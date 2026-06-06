# Parallel 노드 그룹/페이지 레이턴시 (A2-2) — 설계

- **날짜**: 2026-06-06
- **출처**: 로드맵 §A2 도출 우선순위 "(2) 그룹/페이지 레이턴시 — 동시 호출의 max = 웹뷰 페이지 로드 KPI, Parallel(A2)이 선행됐으니 이제 정확". A2 잔여 연기 항목.
- **성격**: 리포트 깊이 확장(부하 모양은 A2가 이미 고침). 엔진(측정) + proto + controller(저장·리포트) + UI. loop 7-1 / if 9d breakdown 파이프라인을 **HDR(카운트가 아니라)** 로 재사용.
- **ADR**: 별도 불필요 — ADR-0033(parallel) 범위 내 additive. ADR-0033의 연기 목록에서 "그룹/페이지 레이턴시"를 구현으로 옮기는 한 줄 갱신만.

## 1. 목표 / 비목표

### 목표
각 `parallel` 노드가 자기 **페이지-로드 레이턴시 분포**를 종료 리포트에 emit한다. 페이지-로드 레이턴시 = 한 iteration에서 동시 분기 블록 전체의 wall-clock 시간(분기가 동시 실행되므로 ≈ 가장 느린 분기의 시간 = max). parallel 노드당 run 전체 분포 1개: `count + p50_ms + p95_ms + p99_ms + max_ms`.

이게 VU 스케일·per-endpoint p95로 대체 불가한 이유: per-endpoint p95는 각 호출을 독립으로 보지만, "페이지가 떴다"는 동시 호출 묶음이 **전부** 끝난 순간이다. 그 묶음당 max를 iteration 단위로 재서 분포를 내야 웹뷰 페이지 로드 KPI가 나온다 — 집계된 per-step 히스토그램에서는 `max(branch_a_i, branch_b_i)`를 복원할 수 없다(§2).

### 비목표 (이 슬라이스 밖, 연기)
- **페이지 성공률 / 에러 분할**: "이 페이지 로드에 실패한 분기가 있었나"는 v1 제외. 순수 레이턴시만(B7-D 레이턴시 분포가 성공/오류를 안 나눈 것과 동일). 추가하려면 `execute_steps`가 분기 에러 플래그를 버블해야 함 → 연기.
- **초단위 시계열**: per-second 페이지-로드 p95 곡선. v1은 run 전체 집계 1개(B7-D가 per-window 히스토그램을 연기한 것과 일관).
- **loop/if·일반 group 컨테이너로 확장**: 데이터 모델이 step_id 키라 additive로 가능하나 v1은 parallel만.
- **분기별 bottleneck 분해**: "어느 분기가 max였나" per-branch breakdown. v1은 블록 분포만.
- **중첩 parallel**: A2가 parallel을 top-level-only로 강제(UI Zod). 엔진 측정은 중첩이어도 동작하나 authoring 경로가 없음.
- **open-loop 전용 처리**: open-loop arrival도 시나리오를 돌며 Parallel arm을 타므로 그룹 레이턴시가 동일하게 기록된다(arrival당 측정). 별도 코드 없음 — 의도된 재사용.

### 알려진 한계 (버그 아님, 문서화 — spec-reviewer)
- **clean-flow 게이팅의 빈 분포 케이스**: `!aborted && !deadline_hit`일 때만 기록하므로, parallel 블록이 매우 길어 각 VU의 **첫-유일 블록이 run deadline을 가로지르면** 그 run의 `group_latency`가 빈 배열이 될 수 있다. 정상 run은 VU당 마지막 부분 블록 1개만 잃는다(올바름 — 잘린 시간은 max를 왜곡). UI는 빈 섹션을 미렌더(§4.6)라 사용자에겐 "데이터 없음"으로 보인다 — 버그로 읽지 말 것. (블록 시간 < run window면 항상 샘플 ≥1.)

## 2. 핵심 관찰: 데이터를 새로 측정해야 한다

B7-D(레이턴시 분포)는 "데이터가 이미 있다"였지만 이건 **반대**다. 리포트는 per-(step_id, ts_second) 집계 히스토그램만 갖는다 — 한 iteration에서 분기 A와 분기 B의 레이턴시가 **상관**돼 있다는 정보(같은 페이지 로드의 일부)가 집계 과정에서 사라진다. `max(branch_a_i, branch_b_i)`를 per-iteration으로 복원할 수 없으므로 **엔진이 Parallel 블록을 실행하는 시점에 wall-clock을 직접 재서** 집계해야 한다.

