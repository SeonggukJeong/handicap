# tui-2b-secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이름이 비밀 같은 응답 값을 비교값으로 채우지 않고(TUI·GUI), GUI의 잘린 본문에서 `본문 전체` 버튼을 없애고, 서버가 보드 글자 칸의 제어·bidi·줄 구분 문자를 거절한다.

**Architecture:**
- 컨트롤러 `monitor/config.rs`에 금지 글자 술어 하나를 두고, `validate_and_normalize` 경로의 모든 자유 글자 칸에 정규화 뒤 적용한다. 가져오기 오류가 보드 이름을 되풀이할 때는 그 글자를 치환한다.
- 두 경로 생성기(TUI `pick.rs`, GUI `jsonPath.ts`)는 같은 집합을 `\uXXXX`로 이스케이프한다. 엔진이 그 형태를 읽는지는 Task 1의 STOP 테스트가 먼저 확인한다.
- 이름 규칙은 TUI `pick.rs`와 GUI `conditions.ts`에 하나씩 두고, 같은 판정표·미리 채움 대조표 행으로 묶는다.

**Tech Stack:** Rust(controller·engine·tui, ratatui) · TypeScript/React(vitest·RTL).

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-12-tui-2b-secrets-design.md` (APPROVED — 리뷰 3라운드). 구현자는 spec §2–§4를 함께 읽는다.

## Global Constraints

- 금지 글자 집합(spec §4.1): `char::is_control()` · U+2028 · U+2029 · U+061C · U+200E · U+200F · U+202A–202E · U+2066–2069. ZWJ(U+200D)·ZWNJ는 허용.
- 비밀 낱말(spec §2.2): `token` `secret` `pass` `pwd` `session` `key` `csrf` `auth` `cookie`. 판정은 ASCII 소문자로 바꾼 뒤 부분문자열 포함이다.
- 조건 안내 문구(TUI·GUI 같은 글자): `이름이 비밀 값처럼 보여 비교값을 채우지 않았습니다`.
- 화면에 추가 안내 문구: `이름이 비밀 값처럼 보입니다 — 화면에 늘 보입니다`.
- 서버 오류 꼴: `{칸 이름}에 쓸 수 없는 글자(제어·방향 제어·줄 구분 문자)가 있습니다`. 칸 안의 것은 기존 호출자가 `칸 N: `을 붙인다.
- 와이어(REST·proto)·마이그레이션·엔진 실행 코드 무변경. 엔진은 테스트 1개만 추가한다.
- 값을 품는 TUI 타입은 derive `Debug` 금지(`crates/tui/CLAUDE.md`).
- 모든 사용자 노출 GUI 문구는 `ko.ts` 경유.
- **소스에 날것 금지 글자를 넣지 않는다**: 테스트·코드의 금지 글자는 Rust·TS 모두 중괄호 이스케이프 `\u{202E}`로 쓴다. 이 plan을 쓸 때 Write/Edit 도구가 중괄호 없는 `\u202e` 꼴을 실제 글자로 바꿔 넣은 일이 있다(orchestrator 실측). 커밋 전에 `git diff --cached`의 추가 줄에 U+202A–202E·U+2066–2069·U+200E/F·U+2028/2029·U+061C가 0개인지 확인한다(python `-I` 한 줄로 셀 것 — 스크립트는 scratchpad에).
- 커밋(구현자): 단일 FOREGROUND 호출(timeout 600000ms), `| tail` 금지, 판정은 `; echo exit=$?`, `--no-verify` 금지, 메시지는 `-F <파일>`(scratchpad)로. 커밋 뒤 `git log -1`로 확인한다.

## Review Focus

1. **GUI에서 인증 헤더(`Set-Cookie`)를 고르면** 지금은 `= <쿠키 원문>`이 채워진다. 이 슬라이스 뒤에는 `값 있음` + 비밀 안내가 된다(Task 5 판정표 행).
2. **이름은 비밀 같지만 값이 빈 문자열**이면 `= ""`로 채운다(`값 있음`이면 다음 점검이 바로 실패한다 — Task 3·5 대조표 행).
3. **값이 필요 없는 규칙(`exists`)의 옛 `value`에 금지 글자가 남은 보드**는 서버가 그 값을 비운 뒤 검사하므로 통과한다(Task 1 테스트).
4. **응답 키에 날것 bidi가 든 줄**은 이스케이프된 경로가 서버를 통과하고 엔진이 같은 키를 고른다(Task 1 STOP + Task 2 + 라이브).
5. **TUI 선택 창이 낮을 때** 안내 줄이 머리 줄보다 오래 남고, 어떤 크기에서도 패닉이 없다(Task 4 스윕).

---

### Task 1: 서버 금지 글자 검사 + 엔진 이스케이프 실측

**Files:**
- Modify: `crates/engine/src/extract.rs` (테스트만 — 기존 `$['a\\u0009b']` 목록 옆)
- Modify: `crates/controller/src/monitor/config.rs` (술어·검사·인라인 테스트)
- Modify: `crates/controller/src/monitor/board_file.rs` (오류 접두 이름 치환·인라인 테스트)
- Test: `crates/tui/tests/input_test.rs` (술어 동기화 1건)

**Interfaces:**
- Produces: `pub fn is_forbidden_text_char(c: char) -> bool`와 `pub fn replace_forbidden(s: &str) -> String`. 둘 다 `handicap_controller::monitor::config`에 있다. 뒤의 것은 금지 글자를 `\u{FFFD}`로 바꾼다. Task 2(TUI)가 앞의 것을 쓴다.

- [ ] **Step 1: 엔진 STOP 실측 테스트** — `extract.rs` 테스트 모듈에 `escaped_bidi_quoted_name_selects_raw_key`를 추가한다:
  - `"$['a\\u202eb']"`(Rust 리터럴 — 백슬래시가 든 6글자 이스케이프)가 `jsonpath_is_valid`·`jsonpath_is_simple`을 통과한다.
  - 본문 `{"a\u{202E}b": 7}`에 이 경로를 적용하면 값 `7`을 고른다. 그 파일에 이미 있는 값 추출 함수를 쓴다.
  - 같은 꼴로 `\\u2028`·`\\u0085`·`\\u2066`도 확인한다.
  - 실행: `cargo test -p handicap-engine escaped_bidi_quoted_name -- --nocapture`. **PASS가 기대값이다(실측).**
  - **FAIL이면 STOP**: 커밋하지 말고 결과를 orchestrator에게 보고한다(spec §4.3 STOP 조건).
- [ ] **Step 2: 실패하는 컨트롤러 테스트** — `config.rs` `mod tests`에 아래를 추가한다:
  - `forbidden_char_set_boundary`: 탭·`\n`·`\u{7F}`·`\u{85}`·`\u{9F}`·`\u{200E}`·`\u{200F}`·`\u{2028}`·`\u{2029}`·`\u{202A}`·`\u{202E}`·`\u{2066}`·`\u{2069}`·`\u{061C}`는 `true`이고, `\u{200D}`·`\u{200C}`·`a`·`가`·`❤`는 `false`다.
  - `rejects_forbidden_chars_per_field`: 표 테스트. 기존 `board()`/`panel()` 헬퍼에서 한 칸씩 금지 글자를 넣고 `validate_and_normalize("보드", …)`의 `Err` 문자열을 정확히 단언한다. 행:

    | 넣는 곳 | 기대 오류 |
    |---|---|
    | 보드 이름 `"a\u{202E}b"` | `보드 이름에 쓸 수 없는 글자(제어·방향 제어·줄 구분 문자)가 있습니다` |
    | 칸 제목 `"a\u{1}b"` | `칸 1: 칸 제목에 …` |
    | 조건 `eq` value `"a\tb"` | `칸 1: 비교값에 …` |
    | 조건 header path `"x\u{200F}y"` | `칸 1: 헤더 이름에 …` |
    | 조건 body path `"$['a\u{202E}b']"`(날것) | `칸 1: 본문 경로에 …` |
    | 표시 header path | `칸 1: 화면 표시 항목 헤더 이름에 …` |
    | 표시 body path(날것) | `칸 1: 화면 표시 항목 본문 경로에 …` |
    | `scenario_id` `"S\u{2028}"` | `칸 1: 시나리오 id에 …` |
    | `environment_id` `Some("E\u{7F}")` | `칸 1: 환경 id에 …` |
    | 스텝 없는 칸 `latency_source: Step{step_id:"x\u{202A}"}` | `칸 1: 응답 시간 스텝 id에 …` |
    | 묶음 `scenario_id` | `점검 묶음 1: 시나리오 id에 …` |
    | 묶음 `environment_id` | `점검 묶음 1: 환경 id에 …` |

    `…`는 Global Constraints의 꼴을 줄인 것이고 테스트에는 전체 글자를 쓴다. 묶음 행은 묶음 칸 규칙(스텝 필수·연속)을 지키는 픽스처로 만든다. 그 픽스처는 기존 묶음 테스트 헬퍼를 참고한다.
  - `checks_after_normalization`:
    - `exists` 조건의 value `"a\u{202E}"` → `Ok`, 저장된 value는 `""`.
    - `status` 조건의 path `"a\u{1}"` → `Ok`, path는 `""`.
    - 조건 헤더 path `"\tx-a\u{2028}"` → `Ok`, 저장된 path는 `"x-a"`(trim이 지우는 금지 글자 — 검사가 trim 앞이면 RED).
    - 칸 제목 `"\t제목\u{2029}"` → `Ok`, 저장된 제목은 `"제목"`.
    - 앞에 `\u{1}`이 붙은 칸 제목 → `Err`(`str::trim`이 못 지운다).
  - `escaped_body_path_passes`: 조건·표시 body path `"$['a\\u202eb']"`(이스케이프 글자) → `Ok`.
  - `board_file.rs` `mod tests`에 `import_error_never_echoes_forbidden_chars`를 추가한다:
    - 보드 이름이 `"x\u{202E}y"`인 번들을 `parse_bundle_value`(또는 그 파일 테스트가 쓰는 진입점)에 넣는다.
    - `Err` 문자열이 비어 있지 않고, 그 안에 `is_forbidden_text_char`인 글자가 0개다.
    - 보드 이름을 넣는 오류 경로는 4곳이다. `board_file.rs`의 `format!("보드 '{}' …", b.name.trim())` 2곳(개수 검사·`validate_and_normalize`)과 `let board = b.name.trim();` 바인딩을 쓰는 "파일 내용이 서로 맞지 않습니다(보드 '{board}' …)" 2곳(시나리오·환경 없음)이다. 경로마다 행을 하나씩 만든다. 개수 초과·검증 실패·칸의 시나리오 없음·칸의 환경 없음 픽스처를 쓴다.
    - "0건 추가"(spec §6)는 구조로 보장된다. `parse_bundle_value`는 순수 함수이고 DB 쓰기 전에 거절한다. 라이브(US4)가 실제 수를 본다 — 단위 테스트로는 만들지 않는다.
- [ ] **Step 3: RED 확인** — 실행: `cargo test -p handicap-controller --lib monitor::`. 기대: 새 테스트가 컴파일 에러(`is_forbidden_text_char` 없음) 또는 FAIL.
- [ ] **Step 4: 구현** (`config.rs`):
  - `is_forbidden_text_char`·`replace_forbidden`과 `fn check_text(label: &str, s: &str) -> Result<(), String>`을 만든다.
  - 검사 위치(spec §4.2 "정규화 뒤"):
    - 보드 이름: `validate_and_normalize`의 trim·`check_name` 뒤.
    - 칸 제목: `validate_panel`의 trim·`check_name` 뒤.
    - `scenario_id`·`environment_id`·`latency_source` `Step{step_id}`: `validate_panel` 안. `normalize_step_panel`이 이미 덮어쓴 스텝 칸은 ULID라 통과한다.
    - 조건: `validate_conditions` 한 조건의 모든 정규화·기존 검사 **뒤**. 헤더 이름은 `헤더 이름`, 본문 경로는 `본문 경로`, 비교값은 `비교값`.
    - 표시 값: `validate_display_items` 루프 끝. 레이블은 `화면 표시 항목 헤더 이름`·`화면 표시 항목 본문 경로`.
    - 묶음: `validate_groups` 루프. `점검 묶음 {n}: ` 접두는 그 함수의 기존 꼴을 따른다.
  - `board_file.rs`: 위 4곳 모두 이름을 `replace_forbidden(…)`을 거친 글자로 바꾼다. `let board = …` 바인딩은 그 자리에서 `replace_forbidden(b.name.trim())`으로 만든다.
- [ ] **Step 5: TUI 동기화 테스트** — `crates/tui/tests/input_test.rs`에 `input_and_server_agree_on_every_char`를 추가한다. 이 테스트는 `char::from_u32`로 0..=0x10FFFF 전 글자에 대해 `handicap_tui::input::accept_char(c) == !is_forbidden_text_char(c)`를 단언한다. `input.rs`는 바꾸지 않는다(spec §4.1 — 동기화 테스트 선택). 실행: `cargo test -p handicap-tui --test input_test input_and_server_agree`. 기대: PASS.
- [ ] **Step 6: GREEN + 이빨** — 실행: `cargo test -p handicap-controller --lib monitor::` → PASS. 그다음 고의 회귀를 세 번 넣어 각각 RED를 확인하고 원복한다:
  - ① 조건 검사를 정규화 **앞**(value 비우기 전)으로 옮기면 `checks_after_normalization`의 `exists` 행이 RED.
  - ①' 헤더 이름 검사를 trim **앞**으로 옮기면 헤더 path 행이 RED.
  - ② `is_forbidden_text_char`에서 bidi 갈래를 지우면 `forbidden_char_set_boundary`와 `input_and_server_agree…`가 RED.
  - ③ `board_file.rs`의 4곳을 **하나씩** 원래대로 돌려 매번 해당 행이 RED인지 본다(4회).
  - 결과를 리포트에 적는다.
- [ ] **Step 7: 커밋** — `git add crates/engine/src/extract.rs crates/controller/src/monitor/config.rs crates/controller/src/monitor/board_file.rs crates/tui/tests/input_test.rs` → `git diff --cached --name-only`로 확인 → `git commit -F <msg>`. 메시지 제목: `feat: 보드 글자 칸의 제어·방향 제어 문자 거절 (tui-2b-secrets §4)`.

### Task 2: 두 경로 생성기의 이스케이프 확장 (TUI + GUI 같은 글자)

**Files:**
- Modify: `crates/tui/src/pick.rs` (`segments_to_path`·`path_len`)
- Modify: `ui/src/scenario/jsonPath.ts` (`escapeBracketKey` + `export function isForbiddenTextChar`)
- Test: `crates/tui/tests/pick_test.rs`(기존 경로 표 — `(vec![k("\u{1f}")], "$['\\u001f']")` 근처), `ui/src/scenario/__tests__/jsonPath.test.ts`

**Interfaces:**
- Consumes: Task 1 `handicap_controller::monitor::config::is_forbidden_text_char`.
- Produces: GUI `export function isForbiddenTextChar(ch: string): boolean`(한 코드 포인트). Task 5가 쓴다.

- [ ] **Step 1: 실패하는 테스트(두 언어 같은 행)** — 키 → 경로 표:
  - 표기는 **Rust 리터럴**이다: 키는 `\u{…}` 글자이고, 경로의 `\\u…`는 결과 문자열 속 백슬래시 하나 + 소문자 hex 4자리다. TS 테스트도 같은 문자열을 만든다. 행:
    - 키 `"a\u{202E}b"` → 경로 `"$['a\\u202eb']"`
    - 키 `"a\u{2028}b"` → 경로 `"$['a\\u2028b']"`
    - 키 `"a\u{85}b"` → 경로 `"$['a\\u0085b']"`
    - 키 `"a\u{7F}b"` → 경로 `"$['a\\u007fb']"`
    - 키 `"a\u{2066}b"` → 경로 `"$['a\\u2066b']"`
    - 키 `"a\u{200D}b"`(ZWJ) → 경로 `"$['a\u{200D}b']"`(ZWJ는 금지 아님 — 이스케이프하지 않고 그대로)
  - 기존 탭·줄바꿈·U+001F 행은 유지한다.
  - TUI는 `path_len`이 비공개이므로 `pick.rs`에 인라인 `#[cfg(test)] mod tests`를 새로 만든다. 거기서 같은 표의 행마다 `path_len(&segs) == segments_to_path(&segs).len()`을 단언한다(`tdd-guard`가 인라인 테스트를 넣는 편집을 허용한다). 모듈은 **파일 맨 끝**에 둔다 — 중간에 두면 clippy `items_after_test_module`이 `-D warnings`로 막는다.
  - GUI는 `isForbiddenTextChar` 경계 행을 Task 1 `forbidden_char_set_boundary`와 같은 목록으로 둔다.
  - **spec과 다른 위치(의도)**: spec §4.1은 GUI 집합을 `conditions.ts`에 둔다고 적었다. 하지만 첫 소비처가 `jsonPath.ts`이고 `conditions.ts`는 이미 `jsonPath.ts`를 가져온다. 그래서 `jsonPath.ts`에 둔다. 모니터 쪽에서 시나리오 모듈로 가는 의존 방향이 그대로 유지된다.
  - 기대 경로 문자열은 테스트 소스에 **이스케이프 글자 그대로** 쓴다. 날것 bidi 글자는 소스에 넣지 않는다.
