# Tauri 데스크톱 셸 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 `bundle`-feature `controller.exe`를 사이드카로 spawn해 네이티브 창에 핸디캡 UI를 띄우고, 창 닫으면 프로세스 트리째 정리하며, Windows 인스톨러를 산출하는 Tauri v2 데스크톱 셸을 `desktop/`에 추가한다(`crates/**`·`ui/src` 0-diff).

**Architecture:** Tauri v2 셸(`desktop/src-tauri/`)이 부팅 시 `tauri::async_runtime::spawn`으로 사이드카 controller를 **직접**(`tokio::process::Command`, plugin-shell 아님) `--rest 127.0.0.1:0 --grpc 127.0.0.1:0 --no-open`로 spawn → controller stdout/stderr 로그에서 **실제 바인딩 REST 포트**를 파싱 → `GET /api/health`==`ok` 준비 확인 → 창 webview를 `http://127.0.0.1:<port>/`로 navigate. 종료 시(`RunEvent::Exit`) Unix `killpg`/Windows Job Object로 controller+손자 워커를 트리째 종료. 셸은 `ControllerBackend{base_url(),shutdown()}` 경계 뒤에 두어 접근 2(in-process)·LAN 전방호환.

**Tech Stack:** Tauri v2 (`tauri = "2"`, `tauri-build = "2"`), tokio, reqwest(헬스폴), libc(unix killpg), win32job(windows Job Object). 프런트는 정적 스플래시 한 장(실 UI는 controller가 서빙).

## Global Constraints

- **Tauri v2 전용** — `tauri = "2"`/`tauri-build = "2"`. v1 API(`tauri::api::process`, `tauri::Window`) 금지.
- **`desktop/`는 cargo workspace 멤버가 아니다** — 루트 `Cargo.toml` `members = ["crates/*"]` 밖. `desktop/`에 자체 `Cargo.toml`을 두되 루트 워크스페이스에 추가 금지(R5). 결과: `cargo build --workspace`·pre-commit cargo 게이트가 desktop을 안 건드림(`CARGO_PATHS` 정규식 `^(crates/|Cargo\.toml$|...)`는 `desktop/...` 비매치).
- **`crates/**`·`ui/src` 0-diff(R4)** — controller/worker/engine/proto/migration/UI 한 줄도 수정 금지. 변경 표면 = `desktop/`(신규) + `docs/`.
- **localhost-only(R6)** — spawn 인자에 `0.0.0.0` 등 네트워크 노출 주소 금지(기본 `127.0.0.1`).
- **사이드카 바이너리는 빌드타임 복사물(R13)** — `desktop/src-tauri/binaries/controller-<triple>`는 커밋 금지(`desktop/.gitignore`).
- **검증 = macOS(필수) + Windows(런북 갭으로 연기)** — `cfg(windows)` 코드(Job Object)는 macOS에서 컴파일 안 됨 → 작성하되 Windows 검증 연기(옵션 A 정책).
- **준비 신호 = `GET /api/health` 상태 200 + 본문 `ok`** — 상태코드만/`/`경로 금지(bundle SPA fallback이 200 HTML 반환).
- **desktop 크레이트 테스트는 pre-commit이 안 돌린다** — 각 task 커밋 전 `cd desktop/src-tauri && cargo test`를 **수동** 실행(게이트 밖).
- **subagent commit은 단일 foreground 호출**(`run_in_background:false`, 폴링 금지) — 루트 CLAUDE.md A4b.

---

## File Structure

- `desktop/.gitignore` — desktop 빌드 산출물·사이드카 바이너리 무시(R13).
- `desktop/src-tauri/Cargo.toml` — Tauri v2 + tokio/reqwest/libc/win32job 의존. workspace 밖(R5).
- `desktop/src-tauri/build.rs` — `tauri_build::build()`.
- `desktop/src-tauri/tauri.conf.json` — 단일 창(초기 `splash.html`)·`frontendDist`·`bundle.externalBin`·`csp:null`(R1/R10).
- `desktop/src-tauri/binaries/.gitkeep` — externalBin 복사 타깃 디렉토리(바이너리 자체는 gitignore).
- `desktop/src-tauri/src/launch.rs` — **순수 글루**: `SpawnConfig`/`to_args`/`resolve_sidecar_path`/`parse_rest_port`/`base_url`/`health_url`/폴 상수(R6/R8/R11). 단위 테스트 동거.
- `desktop/src-tauri/src/backend.rs` — `ControllerBackend` 트레잇 + `SidecarBackend`(spawn·로그드레인·포트파싱·헬스폴·killpg/Job Object)(R3/R7/R12).
- `desktop/src-tauri/src/lib.rs` — `run()`: managed state + setup 훅(async spawn→navigate/에러) + `RunEvent::Exit` 정리(R1/R3).
- `desktop/src-tauri/src/main.rs` — `app_lib::run()` 호출(스캐폴드 그대로).
- `desktop/src/splash.html`(또는 `desktop/splash/`) — "시작 중…" 정적 페이지(R1).
- `docs/dev/tauri-desktop-build.md` — 빌드 런북 + Windows-검증 체크리스트(R10/R14).
- `docs/adr/0040-tauri-desktop-wrapper.md` — 결정 기록(Task 6).