따라서 측정은 엔진 `runner.rs`의 `Step::Parallel` arm(`join_all`을 `Instant`로 감쌈)에서 일어나고, 새 메트릭 계열로 흐른다.

### 2.1 왜 per-step `run_metrics` 파이프라인을 재사용하면 안 되나 (별 테이블의 핵심 근거)

`build_report`(`report.rs:254` 부근)는 **모든** 윈도 히스토그램을 `overall`에 머지(`merge_into(&mut overall, &h)`)하고 **모든** count를 `total_count`/`rps`에 더한다. 그룹 레이턴시 샘플이 같은 `run_metrics`/`MetricWindow` 경로로 흐르면:
- `overall`에 머지돼 summary p50/p95/p99·B7-D 분포를 **오염**(페이지 로드는 이미 카운트된 자식들의 max라 이중 계산).
- `total_count`/`rps`를 **부풀림**(페이지 로드는 요청이 아닌데 요청처럼 카운트).

`build_report`가 어떤 step_id가 그룹 노드인지 알려면 시나리오 YAML을 walk해야 하는데(no-YAML-walk 불변식 위반), 그러지 않으려면 **별도 메트릭 계열**이 답이다. loop 7-1 / if 9d가 정확히 이 이유로 별도 테이블·proto 필드·최상위 배열을 썼다. 유일한 차이: 그들은 counts-only, 이건 HDR.

## 3. 데이터 표현 (와이어 포맷)

### 3.1 단위 결정: 밀리초(_ms), ReportStep과 동일
그룹 레이턴시 행은 per-노드 **통계 행**이라 `ReportStep`(p50_ms/p95_ms/p99_ms)·summary와 같은 ms 정수 컨벤션을 쓴다. 페이지 로드는 동시 호출의 max(보통 수십~수백 ms)라 ms 해상도로 충분(B7-D의 µs는 저지연 꼬리 해상도가 목적이었으나 페이지 로드엔 무관). UI는 StepStatsTable처럼 `"{p95_ms} ms"`로 렌더 — 별도 포맷 헬퍼 불필요.

### 3.2 proto (`crates/proto/proto/coordinator.proto`)
```proto
message GroupStat {
  string step_id = 1;        // the `parallel` node's id
  bytes hdr_histogram = 2;   // hdrhistogram V2 serialized (delta since last drain)
  uint64 count = 3;          // page-load samples in this delta
}

message MetricBatch {
  // ... 기존 1..6 ...
  repeated GroupStat group_stats = 7;   // parallel 페이지-로드 레이턴시 (delta, 컨트롤러가 merge)
}
```
`GroupStat.hdr_histogram`은 **마지막 drain 이후의 delta** 히스토그램(loop/if delta와 동형 — 컨트롤러가 누적 merge). count도 delta.

### 3.3 엔진 집계 (`crates/engine/src/aggregator.rs`)
```rust
/// A per-(parallel_step_id) page-load latency delta since the last drain.
/// HDR (not counts) — page latency is a distribution, merged by the controller
/// via Histogram::add (delta-merge), unlike LoopStat/BranchStat count-sum.
pub struct GroupStat {
    pub step_id: String,
    pub histogram: Histogram<u64>,  // live; worker serializes at forward time
    pub count: u64,
}
```
`Aggregator`에 필드 `group_hists: HashMap<String, (Histogram<u64>, u64)>`(히스토그램 bound = StepWindow와 동일 1µs–60s/3sig — `merge_into` 무손실).
- `record_group(&mut self, step_id: &str, latency_us: u64)`: `clamp(1, 60_000_000)` → `histogram.record(v)` + count++.
- `drain_group_deltas(&mut self) -> Vec<GroupStat>`: `std::mem::take`로 take+reset(delta 의미). 히스토그램은 **live로 반환**(worker가 직렬화) — StepWindow와 동일, BranchStat/LoopStat의 counts와 다름.

