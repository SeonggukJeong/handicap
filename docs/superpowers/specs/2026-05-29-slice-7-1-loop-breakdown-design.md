# Slice 7-1 — Loop 요청수 breakdown 설계 명세

> Slice 7(loop 노드)의 후속. 리포트에서 루프 본문 스텝이 `${loop_index}` 별로
> 실제 몇 번 요청됐는지를 **별도 drill-down**으로 보여준다. Slice 7과 **같은
> `slice-7-loop` 브랜치에 머지 전** 구현한다.

**문제:** 리포트 Steps 표는 `step_id` 단위 집계(ADR-0012/0017)라 루프 본문
1스텝 = 1행이고, 그 행이 `/item/0`·`/item/1`·`/item/2`… 요청을 전부 합친다
(예: 15,765건). URL 칼럼엔 `${loop_index}`가 그대로 떠서 "실제로 무엇을, 몇 번
때렸는지"를 알 수 없다.

**해결:** `(step_id, loop_index)` 별 **count + error_count**(latency 없음)를
집계해, 해당 루프 스텝 행 아래에 접이식(collapsible) drill-down으로 노출한다.
메인 표는 접힌 기본 상태에서 지금과 동일.

---

## 1. 범위 (In / Out)

**In**
- 엔진: `(step_id, loop_index)` 별 count/error 집계(상한 cap, 초과분은 overflow 한 버킷).
- 전송: `MetricBatch`에 `loop_stats` delta 추가(기존 per-second flush에 편승, 누적 합산).
- 저장: `run_loop_metrics` 테이블(migration 0003), UPSERT 누적.
- 리포트: `ReportStep.loop_breakdown` (loop_index별 정렬 + overflow).
- UI: Steps 표의 루프 스텝 행에 expand caret → 내부 표(loop_index | requests | errors).
- 설정: **run profile**에 `loop_breakdown_cap`(UI Run 다이얼로그에서 지정). **0 = 끄기**, 기본 256, 상한 10000.

**Out (명시적 연기)**
- loop_index별 **latency 백분위**(p50/p95/p99) — count/error만. (HDR per-index는 비용·payload 과다.)
- 중첩 루프(단일 레벨만; Slice 7 제약 그대로) — 중첩 슬라이스에서 scoped index.
- 실제 resolved URL 문자열 저장(예: `/item/3`) — loop_index 숫자로 충분, URL은 시나리오 템플릿으로 재구성 가능.
- 시계열(per-second) breakdown — 전체 run 총계만.

---

## 2. 아키텍처 결정

- **counts-only, totals-only.** breakdown은 히스토그램·시계열 없이 run 전체
  `(step_id, loop_index) → {count, errors}` 총계. hot path·payload·DB 부담 최소.
- **cap은 per-run UI 설정** (`profile.loop_breakdown_cap`). env 아님 — 발견성·재현성.
  **0 = 완전 비활성**(record 시 breakdown 경로 진입 안 함, drill-down 미표시).
- **cap 상한 10000** = ADR-0017 "≤10k 행 / 리포트 <2s" 기준을 사용자 설정으로도
  지키게 하는 가드. 사용자가 `repeat: 1_000_000`을 줘도 버킷 수는 cap으로 제한.
- **overflow sentinel** = `u32::MAX`. `loop_index >= cap`인 요청은 sentinel 버킷에
  합산. 리포트는 sentinel을 `loop_index: null`로 내보내고 UI는 "그 외(상한 초과)"로
  렌더 → 컨트롤러/UI가 cap 숫자를 몰라도 됨.
- **delta-flush + UPSERT 누적.** 기존 per-second window drain에 편승해 breakdown
  delta를 같이 보내고 컨트롤러가 `count = count + excluded.count`로 합산 →
  abort/crash에 강함(마지막 flush까지 부분 집계 보존), 메인 메트릭과 동일 내구성.
- **profile_json 저장이라 runs 마이그레이션 불필요.** `Profile`에 `#[serde(default)]`
  필드 추가 → 구 run row도 기본값으로 역직렬화. migration 0003은 **새 테이블뿐**
  (`CREATE TABLE IF NOT EXISTS`, 완전 idempotent — Slice 6의 ADD COLUMN 함정 회피).

---

## 3. 데이터 흐름

```
RunDialog(cap 입력) → POST /api/runs {profile.loop_breakdown_cap}
  → controller 검증(0..=10000) → profile_json 저장 → proto Profile.loop_breakdown_cap
  → worker → RunPlan.loop_breakdown_cap → Aggregator::new(cap)
       │ (실행 중, 루프 Http leaf마다)
       └ record(step_id, …, loop_index=Some(i))
            └ cap>0 이면 (step_id, min(i,cap)→else sentinel) 버킷 count/error++
  → drain 시 loop delta → MetricBatch.loop_stats[]
  → controller UPSERT run_loop_metrics(run_id,step_id,loop_index,count,error_count)
GET /api/runs/{id}/report
  → build_report: run_loop_metrics 조회 → ReportStep.loop_breakdown[] (+ null=overflow)
  → UI StepStatsTable: 루프 스텝 행 caret → 내부 표
```

