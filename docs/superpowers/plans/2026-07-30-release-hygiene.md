# 릴리즈 위생 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 배포된 handicap 바이너리가 자기 릴리즈 버전을 말하게 하고(CLI·로그·REST·UI 헤더), 릴리즈 CI를 preflight → build×2 → publish로 갈라 장애 시 재실행 비용을 18분에서 수십 초로 줄이며, 릴리즈 노트가 빈 채로 발행될 수 없게 만든다.

**Architecture:** 버전 단일 소스는 루트 `[workspace.package] version`이고 5개 crate가 상속한다(`env!("CARGO_PKG_VERSION")` → clap `--version`·startup 로그 5곳·`GET /api/version` → UI 헤더). 릴리즈 파이프라인의 판정·게시 로직은 YAML이 아니라 **레포 스크립트 2개**(`scripts/check-release-versions.sh`·`scripts/publish-release.sh`)에 두어 로컬에서 양방향 테스트가 가능하게 하고, 워크플로는 그것을 호출만 한다.

**Tech Stack:** Rust(clap 4 derive·axum 0.8·tracing) · TypeScript/React(React Query·Zod) · bash 3.2 호환 스크립트 + `jq` · GitHub Actions(`tauri-action`·`upload/download-artifact@v4`·`gh` CLI)

**Spec:** `docs/superpowers/specs/2026-07-30-release-hygiene-design.md` (clean APPROVE, 3라운드 28 findings 종결). R-id는 그 spec을 가리킨다.

## Global Constraints

spec에서 **verbatim** 옮긴 프로젝트 전역 값·규칙. 모든 task의 요구사항에 암묵적으로 포함된다.

- **버전 값은 `0.7.0`** — 이 슬라이스는 **bump가 아니다**(현 릴리즈 버전에서 출발). 태그 표기는 `v0.7.0`, 파일 안 값은 `0.7.0`.
- **ko 신규 키는 정확히 1개**: `ko.common.versionTitle = "컨트롤러 버전"`. `ko.nav`가 아니라 `ko.common`(nav는 목적지 링크 라벨 전용). 헤더 단언은 **정확매치/testid**로 — 기존 값 `"버전"`(`ko.ts:395` `versionCol`)이 부분문자열로 걸리므로 `toHaveTextContent(ko.common.versionTitle)` 류 금지.
- **`env!("CARGO_PKG_VERSION")`만 사용** — 하드코딩 `"0.7.0"` 문자열을 Rust/TS 코드에 넣지 않는다(테스트 픽스처와 스크립트 인자는 예외).
- **에셋 파일명 5종은 v0.7.0과 동일**(*네이밍* 불변식, 완전성 아님): `Handicap_<ver>_x64-setup.exe` · `Handicap_<ver>_x64_en-US.msi` · `Handicap_<ver>_x64-portable.exe` · `Handicap_<ver>_aarch64.dmg` · `Handicap_<ver>_x64.dmg`. 릴리즈 이름은 `Handicap v<ver>`.
- **재시도**: 최대 **5회 시도**(최초 1회 + 4회), 지연 **10/20/40/80초**(총 150초). **오류 분류 없음**(gh는 HTTP 상태를 안 준다). 지연은 `PUBLISH_RETRY_DELAYS` env로 오버라이드 가능.
- **스크립트는 bash 3.2 호환**(개발 머신 실측 `GNU bash 3.2.57`, **`mapfile` 없음**) — `while IFS= read -r` 루프 사용, `mapfile`/`declare -A`/`${x^^}` 금지. shebang `#!/usr/bin/env bash` + `set -euo pipefail` + **모드 100755로 커밋**.
- **R11 불변**: proto·migration·엔진 **0-diff** · `.github/workflows/ci.yml` 무변경 · 기존 REST 응답 shape·기존 UI 화면 무변경(헤더 텍스트 1개 추가 외) · 기존 CLI 인자·기본값 무변경 · `info!(?args, …)` 구조체 Debug 덤프 **금지**(worker_token PSK 평문 유출).
- **`in_process.rs`는 bundle-gated**(`crates/controller/src/lib.rs:11-12`) — pre-commit도 기본 feature `cargo build --workspace`도 컴파일하지 않는다. 그 파일을 건드린 task는 `cargo build/clippy -p handicap-controller --features bundle`(+`ui/dist` 선빌드) **및 필터 없는 전체** `cargo test -p handicap-controller --features bundle`을 수동 실행해야 한다.
- **tdd-guard 파일별 사전조건**(실측):

| 파일 | 인라인 `#[cfg(test)]` | 결론 |
|---|---|---|
| `crates/controller/src/app.rs` | **0** | 편집 **차단** → `crates/controller/tests/version_api_test.rs`를 **먼저** 만든다 |
| `crates/worker/src/main.rs` | **0** | 편집 차단 → 테스트 mod를 **같은 Edit에 포함**한다 |
| `crates/controller/src/{main.rs,in_process.rs}` · `crates/worker/src/lib.rs` | 있음 | 자유 |
| `crates/*/Cargo.toml` · `Cargo.lock` · `justfile` · `scripts/` · `.github/` · `docs/` | 미감시 | 자유 |
| `ui/src/**` | — | 테스트 파일 편집을 **첫 스텝**으로 |

- **커밋 규율**: cargo-영향 경로(`Cargo.toml`·`Cargo.lock`·`crates/**`)를 건드린 커밋은 full pre-commit 게이트라 수 분 → `git commit`을 **단일 FOREGROUND 호출(timeout 600000ms)**로 실행하고 `| tail`/`| head` 파이프를 붙이지 않는다(종료코드 마스킹 — git-guard가 deny). `--no-verify` 금지.

## File Structure

| 파일 | 역할 | Task |
|---|---|---|
| `Cargo.toml` | `[workspace.package] version = "0.7.0"` 단일 소스 | 1 |
| `crates/{engine,proto,worker-core,worker,controller}/Cargo.toml` | `version.workspace = true` | 1 |
| `Cargo.lock` · `desktop/src-tauri/Cargo.lock` | 생성물(handicap 5개 항목 `0.7.0`) | 1 |
| `crates/controller/src/main.rs` | `#[command(version)]` + 로그 #1(비-bundle)·#2(`run_bundle`) + 인라인 버전 테스트 | 2 |
| `crates/controller/src/in_process.rs` | 로그 #3(데스크톱 = US1 채널, bundle-only) | 2 |
| `crates/worker/src/main.rs` | `#[command(version)]` + 인라인 버전 테스트(같은 Edit) | 3 |
| `crates/worker/src/lib.rs` | 로그 #4(`run`)·#5(`run_pool`) | 3 |
| `crates/controller/src/app.rs` | `VersionResponse` + `GET /api/version` | 4 |
| `crates/controller/tests/version_api_test.rs` | 라우트 통합 테스트(tdd-guard 선행 조건) | 4 |
| `ui/src/api/schemas.ts` | `VersionSchema` | 5 |
| `ui/src/api/client.ts` | `api.getVersion` | 5 |
| `ui/src/api/hooks.ts` | `queryKeys.version` + `useVersion` | 5 |
| `ui/src/i18n/ko.ts` | `common.versionTitle` | 5 |
| `ui/src/components/Layout.tsx` | 로고+버전 공통 래퍼 | 5 |
| `ui/src/components/__tests__/Layout.test.tsx` | 훅 모킹(기존 테스트 구제) + 렌더/미렌더 2케이스 | 5 |
| `scripts/check-release-versions.sh` | 태그↔6개 버전 문자열 정합 검사(5종) | 6 |
| `justfile` | `bump-version <ver>` | 7 |
| `scripts/publish-release.sh` | 에셋 수집·노트 4분기·유한 재시도 | 8 |
| `.github/workflows/release.yml` | preflight → build×2 → publish | 8 |
| `docs/release-notes/v0.6.0.md` | 소급 노트(게시는 사용자 확인 후) | 9 |
| `docs/dev/tauri-desktop-build.md` | §CI 릴리즈 절차 갱신 | 10 |

**순서**: Task 1–5 = 8a(버전 신원, 오늘 라이브 증명 가능) → Task 6–10 = 8b(릴리즈 파이프라인·노트). 8b를 드롭해도 8a는 그대로 출하된다.

---

### Task 1: workspace 버전 상속 (R1)

**Files:**
- Modify: `Cargo.toml` (`[workspace.package]` 블록, 5-9행)
- Modify: `crates/engine/Cargo.toml:3` · `crates/proto/Cargo.toml:3` · `crates/worker-core/Cargo.toml:3` · `crates/worker/Cargo.toml:3` · `crates/controller/Cargo.toml:3`
- Modify(생성물): `Cargo.lock` · `desktop/src-tauri/Cargo.lock`

