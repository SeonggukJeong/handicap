# 조건 반복(loop + `while`) 1차 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** loop 스텝에 선택적 `while` 조건을 붙여 "본문 1회 실행 → 조건이 참이면 다시"(do-while)를 실행·시험 실행·운영 모니터·에디터에서 지원한다.

**Architecture:** 엔진 `LoopStep`에 `while`·`keep_think`를 더하고 `repeat`을 선택으로 바꾼다. runner와 trace의 loop arm이 `while` 유무로 경로를 나누며(없으면 기존 코드 그대로), 조건 반복 본문에서는 너그러운 추출을 쓴다. 최대 횟수 도달은 새 `StepFlow::EndIteration`으로 이번 반복을 끝낸다. 메트릭 와이어·DB·리포트는 건드리지 않는다(2차).

**Tech Stack:** Rust(engine·controller·tui), TypeScript/React(Zod·Zustand·yaml Document API), vitest/RTL, cargo nextest.

REVIEW-GATE: APPROVED

(spec 4회차·plan 4회차 `spec-plan-reviewer` clean APPROVE, 2026-11-13)

**Spec:** `docs/superpowers/specs/2026-11-13-loop-do-while-design.md` · **문구 정본:** `docs/superpowers/specs/2026-11-13-loop-do-while-copy.md`(byte-exact — 매 UI task brief에 첨부)

## Global Constraints

- **R0**: `while`이 없는 loop과 기존 YAML은 전 계층에서 지금과 같다 — 실행 순서(`repeat: 0` = 0회 포함), YAML round-trip 글자, 메트릭, 리포트 JSON, trace JSON, UI 화면·신뢰도 지문.
- 메트릭 proto·DB 마이그레이션·`ReportJson`·`build_report`를 건드리지 않는다.
- UI 문구는 전부 `ko.ts` 경유이고 값은 문구 정본 그대로. 새 버튼의 접근명은 보이는 글자를 포함한다.
- Zod 새 필드는 `.optional()`만(`.default()` 금지). 응답 스키마에서 서버가 생략하는 키는 `.optional()`.
- plan 인라인 Rust는 clippy `-D warnings` 통과 형태(2-arm match 대신 `if let`).
- 모든 task는 테스트 먼저(tdd-guard). 커밋은 task마다 하나, 전체 게이트 통과 상태. 커밋·게이트 명령에 `| tail`/`| head` 금지, `--no-verify` 금지.
- "회귀 가드"라고 표시한 테스트는 고의로 망가뜨려 RED → 원복 GREEN을 실제로 실행해 보고에 남긴다.
- 줄번호는 이 문서에 적지 않았다. 위치는 각 task의 `grep` 명령으로 찾는다.

## Review Focus

1. **`repeat: 0`인 기존 loop** — 본문 0회여야 한다(무한 반복 금지). → Task 1·3·4 테스트.
2. **대기 응답에 없는 값을 함께 뽑는 스텝** — `code`는 뽑히고 스텝 에러 0, 반복은 계속. → Task 2·3 테스트.
3. **요청 없는 본문 + 항상 참인 조건** — 시험 실행은 판정 행 200개에서 끊기고, 부하 경로는 실행기를 독점하지 않는다(단일 스레드 실행기에서 옆 task가 진행). → Task 3·4 테스트.
4. **open-loop "think time 무시" + 루트 기본 think만 있는 시나리오** — 조건 반복 본문 스텝에 루트 기본값이 복사돼 살아남는다. → Task 5 테스트.
5. **최대 횟수를 비웠다가 다시 채우기 / 조건 삭제** — YAML에 `repeat` 없는 무조건 loop이 남지 않는다. → Task 6·8 테스트.

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `crates/engine/src/scenario.rs` | `LoopStep` 모델·헬퍼 | 1 |
| `crates/engine/src/extract.rs` | `evaluate_lenient`, `blank_missing_extracts` | 2 |
| `crates/engine/src/executor.rs` | `ExtractMode`, `execute_step_with`, `execute_step_traced_with` | 2 |
| `crates/engine/src/condition.rs` | `explain_condition` | 4 |
| `crates/engine/src/runner.rs` | do-while 실행, `EndIteration`, 조건 반복 표지 | 3 |
| `crates/engine/src/trace.rs` | do-while trace, `StepKind::Loop`, `ended_by_loop`, 강제 think | 4 |
| `crates/tui/src/inspect.rs` | `StepKind::Loop` 줄 | 4 |
| `crates/controller/src/insights.rs` | `collect_unconditional` 조건 | 1 |
| `crates/controller/src/api/runs.rs` | think strip에서 `keep_think` 보존 | 5 |
| `crates/controller/src/monitor/check.rs` | `REASON_LOOP_EXHAUSTED` | 5 |
| `ui/src/scenario/model.ts`, `problems.ts`, `yamlDoc.ts`, `store.ts`, `trustPrefs.ts` | 모델·검증·편집 액션·지문 | 6 |
| `ui/src/components/run/sizing.ts`, `openLoopChecks.ts` | 조건 반복의 추정 횟수 | 6 |
| `ui/src/scenario/scanVars.ts`, `ui/src/components/scenario/stepRefLabel.ts` | `while`의 변수 참조 | 7 |
| `ui/src/scenario/loopLabel.ts`(신규) | 아웃라인·칩 라벨 | 8 |
| `ui/src/components/scenario/Inspector.tsx`, `FlowOutline.tsx`, `TestFlowChips.tsx` | 에디터 화면 | 8·9 |
| `ui/src/scenario/condEmptyEval.ts`, `loopWarnings.ts`(신규) | 경고 판정 | 9 |
| `ui/src/api/schemas.ts`, `ui/src/scenario/chipResults.ts`, `ui/src/components/scenario/TestRunPanel.tsx`, `ui/src/components/monitor/CheckRecordDialog.tsx`, `PreviewResult.tsx` | 판정 행 소비 | 10 |
| `docs/adr/0056-conditional-loop.md`, 매뉴얼, 도메인 `CLAUDE.md` | 기록 | 11 |

---

### Task 1: 엔진 모델 — `LoopStep`에 `while`·`keep_think`, `repeat` 선택화

**Files:**
- Modify: `crates/engine/src/scenario.rs` (`pub struct LoopStep`), `crates/engine/src/runner.rs`·`crates/engine/src/trace.rs`(loop arm의 `lp.repeat` — 컴파일 유지용 최소 수정), `crates/controller/src/insights.rs`(`l.repeat == 0`), 엔진·컨트롤러의 `LoopStep { … }` 리터럴과 `.repeat` 단언(명령: `grep -rn "LoopStep {\|\.repeat\b" crates --include='*.rs'`), `crates/engine/tests/proptests.rs`
- Test: `crates/engine/src/scenario.rs` 인라인 테스트, `crates/controller/src/insights.rs` 인라인 테스트

**Interfaces:**
- Produces:
  ```rust
  pub struct LoopStep {
      pub id: String,
      pub name: String,
      #[serde(default, skip_serializing_if = "Option::is_none")]
      pub repeat: Option<u32>,
      #[serde(rename = "do")]
      pub do_: Vec<Step>,
      #[serde(rename = "while", default, skip_serializing_if = "Option::is_none")]
      pub while_: Option<Condition>,
      #[serde(default = "default_true", skip_serializing_if = "is_true")]
      pub keep_think: bool,
  }
  impl LoopStep {
      /// while 없는 loop의 반복 횟수: repeat.unwrap_or(1)
      pub fn plain_repeat(&self) -> u32;
      /// while 있는 loop의 최대 회차: repeat.map(|n| n.max(1)). None = 무제한
      pub fn max_passes(&self) -> Option<u32>;
      /// while이 있고 keep_think가 true
      pub fn keeps_think(&self) -> bool;
  }
  ```
  `deny_unknown_fields` 유지. `default_true`/`is_true`는 `scenario.rs` 안 private 헬퍼(`is_true(b: &bool) -> bool`).

