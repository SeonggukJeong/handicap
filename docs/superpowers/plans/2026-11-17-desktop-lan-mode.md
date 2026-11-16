# 데스크톱 앱 서버 모드 1차 (desktop-lan-mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설치판 앱에서 버튼으로 서버(풀 모드)를 열고 닫으며, 서버 PC도 부하를 내고, 부하기 PC용 OS별 명령을 복사할 수 있게 한다. 포터블 exe의 `--worker-mode pool` 무시 버그도 고친다.

**Architecture:** 셸(Tauri)이 역할 설정 파일을 소유하고, 역할이 바뀌면 in-process 컨트롤러를 새 `InProcessConfig`로 다시 띄운다. 역할 조작은 셸 origin의 정적 페이지(`desktop/src/role.html`, 화면 제목 「모드 전환」)에서 IPC로 하고, React UI는 셸이 넣어 준 읽기 전용 표지(`window.__HANDICAP_DESKTOP__.rolePageUrl`)로 그 페이지에 가는 상단 링크 「모드 전환」만 그린다. 순수 로직은 새 워크스페이스 크레이트 `crates/desktop-core`에 둬 게이트 안에서 테스트한다.

**Tech Stack:** Rust(Tauri v2 2.11.x, tokio, controller `in-process` feature), worker lib, React/TS(Vitest·RTL·Zod), 정적 HTML/JS(셸 페이지).

**Spec:** `docs/superpowers/specs/2026-11-16-desktop-lan-mode-design.md` — 각 task의 요구사항은 spec의 R 번호를 따른다. 실행자는 spec과 이 plan을 함께 읽는다.

REVIEW-GATE: APPROVED

## Global Constraints

- REST는 모든 역할에서 `127.0.0.1:0`. gRPC만 서버 역할에서 `0.0.0.0:<저장 포트>`(기본 `8081`). (spec R3)
- gRPC fallback(허용 시) = `AddrInUse` 또는 `PermissionDenied`면 빈 포트. 서버 역할은 실제 포트를 저장. REST fallback 규칙 무변경. (R3)
- Pool 모드는 비어 있지 않은(trim 후) 토큰 필수 — 아니면 `run_in_process`가 `Err`, 메시지에 `--worker-token`. (R2)
- 토큰 = OS CSPRNG 16바이트의 소문자 hex 32자. ULID 금지. (R3)
- 활성 run 기록은 가드 UPDATE `WHERE id=? AND status IN ('pending','running')`, 메시지 "모드 전환으로 중단" / "앱 종료로 중단". (R2)
- 정지 순서(전환·종료 공통): aborted 기록·abort 전송 → 이 PC 부하기 정지 → 컨트롤러 shutdown. (R8)
- 원격 origin(`http://127.0.0.1:*`)에는 IPC를 열지 않는다. 토큰은 셸 페이지 IPC 응답(`worker_command`)에만. (R7)
- 표지 = `window.__HANDICAP_DESKTOP__ = Object.freeze({ rolePageUrl })` — 필드 하나, 비밀 없음. (R6·§5)
- `InProcessConfig::default()`는 지금 값 그대로(Subprocess, `127.0.0.1:0` ×2, 토큰 None, gRPC fallback true). (R0)
- 비-bundle CLI 컨트롤러·CLI 워커의 인자·동작·로그 무변경. proto·migration·REST 엔드포인트 추가 0. (R0·§5)
- 부하기 ID: 이 PC 부하기 = `handicap_worker::resolve_hostname()`(capacity_vus 1000 = CLI 기본), 복사 명령 = Windows `$env:COMPUTERNAME` / macOS·Linux `"$(hostname)"`. (R4·R5)
- 표시 이름: 상단 링크·셸 화면 제목 = 「모드 전환」(사용자 결정 2026-11-17).
- React UI 문구는 `ko.ts` 경유(ADR-0035). 셸 페이지 문구는 그 HTML 안.

## Review Focus

1. **전환 중 다시 누르기·연타** — 두 번째 `switch_role`은 첫 전환이 끝나길 기다리지 않고 즉시 `Err("이미 전환 중입니다")`. Task 6 동시 실행 테스트가 소유.
2. **설정 디렉터리에 쓸 수 없음** — 전환은 성공, 저장 실패면 `notices.save_failed` + 역할 화면 「역할을 저장하지 못했습니다 — 다음 실행 때 이전 역할로 열립니다」, 전환 결과 유지. Task 6 테스트.
3. **망 주소 0개(오프라인 노트북)** — 명령 칸 비우고 「이 PC의 망 주소를 찾지 못했습니다」. Task 2 `candidate_ipv4s` + Task 7 DTO 테스트.
4. **PC 이름이 빈 문자열** — 이 PC 부하기 미시작, 토글 disabled + 「PC 이름을 읽지 못해 쓸 수 없습니다」. Task 6 테스트.
5. **전환 도중 앱 종료** — 종료는 진행 중 전환을 **최대 10초** 기다린 뒤 같은 bounded 정지 경로로 끝난다(무한 대기 없음). Task 6 동시 실행 테스트.

## 게이트 (각 task 커밋 전)

- 워크스페이스(`crates/`) 변경: pre-commit이 자동(fmt·build·clippy·nextest·doctest). 커밋은 FOREGROUND 600000ms 단일 호출.
- **`in_process` 모듈은 `#[cfg(feature = "in-process")]`**(`crates/controller/src/lib.rs:11`) — `-p handicap-controller` 단독 실행은 그 테스트를 **안 돈다**. 컨트롤러 in-process 테스트는 `cargo nextest run -p handicap-controller --features in-process …`로.
- `crates/controller` bundle 경로(`main.rs` `run_bundle`)를 건드린 task: 커밋 전 `cd ui && pnpm build && cd ..` 후 `cargo build -p handicap-controller --features bundle && cargo clippy -p handicap-controller --features bundle -- -D warnings && cargo nextest run -p handicap-controller --features bundle` (필터 없이).
- `desktop/` 변경: 커밋 전 `cd desktop/src-tauri && cargo build && cargo clippy -- -D warnings && cargo test` (ui/dist 필요). desktop은 tdd-guard·spec-review-guard 대상 밖.
- `ui/` 변경: pre-commit UI 게이트(`pnpm lint && pnpm test && pnpm build`).
- `git add`는 그 task의 Files 목록 경로만 명시.

---

### Task 1: 셸 스파이크 — 초기화 스크립트·셸 화면 이동·IPC 범위·클립보드 실측 (버리는 코드)

**목적:** spec §9.1 ⓪①②③ + 원격 IPC 차단. 결과가 Task 7의 창 생성 방식을 정한다(복사 수단은 아래 Step 1에서 미리 고정 — 실측은 Task 7 Step 5의 클릭 시험).

**STOP 조건(구현 중단·orchestrator가 사용자에게 확인):** ⓐ 원격 페이지에 표지가 안 들어감(`SPIKE REMOTE LOADED`는 있는데 `SPIKE NAV …#remote=` 이동이 없음 — 스크립트가 안 돈 것) ⓑ 원격 → 셸 화면 이동 실패(`SPIKE NAV` 셸 URL 없음) ⓒ 원격 IPC가 닿는데(`SPIKE REMOTE IPC REACHABLE`) capability로 막을 방법을 못 찾음.

**Files:** 임시 수정 `desktop/src-tauri/src/lib.rs`·`desktop/src-tauri/tauri.conf.json`·새 `desktop/src/probe.html` — **커밋하지 않는다**, 끝나면 `git restore desktop/` + `rm desktop/src/probe.html`로 되돌리고 `git status --porcelain`이 빈지 확인. 결과 기록: `.superpowers/sdd/desktop-lan-mode-spike.md`(커밋 금지).

**Interfaces:**
- Produces(기록으로): 창·초기화 스크립트 설치 코드 조각, 셸 origin 실제 URL 형식(macOS), 원격 IPC 결과(거절 문자열 포함).