- [ ] **Step 2: RED 확인** — `cargo test -p handicap-tui --test pick_test` FAIL · `cd ui && pnpm test jsonPath` FAIL.
- [ ] **Step 3: 구현** — 두 생성기의 `< 0x20` 갈래를 금지 집합 전체로 넓힌다.
  - TUI는 `is_forbidden_text_char(c)`, GUI는 `isForbiddenTextChar(ch)`를 쓴다.
  - 형식은 기존 그대로 소문자 hex 4자리다. 금지 집합은 전부 BMP라 4자리면 충분하다.
  - `path_len`의 해당 갈래도 `6`으로 맞춘다.
  - `escapeBracketKey` 주석의 "raw control chars" 설명에 금지 집합 전체를 적는다.
- [ ] **Step 4: GREEN + 시나리오 쪽 확인** — 실행:
  - `cargo test -p handicap-tui --test pick_test` PASS · `cd ui && pnpm test jsonPath` PASS.
  - `cd ui && pnpm test scenario` PASS(시나리오 에디터의 기존 경로 단언).
  - 이빨: TUI 쪽만 원래대로 돌려 두 언어 표가 갈리는지(TUI RED) 확인하고 원복한다.
- [ ] **Step 5: 게이트 + 커밋** — `cd ui && pnpm lint && pnpm build`. 그다음 `git add crates/tui/src/pick.rs crates/tui/tests/pick_test.rs ui/src/scenario/jsonPath.ts ui/src/scenario/__tests__/jsonPath.test.ts` → 커밋. 제목: `feat: 경로 생성기가 방향 제어·줄 구분 문자를 이스케이프 (tui-2b-secrets §4.3)`.

