# 단일 self-contained 바이너리 모드 (ADR-0039 옵션 A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인자 없이 실행하면 worker 자동 기동 + 임베드 UI 서빙 + 사용자 데이터 폴더 DB + 브라우저 자동 오픈 + 포트 자동 회피하는 단일 self-contained 바이너리 모드를, cargo 기능 `bundle`(기본 off, off=현행 byte-identical)로 추가한다.

**Architecture:** worker 실행 로직을 lib(`handicap_worker::run`)으로 추출 → 컨트롤러가 숨은 `worker` 서브커맨드로 자기 자신(`current_exe`)을 재실행(멀티콜). bundle 기능을 켜면 UI 임베드(rust-embed)·사용자 데이터 폴더(dirs)·브라우저 오픈(open)·포트 폴백·worker self-spawn이 활성. proto/DB/migration/리포트 무변경.

**Tech Stack:** Rust (clap 멀티콜, rust-embed 8, dirs 5, open 5, tokio-stream `serve_with_incoming`), 기존 axum/tonic/sqlx 그대로.

**근거 spec:** `docs/superpowers/specs/2026-06-16-windows-single-exe-design.md` (spec-plan-reviewer clean APPROVE).

---

## 빌드 게이트 주의 (모든 bundle 태스크 공통)

- **pre-commit 훅은 `cargo build/clippy/test --workspace`(= 비-bundle)만 돈다.** `#[cfg(feature="bundle")]`
  코드는 훅이 컴파일하지 않으므로, bundle 코드를 만진 태스크는 커밋 전 **수동으로**:
  ```
  cargo build -p handicap-controller --features bundle
  cargo clippy -p handicap-controller --features bundle --all-targets -- -D warnings
  cargo test  -p handicap-controller --features bundle
  ```
  를 추가로 돌려 green을 확인한다(비-bundle workspace 게이트도 물론 통과해야 함).
- **bundle 빌드/테스트는 `ui/dist`가 있어야 컴파일된다**(rust-embed 입력). bundle 코드를 처음 만지는
  태스크(Task 5+) 전에 워크트리에서 한 번:
  ```
  cd ui && pnpm install && pnpm build && cd ..
  ```
- 커밋은 파이프 없이(`git commit` 단독) 돌리고 직후 `git log -1`로 landed 확인(루트 CLAUDE.md).

---

## File Structure

| 파일 | 책임 | 태스크 |
|---|---|---|
| `crates/worker/src/lib.rs` (신규) | `WorkerArgs`·`run()`·`init_worker_tracing()`·헬퍼·인라인 테스트 (worker 실행 로직 단일 소스) | 1 |
| `crates/worker/src/main.rs` (수정) | 얇은 래퍼(clap 파싱 → `run`) | 1 |
| `crates/controller/Cargo.toml` (수정) | `bundle` 기능 + optional dep(handicap-worker/rust-embed/dirs/open) | 2 |
| `crates/controller/src/main.rs` (수정) | clap 멀티콜 재구성 + tracing 이동 + (bundle) db 경로·포트 폴백·dispatcher self-spawn·브라우저 | 2,3,4,6 |
| `crates/controller/src/launch.rs` (신규) | `resolve_db_path`·`bind_with_fallback` (항상 컴파일, 단위 테스트) | 3,4 |
| `crates/controller/src/bundle.rs` (신규, `#[cfg(feature="bundle")]`) | `EmbeddedUi`·`resolve_embedded`/`serve_embedded_ui`·`open_browser`·`data_dir` | 5,6 |
| `crates/controller/src/app.rs` (수정) | bundle일 때 ui_dir None → 임베드 fallback | 5 |
| `crates/controller/src/dispatcher/subprocess.rs` (수정) | `leading_args` 필드 + `with_leading_args` + dispatch prepend | 6 |
| `crates/controller/src/lib.rs` (수정) | `pub mod launch;` + `#[cfg(feature="bundle")] pub mod bundle;` | 3,5 |
| `docs/dev/single-exe-build.md` (신규) | 초보자용 빌드 런북 | 7 |

---

## Task 1: worker 실행 로직 lib 추출

**Files:**
- Create: `crates/worker/src/lib.rs`
- Modify: `crates/worker/src/main.rs` (전체 교체)
- (임시) Create→삭제: `crates/worker/tests/_tdd_keepalive.rs`

순수 리팩터: 동작/와이어 한 줄도 안 바꾸고 코드를 옮긴다. 기존 인라인 테스트가 회귀 가드.

- [ ] **Step 1: tdd-guard keepalive 선설치 (C-1 대비)**

새 `lib.rs` Write가 막히지 않도록 pending test-path 파일을 먼저 만든다:

```rust
// crates/worker/tests/_tdd_keepalive.rs
#[test]
fn _keepalive() {}
```

- [ ] **Step 2: `crates/worker/src/lib.rs` 작성**

현 `main.rs`에서 아래를 **그대로 이동**한다(로직 불변):
- 최상단 `use` 줄 전부 (현 main.rs 1–23) — 단 `use clap::Parser;`는 **`use clap::Args as ClapArgs;`** 로 바꾼다(아래 derive에서 사용).
- 헬퍼 함수 6개 verbatim: `map_policy`(현 449–464), `proto_is_open_loop`(466–470), `proto_is_vu_curve`(472–475), `run_duration_secs`(477–490), `resolve_worker_id`(492–508), `phase_for_result`(510–521).
- `#[cfg(test)] mod tests { ... }` 블록 verbatim (현 523–639).

그리고 아래를 **새로** 추가한다:

