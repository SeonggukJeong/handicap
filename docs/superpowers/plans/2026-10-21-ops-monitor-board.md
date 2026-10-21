# 운영실 모니터 화면 본체 ①a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handicap 안에 운영 모니터 보드를 추가한다 — 컨트롤러가 칸(시나리오)마다 정한 주기로 1패스 점검을 돌리고, 원거리용 전시 화면이 정상/느림/실패·응답 ms·막대 그래프를 보여준다.

**Architecture:** controller에 `monitor` 모듈(설정 타입·검증 / 점검 판정 / 감독자 루프)과 `monitor_boards` 테이블·REST를 추가하고, 엔진 `trace_scenario`를 바깥 timeout으로 감싸 재사용한다. 결과는 메모리 링버퍼, "느림"·색·멈춤 판정은 UI 순수 함수가 현재 설정으로 계산한다. UI는 설정 화면(`Layout` 안)과 전시 화면(`Layout` 밖, 1초 폴링)으로 나뉜다.

**Tech Stack:** Rust(axum, sqlx/SQLite, tokio, tokio-util `CancellationToken`, wiremock), React+TS(React Query, Zod, react-router, Tailwind, vitest+RTL).

**Spec:** `docs/superpowers/specs/2026-10-21-ops-monitor-board-design.md` (r3, APPROVE) · 결정 원천 `docs/superpowers/specs/2026-10-21-ops-monitor-mockups/00-decisions.md` · 레이아웃 정본 `docs/superpowers/specs/2026-10-21-ops-monitor-mockups/02-latency-bars-final.html`/`.png` · 문구 정본 `docs/superpowers/plans/2026-10-21-ops-monitor-board-copy.md`(byte-exact, Task 7–10 brief에 동봉).

개정: r2 — plan 리뷰 1차(APPROVE-WITH-FIXES 21건) 반영. Task 3을 3(스텁+리터럴 churn)/4(감독자 로직)로 분할 → 총 10 task. r3 — 2차 3건(실제 live 루프 카운터·retry 판별 테스트·스텁 dead_code) 반영, spec-plan-reviewer clean APPROVE.

REVIEW-GATE: APPROVED

## Global Constraints

- 응답속도 표시는 **정수 ms + 천 단위 쉼표**(`1,350 ms`), 소수점 초 금지. `[사용자]`
- 점검 주기는 칸별 입력 `1..=3600`초, **10은 새 칸 기본값일 뿐** — 하드코딩 금지. `[사용자]`
- 범용 API 모니터 — UI·서버 어디에도 "로그인" 문구·토큰 특화 판정·비밀번호 식별 없음. `[사용자]`
- 글자 크기·깜빡임은 **보드 단위**(칸별 아님). `[사용자]`
- 기준선 숫자·점선은 막대 영역을 침범하지 않는다(숫자는 그래프 오른쪽 전용 열, `(ms)` 1회). `[사용자]`
- 전체화면 해제 = ESC · F · `mousedown` 아무 버튼, 마우스 이동만으로는 해제 안 함, 해제 후에도 점검 계속. `[사용자]`
- 범위(위반 = **400** 한국어 메시지, 이름 중복 = 409): 보드 이름 trim 후 1..=40자(spec 보완 — `[Claude]`) · `font_scale` small|medium|large|xlarge(기본 large) · `blink` off|fail|slow_and_fail(기본 fail) · panels 1..=9 · title trim 후 1..=40자 · `interval_seconds` 1..=3600(기본 10) · `timeout_seconds` 1..=120(기본 5) · thresholds 0..=5(새 칸 기본 **없음** — `[Claude]`), ms 1..=600000 엄격 오름차순, color `#rrggbb` · `bar_count` 10..=300(기본 60) · `graph_max_ms` 100..=600000(기본 2000) · panel id 유효 ULID(26자 Crockford)·보드 내 유일(빈 값이면 서버 발급) · `scenario_id` 비어 있지 않음.
- **와이어 enum 문자열은 정확히**: `font_scale` `"small"|"medium"|"large"|"xlarge"`(Rust variant `Xlarge` — `XLarge`는 snake_case로 `"x_large"`가 되므로 금지), `blink` `"off"|"fail"|"slow_and_fail"`, `latency_source.kind` `"total"|"step"`, `verdict` `"ok"|"fail"|"config_error"`.
- 점검 1회 요청 상한 `MONITOR_MAX_REQUESTS = 50`(설정 `max_test_run_requests`와 무관), `apply_think_time: false`, 제한 시간은 `tokio::time::timeout`으로 바깥 강제.
- 벽 화면에 나가는 사유는 copy 정본 §서버 고정 문구 + 시나리오 작성자의 스텝 이름뿐 — 엔진 error 원문·URL·응답 값 금지.
- 서버 응답 JSON은 serde 그대로, Zod는 `null` 가능 필드를 `.nullable()`로(ui/CLAUDE.md `.nullish()` 함정).
- Rust: `cargo fmt`, `clippy -D warnings` — 2-arm `match … _ => {}` 대신 `if let`, 중첩 제네릭은 **type alias**(`type_complexity`), `std::sync::Mutex`는 `.await` 넘어 잡지 않는다. UI: `pnpm lint && pnpm test && pnpm build` — 게이트 판정은 파이프 없이 `; echo exit=$?`.
- **bundle 수동 게이트**: `crates/controller/src/in_process.rs`는 `#[cfg(feature = "bundle")]`(`lib.rs:11-12`)라 pre-commit이 컴파일하지 않는다. 이 파일을 건드리는 task(3, 5, 6)는 `cd ui && pnpm build` 후 `cargo build -p handicap-controller --features bundle` · `cargo clippy -p handicap-controller --features bundle -- -D warnings` · `cargo nextest run -p handicap-controller --features bundle` 셋 다 exit 0.