### Task 3: TUI 비밀 이름 판정 + 조건 미리 채움

**Files:**
- Modify: `crates/tui/src/pick.rs` (`is_secret_name`·`ValueRow.secret_name`·`Hint::SecretName`·`default_condition`)
- Modify: `crates/tui/src/text.rs` (`PICK_SECRET_HINT`)
- Test: `crates/tui/tests/pick_test.rs`
- Test(필드 추가로 컴파일만 고침): `crates/tui/tests/app_test.rs`(`ValueRow` 리터럴 — `grep -n 'ValueRow {' crates/tui/tests/app_test.rs`, 작성 시점 2951·2958·3268 근처, `body_str` 헬퍼 포함)·`crates/tui/tests/values_view_test.rs`(431·437 근처). 모두 `secret_name: false`. `body_str`은 경로에서 계산하지 **않고** `false` 고정이다. `app_test.rs`의 `open_form(body_str("$.token", …41자))` → `Hint::Volatile` 테스트가 길이 갈래를 지키려면 그래야 한다. 그 사실을 헬퍼에 주석 한 줄로 적는다.

**Interfaces:**
- Produces:
  - `pub fn is_secret_name(name: &str) -> bool`
  - `ValueRow`의 새 필드 `pub secret_name: bool`. 헤더 줄은 헤더 이름으로 정한다. 본문 줄은 `Walker::push` 시점의 `segs`에서 마지막 `Seg::Key`로 정하고, 키가 없으면 `false`다. 응답 코드·`본문 전체` 줄은 `false`다.
  - `Hint::SecretName`(`text()` = `text::PICK_SECRET_HINT`)
  - `ValueRow` 손 Debug에 `secret_name` bool을 덧붙인다(값 아님).
  - Task 4가 `row.secret_name`을 쓴다.

