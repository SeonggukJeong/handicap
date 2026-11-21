# abort-before-register Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 중단된 run에 부하기가 붙어 부하를 끝까지 내는 버그를 없애고, 시작 전·일부 접속 중단을 사유로 알리고, 시작 시각 없는 run의 리포트 숫자를 바로잡는다.

**Architecture:** 컨트롤러 코디네이터가 외부 중단 표시(`external_abort`)를 등록 시점에 확인하고, 등록한 워커가 없는 run은 `abort()`가 즉시 정리한다. 중단 API는 「가드 DB 기록 → 코디네이터 중단 → 사유」 순서로 바뀌고, run 생성은 `enqueue` 뒤 상태를 다시 읽는다. run 전용 워커는 배정 전 `AbortRun`을 받으면 재시도하지 않는다. proto·마이그레이션 변경 없음.

**Tech Stack:** Rust(tokio·tonic·sqlx/SQLite·axum), TypeScript(vitest) — 인쇄 요약 문장 한 함수.

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-21-abort-before-register-design.md` — 각 task는 spec 절 번호를 가리킨다. 구현자는 spec의 해당 절과 「사용자 스토리 (US)」 블록을 함께 읽는다.

## Global Constraints

- 정상 run(중단 표시 없음)의 등록·배정·완료 경로는 메시지 순서와 내용이 그대로여야 한다(spec §2 안티목표).
- 이미 끝난 run(`completed`/`failed`)의 상태·사유를 덮어쓰지 않는다.
- 중단 표시와 run 제거는 `runs` 잠금 안에서, 어떤 `AbortRun`도 보내기 전에. `cleanup_dispatcher`·DB 쓰기는 잠금 밖에서(spec §7).
- 사유 문구(글자 그대로): `부하를 시작하기 전에 중단했습니다` / `부하기 {expected}대 중 {registered}대만 접속한 상태에서 중단했습니다`.
- `AbortRun.reason` 글자 그대로: `run aborted before assignment`(등록 차단) / `run is not active`(`NoRun`).
- 주석은 사실(불변식·순서 제약)만. 이상한 동작을 설명하고 넘어가는 주석이 필요하면 코드를 고친다(`docs/dev/working-rules.md` §7) — 결함을 변호하는 주석은 리뷰에서 Important다.
- 구현은 정확성 우선, 그 안에서 불필요한 일을 하지 않는다(working-rules §10): `register`의 추가 비용은 불리언 한 번 읽기, run 생성의 추가 비용은 기본 키 조회 한 번.
- 커밋: `git add <파일>` → `git commit -F <메시지 파일>` 단독 호출(복합 명령·파이프·`--no-verify` 금지). cargo 경로가 든 커밋의 게이트는 수 분 걸린다 — 단일 FOREGROUND 호출(timeout 600000ms)로, 그동안 다른 `cargo` 금지. 커밋 뒤 `git log -1 --oneline`으로 확인.
- `tdd-guard`: `crates/*/src`·`ui/src` 편집 전에 테스트 편집(인라인 `#[cfg(test)]` 포함)이 먼저 있어야 한다. 각 task의 Step 1이 테스트다.
- 풀 e2e 파일은 `--features in-process`로 돌려야 실행된다(`cargo nextest run -p handicap-controller --features in-process`).
- 줄번호는 base `1bbc9e57` 기준이다. 편집 전 `grep -n`으로 다시 확인한다.

## Review Focus

spec이 함의하지만 놓치기 쉬운 입력 — 각 줄의 테스트는 괄호 안 task에 들어 있다.

1. 중단 직후 **같은 워커가 다시 등록**한다(구성원 재등록) → 배정을 다시 받지 않는다(Task 2, `reregister_after_abort_is_refused`).
2. 중단을 누르는 순간 run이 **막 끝났다** → `completed` 그대로, 409(Task 3, `abort_run_does_not_overwrite_finished_run`).
3. **풀 모드**에서 생성 도중 중단 → 예약한 풀 워커에 배정이 남지 않는다(Task 4, `spawn_recheck_releases_pool_reservation`).
4. 시작 시각 없는 run에 **측정 창이 한 초뿐**이다 → 기간 1초(0으로 나누지 않는다)(Task 1, `duration_single_window_is_one_second`).
5. **풀 워커**가 배정 전 `AbortRun`(토큰 거절 등)을 받는다 → 재시도 동작이 지금과 같다(Task 5, `retry_all_policy_still_retries_abort`).

---

### Task 1: 리포트 기간 계산 (spec §3.5, US4)

**Files:**
- Modify: `crates/controller/src/report.rs` (기간 계산 760–771, 인라인 테스트 모듈)

**Interfaces:**
- Produces: 없음(리포트 JSON 모양 그대로, `duration_seconds`·`rps` 값만 달라진다).

- [ ] **Step 1: 실패하는 테스트 작성** — `report.rs` 인라인 테스트 모듈에, 기존 `run_row()`(1217)와 창 픽스처 도우미를 써서 넷:

```rust
// started_at None, ended_at Some, 창 없음
fn duration_no_start_no_windows_is_zero()        // duration_seconds == 0, rps == 0.0
// started_at None, 창 ts_second = 100..=102 (요청 합 300)
fn duration_no_start_uses_window_span()          // duration_seconds == 3, rps == 100.0
// started_at None, 창 한 초(ts 100, 요청 50)
fn duration_single_window_is_one_second()        // duration_seconds == 1, rps == 50.0
// started_at Some(100_000), ended_at None
fn duration_running_run_is_zero_not_negative()   // duration_seconds == 0, rps == 0.0
```

기존 `build_report` 호출 픽스처(같은 모듈의 `build_report_tolerates_bad_hdr_blob` 1393 참고)를 그대로 따라 인자를 채운다.

- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-controller duration_` → 넷 다 실패(시작 시각 없는 셋은 `ended_at` 값 그대로, `running_run`은 음수). 창 픽스처는 같은 모듈의 `win`(1259).

- [ ] **Step 3: 구현** — 기간(ms)을 spec §3.5 표대로:
  - `started_at`·`ended_at` 둘 다 있음 → `(ended − started).max(0)`
  - `started_at` 없음 → `rows`가 비었으면 0, 아니면 `(마지막 ts_second − 첫 ts_second + 1) * 1000`. 첫·마지막은 `rows` 전체의 최소·최대 `ts_second`(정렬을 가정하지 않는다).
  - `started_at` 있음·`ended_at` 없음 → 0
  
  `rps`는 지금 식 그대로(`duration_ms > 0`일 때만). `ReportRun.started_at`은 건드리지 않는다.

- [ ] **Step 4: GREEN + 회귀** — `cargo nextest run -p handicap-controller report::` 전부 통과(기존 `duration_seconds == 2` 픽스처 포함).

- [ ] **Step 5: 커밋** — `fix(controller/report): 시작 시각 없는 run의 기간을 측정 구간으로, 실행 중 run의 음수 기간 수정`

---

### Task 2: 코디네이터 — 등록 차단 + 중단 즉시 정리 (spec §3.1·§3.2, US1·US2)

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` — `RegisterOutcome`(255–), `register`(1061–1105), `abort`(1559–1590), 스트림 핸들러 Register 가지(1951–1986), `assign_pool_workers`의 `_ =>` 가지(456), 인라인 테스트
- Modify: `crates/controller/src/in_process.rs`(169–171 주석) — `abort`가 `false`를 돌려준다는 서술을 새 결과에 맞게
- Modify: `crates/controller/CLAUDE.md` — A3c 노트의 「`abort()` 자체엔 cleanup 미삽입」 줄

**Interfaces:**
- Produces:

```rust
/// `CoordinatorState::abort`의 결과.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbortOutcome {
    NoRun,
    NotStarted,
    Marked { registered: u32, expected: u32 },
}
pub async fn abort(&self, run_id: &str) -> AbortOutcome;

pub enum RegisterOutcome { /* 기존 넷 */, Aborted }
```

- [ ] **Step 1: 실패하는 테스트 작성** — 인라인 테스트 모듈에(도우미 `seed_run`·`base_assignment`·`fake_tx`·`LONG`·`two_worker_run`·`abort_reason` 재사용, `enqueue`는 7인자):

```rust
#[tokio::test] async fn abort_with_no_workers_removes_run() {
    // enqueue(expected 1) → abort → AbortOutcome::NotStarted
    // 이어지는 register(&run_id, "w0", tx) → RegisterOutcome::NoRun
}
#[tokio::test] async fn late_worker_after_abort_is_refused() {
    // enqueue(expected 2) → register w0(Assigned) → abort → Marked { registered: 1, expected: 2 }
    // w0 수신 큐 첫 메시지 = Abort("user requested abort")
    // register w1 → RegisterOutcome::Aborted
    // 그 뒤 abort를 한 번 더 → Marked { registered: 1, expected: 2 } (w1이 구성원이 되지 않았다)
}
#[tokio::test] async fn reregister_after_abort_is_refused() {
    // enqueue(expected 1) → register w0 → abort → register w0 다시 → Aborted (Resend 아님)
}
#[tokio::test] async fn register_without_abort_is_unchanged() {
    // enqueue(expected 1) → register w0 → Assigned{first:true}; register w0 → Resend; register w1 → Reject
}
#[tokio::test] async fn auto_stop_does_not_block_register() {
    // two_worker_run과 같은 구성에서 w0만 등록 → auto_stop(saturation_stop(3)) → register w1 → Assigned
    // (자동 정지는 이번 범위 밖 — 동작이 실수로 바뀌지 않았는지)
}
#[tokio::test] async fn assign_pool_workers_on_aborted_run_releases_reservation() {
    // 풀 워커 2대 유휴 등록 → reserve → enqueue → abort(NotStarted) → assign_pool_workers → Err
    // pool_snapshot(..)의 두 워커 모두 assigned_run.is_none()
    // (풀 픽스처는 pool_worker_in_run 4410·two_pool_workers_in_run 4452 참고)
}
```

스트림 핸들러 수준(같은 모듈의 `idle_register_stream`(6053)·`not in pool mode` 테스트(3560–3592)와 같은 방식 — 실제 gRPC 서버를 띄우고 `CoordinatorClient`로 `Register`를 보낸다. `run_id`를 채운 Register를 보내는 도우미 하나를 `idle_register_stream` 옆에 둔다):

```rust
#[tokio::test] async fn register_for_unknown_run_gets_abort() {
    // run 없음 → 첫 서버 메시지 = Abort{ reason: "run is not active" }, 다음은 스트림 종료
}
#[tokio::test] async fn register_for_aborted_run_gets_abort() {
    // enqueue(expected 2) + fake w0 register + abort → 실제 스트림으로 w1 Register
    // → 첫 서버 메시지 = Abort{ reason: "run aborted before assignment" }, 다음은 스트림 종료
}
```

- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-controller --features in-process coordinator::tests::` 중 새 테스트가 컴파일 오류(새 타입) → 타입만 먼저 넣은 뒤 다시 돌려 `abort_with_no_workers_removes_run`·`late_worker_after_abort_is_refused`·`reregister_after_abort_is_refused`·핸들러 둘이 단언에서 실패하는 것을 확인한다(지금 코드는 `Assigned`/`Resend`/조용한 종료).