---

## 4. 엔진 (`crates/engine`)

### 4.1 Aggregator (`aggregator.rs`)
- 보조 맵 추가: `loop_counts: HashMap<(String /*step_id*/, u32 /*bucket*/), LoopCount>`,
  `LoopCount { count: u64, error_count: u64 }`.
- 생성자 `Aggregator::new(loop_breakdown_cap: u32)` (기존 `new()`는 `new(256)` 또는
  호출부 수정). `cap == 0`이면 breakdown 비활성.
- `record(step_id, latency_us, status, is_error, loop_index: Option<u32>)`:
  - 기존 window 기록은 그대로.
  - `if cap > 0 { if let Some(i) = loop_index { let b = if i < cap { i } else { u32::MAX }; loop_counts[(step_id,b)].count += 1; if is_error { …error_count += 1 } } }`
  - **flat/비루프 경로(`loop_index == None`)와 `cap == 0`은 추가 작업 0** — hot path 무영향.
- drain: 기존 `drain_completed`/`drain_all`이 window를 비울 때 `loop_counts`의 **delta를
  같이 take + reset**해 반환(예: `drain_completed`/`drain_all`이 `(Vec<StepWindow>, Vec<LoopStatDelta>)` 반환, 혹은 별도 `drain_loop_deltas()`). delta 방식이라 컨트롤러가 합산.
  `LoopStatDelta { step_id, loop_index: u32 /*sentinel=u32::MAX*/, count, error_count }`.

### 4.2 RunPlan / runner (`runner.rs`)
- `RunPlan`에 `pub loop_breakdown_cap: u32` 추가.
- `Aggregator::new(plan.loop_breakdown_cap)`로 생성.
- Http leaf의 `record(...)` 호출에 현재 `loop_index`(이미 `TemplateContext`로 스코프에
  있음) 전달.
- flush 코드(worker로 보내는 쪽)가 loop delta도 batch에 실어 보냄.

---

## 5. proto (`crates/proto`) — additive, backward-compatible

```proto
message Profile {
  uint32 vus = 1;
  uint32 ramp_up_seconds = 2;
  uint32 duration_seconds = 3;
  uint32 loop_breakdown_cap = 4;   // 0 = disabled, default applied controller-side
}

message LoopStat {
  string step_id = 1;
  uint32 loop_index = 2;   // u32::MAX = overflow bucket (>= cap)
  uint64 count = 3;
  uint64 error_count = 4;
}

message MetricBatch {
  string worker_id = 1;
  string run_id = 2;
  repeated MetricWindow windows = 3;
  repeated LoopStat loop_stats = 4;   // delta since last flush
}
```
필드 추가는 backward-compat 안전(Slice 4 함정 노트). 옛 worker→새 controller 조합은
없음(동시 배포).

---

## 6. Controller (`crates/controller`)

### 6.1 profile (`store/runs.rs`, `api/runs.rs`)
- `store::runs::Profile`에 `#[serde(default = "default_loop_cap")] pub loop_breakdown_cap: u32`
  (`default_loop_cap() -> 256`). **profile_json 저장이라 runs 마이그레이션 불필요.**
- `api::runs::Profile`(요청 payload)도 동일 필드 + 기본값. `CreateRunRequest` 검증:
  `loop_breakdown_cap > 10000` 이면 400(또는 10000으로 clamp — **reject 채택**, 메시지로
  상한 안내). 0 허용(=끄기).
- proto Profile 빌드(api/runs.rs:65 부근)에 `loop_breakdown_cap` 전달.

### 6.2 migration 0003 (`store/migrations/0003_run_loop_metrics.sql`)
```sql
CREATE TABLE IF NOT EXISTS run_loop_metrics (
  run_id      TEXT    NOT NULL,
  step_id     TEXT    NOT NULL,
  loop_index  INTEGER NOT NULL,   -- 4294967295 = overflow bucket
  count       INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, step_id, loop_index)
);
```
`IF NOT EXISTS`라 재기동 재실행에 idempotent(컬럼 ADD가 아니라 안전).

### 6.3 ingest (`store/metrics.rs`, `grpc/coordinator.rs`)
- `MetricBatch.loop_stats` 수신 시 UPSERT 누적:
  `INSERT INTO run_loop_metrics(...) VALUES(...) ON CONFLICT(run_id,step_id,loop_index) DO UPDATE SET count = count + excluded.count, error_count = error_count + excluded.error_count`.

### 6.4 report (`report.rs`)
- `run_loop_metrics` 를 run_id로 조회, step_id별 group.
- `ReportStep`에 `loop_breakdown: Vec<LoopBucket>` 추가
  (`LoopBucket { loop_index: Option<u32> /*null=overflow*/, count, error_count }`),
  loop_index 오름차순 정렬 + overflow(null)는 맨 끝. breakdown 없으면 빈 벡터.