- [ ] **Step 1: 실패하는 테스트**
  - `secret_name_table`: 행마다 `is_secret_name`. 맞음: `session_id` `X-Api-Key` `csrfToken` `password` `author` `Set-Cookie` `user_pwd` `Authorization` `refresh_token`. 아님: `name` `id` `count` `status` `url` `message`. **이 행 목록은 Task 5 GUI 표와 같은 순서·같은 글자**로 쓴다(서로 "Keep in sync" 주석).
  - `secret_name_from_value_list`: `value_list`에 실제 `TracedResponse`(헤더 `X-Api-Key: k`, 본문 `{"session_id":"s","items":[{"api_key":"k"}],"tokens":["t"],"name":"n","nested":{"session":{"id":"i"}}}`)를 넣는다. 각 줄의 `secret_name`을 단언한다:
    - `X-Api-Key`·`$.session_id`·`$.items[0].api_key`·`$.tokens[0]` → `true`.
    - `$.name`·`$.nested.session.id` → `false`(spec §8 — 마지막 키만 본다).
    - 응답 코드 → `false`.
    - 루트가 배열인 본문(`[1]`)의 `$[0]` → `false`.
  - `default_condition_prefill_parity`: 표. `(이름, 값) → (op, value, hint)`. **Task 5와 같은 행**:
    - `("session_id", "a"×32)` → `NotEmpty`, `""`, `SecretName`
    - `("session_id", "")` → `Eq`, `""`, 없음
    - `("token", "x"×41)` → `NotEmpty`, `""`, `SecretName`(비밀이 길이보다 앞)
    - `("name", "web-1")` → `Eq`, `"web-1"`, 없음
    - `("name", "x"×41)` → `NotEmpty`, `""`, `Volatile`
    - `("name", "a\tb")` → `NotEmpty`, `""`, `Volatile`
    - `("name", "a\u{200F}b")` → `NotEmpty`, `""`, `Volatile`
    - `("session_count", 숫자 5)` → `Eq`, `"5"`, 없음
    - 헤더 `("Authorization", "Bearer x")` → `NotEmpty`, `""`, `Masked`(TUI만 — 인증 헤더가 비밀 이름보다 앞)
  - 문자열 행은 본문 줄(`RowKind::Body{path}` + `PickValue::Str`)로 만든다. 헤더 행은 `RowKind::Header`로 만든다. `secret_name`은 `is_secret_name(이름)`으로 채운다.
  - 기존 `pick_test.rs`의 `ValueRow { … }` 리터럴과 `row()` 헬퍼에 `secret_name: false`를 넣는다. 기존 기대값은 바꾸지 않는다.
