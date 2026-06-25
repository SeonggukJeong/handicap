# Tauri in-process controller backend — Slice 1 (백엔드 lib) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** controller를 별도 lib 진입점 `run_in_process()`로 in-process 구동·graceful 종료할 수 있게 만들고(전부 `#[cfg(feature="bundle")]` gated), 워커가 컨트롤러 연결 끊김(하드 크래시)에도 좀비 부하를 멈추도록 cross-platform disconnect-cancel을 추가한다. desktop 셸 교체(Slice 2)는 이 backend 경계를 소비만 한다.

**Architecture:** bundle `controller` 바이너리의 부트스트랩(현 `main.rs` 137–404)을 라이브러리 함수 `run_in_process(InProcessConfig) -> RunningController`로 추출한다(비-bundle 인라인 경로와 의도적으로 중복 — byte-identical 보존). `RunningController`는 `rest_addr()`/`grpc_addr()`/`join()`/`shutdown()`를 제공하고, `shutdown()`은 활성 run abort → `CancellationToken` 취소(axum/tonic graceful + scheduler/heartbeat 정지) → **bounded drain**(절대 무한 대기 안 함)을 한다. 워커 쪽 R4b는 abort-listener 루프를 추출해 "명시적 Abort 없이 인바운드 스트림이 닫혀도 취소"하게 만든다(always-compiled, 크로스플랫폼 하드-크래시 백스톱).

**Tech Stack:** Rust(edition 2024), tokio(full) + tokio-util(`CancellationToken`, 기존 dep), axum graceful shutdown, tonic `serve_with_incoming_shutdown`, sqlx(SQLite), anyhow.

## Global Constraints

스펙 `docs/superpowers/specs/2026-06-26-tauri-in-process-backend-design.md`의 프로젝트-전역 요구. 모든 task에 암묵 적용:

- **R1 — 신규 진입점은 lib에.** controller crate에 `run_in_process`/`RunningController`/`InProcessConfig`/`SettingsSeeds` 공개 API를 추가한다(바이너리가 아니라 라이브러리).
- **R5 — bundle byte-identical.** 신규 in-process 심볼은 **전부 `#[cfg(feature="bundle")]` gated**(워커 R4b 변경은 예외 — additive·always-compiled). 비-bundle `controller` 바이너리는 동작·심볼 불변. "byte-identical"의 검증 = 비-bundle `cargo build/clippy/nextest -p handicap-controller` green + `main.rs`의 비-bundle `tokio::try_join!(rest_fut, grpc_fut)` 경로 텍스트 무변경. (리터럴 바이너리 diff가 아니라 *동작·심볼 불변* 의미 — repo 관행의 "byte-identical-off".)
- **R6 — 동일 함수가 standalone bundle exe도 구동.** `run_in_process`는 `main.rs` bundle 부트스트랩을 그대로 재현한다(scheduler·heartbeat-reaper 배선 포함). in-process 설정상 `worker_mode = Subprocess` 고정이라 `is_pool_mode()`가 런타임에 false → heartbeat-reaper 태스크는 실제로 안 뜨지만, `if coord_state.is_pool_mode()` 배선 자체는 충실히 둔다(wired-but-dormant).
- **R7 — clap `Cmd::Worker` arm 보존.** Slice 1은 `main.rs`의 멀티콜 워커 arm(`controller worker …`)을 그대로 둔다(byte-identical).
- **R8 — tracing init은 호출자 소유.** `run_in_process`는 `tracing_subscriber` init을 호출하지 않는다(`main.rs`·desktop 셸이 각자 init).
- **R9 — engine/proto/migration 0-diff.** `crates/engine`·`crates/proto`·`crates/controller/migrations`·`crates/worker` proto 와이어 무변경. 워커 R4b는 `crates/worker/src/lib.rs` 로직만 바꾼다(proto 무변경).
- **§6 — `shutdown()`은 절대 무한 hang 금지.** `abort_all`은 gRPC Abort를 **send-only**로 보내고 스트림 close를 await하지 않으므로 graceful drain이 hang할 잔여 윈도우가 있다. 따라서 `shutdown()`은 graceful drain을 **bounded deadline**으로 감싼다. **고정값: 타임아웃 = 5초, 초과 시 hard-stop = serve JoinHandle `abort()`.** "shutdown()이 절대 hang 안 한다"가 acceptance.
- **보안 — `worker_token` 로그 누출 금지.** 토큰을 담는 구조체를 `?args`/`{:?}`로 통째 덤프하지 말 것(`main.rs:91`의 SECURITY 주석 정신). 로깅은 명시 필드 + `worker_token_set: bool`만.
- **bundle 코드는 pre-commit 게이트가 안 본다.** `#[cfg(feature="bundle")]` 코드는 pre-commit의 비-bundle `cargo` 게이트에 안 잡힌다. Task 2–4 커밋 **전** 수동으로:
  ```bash
  cd /Users/sgj/develop/handicap/.claude/worktrees/tauri-in-process
  cargo build  -p handicap-controller --features bundle
  cargo clippy -p handicap-controller --features bundle --all-targets -- -D warnings
  cargo nextest run -p handicap-controller --features bundle    # 필터 금지 — 풀 bundle 스위트
  ```
  (rust-embed가 컴파일 타임에 `ui/dist`를 읽으므로 bundle 빌드 전 `ui/dist`가 있어야 한다 — 없으면 `cd ui && pnpm build` 1회.)
- **TDD 가드 keepalive.** tdd-guard는 *test-path 파일*(`tests/*.rs` 등)만 pending으로 친다. Task 2가 **새 src 파일** `crates/controller/src/in_process.rs`를 처음 Write할 때 디스크에 pending test-path가 없으면 막힌다 → orchestrator가 디스패치 전 `crates/controller/tests/_tdd_keepalive.rs`(`#[test] fn k(){}`)를 깔아 unblock하고, implementer에는 **명시 경로 `git add`만**(절대 `-A` 금지) 시킨 뒤 task 끝나면 `rm`(커밋 안 됨). Task 1·3·4는 기존 인라인 `#[cfg(test)] mod tests` 파일을 편집하므로 keepalive 불요(Task 1 worker lib·Task 3/4 controller in_process.rs는 Task 2 이후 이미 인라인 test 보유). 안전하게 Task 1 디스패치 전에도 keepalive를 깔아두면 무해.
- **커밋 규율.** `git commit`은 파이프 없이(`| tail`/`| head` 금지 — exit code 마스킹). 스테이징은 명시 경로, 커밋 후 `git log -1`로 landed 확인. `--no-verify` 금지.

---

## File Structure

| 파일 | 책임 | task |
|---|---|---|
| `crates/worker/src/lib.rs` | abort-listener 루프 추출(`abort_listener_loop`) + disconnect-cancel(R4b) + 3 단위 테스트. **always-compiled.** | 1 |
| `crates/controller/src/in_process.rs` (신규) | `SettingsSeeds`/`InProcessConfig`/`bounded_drain`/`abort_all`/`run_in_process`/`RunningController`. **모듈 전체 bundle-gated**(lib.rs decl에서). | 2,3 |
| `crates/controller/src/lib.rs` | `#[cfg(feature="bundle")] pub mod in_process;` 1줄 추가. | 2 |
| `crates/controller/src/main.rs` | bundle 부트스트랩(137–404)을 `run_bundle` → `run_in_process` 위임으로 교체. 비-bundle `try_join!` 경로 byte-identical. | 4 |

모듈 전체를 `lib.rs` decl 한 곳에서 `#[cfg(feature="bundle")]` gate하므로 `in_process.rs` 내부 아이템엔 per-item cfg가 **불필요**하다(인라인 `#[cfg(test)] mod tests`도 부모 모듈이 이미 gated라 bundle 빌드에서만 컴파일·테스트된다).

---

## Task 1: 워커 disconnect-cancel (R4b) — always-compiled

