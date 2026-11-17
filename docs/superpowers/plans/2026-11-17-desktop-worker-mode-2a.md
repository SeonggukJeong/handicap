# 데스크톱 부하기 모드 2a (라이브러리·와이어) Implementation Plan

<!-- REVIEW-GATE: APPROVED -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데스크톱 셸(2b)이 부하기 상태 화면을 그릴 수 있도록 worker-core에 상태 사건 통로·IP 탐침·포기하지 않는 연결 루프를 만들고, 컨트롤러에 등록 직후 `Ping`과 「한 부하기 중단 = run 전체 중단」(R8)을 넣는다.

**Architecture:** 컨트롤러는 기존 메시지만으로 두 신호를 더한다(등록 직후 `Ping`, 부하기 스스로 중단 시 형제 abort + 사유). worker-core는 사건 타입·이유 분류·사건 → 상태 추적기(15초 유예)·탐침을 순수 함수로 갖고, `connect_and_register`에 선택 옵션(연결 상한·수락 콜백)을 더한다(기존 함수는 기본값 위임 = CLI 불변). worker lib에 데스크톱 전용 진입점 `run_pool_desktop`이 탐침 → 등록 → 기존 `execute_assignment`를 돌며 사건을 낸다.

**Tech Stack:** Rust(tokio, tonic 0.12, tokio-util `CancellationToken`), sqlx(SQLite), cargo nextest, wiremock(controller dev-dep).

**Spec:** `docs/superpowers/specs/2026-11-17-desktop-worker-mode-design.md` — 이 plan은 그 **2a 절(R0a·R3·R4·R8·2a 검증)** 과 §7 「2a plan」 순서를 구현한다. 2b 절(R1·R2·R5·R6·R7)은 범위 밖(2a 머지 뒤 별도 plan).

## Global Constraints

- CLI 워커(`run`/`run_pool`/`run_pool_until`)의 인자·로그·재시도 일정(1·2·4·8s, 60s 포기 후 재사이클) 불변. 기존 `retry_with_backoff(f, cancel)`·`connect_with_backoff(…)`·`connect_and_register(…)` **시그니처 불변**(호출처: `crates/worker/src/lib.rs:450,500`, `crates/worker-core/tests/reconnect_backoff_test.rs`는 `retry_with_backoff`). 배정 대기의 기존 로그 `warn!(?other, "expected RunAssignment, got something else")`(`client.rs:167`)는 새 `Abort` 갈래에서도 그대로 찍는다.
- proto 메시지·필드·migration·REST 추가 0. 엔진 무변경.
- 사유 문자열 `"authentication failed"`는 `handicap-proto`의 공개 상수 하나(`AUTH_FAILED_REASON`)로 공유.
- 서버가 보낸 문자열은 Rust에서 자른다: 시나리오 이름 80자, 배정 전 Abort 사유 200자(`char` 단위).
- 탐침·연결 상한 = 2초(`PROBE_TIMEOUT`). 유예 = 15초(`GRACE`). 데스크톱 재시도 일정 = `reconnect::SCHEDULE` 재사용(1·2·4·8s, 이후 8s), 포기 없음, 수락 뒤 시도 카운터 0.
- R8 사유 message(영어 원문): `worker {worker_id} stopped mid-run — run aborted` + 형제가 1개 이상이면 ` (other workers stopped)`, 전체를 기존 `truncate_message`(`coordinator.rs:1026` 형제 실패 경로가 쓰는 것)로 감싼다.
- **controller의 `in-process` 테스트는 `-p handicap-controller --features in-process`로만 돈다**(기본 기능이 아니다 — 워크스페이스 전체 실행에서만 `crates/tui`가 켜 준다). 이 plan의 controller nextest 명령은 전부 이 플래그를 단다.
- **tdd-guard**: `crates/*/src/*.rs` 편집은 그 파일에 이미 `#[cfg(test)]`가 있거나, 편집 내용이 `#[cfg(test)]`를 더하거나, pending 테스트 경로 파일(`tests/*.rs`·`_test.rs`)이 있어야 통과한다. `worker-core/src/error.rs`·`lib.rs`·`crates/proto/src/lib.rs`·`crates/worker/src/lib.rs`(있으면 통과)는 각 task의 **첫 스텝이 만드는 `tests/` 파일**로 연다.
- clippy `-D warnings`: 새 `pub fn new()` 타입엔 `impl Default`, 8개 넘는 인자 함수엔 `#[allow(clippy::too_many_arguments)]`(`client.rs:101` 선례).
- 통합 테스트(controller `tests/`)에서 `tokio::time::pause` 금지(sqlx `PoolTimedOut` — controller CLAUDE.md). worker-core 단위 테스트의 가상 시간은 `#[tokio::test(start_paused = true)]` + **`tokio::time::Instant`로 측정**(worker-core CLAUDE.md).
- 커밋마다 cargo 게이트(pre-commit) — implementer의 commit은 단일 FOREGROUND 호출(600000ms), `| tail` 금지, `--no-verify` 금지.
- 마무리 기록(build-log·roadmap §B — spec §5 판단 7건·`HANDICAP_WORKER_TOKEN` 재연기·§8 (2a) 릴리즈 노트 줄)은 이 plan 밖, `/finish-slice`에서.

