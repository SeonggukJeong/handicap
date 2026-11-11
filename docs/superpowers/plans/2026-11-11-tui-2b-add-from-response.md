# 응답에서 값을 골라 성공 조건·표시 값 추가 (tui-2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 터미널 모니터의 요청·응답 화면에서 `a`를 누르면 그 응답의 값 목록이 뜨고, 값을 골라 성공 조건 또는 화면 표시 값으로 저장한다. 칸 설정 11·12 하위 목록의 `a`는 지금 점검 뒤 값 목록까지 바로 간다.

**Architecture:** 새 순수 모듈 `pick.rs`(응답 → 값 목록·경로·기본 조건·막힘·표지)와 새 화면 `Screen::Values`. 값 목록 상태는 `EditUi.values`에 두고 창(선택 창·조건 칸·저장 중)은 2a의 `EditUi.overlay`를 써서 저장 길(`commit` → `EditReq::SaveBoard` → `apply_done`)을 그대로 탄다. 서버·GUI는 건드리지 않는다.

**Tech Stack:** Rust(edition 2024), ratatui `TestBackend`, serde(순서 지키는 트리의 손 `Deserialize`), wiremock(통합), `handicap_engine::extract::{jsonpath_first, jsonpath_is_simple, jsonpath_is_valid}`(테스트 대조).

**Spec:** `docs/superpowers/specs/2026-11-11-tui-2b-add-from-response-design.md` — **§2 동작 규칙·§3 화면·§4 구조가 정본**. 구현자는 자기 task가 가리키는 절을 반드시 읽는다. 이 plan과 spec이 다르면 **STOP**하고 보고(임의로 한쪽을 고르지 말 것).

spec·plan 모두 `spec-plan-reviewer` clean APPROVE(spec 2라운드, plan 2라운드 — 2026-11-11).

REVIEW-GATE: APPROVED

**US 블록(매 brief 첨부):** spec의 `## 사용자 스토리 (US)` 헤딩부터 다음 `## ` 헤딩 앞까지.

## Global Constraints

- 범위: `crates/tui` + 문서. **`crates/controller`·`crates/engine`·`crates/proto`·`crates/worker*`·`ui/`·DB 0-diff.** 새 의존 없음(`Cargo.toml`·`Cargo.lock` 0-diff). 워크스페이스 `serde_json`에 `preserve_order`를 켜지 않는다.
- 이 세션은 워크트리 없이 저장소 루트 `/home/user/handicap`, 브랜치 `ccr-7683ac09-t7d25q`. subagent prompt 첫 줄은 `cd /home/user/handicap`.
- 화면 문구는 **`text.rs` 상수만**, spec의 글자 그대로. GUI와 같은 뜻의 문구는 `ui/src/i18n/ko.ts` 값과 글자까지 같게 하고 `mirrored_text_exists_in_ko_ts`에 행을 더한다(Task 2).
- **응답 값을 품는 타입은 derive `Debug` 금지** — `ValueRow`·`ValueList`·`ValuesState`·`CondTarget`은 손 `Debug`(종류·길이만). `Overlay`·`EditUi`·`Change`의 기존 손 `Debug`에 새 갈래를 **종류만** 더한다. 로그(`tracing`)에 값·경로·헤더 이름을 남기지 않는다.
- 원격 글자(헤더 이름·값·본문 키·값)는 폭 계산 **전에** `inspect::sanitize`.
- 값 목록은 **열 때 한 번** 만든다(그릴 때 파싱 금지). 그릴 때 계산하는 것은 표지(§2.6)뿐.
- 값 목록 커서는 `ValuesState.cursor` — `EditUi.list_cursor`를 쓰지 않는다(spec §4.2).
- tdd-guard: 각 task의 **첫 편집은 테스트 파일**(Step 1). 새 테스트 파일은 `crates/tui/tests/` 아래.
- 각 task = 독립 green 커밋. 커밋·검증은 단일 FOREGROUND 호출(600000ms), `| tail`/`| head` 금지, `--no-verify` 금지, 커밋 메시지는 `-F <파일>`. 이 컨테이너엔 `cargo-nextest`가 없어 pre-commit이 `cargo test --workspace`로 돈다(수 분).
- 회귀 가드를 표방하는 테스트는 **고의 회귀 → RED → 원복 → GREEN**을 실증하고 보고서에 남긴다(각 task의 "이빨 실증" 목록).
- 줄 번호는 이 plan을 쓴 시점(`f4df6f6`) 값 — 편집 전에 `grep -n`으로 다시 확정한다.

## Review Focus

1. **칸이 맞는가**: `a`로 연 `EditUi`의 보드·칸 = 보고 있는 기록의 보드·칸(남아 있던 다른 칸의 `EditUi`를 쓰지 않는다). 저장 요청의 `panel_id`로 단언. → Task 5.
2. **늘 실패하는 조건을 만들지 않는가**: 엔진이 자른 본문에 `본문 전체` 줄 없음, 인증 헤더의 가린 값이 비교값으로 안 들어감. → Task 1·2.
3. **경로**: 만든 경로가 전부 서버 허용 문법 안이고 서버와 같은 값을 찾는가(감싼 JSON 안쪽 포함). → Task 1 성질 테스트 + Task 6 통합.
4. **GUI와 같은 기본 조건**(★ 두 행 제외), 막힘 순서(2개 → 중복 → 인증 헤더). → Task 2.
5. **값이 새지 않는가**: 손 `Debug`, 5분 복귀가 값 목록·창·`restore`를 버리는가, `sanitize`(값 목록 줄·선택 창 머리·조건 칸의 받은 값). → Task 1·3·4.
6. **커서**: 칸 설정 경로에서 저장 성공 뒤 값 목록 커서가 그대로. → Task 4.
7. **`Esc` 사슬과 `EditUi` 수명**: 오류 보기 경로 = 값 목록을 나가면 `EditUi` 없음, 칸 설정 경로 = 남음. 저장 중 `Esc` 무시. → Task 4(9-1·10)·Task 5.
8. **11·12 `a`**: 10개·2개면 요청 없음, 종료 확인창이 떠 있을 때 기록이 와도 창이 안 닫힘, 표지 1회. → Task 7.
9. 기존 동작 회귀: 2a 조건 수정(`CondTarget::Existing`)·기준선 `a`·메뉴 `r`·오류 보기 → 자세히 → 요청·응답의 키.

## File Map

| 파일 | Task | 무엇 |
|---|---|---|
| `crates/tui/src/pick.rs`(새) · `lib.rs` | 1, 2 | 값 목록·경로·기본 조건·막힘·표지·`ValuesState`·`open_values`·`auto_target` |
| `crates/tui/src/text.rs` | 1, 2, 3, 5, 7 | 새 문구 |
| `crates/tui/src/edit.rs` | 2, 7 | `add_condition`·`add_display`, `edit_kind` 11·12 |
| `crates/tui/src/view/values.rs`(새) · `view/mod.rs` · `view/edit.rs` · `view/settings.rs` | 3, 7 | 값 목록 그리기, 조건 칸의 새 줄, 선택 창, 하위 목록 키 줄 |
| `crates/tui/src/app.rs` | 4, 5, 7 | 화면·상태·키·저장 연결 |
| `crates/tui/src/inspect.rs` | 7 | `RecordState.auto_values` |
| `crates/tui/tests/pick_test.rs`(새) · `values_view_test.rs`(새) · `app_test.rs` · `edit_test.rs` · `edit_view_test.rs` · `view_test.rs` · `judge_parity_test.rs` · `save_flow_test.rs` · `inspect_test.rs` | 1–7 | 테스트 |
| 문서 | 8 | 상위 spec·매뉴얼·이 spec 상태 줄 |

---

### Task 1: 값 목록 만들기 (`pick.rs` — 순수)

spec §2.1, §4.1. US1·US4의 토대.

**Files:**
- Create: `crates/tui/src/pick.rs`, `crates/tui/tests/pick_test.rs`.
- Modify: `crates/tui/src/lib.rs`(`pub mod pick;`), `crates/tui/src/text.rs`.

**Interfaces (Produces):**
- `pub enum PickValue { Status(u16), Header(String), Null, Bool(bool), Number(String), Str(String), BodyText }` — `Number`는 §2.4의 숫자 글자(정수 그대로, 소수는 Rust `f64` `{}` 표기).
- `pub enum RowKind { Status, Header { name: String }, Body { path: String }, BodyText }`.
- `pub struct ValueRow { pub kind: RowKind, pub value: PickValue }` + `pub fn target(&self) -> String`(대상 글자 — `panel_settings::condition_target`에 `Condition { source, path, .. }`을 넣어 얻는다) + `pub fn shown(&self) -> String`(받은 값 글자: 문자열은 `"…"`, `Null`은 `null`, `BodyText`는 `text::PICK_BODY_TEXT_VALUE`).
- `pub enum ListNote { Unwrapped, EngineTruncated, Clipped(u32), TooLarge, TooDeep, LaterRun }` + `pub fn text(&self) -> String`.
- `pub struct ValueList { pub rows: Vec<ValueRow>, pub notes: Vec<ListNote> }`.
- `pub fn value_list(resp: &handicap_engine::TracedResponse, clipped_resp: bool, limit_kb: u32) -> ValueList`.
- `pub enum Seg { Key(String), Index(usize) }`, `pub fn segments_to_path(segs: &[Seg]) -> String`.
- `text.rs`: `PICK_BODY_TEXT_VALUE = "글자 포함 조건으로"`, `PICK_UNWRAPPED = "문자열로 감싼 JSON을 풀어서 표시 중"`, `PICK_ENGINE_TRUNCATED = "1 MiB에서 잘린 응답은 본문 조건을 달 수 없습니다"`, `PICK_TOO_LARGE = "64KB를 넘는 본문은 값을 고를 수 없습니다"`, `PICK_TOO_DEEP = "너무 깊게 중첩된 본문은 값을 고를 수 없습니다"`, `PICK_LATER_RUN = "같은 스텝이 뒤에 다시 실행됐습니다 — 판정은 마지막 실행의 응답을 봅니다"`. 기록 상한 문구는 기존 `text::record_clipped(limit_kb)`.
- 손 `Debug`: `PickValue`·`ValueRow`·`ValueList`(종류와 글자 수만 — 예: `Str(len=5)`, `Body(path_len=12)`).