**Files:**
- Modify: `crates/worker/src/lib.rs` (abort-listener 클로저 → `abort_listener_loop` 추출 + 인바운드 close 취소)
- Test: `crates/worker/src/lib.rs` 인라인 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: (없음 — 기존 `pb::ServerMessage`, `pb::server_message::Payload as ServerPayload`, `pb::AbortRun`, `tokio::sync::mpsc`, `tokio_util::sync::CancellationToken` 전부 이미 import됨)
- Produces: `pub(crate) async fn abort_listener_loop(inbound_rx: mpsc::Receiver<pb::ServerMessage>, run_id: String, cancel: CancellationToken)` — 명시적 Abort 수신 또는 인바운드 스트림 close 시 `cancel.cancel()`. (Task 2–4는 이 fn을 사용하지 않음 — 워커 내부 전용. 별도 task인 이유는 독립 green 커밋 + 별도 리뷰 게이트.)

**배경(스펙 §4.2):** 현재 abort-listener는 인바운드 스트림에서 `Abort`만 감시하고, *명시적 Abort 없이 스트림이 닫히면*(컨트롤러 크래시·연결 끊김) 그냥 루프를 빠져나가 취소하지 **않는다** → 좀비 부하 잔존. R4b는 그 close-without-abort 경로도 취소한다. 정상 완료 경로는 호출부가 listener를 `abort()`로 *먼저* 죽이므로(현 코드 `abort_listener.abort(); abort_listener.await.ok();`) 오탐이 없다.

- [ ] **Step 1: 추출 대상 클로저 확인**

`crates/worker/src/lib.rs`에서 abort-listener spawn 지점을 읽는다(현재 ~407–419):

```rust
let cancel_for_listener = run_cancel.clone();
let abort_run_id = run_id.clone();
let abort_listener = tokio::spawn(async move {
    while let Some(msg) = inbound_rx.recv().await {
        if let Some(ServerPayload::Abort(a)) = msg.payload {
            if a.run_id == abort_run_id {
                info!(run_id = %abort_run_id, reason = %a.reason, "abort signal received");
                cancel_for_listener.cancel();
                break;
            }
        }
    }
});
```

정확한 줄번호·바인딩명(`run_cancel`/`run_id`/`inbound_rx`)을 실제 파일에서 확인한다(컨텍스트에 따라 약간 다를 수 있음). `inbound_rx`의 타입이 `mpsc::Receiver<pb::ServerMessage>`인지, `mpsc`/`ServerPayload`/`CancellationToken`/`info` import가 이미 있는지 확인(있음).

- [ ] **Step 2: 실패 테스트 3개 작성**

`crates/worker/src/lib.rs`의 인라인 `#[cfg(test)] mod tests`(현재 ~639) 끝에 추가. (`use super::*`가 `abort_listener_loop`·`mpsc`·`CancellationToken`·`pb`·`ServerPayload`를 가져온다. 워크스페이스 tokio는 `full`이라 `#[tokio::test]` 사용 가능.)

```rust
#[tokio::test]
async fn abort_listener_explicit_abort_cancels() {
    let (tx, rx) = mpsc::channel::<pb::ServerMessage>(4);
    let cancel = CancellationToken::new();
    let h = tokio::spawn(abort_listener_loop(rx, "run-1".to_string(), cancel.clone()));
    tx.send(pb::ServerMessage {
        payload: Some(ServerPayload::Abort(pb::AbortRun {
            run_id: "run-1".to_string(),
            reason: "user".to_string(),
        })),
    })
    .await
    .unwrap();
    h.await.unwrap();
    assert!(cancel.is_cancelled());
}

#[tokio::test]
async fn abort_listener_inbound_close_cancels() {
    // R4b: 컨트롤러 크래시 시뮬레이션 — 명시적 Abort 없이 송신자 drop으로 스트림 close.
    let (tx, rx) = mpsc::channel::<pb::ServerMessage>(4);
    let cancel = CancellationToken::new();
    let h = tokio::spawn(abort_listener_loop(rx, "run-1".to_string(), cancel.clone()));
    drop(tx);
    h.await.unwrap();
    assert!(cancel.is_cancelled());
}

#[tokio::test]
async fn abort_listener_aborted_before_close_no_false_positive() {
    // 정상 완료 경로: 호출부가 listener를 먼저 abort → 그 뒤 스트림이 닫혀도 취소 안 됨.
    let (tx, rx) = mpsc::channel::<pb::ServerMessage>(4);
    let cancel = CancellationToken::new();
    let h = tokio::spawn(abort_listener_loop(rx, "run-1".to_string(), cancel.clone()));
    h.abort();
    let _ = h.await;
    drop(tx);
    tokio::task::yield_now().await;
    assert!(!cancel.is_cancelled());
}
```

`pb::AbortRun`/`pb::ServerMessage`의 정확한 필드명(`run_id`/`reason`, `payload`)은 `crates/proto`에서 확인(스펙 §4.2 기준 위와 같음). `pb` 별칭이 tests 모듈에서 `super::*`로 들어오는지 확인 — 안 들어오면 `use crate::pb;` 또는 실제 별칭 경로 추가.

- [ ] **Step 3: 실패 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/tauri-in-process
cargo test -p handicap-worker abort_listener_ --no-run
```
Expected: 컴파일 FAIL — `cannot find function abort_listener_loop in this scope`.

- [ ] **Step 4: `abort_listener_loop` 추출 + disconnect-cancel 구현**

`run`/`run_pool`이 공유하는 `execute_assignment`(또는 abort-listener가 사는 함수) 밖, 모듈 레벨에 자유 함수를 추가한다:

```rust
/// 인바운드 서버 스트림에서 이 run의 Abort 신호를 감시한다.
/// - 명시적 `Abort`(run_id 일치) 수신 → 취소하고 반환.
/// - 명시적 Abort 없이 스트림이 닫힘(컨트롤러 크래시/연결 끊김) → **그것도 취소**한다
///   (R4b: cross-platform 하드-크래시 백스톱 — 워커가 좀비 부하를 계속 돌리지 않게).
///
/// 정상 완료 경로에선 호출부가 이 태스크를 `abort()`로 먼저 죽이므로(스트림 close 관찰 전)
/// close-without-abort 취소가 오탐을 내지 않는다. 호출부가 시나리오 완료(lib.rs:427) 직후
/// listener를 abort(lib.rs:430)하는 그 찰나에 스트림이 닫혀 `cancel()`이 발화하더라도
/// **benign-by-construction** — 시나리오는 이미 끝났으니 늦은 취소는 no-op이고, 풀은
/// reconnect-per-run이라 run마다 새 `link`/`inbound_rx`를 받아 stale-channel 누수가 없다.
pub(crate) async fn abort_listener_loop(
    mut inbound_rx: mpsc::Receiver<pb::ServerMessage>,
    run_id: String,
    cancel: CancellationToken,
) {
    while let Some(msg) = inbound_rx.recv().await {
        if let Some(ServerPayload::Abort(a)) = msg.payload {
            if a.run_id == run_id {
                info!(run_id = %run_id, reason = %a.reason, "abort signal received");
                cancel.cancel();
                return;
            }
        }
    }
    // 스트림이 명시적 Abort 없이 닫힘 = 컨트롤러 연결 끊김(크래시). 좀비 run 방지 취소.
    info!(
        run_id = %run_id,
        "inbound stream closed without abort — cancelling run (controller disconnect)"
    );
    cancel.cancel();
}
```

그리고 기존 spawn 지점(Step 1)을 다음으로 교체한다:

```rust
let abort_listener = tokio::spawn(abort_listener_loop(
    inbound_rx,
    run_id.clone(),
    run_cancel.clone(),
));
```

(기존 `cancel_for_listener`/`abort_run_id` 임시 바인딩은 fn 인자로 흡수되므로 제거. `inbound_rx`는 fn으로 move됨 — 이후 다른 사용처가 없는지 확인.) 정상-완료 teardown(`abort_listener.abort(); abort_listener.await.ok();`)은 **그대로 둔다** — 이게 오탐 방지의 핵심.

- [ ] **Step 5: 통과 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/tauri-in-process
cargo test -p handicap-worker abort_listener_
```
Expected: 3 PASS.

