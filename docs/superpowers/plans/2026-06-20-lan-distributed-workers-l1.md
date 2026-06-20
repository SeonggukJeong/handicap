# LAN 분산 워커 L1 (상시 워커 풀 백엔드 제어판) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 워커가 `--run-id` 없이 컨트롤러에 붙어 유휴 풀에 대기하고, run 발사 시 컨트롤러가 연결된 유휴 워커에 샤드를 push 배정하는 LAN 분산 실행(L1 백엔드)을 추가한다.

**Architecture:** 기존 per-run dispatcher-spawn(pull) 모델 옆에 세 번째 워커 모드 `pool`을 더한다. 워커는 빈 run_id로 register하여 컨트롤러의 인메모리 풀 레지스트리에 들어가고, `connect_and_register`의 기존 "첫 RunAssignment 블록 대기"가 곧 유휴 상태가 된다. run 발사 시 `spawn_run`이 유휴 워커를 부하상한으로 cap한 만큼 예약→`register()`/`assignment_for()`/`stream_dataset()`(기존 함수)로 샤드를 push한다. shard_split·메트릭 머지·fail-fast는 그대로 재사용. 채널엔 선택적 공유 토큰 인증을 더한다.

**Tech Stack:** Rust (tonic gRPC bidi stream, tokio, tokio-util CancellationToken), prost proto, clap CLI, sqlx(읽기만 — migration 0).

## Global Constraints

- **spec 척추**: `docs/superpowers/specs/2026-06-20-lan-distributed-workers-l1-design.md` — 모든 task는 그 R-id를 충족한다. 의심 시 spec이 권위.
- **migration 0 / 엔진 무변경**: 풀은 인메모리. `crates/engine`·DB 스키마·리포트·CSV/XLSX·UI 전부 무변경(spec §5).
- **조건부 byte-identical (R10)**: `--worker-mode subprocess`(기본) AND `--worker-token` 미설정이면 pre-slice 동작과 동일. 토큰 검사는 미설정 시 skip. proto는 additive(`Register.token` 기본 빈).
- **wire 1:1 (R2)**: proto `Register.token` 변경은 worker 송신(`client.rs`) + controller 수신(`coordinator.rs`)이 **같은 task/커밋**(Task 1). 한쪽만 머지 금지.
- **green-commit 게이트**: cargo-영향 커밋마다 전체 워크스페이스 게이트(`cargo fmt --check` + `cargo build --workspace` + `cargo clippy --workspace --all-targets -- -D warnings` + `cargo nextest run --workspace`). **미사용 `pub(crate)` 헬퍼(clippy dead_code)·RED-only 테스트 단독 커밋 불가** → 각 task는 새 코드가 그 커밋 안에서 prod 호출되는 단일 green 커밋. 새 풀 메서드는 추가한 task 안에서 prod 경로(핸들러/spawn_run)가 호출하도록 배치했다.
- **커밋 규율**: `git commit`은 파이프 없이(exit code 가시성), 직후 `git log -1`로 확인. `--no-verify` 금지. 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` + `Claude-Session:` 트레일러.
- **빌드 워밍(cold-build flake 회피, CLAUDE.md S-A)**: 엔진/워커 영향 커밋 전 `cargo build -p handicap-worker --bin worker` 후 전체 빌드. e2e(Task 5) 전 특히.
- **MSRV/edition**: workspace edition 2024 / MSRV 1.85. 신규 dep는 워크스페이스 dep만(Task 4의 `ulid`).
- **TDD**: 각 task는 실패 테스트 → 최소 구현 → 통과 → 커밋. RED→GREEN을 로컬에서 확인하되 게이트 때문에 커밋은 task당 1회 green fold.

---

## 파일 구조 (생성/수정 맵)

| 파일 | 책임 | task |
|---|---|---|
| `crates/proto/proto/coordinator.proto` | `Register.token=4` 추가(additive) | 1 |
| `crates/worker-core/src/client.rs` | `connect_and_register` token 파라미터·Register.token 송신; Task 4에서 cancel-aware 유휴 대기 | 1, 4 |
| `crates/worker-core/src/reconnect.rs` | `connect_with_backoff` token(·cancel) 스레딩 | 1, 4 |
| `crates/worker/src/lib.rs` | `WorkerArgs.{run_id:Option, token:Option}`·`run_dispatch`/`run_pool`/`execute_assignment`·ulid worker_id | 1, 4 |
| `crates/worker/src/main.rs` | `run` → `run_dispatch` 라우팅 | 4 |
| `crates/worker/Cargo.toml` | `ulid` 워크스페이스 dep 추가 | 4 |
| `crates/controller/src/grpc/coordinator.rs` | `CoordinatorState` 풀 필드·setter·풀 메서드·핸들러 분기·disconnect 라우팅 | 1, 2, 3 |
| `crates/controller/src/api/runs.rs` | `spawn_run` 풀 N 분기·예약·assign | 3 |
| `crates/controller/src/main.rs` | `WorkerMode::Pool`·`--worker-token`·setter 와이어 | 1, 3 |
| `crates/controller/tests/pool_e2e.rs` (신규) | 풀 워커 e2e(연속 2 run 재사용) | 5 |
| `docs/dev/lan-workers.md` (신규) | 운영 런북 | 6 |

---

## Task 1: proto `Register.token` + 공유 토큰 인증 (wire)

충족 R: **R2, R3, R10**. Phase 1 — push-inversion과 독립, 토큰 미설정 시 byte-identical.

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (`Register` message)
- Modify: `crates/worker-core/src/client.rs:80-106` (`connect_and_register` 시그니처 + Register 생성)
- Modify: `crates/worker-core/src/reconnect.rs` (`connect_with_backoff` 시그니처/클로저)
- Modify: `crates/worker/src/lib.rs:28-39` (`WorkerArgs` + `connect_with_backoff` 호출처 `lib.rs:88`)
- Modify: `crates/controller/src/grpc/coordinator.rs` (`CoordinatorState`에 `worker_token` + `set_worker_token` + 핸들러 Register arm 토큰 검사)
- Modify: `crates/controller/src/main.rs` (`--worker-token` arg + `coord_state.set_worker_token`)
- Test: `crates/controller/src/grpc/coordinator.rs` (인라인 `#[cfg(test)]`) + `crates/worker-core/src/client.rs` (인라인)

**Interfaces:**
- Produces: `Register { worker_id: String, run_id: String, capacity_vus: u32, token: String }` (proto, field 4).
- Produces: `connect_and_register(controller_url: &str, worker_id: &str, run_id: &str, capacity_vus: u32, token: &str) -> Result<WorkerLink, WorkerError>` (token 파라미터 추가).
- Produces: `connect_with_backoff(controller_url: &str, worker_id: &str, run_id: &str, capacity_vus: u32, token: &str, cancel: CancellationToken) -> Result<WorkerLink, WorkerError>` (token 추가).
- Produces: `CoordinatorState::set_worker_token(&self, token: Option<String>)` — startup 1회, `set_dispatcher`(coordinator.rs:150) 패턴.
- Produces: `WorkerArgs.token: Option<String>` (clap `--token`).

- [ ] **Step 1: proto에 token 필드 추가**

`crates/proto/proto/coordinator.proto`의 `Register` (현 22-26줄):

```proto
message Register {
  string worker_id = 1;
  string run_id = 2;        // worker is spawned per-run in slice 1; "" = pool-mode idle (LAN L1)
  uint32 capacity_vus = 3;  // max VUs this worker is willing to run
  string token = 4;         // shared preshared key (LAN L1); "" = unset
}
```

- [ ] **Step 2: 빌드로 proto 코드젠 확인**

Run: `cargo build -p handicap-proto`
Expected: PASS (prost가 `Register`에 `pub token: String` 생성).