**규칙(spec §2.1 그대로 — 여기 적은 것은 구현 지침):**
- 줄 순서: 응답 코드 → 헤더(`resp.headers`는 `BTreeMap` — 그 순서) → 본문 표의 첫 번째로 맞는 행. `LaterRun` 안내는 이 함수가 내지 않는다(Task 2 `open_values`).
- 본문 읽기는 **순서를 지키는 작은 트리**(비공개 `enum Node { Null, Bool(bool), Num(String), Str(String), Arr(Vec<Node>), Obj(Vec<(String, Node)>) }` + 손 `Deserialize`/`Visitor`). 객체에서 같은 키가 다시 나오면 **자리는 처음 것, 값은 뒤 것**. 숫자는 `visit_u64`/`visit_i64` → `to_string()`, `visit_f64` → `format!("{}")`.
- 감싼 JSON 풀기: 서버 `check.rs` `unwrap_json_str`와 같은 규칙(JSON 공백 4종 뒤 첫 글자가 `{`·`[`·`"`인 문자열만 시도, 최대 3겹, 객체·배열이 되면 그 값, 아니면 원래 문자열 그대로). 뿌리 문자열에 한 번, 그 뒤 모든 문자열 값에 한 번씩(푼 값 안쪽도 계속 본다). 한 겹이라도 풀었으면 `ListNote::Unwrapped`.
- 깊이: 줄을 내며 걷는 동안 객체·배열 중첩을 센다(풀기로 생긴 것 포함). 64를 넘으면 그 자리에서 멈추고 표 6행. `serde_json` 오류 문구가 `recursion limit exceeded`로 시작하면(128단) 5행이 아니라 6행.
- 64KB 판정은 `resp.body.len() > inspect::PRETTY_MAX_BYTES`(읽기 전에).
- 뿌리가 스칼라면 경로 `$` 한 줄. 빈 객체·빈 배열은 줄 없음(본문 줄이 0개여도 7행이다 — `본문 전체`로 바꾸지 않는다, GUI 트리와 같다).
- `segments_to_path`: spec §2.1 "경로 글자"(`\u` 뒤는 소문자 16진 4자리).

- [ ] **Step 1: 실패하는 테스트 작성** (`crates/tui/tests/pick_test.rs`)
  도우미: `fn resp(status: u16, headers: &[(&str, &str)], body: &str) -> TracedResponse`(나머지 필드 기본값 — `grep -n "pub struct TracedResponse" -A9 crates/engine/src/trace.rs`로 필드 확인), `fn targets(l: &ValueList) -> Vec<String>`, `fn shown(l: &ValueList) -> Vec<String>`.
  1. `rows_in_order`: 헤더 2개 + `{"b":1,"a":"x","c":{"d":null,"e":[true,2.5]}}` → 대상 `["상태코드", "헤더 …"×2, "b", "a", "c.d", "c.e[0]", "c.e[1]"]`, 받은 값 `["200", …, "1", "\"x\"", "null", "true", "2.5"]`. **`b`가 `a`보다 먼저**(정렬이 아님).
  2. `duplicate_key_last_value_first_position`: `{"a":1,"b":2,"a":3}` → `["a", "b"]`, `a`의 값 `3`.
  3. `root_scalar_and_empty_containers`: `7` → 대상 `본문`·경로 `$`; `"hello"` → `본문`; `{}`·`[]`·`{"a":{},"b":[]}` → 본문 줄 0개이고 `본문 전체`도 없음.
  4. `body_table`(spec §2.1 표 7행 각각, 헤더 없이 코드 줄 + 본문 줄만 본다):
     - 빈 본문·잘림 없음 → 본문 줄 없음·안내 없음.
     - `body_truncated: true`(본문 `{"a":1}`) → `본문 전체` **없음**, 안내 `[EngineTruncated]`.
     - `body_truncated: true` + `clipped_resp: true` → 위와 같다(2행이 이김).
     - `clipped_resp: true`, 본문 `{"a":` → `본문 전체` + `[Clipped(128)]`.
     - `clipped_resp: true`, 본문 `""`(상한이 다 차서 빈 글자) → `본문 전체` + `[Clipped(128)]`.
     - 65KB JSON → `본문 전체` + `[TooLarge]`.
     - `not json` → `본문 전체`, 안내 없음.
     - 65단 중첩 `[[[…]]]` → `본문 전체` + `[TooDeep]`; 64단 → 본문 값 줄(안쪽 스칼라 하나).
     - 200단 중첩(serde 재귀 상한) → `본문 전체` + `[TooDeep]`.
  5. `unwrap_rules`: 뿌리 1·2·3겹 감싼 `{"a":1}` → 줄 `a`, `[Unwrapped]`; 4겹 → 뿌리 스칼라 줄(`본문`) 하나·`Unwrapped` 없음; 필드 `{"p":"{\"id\":7}"}` → 줄 `p.id`(값 `7`)이고 `p` 자체 줄은 없음; `{"p":"plain {"}`·`{"p":"  [1"}`(깨진 JSON)·`{"p":"7"}` → `p` 문자열 줄 그대로·`Unwrapped` 없음; 풀기 포함 깊이 상한(63단 안의 문자열이 3단짜리 JSON → `TooDeep`).
  6. `paths_match_gui_shape`(`ui/src/scenario/jsonPath.ts` `segmentsToPath` 대조표 — 주석에 TS 줄 번호): `[Key("a")]` → `$.a`; `[Key("a_1"), Index(0)]` → `$.a_1[0]`; `[Key("1a")]` → `$['1a']`; `[Key("a.b")]` → `$['a.b']`; `[Key("it's")]` → `$['it\'s']`; `[Key("a\\b")]` → `$['a\\\\b']`(역슬래시 2개); `[Key("\u{1f}")]` → `$['\u001f']`; `[Key("")]` → `$['']`; `[Key("한글")]` → `$['한글']`(GUI `IDENT_RE`는 ASCII만 식별자); `[]` → `$`.
  7. **`every_path_resolves_like_server`**(성질): 픽스처 본문 여럿(식별자 키·점/공백/작은따옴표/큰따옴표/역슬래시/제어 문자/한글/빈 키·배열·중첩·감싼 JSON 필드·뿌리 감싼 JSON)에 대해 `value_list`의 **모든 `Body` 줄**이 ① `jsonpath_is_simple(path) && jsonpath_is_valid(path)` ② 서버와 같은 순서로 찾은 값과 같다 — 테스트 안에 서버 규칙을 `serde_json::Value`로 다시 적는다(`shallow` = 뿌리만 푼 값, `nested` = 모든 문자열 필드를 푼 값; `jsonpath_first(&shallow, p).or_else(|| jsonpath_first(&nested, p))`), 찾은 값의 `handicap_engine::extract::stringify`가 줄의 값 글자(따옴표 뗀 것, `null`은 빈 글자)와 같다(숫자는 `parse::<f64>()`끼리 비교).
  8. `debug_hides_values`: `format!("{:?}", value_list(&resp(200, &[("x-secret","TOKEN123")], r#"{"k":"BODYSECRET"}"#), false, 128))`에 `TOKEN123`·`BODYSECRET`·`x-secret`·`$.k`가 **없고** 줄 수(또는 길이 숫자)는 있다.
- [ ] **Step 2: 구현** — `pick.rs`(위 Interfaces), `lib.rs`에 모듈, `text.rs` 상수.
- [ ] **Step 3: 이빨 실증** — ① 순서 트리를 `BTreeMap`/`serde_json::Value`로 바꾸면 1번 RED ② 2행 판정(`body_truncated`)을 빼면 4번 RED ③ `clipped_resp ||`를 빼면 4번(빈 글자 잘림) RED ④ 필드 풀기를 끄면 5·7번 RED ⑤ 손 `Debug`를 derive로 바꾸면 8번 RED. 원복 뒤 GREEN.
- [ ] **Step 4: 검증** — `cargo test -p handicap-tui --test pick_test` → `cargo clippy -p handicap-tui --all-targets -- -D warnings`.
- [ ] **Step 5: 커밋** — `feat(tui): 응답 값 목록 만들기 — 경로·감싼 JSON 풀기·본문 한도`.

---

### Task 2: 기본 조건·막힘·표지·값 목록 상태 + 편집 변환