## Review Focus

1. **실행 중에 대시보드 「제외」** → 「연결됨 · 대기」(유예)가 아니라 「제외됨」, 그 사이 `RunEnded` 없음 — Task 5 `excluded_while_running_emits_excluded`.
2. **REST 중단과 워커 `Aborted` 보고가 경합**(DB가 아직 `running`) → run message는 R8 문구가 아니라 `NULL` — Task 2 ②와 변형 ④, 둘 다 이빨 실증.
3. **IP 후보 중 하나가 응답 없는(패킷을 버리는) 주소** → 다른 후보로 2초 안에 붙는다 — Task 4 `probe_skips_blackhole`(가상 시간 `tokio::time::Instant` 측정 + 회귀 실증).
4. **수락됐던 세션이 끊긴 뒤 재시도 간격이 처음부터 다시** → `retry_in`이 1s부터 — Task 5 `retry_counter_resets_after_accept`(CLI식 누적 일정이면 RED).
5. **토큰 불일치 코드** → 이유 `AuthFailed`, 계속 재시도 — Task 3(사유 보존) + Task 5 `wrong_token_reports_auth_failed`.

---

### Task 1: 등록 직후 Ping + 사유 상수 (R3 컨트롤러 쪽)

**Files:**
- Create: `crates/controller/tests/pool_register_ping_test.rs` (`#![cfg(feature = "in-process")]`)
- Modify: `crates/proto/src/lib.rs` (상수)
- Modify: `crates/controller/src/grpc/coordinator.rs:1323-1350` (토큰 불일치 사유를 상수로, 풀 분기에서 `pool_register_idle` **전** `Ping`)

**Interfaces:**
- Produces: `handicap_proto::AUTH_FAILED_REASON: &str = "authentication failed"` (Task 3·4가 씀).

- [ ] **Step 1: 실패하는 통합 테스트** — `in_process_pool_rejoin_test.rs`의 `start_pool` 패턴(토큰 `"t"`, 빈 포트, `grpc_port_fallback: false`; 하트비트 설정은 손대지 않는다 — 리퍼가 첫 틱 전에 `interval`(기본 10s)만큼 잠들어 있어 2초 창 안의 Ping은 새 Ping뿐, `in_process.rs:414-421`). tonic `CoordinatorClient`로 붙어 `Register{run_id:"", token, worker_id:"ping-w1", hostname:"h", stable_id:false, capacity_vus:10}` 전송.
  - `first_message_after_pool_register_is_ping`: 2초 안에 첫 서버 메시지가 `ServerPayload::Ping(_)`.
  - `wrong_token_abort_reason_is_auth_failed`: 틀린 토큰 → 첫 메시지 `Abort{reason}`, `reason == "authentication failed"`(이 스텝에선 리터럴 — 상수 대조는 Step 3 뒤 한 줄 추가).
- [ ] **Step 2: RED** — `cargo nextest run -p handicap-controller --features in-process --test pool_register_ping_test` → 첫 테스트 실패(2초 안에 Ping 없음), 둘째 PASS.
- [ ] **Step 3: 구현** — 상수 추가; `coordinator.rs:1329` 리터럴 → 상수; 풀 분기(`reg.run_id.is_empty()`)에서 `let _ = tx.send(Ok(ServerMessage{ payload: Some(ServerPayload::Ping(pb::Ping{nonce:0})) })).await;`를 `pool_register_idle` 호출 **앞**에. 테스트 둘째에 `assert_eq!(reason, handicap_proto::AUTH_FAILED_REASON)` 추가.
- [ ] **Step 4: GREEN** — 같은 명령 PASS + `cargo nextest run -p handicap-controller --features in-process` 전체 green.
- [ ] **Step 5: 커밋** — `feat(controller): 풀 등록 직후 Ping, 인증 실패 사유 상수 공유`

### Task 2: 한 부하기 중단 = run 전체 중단 (R8)

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` — `RunWorkers`(:139, 리터럴은 `enqueue` 안 :729 하나)에 `abort_requested: bool`(초기 `false`), `abort()`(:1129), `record_phase`(:884)의 `Finalize::Aborted` 결정·arm(:925-928, :970-978)
- Test: 같은 파일 `mod tests`(헬퍼 `seed_run`·`base_assignment`·`fake_tx`(채널 8)·`LONG` 재사용 — 파일에 `#[cfg(test)]`가 있어 tdd-guard 통과)