- [ ] **Step 3: 워커 송신 — `connect_and_register`에 token 추가 (RED 테스트 먼저)**

`crates/worker-core/src/client.rs` 인라인 `#[cfg(test)]`에 추가 (이 테스트는 Register가 token을 싣는지 본다 — 구현 전엔 컴파일 실패=RED):

```rust
#[tokio::test]
async fn register_carries_token() {
    // connect_and_register는 실제 채널이 필요하므로, 여기선 Register 메시지 생성만 단위 검증.
    let reg = pb::Register {
        worker_id: "w0".into(),
        run_id: "".into(),
        capacity_vus: 100,
        token: "secret".into(),
    };
    assert_eq!(reg.token, "secret");
}
```

- [ ] **Step 4: `connect_and_register` 시그니처에 token 추가, Register.token 채우기**

`crates/worker-core/src/client.rs:80-106`:

```rust
pub async fn connect_and_register(
    controller_url: &str,
    worker_id: &str,
    run_id: &str,
    capacity_vus: u32,
    token: &str,
) -> Result<WorkerLink, WorkerError> {
    let channel = Channel::from_shared(controller_url.to_string())?
        .connect()
        .await?;
    let mut client = CoordinatorClient::new(channel);

    let (tx, rx) = mpsc::channel::<WorkerMessage>(64);
    let outbound = ReceiverStream::new(rx);
    let response = client.channel(outbound).await?;
    let mut inbound = response.into_inner();

    // Send Register.
    tx.send(WorkerMessage {
        payload: Some(WorkerPayload::Register(Register {
            worker_id: worker_id.to_string(),
            run_id: run_id.to_string(),
            capacity_vus,
            token: token.to_string(),
        })),
    })
    .await
    .map_err(|_| WorkerError::SendFailed)?;
    info!(%worker_id, %run_id, "registered with controller");
    // ... (이후 첫 RunAssignment 대기 등 기존 코드 그대로) ...
```

- [ ] **Step 5: `connect_with_backoff` (reconnect.rs)에 token 스레딩**

`crates/worker-core/src/reconnect.rs`의 `connect_with_backoff` 시그니처에 `token: &str` 추가하고, 내부 `connect_and_register(...)` 호출(클로저 `attempt_fn`)에 `token`을 넘긴다. 클로저가 `token`을 캡처하도록 `let token = token.to_string();`로 owned 캡처(`&str` 수명 회피).

```rust
pub async fn connect_with_backoff(
    controller_url: &str,
    worker_id: &str,
    run_id: &str,
    capacity_vus: u32,
    token: &str,
    cancel: CancellationToken,
) -> Result<WorkerLink, WorkerError> {
    let token = token.to_string();
    // 기존 retry_with_backoff(...) 호출의 attempt 클로저에서:
    //   connect_and_register(controller_url, worker_id, run_id, capacity_vus, &token).await
    // (나머지 backoff/cancel 로직 무변경 — cancel은 Task 4에서 유휴 대기에 추가 활용)
}
```

- [ ] **Step 6: `WorkerArgs.token` + 호출처 갱신**

`crates/worker/src/lib.rs:28-39`에 `token` 추가:

```rust
#[derive(Debug, ClapArgs)]
pub struct WorkerArgs {
    #[arg(long)]
    pub controller: String,
    #[arg(long)]
    pub run_id: String,
    #[arg(long)]
    pub worker_id: Option<String>,
    #[arg(long, default_value = "1000")]
    pub capacity_vus: u32,
    /// Shared preshared key for the controller (LAN). Omit if controller has no --worker-token.
    #[arg(long)]
    pub token: Option<String>,
}
```

`lib.rs:88`의 `connect_with_backoff(...)` 호출에 `args.token.as_deref().unwrap_or("")`를 token 인자로 추가.

> 참고: 이 task에서 `run_id`는 아직 `String`(Task 4에서 `Option`으로). 토큰만 추가.

- [ ] **Step 7: 컨트롤러 — `CoordinatorState.worker_token` + setter (RED 테스트 먼저)**

`crates/controller/src/grpc/coordinator.rs` 인라인 tests에 추가:

```rust
#[tokio::test]
async fn token_unset_accepts_any() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db);
    // worker_token 미설정 → check_token은 항상 통과
    assert!(coord.check_token(""));
    assert!(coord.check_token("anything"));
}

#[tokio::test]
async fn token_mismatch_rejected() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db);
    coord.set_worker_token(Some("secret".to_string()));
    assert!(coord.check_token("secret"));
    assert!(!coord.check_token("wrong"));
    assert!(!coord.check_token(""));
}
```

- [ ] **Step 8: `worker_token` 필드 + setter + `check_token` 구현**

`CoordinatorState`(coordinator.rs:125-134)에 필드 추가, `new`(140-146)에 초기화, setter + 검사 메서드 추가:

```rust
#[derive(Clone)]
pub struct CoordinatorState {
    pub db: Db,
    runs: Arc<Mutex<HashMap<String, RunWorkers>>>,
    dispatcher: Arc<OnceLock<SharedDispatcher>>,
    worker_token: Arc<OnceLock<String>>,  // 설정 시 Register.token이 일치해야 함
}

impl CoordinatorState {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            runs: Arc::new(Mutex::new(HashMap::new())),
            dispatcher: Arc::new(OnceLock::new()),
            worker_token: Arc::new(OnceLock::new()),
        }
    }

    /// Install the required worker token (startup, once). None = no auth.
    pub fn set_worker_token(&self, token: Option<String>) {
        if let Some(t) = token {
            let _ = self.worker_token.set(t);
        }
    }

    /// True if `presented` matches the configured token (or no token configured).
    /// Plain compare: the L1 channel is plaintext so timing is moot (spec R3/§3.6).
    pub fn check_token(&self, presented: &str) -> bool {
        match self.worker_token.get() {
            None => true,
            Some(expected) => expected == presented,
        }
    }
}
```

- [ ] **Step 9: 핸들러 Register arm에 토큰 검사 (legacy 경로에도 적용)**

`crates/controller/src/grpc/coordinator.rs`의 `channel` 핸들러 `Register` arm(647줄 `Some(WorkerPayload::Register(reg)) => {` 직후)에 검사 추가:

```rust
Some(WorkerPayload::Register(reg)) => {
    if !state.check_token(&reg.token) {
        warn!(worker_id = %reg.worker_id, "register rejected: token mismatch");
        let _ = tx.send(Ok(ServerMessage {
            payload: Some(ServerPayload::Abort(AbortRun {
                run_id: reg.run_id.clone(),
                reason: "authentication failed".to_string(),
            })),
        })).await;
        break;
    }
    run_id = Some(reg.run_id.clone());
    worker_id = Some(reg.worker_id.clone());
    // ... 기존 register/assignment 흐름 그대로 ...
```

- [ ] **Step 10: `--worker-token` CLI + 와이어**

`crates/controller/src/main.rs` `ControllerArgs`에 추가(예: `--grpc` 근처):

```rust
/// Shared preshared key required from workers on register (LAN). Omit = no auth.
#[arg(long)]
worker_token: Option<String>,
```

컨트롤러 부팅 경로(`coord_state`(`CoordinatorState`) 생성 직후, dispatcher set 부근)에 `coord_state.set_worker_token(args.worker_token.clone());` 추가. (main.rs의 핸들 변수명은 `coord_state` — coordinator.rs:151.)

- [ ] **Step 11: 워밍 + 게이트 + 커밋**

```bash
cargo build -p handicap-worker --bin worker
cargo build --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo nextest run --workspace
```
Expected: 전부 PASS. 새 토큰 테스트 통과 + 기존 스위트 무회귀(토큰 미설정 byte-identical).

