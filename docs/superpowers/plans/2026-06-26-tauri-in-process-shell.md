# Tauri 데스크톱 셸 → in-process 백엔드 전환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데스크톱 셸이 bundle `controller` exe를 사이드카로 spawn하던 것을, 컨트롤러를 자기 프로세스에 in-process 임베드(슬라이스 1 `run_in_process`/`RunningController`)하도록 전환한다.

**Architecture:** `desktop/` 크레이트가 `handicap-controller`(bundle feature)를 path 의존으로 끌어와 `run_in_process`로 컨트롤러를 in-process 구동하고 창을 in-process REST 포트로 navigate한다. in-process `SubprocessDispatcher`가 워커를 `current_exe worker …`로 self-spawn하므로 데스크톱 바이너리가 멀티콜이 돼야 한다(`run_worker_if_invoked` — GUI init 전 argv 가드). 사이드카·로그파싱·health폴링·OS 트리종료·`externalBin`은 제거되고, 크래시 teardown은 슬라이스 1의 워커 R4b disconnect-cancel(크로스플랫폼·검증됨)에 맡긴다(R4d Windows Job은 트리거-기반 연기).

**Tech Stack:** Rust, Tauri v2 (2.11.3), clap (derive), tokio, `handicap-controller`(bundle feature: rust-embed 임베드 UI), `handicap-worker`(WorkerArgs/run_dispatch).

**Spec:** `docs/superpowers/specs/2026-06-26-tauri-in-process-shell-design.md` (R1–R10). **슬라이스 1**(이미 머지): `crates/controller/src/in_process.rs`(`run_in_process`/`RunningController`/`InProcessConfig`/`abort_all`) + 워커 R4b.

## Global Constraints

- **비-bundle `controller` 바이너리 byte-identical** — Task 1의 신규 심볼(`run_worker_if_invoked`/`worker_args_from`/`WorkerCli`)은 전부 `#[cfg(feature="bundle")]`. 비-bundle 빌드에 신규 심볼 0. (spec R9, §8)
- **engine / proto / migration / DB / `crates/worker` / 컨트롤러 `main.rs`의 `Cmd::Worker` arm = 0-diff.** (spec R9, §8) — 멀티콜 통합 안 함(컨트롤러 `main.rs`는 무변경).
- **standalone bundle `controller.exe`(ADR-0039 옵션 A) 동작 무변경** — Task 1·2 어느 것도 이 경로를 건드리지 않는다. (spec R10)
- **bundle-gated 코드는 pre-commit 훅이 컴파일조차 안 한다**(훅은 비-bundle `--workspace`만). Task 1은 커밋 전 **수동으로** `cargo build/clippy/nextest -p handicap-controller --features bundle`을 돌려 green 확인(rust-embed가 `ui/dist`를 요구 → 먼저 빌드). (controller/CLAUDE.md "bundle 변경은 수동")
- **desktop 크레이트는 pre-commit·tdd-guard·spec-review-guard 모두 밖**(자체 `[workspace]`·`crates/*/src` 비대상). Task 2/3은 **수동** `cd desktop/src-tauri && cargo build && cargo test`로 검증. (desktop/CLAUDE.md)
- **desktop 빌드는 `ui/dist`가 컴파일타임에 존재해야 한다**(controller bundle feature의 rust-embed). 빌드 전 repo 루트에서 `just ui-build`(또는 `cd ui && pnpm install && pnpm build`). (spec R6, §6)
- **`HANDICAP_DB` env**로 in-process DB 경로 override(dev/live-verify 격리). 미설정 = `dirs` data-local-dir 기본. (spec R5)

---

## Task 1: 컨트롤러 워커 멀티콜 가드 (`run_worker_if_invoked`)

**Files:**
- Modify: `crates/controller/src/in_process.rs` (신규 `WorkerCli`/`worker_args_from`/`run_worker_if_invoked` + 인라인 `mod tests` 추가 — 전부 모듈이 이미 `#[cfg(feature="bundle")]`)

**Interfaces:**
- Consumes: `handicap_worker::{WorkerArgs, init_worker_tracing, run_dispatch}`(worker/src/lib.rs:29/53/559). `WorkerArgs`는 `#[derive(clap::Args)]`(worker/src/lib.rs:28) — 자체 `Parser` 없음.
- Produces: `pub fn handicap_controller::in_process::run_worker_if_invoked()`(Task 2 desktop `main.rs`가 호출). 순수 헬퍼 `worker_args_from(argv) -> Option<WorkerArgs>`(테스트용).

