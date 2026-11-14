# 조건 반복 3차 — 응답 시간 분리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 조건 반복 본문 스텝의 응답 시간을 "반복을 끝낸 응답 / 재시도로 이어진 응답" 두 줄로 리포트 스텝 표에 보여 준다.

**Architecture:** 엔진이 조건 반복 본문의 응답을 회차 버퍼에 쥐었다가 회차가 끝날 때 세 갈래(끝냄·이어짐·끊김)로 기존 `phase_stats` 길에 기록한다. 컨트롤러 `build_report`가 그 구간 행을 스텝별 `loop_split`으로 합치고, 화면이 스텝 행 아래 두 줄을 그린다. proto·migration·워커·저장 계층은 건드리지 않는다.

**Tech Stack:** Rust(엔진 `runner.rs`·`aggregator.rs`, 컨트롤러 `report.rs`), TypeScript/React(Zod 스키마, `StepStatsTable`, `StepPhaseBreakdown`), wiremock·nextest·vitest/RTL.

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-14-loop-while-latency-split-design.md` — 구현자는 spec을 함께 읽는다. US 블록은 spec 앞머리 `사용자 스토리 (US)`.

## Global Constraints

- **R0**: 조건 반복(`while` 있는 loop)이 없는 시나리오의 run은 `MetricBatch` 바이트·DB 행·리포트 JSON·화면 DOM이 지금과 같다.
- **US3**: `loop_retry`(이어짐) 건수가 0인 스텝에는 `loop_split` 키가 없다. 끊긴 회차(`loop_cut`)만으로는 두 줄이 뜨지 않는다.
- proto(`crates/proto`)·migration·`crates/worker`·`crates/controller/src/store`·`crates/controller/src/grpc`·`crates/engine/src/trace.rs`·`export.rs`의 운영 코드는 수정하지 않는다.
- 구간 이름 문자열은 엔진 `aggregator.rs`의 `pub const` 한 곳에만 적는다. 컨트롤러는 그 상수를 가져다 쓴다.
- 화면 문구는 전부 `ui/src/i18n/ko.ts` `report.loopExit` 아래(문구는 spec §4.3 그대로).
- 2차 화면 요소(「재시도 포함」 표지 규칙·풀이 줄·분포 패널·맨 위 안내)는 바꾸지 않는다.
- 커밋: 구현자는 커밋과 검증을 한 번의 foreground 호출로. `| tail`·`| head` 파이프 금지, `--no-verify` 금지, 커밋 메시지는 파일로(`git commit -F`). 워크트리 루트에 `.md` 리포트를 쓰지 않는다.
- 이 워크트리에서 `git`은 단독 명령으로만 부른다(`cd … && git …`·`;`·`|` 복합은 거부된다).

## Review Focus

테스트가 없으면 놓치기 쉬운 것. 각 줄의 테스트는 괄호 안 task가 갖는다.

1. 재시도가 없는 run이 run 종료 시각에 본문 think time 도중 끊긴다 → 두 줄이 없어야 한다(Task 2 테스트 6, Task 3 테스트 2).
2. 조건 반복 본문의 if 안 스텝 → 그 스텝도 나뉘어야 한다. if 가지가 `None`을 넘겨도 컴파일된다(Task 2 테스트 9).
3. 워커가 보낸 이상한 값(에러 수 > 건수, 음수 건수, 깨진 BLOB) → 리포트가 만들어지고 값이 잘린다(Task 3 테스트 5).
4. `loop_split`은 있는데 「재시도 포함」 표지는 없는 스텝(1번째 회차에서만 도는 if 안 스텝) → 두 줄이 표지와 무관하게 보인다(Task 4 테스트 8).
5. 끝내 풀리지 않은 조건 반복 → 끝낸 응답 0건, 백분위 `—`(Task 4 테스트 2, Task 5 테스트 2).

---

### Task 1: 엔진 집계기 — 갈래 enum·구간 이름·`record_loop_split`

**Files:**
- Create: `crates/engine/tests/loop_split.rs` (재수출 계약 테스트 하나 — Task 2가 이 파일에 이어 쓴다)
- Modify: `crates/engine/src/aggregator.rs`
- Modify: `crates/engine/src/lib.rs` (재수출)

**Interfaces:**
- Produces (모두 `handicap_engine::`으로 재수출):

```rust
pub const LOOP_SPLIT_PASS_SAMPLE_CAP: usize = 1024;
pub const PHASE_LOOP_FINAL: &str = "loop_final";
pub const PHASE_LOOP_RETRY: &str = "loop_retry";
pub const PHASE_LOOP_CUT: &str = "loop_cut";
pub const PHASE_LOOP_FINAL_ERR: &str = "loop_final_err";
pub const PHASE_LOOP_RETRY_ERR: &str = "loop_retry_err";
pub const PHASE_LOOP_CUT_ERR: &str = "loop_cut_err";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopSplitClass { Ended, Continued, Cut }
impl LoopSplitClass {
    pub fn phase(self) -> &'static str;      // Ended→loop_final, Continued→loop_retry, Cut→loop_cut
    pub fn err_phase(self) -> &'static str;  // 각 *_err
}
impl Aggregator {
    /// 조건 반복 본문 응답 한 건을 갈래 구간에 기록한다. 에러면 *_err 구간에도 한 번 더.
    pub fn record_loop_split(&mut self, step_id: &str, class: LoopSplitClass, latency_us: u64, is_error: bool);
}
```

- [ ] **Step 1: 실패하는 테스트 둘**

먼저 `crates/engine/tests/loop_split.rs`를 만든다(`lib.rs`에는 `#[cfg(test)]`가 없어 tdd-guard가 대기 중인 테스트 파일을 요구한다 — 이 파일이 그 역할이고 재수출 계약도 지킨다):