---

### Task 1: 스캐폴드 + `desktop/.gitignore` + 순수 글루(`launch.rs`)

**Files:**
- Create: `desktop/` (Tauri v2 vanilla 스캐폴드 — `src-tauri/{Cargo.toml,build.rs,tauri.conf.json,src/{main,lib}.rs}`, 정적 프런트)
- Create: `desktop/.gitignore`
- Create/Modify: `desktop/src-tauri/src/launch.rs` (+ `lib.rs`에 `mod launch;`)
- Test: `launch.rs` 인라인 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `SpawnConfig`(+`Default`,`to_args()->Vec<String>`), `resolve_sidecar_path(&Path, Option<&str>)->PathBuf`, `parse_rest_port(&str)->Option<u16>`, `base_url(u16)->String`, `health_url(u16)->String`, `HEALTH_POLL_ATTEMPTS:u32`, `HEALTH_POLL_INTERVAL_MS:u64`.

- [ ] **Step 1: Tauri CLI + 스캐폴드**

Run (워크트리 루트에서):
```bash
cargo install tauri-cli --version "^2" --locked
cargo install create-tauri-app --locked
cargo create-tauri-app --yes --template vanilla desktop
```
`desktop/`가 생성된다(`desktop/src-tauri/...` + 정적 프런트 `desktop/src/` 또는 `desktop/index.html`). **스캐폴드를 루트 워크스페이스에 추가하지 말 것**(R5) — 루트 `Cargo.toml`은 건드리지 않는다.

- [ ] **Step 2: `desktop/.gitignore` 작성(R13)**

Create `desktop/.gitignore`:
```gitignore
# Tauri/Rust 빌드 산출물
src-tauri/target/
# 빌드타임 복사 사이드카(커밋 금지 — 런북이 빌드 시 복사)
src-tauri/binaries/controller*
# JS 툴체인(스캐폴드 잔재)
node_modules/
dist/
```

- [ ] **Step 3: `desktop/src-tauri/binaries/.gitkeep` + Cargo.toml 의존 정리**

Run: `mkdir -p desktop/src-tauri/binaries && touch desktop/src-tauri/binaries/.gitkeep`

`desktop/src-tauri/Cargo.toml`의 `[dependencies]`를 아래로(스캐폴드 tauri는 유지, 나머지 추가). **`tauri-plugin-shell`은 제거**(직접 spawn):
```toml
[dependencies]
tauri = { version = "2", features = [] }
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", default-features = false }
anyhow = "1"

[target.'cfg(unix)'.dependencies]
libc = "0.2"

[target.'cfg(windows)'.dependencies]
win32job = "2"
```
(이미 있는 `[lib] name=... crate-type=[...]`, `[build-dependencies] tauri-build`는 스캐폴드 그대로 둔다.)

> **reqwest 주의**: 헬스체크는 **localhost http만** 쓴다(TLS 불요). `default-features = false`로 충분하지만, 첫 `cargo build`에서 `reqwest::Client::new()`가 기능 부족으로 실패하면 `features = ["http2"]` 정도만 추가(절대 TLS feature는 불필요). 빌드가 빠르게 알려준다.
> **serde_json**: Task 3의 `win.eval` 에러 인코딩용 — 이 단계에서 `serde_json = "1"`도 함께 추가.

- [ ] **Step 4: 실제 controller 로그 라인 1개 캡처(드리프트 가드 fixture용)**

bundle controller를 잠깐 띄워 실제 "REST listening" 라인을 캡처한다(파싱 fixture를 *실측*으로):
```bash
pnpm --dir ui build          # rust-embed가 ui/dist를 컴파일타임에 임베드 → 먼저 빌드
RUST_LOG=info cargo run -p handicap-controller --bin controller --features bundle -- \
  --rest 127.0.0.1:0 --grpc 127.0.0.1:0 --no-open --db /tmp/cap.db 2>&1 | grep -m1 "REST listening"
# 예: "2026-06-19T... INFO handicap_controller: REST listening addr=127.0.0.1:50845"
# Ctrl-C로 종료. 위 라인을 Step 5 테스트의 fixture로 사용(addr= 뒤 포트가 실제값).
```

