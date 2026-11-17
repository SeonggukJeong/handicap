# 끝난 run 항목 정리 + 「제외」 틈 묘비 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 끝난 run의 조정 항목과 송신 복사본을 즉시 놓아 워커의 2초 대기·메모리 누적을 없애고, 그 결과 생기는 「전할 수 없는 제외」를 묘비로 막고, 재등록 없이 떠난 워커를 10초 뒤 목록에서 지운다.

**Architecture:** 모두 `crates/controller/src/grpc/coordinator.rs`의 `CoordinatorState` 안. 풀 항목의 식별을 송신 채널 비교(`same_channel`)에서 등록 세대(`generation: u64`)로 바꿔 송신 없는 재등록 대기 항목도 자기 것을 알아보게 하고(Task 1), 「몫을 끝냄」 판정을 run 항목에서 풀 항목으로 옮긴 뒤(Task 2), 최종화 순간 run 항목을 지운다(Task 3). 그 위에 배정 실패 덮어쓰기 가드·배정 못 받은 예약 해제(Task 4)·대기 10초 타이머(Task 5)·묘비(Task 6)를 얹고, 실제 부하기 e2e로 2초 대기 소멸을 증명한다(Task 7).

**Tech Stack:** Rust 2024, tokio(mpsc·`time::pause`), tonic gRPC, sqlx SQLite, cargo nextest.

**Spec:** `docs/superpowers/specs/2026-11-17-run-workers-cleanup-design.md` (APPROVE 4라운드). 구현자는 spec R0–R8을 함께 읽는다.

**Plan review:** spec-plan-reviewer APPROVE (2라운드, 2026-11-17) · R9 편입(Task 4 확장) 후 재검토 APPROVE (3라운드 추가, 2026-11-17). spec도 R9 편입 후 재검토 APPROVE.

REVIEW-GATE: APPROVED


## Global Constraints

- proto·migration·REST 응답 모양·UI·워커 동작 무변경(spec R0). 워커 크레이트는 주석 한 곳만(Task 8).
- 락 규율 R14: `runs` 락과 `pool` 락을 겹쳐 잡지 않는다. 락을 쥔 채 `.await` 없음.
- 최종화의 DB 쓰기·verdict 영속·fan-out 순서·사유 문구 그대로. 모든 terminal 전이 지점은 `rw.done.cancel()`을 지금처럼 부른 뒤 맵에서 제거(토큰은 drop으로 취소되지 않는다).
- 재등록 대기 자체 기한 = **10초** 상수 `AWAIT_REREGISTER_GRACE`. 묘비 만료 = 하트비트의 `stale` 인자(만든 시각 기준).
- 묘비는 **전달 불가일 때만**(항목 `tx`가 `None` 또는 `tx.is_closed()`), **한 번 쓰면 삭제**, 확인은 `check_token`·풀 모드 검사 **뒤**, 맞으면 `Disconnect{reason}` 후 핸들러 `break`.
- 결함을 변호하는 새 주석 금지(working-rules §7) — 사라진 동작을 설명하는 주석은 지운다.
- 각 task는 독립 green 커밋(`git commit`이 pre-commit cargo 게이트 전체를 돈다 — 단일 FOREGROUND 호출, timeout 600000, 파이프 금지, `; echo exit=$?`). 회귀 가드 테스트마다 **되돌려 확인**(고의 회귀 → RED 확인 → 원복 → GREEN)을 실행하고 보고서에 그 명령·결과를 적는다.
- 테스트 실행: `cargo nextest run -p handicap-controller --features in-process <필터>` (워크트리 루트에서). **`--features in-process` 필수** — `pool_control_across_runs_test.rs`·`pool_desktop_worker_test.rs`는 `#![cfg(feature = "in-process")]`라 `-p handicap-controller`만으로는 빈 파일로 컴파일돼 공허하게 통과한다(이 plan의 모든 「전체 PASS」 단계에 적용).
- `ingest_metrics`는 run이 없어도 이미 행을 넣는다(`coordinator.rs:1724-1729`) — spec R1의 ingest 항은 코드 변경 없음.
- Task 1–5 커밋 사이에선 재등록 대기 항목의 송신이 없어 그 동안의 「제외」가 전달되지 않는다(Task 6이 해소, spec의 같은-머지 규칙) — 이 구간 커밋은 bisect 용도로 쓰지 않는다.

## Review Focus

1. **옛 스트림 close가 새 등록 뒤에 처리됨**(워커가 다시 붙은 직후 옛 핸들러의 close가 늦게 옴) → 새 항목은 그대로(세대 불일치 no-op). Task 1 테스트 `stale_generation_close_keeps_newer_registration`.
2. **다른 run의 늦은 보고**(워커가 이미 다음 run에 배정된 뒤 옛 run_id의 RunStatus가 옴) → 새 run의 「몫을 끝냄」 표시를 세우지 않는다(`assigned_run == Some(run_id)` 조건). Task 2 테스트 `report_for_other_run_sets_no_flag`.
3. **Task 2 중간 상태 — run이 terminal로 맵에 남아 있는데 형제의 늦은 Aborted가 옴**(Failed·스스로 중단 run) → 형제 항목 유지(09bb1914 회귀 금지). Task 2 테스트 `failed_run_sibling_late_aborted_keeps_entry`·`self_abort_sibling_keeps_entry`.
4. **대기 항목을 연달아 두 번 「제외」** → 첫 번째 `true`+묘비, 두 번째 `false`(404 — 항목 없음), 묘비는 하나. Task 6 테스트 `double_exclude_awaiting_second_is_not_found`.
5. **짧은 run을 연달아 돌려 같은 워커가 새 세대로 다시 대기 상태일 때 옛 타이머가 발화** → 지우지 않음(세대 불일치). Task 5 테스트 `old_timer_ignores_new_awaiting_generation`.

