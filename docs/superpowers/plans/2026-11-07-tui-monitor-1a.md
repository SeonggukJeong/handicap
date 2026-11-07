# TUI 운영 모니터 1a Implementation Plan

REVIEW-GATE: APPROVED

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 구형 Ubuntu(19.04)에서 바이너리 하나로 실행되는 운영 모니터 터미널 화면 `handicap-tui` — 번들 json을 받아 즉시 점검을 시작하고 칸 상태를 GUI와 같은 규칙으로 보여 준다.

**Architecture:** 새 crate `crates/tui`가 컨트롤러를 `run_in_process`로 품고(새 `in-process` 기능), 루프백 REST(`/api/monitor-boards/*`)를 부르는 얇은 클라이언트로 동작한다. UI 루프는 메인 스레드의 동기 루프(crossterm `event::poll`)이고, 컨트롤러·폴러는 tokio 런타임 태스크다. 화면 판정 규칙은 TS에서 Rust로 1:1 이식한다.

**Tech Stack:** Rust 2024(툴체인 1.99.1 고정), ratatui 0.30(crossterm 백엔드 — `ratatui::crossterm` 재수출만 사용, crossterm 직접 의존 금지), reqwest(workspace), tokio, tracing-subscriber(파일 전용), clap, cargo-zigbuild(glibc 2.27 대상).

**Spec:** `docs/superpowers/specs/2026-11-07-tui-monitor-design.md` (ADR-0055). 실행자는 spec과 이 plan을 함께 읽는다.

## Global Constraints

- 대상: `x86_64-unknown-linux-gnu`, glibc ≤ 2.27 심볼만. NEEDED ⊆ {libc, libm, libpthread, libdl, librt, libutil, libgcc_s, ld-linux}.
- 컨트롤러 와이어 0-diff. 컨트롤러 변경은 `Cargo.toml` 기능 정의·`lib.rs`의 `in_process` 게이트 한 줄·그로 인해 처음 lint되는 `in_process.rs`의 clippy 낙진 수정뿐(Task 1).
- `crates/tui`의 `rust-version = "1.88"`(ratatui 0.30.2 요구치 — `cargo info ratatui@0.30.2`; workspace 1.85를 상속하지 않는다). unix 전용 코드(`libc`, 파일 권한)는 `#[cfg(unix)]`.
- reqwest 클라이언트는 `.no_proxy()` — 모니터 PC의 `HTTP(S)_PROXY`가 루프백 호출을 프록시로 보내지 않게.
- 웹 UI(`ui/`) 0-diff. TUI 바이너리는 `bundle` 기능을 켜지 않는다(웹 UI 미내장).
- 터미널에 로그·패닉 기본 출력 금지 — tracing은 파일 전용(`$XDG_STATE_HOME/handicap/tui.log`, 기본 `~/.local/state/handicap/tui.log`, 직전 것은 `tui.log.1`; `--check`는 같은 디렉토리의 `tui-check.log`), 기본 수준 `info`, `RUST_LOG` 우선. 로그 초기화·회전은 **프로세스당 1회**.
- 모든 사용자 노출 문구는 한국어, GUI와 같은 의미의 문구는 `ui/src/i18n/ko.ts` 값을 **그대로** 복사(상태 문구 9종·`N회 연속 · HH:MM:SS부터`·`평균`·`최대`·`서버 응답 없음`). 복사본은 `crates/tui/src/text.rs` 한 곳에만.
- 판정 규칙 상수: `SERVER_DOWN_AFTER = 3`, 폴링 제한 3000 ms, 폴링 주기 1000 ms, 404는 실패로 세지 않음, `nowMs` = 서버 `now_ms`, `budgetSec` = `check_budget_seconds`(없으면 칸 `timeout_seconds`), `DEFAULT_BAR_COLOR = "#22c55e"`.
- `--check` exit: 0 = 모든 칸 결과 수신 · 1 = 기동/가져오기/`start` 실패 · 2 = 대기 상한 초과. 대기 상한 = ⌈실행 단위 수/32⌉ × 칸들의 `check_budget_seconds` 최댓값 + 10초(실행 단위 = 묶음 1개 또는 묶음 없는 칸 1개, 시작한 모든 보드 합산).
- 커밋은 task별 독립 green(pre-commit cargo 게이트 통과). `--no-verify` 금지. 커밋 메시지 끝 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `tdd-guard`: 각 task는 **테스트 파일 편집이 첫 production 편집보다 먼저**.

## Review Focus

1. **Windows에서 편집해 BOM이 붙은 번들 파일** → 정상 가져오기(오류 "1번째 줄 JSON 형식 오류"가 나면 실패). → Task 2 `session_test::bom_file_imports`.
2. **가져오기는 됐는데 `start`가 실패한 뒤 `r` 재시도** → 409 없이 새 DB로 성공, 원래 실패 로그가 같은 `tui.log`에 남음. → Task 2 `session_test::restart_uses_fresh_db` + Task 2 `logging::init_twice_is_noop`.
3. **컨트롤러 백그라운드 태스크 패닉** → 화면 유지·stderr 출력 0(로그 파일에만). → Task 7 `panic_hook_non_ui_thread_keeps_terminal`.
4. **아주 좁거나 낮은 터미널(80×24 미만, 9칸)** → 겹침 없이 "창을 키워 주세요" 안내. → Task 6 `render_too_small`.
5. **서버 폴링이 한두 번만 실패** → 상태가 즉시 `확인 불가`로 바뀌지 않음(3회 연속에서만). → Task 5 `server_down_after_three`.
6. **자리를 비운 사이 잠깐 실패했다 회복(US6)** → 빨간 막대 아래 시각 줄로 대략 몇 시 몇 분인지 읽힘. 가장 좁은 칸(24폭)·짧은 구간(`HH:MM:SS` 8자)·결과가 몇 개뿐인 시작 직후에도 눈금이 겹치거나 잘리지 않음, 칸 안쪽 4줄이어도 시각 줄 유지. → Task 6 `axis_invariants_sweep`·`panel_rows_priority`·`render_min_panel_keeps_axis`.

---

### Task 0: 착수 전 게이트 (코드 변경 없음)

- [x] **해소됨(2026-11-07)** — 사용자: "CPU 아키텍처는 굳이 확인 안 해도 됨. 동일한 모델의 PC에 Windows도 설치해서 사용 중" → x86_64 확정, `uname -m` 확인 생략(spec §10). 이 답을 finish-slice 때 build-log 메모로 남긴다. 구현은 Task 1부터.

### Task 1: 컨트롤러 `in-process` 기능 분리

**Files:**
- Modify: `crates/controller/Cargo.toml` (`[features]`)
- Modify: `crates/controller/src/lib.rs` (`#[cfg(feature = "bundle")] pub mod in_process;` 한 줄)
- Create: `crates/controller/tests/in_process_feature_test.rs`

**Interfaces:**
- Produces: 기능 `in-process = ["dep:handicap-worker", "dep:dirs"]`; `bundle = ["in-process", "dep:rust-embed", "rust-embed/mime-guess", "rust-embed/interpolate-folder-path", "dep:open"]`. `handicap_controller::in_process::{run_in_process, InProcessConfig, RunningController, run_worker_if_invoked}`는 `in-process`에서 노출. `bundle` 모듈·`main.rs`·`app.rs`의 `bundle` 게이트는 **변경 금지**.