- [ ] **Step 2: RED 확인** — `cargo test -p handicap-tui --test pick_test` FAIL(필드·함수 없음).
- [ ] **Step 3: 구현** — spec §2.3 순서(인증 헤더 → 비밀 이름 + 빈 문자열 아님 → 길이·`input_accepts` → `=`)로 `default_condition`의 `string` 클로저를 고친다. `string` 클로저에 `secret: bool` 인자를 더하고, 호출 쪽이 `row.secret_name`을 넘긴다.
- [ ] **Step 4: GREEN + 이빨** — `cargo test -p handicap-tui` PASS. 고의 회귀를 두 번 넣어 RED를 확인하고 원복한다:
  - ① 비밀 갈래를 길이 갈래 뒤로 옮기면 `token`×41 행이 RED.
  - ② 빈 문자열 예외를 지우면 `session_id` `""` 행이 RED.
- [ ] **Step 5: 커밋** — `cargo build --workspace --tests` 0 에러 + `TZ=UTC cargo test -p handicap-tui` PASS 뒤 `git add crates/tui/src/pick.rs crates/tui/src/text.rs crates/tui/tests/pick_test.rs crates/tui/tests/app_test.rs crates/tui/tests/values_view_test.rs` → 커밋. 제목: `feat(tui): 이름이 비밀 같은 값은 비교값을 채우지 않음 (tui-2b-secrets §2.3)`.