### 3.4 MetricFlush (`runner.rs`)
`MetricFlush`에 `pub group_stats: Vec<GroupStat>` 추가. 4개 리터럴 사이트 전부 `group_stats: { let mut a = agg.lock().await; a.drain_group_deltas() }`(이미 windows/loop/branch를 같은 락에서 드레인 — 같은 락 구간에 추가). periodic + final 둘 다 드레인(branch_stats와 동형):
- closed-loop: `runner.rs:195`(periodic), `:230`(final).
- open-loop: `runner.rs:624`(periodic), `:771`(final).

비-parallel 시나리오는 빈 벡터 → **와이어 byte-identical**.

**flush send-guard 3곳도 갱신**(4 리터럴 사이트와 별개): 4 flush 중 **3곳이 "보낼 데이터 있나" 가드**로 감싸여 있어 group_stats만 차 있고 windows/loops/branches가 비면 flush가 **스킵돼 그룹 샘플 유실**된다. parallel 시나리오는 http-leaf 윈도가 항상 차 있어 실제로는 안 터지나, `dropped`가 `&& flush.dropped == 0`을 넣은 것과 같은 방어로 group 조건을 추가한다(코드 직접 확인 — spec-reviewer는 :228/:615만 보고 :187 누락):
- **closed-loop periodic** 가드 `runner.rs:187`: `if !drained.is_empty() || !loop_stats.is_empty() || !branch_stats.is_empty()` → `|| !group_stats.is_empty()` 추가.
- **closed-loop final** 가드 `runner.rs:228`: `if !final_windows.is_empty() || !final_loops.is_empty() || !final_branches.is_empty()` → `|| !final_groups.is_empty()` 추가.
- **open-loop periodic** `has_data` 가드 `runner.rs:614`: `!drained.is_empty() || !loop_stats.is_empty() || !branch_stats.is_empty()` → `|| !group_stats.is_empty()` 추가.

(**open-loop final** `:771`만 무조건 send — `total_dropped`를 실어야 해서 가드 없음. 필드만 추가.)

## 4. 컴포넌트 설계

### 4.1 엔진 측정 — `runner.rs` `Step::Parallel` arm

`join_all`을 `Instant`로 감싸고, **flow가 깨끗할 때만** 기록한다.
```rust
Step::Parallel(par) => {
    // ... entry snapshot, seeds (변경 없음) ...
    let t0 = Instant::now();
    let results = futures::future::join_all(futs).await;
    let elapsed_us = t0.elapsed().as_micros() as u64;
    // ... merge loop: aborted / deadline_hit 계산 (변경 없음) ...

    // 페이지-로드 레이턴시: 블록이 깨끗이 완료됐을 때만 기록한다.
    // deadline에 잘린 마지막 블록은 분기가 조기 return해 시간이 낮게
    // 왜곡되므로 제외(loop 부분 iteration과 같은 신중함). count > 0 보장.
    if !aborted && !deadline_hit {
        agg.lock().await.record_group(&par.id, elapsed_us);
    }
    if aborted { return Ok(StepFlow::Aborted); }
    if deadline_hit { return Ok(StepFlow::DeadlineReached); }
}
```
- 락은 `record_branch`처럼 짧게 스코프(이미 merge 후라 재귀 호출 없음).
- `Instant`는 runner에서 이미 deadline용으로 사용 중(import 추가 불요 가능 — plan에서 확인).
- 핫 flat-http·loop·if 경로 무변경. trace는 **무변경**(아래 §4.2).

### 4.2 trace (`trace.rs`) — 무변경
test-run trace는 1-VU 단일 패스로 분기를 **순차** 실행(타이밍 무의미, ADR-0033)하므로 그룹 레이턴시를 기록하지 않는다. loop/if breakdown이 trace에 없는 것과 동일 — 그룹 레이턴시는 **부하 경로 전용 메트릭**. `trace_scenario`/`trace_steps` 무변경.

