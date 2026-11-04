# 운영 모니터 점검 묶음(스텝별 칸) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오 1회 실행(로그인 1회)을 여러 칸이 스텝별로 나눠 판정하는 "점검 묶음"과, 확인 못 함·분기 제외 상태, 칸별 스텝 제한 시간, "값 있음" 빈 컨테이너 수정을 넣는다.

**Architecture:** 설정은 `BoardConfig.groups` + `PanelConfig.group_id/step_id`(가산, 기본값 직렬화 생략). 감독자는 칸 대신 *실행 단위*(흐름 전체 칸 1개 / 스텝 칸 묶음)로 task를 돌리고, 스텝 칸 판정은 실행 단위 전체를 한 번에 계산하는 순수 함수(`step_judge::judge_unit`). 엔진은 trace 전용으로 IF 판정 근거(`branch_eval`)와 시간 초과 표지(`timed_out`)를 싣는다(부하 경로 무변경).

**Tech Stack:** Rust(engine·controller, axum, tokio, serde, sqlx), React+TS(Zod, vitest/RTL).

**Spec:** `docs/superpowers/specs/2026-11-04-monitor-step-panels-design.md` (결정 원천 `docs/superpowers/specs/2026-11-04-monitor-step-panels-mockups/00-decisions.md` + 목업 01·02·03 — **목업 밖 화면 금지**, 예외는 `묶음 삭제` 1건)

## Global Constraints

- 기존 보드(묶음 없음)·기존 보드 파일: `config_json`·내보낸 파일 **바이트 동일**, 판정 동작 동일(예외 = Task 1 결함 수정만).
- 새 필드 직렬화 생략: `BoardConfig.groups` 빈 배열이면, `PanelConfig.group_id`/`step_id` `None`이면 키 자체 생략(`skip_serializing_if`).
- 와이어 문자열(정확히): verdict `"upstream_failed"`, `"branch_skipped"` · trace 필드 `branch_eval`, `timed_out` · status 필드 `check_budget_seconds`.
- 시간 상수: 칸 없는 스텝 기본 5초, 칸 없는 스텝 시나리오 값 상한 30초, 흐름 상한 최대 120초, 바깥 여유 +32초(30+2), 첫 회차 전 스텝 칸 예산 152초. 같은 묶음에 같은 스텝을 보는 칸이 둘 이상이면 그 스텝 제한 = 칸들의 **최댓값**, 흐름 상한 합에는 **한 번만**.
- 사유 문구(정확히): `앞 단계 실패` · `{스텝 이름}에서 멈춤` · 대리 원인 칸 상세 `{스텝 이름} · {규칙3 사유}` · `분기 값 없음` · 시간 초과는 기존 `reason_timeout` = `시간 초과({N}초)`(공백 없음) · 분기 제외 큰 줄 `{대상} = {값}`, 작은 줄 `조건 {대상} {기호} {기대} · {IF 이름}`(exists/empty는 `조건 {대상} {기호} · {IF 이름}`), 빈 그룹은 큰 줄 `조건 = 참`/`조건 = 거짓`, 작은 줄 `{IF 이름}`. **새 reason·detail은 전부 `check::shown()`을 거친다**(서식 문자 정리 + 200자 `…` — 기존 조건 사유와 같은 처리).
- 분기 값 보안: `left`/`right` 원문에 `${`가 있으면 엔진이 렌더 값을 **저장하지 않는다**(`None`) → 화면 `(환경 값)`. exists/empty는 값 대신 `left_value`가 비었는지로 `비어 있음`/`값 있음`. 비밀 식별 로직 금지.
- IF 연산 기호: eq `=` · ne `≠` · lt `<` · gt `>` · lte `≤` · gte `≥` · contains `포함` · matches `~` · exists `값 있음` · empty `비어 있음`. 대상 표기: 원문이 정확히 `{{이름}}`이면 `이름`.
- 검증 오류 접두: 묶음 `점검 묶음 {N}: `(N = `panels` 첫 등장 순서 1부터), 칸 `칸 {N}: `(기존).
- 용어: 묶음 밖 칸 = **단독 실행**. 모든 UI 문구 `ko.ts` 경유.
- 저장소 규칙(루트 CLAUDE.md): 커밋은 `git commit -F <파일>`(워크트리 격리 세션은 복합 git 명령 거부), 게이트 판정에 `| tail` 금지·`; echo exit=$?`, `--no-verify` 금지, implementer 커밋은 단일 FOREGROUND(600000ms). `ui/src`를 건드리는 task는 UI 테스트 스텝 필수(tdd-guard). 리포트는 `.superpowers/sdd/`에만. `pnpm test -- X`는 전체 스위트를 돈다(ui/CLAUDE.md) — 느려도 정상.

## Review Focus

1. **실행 중 시나리오 편집으로 한 칸의 스텝이 사라짐** — 그 칸만 `config_error`("응답 시간 기준 스텝 없음"), 나머지 칸은 같은 회차를 정상 판정(Task 5 `missing_step_only_that_panel_config_error`).
2. **반복(loop) 안 IF가 회차마다 다른 값으로 같은 분기를 제외** — 마지막 결정 행의 값으로 표시(Task 5 `if_in_loop_uses_last_decision_row`).
3. **묶음과 단독 실행 칸이 섞인 보드** — 단독 칸 직렬화·실행 무변경(Task 3 `mixed_board_solo_panel_serializes_without_new_keys`, Task 7 `mixed_board_runs_whole_and_unit`).
4. **긴 IF 이름·긴 값·서식 문자(U+202E)가 전시 칸에** — 서버가 `shown()`으로 정리·200자 컷(Task 5 `new_reasons_pass_through_shown`), 화면은 두 줄 `…`·줄 수 불변(Task 8 `blocked_and_skipped_long_text_truncates`) + 라이브 rect 실측.
5. **`parallel` 다른 분기의 에러** — 형제 분기 칸은 `upstream_failed`가 되지 않음(Task 5 `parallel_sibling_error_not_upstream`).

---

### Task 1: "값 있음" 조건이 빈 배열·빈 객체를 비어 있음으로 판정

**Files:**
- Modify: `crates/controller/src/monitor/check.rs` (`actual_value` ~:278, `op_passes` ~:338, `eval_conditions` 실패 사유 분기 ~:431-445)
- Test: 같은 파일 `mod tests`

**Interfaces:** Consumes/Produces 없음(동작 수정만).