**왜:** in-process `SubprocessDispatcher`는 워커를 `[current_exe, "worker", "--controller", …]`로 spawn한다(in_process.rs:262-265, `with_leading_args(["worker"])`). desktop 모드에서 `current_exe`=데스크톱 바이너리라, 그 바이너리가 `<exe> worker …`를 잡아 GUI 대신 워커로 동작해야 한다. 워커 *동작*은 `handicap_worker`가 단일소스; 이 가드는 argv 분기 + 런타임 + exit 글루.

- [ ] **Step 1: `ui/dist` 선빌드 (rust-embed 전제, bundle 빌드/테스트에 필수)**

Run (repo 루트):
```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/tauri-inprocess-shell
[ -f ui/dist/index.html ] || (cd ui && pnpm install && pnpm build)
ls ui/dist/index.html
```
Expected: `ui/dist/index.html` 존재.

- [ ] **Step 2: 실패하는 단위 테스트 작성 — `worker_args_from`**

`crates/controller/src/in_process.rs`의 기존 `#[cfg(test)] mod tests { … }` 안에 추가(파일 전체가 `#[cfg(feature="bundle")]`라 테스트도 bundle-gated):

```rust
    #[test]
    fn worker_args_from_parses_worker_invocation() {
        let argv = [
            "app", "worker",
            "--controller", "http://127.0.0.1:8081",
            "--run-id", "r1",
            "--worker-id", "w1",
        ];
        let got = worker_args_from(argv).expect("worker invocation must parse");
        assert_eq!(got.controller, "http://127.0.0.1:8081");
        assert_eq!(got.run_id.as_deref(), Some("r1"));
        assert_eq!(got.worker_id.as_deref(), Some("w1"));
    }

    #[test]
    fn worker_args_from_ignores_controller_invocation() {
        // GUI/컨트롤러 기동: argv[1]이 "worker"가 아니면 None(가드가 return해 GUI로).
        assert!(worker_args_from(["app"]).is_none());
        assert!(worker_args_from(["app", "--rest", "127.0.0.1:0"]).is_none());
    }

    #[test]
    fn worker_args_from_pool_invocation_without_run_id() {
        // 풀 워커: --run-id 생략(should_run_pool). 토큰 스킵 + 파싱 parity 확인.
        let got = worker_args_from(["app", "worker", "--controller", "http://127.0.0.1:8081"])
            .expect("pool worker invocation must parse");
        assert_eq!(got.controller, "http://127.0.0.1:8081");
        assert!(got.run_id.is_none());
    }
```

- [ ] **Step 3: 테스트가 실패(미컴파일)함을 확인**

Run:
```bash
cargo test -p handicap-controller --features bundle worker_args_from 2>&1 | tail -20
```
Expected: FAIL — `cannot find function `worker_args_from``.

- [ ] **Step 4: 최소 구현 작성 — `WorkerCli` + `worker_args_from` + `run_worker_if_invoked`**

`in_process.rs` 상단 import 근처에 `use clap::Parser;`(이미 있으면 생략). 모듈 본문(테스트 mod 밖, 다른 pub fn들과 같은 레벨)에 추가:

```rust
/// worker/src/main.rs:6-11 미러 — `WorkerArgs`는 derive(Args)라 자체 파싱이 안 되므로
/// flatten 래퍼가 `Parser`를 제공한다. (bundle-gated 모듈 안이라 cfg 불필요.)
#[derive(clap::Parser)]
struct WorkerCli {
    #[command(flatten)]
    args: handicap_worker::WorkerArgs,
}

/// 순수: argv[1]=="worker"면 그 토큰을 드롭하고 나머지를 `WorkerArgs`로 파싱한다.
/// dispatcher argv = `[exe, "worker", "--controller", …]`(in_process.rs `with_leading_args`).
/// `[synthetic_prog] ++ argv[2..]`를 `WorkerCli::try_parse_from`에 먹인다(합성 argv[0]=프로그램명).
/// standalone `controller.exe`의 clap `Cmd::Worker`가 같은 argv를 소비하는 방식과 정합.
fn worker_args_from<I, T>(argv: I) -> Option<handicap_worker::WorkerArgs>
where
    I: IntoIterator<Item = T>,
    T: Into<std::ffi::OsString>,
{
    let v: Vec<std::ffi::OsString> = argv.into_iter().map(Into::into).collect();
    if v.get(1)?.to_str()? != "worker" {
        return None;
    }
    let synth = std::iter::once(std::ffi::OsString::from("worker"))
        .chain(v.into_iter().skip(2));
    WorkerCli::try_parse_from(synth).ok().map(|c| c.args)
}

/// 멀티콜 가드. `<exe> worker …`로 실행됐으면 워커로 동작 후 프로세스 종료(절대 return 안 함);
/// 아니면 즉시 return해 호출자가 GUI를 띄우게 한다. **desktop `main()`의 첫 문장으로 호출**해야
/// 한다(Tauri/런타임 init 전). `run_in_process`는 tracing init을 안 하므로(caller 소유) 워커
/// 프로세스는 자기 `init_worker_tracing()`을 호출한다.
pub fn run_worker_if_invoked() {
    let Some(args) = worker_args_from(std::env::args_os()) else {
        return;
    };
    handicap_worker::init_worker_tracing();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build worker runtime");
    let code = match rt.block_on(handicap_worker::run_dispatch(args)) {
        Ok(()) => 0,
        Err(e) => {
            tracing::error!(error = ?e, "worker failed");
            1
        }
    };
    std::process::exit(code);
}
```