```rust
/// Worker CLI 인자 — lib이 단일 소스. worker 바이너리(`main.rs`)는 `#[command(flatten)]`로,
/// 컨트롤러 멀티콜(`controller worker …`)은 `Cmd::Worker(WorkerArgs)`로 같은 구조체를 재사용한다.
#[derive(Debug, ClapArgs)]
pub struct WorkerArgs {
    #[arg(long)]
    pub controller: String,
    #[arg(long)]
    pub run_id: String,
    /// Explicit worker id. If omitted (K8s Indexed Job), derived from
    /// JOB_COMPLETION_INDEX as "{run_id}-w{index}". (A3a spec §7.2.)
    #[arg(long)]
    pub worker_id: Option<String>,
    #[arg(long, default_value = "1000")]
    pub capacity_vus: u32,
}

/// Install the worker's tracing subscriber (fmt + EnvFilter, default "info").
/// Called once by the worker bin OR the controller's `worker` subcommand arm —
/// NOT by `run()` (avoids a double global-subscriber set panic when the same
/// process also booted the controller; in practice the worker subcommand is a
/// fresh process, but keeping init out of `run()` makes that structural).
pub fn init_worker_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
}

/// Run the worker against the controller until the run terminates. This is the
/// former `main` body (parsing + tracing init removed — the caller does those).
pub async fn run(args: WorkerArgs) -> anyhow::Result<()> {
    // ── 여기에 현 main.rs 46–447 본문을 그대로 붙인다 ──
}
```

`run()` 본문 = 현 main.rs **47–447줄 verbatim**(`let worker_id = resolve_worker_id(...)`부터 끝까지 — 이미 `args.controller`/`args.run_id`/`args.worker_id`/`args.capacity_vus`를 참조하므로 시그니처 `args: WorkerArgs`와 그대로 맞는다). **현 46줄 `let args = Args::parse();`는 옮기지 않는다**(호출자가 파싱; 이 줄을 `run()`에 넣으면 없어진 `Args` 타입 참조 + `args` 이중 바인딩으로 컴파일 실패). 41–45줄의 tracing init도 `run()`에 넣지 않는다(→ `init_worker_tracing()`).

- [ ] **Step 3: `crates/worker/src/main.rs` 전체 교체 (얇은 래퍼)**

```rust
use clap::Parser;
use handicap_worker::WorkerArgs;

/// `worker` 바이너리 진입점. 인자는 lib의 `WorkerArgs`를 그대로 쓴다(K8s/subprocess
/// dispatcher가 `--controller/--run-id/--worker-id`로 호출 — A3a/A3c).
#[derive(Debug, Parser)]
struct Cli {
    #[command(flatten)]
    args: WorkerArgs,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    handicap_worker::init_worker_tracing();
    let cli = Cli::parse();
    handicap_worker::run(cli.args).await
}
```

- [ ] **Step 4: 빌드·테스트로 회귀 확인**

Run:
```
cargo build -p handicap-worker
cargo test -p handicap-worker
```
Expected: 빌드 OK, 기존 단위 테스트(`phase_for_*`, `resolve_worker_id_*`, `run_duration_*`, `stages_wiring` 등 9개) 전부 PASS. (Cargo가 `src/lib.rs`를 자동 인식해 lib `handicap_worker` 생성 — `[lib]` 명시 불필요.)

- [ ] **Step 5: keepalive 삭제 후 커밋**

```
rm crates/worker/tests/_tdd_keepalive.rs
git add crates/worker/src/lib.rs crates/worker/src/main.rs
git commit -m "refactor(worker): extract run loop into handicap_worker lib (multi-call prep)"
git log -1
```
(절대 `git add -A` 금지 — keepalive가 스테이지될 수 있음.)

---

## Task 2: 컨트롤러 `bundle` 기능 + 멀티콜 `worker` 서브커맨드

**Files:**
- Modify: `crates/controller/Cargo.toml`
- Modify: `crates/controller/src/main.rs`

이 태스크 후 bundle 빌드는 "controller이자 worker가 될 수 있는" 바이너리가 된다(아직 UI 임베드·자동 경로·포트 폴백·브라우저·self-spawn은 없음 — 후속 태스크).

- [ ] **Step 1: `crates/controller/Cargo.toml`에 optional dep + bundle 기능 추가**

`[dependencies]` 끝(현 `ulid.workspace = true` 다음 줄)에 추가:

```toml
# bundle(단일 self-contained 바이너리) 전용 — optional, 기본 빌드엔 불포함.
handicap-worker = { path = "../worker", optional = true }
rust-embed = { version = "8", optional = true }
dirs = { version = "5", optional = true }
open = { version = "5", optional = true }
```

`[features]` 블록을 다음으로 교체:

```toml
[features]
slice6-k8s = []
# 단일 self-contained 바이너리 모드(ADR-0039 옵션 A). off=현행 byte-identical.
bundle = ["dep:handicap-worker", "dep:rust-embed", "rust-embed/mime-guess", "dep:dirs", "dep:open"]
```

- [ ] **Step 2: `crates/controller/src/main.rs` clap 재구성 + tracing 이동**

상단 `use clap::{Parser, ValueEnum};`는 유지. 현 `#[derive(Debug, Parser)] struct Args { … }`(23–70)를
**`#[derive(Debug, clap::Args)] struct ControllerArgs { … }`** 로 바꾼다(이름·derive만 변경, 필드 전부 유지).

그 바로 위에 멀티콜 래퍼를 추가:

```rust
#[derive(Debug, Parser)]
struct Cli {
    /// bundle 빌드에서만: `worker` 서브커맨드로 자기 자신을 워커로 재실행(멀티콜). 없으면 컨트롤러.
    #[cfg(feature = "bundle")]
    #[command(subcommand)]
    cmd: Option<Cmd>,
    #[command(flatten)]
    controller: ControllerArgs,
}

#[cfg(feature = "bundle")]
#[derive(Debug, clap::Subcommand)]
enum Cmd {
    /// 컨트롤러가 내부적으로 spawn하는 워커 모드(직접 호출 불필요).
    Worker(handicap_worker::WorkerArgs),
}
```