- [ ] **Step 1: 실패하는 테스트 작성** (`scenario.rs` `mod tests`)
  - `loop_legacy_yaml_roundtrips_byte_identical`: `repeat: 3`·`do` 한 스텝짜리 loop YAML을 `from_yaml`→`to_yaml`→`from_yaml` 했을 때 구조가 같고, 직렬화 결과에 `while`·`keep_think` 글자가 없다. `l.repeat == Some(3)`, `l.while_.is_none()`, `l.keep_think == true`.
  - `loop_while_parses_and_roundtrips`: `repeat` 없음 + `while: {left: "{{code}}", op: eq, right: "WAIT"}` + `keep_think: false` → `repeat == None`, `while_ == Some(Condition::Compare{..})`, `keep_think == false`; 다시 쓰면 `keep_think: false`가 있고 `repeat`이 없다.
  - `loop_helpers`: `plain_repeat()` — `Some(0)→0`, `None→1`; `max_passes()` — `Some(0)→Some(1)`, `Some(5)→Some(5)`, `None→None`; `keeps_think()` — while 없음 → false.
  - `loop_unknown_field_rejected`: `until: …` 키가 있으면 `from_yaml` Err.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-engine scenario::tests::loop_` → 컴파일 에러(필드 없음).
- [ ] **Step 3: 모델 구현 + 컴파일 수정**
  - runner·trace의 loop arm은 이 task에서 `for i in 0..lp.plain_repeat()`로만 바꾼다(의미 변경은 Task 3·4).
  - `insights.rs::collect_unconditional`: `let cond = conditional || (l.while_.is_none() && l.repeat == Some(0));`
  - 리터럴은 `repeat: Some(N), while_: None, keep_think: true`.
  - proptest 생성기: loop에 `while_`(None 또는 단순 Compare)·`keep_think`·`repeat`(None은 `while_`가 Some일 때만) 조합을 추가한다.
- [ ] **Step 4: insights 테스트 추가** — `while_loop_body_counts_as_unconditional`: `repeat: Some(0)` + `while_: Some(..)`인 loop의 본문 http 스텝 id가 `collect_unconditional` 결과에 들어 있다(기존 `repeat: 0` 테스트는 그대로 통과).
- [ ] **Step 5: 통과 확인** — `cargo nextest run -p handicap-engine` · `cargo nextest run -p handicap-controller insights` · `cargo build --workspace` · `cargo clippy --workspace --all-targets -- -D warnings` 전부 성공.
- [ ] **Step 6: 커밋** — `feat(engine): LoopStep에 while·keep_think, repeat 선택화 (loop-do-while T1)`

---

### Task 2: 너그러운 추출

**Files:**
- Modify: `crates/engine/src/extract.rs`, `crates/engine/src/executor.rs`
- Test: 두 파일의 인라인 테스트

**Interfaces:**
- Produces:
  ```rust
  // extract.rs
  /// 항목별로 평가해 뽑힌 것만 돌려준다. 실패 항목(경로 없음·헤더/쿠키 없음·본문 비-JSON·decode/claim 실패)은 빠진다. 절대 Err를 내지 않는다.
  pub fn evaluate_lenient(extracts: &[Extract], facts: &ResponseFacts<'_>) -> BTreeMap<String, String>;
  /// step.extract가 선언한 이름 중 `extracted`에 없는 것을 `iter_vars`와 `extracted`에 ""로 넣는다. 넣은 이름을 돌려준다.
  pub fn blank_missing_extracts(step: &HttpStep, extracted: &mut BTreeMap<String, String>, iter_vars: &mut BTreeMap<String, String>) -> Vec<String>;

  // executor.rs
  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub enum ExtractMode { Strict, Lenient }
  pub async fn execute_step_with(client: &VuClient, step: &HttpStep, ctx: &TemplateContext<'_>, mode: ExtractMode) -> Result<ExecOutcome>;
  pub async fn execute_step_traced_with(client: &VuClient, step: &HttpStep, ctx: &TemplateContext<'_>, mode: ExtractMode) -> HttpTrace;
  ```
  기존 `execute_step`/`execute_step_traced`는 `Strict`를 넘기는 얇은 래퍼로 남긴다(시그니처·기존 테스트 21곳 무수정). `lib.rs`에서 `ExtractMode`·새 함수들을 기존 `execute_step`과 같은 방식으로 re-export.
- 규칙: `Lenient`는 "추출 직전까지 `error`가 없을 때" `evaluate_lenient`를 쓰고 추출 실패를 `error`로 만들지 않는다. 추출 전에 이미 `error`가 있으면 두 모드 모두 지금처럼 추출하지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `extract.rs`: `lenient_keeps_found_and_drops_missing` — 본문 `{"code":"WAIT"}`에 `code`(`$.code`)·`orderId`(`$.orderId`) 두 항목 → 결과 `{"code":"WAIT"}`만. `lenient_non_json_body_drops_body_items_keeps_header` — 본문 `not json` + Body 항목 1 + Header 항목 1(헤더 있음) → Header 항목만. `lenient_decode_failure_drops_item`. `strict_evaluate_unchanged` — 같은 입력에 기존 `evaluate`는 Err.
  - `extract.rs`: `blank_missing_fills_only_declared_and_missing` — 선언 `code`,`orderId`, extracted `{code:"WAIT"}`, iter_vars `{orderId:"old", other:"x"}` → 반환 `["orderId"]`, iter_vars `orderId == ""`, `other == "x"`, extracted에 `orderId: ""`.
  - `executor.rs`(wiremock 기존 테스트 형식): `lenient_mode_missing_extract_is_not_error` — 200 `{"code":"WAIT"}`에 두 항목 → `error.is_none()`, `extracted == {"code":"WAIT"}`. `strict_mode_same_response_errors` — 같은 응답에 `execute_step` → `error.is_some()`, `extracted.is_empty()`. `lenient_mode_assert_failure_skips_extract` — status assert 실패(응답 503, 본문에 `code: WAIT`) → `error.is_some()`, `extracted.is_empty()`. traced 변형 1개(`execute_step_traced_with(.., Lenient)`가 같은 결과).
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-engine lenient` → 컴파일 에러.
- [ ] **Step 3: 구현** — `evaluate_lenient`는 본문 JSON 파싱 결과(성공/실패)를 한 번만 계산해 Body 항목에 재사용한다. 기존 `evaluate` 본문은 바꾸지 않는다.
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-engine` 전부 성공, clippy 통과.
- [ ] **Step 5: 커밋** — `feat(engine): 너그러운 추출 모드 (loop-do-while T2)`

---

### Task 3: runner — do-while 실행과 `EndIteration`

**Files:**
- Modify: `crates/engine/src/runner.rs`
- Test: `crates/engine/src/runner.rs` 인라인 테스트 또는 `crates/engine/tests/`의 기존 runner 통합 테스트 파일(wiremock) — 기존 loop 테스트가 있는 곳에 둔다(명령: `grep -rln "Step::Loop\|type: loop" crates/engine/tests crates/engine/src/runner.rs`)

**Interfaces:**
- Consumes: Task 1 `LoopStep` 헬퍼, Task 2 `execute_step_with`·`ExtractMode`·`blank_missing_extracts`.
- Produces: `enum StepFlow { Continue, DeadlineReached, Aborted, EndIteration }`, `execute_steps(…, in_cond_loop: bool)`(마지막 인자 추가).

**동작 (spec §3.1–§3.3):**
- loop arm: `lp.while_`가 `None`이면 `for i in 0..lp.plain_repeat()` 기존 본문 그대로(재귀 호출에는 **받은 `in_cond_loop`를 그대로** 넘긴다). `Some(cond)`이면:
  ```
  let max = lp.max_passes(); let mut pass: u32 = 0;
  loop {
      deadline/cancel 확인(기존 두 줄);
      본문 재귀(loop_index = Some(pass), in_cond_loop = true) — Continue가 아니면 그대로 반환;
      pass = pass.saturating_add(1);
      조건 = eval_condition(cond, ctx{vars: iter_vars, loop_index: Some(pass - 1)});
      if !조건 { break; }
      if let Some(n) = max { if pass >= n { return Ok(StepFlow::EndIteration); } }
      tokio::task::yield_now().await;
  }
  ```
- http arm: `in_cond_loop`이면 `execute_step_with(.., ExtractMode::Lenient)`, 아니면 `Strict`. 순서: `mark_written(outcome.extracted.keys())` → (`in_cond_loop`일 때만) `blank_missing_extracts(http, &mut extracted, iter_vars)` → `iter_vars.extend(extracted)`. 메트릭 기록(`a.record(.., outcome.error.is_some(), ..)`)은 그대로.
- if arm: 받은 `in_cond_loop`를 그대로 넘긴다. parallel arm: 분기 재귀에도 그대로 넘기고, 분기 결과 합치기에 `EndIteration`을 추가한다 — 우선순위 `Aborted > DeadlineReached > EndIteration > Continue`, `EndIteration`이면 페이지 레이턴시(`record_group`)를 기록하지 않는다.
- 최상위 호출 3곳은 `in_cond_loop = false`. closed-loop VU 루프와 VU 곡선 루프의 `match flow`는 `EndIteration`을 `Continue`와 같은 가지로 처리한다. open-loop 한 반복 실행은 결과를 버리므로 인자만 추가.

- [ ] **Step 1: 실패하는 테스트 작성** (wiremock 응답기, 요청 수는 `received_requests` 길이로 단언)
  - `while_false_first_pass_runs_once`: 항상 `{"code":"OK"}` → 그 스텝 요청 수 == 반복 수(각 반복 1회), 다음 스텝 요청 수 == 반복 수.
  - `while_retries_until_ok`: 응답기가 처음 2건은 WAIT, 이후는 OK(`up_to_n_times`), VU 1 → 주문 스텝이 받은 **앞 3건**의 `${loop_index}` 쿼리가 0,1,2이고, 뒤 스텝의 첫 요청이 주문 스텝 3번째 요청 뒤에 온다(반복 횟수를 고정하는 설정은 없으므로 앞쪽 요청 순서만 단언).
  - `while_exhausted_ends_iteration_and_next_starts` (**회귀 가드**): 항상 WAIT, `repeat: Some(3)`, 시나리오 = [첫 스텝, 조건 loop, 뒤 스텝], VU 1, 짧은 duration → 뒤 스텝 요청 0건, 첫 스텝 요청 ≥ 2건(다음 반복이 시작됨), 주문 스텝 요청 수가 `3 × (첫 스텝 요청 수 − 1)` 이상 `3 × 첫 스텝 요청 수` 이하(deadline에 잘린 마지막 반복 허용). `run_scenario`가 `Ok`를 돌려준다.
  - `while_unlimited_stops_at_deadline`: 항상 WAIT, `repeat: None`, duration 1초, 본문 think 50ms → run이 `Ok`로 끝나고 걸린 시간 < 3초, 뒤 스텝 0건.
  - `plain_loop_repeat_zero_runs_zero_times` (**회귀 가드**, R0): `while` 없음 + `repeat: Some(0)` → 본문 스텝 요청 0건, 뒤 스텝은 실행됨.
  - `plain_loop_unchanged_order`: `repeat: Some(3)`, `while` 없음 → 본문 요청 3건, `${loop_index}` 0,1,2 (기존 테스트가 이미 있으면 그대로 두고 새로 쓰지 않는다).
  - `cond_loop_lenient_extract_keeps_retrying`: WAIT 응답 `{"code":"WAIT"}`·OK 응답 `{"code":"OK","orderId":"7"}`, 스텝이 `code`와 `orderId`를 함께 뽑음 → WAIT 2번 뒤 OK까지 3건, 그 스텝의 에러 카운트 0, 뒤 스텝이 `{{orderId}}`를 `7`로 보냄.
  - `cond_loop_transport_failure_blanks_and_exits`: 1회차 WAIT, 2회차 응답 지연으로 스텝 timeout(1초, `timeout_seconds: 1`) → 조건 `eq WAIT`이 거짓이 되어 loop을 빠져나오고 뒤 스텝이 실행됨. 대조: 같은 구성에서 `while` 없는 loop은 실패 뒤에도 `{{code}}`가 `WAIT`으로 남는다(뒤 스텝이 보내는 값으로 확인).
  - `cond_loop_no_request_body_stops_at_deadline`: 본문이 분기가 안 타는 if 하나뿐 + 조건 항상 참 + `repeat: None`, duration 1초 → run이 3초 안에 `Ok`로 끝난다.
  - `cond_loop_no_request_body_yields_to_other_tasks` (**회귀 가드**, `#[tokio::test(flavor = "current_thread")]`): 본문이 **빈 배열 `do: []`**인 조건 loop(엔진 타입으로 직접 만든다 — 조건 항상 참, `repeat: None`, duration 300ms)을 돌리는 동안 옆에서 `loop { counter += 1; yield_now().await }` task를 띄운다 → run이 끝난 뒤 `counter > 100`. 본문을 비우는 이유: if가 든 본문은 회차마다 `agg.lock().await`를 거치고 tokio의 협조 예산이 그 지점에서 양보를 만들어, `yield_now`가 없어도 옆 task가 돈다(가드가 공허해진다). 빈 본문은 await 지점이 `yield_now` 하나뿐이라 그것을 빼면 옆 task가 굶는다.
  - `parallel_branch_end_iteration_priority`: parallel의 한 분기에 최대 1회 조건 loop(항상 WAIT), 다른 분기는 일반 http → 다른 분기 요청은 실행되고, parallel 뒤 스텝은 0건.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-engine while_ cond_loop_ plain_loop_repeat_zero parallel_branch_end` → `while_*`·`cond_loop_*`·`parallel_*` FAIL(조건이 무시돼 횟수가 다름. 단 `cond_loop_no_request_body_stops_at_deadline`은 구현 전에도 통과할 수 있다). `plain_loop_repeat_zero…`는 이미 통과해야 한다(Task 1의 `plain_repeat`).
- [ ] **Step 3: 구현** (위 "동작")
- [ ] **Step 4: 통과 확인 + 이빨 실증** — 전체 엔진 테스트 통과. 회귀 가드 3개: ① 조건 반복 경로를 `while` 없는 loop에도 타게 바꿔 `plain_loop_repeat_zero…`가 RED(시간 초과 또는 요청 수 불일치)인지 ② closed-loop `match flow`에서 `EndIteration`을 `return Ok(())`로 바꿔 `while_exhausted…`의 "첫 스텝 ≥ 2건"이 RED인지 ③ `yield_now` 줄을 빼서 `…yields_to_other_tasks`가 RED인지 확인하고 원복.
- [ ] **Step 5: 커밋** — `feat(engine): 조건 반복 실행·EndIteration (loop-do-while T3)`

---

### Task 4: trace — 판정 행, `ended_by_loop`, 강제 think (+ TUI 줄)

**Files:**
- Modify: `crates/engine/src/condition.rs`, `crates/engine/src/trace.rs`, `crates/tui/src/inspect.rs`(+ TUI 문자열 상수 `crates/tui/src/text.rs`), 그리고 `ScenarioTrace { … }` 리터럴이 있는 테스트 코드 전부(명령: `grep -rn "ScenarioTrace {" crates --include='*.rs'` — 컨트롤러 `monitor/check.rs`·`record.rs`·`step_judge.rs`의 `#[cfg(test)]`, TUI `inspect_test.rs`·`pick_test.rs` 포함. `ended_by_loop: None` 추가)
- Test: `crates/engine/src/trace.rs`·`condition.rs` 인라인 테스트, `crates/tui/src/inspect.rs` 인라인 테스트

**Interfaces:**
- Consumes: Task 1·2.
- Produces:
  ```rust
  // condition.rs
  /// 조건 하나의 결과와 결정 잎(if 판정과 같은 가림 규칙). branch 라벨은 호출자가 준다.
  pub fn explain_condition(cond: &Condition, branch: &str, ctx: &TemplateContext) -> BranchEval;
  // trace.rs
  pub enum StepKind { Http, If, Loop }            // 와이어 "loop"
  pub const MAX_LOOP_JUDGE_ROWS: u32 = 200;
  pub struct ScenarioTrace { /* 기존 */ #[serde(default, skip_serializing_if = "Option::is_none")] pub ended_by_loop: Option<String> }
  ```
  판정 행 `StepTrace`: `step_id` = loop id, `kind` = `Loop`, `loop_index` = `Some(그 회차)`, `branch` = `Some("again" | "done" | "exhausted")`, `branch_eval` = `vec![explain_condition(cond, "while", ctx)]`, `request`/`response`/`error` = None, `extracted`/`unbound_vars` = 빈 값, `timed_out` = false.

**동작 (spec §3.2·§3.4·§3.5):**
- `TraceState`에 `judge_rows: u32`, `ended_by_loop: Option<String>` 추가. `trace_steps`에 `in_cond_loop: bool`, `force_think: bool` 인자 추가(최상위 호출은 둘 다 false).
- loop arm: `while_` 없음 → 기존 그대로(`plain_repeat`, 받은 두 표지를 그대로 전달). 있음 → runner와 같은 do-while. 본문 재귀에는 `in_cond_loop = true`, `force_think = 받은 값 || lp.keeps_think()`. 매 회차 뒤 판정 행을 push하고 `judge_rows += 1`; `judge_rows > MAX_LOOP_JUDGE_ROWS`면 `truncated = true`로 반환. `judge_rows`는 데이터 행 사이에 **초기화하지 않는다**(`max_requests`·`max_wall`처럼 전 행이 나눠 쓰는 예산). `exhausted`면 `state.ended_by_loop = Some(lp.id.clone())`로 두고 반환. 기존 `truncated` 확인 자리마다 `ended_by_loop.is_some()`도 같이 확인해 바깥 재귀를 빠져나온다.
- http arm: `in_cond_loop`이면 `execute_step_traced_with(.., Lenient)`. 순서: `mark_written(t.extracted.keys())` → (`in_cond_loop`) `blank_missing_extracts(http, &mut t.extracted, iter_vars)` → `iter_vars.extend(..)` → 행 push(행의 `extracted`에는 `""`로 채운 이름도 들어 있다). think 조건은 `opts.apply_think_time || force_think`.
- if·parallel arm은 두 표지를 그대로 전달.
- `ScenarioTrace` 생성 지점 전부(명령: `grep -n "ScenarioTrace {" crates --include='*.rs' -r`)에 `ended_by_loop` 채우기 — 실행 경로는 `state.ended_by_loop.take()`, 그 외 리터럴은 `None`. `ok` 계산은 그대로.
- TUI `inspect.rs`: `StepLine::If`를 재사용하고 `StepKind::Loop` 가지에서 `branch`를 문구 정본의 TUI 문자열로 바꿔 넣는다(`again`/`done`/`exhausted` → 세 문구, 그 외는 원문). http 줄 순번(`no`)은 세지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `condition.rs`: `explain_condition_reports_leaf` — `{{code}} eq WAIT`, vars `code=WAIT` → `passed == true`, `branch == "while"`, `leaf.left_value == Some("WAIT")`. `${`가 든 쪽은 값 None(기존 가림).
  - `trace.rs`:
    - `trace_while_emits_judge_rows`: WAIT 2번 뒤 OK → `steps`의 kind 순서 `[Http, Loop, Http, Loop, Http, Loop, …뒤 스텝 Http]`, Loop 행 `branch`가 `again, again, done`, `loop_index` 0,1,2, `ended_by_loop == None`.
    - `trace_while_exhausted_sets_ended_by_loop`: 항상 WAIT, `repeat: Some(2)` → 마지막 Loop 행 `branch == "exhausted"`, `ended_by_loop == Some(loop id)`, 뒤 스텝 행 없음, `truncated == false`.
    - `trace_plain_loop_has_no_judge_rows` (**회귀 가드**, R0): `while` 없는 loop의 trace를 JSON으로 직렬화하면 `"loop"` kind 행이 없고 `ended_by_loop` 키가 없다.
    - `trace_judge_rows_capped`: 요청 없는 본문(분기 안 타는 if) + 항상 참 + `repeat: None`, `max_requests: 50`, `max_wall: 30s` → 1초 안에 끝나고 `truncated == true`, Loop 행 수 == 201 이하 200 이상.
    - `trace_keep_think_sleeps_when_think_disabled`: `apply_think_time: false`, 본문 스텝 `think_time` 200ms 고정, WAIT 2번 뒤 OK, `keep_think` 기본 → `total_ms >= 400`. 같은 시나리오에 `keep_think: false` → `total_ms < 300`. 루트 `default_think_time`만 있는 변형도 `>= 400`.
    - `trace_cond_loop_lenient_extract`: WAIT 응답에 `orderId` 없음 → 그 http 행 `error == None`, `extracted == {"code":"WAIT","orderId":""}`.
    - `trace_sequential_rows_continue_after_exhausted`: 데이터셋 sequential 2행 + 항상 WAIT + 최대 1 → 두 행 모두 trace가 있고 각 `ended_by_loop`가 Some.
  - `inspect.rs`: `loop_judge_row_renders_as_if_line` — Loop 행 3종이 문구 정본의 세 문자열로 나오고 http 순번이 건너뛰지 않는다.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-engine trace_ explain_condition` → 컴파일 에러(`StepKind::Loop` 없음).
- [ ] **Step 3: 구현** (위 "동작"). TUI의 `match s.kind`에 `Loop` 가지 추가.
- [ ] **Step 4: 통과 확인 + 이빨 실증** — `cargo clippy --workspace --all-targets -- -D warnings`(테스트 코드의 리터럴 컴파일 포함)와 `cargo nextest run --workspace` 통과. 회귀 가드: `while` 없는 loop에도 판정 행을 push하게 바꿔 `trace_plain_loop_has_no_judge_rows`가 RED인지 확인 후 원복.
- [ ] **Step 5: 커밋** — `feat(engine,tui): 조건 반복 trace — 판정 행·ended_by_loop·keep_think (loop-do-while T4)`

---

### Task 5: 컨트롤러 — think strip 보존, 모니터 실패 사유

**Files:**
- Modify: `crates/controller/src/api/runs.rs`(`strip_scenario_think`·`strip_steps_think`), `crates/controller/src/monitor/check.rs`
- Test: 두 파일의 인라인 테스트(기존 strip 테스트·판정 테스트 옆)

**Interfaces:**
- Consumes: Task 1 `LoopStep::keeps_think`, Task 4 `ScenarioTrace.ended_by_loop`·`StepKind::Loop`.
- Produces: `pub const REASON_LOOP_EXHAUSTED: &str = "조건 반복이 최대 횟수까지 풀리지 않음";`

**동작:**
- `strip_scenario_think`: 루트 기본값을 지우기 **전에** 값을 잡아 `strip_steps_think(steps, root_default, keep = false)`에 넘긴다. `Step::Loop(l)` 재귀 시 `keep || l.keeps_think()`를 넘긴다. `keep`이 true인 http 스텝은 `think_time = think_time.or(root_default)`로 채우고 지우지 않는다(값이 바뀌었으면 changed). if는 `keep`과 `root_default`를 그대로 전달. parallel은 `keep`은 전달하되 `root_default`는 `None`으로 넘긴다(엔진이 parallel 분기에는 시나리오 기본 think를 적용하지 않으므로 복사하면 없던 대기가 생긴다). 대상 loop이 없는 시나리오의 출력은 지금과 같다.
- `check.rs` 판정: 기존 `trace.truncated` 검사와 `trace.error` 검사 **바로 뒤**에 `if trace.ended_by_loop.is_some() { return CheckResult::with_reason(at_ms, Verdict::Fail, REASON_LOOP_EXHAUSTED); }`.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `runs.rs`:
    - `strip_keeps_think_inside_keep_think_loop`: open-loop·think 무시 프로필, 시나리오 = 루트 `default_think_time {100,100}` + [http A(think 없음), 조건 loop(keep 기본)[http B(think {50,50}), http C(think 없음)], 조건 loop(`keep_think: false`)[http D(think {50,50})]] → 결과: 루트 기본 None, A None, B `{50,50}`, C `{100,100}`(루트 복사), D None.
    - `strip_output_unchanged_without_cond_loops` (**회귀 가드**, R0): `while` 없는 loop만 있는 시나리오 → 결과 YAML이 이 task 전 동작과 같다(전 스텝 think None, 루트 None). 기존 strip 테스트가 이를 이미 단언하면 그것을 가드로 지정한다.
    - `strip_if_inside_keep_loop_keeps_think`: 조건 loop 본문의 if 분기 안 http 스텝 think가 남는다.
    - `strip_parallel_inside_keep_loop_does_not_copy_root_default`: (엔진 타입으로 직접 만든) 조건 loop 본문의 parallel 분기 안 http 스텝 — 자기 think가 있으면 남고, 없으면 루트 기본값이 복사되지 않는다(None).
  - `check.rs`:
    - `ended_by_loop_fails_with_reason`: `ended_by_loop: Some(..)`, `truncated: false`, `error: None` trace → `Verdict::Fail`, reason == `REASON_LOOP_EXHAUSTED`.
    - `truncated_reason_wins_over_ended_by_loop`: 둘 다 서 있으면 기존 truncated 사유.
    - `loop_judge_rows_ignored_by_judging`: Loop 행이 섞인 정상 trace(마지막 http 200) → `Verdict::Ok`, `LatencySource::Step` 칸의 `latency_ms`가 그 스텝 **마지막** http 행의 값, 조건(`eval_conditions`)도 마지막 http 행 기준.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller strip_ ended_by_loop loop_judge_rows` → strip 2개·ended_by_loop 2개 FAIL, `loop_judge_rows…`는 통과(코드 변경 없이 고정하는 테스트).
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인 + 이빨 실증** — 컨트롤러 전체 테스트 통과. 회귀 가드: `keep`을 항상 true로 바꿔 `strip_output_unchanged…`가 RED인지 확인 후 원복.
- [ ] **Step 5: 커밋** — `feat(controller): keep_think think 보존·모니터 조건 반복 실패 사유 (loop-do-while T5)`

---

### Task 6: UI 모델·검증·편집 액션 (+ `repeat` 선택화에 따른 컴파일 수정)

**Files:**
- Modify: `ui/src/api/schemas.ts`(`StepKindSchema`에 `"loop"`, `ScenarioTraceSchema`에 `ended_by_loop: z.string().optional()` — Task 4 이후 서버가 내보내는 값을 UI가 거부하지 않게 이 task에서 먼저 받는다. 화면은 Task 10), `ui/src/scenario/model.ts`, `problems.ts`, `yamlDoc.ts`, `store.ts`, `trustPrefs.ts`, `ui/src/components/run/sizing.ts`, `openLoopChecks.ts`, 그리고 `step.repeat`을 화면에 찍는 3곳(`Inspector.tsx`·`FlowOutline.tsx`·`TestFlowChips.tsx` — 이 task에서는 `step.repeat ?? 1` 수준의 타입 수정만, 화면은 Task 8), `ui/src/i18n/ko.ts`(gate 문구 2개)
- Test: `ui/src/scenario/__tests__/`의 model·yamlDoc·store·trustPrefs 테스트, `ui/src/components/run/__tests__/`의 sizing·openLoopChecks 테스트(기존 파일에 추가)

**Interfaces:**
- Produces:
  ```ts
  // model.ts — LoopStepModel·NestedLoopStepModel 둘 다
  repeat: z.number().int().min(1, "repeat must be >= 1").optional(),
  while: ConditionModel.optional(),
  keep_think: z.boolean().optional(),
  export function isConditionalLoop(s: { while?: Condition }): boolean;   // s.while !== undefined
  /** 추정용 회차: 조건 반복이면 upper ? (repeat ?? 1) : 1, 아니면 repeat ?? 1 */
  export function loopPassesForEstimate(s: LoopStep | NestedLoopStep, bound: "lower" | "upper"): number;
  // yamlDoc.ts 편집 액션
  | { type: "setLoopRepeat"; loopId: string; repeat: number | undefined }
  | { type: "setLoopWhile"; loopId: string; cond: Condition | undefined }
  | { type: "setLoopKeepThink"; loopId: string; keep: boolean }
  // store.ts
  setLoopRepeat(loopId: string, repeat: number | undefined): void;
  setLoopWhile(loopId: string, cond: Condition | undefined): void;
  setLoopKeepThink(loopId: string, keep: boolean): void;
  ```
- 교차 검사는 기존 `StepModel.superRefine` 안에 추가: 최상위 loop과 if의 `then`/`elif[i].then`/`else` 안 loop을 순회. 메시지(영문, `problems.ts`가 한국어로 매핑): `repeat required when loop has no while`, `keep_think needs while`. path는 그 loop까지의 경로 + `"repeat"`/`"keep_think"`. `problems.ts`에 `^(.+): repeat required when loop has no while$` → `ko.editor.gateLoopRepeatRequired`, `^(.+): keep_think needs while$` → `ko.editor.gateLoopKeepThinkNeedsWhile` 매핑을 `repeat must be >= 1` 매핑 옆에 추가.
- yamlDoc: `setLoopRepeat`의 `undefined`는 `doc.deleteIn`. `setLoopWhile(undefined)`은 `while`과 `keep_think`를 지우고, `repeat`이 없으면 `repeat: 1`을 넣는다. `setLoopKeepThink(true)`는 키 삭제, `false`는 `keep_think: false`. 새 키는 맵 끝에 붙는다(`doc.setIn`). `normalizeStep`의 loop 가지에 `while`·`keep_think`를 있을 때만 통과(`...(src.while !== undefined ? { while: src.while } : {})`). loop 복제 경로는 YAML 노드 복사라 그대로 따라온다 — 테스트로 고정.
- `trustPrefs.ts` `canonSteps`의 loop 줄: `while`이 없으면 **지금 글자 그대로**. 있으면 `loop(${s.repeat ?? "inf"}|do:${…}|while:${JSON.stringify(s.while)}|keep:${s.keep_think === false ? 0 : 1})`.
- `sizing.ts`·`openLoopChecks.ts`: `s.repeat * …`를 `loopPassesForEstimate(s, …)`로 교체. 하한/기대값 계산은 `"lower"`, `iterationRequestRange`의 max와 `iterationTimeUpperBoundSeconds`는 `"upper"`.

- [ ] **Step 1: 실패하는 테스트 작성**
  - schemas: `kind: "loop"` 행과 `ended_by_loop`가 든 trace JSON이 `ScenarioTraceSchema.safeParse` 성공 / 둘 다 없는 기존 JSON도 성공.
  - model: 표 5줄 — ① `repeat: 3` 통과 ② `repeat: 3` + `while` 통과 ③ `while`만 통과 ④ 둘 다 없음 → 이슈 메시지에 `repeat required when loop has no while` ⑤ `while` + `repeat: 0` → `repeat must be >= 1`. `keep_think: false` + `while` 없음 → `keep_think needs while`. if 분기 안 loop의 ④도 잡힌다. `.strict()`: `until` 키 거부.
  - problems: 두 새 메시지가 문구 정본의 한국어로 나온다(리터럴 문자열로 단언).
  - yamlDoc/store: `setLoopWhile(id, cond)` 후 YAML에 `while:`가 `do:` 뒤에 있다 / `setLoopRepeat(id, undefined)` 후 `repeat` 키 없음 / `setLoopWhile(id, undefined)` 후 `while`·`keep_think` 없음 + `repeat: 1`(repeat이 없던 경우), repeat이 5였으면 5 유지 / `setLoopKeepThink(id, false)` → `keep_think: false`, `true` → 키 없음 / YAML → 모델 → 읽기에 `while`·`keep_think: false`가 살아 있다 / `while` 없는 loop의 정규화 결과에 새 키가 없다(`toEqual`로 정확 비교) / 조건 loop 복제 시 `while`이 따라온다.
  - trustPrefs (**회귀 가드**): `while` 없는 loop의 지문 문자열이 리터럴 `loop(3|do:…)` 형식과 정확히 같다(기존 테스트가 있으면 그것을 가드로). `while`을 바꾸면 지문이 달라진다. `keep_think`를 바꾸면 달라진다.
  - sizing/openLoopChecks: 조건 loop(`repeat: 5`, 본문 http 1개) → 요청 수 범위 min에 1회차, max에 5회차. `repeat` 없는 조건 loop → min·max 모두 1회차. `while` 없는 `repeat: 3` → 기존 값 그대로.
- [ ] **Step 2: 실패 확인** — `pnpm test schemas model yamlDoc trustPrefs sizing openLoopChecks problems` (`ui/`에서, `--` 없이) → 새 테스트 FAIL.
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인 + 이빨 실증** — `pnpm lint && pnpm test && pnpm build` 전부 성공(인자 없는 전체 테스트 1회 포함). 회귀 가드: `canonSteps`에 `|while:` 접미사를 무조건 붙이게 바꿔 trustPrefs 가드가 RED인지 확인 후 원복.
- [ ] **Step 5: 커밋** — `feat(ui): loop 모델에 while·keep_think, 편집 액션·검증 (loop-do-while T6)`

---

### Task 7: UI 변수 참조 — `while`의 `{{변수}}`

**Files:**
- Modify: `ui/src/scenario/scanVars.ts`(**참조를 세는 두 함수 `buildVarRefIndex`·`undefinedVarRefs`의 loop 가지만** — 같은 grep에 걸리는 `flatExtractNames`·`collectSubtreeExtractNames`는 추출 이름을 모으는 함수라 건드리지 않는다. 위치: `grep -n '"loop"' ui/src/scenario/scanVars.ts`), `ui/src/components/scenario/stepRefLabel.ts`, `ui/src/i18n/ko.ts`(`varRefLoopCond`)
- Test: `ui/src/scenario/__tests__/scanVars*.test.ts`, `ui/src/components/scenario/__tests__/stepRefLabel*.test.ts`(기존 파일)

**Interfaces:**
- Consumes: Task 6 모델.
- 규칙: 두 함수의 loop 가지에서 **본문(`s.do`)을 먼저 훑은 뒤** `s.while`의 조건 잎(`left`·`right`, `all`/`any` 재귀)에서 `{{…}}`를 참조로 센다. if 스텝의 `cond`를 세는 기존 헬퍼가 있으면 그것을 재사용한다(`grep -n "cond" ui/src/scenario/scanVars.ts`). 참조의 위치 라벨은 loop 스텝 id + `ko.editor.varRefLoopCond`.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `while_var_counts_as_used`: 본문 스텝이 `code`를 extract하고 `while`만 `{{code}}`를 쓰는 시나리오 → `code`가 "미사용"으로 잡히지 않는다(`buildVarRefIndex`에 참조 1건, 위치가 loop id).
  - `while_ref_to_body_extract_is_not_undefined` (**회귀 가드**): 같은 시나리오에서 `undefinedVarRefs`가 `code`를 내지 않는다(본문 뒤 판정). 대조: `while`이 본문 어디서도 안 뽑고 선언도 안 된 `{{ghost}}`를 쓰면 `ghost`가 나온다.
  - `while_does_not_pollute_extract_names`: 조건이 `{{ghost}}`를 쓰는 loop에서 `flatExtractNames`·`collectSubtreeExtractNames` 결과에 `ghost`가 없다.
  - stepRefLabel: loop 조건 참조의 라벨이 `반복 조건`을 포함한다.
- [ ] **Step 2: 실패 확인** — `pnpm test scanVars stepRefLabel` → 새 테스트 FAIL.
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인 + 이빨 실증** — `pnpm lint && pnpm test && pnpm build`. 회귀 가드: `while`을 본문 **앞**에서 판정하게 바꿔 `while_ref_to_body_extract_is_not_undefined`가 RED인지 확인 후 원복.
- [ ] **Step 5: 커밋** — `feat(ui): 반복 조건의 변수 참조를 변수 검사에 반영 (loop-do-while T7)`

---

### Task 8: UI 에디터 — 반복 조건 구역, 횟수 칸, 라벨

**Files:**
- Create: `ui/src/scenario/loopLabel.ts`
- Modify: `ui/src/components/scenario/Inspector.tsx`(`LoopInspector`, 자식 버튼 `loop ×N`), `FlowOutline.tsx`, `TestFlowChips.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/scenario/__tests__/loopLabel.test.ts`, `ui/src/components/scenario/__tests__/`의 Inspector·FlowOutline·TestFlowChips 테스트(기존 파일에 추가)

**Interfaces:**
- Consumes: Task 6 store 액션·`isConditionalLoop`, 기존 `ConditionEditor`(`Inspector.tsx`), `summarizeCondition`(`model.ts`), 접이식 프리미티브 `Section`(`ui/src/components/ui/Section.tsx` — `variant="card" collapsible open onToggle`, 열림 상태는 부모가 가진다). 이 구역의 열림 상태는 `sectionPrefs`(localStorage 전역)가 **아니라** `LoopInspector`의 로컬 state다: `useState(step.while !== undefined)`로 시드하고 `step.id`가 바뀌면 다시 시드한다(dep은 `step.id`만 — 조건을 추가한 직후에는 추가 핸들러가 직접 연다).
- Produces: `export function loopCountLabel(step: { repeat?: number; while?: Condition }): string` — `while` 없음 → `× ${repeat}`(지금 글자 그대로), 있음 + repeat → `ko.editor.loopCondLabelMax(n)`, 있음 + 없음 → `ko.editor.loopCondLabelUnlimited`.

**화면 (spec §5, 문구 정본):**
- `LoopInspector`에 「반복 조건」 구역(`Section`, 기본 접힘, `step.while`이 있으면 펼친 채로 시작). 조건 없음: 소개 문구 `loopCondIntro` + `loopCondAdd` 버튼(→ `setLoopWhile(id, {left:"", op:"eq", right:""})`). 조건 있음: `ConditionEditor`(`onCommit` → `setLoopWhile`) + `loopKeepThink` 체크(체크 상태 = `step.keep_think !== false`, 옆 HelpTip에 `loopKeepThinkHelp` — 체크의 `<label>` 밖 형제) + 한 줄 도움말 `loopLenientExtractHelp` + `loopCondRemove` 버튼(→ `setLoopWhile(id, undefined)`).
- 횟수 칸: 조건 없음 → 지금 그대로(라벨 `fieldRepeat`, 빈 값·0 이하는 되돌림). 조건 있음 → 라벨 `fieldRepeatMax`, 빈 문자열로 blur하면 `setLoopRepeat(id, undefined)`, 값이 없을 때 칸 아래 `loopRepeatUnlimitedHint`. draft 재시드 effect의 dep은 원시값(`step.id`, `step.repeat`).
- 아웃라인 행·테스트 칩의 `× N` 자리는 `loopCountLabel(step)`. 인스펙터 자식 버튼은 지금 글자가 `loop ×N`(공백 없음)이므로 **조건 반복일 때만** `loopCountLabel(step)`로 바꾸고 `while` 없는 loop은 지금 글자 그대로 둔다(R0). 조건 요약(`summarizeCondition(step.while)`)은 **아웃라인 행에만** if 행의 `CondSummary`와 같은 방식으로 붙인다(긴 요약은 `truncate` + `title`). 테스트 칩은 폭이 좁아 라벨만 둔다.
- if 분기 안 loop(`topLevel === false`)에서도 같은 구역이 보인다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - loopLabel: `{repeat:5}` → `"× 5"` / `{repeat:5, while}` → `"조건 반복 · 최대 5"` / `{while}` → `"조건 반복 · 무제한"`(리터럴 단언).
  - Inspector(각 테스트 `beforeEach`에 `localStorage.clear()`, StrictMode 래핑은 기존 파일 관례를 따른다):
    - 조건 없는 loop: 구역 토글을 열면 `조건 추가` 버튼이 보이고 체크·`조건 삭제`는 없다. 누르면 store의 그 loop에 `while`이 생긴다.
    - 조건 있는 loop: 구역이 열린 채로 시작, 라벨이 `최대 반복 횟수`, 체크 `이 반복 안의 think time은 항상 적용`이 checked. 체크를 끄면 YAML에 `keep_think: false`.
    - 횟수 칸을 비우고 다른 곳을 클릭(`user.click` — 실제 포커스 이동)하면 YAML에 `repeat` 없음 + 안내 문구가 보인다. 다시 `4`를 넣고 blur → `repeat: 4`.
    - 조건 없는 loop에서 횟수 칸을 비우고 blur → 이전 값으로 되돌아가고 YAML 불변 (**회귀 가드**).
    - `조건 삭제`(횟수 비운 상태) → YAML에 `while` 없음, `repeat: 1` (**회귀 가드**: Review Focus 5).
  - FlowOutline: 조건 loop 행에 `조건 반복 · 최대 5`와 조건 요약이 보인다. TestFlowChips: 조건 loop 칩에 `조건 반복 · 최대 5`(요약 없음). 둘 다 `while` 없는 loop은 `× 3` 그대로. 인스펙터 자식 버튼: `while` 없는 loop은 `loop ×3` 그대로(리터럴 단언, **회귀 가드**), 조건 loop은 `조건 반복 · 최대 5`.
- [ ] **Step 2: 실패 확인** — `pnpm test loopLabel Inspector FlowOutline TestFlowChips` → 새 테스트 FAIL.
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인 + 이빨 실증** — `pnpm lint && pnpm test && pnpm build`. 회귀 가드 2개: ① 조건 없는 loop에서도 빈 값을 `undefined`로 커밋하게 바꿔 RED ② `setLoopWhile(undefined)`의 `repeat: 1` 채우기를 빼서 RED(이 경우 Zod 이슈로 모델이 깨지는 것도 확인) — 확인 후 원복.
- [ ] **Step 5: 커밋** — `feat(ui): loop 인스펙터 반복 조건 구역·라벨 (loop-do-while T8)`

---

### Task 9: UI 경고 (US3)

**Files:**
- Create: `ui/src/scenario/condEmptyEval.ts`, `ui/src/scenario/loopWarnings.ts`
- Modify: `ui/src/components/scenario/Inspector.tsx`(반복 조건 구역 안 경고), `FlowOutline.tsx`(행의 주의 아이콘), `ui/src/i18n/ko.ts`(경고 문구 + open-loop think 무시 문구에 한 문장 추가), `crates/engine/src/condition.rs`(연산자 표 테스트만)
- Test: `ui/src/scenario/__tests__/condEmptyEval.test.ts`, `loopWarnings.test.ts`, Inspector·FlowOutline 테스트, `condition.rs` 인라인 테스트

**Interfaces:**
- Consumes: Task 6 모델, 기존 think 판정 헬퍼(`ui/src/scenario/thinkTime.ts`의 `classifyThink` — `{0,0}`을 "없음"으로 보는 규칙을 그대로 쓴다).
- Produces:
  ```ts
  // condEmptyEval.ts
  export type Tri = true | false | "unknown";
  /** 본문 직계 http 스텝이 extract하는 변수 이름 (if 분기 안 스텝 제외) */
  export function directBodyExtractVars(loop: LoopStep | NestedLoopStep): Set<string>;
  /** bodyVars에 든 {{변수}}를 ""로 놓고 조건을 3값 평가. 그 밖의 {{…}}·${…}가 있는 잎은 "unknown" */
  export function condWhenBodyVarsEmpty(cond: Condition, bodyVars: Set<string>): Tri;
  // loopWarnings.ts
  export interface LoopWarnings { noThink: boolean; thinkNotKept: boolean; retryOnFailure: boolean; unlimited: boolean }
  /** while 없는 loop은 전부 false */
  export function loopWarnings(loop: LoopStep | NestedLoopStep, scenarioDefaultThink: ThinkTime | undefined): LoopWarnings;
  ```
- 판정: `noThink` = 본문의 모든 http 스텝(if 분기 안 포함)에 유효 think(스텝 값, 없으면 시나리오 기본, `{0,0}`은 없음)가 없음. `thinkNotKept` = `!noThink && keep_think === false`. `retryOnFailure` = `condWhenBodyVarsEmpty(...) === true`. `unlimited` = `repeat === undefined`.
- 잎 평가(양쪽이 리터럴이거나 bodyVars만 든 경우, 왼쪽 렌더 결과를 `l`, 오른쪽을 `r`): `eq` l===r / `ne` l!==r / `contains` l.includes(r) / `matches` `new RegExp(r)`가 던지면 `"unknown"`, 아니면 `.test(l)` / `lt gt lte gte` 양쪽이 유한 숫자로 파싱될 때만 비교, 아니면 false — **빈 문자열·공백만 있는 문자열은 숫자가 아니다**(`Number("")`가 0이므로 `s.trim() !== "" && Number.isFinite(Number(s))`로 판정. 엔진은 `"".parse::<f64>()` 실패) / `exists` l!=="" / `empty` l==="". `all`: 하나라도 false → false, 전부 true → true, 그 외 unknown(빈 그룹 → true). `any`: 하나라도 true → true, 전부 false → false, 그 외 unknown(빈 그룹 → false).
- 화면: 반복 조건 구역 안에 경고를 `Callout`(주의 톤 — 기존 프리미티브 `ui/src/components/ui/`)으로. `noThink`/`thinkNotKept`/`retryOnFailure` 각각 문구 정본의 문장, `unlimited`이고 경고가 하나라도 있으면 그 문장 뒤에 `loopWarnUnlimitedSuffix`를 붙인다. 아웃라인 행에는 경고가 하나라도 있으면 주의 아이콘(`aria-label` = `loopWarnIconAria(이름)`, `title` 동일). 저장·실행 버튼 상태는 바꾸지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `condition.rs` `empty_left_operator_table`: 왼쪽 `{{x}}`(미설정), 오른쪽 `"WAIT"` — eq false / ne true / contains false / matches(`"^$"`) true·matches(`"WAIT"`) false / lt·gt·lte·gte false / exists false / empty true. 오른쪽이 숫자인 줄도 넣는다: `lt "5"` false, `gte "0"` false, `lte "0"` false(빈 문자열은 숫자로 파싱되지 않는다). (엔진 동작을 고정하는 표 — UI 표와 같은 값.)
  - `condEmptyEval.test.ts`: 위 표와 **같은 줄 전부**(숫자 3줄 포함, 리터럴 기대값 — `Number("") === 0` 함정의 **회귀 가드**) + `{{other}} eq WAIT`(bodyVars에 없음) → unknown / `${ENV} eq x` → unknown / `all[true, unknown]` → unknown, `all[false, unknown]` → false, `any[true, unknown]` → true, `any[false, unknown]` → unknown / `matches`에 JS에서 못 여는 패턴(`"(?<=a"` 같은 깨진 패턴) → unknown / `directBodyExtractVars`가 if 분기 안 extract를 제외.
  - `loopWarnings.test.ts`: think 없는 조건 loop → `noThink` / 스텝 think `{0,0}` → `noThink` / 시나리오 기본 think만 있음 → `noThink` false / think 있고 `keep_think:false` → `thinkNotKept` / `{{code}} ne OK`(code는 본문 추출) → `retryOnFailure` true, `{{code}} eq WAIT` → false / `while` 없는 loop → 전부 false.
  - Inspector: `ne OK` + think 없음 + 횟수 비움 loop → 두 경고 문장과 접미 문장이 보인다(문구 정본 리터럴로 단언). think를 넣고 조건을 `eq WAIT`로 바꾼 시나리오에서는 경고 Callout이 없다. 경고가 있는 시나리오도 Zod 검증은 통과한다(`ScenarioModel.safeParse(...).success === true` — 경고는 검증 이슈가 아니라 저장·실행을 막지 않는다).
  - FlowOutline: 경고 있는 loop 행에 `getByLabelText("주문 재시도 반복 조건 주의")`, 없는 행에는 없음.
- [ ] **Step 2: 실패 확인** — `pnpm test condEmptyEval loopWarnings Inspector FlowOutline` FAIL(모듈 없음). `cargo nextest run -p handicap-engine empty_left_operator_table`은 통과해야 한다(엔진 동작 고정 테스트 — 실패하면 UI 표를 엔진 값에 맞춘다).
- [ ] **Step 3: 구현** + `ko.ts`의 open-loop think 무시 문구에 문구 정본의 한 문장 추가(그 문구를 단언하는 기존 테스트가 있으면 같이 갱신: `grep -rn "think time 무시 중" ui/src`).
- [ ] **Step 4: 통과 확인 + 이빨 실증** — `pnpm lint && pnpm test && pnpm build`, `cargo nextest run -p handicap-engine condition`. 회귀 가드: 숫자 판정을 `Number.isFinite(Number(s))`만으로 바꿔 숫자 3줄이 RED인지 확인 후 원복.
- [ ] **Step 5: 커밋** — `feat(ui): 조건 반복 경고 — 쉬지 않는 재시도·실패해도 반복 (loop-do-while T9)`

---

### Task 10: UI 판정 행 소비 — 시험 실행·모니터 화면

**Files:**
- Modify: `ui/src/scenario/chipResults.ts`, `ui/src/components/scenario/TestRunPanel.tsx`, `ui/src/components/monitor/CheckRecordDialog.tsx`, `ui/src/components/monitor/PreviewResult.tsx`, `PanelEditor.tsx`(prop 전달), `ui/src/i18n/ko.ts`
- Create: `ui/src/scenario/loopJudgeMeta.ts`, `ui/src/components/scenario/LoopJudgeRow.tsx`
- Test: 각 파일의 기존 테스트 파일에 추가 + `ui/src/scenario/__tests__/loopJudgeMeta.test.ts`

**Interfaces:**
- Consumes: Task 4 와이어(`kind: "loop"`, `branch: "again"|"done"|"exhausted"`, `loop_index`, `ended_by_loop`).
- Consumes(추가): Task 6이 넣은 `StepKindSchema`의 `"loop"`·`ended_by_loop`.
- Produces: `ui/src/scenario/loopJudgeMeta.ts`의 `export type LoopJudgeMeta = Record<string, { name: string; maxPasses: number | undefined }>`와 `export function loopJudgeMeta(scenario: Scenario): LoopJudgeMeta`(조건 반복 loop만, 최상위와 if 분기 안 포함). 공유 컴포넌트 `LoopJudgeRow`(새 파일 `ui/src/components/scenario/LoopJudgeRow.tsx`): props `{ step: StepTrace; loopName: string; maxPasses: number | undefined }` — 한 줄에 `{loop 이름} · {loopJudgePass(loop_index + 1)} · {again/done/exhausted 문구}`.
- 화면: `TestRunPanel`의 행 분기는 `kind === "if"` → `IfRow`, `"loop"` → `LoopJudgeRow`, 그 외 → `HttpRow`. `trace.ended_by_loop`가 있으면 목록 위에 `endedByLoop(이름)` 안내(주의 톤 Callout). `CheckRecordDialog`·`PreviewResult`도 loop 행을 `LoopJudgeRow`로 그린다(`CheckRecordDialog`의 포커스 인덱스 계산 `kind !== "if"`는 `kind === "http"`로). `chipResults.ts`는 `row.kind === "loop"`이면 건너뛴다(loop id로 칩 결과를 만들지 않는다).
- loop 이름·최대 횟수는 `loopJudgeMeta(scenario)`에서 찾는다. 시험 실행 패널은 에디터의 시나리오로 만든다. 모니터 쪽은 기존 `stepNames`(http 스텝 이름 맵 — 조건 스텝 존재 검사 `c.step_id in stepNames`에도 쓰이므로 **loop을 섞지 않는다**)와 별도로 `loopMeta: LoopJudgeMeta` prop을 새로 내려 준다: `CheckRecordDialog`는 `stepNames`를 만드는 자리에서 같이 만들고, `PreviewResult`는 `PanelEditor`가 넘긴다. 맵에 없으면 이름은 `step_id`, `exhausted` 문구의 횟수는 `loop_index + 1`.

- [ ] **Step 1: 실패하는 테스트 작성**
  - loopJudgeMeta: 최상위 조건 loop·if 분기 안 조건 loop이 이름·최대 횟수와 함께 나오고, `while` 없는 loop과 http 스텝은 없다.
  - chipResults: http 행 2 + loop 행 2 trace → 결과 맵에 loop id 키가 없고 http 스텝 결과는 그대로.
  - TestRunPanel: WAIT·again·WAIT·again·OK·done trace → `1회차`·`2회차`·`3회차`와 `조건이 참 → 다시 실행` 2개·`조건이 거짓 → 다음 스텝` 1개(`getAllByText(...)`의 길이를 리터럴 숫자로) / http 행 수는 3 그대로 / `ended_by_loop` trace → `조건 반복 「주문 재시도」이(가) 최대 횟수까지 풀리지 않아 여기서 끝났습니다.` + `최대 3회 → 이번 반복 종료`.
  - CheckRecordDialog·PreviewResult: loop 행이 든 기록에서 loop 행이 http 행 모양(메서드·URL·상태 칸)으로 그려지지 않고 판정 문구로 보이며, loop **이름**(ULID가 아님)이 찍힌다. 포커스 스텝 인덱스가 loop 행에 걸리지 않는다. 조건 스텝 존재 검사는 loop id를 스텝으로 인정하지 않는다(기존 동작 유지).
- [ ] **Step 2: 실패 확인** — `pnpm test loopJudgeMeta chipResults TestRunPanel CheckRecordDialog PreviewResult` → 새 테스트 FAIL.
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — `pnpm lint && pnpm test && pnpm build`.
- [ ] **Step 5: 커밋** — `feat(ui): 조건 반복 판정 줄 — 시험 실행·모니터 기록 (loop-do-while T10)`

---

### Task 11: 문서 — ADR·매뉴얼·함정 노트

**Files:**
- Create: `docs/adr/0056-conditional-loop.md`(MADR — 결정: loop에 `while`/`keep_think`, 너그러운 추출, `EndIteration`, 전용 대기 설정·사전 조건 while 기각. ADR-0020 확장)
- Modify: 루트 `CLAUDE.md` "알아둘 결정들"에 한 줄(`- **0056** 조건 반복: loop + `while`(do-while) + `keep_think` + 본문 너그러운 추출 + `EndIteration``), `crates/engine/CLAUDE.md`(조건 반복 본문 표지·`repeat: 0` R0·`mark_written` 순서 한 줄씩), `ui/src/scenario/CLAUDE.md`(superRefine 위치·`setLoopWhile(undefined)`의 `repeat: 1` 한 줄), 저장소에 사용자 매뉴얼이 없으므로(확인: `grep -rln "반복(loop)\|loop 스텝" docs --include='*.md' | grep -v superpowers` → 0건) spec이 "매뉴얼에 적는다"고 한 내용은 **ADR-0056의 `## 사용 안내` 절**에 둔다 — 사용 예(대기 응답 재시도), think time 선택, 너그러운 추출의 대가 2가지, 무제한 반복과 VU 감소·도착률 자리, 운영 모니터의 응답 시간 기준·제한 시간. (화면 안 안내는 Task 8·9의 도움말·경고 문구가 맡는다.)

- [ ] **Step 1:** 위 문서 작성.
- [ ] **Step 2:** `just doc-budget` 실행 — FAIL이면 루트에 넣은 줄을 줄인다.
- [ ] **Step 3: 커밋** — `docs: 조건 반복 ADR-0056·매뉴얼·함정 노트 (loop-do-while T11)`

---

## 구현 뒤 게이트 (task 아님 — 파이프라인 4–6단계)

1. `handicap-reviewer` whole-branch 리뷰. 초점: R0(특히 `repeat: 0`, trace JSON, 신뢰도 지문), runner↔trace 규칙 일치(추출 순서·표지 상속), 와이어 1:1(`kind: "loop"`·`ended_by_loop`·YAML 키), "옛 동작의 부수효과에 기대던 소비자"(엄격 추출 실패 = 에러에 기대던 모니터 `REASON_EXTRACT`·신뢰도 판정이 조건 반복 본문에서 달라지는 점).
2. `security-reviewer`(spec §8 — grep 결과와 무관하게 실행).
3. `/live-verify` — spec §7 라이브 표(US1–US3 + §3.2 + R0 대조 + 운영 모니터 + 모든 진입 화면 + 극단값). 실행 전 `cargo build -p handicap-worker`.
4. `/finish-slice` — build-log 단락, roadmap §B 새 블록(spec §9의 연기 항목 전부를 `무엇 · cost-if-wrong · 해소 경로`로), 상태 줄, 현황판에 "2차: 리포트" 다음 작업 등록.
