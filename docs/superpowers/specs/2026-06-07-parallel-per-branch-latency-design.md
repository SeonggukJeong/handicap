# Parallel per-branch latency breakdown — 설계

- **날짜**: 2026-06-07
- **상태**: 설계 승인 → 구현 계획 대기
- **출처**: `docs/roadmap.md` §A2 "다음 슬라이스", 자동메모리 `parallel-per-branch-breakdown-next`
- **선행 조건**: B7-C 레이턴시 phase 분해 머지 완료(master `c755e23`). phase와 같은 메트릭 이음새를 *다른 키*로 미러하므로 순차 진행이 필수였고, 이제 그 위에서 시작.
- **관련 ADR**: ADR-0033(Parallel 노드), ADR-0017(리포트 스코프), ADR-0016(VU 모델), ADR-0018(VU별 jar). **신규 ADR 불필요** — ADR-0033 범위 내 additive(A2-2 group/page latency, B7-C phase 분해와 동일한 선례).

---

## 1. 동기

A2-2(그룹/페이지 레이턴시)는 각 `parallel` 노드의 **페이지-로드 레이턴시**(동시 분기 블록의 wall-clock ≈ `max(분기)`)를 리포트에 emit한다. 이는 "웹뷰 페이지 로드가 얼마나 걸리나"는 주지만, **어느 동시 호출이 그 페이지를 지배하는가(병목 분기)** 는 보이지 않는다. 웹뷰 fan-out 디버깅의 다음 질문이다.

이 슬라이스는 각 parallel 노드 아래 **분기별 레이턴시 분포**를 추가해, 페이지 max와 나란히 놓고 "이 분기가 병목"을 한눈에 보이게 한다.

### 1.1 기존 per-step 메트릭과의 관계 (가치 명료화)

분기가 http 스텝 1개면 그 분기의 레이턴시는 사실상 기존 **per-step 메트릭**(그 step_id의 p50/p95/p99, `report.steps`)에 이미 들어있다. per-branch breakdown의 *추가* 가치는:

1. **그룹핑 + 페이지 max와의 병치** — 분기들을 그 parallel 노드 아래 묶어 페이지 로드(=max)와 나란히 보여줘 병목 분기를 즉시 식별. per-step 테이블은 parallel 노드별로 묶지 않고, "이들은 동시에 돌고 이게 지배한다"를 보여주지 않는다.
2. **다중 스텝 분기의 wall-clock** — 분기에 스텝이 여러 개면 그 분기 전체의 wall-clock은 per-step에 없는 새 정보(per-step은 개별 스텝만).

단일-http-스텝 분기의 흔한 경우엔 개별 숫자가 per-step과 겹치지만, **병목을 가려내는 정렬·병치가 핵심 가치**다.

---

## 2. 범위

### 2.1 포함
- 각 `parallel` 노드의 **분기별** 레이턴시 분포: count + p50/p95/p99/max(ms), HDR 기반.
- 기존 **페이지 행**(A2-2) 유지 — 분기와 같은 테이블/파이프라인에서 함께 emit.
- 부하 경로(closed-loop + open-loop 둘 다, 공유 `execute_steps`).

### 2.2 제외 (의도적, 직교)
- **phase(TTFB/다운로드) 분할** — per-branch는 분기 wall-clock만(B7-C는 step 레벨에서 직교 유지). `(step_id, branch, phase)` 3차원은 scope creep.
- **성공/오류 분할** — counts라 HDR과 별개 차원, 가치 대비 복잡도 연기.
- **test-run trace** — A2-2 페이지처럼 per-branch도 부하 전용(trace는 1-VU 단일 패스라 타이밍 무의미; 엔진 `trace.rs` Parallel arm 무변경).
- **중첩 parallel·loop/if 컨테이너 내 parallel** — UI v1이 top-level·http-only parallel만 authoring(A2). 엔진은 도달한 어떤 parallel 노드든 `par.id` 키로 기록하므로 별도 제약 코드 불필요 — UI authoring이 자연히 top-level로 bound.