- [ ] **Step 6: 워커 전체 회귀 확인**

```bash
cargo build -p handicap-worker
cargo test -p handicap-worker
cargo clippy -p handicap-worker --all-targets -- -D warnings
```
Expected: 전부 green(기존 워커 테스트 + 신규 3개).

- [ ] **Step 7: 커밋**

```bash
git add crates/worker/src/lib.rs
git commit -m "feat(worker): cancel run on inbound stream close (R4b cross-platform crash backstop)"
git log -1
```

---

## Task 2: in-process leaf helpers — `SettingsSeeds`/`InProcessConfig`/`bounded_drain`/`abort_all`

**Files:**
- Create: `crates/controller/src/in_process.rs`
- Modify: `crates/controller/src/lib.rs` (`#[cfg(feature="bundle")] pub mod in_process;` 추가)
- Test: `crates/controller/src/in_process.rs` 인라인 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `crate::store::{Db, connect, url_from_path}`; `crate::grpc::coordinator::{CoordinatorState (new(Db), abort(&str)->bool), DEFAULT_WORKER_CAPACITY_VUS}`. (`DEFAULT_WORKER_CAPACITY_VUS`는 `grpc/coordinator.rs:30`의 `pub const … : u32 = 2000` — `settings.rs`는 그걸 *re-import*만 하지 re-export 안 하므로 `crate::settings::…` 경로는 컴파일 안 된다. `SettingsState`는 Task 2가 안 쓴다 — Task 3에서 import.)
- Produces (Task 3·4가 의존):
  - `pub struct SettingsSeeds { pub worker_capacity_vus: u32, pub dataset_max_rows: u64, pub scheduler_tick_seconds: u64, pub pool_heartbeat_interval_seconds: u64, pub pool_stale_timeout_seconds: u64, pub pool_keepalive_seconds: u64, pub run_startup_grace_seconds: u64, pub run_backstop_grace_seconds: u64 }` + `impl Default` + `fn to_seed_array(&self) -> [(&'static str, i64); 8]`. 전부 `Clone`.
  - `pub struct InProcessConfig { pub db: Option<String>, pub rest: SocketAddr, pub grpc: SocketAddr, pub worker_token: Option<String>, pub scheduler_disabled: bool, pub scheduler_timezone: String, pub settings_seeds: SettingsSeeds }` + `impl Default`(`rest`/`grpc` = `127.0.0.1:0`, `scheduler_timezone` = `"Asia/Seoul"`).
  - `async fn bounded_drain(handle: tokio::task::JoinHandle<()>, timeout: Duration) -> bool` — 시간 내 완료 시 `true`, 초과 시 `handle.abort()` 후 `false`.
  - `pub async fn abort_all(coord: &CoordinatorState, db: &Db) -> anyhow::Result<usize>` — `status IN ('pending','running')` run id를 조회해 각각 `coord.abort(id)`(no-op 허용), 카운트 반환.
  - `const GRACEFUL_DRAIN_TIMEOUT: Duration = Duration::from_secs(5)`.

**주의:** orchestrator는 이 task 디스패치 전 `crates/controller/tests/_tdd_keepalive.rs`(`#[test] fn k(){}`)를 깔아 새 src 파일 Write를 unblock하고, implementer에 "끝나면 `rm crates/controller/tests/_tdd_keepalive.rs`, `git add`는 명시 경로만"을 지시.

- [ ] **Step 1: 모듈 등록 + 빈 스캐폴드**

`crates/controller/src/lib.rs`에서 `#[cfg(feature = "bundle")] pub mod bundle;` 근처에 추가:

```rust
#[cfg(feature = "bundle")]
pub mod in_process;
```

`crates/controller/src/in_process.rs` 생성, 상단 import:

```rust
//! controller in-process 구동 진입점(bundle 전용). `main.rs` bundle 부트스트랩을
//! 라이브러리로 추출한 것 — desktop 셸(Slice 2)·standalone bundle exe가 함께 쓴다.

use std::net::SocketAddr;
use std::time::Duration;

use anyhow::Context;

use crate::grpc::coordinator::{CoordinatorState, DEFAULT_WORKER_CAPACITY_VUS};
use crate::store::{self, Db};

const GRACEFUL_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
```

> **import 최소화(중요 — `-D warnings`라 unused import는 빌드 실패):** Task 2가 *실제로* 쓰는 것만 import한다. 위 블록이 그 최소 집합이다 — `SocketAddr`(InProcessConfig.rest/grpc), `Duration`(timeout+bounded_drain), `Context`(abort_all), `CoordinatorState`(abort_all 인자+테스트), `DEFAULT_WORKER_CAPACITY_VUS`(SettingsSeeds::default+테스트), `store::{self, Db}`. `sqlx`/`tempfile`은 코드에서 fully-qualified(`sqlx::query_scalar`/`tempfile::tempdir`)로 쓰므로 `use` 불필요. `Arc`/`Mutex`/`CancellationToken`/`TcpListener`/`TcpListenerStream`/`CoordinatorService`/`CoordinatorServer`/`SettingsState`/`app`/`SubprocessDispatcher`/`info`/`warn`는 **Task 3에서 추가**(Task 2는 안 씀).
>
> **`DEFAULT_WORKER_CAPACITY_VUS` 경로(리뷰 적발):** `crate::grpc::coordinator`에 `pub const … : u32 = 2000`로 정의돼 있다(`settings.rs`는 *re-import*만 하지 re-export 안 하므로 `crate::settings::DEFAULT_WORKER_CAPACITY_VUS`는 컴파일 안 됨). 위 import 경로(`crate::grpc::coordinator::{… , DEFAULT_WORKER_CAPACITY_VUS}`)를 그대로 쓸 것.

- [ ] **Step 2: 실패 테스트 작성 (seed 매핑 + bounded_drain + abort_all)**

