# 터미널 운영 모니터 1b — 오류 보기·칸 설정 보기 (tui-monitor-1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `handicap-tui`에서 지나간 실패를 확인한다(US3) — 칸을 고르고 `e` → 실패 목록(시각·상태·사유) → `Enter` 자세히(사유·판정 상세·스텝 표) → `Enter` 요청·응답 본문(JSON은 들여써서, `←`/`→`로 옆 스텝). `Enter`(모니터 화면)는 칸 설정을 번호 목록으로 보여 준다(읽기 전용). 시나리오·스텝·환경 이름은 번들 파일에서 푼다.

**Architecture:** 컨트롤러의 기존 기록 엔드포인트 `GET /api/monitor-boards/{id}/panels/{panel_id}/records/{at_ms}`를 루프백으로 부른다(거울 타입 `wire::CheckRecord`). 화면 상태·줄 모델은 순수 함수 모듈 `inspect.rs`(오류 보기 3단계)·`panel_settings.rs`(설정 항목)에 두고, 그리기는 `view/inspect.rs`·`view/settings.rs`가 뷰 모델만 받아 그린다(1a `MonitorScreen` 방식). 새 화면 넷은 화면 전체를 쓰고 맨 윗줄은 모니터와 같은 머리 줄, 입력 없이 5분이면 모니터로 돌아간다. 이름 해석은 새 `names.rs`가 번들 파일 바이트에서 `scenarios[].yaml`(엔진 `Scenario::from_yaml`)과 `environments[].{id,name}`만 읽는다. 기록 조회는 UI 루프를 막지 않게 tokio 태스크 + `std::sync::mpsc`로 받는다. 컨트롤러·엔진·GUI는 0-diff(Cargo 의존 한 줄 추가뿐).

**Tech Stack:** Rust(edition 2024, tui crate `rust-version = "1.88"`), ratatui 0.30(crossterm 재수출), reqwest, serde/serde_json, tokio, wiremock(테스트). 새 의존: `handicap-engine`(path — `ScenarioTrace`·`Scenario`·`Step`).

**Spec:** `docs/superpowers/specs/2026-11-07-tui-monitor-design.md` §0(1b 행)·US3·§5.2(`e`·`Enter`)·§5.3·§5.4(+ 두 절 끝의 **"1b 확정 (사용자 2026-11-10)"** 블록)·§8·§9·§11. 화면 목업 `docs/superpowers/specs/2026-11-10-tui-1b-mockups/01-screens.html`(사용자 승인 — 글자 배치의 기준). 모니터 화면 배치는 `2026-11-08-tui-readability-design.md`가 우선(이 plan은 그 화면에 키 조각 두 개만 더한다).

## 선행 결정 (리뷰어·사용자 확인용)

| 질문 | 결정 | 근거 |
|---|---|---|
| 컨트롤러 변경이 필요한가 | **아니오 — 0-diff.** 기록 엔드포인트·404 규칙이 이미 있다 | 사실 근거 C1·C2 |
| 기록 응답 모양 | `{at_ms, limit_kb, result, trace(null 가능), clipped:[{step, side:"request"\|"response"}]}` — `CheckRecord`는 손으로 쓴 `Serialize`만 있어 재사용 불가 → `wire.rs` 거울 | C3 |
| 평탄화 함수: 엔진 대응 함수가 있는가 | 공개된 것이 **없다**(엔진 `reqgen::collect_http` 비공개, 컨트롤러 `check::collect_http_steps` `pub(crate)`). 순서는 GUI와 같다(http → loop.do → if then·elif·else → parallel 분기). **TUI `names.rs`에 이식**(15줄, 엔진·컨트롤러 가시성 변경 없이) | C4·C5 |
| 번들 파일 파싱 | 컨트롤러 `board_file::parse_bundle_bytes`(전체 검증)를 다시 돌리지 않고 **필요한 키만 읽는 느슨한 serde 구조체**(`scenarios[].{id,yaml}`, `environments[].{id,name}`). 서버 가져오기가 이미 형식을 검증했고, 실패해도 이름이 id로 보일 뿐(fail-soft). 환경 `vars`는 **역직렬화하지 않는다**(값을 메모리에 들지 않음) | C6 |
| 목록의 404 문구 | 목록 줄은 `기록 지남`(사용자 확정 7, TUI 전용), 상세 화면은 `ko.monitor.recordMissing` 그대로 | C7 |
| `a` 전체 회차 | "현재 막대 구간(`/status`의 `results`)의 모든 회차". 기록도 칸의 `bar_count`개만 보관되므로 그 밖은 볼 것이 없다 | C8 |
| 사유 지연 조회의 메모리 | 목록용 조회는 응답에서 `reason`·`detail`만 남기고 trace를 즉시 버린다. 상세는 한 번에 기록 1개만 든다 | spec §9 "저사양 PC" |
| 본문 표시 | JSON으로 읽히면 **들여쓴 모양**, 아니면 원문(사용자 확정 5). 64KB 초과·파싱 실패(너무 깊은 중첩 포함)·잘린 본문은 원문. 들여쓰기는 `serde_json::Value`로 다시 찍지 않고 **글자 흐름을 그대로 다시 줄바꿈**한다 — 워크스페이스 serde_json에 `preserve_order`가 없어 `Value`를 거치면 키 순서가 바뀐다(C18). 검증만 `serde::de::IgnoredAny`로(재귀 상한 초과 = 파싱 실패 → 원문). 제어 문자는 치환 | Review Focus 1·8 |
| 화면 전환 방식 | 새 화면 넷은 **화면 전체 전환**, 맨 윗줄은 모니터와 같은 머리 줄(사용자 확정 1) — `monitor.rs`의 머리 줄 그리기를 `HeaderView`로 뽑아 같이 쓴다 | 목업 |
| 자리 비움 | 새 화면 넷(과 그 위의 종료 확인창)에서 키·마우스 입력 없이 **5분**이면 모니터 화면으로(사용자 확정 2). 도움말·모니터 위 종료 확인창은 1a 그대로(적용 안 함 — 도움말은 모니터 위 팝업이라 뒤 칸이 보이고, 범위를 넓히지 않는다) | Task 7 |
| 목록·상세의 상태 문구 | GUI 기록 창의 `확인 못 함`/`분기 제외`가 아니라 **벽과 같은 기호 붙은 문구**(`― 확인 못 함`·`○ 분기 제외`·`▲ 느림` — 목업). 이미 있는 `text::state_label`을 쓴다 | 목업, C19 |
| 목업과 다르게 둔 것 | 아래 "목업과 다른 점" 절 | — |

## Global Constraints

- 변경 범위는 `crates/tui/**`와 문서뿐 — `crates/controller`·`crates/engine`·`ui/`·proto·마이그레이션 0-diff. Task 1의 `crates/tui/Cargo.toml` 의존 한 줄(+`Cargo.lock`)이 유일한 매니페스트 변경.
- tui crate `rust-version = "1.88"`: 1.88에 없는 std API 금지. clippy `-D warnings`(2-arm `match … _ => {}` 대신 `if let`).
- 사용자 노출 한국어 문구는 `crates/tui/src/text.rs` 한 곳에. GUI와 같은 뜻의 문구는 `ui/src/i18n/ko.ts` 값과 **글자까지 같게** — 각 task의 문구 표에 키를 적었고 `mirrored_text_exists_in_ko_ts`(Task 3에서 생성, 이후 task가 행 추가)가 ko.ts 파일을 읽어 대조한다.
- **화면 배치의 기준은 목업** `docs/superpowers/specs/2026-11-10-tui-1b-mockups/01-screens.html`(사용자 승인 2026-11-10): §0 모니터 키 줄 · §1 오류 목록 · §2 자세히 · §3 요청·응답 · §4 칸 설정 보기. 화면을 그리는 task는 구현 전에 그 절을 읽는다(각 Task 머리에 절 번호). 글자 배치는 재량이지만 줄 구성·문구는 목업을 따르고, 이 plan의 표·"목업과 다른 점" 절이 목업과 다르면 plan이 우선.
- 좁은 화면 문구는 통째 단위로 줄인다(`crates/tui/CLAUDE.md` 첫 함정). 폭·높이 계산은 전부 `saturating_sub`, 새 화면 네 개는 폭 1칸·높이 1줄 단위 스윕 테스트(Task 3–6 각각).
- 로그(`tracing`)에 URL·헤더·본문·사유 문자열을 남기지 않는다(`api.rs` 기존 규칙 — 종류만).
- crossterm은 `ratatui::crossterm` 재수출만. 와이어 거울은 `deny_unknown_fields`.
- 로컬 시각을 단언하는 테스트는 기대값도 `chrono::Local`/`judge::format_*`로 구한다(CI는 UTC).
- 매 task: 실패 테스트 먼저(`tdd-guard`가 src 편집을 막는다) → 구현 → `cargo test -p handicap-tui` · `cargo clippy -p handicap-tui --all-targets -- -D warnings` · `cargo fmt -p handicap-tui --check` → 커밋. 커밋 메시지는 `-F <파일>`, 끝 줄 `Co-Authored-By: <구현 모델 이름> <noreply@anthropic.com>`. 구현 subagent는 커밋·검증을 **단일 foreground 호출(600000ms)**로, 파이프(`| tail`) 금지, 판정은 `; echo exit=$?`.

## Review Focus

1. **터미널로 가는 원격 문자열**: 응답 본문·헤더·URL·`StepTrace.error`·사유에 ESC·탭·CR 같은 제어 문자가 있어도 화면이 깨지거나 폭 계산이 어긋나지 않는다. → Task 5 `sanitize_replaces_control_chars`·`body_lines_escape_sequence_is_inert`.
2. **늦게 도착한 조회 결과**: 다른 칸·다른 회차로 옮긴 뒤(또는 `r` 재시도 뒤) 도착한 응답을 현재 화면에 넣지 않는다. → Task 7 `fetched_for_other_panel_is_dropped`.
3. **목록이 살아 움직인다**(사용자 확정 3): 1초마다 새 결과가 앞에 끼고 오래된 것이 밀려나도 커서는 같은 회차(`at_ms`)에 머문다. 밀려났으면 가장 가까운 더 오래된 줄. → Task 3 `cursor_stays_on_same_round_when_new_results_arrive`·`cursor_falls_to_next_older_when_evicted`.
4. **작은 터미널**: 새 화면 네 개가 1×1부터 패닉 없이 그려진다. 무입력 안내 줄·개수·`보기 전용` 같은 덧붙은 글자는 잘리지 않고 통째로 빠진다. → Task 3–6 `*_size_sweep_no_panic`, Task 3 `render_errors_narrow_drops_whole_parts`.
5. **요청 본문은 기본 가림**: `v` 전에는 본문 글자가 버퍼 어디에도 없다. 본문 화면을 나가거나 `←`/`→`로 옆 스텝에 가거나 5분 자동 복귀하면 다시 가려진다. → Task 5 `request_body_hidden_until_reveal`, Task 7 `leaving_body_resets_reveal`·`idle_return_clears_views`.
6. **거울 1:1**: 실제 in-process 컨트롤러 응답을 `deny_unknown_fields` 거울로 역직렬화한다. → Task 1 `record_round_trips_real_controller_response`.
7. **스텝 칸 강조 규칙이 GUI와 같다**: 같은 스텝이 loop로 여러 번 돌면 **마지막** http 행, `if` 행은 대상 아님. → Task 4 `focus_is_last_http_row_of_step`.
8. **JSON 들여쓰기가 내용을 바꾸지 않는다**: 키 순서·숫자 표기(`1.0`, `1e3`, 큰 정수)·문자열 안의 `{`·`,`·`\"`가 그대로다. 공백을 뺀 글자열이 원문과 같다. → Task 5 `pretty_json_preserves_tokens`.
9. **5분 자동 복귀가 실제 시간 없이 검증된다**: 판정은 `Instant` 두 개를 받는 순수 함수. → Task 7 `idle_expired_rules`.

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `crates/tui/Cargo.toml` (수정) | `handicap-engine = { path = "../engine" }` | 1 |
| `crates/tui/src/wire.rs` (수정) | `ClipSide`·`Clipped`·`CheckRecord` 거울 | 1 |
| `crates/tui/src/api.rs` (수정) | `Api::record` | 1 |
| `crates/tui/src/names.rs` (새) | 번들 → 시나리오·스텝·환경 이름, `flatten_http_steps`, 스텝 메서드·URL(적힌 그대로) | 2 |
| `crates/tui/src/session.rs` (수정) | `Session.names` | 2 |
| `crates/tui/src/inspect.rs` (새) | 오류 보기 상태·순수 모델(목록 줄·커서·사유 캐시·스텝 줄·본문 줄) | 3, 4, 5 |
| `crates/tui/src/view/inspect.rs` (새) | 새 화면 공용 틀(머리 줄·무입력 안내 줄·키 줄) + 목록·상세·본문 그리기 | 3, 4, 5 |
| `crates/tui/src/panel_settings.rs` (새) | 설정 항목 12개, 조건·표시 값 한 줄 문구 | 6 |
| `crates/tui/src/view/settings.rs` (새) | 설정 번호 목록 그리기 | 6 |
| `crates/tui/src/view/mod.rs` (수정) | `pub mod inspect; pub mod settings;`, `wrap_width`를 `overlay.rs`에서 옮겨 `pub(crate)` | 3, 5 |
| `crates/tui/src/judge.rs` (수정) | `format_date_hms` | 4 |
| `crates/tui/src/text.rs` (수정) | 새 문구 | 3–7 |
| `crates/tui/src/app.rs` (수정) | 화면 4개·키·조회 태스크·5분 자동 복귀·키 줄 | 7 |
| `crates/tui/src/view/monitor.rs`, `view/overlay.rs` (수정) | 머리 줄 공용화(`HeaderView`), 모니터 키 줄 조각 2개·순서, 도움말 2줄 + 무입력 안내 | 3, 7 |
| `crates/tui/src/lib.rs` (수정) | `pub mod names; pub mod inspect; pub mod panel_settings;` | 2, 3, 6 |
| `crates/tui/tests/record_test.rs`·`names_test.rs`·`inspect_test.rs`·`settings_test.rs` (새), `session_test.rs`·`app_test.rs`·`view_test.rs`·`judge_parity_test.rs` (수정) | 테스트 | 1–7 |
| `docs/dev/tui-monitor.md`, `docs/superpowers/specs/2026-11-07-tui-monitor-design.md` | 매뉴얼·spec 확정 표시 | 8 |

공통 테스트 도우미: 새 테스트 파일은 `view_test.rs`의 `buffer_text`·`draw`(31–55행 근처 — 넓은 문자 채움 셀 건너뛰기)를 **그대로 복사**해 쓴다(테스트 파일끼리 공유 모듈 없음 — 1a 관례).

---

### Task 1: 기록 조회 — 거울 타입 + `Api::record` (US3 기반)

spec §4.1 "1b 엔드포인트", §5.3-1 "404".

**Files:**
- Modify: `crates/tui/Cargo.toml`, `crates/tui/src/wire.rs`, `crates/tui/src/api.rs`
- Create: `crates/tui/tests/record_test.rs`

**Interfaces:**
- Produces:
  ```rust
  // wire.rs — 컨트롤러 monitor/record.rs `CheckRecord`(손으로 쓴 Serialize: at_ms, limit_kb, result, trace, clipped)의 거울
  #[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
  #[serde(rename_all = "lowercase")]
  pub enum ClipSide { Request, Response }
  #[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct Clipped { pub step: u32, pub side: ClipSide } // step = trace.steps 배열 인덱스
  #[derive(Debug, Clone, Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct CheckRecord {
      pub at_ms: i64,
      pub limit_kb: u32,
      pub result: CheckResult,                         // handicap_controller::monitor::check
      pub trace: Option<handicap_engine::ScenarioTrace>,
      pub clipped: Vec<Clipped>,
  }
  // api.rs
  /// 없는 보드·칸·밀려난 기록은 모두 `ApiError{status: Some(404)}`.
  pub async fn record(&self, board_id: &str, panel_id: &str, at_ms: i64) -> Result<CheckRecord, ApiError>;
  ```
  경로 `"{base}/monitor-boards/{board_id}/panels/{panel_id}/records/{at_ms}"`, 제한 `POLL_TIMEOUT`, 기존 `parse`·`transport` 재사용. 보드·칸 id는 서버가 ULID로 검증한 값이라 `format!`로 충분하다(1a `board`·`status`와 같다).

- [ ] **Step 1: 실패 테스트 작성**

