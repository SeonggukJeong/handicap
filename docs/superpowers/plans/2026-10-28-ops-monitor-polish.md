# 운영실 모니터 개선 1차 (ops-monitor-polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 칸 성공 조건에 `∈`·`≥`·`≤`와 기호 표기를 더하고, 문자열로 감싼 JSON을 풀어 판정·표시하며, 판정과 무관한 표시 전용 값(칸당 2개)과 평균·최대(켜기/끄기)를 벽에 반반 배치로 보이고, 막대를 오른쪽부터 채운다.

**Architecture:** 판정·값 추출은 controller `monitor/check.rs` 안에서만 — 새 op는 `op_passes`, 풀기는 `parse_body_json`(함수별 지역 캐시), 표시 값은 `run_check`가 `judge` 뒤 trace에서 따로 뽑아 `CheckResult.display`에 싣고 `/status`는 최신 결과에만 남긴다. 평균·최대는 클라 계산, 켜기/끄기는 reconcile 없는 원자 `json_set` 전용 엔드포인트. 벽의 반반 줄은 기존 `--reason-fit`과 같은 방식의 별도 배율 `--split-fit`으로 맞춰 다른 칸 글자에 영향이 없다.

**Tech Stack:** Rust(axum, serde, serde_json, sqlx-sqlite JSON1, wiremock), React+TS(Zod, React Query, Tailwind container queries, vitest+RTL).

**Spec:** `docs/superpowers/specs/2026-10-28-ops-monitor-polish-design.md`(spec-plan-reviewer clean APPROVE 3라운드) · **결정 원천(최우선)** `docs/superpowers/specs/2026-10-28-ops-monitor-polish-mockups/00-decisions.md` · 목업 정본 `02-split-stats-chosen.html` **1번 보드**. spec과 결정 원천이 다르면 결정 원천이 이긴다. **목업에 없는 화면·배치를 만들지 않는다.**

REVIEW-GATE: APPROVED

## Global Constraints

- **와이어 op**(snake_case): 기존 7종 + `"gte"`·`"lte"`·`"one_of"`. `needs_value` = eq·ne·contains·gt·lt·**gte·lte·one_of** / `has_flags` = eq·ne·contains·**one_of** / `allows`: body·header 전부, status = eq·ne·gt·lt·gte·lte·one_of, body_text = contains·not_empty.
- **새 저장 필드**(컨테이너 `#[serde(default)]` + 손 `Default`, migration 없음): `PanelConfig.display_items: Vec<DisplayItem>`(기본 빈) · `DisplayItem { step_id: String, source: DisplaySource, path: String }` · `DisplaySource` = `"body"|"header"|"status"` · `BoardConfig.show_latency_stats: bool`(**기본 `true`** — `impl Default for BoardConfig`에 명시) · `MAX_DISPLAY_ITEMS = 2`.
- **`CheckResult.display: Vec<Option<String>>`** — 항상 직렬화(빈 배열 포함), `display_items`와 같은 길이·순서, trace 없으면 빈 Vec. `/status`는 최신 결과 외 `display`를 `Vec::new()`로.
- **서버 400 문구(byte-exact)**: `크기 비교 조건(>, <, ≥, ≤)의 비교값은 숫자여야 합니다`(기존 `크다·작다 조건의 비교값은 숫자여야 합니다` **대체**) · `여러 값 중 하나(∈) 조건의 후보값을 하나 이상 입력해야 합니다` · `벽 표시 항목은 최대 2개까지 설정할 수 있습니다` · `벽 표시 항목 스텝 id가 올바른 ULID 형식이 아닙니다` · `벽 표시 항목 본문 경로는 1~500자여야 합니다` · `벽 표시 항목 본문 경로(JSONPath)가 올바르지 않습니다` · `벽 표시 항목 헤더 이름은 1~200자여야 합니다` · `벽 표시 항목에는 인증 헤더를 쓸 수 없습니다`.
- **인증 헤더 4종**(대소문자 무시): `set-cookie`·`cookie`·`authorization`·`proxy-authorization` — 서버 거부 + UI `벽에 표시` 비활성. 조건은 무변경.
- **detail 서식**: `{대상} {기호}[ {비교값}][ · {스텝 이름}]` — 기호 `=`·`≠`·`>`·`<`·`≥`·`≤`·`∈`·`글자 포함`·`키 있음`·`값 있음`. `one_of` 비교값 = `{` + 분해 후보를 `", "`로 결합 + `}`. 빈 비교값 `""`(eq/ne 기존 규칙). 스텝 이름은 정의된 http 스텝 2개 이상일 때만(기존). `{대상}` = 기존 `target_label` 무변경.
- **감싼 JSON 풀기**(Rust `parse_body_json`·TS `parseBodyJson` 동일): JSON 읽기 실패 → 비JSON. 읽은 값이 문자열이면 그 문자열을 다시 읽기를 **최대 3번**; 도중 객체/배열에 도달하면 그 값, 아니면 **처음 읽은 값**. `body_text`(글자 포함)는 원문.
- **UI 문구는 `ko.monitor.*` 경유**(aria 포함) — 바뀌는/새 키는 각 task에 byte-exact.
- **배율 키에 결과 금지**: `scaleKey`에 넣는 것은 설정뿐 — 이 슬라이스는 `display_items.length`·`show_latency_stats`를 추가.
- Rust: `cargo fmt`, `clippy -D warnings`(2-arm `match … _ => {}` 대신 `if let`). 커밋은 `run_in_background`, 게이트 판정에 파이프 금지(`; echo exit=$?`), 커밋 후 `git log -1`. UI: `pnpm lint; echo exit=$?` · `pnpm test; echo exit=$?` · `pnpm build; echo exit=$?`, 단일 파일은 `pnpm test <파일명>`.
- **`ui/src` 편집 전 테스트부터**(tdd-guard). 새 required 스키마 필드를 추가하는 task가 **같은 커밋에서** 기존 fixture를 고친다(확인 `grep -rln "graph_max_ms\|latency_ms" ui/src --include='*.test.tsx' --include='*.test.ts'`).
- **회귀 가드 테스트는 고의 회귀 → RED → 원복 → GREEN 실증**(각 task의 "이빨" 스텝) — 실증 결과를 리포트에 기록.

## Review Focus