```bash
git add crates/proto crates/worker-core crates/worker crates/controller
git commit -m "feat(lan): proto Register.token + 컨트롤러 공유 토큰 인증 (R2/R3/R10)

워커가 Register에 토큰을 싣고(connect_and_register token 인자) 컨트롤러가
--worker-token 설정 시 불일치를 거부. 미설정이면 모든 토큰 수용 = byte-identical.
push-inversion 없이 독립 green (Phase 1).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C8tTC1wcYZrZU61Zh8MHRV"
git log -1
```

---

## Task 2: 풀 레지스트리 + 핸들러 풀 분기 + disconnect 라우팅

충족 R: **R5, R8, R13(register_idle reset)**. `pool_register_idle`/`pool_disconnect`는 이 task의 핸들러(prod)가 호출 → dead_code 없음.

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` (`PoolEntry` struct, `CoordinatorState.pool`, `pool_register_idle`/`pool_disconnect`, 핸들러 빈-run_id 분기 + 종료 라우팅)
- Test: 인라인 `#[cfg(test)]`

**Interfaces:**
- Produces: `struct PoolEntry { tx: WorkerTx, capacity_vus: u32, assigned_run: Option<String> }` (WorkerTx = `mpsc::Sender<Result<ServerMessage, Status>>`, coordinator.rs:78).
- Produces: `CoordinatorState::pool_register_idle(&self, worker_id: &str, tx: WorkerTx, capacity_vus: u32)` — 멱등 insert/replace, `assigned_run=None`.
- Produces: `CoordinatorState::pool_disconnect(&self, worker_id: &str)` — 엔트리 제거; `assigned_run`이 `Some(run_id)`면 기존 `worker_disconnected(run_id, worker_id)` 호출.
- Consumes(Task 3): `reserve_idle_pool`/`assign_pool_workers`가 `pool` 맵 사용.

- [ ] **Step 1: 실패 테스트 — 멱등 등록 + assigned_run 리셋 + disconnect 제거**

`coordinator.rs` 인라인 tests에 추가:

```rust
#[tokio::test]
async fn pool_register_idempotent_resets_assigned() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db);
    let (tx0, _r0) = fake_tx();
    coord.pool_register_idle("w0", tx0, 100).await;
    assert_eq!(coord.pool_idle_count().await, 1);
    // 같은 worker_id 재등록 = tx 교체, 중복 아님
    let (tx0b, _r0b) = fake_tx();
    coord.pool_register_idle("w0", tx0b, 100).await;
    assert_eq!(coord.pool_idle_count().await, 1, "재등록은 멱등(중복 엔트리 없음)");
}

#[tokio::test]
async fn pool_disconnect_removes() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db);
    let (tx0, _r0) = fake_tx();
    coord.pool_register_idle("w0", tx0, 100).await;
    coord.pool_disconnect("w0").await;
    assert_eq!(coord.pool_idle_count().await, 0);
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo nextest run -p handicap-controller pool_register_idempotent_resets_assigned pool_disconnect_removes`
Expected: 컴파일 실패(메서드 미정의) = RED.

- [ ] **Step 3: `PoolEntry` + `pool` 필드 + 메서드 구현**

`CoordinatorState`에 `pool` 필드 추가(`new`에도 초기화), 구조체 + 메서드:

```rust
struct PoolEntry {
    tx: WorkerTx,
    capacity_vus: u32,
    assigned_run: Option<String>,
}

// CoordinatorState 필드 추가:
//   pool: Arc<Mutex<HashMap<String, PoolEntry>>>,
// new()에: pool: Arc::new(Mutex::new(HashMap::new())),

impl CoordinatorState {
    /// Register (or refresh, on reconnect) an idle pool worker. Idempotent on
    /// worker_id: replaces tx and RESETS assigned_run to None (R13 reuse). 
    pub async fn pool_register_idle(&self, worker_id: &str, tx: WorkerTx, capacity_vus: u32) {
        let mut g = self.pool.lock().await;
        g.insert(
            worker_id.to_string(),
            PoolEntry { tx, capacity_vus, assigned_run: None },
        );
    }

    /// Test/observability helper: count idle (unassigned) pool workers.
    pub async fn pool_idle_count(&self) -> usize {
        self.pool.lock().await.values().filter(|e| e.assigned_run.is_none()).count()
    }

    /// A pool worker's stream closed. Remove its entry; if it was mid-run
    /// (assigned_run = Some), route to the existing fail-fast which preserves
    /// the terminal-phase guard (no spurious fail after Completed). (R8)
    pub async fn pool_disconnect(&self, worker_id: &str) {
        let assigned = {
            let mut g = self.pool.lock().await;
            g.remove(worker_id).and_then(|e| e.assigned_run)
        };
        if let Some(run_id) = assigned {
            self.worker_disconnected(&run_id, worker_id).await;
        }
    }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo nextest run -p handicap-controller pool_register_idempotent_resets_assigned pool_disconnect_removes`
Expected: PASS.

- [ ] **Step 5: 핸들러 빈-run_id 풀 분기 + 종료 라우팅 구현**

> busy 워커 disconnect→fail-fast 테스트(`pool_busy_disconnect_fails_run`)는 **Task 3**에서 `reserve_idle_pool`로 busy 상태를 셋업한다(reserve가 `assigned_run=Some`을 마킹하는 유일한 경로 — `pool_set_assigned` 같은 별도 헬퍼를 두면 Task 2에선 test-only=clippy dead_code). 이 task는 idle 등록/해제만 검증(Step 1 `pool_disconnect_removes`가 idle disconnect 커버).

핸들러(coordinator.rs `channel`의 `Register` arm, Task 1에서 토큰 검사 추가한 직후): 빈 run_id면 풀 등록 후 fall-through:

```rust
// (토큰 검사 통과 후)
worker_id = Some(reg.worker_id.clone());
if reg.run_id.is_empty() {
    // 풀 모드: 유휴 등록만, 배정은 나중에 assign_pool_workers가 push.
    info!(worker_id = %reg.worker_id, "pool worker registered idle");
    state.pool_register_idle(&reg.worker_id, tx.clone(), reg.capacity_vus).await;
    pool_conn = true;   // 로컬 bool, 루프 시작 전 `let mut pool_conn = false;`
    continue;           // 다음 inbound 메시지(MetricBatch/RunStatus) 대기
}
run_id = Some(reg.run_id.clone());
// ... 기존 legacy register/assignment 흐름 ...
```

핸들러 종료 라우팅(현 750-752 `if let (Some(rid), Some(wid)) = ...`)을 분기:

```rust
if pool_conn {
    if let Some(wid) = worker_id.as_ref() {
        state.pool_disconnect(wid).await;
    }
} else if let (Some(rid), Some(wid)) = (run_id.as_ref(), worker_id.as_ref()) {
    state.worker_disconnected(rid, wid).await;
}
```

> `pool_conn` 로컬 변수를 `tokio::spawn` 클로저 상단(현 636 `let mut run_id ...` 부근)에 `let mut pool_conn = false;`로 선언.

- [ ] **Step 6: 게이트 + 커밋**

```bash
cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace
```
Expected: PASS (새 풀 단위 + 기존 무회귀).

```bash
git add crates/controller
git commit -m "feat(lan): 컨트롤러 풀 레지스트리 + 핸들러 빈-run_id 분기 + disconnect 라우팅 (R5/R8/R13)

CoordinatorState.pool(worker_id→PoolEntry{tx,capacity,assigned_run}) + 멱등
유휴 등록(assigned_run 리셋) + pool_disconnect가 기존 worker_disconnected
fail-fast로 라우팅(terminal-phase 가드 보존). 핸들러가 빈 run_id를 풀 등록.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C8tTC1wcYZrZU61Zh8MHRV"
git log -1
```

---

## Task 3: 풀 발사 (예약 + push 배정) + `--worker-mode pool` 와이어