```rust
// tests/record_test.rs — session_test.rs의 TEMPLATE·write 도우미를 복사. 응답기는 503 고정.
#[tokio::test(flavor = "multi_thread")]
async fn record_round_trips_real_controller_response() {
    // Review Focus 6. wiremock GET → 503. Session::start → /status에 결과가 생길 때까지(10 s 상한, 200 ms 간격).
    // r = status.panels[0].results.last(); rec = api.record(board, panel, r.at_ms).await.unwrap()
    // rec.at_ms == r.at_ms; rec.result.verdict == Verdict::Fail; rec.result.reason.is_some()
    // rec.limit_kb == 128 (보드 기본값); trace = rec.trace.unwrap(); trace.steps.len() == 1
    // trace.steps[0].step_id == "01J0000000000000000000ST01"; response.status == 503; rec.clipped.is_empty()
    // 끝에 s.shutdown().await
}
#[tokio::test(flavor = "multi_thread")]
async fn record_unknown_round_is_404() {
    // 같은 세션에서 at_ms = 1 → Err, e.status == Some(404). 없는 칸 id("01J0000000000000000000PN99")도 404.
}
// wire.rs #[cfg(test)]
#[test] fn record_trace_null_and_clipped_deserialize() {
    // {"at_ms":5,"limit_kb":16,"result":{"at_ms":5,"verdict":"config_error","latency_ms":null,"reason":"x","detail":null,"display":[]},
    //  "trace":null,"clipped":[{"step":0,"side":"request"},{"step":2,"side":"response"}]}
    // → trace None, clipped == [Clipped{0,Request}, Clipped{2,Response}]
}
#[test] fn record_rejects_unknown_field() { /* 위 JSON에 "extra":1 → Err ; clipped 원소에 "x":1 → Err */ }
```

- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-tui --test record_test` → 컴파일 오류(`Api::record` 없음).
- [ ] **Step 3: 구현** — Interfaces 그대로. `Cargo.toml` `[dependencies]`에 `handicap-engine = { path = "../engine" }`. **접어 넣는 연기 항목(§B45 (2))**: `api.rs` `io_kind_reports_connection_refused` 테스트의 `reqwest::Client::new()`를 `reqwest::Client::builder().no_proxy().build().unwrap()`으로(프록시 환경에서 다른 오류가 나는 것 방지).
- [ ] **Step 4: 통과 확인** — 공통 3명령 전부 PASS.
- [ ] **Step 5: 커밋** — `git add crates/tui Cargo.lock` → `feat(tui): 점검 기록 조회 API와 거울 타입`.

---

### Task 2: 이름 해석 — 번들 파일에서 시나리오·스텝·환경 이름 (US3 기반)

spec §5.3 "이름 해석". 선행 결정 표의 평탄화·파싱 결정.

**Files:**
- Create: `crates/tui/src/names.rs`, `crates/tui/tests/names_test.rs`
- Modify: `crates/tui/src/lib.rs`, `crates/tui/src/session.rs`, `crates/tui/tests/session_test.rs`

**Interfaces:**
- Produces:
  ```rust
  // names.rs
  /// GUI `flattenHttpSteps`와 같은 순서: http → loop.do → if(then, elif[].then, else) → parallel(branches[].steps), 깊이 우선.
  pub fn flatten_http_steps(steps: &[Step]) -> Vec<&HttpStep>;       // handicap_engine::{Step, HttpStep}
  /// `method` = `HttpMethod`의 serde 문자열("GET"), `url` = YAML에 적힌 그대로(`{{var}}`·`${ENV}` 미치환 — 사용자 확정 4).
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct StepInfo { pub id: String, pub name: String, pub method: String, pub url: String }
  #[derive(Debug, Clone, Default, PartialEq, Eq)]
  pub struct Names { /* 비공개: scenarios: HashMap<String, ScenarioNames>, environments: HashMap<String, String> */ }
  impl Names {
      /// `file` = 번들 파일 바이트(BOM 있어도 됨 — `session::strip_bom`). JSON이 깨졌으면 빈 Names,
      /// 시나리오 YAML 하나가 깨졌으면 그 시나리오만 빠진다. 절대 실패하지 않는다.
      pub fn from_bundle(file: &[u8]) -> Names;
      pub fn scenario_name(&self, scenario_id: &str) -> Option<&str>;
      /// `None` = 그 시나리오를 못 읽음. `Some(목록)` = 평탄화 순서.
      pub fn step_infos(&self, scenario_id: &str) -> Option<&[StepInfo]>;
      /// (평탄화 순번 1부터, 정보)
      pub fn step_info(&self, scenario_id: &str, step_id: &str) -> Option<(usize, &StepInfo)>;
      pub fn step_name(&self, scenario_id: &str, step_id: &str) -> Option<&str>;
      pub fn env_name(&self, environment_id: &str) -> Option<&str>;
  }
  // session.rs
  pub struct Session { pub names: Names, /* 기존 필드 */ }  // Session::start가 읽은 `bytes`로 만든다(파일을 다시 읽지 않는다)
  ```
  파싱용 비공개 구조체는 `deny_unknown_fields` **없이** `#[derive(Deserialize)] struct BundleLite { #[serde(default)] scenarios: Vec<ScenarioLite{id, yaml}>, #[serde(default)] environments: Vec<EnvLite{id, name}> }` — `EnvLite`에 `vars` 필드를 두지 않는다. 모듈 주석에 "wire.rs의 `deny_unknown_fields`를 일부러 따르지 않는다(이름 표시용, 검증은 서버 가져오기가 했다)".

- [ ] **Step 1: 실패 테스트 작성**

```rust
// tests/names_test.rs
const NESTED: &str = r#"
version: 1
name: 중첩
steps:
  - { id: "01J00000000000000000000A01", name: a, type: http, request: { method: GET, url: "/a" }, assert: [] }
  - id: "01J00000000000000000000L01"
    name: 반복
    type: loop
    repeat: 2
    do:
      - { id: "01J00000000000000000000A02", name: b, type: http, request: { method: GET, url: "/b" }, assert: [] }
  - id: "01J00000000000000000000I01"
    name: 분기
    type: if
    cond: { left: "{{code}}", op: eq, right: "200" }
    then:
      - { id: "01J00000000000000000000A03", name: c, type: http, request: { method: GET, url: "/c" }, assert: [] }
    elif:
      - cond: { left: "{{code}}", op: eq, right: "404" }
        then:
          - { id: "01J00000000000000000000A04", name: d, type: http, request: { method: GET, url: "/d" }, assert: [] }
    else:
      - { id: "01J00000000000000000000A05", name: e, type: http, request: { method: GET, url: "/e" }, assert: [] }
  - id: "01J00000000000000000000P01"
    name: 동시
    type: parallel
    branches:
      - name: x
        steps:
          - { id: "01J00000000000000000000A06", name: f, type: http, request: { method: GET, url: "/f" }, assert: [] }
      - name: y
        steps:
          - { id: "01J00000000000000000000A07", name: g, type: http, request: { method: GET, url: "/g" }, assert: [] }
"#;
#[test] fn flatten_order_matches_gui() {
    // Scenario::from_yaml(NESTED).unwrap() → flatten_http_steps 이름 == ["a","b","c","d","e","f","g"]
    // (YAML이 파싱 안 되면 이 테스트가 먼저 알려 준다 — 문법은 엔진 scenario.rs 테스트 픽스처에서 가져왔다)
}
#[test] fn names_from_bundle_resolves() {
    // serde_json::json!로 번들 조립: scenarios [{id:"S1", yaml: NESTED}], environments [{id:"E1", name:"운영", vars:{"K":"비밀"}}]
    // scenario_name("S1") == Some("중첩"); step_name("S1","01J00000000000000000000A04") == Some("d")
    // step_infos("S1").unwrap().len() == 7; step_info("S1", …A04) == Some((4, StepInfo{name:"d", method:"GET", url:"/d", ..}))
    // env_name("E1") == Some("운영"); 모르는 id → None
    // format!("{names:?}")에 "비밀" 없음(환경 값을 들지 않는다)
}
#[test] fn names_tolerates_bad_input() {
    // b"not json" → Names::default(); 시나리오 둘 중 하나의 yaml이 "::" → 그 시나리오만 step_infos None, 다른 것은 Some
    // BOM(EF BB BF) + 정상 JSON → 정상; scenarios 키 없음 → 빈 Names
}
// tests/session_test.rs
#[tokio::test(flavor = "multi_thread")]
async fn session_keeps_names_from_bundle() {
    // 기존 fixture: names.step_name("01J0000000000000000000SC01","01J0000000000000000000ST01") == Some("ping")
    // names.scenario_name(..) == Some("tui-fixture"); env_name("01J0000000000000000000EN01") == Some("대상")
}
```

- [ ] **Step 2: 실패 확인** — 컴파일 오류(`names` 모듈 없음).
- [ ] **Step 3: 구현** — Interfaces 그대로. `flatten_http_steps`는 `match`가 `Step` 네 변형을 모두 나열(와일드카드 금지 — 엔진이 변형을 더하면 컴파일 오류로 알게).
- [ ] **Step 4: 통과 확인** — 공통 3명령.
- [ ] **Step 5: 커밋** — `feat(tui): 번들 파일에서 시나리오·스텝·환경 이름 해석`.

---

### Task 3: 오류 목록 — 화면 틀·줄 모델·커서·사유 캐시·그리기 (US3)

spec §5.3-1 + "1b 확정" 블록. Review Focus 3·4. **화면 배치는 목업 `docs/superpowers/specs/2026-11-10-tui-1b-mockups/01-screens.html` §1(오류 목록, `a` 누른 뒤 포함)을 따른다(글자 배치 재량 범위 내).**

**Files:**
- Create: `crates/tui/src/inspect.rs`, `crates/tui/src/view/inspect.rs`, `crates/tui/tests/inspect_test.rs`
- Modify: `crates/tui/src/lib.rs`, `crates/tui/src/view/mod.rs`, `crates/tui/src/view/monitor.rs`(머리 줄 뽑기), `crates/tui/src/text.rs`, `crates/tui/tests/judge_parity_test.rs`

**Interfaces:**
- Consumes: Task 1 `CheckRecord`, `ApiError`.
- Produces (`view/monitor.rs` — 머리 줄 공용화, 모양 불변):
  ```rust
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct HeaderView { pub board_name: String, pub board_pos: (usize, usize), pub server_time: Option<i64>, pub server_down: bool }
  impl MonitorScreen { pub fn header(&self) -> HeaderView; }
  pub fn render_header_view(f: &mut Frame, area: Rect, h: &HeaderView);   // 기존 비공개 render_header의 본체. render_header는 이것을 부른다
  ```
- Produces (`view/inspect.rs` — 새 화면 넷이 같이 쓰는 틀):
  ```rust
  pub struct SubLayout { pub head: Option<Rect>, pub body: Rect, pub idle: Option<Rect>, pub keys: Option<Rect> }
  /// 높이 ≥ 1이면 맨 아래 키 줄, ≥ 3이면 맨 위 머리 줄, 높이 ≥ 10 ∧ 폭 ≥ (안내 문구 폭 + 1)이면 키 줄 바로 위에 무입력 안내 줄. 나머지가 body.
  pub fn sub_layout(area: Rect) -> SubLayout;
  /// 머리 줄·무입력 안내 줄(`text::IDLE_NOTICE`, C_MUTED)·키 줄(`view::key_bar`, C_MUTED)을 그리고 body를 돌려준다.
  pub fn render_frame(f: &mut Frame, head: &HeaderView, keys: &[&str]) -> Rect;
  ```
  **무입력 안내 줄 자리 결정**: 키 줄 조각으로 넣으면 80열에서 늘 빠지므로(문구 42칸) **키 줄 바로 위 전용 한 줄**로 둔다. 높이 10줄 미만이거나 폭이 문구보다 좁으면 **통째로 생략**(줄이거나 `…`로 자르지 않는다 — `crates/tui/CLAUDE.md` 첫 함정). 생략돼도 도움말(`?`)과 매뉴얼에 같은 문장이 있다(Task 7·8).
- Produces (`inspect.rs`):
  ```rust
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub enum Reason {
      Known { reason: Option<String>, detail: Option<String> },
      Loading,
      Gone,            // 404
      Failed(String),  // ApiError.message
  }
  pub fn is_failure(v: Verdict) -> bool;                     // Fail | ConfigError | UpstreamFailed
  /// 한 회차의 상태 — 벽과 같은 규칙(`judge::panel_state`의 verdict·기준선 부분): Fail→Fail, ConfigError→ConfigError,
  /// UpstreamFailed→Blocked, BranchSkipped→Skipped, Ok ∧ 지연 ≥ 어느 기준선→Slow, 그 외 Ok.
  pub fn row_state(r: &CheckResult, thresholds: &[Threshold]) -> PanelState;
  /// 최신 순. `show_all == false`면 실패류만.
  pub fn error_results(results: &[CheckResult], show_all: bool) -> Vec<&CheckResult>;
  /// 목록(최신 순 at_ms)에서 커서 줄 번호. None → 0. 있으면 그 줄. 없으면 그보다 오래된 첫 줄, 그것도 없으면 마지막 줄. 빈 목록 → 0.
  pub fn cursor_index(rows_at: &[i64], cursor_at: Option<i64>) -> usize;
  /// 커서를 `delta`줄 옮긴 뒤의 at_ms(양 끝에서 멈춤). 빈 목록 → None.
  pub fn move_cursor(rows_at: &[i64], cursor_at: Option<i64>, delta: isize) -> Option<i64>;
  /// 커서가 보이는 창의 첫 줄(상태 없이 계산): `cursor.saturating_sub(height / 2).min(len.saturating_sub(height))`.
  pub fn window_start(cursor: usize, len: usize, height: usize) -> usize;
  pub fn reason_of(r: Result<CheckRecord, ApiError>) -> Reason;  // Ok → Known{result.reason, result.detail}, 404 → Gone, 그 외 → Failed(message)

  #[derive(Debug, Default)]
  pub struct ReasonCache { /* HashMap<i64, Reason> */ }
  impl ReasonCache {
      /// 최신 결과(`/status`가 사유를 싣는다)와 Ok는 조회 없이 `r`에서, 나머지는 캐시(없으면 Loading).
      pub fn reason_for(&self, r: &CheckResult, is_latest: bool) -> Reason;
      /// `visible` 중 조회가 필요한 at_ms(최신 아님 ∧ Ok 아님 ∧ 캐시에 없음).
      pub fn wanted(&self, visible: &[&CheckResult], latest_at: Option<i64>) -> Vec<i64>;
      pub fn mark_loading(&mut self, at: &[i64]);
      pub fn put(&mut self, at_ms: i64, r: Reason);
      pub fn retain(&mut self, alive: &std::collections::HashSet<i64>); // 막대 구간에서 밀려난 회차 제거
  }
  #[derive(Debug, Default)]
  pub struct ErrorsState { pub board_id: String, pub panel_id: String, pub show_all: bool, pub cursor_at: Option<i64>, pub cache: ReasonCache }

  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct ErrorRow { pub at_ms: i64, pub state: PanelState, pub latency_ms: Option<u64>, pub reason: Reason }
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct ErrorsView {
      pub title: String,            // 칸 제목
      pub rows: Vec<ErrorRow>,      // 보이는 창만
      pub cursor: Option<usize>,    // 창 안 줄 번호(목록이 비면 None)
      pub failures: usize,          // 막대 구간의 실패류 회차 수
      pub total: usize,             // 막대 구간 전체 회차 수
      pub span_secs: u64,           // total × interval_seconds (명목 구간)
      pub show_all: bool,
  }
  pub struct ErrorsInput<'a> { pub title: &'a str, pub results: &'a [CheckResult], pub thresholds: &'a [Threshold], pub interval_seconds: u32 }
  /// `height` = 목록 줄 수. `results`는 `/status` 순서(오래된 → 최신).
  pub fn errors_view(i: &ErrorsInput, st: &ErrorsState, height: usize) -> ErrorsView;
  /// 창에 보이는 결과(조회 대상 계산용) — `errors_view`와 같은 창.
  pub fn visible_results<'a>(results: &'a [CheckResult], st: &ErrorsState, height: usize) -> Vec<&'a CheckResult>;
  ```
