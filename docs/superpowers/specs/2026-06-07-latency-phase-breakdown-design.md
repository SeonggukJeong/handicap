# 레이턴시 단계 분해 — TTFB + 다운로드 (B7-C 1단계) — 설계

> 날짜: 2026-06-07 · 상태: 설계 승인 (brainstorming 완료, plan 대기)
> 출처: `docs/roadmap.md` §A2 도출 우선순위 (3) "B7-C 연결-단계 분해" 의 **1단계**
> 관련 ADR: ADR-0017(리포트 스코프), ADR-0033/A2-2(`group_stats` HDR-per-step 파이프라인 — 이 슬라이스가 그대로 재사용). **ADR 신규 불필요**(additive, 기존 파이프라인 재사용).

---

## 1. 목표 / 비목표

### 목표
- 각 HTTP 스텝의 응답 시간을 **두 phase로 분해**해 per-step 리포트에 노출: **TTFB(요청 전송 ~ 응답 헤더 도착)** 와 **본문 다운로드(헤더 도착 ~ 본문 수신 완료)**.
- "느린 게 서버 응답이냐(TTFB) 큰 페이로드/느린 다운로드냐"를 부하 리포트에서 직접 가른다.
- **opt-in**: run 시작 전 토글로 측정 on/off 선택(기본 off). off면 기존과 **byte-identical**.
- 향후 DNS/TCP/TLS/total phase를 **스키마 변경 없이** 추가할 수 있도록 채널을 `phase`-키 일반형으로 설계(단, v1 코드 경로는 `download` 하나뿐).

### 비목표 (이 슬라이스 밖, 연기)
- **DNS/TCP/TLS handshake 분해**: reqwest 0.12가 per-request 연결 단계 타이밍을 노출하는 공개 API가 없음(Go `httptrace` 부재) → 커스텀 리졸버/커넥터 필요(핫패스 침습 위험). 게다가 keep-alive 커넥션 재사용(ADR-0018)으로 부하 중엔 handshake가 VU당 첫 요청 1회뿐이라 per-request 평균 ≈ 0. "네트워크 문제 규명이 필요할 때" 별도 슬라이스로(채널은 이 슬라이스에서 받아둠).
- **전체 응답시간(TTFB+다운로드) 퍼센타일**: 2 phase로 확정(퍼센타일 비가산이라 정확한 total은 별도 HDR 필요 — 연기).
- per-second 다운로드 시계열, 다운로드 성공/오류 분할, 다운로드 SLO criteria, run 비교·insights의 다운로드.

---

## 2. 핵심 관찰

### 2.1 기존 "latency"는 이미 TTFB다
`executor.rs:150-152` 에서 `latency = started.elapsed()` 는 `req.send().await`(헤더 도착 시점에 resolve) **직후**, `resp.bytes().await`(본문 다운로드) **이전**에 찍힌다. 즉:
- **기존 per-step `latency` = TTFB**(요청 전송 ~ 헤더). 리포트·SLO verdict·퍼센타일·시계열이 전부 이 값.
- **본문 다운로드 시간은 현재 측정 자체가 안 됨**(보이지 않는 phase).

→ 따라서 이 슬라이스는 **기존 latency 의미를 한 글자도 바꾸지 않고**(SLO/비교/byte-identical 보존), **다운로드 phase만 추가로** 재면 "TTFB + 다운로드" 분해가 자연 성립한다.

### 2.2 다운로드는 reqwest의 `bytes().await` 구간으로 공짜로 잡힌다
`req.send().await` 는 응답 헤더에서 resolve되고 본문은 그 뒤 스트리밍이므로, `bytes().await` 를 `Instant` 로 감싸면 다운로드 시간이 나온다(추가 비용 = Instant 2회 = 무시 가능).