- [ ] **Step 1: 실패 테스트** — `cond_not_empty_rejects_empty_containers`(기존 헬퍼 `judge_c`·`t_body`·`cond`). 본문 `{"list":[],"obj":{},"one":[0],"m":{"a":1}}`:
  - `$.list` NotEmpty → `verdict == Fail`, `reason == Some("비어 있음")`; `$.obj` 같음.
  - `$.one`·`$.m` NotEmpty → `Ok`; `$.list` Exists → `Ok`.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller cond_not_empty_rejects_empty_containers` → FAIL.
- [ ] **Step 3: 구현** — Body 분기에서 값이 빈 `Array`/`Object`임을 `Actual::Val`이 알게 하고(예: `empty_container: bool`), NotEmpty는 이를 실패로, 실패 사유는 `text.is_empty() || empty_container`면 `REASON_EMPTY`. 다른 연산·소스 무변경.
- [ ] **Step 4: 통과 확인** — 같은 명령 + `cargo nextest run -p handicap-controller monitor::` PASS.
- [ ] **Step 5: 커밋** — `fix(monitor): 값 있음 조건이 빈 목록·빈 객체를 통과시키던 문제`

---

### Task 2: 엔진 trace에 분기 판정 근거(`branch_eval`)와 시간 초과 표지(`timed_out`)

**Files:**
- Modify: `crates/engine/src/condition.rs`, `crates/engine/src/trace.rs`(`HttpTrace` :59, `StepTrace` :68, If arm :443, Http arm :386), `crates/engine/src/executor.rs`(`execute_step_traced` 에러 반환 :515 send, :552 body), `crates/engine/src/lib.rs`
- Modify: 리터럴 사이트(컴파일러 지시): `crates/engine/src/{trace,executor}.rs`, `crates/controller/src/monitor/{check,record}.rs`
- Modify: `crates/controller/src/monitor/record.rs` `build_record` — 각 행 `branch_eval.clear()`(흐름 변수 폐기 원칙; 이 커밋부터 기록 엔드포인트에 판정 근거가 새지 않게)
- Test: `condition.rs`·`trace.rs`·`record.rs` `mod tests`

**Interfaces:**
- Produces (condition.rs; `lib.rs` `pub use condition::{eval_condition, explain_branches, BranchEval, LeafEval};`):
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
  pub struct LeafEval { pub left: String, pub op: CompareOp, pub right: Option<String>,
                        pub left_value: Option<String>, pub right_value: Option<String>, pub left_unbound: bool }
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
  pub struct BranchEval { pub branch: String, pub passed: bool, pub leaf: Option<LeafEval> }
  pub fn explain_branches(if_step: &IfStep, ctx: &TemplateContext) -> Vec<BranchEval>
  ```
- Produces (trace.rs): `StepTrace.branch_eval: Vec<BranchEval>` `#[serde(default, skip_serializing_if = "Vec::is_empty")]`; `StepTrace.timed_out: bool` `#[serde(default, skip_serializing_if = "std::ops::Not::not")]`; `HttpTrace.timed_out: bool`(평범한 필드 — `HttpTrace`는 serde 파생이 없다).

규칙(스펙 §6.1): `if` 조건 평가 → 거짓이면 `elif`를 순서대로, 참이 나온 데서 멈춤 — 원소 순서·`passed`가 `runner::select_branch`와 같다. 결정 잎: `Compare` = 그 잎 / `all` 거짓 → 처음 거짓 잎, 참 → 첫 잎 / `any` 참 → 처음 참 잎, 거짓 → 첫 잎 / 하위 그룹 재귀 / 빈 그룹 → `None`. `left_value` = `render_lenient` 앞 200자(`chars().take(200)`), **원문에 `${`가 있으면 `None`**. `right_value` = 같은 규칙, exists/empty면 `None`. `left_unbound` = `render_collecting(left)`가 미바인딩 이름을 냈는지. `timed_out` = 두 에러 반환에서 `e.is_timeout()`.

- [ ] **Step 1: 실패 테스트(condition.rs)** —
  - `explain_matches_select_branch_table`: then/elif_0/elif_1/else/none 픽스처마다 `explain_branches`의 첫 `passed==true` 원소의 `branch`(없으면 else/none)가 `runner::select_branch(..).1`과 같음.
  - `deciding_leaf_all_false_is_first_false`(`all:[{{a}} eq 1 참, {{b}} eq 2 거짓, {{c}} eq 3 거짓]` → `leaf.left == "{{b}}"`) · `deciding_leaf_all_true_is_first` · `deciding_leaf_any_true_is_first_true` · `deciding_leaf_any_false_is_first`.
  - `empty_group_has_no_leaf`(`all: []` → `passed: true, leaf: None`).
  - `left_unbound_flag`(`{{missing}} eq x` → `left_unbound: true, left_value: Some("")`; 바인딩되면 false).
  - `env_values_not_stored`(`${RACE} eq true`, env `RACE=secret` → `left_value: None`; `right: "${X}"` → `right_value: None`).
  - `values_capped_at_200_chars`(300자 → `left_value.unwrap().chars().count() == 200`).
- [ ] **Step 2: 실패 테스트(trace.rs·record.rs)** —
  - `if_row_carries_branch_eval`(결정 행 `branch_eval` 비어 있지 않고 마지막 `passed` 원소 branch == 행 `branch`).
  - `http_row_json_has_no_new_keys`(http 행 `to_value`의 `as_object()`에 `"branch_eval"`·`"timed_out"` 없음).
  - `timed_out_on_send_timeout`(wiremock `set_delay(2s)` + 스텝 `timeout_seconds: 1` → `timed_out`, `error.is_some()`).
  - `timed_out_on_body_read_timeout`(테스트 안 `tokio::net::TcpListener`가 헤더 `Content-Length: 100`만 보내고 멈춤 + `timeout_seconds: 1` → `timed_out`, `error`가 `read body:`로 시작).
  - `not_timed_out_on_refused`(닫힌 포트 → `timed_out == false`).
  - record.rs `record_clears_branch_eval`(결정 행 `branch_eval` 있는 trace → 기록의 그 행 비어 있음).
- [ ] **Step 3: 실패 확인** — `cargo nextest run -p handicap-engine` · `cargo nextest run -p handicap-controller record_clears_branch_eval` → 컴파일 에러/FAIL.
- [ ] **Step 4: 구현** — trace.rs If arm에서 `explain_branches(if_step, &ctx)`를 결정 행에 싣는다(분기 선택은 `select_branch` 그대로 — 단일 소스). 부하 경로(`runner.rs` 실행부·`execute_step`) 무변경.
- [ ] **Step 5: 통과 확인** — `cargo nextest run -p handicap-engine -p handicap-controller` PASS, `cargo clippy --workspace --tests -- -D warnings` 0.
- [ ] **Step 6: 커밋** — `feat(engine): trace에 IF 판정 근거와 시간 초과 표지 기록`

---

### Task 3: 설정 모델(점검 묶음)·검증·보드 파일

**Files:**
- Modify: `crates/controller/src/monitor/config.rs`(`PanelConfig` ~:180, `BoardConfig` ~:216, `validate_and_normalize` :416)
- Modify: `crates/controller/src/monitor/board_file.rs`(`first_unknown_key` :165, R6 :346 앞, `board_warnings` ~:410)
- Test: 두 파일 `mod tests`

**Interfaces:**
- Produces (config.rs):
  ```rust
  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)] #[serde(default)]
  pub struct CheckGroup { pub id: String, pub scenario_id: String,
                          pub environment_id: Option<String>, pub interval_seconds: u32 } // Default: interval 10
  // BoardConfig  += #[serde(skip_serializing_if = "Vec::is_empty")] pub groups: Vec<CheckGroup>
  // PanelConfig  += #[serde(skip_serializing_if = "Option::is_none")] pub group_id: Option<String>
  //              += #[serde(skip_serializing_if = "Option::is_none")] pub step_id: Option<String>
  pub fn apply_group_mirror(cfg: &mut BoardConfig)   // 묶음 칸의 scenario_id·environment_id·interval_seconds := 묶음 값
  pub fn normalize_step_panel(p: &mut PanelConfig)   // step_id Some일 때: latency_source := Step{step_id},
                                                      // conditions[*].step_id·display_items[*].step_id := step_id
  ```