- [ ] **Step 1: 실패 테스트** — `in_process_feature_test.rs` 첫 줄 `#![cfg(feature = "in-process")]`, 테스트 `in_process_available_without_bundle`: `InProcessConfig::default()`의 `rest.port() == 0` 단언 + `run_in_process`(tempdir DB, `scheduler_disabled: true`)로 기동 → `GET http://{rest_addr}/api/health`(기존 `run_in_process_serves_health_then_shuts_down`과 같은 경로) 200 → `shutdown()`.
- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller --features in-process --test in_process_feature_test` → `error: ... does not contain this feature: in-process`.
- [ ] **Step 3: 기능 정의 + `lib.rs` 게이트를 `in-process`로**.
- [ ] **Step 4: GREEN + 낙진 처리(spec §10.1)** — 아래 전부 통과:
  - `cargo test -p handicap-controller --features in-process --test in_process_feature_test`
  - `cargo test -p handicap-controller --features in-process --lib in_process` (기존 in_process 단위 테스트가 처음으로 이 경로에서 돈다)
  - `cargo clippy -p handicap-controller --features in-process --all-targets -- -D warnings` (경고가 나오면 이 task에서 수정)
  - GUI 무영향: `cd ui && pnpm build` 후 `cargo build -p handicap-controller --features bundle` 성공, 그리고 `cargo tree -p handicap-controller --features bundle -e features | grep 'feature "in-process"'` 1줄 이상.
  - 기본 빌드 무영향: `cargo build -p handicap-controller` 성공.
- [ ] **Step 5: 커밋** — `feat(controller): in_process를 in-process 기능으로 분리 (bundle이 포함)`.

### Task 2: `crates/tui` 골격 + 부트스트랩(로그·임시 DB·세션·API)

**Files:**
- Create: `crates/tui/Cargo.toml` (bin `handicap-tui`, lib `handicap_tui`, `rust-version = "1.88"`; deps: `handicap-controller = { path, features = ["in-process"] }`, `ratatui = "0.30"`, workspace `tokio`·`reqwest`·`serde`·`serde_json`·`tracing`·`tracing-subscriber`·`clap`·`anyhow`·`chrono`(Task 4 `format_hms`), `libc`(pid 생존 확인); dev: `tempfile`, workspace `wiremock`)
- Create: `crates/tui/src/{main.rs, lib.rs, cli.rs, logging.rs, tempdb.rs, api.rs, wire.rs, session.rs}`
- Create: `crates/tui/tests/session_test.rs`, `crates/tui/tests/fixtures/bundle_template.json`

**Interfaces:**
- Consumes: Task 1의 `in_process` API.
- Produces:
  - `cli::Command { Run { file: PathBuf }, Check { file: PathBuf }, Usage }`; `cli::parse<I: IntoIterator<Item = OsString>>(args: I) -> Result<Command, clap::Error>` (`--version`/`--help`는 clap 기본 동작).
  - `logging::LogLoc { Path(PathBuf), Unavailable(String) }` (화면·패닉 훅이 받는 로그 위치 — 실패 시 `Unavailable(원인)`을 `로그 없음: <원인>`으로 표시).
  - `logging::state_dir() -> PathBuf`; `logging::init(dir: &Path, file_name: &str) -> anyhow::Result<PathBuf>` — 화면 모드는 `tui.log`, `--check`는 `tui-check.log`(돌고 있는 TUI의 로그를 회전시키지 않게). 첫 호출만 회전·설치, 이후 호출은 같은 경로를 돌려주는 no-op. 필터는 `EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))`. **실패 시**(디렉토리 쓰기 불가 등) 호출부는 구독자 없이 계속 진행하고 도움말·오류 화면의 로그 경로 자리에 `로그 없음: <원인>`을 보인다.
  - `tempdb::runtime_dir() -> PathBuf` (`$XDG_RUNTIME_DIR` 없으면 `std::env::temp_dir()`); `tempdb::TempDb::create(dir: &Path) -> io::Result<TempDb>` — 이름 `handicap-tui-<pid>-<seq>.db`(seq = 프로세스 내 증가 카운터), **0600으로 먼저 생성**; `TempDb::path() -> &Path`; `Drop`이 `.db`·`-wal`·`-shm` 삭제; `tempdb::sweep_stale(dir: &Path) -> usize` — 살아 있지 않은 pid의 `handicap-tui-*` 파일 삭제.
  - `wire::{StatusResponse, PanelStatus, BoardResponse}` (필드는 `crates/controller/src/api/monitor_boards.rs`의 같은 이름 구조체와 1:1, `Deserialize` + **`#[serde(deny_unknown_fields)]`** — 서버가 필드를 늘리면 통합 테스트가 RED가 되어 거울 드리프트를 잡는다). 재사용: `handicap_controller::monitor::{check::CheckResult, config::BoardConfig, transfer::ImportResult}`.
  - `api::Api::new(base: SocketAddr) -> Api` (reqwest `.no_proxy()`); `async fn import(&self, body: Vec<u8>) -> Result<ImportResult, ApiError>` (`Content-Type: application/json` 필수 — 없으면 415, `monitor_transfer.rs` `require_json`); `async fn start(&self, id: &str) -> Result<(), ApiError>`; `async fn board(&self, id: &str) -> Result<BoardResponse, ApiError>`; `async fn status(&self, id: &str) -> Result<StatusResponse, ApiError>`(요청 제한 3000 ms). `ApiError { status: Option<u16>, message: String }` — 4xx/5xx면 응답 `{"error": …}`의 문자열, 연결/시간초과면 `status: None`.
  - `session::strip_bom(b: &[u8]) -> &[u8]`; `session::import_body(file: &[u8]) -> Vec<u8>` (= `{"bundle":` + strip_bom(file) + `}`, 재직렬화 금지).
  - `session::Stage { ReadFile, Controller, Import, StartBoard }`; `session::StartError { stage: Stage, message: String, rest_addr: Option<SocketAddr> }` (`rest_addr` = 컨트롤러가 떴다면 그 주소 — 진단·정리 검증용).
  - `Session` 필드 순서: 컨트롤러 핸들이 `TempDb`보다 **먼저** drop되도록 선언(풀이 닫힌 뒤 파일 삭제).
  - `session::BoardRef { id: String, name: String }`; `session::Session { pub api: Api, pub boards: Vec<BoardRef>, pub file: PathBuf, .. }`; **`async fn Session::start(file: &Path, db_dir: &Path) -> Result<Session, StartError>`** (임시 DB 생성 → `run_in_process{db, scheduler_disabled: true}` → 파일 읽기 → import → 모든 보드 start); **`async fn Session::shutdown(self)`** (컨트롤러 shutdown 후 TempDb drop). **컨트롤러가 뜬 뒤 실패하면 `Err`를 돌려주기 전에 반드시 컨트롤러 `shutdown()` + TempDb drop** — 안 하면 serve 태스크·이미 start된 감독자가 남고 `r` 재시도 시 두 컨트롤러가 같은 보드를 점검한다.
  - 단계 매핑·문구(한국어, `text.rs`가 아니라 `session.rs` 상수 — Task 4 이전이므로): TempDb 생성·컨트롤러 기동 실패 = `Stage::Controller`("점검 엔진을 시작하지 못했습니다: …"), 파일 io 오류 = `Stage::ReadFile`(`NotFound` → "파일을 찾을 수 없습니다", `PermissionDenied` → "파일을 읽을 권한이 없습니다", 그 외 → "파일을 읽을 수 없습니다"), import 4xx = `Stage::Import`(서버 `error` 문자열 그대로), start 실패 = `Stage::StartBoard`.
  - `main.rs` 호출 순서(spec §4.2·§4.3): `run_worker_if_invoked()` → `cli::parse` → `logging::init(&logging::state_dir(), 모드별 파일명)` → `tempdb::sweep_stale(&tempdb::runtime_dir())` → 모드 분기. 이 task의 `Run`/`Check`는 런타임에서 `Session::start` → 성공 시 stdout에 "가져온 보드 N개" 출력 후 shutdown, 실패 시 stdout에 단계·문구 출력 후 exit 1 (임시 동작, Task 5·7에서 대체).