- [ ] **Step 1: 실측 장치**
  - 창 생성: 1순위 `tauri.conf.json` `app.windows[0]`에 `"create": false`를 두고 `setup`에서 `WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?.initialization_script(SCRIPT).on_page_load(..).on_navigation(..).build()`(크기·제목은 설정 파일 유지, label `"main"` 유지 — capability 매치). 안 되면 2순위 `WebviewWindowBuilder::new(app, "main", WebviewUrl::App("splash.html".into()))`, 3순위 플러그인 `js_init_script`.
  - `on_navigation`/`on_page_load` 콜백: stdout `SPIKE NAV <url>` (`true` 반환).
  - SCRIPT: `location.origin`이 `http://127.0.0.1:`로 시작할 때만 — 표지 설정, `console`이 아니라 셸로 알리기 위해 표지 설정 직후 `location.hash`가 비어 있으면 2초 뒤 아래 진행: `window.__TAURI_INTERNALS__`가 있으면 `invoke("spike_remote")`를 1.5초 타임아웃과 경주시켜 결과 문자열(성공 `ok` / 거절 메시지 / `timeout` / `no-internals`)을 얻고 `location.assign(rolePageUrl + "#remote=" + encodeURIComponent(result))`.
  - `probe.html`(셸 origin): 로드 시 `invoke("spike_ok", {origin: location.origin, hash: location.hash, framed: window.top !== window.self})` 후 `app.exit(0)`을 부르는 `invoke("spike_done")`. 클립보드는 **스파이크에서 판정하지 않는다** — WebKit은 사용자 제스처 없는 복사를 거절해 로드 시 시험은 결론이 안 난다.
  - 복사 수단 결정(미리 고정): 버튼 클릭에서 `navigator.clipboard.writeText` → 실패 시 숨은 textarea + `document.execCommand("copy")` → 둘 다 실패면 Task 7 Step 5 수동 클릭 시험에서 확인한 뒤에만 `tauri-plugin-clipboard-manager` + capability 권한.
  - Rust 명령: `spike_ok` → `SPIKE OK origin=<…> hash=<…> framed=<…>`, `spike_remote` → `SPIKE REMOTE IPC REACHABLE`, `spike_done` → `app.exit(0)`. 원격 페이지 로드 확인용으로 `on_page_load`에서 URL이 `http://127.0.0.1:`이면 `SPIKE REMOTE LOADED`도 찍는다. 셸 origin 절대 URL은 `setup`에서 창 초기 URL의 scheme+host로.
- [ ] **Step 2: 실행** — Run: `just ui-build && cd desktop/src-tauri && cargo build && HANDICAP_DB=/tmp/desktop-lan-spike.db ./target/debug/desktop 2>&1 | tee /tmp/desktop-lan-spike.log` (GUI 세션; `spike_done`으로 스스로 끝남 — 40초 넘게 안 끝나면 `pkill -f "target/debug/desktop"`).
  Expected: `SPIKE REMOTE LOADED` · `SPIKE NAV tauri://localhost/probe.html#remote=…`(macOS 예상 — 실제 값 기록) · `SPIKE OK origin=… hash=#remote=<거절 메시지 / timeout / no-internals>` · `SPIKE REMOTE IPC REACHABLE` **0줄**.
- [ ] **Step 3: 판정·기록** — STOP 조건 해당 여부, 설치 방법, 셸 origin 형식, 원격 IPC 결과 문자열을 `.superpowers/sdd/desktop-lan-mode-spike.md`에. 되돌리기 확인.

---

### Task 2: `crates/desktop-core` — 셸 순수 로직