spec §2.2–§2.6, §4.1. US1·US2·US4의 규칙.

**Files:**
- Modify: `crates/tui/src/pick.rs`, `crates/tui/src/edit.rs`, `crates/tui/src/text.rs`.
- Test: `crates/tui/tests/pick_test.rs`, `crates/tui/tests/edit_test.rs`, `crates/tui/tests/judge_parity_test.rs`.

**Interfaces (Produces):**
- `pub const AUTH_HEADERS: [&str; 4]` + `pub fn is_auth_header(name: &str) -> bool`(§2.3의 4종 — 앞뒤 공백·대소문자 무시. 컨트롤러 `AUTH_HEADERS`는 `pub(crate)`라 TUI에 같은 4개를 적고, 아래 대조 테스트로 어긋남을 막는다).
- `pub enum Hint { Volatile, Masked }`(`text()` → `text::COND_VOLATILE_HINT` / `text::PICK_MASKED_HINT`).
- `pub struct Draft { pub cond: Condition, pub hint: Option<Hint>, pub focus_value: bool }`.
- `pub fn default_condition(step_id: &str, row: &ValueRow) -> Draft` — spec §2.4 표. 우선순위: 인증 헤더 → 입력줄이 못 받는 값(`LineInput::new(v, InputMode::Text { max_chars: 2000 }).text() != v`) → 40자 초과(글자 수 `chars().count()`) → `=`. `focus_value`는 `본문 전체`만 `true`.
- `pub fn display_item(step_id: &str, row: &ValueRow) -> Option<DisplayItem>`(`BodyText`는 `None`).
- `pub fn cond_block(p: &PanelConfig) -> Option<&'static str>`(10개면 `text::COND_MAX`).
- `pub fn display_block(p: &PanelConfig, item: &DisplayItem) -> Option<&'static str>` — 순서: 2개 → 같은 `step_id`·`source`·`path`(글자 그대로) → 인증 헤더.
- `pub fn marks(p: &PanelConfig, step_id: &str, row: &ValueRow) -> (usize, bool)` — (그 스텝·그 대상의 조건 수, 표시 값 있음). `source`·`path` 글자 그대로 비교.
- `pub enum Blocked { OtherStep { name: String }, NoResponse }`(`text()`).
- `pub struct ValuesState { pub step_id: String, pub list: ValueList, pub blocked: Option<Blocked>, pub cursor: usize }`(`Clone`, 손 `Debug`).
- `pub fn open_values(panel: &PanelConfig, trace: &ScenarioTrace, trace_idx: usize, clipped_resp: bool, limit_kb: u32, names: &Names) -> ValuesState` — spec §2.2. 스텝 칸(`panel.step_id` 있음)인데 `trace.steps[trace_idx].step_id`가 다르면 `OtherStep`(이름 = `names.step_name(&panel.scenario_id, 칸 스텝)` 없으면 id), 응답 없으면 `NoResponse`, 아니면 `value_list` + (같은 `step_id`의 `StepKind::Http` 실행이 `trace_idx` **뒤에** 있으면 `notes` 맨 앞에 `LaterRun`). `step_id` = 그 trace 스텝의 id(스텝 칸에선 칸 스텝과 같다).
- `edit.rs`: `pub fn add_condition(cfg: &BoardConfig, panel_idx: usize, c: Condition) -> BoardConfig`, `pub fn add_display(cfg: &BoardConfig, panel_idx: usize, d: DisplayItem) -> BoardConfig` — 끝에 붙임, 스텝 칸이면 `step_id`를 칸의 스텝으로 덮어씀(GUI `addCondition`·`addDisplay`의 `ownStep`), 다른 칸 불변(기존 `with_panel` 도우미).
- `text.rs`: `COND_ADD_CHOICE = "조건으로 추가"`, `DISPLAY_ADD_CHOICE = "화면에 추가"`, `COND_MAX = "조건은 최대 10개까지 추가할 수 있습니다"`, `DISPLAY_MAX = "화면 표시는 최대 2개까지"`, `DISPLAY_DUP = "이미 화면에 표시 중"`, `DISPLAY_AUTH_HEADER = "인증 헤더는 화면에 표시할 수 없음"`, `COND_VOLATILE_HINT = "매번 바뀌는 값이면 '='은 매 점검 실패하고 그 값이 화면에 표시됩니다"`, `PICK_MASKED_HINT = "가려진 값이라 비교값을 채우지 않았습니다"`, `pub fn pick_other_step(name: &str) -> String`(`이 칸은 "{name}" 스텝만 봅니다 — 그 스텝의 요청·응답에서 추가하세요`), `PICK_NO_RESPONSE = "응답이 없어 고를 값이 없습니다"`.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `pick_test.rs`:
    1. `default_condition_table`(spec §2.4 표 + `ui/src/monitor/conditions.ts` `defaultCondition` 대조 — 주석에 TS 줄): 응답 코드 200 → `status`·`""`·`Eq`·`"200"`; 본문 `null` → `Exists`·값 빈; 숫자 `7`·참거짓 `true` → `Eq`·그 글자; 문자열 40자 → `Eq`·그 값·안내 없음; 41자 → `NotEmpty`·빈 값·`Volatile`; 빈 문자열 → `Eq`·`""`; 보통 헤더 `x-id: abc` → `header`·`x-id`·`Eq`·`abc`; 헤더 41자 → `NotEmpty`·`Volatile`; `본문 전체` → `body_text`·`Contains`·빈 값·`focus_value`. 모든 행 `ignore_case`·`trim` = false, `step_id` = 넘긴 값.
    2. `default_condition_deviations`(★ 두 행): `set-cookie: sid=••••`·` Authorization `(공백)·`COOKIE`·`proxy-authorization` → `NotEmpty`·빈 값·`Masked`(값이 5자여도); 40자 넘는 인증 헤더도 `Masked`(`Volatile` 아님); 본문 문자열 `"a\nb"`·`"a\u{202e}b"`·`"a\u{85}b"` → `NotEmpty`·빈 값·`Volatile`.
    3. `display_block_order`: 표시 값 2개 + 같은 대상 + 인증 헤더 → `DISPLAY_MAX`; 1개(같은 대상) → `DISPLAY_DUP`; 1개(다른 대상)·인증 헤더 → `DISPLAY_AUTH_HEADER`; 0개·보통 값 → `None`; 같은 경로·다른 `step_id`는 중복 아님. `cond_block`: 9개 `None`, 10개 `COND_MAX`. `display_item(BodyText)` → `None`.
    4. `marks_counts`: 조건 0·1·2개(같은 스텝·같은 대상), 다른 스텝의 같은 경로는 세지 않음, 표시 값 있음/없음, 헤더는 이름 글자 그대로.
    5. `open_values_rules`: 스텝 칸 + 다른 스텝 → `OtherStep { name }`(이름 해석·없으면 id), 줄 0개; **묶음이 아닌 `step_id` 칸**도 제한; 응답 `None` → `NoResponse`; 흐름 전체 칸은 아무 스텝이나 → 줄 있음·`step_id` = 그 스텝; 같은 스텝이 뒤에 또 실행된 trace의 앞 실행 → `notes[0] == LaterRun`, 마지막 실행 → 없음; `If` 줄은 세지 않음.
    6. `values_state_debug_hides_values`.
    7. `auth_headers_match_controller`: `crates/controller/src/monitor/config.rs`를 글자로 읽어(`concat!(env!("CARGO_MANIFEST_DIR"), "/../controller/src/monitor/config.rs")`) `const AUTH_HEADERS` 줄부터 `];`까지의 따옴표 글자들을 뽑아 `pick::AUTH_HEADERS`와 **집합이 같다**(`mirrored_text_exists_in_ko_ts`와 같은 방식 — 컨트롤러 목록이 바뀌면 RED).
  - `edit_test.rs`: `add_condition_appends`(끝에 붙음·다른 칸 불변·흐름 칸은 `step_id` 그대로·스텝 칸은 칸 스텝으로 덮어씀), `add_display_appends`(같은 4가지).
  - `judge_parity_test.rs` `mirrored_text_exists_in_ko_ts`의 표에 행: `("condChooseCondition", text::COND_ADD_CHOICE)`, `("condChooseDisplay", text::DISPLAY_ADD_CHOICE)`, `("condMax", text::COND_MAX)`, `("displayMax", text::DISPLAY_MAX)`, `("displayDup", text::DISPLAY_DUP)`, `("displayAuthHeader", text::DISPLAY_AUTH_HEADER)`, `("previewUnwrapped", text::PICK_UNWRAPPED)`, `("condVolatileHint", text::COND_VOLATILE_HINT)`.
- [ ] **Step 2: 구현.**
- [ ] **Step 3: 이빨 실증** — ① 인증 헤더 우선순위를 빼면 1-2 RED ② `display_block` 순서를 바꾸면 1-3 RED ③ `open_values`의 제한을 `group_id.is_some()`으로 좁히면 1-5 RED ④ `add_condition`의 덮어쓰기를 빼면 `edit_test` RED ⑤ `text::COND_MAX` 글자를 하나 바꾸면 `mirrored_text_exists_in_ko_ts` RED.
- [ ] **Step 4: 검증** — `cargo test -p handicap-tui` 전체 + clippy.
- [ ] **Step 5: 커밋** — `feat(tui): 값 고르기 규칙 — 기본 조건·막힘·표지·스텝 제한, 조건·표시 값 추가 변환`.