## Review Focus

1. **편집 중 시나리오가 깨짐** — 점검 중 YAML이 잘못 저장되거나 기준 스텝이 지워지면 다음 점검에서 `⚠ 설정 오류` → Task 2 `config_error_when_latency_step_missing`·`config_error_when_scenario_yaml_invalid`.
2. **같은 보드를 빠르게 연속 저장/시작/정지(동시 요청 포함)** — DB의 `enabled`와 실제 점검 상태가 어긋나거나 고아 task가 남으면 안 된다 → Task 4 `reconcile_*`·`live_task_count_after_rapid_reconcile`, Task 5 `concurrent_stop_and_put_end_consistent`.
3. **응답이 아예 안 오는 서버** — 정상이 아니라 `시간 초과(N초)`, 다음 점검이 밀리지 않음 → Task 2 `outer_timeout_fails_and_cancels`, Task 4 `slow_check_does_not_overlap`.
4. **결과가 막대보다 적은 첫 몇 분 / 칸 9개의 작은 칸** — 왼쪽부터 채움, 작은 칸에서도 글자는 그래프 때문에 줄지 않음(남는 높이 15% 미만이면 그래프 숨김) → Task 7 `slots_left_fill`, Task 9 `graph_hidden_when_too_short` + 라이브 9칸 실측.
5. **켜 둔 채 재시작·PUT으로 칸 추가·재저장** — 새 칸은 "확인 중"으로 시작하고, 기존 칸은 재저장해도 기록이 유지된다 → Task 4 `started_at_resets_on_reconcile`, Task 7 `pending_until_grace_after_start`, Task 8 `resave_keeps_panel_ids`.

---

### Task 1: 저장소 + 설정 타입·검증

**Files:**
- Create: `crates/controller/src/store/migrations/0022_monitor_boards.sql`, `crates/controller/src/store/monitor_boards.rs`, `crates/controller/src/monitor/mod.rs`, `crates/controller/src/monitor/config.rs`
- Modify: `crates/controller/src/store/mod.rs`(include_str + `connect()`의 `ensure_runs_label` 다음 줄 실행, `pub mod monitor_boards;`), `crates/controller/src/lib.rs`(`pub mod monitor;`)

**Interfaces:**
- Produces (`monitor::config`): `BoardConfig { font_scale: FontScale, blink: Blink, panels: Vec<PanelConfig> }`, `PanelConfig { id: String, title: String, scenario_id: String, environment_id: Option<String>, interval_seconds: u32, timeout_seconds: u32, latency_source: LatencySource, thresholds: Vec<Threshold>, bar_count: u32, graph_max_ms: u32 }`, `enum LatencySource { Total, Step { step_id: String } }`(`#[serde(tag = "kind", rename_all = "snake_case")]`), `Threshold { ms: u32, color: String }`, `enum FontScale { Small, Medium, Large, Xlarge }`, `enum Blink { Off, Fail, SlowAndFail }`. 기본값은 **컨테이너 레벨 `#[serde(default)]` + 손으로 쓴 `impl Default`**(필드 레벨 `#[serde(default)]`는 `u32`를 0으로 채우므로 금지). `pub fn validate_panel(p: &mut PanelConfig) -> Result<(), String>`(빈 id → ULID 발급, title trim, 범위), `pub fn validate_and_normalize(name: &str, cfg: &mut BoardConfig) -> Result<String /*trim된 이름*/, String>`(이름·panels 수·id 중복 + 각 칸 `validate_panel`).
- Produces (`store::monitor_boards`): `MonitorBoardRow { id, name, config: BoardConfig, enabled: bool, created_at: i64, updated_at: i64 }`; `insert(db, name, &BoardConfig)`, `get(db, id) -> Option`, `list(db)`(이름순), `update(db, id, name, &BoardConfig) -> Option`(updated_at 갱신), `set_enabled(db, id, bool) -> Option`(**updated_at 불변** — 화면 재조회 트리거는 설정 변경만), `delete(db, id)`, `list_enabled(db)` — 모두 `sqlx::Result`.

- [ ] **Step 1: 실패 테스트** — `config.rs` `#[cfg(test)]`: `defaults_fill_missing_fields`(`{"panels":[{"scenario_id":"S"}]}` → interval 10·timeout 5·bar_count 60·graph_max_ms 2000·thresholds 빈·latency Total·font Large·blink Fail), `enum_wire_strings_roundtrip`(FontScale 4·Blink 3·LatencySource 2를 위 Global Constraints 리터럴 문자열과 양방향 비교), `validate_rejects_out_of_range`(interval 0·3601, timeout 0·121, panels 0·10, thresholds 6개, `[700,700]`, color `"red"`, bar_count 9, graph_max_ms 99, title 공백만, 이름 공백만·41자, scenario_id `""`, 중복 id, 비-ULID id → 각 Err), `validate_assigns_ids_and_trims`. `monitor_boards.rs` `#[cfg(test)]`(`store::connect("sqlite::memory:")`): `crud_roundtrip`, `set_enabled_keeps_updated_at`, `list_enabled_only_enabled`, `name_unique_violation`(`is_unique_violation()`).
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller monitor:: store::monitor_boards` → 컴파일 실패/FAIL.
- [ ] **Step 3: 구현** — SQL은 spec §4. 패턴은 `store/environments.rs`(ULID 서버 생성, `super::now_ms()`, `config_json`은 `serde_json`).
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 5: 커밋** — `feat(controller): monitor_boards 저장소·설정 검증 (ops-monitor ①a)`.

### Task 2: 점검 1회와 판정

**Files:**
- Create: `crates/controller/src/monitor/check.rs` (테스트는 같은 파일 `#[cfg(test)]`, wiremock)