**Interfaces:**
- Consumes: 없음(첫 task)
- Produces: `env!("CARGO_PKG_VERSION")` == `"0.7.0"` (Task 2·3·4가 읽는다) · `[workspace.package] version` 존재(Task 6의 검사 #1 대상)

- [ ] **Step 1: 루트 `Cargo.toml`의 `[workspace.package]`에 version 추가**

`Cargo.toml` 5-9행을 아래로 만든다(`version`을 `edition` **위**에 둔다 — cargo 관용 순서):

```toml
[workspace.package]
version = "0.7.0"
edition = "2024"
rust-version = "1.85"
license = "Proprietary"
publish = false
```

- [ ] **Step 2: 5개 crate manifest를 상속으로 전환**

각 파일의 `version = "0.1.0"`(3행)을 정확히 아래로 교체한다. 다른 줄은 건드리지 않는다.

```toml
version.workspace = true
```

대상: `crates/engine/Cargo.toml` · `crates/proto/Cargo.toml` · `crates/worker-core/Cargo.toml` · `crates/worker/Cargo.toml` · `crates/controller/Cargo.toml`

- [ ] **Step 3: 내부 path 의존에 버전 요구가 붙지 않았는지 확인**

Run: `grep -rn "handicap-" crates/*/Cargo.toml | grep version`
Expected: **출력 없음**. (bare `path = "..."` 유지가 R1 불변 — 버전 요구가 붙으면 다음 bump가 5개 파일을 더 건드린다.)

- [ ] **Step 4: 두 락파일 재생성**

```bash
cargo metadata --format-version 1 >/dev/null
cargo metadata --manifest-path desktop/src-tauri/Cargo.toml --format-version 1 >/dev/null
```

`--offline`을 붙이지 말 것(락에 타 플랫폼 의존이 있어 exit 101).

- [ ] **Step 5: 두 락파일이 실제로 갱신됐는지 확인**

```bash
for f in Cargo.lock desktop/src-tauri/Cargo.lock; do
  echo "== $f"
  awk '/^name = "handicap-/ { n=$0; getline; print n, $0 }' "$f"
done
```

Expected: 두 파일 각각 handicap 5줄이 모두 `version = "0.7.0"`. 하나라도 `0.1.0`이면 Step 4의 명령이 그 워크스페이스를 갱신하지 못한 것 → `cargo update --workspace`(해당 매니페스트 경로 지정)로 재시도하고 **어느 명령이 통했는지 Task 7 Step 3에 반영**한다.

- [ ] **Step 6: 워크스페이스 빌드 green 확인**

Run: `cargo build --workspace`
Expected: 성공(경고 무관). 버전 상속은 코드 변경이 없으므로 실패하면 manifest 문법 오류다.

- [ ] **Step 7: 커밋**

```bash
git add Cargo.toml Cargo.lock crates/*/Cargo.toml desktop/src-tauri/Cargo.lock
git commit -m "chore(crates): workspace version 상속 도입 — crates/* 0.1.0 → 0.7.0 (R1)"
```

FOREGROUND·timeout 600000ms·파이프 없이. 커밋 후 `git log -1`로 landed 확인.

---

### Task 2: controller `--version` + startup 로그 3곳 (R2 controller, R3 #1–#3)

**Files:**
- Modify: `crates/controller/src/main.rs` (`Cli` derive ~35행, 로그 ~154행, `run_bundle` 로그 ~367행, 인라인 `mod tests`)
- Modify: `crates/controller/src/in_process.rs:~256` (로그 #3)

**Interfaces:**
- Consumes: Task 1의 `CARGO_PKG_VERSION == "0.7.0"`
- Produces: `controller --version` → `handicap-controller 0.7.0` (Task 5 라이브 검증이 참조)

- [ ] **Step 1: 인라인 테스트 추가 (RED 먼저)**

`crates/controller/src/main.rs`의 **기존 `#[cfg(test)] mod cli_tests` 블록**(`:407`, `use super::*;` + `use clap::Parser;`가 이미 있다) 안에 아래 테스트를 추가한다. **새 모듈을 만들지 말 것** — 이름이 `mod tests`가 아니라 `mod cli_tests`다.

```rust
    #[test]
    fn cli_exposes_version_flag() {
        use clap::CommandFactory;
        let rendered = super::Cli::command().render_version().to_string();
        assert!(
            rendered.contains(env!("CARGO_PKG_VERSION")),
            "--version은 크레이트 버전을 출력해야 한다: {rendered:?}"
        );
    }
```

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-controller --bin controller cli_exposes_version_flag`
Expected: FAIL — `version`이 미설정이면 `render_version()`이 `"handicap-controller \n"`(이름만, 버전 없음)을 돌려주므로 `contains(env!("CARGO_PKG_VERSION"))`이 거짓이다(빈 문자열이라서가 아니다).

- [ ] **Step 3: `#[command(version)]` 부착**

`crates/controller/src/main.rs`의 `Cli` derive를 아래로 바꾼다(`#[derive(Debug, Parser)]` 줄 **다음**에 한 줄 추가, 기존 필드·주석 무변경):

```rust
#[derive(Debug, Parser)]
#[command(version)]
struct Cli {
```

- [ ] **Step 4: GREEN 확인**

Run: `cargo test -p handicap-controller --bin controller cli_exposes_version_flag`
Expected: PASS

- [ ] **Step 5: 이빨 실증 (고의 회귀 → RED → 원복 → GREEN)**

`#[command(version)]` 줄을 임시 삭제 → Step 2 명령 → **FAIL 확인** → 줄 복원 → Step 4 명령 → **PASS 확인**. (이 테스트가 플래그 배선을 실제로 잠그는지 증명한다.)

- [ ] **Step 6: 로그 #1 — 비-bundle controller**

`crates/controller/src/main.rs`의 `#[cfg(not(feature = "bundle"))]` 블록 안 `info!`(~154행)에 `version` 필드를 **첫 필드로** 추가한다:

```rust
        info!(
            version = env!("CARGO_PKG_VERSION"),
            rest = %args.rest,
            grpc = %args.grpc,
            worker_mode = ?args.worker_mode,
            worker_token_set = args.worker_token.is_some(),
            "controller starting"
        );
```

- [ ] **Step 7: 로그 #2 — `run_bundle` (포터블 exe가 보는 라인)**

같은 파일 `run_bundle`의 `info!`(~367행). 바로 위의 "args를 통째 ?-덤프하지 말 것" 주석은 **유지**한다:

```rust
    info!(
        version = env!("CARGO_PKG_VERSION"),
        rest = %args.rest,
        grpc = %args.grpc,
        worker_token_set = args.worker_token.is_some(),
```

- [ ] **Step 8: 로그 #3 — in-process (Tauri 데스크톱 = US1 채널)**

`crates/controller/src/in_process.rs:~256`을 아래로 바꾼다:

```rust
    info!(version = env!("CARGO_PKG_VERSION"), rest = %rest_addr, grpc = %grpc_addr, "listeners (in-process)");
```

이 파일은 **bundle-only**이므로 pre-commit이 컴파일하지 않는다 — Step 10의 수동 게이트가 유일한 컴파일 확인이다.

- [ ] **Step 9: 비-bundle 게이트**

```bash
cargo build -p handicap-controller --bin controller
cargo clippy -p handicap-controller --bin controller -- -D warnings
cargo test -p handicap-controller --bin controller
```

Expected: 전부 green.

- [ ] **Step 10: bundle 게이트 (수동 — 필터 없이)**

```bash
cd ui && pnpm build && cd ..            # rust-embed가 컴파일타임에 ui/dist를 읽는다
cargo build -p handicap-controller --features bundle
cargo clippy -p handicap-controller --features bundle -- -D warnings
cargo test -p handicap-controller --features bundle
```

Expected: 전부 green, 테스트 0-failed. **필터를 붙이지 말 것**(필터 실행이 "기능 켜짐에 깨지는 기존 테스트"를 놓친 선례가 `crates/controller/CLAUDE.md`에 있다).

- [ ] **Step 11: `--version` 실제 실행 확인**

```bash
cargo run -q -p handicap-controller --bin controller -- --version
cargo run -q -p handicap-controller --bin controller --features bundle -- --version
```

Expected: 둘 다 `handicap-controller 0.7.0`.

- [ ] **Step 12: 커밋**

```bash
git add crates/controller/src/main.rs crates/controller/src/in_process.rs
git commit -m "feat(controller): --version 플래그 + startup 로그 version 필드 3곳 (R2·R3 #1-#3)"
```

---

### Task 3: worker `--version` + startup 로그 2곳 (R2 worker, R3 #4–#5)

**Files:**
- Modify: `crates/worker/src/main.rs` (전체 — 17행 파일, 테스트 mod를 **같은 Edit에** 포함)
- Modify: `crates/worker/src/lib.rs:~489`(`run`) · `:~539`(`run_pool`)

**Interfaces:**
- Consumes: Task 1의 `CARGO_PKG_VERSION`
- Produces: `worker --version` → `handicap-worker 0.7.0`

- [ ] **Step 1: `crates/worker/src/main.rs`를 아래 내용으로 교체 (한 번의 Edit — 테스트 포함이 tdd-guard 통과 조건)**

```rust
use clap::Parser;
use handicap_worker::WorkerArgs;

/// `worker` 바이너리 진입점. 인자는 lib의 `WorkerArgs`를 그대로 쓴다(K8s/subprocess
/// dispatcher가 `--controller/--run-id/--worker-id`로 호출 — A3a/A3c).
#[derive(Debug, Parser)]
#[command(version)]
struct Cli {
    #[command(flatten)]
    args: WorkerArgs,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    handicap_worker::init_worker_tracing();
    let cli = Cli::parse();
    handicap_worker::run_dispatch(cli.args).await
}

#[cfg(test)]
mod tests {
    use super::Cli;
    use clap::CommandFactory;

    #[test]
    fn cli_exposes_version_flag() {
        let rendered = Cli::command().render_version().to_string();
        assert!(
            rendered.contains(env!("CARGO_PKG_VERSION")),
            "--version은 크레이트 버전을 출력해야 한다: {rendered:?}"
        );
    }
}
```

- [ ] **Step 2: GREEN 확인 + 이빨 실증**

```bash
cargo test -p handicap-worker --bin worker cli_exposes_version_flag
```
Expected: PASS → `#[command(version)]` 줄 임시 삭제 후 재실행 → **FAIL 확인** → 복원 → 재실행 → PASS.

- [ ] **Step 3: 로그 #4 — `run` (run-scoped 워커)**

`crates/worker/src/lib.rs:~489`의 `info!`에 `version`을 첫 필드로:

```rust
    info!(
        version = env!("CARGO_PKG_VERSION"),
        controller = %args.controller,
        run_id = ?args.run_id,
        capacity_vus = args.capacity_vus,
```

- [ ] **Step 4: 로그 #5 — `run_pool` (LAN 풀 워커)**

같은 파일 `:~539`:

```rust
    info!(version = env!("CARGO_PKG_VERSION"), %worker_id, "pool worker starting (idle)");
```

- [ ] **Step 5: 게이트**

```bash
cargo build -p handicap-worker
cargo clippy -p handicap-worker -- -D warnings
cargo test -p handicap-worker
cargo run -q -p handicap-worker --bin worker -- --version
```

Expected: green + `handicap-worker 0.7.0`.

- [ ] **Step 6: 커밋**

```bash
git add crates/worker/src/main.rs crates/worker/src/lib.rs
git commit -m "feat(worker): --version 플래그 + startup 로그 version 필드 2곳 (R2·R3 #4-#5)"
```

---

### Task 4: `GET /api/version` (R4)

**Files:**
- Create: `crates/controller/tests/version_api_test.rs` (**Step 1에서 먼저** — `app.rs`는 인라인 테스트가 0이라 tdd-guard가 편집을 막는다)
- Modify: `crates/controller/src/app.rs` (`/health` 라우트 직후 + 파일 하단 핸들러)

**Interfaces:**
- Consumes: Task 1의 `CARGO_PKG_VERSION`
- Produces: `GET /api/version` → `200 {"version":"0.7.0"}` · `pub struct VersionResponse { pub version: String }`(Task 5의 Zod 스키마가 이 shape과 1:1)

- [ ] **Step 1: 통합 테스트 파일 생성 (RED 먼저 + tdd-guard 선행 조건)**

`crates/controller/tests/version_api_test.rs`:

```rust
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::subprocess::SubprocessDispatcher;
use handicap_controller::{app, store};
use tower::ServiceExt;

async fn build_state() -> app::AppState {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = handicap_controller::grpc::coordinator::CoordinatorState::new(db.clone());
    let dispatcher = Arc::new(SubprocessDispatcher::new(
        "/nonexistent".to_string(),
        "127.0.0.1:0".parse().unwrap(),
        db.clone(),
    ));
    app::AppState {
        db,
        coord,
        dispatcher,
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
    }
}

#[tokio::test]
async fn version_endpoint_reports_crate_version() {
    let app = app::router(build_state().await);
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/version")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        parsed,
        serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }),
        "응답은 version 한 필드만 담아야 한다(경로·호스트명 등 추가 금지)"
    );
}
```

`ui_dir: None`이 load-bearing이다 — SPA fallback이 붙으면 미매치 `/api/*`가 404가 아니라 200 `index.html`이 되어(spec 실측 §9) 라우트 부재를 이 테스트가 놓친다.

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-controller --test version_api_test`
Expected: FAIL — 라우트가 없어 404(`assert_eq!(resp.status(), OK)`에서 실패).

- [ ] **Step 3: 핸들러 + 응답 타입 추가**

`crates/controller/src/app.rs` 파일 하단(`router` 함수 밖)에 추가한다:

```rust
/// `GET /api/version` 응답. 필드는 `version` **하나만** — 경로·호스트명·설정값을
/// 얹지 않는다(공개 표면 최소화, R4).
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct VersionResponse {
    pub version: String,
}

async fn version() -> axum::Json<VersionResponse> {
    axum::Json(VersionResponse {
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}
```

- [ ] **Step 4: 라우트 배선**

`router()`의 `/health` 줄 **바로 다음**에 한 줄 추가:

```rust
        .route("/health", get(|| async { "ok" }))
        .route("/version", get(version))
```

- [ ] **Step 5: GREEN 확인**

Run: `cargo test -p handicap-controller --test version_api_test`
Expected: PASS

- [ ] **Step 6: 이빨 실증**

`.route("/version", get(version))` 줄을 임시 삭제 → Step 2 명령 → **FAIL(404) 확인** → 복원 → PASS 확인.

- [ ] **Step 7: 게이트**

```bash
cargo clippy -p handicap-controller --all-targets -- -D warnings
cargo test -p handicap-controller
```

Expected: green. (`/health` 응답 shape 무변경 = R11.)

- [ ] **Step 8: 커밋**

```bash
git add crates/controller/src/app.rs crates/controller/tests/version_api_test.rs
git commit -m "feat(controller): GET /api/version — 단일 version 필드 (R4)"
```

---

### Task 5: UI 헤더 버전 (R5)

**Files:**
- Modify: `ui/src/components/__tests__/Layout.test.tsx` (**Step 1 — tdd-guard가 UI 첫 스텝으로 테스트를 요구**)
- Modify: `ui/src/api/schemas.ts` · `ui/src/api/client.ts` · `ui/src/api/hooks.ts` · `ui/src/i18n/ko.ts` · `ui/src/components/Layout.tsx`

**Interfaces:**
- Consumes: Task 4의 `GET /api/version` → `{"version": string}`
- Produces: `useVersion(): UseQueryResult<{version: string}>` · `ko.common.versionTitle`

- [ ] **Step 1: 기존 테스트 파일을 아래 내용으로 교체 (RED 먼저)**

기존 파일은 `MemoryRouter`만으로 렌더하므로, `Layout`이 `useVersion()`을 부르기 시작하면 *No QueryClient set*으로 **확정 RED**가 되고 `vi.mock`은 파일 스코프라 다른 파일의 모킹이 이 파일을 구제하지 못한다. 훅을 이 파일에서 모킹해 QueryClient 자체를 불필요하게 만든다.

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useVersion } from "../../api/hooks";
import { Layout } from "../Layout";

vi.mock("../../api/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/hooks")>()),
  useVersion: vi.fn(),
}));

function mockVersion(data: { version: string } | undefined) {
  vi.mocked(useVersion).mockReturnValue({ data } as unknown as ReturnType<typeof useVersion>);
}

function renderLayout() {
  render(
    <MemoryRouter>
      <Layout />
    </MemoryRouter>,
  );
}

describe("Layout nav", () => {
  beforeEach(() => {
    mockVersion(undefined);
  });

  it("네비 4개가 한국어 라벨로 올바른 경로를 가리킨다", () => {
    renderLayout();
    expect(screen.getByRole("link", { name: ko.nav.scenarios })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: ko.nav.datasets })).toHaveAttribute(
      "href",
      "/datasets",
    );
    expect(screen.getByRole("link", { name: ko.nav.environments })).toHaveAttribute(
      "href",
      "/environments",
    );
    expect(screen.getByRole("link", { name: ko.nav.schedules })).toHaveAttribute(
      "href",
      "/schedules",
    );
  });
});

describe("Layout 버전 표시", () => {
  it("버전을 받으면 로고 옆에 v<버전>을 렌더한다", () => {
    mockVersion({ version: "9.9.9" });
    renderLayout();
    const badge = screen.getByTitle(ko.common.versionTitle);
    expect(badge).toHaveTextContent(/^v9\.9\.9$/);
    // 로고 접근명이 오염되지 않는다(버전은 <Link> 밖 형제여야 한다)
    expect(screen.getByRole("link", { name: "Handicap" })).not.toHaveTextContent("9.9.9");
  });

  it("버전이 없으면(로딩·실패) 아무것도 렌더하지 않는다", () => {
    mockVersion(undefined);
    renderLayout();
    expect(screen.queryByTitle(ko.common.versionTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test Layout`
Expected: FAIL — `useVersion`이 `../../api/hooks`에 없어 모킹 factory가 깨지거나 `ko.common.versionTitle`이 undefined.

- [ ] **Step 3: Zod 스키마 추가**

`ui/src/api/schemas.ts` 하단에 추가한다. 서버가 항상 직렬화하는 non-Option 필드라 **plain `z.string()`**(`.optional()`/`.nullish()`/`.default()` 금지 — `request<T>` 제네릭에 input 타입이 누출된다):

```ts
export const VersionSchema = z.object({ version: z.string() }).strict();
export type Version = z.infer<typeof VersionSchema>;
```

- [ ] **Step 4: API 클라이언트에 추가**

`ui/src/api/client.ts`의 `export const api = {` 블록에서 `listScenarios` **위**에 한 줄 추가하고, 파일 상단 스키마 import 목록에 `VersionSchema`를 더한다:

```ts
  getVersion: () => request("/version", { method: "GET" }, VersionSchema),
```

- [ ] **Step 5: queryKey + 훅 추가**

`ui/src/api/hooks.ts`의 `queryKeys` 객체 마지막(`poolWorkers` 다음)에 한 줄:

```ts
  version: () => ["version"] as const,
```

그리고 `useScenarios` **위**에 훅을 추가한다(재시작 없이는 바뀌지 않는 값이라 `staleTime: Infinity`):

```ts
export function useVersion() {
  return useQuery({
    queryKey: queryKeys.version(),
    queryFn: api.getVersion,
    staleTime: Infinity,
  });
}
```

- [ ] **Step 6: ko 카탈로그에 키 추가**

`ui/src/i18n/ko.ts`의 `common:` 그룹 안(`close` 다음 줄 등 알파벳 무관, 그룹 내부)에 추가:

```ts
    versionTitle: "컨트롤러 버전",
```

- [ ] **Step 7: `Layout.tsx` — 로고+버전 공통 래퍼**

헤더는 현재 `justify-between` **2자녀**(로고 `<Link>` + `<nav>`)다. 버전을 세 번째 자녀로 넣으면 **헤더 중앙에 뜬다** → 로고와 한 래퍼로 감싼다. 파일 상단에 `import { useVersion } from "../api/hooks";`를 추가하고, 컴포넌트 본문 첫 줄에 `const version = useVersion();`를 넣은 뒤 로고 블록을 아래로 교체한다:

```tsx
        <div className="flex items-baseline gap-2">
          <Link to="/" className="text-xl font-semibold tracking-tight">
            Handicap
          </Link>
          {version.data && (
            <span className="text-xs text-slate-400" title={ko.common.versionTitle}>
              v{version.data.version}
            </span>
          )}
        </div>
```

- [ ] **Step 8: GREEN 확인**

Run: `cd ui && pnpm test Layout`
Expected: PASS (3케이스).

- [ ] **Step 9: 이빨 실증**

`{version.data && (…)}`를 `{false && (…)}`로 임시 변경 → Step 8 → **"버전을 받으면 …" 케이스 FAIL 확인** → 원복 → PASS. 이어서 래퍼 `<div className="flex items-baseline gap-2">`를 제거해도 테스트는 **통과한다는 것**을 확인한다(jsdom은 레이아웃이 0 — 인접 배치는 Step 12 라이브 실측만이 증명한다). 확인 후 래퍼를 복원한다.

- [ ] **Step 10: 전체 UI 게이트 (파이프 없이 종료코드 명시)**

```bash
cd ui && pnpm lint; echo "lint exit=$?"
cd ui && pnpm test; echo "test exit=$?"
cd ui && pnpm build; echo "build exit=$?"
```

Expected: 세 exit 모두 0. (`pnpm test`는 **인자 없이 전체** — targeted green ≠ full green.)

- [ ] **Step 11: 커밋**

```bash
git add ui/src/api/schemas.ts ui/src/api/client.ts ui/src/api/hooks.ts ui/src/i18n/ko.ts ui/src/components/Layout.tsx ui/src/components/__tests__/Layout.test.tsx
git commit -m "feat(ui): 헤더에 컨트롤러 버전 표시 + GET /api/version 훅 (R5)"
```

- [ ] **Step 12: 8a 라이브 검증 (US1·US1'·US2 — spec §라이브 검증 표)**

```bash
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller
./target/debug/controller --db /tmp/relhyg.db --ui-dir ui/dist --rest 127.0.0.1:8099 --grpc 127.0.0.1:8098 &
```

`&`(또는 Bash 툴 `run_in_background`)가 필요하다 — 포그라운드로 띄우면 셸이 블록돼 다음 스텝을 실행할 수 없다. `ui/dist`가 없으면 컨트롤러가 시작 시 `Error: --ui-dir "..." does not exist`로 fail-fast하므로 먼저 `cd ui && pnpm build`(Task 5 Step 10에서 이미 돌렸다).

브라우저로 `http://127.0.0.1:8099` 진입 후:

- **US1**: 헤더에 `v0.7.0`. 아래를 실행해 **인접 배치**를 실측한다(DOM 존재만으로 PASS 금지):

```js
const logo = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === 'Handicap');
const badge = document.querySelector('[title="컨트롤러 버전"]');
const lr = logo.getBoundingClientRect(), br = badge.getBoundingClientRect();
JSON.stringify({ gap: Math.round(br.left - lr.right), sameRowish: Math.abs(br.bottom - lr.bottom) < 6,
                 color: getComputedStyle(badge).color, logoName: logo.textContent.trim() })
```

Expected: `gap`이 한 자리 px(8 전후) · `sameRowish: true` · `logoName === "Handicap"`(버전 문자열 미포함).

- **US1'**: `pnpm dev`(5173)로 SPA를 띄우고 8099 컨트롤러를 죽인 상태로 진입 → 헤더에 버전이 **없고** 에러 배너·레이아웃 붕괴·콘솔 Zod raw 에러가 없음. (컨트롤러가 SPA를 서빙하는 US1 구성에서 컨트롤러를 죽이면 `ERR_CONNECTION_REFUSED`로 헤더 자체가 없어 관찰이 성립하지 않는다.)
- **US2**: Task 2 Step 11 + Task 3 Step 5의 세 `--version` 출력을 기록한다.

포트를 8099/8098로 쓰는 이유: 8080 점유자가 이 repo 것이 아닐 수 있다(`ps`로 확인 전 kill 금지). 종료는 `pgrep -f "target/debug/controller --db /tmp/relhyg.db"`로 **내가 띄운 프로세스만** 지목한다.

---

### Task 6: 버전 정합 검사 스크립트 (R6)

**Files:**
- Create: `scripts/check-release-versions.sh` (mode 100755)

**Interfaces:**
- Consumes: Task 1이 만든 `[workspace.package] version`
- Produces: `scripts/check-release-versions.sh <tag>` → exit 0/1 (Task 7·8이 호출)

- [ ] **Step 1: 스크립트 작성**

```bash
#!/usr/bin/env bash
# 릴리즈 태그와 레포 내 버전 문자열들의 정합을 검사한다(spec R6).
# 불일치는 전부 출력한 뒤 1로 종료한다(첫 항목에서 멈추지 않는다 — 한 번에 다 고치게).
# bash 3.2 호환(mapfile/연관배열 금지).
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: $0 <tag>   (예: $0 v0.7.0)" >&2; exit 2; }
tag="$1"
# 선행 v만 제거한다. `0.7.0`처럼 v 없는 입력도 **통과시키는 것이 의도**다 —
# 잘못된 태그의 실제 가드는 워크플로의 actions/checkout이 `ref: 0.7.0`(없는 ref)에서
# 실패하는 것이지 이 스크립트가 아니다. 여기서 태그 형식을 거부하도록 "고치지" 말 것.
want="${tag#v}"
fail=0

check() { # <label> <actual>
  if [ "${2:-}" != "$want" ]; then
    printf 'MISMATCH  %-44s %s (기대 %s)\n' "$1" "${2:-<없음>}" "$want"
    fail=1
  else
    printf 'ok        %-44s %s\n' "$1" "$2"
  fi
}

# TOML의 [section] 안 version. 섹션 스코프가 load-bearing —
# 루트 Cargo.toml엔 [workspace.dependencies.wiremock]의 version이 열 0에 있어
# naive `grep '^version'`은 틀린 줄을 읽는다.
toml_section_version() { # <file> <section>
  awk -v want="$2" '
    /^\[/ { in_s = ($0 == "[" want "]"); next }
    in_s && /^[[:space:]]*version[[:space:]]*=/ {
      if (match($0, /"[^"]*"/)) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
    }
  ' "$1"
}

# Cargo.lock의 [[package]] name = "<pkg>" 블록의 version.
lock_version() { # <lockfile> <pkg>
  awk -v pkg="$2" '
    $0 == "name = \"" pkg "\"" { found = 1; next }
    found && /^version = / {
      if (match($0, /"[^"]*"/)) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
    }
  ' "$1"
}

check "Cargo.toml [workspace.package]" "$(toml_section_version Cargo.toml workspace.package)"
check "desktop/src-tauri/Cargo.toml [package]" \
  "$(toml_section_version desktop/src-tauri/Cargo.toml package)"
check "desktop/src-tauri/tauri.conf.json" "$(jq -r .version desktop/src-tauri/tauri.conf.json)"

for pkg in handicap-engine handicap-proto handicap-worker-core handicap-worker handicap-controller; do
  check "Cargo.lock $pkg" "$(lock_version Cargo.lock "$pkg")"
  check "desktop lock $pkg" "$(lock_version desktop/src-tauri/Cargo.lock "$pkg")"
done

# v0.2.1이 실제로 stale이던 항목. 루트 락엔 desktop 항목이 없다(별도 워크스페이스).
check "desktop lock desktop" "$(lock_version desktop/src-tauri/Cargo.lock desktop)"

notes="docs/release-notes/${tag}.md"
if [ -f "$notes" ]; then
  echo "notes: present ($notes)"
else
  echo "notes: absent ($notes — 자동 초안으로 발행됩니다)"
fi

exit "$fail"
```

- [ ] **Step 2: 실행 권한 부여 + 정합 케이스 확인**

```bash
chmod +x scripts/check-release-versions.sh
scripts/check-release-versions.sh v0.7.0; echo "exit=$?"
```

Expected: **14행** 전부 `ok` + `notes: absent` + `exit=0`. (검사 항목 = 3 + 5×2 + 1 = 14행, 그 중 락 11행[handicap 5×2 + `desktop` 1].)

- [ ] **Step 3: 섹션 스코프 파싱이 wiremock 줄에 속지 않는지 확인**

Run: `grep -n '^version' Cargo.toml`
Expected: `56:version = "0.6"` 한 줄만(=naive 파서가 읽을 값). Step 2에서 `Cargo.toml [workspace.package]`가 `0.7.0`으로 나왔다면 섹션 스코프가 실제로 동작한 것이다.

- [ ] **Step 4: 이빨 실증 — 검사 5종을 하나씩 어긋나게**

각 항목을 고의로 틀리게 만들고 스크립트가 **그 항목을** 잡는지 확인한 뒤 원복한다(원복은 `git checkout -- <file>` 금지 — 워크트리 HEAD 보호를 위해 편집으로 되돌린다).

1. 루트 `Cargo.toml`의 `[workspace.package] version`을 `0.7.1`로 → `MISMATCH Cargo.toml [workspace.package]` + exit 1 → 원복
2. `desktop/src-tauri/Cargo.toml`의 `version`을 `0.7.1`로 → 해당 행 MISMATCH → 원복
3. `desktop/src-tauri/tauri.conf.json`의 `"version"`을 `0.7.1`로 → 해당 행 MISMATCH → 원복
4. `Cargo.lock`의 `handicap-controller` 블록 `version`을 `0.7.1`로 → `MISMATCH Cargo.lock handicap-controller` → 원복
5. `desktop/src-tauri/Cargo.lock`의 `name = "desktop"` 블록 `version`을 `0.7.1`로 → `MISMATCH desktop lock desktop` → 원복

5번이 가장 중요하다(v0.2.1 실제 사고 클래스). 각 원복 후 `scripts/check-release-versions.sh v0.7.0`이 exit 0임을 확인하고, 마지막에 `git status --porcelain`이 스크립트 파일만 보여주는지 확인한다.

- [ ] **Step 5: 태그 인자 형태 확인**

```bash
scripts/check-release-versions.sh 0.7.0; echo "exit=$?"     # v 없는 입력
scripts/check-release-versions.sh v0.9.9; echo "exit=$?"    # 없는 버전
```

Expected: 첫 명령 exit 0(선행 `v`만 제거하므로 그대로 비교), 둘째 exit 1(전 항목 MISMATCH).

`v` 없는 입력을 스크립트가 **통과시키는 것이 맞다** — 실제 가드는 워크플로의 `actions/checkout`이 `ref: 0.7.0`(그런 remote ref 없음)에서 실패하는 것이다. spec 엣지케이스의 "수동 오입력은 preflight 불일치로 드러난다"는 서술보다 이 스텝이 정확하다. 나중에 누군가 "스크립트가 `v` 없는 태그를 거부하게 고치는" 것을 막기 위해 이 근거를 스크립트 주석에도 한 줄 남긴다.

- [ ] **Step 6: 커밋**

```bash
git add scripts/check-release-versions.sh
git commit -m "feat(scripts): 릴리즈 버전 정합 검사 — 태그↔6개 버전 문자열 5종 검사 (R6)"
git show --stat HEAD | grep -q "100755" && echo "mode ok" || echo "MODE NOT 755"
```

Expected: `mode ok`.

---

### Task 7: `just bump-version` (R7)

**Files:**
- Modify: `justfile` (하단에 레시피 추가)

**Interfaces:**
- Consumes: Task 6의 `scripts/check-release-versions.sh`
- Produces: `just bump-version <ver>`

- [ ] **Step 1: 레시피 추가**

`justfile` 하단에 추가한다. 3개 파일 편집은 sed 대신 **python3**로 한다(macOS BSD sed와 GNU sed의 `-i` 비호환 + `assert`로 매치 수를 검증할 수 있다).

```just
# 릴리즈 버전 bump: 사람이 맞추는 3개 파일 + 생성물 락 2개 + 정합 검사(R7).
# 커밋·태그·push는 하지 않는다(사람이 확인 후 수행).
bump-version ver:
    #!/usr/bin/env bash
    set -euo pipefail
    python3 - "{{ver}}" <<'PY'
    import pathlib, re, sys
    ver = sys.argv[1]

    def toml_section_set(path, section):
        p = pathlib.Path(path)
        s = p.read_text()
        m = re.search(r'^\[' + re.escape(section) + r'\][^\[]*', s, re.M)
        assert m, f"{path}: [{section}] 섹션 없음"
        pat = r'^version\s*=\s*"[^"]*"'
        # 개수를 먼저 센다 — subn(count=1)의 n은 최대 1이라 *중복*을 못 잡는다.
        hits = len(re.findall(pat, m.group(0), re.M))
        assert hits == 1, f"{path}: [{section}] 안 version 줄이 {hits}개(1개여야 함)"
        block = re.sub(pat, f'version = "{ver}"', m.group(0), count=1, flags=re.M)
        p.write_text(s[:m.start()] + block + s[m.end():])
        print(f"  {path} [{section}] -> {ver}")

    toml_section_set("Cargo.toml", "workspace.package")
    toml_section_set("desktop/src-tauri/Cargo.toml", "package")

    conf = pathlib.Path("desktop/src-tauri/tauri.conf.json")
    s = conf.read_text()
    vpat = r'("version"\s*:\s*)"[^"]*"'
    vhits = len(re.findall(vpat, s))
    assert vhits == 1, f'tauri.conf.json: "version" 키가 {vhits}개(1개여야 함)'
    s2 = re.sub(vpat, lambda m: m.group(1) + f'"{ver}"', s, count=1)
    conf.write_text(s2)
    print(f"  desktop/src-tauri/tauri.conf.json -> {ver}")
    PY
    echo "락 재생성…"
    cargo metadata --format-version 1 >/dev/null
    cargo metadata --manifest-path desktop/src-tauri/Cargo.toml --format-version 1 >/dev/null
    scripts/check-release-versions.sh "v{{ver}}"
    echo
    echo "다음: git add -u && git commit -m 'chore(release): {{ver}} 버전 bump' && git tag -a v{{ver}} && git push origin master v{{ver}}"
```

`tauri.conf.json`의 `"version"` 키는 파일에 **정확히 1개**(4행)라 `count=1` + `assert n == 1`이 안전하다(실측).

- [ ] **Step 2: 왕복 실증 — 0.7.1로 bump**

```bash
just bump-version 0.7.1; echo "exit=$?"
```

Expected: 편집 3행 출력 + `scripts/check-release-versions.sh v0.7.1`의 14행 전부 `ok` + exit 0. **여기서 락 항목이 MISMATCH로 잡히면** Step 3으로 간다.

- [ ] **Step 3: 락 재생성 명령 확정 (spec N2가 남긴 미결 의무)**

Step 2에서 락 10행 + `desktop lock desktop`이 모두 `ok`였으면 `cargo metadata`가 정답이므로 레시피를 그대로 둔다. 하나라도 stale이면 그 워크스페이스의 명령을 아래로 바꿔 재시도하고, **통한 명령으로 레시피를 고정**한다:

```bash
cargo update --workspace                                                  # 루트
cargo update --workspace --manifest-path desktop/src-tauri/Cargo.toml     # desktop
```

`cargo generate-lockfile`은 전체 재해상도라 **쓰지 않는다**(무관한 의존이 함께 올라간다). 확정 결과를 이 plan의 이 스텝에 한 줄로 적는다.

- [ ] **Step 4: 0.7.0으로 원복 + 트리 청결 확인**

```bash
just bump-version 0.7.0; echo "exit=$?"
git status --porcelain
```

Expected: exit 0 + `git status --porcelain`에 `justfile`만(버전 파일 5개는 원래 값으로 돌아와 diff 없음). `Cargo.lock`이 남아 있으면 `git diff Cargo.lock`으로 무엇이 달라졌는지 확인한다(의존 해상도가 바뀐 게 아니라 버전 줄만이어야 한다).

- [ ] **Step 5: 커밋**

```bash
git add justfile
git commit -m "feat(just): bump-version 레시피 — 3파일 갱신+락 재생성+정합 검사 (R7)"
```

---

### Task 8: 릴리즈 파이프라인 3-잡 재구성 (R8)

**Files:**
- Create: `scripts/publish-release.sh` (mode 100755)
- Modify: `.github/workflows/release.yml` (전체 재구성)

**Interfaces:**
- Consumes: Task 6의 `check-release-versions.sh` · Task 9가 만들 `docs/release-notes/v<ver>.md`(없어도 동작)
- Produces: `scripts/publish-release.sh <tag> <assets-dir>`

> **잡 이름은 기존 것을 유지한다**(`windows-installer`·`macos-dmg`). spec R8의 그래프는 이해를 위해 `windows-build`/`macos-build`로 적었지만, 실제 파일의 잡 이름을 바꾸면 진행 중인 릴리즈의 재실행·Actions 히스토리 참조가 끊긴다 → 이름은 그대로 두고 **역할만** 빌드-only로 바꾼다. 따라서 `publish`의 조건은 `needs.windows-installer.result == 'success'`다.

- [ ] **Step 1: 게시 스크립트 작성**

로직을 YAML이 아니라 스크립트에 두는 이유 = 로컬에서 `gh` 스텁으로 테스트 가능해야 한다(이 슬라이스의 유일한 검증 수단).

```bash
#!/usr/bin/env bash
# 릴리즈 게시(spec R8). 재실행 멱등: 릴리즈가 있으면 upload --clobber, 없으면 create.
# 오류 분류 없음 — gh는 HTTP 상태를 노출하지 않는다(spec 실측 §7). 유한 재시도만.
# bash 3.2 호환(mapfile 금지).
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: $0 <tag> <assets-dir>" >&2; exit 2; }
tag="$1"
assets_dir="$2"
notes_file="docs/release-notes/${tag}.md"

# 존재하는 파일만 수집 — 매치 없는 glob이 게시를 죽이면 안 된다(macOS dmg 실패 시 3종만 올린다).
assets=()
while IFS= read -r f; do
  assets+=("$f")
done < <(find "$assets_dir" -type f \( -name '*.exe' -o -name '*.msi' -o -name '*.dmg' \) | sort)

[ "${#assets[@]}" -gt 0 ] || { echo "게시할 에셋이 없습니다: $assets_dir" >&2; exit 1; }
echo "에셋 ${#assets[@]}개:"
printf '  %s\n' "${assets[@]}"
for want in x64-setup.exe x64_en-US.msi x64-portable.exe aarch64.dmg x64.dmg; do
  printf '%s\n' "${assets[@]}" | grep -q -- "$want" || echo "  (누락: *$want)"
done

# 최대 5회 시도(최초 1회 + 4회), 지연 10/20/40/80초. 테스트용 env 오버라이드.
retry() {
  local delays i=0
  delays=(${PUBLISH_RETRY_DELAYS:-10 20 40 80})
  until "$@"; do
    if [ "$i" -ge "${#delays[@]}" ]; then
      echo "재시도 소진(5회): $*" >&2
      return 1
    fi
    echo "실패 — ${delays[$i]}초 후 재시도 ($((i + 2))/5): $*" >&2
    sleep "${delays[$i]}"
    i=$((i + 1))
  done
}

generate_notes_to() { # <outfile>  — gh release edit엔 --generate-notes가 없다(실측 §8)
  gh api --method POST "repos/${GITHUB_REPOSITORY}/releases/generate-notes" \
    -f "tag_name=${tag}" --jq .body > "$1"
}

if gh release view "$tag" >/dev/null 2>&1; then
  echo "릴리즈 $tag 존재 → 에셋 덮어쓰기(재실행 멱등)"
  retry gh release upload "$tag" "${assets[@]}" --clobber
  if [ -f "$notes_file" ]; then
    retry gh release edit "$tag" --notes-file "$notes_file"
  elif [ -z "$(gh release view "$tag" --json body -q .body)" ]; then
    # 바이트 수로 판정하지 말 것: 빈 본문은 `-q .body | wc -c` = 1(개행)이다.
    draft="$(mktemp)"
    retry generate_notes_to "$draft"
    retry gh release edit "$tag" --notes-file "$draft"
  else
    echo "노트 파일 없음 + 기존 본문 있음 → 본문 유지"
  fi
else
  echo "릴리즈 $tag 신규 생성"
  if [ -f "$notes_file" ]; then
    retry gh release create "$tag" --title "Handicap ${tag}" \
      --notes-file "$notes_file" "${assets[@]}"
  else
    retry gh release create "$tag" --title "Handicap ${tag}" \
      --generate-notes "${assets[@]}"
  fi
fi
echo "게시 완료: $tag"
```

- [ ] **Step 2: 실행 권한 + gh 스텁으로 재시도 루프 테스트**

> ### ⚠ 스텁 테스트 안전 규약 (Step 2·2b·3·4 **모든** 블록에 적용 — 어기면 공개 릴리즈가 깨진다)
>
> `gh`는 이 머신에서 **실제 공개 레포에 인증된 상태**다. 스텁이 PATH 앞단에 없으면 `scripts/publish-release.sh v0.7.0`은 **실존하는 v0.7.0 릴리즈**를 상대로 `release upload --clobber`(9.9MB 인스톨러를 0바이트 파일로 교체) + `release edit --notes-file`(4970B 한국어 노트를 픽스처 내용으로 교체)을 실행한다.
>
> **Bash 툴은 호출 간 셸 상태(변수)를 유지하지 않는다** — 한 블록에서 `stub=...`를 정의해도 다음 블록에선 비어 `PATH=":$PATH"`가 되고, 그러면 **실제 `gh`가 잡힌다**. 그래서 스텁을 쓰는 **모든 블록**은 아래 3줄로 시작한다(리터럴 경로 + fail-closed 가드 + 인증 무력화):
>
> ```bash
> export PATH="/tmp/relhyg-stub:$PATH" GH_CONFIG_DIR=/tmp/relhyg-nogh GH_TOKEN= \
>        GITHUB_REPOSITORY=owner/repo PUBLISH_RETRY_DELAYS="0 0 0 0"
> command -v gh | grep -q '^/tmp/relhyg-stub/' \
>   || { echo "스텁이 PATH 앞단에 없다 — 실제 gh가 공개 릴리즈를 건드린다. 중단"; exit 1; }
> ```
>
> **가짜 태그로 회피하지 말 것** — 존재하지 않는 태그를 쓰면 분기 2가 실제 `gh release create`가 되어 **릴리즈를 발행**한다. 안전은 "실제 gh에 도달하지 않는 것"으로만 확보한다.

```bash
chmod +x scripts/publish-release.sh
rm -rf /tmp/relhyg-stub && mkdir -p /tmp/relhyg-stub && : > /tmp/relhyg-calls
cat > /tmp/relhyg-stub/gh <<'EOF'
#!/usr/bin/env bash
echo "$*" >> /tmp/relhyg-calls
n=$(grep -c 'release upload' /tmp/relhyg-calls || true)
case "$*" in
  "release view "*"--json body"*) echo "" ;;                 # 기존 본문 비어 있음
  "release view "*) exit 0 ;;                                # 릴리즈 존재
  "release upload"*) [ "$n" -ge 3 ] || { echo "boom" >&2; exit 1; } ;;  # 2회 실패 후 성공
  *) : ;;
esac
EOF
chmod +x /tmp/relhyg-stub/gh
mkdir -p /tmp/relhyg-assets && : > /tmp/relhyg-assets/Handicap_0.7.0_x64-setup.exe

export PATH="/tmp/relhyg-stub:$PATH" GH_CONFIG_DIR=/tmp/relhyg-nogh GH_TOKEN= \
       GITHUB_REPOSITORY=owner/repo PUBLISH_RETRY_DELAYS="0 0 0 0"
command -v gh | grep -q '^/tmp/relhyg-stub/' \
  || { echo "스텁이 PATH 앞단에 없다 — 실제 gh가 공개 릴리즈를 건드린다. 중단"; exit 1; }

scripts/publish-release.sh v0.7.0 /tmp/relhyg-assets; echo "exit=$?"
grep -c 'release upload' /tmp/relhyg-calls
```

Expected: `exit=0` + `release upload` 호출이 **정확히 3회**(2회 실패 → 3회차 성공) + 출력에 `(누락: *x64_en-US.msi)` 등 4건 + 재시도 로그 2줄. 여기에 **노트 분기 3**(파일 없음 + 기존 본문 빈 상태)이 함께 실행되므로 아래도 단언한다:

```bash
grep -c 'generate-notes' /tmp/relhyg-calls              # 1 — API 초안 생성
grep -c 'release edit .* --notes-file' /tmp/relhyg-calls # 1 — 초안 주입
```

**이 테스트가 증명하는 것은 "루프가 유한 재시도한다"와 "분기 3이 초안을 주입한다"이고, 오류 분류는 아니다**(분류를 하지 않기로 했다).

- [ ] **Step 2b: 노트 4분기 전부 단언 (US3의 "빈 본문 발행 불가"가 실제로 걸리는 지점)**

분기 3만 우연히 실행되고 1·2·4는 한 번도 안 돌면, US3의 구조적 약속을 아무것도 검사하지 않는 것이다. 스텁이 이미 `$*`로 분기하므로 아래 3회 실행이면 닫힌다. **각 실행은 위 ⚠ 안전 규약 3줄(export + `command -v gh` 가드)로 시작**하고 `: > /tmp/relhyg-calls`로 로그를 비운 뒤 `scripts/publish-release.sh v0.7.0 /tmp/relhyg-assets`를 부른다. 스텁 파일은 `/tmp/relhyg-stub/gh`(리터럴 경로 — 변수 금지).

**분기 4 — 파일 없음 + 기존 본문 있음 → 본문 유지**: 스텁의 `--json body` arm을 `echo "existing"`으로 바꾸고 아래를 실행.

```bash
export PATH="/tmp/relhyg-stub:$PATH" GH_CONFIG_DIR=/tmp/relhyg-nogh GH_TOKEN= \
       GITHUB_REPOSITORY=owner/repo PUBLISH_RETRY_DELAYS="0 0 0 0"
command -v gh | grep -q '^/tmp/relhyg-stub/' \
  || { echo "스텁이 PATH 앞단에 없다 — 실제 gh가 공개 릴리즈를 건드린다. 중단"; exit 1; }

: > /tmp/relhyg-calls
scripts/publish-release.sh v0.7.0 /tmp/relhyg-assets
grep -c 'generate-notes' /tmp/relhyg-calls   # 0
grep -c 'release edit' /tmp/relhyg-calls     # 0
```
출력에 `노트 파일 없음 + 기존 본문 있음 → 본문 유지`. 확인 후 arm을 `echo ""`로 원복.

이 분기도 `release exists → upload --clobber` 경로를 지난다 — 가드 없이 실제 `gh`에 닿으면 **공개 v0.7.0 에셋이 0바이트로 교체된다**.

**분기 1 — 노트 파일 있음 → `--notes-file <파일>`**:

```bash
export PATH="/tmp/relhyg-stub:$PATH" GH_CONFIG_DIR=/tmp/relhyg-nogh GH_TOKEN= \
       GITHUB_REPOSITORY=owner/repo PUBLISH_RETRY_DELAYS="0 0 0 0"
command -v gh | grep -q '^/tmp/relhyg-stub/' \
  || { echo "스텁이 PATH 앞단에 없다 — 실제 gh가 공개 릴리즈를 건드린다. 중단"; exit 1; }

: > /tmp/relhyg-calls
mkdir -p docs/release-notes && printf 'x\n' > docs/release-notes/v0.7.0.md
scripts/publish-release.sh v0.7.0 /tmp/relhyg-assets
grep -c 'release edit v0.7.0 --notes-file docs/release-notes/v0.7.0.md' /tmp/relhyg-calls  # 1
grep -c 'generate-notes' /tmp/relhyg-calls                                                # 0
rm docs/release-notes/v0.7.0.md    # Task 9가 만드는 것은 v0.6.0.md다 — 이 픽스처는 남기지 않는다
```

이 분기가 가드 없이 실제 `gh`에 닿으면 **공개 v0.7.0 노트가 `x`로 교체된다**(픽스처 내용). 세 줄 가드가 load-bearing인 이유가 이 케이스다.

**분기 2 — 릴리즈 없음 + 파일 없음 → `create --generate-notes`**: 스텁의 `"release view "*) exit 0` arm을 `exit 1`로 바꾸고 아래를 실행.

```bash
export PATH="/tmp/relhyg-stub:$PATH" GH_CONFIG_DIR=/tmp/relhyg-nogh GH_TOKEN= \
       GITHUB_REPOSITORY=owner/repo PUBLISH_RETRY_DELAYS="0 0 0 0"
command -v gh | grep -q '^/tmp/relhyg-stub/' \
  || { echo "스텁이 PATH 앞단에 없다 — 실제 gh가 공개 릴리즈를 건드린다. 중단"; exit 1; }

: > /tmp/relhyg-calls
scripts/publish-release.sh v0.7.0 /tmp/relhyg-assets
grep -c 'release create v0.7.0 --title Handicap v0.7.0 --generate-notes' /tmp/relhyg-calls  # 1
grep -c 'release upload' /tmp/relhyg-calls                                                   # 0
```
확인 후 arm을 `exit 0`으로 원복. (`--title`과 태그 사이 인자 순서는 스크립트 그대로 — grep이 실패하면 실제 호출 문자열을 로그에서 확인해 패턴을 맞춘다.)

- [ ] **Step 3: 재시도 소진 경로 확인**

`/tmp/relhyg-stub/gh`의 `[ "$n" -ge 3 ]`를 `[ "$n" -ge 99 ]`로 바꾸고 아래를 실행한다.

```bash
export PATH="/tmp/relhyg-stub:$PATH" GH_CONFIG_DIR=/tmp/relhyg-nogh GH_TOKEN= \
       GITHUB_REPOSITORY=owner/repo PUBLISH_RETRY_DELAYS="0 0 0 0"
command -v gh | grep -q '^/tmp/relhyg-stub/' \
  || { echo "스텁이 PATH 앞단에 없다 — 실제 gh가 공개 릴리즈를 건드린다. 중단"; exit 1; }

: > /tmp/relhyg-calls
scripts/publish-release.sh v0.7.0 /tmp/relhyg-assets; echo "exit=$?"
grep -c 'release upload' /tmp/relhyg-calls   # 5
```

Expected: `exit=1` + `재시도 소진(5회)` 출력 + `release upload` **정확히 5회**. 확인 후 스텁을 원복한다.

가드가 없으면 이 스텝은 **공개 릴리즈 에셋 파괴를 5회 반복한다**.

- [ ] **Step 4: 에셋 없음 경로 확인**

```bash
export PATH="/tmp/relhyg-stub:$PATH" GH_CONFIG_DIR=/tmp/relhyg-nogh GH_TOKEN= \
       GITHUB_REPOSITORY=owner/repo PUBLISH_RETRY_DELAYS="0 0 0 0"
command -v gh | grep -q '^/tmp/relhyg-stub/' \
  || { echo "스텁이 PATH 앞단에 없다 — 실제 gh가 공개 릴리즈를 건드린다. 중단"; exit 1; }

mkdir -p /tmp/relhyg-empty
scripts/publish-release.sh v0.7.0 /tmp/relhyg-empty; echo "exit=$?"
```

Expected: `exit=1` + `게시할 에셋이 없습니다`. (`find`가 빈 결과여도 스크립트가 죽지 않고 명시 메시지로 실패한다 = glob 안전성.)

이 스텝은 **bash 3.2 빈 배열 footgun의 가드**이기도 하다: `set -u` + bash 3.2에서 빈 배열을 `"${assets[@]}"`로 전개하면 `unbound variable`로 죽는다(`${#assets[@]}`는 안전). 스크립트가 `-gt 0` 검사를 통과한 뒤에만 전개하므로 안전한데, 출력이 의도한 한국어 메시지가 아니라 `unbound variable`이면 전개 순서가 어긋난 것이다 → 그 경우 `[ "${#assets[@]}" -gt 0 ] || { …; exit 1; }`가 모든 `"${assets[@]}"` 사용보다 **위에** 있는지 확인한다.

- [ ] **Step 5: `.github/workflows/release.yml`을 아래 내용으로 교체**

```yaml
name: release

# Windows Tauri 인스톨러(NSIS .exe + MSI) + 포터블 단일 exe(README §B, --features bundle) +
# macOS .dmg(arch별 네이티브 2개)를 빌드해 GitHub Release에 첨부.
# 트리거: v* 태그 푸시(예: v0.1.0) 또는 수동 실행(태그 입력).
#
# 구조(spec R8): preflight(버전 정합, 수 초) → windows-build / macos-build(둘 다 **빌드만**
# + upload-artifact) → publish(artifact 다운로드 → gh release). 빌드와 게시를 갈라 놓아
# GitHub API 장애로 게시가 실패해도 **실패한 publish 잡만 재실행**하면 되고(빌드 재실행 불필요,
# 18분 → 수십 초), 릴리즈 생성 레이스도 없어져 구 macos 잡의 30분 폴링이 사라졌다.
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      tag:
        description: '생성할 릴리즈 태그 (예: v0.1.0)'
        required: true

permissions:
  contents: write # 릴리즈 생성 + 에셋 업로드 + generate-notes

jobs:
  # 태그↔workspace/desktop/tauri.conf/두 락파일 정합을 빌드 **전에** 검사한다.
  # 실패 시 18분 빌드가 시작조차 하지 않고, 잘못 라벨된 에셋(v0.8.0 태그에 0.7.0 파일)이 막힌다.
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # workflow_dispatch에서 ref를 안 주면 디스패치 브랜치를 체크아웃해
          # 임의 태그를 master 매니페스트와 비교하게 된다(=이 검사가 막으려는 그 버그).
          ref: ${{ inputs.tag || github.ref }}
      - name: Check version consistency
        run: scripts/check-release-versions.sh "${{ inputs.tag || github.ref_name }}"

  windows-installer:
    needs: preflight
    runs-on: windows-latest
    # 인스톨러(desktop 워크스페이스) + 포터블 exe(루트 워크스페이스) 두 릴리즈 빌드라 cold-cache에 빠듯.
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.tag || github.ref }}

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      # rust-embed가 컴파일타임에 ui/dist를 임베드하므로 cargo 빌드 전에 먼저.
      - name: Build UI (ui/dist)
        working-directory: ui
        env:
          # Vite+Monaco+Recharts 번들이 기본 V8 old-space(~2GiB)로 OOM (deploy/Dockerfile와 동일 처방).
          NODE_OPTIONS: --max-old-space-size=4096
        run: |
          pnpm install --frozen-lockfile
          pnpm build

      # tonic-build(handicap-proto)이 빌드타임에 protoc를 요구.
      - uses: arduino/setup-protoc@v3
        with:
          repo-token: ${{ secrets.GITHUB_TOKEN }}

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
        with:
          # desktop/src-tauri는 루트 워크스페이스 밖(자체 [workspace])이라 별도 target.
          # 루트 워크스페이스는 포터블 단일 exe(--features bundle) 빌드용.
          workspaces: |
            desktop/src-tauri -> target
            . -> target

      # tagName 없이 호출 = **빌드만**(릴리즈 생성·업로드 안 함). 게시는 publish 잡이 담당.
      # id는 다음 스텝이 outputs.artifactPaths를 폴백으로 읽기 위해 필요하다.
      - name: Build Windows installers
        id: tauri
        uses: tauri-apps/tauri-action@v0
        with:
          projectPath: desktop
          args: --bundles nsis,msi

      # 포터블 단일 exe(README §B, ADR-0039 옵션 A). ui/dist는 위 UI 빌드가 이미 생성.
      - name: Build portable single exe
        run: cargo build --release -p handicap-controller --bin controller --features bundle

      # tauri-action의 artifactPaths 출력을 폴백으로 쓴다(spec R8의 plan 의무):
      # 하드코딩 경로는 Windows 러너에서만 검증 가능하고(개발기 macOS 재현 불가) 틀리면 18분째에
      # 잡이 죽는다 → ① 먼저 번들 트리를 통째로 찍어 실패 시 실제 경로가 로그에 남게 하고
      # ② 하드코딩 glob이 0개를 잡으면 artifactPaths(JSON 배열)에서 nsis/msi를 건져 복사한다.
      - name: Stage release assets
        shell: pwsh
        env:
          ARTIFACT_PATHS: ${{ steps.tauri.outputs.artifactPaths }}
        run: |
          $ErrorActionPreference = 'Stop'
          $tag = '${{ inputs.tag || github.ref_name }}'
          $ver = $tag.TrimStart('v')
          New-Item -ItemType Directory -Force -Path staging | Out-Null

          # -ErrorAction SilentlyContinue가 load-bearing: bundle 루트 자체가 이동한 경우
          # (=폴백이 존재하는 바로 그 시나리오) $ErrorActionPreference='Stop'이 이 줄을
          # 종료 예외로 만들어 아래 폴백에 도달조차 못 한다.
          # backtick 줄바꿈은 유지한다: `@( )`는 그룹 괄호와 달리 subexpression이라
          # 개행이 문장 구분자로 동작해, backtick을 빼면 `-ErrorAction …`이 별개 문장으로
          # 파싱된다(리뷰의 "괄호 안이라 불필요" 제안은 `( )`에만 해당). 검증 불가한
          # 환경(pwsh 없음)에서는 확실히 유효한 형태를 남긴다.
          Write-Host "== bundle tree (경로 오판 시 이 목록이 근거가 된다)"
          $tree = @(Get-ChildItem desktop/src-tauri/target/release/bundle -Recurse -File `
            -ErrorAction SilentlyContinue)
          if ($tree.Count -eq 0) {
            Write-Host "  (bundle 트리가 비었거나 루트 경로가 이동했다 — artifactPaths 폴백에 의존한다)"
          } else {
            $tree | Select-Object -ExpandProperty FullName
          }

          $installers = @(Get-ChildItem -Path `
            desktop/src-tauri/target/release/bundle/nsis/*.exe, `
            desktop/src-tauri/target/release/bundle/msi/*.msi -ErrorAction SilentlyContinue)

          if ($installers.Count -eq 0) {
            Write-Host "하드코딩 경로에서 인스톨러를 못 찾음 → artifactPaths 폴백"
            if (-not $env:ARTIFACT_PATHS) { throw "artifactPaths 출력도 비어 있다 — 위 트리 목록으로 경로를 고칠 것" }
            $installers = @($env:ARTIFACT_PATHS | ConvertFrom-Json |
              Where-Object { $_ -match '\.(exe|msi)$' } | ForEach-Object { Get-Item $_ })
          }
          if ($installers.Count -eq 0) { throw "인스톨러 산출물 0개" }
          $installers | ForEach-Object { Copy-Item $_.FullName staging/ }

          Copy-Item target/release/controller.exe "staging/Handicap_${ver}_x64-portable.exe"
          Get-ChildItem staging | Select-Object Name, Length

      - uses: actions/upload-artifact@v4
        with:
          name: release-assets-windows
          path: staging/
          if-no-files-found: error

  # macOS 네이티브 앱 번들(.app) + .dmg. universal(lipo) 대신 **아키텍처별 네이티브 2개**:
  # lipo로 합친 바이너리는 서명이 날아가 arm64에서 실행이 거부될 수 있다.
  # 서명/공증 없음 → 사용자는 Gatekeeper 우회 필요(README §C).
  macos-dmg:
    needs: preflight
    runs-on: macos-latest
    timeout-minutes: 90
    strategy:
      fail-fast: false # 한쪽 아키텍처가 실패해도 다른 쪽 dmg는 출하한다.
      matrix:
        target: [aarch64-apple-darwin, x86_64-apple-darwin]
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.tag || github.ref }}

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Build UI (ui/dist)
        working-directory: ui
        env:
          NODE_OPTIONS: --max-old-space-size=4096
        run: |
          pnpm install --frozen-lockfile
          pnpm build

      - uses: arduino/setup-protoc@v3
        with:
          repo-token: ${{ secrets.GITHUB_TOKEN }}

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: desktop/src-tauri -> target
          key: ${{ matrix.target }}

      # app을 dmg보다 먼저 두어, dmg 변환(bundle_dmg.sh — AppleScript)이 실패해도 .app은 남는다.
      - name: Build macOS app bundle + dmg
        uses: tauri-apps/tauri-action@v0
        with:
          projectPath: desktop
          args: --target ${{ matrix.target }} --bundles app,dmg

      # 회수용(발행 대상 아님): dmg 변환 실패 시 .app 확인.
      - name: Upload bundle as workflow artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: macos-bundle-${{ matrix.target }}
          path: desktop/src-tauri/target/${{ matrix.target }}/release/bundle/
          if-no-files-found: warn

      # 발행용: dmg만. publish 잡은 release-assets-* 패턴만 내려받는다.
      - uses: actions/upload-artifact@v4
        with:
          name: release-assets-macos-${{ matrix.target }}
          path: desktop/src-tauri/target/${{ matrix.target }}/release/bundle/dmg/*.dmg
          if-no-files-found: error

  # 게시 전담. 재실행 시 이 잡만 다시 돌면 artifact를 재사용해 수십 초에 끝난다.
  # macOS가 양쪽 다 실패해도 Windows 3종으로 발행한다(에셋 이름은 불변, 완전성은 불변식이 아니다).
  publish:
    needs: [windows-installer, macos-dmg]
    if: always() && needs.windows-installer.result == 'success'
    runs-on: ubuntu-latest
    steps:
      # 노트 파일(docs/release-notes/v<ver>.md)을 읽어야 하므로 publish도 체크아웃한다.
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.tag || github.ref }}

      - uses: actions/download-artifact@v4
        with:
          pattern: release-assets-*   # 회수용 macos-bundle-*은 제외
          merge-multiple: true
          path: staging

      - name: Publish release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
        run: scripts/publish-release.sh "${{ inputs.tag || github.ref_name }}" staging
```

- [ ] **Step 6: 워크플로 정적 검증**

```bash
python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/release.yml')); print(list(d['jobs'])); print({k:(v.get('needs'),v.get('if')) for k,v in d['jobs'].items()})"
grep -c "tagName" .github/workflows/release.yml
grep -c "ref: \${{ inputs.tag || github.ref }}" .github/workflows/release.yml
grep -n "release upload\|gh release create" .github/workflows/release.yml
```

Expected: 잡 4개(`preflight`·`windows-installer`·`macos-dmg`·`publish`) · `publish.needs == ['windows-installer','macos-dmg']` · **`tagName` 0회**(빌드 잡이 릴리즈를 만들지 않는다) · `ref:` **4회**(모든 잡) · 워크플로 안에 `gh release` 직접 호출 **0건**(스크립트 경유).

- [ ] **Step 7: 커밋**

```bash
git add scripts/publish-release.sh .github/workflows/release.yml
git commit -m "feat(ci): 릴리즈 워크플로 3-잡 분리 — preflight/build/publish + 게시 재시도 (R8)"
```

---

### Task 9: v0.6.0 릴리즈 노트 소급 (R9)

**Files:**
- Create: `docs/release-notes/v0.6.0.md`

**Interfaces:**
- Consumes: `docs/build-log.md`(원천) · Task 8의 publish 스크립트가 이 경로 규약을 읽는다
- Produces: `docs/release-notes/v<ver>.md` 포맷 선례

> **Task 9·10은 산출물이 *산문*이다** — 여기 스텝은 verbatim 본문 대신 **원천·구조·수락 기준**(필수 절, 표의 행/열, 링크, 금지 사항)을 고정한다. 릴리즈 노트 4KB를 plan에 미리 써 넣는 것은 산출물을 두 번 쓰는 것이고, 원천(build-log 단락)을 읽지 않고 쓰면 사실 오류가 들어간다. 코드 스텝의 "코드 블록 필수" 규칙이 적용되지 않는 유일한 두 task다.

- [ ] **Step 1: 원천 범위 확인**

```bash
git log --oneline v0.5.0..v0.6.0 | wc -l
gh release view v0.6.0 --json assets -q '.assets[].name'
```

Expected: 65커밋 · 에셋 **3종**(`Handicap_0.6.0_x64-portable.exe`·`_x64-setup.exe`·`_x64_en-US.msi`) — **macOS는 v0.7.0부터**이므로 다운로드 표에 dmg 행과 "macOS 첫 실행" 절을 넣지 않는다.

- [ ] **Step 2: build-log에서 해당 구간 슬라이스를 읽는다**

```bash
grep -n "trustworthy-open-test\|pair-input-blur-commit\|dynamic-vars\|scenario-notes\|genvar-preview-ux\|scenario-preflight" docs/build-log.md
```

여섯 슬라이스가 v0.5.0~v0.6.0 구간이다. 각 단락에서 **사용자가 체감하는 변화**만 추출한다(내부 리팩터·테스트·리뷰 과정은 제외).

- [ ] **Step 3: `docs/release-notes/v0.6.0.md` 작성**

v0.7.0 본문의 구조를 따른다(제목 없이 **본문만** — 제목은 릴리즈 이름이 담당). 필수 절:

1. `## 하이라이트` — 여섯 슬라이스를 사용자 관점 `###` 소제목으로. 각 항목은 "무엇이 달라졌나 → 그래서 뭐가 가능해졌나" 2~4줄.
2. `## 다운로드` — 3행 표(설치 NSIS/MSI · 포터블). 열 = `환경` / `파일` / `비고`. Linux·폐쇄망·K8s는 README 참조 한 줄.
3. `## 참고` — Windows SmartScreen 안내(서명 없음) + `v0.5.0 이후 65개 커밋` + compare 링크 `https://github.com/SeonggukJeong/handicap/compare/v0.5.0...v0.6.0` + build-log 링크.

내부 경로·호스트명·토큰류를 본문에 넣지 않는다(공개 릴리즈 본문 = 새 sink).

- [ ] **Step 4: 노트 파일이 파이프라인에 인식되는지 확인**

```bash
scripts/check-release-versions.sh v0.6.0 | tail -1
```

Expected: `notes: present (docs/release-notes/v0.6.0.md)`. (버전 검사 자체는 MISMATCH·exit 1이 정상 — 현재 트리는 0.7.0이다. 여기서 확인하는 것은 **노트 감지 한 줄**이다.)

- [ ] **Step 5: 커밋 (게시는 하지 않는다)**

```bash
git add docs/release-notes/v0.6.0.md
git commit -m "docs(release-notes): v0.6.0 소급 노트 — 사용자 관점 하이라이트+다운로드 표 (R9)"
```

**`gh release edit v0.6.0 --notes-file`을 실행하지 말 것** — 공개 레포 릴리즈 본문 변경이므로 파일 리뷰 후 **사용자 확인**을 받고 실행한다(US3 라이브 검증 단계).

---

### Task 10: 릴리즈 절차 문서 갱신 (R10)

**Files:**
- Modify: `docs/dev/tauri-desktop-build.md` (§CI 릴리즈 — `:44` 이후 블록, `:51` 이력 줄, `:53` 함정 노트)

**Interfaces:**
- Consumes: Task 6·7·8의 스크립트·레시피·잡 이름
- Produces: 릴리즈 절차 단일 소스

- [ ] **Step 1: §CI 릴리즈의 "흐름" 서술을 새 잡 그래프로 교체**

`preflight → windows-installer / macos-dmg(빌드만+artifact) → publish(release-assets-* 다운로드 → `scripts/publish-release.sh`)` 구조와, **구 30분 폴링이 사라진 이유**(릴리즈 생성이 publish 한 곳으로 모여 레이스가 없다)를 적는다.

- [ ] **Step 2: bump 절차를 `just bump-version`으로 교체**

사람이 맞추는 3개 파일(루트 `Cargo.toml`·`desktop/src-tauri/Cargo.toml`·`tauri.conf.json`) + 생성물 락 2개를 명시하고, `crates/*` 5개는 **workspace 상속이라 릴리즈마다 건드리지 않는다**고 적는다. 순서: `just bump-version <ver>` → 검토 → 커밋 → `git push origin master` → `git tag -a v<ver>` → `git push origin v<ver>`.

- [ ] **Step 3: "노트 작성"을 명시 체크 단계로 추가**

`docs/release-notes/v<ver>.md`를 bump 커밋과 **같은 커밋에** 넣는 것을 권장 단계로 적고, 없으면 `--generate-notes` 초안으로 발행된다(빈 본문은 불가)고 명시한다.

- [ ] **Step 4: 장애 시 재실행 레시피 추가**

게시만 실패한 경우 → Actions에서 **"Re-run failed jobs"**(빌드 artifact 재사용, 수십 초). 워크플로 자체가 못 뜨는 경우 → artifact를 내려받아 수동 `gh release create v<ver> <파일들>`. v0.5.0 사고(빌드 18분 후 게시 503 → 재실행이 setup-protoc에서 2분 만에 재실패)를 한 줄 근거로 남긴다.

- [ ] **Step 5: 릴리즈 이력 줄에 v0.5.0·v0.6.0 채우기 + `desktop` 락 함정 노트 갱신**

**줄번호로 찾지 말 것** — Step 1~4가 같은 §CI 릴리즈 영역(원래 `:44`–`:53`)을 편집해 번호가 이미 밀렸다. **내용으로** 찾는다:

- `grep -n "이 절차로 발행됨" docs/dev/tauri-desktop-build.md`로 이력 나열 문장을 찾아 `v0.5.0(2026-07-20)`·`v0.6.0(2026-07-25)`를 시간순 위치에 추가(현재 누락 — v0.4.0 다음에 v0.7.0이 온다).
- `grep -n 'name = "desktop"' docs/dev/tauri-desktop-build.md`로 stale-lock 함정 노트를 찾아 끝에 "이제 `scripts/check-release-versions.sh`가 태그 push 전/preflight에서 기계로 검사한다(검사 #5)" 한 줄 추가.

- [ ] **Step 6: 커밋**

```bash
git add docs/dev/tauri-desktop-build.md
git commit -m "docs(dev): CI 릴리즈 절차 갱신 — 3-잡 그래프·bump 헬퍼·노트 단계·재실행 레시피 (R10)"
```

---

## 파이프라인 마무리 (task 아님 — orchestrator 담당)

1. **최종 whole-branch 리뷰**: `handicap-reviewer`(model: opus) — BASE는 **Task 1 디스패치 직전 커밋**(`HEAD~1` 금지). 교차-task 상호작용(Zod↔serde 와이어 1:1·R11 불변·deferral 추적)을 본다.
2. **보안 표면 게이트**: `finish-slice §0`의 grep을 **직접 실행**한다(예측으로 스킵 금지). N/A여도 판단 재검토 2건: ① `/api/version` 응답이 `version` 한 필드뿐인가 ② `docs/release-notes/v0.6.0.md`에 내부 경로·호스트명·토큰류가 없는가.
3. **라이브 검증**: Task 5 Step 12(US1·US1'·US2). US3은 사용자 확인 후 `gh release edit v0.6.0 --notes-file`. US4·US5는 Task 6·8의 로컬 스텁·양방향 실행으로 대체 증명(spec §라이브 검증 표).
4. **bundle 수동 게이트 재확인**: `cargo build/clippy -p handicap-controller --features bundle` + **필터 없는** `cargo test -p handicap-controller --features bundle`(`in_process.rs`는 pre-commit이 컴파일하지 않는다).
5. **`/finish-slice`**: build-log 단락(증명된 US / 못 한 US 한 줄 포함)·roadmap-status frontier 전진(§B24·§B25 완료 표기)·CLAUDE 상태줄 교체·메모리 → ff-merge → `ExitWorktree`.

## 리뷰 이력 (spec-plan-reviewer, 2026-07-30)

- **spec**: 3라운드 · 28 findings 종결 → clean `APPROVE`. 라운드마다 **직전 fix가 만든 새 결함**을 잡았다(원안 → "로그 4곳으로 못 박기"가 데스크톱 채널 배제[N1] → 그 보강이 게이트 밖 bundle 코드를 건드림[P1]).
- **plan**: 2라운드 · G1/G2/F1–F7 + H1/H2 종결 → clean `APPROVE`. 리뷰어가 인라인 코드를 **실행**해 검증(awk 파서 14/14 타깃 · python 스플라이스 · just shebang dedent · 재시도 3·5회 카운트 · 노트 4분기 · bash 3.2 빈 배열 · `tauri-action` `artifactPaths` 상류 사실 2건).
- **H1은 G2 수정이 만든 blocker였다**: 스텁 호출이 4개 블록으로 늘어나며 Bash 툴의 셸-상태 비영속성 때문에 실제 `gh`가 공개 릴리즈를 파괴할 수 있었다 → 3층 가드로 종결(리터럴 경로 + fail-closed + 인증 무력화, 후자는 실측으로 exit 4 확인).
- **구현으로 넘기는 미결 1건**(설계상 의도): Task 7 Step 3이 **어느 락 재생성 명령이 두 락을 갱신하는지** 실측으로 확정해야 한다(spec N2의 결과-기반 수락). Task 1 Step 5가 교차 참조한다. 리뷰로는 사전 해결 불가.
- 비차단 제안 1건 **기각**: pwsh `@( )` 안의 backtick 줄바꿈 제거 — `@( )`는 subexpression이라 개행이 문장 구분자다(그룹 괄호 `( )`와 다르다). pwsh 미설치로 실증 불가한 환경에서는 확실히 유효한 형태를 유지한다. 근거를 코드 주석에 남겼다.

REVIEW-GATE: APPROVED