- [ ] **Step 3: `abort` 구현** — 한 잠금 블록에서:
  - run 없음 → `NoRun`
  - `rw.workers.is_empty()` → 맵에서 제거, `done.cancel()`; 잠금을 푼 뒤 `cleanup_dispatcher(run_id).await`; `NotStarted`
  - 그 밖 → 지금 그대로(표시 둘 → 송신자 복사 → 잠금 밖 `fan_out_abort`), `Marked { registered: rw.workers.len() as u32, expected: rw.expected }`
  
  머리 주석(1559–1568)을 사실에 맞게 고친다: 등록한 워커가 있으면 `abort`는 정리하지 않는다(워커의 `Aborted` 보고·끊김이 정리한다), 없으면 여기서 정리한다.

- [ ] **Step 4: `register` 구현** — run을 찾은 직후, 구성원 확인보다 먼저 `if rw.external_abort { return RegisterOutcome::Aborted; }`. 다른 줄은 그대로.

- [ ] **Step 5: 스트림 핸들러** — `RegisterOutcome::Aborted` 가지: `Reject` 가지와 같은 모양으로 `AbortRun { run_id, reason: "run aborted before assignment" }` 송신 후 `break`. `NoRun` 가지: `warn!` 뒤 `AbortRun { run_id, reason: "run is not active" }` 송신 후 `break`. 두 사유는 `NOT_POOL_MODE_REASON`(42) 옆에 `const`로 둔다.