---

### Task 3: 값 목록 화면·창 그리기 (뷰만)

spec §3.1, §3.2. 뷰 모델만 받아 그린다(`app.rs` 연결은 Task 4·5).

**Files:**
- Create: `crates/tui/src/view/values.rs`, `crates/tui/tests/values_view_test.rs`.
- Modify: `crates/tui/src/view/mod.rs`(`pub mod values;`), `crates/tui/src/view/edit.rs`(`CondFormView`·`render_cond_form`·`cond_form_lines`), `crates/tui/src/view/settings.rs`(`OverlayView`·`overlay_rows`), `crates/tui/src/text.rs`.
- Test: `crates/tui/tests/values_view_test.rs`, `crates/tui/tests/edit_view_test.rs`.

**Interfaces (Produces):**
- `view/values.rs`:
  - `pub struct ValueRowView { pub target: String, pub shown: String, pub cond_marks: usize, pub display_mark: bool }`(손 `Debug` 없음 — `Debug`를 아예 달지 않는다).
  - `pub struct ValuesView<'a> { pub title: &'a str, pub notes: Vec<String>, pub blocked: Option<String>, pub rows: Vec<ValueRowView>, pub cursor: usize, pub overlay: Option<OverlayView<'a>>, pub form: Option<&'a CondFormView<'a>> }`.
  - `pub fn render_values(f: &mut Frame, head: &HeaderView, v: &ValuesView, keys: &[&str])` — `render_frame`(머리 줄·무입력 안내·키 줄) 안에: 제목 줄(오른쪽 `{커서+1}/{전체}` — 폭이 모자라면 통째 생략, 줄이 0개면 없음) → 안내 줄들 → 표 머리(`대상`/`받은 값`) → 줄(창에 맞춰 밀기 — 고른 줄이 늘 보인다) → 맨 아래 overlay 줄 또는 조건 칸(2a `render_list_with_form`과 같은 자리 규칙: 창·칸 높이만큼 목록 영역이 줄어든다).
  - `pub fn mark_text(cond_marks: usize, display_mark: bool) -> String`(`""`·`조건`·`조건 2`·`표시`·`조건 · 표시`·`조건 2 · 표시`).
  - `pub fn fit_head(s: &str, w: usize) -> String`(넘치면 **앞**을 `…`로 — 끝이 보인다).
  - 폭 규칙(spec §3.1): 대상 칸 = min(가장 긴 대상 폭, 본문 폭의 절반), 대상은 `fit_head`, 받은 값은 기존 `fit`(뒤 `…`), 표지는 (`▶`+대상 칸+2+받은 값 최소 4칸+2+표지 폭)이 본문 폭을 넘으면 그 줄에서 통째 생략. 모든 빼기는 `saturating_sub`.
  - 높이 규칙: 줄이 1줄도 안 남으면 안내 줄 → 표 머리 순으로 뺀다. `blocked`가 있으면 줄·표 머리 없이 그 한 줄(`wrap_width`로 줄바꿈).
- `view/settings.rs`: `OverlayView::Choice { head: String, options: [(&'a str, Option<&'a str>); 2], cursor: usize }` — `overlay_rows`가 머리 줄(`{대상}  =  {받은 값}`, `sanitize` + `fit`) + 두 줄(`▶`/공백 + 이름, 막힌 줄은 ` — {이유}`를 붙여 흐리게)을 낸다. 목록 창(`render_pick`)을 쓰지 않는 **아래 붙는 줄 방식**(입력줄·확인 줄과 같은 자리).
- `view/edit.rs`: `CondFormView`에 `pub received: Option<&'a str>`(대상 줄 아래 `받은 값` 줄)·`pub hint: Option<&'a str>`(맨 아래 안내 줄, 흐리게). `cond_form_lines`가 두 줄을 센다. 높이가 모자라면 `hint` → `received` 순으로 뺀다(오류 줄·규칙·값·체크가 먼저). 기존 호출부(`app.rs` `draw_edit`)·테스트(`edit_view_test.rs` `form` 도우미)는 `received: None, hint: None`.
- `text.rs`: `PICK_TITLE_SUFFIX = " — 값 고르기"`, `PICK_COL_TARGET = "대상"`(= 기존 `COND_FORM_TARGET`와 같은 글자 — 그 상수를 재사용), `PICK_COL_VALUE = "받은 값"`, `MARK_COND = "조건"`, `MARK_DISPLAY = "표시"`.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `values_view_test.rs`(도우미는 `edit_view_test.rs`의 `buffer_text`·`head`·`row_with`·`find_cell`을 복사):
    1. `renders_rows_and_marks`(80×24): 제목 + `4/8`, 표 머리, 각 줄의 대상·받은 값, `조건`·`표시` 표지가 그 줄 오른쪽 끝.
    2. `selected_row_highlight`: 고른 줄의 **본문 줄 칸**(머리 줄 y=0이 아님) 바탕이 선택 색, 다른 줄은 아님(선택 스타일을 지우면 RED).
    3. `cursor_always_visible`: 줄 200개·커서 150·높이 12 → 고른 줄의 대상이 화면에 있다.
    4. `long_target_keeps_tail`: 300자 경로 → 화면에 `…`로 시작하고 **끝 키 이름**이 보인다; 받은 값은 뒤 `…`.
    5. `notes_and_blocked`: 안내 줄 2개가 표 머리 위; `blocked: Some(..)` → 그 문구만(표 머리·줄 없음), 80칸에서 줄바꿈.
    6. `low_height_drops_notes_first`: 높이를 줄여 가며 줄이 최소 1개 남고 안내 → 표 머리 순으로 빠진다.
    7. `width_sweep_no_panic`: 폭 1..=120 × 높이 {3, 6, 10, 24} × (overlay 없음 / `Choice` / 조건 칸) × 커서 {0, 중간, 끝} — 패닉 없음(넓은 글자 대상·빈 값 포함).
    8. `remote_strings_sanitized`: 대상·값에 `\u{1b}[31m`·`\u{202e}` → 화면에 `\u{FFFD}`가 **보인다**(긍정 단언).
    9. `choice_rows`: `Choice` — 머리 줄, 고른 줄 `▶`, 막힌 줄에 ` — 화면 표시는 최대 2개까지`.
  - `edit_view_test.rs`: `cond_form_received_and_hint`(두 줄이 그려지고, 높이가 모자라면 안내 → 받은 값 순으로 빠지며 규칙·값 줄은 남는다), `cond_form_received_sanitized`(`received`에 `\u{1b}[31m`·`\u{202e}` → 화면에 `\u{FFFD}`가 보인다 — `sanitize`를 빼면 RED), 기존 `form` 도우미에 새 필드.
- [ ] **Step 2: 구현.**
- [ ] **Step 3: 이빨 실증** — ① 선택 스타일 제거 → 2번 RED ② `fit_head`를 `fit`으로 → 4번 RED ③ **받은 값 칸 폭 계산**(본문 폭 − `▶` − 대상 칸 − 간격)의 `saturating_sub`를 `-`로 → 7번이 폭 1~3에서 패닉으로 RED(실증에 쓴 식과 폭을 보고서에 적는다 — 넘칠 수 없는 빼기를 골라 GREEN이 나오면 실증이 아니다) ④ `sanitize` 제거 → 8번 RED.
- [ ] **Step 4: 검증** — `cargo test -p handicap-tui` 전체 + clippy.
- [ ] **Step 5: 커밋** — `feat(tui): 값 목록 화면·선택 창 그리기, 조건 칸에 받은 값·안내 줄`.

---

### Task 4: 편집 상태·키·저장 연결 (`app.rs` — 순수 함수)

spec §2.3–§2.6, §4.2. `App` 연결(요청·응답의 `a`, 그리기)은 Task 5.

**Files:**
- Modify: `crates/tui/src/app.rs`.
- Test: `crates/tui/tests/app_test.rs`.