- [ ] **Step 1: 실패 테스트** — `session_test.rs`(`#[tokio::test(flavor = "multi_thread")]`; fixture: `bundle_template.json`은 시나리오 1개·환경 1개(`BASE_URL = "__BASE__"`)·보드 1개·칸 1개(주기 1초)짜리 유효 번들, 정규 ULID. 시나리오 스텝은 `url: ${BASE_URL}/` + **`assert:\n  - status: 200`**(없으면 503도 `ok` 판정 — `check.rs` `status_mismatch`; YAML 형태는 `crates/controller/tests/monitor_boards_api_test.rs` 시나리오 문자열을 본뜸). 테스트가 `__BASE__`를 wiremock 주소로 치환해 tempdir에 씀):
  - `imports_and_starts_all_boards` — `Session::start` 성공, `boards.len() == 1`, **10초** 안에 `api.status(id)`의 `panels[0].results.len() >= 1`(wire 거울 타입 역직렬화 + `deny_unknown_fields`로 1:1 증명).
  - `bom_file_imports` — 같은 파일 앞에 `EF BB BF` → 성공.
  - `bad_json_is_import_stage_error` — `{` 한 글자 파일 → `Err(StartError{stage: Import, ..})`, message에 서버 문구 `JSON 형식 오류` 포함. **+ 정리 확인**: `err.rest_addr`가 `Some`이고 그 주소로 TCP 연결이 거부됨(컨트롤러 shutdown 증명), 임시 DB 파일 부재(테스트용으로 `Session::start`가 쓴 DB 디렉토리를 인자로 받으므로 그 디렉토리에 `handicap-tui-*` 0개).
  - `missing_file_is_read_stage_error` → `Stage::ReadFile`.
  - `restart_uses_fresh_db` — 같은 파일로 `start` → `shutdown` → 다시 `start` 성공(두 번째 TempDb 경로가 첫 번째와 다름).
  - `new_file_with_added_panel_starts_both` (US5) — 칸 1개 파일로 start → shutdown → 같은 보드 id에 칸을 하나 더한 파일로 교체 → start 성공, `api.board(id)`의 `config.panels.len() == 2`(겹침 409 없음).
  - 단위(`#[cfg(test)]`): `strip_bom` 3케이스(있음/없음/빈), `import_body` 바이트 정확성, `cli::parse` 4케이스(파일 / `--check 파일` / 인자 없음=Usage / `--version`은 `clap::error::ErrorKind::DisplayVersion`), `tempdb::create_is_0600`(unix mode `0o600`), `tempdb::drop_removes_wal_shm`, `tempdb::sweep_stale_skips_live_pid`(자기 pid 파일은 남고 존재하지 않는 pid(예: `i32::MAX`) 파일은 삭제), `logging::init_twice_is_noop`(두 번째 호출이 패닉 없이 같은 경로, `tui.log.1`이 두 번째 호출로 생기지 않음).
- [ ] **Step 2: RED 확인** — `cargo test -p handicap-tui` → 컴파일 실패(모듈 없음).
- [ ] **Step 3: 구현** (위 Interfaces). 로그 구독자는 `tracing_subscriber::fmt().with_writer(파일).with_ansi(false)` + 위 Interfaces의 `EnvFilter` 식; `OnceLock<PathBuf>`로 1회 보장.
- [ ] **Step 4: GREEN** — `cargo test -p handicap-tui` 전부 통과, `cargo clippy -p handicap-tui --all-targets -- -D warnings`, workspace 전체 `cargo build --workspace`(in-process 통합 후 다른 crate 무영향) 통과.
- [ ] **Step 5: stderr 0 확인** — `session_test::start_writes_nothing_to_stderr`: `std::process::Command::new(env!("CARGO_BIN_EXE_handicap-tui")).args(["--check", fixture])`(HOME·XDG_STATE_HOME·XDG_RUNTIME_DIR을 tempdir로, 대상은 wiremock) 실행 → stderr 바이트 0, 종료 0, `XDG_STATE_HOME/handicap/tui-check.log` 존재·비어 있지 않음, `tui.log`는 생기지 않음. **`--check`를 쓰는 이유**: Task 7 이후 파일 인자만 주면 전체 화면 TUI라 TTY 없는 테스트에서 못 돈다 — `--check`는 Task 5에서 실제 동작으로 바뀌어도 화면 없이 종료하므로 이 테스트가 그대로 산다(Task 5에서 이 테스트를 다시 돌려 확인).
- [ ] **Step 6: 커밋** — `feat(tui): handicap-tui 골격 — 로그·임시 DB·세션·루프백 API`.

### Task 3: glibc 2.27 빌드 스파이크 (STOP 게이트)

**Files:**
- Create: `scripts/tui-linux-build.sh` (zigbuild 빌드 → `target/x86_64-unknown-linux-gnu/release/handicap-tui`)
- Create: `scripts/tui-linux-gates.sh <binary>` (Linux 전용: ① `objdump -T`의 `GLIBC_x.y` 최댓값 ≤ 2.27 ② `readelf -d` NEEDED ⊆ Global Constraints 집합; 위반 시 exit 1과 위반 목록 출력)

**Interfaces:**
- Produces: 두 스크립트(Task 8 CI가 그대로 호출). 스크립트 머리 주석에 **이 task에서 실제로 성공한 zig·cargo-zigbuild 버전**을 고정 기록하고, 스크립트가 버전 불일치 시 경고.

- [ ] **Step 1: 도구 준비(macOS 로컬)** — `rustup target add x86_64-unknown-linux-gnu`, zig 설치(`brew install zig`), `cargo install cargo-zigbuild --locked`. 설치된 버전을 기록.
- [ ] **Step 2: 빌드** — `scripts/tui-linux-build.sh` = `cargo zigbuild --release -p handicap-tui --target x86_64-unknown-linux-gnu.2.27`. 실패하면 **폴백**: `docker run --platform linux/amd64 ubuntu:18.04` 안에서 rustup(툴체인 1.99.1) + protoc **릴리즈 바이너리**(apt 판 3.0.x는 proto3 `optional` 불가) + `cargo build --release -p handicap-tui`. 둘 다 실패 → **STOP, 오류 전문과 함께 사용자에게 보고**(Task 4–7은 빌드 방식과 독립이라 계속 가능 여부를 사용자에게 물음).
- [ ] **Step 3: 게이트** — `docker run --rm --platform linux/amd64 -v "$PWD":/w -w /w ubuntu:24.04 sh -c 'apt-get update -qq && apt-get install -y -qq binutils >/dev/null && scripts/tui-linux-gates.sh target/x86_64-unknown-linux-gnu/release/handicap-tui'; echo exit=$?` → `exit=0`. 게이트 이빨: 일부러 `--target x86_64-unknown-linux-gnu`(버전 접미사 없음, 호스트 glibc 최신 심볼)로 빌드한 바이너리에 게이트를 돌리면 exit 1이어야 함 — 안 되면 게이트 스크립트를 고친다(macOS에선 zig 기본 glibc가 2.28+일 수 있으니 RED가 안 나오면 `.2.39` 접미사로 대체 실증).
- [ ] **Step 4: 19.04 실행** — `docker run --rm --platform linux/amd64 -v "$PWD/target/x86_64-unknown-linux-gnu/release":/b ubuntu:19.04 /b/handicap-tui --version; echo exit=$?` → 버전 줄 + `exit=0`.
- [ ] **Step 5: 커밋** — `build(tui): glibc 2.27 대상 Linux 빌드·게이트 스크립트`.

### Task 4: 화면 판정 규칙 이식 (`judge.rs`·`text.rs`)