---

## 3. 설계 결정

### 3.1 파이프라인: 기존 `group_stats` 확장 (vs 별도 파이프라인)

**결정**: 기존 `group_stats`(A2-2)에 `branch` 차원 1개를 추가한다. 페이지 = `branch=""`, 분기 = `branch.name`.

근거: 페이지 레이턴시와 분기 레이턴시는 **같은 개념**(동시 단위의 wall-clock; 페이지 = 분기들의 max/합집합)이다. B7-C가 phase 분해에서 쓴 "(step_id, phase) = step_id에 2번째 차원" 패턴과 동형. 이점:
- **신규 드레인/플러시/guard 사이트 0개** — 같은 `group_stats` 벡터를 재사용(문서화된 "MetricFlush 4 drain + 3 send-guard" 함정을 건드리지 않음).
- 신규 proto 메시지 0, 신규 테이블 0, `build_report` 시그니처 무변경.
- 충돌면(다른 작업과의 텍스트 충돌) 최소.

거절한 대안(별도 `BranchLatencyStat` 메시지 + `MetricBatch` 필드 9 + 신규 드레인 벡터 + 신규 테이블 `run_branch_metrics` + `build_report` 새 param): 개념 분리는 깔끔하나 표면적 ~2배 + 4+3 드레인 함정 재노출.

### 3.2 분기 라벨 = `branch.name`

`branch.name`을 라벨로 쓴다(선언-순서 인덱스 아님). 근거: UI가 분기명 유니크를 강제(`ParallelStepModel` superRefine), `{{branch.var}}` 네임스페이스 merge와 동일 소스라 라벨 drift가 없고, human-readable해 리포트가 바로 유용. 9d의 `elif_{j}` 인덱스 라벨은 elif가 익명(이름 없음)이라 인덱스를 쓴 것 — parallel 분기는 사용자가 이름을 단다.

### 3.3 측정·기록: clean-block 게이트로 페이지와 함께

각 분기 future 내부에서 자기 wall-clock(`Instant`)을 측정하고, join 후 페이지 기록과 **같은 clean-block 게이트**(`!aborted && !deadline_hit`)에서 페이지 + 전 분기를 함께 기록한다.

- **각 분기 행의 `count` == 페이지 행의 `count`** (분기 수만큼의 분기 행 — N 분기면 N개 행, 각 행 count = 페이지 count). 정확히: clean iteration마다 페이지 버킷 +1, 그리고 각 분기 버킷도 +1 → per-branch-row count는 페이지 count와 같다. (분기 행 count의 *합*은 N × 페이지 count이지만, 리포트가 비교하는 건 각 분기 행 vs 페이지다.) deadline/abort가 한 분기를 자르면 페이지도 분기도 기록 안 함(부분 skew 방지, A2-2와 동일 caution).
- 분기 wall-clock은 async 실시간(Instant) — 분기가 자기 HTTP에서 await 중인 실제 경과. join_all이 협력 폴링이라 각 분기는 자기 완료 시점에 자기 elapsed를 산출(형제 영향 없음).

---

## 4. 데이터 흐름 (레이어별)

### 4.1 엔진 `aggregator.rs`
- `group_hists: HashMap<String, (Histogram<u64>, u64)>` → `HashMap<(String, String), (Histogram<u64>, u64)>` (키 = `(step_id, branch)`).
- `record_group(step_id: &str, latency_us: u64)` → `record_group(step_id: &str, branch: &str, latency_us: u64)`.
- `GroupStat` 구조체에 `branch: String` 추가. `drain_group_deltas`가 `GroupStat { step_id, branch, hdr_histogram, count }` emit.
- 단위 테스트(`record_group_accumulates_and_drains_as_delta` 등) — 분기 키 추가.