---

### Task 1: 풀 항목 식별을 등록 세대로 + 재등록 대기 항목은 송신을 놓는다 (spec R4)

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` — `PoolEntry`(`:83-114`), `CoordinatorState`(`:222-252`, `new`), `pool_register_idle`(`:399`), `pool_heartbeat_tick`(`:511`), `pool_evict_if_same`(`:555`), `pool_stream_closed`(`:577`), `pool_exclude`(`:666`), 예약 경로(`reserve_idle_pool` `:314`, `reserve_idle_pool_capacity` `:711`, `release_pool_reservation` `:761`), 스트림 핸들러 Register·close 분기(`:1484-1505`, `:1615-1621`), 테스트 모듈
- Test: 같은 파일 `#[cfg(test)] mod tests`; `crates/controller/tests/pool_api_test.rs:95`는 반환값을 무시하므로 무수정

**Interfaces:**
- Produces:
  - `PoolEntry.tx: Option<WorkerTx>` (재등록 대기 = `None`), `PoolEntry.generation: u64`
  - `CoordinatorState.next_generation: Arc<AtomicU64>` (`new`에서 1부터)
  - `pub async fn pool_register_idle(&self, worker_id: &str, tx: WorkerTx, capacity_vus: u32, hostname: String, stable: bool) -> u64` — 매 호출 새 세대를 매겨 항목에 쓰고 돌려준다
  - `pub async fn pool_stream_closed(&self, worker_id: &str, generation: u64)`
  - `async fn pool_evict_if_same(&self, worker_id: &str, generation: u64)`
  - 핸들러: `pool_gen: Option<u64>`를 Register에서 받아 close 때 넘긴다

- [ ] **Step 1: 실패하는 테스트 작성** — 테스트 모듈에:
  - 도우미 `pool_worker_in_run`은 `(run_id, generation, stream_tx, rx)`를 돌려주게 바꾼다(`stream_tx` = 핸들러 몫 송신 — Task 3이 drop해야 한다).
  - `awaiting_entry_drops_sender`: `pool_worker_in_run` → `record_phase(Completed)` → `pool_stream_closed("w0", gen)` → `pool.lock()`의 `w0` 항목이 `awaiting_reregister == true` **그리고** `tx.is_none()`.
  - `stale_generation_close_keeps_newer_registration`(`evict_with_old_tx_keeps_newer_registration` 대체): `g1 = pool_register_idle("w1", ..)`, `g2 = pool_register_idle("w1", ..)`, `assert_ne!(g1, g2)`; `pool_evict_if_same("w1", g1)` → idle 1개 남음; `pool_stream_closed("w1", g1)` → 남음; `pool_evict_if_same("w1", g2)` → 0개.
  - 기존 테스트를 새 시그니처로 옮긴다(`pool_stream_closed(.., &stx)` → 세대, `awaiting_entry_with_closed_tx`는 `tx = None`으로 대기 상태를 만든다, `pool_register_idle_preserves_control_and_refreshes_tx`는 `e.tx.as_ref().unwrap().same_channel(..)`).

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --features in-process awaiting_entry_drops_sender stale_generation_close` → 컴파일 오류(시그니처) 또는 FAIL.

- [ ] **Step 3: 구현** — 위 Interfaces대로. `pool_stream_closed`가 대기로 남길 때 `e.tx = None`. 모든 `same_channel` 비교를 `e.generation == generation`으로. 하트비트 스냅숏은 `(id, Option<WorkerTx>, generation, is_stale, awaiting)`를 잡고 stale 제거는 세대로, Ping은 `Some(tx)`일 때만. 예약 경로는 `assigned_run.is_none()`인 항목만 보므로 `tx`가 늘 `Some`이지만 `if let Some(tx)`로 건너뛴다. `pool_exclude`의 `try_send`는 `Some`일 때만(묘비는 Task 6). `PoolEntry.awaiting_reregister`·`pool_stream_closed` 문서 주석의 「dead `tx`」 서술을 「송신 없음」으로 고친다.

- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller --features in-process` 전체 PASS.

- [ ] **Step 5: 되돌려 확인** — `e.tx = None` 줄을 지워 `awaiting_entry_drops_sender` RED, 세대 비교를 `true`로 바꿔 `stale_generation_close_keeps_newer_registration` RED → 원복 → GREEN.

- [ ] **Step 6: 커밋** — `git add crates/controller/src/grpc/coordinator.rs` → `git commit -m "refactor(controller): 풀 항목을 등록 세대로 식별 — 재등록 대기 항목은 송신을 놓는다"`

---