- Produces (`view/inspect.rs`):
  ```rust
  /// body에서 제목 줄 1 + (body 높이 ≥ 4면) 열 이름 줄 1을 뺀 줄 수.
  pub fn errors_list_height(area: Rect) -> usize;
  pub fn render_errors(f: &mut Frame, head: &HeaderView, v: &ErrorsView, keys: &[&str]);
  ```
  배치(목업 §1): `render_frame` 뒤 body 1행 = 제목 `오류 보기 · {칸 제목}`(왼쪽) + 개수(오른쪽 — 실패만: `실패 {failures}회 · 최근 {total}회({구간}) 중`, 전체: `전체 {total}회`; 폭이 모자라면 개수를 **통째로** 뺀다). 구간 글자 = `span_secs ≥ 60`이면 `약 {반올림 분}분`, 아니면 `약 {초}초`. 열 이름 줄 `시각 · 상태 · 사유`(C_MUTED, 열 위치는 목록과 같게). 목록 줄 = `▶ `(커서 줄만, 아니면 2칸 공백) + `HH:MM:SS`(`judge::format_hms`) + 3칸 + `text::state_label(state)`(가장 넓은 문구 `– 확인 불가 · 점검 꺼짐`이 아니라 **이 화면에 나올 수 있는 여섯 문구 중 가장 넓은 폭**으로 채움) + 3칸 + 사유 칸. 사유 칸: 상태가 Ok·Slow면 `judge::format_ms(latency)`(지연 없으면 `text::NO_VALUE`), 그 외 `Known{reason: Some(s)}` → `s`, `Known{None}` → `text::NO_VALUE`, `Loading` → `text::LOADING`, `Gone` → `text::RECORD_GONE_SHORT`, `Failed(m)` → `text::record_load_error(m)`. 폭이 모자라면 사유를 `fit`으로 줄이고(가변 칸), 그래도 모자라면 상태 문구 → 시각 순으로 **통째** 뺀다. 빈 목록이면 `text::ERRORS_EMPTY`(실패만 보기) 또는 `text::ERRORS_EMPTY_ALL` 한 줄. 색: Fail `C_FAIL`, ConfigError·Slow `C_SLOW`, Blocked·Skipped `C_GRAY`, Ok `C_OK`(`monitor.rs`의 `pub(crate)` 상수 재사용), 커서 줄 굵게.

- 문구(`text.rs`):

  | 상수·함수 | 값 | 출처 |
  |---|---|---|
  | (재사용) `state_label(PanelState)` | `✔ 정상`·`▲ 느림`·`✖ 실패`·`⚠ 설정 오류`·`― 확인 못 함`·`○ 분기 제외` | 1a에 이미 있음(`ko.monitor.stateOk`…`stateSkipped`) |
  | `LOADING` | `불러오는 중…` | `ko.monitor.loading` |
  | `record_load_error(msg)` | `기록을 불러오지 못했습니다: {msg}` | `ko.monitor.recordLoadError` |
  | `RECORD_GONE_SHORT` | `기록 지남` | TUI 전용(사용자 확정 7) |
  | `ERRORS_TITLE` | `오류 보기` | TUI 전용 |
  | `errors_count(failures, total, span)` / `errors_count_all(total)` | `실패 {failures}회 · 최근 {total}회({span}) 중` / `전체 {total}회` | TUI 전용(목업) |
  | `span_text(secs)` | `약 {n}분` / `약 {n}초` | TUI 전용 |
  | `ERRORS_COLS` | `("시각", "상태", "사유")` | TUI 전용(목업) |
  | `ERRORS_EMPTY` / `ERRORS_EMPTY_ALL` | `이 구간에 실패가 없습니다` / `아직 점검 결과가 없습니다` | TUI 전용(목업 / 재량) |
  | `IDLE_NOTICE` | `5분 동안 입력이 없으면 모니터로 돌아갑니다` | TUI 전용(사용자 확정 2·B) |

- [ ] **Step 1: 실패 테스트 작성**

```rust
// tests/inspect_test.rs — res(at, verdict, latency) 도우미: reason/detail None, display 빈 배열. head() 도우미: HeaderView{"운영 API 보드",(1,1),Some(now),false}
#[test] fn error_results_filters_and_orders() {
    // [ok@1, fail@2, config_error@3, branch_skipped@4, upstream_failed@5] → 실패만: at [5,3,2]; 전체: [5,4,3,2,1]
}
#[test] fn row_state_matches_wall_rules() {
    // 기준선 [800]: ok 612 → Ok; ok 1620 → Slow; ok 지연 None → Ok; fail → Fail; config_error → ConfigError;
    // upstream_failed → Blocked; branch_skipped → Skipped. 기준선 없음: ok 9999 → Ok
}
#[test] fn cursor_stays_on_same_round_when_new_results_arrive() {
    // Review Focus 3(사용자 확정 3). rows [30,20,10], cursor_at Some(20) → 1. 새 실패 40이 앞에: [40,30,20,10] → 2 (같은 회차)
}
#[test] fn cursor_falls_to_next_older_when_evicted() {
    // rows [40,30,10], cursor_at Some(20)(목록에서 사라짐) → 2(10). rows [40,30], cursor_at Some(20) → 1(마지막). 빈 목록 → 0.
}
#[test] fn move_cursor_clamps() { /* [30,20,10]: (None,+1)→Some(20); (Some(10),+1)→Some(10); (Some(30),-5)→Some(30); 빈 목록 → None */ }
#[test] fn window_start_cases() { /* (0,10,4)→0; (5,10,4)→3; (9,10,4)→6; (2,3,10)→0; (0,0,0)→0; (3,10,0)→0 패닉 없음 */ }
#[test] fn reason_for_latest_and_ok_need_no_fetch() {
    // 최신 fail(reason Some("HTTP 503")) → Known 그대로; 예전 ok → Known{None,None}; 예전 fail 캐시 없음 → Loading
    // wanted([최신 fail, 예전 fail@2, 예전 ok@1], latest_at) == [2]; mark_loading([2]) 뒤 wanted == []
}
#[test] fn reason_of_maps_404_and_errors() { /* status Some(404) → Gone; status None message "m" → Failed("m"); Ok(rec) → Known{rec.result.reason, detail} */ }
#[test] fn cache_retain_drops_evicted() { /* put(1), put(2); retain({2}) → reason_for(예전 fail@1) == Loading */ }
#[test] fn errors_view_window_and_counts() {
    // 결과 12개(실패 10·ok 2), interval 5, height 4, cursor_at 가운데 → rows.len()==4, cursor Some(창 안 번호),
    // failures 10, total 12, span_secs 60. show_all이면 ok 줄 포함(state Ok, latency Some). visible_results가 같은 4개.
}
#[test] fn span_text_minutes_and_seconds() { /* 1500 → "약 25분"; 60 → "약 1분"; 45 → "약 45초"; 0 → "약 0초" */ }
#[test] fn sub_layout_rows() {
    // 100×24: head Some(y0), keys Some(y23), idle Some(y22), body y1..y22
    // 100×9: idle None(높이 < 10); 30×24: idle None(폭 < 문구); 80×2: head None, keys Some; 80×0: keys None, body 높이 0
}
#[test] fn render_errors_shows_rows() {
    // 100×14(목업 §1): 머리 줄 "Handicap 모니터 · 운영 API 보드", "오류 보기 · 주문 조회", "실패 3회 · 최근 5회(약 25초) 중",
    // 열 이름 "시각"·"상태"·"사유", 커서 줄 "▶ ", format_hms(at) 글자, "✖ 실패", "HTTP 503", "― 확인 못 함",
    // Loading 줄 "불러오는 중…", Gone 줄 "기록 지남", 끝에서 둘째 줄 == "5분 동안 입력이 없으면 모니터로 돌아갑니다"(앞뒤 공백 제외), 마지막 줄 = 넘긴 keys
    // 버퍼 어디에도 "판정 상세" 없음(사용자 확정 8 — 목록엔 판정 상세 줄이 없다)
}
#[test] fn render_errors_all_mode_shows_latency() {
    // show_all: "전체 5회", ok 줄 "✔ 정상" + "612 ms", 느림 줄 "▲ 느림" + "1,620 ms"
}
#[test] fn render_errors_empty_messages() { /* 실패만: "이 구간에 실패가 없습니다"; show_all + 결과 0: "아직 점검 결과가 없습니다" */ }
#[test] fn render_errors_narrow_drops_whole_parts() {
    // 폭 30: 무입력 안내 줄 없음(잘린 "5분 동안 입" 없음), 개수 통째 없음, 사유는 `…`로, 상태 문구는 통째로 있거나 통째로 없다
}
#[test] fn errors_size_sweep_no_panic() { /* Review Focus 4. w 1..=60 × h 1..=12, 커서가 맨 위·가운데·맨 아래 줄일 때 각각 그리기 */ }
// tests/view_test.rs
#[test] fn header_view_matches_monitor_header() { /* 같은 값의 MonitorScreen.header()로 render_header_view를 그린 첫 줄 == render(모니터)의 첫 줄 */ }
// tests/judge_parity_test.rs
#[test] fn mirrored_text_exists_in_ko_ts() {
    // ko = read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../ui/src/i18n/ko.ts"))
    // 이 task 행: ko.contains(r#"loading: "불러오는 중…""#), "`기록을 불러오지 못했습니다: ${msg}`"
    // 그리고 text 쪽 값이 같은 글자인지: text::LOADING == "불러오는 중…", record_load_error("m") == "기록을 불러오지 못했습니다: m"
}
#[test] fn reason_parts_multibyte_needle() {
    // §B45 (2) 접어 넣기: reason_parts("\"한글\" 포함 안 됨", Some("본문 전체 글자 포함 x")) == NotContained{needle:"한글", small:"본문 전체 글자 포함 x"}
}
```

- [ ] **Step 2: 실패 확인** — 컴파일 오류(`inspect` 없음). `reason_parts_multibyte_needle`만은 기존 코드로 바로 통과해도 된다(연기된 테스트 보강).
- [ ] **Step 3: 구현** — Interfaces·문구 표 그대로. 머리 줄 뽑기는 모양 불변 리팩터(기존 `view_test.rs` 머리 줄 테스트가 그대로 통과).
- [ ] **Step 4: 통과 확인** — 공통 3명령. 추가로 `mirrored_text_exists_in_ko_ts`가 공허하지 않은지 실증: `text::LOADING`을 한 글자 바꿔 RED 확인 → 되돌려 GREEN.
- [ ] **Step 5: 커밋** — `feat(tui): 오류 목록 모델과 화면`.

---

### Task 4: 기록 상세 — 사유·판정 상세·스텝 표·특수 기록 (US3)

spec §5.3-2·§5.3-3 + "1b 확정" 블록. Review Focus 7. **화면 배치는 목업 `docs/superpowers/specs/2026-11-10-tui-1b-mockups/01-screens.html` §2(자세히 + 특수 기록 4가지)를 따른다(글자 배치 재량 범위 내).**

**Files:**
- Modify: `crates/tui/src/inspect.rs`, `crates/tui/src/view/inspect.rs`, `crates/tui/src/judge.rs`, `crates/tui/src/text.rs`
- Test: `crates/tui/tests/inspect_test.rs`, `crates/tui/tests/judge_parity_test.rs`

**Interfaces:**
- Consumes: Task 2 `Names`, Task 3 `window_start`·`row_state`·`render_frame`·`HeaderView`.
- Produces (`inspect.rs`):
  ```rust
  #[derive(Debug, Clone)]
  pub enum RecordLoad { Loading, Loaded(Box<CheckRecord>), Gone, Failed(String) }
  pub fn load_of(r: Result<CheckRecord, ApiError>) -> RecordLoad;
  #[derive(Debug, Clone)]
  pub struct RecordState { pub at_ms: i64, pub clicked: CheckResult, pub load: RecordLoad, pub cursor: usize }

  /// GUI `branchText`: "none" → "(미매치)", "then"/"else" 그대로, "elif_3" → "elif 3", 그 외 원문.
  pub fn branch_text(branch: &str) -> String;
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub enum StepLine {
      If { branch: String },                    // branch_text 적용본
      Http {
          trace_idx: usize,                     // trace.steps 인덱스(= Clipped.step)
          no: usize,                            // 이 기록의 http 줄 순번(1부터, if 줄은 세지 않는다)
          loop_index: Option<u32>,
          name: String,                         // Names에서, 없으면 step_id
          method: Option<String>, url: Option<String>,
          status: Option<u16>, latency_ms: Option<u64>,
          error: Option<String>, timed_out: bool,
          focus: bool,                          // 스텝 칸의 그 스텝(마지막 http 행 하나만)
      },
  }
  pub fn step_lines(trace: &ScenarioTrace, names: &Names, scenario_id: &str, focus_step_id: Option<&str>) -> Vec<StepLine>;
  /// 처음 커서: focus 줄(스텝 칸 — 사용자 확정 9) → 없으면 error가 있는 첫 Http → 첫 Http → 0.
  pub fn initial_step_cursor(lines: &[StepLine]) -> usize;
  /// `from`에서 `dir`(−1/+1) 쪽으로 가장 가까운 Http 줄 번호(If 줄 건너뜀). 없으면 None. (Task 5·7의 `←`/`→`가 쓴다)
  pub fn neighbor_http(lines: &[StepLine], from: usize, dir: isize) -> Option<usize>;
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub enum Note { NoTraceConfig, NoTraceTimeout, TraceError(String), TraceCut }
  /// GUI `RecordSteps`와 같은 구분: trace null → (clicked가 config_error면 NoTraceConfig, 아니면 NoTraceTimeout) 하나만.
  /// trace 있음 → error가 있으면 TraceError, truncated면 TraceCut(둘 다면 그 순서로 둘).
  pub fn record_notes(rec: &CheckRecord, clicked: Verdict) -> Vec<Note>;

  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct RecordView {
      pub title: String,              // text::record_title(칸 제목, format_date_hms(clicked.at_ms))
      pub state: PanelState,          // row_state(clicked, 칸 기준선)
      pub latency_ms: Option<u64>,    // clicked 기준
      pub reason: Option<String>,     // 기록이 왔으면 rec.result, 아니면 clicked (GUI `q.data?.result ?? clicked`)
      pub detail: Option<String>,
      pub scenario: String,           // 이름 또는 id
      pub environment: Option<String>,// 이름 또는 id, 환경 없음이면 None
      pub body: RecordBody,
  }
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub enum RecordBody { Loading, Gone, Failed(String), Loaded { notes: Vec<Note>, lines: Vec<StepLine>, cursor: usize } }
  pub fn record_view(panel: &PanelConfig, st: &RecordState, names: &Names) -> RecordView; // focus = panel.step_id
  ```
- Produces (`judge.rs`): `pub fn format_date_hms(ms: i64) -> String` — 로컬 `YYYY-MM-DD HH:MM:SS`(GUI `formatDateHms`). `local_fmt`의 변환 실패 대체에 `%Y`→`0000`, `%m`·`%d`→`00`을 더한다.
- Produces (`view/inspect.rs`): `pub fn render_record(f: &mut Frame, head: &HeaderView, v: &RecordView, keys: &[&str]);`
  배치(목업 §2, `render_frame`의 body 안 위에서부터): 제목 줄 · `{state_label}    {format_ms(latency)}`(지연 없으면 문구만) · `사유  {reason}`(있으면) · `판정 상세  {detail}`(있으면) · `시나리오  {scenario}   환경 {environment}`(환경 없으면 `text::SET_ENV_NONE` 대신 환경 조각 생략) · 안내 줄들(Note·Loading·Gone·Failed) · 표 머리 `#  스텝  요청  응답  지연`(C_MUTED, 스텝 줄이 있을 때만) · 스텝 줄들(남는 높이에 `window_start(cursor, len, 높이)`부터). 높이가 모자라면 위에서부터 순서대로 그리되 **스텝 줄이 최소 1줄은 보이게** `시나리오` 줄 → `판정 상세` 줄 → 표 머리 순으로 통째 뺀다(상태·사유·안내 줄은 남긴다).
  스텝 줄: `If` → 들여쓴 `text::record_if_row(branch)`(C_MUTED). `Http` → `▶ `(커서) + 순번 `no`(오른쪽 정렬 2칸) + 2칸 + 이름(+ ` #{loop_index}` — GUI처럼 엔진 값 그대로 0부터) + 2칸 + `METHOD URL` + 2칸 + 상태 코드(응답 없으면 `text::NO_VALUE`) + 2칸 + `format_ms(지연)`(시간 초과면 그 자리에 `text::TIMED_OUT`) + (`focus`면 3칸 + `text::THIS_PANEL`). `error`가 있으면 **다음 줄**에 들여 `C_FAIL` 색으로(한 줄, `fit`, 엔진 오류 문장 그대로). 폭이 모자라면 URL을 `fit`으로 줄이고(가변 칸, 8칸 미만이면 `METHOD URL` 통째 생략), 이름은 20칸까지만, `◀ 이 칸`은 통째로 남긴다. 줄 글자는 모두 `inspect::sanitize`를 거쳐야 하는데 그 함수는 Task 5에서 생긴다 — **Task 5 Step 3이 여기에 적용한다**(Task 5에 명시됨).