- `Serialize` + `Deserialize` 양방향(통합 테스트의 typed round-trip 요구 — Slice 5 함정).

---

## 7. UI (`ui/`)

### 7.1 Run 다이얼로그 (`components/RunDialog.tsx`)
- 신규 숫자 입력 **"Loop breakdown cap"**: 기본 256, `min 0`, `max 10000`. **0 = 끄기**(도움말 표기).
  도움말: "루프 스텝의 loop_index별 요청수 집계 상한. 0이면 집계 안 함."
- `profile.loop_breakdown_cap`로 payload에 포함. canSubmit 검증에 `0..=10000` 추가.

### 7.2 report 모델 (`scenario`/report 타입 + Zod)
- `ReportStep.loop_breakdown?: { loop_index: number | null; count: number; error_count: number }[]`.

### 7.3 StepStatsTable (`components/report/ReportView.tsx`)
- 스텝의 `loop_breakdown`가 비어있지 않으면 행에 **expand caret**(버튼, `aria-expanded`).
  펼치면 내부 표: `loop_index │ requests │ errors`. `loop_index === null` 행은
  **"그 외 (상한 초과)"**. 기본 접힘 → 메인 표는 현행 그대로.
- breakdown 없는 스텝(http top-level, cap=0 run 등)은 caret 미표시.

---

## 8. 성능 검토 (MVP §4.3 / Slice 7 baseline 비회귀)

Slice 7 baseline(단일 워커, flat ~19,974 RPS / loop(repeat:1) ~19,449 RPS, p95 17ms)
대비 회귀가 없어야 한다. 설계는 의도적으로 hot path 밖이다:

- **flat/비루프 경로 무영향.** `loop_index == None` 이면 `record`가 breakdown 분기를
  건너뜀 — 추가 연산 0. 비루프 시나리오는 Slice 7과 동일 처리량.
- **`cap == 0` 무영향.** 끄면 루프 안에서도 breakdown 분기 진입 안 함 — 정확히 0 비용.
- **루프 내부 비용 = HashMap 1회 + u64 2증분/요청.** 이미 critical section에서 도는
  HDR `histogram.record`보다 훨씬 싸고 HTTP RTT 대비 무시 가능. 새 lock 없음(기존
  aggregator mutex 안). `SystemTime` 호출 추가 없음.
- **메모리·cardinality 유한.** `loop_counts` 엔트리 수 = (루프 스텝 수) × min(repeat,cap)
  + overflow ≤ ~cap. 기본 256·상한 10000으로 제한. 엔트리는 작음(문자열 키 + 2 u64).
- **wire/DB/리포트 유한.** flush당 loop_stats ≤ cap rows(작은 메시지). `run_loop_metrics`
  행 = step × distinct loop_index ≤ cap(run당, ≤10k). 리포트 payload도 cap으로 상한 →
  "≤10k 행 / <2s" 기준 유지.

**경험적 재확인(구현 plan에 포함):** `SCENARIO_KIND=loop` 벤치에 breakdown ON(cap=256) vs
OFF(cap=0) 변형을 추가해 같은 머신·세션에서 비교 → loop baseline(~19,449 RPS) 대비 ~5%
이내, p95/p99 동일임을 확인. (회귀 시 cap 기본 하향 또는 비활성 기본 검토.)

---

## 9. 완료 기준 (acceptance)

- 엔진: aggregator 단위 테스트(loop_index별 count, cap 경계, overflow, cap=0 무집계);
  통합 테스트(`repeat: 3` 루프 → breakdown 합 = 스텝 count, index 0/1/2 분포).
- 컨트롤러: migration 0003 idempotent; loop_stats UPSERT 누적; report에 loop_breakdown
  포함 + typed round-trip; cap 검증(0 허용, >10000 reject).
- UI: RunDialog cap 입력·검증·payload; ReportView drill-down(행 렌더, 기본 접힘,
  overflow 라벨, breakdown 없으면 caret 없음); 빌드 게이트(`tsc -b && vite build`).
- e2e: 루프 시나리오 create→run→report 에 step별 loop_breakdown 합 = 스텝 count, error=0.
- 성능: §8 벤치(ON vs OFF) 수치 기록, baseline 대비 비회귀.
- 게이트: `cargo fmt/clippy -D warnings/test --workspace`, `pnpm test && pnpm build`.

---

## 10. 추가/갱신되는 ADR

- ADR-0020(loop 노드)에 "loop_index별 요청수 breakdown(counts-only, per-run cap,
  0=off)" 후속 결정을 짧게 보강하거나, ADR-0021로 분리(메트릭 cardinality 정책:
  per-run cap + overflow sentinel). 구현 plan Task에서 결정.