**Interfaces:**
- Consumes: `store::runs::mark_aborted_if_active(db, id, message) -> sqlx::Result<bool>`(`store/runs.rs:441` — `ended_at`·`message` 함께 기록, `pending|running` 가드).
- Produces: 동작만(외부 시그니처 불변).

- [ ] **Step 1: 실패하는 단위 테스트 6개**
  - ① `self_abort_fans_out_to_siblings_with_message`: 2워커 enqueue+register → `record_phase(w0, Aborted, "")` → `r1.try_recv()`가 `Abort`, run status `Aborted`, message `== "worker w0 stopped mid-run — run aborted (other workers stopped)"`.
  - ① ′ `self_abort_single_worker_message_has_no_sibling_suffix`: 1워커 → message `== "worker w0 stopped mid-run — run aborted"`.
  - ② `controller_abort_then_worker_aborted_keeps_null_message`: 2워커 → `coord.abort(&run_id).await`(DB `running` 그대로) → `record_phase(w0, Aborted)` → status `Aborted`, message `None`; `r1`의 Abort는 **정확히 1개**(`abort()` 몫 — `try_recv` 두 번째는 `Err`).
  - ③ `prior_guarded_message_survives`: `mark_aborted_if_active(&db,&run_id,"X")` + `coord.abort` → `record_phase(w0, Aborted)` → message `"X"` + `r1`의 Abort는 **정확히 1개**(두 번째 fan-out 없음).
  - ③′ `prior_db_abort_without_coord_abort_keeps_message`: 2워커 → `mark_aborted_if_active(&db,&run_id,"X")`만(**`coord.abort` 없음** — `abort_active_runs`가 DB를 먼저 쓰고 `coord.abort`를 나중에 부르는 틈, `in_process.rs:231-233`) → `record_phase(w0, Aborted)` → message `"X"`(R8 가드 쓰기가 아무것도 안 함) + `r1`이 Abort 1개 수신(DB가 이미 terminal이어도 R8은 형제를 멈춘다).
  - ④ `abort_flag_set_before_sends`: w1 tx를 `mpsc::channel(1)`로 만들어 미리 1개 채움(수신자는 보관), w0은 `fake_tx` → `abort()`를 spawn(가득 찬 채널에서 막힘 — HashMap 순서 가정 금지) → `tokio::time::sleep(50ms)` → `tokio::time::timeout(2s, coord.record_phase(w0, Aborted))`를 `.expect("record_phase가 막힘 = 표시가 전송 뒤")` → `runs::get` message `None` → 끝에 w1 수신자를 비워 spawn한 `abort()`를 join.
- [ ] **Step 2: RED** — `cargo nextest run -p handicap-controller --features in-process --lib -- coordinator::tests::self_abort coordinator::tests::controller_abort coordinator::tests::prior coordinator::tests::abort_flag` → ①·①′·③′ 실패(message `None`/Abort 없음). ②·③·④는 지금도 PASS(현 `set_status`는 message를 안 쓰고 fan-out도 없다) — 이들의 이빨은 Step 5에서.
- [ ] **Step 3: 구현**
  - `abort()`: 잠금을 `let mut g`로, `Some(rw)`이면 **같은 블록 안에서** `rw.abort_requested = true` 후 tx 복사 → 잠금 해제 → `fan_out_abort`(그대로).
  - `Finalize::Aborted` → `Finalize::Aborted { self_abort: Option<Vec<WorkerTx>> }`: `rw.abort_requested`면 `None`, 아니면 `phase`가 `Completed|Failed|Aborted`가 아닌 다른 워커들의 tx.
  - arm: `None` → 기존(`set_status(Aborted)` + cleanup). `Some(siblings)` → `mark_aborted_if_active(db, run_id, &truncate_message(msg))`(에러는 `warn!` 후 계속) → `fan_out_abort(run_id, &siblings, "sibling worker aborted — run stopped")` → cleanup.
- [ ] **Step 4: GREEN** — 위 명령 + `cargo nextest run -p handicap-controller --features in-process` 전체(in_process `abort_active_runs_*` 포함).
- [ ] **Step 5: 이빨 실증(필수, 리포트에 기록)** — (a) `abort()`의 표시를 `fan_out_abort` **뒤** 별도 잠금으로 옮김 → ④ RED(단언/expect 실패, 러너 타임아웃 아님) → 원복. (b) `record_phase`에서 `rw.abort_requested` 확인을 지워 항상 R8 → ②(message·두 번째 Abort)·③(두 번째 Abort — message는 가드 때문에 `"X"` 그대로) RED → 원복. (c) R8 경로의 `mark_aborted_if_active`를 무가드 `UPDATE … SET status='aborted', message=?`로 바꿔 ③′ message RED → 원복. 마지막에 GREEN.
- [ ] **Step 6: 데스크톱 1차 순서 테스트(게이트 밖, 수동)** — 워크트리에 `ui/dist`가 없으면 `cd ui && pnpm install && pnpm build && cd ..`(또는 `just ui-build`) 뒤 `cd desktop/src-tauri && cargo test -- switch_marks_self_worker_run_aborted_not_failed shutdown_marks_self_worker_run_aborted_with_app_exit` PASS.
- [ ] **Step 7: 커밋** — `fix(controller): 부하기가 스스로 중단하면 형제도 중단하고 run에 사유를 남김`