주의: `use clap::Parser;`가 `WorkerCli::try_parse_from`(Parser provided method)에 필요. `in_process.rs`에 이미 다른 clap import가 없으면 파일 상단 `use` 블록에 추가.

- [ ] **Step 5: 테스트 통과 확인 (bundle feature)**

Run:
```bash
cargo test -p handicap-controller --features bundle worker_args_from 2>&1 | tail -20
```
Expected: 3 tests PASS.

- [ ] **Step 6: bundle FULL 게이트 — 필터 없이(기존-깨짐 테스트 적발) + 비-bundle byte-identical 확인**

Run:
```bash
# bundle: 필터 없이 전체(controller/CLAUDE.md "필터된 bundle 테스트는 기존-깨짐 테스트를 놓친다")
cargo build -p handicap-controller --features bundle 2>&1 | tail -5
cargo clippy -p handicap-controller --features bundle --all-targets -- -D warnings 2>&1 | tail -5
cargo nextest run -p handicap-controller --features bundle 2>&1 | tail -15
# 비-bundle: 신규 심볼 0(byte-identical) — 컴파일·테스트 green
cargo build -p handicap-controller 2>&1 | tail -5
cargo nextest run -p handicap-controller 2>&1 | tail -10
```
Expected: bundle build/clippy 0 경고, nextest 0-failed. 비-bundle build 성공·nextest 0-failed. (clippy `-D warnings`로 `WorkerCli`/`worker_args_from`이 dead_code가 아님을 확인 — `run_worker_if_invoked`가 pub이라 reachable.)

- [ ] **Step 7: 커밋 (단일 green — 테스트+구현 fold)**

```bash
git add crates/controller/src/in_process.rs
git commit -m "feat(controller): bundle 워커 멀티콜 가드 run_worker_if_invoked (슬라이스 2 Task 1)"
git log -1 --oneline
```
(pre-commit은 비-bundle workspace 게이트를 돈다 — bundle 코드는 안 보지만 Step 6에서 수동 검증 완료. `git commit`은 파이프 없이·foreground.)

---

## Task 2: 데스크톱 in-process 전환 (SidecarBackend→InProcessBackend)

**Files:**
- Modify: `desktop/src-tauri/Cargo.toml` (handicap-controller dep 추가·reqwest/libc/win32job 제거)
- Modify: `desktop/src-tauri/Cargo.lock` (재생성 — 빌드가 갱신)
- Rewrite: `desktop/src-tauri/src/backend.rs` (SidecarBackend 삭제·InProcessBackend 추가·트레잇 유지)
- Trim: `desktop/src-tauri/src/launch.rs` (base_url만 잔존)
- Modify: `desktop/src-tauri/src/lib.rs` (setup가 InProcessBackend::start)
- Modify: `desktop/src-tauri/src/main.rs` (첫 문장 run_worker_if_invoked)
- Modify: `desktop/src-tauri/tauri.conf.json` (externalBin 제거)

**Interfaces:**
- Consumes (Task 1): `handicap_controller::in_process::run_worker_if_invoked()`. (슬라이스 1): `handicap_controller::in_process::{InProcessConfig, RunningController, run_in_process}`.
- Produces: `backend::InProcessBackend`(`ControllerBackend` 구현). `ControllerBackend` 트레잇 유지(R7).

**의존:** Task 1 **커밋** 후(desktop `cargo build`가 worktree 소스의 `handicap-controller`를 path-dep로 컴파일 — master 머지 불요·`run_worker_if_invoked` 심볼 필요).