### 4.3 워커 (`crates/worker/src/main.rs`)
windows 직렬화 패턴 그대로:
```rust
let group_stats: Vec<pb::GroupStat> = flush.group_stats.into_iter().filter_map(|g| {
    let hdr = g.serialize_histogram().ok()?;   // GroupStat에 serialize_histogram 메서드 추가
    Some(pb::GroupStat { step_id: g.step_id, hdr_histogram: hdr, count: g.count })
}).collect();
```
- 엔진 `GroupStat`에 `serialize_histogram(&self) -> Result<Vec<u8>>`(StepWindow의 것 복제) 추가.
- 엔진 `GroupStat`은 `pub` + `lib.rs:15` 재export(`{Aggregator, BranchStat, LoopStat, StepWindow}` 옆) 필수 — `MetricFlush.group_stats: Vec<GroupStat>` 필드 타입이 worker에서 nameable하려면.
- 빈-배치 스킵 가드에 `&& group_stats.is_empty()` 추가(`main.rs:282-285`).
- **`pb::MetricBatch { ..., group_stats }` 리터럴은 두 곳**(prost exhaustive — spec-reviewer가 정정): worker `main.rs`(forward) **AND** `crates/controller/src/grpc/coordinator.rs:1236`(`#[tokio::test]` 헬퍼 `mk`). 둘 다 `group_stats` 추가해야 컴파일. `grep -rn "MetricBatch {" crates/`로 확인.

### 4.4 컨트롤러 저장 (`crates/controller/src/store/`)

- **migration 0010** (`MIGRATION_SQL_0010`, `CREATE TABLE IF NOT EXISTS`):
  ```sql
  CREATE TABLE IF NOT EXISTS run_group_metrics (
    run_id        TEXT    NOT NULL,
    step_id       TEXT    NOT NULL,
    hdr_histogram BLOB    NOT NULL,
    count         INTEGER NOT NULL
  );
  ```
  **append-only** — PK/UPSERT 없음. 이유: HDR은 SQL에서 머지 불가(loop/if의 `count + excluded.count` UPSERT 불가능)라 run_metrics와 같은 "여러 행 저장→읽을 때 merge" 모델. `worker_id` 컬럼 불필요 — 멀티워커 delta는 disjoint이므로 그냥 추가 행으로 merge되면 정확(loop/if가 worker_id 안 넣는 것과 같은 이유).
  - **append-only 멱등 주의(spec-reviewer)**: 이건 멱등 키 없는 유일한 메트릭 테이블이다. `run_metrics`는 PK keep-first, loop/if는 PK UPSERT라 둘 다 재전송에 멱등하지만 group은 plain INSERT라 배치가 두 번 도착하면 이중 카운트된다. **안전한 진짜 이유는 "메트릭 배치는 단일 bidi 스트림으로 한 번만 전달되고 run 중 재전송 안 됨"**(워커 `connect_with_backoff`는 초기 연결 한정, run 중 단절 → run fail-fast). loop/if 유추가 아니라 이 전달-once 보장이 멱등 부재를 메운다 — plan에 명시.
  - **함정(controller CLAUDE.md)**: const 추가 + `connect()`의 `.execute()` 라인 추가 **둘 다**. rebase 시 execute 라인이 silently auto-merge로 누락되니 `grep -c MIGRATION_SQL`로 const N개·execute N개 교차검증. (0008/0009는 Rust-guarded라 const 리스트엔 0001–0007만 — 0010은 순수 SQL const, 다음 자유 번호.)
- **`ingest_metrics`**: `batch.group_stats`마다 `INSERT INTO run_group_metrics (run_id, step_id, hdr_histogram, count) VALUES (?,?,?,?)`(append). loop/if 누적 UPSERT 옆에 추가.
- **store read** `group_metrics_for_run(run_id) -> Vec<GroupMetricRow>` where `GroupMetricRow { step_id: String, hdr_histogram: Vec<u8>, count: i64 }`. `report()` 핸들러·export 공유 헬퍼(`build_report_for_run`)의 fetch 블록에 추가.