### 4.2 엔진 `runner.rs` Parallel arm (`:511-578`)
- 분기 future가 `(branch, branch_vars, flow)` → `(branch, branch_vars, flow, branch_us)` 반환. **`Instant::now()`은 분기 `async move` 안에서 `Box::pin(execute_steps(...)).await`만 감싼다**(`:525-539`) — 분기 자기 wall-clock.
- **함정(리뷰 반영)**: 현재 merge 루프(`:555`)가 `results`를 **by-value로 소비**(`for (branch, branch_vars, flow) in results`)하므로 `record_group` *뒤에* `&results`를 다시 도는 의사코드는 컴파일 안 된다. → merge 루프 **안에서** `(branch.name.clone(), branch_us)`를 모으고, 루프 후 clean-block에서 기록:
  ```rust
  let results = futures::future::join_all(futs).await;
  let elapsed_us = t0.elapsed().as_micros() as u64;

  let mut aborted = false;
  let mut deadline_hit = false;
  let mut branch_samples: Vec<(String, u64)> = Vec::new();   // (분기명, wall-clock µs)
  for (branch, branch_vars, flow, branch_us) in results {     // by-value 소비, 4-tuple
      match flow? {                                           // genuine EngineError 조기 전파(기존)
          StepFlow::Continue => {}
          StepFlow::DeadlineReached => deadline_hit = true,
          StepFlow::Aborted => aborted = true,
      }
      for k in branch.output_var_names() {
          if let Some(v) = branch_vars.get(k) {
              iter_vars.insert(format!("{}.{}", branch.name, k), v.clone());
          }
      }
      branch_samples.push((branch.name.clone(), branch_us));  // 신규
  }
  if !aborted && !deadline_hit {
      let mut a = agg.lock().await;                           // 락 1회로 페이지+분기 일괄
      a.record_group(&par.id, "", elapsed_us);                // 페이지 (기존, branch="")
      for (name, us) in &branch_samples {
          a.record_group(&par.id, name, *us);                 // 분기별 (신규)
      }
  }
  ```
- **`record_group` 프로덕션 호출부는 이 한 곳뿐**(`runner.rs:571`) — `grep -rn record_group crates/engine/src`로 확인(나머지는 aggregator 단위테스트). 시그니처 확장은 컴파일러-driven.
- 드레인/플러시/send-guard 사이트는 **무변경**(같은 `group_stats` 벡터: closed periodic/final `:194/:245`, open periodic/final `:674/:839`, send-guard `:201/:252/:681`).

### 4.3 proto `coordinator.proto` `GroupStat`
```proto
message GroupStat {
  string step_id = 1;
  bytes hdr_histogram = 2;
  uint64 count = 3;
  string branch = 4;          // "" = page (A2-2), else branch name
}
```
- additive 필드 4. 페이지 행은 `branch=""`(proto3 default라 미직렬화 → 와이어 byte-identical).
- 워커가 엔진 `GroupStat` → proto `GroupStat` 변환 시 `branch` forward(워커 forwarding 코드 1줄, `worker/src/main.rs:287`).
- **prost exhaustive — 컨트롤러 *테스트*의 `pb::GroupStat {` 리터럴(`grpc/coordinator.rs:1413`, `ingest_stores_group_stats`)도 컴파일러-forced** → 같은 커밋에서 `branch: String::new()` 추가(안 하면 `cargo test --workspace` 컴파일 실패). proto 필드 추가는 crate-wide(`grep -rn "GroupStat {" crates/`).

### 4.4 컨트롤러 `store/metrics.rs` + `store/mod.rs`
- **migration 0014** = Rust-guarded `ensure_run_group_metrics_branch`(`ensure_runs_dropped`/`ensure_run_metrics_worker_id` 동형, .sql 파일 아님):
  ```
  if SELECT COUNT(*) FROM pragma_table_info('run_group_metrics') WHERE name='branch' == 0:
      ALTER TABLE run_group_metrics ADD COLUMN branch TEXT NOT NULL DEFAULT ''
  ```
  `connect()`에서 기존 group/phase 마이그레이션 뒤에 배선. (SQLite ALTER 비멱등 → 가드 필수.)