- [ ] **Step 1: `desktop/src-tauri/Cargo.toml` — 의존 조정**

`[dependencies]`에 추가, `reqwest` 줄 제거, 두 `[target.*]` 블록 제거. 결과 `[dependencies]`+target 영역:

```toml
[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
anyhow = "1"
handicap-controller = { path = "../../crates/controller", features = ["bundle"] }
```
(`reqwest`·`[target.'cfg(unix)'.dependencies] libc`·`[target.'cfg(windows)'.dependencies] win32job` 3개 블록 삭제. `[lib]`/`[build-dependencies]`/`[profile.release]`는 무변경.)

- [ ] **Step 2: `desktop/src-tauri/src/launch.rs` — 사이드카 글루 제거, `base_url`만 유지**

파일 전체를 다음으로 교체:

```rust
//! Tauri 런타임 비의존 순수 글루. 단위 테스트로 잠근다.

/// 창이 navigate할 베이스 URL(`http://127.0.0.1:<port>/`).
pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_is_localhost() {
        assert_eq!(base_url(8080), "http://127.0.0.1:8080/");
    }
}
```
(`SpawnConfig`·`resolve_sidecar_path`·`strip_ansi`·`parse_rest_port`·`health_url`·`HEALTH_POLL_*`·그 테스트 전부 삭제. `health_url` 단언이 있던 `urls_are_localhost_with_health_path`는 위 `url_is_localhost`로 대체.)

- [ ] **Step 3: `desktop/src-tauri/src/backend.rs` — SidecarBackend 삭제, InProcessBackend 추가**

파일 전체를 다음으로 교체:

```rust
//! controller 실행 추상(R7) + in-process 구현(접근 2). 셸(lib.rs)은 트레잇의
//! base_url()/shutdown()에만 의존 → 사이드카(접근 1)는 제거, in-process가 유일 구현.

use handicap_controller::in_process::{InProcessConfig, RunningController, run_in_process};

/// controller 실행 백엔드 추상. LAN 전방호환 위해 트레잇 경계 유지(R7).
pub trait ControllerBackend: Send + Sync {
    /// 창이 navigate할 베이스 URL(`http://127.0.0.1:<port>/`).
    fn base_url(&self) -> String;
    /// 종료 시 호출 — controller graceful shutdown(active run abort → drain).
    fn shutdown(&self);
}

/// 컨트롤러를 Tauri 프로세스에 in-process 임베드. `RunningController`(슬라이스 1)를 보유한다.
pub struct InProcessBackend {
    rc: RunningController,
    base_url: String,
}

// `Box<dyn ControllerBackend>`(managed state)로 쓰이려면 Send+Sync 필요 — 컴파일타임 고정.
// RunningController가 비-Send/Sync가 되면 여기서 즉시 에러(조기 신호).
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<InProcessBackend>();
};

impl InProcessBackend {
    /// in-process 컨트롤러 부팅(REST/gRPC 사전바인딩·serve/scheduler/heartbeat spawn) →
    /// 실제 REST 포트로 base_url 캐시. 실패(bind/DB/migration)면 Err → 호출자가 splash에 표시.
    pub async fn start(cfg: InProcessConfig) -> anyhow::Result<InProcessBackend> {
        let rc = run_in_process(cfg).await?;
        let base_url = crate::launch::base_url(rc.rest_addr().port());
        Ok(InProcessBackend { rc, base_url })
    }
}

impl ControllerBackend for InProcessBackend {
    fn base_url(&self) -> String {
        self.base_url.clone()
    }

    fn shutdown(&self) {
        // RunningController::shutdown()은 async·bounded(슬라이스 1 §6 — 절대 hang 안 함).
        // RunEvent::Exit는 메인(이벤트루프) 스레드라 tokio 워커가 아님 → block_on 안전(nested-runtime 없음).
        tauri::async_runtime::block_on(self.rc.shutdown());
    }
}
```
(`ChildTree`·`kill_tree_on_failure`·사이드카 `start`·`killpg`/Job `shutdown`·`#[cfg(all(test, unix))] mod tests`(`killpg_terminates_child_and_grandchild`) 전부 삭제. `std::process::Stdio`/`tokio::process`/`oneshot`/`libc`/`win32job`/`reqwest` 등 사이드카 import 전부 삭제.)

- [ ] **Step 4: `desktop/src-tauri/src/lib.rs` — setup가 InProcessBackend::start**