- `validate_and_normalize` 순서(기존 검사의 상대 순서 유지):
  1. 보드 이름(기존) → 2. 칸 1~9개(기존) → 3. `groups`를 `panels` 첫 등장 순으로 정렬(칸 없는 묶음은 원래 순서대로 뒤) → 4. 묶음별 검사 → 5. 칸 배치 검사 → 6. `step_id` ULID 검사 → 7. `apply_group_mirror` + 칸마다 `normalize_step_panel` → 8. 칸별 `validate_panel`(기존, 접두 `칸 N:`) → 9. 칸 id 중복(기존) → 10. `record_limit_kb`(기존).
- 오류 문구(정확히): `점검 묶음 {n}: 묶음 id가 올바른 ULID 형식이 아닙니다` · `점검 묶음 {n}: 묶음 id가 중복됩니다` · `점검 묶음 {n}: 시나리오를 선택해야 합니다` · `점검 묶음 {n}: 점검 주기는 1~3600초여야 합니다` · `점검 묶음 {n}: 칸이 없는 점검 묶음입니다` · `칸 {n}: 없는 점검 묶음을 가리킵니다` · `칸 {n}: 같은 점검 묶음의 칸은 붙어 있어야 합니다` · `칸 {n}: 점검 묶음 칸은 볼 스텝을 골라야 합니다` · `칸 {n}: 스텝 id가 올바른 ULID 형식이 아닙니다`.
- board_file: R6 직전에 각 board config에 `apply_group_mirror`. `first_unknown_key`는 정확히 세 경우만 추가 허용 — 보드 `config` 객체 바로 아래 `groups` 값 `[]`, `config.panels[i]` 바로 아래 `group_id`·`step_id` 값 `null`. `board_warnings`: `step_id: Some` 칸은 기존 세 경고(응답 시간 기준·조건·표시) 대신 하나만 — `칸 {n}: 볼 스텝이 시나리오에 없습니다(점검이 설정 오류로 표시됩니다)`.

- [ ] **Step 1: 실패 테스트(config.rs)** —
  - `legacy_config_serializes_without_new_keys`(칸 1개 기본 보드 JSON에 `groups`·`group_id`·`step_id` 키 없음).
  - `mixed_board_solo_panel_serializes_without_new_keys`(Review Focus 3).
  - `groups_sorted_by_first_appearance`(groups `[G2,G1]`, panels `[G1칸,G2칸]` → `groups[0].id == G1`).
  - `mirror_overwrites_member_fields`(칸 사본 `"x"`·묶음 `"S"`·interval 30·env `Some("E")` → 칸 값 모두 묶음 값).
  - `step_panel_normalizes_latency_condition_display_steps`.
  - 오류 표(각 정확한 문자열): 빈 묶음 → `"점검 묶음 1: 칸이 없는 점검 묶음입니다"` · `[G1, solo, G1]` → `"칸 3: 같은 점검 묶음의 칸은 붙어 있어야 합니다"` · 묶음 칸 step 없음 → `"칸 1: 점검 묶음 칸은 볼 스텝을 골라야 합니다"` · 없는 group_id → `"칸 1: 없는 점검 묶음을 가리킵니다"` · interval 0 → `"점검 묶음 1: 점검 주기는 1~3600초여야 합니다"` · 중복 묶음 id → `"점검 묶음 2: 묶음 id가 중복됩니다"` · 조건 있는 칸의 `step_id: "bad"` → `"칸 1: 스텝 id가 올바른 ULID 형식이 아닙니다"`(조건 문구가 아님).
- [ ] **Step 2: 실패 테스트(board_file.rs)** — `import_mirror_applied_before_reference_check` · `explicit_new_defaults_tolerated` · `other_null_unknown_key_still_rejected`(칸 `"foo": null` → 기존 모르는 키 Err) · `bundle_round_trip_with_groups`(**비기본값 픽스처**: 묶음 interval 45·환경 있음·step_id·칸 timeout 7 → 왕복 동일) · `step_panel_single_warning`(스텝 없음 → 경고 정확히 1개, 위 문구).
- [ ] **Step 3: 실패 확인** — `cargo nextest run -p handicap-controller monitor::config monitor::board_file` → FAIL.
- [ ] **Step 4: 구현** — Interfaces대로.
- [ ] **Step 5: 통과 확인** — `cargo nextest run -p handicap-controller` 전체 PASS(기존 보드 파일·검증 테스트 무수정 통과).
- [ ] **Step 6: 커밋** — `feat(monitor): 점검 묶음 설정 모델·검증·보드 파일 왕복`

---

### Task 4: 판정 상태 2종·연속 실패 규칙·기록 본문 공유 구조

**Files:**
- Modify: `crates/controller/src/monitor/check.rs`(`Verdict` :127-133, 새 사유 상수, 가시성)
- Modify: `crates/controller/src/monitor/supervisor.rs`(`consecutive_fail` :69; 기존 테스트의 `rec.trace` 등 접근 :496-500)
- Modify: `crates/controller/src/monitor/record.rs`(`CheckRecord` :31, `build_record` :47; 기존 테스트 ~20곳 `rec.trace/clipped/limit_kb` → `rec.body.*`)
- Test: 각 파일 `mod tests`

**Interfaces:**
- Produces:
  ```rust
  // check.rs
  pub enum Verdict { Ok, Fail, ConfigError, UpstreamFailed, BranchSkipped }   // snake_case
  pub const REASON_UPSTREAM: &str = "앞 단계 실패";
  pub const REASON_BRANCH_VALUE_MISSING: &str = "분기 값 없음";
  pub(crate) fn classify(..) / reason_timeout(..) / eval_conditions(..) / shown(..)   // 가시성만 pub(crate)
  // record.rs
  pub struct RecordBody { pub limit_kb: u32, pub trace: Option<ScenarioTrace>, pub clipped: Vec<Clipped> }
  pub struct CheckRecord { pub at_ms: i64, pub result: CheckResult, pub body: Arc<RecordBody> }
  // CheckRecord: 손으로 쓴 impl Serialize(필수 — serde `rc` feature 없음) → {at_ms, limit_kb, result, trace, clipped}
  pub fn build_record_body(trace: Option<ScenarioTrace>, limit_kb: u32) -> RecordBody   // 가림·자르기·흐름 변수/branch_eval 폐기
  pub fn build_record(result: &CheckResult, trace: Option<ScenarioTrace>, limit_kb: u32) -> CheckRecord // 유지(래퍼)
  ```
- `consecutive_fail`: 최신부터 `Fail`·`ConfigError`인 동안만 센다.

- [ ] **Step 1: 실패 테스트** — `verdict_wire_strings`(`"\"upstream_failed\""`·`"\"branch_skipped\""`) · `consecutive_fail_stops_at_new_states`(`[Fail,Fail,UpstreamFailed]` → `(0,None)`; `[BranchSkipped,Fail,ConfigError]` → `(2,Some(두 번째 at))`) · `shared_body_serializes_per_panel_result`(같은 `Arc<RecordBody>`·다른 result 두 기록 → JSON `result.verdict` 다르고 `trace` 같음). 와이어 키 집합은 기존 `serializes_wire_shape`(record.rs :661)가 계속 지킨다.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller verdict_wire consecutive_fail_stops shared_body` → FAIL.
- [ ] **Step 3: 구현** — Interfaces대로. 새 변형을 매치하는 기존 `match`는 판정 로직 변경 없이 컴파일만 맞춘다. 기존 테스트의 필드 접근은 `rec.body.*`로 기계적 수정.
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller` 전체 PASS.
- [ ] **Step 5: 커밋** — `feat(monitor): 확인 못 함·분기 제외 판정 상태와 공유 기록 구조`

---

### Task 5: 스텝 칸 판정(실행 단위 전체)