`main` 시작부를 다음으로 바꾼다 — **기존 top-of-main `tracing_subscriber…init()`(현 74–78)을 제거**하고
파싱·분기 이후 컨트롤러 arm에서 1회 init(이동):

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    // 멀티콜: `controller worker …` → 워커로 동작(자기 자신 재실행 대상). bundle 전용.
    #[cfg(feature = "bundle")]
    if let Some(Cmd::Worker(wargs)) = cli.cmd {
        handicap_worker::init_worker_tracing();
        return handicap_worker::run(wargs).await;
    }

    let args = cli.controller;

    // 컨트롤러 경로: tracing init(과거 top-of-main에 있던 것과 동일 — byte-identical).
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    info!(?args, "controller starting");
    // ── 이하 현 main.rs 82줄부터(`if let Some(d) = &args.ui_dir {`)의 본문 그대로 ──
}
```

(현 79–80의 `let args = Args::parse(); info!(?args, …)`는 위로 대체됨. 본문은 `args.xxx`를 그대로
참조하므로 `let args = cli.controller;`로 이름만 이어진다.)

- [ ] **Step 3: arg 파싱 회귀 단위 테스트 추가**

`main.rs` 맨 아래에 추가:

```rust
#[cfg(test)]
mod cli_tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn flat_controller_invocation_still_parses() {
        // 서브커맨드 없는 기존 호출이 깨지지 않아야 한다.
        let cli = Cli::try_parse_from([
            "controller", "--db", "x.db", "--rest", "127.0.0.1:8080", "--ui-dir", "ui/dist",
        ])
        .expect("flat controller args must parse");
        assert_eq!(cli.controller.db, "x.db");
    }

    #[cfg(feature = "bundle")]
    #[test]
    fn worker_subcommand_parses() {
        let cli = Cli::try_parse_from([
            "controller", "worker", "--controller", "http://127.0.0.1:8081",
            "--run-id", "r1", "--worker-id", "w1",
        ])
        .expect("worker subcommand must parse");
        match cli.cmd {
            Some(Cmd::Worker(w)) => {
                assert_eq!(w.run_id, "r1");
                assert_eq!(w.worker_id.as_deref(), Some("w1"));
            }
            _ => panic!("expected Worker subcommand"),
        }
    }
}
```

(이 단계 전제: Task 3에서 `db`가 `Option<String>`이 되면 `assert_eq!(cli.controller.db, "x.db")`를
`assert_eq!(cli.controller.db.as_deref(), Some("x.db"))`로 갱신. Task 2 시점엔 `db: String`이므로 위 그대로.)

- [ ] **Step 4: 양쪽 빌드/게이트 확인**

Run:
```
cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run -p handicap-controller
cargo build -p handicap-controller --features bundle && cargo clippy -p handicap-controller --features bundle --all-targets -- -D warnings && cargo test -p handicap-controller --features bundle cli_tests
```
Expected: 둘 다 green. (비-bundle엔 `cmd` 필드·`Cmd`·worker dep이 컴파일 제외 → 현행 CLI 동일.)

- [ ] **Step 5: 커밋**

```
git add crates/controller/Cargo.toml crates/controller/src/main.rs Cargo.lock
git commit -m "feat(controller): bundle feature + multi-call worker subcommand (off=byte-identical)"
git log -1
```

---

## Task 3: DB 경로 해석 (`resolve_db_path` + 사용자 데이터 폴더)

**Files:**
- Create: `crates/controller/src/launch.rs`
- Modify: `crates/controller/src/lib.rs` (`pub mod launch;`)
- Modify: `crates/controller/src/main.rs`

- [ ] **Step 1: `crates/controller/src/launch.rs` 작성 (resolve_db_path + 테스트)**

```rust
//! main.rs 와이어링용 격리 헬퍼(런타임 경로/포트 결정). main-only 와이어링은 통합/e2e가
//! 안 거치므로(controller CLAUDE.md) 여기 순수 함수를 단위 테스트로 잠근다.

use std::path::{Path, PathBuf};

/// DB 파일 경로를 결정한다.
/// - `explicit`(명시 `--db`)이 있으면 그대로.
/// - 없고 `data_dir`(bundle: 사용자 데이터 폴더)가 있으면 `<data_dir>/handicap.db`.
/// - 둘 다 없으면 현행 기본 `./handicap.db`.
pub fn resolve_db_path(explicit: Option<&str>, data_dir: Option<&Path>) -> String {
    if let Some(p) = explicit {
        return p.to_string();
    }
    match data_dir {
        Some(dir) => dir.join("handicap.db").display().to_string(),
        None => "./handicap.db".to_string(),
    }
}

/// `<data_local_dir>/handicap` 형태의 앱 데이터 폴더 경로(존재 보장 X — 호출자가 create_dir_all).
pub fn app_data_dir(base: &Path) -> PathBuf {
    base.join("handicap")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn explicit_db_wins() {
        assert_eq!(
            resolve_db_path(Some("/tmp/x.db"), Some(Path::new("/data"))),
            "/tmp/x.db"
        );
    }

    #[test]
    fn data_dir_used_when_no_explicit() {
        assert_eq!(
            resolve_db_path(None, Some(Path::new("/data/handicap"))),
            "/data/handicap/handicap.db"
        );
    }

    #[test]
    fn falls_back_to_cwd_when_nothing() {
        assert_eq!(resolve_db_path(None, None), "./handicap.db");
    }

    #[test]
    fn app_data_dir_appends_handicap() {
        assert_eq!(app_data_dir(Path::new("/data")), Path::new("/data/handicap"));
    }
}
```

- [ ] **Step 2: `lib.rs`에 모듈 등록**

`crates/controller/src/lib.rs`의 `pub mod app;` 다음 줄에 추가:
```rust
pub mod launch;
```

- [ ] **Step 3: `main.rs`의 `--db`를 `Option<String>`으로 + 경로 해석 배선**

`ControllerArgs`의 db 필드를 교체:
```rust
    /// SQLite DB 경로. 생략 시: bundle은 사용자 데이터 폴더(<data>/handicap/handicap.db),
    /// 비-bundle은 ./handicap.db.
    #[arg(long)]
    db: Option<String>,