### Task 3: 배정 전 Abort 사유 보존 + 등록 옵션 (R3 워커 쪽, R4 일부)

**Files:**
- Create: `crates/worker-core/tests/register_opts_test.rs` (첫 스텝 — tdd-guard를 연다; tonic `Coordinator` 서비스 스텁을 `127.0.0.1:0`에 띄워 원하는 서버 메시지를 순서대로 보냄)
- Modify: `crates/worker-core/src/error.rs` (변형 2개 + 접근자)
- Modify: `crates/worker-core/src/client.rs:101-200` (`connect_and_register_opts`, 기존 함수는 위임, 배정 대기의 `other =>` 갈래에서 `Abort` 구별)
- Modify: `crates/worker-core/src/lib.rs` (재수출)

**Interfaces:**
- Produces:
  - `WorkerError::AbortedBeforeAssignment { reason: String }` — `#[error("missing assignment after register")]`(Display = `NoAssignment`과 같음). `reason`은 200자로 자른 값.
  - `WorkerError::ConnectTimeout` — `#[error("connect timed out")]`(단위 변형).
  - `impl WorkerError { pub fn abort_reason(&self) -> Option<&str> }`
  - `#[derive(Default)] pub struct RegisterOpts<'a> { pub connect_timeout: Option<Duration>, pub on_accepted: Option<&'a (dyn Fn() + Send + Sync)> }`
  - `#[allow(clippy::too_many_arguments)] pub async fn connect_and_register_opts(controller_url: &str, worker_id: &str, run_id: &str, capacity_vus: u32, token: &str, hostname: &str, stable: bool, cancel: &CancellationToken, opts: RegisterOpts<'_>) -> Result<WorkerLink, WorkerError>`
    - `connect_timeout`이 `Some(d)`면 `Endpoint::connect_timeout(d)` **와** "채널 연결 + `client.channel()` + Register 전송" 구간 전체를 `tokio::time::timeout(d, …)`로 감싸고 초과 시 `ConnectTimeout`. **배정 대기(유휴)는 감싸지 않는다**(2초마다 유휴 워커가 끊긴다). `Endpoint::timeout`(요청별 상한 — bidi 스트림을 죽인다)은 쓰지 않는다.
    - `on_accepted`: 배정 대기 중 **첫** `Ping` 수신 때, 또는 아직 안 불렸으면 `Assignment` 수신 때 정확히 한 번.
    - 배정 대기 중 `Abort{reason}` → `warn!(?other, …)`(기존 로그 그대로) 뒤 `Err(AbortedBeforeAssignment{reason: 200자})`.
  - 기존 `connect_and_register(…)` = `connect_and_register_opts(…, RegisterOpts::default())`.

- [ ] **Step 1: 실패하는 테스트**(`tests/register_opts_test.rs`)
  - `abort_before_assignment_keeps_reason`: 스텁이 `Abort{reason:"authentication failed"}` → `e.abort_reason()==Some("authentication failed")`, `e.to_string()=="missing assignment after register"`.
  - `abort_reason_is_clipped_to_200_chars`: 300자 사유 → `abort_reason().unwrap().chars().count()==200`.
  - `on_accepted_fires_once_on_first_ping`: Ping, Ping, Assignment → 콜백 1회, `Ok`.
  - `on_accepted_fires_on_assignment_without_ping`: Assignment만 → 1회.
  - `default_opts_never_call_back_and_match_old_behaviour`: `connect_and_register`(옛 함수)로 Abort → 같은 `Display`.
  - `connect_timeout_bounds_silent_listener`: TCP만 받고 아무 바이트도 안 보내는 로컬 리스너(`tokio::net::TcpListener` accept 후 소켓을 쥐고 잠듦) → `connect_timeout: Some(300ms)`로 `Err(ConnectTimeout)`이 1초 안(실시간 — 통합 성격이라 `pause` 금지). 이빨: 옵션을 `None`으로 바꾸면 3초 안에 안 끝남 → 테스트를 `tokio::time::timeout(3s, …)`로 감싸 RED가 단언 실패로 보이게.
  - `tests/error_size.rs` 그대로 green(128B 이하).