**Interfaces (Produces):**
- `Screen::Values`. `is_sub`에 추가.
- `EditUi.values: Option<pick::ValuesState>`(손 `Debug`는 있는지만). `idle_drop`이 `None`으로.
- `pub enum CondTarget { Existing(usize), New { step_id: String, source: ConditionSource, path: String, shown: String, hint: Option<pick::Hint> } }`(`Clone + PartialEq + Eq`, 손 `Debug` — 종류만). `Overlay::CondForm`의 `index: usize` → `target: CondTarget`. 기존 사이트(`grep -rn "Overlay::CondForm" crates/tui/src crates/tui/tests` — src 14줄·테스트 6줄)를 전부 `CondTarget::Existing(i)`로 옮긴다. `with_error`와 `cond_key`의 `restore`는 `target`을 그대로 옮긴다.
- `Overlay::AddChoice { cursor: usize, cond_block: Option<&'static str>, display_block: Option<&'static str> }`(`kind()` = `"AddChoice"`).
- `Change::AddCondition(Condition)`·`Change::AddDisplay(DisplayItem)`(`Debug`는 `"AddCondition"`·`"AddDisplay"`). `apply_change` → `edit::add_condition`·`add_display`. `confirm_for`·`pending_of`는 `None`(기존 `_ =>` 갈래).
- `edit_key`: 화면 규칙에 `Screen::Values`(이동·`PgUp`/`PgDn`/`Home`/`End`·`Enter` = `Activate`·`Esc` = `Back`·`q`/`Ctrl+C` = `AskQuit`·그 밖 무동작. 숫자·`r`·`a`·`d`·`s`·`v`는 무동작).
- `overlay_key`: `Overlay::AddChoice` → `Overlay::Pick`과 같은 키(`PickMove`·`PickChoose`·`PickCancel`·`AskQuit`).
- `edit_apply`:
  - `MoveCursor`·`Jump` on `Screen::Values` → `values.cursor`(줄 수로 가둠, `list_cursor` 불변).
  - `Activate` on `Screen::Values` → 새 `fn activate_value(ui, p)`: `values`가 없거나 `blocked`거나 줄이 없으면 무동작. `BodyText` 줄 → `cond_block`이면 `Notice(이유)`, 아니면 조건 칸(`New`). 그 밖 → 둘 다 막혔으면 `Notice("{조건 이유} · {표시 이유}")`, 아니면 `AddChoice`(커서 = 안 막힌 첫 줄).
  - `PickMove` in `AddChoice` → 커서 0↔1(가둠). `PickChoose` in `AddChoice` → 고른 줄이 막혔으면 무동작; 0 → 조건 칸(`New`, `pick::default_condition`의 규칙·값·`focus_value`); 1 → `commit(Change::AddDisplay(item), restore None)`. `PickCancel` → 창 닫힘.
  - 조건 칸(`New`)을 여는 공통 함수: `ops = edit::ops_for(source)`, `op` = 기본 규칙의 위치, 값 = `LineInput::new(기본 값, Text{2000})`, `focus` = `focus_value`면 `CondFocus::Value` 아니면 `Op`.
  - `cond_key`의 `Enter`: `Existing(i)` → 지금과 같다(`Change::Condition`); `New{..}` → `Change::AddCondition(Condition { step_id, source, path, op, value(규칙이 값이 필요 없으면 빈), ignore_case, trim })`.
- `SubViews::back(&Screen::Values)` → `edit.values = None`, 그 기록이 `RecordOrigin::Errors`면 `self.edit = None`, `Some(Screen::Body)`(`body`·`record`는 그대로).
- `edit_keys`: `Screen::Values` + 창 없음 → 줄이 있고 막히지 않았으면 `[KEYS_PICK, KEYS_ADD_ENTER, KEYS_TO_BODY]`, 아니면 `[KEYS_TO_BODY]`; `AddChoice` → `[KEYS_PICK, KEYS_CHOOSE, KEYS_CANCEL]`. `text.rs`: `KEYS_ADD_ENTER = "Enter 추가"`, `KEYS_TO_BODY = "Esc 요청·응답으로"`, `KEYS_CHOOSE = "Enter 선택"`.
- `overlay_view`: `Overlay::AddChoice` → `OverlayView::Choice`(머리 = 고른 줄의 `target()`·`shown()` — 함수 인자에 `values`가 필요하다: 시그니처에 `Option<&pick::ValuesState>`를 더하거나 `AddChoice` 갈래만 호출 쪽에서 만든다. 어느 쪽이든 기존 호출부 2곳 — `pump_settings`·`draw_edit`, `grep -n "overlay_view(" crates/tui/src/app.rs` — 를 맞춘다).

- [ ] **Step 1: 실패하는 테스트 작성** (`app_test.rs` — 기존 `ek`·`ui_with`·`ch`·`key`·`ctrl`·`result` 도우미 + 새 도우미 `values_ui(rows…)`·`ctx_with(boards…)`. `edit_apply`를 부르는 기존 테스트의 `EditCtx` 만드는 법은 `grep -n "EditCtx {" crates/tui/tests/app_test.rs`)
  1. `values_keys`: `Screen::Values`에서 `↓`/`j`·`↑`/`k`·`PgDn`·`Home`·`End` → 이동 동작, `Enter` → `Activate`, `Esc` → `Back`, `q`·`Ctrl+C` → `AskQuit`, `Ctrl+B`·`1`·`r`·`a`·`d`·`s`·`v` → `None`.
  2. `values_cursor_is_separate`: 이동이 `values.cursor`만 바꾸고 `list_cursor`·`cursor`는 그대로, 끝에서 가둠.
  3. `activate_opens_choice`: 보통 줄 → `AddChoice { cursor: 0, None, None }`; 조건 10개 칸 → 커서 1·`cond_block` 있음; 표시 값 2개 칸 → 커서 0·`display_block` 있음; 둘 다 막힘 → `Notice`에 두 이유; `본문 전체` 줄 → 바로 조건 칸(`New`, 규칙 `Contains`, `focus == Value`); `본문 전체` + 조건 10개 → `Notice(COND_MAX)`; `blocked` 상태·줄 0개 → 창 없음.
  4. `choice_keys_and_blocked_rows`: `AddChoice`에서 `↓`·`↑`·`Enter`·`Esc`·`q`; 막힌 줄에서 `Enter` → 창 그대로·요청 없음.
  5. `choose_condition_opens_prefilled_form`: 문자열 줄 → 조건 칸 `New { source: Body, path, shown: "\"OK\"", hint: None }`, 규칙 `=`, 값 `OK`; 41자 줄 → 규칙 `값 있음`·`hint: Some(Volatile)`; 인증 헤더 줄 → `Some(Masked)`.
  6. `save_new_condition_request`: 조건 칸(`New`)에서 `Enter` → `EditReq::SaveBoard`의 `config.panels[i].conditions` 끝에 새 조건(필드 전부 단언), `panel_id` = `ui.panel_id`, 창 = `Saving { restore: Some(조건 칸) }`. 규칙을 `키 있음`으로 바꾸고 저장 → 값 빈 글자. 스텝 칸이면 `step_id` = 칸 스텝.
  7. `save_new_display_request`: `AddChoice`에서 `화면에 추가` → `display_items` 끝에 추가, `Saving { restore: None }`.
  8. `save_results`: `apply_done` 성공 → 창 닫힘·`values` 그대로·**`values.cursor` 그대로**. 픽스처를 못 박는다: 줄 8개·`values.cursor = 5`·메뉴 커서 `cursor = 10`(11번)·저장 뒤 조건 1개 → `values.cursor == 5`(`apply_done`은 `list_cursor`를 `조건 수 − 1 = 0`으로 자른다 — 커서를 `list_cursor`와 같이 쓰면 5 → 0으로 튀어 RED. 커서가 0·1이면 이 회귀를 못 잡는다), 보드 캐시 갱신 뒤 `pick::marks`가 1. 서버 거절(조건) → 조건 칸이 `error`를 달고 되살아나며 `target`이 `New` 그대로; 거절(표시) → `Notice(서버 문구)`.
  9. `saving_in_flight`: 표(`ticket`)가 있을 때 저장 시도 → `Notice(text::SAVING)`·요청 없음(기존 규칙).
  9-1. `esc_ignored_while_saving`: `Screen::Values` + 창 `Saving` → `Esc`·`Enter`·`↓` = `EditAction::None`, `q` = `AskQuit`(진행 중 저장이 버려지지 않는다).
  10. `back_from_values`: `RecordOrigin::Errors` 기록 + `edit` → `back(&Screen::Values)` = `Screen::Body`, `edit` **None**, `body`·`record` 그대로; `RecordOrigin::Settings` → `edit` Some·`values` None·`cursor` 그대로.
  11. `idle_drops_values`: `idle_drop` 뒤 `values` None·창 없음; `Saving` 중이면 `Saving`은 남고 `restore`·`values`는 None. `idle_expired(&Screen::Values, …)` = 5분 뒤 true.
  12. `existing_condition_edit_unchanged`(회귀): 2a의 조건 수정 테스트가 `CondTarget::Existing`으로 그대로 통과(기존 테스트를 옮긴 것 — 지우지 않는다).
  13. `debug_hides_values`: `format!("{:?}")` — `Overlay::CondForm { target: New{ shown: "SECRETVALUE", path: "$.secretpath", .. }, .. }`·`EditUi { values: Some(..) }`·`Change::AddCondition(..)`에 그 글자들이 없다.
- [ ] **Step 2: 구현.** `draw_edit`의 조건 칸 그리기(`p.conditions.get(*index)`)는 `Existing`만 그리게 맞춘다(`New`의 그리기는 Task 5 — 이 task에서 `Screen::Values`는 아직 그려지지 않는다: `draw_sub`의 `_ => {}` 갈래).
- [ ] **Step 3: 이빨 실증** — ① `values.cursor` 대신 `list_cursor`를 쓰면 8번 RED ② `back`에서 origin 검사를 빼면 10번 RED ③ `with_error`가 `target`을 `Existing(0)`으로 바꾸면 8번 RED ④ `idle_drop`에서 `values`를 안 비우면 11번 RED ⑤ 막힌 줄 `PickChoose` 가드를 빼면 4번 RED.
- [ ] **Step 4: 검증** — `cargo test -p handicap-tui` 전체 + clippy + `cargo build --workspace --tests`.
- [ ] **Step 5: 커밋** — `feat(tui): 값 목록 편집 상태 — 선택 창·새 조건 칸·조건/표시 값 추가 저장`.

---

### Task 5: 요청·응답의 `a` + 그리기 + 키 줄·도움말 (US1·US2·US4 완성)