- [ ] **Step 6: `assign_pool_workers`** — `_ =>` 가지를 `RegisterOutcome::NoRun | RegisterOutcome::Reject | RegisterOutcome::Aborted =>`로(본문 그대로).

- [ ] **Step 7: 호출부·기존 테스트 맞추기** — `assert!(coord.abort(..).await)` 여섯 곳(`grep -n "assert!(coord.abort\|assert!(.*\.abort(&" crates/controller/src/grpc/coordinator.rs`로 확인)을 `assert!(matches!(coord.abort(..).await, AbortOutcome::Marked { .. }))`로. `api/runs.rs` 1403·`in_process.rs` 179·233은 반환값을 버리므로 `let _ =` 유무만 컴파일에 맞춘다(동작 변경은 Task 3). `in_process.rs` 169–171 주석과 `crates/controller/CLAUDE.md` A3c 노트의 `abort()` 줄을 새 동작으로 고친다(「user abort는 등록한 워커가 있으면 … 닫히므로 `abort()`는 정리하지 않고, 등록한 워커가 없으면 `abort()`가 run을 지우고 cleanup한다」).

- [ ] **Step 8: GREEN + 회귀** — `cargo nextest run -p handicap-controller --features in-process` 전체 통과, 실행된 테스트 수가 0이 아님을 확인. `cargo build --workspace --tests` 통과.

- [ ] **Step 9: 되돌려 확인** — Step 4의 한 줄을 지우고 `late_worker_after_abort_is_refused`·`reregister_after_abort_is_refused`가 실패하는 것을 본 뒤 되돌린다. Step 3의 `workers.is_empty()` 가지를 지우고 `abort_with_no_workers_removes_run`이 실패하는 것을 본 뒤 되돌린다. Step 4의 검사를 `rw.abort_requested`로 바꿔 `auto_stop_does_not_block_register`가 실패하는 것을 본 뒤 되돌린다(이 테스트가 막으려는 회귀).

