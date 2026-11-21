# pool-prefail-response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** run 생성이 실패하는 일곱 곳에서, 그 run이 이미 중단됐으면 오류 대신 `aborted` 행을 정상 생성으로 돌려준다.

**Architecture:** `api/runs.rs`에 헬퍼 `fail_run_start` 하나를 두고 `spawn_run`의 실패 여섯 곳과 `fail_pool_assignment`가 그것을 부른다. `enqueue` 전의 다섯 곳만 빈 사유에 「부하를 시작하기 전에 중단했습니다」를 채운다. 스케줄러·`create`·proto·마이그레이션·UI는 바꾸지 않는다.

**Tech Stack:** Rust(tokio·sqlx/SQLite·axum). 변경 파일은 `crates/controller/src/api/runs.rs`(운영 코드+테스트), `crates/controller/src/schedule/runner.rs`(테스트만), 주석·문서.

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-21-pool-prefail-response-design.md` — 구현자는 spec의 「사용자 스토리 (US)」 블록과 §4·§5를 함께 읽는다. 아래 「N번 곳」은 spec §1 표의 번호다.

## Global Constraints

- 중단이 끼지 않은 실패는 응답 종류·문구·행의 `failed` 상태와 사유·풀 예약 해제가 지금과 글자까지 같다(spec §2 안티목표). 오류 문구는 지금 코드의 `msg`를 그대로 넘긴다 — 새로 쓰지 않는다.
- 이미 `completed`/`failed`인 행은 정상 생성으로 돌려주지 않는다(원래 오류).
- 사유 글자: `runs::ABORT_MSG_NOT_STARTED`(「부하를 시작하기 전에 중단했습니다」) 상수를 쓴다.
- 운영 코드에 시험용 틈(테스트 전용 인자·`cfg(test)` 가지)을 내지 않는다.
- 주석은 사실(불변식·순서 제약)만. 이상한 동작을 설명하고 넘어가는 주석이 필요하면 코드를 고친다(`docs/dev/working-rules.md` §7) — 결함을 변호하는 주석은 리뷰에서 Important다.
- 성능(working-rules §10): 중단이 끼지 않은 실패 경로의 DB 쓰기·읽기 횟수는 지금과 같다(가드 UPDATE 1회). 추가 UPDATE·SELECT는 가드 UPDATE가 0행일 때만.
- `tdd-guard`: `crates/*/src` 편집 전에 테스트 편집(인라인 `#[cfg(test)]`)이 먼저 있어야 한다. 각 task의 Step 1이 테스트다.
- 커밋: `git add <파일>` → `git commit -F <메시지 파일>` 단독 호출(복합 명령·파이프·`--no-verify` 금지). cargo 게이트는 수 분 걸린다 — 단일 FOREGROUND 호출(timeout 600000ms), 그동안 다른 `cargo` 금지. 커밋 뒤 `git log -1 --oneline`으로 확인.
- 테스트 실행: `cargo nextest run -p handicap-controller --features in-process <필터>`.
- 줄번호는 base `a94017bf` 기준이다. 편집 전 `grep -n`으로 다시 확인한다.
- 되돌려 확인: 각 task가 적은 대로 운영 코드를 일부러 옛 상태로 되돌려 새 테스트가 실패(RED)하는지 보고 원복한다. 결과(어느 테스트가 어떤 단언으로 실패했는지)를 보고서에 적는다. 예상과 다르면 멈추고 보고한다.

## Review Focus

테스트가 덮지 못해 리뷰가 봐야 할 곳.

1. 헬퍼 안에서 `cancel_dispatch_failed` → 가드 UPDATE 순서가 지금과 같은가(뒤집으면 `enqueue` 후 곳에서 감시 태스크가 먼저 `failed`를 쓸 틈이 달라진다).
2. 3·5번 곳의 `release_pool_reservation`이 헬퍼 호출 **앞**에 그대로 있는가(빠지면 부하기가 「사용 중」으로 남는다 — Task 1 테스트가 중단이 낀 경우만 본다. 중단 없는 경우의 해제는 기존 테스트가 보는지 리뷰어가 `grep -n "release_pool_reservation\|assert_pool_released" crates/controller/src/api/runs.rs`로 확인).
3. 헬퍼가 `Ok(row)`를 돌려주는 조건이 정확히 `status == Aborted`뿐인가(`completed` 행·없는 행은 오류).
4. 6번 곳의 `tracing::error!`가 남아 있는가. 헬퍼의 `info!`에 넘겨받은 사유 외의 값(env·토큰)이 들어가지 않는가.
5. `enqueue` 후(6·7번)에는 사유를 채우지 않는가 — 채우면 일부 접속 사유가 밀린다(spec §4.2).

---

### Task 1: 헬퍼 + `enqueue` 전의 네 곳(1·3·4·5번) + `fail_pool_assignment`(7번)

**Files:**
- Modify: `crates/controller/src/api/runs.rs` — 헬퍼 추가(`fail_pool_assignment` 근처, `grep -n "async fn fail_pool_assignment"`), 호출처 `grep -n "mark_failed_if_active" crates/controller/src/api/runs.rs`의 872·895·950·961 네 곳, `fail_pool_assignment` 몸통, 인라인 테스트.

**Interfaces:**
- Produces(뒤 task가 쓴다):

```rust
/// 생성 실패가 `enqueue` 전인지 후인지.
#[derive(Clone, Copy, PartialEq, Eq)]
enum StartFailedAt { BeforeEnqueue, AfterEnqueue }

/// 생성 실패 처리. 활성 행이면 `failed` + `reason` 뒤 `err`. 이미 `aborted`면 그 행
/// (`BeforeEnqueue`면 빈 사유에 `ABORT_MSG_NOT_STARTED`를 채운 뒤). 그 밖은 `err`.
async fn fail_run_start(
    coord: &crate::grpc::coordinator::CoordinatorState,
    db: &crate::store::Db,
    run_id: &str,
    reason: &str,
    err: ApiError,
    at: StartFailedAt,
) -> Result<runs::RunRow, ApiError>
```

- 테스트 틀(뒤 task가 쓴다, 모두 `mod tests` 안):
  - `async fn call_spawn_run_unique(state: &AppState, scenario: &ScenarioRow, vus: u32, rows: i64, force: bool) -> Result<runs::RunRow, ApiError>` — `unique_profile("ds".into(), vus)`와 `vec![DatasetMeta { id: "ds".into(), name: "d".into(), columns: vec![], row_count: rows, byte_size: 0, created_at: 0 }]`를 넘긴다.
  - `async fn abort_with_reason_on_insert_trigger(db: &Db)` — `abort_on_insert_trigger`와 같되 `SET status = 'aborted', message = '앱 종료로 중단'`. 트리거 이름은 달리한다.
  - `async fn only_run(state: &AppState) -> runs::RunRow` — `SELECT id FROM runs`로 하나뿐인 행을 읽어 `runs::get`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`spawn_run_pool_empty_failure_keeps_aborted_row`(`grep -n`으로 위치 확인)를 아래 첫 테스트로 바꾸고 나머지를 더한다. 중단이 낀 경우의 공통 단언: `Ok(row)`, `row.status == Aborted`, `row.message.as_deref() == Some(runs::ABORT_MSG_NOT_STARTED)`, DB의 행도 같다.

| 테스트 이름 | 준비 | 단언 |
|---|---|---|
| `prefail_empty_pool_force_returns_aborted_row` (4번) | `abort_on_insert_trigger` · 풀 모드 · 부하기 없음 · `call_spawn_run(…, 1, true)` | 공통 |
| `prefail_empty_pool_returns_aborted_row` (1번) | 같되 `force = false` | 공통 |
| `prefail_unique_floor_returns_aborted_row` (3번) | 트리거 · `pool_state_with_two_workers` · `call_spawn_run_unique(…, 2, 1, false)` | 공통 + `assert_pool_released` |
| `prefail_unique_floor_force_returns_aborted_row` (5번) | 같되 `force = true` | 공통 + `assert_pool_released` |
| `prefail_keeps_existing_abort_reason` | `abort_with_reason_on_insert_trigger` · 풀 모드 · 부하기 없음 · `force = false` | `Ok`, `Aborted`, `message == Some("앱 종료로 중단")` |
| `prefail_empty_pool_without_abort_fails_run` (US3, 1·4번) | 트리거 없음 · 풀 모드 · 부하기 없음 · `force` false·true 각각 | `Err(ApiError::BadRequest(m))`이고 `m == "연결된 LAN 워커가 없습니다 — 워커를 1대 이상 띄우세요"`, 행 `Failed` + `message == Some(m)` |
| `prefail_unique_floor_without_abort_fails_run` (US3, 3·5번 — **도달 증명**) | 트리거 없음 · 부하기 2대 · `call_spawn_run_unique(…, 2, 1, force)` `force` false·true 각각 | `Err(ApiError::BadRequest(m))`이고 `m == "unique 데이터셋 행 수가 풀 워커 수보다 적습니다: rows=1 < workers=2"`, 행 `Failed` + 같은 사유, 부하기 2대 모두 `assigned_run.is_none()` |
| `fail_run_start_keeps_finished_run_before_enqueue` | `seed_plain_run` → `set_status(Completed)` → `fail_run_start(…, "x", ApiError::BadRequest("x".into()), BeforeEnqueue)` | `Err(BadRequest)`, 행 `Completed`·`message == None` |

- [ ] **Step 2: 돌려서 실패를 확인한다**

Run: `cargo nextest run -p handicap-controller --features in-process prefail_ fail_run_start_`
Expected: 컴파일 오류(`fail_run_start` 없음). 헬퍼를 몸통 `Err(err)`뿐인 껍데기로 두고(`todo!()` 금지 — 끝난 run 테스트가 panic한다) 돌리면 「중단이 낀 경우」 넷과 사유 보존이 `Err`로 실패하고, `without_abort` 둘은 통과한다 — **`prefail_unique_floor_without_abort_fails_run`이 고치기 전 코드에서 통과해야 한다**(3·5번 곳에 닿았다는 증명). 통과하지 않으면 틀(바인딩·메타·부하기 수)을 고친다.

- [ ] **Step 3: `fail_run_start`를 구현하고 네 곳을 바꾼다**

순서(spec §4.1): `coord.cancel_dispatch_failed(run_id)` → `mark_failed_if_active(db, run_id, reason)?`가 `true`면 `Err(err)` → `at == BeforeEnqueue`면 `set_abort_reason_if_absent(db, run_id, ABORT_MSG_NOT_STARTED)?` → `runs::get`으로 읽어 `Aborted`면 `tracing::info!(run_id, reason, …)` 뒤 `Ok(row)`, 아니면 `Err(err)`.

네 곳(872·895·950·961)은 `cancel_dispatch_failed`·`mark_failed_if_active`·`return Err(…)` 세 줄을 `return fail_run_start(&state.coord, &state.db, &row.id, &msg, ApiError::BadRequest(msg.clone()), StartFailedAt::BeforeEnqueue).await;`로 바꾼다(`msg`를 빌려주면서 옮길 수 없으므로 `clone`). 895·961의 `release_pool_reservation` 줄은 그 앞에 그대로 둔다.

`fail_pool_assignment`(7번): 시그니처는 그대로, 몸통은 `fail_run_start(coord, db, run_id, POOL_ASSIGN_FAILED_MSG, ApiError::Internal(anyhow::anyhow!(POOL_ASSIGN_FAILED_MSG)), StartFailedAt::AfterEnqueue).await` 한 줄. 문서 주석은 사실만 남긴다. 이 task에 넣는 이유: `AfterEnqueue`를 쓰는 곳이 없으면 pre-commit의 `clippy -D warnings`가 dead_code로 커밋을 막는다. 동작은 지금과 같다 — 기존 `fail_pool_assignment_*` 셋이 고치지 않은 채 통과한다.

882(2번)·1017(6번)은 이 task에서 건드리지 않는다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo nextest run -p handicap-controller --features in-process prefail_ fail_run_start_ spawn_ fail_pool_assignment_`
Expected: 전부 PASS.

- [ ] **Step 5: 되돌려 확인**

네 곳을 하나씩 옛 세 줄로 되돌려 그 곳의 `…_returns_aborted_row` 테스트가 `Err`로 실패하는지 본다(넷 각각). 헬퍼의 `set_abort_reason_if_absent` 줄을 지우면 공통 단언의 사유가 실패하는지 본다. 헬퍼의 `at == BeforeEnqueue` 조건을 지워 항상 사유를 채우게 하면 `fail_pool_assignment_returns_row_when_aborted`가 `message` 단언으로 실패하는지 본다. 모두 원복한다.

- [ ] **Step 6: 커밋**

`git add crates/controller/src/api/runs.rs` → 메시지 `fix(controller): 풀 사전 실패 네 곳 — 이미 중단된 run은 오류 대신 그 행을 돌려준다, 생성 실패 처리를 헬퍼 하나로`.

---

### Task 2: 2번 곳(용량 부족)

**Files:**
- Modify: `crates/controller/src/api/runs.rs` — 882 근처 한 곳 + 인라인 테스트.

**Interfaces:**
- Consumes: Task 1의 `fail_run_start`·`StartFailedAt`·`only_run`·`abort_on_insert_trigger`·`pool_state_with_two_workers`.
- Produces: `CountingDispatcher`에 `cleanups: Arc<AtomicUsize>`(`cleanup` 호출 수) 추가. 기존 `state_with_counting`의 반환·동작은 그대로 둔다.

2번 곳은 사전 검사(`pool_achievable_capacity`)와 예약(`reserve_idle_pool_capacity`) 사이에 풀이 줄어야 닿는다. 방법(spec §5): 부하기 2대(각 100) · `vus = 150`으로 사전 검사를 통과시키고, 다른 연결이 `BEGIN IMMEDIATE`로 쓰기 잠금을 쥔 동안 `spawn_run`을 `tokio::spawn`으로 띄우고 `tokio::task::yield_now()`로 사전 검사까지 돌린 뒤 `state.coord.pool_exclude("w1", "test")`, 그다음 `ROLLBACK`, 태스크 결과를 받는다. 테스트는 `#[tokio::test]`(현재 스레드 런타임)여야 한다 — 다중 스레드면 「사전 검사가 `pool_exclude`보다 먼저」가 보장되지 않는다. 다른 연결은 `state.db.acquire()`로 얻되, 먼저 연결 둘을 얻어 하나를 돌려놓은 뒤 남은 하나로 `BEGIN IMMEDIATE`를 한다(띄운 태스크의 `insert`가 잠금 중에 새 연결을 여는 변수를 없앤다). `AppState`는 `Clone`이고 `ScenarioRow`는 `Clone`이 아니므로 태스크에 `move`로 넘긴다.

**이 방법이 결정적으로 되는지는 구현 중 실측으로 확정한다.** 아래 Step 2에서 20회 연속 같은 결과가 나오지 않으면 멈추고, 무엇이 나왔는지(409 / 201 / 멈춤)를 보고한다 — 그 경우 orchestrator가 「헬퍼 테스트 + 코드 대조」로 내리고 roadmap 검증 공백에 적는다(spec §5). 이때도 Step 3의 한 줄 교체는 한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

| 테스트 이름 | 준비 | 단언 |
|---|---|---|
| `prefail_insufficient_without_abort_fails_run` (US3 — 도달 증명) | 위 방법, 트리거 없음 | `Err(ApiError::Internal(e))`이고 `e.to_string() == "풀 용량 부족 (가용 100 VU < 요청 150 VU)"`, 행 `Failed` + 같은 사유, 남은 부하기 `w0`의 `assigned_run.is_none()` |
| `prefail_insufficient_returns_aborted_row` (US1·US2) | 위 방법 + `abort_on_insert_trigger` + `state.coord.set_dispatcher(Arc::new(CountingDispatcher{…}))` | `Ok(row)`, `Aborted`, `message == Some(ABORT_MSG_NOT_STARTED)`, **`cleanups == 0`**(늦게 빼서 `row_if_no_longer_pending` 길로 갔다면 1이다 — 도달 확인) |

- [ ] **Step 2: 돌려서 확인한다**

Run: `cargo nextest run -p handicap-controller --features in-process prefail_insufficient`
Expected: `without_abort`는 PASS(고치기 전 코드에서도 — 2번 곳에 닿는다는 증명), `returns_aborted_row`는 `Err`로 FAIL.
그다음 결정성 확인: 같은 명령에 `--stress-count 20`(nextest가 지원하지 않으면 20번 반복 실행). 20회 모두 같은 결과여야 한다.

- [ ] **Step 3: 882 한 곳을 바꾼다**

`return fail_run_start(&state.coord, &state.db, &row.id, &msg, ApiError::Internal(anyhow::anyhow!(msg.clone())), StartFailedAt::BeforeEnqueue).await;` — 지금의 문구·오류 종류 그대로.

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo nextest run -p handicap-controller --features in-process prefail_ spawn_` (+ 위 20회 반복)
Expected: 전부 PASS.

- [ ] **Step 5: 되돌려 확인**

882를 옛 세 줄로 되돌려 `prefail_insufficient_returns_aborted_row`가 `Err`로 실패하는지 본다. 원복한다.

- [ ] **Step 6: 커밋**

`git add crates/controller/src/api/runs.rs` → 메시지 `fix(controller): 풀 용량 부족 실패 — 이미 중단된 run은 그 행을 돌려준다`.

---

### Task 3: 6번 곳(디스패치 실패)과 주석·문서

**Files:**
- Modify: `crates/controller/src/api/runs.rs` — 1017 근처, `spawn_run` 머리 주석(710–715), 인라인 테스트.
- Modify: `crates/controller/src/grpc/coordinator.rs` — `cancel_dispatch_failed` 문서 주석(`grep -n "Tear down a run whose worker dispatch failed"`)의 호출처 설명을 지금 동작으로(주석만).
- Modify: `crates/controller/CLAUDE.md` — `grep -n "dispatch 실패는 권위 있는\|중단 API는 「가드 DB 기록\|풀 발사 = " crates/controller/CLAUDE.md`의 세 줄에서 「응답」 서술을 지금 동작으로: 생성 실패 일곱 곳은 `fail_run_start` 하나를 지나고, 행이 이미 `aborted`면 그 행을 `Ok`로 돌려준다(`enqueue` 전 다섯 곳만 빈 사유에 「시작 전」을 채운다).

**Interfaces:**
- Consumes: Task 1의 `fail_run_start`·`StartFailedAt`.
- Produces: 없음.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

시험용 디스패처 `FailingDispatcher { before_fail: BeforeFail }`(`mod tests` 안), `enum BeforeFail { Nothing, AbortInDb(Db), AbortViaApi(AppState) }`: `dispatch`가 `AbortInDb`면 `runs::abort_if_active(db, run_id)`를, `AbortViaApi`면 `super::abort_run(State(state.clone()), Path(run_id.to_string()))`를 부르고(둘 다 성공을 `unwrap`으로 확인), 어느 경우든 `Err(anyhow!("simulated dispatch failure"))`를 돌려준다. `cleanup`은 `Ok(())`. `AbortViaApi`에 넣는 `AppState`는 디스패처를 바꿔 끼우기 **전**의 복제본이다(`abort_run`은 디스패처를 쓰지 않는다). 풀 모드가 아닌 `state_with(db, 100)` + `call_spawn_run(…, 1, false)`.

| 테스트 이름 | 준비 | 단언 |
|---|---|---|
| `dispatch_failure_returns_aborted_row` (6ⓐ) | `AbortInDb` | `Ok(row)`, `Aborted`, `row.message == None`, DB 행도 `message == None` |
| `dispatch_failure_after_abort_api_keeps_api_reason` (6ⓑ) | `AbortViaApi` | `Ok(row)`, `Aborted`, DB 행 `message == Some(ABORT_MSG_NOT_STARTED)` |
| `dispatch_failure_without_abort_fails_run` (US3) | `Nothing` | `Err(ApiError::Internal(e))`이고 `e.to_string() == "failed to dispatch workers: simulated dispatch failure"`, 행 `Failed` + 같은 사유 |

- [ ] **Step 2: 돌려서 실패를 확인한다**

Run: `cargo nextest run -p handicap-controller --features in-process dispatch_failure_`
Expected: ⓐ·ⓑ는 `Err`로 FAIL, `without_abort`는 PASS.

- [ ] **Step 3: 구현**

1017 근처: `tracing::error!`는 그대로 두고 뒤의 세 줄을 `return fail_run_start(&state.coord, &state.db, &row.id, &message, ApiError::Internal(anyhow::anyhow!(message.clone())), StartFailedAt::AfterEnqueue).await;`로.
주석·문서 세 군데(Files 참고)를 고친다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo nextest run -p handicap-controller --features in-process dispatch_failure_ fail_pool_assignment_ prefail_ spawn_`
Expected: 전부 PASS. `tests/run_dispatch_failure_test.rs`의 `dispatch_failure_marks_run_failed_and_returns_5xx`도 이 필터에 걸려 고치지 않은 채 통과한다.

- [ ] **Step 5: 되돌려 확인**

① 1017을 옛 세 줄로 되돌리면 ⓐ·ⓑ가 `Err`로 실패. ② 헬퍼의 `at == BeforeEnqueue` 조건을 지워 항상 사유를 채우게 하면 ⓐ가 `message` 단언으로 실패. 모두 원복한다.

- [ ] **Step 6: 커밋**

`git add crates/controller/src/api/runs.rs crates/controller/src/grpc/coordinator.rs crates/controller/CLAUDE.md` → 메시지 `fix(controller): 디스패치 실패도 이미 중단된 run은 그 행을 돌려준다`.

---

### Task 4: 스케줄러 기록 (US1)

**Files:**
- Modify: `crates/controller/src/schedule/runner.rs` — 인라인 테스트만(`mod tests`, 293–). 운영 코드 무변경.

**Interfaces:**
- Consumes: Task 1의 동작(풀 모드·빈 풀에서 `spawn_run`이 중단된 행을 `Ok`로).

- [ ] **Step 1: 테스트를 쓴다**

`test_state()` 뒤 `state.coord.set_pool_mode(true)`. 트리거 SQL은 `api/runs.rs`의 `abort_on_insert_trigger`와 같은 글자를 이 파일 테스트 안에 둔다(그 틀은 다른 모듈의 비공개 함수다). 스케줄은 `cron_due_fires_and_advances`와 같은 식(`Trigger::Cron`, `Some(NOW - 1_000)`).

| 테스트 이름 | 준비 | 단언 |
|---|---|---|
| `fire_aborted_during_create_records_fired` | 풀 모드 · 부하기 없음 · 트리거 | `sum.fired == 1`·`sum.errored == 0`, `last_status == Some("fired")`, `last_run_id`가 있고 그 run이 `Aborted` + `message == Some(runs::ABORT_MSG_NOT_STARTED)`, 기록 1건 `kind == "fired"`·`run_id == Some(그 id)` |
| `fire_pool_empty_records_error` (US3) | 풀 모드 · 부하기 없음 · 트리거 없음 | `sum.errored == 1`, 기록 1건 `kind == "error"`·`run_id == None`·`detail`이 `발사 실패: `로 시작하고 `연결된 LAN 워커가 없습니다`를 포함 |

- [ ] **Step 2: 돌려서 확인한다**

Run: `cargo nextest run -p handicap-controller --features in-process fire_aborted_during_create fire_pool_empty`
Expected: 둘 다 PASS(Task 1이 이미 들어가 있다).

- [ ] **Step 3: 되돌려 확인**

`api/runs.rs`의 1번 곳(용량 고려 갈래의 빈 풀)을 옛 세 줄로 되돌리면 `fire_aborted_during_create_records_fired`가 `sum.fired` 단언으로 실패하는지 본다. 원복하고 `git diff --stat`으로 `api/runs.rs`에 변경이 없음을 확인한다.

- [ ] **Step 4: 커밋**

`git add crates/controller/src/schedule/runner.rs` → 메시지 `test(controller/schedule): 생성 도중 중단된 run의 발사 기록 — 발사됨 + run 번호`.

---

### Task 5: 라이브 검증 (orchestrator가 직접, `/live-verify`)

spec §6의 표 다섯 줄을 그대로 실행한다. 워크트리 자체 바이너리(`cargo build -p handicap-controller -p handicap-worker` 뒤 `./target/debug/controller`), 파일 DB `/tmp/pool-prefail-response.db`, `--worker-mode pool`, `--scheduler-tick-seconds 1`, 포트는 `lsof`로 비었는지 읽고 정한다. 트리거는 `sqlite3 /tmp/pool-prefail-response.db`로 만든다(Task 1 테스트의 SQL과 같은 글자). UI는 `ui/dist`를 빌드해 run 상세 화면에서 「중단 사유」가 보이는지 한 번 본다(UI 코드는 안 바뀌었다 — 생성 응답이 `aborted`인 경우의 응답 파싱 확인).

- [ ] US3: 빈 풀 `POST /api/runs` → 400 + 행 `failed`
- [ ] US2: 트리거 뒤 `POST /api/runs` → 201 `aborted` + 사유, 상세 화면
- [ ] US2: 트리거 뒤 `POST /api/runs?force=true` → 201 `aborted` + 사유
- [ ] US1: 트리거 상태에서 1회 스케줄 → 기록 「발사됨」+run 번호
- [ ] US3: `DROP TRIGGER` 뒤 새 1회 스케줄 → 기록 「발사 실패: …」
- [ ] 못 본 곳(2·3·5·6번은 단위 테스트로만)을 build-log에 적는다.
- [ ] spec §7의 항목을 roadmap §B 새 블록에 적는다(번호는 `grep -n '^### B' docs/roadmap.md`의 마지막 +1): §4.2의 비용 둘과 해소 경로 · US1의 한계 · 2번 곳 테스트가 결정적으로 안 됐으면 그 공백 · 라이브로 못 본 곳 · §B79 (2) 첫 항목 해소 표시 · 다음 릴리즈 노트 줄. (`/finish-slice`에서 함께 한다.)