spec §2.2, §3.3, §4.2("`EditUi`가 누구 것인가"·"그리기").

**Files:**
- Modify: `crates/tui/src/app.rs`, `crates/tui/src/text.rs`.
- Test: `crates/tui/tests/app_test.rs`, `crates/tui/tests/view_test.rs`.

**Interfaces (Produces):**
- `Action::AddValue`. `sub_screen_key`: `(Screen::Body, KeyCode::Char('a')) => Action::AddValue`(`ㅁ`은 `normalize_char`가 이미 `a`로).
- `SubViews::value_target(&self, screen: &Screen, lines: &[StepLine]) -> Option<usize>` — 값 목록을 열 수 있는 자리인가(순수): 화면이 **정확히** `Screen::Body` · `record`가 `Loaded` · `body.line_idx`의 줄이 `StepLine::Http` → 그 `trace_idx`. 아니면 `None`.
- `SubViews::enter_values(&mut self, state: pick::ValuesState, ticket: Option<&SaveTicket>) -> Option<Screen>`(`pick::open_values`와 이름이 겹치지 않게 `enter_`) — `record`가 없으면 `None`. `edit`가 **없거나 `record`의 보드·칸과 다르면** 새 `EditUi { board_id, panel_id, overlay, ..default }`(`overlay` = `OpenSettings`와 같은 규칙: 표가 그 칸이면 `Saving { restore: None }`, 다른 칸이면 `Notice(text::SAVING)`, 없으면 `None` — 그 규칙을 `fn overlay_for_ticket(ticket, board_id, panel_id) -> Option<Overlay>`로 빼 `OpenSettings`도 쓴다). 같은 칸이면 그 `EditUi`를 그대로 쓴다. `edit.values = Some(state)`, `Some(Screen::Values)`.
- `App::apply(Action::AddValue)` = `fn open_values_here(&mut self) -> bool`(Task 7이 다시 쓴다): `views.value_target(&self.screen, &lines)`가 `Some(trace_idx)`이고 칸을 찾았을 때 `pick::open_values(panel, trace, trace_idx, clip_flags(&rec.clipped, trace_idx).1, rec.limit_kb, names)` → `views.enter_values(state, self.save_in_flight.as_ref())` → 화면 전환. 판단은 전부 `value_target`·`enter_values`(순수)에 두고 `App`에는 잇는 코드만 남긴다.
- `on_edit_screen`에 `Screen::Values`. `draw_sub`에 `Screen::Values` 갈래 → 새 `fn draw_values`: 제목 = 요청·응답 화면 제목(`{칸 제목} · {format_hms(at_ms)} · {no} {스텝 이름}`) + `text::PICK_TITLE_SUFFIX`, 줄 = `values.list.rows` → `ValueRowView`(표지 = `pick::marks(지금 칸 설정, …)`), 안내 = `notes`의 `text()`, `blocked`의 `text()`, 창 = `overlay_view`/조건 칸(`New`: 대상 = `"{대상 글자} · {스텝 이름}"`, `received` = `shown`, `hint`). 조건 칸 그리기 재료를 만드는 코드는 `draw_edit`(하위 목록)와 공유한다(`Existing` = 지금 그대로).
- 요청·응답 키 줄: `sub_keys(Screen::Body)`가 `text::KEYS_ADD_VALUE`(`"a 조건·표시 추가"`)를 `KEYS_TO_DETAIL` **바로 앞**에.
- `text::HELP_KEYS` 12줄 — `("a", "요청·응답에서 조건·표시 추가")`를 `Enter` 줄 **뒤**에(설명 30칸 이내 — 한글 2칸으로 28칸).

- [ ] **Step 1: 실패하는 테스트 작성**
  - `app_test.rs`:
    1. `body_a_key`: `Screen::Body`에서 `a`·`A`·`ㅁ` → `Action::AddValue`; `Ctrl+A` → `None`; `Screen::Record`·`Screen::Errors`(여긴 `a` = 전체 회차 토글 그대로)·`Screen::Monitor`에서는 `AddValue`가 아님.
    2. `value_target_rules`: (`Body`, `Loaded`, Http 줄) → `Some(trace_idx)`; `QuitConfirm(Body)`·`Record`·`Values` → `None`; 기록 `Loading`/`Gone` → `None`; `body` 없음 → `None`.
    2-1. `enter_values_creates_edit_for_record_panel`: `edit` 없음 + 기록(보드 B·칸 P) → `edit`의 보드·칸 = B·P, `values` Some, `Screen::Values`.
    3. **`enter_values_replaces_other_panels_edit`**: `edit`가 칸 A(창 없음 — 5분 복귀 뒤 저장이 끝난 상태) + 기록은 칸 B → `edit.panel_id == B`. 이어서 `edit_apply`로 조건 저장 → `EditReq::SaveBoard.panel_id == B`이고 바뀐 칸이 B(칸 A의 조건 수 불변).
    4. `enter_values_keeps_same_panel_edit`: 칸 설정 경로(`edit`가 그 칸·`cursor = 10`) → 같은 `EditUi`(`cursor` 그대로)·`values` Some.
    5. `enter_values_with_save_in_flight`: 새로 만들 때 표가 그 칸 → `Saving { restore: None }`; 다른 칸 → `Notice(text::SAVING)`; `record` 없음 → `None`.
    6. `esc_chain_errors_path`: 오류 목록 → 자세히 → 요청·응답 → 값 목록 → `back`×4 = 요청·응답 → 자세히 → 목록 → 모니터, 값 목록을 나온 뒤 `edit` None.
    7. `esc_chain_settings_path`: 칸 설정 `r`로 연 자세히 → 요청·응답 → 값 목록 → `back`×3 = 요청·응답 → 자세히 → 칸 설정, `edit` Some.
    8. `body_keys_bar`: `sub_keys(&Screen::Body, …)`의 끝 두 조각이 `KEYS_ADD_VALUE`, `KEYS_TO_DETAIL`(요청 본문 유무 둘 다).
  - `view_test.rs`: `HELP_KEYS.len() == 12`(기존 11 단언 갱신 — `grep -n "HELP_KEYS.len()" crates/tui/tests/view_test.rs`), `a` 줄이 `Enter` 줄 뒤, 50칸 도움말 상자에서 `a` 줄 설명이 통째로 보인다(기존 `help_errors_row_whole_at_50_columns`와 같은 방식 — 그 테스트에 `a` 줄을 더한다). 80×24 도움말에 키 줄이 전부 보이는지는 기존 `help_zoom_row_whole_from_50_columns`가 지킨다(깨지면 STOP — 줄 예산).
- [ ] **Step 2: 구현.**
- [ ] **Step 3: 이빨 실증** — ① `enter_values`가 남은 `EditUi`를 그대로 쓰게(칸 비교 제거) → 3번 RED ② `on_edit_screen`에서 `Values`를 빼면… 순수 테스트로는 안 잡힌다 — Task 뒤 라이브가 그물(보고서에 그렇게 적는다) ③ 키 줄 순서를 바꾸면 8번 RED.
- [ ] **Step 4: 화면 손 확인(구현자)** — `cargo build -p handicap-tui` 뒤 tmux로 한 번 띄워(방법 `crates/tui/CLAUDE.md` — 번들 fixture + 응답기) 요청·응답 → `a` → 값 목록 → `Enter` → 조건 저장까지 캡처 1장을 보고서에(정식 라이브는 Task 뒤).
- [ ] **Step 5: 검증** — `cargo test -p handicap-tui` 전체 + clippy + `cargo build --workspace --tests`.
- [ ] **Step 6: 커밋** — `feat(tui): 요청·응답 화면에서 a — 응답 값을 골라 성공 조건·표시 값 추가`.

---

### Task 6: 통합 테스트 (in-process 컨트롤러 — 서버가 그 경로·조건을 실제로 받는다)

spec §7 "통합". production diff 0(테스트만).

**Files:**
- Test: `crates/tui/tests/save_flow_test.rs`(기존 `rig`·`recv`·`save_req`·`wait_request`·`flow_bundle` 도우미를 쓴다 — `grep -n "^async fn \|^fn " crates/tui/tests/save_flow_test.rs`). 응답 바꾸기는 wiremock `srv.reset().await` 뒤 새 `Mock` 등록, 새 결과 기다리기는 `api.check_now` 뒤 `api.status`를 폴링해 `at_ms`가 더 새 결과가 올 때까지(최대 10초 — `wait_request`와 같은 모양의 도우미를 하나 둔다). 기록은 `api.record(board, panel, at_ms)`.

- [ ] **Step 1: 테스트 작성**
  1. `added_condition_judges_next_checks`: 응답기가 `{"status":"OK","wrap":"{\"id\":7}","we'ird key":{"n":1}}` + 헤더 `x-id: abc`. 기록 조회(`api.record`) → `pick::open_values` → 줄 `status`를 골라 `default_condition` → `edit::add_condition` → `EditReq::SaveBoard` → ① 응답 보드에 조건 ② 저장된 파일을 다시 읽으면 그 칸에 조건 ③ 지금 점검(`api.check_now`) 뒤 새 결과 `verdict == Ok` ④ 응답기를 `{"status":"DOWN",…}`으로 바꾸고 지금 점검 → `Fail`.
  2. `added_paths_resolve_on_server`: 감싼 JSON 안쪽 줄(`wrap.id`)·따옴표 든 키 줄(`['we\'ird key'].n`)·헤더 줄(`x-id`)·응답 코드 줄 각각으로 `=` 조건을 달아 저장 → 지금 점검 → 넷 다 있는 칸이 `Ok`(서버가 그 경로를 찾는다).
  3. `added_display_shows_value`: 숫자 줄로 `add_display` 저장 → 지금 점검 → `/status` 최신 결과의 `display[0]`이 그 값.
  4. `server_rejects_over_limit`: 501자 경로의 조건 저장 → 서버 거절 문구(`본문 경로는 1~500자여야 합니다`, `칸 N: ` 접두 떼짐), 파일·캐시 불변.