**Files:**
- Create: `crates/tui/tests/judge_parity_test.rs` (**첫 편집 — tdd-guard**: `lib.rs`에 `pub mod` 추가가 production 편집이라 그 전에 `tests/` 파일이 pending이어야 한다), `crates/tui/src/judge.rs`, `crates/tui/src/text.rs`
- Modify: `crates/tui/src/lib.rs` (`pub mod judge; pub mod text;`)

**Interfaces:**
- Produces (`judge`):
  - `enum PanelState { Ok, Slow, Fail, ConfigError, Blocked, Skipped, Stale, StaleOff, Pending }`
  - `const DEFAULT_BAR_COLOR: &str = "#22c55e"`
  - `fn format_ms(ms: f64) -> String` (`"1,350 ms"`), `fn format_stat_num(ms: f64) -> String` (`"1,350"`)
  - `fn bar_color<'a>(latency_ms: u64, thresholds: &'a [Threshold]) -> &'a str` (기본값은 `DEFAULT_BAR_COLOR`)
  - `fn stale_after_ms(interval_sec: u32, budget_sec: u32) -> i64`
  - `struct PanelStateInput<'a> { latest: Option<&'a CheckResult>, now_ms: i64, started_at_ms: Option<i64>, enabled: bool, server_down: bool, interval_sec: u32, budget_sec: u32, thresholds: &'a [Threshold] }`; `fn panel_state(i: &PanelStateInput) -> PanelState`
  - `fn bar_slots(results: &[CheckResult], bar_count: usize) -> Vec<Option<&CheckResult>>`
  - `fn latency_stats(results: &[CheckResult]) -> Option<(u64, u64)>` (avg 반올림, max)
  - `fn show_consecutive(n: u32) -> bool`
  - `fn big_value_text(state: PanelState, latest: Option<&CheckResult>) -> String`
  - `fn grid_for(n: usize) -> (usize, usize)` (cols, rows)
  - `fn split_reason(reason: &str) -> (String, Option<String>)`; `enum ReasonParts { Split { fixed: String, step: Option<String> }, Detail { big: String, small: String }, NotContained { needle: String, small: String } }`; `fn reason_parts(reason: &str, detail: Option<&str>) -> ReasonParts` — 의미는 `ui/src/monitor/display.ts`의 `splitReason`/`reasonParts` 그대로.
  - `fn format_hms(ms: i64) -> String` (로컬 시각 `HH:MM:SS`, chrono `Local`), `fn format_hm(ms: i64) -> String` (로컬 시각 `HH:MM`, 시각 줄용 — spec §5.1 US6)
- Produces (`text`): `fn state_label(s: PanelState) -> &'static str`, `fn consecutive(n: u32, hms: &str) -> String`, `const STATS_AVG`, `const STATS_MAX`, `const SERVER_DOWN`, `const NO_VALUE: &str = "—"`(`ko.monitor.noValue`).

- [ ] **Step 1: 실패 테스트(1:1 대조표)** — `tests/judge_parity_test.rs`에 공개 API로 작성. TS 원본을 열어 같은 입력·기대값으로 옮긴다. 테스트 이름 = TS 이름의 snake_case:

  | TS (`ui/src/monitor/__tests__/`) | Rust 테스트 |
  |---|---|
  | logic `formatMs_integer_commas` | `format_ms_integer_commas` |
  | logic `barColor_highest_crossed` | `bar_color_highest_crossed` |
  | logic `slots_right_fill`·`slots_evict_oldest` | 동명 snake_case |
  | logic `state_slow_uses_current_thresholds`·`state_fail_and_config_error`·`stale_after_grace`·`panelState_new_states`·`stale_outranks_new_states`·`stale_uses_budget`·`pending_until_grace_after_start`·`stale_off_when_disabled`·`server_down_forces_stale` | 동명 snake_case |
  | logic `grid_table`·`big_value_text_cases`·`consecutive_threshold` | 동명 |
  | logic latencyStats 4케이스 | `latency_stats_avg_max_rounded`·`latency_stats_includes_slow`·`latency_stats_excludes_fail_config_null`·`latency_stats_none_when_empty` |
  | display `split_reason_at_first_separator`·`reason_parts_without_detail_splits_as_before`·`reason_parts_detail_never_splits`·`reason_parts_not_contained_three_conditions` | 동명 |
  | (시각 형식, TUI 전용 — US6) | `format_hm_shape`: 임의 ms 몇 개에 대해 `format_hm(ms).len() == 5`·`format_hm(ms) == format_hms(ms)[..5]`·`format_hms(ms)`가 `dd:dd:dd` 모양(TZ 무관) |
  | (ko.ts 값) | `text_labels_match_ko`: 9개 상태 문구·`consecutive(4,"09:39:51") == "4회 연속 · 09:39:51부터"`·`STATS_AVG == "평균"`·`STATS_MAX == "최대"`·`SERVER_DOWN == "서버 응답 없음"`·`NO_VALUE == "—"` |

  (TS의 `axis_labels`·`font_scale`·focus 계열은 GUI 전용이라 제외.)
- [ ] **Step 2: RED** — `cargo test -p handicap-tui --test judge_parity_test` → 컴파일 실패.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: GREEN + 이빨 1건 실증** — `panel_state`의 `server_down` 분기를 주석 처리 → `server_down_forces_stale` RED → 원복 → GREEN. 결과를 커밋 메시지 본문에 한 줄.
- [ ] **Step 5: 커밋** — `feat(tui): 화면 판정 규칙 TS→Rust 1:1 이식`.

### Task 5: 폴러 + 서버 끊김 판정 + `--check`

**Files:**
- Create: `crates/tui/src/poll.rs`, `crates/tui/src/check_mode.rs`
- Modify: `crates/tui/src/main.rs` (`Command::Check` → `check_mode::run`)
- Create: `crates/tui/tests/check_mode_test.rs`

**Interfaces:**
- Consumes: Task 2 `Session`·`Api`·`wire`, Task 4 `judge`·`text`.
- Produces:
  - `poll::PollOutcome { Ok(StatusResponse), NotFound, Failed }`; `poll::ServerDownTracker::default()`, `fn record(&mut self, o: &PollOutcome)` (Ok → 0으로 리셋, Failed → +1, NotFound → 변화 없음), `fn is_down(&self) -> bool` (≥ 3).
  - `poll::spawn_poller(api: Api, board: watch::Receiver<String>, tx: watch::Sender<PollSnapshot>) -> JoinHandle<()>` — 1000 ms마다 현재 board id의 `status`를 부르고 `PollSnapshot { board_id: String, last: Option<StatusResponse>, server_down: bool }`를 보냄(보이는 보드만 폴링).
  - `check_mode::count_units(cfg: &BoardConfig) -> usize` (묶음 id 고유 개수 + `group_id == None` 칸 수); `check_mode::wait_cap_secs(units: usize, max_budget: u32) -> u64`; **`async fn check_mode::run_with_cap(file: &Path, db_dir: &Path, cap: Option<Duration>) -> (i32, String)`**(출력 문자열 반환; `cap=None`이면 공식으로 계산 — 실행 단위는 `api.board(id)`의 config로 세고, `max_budget`은 **첫 `/status` 응답**의 `check_budget_seconds` 최댓값); 동기 진입점 `check_mode::run(file: &Path) -> i32`는 `main`에서만 쓰며 자체 런타임을 만든다(테스트는 `#[tokio::test]`에서 async 판을 직접 await — 런타임 중첩 금지).
  - 출력 형식: 칸마다 `"{보드 이름} / {칸 제목}  {state_label}  {big_value_text}"` 한 줄(상태 판정은 `panel_state`, `server_down=false`).