파일 전체를 다음으로 교체:

```rust
mod backend;
mod launch;

use std::sync::Mutex;

use backend::{ControllerBackend, InProcessBackend};
use handicap_controller::in_process::InProcessConfig;
use tauri::{Manager, RunEvent};

/// 종료 훅이 접근할 backend 핸들(managed state).
struct BackendState(Mutex<Option<Box<dyn ControllerBackend>>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackendState(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // in-process 컨트롤러: DB는 HANDICAP_DB env override(dev/live-verify 격리) 또는 기본.
                let cfg = InProcessConfig {
                    db: std::env::var("HANDICAP_DB").ok(),
                    ..InProcessConfig::default()
                };
                match InProcessBackend::start(cfg).await {
                    Ok(be) => {
                        let url = be.base_url();
                        if let Some(win) = handle.get_webview_window("main") {
                            if let Ok(u) = url.parse::<tauri::Url>() {
                                let _ = win.navigate(u);
                            }
                        }
                        handle
                            .state::<BackendState>()
                            .0
                            .lock()
                            .unwrap()
                            .replace(Box::new(be));
                    }
                    Err(e) => {
                        // 창의 스플래시에 에러 표시(navigate 금지).
                        if let Some(win) = handle.get_webview_window("main") {
                            let js = format!(
                                "window.__setError && window.__setError({})",
                                serde_json::to_string(&e.to_string())
                                    .unwrap_or_else(|_| "\"error\"".into())
                            );
                            let _ = win.eval(&js);
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(be) = app_handle.state::<BackendState>().0.lock().unwrap().take() {
                    be.shutdown();
                }
            }
        });
}
```
(사이드카 `exe_dir`/`resolve_sidecar_path`/`SidecarBackend::start` 제거. `SpawnConfig` import 제거.)

- [ ] **Step 5: `desktop/src-tauri/src/main.rs` — 첫 문장 멀티콜 가드**

파일 전체를 다음으로 교체:

```rust
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 멀티콜: `<exe> worker …`로 실행됐으면 워커로 동작 후 종료(GUI init 전).
    // in-process SubprocessDispatcher가 워커를 current_exe(=이 바이너리)로 self-spawn한다.
    handicap_controller::in_process::run_worker_if_invoked();
    desktop_lib::run()
}
```

- [ ] **Step 6: `desktop/src-tauri/tauri.conf.json` — externalBin 제거**

`"bundle"` 객체에서 `"externalBin": ["binaries/controller"],` 줄 삭제. 결과 `bundle` 블록:

```json
  "bundle": {
    "active": true,
    "targets": ["nsis", "msi", "dmg", "app"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
```

- [ ] **Step 7: `ui/dist` 선빌드(rust-embed) 후 데스크톱 빌드·테스트 (Cargo.lock 재생성 포함)**

Run:
```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/tauri-inprocess-shell
[ -f ui/dist/index.html ] || (cd ui && pnpm install && pnpm build)
cd /Users/sgj/develop/handicap/.claude/worktrees/tauri-inprocess-shell/desktop/src-tauri
cargo build 2>&1 | tail -15
cargo test 2>&1 | tail -15
```
Expected: `cargo build` 성공(handicap-controller bundle 그래프 전체 컴파일·`Cargo.lock` 갱신·`edition.workspace`/`rust-version.workspace` 루트 상속 해소 확인), `cargo test` 0-failed(`url_is_localhost` 등). 빌드 실패 시: ① `ui/dist` 없는지(rust-embed), ② `handicap-controller` path/feature 오타 확인.