```

`main`에서 현 `let db_url = store::url_from_path(&args.db);`(현 91) 직전에 경로 해석을 넣는다:

```rust
    // bundle: 사용자 데이터 폴더(%LOCALAPPDATA%\handicap / ~/Library/Application Support/handicap)
    // 를 만들고 거기에 DB를 둔다. 비-bundle: data_dir=None → ./handicap.db(현행).
    #[cfg(feature = "bundle")]
    let data_dir: Option<std::path::PathBuf> = dirs::data_local_dir()
        .map(|base| handicap_controller::launch::app_data_dir(&base));
    #[cfg(not(feature = "bundle"))]
    let data_dir: Option<std::path::PathBuf> = None;

    if let Some(dir) = &data_dir {
        std::fs::create_dir_all(dir).context("create app data dir")?;
    }
    let db_path =
        handicap_controller::launch::resolve_db_path(args.db.as_deref(), data_dir.as_deref());
    info!(db = %db_path, "resolved database path");
    let db_url = store::url_from_path(&db_path);
```

(이후 `store::connect(&db_url)`는 그대로.)

- [ ] **Step 4: Task 2의 파싱 테스트 db 단언 갱신**

`main.rs`의 `cli_tests::flat_controller_invocation_still_parses`에서:
```rust
    assert_eq!(cli.controller.db.as_deref(), Some("x.db"));
```

- [ ] **Step 5: 빌드/게이트 + 커밋**

Run (양쪽):
```
cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run -p handicap-controller
cargo build -p handicap-controller --features bundle && cargo clippy -p handicap-controller --features bundle --all-targets -- -D warnings && cargo test -p handicap-controller --features bundle launch
```
Expected: green, `launch::tests` 4개 PASS.
```
git add crates/controller/src/launch.rs crates/controller/src/lib.rs crates/controller/src/main.rs
git commit -m "feat(controller,bundle): resolve DB into user data dir; --db now optional"
git log -1
```

---

## Task 4: 포트 자동 회피 (`bind_with_fallback` + bundle 바인딩 재배선)

**Files:**
- Modify: `crates/controller/src/launch.rs` (`bind_with_fallback` + 테스트)
- Modify: `crates/controller/src/main.rs` (serve 경로 cfg 분기)

- [ ] **Step 1: `launch.rs`에 `bind_with_fallback` + 테스트 추가**

상단 `use` 다음에 추가:
```rust
use std::net::{SocketAddr, TcpListener};
```

함수 추가(`app_data_dir` 다음):
```rust
/// `preferred`에 바인딩을 시도하고, 이미 사용 중(`AddrInUse`)이며 `allow_fallback`이면
/// 같은 IP의 포트 0(OS-할당 빈 포트)로 재바인딩한다. 그 외 에러는 전파.
/// (bundle 모드에서만 fallback=true — 비-bundle은 현행처럼 사용 중이면 에러.)
pub fn bind_with_fallback(
    preferred: SocketAddr,
    allow_fallback: bool,
) -> std::io::Result<TcpListener> {
    match TcpListener::bind(preferred) {
        Ok(l) => Ok(l),
        Err(e) if allow_fallback && e.kind() == std::io::ErrorKind::AddrInUse => {
            let fallback = SocketAddr::new(preferred.ip(), 0);
            TcpListener::bind(fallback)
        }
        Err(e) => Err(e),
    }
}
```

테스트 모듈에 추가:
```rust
    #[test]
    fn fallback_picks_free_port_when_busy() {
        let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
        let busy_addr = occupied.local_addr().unwrap();
        // 같은 주소를 fallback=true로 다시 바인딩 → 다른 포트로 성공.
        let l = bind_with_fallback(busy_addr, true).expect("should fall back");
        assert_ne!(l.local_addr().unwrap().port(), busy_addr.port());
    }

    #[test]
    fn no_fallback_errors_when_busy() {
        let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
        let busy_addr = occupied.local_addr().unwrap();
        let err = bind_with_fallback(busy_addr, false);
        assert!(err.is_err(), "without fallback, busy port must error");
    }