- `GroupMetricRow`(`store/metrics.rs:248`)에 `branch: String`.
- `insert_group_batch`(`:256`): `INSERT INTO run_group_metrics(run_id,step_id,branch,hdr_histogram,count) VALUES(?,?,?,?,?)` (append-only 유지, PK 없음 — HDR delta).
- `group_breakdown`(`:277`): `SELECT step_id, branch, hdr_histogram, count …` + `ORDER BY step_id` → **`ORDER BY step_id, branch`**.

### 4.4b 컨트롤러 ingest 변환 `grpc/coordinator.rs` (리뷰 반영 — §4 누락 보강)
- proto `GroupStat` → `GroupMetricRow` 변환 사이트(`grpc/coordinator.rs:853-862`)에 **`branch: gs.branch.clone()`** 추가. `GroupMetricRow`에 필드가 늘어 **컴파일러-forced**(누락 불가)지만, 데이터 흐름 walk에서 빠지기 쉬워 명시. (read 사이트 `group_breakdown` 호출은 `coordinator.rs:1423` build path — 함수 사용이라 리터럴 변경 없음.)

### 4.5 컨트롤러 `report.rs` `build_report` (`:540-567`)
- `group_acc: BTreeMap<String, …>` → `BTreeMap<(String, String), …>` (키 `(step_id, branch)`). 누적 로직 동일 — **분기 행도 페이지 행과 같은 `decode_hdr`/`merge_into`/`percentiles_of` 경로 재사용**: 깨진 분기 HDR blob은 그 행의 count는 유지하되 분포만 skip(페이지와 동일 fail-soft, `report.rs:549-552`).
- **시그니처 무변경** — 6번째 param `groups`(`&[GroupMetricRow]`) 그대로.
- 조립: page 행(`branch==""`)을 `GroupLatency`로, 분기 행을 그 노드의 `branches: Vec<BranchLatency>`로 중첩. `BTreeMap` 키 `(step_id, branch)`라 각 step_id 내에서 `branch==""`(페이지)가 먼저, 그 뒤 분기명 사전순.
- **summary/overall/per_step/windows/RPS 절대 미접촉** 유지(A2-2 불변식 — 페이지·분기 모두 이미 per-step에 집계된 자식의 wall-clock이라 오염 시 이중카운트).

### 4.6 리포트 스키마 (`report.rs` struct)
```rust
pub struct GroupLatency {
    pub step_id: String,
    pub count: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
    #[serde(default)]              // skip_serializing_if 없음 = 항상 직렬화(빈 vec도 [])
    pub branches: Vec<BranchLatency>,
}

pub struct BranchLatency {
    pub branch: String,
    pub count: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
}
```
- `GroupLatency`/`BranchLatency` 둘 다 `Serialize + Deserialize`(typed round-trip 테스트가 강제).
- **컴파일러-forced 리터럴 사이트(리뷰로 정정)**:
  - `GroupLatency`에 `branches` 추가 → 프로덕션 리터럴 **`report.rs:558` 한 곳**만 `branches: vec![…]` 필요. (`#[serde(default)]`는 역직렬화만 default라 리터럴엔 필드 필요.)
  - **`export.rs:419`는 `GroupLatency` 리터럴이 아니라 `group_latency: vec![]`(빈 `Vec<GroupLatency>`)** — 필드 추가가 여기엔 변경 강제 안 함(스펙 초안 오류 정정).
  - `GroupMetricRow`에 `branch` 추가 → 그 struct 리터럴 사이트가 컴파일러-forced: `report.rs:1192`(테스트 fixture), `store/metrics.rs:759`·`:765`(테스트 fixture), `grpc/coordinator.rs:856`(ingest, §4.4b). 각각 `branch: …` 추가.