- [ ] **Step 8: 커밋 (desktop crate green)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/tauri-inprocess-shell
git add desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock desktop/src-tauri/src/backend.rs desktop/src-tauri/src/launch.rs desktop/src-tauri/src/lib.rs desktop/src-tauri/src/main.rs desktop/src-tauri/tauri.conf.json
git commit -m "feat(desktop): in-process 백엔드 전환 — SidecarBackend→InProcessBackend·멀티콜·externalBin 제거 (슬라이스 2 Task 2)"
git log -1 --oneline
```
주의: `desktop/src-tauri/Cargo.toml`이 staged라 pre-commit이 비-bundle workspace 게이트를 돈다(desktop은 워크스페이스 밖이라 *검증 안 됨* — Step 7의 수동 `cargo build/test`가 진짜 검증). 게이트 통과(루트 워크스페이스 무변경)면 커밋 landed. `git commit`은 파이프 없이·foreground·`run_in_background`로(workspace 게이트 수 분).

---

## Task 3: 문서 — ADR-0042 + 데스크톱 함정 노트 + ADR-0040 status

**Files:**
- Create: `docs/adr/0042-tauri-in-process-controller.md`
- Modify: `docs/adr/0040-tauri-desktop-wrapper.md` (status: 접근 1 채택 → 접근 2로 대체(0042))
- Modify: `desktop/README.md` (사이드카 문구 → in-process)
- Modify: `desktop/CLAUDE.md` (사이드카 함정 → in-process 함정)
- Modify: `CLAUDE.md` (루트 — "알아둘 결정들"에 ADR-0042 한 줄)

**의존:** Task 2 후(문서가 최종 코드 형상을 반영).

- [ ] **Step 1: ADR-0042 작성**

`docs/adr/0042-tauri-in-process-controller.md` 생성(MADR 포맷, 인덱스는 한 줄 규칙이므로 상세는 여기):

```markdown
# 0042. 라이트 Windows 데스크톱 배포 — 옵션 B 접근 2: Tauri in-process 컨트롤러

- 상태: 채택 (2026-06-26) — ADR-0040(접근 1 사이드카)을 대체
- 관련: [ADR-0040](0040-tauri-desktop-wrapper.md)(접근 1·R7 backend 경계), [ADR-0039](0039-windows-desktop-distribution.md)(옵션 A/B·LAN feasibility), `docs/superpowers/specs/2026-06-26-tauri-in-process-backend-design.md`(슬라이스 1), `docs/superpowers/specs/2026-06-26-tauri-in-process-shell-design.md`(슬라이스 2)

## 맥락

ADR-0040은 Tauri 셸을 접근 1(bundle `controller` exe를 사이드카 프로세스로 spawn·로그에서 포트 파싱·health 폴링·OS 트리종료)로 구현하고, 접근 2(in-process 임베드)를 R7 `ControllerBackend{base_url(),shutdown()}` 추상 뒤로 예고했다. 접근 2는 사이드카·로그파싱·health폴링·별도 프로세스 트리종료를 제거한다.

## 결정

**컨트롤러를 Tauri 프로세스에 in-process 임베드한다(접근 2).** 두 슬라이스로 구현:

- **슬라이스 1(백엔드):** 컨트롤러 부트스트랩을 `run_in_process(InProcessConfig) -> RunningController`로 추출(bundle-gated, REST/gRPC 사전바인딩→실주소 동기 반환·serve/scheduler/heartbeat를 취소 토큰과 함께 spawn). `RunningController::shutdown()` = graceful **bounded-drain**(절대 hang 안 함: active run abort → 토큰 cancel → 5s drain → hard-stop). 워커 **R4b disconnect-cancel**(인바운드 스트림이 명시적 `Abort` 없이 닫히면=컨트롤러 소멸 시 run 취소·크로스플랫폼·loopback 거의 즉시).
- **슬라이스 2(셸):** desktop `SidecarBackend`→`InProcessBackend`(`run_in_process` 보유·창을 in-process REST 포트로 navigate·async shutdown을 `tauri::async_runtime::block_on`으로 브리지). 데스크톱 바이너리 **멀티콜**(`run_worker_if_invoked` — in-process `SubprocessDispatcher`가 `current_exe worker …`로 self-spawn하므로 GUI init 전 argv 가드). `externalBin`·사이드카·health폴링 제거.

**크래시-견고 워커 teardown은 계층화:** R4b disconnect-cancel(1차·크로스플랫폼·검증가능) + `abort_all` graceful(정상종료) + `mark_orphans_failed`(영속 백스톱). **Windows Job(R4d)은 트리거-기반 연기** — in-process가 컨트롤러 자식 프로세스를 없애 ADR-0040 R3의 "OS-레벨 트리킬이 load-bearing" 근거가 소멸했고, R4b가 사용자 채택 조건("하드 크래시에도 워커 고아 0/bounded")을 크로스플랫폼·검증가능 형태로 충족한다. Windows에서 hung-워커 고아가 실제 관측되면 그때 desktop-only로 Job을 추가한다(트레잇 경계 보존).

## 근거

