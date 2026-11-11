# 터미널 모니터 2a-1 — 칸 설정 수정·환경/시나리오 변수 값 수정·파일 저장 (tui-2a-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `handicap-tui`의 칸 설정 화면(1b 읽기 전용)을 편집 메뉴로 바꾼다 — 번호로 항목을 골라 값을 고치면 바로 점검에 반영되고 보드 파일에 저장된다(백업 `.bak`·원본 `.orig.bak`). 칸이 쓰는 **환경 변수 값**(US7)과 **시나리오 `variables:` 고정 값**(US8, YAML 그 한 줄만 교체)도 같은 화면에서 고친다. 1b 연기 "꺼진 보드 빈 목록 문구"를 함께 고친다. 미리 실행은 2a-2(이 plan 밖).

**Architecture:** 편집은 전부 루프백 REST로 서버에 먼저 반영하고(`PUT` 보드·환경·시나리오 — 서버 검증이 권위), 성공하면 `POST /export`로 받은 번들 바이트를 파일에 쓴다. 판단 로직은 순수 모듈 넷 — `yaml_var.rs`(한 줄 교체·검증), `edit.rs`(항목별 편집 규칙·칸 설정 변환·공유 칸 수), `input.rs`(입력줄 편집기), `filesave.rs`(지문·백업·원자 교체) — 에 두고, 화면 상태·키는 `app.rs`의 `SubViews`에 순수 함수로(1b 방식), 그리기는 `view/settings.rs`·새 `view/edit.rs`가 뷰 모델만 받아 그린다. 서버 호출(열 때의 조회·저장)은 1b 기록 조회 작업자와 **다른** 작업자 태스크 하나가 차례로 처리한다(`spawn_edit_worker`). 컨트롤러·엔진·GUI는 0-diff.

**Tech Stack:** Rust(edition 2024, tui crate `rust-version = "1.88"`), ratatui 0.30(crossterm 재수출), reqwest, serde/serde_json, **serde_yaml 0.9(새, workspace)**, **sha2 0.10(새)**, tempfile(기존), tokio, wiremock(테스트).

**Spec:** `docs/superpowers/specs/2026-11-07-tui-monitor-design.md` US4·US7·US8, §0(2a-1 행), **§6.1–6.4·§6.6·§6.7**(§6.5 미리 실행은 2a-2), §5.2(마우스 예외), §8(2a 단위·파일 쓰기·라이브 항), §9(2a 줄), §10(2a 한계 3줄). 화면 목업 `docs/superpowers/specs/2026-11-11-tui-2a-mockups/01-screens.html`(사용자 승인 — 글자 배치의 기준, **§6 머리의 "목업과 다른 점" ①②③과 이 plan의 표가 우선**). 목업 §6(미리 실행)은 2a-2.

REVIEW-GATE: APPROVED

## 사용자 스토리 (US) — spec에서 발췌(byte-exact 원천은 spec)

- **US4** *(2a)*: 운영자가 칸 설정을 고쳐야 한다 — 칸에서 Enter → 번호로 항목 선택 → 값 수정하면 바로 점검에 반영되고 TUI를 재시작해도 유지된다(json에 저장, 백업 남김). 묶음 칸에서 미리 실행하면 **그 칸의 스텝만** 결과로 보인다. 도움말은 "새 파일로 바꾸면 이 PC에서 고친 값은 사라진다"를 알린다. — **2a-1 범위 = 미리 실행 문장을 뺀 나머지.**
- **US7** *(2a)*: 운영자가 서버 주소나 토큰이 바뀌어 점검이 실패하기 시작했다 — 칸 설정에서 그 칸이 쓰는 환경 변수 값을 고치면(같은 환경을 쓰는 칸이 여럿이면 그 수를 보고 확인) 다음 점검부터 새 값으로 돌고 TUI를 재시작해도 유지된다. 값은 화면에 기본으로 가려져 있다.
- **US8** *(2a)*: 운영자가 시나리오 변수(`variables:`의 고정 값, 예: 조회할 주문 번호)를 바꿔야 한다 — 칸 설정에서 값만 고치면 다음 점검부터 반영되고, 저장된 파일의 그 시나리오 YAML은 그 값 한 줄 말고는(주석 포함) 글자 그대로다. 고칠 수 없는 모양의 값이면 저장하지 않고 "GUI에서" 안내가 보인다.

## 선행 결정 (리뷰어·사용자 확인용)

| 질문 | 결정 | 근거 |
|---|---|---|
| 컨트롤러 변경이 필요한가 | **아니오 — 0-diff.** 보드·환경·시나리오 PUT, export가 이미 있다 | 사실 근거 C1–C4 |
| 화면 상태를 어디에 두나 | 1b `SubViews`에 `edit: Option<EditUi>`를 더한다. `Screen`엔 새 변형 넷(`EditList`·`EnvVars`·`ScenarioVars`, 그리고 편집 메뉴는 기존 `Settings` 재사용). 입력줄·목록 창·조건 수정 칸·확인 줄·저장 중은 **화면이 아니라 `EditUi.overlay`** — 키는 overlay가 있으면 overlay가 먼저 받는다 | 1b `SubViews` 패턴, spec §6.7 모드 표 |
| 입력줄의 키 | `handle_key`가 화면 판정 **전에** overlay가 입력줄인지 보고, 그렇다면 `normalize_char`·`q` 종료·Ctrl+문자 무동작을 거치지 않는 `input_key`로 보낸다 | spec §6.7, C11 |
| 서버 호출 작업자 | `spawn_edit_worker` 하나 — `EditReq::{LoadEnv, LoadScenario, SaveBoard, SaveEnv, SaveScenario}`를 차례로. 저장 요청은 서버 PUT → export → 파일 쓰기까지 **작업자 안에서** 끝내고 결과 하나(`EditDone`)를 돌려준다(UI가 단계 사이에 끼지 않는다 — 5분 복귀·보드 전환과 무관하게 끝까지) | spec §6.2 끝 단락, roadmap §B48 (2) 조회 큐 교훈 |
| 파일 쓰기 상태(기대 지문·`.orig.bak` 판단 여부·경고) | `filesave::FileState`를 **작업자가 소유**(UI 루프와 공유 안 함). 경고 문구는 `EditDone`에 실려 UI의 `App.file_notice`로 | 저장이 차례로만 일어나므로 잠금 불필요 |
| 지문 기록 위치 | `logging::state_dir()/tui-writes.json` = `{"<실제 경로>": "<sha256 hex>"}` 맵(여러 파일). 상태 디렉터리 없음 → 기록 안 함(`.orig.bak` 판단은 "밖에서 온 파일") | spec §6.2-4ⓑⓔ, C12 |
| 보드 PUT 본문 | 캐시된 `BoardResponse.config`를 복제해 그 칸만 `edit.rs` 변환으로 바꾼 전체 + `name`. 서버 응답 보드로 캐시 교체 | spec §6.2-1·2, C1 |
| 환경 목록·키 이름 | `Names`에 `env_order: Vec<(id, name)>`(번들 순서)·`env_keys: HashMap<id, Vec<String>>`(키만, `vars`를 `IgnoredAny` 값으로 읽어 값은 메모리에 안 남김)·`scenario_vars: HashMap<id, Vec<(key, VarKind)>>` | spec §6.1 13·14 행, C10 |
| 공유 칸 수 | `edit::usage(boards, |p| p.environment_id == Some(id))` → `(칸 수, 보드 수)` — 세션 보드 캐시 전부 | spec §6.3 |
| `칸 N:` 접두 | `edit::strip_panel_prefix(msg, panel_no)` — 고치는 칸 번호와 같을 때만 뗀다 | spec §6.1, C5 |
| 2b 자리 | 11·12에 항목이 없을 때 안내만(`조건 추가는 GUI에서(다음 버전에서 TUI 지원)`). 추가 동작은 만들지 않는다 | spec §6 머리 |

## Global Constraints

- 변경 범위는 `crates/tui/**`와 문서뿐 — `crates/controller`·`crates/engine`·`ui/`·proto·마이그레이션 0-diff. 매니페스트 변경은 Task 1의 `crates/tui/Cargo.toml` 두 줄(`serde_yaml.workspace = true`, `sha2 = "0.10"`) + `Cargo.lock`.
- tui crate `rust-version = "1.88"`: 1.88에 없는 std API 금지. clippy `-D warnings`(2-arm `match … _ => {}` 대신 `if let`).
- 사용자 노출 한국어 문구는 `crates/tui/src/text.rs` 한 곳. GUI와 같은 뜻의 문구는 `ui/src/i18n/ko.ts` 값과 **글자까지 같게** — `mirrored_text_exists_in_ko_ts`(`tests/judge_parity_test.rs`)에 행을 더한다.
- **화면 배치의 기준은 목업** `docs/superpowers/specs/2026-11-11-tui-2a-mockups/01-screens.html` §1–§5·§7. 화면을 그리는 task(8·9)는 구현 전에 그 절을 읽는다. 줄 구성·문구는 목업을 따르고, spec §6 머리 "목업과 다른 점"·이 plan 표가 목업과 다르면 그쪽이 우선.
- 좁은 화면 문구는 통째 단위로 줄인다(`crates/tui/CLAUDE.md` 첫 함정). 폭·높이 계산은 전부 `saturating_sub`. 새 화면·overlay는 폭 1칸·높이 1줄 단위 스윕 테스트.
- **로그(`tracing`)에 URL·헤더·본문·사유·환경 키 이름·변수 값·파일 내용을 남기지 않는다** — 단계 이름과 `io::ErrorKind`·HTTP 상태만.
- 원격·파일 유래 문자열은 그리기 전에 `inspect::sanitize`(폭 계산 **전에** — `crates/tui/CLAUDE.md`).
- crossterm은 `ratatui::crossterm` 재수출만. 새 와이어 거울은 `deny_unknown_fields`.
- 테스트에서 실제 `~/.local/state`·`~/.config`를 건드리지 않는다 — 상태 디렉터리는 인자로 주입(`filesave`), 통합 테스트는 tempdir.

## Review Focus