**Files:**
- Create: `crates/controller/src/monitor/step_judge.rs`(+ `monitor/mod.rs` `pub mod step_judge;`)
- Test: 같은 파일 `mod tests`

**Interfaces:**
- Consumes: Task 2 `BranchEval`·`LeafEval`·`StepTrace.timed_out`; Task 4 `Verdict`·`REASON_UPSTREAM`·`REASON_BRANCH_VALUE_MISSING`·`classify`·`reason_timeout`·`eval_conditions`·`shown`; 기존 `check::{collect_http_steps, display_values, CheckResult, REASON_LATENCY_STEP_MISSING, REASON_COND_STEP_NOT_RUN, REASON_REQUEST_CAP, REASON_UNBOUND_VAR, MONITOR_MAX_REQUESTS}`.
- Produces:
  ```rust
  pub fn judge_unit(
      scenario: &Scenario,
      panels: &[PanelConfig],               // 실행 단위의 스텝 칸(배열 순서 = 칸 순서), step_id 모두 Some, 정규화됨
      trace: &ScenarioTrace,
      at_ms: i64,
      flow_cap_secs: u32,                   // truncated 사유용
      step_limits: &HashMap<String, u32>,   // http step_id → 유효 요청 제한(초)
  ) -> Vec<CheckResult>                     // panels와 같은 길이·순서, display 채움
  pub(crate) fn if_op_symbol(op: CompareOp) -> &'static str
  ```
- 알고리즘 = 스펙 §5(용어 *스텝 행*·*제외 결정 행*·*앞 구간*·*엔진 수준 실패*, 판정 1–5, 대리 원인 칸) + §6.3 표기. 명시 보충:
  - 규칙 3의 에러 사유 우선순위: `unbound_vars` 비어 있지 않음 → `ConfigError` `REASON_UNBOUND_VAR` / `timed_out` → `reason_timeout(step_limits[step])` / 그 밖 `classify`.
  - `parallel` 소속 판정(비공개 헬퍼)은 http 행과 **IF 결정 행 모두** 대상(앞 구간이 결정 행을 경계로 쓸 수 있으므로).
  - exists/empty 큰 줄 값: `left_value`가 비었으면 `비어 있음`, 아니면 `값 있음`; `left_value: None`(환경 값)이면 `(환경 값)`.
  - 계산 순서: 원인 칸의 판정은 그 칸 자신의 앞 구간만 보므로 원인 행의 trace 순서대로 계산(순환 없음).
  - 모든 새 reason/detail은 `shown()` 통과.

- [ ] **Step 1: 실패 테스트(표)** — 시나리오 픽스처 `L1 → L2 → B(isRaceDay 추출) → IF "경마일 분기"({{isRaceDay}} eq true){ H, P }`, trace는 손으로 만든 `StepTrace` 목록(`check.rs` 테스트 헬퍼 `st`·`resp` 패턴 복제). 각 단언:
  - `all_ok`: 5칸 `Ok`, `latency_ms` = 각 행 응답 ms.
  - `upstream_error_greys_later_panels`: L2 행 error + 응답 503 + assert → L2 `Fail` `"HTTP 503"`, B·H·P `UpstreamFailed` reason `"앞 단계 실패"` detail `"L2에서 멈춤"`, L1 `Ok`.
  - `cause_without_panel_stand_in`: L1 칸 없음, L1 행 error(응답 없음) → 칸 순서 첫 칸 L2 `Fail` reason `"앞 단계 실패"` detail `"L1 · 요청 실패"`, 나머지 `UpstreamFailed`.
  - `stand_in_timeout_reason`: L1 행 `timed_out`, `step_limits[L1]=5` → detail `"L1 · 시간 초과(5초)"`.
  - `stand_in_unbound_is_config_error`: 원인 행 `unbound_vars` 있음 → 대리 칸 `ConfigError`.
  - `loop_last_iteration_success_uses_stand_in`: 원인 스텝 칸 있음, 반복 첫 행 에러·마지막 행 성공(그 칸 `Ok`) → 다음 칸 대리 `Fail`.
  - `condition_failure_upstream_does_not_grey`: L1 칸 조건 실패(엔진 에러 없음) → L1 `Fail`, L2 `Ok`.
  - `own_timeout`: H 행 `timed_out`, `step_limits[H]=3` → H `Fail` `"시간 초과(3초)"`, P `UpstreamFailed` `"H에서 멈춤"`.
  - `branch_skipped_shows_value`: 결정 행 `none`, `branch_eval=[{then, false, leaf{left "{{isRaceDay}}", Eq, right "true", left_value Some("false")}}]` → H·P `BranchSkipped`, reason `"isRaceDay = false"`, detail `"조건 isRaceDay = true · 경마일 분기"`, `latency_ms None`.
  - `branch_after_error_not_upstream`: 결정 행 **뒤**의 다른 http 행 에러 → H·P 여전히 `BranchSkipped`.
  - `branch_value_missing`: leaf `left_unbound: true`, Eq → H `Fail` `"분기 값 없음"`, detail `"경마일 분기"`.
  - `branch_exists_op_unbound_is_skip`: Exists, `left_unbound`, `left_value Some("")` → `BranchSkipped` reason `"isRaceDay = 비어 있음"`.
  - `env_value_hidden`: leaf left `"${RACE}"`, `left_value None` → reason `"${RACE} = (환경 값)"`.
  - `preempted_by_earlier_branch`: 스텝이 `elif_0` 안, 결정 `then`(then passed, leaf `{{a}} eq 1`, left_value `"1"`) → reason `"a = 1"`, detail `"조건 a = 1 · 경마일 분기"`.
  - `empty_group_reason`: leaf None·passed false → reason `"조건 = 거짓"`, detail `"경마일 분기"`.
  - `if_in_loop_uses_last_decision_row`(Review Focus 2): 반복 2회, H 한 번도 안 탐, 결정 행 `none`(left_value `"x"`) → `none`(left_value `"y"`) → reason `"isRaceDay = y"`. 같은 테스트 안 보조 케이스: 첫 회차 `then`(H 행 성공)·둘째 `none` → H `Ok`(규칙 3 우선).
  - `parallel_sibling_error_not_upstream`(Review Focus 5): parallel 분기 a(Ea 에러)·b(Eb 정상) → Eb 칸 `Ok`.
  - `missing_step_only_that_panel_config_error`(Review Focus 1): 한 칸 step_id 없음 → 그 칸 `ConfigError` `"응답 시간 기준 스텝 없음"`, 나머지 정상.
  - `truncated_not_run_reason`: truncated·미실행·앞 에러 없음 → `Fail` `"시간 초과(21초)"`(flow_cap 21); http 행 수 ≥ `MONITOR_MAX_REQUESTS`면 `REASON_REQUEST_CAP`.
  - `skip_beats_truncated`: truncated여도 제외 결정 행 있으면 `BranchSkipped`.
  - `new_reasons_pass_through_shown`(Review Focus 4): left_value에 U+202E·300자 → reason에 U+202E 없음, `chars().count()`가 `shown()` 상한 이하이며 `…`로 끝남.
  - `if_op_symbols`: 10개 연산 → 표의 기호.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller step_judge` → 컴파일 에러.
- [ ] **Step 3: 구현** — `judge_unit`·비공개 트리 헬퍼(IF 조상 체인 `(IfStep, 분기 라벨)` 바깥→안, `parallel` 조상 `(parallel id, 분기 인덱스)`). 규칙 3은 기존 `classify`·`eval_conditions`·`display_values` 재사용(복제 금지).
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS + `cargo clippy -p handicap-controller --tests -- -D warnings` 0.
- [ ] **Step 5: 커밋** — `feat(monitor): 스텝 칸 판정 — 앞 단계 실패·분기 제외·대리 원인 칸`

---

### Task 6: 실행 단위 계획·스텝 제한·단위 점검 실행

**Files:**
- Create: `crates/controller/src/monitor/unit.rs`(+ `mod.rs`)
- Test: 같은 파일 `mod tests`

**Interfaces:**
- Consumes: Task 3 `CheckGroup`·`group_id`·`step_id`; Task 5 `judge_unit`; 기존 `check::{reason_timeout, MONITOR_MAX_REQUESTS, REASON_SCENARIO_MISSING, REASON_SCENARIO_INVALID, REASON_ENV_MISSING}`, `handicap_engine::{trace_scenario, TraceOptions}`.
- Produces:
  ```rust
  pub const UNPANELED_STEP_TIMEOUT_SECS: u32 = 5;
  pub const STEP_TIMEOUT_MAX_SECS: u32 = 30;
  pub const FLOW_CAP_MAX_SECS: u32 = 120;
  pub const OUTER_GRACE_SECS: u32 = 32;
  pub const INITIAL_STEP_BUDGET_SECS: u32 = 152;
  pub struct CheckUnit { pub scenario_id: String, pub environment_id: Option<String>,
                         pub interval_seconds: u32, pub panels: Vec<PanelConfig> }
  pub enum UnitPlan { Whole(PanelConfig), Steps(CheckUnit) }
  pub fn plan_units(cfg: &BoardConfig) -> Vec<UnitPlan>   // 칸 순서대로: 묶음→Steps(소속 칸), 단독 step 칸→Steps(1칸), 나머지→Whole
  pub fn apply_step_limits(sc: &mut Scenario, unit: &CheckUnit) -> (u32 /*flow_cap*/, HashMap<String, u32>)
  pub fn outer_timeout_results(n: usize, at_ms: i64, flow_cap: u32) -> Vec<CheckResult> // 모두 Fail reason_timeout(flow_cap)
  pub struct UnitOutcome { pub trace: Option<ScenarioTrace>, pub results: Vec<CheckResult>, pub budget_secs: u32 }
  pub async fn run_unit_check(db: &Db, unit: &CheckUnit) -> UnitOutcome
  ```
  `apply_step_limits`: 칸 있는 스텝 = 그 스텝을 보는 칸들의 `timeout_seconds` **최댓값**, 칸 없는 http 스텝 = `min(시나리오 값, 30)` 또는 5 → `HttpStep.timeout_seconds`에 기록; flow_cap = 정의상 http 스텝(중복 없이) 유효 제한 합의 `min(…, 120)`. `run_unit_check`: DB에서 시나리오·환경 재조회(실패 시 모든 칸 `ConfigError` + 기존 사유, budget 152), `TraceOptions{env, max_requests: MONITOR_MAX_REQUESTS, max_wall: flow_cap, apply_think_time: false}`, 바깥 `tokio::time::timeout(flow_cap + 32)` 초과 시 `outer_timeout_results`. 정상 → `judge_unit(..)`. `budget_secs = flow_cap + 32`. 모든 결과 같은 `at_ms`.

- [ ] **Step 1: 실패 테스트** —
  - `plan_units_mixed`: 묶음(칸 2) + 단독 흐름 칸 + 단독 step 칸 → `[Steps(2칸), Whole, Steps(1칸)]`.
  - `step_limits_table`: 칸 있는 스텝 3·3, 칸 없는 스텝(시나리오 600) → 30, 칸 없는 스텝(값 없음) → 5 → flow_cap 41; 합 200 → 120; 같은 스텝을 보는 칸 둘(3·7) → 그 스텝 7, 합에 한 번.
  - `outer_timeout_results_all_fail`: `(3, 100, 41)` → 3개 모두 `Fail`, reason `"시간 초과(41초)"`, `at_ms 100`.
  - `run_unit_check_one_trace_per_round`(US1): wiremock `/login1`·`/login2`·`/race` 각 `.expect(1)`, 3칸 묶음 1회 → 결과 3개 `Ok`, 같은 `at_ms`, `budget_secs == flow_cap + 32`(서버 drop 시 verify).
  - `run_unit_check_missing_scenario`: 없는 시나리오 → 모든 칸 `ConfigError` `"시나리오를 찾을 수 없음"`.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller monitor::unit` → 컴파일 에러.