### Task 4: TUI `화면에 추가` 안내 줄

**Files:**
- Modify: `crates/tui/src/app.rs` (`Overlay::AddChoice`에 `display_note: Option<&'static str>`, 선택 창 열기·`OverlayView` 만들기)
- Modify: `crates/tui/src/view/settings.rs` (`OverlayView::Choice`에 `note: Option<&'a str>`, 그리기·줄 예산)
- Modify: `crates/tui/src/text.rs` (`DISPLAY_SECRET_NOTE`)
- Test: `crates/tui/tests/values_view_test.rs`(기존 `OverlayView::Choice` 리터럴 3곳 — 작성 시점 132·468·544 — 에 `note: None` + 그리기 테스트 2개), `crates/tui/tests/app_test.rs`(`Overlay::AddChoice` 리터럴 — 작성 시점 3012 근처 — 에 `display_note: None` + `choice_note_only_for_secret_unblocked`)
- 컴파일러가 잡는 소스 쪽 자리(필드 추가): `app.rs`에서 `Overlay::AddChoice`를 만드는 곳(`activate_value`, 작성 시점 2539)과 필드를 다 적어 푸는 곳 2개(`choose_add` 2581·`OverlayView` 만들기 3037). `grep -n 'AddChoice' crates/tui/src` 전부 확인한다.

**Interfaces:**
- Consumes: Task 3 `ValueRow.secret_name`.

- [ ] **Step 1: 실패하는 테스트**
  - `choice_note_only_for_secret_unblocked`:
    - `secret_name`인 줄을 고르면 선택 창 상태의 `display_note == Some(text::DISPLAY_SECRET_NOTE)`다.
    - 같은 줄이라도 `display_block`이 있으면(표시 값 가득 참·중복) `None`이다.
    - `secret_name == false`면 `None`이다.
  - `choice_note_outlives_head_sweep`: `note: Some(..)`인 `OverlayView::Choice`를 아래 크기로 그린다:
    - 크기: 패닉 없음은 폭 `w` ∈ 1..=120(기존 sweep과 같은 범위)과 기존 Choice 테스트의 높이 범위 전부에서 본다. 머리 글자는 짧은 것과 300자인 것 두 가지다.
    - 보임 단언은 안내 접두 `이름이 비밀`이 `fit` 뒤에도 남는 폭(`w >= 30`)에서만 한다:
      - 안내가 보이면 고른 선택 줄도 보인다.
      - 머리 글자가 보이는 모든 높이에서 안내도 보인다(머리보다 오래 남는다).
      - `bh == 5`에서 안내는 보이고 머리는 안 보인다.
  - `choice_note_style_is_not_dim`: 안내 줄 칸들의 스타일에 `Modifier::DIM`이 없다(막는 이유와 구분 — spec §2.4).