```

(테스트 상단 `use super::*;`는 이미 있으니 `TcpListener`도 그 경로로 보인다.)

- [ ] **Step 2: `main.rs` serve 경로를 cfg로 분기**

현 REST/gRPC 바인딩·serve·dispatcher 순서를 bundle/비-bundle로 가른다. 핵심:
- **bundle**: REST·gRPC 둘 다 `bind_with_fallback`로 우리가 바인딩 → 실제 주소 읽기 → **dispatcher를
  실제 gRPC 주소로 생성** → REST는 `axum::serve(listener,…)`, gRPC는
  `serve_with_incoming(TcpListenerStream::new(grpc_listener))`.
- **비-bundle**: 현행 그대로(REST `axum::serve(TcpListener::bind(args.rest))`, gRPC `.serve(args.grpc)`,
  폴백 없음, serve 메커니즘까지 불변).

현 main.rs의 dispatcher 생성 블록(104–127)과 그 이후를 다음 구조로 재배치한다. **dispatcher 생성을
바인딩 이후로 옮긴다**(bundle이 실제 gRPC 주소를 알아야 하므로). 비-bundle은 `args.grpc` 그대로.

**설계: REST/gRPC serve 경로를 bundle/비-bundle로 *완전히* cfg-split한다.** 이렇게 하면 ① 새 리스너·
스트림 코드가 전부 bundle arm에만 있어 비-bundle에 unused-import가 안 생기고(리뷰어 BLOCKING #1 해소),
② 비-bundle은 현행 serve 메커니즘까지 100% 그대로(spec §5.8 불변), ③ 비-bundle은 gRPC를 미리 바인딩
하지 않으니 bind→drop TOCTOU도 없다(리뷰어 #3·#4 해소). `use tokio_stream::wrappers::TcpListenerStream;`
**top-level import는 추가하지 않는다** — bundle arm에서 full-path로 쓴다. 기존 `use tokio::net::TcpListener;`
(main.rs:13)는 **양쪽 arm이 `TcpListener::bind`/`TcpListener::from_std`로 계속 사용하므로 제거하지 않는다**.

**(a) 리스너/주소 확정** — dispatcher 생성 블록(현 104)의 *직전*에 삽입(bundle은 미리 바인딩해 실제 주소
확보, 비-bundle은 args 주소만):
```rust
    // bundle: 포트가 사용 중이면 빈 포트로 폴백해 미리 바인딩 → 실제 주소 확보(브라우저/worker가 dial).
    //         이 리스너를 serve로 넘긴다(아래). 비-bundle: 현행처럼 serve 시점에 바인딩, 주소만 args에서.
    #[cfg(feature = "bundle")]
    let (rest_listener, rest_addr, grpc_listener, grpc_addr) = {
        let rl = handicap_controller::launch::bind_with_fallback(args.rest, true)
            .context("bind REST")?;
        let ra = rl.local_addr().context("REST local_addr")?;
        let gl = handicap_controller::launch::bind_with_fallback(args.grpc, true)
            .context("bind gRPC")?;
        let ga = gl.local_addr().context("gRPC local_addr")?;
        (rl, ra, gl, ga)
    };
    #[cfg(not(feature = "bundle"))]
    let (rest_addr, grpc_addr) = (args.rest, args.grpc);
    info!(rest = %rest_addr, grpc = %grpc_addr, "listeners");
```

**(b) dispatcher가 실제 gRPC 주소를 쓰게** — SubprocessDispatcher 생성의 `args.grpc`를 `grpc_addr`로
(비-bundle은 `grpc_addr == args.grpc`라 무변경):
```rust
        WorkerMode::Subprocess => Arc::new(SubprocessDispatcher::new(
            args.worker_bin.clone(),
            grpc_addr,                 // ← 실제 바인딩 주소 (was args.grpc)
            db.clone(),
        )),
```

**(c) serve 블록(현 156–175 전부)을 cfg-split로 교체**:
```rust
    let grpc_svc = CoordinatorServer::new(CoordinatorService { state: coord_state });

    // REST — bundle: 미리 바인딩한 std 리스너를 tokio로 변환. 비-bundle: 현행 그대로 bind.
    #[cfg(feature = "bundle")]
    let rest_fut = async {
        rest_listener.set_nonblocking(true).context("rest set_nonblocking")?;
        let l = TcpListener::from_std(rest_listener).context("rest into tokio listener")?;
        axum::serve(l, app_router).await.context("serve REST")
    };
    #[cfg(not(feature = "bundle"))]
    let rest_fut = async {
        let l = TcpListener::bind(args.rest).await.context("bind REST")?;
        axum::serve(l, app_router).await.context("serve REST")
    };

    // gRPC — bundle: 미리 바인딩한 리스너로 serve_with_incoming. 비-bundle: 현행 `.serve(args.grpc)`.
    #[cfg(feature = "bundle")]
    let grpc_fut = async {
        info!(addr = %grpc_addr, "gRPC listening");
        grpc_listener.set_nonblocking(true).context("grpc set_nonblocking")?;
        let incoming = tokio_stream::wrappers::TcpListenerStream::new(
            TcpListener::from_std(grpc_listener).context("grpc into tokio listener")?,
        );
        tonic::transport::Server::builder()
            .add_service(grpc_svc)
            .serve_with_incoming(incoming)
            .await
            .context("serve gRPC")
    };
    #[cfg(not(feature = "bundle"))]
    let grpc_fut = async {
        info!(addr = %grpc_addr, "gRPC listening");
        tonic::transport::Server::builder()
            .add_service(grpc_svc)
            .serve(args.grpc)
            .await
            .context("serve gRPC")
    };

    info!(addr = %rest_addr, "REST listening");
    tokio::try_join!(rest_fut, grpc_fut)?;
    Ok(())
```

> 핵심: `TcpListener`(= `use tokio::net::TcpListener;`, main.rs:13)는 비-bundle arm의 `::bind` + bundle
> arm의 `::from_std`로 **양쪽에서 사용**되니 그대로 둔다. `TcpListenerStream`은 bundle arm full-path라
> 비-bundle에 unused가 안 생긴다. `bind_with_fallback`은 lib의 `pub fn`이라 비-bundle에서 호출이 없어도
> dead_code 경고 없음(공개 API). 비-bundle은 gRPC를 미리 바인딩하지 않으므로 bind→drop도 없다.

- [ ] **Step 3: 양쪽 빌드/게이트**

Run:
```
cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run -p handicap-controller
cargo build -p handicap-controller --features bundle && cargo clippy -p handicap-controller --features bundle --all-targets -- -D warnings && cargo test -p handicap-controller --features bundle launch
```
Expected: green, `bind_with_fallback` 테스트 2개 PASS. (`tokio-stream`은 이미 controller dep + `net`이
tonic 통해 켜져 있어 Cargo 변경 불필요 — 만약 `TcpListenerStream` 미해결이면 controller Cargo의
`tokio-stream` 줄에 `features=["net"]` 가산.)

- [ ] **Step 4: 커밋**

```
git add crates/controller/src/launch.rs crates/controller/src/main.rs
git commit -m "feat(controller,bundle): auto-avoid busy REST/gRPC ports (fallback to free port)"
git log -1
```

---

## Task 5: UI 임베드 서빙 (rust-embed + app.rs fallback)

**Files:**
- Create: `crates/controller/src/bundle.rs` (`#[cfg(feature="bundle")]`)
- Modify: `crates/controller/src/lib.rs`
- Modify: `crates/controller/src/app.rs`