- [ ] **Step 1: 실패 테스트** — 단위: `server_down_after_three`(Failed 2회 → false, 3회 → true), `not_found_does_not_count`(Failed 2 + NotFound 5 → false), `ok_resets`, `count_units_groups_and_singles`(묶음 2개(칸 3개) + 단독 2칸 → 4), `wait_cap_formula`(`(33, 5) → 2*5+10 = 20`, `(1, 152) → 162`). 통합(`check_mode_test.rs`, wiremock + Task 2 fixture): `check_ok_exit0`(200 응답 → exit 0, 출력에 `✔ 정상`), `check_503_still_exit0`(503 → exit 0, 출력에 `✖ 실패`), `check_bad_file_exit1`, `check_cap_exceeded_exit2`(응답기 지연 5 s + `run_with_cap(…, 1s)` → 2).
- [ ] **Step 2: RED** — `cargo test -p handicap-tui` 실패 확인.
- [ ] **Step 3: 구현** — `--check`는 1초 간격 `status` 폴링, 모든 보드의 모든 칸 `results.len() >= 1`이면 출력 후 0, 상한 넘으면 2, `Session::start` 실패면 `StartError` 문구 출력 후 1. 종료 전 `Session::shutdown`.
- [ ] **Step 4: GREEN** — `cargo test -p handicap-tui`(Task 2의 `start_writes_nothing_to_stderr`가 실제 `--check`로도 green인지 포함), clippy.
- [ ] **Step 5: 커밋** — `feat(tui): 상태 폴러·서버 끊김 판정·--check 모드`.

### Task 6: 화면 렌더링 (`view/`)

**Files:**
- Create: `crates/tui/tests/view_test.rs` (**첫 편집 — tdd-guard**, 공개 API + ratatui `TestBackend`), `crates/tui/src/view/{mod.rs, model.rs, axis.rs, monitor.rs, overlay.rs, error.rs}`
- Modify: `crates/tui/src/lib.rs` (`pub mod view;`)
- 테스트 헬퍼 `buffer_text(buf: &Buffer) -> String`(행마다 셀 심볼을 잇되 넓은 문자 뒤 빈 채움 셀은 건너뜀 — 그냥 이으면 `창을 키워 주세요`가 매치되지 않는다)

**Interfaces:**
- Consumes: Task 4 `judge`·`text`, Task 5 `PollSnapshot`, Task 2 `StartError`·`BoardResponse`.
- Produces:
  - `model::PanelView { title, state: PanelState, label: &'static str, big: BigValue, consecutive: Option<String>, bars: Vec<Bar>, stats: Option<String>, display: Vec<String> }`; `enum BigValue { Text(String), Reason(ReasonParts) }`; `struct Bar { glyph: char, color: Color, at_ms: Option<i64> }`(`at_ms` = 그 슬롯 결과의 `CheckResult.at_ms`, 빈 슬롯 `None` — 시각 줄 재료).
  - `model::build_panels(board: &BoardResponse, snap: &PollSnapshot) -> Vec<PanelView>` — `started_at_ms`·`now_ms`·`enabled`는 `snap.last`(status)에서. 호출부 규칙(spec §4.4): 첫 status 전은 `server_down ? Stale : Pending`, 연속 줄은 `state == Fail && show_consecutive && fail_since_ms.is_some()`, 평균·최대 줄은 `show_latency_stats && state ∈ {Ok, Slow, Fail}`, 실패류 큰 값은 `reason_parts(reason, detail)`. `display` = `display_items` 개수(최대 2)만큼, 최신 결과의 `display[i]`가 `None`·빈 문자열이면 `text::NO_VALUE`(`—`)로 채운다(GUI `MonitorPanel.tsx` `shownAt`). 실패류 칸에서만 전부 비어 있으면 줄을 생략(GUI와 같음 — ok/slow 칸은 `—`를 그대로 보임), 칸 높이가 남을 때만 그린다.
  - 막대: `bar_slots(results, bar_count)`의 최신 쪽 `width`개. ok/slow = 높이 `clamp(round(latency/graph_max_ms*8), 1, 8)`의 블록 문자(`▁▂▃▄▅▆▇█`) + `bar_color` 색, fail = `█` 빨강 `#ef4444`(GUI `LatencyBars.tsx` 줄무늬의 밝은 색을 단색으로), config_error·upstream_failed·branch_skipped = `·` 회색 `#475569`(GUI도 config_error 막대는 회색 — spec §5.1도 같이 정정됨), 빈 슬롯 = 공백.
  - `fn parse_hex(s: &str) -> Option<Color>` (`#rrggbb` → `Color::Rgb`).
  - **시각 줄(spec §5.1 US6)** — `axis::Mark { start: u16, text: String }`; `fn axis::axis_marks(times: &[Option<i64>], label: &dyn Fn(i64) -> String) -> Vec<Mark>` (순수, `times` = 화면에 보이는 막대 슬롯의 `at_ms` 왼→오, 폭 = `times.len()`; 시각 → 글자는 인자로 받아 TZ와 무관하게 테스트). 규칙: 결과(`Some`)가 없거나 폭 < 라벨 길이면 빈 vec · 빈 슬롯은 왼쪽에만 있다(`bar_slots` 앞 채움 → 마지막 슬롯 `w−1`이 최신) · **왼쪽 끝** = 첫 `Some` 슬롯 `f`의 시각, `start = min(f, w − len)`(폭을 넘으면 끝에 붙임 — 결과 1개면 이것이 곧 오른쪽 정렬) · **오른쪽 끝** = 마지막 슬롯 `w−1`의 시각, `start = w − len` — 왼쪽 눈금 끝과 2칸 이상 못 띄우거나 글자가 같으면 생략(왼쪽 유지) · **중간** = 그 사이 `Some` 슬롯을 중심으로 한 눈금을 왼→오 탐욕 배치(앞 눈금 끝과 2칸 이상, 바로 앞 눈금과 글자 다름, 오른쪽 끝 눈금이 있으면 그 시작과 2칸 이상·**그 글자와도 다름**, 없으면 끝 ≤ `w`; 간격 선택은 구현 재량) · 모든 눈금은 `[0, len(times))` 안. `fn axis::axis_uses_seconds(visible_slots: usize, interval_sec: u32) -> bool` (명목 구간 `visible_slots.saturating_sub(1) × interval_sec < 600`초, 곱은 `u64`로 — 실측 `at_ms` 차이를 쓰지 않는다: 10분 근처 ms 흔들림으로 매초 형식이 바뀌는 깜박임 방지, spec §5.1). `fn axis::axis_line(times, label) -> String`(폭만큼 공백 위에 눈금을 얹은 한 줄). **보이는 막대 잘라내기는 `monitor::render`에서**(`build_panels`는 폭을 모른다 — `PanelView.bars`는 `bar_slots` 전체): `visible = min(bars.len(), 안쪽 폭)`개의 최신 쪽을 칸 안쪽 **왼쪽부터** 막대 줄에 그리고, 시각 줄도 같은 x 범위에 `axis_line(그 visible의 at_ms…)`. 렌더는 `label = if axis_uses_seconds(visible, panel.interval_seconds) { format_hms } else { format_hm }`(Task 4; `visible` = 위의 `min(bars.len(), 안쪽 폭)`, 빈 슬롯 포함 — spec "보이는 막대 칸 수"), 색은 GUI 축 글자색 `#7b8794`(`ui/src/monitor/display.ts` `COLOR.axis`).
  - **줄 우선순위** — `model::Row { Status, ReasonSmall, Consecutive, Bars, Axis, Stats, Display(usize) }`; `fn model::panel_rows(inner_h: u16, has_reason_small: bool, has_consecutive: bool, has_stats: bool, n_display: usize) -> Vec<Row>` (순수): 우선순위 Status > Bars > Axis > Consecutive > ReasonSmall > Stats > Display(0) > Display(1)(spec §5.1 — 사용자 승인 순서에 ReasonSmall을 Consecutive 다음에 끼움)로 `inner_h`줄만 고르고 **화면 순서**(Status, ReasonSmall, Consecutive, Bars, Axis, Stats, Display…)로 반환. `ReasonSmall` = `BigValue::Reason`의 작은 부분(`Split.step`이 `Some`일 때 그것, `Detail`/`NotContained`의 `small`) — GUI `MonitorPanel.tsx` `smallLine`처럼 큰 값 아래 별도 줄, 안쪽 폭에서 잘림. 렌더는 이 결과대로만 그린다(위 `display` "칸 높이가 남을 때만"은 이 함수가 결정).
  - `monitor::Layout { panels: Vec<Rect> }`; `fn layout(area: Rect, n: usize) -> Result<Layout, TooSmall>` — `grid_for` 격자, 머리 줄 1행·키 안내 줄 1행 제외, 칸 최소 24×6(미달 → `TooSmall { have: (u16,u16), need: (u16,u16) }`).
  - `fn panel_at(layout: &Layout, x: u16, y: u16) -> Option<usize>` (테두리 포함 칸 사각형 기준).
  - `monitor::render(f: &mut Frame, s: &MonitorScreen)` — `MonitorScreen { board_name, board_pos: (usize, usize), server_time: Option<i64>, server_down: bool, panels: Vec<PanelView>, selected: usize }`. 선택 칸은 굵은 테두리(`BorderType::Thick`).
  - `overlay::render_help(f, file: &Path, log: &LogLoc)`(키 표 + 파일·로그 경로 + "글자 복사는 Shift+드래그"), `overlay::render_quit_confirm(f)`(`종료할까요? y 종료 · 다른 키 취소`).
  - `error::render_error(f, e: &StartError, file: &Path, log: &LogLoc)`(단계별 제목 + 메시지 + 경로 + `r 다시 시도  q 종료`), `error::render_usage(f)`(사용법 `handicap-tui <보드 파일.json>` + 매뉴얼 위치 "함께 받은 tui-monitor.md").
  - 키 안내 줄 문구(정확히): 모니터 `←↑↓→ 칸 이동  Tab 다음 보드  ? 도움말  q 종료`(보드 1개면 `Tab 다음 보드` 생략), 오류 화면 `r 다시 시도  q 종료`, 도움말 `Esc 닫기`.