- [ ] **Step 2: 이빨 실증** — `segments_to_path`의 작은따옴표 이스케이프를 빼면 2번 RED(서버가 경로를 거절하거나 못 찾음). 원복.
- [ ] **Step 3: 검증** — `cargo test -p handicap-tui --test save_flow_test` + 전체.
- [ ] **Step 4: 커밋** — `test(tui): 응답에서 고른 조건·표시 값 — 서버 판정까지 통합 테스트`.

---

### Task 7: 칸 설정 11·12의 `a` (US3)

spec §2.7, §4.3. US1·2·4와 독립 — 앞 task들이 green인 뒤.

**Files:**
- Modify: `crates/tui/src/app.rs`, `crates/tui/src/edit.rs`(`edit_kind`), `crates/tui/src/inspect.rs`(`RecordState`), `crates/tui/src/pick.rs`(`auto_target`), `crates/tui/src/view/edit.rs`(`list_keys`), `crates/tui/src/text.rs`.
- Test: `crates/tui/tests/app_test.rs`, `edit_test.rs`, `edit_view_test.rs`, `inspect_test.rs`, `pick_test.rs`.

**Interfaces (Produces):**
- `edit_kind`: 11 → 항상 `List(Conditions)`, 12 → 항상 `List(Display)`.
- `text::EDIT_ADD_HINT = "없음 — a로 추가(지금 점검 뒤 응답에서 값 고르기)"` — `EDIT_NO_CONDITIONS`·`EDIT_NO_DISPLAY`를 **지우고** 쓰던 곳(`grep -rn "EDIT_NO_CONDITIONS\|EDIT_NO_DISPLAY" crates/tui` — src 6줄·테스트 3줄)을 바꾼다.
- `view::edit::list_keys`: `KEYS_ADD`가 세 종류 모두에.
- `pub enum CheckThen { Record, Values }`(`Copy`). `Overlay::Checking { seq, wait, then: CheckThen }`. `start_check(ui, seq, then)`. `check_open_allowed(screen: &Screen, then: CheckThen) -> bool`(`Record` → `Screen::Settings`, `Values` → `Screen::EditList`).
- `EditOut.check: Option<CheckThen>` — `edit_apply`의 `EditAction::Add`가 하위 목록 11·12에서: 조건 10개(11번)·표시 값 2개(12번)면 `Notice(COND_MAX / DISPLAY_MAX)`, 아니면 `out.check = Some(CheckThen::Values)`. 기준선(8번)의 `Add`는 지금 그대로. `run_edit`이 `out.check`를 보고 `start_check` + `send_fetch`(조회 작업자가 없으면 창을 띄우지 않는다 — 메뉴 `r`과 같은 가드).
- `RecordState.auto_values: bool`(리터럴 사이트 `grep -rn "RecordState {" crates/tui`). `SubViews::open_record_from_settings(clicked, auto_values: bool)`.
- `pick::auto_target(lines: &[StepLine], step_panel: bool) -> Option<usize>` — 스텝 칸: `focus: true`인 줄의 위치; 흐름 전체 칸: `StepLine::Http`가 정확히 1개일 때 그 위치; 그 밖 `None`.
- `SubViews::take_auto_values(&mut self, screen: &Screen, lines: &[StepLine], step_panel: bool) -> Option<Screen>`(순수 — 판단과 상태 변경을 전부 여기에):
  - 화면이 **정확히** `Screen::Record`가 아니거나 · `record`가 없거나 · `auto_values`가 내려가 있거나 · 기록이 `Loading`이면 → `None`, **표지 그대로**(종료 확인창이 떠 있는 동안은 기다린다).
  - 그 밖(기록이 `Loaded`·`Gone`·`Failed`)이면 **표지를 내린다**. `Loaded`이고 `pick::auto_target(lines, step_panel)`이 `Some(i)`면 `record.cursor = i` → `self.open_body(lines)`의 결과(`Some(Screen::Body)`)를 돌려준다. 아니면 `None`(자세히에 머문다).
- `App::pump`: `pump_check_ready` **뒤**에 `take_auto_values(&self.screen, &lines, 칸.step_id.is_some())` → `Some(s)`면 **먼저 `self.screen = s`(요청·응답)로 바꾼 뒤** `open_values_here()`(Task 5 — `value_target`이 화면 `Body`를 요구한다). `App`에는 이 두 줄만 남긴다. `pump_check_ready`는 창의 `then`으로 `check_open_allowed`와 `open_record_from_settings(clicked, then == Values)`를 부른다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `edit_test.rs`: `edit_kind(11|12, 빈 칸)` → `List`(기존 `ReadOnly` 단언 갱신 — `grep -n "EDIT_NO_\|ReadOnly" crates/tui/tests/edit_test.rs`).
  - `edit_view_test.rs`: `list_keys(Conditions|Display, 0|n)`에 `KEYS_ADD`; 빈 목록 안내 줄 = `EDIT_ADD_HINT`(기존 `list_empty_shows_guidance` 갱신).
  - `pick_test.rs`: `auto_target_table` — 스텝 칸 focus 있음 → 그 줄 / 없음 → `None`; 흐름 HTTP 1개(+`If` 줄) → 그 줄; HTTP 2개 → `None`; 한 스텝 반복 2줄 → `None`; 빈 목록 → `None`.
  - `app_test.rs`:
    1. `list_a_key`: 하위 목록에서 `a`·`ㅁ` → `EditAction::Add`(지금도 그렇다 — 유지 확인).
    2. `list_a_blocked`: 11번·조건 10개 → `Notice(COND_MAX)`·`out.check` None; 12번·표시 값 2개 → `Notice(DISPLAY_MAX)`·None; 11번·9개 / 12번·1개 / 빈 목록 → `out.check == Some(Values)`·창 그대로(창은 `run_edit`의 `start_check`가 띄운다); 8번(기준선) → 지금처럼 입력줄·`out.check` None.
    3. `start_check_carries_then`: `start_check(.., CheckThen::Values)` → `Checking { then: Values, wait: Sent, .. }`; 메뉴 `r` 경로는 `Record`.
    4. `check_open_allowed_by_intent`: (`Settings`, `Record`) true · (`EditList`, `Record`) false · (`EditList`, `Values`) true · (`Settings`, `Values`) false · (`QuitConfirm(EditList)`, `Values`) false.
    5. `open_record_from_settings_sets_flag`: `auto_values` true/false가 `RecordState`에 실린다; `back(&Screen::Record)` → `Screen::Settings`(지금과 같다).
    6. `take_auto_values_sequence`(스텝 칸·focus 줄 있는 `lines`, 기록 `Loaded`·표지 선 상태에서 **차례로**): ① 화면 `QuitConfirm(Record)` → `None`, **표지 그대로**, `body` 없음(창을 닫지 않는다) ② 화면 `Record` → `Some(Screen::Body)`, 표지 내려감, `record.cursor` = focus 줄, `body` 있음 ③ 다시 부르면(`Record`) → `None`(한 번만). 이어서 `value_target(&Screen::Body, &lines)`가 `Some`(= `open_values_here`가 열 수 있다).
    6-1. `take_auto_values_rules`: 기록 `Loading` → `None`·표지 그대로; `Gone`/`Failed` → `None`·표지 내려감; `Loaded`인데 대상 없음(흐름 HTTP 2줄) → `None`·표지 내려감·`body` 없음; 표지 없음·`record` 없음·화면 `Body` → `None`·상태 불변; 기록을 기다리다 `back(&Screen::Record)`으로 떠나면 `record`째 사라져 그 뒤 `None`.
    7. `idle_and_cancel`: 대기 창 `Esc`(`CheckCancel`) → 창 닫힘(기존); `idle_drop`이 `Checking { then: Values }`도 버린다.
- [ ] **Step 2: 구현.**
- [ ] **Step 3: 이빨 실증** — ① `take_auto_values`의 화면 검사를 `QuitConfirm` 안쪽까지 보게 풀면 6번 ①이 RED, 표지를 안 내리면 6번 ③이 RED ② 10개 가드를 빼면 2번 RED ③ `check_open_allowed`가 의도를 무시하면 4번 RED.
- [ ] **Step 4: 화면 손 확인(구현자)** — tmux: 스텝 1개 흐름 칸의 11번 → `a` → 대기 창 → 값 목록이 바로 뜨는 캡처 1장.
- [ ] **Step 5: 검증** — `cargo test -p handicap-tui` 전체 + clippy + `cargo build --workspace --tests`.
- [ ] **Step 6: 커밋** — `feat(tui): 칸 설정 11·12에서 a — 지금 점검 뒤 값 목록까지`.