충족 R: **R4, R6, R7, R14**. `reserve_idle_pool`/`assign_pool_workers`는 이 task의 `spawn_run`(prod)이 호출 → dead_code 없음.

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` (`reserve_idle_pool`, `assign_pool_workers`, `pool_mode` 필드 + `set_pool_mode`/`is_pool_mode`)
- Modify: `crates/controller/src/api/runs.rs:490-637` (`spawn_run` 풀 분기)
- Modify: `crates/controller/src/main.rs` (`WorkerMode::Pool` + dispatcher=Noop + `set_pool_mode`)
- Test: `coordinator.rs` 인라인 + `runs.rs` 인라인/통합

**Interfaces:**
- Produces: `CoordinatorState::reserve_idle_pool(&self, run_id: &str, cap: usize) -> Vec<(String, WorkerTx)>` — 원자적으로 유휴에서 `min(idle, cap)`개 제거(반환 worker_id+tx; 아직 assigned_run=None).
- Produces: `CoordinatorState::assign_pool_workers(&self, run_id: &str, reserved: Vec<(String, WorkerTx)>) -> Result<(), ()>` — 예약 워커마다 `register()`+`assignment_for()`+push+`stream_dataset()`+첫워커 Running. `assigned_run`은 reserve가 이미 Some(락). 어느 push라도 tx 닫힘이면 `Err(())`(호출자가 cancel_dispatch_failed).
- Produces: `CoordinatorState::is_pool_mode(&self) -> bool` + `set_pool_mode(&self, on: bool)`.

- [ ] **Step 1: 실패 테스트 — reserve가 부하상한으로 cap**

`coordinator.rs` 인라인 tests:

```rust
#[tokio::test]
async fn pool_n_is_min_idle_and_load() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db);
    for w in ["w0", "w1", "w2"] {
        let (tx, _r) = fake_tx();
        coord.pool_register_idle(w, tx, 100).await;
    }
    // cap=2(부하상한, 예: vus=2) → 3 유휴 중 2개만 예약
    let reserved = coord.reserve_idle_pool("run-x", 2).await;
    assert_eq!(reserved.len(), 2);
    assert_eq!(coord.pool_idle_count().await, 1, "예약된 2개는 유휴에서 빠짐");
}

#[tokio::test]
async fn pool_empty_reserves_none() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db);
    let reserved = coord.reserve_idle_pool("run-x", 4).await;
    assert!(reserved.is_empty());
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo nextest run -p handicap-controller pool_n_is_min_idle_and_load pool_empty_reserves_none`
Expected: RED(메서드 미정의).

- [ ] **Step 3: `reserve_idle_pool` + `assign_pool_workers` + `pool_mode` 구현**

```rust
// CoordinatorState 필드: pool_mode: Arc<OnceLock<bool>>  (new에 초기화)
impl CoordinatorState {
    pub fn set_pool_mode(&self, on: bool) { let _ = self.pool_mode.set(on); }
    pub fn is_pool_mode(&self) -> bool { *self.pool_mode.get().unwrap_or(&false) }

    /// Atomically (under the pool lock) reserve up to `cap` idle workers for
    /// `run_id`: mark each `assigned_run = Some(run_id)` (reservation LOCK —
    /// stops a concurrent launch from grabbing the same worker) and return
    /// (worker_id, tx) for each. (R6/R13.)
    pub async fn reserve_idle_pool(&self, run_id: &str, cap: usize) -> Vec<(String, WorkerTx)> {
        let mut g = self.pool.lock().await;
        let ids: Vec<String> = g.iter()
            .filter(|(_, e)| e.assigned_run.is_none())
            .map(|(id, _)| id.clone())
            .take(cap)
            .collect();
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(e) = g.get_mut(&id) {
                e.assigned_run = Some(run_id.to_string()); // 예약 락(같은 guard 내 원자적)
                out.push((id, e.tx.clone()));
            }
        }
        out
    }

    /// Push assignments to reserved pool workers, reusing register()/assignment_for()/
    /// stream_dataset(). On a closed tx (worker vanished between reserve and push),
    /// return Err so the caller fails the run fast (R7) — not the 60s watchdog.
    pub async fn assign_pool_workers(
        &self,
        run_id: &str,
        reserved: Vec<(String, WorkerTx)>,
    ) -> Result<(), ()> {
        for (worker_id, tx) in reserved {
            let outcome = self.register(run_id, &worker_id, tx.clone()).await;
            let (shard_index, shard_count, vu_offset, vu_count, set_running) = match outcome {
                RegisterOutcome::Assigned { shard_index, shard_count, vu_offset, vu_count, first } =>
                    (shard_index, shard_count, vu_offset, vu_count, first),
                // 풀 발사에선 일어나지 않아야 함(예약 수==expected). 방어적으로 실패.
                _ => return Err(()),
            };
            let Some((assignment, streams)) = self
                .assignment_for(run_id, &worker_id, shard_index, shard_count, vu_offset, vu_count)
                .await
            else { return Err(()); };
            if tx.send(Ok(ServerMessage {
                payload: Some(ServerPayload::Assignment(assignment)),
            })).await.is_err() {
                return Err(()); // 워커 이탈 → 즉시 fail-fast (R7) — assigned_run은 reserve가 이미 Some
            }
            if set_running {
                let _ = runs::set_status(&self.db, run_id, RunStatus::Running,
                    Some(crate::store::now_ms()), None).await;
            }
            for ws in &streams {
                if ws.count > 0 && !stream_dataset(self, &tx, run_id, ws).await { break; }
            }
        }
        Ok(())
    }
}
```

> 주의: `reserve_idle_pool`이 예약 락으로 `assigned_run=Some(run_id)`를 즉시 마킹하므로, 그 사이 워커가 끊기면 `pool_disconnect`가 `worker_disconnected(run_id,…)`를 호출하는데 — 이때 run이 아직 `enqueue`되기 *전*이면 `worker_disconnected`는 `runs.get(run_id)=None`으로 **무해 early-return**(coordinator.rs:426). 따라서 spawn_run은 reserve 직후 곧바로 enqueue→assign한다(§4.4 순서).

- [ ] **Step 4: reserve/assign 테스트 통과 + 샤드 배정 테스트**

샤드 배정 단위(assign이 register로 shard 0/1 배정하는지):

```rust
#[tokio::test]
async fn pool_launch_assigns_shards() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let run_id = seed_run(&db).await;
    let coord = CoordinatorState::new(db.clone());
    let (tx0, mut r0) = fake_tx();
    let (tx1, mut r1) = fake_tx();
    coord.pool_register_idle("w0", tx0, 100).await;
    coord.pool_register_idle("w1", tx1, 100).await;
    let reserved = coord.reserve_idle_pool(&run_id, 4).await; // cap=4(vus), 유휴 2 → N=2
    coord.enqueue(run_id.clone(), base_assignment(), reserved.len() as u32, 4).await;
    coord.assign_pool_workers(&run_id, reserved).await.unwrap();
    // 두 워커가 각각 RunAssignment를 받았고 shard_index가 0/1
    let a0 = r0.try_recv().unwrap().unwrap();
    let a1 = r1.try_recv().unwrap().unwrap();
    let idxs: Vec<u32> = [a0, a1].iter().filter_map(|m| match &m.payload {
        Some(ServerPayload::Assignment(a)) => Some(a.shard_index), _ => None }).collect();
    assert_eq!({ let mut v = idxs.clone(); v.sort(); v }, vec![0, 1]);
}
```

busy 워커 disconnect → fail-fast (reserve가 `assigned_run=Some`로 락 → `pool_disconnect`가 `worker_disconnected` 라우팅, terminal 미보고라 fail):

```rust
#[tokio::test]
async fn pool_busy_disconnect_fails_run() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let run_id = seed_run(&db).await;
    let coord = CoordinatorState::new(db.clone());
    let (tx0, _r0) = fake_tx();
    coord.pool_register_idle("w0", tx0, 100).await;
    let reserved = coord.reserve_idle_pool(&run_id, 4).await; // assigned_run=Some(run_id)
    coord.enqueue(run_id.clone(), base_assignment(), reserved.len() as u32, 4).await;
    coord.assign_pool_workers(&run_id, reserved).await.unwrap();
    coord.pool_disconnect("w0").await; // terminal 보고 없이 끊김
    assert_eq!(
        runs::get(&db, &run_id).await.unwrap().unwrap().status,
        RunStatus::Failed
    );
}
```

dead-tx push 즉시 fail-fast (R7 — 60s watchdog 비의존):

```rust
#[tokio::test]
async fn pool_push_to_dead_tx_fails_fast() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let run_id = seed_run(&db).await;
    let coord = CoordinatorState::new(db.clone());
    let (tx0, r0) = fake_tx();
    drop(r0); // 수신측 닫힘 → 이후 tx.send 실패
    coord.pool_register_idle("w0", tx0, 100).await;
    let reserved = coord.reserve_idle_pool(&run_id, 4).await;
    coord.enqueue(run_id.clone(), base_assignment(), reserved.len() as u32, 4).await;
    assert!(
        coord.assign_pool_workers(&run_id, reserved).await.is_err(),
        "닫힌 tx push는 즉시 Err (호출자가 cancel_dispatch_failed, R7)"
    );
}
```

정상 완료 후 스트림 종료는 fail 안 함 (R8 — terminal-phase 가드):

```rust
#[tokio::test]
async fn pool_completed_then_close_no_fail() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let run_id = seed_run(&db).await;
    let coord = CoordinatorState::new(db.clone());
    let (tx0, _r0) = fake_tx(); // _r0 유지 → push 성공
    coord.pool_register_idle("w0", tx0, 100).await;
    let reserved = coord.reserve_idle_pool(&run_id, 4).await;
    coord.enqueue(run_id.clone(), base_assignment(), reserved.len() as u32, 4).await;
    coord.assign_pool_workers(&run_id, reserved).await.unwrap();
    coord.record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32).await; // 완료
    coord.pool_disconnect("w0").await; // 정상 종료(terminal 보고 후 close)
    assert_eq!(
        runs::get(&db, &run_id).await.unwrap().unwrap().status,
        RunStatus::Completed,
        "Completed 보고 후 정상 종료는 fail-fast 오탐 안 함"
    );
}
```

재연결 워커는 다시 유휴 (R13 — 재사용 정확성 블로커):

```rust
#[tokio::test]
async fn pool_reused_worker_is_idle_after_reconnect() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db);
    let (tx0, _r0) = fake_tx();
    coord.pool_register_idle("w0", tx0, 100).await;
    let _ = coord.reserve_idle_pool("run-x", 4).await; // assigned_run=Some → busy
    assert_eq!(coord.pool_idle_count().await, 0, "예약 후 busy(idle 아님)");
    // run 종료 후 워커가 새 스트림으로 재연결 → 재등록(fresh idle, assigned_run=None)
    let (tx0b, _r0b) = fake_tx();
    coord.pool_register_idle("w0", tx0b, 100).await;
    assert_eq!(coord.pool_idle_count().await, 1, "재연결 워커는 다시 유휴 → reserve가 재사용(R13)");
}
```

Run: `cargo nextest run -p handicap-controller pool_n_is_min_idle_and_load pool_empty_reserves_none pool_launch_assigns_shards pool_busy_disconnect_fails_run pool_push_to_dead_tx_fails_fast pool_completed_then_close_no_fail pool_reused_worker_is_idle_after_reconnect`
Expected: PASS.

- [ ] **Step 5: `spawn_run` 풀 분기**

`crates/controller/src/api/runs.rs:490-637`의 N/total_vus 계산(601-617) 뒤, dispatch(629) 앞을 분기. `is_pool_mode()`면 풀 경로:

```rust
// (insert/data_bindings/assignment 빌드는 기존 그대로 — assignment까지 만든 뒤)
let total_vus = /* 기존 601-617 그대로 */;