- [ ] **Step 1: 실패 테스트** — `build_panels_*`: ok 칸(큰 값 `182 ms`·평균 줄), fail 칸 연속 4회(`4회 연속 · …부터` 포함·평균 줄 있음), stale 칸(평균 줄 없음), 첫 status 전 pending/stale 분기, `show_latency_stats=false` → 평균 줄 없음. `layout_grid_3_is_3x1`, `render_too_small`(9칸·60×15 → 버퍼에 `창을 키워 주세요` 포함, 칸 테두리 문자 없음), `panel_at_hits_and_misses`(칸 내부·테두리·머리 줄·칸 사이 경계), `render_monitor_contains`(80×24·3칸 → 상태 문구 3종·키 안내 줄 정확 문구·선택 칸 Thick 테두리 문자 `┏`), `render_key_bar_single_board_omits_tab`, `render_error_import`(StartError Import → 서버 문구·`r 다시 시도  q 종료`), `render_help_has_paths`, `render_quit_confirm_text`, `display_missing_value_shows_dash`, `parse_hex_cases`. 시각 줄·줄 우선순위(라벨 함수는 테스트 내 고정 클로저, 예: `|ms| format!("{:02}:{:02}", ms / 3_600_000 % 24, ms / 60_000 % 60)`): `axis_empty_when_no_results`(전부 `None` → 빈 vec), `axis_single_result_right_aligned`(폭 10, 마지막만 `Some`, 라벨 5자 → 눈금 1개 `start == 5`), `axis_few_results_clamped`(폭 26, 마지막 3개만 `Some`, 라벨 5자 → 첫 눈금 `start == 21`, 글자 == 가장 오래된 결과), `axis_ends_and_middle`(폭 26, 전부 `Some`·60 s 간격 → 첫 눈금 `start == 0`, 마지막 눈금 끝 == 26, 중간 눈금 ≥ 1), `axis_too_narrow_keeps_left`(폭 12, 전부 `Some`(첫 `Some` = 0), 8자 라벨 → 눈금 1개 `start == 0`), `axis_duplicate_text_skipped`(폭 26, 모든 시각이 같은 분 → 눈금 1개), `axis_middle_differs_from_right`(폭 60, 1 s 간격, `HH:MM` 라벨, **앞 3슬롯만 분 M·나머지 57슬롯은 M+1** → 중간 후보는 왼쪽(M)과 다르고 오른쪽(M+1)과 같으므로 눈금은 정확히 2개 — "오른쪽 끝 글자와도 다름" 규칙 없이는 3개 이상), **`axis_invariants_sweep`**(폭 1..=60 × 앞쪽 `None` 개수 0..=폭 × 라벨 5자·8자 × 시각 간격 {1 s, 5 s, 60 s, 고르지 않음(예: 1·1·47·1·120 s 반복)} 전수: 눈금끼리 겹침 없음·간격 ≥ 2·전부 폭 안·각 눈금 범위 안에 `label(times[k]) == text`인 `Some` 슬롯 `k` 존재·이웃 눈금 글자 다름·`Some`이 있고 폭 ≥ 라벨 길이면 눈금 ≥ 1이고 첫 눈금 `start == min(첫 Some, 폭 − 라벨 길이)`·첫 눈금 글자 == `label(첫 Some 시각)`·`첫 Some + 2×길이 + 2 ≤ 폭`이고 양 끝 시각 글자가 다르면 마지막 눈금 끝 == 폭), `axis_seconds_threshold`(`(21, 30) → false`(600 s), `(20, 30) → true`(570 s), `(2, 599) → true`, `(2, 600) → false`, `(0, 30)`·`(1, 30) → true`(패닉 없음)), `panel_rows_priority`(인자 `(inner_h, reason_small, consecutive, stats, n_display)`: `(1, t, t, t, 2)` → `[Status]`, `(2, t, t, t, 2)` → `[Status, Bars]`, `(3, t, t, t, 2)` → `[Status, Bars, Axis]`, `(4, t, t, t, 2)` → `[Status, Consecutive, Bars, Axis]`, `(4, t, f, t, 2)` → `[Status, ReasonSmall, Bars, Axis]`, `(5, t, t, t, 2)` → `[Status, ReasonSmall, Consecutive, Bars, Axis]`, `(5, f, f, t, 2)` → `[Status, Bars, Axis, Stats, Display(0)]`, `(6, f, t, t, 2)` → `Display(1)` 없음, `(9, t, t, t, 2)` → 8줄 전부 화면 순서), `render_axis_shows_bar_times`(80×24·3칸, `bar_count`·`interval_seconds`로 명목 구간 ≥ 10분과 < 10분 두 경우 → 버퍼에 **가장 오래된 보이는 결과**의 `judge::format_hm` / `format_hms` 문자열(왼쪽 끝 눈금은 항상 그려진다) — `format_hm` 모양 자체는 Task 4 `format_hm_shape`가 고정), `render_min_panel_keeps_axis`(칸 1개가 최소 24×6이 되는 터미널, **실패 칸**: 연속 실패 ≥ 2·사유에 스텝부·`show_latency_stats = true` → 상태 문구·`N회 연속` 줄·막대·시각 문자열이 버퍼에 있고 사유 작은 줄(스텝부)·평균 줄은 없음).
- [ ] **Step 2: RED** → **Step 3: 구현** → **Step 4: GREEN** (`cargo test -p handicap-tui --test view_test` + `cargo test -p handicap-tui --lib`, clippy). **이빨 1건 실증**: `axis_marks`의 **오른쪽 끝** 눈금 간격 검사(왼쪽 눈금 끝과 2칸 이상)를 1칸으로 바꾸면 `w = f + 2L + 1`에서 간격 1인 눈금이 생겨 `axis_invariants_sweep` RED(결정적 — 중간 눈금 간격은 구현 재량이라 그쪽 약화는 RED가 보장되지 않는다) → 원복 → GREEN. 그리고 중간 눈금의 "오른쪽 끝 글자와도 다름" 검사를 빼면 `axis_middle_differs_from_right` RED → 원복 → GREEN. 두 결과를 커밋 메시지 본문에 한 줄씩.
- [ ] **Step 5: 커밋** — `feat(tui): 모니터·오류·도움말 화면 렌더링`.