1. **벽이 켜진 채 설정 화면에서 표시 항목을 추가·삭제·순서 변경** — 다음 보드 재조회에서 배율이 다시 계산되고(옛 배율로 `30,0…` 잘림 없음), 첫 새 점검 전까지 없는 인덱스는 `—` → Task 9 `scale_key_changes_with_display_items_and_stats_flag`, `missing_display_index_renders_dash`.
2. **벽에서 평균·최대를 끄는 순간 설정 화면에서 칸을 저장** — 칸 편집이 되살아나거나 사라지지 않음. 경쟁 자체는 **설계로 차단**(단일 `UPDATE … json_set` 문 — 읽고-고쳐-쓰기 창이 없음); 테스트는 그 구현을 판별한다 → Task 5 `latency_stats_toggle_preserves_unknown_config_keys`(읽고-고쳐-쓰기면 serde 재직렬화가 모르는 키를 떨어뜨려 RED).
3. **감싼 JSON 응답에 `글자 포함` 조건** — 원문(`\"code\"` 이스케이프 포함)에서 찾음, 풀린 값 아님 → Task 3 `body_text_contains_uses_raw_wrapped_body`.
4. **표시 항목으로 고른 헤더가 다음 배포에서 사라짐 / 스텝을 시나리오에서 지움** — 판정은 그대로 정상, 벽은 `—`, 설정 화면 `⚠ 스텝 없음` → Task 4 `display_step_missing_is_not_config_error`, Task 7 `display_item_marks_missing_step`.
5. **`∈` 후보에 공백·빈 칸·대소문자 섞임**(`" 0000 ,, ok "` + 대소문자 무시) — 공백 무시·빈 후보 버림·플래그 적용 → Task 1 `one_of_candidates_trim_skip_empty_and_flags`.

---

### Task 1: 조건 op `gte`·`lte`·`one_of` — 설정 검증 + 판정

**Files:**
- Modify: `crates/controller/src/monitor/config.rs`(enum·`needs_value`·`has_flags`·`allows`·`validate_conditions`)
- Modify: `crates/controller/src/monitor/check.rs`(`op_passes`, `rule_label`에 새 arm만 — 기존 arm 문구는 Task 2가 바꾼다)

**Interfaces:**
- Produces: `ConditionOp::{Gte, Lte, OneOf}`(와이어 `gte`/`lte`/`one_of`) · `pub fn one_of_candidates(value: &str) -> Vec<&str>`(config.rs — `split(',')` → `trim` → 빈 것 제외; check.rs·Task 2 detail이 공유).
- `op_passes`: `Gte`/`Lte` = `Gt`/`Lt`와 같은 `parse_finite` 쌍 + `>=`/`<=`. `OneOf` = 후보 중 하나라도 `Eq`와 같은 비교(숫자 매치 + 후보 `parse_finite` → 수치, 아니면 `normalize_cmp`).
- `rule_label` 새 arm 임시값 `"≥"`·`"≤"`·`"∈"`(Task 2가 전체 서식 교체). `ConditionOp`에 대한 `match`는 `rule_label`·`op_passes` 둘뿐(리뷰 확인) — 둘 다 이 task에서 arm 추가.
- 기존 단언 갱신: `crates/controller/tests/monitor_boards_api_test.rs`(약 :460)의 `크다·작다 …` 문구 → 새 문구.
- 표 테스트 주의: 기존 `cond_ops_table`(`check.rs` 약 :1091)은 경로 `$.v` 고정 — 새 행도 `$.v`/`{"v":…}`로 쓰거나 별도 표 함수로.

- [ ] **Step 1: 실패 테스트**(`config.rs`·`check.rs` 테스트 모듈, 기존 `cond`/`flagged`/`judge_c`/`t_body` 헬퍼 재사용)
  - `enum_wire_strings_roundtrip` 확장: `gte`·`lte`·`one_of` 왕복.
  - `allows_table_new_ops`: status+gte/lte/one_of 허용, body_text+gte/one_of 거부(`이 대상에 쓸 수 없는 조건 규칙입니다`).
  - `conditions_validate_rejects` 확장: gte `"abc"`·lte `""` → `크기 비교 조건(>, <, ≥, ≤)의 비교값은 숫자여야 합니다`; **gt `"abc"`도 같은 새 문구**(기존 기대 문구 갱신); one_of `" , ,"` → `여러 값 중 하나(∈) 조건의 후보값을 하나 이상 입력해야 합니다`.
  - `conditions_validate_normalizes` 확장: gte `ignore_case:true` → `false`; one_of `ignore_case:true` 유지.
  - `cond_ops_table` 확장(경로 `$.v`): gte `5`≥`5` 통과·`4`≥`5` 실패 사유 `4` · lte `5`≤`5` 통과 · gte `"abc"` 실패 · one_of 본문 `{"v":1}` 후보 `"1, 20"` 통과 · `{"v":20}` 통과 · `{"v":2}` 실패 사유 `2` · 본문 `{"v":1.0}` 후보 `"1"` 통과(숫자 동치) · 문자열 `"0020"` 후보 `"0000, 0020"` 통과 · 문자열 `"20"` 후보 `"020"` 실패(문자열은 수치 비교 안 함 — 매치가 JSON 숫자일 때만).
  - `one_of_candidates_trim_skip_empty_and_flags`(Review Focus 5): `one_of_candidates(" 0000 ,, ok ") == ["0000","ok"]`; 실제 값 `"OK"` + `ignore_case` → 통과, 플래그 꺼짐 → 실패.
  - status one_of `"200, 204"` + 응답 204 통과.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller; echo exit=$?` → 컴파일 에러/FAIL(통합 테스트 포함).
- [ ] **Step 3: 구현** — Interfaces대로. gt/lt 문구 상수 교체.
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller; echo exit=$?` · `cargo clippy -p handicap-controller --all-targets -- -D warnings; echo exit=$?` 둘 다 0.
- [ ] **Step 5: 커밋** — `feat(monitor): 조건 규칙 ≥·≤·∈(여러 값 중 하나) 판정·검증`.

### Task 2: 기호 표기 detail 서식 (서버) + UI `NOT_CONTAINED_HEAD` 동시 변경

**Files:**
- Modify: `crates/controller/src/monitor/check.rs`(`rule_label`·`condition_detail`)
- Modify: `ui/src/monitor/display.ts`(`NOT_CONTAINED_HEAD`)
- Test: `ui/src/monitor/__tests__/display.test.ts`, `ui/src/pages/__tests__/MonitorDisplayPage.test.tsx`(`not_contained_reason_keeps_tail_span` 약 :849-859의 detail fixture → 새 헤드 `본문 전체 글자 포함 OK`), `crates/controller/tests/monitor_boards_api_test.rs`(약 :445 `resultCode · 같음 0000` → `resultCode = 0000`)

**Interfaces:**
- `rule_label(op) -> &'static str`: Eq `=` · Ne `≠` · Gt `>` · Lt `<` · Gte `≥` · Lte `≤` · OneOf `∈` · Contains `글자 포함` · Exists `키 있음` · NotEmpty `값 있음`.
- `condition_detail(c, step_name) -> String` = `{target_label} {rule_label}` + (`needs_value`면 ` ` + 비교값: OneOf는 `{a, b}`(Task 1 `one_of_candidates`), 그 외 원문, 빈 값이면 `""`) + (`step_name`이면 ` · {이름}`).
- UI `NOT_CONTAINED_HEAD = "본문 전체 글자 포함 "`(`reasonParts`가 이 접두로 `not_contained` 판별).