```rust
//! 조건 반복 응답 시간 분리(loop-while-latency-split).
use handicap_engine::{
    LOOP_SPLIT_PASS_SAMPLE_CAP, LoopSplitClass, PHASE_LOOP_CUT, PHASE_LOOP_CUT_ERR,
    PHASE_LOOP_FINAL, PHASE_LOOP_FINAL_ERR, PHASE_LOOP_RETRY, PHASE_LOOP_RETRY_ERR,
};

#[test]
fn loop_split_wire_names_are_fixed() {
    assert_eq!(LOOP_SPLIT_PASS_SAMPLE_CAP, 1024);
    assert_eq!(
        [PHASE_LOOP_FINAL, PHASE_LOOP_RETRY, PHASE_LOOP_CUT],
        ["loop_final", "loop_retry", "loop_cut"]
    );
    assert_eq!(
        [PHASE_LOOP_FINAL_ERR, PHASE_LOOP_RETRY_ERR, PHASE_LOOP_CUT_ERR],
        ["loop_final_err", "loop_retry_err", "loop_cut_err"]
    );
    assert_eq!(LoopSplitClass::Ended.phase(), PHASE_LOOP_FINAL);
    assert_eq!(LoopSplitClass::Continued.phase(), PHASE_LOOP_RETRY);
    assert_eq!(LoopSplitClass::Cut.phase(), PHASE_LOOP_CUT);
    assert_eq!(LoopSplitClass::Cut.err_phase(), PHASE_LOOP_CUT_ERR);
}
```

그다음 단위 테스트를 `aggregator.rs`의 기존 `#[cfg(test)] mod tests`에 추가:

```rust
#[test]
fn loop_split_records_class_and_error_phases() {
    let mut a = Aggregator::new(0);
    a.record_loop_split("s1", LoopSplitClass::Ended, 180_000, false);
    a.record_loop_split("s1", LoopSplitClass::Continued, 12_000, false);
    a.record_loop_split("s1", LoopSplitClass::Continued, 13_000, true);
    a.record_loop_split("s1", LoopSplitClass::Cut, 14_000, true);
    let got: std::collections::BTreeMap<String, u64> = a
        .drain_phase_deltas()
        .into_iter()
        .map(|p| {
            assert_eq!(p.step_id, "s1");
            assert_eq!(p.histogram.len(), p.count);
            (p.phase, p.count)
        })
        .collect();
    let want: std::collections::BTreeMap<String, u64> = [
        ("loop_final", 1), ("loop_retry", 2), ("loop_retry_err", 1),
        ("loop_cut", 1), ("loop_cut_err", 1),
    ].into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    assert_eq!(got, want);
    assert_eq!(LOOP_SPLIT_PASS_SAMPLE_CAP, 1024);
    assert_eq!(LoopSplitClass::Ended.err_phase(), "loop_final_err");
}
```

- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-engine loop_split` → 컴파일 실패(이름 없음).
- [ ] **Step 3: 구현** — 위 Interfaces 그대로. `record_loop_split`은 기존 `record_phase`를 부른다(에러면 두 번). `lib.rs`의 `pub use aggregator::{…}` 목록에 새 이름 8개(상수 7 + `LoopSplitClass`)를 더한다.
- [ ] **Step 4: GREEN 확인** — 같은 명령으로 두 테스트 PASS. `cargo clippy -p handicap-engine --all-targets -- -D warnings` 통과.
- [ ] **Step 5: 커밋** — `feat(engine): 조건 반복 응답 시간 갈래 기록(record_loop_split) (loop-while-latency-split)`

---

### Task 2: 엔진 runner — 회차 버퍼와 갈래 분류

**Files:**
- Modify: `crates/engine/tests/loop_split.rs` (Task 1이 만든 파일에 이어 쓴다)
- Modify: `crates/engine/src/runner.rs` (`execute_steps` 시그니처·Http 가지·조건 반복 가지·if/loop/parallel 가지의 전달·비재귀 호출부 3곳)
- Modify: `crates/engine/CLAUDE.md` (한 줄 고침 + 한 줄 추가)

**Interfaces:**
- Consumes: Task 1의 `LoopSplitClass`, `Aggregator::record_loop_split`, `LOOP_SPLIT_PASS_SAMPLE_CAP`, `PHASE_LOOP_*`.
- Produces: 조건 반복이 있는 run의 `MetricFlush.phase_stats`에 `loop_final`/`loop_retry`/`loop_cut`(+`_err`) 항목. 조건 반복이 없는 run은 `phase_stats`가 지금과 같다.

**설계 결정 (spec §3.1)**

- `execute_steps`의 마지막 인자 `in_cond_loop: bool` → `cond_pass: Option<&PassSamples>`. 본문 안 여부 = `cond_pass.is_some()`.
- `runner.rs`에 비공개 타입:

```rust
struct PassSample { step_id: String, latency_us: u64, is_error: bool }
type PassSamples = std::sync::Mutex<Vec<PassSample>>;
```

- `step_id`는 새로 복사하지 않는다. Http 가지의 집계 블록 끝에서 `outcome.step_id`를 `std::mem::take`로 옮겨 담는다(그 뒤 `outcome.step_id`를 읽는 코드가 없는지 구현자가 확인. 있으면 복사로 바꾸고 리포트에 적는다).
- Http 가지: `cond_pass`가 `Some`이고 버퍼 길이 < `LOOP_SPLIT_PASS_SAMPLE_CAP`이면 한 건 push. std 잠금은 `await`를 넘기지 않는다. 오염된 잠금은 `unwrap_or_else(|e| e.into_inner())`.
- 조건 반복 가지(진입마다 `PassSamples` 하나를 만들어 본문에 `Some(&…)`): 회차가 끝나는 네 곳에서 버퍼를 비워 기록한다.

| 지점 | 갈래 | 기존 `record_loop_exit` |
|---|---|---|
| 본문 `Continue` + 조건 거짓 | `Ended` | `Completed` — 같은 잠금 안에서 함께 |
| 본문 `Continue` + 조건 참 + 최대 횟수 | `Cut` | `Exhausted` — 같은 잠금 안에서 함께 |
| 본문 `Continue` + 조건 참 + 다음 회차 | `Continued` | 없음. `yield_now` 전에 비운다 |
| 본문 비-`Continue`/`Err` | `Cut` | `Truncated` — 같은 잠금 안에서 함께 |

- 버퍼가 비어 있고 `record_loop_exit`도 없으면 집계 잠금을 잡지 않는다. 머리의 종료 시각·취소 지점은 손대지 않는다(버퍼가 항상 비어 있다).
- 회차마다 새 `Vec`를 할당하지 않는다(가지가 가진 빈 `Vec`와 `mem::swap` 뒤 `drain`).
- 반환 값·분기 순서·`yield_now`는 그대로.
- if·while 없는 loop·parallel 가지는 받은 `cond_pass`를 그대로 넘긴다. 비재귀 호출부 3곳(`grep -n 'execute_steps(' crates/engine/src/runner.rs`의 491·1514·1908행 부근)은 `None`.
- `trace.rs`는 수정하지 않는다.

- [ ] **Step 1: `crates/engine/tests/loop_split.rs`에 실패하는 테스트 추가**

`crates/engine/tests/loop_exit.rs`의 `plan`·`Mode`·`Out`·`run_mode`·`wait_resp`·`ok_resp`·`WHILE_WAIT`를 같은 내용으로 이 파일에 둔다(통합 테스트 파일은 서로 가져다 쓸 수 없다). 시나리오 YAML 생성기는 이 파일용으로 새로 쓴다 — 본문 스텝 목록과 `assert`를 인자로 받는다. 스텝 id는 ULID 규칙을 지킨다(`I`·`L`·`O`·`U` 금지).

도우미:

```rust
/// 전 flush 합산: 그 스텝의 (loop_final, loop_retry, loop_cut, final_err, retry_err, cut_err) 건수.
fn split(out: &Out, step_id: &str) -> [u64; 6];
/// 전 flush 합산: 그 스텝 창의 (count, error_count).
fn window(out: &Out, step_id: &str) -> (u64, u64);
```

모든 조건 반복 테스트의 공통 단언(이하 "합 등식"): `final + retry + cut == window.count`, `final_err + retry_err + cut_err == window.error_count`.

| # | 테스트 이름 | 준비 | 단언 |
|---|---|---|---|
| 1 | `wait_twice_then_ok_splits_by_pass` | `/order` WAIT 2번 뒤 OK, 본문 http 하나, 600ms | 합 등식 · `retry == 2` · `final >= 1` · `*_err` 전부 0 |
| 2 | `exhausted_last_pass_is_cut` | 항상 WAIT, `while` + `repeat: 3` | 합 등식 · `final == 0` · `retry >= 2` · `cut >= 1` · `retry <= 2 * cut + 2`(run 종료 때 돌던 진입 하나는 이어진 회차 1–2개만 남기고 머리 검사에서 끝난다 — 그때는 끊김 표본이 없다) |
| 3 | `two_body_steps_split_together` | 본문 http 둘(`/order` WAIT 2번 뒤 OK, `/extra` 항상 200) | 두 스텝 각각 합 등식 · 각각 `retry == 2` |
| 4 | `errors_land_in_err_phases` | 본문 스텝에 `assert: [{ status: 201 }]`(응답은 200이라 전부 에러), WAIT 2번 뒤 OK | 합 등식 · `window.error_count > 0` · `final_err + retry_err + cut_err == window.count`(전부 에러). 에러 응답에서 추출이 되는지에는 기대지 않는다 |
| 5 | `unbounded_never_resolving_has_no_final` | 항상 WAIT, 최대 횟수 없음, 300ms | 합 등식 · `final == 0` · `retry >= 1` |
| 6 | `no_retry_run_records_no_loop_retry` | (a) 항상 OK + 본문 스텝 `think_time: { min_ms: 2000, max_ms: 2000 }`, 300ms (b) 항상 WAIT + `while` + `repeat: 1` | (a) `retry == 0` · `final == 0` · `cut == 1` · 합 등식 (b) `retry == 0` · `final == 0` · `cut == window.count` |
| 7 | `scenarios_without_cond_loop_record_no_phase_stats` | flat, while 없는 loop(`repeat: 2`), if, parallel 시나리오 각각 | 모든 flush의 `phase_stats`가 비어 있다 |
| 8 | `pass_sample_cap_limits_one_pass` | 조건 반복 본문 = while 없는 loop `repeat: 1100` 안에 http 하나, 항상 OK, 충분한 시간(완료된 진입이 1건 이상 나오게) | `window.count >= 1100` · `final == 1024 * (loop_exit_stats의 완료 건수)` · `final + cut < window.count` |
| 9 | `http_inside_if_in_cond_loop_is_split` | 본문 = `/order` http + if(`{{code}}` eq `OK`) then `/detail` http. WAIT 2번 뒤 OK | `/detail` 스텝: 합 등식 · `final >= 1` · `retry == 0`. `/order` 스텝: `retry == 2` |
| 10 | `http_inside_parallel_in_cond_loop_is_split` · `http_inside_plain_loop_in_cond_loop_is_split` (테스트 둘) | 본문에 parallel 분기 안 http / 본문에 while 없는 loop 안 http | 안쪽 스텝마다 합 등식 · `final + retry + cut >= 1` |
| 11 | `curve_and_open_modes_keep_sum_equality` | 테스트 1의 시나리오를 `Mode::Curve`·`Mode::Open`으로 | 합 등식 · `final + retry + cut >= 1` |

- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-engine --test loop_split` → Task 1의 이름 테스트와 테스트 7만 통과하고 나머지는 실패(구간 건수 0).
- [ ] **Step 3: 구현** — 위 "설계 결정" 그대로.
- [ ] **Step 4: GREEN 확인** — `cargo nextest run -p handicap-engine --test loop_split` 전부 PASS. `cargo nextest run -p handicap-engine` 전체 PASS(기존 `loop_exit`·`phase_breakdown`·`think_time` 포함).
- [ ] **Step 5: 이빨 실증 (되돌림 포함, 리포트에 출력 발췌)**
  - "조건 참 + 다음 회차" 지점의 비우기를 지움 → 테스트 1 RED(`retry == 2`만 깨진다 — 표본이 버퍼에 남았다가 마지막 회차와 함께 기록되므로 합 등식은 그대로 성립) → 원복.
  - Http 가지에서 `cond_pass`와 무관하게 `record_loop_split`을 바로 부르게 바꿈 → 테스트 7 RED(R0) → 원복.
  - if 가지의 전달을 `None`으로 바꿈 → 테스트 9 RED → 원복.
  - parallel 가지의 전달만 `None`으로 바꿈 → 테스트 10의 parallel 쪽 RED → 원복. while 없는 loop 가지의 전달만 `None`으로 바꿈 → 테스트 10의 loop 쪽 RED → 원복(하나씩 따로).
  - 조건 반복 가지에서 "조건 참 + 최대 횟수"를 `Continued`로 바꿈 → 테스트 6(b) RED → 원복.
  - Http 가지의 push를 `cond_pass` 검사 없이 하도록은 못 한다(타입상 불가) — 대신 push의 상한 검사를 지움 → 테스트 8 RED → 원복.