- [ ] **Step 2: RED** — `cargo nextest run -p handicap-worker-core --test register_opts_test` → 컴파일 에러(미정의).
- [ ] **Step 3: 구현** — Interfaces대로.
- [ ] **Step 4: GREEN** — `cargo nextest run -p handicap-worker-core` 전체 + `cargo nextest run -p handicap-worker` + `cargo nextest run -p handicap-controller --features in-process --test in_process_pool_rejoin_test`.
- [ ] **Step 5: 이빨 실증** — `connect_timeout_bounds_silent_listener`를 바깥 `tokio::time::timeout` 감쌈을 지운 구현으로 돌려 RED → 원복(리포트 기록).
- [ ] **Step 6: 커밋** — `feat(worker-core): 배정 전 Abort 사유 보존, 등록 옵션(연결 상한·수락 콜백)`

### Task 4: 상태 사건·이유 분류·추적기·탐침 (R4 순수 로직)

**Files:**
- Create: `crates/worker-core/tests/pool_status_api_test.rs` (첫 스텝 — 2b가 쓸 공개 이름을 잠그고 tdd-guard를 연다)
- Create: `crates/worker-core/src/pool_status.rs` (인라인 `#[cfg(test)]` 단위 테스트 포함)
- Modify: `crates/worker-core/src/lib.rs` (`pub mod pool_status;`)

**Interfaces:**
- Consumes: `WorkerError::abort_reason`·`ConnectTimeout`(Task 3), `handicap_proto::AUTH_FAILED_REASON`(Task 1), `reconnect::SCHEDULE`.
- Produces (Task 5·2b가 이름 그대로 씀):
  - `pub const PROBE_TIMEOUT: Duration = Duration::from_secs(2); pub const GRACE: Duration = Duration::from_secs(15);`
  - `#[derive(Debug, Clone, PartialEq, Eq)] pub enum FailReason { Unreachable, AuthFailed, Rejected(String), Protocol }`
  - `pub fn classify(err: &WorkerError) -> FailReason` — `Connect`·`InvalidUri`·`ConnectTimeout` → `Unreachable`; `abort_reason()==Some(AUTH_FAILED_REASON)` → `AuthFailed`; 다른 `abort_reason()` → `Rejected(그 문자열)`; 나머지 → `Protocol`.
  - `#[derive(Debug, Clone, PartialEq, Eq)] pub enum PoolEvent { Probing { candidates: usize }, AttemptFailed { reason: FailReason, retry_in: Duration }, Accepted { addr: SocketAddr }, SessionLost { reason: FailReason }, RunStarted { run_id: String, scenario_name: Option<String> }, RunEnded, Excluded }`
  - `pub type EventSink = Arc<dyn Fn(PoolEvent) + Send + Sync>;`
  - `#[derive(Debug, Clone, PartialEq, Eq)] pub enum PoolState { Connecting, Idle { addr: SocketAddr }, Running { addr: SocketAddr, run_id: String, scenario_name: Option<String> }, Retrying { reason: FailReason, retry_at: Instant }, Excluded }` (`Instant` = `std::time::Instant`)
  - `pub struct StatusTracker` + `impl Default`(=`new()`) + `pub fn new() -> Self` + `pub fn apply(&mut self, ev: &PoolEvent, now: Instant)` + `pub fn state(&self, now: Instant) -> PoolState`.
  - `pub fn desktop_retry_delay(attempt: usize) -> Duration` (= `SCHEDULE[min(attempt, len-1)]`).
  - `pub fn clip(s: &str, max_chars: usize) -> String`.
  - `pub async fn probe_first<F, Fut>(addrs: &[SocketAddr], timeout: Duration, connect: F) -> Option<SocketAddr> where F: Fn(SocketAddr) -> Fut, Fut: Future<Output = bool>` — 전부 동시, 첫 `true`의 주소, 각 시도 `timeout` 상한, 전부 실패·상한이면 `None`. `pub async fn tcp_reachable(addr: SocketAddr) -> bool`(운영용 `TcpStream::connect`).
- **추적기 규칙**(spec R4·R5, 결정 고정):
  - 시작 = `Connecting`. `Probing` → 변화 없음.
  - `Accepted{addr}` → `Idle{addr}`, 유예 해제, 마지막 실패 기록 지움, "수락된 적 있음".
  - `RunStarted{…}` → `Running{addr: 마지막 수락 주소, …}`.
  - `RunEnded`·`SessionLost` → 수락된 적이 있으면 유예 시작 `grace_until = now + GRACE`(마지막 실패 기록 지움), 아니면 변화 없음.
  - `AttemptFailed{reason, retry_in}` → 마지막 실패 = `(reason, now + retry_in)` 기록.
  - `state(now)`:
    - `Excluded`를 받았으면 언제나 `Excluded`(최종 — 이후 사건 무시).
    - 유예 중(`now < grace_until`) → `Idle{마지막 addr}`.
    - 유예가 끝났는데(`now >= grace_until`, 아직 재수락 없음) → 마지막 실패가 있으면 `Retrying{reason, retry_at}`, 없으면 `Connecting`.
    - 유예 없음 + 마지막 실패 있음(수락 전 첫 접속) → `Retrying{…}`; 둘 다 없으면 현재 상태(`Connecting`/`Idle`/`Running`).