**Interfaces:**
- Consumes: Task 1 `PanelConfig`/`LatencySource`; `store::scenarios::get`, `store::environments::get`; `handicap_engine::{Scenario, Step, TraceOptions, trace_scenario, ScenarioTrace}`.
- Produces: `CheckResult { at_ms: i64, verdict: Verdict, latency_ms: Option<u64>, reason: Option<String> }`(Serialize/Deserialize/Clone/Debug/PartialEq), `enum Verdict { Ok, Fail, ConfigError }`(snake_case), `pub const MONITOR_MAX_REQUESTS: u32 = 50;`, `pub async fn run_check(db: &Db, panel: &PanelConfig) -> (Option<ScenarioTrace>, CheckResult)`, 순수 `pub fn judge(scenario: &Scenario, panel: &PanelConfig, trace: &ScenarioTrace, at_ms: i64) -> CheckResult`.
- **분류 순서(spec §6.2.3 정밀화 — 의도적 확정, spec r3 리뷰 nit)**: 첫 error 스텝에 대해 ① error가 `invalid header`로 시작(응답 유무 무관 — 엔진은 이때 assert를 건너뛰고, 전송 실패여도 build_error를 남긴다 `executor.rs:528,577`) → `요청 구성 오류` ② 응답 있음 + 그 스텝의 status assert ≠ 응답 status → `HTTP {status}` ③ 응답 있음 + `read body:` → `응답 본문 읽기 실패` ④ 응답 있음 + 그 외 → `값 추출 실패` ⑤ 응답 없음 → `요청 실패`.

- [ ] **Step 1: 실패 테스트** — 순수 `judge`(ScenarioTrace 직접 구성): `ok_when_all_steps_pass`(latency = total_ms), `latency_from_last_execution_of_step`, `ok_with_null_latency_when_step_not_executed`(기준 스텝이 안 탄 분기 → `Ok`, `latency_ms None`), `fail_http_status_when_assert_mismatch`(→ `"HTTP 503"`), `fail_invalid_header_with_response`·`fail_invalid_header_without_response`(둘 다 → `"요청 구성 오류"`), `fail_read_body_label`, `fail_extract_label`(error `"no match: $.t"` → `"값 추출 실패"`, `reason`에 `$.t` 미포함 단언), `fail_no_response_label`, `step_suffix_only_when_multiple_http_steps`(`"HTTP 503 · 인증"` vs `"HTTP 503"`), `truncated_request_cap_reason`(http StepTrace 50개 + truncated → `"요청 수 상한(50) 초과"`), `truncated_time_reason`(→ `"시간 초과(5초)"`), `trace_error_reason`(→ `"시나리오 실행 오류"`), `config_error_when_latency_step_missing`(loop/if/parallel 안 http 스텝은 찾아야 함 — 중첩 시나리오로 단언). `run_check`(인메모리 DB + wiremock): `outer_timeout_fails_and_cancels`(응답 3초 지연·timeout 1 → `Fail "시간 초과(1초)"`, latency None, trace None, 경과 < 2초), `config_error_when_scenario_missing`, `config_error_when_environment_missing`, `config_error_when_scenario_yaml_invalid`, `env_vars_applied_from_environment`.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller monitor::check`.
- [ ] **Step 3: 구현** — spec §6.1. `TraceOptions{ env, max_requests: MONITOR_MAX_REQUESTS, max_wall: Duration::from_secs(timeout), apply_think_time: false }`를 `tokio::time::timeout`으로 감싼다. http 스텝 수집은 `Step::{Http, Loop(do_), If(then_, elif[].then_, else_), Parallel(branches[].steps)}` 재귀 exhaustive match. 사유 문구는 copy 정본 §서버를 상수로. error 원문은 `starts_with` 분류에만 쓴다.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 5: 커밋** — `feat(controller): 모니터 점검 1회·판정 (바깥 timeout·고정 사유)`.

### Task 3: AppState 배선 (스텁 감독자 + 리터럴 50곳)

**Files:**
- Create: `crates/controller/src/monitor/supervisor.rs`(스텁: `#[derive(Clone, Default)] pub struct MonitorSupervisor { inner: Arc<Inner> }`, **`Inner`는 빈 구조체**, `pub fn with_root(_token: CancellationToken) -> Self`는 토큰을 무시 — 토큰 필드는 Task 4에서 추가(읽히지 않는 필드는 `dead_code`로 clippy `-D warnings` 실패))
- Modify: `crates/controller/src/app.rs`(`pub monitor: crate::monitor::MonitorSupervisor`), **구조체 리터럴 50곳**(컴파일러가 전부 찾는다 — `cargo build --workspace --all-targets` 에러 목록; 참고 `grep -rn "AppState {" crates/controller/src crates/controller/tests`는 정의 1 + 헬퍼 시그니처 4를 포함해 55). 경로: crate 안 `crate::monitor::MonitorSupervisor::default()`, `main.rs`·tests는 `handicap_controller::monitor::MonitorSupervisor::default()`, `in_process.rs`는 이 task에서 `default()`(토큰 연결은 Task 6).

**Interfaces:**
- Produces: `AppState.monitor: MonitorSupervisor`(Task 4가 내부를 채운다 — 공개 시그니처는 Task 4 Interfaces).