- [ ] **Step 3: 구현** — Interfaces대로.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS + clippy 0.
- [ ] **Step 5: 커밋** — `feat(monitor): 점검 묶음 실행 단위 — 스텝 제한·흐름 상한·단위 점검`

---

### Task 7: 감독자 실행 단위 루프·상태 예산·미리 실행 + ADR-0053 보완

**Files:**
- Modify: `crates/controller/src/monitor/supervisor.rs`(`PanelBuf` :44, `PanelSnapshot` :62, `RunningGuard` :83-122, `panel_loop` :131, `reconcile_slot` :287, `spawn_panel` :391)
- Modify: `crates/controller/src/api/monitor_boards.rs`(`PanelStatus` :50, `build_panel_status` ~:101, `preview_check` ~:278)
- Modify: `docs/adr/0053-*.md`(보완 절)
- Test: `supervisor.rs`·`monitor_boards.rs` `mod tests`(순수), `crates/controller/tests/monitor_boards_api_test.rs`(미리 실행 2건 — 기존 `make_app`·`create_scenario`·`preview_check_returns_trace_and_result` :318 패턴)

**Interfaces:**
- Consumes: Task 4 `RecordBody`·`build_record_body`·`CheckRecord{body}`; Task 6 `plan_units`·`UnitPlan`·`CheckUnit`·`run_unit_check`·`INITIAL_STEP_BUDGET_SECS`; Task 3 `normalize_step_panel`.
- Produces:
  - `PanelBuf.budget_secs: u32`, `PanelSnapshot.budget_secs: u32`.
  - `pub(crate) async fn unit_loop<F, Fut>(interval: Duration, members: Vec<(SharedBuf, usize /*bar_count*/)>, check: F, token: CancellationToken)` where `Fut: Future<Output = (Vec<(CheckResult, Arc<CheckRecord>)>, u32 /*budget_secs*/)>` — members 순서대로 `running` on/off·push·`budget_secs` 저장. 프로덕션은 `Whole`·`Steps` 모두 `unit_loop`를 직접 쓴다. 기존 `panel_loop`는 `#[cfg(test)]`로 내려 member 1개짜리 래퍼(check 결과에 budget 0을 붙여 `unit_loop` 호출)로 남긴다 — 기존 테스트 :536-723 무수정 통과, 비-테스트 빌드의 `dead_code` 경고 없음(pre-commit `clippy --all-targets -D warnings`).
  - 감독자는 `plan_units` 결과마다 task 1개: `Whole` = 기존 `run_check`+`build_record`(budget = `timeout_seconds`), `Steps` = `run_unit_check` → `build_record_body` 1회 → 칸마다 `CheckRecord{at_ms, result, body: Arc::clone}`. 세마포어 허가는 단위당 1개.
  - `reconcile_slot`: 살아남은 칸 버퍼 유지 + `budget_secs`를 초기값(스텝 칸 152, 흐름 칸 `timeout_seconds`)으로 재설정.
  - `PanelStatus.check_budget_seconds: u32`(스냅샷 값, 스냅샷 없으면 초기값).
  - `preview_check`: `normalize_step_panel(&mut panel)` → `validate_panel` → `step_id.is_some()`면 `CheckUnit{panels: vec![panel]}`로 `run_unit_check` → `PreviewResponse{trace, result: results[0]}`, 아니면 기존 경로.