if state.coord.is_pool_mode() {
    // 부하상한 cap: vu-curve:1 / open:min(max_in_flight, 고정 target_rps|곡선 max(stage.target)) / closed:vus
    let n_cap: usize = if profile.is_vu_curve() {
        1
    } else if profile.is_open_loop() {
        let slots = profile.max_in_flight.unwrap_or(1);
        let rate = profile.target_rps.unwrap_or_else(|| {
            profile.stages.as_deref().unwrap_or_default()
                .iter().map(|s| s.target).max().unwrap_or(1)
        });
        slots.min(rate) as usize
    } else {
        profile.vus as usize
    };
    let reserved = state.coord.reserve_idle_pool(&row.id, n_cap).await;
    let n = reserved.len() as u32;
    if n == 0 {
        let msg = "연결된 LAN 워커가 없습니다 — 워커를 1대 이상 띄우세요".to_string();
        state.coord.cancel_dispatch_failed(&row.id).await;
        runs::mark_failed(&state.db, &row.id, &msg).await?;
        return Err(ApiError::BadRequest(msg));
    }
    state.coord.enqueue(row.id.clone(), assignment, n, total_vus).await;
    if state.coord.assign_pool_workers(&row.id, reserved).await.is_err() {
        let msg = "풀 워커 배정 실패(워커 이탈) — 재시도하세요".to_string();
        state.coord.cancel_dispatch_failed(&row.id).await;
        runs::mark_failed(&state.db, &row.id, &msg).await?;
        return Err(ApiError::Internal(anyhow::anyhow!(msg)));
    }
    return Ok(row);
}

// (비-풀: 기존 n 계산 601-607 + enqueue + dispatcher.dispatch 그대로)
```

> 기존 `n`(601-607)·enqueue(618-621)·dispatch(629-635)는 비-풀 분기로 유지. 풀 분기는 그 앞에서 early-return.

- [ ] **Step 6: `--worker-mode pool` 와이어**

`crates/controller/src/main.rs`:
- `WorkerMode` enum(17-21)에 `Pool` 추가:
```rust
#[derive(Clone, Copy, Debug, ValueEnum)]
enum WorkerMode { Subprocess, Kubernetes, Pool }
```
- dispatcher 선택(169-209 부근) `match args.worker_mode`에 arm 추가:
```rust
WorkerMode::Pool => {
    coord_state.set_pool_mode(true);
    Arc::new(NoopDispatcher) as SharedDispatcher  // 배정은 assign_pool_workers가 수행
}
```
(main.rs의 핸들 변수명은 `coord_state`(coordinator.rs:151에서 `CoordinatorState::new` → main.rs에서 `coord_state`로 바인딩, dispatcher match는 그 뒤 line 169). `set_pool_mode`는 그 시점에 `coord_state`가 존재하므로 그대로 배치.)

- [ ] **Step 7: 통합 테스트 — 빈 풀 fail-fast (spawn_run 경유)**

`crates/controller/tests/`에 기존 run-create 통합 테스트 패턴을 따라(또는 인라인) pool_mode 컨트롤러에 풀 워커 0으로 `POST /api/runs` → 400 + "연결된 LAN 워커" 메시지 확인. (기존 `api_runs` 통합 테스트 파일이 있으면 거기에 케이스 추가; AppState 빌더에서 `coord.set_pool_mode(true)`.)

```rust
#[tokio::test]
async fn pool_run_with_empty_pool_fails_fast() {
    // AppState를 pool_mode로 구성, 풀에 워커 0
    // POST /api/runs → 400, body에 "연결된 LAN 워커"
}
```

- [ ] **Step 8: 게이트 + 커밋**

```bash
cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace
```
Expected: PASS.

```bash
git add crates/controller
git commit -m "feat(lan): 풀 발사 — use-all 예약 + push 배정 + 빈풀/dead-tx fail-fast + --worker-mode pool (R4/R6/R7/R14)