- **사이드카 제거가 단순화:** 별도 프로세스·로그 포트파싱(ANSI strip)·health 폴링·bind-ok-but-health-failed 좀비가 구조적으로 소멸. 창은 `rest_addr()`로 직접 navigate.
- **R4b가 OS-레벨 소켓 teardown 기반이라 Windows=Unix:** 컨트롤러 소멸→소켓 close→워커가 `Abort` 없는 close 감지→run 취소→종료. 사이드카가 Job/killpg를 쓴 *원래 이유*(컨트롤러 자식이 시그널 핸들러 없이 손자 워커에 미전파)를 R4b가 대체.
- **R7 backend 경계·byte-identical-when-off 계승:** `ControllerBackend` 트레잇 유지(LAN 전방호환). 신규 컨트롤러 심볼은 전부 `#[cfg(feature="bundle")]` → 비-bundle 바이너리 byte-identical. engine/proto/migration 0-diff.

## 대안 (기각)

- **접근 1 사이드카 유지:** 로그파싱·health폴링·좀비 복잡성. (단 LAN 헤드리스 워커 분리가 중요해지면 사이드카가 정답일 수 있어 standalone bundle `controller.exe`[ADR-0039 옵션 A]는 별도 산출물로 유지.)
- **Windows Job 지금 구현:** self-assign(WebView2 nested-job·자가-kill 타이밍 캐벗)·controller-passthrough(Windows API를 컨트롤러에 — blast radius)·runbook-only 검증(macOS 실측 불가). R4b가 1차를 충족하므로 트리거-기반 연기.

## 결과