- [ ] **Step 2: RED 확인** — `cargo test -p handicap-tui --test values_view_test` FAIL · `cargo test -p handicap-tui --test app_test choice_note` FAIL.
- [ ] **Step 3: 구현**
  - `activate_value`(`app.rs` — `display_block` 계산 바로 뒤): `display_block.is_none() && row.secret_name`이면 `display_note = Some(text::DISPLAY_SECRET_NOTE)`.
  - `OverlayView::Choice` 만들기(`app.rs`의 `Overlay::AddChoice` → `OverlayView::Choice`)에 `note`를 넘긴다.
  - 그리기(`settings.rs` Choice 갈래):
    - 안내는 두 선택 줄 바로 아래에 `fit`한 한 줄이다. 스타일은 막는 이유의 `muted`가 아니라 강조색이다(구현자가 기존 색 상수에서 고른다).
    - 줄 예산: 안내가 있으면 머리 조건을 `bh >= 6`(`cap = bh - 5`)로 바꾸고, 안내 자체는 `bh >= 5`일 때 낸다. 안내가 없으면 기존 예산 그대로다(byte-identical).
- [ ] **Step 4: GREEN + 이빨** — `TZ=UTC cargo test -p handicap-tui` PASS. 고의 회귀를 두 번 넣어 RED를 확인하고 원복한다:
  - ① 문턱을 맞바꾸면(머리 `bh >= 5`·안내 `bh >= 6`) `bh == 5` 단언과 sweep이 RED.
  - ② 안내 조건에서 `display_block.is_none()`을 지우면 `choice_note_only…`가 RED.
- [ ] **Step 5: 커밋** — `git add` 위 파일들 → 커밋. 제목: `feat(tui): 비밀 같은 이름을 화면에 추가할 때 안내 (tui-2b-secrets §2.4)`.

### Task 5: GUI 비밀 이름·금지 글자 미리 채움·화면 추가 안내·잘린 본문 버튼

**Files:**
- Modify: `ui/src/monitor/conditions.ts`:
  - `isSecretName`·`lastKeyOf`
  - `ConditionClick` body에 `key: string | null`
  - `export type CondHint = "volatile" | "secret" | null`
  - `defaultCondition` 반환을 `{ condition, hint: CondHint }`로
- Modify: `ui/src/components/monitor/PreviewResult.tsx`:
  - body click에 `key: lastKeyOf(l.segments)`
  - `AddChoice`에 `secretName: boolean` prop + 안내
  - `belowHeading` 버튼에 `!resp.body_truncated`
- Modify: `ui/src/components/monitor/ConditionRow.tsx` (`volatileHint?: boolean` → `hint?: CondHint`)
- Modify: `ui/src/i18n/ko.ts` (`ko.monitor.condSecretHint`·`ko.monitor.displaySecretNote`)
- Test: `ui/src/monitor/__tests__/conditions.test.ts`, `ui/src/components/monitor/__tests__/PreviewResult.test.tsx`, `ui/src/components/monitor/__tests__/ConditionRow.test.tsx`
- Test(기존 테스트 보정):
  - `ui/src/pages/__tests__/MonitorEditPage.test.tsx`: `preview_long_string_defaults_not_empty_with_hint`(작성 시점 1068 근처)가 키 `token` + 41자로 `condVolatileHint`를 단언한다. `token`은 이제 비밀 이름이라 키를 `trace_id`로 바꿔 길이 갈래를 계속 지킨다.
  - `conditions.test.ts`의 기존 body click 리터럴(작성 시점 40·43·47·49·51)에 `key`를 넣는다. `key`는 필수 필드로 둔다 — 빠뜨리면 `tsc -b`가 잡는다. `grep -rn 'kind: "body"' ui/src`로 전수 확인한다.

**Interfaces:**
- Consumes: Task 2 `isForbiddenTextChar`(`ui/src/scenario/jsonPath.ts`).
- Produces:
  - `export function isSecretName(name: string): boolean`
  - `export function lastKeyOf(segments: ReadonlyArray<Segment>): string | null` — 배열 첨자를 건너뛴 마지막 키. 키가 없으면 `null`. `JsonValueTree`의 `lastKey`와 달리 `"value"` 폴백을 쓰지 않는다.