1. **입력줄은 글자를 글자로 받는다**: `q`·`j`·`?`·한글 자모·대문자가 그대로 버퍼에 들어가고 종료 확인·이동이 일어나지 않는다. `Ctrl+U`는 지우기. → Task 7 `input_mode_keys_are_literal`.
2. **한 줄 교체는 fail-closed**: 잘못 자를 법한 YAML에서 검증이 거절하고, 성공한 교체는 그 한 줄만 바꾼다(줄 끝 `\r\n` 포함 나머지 바이트 동일). → Task 2 `splice_*`.
3. **파일은 원자적으로·밖의 변경을 덮지 않게**: 쓰기 실패 시 원본 그대로·임시 파일 없음, 밖에서 바뀐 파일엔 안 씀, `.orig.bak` 규칙. → Task 4 `write_*`.
4. **서버가 거절하면 아무것도 안 바뀐다**: 파일 불변(Task 10 `save_rejected_keeps_file_and_cache` — 작업자 수준), 캐시 불변·입력줄 열린 채 서버 문구(Task 10 `apply_done_rejection_keeps_cache_and_restores` — 순수).
5. **환경 값은 기본 가림, 로그에 없음**: `v` 전 버퍼에 값 글자가 없다. 화면을 나가면 다시 가림. → Task 9 `env_values_masked_until_v`, 라이브 `grep -c`.
6. **묶음 칸 읽기 전용 규칙이 GUI와 같다**: 2 항상, 3·5 묶음 칸, 4 단독 칸, 7 스텝 칸. → Task 5 `edit_kind_table`.
7. **거울 1:1**: 실 in-process 응답을 `deny_unknown_fields` 거울로. → Task 1 `env_and_scenario_round_trip_real_controller`.
8. **5분 자동 복귀가 입력 중 값을 버리고 진행 중 저장은 살린다**, 늦은 결과는 다른 칸 화면을 건드리지 않는다. → Task 7 `idle_drops_overlay_keeps_pending_save`, Task 10 `apply_done_after_idle_keeps_notice`·`apply_done_stale_panel_no_overlay`·`ticket_blocks_second_save`.

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `crates/tui/Cargo.toml` (수정) | `serde_yaml.workspace = true`, `sha2 = "0.10"` | 1 |
| `crates/tui/src/wire.rs` (수정) | `EnvironmentResponse`·`ScenarioResponse` 거울 | 1 |
| `crates/tui/src/api.rs` (수정) | `put_board`·`export`·`environment`·`put_environment`·`scenario`·`put_scenario` | 1 |
| `crates/tui/src/yaml_var.rs` (새) | `static_vars`·`splice_static_var`·`NotEditable` | 2 |
| `crates/tui/src/names.rs` (수정) | 환경 순서·환경 키 이름·시나리오 변수 키/종류 | 3 |
| `crates/tui/src/filesave.rs` (새) | `FileTarget`·`FileState`·`fingerprint`·`write_bundle`·지문 기록 | 4 |
| `crates/tui/src/session.rs` (수정) | `Session.target`·`start_fp`·`start_bytes` | 4 |
| `crates/tui/src/edit.rs` (새) | 항목 편집 규칙 표·칸 설정 변환·기준선 팔레트·조건 규칙 목록·공유 칸 수·빠지는 환경·접두 떼기 | 5 |
| `crates/tui/src/input.rs` (새) | 입력줄 편집기(글자/숫자 모드·거부 글자·붙여넣기 정리·가로 창) | 6 |
| `crates/tui/src/app.rs` (수정) | `Screen` 새 변형·`EditUi`·키(§6.7)·숫자 두 자리·붙여넣기·5분 복귀(7) / 편집 작업자·저장 연결·머리 줄 경고(10) / 변수 화면·마우스·도움말 연결(11) | 7, 10, 11 |
| `crates/tui/src/panel_settings.rs` (수정) | 13·14 항목, 메뉴 줄 → 항목 번호 표 | 8 |
| `crates/tui/src/view/settings.rs` (수정) | 편집 메뉴(선택 `▶`·안내 문구·구분 줄) + overlay(입력줄·목록 창·확인 줄·저장 중) | 8 |
| `crates/tui/src/view/edit.rs` (새) | 하위 목록(기준선·조건·표시)·조건 수정 칸·환경 변수·시나리오 변수 화면 | 9 |
| `crates/tui/src/view/monitor.rs` (수정) | `HeaderView.notice: Option<HeaderNotice>`(저장됨·파일 경고) | 8 |
| `crates/tui/src/view/overlay.rs` (수정) | 도움말 새 줄 | 11 |
| `crates/tui/src/terminal.rs` (수정) | `EnableBracketedPaste`/`DisableBracketedPaste` | 11 |
| `crates/tui/src/inspect.rs` (수정) | 꺼진 보드 빈 목록 문구 | 11 |
| `crates/tui/src/text.rs` (수정) | 새 문구 | 2, 5–11 |
| `crates/tui/src/lib.rs` (수정) | `pub mod yaml_var; pub mod filesave; pub mod edit; pub mod input;` | 2, 4, 5, 6 |
| `crates/tui/tests/edit_api_test.rs`·`yaml_var_test.rs`·`filesave_test.rs`·`edit_test.rs`·`input_test.rs`·`edit_view_test.rs`·`save_flow_test.rs` (새), `names_test.rs`·`app_test.rs`·`settings_test.rs`·`view_test.rs`·`judge_parity_test.rs`·`inspect_test.rs` (수정) | 테스트 | 1–11 |
| `docs/dev/tui-monitor.md`, spec | 매뉴얼·spec 상태 | 12 |

공통 테스트 도우미: 새 테스트 파일은 `view_test.rs`의 `buffer_text`·`draw`를 **그대로 복사**해 쓴다(테스트 파일끼리 공유 모듈 없음 — 1a 관례). in-process 세션 도우미는 `session_test.rs`의 `target`·`bundle_for`·`write`를 복사.

공통 3명령(각 task Step 4): `cargo fmt --all -- --check` · `cargo clippy -p handicap-tui --all-targets -- -D warnings` · `cargo nextest run -p handicap-tui`(+ `TZ=UTC` 한 번 — 시각 단언이 있는 task).

---

### Task 1: 의존·거울·루프백 메서드 (US4·US7·US8 기반)

**Files:**
- Modify: `crates/tui/Cargo.toml`, `crates/tui/src/wire.rs`, `crates/tui/src/api.rs`
- Test: `crates/tui/tests/edit_api_test.rs`(새)

**Interfaces — Produces:**
```rust
// wire.rs — 컨트롤러 api/environments.rs:20 / api/scenarios.rs:117 거울
/// `Debug`는 손으로(`vars` 값 대신 키 수만) — 값이 `{:?}`로 로그에 새지 않게.
#[derive(Clone, Deserialize)] #[serde(deny_unknown_fields)]
pub struct EnvironmentResponse { pub id: String, pub name: String, pub vars: BTreeMap<String, String>, pub created_at: i64, pub updated_at: i64 }
#[derive(Debug, Clone, Deserialize)] #[serde(deny_unknown_fields)]
pub struct ScenarioResponse { pub id: String, pub name: String, pub yaml: String, pub version: i64, pub created_at: i64, pub updated_at: i64 }

// api.rs — 모두 WRITE_TIMEOUT(조회 둘은 POLL_TIMEOUT), 오류는 기존 error_of/parse
impl Api {
    /// PUT /monitor-boards/{id} {name, config} → 정규화된 보드(묶음 미러 적용본)
    pub async fn put_board(&self, id: &str, name: &str, config: &BoardConfig) -> Result<BoardResponse, ApiError>;
    /// POST /monitor-boards/export {board_ids} → 응답 바이트 그대로(재직렬화 금지)
    pub async fn export(&self, board_ids: &[String]) -> Result<Vec<u8>, ApiError>;
    pub async fn environment(&self, id: &str) -> Result<EnvironmentResponse, ApiError>;
    pub async fn put_environment(&self, id: &str, name: &str, vars: &BTreeMap<String, String>) -> Result<EnvironmentResponse, ApiError>;
    pub async fn scenario(&self, id: &str) -> Result<ScenarioResponse, ApiError>;
    /// 409 = 버전 어긋남(ApiError.status == Some(409))
    pub async fn put_scenario(&self, id: &str, yaml: &str, version: i64) -> Result<ScenarioResponse, ApiError>;
}
```

- [ ] **Step 1: 실패 테스트 작성** — `tests/edit_api_test.rs`(in-process 세션 + wiremock 대상, `session_test.rs` 도우미 복사):
  - `env_and_scenario_round_trip_real_controller`: 번들 fixture(`fixtures/bundle_template.json` — 환경이 없으면 이 테스트 파일 안에서 환경 1개·`variables: {order_id: "A-1"}` 시나리오를 가진 번들 문자열을 조립)로 세션 시작 → `environment(id)`·`scenario(id)`가 `deny_unknown_fields` 거울로 역직렬화된다.
  - `put_board_returns_normalized_board`: 첫 칸 `timeout_seconds` 7로 바꿔 `put_board` → 응답 보드의 그 칸 7, 다시 `board(id)`도 7.
  - `put_board_rejects_with_server_message`: `timeout_seconds` 45 → `Err(ApiError{status: Some(400), message})`, `message == "칸 1: 제한 시간은 1~30초여야 합니다"`.
  - `export_bytes_reimport`: `export(&[id])` 바이트를 새 tempdir 파일로 써서 **두 번째 세션**을 시작 → 성공, 보드 id 같음(ADR-0054 ID 보존).
  - `put_environment_and_scenario`: 환경 값 바꿔 PUT → 다시 GET 값 바뀜. 시나리오 `yaml` 그대로 + `version` 하나 작게 → `status == Some(409)`.
- [ ] **Step 2: 실패 확인** — 컴파일 오류.
- [ ] **Step 3: 구현** — Interfaces 그대로. `Cargo.toml`에 두 의존 추가(`sha2`는 Task 4가 쓰지만 매니페스트 변경을 한 번에).
- [ ] **Step 4: 통과 확인** — 공통 3명령.
- [ ] **Step 5: 커밋** — `feat(tui): 보드·환경·시나리오 수정과 내보내기 루프백 메서드`.

---

### Task 2: 시나리오 고정 변수 한 줄 교체 — `yaml_var.rs` (US8)

spec §6.4. 엔진·서버 없는 순수 모듈.

**Files:**
- Create: `crates/tui/src/yaml_var.rs`, `crates/tui/tests/yaml_var_test.rs`
- Modify: `crates/tui/src/lib.rs`, `crates/tui/src/text.rs`

**Interfaces — Produces:**
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotEditable { Generated, Shape }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaticVar { pub key: String, pub value: String, pub editable: Result<(), NotEditable> }

/// `Scenario::from_yaml`의 `variables` 순서(BTreeMap = 키 순). Static은 `value` = 값, `editable` = 같은 값으로
/// `splice_static_var`를 한 번 돌린 결과. Gen은 `value` = "" + `Err(Generated)`. YAML을 못 읽으면 빈 목록.
pub fn static_vars(yaml: &str) -> Vec<StaticVar>;

/// spec §6.4 1–4. 성공하면 그 값 구간만 `serde_json::to_string(new)`로 바뀐 전체 YAML.
pub fn splice_static_var(yaml: &str, key: &str, new: &str) -> Result<String, NotEditable>;
```
- 알고리즘(spec §6.4 그대로): ① 줄을 `split_inclusive('\n')`로 나눠 각 줄 끝(`\r\n`/`\n`/없음)을 떼어 둔다 ② 열 0 `variables:` 줄(뒤 공백·`#…`만) 정확히 1개 ③ 블록 = 다음 "열 0이 공백도 `#`도 아닌 줄" 전까지, 블록 첫 비공백·비주석 줄의 들여쓰기 = 항목 들여쓰기 ④ 그 들여쓰기로 시작하고 키(`key`·`"key"`·`'key'`) + `:` + 공백 1개 이상인 줄 **정확히 1개**(들여쓰기가 더 깊은 줄은 보지 않는다) ⑤ 값 구간: `'`로 시작 → 짝 `'`(`''`는 이스케이프)까지 / `"`로 시작 → 짝 `"`(`\` 다음 글자 건너뜀)까지 / 그 밖 → 첫 ` #`(공백+`#`) 전 또는 줄 끝, 뒤 공백 제외. 값이 비었거나 `| > & * ! { [`로 시작 → `Shape` ⑥ 값 구간을 `serde_json::to_string(new)`로 바꾸고 줄 끝을 다시 붙인다 ⑦ 검증: `serde_yaml::from_str::<Value>` 옛·새, `옛.variables[key] = Value::String(new)`로 고친 값 == 새, 그리고 `Scenario::from_yaml(새).is_ok()` — 아니면 `Shape`.
- 키가 Gen이면 ①–⑦ 전에 `Generated`(`Scenario::from_yaml` 결과로 판정). 키가 없으면 `Shape`.
- 문구(`text.rs`, TUI 전용): `VAR_GENERATED = "생성 변수 — GUI에서"`, `VAR_SHAPE = "이 값의 모양은 TUI에서 못 고칩니다 — GUI에서"`.

- [ ] **Step 1: 실패 테스트 작성** — `tests/yaml_var_test.rs`. 공통 시나리오 본체 = `version: 1`·`name: s`·`steps:`에 http 스텝 하나(ULID id). 각 케이스는 `variables:` 블록만 바꾼다. **도우미 `fixture(vars_block) -> String`은 조립한 YAML에 `assert!(Scenario::from_yaml(&y).is_ok())`를 건다** — `Scenario`는 `deny_unknown_fields`, 고정 변수는 **문자열만**(`genvars.rs` `visit_str`뿐 — `a: 1` 같은 숫자 값은 시나리오 자체가 무효라 모든 거절 케이스가 공허하게 `Shape`가 된다). 모든 값은 따옴표 문자열 또는 숫자로 안 읽히는 일반 문자열(`A-1`)로.
  - 성공 + **diff 한 줄**(도우미 `changed_lines(a, b) -> Vec<usize>`가 `[그 줄 번호]`): 일반 값 `order_id: A-1` / `'A-1'` / `"A-1"` / 뒤 주석 `order_id: "A-1"  # 주문` → 주석 보존 / 값 속 `#`(`tag: a#b`) → `"Z"`로 바뀌고 `a#b` 전체가 사라짐 / `''` 든 `'it''s'` / `\"` 든 `"a\"b"` / 새 값에 `"`·`\`·한글·`${ENV}` → 다시 읽은 값이 정확히 새 값.
  - **CRLF**: 모든 줄 끝 `\r\n`인 YAML → 결과도 모든 줄 `\r\n`, 바뀐 줄 하나.
  - **거절·오인 방지**: 시나리오 `notes: |`(유효 필드) 블록 안에 `  variables:`·`  order_id: X` 모양 줄이 있고 진짜 `variables:`는 아래 → 진짜 쪽만 바뀌고 `notes` 값이 원문 그대로 / 블록 안 더 깊은 들여쓰기의 같은 키 모양(`  a: "1"` 아래 주석 줄 `    # a: "2"`) → 얕은 쪽만 / 흐름 표기 `variables: {a: "1"}` → `Shape` / 앵커 `a: &x "1"` → `Shape` / 별칭 `b: *x` → `Shape` / 여러 줄 값 `a: |\n  x` → `Shape` / 생성 변수(`a: {gen: uuid}` — 엔진 `genvars.rs` 허용 형식으로) → `Generated` / 키 없음 → `Shape` / `variables:`가 두 번 → `Shape`.
  - `static_vars`: 고정 2개 + 생성 1개 → 키 순서, 고정은 `editable == Ok(())`, 생성은 `Err(Generated)`, 앵커 값 고정 변수는 `Err(Shape)`.