- ADR-0053 `## 보완 — 점검 묶음 (2026-11-04)`: 실행 단위(묶음 trace 1회 공유)·상태 2종·칸별 스텝 제한(묶음 흐름 상한 최대 120초 — 1–30 상한은 흐름 전체 칸에만)·`check_budget_seconds`·분기 값 노출 규칙(`${}` 값 미저장 → `(환경 값)`) 4–6줄.

- [ ] **Step 1: 실패 테스트** —
  - `unit_loop_pushes_all_members_same_at`: 가짜 check(카운터) member 2개 → 1회차 후 두 버퍼 `results.len()==1`, 같은 `at_ms`, 카운터 1, `budget_secs` 저장.
  - `mixed_board_runs_whole_and_unit`(Review Focus 3): **묶음 칸 2개** + 흐름 칸 1개 보드 reconcile → `live_task_count == 2`(칸별이면 3).
  - `reconcile_resets_budget`: budget 41 버퍼 → reconcile 직후 스냅샷 `budget_secs == 152`, 결과는 유지.
  - `status_check_budget_seconds`: 스냅샷 없음 → 스텝 칸 152 / 흐름 칸 `timeout_seconds`; 스냅샷 있으면 그 값.
  - `record_lookup_group_member`: 같은 회차 `at_ms`로 두 칸 `record()` → 둘 다 Some, 각자 result, `Arc::ptr_eq(&a.body, &b.body)`.
  - `preview_step_panel_uses_unit_path`: 2스텝 시나리오(L1 503 + assert, L2 정상), 칸이 L2를 봄(L1 칸 없음) → `result.verdict == Fail`, reason `"앞 단계 실패"`, detail이 `"L1 · "`로 시작(옛 경로면 L2 기준으로 이 문구가 나올 수 없음).
  - `preview_step_panel_with_condition_ok`: 조건 1개(step_id 빈 문자열)인 step 칸 미리 실행 → 400 아님(정규화가 validate 앞).
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller monitor::supervisor api::monitor_boards preview_step_panel` → FAIL.
- [ ] **Step 3: 구현** — Interfaces대로. 흐름 전체 칸의 타이밍·기록·사유 바이트 동일.
- [ ] **Step 4: ADR 보완 절 작성.**
- [ ] **Step 5: 통과 확인** — `cargo nextest run -p handicap-controller` 전체 PASS + `cargo clippy --workspace --tests -- -D warnings` 0.
- [ ] **Step 6: 커밋** — `feat(monitor): 감독자 실행 단위 루프·상태 예산·스텝 칸 미리 실행`

---

### Task 8: UI 와이어·전시 화면 새 상태(목업 03)·기록 창

**Files:**
- Modify: `ui/src/api/monitors.ts`(`PanelConfigSchema` :63, `BoardConfigSchema` :82, `CheckResultSchema` :92, `PanelStatusSchema` :125, 머리 주석 :8-10)
- Modify: `ui/src/monitor/logic.ts`(`PanelState` :12, `staleAfterMs` :35, `panelState` :39, `bigValueText` ~:148)
- Modify: `ui/src/monitor/display.ts`(`fillBackground` ~:230 exhaustive switch, `STATE_LABEL` ~:265, 테두리/상태 색)
- Modify: `ui/src/components/monitor/MonitorPanel.tsx`, `LatencyBars.tsx`, `StripCard.tsx`(C 작은 카드·탐침의 최장 라벨 가정), `PreviewResult.tsx`(`VERDICT_LABEL` :16), `CheckRecordDialog.tsx`(`VERDICT_LABEL`/`VERDICT_CLASS` :19-27, 스텝 행 `defaultOpen`)
- Modify: `ui/src/pages/MonitorDisplayPage.tsx`(:255-275 `panelState` 호출, 기록 창 열기), `ui/src/i18n/ko.ts`
- Modify(픽스처): `check_budget_seconds`가 필수가 되므로 status 픽스처 전부 — `ui/src/api/__tests__/monitors.test.ts`, `ui/src/pages/__tests__/MonitorDisplayPage.test.tsx`, `ui/src/pages/__tests__/MonitorDisplayPage.fullscreen.test.tsx`(grep `consecutive_fail`로 전수)
- Test: 위 + `ui/src/monitor/__tests__/logic.test.ts`, `ui/src/components/monitor/__tests__/{LatencyBars,CheckRecordDialog,PreviewResult}.test.tsx`

**Interfaces:**
- Produces (monitors.ts):
  ```ts
  export const CheckGroupSchema = z.object({ id: z.string(), scenario_id: z.string(),
    environment_id: z.string().nullable(), interval_seconds: z.number().int() });
  export type CheckGroup = z.infer<typeof CheckGroupSchema>;
  // PanelConfigSchema += group_id: z.string().optional(), step_id: z.string().optional()
  // BoardConfigSchema += groups: z.array(CheckGroupSchema).optional()
  // CheckResultSchema.verdict = z.enum(["ok","fail","config_error","upstream_failed","branch_skipped"])
  // PanelStatusSchema += check_budget_seconds: z.number().int()
  ```
  머리 주석에 "groups·group_id·step_id만 서버가 기본값을 생략 → `.optional()`" 예외 한 줄.
- Produces (logic.ts): `PanelState` += `"blocked" | "skipped"`; `staleAfterMs(intervalSec, budgetSec)`; `panelState` 인자 `timeoutSec` → `budgetSec`(호출부: `status.check_budget_seconds`, 상태 항목 없으면 칸 `timeout_seconds`). 매핑 `upstream_failed`→`blocked`, `branch_skipped`→`skipped`, `stale` 검사 뒤·`slow` 앞.
- ko.ts: `stateBlocked: "― 확인 못 함"`, `stateSkipped: "○ 분기 제외"`, `verdictUpstreamFailed: "확인 못 함"`, `verdictBranchSkipped: "분기 제외"`.
- `CheckRecordDialog` prop `focusStepId?: string` — 그 `step_id`의 **마지막** http 행만 `defaultOpen`(없으면 기존 규칙). `MonitorDisplayPage`가 칸 `step_id`를 넘긴다.
- 렌더(목업 03): B = blocked 실선 회색 테두리·흐린 글자, 큰 줄 `reason`·작은 줄 `detail` / skipped 점선 회색 테두리·값 밝게, 같은 두 줄. A(fill) = 회색 배경 계열. C = 작은 카드(`focusLayout` 무변경), `StripCard` 탐침이 새 라벨 길이를 덮게. 깜빡임·`N회 연속` 없음. LatencyBars: 기존 `data-verdict` 관례로 `data-verdict="upstream_failed"` 회색 낮은 막대(높이 12%), `data-verdict="branch_skipped"` 막대 없이 바닥 작은 ○.

- [ ] **Step 1: 픽스처 갱신** — status 픽스처 전부에 `check_budget_seconds` 추가 + 기존 `logic.test.ts`의 `panelState({… timeoutSec …})` 호출을 `budgetSec`로(기존 테스트가 새 필수 필드·인자명으로 깨지지 않게 — 동작 단언 무변경).
- [ ] **Step 2: 실패 테스트** —
  - monitors.test `schema_optional_group_fields`: 세 필드 없는 보드 parse OK, 있는 보드 값 보존, `check_budget_seconds` 없는 status는 parse 실패.
  - logic.test `panelState_new_states`(verdict → `"blocked"`/`"skipped"`, 임계 넘는 latency여도 `slow` 아님) · `stale_uses_budget`(interval 10·budget 53·46초 전 → 비-stale(구 공식 timeout 3이면 stale) / 89초 전 → `stale`).
  - LatencyBars.test `blocked_and_skipped_bars`(`[data-verdict="upstream_failed"]` 요소 1·`[data-verdict="branch_skipped"]` ○ 요소 1).
  - MonitorDisplayPage.test `blocked_panel_no_blink_no_consecutive` · `skipped_panel_shows_value_lines`(`isRaceDay = false`·`조건 isRaceDay = true · 경마일 분기`) · `blocked_and_skipped_long_text_truncates`(200자 reason/detail → 두 줄 요소가 기존 `…` 규칙 컴포넌트/클래스, 줄 수 2) · `fill_style_blocked_gray`(A 방식 배경이 회색 계열 클래스/스타일).
  - CheckRecordDialog.test `focus_step_open`(그 행만 `aria-expanded="true"`) · PreviewResult.test `branch_skipped_label`(`분기 제외`).
- [ ] **Step 3: 실패 확인** — `cd ui && pnpm test` → 새 테스트 FAIL.
- [ ] **Step 4: 구현** — Interfaces·목업 03대로. 배율: 새 상태 글줄이 기존 탐침(`FocusProbes`/`useScaleSearch`)으로 덮이는지 확인, 아니면 탐침에 포함.
- [ ] **Step 5: 통과 확인** — `cd ui && pnpm lint && pnpm test && pnpm build; echo exit=$?` → 0.
- [ ] **Step 6: 커밋** — `feat(monitor-ui): 확인 못 함·분기 제외 칸 표시와 기록 창 스텝 펼침`

---

### Task 9: UI 설정 순수 헬퍼 — 묶음 조작·칸 목록 구획·스텝 선택지·오류·요약

**Files:**
- Create: `ui/src/monitor/groups.ts`
- Modify: `ui/src/monitor/panelErrors.ts`, `ui/src/monitor/panelSummary.ts`
- Test: `ui/src/monitor/__tests__/groups.test.ts`(신규), `panelErrors.test.ts`, `panelSummary.test.ts`

**Interfaces:**
- Consumes: Task 8 `CheckGroup`·optional 필드; `newStepId()`(`ui/src/scenario/ulid.ts`), `newPanel()`(`ui/src/api/monitors.ts`), 시나리오 모델 타입(`parseScenarioDoc(..).model.steps`, PanelEditor :82와 같은 출처).
- Produces (groups.ts):
  ```ts
  export function normalizeForCompare(cfg: BoardConfig): BoardConfig   // 빈 groups 키·undefined group_id/step_id 제거
  export type NavSegment = { groupId: string | null; indices: number[] };
  export function navSegments(panels: PanelConfig[]): NavSegment[]
  export function addGroup(cfg: BoardConfig): { cfg: BoardConfig; groupId: string; panelId: string } // 끝에 빈 묶음+빈 스텝 칸
  export function addPanelToGroup(cfg: BoardConfig, groupId: string): { cfg: BoardConfig; panelId: string } // 묶음 마지막 칸 뒤, 묶음 값 미러
  export function updateGroup(cfg: BoardConfig, next: CheckGroup): BoardConfig  // 소속 칸 scenario/env/interval 미러
  export function setPanelStep(p: PanelConfig, stepId: string): PanelConfig     // step_id + 조건·표시 값 step_id 동기화
  export function removePanel(cfg: BoardConfig, index: number): BoardConfig    // 묶음 마지막 칸이면 묶음도 제거
  export function removeGroup(cfg: BoardConfig, groupId: string): BoardConfig  // 소속 칸 함께
  // removePanel·removeGroup은 마지막 묶음을 지워도 `groups: []`를 남긴다(키 삭제 안 함) — 정리는 normalizeForCompare 몫
  export function groupNumber(cfg: BoardConfig, groupId: string): number       // panels 첫 등장 순 1부터
  export function withMirror(p: PanelConfig, g: CheckGroup): PanelConfig        // 미리 실행 요청: 미러 채움, group_id 키 생략
  export type StepOption = { id: string; name: string; branchHint: string | null };
  export function stepOptionsFor(steps: ReadonlyArray<Step>): StepOption[]   // Step = ui/src/scenario/model.ts:273 // http 스텝 전부(loop/parallel/if 재귀), 가장 안쪽 IF 이름 = branchHint
  ```
- `parseGroupError(message: string): { groupNumber: number; reason: string } | null` — `/^점검 묶음 (\d+): (.+)$/s`.
- `panelSummary(p, scenarioName, opts?: { solo?: boolean; stepName?: string })` — `solo`면 `단독 실행 · {기존} · 시나리오 전체`; `stepName`이면 `스텝: {이름} · 제한 {N}초 · 조건 {N}`; opts 없으면 기존 문자열 그대로.

- [ ] **Step 1: 실패 테스트** — groups.test: `navSegments_groups_contiguous`(`[g1,g1,solo,g2]` → `[{g1,[0,1]},{null,[2]},{g2,[3]}]`) · `addGroup_appends_group_and_step_panel` · `addPanelToGroup_inserts_after_last_member_with_mirror` · `updateGroup_mirrors_members` · `setPanelStep_syncs_conditions_and_display` · `removePanel_last_member_removes_group` · `removeGroup_removes_members`(마지막 묶음 삭제 후 `cfg.groups`가 `[]`로 남음 — `"groups" in cfg`) · `groupNumber_first_appearance` · `normalizeForCompare_add_then_remove_group_equal`(원본 vs addGroup→removeGroup 결과 `JSON.stringify` 같음) · `withMirror_fills_and_omits_group_id`(`!("group_id" in r)`) · `stepOptionsFor_nested_if_hint`(loop 안 if 안 스텝 → `branchHint` = 그 IF 이름, 밖 스텝 → null). panelErrors.test `parseGroupError`(`"점검 묶음 2: 칸이 없는 점검 묶음입니다"` → `{2, "칸이 없는 점검 묶음입니다"}`; `"칸 1: x"` → null). panelSummary.test(`solo`·`stepName`·기본 3형태).
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test` → 새 테스트 FAIL.
- [ ] **Step 3: 구현** — Interfaces대로.
- [ ] **Step 4: 통과 확인** — `cd ui && pnpm lint && pnpm test && pnpm build; echo exit=$?` → 0.
- [ ] **Step 5: 커밋** — `feat(monitor-ui): 점검 묶음 설정 헬퍼`