### 4.5 컨트롤러 리포트 (`crates/controller/src/report.rs`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GroupLatency {
    pub step_id: String,    // the `parallel` node's id
    pub count: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
}
// ReportJson 에 추가:
#[serde(default)]
pub group_latency: Vec<GroupLatency>,
```
`build_report` 시그니처에 **6번째 파라미터** `groups: &[GroupMetricRow]` 추가. step_id별 머지(별도 누적기, `overall`/`total_count`/`per_step`/`windows`/`status_dist` **전부 미접촉** = 오염 0):
```rust
let mut group_acc: BTreeMap<String, (Histogram<u64>, u64)> = BTreeMap::new();
for g in groups {
    let e = group_acc.entry(g.step_id.clone()).or_insert_with(|| (fresh_hist(), 0));
    if let Ok(Some(h)) = decode_hdr(&g.hdr_histogram) { merge_into(&mut e.0, &h); } // fail-soft
    e.1 += g.count as u64;   // count는 디코드 성공과 무관하게 누적(워커 권위, windows fail-soft와 동일 철학)
}
let group_latency: Vec<GroupLatency> = group_acc.into_iter().map(|(step_id, (h, count))| {
    let p = percentiles_of(&h);
    GroupLatency { step_id, count, p50_ms: p.p50_ms, p95_ms: p.p95_ms, p99_ms: p.p99_ms,
                   max_ms: h.max() / 1000 }
}).collect();
```
- **`#[serde(default)]` 필수**로 골든 fixture(A4b `testdata/compare_golden.json`, Rust 측 `Vec<ReportJson>` 파싱·`export.rs:435`)·기존 직렬화 리포트 호환. `ReportJson`은 `deny_unknown_fields` 미사용이라 OK. 빈 배열은 `[]`로 직렬화(Option 아님). **precedent 정정(spec-reviewer)**: `#[serde(default)] Vec`의 선례는 `insights`(`report.rs:22-23`)다 — `if_breakdown`(`report.rs:19`)은 `#[serde(default)]`가 **없어서** 필드 부재 시 역직렬화 실패하므로 그걸 따라하면 안 됨. 고른 attribute(`#[serde(default)]`)는 맞다.
- **모든 call site에 `&[]` 추가 (총 12 + 정의 1, spec-reviewer 실측)**: production 1곳(`build_report_for_run` → `runs.rs:389`) + report.rs 테스트 11곳(lines 500/548/573/616/660/749/763/770/777/792/814). export·e2e는 `build_report_for_run`/HTTP 경유라 직접 호출 없음. 시그니처 변경이라 컴파일러가 전부 강제.

### 4.6 UI

#### Zod — `ui/src/api/schemas.ts`
```ts
const GroupLatencySchema = z.object({
  step_id: z.string(),
  count: z.number().int().nonnegative(),
  p50_ms: z.number().int().nonnegative(),
  p95_ms: z.number().int().nonnegative(),
  p99_ms: z.number().int().nonnegative(),
  max_ms: z.number().int().nonnegative(),
}).strict();
// ReportSchema 에:  group_latency: z.array(GroupLatencySchema).optional(),   // .optional(), NOT .default([])
```
**`.optional()` + 소비처 `?? []`** — `if_breakdown`(`schemas.ts:246` `z.array(IfBreakdownSchema).optional()`)과 동일 패턴. **`.default([])` 금지(spec-reviewer)**: ui/CLAUDE.md(S-C) 함정 — 응답 스키마의 top-level `.default()`는 `request<T>`로 `T | undefined`를 누출시키고 `tsc -b`(`pnpm build`)에서만 잡힌다. `.optional()`은 누출 없고(`if_breakdown`이 증명) **기존 Report fixture에 `group_latency`를 안 넣어도 parse 통과**(plain required면 `dropped` S-D 교훈처럼 모든 fixture 수정 필요 — `.optional()`로 회피). 그리고 **머지 전 라이브 run으로 실제 응답이 배열인지 확인**(S-D 교훈 — RTL absent fixture는 서버 실제 shape를 안 보장).

#### 테이블 — `ui/src/components/report/GroupLatencyTable.tsx` (BranchStatsTable 미러)
- parallel 노드당 행: 라벨(노드명) + count + p50/p95/p99/max ms.
- **라벨 resolve**: `findStepById`(9c 추가, 어떤 타입 스텝도 찾음)로 시나리오 YAML에서 `parallel` 노드를 찾아 `name` 표시(예: `"페이지 로드: {name}"` 또는 그냥 `{name}`). step_id가 안 풀리면 step_id 원문(BranchStatsTable의 `ifMeta` fallback 패턴).
- 섹션 제목 "페이지 로드 레이턴시"(`<h3>`/`<section aria-label>` — 기존 리포트 섹션 컨벤션). `group_latency`가 비면 섹션 전체 미렌더.
- 배치: `StepStatsTable` 뒤(BranchStatsTable가 StepStatsTable 뒤에 오는 것과 같은 자리 묶음) — `ReportView.tsx`.

## 5. 불변식 / 와이어 1:1