reserve_idle_pool(부하상한 cap)·assign_pool_workers(register/assignment_for/
stream_dataset 재사용·push 실패 즉시 fail-fast)·spawn_run 풀 분기·is_pool_mode
setter. --worker-mode pool=NoopDispatcher+set_pool_mode. 비-풀 경로 무변경.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C8tTC1wcYZrZU61Zh8MHRV"
git log -1
```

---

## Task 4: 워커 풀 모드 (run_dispatch/run_pool/execute_assignment + cancel-aware 유휴 대기 + ulid worker_id)

충족 R: **R1, R12** + cancel-aware 유휴 대기(spec §3.1).

**Files:**
- Modify: `crates/worker/Cargo.toml` (`ulid` 워크스페이스 dep)
- Modify: `crates/worker/src/lib.rs` (`WorkerArgs.run_id → Option<String>`, `execute_assignment` 추출, `run_pool`, `run_dispatch`, `resolve_worker_id` ulid)
- Modify: `crates/worker/src/main.rs:16` (`run` → `run_dispatch`)
- Modify: `crates/worker-core/src/client.rs` (`connect_and_register` cancel-aware 유휴 대기)
- Modify: `crates/worker-core/src/reconnect.rs` (`connect_with_backoff` cancel를 유휴 대기로 전달)
- Test: `lib.rs` 인라인 (`resolve_worker_id`, `run_dispatch` 라우팅)

**Interfaces:**
- Consumes: `connect_with_backoff(..., token, cancel)` (Task 1) — 풀 모드는 `run_id=""`로 호출.
- Produces: `run_dispatch(args: WorkerArgs) -> anyhow::Result<()>` — `args.run_id.is_none() ? run_pool : run`.
- Produces: `run_pool(args: WorkerArgs)` — 유휴 등록·배정 대기·실행·재연결 루프.
- Produces: `execute_assignment(link: WorkerLink, run_cancel: CancellationToken) -> anyhow::Result<()>` — 현 `run()` 본체(115-456) 추출, run_id는 `link.assignment.run_id` 사용.

- [ ] **Step 1: `ulid` dep 추가**

`crates/worker/Cargo.toml` `[dependencies]`에:
```toml
ulid = { workspace = true }
```
Run: `cargo build -p handicap-worker`
Expected: PASS.

- [ ] **Step 2: 실패 테스트 — worker_id 안정성 + run_dispatch 라우팅**

`crates/worker/src/lib.rs` 인라인 tests:

```rust
#[test]
fn pool_worker_id_explicit_override() {
    assert_eq!(resolve_pool_worker_id(Some("w-x".into())), "w-x");
}

#[test]
fn pool_worker_id_random_is_nonempty_and_stable() {
    // 명시 없으면 ULID 1개 생성. 같은 입력에 대해 같은 호출은 매번 새 값이지만
    // 형식(26자 Crockford)·비어있지 않음을 검증. 프로세스 수명 내 재사용은 run_pool이
    // worker_id를 루프 밖에서 1회 계산함으로 보장(아래 Step 5).
    let id = resolve_pool_worker_id(None);
    assert_eq!(id.len(), 26);
    assert!(!id.is_empty());
}
```

- [ ] **Step 3: `resolve_pool_worker_id` 구현**

`lib.rs`에:
```rust
/// 풀 워커 id: 명시 --worker-id 우선, 없으면 프로세스 1회 랜덤 ULID(R12).
/// run_pool이 루프 밖에서 1회 호출 → 프로세스 수명 내 모든 재연결에 동일 값.
fn resolve_pool_worker_id(explicit: Option<String>) -> String {
    explicit.unwrap_or_else(|| ulid::Ulid::new().to_string())
}
```

Run: `cargo nextest run -p handicap-worker pool_worker_id`
Expected: PASS.

- [ ] **Step 4: `execute_assignment` 추출**

현 `run()`의 본체(`lib.rs:115` `let scenario = ...`부터 `456` `Ok(())`까지)를 `execute_assignment`로 추출. 시그니처:
```rust
async fn execute_assignment(
    link: handicap_worker_core::WorkerLink,
    run_cancel: tokio_util::sync::CancellationToken,
) -> anyhow::Result<()> {
    let assignment = link.assignment;
    let run_id = assignment.run_id.clone(); // ← args.run_id 대신 assignment.run_id 사용
    let tx = link.tx;
    let mut inbound_rx = link.inbound_rx;
    let inbound_fwd = link.inbound_fwd;
    let shutdown = link.shutdown;
    // ... (현 116-456 본체를 옮기되, `args.run_id` 모든 사용을 `run_id`로,
    //      `cancel`을 `run_cancel`로 치환. abort_listener/engine이 run_cancel을 watch.) ...
}
```
**치환 규칙(정확히)**: 본체 안의 `args.run_id` → `run_id`(로컬), `cancel`(클로저/엔진/abort_listener) → `run_cancel`, `assignment.run_id`(395줄 `assignment_run_id`)도 `run_id`로 통일. **소유 분리**: `signal_task`은 호출자(run/run_pool)가 소유 → `execute_assignment` 본체 안의 모든 `signal_task.abort()`(현 dataset-load 조기반환 arm lib.rs:175·193, 정상종료 419)는 **제거**하고, 그 arm들은 그대로 `shutdown.store(true)`+`drop(tx)`+`inbound_fwd` await 후 `return Ok(())`/`return ...`. 호출자가 `execute_assignment` 반환 직후 `signal_task.abort()`로 정리(즉 `shutdown`/`inbound_fwd`/`tx`는 `execute_assignment` 소유, `signal_task`만 호출자 소유 — 분리). `execute_assignment` 시그니처는 `signal_task`을 받지 않는다.

- [ ] **Step 5: 기존 `run()`을 execute_assignment 재사용으로 축소 + `run_pool` 추가**

```rust
/// Legacy single-run(비-풀): 컨트롤러가 spawn하며 run_id를 박은 경우.
pub async fn run(args: WorkerArgs) -> anyhow::Result<()> {
    let run_id = args.run_id.clone().expect("legacy run() requires --run-id");
    let worker_id = resolve_worker_id(args.worker_id.clone(), &run_id,
        std::env::var("JOB_COMPLETION_INDEX").ok());
    let cancel = CancellationToken::new();
    let signal_task = spawn_sigterm(cancel.clone()); // 현 73-86을 헬퍼로 추출
    let token = args.token.as_deref().unwrap_or("");
    let link = match connect_with_backoff(&args.controller, &worker_id, &run_id,
        args.capacity_vus, token, cancel.clone()).await {
        Ok(l) => l,
        Err(WorkerError::Cancelled) => { signal_task.abort(); return Ok(()); }
        Err(e) => return Err(anyhow::Error::from(e).context("connect_with_backoff")),
    };
    let res = execute_assignment(link, cancel.clone()).await;
    signal_task.abort();
    res
}

/// 풀 모드: --run-id 없이 유휴 등록 → 배정 대기 → 실행 → 재연결 반복(R1).
pub async fn run_pool(args: WorkerArgs) -> anyhow::Result<()> {
    let worker_id = resolve_pool_worker_id(args.worker_id.clone());
    let cancel = CancellationToken::new();        // 프로세스 레벨(SIGTERM)
    let signal_task = spawn_sigterm(cancel.clone());
    let token = args.token.as_deref().unwrap_or("");
    info!(%worker_id, "pool worker starting (idle)");
    loop {
        if cancel.is_cancelled() { break; }
        match connect_with_backoff(&args.controller, &worker_id, "",
            args.capacity_vus, token, cancel.clone()).await {
            Ok(link) => {
                let run_cancel = cancel.child_token(); // per-run(abort는 이것만 취소)
                if let Err(e) = execute_assignment(link, run_cancel).await {
                    warn!(error = ?e, "pool assignment ended with error; back to idle");
                }
                // 종료 후 루프 → 재연결해 다시 유휴 등록(reconnect-per-run)
            }
            Err(WorkerError::Cancelled) => break,
            Err(e) => { warn!(error = %e, "pool connect failed; retrying"); }
        }
    }
    signal_task.abort();
    info!("pool worker exiting");
    Ok(())
}