**Files:**
- Create: `crates/desktop-core/Cargo.toml`, `crates/desktop-core/src/lib.rs`, `src/config.rs`, `src/net.rs`, `src/command.rs`, `src/token.rs`
- Test: 각 파일 인라인 `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `config.rs`: `pub enum Role { Local, Server }`(`Debug, Clone, Copy, PartialEq, Eq`) · `pub struct ServerSettings { pub token: Option<String>, pub grpc_port: u16, pub self_worker: bool }`(Default: `None`, `8081`, `true`) · `pub struct DesktopConfig { pub role: Role, pub server: ServerSettings }`(Default: Local + Default, `Clone, PartialEq`) · `pub struct Loaded { pub config: DesktopConfig, pub warning: bool }` · `pub fn parse_config(raw: Option<&str>) -> Loaded` · `pub fn serialize_config(c: &DesktopConfig) -> String` · `pub const CONFIG_FILE_NAME: &str = "desktop-role.json"`.
  - `token.rs`: `pub fn generate_token<R: rand::RngCore + rand::CryptoRng>(rng: &mut R) -> String` · `pub fn is_usable_token(t: &str) -> bool`.
  - `net.rs`: `pub fn candidate_ipv4s(addrs: &[std::net::Ipv4Addr]) -> Vec<std::net::Ipv4Addr>` · `pub fn list_local_ipv4s() -> Vec<std::net::Ipv4Addr>`(인터페이스 열거 크레이트 얇은 래퍼, 테스트 없음).
  - `command.rs`: `pub enum WorkerOs { Windows, Macos, Linux }`(`Debug, Clone, Copy, PartialEq, Eq`, serde `lowercase` — `"windows"|"macos"|"linux"`) · `pub fn worker_command(os: WorkerOs, app_version: &str, ip: std::net::Ipv4Addr, port: u16, token: &str) -> String` · `pub fn current_os() -> WorkerOs`.

- [ ] **Step 1: 크레이트 골격 + 실패하는 테스트** — tdd-guard는 `crates/*/src`의 `.rs` 쓰기를 내용에 `#[cfg(test)]`가 있어야 허용하므로 **테스트를 담은 모듈 파일(config/net/command/token)을 먼저** 쓰고, `lib.rs`(`pub mod …`만)는 맨 끝에 `#[cfg(test)] mod smoke { #[test] fn crate_links() {} }`를 둬서 쓴다. `Cargo.toml`: `name = "handicap-desktop-core"`, `version/edition/rust-version/license/publish = workspace`, deps `serde`·`serde_json`·`rand`(workspace) + 인터페이스 열거 크레이트(`if-addrs` 최신 안정판 — `cargo add`, MSRV 1.85 빌드 확인; 안 맞으면 `local-ip-address`). 테스트:

```rust
// config.rs
#[test] fn missing_file_is_local_without_warning() {
    let l = parse_config(None);
    assert_eq!(l.config.role, Role::Local); assert!(!l.warning);
    assert_eq!(l.config.server.grpc_port, 8081); assert!(l.config.server.self_worker);
}
#[test] fn server_round_trip() {
    let c = DesktopConfig { role: Role::Server, server: ServerSettings { token: Some("ab".repeat(16)), grpc_port: 8093, self_worker: false } };
    let l = parse_config(Some(&serialize_config(&c)));
    assert_eq!(l.config, c); assert!(!l.warning);
}
#[test] fn garbage_is_local_with_warning() { let l = parse_config(Some("{not json")); assert_eq!(l.config.role, Role::Local); assert!(l.warning); }
#[test] fn unknown_role_is_local_with_warning_keeping_server_settings() {
    let l = parse_config(Some(r#"{"version":1,"role":"worker","server":{"token":null,"grpc_port":9000,"self_worker":true}}"#));
    assert_eq!(l.config.role, Role::Local); assert!(l.warning); assert_eq!(l.config.server.grpc_port, 9000);
}
#[test] fn unknown_version_is_local_with_warning() { let l = parse_config(Some(r#"{"version":2,"role":"server"}"#)); assert_eq!(l.config.role, Role::Local); assert!(l.warning); }
#[test] fn missing_server_section_defaults_without_warning() { let l = parse_config(Some(r#"{"version":1,"role":"server"}"#)); assert_eq!(l.config.role, Role::Server); assert!(!l.warning); assert_eq!(l.config.server.grpc_port, 8081); }
// token.rs
#[test] fn token_is_32_lower_hex() { let t = generate_token(&mut rand::rngs::OsRng); assert_eq!(t.len(), 32); assert!(t.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))); }
#[test] fn tokens_differ() { assert_ne!(generate_token(&mut rand::rngs::OsRng), generate_token(&mut rand::rngs::OsRng)); }
#[test] fn blank_tokens_unusable() { assert!(!is_usable_token("")); assert!(!is_usable_token("  \t")); assert!(is_usable_token("x")); }
// net.rs
#[test] fn private_only_in_input_order() {
    use std::net::Ipv4Addr as A;
    let v = candidate_ipv4s(&[A::new(127,0,0,1), A::new(169,254,1,2), A::new(8,8,8,8), A::new(192,168,0,12), A::new(10,1,2,3), A::new(172,20,0,1), A::new(172,32,0,1)]);
    assert_eq!(v, vec![A::new(192,168,0,12), A::new(10,1,2,3), A::new(172,20,0,1)]);
}
#[test] fn no_private_falls_back_to_non_loopback_non_linklocal() { use std::net::Ipv4Addr as A; assert_eq!(candidate_ipv4s(&[A::new(127,0,0,1), A::new(169,254,3,3), A::new(8,8,4,4)]), vec![A::new(8,8,4,4)]); }
#[test] fn none_left_is_empty() { use std::net::Ipv4Addr as A; assert!(candidate_ipv4s(&[A::new(127,0,0,1), A::new(169,254,9,9)]).is_empty()); }
// command.rs
#[test] fn windows_command() { assert_eq!(worker_command(WorkerOs::Windows, "0.15.0", "192.168.0.12".parse().unwrap(), 8081, "tok"),
    r".\Handicap_0.15.0_x64-portable.exe worker --controller http://192.168.0.12:8081 --token tok --worker-id $env:COMPUTERNAME"); }
#[test] fn macos_command() { assert_eq!(worker_command(WorkerOs::Macos, "0.15.0", "10.0.0.5".parse().unwrap(), 8093, "tok"),
    r#"/Applications/Handicap.app/Contents/MacOS/desktop worker --controller http://10.0.0.5:8093 --token tok --worker-id "$(hostname)""#); }
#[test] fn linux_command() { assert_eq!(worker_command(WorkerOs::Linux, "0.15.0", "10.0.0.5".parse().unwrap(), 8081, "tok"),
    r#"./Handicap_0.15.0_amd64.AppImage worker --controller http://10.0.0.5:8081 --token tok --worker-id "$(hostname)""#); }
```
  파일 이름 근거: `gh release view v0.14.0 --repo SeonggukJeong/handicap --json assets --jq '.assets[].name'` → `Handicap_0.14.0_x64-portable.exe`·`Handicap_0.14.0_amd64.AppImage`. macOS 내부 실행 파일 `desktop` = desktop/CLAUDE.md "dmg 안의 실행파일 이름".
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-desktop-core` → 컴파일 에러 또는 FAIL.
- [ ] **Step 3: 구현** — JSON `{"version":1,"role":"local"|"server","server":{"token":…,"grpc_port":…,"self_worker":…}}`; 사설 10/8·172.16/12·192.168/16, link-local 169.254/16.
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-desktop-core` → PASS.
- [ ] **Step 5: 커밋** — `git add crates/desktop-core Cargo.lock` → `git commit -m "feat(desktop-core): 역할 설정·토큰·IP 후보·부하기 명령 순수 로직"`.

---

### Task 3: 컨트롤러 in-process 풀 모드 + gRPC fallback 확장 + 포터블 배선 (US5)

**Files:**
- Modify: `crates/controller/src/in_process.rs`(InProcessConfig·Debug·토큰 검사·bind·dispatcher 분기·`is_pool_mode`), `crates/controller/src/launch.rs`(gRPC bind 변형), `crates/controller/src/main.rs:382-398`(`run_bundle` + 매핑 함수)
- Test: `in_process.rs`·`launch.rs`·`main.rs`(bundle-gated) 인라인 tests

**Interfaces:**
- Produces:
  - `pub enum InProcessWorkerMode { Subprocess, Pool }`(`Debug, Clone, Copy, Default, PartialEq, Eq`, Default=Subprocess) — `in_process.rs`.
  - `InProcessConfig`에 `pub worker_mode: InProcessWorkerMode`, `pub grpc_port_fallback: bool`(Default `true`). Debug에 두 필드 추가.
  - `launch::is_port_fallback_error(kind: std::io::ErrorKind) -> bool` · `launch::bind_grpc_with_fallback(preferred: SocketAddr, allow_fallback: bool) -> std::io::Result<std::net::TcpListener>`.
  - `RunningController::is_pool_mode(&self) -> bool`.
  - `main.rs`(bundle): `fn bundle_worker_mode(m: WorkerMode) -> anyhow::Result<(InProcessWorkerMode, bool)>` — Subprocess→`(Subprocess, true)`, Pool→`(Pool, false)`, Kubernetes→`Err("--worker-mode kubernetes is not supported by the single-exe controller; deploy with the Helm chart")`.

- [ ] **Step 1: 실패하는 테스트**

```rust
// launch.rs
#[test] fn fallback_kinds() { use std::io::ErrorKind as K;
    assert!(is_port_fallback_error(K::AddrInUse)); assert!(is_port_fallback_error(K::PermissionDenied));
    assert!(!is_port_fallback_error(K::AddrNotAvailable)); assert!(!is_port_fallback_error(K::Other)); }
#[test] fn grpc_bind_falls_back_when_busy() { let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); let a = held.local_addr().unwrap();
    assert_ne!(bind_grpc_with_fallback(a, true).unwrap().local_addr().unwrap().port(), a.port()); }
#[test] fn grpc_bind_errors_when_busy_without_fallback() { let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    assert!(bind_grpc_with_fallback(held.local_addr().unwrap(), false).is_err()); }
// in_process.rs tests (기존 start_test_controller 패턴: tempdir db + scheduler_disabled)
#[test] fn default_config_unchanged() { let c = InProcessConfig::default();
    assert_eq!(c.worker_mode, InProcessWorkerMode::Subprocess); assert!(c.grpc_port_fallback); assert!(c.worker_token.is_none());
    assert_eq!(c.rest.to_string(), "127.0.0.1:0"); assert_eq!(c.grpc.to_string(), "127.0.0.1:0"); }
#[tokio::test] async fn pool_requires_nonempty_token() { for t in [None, Some(String::new()), Some("  ".to_string())] {
    let cfg = InProcessConfig { db: Some(<tempdir db>), scheduler_disabled: true, worker_mode: InProcessWorkerMode::Pool, worker_token: t, ..Default::default() };
    let e = run_in_process(cfg).await.err().expect("must refuse"); assert!(format!("{e:#}").contains("--worker-token")); } }
#[tokio::test] async fn pool_mode_is_pool() { let rc = run_in_process(InProcessConfig { db: Some(<tempdir>), scheduler_disabled: true, worker_mode: InProcessWorkerMode::Pool, worker_token: Some("t".into()), ..Default::default() }).await.unwrap();
    assert!(rc.is_pool_mode()); rc.shutdown().await; }
#[tokio::test] async fn subprocess_mode_is_not_pool() { let rc = start_test_controller().await; assert!(!rc.is_pool_mode()); rc.shutdown().await; }
#[tokio::test] async fn pool_without_fallback_errors_on_busy_grpc() { let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let cfg = InProcessConfig { db: Some(<tempdir>), scheduler_disabled: true, worker_mode: InProcessWorkerMode::Pool, worker_token: Some("t".into()), grpc: held.local_addr().unwrap(), grpc_port_fallback: false, ..Default::default() };
    assert!(run_in_process(cfg).await.is_err()); }
// main.rs — #[cfg(all(test, feature = "bundle"))]
#[test] fn bundle_worker_mode_mapping() {
    assert_eq!(bundle_worker_mode(WorkerMode::Subprocess).unwrap(), (InProcessWorkerMode::Subprocess, true));
    assert_eq!(bundle_worker_mode(WorkerMode::Pool).unwrap(), (InProcessWorkerMode::Pool, false));
    assert!(format!("{:#}", bundle_worker_mode(WorkerMode::Kubernetes).unwrap_err()).contains("kubernetes")); }
```
  (`main.rs` 테스트 모듈이 bin에 있으면 `cargo nextest run -p handicap-controller --features bundle --bin controller`로 돈다 — bundle 게이트가 필터 없이 실행하므로 포함된다. `WorkerMode`에 `PartialEq`/`Debug`가 없으면 derive 추가.)
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --features in-process -E 'test(/fallback_kinds|grpc_bind|default_config_unchanged|pool_|subprocess_mode_is_not_pool/)'` → FAIL/컴파일 에러.
- [ ] **Step 3: 구현**
  - `run_in_process` 맨 앞(DB·bind 전): Pool이고 `!cfg.worker_token.as_deref().is_some_and(|t| !t.trim().is_empty())`면 `anyhow::bail!("pool worker mode requires a non-empty worker token (--worker-token)")`.
  - gRPC bind → `bind_grpc_with_fallback(cfg.grpc, cfg.grpc_port_fallback)`. REST는 기존 `bind_with_fallback(cfg.rest, true)` 그대로.
  - dispatcher: Pool이면 `coord_state.set_pool_mode(true)` + `Arc::new(crate::dispatcher::NoopDispatcher)`(비-bundle `main.rs:225-229`와 같은 배선), Subprocess면 지금 코드. `in_process.rs:91` 주석을 실제 동작으로.
  - `run_bundle`: `let (worker_mode, grpc_port_fallback) = bundle_worker_mode(args.worker_mode)?;` 를 리터럴에. 시작 `info!`에 `worker_mode = ?args.worker_mode` 추가(토큰은 계속 `worker_token_set` bool만).
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller --features in-process` PASS + §게이트 bundle 수동 게이트 PASS.
- [ ] **Step 5: 헤드리스 US5 확인** — `cargo build -p handicap-controller --bin controller --features bundle`; 빈 포트 `<r>`·`<g>`를 `lsof -iTCP:<p> -sTCP:LISTEN` 출력이 빈지 **읽고** 고른다.
  - ① `./target/debug/controller --db /tmp/dlm-us5.db --no-open --worker-mode pool --rest 127.0.0.1:<r> --grpc 0.0.0.0:<g> --worker-token t1` → `curl -s 127.0.0.1:<r>/api/pool/workers`에 `"pool_mode":true` → `./target/debug/controller worker --controller http://127.0.0.1:<g> --token t1 --worker-id us5-a &` 3초 뒤 workers에 `us5-a`.
  - ② `--worker-token` 없이 기동 → exit≠0, 출력에 `--worker-token`.
  - ③ `<g>`를 **`0.0.0.0:<g>`** 리스너로 잡아 둔 채(예 `python3 -c "import socket,time;s=socket.socket();s.bind(('0.0.0.0',<g>));s.listen();time.sleep(60)" &` — macOS는 SO_REUSEADDR 때문에 `127.0.0.1:<g>` 홀더로는 와일드카드 bind가 성공해 거짓 통과한다) ①과 같은 명령 → exit≠0(빈 포트로 안 감).
  - ④ `--worker-mode kubernetes` → exit≠0, 출력에 `kubernetes`.
  출력을 리포트에 붙인다. 종료는 `pgrep -f "controller --db /tmp/dlm-us5.db"`로 내 것만.
- [ ] **Step 6: 커밋** — `git add crates/controller/src/in_process.rs crates/controller/src/launch.rs crates/controller/src/main.rs` → `git commit -m "fix(controller): in-process 풀 모드 — 포터블 exe --worker-mode pool이 실제로 동작, gRPC fallback에 PermissionDenied"`.

---

### Task 4: 활성 run aborted 기록 + 컨트롤러 접근자 (US4·R2)

**Files:**
- Modify: `crates/controller/src/store/runs.rs`(가드 함수), `crates/controller/src/in_process.rs`(RunningController 메서드·상수)
- Test: 인라인 tests

**Interfaces:**
- Consumes: Task 3 `RunningController`.
- Produces:
  - `store::runs::mark_aborted_if_active(db: &Db, id: &str, message: &str) -> sqlx::Result<bool>`(행이 바뀌면 true).
  - `pub async fn active_run_count(&self) -> anyhow::Result<usize>`
  - `pub async fn abort_active_runs(&self, message: &str) -> anyhow::Result<usize>` — `abort_all`과 같은 활성 id 쿼리 → 각 id `mark_aborted_if_active` → true인 것만 `coord.abort(id)`. 반환 = aborted로 바꾼 수.
  - `pub async fn pool_workers(&self) -> Vec<crate::grpc::coordinator::PoolWorkerInfo>`(`coord.pool_snapshot(tokio::time::Instant::now()).await`).
  - `pub fn rest_base_url(&self) -> String`은 추가하지 않는다(셸 `launch::base_url` 유지).
  - `pub const ABORT_MSG_ROLE_SWITCH: &str = "모드 전환으로 중단";` · `pub const ABORT_MSG_APP_EXIT: &str = "앱 종료로 중단";`(in_process.rs).

- [ ] **Step 1: 실패하는 테스트** (in_process.rs 테스트 모듈 — 기존 `insert_active_run(db, id, status)`(`in_process.rs:527`)와 그 앞의 시드 시나리오 INSERT(`:506`)를 재사용. 상태·메시지는 `sqlx::query_as::<_, (String, Option<String>)>("SELECT status, message FROM runs WHERE id=?")`로 읽는다.)

```rust
#[tokio::test] async fn guarded_abort_skips_terminal() { /* seed scn-1; A running, B completed */
    assert!(store::runs::mark_aborted_if_active(&db, "A", "m").await.unwrap());
    assert!(!store::runs::mark_aborted_if_active(&db, "B", "m").await.unwrap());
    assert_eq!(status_msg(&db, "A").await, ("aborted".into(), Some("m".into())));
    assert_eq!(status_msg(&db, "B").await.0, "completed"); }