### Task 2: 「몫을 끝냄」을 풀 항목에 기록 (spec R3)

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` — `PoolEntry`, `record_phase`(`:962`), `pool_stream_closed`, `pool_register_idle`, `worker_finished_part`(`:604` — 삭제)
- Test: 같은 파일

**Interfaces:**
- Consumes: Task 1의 `pool_register_idle -> u64`, `pool_stream_closed(worker_id, generation)`
- Produces: `PoolEntry.finished_part: bool`; `async fn pool_mark_finished(&self, run_id: &str, worker_id: &str)` — 항목이 있고 `assigned_run.as_deref() == Some(run_id)`이면 `finished_part = true`; 테스트 도우미 `async fn two_pool_workers_in_run(coord, db) -> (String, [(String, u64, WorkerTx, Receiver); 2])`(`w0`·`w1` 풀 등록 → 예약 → enqueue(expected 2) → `assign_pool_workers`; 기존 `two_worker_run`(`:4311`)은 풀 기반이 아니라 못 쓴다)

- [ ] **Step 1: 실패하는 테스트 작성**
  - `aborted_after_run_removed_counts_as_finished`: `pool_worker_in_run` → `cancel_dispatch_failed(&run_id)`(run 항목 제거) → `record_phase(Aborted)` → `pool_stream_closed` → `pool_entry_awaiting == Some(true)` (spec R3 행동 변화).
  - `report_for_other_run_sets_no_flag`(Review Focus 2): `pool_worker_in_run` → `record_phase("other-run", "w0", Completed)` → `pool_stream_closed` → `None`(제거).
  - `non_member_report_sets_no_flag`: run에 등록 안 된 풀 워커 `w9`(assigned_run을 그 run으로 직접 세팅)가 `record_phase(run_id, "w9", Completed)` → close → `None`.
  - `reregister_clears_finished_flag`: 끝냄 표시 세운 뒤 `pool_register_idle` → `finished_part == false`.
  - `failed_run_sibling_late_aborted_keeps_entry`(US4, Review Focus 3): `two_pool_workers_in_run`, w1에 `pool_set_control(label=Some("keep"))` → w0 `Failed` → w1 `record_phase(Aborted)` → `pool_stream_closed(w1, g1)` → `Some(true)`·라벨 유지. (이 task 상태에선 run이 terminal로 맵에 남고 `abort_requested == false` — 분류가 `abort_requested`를 보면 여기서 깨진다.)
  - `self_abort_sibling_keeps_entry`: w0 스스로 `Aborted`(run terminal) → w1 fan-out 뒤 `Aborted` → w1 close `Some(true)`, w0 close `None`.
  - `two_pool_workers_controller_abort_keeps_both`(US4 사용자 중단): `abort(run)` → 둘 다 `Aborted` → 둘 다 close → 둘 다 `Some(true)`.
  - 기존 `stream_closed_after_*` 5개는 그대로 통과해야 한다.

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --features in-process aborted_after_run_removed other_run non_member reregister_clears_finished failed_run_sibling self_abort_sibling two_pool_workers_controller_abort` → FAIL(컴파일 오류 또는 첫 테스트 FAIL — 지금은 제거됨; 형제 테스트들은 지금 통과할 수 있다 — 이 task의 회귀 가드라 Step 5에서 이빨을 본다).

- [ ] **Step 3: 구현** — `record_phase`의 runs 락 블록이 `pool_mark: bool`을 함께 돌려주게: spec R3 표를 **위에서부터 먼저 맞는 줄**로 — run 있음+구성원 아님 → false · Completed/Failed → true · Aborted+run 있음 → **`!e.self_aborted`**(블록 끝, `self_aborted`를 세우는 Aborted 분기 **뒤**에 읽는다 — `self_aborted`는 run이 활성이고 `abort_requested`가 없을 때만 세워지므로 terminal run의 늦은 Aborted는 끝냄; 이 필드는 `worker_finished_part` 삭제 뒤 유일한 읽기라 dead_code 경고도 막는다) · Aborted+run 없음 → true. run 없음 분기(`let Some(rw) .. else`)는 phase가 Completed/Failed/Aborted면 `pool_mark = true`로 락을 빠져나온다. 락을 놓은 **직후, `match decision` 전에** `if pool_mark { self.pool_mark_finished(run_id, worker_id).await }`. `pool_stream_closed`는 `e.finished_part`로 판정, `worker_finished_part` 삭제, 재등록 시 `finished_part = false`.

- [ ] **Step 4: 통과 확인** — 전체 `cargo nextest run -p handicap-controller --features in-process` PASS.

- [ ] **Step 5: 되돌려 확인** — 두 자리를 따로: (i) run-없음 분기의 Aborted `true`를 `false`로 → `aborted_after_run_removed_counts_as_finished` RED (ii) run-있음 분류 `!e.self_aborted`를 `false`로 → `stream_closed_after_controller_requested_abort_keeps_entry`·`failed_run_sibling_late_aborted_keeps_entry` RED (iii) `assigned_run` 조건 제거 → `report_for_other_run_sets_no_flag` RED → 각각 원복 → GREEN.

- [ ] **Step 6: 커밋** — `refactor(controller): 「몫을 끝냄」을 풀 항목에 기록 — run 항목 없이 판정`

---