- [ ] **Step 1: 실패하는 테스트**
  - `conditions.test.ts`:
    - `isSecretName` 표: Task 3 `secret_name_table`과 **같은 행·같은 순서**, "Keep in sync" 주석.
    - `lastKeyOf`: `[]` → `null`, `[index 0]` → `null`, `[key tokens, index 0]` → `"tokens"`, `[key a, key b]` → `"b"`.
    - `defaultCondition` 대조표: Task 3 `default_condition_prefill_parity`와 **같은 행**. 단 TUI 전용 `Authorization` → `Masked` 행 대신 GUI 행 `("Set-Cookie" 헤더, "sid=abc")` → `not_empty`, `""`, `"secret"`을 둔다. 문자열 행은 `{kind:"body", path:"$.<이름>", value, key:<이름>}`이다. 숫자 행은 `value: 5`다.
    - 기존 `volatileHint` 단언 3곳은 `hint`로 바꾼다(기대값 의미는 같다).
  - `ConditionRow.test.tsx`: `hint="secret"`이면 `ko.monitor.condSecretHint`가, `hint="volatile"`이면 `ko.monitor.condVolatileHint`가 보인다. 둘 다 아니면 어느 것도 없다.
  - `PreviewResult.test.tsx`:
    - **US3**: `body_truncated: true`이고 본문이 JSON이 아닌 응답이면 `ko.monitor.condAddBodyText` 버튼이 없다(`queryByRole("button",{name})` → null). 같은 본문이 `body_truncated: false`면 버튼이 있다(이빨 짝).
    - **US5**: 본문 `{"session_id":"s","name":"n"}` 트리에서 `session_id` `+ 추가`를 누르면 `ko.monitor.displaySecretNote`가 보이고 `화면에 추가` 버튼은 활성이다. `name` `+ 추가`에서는 안내가 없다. 표시 값이 가득 찬(`displayItems` 2개) 상태에서는 기존 `displayMax` 이유만 보이고 안내는 없다.
    - **US1**: `session_id` → `조건으로 추가`로 열린 조건 칸의 규칙이 `값 있음`이고, 비교값 입력이 비어 있거나 숨겨져 있고, `condSecretHint`가 보인다.
  - 테스트 파일을 **먼저** 편집한다(`tdd-guard` — `ui/CLAUDE.md`).
- [ ] **Step 2: RED 확인** — `cd ui && pnpm test conditions` · `pnpm test PreviewResult` · `pnpm test ConditionRow` FAIL.
- [ ] **Step 3: 구현**
  - `defaultCondition`의 `str` 갈래 순서: 이름이 비밀이고 `v !== ""`면 → `not_empty` + `"secret"`. 그다음 `len(v) > 40` 또는 `[...v].some(isForbiddenTextChar)`면 → `not_empty` + `"volatile"`. 나머지는 `eq`다.
  - 이름: 헤더는 `click.name`, 본문은 `click.key`(`null`이면 비밀 아님)다.
  - `AddChoice` 안내: `reason === undefined && secretName`일 때 버튼 줄 안에 `<span>`을 둔다. 막는 이유의 `text-slate-500`과 다른 강조색을 쓰고(구현자가 고른다), `aria-describedby`로 `화면에 추가` 버튼에 잇는다.
  - `secretName`은 `StepRow`가 click으로 계산해 넘긴다(헤더 `name`·본문 `key`). 응답 코드는 `false`다.
- [ ] **Step 4: GREEN + 이빨** — 위 세 파일 PASS. 고의 회귀를 세 번 넣어 RED를 확인하고 원복한다:
  - ① `!resp.body_truncated`를 지우면 US3이 RED.
  - ② 금지 글자 검사를 지우면 탭 행·U+200F 행이 RED.
  - ③ `lastKeyOf`가 `"value"`로 폴백하게 바꾸면 `lastKeyOf([])` → `null` 단언이 RED.
- [ ] **Step 5: 게이트 + 커밋** — `cd ui && pnpm lint && pnpm test && pnpm build`(전체). `find ui/src -name '*.test.ts*' | grep -v __tests__` 출력이 없어야 한다. 그다음 `git add` 위 파일들 → 커밋. 제목: `feat(ui): 비밀 같은 이름·금지 글자 미리 채움·잘린 본문 버튼 (tui-2b-secrets §2·§3)`.

---

## 구현 뒤 (orchestrator — task 아님)

- **최종 리뷰**: `handicap-reviewer` 전체 브랜치 + `security-reviewer`(spec §6 — grep 결과와 무관하게 필수). 초점은 "옛 동작에 기대던 소비처"다. 옛 동작 둘이 대상이다: `volatileHint`(GUI) 그리고 경로 글자가 바뀐 시나리오 에디터 추출 경로.
- **라이브**: spec §6 US1–US5 전부. TUI는 tmux, GUI는 Playwright, US4는 curl과 번들 가져오기다. 옛 보드 파일로 TUI를 시작해 오류 문구도 본다. TUI·GUI가 저장한 조건을 필드 단위로 대조한다.
- **마무리**: `/finish-slice`. roadmap §B 블록에 다음을 적는다:
  - 판단·연기
  - 릴리즈 노트 한 줄(spec §4.2: "제어·방향 제어 글자가 든 보드 파일은 가져오기·TUI 시작에서 거절된다 — 오류가 가리키는 칸을 고칠 것")
  - §B52 (2) 1–3번째 항목 해소 표시
  - §B52 "GUI 입력 길 걸러진다" 정정
  - 연기: 내보내기 쪽(`api/monitor_transfer.rs`)의 오류 문구도 날것 `b.name`을 되풀이한다. DB에 이미 있는 bidi 이름 보드가 대상이다(plan 리뷰 info).