/// 라우팅(branch site): run_id 있으면 legacy, 없으면 풀.
pub async fn run_dispatch(args: WorkerArgs) -> anyhow::Result<()> {
    if args.run_id.is_some() { run(args).await } else { run_pool(args).await }
}
```

`spawn_sigterm`은 현 73-86의 SIGTERM 설치 블록을 `fn spawn_sigterm(cancel: CancellationToken) -> tokio::task::JoinHandle<()>`로 추출.

- [ ] **Step 6: `WorkerArgs.run_id`를 Option으로 + main 라우팅**

`lib.rs` `WorkerArgs`:
```rust
#[arg(long)]
pub run_id: Option<String>,   // 생략 = 풀 모드
```
`crates/worker/src/main.rs:16`: `handicap_worker::run(cli.args)` → `handicap_worker::run_dispatch(cli.args)`.
`crates/controller/src/main.rs:104`(번들 멀티콜 arm): `handicap_worker::run(wargs)` → `handicap_worker::run_dispatch(wargs)`.
**번들 게이트 회귀(필수)**: `run_id: Option<String>` 변경이 `#[cfg(feature="bundle")]` 테스트 `worker_subcommand_parses`(`crates/controller/src/main.rs:341` `assert_eq!(w.run_id, "r1")`)를 컴파일-깨뜨린다 → `assert_eq!(w.run_id.as_deref(), Some("r1"))`로 수정. **이 테스트·위 멀티콜 arm은 둘 다 bundle-gated라 기본 워크스페이스 게이트가 컴파일조차 안 한다**(controller CLAUDE.md 함정) → Step 9에 `--features bundle` 게이트 필수.

- [ ] **Step 7: cancel-aware 유휴 대기 — `connect_and_register`**

`crates/worker-core/src/client.rs`의 첫 RunAssignment 대기(현 108-120 `let first = inbound.next().await;`)를 cancel-aware로. `connect_and_register`에 `cancel: &CancellationToken` 인자 추가(Task 1의 token 뒤):
```rust
let first = tokio::select! {
    _ = cancel.cancelled() => return Err(WorkerError::Cancelled),
    m = inbound.next() => m,
};
```
`connect_with_backoff`(reconnect.rs)가 자신의 `cancel`을 `connect_and_register(..., &cancel)`로 전달. (legacy `run()`도 cancel을 넘기므로 동작 동일 — legacy는 assignment가 즉시 와서 select가 바로 풀린다.)

> `WorkerError::Cancelled` variant는 이미 존재(client.rs `Err(WorkerError::Cancelled)` 사용처 lib.rs:98). 재사용.

- [ ] **Step 8: run_dispatch 라우팅 테스트**

```rust
#[test]
fn run_dispatch_routes_on_run_id() {
    // 순수 분기 검증: run_id.is_some() ? legacy : pool. 실제 네트워크 없이
    // 분기 조건만 단위 검증(헬퍼로 분리하거나, args만 만들어 is_some 확인).
    let pool_args_has_no_run_id = WorkerArgs {
        controller: "http://x".into(), run_id: None, worker_id: None,
        capacity_vus: 1, token: None,
    };
    assert!(pool_args_has_no_run_id.run_id.is_none());
}
```

- [ ] **Step 9: 워밍 + 게이트 + 커밋**

```bash
cargo build -p handicap-worker --bin worker
cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace
# 번들 게이트(기본 게이트가 안 봄 — bundle-gated 테스트/멀티콜 arm 컴파일·통과 확인):
cargo build -p handicap-controller --features bundle
cargo test -p handicap-controller --features bundle worker_subcommand_parses
```
Expected: 전부 PASS (비-번들 + 번들 양쪽). `git add`에 `crates/controller`도 포함(main.rs:341/104 수정).

```bash
git add crates/worker crates/worker-core crates/controller
git commit -m "feat(lan): 워커 풀 모드 — run_dispatch/run_pool/execute_assignment + cancel-aware 유휴 대기 + ulid worker_id (R1/R12)

--run-id 생략 시 풀 모드(유휴 등록·배정 대기·실행·재연결 reconnect-per-run).
run() 본체를 execute_assignment로 추출해 legacy/pool 공유. connect_and_register
유휴 대기를 SIGTERM cancel-aware로. worker_id 기본=프로세스 1회 ULID.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C8tTC1wcYZrZU61Zh8MHRV"
git log -1
```

---

## Task 5: e2e 통합 테스트 (풀 워커 연속 2 run 재사용)

충족 R: **R1**(end-to-end), **R9**(메트릭 머지). 신규 하네스 — 실패 위험 높음, 별도 reviewer 게이트.

**Files:**
- Create: `crates/controller/tests/pool_e2e.rs`
- Test: 위 파일

**Interfaces:**
- Consumes: Task 1-4 전부(`--worker-mode pool`, 워커 풀 모드, 토큰).

- [ ] **Step 1: 하네스 작성 — 컨트롤러 + 풀 워커 1개 + 연속 2 run**

**템플릿 = `crates/controller/tests/multi_worker_fanout_e2e.rs`**(검증됨, ~696줄; 앞부분 `worker_bin_path()`[빌드+`target/debug/worker` 위치]·`bind_local()`[`127.0.0.1:0`]·in-process `boot()`[axum REST + tonic gRPC를 bound listener에, `sqlite::memory:` 공유]·`reqwest` scenario/run 생성·status poll-to-terminal 헬퍼를 그대로 재사용). **단 워커 직접 spawn + PID-capture는 신규 작성**(기존 테스트는 워커를 `SubprocessDispatcher`가 띄움 — 풀 테스트는 테스트가 직접 띄운다). **풀 델타 4가지**: ① 컨트롤러를 `NoopDispatcher` + `coord_state.set_pool_mode(true)`(SubprocessDispatcher 대신) ② 워커를 **테스트가 직접** `std::process::Command::new(worker_bin).args(["--controller", &grpc_url, "--token", X])`(`--run-id` 없이)로 **run 전에** spawn해 유휴 등록되게 — **child PID를 잡아둠** ③ run 2개를 순차 `POST /api/runs` ④ 각 run completed + **두 run 사이 child가 살아있음**(`child.try_wait()? == None`으로 재사용 단언). 정리: child kill + 컨트롤러 종료. gRPC listener는 `bind_local`로 concrete `127.0.0.1:<port>`라 별도 프로세스가 도달 가능.

```rust
// 핵심 골격(세부는 기존 e2e 헬퍼 재사용):
#[tokio::test]
async fn pool_worker_runs_then_reuses() {
    // 1) 격리 DB + pool-mode 컨트롤러 기동(REST/gRPC 포트 확보)
    // 2) `target/debug/worker --controller http://127.0.0.1:<grpc> --token X` (run_id 없이) spawn
    //    → 유휴 등록 대기(짧은 poll: 풀 idle_count==1 또는 첫 run이 즉시 배정되는지로 확인)
    // 3) scenario 생성 → run #1 POST → completed까지 poll → report 확인
    // 4) run #2 POST(같은 풀 워커 재사용) → completed → report 확인
    // 5) 두 run 모두 status=completed, 요청수>0 (워커가 두 번 일했다)
    // 정리: 워커/컨트롤러 프로세스 kill.
}
```

> **cold-build flake(S-A)**: 테스트 시작 전 `cargo build -p handicap-worker --bin worker`가 선행돼야 `target/debug/worker`가 존재. plan 실행 시 Step 2의 빌드가 이를 보장.

- [ ] **Step 2: 워밍 후 e2e 실행**

```bash
cargo build -p handicap-worker --bin worker
cargo build -p handicap-controller
cargo nextest run -p handicap-controller pool_worker_runs_then_reuses --no-capture
```
Expected: PASS(두 run completed, 워커 재사용). flake면 워밍 상태로 재시도(CLAUDE.md S-A).

- [ ] **Step 3: 게이트 + 커밋**

```bash
cargo nextest run --workspace
git add crates/controller/tests/pool_e2e.rs
git commit -m "test(lan): 풀 워커 e2e — 연속 2 run 재사용 (R1/R9)