- **핫 flat-http 경로 byte-identical**, 비-parallel run 와이어 byte-identical(빈 group_stats). 엔진 변경은 Parallel arm(타이밍+조건부 record_group) + aggregator(새 필드/메서드)뿐.
- **그룹 레이턴시는 summary/overall/RPS/per_step/windows를 절대 안 건드린다**(§2.1) — 별도 누적기·별도 테이블·최상위 배열. 회귀 테스트로 단언.
- loop/if/closed-vs-open 회귀 0. trace 무변경.
- 필드명 snake_case 1:1: `group_stats`/`group_latency`/`step_id`/`count`/`p50_ms`/`p95_ms`/`p99_ms`/`max_ms`/`hdr_histogram`. Rust ↔ proto ↔ Zod 정확 대조(최종 handicap-reviewer).

## 6. 테스트 전략

- **엔진 유닛** (`aggregator.rs` `#[cfg(test)]`): `record_group`+`drain_group_deltas` reset(2회 드레인 → 2번째 빈), 다중 step_id 분리, clamp.
- **엔진 통합** (`crates/engine/tests/`): 2분기 parallel(분기에 인공 지연차) 시나리오 → 그룹 샘플이 블록 시간 ≈ max(분기) 1개 기록, 비-parallel 시나리오 → group_stats 빈.
- **컨트롤러** (`report.rs` `#[cfg(test)]`): `build_report_attaches_group_latency`(샘플 행→분포), append 여러 행 step_id별 merge+count SUM, bad HDR blob fail-soft(count는 유지·p=0), **group이 `overall`/`total_count`/`rps` 미오염** 단언(핵심), round-trip(`to_value`/`from_value`), 빈 groups→`group_latency: []`.
- **e2e** (`crates/controller/tests/e2e_test.rs`): `parallel_group_latency_report_e2e_smoke` — 워커 subprocess→컨트롤러→리포트, `group_latency` 비어있지 않고 p95 > 0(인공 지연).
- **UI (RTL)**: `GroupLatencyTable` fixture 렌더(행·라벨 단언) + `ReportSchema` parse(`group_latency` 정상 배열·빈 배열 둘 다).
- **라이브** (머지 전 1회): parallel 시나리오 run → 리포트에서 페이지-로드 p50 ≈ max(분기) > 개별 분기 p50, summary RPS·count는 분기 http만(그룹 미포함) 확인. (S-D 교훈: run 생성/응답 파싱은 RTL로 안 잡힘 → 실 `/report` → `ReportSchema.parse` 통과 확인.)

## 7. 게이트

- Rust: `cargo fmt` + `cargo build --workspace` + `cargo clippy --workspace --all-targets -- -D warnings` + `cargo test --workspace`(pre-commit 훅). engine/worker 변경이라 cold-build 워커-바이너리 race flake 주의 — 커밋 전 `cargo build -p handicap-worker && cargo build --workspace` warm.
- UI: `cd ui && pnpm lint && pnpm test && pnpm build`(수동 — 훅은 cargo만).
- proto 변경: `pb::MetricBatch{}` 리터럴은 **두 곳**(worker `main.rs` + controller `grpc/coordinator.rs:1236` 테스트 `mk`) — prost exhaustive, `grep -rn "MetricBatch {" crates/`로 확인.

## 8. 구현 순서 (plan에서 세분)

1. **엔진**: aggregator `GroupStat`/`group_hists`/`record_group`/`drain_group_deltas`(+`serialize_histogram`) + MetricFlush 필드 + Parallel arm 측정 + 유닛/통합 테스트. (proto는 이 task에서 같이 — MetricFlush↔proto는 worker가 잇지만 엔진 GroupStat은 proto와 독립이라 분리 가능; plan에서 결정.)
2. **proto + worker**: `GroupStat`/`MetricBatch.group_stats` + worker 직렬화·스킵 가드.
3. **컨트롤러 저장**: migration 0010 + `ingest_metrics` append + `group_metrics_for_run` read.
4. **컨트롤러 리포트**: `GroupLatency`/`ReportJson.group_latency` + `build_report` 6번째 파라미터 + 전 call site + 테스트.
5. **UI**: Zod + `GroupLatencyTable` + ReportView 슬롯 + RTL.
6. **e2e + 라이브**.

(pre-commit 전체-게이트 때문에 dead-code/RED-only 단독 커밋 불가 — 헬퍼+테스트+배선을 green 커밋 단위로 묶는다. 새 proto 필드를 추가하는 task는 worker 직렬화·MetricBatch 리터럴까지 같은 커밋이라야 컴파일. CLAUDE.md "검증 자동화" 참조.)