- [ ] **Step 6: `crates/engine/CLAUDE.md`** — 테스트 절의 `in_cond_loop` 줄에서 인자 이름을 `cond_pass`(runner)·`in_cond_loop`(trace)로 바로잡고, 오픈루프 절의 `loop_exit_stats` 줄 아래에 한 줄: "조건 반복 가지가 회차 끝에 `loop_final`/`loop_retry`/`loop_cut`(+`_err`)를 `record_phase`로 기록한다 — `measure_phases`와 무관, 새 드레인 없음. if·loop·parallel 가지가 `cond_pass`를 그대로 넘겨야 한다(`None`을 넘겨도 컴파일된다 — `tests/loop_split.rs` 9·10이 지킨다) (loop-while-latency-split)".
- [ ] **Step 7: 게이트·커밋** — `cargo fmt --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo nextest run --workspace`. 커밋 `feat(engine): 조건 반복 본문 응답을 회차 끝에 세 갈래로 기록 (loop-while-latency-split)`.

---

### Task 3: 컨트롤러 — `build_report`의 `loop_split`

**Files:**
- Modify: `crates/controller/src/report.rs` (구조체 2개·`ReportStep` 필드·`build_report` 집계·테스트)
- Modify: `crates/controller/src/export.rs`, `crates/controller/src/insights.rs` (테스트의 `ReportStep` 리터럴에 `loop_split: None`만)
- Modify: `docs/adr/0056-*.md` ("리포트 집계" 절에 한 문단)