`in_process.rs` 끝에:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_seeds_default_maps_keys_and_values() {
        let arr = SettingsSeeds::default().to_seed_array();
        assert_eq!(arr.len(), 8);
        assert_eq!(arr[0], ("worker_capacity_vus", DEFAULT_WORKER_CAPACITY_VUS as i64));
        assert_eq!(arr[2], ("scheduler_tick_seconds", 30));
        assert_eq!(arr[3], ("pool_heartbeat_interval_seconds", 10));
        assert_eq!(arr[4], ("pool_stale_timeout_seconds", 30));
        assert_eq!(arr[5], ("pool_keepalive_seconds", 20));
        assert_eq!(arr[6], ("run_startup_grace_seconds", 90));
        assert_eq!(arr[7], ("run_backstop_grace_seconds", 120));
    }

    #[test]
    fn in_process_config_default_binds_ephemeral_localhost() {
        let c = InProcessConfig::default();
        assert_eq!(c.rest.ip().to_string(), "127.0.0.1");
        assert_eq!(c.rest.port(), 0);
        assert_eq!(c.grpc.port(), 0);
        assert_eq!(c.scheduler_timezone, "Asia/Seoul");
        assert!(c.db.is_none());
        assert!(c.worker_token.is_none());
        assert!(!c.scheduler_disabled);
    }

    #[tokio::test]
    async fn bounded_drain_returns_true_when_task_finishes() {
        let h = tokio::spawn(async {});
        assert!(bounded_drain(h, Duration::from_secs(5)).await);
    }

    #[tokio::test]
    async fn bounded_drain_hard_stops_on_timeout() {
        // pending 태스크 → 타임아웃 → hard-stop. 테스트가 끝난다는 것 자체가 hang 안 함의 증거.
        let h = tokio::spawn(std::future::pending::<()>());
        assert!(!bounded_drain(h, Duration::from_millis(50)).await);
    }

    #[tokio::test]
    async fn abort_all_counts_active_runs_and_tolerates_absent_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let db_url = store::url_from_path(&tmp.path().join("a.db").display().to_string());
        let db = store::connect(&db_url).await.unwrap();
        insert_active_run(&db, "run-a", "running").await;
        insert_active_run(&db, "run-b", "pending").await;
        insert_active_run(&db, "run-c", "completed").await; // 비활성 → 카운트 제외
        let coord = CoordinatorState::new(db.clone());
        // 워커 등록 안 함 → 활성 run 모두 in-memory 엔트리 없음 → abort()는 false지만 에러 아님.
        let n = abort_all(&coord, &db).await.unwrap();
        assert_eq!(n, 2);
    }

    async fn insert_active_run(db: &Db, id: &str, status: &str) {
        sqlx::query(
            "INSERT INTO runs(id,scenario_id,scenario_yaml,profile_json,env_json,status,created_at) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind(id)
        .bind("scn-1")
        .bind("version: 1\nsteps: []\n")
        .bind(r#"{"duration_seconds":1}"#)
        .bind("{}")
        .bind(status)
        .bind(0_i64)
        .execute(db)
        .await
        .unwrap();
    }
}
```

(`tempfile`은 controller `[dev-dependencies]`에 있음. `sqlx`는 normal dep. `runs` 테이블 컬럼은 `crate::store::runs::insert`의 INSERT(`id,scenario_id,scenario_yaml,profile_json,env_json,status,created_at`)와 일치 — 실제 스키마와 어긋나면 `crates/controller/src/store/runs.rs`에서 확인해 맞출 것.)

- [ ] **Step 3: 실패 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/tauri-in-process
cargo test -p handicap-controller --features bundle in_process:: --no-run
```
Expected: 컴파일 FAIL — `SettingsSeeds`/`InProcessConfig`/`bounded_drain`/`abort_all` not found.

- [ ] **Step 4: leaf 심볼 구현**

`in_process.rs`의 `const GRACEFUL_DRAIN_TIMEOUT` 아래, `mod tests` 위에:

```rust
/// `SettingsState::build`에 넘길 8개 런타임 설정의 CLI-기본 시드.
/// 필드명·기본값은 `main.rs` `ControllerArgs`의 `default_value_t`와 1:1.
#[derive(Debug, Clone)]
pub struct SettingsSeeds {
    pub worker_capacity_vus: u32,
    pub dataset_max_rows: u64,
    pub scheduler_tick_seconds: u64,
    pub pool_heartbeat_interval_seconds: u64,
    pub pool_stale_timeout_seconds: u64,
    pub pool_keepalive_seconds: u64,
    pub run_startup_grace_seconds: u64,
    pub run_backstop_grace_seconds: u64,
}

impl Default for SettingsSeeds {
    fn default() -> Self {
        Self {
            worker_capacity_vus: DEFAULT_WORKER_CAPACITY_VUS,
            dataset_max_rows: 1_000_000,
            scheduler_tick_seconds: 30,
            pool_heartbeat_interval_seconds: 10,
            pool_stale_timeout_seconds: 30,
            pool_keepalive_seconds: 20,
            run_startup_grace_seconds: 90,
            run_backstop_grace_seconds: 120,
        }
    }
}

impl SettingsSeeds {
    /// `SettingsState::build(&overrides, &seeds)`가 받는 `(key, i64)` 시드 슬라이스.
    /// R5c stale-clamp는 build 호출 *전*에 raw 시드에 대해 별도로 처리하므로 여기선 raw 값만.
    ///
    /// 주의(리뷰 적발): `scheduler_tick_seconds`·`pool_keepalive_seconds`는 `SETTINGS`
    /// 레지스트리에 **readonly(`mutable:false`)** 항목이라(settings.rs:144/154) `build`가
    /// 가변 스냅샷이 아니라 `readonly` 표시값으로만 보관한다(settings.rs:252). 결정 지점은
    /// settings 스냅샷이 아니라 `SettingsSeeds` 필드에서 **직접** 읽는다(run_in_process §8
    /// scheduler tick·§11 keepalive·가변 accessor 부재). main.rs:272/275도 같은 8키를
    /// 넘기므로 parity 유지 — 미래 독자가 "죽은 시드"로 오인해 제거하지 않도록 8키를 그대로 둔다.
    fn to_seed_array(&self) -> [(&'static str, i64); 8] {
        [
            ("worker_capacity_vus", self.worker_capacity_vus as i64),
            ("dataset_max_rows", self.dataset_max_rows as i64),
            ("scheduler_tick_seconds", self.scheduler_tick_seconds as i64),
            ("pool_heartbeat_interval_seconds", self.pool_heartbeat_interval_seconds as i64),
            ("pool_stale_timeout_seconds", self.pool_stale_timeout_seconds as i64),
            ("pool_keepalive_seconds", self.pool_keepalive_seconds as i64),
            ("run_startup_grace_seconds", self.run_startup_grace_seconds as i64),
            ("run_backstop_grace_seconds", self.run_backstop_grace_seconds as i64),
        ]
    }
}

/// in-process controller 구동 설정. `db: None` → dirs data-local-dir의 기본 DB,
/// `rest`/`grpc` 기본 `127.0.0.1:0`(OS가 빈 포트 할당). **고정: worker_mode = Subprocess, ui_dir = None.**
#[derive(Debug, Clone)]
pub struct InProcessConfig {
    pub db: Option<String>,
    pub rest: SocketAddr,
    pub grpc: SocketAddr,
    pub worker_token: Option<String>,
    pub scheduler_disabled: bool,
    pub scheduler_timezone: String,
    pub settings_seeds: SettingsSeeds,
}

impl Default for InProcessConfig {
    fn default() -> Self {
        Self {
            db: None,
            rest: SocketAddr::from(([127, 0, 0, 1], 0)),
            grpc: SocketAddr::from(([127, 0, 0, 1], 0)),
            worker_token: None,
            scheduler_disabled: false,
            scheduler_timezone: "Asia/Seoul".to_string(),
            settings_seeds: SettingsSeeds::default(),
        }
    }
}

/// serve 태스크를 graceful drain하되 **절대 무한 대기하지 않는다**(스펙 §6).
/// `timeout` 내 완료 → `true`. 초과 → 태스크를 hard-abort하고 `false`.
/// (JoinHandle을 그냥 drop하면 detach될 뿐 abort되지 않으므로 명시적 `abort()` 필요.)
async fn bounded_drain(mut handle: tokio::task::JoinHandle<()>, timeout: Duration) -> bool {
    match tokio::time::timeout(timeout, &mut handle).await {
        Ok(_) => true,
        Err(_) => {
            handle.abort();
            let _ = handle.await;
            false
        }
    }
}

/// 활성(`pending`/`running`) run에 in-memory Abort를 보낸다(send-only).
/// `coord.abort(id)`는 in-memory 워커 엔트리가 없으면 `false`를 돌려주는데(아직 미등록 pending 등)
/// 이는 **no-op이지 에러가 아니다** — 그런 run은 워커 self-cancel(R4b)·다음 startup
/// `mark_orphans_failed`(R4c)가 커버한다. 반환값은 활성 run 개수.
pub async fn abort_all(coord: &CoordinatorState, db: &Db) -> anyhow::Result<usize> {
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM runs WHERE status IN ('pending','running')")
            .fetch_all(db)
            .await
            .context("query active run ids")?;
    for id in &ids {
        let _ = coord.abort(id).await;
    }
    Ok(ids.len())
}
```

- [ ] **Step 5: 통과 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/tauri-in-process
cargo test -p handicap-controller --features bundle in_process::
```
Expected: 5 PASS(seed 매핑·config default·bounded_drain ×2·abort_all). seed 매핑 테스트가 빨갛게 나면 `to_seed_array` 인덱스 순서를, abort_all이 빨갛게 나면 `runs` 컬럼명을 실제 스키마와 대조.

- [ ] **Step 6: bundle 게이트 풀 통과 + keepalive 제거**

```bash
cargo build  -p handicap-controller --features bundle
cargo clippy -p handicap-controller --features bundle --all-targets -- -D warnings
cargo nextest run -p handicap-controller --features bundle
rm -f crates/controller/tests/_tdd_keepalive.rs
```
Expected: 전부 green. (unused import 경고 = `-D warnings` 실패 → Task 3용 import를 미리 넣지 말 것.)

- [ ] **Step 7: 커밋**

```bash
git add crates/controller/src/in_process.rs crates/controller/src/lib.rs
git commit -m "feat(controller): in-process leaf helpers (SettingsSeeds/InProcessConfig/bounded_drain/abort_all, bundle-gated)"
git log -1
```

(`_tdd_keepalive.rs`는 Step 6에서 `rm`했으므로 `git add`에 안 걸린다 — 혹시 남았으면 `git status`로 확인 후 제외.)

---

## Task 3: `run_in_process` + `RunningController` 조립

**Files:**
- Modify: `crates/controller/src/in_process.rs` (조립 함수 + 구조체 + import 보강)
- Test: `crates/controller/src/in_process.rs` 인라인 `#[cfg(test)] mod tests` (health-serve + shutdown 통합 테스트)

**Interfaces:**
- Consumes (Task 2): `SettingsSeeds::to_seed_array`, `InProcessConfig`, `bounded_drain`, `abort_all`, `GRACEFUL_DRAIN_TIMEOUT`. 그리고 `crate::launch::{resolve_db_path, app_data_dir, bind_with_fallback}`(std `TcpListener` 반환, `set_nonblocking` 미설정), `crate::store::{connect, url_from_path, runs::mark_orphans_failed}`, `crate::settings::SettingsState::build`, `crate::app::{router, AppState}`, `crate::dispatcher::{SharedDispatcher, subprocess::SubprocessDispatcher}`, `crate::schedule::run_scheduler`, `crate::grpc::coordinator::{CoordinatorState, CoordinatorService}`, `handicap_proto::v1::coordinator_server::CoordinatorServer`.
- Produces (Task 4가 의존):
  - `pub async fn run_in_process(cfg: InProcessConfig) -> anyhow::Result<RunningController>` — 부트스트랩 완료 후 serve 태스크가 *백그라운드에서 돌고 있는* 핸들을 반환(R8: tracing init 안 함).
  - `pub struct RunningController` + `pub fn rest_addr(&self) -> SocketAddr`, `pub fn grpc_addr(&self) -> SocketAddr`, `pub async fn shutdown(&self)`(절대 hang 안 함), `pub async fn join(self)`(serve 태스크 await — standalone exe용).

**배경(스펙 §5):** `run_in_process`는 `main.rs` 137–404 bundle 경로를 그대로 재현한다 — data-dir 생성 → DB connect → `mark_orphans_failed` → `CoordinatorState` + worker token → 포트 pre-bind(`bind_with_fallback`) → dispatcher(Subprocess self-exe) → settings(R5c stale-clamp + `SettingsState::build`) → `AppState` → scheduler spawn → heartbeat-reaper(`is_pool_mode()`면; in-process는 false라 dormant) → gRPC svc → serve 태스크 spawn(graceful shutdown 배선). 단 **창/브라우저-open은 호출자(main.rs/desktop) 몫**이고, serve를 `try_join!`으로 *블록*하지 않고 `JoinHandle`로 보관해 `RunningController`에 넘긴다.

- [ ] **Step 1: import 보강 + 구조체/조립 스텁(컴파일만)**

`in_process.rs` 상단 import에 추가(Task 2에서 뺐던 것 + 신규):

```rust
use std::sync::{Arc, Mutex};

use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::app::{self, AppState};
use crate::dispatcher::{SharedDispatcher, subprocess::SubprocessDispatcher};
use crate::settings::SettingsState;
use handicap_proto::v1::coordinator_server::CoordinatorServer;
```

또한 Task 2의 `use crate::grpc::coordinator::{CoordinatorState, DEFAULT_WORKER_CAPACITY_VUS};`를 **`{CoordinatorState, CoordinatorService, DEFAULT_WORKER_CAPACITY_VUS}`로 확장**한다(Task 3가 `CoordinatorService`를 씀).

(이들은 전부 Task 3가 *새로* 쓰는 심볼이다 — Task 2는 안 썼다: `Arc`/`Mutex`(RunningController 핸들 보관), `TcpListener`/`TcpListenerStream`(serve), `CancellationToken`(graceful 토큰), `info`/`warn`(부트스트랩·shutdown 로그), `SettingsState`(`build`), `app`/`AppState`(router), `SharedDispatcher`/`SubprocessDispatcher`(dispatcher), `CoordinatorServer`(gRPC svc). `TcpListenerStream`의 정확한 경로는 `main.rs`의 grpc serve `use` 문과 동일하게 맞출 것 — `tokio_stream::wrappers::TcpListenerStream`. `chrono_tz::Tz`·`dirs::data_local_dir`·`crate::launch::*`·`crate::schedule::run_scheduler`·`crate::store::{settings::load_overrides, runs::mark_orphans_failed}`는 본문에서 fully-qualified로 쓰므로 `use` 불요.)

`RunningController` 구조체 + 조립 함수 스텁:

```rust
/// in-process로 구동 중인 controller 핸들. serve/scheduler/heartbeat 태스크를 보유하고
/// graceful 종료(`shutdown`)·블로킹 대기(`join`)를 제공한다.
pub struct RunningController {
    rest_addr: SocketAddr,
    grpc_addr: SocketAddr,
    token: CancellationToken,
    serve: Mutex<Option<tokio::task::JoinHandle<()>>>,
    scheduler: Mutex<Option<tokio::task::JoinHandle<()>>>,
    heartbeat: Mutex<Option<tokio::task::JoinHandle<()>>>,
    coord: CoordinatorState,
    db: Db,
}

impl RunningController {
    pub fn rest_addr(&self) -> SocketAddr {
        self.rest_addr
    }
    pub fn grpc_addr(&self) -> SocketAddr {
        self.grpc_addr
    }

    /// graceful 종료. 절대 무한 hang하지 않는다(스펙 §6): 활성 run abort(R4a) →
    /// 토큰 취소(axum/tonic graceful drain·scheduler/heartbeat 정지) → bounded drain
    /// (초과 시 serve 태스크 hard-stop).
    pub async fn shutdown(&self) {
        match abort_all(&self.coord, &self.db).await {
            Ok(n) => info!(aborted = n, "shutdown: aborted active runs"),
            Err(e) => warn!(error = ?e, "shutdown: abort_all failed (continuing)"),
        }
        self.token.cancel();
        let serve = self.serve.lock().unwrap().take();
        if let Some(handle) = serve {
            if !bounded_drain(handle, GRACEFUL_DRAIN_TIMEOUT).await {
                warn!(
                    timeout_s = GRACEFUL_DRAIN_TIMEOUT.as_secs(),
                    "graceful drain exceeded deadline — serve task hard-stopped"
                );
            }
        }
        // 토큰 취소로 select!를 빠져나오지만 백스톱으로 abort.
        if let Some(h) = self.scheduler.lock().unwrap().take() {
            h.abort();
        }
        if let Some(h) = self.heartbeat.lock().unwrap().take() {
            h.abort();
        }
    }

    /// serve 태스크를 await(토큰이 취소되지 않는 한 사실상 영원). standalone bundle exe용.
    pub async fn join(self) {
        let serve = self.serve.lock().unwrap().take();
        if let Some(handle) = serve {
            let _ = handle.await;
        }
    }
}

pub async fn run_in_process(cfg: InProcessConfig) -> anyhow::Result<RunningController> {
    todo!("Step 4")
}
```

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/tauri-in-process
cargo build -p handicap-controller --features bundle
```
Expected: 컴파일 OK(`todo!` 경고만). unused import 있으면 정리.

- [ ] **Step 2: 실패 테스트 작성 (health-serve + shutdown)**

`mod tests`에 추가(`reqwest`는 controller normal dep이라 테스트에서 사용 가능):

```rust
async fn start_test_controller() -> RunningController {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = InProcessConfig {
        db: Some(tmp.path().join("c.db").display().to_string()),
        scheduler_disabled: true, // 테스트 잡음 제거
        ..InProcessConfig::default()
    };
    // tmp는 함수 종료 시 drop되지만 DB connect가 끝난 뒤라 무방(파일 핸들은 풀이 보유).
    std::mem::forget(tmp);
    run_in_process(cfg).await.unwrap()
}

#[tokio::test]
async fn run_in_process_serves_health_then_shuts_down() {
    let rc = start_test_controller().await;
    let port = rc.rest_addr().port();
    assert_ne!(port, 0, "ephemeral 포트가 실제 할당돼야 함");

    let url = format!("http://127.0.0.1:{port}/api/health");
    let body = reqwest::get(&url).await.unwrap().text().await.unwrap();
    assert_eq!(body, "ok");

    // shutdown은 빠르게(절대 hang 없이) 반환해야 한다.
    tokio::time::timeout(Duration::from_secs(10), rc.shutdown())
        .await
        .expect("shutdown must not hang");

    // 종료 후 health는 더 이상 안 떠야 한다.
    let after = reqwest::get(&url).await;
    assert!(after.is_err(), "shutdown 후 REST가 닫혀야 함");
}
```

(`GET /api/health` → `"ok"`는 `crate::app::router`의 `/api` nest 아래 `/health` 라우트. 경로가 다르면 `crates/controller/src/app.rs`에서 확인. `reqwest::get`은 기본 features로 충분 — controller reqwest는 `rustls-tls`+`json`.)

- [ ] **Step 3: 실패 확인**

```bash
cargo test -p handicap-controller --features bundle in_process::tests::run_in_process_serves_health --no-run
```
Expected: 컴파일은 되나 실행 시 `todo!` panic(또는 `--no-run`이면 링크 OK). 이어서:
```bash
cargo test -p handicap-controller --features bundle in_process::tests::run_in_process_serves_health
```
Expected: FAIL — `not yet implemented` (`todo!`).

- [ ] **Step 4: `run_in_process` 본문 구현**

`main.rs` 137–404의 bundle 경로를 재현. `todo!`를 다음으로 교체:

```rust
pub async fn run_in_process(cfg: InProcessConfig) -> anyhow::Result<RunningController> {
    // 1) data-dir + DB 경로 해석 (bundle: dirs data-local-dir, in-process는 worker_mode 고정 Subprocess).
    let data_dir: Option<std::path::PathBuf> =
        dirs::data_local_dir().map(|base| crate::launch::app_data_dir(&base));
    if let Some(dir) = &data_dir {
        std::fs::create_dir_all(dir).context("create app data dir")?;
    }
    let db_path = crate::launch::resolve_db_path(cfg.db.as_deref(), data_dir.as_deref());
    info!(db = %db_path, "resolved database path");
    let db_url = store::url_from_path(&db_path);
    let db = store::connect(&db_url).await?;

    // 2) 고아 run 정리(R4c) + Coordinator 상태.
    let recovered = crate::store::runs::mark_orphans_failed(
        &db,
        "controller restarted while run was in progress",
    )
    .await
    .context("mark_orphans_failed")?;
    if recovered > 0 {
        info!(count = recovered, "marked orphan runs as failed on startup");
    }
    let coord_state = CoordinatorState::new(db.clone());
    coord_state.set_worker_token(cfg.worker_token.clone());

    // 3) 포트 pre-bind(빈 포트 fallback) → 실제 주소 확보(브라우저/worker가 dial).
    let rest_listener = crate::launch::bind_with_fallback(cfg.rest, true).context("bind REST")?;
    let rest_addr = rest_listener.local_addr().context("REST local_addr")?;
    let grpc_listener = crate::launch::bind_with_fallback(cfg.grpc, true).context("bind gRPC")?;
    let grpc_addr = grpc_listener.local_addr().context("gRPC local_addr")?;
    info!(rest = %rest_addr, grpc = %grpc_addr, "listeners (in-process)");

    // 4) dispatcher: in-process는 항상 Subprocess(self-exe 멀티콜 워커).
    let self_exe = std::env::current_exe()
        .context("resolve current_exe for worker self-spawn")?
        .to_string_lossy()
        .into_owned();
    let dispatcher: SharedDispatcher = Arc::new(
        SubprocessDispatcher::new(self_exe, grpc_addr, db.clone())
            .with_leading_args(vec!["worker".to_string()]),
    );
    coord_state.set_dispatcher(dispatcher.clone());

    let scheduler_tz: chrono_tz::Tz = cfg
        .scheduler_timezone
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid scheduler timezone: {}", cfg.scheduler_timezone))?;

    // 5) settings: R5c stale-clamp(시드 stale ≤ interval이면 interval+1) 후 build.
    let overrides = crate::store::settings::load_overrides(&db).await?;
    let mut seeds = cfg.settings_seeds.clone();
    if seeds.pool_stale_timeout_seconds <= seeds.pool_heartbeat_interval_seconds {
        warn!(
            interval = seeds.pool_heartbeat_interval_seconds,
            stale = seeds.pool_stale_timeout_seconds,
            "stale ≤ interval seed — clamping to interval+1"
        );
        seeds.pool_stale_timeout_seconds = seeds.pool_heartbeat_interval_seconds + 1;
    }
    let settings = SettingsState::build(&overrides, &seeds.to_seed_array());

    // 6) AppState (ui_dir 고정 None — bundle은 rust-embed로 임베드 UI 서빙).
    let state = AppState {
        db: db.clone(),
        coord: coord_state.clone(),
        dispatcher: dispatcher.clone(),
        ui_dir: None,
        settings: settings.clone(),
        scheduler_tz,
    };

    // 7) graceful 종료 토큰.
    let token = CancellationToken::new();

    // 8) scheduler 루프(토큰 취소 시 종료).
    let scheduler_handle = if !cfg.scheduler_disabled {
        let sched_state = state.clone();
        let tick = Duration::from_secs(seeds.scheduler_tick_seconds);
        let sched_token = token.clone();
        info!("scheduler enabled");
        Some(tokio::spawn(async move {
            tokio::select! {
                _ = crate::schedule::run_scheduler(sched_state, tick) => {}
                _ = sched_token.cancelled() => {}
            }
        }))
    } else {
        None
    };

    // 9) heartbeat-reaper(pool 모드에서만; in-process는 Subprocess라 dormant — R6 충실 배선).
    let heartbeat_handle = if coord_state.is_pool_mode() {
        let coord = coord_state.clone();
        let settings = settings.clone();
        let hb_token = token.clone();
        Some(tokio::spawn(async move {
            loop {
                let interval = settings.pool_heartbeat_interval_seconds().max(1);
                let stale = settings.pool_stale_timeout_seconds();
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(interval)) => {}
                    _ = hb_token.cancelled() => break,
                }
                coord
                    .pool_heartbeat_tick(tokio::time::Instant::now(), Duration::from_secs(stale))
                    .await;
            }
        }))
    } else {
        None
    };

    // 10) gRPC 서비스.
    let grpc_svc = CoordinatorServer::new(CoordinatorService {
        state: coord_state.clone(),
    });

    // 11) serve 태스크: axum(REST) + tonic(gRPC)을 graceful shutdown 토큰과 함께 한 태스크에서.
    let app_router = app::router(state);
    let rest_token = token.clone();
    let grpc_token = token.clone();
    let keepalive = Duration::from_secs(seeds.pool_keepalive_seconds);
    let serve_handle = tokio::spawn(async move {
        rest_listener
            .set_nonblocking(true)
            .expect("rest set_nonblocking");
        let rest_l = TcpListener::from_std(rest_listener).expect("rest from_std");
        let rest_fut = axum::serve(rest_l, app_router)
            .with_graceful_shutdown(async move { rest_token.cancelled().await });

        let grpc_incoming =
            TcpListenerStream::new(TcpListener::from_std(grpc_listener).expect("grpc from_std"));
        let grpc_fut = tonic::transport::Server::builder()
            .http2_keepalive_interval(Some(keepalive))
            .http2_keepalive_timeout(Some(keepalive))
            .add_service(grpc_svc)
            .serve_with_incoming_shutdown(grpc_incoming, async move {
                grpc_token.cancelled().await
            });

        let _ = tokio::join!(rest_fut, grpc_fut);
    });

    Ok(RunningController {
        rest_addr,
        grpc_addr,
        token,
        serve: Mutex::new(Some(serve_handle)),
        scheduler: Mutex::new(scheduler_handle),
        heartbeat: Mutex::new(heartbeat_handle),
        coord: coord_state,
        db,
    })
}
```

**구현 시 main.rs와 대조해 정확히 맞출 지점(이름이 다르면 main.rs 우선):**
- `SubprocessDispatcher::new(self_exe, grpc_addr, db.clone())` 인자 순서·`.with_leading_args(vec!["worker".to_string()])`.
- `CoordinatorService { state: coord_state.clone() }` 필드명(`state`).
- `coord_state.set_dispatcher` / `set_worker_token` / `is_pool_mode` / `pool_heartbeat_tick` 시그니처.
- `crate::store::settings::load_overrides(&db)` 경로.
- `tonic` keepalive 호출(`http2_keepalive_interval`/`_timeout`)과 그 인자(main.rs는 `args.pool_keepalive_seconds`로 둘 다 설정 — main.rs가 timeout에 다른 값을 쓰면 그걸 따를 것).
- `AppState` 필드 집합(`db,coord,dispatcher,ui_dir,settings,scheduler_tz`).
- serve의 set_nonblocking/from_std/TcpListenerStream 패턴은 main.rs bundle `rest_fut`/`grpc_fut`와 동일하게. (main.rs는 `serve_with_incoming` + 별도 listener였다면, 여기선 graceful이 필요하므로 `serve_with_incoming_shutdown` + `with_graceful_shutdown`으로 바꾼다 — 이게 §6 배선의 핵심.)

비-Subprocess 분기(Kubernetes/Pool)·browser-open·`try_join!` 블록은 **재현하지 않는다**(in-process는 Subprocess 고정, open은 호출자 몫, serve는 핸들 반환).

- [ ] **Step 5: 통과 확인**

```bash
cargo test -p handicap-controller --features bundle in_process::tests::run_in_process_serves_health
```
Expected: PASS(health "ok" + shutdown 10s 내 반환 + 종료 후 닫힘).

- [ ] **Step 6: bundle 게이트 풀 통과**

```bash
cargo build  -p handicap-controller --features bundle
cargo clippy -p handicap-controller --features bundle --all-targets -- -D warnings
cargo nextest run -p handicap-controller --features bundle
```
Expected: 전부 green.

- [ ] **Step 7: 커밋**

```bash
git add crates/controller/src/in_process.rs
git commit -m "feat(controller): run_in_process + RunningController (graceful bounded-drain shutdown, bundle-gated)"
git log -1
```

---

## Task 4: bundle `main.rs`를 `run_in_process`로 위임 (비-bundle byte-identical)

**Files:**
- Modify: `crates/controller/src/main.rs` (bundle 부트스트랩 137–404 → `run_bundle` 위임; 비-bundle은 동일 로직을 `#[cfg(not(feature="bundle"))]` 블록으로 격리)