- [ ] **Step 5: `launch.rs` + 단위 테스트 작성(R6/R8/R11)**

Create `desktop/src-tauri/src/launch.rs`:
```rust
//! Tauri 런타임 비의존 순수 글루(controller `launch.rs` 패턴). 단위 테스트로 잠근다.

use std::path::{Path, PathBuf};

/// controller 기동 파라미터. 기본값은 **localhost-only**(LAN 전방호환 — 미래엔 필드 추가만).
#[derive(Debug, Clone)]
pub struct SpawnConfig {
    /// REST 바인드 주소. 기본 `127.0.0.1:0` → OS가 빈 포트를 *원자적으로* 할당(pick-then-bind TOCTOU 없음).
    pub rest: String,
    /// gRPC 바인드 주소. 기본 `127.0.0.1:0`(워커는 controller가 내부적으로 dial — 셸은 grpc 포트 불요).
    pub grpc: String,
    /// 브라우저 자동 오픈 끔(창이 대신 표시). bundle controller의 `--no-open`.
    pub no_open: bool,
}

impl Default for SpawnConfig {
    fn default() -> Self {
        Self {
            rest: "127.0.0.1:0".to_string(),
            grpc: "127.0.0.1:0".to_string(),
            no_open: true,
        }
    }
}

impl SpawnConfig {
    /// controller CLI 인자. bundle controller는 `--rest`/`--grpc`(SocketAddr)·`--no-open`(bundle 전용)을 받는다.
    pub fn to_args(&self) -> Vec<String> {
        let mut a = vec![
            "--rest".to_string(),
            self.rest.clone(),
            "--grpc".to_string(),
            self.grpc.clone(),
        ];
        if self.no_open {
            a.push("--no-open".to_string());
        }
        a
    }
}

/// 사이드카 controller 경로 결정.
/// 1) env `HANDICAP_CONTROLLER_BIN`(dev/live-verify 오버라이드) 우선,
/// 2) 없으면 현재 exe 옆(번들 설치 형태 — Tauri externalBin이 triple suffix 떼고 옆에 복사).
pub fn resolve_sidecar_path(current_exe_dir: &Path, env_override: Option<&str>) -> PathBuf {
    if let Some(p) = env_override {
        return PathBuf::from(p);
    }
    let name = if cfg!(windows) { "controller.exe" } else { "controller" };
    current_exe_dir.join(name)
}

/// controller `info!` 로그 라인에서 **실제 바인딩된 REST 포트**를 추출.
/// 매칭(단일 소스): `... REST listening ... addr=127.0.0.1:NNNN`(main.rs:293)
///                 `... listeners ... rest=127.0.0.1:NNNN grpc=...`(main.rs:167).
/// 비매칭(가드): `controller starting ... rest: 127.0.0.1:0`(요청 포트 0·Debug `rest:`),
///             `gRPC listening ... addr=127.0.0.1:MMMM`(grpc 포트).
pub fn parse_rest_port(line: &str) -> Option<u16> {
    let key = if line.contains("REST listening") {
        "addr="
    } else if line.contains("listeners") {
        "rest="
    } else {
        return None;
    };
    let after = line.split(key).nth(1)?;
    let port_str: String = after
        .split(':')
        .nth(1)?
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    match port_str.parse::<u16>().ok()? {
        0 => None,
        p => Some(p),
    }
}

pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

pub fn health_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/health")
}

/// 헬스폴 단계: 100회 × 100ms = 최대 ~10s. (별도로 포트 파싱 대기도 최대 ~10s →
/// 기동 실패 시 창에 에러를 띄우기까지 worst-case 합 ~20s — 런북/에러문구에 반영.)
pub const HEALTH_POLL_ATTEMPTS: u32 = 100;
pub const HEALTH_POLL_INTERVAL_MS: u64 = 100;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn default_config_is_localhost_no_open() {
        let args = SpawnConfig::default().to_args();
        assert!(args.iter().any(|a| a == "--no-open"), "no_open 기본 on");
        // localhost only — 네트워크 노출 주소 없음(R6)
        assert!(args.iter().any(|a| a.contains("127.0.0.1")));
        assert!(!args.iter().any(|a| a.contains("0.0.0.0")), "네트워크 노출 금지");
        // rest/grpc 둘 다 :0(원자 할당)
        assert_eq!(args.iter().filter(|a| a.as_str() == "127.0.0.1:0").count(), 2);
    }

    #[test]
    fn env_override_wins_for_sidecar_path() {
        let p = resolve_sidecar_path(Path::new("/app"), Some("/tmp/controller"));
        assert_eq!(p, PathBuf::from("/tmp/controller"));
    }

    #[test]
    fn sidecar_path_defaults_next_to_exe() {
        let p = resolve_sidecar_path(Path::new("/app"), None);
        let name = if cfg!(windows) { "controller.exe" } else { "controller" };
        assert_eq!(p, Path::new("/app").join(name));
    }

    // 드리프트 가드 — Step 4에서 캡처한 *실측* 라인으로 교체할 것.
    #[test]
    fn parses_real_rest_listening_line() {
        let line = "2026-06-19T00:00:00.000000Z  INFO handicap_controller: REST listening addr=127.0.0.1:50845";
        assert_eq!(parse_rest_port(line), Some(50845));
    }

    #[test]
    fn parses_listeners_line_taking_rest_not_grpc() {
        let line = "... INFO handicap_controller: listeners rest=127.0.0.1:50845 grpc=127.0.0.1:50846";
        assert_eq!(parse_rest_port(line), Some(50845));
    }

    #[test]
    fn ignores_grpc_listening_line() {
        let line = "... INFO handicap_controller: gRPC listening addr=127.0.0.1:50846";
        assert_eq!(parse_rest_port(line), None);
    }

    #[test]
    fn ignores_controller_starting_args_with_port_zero() {
        let line = "... INFO handicap_controller: controller starting args=ControllerArgs { rest: 127.0.0.1:0, grpc: 127.0.0.1:0 }";
        assert_eq!(parse_rest_port(line), None);
    }

    #[test]
    fn urls_are_localhost_with_health_path() {
        assert_eq!(base_url(8080), "http://127.0.0.1:8080/");
        assert_eq!(health_url(8080), "http://127.0.0.1:8080/api/health");
    }
}
```