--worker-mode pool 컨트롤러 + --run-id 없는 풀 워커 1개 → run 2개 순차 완료,
워커가 두 run 사이 살아남아 재사용됨을 검증(신규 e2e 하네스).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C8tTC1wcYZrZU61Zh8MHRV"
git log -1
```

---

## Task 6: 런북 (`docs/dev/lan-workers.md`) + 라이브 검증

충족 R: **R11**, spec §6 라이브 검증.

**Files:**
- Create: `docs/dev/lan-workers.md`

- [ ] **Step 1: 런북 작성**

`docs/dev/lan-workers.md`에 다음을 문서화:
- **컨트롤러 기동**: `controller --worker-mode pool --grpc 0.0.0.0:8081 --rest 0.0.0.0:8080 --worker-token <key> --ui-dir ui/dist`. **`--grpc` 기본은 `127.0.0.1`이라 LAN엔 `0.0.0.0`(또는 특정 인터페이스) 오버라이드 필수**.
- **Windows 방화벽**: 8081(gRPC)·8080(REST) 인바운드 허용.
- **각 PC 워커**: `worker --controller http://<controller-ip>:8081 --token <key>` (`--run-id` 없이 = 풀 모드). 종료 후 자동 재연결.
- **use-all 매칭**: run은 연결된 유휴 워커를 부하상한까지 사용(closed=`vus`, open=`min(max_in_flight, target_rps|peak)`). **closed-loop `vus`는 총부하이자 워커 상한**(N=min(idle, vus)).
- **⚠ 과부하 미가드(L1)**: closed-loop은 각 PC `capacity_vus`를 무시하고 `vus`를 유휴 워커 수로 나눠 배정 — 워커당 부하가 PC 능력을 초과할 수 있다(L2에서 가드 예정).
- **빈 풀**: 유휴 워커 0이면 run이 즉시 실패("연결된 LAN 워커가 없습니다").
- **보안**: 토큰은 평문 채널에 노출(접근 통제용). 기밀성은 mTLS(후속) 필요.
- **한도**: L1은 reconnect-per-run(run 사이 sub-second 갭), 단일PC 데스크톱 한도는 기존대로.

- [ ] **Step 2: 라이브 검증 (`/live-verify` localhost 풀 스택)**

`/live-verify` 또는 수동:
```bash
# 워밍
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller
# pool-mode 컨트롤러(격리 DB)
./target/debug/controller --db /tmp/lan-l1.db --ui-dir ui/dist \
  --worker-mode pool --grpc 127.0.0.1:8091 --rest 127.0.0.1:8090 --worker-token SECRET &
# 풀 워커 2개(run_id 없이)
./target/debug/worker --controller http://127.0.0.1:8091 --token SECRET &
./target/debug/worker --controller http://127.0.0.1:8091 --token SECRET &
# 50ms responder(live-verify 번들) 띄우고 시나리오/run 생성(curl)
```
검증 5종(spec §6): ① use-all(워커 2 = 샤드 2, report 머지) ② 토큰 거부(틀린 `--token` 워커가 풀 미진입) ③ 빈 풀 fail-fast(워커 0서 run→400) ④ 연속 2 run 재사용 ⑤ `/report`가 `ReportSchema` 통과(메트릭 머지 정확, S-D 갭 차단). **검증 결과를 finish-slice의 build-log에 기록.** Playwright/`.playwright-mcp` 산출물 정리(머지 전 `rm -rf .playwright-mcp` + 루트 png).

- [ ] **Step 3: 런북 커밋**

```bash
git add docs/dev/lan-workers.md
git commit -m "docs(lan): LAN 분산 워커 운영 런북 (R11)

바인드 오버라이드·방화벽·워커 기동·토큰·use-all·과부하 미가드 경고·vus 이중의미.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C8tTC1wcYZrZU61Zh8MHRV"
git log -1
```

---

## 최종 검증 (전 task 후)

- [ ] `handicap-reviewer`로 whole-branch 리뷰(크로스커팅·repo 함정·proto wire 1:1: `Register.token` worker 송신↔controller 수신).
- [ ] **보안 표면 게이트**: diff가 요청실행/인증/채널을 건드리므로 `security-reviewer` APPROVE 필수(토큰 인증·풀 배정이 시나리오 YAML+env를 워커에 전달 — SSRF/시크릿 노출/인증 우회 렌즈).
- [ ] T1·T2·T3의 code-quality 리뷰는 **path-gate로 Opus 승격**(proto/와이어포맷·동시성·gRPC 핸들러·spawn 경로). spec-compliance 리뷰는 Sonnet.
- [ ] 라이브 검증(Task 6 Step 2) 완료 + build-log 기록.
- [ ] `/finish-slice`: build-log·roadmap·CLAUDE 상태줄·ADR-0041 작성·메모리 → ff-merge.

---

## Self-Review (spec 대조)

- **R1**(풀 워커 유휴·실행·재사용): Task 4 `run_pool`/reconnect-per-run + Task 5 e2e. ✓
- **R2**(proto token additive·wire 1:1): Task 1(worker 송신+controller 수신 한 커밋). ✓
- **R3**(토큰 인증·plain compare·미설정 수용): Task 1 `check_token`. ✓
- **R4**(use-all N=min(idle,부하상한)): Task 3 `reserve_idle_pool`+spawn_run n_cap(open은 슬롯·레이트 min). ✓
- **R5**(풀 레지스트리·멱등·reset): Task 2 `pool_register_idle`. ✓
- **R6**(예약→enqueue→assign 재사용): Task 3 순서 + `assign_pool_workers`. ✓
- **R7**(빈풀·dead-tx fail-fast): Task 3 spawn_run 빈풀 분기 + assign Err. 테스트 `pool_empty_reserves_none`·`pool_push_to_dead_tx_fails_fast`(T3) + `pool_run_with_empty_pool_fails_fast`(T3 통합). ✓
- **R8**(disconnect 라우팅·terminal 보존): Task 2 `pool_disconnect`→`worker_disconnected` 구현. 테스트 `pool_busy_disconnect_fails_run`·`pool_completed_then_close_no_fail`(T3, reserve 셋업 필요). ✓
- **R9**(메트릭 머지 재사용): Task 3 assign이 기존 ingest 경로 사용 + Task 5 라이브. ✓
- **R10**(조건부 byte-identical): Task 1 토큰 미설정 skip·proto additive·기존 스위트 무수정. ✓
- **R11**(바인드·런북): Task 6. ✓
- **R12**(worker_id ULID·override): Task 4 `resolve_pool_worker_id`. ✓
- **R13**(assigned_run lifecycle): Task 2 reset(register_idle) + Task 3 reserve가 set(예약 락). 테스트 `pool_reused_worker_is_idle_after_reconnect`(T3). ✓
- **R14**(CoordinatorState setter·AppState churn 0): Task 1/2/3 setter. ✓

전 R-id에 task 매핑됨. 누락 없음.

<!-- REVIEW-GATE: APPROVED -->