---

### Task 10: UI 설정 화면 — 묶음 상자·칸 목록 상자·스텝 칸(목업 01 A·02 1안)

**Files:**
- Create: `ui/src/components/monitor/GroupBox.tsx`
- Modify: `ui/src/pages/MonitorEditPage.tsx`(dirty 기준선 :89, 오류 펼침 :168-185, `valid()` :192, 칸 목록 :433-475)
- Modify: `ui/src/components/monitor/PanelEditor.tsx`(props :27, 스텝 모드, 조건 스텝 경고 :446·:505), `PanelNav.tsx`, `PreviewResult.tsx`(추가 버튼 제한), `ui/src/i18n/ko.ts`
- Test: `ui/src/pages/__tests__/MonitorEditPage.test.tsx`, `ui/src/components/monitor/__tests__/{PanelNav,PreviewResult}.test.tsx`

**Interfaces:**
- Consumes: Task 9 헬퍼 전부·`parseGroupError`·`panelSummary` opts; Task 8 스키마.
- `PanelEditor` += `group?: CheckGroup`, `stepOptions?: StepOption[]`: `group`이 있으면 시나리오·환경·점검 주기·응답 시간 기준 입력 숨김, `볼 스텝` select(라벨 `이름` + branchHint면 ` (<IF 이름> 분기 안)`, 변경 시 `setPanelStep`), 조건/표시 값 추가는 `step_id := panel.step_id`, 스텝이 `stepOptions`에 없으면 `stepMissingInScenario` 경고, 미리 실행 요청은 `withMirror(panel, group)`. `stepOptions`는 페이지가 묶음 시나리오 YAML로 `stepOptionsFor` 계산.
- `PreviewResult` += `onlyStepId?: string` — 주어지면 그 스텝 행에만 조건/표시 추가 버튼.
- `GroupBox` props `{ group, number, scenarios, environments, expanded, error?, canRemove, canAddPanel, onToggle, onChange(next: CheckGroup), onAddPanel, onRemove, children }` — 머리 `점검 묶음 {n}` · 시나리오 이름 · 환경 · `{s}초마다 한 번 실행` · `칸 {k}`, 상자 안 시나리오·환경·주기 입력, `+ 이 묶음에 칸 추가`(9칸이면 비활성), `묶음 삭제`(canRemove=false면 비활성 — 남는 칸이 0개가 되는 경우).
- `MonitorEditPage`: 칸 목록을 `navSegments`로 렌더(묶음 구획 = `GroupBox` 안에 `PanelEditor`들), 끝 버튼 `+ 칸 추가 (단독 실행)`·`+ 점검 묶음 추가 (스텝 골라 칸 여러 개)`(9칸이면 둘 다 비활성). `valid()`: 묶음 칸은 칸 대신 **묶음** `scenario_id`를 검사해 빈 묶음 상자를 펼치고 오류 표시, 단독 칸은 기존 규칙. dirty 기준선·현재 비교 모두 `normalizeForCompare`. 서버 오류 `parseGroupError` → 그 묶음 상자 펼침. 보드에 묶음이 있으면 단독 칸 요약에 `solo: true`.
- PanelNav: `navSegments`대로 묶음은 연한 상자(머리 `시나리오 이름 · {s}초`), 번호는 `i + 1` 그대로.
- ko.ts(목업 문구): `groupTitle: (n) => \`점검 묶음 ${n}\``, `groupRunsEvery: (s) => \`${s}초마다 한 번 실행\``, `groupAddPanel: "+ 이 묶음에 칸 추가"`, `addSoloPanel: "+ 칸 추가 (단독 실행)"`, `addGroup: "+ 점검 묶음 추가 (스텝 골라 칸 여러 개)"`, `removeGroup: "묶음 삭제"`, `stepPick: "볼 스텝"`, `stepBranchHint: (name) => \`(${name} 분기 안)\``, `soloPrefix: "단독 실행"`, `wholeScenario: "시나리오 전체"`, `stepMissingInScenario: "이 스텝이 시나리오에 없습니다"`, 칸 도움말 한 줄 `분기에 따라 달라지는 스텝은 점검 묶음 칸으로 보세요`, 조건 라벨 기존 키 값 → `값 있음 (null·빈값·빈 목록 아님)`(스펙 §7).