**Interfaces:**
- Consumes: `handicap_engine::{PHASE_LOOP_FINAL, PHASE_LOOP_RETRY, PHASE_LOOP_CUT, PHASE_LOOP_FINAL_ERR, PHASE_LOOP_RETRY_ERR, PHASE_LOOP_CUT_ERR}`.
- Produces (리포트 JSON, Task 4·5가 읽는다):

```rust
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct LoopSplitStats { pub count: u64, pub error_count: u64, pub p50_ms: u64, pub p95_ms: u64, pub p99_ms: u64 }

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct LoopSplit {
    #[serde(rename = "final")]
    pub ended: LoopSplitStats,
    pub retry: LoopSplitStats,
}

// ReportStep에 추가
#[serde(default, skip_serializing_if = "Option::is_none")]
pub loop_split: Option<LoopSplit>,
```

JSON 꼴: `"loop_split": {"final": {"count":…,"error_count":…,"p50_ms":…,"p95_ms":…,"p99_ms":…}, "retry": {…}}`.

**규칙 (spec §3.3)**

- `final` = `loop_final` 행. `retry` = `loop_retry` + `loop_cut` 행을 합친 것. 히스토그램은 `merge_into`, 건수는 `count` 합. 에러 수는 `*_err` 행의 `count` 합(`*_err`의 BLOB은 읽지 않는다).
- **`loop_retry` 건수 합이 1 이상인 스텝에만** `Some`. `loop_cut`은 이 판단에 넣지 않는다.
- 음수 `count`는 0. `error_count`는 `count`로 자른다. 깨진 BLOB은 `count`만 더하고 히스토그램은 뺀다(`download` 처리와 같다).
- 백분위는 `percentiles_of`. 건수 0인 갈래의 백분위는 0.
- `steps`에 없는 스텝의 구간 행은 버린다. 기존 `download`·`wait`·`connection` 계산은 손대지 않는다.

- [ ] **Step 1: `report.rs` 테스트 모듈에 실패하는 테스트 6개** (기존 `run_row`·`win`·`make_hdr_bytes`·`PhaseMetricRow` 사용. `ph(step, phase, samples_us, count)` 도우미 하나를 둔다)

| # | 이름 | 입력 | 단언 |
|---|---|---|---|
| 1 | `loop_split_rolls_up_final_and_retry` | 스텝 `s1` 창 1개 + `loop_final`(샘플 180_000×2, count 2) 2행 + `loop_retry`(12_000×3, count 3) + `loop_retry_err`(count 1) | `final.count == 4`, `final.p50_ms == 180`, `retry.count == 3`, `retry.error_count == 1`, `retry.p50_ms == 12`, `final.error_count == 0` |
| 2 | `loop_split_omitted_without_continued_passes` | (a) `loop_final`만 (b) `loop_final` + `loop_cut` (c) `loop_retry` count 0 | 셋 다 `loop_split.is_none()`이고 `serde_json::to_string(&rep)`에 `"loop_split"`이 없다 |
| 3 | `loop_split_retry_includes_cut` | `loop_retry` count 1 + `loop_cut` count 2 + `loop_cut_err` count 2 | `retry.count == 3`, `retry.error_count == 2` |
| 4 | `loop_split_without_final_keeps_both_sides` | `loop_retry` count 5만 | `Some`, `final.count == 0`, `final.p50_ms == 0`, `retry.count == 5` |
| 5 | `loop_split_sanitizes_worker_input` | `loop_retry` count 2 + `loop_retry_err` count 9 + `loop_final` count -3 + `loop_retry` 행 하나는 BLOB `vec![1,2,3]`·count 4 | `retry.count == 6`, `retry.error_count == 6`, `final.count == 0`, 패닉 없음 |
| 6 | `loop_split_rows_do_not_touch_download_wait_connection` | `download`·`wait`·`dns`·`connect` 행 + 구간 여섯 종 행 | `download`·`wait`·`connection`이 구간 행 없이 만든 리포트와 `==`. `steps`에 없는 스텝 id의 구간 행이 있어도 `steps.len()` 불변 |