### 2.3 메트릭 파이프라인은 A2-2 `group_stats` 가 똑같은 모양
`group_stats`(parallel 페이지-로드 레이턴시)는 이미 **step_id별 HDR delta → MetricFlush 드레인 → proto → 워커 forward → append-only 테이블 → build_report read-merge → 리포트** 의 7-layer 가산 채널이다. 이 슬라이스는 키를 `(step_id, phase)` 로만 바꿔 그대로 재사용한다.

---

## 3. 결정된 접근

**접근법 1(추가 HDR 채널) + phase-키 일반 채널.** 기존 핫 per-window 파이프라인(StepWindow/run_metrics)은 완전 무변경. 새 채널은 가산만. (기각된 대안: ②기존 StepWindow에 다운로드 HDR을 끼워넣기 = 핫 파이프라인 침습·회귀 위험; ③trace 전용 = 부하 중 다운로드 병목 못 봄.)

---

## 4. 컴포넌트 설계

### 4.1 측정 — 엔진 `executor.rs`
```rust
let started = Instant::now();
let outcome = req.send().await;
let latency = started.elapsed();          // TTFB — 기존 그대로, byte-identical
// ... (헤더/set-cookie 수집)
let dl_start = Instant::now();            // NEW
let body_bytes = resp.bytes().await ...;
let download = dl_start.elapsed();        // NEW
```
- `ExecOutcome` 에 `download: Option<Duration>` 추가. **성공 경로(`bytes().await` 도달)에서만 `Some`** — transport 실패(connection refused 등)는 `None`(다운로드 phase 없음).
- 측정 자체는 **항상** 수행. opt-in 플래그는 *측정*이 아니라 *집계/저장*만 게이트 → `executor.rs` 는 플래그를 모른다.
- `execute_step_traced`(trace twin)에도 동일 측정 추가(§4.6).

### 4.2 집계 — 엔진 `aggregator.rs`
A2-2 `group_*` 를 미러, 키를 `(step_id, phase)` 로:
```rust
pub struct PhaseStat { pub step_id: String, pub phase: String, pub histogram: Histogram<u64>, pub count: u64 }
// Aggregator:
phase_hists: HashMap<(String, String), (Histogram<u64>, u64)>,
pub fn record_phase(&mut self, step_id: &str, phase: &str, latency_us: u64) { ... }   // clamp(1, 60_000_000), HDR record, count++
pub fn drain_phase_deltas(&mut self) -> Vec<PhaseStat> { ... }                        // std::mem::take, group과 동일
```
- `Aggregator::new` 시그니처 **무변경**(group과 동일 — 게이트는 호출부).
- `PhaseStat::serialize_histogram()` = group과 동일(V2Serializer).

### 4.3 게이트 + 기록 — 엔진 `runner.rs`
- `RunPlan` 에 `measure_phases: bool` 추가. `run_vu`/`run_arrival` → `do_step` 으로 스레드(http_timeout/think_seed와 같은 방식).
- `Step::Http` arm: 기존 `a.record(...)`(TTFB) 그대로 + `if measure_phases { if let Some(dl) = outcome.download { a.record_phase(&id, "download", dl.as_micros()...) } }`.
- **`MetricFlush`** 에 `phase_stats: Vec<PhaseStat>` 드레인 벡터 추가 → **4 flush 사이트 드레인 + 3 send-guard**(엔진 CLAUDE.md 함정: 드레인 4곳[closed periodic/final + open periodic/final], `|| !phase_stats.is_empty()` send-guard 3곳[closed periodic·closed final·open periodic]; open-loop final은 dropped 무가드라 phase도 거기선 무관). `MetricFlush{}` 리터럴 전부에 `phase_stats: vec![]` 명시(컴파일러 강제).

### 4.4 와이어 — `crates/proto`
```proto
message PhaseStat {
  string step_id = 1;
  string phase = 2;          // v1: "download" only
  bytes hdr_histogram = 3;   // hdrhistogram V2 serialized (delta since last drain)
  uint64 count = 4;
}
message MetricBatch { ...; repeated PhaseStat phase_stats = 8; }   // 다음 필드 = 8
message Profile { ...; bool measure_phases = 11; }                 // 다음 필드 = 11, default false
```