- [ ] **Step 2: 실패 확인** — 컴파일 오류.
- [ ] **Step 3: 구현** — Interfaces·알고리즘 그대로.
- [ ] **Step 4: 통과 확인** — 공통 3명령. 추가로 **고의 회귀 실증**: 케이스 `multiline_plain_rejected_by_verify` — 일반 값이 다음 줄로 이어지는 유효 YAML(`  order_id: A-1\n    B-2` — 일반 스칼라의 줄 이어짐, 값 = `"A-1 B-2"`)은 ⑤가 `A-1`만 잘라 `"Z"`로 바꾸므로 결과가 무효/다른 값 → ⑦만이 막는다. ⑦을 주석 처리 → 이 케이스 RED 확인 → 원복 → GREEN(구현 보고에 두 결과를 적는다).
- [ ] **Step 5: 커밋** — `feat(tui): 시나리오 고정 변수 한 줄 교체와 검증`.

---

### Task 3: 이름 해석 넓히기 — 환경 순서·키 이름·시나리오 변수 키 (US7·US8 기반)

spec §6.1 13·14 행 아래 첫 불릿. 1b 원칙 유지: 환경 **값**은 메모리에 들지 않는다.

**Files:**
- Modify: `crates/tui/src/names.rs`, `crates/tui/tests/names_test.rs`

**Interfaces — Produces:**
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VarKind { Static, Generated }
impl Names {
    /// 번들 `environments[]` 순서의 (id, 이름).
    pub fn env_order(&self) -> &[(String, String)];
    /// 그 환경의 변수 키(번들에 적힌 순서가 아니라 키 순 — 서버 BTreeMap과 같게). 모르는 환경이면 None.
    pub fn env_keys(&self, environment_id: &str) -> Option<&[String]>;
    /// 그 시나리오 `variables`의 (키, 종류), 키 순. 못 읽은 시나리오면 None.
    pub fn scenario_vars(&self, scenario_id: &str) -> Option<&[(String, VarKind)]>;
}
```
- `EnvLite`에 `#[serde(default)] vars: BTreeMap<String, serde::de::IgnoredAny>` — 키만 남고 값은 버려진다(값 문자열이 할당되지 않는다는 보장은 serde 동작 — 테스트는 키만 단언).

- [ ] **Step 1: 실패 테스트 작성** — `names_test.rs`에: 환경 2개(번들 순서 E2, E1) → `env_order` 순서 E2, E1 / `env_keys("E1") == ["API_TOKEN", "BASE_URL"]`(키 순) / 변수 없는 환경 → `Some([])` / 모르는 id → None / 시나리오 변수 고정 2·생성 1 → 키 순·종류 / 깨진 YAML 시나리오 → None.
- [ ] **Step 2: 실패 확인**.
- [ ] **Step 3: 구현**.
- [ ] **Step 4: 통과 확인** — 공통 3명령.
- [ ] **Step 5: 커밋** — `feat(tui): 번들에서 환경 순서·변수 키 이름 읽기`.

---

### Task 4: 파일 저장 — 지문·백업·원자 교체 (`filesave.rs`, US4)

spec §6.2-4·5. 서버 없는 순수+파일 모듈. 상태 디렉터리는 인자로 주입.

**Files:**
- Create: `crates/tui/src/filesave.rs`, `crates/tui/tests/filesave_test.rs`
- Modify: `crates/tui/src/lib.rs`, `crates/tui/src/session.rs`, `crates/tui/src/text.rs`

**Interfaces — Produces:**
```rust
pub type Fingerprint = [u8; 32]; // SHA-256
pub fn fingerprint(bytes: &[u8]) -> Fingerprint;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileTarget { pub given: PathBuf, pub real: PathBuf } // real = canonicalize(given) (시작 때)
impl FileTarget { pub fn bak(&self) -> PathBuf; pub fn orig_bak(&self) -> PathBuf; } // real + ".bak" / ".orig.bak"

/// 작업자가 소유. `expected` = 시작 때 읽은 내용의 지문, 쓸 때마다 갱신. `first_done` = 이 세션에서 한 번 썼나.
#[derive(Debug, Clone)]
pub struct FileState { pub target: FileTarget, pub start: Fingerprint, pub expected: Fingerprint, pub first_done: bool, pub state_dir: Option<PathBuf> }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteStage { ReadCurrent, ChangedOutside, OrigBackup, Backup, Temp, Persist }
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteError { pub stage: WriteStage, pub kind: Option<std::io::ErrorKind> }

/// spec §6.2-4 ⓐ–ⓔ. `start_bytes`는 ⓑ에서 `.orig.bak`을 쓸 때만 쓰인다(세션 시작 때 읽은 바이트).
pub fn write_bundle(st: &mut FileState, start_bytes: &[u8], new_bytes: &[u8]) -> Result<(), WriteError>;
/// ⓓ만(같은 디렉터리 임시 파일 → 권한 → fsync → persist → 디렉터리 fsync). `.bak`·`.orig.bak`도 이 함수로 쓴다.
pub fn replace_atomic(real: &Path, bytes: &[u8], perm: std::fs::Permissions) -> Result<(), WriteError>;

/// `<state_dir>/tui-writes.json` 읽기/쓰기 — `{실제 경로 문자열: 64자 hex}`. 없거나 깨졌으면 빈 맵. 쓰기는 임시 파일+rename.
pub fn last_written(state_dir: &Path, real: &Path) -> Option<Fingerprint>;
pub fn record_written(state_dir: &Path, real: &Path, fp: &Fingerprint) -> std::io::Result<()>;
```
- ⓐ 지금 파일을 읽어(`metadata()`가 일반 파일이 아니면 `ReadCurrent` — FIFO로 바뀐 경로에서 작업자가 영원히 막히지 않게, `read_capped`와 같은 순서 / `len()` > 32 MB면 `ReadCurrent` — `read_capped`는 `io::ErrorKind`를 버리므로 쓰지 않고 `std::fs::read`로, 실패 = `ReadCurrent` + 그 kind) 지문 ≠ `expected` → `Err(ChangedOutside)`, 아무것도 안 씀.
- ⓑ `!first_done`일 때: `state_dir`가 있고 `last_written(..) == Some(start)` → 건너뜀, 아니면 `start_bytes`를 `orig_bak()`에 원자적으로 씀(같은 임시 파일+persist 경로, 원본 권한).
- ⓒ 지금 파일 내용을 `bak()`에(원자적으로, 원본 권한).
- ⓓ `NamedTempFile::new_in(real.parent())` → `write_all` → 권한 = 원본 `metadata().permissions()` → `as_file().sync_all()` → `persist(real)` → 부모 디렉터리 `File::open(dir)?.sync_all()`(unix만, 실패는 무시하고 로그 종류만).
- ⓔ `expected = fingerprint(new_bytes)`, `first_done = true`, `state_dir`가 있으면 `record_written`(실패는 `tracing::warn!(kind = ?e.kind())`만).
- `session.rs`: `Session`에 `pub target: FileTarget`·`pub start_fp: Fingerprint`·`pub start_bytes: Option<Vec<u8>>`(시작 때 이미 읽은 번들 바이트 — `.orig.bak`용. 32 MB 상한 안). **소유권을 작업자에게 넘긴다**: Task 10이 `session.start_bytes.take()`로 꺼내 `spawn_edit_worker`에 주고, 작업자는 첫 파일 쓰기 뒤 버린다(`Session`에 사본이 남지 않게).
- 문구(`text.rs`): `FILE_SAVED = "저장됨"`(뒤에 ` HH:MM:SS`), `FILE_SAVE_FAILED = "파일에 저장 못 함 — 재시작하면 사라짐"`, `FILE_CHANGED_OUTSIDE = "보드 파일이 밖에서 바뀌었습니다 — 저장 안 됨, TUI를 다시 시작하세요"`.

- [ ] **Step 1: 실패 테스트 작성** — `tests/filesave_test.rs`(전부 tempdir, 상태 디렉터리도 tempdir):
  - `write_first_creates_orig_and_bak`: 파일 A → `write_bundle(B)` → 파일 = B, `.bak` = A, `.orig.bak` = A, 기록 = fp(B).
  - `orig_kept_when_last_written_matches`: 기록 = fp(A)로 미리 써 두고 A로 시작 → B 쓰기 → `.orig.bak` 없음(만들지 않음). 미리 `.orig.bak` = O가 있으면 그대로 O.
  - `orig_refreshed_when_from_outside`: 기록 = fp(X)(다름)·`.orig.bak` = O → A로 시작해 쓰기 → `.orig.bak` = A. 상태 디렉터리 `None` → 같은 결과.
  - `second_write_keeps_orig_updates_bak`: B → C 연속 → `.orig.bak` = A 그대로, `.bak` = B.
  - `changed_outside_refuses`: 시작 후 파일을 Z로 바꿈 → `Err(ChangedOutside)`, 파일 = Z, `.bak`·`.orig.bak` 없음.
  - `permissions_preserved`(unix): 원본 **0640**(tempfile 기본 0600과 달라야 단언이 의미 있다) → 새 파일·`.bak`·`.orig.bak` 모두 0640.
  - `symlink_target_replaced_link_kept`(unix): `link.json → real/b.json` → `FileTarget{given: link, real: canonicalize}` → 쓰기 후 `link.json`은 여전히 링크, 실제 파일 = B, 백업은 `real/b.json.bak`.
  - `backup_failure_leaves_original`: `<real>.bak` 자리에 **디렉터리**를 만들어 둠(권한과 무관 — root CI에서도 실패) → `Err(stage == Backup)`, 원본 그대로, 부모 디렉터리에 임시 파일 없음.
  - `replace_atomic_failure_cleans_temp`: ⓓ를 `pub fn replace_atomic(real: &Path, bytes: &[u8], perm: Permissions) -> Result<(), WriteError>`로 떼어 직접 테스트 — `real`이 비어 있지 않은 **디렉터리**면 `persist`가 실패 → `Err(stage == Persist)`, 디렉터리 그대로, 부모에 임시 파일 없음(`NamedTempFile` drop 정리 확인).
  - `record_file_roundtrip_and_corrupt`: 기록 두 경로 → 각자 읽힘, 깨진 JSON → `last_written == None`.
- [ ] **Step 2: 실패 확인**.
- [ ] **Step 3: 구현** — Interfaces 그대로. `session.rs`는 `FileTarget`(시작 때 `canonicalize` 실패면 `real = given`)·`start_bytes`·`start_fp`를 채운다(기존 `file` 필드·도움말은 그대로 `given`).
- [ ] **Step 4: 통과 확인** — 공통 3명령.
- [ ] **Step 5: 커밋** — `feat(tui): 보드 파일 저장 — 지문 확인·백업·원자 교체`.

---

### Task 5: 편집 규칙·칸 설정 변환 — `edit.rs` (US4·US7·US8)

spec §6.1 표와 불릿들, §6.3 공유 칸 수. 순수 함수만.

**Files:**
- Create: `crates/tui/src/edit.rs`, `crates/tui/tests/edit_test.rs`
- Modify: `crates/tui/src/lib.rs`, `crates/tui/src/text.rs`, `crates/tui/src/names.rs`(`StepInfo.branch_hint`), `crates/tui/tests/names_test.rs`(`StepInfo` 리터럴 + 힌트 단언), `crates/tui/tests/judge_parity_test.rs`