- [ ] **Step 10: 커밋** — `fix(controller/coordinator): 중단된 run의 등록을 막고, 등록한 워커가 없으면 중단 시점에 정리`

---

### Task 3: store 함수 + 중단 API (spec §3.4, US3)

**Files:**
- Modify: `crates/controller/src/store/runs.rs` — 새 함수 둘·상수·문구 함수, 인라인 테스트
- Modify: `crates/controller/src/api/runs.rs` — `abort_run`(1387–1406), 인라인 테스트(도우미 `state_with` 1580, `seed_plain_run` 2875)

**Interfaces:**
- Consumes: `AbortOutcome`(Task 2).
- Produces:

```rust
// store/runs.rs
pub const ABORT_MSG_NOT_STARTED: &str = "부하를 시작하기 전에 중단했습니다";
pub fn abort_msg_partial(registered: u32, expected: u32) -> String;
// → "부하기 {expected}대 중 {registered}대만 접속한 상태에서 중단했습니다"

/// 활성(pending/running) 행만 aborted로(ended_at = now, message 그대로). 바뀌었으면 true.
pub async fn abort_if_active(db: &Db, id: &str) -> sqlx::Result<bool>;
/// status = 'aborted' AND message IS NULL 인 행에만 message를 쓴다. 썼으면 true.
pub async fn set_abort_reason_if_absent(db: &Db, id: &str, message: &str) -> sqlx::Result<bool>;
```

`mark_aborted`는 고치지 않는다(테스트 픽스처 둘이 끝난 행 덮어쓰기에 기댄다 — spec §3.4 1번).

- [ ] **Step 1: store 테스트 작성** (`store/runs.rs` 인라인):

```rust
abort_if_active_marks_pending_and_running      // 각각 true, status aborted, ended_at Some, message None
abort_if_active_skips_finished                 // completed 행 → false, status completed 그대로
set_abort_reason_writes_only_when_absent       // aborted·message NULL → true; 다시 다른 글자로 호출 → false, 첫 글자 유지
set_abort_reason_skips_non_aborted             // running 행 → false, message None
abort_msg_partial_text                         // abort_msg_partial(1, 2) == "부하기 2대 중 1대만 접속한 상태에서 중단했습니다"
```

- [ ] **Step 2: API 테스트 작성** (`api/runs.rs` 인라인, `state_with`(1580) 상태 — 이 테스트들은 `coord.set_dispatcher`를 부르지 않으므로 `abort`의 cleanup은 아무 일도 하지 않는다):

```rust
abort_run_before_any_worker_leaves_not_started_reason
// seed_plain_run + coord.enqueue(expected 1) → abort_run → 200
// 행: aborted, message == Some(ABORT_MSG_NOT_STARTED); 코디네이터에 run 없음(register → NoRun)
abort_run_with_partial_registration_leaves_partial_reason
// enqueue(expected 2) + register w0 → abort_run → 200, message == Some("부하기 2대 중 1대만 접속한 상태에서 중단했습니다")
abort_run_fully_registered_leaves_no_reason
// enqueue(expected 1) + register w0 → abort_run → 200, message None
abort_run_does_not_overwrite_finished_run
// 행을 completed로 바꾼 뒤 abort_run → Err(ApiError::Conflict(_)), 행 completed 그대로
abort_run_on_already_aborted_run_conflicts
// 행에 mark_aborted_if_active(.., "앱 종료로 중단")을 먼저 적용 → abort_run → Conflict(문구에 "aborted"),
// message "앱 종료로 중단" 그대로 (가드 UPDATE 0행 → 다시 읽기 → 409 경로)
abort_run_unknown_id_is_not_found
// 없는 id → Err(ApiError::NotFound)
```

「사유를 덮지 않는다」는 store 테스트 `set_abort_reason_writes_only_when_absent`가 잠근다.

- [ ] **Step 3: RED 확인** — `cargo nextest run -p handicap-controller abort_` (컴파일 오류 → 시그니처만 넣고 재실행 → 단언 실패).

- [ ] **Step 4: store 구현** — 두 함수 모두 가드 단일 UPDATE, `rows_affected() > 0` 반환(`mark_aborted_if_active` 482– 와 같은 모양).

- [ ] **Step 5: `abort_run` 구현** — 순서:
  1. `runs::abort_if_active` (맨 먼저 — 지금의 `runs::get` 선확인은 없앤다).
  2. `false`면 `runs::get` → 없으면 404, 있으면 409(「run is {상태} and cannot be aborted」 — 지금과 같은 문구).
  3. `state.coord.abort(&id).await`
  4. 결과가 `NotStarted` → `set_abort_reason_if_absent(.., ABORT_MSG_NOT_STARTED)`; `Marked { registered, expected }`이고 `registered < expected` → `set_abort_reason_if_absent(.., &abort_msg_partial(registered, expected))`; 그 밖은 쓰지 않는다.
  5. 200.
  
  지금 있는 두 줄 주석(「Best-effort … mark_aborted below is sufficient」)은 사실이 아니게 되므로 지운다.