### Task 3: 최종화 순간 run 항목 제거 + 끝 보고한 워커의 송신 해제 (spec R1·R2)

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` — `WorkerEntry`(`:138`), `RunWorkers`(`:151`, `terminal` 필드 삭제), `enqueue`, `register`(`:839`), `record_phase`, `worker_disconnected`(`:1126`), `fail_run_hung`(`:1178`), `fail_incomplete_registration`, `abort`(`:1262`), `RegisterOutcome::Reject` 문서(`:210`), `pool_exclude` 문서(`:663`), 핸들러 `NoRun` 로그(`:1540` `error!` → `warn!`)
- Test: 같은 파일

**Interfaces:**
- Consumes: Task 2의 `pool_mark_finished`
- Produces: `WorkerEntry.tx: Option<WorkerTx>`(`self_aborted`는 유지); 테스트 도우미 `async fn run_done_token(coord: &CoordinatorState, run_id: &str) -> CancellationToken`(맵에 있을 때 `done` 복제)·`async fn run_present(coord, run_id) -> bool`

- [ ] **Step 1: 실패하는 테스트 작성** — 각 경로 뒤 `!run_present` **그리고** `done.is_cancelled()`(`done`은 경로 실행 전에 `run_done_token`으로 잡는다):
  - `run_removed_after_completed_single`, `run_removed_after_completed_two_workers`(첫 Completed 뒤엔 `run_present`, 둘째 뒤 제거), `run_removed_after_failed`, `run_removed_after_controller_abort`(`abort` → Aborted 보고), `run_removed_after_self_abort`, `run_removed_after_worker_disconnected`, `run_removed_after_fail_run_hung`, `run_removed_after_registration_deadline`(`fail_incomplete_registration`).
  - `worker_response_closes_after_terminal_report`(US2): 풀 워커 하나 — 테스트가 `stream_tx` 복제(핸들러 몫)와 수신기 `rx0`를 쥔다 → `record_phase(Completed)` → `pool_stream_closed` → `drop(stream_tx)` → `timeout(1s, rx0.recv())`가 `None`(앞서 받은 Assignment 등은 먼저 비운다).
  - `first_finisher_response_closes_before_sibling`: 두 워커 run에서 w0만 Completed + close + 핸들러 몫 drop → `rx0`가 `None`, run은 아직 `run_present`.
  - Task 2의 `failed_run_sibling_late_aborted_keeps_entry`·`self_abort_sibling_keeps_entry`·`two_pool_workers_controller_abort_keeps_both`는 이 task 뒤에도(run이 이제 맵에서 **없는** 상태로) 그대로 통과해야 한다.
  - `duplicate_terminal_report_after_removal_is_noop`: Completed 두 번 → 패닉 없음·awaiting 유지.
  - `late_register_for_finished_run_is_norun`: 끝난 run에 `register` → `RegisterOutcome::NoRun`.

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --features in-process run_removed_after worker_response_closes first_finisher duplicate_terminal late_register_for_finished` → FAIL.

- [ ] **Step 3: 구현** — terminal 전이 5곳(`record_phase` Failed/Aborted/Completed, `worker_disconnected` fail-fast, `fail_run_hung`): 같은 락 블록에서 `rw.done.cancel()` → 형제 송신 수집 → `g.remove(run_id)`. `terminal` 필드와 그 검사 삭제(맵에 있으면 활성). `record_phase`는 그 워커의 phase를 끝 phase로 기록할 때 `e.tx.take()`; fan-out 수집은 `Some`만(`filter_map`). `worker_disconnected`의 「terminal 워커는 남긴다」 분기는 run이 활성일 때만 의미가 있으므로 유지하되 `rw.terminal` 조건만 뺀다. `register`의 `if rw.terminal { Reject }` 삭제(초과 등록 `Reject`는 유지). `NoRun` 로그 `warn!`. 사라진 동작을 말하는 주석(「absorbed by the terminal guard」 등)을 고친다. Aborted 분기에 `g.remove`가 들어가면 빌림 검사가 Task 2의 `pool_mark`(`!e.self_aborted` 읽기)를 제거 **전에** 계산하게 강제한다 — 단 `self_aborted`를 세운 **뒤**에 읽어야 한다(순서가 틀리면 `stream_closed_after_self_abort_removes_entry`가 잡는다).

- [ ] **Step 4: 통과 확인** — 전체 `cargo nextest run -p handicap-controller --features in-process` PASS(기존 `complete_then_disconnect_then_sibling_completes_finalizes`·`fail_run_hung_fails_active_and_noops_terminal` 포함).

- [ ] **Step 5: 되돌려 확인** — (a) `record_phase` Completed 분기의 `g.remove`를 지워 `run_removed_after_completed_single` RED (b) 그 분기에서 `done.cancel()`을 지우고 `remove`만 남겨 `done.is_cancelled()` 단언 RED (c) `e.tx.take()`를 지워 `first_finisher_response_closes_before_sibling` RED(부하기 1대 run은 최종화 때 항목째 지워져 `take()` 없이도 닫히므로 이 2대 테스트가 `take()`의 이빨이다) (d) Task 1의 `e.tx = None`(대기 항목 송신 해제)을 지워 `worker_response_closes_after_terminal_report` RED (e) Task 2의 run-없음 Aborted `true`를 `false`로 → 이제 `failed_run_sibling_late_aborted_keeps_entry` RED(run이 지워졌으므로 그 분기를 탄다) → 원복 → GREEN.

- [ ] **Step 6: 커밋** — `fix(controller): 끝난 run 항목을 최종화 순간 지우고 끝 보고한 워커의 송신을 놓는다`