**Interfaces — Produces:**
```rust
use handicap_controller::monitor::config::{BoardConfig, PanelConfig, ConditionOp, ConditionSource};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field { Title, Interval, Timeout, BarCount, GraphMax } // 입력줄 항목
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pick { Env, Step, Latency }                         // 목록 항목
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListKind { Thresholds, Conditions, Display }       // 하위 목록
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditKind { Input(Field), Pick(Pick), List(ListKind), EnvVars, ScenarioVars, ReadOnly(&'static str) }

/// 항목 번호 1..=14 → 편집 종류(spec §6.1 표의 "고칠 수 없을 때" 열이 ReadOnly 문구). 범위 밖은 ReadOnly("").
pub fn edit_kind(no: usize, p: &PanelConfig, names: &Names) -> EditKind;
/// 숫자 입력줄 범위(서버 validate_panel과 같음) — Title이면 None.
pub fn field_range(f: Field) -> Option<(u32, u32)>;
pub fn field_value(p: &PanelConfig, f: Field) -> String;

/// 칸 설정 변환 — 모두 `cfg`를 복제해 `panel_idx` 칸만 바꾼 새 BoardConfig.
pub fn set_field(cfg: &BoardConfig, panel_idx: usize, f: Field, v: &str) -> BoardConfig; // 숫자는 parse 실패 시 0(서버가 거절)
pub fn set_env(cfg: &BoardConfig, panel_idx: usize, env: Option<String>) -> BoardConfig;
pub fn set_step(cfg: &BoardConfig, panel_idx: usize, step_id: &str) -> BoardConfig;      // GUI setPanelStep
pub fn set_latency(cfg: &BoardConfig, panel_idx: usize, step_id: Option<&str>) -> BoardConfig; // None = Total
pub fn threshold_add(cfg: &BoardConfig, panel_idx: usize, ms: u32) -> BoardConfig;      // 색 = THRESHOLD_COLORS[개수 % 5]
pub fn threshold_set(cfg: &BoardConfig, panel_idx: usize, i: usize, ms: u32) -> BoardConfig;
pub fn threshold_default_ms(p: &PanelConfig) -> u32;                                      // 마지막 + 1000, 없으면 1000
pub fn remove_at(cfg: &BoardConfig, panel_idx: usize, kind: ListKind, i: usize) -> BoardConfig;
pub fn swap_display(cfg: &BoardConfig, panel_idx: usize) -> BoardConfig;                  // 2개일 때 0↔1, 아니면 그대로
pub fn set_condition(cfg: &BoardConfig, panel_idx: usize, i: usize, op: ConditionOp, value: &str, ignore_case: bool, trim: bool) -> BoardConfig;
pub fn ops_for(source: ConditionSource) -> Vec<ConditionOp>; // ConditionOp 정의 순서 중 `source.allows(op)`
// 체크 표시 여부는 컨트롤러 `ConditionOp::has_flags`(GUI hasFlags와 같음)를 그대로 쓴다 — 새 함수 없음.

/// set_step 전 확인 줄에 쓸 (조건 수, 표시 값 수). 둘 다 0이면 확인 없음.
pub fn step_change_counts(p: &PanelConfig) -> (usize, usize);
/// 이 칸의 환경을 `new`로 바꾸면 세션 어느 보드의 어느 칸도 안 쓰게 되는 옛 환경 id(=파일에서 빠짐). 아니면 None.
pub fn dropped_env(boards: &[BoardConfig], board_idx: usize, panel_idx: usize, new: Option<&str>) -> Option<String>;
/// (칸 수, 보드 수) — `pred`를 만족하는 칸.
pub fn usage(boards: &[BoardConfig], pred: impl Fn(&PanelConfig) -> bool) -> (usize, usize);
/// 서버 문구 맨 앞 `칸 {panel_no}: `만 뗀다(번호가 다르면 그대로).
pub fn strip_panel_prefix(msg: &str, panel_no: usize) -> &str;
/// 볼 스텝 목록 줄: `{순번} {이름}  {METHOD} {URL}` + IF 분기 안이면 `  ({IF 이름} 분기)` (GUI stepOptionsFor branchHint = 가장 안쪽 IF 이름).
pub fn step_options(names: &Names, scenario_id: &str) -> Vec<(String /*id*/, String /*줄*/)>;
```
- `step_options`의 분기 힌트는 `Names`에 IF 이름이 없으므로 **`names.rs`의 평탄화에 힌트를 같이 실어** `StepInfo.branch_hint: Option<String>`을 더한다(Task 3과 같은 파일 — 이 task에서 수정, `names_test.rs`에 IF 안 스텝 힌트 단언 1개 추가). GUI `stepOptionsFor`와 같은 걷기(loop·parallel은 힌트 상속, if는 then·elif·else에 IF 이름).
- 문구(`text.rs`): `VALUE_UNEDITABLE = "이 값은 TUI에서 못 고칩니다 — GUI에서"`, spec §6.1 표의 안내 6개(`시나리오는 GUI에서 바꿉니다` 등)·확인 줄 3종(`step_change_confirm(n, m)`·`env_drop_confirm(name)`·`delete_confirm(n)`)·`share_note(n, boards)` = `이 값을 쓰는 칸 {n}개(보드 {b}개)가 함께 바뀝니다`·`usage_note(n, b)` = `이 환경을 쓰는 칸 {n}개(보드 {b}개)` / 시나리오판 `이 시나리오를 쓰는 칸 …`. 기호는 기존 `cond_op_label`.

- [ ] **Step 1: 실패 테스트 작성** — `tests/edit_test.rs`:
  - `edit_kind_table`: 단독 흐름 칸(step None, group None) → 1 Input(Title), 2 ReadOnly(시나리오), 3 Pick(Env), 4 ReadOnly(볼 스텝 GUI), 5 Input(Interval), 7 Pick(Latency), 8/11/12 List, 13 EnvVars(환경 있음)/ReadOnly(환경 없음), 14 ScenarioVars(변수 있음)/ReadOnly / 묶음 스텝 칸 → 3·5 ReadOnly(묶음), 4 Pick(Step), 7 ReadOnly(스텝 칸) / 11·12 비었으면 ReadOnly(조건 추가는 GUI…) / 13: 키 0개 환경 → ReadOnly(변수 없음).
  - `set_step_matches_gui_setPanelStep`: 조건 2·표시 1 → 전부 새 step_id, latency Step(새), `step_change_counts == (2,1)`.
  - `threshold_palette_and_default`: 빈 → default 1000, 추가 색 `#f59e0b`; 2개(800, 1500) → default 2500, 세 번째 색 `#a855f7`.
  - `ops_for_matches_server_allows`: Status → `[Eq, Ne, Gt, Lt, Gte, Lte, OneOf]`, BodyText → `[NotEmpty, Contains]`(정의 순서), Body → 10개 / `ConditionOp::has_flags`가 4개만(대조 단언).
  - `set_condition_keeps_target_and_step`: path·source·step_id 불변, op/value/flags만.
  - `dropped_env_rules`: 단독 칸이 혼자 쓰던 E1 → E2 → Some("E1"); 다른 보드 칸도 E1 → None; None→E2(옛 환경 없음) → None.
  - `usage_counts_across_boards`: 보드 2개 × 칸 → (칸 수, 보드 수).
  - `strip_prefix_only_own_panel`: (`"칸 3: 제한 시간…"`, 3) → `"제한 시간…"`, (…, 2) → 원문.
  - `step_options_branch_hint`: IF `분기A` 안 스텝 줄이 `  (분기A 분기)`로 끝남, 바깥 스텝은 힌트 없음.
  - `mirrored_text_exists_in_ko_ts` 행 추가: 없음(이 task의 문구는 전부 TUI 전용 — 추가 0행임을 확인만).
- [ ] **Step 2: 실패 확인**.
- [ ] **Step 3: 구현**.
- [ ] **Step 4: 통과 확인** — 공통 3명령.
- [ ] **Step 5: 커밋** — `feat(tui): 칸 설정 편집 규칙과 설정 변환`.

---

### Task 6: 입력줄 편집기 — `input.rs` (US4·US7·US8)

spec §6.7 입력줄 행·붙여넣기 불릿. 순수.

**Files:**
- Create: `crates/tui/src/input.rs`, `crates/tui/tests/input_test.rs`
- Modify: `crates/tui/src/lib.rs`