- **`pool_status` 재수출은 Task 5**(worker lib).

- [ ] **Step 1: 실패하는 공개 API 테스트**(`tests/pool_status_api_test.rs`): `use handicap_worker_core::pool_status::{PoolEvent, PoolState, StatusTracker, FailReason, EventSink, classify, probe_first, tcp_reachable, desktop_retry_delay, clip, PROBE_TIMEOUT, GRACE};` + `new_tracker_is_connecting`(`StatusTracker::default().state(now)==Connecting`) + `classify_real_connect_error_is_unreachable`(`tonic::transport::Endpoint::from_static("http://127.0.0.1:1").connect().await`의 실제 에러를 `WorkerError::Connect`로 → `Unreachable`) + `public_names_are_usable`(가져온 이름을 **모두 한 번씩** 쓴다 — 안 쓰면 clippy `-D warnings`의 `unused_imports`로 커밋이 막힌다): `let _: EventSink = Arc::new(|_| {});` · `let _ = (PROBE_TIMEOUT, GRACE, desktop_retry_delay(0), clip("a", 1), PoolEvent::RunEnded);` · `assert_eq!(probe_first(&[], PROBE_TIMEOUT, |_| async { false }).await, None);` · `assert!(!tcp_reachable("127.0.0.1:1".parse().unwrap()).await);`.
- [ ] **Step 2: RED** — `cargo nextest run -p handicap-worker-core --test pool_status_api_test` → 컴파일 에러.
- [ ] **Step 3: 단위 테스트 작성**(`pool_status.rs` 인라인)
  - `classify_maps_kinds`: `InvalidUri`·`ConnectTimeout`→Unreachable, `AbortedBeforeAssignment{AUTH_FAILED_REASON}`→AuthFailed, `AbortedBeforeAssignment{"run already started or fully sharded"}`→`Rejected(같은 문자열)`, `NoAssignment`·`SendFailed`→Protocol.
  - `accepted_is_idle_with_addr`, `probing_changes_nothing`, `run_started_carries_last_accepted_addr`.
  - `first_failure_before_accept_is_retrying_immediately`.
  - `grace_after_run_end`: Accepted → RunEnded(t0) → AttemptFailed(t0+1s, 2s) → `state(t0+14s)==Idle`, `state(t0+15s)==Retrying{reason, retry_at: t0+3s}`.
  - `grace_after_session_lost_expires_to_retrying`: 같은 규칙, `SessionLost` 경로.
  - `grace_expired_without_failure_is_connecting`: Accepted → RunEnded(t0) → `state(t0+16s)==Connecting`.
  - `reaccept_within_grace_stays_idle`: SessionLost(t0) → AttemptFailed → Accepted(t0+5s) → `state(t0+20s)==Idle`.
  - `excluded_is_final`: Running → Excluded → RunEnded·Accepted → `Excluded`.
  - `desktop_delay_never_gives_up`: `desktop_retry_delay(0..=100)` = 1,2,4,8,8,…초.
  - `clip_respects_char_boundary`: `clip("가나다라",2)=="가나"`, 짧으면 그대로.
  - 탐침(`#[tokio::test(start_paused = true)]`, 경과는 **`tokio::time::Instant`** 로 측정): `probe_picks_first_success`, `probe_skips_blackhole`(한 주소의 connect가 `std::future::pending` → 다른 주소 즉시 `true` → 결과 그 주소, 경과 `< PROBE_TIMEOUT`), `probe_all_fail_returns_none_within_timeout`(경과 `<= PROBE_TIMEOUT + 10ms`), `probe_single_candidate`.
- [ ] **Step 4: 구현** — Interfaces·규칙대로.
- [ ] **Step 5: GREEN** — `cargo nextest run -p handicap-worker-core` 전체.
- [ ] **Step 6: 이빨 실증** — `probe_first`를 "모든 후보 결과를 다 기다린 뒤 첫 성공 반환"으로 바꿔 `probe_skips_blackhole` RED(경과 단언) → 원복(리포트 기록).
- [ ] **Step 7: 커밋** — `feat(worker-core): 부하기 상태 사건·이유 분류·유예 추적기·IP 탐침`

### Task 5: 데스크톱 풀 진입점 `run_pool_desktop` + 통합 테스트

**Files:**
- Create: `crates/controller/tests/pool_desktop_worker_test.rs` (`#![cfg(feature = "in-process")]`, 첫 스텝)
- Modify: `crates/worker/src/lib.rs` (재수출 + 새 공개 타입·함수, private `execute_assignment` 재사용)