---

### Task 4: 풀 배정 실패 — 끝난 run을 덮지 않고, 배정 못 받은 예약 워커를 풀어 준다 (spec R1 `assignment_for` 항 · R9)

**Files:**
- Modify: `crates/controller/src/api/runs.rs` — `assign_pool_workers` 실패 분기 두 곳(`:903-912`, `:969-978`); `crates/controller/src/grpc/coordinator.rs` — `assign_pool_workers`(`:335`), 새 `release_unsent_reservations`
- Test: `crates/controller/src/api/runs.rs` `#[cfg(test)]`(`:1370` 모듈) + `coordinator.rs` 테스트

**Interfaces:**
- Produces: `async fn fail_pool_assignment(coord: &CoordinatorState, db: &Db, run_id: &str) -> Result<ApiError, sqlx::Error>` — `coord.cancel_dispatch_failed(run_id)` → `runs::mark_failed_if_active(db, run_id, POOL_ASSIGN_FAILED_MSG)` → `ApiError::Internal(anyhow!(POOL_ASSIGN_FAILED_MSG))`. 상수 `POOL_ASSIGN_FAILED_MSG = "풀 워커 배정 실패(워커 이탈) — 재시도하세요"`(문구 그대로). 호출부: `return Err(fail_pool_assignment(&state.coord, &state.db, &row.id).await?);`
- Produces (R9): `async fn release_unsent_reservations(&self, run_id: &str, worker_ids: &[String])` — pool 락 한 구간에서 각 ID의 항목이 `assigned_run.as_deref() == Some(run_id)`이고 `tx`가 `Some`이며 `!is_closed()`이면 `assigned_run = None`(풀 항목 자신의 `tx`만 본다). 기존 `release_pool_reservation`(`:761`)은 무변경. `assign_pool_workers`는 루프 전에 `let ids: Vec<String> = reserved.iter().map(|(id, _)| id.clone()).collect();`를 모으고 `reserved`는 지금처럼 `into_iter().enumerate()`로 **소비**한다(각 `tx` 복제가 그 회차 끝에 놓이게 — 참조로 돌면 모든 복제가 함수 끝까지 살아 먼저 끝난 워커의 응답 쪽이 닫히지 않는다, US2). 순수 함수 `enum AssignStep { NotAssigned, NoAssignment, SendFailed }` + `fn release_start(failed_at: AssignStep, i: usize) -> usize`(`NotAssigned` → `i`, 나머지 → `i + 1`). `NotAssigned` 분기엔 한 줄 주석: 이 분기는 `NoRun`·초과 등록 `Reject`만 예상한다(예약 ID는 겹치지 않아 `Resend` — 이미 구성원 — 은 오지 않는다; 오면 k를 풀면 안 된다). 실패 분기마다 `Err` 반환 직전에 `self.release_unsent_reservations(run_id, &ids[release_start(step, i)..]).await`: `register` 비-Assigned 분기는 k 포함, `assignment_for` `None`·배정 `send` 실패 분기는 **k 제외**(`register`가 Assigned를 돌려줬으니 k는 run 구성원이고 그 run의 최종화 Abort가 오는 중이다; 풀면 다음 run 배정 대기 중 옛 Abort를 받아 새 run이 실패할 수 있다, spec R9).