- [ ] **Step 1: 실패 테스트** — `supervisor.rs` `#[cfg(test)]` `default_is_constructible`(`MonitorSupervisor::default()` 생성·clone).
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller monitor::supervisor`.
- [ ] **Step 3: 구현** — 스텁 + 50곳 한 줄 추가(로직 변경 없음).
- [ ] **Step 4: 통과 확인** — `cargo build --workspace --all-targets` · `cargo nextest run -p handicap-controller` PASS + **bundle 수동 게이트** 3개 exit 0.
- [ ] **Step 5: 커밋** — `refactor(controller): AppState에 MonitorSupervisor 필드 배선`.

### Task 4: 감독자 루프와 reconcile

**Files:**
- Modify: `crates/controller/src/monitor/supervisor.rs`

**Interfaces:**
- Consumes: Task 1 store/`BoardConfig`, Task 2 `CheckResult`/`run_check`.
- Produces:
  - `pub const BUFFER_CAP: usize = 300;`
  - `pub struct PanelBuf { results: VecDeque<CheckResult>, running: bool }` — `std::sync::Mutex<PanelBuf>`로 보관(락을 `.await` 넘어 잡지 않음).
  - `pub async fn reconcile(&self, db: &Db, board_id: &str) -> anyhow::Result<()>` — **보드별 `tokio::sync::Mutex` 안에서** 행을 다시 읽는다: 없음/disabled → 정지(task 토큰 cancel + `JoinHandle` await(abort 백스톱) 후 버퍼·`started_at_ms` 폐기); enabled → 기존 task 정지·**await 완료 후** 행 config로 재시작(남은 panel id 버퍼 유지, 사라진 칸 버퍼 폐기, `started_at_ms = now`). 모든 REST 쓰기 핸들러와 기동 재개가 이것만 부른다.
  - `pub async fn snapshot(&self, board_id: &str) -> Option<BoardSnapshot>`; `BoardSnapshot { started_at_ms: i64, panels: HashMap<String, PanelSnapshot> }`, `PanelSnapshot { results: Vec<CheckResult> /*오래된→최신, 전체 버퍼*/, running: bool }`.
  - `pub async fn stop_all(&self)` — 루트 토큰 cancel + 모든 handle await/abort(데스크톱 종료용).
  - `#[cfg(test)] pub(crate) fn live_task_count(&self, board_id: &str) -> usize` — **map의 handle 수가 아니라 실제 살아 있는 루프 수**: `panel_loop` 진입 시 보드별 `Arc<AtomicUsize>` +1, drop guard로 종료(cancel·abort 포함) 시 −1.
  - 루프 코어 `pub(crate) async fn panel_loop<F, Fut>(interval: Duration, check: F, buf: Arc<std::sync::Mutex<PanelBuf>>, token: CancellationToken) where F: Fn() -> Fut, Fut: Future<Output = CheckResult>` — 시작-시작 간격, 첫 점검 즉시, 겹침 없음, `select!`로 cancel.
  - 중첩 타입은 type alias로(`type BoardTasks = …`).