**Interfaces:**
- Consumes: Task 3 `connect_and_register_opts`/`RegisterOpts`, Task 4 전부.
- Produces (2b 셸이 부른다 — `desktop/`과 controller 테스트는 `handicap-worker`만 의존하므로 재수출 필수):
  - `pub use handicap_worker_core::pool_status;`
  - `pub struct PoolTarget { pub ips: Vec<Ipv4Addr>, pub port: u16, pub token: String, pub worker_id: String, pub capacity_vus: u32 }` (Debug 손구현 — `token`은 `[REDACTED]`)
  - `pub async fn run_pool_desktop(target: PoolTarget, cancel: CancellationToken, events: pool_status::EventSink) -> anyhow::Result<()>`
- **루프 동작**(spec R4):
  - 사이클: `Probing{n}` → `probe_first(ips×port, PROBE_TIMEOUT, tcp_reachable)`. 없으면 `d = desktop_retry_delay(attempt)` → `AttemptFailed{Unreachable, d}` → 취소 가능한 sleep(`select!` with `cancel.cancelled()`) → `attempt += 1`.
  - 있으면 `child = cancel.child_token()`, 수락 플래그 `AtomicBool` + `on_accepted`(플래그 세우고 `Accepted{addr}`) → `connect_and_register_opts(format!("http://{addr}"), worker_id, "", capacity, token, &resolve_hostname(), true, &child, RegisterOpts{ connect_timeout: Some(PROBE_TIMEOUT), on_accepted: Some(&cb) })`:
    - `Ok(link)` → `attempt = 0`; `RunStarted{run_id, scenario_name: Scenario::from_yaml(&yaml).ok().map(|s| clip(&s.name, 80))}`; `execute_assignment(link, worker_id.clone(), child.child_token())`(에러는 `warn!`). 끝나면: `cancel` 취소 → 반환; `child` 취소(∧ `cancel` 미취소) → `Excluded` 후 반환(**`RunEnded` 안 냄**); 아니면 `RunEnded` 후 곧바로 다음 사이클.
    - `Err(_)` ∧ `cancel` 취소 → 반환. `Err(_)` ∧ `child` 취소 → `Excluded` 후 반환(대기 중 `Disconnect`).
    - 그 밖의 `Err(e)` → 수락 플래그가 섰으면 `attempt = 0` + `SessionLost{classify(&e)}` + sleep `desktop_retry_delay(0)`, 아니면 `AttemptFailed{classify(&e), d}` + sleep `d`; 이어 `attempt += 1`.
  - CLI 경로(`run_pool_until`)는 건드리지 않는다.

- [ ] **Step 1: 실패하는 통합 테스트** — 사건을 `Arc<Mutex<Vec<(tokio::time::Instant, PoolEvent)>>>`에 모으는 `EventSink`. 컨트롤러 = `in_process_pool_rejoin_test.rs` `start_pool` 패턴(토큰 `"t"`, 빈 포트, `ips: [127.0.0.1]`). 대상 HTTP = `wiremock`(즉시 200). 헬퍼 `wait_pool_idle(rc, worker_id)` = `GET /api/pool/workers`에 그 워커가 `busy:false`로 보일 때까지(≤5s) — **`Accepted` 뒤 REST로 무언가 하기 전엔 늘 이 헬퍼**(Ping이 풀 등록보다 먼저라 `Accepted` 직후엔 아직 풀에 없을 수 있다 — 고정 ID는 등록 전 DB 읽기를 한다, `coordinator.rs:396-406`).
  - `events_idle_run_idle`: `Probing`·`Accepted` → `wait_pool_idle` → REST로 1초 closed-loop run(시나리오 `name: "lv-desktop"`) → `RunStarted{scenario_name: Some("lv-desktop")}` → `RunEnded` → 다음 `Accepted` 순서.
  - `scenario_name_is_clipped_to_80`: 100자 이름 시나리오 → `RunStarted.scenario_name`의 `chars().count()==80`.
  - `wrong_token_reports_auth_failed`: 토큰 `"x"` → 3초 안 `AttemptFailed{reason: AuthFailed}`, 그 뒤 두 번째 `AttemptFailed`도 옴.
  - `unreachable_reports_within_probe_timeout`: 빈 포트(리스너 없음) → 3초 안 `AttemptFailed{Unreachable}`.
  - `retry_counter_resets_after_accept`: 컨트롤러 없이 시작 → `AttemptFailed.retry_in`이 1s, 2s까지 쌓이는 것 확인 → 같은 포트로 컨트롤러 시작 → `Accepted` → `rc.shutdown()` → `SessionLost` → 그 다음 `AttemptFailed.retry_in == 2s`(리셋 뒤 `SessionLost` sleep이 index 0, 다음 실패가 index 1 — CLI식 누적이면 4s 이상 → RED).
  - `controller_restart_emits_session_lost_then_accepted`: `Accepted` 뒤 `rc.shutdown()` → 같은 포트 재시작 → `SessionLost` 뒤 `Accepted`(≤15s).
  - `excluded_while_idle_emits_excluded`: `Accepted` → `wait_pool_idle` → `POST /api/pool/workers/{id}/exclude`(본문 `{}`, `app.rs:193`·`api/pool.rs:145`) → `Excluded`, 함수 반환.
  - `excluded_while_running_emits_excluded`: 30초 run 중(`RunStarted` 확인) 「제외」 → 마지막 사건 `Excluded`, `RunStarted`와 `Excluded` 사이에 `RunEnded` 없음, 함수 반환.
  - `cancel_returns_without_excluded`: `Accepted` 뒤 `cancel.cancel()` → 반환, `Excluded` 없음.
  - `worker_id_is_stable`: `wait_pool_idle` 뒤 목록의 그 워커 `stable == true`, `worker_id == target.worker_id`.