- [ ] **Step 1: 실패하는 테스트 작성**
  - (coordinator.rs) `assign_to_removed_run_errs_without_db_write`: run을 seed·enqueue·reserve 뒤 `cancel_dispatch_failed`로 제거 → `assign_pool_workers` → `Err`, DB status는 seed 그대로(`pending`), **예약된 워커는 다시 유휴**(`register` 비-Assigned 분기의 R9 해제 — 수신기는 테스트 끝까지 쥔다).
  - (api/runs.rs) `fail_pool_assignment_keeps_finished_run`: DB에서 `completed`로 만든 run → 함수 호출 → status `completed`·message 그대로. `fail_pool_assignment_fails_active_run`: `pending` run → `failed` + 문구 일치.
  - (coordinator.rs, R9) `partial_assign_failure_releases_unsent_workers`: 풀 워커 `a`·`b`·`c`·`d` 등록 → `reserve_idle_pool` → 반환 Vec을 `[a, b, c, d]` 순으로 재정렬(`HashMap` 순서라) → `b`·`d`의 수신기 drop → enqueue(expected 4) → `assign_pool_workers` `Err`(b에서 전송 실패) → `c`는 `assigned_run == None`(유휴, 다음 `reserve_idle_pool`에 잡힘) · `d`는 `Some(run)` 그대로(해제 범위 안이지만 닫힌 송신 — 풀지 않음) · `b`는 `Some(run)` 그대로(실패 지점 — 닫힌 송신이라 송신 가드가 막는다; k+1 규칙의 증거가 아니다) · `a`는 `Some(run)` 그대로(배정 받음).
  - (coordinator.rs, R9) `release_start_per_failure_step`: `release_start(NotAssigned, 2) == 2`, `release_start(NoAssignment, 2) == 3`, `release_start(SendFailed, 2) == 3` — 분기 2·3의 「k 제외」 규칙의 유일한 이빨.
  - (coordinator.rs, R9) `release_unsent_skips_other_run`: **살아 있는 등록**(수신기를 `_rx`로 테스트 끝까지 쥠, `tx`가 `Some`)인데 `assigned_run`이 다른 run(`"r-other"`)인 항목 → `release_unsent_reservations("r-this", &[id])` 뒤에도 `Some("r-other")`. (수신기가 죽어 있으면 송신 가드가 먼저 막아 `assigned_run` 가드의 이빨이 안 보인다.)

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --features in-process fail_pool_assignment assign_to_removed_run partial_assign_failure release_unsent release_start` → 컴파일 오류(함수 없음).

- [ ] **Step 3: 구현** — Interfaces대로, 두 호출부를 함수 호출로, `assign_pool_workers` 세 실패 분기에 예약 해제.

- [ ] **Step 4: 통과 확인** — 전체 PASS.

- [ ] **Step 5: 되돌려 확인** — (a) 함수 안 `mark_failed_if_active`를 `mark_failed`로 바꿔 `fail_pool_assignment_keeps_finished_run` RED (b) `send` 실패 분기의 `release_unsent_reservations` 호출을 지워 `partial_assign_failure_releases_unsent_workers` RED (c) `!is_closed()` 조건을 빼서 같은 테스트의 `d` 단언 RED (c') `release_start`의 `SendFailed`/`NoAssignment` 팔을 `i`로 바꿔 `release_start_per_failure_step` RED. **이빨 없는 자리(코드 리뷰 확인 항목)**: 각 호출부가 맞는 변형을 넘기는지(분기 1 `NotAssigned`·분기 2 `NoAssignment`·분기 3 `SendFailed`)는 테스트가 못 잡는다 — 보고서에 세 줄을 인용해 리뷰어가 대조하게 한다 (d) `assigned_run` 가드를 빼서 `release_unsent_skips_other_run` RED (e) `register` 비-Assigned 분기의 해제 호출을 지워 `assign_to_removed_run_errs_without_db_write`의 유휴 단언 RED → 각각 원복 → GREEN. (`assignment_for` `None` 분기는 경쟁으로만 닿아 테스트 없이 둔다.)

- [ ] **Step 6: 커밋** — `fix(controller): 풀 배정 실패 — 끝난 run을 덮지 않고 배정 못 받은 예약 워커를 풀어 준다`

---

### Task 5: 재등록 대기 항목의 자체 기한 10초 (spec R5)

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` — `pool_stream_closed`, 새 `pool_expire_awaiting`
- Test: 같은 파일

**Interfaces:**
- Consumes: Task 1 세대
- Produces: `const AWAIT_REREGISTER_GRACE: Duration = Duration::from_secs(10);` · `async fn pool_expire_awaiting(&self, worker_id: &str, generation: u64)` — 항목이 `awaiting_reregister && generation` 일치면 조용히 제거(run 처리 없음). `pool_stream_closed`가 대기로 남긴 직후 **spawn 전에** `let deadline = tokio::time::Instant::now() + AWAIT_REREGISTER_GRACE;`를 잡고 `tokio::spawn`(코디네이터 복제 + `sleep_until(deadline)` → `pool_expire_awaiting`). (`sleep(dur)`은 spawn된 태스크가 처음 poll될 때 기한을 정하므로 current-thread 테스트에서 기한이 밀린다.)

- [ ] **Step 1: 실패하는 테스트 작성** — DB를 쓰는 준비(`pool_worker_in_run`·`record_phase(Completed)` — `seed_run`·`set_status`·리포트 빌드)는 **전부 `tokio::time::pause()` 전에** 끝내고, 멈춘 뒤엔 DB를 안 쓰는 호출만(`pool_stream_closed`·`pool_register_idle(stable=false)`·락 아래 필드 세팅):
  - `awaiting_entry_expires_after_grace`(US3): 준비 → `pause()` → `pool_stream_closed(w0, g1)` → `advance(9s)`+`yield_now` 후 `Some(true)` → `advance(2s)`+`yield_now` 후 `None`.
  - `old_timer_ignores_new_awaiting_generation`(Review Focus 5): 준비 → `pause()` → close(g1) at t0 → `advance(5s)` → `g2 = pool_register_idle(w0)` → 락 아래 `assigned_run = Some("r2")`·`finished_part = true` 세팅(다음 run을 끝낸 상태 모사) → `pool_stream_closed(w0, g2)`(t=5, 새 타이머) → `advance(5.5s)`(t=10.5, g1 타이머 발화)+`yield_now` 후 `Some(true)` → `advance(5s)`(t=15.5)+`yield_now` 후 `None`.

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --features in-process awaiting_entry_expires old_timer_ignores` → 둘 다 FAIL(타이머 없음 → 15.5초에도 남음).

- [ ] **Step 3: 구현** — Interfaces대로.

- [ ] **Step 4: 통과 확인** — 전체 PASS.

- [ ] **Step 5: 되돌려 확인** — `pool_expire_awaiting`의 세대 비교를 빼서 `old_timer_ignores_new_awaiting_generation` RED(10.5초에 지워짐), spawn을 지워 `awaiting_entry_expires_after_grace` RED, `sleep_until(deadline)`을 `sleep(GRACE)`로 바꿔 `awaiting_entry_expires_after_grace` RED → 원복 → GREEN.

- [ ] **Step 6: 커밋** — `feat(controller): 재등록 없이 떠난 풀 워커를 10초 뒤 목록에서 지운다`

---

### Task 6: 「제외」 묘비 (spec R6)

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` — `pool` 필드 타입, 모든 `pool.lock()` 사용처(약 30곳, 테스트 17곳 포함 — 기계적 `.entries` 치환), `pool_exclude`, `pool_register_idle`, `pool_heartbeat_tick`, 핸들러 Register 분기
- Test: 같은 파일(단위 + 이 파일의 tonic 서버 테스트 패턴 `acceptance_ping_is_sent_after_pool_insert` `:2764`)