- [ ] **Step 1: 실패 테스트** — 루프(`#[tokio::test(start_paused = true)]`, 주입 fake check, **SQLite 금지** — paused time + sqlx = `PoolTimedOut`): `first_check_immediate_then_start_to_start`(interval 10s·check 1s → 시작 0,10,20s), `slow_check_does_not_overlap`(interval 2s·check 5s → 시작 0,5,10s, 동시 실행 최대 1), `buffer_capped_and_ordered`(305회 → 300개, 첫 = 6번째), `cancel_stops_loop`. reconcile(실시간, 인메모리 DB, 존재하지 않는 scenario_id → `config_error` 결과로 충분, interval 1s): `reconcile_starts_enabled_and_stops_disabled`, `reconcile_keeps_buffer_for_same_panel_id`, `reconcile_drops_removed_panel`, `started_at_resets_on_reconcile`, `reconcile_deleted_row_stops`, `live_task_count_after_rapid_reconcile`(reconcile 5회 연속 → 200ms 후 `live_task_count == panels.len()`; 이빨 실증: reconcile의 기존 task 정지를 건너뛰면 RED → 원복 GREEN), `stop_all_stops_everything`(`live_task_count == 0`). 연속 실패 계산은 순수 함수 `consecutive_fail(results: &[CheckResult]) -> (u32, Option<i64>)`로 분리해 여기서 단위 테스트(`consecutive_counts_from_newest_over_full_buffer` — 300개 버퍼, 최신 12개 fail).
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller monitor::supervisor`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 같은 명령 + `cargo nextest run -p handicap-controller` PASS.
- [ ] **Step 5: 커밋** — `feat(controller): 모니터 감독자 루프·reconcile`.

### Task 5: REST API

**Files:**
- Create: `crates/controller/src/api/monitor_boards.rs`; Modify: `crates/controller/src/api/mod.rs`, `crates/controller/src/app.rs`(라우트)
- Test: `crates/controller/tests/monitor_boards_api_test.rs`(`environments_api_test.rs`의 `make_app`/`send` 패턴 + wiremock)

**Interfaces:**
- Consumes: Task 1 store/검증, Task 2 `run_check`, Task 4 `reconcile`/`snapshot`.
- Produces (와이어, spec §5·§6.4): `BoardResponse { id, name, config, enabled, created_at, updated_at }`, 목록 `{"boards":[…]}`, `BoardBody { name, config }`, `StatusResponse { now_ms, board_updated_at, enabled, started_at_ms: Option<i64>, panels: Vec<PanelStatus> }`, `PanelStatus { panel_id, results: Vec<CheckResult>, consecutive_fail: u32, fail_since_ms: Option<i64>, running: bool }` — `results`는 그 칸 `bar_count`개로 자르고, `consecutive_fail`/`fail_since_ms`는 **자르기 전 전체 버퍼**로 계산, 칸 순서 = 설정 panels 순. `PreviewResponse { trace: Option<ScenarioTrace>, result: CheckResult }`. 라우트 `/monitor-boards`(post,get) · `/monitor-boards/{id}`(get,put,delete) · `/monitor-boards/{id}/start`·`/stop`(post) · `/monitor-boards/{id}/status`(get) · `/monitor-boards/preview-check`(post, 본문 `PanelConfig` → `validate_panel` → `run_check`) — 고정 세그먼트는 axum이 `{id}`보다 우선(선례 `app.rs`의 `/datasets/preview`·`/schedules/preview-next`).
- 모든 쓰기(create는 enabled false라 생략 가능, put/start/stop/delete)는 **DB 쓰기 → `state.monitor.reconcile(&db, id)`**. 오류: 중복 → `Conflict("같은 이름의 모니터가 이미 있습니다")`, 검증 → `BadRequest(msg)`, 없음 → `NotFound`.

- [ ] **Step 1: 실패 테스트**: `create_list_get_update_delete`, `create_400_on_invalid_config`, `duplicate_name_409`, `unknown_id_404`(get/put/delete/start/status), `start_status_stop`(wiremock 200 → start → 2초 내 결과 ≥1·`started_at_ms` Some → stop → enabled false·started_at None·results 빈), `put_bumps_board_updated_at_and_reconfigures`(create 후 10ms sleep → PUT → `updated_at` 증가), `start_stop_do_not_bump_updated_at`, `status_consecutive_fail_wired`(503, interval 1 → 결과 ≥3 기다림, `consecutive_fail >= results.len()`·`fail_since_ms` = 첫 결과 at_ms — 전체 버퍼 계산 자체는 Task 4 순수 함수 테스트가 담당, `results`는 `bar_count`로 잘림을 bar_count 10 미만 결과로는 못 보므로 잘림은 `status_results_truncated_to_bar_count` 단위 테스트로: status 조립 함수를 순수 `build_panel_status(cfg, snapshot) -> PanelStatus`로 분리해 300개 snapshot → 10개), `preview_check_returns_trace_and_result`, `preview_check_400_on_invalid_panel`, `delete_stops_running_board`, `concurrent_stop_and_put_end_consistent`(멀티스레드 런타임 `#[tokio::test(flavor = "multi_thread")]`, 20회 반복: enabled 보드에 stop과 PUT을 `tokio::join!` → 끝난 뒤 DB `enabled`와 `snapshot.is_some()`이 일치 — 스모크; 실제 보장은 "마지막 reconcile이 두 DB 쓰기 이후에 돈다"는 설계).
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --test monitor_boards_api_test`.
- [ ] **Step 3: 구현** — `api/environments.rs` 구조 미러(`map_db_err`). status = store row + `snapshot`, `now_ms = store::now_ms()`.
- [ ] **Step 4: 통과 확인** — 같은 명령 + `cargo nextest run -p handicap-controller` PASS.
- [ ] **Step 5: 커밋** — `feat(controller): /api/monitor-boards REST·status·preview-check`.

### Task 6: 기동 시 자동 재개 (두 시작 경로) + ADR-0053

**Files:**
- Modify: `crates/controller/src/monitor/mod.rs`(`pub async fn resume_enabled(state: &AppState) -> anyhow::Result<usize>` — `list_enabled` 각각 `reconcile`), `crates/controller/src/main.rs`(AppState 생성 직후 스케줄러 블록 옆에서 `resume_enabled` — 실패는 `warn!` 후 계속), `crates/controller/src/in_process.rs`(토큰 생성을 AppState 앞으로 옮기고 `monitor: MonitorSupervisor::with_root(token.child_token())`; `resume_enabled` 호출; `RunningController`에 `monitor` 필드 + `shutdown()`에서 `self.token.cancel()` 뒤 `self.monitor.stop_all().await`)
- Create: `docs/adr/0053-ops-monitor-mode.md`; Modify: 루트 `CLAUDE.md` "알아둘 결정들"에 한 줄 `- **0053** 운영 모니터 모드: 엔진 1패스 trace 재사용 주기 점검 보드 + 메모리 링버퍼 + 느림은 화면 계산 (ADR-0009 범위=부하 실행 중 대시보드)`
- Test: `crates/controller/tests/monitor_boards_api_test.rs` `resume_enabled_restarts_enabled_boards`

- [ ] **Step 1: 실패 테스트** — enabled 1·disabled 1 삽입 → `resume_enabled(&state) == 1`, enabled만 `snapshot` Some.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --test monitor_boards_api_test resume`.
- [ ] **Step 3: 구현** — 위 Files대로. ADR은 MADR, 내용 spec §11.
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller` PASS + **bundle 수동 게이트** 3개 exit 0.
- [ ] **Step 5: 커밋** — `feat(controller): 켜진 모니터 기동 시 자동 재개 (standalone·in-process) + ADR-0053`.

### Task 7: UI API 클라이언트 + 표시 순수 로직

**Files:**
- Create: `ui/src/api/monitors.ts`, `ui/src/monitor/logic.ts`
- Test: `ui/src/api/__tests__/monitors.test.ts`, `ui/src/monitor/__tests__/logic.test.ts`

**Interfaces:**
- Produces (`api/monitors.ts`): Zod `BoardConfigSchema`/`PanelConfigSchema`/`CheckResultSchema`(`latency_ms`·`reason` `.nullable()`)/`BoardSchema`/`StatusSchema`(`started_at_ms`·`fail_since_ms` `.nullable()`)/`PreviewSchema`(`trace: ScenarioTraceSchema.nullable()` — `api/schemas.ts`에서 import); 타입 `Board`, `BoardConfig`, `PanelConfig`, `Threshold`, `FontScale`, `Blink`, `CheckResult`, `BoardStatus`; `listBoards()`, `getBoard(id)`, `createBoard({name, config})`, `updateBoard(id, {name, config})`, `deleteBoard(id)`, `startBoard(id)`, `stopBoard(id)`, `getBoardStatus(id)`(404면 `ApiError(404)` — `api/client.ts`의 `ApiError` 재사용), `previewCheck(panel)`; 오류 메시지 추출은 `api/environments.ts`의 `errorMessage` 패턴. `newPanel(): PanelConfig` — **id는 `newStepId()`(`ui/src/scenario/ulid.ts`)로 클라 생성**, 나머지 기본값 = Global Constraints.
- Produces (`monitor/logic.ts`): `formatMs(ms: number): string`, `barColor(latencyMs: number, thresholds: Threshold[]): string`(넘은 가장 높은 기준선 색, 없으면 `#22c55e`), `type PanelState = "ok" | "slow" | "fail" | "config_error" | "stale" | "stale_off" | "pending"`, `panelState(args: { latest?: CheckResult; nowMs: number; startedAtMs: number | null; enabled: boolean; serverDown: boolean; intervalSec: number; timeoutSec: number; thresholds: Threshold[] }): PanelState`, `staleAfterMs(intervalSec, timeoutSec) = (interval*3 + timeout + 5) * 1000`, `barSlots(results, barCount): (CheckResult | null)[]`(길이 barCount, **왼쪽부터**, 초과분은 오래된 것 제거), `gridFor(n): { cols; rows }`(1→1×1, 2→2×1, 3→3×1, 4→2×2, 5–6→3×2, 7–9→3×3), `axisAgoLabel(barCount, intervalSec): string`(`"10분"`, `"50초"`, `"1시간 40분"`), `FONT_SCALE = { small: 0.7, medium: 0.85, large: 1, xlarge: 1.2 }`, `showConsecutive(n) = n >= 2`(`[Claude]`), `bigValueText(state, latest): string`(ok/slow = `formatMs`, latency null이면 `"—"`; fail/config_error = `reason`; stale/stale_off/pending = `"—"`).