#[tokio::test] async fn aborted_survives_orphan_sweep() { /* A running → mark_aborted_if_active → mark_orphans_failed */
    assert_eq!(status_msg(&db, "A").await.0, "aborted"); }
#[tokio::test] async fn abort_active_runs_counts_only_active() { /* start_test_controller; 그 DB(rc의 db)에 seed + pending·running·completed */
    assert_eq!(rc.active_run_count().await.unwrap(), 2);
    assert_eq!(rc.abort_active_runs(ABORT_MSG_ROLE_SWITCH).await.unwrap(), 2);
    assert_eq!(rc.active_run_count().await.unwrap(), 0); }
```
  (RunningController의 `db`는 private — 테스트는 같은 모듈 안이라 `rc.db`로 접근 가능.)
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --features in-process -E 'test(/guarded_abort|aborted_survives|abort_active_runs/)'` → FAIL.
- [ ] **Step 3: 구현** — SQL `UPDATE runs SET status='aborted', ended_at=?, message=? WHERE id=? AND status IN ('pending','running')`, `rows_affected()==1`. 이빨: 가드 `AND status IN (…)`를 지우면 `guarded_abort_skips_terminal`이 RED인지 1회 확인 후 원복(리포트 기록).
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller --features in-process` PASS + bundle 수동 게이트 PASS.
- [ ] **Step 5: 커밋** — `git add crates/controller/src/store/runs.rs crates/controller/src/in_process.rs` → `git commit -m "feat(controller): 활성 run을 가드 UPDATE로 aborted 기록 + RunningController 접근자"`.

---

### Task 5: worker lib — 외부 취소 토큰 풀 진입점

**Files:**
- Modify: `crates/worker/src/lib.rs`
- Test: 인라인 tests

**Interfaces:**
- Produces: `pub async fn run_pool_until(args: WorkerArgs, cancel: CancellationToken) -> anyhow::Result<()>` — 시그널 처리기 **설치 안 함**, 로그 문자열("pool worker starting (idle)"·"pool worker exiting")은 여기 그대로. `pub fn resolve_hostname() -> String`(private → pub). `run_pool(args)` = `let cancel = CancellationToken::new(); let sig = spawn_sigterm(cancel.clone()); let r = run_pool_until(args, cancel).await; sig.abort(); r` — CLI 동작·로그 동일(본문 이동만 — 리뷰로 확인, spec §6).

- [ ] **Step 1: 실패하는 테스트** (닫힌 포트: `let p = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();` 후 drop)

```rust
#[tokio::test] async fn run_pool_until_returns_when_precancelled() {
    let c = CancellationToken::new(); c.cancel();
    tokio::time::timeout(Duration::from_secs(2), run_pool_until(args_for(closed_port()), c)).await.expect("must return").unwrap(); }
#[tokio::test] async fn run_pool_until_stops_on_cancel_during_backoff() {
    let c = CancellationToken::new(); let c2 = c.clone();
    let h = tokio::spawn(run_pool_until(args_for(closed_port()), c));
    tokio::time::sleep(Duration::from_millis(300)).await; c2.cancel();
    tokio::time::timeout(Duration::from_secs(2), h).await.expect("must stop").unwrap().unwrap(); }