---

### Task 8: 문서

spec §6. production diff 0.

**Files:**
- Modify: `docs/superpowers/specs/2026-11-07-tui-monitor-design.md`, `docs/dev/tui-monitor.md`, `docs/superpowers/specs/2026-11-11-tui-2b-add-from-response-design.md`(상태 줄), `crates/tui/CLAUDE.md`(밟은 함정이 있을 때만).

- [ ] **Step 1: 상위 설계** — `grep -n "2b\|GUI에서(다음 버전" docs/superpowers/specs/2026-11-07-tui-monitor-design.md`의 줄을 하나씩 판정: 상태 줄(2b 완료 + 이 spec 링크), US9 문장 뒤에 `→ [tui-2b 설계](2026-11-11-tui-2b-add-from-response-design.md)`, §0 표 2b 행, §5.2 키 표에 `a` 행(요청·응답 화면: 값 목록 / 하위 목록 11·12: 지금 점검 뒤 값 목록), §6 머리 "2b" 문장, §6.1 표 11·12 행의 "고칠 수 없을 때" 칸(`없음 → 조건 추가는 GUI에서…` → `없음 → 하위 목록의 a로 추가`)과 "편집" 칸에 `a` 추가.
- [ ] **Step 2: 매뉴얼** `docs/dev/tui-monitor.md` — 키 표에 `a` 두 줄, 새 절 "성공 조건·화면 표시 값 추가"(두 길: 오류 보기/칸 설정 `r` → 자세히 → 요청·응답 → `a`, 그리고 11·12의 `a` · 값 목록 읽는 법 · `조건`/`표시` 표지 · 고를 수 없는 경우 4가지와 이유 문구 · 가려진 인증 값은 비교값을 안 채움 · 본문 값은 64KB 이하 JSON만 · 꺼진 보드에서는 못 함 · 틀린 조건은 11번에서 고치거나 지움).
- [ ] **Step 3: 이 spec 상태 줄** — `구현 완료(코드 <첫 커밋>..<끝 커밋>), 라이브·마무리는 finish-slice`.
- [ ] **Step 4: 함정** — 구현·손 확인에서 실제로 밟은 것만 `crates/tui/CLAUDE.md`에 한 줄씩(없으면 건드리지 않는다).
- [ ] **Step 5: 커밋** — `docs: tui-2b — 상위 설계·매뉴얼 개정`.

---

## Task 뒤 (orchestrator — 순서 고정, 생략 금지)

1. **최종 whole-feature 리뷰** `handicap-reviewer`(BASE = Task 1 직전 커밋). 초점: Review Focus 9개 + "옛 동작에 기대던 소비자"(`CondForm.index`를 쓰던 곳·`check_open_allowed`·`start_check`·`open_record_from_settings`의 기존 호출부, `EDIT_NO_*`를 보던 테스트, `HELP_KEYS` 길이에 기대는 도움말 줄 예산) + 범위 0-diff 확인(`git diff --stat <BASE>..HEAD -- crates/controller crates/engine crates/proto ui Cargo.toml Cargo.lock` → 빈 출력).
2. **보안 게이트** — `finish-slice` §0 grep을 직접 돌린다. 매치 여부와 무관하게 이 슬라이스는 **기록 뷰어에서 응답 값을 설정 파일로 옮기는 새 길**이라 `security-reviewer`를 돌린다(spec §9: 가린 값이 조건 값으로 안 들어가는가 · 손 `Debug`·로그 · `sanitize` · 5분 복귀가 값을 버리는가 · 다른 칸에 저장되는 길이 없는가).
3. **라이브 검증** — spec §8 표 전부 + 극단값(tmux, 응답 값을 바꿀 수 있는 응답기, `crates/tui/CLAUDE.md`의 tmux·in-process REST 방법, 이 체크아웃의 바이너리). GUI 대조 행은 별도 컨트롤러(`--ui-dir ui/dist`, 다른 포트·DB) + Playwright.
4. **`/finish-slice`** — build-log·roadmap(§B 새 절: 판단·연기 + §B49 (2) `Names` 메모 정정 + GUI 선재 갭 "엔진이 자른 본문에도 `+ 본문 전체 포함 조건`")·현황판·루트 상태 줄·"증명된 US / 못 한 US" 한 줄. **이 세션은 cloud 브랜치라 로컬 ff-merge가 없다 — push까지 하고, master 합류·맥 전체 게이트(nextest)·Ubuntu 실기는 사용자 몫으로 roadmap에 적는다**(tui-check-now §B51과 같은 방식).

## 사실 근거 (이 plan이 기대는 코드 사실 — 디스패치 전 재실행)

| 주장 | 명령 |
|---|---|
| `TracedResponse` 필드(status·headers `BTreeMap`·body·body_truncated) | `grep -n "pub struct TracedResponse" -A9 crates/engine/src/trace.rs` |
| 엔진 공개 함수 `jsonpath_first`·`jsonpath_is_valid`·`jsonpath_is_simple`·`stringify` | `grep -n "^pub fn" crates/engine/src/extract.rs` |
| TUI가 `handicap_engine`의 trace 타입을 쓴다 | `grep -n "use handicap_engine" crates/tui/src/inspect.rs crates/tui/src/wire.rs` |
| 서버 풀기 규칙(대조 테스트가 다시 적을 것) | `grep -n -A16 "^fn unwrap_json_str" crates/controller/src/monitor/check.rs` |
| 한도 상수 | `grep -n "PRETTY_MAX_BYTES\|PRETTY_MAX_DEPTH" crates/tui/src/inspect.rs` |
| 대상 글자 함수 | `grep -n "pub fn condition_target\|pub fn display_target" crates/tui/src/panel_settings.rs` |
| 입력줄이 받지 않는 글자 | `grep -n -B2 -A3 "c.is_control()" crates/tui/src/input.rs` |
| `with_panel`(칸 하나만 바꾸는 도우미) | `grep -n "^fn with_panel" -A10 crates/tui/src/edit.rs` |
| `mirrored_text_exists_in_ko_ts`의 표 형식(`{key}: "{val}"`) | `grep -n -A30 "fn mirrored_text_exists_in_ko_ts" crates/tui/tests/judge_parity_test.rs` |
| ko.ts 값 8개 | `grep -n "condChooseCondition\|condChooseDisplay\|condMax\|displayMax\|displayDup\|displayAuthHeader\|previewUnwrapped\|condVolatileHint" ui/src/i18n/ko.ts` |
| `Overlay::CondForm` 사이트(src 14·테스트 6) | `grep -rn "Overlay::CondForm" crates/tui/src crates/tui/tests` |
| `Overlay`를 전부 나열하는 곳 = `kind`·`overlay_key`·`edit_keys`·`overlay_view` | `grep -n "Overlay::Saving" crates/tui/src/app.rs` |
| `Change`를 전부 나열하는 곳 = 손 `Debug`·`apply_change` | `grep -n "Change::Swap" crates/tui/src/app.rs` |
| `EditUi {` 리터럴(src 4·테스트 12 — `..EditUi::default()`가 아닌 곳은 새 필드 필요) | `grep -rn "EditUi {" crates/tui/src crates/tui/tests` |
| `Screen`을 전부 나열하는 `match`(새 갈래가 필요한 곳은 컴파일러가 알려 준다) | `cargo build -p handicap-tui`(구현 중) |
| `is_sub`·`on_edit_screen`·`edit_key` 화면 규칙 | `grep -n -A10 "^fn is_sub\|fn on_edit_screen\|let menu = matches!(screen, Screen::Settings);" crates/tui/src/app.rs` |
| `OpenSettings`의 저장 중 규칙(빼낼 것) | `grep -n -A8 "저장 중이면: 그 칸이면" crates/tui/src/app.rs` |
| 요청·응답 화면 제목 만드는 곳 | `grep -n -B2 -A10 "BodyLineKind::Title," crates/tui/src/inspect.rs` |
| 요청·응답 키 줄 | `grep -n -A12 "Screen::Body => {" crates/tui/src/app.rs` |
| 도움말 줄 수 단언 | `grep -n "HELP_KEYS.len()" crates/tui/tests/view_test.rs` |
| `list_keys` 호출·테스트 | `grep -rn "list_keys(" crates/tui/src crates/tui/tests` |
| `EDIT_NO_*` 사이트(src 6·테스트 3) | `grep -rn "EDIT_NO_CONDITIONS\|EDIT_NO_DISPLAY" crates/tui` |
| `Overlay::Checking`·`start_check`·`check_open_allowed`·`open_record_from_settings` 사이트 | `grep -rn "Overlay::Checking\|start_check(\|check_open_allowed(\|open_record_from_settings(" crates/tui/src crates/tui/tests` |
| `RecordState {` 리터럴 | `grep -rn "RecordState {" crates/tui` |
| `EditOut {` 리터럴 | `grep -rn "EditOut {" crates/tui` |
| 통합 테스트 도우미 | `grep -n "^async fn \|^fn " crates/tui/tests/save_flow_test.rs` |
| 서버 거절 문구(경로 길이) | `grep -n "본문 경로는 1~500자여야 합니다" crates/controller/src/monitor/config.rs` |
| pre-commit이 nextest 없으면 `cargo test --workspace` | `grep -n -B3 -A8 "command -v cargo-nextest" .githooks/pre-commit` |