**전제**: `ui/dist` 존재(`cd ui && pnpm install && pnpm build`). 없으면 rust-embed 컴파일 실패.

- [ ] **Step 1: `crates/controller/src/bundle.rs` 작성**

```rust
//! 단일 self-contained 바이너리(`--features bundle`) 전용 — 임베드 UI 서빙·브라우저 오픈 등.

use axum::body::Body;
use axum::http::{StatusCode, Uri, header};
use axum::response::Response;

/// 컴파일 타임에 ui/dist를 바이너리에 임베드. content-type은 rust-embed의 `mime-guess` 기능으로.
#[derive(rust_embed::RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../ui/dist"]
struct EmbeddedUi;

/// 요청 경로에 맞는 임베드 에셋(bytes, content-type)을 찾는다. 못 찾으면 SPA fallback으로
/// index.html(text/html)을 돌려준다(클라이언트 라우트 hard-refresh 대비; ServeDir.fallback과 동일 계약).
fn resolve_embedded(path: &str) -> Option<(Vec<u8>, String)> {
    let trimmed = path.trim_start_matches('/');
    let key = if trimmed.is_empty() { "index.html" } else { trimmed };
    if let Some(f) = EmbeddedUi::get(key) {
        return Some((f.data.into_owned(), f.metadata.mimetype().to_string()));
    }
    // SPA fallback: 알 수 없는 경로 → index.html을 200으로.
    EmbeddedUi::get("index.html")
        .map(|f| (f.data.into_owned(), "text/html".to_string()))
}

/// axum fallback 핸들러: 임베드 UI를 서빙(없으면 SPA index.html, 그조차 없으면 404).
pub async fn serve_embedded_ui(uri: Uri) -> Response {
    match resolve_embedded(uri.path()) {
        Some((bytes, mime)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .body(Body::from(bytes))
            .unwrap(),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("ui asset not found"))
            .unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_is_embedded() {
        assert!(EmbeddedUi::get("index.html").is_some(), "ui/dist/index.html must be embedded");
    }

    #[test]
    fn root_resolves_to_index() {
        let (bytes, mime) = resolve_embedded("/").expect("root should resolve");
        assert!(!bytes.is_empty());
        assert!(mime.contains("html"));
    }

    #[test]
    fn unknown_route_falls_back_to_index() {
        // 클라이언트 라우트(파일 아님) → index.html 200.
        let (bytes, _) = resolve_embedded("/scenarios/01ABC").expect("spa fallback");
        let (index, _) = resolve_embedded("/index.html").expect("index");
        assert_eq!(bytes, index, "unknown route must serve index.html bytes");
    }
}
```

- [ ] **Step 2: `lib.rs`에 모듈 등록**

`crates/controller/src/lib.rs`의 `pub mod app;` 다음(또는 `pub mod launch;` 근처)에 추가:
```rust
#[cfg(feature = "bundle")]
pub mod bundle;
```

- [ ] **Step 3: `app.rs`에서 bundle일 때 임베드 fallback 장착**

`app.rs`의 `if let Some(dir) = &state.ui_dir { … }` 블록(130–148) 다음에 추가:
```rust
    // bundle 빌드 + --ui-dir 미지정 → 임베드 UI를 fallback으로 서빙(SPA fallback 포함).
    #[cfg(feature = "bundle")]
    if state.ui_dir.is_none() {
        app = app.fallback(crate::bundle::serve_embedded_ui);
    }
```

(`--ui-dir`를 주면 위 Some 분기의 `ServeDir`가 우선 — 개발 override는 bundle 빌드에서도 유효.)

- [ ] **Step 4: bundle 빌드/게이트 (ui/dist 필요)**

Run:
```
cd ui && pnpm install && pnpm build && cd ..
cargo build -p handicap-controller --features bundle
cargo clippy -p handicap-controller --features bundle --all-targets -- -D warnings
cargo test -p handicap-controller --features bundle bundle::
```
Expected: green, `bundle::tests` 3개 PASS. (비-bundle workspace 게이트도 변화 없으니 통과 — `bundle.rs`는
cfg-out, `app.rs` 추가 블록도 cfg-out.)
```
cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings
```

- [ ] **Step 5: 커밋**

```
git add crates/controller/src/bundle.rs crates/controller/src/lib.rs crates/controller/src/app.rs
git commit -m "feat(controller,bundle): embed ui/dist and serve it with SPA fallback"
git log -1
```

---

## Task 6: 브라우저 자동 오픈 + worker self-spawn 배선

**Files:**
- Modify: `crates/controller/src/dispatcher/subprocess.rs`
- Modify: `crates/controller/src/bundle.rs`
- Modify: `crates/controller/src/main.rs`

- [ ] **Step 1: `subprocess.rs`에 `leading_args` + 빌더 + 테스트용 순수 헬퍼**

구조체에 필드 추가(현 15–19):
```rust
pub struct SubprocessDispatcher {
    worker_bin: String,
    grpc_addr: SocketAddr,
    db: Db,
    /// `worker_bin` 뒤·`--controller` 앞에 끼울 선행 인자(멀티콜 서브커맨드용). 기본 빈 벡터.
    leading_args: Vec<String>,
}
```