**Interfaces:**
- Consumes: Task 1 `Option<WorkerTx>`·세대
- Produces:
  - `struct PoolState { entries: HashMap<String, PoolEntry>, tombstones: HashMap<String, Tombstone> }`, `struct Tombstone { reason: String, created: tokio::time::Instant }`; `pool: Arc<Mutex<PoolState>>`
  - `pub enum IdleRegister { Registered { generation: u64 }, Tombstoned { reason: String } }`; `pool_register_idle(..) -> IdleRegister` — 락 구간 안에서 묘비를 먼저 보고 있으면 지우고 `Tombstoned`(항목 안 넣음)
  - `pool_exclude`: 같은 락 구간에서 항목 제거 + `tx`가 `None`이거나 `is_closed()`면 묘비 삽입; 락 뒤 순서(`worker_disconnected` → `try_send(Disconnect)`) 그대로, 반환 그대로
  - `pool_heartbeat_tick`: `now - created > stale`인 묘비 삭제
  - 핸들러: `Tombstoned { reason }` → `tx.send(Disconnect{reason})` → `break`(`pool_conn` 안 세움, 수락 Ping 없음)

- [ ] **Step 1: 실패하는 테스트 작성**
  - `exclude_awaiting_leaves_tombstone_and_register_is_bounced`(US1): 대기 항목 `pool_exclude("w1","bye") == true` → `pool_register_idle("w1",..)`가 `Tombstoned{reason:"bye"}`, 풀에 `w1` 없음 → 두 번째 `pool_register_idle`은 `Registered`.
  - `exclude_live_entry_leaves_no_tombstone`: 수신기가 살아 있는 항목 「제외」 → 그다음 등록 `Registered`.
  - `exclude_closed_sender_leaves_tombstone`: 수신기를 drop한(`is_closed`) 비대기 항목 「제외」 → 다음 등록 `Tombstoned`.
  - `tombstone_expires_after_stale`: 묘비 → `pool_heartbeat_tick(now + 31s, 30s)` → 등록 `Registered`.
  - 순서 두 갈래를 순차 테스트로(current-thread `join!`은 늘 같은 순서라 경쟁을 못 만든다 — 원자성은 같은 락 구간이라는 구조가 보장): `exclude_before_register_bounces`(대기 항목 「제외」 → 등록 `Tombstoned`, 풀에 없음) · `register_before_exclude_delivers_disconnect`(대기 항목에 먼저 `pool_register_idle`(수신기 살아 있음) → 「제외」 → 그 수신기가 `Disconnect{reason}`을 받고 묘비 없음 — 다음 등록 `Registered`).
  - `double_exclude_awaiting_second_is_not_found`(Review Focus 4): 둘째 `false`, 묘비 1개.
  - `tombstoned_register_gets_disconnect_and_stream_ends`(gRPC): 풀 모드·토큰 `t`인 tonic 서버, 대기 항목을 만들고 「제외」 → 같은 ID로 raw Register(토큰 `t`) — **요청 송신 `tx`를 테스트 끝까지 쥔 채**(놓으면 inbound가 끝나 핸들러가 어차피 빠져나가 `break` 검증이 공허해진다) → 첫 메시지 `Disconnect{reason}` → `timeout(2s, stream.message())`가 `Ok(Ok(None))`, 풀에 항목 없음.
  - `wrong_token_register_does_not_consume_tombstone`(gRPC): 묘비 → 토큰 `x`로 Register → Abort(인증 실패) → 묘비 여전히 있음(올바른 토큰 Register가 `Disconnect`를 받는다).

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --features in-process tombstone exclude_awaiting exclude_live exclude_closed exclude_before_register register_before_exclude double_exclude wrong_token_register` → 컴파일 오류/FAIL.

- [ ] **Step 3: 구현** — Interfaces대로. Task 1·5 테스트의 `let g = pool_register_idle(..)`(→ `u64`) 줄은 `IdleRegister::Registered { generation }` 매칭으로 고친다(작은 테스트 도우미 `fn gen_of(r: IdleRegister) -> u64` 권장). 먼저 `PoolState`로 바꾸고 `.entries` 기계 치환(테스트 포함) → 빌드 green 확인 → 묘비 로직. 묘비 확인은 핸들러의 `check_token`(`:1461`)·풀 모드 검사(`:1473-1483`) 뒤 `pool_register_idle` 호출 자리(`:1490`)에서만 일어난다(함수 안이므로 자동).

- [ ] **Step 4: 통과 확인** — 전체 `cargo nextest run -p handicap-controller --features in-process` PASS.

- [ ] **Step 5: 되돌려 확인** — (a) `pool_exclude`의 묘비 삽입을 지워 US1 테스트 RED (b) 「전달 불가일 때만」 조건을 늘 참으로 바꿔 `exclude_live_entry_leaves_no_tombstone` RED (c) 소비(삭제)를 지워 두 번째 등록 단언 RED (d) 핸들러 `break`를 `continue`로 바꿔 gRPC 테스트의 스트림 종료 단언 RED → 원복 → GREEN.

- [ ] **Step 6: 커밋** — `fix(controller): 전할 수 없는 「제외」는 묘비로 — 재등록하는 부하기를 돌려보낸다`

---

### Task 7: 실제 부하기 e2e — run 뒤 즉시 재등록·연달아 run (spec US2)

**Files:**
- Modify (test only): `crates/controller/tests/pool_control_across_runs_test.rs` (기존 도우미 `start_pool`·`spawn_ephemeral_worker`·`create_scenario`·`start_run`·`run_status`·`worker`·`wait_busy`·`post_run` 재사용)

**Interfaces:**
- Consumes: Task 1–3의 동작(프로덕션 변경 없음)

- [ ] **Step 1: 테스트 작성** — `#[tokio::test(flavor = "multi_thread", worker_threads = 4)]`
  - `worker_reregisters_promptly_after_run`: 부하기 1대, 1초 run → `wait_busy` → 20ms 간격으로 `run_status == "completed"`를 처음 본 시각 `t0` → 같은 간격으로 `worker(..)["busy"] == false`를 본 시각 `t1` → `assert!(t1 - t0 < Duration::from_millis(1000))`(옛 동작 약 2초).
  - `back_to_back_run_gets_the_worker`: `run_status == "completed"`를 처음 본 **즉시** `post_run`, 400이면 50ms 간격으로 재시도하되 **총 500ms 안에** `is_success()`여야 한다(옛 동작은 재등록까지 약 2초라 500ms 안엔 늘 400) → `wait_busy`로 그 부하기가 새 run에 잡힘.