**Interfaces:**
- Consumes (Task 2·3): `handicap_controller::in_process::{run_in_process, InProcessConfig, SettingsSeeds}`.
- Produces: (없음 — 바이너리 종단)

**배경(스펙 R5/R6):** bundle 빌드는 `run_bundle(args)` → `InProcessConfig` 조립 → `run_in_process` → browser-open → `rc.join().await`. 비-bundle 빌드는 현 인라인 부트스트랩을 **그대로**(byte-identical) `#[cfg(not(feature="bundle"))]` 블록에 둔다. cfg-split 지점은 tracing init 직후.

- [ ] **Step 1: 현재 main.rs 구조 정독**

`crates/controller/src/main.rs`를 읽어 다음 경계를 확인: ① 워커 멀티콜 arm(`#[cfg(feature="bundle")] if let Some(Cmd::Worker(...))`, ~122–126) ② `let args = cli.controller;` + tracing init(~128–135) ③ 부트스트랩 본문(`info! "controller starting"` ~137부터 `tokio::try_join!(rest_fut, grpc_fut)?; Ok(())` ~404까지). ③ 안에는 `#[cfg(feature="bundle")]` / `#[cfg(not(feature="bundle"))]` sub-블록들(data_dir·listeners·dispatcher·rest_fut·grpc_fut·browser-open)이 섞여 있다.