// args_for(p) = WorkerArgs { controller: format!("http://127.0.0.1:{p}"), run_id: None, worker_id: Some("t".into()), capacity_vus: 1000, token: None }
```
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-worker run_pool_until` → 컴파일 에러.
- [ ] **Step 3: 구현** — 위 Interfaces. 이빨: `run_pool_until`이 받은 토큰 대신 `CancellationToken::new()`를 쓰게 바꾸면 두 테스트가 RED(타임아웃)인지 1회 확인 후 원복(리포트 기록). (루프 앞 `is_cancelled()`만 지우는 변이는 `retry_with_backoff`가 같은 검사를 해 GREEN으로 남는다 — 쓰지 말 것.)
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-worker` PASS.
- [ ] **Step 5: 커밋** — `git add crates/worker/src/lib.rs` → `git commit -m "refactor(worker): run_pool_until — 외부 취소 풀 진입점, CLI run_pool은 SIGTERM 래퍼"`.

---

### Task 6: 셸 백엔드 — 역할 상태·시작·정지·전환·이 PC 부하기·설정 저장

**Files:**
- Modify: `desktop/src-tauri/Cargo.toml`(deps `handicap-desktop-core`·`handicap-worker` path, `tokio-util`, `rand = "0.8"`(워크스페이스와 같은 주버전 — 0.9의 `OsRng`는 0.8 `RngCore`가 아니다); dev-deps `tempfile`, `reqwest`(json — 테스트에서 run 생성)), `desktop/src-tauri/src/backend.rs`(트레잇 제거 → `role.rs`로 흡수, 파일 삭제 가능), `desktop/src-tauri/src/lib.rs`(관리 상태·시작·종료)
- Create: `desktop/src-tauri/src/role.rs`, `desktop/src-tauri/src/config_store.rs`
- Test: 인라인 tests(수동 `cargo test`)

**Interfaces:**
- Consumes: Task 2 전부, Task 3 `InProcessConfig{worker_mode, grpc_port_fallback}`·`InProcessWorkerMode`·`is_pool_mode`, Task 4 `abort_active_runs`·`pool_workers`·`ABORT_MSG_*`, Task 5 `run_pool_until`·`resolve_hostname`.
- Produces:
  - `config_store::config_dir(app: &tauri::AppHandle) -> PathBuf`(env `HANDICAP_DESKTOP_CONFIG_DIR` 우선, 없으면 `app.path().app_config_dir()`) · `config_store::load(dir: &Path) -> Loaded`(파일 없음 → `parse_config(None)`) · `config_store::save(dir: &Path, c: &DesktopConfig) -> std::io::Result<()>`(`create_dir_all` + 임시 파일 쓰고 rename).
  - `role::Env { config_dir: PathBuf, db: Option<String>, hostname: fn() -> String, start_gate: Option<Arc<tokio::sync::Notify>> }`(테스트가 주입; 실사용은 `resolve_hostname`·`None`). `start_gate`가 있으면 `switch`가 정지 뒤·시작 전에 `notified().await`로 멈춘다 — 동시 실행 테스트를 시간에 기대지 않게 하는 테스트 전용 문.
  - `role::Notices { port_changed: Option<(u16,u16)>, save_failed: bool, self_worker_excluded: bool, self_worker_unavailable: Option<String>, start_error: Option<String> }`.
  - `role::Running { controller: RunningController, base_url: String, self_worker: Option<SelfWorker> }` · `role::SelfWorker { generation: u64, parent: CancellationToken, child: CancellationToken, handle: JoinHandle<()>, worker_id: String }`(`generation`은 `ShellState`의 단조 카운터 — 늦게 끝난 감시 블록이 새 부하기를 지우지 않게).
  - `role::ShellState { env: Env, config: DesktopConfig, config_warning: bool, running: Option<Running>, switching: bool, notices: Notices }` + `ShellState::new(loaded: Loaded, env: Env) -> Self`.
  - 관리 상태: `pub type Shared = Arc<tokio::sync::Mutex<ShellState>>` + `Arc<tokio::sync::Notify>`(전환 끝 알림) — `role::Shell { state: Shared, switch_done: Arc<Notify> }`(Clone).
  - **잠금 규칙(Review Focus 1·5)**: 긴 작업(`run_in_process`·정지)은 **잠금 없이**. 잠금 안에선 플래그·`take()`·설치만.
  - `role::boot(shell: &Shell) -> Result<String, String>` — 시작 시 `config.role`로 `start_running`, 성공이면 base_url 반환. 시작 중 토큰 생성·포트 변경으로 config가 바뀌었으면 **여기서 저장**(실패 → `notices.save_failed`). 실패면 `notices.start_error` 기록 후 `Err`.
  - `async fn start_running(shell: &Shell, config: &mut DesktopConfig, notices: &mut Notices) -> Result<Running, String>`(잠금 없이 호출 — `config`·`notices`는 호출자가 잠금 밖으로 복제해 온 사본, 끝나면 호출자가 잠금 안에서 설치) — Local: `InProcessConfig{ db, ..Default }`; Server: 토큰 없거나 `!is_usable_token`이면 `generate_token(&mut OsRng)`로 채움, `InProcessConfig{ db, rest: 127.0.0.1:0, grpc: 0.0.0.0:<port>, worker_mode: Pool, grpc_port_fallback: true, worker_token: Some(token) }`, 실제 포트 ≠ 저장 포트면 `notices.port_changed = Some((saved, actual))` + `config.server.grpc_port = actual`; 서버·`self_worker`·호스트명 비어 있지 않음 → `spawn_self_worker`; 호스트명 빈 값 → `notices.self_worker_unavailable = Some("PC 이름을 읽지 못해 쓸 수 없습니다")`.
  - `fn spawn_self_worker(shell: &Shell, port: u16, token: &str, worker_id: String) -> SelfWorker` — `run_pool_until(WorkerArgs{ controller: http://127.0.0.1:<port>, run_id: None, worker_id: Some(id), capacity_vus: 1000, token: Some(token) }, child)`를 spawn하고, 끝나면 **감시 블록**이 먼저 잠금 없이 `child.is_cancelled() && !parent.is_cancelled()`(서버가 `Disconnect`로 제외)를 확인하고, 참일 때만 잠금을 잡아 현재 `SelfWorker.generation`이 자기 것과 같을 때 `config.server.self_worker=false`·저장·`notices.self_worker_excluded=true`·`running.self_worker=None`(셸이 멈춘 경우 = `parent` 취소 → 잠금을 안 잡으므로, 잠금 밖에서 `handle`을 기다리는 쪽과 교착이 없다).
  - `async fn stop_running(r: Running, message: &str)` — R8 순서: `controller.abort_active_runs(message)` → self_worker `parent.cancel()` + `timeout(5s, handle)` → `controller.shutdown()`(기존 bounded).
  - `role::switch(shell: &Shell, target: Role) -> Result<(), String>` — 잠금: `switching`이면 즉시 `Err("이미 전환 중입니다")`; 아니면 `switching=true`, `running.take()`, config 복제 → 잠금 해제 → `stop_running(prev, ABORT_MSG_ROLE_SWITCH)` → `config.role=target`으로 `start_running` → 실패면 이전 역할로 다시 `start_running`(그것도 실패면 Local) → 잠금: 결과 설치, 성공이면 `save`(실패 → `save_failed`), `switching=false` → `switch_done.notify_waiters()`. 실패 결과는 `Err(사유)`.
  - `role::shutdown(shell: &Shell)` — 잠금: `switching`이면 **잠금을 쥔 채** `let n = switch_done.notified(); tokio::pin!(n); n.as_mut().enable();` 후 잠금 해제 → `timeout(10s, n)`(깨우기 유실 방지), 다시 잠금 → `running.take()` → 해제 → `stop_running(r, ABORT_MSG_APP_EXIT)`.
  - `role::set_self_worker(shell: &Shell, enabled: bool) -> Result<(), String>` — 전환 중(`switching`) → `Err("전환 중입니다")`; 서버 역할 아님 → `Err`; 이 PC 부하기(`SelfWorker.worker_id` 기준)가 `pool_workers()`에서 `assigned_run.is_some()`이면 `Err("이 PC가 테스트를 실행하는 중이라 끝난 뒤 바꿀 수 있습니다")`; 아니면 시작/정지 + `config.server.self_worker` + 저장(실패 → `save_failed`). 정지 시엔 잠금 안에서 `SelfWorker`를 `take()`한 뒤 **잠금을 풀고** `parent.cancel()` + `timeout(5s, handle)`.
  - `role::self_worker_busy(shell: &Shell) -> bool`.

- [ ] **Step 1: 실패하는 테스트(셸 크레이트, 수동 실행)** — 공통 헬퍼: tempdir config dir·DB, `hostname: || "test-host".into()`, 서버 포트는 `TcpListener::bind("0.0.0.0:0")`으로 얻어 drop.

```rust
// config_store.rs
#[test] fn save_then_load_round_trips() { let d = tempfile::tempdir().unwrap(); save(d.path(), &server_cfg()).unwrap(); assert_eq!(load(d.path()).config, server_cfg()); }
#[test] fn save_into_unwritable_dir_errors() { let d = tempfile::tempdir().unwrap(); let f = d.path().join("file"); std::fs::write(&f, "x").unwrap(); assert!(save(&f.join("sub"), &server_cfg()).is_err()); }
// role.rs
#[tokio::test] async fn boot_local_is_subprocess() { let s = shell(local()); boot(&s).await.unwrap(); assert!(!running(&s).await.controller.is_pool_mode()); shutdown(&s).await; }
#[tokio::test] async fn boot_server_generates_token_pools_and_saves() { let s = shell(server(free_port())); boot(&s).await.unwrap();
    let saved = config_store::load(&s_dir).config; assert!(saved.server.token.as_deref().is_some_and(is_usable_token)); assert!(running(&s).await.controller.is_pool_mode()); shutdown(&s).await; }
#[tokio::test] async fn busy_port_records_change_and_persists() { let held = std::net::TcpListener::bind("0.0.0.0:0").unwrap(); let p = held.local_addr().unwrap().port();
    let s = shell(server(p)); boot(&s).await.unwrap(); let st = s.state.lock().await;
    assert_eq!(st.notices.port_changed.map(|x| x.0), Some(p)); assert_ne!(config_store::load(&s_dir).config.server.grpc_port, p); }
#[tokio::test] async fn concurrent_switch_is_rejected() { let gate = Arc::new(Notify::new()); let s = shell_gated(local(), gate.clone()); boot(&s).await.unwrap();
    let s2 = s.clone(); let a = tokio::spawn(async move { switch(&s2, Role::Server).await });
    wait_until(|| async { s.state.lock().await.switching }).await;          // 첫 전환이 문 앞에 멈춤
    assert_eq!(switch(&s, Role::Server).await.unwrap_err(), "이미 전환 중입니다");
    assert_eq!(set_self_worker(&s, false).await.unwrap_err(), "전환 중입니다");
    gate.notify_one(); a.await.unwrap().unwrap(); shutdown(&s).await; }
#[tokio::test] async fn shutdown_during_switch_is_bounded() { let gate = Arc::new(Notify::new()); let s = shell_gated(local(), gate.clone()); boot(&s).await.unwrap();
    let s2 = s.clone(); let _a = tokio::spawn(async move { let _ = switch(&s2, Role::Server).await; });
    wait_until(|| async { s.state.lock().await.switching }).await;
    let t = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(25), shutdown(&s)).await.expect("bounded");   // 문을 열지 않음 → 10s 대기 상한 뒤 끝나야
    assert!(t.elapsed() >= Duration::from_secs(9)); }   // 실제로 전환과 겹쳤다는 증거
// wait_until = 2s 안에 조건이 참이 될 때까지 10ms 폴링, 아니면 panic
#[tokio::test] async fn switch_save_failure_keeps_result() { /* config_dir = 파일 아래 경로 */ let s = shell_with_dir(local(), unwritable); boot(&s).await.unwrap();
    switch(&s, Role::Server).await.unwrap(); let st = s.state.lock().await; assert!(st.notices.save_failed); assert_eq!(st.config.role, Role::Server); }
#[tokio::test] async fn self_worker_registers_with_hostname() { let s = shell(server(free_port())); boot(&s).await.unwrap();
    /* 5s 안에 running.controller.pool_workers()에 worker_id "test-host" */ }
#[tokio::test] async fn empty_hostname_skips_self_worker() { let s = shell_with_host(server(free_port()), || String::new()); boot(&s).await.unwrap();
    let st = s.state.lock().await; assert!(st.running.as_ref().unwrap().self_worker.is_none()); assert!(st.notices.self_worker_unavailable.is_some()); }
#[tokio::test] async fn exclusion_turns_toggle_off_and_saves() { /* server + self worker 등록 후 그 SelfWorker.child.cancel()만 */
    /* 2s 안에 config.server.self_worker == false && notices.self_worker_excluded && load(dir).config.server.self_worker == false */ }
#[tokio::test] async fn switch_marks_self_worker_run_aborted_not_failed() {
    // server + self worker 등록 대기 → REST(rc.rest_addr)로 시나리오 생성(YAML version:1, ULID step id, http step이 응답 안 하는 로컬 TcpListener를 향함)
    // → POST /api/runs (closed-loop vus 1, duration 60) → pool_workers()에서 assigned_run.is_some() 대기
    // → switch(&s, Role::Local) → 같은 DB를 직접 열어 그 run: status "aborted", message "모드 전환으로 중단"
}
```
  이빨(리포트 기록): `stop_running`에서 aborted 기록을 부하기 정지 **뒤로** 옮기면 `switch_marks_self_worker_run_aborted_not_failed`가 `failed`로 RED인지 1회 확인 후 원복. REST 페이로드 모양은 `docs/dev/live-verify-backend.md`(YAML `version: 1`·ULID step id·http step은 `request:` 아래 `method`/`url`)를 따른다.
- [ ] **Step 2: 실패 확인** — `cd desktop/src-tauri && cargo test` → 컴파일 에러/FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces. `lib.rs`: `setup`에서 `Shell` 생성(config_store::load) → `boot` → 성공이면 창을 base_url로, 실패면 이 task에선 기존 `__setError` 표시(Task 7이 역할 화면으로 바꾼다). `RunEvent::Exit`: `tauri::async_runtime::block_on(role::shutdown(&shell))`(메인 스레드 — 기존과 같은 위치).
- [ ] **Step 4: 통과 확인** — §게이트 desktop 수동 게이트 PASS.
- [ ] **Step 5: 커밋** — `git add desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock desktop/src-tauri/src` → `git commit -m "feat(desktop): 역할 상태·서버 시작/정지·전환·이 PC 부하기·설정 저장"`.

---

### Task 7: 셸 「모드 전환」 화면 + IPC 명령 + 표지 설치 + 전환 표시

**Files:**
- Create: `desktop/src/role.html`(정적 HTML+인라인 JS·CSS), `desktop/src-tauri/src/commands.rs`
- Modify: `desktop/src-tauri/src/lib.rs`(Task 1 방식으로 창 생성·초기화 스크립트·`invoke_handler`·시작 실패 시 역할 화면), `desktop/src-tauri/tauri.conf.json`(Task 1 결과), `desktop/src-tauri/capabilities/default.json`(Task 1 결과 — 셸 origin만; 클립보드 플러그인을 쓰면 그 권한)
- Test: `commands.rs` 인라인 tests

**Interfaces:**
- Consumes: Task 6 `Shell`·`role::*`, Task 2 `candidate_ipv4s`·`list_local_ipv4s`·`worker_command`·`current_os`·`WorkerOs`, Task 1 기록.
- Produces (IPC — **모두 `async fn … -> Result<T, String>`**, `tauri::State<'_, role::Shell>`; 이름·모양 고정, role.html과 1:1):
  - `role_state() -> RoleStateDto { role: "local"|"server", switching: bool, grpc_port: u16, ips: Vec<String>, server_os: WorkerOs, self_worker: bool, self_worker_busy: bool, self_worker_unavailable: Option<String>, notices: NoticesDto { port_changed: Option<[u16;2]>, save_failed: bool, self_worker_excluded: bool, config_warning: bool, start_error: Option<String> }, app_url: Option<String> }` — 토큰 없음. 잠금은 짧게(전환 중이어도 즉시 응답 — `switching:true`).
  - `worker_command(ip: String, os: WorkerOs) -> String` — 서버 역할·`ip`가 현재 후보에 있을 때만, 아니면 `Err`.
  - `active_run_count() -> usize`(전환 중이면 `Err("전환 중입니다")`) · `switch_role(target: "local"|"server") -> ()` · `set_self_worker(enabled: bool) -> ()` · `dismiss_notice(kind: "port_changed"|"save_failed"|"self_worker_excluded"|"config_warning"|"start_error") -> ()`.
  - 순수: `pub fn build_role_state(s: &ShellState, ips: Vec<Ipv4Addr>, busy: bool) -> RoleStateDto` · `pub fn worker_command_for(s: &ShellState, ips: &[Ipv4Addr], ip: &str, os: WorkerOs, app_version: &str) -> Result<String, String>`.
  - 표지 스크립트: 원격(`http://127.0.0.1:`) 페이지에서만 `window.__HANDICAP_DESKTOP__ = Object.freeze({rolePageUrl: "<셸 origin>/role.html"})`.

- [ ] **Step 1: 실패하는 테스트**

```rust
#[test] fn role_state_never_contains_token() { let s = server_state_with_token(&"deadbeef".repeat(4)); assert!(!serde_json::to_string(&build_role_state(&s, vec![], false)).unwrap().contains("deadbeef")); }
#[test] fn role_state_maps_port_change() { let mut s = server_state(); s.notices.port_changed = Some((8081, 8093)); assert_eq!(build_role_state(&s, vec![], false).notices.port_changed, Some([8081, 8093])); }
#[test] fn role_state_lists_candidates_only() { assert_eq!(build_role_state(&server_state(), vec!["192.168.0.12".parse().unwrap(), "127.0.0.1".parse().unwrap()], false).ips, vec!["192.168.0.12"]); }
#[test] fn role_state_no_ips_is_empty() { assert!(build_role_state(&server_state(), vec!["127.0.0.1".parse().unwrap()], false).ips.is_empty()); }
#[test] fn worker_command_refused_when_local() { assert!(worker_command_for(&local_state(), &[ip("10.0.0.1")], "10.0.0.1", WorkerOs::Macos, "0.15.0").is_err()); }
#[test] fn worker_command_refused_for_unknown_ip() { assert!(worker_command_for(&server_state(), &[ip("10.0.0.1")], "8.8.8.8", WorkerOs::Macos, "0.15.0").is_err()); }
#[test] fn worker_command_uses_current_port_and_token() { let s = server_state_with_token("tok"); /* grpc_port 8093 */
    assert!(worker_command_for(&s, &[ip("10.0.0.1")], "10.0.0.1", WorkerOs::Linux, "0.15.0").unwrap().contains("http://10.0.0.1:8093 --token tok")); }
```
- [ ] **Step 2: 실패 확인** — `cd desktop/src-tauri && cargo test` → FAIL.
- [ ] **Step 3: 셸 구현** — Task 1 기록대로 창 생성·초기화 스크립트 설치, capability 셸 origin만. `boot` 실패(`start_error`)면 창을 `role.html`로. 앱 버전은 `app.package_info().version`.
- [ ] **Step 4: `role.html` 구현**(문구 정확히)
  - 맨 앞: `if (window.top !== window.self) { document.documentElement.textContent = ""; throw new Error("framed"); }` — 그 뒤에만 IPC.
  - 제목 「모드 전환」. 현재 모드 줄: 「현재 모드: 혼자 쓰기 (이 PC만 부하를 냅니다)」 / 「현재 모드: 서버로 열려 있음」.
  - 버튼: 혼자 쓰기면 「서버로 열기」, 서버면 「혼자 쓰기로 돌아가기」. `app_url`이 있으면 「화면으로 돌아가기」(`location.assign(app_url)`).
  - 서버일 때: 「이 PC의 IP」 라디오(첫 항목 선택) — 0개면 「이 PC의 망 주소를 찾지 못했습니다」·명령 칸 비움. 「부하기 PC의 OS」 선택(Windows / macOS / Linux, 기본 `server_os`) → `worker_command` → 읽기 전용 명령 칸 + 「부하기 PC용 명령 복사」(Task 1이 정한 수단, 성공 시 2초 「복사됨」, 실패 시 「복사하지 못했습니다 — 칸을 선택해 직접 복사하세요」) + OS별 안내 한 줄(spec R5 문구 그대로). 「이 PC도 부하 내기」 체크박스(`self_worker_busy`면 disabled + 「이 PC가 테스트를 실행하는 중이라 끝난 뒤 바꿀 수 있습니다」, `self_worker_unavailable`이면 disabled + 그 사유). 방화벽 안내(서버 OS별, spec R6 문구 그대로).
  - 안내(✕ → `dismiss_notice`): 포트 변경 「부하기 접속 포트 {옛}을 다른 프로그램이 쓰고 있어 {새}로 열었습니다 — 부하기들에 새 명령을 주세요」 / 저장 실패 「역할을 저장하지 못했습니다 — 다음 실행 때 이전 역할로 열립니다」 / 제외 「워커 화면에서 이 PC를 제외해 꺼졌습니다」 / 설정 읽기 실패 「저장된 역할 설정을 읽지 못해 혼자 쓰기로 열었습니다」 / 시작 실패 「서버로 열지 못했습니다: {사유}」.
  - 복사는 Task 1이 고정한 순서(클릭에서 `navigator.clipboard.writeText` → `execCommand("copy")` 폴백). Step 5 수동 시험에서 둘 다 실패하면 그때 `tauri-plugin-clipboard-manager` + capability 권한(orchestrator에 보고).
  - 전환: 버튼 → `active_run_count()` > 0이면 페이지 내 확인 상자 「실행 중인 테스트 {N}개가 중단됩니다」 [중단하고 전환] [취소] → 확인(또는 0개) 시 전체 덮개(클릭 차단, `aria-busy="true"`) 「서버 모드로 전환 중…」 / 「혼자 쓰기로 돌아가는 중…」 + 진행 표시 → `Promise.allSettled([invoke("switch_role"), 600ms 지연])` → 덮개 제거 후 `role_state()` 다시 그림. 실패면 「전환하지 못했습니다: {사유}」. 덮개 동안 모든 버튼 disabled.
  - 로드·`visibilitychange` 때 `role_state()` 갱신, 서버면 3초마다.
- [ ] **Step 5: 통과 확인** — §게이트 desktop 수동 게이트 PASS. 수동 1회: 앱 실행 → 상단 링크(Task 8 전이므로 개발자 도구 콘솔에서 `location.assign(__HANDICAP_DESKTOP__.rolePageUrl)`) → 「모드 전환」 렌더 확인 + 서버로 열기 뒤 「부하기 PC용 명령 복사」를 **클릭**해 붙여넣기로 클립보드 내용 확인.
- [ ] **Step 6: 커밋** — `git add desktop/src desktop/src-tauri/src desktop/src-tauri/tauri.conf.json desktop/src-tauri/capabilities desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock` → `git commit -m "feat(desktop): 「모드 전환」 화면·IPC 명령·표지 설치·전환 표시"`.

---

### Task 8: React UI — 상단 「모드 전환」 링크 + 「서버 · 부하기 N대」 칩

**Files:**
- Create: `ui/src/api/desktopShell.ts`, `ui/src/api/__tests__/desktopShell.test.ts`
- Modify: `ui/src/components/Layout.tsx`, `ui/src/i18n/ko.ts`(`nav`), `ui/src/components/__tests__/Layout.test.tsx`

**Interfaces:**
- Produces: `export const DesktopShellSchema = z.object({ rolePageUrl: z.string().min(1) }).strict()` · `export function readDesktopShell(w: unknown = window): { rolePageUrl: string } | null`(`(w as any).__HANDICAP_DESKTOP__`를 safeParse, 없음·실패 → null). `Layout`은 **렌더마다** `readDesktopShell()`을 부른다(테스트가 import 뒤에 표지를 넣는다).
- ko: `nav.modeSwitch: "모드 전환"`, `nav.poolChip: (n: number) => \`서버 · 부하기 ${n}대\``, `nav.poolChipTitle: "부하기 목록 보기"`.

- [ ] **Step 1: 실패하는 테스트**

```ts
// desktopShell.test.ts
it("표지가 없으면 null", () => expect(readDesktopShell({})).toBeNull());
it("모양이 틀리면 null", () => expect(readDesktopShell({ __HANDICAP_DESKTOP__: { rolePageUrl: 3 } })).toBeNull());
it("여분 필드면 null(strict)", () => expect(readDesktopShell({ __HANDICAP_DESKTOP__: { rolePageUrl: "x", token: "t" } })).toBeNull());
it("정상 표지", () => expect(readDesktopShell({ __HANDICAP_DESKTOP__: { rolePageUrl: "tauri://localhost/role.html" } })).toEqual({ rolePageUrl: "tauri://localhost/role.html" }));
// Layout.test.tsx — 기존 vi.mock에 usePoolWorkers: vi.fn() 추가. **파일 최상위** beforeEach(모든 describe 적용 — 기존 "Layout 버전 표시" describe에도)에서 mockPool({ pool_mode: false, workers: [] }), 최상위 afterEach에서 delete (window as any).__HANDICAP_DESKTOP__
it("풀 모드가 아니면 칩이 없다", () => { renderLayout(); expect(screen.queryByText(/서버 · 부하기/)).toBeNull(); });
it("풀 모드면 연결된 워커 수로 칩을 보이고 /workers로 간다", () => { mockPool({ pool_mode: true, workers: [w("a"), w("b")] }); renderLayout();
  expect(screen.getByRole("link", { name: "서버 · 부하기 2대" })).toHaveAttribute("href", "/workers"); });
it("데스크톱 표지가 없으면 「모드 전환」 링크가 없다", () => { renderLayout(); expect(screen.queryByRole("link", { name: "모드 전환" })).toBeNull(); });
it("표지가 있으면 「모드 전환」 링크가 셸 화면을 가리킨다", () => { (window as any).__HANDICAP_DESKTOP__ = { rolePageUrl: "tauri://localhost/role.html" }; renderLayout();
  expect(screen.getByRole("link", { name: "모드 전환" })).toHaveAttribute("href", "tauri://localhost/role.html"); });
```
  (`w(id)`는 `ui/src/api/pool.ts`의 워커 스키마를 만족하는 최소 객체. 기존 "네비 4개" 테스트는 그대로 통과.)
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test -- desktopShell Layout` → FAIL.
- [ ] **Step 3: 구현** — `Layout`에서 `usePoolWorkers()`(풀 모드일 때만 3초 폴링 — 기존 규칙); 칩은 nav 끝(「워커」 뒤) `Link to="/workers"` + `Badge` 프리미티브(accent), `title={ko.nav.poolChipTitle}`, 접근 이름 = 칩 문구. 「모드 전환」은 칩 앞 일반 `<a href={rolePageUrl}>`(외부 origin이라 router `Link` 아님).
- [ ] **Step 4: 통과 확인** — `cd ui && pnpm lint && pnpm test && pnpm build` PASS.
- [ ] **Step 5: 커밋** — `git add ui/src/api/desktopShell.ts ui/src/api/__tests__/desktopShell.test.ts ui/src/components/Layout.tsx ui/src/components/__tests__/Layout.test.tsx ui/src/i18n/ko.ts` → `git commit -m "feat(ui): 상단 「모드 전환」 링크와 풀 모드 칩"`.

---

### Task 9: 문서

**Files:**
- Create: `docs/adr/0057-desktop-role-switch.md`(MADR — 셸 소유 설정 + 재기동, 셸 origin 「모드 전환」 화면, REST loopback 고정, 대안 B·C 기각은 spec §2, 창 생성 방식은 Task 1 결과)
- Modify: `docs/dev/lan-workers.md`(맨 앞 "설치판 앱 버튼 방식" 절 — 「모드 전환」 흐름·OS별 명령·방화벽; 포터블 `--worker-mode pool`이 이번 버전부터 동작하고 v0.14.0 이하에선 무시됐다는 정정 + 토큰 필수 + `kubernetes` 거절), `desktop/CLAUDE.md`(Task 1·6·7에서 실제로 겪은 함정만 — 창 생성 방식·표지·원격 IPC 차단·잠금 밖 긴 작업·정지 순서·`block_on` 위치), 루트 `CLAUDE.md` ADR 인덱스 한 줄.

- [ ] **Step 1: 작성** — 기존 명령줄 절은 지우지 않는다.
- [ ] **Step 2: 확인** — `just doc-budget` PASS(WARN이면 보고).
- [ ] **Step 3: 커밋** — `git add docs/adr/0057-desktop-role-switch.md docs/dev/lan-workers.md desktop/CLAUDE.md CLAUDE.md` → `git commit -m "docs: ADR-0057 데스크톱 모드 전환, LAN 워커 런북에 앱 버튼 방식"`.

---

## 라이브 검증 (구현 후, `/live-verify` — US 척추)

사전: `lsof -iTCP:8081 -sTCP:LISTEN`이 비었는지 확인(spec §6). 워크트리 빌드 앱(`desktop/src-tauri/target/debug/desktop`), `HANDICAP_DB=/tmp/dlm-live.db`, `HANDICAP_DESKTOP_CONFIG_DIR=/tmp/dlm-live-cfg`. GUI 조작은 computer-use 권한 또는 사용자 조작(관람은 요청 시에만). run은 closed-loop `vus ≥ 부하기 수`(풀 상한 = vus, `store/runs.rs:235`).

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 상단 「모드 전환」 → 「서버로 열기」 | 전환 덮개 문구 ≥600ms·클릭 차단 · 「현재 모드: 서버로 열려 있음」+IP · 화면으로 돌아가 칩 「서버 · 부하기 1대」 · 앱 재시작 후 그대로 서버 · `curl --max-time 3 http://<LAN IP>:<REST 포트>/api/health` 연결 실패 |
| US2 | 서버 상태에서 테스트 1개(vus 2) 실행 | 「워커」에 이 PC 이름 · 리포트에 부하 · 실행 중 토글 disabled + 잠금 문구 |
| US3 | 토글 끔 → macOS 명령 복사 → 실행 파일을 워크트리 바이너리로, `--worker-id`를 `live-mac`으로 바꿔 터미널 실행 | 「워커」에 `live-mac` · 테스트가 그 부하기로 분배 · 복사 문자열이 `/Applications/Handicap.app/Contents/MacOS/desktop worker --controller http://<IP>:<포트> --token <32hex> --worker-id "$(hostname)"` 형식 |
| US3(포트) | 다른 프로세스로 **`0.0.0.0:8081`**을 잡아 둔 채(`127.0.0.1` 홀더는 macOS에서 무효 — Task 3 Step 5③) 앱 재시작(서버) → 잡던 것 풀고 다시 재시작 | 포트 변경 안내 · 복사 명령이 새 포트 · 두 번째 재시작은 새 포트 그대로, 안내 없음 |
| US4 | 테스트 실행 중 「혼자 쓰기로 돌아가기」 → 취소 → 다시 → 확인. 서버로 가는 방향도 1회 | 취소 시 변화 없음 · 확인 후 run 배지 `aborted`, run 상세 message 「모드 전환으로 중단」 · 칩 사라짐 |
| US5 | Task 3 Step 5 결과 + 그 스택에서 run 1회 리포트까지 | `pool_mode:true` · CLI 부하기 분배 · 거절 3종 |
| 종료 | 테스트 실행 중 창 닫기 → 재시작 | 그 run 배지 `aborted`, message 「앱 종료로 중단」 |

Windows 실기(방화벽 창·PowerShell 명령·예약 포트·재시작 직후 8081 TIME_WAIT 재bind)·Linux 실기는 연기 — roadmap §B 대기 항목(spec §6).

## 최종 리뷰

- `handicap-reviewer`(whole-branch, 와이어 = IPC DTO ↔ role.html 1:1, `InProcessConfig` 호출부 5곳, bundle·in-process 게이트 재실행) + `security-reviewer`(토큰 생성·저장·표시, 0.0.0.0 bind, 표지, IPC 범위, 프레임 가드).