- [ ] **Step 6: GREEN + 회귀** — `cargo nextest run -p handicap-controller --features in-process` 전체 통과(`tests/api_test.rs`의 `abort_run_marks_run_aborted` 157·`aborted_status_not_overwritten_by_completed` 516 포함).

- [ ] **Step 7: 되돌려 확인** — `abort_if_active`의 `WHERE` 가드를 `WHERE id = ?`로 바꿔 `abort_run_does_not_overwrite_finished_run`·`abort_if_active_skips_finished`가 실패하는 것을 보고 되돌린다(선확인이 없으므로 API 테스트도 이 가드에 달려 있다).

- [ ] **Step 8: 커밋** — `fix(controller/api): 중단 API — 끝난 run을 덮지 않고, 시작 전·일부 접속 중단에 사유`

---

### Task 4: run 생성 도중의 중단 (spec §3.6)

**Files:**
- Modify: `crates/controller/src/api/runs.rs` — `spawn_run`의 세 `enqueue` 갈래(899·962·986 부근), `fail_pool_assignment`(1377–1385)와 그 테스트(2896–2921)
- Modify: `crates/controller/src/grpc/coordinator.rs`(96) — `type WorkerTx`를 `pub(crate) type WorkerTx`로(지금은 비공개 별칭이라 `api/runs.rs`에서 이름을 쓸 수 없다)

**Interfaces:**
- Consumes: `ABORT_MSG_NOT_STARTED`·`set_abort_reason_if_absent`(Task 3), `cancel_dispatch_failed`·`release_pool_reservation`(기존).
- Produces(파일 안 전용):

```rust
/// `enqueue` 뒤·디스패치 앞에서 부른다. 행이 더는 `pending`이 아니면 풀 예약을 풀고(`reserved`가
/// 비어 있지 않으면) 코디네이터 항목을 정리하고(`aborted`면 시작 전 사유를 남기고) 다시 읽은 행을
/// 돌려준다. `pending`이면 None. 행 읽기가 실패해도 같은 정리를 한 뒤 오류를 돌려준다.
async fn row_if_no_longer_pending(
    state: &AppState,
    run_id: &str,
    reserved: &[(String, crate::grpc::coordinator::WorkerTx)], // 풀 갈래의 예약 목록, 그 밖은 &[]
) -> Result<Option<runs::RunRow>, ApiError>;

/// 풀 배정 실패 처리. 행이 `aborted`면 그 행(정상 생성으로 돌려줄 값), 아니면 지금의 오류.
async fn fail_pool_assignment(coord, db, run_id) -> Result<Result<runs::RunRow, ApiError>, sqlx::Error>;
```

`fail_pool_assignment`의 반환 모양은 구현자가 더 읽기 쉬운 것으로 바꿔도 된다(전용 enum 등). 조건: 호출부 둘이 「`aborted` 행 → `Ok(row)`」와 「그 밖 → `Err(…)`」를 구분할 수 있고, 기존 테스트 둘의 뜻(끝난 run을 덮지 않는다 / 활성 run은 `failed` + `POOL_ASSIGN_FAILED_MSG`)이 유지된다.

- [ ] **Step 1: 테스트 작성** (`api/runs.rs` 인라인). 도우미 수준 셋:

```rust
row_if_no_longer_pending_returns_none_for_pending
// seed + enqueue → None, 코디네이터에 run 남아 있음
row_if_no_longer_pending_tears_down_aborted_run
// seed + abort_if_active + enqueue → Some(row), row.status == Aborted,
// row.message == Some(ABORT_MSG_NOT_STARTED), 코디네이터에 run 없음(register → NoRun)
row_if_no_longer_pending_keeps_existing_reason
// mark_aborted_if_active(.., "앱 종료로 중단") + enqueue → Some(row), message "앱 종료로 중단"
fail_pool_assignment_returns_row_when_aborted
// seed + abort_if_active → fail_pool_assignment → aborted 행, status·message 그대로(failed로 안 바뀜)
```

`spawn_run` 배선 수준(도우미 호출을 `spawn_run`에서 지우면 실패해야 한다). 생성 도중의 중단은 프로덕션 코드에 틈을 내지 않고 **SQLite 트리거**로 넣는다 — 테스트가 DB에 `CREATE TRIGGER abort_on_insert AFTER INSERT ON runs BEGIN UPDATE runs SET status = 'aborted' WHERE id = NEW.id; END`를 만들면 `runs::insert` 직후 행이 `aborted`다. 디스패처는 `dispatch` 호출 수를 세는 시험용(`AtomicUsize`, `WorkerDispatcher` 구현 — `tests/run_dispatch_failure_test.rs` 18–35 모양)을 쓴다. `state_with`(1580)는 `SubprocessDispatcher`를 박아 두므로, 디스패처를 받는 `state_with_dispatcher` 도우미를 옆에 두거나 `AppState`를 테스트 안에서 짓는다.