- [ ] **Step 2: cfg-split — `run_bundle` 위임 + 비-bundle 인라인 격리**

`main()`의 tracing init **이후**를 다음 구조로 바꾼다. 워커 arm·`let args`·tracing init은 **그대로 유지**(R7/R8):

```rust
    // (워커 멀티콜 arm + let args = cli.controller; + tracing init … 무변경)

    #[cfg(feature = "bundle")]
    return run_bundle(args).await;

    #[cfg(not(feature = "bundle"))]
    {
        // ── 현행 비-bundle 부트스트랩(137–404)을 그대로 — byte-identical. ──
        // 이 블록은 비-bundle에서만 컴파일되므로, 안의 #[cfg(feature="bundle")] sub-블록은
        // 제거하고 #[cfg(not(feature="bundle"))] 변형만 무조건문으로 남긴다(아래 Step 3).
        info!(
            rest = %args.rest,
            grpc = %args.grpc,
            worker_mode = ?args.worker_mode,
            worker_token_set = args.worker_token.is_some(),
            "controller starting"
        );
        // … ui_dir 검증, data_dir=None, db connect, mark_orphans, coord_state,
        //    listeners(args.rest/args.grpc), dispatcher(args.worker_bin), settings,
        //    AppState, scheduler, heartbeat, grpc_svc, rest_fut/grpc_fut(.bind/.serve) …
        tokio::try_join!(rest_fut, grpc_fut)?;
        Ok(())
    }
```