### Task 7: 앱 루프·키/마우스·터미널 수명·패닉 훅

**Files:**
- Create: `crates/tui/tests/app_test.rs` (**첫 편집 — tdd-guard**), `crates/tui/src/app.rs`, `crates/tui/src/terminal.rs`
- Modify: `crates/tui/src/lib.rs`, `crates/tui/src/main.rs` (`Command::Run`·`Usage` → `app::run`)

**Interfaces:**
- Consumes: Task 2 `Session`·`logging`, Task 5 `spawn_poller`, Task 6 렌더·`layout`·`panel_at`.
- Produces:
  - 실행 구조(spec §10.1 N9): `main`이 tokio 멀티스레드 런타임을 만들고 **메인 스레드에서 동기 UI 루프**를 돈다(`event::poll(100ms)` → 입력 처리 → `watch` 최신 스냅샷으로 그리기). 비동기 작업(`Session::start`, 폴러)은 `rt.block_on`/`rt.spawn`. UI 루프를 `tokio::spawn` 안에 넣지 않는다.
  - `app::Screen { Starting, Monitor, Help, QuitConfirm(Box<Screen>), Error(StartError), Usage }`.
  - `app::Action { None, Move(Dir), Select(usize), NextBoard, PrevBoard, OpenHelp, Back, AskQuit, Quit, Retry }`; `fn handle_key(screen: &Screen, k: KeyEvent, n_boards: usize) -> Action`(순수, 이동은 방향만 낸다); `fn move_sel(sel: usize, dir: Dir, grid: (usize, usize), n_panels: usize) -> usize`(순수 — 격자 경계와 마지막 줄이 덜 찬 격자에서 멈춤); `fn handle_mouse(screen: &Screen, m: MouseEvent, layout: &Layout) -> Action`(왼쪽 버튼 Down만, `panel_at`); `fn screen_after_start(r: &Result<(), StartError>) -> Screen`(Ok → Monitor, Err → Error).
  - 키(spec §5.2): 방향키·`hjkl` 이동(`move_sel`), `Tab`/`BackTab` 보드 전환(보드 1개면 None), `?` 도움말, `q`·`Ctrl+C` → 종료 확인, 확인창에서 `y`만 Quit, `Esc` 뒤로, 오류 화면 `r` Retry·`q` Quit(오류·사용법 화면은 확인 없이 종료).
  - `Retry`: 기존 Session(있으면) shutdown → `Session::start` 재호출(로그는 재초기화하지 않음).
  - `terminal::TerminalGuard::enter() -> io::Result<TerminalGuard>`(raw mode·대체 화면·마우스 이벤트 받기 켬), `Drop`이 셋 다 되돌림 — 단 전역 `RESTORED: AtomicBool`이 이미 참이면 건너뜀(패닉 훅이 복구한 뒤 unwind 중 `LeaveAlternateScreen`을 또 보내 "로그:" 줄을 덮는 것 방지).
  - `terminal::install_panic_hook(ui_thread: ThreadId, log: LogLoc)` — 모든 패닉을 `tracing::error!`로 로그 파일에 기록, 기본 훅 호출 안 함. 현재 스레드 == `ui_thread`일 때만 터미널 복구(`RESTORED` 세팅) 후 stderr에 `핸디캡 모니터 오류로 종료합니다. 로그: {log}` 한 줄.
  - 순수 부분 분리: `terminal::panic_action(current: ThreadId, ui: ThreadId) -> PanicAction { RestoreAndPrint, LogOnly }`.

- [ ] **Step 1: 실패 테스트** (`tests/app_test.rs`) — `move_sel_stops_at_edges`(3×3, 칸 2에서 오른쪽 → 2), `move_sel_partial_grid`(5칸 3×2, 칸 2에서 아래 → 2 그대로(칸 5 없음), 칸 1에서 아래 → 4), `q_asks_then_y_quits`(Monitor `q` → AskQuit, QuitConfirm `y` → Quit, `n` → Back), `ctrl_c_asks`, `tab_ignored_single_board`, `error_screen_r_retries`, `usage_q_quits_without_confirm`, `screen_after_start_maps_err_to_error`, `mouse_left_click_selects`(Down Left at 칸 2 내부 → Select(2)), `mouse_other_events_ignored`(Moved/Right/Up → None), `panic_action_ui_thread_restores`·`panic_action_other_thread_logs_only`(순수 판정), **`panic_hook_non_ui_thread_keeps_terminal`(서브프로세스)**: `CARGO_BIN_EXE_handicap-tui`를 숨은 환경변수 `HANDICAP_TUI_PANIC_SELFTEST=1`로 실행 → `main`이 그 변수일 때만 훅 설치 후 별도 스레드에서 패닉·join하고 exit 0 → stderr 0바이트 + 로그 파일에 패닉 메시지(훅 설치·기본 훅 미호출·로그 기록을 함께 증명).
- [ ] **Step 2: RED** → **Step 3: 구현** → **Step 4: GREEN** (`cargo test -p handicap-tui`, clippy, `cargo test --workspace --no-run`).
- [ ] **Step 5: 수동 스모크(macOS 실제 터미널)** — wiremock 대신 `python3 -m http.server`를 대상으로 하는 fixture로 `cargo run -p handicap-tui -- <file>`: 칸 이동·클릭 선택·`?`·`q`→`n`·`q`→`y` 종료 후 터미널 정상 복구, 막대 아래 시각 줄이 보이고 오른쪽 끝 눈금(있으면)이 머리 줄 서버 시각보다 `주기 + 1초` 안쪽으로 이름(`at_ms`는 점검 시작 시각 + 폴링 지연), `tui.log` 생성, 터미널에 로그 줄 0. 결과를 커밋 메시지 본문에.
- [ ] **Step 6: 커밋** — `feat(tui): 앱 루프·키/마우스·터미널 복구·패닉 훅`.

### Task 8: 릴리즈 잡·게시 스크립트·19.04 `--check` 게이트·매뉴얼