테스트 1에 round-trip도 넣는다: `serde_json::to_value(&rep)`의 `steps[0].loop_split.final.count == 4`, 다시 `ReportJson`으로 역직렬화 성공.

- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-controller loop_split` → 컴파일 실패.
- [ ] **Step 3: 구현** — 구조체·필드·`build_report` 집계. `ReportStep` 리터럴 4곳(`grep -rnE '^\s*ReportStep \{' crates/controller`)에 `loop_split`.
- [ ] **Step 4: GREEN 확인** — `cargo nextest run -p handicap-controller` 전체 PASS(기존 리포트·내보내기·골든 테스트의 단언은 고치지 않는다).
- [ ] **Step 5: 이빨 실증** — 방출 조건을 "`retry.count >= 1`"(끊김 포함)로 바꿈 → 테스트 2(b) RED → 원복.
- [ ] **Step 6: ADR-0056** — "리포트 집계" 절 끝에 한 문단: 세 갈래 규칙(끝냄·이어짐·끊김), 구간 이름 여섯 개가 `phase_stats` 길을 탄다는 것, 화면 `retry` = 이어짐 + 끊김, 표시 조건 = 이어짐 ≥ 1, 회차 표본 상한 1,024.
- [ ] **Step 7: 게이트·커밋** — `cargo fmt --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo nextest run --workspace`. 커밋 `feat(controller): 리포트 스텝에 loop_split(끝낸 응답/재시도 응답) (loop-while-latency-split)`.

---

### Task 4: 화면 — 스키마·문구·스텝 표 두 줄

**Files:**
- Modify: `ui/src/api/schemas.ts`
- Modify: `ui/src/i18n/ko.ts`
- Modify: `ui/src/components/report/StepStatsTable.tsx`
- Test: `ui/src/components/report/__tests__/StepStatsTable.test.tsx`, 스키마 테스트는 기존 리포트 스키마 테스트 파일(`grep -rln 'ReportStepSchema\|ReportSchema' ui/src --include='*.test.ts*'`로 찾는다)

**Interfaces:**
- Consumes: Task 3의 JSON 꼴.
- Produces:

```ts
// schemas.ts
export const LoopSplitStatsSchema = z.object({
  count: z.number().int().nonnegative(),
  error_count: z.number().int().nonnegative(),
  p50_ms: z.number().int().nonnegative(),
  p95_ms: z.number().int().nonnegative(),
  p99_ms: z.number().int().nonnegative(),
}).strict();
export const LoopSplitSchema = z.object({ final: LoopSplitStatsSchema, retry: LoopSplitStatsSchema }).strict();
// ReportStepSchema에: loop_split: LoopSplitSchema.optional()
export type LoopSplit = z.infer<typeof LoopSplitSchema>;

// ko.ts report.loopExit 아래 (spec §4.3 문구 그대로)
splitFinal: "반복을 끝낸 응답",
splitRetry: "재시도로 이어진 응답",
splitHelpLabel: (name: string) => `「${name}」 나뉜 응답 시간 설명`,
splitHelpFinal: "반복을 끝낸 응답 = 조건이 풀려 반복이 끝난 회차에서 받은 응답.",
splitHelpRetry: "재시도로 이어진 응답 = 그 밖의 회차에서 받은 응답. 최대 횟수에 걸려 중단된 회차와 run 종료·중지·오류로 끊긴 회차도 여기에 들어갑니다.",
splitBarLine: (label: string, count: string, errors: string, p50: string, p95: string, p99: string) =>
  `${label} · ${count}건 · 에러 ${errors} · p50 ${p50} · p95 ${p95} · p99 ${p99} ms`,