`return run_bundle(args).await;`가 diverge하므로 `#[cfg(not)]` 블록과 타입 충돌 없음(둘 중 하나만 컴파일).

- [ ] **Step 3: 비-bundle 블록에서 죽은 bundle sub-블록 제거**

`#[cfg(not(feature="bundle"))]` 블록 안에서, 각 cfg-split을 **비-bundle 변형만 남기고 단순화**한다(블록 전체가 이미 non-bundle이므로 `#[cfg(feature="bundle")]` sub-블록은 절대 컴파일 안 됨 → 제거; `#[cfg(not(feature="bundle"))]` 변형은 무조건문으로):

- `data_dir`: `let data_dir: Option<std::path::PathBuf> = None;`
- listeners: `let (rest_addr, grpc_addr) = (args.rest, args.grpc);`
- dispatcher Subprocess arm: 비-bundle `Arc::new(SubprocessDispatcher::new(args.worker_bin.clone(), grpc_addr, db.clone()))`만.
- `rest_fut`/`grpc_fut`: 비-bundle 변형(`TcpListener::bind(args.rest).await` + `axum::serve(...).await`, `tonic ... .serve(args.grpc).await`)만.
- browser-open `#[cfg(feature="bundle")]` 블록: **제거**(비-bundle엔 원래 없음).

**검증 기준:** 이 블록의 *비-bundle 컴파일 결과*가 변경 전과 동일해야 한다(코드 텍스트는 cfg sub-블록 제거로 줄지만, 비-bundle에서 실제 컴파일되던 문장 집합은 불변). 확신이 안 서면 sub-블록을 제거하지 말고 **verbatim 유지**(죽은 `#[cfg(feature="bundle")]` 블록을 그대로 둬도 비-bundle 코드젠은 동일) — byte-identical 안전이 우선. 단 clippy `-D warnings`가 죽은 블록에서 경고를 내면 제거.

- [ ] **Step 4: `run_bundle` 추가**

`main.rs` 하단(`#[tokio::main] async fn main` 밖)에:

```rust
#[cfg(feature = "bundle")]
async fn run_bundle(args: ControllerArgs) -> anyhow::Result<()> {
    use handicap_controller::in_process::{run_in_process, InProcessConfig, SettingsSeeds};

    // 보안: args를 통째 ?-덤프하지 말 것(worker_token 누출). 명시 필드 + bool만.
    info!(
        rest = %args.rest,
        grpc = %args.grpc,
        worker_token_set = args.worker_token.is_some(),
        "controller starting (in-process bundle)"
    );

    let cfg = InProcessConfig {
        db: args.db.clone(),
        rest: args.rest,
        grpc: args.grpc,
        worker_token: args.worker_token.clone(),
        scheduler_disabled: args.scheduler_disabled,
        scheduler_timezone: args.scheduler_timezone.clone(),
        settings_seeds: SettingsSeeds {
            worker_capacity_vus: args.worker_capacity_vus,
            dataset_max_rows: args.dataset_max_rows,
            scheduler_tick_seconds: args.scheduler_tick_seconds,
            pool_heartbeat_interval_seconds: args.pool_heartbeat_interval_seconds,
            pool_stale_timeout_seconds: args.pool_stale_timeout_seconds,
            pool_keepalive_seconds: args.pool_keepalive_seconds,
            run_startup_grace_seconds: args.run_startup_grace_seconds,
            run_backstop_grace_seconds: args.run_backstop_grace_seconds,
        },
    };

    let rc = run_in_process(cfg).await?;

    if !args.no_open {
        let url = format!("http://localhost:{}", rc.rest_addr().port());
        info!(%url, "opening browser");
        handicap_controller::bundle::open_browser(&url);
    }
    info!(rest = %rc.rest_addr(), "REST listening (in-process)");

    rc.join().await;
    Ok(())
}
```

(`ControllerArgs`의 필드명·타입이 위와 다르면 실제 struct에 맞춘다 — 특히 `no_open`/`scheduler_disabled`/`worker_capacity_vus`/grace·pool 필드.)

**`--ui-dir` 검증을 의도적으로 드롭한다(리뷰 적발 — 결정·명시).** 현 bundle `main.rs`는 cfg-split *전* 공유 코드에서 `--ui-dir`가 주어졌고 존재하지 않으면 `bail!`로 fail-fast한다. in-process 경로는 `ui_dir = None` 고정(spec §4.1 — bundle은 rust-embed 임베드 UI가 authoritative)이라 `--ui-dir`가 **수용-후-무시**되고, 그 존재성 `bail!`도 따라서 사라진다. 이는 R6 "standalone byte-identical"의 의도된 예외 — 임베드 UI가 외부 `ui_dir`를 moot하게 만들기 때문이며, bundle exe에 `--ui-dir`를 넘기는 것 자체가 오용이다. (검증을 되살리고 싶으면 `run_bundle`에서 config 조립 전 `if let Some(d) = &args.ui_dir { if !d.exists() { anyhow::bail!(...) } }`를 재현할 수 있으나, 검증 후 무시는 비일관이라 **드롭이 권장**. 이 결정을 build-log byte-identical 단락에도 적는다.)

- [ ] **Step 5: 비-bundle 게이트 (byte-identical 회귀)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/tauri-in-process
cargo build  -p handicap-controller
cargo clippy -p handicap-controller --all-targets -- -D warnings
cargo nextest run -p handicap-controller
```
Expected: 전부 green. **비-bundle controller e2e(`full_slice_1_e2e` 등) 포함 통과** — 부트스트랩 동작 불변의 증거.

- [ ] **Step 6: bundle 게이트 (in-process 경로)**

```bash
cargo build  -p handicap-controller --features bundle
cargo clippy -p handicap-controller --features bundle --all-targets -- -D warnings
cargo nextest run -p handicap-controller --features bundle
```
Expected: 전부 green.

- [ ] **Step 7: 커밋**

```bash
git add crates/controller/src/main.rs
git commit -m "refactor(controller): bundle main.rs delegates to run_in_process (non-bundle byte-identical)"
git log -1
```

---

## 라이브 검증 (구현 완료 후, finish-slice 전)

production diff가 run-생성/엔진/serve 경로를 건드리므로 **필수**(`/live-verify` 정신). bundle 바이너리로 in-process 경로를 실측:

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/tauri-in-process
cd ui && pnpm build && cd ..                         # rust-embed가 컴파일 타임에 읽음
cargo build -p handicap-controller --features bundle  # self-exe 멀티콜 워커 포함
```

1. **in-process 부팅 + run 완료:** `./target/debug/controller --rest 127.0.0.1:0 --grpc 127.0.0.1:0 --no-open`(bundle은 멀티콜 워커 self-spawn) → 로그에서 실제 REST 포트 파싱 → `GET /api/health`==`ok` → 50ms python responder로 시나리오 생성 → `POST /api/runs`(closed-loop vus=2 duration=3) → 리포트 `summary.rps` 정상 확인(워커 self-spawn 동작 = in-process dispatcher 정상).
2. **graceful 종료(§6):** run 진행 중 컨트롤러에 SIGTERM → 프로세스가 5초 내 종료, 좀비 워커 0(`pgrep -f 'controller worker'` 비어야 함). (현 main.rs엔 SIGTERM 핸들러가 없으므로 이 검증은 desktop Slice 2의 `shutdown()` 호출 경로를 대신해 **`RunningController::shutdown` 단위 테스트(Task 3)** + 워커 R4b 크로스플랫폼 백스톱으로 커버됨을 명시 — standalone exe는 Ctrl-C로 즉사하고 R4c가 다음 startup에 고아 정리. 라이브에선 컨트롤러 kill 후 *재시작* 시 `mark_orphans_failed` 로그 + 워커 self-cancel 로그를 확인.)
3. **R4b 크로스플랫폼:** run 진행 중 컨트롤러를 `kill -9`(graceful 우회 = 하드 크래시) → 워커 로그에 `inbound stream closed without abort — cancelling run` + 워커가 좀비로 안 남음 확인.

(라이브가 1M-context 크레딧 에러로 subagent에서 죽으면 메인 세션에서 직접 절차 수행 — CLAUDE.md subagent-dispatch 함정.)

---

## Self-Review (작성자 체크 — 통과)

**1. Spec coverage:** R1(lib 진입점=Task 2·3 in_process.rs), R5(bundle-gated=Task 2 모듈 decl + Task 4 cfg-split, 검증 Step 5), R6(`run_in_process`가 scheduler/heartbeat 충실 배선=Task 3 §8·9), R7(`Cmd::Worker` arm 무변경=Task 4 Step 1·2), R8(tracing init 호출자=Task 3 주석·Task 4가 init), R9(engine/proto/migration 0-diff — 어느 task도 안 건드림; 워커는 로직만), §6 bounded-drain(Task 2 `bounded_drain` + Task 3 `shutdown`·5s·JoinHandle abort), §4.2 disconnect-cancel(Task 1), 보안 token 비누출(Task 4 `run_bundle` info! 명시 필드). ✔ 빠짐 없음.

**2. Placeholder scan:** `todo!`는 Task 3 Step 1 스텁→Step 4에서 실체화(의도된 TDD red). 그 외 "TBD/적절히/handle edge cases" 없음. ✔

**3. Type consistency:** `SettingsSeeds`/`InProcessConfig`/`bounded_drain(...)->bool`/`abort_all(...)->anyhow::Result<usize>`/`run_in_process(InProcessConfig)->anyhow::Result<RunningController>`/`RunningController::{rest_addr,grpc_addr,shutdown,join}`가 Interfaces 블록과 본문에서 일관. `GRACEFUL_DRAIN_TIMEOUT=5s`·`to_seed_array()->[(&str,i64);8]` 일치. ✔

**4. 커밋 경계(green-commit 게이트):** 4 task 모두 단일 green 커밋(헬퍼+테스트+배선 fold). Task 2의 미사용 `pub(crate)` 헬퍼 dead_code 문제 없음(전부 테스트가 즉시 사용 + `pub`은 cross-crate 소비 예정). bundle 코드는 pre-commit 비대상 → 각 task Step에 수동 `--features bundle` 게이트 명시. ✔

<!-- REVIEW-GATE: APPROVED -->