### 4.5 워커 + 영속화 — `crates/worker`, controller `store`
- 워커: `group_stats` 와 동일 forward 경로(HDR 직렬화는 엔진에서, 워커는 그대로 전달) — 추가 로직 0.
- **migration 0013** `run_phase_metrics`:
  ```sql
  CREATE TABLE IF NOT EXISTS run_phase_metrics (
    run_id        TEXT    NOT NULL,
    step_id       TEXT    NOT NULL,
    phase         TEXT    NOT NULL,
    hdr_histogram BLOB    NOT NULL,
    count         INTEGER NOT NULL
  );  -- append-only, PK 없음 (run_group_metrics/0010 미러)
  CREATE INDEX IF NOT EXISTS idx_run_phase_metrics_run ON run_phase_metrics(run_id);
  ```
  - 번호 0013 = 다음 빈 번호(`.sql`: 0001–0007/0010/0011; 0008·0009·0012는 Rust-guarded). `store/mod.rs`에 const + execute 라인 **둘 다** 추가(컨트롤러 CLAUDE.md: execute 라인 silently auto-merge 누락 함정 — `grep -c MIGRATION_SQL`로 const N == execute N 교차검증).
  HDR는 SQL merge 불가라 delta 행 공존 + read-time merge. 멱등성은 단일 bidi 스트림 배치 전달-once가 보장. 멀티워커도 read-time `(step_id, phase)` merge로 자동 합산(worker_id 불필요).

### 4.6 리포트 빌드 — controller `report.rs`
- `build_report` 가 `groups` param 옆에 `phases` param(=`run_phase_metrics` 행) 추가 → `(step_id, phase)` 별 `phase_acc` 로 HDR merge.
- **summary/overall/RPS/windows 절대 미접촉**(download은 TTFB와 별개 phase라 겹치지 않지만 격리 원칙 유지).
- per_step 행에 부착:
  ```rust
  pub struct PhaseStats { pub count: u64, pub p50_ms: f64, pub p95_ms: f64, pub p99_ms: f64, pub max_ms: f64 }
  // ReportStep:
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub download: Option<PhaseStats>,
  ```

### 4.7 UI — Zod + 리포트 표
- `StepSchema` 에 `download` `.nullish()`(서버 None→null, S-D 갭 차단). `PhaseStatsSchema` 신규.
- **`StepStatsTable`**: per_step 중 하나라도 `download` 가 있으면 **다운로드 컬럼(p50/p95/p99)** 추가, 기존 레이턴시 컬럼 헤더는 "응답(TTFB)" 로 명확화. (별도 드릴다운 아님 — loop caret과 충돌 없음.)
- 짧은 범례: "응답(TTFB) = 요청 전송~헤더 도착 · 다운로드 = 본문 수신. 합 ≠ 전체(퍼센타일 비가산)."

### 4.8 opt-in 토글 — UI `profileForm.ts` (공유)
- 공유 `profileForm.ts` 의 `buildProfile` 에 `measure_phases` 추가 → **RunDialog + ScheduleForm 양쪽 자동 노출**.
- 접이식 "진단/고급" 섹션(기본 접힘, 사용자 선호 — optional 섹션 disclosure 이디엄), 기본 off.
- 엔진 `RunPlan.measure_phases` / `profile_json.measure_phases`(`#[serde(default)]` → 옛 run·absent = false = byte-identical).

### 4.9 test-run trace (소규모 additive)
- `TracedResponse` 에 `download_ms` 추가(기존 `latency_ms`=TTFB 옆). trace는 진단용 단일패스라 **플래그 무관 항상 측정**.
- `TestRunPanel` http 행에 "TTFB / 다운로드" 표시 → 에디터에서 단발 요청으로 분해 미리보기.
- `execute_step_traced` ↔ `execute_step` lockstep 유지(둘 다 `bytes().await` 측정).