```rust
spawn_run_skips_dispatch_when_aborted_during_create
// 트리거 + 세는 디스패처 → create(또는 spawn_run) 성공
// dispatch 호출 0회, 돌려받은 행 status == Aborted, message == Some(ABORT_MSG_NOT_STARTED),
// 코디네이터에 run 없음(register → NoRun)
spawn_run_dispatches_normally_without_abort
// 트리거 없음 → dispatch 1회, 행 pending (다시 읽기가 정상 경로를 막지 않는다)
spawn_recheck_releases_pool_reservation
// 풀 모드 상태(set_pool_mode + pool_register_idle로 유휴 풀 워커 2대, capacity 100) + 트리거
// 프로필은 VU 2 이상(VU 1이면 한 대만 예약돼 둘째 워커 단언이 공허해진다)
// → create 성공(500 아님), 행 aborted, pool_snapshot(..)의 두 워커 assigned_run.is_none(),
//   두 워커 수신 큐에 Assignment 없음
spawn_recheck_releases_pool_reservation_force
// 같은 구성을 Query(ForceQuery { force: true })로(옛 풀 갈래 941–980) → 같은 단언
```

트리거가 `runs::insert`와 같은 DB에 걸렸는지는 Step 2가 알려 준다(안 걸렸으면 `skips_dispatch`가 dispatch 1회로 실패한다 — 그때는 다른 테스트들과 같은 연결 방식을 쓰는지 확인).

- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-controller --features in-process row_if_no_longer_pending fail_pool_assignment spawn_run_ spawn_recheck` → 새 테스트가 실패(도우미 없음 → 시그니처만 넣고 재실행 → `spawn_run_skips_dispatch…`는 dispatch 1회, `spawn_recheck…`는 워커가 배정을 받음).

- [ ] **Step 3: 구현**
  - `row_if_no_longer_pending`: `runs::get` → `pending`이면 `None`. 아니면(행이 없거나 읽기 오류인 경우 포함) `release_pool_reservation(reserved)`(비어 있지 않을 때) → `coord.cancel_dispatch_failed(run_id)` → 상태가 `aborted`면 `set_abort_reason_if_absent(.., ABORT_MSG_NOT_STARTED)` → 행을 다시 읽어 `Some`. 읽기 오류면 같은 정리 뒤 그 오류를 돌려준다(코디네이터 항목·예약을 쥔 채 `?`로 빠져나가지 않는다).
  - 세 갈래 모두 `enqueue(..).await` 바로 뒤에: `if let Some(row) = row_if_no_longer_pending(&state, &row.id, <예약 목록 또는 &[]>).await? { return Ok(row); }`. 풀 갈래는 예약 목록을 `assign_pool_workers`에 넘기기(move) 전에 이 확인을 한다.
  - `fail_pool_assignment`: 지금 동작(정리 + `mark_failed_if_active`) 뒤, `mark_failed_if_active`가 `false`(행이 이미 활성이 아님)일 때만 행을 읽어 `aborted`면 그 행을 돌려준다. 호출부 둘을 새 반환 모양에 맞춘다.

- [ ] **Step 4: GREEN + 회귀** — `cargo nextest run -p handicap-controller --features in-process` 전체 통과. `fail_pool_assignment_keeps_finished_run`·`fail_pool_assignment_fails_active_run`은 새 반환 모양에 맞게 단언을 옮기되 뜻은 그대로.

- [ ] **Step 5: 되돌려 확인** — 일반 갈래의 `row_if_no_longer_pending` 호출을 지워 `spawn_run_skips_dispatch_when_aborted_during_create`가 실패하는 것을 보고 되돌린다. 풀 갈래 두 곳의 호출을 하나씩 지워 각각 `spawn_recheck_releases_pool_reservation`·`…_force`가 실패하는 것을 보고 되돌린다.

- [ ] **Step 6: 커밋** — `fix(controller/api): run 생성 도중에 온 중단 — 디스패치 전에 상태를 다시 읽는다`

---

### Task 5: 워커 — 배정 전 중단이면 재시도하지 않는다 (spec §3.3)

**Files:**
- Modify: `crates/worker-core/src/reconnect.rs` — `connect_with_backoff`(36–64), `retry_with_backoff`(87–)
- Modify: `crates/worker-core/src/lib.rs`(17, 재수출)
- Modify: `crates/worker/src/lib.rs` — 호출부 357(`run`)·407(`run_pool_until`)
- Test: `crates/worker-core/tests/reconnect_backoff_test.rs`

**Interfaces:**
- Produces:

```rust
/// 접속 재시도 규칙.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryPolicy {
    /// 모든 오류를 재시도한다(풀 워커 — 지금 동작).
    RetryAll,
    /// 배정 전에 컨트롤러가 Abort를 보냈으면 재시도하지 않는다(run 전용 워커).
    StopOnAbort,
}
impl RetryPolicy { pub fn is_fatal(self, e: &WorkerError) -> bool; }
// StopOnAbort → matches!(e, WorkerError::AbortedBeforeAssignment { .. }), RetryAll → false