- 문구(`text.rs`):

  | 상수·함수 | 값 | 출처(`ko.monitor.*`) |
  |---|---|---|
  | `record_title(title, when)` | `{title} · {when}` | `recordTitle` |
  | `RECORD_MISSING` | `이 점검의 기록이 없습니다 — 기록은 막대 구간만큼만 보관되어 이미 지워졌습니다` | `recordMissing` |
  | `RECORD_NO_TRACE_CONFIG` | `요청을 보내기 전에 멈췄습니다(설정 오류) — 요청·응답 기록 없음` | `recordNoTraceConfig` |
  | `RECORD_NO_TRACE_TIMEOUT` | `응답이 오기 전에 시간 초과 — 요청·응답 기록 없음` | `recordNoTraceTimeout` |
  | `record_trace_error(e)` | `점검 준비 중 오류: {e}` | `recordTraceError` |
  | `RECORD_TRACE_CUT` | `점검이 중간에 끊겨 그 전 스텝까지만 기록됐습니다` | `recordTraceCut` |
  | `record_if_row(branch)` | `조건 분기 → {branch}` | `recordIfRow` |
  | `BRANCH_NONE` | `(미매치)` | `ui/src/scenario/chipResults.ts` `BRANCH_LABEL.none` |
  | `REASON_LABEL` / `JUDGE_DETAIL` | `사유` / `판정 상세` | TUI 전용(목업, spec §5.3-2 용어) |
  | `SET_SCENARIO` / `SET_ENV` | `시나리오` / `환경` | `scenario`·`environment`(Task 6도 쓴다) |
  | `RECORD_COLS` | `("#", "스텝", "요청", "응답", "지연")` | TUI 전용(목업) |
  | `TIMED_OUT` | `시간 초과` | TUI 전용(spec §5.3-2 "시간 초과 표시") |
  | `THIS_PANEL` | `◀ 이 칸` | TUI 전용(목업, 사용자 확정 9) |

- [ ] **Step 1: 실패 테스트 작성**

```rust
// tests/inspect_test.rs — trace 조립 도우미: http(step_id, loop_index, status, error) / if_row(step_id, branch)
#[test] fn branch_text_cases() { /* none→"(미매치)", then→"then", else→"else", elif_2→"elif 2", "x"→"x" */ }
#[test] fn step_lines_names_and_fields() {
    // Names(Task 2 NESTED 번들) + trace [http A01 200 12ms, if I01 "elif_0", http A04 503 error "boom" timed_out]
    // → [Http{no:1, name:"a", status:Some(200), ..}, If{branch:"elif 0"}, Http{no:2, name:"d", error:Some("boom"), timed_out:true, trace_idx:2, ..}]
    // Names에 없는 step_id → name == step_id
}
#[test] fn focus_is_last_http_row_of_step() {
    // Review Focus 7. trace [http A02 #0, http A02 #1, if(step_id A02 — 있을 수 없는 조합이지만 가드), http A03], focus Some("A02")
    // → focus == true 인 줄은 두 번째 Http(#1) 하나뿐. focus None → 전부 false.
}
#[test] fn initial_cursor_rules() { /* focus 줄 번호 / focus 없고 둘째 Http에 error → 그 줄 / 둘 다 없음 → 첫 Http / 빈 목록 → 0 */ }
#[test] fn neighbor_http_skips_if_rows() {
    // [Http, If, Http, Http]: (0,+1)→Some(2); (2,-1)→Some(0); (3,+1)→None; (0,-1)→None; 빈 목록 → None
}
#[test] fn record_notes_match_gui_branches() {
    // trace None + ConfigError → [NoTraceConfig]; trace None + Fail → [NoTraceTimeout]
    // trace{error: Some("e"), truncated: true} → [TraceError("e"), TraceCut]; 평범한 trace → []
}
#[test] fn record_view_prefers_record_reason() {
    // clicked(reason None) + Loaded(rec.result.reason Some("HTTP 503"), detail Some("d")) → view.reason/detail == rec 것
    // Loading이면 clicked 것(None). state·latency는 항상 clicked. scenario/environment는 Names 이름(없으면 id, 환경 없음 → None)
}
#[test] fn render_record_loaded() {
    // 110×22(목업 §2): 머리 줄, 제목 "주문 조회 · " + format_date_hms(at), "✖ 실패", "1,204 ms", "사유", "HTTP 503",
    // "판정 상세", "시나리오", "중첩", "환경 운영", 표 머리 "스텝"·"요청"·"응답"·"지연", "POST http://h/login", "503",
    // focus 줄에 "◀ 이 칸" + 그 줄이 "▶ "로 시작(처음 커서), 응답 없는 줄 "—"·"시간 초과", 다음 줄 "boom", "조건 분기 → elif 0",
    // 무입력 안내 줄 있음
}
#[test] fn render_record_states() {
    // Loading → "불러오는 중…"; Gone → RECORD_MISSING(폭에 맞게 줄어도 앞부분 "이 점검의 기록이 없습니다"); Failed("m") → "기록을 불러오지 못했습니다: m"
    // NoTraceConfig / NoTraceTimeout / TraceError / TraceCut 문구(목업 §2 특수 기록 4가지 + "점검 준비 중 오류: …")
}
#[test] fn render_record_short_height_keeps_a_step_row() { /* 110×8: "시나리오" 줄·표 머리가 빠져도 "✖ 실패"·사유·스텝 줄 1개 이상은 보인다 */ }
#[test] fn record_size_sweep_no_panic() { /* w 1..=60 × h 1..=12, 스텝 30줄·커서 0/15/29 */ }
// judge_parity_test.rs
#[test] fn format_date_hms_shape() { /* 길이 19, [4]=='-' [7]=='-' [10]==' ' [13]==':' — 값은 Local로 구해 비교(TZ 무관) */ }
// mirrored_text_exists_in_ko_ts에 행 추가: recordMissing·recordNoTraceConfig·recordNoTraceTimeout·recordTraceCut·scenario·environment 값,
//   "`점검 준비 중 오류: ${e}`", "`조건 분기 → ${branch}`", "`${title} · ${when}`", chipResults.ts의 `none: "(미매치)"`
```

- [ ] **Step 2: 실패 확인** — 컴파일 오류.
- [ ] **Step 3: 구현** — Interfaces·문구 표 그대로.
- [ ] **Step 4: 통과 확인** — 공통 3명령 + `TZ=UTC cargo test -p handicap-tui --test judge_parity_test`(시각 테스트의 TZ 무관 확인).
- [ ] **Step 5: 커밋** — `feat(tui): 점검 기록 상세 — 사유·판정 상세·스텝 표`.

---

### Task 5: 요청·응답 본문 — 줄 만들기·JSON 들여쓰기·가림·잘림 표시·스크롤 (US3)

spec §5.3-4 + "1b 확정" 블록, §9. Review Focus 1·5·8. **화면 배치는 목업 `docs/superpowers/specs/2026-11-10-tui-1b-mockups/01-screens.html` §3(요청·응답 + 요청 본문 가림/보기)을 따른다(글자 배치 재량 범위 내).**

**Files:**
- Modify: `crates/tui/src/inspect.rs`, `crates/tui/src/view/inspect.rs`, `crates/tui/src/view/mod.rs`, `crates/tui/src/view/overlay.rs`, `crates/tui/src/text.rs`
- Test: `crates/tui/tests/inspect_test.rs`, `crates/tui/tests/judge_parity_test.rs`