**Files:**
- Modify: `.github/workflows/release.yml` (새 잡 `linux-tui`, `publish.needs`에 추가 — **`if:` 차단 조건에는 넣지 않음**)
- Modify: `scripts/publish-release.sh` (`find`에 `-o -name '*.tar.gz'`, 누락 점검 목록에 `linux-x86_64.tar.gz`)
- Create: `scripts/tui-linux-smoke.sh <binary> <fixture>` (호스트에서 `python3 -m http.server`(빈 디렉토리, 임의 포트 — 빈 디렉토리는 `/`만 200이므로 fixture URL은 `${BASE_URL}/`) 기동 → fixture의 `__BASE__`를 치환한 임시 파일 → `docker run --rm --platform linux/amd64 -v …:/b ubuntu:19.04 /b/handicap-tui --check /b/board.json` exit 0 + 출력에 `✔ 정상` → 응답기 종료. **호스트 주소는 OS별**: Linux(CI) = `--network host` + `http://127.0.0.1:<port>`, macOS(Docker Desktop은 host 네트워크가 기본 꺼짐) = 기본 네트워크 + `http://host.docker.internal:<port>` — `uname -s`로 분기)
- Create: `crates/tui/tests/fixtures/smoke_bundle.json` (Task 2 템플릿과 같은 형태, 칸 1개, `assert: status 200`)
- Create: `docs/dev/tui-monitor.md` (매뉴얼)
- Modify: `docs/dev/tauri-desktop-build.md` §CI 릴리즈 (잡 목록·에셋 목록에 `linux-tui`·`handicap-tui_<ver>_linux-x86_64.tar.gz`, 선택 에셋임을 명시)

**Interfaces:**
- Consumes: Task 3 스크립트, Task 5 `--check`.
- Produces: 릴리즈 에셋 `handicap-tui_<ver>_linux-x86_64.tar.gz`(바이너리 + `tui-monitor.md`).

- [ ] **Step 1: 스모크 스크립트 RED→GREEN** — Task 3 산출 바이너리로 `scripts/tui-linux-smoke.sh target/x86_64-unknown-linux-gnu/release/handicap-tui crates/tui/tests/fixtures/smoke_bundle.json; echo exit=$?` → `exit=0`. 이빨: 응답기를 띄우지 않는 플래그(`NO_RESPONDER=1`)로 돌리면 출력에 `✖ 실패`가 나오고 스크립트가 exit 1이어야 함.
- [ ] **Step 2: release.yml `linux-tui` 잡** — `runs-on: ubuntu-24.04`, `needs: preflight`, checkout(`ref: ${{ inputs.tag || github.ref }}`), `arduino/setup-protoc@v3`, `dtolnay/rust-toolchain@1.99.1`(+ target `x86_64-unknown-linux-gnu`), zig·cargo-zigbuild(Task 3 고정 버전), `Swatinem/rust-cache@v2`, `scripts/tui-linux-build.sh` → `scripts/tui-linux-gates.sh` → `scripts/tui-linux-smoke.sh` → tar.gz 스테이징 → `actions/upload-artifact`(이름 `release-assets-linux-tui`, 기존 잡 패턴과 동일). `publish` 잡의 `actions/download-artifact`는 `pattern: release-assets-*` + `merge-multiple: true`라 이 이름이면 자동 수집된다(`grep -n "pattern: release-assets" .github/workflows/release.yml`).
- [ ] **Step 3: 워크플로 검증** — `actionlint .github/workflows/release.yml`(없으면 `brew install actionlint`) 통과, `bash -n scripts/*.sh`.
- [ ] **Step 4: publish-release.sh** — `find` 필터와 누락 목록 수정. 검증(스크립트에 dry-run이 없고 실제 `gh`를 부르므로 **가짜 `gh`**로): 스크래치 디렉토리에 인자를 파일에 기록하고 `release view`엔 exit 1(→ create 분기)·그 외엔 exit 0인 `gh` 스크립트를 두고, 에셋 디렉토리에 더미 `handicap-tui_0.0.0_linux-x86_64.tar.gz`·`x.deb`를 둔 뒤 `env PATH=/<스크래치 절대경로>/bin:/usr/bin:/bin GITHUB_REPOSITORY=o/r PUBLISH_RETRY_DELAYS=0 scripts/publish-release.sh v0.0.0 /<에셋 절대경로>; echo exit=$?`(PATH는 **리터럴** — `$PATH` 확장은 워크트리 가드가 거부). 출력의 "에셋 N개" 목록과 가짜 `gh` 기록에 tar.gz가 있어야 함. `docs/release-notes/v0.0.0.md` 부재 경로가 스크립트를 막으면 그 분기를 따라가는 대신 스크래치 노트 파일을 두는 방법을 스크립트 본문에서 확인해 쓴다. 이 검증은 커밋하지 않는다.
- [ ] **Step 5: 매뉴얼 `docs/dev/tui-monitor.md`** — spec §7 매뉴얼 항목 전부: 설치(복사·`chmod +x`), 자동 시작 `.desktop` 전문(spec §3 그대로: `gnome-terminal --full-screen -- sh -c '…; read x'`, `--maximize` 대안, `X-GNOME-Autostart-Delay`/`sleep` 지연, `read x` 이유), 키 표, 파일 교체(US5), 로그 위치(`tui.log`·`tui.log.1`·`--check`용 `tui-check.log`), `--check` 사용법·exit 코드, 보드 수·`record_limit_kb`와 PC 부담, 보안 전제(전용 단일 사용자 PC, 루프백 무인증), 화면 읽는 법(막대 아래 시각 줄 — 10분 미만 구간은 초까지), 문제 해결 한 줄(실행 시 `exec format error`면 32비트 사용자 공간 설치본 — spec §10).
- [ ] **Step 6: 커밋** — `build(release): Linux TUI 에셋 + 19.04 --check 게이트 + 매뉴얼`.

---

## 슬라이스 마감 전 (finish-slice가 확인)

- 라이브(spec §8): macOS 실제 터미널 + `ubuntu:19.04` 컨테이너 `--check` + tmux로 TUI 화면 캡처 1장(이미지에 tmux가 없고 19.04는 EOL이라 `sed -i "s/archive.ubuntu.com\|security.ubuntu.com/old-releases.ubuntu.com/g" /etc/apt/sources.list && apt-get update && apt-get install -y tmux` 후 `tmux new -d -x 80 -y 24` → `tmux capture-pane -p`), US1·2·5·6 통과 신호 표. US6(macOS, `brew install tmux` — 이 Mac엔 tmux 없음 확인): 9칸 fixture(주기 5 s·`bar_count` 60 → `HH:MM:SS` 구간, 응답기 `python3 -m http.server`)를 `tmux new -d -x 80 -y 24 "cargo run -p handicap-tui -- <file>"`로 띄우고 1분쯤 뒤 응답기를 멈춰 30초 뒤 다시 띄운다(멈춘·다시 띄운 시각을 `date +%T`로 기록 — 전송 실패도 실패 막대) → 1분 뒤 `tmux capture-pane -p` 캡처에서 실패 막대 `█`(성공은 낮은 지연이라 `▁`) 근처 눈금 시각이 기록 구간과 맞는지 + 9칸 모두 눈금 겹침·잘림 없음. 극단값: 띄운 직후(결과 몇 개뿐) 캡처 1장, `interval_seconds` 60 fixture(`HH:MM` 구간)로 1장 더. 색은 `capture-pane -p -e`로 필요 시 확인. 컨테이너 캡처는 배치 확인용.
- 보안 grep(finish-slice §0)으로 `security-reviewer` 필요 여부 판정. 로그 파일에 본문·환경 값이 tracing 필드로 나가지 않는지: `grep -rn "tracing::\(info\|debug\|warn\|error\)!" crates/controller/src/monitor crates/tui/src | grep -i "body\|vars\|header"` 결과 검토.
- 사용자(머지 후): 실제 19.04 PC 자동 시작·`--full-screen`·모호 폭 문자 확인. (`uname -m`은 사용자 답으로 생략 — Task 0.)
- 라이브에서 패닉 경로 1회: `HANDICAP_TUI_PANIC_SELFTEST`류가 아니라 실제 UI 스레드 패닉은 재현 수단이 없으므로, 터미널 복구 후 "로그:" 줄이 덮이지 않는지(`RESTORED` 플래그)는 코드 리뷰로 갈음(한계로 build-log에 기록).