- [ ] **Step 1: 실패 테스트** — `logic.test.ts`: `formatMs_integer_commas`(1350→`"1,350 ms"`, 7→`"7 ms"`), `barColor_highest_crossed`, `slots_left_fill`, `slots_evict_oldest`, `state_slow_uses_current_thresholds`, `state_fail_and_config_error`, `stale_after_grace`(10·5 → 40초 경과 stale, 39초 ok), `pending_until_grace_after_start`, `stale_off_when_disabled`, `server_down_forces_stale`, `grid_table`, `axis_labels`, `big_value_text_cases`, `consecutive_threshold`. `monitors.test.ts`: `null` 필드 포함 status/preview 페이로드 `parse` 통과, `new_panel_ids_unique`(두 번 호출 → 서로 다른 26자).
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/monitor src/api/__tests__/monitors.test.ts`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS + `pnpm lint; echo exit=$?` 0.
- [ ] **Step 5: 커밋** — `feat(ui): 모니터 API 클라이언트·표시 로직`.

### Task 8: 설정 화면 (목록·편집·미리 실행) + 메뉴·라우트·문구

**Files:**
- Create: `ui/src/pages/MonitorListPage.tsx`, `ui/src/pages/MonitorEditPage.tsx`(new·edit 겸용), `ui/src/components/monitor/PanelEditor.tsx`, `ui/src/components/monitor/PreviewResult.tsx`, `ui/src/monitor/fullscreen.ts`
- Modify: `ui/src/routes.tsx`(`monitors`, `monitors/new`, `monitors/:id` — Layout 자식), `ui/src/components/Layout.tsx`(`/monitors` 링크를 `workers` 앞), `ui/src/i18n/ko.ts`(copy 정본 **전체**를 이 task에서 추가)
- Test: `ui/src/pages/__tests__/MonitorEditPage.test.tsx`, `ui/src/pages/__tests__/MonitorListPage.test.tsx`

**Interfaces:**
- Consumes: Task 7 전부; `useScenarios()`/`useScenario(id)`(`api/hooks.ts`), `listEnvironments()`(`api/environments.ts`), `parseScenarioDoc`(`scenario/yamlDoc.ts`) → `model.steps` → `flattenHttpSteps`(`scenario/model.ts`); 프리미티브 `components/ui/*`.
- Produces (`monitor/fullscreen.ts`): `enterFullscreen(): void`(`document.documentElement.requestFullscreen?.()`의 promise를 `.catch(() => {})`, **동기 호출**), `exitFullscreen(): void`(`document.fullscreenElement`가 있을 때만 `document.exitFullscreen().catch(() => {})`), `isFullscreen(): boolean`.
- "모니터 시작" 핸들러(동기 부분이 먼저): ① `enterFullscreen()` ② 새 보드면 `createBoard`, dirty면 `updateBoard` ③ `startBoard` ④ `navigate("/monitors/{id}/display")`. 실패 시 `exitFullscreen()` + 오류 표시. 저장 성공 후 페이지 state를 **서버 응답 `Board`로 교체**(panel id 보존).
- 레이아웃(spec §7.2): 칸 본문 = 제목·시나리오(필수)·환경·주기·**기준선 목록(접지 않음)**; 접이식은 **"고급"만**(제한 시간·표시 응답 시간·막대 개수·그래프 최대 높이, 기본과 다르면 `advancedSet(n)` 힌트 — `ScenarioSnapshot` 이디엄). 미리 실행 결과 = 스텝별 status·ms·error 원문·본문 `<pre>`(본문 트리 조건 작성은 ①b — 넣지 말 것). 목록 빈 상태·삭제 확인 등 문구는 copy 정본. 삭제 확인은 인라인 확인 행(`window.confirm` 금지 — 브라우저 모달은 Playwright 라이브 검증을 막는다).

- [ ] **Step 1: 실패 테스트**: `renders_board_fields_and_default_panel`(칸 1개, 주기 `10`, "크게", "실패만", 기준선 0개), `interval_is_editable`(30 → `createBoard` 페이로드 `interval_seconds: 30`), `thresholds_add_remove_max5`(6번째 추가 버튼 disabled), `advanced_collapsed_with_count_hint`, `latency_step_options_from_scenario_yaml`, `scenario_required_blocks_save`, `preview_shows_verdict_and_raw_error`, `start_requests_fullscreen_synchronously`(`Object.defineProperty`로 `document.documentElement.requestFullscreen` spy·`document.fullscreenElement` 정의 → `fireEvent.click(시작)` **직후 await/waitFor 없이** `expect(spy).toHaveBeenCalledTimes(1)`; 이빨 실증: 호출을 `await updateBoard` 뒤로 옮기면 RED → 원복 GREEN), `resave_keeps_panel_ids`(저장 → 응답으로 state 교체 → 재저장 페이로드의 panel id가 첫 응답과 동일), `new_board_start_creates_then_starts`, `server_400_message_shown`, `delete_board_with_confirm`. 목록: `lists_boards_with_enabled_and_open_link`, `empty_state_copy`.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/pages/__tests__/Monitor`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `pnpm lint; echo exit=$?` · `pnpm test; echo exit=$?` · `pnpm build; echo exit=$?` 모두 0.
- [ ] **Step 5: 커밋** — `feat(ui): 모니터 설정 화면·미리 실행·메뉴`.

### Task 9: 전시 화면 렌더링 (칸·막대·헤더·폴링·확인 불가)

**Files:**
- Create: `ui/src/pages/MonitorDisplayPage.tsx`, `ui/src/components/monitor/MonitorPanel.tsx`, `ui/src/components/monitor/LatencyBars.tsx`
- Modify: `ui/src/routes.tsx`(최상위 형제 `{ path: "/monitors/:id/display", element: <MonitorDisplayPage /> }` — **Layout 밖**)
- Test: `ui/src/pages/__tests__/MonitorDisplayPage.test.tsx`, `ui/src/components/monitor/__tests__/LatencyBars.test.tsx`

**Interfaces:**
- Consumes: Task 7 전부, copy 정본.
- Produces: `LatencyBars({ results, barCount, graphMaxMs, thresholds, intervalSec })` — DOM: 막대 영역 `data-testid="bars-area"`, 기준값 열 `data-testid="threshold-labels"`(막대 영역의 **형제**), 슬롯 `data-testid="bar-slot"`(빈 슬롯 `data-empty`, 실패 `data-verdict="fail"`, 설정 오류 `data-verdict="config_error"`, 높이 style `%`). `MonitorPanel({ panel, status, state, fontScale, blinkOn })`.
- **글자 크기**: 칸 컨테이너 `container-type: size`, 글자 = 칸 단위(cqw/cqh) × `FONT_SCALE` — 기준 비율은 **1920×1080·2칸·large에서 목업 v4 재현**(목업은 화면-cqw: 제목 5.2·상태 5.2·큰 값 9·기준값 2.4·축 1.8, 칸 폭 ≈ 화면 0.47 → 제목 ≈ 11 칸-cqw 등; **구현 중 실측 확정** — 라이브에서 ±10% 벗어나면 이 비율을 고치는 fix 커밋).
- **그래프 숨김은 JS 측정**: 칸 ref와 텍스트 블록 ref 높이를 `ResizeObserver`로 측정, `(칸 높이 − 텍스트 높이) < 칸 높이 × 0.15`면 `LatencyBars`를 렌더하지 않는다(CSS-only `@container` 규칙 금지 — jsdom에서 검증 불가). 글자 크기 계산은 그래프 유무와 독립.
- 폴링: `useQuery({ queryKey: ["monitorStatus", id], queryFn, refetchInterval: 1000, refetchIntervalInBackground: true, retry: false })`, 연속 실패 수는 컴포넌트 state(성공 시 0, 3 이상 = serverDown). status 404 → 전체 화면 "모니터를 찾을 수 없음"(copy) — serverDown 아님. `board_updated_at` 변경 시 `getBoard` 재조회.

- [ ] **Step 1: 실패 테스트**: `LatencyBars`: `slot_count_equals_bar_count_left_filled`, `threshold_labels_outside_bars_area`(라벨 노드가 `bars-area` 자손 아님 + `"1,200"` 단위 없음 + `(ms)` 정확히 1회), `bar_color_from_current_thresholds`, `fail_bar_full_height`, `config_error_bar_gray_full`, `overflow_clamped_to_100`(graph_max 2000·latency 5000 → `100%`). 페이지(fake timers + fetch mock): `header_board_name_and_last_check`(주기 동일 → `· 10초 주기`; 다르면 칸 시간축에 `N초 주기`; 결과 없으면 `마지막 점검 —`), `no_login_wording`(`"로그인"` 0건), `panel_shows_ms_and_state`, `fail_shows_reason_and_consecutive`(`consecutive_fail` 1 → 연속 문구 없음, 3 → `3회 연속 · …부터`), `refetches_board_when_updated_at_changes`, `server_down_after_3_failed_polls`(500 3회 → `서버 응답 없음` + 전 칸 `– 확인 불가`, 2회에선 아님), `status_query_no_retry`(**테스트 QueryClient를 `{ retry: 1, retryDelay: 10 }`로 생성** — 흔한 `retry:false` 래퍼 금지, 기본 retryDelay 1000ms는 폴링 1000ms와 구분 불가; 500 1회 후 ~200ms만 진행 → fetch 정확히 1회; 이빨 실증: 쿼리의 `retry: false` 제거 → 2회로 RED → 원복), `not_found_page_on_404`, `graph_hidden_when_too_short`(테스트 로컬 `ResizeObserver` mock이 칸 300·텍스트 270을 콜백으로 전달 → `bars-area` 없음; 300·150 → 있음).
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/pages/__tests__/MonitorDisplayPage.test.tsx src/components/monitor`.
- [ ] **Step 3: 구현** — 색·레이아웃은 목업 v4 B 방식(어두운 칸 `#111a23` + 상태 색 테두리, 실패 빨강 빗금 ✖).
- [ ] **Step 4: 통과 확인** — `pnpm lint; echo exit=$?` · `pnpm test; echo exit=$?` · `pnpm build; echo exit=$?` 모두 0.
- [ ] **Step 5: 커밋** — `feat(ui): 모니터 전시 화면 (칸·막대·확인 불가)`.

### Task 10: 전체화면·깜빡임·커서·창 모드 도구 줄

**Files:**
- Modify: `ui/src/pages/MonitorDisplayPage.tsx`, `ui/src/components/monitor/MonitorPanel.tsx`
- Test: `ui/src/pages/__tests__/MonitorDisplayPage.fullscreen.test.tsx`

**Interfaces:**
- Consumes: Task 8 `enterFullscreen`/`exitFullscreen`/`isFullscreen`, Task 9 페이지.
- jsdom에는 Fullscreen API가 없다 → 테스트는 `Object.defineProperty(document, "fullscreenElement", { configurable: true, get })` + `document.documentElement.requestFullscreen`/`document.exitFullscreen` spy(Promise 반환) + 상태 변경 시 `document.dispatchEvent(new Event("fullscreenchange"))`. 페이지는 `fullscreenchange`로 전체화면 상태를 갱신한다.

- [ ] **Step 1: 실패 테스트**: `f_key_toggles`, `any_mouse_button_exits`(button 0/1/2 각각), `mousemove_does_not_exit`, `contextmenu_prevented_in_fullscreen`, `toolbar_only_when_windowed`(전체화면 중 `전체화면`·`설정으로`·`점검 정지` 없음, 해제 후 표시), `cursor_hidden_then_shown_on_move`(fake timers: 3초 후 `cursor: none`, mousemove 직후 해제, 3초 뒤 다시), `blink_targets`(fail: fail 칸만; slow_and_fail: fail+slow; config_error·stale·pending은 어느 설정에서도 없음; off: 없음), `polling_continues_after_exit`.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/pages/__tests__/MonitorDisplayPage.fullscreen.test.tsx`.
- [ ] **Step 3: 구현** — 깜빡임 = 1s ease-in-out 배경 밝기 keyframes(초당 3회 이상 번쩍임 금지), `prefers-reduced-motion`이어도 켜져 있으면 유지.
- [ ] **Step 4: 통과 확인** — `pnpm lint; echo exit=$?` · `pnpm test; echo exit=$?` · `pnpm build; echo exit=$?` 모두 0.
- [ ] **Step 5: 커밋** — `feat(ui): 모니터 전체화면·깜빡임·커서 숨김`.

---

## 구현 후 (파이프라인 4–6단계 — task 아님)

- **리뷰 라우팅**: Task 4(동시성)·Task 2(요청 실행) code-quality는 `model: opus`; Task 3(기계적 churn)은 Sonnet.
- **최종 리뷰**: `handicap-reviewer`(와이어 1:1 — Rust `StatusResponse`/`CheckResult`/enum 문자열 ↔ Zod, 50곳 리터럴, 두 시작 경로) + `security-reviewer`(finish-slice §0 grep으로 확정; 중점: 벽 화면 사유에 원문 미노출, 반복 점검 부하 상한 50).
- **bundle 수동 게이트** 재실행.
- **라이브 검증**(`/live-verify`, 필수) — spec §9 US 표(US1·US2·US4·US5·안티골 20초 지연) + **9칸·1920×1080·"크게"/"아주 크게"에서 그래프 표시/숨김 시 제목 `getBoundingClientRect` 높이 동일** + 웹뷰 엔진별 전체화면 실측(Chromium, macOS 데스크톱 앱 WKWebView; Ubuntu WebKitGTK는 못 돌리면 "미검증"). 글자 높이 ±10% 벗어나면 Task 9 비율 fix 커밋.
- **finish**: build-log 단락(증명/미증명 US), roadmap §B — 삭제 가드 보드 참조 연기(비용+해소법), Ubuntu WebKitGTK 전체화면 미검증, ①b·②·③ frontier; 현황판·CLAUDE 상태줄·메모리 `ops-monitor-board` 갱신.