**Interfaces:**
- Consumes: Task 1 `Clipped`·`ClipSide`, Task 3 `render_frame`·`HeaderView`, Task 4 `StepLine`.
- Produces (`view/mod.rs`): `overlay.rs`의 비공개 `wrap_width(s, w) -> Vec<String>`를 `view/mod.rs`로 옮겨 `pub(crate)`(동작 불변, `overlay.rs`는 `super::wrap_width` 사용).
- Produces (`inspect.rs`):
  ```rust
  /// 탭 → 공백 4칸, CR 제거, 그 밖의 `char::is_control`(ESC 포함)·U+2028/2029 → `�`. 줄바꿈(`\n`)은 호출 쪽이 먼저 나눈다.
  pub fn sanitize(s: &str) -> String;
  /// GUI `TREE_MAX_BYTES`와 같은 상한.
  pub const PRETTY_MAX_BYTES: usize = 64 * 1024;
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub enum Pretty { Json(String), TooLarge, Raw }
  /// 본문을 JSON으로 들여쓸 수 있는지. `s.len() > PRETTY_MAX_BYTES` ∧ 첫 비공백 글자가 `{`/`[` → TooLarge.
  /// `serde_json::from_str::<serde::de::IgnoredAny>(s)`가 성공 ∧ 첫 비공백 글자가 `{`/`[` → Json(들여쓴 글).
  /// 그 외(파싱 실패 — serde_json 재귀 상한 초과의 깊은 중첩 포함, 스칼라, 빈 글) → Raw.
  pub fn pretty_json(s: &str) -> Pretty;
  pub fn clip_flags(clipped: &[Clipped], trace_idx: usize) -> (bool, bool); // (요청 잘림, 응답 잘림)
  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub enum BodyLineKind { Title, Summary, Error, Heading, Text, Note }
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct BodyLine { pub kind: BodyLineKind, pub text: String }
  pub struct BodyInput<'a> {
      pub panel_title: &'a str, pub at_ms: i64, pub no: usize, pub name: &'a str,   // 제목 줄용(StepLine::Http의 no·name)
      pub step: &'a StepTrace, pub clipped_req: bool, pub clipped_resp: bool, pub limit_kb: u32, pub reveal: bool,
  }
  /// 폭 `width`(0이면 1로)에 맞춰 줄바꿈한 전체 줄.
  pub fn body_lines(i: &BodyInput, width: usize) -> Vec<BodyLine>;
  /// 만든 줄을 (폭, reveal)로 기억 — 매 프레임 다시 만들지 않는다(1 MiB 본문).
  #[derive(Debug, Default)]
  pub struct BodyState { pub line_idx: usize /* StepLine 목록에서의 줄 번호 */, pub reveal: bool, pub scroll: usize, /* 비공개 캐시: Option<(usize, bool, Vec<BodyLine>)> */ }
  impl BodyState {
      pub fn new(line_idx: usize) -> BodyState;       // 항상 reveal false · scroll 0 (옆 스텝으로 갈 때도 new)
      /// 캐시가 (width, self.reveal)와 다르면 다시 만든다. 돌려주는 줄 수.
      pub fn ensure(&mut self, i: &BodyInput, width: usize) -> usize;
      pub fn lines(&self) -> &[BodyLine];
      /// `scroll`을 `delta`만큼 옮기되 `0..=len.saturating_sub(height)`에 가둔다.
      pub fn scroll_by(&mut self, delta: isize, height: usize);
      pub fn scroll_to_end(&mut self, height: usize);
  }
  ```
  `pretty_json` 들여쓰기 규칙(값을 다시 만들지 않는 글자 재배치 — Review Focus 8): 문자열 밖 공백은 버린다. `{`/`[` 뒤 줄바꿈 + 들여쓰기 2칸 증가(바로 닫히는 `{}`·`[]`는 한 줄), `,` 뒤 줄바꿈, `:` 뒤 공백 1칸, `}`/`]` 앞 줄바꿈 + 들여쓰기 감소. 문자열(`"` … `"`, `\` 다음 글자는 건너뜀) 안은 한 글자도 바꾸지 않는다. 숫자·`true`/`false`/`null`은 원문 글자 그대로.
  `body_lines` 순서(목업 §3, GUI `StepRow` 펼친 내용과 같은 구분):
  1. `Title`: `{칸 제목} · {HH:MM:SS} · {no} {스텝 이름}`(`judge::format_hms`).
  2. `Summary`: `{METHOD} {URL}   →   {status}   {N ms}`(응답 없으면 ` → ` 뒤 생략)를 폭에 맞게 줄바꿈(URL 전체가 보이게).
  3. `Error`: `step.error`가 있으면(줄바꿈) + `timed_out`이면 `Note` `text::TIMED_OUT`.
  4. `Heading` `요청 헤더` + `Text` 줄들 — `  {이름}{채움}  {값}`(이름 칸 폭 = 가장 긴 이름, 최대 24). 헤더가 없으면 제목도 생략.
  5. 요청 본문이 비어 있지 않을 때만: `Heading` `요청 본문` → `reveal == false`면 `Note` `요청 본문은 가려져 있습니다`, `true`면 본문 `Text` 줄들(아래 본문 규칙). 어느 쪽이든 `clipped_req`면 `Note` `text::record_clipped(limit_kb)`.
  6. 응답이 있으면: `Heading` `응답 헤더` + 줄들, 응답 본문이 비어 있지 않으면 `Heading` `응답 본문` → (`clipped_resp`면 `Note` 잘림) → (`body_truncated`면 `Note` `text::RECORD_ENGINE_TRUNCATED`) → 본문 `Text` 줄들.
  7. URL·헤더 값 어디든 `••••`(U+2022×4)가 있으면 끝에 `Note` `인증 값은 ••••로 가렸습니다`(GUI `masked`).
  **본문 규칙**(사용자 확정 5): 잘렸거나(`clipped_*`·`body_truncated`) `pretty_json`이 `Raw`면 원문, `Json(p)`면 `p`, `TooLarge`면 원문 + 본문 앞에 `Note` `text::RECORD_TREE_TOO_LARGE`(GUI 안내문 그대로). 너무 깊은 중첩은 따로 알리지 않고 원문(파싱 실패와 구별하지 않는다). 본문 `Text`는 2칸 들여쓴다. 모든 `Text`·`Title`·`Summary`·`Error` 글자는 `\n`으로 나눈 뒤 `sanitize` → `wrap_width`.
- Produces (`view/inspect.rs`):
  ```rust
  pub fn body_height(area: Rect) -> usize;             // sub_layout(area).body.height
  /// `pos` = (보이는 마지막 줄 번호, 전체 줄 수)를 첫 줄 오른쪽 끝에 `text::line_pos`로(폭이 모자라면 통째 생략).
  pub fn render_body(f: &mut Frame, head: &HeaderView, lines: &[BodyLine], scroll: usize, keys: &[&str]);
  ```
  `Title`·`Heading` 굵게 + `C_TEXT`, `Note` `C_SLOW`, `Error` `C_FAIL`, `Text`·`Summary` 기본. 줄 위치 `{끝}/{전체}줄`은 body 첫 화면 줄의 오른쪽 끝(전체 줄 수 ≤ 높이면 생략).
  **Task 4에서 넘어온 일**: `render_record`·`render_errors`가 그리는 원격 문자열(사유·판정 상세·이름·URL·오류)에도 `sanitize`를 적용한다.

- 문구(`text.rs`):

  | 상수·함수 | 값 | 출처(`ko.monitor.*`) |
  |---|---|---|
  | `RECORD_REQ_HEADERS` / `RECORD_REQ_BODY` / `RECORD_RESP_HEADERS` / `RECORD_RESP_BODY` | `요청 헤더` / `요청 본문` / `응답 헤더` / `응답 본문` | `recordReqHeaders`·`recordReqBody`·`recordRespHeaders`·`recordRespBody` |
  | `RECORD_REQ_BODY_HIDDEN` | `요청 본문은 가려져 있습니다` | `recordReqBodyHidden` |
  | `record_clipped(kb)` | `기록 상한 {kb}KB에서 잘림` | `recordClipped` (spec §5.3-4의 "(N KB)" 표기보다 ko.ts가 우선) |
  | `RECORD_ENGINE_TRUNCATED` | `1 MiB에서 잘림 — 실제 응답은 더 큼` | `recordEngineTruncated` |
  | `RECORD_TREE_TOO_LARGE` | `64KB를 넘는 본문은 원문으로 표시합니다` | `recordTreeTooLarge` |
  | `RECORD_MASKED_HINT` | `인증 값은 ••••로 가렸습니다` | `recordMaskedHint` |
  | `MASK` | `••••` | 컨트롤러 `monitor/record.rs` `MASK`(값 복사 — 판정에만 쓴다) |
  | `line_pos(end, total)` | `{end}/{total}줄` | TUI 전용(목업) |

- [ ] **Step 1: 실패 테스트 작성**

```rust
#[test] fn sanitize_replaces_control_chars() {
    // Review Focus 1. "a\tb" → "a    b"; "a\rb" → "ab"; "x\x1b[31my" → "x�[31my"; "\u{7}" → "�"; "한글 OK" 불변
}
#[test] fn pretty_json_indents_objects_and_arrays() {
    // r#"{"error":"x","n":[1,2],"e":{},"a":[]}"# → Json("{\n  \"error\": \"x\",\n  \"n\": [\n    1,\n    2\n  ],\n  \"e\": {},\n  \"a\": []\n}")
}
#[test] fn pretty_json_preserves_tokens() {
    // Review Focus 8. r#"{"z":1.0,"a":1e3,"big":12345678901234567890,"s":"a{b,c}:\"d\" \\","k":null}"#
    // → Json(p): 키가 z, a, big, s, k 순서 그대로; p에서 문자열 밖 공백·줄바꿈을 뺀 글자열 == 원문에서 문자열 밖 공백을 뺀 글자열;
    //   "1.0"·"1e3"·"12345678901234567890"이 그대로 들어 있다; 문자열 `"a{b,c}:\"d\" \\"`가 한 글자도 안 바뀐다
    // 이미 들여쓴 JSON(공백·줄바꿈 포함)을 넣어도 같은 결과(멱등)
}
#[test] fn pretty_json_falls_back_to_raw() {
    // "plain text" → Raw; r#"{"a":"# (잘린 JSON) → Raw; "42"·r#""s""# (스칼라) → Raw; "" → Raw
    // "[".repeat(200) + &"]".repeat(200) (serde_json 재귀 상한 초과) → Raw, 패닉 없음
    // 65_537바이트짜리 r#"{"a":"xxxx…"}"# → TooLarge; 65_537바이트 평문 → Raw
}
#[test] fn clip_flags_by_trace_index() { /* [{0,Request},{2,Response}]: idx0 → (true,false); idx2 → (false,true); idx1 → (false,false) */ }
#[test] fn request_body_hidden_until_reveal() {
    // Review Focus 5. 요청 본문 "SECRET-PAYLOAD": reveal false → 어떤 줄에도 "SECRET" 없음 + Note "요청 본문은 가려져 있습니다"
    // reveal true → Text 줄에 "SECRET-PAYLOAD". 요청 본문이 None/""이면 "요청 본문" 제목 자체가 없다.
}
#[test] fn body_lines_sections_and_notes() {
    // 첫 줄 Title "주문 조회 · " + format_hms(at) + " · 3 주문 상세"; 둘째 Summary "GET http://h/orders/1042   →   503   781 ms"
    // 헤더 2개·응답 본문 "line1\nline2": Heading(요청 헤더) → Text("  accept         application/json" 꼴, 이름 칸 정렬) → Heading(응답 헤더) → Text → Heading(응답 본문) → Text×2
    // clipped_resp → "기록 상한 128KB에서 잘림"이 응답 본문 제목 바로 다음; body_truncated → "1 MiB에서 잘림 — 실제 응답은 더 큼"
    // clipped_req + reveal false → 가림 안내 뒤에 잘림 Note도 있다
    // Authorization 값 "Bearer ••••" → 마지막 줄 Note "인증 값은 ••••로 가렸습니다"; ••••가 없으면 그 Note 없음
    // error Some("boom") + timed_out → Error "boom", Note "시간 초과"; response None → 응답 구역 없음, Summary에 "→" 없음
}
#[test] fn body_lines_json_body_is_indented() {
    // 응답 본문 r#"{"error":"service_unavailable","trace_id":"9f"}"# → Text 줄들 == ["  {", "    \"error\": \"service_unavailable\",", "    \"trace_id\": \"9f\"", "  }"]
    // 같은 본문 + clipped_resp → 원문 한 줄(들여쓰기 안 함); 66KB JSON → Note "64KB를 넘는 본문은 원문으로 표시합니다" + 원문
    // 요청 본문 JSON + reveal true → 들여쓴 줄들
}
#[test] fn body_lines_wrap_wide_text() { /* 폭 10, 본문 한글 12자(24칸) → 여러 줄, 각 줄 표시 폭 ≤ 10; 폭 0 → 패닉 없음 */ }
#[test] fn body_lines_escape_sequence_is_inert() {
    // Review Focus 1. 응답 본문 "\x1b[2J\x1b[Hpwned" → 줄에 '\x1b' 없음. JSON 문자열 안의 실제 제어 바이트도 같다.
    // render_body로 TestBackend에 그려 버퍼 전체에 '\x1b' 없음.
}
#[test] fn body_state_caches_and_clamps() {
    // ensure(i, 40) 두 번 → 줄 수 같음; reveal 바꾸고 ensure → 줄 수 달라짐; 폭 바꾸면 다시 만든다
    // 30줄·height 10: scroll_by(+100) → 20; scroll_by(-100) → 0; scroll_to_end → 20; 줄 수 < height → 항상 0
    // BodyState::new(n): reveal false, scroll 0
}
#[test] fn render_body_scrolls_and_shows_position() {
    // 80×14, 40줄: 머리 줄 + scroll 0이면 Title 줄 보임 + 오른쪽 끝 "{끝}/40줄"; scroll 15면 16번째 줄이 body 맨 위;
    // 끝에서 둘째 줄 무입력 안내, 마지막 줄 = keys. 줄 수 ≤ 높이면 "줄" 위치 표시 없음
}
#[test] fn body_size_sweep_no_panic() { /* w 1..=50 × h 1..=12, scroll 0·중간·끝 */ }
// mirrored_text_exists_in_ko_ts 행 추가: recordReqHeaders·recordReqBody·recordRespHeaders·recordRespBody·recordReqBodyHidden·
//   recordEngineTruncated·recordTreeTooLarge·recordMaskedHint 값, "`기록 상한 ${kb}KB에서 잘림`"
```

- [ ] **Step 2: 실패 확인** — 컴파일 오류.
- [ ] **Step 3: 구현** — Interfaces·문구 표 그대로 + Task 3·4 그리기 함수에 `sanitize` 적용(그 두 화면에 제어 문자 단언 한 줄씩 추가: 사유 `"a\x1bb"` → 버퍼에 `\x1b` 없음). `pretty_json`은 `serde_json::Value`·`to_string_pretty`를 쓰지 않는다(키 순서 — 선행 결정 표).
- [ ] **Step 4: 통과 확인** — 공통 3명령. `overlay.rs`의 기존 `help_*` 테스트가 그대로 통과하는지(옮기기만 했는지) 확인. `pretty_json_preserves_tokens`가 공허하지 않은지 실증: 구현을 잠깐 `serde_json::to_string_pretty(&Value)`로 바꿔 RED(키 순서·`1.0`) 확인 → 되돌려 GREEN.
- [ ] **Step 5: 커밋** — `feat(tui): 요청·응답 본문 화면 — JSON 들여쓰기·요청 본문 기본 가림·잘림 표시`.

---

### Task 6: 칸 설정 보기 — 번호 목록(읽기 전용)

spec §5.4 + "1b 확정" 블록. 이 번호 목록을 슬라이스 2가 편집 메뉴로 쓴다 — 항목 순서·번호를 여기서 고정한다. **화면 배치는 목업 `docs/superpowers/specs/2026-11-10-tui-1b-mockups/01-screens.html` §4(칸 설정 보기)를 따른다(글자 배치 재량 범위 내) — 단 항목 이름·값 표기는 아래 표가 우선(목업과 다른 점은 plan 끝 절).**

**Files:**
- Create: `crates/tui/src/panel_settings.rs`, `crates/tui/src/view/settings.rs`, `crates/tui/tests/settings_test.rs`
- Modify: `crates/tui/src/lib.rs`, `crates/tui/src/view/mod.rs`, `crates/tui/src/text.rs`, `crates/tui/tests/judge_parity_test.rs`

**Interfaces:**
- Consumes: Task 2 `Names`, Task 3 `render_frame`·`HeaderView`, Task 5 `sanitize`·`wrap_width`.
- Consumes (`names.rs`, Task 2): `StepInfo{id, name, method, url}`·`Names::step_info(scenario_id, step_id) -> Option<(순번, &StepInfo)>` — `url`은 시나리오에 적힌 그대로(사용자 확정 4).
- Produces (`panel_settings.rs`):
  ```rust
  /// GUI `targetLabel`: body "$" → "본문", "$.a.b" → "a.b", "$['a b']" → "['a b']", 그 외 원문 / header → "헤더 {path}" / status → "상태코드" / body_text → "본문 전체".
  pub fn condition_target(c: &Condition) -> String;
  pub fn display_target(d: &DisplayItem) -> String;          // body/header/status 같은 규칙
  /// GUI `conditionSummary`: `{target} {기호}` + (one_of → ` {a, b}` / 값 필요 연산 → ` {value}`, 빈 값이면 ` ""`) + ` · {스텝 이름 또는 step_id}` + (ignore_case → ` · 대소문자 무시`) + (trim → ` · 앞뒤 공백 무시`).
  pub fn condition_summary(c: &Condition, step_name: Option<&str>) -> String;
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct SettingItem { pub label: &'static str, pub values: Vec<String> /* 1줄 이상 */, pub from_group: bool }
  /// 항상 12개, 아래 표 순서. 번호는 인덱스 + 1. `from_group` = 묶음 칸(`group_id` 있음)의 2·3·5번.
  pub fn settings_items(p: &PanelConfig, names: &Names) -> Vec<SettingItem>;
  /// 묶음 칸이면 `text::group_note(n)` — n = `board.groups`에서 그 묶음의 순번(1부터, GUI `groupTitle(n)`과 같은 번호). 묶음을 못 찾으면 번호 없이 `text::GROUP_NOTE_PLAIN`.
  pub fn group_note(board: &BoardConfig, p: &PanelConfig) -> Option<String>;
  /// `{번호 2칸 오른쪽 정렬}  {라벨, 가장 넓은 라벨 폭으로 채움}   {값}` 줄들(값이 여럿이면 둘째부터 값 칸에 맞춰 들여쓰기, 폭 넘으면 줄바꿈).
  /// `from_group` 항목은 첫 값 줄 끝에 `  (묶음)`. 값은 `sanitize`를 거친다.
  pub fn settings_lines(items: &[SettingItem], width: usize) -> Vec<String>;
  ```
  연산 기호(`ko.monitor.condOpLabel`): eq `=` · ne `≠` · exists `키 있음` · not_empty `값 있음` · contains `글자 포함` · gt `>` · lt `<` · gte `≥` · lte `≤` · one_of `∈`. 후보값 분해는 컨트롤러 `config::one_of_candidates`, 값 필요 여부는 `ConditionOp::needs_value`(둘 다 `pub`) 재사용.

  | # | 라벨(`ko.monitor.*` 값 그대로) | 값 |
  |---|---|---|
  | 1 | `제목`(`panelTitle`) | `title`, 비면 `(제목 없음)`(`noTitle`) |
  | 2 | `시나리오`(`scenario`) | `names.scenario_name` 또는 id |
  | 3 | `환경`(`environment`) | 없으면 `환경 없음`(`environmentNone`), 있으면 이름 또는 id |
  | 4 | `볼 스텝`(`stepPick`) | `step_id` 없으면 `시나리오 전체`(`wholeScenario`). 있으면 `{순번} {이름}  {METHOD} {URL}` — **URL은 시나리오에 적힌 그대로(`{{var}}`·`${ENV}` 미치환)**. 시나리오는 읽었는데 그 스텝이 없으면 `{id} ⚠ 스텝 없음`(`condStepGone`), 시나리오를 못 읽었으면 id만 |
  | 5 | `점검 주기(초)`(`interval`) | 숫자 |
  | 6 | `제한 시간(초)`(`timeout`) | 숫자 |
  | 7 | `표시할 응답 시간`(`latencySource`) | Total → `시나리오 전체`(`latencyTotal`). Step이 칸의 `step_id`와 같으면 `이 스텝`(TUI 전용), 다르면 이름 또는 id |
  | 8 | `응답속도 기준선`(`thresholds`) | 한 줄 `{ms} ms 이상 · {ms} ms 이상 …`(`thresholdMs`, 숫자는 `format_stat_num` 쉼표), 없으면 `없음` |
  | 9 | `막대 개수`(`barCount`) | 숫자 |
  | 10 | `그래프 최대 높이(ms)`(`graphMax`) | 숫자(`format_stat_num` 쉼표) |
  | 11 | `성공 조건`(`conditions`) | 줄마다 `condition_summary`, 없으면 `없음` |
  | 12 | `화면에 표시`(`displayTitle`) | 줄마다 `{① 큰 글자\|② 작은 줄} {display_target} · {스텝 이름 또는 id}`(`displayRank`), 없으면 `없음` |

- Produces (`view/settings.rs`):
  ```rust
  /// body에서 제목 줄 1 + (각주가 있으면) 각주 줄 1을 뺀 줄 수.
  pub fn settings_height(area: Rect, has_note: bool) -> usize;
  pub fn render_settings(f: &mut Frame, head: &HeaderView, title: &str, lines: &[String], note: Option<&str>, scroll: usize, keys: &[&str]);
  ```
  배치(목업 §4): body 1행 = `칸 설정 · {칸 제목}`(왼쪽) + `text::SETTINGS_READONLY`(오른쪽, C_MUTED — 폭이 모자라면 통째 생략), 그 아래 줄들(`scroll`부터), body 맨 아래 줄 = 각주(`note`, C_MUTED, `fit`).
- 문구(`text.rs`, TUI 전용): `SETTINGS_TITLE = "칸 설정"`, `SETTINGS_READONLY = "보기 전용 — 수정은 다음 버전"`(목업), `NONE = "없음"`, `THIS_STEP = "이 스텝"`(목업), `GROUP_MARK = "(묶음)"`, `group_note(n) = "(묶음) = 점검 묶음 {n}의 값 — 칸마다 따로 못 바꿉니다"`, `GROUP_NOTE_PLAIN = "(묶음) = 점검 묶음의 값 — 칸마다 따로 못 바꿉니다"`. 위 표의 라벨·값 문구는 ko.ts 값 그대로 상수로(`SET_*`).

- [ ] **Step 1: 실패 테스트 작성**

```rust
// tests/settings_test.rs — GUI ui/src/monitor/__tests__/conditions.test.ts `target_and_summary_labels`·`condition_summary_symbols_table`과 1:1
#[test] fn target_labels_match_gui() {
    // body "$.data.items[0].code" → "data.items[0].code"; "$.resultCode" → "resultCode"; "$" → "본문"; "$['a b']" → "['a b']"
    // header "X-A" → "헤더 X-A"; status → "상태코드"; body_text → "본문 전체"
}
#[test] fn condition_summary_matches_gui() {
    // (path "$.resultCode", eq, "0000", ignore_case) + "로그인" → "resultCode = 0000 · 로그인 · 대소문자 무시"
    // (path "$.a", exists) + "로그인" → "a 키 있음 · 로그인"; (path "$.a", eq, "") + None → `a = "" · {step_id}`
    // (path "$.a", eq, "v", trim) + "s" → "a = v · s · 앞뒤 공백 무시"
    // (path "$.n") ne 1 → "n ≠ 1 · 로그인"; gt → "n > 1 · 로그인"; one_of "0000, 0020" → "n ∈ {0000, 0020} · 로그인"
    // (나머지 기호 행은 conditions.test.ts `condition_summary_symbols_table`의 모든 expect를 그대로 옮긴다 — 구현 중 그 파일을 읽어 확정)
}
#[test] fn settings_items_fixed_twelve() {
    // 기본 PanelConfig + 빈 Names: 12개, 라벨 순서 == 위 표, [0].values == ["(제목 없음)"], [2] == ["환경 없음"],
    // [3] == ["시나리오 전체"], [6] == ["시나리오 전체"], [7]·[10]·[11] == ["없음"], [4] == ["10"], [5] == ["5"], [8] == ["60"], [9] == ["2,000"]
    // 전부 from_group == false
}
#[test] fn settings_items_resolve_names() {
    // Task 2 번들 Names: scenario_id "S1" → "중첩"; environment_id "E1" → "운영"; step_id A04 → 값이 "4 d  GET /d"로 시작
    // 없는 스텝 "01J00000000000000000000ZZZ" → "01J00000000000000000000ZZZ ⚠ 스텝 없음"; 시나리오 자체를 못 읽으면 경고 없이 id만
    // latency_source Step(A04) + step_id A04 → [6] == ["이 스텝"]; latency Step(A01)·step_id None → ["a"]
    // thresholds [(800,_),(1500,_)] → ["800 ms 이상 · 1,500 ms 이상"]
    // display_items 2개 → ["① 큰 글자 resultCode · d", "② 작은 줄 상태코드 · d"]
}
#[test] fn step_url_template_shown_as_written() {
    // 사용자 확정 4. 시나리오 YAML의 url "${BASE_URL}/orders/{{order_id}}" → names.step_info(..).1.url == 그 글자 그대로,
    // settings_items [3] 값에 "{{order_id}}"·"${BASE_URL}"이 글자 그대로 들어 있다
}
#[test] fn group_panel_marks_and_note() {
    // group_id Some("G2") 칸: [1]·[2]·[4].from_group == true, 나머지 false. settings_lines에서 그 세 항목 첫 줄이 "(묶음)"으로 끝난다
    // board.groups [G1, G2] → group_note == Some("(묶음) = 점검 묶음 2의 값 — 칸마다 따로 못 바꿉니다"); 묶음 목록에 없는 id → GROUP_NOTE_PLAIN
    // group_id None → group_note None, "(묶음)" 글자 없음
}
#[test] fn settings_lines_numbering_and_wrap() {
    // 폭 70: 첫 줄 " 1  제목" 꼴, "12  화면에 표시" 줄 존재, 값이 여럿인 항목은 둘째 줄이 값 칸에 맞춰 들여쓰기
    // 폭 20: 모든 줄 표시 폭 ≤ 20; 값에 '\x1b' → 줄에 없음
}
#[test] fn render_settings_shows_title_notice_keys() {
    // 100×20(목업 §4): 머리 줄, "칸 설정 · 주문 조회", "보기 전용 — 수정은 다음 버전", 각주 "(묶음) = 점검 묶음 1의 값",
    // 무입력 안내 줄, 마지막 줄 keys; scroll 3이면 넷째 줄부터. 폭 40 → "보기 전용" 통째 없음
}
#[test] fn settings_size_sweep_no_panic() { /* w 1..=50 × h 1..=12, 각주 있음/없음 */ }
// mirrored_text_exists_in_ko_ts 행 추가: panelTitle·stepPick·wholeScenario·environmentNone·interval·timeout·
//   latencySource·latencyTotal·thresholds·thresholdMs·barCount·graphMax·conditions·displayTitle·noTitle·condStepGone·condIgnoreCase·condTrim·
//   condTargetBodyRoot·condTargetStatus·condTargetBodyText 값, "`헤더 ${n}`", `displayRank: ["① 큰 글자", "② 작은 줄"]`, "`점검 묶음 ${n}`"
```

- [ ] **Step 2: 실패 확인** — 컴파일 오류.
- [ ] **Step 3: 구현** — Interfaces·표 그대로.
- [ ] **Step 4: 통과 확인** — 공통 3명령.
- [ ] **Step 5: 커밋** — `feat(tui): 칸 설정 보기(읽기 전용 번호 목록)`.

---

### Task 7: 앱 연결 — 화면 4개·키·기록 조회 태스크·5분 자동 복귀·키 줄·도움말 (US3)

spec §5.2(`e`·`Enter`·`Esc`), §5.3·§5.4 "1b 확정" 블록(지연 조회·`a`·`v`·`←→`·무입력 5분 복귀), §5.1 "키 안내 줄". Review Focus 2·5·9. **화면 배치·키 줄은 목업 `docs/superpowers/specs/2026-11-10-tui-1b-mockups/01-screens.html` §0(모니터 키 줄)과 §1–§4의 맨 아래 키 줄을 따른다(글자 배치 재량 범위 내 — 조각 순서는 아래 표가 우선).**

**Files:**
- Modify: `crates/tui/src/app.rs`, `crates/tui/src/text.rs`, `crates/tui/src/view/monitor.rs`, `crates/tui/src/view/overlay.rs`
- Test: `crates/tui/tests/app_test.rs`, `crates/tui/tests/view_test.rs`

**Interfaces:**
- Consumes: Task 1–6 전부.
- Produces (`app.rs`):
  ```rust
  pub enum Screen { /* 기존 */ Errors, Record, Body, Settings }      // 데이터 없는 변형 — 상태는 App 필드에(Screen은 Clone·Eq로 QuitConfirm에 담긴다)
  pub enum Action { /* 기존 */ OpenErrors, OpenSettings, Activate, ToggleAll, ToggleReveal, PrevStep, NextStep, Up, Down, PageUp, PageDown, Home, End }
  /// `Esc` 한 단계 뒤: Body → Record → Errors → Monitor, Settings → Monitor, Help → Monitor. 그 외 None.
  pub fn back_target(screen: &Screen) -> Option<Screen>;
  /// 새 화면 네 개의 키 줄 조각(앞 조각부터 통째로 빠진다 — 덜 중요한 것을 앞에). `has_req_body` = 본문 화면의 스텝에 요청 본문이 있는가.
  pub struct KeyCtx { pub quit_confirm: bool, pub show_all: bool, pub reveal: bool, pub has_req_body: bool }
  pub fn sub_keys(screen: &Screen, c: KeyCtx) -> Vec<&'static str>;
  /// 입력 없이 이만큼 지나면 모니터 화면으로.
  pub const IDLE_RETURN: std::time::Duration = std::time::Duration::from_secs(300);
  /// 새 화면 넷, 또는 그 넷을 감싼 종료 확인창일 때만 대상. `now - last_input >= IDLE_RETURN`이면 true.
  /// 도움말·모니터·모니터 위 종료 확인창·오류/사용법/시작 화면은 항상 false.
  pub fn idle_expired(screen: &Screen, last_input: std::time::Instant, now: std::time::Instant) -> bool;
  /// 태스크가 보내는 조회 결과.
  pub enum Fetched {
      Reason { board_id: String, panel_id: String, at_ms: i64, reason: Reason },
      Record { board_id: String, panel_id: String, at_ms: i64, load: RecordLoad },
  }
  /// 현재 보고 있는 칸·회차의 것만 받아들인다. 받아들였으면 true.
  pub fn accept_fetched(errors: Option<&mut ErrorsState>, record: Option<&mut RecordState>, msg: Fetched) -> bool;
  /// 새 화면 상태 묶음 — 자동 복귀·재시도·보드 전환이 한 번에 비운다(테스트 가능하게 App 밖 구조체로).
  #[derive(Debug, Default)]
  pub struct SubViews { pub errors: Option<ErrorsState>, pub record: Option<RecordState>, pub body: Option<BodyState>, pub settings_scroll: usize }
  impl SubViews { pub fn clear(&mut self); }
  ```
- 키(`handle_key`):

  | 화면 | 키 → Action |
  |---|---|
  | Monitor | (기존) + `e` → `OpenErrors`, `Enter` → `OpenSettings` |
  | Errors | `↑`/`k` Up · `↓`/`j` Down · `PgUp` · `PgDn` · `Home` · `End` · `a` → `ToggleAll` · `Enter` → `Activate` · `Esc` → `Back` · `q`/`Ctrl+C` → `AskQuit` |
  | Record | `↑`/`k` · `↓`/`j` · `PgUp` · `PgDn` · `Home` · `End` · `Enter` → `Activate` · `Esc` · `q` |
  | Body | `↑`/`k` · `↓`/`j` · `PgUp` · `PgDn` · `Home` · `End` · `←`/`h` → `PrevStep` · `→`/`l` → `NextStep` · `v` → `ToggleReveal` · `Esc` · `q` |
  | Settings | `↑`/`k` · `↓`/`j` · `PgUp` · `PgDn` · `Home` · `End` · `Esc` · `q` (숫자 키는 1b에서 무동작) |

  `normalize_char`에 `'ㄷ' => 'e'`, `'ㅁ' => 'a'`, `'ㅍ' => 'v'` 추가. **접어 넣는 연기 항목(§B46 (2) "`Ctrl`+`B`도 테두리 전환")**: `Ctrl`이 눌린 문자 키는 `Ctrl+C`만 빼고 전부 `Action::None`(`handle_key` 앞머리에서 한 번에 — 기존 `b`·새 `e`/`a`/`v` 모두).
- App 동작:
  - 새 필드: `views: SubViews`, `fetch_tx: std::sync::mpsc::Sender<Fetched>`, `fetch_rx: Receiver<Fetched>`, `size: Rect`(이벤트 루프가 매 반복 `term.size()`로 갱신), `last_input: Instant`.
  - `OpenErrors`·`OpenSettings`는 `toggle_allowed(&screen, panels_drawn)`일 때만(칸이 안 그려진 작은 화면에서 어느 칸인지 모르는 채 열리지 않게 — 그 함수 문서 주석을 "칸 대상 동작(테두리·오류 보기·칸 설정)"으로 고친다). `OpenErrors` → `ErrorsState{board_id, panel_id, ..Default}` 새로 만들고 `Screen::Errors`. `OpenSettings` → `settings_scroll = 0`, `Screen::Settings`.
  - Errors `Activate`: 커서 줄의 `CheckResult`를 `clicked`로 `RecordState{load: Loading, cursor: 0}` 만들고 기록 조회 태스크를 띄운 뒤 `Screen::Record`(정상 회차도 열 수 있다 — 목업 §1). 빈 목록이면 무동작. Record `Activate`: `Loaded`이고 커서 줄이 `StepLine::Http`면 `BodyState::new(커서 줄 번호)`, `Screen::Body`. `If` 줄·미로딩이면 무동작.
  - Body `PrevStep`/`NextStep`(사용자 확정 6): `neighbor_http(lines, body.line_idx, ∓1)`이 `Some(n)`이면 `body = BodyState::new(n)`(가림·스크롤 초기화) + `record.cursor = n`(상세로 돌아가면 그 줄), `None`이면 무동작.
  - `Back`: `QuitConfirm`은 기존대로, 그 외 `back_target`. Body를 나가면 `body = None`(가림 초기화 — Review Focus 5), Record를 나가면 `record = None`, Errors·Settings를 나가면 `errors = None`.
  - `start_session`(재시도)·보드 전환은 `views.clear()`.
  - **무입력 5분 복귀**(사용자 확정 2): 이벤트 루프가 키·마우스 이벤트를 받을 때마다 `last_input = Instant::now()`(크기 변경 이벤트는 입력으로 치지 않는다). 매 반복 `idle_expired(&screen, last_input, Instant::now())`면 `screen = Screen::Monitor` + `views.clear()` + 다시 그리기. 종료 확인창이 새 화면을 감싸고 있어도 같은 길로 모니터로 간다(확인창도 닫힘 = 취소). 도움말과 모니터 위 확인창은 1a 그대로 둔다.
  - 조회 태스크: `rt.spawn(async move { for at in list { let r = api.record(&board, &panel, at).await; if tx.send(Fetched::Reason{.., reason: reason_of(r)}).is_err() { return; } } })` — 순서대로 하나씩(동시에 여러 기록을 메모리에 들지 않는다). 상세용은 `load_of`.
  - `pump(&mut self) -> bool`(이벤트 루프가 그리기 전에 부른다, 바뀐 것이 있으면 true → 다시 그리기): ① `fetch_rx.try_recv()`를 빌 때까지 `accept_fetched` ② `Screen::Errors`(또는 그것을 감싼 `QuitConfirm`)면 현재 스냅샷의 그 칸 결과로 `cache.retain(살아 있는 at_ms)` → `visible_results(.., errors_list_height(size))` → `cache.wanted` → 비어 있지 않으면 `mark_loading` + 태스크 ③ `Record`가 `Loaded`로 막 바뀌었으면 `cursor = initial_step_cursor(..)` ④ `Screen::Body`면 `body.ensure(.., sub_layout(size).body.width)`.
  - 그 칸의 결과 = `snap_rx.borrow()`의 `last`에서 `board_id`가 맞을 때 `panels[panel_id].results`, 아니면 빈 목록. 머리 줄 = `monitor_screen()`의 `header()`(끊김 표시 포함 — 새 화면에서도 보드 상태가 보인다).
  - 그리기: `Screen::Errors` → `render_errors(f, &head, &errors_view(&ErrorsInput{칸 제목, 결과, &panel.thresholds, panel.interval_seconds}, st, errors_list_height(area)), &keys)`; `Record` → `render_record(f, &head, &record_view(panel, st, &session.names), &keys)`; `Body` → `render_body(f, &head, body.lines(), body.scroll, &keys)`; `Settings` → `render_settings(f, &head, 칸 제목, &settings_lines(&settings_items(panel, &session.names), 폭), group_note(&board.config, panel).as_deref(), settings_scroll, &keys)`. `QuitConfirm(inner)`가 새 화면을 감싸면 `KeyCtx.quit_confirm = true`(= `[KEYS_CONFIRM_YES, KEYS_CONFIRM_CANCEL]`).
  - 이동량: Errors `Up`/`Down` = `move_cursor(±1)`, `PageUp`/`PageDown` = `±errors_list_height`, `Home`/`End` = 처음/끝. Record는 `cursor`를 `0..len`에 가둔 ±1/±10. Body는 `scroll_by(±1 / ±body_height)`·`Home` → 0·`End` → `scroll_to_end`. Settings는 `settings_scroll`을 `0..=줄 수 − settings_height`에 가둔다.
- 문구(`text.rs`, TUI 전용 — 목업 키 줄 글자):

  | 상수 | 값 |
  |---|---|
  | `KEYS_ERRORS` / `KEYS_SETTINGS` | `e 오류 보기` / `Enter 칸 설정` |
  | `KEYS_PICK` / `KEYS_PICK_STEP` | `↑↓ 고르기` / `↑↓ 스텝 고르기` |
  | `KEYS_SCROLL` / `KEYS_SCROLL_SHORT` | `↑↓ PgUp PgDn 스크롤` / `↑↓ 스크롤` |
  | `KEYS_ALL_ON` / `KEYS_ALL_OFF` | `a 전체 회차` / `a 실패만` |
  | `KEYS_DETAIL` / `KEYS_BODY` | `Enter 자세히` / `Enter 요청·응답 보기` |
  | `KEYS_STEP_NAV` | `←→ 이전·다음 스텝` |
  | `KEYS_REVEAL` / `KEYS_HIDE` | `v 요청 본문 보기` / `v 가리기` |
  | `KEYS_TO_MONITOR` / `KEYS_TO_LIST` / `KEYS_TO_DETAIL` | `Esc 모니터로` / `Esc 목록으로` / `Esc 자세히로` |
  | `HELP_KEYS` 추가 2줄(`b` 줄 앞, 배열 길이 8 → 10) | `("e", "선택 칸 오류 보기(실패 목록 → 자세히 → 요청·응답)")`, `("Enter", "선택 칸 설정 보기")` |
  | `HELP_IDLE` | `오류 보기·칸 설정 화면은 5분 동안 입력이 없으면 모니터로 돌아갑니다` |

  **모니터 키 줄**(`render_with_keys` `KeyBar::Monitor`): 조각 순서 `b 테두리 · [Tab 다음 보드] · ←↑↓→ 칸 이동 · e 오류 보기 · Enter 칸 설정 · ? 도움말 · q 종료`. 1a `key_bar`는 **앞 조각부터** 통째로 빼므로, 목업 §0의 "좁으면 덜 중요한 키(b·Tab)부터 뺀다"를 지키려면 `b`·`Tab`이 앞에 와야 한다(목업 그림의 글자 순서와 다르다 — plan 끝 "목업과 다른 점").
  **`sub_keys`**(뒤로 갈수록 오래 남는다): Errors `[↑↓ 고르기, a 전체 회차|a 실패만, Enter 자세히, Esc 모니터로]` · Record `[↑↓ 스텝 고르기, Enter 요청·응답 보기, Esc 목록으로]` · Body `[↑↓ PgUp PgDn 스크롤, ←→ 이전·다음 스텝, (요청 본문이 있을 때만) v 요청 본문 보기|v 가리기, Esc 자세히로]` · Settings `[↑↓ 스크롤, Esc 모니터로]`. 목업처럼 새 화면 키 줄에는 `q 종료`를 쓰지 않는다(`q`는 동작하고 도움말에 있다).
  **도움말**(`overlay.rs` `render_help`): 고정 줄(`fixed`)에 `text::HELP_IDLE`을 `HELP_COPY` 앞에 더한다(높이가 모자라면 기존 규칙대로 키 줄 → 뒤쪽 고정 줄 순으로 빠진다).

- [ ] **Step 1: 실패 테스트 작성**

```rust
// tests/app_test.rs
#[test] fn monitor_e_and_enter_open_views() {
    // handle_key(Monitor,'e') == OpenErrors; 'ㄷ' == OpenErrors; 'E' == OpenErrors; Enter == OpenSettings
    // Help·Error·Usage에서 'e'·Enter → OpenErrors/OpenSettings 아님
}
#[test] fn sub_screen_keys() {
    // Errors: Up/'k' → Up, Down/'j' → Down, PageUp, PageDown, Home, End, 'a'/'ㅁ' → ToggleAll, Enter → Activate, Esc → Back, 'q' → AskQuit
    // Record: 'a' → None, Enter → Activate, Left/Right → None
    // Body: 'v'/'ㅍ' → ToggleReveal, Left/'h' → PrevStep, Right/'l' → NextStep, Enter → None
    // Settings: Enter·'1' → None, Esc → Back. 새 화면 넷 모두 Tab·'b'·'?' → None
}
#[test] fn ctrl_modified_letters_are_ignored() {
    // §B46 (2) 접어 넣기: Monitor에서 Ctrl+B·Ctrl+E → None, Errors에서 Ctrl+A → None, Body에서 Ctrl+V → None; Ctrl+C는 여전히 AskQuit
}
#[test] fn back_target_chain() { /* Body→Record→Errors→Monitor; Settings→Monitor; Help→Monitor; Monitor·Starting·Usage → None */ }
#[test] fn sub_keys_per_screen() {
    // §B45 (2) "화면→키 줄 매핑 테스트 없음" 보강(목업 키 줄).
    // Errors == ["↑↓ 고르기","a 전체 회차","Enter 자세히","Esc 모니터로"]; show_all → "a 실패만"
    // Record == ["↑↓ 스텝 고르기","Enter 요청·응답 보기","Esc 목록으로"]
    // Body(has_req_body false) == ["↑↓ PgUp PgDn 스크롤","←→ 이전·다음 스텝","Esc 자세히로"]; has_req_body → "v 요청 본문 보기" 포함, reveal → "v 가리기"
    // Settings == ["↑↓ 스크롤","Esc 모니터로"]; quit_confirm=true → 네 화면 모두 ["y 종료","다른 키 취소"]
}
#[test] fn idle_expired_rules() {
    // Review Focus 9(실제 시간 없이). t0 = Instant::now(), 판정 시각은 t0 + Duration으로 만든다.
    // Errors·Record·Body·Settings: t0 + 299 s → false; t0 + 300 s → true
    // QuitConfirm(Box(Errors)): 300 s → true. QuitConfirm(Box(Monitor))·Help·Monitor·Starting·Usage·Error(_): 1시간 뒤에도 false
    // last_input이 now보다 뒤(시계 역전)여도 패닉 없이 false
}
#[test] fn idle_return_clears_views() {
    // SubViews{errors: Some, record: Some, body: Some(BodyState{reveal: true, ..}), settings_scroll: 7}.clear()
    // → 전부 None·0 — 다시 열면 BodyState::new라 요청 본문이 다시 가려진다(Review Focus 5)
}
#[test] fn fetched_for_other_panel_is_dropped() {
    // Review Focus 2. ErrorsState{board "B", panel "P1"}: Reason{board "B", panel "P2", ..} → false, 캐시 불변
    // Reason{"B","P1", at 5, Gone} → true, cache에 Gone. RecordState{at_ms: 7}: Record{.., at_ms: 8, ..} → false; at_ms 7 → true, load 교체
    // errors None(화면을 이미 나감) → false
}
#[test] fn leaving_body_resets_reveal() {
    // Review Focus 5. BodyState::new(n)은 항상 reveal false·scroll 0 — Esc로 나갔다 다시 들어올 때, ←/→로 옆 스텝에 갈 때 모두 new를 쓴다.
}
// tests/view_test.rs — 기존 키 줄 단언 5곳(grep -n "b 테두리" 결과 425·443·1227·2453·2461행)을 새 조각 순서로 갱신
#[test] fn key_bar_has_errors_and_settings_keys() {
    // 100열·보드 1개: "b 테두리  ←↑↓→ 칸 이동  e 오류 보기  Enter 칸 설정  ? 도움말  q 종료"
    // 80열·보드 2개(전체 84칸이라 안 들어감): 맨 앞 "b 테두리"만 통째로 빠지고 "Tab 다음 보드  ←↑↓→ 칸 이동  e 오류 보기 …"
    // 60열·보드 2개: "b 테두리"·"Tab 다음 보드"가 빠지고 "←↑↓→ 칸 이동  e 오류 보기  Enter 칸 설정  ? 도움말  q 종료"는 남는다
}
#[test] fn help_lists_new_keys_and_idle_rule() {
    // 도움말(80×30)에 "선택 칸 오류 보기", "선택 칸 설정 보기", "5분 동안 입력이 없으면 모니터로 돌아갑니다"; HELP_KEYS.len() == 10
}
```

**접어 넣는 연기 항목(§B45 (2)·§B46 (2) 신호 테스트 flake)**: `app_test.rs`의 `termination_signals_set_quit_flag`·`watchdog_fires_when_main_does_not_exit`가 전역 신호 처리기를 같은 프로세스에서 나눠 쓴다 — 파일 맨 위에 `static SIGNAL_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());`를 두고 두 테스트 첫 줄에서 `let _serial = SIGNAL_TESTS.lock().unwrap_or_else(|e| e.into_inner());`. **이 완화는 효과를 실증할 수 없다**(이 plan 저작 시 `cargo test -p handicap-tui --test app_test` 25회 중 0회 실패 — 사실 근거 C12). 따라서 roadmap의 그 항목을 "해소"로 표시하지 **않는다**(Task 8이 "직렬화 넣음, CI 재발 여부 관찰"로만 적는다).

- [ ] **Step 2: 실패 확인** — 컴파일 오류(새 `Action`·`back_target`·`idle_expired` 없음).
- [ ] **Step 3: 구현** — Interfaces·표 그대로. `event_loop`: 매 반복 `app.size = term.size()` → 무입력 판정 → `if app.pump() { dirty = true; }` → 기존 그리기 조건. `help_*`·`render_help_has_paths` 등 도움말 높이 테스트가 줄 수 증가로 깨지면 **줄 빼기 규칙 단언은 유지**하고 기대 줄만 갱신.
- [ ] **Step 4: 통과 확인** — 공통 3명령 + `TZ=UTC cargo test -p handicap-tui`.
- [ ] **Step 5: 커밋** — `feat(tui): e 오류 보기·Enter 칸 설정 — 화면 연결·기록 지연 조회·5분 자동 복귀`.

---

### Task 8: 문서 — 매뉴얼·spec 확정 표시

**Files:**
- Modify: `docs/dev/tui-monitor.md`, `docs/superpowers/specs/2026-11-07-tui-monitor-design.md`

- [ ] **Step 1: 매뉴얼 §3 키 표**에 행 추가: `e`(선택 칸 오류 보기 — 목록에서 `↑↓`·`a` 전체 회차/실패만·`Enter` 자세히·`Esc` 뒤로), `Enter`(선택 칸 설정 보기 — 읽기 전용, 수정은 다음 버전), 자세히 화면 `Enter`(그 스텝의 요청·응답), 본문 화면 `↑↓`·`PgUp`/`PgDn`·`Home`/`End`·`←`/`→`(이전·다음 스텝)·`v`(요청 본문 보기/가리기). 표 아래 한 줄: **"오류 보기·칸 설정 화면은 5분 동안 입력이 없으면 모니터로 돌아갑니다"**(화면 키 줄 위와 도움말에도 같은 문장). `Esc` 행을 "한 단계 뒤로(본문 → 상세 → 목록 → 모니터)"로.
- [ ] **Step 2: 매뉴얼 새 절 "오류 보기"**(§4 "화면 읽는 법" 뒤): ① 목록은 그 칸의 막대 구간 안 회차만 — 기록도 막대 개수만큼만 보관되어 그보다 오래된 회차는 `기록 지남` ② 사유는 보이는 줄만 그때그때 불러온다(`불러오는 중…`) ③ 요청 본문은 기본 가림(`v`), 인증 값은 `••••` ④ JSON 본문은 들여써서 보여 주고(64KB 초과·잘린 본문·JSON이 아닌 본문은 원문), `기록 상한 NKB에서 잘림`은 보드의 점검 기록 상한 ⑤ TUI를 다시 띄우면 기록은 비워진다 ⑥ 자리를 비워도 5분 뒤 모니터 화면으로 돌아가므로 벽 화면이 목록에 멈춰 있지 않는다(요청 본문도 다시 가려진다) ⑦ 칸 설정 보기의 URL은 시나리오에 적힌 그대로(`{{변수}}` 미치환) — 실제 값은 오류 보기의 요청·응답에서. §9 "보안 전제"에 한 줄: "오류 보기의 요청·응답은 화면에만 그리고 파일·로그에 남기지 않는다. 화면을 볼 수 있는 사람은 응답 본문(업무 데이터)을 볼 수 있다."
- [ ] **Step 3: spec** — 5행 상태 줄을 "1a 완료 … **1b 구현**(plan `docs/superpowers/plans/2026-11-10-tui-monitor-1b.md`), 2 미착수"로(코드 범위·날짜는 `/finish-slice`가 채운다). §5.3 "이름 해석" 끝 문장 뒤에 "→ 1b 계획 확정: 공개된 엔진 대응 함수 없음(`reqgen::collect_http` 비공개·컨트롤러 `collect_http_steps` `pub(crate)`), TUI `names.rs`에 같은 순서로 이식." §5.3-4의 `"기록 상한(N KB)에서 잘림"` 옆에 "(화면 문구는 `ko.monitor.recordClipped` 그대로 `기록 상한 NKB에서 잘림`)". (§5.3·§5.4의 "1b 확정" 블록은 plan 저작 때 이미 넣었다 — 구현이 그 블록과 달라졌으면 여기서 고친다.)
- [ ] **Step 4: 커밋** — docs-only. `docs(tui): 1b 오류 보기·칸 설정 보기 매뉴얼·spec 확정 표시`.

roadmap·build-log·root 상태 줄·`crates/tui/CLAUDE.md` 새 함정은 `/finish-slice`가 한다(이 plan의 task 아님). 그때 §B45 (2)·§B46 (2)에 아래 "연기 항목 처리" 표를 반영한다.

---

## 라이브 검증 (파이프라인 5단계 — 이 plan의 task 아님, 머지 전 필수)

spec §8 라이브 항 + `crates/tui/CLAUDE.md` tmux 함정. 워크트리 자체 바이너리(`cargo build -p handicap-tui` → `./target/debug/handicap-tui <번들>`), `XDG_CONFIG_HOME`·`XDG_STATE_HOME`은 scratchpad로 격리. tmux는 python 드라이버(`subprocess.run(["tmux", …])`)로: `new-session -d -x W -y H` → `send-keys` → `capture-pane -p`(색은 `-e`). 하네스는 1a/readability build-log를 보고 다시 만든다.

- **응답기**(python `http.server`, `request_queue_size` 키움): `/ok` 200 JSON · `/fail` 503 · `/toggle`(파일 플래그로 200↔503) · `/big`(본문 300KB — 잘림 확인) · `/esc`(본문에 `\x1b[2J\x1b[31m` 포함) · `/slow`(칸 제한 시간보다 길게 — 바깥 시간 초과) · `/code`(본문 `{"resultCode":"0020"}`).
- **번들**(안 쓰는 시나리오 금지): 보드 1 = ① `/toggle` 칸(헤더 `Authorization: Bearer abc`, POST 본문 `{"pw":"SECRET"}`) ② 조건 칸(`/code`, 조건 `resultCode = 0000` → 판정 상세) ③ 스텝 칸(loop 2회 안 스텝을 보는 묶음 칸) ④ `if` 분기 시나리오 칸 ⑤ `/big` 칸(`record_limit_kb` 16) ⑥ `/esc` 칸 ⑦ `/slow` 칸 ⑧ 없는 환경 변수 URL 칸(설정 오류). `bar_count` 10·`interval_seconds` 1인 칸 하나(밀려남 확인용).

| US | 절차 | 통과 신호 |
|---|---|---|
| US3-목록 | ① 칸 선택 → `/toggle`을 503으로 10초 → 200으로 → `e` | 모니터와 같은 머리 줄. 최신 순 실패 줄: 시각(`date +%T`로 적어 둔 구간과 일치)·`✖ 실패`·`HTTP 503…`, 오른쪽 `실패 N회 · 최근 M회(약 X분) 중`. 예전 줄이 `불러오는 중…` → 사유로 바뀜. 열어 둔 채 새 실패가 생기면 위에 줄이 늘고 `▶`는 같은 시각 줄에 머문다. `a` → 정상 줄(`612 ms` 꼴 응답 시간)도 보이고 개수 표기가 `전체 M회`로 |
| US3-사유·판정값 | ② 조건 칸 → `e` → 줄 선택 → `Enter` | 자세히 화면에 `사유` + `판정 상세  …0020…` + `시나리오`·`환경` 이름(목록에는 판정 상세 줄이 없다) |
| US3-한 단계 더 | 자세히에서 `Enter`, 이어서 `→`·`←` | 요청 헤더·응답 헤더·응답 본문(JSON은 들여쓴 여러 줄, 키 순서가 응답기가 보낸 순서 그대로). `→`/`←`로 자세히로 안 돌아가고 옆 스텝(분기 줄은 건너뜀), 양 끝에서는 그대로. `Authorization` 값 `Bearer ••••` + `인증 값은 ••••로 가렸습니다`. 요청 본문은 `요청 본문은 가려져 있습니다` → `v` → `{"pw":"SECRET"}` → `Esc` 후 다시 `Enter` → 다시 가려짐 |
| 이름 해석 | ③ 스텝 칸·④ 분기 칸 상세 | 스텝 이름이 ULID가 아니라 시나리오의 이름, loop 행 `#0`·`#1`, 스텝 칸은 **마지막** 반복 행에 `◀ 이 칸` + 처음부터 그 줄이 선택, `조건 분기 → then`(또는 `(미매치)`) |
| 특수 기록 | ⑦·⑧ 칸 상세, ⑤ 칸 본문 | ⑦ `응답이 오기 전에 시간 초과 — 요청·응답 기록 없음` · ⑧ `요청을 보내기 전에 멈췄습니다(설정 오류) — …` · ⑤ `기록 상한 16KB에서 잘림` |
| 지난 기록 | `bar_count` 10 칸에서 `e` → 맨 아래 줄에 커서 → 15초 대기 → `Enter` | 커서가 같은 회차를 따라가다 밀려나면 다음 줄로. 밀려난 회차 자세히는 `이 점검의 기록이 없습니다 — …` (목록 줄이 잠깐 `기록 지남`으로 보이는 경우 포함) |
| 칸 설정 | 모니터에서 `Enter`(단독 칸·묶음 칸 각각) | ` 1  제목` … `12  화면에 표시` 12항목, 시나리오·환경·스텝이 이름으로, `볼 스텝`의 URL에 `{{변수}}`·`${ENV}`가 **적힌 그대로**, `보기 전용 — 수정은 다음 버전`. 묶음 칸은 2·3·5번에 `(묶음)` + 맨 아래 각주 |
| 5분 자동 복귀 | 새 화면 넷 각각에서 키를 누르지 않고 5분 5초 대기(요청 본문은 `v`로 보이게 해 둔 채) | 화면에 `5분 동안 입력이 없으면 모니터로 돌아갑니다` 줄이 보였고, 5분 뒤 모니터 화면. 다시 `e` → `Enter` → `Enter`하면 요청 본문이 가려져 있다. 4분 50초에 `↓` 한 번 누르면 그때부터 다시 5분. 도움말(`?`)·모니터 위 종료 확인창은 5분이 지나도 그대로 |
| 키 줄·도움말 | 모니터 80×24 / 120×30, `?` | 키 줄에 `e 오류 보기`·`Enter 칸 설정`, 도움말 2줄 |

**극단값(전부 캡처)**: 응답기 `/deep`(1,000겹 중첩 배열)·`/big`의 66KB JSON → 패닉 없이 원문(+`64KB를 넘는 본문은 원문으로 표시합니다`) · 숫자 `1.0`·`1e3`·20자리 정수와 키 순서 `z,a,m`인 JSON이 들여쓴 뒤에도 그대로 · 종료 확인창을 오류 보기 위에 띄운 채 5분 → 모니터 화면 · 100×9(높이 10 미만)와 40×24(폭 부족)에서 무입력 안내 줄이 통째로 없고 잘린 글자가 없다 · ⑥ `/esc` 칸 본문 화면에서 터미널이 지워지거나 색이 번지지 않는다(`capture-pane -e`에 응답 유래 제어열 없음) · 본문 300KB에서 `PgDn` 연타·`End`가 즉시 반응 · 새 화면 넷을 `resize-window`로 80×24 → 40×10 → 20×5 → 120×40(패닉·겹침 없음, 키 줄 통째 줄임) · 오류 보기 중 컨트롤러 정지 불가이므로 대신 in-process REST로 보드 `stop`(`tui.log`의 `rest=` 포트 → `POST /api/monitor-boards/{id}/stop`) 후 `e` → 줄은 남고 사유 칸은 `기록 지남`(꺼진 보드는 404) · 오류 보기에서 `q` → 확인창 → 다른 키 → 같은 화면 복귀 · 한글 2벌식 `ㄷ`·`ㅁ`·`ㅍ` · 종료 후 `tui.log`에 URL·헤더·본문 글자 없음(`grep -c "SECRET\|Bearer" tui.log` = 0) · 9칸 보드·보드 2개에서 `Tab` 뒤 `e`가 새 보드의 칸을 연다.

**보안 게이트**: 기록 뷰어(trace/body)를 더하므로 `finish-slice` §0 grep이 매치할 것으로 예상 — `security-reviewer` APPROVE 필수(예상이 아니라 grep 결과가 지배).

---

## 목업과 다른 점 (의도적 — 코드·기존 규칙이 근거)

| 목업 | 이 plan | 이유 |
|---|---|---|
| §0 모니터 키 줄 글자 순서 `칸 이동 · e · Enter · Tab · ? · q`, `b 테두리` 없음 | `b 테두리 · Tab · 칸 이동 · e · Enter · ? · q` | `b` 키는 그대로 있어야 하고(tui-readability), 1a `key_bar`는 **앞 조각부터** 뺀다 — 목업의 "좁으면 b·Tab부터 뺀다"를 지키려면 그 둘이 앞에 와야 한다. 빼는 규칙을 우선순위 방식으로 바꾸는 것은 범위 밖 |
| §4 항목 이름 `점검 주기`·`제한 시간`·`그래프 최대 높이`·`화면 표시 값`, 값 `5초`·`2,000 ms` | ko.ts 값 그대로 `점검 주기(초)`·`제한 시간(초)`·`그래프 최대 높이(ms)`·`화면에 표시`, 값은 숫자만 | 목업 설명도 "항목 이름은 GUI 칸 편집기와 같은 말" — 실제 ko.ts 값은 단위가 이름에 들어 있다(C11). 단위를 값에도 쓰면 `점검 주기(초) 5초`로 겹친다 |
| §4 각주 `점검 묶음 "주문 흐름 묶음"의 값` | `점검 묶음 {n}의 값` | 묶음에는 이름 필드가 없다(`CheckGroup{id, scenario_id, environment_id, interval_seconds}`). GUI도 `점검 묶음 N`으로 부른다(C20) |
| §4 조건 줄 `status = "OK"`, 표시 값 `재고  stock.count` | GUI `conditionSummary`·표시 항목 줄 그대로(`… · {스텝 이름}`, `① 큰 글자 …`) | GUI와 같은 문구(반목표 "GUI와 다른 문구"), 표시 항목에는 이름 필드가 없다 |
| §2 "반복 안의 스텝은 #2처럼 회차 표시" | `#{loop_index}` 엔진 값 그대로(0부터) | GUI 기록 창이 `#${step.loop_index}`를 그대로 쓴다(C9) — 같은 기록을 두 화면에서 다른 번호로 보이지 않게 |
| §3 `기록 상한 …에서 잘림`이 제목 줄 오른쪽, `12/40줄`이 가림 안내와 같은 줄 | 잘림 안내는 제목 바로 아래 한 줄, 줄 위치는 화면 첫 줄 오른쪽 끝 | 본문은 스크롤되는 한 덩어리 줄 목록이라 "제목 줄 오른쪽"을 넣으면 줄바꿈 계산이 갈린다. 내용은 같다(글자 배치 재량) |
| §3 작은 그림의 키 줄 `v 요청 본문 보기`가 맨 앞 | `v …`는 `Esc` 바로 앞 | 앞 조각부터 빠지므로 `v`(가림 풀기)가 스크롤 안내보다 오래 남게 |
| §1 `a` 뒤 키 줄만 `↑↓ PgUp PgDn 고르기` | 두 경우 모두 `↑↓ 고르기` | 같은 화면의 같은 키를 두 가지로 쓰지 않는다(PgUp/PgDn은 둘 다 동작) |
| 목업에 없음 | 키 줄 위 `5분 동안 입력이 없으면 모니터로 돌아갑니다` 한 줄, 자세히 화면 높이가 모자랄 때 줄 빼는 순서, 너무 깊은 JSON은 안내 없이 원문 | 사용자 추가 요구(B) / 목업이 정하지 않은 부분 |

---

## 연기 항목 처리 (roadmap §B45 (2)·§B46 (2) — 재개 신호 "1b에서 그 파일을 만질 때")

| 항목 | 처리 | 이유 |
|---|---|---|
| `io_kind` 테스트 클라이언트 `.no_proxy()` 없음 | **접음**(Task 1) | `api.rs` 편집, 1줄 |
| `reason_parts` 멀티바이트 needle 테스트 | **접음**(Task 3) | `judge_parity_test.rs` 편집, 테스트 1개 |
| `text_labels_match_ko`가 ko.ts 아닌 리터럴 대조 | **부분 접음**(Task 3–6 `mirrored_text_exists_in_ko_ts` — 1b 새 문구만 ko.ts 파일 대조) | 기존 1a 문구까지 옮기는 것은 범위 밖 |
| `App::draw_with` 화면→키 줄 매핑 테스트 없음 | **부분 접음**(Task 7 `sub_keys_per_screen` — 새 화면 넷) | 모니터·도움말 매핑은 그대로 `render_with_keys` 안 |
| `Ctrl`+`B`도 테두리 전환 | **접음**(Task 7) | 같은 `handle_key`에 새 문자 키 3개를 더하므로 같이 막는다 |
| 신호 테스트 2개 전역 처리기 공유 flake(`app_test.rs`) | **완화만**(Task 7 Mutex 직렬화, "해소" 표시 안 함) | 로컬 25회 0회 재현 — 효과 실증 불가 |
| `tempdb::tests::sweep_removes_own_pid_leftovers…` flake | 안 접음 | `tempdb.rs`를 건드리지 않는다 |
| `poll_once` 404·폴러 주기·보드 전환 테스트, 404 후 폴링 계속, 보드 전환 1 s 지연 | 안 접음 | `poll.rs` 무수정 |
| post-start `api.board` 실패가 `Stage::Import` | 안 접음 | `app.rs`를 건드리지만 시작 경로·오류 화면 문구 변경이라 1b와 무관한 동작 변경 |
| `error_of` 본문 읽기 오류 로그 없음 | 안 접음 | 동작 변경, 1b 경로와 무관 |
| 키 줄 그리기 함수 2개(DIM vs muted) | 안 접음(새 화면은 `C_MUTED` 쪽을 쓴다) | 도움말 팝업 모양 변경 |
| 머리 줄·평균/최대·연속 줄 등 모니터 화면 nit, 단계/글꼴 테스트 nit, 릴리즈·문서 nit | 안 접음 | 해당 그리기 코드·파일 무수정 |
| DNS 리바인딩 Host 검사, SIGHUP 감시견 원인, 엔진 정규식 warn 로그 | 안 접음 | 컨트롤러/엔진 슬라이스 |

---

## 사실 근거 (claims-ledger)

기준 커밋 `e7eb9cf2`. 줄 번호는 전부 `grep -n` 출력.

| # | 주장 | 명령 |
|---|---|---|
| C1 | 기록 경로는 `/monitor-boards/{id}/panels/{panel_id}/records/{at_ms}`(152행), 없으면 구분 없이 404 | `grep -n "records\|monitor-boards" crates/controller/src/app.rs` · `grep -n "ok_or(ApiError::NotFound)" crates/controller/src/api/monitor_boards.rs` |
| C2 | `/status`는 최신 결과에만 사유·detail·display | `grep -n "사유·detail은 최신 결과에만" -A8 crates/controller/src/api/monitor_boards.rs` |
| C3 | `CheckRecord` 직렬화 필드 5개(`at_ms`·`limit_kb`·`result`·`trace`·`clipped`), `Deserialize` 없음, `ClipSide`는 lowercase, `Clipped{step: u32, side}` | `grep -n "serialize_field\|pub struct Clipped\|pub enum ClipSide\|derive\|rename_all" crates/controller/src/monitor/record.rs` |
| C4 | 공개된 http 평탄화 함수 없음: 엔진 `fn collect_http`(reqgen.rs:76, 비공개)·컨트롤러 `pub(crate) fn collect_http_steps`(check.rs:540)뿐 | `grep -rn "fn flatten\|collect_http\|fn http_steps\|fn walk_http\|fn collect_unconditional\|fn http_leaves" crates/ --include=*.rs` |
| C5 | GUI `flattenHttpSteps` 순서(model.ts:290) = http → loop.do → parallel.branches[].steps → if then·elif·else, 컨트롤러 `collect_http_steps`도 같은 재귀 | `grep -n "export function flattenHttpSteps" -A16 ui/src/scenario/model.ts` · `grep -n "pub(crate) fn collect_http_steps" -A18 crates/controller/src/monitor/check.rs` |
| C6 | 번들 키: `scenarios[].{id,yaml}`·`environments[].{id,name,vars}`; 칸 id는 ULID 검증(config.rs:411) | `grep -n "pub struct ScenarioOut\|pub struct EnvOut" -A4 crates/controller/src/monitor/board_file.rs` · `grep -n "Ulid::from_string" crates/controller/src/monitor/config.rs` |
| C7 | ko.ts 기록 창 문구(1830–1849행: `recordTitle`·`recordMissing`·`recordLoadError`·`recordNoTraceConfig`·`recordNoTraceTimeout`·`recordTraceError`·`recordTraceCut`·`recordReqHeaders`…`recordRespBody`·`recordIfRow`·`recordMaskedHint`·`recordReqBodyHidden`·`recordClipped`·`recordEngineTruncated`), `verdictUpstreamFailed`(1924)·`verdictBranchSkipped`(1925), `monitor.loading`(2026) | `grep -n "record[A-Za-z]*:\|verdictUpstreamFailed\|verdictBranchSkipped\|loading:" ui/src/i18n/ko.ts` · `grep -n "^  [a-zA-Z]*: {" ui/src/i18n/ko.ts`(`monitor: {` 1768행) |
| C8 | 기록 보관은 칸의 `bar_count`개, `/status` 결과도 최신 `bar_count`개 | `grep -n "records.len() > bar_count" crates/controller/src/monitor/supervisor.rs` · `grep -n "saturating_sub(cfg.bar_count" crates/controller/src/api/monitor_boards.rs` |
| C9 | GUI 특수 기록 구분·강조 규칙·요약 줄·가림 판정 | `cat ui/src/components/monitor/CheckRecordDialog.tsx`(`RecordSteps`·`StepRow`) · `grep -n "BRANCH_LABEL" -A10 ui/src/scenario/chipResults.ts` |
| C10 | `StepTrace` 필드(`step_id`·`kind`·`loop_index`·`branch`·`request`·`response`·`extracted`·`unbound_vars`·`error`·`branch_eval`·`timed_out`), `ScenarioTrace`(`ok`·`total_ms`·`steps`·`final_vars`·`truncated`·`error`), 엔진이 `Scenario`·`Step`·`HttpStep`·`ScenarioTrace`·`StepTrace`를 재수출 | `sed -n '/pub struct StepTrace/,/^}/p;/pub struct ScenarioTrace/,/^}/p' crates/engine/src/trace.rs` · `grep -n "^pub use" -A3 crates/engine/src/lib.rs` |
| C11 | 설정 화면 필드·문구 키(`panelTitle`·`scenario`·`environment`·`environmentNone`·`stepPick`·`wholeScenario`·`interval`·`timeout`·`latencySource`·`latencyTotal`·`thresholds`·`thresholdMs`·`barCount`·`graphMax`·`conditions`·`displayTitle`·`displayRank`·`noTitle`·`condStepGone`·`condOpLabel`·`condTarget*` 2004–2008행), `targetLabel`(conditions.ts:151)·`conditionSummary`(172) | `grep -n "ko\.monitor\.[a-zA-Z]*" -o ui/src/components/monitor/PanelEditor.tsx` · `sed -n 1855,2010p ui/src/i18n/ko.ts` · `grep -n "export function targetLabel\|export function conditionSummary" -A14 ui/src/monitor/conditions.ts` · `sed -n 100,125p ui/src/monitor/__tests__/conditions.test.ts` |
| C12 | 신호 테스트 flake 로컬 재현 0/25 | `for i in $(seq 1 25); do cargo test -p handicap-tui --test app_test; done`(전부 `24 passed; 0 failed`) |
| C13 | tui crate는 지금 `handicap-engine`에 직접 의존하지 않는다, `rust-version = "1.88"` | `grep -rn "handicap.engine\|handicap_engine" crates/tui/` (0건) · `cat crates/tui/Cargo.toml` |
| C14 | ratatui 버퍼는 제어 문자가 든 글자를 걸러 버린다(그래도 폭 계산·탭 때문에 `sanitize`를 둔다) | `grep -n "is_control" ~/.cargo/registry/src/*/ratatui-core-0.1.2/src/buffer/buffer.rs`(351행) |
| C15 | 모니터 키 줄 기대 문자열 단언 5곳(view_test.rs 425·443·1227·2453·2461), `HELP_KEYS: [(&str, &str); 8]` | `grep -n "b 테두리\|HELP_KEYS" crates/tui/tests/*.rs crates/tui/src/text.rs` |
| C16 | 모니터 키 줄 폭: 보드 2개에서 조각 7개 합 71칸 + 구분 12 + 앞 공백 1 = 84 > 80 | 손계산(한글 2칸): 12+13+8+11+13+8+6 — **구현 중 실측 확정**(`key_bar_has_errors_and_settings_keys`), 불일치 = STOP → plan 정정 |
| C17 | 엔진 YAML 문법(Task 2 `NESTED`): loop `repeat`/`do`, if `cond: {left, op: eq, right}`/`then`/`elif[].{cond,then}`/`else`, parallel `branches[].{name,steps}` | `grep -n "type: if" -A12 crates/engine/src/scenario.rs` · `sed -n 1350,1372p crates/engine/src/scenario.rs` · `grep -n "pub struct LoopStep\|pub struct IfStep\|pub struct ParallelStep" -A12 crates/engine/src/scenario.rs` — 조합 fixture 자체는 **구현 중 `flatten_order_matches_gui`가 확정** |
| C18 | 워크스페이스 serde_json에 `preserve_order` 없음(→ `Value`로 다시 찍으면 키 순서가 바뀐다) | `grep -n "preserve_order" Cargo.toml crates/*/Cargo.toml Cargo.lock` (0건) |
| C19 | 벽의 상태 규칙: verdict → Fail/ConfigError/Blocked/Skipped, Ok ∧ 지연 ≥ 어느 기준선 → Slow; 문구 `stateSlow`(1919)·`stateBlocked`(1922)·`stateSkipped`(1923)는 `text::state_label`에 이미 있다 | `sed -n 72,108p crates/tui/src/judge.rs` · `grep -n "stateSlow\|stateBlocked\|stateSkipped" ui/src/i18n/ko.ts` · `grep -n "pub fn state_label" -A12 crates/tui/src/text.rs` |
| C20 | 묶음에는 이름이 없고 GUI는 `점검 묶음 ${n}`(1858행)으로 부른다 | `grep -n "pub struct CheckGroup" -A6 crates/controller/src/monitor/config.rs` · `grep -n "groupTitle" ui/src/i18n/ko.ts ui/src/components/monitor/GroupBox.tsx` |
| C21 | `HttpMethod`는 `rename_all = "UPPERCASE"`, `Request.url`은 YAML 문자열 그대로(`String`) | `grep -n "pub enum HttpMethod" -B3 -A8 crates/engine/src/scenario.rs` · `grep -n "pub struct Request\b" -A4 crates/engine/src/scenario.rs` |
| C22 | GUI 원문 전환 상한 64KB(`TREE_MAX_BYTES`)·안내문 `recordTreeTooLarge`(1850행) | `grep -n "TREE_MAX_BYTES\|TREE_MAX_DEPTH" ui/src/components/monitor/RecordBody.tsx` · `grep -n "recordTreeTooLarge" ui/src/i18n/ko.ts` |
| C23 | 목업 절 번호·키 줄·문구(§0–§4, "정할 것" Q1–Q4) | `docs/superpowers/specs/2026-11-10-tui-1b-mockups/01-screens.html`을 태그 제거 후 전문 읽음 |
| C24 | 무입력 안내 문구 폭 42칸(한글 2칸) — 80열 키 줄 조각으로는 늘 빠진다 | 손계산 — **구현 중 실측 확정**(`sub_layout_rows`·`render_errors_shows_rows`) |