`desktop/src-tauri/src/lib.rs` 맨 위에 `mod launch;` 추가(스캐폴드 `run()`은 일단 유지 — Task 3에서 교체).

- [ ] **Step 6: Step 4 실측 라인으로 fixture 교체**

`parses_real_rest_listening_line` 테스트의 `line`을 Step 4에서 캡처한 **실제** 출력 라인으로 교체(타임스탬프·포트 실제값). 포맷이 위 가정과 다르면 `parse_rest_port`를 실측에 맞춰 조정(예: `addr=` 대신 다른 구분자).

- [ ] **Step 7: 테스트 실행(녹색 확인)**

Run: `cd desktop/src-tauri && cargo test`
Expected: 위 7개 테스트 PASS. (Tauri 시스템 의존은 macOS 기본 충족 — Xcode CLT 필요.)

- [ ] **Step 8: 커밋(단일 foreground)**

```bash
git add desktop/.gitignore desktop/src-tauri desktop/src desktop/index.html desktop/package.json desktop/README.md
git commit -m "feat(desktop): Tauri v2 스캐폴드 + 순수 글루(SpawnConfig/포트파싱/헬스URL)"
```
(스캐폴드가 만든 실제 파일 집합에 맞춰 `git add` 경로 조정. `desktop/src-tauri/binaries/controller*`·`target/`는 `.gitignore`로 제외됨 — `git status`로 확인.)

---

### Task 2: `backend.rs` — `ControllerBackend` 추상 + `SidecarBackend`(생명주기)

**Files:**
- Create: `desktop/src-tauri/src/backend.rs` (+ `lib.rs`에 `mod backend;`)
- Test: `backend.rs` 인라인 `#[cfg(test)] mod tests`(cfg(unix) 트리-종료 테스트)

**Interfaces:**
- Consumes: `launch::{SpawnConfig, resolve_sidecar_path, parse_rest_port, health_url, base_url, HEALTH_POLL_ATTEMPTS, HEALTH_POLL_INTERVAL_MS}`.
- Produces: `trait ControllerBackend: Send + Sync { fn base_url(&self)->String; fn shutdown(&self); }`; `struct SidecarBackend` with `async fn start(sidecar: PathBuf, cfg: SpawnConfig) -> anyhow::Result<SidecarBackend>` and `impl ControllerBackend for SidecarBackend`.

- [ ] **Step 1: 트레잇 + 구조 + spawn/헬스 작성**

Create `desktop/src-tauri/src/backend.rs`:
```rust
//! controller 실행 추상(R7) + 사이드카 구현(R3 Unix killpg / R12 Windows Job Object).
//! 셸(lib.rs)은 이 트레잇의 base_url()/shutdown()에만 의존 → 접근 2(in-process)는 backend 교체.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;

use anyhow::{anyhow, Context};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::launch::{
    self, SpawnConfig, HEALTH_POLL_ATTEMPTS, HEALTH_POLL_INTERVAL_MS,
};

/// controller 실행 백엔드 추상. v1=사이드카, 접근 2=in-process(후속).
pub trait ControllerBackend: Send + Sync {
    /// 창이 navigate할 베이스 URL(`http://127.0.0.1:<port>/`).
    fn base_url(&self) -> String;
    /// 종료 시 호출 — 프로세스 트리 정리.
    fn shutdown(&self);
}

