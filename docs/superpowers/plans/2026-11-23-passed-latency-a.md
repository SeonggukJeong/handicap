# 응답 시간 표본 슬라이스 A (passed-latency-a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 리포트의 응답 시간 값을 통과한 요청만으로 계산하고(실패한 요청의 응답 시간은 따로 모아 「실패한 요청」·「모든 요청」 표본도 낼 수 있게), 통과한 요청이 없을 때 0ms·거짓 통과가 나오지 않게 한다.

**Architecture:** 워커가 창마다 실패한 요청만의 HDR 분포를 `MetricWindow.failed_hdr_histogram`(optional bytes 7)으로 함께 보내고, 컨트롤러가 `run_metrics.failed_hdr_histogram`(NULL 허용)에 저장한다. 컨트롤러의 새 모듈 `sample.rs`가 누적 자리마다 전체·실패 분포를 따로 합친 뒤 한 번 빼서 통과 표본을 만든다. `build_report`는 한 번의 빌드로 「보여 주는 값」(요청한 표본)·「판정하는 값」(기본 표본)·「점유 값」(모든 요청)을 낸다. 계단은 실행 중·종료 뒤 모두 창 단위로 표본을 고른다.

**Tech Stack:** Rust(engine·worker·controller, `hdrhistogram` 7.5.4, prost, sqlx/SQLite), TypeScript/React(Zod, React Query, Recharts), Python(`/perf-ab` 스크립트).

REVIEW-GATE: APPROVED

(spec-plan-reviewer: spec 4차·plan 4차에 clean APPROVE, 2026-11-23)

**Spec:** `docs/superpowers/specs/2026-11-23-passed-latency-design.md` (US 블록은 그 파일 「사용자 스토리 (US)」 헤딩 — 매 task brief에 첨부). 목업(시각 기준): `docs/superpowers/specs/2026-11-23-passed-latency-mockups/screens.html`의 1-가·3·4·5·6. **목업의 CSS·마크업이 시각 기준이다**(working-rules §4).

## Global Constraints

- 작업 디렉토리: `/Users/sgj/develop/handicap/.claude/worktrees/verdict-stats` (브랜치 `worktree-verdict-stats`). 모든 subagent prompt 첫 줄에 `cd`를 쓴다.
- 성공한 요청의 기록 경로에 새 일을 더하지 않는다(spec §1.4, R1). 리포트 빌드에서 행 BLOB은 지금처럼 **행당 한 번만** 디코드한다(예외: 빼기가 실패한 자리의 행 단위 다시 계산 — 있을 수 없는 상태에서만 도는 경로).
- 나눌 수 없는 run(실패 칸이 NULL인 행이 하나라도 있거나 행이 없는 run)의 리포트는 `sample` 블록 말고는 지금과 바이트 동일하다(R12).
- 통과한 요청이 없는 자리에 0을 찍지 않는다(R17·R28). 「계산 실패」(`Broken`)는 「통과한 요청 없음」(`Empty`)이 아니다(R9).
- 표본 이름(화면 문구): 「통과한 요청」·「실패한 요청」·「모든 요청」. 「전체」는 쓰지 않는다. 와이어 값: `passed`·`failed`·`all`.
- 새 문구는 전부 `ui/src/i18n/ko.ts` 경유. 번역투 명사구 금지(working-rules §8). 결함을 변호하는 주석 금지(§7).
- 커밋: task마다 독립 green 커밋. `git commit`에 파이프 금지, `--no-verify` 금지. cargo-영향 커밋은 수 분(implementer는 단일 FOREGROUND 호출, 600000ms).
- tdd-guard: 각 task의 Step 1(테스트)이 production 편집보다 먼저다. 순서를 바꾸지 않는다.
- **Task 5 ↔ Task 12 사이에는 화면으로 라이브 확인을 하지 않는다** — 서버가 `sample` 키를 보내는데 UI의 `.strict()` 스키마가 아직 모른다.
- 라이브로 볼 때는 **`cargo build -p handicap-worker`를 먼저** 한다. 옛 워커 바이너리는 새 칸을 안 보내 모든 run이 「나눌 수 없음」으로 나오고, 화면은 아무 오류 없이 「모든 요청」만 보여 준다.
- 코드 리뷰 모델: Task 1–10은 Opus(엔진·proto·마이그레이션·리포트 계산·내보내기), Task 12–16은 Sonnet.
- 줄 번호는 저작 시점 값이다. 구현 때 `grep -n`으로 다시 확인한다.

## Review Focus

1. **실패가 전체보다 많은 칸 / 깨진 BLOB** — 리포트가 계속 만들어지고 정상 행의 값이 남는다. 전부 깨진 자리는 `Broken`이고 `no_sample` 판정을 받지 않는다 → Task 4·7.
2. **요청은 있는데 전부 「보내지 않음」인 스텝**(분포는 있지만 표본 0) — `Empty` → 판정 `no_sample`, 화면 「—」 → Task 4·7·13.
3. **버전이 섞인 run**(일부 행만 실패 칸 있음) — run 전체가 `all`, 실패 칸을 읽지 않는다 → Task 4·5.
4. **`?sample=passed`가 URL에 남은 채 옛 run을 연다** — 400이 아니라 `all` 리포트 → Task 9.
5. **같은 run의 기본 리포트가 캐시에 있을 때 슬롯 사이징** — `all` 리포트를 따로 받는다 → Task 12.

## File Structure

| 파일 | 책임 |
|---|---|
| `crates/engine/src/aggregator.rs` | `StepWindow`에 실패 분포(첫 실패 때 생성)·직렬화 |
| `crates/proto/proto/coordinator.proto` | `MetricWindow.failed_hdr_histogram = 7` |
| `crates/worker/src/lib.rs` | `flush_to_batch`가 새 칸을 항상 싣기 |
| `crates/controller/src/store/mod.rs`·`store/metrics.rs` | 마이그레이션 0028, 행 구조체·읽기·쓰기 |
| `crates/controller/src/grpc/coordinator.rs` | 수신 → 행 변환에 새 칸 |
| `crates/controller/src/sample.rs` (새 파일) + `crates/controller/tests/sample_test.rs` (새 파일) | `Sample`·`run_is_split`·`decode_row`·`SplitHist`·`Resolved`·`window_hist_per_window` |
| `crates/controller/src/report.rs` | 누적 자리를 `SplitHist`로, 세 값, `sample` 블록, `no_sample` |
| `crates/controller/src/stair.rs`·`stair_monitor.rs` | 창 단위 표본 |
| `crates/controller/src/api/runs.rs` | `?sample=` |
| `crates/controller/src/export.rs` | `latency_sample` 행·열, 값 없음 빈 칸 |
| `.claude/skills/perf-ab/perf_ab.py`·`SKILL.md` | `--allow-errors` |
| `ui/src/api/{schemas,client,hooks}.ts` | 와이어·표본 인자·캐시 열쇠 |
| `ui/src/report/hasLatency.ts` (새 파일) | 「표본에 해당하는 요청이 있는가」 단일 소스 |
| `ui/src/components/report/SampleBar.tsx`·`MixedSampleBadge.tsx` (새 파일) | 머리 표지·「실패 포함」 표지 |
| 그 밖의 `ui/src/components/report/**`·`ui/src/print/**`·`ui/src/compare/**` | 0 대신 「—」, `no_sample`, 표본 한 줄, 비교 안내 |
| `docs/adr/0063-passed-latency-sample.md` (새 파일) | 결정 기록 |

---

### Task 1: 엔진 — 창마다 실패한 요청의 분포를 따로 모은다 (R1)

**Files:**
- Modify: `crates/engine/src/aggregator.rs` (`StepWindow` 약 :181–226, 테스트 모듈)
- Modify: `crates/worker/src/lib.rs`의 `StepWindow { … }` 테스트 리터럴(`grep -rn "StepWindow {" crates/`)

**Interfaces:**
- Produces: `StepWindow.failed_histogram: Option<Histogram<u64>>`(pub), `StepWindow::serialize_failed_histogram(&self) -> Result<Vec<u8>>`(없으면 빈 벡터).

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`aggregator.rs`의 `mod tests`)

```rust
#[test]
fn failed_histogram_absent_when_no_errors() {
    let mut w = StepWindow::new("s".into(), 1);
    w.record(1_000, 200, false);
    w.record(2_000, 200, false);
    assert!(w.failed_histogram.is_none());
    assert_eq!(w.serialize_failed_histogram().unwrap(), Vec::<u8>::new());
    assert_eq!(w.histogram.len(), 2);
}

#[test]
fn failed_histogram_holds_only_error_samples() {
    let mut w = StepWindow::new("s".into(), 1);
    w.record(40_000, 200, false);
    w.record(2_000, 500, true);
    w.record(90_000_000, 0, true); // 60초로 잘린다
    w.record_not_sent();           // 표본 없음
    let f = w.failed_histogram.as_ref().expect("first error creates it");
    assert_eq!(f.len(), 2);
    assert_eq!(w.histogram.len(), 3);          // 전체 분포는 지금과 같다
    assert_eq!(w.error_count, 3);              // 보내지 않음 포함
    assert!(f.max() >= 59_998_208);            // 같은 값(자른 값)이 들어간다
    assert!(!w.serialize_failed_histogram().unwrap().is_empty());
}
```

- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-engine failed_histogram`. 기대: 컴파일 에러(`failed_histogram` 없음).
- [ ] **Step 3: 구현** — `StepWindow`에 `pub failed_histogram: Option<Histogram<u64>>`(`new`에서 `None`). `record`의 기존 `if is_error` 블록 안에서 `get_or_insert_with`로 같은 경계(1, 60_000_000, 3)의 분포를 만들어 자른 값 `v`를 넣는다. 성공 경로에는 줄을 더하지 않는다. `serialize_failed_histogram`은 `serialize_histogram`과 같은 V2 직렬화, `None`이면 `Ok(Vec::new())`.
- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-engine failed_histogram` PASS. 워커 테스트 리터럴에 `failed_histogram: None`을 더해 `cargo build --workspace --tests` green.
- [ ] **Step 5: 되돌려 확인** — 새 기록 줄을 `if is_error` 밖으로 옮겨 `failed_histogram_absent_when_no_errors` RED 확인 → 원복.
- [ ] **Step 6: 커밋** — `feat(engine): 창마다 실패한 요청의 응답 시간 분포를 따로 모은다`.

---

### Task 2: proto + 워커 — 실패 분포를 항상 싣는다 (R2)

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (`message MetricWindow`)
- Modify: `crates/worker/src/lib.rs` (`flush_to_batch` 약 :822–841, 테스트 모듈)
- Modify: 컨트롤러 테스트의 `MetricWindow {` 리터럴 7곳(`grep -rn "MetricWindow {" crates/`)

**Interfaces:**
- Consumes: Task 1의 `serialize_failed_histogram`.
- Produces: prost `MetricWindow.failed_hdr_histogram: Option<Vec<u8>>` — 워커는 항상 `Some`(실패 없으면 `Some(vec![])`).

- [ ] **Step 1: 실패하는 테스트** (`crates/worker/src/lib.rs` 테스트 모듈)

```rust
#[test]
fn flush_always_carries_failed_histogram_field() {
    // 실패 없는 창("ok")과 실패 있는 창("bad")을 flush_to_batch에 넣는다(기존 테스트가 MetricFlush를 만드는 법을 따른다).
    let ok = /* batch.windows 중 step_id == "ok" */;
    let bad = /* step_id == "bad" */;
    assert_eq!(ok.failed_hdr_histogram.as_deref(), Some(&[][..]));
    assert!(bad.failed_hdr_histogram.as_ref().is_some_and(|b| !b.is_empty()));
}

#[test]
fn failed_histogram_is_field_7() {
    use prost::Message;
    let w = handicap_proto::MetricWindow { failed_hdr_histogram: Some(vec![]), ..Default::default() };
    assert_eq!(w.encode_to_vec(), vec![0x3a, 0x00]); // 태그 7·길이 0
}
```

(proto 크레이트의 실제 경로 이름은 그 파일의 기존 `use`를 따른다.) 기존 `hand_built_batch_bytes_pin_field_numbers`의 창 리터럴에는 `failed_hdr_histogram: None`을 넣어 고정 바이트를 그대로 둔다.

- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-worker failed_histogram` → 컴파일 에러.
- [ ] **Step 3: 구현** — proto에 `optional bytes failed_hdr_histogram = 7;`(주석: 없음 = 옛 부하기, 빈 값 = 실패 없음). `flush_to_batch`의 창 변환에서 실패 분포 직렬화도 `.ok()?`로 받아(실패하면 그 창을 건너뛴다) `failed_hdr_histogram: Some(bytes)`. 컨트롤러 테스트 리터럴에는 `failed_hdr_histogram: None`.
- [ ] **Step 4: 통과 확인** — `cargo build --workspace --tests` green, `cargo test -p handicap-worker` PASS.
- [ ] **Step 5: 커밋** — `feat(proto,worker): MetricWindow.failed_hdr_histogram(7) — 실패한 요청의 분포`.

---

### Task 3: 저장 — 마이그레이션 0028 + 행 구조체 (R3)

**Files:**
- Modify: `crates/controller/src/store/mod.rs` (`connect()`의 마지막 마이그레이션 뒤에 `ensure_run_metrics_failed_hdr` — 본보기 `ensure_runs_verdict_json` :189)
- Modify: `crates/controller/src/store/metrics.rs` (`MetricRow`, `insert_batch`, `WindowWithHdr`, `windows_with_hdr`)
- Modify: `crates/controller/src/grpc/coordinator.rs` (`ingest_metrics`의 행 변환 약 :2360–2376)
- Modify: `MetricRow {`(약 66곳)·`WindowWithHdr {`(약 21곳) 리터럴 — 컴파일러가 알려 준다. 전부 `failed_hdr_histogram: None`.

**Interfaces:**
- Produces: `MetricRow.failed_hdr_histogram: Option<Vec<u8>>`, `WindowWithHdr.failed_hdr_histogram: Option<Vec<u8>>`. DB 칸 `run_metrics.failed_hdr_histogram BLOB`(NULL 허용).

- [ ] **Step 1: 실패하는 테스트** (`store/metrics.rs` 테스트 모듈)

```rust
#[tokio::test]
async fn failed_hdr_roundtrips_none_empty_and_bytes() {
    // 같은 run에 세 행(스텝 id만 다르게): None / Some(vec![]) / Some(vec![1,2,3])
    // windows_with_hdr로 읽어 각각 None / Some(vec![]) / Some(vec![1,2,3])
    // 직접 SQL: SELECT COUNT(*) FROM run_metrics WHERE failed_hdr_histogram IS NULL == 1
}

#[tokio::test]
async fn migration_0028_is_idempotent() {
    // 같은 파일 DB에 connect() 두 번 → 에러 없음,
    // SELECT COUNT(*) FROM pragma_table_info('run_metrics') WHERE name='failed_hdr_histogram' == 1
}
```

- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-controller failed_hdr_roundtrips` → 컴파일 에러.
- [ ] **Step 3: 구현** — `ensure_run_metrics_failed_hdr(db)`: 칸이 없을 때만 `ALTER TABLE run_metrics ADD COLUMN failed_hdr_histogram BLOB`. `insert_batch`·`windows_with_hdr`의 칸 목록에 추가. `ingest_metrics`는 `w.failed_hdr_histogram.clone()`.
- [ ] **Step 4: 통과 확인** — `cargo build --workspace --tests` green · `cargo nextest run -p handicap-controller --features in-process`(실행 테스트 수가 0이 아닌지 본다).
- [ ] **Step 5: 커밋** — `feat(controller): run_metrics.failed_hdr_histogram (migration 0028)`.

---

### Task 4: `sample.rs` — 표본 계산 한 곳 (R4·R5·R9)

**Files:**
- Create: `crates/controller/tests/sample_test.rs` (**먼저** — tdd-guard: `lib.rs`·새 `sample.rs`는 테스트 경로가 아니다)
- Create: `crates/controller/src/sample.rs`
- Modify: `crates/controller/src/lib.rs`(`pub mod sample;`)

**Interfaces:**
- Consumes: `WindowWithHdr`(Task 3), `handicap_engine::percentiles::decode_hdr`.
- Produces(전부 `pub`):

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Sample { Passed, Failed, #[default] All }

pub fn run_is_split(rows: &[WindowWithHdr]) -> bool;

/// 한 행을 한 번 디코드한다. None = 그 행을 버린다(전체 BLOB이 깨졌거나, 실패 BLOB이 비어 있지 않은데 깨졌다).
/// `failed`에 None을 넘기면 실패 칸을 읽지 않는다(나눌 수 없는 run).
pub struct DecodedRow { pub all: Histogram<u64>, pub failed: Option<Histogram<u64>> }
pub fn decode_row(all: &[u8], failed: Option<&[u8]>) -> Option<DecodedRow>;

pub enum Resolved<'a> {
    Hist(std::borrow::Cow<'a, Histogram<u64>>), // 표본이 1개 이상
    Empty,                                       // 행은 계산됐는데 그 표본에 해당하는 요청이 없다
    Broken,                                      // 계산된 행이 하나도 없다
}
impl Resolved<'_> {
    pub fn hist(&self) -> Option<&Histogram<u64>>;
    pub fn is_empty_sample(&self) -> bool; // Empty만 true
}

/// 한 누적 자리(초·스텝 창, 스텝, 워커, 전체). `'r` = 행 BLOB의 수명.
#[derive(Default)]
pub struct SplitHist<'r> { /* all, failed, fed: bool, clean_rows: usize, fail_rows: Vec<(&'r [u8], &'r [u8])> */ }
impl<'r> SplitHist<'r> {
    /// 디코드된 행을 합친다. `raw`는 그 행에 실패 표본이 있을 때만 (전체 BLOB, 실패 BLOB)을 넘긴다.
    pub fn add(&mut self, row: &DecodedRow, raw: Option<(&'r [u8], &'r [u8])>);
    pub fn resolve(&self, s: Sample) -> Resolved<'_>;
    /// resolve와 같은 결과를 소유권으로. 빼기가 필요 없으면 복사 없이 옮긴다.
    pub fn into_hist(self, s: Sample) -> Option<Histogram<u64>>; // Empty·Broken → None
}

/// 계단용: 실패 칸이 있으면(Some) 통과 표본, 없으면 전체. 계산 실패·표본 0은 None.
pub fn window_hist_per_window(all: &[u8], failed: Option<&[u8]>) -> Option<Histogram<u64>>;
```

`resolve` 규칙:
- **한 번도 `add`되지 않은 자리 → `Broken`**(모든 표본).
- `All`: 전체를 빌려 준다. 표본 수 0이면 `Empty`.
- `Failed`: 실패를 빌려 준다. 실패 분포가 없거나 표본 수 0이면 `Empty`.
- `Passed`: 실패 분포가 없으면 `All`과 같다(빌려 준다). 있으면 전체의 **복사본**에서 실패를 뺀다. 성공하면 표본 수 0 → `Empty`, 아니면 `Hist`.
- `Passed`의 빼기가 `Err`면 **행 단위로 다시 계산**한다(전부 복사본에서):
  1. 전체의 복사본에서 `fail_rows`의 각 행의 전체를 뺀다(합칠 때 더한 것이라 실패하지 않는다 — 실패하면 `Broken`). 남은 것은 실패 표본이 없던 행들의 합이다.
  2. `fail_rows`의 행마다 `(전체 − 실패)`를 따로 계산한다. `Err`인 행은 **버린다**(그 행만). 되는 행은 1의 결과에 더한다.
  3. 「살아남은 행」 = 실패 표본이 없던 행 + 2에서 된 행. **살아남은 행이 하나도 없으면 `Broken`**, 있는데 결과 표본 수가 0이면 `Empty`, 아니면 `Hist`.
  - 그래서 `SplitHist`는 실패 표본이 없던 행의 수도 센다(`clean_rows: usize`).

- [ ] **Step 1: 실패하는 테스트** (`crates/controller/tests/sample_test.rs` — `handicap_controller::sample::*`만 쓴다. 분포 만들기: `Histogram::<u64>::new_with_bounds(1, 60_000_000, 3)`에 값을 넣고 `V2Serializer`로 직렬화하는 도우미 `blob(&[u64]) -> Vec<u8>`. 행을 자리에 넣는 도우미 `feed(sh, all_blob, failed_opt)`는 `decode_row` → `add`를 하고, 실패 BLOB이 비어 있지 않으면 `raw`를 넘긴다)

```rust
#[test] fn run_is_split_cases()                 // 전부 Some → true / 전부 None → false / 섞임 → false / 빈 목록 → false
#[test] fn passed_equals_recording_passed_values_only()
// 행1: 전체 [40_000, 41_000, 2_000], 실패 [2_000] · 행2: 전체 [39_000], 실패 Some(빈)
// resolve(Passed) 분포 == [40_000, 41_000, 39_000]만 기록한 분포(len, min, max, value_at_quantile(0.5), mean 동일)
// resolve(Failed).len() == 1, resolve(All).len() == 4, into_hist(Passed)도 같은 분포
#[test] fn no_failures_borrows()                // 실패 없는 자리의 resolve(Passed)가 Cow::Borrowed
#[test] fn all_failed_is_empty()                // 전체 [2_000], 실패 [2_000] → Passed = Empty, Failed = Hist
#[test] fn all_not_sent_is_empty_for_every_sample()
// 전체 = 표본 0인 분포의 BLOB(비어 있지 않은 바이트), 실패 Some(빈) → Passed·All·Failed 모두 Empty
#[test] fn never_fed_is_broken()                // SplitHist::default().resolve(*) == Broken
#[test] fn corrupt_all_blob_drops_row()         // decode_row(쓰레기, _) == None
#[test] fn corrupt_failed_blob_drops_row_but_not_when_unread()
// decode_row(정상, Some(쓰레기)) == None · decode_row(정상, None)은 Some (나눌 수 없는 run)
#[test] fn inconsistent_row_is_dropped_others_survive()
// 행1: 전체 [40_000], 실패 [40_000, 50_000] · 행2: 전체 [41_000, 2_000], 실패 [2_000]
// resolve(Passed) == [41_000]만 기록한 분포
#[test] fn only_inconsistent_rows_is_broken()   // 행1만 → Passed = Broken (살아남은 행 0)
#[test] fn inconsistent_row_plus_clean_not_sent_row_is_empty()
// 행1(위의 어긋난 행) + 행3: 전체 = 표본 0인 분포, 실패 Some(빈) → Passed = Empty (살아남은 행 1, 표본 0)
#[test] fn per_window_rule()                    // (all, None) → 전체 · (all, Some(빈)) → 전체 · (all, Some(실패)) → 전체−실패 · 전부 실패 → None
```

- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-controller --test sample_test` → 컴파일 에러(모듈 없음).
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, `cargo clippy -p handicap-controller --all-targets -- -D warnings`.
- [ ] **Step 5: 커밋** — `feat(controller): sample.rs — 통과·실패·모든 요청 표본 계산`.

---

### Task 5: `build_report` — 누적 자리를 `SplitHist`로, 기본 표본 = 통과한 요청, `sample` 블록 (R5·R6·R9·R11·R12·R15)

**Files:**
- Modify: `crates/controller/src/report.rs` (`build_report` :625–, 행 루프 :777–836, 창 :846–865, `ReportJson`)
- Modify: `build_report(` 호출자 전부(약 49곳 — `grep -rn "build_report(" crates/controller`): 새 인자 `None`
- Modify: `testdata/report_whole_golden.json`(재생성), 최상위 키 목록을 단언하는 테스트(`grep -n "\"validity\"" crates/controller/src/report.rs`로 찾는다 — 약 :3215–3241)
- Test: `report.rs` 테스트 모듈, `crates/controller/src/grpc/coordinator.rs`(기존 `persisted_verdict_follows_default_basis` 옆)

**Interfaces:**
- Consumes: Task 4.
- Produces:
  - `build_report(…, scope, sample: Option<Sample>) -> ReportJson`(마지막 인자).
  - `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)] pub struct SampleBlock { pub selected: Sample, pub default: Sample, pub split: bool }`, `ReportJson.sample: SampleBlock`(`#[serde(default)]`).
  - **이 task에서는 판정·인사이트·속도 구간도 `selected` 표본을 쓴다**(나누는 일은 Task 6). 요청이 없으면 `selected == default`이므로 저장 판정(R15)은 여기서 완성된다.

구현 지침:
- `split = run_is_split(rows)`, `default = if split { Passed } else { All }`, `selected = sample.filter(|s| split || *s == Sample::All).unwrap_or(default)`.
- 행 루프: 행마다 `decode_row(&r.hdr_histogram, if split { r.failed_hdr_histogram.as_deref() } else { None })`를 **한 번** 부르고, 네 누적 자리(창, `overall`, `per_step`, 워커별)의 `SplitHist`에 `add`한다. `raw`는 실패 분포가 있는 행만.
- 루프 뒤 자리마다 `resolve(selected)`(또는 소유가 필요한 곳은 `into_hist(selected)`)로 지금 쓰던 분포를 얻는다. `speed_bands::build`가 받는 `BTreeMap<String, Histogram<u64>>`는 `into_hist`로 만든다(실패 없는 스텝은 복사 없음). `Empty`·`Broken`은 지금의 「분포 없음」과 같은 값(0)이다. **순서**: 한 자리에서 `resolve`(빌림)를 쓰는 계산(스텝·요약·분포 곡선)을 전부 끝낸 뒤에 `into_hist`(소비)를 부른다 — 지금 `speed_bands::build` 호출(약 :862)은 스텝을 만드는 곳(약 :1101)보다 앞이라, 그 호출을 스텝·요약·분포 곡선 블록 **뒤로 옮긴다**(계산 결과는 같다).
- `ReportJson { … }` 리터럴(테스트 포함)에 `sample`.

- [ ] **Step 1: 실패하는 테스트**

```rust
#[test]
fn passed_sample_is_default_for_split_run() {
    // 한 스텝, 두 초. 초마다 전체 [40_000×2, 2_000×3], 실패 [2_000×3] (모든 행 failed Some)
    // build_report(.., None): sample == {passed, passed, true}
    //   summary.p50_ms == 40, steps[0].p50_ms == 40, 모든 windows의 p50_ms == 40, summary.mean_ms == 40
    // build_report(.., Some(All)): sample.selected == All, summary.p50_ms == 2
    // build_report(.., Some(Failed)): summary.p50_ms == 2
    // 세 리포트의 summary.count·errors·rps, steps[0].count·error_count가 같다
}

#[test]
fn non_split_run_is_unchanged_and_ignores_failed_column() {
    // 행 일부만 failed Some(그중 하나는 쓰레기 바이트) → sample == {all, all, false}
    // failed를 전부 None으로 바꾼 같은 입력의 리포트와 serde_json::to_value가 같다.
    // Some(Passed)·Some(Failed) 요청도 같은 리포트(selected == All).
}

#[test]
fn broken_failed_blob_keeps_other_rows() {
    // split run: 행1 failed = 쓰레기, 행2 정상(전체 [41_000]). summary.p50_ms == 41 (행1만 버려진다)
}
```

coordinator: `persisted_verdict_uses_passed_sample` — split run(통과 40ms, 실패 2ms 60%, `max_p50_ms: 10`)에서 저장된 판정이 실패(통과 표본 p50 40 > 10). 모든 요청 표본이면 2 ≤ 10이라 통과다.

- [ ] **Step 2: 실패 확인** — 컴파일 에러(인자 수).
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 골든·키 목록** — `REPORT_WHOLE_GOLDEN_UPDATE=1 cargo test -p handicap-controller whole_report_matches_golden`으로 재생성하고 `git diff testdata/report_whole_golden.json`을 읽어 **달라진 것이 `sample` 키 추가뿐**인지 확인한다(다르면 STOP — R12 위반). 키 목록 테스트에 `sample`을 더한다.
- [ ] **Step 5: 통과 확인** — `cargo build --workspace --tests` · `cargo nextest run -p handicap-controller --features in-process` · `cargo build -p handicap-controller --features bundle --tests`(`ui/dist`가 없으면 먼저 `just ui-build`).
- [ ] **Step 6: 되돌려 확인** — `default`를 늘 `All`로 바꿔 `persisted_verdict_uses_passed_sample`·`passed_sample_is_default_for_split_run` RED 확인 → 원복. `split`이 거짓일 때도 실패 칸을 넘기게 바꿔 `non_split_run_is_unchanged…` RED 확인 → 원복.
- [ ] **Step 7: 커밋** — `feat(controller): 리포트 응답 시간을 통과한 요청 기준으로 (sample 블록)`.

---

### Task 6: `build_report` — 판정은 기본 표본, 점유는 모든 요청 (R7·R8가)

**Files:**
- Modify: `crates/controller/src/report.rs` (요약·스텝·창을 만드는 곳, `evaluate_criteria`·`derive_insights`·`speed_bands::build` 호출, 구조체 `derive`)

**Interfaces:**
- Consumes: Task 5.
- 결정된 방식:
  - 판정용 요약·스텝(기본 표본)을 먼저 만든다. `selected != default`일 때만 그것을 복사해 응답 시간 칸(`summary.mean_ms/p50/p95/p99`, `steps[].p50/p95/p99`)을 `selected` 값으로 바꾼 「보여 주는」 요약·스텝을 만든다. 복사에 필요한 `#[derive(Clone)]`을 `ReportSummary`·`ReportStep`과 그 안의 구조체에 더한다(컴파일러가 알려 주는 만큼).
  - 창: 「보여 주는 창」(`selected`)과 「점유 창」(`All` — 건수는 같고 응답 시간만 모든 요청)을 만든다. `selected == All`이면 한 벌. `derive_insights`의 `windows` 인자에는 점유 창을 지금의 `scoped_windows`와 같은 방식으로 자른 것을 넘긴다. `evaluate_criteria`는 창에서 건수만 읽으므로 어느 쪽을 넘겨도 같다 — 점유 창을 넘긴다.
  - `speed_bands::build`·`LatencyDistribution`(분포 곡선): 속도 구간은 기본 표본, 분포 곡선과 워커별은 `selected`.
  - 구현 전에 확인: `grep -n "p50_ms\|p95_ms\|p99_ms" crates/controller/src/insights.rs` — 창(`windows`/`w.`)의 응답 시간을 읽는 곳이 `latency_rose` 하나가 아니면 STOP하고 보고한다.

- [ ] **Step 1: 실패하는 테스트**

```rust
#[test]
fn judging_values_ignore_requested_sample() {
    // Task 5 픽스처(통과 40ms, 실패 2ms 60%) + criteria { max_p50_ms: 10 }, run Completed.
    // None·Some(All)·Some(Failed) 세 리포트의 verdict·speed_bands·insights가 서로 같다
    // (verdict: p50 실측 40, 실패 — 모든 요청 표본이면 2라 통과했을 것).
    // 반면 summary.p50_ms는 40 / 2 / 2로 다르다.
}

#[test]
fn occupancy_signal_uses_all_sample() {
    // open-loop 포화 픽스처(기존 load_gen_saturated의 cause 테스트 픽스처를 본뜬다 — dropped > 0, 슬롯 충분):
    // 뒤쪽 3분의 1의 초에 시간 초과(실패, 30_000_000µs)가 늘고 통과한 요청의 p95는 평평, 5xx 없음.
    // load_gen_saturated 인사이트의 cause == "sut".
}
```

- [ ] **Step 2: 실패 확인** — 첫 테스트는 `Some(All)`에서 판정이 통과로 바뀌어 RED, 둘째는 cause가 `slots`라 RED.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller --features in-process`. 골든이 바뀌지 않는다(`git status testdata`).
- [ ] **Step 5: 되돌려 확인** — `derive_insights`에 보여 주는 창을 넘기게 바꿔 `occupancy_signal_uses_all_sample` RED 확인 → 원복.
- [ ] **Step 6: 커밋** — `feat(controller): 판정은 기본 표본, 포화 원인의 지연 상승은 모든 요청 표본`.

---

### Task 7: 판정 — 통과한 요청이 없으면 실패 (`no_sample`, R13·R9)

**Files:**
- Modify: `crates/controller/src/report.rs` (`CriterionResult` :380–388, `evaluate_criteria` :429–, `build_report`의 호출)
- Modify: `evaluate_criteria(` 테스트 호출(약 15곳), `CriterionResult {` 리터럴(컴파일러)

**Interfaces:**
- Produces: `CriterionResult.no_sample: bool`(`#[serde(default, skip_serializing_if = "std::ops::Not::not")]`). `evaluate_criteria`의 마지막 인자 `no_sample: &NoSample<'_>`:

```rust
pub struct NoSample<'a> { pub run: bool, pub steps: &'a BTreeSet<String> }
impl NoSample<'static> { pub fn none() -> Self; } // run: false, 빈 집합
```

- `build_report`가 만든다: 기본 표본이 `Passed`일 때만, `run = (요청 수 > 0) && overall의 resolve(Passed)가 Empty`, `steps = 요청 수 > 0이고 그 스텝의 resolve(Passed)가 Empty인 스텝 id`. `Broken`은 넣지 않는다. 나눌 수 없는 run은 `NoSample::none()`.
- 규칙: `no_sample.run`이면 run의 p50·p95·p99 기준 행은 `actual: 0.0, passed: false, no_sample: true`. 스텝 기준(`p50_ms`·`p95_ms`·`p99_ms`)은 그 스텝이 집합에 있으면 같다. 요청 0 스텝은 지금처럼 건너뛴다. 다른 항목은 그대로.

- [ ] **Step 1: 실패하는 테스트**

```rust
#[test] fn run_latency_criterion_fails_when_nothing_passed()   // NoSample{run:true} + max_p95_ms=3000 → 행 1개, passed false, no_sample true, verdict.passed false
#[test] fn step_latency_criterion_fails_when_step_has_no_passed() // steps={"a"} + 스텝 p95 기준 a·b → a는 no_sample, b는 정상
#[test] fn no_sample_flag_is_omitted_when_false()              // serde_json::to_value(행).as_object()에 "no_sample" 키 없음
#[test] fn build_report_marks_all_failed_and_all_not_sent() {
    // split run. 스텝 a: 전부 실패(전체 = 실패 = [2_000×5]) · 스텝 b: 전부 「보내지 않음」(count 5, error 5, 표본 0인 분포, 실패 Some(빈)) · 스텝 c: 정상
    // criteria: 스텝 a·b·c의 p95 기준 + run max_p95_ms.
    // a·b 행은 no_sample true·passed false, c와 run 행은 정상(run에는 c의 통과 표본이 있다).
}
#[test] fn broken_step_gets_no_no_sample() {
    // split run. 스텝 a의 모든 행이 전체 BLOB 쓰레기 → verdict의 a 행에 no_sample이 없다(지금 동작: actual 0).
}
#[test] fn non_split_all_failed_run_keeps_todays_verdict() {
    // 같은 「전부 실패」 입력에서 failed를 None으로: 행에 no_sample 없음, actual = 실패한 요청의 값(2), threshold 3000이면 passed true.
}
```

- [ ] **Step 2–4: 실패 확인 → 구현(기존 테스트 호출에는 `&NoSample::none()`) → `cargo nextest run -p handicap-controller --features in-process`.**
- [ ] **Step 5: 되돌려 확인** — `no_sample.run` 분기를 지워 첫 테스트 RED 확인 → 원복.
- [ ] **Step 6: 커밋** — `feat(controller): 통과한 요청이 없으면 응답 시간 기준은 실패 (no_sample)`.

---

### Task 8: 계단 — 실행 중·종료 뒤 모두 창 단위 표본 (R14)

**Files:**
- Modify: `crates/controller/src/stair.rs` (`build_stair_report`의 디코드 약 :960)
- Modify: `crates/controller/src/stair_monitor.rs` (`on_batch`의 디코드 약 :691, 테스트 모듈, `#[ignore]` 성능 테스트 `monitor_batch_cost_*`)

**Interfaces:**
- Consumes: `sample::window_hist_per_window`. 두 자리 모두 실패 바이트가 손에 있다(`WindowWithHdr.failed_hdr_histogram`, `pb::MetricWindow.failed_hdr_histogram`).

- [ ] **Step 1: 실패하는 테스트** — `monitor_matches_report_for_completed_steps`(약 :1486)를 본뜬 `monitor_matches_report_with_failed_samples`: 계단 창마다 전체 = 통과(1ms대) + 실패(30초), 실패 칸 `Some`. 단언: (가) 감시가 낸 계단 숫자 = `build_stair_report`의 숫자, (나) 계단 p99가 1초 미만(30초가 아니다). `only_failed_second_has_zero_p99`: 실패만 있는 초의 `LastSecond.p99_us == 0`. `old_worker_window_uses_all`: 실패 칸 `None`인 창의 p99는 30초 근처(지금 값).
- [ ] **Step 2: 실패 확인** — (나)가 30초 근처라 RED.
- [ ] **Step 3: 구현** — 두 디코드 자리를 `window_hist_per_window`로 바꾼다. `build_stair_report`는 표본 인자를 받지 않는다. `#[ignore]` 성능 테스트 옆에 실패가 섞인 입력 변형 `monitor_batch_cost_with_failures`를 더한다(입력은 재는 구간 밖에서 만든다 — `crates/controller/CLAUDE.md`의 마이크로벤치 함정).
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller --features in-process stair`.
- [ ] **Step 5: 커밋** — `feat(controller): 계단 판정은 통과한 요청의 p99로 (실행 중·종료 뒤 같은 규칙)`.

---

### Task 9: REST `?sample=` (R10)

**Files:**
- Modify: `crates/controller/src/api/runs.rs` (`ReportParams`, `parse_basis` 옆 `parse_sample`, `report` 핸들러, `build_report_for_run`·`build_reports_for_run`에 `sample: Option<Sample>` — 안의 `build` 클로저가 `build_report`에 넘긴다)
- Modify: 두 함수의 호출자 전부(`grep -rn "build_report_for_run(\|build_reports_for_run(" crates/controller`) — `None`
- Test: `crates/controller/tests/report_test.rs`

**Interfaces:**
- Produces: `build_report_for_run(db, run_id, basis, sample)`, `build_reports_for_run(db, run_id, basis, sample)`. 두 기준 리포트 모두 같은 `sample`을 받는다.

- [ ] **Step 1: 실패하는 테스트** (`report_test.rs` — split run과 옛 run을 DB에 넣는다)

```rust
// GET /report                → sample.selected == "passed"
// GET /report?sample=all     → "all", summary.p50_ms가 다르다
// GET /report?sample=failed  → "failed"
// GET /report?sample=bogus   → 400, 본문에 "sample"
// 옛 run GET /report?sample=passed → 200, sample == {selected:"all", default:"all", split:false}
// GET /report?sample=all&basis=whole → 200
```

- [ ] **Step 2–4: 실패 확인 → 구현(`parse_sample`: `passed|failed|all`, 그 밖 `BadRequest("sample은 passed, failed, all 중 하나여야 합니다")`) → 통과 확인.**
- [ ] **Step 5: 커밋** — `feat(controller): 리포트 ?sample=passed|failed|all`.

---

### Task 10: 내보내기 — 표본 적기 + 값 없음은 빈 칸 (R21 XLSX·R28)

**Files:**
- Modify: `crates/controller/src/export.rs` (`write_summary_numbers` :292, `write_steps_table` :266, `summary_metric` :71, `report_to_csv`, `comparison_to_csv`, `comparison_to_xlsx`, Runs 시트, Windows 시트 약 :895–927)
- Modify: `testdata/compare_golden.json`, Rust 테스트 `golden_summary_deltas_match`
- Test: `export.rs` 테스트 모듈, `crates/controller/tests/export_routes_test.rs`

**Interfaces:**
- 값 없음 판정(한 함수): `fn latency_missing(sample: &SampleBlock, count: u64, errors: u64) -> bool { sample.default == Sample::Passed && count > 0 && count == errors }`. run은 `summary`, 스텝은 그 스텝, 초별 창은 그 창의 값. 통과 = `count − errors`이고 「보내지 않음」도 오류에 들어 있으므로 `count == errors`가 「통과한 요청 없음」이다. 옛 run은 `default == All`이라 늘 거짓.
- 「Other basis」 시트도 `write_steps_table`을 쓴다 — **그 리포트 자신의 `sample` 블록**으로 판정한다.
- 골든 형식(이 task가 정하고 Task 16이 읽는다): `testdata/compare_golden.json` 최상위에 **새 키** `missing_cases: [{ name, reports, baseline_id, expected }]`를 더한다. 기존 최상위 키(`reports`·`baseline_id`·`expected`)는 건드리지 않는다. `expected.summary[*].values[i]`와 `deltas[i]`가 `null`이면 「값 없음」. 경우 둘: `baseline_missing`, `candidate_missing`. 리포트에는 `sample: {selected: "passed", default: "passed", split: true}`와 `errors == count`인 run을 넣는다.

- [ ] **Step 1: 실패하는 테스트**

```rust
#[test] fn xlsx_summary_has_latency_sample_last_row()            // calamine: Summary 마지막 행 = ["latency_sample", "passed"], 옛 run은 "all"
#[test] fn compare_xlsx_runs_has_latency_sample_last_column()    // 기준 열이 있는 묶음·없는 묶음 두 경우의 열 번호
#[test] fn missing_latency_is_blank_not_zero()
// split run에서 전부 실패한 스텝: 단일 XLSX Steps의 p50·p95·p99 칸이 None|Data::Empty,
// 단일 CSV 그 칸이 빈 문자열. 전부 실패한 run의 Summary p50·p95·p99 칸이 빈 칸(라벨은 있다).
// Windows 시트: 통과한 요청이 없는 초의 응답 시간 칸이 빈 칸.
// 「Other basis」 시트도 같다.
#[test] fn compare_skips_value_and_delta_when_either_side_missing()
// 비교 CSV·XLSX(Summary·Steps): 기준 run에 값 없음 / 비교 run에 값 없음 → 값 칸·Δ 칸 빈 칸.
// 비교 run 셋 중 가운데가 값 없음일 때 셋째 run의 Δ가 제 열에 있다(Δ 열 카운터는 건너뛴 칸에서도 올라간다).
```

`golden_summary_deltas_match` 옆에 `golden_missing_cases_match`: `missing_cases`의 각 경우를 Rust 비교 계산에 넣어 `expected`와 같은지 본다. 지금은 비교 값이 CSV/XLSX 쓰는 코드 안에서만 계산되므로 공유 도우미 `fn summary_value(r: &ReportJson, metric: &str) -> Option<f64>`(값 없음이면 `None`, 그 밖은 `summary_metric`의 값)를 만들어 CSV·XLSX·이 테스트가 함께 쓴다. `missing_cases` 안의 리포트는 온전한 `ReportJson`이어야 한다(Rust가 엄격히 읽는다). 기존 `golden_summary_deltas_match`는 건드리지 않는다(새 키를 무시하는지 — 골든을 읽는 구조체에 `deny_unknown_fields`가 있으면 그 구조체에 `missing_cases` 칸을 더한다).

- [ ] **Step 2–4: 실패 확인 → 구현 → `cargo nextest run -p handicap-controller --features in-process export`.** 기존 행 번호 단언 테스트가 무수정으로 통과하는지 본다.
- [ ] **Step 5: UI 게이트 확인** — `cd ui && pnpm test -- compareReports`가 지금 상태(UI 무수정)에서 통과한다(새 최상위 키를 기존 TS 테스트가 읽지 않는다). 깨지면 STOP.
- [ ] **Step 6: 커밋** — `feat(controller): 내보내기 — 응답 시간 표본 적기, 통과한 요청 없는 칸은 빈 칸`.

---

### Task 11: `/perf-ab` — 오류가 있는 라운드를 버리지 않는 선택지 (R25 도구)

**Files:**
- Modify: `.claude/skills/perf-ab/perf_ab.py` (인자 약 :198–207, 문제 판정 약 :188–191), `.claude/skills/perf-ab/SKILL.md`

- [ ] **Step 1:** `--allow-errors`(store_true)를 더한다. 켜면 `errors`와 non-200 상태를 문제로 치지 않는다(실패한 run·요청 0건은 여전히 문제). 출력 머리에 `allow-errors: on`을 찍는다.
- [ ] **Step 2: 확인** — `python3 .claude/skills/perf-ab/perf_ab.py --help`에 선택지가 보인다. `python3 -m py_compile .claude/skills/perf-ab/perf_ab.py`.
- [ ] **Step 3:** `SKILL.md`에 한 줄: 실패 경로의 비용을 잴 때 `--allow-errors --scenario <상태 코드 검사가 맞지 않는 시나리오>`(응답기는 200만 내므로 `assert: status 201`).
- [ ] **Step 4: 커밋** — `chore(perf-ab): --allow-errors`.

---

### Task 12: UI 와이어 — 스키마·표본 인자·캐시 열쇠·슬롯 사이징 (R8나·R10·R11·R13 UI쪽)

**Files:**
- Modify: `ui/src/api/schemas.ts` (`CriterionResultSchema`, `ReportSchema`), `ui/src/api/client.ts` (`getRunReport` 약 :279), `ui/src/api/hooks.ts` (`queryKeys.runReport` :49, `useRunReport` 약 :254–268)
- Modify: `ui/src/components/run/SlotSizingHelper.tsx` (:32)
- Test: `ui/src/api/__tests__/`, `ui/src/components/run/__tests__/SlotSizingHelper.test.tsx`

**Interfaces:**
- Produces(`schemas.ts`): `export type ReportSampleName = "passed" | "failed" | "all"`, `ReportSampleSchema = z.object({ selected, default, split: z.boolean() }).strict()`, `ReportSchema.sample: ReportSampleSchema.optional()`, `export function reportSample(report: Report): { selected: ReportSampleName; default: ReportSampleName; split: boolean }`(없으면 `all/all/false`), `CriterionResultSchema.no_sample: z.boolean().optional()`.
- `api.getRunReport(id, basis?, sample?)`, `queryKeys.runReport(id, basis?, sample?)`, `useRunReport(id, terminal, basis?, sample?)`. URL은 `?basis=…&sample=…`(있는 것만, 이 순서).
- `SlotSizingHelper`: `useRunReport(latest?.id, Boolean(latest), undefined, "all")`.

- [ ] **Step 1: 실패하는 테스트** — (가) 스키마: `sample` 있는 리포트·없는 리포트 둘 다 통과, `no_sample: true` 행 통과, `reportSample` 기본값. (나) 클라이언트: `getRunReport("r", "whole", "all")`의 URL 끝이 `/report?basis=whole&sample=all`, `getRunReport("r", undefined, "all")`은 `/report?sample=all`. (다) 열쇠: `queryKeys.runReport("r")`와 `queryKeys.runReport("r", undefined, "all")`가 다르다. (라) `SlotSizingHelper`: 같은 run의 기본 리포트를 `queryKeys.runReport(id)`로 미리 넣어 둔 `QueryClient`에서 도우미를 그리면 URL에 `sample=all`이 든 요청이 **나간다**.
- [ ] **Step 2–4: 실패 확인 → 구현 → `pnpm lint && pnpm test && pnpm build`.**
- [ ] **Step 5: 커밋** — `feat(ui): 리포트 표본 와이어 + 슬롯 사이징은 모든 요청 표본`.

---

### Task 13: UI 화면 — 0 대신 「—」, 끊기는 그래프 (R17 화면·R18)

**Files:**
- Create: `ui/src/report/hasLatency.ts` + `ui/src/report/__tests__/hasLatency.test.ts`
- Modify: `ui/src/components/report/Summary.tsx`, `StepStatsTable.tsx`, `ReportHeadline.tsx`, `WorkerBreakdownTable.tsx`, `basisText.ts`(+ 호출자 `BasisBar.tsx`·`ui/src/print/buildPrintDoc.ts`), `ReportView.tsx`(새 props 넘기기), `stair/StairTable.tsx`, `stair/stairBandSeries.ts`, `ui/src/report/bySecond.ts`, `ui/src/components/report/TimeSeriesChart.tsx`, `ui/src/compare/overlaySeries.ts`, `ui/src/i18n/ko.ts`, `ui/src/i18n/__tests__/ko.test.ts`(머리말 함수를 직접 부르는 테스트 약 :237–243 — 인자 `p95`를 `latency`로)

**Interfaces:**
- Consumes: `reportSample`·`ReportSampleName`(Task 12).
- Produces:

```ts
export type LatencyCounts = { count: number; errors: number; notSent: number };
/** passed → count − errors > 0 · failed → errors − notSent > 0 · all → count − notSent > 0 */
export function hasLatency(c: LatencyCounts, sample: ReportSampleName): boolean;
export function windowNotSent(w: { count: number; status_counts: Record<string, number> }): number; // count − Σstatus_counts
export function stepCounts(s: ReportStep): LatencyCounts;                // notSent = s.not_sent ?? 0
export function summaryCounts(r: Report): LatencyCounts;                 // notSent = Σ steps[].not_sent
```

- 자리별 규칙(R17 표 — 이 task의 몫):

| 자리 | 지금 | 바꾼 뒤 |
|---|---|---|
| `StepStatsTable` p50·p95·p99 | `count − not_sent > 0`이면 값 | `hasLatency(stepCounts(s), selected)` |
| `Summary` p50·p95·p99 카드 | 늘 값 | `selected`가 `passed`·`failed`이고 `hasLatency`가 거짓이면 「—」. `all`은 지금 그대로 |
| `ReportHeadline`의 응답 시간 | 늘 값 | 요약 카드와 같은 규칙 |
| `WorkerBreakdownTable` | 늘 값 | `passed`: `count − errors > 0` · `failed`: `errors > 0` · `all`: 지금 그대로(워커별 「보내지 않음」 수는 와이어에 없다) |
| `basisText`의 다른 기준 p95 | 늘 값 | `reportSample(r).selected === "passed"`이고 `other.count > 0 && other.error_rate >= 1`이면 「—」 |
| `StairTable`·`stairBandSeries` | `measured`/`count > 0` | `p99_us > 0`일 때만 값·점(`StairCurveChart`의 식과 같게) |
| `bySecond` → 시간대별 응답 시간 그래프 | 0 | 그 초의 모든 스텝 창에서 `hasLatency`가 거짓이면 `p95_ms: null` |

- props·함수 모양(지금은 `summary`만 받는 부품들):
  - `Summary`·`ReportHeadline`에 `latency: { sample: ReportSampleName; counts: LatencyCounts }`(선택 prop, 없으면 지금 동작)를 더하고 `ReportView`가 `reportSample(report).selected`와 `summaryCounts(report)`로 넘긴다.
  - `basisOtherLine(basis, sample: ReportSampleName)` — 호출자 `BasisBar.tsx`·`print/buildPrintDoc.ts`가 넘긴다. `BasisBar`는 지금 `basis`만 받으므로 선택 prop `sample?: ReportSampleName`(기본 `"all"` — 기존 `BasisBar` 테스트 무수정)을 더하고 `ReportView`가 `reportSample(report).selected`를 넘긴다. `buildPrintDoc`은 리포트가 손에 있어 직접 `reportSample(report).selected`를 쓴다.
- 문구(`ko.ts`, byte-exact):
  - `ko.report.headlineLatency: (p95: string | null) => string` — 값이 있으면 「95%가 ${p95} 안에 응답」, `null`이면 「통과한 요청 없음」. 머리말 네 함수(`headlineClosed`·`headlineOpenFixed`·`headlineOpenCurve`·`headlineClosedCurve`)의 「95%가 ${p.p95} 안에 응답」 자리를 `${p.latency}`로 바꾸고 호출부가 `headlineLatency(...)` 결과를 넘긴다(값이 있을 때 문장은 지금과 글자가 같다).
  - `ko.report.basis.otherLine`의 `p95` 인자를 `number | null`로: `null`이면 「p95 —」(단위 없이), 아니면 지금처럼 「p95 ${p95} ms」.
- `Sec.p95_ms: number | null`. `TimeSeriesChart`의 `Point.value: number | null`, 값 없는 곳에서 선이 끊긴다(`connectNulls`를 켜지 않는다). `overlaySeries`도 `null`을 그대로 넘긴다.

- [ ] **Step 1: 실패하는 테스트** — `hasLatency` 표 테스트(세 표본 × {정상, 전부 실패, 전부 보내지 않음, 요청 0}), `windowNotSent`, `bySecond`(전부 실패한 초 → `null`, 섞인 초 → 값), `overlaySeries`(`null` 유지), 각 부품 RTL(전부 실패한 스텝·run 픽스처에서 「—」가 있고 `0 ms` 글자가 없다), 머리말(전부 실패 → 문장에 「통과한 요청 없음」이 있고 「95%가」가 없다 · 정상 run의 문장은 지금 기대 문자열과 같다), `otherLine`(`null` → 「p95 —」), `WorkerBreakdownTable`(통과 0인 워커), `basisText`(다른 기준 전부 실패), `StairTable`(p99_us 0인 계단).
- [ ] **Step 2–4: 실패 확인 → 구현 → `pnpm lint && pnpm test && pnpm build`.**
- [ ] **Step 5: 커밋** — `feat(ui): 통과한 요청이 없는 자리에 0ms 대신 「—」, 그래프는 끊는다`.

---

### Task 14: UI 화면 — 표본 줄·표지·판정 표·문구 (R16·R19 화면·R20·R23·R24·R27)

**Files:**
- Create: `ui/src/components/report/SampleBar.tsx`, `MixedSampleBadge.tsx` + 테스트
- Modify: `ui/src/components/report/ReportView.tsx`(`BasisBar` 아래에 `SampleBar`), `verdictFormat.ts`·`VerdictPanel.tsx`·`ui/src/components/VerdictBadge.tsx`, `SetupSection.tsx`·`GroupLatencyTable.tsx`·`StepStatsTable.tsx`(대기/다운로드 열 머리)·`StepPhaseBreakdown.tsx`(구간 표)·조건 반복 분리 행(`grep -rn "loop_split" ui/src/components`), `ui/src/components/run/StairLivePanel.tsx`, `ui/src/i18n/ko.ts`

**Interfaces:**
- Consumes: `reportSample`(Task 12).
- `SampleBar({ report })`: `report.windows.length === 0`이면 `null`. `split`이면 「통과한 요청」 표지 + HelpTip + 설명, 아니면 「모든 요청 (실패한 요청 포함)」 표지 + 설명. 전환 단추는 없다. 모양 = 목업 1-가·3.
- `MixedSampleBadge`: `WholeRunBadge`와 같은 모양. `reportSample(report).split`이 참일 때만 그린다.
- 문구(`ko.report.sample.*`, byte-exact):

| 키 | 글자 |
|---|---|
| `barLabel` | 응답 시간 표본 |
| `passed` | 통과한 요청 |
| `all` | 모든 요청 (실패한 요청 포함) |
| `passedHint` | 응답 시간은 통과한 요청만으로 계산했습니다. 실패한 요청은 오류 수에 들어 있습니다. |
| `allHint` | 이 run은 통과한 요청과 실패한 요청의 응답 시간을 따로 기록하지 않았습니다. 응답 시간에 실패한 요청이 들어 있습니다. |
| `passedHelp` | 오류로 세지 않은 요청입니다. 상태 코드 검사가 없는 스텝에서는 4xx·5xx 응답도 통과로 셉니다. |
| `mixedBadge` | 실패 포함 |
| `mixedTitle` | 이 구획의 응답 시간은 실패한 요청도 포함합니다. |
| `noSample` | 통과한 요청 없음 |
| `stairP99Help` | 통과한 요청의 p99입니다. |

- 풀이 고치기(R24 — 줄 번호는 저작 시점, `grep -n "전체 요청" ui/src/i18n/ko.ts`로 다시 찾는다):

| 줄(저작 시점) | 지금 | 바꿈 |
|---|---|---|
| :58–60 `glossary.p50/p95/p99` | 「전체 요청의 N%가 이 시간 안에 응답했다는 뜻입니다」 | 「요청의 N%가 이 시간 안에 응답했다는 뜻입니다」(뒤 문장 그대로) |
| :3249 인쇄 풀이 p95 | 「전체 요청의 95%가 이 시간 안에 응답한 기준선」 | 「요청의 95%가 이 시간 안에 응답한 기준선」 |
| :2819 | 「이전·이후 전체 요청의 응답 속도 구간 비교」 | 「이전·이후 모든 단계의 응답 속도 구간 비교」 |
| :2981 | 「응답 속도 구간 비교 (전체 요청)」 | 「응답 속도 구간 비교 (모든 단계)」 |
| :3357 `totalRow` | 「전체 요청」 | 「모든 단계」 |
| :3381 | 「… 이번 측정은 전체 요청의 」 | 「… 이번 측정은 모든 단계를 합친 요청의 」 |
| :3414 | 「… 기준이 없는 단계와 전체 요청은 …」 | 「… 기준이 없는 단계와 모든 단계 합계는 …」 |
| :2655·:2664·:3158 (오류율·요청 수) | — | 그대로 둔다(표본과 무관한 값) |

  이 문구를 단언하는 기존 테스트를 함께 고친다(`grep -rn "전체 요청" ui/src --include='*.test.*'`).

- [ ] **Step 1: 실패하는 테스트** — `SampleBar`(split / 옛 run / 창 없음 → 안 그림), 구획별 표지 유무(split 참·거짓), `verdictFormat`(`no_sample` 행의 실측 글자 = 「통과한 요청 없음」 — 패널과 배지 툴팁 둘 다), `StairLivePanel` 풀이.
- [ ] **Step 2–4: 실패 확인 → 구현 → `pnpm lint && pnpm test && pnpm build`.**
- [ ] **Step 5: 목업 대조** — `cargo build -p handicap-worker` 후 워크트리 바이너리로 컨트롤러를 띄워(`/live-verify` 준비 절차, `just ui-build` 먼저) 실패가 섞인 run 하나를 돌린다. 그 run과, 그 run의 사본을 옛 run처럼 만든 것(`UPDATE run_metrics SET failed_hdr_histogram = NULL WHERE run_id = ?`)의 리포트를 열어 목업 1-가·3·4·5·6과 스크린샷을 나란히 본다. 머리 표지가 「통과한 요청」으로 나오는지 먼저 확인한다(「모든 요청」이면 워커 바이너리가 옛것이다). 다른 곳을 고친다.
- [ ] **Step 6: 커밋** — `feat(ui): 응답 시간 표본 줄·「실패 포함」 표지·통과한 요청 없음 표시`.

---

### Task 15: UI 인쇄 — 0 대신 값 없음, 표본 한 줄 (R17 인쇄·R19 인쇄·R21 인쇄)

**Files:**
- Modify: `ui/src/print/stepTable.ts`(`requestsSent`와 그 주석)·`ui/src/print/components/StepCodeTable.tsx`, `ui/src/print/sentences.ts`, `ui/src/print/speedBands.ts`, `ui/src/i18n/ko.ts`, `ui/src/print/verdict.ts`(`kpiCards`·판정 행), `ui/src/print/stairTable.ts`, `ui/src/print/buildPrintDoc.ts`·`ui/src/print/components/ReportHeader.tsx`
- Test: `ui/src/print/__tests__/`

**Interfaces:**
- Consumes: `hasLatency`·`stepCounts`·`summaryCounts`(Task 13), `reportSample`(Task 12), `ko.report.sample.noSample`(Task 14).
- 인쇄 단계 표·자동 요약 문장: 값 없음이면 그 표면의 「없음」 표현(단계 표는 「–」 — 지금 보내지 않은 단계에 쓰는 글자, 문장은 그 응답 시간 문장을 내지 않는다).
- KPI 카드: 평균·p95 카드의 값이 값 없음이면 「–」, 「측정」 글자는 `no_sample` 행이면 「통과한 요청 없음」.
- 계단 인쇄 표: `p99_us > 0`일 때만 값.
- 속도 구간 주석(`ui/src/print/speedBands.ts` 약 :412, `ko.ts`의 `noteBars`·`noteNamed`): 나눌 수 있는 run(`reportSample(report).default === "passed"`)에서는 `noteBars` 자리에 새 문구 `noteBarsPassed` = 「※ 막대에는 통과한 요청만 들어 있습니다.」를 쓰고 `noteNamed`와 `noteNamedMore`(「외 N단계도 …」)를 내는 `if (named.length > 0)` 블록(약 :412–418)을 **통째로 건너뛴다**. `buildSpeedModel`의 인자 객체에 `split: boolean`을 더해 호출자가 넘긴다. 옛 run은 지금 문구 그대로.
- 머리 한 줄(`meta.sampleNote`): 「응답 시간 표본: 통과한 요청」 / 「응답 시간 표본: 모든 요청 (실패한 요청 포함)」. 리포트에 창이 없으면 줄을 내지 않는다.

- [ ] **Step 1: 실패하는 테스트** — 전부 실패한 run·스텝 픽스처에서: 단계 표에 `0ms`가 없다, 문장 목록에 응답 시간 문장이 없다, KPI 카드 글자, 판정 행 「통과한 요청 없음」, 머리 줄 두 경우, 계단 표, 속도 구간 주석(나눌 수 있는 run: 새 문구가 있고 `noteNamed`·`noteNamedMore` 글자가 둘 다 없다 — 실패 비율 10% 이상인 단계가 여럿인 픽스처로 · 옛 run: 지금 문구 그대로).
- [ ] **Step 2–4: 실패 확인 → 구현 → `pnpm lint && pnpm test && pnpm build`.**
- [ ] **Step 5: 커밋** — `feat(ui): 인쇄 — 통과한 요청 없는 칸, 응답 시간 표본 한 줄`.

---

### Task 16: UI 비교 — 값 없음·표본 안내 (R17 비교·R22·R28 TS쪽)

**Files:**
- Modify: `ui/src/compare/compareReports.ts`, `ui/src/print/compare/change.ts`, `ui/src/print/compare/dumbbell.ts`, `ui/src/print/compare/fairness.ts`(비교 인쇄의 안내)
- Create: `ui/src/compare/sampleNotice.ts`(`basisNotice.ts`를 본뜬다) + 사용처 `ui/src/pages/ScenarioComparePage.tsx`(`basisNotice`를 쓰는 :189 옆)
- Test: `ui/src/compare/__tests__/compareReports.test.ts`(골든), 각 `__tests__`

**Interfaces:**
- Consumes: `hasLatency`·`summaryCounts`·`stepCounts`(Task 13), `reportSample`(Task 12), Task 10의 골든 `missing_cases`.
- `compareReports`: run 요약 p50·p95·p99와 스텝 p95에서 한쪽이 값 없음(`reportSample(r).default === "passed"`이고 `count > 0 && count === errors` — 서버 `latency_missing`과 같은 식)이면 그 칸 `null`, Δ `null`.
- `sampleNotice(reports: Report[]): string | null` — `reportSample(r).default`가 섞였으면 `ko.compare.sampleNotice` = 「고른 run 중 일부는 실패한 요청을 포함해 응답 시간을 계산했습니다. 응답 시간을 그대로 비교하기 어렵습니다.」

- [ ] **Step 1: 실패하는 테스트** — `compareReports.test.ts`에 `missing_cases`를 도는 테스트(서버 기대값과 같은 `values`·`deltas`), `change.ts`·`dumbbell.ts`(값 없음 → 변화·점을 내지 않는다), `sampleNotice`(섞임 → 문구, 같음 → `null`), 비교 화면·비교 인쇄에 안내가 보인다.
- [ ] **Step 2–4: 실패 확인 → 구현 → `pnpm lint && pnpm test && pnpm build`.**
- [ ] **Step 5: 커밋** — `feat(ui): 비교 — 통과한 요청 없는 칸은 값·차이 없음, 표본이 섞이면 안내`.

---

### Task 17: 문서 — ADR-0063·함정 노트·roadmap

**Files:**
- Create: `docs/adr/0063-passed-latency-sample.md`(MADR — 맥락·결정·대안 「통과 분포만 보내기」「지금처럼 섞기」·결과)
- Modify: 루트 `CLAUDE.md` 「알아둘 결정들」에 한 줄, `crates/controller/CLAUDE.md`(리포트 빌드 절: 표본 셋·판정은 기본 표본·점유는 모든 요청·`Broken`≠`Empty`·나눌 수 없는 run은 실패 칸을 읽지 않는다·계단은 창 단위), `crates/engine/CLAUDE.md`(실패 분포는 첫 실패 때 생성)
- Modify: `docs/roadmap.md` — 새 §B 블록(번호는 `grep -n '^### B' docs/roadmap.md`의 마지막 + 1)에 spec §10의 연기 표를 비용·해소법과 함께 옮긴다.

- [ ] **Step 1:** 쓴다. `just doc-budget` 확인.
- [ ] **Step 2: 커밋** — `docs: ADR-0063 응답 시간 표본 + roadmap 연기 기록`.

---

### Task 18: 측정·라이브 검증 (orchestrator가 직접 — subagent에 맡기지 않는다)

- [ ] **Step 0: 준비** — `cargo build -p handicap-worker && cargo build -p handicap-controller --bin controller && just ui-build`. 라이브용 응답기를 스크래치에 만든다(keep-alive, 인자로 「즉시 500 비율」·「정상 지연 ms」·「붙잡기 비율과 시간」을 받는다 — `.claude/skills/live-verify/responder.py`는 200만 낸다).
- [ ] **Step 1: 워커 CPU(R25)** — `/perf-ab master`(기본 시나리오) → 「ranges OVERLAP」이어야 한다. 이어서 `--allow-errors --scenario <assert: status 201 시나리오>`로 실패 경로 수치를 잰다. 둘 다 build-log에.
- [ ] **Step 2: 리포트 빌드 시간(R26)** — 실패가 내내 있는 긴 run(600초 × 스텝 5, 매 초 실패)을 만들어 `GET /report` 응답 시간을 master 바이너리와 비교한다(같은 DB 사본 — master 바이너리는 새 칸을 무시한다). 수치를 build-log에.
- [ ] **Step 3: 계단 감시 비용** — `cargo test -p handicap-controller --features in-process monitor_batch_cost -- --ignored --nocapture`의 두 수치.
- [ ] **Step 4: 라이브 US 표** — spec §9의 표(US1·US3·US4·US5·R8). 머리 표지가 「통과한 요청」인지 먼저 본다. 극단값(스텝 수십 개·긴 이름·좁은 폭)과 진입 화면(run 상세·인쇄 미리보기·비교·비교 인쇄·실행 창 슬롯 사이징·실행 중 계단 패널) 전부.
- [ ] **Step 5:** 최종 리뷰(`handicap-reviewer` — 와이어 1:1: proto ↔ DB ↔ `ReportJson` ↔ Zod, 화면 비교 ↔ 내보내기 ↔ 골든) + `finish-slice` §0 보안 grep.

---

## 요구사항 ↔ task

| R | Task | R | Task |
|---|---|---|---|
| R1 | 1 | R15 | 5 |
| R2 | 2 | R16 | 14 |
| R3 | 3 | R17 | 13(화면)·15(인쇄)·16(비교) |
| R4 | 4 | R18 | 13 |
| R5·R6 | 4·5 | R19 | 14(화면)·15(인쇄) |
| R7 | 6 | R20 | 14 |
| R8 | 6(가)·12(나) | R21 | 10(XLSX)·15(인쇄) |
| R9 | 4·5·7 | R22 | 16 |
| R10 | 5(표본 고르기)·9(라우트) | R23·R24·R27 | 14 |
| R11·R12 | 5 | R25 | 11·18 |
| R13 | 7·12(스키마) | R26 | 18 |
| R14 | 8 | R28 | 10·16 |

## 사실 확인 명령 (디스패치 전 orchestrator가 다시 돌린다)

```bash
grep -n "pub struct StepWindow" -A 8 crates/engine/src/aggregator.rs
grep -rn "StepWindow {" crates/
grep -rn "MetricWindow {" crates/
grep -n "message MetricWindow" -A 8 crates/proto/proto/coordinator.proto
grep -n "async fn ensure_\|MIGRATION_SQL_00" crates/controller/src/store/mod.rs
grep -rn "MetricRow {" crates/controller | wc -l
grep -rn "WindowWithHdr {" crates/controller | wc -l
grep -rn "build_report(" crates/controller | wc -l
grep -rn "evaluate_criteria(" crates/controller | wc -l
grep -rn "build_report_for_run(\|build_reports_for_run(" crates/controller
grep -n "p50_ms\|p95_ms\|p99_ms" crates/controller/src/insights.rs
grep -n "GOLDEN_UPDATE" crates/controller/src/report.rs
grep -n "cfg(test)" crates/controller/src/lib.rs crates/controller/src/speed_bands.rs
grep -n "fn write_summary_numbers\|fn write_steps_table\|fn summary_metric\|fn comparison_to_csv\|fn comparison_to_xlsx\|fn golden_summary_deltas_match" crates/controller/src/export.rs
grep -n "runReport\|getRunReport" ui/src/api/hooks.ts ui/src/api/client.ts
grep -rn "compare_golden" ui/src
grep -n "전체 요청" ui/src/i18n/ko.ts
grep -rn "basisNotice" ui/src --include='*.ts' --include='*.tsx' -l
```