- [ ] **Step 2: RED** — `cargo nextest run -p handicap-controller --features in-process --test pool_desktop_worker_test` → 컴파일 에러.
- [ ] **Step 3: 구현** — 위 루프 동작대로.
- [ ] **Step 4: GREEN** — 같은 명령 + `cargo nextest run -p handicap-worker` + `cargo nextest run -p handicap-controller --features in-process --test in_process_pool_rejoin_test` + 워크스페이스 `cargo nextest run --workspace`.
- [ ] **Step 5: 이빨 실증** — (a) `Excluded` 판정을 지우고(그냥 `RunEnded`) `excluded_while_running_emits_excluded` RED → 원복. (b) `SessionLost`에서 `attempt = 0`을 지워 `retry_counter_resets_after_accept` RED → 원복(리포트 기록).
- [ ] **Step 6: 커밋** — `feat(worker): 데스크톱 풀 진입점 run_pool_desktop(탐침·포기 없는 재시도·상태 사건)`

### Task 6: 라이브 검증(R8) + 워커 함정 기록

**Files:**
- Modify: `crates/worker-core/CLAUDE.md` (함정 두 줄: 「데스크톱 루프 `run_pool_desktop`은 CLI `run_pool_until`과 재시도 규칙이 다르다 — 포기 없음·수락 뒤 리셋·`SessionLost`/`AttemptFailed` 구별」, 「실행 중 제외 판정 = 자식 토큰 취소 ∧ 호출자 미취소 — `forward_inbound`는 넘겨받은 토큰만 cancel한다」)
- 기록: `.superpowers/sdd/` 리포트(커밋 안 함, worktree 루트에 `.md` 금지)

- [ ] **Step 1: 라이브 스택** — `/live-verify` 레시피(워크트리 자체 바이너리, 격리 DB, `--ui-dir` 없음). 컨트롤러 `./target/debug/controller --db /tmp/dwm-2a.db --worker-mode pool --worker-token T --rest 127.0.0.1:<빈> --grpc 127.0.0.1:<빈>`(포트는 `lsof -nP -iTCP:<p> -sTCP:LISTEN` 출력이 빈 것). 워커 2개: `./target/debug/worker --controller http://127.0.0.1:<grpc> --token T --worker-id lv-a`(그리고 `lv-b`, 각자 로그 파일). 대상 = **요청 수를 세는** 응답기(스크래치패드에 작은 python 서버 — 요청마다 카운터 파일 증가; 스킬의 `responder.py`는 로그가 없다).
- [ ] **Step 2: R8 재현** — `vus: 4`(풀 N = min(유휴 워커, vus) — 2 이상이어야 두 워커 모두 배정), 20초 closed-loop run 생성 → `GET /api/pool/workers`에서 두 워커 `busy:true` → 5초 뒤 `lv-a`에 SIGTERM → 기대: `GET /api/runs/{id}`의 status `aborted` + message `worker lv-a stopped mid-run — run aborted (other workers stopped)`, `lv-b` 로그에 `abort signal received`(`worker/src/lib.rs:746`), 응답기 카운트가 2초 뒤부터 더 늘지 않음(전후 두 번 읽기).
- [ ] **Step 3: REST 중단 대조** — `lv-a` 재기동 → 새 run(vus 4) → `POST /api/runs/{id}/abort` → status `aborted`, message `null`.
- [ ] **Step 4: 정리** — `pgrep -f "target/debug/controller --db /tmp/dwm-2a.db"`·워커 pid로 내 프로세스만 종료.
- [ ] **Step 5: 함정 기록 커밋** — `docs(worker-core): 데스크톱 풀 루프 함정` (`.md`만 — pre-commit fast-path).