- [ ] **Step 2: 실행** — `cargo nextest run -p handicap-controller --features in-process --test pool_control_across_runs_test` PASS(**`--features` 없이 돌리면 0개 실행으로 공허 통과** — 출력의 실행 테스트 수를 보고서에 적는다).

- [ ] **Step 3: 되돌려 확인** — `coordinator.rs`에서 Task 1의 `pool_stream_closed` 안 `e.tx = None`(대기 항목 송신 해제)을 임시로 지워 `worker_reregisters_promptly_after_run` RED(약 2초 — 부하기 1대 run은 run 항목 제거로 `WorkerEntry.tx`가 이미 놓이므로 남는 복사본은 풀 항목 것) ; 같은 회귀로 `back_to_back_run_gets_the_worker`도 RED → 원복 → GREEN. (프로덕션 임시 편집은 커밋 전 `git diff --stat`으로 원복 확인.)

- [ ] **Step 4: 커밋** — `test(controller): 풀 부하기가 run 뒤 곧바로 다시 등록하는지 e2e`

---

### Task 8: 낡은 주석·함정 노트 (spec R8)

**Files:**
- Modify: `crates/worker/src/lib.rs:417-429`(주석만), `crates/worker-core/CLAUDE.md`(`inbound_fwd` 불릿 — `grep -n "inbound_fwd" crates/worker-core/CLAUDE.md`), `crates/controller/CLAUDE.md`(`grep -n "terminal\|same_channel\|pool_stream_closed" crates/controller/CLAUDE.md`로 찾은 서술)

- [ ] **Step 1: 고칠 곳 전수 확인** — `grep -rn "same_channel\|terminal\|dead .tx\|§B66\|inbound_fwd\|worker_finished_part" crates/controller/src/grpc/coordinator.rs crates/worker/src/lib.rs crates/controller/CLAUDE.md crates/worker-core/CLAUDE.md`(`terminal`은 run 상태 일반어도 섞이니 run 조정 항목의 `terminal` 플래그·「이미 terminal run」 서술만 고친다 — `crates/controller/CLAUDE.md:88-89` 포함) 결과를 보고서에 붙이고, Task 1–6이 이미 고친 것 외 남은 줄을 바뀐 사실로 고친다: 컨트롤러가 run 최종화·재등록 대기 때 송신을 놓으므로 워커 대기는 곧 끝나고 2초는 상한 · 풀 항목 식별은 등록 세대 · 재등록 대기 항목은 송신 없음·10초 기한·전달 불가 「제외」는 묘비.
- [ ] **Step 2: 확인** — 같은 grep 재실행, 남은 매치가 모두 참인 서술인지 보고서에 한 줄씩.
- [ ] **Step 3: 커밋** — `docs: run 항목 정리·등록 세대·묘비에 맞춰 주석과 함정 노트 갱신` (워커 `.rs` 주석-only라 nextest skip 경로)

---

## 라이브 검증 메모 (`/live-verify` 단계 — 구현 task 아님)

spec §5 표 그대로. 확정 사항:
- US4 실패 run 시나리오: URL `"{{missing_var}}/"`(정의 안 된 변수 → 모든 VU `UnknownVar` → 워커 `Failed`, 근거 `crates/engine/tests/all_vus_failed.rs`). 컨트롤러가 이 시나리오 저장을 거절하면 그 사실과 대체 방법을 build-log에 적는다.
- US2 baseline은 master 바이너리(메인 체크아웃 `target/debug`가 아닌, master에서 따로 빌드한 것)로.