---

## 5. 불변식

1. **byte-identical (off)**: `measure_phases=false` → 와이어에 `phase_stats` 없음 + `run_phase_metrics` 빈 채 + `report.download` absent + 기존 리포트 전부 무변경.
2. **TTFB 불변**: 기존 per-step `latency` / summary / overall / windows / SLO verdict 는 이 슬라이스로 한 글자도 안 바뀐다(다운로드는 별개 채널·별개 phase).
3. **wire 1:1**: proto `PhaseStat` ↔ 엔진 `PhaseStat`/aggregator ↔ controller `PhaseStats` ↔ UI Zod 필드 패리티.
4. **격리**: build_report 의 phase merge가 summary/overall/RPS/per_step(TTFB)/windows 를 건드리지 않음.
5. **download Some/None**: 성공 응답만 다운로드 샘플 기여; transport 실패는 TTFB 오류 카운트에만 기여.

---

## 6. 테스트 전략

- **엔진 단위**: `aggregator` record_phase/drain_phase_deltas(누적·delta 리셋·키 분리); `executor` `download` Some(성공)/None(connection refused) 경로. **정확 ms 비단언**(group 테스트처럼 count·존재만 — wall-clock flake 회피).
- **MetricFlush**: 4 드레인 + 3 send-guard 가 phase delta를 유실/중복 없이 실어보내는지(빈 배치 스킵 가드에 phase 포함).
- **e2e** `phase_breakdown_report_e2e_smoke`(controller, group e2e 미러): opt-in run → `/report` per_step.download 존재.
- **byte-identical** 회귀: measure_phases off run 의 리포트 JSON 이 pre-feature와 동일.
- **UI**: Zod `.nullish()` round-trip, StepStatsTable 다운로드 컬럼 조건부 렌더.
- **라이브 검증 필수**(S-D 교훈 — RTL은 서버 `null`을 absent로 줘서 `.nullish()` 미스매치를 통과시킴): 큰 본문 반환 타깃으로 ① ON run → `/report` 가 `ReportSchema.parse` 통과 + per_step.download 존재·다운로드 p50>0, ② OFF run → download absent + 기존 리포트 byte-identical, ③ Playwright 토글→리포트 컬럼 + 콘솔 Zod 0.

---

## 7. 게이트 / 와이어 1:1 체크리스트 (handicap-reviewer 최종)

- proto field 번호: `MetricBatch.phase_stats = 8`, `Profile.measure_phases = 11`.
- 엔진 `MetricFlush` 드레인 4곳 + send-guard 3곳.
- migration 0013 = run_group_metrics(0010) 미러 + `phase TEXT` 컬럼.
- 기존 핫 per-window 파이프라인(StepWindow/proto MetricWindow/run_metrics) 무변경.
- `cargo fmt/build/clippy/test --workspace` + UI `pnpm lint && pnpm test && pnpm build`.

---

## 8. 연기 항목 (→ `docs/roadmap.md` §B7 에 누적)

- DNS/TCP/TLS/total phase(커스텀 리졸버·커넥터; phase 채널이 받아둠).
- per-second 다운로드 시계열 / 다운로드 성공·오류 분할 / 다운로드 SLO criteria / run 비교·insights 다운로드.

---

## 9. 구현 순서 (plan 에서 세분)

대략: 엔진(executor 측정 → aggregator phase_hists → runner 게이트+MetricFlush) → proto → 워커 forward → migration 0013 + store → build_report + ReportStep → UI Zod + StepStatsTable + profileForm 토글 → trace download_ms + TestRunPanel → e2e + 라이브. (commit 경계는 pre-commit 전체-게이트에 맞춰 plan 에서 확정.)