/// OS별 자식 핸들(트리 종료용).
#[cfg(unix)]
struct ChildTree {
    pgid: i32, // process_group(0)로 child가 그룹 리더 → pgid == child pid
}
#[cfg(windows)]
struct ChildTree {
    _job: win32job::Job, // drop/close 시 KILL_ON_JOB_CLOSE로 트리 종료
}

pub struct SidecarBackend {
    port: u16,
    tree: Mutex<Option<ChildTree>>,
}

impl SidecarBackend {
    /// 사이드카 spawn → 로그에서 실제 REST 포트 파싱 → `/api/health`==`ok` 준비 대기 → 반환.
    /// 실패(포트 미검출/헬스 타임아웃)면 Err — 호출자가 창에 에러를 띄운다(navigate 금지).
    pub async fn start(sidecar: PathBuf, cfg: SpawnConfig) -> anyhow::Result<SidecarBackend> {
        let mut cmd = Command::new(&sidecar);
        cmd.args(cfg.to_args())
            .env("RUST_LOG", "info") // 포트 로그 라인 보장(R8)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);

        // Unix: child를 자기 자신이 리더인 새 프로세스 그룹으로 → killpg가 손자 워커까지 도달(R3).
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd.spawn().with_context(|| format!("spawn {:?}", sidecar))?;
        let child_pid = child.id().ok_or_else(|| anyhow!("no child pid"))? as i32;

        // Windows: child를 Job에 배정(워커 spawn 전). 손자는 breakaway 미사용으로 자동 enrolled(R12).
        #[cfg(windows)]
        let tree = {
            // child.raw_handle()는 tokio Child의 inherent 메서드(AsRawHandle 트레잇 import 불요).
            let job = win32job::Job::create().context("create job")?;
            let mut info = job.query_extended_limit_info().context("query job")?;
            info.limit_kill_on_job_close();
            job.set_extended_limit_info(&mut info).context("set job")?;
            job.assign_process(child.raw_handle().ok_or_else(|| anyhow!("no handle"))? as isize)
                .context("assign job")?;
            ChildTree { _job: job }
        };
        #[cfg(unix)]
        let tree = ChildTree { pgid: child_pid };

        // stdout/stderr를 *지속* 드레인(파이프 버퍼 막힘 방지) + 첫 포트를 채널로 전달.
        let (tx, rx) = oneshot::channel::<u16>();
        let tx = std::sync::Arc::new(Mutex::new(Some(tx)));
        for stream in [child.stdout.take(), child.stderr.take()] {
            if let Some(s) = stream {
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut lines = BufReader::new(s).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        if let Some(p) = launch::parse_rest_port(&line) {
                            if let Some(sender) = tx.lock().unwrap().take() {
                                let _ = sender.send(p);
                            }
                        }
                        // 계속 드레인(로그 폐기) — 멈추면 child가 파이프에 블록.
                    }
                });
            }
        }

        // 포트 대기(타임아웃).
        let port = tokio::time::timeout(
            std::time::Duration::from_millis(HEALTH_POLL_INTERVAL_MS * HEALTH_POLL_ATTEMPTS as u64),
            rx,
        )
        .await
        .map_err(|_| anyhow!("controller가 시간 내 REST 포트를 로그하지 않음"))?
        .map_err(|_| anyhow!("포트 채널 닫힘(controller 조기 종료?)"))?;

        // 헬스폴: 200 + 본문 "ok"만 준비로 인정(R8 — SPA fallback 200 false-positive 회피).
        let client = reqwest::Client::new();
        let url = launch::health_url(port);
        let mut ready = false;
        for _ in 0..HEALTH_POLL_ATTEMPTS {
            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    if let Ok(body) = resp.text().await {
                        if body.trim() == "ok" {
                            ready = true;
                            break;
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(HEALTH_POLL_INTERVAL_MS)).await;
        }
        if !ready {
            // 정리 후 실패 — 좀비 방지.
            #[cfg(unix)]
            unsafe { libc::killpg(tree.pgid, libc::SIGKILL); }
            return Err(anyhow!("controller /api/health 준비 실패(포트 {port})"));
        }

        Ok(SidecarBackend { port, tree: Mutex::new(Some(tree)) })
    }
}

impl ControllerBackend for SidecarBackend {
    fn base_url(&self) -> String {
        launch::base_url(self.port)
    }