**Interfaces — Produces:**
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMode { Text { max_chars: usize }, Digits { max: usize } }
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineInput { buf: Vec<char>, cursor: usize /* 글자 위치 */, mode: InputMode }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputOutcome { Edited, Submit, Cancel, AskQuit, Ignored }
impl LineInput {
    pub fn new(initial: &str, mode: InputMode) -> LineInput; // 커서 = 끝, 초기값도 accept 규칙으로 거른다
    pub fn text(&self) -> String;
    /// 원시 KeyEvent(정규화 전). Char = 그대로 넣기(Digits는 '0'..='9'만), Enter Submit, Esc Cancel,
    /// ←→ Home End Backspace Delete, Ctrl+U 비우기, Ctrl+C AskQuit, 그 밖 Ctrl+문자 Ignored.
    pub fn key(&mut self, k: KeyEvent) -> InputOutcome;
    /// 붙여넣기: `\r`·`\n`·제어 문자를 빼고 넣는다(Digits는 숫자만).
    pub fn paste(&mut self, s: &str);
    /// 폭 `w` 칸에 보일 (글자열, 커서의 화면 x). 커서가 늘 보이게 가로로 민다(넓은 글자 2칸).
    pub fn view(&self, w: usize) -> (String, usize);
}
/// 받지 않는 글자: `char::is_control`, U+0085, U+2028/2029, `inspect::sanitize`가 `�`로 바꾸는 bidi 제어.
pub fn accept_char(c: char) -> bool;
```
- 글자 칸 상한: 제목 2000자 → 실제로는 서버 `check_name`이 더 짧게 거절할 수 있다(서버 문구가 권위). 환경·시나리오 값 2000자.

- [ ] **Step 1: 실패 테스트 작성** — `tests/input_test.rs`: `q`·`j`·`?`·`ㅂ`·`Q` 입력 → 버퍼에 그대로 + `Edited` / Digits에 `a`·`-` → `Ignored`, 7번째 숫자 → `Ignored` / `Ctrl+U` 비움, `Ctrl+C` AskQuit(버퍼 유지), `Ctrl+B` Ignored / `←` 뒤 삽입 위치 / `\u{2028}`·`\u{202E}`·`\u{85}` 거부 / 붙여넣기 `"a\r\nb\n"` → `ab`, `Submit`이 일어나지 않음 / `view`: 폭 5에 한글 10자 → 표시 폭 ≤ 5이고 커서 x < 5, 커서를 처음으로 옮기면 첫 글자가 보임 / 폭 0·1 패닉 없음.
- [ ] **Step 2: 실패 확인**.
- [ ] **Step 3: 구현**.
- [ ] **Step 4: 통과 확인** — 공통 3명령.
- [ ] **Step 5: 커밋** — `feat(tui): 입력줄 편집기`.

---

### Task 7: 편집 화면 상태·키 — 순수 함수 (US4·US7·US8)

spec §6.7 표 전체, §6.6 자리 비움, §6.1 번호 키. Review Focus 1·8. **App 연결은 Task 10·11** — 여기는 상태·키 판정만(테스트 가능하게 `SubViews`의 메서드와 자유 함수).

**Files:**
- Modify: `crates/tui/src/app.rs`, `crates/tui/tests/app_test.rs`

**Interfaces — Produces (`app.rs`):**
```rust
pub enum Screen { /* 기존 … */ Settings, EditList, EnvVars, ScenarioVars }
// is_sub: 기존 넷 + EditList·EnvVars·ScenarioVars

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Overlay {
    Input { target: InputTarget, input: LineInput, error: Option<String>, share: Option<String> },
    Pick { pick: edit::Pick, options: Vec<(Option<String>, String)>, cursor: usize },
    CondForm { index: usize, ops: Vec<ConditionOp>, op: usize, value: LineInput, ignore_case: bool, trim: bool, focus: CondFocus, error: Option<String> },
    Confirm { text: String, then: Pending, y_only: bool },
    /// 저장 중. `restore` = 서버가 거절하면 되살릴 overlay(Input·CondForm은 오류 줄을 채워서). Pick·Confirm(삭제·단계·환경 빠짐)·
    /// 자리 바꾸기에서 온 저장은 `restore = None` — 거절이면 `Notice(서버 문구)`로 보인다.
    Saving { restore: Option<Box<Overlay>> },
    Notice(String), // ReadOnly 안내·서버 거절 — 다음 키 하나로 닫힘(그 키는 메뉴로 넘어가지 않는다)
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum CondFocus { Op, Value, IgnoreCase, Trim }
#[derive(Debug, Clone, PartialEq, Eq)] pub enum InputTarget { Field(edit::Field), ThresholdNew, Threshold(usize), EnvVar(String), ScenarioVar(String) }
/// 확인 뒤 할 일(저장 요청을 만들 재료).
#[derive(Debug, Clone, PartialEq, Eq)] pub enum Pending { SetStep(String), SetEnv(Option<String>), Remove(edit::ListKind, usize) }

/// `PartialEq` 없음(환경 응답을 품는다). `Debug`는 손으로 — `env`·`scen`·입력줄 값은 `<가림>`으로 찍는다(값이 로그로 새지 않게).
#[derive(Clone, Default)]
pub struct EditUi {
    pub board_id: String, pub panel_id: String,
    pub cursor: usize,            // 메뉴 항목 0..14
    pub list_cursor: usize,       // 하위 목록·변수 화면 줄
    pub digit: Option<(u8, Instant)>, // `1` 뒤 1초
    pub overlay: Option<Overlay>,
    pub reveal: bool,             // 환경 값 보기(EnvVars를 나가면 false)
    pub env: Option<EnvLoad>,     // 13 화면 데이터(열 때 조회)
    pub scen: Option<ScenLoad>,   // 14 화면 데이터
}
#[derive(Clone)] pub enum EnvLoad { Loading { id: String }, Loaded(EnvironmentResponse), Failed(String) }
#[derive(Clone)] pub enum ScenLoad { Loading { id: String }, Loaded { id: String, yaml: String, version: i64, vars: Vec<yaml_var::StaticVar> }, Failed(String) }

/// 편집 모드의 키 → 동작. 순서: overlay 있음 → overlay 규칙(입력줄은 `LineInput::key`에 **원시 키**),
/// 없음 → 화면 규칙(정규화 + `q` 종료 확인). `now`는 두 자리 번호 판정용.
pub fn edit_key(screen: &Screen, ui: &EditUi, k: KeyEvent, now: Instant) -> EditAction;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditAction { None, AskQuit, Back, MoveCursor(isize), Jump(usize), Digit(u8), Activate /* Enter */, Remove, Swap, Add, ToggleReveal, Input(InputOutcome), PickMove(isize), PickChoose, CondKey(KeyEvent), ConfirmYes, ConfirmNo, CloseNotice }
/// 숫자는 **언제나 즉시** 이동한다: `1`–`9` → 그 번호(그리고 `1`이면 1초 대기 표시를 남김). 대기 중(1초 안)에 `0`–`4`가 오면
/// 10–14로 **다시** 이동하고 대기를 지운다. 대기 중 `5`–`9`·`1`은 그 번호로(대기는 `1`이면 새로). 타이머가 필요 없다 — `1`만 누르고
/// 기다리면 이미 1번에 가 있다.
pub fn digit_jump(prev: Option<(u8, Instant)>, d: u8, now: Instant) -> (usize /*이동할 번호 1..=14*/, Option<(u8, Instant)> /*새 대기*/);
/// 입력 중인 overlay(Input·Pick·CondForm·Confirm·Notice)를 버린다. `Saving`은 남긴다(진행 중 저장).
pub fn idle_drop(ui: &mut EditUi);
```
- `handle_key`: `Screen::Settings | EditList | EnvVars | ScenarioVars`이고 `views.edit`가 있으면 `edit_key`로 보낸다(그 경로 안에서만 정규화를 적용). 기존 `handle_key` 시그니처는 그대로 두고, App이 편집 화면이면 `edit_key`를 먼저 부른다(Task 10).
- 정규화 표(화면 규칙): 기존 `normalize_char` + `ㅇ`→`d`, `ㄴ`→`s`(spec §6.7).
- 메뉴 `?` 무동작, `Esc` → `Back`(메뉴→모니터, 하위 화면→메뉴, `EnvVars`를 나가면 `reveal = false`·`env = None`, `ScenarioVars`도 `scen = None`).
- 5분 복귀(`idle_expired`)는 새 화면에도(`is_sub` 확장). App이 복귀할 때 `idle_drop` 후 `Saving`이 없으면 `views.edit = None`, 있으면 `edit`는 남기고 `screen = Monitor`(저장 결과가 오면 Task 10이 처리).

- [ ] **Step 1: 실패 테스트 작성** — `app_test.rs`:
  - `input_mode_keys_are_literal`: overlay Input에서 `q`·`ㅂ`·`j`·`?` → `EditAction::Input(Edited)`(종료 확인 아님) / `Ctrl+C` → `Input(AskQuit)` / 같은 키들이 overlay 없는 메뉴에선 `AskQuit`·`MoveCursor(1)`·`None`.
  - `menu_digit_jump`(`digit_jump` 반환으로): `3` → (3, None) / `1` → (1, Some) → 0.5초 뒤 `2` → (12, None) / `1` → 1.5초 뒤 `2` → (2, None) / `1` 뒤 `7` → (7, None) / `0` 단독 → 무동작(`edit_key`가 `None` — 번호 0 없음).
  - `list_screen_keys_normalize`: EditList에서 `ㅇ`→Remove, `ㄴ`→Swap, `ㅁ`→Add, EnvVars `ㅍ`→ToggleReveal.
  - `cond_form_keys`: Tab → CondKey(Tab), Space → CondKey(Space).
  - `confirm_y_only`: 삭제 확인에서 `y`만 ConfirmYes, `Enter`는 ConfirmNo / 단계 확인(y_only=false)은 `Enter` ConfirmYes.
  - `notice_swallows_next_key`: Notice 중 `↓` → CloseNotice(커서 불변).
  - `idle_drops_overlay_keeps_pending_save`: Input → `idle_drop` 후 None / Saving → 그대로.
  - `idle_applies_to_edit_screens`: `idle_expired(&Screen::EnvVars, …)` 5분 → true.
- [ ] **Step 2: 실패 확인**.
- [ ] **Step 3: 구현** — 상태·키 판정만. `EditAction`을 실제로 수행하는 `App::apply_edit`는 Task 10.
- [ ] **Step 4: 통과 확인** — 공통 3명령.
- [ ] **Step 5: 커밋** — `feat(tui): 편집 화면 상태와 키 판정`.

---

### Task 8: 편집 메뉴·overlay·머리 줄 알림 그리기 (US4)

목업 §1·§2·§3·§7(머리 줄). 화면 배치는 목업 그대로(글자 배치 재량), spec §6 머리 ①②③ 우선.

**Files:**
- Modify: `crates/tui/src/panel_settings.rs`, `crates/tui/src/view/settings.rs`, `crates/tui/src/view/monitor.rs`, `crates/tui/src/app.rs`(`MonitorScreen`·`HeaderView` 리터럴에 `notice: None` — 연결은 Task 10), `crates/tui/src/text.rs`
- Test: `crates/tui/tests/settings_test.rs`, `crates/tui/tests/view_test.rs`, `crates/tui/tests/inspect_test.rs`(`HeaderView` 리터럴), `crates/tui/tests/judge_parity_test.rs`

**Interfaces — Produces:**
```rust
// panel_settings.rs
/// 14개(1b 12개 + 13 환경 변수 + 14 시나리오 변수). 13 값 = `{환경 이름} · {N}개  ({키} · …)` / 환경 없음 → `없음`,
/// 14 = `{시나리오 이름} · {N}개  ({키} · …)` / 변수 없음 → `없음`. 키 목록은 폭에 맞춰 통째 조각으로 줄임(`…` 금지 — 넘치면 `(… 외 N개)`).
pub fn settings_items_edit(p: &PanelConfig, names: &Names, width: usize) -> Vec<SettingItem>;
/// settings_lines와 같은 규칙의 줄 + 각 줄이 속한 항목 번호(0부터). 12와 13 사이에 구분 줄(항목 번호 None).
/// **선택 표시 `▶ ` 2칸을 이 함수가 줄 앞에 예약한다**(1b `settings_lines`는 `" 1  제목"`처럼 비워 두지 않는다) —
/// 안쪽 폭 = `width.saturating_sub(2)`로 `settings_lines`를 부른 뒤 모든 줄 앞에 공백 2칸(고른 항목 첫 줄은 그리기에서 `▶ `).
pub fn edit_menu_lines(items: &[SettingItem], width: usize) -> Vec<(String, Option<usize>)>;

// view/monitor.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderNotice { Saved(i64 /*ms*/), FileFailed, ChangedOutside }
pub struct HeaderView { /* 기존 */ pub notice: Option<HeaderNotice> }
pub struct MonitorScreen { /* 기존 */ pub notice: Option<HeaderNotice> } // header()가 그대로 옮긴다
// 기존 테스트의 구조체 리터럴(`inspect_test.rs`·`settings_test.rs`·`view_test.rs`)에 `notice: None`을 더한다.
// render_header_view: Saved = 초록 `저장됨 HH:MM:SS`를 시계·상태 앞에(목업 §2 오른쪽). FileFailed/ChangedOutside = 빨강, 왼쪽
// `Handicap 모니터 · ` 접두 자리에(목업 §7 — 접두를 빼고 그 자리), **보드 이름보다 먼저 지킨다**(좁으면 날짜 → 보드 이름 순으로 뺀 뒤에도
// 안 들어가면 경고를 `fit`, 점검 상태는 1a 규칙대로 절대 자르지 않는다).

// view/settings.rs
pub struct EditMenuView<'a> { pub title: &'a str, pub lines: &'a [(String, Option<usize>)], pub cursor: usize, pub scroll: usize, pub note: Option<&'a str>, pub overlay: Option<OverlayView<'a>> }
pub enum OverlayView<'a> { Input { label: &'a str, text: String, cursor_x: usize, hint: Option<String>, error: Option<&'a str>, share: Option<&'a str> }, Pick { title: &'a str, options: &'a [String], cursor: usize }, Confirm(&'a str), Saving, Notice(&'a str) }
/// 그린 줄 → 항목 번호 표를 돌려준다(마우스 클릭용, Task 11). 표 = (화면 y, 항목 번호).
pub fn render_edit_menu(f: &mut Frame, head: &HeaderView, v: &EditMenuView, keys: &[&str]) -> Vec<(u16, usize)>;
```
- 배치: body 1행 = `칸 설정 · {제목}` + 오른쪽 `고친 값은 바로 점검에 반영·파일에 저장`(`SETTINGS_EDIT_NOTE` — 1b `SETTINGS_READONLY`는 지운다). 고른 항목의 줄 전부 흰 바탕 + 첫 줄 맨 앞 `▶`(`edit_menu_lines`가 예약한 2칸, 폭 계산은 `saturating_sub`). 커서가 늘 보이게 `scroll`을 호출자가 맞춘다(`ensure_visible(lines, cursor, height)` 순수 함수도 이 task에서 — 테스트 포함).
- overlay 자리(목업 §2·§3): Input·Confirm·Saving·Notice = 키 줄 바로 위 1–3줄(오류 줄·공유 줄이 있으면 늘어남, body 높이가 모자라면 목록 줄을 줄이고 overlay를 지킨다). Pick = 고른 항목 줄 아래 테두리 창(공간이 없으면 위로, 그래도 없으면 body 전체).
- 키 줄 조각(`sub_keys` 확장): 메뉴 = `↑↓ 고르기`·`1–14 번호`·`Enter 수정`·`Esc 모니터로` / 입력줄 = `Enter 저장`·`Esc 취소`·`Ctrl+U 지우기` / 목록 창 = `↑↓ 고르기`·`Enter 저장`·`Esc 취소` / 확인 = 확인 문구가 이미 키를 말하므로 빈 키 줄.
- 문구: `SETTINGS_EDIT_NOTE`, `SET_ENV_VARS = "환경 변수"`, `SET_SCEN_VARS = "시나리오 변수"`, `EDIT_DIVIDER = "이 칸이 쓰는 값 · 같은 값을 쓰는 다른 칸도 함께 바뀝니다"`, 범위 힌트 `range_hint(lo, hi)` = `{lo}~{hi}`, `SAVING = "저장 중…"`, 키 조각들. GUI와 같은 뜻: 없음(1b `NONE` 재사용).

- [ ] **Step 1: 실패 테스트 작성**:
  - `settings_test.rs` `edit_items_fourteen`: 환경 E1(키 3개)·변수 2개 → 13 값 `운영 · 3개  (API_TOKEN · BASE_URL · SHOP_ID)`, 14 `주문 흐름 · 2개  (order_id · page_size)` / 환경 없음 → 13 `없음`.
  - `edit_menu_lines_map_items`: 여러 줄 조건 항목의 둘째 줄도 `Some(10)`, 구분 줄 `None`, 폭 20에서도 모든 줄 ≤ 20.
  - `render_edit_menu_selection_and_note`(목업 §1, 100×30): `▶`가 고른 항목 첫 줄에, 그 항목 모든 줄 배경 흰색(셀 스타일 단언), 오른쪽 안내 문구, 구분 줄, 각주, 반환 표의 y가 그 줄들.
  - `render_input_overlay`(목업 §2): `제한 시간(초)  15  1~30` + 오류 줄 `제한 시간은 1~30초여야 합니다` + 키 줄 / 공유 줄 노란색.
  - `render_pick_overlay`(목업 §3): 볼 스텝 창에 `흐름 전체` **없음**(spec ①), 고른 줄 `▶`.
  - `header_notice_saved_and_failed`(`view_test.rs`): 120폭 `저장됨 09:41:32`(TZ 무관하게 `Local`로 기대값 — CLAUDE.md 함정), 40폭에서 `FileFailed` 문구가 보드 이름보다 먼저 남음.
  - 스윕: `render_edit_menu` w 1..=60 × h 1..=16 × overlay 6종 × 커서 0/13 — 패닉 없음.
- [ ] **Step 2: 실패 확인**.
- [ ] **Step 3: 구현**.
- [ ] **Step 4: 통과 확인** — 공통 3명령 + `TZ=UTC`.
- [ ] **Step 5: 커밋** — `feat(tui): 편집 메뉴·입력줄·목록 창·머리 줄 알림 그리기`.

---

### Task 9: 하위 목록·조건 수정 칸·환경/시나리오 변수 화면 그리기 (US4·US7·US8)

목업 §4·§5. Review Focus 5.

**Files:**
- Create: `crates/tui/src/view/edit.rs`, `crates/tui/tests/edit_view_test.rs`
- Modify: `crates/tui/src/view/mod.rs`(`pub mod edit;`), `crates/tui/src/text.rs`, `crates/tui/tests/judge_parity_test.rs`

**Interfaces — Produces (`view/edit.rs`):**
```rust
pub struct ListView<'a> { pub title: &'a str /* 응답속도 기준선 · 칸 제목 */, pub rows: Vec<ListRow>, pub cursor: usize, pub overlay: Option<OverlayView<'a>> }
pub struct ListRow { pub text: String, pub color: Option<String> /* 기준선 #hex */, pub dim: bool }
pub fn render_list(f: &mut Frame, head: &HeaderView, v: &ListView, keys: &[&str]);
pub struct CondFormView<'a> { pub target: &'a str, pub ops: &'a [&'static str], pub op: usize, pub value: Option<(String, usize)>, pub flags: Option<(bool, bool)>, pub focus: CondFocus, pub error: Option<&'a str> }
pub fn render_cond_form(f: &mut Frame, area: Rect, v: &CondFormView);
pub struct VarsView<'a> { pub title: String /* 환경 변수 · 운영 */, pub usage: String, pub rows: Vec<VarRow>, pub cursor: usize, pub loading: bool, pub failed: Option<&'a str>, pub overlay: Option<OverlayView<'a>> }
pub struct VarRow { pub key: String, pub value: String /* 이미 가림 처리된 표시값 */, pub note: Option<&'static str> /* 생성 변수/모양 */ }
pub fn render_vars(f: &mut Frame, head: &HeaderView, v: &VarsView, keys: &[&str]);
/// 환경 값 표시: reveal이 아니면 항상 `••••••••`(길이 무관 — 값 길이도 새지 않게).
pub fn env_display(value: &str, reveal: bool) -> String;
```
- 기준선 줄 `{n}  ■ {ms} ms`(■에 그 색), 조건 줄 = `condition_summary`, 표시 줄 = `{①|②} {target} · {스텝}`. 빈 목록이면 안내 문구(spec §6.1 11·12 ReadOnly와 같은 글).
- 변수 화면 머리 오른쪽 = `usage_note`. 키 줄: 환경 `↑↓ 고르기`·`Enter 수정`·`v 값 보기`(reveal이면 `v 가리기`)·`Esc 뒤로`, 시나리오는 `v` 없음, 하위 목록 `a 추가`(기준선만)·`d 삭제`·`s 자리 바꾸기`(표시만, 2개일 때)·`Enter 수정`(표시엔 없음).
- 문구: 목업 §4·§5 그대로, `ENV_LOADING = 불러오는 중…`(1b `LOADING` 재사용 = ko.ts `loading`), 조건 수정 칸 라벨 `대상`·`규칙`·`값` + 체크 문구는 ko.ts `condIgnoreCase`·`condTrim` 값 그대로(1b `COND_IGNORE_CASE`·`COND_TRIM` 재사용 — 체크 칸 앞 `[x]`/`[ ]`).

- [ ] **Step 1: 실패 테스트 작성** — `tests/edit_view_test.rs`:
  - `env_values_masked_until_v`: 값 `SECRET-TOKEN` → reveal=false 버퍼에 `SECRET` 없음·`••••••••` 있음 / reveal=true → 보임 / `env_display("", false) == "••••••••"`.
  - `vars_rows_notes`(목업 §5 오른쪽): 생성 변수 줄 흐림 + `생성 변수 — GUI에서`.
  - `list_thresholds_colored`: ■ 셀 색 = `#f59e0b`.
  - `cond_form_layout`(목업 §4 오른쪽): `대상    status`, 규칙 `= 같음`, 값, `[x] 대소문자 무시   [ ] 앞뒤 공백 무시`(ko.ts `condIgnoreCase`·`condTrim` 값 — 목업의 "제거"는 이 plan이 고친다), 포커스 칸 반전 / `exists` 규칙이면 값 줄·체크 줄 없음.
  - `vars_loading_and_failed`: Loading → `불러오는 중…`, Failed(m) → 서버 문구.
  - 원격 문자열 제어 문자: 키·값에 `\u{202E}`·`\x1b` → `\u{FFFD}`가 **보인다**(긍정 단언 — CLAUDE.md 함정).
  - 스윕: 세 그리기 함수 w 1..=60 × h 1..=16 × overlay 유무.
- [ ] **Step 2: 실패 확인**.
- [ ] **Step 3: 구현**.
- [ ] **Step 4: 통과 확인** — 공통 3명령.
- [ ] **Step 5: 커밋** — `feat(tui): 기준선·조건·표시 목록과 변수 화면 그리기`.

---

### Task 10: 편집 작업자·저장 연결 — 항목 1–12 (US4)

spec §6.2 전부. Review Focus 3·4·8. Task 4–9를 App에 잇는다.

**Files:**
- Modify: `crates/tui/src/app.rs`
- Test: `crates/tui/tests/save_flow_test.rs`(새)

**Interfaces — Produces (`app.rs`):**
```rust
pub enum EditReq {
    LoadEnv { id: String },
    LoadScenario { id: String },
    SaveBoard { seq: u64, board_id: String, panel_id: String, panel_no: usize, name: String, config: BoardConfig },
    SaveEnv { seq: u64, id: String, name: String, vars: BTreeMap<String, String> },
    SaveScenario { seq: u64, id: String, yaml: String, version: i64 },
}
pub enum EditDone {
    Env { id: String, result: Result<EnvironmentResponse, String> },
    Scenario { id: String, result: Result<ScenarioResponse, String> },
    /// server: 서버 반영 결과(오류는 접두 뗀 문구). file: 서버 반영이 됐을 때만 Some — 파일 쓰기 결과.
    Saved { seq: u64, req: SavedWhat, server: Result<SavedValue, String>, file: Option<Result<(), FileErr>> },
}
/// 서버 반영 뒤 단계 실패: 내보내기 실패(`Export`, 서버 문구) 또는 파일 쓰기 실패.
pub enum FileErr { Export(String), Write(WriteError) }

pub enum SavedWhat { Board { board_id: String }, Env { id: String }, Scenario { id: String } }
pub enum SavedValue { Board(BoardResponse), Env(EnvironmentResponse), Scenario(ScenarioResponse) }

// EditReq·EditDone도 `Debug`는 손으로(값 가림).
/// 편집 작업자 — 요청을 하나씩. 저장은 서버 PUT → (성공 시) export(세션 보드 전부, 가져온 순서) → `filesave::write_bundle`
/// 까지 한 번에. `FileState`·시작 바이트를 소유. 로그엔 단계·상태·ErrorKind만.
pub fn spawn_edit_worker(handle: &Handle, api: Api, board_ids: Vec<String>, file: FileState, start_bytes: Vec<u8>, out: std::sync::mpsc::Sender<EditDone>) -> (UnboundedSender<EditReq>, JoinHandle<()>);
```
- **저장 표(ticket)**: App에 `save_in_flight: Option<SaveTicket>`(`SaveTicket { seq: u64, board_id, panel_id }`, `EditDone::Saved`에 `seq`를 싣는다). 표가 있는 동안: 새 저장 요청을 만들지 않는다(편집 확정 키 → `Notice(SAVING)`), `OpenSettings`는 열리되 같은 표시. 결과가 오면 캐시·알림은 **항상** 반영, overlay 복원·`Notice`는 지금 `views.edit`가 표의 보드·칸과 같을 때만. 보드 전환(`NextBoard`는 지금처럼 `views.clear()`)·5분 복귀 뒤에도 표는 App에 남는다 — 그래서 늦은 결과가 다른 칸 화면을 건드리지 않고, 저장 전 캐시로 만든 두 번째 저장이 첫 변경을 덮지 않는다.
- App 필드: `views.edit: Option<EditUi>`, `edit_out: (Sender<EditDone>, Receiver<EditDone>)`, `edit_req: Option<UnboundedSender<EditReq>>`, `file_notice: Option<HeaderNotice>`(+ `Saved`는 5초 뒤 지움 — `saved_at: Option<Instant>`). 세션 시작 때 `spawn_edit_worker`, `stop_session`에서 abort·await(1b `fetcher`와 같이 — `crates/tui/CLAUDE.md` mpsc 함정). `start_session`은 `file_notice = None`·`save_in_flight = None`·`edit_out` 비우기(옛 세션 결과가 새 세션 캐시에 들지 않게 — 보드 id는 가져오기 사이에 보존되므로). `apply_done`은 `seq`가 표와 다른 `Saved`를 버린다.
- `OpenSettings` → `views.edit = Some(EditUi{board_id, panel_id, ..})`, `Screen::Settings`. 편집 화면이면 이벤트 루프가 `edit_key` 먼저(Task 7), 그 결과를 `apply_edit`.
- `apply_edit` 핵심 갈래:
  - 숫자 키: `edit_key`가 `EditAction::Digit(d)` → `digit_jump` → `cursor = 번호 − 1`.
  - `Activate`(메뉴): `edit::edit_kind(no)` → Input(Field) = `Overlay::Input{LineInput::new(field_value, mode)}`(초기값이 `accept_char`를 통과 못 하거나 상한을 넘으면 입력줄을 열지 않고 `Notice(VALUE_UNEDITABLE)` — 고르지 않은 글자를 몰래 잘라 저장하지 않게, Task 11의 변수 값도 같은 규칙) / Pick = 옵션 만들기(Env: `환경 없음` + `names.env_order()`; Step: `edit::step_options`; Latency: `시나리오 전체`(`text::LATENCY_TOTAL` = ko.ts `latencyTotal` — 메뉴 7번 값 표기와 같게) + `step_options`) 커서 = 지금 값 / List = `Screen::EditList` / EnvVars = `Screen::EnvVars` + `env = Loading` + `LoadEnv` / ScenarioVars = 같은 꼴 / ReadOnly(m) = `Overlay::Notice(m)`.
  - `Input(Submit)`·`PickChoose`·CondForm `Enter`·`ConfirmYes`: 확인이 필요한가(`edit::step_change_counts`≠(0,0) → 단계 확인, `edit::dropped_env` Some → 환경 빠짐 확인, `Remove` → 삭제 확인(y_only)) → 필요 없으면 `edit.rs` 변환으로 새 `BoardConfig` → `EditReq::SaveBoard{seq}` + `overlay = Saving{restore}`(Input·CondForm이면 그 overlay, 그 밖 None) + `save_in_flight = Some(ticket)`.
  - `EditDone::Saved{server: Err(m)}` → `Saving{restore: Some(o)}`면 `o`를 되살려 `error = Some(m)`, `None`이면 `Notice(m)` / `Ok(Board(b))` → 캐시 보드 교체, overlay None, `file` 결과 → `Ok` = `Saved(now_ms)`·`saved_at`, `Err(Write{stage: ChangedOutside})` = `ChangedOutside`, 그 밖 `Err`(`Export`·다른 `Write`) = `FileFailed`(성공이 올 때까지 유지 — 다음 `Ok`가 덮는다).
  - 결과 처리는 **순수 함수**로 뗀다: `pub fn apply_done(edit: Option<&mut EditUi>, boards: &mut [BoardResponse], ticket: &mut Option<SaveTicket>, done: EditDone, now_ms: i64) -> Option<HeaderNotice>` — 캐시 교체·표 지우기·overlay 복원/Notice·알림 계산. 확인 필요 판정도 순수 함수 `pub fn confirm_for(boards: &[BoardConfig], board_idx, panel_idx, change: &Change) -> Option<(String, bool /*y_only*/)>`(`Change` = 이 task가 정의하는 편집 한 건: Field·Env·Step·Latency·Threshold*·Remove·Swap·Condition).
  - `EditDone::Env{id}`/`Scenario{id}`는 지금 `EditUi.env`/`scen`의 id(`Loading{id}`)와 같을 때만 받는다(1b `SubViews::accept`와 같은 원리). 화면을 이미 나갔으면 버린다 — 값이 다시 메모리에 들지 않게.
  - `q`/`Ctrl+C`는 저장 중에도 종료 확인창(종료하면 작업자를 abort — §10의 "저장 도중 재시도" 한계와 같은 쪽).
  - Task 10 시점엔 13·14가 `Loading`에 머문다(조회 결과 처리는 Task 11) — 의도된 중간 상태.
- 머리 줄: `draw_sub`·모니터 `header()` 모두 `notice = self.file_notice.clone()`(모든 화면 — spec §6.2-5).

- [ ] **Step 1: 실패 테스트 작성** — `tests/save_flow_test.rs`(in-process 세션 + tempdir 보드 파일 + 상태 디렉터리 tempdir; 작업자를 직접 띄워 `EditReq`를 보낸다 — App 루프 없이):
  - `save_board_writes_file_and_backups`: 첫 칸 timeout 5→9 `SaveBoard` → `EditDone::Saved{server: Ok, file: Some(Ok)}` / 보드 파일을 다시 가져온 새 세션에서 그 칸 9 / `.bak`·`.orig.bak` = 원래 바이트.
  - `save_rejected_keeps_file_and_cache`: timeout 45 → `server: Err("제한 시간은 1~30초여야 합니다")`(접두 뗌), `file: None`, 파일 바이트 불변.
  - `file_changed_outside_reports`: 저장 전 파일을 다른 바이트로 덮음 → `server: Ok`, `file: Some(Err(FileErr::Write(WriteError{stage: ChangedOutside, ..})))`, 파일 = 덮은 바이트.
  - `worker_processes_in_order`: LoadEnv·SaveBoard·LoadScenario 순서대로 결과.
  - `stop_aborts_worker`: JoinHandle abort 후 await 완료(1b `stop_session` 패턴).
  - `app_test.rs`(순수, 세션 없이): `apply_done_rejection_keeps_cache_and_restores`(거절 → `boards` 불변, overlay = 되살린 Input + `error`) / `apply_done_pick_rejection_is_notice` / `apply_done_ok_replaces_board_and_notice`(`Saved`, 실패 파일 → `FileFailed`, `ChangedOutside`) / `apply_done_stale_panel_no_overlay`(표의 칸 ≠ 지금 화면 칸 → 캐시는 바뀌고 `edit` overlay 불변) / `apply_done_after_idle_keeps_notice`(`edit = None`이어도 캐시·알림 반영) / `ticket_blocks_second_save` / `confirm_for_table`(단계 확인·환경 빠짐·삭제 y_only·확인 없음).
- [ ] **Step 2: 실패 확인**.
- [ ] **Step 3: 구현** — Interfaces·갈래 그대로. App 조립(이벤트 루프·그리기)은 단위 테스트가 닿지 않는다 — **라이브 표가 유일한 그물**.
- [ ] **Step 4: 통과 확인** — 공통 3명령 + `TZ=UTC`.
- [ ] **Step 5: 커밋** — `feat(tui): 칸 설정 수정을 서버와 보드 파일에 저장`.

---

### Task 11: 환경/시나리오 변수 연결·마우스·붙여넣기·도움말·꺼진 보드 문구 (US7·US8·US4)

spec §6.3·§6.4(App 쪽)·§6.1 마우스·§6.7 붙여넣기·§6.6.

**Files:**
- Modify: `crates/tui/src/app.rs`, `crates/tui/src/terminal.rs`, `crates/tui/src/view/overlay.rs`, `crates/tui/src/inspect.rs`, `crates/tui/src/text.rs`
- Test: `crates/tui/tests/save_flow_test.rs`, `crates/tui/tests/app_test.rs`, `crates/tui/tests/inspect_test.rs`, `crates/tui/tests/view_test.rs`, `crates/tui/tests/judge_parity_test.rs`

**동작:**
- `EditDone::Env{id, result: Ok(e)}`(지금 `env == Loading{id}`일 때만) → `env = Loaded(e)`(키 순 줄), `Err(m)` → `Failed(m)`. EnvVars `Activate` → 값이 `accept_char`·2000자 규칙을 못 지키면 `Notice(VALUE_UNEDITABLE)`. 아니면 공유 줄 `edit::usage(.., environment_id == id)`가 칸 ≥ 2면 `text::share_note` → `Overlay::Input{target: EnvVar(key), LineInput::new(값, Text{2000})}` → Submit → `vars` 복제해 그 키만 바꿔 `SaveEnv` → 성공이면 `env = Loaded(응답)`.
- `EditDone::Scenario{id, result: Ok(s)}`(지금 `scen == Loading{id}`일 때만) → `scen = Loaded{id, yaml, version, vars: yaml_var::static_vars(&yaml)}`. 머리 오른쪽 = `scenario_usage_note`(`이 시나리오를 쓰는 칸 N개(보드 M개)`). ScenarioVars `Activate`: 그 줄 `editable`이 Err면 `Notice(사유 문구)`, 값이 입력 규칙을 못 지키면 `Notice(VALUE_UNEDITABLE)`, Ok면 공유 줄(`edit::usage(.., scenario_id == id)` 칸 ≥ 2 → `share_note`) + Input → Submit → `yaml_var::splice_static_var` → Err면 overlay 오류 줄에 사유 문구(저장 안 함), Ok면 `SaveScenario{yaml: 교체본, version}` → 성공이면 응답의 `yaml`·`version`으로 `scen` 갱신, 409면 `다른 곳에서 시나리오가 바뀌었습니다 — 다시 열어 주세요`.
- 화면을 나가면(`Back`) `env`/`scen`/`reveal`을 비운다(값을 메모리에서 놓는다).
- 409 문구 변환은 **작업자**가 한다(`ApiError.status == Some(409)` → `다른 곳에서 시나리오가 바뀌었습니다 — 다시 열어 주세요`) — `EditDone`엔 상태 코드가 없다.
- 붙여넣기: `terminal.rs` `enter()`에 `EnableBracketedPaste`, `restore()`·실패 경로에 `DisableBracketedPaste`. 이벤트 루프 `Event::Paste(s)` → 입력줄 overlay(Input·CondForm 값 칸)면 `paste(&s)`, 아니면 버림. `is_user_input`에 Paste 포함.
- 마우스(spec §6.1): `Screen::Settings`이고 overlay 없음일 때만 — 왼쪽 클릭 y를 `render_edit_menu`가 돌려준 표(App이 `Cell`에 보관)에서 찾아 항목이 지금 커서면 `Activate`, 아니면 커서 이동.
- 도움말(`overlay.rs`): 시그니처 `render_help(f, file: &Path, backups: Option<&FileTarget>, log: &LogLoc)`(App은 세션이 있으면 `Some(&session.target)`). `Enter` 행 설명 → `선택 칸 설정 보기·수정`, 노란 줄 `새 파일로 바꾸면 이 PC에서 고친 값은 사라집니다`, 파일 줄 아래 `백업: <real>.bak · 원본: <real>.orig.bak`(sanitize, 폭 넘치면 `fit`). 높이가 모자라면 **새 두 줄부터** 뺀다(백업 줄 → 경고 줄 순) — 기존 작은 높이 테스트(`view_test.rs`의 도움말 높이 케이스)가 지금 결과를 유지하는지 확인하고, 바뀌면 그 이유를 테스트 주석에.
- 꺼진 보드 빈 문구(roadmap §B48 (2)): `errors_view`(또는 그 호출)가 `/status` `enabled == false`면 빈 목록 문구 `점검이 꺼져 있어 결과가 없습니다`(`ERRORS_EMPTY_OFF`). 스냅샷의 `enabled`를 `ErrorsInput`에 싣는다.

- [ ] **Step 1: 실패 테스트 작성**:
  - `save_flow_test.rs` `env_value_change_reaches_next_check`: wiremock 대상에 `${TOKEN}` 헤더를 쓰는 시나리오 + 환경 TOKEN=old → `SaveEnv` TOKEN=new → 다음 점검 요청 헤더가 new(wiremock `received_requests`로 확인, 최대 10초 대기) + 파일을 다시 가져오면 환경 값 new.
  - `scenario_var_change_one_line_in_file`: 블록 표기 `variables:` 아래 주석 줄 `  # 주문 번호` + `  order_id: "A-1"` → `splice` → `SaveScenario` → 파일의 그 시나리오 `yaml`과 원래 `yaml`의 `changed_lines == [그 줄]`, 주석 줄 그대로 + 다음 점검 URL에 새 값.
  - `scenario_stale_version_409`: `version - 1`로 → `Err` 문구.
  - `app_test.rs` `late_load_for_other_id_dropped`: `env == Loading{id: E2}`에 `EditDone::Env{id: E1}` → 버림 / 화면을 나가 `env == None`이면 버림. `scenario_share_note_when_shared`: 시나리오를 쓰는 칸 2개 → Input overlay의 `share`가 Some.
  - 성공 저장 결과가 변수 화면을 나간 뒤 오면 알림만 반영하고 `env`/`scen`을 다시 채우지 않는다(`apply_done` 테스트 1개 추가).
  - `app_test.rs`: `paste_only_into_input`(순수 판정 함수 `paste_target(&EditUi) -> bool`), `mouse_click_maps_to_item`(표 `[(5,0),(6,1),(7,1)]`에서 y 7 → 항목 1).
  - `inspect_test.rs` `errors_empty_when_board_off`: enabled=false·결과 0 → `점검이 꺼져 있어 결과가 없습니다`, enabled=true·결과 0 → 기존 문구.
  - `view_test.rs` `help_lists_backup_and_warning`.
- [ ] **Step 2: 실패 확인**.
- [ ] **Step 3: 구현**.
- [ ] **Step 4: 통과 확인** — 공통 3명령 + `TZ=UTC`.
- [ ] **Step 5: 커밋** — `feat(tui): 환경·시나리오 변수 값 수정과 붙여넣기·도움말`.

---

### Task 12: 문서 — 매뉴얼·spec 상태

**Files:**
- Modify: `docs/dev/tui-monitor.md`, `docs/superpowers/specs/2026-11-07-tui-monitor-design.md`

- [ ] **Step 1: 매뉴얼 키 표**: `Enter`(칸 설정 보기·수정 — 번호·`↑↓`로 고르고 `Enter`), 편집 화면 키(spec §6.7 표를 운영자 말로), 입력줄에서는 `q`도 글자, 붙여넣기 가능(끝 줄바꿈은 저장되지 않음).
- [ ] **Step 2: 새 절 "칸 설정 고치기"**: ① 고치면 바로 점검에 반영·보드 파일에 저장 ② 백업 두 개(`.bak` = 바로 전, `.orig.bak` = GUI에서 받은 원본 — TUI가 쓴 파일을 다시 띄우면 그대로) ③ **새 파일로 바꾸면 이 PC에서 고친 값은 사라진다** — 바꾸기 전 TUI를 끄고 바꿀 것, 켠 채 바꾸면 TUI는 그 파일에 쓰지 않고 머리 줄에 경고 ④ 환경 변수 값은 가려져 있고 `v`로 보기, 같은 환경을 쓰는 칸이 여럿이면 함께 바뀜 ⑤ 시나리오 변수는 고정 값 한 줄만(생성 변수·여러 줄 값은 GUI) — **자주 바꿀 값은 시나리오에 `${ENV}`로 빼 두면 환경 변수로 고칠 수 있다** ⑥ 고칠 수 없는 항목(시나리오·묶음의 값)과 이유 ⑦ 파일 소유자는 TUI를 실행한 사용자로 바뀐다.
- [ ] **Step 3: spec** — 5행 상태 줄 "2a 설계 확정" 뒤에 "**2a-1 구현**(plan `docs/superpowers/plans/2026-11-11-tui-2a-1-edit-save.md`)"(코드 범위·날짜는 `/finish-slice`).
- [ ] **Step 4: 커밋** — docs-only. `docs(tui): 2a-1 칸 설정 수정 매뉴얼·spec 상태`.

roadmap·build-log·root 상태 줄·`crates/tui/CLAUDE.md` 새 함정은 `/finish-slice`(이 plan의 task 아님). 그때 roadmap §B48 (2) "꺼진 보드" 항목을 완료로 옮기고, 사용자 실기 목록에 새 모호 폭 문자 `▶`·`■`·`•`·`①②`·`[x]`(gnome-terminal ko_KR·Windows Terminal)를 더한다.

---

## 라이브 검증 (파이프라인 5단계 — 이 plan의 task 아님, 머지 전 필수)

spec §8 "2a 라이브" + `crates/tui/CLAUDE.md` tmux 함정. 워크트리(이 세션은 지정 브랜치) 자체 바이너리 `./target/debug/handicap-tui <번들>`, `XDG_CONFIG_HOME`·`XDG_STATE_HOME` scratchpad 격리. tmux는 python 드라이버. **로깅 응답기**(python `http.server`, `request_queue_size` 키움 — 받은 요청 줄·헤더를 파일에 남김)로 와이어 확인.

번들: 보드 2개 — 보드 1 = 단독 칸(환경 E1 `BASE_URL`·`TOKEN`, 헤더 `Authorization: Bearer ${TOKEN}`, URL에 `{{order_id}}`, 시나리오 `variables:`에 주석 줄 + `order_id: "A-1"` + 생성 변수 1개) + 묶음 칸 2개(같은 시나리오, E1) / 보드 2 = E1을 쓰는 칸 1개.

| US | 절차 | 통과 신호 |
|---|---|---|
| US4 | 단독 칸 `Enter` → `6` → `Enter`(입력줄은 지금 값이 채워진 채 열린다) → `Ctrl+U` → `9` → `Enter` → `q` `y`로 종료 → 다시 실행 → `Enter` | 머리 줄 `저장됨 HH:MM:SS`, 제한 시간 9가 재시작 뒤에도 9, 파일 옆 `.bak`·`.orig.bak` 생김(`.orig.bak` = 처음 파일과 `cmp` 동일). 다시 저장해도 `.orig.bak` 불변 |
| US4-거절 | `6` → `Enter` → `Ctrl+U` → `45` → `Enter` | 입력줄 아래 `제한 시간은 1~30초여야 합니다`(접두 없음), 파일 `sha256sum` 불변 |
| US4-읽기 전용 | 묶음 칸에서 `2`·`3`·`5`, 단독 칸에서 `4` | 각 안내 문구, 다음 키에 닫힘 |
| US4-볼 스텝 | 묶음 칸 `4` | `흐름 전체` 없는 목록, IF 안 스텝에 `(… 분기)`, 조건이 있으면 확인 줄 |
| US7 | 단독 칸 `1``3`(13) → 값 가림 확인 → `v` → `TOKEN` 줄에서 `Enter` → `Ctrl+U` → 새 토큰 → `Enter` | 머리 오른쪽 `이 환경을 쓰는 칸 4개(보드 2개)`, 입력줄 위 노란 `이 값을 쓰는 칸 4개(보드 2개)가 함께 바뀝니다`, 저장 뒤 로깅 응답기에 오는 `Authorization`이 새 값(다음 점검부터), 재시작 후 유지. 종료 후 `grep -c "<새 토큰>" tui.log` = 0 |
| US7-붙여넣기 | 입력줄에서 `tmux load-buffer` + `paste-buffer -p`(끝 줄바꿈 포함 토큰) | 줄바꿈이 빠진 값이 입력줄에 있고 **저장되지 않은 상태**(Enter를 눌러야 저장) |
| US8 | `1``4`(14) → `order_id` 줄에서 `Enter` → `Ctrl+U` → `B-2` → `Enter` | 다음 점검 URL이 `…/B-2`, 파일 속 그 시나리오 YAML을 원래와 diff → 정확히 한 줄(주석 줄 그대로), 생성 변수 줄은 `생성 변수 — GUI에서`로 `Enter` 시 안내만 |
| 밖에서 교체 | TUI 켠 채 보드 파일을 다른 번들로 `cp` → 값 하나 수정 | 머리 줄 `보드 파일이 밖에서 바뀌었습니다 — 저장 안 됨, TUI를 다시 시작하세요`, 파일 = 새로 복사한 바이트 그대로 |
| 파일 쓰기 실패 | 디렉터리 `chmod 500` 후 수정 | `파일에 저장 못 함 — 재시작하면 사라짐`이 모니터 화면에서도 유지, 권한 복구 후 다음 저장 성공에 사라짐 |
| 5분 복귀 | 입력줄을 연 채 5분 5초 | 모니터 화면, 입력하던 값 저장 안 됨 |
| 꺼진 보드 | in-process REST로 보드 `stop` 후 `e` | `점검이 꺼져 있어 결과가 없습니다` |

**극단값(전부 캡처)**: 입력줄에 `q`·`ㅂ`·`?`·`j` 타이핑 → 글자로 · `Ctrl+C` → 종료 확인창, 다른 키 → 입력값 그대로 · 메뉴 `1` → 1초 대기 → 1번 항목 / `1``2` 빠르게 → 12 · 80×24 → 40×10 → 20×5 → 120×40 `resize-window`(메뉴·입력줄·목록 창·변수 화면 각각, 패닉·겹침 없음) · 한글 제목 2000자 붙여넣기 → 가로 밀림, 서버 거절이면 그 문구 · 환경 값에 `‮` 붙여넣기 → 거부(버퍼에 없음) · 메뉴 줄 클릭(여러 줄 조건 항목의 둘째 줄 클릭 → 그 항목) · 보드 2개 `Tab` 뒤 편집이 새 보드 칸을 고침 · 저장 직후 `Esc` 연타 → 저장은 끝까지(파일 바뀜).

**보안 게이트**: env 바인딩·템플릿 값·파일 되쓰기를 건드리므로 `finish-slice` §0 grep 매치 예상 — `security-reviewer` APPROVE 필수(grep 결과가 지배).

---

## 목업과 다른 점 (의도적)

- 목업 §3 볼 스텝 목록의 `흐름 전체` 없음(spec ①). 목업 §1 각주 "13·14가 없으면 줄은 없음" → 줄을 두고 `없음`(spec ②). 목업 §2 거절 문구에 접두 없음 = spec ③ 규칙 그대로.
- 목업 §4 조건 수정 칸의 `규칙  = 같음 ▾`는 `←→`로 고르는 칸(드롭다운 아님 — spec §6.7 조건 수정 칸 행).
- 목업 §6(미리 실행)·메뉴 키 줄의 `p 미리 실행`은 2a-2.

## 연기 항목 처리

| 항목 | 처리 |
|---|---|
| roadmap §B48 (2) 꺼진 보드 빈 목록 문구 | **이 plan Task 11에서 접음** |
| §B48 (2) 조회 큐 순서·`Reason::Failed` 재요청·`PgUp` 10줄·숫자 꺾임·`a` 창 위치·좁은 폭 조각 폭증 | 안 접음(이 plan이 그 파일의 해당 코드를 만지지 않음) — 편집 작업자를 따로 둔 것은 같은 교훈의 적용일 뿐 |
| §B48 (Windows) `HOME` 부재·X 닫기·임시 디렉터리 정리 | 안 접음 — 단 `tui-writes.json`이 `state_dir()`(HOME 기반)을 써서 Windows에선 기록 없음 → `.orig.bak`은 매 세션 첫 저장 때 덮임(§10 한계와 같은 쪽). finish-slice 때 §B48 Windows 항목에 한 줄 |

## 사실 근거 (claims-ledger)

| # | 주장 | 명령 |
|---|---|---|
| C1 | 보드 PUT `{name, config}`·응답 보드·reconcile | `grep -n "pub struct BoardBody" -A5 crates/controller/src/api/monitor_boards.rs; grep -n "pub async fn update" -A12 crates/controller/src/api/monitor_boards.rs` |
| C2 | export `{board_ids}`·쓰는 환경만·자기 검증 | `grep -n "pub struct ExportRequest" -A3 crates/controller/src/api/monitor_transfer.rs; grep -n "쓰는 시나리오·환경 ID" -A14 crates/controller/src/api/monitor_transfer.rs` |
| C3 | 환경 PUT·응답 필드 5개 | `grep -n "pub struct EnvironmentBody\|pub struct EnvironmentResponse" -A6 crates/controller/src/api/environments.rs` |
| C4 | 시나리오 PUT `{yaml, version}`·409·응답 필드 6개 | `grep -n "pub struct UpdateRequest\|pub struct ScenarioResponse" -A7 crates/controller/src/api/scenarios.rs; grep -n "VersionMismatch" crates/controller/src/api/scenarios.rs` |
| C5 | `칸 {n}: ` 접두 | `grep -n 'format!("칸 {}: {e}"' crates/controller/src/monitor/config.rs` |
| C6 | 서버 범위(주기·제한·막대·그래프) | `grep -n "in_range(p\." crates/controller/src/monitor/config.rs` |
| C7 | 조건 규칙 허용 표·`needs_value` | `grep -n "pub fn allows\|pub fn needs_value" -A10 crates/controller/src/monitor/config.rs` |
| C8 | GUI `setPanelStep`·`stepOptionsFor`·`hasFlags`·팔레트·`addThreshold` | `grep -n "export function setPanelStep\|export function stepOptionsFor" -A12 ui/src/monitor/groups.ts; grep -n "hasFlags =" -A1 ui/src/monitor/conditions.ts; grep -n "THRESHOLD_COLORS\|last.ms + 1000" ui/src/components/monitor/PanelEditor.tsx` |
| C9 | 고정 변수 = YAML 문자열만 | `grep -n "impl<'de> Deserialize<'de> for VarDecl" -A12 crates/engine/src/genvars.rs` |
| C10 | `Names`: `HashMap` 환경·`EnvLite{id,name}` | `grep -n "environments: HashMap\|struct EnvLite" -A3 crates/tui/src/names.rs` |
| C11 | `normalize_char`·`quit_key`·`ctrl_letter` | `grep -n "fn normalize_char\|let quit_key\|let ctrl_letter" crates/tui/src/app.rs` |
| C12 | `logging::state_dir()` | `grep -n "pub fn state_dir" -A3 crates/tui/src/logging.rs` |
| C13 | `tempfile` 일반 의존·`serde_yaml`/`sha2` 없음 | `grep -n "tempfile\|serde_yaml\|sha2" crates/tui/Cargo.toml` |
| C14 | `sha2` 0.10 판이 Lock에 | `grep -n -A1 '^name = "sha2"' Cargo.lock` |
| C15 | 점검이 매번 DB에서 시나리오·환경을 읽음 | `grep -n "store::scenarios::get\|store::environments::get\|fn load_scenario_env" crates/controller/src/monitor/check.rs; grep -n "load_scenario_env" crates/controller/src/monitor/unit.rs` |
| C16 | 마우스 캡처·restore 위치 | `grep -n "EnableMouseCapture\|DisableMouseCapture" crates/tui/src/terminal.rs` |
| C17 | 1b 칸 설정 12항목·`SETTINGS_READONLY` | `grep -n "pub const SETTINGS_READONLY\|pub fn settings_items" crates/tui/src/text.rs crates/tui/src/panel_settings.rs` |
| C18 | `/status` `enabled` | `grep -n "pub enabled" crates/tui/src/wire.rs` |