pub async fn retry_with_backoff_policy<F, Fut, T>(attempt_fn: F, cancel: CancellationToken, policy: RetryPolicy) -> Result<T, WorkerError>;
// retry_with_backoff(attempt_fn, cancel) = retry_with_backoff_policy(.., RetryPolicy::RetryAll) — 시그니처 그대로

pub async fn connect_with_backoff(/* 기존 8개 */, policy: RetryPolicy) -> Result<WorkerLink, WorkerError>;
```

재시도 여부 판단은 `RetryPolicy::is_fatal` 한 곳에만 둔다.

- [ ] **Step 1: 테스트 작성** (`reconnect_backoff_test.rs`, 기존 테스트의 `start_paused` 방식 그대로 — 시도 횟수를 세는 합성 `attempt_fn`):

```rust
stop_on_abort_returns_after_first_attempt
// attempt_fn이 항상 Err(AbortedBeforeAssignment{reason:"x".into()}) + StopOnAbort
// → Err(AbortedBeforeAssignment{..}), 시도 1회, 가상 시계 경과 0
stop_on_abort_still_retries_other_errors
// attempt_fn이 항상 Err(NoAssignment) + StopOnAbort → 시도 횟수 > 1, 60초 상한에서 Err(NoAssignment)
retry_all_policy_still_retries_abort
// attempt_fn이 항상 Err(AbortedBeforeAssignment) + RetryAll → 시도 횟수 > 1 (풀 워커 동작 유지)
```

- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-worker-core reconnect` (컴파일 오류 → 타입만 넣고 재실행 → `stop_on_abort_returns_after_first_attempt` 실패).

- [ ] **Step 3: 구현** — `retry_with_backoff`의 본문을 `retry_with_backoff_policy`로 옮기고, `Err(e)` 가지 맨 앞에 `if policy.is_fatal(&e) { return Err(e); }`. `connect_with_backoff`에 `policy` 인자를 더해 넘긴다. `worker/src/lib.rs` 357은 `RetryPolicy::StopOnAbort`, 407은 `RetryPolicy::RetryAll`. 다른 호출부가 있는지 `grep -rn "connect_with_backoff(" crates/ desktop/`로 확인해 전부 맞춘다(`run_pool_desktop`은 이 함수를 쓰지 않는다 — 건드리지 않는다).

- [ ] **Step 4: GREEN + 회귀** — `cargo nextest run -p handicap-worker-core -p handicap-worker` 전부 통과. `cargo build --workspace --tests` 통과.

- [ ] **Step 5: 커밋** — `fix(worker): run 전용 워커는 배정 전 Abort를 받으면 재시도하지 않는다`

---

### Task 6: 종단 재현 테스트 (spec §5 종단, US1·US3·US4)

**Files:**
- Modify: `crates/controller/tests/e2e_test.rs`

**Interfaces:**
- Consumes: Task 1–5 전부. 새 프로덕션 코드는 없다.

- [ ] **Step 1: 테스트 작성** — `abort_e2e_marks_run_aborted`(419–)의 뼈대(실제 gRPC·REST 서버, wiremock 대상, `worker_bin_path()`)를 따르되 디스패처만 시험용으로 바꾼다:

```rust
/// 워커를 `dispatch` 때 띄우지 않고 (run_id, worker_id)만 기억한다.
/// `spawn_now()`가 실제 워커 바이너리를 띄워 Child를 돌려준다(SubprocessDispatcher와 같은 인자:
/// --controller <grpc url> --run-id <id> --worker-id <ulid>).
struct DeferredDispatcher { /* worker_bin, grpc_url, Mutex<Option<String>> */ }

#[tokio::test(flavor = "multi_thread")]
async fn abort_before_worker_registers_sends_no_load() {
    // 1. 시나리오 + run 생성(8 VU, 30초) → 201
    // 2. 곧바로 POST /api/runs/{id}/abort → 200
    // 3. dispatcher.spawn_now() → Child
    // 4. tokio::time::timeout(10초, child.wait()) 가 기한 안에 끝난다(60초 재시도 없음)
    // 5. wiremock.received_requests() 길이 == 0
    // 6. GET /api/runs/{id}: status "aborted", message "부하를 시작하기 전에 중단했습니다", started_at null
    // 7. GET /api/runs/{id}/report: summary.count == 0, duration_seconds == 0, rps == 0.0
}
```

- [ ] **Step 2: GREEN** — `cargo nextest run -p handicap-controller --test e2e_test abort_before_worker_registers_sends_no_load`.