    fn shutdown(&self) {
        let Some(tree) = self.tree.lock().unwrap().take() else { return };
        #[cfg(unix)]
        unsafe {
            // SIGTERM(워커 graceful) → 유예 → SIGKILL(controller는 시그널 핸들러 없음).
            libc::killpg(tree.pgid, libc::SIGTERM);
            std::thread::sleep(std::time::Duration::from_millis(500));
            libc::killpg(tree.pgid, libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            drop(tree); // Job 핸들 close → KILL_ON_JOB_CLOSE로 트리 종료.
        }
    }
}
```

`lib.rs`에 `mod backend;` 추가.

- [ ] **Step 2: cfg(unix) 트리-종료 단위 테스트**

`backend.rs`의 `#[cfg(test)] mod tests`에:
```rust
#[cfg(all(test, unix))]
mod tests {
    /// process_group(0) + killpg가 *손자*까지 종료함을 가짜 트리로 검증(R3 메커니즘).
    #[tokio::test]
    async fn killpg_terminates_child_and_grandchild() {
        use std::process::Stdio;
        use tokio::process::Command;
        // 자식 sh가 손자 sleep을 낳고, 둘 다 같은 새 그룹.
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("sleep 60 & echo started; wait")
            .stdout(Stdio::piped())
            .process_group(0);
        let mut child = cmd.spawn().unwrap();
        let pgid = child.id().unwrap() as i32;
        // 시작 대기
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        // killpg → 그룹 전체(자식 sh + 손자 sleep) 종료.
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
        let status = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait())
            .await
            .expect("child should die within 3s")
            .unwrap();
        assert!(!status.success() || status.code().is_none());
        // 손자 sleep이 같은 그룹이라 함께 종료됨(고아 0) — pgid로 추가 sleep 없음을 OS가 보장.
    }
}
```

- [ ] **Step 3: 테스트 실행**

Run: `cd desktop/src-tauri && cargo test`
Expected: Task 1 테스트 + `killpg_terminates_child_and_grandchild` PASS. (windows Job Object 경로는 macOS에서 컴파일 제외 — Windows 검증 연기.)

- [ ] **Step 4: 커밋**

```bash
git add desktop/src-tauri/src/backend.rs desktop/src-tauri/src/lib.rs desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock
git commit -m "feat(desktop): ControllerBackend 추상 + SidecarBackend(포트파싱·헬스폴·트리종료)"
```

---

### Task 3: 셸 배선(`lib.rs run()`) + 스플래시 + `tauri.conf.json`

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs` (`run()` 교체)
- Create: `desktop/src/splash.html`(스캐폴드 프런트 dir 안 — `frontendDist` 대상)
- Modify: `desktop/src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: `backend::{ControllerBackend, SidecarBackend}`, `launch::{SpawnConfig, resolve_sidecar_path}`.

- [ ] **Step 1: 스플래시 페이지**

Create `desktop/src/splash.html`(스캐폴드가 `desktop/src/`를 프런트 dir로 쓰면 거기, `desktop/`에 `index.html`만 있으면 `desktop/splash.html`):
```html
<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>핸디캡</title>
<style>body{font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0}
#e{color:#b00;display:none;white-space:pre-wrap;padding:1rem}</style></head>
<body><div><h2>핸디캡 시작 중…</h2><p id="e"></p></div>
<script>window.__setError=function(m){var e=document.getElementById('e');e.style.display='block';e.textContent='시작 실패: '+m;}</script>
</body></html>
```

- [ ] **Step 2: `tauri.conf.json` 편집(단일 창·splash·externalBin·csp null)**

`desktop/src-tauri/tauri.conf.json`을 아래 키로(스캐폴드 값에 맞춰 `productName`/`identifier` 유지·조정):
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Handicap",
  "version": "0.1.0",
  "identifier": "com.handicap.desktop",
  "build": { "frontendDist": "../src" },
  "app": {
    "windows": [
      { "label": "main", "title": "Handicap", "url": "splash.html", "width": 1280, "height": 860 }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis", "msi", "dmg", "app"],
    "externalBin": ["binaries/controller"],
    "icon": ["icons/icon.icns", "icons/icon.ico"]
  }
}
```
(스캐폴드 `frontendDist`가 `../dist`면 정적 단일파일 구조에 맞게 `../src`로. `icon` 경로는 스캐폴드 생성값 유지. `beforeBuildCommand`/`devUrl`은 정적이라 제거 또는 빈 값.)

- [ ] **Step 3: `run()` 교체**

`desktop/src-tauri/src/lib.rs`의 `run()`을 아래로:
```rust
mod backend;
mod launch;

use std::sync::Mutex;

use backend::{ControllerBackend, SidecarBackend};
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
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                let sidecar = launch::resolve_sidecar_path(
                    &exe_dir,
                    std::env::var("HANDICAP_CONTROLLER_BIN").ok().as_deref(),
                );
                match SidecarBackend::start(sidecar, launch::SpawnConfig::default()).await {
                    Ok(be) => {
                        let url = be.base_url();
                        if let Some(win) = handle.get_webview_window("main") {
                            if let Ok(u) = url.parse::<tauri::Url>() {
                                let _ = win.navigate(u);
                            }
                        }
                        handle.state::<BackendState>().0.lock().unwrap()
                            .replace(Box::new(be));
                    }
                    Err(e) => {
                        // 창의 스플래시에 에러 표시(navigate 금지).
                        if let Some(win) = handle.get_webview_window("main") {
                            let js = format!(
                                "window.__setError && window.__setError({})",
                                serde_json::to_string(&e.to_string()).unwrap_or_else(|_| "\"error\"".into())
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
주의: `win.eval`에 쓰는 에러 문자열 JSON 인코딩 위해 `serde_json`을 desktop Cargo.toml `[dependencies]`에 추가(`serde_json = "1"`). `tauri::Url`은 `url::Url` 재export.

- [ ] **Step 4: 컴파일 확인**

Run: `cd desktop/src-tauri && cargo build`
Expected: 성공(경고 허용). 실패 시 스캐폴드 `lib.rs`의 기존 `run()`/`main.rs` 호출 시그니처와 맞춘다(`app_lib::run()`).

- [ ] **Step 5: 커밋**

```bash
git add desktop/src-tauri/src/lib.rs desktop/src/splash.html desktop/src-tauri/tauri.conf.json desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock
git commit -m "feat(desktop): 셸 배선(setup→사이드카→navigate, RunEvent::Exit 정리) + 스플래시"
```

---

### Task 4: 빌드 런북 + 사이드카 복사 + bundle 검증

**Files:**
- Create: `docs/dev/tauri-desktop-build.md`

- [ ] **Step 1: bundle controller 빌드·테스트(R14)**

Run:
```bash
pnpm --dir ui build
cargo test -p handicap-controller --features bundle
```
Expected: green(사이드카 의존이 멀쩡함을 확인 — 기본 게이트는 bundle 미컴파일).

- [ ] **Step 2: 사이드카 복사 + `cargo tauri build`(macOS, R10)**

Run:
```bash
TRIPLE=$(rustc -vV | sed -n 's/host: //p')
cargo build -p handicap-controller --features bundle --release
cp target/release/controller "desktop/src-tauri/binaries/controller-${TRIPLE}"
cd desktop && cargo tauri build
```
Expected: `desktop/src-tauri/target/release/bundle/`에 `.app`/`.dmg` 생성. (Windows nsis/msi는 Windows에서만 — 런북 갭.)

- [ ] **Step 3: 런북 작성**

Create `docs/dev/tauri-desktop-build.md` — 위 단계 + Windows 절차(Rust MSVC·Node·`cargo install tauri-cli --version "^2"`·WebView2 기본 탑재[없으면 Evergreen 설치 확인]·`rustc -vV` triple로 사이드카 명명) + **Windows-검증 갭 체크리스트**: ① 인스톨러 설치→실행→run 1개 완료 ② **앱 종료 시 작업관리자에 controller/worker 잔류 0(Job Object)** ③ 리포트 CSV/XLSX 다운로드가 WebView2에서 저장됨. + `docs/dev/single-exe-build.md`(옵션 A) 상호 참조.

- [ ] **Step 4: 커밋(docs)**

```bash
git add docs/dev/tauri-desktop-build.md
git commit -m "docs(desktop): Tauri 데스크톱 빌드 런북 + Windows-검증 갭 체크리스트"
```

---

### Task 5: macOS 라이브 검증 (R1·R2·R3·R9) — 커밋 없음(게이트)

**Files:** 없음(검증). 결과는 Task 6 build-log에 기록.

- [ ] **Step 1: 50ms responder + 격리 DB 준비** — `/live-verify` 스택의 responder를 띄운다(`python3` ThreadingHTTPServer 200·~50ms). bundle controller를 release로 빌드(Task 4 Step 2 산출물 재사용).

- [ ] **Step 2: 앱 기동(사이드카 오버라이드로)**

Run:
```bash
cd desktop
HANDICAP_CONTROLLER_BIN="$(pwd)/../target/release/controller" cargo tauri dev
```
Expected(R1): 창이 스플래시→핸디캡 UI로 navigate. (env 오버라이드로 dev에서도 release 사이드카 사용 — externalBin dev-copy 불확실성 회피.)

- [ ] **Step 3: run 1개 생성·완료(R2)** — 창 UI에서 responder 대상 시나리오로 run 생성 → `completed` + 리포트 표시. (또는 사이드카 포트로 curl `POST /api/runs`.)

- [ ] **Step 4: 회귀 3종(R9)** — 리포트 CSV/XLSX 다운로드(저장 동작)·HAR 가져오기 파일 선택·스텝 템플릿 등 클립보드 복사가 창(WKWebView)에서 동작.

- [ ] **Step 5: run 진행 중 종료 → 고아 0(R3)**

run을 길게(예: duration 30s) 시작해 **워커가 살아있는 동안** 앱 창을 닫는다. 직후:
```bash
pgrep -fl 'target/release/controller' ; pgrep -fl 'controller worker' ; echo "exit=$?"
```
Expected(R3): controller·worker 프로세스 **0건**(killpg가 손자까지 종료). 잔류가 있으면 R3 미충족 → backend.shutdown 점검.
> 패턴 주의: bundle 워커는 멀티콜 re-exec라 cmdline이 `.../controller worker --controller … --run-id …`다(`/worker` 경로가 없음). 그래서 `pgrep -fl 'controller worker'`로 잡는다(첫 패턴 `target/release/controller`도 워커 라인을 포함하나, 전용 워커 라인을 정확히 확인).

- [ ] **Step 6: 정리** — responder 종료, `/tmp/*.db` 정리, `.playwright-mcp`/루트 png 있으면 제거(라이브검증 잔재).

---

### Task 6: 마무리 docs (ADR-0040 · build-log · roadmap · 루트 상태줄 · 메모리)

**Files:**
- Create: `docs/adr/0040-tauri-desktop-wrapper.md`
- Modify: `docs/build-log.md`, `docs/roadmap.md`, `CLAUDE.md`(상태줄), 메모리

- [ ] **Step 1: ADR-0040** — MADR 포맷. 결정: 데스크톱 셸=Tauri 사이드카(접근 1), 접근 2(in-process)·LAN 전방호환 명시(R6/R7), 대안(in-process 우선·plugin-shell spawn·Electron) 기각 근거. 루트 `CLAUDE.md` "알아둘 결정들"에 한 줄 인덱스 추가.

- [ ] **Step 2: build-log 한 단락** — 파이프라인(spec→reviewer 2라운드→plan→구현 6 task→macOS 라이브)·함정(spec main-checkout 오기→worktree 이동·포트 silent-fallback→`:0`+로그파싱·health `/api/health` 본문·killpg 손자·desktop workspace-밖)·라이브 결과(R1/R2/R3/R9).

- [ ] **Step 3: roadmap 현재상태 + 연기** — "Tauri 데스크톱 셸 완료" 한 줄 + §7 연기(접근2·코드서명·네이티브 다이얼로그·트레이·자동업데이트·LAN·Windows CI) 누적.

- [ ] **Step 4: 루트 CLAUDE.md 상태줄 *교체*(append 금지)** — 최신 = Tauri 데스크톱 셸. ADR-0040 인덱스 한 줄.

- [ ] **Step 5: 메모리** — `windows-desktop-distribution.md` 업데이트(옵션 B 접근1 구현 완료) + `MEMORY.md` 활성작업 갱신.

- [ ] **Step 6: 커밋(마무리 docs — 별도 마지막 커밋)**

```bash
git add docs/adr/0040-tauri-desktop-wrapper.md docs/build-log.md docs/roadmap.md CLAUDE.md
git commit -m "docs(desktop): ADR-0040 + build-log/roadmap/상태줄 — Tauri 데스크톱 셸 완료"
```

---

## 구현 순서 / 게이트 노트

- 순서: Task 1(스캐폴드+순수글루) → 2(backend) → 3(셸배선) → 4(런북+빌드) → 5(macOS 라이브) → 6(마무리 docs).
- 각 task = 독립 green 커밋(Task 5 제외 — 검증). desktop 커밋은 cargo workspace 게이트 밖이라 빠름 — **`cd desktop/src-tauri && cargo test`를 커밋 전 수동 실행**(게이트가 안 잡음).
- tdd-guard/spec-review-guard는 `crates/*/src`·`ui/src`만 가드 → `desktop/`은 비대상(keepalive stub 불요). 단 TDD 순서(테스트 먼저)는 관례로 유지.
- 최종 리뷰: `handicap-reviewer`(크로스커팅·R4 0-diff 와이어 무변경 확인) + path-gate상 요청실행/spawn 경로라 `security-reviewer`(사이드카 spawn 인자·env·localhost-only) 권장.

<!-- REVIEW-GATE: APPROVED -->