### 4.7 UI `schemas.ts` + `GroupLatencyTable.tsx`
- `GroupLatencySchema`에 `branches: z.array(BranchLatencySchema)` — **plain required**(서버가 항상 emit하므로 `.default([])` 누출 회피, B7-C `ReportStep.download` 대신 group_latency 자체가 항상-emit인 케이스). 신규 `BranchLatencySchema{branch, count, p50_ms, p95_ms, p99_ms, max_ms}` `.strict()`.
- `GroupLatencyTable`: 각 parallel 노드 = 페이지 행(기존, `meta.get(step_id)?.name` 노드명) + 들여쓴 **분기 sub-행**(라벨 = `b.branch` 문자열 직접 — findStepById 불필요). 페이지 행 우측 정렬 컬럼(p50/p95/p99/max) 아래 분기 행이 같은 컬럼으로 병치돼 병목 비교. 테이블 헤더/단위(ms) 컨벤션 유지.

---

## 5. 불변식 / byte-identical

- **비-parallel run**: `group_hists` 비어있음 → 출력 무변경.
- **A2-2 페이지-only 와이어**: `GroupStat.branch=""`는 proto3 default라 미직렬화 → 페이지 행 와이어 byte-identical.
- **기존 0010 행**: migration 0014가 `branch TEXT NOT NULL DEFAULT ''` 추가 → 과거 행은 `branch=''`(=페이지)로 읽혀 무영향.
- **summary/RPS 비오염**: 별도 `group_acc`(페이지+분기)는 summary/overall/per_step/windows를 절대 안 건드림(A2-2 §2.1 불변식 연장).

---

## 6. 테스트 전략

- **엔진**: `aggregator` 단위(`(step_id, branch)` 키로 누적·드레인, `GroupStat.branch` emit). `runner`(parallel 분기별 latency 기록, **각 분기 행 count == 페이지 count**, 분기 행 수 == 분기 수).
- **컨트롤러**: `build_report` 단위(`group_acc` 키 (step_id,branch), 페이지 행 + 중첩 `branches`, **summary 비오염** 단언 유지). migration 가드(`ensure_run_group_metrics_branch` 멱등 — 두 번 실행해도 OK).
- **e2e**: `parallel_group_latency_report_e2e_smoke`(`e2e_test.rs:1980`) 확장 — 페이지 행의 `branches`가 분기 수(N)만큼이고 각 분기 라벨이 분기명과 일치, 각 분기 count == 페이지 count.
- **UI**: `GroupLatencyTable.test.tsx`(페이지 행 + 분기 sub-행 렌더, 분기 라벨). `schemas.ts` parse(branches 포함 fixture).
- **라이브(머지 전 필수, S-D 갭 차단)**: controller+worker 띄우고 한 분기를 의도적으로 느리게(예 `/slow` wiremock 200ms vs `/fast` 20ms) 부하 run → 리포트 `/report`에서 분기 p50 차이 확인 + 페이지 p50 ≈ max(분기) + 분기 count == 페이지 count + `ReportSchema.parse` 통과(콘솔 Zod 0). curl→python 직결 또는 실브라우저.

---

## 7. 빈 번호 (phase 머지 후, 충돌 방지)

- proto `GroupStat.branch` = **필드 4**(GroupStat 내 다음 빈 번호; `MetricBatch`엔 신규 필드 불필요 — group_stats=7 재사용).
- migration **0014**(phase가 0013 점유).
- `Profile` knob 불필요(per-branch는 opt-in 아님 — parallel run이면 항상; A2-2 페이지처럼 비용 무시 가능, B7-C와 달리 hot-path 계측 아님 = 동시 블록 1회 측정).

---

## 8. 미해결/연기 항목 (이 슬라이스 밖)

- per-branch **phase**(TTFB/다운로드) 3차원 분해.
- 분기 **성공/오류** 분할.
- 중첩 parallel·loop/if 컨테이너 내 parallel(UI authoring 확장과 함께).
- 분기 **초단위 시계열**(현재 run-total 분포만).
- open-loop 상호작용 정밀화(현재 공유 `execute_steps`로 자동 포함되나 별도 검증은 라이브에서).