- [ ] **Step 1: 실패 테스트**
  - Rust: 기존 detail 단언 전부 새 서식으로 갱신 + `detail_symbols_table` — `resultCode = 0000` · `resultCode ≠ 0000` · `data.count ≥ 1` · `resultCode ∈ {0000, 0020}`(값 `" 0000,0020 "`) · `본문 전체 글자 포함 OK` · `data.token 키 있음` · `data.token 값 있음` · `상태코드 > 300` · eq 빈 값 `resultCode = ""` · 2스텝이면 `resultCode = 0000 · 인증`.
  - UI `display.test.ts`: `reasonParts('"OK" 포함 안 됨', "본문 전체 글자 포함 OK")` → `{kind:"not_contained", needle:"OK", small:"본문 전체 글자 포함 OK"}`; 옛 헤드 `"본문 전체 · 포함 OK"`는 `kind:"detail"`.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller; echo exit=$?` FAIL · `cd ui && pnpm test display; echo exit=$?` FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces.
- [ ] **Step 4: 이빨** — UI 헤드를 옛 값으로 되돌려 `display.test.ts` RED 확인 → 원복 GREEN. 리포트에 기록.
- [ ] **Step 5: 통과 확인** — cargo nextest + clippy · `pnpm lint; echo exit=$?` · `pnpm test; echo exit=$?` · `pnpm build; echo exit=$?` 각각 0.
- [ ] **Step 6: 커밋** — `feat(monitor): 조건 사유 작은 줄 기호 표기(=·≥·∈ …)`.

### Task 3: 문자열로 감싼 JSON 풀기 + 함수별 파싱 캐시 (서버, ③)

**Files:**
- Modify: `crates/controller/src/monitor/check.rs`

**Interfaces:**
- Produces: `pub(crate) fn parse_body_json(body: &str) -> Option<serde_json::Value>` — Global Constraints 정의(첫 읽기 실패 → `None`). `pub(crate) const MAX_JSON_UNWRAP: usize = 3;`
- `eval_conditions` 안에 스텝 trace 인덱스 → `Option<Option<Value>>` 지연 캐시(`HashMap<usize, Option<serde_json::Value>>` 등): 같은 응답 본문은 조건 개수와 무관하게 한 번만 파싱. `actual_value`가 문자열 대신 캐시된 값을 받도록 시그니처 조정(`judge` 시그니처 불변). `REASON_BODY_NOT_JSON`은 `parse_body_json == None`일 때만.
- `BodyText` 경로는 `resp.body` 원문 그대로(무변경).

- [ ] **Step 1: 실패 테스트**
  - `parse_body_json_table`: `{"a":1}` → 객체 · `"{\"code\":1}"`(1겹) → `{"code":1}` · 2겹·3겹 → 객체 · 4겹 → 처음 읽은 문자열 그대로 · `"hello"` → `String("hello")` · `"12"` → `String("12")` · `"[1,2]"` → 배열 · `not json` → `None`.
  - `wrapped_json_condition_passes`(US3): `t_body(r#""{\"code\":1}""#)`, body `$.code` eq `1` → `Ok`. **이빨**: 풀기를 끄면(`MAX_JSON_UNWRAP` 0) `값 없음` 실패 — RED 확인 후 원복.
  - `body_text_contains_uses_raw_wrapped_body`(Review Focus 3): 같은 본문, body_text contains `\"code\"`(백슬래시 포함) 통과 · contains `"code":1`(백슬래시 없음) 실패.
  - `string_body_not_unwrapped`: 본문 `"hello"`, `$` eq `hello` 통과.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller monitor::check` FAIL.
- [ ] **Step 3: 구현** — Interfaces대로.
- [ ] **Step 4: 통과 확인** — nextest + clippy exit 0.
- [ ] **Step 5: 커밋** — `fix(monitor): 문자열로 감싼 JSON 응답을 풀어서 조건 판정`.

### Task 4: 표시 전용 항목 — 설정·값 추출·`CheckResult.display`·`/status` 최신만

**Files:**
- Modify: `crates/controller/src/monitor/config.rs`(`DisplayItem`·`DisplaySource`·`MAX_DISPLAY_ITEMS`·`validate_display_items`)
- Modify: `crates/controller/src/monitor/check.rs`(`CheckResult.display`, `display_values`, `run_check` 연결)
- Modify: `crates/controller/src/api/monitor_boards.rs`(`build_panel_status` 최신 외 `display` 비움)
- Modify: `CheckResult` 리터럴 전부에 `display: vec![]` — `check.rs` 테스트(약 :703 `ok_when_all_steps_pass` 기대값 포함)·`supervisor.rs`·`api/monitor_boards.rs` 테스트(확인 `grep -rn "CheckResult {" crates/controller`)

**Interfaces:**
- Produces (config): Global Constraints 타입. `validate_panel` 끝에서 `validate_display_items(&mut p.display_items)?` — 순서: 개수 → ULID → source별 path(body: char 1..=500 → `jsonpath_is_valid` → `jsonpath_is_simple`, 둘 다 실패면 같은 JSONPath 문구; header: trim 저장 → char 1..=200 → 인증 헤더 4종 거부; status: `""`). 스텝 존재는 검사 안 함.
- Produces (check): `CheckResult.display: Vec<Option<String>>`(`with_reason`·`cond_result`·`judge` Ok 모두 `Vec::new()`). `fn display_values(panel: &PanelConfig, trace: &ScenarioTrace) -> Vec<Option<String>>` — 항목마다 `rfind`(조건과 같은 마지막 http 실행)의 응답에서 body = `parse_body_json`(이 함수의 지역 캐시) → `jsonpath_first` → `stringify` / header = `eq_ignore_ascii_case` / status = 10진 문자열; 없음·응답 없음·잘림·비JSON → `None`; 값이면 `Some(shown(text))`. `run_check`의 `Ok(trace)` 가지에서 `judge` 결과에 `result.display = display_values(panel, &trace)`.
- `build_panel_status`: 기존 `reason`/`detail` 비우는 루프에 `r.display = Vec::new()` 추가.

- [ ] **Step 1: 실패 테스트**
  - config: `defaults_fill_missing_fields` 확장(`display_items` 빈) · `display_items_validate_rejects` 표(3개 · ULID `"x"` · body `""` · body `"$..a"`(simple 아님) · header 201자 · header `"Set-Cookie"`·`"cookie"`·`"Authorization"`·`" proxy-authorization "` 각각 → 메시지 정확 일치) · `display_items_validate_normalizes`(status path `"$.x"` → `""`, header `" X-Trace "` → `"X-Trace"`) · 경계 수용(2개, body 500자 simple).
  - check: `display_values_table` — 항목 [body `$.resultCode`, body `$.message`], 본문 `{"resultCode":"0000","message":"정상"}` → `[Some("0000"), Some("정상")]` · 경로 없음 `None` · 스텝 미실행 `None` · `body_truncated` `None` · 비JSON `None` · 감싼 JSON 풀림 · header 대소문자 무시 · status `"200"` · 값 300자 → 200자 `…`(`shown`) · JSON null → `Some("")`.
  - `display_step_missing_is_not_config_error`(Review Focus 4): 항목 step_id가 시나리오에 없음 → `run_check`(wiremock 200) verdict `Ok`, `display == [None]`.
  - `display_filled_on_fail_verdict`: 조건 실패 + 항목 → `Fail`이고 `display` 채워짐.
  - `display_empty_without_trace`: 시간 초과(기존 `outer_timeout_fails_and_cancels` 패턴) → `display.is_empty()`.
  - api: `status_strips_display_except_latest`(기존 `status_results_truncated_to_bar_count` 패턴, 모든 결과에 `display: vec![Some("x")]` → 마지막만 남음). **이빨**: 비우는 줄 제거 → RED → 원복.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller` FAIL.
- [ ] **Step 3: 구현** — Interfaces대로.
- [ ] **Step 4: 통과 확인** — nextest + clippy exit 0.
- [ ] **Step 5: 커밋** — `feat(monitor): 벽 표시 전용 항목 — 설정 검증·점검 값 추출·/status 최신만`.

### Task 5: 평균·최대 켜기/끄기 — `show_latency_stats` + 원자 갱신 엔드포인트

**Files:**
- Modify: `crates/controller/src/monitor/config.rs`(`BoardConfig.show_latency_stats` + `Default` true)
- Modify: `crates/controller/src/store/monitor_boards.rs`(신규 `set_latency_stats`)
- Modify: `crates/controller/src/api/monitor_boards.rs`(핸들러 + 모듈 doc 예외 주석), `crates/controller/src/app.rs`(라우트)
- Modify: `crates/controller/CLAUDE.md`(한 줄)
- Test: `crates/controller/tests/monitor_boards_api_test.rs`

**Interfaces:**
- `pub async fn set_latency_stats(db: &Db, id: &str, show: bool) -> sqlx::Result<Option<MonitorBoardRow>>` — 단일 문 `UPDATE monitor_boards SET config_json = json_set(config_json, '$.show_latency_stats', json(?)), updated_at = ? WHERE id = ?`(바인드 `if show {"true"} else {"false"}`, `super::now_ms()`); `rows_affected() == 0` → `Ok(None)`; 아니면 `get(db, id)`. **읽고-고쳐-쓰기 금지.**
- 핸들러 `pub async fn set_latency_stats(State, Path(id), Json(body: LatencyStatsBody { show: bool })) -> Result<Json<BoardResponse>, ApiError>` — 없으면 `NotFound`. **`reconcile` 호출 없음.** 모듈 doc의 "쓰기 = DB 쓰기 → reconcile" 문장 옆에 예외 명시.
- 라우트 `.route("/monitor-boards/{id}/latency-stats", put(monitor_boards_api::set_latency_stats))`.
- controller `CLAUDE.md` 운영 모니터 함정 근처 한 줄: `표시 전용 보드 필드(show_latency_stats)는 reconcile 없이 json_set 원자 갱신 — 칸 목록·점검 설정 필드엔 이 경로 금지(감독자와 DB 어긋남) (ops-monitor-polish)`.

- [ ] **Step 1: 실패 테스트**
  - config: `defaults_fill_missing_fields` 확장 — 필드 없는 JSON → `show_latency_stats == true`; `BoardConfig::default().show_latency_stats == true`.
  - 통합(`monitor_boards_api_test.rs`, 기존 보드 생성·start·status 헬퍼 재사용):
    - `latency_stats_toggle_does_not_restart_checks` — 보드 생성·start → `/status`의 `started_at_ms` 기록 → ≥5ms 대기 → `PUT …/latency-stats {"show":false}` 200, 응답 `config.show_latency_stats == false`, `updated_at` 증가 → `/status` `started_at_ms` **불변**. **이빨**: 핸들러에 `state.monitor.reconcile(...)` 임시 추가 → RED → 원복.
    - `latency_stats_toggle_after_full_save_keeps_new_panels` — 보드 생성 → `PUT /{id}`로 칸 제목 변경 → `PUT …/latency-stats` → `GET /{id}`의 칸 제목이 변경 후 값 + 플래그 반영(순차 동작 회귀 가드 — 경쟁 판별은 다음 테스트).
    - `latency_stats_toggle_preserves_unknown_config_keys`(Review Focus 2) — 기존 `legacy_board_row_loads_with_defaults`(약 :505)의 raw `sqlx::query("UPDATE monitor_boards SET config_json = …")` 패턴으로 `config_json`에 모르는 키 `"zz_probe":1`을 넣은 행 → 토글 → raw SQL로 `config_json`을 다시 읽어 `zz_probe` 존재 + `show_latency_stats == false` 단언. 읽고-고쳐-쓰기(serde 재직렬화)는 모르는 키를 떨어뜨린다. **이빨**: store 함수를 `get` → 수정 → `update`로 임시 교체 → RED → 원복.
    - `latency_stats_inserts_key_into_legacy_row` — 같은 raw `UPDATE` 패턴으로 키 없는 `config_json` 행 → 토글 → GET에서 `false`.
    - `latency_stats_unknown_board_404`.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --test monitor_boards_api_test` FAIL.
- [ ] **Step 3: 구현** — Interfaces대로.
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller; echo exit=$?` + clippy exit 0.
- [ ] **Step 5: 커밋** — `feat(monitor): 평균·최대 표시 켜기/끄기 — reconcile 없는 원자 갱신`.

### Task 6: UI 와이어·조건 로직·문구·조건 줄 (`∈`·기호·비활성 입력)

**Files:**
- Modify: `ui/src/api/monitors.ts`(스키마·`newPanel`·신규 `setLatencyStats`)
- Modify: `ui/src/monitor/conditions.ts`(op 미러·`targetLabel`·`conditionSummary`·`conditionError`·`normalizeCondition`·신규 `oneOfCandidates`·`parseBodyJson`)
- Modify: `ui/src/i18n/ko.ts`(monitor)
- Modify: `ui/src/components/monitor/ConditionRow.tsx`, `ui/src/pages/MonitorEditPage.tsx`(새 보드 리터럴 `show_latency_stats: true`)
- Test: `ui/src/monitor/__tests__/conditions.test.ts`, `ui/src/api/__tests__/monitors.test.ts`, 신규 `ui/src/components/monitor/__tests__/ConditionRow.test.tsx` + fixture 갱신(`MonitorEditPage`·`MonitorDisplayPage`(2)·`MonitorListPage`·`LatencyBars`·**`logic.test.ts`의 `ok()` 헬퍼(약 :18-24, `CheckResult` 타입 — `tsc -b`가 테스트도 검사)** 테스트)
- **기존 단언 갱신(요약 서식·대상 표기·기호 변경으로 깨짐)**: `MonitorEditPage.test.tsx`의 `SUMMARY_A`/`SUMMARY_B`(약 :155-156)와 약 :709·:834·:867·:878 · `addBtn("본문 …")`/`+ 조건 (본문 …)` 접근명 약 :828·:843·:854·:876·:898·:925·:1002·:1007(→ `+ 추가 (경로)`) · `conditions.test.ts` 약 :114. (줄번호는 리뷰 시점 — `grep -n`으로 재확인.)
- **함정**: user-event `selectOptions`는 `value` 또는 `innerHTML`로 매칭 — `>` 항목의 innerHTML은 `&gt;`라 **텍스트로 고르면 throw**. 기존 `selectOptions(…, ko.monitor.condOpOptions.gt)`(약 :723·:899)와 새 테스트 모두 **값(`"gt"`·`"gte"`·`"one_of"`)으로** 고른다.

**Interfaces:**
- Produces (monitors.ts): `ConditionOpSchema`에 `"gte","lte","one_of"` · `DisplaySourceSchema = z.enum(["body","header","status"])` · `DisplayItemSchema = z.object({step_id, source: DisplaySourceSchema, path})` · `PanelConfigSchema.display_items: z.array(DisplayItemSchema)` · `BoardConfigSchema.show_latency_stats: z.boolean()` · `CheckResultSchema.display: z.array(z.string().nullable())` · `newPanel()`에 `display_items: []` · `setLatencyStats(id: string, show: boolean): Promise<Board>`(`PUT ${BASE}/${id}/latency-stats`, body `{show}`, 기존 `startBoard`와 같은 에러 처리).
- Produces (conditions.ts): `oneOfCandidates(value: string): string[]` · `parseBodyJson(body: string): { value: unknown; unwrapped: number } | null`(Global Constraints, `MAX_JSON_UNWRAP = 3`) · `OPS_BY_SOURCE`·`needsValue`·`hasFlags` = Global Constraints 표 · `conditionError`: one_of 후보 0 → `ko.monitor.condErrOneOf`, gte/lte 비숫자 → `condErrNumber` · `targetLabel` body = 경로만(`condTargetBody` 변경으로) · `conditionSummary(c, stepName)` = `{targetLabel} {condOpLabel[op]}` + (needsValue: one_of면 ` {a, b}`, 그 외 ` {value}`/`""`) + ` · {stepName ?? step_id}` + 플래그 접미(기존).
- ko.monitor 변경(byte-exact): `conditionsIntro: "아래 조건을 모두 만족하면 정상 (AND) · 시나리오 자체 판정에 더해서"` · `condOpOptions: { eq: "=", ne: "≠", exists: "키 있음 (null 허용)", not_empty: "값 있음 (null·빈값 아님)", contains: "글자 포함", gt: ">", lt: "<", gte: "≥", lte: "≤", one_of: "∈ 여러 값 중 하나" }` · `condOpLabel: { eq: "=", ne: "≠", exists: "키 있음", not_empty: "값 있음", contains: "글자 포함", gt: ">", lt: "<", gte: "≥", lte: "≤", one_of: "∈" }` · 신규 `condOpSpoken: { eq: "같음", ne: "다름", gt: "보다 큼", lt: "보다 작음", gte: "이상", lte: "이하", one_of: "여러 값 중 하나", contains: "글자 포함", exists: "키 있음", not_empty: "값 있음" }` · `condVolatileHint: "매번 바뀌는 값이면 '='은 매 점검 실패하고 그 값이 벽에 표시됩니다"` · `condValueOneOfPlaceholder: "0000, 0020"` · `condErrOneOf: "후보값을 하나 이상 입력하세요"` · `condTargetBody: (p: string) => p` · `condAdd: "+ 추가"` · `condAddAria: (target: string) => \`+ 추가 (${target})\`` · `previewBodyClickHint: "응답 본문 — 값을 누르면 조건이나 벽 표시를 추가합니다"` · `previewUnwrapped: "문자열로 감싼 JSON을 풀어서 표시 중"`.
- `ConditionRow`: select `<option>`마다 `aria-label={condOpSpoken[op]}`; `needsValue` 거짓이면 비교값 `Input`을 `disabled`·`value=""`·`placeholder="—"`로 렌더(숨기지 않음); one_of면 placeholder `condValueOneOfPlaceholder`. select 폭 클래스는 가장 긴 항목이 안 잘리는 값(라이브에서 확정 — 우선 `w-52`).

- [ ] **Step 1: 실패 테스트**
  - `conditions.test.ts`: `oneOfCandidates` 표(Task 1과 같은 입력) · `parseBodyJson` 표(Task 3 `parse_body_json_table`과 **같은 케이스**, `unwrapped` 0/1/2/3, 4겹은 0) · `OPS_BY_SOURCE.status`에 gte/lte/one_of · `conditionError` one_of `" , "` → `condErrOneOf`, gte `"x"` → `condErrNumber` · `targetLabel({source:"body",path:"$.resultCode"}) === "resultCode"` · `conditionSummary` 표(Task 2 `detail_symbols_table`과 같은 서식 + ` · 로그인`) · `normalizeCondition` gte 플래그 끔·one_of 플래그 유지.
  - `monitors.test.ts`: `display`·`display_items`·`show_latency_stats` 포함 응답 파싱, 누락 시 실패 · `setLatencyStats` PUT 경로·본문.
  - `ConditionRow.test.tsx`: exists 선택 → 비교값 입력 존재 + `disabled` · one_of placeholder `0000, 0020` · option `≥`의 접근명 `이상` · one_of 빈 후보면 추가 버튼 disabled + `condErrOneOf` 표시.
  - fixture: 기존 보드/칸/결과 fixture에 `display_items: []`·`show_latency_stats: true`·`display: []` 추가.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test conditions; echo exit=$?` · `pnpm test monitors; echo exit=$?` · `pnpm test ConditionRow; echo exit=$?` FAIL.
- [ ] **Step 3: 구현** — Interfaces대로(기존 `condErrNumber`·`condErrValue` 유지).
- [ ] **Step 4: 통과 확인** — `pnpm lint; echo exit=$?` · `pnpm test; echo exit=$?` · `pnpm build; echo exit=$?` 모두 0.
- [ ] **Step 5: 커밋** — `feat(monitor-ui): 조건 ∈·≥·≤·기호 표기·비활성 입력 + 와이어 필드`.

### Task 7: 설정 화면 — `+ 추가` 선택·감싼 JSON 트리·"벽에 표시" 영역

**Files:**
- Modify: `ui/src/components/monitor/PreviewResult.tsx`, `ui/src/components/monitor/PanelEditor.tsx`, `ui/src/i18n/ko.ts`
- Test: 신규 `ui/src/components/monitor/__tests__/PreviewResult.test.tsx`, `ui/src/pages/__tests__/MonitorEditPage.test.tsx`
- **수정 금지**: `ui/src/components/response/BodyBlock.tsx`(TestRunPanel 공유 — 0-diff)

**Interfaces:**
- Consumes: Task 6 `parseBodyJson`, `DisplayItem`, `targetLabel`.
- `PreviewResult` props 추가: `displayItems: DisplayItem[]`, `onAddDisplay?: (d: DisplayItem) => void`. 값 옆 버튼(`condAdd` `+ 추가`) → 그 자리에 버튼 두 개 `condChooseCondition`(=`조건으로 추가`, 기존 `ConditionRow` create 흐름) / `condChooseDisplay`(=`벽에 표시`, 즉시 `onAddDisplay` 후 닫힘). 본문 전체(`condAddBodyText`)는 선택 없이 조건만.
- `벽에 표시` 비활성 사유(우선순위 순, 버튼 옆 텍스트 + `aria-describedby`): `displayMax`(2개) → `displayDup`(같은 `step_id`·`source`·`path`) → `displayAuthHeader`(헤더 4종). 조건 10개 상한(`condMax`)은 **`조건으로 추가` 쪽에만** 적용 — `벽에 표시`를 막지 않는다.
- 항목 추가 시 `벽에 표시` fieldset 자동 펼침(기존 `addCondition`의 `setCondOpen(true)` 이디엄, `PanelEditor.tsx` 약 :133-136).
- **기존 테스트 갱신**: `+ 추가`를 누른 뒤 조건 편집기를 기대하던 `MonitorEditPage.test.tsx`의 모든 흐름(약 :828·:843·:854·:863·:876·:898·:925·:944·:1002·:1007 — `grep -n`으로 재확인)에 `조건으로 추가` 클릭 한 번 추가.
- 트리: `isJsonBody`·`tree.render`가 `parseBodyJson(resp.body)?.value`를 쓴다(`BodyBlock`이 넘기는 값 무시). `unwrapped ≥ 1`이면 본문 제목 줄 옆 `previewUnwrapped`.
- `PanelEditor`: 성공 조건 fieldset 바로 아래 같은 이디엄(`aria-expanded` 토글·접힘 시 `advancedSet(n)`)의 fieldset `displayTitle`. 펼침: `displayIntro` · 항목 행 `{displayRank[i]} {targetLabel} · {스텝 이름}` + `🗑`(aria `displayRemove(i+1)`) + 스텝 없으면 `condStepGone` · 2개면 아래 `displaySwap` 버튼(교환) · 0개면 `displayEmpty`.
- ko.monitor 신규(byte-exact): `condChooseCondition: "조건으로 추가"` · `condChooseDisplay: "벽에 표시"` · `displayTitle: "벽에 표시"` · `displayIntro: "판정과 무관 · 최대 2개 · 첫째는 큰 글자, 둘째는 작은 줄"` · `displayEmpty: "미리 실행 결과에서 값을 눌러 벽에 표시할 값을 고릅니다"` · `displayRank: ["① 큰 글자", "② 작은 줄"]` · `displaySwap: "↕ 순서 바꾸기"` · `displayRemove: (n: number) => \`표시 항목 ${n} 삭제\`` · `displayMax: "벽 표시는 최대 2개까지"` · `displayDup: "이미 벽에 표시 중"` · `displayAuthHeader: "인증 헤더는 벽에 표시할 수 없음"`.

- [ ] **Step 1: 실패 테스트**
  - `PreviewResult.test.tsx`: 감싼 본문 `"{\"code\":1}"` → 트리에 `code` 잎 + `previewUnwrapped` 문구, `+ 추가 (code)` 클릭 → `조건으로 추가`/`벽에 표시` 두 버튼 · `벽에 표시` → `onAddDisplay({step_id, source:"body", path:"$.code"})` · 일반 객체 본문엔 `previewUnwrapped` 없음 · 헤더 `Set-Cookie` 행의 `벽에 표시` disabled + `displayAuthHeader` · 항목 2개면 disabled + `displayMax` · 같은 경로 이미 있으면 `displayDup` · `조건으로 추가`는 기존 `ConditionRow` 표시.
  - `PreviewResult.test.tsx` 추가: 조건 10개여도 `벽에 표시`는 활성(`condMax`는 조건 쪽만).
  - `MonitorEditPage.test.tsx`: 미리 실행에서 `벽에 표시` → 접혀 있던 `벽에 표시` fieldset이 펼쳐지고 항목 1개 · 영역 펼침·항목 2개 → `↕ 순서 바꾸기` 후 저장 요청 body의 `display_items` 순서 뒤바뀜 · 삭제 · `display_item_marks_missing_step`(Review Focus 4 — 시나리오에 없는 step_id면 `⚠ 스텝 없음`) · 조건 목록 머리 `아래 조건을 모두 만족하면 정상 (AND)`.
- [ ] **Step 2: 실패 확인** — `pnpm test PreviewResult; echo exit=$?` · `pnpm test MonitorEditPage; echo exit=$?` FAIL.
- [ ] **Step 3: 구현** — Interfaces대로. `git diff --stat ui/src/components/response/BodyBlock.tsx` 빈 출력 확인.
- [ ] **Step 4: 통과 확인** — lint/test/build exit 0.
- [ ] **Step 5: 커밋** — `feat(monitor-ui): 미리 실행 값 → 조건/벽 표시 선택 + 감싼 JSON 트리 + 벽 표시 영역`.

### Task 8: 벽 — 막대 오른쪽부터·평균/최대 줄·켜기/끄기 토글 (반반 제외)

**Files:**
- Modify: `ui/src/monitor/logic.ts`(`barSlots`, 신규 `latencyStats`·`formatStats`)
- Modify: `ui/src/monitor/display.ts`(`PANEL_TEXT.stats: 5.4`)
- Modify: `ui/src/components/monitor/MonitorPanel.tsx`(평균·최대 줄 + 프로브 줄, prop `showStats`)
- Modify: `ui/src/pages/MonitorDisplayPage.tsx`(토글 버튼·`scaleKey`·`showStats` 전달)
- Modify: `ui/src/components/monitor/FocusProbes.tsx`(C 사건 배율의 `PanelProbe`에도 `showStats` 전달 — 실패 칸이 평균·최대 줄을 그리므로 사건 프로브도 같은 줄을 재야 한다)
- Modify: `ui/src/i18n/ko.ts`
- Test: `ui/src/monitor/__tests__/logic.test.ts`, `ui/src/components/monitor/__tests__/LatencyBars.test.tsx`, `ui/src/pages/__tests__/MonitorDisplayPage.test.tsx`

**Interfaces:**
- `barSlots(results, barCount)`: 빈 칸 `null`을 **앞에** — 최신이 마지막. JSDoc `filled from the right`.
- `latencyStats(results: CheckResult[]): { avg: number; max: number } | null` — `verdict==="ok" && latency_ms!==null`만, `avg = Math.round(mean)`, 0개면 `null`.
- **공용 컴포넌트** `StatsLine({ avg, max, fontSize, labelColor, numColor, probe?: "fit" | "split" })`(`MonitorPanel.tsx` 안): 구조 `<span label>{statsAvg}</span>{" "}<b num>{avg}</b>{" "}<span style={{marginLeft:"3cqw"}} label>{statsMax}</span>{" "}<b num>{max}</b>` — 항목 사이 간격 = **공백 + 3cqw**(숫자 `toLocaleString("en-US")`), 컨테이너 `whitespace-nowrap overflow-hidden text-right`(실제는 `text-ellipsis`). **실제 줄과 프로브 줄이 같은 컴포넌트**를 써서 굵기·간격이 같은 폭으로 측정된다. 실제 = `data-testid="latency-stats"`, 프로브 = `probe` 지정 → 투명 + `data-testid="stats-probe"` + `probe==="fit"`이면 `data-fit-line`, `"split"`(Task 9)이면 `data-split-probe`; 값 = `T`(`timeout_seconds*1000`).
- 그리는 상태: `ok`·`slow`(큰 값 줄 아래)·`fail`(연속 실패 줄 아래) **이고** `showStats` **이고** `latencyStats != null`. 글자 `panelFont(PANEL_TEXT.stats, fontScale)`. 색: 라벨 `COLOR.muted`·숫자 `COLOR.text`, **A(fill) 방식은 둘 다 `ink`**(이 task에서 — 미루지 않는다).
- 프로브(`PanelProbe` prop **`showStats: boolean` 필수** — 선택 prop이면 `FocusProbes`가 조용히 빠진다): 켜짐이면 큰 값 줄 아래 `StatsLine probe`.
- 토글 실패·중복 클릭: 요청 중 `disabled`, 실패 시 도구 줄에 `statsError(msg)`(기존 `stopError` 표시 방식 그대로). 성공 시 응답 보드로 `qc.setQueryData(monitorKey(id), b)`(stop이 쓰는 패턴).
- 토글: 창 모드 도구 줄 `ToolButton`(`aria-pressed={show}`) 라벨 `toolbarStats`; 클릭 → `setLatencyStats(id, !show)`. `ToolButton`에 `pressed?: boolean` prop 추가.
- `scaleKey`에 `` `stats:${board.config.show_latency_stats}` `` 추가.
- ko.monitor 신규: `statsAvg: "평균"` · `statsMax: "최대"` · `toolbarStats: "평균·최대"` · `statsError: (msg: string) => \`평균·최대 표시를 바꾸지 못했습니다: ${msg}\``.

- [ ] **Step 1: 실패 테스트**
  - `logic.test.ts`: `barSlots([r1,r2], 5)` → `[null,null,null,r1,r2]` · 넘치면 최근 N(기존) · `latencyStats` 표(실패·설정 오류·null 지연 제외, 반올림, 빈 → null, slow 포함).
  - `LatencyBars.test.tsx`: 결과 2개·막대 5 → 마지막 두 `bar-slot`이 결과, 앞 셋 `data-empty`. **이빨**: `barSlots`를 append로 되돌려 RED → 원복.
  - `MonitorDisplayPage.test.tsx`: 정상 칸 `getByTestId("latency-stats")`가 `toHaveTextContent("평균 141 최대 2,410")`(span이 나뉘어 `getByText` 불가) · 실패 칸에도 있음 · `config_error`·`pending`엔 없음 · `show_latency_stats:false` 보드면 실제 칸·프로브 모두 없음 · 토글 클릭 → `PUT …/latency-stats {"show":false}` 호출 + `aria-pressed` 반영 + 요청 중 disabled · 실패 응답 → `statsError` 문구 · A(fill)에서 `latency-stats` 숫자 색 = ink · 전체화면엔 도구 줄 없음(기존).
  - `stats_flag_in_scale_key`: 기존 `scale_search_reruns_when_settings_change`(약 :677-700)를 본떠 `stubLayout`으로 "프로브 텍스트에 평균·최대 줄이 있으면 높이가 커지게" 하고, 보드 재조회로 `show_latency_stats`를 false→true로 바꾸면 `fitOf(...)`가 1 미만으로 떨어짐. **이빨**: `scaleKey`에서 `stats:` 조각을 빼면 RED → 원복.
- [ ] **Step 2: 실패 확인** — `pnpm test logic; echo exit=$?` · `pnpm test LatencyBars; echo exit=$?` · `pnpm test MonitorDisplayPage; echo exit=$?` FAIL.
- [ ] **Step 3: 구현** — Interfaces대로.
- [ ] **Step 4: 통과 확인** — lint/test/build exit 0.
- [ ] **Step 5: 커밋** — `feat(monitor-ui): 막대 오른쪽부터 + 평균·최대 줄 + 보드 화면 켜기/끄기`.

### Task 9: 벽 — 반반 배치·표시 값·`--split-fit` + ADR-0053 보완

**Files:**
- Modify: `ui/src/monitor/display.ts`(`PANEL_TEXT.splitBig: 11.2`, `COLOR.soft: "#cbd5e1"`)
- Modify: `ui/src/monitor/useScaleSearch.ts`(`ProbeReport.splitNeed`, 반환 `splitFit`)
- Modify: `ui/src/components/monitor/MonitorPanel.tsx`(반반 줄·실패 칸 표시 값 줄·`PanelMeasure.splitNeed`·프로브 반반 구조·prop `splitFit`)
- Modify: `ui/src/components/monitor/StripCard.tsx`(프로브 보고 리터럴 `splitNeed: Infinity`)
- Modify: `ui/src/pages/MonitorDisplayPage.tsx`(`probeReport`·`renderPanel` scale에 `splitFit`·`scaleKey`)
- Modify: `docs/adr/0053-*.md`(보완 절)
- Test: `ui/src/pages/__tests__/MonitorDisplayPage.test.tsx`, 신규 `ui/src/monitor/__tests__/useScaleSearch.test.ts`

**Interfaces:**
- 항목 칸(`panel.display_items.length ≥ 1`)·상태 `ok`/`slow`: 제목 줄 아래 `<div data-testid="split-row" style={{display:"grid", gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)", columnGap:"3cqw"}}>`. 왼쪽: `display[0]`(`truncate text-left font-black`, `COLOR.text`/ink, `lineHeight:1.18`) + (항목 2개면) `display[1]`(`truncate text-left`, `COLOR.soft`/ink, step 글자). 오른쪽: 응답 속도(`text-right font-black`, `bigColor`, `lineHeight:1.18`) + 평균·최대 줄(Task 8 요소, 켜짐일 때). 네 줄 글자 = `calc(${panelFont(비율, fontScale)} * var(--split-fit, 1))` (왼쪽 큰 값·응답 속도 = `splitBig`, 작은 줄 = `step`, 평균·최대 = `stats`).
- 표시 값 텍스트: `v === undefined || v === null || v === ""` → `ko.monitor.noValue`(`—`). 값 = 최신 결과 `display[i]`.
- `fail` 항목 칸: 연속 실패 줄 아래 `<div data-testid="display-line" className="truncate text-left">` = `<b COLOR.text>{v0}</b> <span COLOR.soft>{v1}</span>`(step 글자; 항목 1개면 `v0`만). 그릴 값이 **하나도** 없으면 줄 렌더 안 함; 일부만 없으면 없는 쪽을 `—`로(`— 세션이 만료…`/`E1023 —`). 그 아래 평균·최대(Task 8).
- `PanelMeasure.splitNeed: number` — `useBoxMeasure`가 `[data-split-probe]`마다 `box/natural*0.98`의 최솟값(없으면 `Infinity`). `ProbeReport.splitNeed`, `useScaleSearch`가 `done` 가지에서 `reasonNeeds`와 같은 방식으로 `splitNeeds` → `splitFit = Math.min(1, ...)`. **`scaleKey` 변경 시 `splitNeeds` 맵만 비우고 `splitFit` 값은 유지**(기존 `reasonFit`과 같은 동작 — 새 검색이 끝나 모든 프로브가 보고하면 갱신; 재측정 동안 옛 값).
- 프로브(항목 칸) **텍스트 블록 = 제목·상태 줄 + 반반 grid뿐** — 기존 전체 너비 `BigValueLine`(시간 초과 ms)과 Task 8의 전체 너비 `StatsLine probe`는 항목 칸 프로브에서 **둘 다 제거**(남기면 항목 칸 프로브가 큰 줄 하나만큼 높아져 보드 공통 `--fit`을 끌어내린다 — D2.17 위반). 반반 grid: 왼쪽 자리 채움 줄(항목 수만큼, 내용 `"\u00a0"`(이스케이프로 작성 — 일반 공백 금지), `color: transparent`, 1줄째 splitBig·`lineHeight:1.18`, 2줄째 step) / 오른쪽 `data-split-probe` 두 줄(`whitespace-nowrap overflow-hidden`): `formatMs(timeout*1000)`(splitBig), 켜짐이면 `StatsLine probe`(Task 8 컴포넌트, `data-fit-line` 대신 `data-split-probe`). 항목 없는 칸 프로브는 Task 8 그대로.
- `MonitorPanel` prop `splitFit` → 상자 style `"--split-fit"`(`--reason-fit`과 같은 방식). `renderPanel`의 scale 객체에 `splitFit`(일반·사건 각자의 `useScaleSearch` 반환값).
- `scaleKey` 칸 조각 `` `${p.id}|${p.title}|${p.timeout_seconds}|${p.display_items.length}` ``.
- ADR-0053 끝에 `## 보완 — ops-monitor-polish (2026-10-28)` — spec §9 문단 그대로(표시 전용 값 상시 노출 예외·칸당 ≤2·`shown`·`/status` 최신만·평균/최대 화면 계산·켜기/끄기는 reconcile 없는 표시 옵션).

- [ ] **Step 1: 실패 테스트**
  - `useScaleSearch.test.ts`: `done` 뒤 모든 프로브가 `splitNeed` 보고 → `splitFit = min(1, …)`; 일부만 보고 땐 갱신 없음; 키 변경 직후 `splitFit`은 옛 값 유지 → 새 검색 완료·전원 보고 후 새 값.
  - `item_panel_probe_has_no_fit_line`: 항목 칸의 `probe-text` 안에 `[data-fit-line]` 0개, `[data-split-probe]` ≥1개(D2.17 — 공통 배율에 안 닿음).
  - `MonitorDisplayPage.test.tsx`: 항목 2개 정상 칸 → `split-row` 안 `0000`·`정상 처리되었습니다`·`132 ms`·`latency-stats` · 항목 1개면 왼쪽 한 줄 · `missing_display_index_renders_dash`(Review Focus 1 — `display: []`인데 항목 2개 → `—` 두 개) · `null`/`""` → `—` · 항목 없는 칸엔 `split-row` 없음 · 실패 항목 칸 → 실패 사유 + `display-line` `E1023 세션…` · 모든 값 null이면 `display-line` 없음 · v0만 null이면 `— {v1}` · `config_error` 항목 칸엔 `split-row`·`display-line` 없음 · 프로브에 `data-split-probe` 두 줄(켜짐)/한 줄(꺼짐).
  - `scale_key_changes_with_display_items_and_stats_flag`(Review Focus 1): 기존 `scale_search_reruns_when_settings_change`(약 :677-700)를 본떠 `stubLayout`으로 "프로브 텍스트에 반반 grid가 있으면 높이가 커지게" 하고, 보드 재조회로 `display_items`를 0→1개로 바꾸면 `fitOf(...)`가 1 미만으로 떨어짐(jsdom은 폭 0이면 측정을 건너뛰므로 stub 필수). **이빨**: `scaleKey`에서 `display_items.length`를 빼면 RED → 원복.
- [ ] **Step 2: 실패 확인** — `pnpm test useScaleSearch; echo exit=$?` · `pnpm test MonitorDisplayPage; echo exit=$?` FAIL.
- [ ] **Step 3: 구현** — Interfaces대로. A(fill) 방식은 모든 새 줄 색을 `ink`로.
- [ ] **Step 4: 통과 확인** — lint/test/build exit 0 + `cargo` 무관(문서만 추가).
- [ ] **Step 5: 커밋** — `feat(monitor-ui): 벽 반반 배치 — 표시 값 + 응답 속도·평균/최대(전용 배율) + ADR-0053 보완`.

## 구현 후 (파이프라인 4–6단계 — task 아님)

- **최종 리뷰** `handicap-reviewer`(와이어 1:1 Rust↔Zod: `display`·`display_items`·`show_latency_stats`·op 3종 / Task 2 서버 서식 ↔ Task 6 `conditionSummary` / `parse_body_json` ↔ `parseBodyJson` 같은 케이스 / Task 4·Task 9 상호작용: 설정 변경 직후 과도 구간). + `finish-slice` §0 grep → `security-reviewer` 판단(표시 값 상시 노출 — spec §8 잔여 위험 기록 포함).
- **라이브 검증 필수** `/live-verify`: US1~US5 척추 행 + spec §7 극단값(칸 9 × xlarge × 시간 제한 30초 × 표시 값 2개 각 200자 × 긴 제목, 실패 칸 전 줄 동시, A/B/C·C 1·2개 실패, 설정 화면 `∈` 200자·select 최장 항목) rect 교차 실측. 응답기는 감싼 JSON `"{\"code\":1,\"message\":\"정상\"}"`. 마운트 경로 전부(보드 창 모드·전체화면, 설정 신규/기존 보드). 토글 후 `/status` `started_at_ms` 불변 확인. select 폭(`w-52`)은 실측으로 확정.
- **마무리** `/finish-slice` — build-log·roadmap(§B 판단 기록 — `rulings-cost-recorded-in-roadmap`)·CLAUDE 상태줄·메모리.