- [ ] **Step 1: 실패 테스트** — MonitorEditPage.test:
  - `add_then_remove_group_not_dirty`: 묶음 없는 보드 열기 → `+ 점검 묶음 추가` → `묶음 삭제` → 저장 버튼 비활성/dirty 아님(`normalizeForCompare` 제거 시 RED가 나는지 Step 3에서 실증).
  - `add_group_shows_box_and_buttons`: `점검 묶음 1` 머리·상자 안 시나리오 select·`+ 이 묶음에 칸 추가`·`묶음 삭제` 보임; 스텝 칸에 점검 주기 입력 없음.
  - `step_select_marks_branch_steps`: IF 안 스텝 옵션 라벨에 `(경마일 분기 안)`.
  - `save_group_board_payload`: 묶음 시나리오 선택·스텝 선택 후 저장 → 클라 검증 통과(scenarioRequired 미표시), 요청 본문 `config.groups.length === 1`, 칸 `group_id`·`step_id`·미러 `scenario_id` 설정.
  - `group_without_scenario_blocks_save`: 묶음 시나리오 비움 → 저장 안 됨, 묶음 상자 펼침·오류.
  - `group_error_expands_box`: 서버 400 `"점검 묶음 1: 칸이 없는 점검 묶음입니다"` → 그 상자 펼침·문구.
  - `remove_group_disabled_when_last`: 묶음 칸만 있는 보드 → `묶음 삭제` 비활성.
  - `condition_added_on_step_panel_uses_panel_step`: 미리 실행 결과에서 조건 추가 → 조건 `step_id === panel.step_id`.
  - PanelNav.test `nav_boxes_group_with_continuous_numbers`(1·2 한 상자 머리 `더비온 흐름 · 10초`, 3은 밖, 번호 1·2·3).
  - PreviewResult.test `only_step_id_limits_add_buttons`(다른 스텝 행엔 추가 버튼 없음).
  - `step_missing_after_group_scenario_change_warns`: 스텝을 고른 묶음 칸 → 묶음 시나리오를 그 스텝이 없는 것으로 변경 → 칸에 `이 스텝이 시나리오에 없습니다`, 저장은 막지 않음.
  - `help_line_for_branch_steps`: `ko.monitor`의 도움말 키 값이 `분기에 따라 달라지는 스텝은 점검 묶음 칸으로 보세요`이고 칸 편집기 도움말에 렌더됨.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test` → 새 테스트 FAIL.
- [ ] **Step 3: 구현 + 이빨 실증** — Interfaces·목업 01 A·02 1안대로(목업 밖 요소 금지, 예외 `묶음 삭제`). 구현 후 `normalizeForCompare` 호출을 잠시 빼서 `add_then_remove_group_not_dirty`가 RED가 되는지 확인하고 원복.
- [ ] **Step 4: 통과 확인** — `cd ui && pnpm lint && pnpm test && pnpm build; echo exit=$?` → 0.
- [ ] **Step 5: 커밋** — `feat(monitor-ui): 점검 묶음 설정 화면 — 묶음 상자·칸 목록 상자·스텝 칸`

---

## 구현 후 (plan 밖 — 파이프라인 4–6단계)

- 최종 리뷰 `handicap-reviewer`(크로스 task 상호작용: Task 5 판정 ↔ Task 6·7 실행 단위 ↔ Task 8 상태 매핑 ↔ Task 10 저장 형태, 옛 동작에 기대던 소비자 — 기록 와이어·`consecutive_fail` 의미 변경·status 필수 필드) + **보안 리뷰 필수**(분기 값 노출, 가져오기 검사 변경, `branch_eval`이 `POST /api/test-runs`·미리 실행 응답에도 실림 — `${}` 값은 엔진이 미저장).
- 라이브 검증 = 스펙 §10 목록(US1–US4·결함·호환·극단값·A/B/C·진입 경로 전부). 시나리오 픽스처 각 스텝에 `assert: status`.

REVIEW-GATE: APPROVED