```

**표 규칙 (spec §4.1)**

- `s.loop_split`이 있으면 스텝 행 바로 뒤에 `<tr>` 둘(끝낸 응답 → 재시도), 그 뒤에 기존 회차별 표 행(열려 있을 때).
- 각 줄의 칸: 이름 칸(`<span aria-hidden="true">└ </span>` + 문구, 들여쓰기, 끝낸 응답 줄에만 `HelpTip`) · 메서드 빈 칸 · URL 빈 칸 · 요청 · 에러 · p50 · p95 · p99 · (대기 칸이 있으면 빈 칸 1) · (다운로드 칸이 있으면 빈 칸 3). 스텝 행과 `td` 수가 같다.
- 숫자는 스텝 행처럼 쉼표 없이. `count`가 0인 줄의 p50·p95·p99는 `—`.
- 글자색 `text-slate-600`, 경계선은 스텝 행과 같은 클래스.
- `HelpTip`의 `label` = `ko.report.loopExit.splitHelpLabel(m?.name ?? s.step_id)`, 내용은 `splitHelpFinal`·`splitHelpRetry` 두 `block` span(`LoopExitSummary.tsx`의 HelpTip과 같은 꼴).
- 두 줄은 `retriedStepIds`와 무관하게 `loop_split`만 보고 그린다.

- [ ] **Step 1: 실패하는 RTL·스키마 테스트 작성** (`describe("loop_split 두 줄", …)`)

| # | 이름 | 단언 |
|---|---|---|
| 1 | 두 줄이 스텝 행 바로 아래에 순서대로 | `loop_split`이 있는 스텝 `a`와 없는 스텝 `b`. `tbody`의 `tr` 순서 = a, 끝낸 응답, 재시도, b. 끝낸 응답 줄 칸 텍스트 = `1200`·`0`·`182`·`420`·`488`, 재시도 줄 = `612`·`0`·`12`·`31`·`44` |
| 2 | 끝낸 응답 0건이면 백분위가 `—` | `final.count: 0` → 그 줄의 p50·p95·p99 칸이 `—`, 요청 칸은 `0` |
| 3 | `loop_split`이 없으면 DOM이 작업 전과 같다 | `loop_split` 없는 스텝 둘(하나는 `loop_breakdown`·표지 있음)을 그린 `container.innerHTML`을 `toMatchInlineSnapshot()`으로 고정. **구현 전에(Step 2에서) 한 번 돌려 지금 DOM을 스냅샷으로 기록**하고, 구현 뒤에도 그 스냅샷 그대로 통과해야 한다(스냅샷을 다시 쓰지 않는다) |
| 4 | 토글을 열면 두 줄 아래에 회차별 표 | `loop_breakdown`도 있는 스텝에서 ▸ 클릭 → `tr` 순서 = 스텝, 끝낸 응답, 재시도, 회차별 표 행 |
| 5 | 대기·다운로드 칸이 있어도 칸 수가 같다 | `wait`·`download`가 있는 스텝 + `loop_split` → 스텝 행과 두 줄의 `td` 수가 모두 같다(12) |
| 6 | 도움말 이름이 스텝마다 다르다 | 나뉜 스텝 둘 → `getByRole("button", { name: "「주문」 나뉜 응답 시간 설명" })`와 `「결제」…`가 각각 하나 |
| 7 | `└`는 낭독되지 않는다 | 두 줄의 `└`가 `aria-hidden="true"` 요소 안에 있다. 이름 칸에서 그 요소를 뺀 텍스트가 `반복을 끝낸 응답`으로 시작 |
| 8 | 표지 없이도 두 줄이 보인다 | `retriedStepIds`에 없는 스텝 + `loop_split` → 표지 없음, 두 줄 있음 |
| 9 | 스키마 | `loop_split` 없는 스텝·있는 스텝 둘 다 `ReportStepSchema.parse` 성공. `loop_split.final`에 모르는 키 → 실패. `loop_split: null` → 실패(서버는 키를 생략한다) |

- [ ] **Step 2: RED 확인** — `cd ui && pnpm test -- StepStatsTable schemas` → 새 테스트 실패. 테스트 3은 통과하며 이때 인라인 스냅샷이 파일에 기록된다(기록된 스냅샷을 커밋에 포함).
- [ ] **Step 3: 구현** — 스키마 → 문구 → 표.
- [ ] **Step 4: GREEN 확인** — `pnpm test -- StepStatsTable schemas` PASS. 테스트 3의 스냅샷은 Step 2에서 기록된 그대로다(`git diff`로 스냅샷 줄이 바뀌지 않았는지 확인).
- [ ] **Step 5: 이빨 실증** — 두 줄을 회차별 표 행 **뒤**에 그리게 바꿈 → 테스트 4 RED → 원복. `count === 0` 검사를 지움 → 테스트 2 RED → 원복.
- [ ] **Step 6: 게이트·커밋** — `pnpm lint && pnpm test && pnpm build`. 커밋 `feat(ui): 스텝 표에 조건 반복 응답 시간 두 줄 (loop-while-latency-split)`.

---

### Task 5: 화면 — 막대 보기 글자 두 줄

**Files:**
- Modify: `ui/src/components/report/StepPhaseBreakdown.tsx`
- Test: `ui/src/components/report/__tests__/StepPhaseBreakdown.test.tsx`
- Modify: `ui/src/components/report/CLAUDE.md` (한 줄)

**Interfaces:**
- Consumes: Task 4의 `ReportStep.loop_split`, `ko.report.loopExit.splitFinal`·`splitRetry`·`splitBarLine`.

**규칙 (spec §4.2)**

- 막대 보기(`view === "waterfall"`)에서 `s.loop_split`이 있는 스텝의 막대 줄 **아래**에 글자 두 줄. 막대 줄(flex 한 줄)의 구조와 폭은 바꾸지 않는다 — 두 줄은 그 줄 밖 형제다.
- 각 줄: `<span aria-hidden="true">└ </span>` + `splitBarLine(문구, 건수, 에러, p50, p95, p99)`. 건수·에러는 `toLocaleString("en-US")`. `count`가 0이면 p50·p95·p99 자리에 `—`.
- 클래스: `text-xs text-slate-600`, 줄바꿈 허용(`break-words`), 가로 넘침 금지.
- 「칩」 보기는 `StepStatsTable`을 그대로 쓰므로 Task 4의 두 줄이 나온다.

- [ ] **Step 1: 실패하는 RTL 테스트**

| # | 이름 | 단언 |
|---|---|---|
| 1 | 막대 보기에 글자 두 줄 | `wait`가 있고 `loop_split`이 있는 스텝 → `반복을 끝낸 응답 · 1,200건 · 에러 0 · p50 182 · p95 420 · p99 488 ms`와 `재시도로 이어진 응답 · 612건 · 에러 0 · p50 12 · p95 31 · p99 44 ms` 텍스트. `loop_split` 없는 스텝에는 없다 |
| 2 | 끝낸 응답 0건 | `… · 0건 · 에러 0 · p50 — · p95 — · p99 — ms` |
| 3 | 막대 줄 구조 불변 | `loop_split` 유무만 다른 두 렌더에서 막대 줄 요소(`role="img"`의 부모)의 `className`과 자식 수가 같다 |
| 4 | 「칩」으로 바꾸면 표 두 줄 | 「칩」 버튼 클릭 → 표에 `반복을 끝낸 응답` 행 |
| 5 | `└`는 `aria-hidden` | 글자 줄의 `└`가 `aria-hidden="true"` 요소 안 |

- [ ] **Step 2: RED 확인** — `cd ui && pnpm test -- StepPhaseBreakdown`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: GREEN 확인.**
- [ ] **Step 5: `ui/src/components/report/CLAUDE.md`** — 조건 반복 줄 아래에 한 줄: "나뉜 응답 시간 두 줄은 `step.loop_split`이 있을 때만(서버가 이어진 회차 ≥ 1일 때만 낸다) — 「재시도 포함」 표지(`retriedStepIds`)와 따로 나올 수 있다. 표는 쉼표 없이(스텝 행과 같게), 막대 보기 글자 줄은 쉼표. `└`는 `aria-hidden` (loop-while-latency-split)".
- [ ] **Step 6: 게이트·커밋** — `pnpm lint && pnpm test && pnpm build`. 커밋 `feat(ui): 막대 보기에 조건 반복 응답 시간 두 줄 (loop-while-latency-split)`.

---

## Task 뒤 (파이프라인 4–6단계, task 아님)

주의: Task 3 커밋과 Task 4 커밋 사이에서는 실제 화면이 `loop_split`이 든 리포트를 거절한다(`.strict()`). 게이트는 깨지지 않지만 그 사이 커밋에서 라이브 확인을 하지 않는다.

1. **최종 리뷰**: `handicap-reviewer`(와이어 1:1 — 엔진 구간 이름 ↔ 컨트롤러 ↔ JSON ↔ Zod, R0, US3). `finish-slice` §0 grep이 매치하면 `security-reviewer`.
2. **라이브 검증**(`/live-verify`): spec §6.4 표 전체 — US1·US2(단일 워커·fan-out 2대·open-loop·`measure_phases`), 끝내 풀리지 않는 반복, US3 세 경우, 전 화면(run 상세·인쇄·비교), 극단값, 성능·저장량 A/B. 작업 전 바이너리는 커밋 `6bef7e79`의 것(이 세션 임시 폴더에 있었으나 새 세션에서는 없을 수 있다 — 없으면 `git worktree add`로 그 커밋을 따로 체크아웃해 빌드).
3. **마무리**(`/finish-slice`): build-log 단락(증명된 US / 못 한 US), roadmap §B61(spec §7 항목 + 구현 중 판단, 번호는 `grep -n '^### B' docs/roadmap.md`로 확인), 현황판, CLAUDE.md 상태 줄, 메모리.

## 사실 주장과 확인 명령 (디스패치 전 재실행)

| 주장 | 명령 |
|---|---|
| `execute_steps` 호출 8줄(정의 1·비재귀 3·재귀 4) | `grep -n 'execute_steps(' crates/engine/src/runner.rs` |
| `in_cond_loop` runner 6줄 | `grep -n 'in_cond_loop' crates/engine/src/runner.rs` |
| `Aggregator::record` 호출 1곳 | `grep -n 'a\.record(' crates/engine/src/runner.rs` |
| `ReportStep` 리터럴 4곳 | `grep -rnE '^\s*ReportStep \{' crates/controller` |
| 새 이름 충돌 없음(무관한 1건) | `grep -rn 'loop_split\|loop_final\|loop_retry\|loop_cut\|PassSample\|LoopSplit' crates ui/src` |
| 기존 테스트가 조건 반복 시나리오의 `phase_stats` 비어 있음을 단언하지 않는다 | `grep -rn 'phase_stats' crates/engine/tests crates/worker crates/controller/tests` |
| ADR-0056 파일 | `ls docs/adr/ \| grep 0056` (구현 시 단독 `ls docs/adr`로 확인) |