`new`는 3-인자 유지 + 필드 기본값, 빌더 추가:
```rust
impl SubprocessDispatcher {
    pub fn new(worker_bin: String, grpc_addr: SocketAddr, db: Db) -> Self {
        Self { worker_bin, grpc_addr, db, leading_args: Vec::new() }
    }

    /// 멀티콜 self-spawn용: spawn 명령에 선행 인자(예 `["worker"]`)를 끼운다.
    pub fn with_leading_args(mut self, args: Vec<String>) -> Self {
        self.leading_args = args;
        self
    }
}
```

spawn 인자 조립을 테스트 가능한 순수 함수로 분리. 파일 하단(impl 밖)에 추가:
```rust
/// worker spawn 인자열을 만든다: [leading…] ++ --controller URL --run-id ID --worker-id WID.
fn worker_command_args(
    leading: &[String],
    controller_url: &str,
    run_id: &str,
    worker_id: &str,
) -> Vec<String> {
    let mut v: Vec<String> = leading.to_vec();
    v.push("--controller".into());
    v.push(controller_url.into());
    v.push("--run-id".into());
    v.push(run_id.into());
    v.push("--worker-id".into());
    v.push(worker_id.into());
    v
}
```

`dispatch`의 명령 조립부(현 44–53)를 헬퍼 사용으로 교체:
```rust
            let cmd_args = worker_command_args(
                &self.leading_args, &controller_url, run_id, &worker_id,
            );
            let mut cmd = Command::new(&self.worker_bin);
            cmd.args(&cmd_args)
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .kill_on_drop(false);
            let mut child = cmd.spawn()?;
```

(나머지 reaper 로직은 그대로.) 파일 하단에 단위 테스트 추가:
```rust
#[cfg(test)]
mod tests {
    use super::worker_command_args;

    #[test]
    fn default_no_leading_args_byte_identical() {
        let a = worker_command_args(&[], "http://127.0.0.1:8081", "r1", "w1");
        assert_eq!(
            a,
            vec!["--controller", "http://127.0.0.1:8081", "--run-id", "r1", "--worker-id", "w1"]
        );
    }

    #[test]
    fn leading_worker_subcommand_prepended() {
        let a = worker_command_args(&["worker".into()], "http://127.0.0.1:8081", "r1", "w1");
        assert_eq!(a[0], "worker");
        assert_eq!(&a[1..3], &["--controller", "http://127.0.0.1:8081"]);
    }
}
```

- [ ] **Step 2: `bundle.rs`에 `open_browser` 추가**

```rust
/// 기본 브라우저로 URL을 연다. 실패는 치명적이지 않다(헤드리스 등) — warn만, 사용자가 직접 열 수 있게.
pub fn open_browser(url: &str) {
    if let Err(e) = open::that(url) {
        tracing::warn!(url, error = %e, "failed to open browser; open the URL manually");
    }
}
```

- [ ] **Step 3: `main.rs` — `--no-open` 플래그 + bundle dispatcher self-spawn + 브라우저 오픈**

`ControllerArgs`에 플래그 추가(아무 위치, 예 `scheduler_disabled` 다음):
```rust
    /// (bundle) 시작 시 기본 브라우저 자동 오픈을 끈다(헤드리스/CI/라이브검증용).
    #[arg(long, default_value_t = false)]
    no_open: bool,
```

SubprocessDispatcher 생성(Task 4에서 `grpc_addr` 사용하도록 바꾼 그 자리)을 bundle/비-bundle로 가른다:
```rust
        WorkerMode::Subprocess => {
            #[cfg(feature = "bundle")]
            {
                // 멀티콜: 자기 자신(current_exe)을 `worker` 서브커맨드로 재실행.
                let self_exe = std::env::current_exe()
                    .context("resolve current_exe for worker self-spawn")?
                    .to_string_lossy()
                    .into_owned();
                Arc::new(
                    SubprocessDispatcher::new(self_exe, grpc_addr, db.clone())
                        .with_leading_args(vec!["worker".to_string()]),
                )
            }
            #[cfg(not(feature = "bundle"))]
            {
                Arc::new(SubprocessDispatcher::new(
                    args.worker_bin.clone(),
                    grpc_addr,
                    db.clone(),
                ))
            }
        }
```

브라우저 오픈: REST 바인딩 성공(Task 4의 `rest_addr` 확보) 직후, serve 진입 전에 추가:
```rust
    #[cfg(feature = "bundle")]
    if !args.no_open {
        let url = format!("http://localhost:{}", rest_addr.port());
        info!(%url, "opening browser");
        handicap_controller::bundle::open_browser(&url);
    }
```

- [ ] **Step 4: 양쪽 빌드/게이트**

Run:
```
cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run -p handicap-controller
cargo build -p handicap-controller --features bundle && cargo clippy -p handicap-controller --features bundle --all-targets -- -D warnings && cargo test -p handicap-controller --features bundle
```
Expected: green. `worker_command_args` 테스트 2개 PASS. **비-bundle 게이트는 dispatcher 구성·spawn 인자가
현행과 동일**(leading_args=[] → byte-identical, 기존 24+ `::new` 사이트 무변경)임을 확인.

- [ ] **Step 5: 커밋**

```
git add crates/controller/src/dispatcher/subprocess.rs crates/controller/src/bundle.rs crates/controller/src/main.rs
git commit -m "feat(controller,bundle): self-spawn worker via current_exe + auto-open browser (--no-open)"
git log -1
```

---

## Task 7: 초보자용 빌드 런북 문서

**Files:**
- Create: `docs/dev/single-exe-build.md`

doc-only(코드 무변경) — pre-commit fast-path. spec §6의 내용을 초보자가 그대로 따라할 수 있게 작성.

- [ ] **Step 1: `docs/dev/single-exe-build.md` 작성**

아래 골격에 **실제 명령**을 채워 넣는다(요지는 spec §6):

1. **개요**: "이 문서는 핸디캡을 더블클릭으로 실행되는 단일 실행 파일로 빌드하는 법. macOS/Linux는
   검증용, Windows `.exe`는 Windows에서 빌드(이 저장소는 macOS에서 개발됨)."