- [ ] **Step 3: 되돌려 확인(이 테스트가 버그를 잡는지)** — 임시로 ① `abort()`의 `workers.is_empty()` 가지와 ② `register`의 `external_abort` 검사를 함께 지운다(= 고치기 전 동작) → 테스트가 5번(요청 수 > 0) 또는 4번에서 실패하는 것을 본다 → 둘 다 되돌리고 GREEN 재확인. `git diff --stat`으로 `e2e_test.rs` 외 변경이 없음을 확인한다.

- [ ] **Step 4: 커밋** — `test(controller/e2e): 생성 직후 중단한 run에 부하가 나가지 않는다`

---

### Task 7: 인쇄 요약 문장 (spec §3.4b, US3)

**Files:**
- Modify: `ui/src/print/sentences.ts` — `specialLines`(38–55)
- Test: `ui/src/print/__tests__/sentences.test.ts`

**Interfaces:**
- 없음(`specialLines`의 입출력 타입 그대로, 새 `ko.ts` 키 없음).

- [ ] **Step 1: 테스트 작성/수정** (`sentences.test.ts`, 기존 `base()`·`summary()` 도우미):

```ts
it("aborted before start with a reason: says it once", () => {
  const l = summaryLines(base({
    status: "aborted", startedMs: null, endedMs: null,
    summary: summary({ count: 0 }), message: "부하를 시작하기 전에 중단했습니다",
  }));
  const texts = l.map((x) => x.text);
  expect(texts).toContain("요청이 하나도 실행되지 않았습니다. 사유: 부하를 시작하기 전에 중단했습니다");
  expect(texts).not.toContain("측정이 시작되기 전에 중단되었습니다.");
});
it("aborted with requests but no start time: not 'before start'", () => {
  const l = summaryLines(base({ status: "aborted", startedMs: null, endedMs: null }));
  expect(l[0].text).toBe("측정이 도중에 중단되었습니다.");
});
```

기존 「aborted before start」(405–408)는 픽스처에 `summary: summary({ count: 0 })`을 더한다(요청 0건·사유 없음 → 「측정이 시작되기 전에 중단되었습니다.」가 그대로 나온다). 이 줄이 `l[0]`이 아니게 되면(0건 줄이 앞에 온다) 단언을 `l.map(x => x.text)`의 `toContain`으로 바꾼다. **코드를 옛 동작으로 되돌려 맞추지 않는다**(spec §5).

`base()`가 `message`·`summary` 덮어쓰기를 받는 모양인지 파일 머리(40–70)에서 확인하고 그 모양대로 쓴다.

- [ ] **Step 2: RED 확인** — `pnpm --dir ui test sentences` → 새 둘 실패.

- [ ] **Step 3: 구현** — `status === "aborted"` 가지에서 `startedMs === null`일 때:
  - 요청 0건이고 사유가 있으면(0건 줄에 사유가 붙었다) 중단 줄을 넣지 않는다.
  - 요청 0건이고 사유가 없으면 `S.abortedBeforeStart`(지금 그대로).
  - 요청 1건 이상이면 `S.abortedNoElapsed`.
  
  `startedMs !== null`인 경우와 `failed` 가지는 건드리지 않는다.

- [ ] **Step 4: GREEN + UI 게이트** — `pnpm --dir ui lint`, `pnpm --dir ui test`(전체), `pnpm --dir ui build` 모두 통과.

- [ ] **Step 5: 커밋** — `fix(ui/print): 시작 전 중단 요약에서 같은 뜻 문장을 한 번만, 요청이 있는 run의 「시작되기 전에」 오문 수정`

---

## 구현 뒤 (task 아님 — orchestrator가 수행)

- **전체 게이트**: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo nextest run --workspace --features in-process`(실행 수 확인), `pnpm --dir ui lint && pnpm --dir ui test && pnpm --dir ui build`.
- **최종 리뷰**: `handicap-reviewer`(whole-branch, BASE = `1bbc9e57`). 초점: 옛 동작의 부수효과에 기대던 다른 소비자(`abort()`의 `bool`, `NoRun`의 조용한 종료, `mark_aborted` 순서), 결함을 변호하는 주석.
- **보안 게이트**: `/finish-slice` §0 grep을 직접 돌린다. 새 사유 문구가 `message`(DB → API → 화면·인쇄)로 가지만 사용자 입력이 섞이지 않는 글자다 — grep이 매치하면 `security-reviewer`.
- **라이브 검증**: spec §6 표 그대로(`/live-verify`, 워크트리 자체 바이너리). K8s는 Docker가 꺼져 있어 하지 못한다 — build-log·§B에 「하지 못한 검증」으로.
- **마무리**: `/finish-slice` — build-log 단락, roadmap §B79(번호는 `grep -n '^### B' docs/roadmap.md`로 마지막+1 확인)에 spec §8 항목 + 사용자 결정(2026-11-21: 가림 완화 보류, 접근 B, 일부 접속 사유, 인쇄 중복 같이, K8s 나중), §B77 (2) 첫 항목에 해소 표시, 현황판·상태줄, `crates/controller/CLAUDE.md`에 새 함정 한 줄.