- 검증 = macOS 라이브(슬라이스 1: bundle in-process boot→health→self-spawn 워커→run 완주→R4b 크래시 backstop·좀비0; 슬라이스 2: 데스크톱 바이너리가 풀 워커로 멀티콜 가드 실측·R4b). GUI 렌더(창 navigate)·WebView2·Windows 인스톨러는 runbook(headless 한계).
- standalone bundle `controller.exe` 보존(LAN·수동 fallback).
- 연기: R4d Windows Job(트리거)·코드서명/SmartScreen/인스톨러 메타데이터·트레이/자동업데이트·LAN 자동등록·Windows CI.
```

- [ ] **Step 2: ADR-0040 status 갱신**

`docs/adr/0040-tauri-desktop-wrapper.md`의 상태 줄을 수정:
```markdown
- 상태: 접근 1 채택 (2026-06-19) → 접근 2로 대체 ([ADR-0042](0042-tauri-in-process-controller.md), 2026-06-26)
```

- [ ] **Step 3: `desktop/README.md` 갱신**

사이드카(`launch.rs SpawnConfig`/포트 파싱/헬스 URL/`externalBin` 복사) 문구를 in-process로 교체. 핵심: "컨트롤러를 in-process 임베드(`handicap-controller` bundle feature)·창이 in-process REST 포트로 navigate·빌드는 `ui/dist` 필요·`HANDICAP_DB`로 DB override·데스크톱 바이너리가 워커 멀티콜(`<app> worker …`)". (사이드카/`binaries/controller` 복사 단계 삭제.)

- [ ] **Step 4: `desktop/CLAUDE.md` 갱신 — 함정 노트 교체**

삭제: `externalBin`이 빌드타임 바이너리 요구·`NO_COLOR`/`parse_rest_port` ANSI strip·트리종료 `start()` 실패경로 정리(사이드카 전용). 추가:
- **데스크톱 빌드는 `ui/dist`가 컴파일타임 존재해야 한다**(controller bundle feature의 rust-embed `$CARGO_MANIFEST_DIR/../../ui/dist`) — `externalBin` 복사 단계 대체. 빌드 전 `just ui-build`.
- **데스크톱 바이너리는 멀티콜** — in-process `SubprocessDispatcher`가 워커를 `current_exe worker …`로 self-spawn하므로 `main()` 첫 문장 `run_worker_if_invoked()`가 GUI init 전 argv를 분기(`<app> worker …`→`process::exit`). 라이브 검증은 풀 모드 + `<app> worker --controller …` 직접 실행으로 헤드리스 가능(데스크톱을 *컨트롤러로* 띄우는 건 WindowServer 필요).
- **Windows windowless 워커 = 콘솔 로그 없음** — `windows_subsystem="windows"`라 워커 서브프로세스도 콘솔 없음(프로덕션 바람직·dev는 debug 빌드/로그파일).
- **async shutdown 브리지** — `InProcessBackend::shutdown`은 sync 트레잇 메서드에서 `tauri::async_runtime::block_on(rc.shutdown())`. `RunEvent::Exit`는 메인 스레드(tokio 워커 아님)라 nested-runtime panic 없음. `RunningController::shutdown`은 bounded(절대 hang 안 함).
- **데스크톱 크레이트가 이제 `handicap-controller{bundle}` 그래프 전체를 컴파일**(→`handicap-proto`→`tonic-build`가 `protoc` 요구) — fresh 머신은 `protoc` 필요(루트 CLAUDE.md 세팅엔 이미 있음). 종전엔 desktop이 handicap 크레이트를 전혀 안 컴파일했다.
- (유지) 자체 `[workspace]`·desktop 테스트 게이트 밖·lib명 `desktop_lib`·창 label "main"·`.dmg` GUI 세션 필요.

- [ ] **Step 5: 루트 `CLAUDE.md` "알아둘 결정들"에 ADR-0042 한 줄 추가**

`- **0041** …` 다음 줄에:
```markdown
- **0042** 라이트 Windows 데스크톱 배포 옵션 B 접근 2: Tauri in-process 컨트롤러(`run_in_process`/`RunningController` 임베드·desktop `InProcessBackend`·워커 멀티콜 `run_worker_if_invoked`·사이드카/externalBin 제거·R4b disconnect-cancel 크래시 teardown·R4d Windows Job 트리거-연기·비-bundle byte-identical). ADR-0040(접근 1) 대체
```

- [ ] **Step 6: 커밋 (docs-only fast-path)**

```bash
git add docs/adr/0042-tauri-in-process-controller.md docs/adr/0040-tauri-desktop-wrapper.md desktop/README.md desktop/CLAUDE.md CLAUDE.md
git commit -m "docs(adr): ADR-0042 in-process 컨트롤러 채택 + 데스크톱 함정 노트 (슬라이스 2 Task 3)"
git log -1 --oneline
```
(`.md`-only라 pre-commit fast-path. `desktop/CLAUDE.md`도 `.md`라 cargo 게이트 skip.)

---

## 구현 후 검증 (finish-slice §5 — 코드 task 아님)

라이브 검증은 spec §7.3(필수·헤드리스) — `/live-verify` 또는 수동:
1. **데스크톱 바이너리 = 풀 워커 (멀티콜 가드 헤드리스 실측):** 컨트롤러를 pool 모드로 기동(`controller --worker-mode pool` 또는 standalone `controller.exe`) → `<desktop-exe> worker --controller <grpc>` 직접 실행(창 안 뜸·가드가 exit) → `GET /api/pool/workers`에 데스크톱-워커 idle 등록 → run 1개 생성·완주.
2. **R4b 크래시:** 위 run 중 컨트롤러/워커 `kill -9` → 데스크톱-워커가 run 취소 후 종료(`ps` 고아 0).
3. **runbook-only(GUI 세션):** 데스크톱 앱 실행→창이 in-process 포트 navigate→React UI 렌더→run→창 닫기 시 `block_on(shutdown())` bounded 종료. (spec §7.4 — macOS headless 불가, build-log에 연기 기록.) **주의: debug `cargo build`는 rust-embed가 `ui/dist`를 런타임에 디스크에서 읽으므로**(슬라이스 1 기성동작) 이 GUI run엔 worktree 경로에 `ui/dist`가 존재해야 한다(release 빌드는 임베드). 헤드리스 §7.3 1–2(데스크톱=워커, UI 서빙 안 함)엔 무관.

`run_in_process` 자체는 슬라이스 1이 이미 라이브 검증(데스크톱 `InProcessBackend::start`는 그 위 base_url 포맷일 뿐 신규 집계 0) — 1·2가 PASS면 in-process 회귀는 생략하고 build-log에 근거 기록.

## Self-Review 결과 (작성자 체크)

- **Spec 커버리지:** R1(Task2 backend), R2(Task2 backend/launch), R3(Task1), R4(Task2 main), R5(Task2 lib), R6(Task2 conf+빌드), R7/R4d 연기(Task3 ADR), R8(Task2 Cargo+lock), R9 byte-identical(Task1 Step6 검증·Global Constraints), R10(무변경·Global Constraints). §7 라이브(구현 후 검증). §10 ADR-0042(Task3). 갭 없음.
- **Placeholder:** 없음(전 코드 완전).
- **타입 일관성:** `run_worker_if_invoked`/`worker_args_from`/`WorkerCli`(Task1) ↔ Task2 main `handicap_controller::in_process::run_worker_if_invoked` 일치. `InProcessBackend::start(InProcessConfig)`·`base_url()`·`shutdown()` ↔ Task2 lib 사용처 일치. `crate::launch::base_url(u16)` ↔ launch.rs 정의 일치.

<!-- REVIEW-GATE: APPROVED -->