2. **§ macOS/Linux 자체완결 바이너리**:
   - `cd ui && pnpm install && pnpm build` (→ `ui/dist`, 임베드 입력).
   - `cargo build --release --features bundle` (→ `target/release/controller`).
   - 실행: `./target/release/controller` → 브라우저 자동 오픈. `--no-open`으로 끔.
3. **§ Windows `.exe` 빌드 — 초보자용 (Windows 머신에서)**: 각 단계에 *왜 필요한지* 한 줄 + 명령:
   1. **Visual Studio C++ 빌드 도구**: "Build Tools for Visual Studio" 설치 시 **"C++를 사용한 데스크톱
      개발"** 워크로드 체크(Rust가 링킹에 MSVC 링커 사용). 다운로드 위치 안내.
   2. **Rust**: https://rustup.rs 의 `rustup-init.exe` 실행 → 기본(MSVC) toolchain. `rustc --version` 확인.
   3. **protoc**: `winget install protobuf` (또는 수동 zip + PATH) → `protoc --version`. (tonic-build이
      빌드 타임에 사용.)
   4. **Node.js + pnpm**: `winget install OpenJS.NodeJS.LTS` → `npm install -g pnpm` → `pnpm --version`.
   5. **소스 가져오기**: 저장소 클론/복사.
   6. **UI 빌드**: `cd ui` → `pnpm install` → `pnpm build`.
   7. **단일 exe 빌드**: 저장소 루트에서 `cargo build --release --features bundle`.
   8. **결과물**: `target\release\controller.exe` → `handicap.exe`로 리네임.
   9. **실행**: `handicap.exe` 더블클릭 → 브라우저가 `http://localhost:<port>` 자동 오픈(포트 사용 중이면
      자동으로 다른 포트).
   10. **데이터 위치**: `%LOCALAPPDATA%\handicap\`(DB 등). 백업/삭제 = 이 폴더.
   11. **문제 해결**: SmartScreen/백신 경고(서명 안 된 exe — "추가 정보→실행"), 방화벽 프롬프트(localhost는
       허용), 포트 안내.
4. **§ (선택) CI 부록**: `windows-latest` 러너에서 위를 자동화하는 GitHub Actions **예시 YAML**.
   **"이 저장소는 remote 미설정이라 지금은 동작 안 함 — GitHub에 올리면 쓸 수 있는 참고용"** 명시.
5. **§ 한계**: 단일 워커(라이트 부하). 본격 부하·멀티워커는 K8s 경로(ADR-0027). exe 서명·인스톨러는
   미포함(ADR-0039 옵션 B/후속).

- [ ] **Step 2: 커밋**

```
git add docs/dev/single-exe-build.md
git commit -m "docs(dev): beginner-friendly single-exe build runbook (Windows + macOS/Linux)"
git log -1
```

---

## Task 8: 라이브 검증 (macOS — 슬라이스 완료 기준)

코드 태스크 아님. `/live-verify` 스킬 + 아래 시나리오. (최종 handicap-reviewer 통과 후 수행 — 슬라이스
파이프라인 5단계.)

- [ ] **Step 1: bundle 바이너리 빌드**
```
cd ui && pnpm install && pnpm build && cd ..
cargo build --release --features bundle
```

- [ ] **Step 2: 인자 없이(브라우저 끔) 기동 + 경로/포트 로그 확인**
```
./target/release/controller --no-open
```
기대: 로그에 `resolved database path`(= `~/Library/Application Support/handicap/handicap.db`),
`bound listeners`(실제 REST/gRPC 포트), `REST listening`. `GET http://localhost:<port>/` 가 임베드 UI
index 200, `GET /api/health` 200.

- [ ] **Step 3: 실제 run 1개 — worker self-spawn 확인**

50ms responder + 시나리오 생성 + run 생성(curl 또는 Playwright). 기대:
- controller 로그에 `spawning worker subprocess`(worker_bin = self exe 경로) + `worker exited` 정상.
- run `completed`, `/runs/{id}/report`가 `ReportSchema` 통과(S-D 갭 차단).

- [ ] **Step 4: 포트 자동 회피 확인**

다른 프로세스로 기본 REST 포트(8080) 점유 후 `./target/release/controller --no-open` 기동 → 로그
`bound listeners`가 8080이 아닌 다른 포트를 보이고 그 포트로 UI 200.

- [ ] **Step 5: 정리**

responder/임시 DB/`.playwright-mcp`·루트 png 정리(`/live-verify` 가이드).

---

## Self-Review (작성자 체크 — 구현 전 1회)

- **spec 커버리지**: D1(범위)=Task7+8, D2(멀티콜)=Task1+2+6, D3(bundle off=byte-identical)=전 태스크 cfg
  게이트, D4(worker bin 유지)=Task1, D5(포트 회피)=Task4. §5.1=T1, §5.2=T2, §5.3=T2, §5.4=T5, §5.5=T3,
  §5.6=T6, §5.7=T6, §5.8=T4, §6=T7, §7=T8. 빠짐 없음.
- **placeholder**: 모든 코드 단계에 실제 코드/명령. worker `run()` 본문만 "verbatim 이동"으로 지시(400줄
  재현은 오류원 — 이동이 정확).
- **타입 일관성**: `WorkerArgs`(lib 단일), `resolve_db_path(Option<&str>, Option<&Path>)`,
  `bind_with_fallback(SocketAddr, bool)`, `with_leading_args(Vec<String>)`, `serve_embedded_ui(Uri)`,
  `open_browser(&str)` — 태스크 간 시그니처 일치.

---

<!-- spec + plan 모두 spec-plan-reviewer clean APPROVE (2026-06-16). 이 마커가 spec-review-guard를 통과시킨다. -->
REVIEW-GATE: APPROVED
