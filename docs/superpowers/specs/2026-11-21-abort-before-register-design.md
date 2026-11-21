# 만들자마자 중단한 run의 부하가 끝까지 나가는 버그 (abort-before-register)

- 날짜: 2026-11-21 · 유형: `correctness-bug`
- 상태: 구현 완료(2026-11-21, 코드 `c75088b2`..`a24b459e`) — 라이브 US1–US4 통과, K8s 모드는 못 봄. 연기·판단 = roadmap §B79
- 출처: roadmap §B77 (2) 선재 버그 첫 항목(print-compare-report 라이브 검증 중 1회 재현)
- 사용자 결정(2026-11-21): 접근 B(등록할 때 막기 + 중단 즉시 정리), US 4개

## 사용자 스토리 (US)

버그 슬라이스라 `재현 / 기대 / 실측` 형식이다.

- **US1 — 만들자마자 중단해도 부하가 멈춘다** (QA)
  - 재현: run을 만들고 부하기가 접속하기 전에 중단한다(중단 버튼 = `POST /api/runs/{id}/abort`, 데스크톱 앱 종료, 모드 전환).
  - 기대: 대상 시스템에 요청이 한 건도 가지 않는다. 뒤늦게 접속한 부하기는 배정을 받지 못하고 바로 끝난다. 이 PC 부하기(subprocess)에서 재현되는 버그다. LAN 풀은 run 생성 요청 안에서 배정까지 끝나므로 버튼으로는 「접속 전 중단」이 생기지 않는다 — 풀은 회귀 확인 대상이다(§6).
  - 실측(§B77 (2)): 8 VU · 30초 run을 생성 0초 뒤 중단 → 상태 `aborted`·`started_at` null인데 리포트 요청 18,967건.
- **US2 — 늦게 붙은 부하기와 준비 중인 부하기도 멈춘다** (QA)
  - 재현: 부하기 2대짜리 run에서 한 대만 접속한 시점에 중단한다. 또는 부하기가 접속은 했지만 배정·데이터셋을 받는 중에 중단한다.
  - 기대: 접속해 있던 부하기는 바로 멈추고, 뒤늦게 접속한 부하기는 배정을 받지 못한다. 중단을 받은 부하기가 다시 접속해 배정을 받는 일이 없다.
  - 실측: 코드상 등록 처리가 중단 표시를 보지 않는다(§1). 라이브 실측 전.
- **US3 — 시작 전에 중단된 run임을 화면에서 알 수 있다** (QA)
  - 재현: 부하기가 한 대도 접속하기 전에 중단 버튼으로 중단한 run의 상세 화면을 연다.
  - 기대: 「중단 사유: 부하를 시작하기 전에 중단했습니다」가 보인다. 리포트의 요청 수는 실제 값(0건)이다. 부하기가 일부만 접속한 상태에서 중단한 run에는 「부하기 N대 중 M대만 접속한 상태에서 중단했습니다」가 보인다. 인쇄 보고서 요약에 같은 뜻의 문장이 두 번 나오지 않는다.
  - 실측: 사용자 중단은 사유를 남기지 않아 다른 중단 run과 구분되지 않는다.
- **US4 — 시작하지 못한 run의 리포트가 거짓 숫자를 내지 않는다** (QA)
  - 재현: `started_at`이 null인 run의 `/api/runs/{id}/report`를 연다.
  - 기대: 요청이 없으면 `duration_seconds` 0, `rps` 0. 요청이 있으면(이 버그로 생긴 옛 run 등) 측정된 초 구간으로 계산한 값이다(§3.5).
  - 실측: `duration_seconds` 1,795,221,083, `rps` ≈ 1e-05.

> US 초안 대비 변경(사용자에게 고지): US1의 풀 부하기를 「같은 결과」에서 「회귀 확인」으로 고침(풀은 생성 요청 안에서 배정이 끝난다). US4에 「요청이 있는 run」의 기대값을 더함(0초·0으로 두면 요청 18,967건에 초당 0건이라는 또 다른 거짓 숫자가 된다).

## 1. 원인 (코드 확인)

줄번호는 base `24e16e3d` 기준, `grep -n`으로 확인했다.

1. `api/runs.rs` `abort_run`(1387–1406): `state.coord.abort(&id)` → `runs::mark_aborted`. `CoordinatorState::abort`(`grpc/coordinator.rs` 1569–1590)는 `abort_requested`·`external_abort`를 세우고 **이미 등록한** 워커의 송신자에만 `AbortRun`을 보낸다. 등록한 워커가 없으면 아무에게도 보내지 않는다.
2. `CoordinatorState::register`(1061–1105)는 `abort_requested`·`external_abort`를 읽지 않는다. 중단 뒤 등록한 워커는 `Assigned`를 받고, 이미 구성원인 워커가 다시 등록하면 `Resend`로 같은 배정을 다시 받는다.
3. 워커 쪽 `retry_with_backoff`(`worker-core/src/reconnect.rs` 87–)는 **모든** 오류를 60초(`TOTAL_CAP`)까지 재시도한다. 배정 전에 `AbortRun`을 받은 경우(`WorkerError::AbortedBeforeAssignment`, `client.rs` 287)도 1초 뒤 다시 접속한다. 보통은 그 사이에 컨트롤러가 스트림 닫힘을 보고 run을 지우므로(`worker_disconnected`, 1456–1463) 재접속은 `NoRun`을 만나고, 워커는 부하 없이 60초 동안 재시도하다 끝난다. 재접속이 그 정리보다 먼저 닿으면 2의 `Resend`로 배정을 받는다(`Resend`는 새 송신자로 바꾸지도 않아 이후 중단이 죽은 송신자로 간다) — 드물지만 열려 있는 경로다. US1의 부하는 1–2(워커 0대에서 중단 → 뒤에 `Assigned`)에서 나온다.
4. 등록한 워커가 없는 run은 60초 등록 기한(`fail_incomplete_registration`, 1508–)까지 `runs` 맵에 남는다. subprocess 디스패처의 `cleanup`은 아무 일도 하지 않는다(`dispatcher/subprocess.rs` 103–107, 워커가 스스로 끝나는 구조). K8s 디스패처의 `cleanup`은 Job을 지운다.
5. 등록 처리의 `NoRun` 가지(1982–1985)는 `AbortRun` 없이 스트림만 닫는다 → 워커는 `NoAssignment`로 60초 재시도한다.
6. `runs::set_status`의 SQL은 `WHERE … status != 'aborted'`라 중단된 run의 `started_at`은 null로 남는다. `report.rs` 762–766은 `ended_at.unwrap_or(0).saturating_sub(started_at.unwrap_or(0))`(둘 다 `i64`)이라 `started_at` null이면 기간이 `ended_at`(1970년부터의 ms) 그대로다. `i64::saturating_sub`는 0에서 멈추지 않으므로, `ended_at`이 null인 실행 중 run은 지금 **음수** `duration_seconds`를 낸다(`rps`만 `duration_ms > 0` 가드로 0).
7. 상세 화면은 `aborted`이고 `message`가 있으면 「중단 사유」를 이미 보여 준다(`ui/src/pages/RunDetailPage.tsx` 324–326). 사용자 중단(`mark_aborted`)은 `message`를 쓰지 않는다. 데스크톱 종료·모드 전환(`in_process.rs` `abort_active_runs`)은 `mark_aborted_if_active`로 사유(「앱 종료로 중단」·「모드 전환으로 중단」)를 먼저 남긴 뒤, 행이 바뀐 run에만 `coord.abort`를 부른다. `abort_all`(`in_process.rs` 172–182, `RunningController::shutdown`·TUI 종료가 쓴다)은 DB를 쓰지 않고 `coord.abort`만 부른다 — 그 run은 다음 시작 때 `mark_orphans_failed`가 정리한다.
8. `mark_aborted`(`store/runs.rs` 468–478)는 상태 가드가 없는 `UPDATE … WHERE id = ?`이고 `auto_stop_json`도 지운다. `abort_run`의 상태 확인(`runs::get`)과 이 UPDATE 사이에 run이 끝나면 `completed`가 `aborted`로 덮인다(지금도 있는 틈).
9. run 생성(`spawn_run`)은 `runs::insert`(`api/runs.rs` 744) 뒤에 `enqueue`(899·962·986 세 갈래)를 부른다. 그 사이에 중단이 오면 DB만 `aborted`가 되고 코디네이터에는 run이 없어(`abort` → 없음) 중단 표시가 남지 않는다. 그 뒤 `enqueue`·디스패치·배정이 그대로 진행돼 부하가 전부 나간다 — 같은 버그의 더 좁은 틈이다. 스케줄러가 발사한 run(목록에 보인다)과 `abort_active_runs`가 이 틈에 닿을 수 있다.

## 2. 목표 / 비목표

**목표**
- 외부 중단(`abort()` — 버튼·앱 종료·모드 전환) 뒤에는 어떤 워커도 그 run의 배정을 받지 못한다(새 등록·재등록 모두).
- 등록한 워커가 없는 run은 중단 시점에 코디네이터에서 정리된다(맵에서 제거·감시 종료·디스패처 `cleanup`).
- 배정을 못 받고 중단을 받은 run 전용 워커는 재시도 없이 곧바로 끝난다.
- run 생성 도중(`insert`와 `enqueue` 사이)에 온 중단도 부하를 내지 않는다(§3.6).
- 시작 전에 중단한 run에 사유가 남는다(US3). `started_at` 없는 run의 리포트 기간·초당 요청 수가 거짓 숫자가 아니다(US4).
- 중단 API는 이미 끝난 run을 덮어쓰지 않는다(§3.4).

**비목표**
- 계단 자동 정지(`auto_stop`) 뒤에 늦게 등록하는 워커. 자동 정지는 측정이 몇 초 이상 쌓인 뒤에만 일어나므로 전원 등록 전에 일어나기 어렵고, 막으려면 자동 정지 run의 최종화 조건(`workers.len() == expected`)을 함께 바꿔야 한다. roadmap §B에 연기로 남긴다(§8).
- 프로토콜(proto) 변경. 기존 `AbortRun` 메시지만 쓴다.
- subprocess 디스패처가 자식 프로세스를 직접 죽이는 기능. 워커가 접속하는 순간 끊고 끝내는 것으로 충분하다(§3.3).
- 풀 워커(run_id 없이 유휴 등록)의 재접속 규칙. 손대지 않는다.
- 부하기 전원이 접속한 뒤(평소의 실행 중)에 버튼으로 중단했을 때의 사유. 지금처럼 사유 없이 둔다.

**안티목표**
- 정상 run의 등록·배정·완료 경로가 달라지는 것. 중단 표시가 없는 run에서는 메시지 순서와 내용이 그대로여야 한다.
- 이미 끝난 run(`completed`/`failed`)의 상태·사유를 덮어쓰는 것.

## 3. 설계

### 3.1 등록할 때 막기 (컨트롤러)

`register`가 run을 찾은 직후, 구성원 확인(`Resend`)보다 **먼저** `rw.external_abort`를 본다. 서 있으면 새 결과 `RegisterOutcome::Aborted`를 돌려준다. 상태는 바꾸지 않는다(구성원 추가·`next_shard` 증가 없음).

등록 처리(스트림 핸들러)의 `Aborted` 가지는 `Reject` 가지와 같은 모양으로 `AbortRun { reason: "run aborted before assignment" }`를 보내고 스트림을 끝낸다.

`NoRun` 가지도 스트림을 닫기 전에 `AbortRun { reason: "run is not active" }`를 보낸다. 3.2에서 run을 지운 뒤 접속하는 워커가 이 가지로 오고, 3.3과 합쳐 그 워커가 곧바로 끝난다.

`assign_pool_workers`(풀 배정, 438–463)는 `register` 결과를 직접 받는다. `Aborted`는 `NoRun`·`Reject`와 같은 「구성원이 아니다」 가지다(예약 해제 + `PoolAssignFailed`). 그 가지는 지금 `_ =>`라 컴파일러가 새 결과를 알려 주지 않는다 — `NoRun | Reject | Aborted`로 이름을 적어 다음 결과가 추가될 때 컴파일 오류가 나게 한다. 스트림 핸들러의 `match`(1955–1986)는 이미 exhaustive다.

`abort_requested`가 아니라 `external_abort`를 보는 이유: `auto_stop`은 `abort_requested`만 세우고, 자동 정지 run은 이번 범위 밖이다(§2 비목표).

### 3.2 중단 즉시 정리 (컨트롤러)

`abort()`의 반환을 `bool`에서 결과 enum으로 바꾼다.

```rust
pub enum AbortOutcome {
    /// 코디네이터에 그 run이 없다(이미 끝났거나 enqueue 전).
    NoRun,
    /// 등록한 워커가 없었다 — run을 정리했다. 부하는 나가지 않았다.
    NotStarted,
    /// 등록한 워커가 있다 — 표시를 세우고, 아직 끝 phase를 보고하지 않은 워커에
    /// Abort를 보냈다(지금 동작). 보낼 워커가 없었을 수도 있다.
    /// `registered` = 그때까지 등록한 워커 수, `expected` = 이 run의 워커 수.
    Marked { registered: u32, expected: u32 },
}
```

`rw.workers`가 비어 있으면 같은 잠금 블록에서 run을 맵에서 지우고 `done`을 취소한다(감시 종료 — `fail_run_hung`과 같은 순서). 잠금을 푼 뒤 `cleanup_dispatcher`를 부른다. 「워커가 비었다 = 한 대도 등록한 적이 없다」는 성립한다: 구성원이 빠지는 경로는 끝 phase 없이 끊긴 경우뿐이고, 그때는 fail-fast가 run을 통째로 지운다.

`workers`가 비어 있지 않으면 지금 동작 그대로다(표시 → 송신자 복사 → 잠금 밖 송신). 일부만 등록한 run(US2)은 등록한 워커의 `Aborted` 보고가 `record_phase`의 기존 가지로 run을 최종화하고, 그 사이·그 뒤에 접속하는 워커는 3.1의 `Aborted`·`NoRun` 가지가 막는다.

`NotStarted`의 `cleanup_dispatcher`는 중단 요청 안에서 기다린다(K8s에서는 Job 삭제 호출 한 번). 지금 `abort()` 머리 주석(1559–1568)과 `crates/controller/CLAUDE.md`의 A3c 노트는 「`abort()` 자체엔 cleanup을 넣지 않는다」고 적고 있다 — 그 근거(워커가 아직 정리 중일 때의 조기·중복 정리)는 등록한 워커가 있을 때만 해당하므로, 두 곳을 「등록한 워커가 없을 때만 `abort()`가 정리한다」로 고친다.

남는 것(§8에 기록): 등록한 워커가 전부 이미 끝 phase를 보고했고 나머지가 아직 등록하지 않은 run(예: 2대 중 w0 완료, w1 미등록)에서 중단하면 보낼 송신자가 없다. 늦은 w1은 3.1로 막히지만 run 항목은 60초 등록 기한까지 맵에 남는다(부하 없음, DB는 `aborted`).

기존 호출부 셋(`api/runs.rs` 1403, `in_process.rs` 179·233)은 반환값을 버리고 있어서 `abort_run`만 결과를 쓴다(3.4). `abort_all`은 DB를 쓰지 않으므로 `NotStarted`로 정리된 run의 행은 지금처럼 `pending`으로 남았다가 다음 시작 때 정리된다(DB 결과는 지금과 같다). 단위 테스트의 `assert!(coord.abort(..).await)`(4662·4776·4928·5737·6497·6790)는 전부 등록한 워커가 있는 경우라 `Marked` 단언으로 바꾼다.

풀 모드에서 `enqueue`와 `assign_pool_workers` 사이에 중단이 끼면(앱 종료가 활성 run 전체를 중단할 때, 또는 스케줄러가 발사한 run을 목록에서 중단할 때) run이 지워지고 배정은 `NoRun`으로 실패한다. 이 경우의 응답은 §3.6에서 정한다.

### 3.3 워커: 배정 전 중단을 받으면 재시도하지 않는다

run 전용 워커(`--run-id`가 있는 `run`, `worker/src/lib.rs` 357)는 접속 시도가 `WorkerError::AbortedBeforeAssignment`로 끝나면 재시도 없이 그 오류로 끝난다(종료 코드는 지금의 「60초 뒤 포기」와 같은 비정상 종료).

run 전용 워커가 배정 전에 `AbortRun`을 받는 경우는 전부 「그 run이 이미 끝났거나 끝나는 중」이다: 토큰 거절, 초과 등록(`Reject`), 3.1의 둘, 그리고 이미 등록한 워커에게 배정보다 먼저 닿은 중단들(`abort()`의 사용자 중단, 형제 워커 실패·끊김의 fail-fast, 디스패치 실패, `fail_run_hung`). 어느 것도 다시 접속해서 풀리지 않는다.

풀 워커는 바꾸지 않는다. 주의: CLI 풀 루프 `run_pool_until`(`worker/src/lib.rs` 407)은 run 전용 `run`(357)과 **같은** `connect_with_backoff`를 쓴다. 그래서 `retry_with_backoff`·`connect_with_backoff` 안을 고치면 풀 루프의 재시도까지 바뀐다. 데스크톱 풀 루프 `run_pool_desktop`만 이 오류를 따로 분류한다(`pool_status::classify`, 627).

구현 위치는 계획에서 정한다. 조건은 둘이다: ① 풀 경로 둘(`run_pool_until`·`run_pool_desktop`)의 재시도 동작이 바뀌지 않는다 ② 재시도 여부 판단이 한 곳에 있다.

subprocess 워커가 비정상 종료하면 reaper가 `mark_failed_if_active`를 부르지만, 가드 UPDATE라 이미 `aborted`인 행은 바뀌지 않는다(§3.4의 순서가 이를 보장한다). 부수 효과: subprocess 모드에서 배정 전에 거절된 워커(초과 등록 등)의 run은 60초 뒤가 아니라 곧바로 reaper의 일반 사유(「worker process exited before completing …」)로 `failed`가 된다. K8s에는 reaper가 없어 그 경우의 run 상태 전이는 지금처럼 60초 기한을 따른다(워커 Pod만 일찍 끝난다).

### 3.4 중단 API의 순서와 사유 (US3)

`abort_run`을 **DB 먼저, 가드 UPDATE**로 바꾼다.

1. 활성(`pending`/`running`) 행만 `aborted`로 바꾸는 가드 UPDATE(사유 없음). **새 store 함수**로 만들고 행이 바뀌었는지를 돌려준다. 기존 `mark_aborted`(가드 없음)는 고치지 않는다 — `abort_run`이 유일한 운영 호출부라 이 변경 뒤에는 테스트 픽스처만 쓰고, 그중 둘(`tests/api_test.rs` 1113, `store/runs.rs` 1315)은 끝난 행을 `aborted`로 덮는 동작에 기대고 있다. 가드 UPDATE가 **맨 먼저**다(지금의 `runs::get` 선확인은 없앤다 — 조회 한 번이 줄고, 끝난 run 보호가 가드 UPDATE 하나에 달려 테스트로 잠글 수 있다). 바뀐 행이 없을 때만 행을 읽는다: 없으면 404, 있으면 그 상태로 409(「run is {상태} and cannot be aborted」 — 지금과 같은 문구).
2. 행이 바뀌었으면 `coord.abort`.
3. 결과에 따라 사유를 쓴다: `NotStarted` → 「부하를 시작하기 전에 중단했습니다」, `Marked`이고 `registered < expected` → 「부하기 N대 중 M대만 접속한 상태에서 중단했습니다」, 그 밖(`Marked` 전원 등록, `NoRun`) → 쓰지 않는다.

`in_process.rs` `abort_active_runs`가 이미 이 순서(가드 UPDATE → 바뀐 행만 `coord.abort`)다.

이유 둘. ① 3.3으로 워커가 곧바로 끝나면, 코디네이터 중단과 DB 기록 사이에 reaper·`worker_disconnected`의 `mark_failed_if_active`가 끼어 `failed` + 「worker … disconnected」 사유를 먼저 쓸 수 있다. DB를 먼저 `aborted`로 바꾸면 그 가드 UPDATE들이 전부 no-op이다. ② 가드가 없으면 §1의 8(끝난 run 덮어쓰기)이 남는다.

코디네이터 중단이 DB보다 먼저여야 하는 경로는 없다: `record_phase`의 `Aborted`·`Completed` 가지는 가드된 `set_status`(`status != 'aborted'`)와 `complete_with_auto_stop`(`IN ('pending','running')`)을 쓰므로 no-op이 될 뿐이다.

DB 먼저 순서가 여는 틈 하나: 1과 2 사이에 워커가 등록하면 `Assigned`를 받고(`external_abort`가 아직 안 섰다), 2의 `Marked`가 곧바로 그 워커에 중단을 보낸다. 그 사이 요청 몇 건이 나갈 수 있고 `started_at`은 null이다(`set_status` 가드). 이 run은 「시작 전 중단」 사유를 받지 않고(`NotStarted`가 아니다), 리포트는 §3.5의 측정 구간 계산을 탄다.

사유 쓰기는 새 store 함수 하나다: `status = 'aborted' AND message IS NULL`인 행에만 `message`를 쓴다(다른 경로가 먼저 남긴 사유를 덮지 않는다). 문구는 Rust 상수 `ABORT_MSG_NOT_STARTED = "부하를 시작하기 전에 중단했습니다"`이고 `store/runs.rs`에 둔다(`in_process.rs`는 `in-process` 기능 뒤에 있어 항상 컴파일되는 `api/runs.rs`가 쓸 수 없다). 컨트롤러가 한글 사유를 `message`에 직접 쓰는 것은 `in_process.rs`의 `ABORT_MSG_*`·`api/runs.rs`의 `POOL_ASSIGN_FAILED_MSG`와 같은 방식이다.

`NotStarted`일 때만 쓰는 이유: 그때만 「요청 0건」이 보장된다. 일부 워커가 등록한 뒤의 중단은 요청이 몇 건 나갔을 수 있으므로 「시작 전」이라고 쓰지 않는다. `started_at IS NULL`로 판정하지 않는 이유도 같다 — 배정을 보낸 뒤 `Running` 기록 전 사이에 중단이 오면 `started_at`은 null이지만 워커는 이미 배정을 받았다.

데스크톱 종료·모드 전환은 자기 사유를 먼저 남기므로 그대로다.

**일부만 접속한 상태의 중단**(사용자 지시 2026-11-21: "사용자한테 알려주기라도 해야"): 결과가 `Marked`이고 `registered < expected`면 같은 사유 쓰기 함수로 「부하기 {expected}대 중 {registered}대만 접속한 상태에서 중단했습니다」를 남긴다(문구를 만드는 함수는 `store/runs.rs`, 상수 옆). 요청이 나갔는지는 적지 않는다 — 실제 요청 수는 리포트가 보여 준다. 전원이 등록한 뒤의 중단(평소의 실행 중 중단)은 지금처럼 사유가 없다.

상세 화면은 바꾸지 않는다. `RunDetailPage`가 이미 `message`를 「중단 사유」로 보여 준다. 인쇄 보고서도 `message`를 「사유: …」로 싣는다(`ui/src/print/sentences.ts` 41) — 새 문구 둘은 사용자 입력이 섞이지 않는 문장(고정 문장, 숫자 둘)이라 그 경로의 전제(값 없는 컨트롤러 문구)에 맞는다.

### 3.4b 인쇄 요약의 같은 말 반복 (UI)

요청 0건·시작 전 중단 run의 인쇄 요약은 지금 구조로는 「요청이 하나도 실행되지 않았습니다. 사유: 부하를 시작하기 전에 중단했습니다」 다음 줄에 「측정이 시작되기 전에 중단되었습니다.」가 이어진다(`sentences.ts` `specialLines` 41–46). 사용자 지시(2026-11-21: "간단하면 같이")로 함께 고친다.

규칙: `aborted`이고 시작 시각이 없을 때, **요청 0건 줄에 사유가 붙었으면** 「측정이 시작되기 전에 중단되었습니다.」 줄을 내지 않는다(사유가 이미 왜 0건인지 말한다 — 「앱 종료로 중단」·「모드 전환으로 중단」도 같다). 요청 0건이고 사유가 없으면 지금 그대로 그 줄을 낸다.

같은 자리의 틀린 문장 하나도 고친다: 시작 시각이 없는데 **요청이 1건 이상**인 중단 run(이 버그로 생긴 옛 run, §3.4의 틈)은 지금 「측정이 시작되기 전에 중단되었습니다.」가 찍힌다 — 요청이 있으므로 거짓이다. 그런 run은 경과 시간 없는 문장 「측정이 도중에 중단되었습니다.」(`abortedNoElapsed`)를 낸다.

요청이 있는 중단 run의 인쇄 요약에는 `message`가 실리지 않는다(지금 구조 — 요청 0건 줄에만 사유가 붙는다). 그래서 「N대 중 M대만…」 사유는 요청이 있으면 상세 화면에만 보인다. US3은 상세 화면을 약속하므로 그대로 두고 §8에 적는다.

손대는 곳은 `ui/src/print/sentences.ts`의 `specialLines`와 그 테스트뿐이다. 그 문장을 쓰는 곳은 이 한 군데다(`grep -rn abortedBeforeStart ui/src` — `sentences.ts` 45와 `ko.ts` 정의, 테스트 제외).

### 3.5 리포트 기간 (US4)

`build_report`의 기간 계산을 셋으로 나눈다.

| `started_at` | `ended_at` | 기간 |
|---|---|---|
| 있음 | 있음 | `ended_at − started_at`(음수면 0) — 지금과 같다 |
| 없음 | (무관) | 측정 창이 있으면 「첫 측정 초 ~ 마지막 측정 초」(`마지막 ts − 첫 ts + 1`초), 없으면 0 |
| 있음 | 없음(실행 중) | 0 — 지금은 음수가 나온다(§1의 6) |

`rps`는 지금처럼 기간(ms)이 0보다 클 때만 `총 요청 수 ÷ 기간`, 아니면 0이다.

둘째 행의 이유: `started_at` 없이 요청이 있는 run은 이 버그로 생긴 옛 run과 §3.4의 틈에서 나온다. 기간을 0으로 두면 「요청 18,967건, 초당 0건」이 되고 `insights.rs`의 `duration_seconds.max(1)`은 1초로 나눈 비율을 낸다. 측정 창의 초 구간은 실제로 부하가 나간 시간이다(`insights.rs` 337의 「run 시작초 정본 = 첫 data-second」와 같은 기준).

`ReportRun.started_at`은 지금처럼 null 그대로 내보낸다(값을 지어내지 않는다).

### 3.6 run 생성 도중의 중단

`spawn_run`의 세 `enqueue` 갈래 모두, `enqueue` 뒤·디스패치(풀이면 `assign_pool_workers`) 앞에서 그 run의 DB 상태를 다시 읽는다. `pending`이 아니면:

- 코디네이터 항목을 정리한다(기존 `cancel_dispatch_failed` — 항목 제거·감시 종료·`cleanup`). 풀 갈래는 예약도 푼다(기존 `release_pool_reservation`).
- 디스패치하지 않는다.
- `aborted`면 §3.4의 사유 쓰기 함수로 `ABORT_MSG_NOT_STARTED`를 남긴다(부하가 시작되지 않았다).
- 호출자에게는 정상 생성으로, **다시 읽은 행**을 돌려준다(응답이 이미 `aborted`인 run을 `pending`이라고 적지 않게).

순서별 결과(중단은 「DB 기록 → `coord.abort`」, 생성은 「`enqueue` → 다시 읽기 → 디스패치」):

| 순서 | 결과 |
|---|---|
| 중단의 DB 기록이 다시 읽기보다 먼저 | 다시 읽기가 `aborted`를 보고 정리, 디스패치 없음 |
| 다시 읽기가 먼저(`pending`을 봄), `coord.abort`는 `enqueue` 뒤 | 디스패치는 진행된다. `abort`가 항목을 찾는다 — 등록한 워커가 없으면 `NotStarted`로 정리하고 워커는 접속 때 `NoRun` → `AbortRun` → 종료, 그 사이 등록한 워커가 있으면 `Marked`(§3.4의 틈) |

둘째 순서에서 풀 갈래는 `assign_pool_workers`가 `NoRun`으로 실패해 `fail_pool_assignment`(`api/runs.rs` 1377–1385)에 온다. 지금 그대로면 500이고, 스케줄러가 발사한 run은 중단됐는데 「발사 실패」로 기록된다. 그래서 풀 배정 실패 처리에서 행을 다시 읽어 `aborted`면 오류 대신 그 행을 정상 생성으로 돌려준다(예약 해제·항목 정리는 지금대로 한다).

`abort_all`(종료 때 DB 기록 없이 `coord.abort`만 부른다)은 이 다시 읽기로 덮이지 않는다: `coord.abort`가 `enqueue`보다 먼저면 run은 그대로 진행된다. 이 경로는 컨트롤러가 곧 종료되는 때만 쓰이고, 컨트롤러가 죽으면 워커가 스트림 닫힘으로 스스로 취소한다(R4b) — 고치지 않고 §8에 적는다.

비용은 run 생성당 기본 키 조회 한 번이다.

## 4. 동작 표

| 중단 시점 | 코디네이터 | 워커 | DB |
|---|---|---|---|
| `insert` 뒤·`enqueue` 전 | `abort` → `NoRun`. 생성 쪽이 `enqueue` 뒤 다시 읽고 정리(§3.6) | 디스패치 안 됨 | `aborted` + 사유 「부하를 시작하기 전에…」 |
| 워커 0대 등록 | run 제거, `cleanup` | 접속 → `NoRun` → `AbortRun` → 곧바로 종료 | `aborted` + 사유 「부하를 시작하기 전에…」 |
| 일부 등록(배정 받음) | 표시, 등록한 워커에 `AbortRun` | 등록한 워커: 멈추고 `Aborted` 보고 → run 최종화. 늦은 워커: `Aborted`/`NoRun` 가지 → 종료 | `aborted` + 사유 「부하기 N대 중 M대만 접속한 상태에서…」 |
| 등록 직후·배정 송신 전 | 표시, `AbortRun`이 배정보다 먼저 큐에 | `AbortedBeforeAssignment` → 재시도 없이 종료 → 스트림 닫힘 → `worker_disconnected`가 run 정리 | `aborted`(DB 먼저라 `mark_failed_if_active` no-op) |
| DB 기록 뒤·코디네이터 중단 전에 등록(§3.4의 틈) | 등록은 `Assigned`, 이어지는 `abort`가 `Marked`로 중단 송신 | 요청 몇 건 뒤 멈추고 `Aborted` 보고 | `aborted`, 사유는 등록 수에 따라(전원이면 없음, 일부면 「N대 중 M대만…」), `started_at` null → 리포트는 측정 구간 계산 |
| 등록한 워커 전원이 끝 phase 보고, 나머지 미등록 | 표시만(보낼 송신자 없음). 늦은 워커는 `Aborted` 가지. 항목은 60초 기한에 정리 | 늦은 워커: 곧바로 종료 | `aborted` + 사유 「부하기 N대 중 M대만 접속한 상태에서…」 |
| 자동 정지 뒤 외부 중단, 일부 미등록 | 위와 같다(늦은 워커가 막혀 전원 등록 조건이 안 찬다 → 60초 기한에 정리) | 위와 같다 | 위와 같다 |
| 배정 뒤·데이터셋 받는 중 | 지금 동작 | 로딩 중 중단 처리(`worker/src/lib.rs` 195–) → `Aborted` 보고 | `aborted` |
| 실행 중 | 지금 동작 | 지금 동작 | 지금 동작 |

## 5. 테스트

재현 테스트를 먼저 쓰고 지금 코드에서 실패(RED)하는 것을 확인한 뒤 고친다. 회귀 가드는 고친 뒤 되돌려 확인한다.

**코디네이터 단위(`grpc/coordinator.rs` 인라인)**
- 워커 0대에서 `abort` → `NotStarted`, run이 맵에 없음, 이어지는 `register`는 `NoRun`.
- 2대 run에서 w0만 등록 → `abort` → `Marked`, w0 수신 큐에 `AbortRun`. 이어서 w1 `register` → `Aborted`(구성원 수·`next_shard` 그대로).
- 스트림 핸들러 수준: `Register`가 `NoRun`·`Aborted`를 만나면 그 스트림으로 §3.1의 사유가 든 `AbortRun`이 온다(`register()` 단위 테스트는 핸들러 가지를 덮지 못한다).
- w0 등록 → `abort` → w0 **재등록** → `Aborted`(`Resend` 아님).
- 중단 표시 없는 run의 `register`는 지금과 같은 `Assigned`/`Resend`/`Reject`.
- `auto_stop` 뒤 `register`는 지금 동작 그대로(비목표가 실수로 바뀌지 않았는지).
- `assign_pool_workers`: 중단된 run에 배정 시도 → 예약이 풀리고 `PoolAssignFailed`.

**워커(`worker-core`·`worker`)**
- run 전용 접속 경로: 첫 시도가 `AbortedBeforeAssignment`면 시도 횟수 1회로 끝난다. 다른 오류(`NoAssignment`·연결 실패)는 지금처럼 재시도한다.
- 풀 경로의 재시도 횟수는 그대로다.

**API·store**
- `abort_run`: 등록 0대 run → 응답 200, `status = aborted`, `message` = 상수. 2대 중 1대만 등록한 run → `message` = 「부하기 2대 중 1대만 접속한 상태에서 중단했습니다」. 전원 등록한 run → `message` null.
- 인쇄 요약(`ui/src/print/__tests__/`): 중단·시작 시각 없음·요청 0건·사유 있음 → 「측정이 시작되기 전에…」 줄 없음. 사유 없음 → 그 줄 있음(지금 그대로). 시작 시각 없음·요청 1건 이상 → 「측정이 도중에 중단되었습니다.」(「시작되기 전에」 아님). 시작 시각 있음 → 지금 그대로.
- 기존 테스트 하나가 바뀐다: `sentences.test.ts`의 「aborted before start」(405–408)는 요청 수를 정하지 않아 기본값 1,000건(`summary()` 52–54)이다 — 새 규칙의 「시작 시각 없음·요청 1건 이상」에 해당해 RED가 된다. 그 픽스처에 `summary({ count: 0 })`을 줘서 「요청 0건·사유 없음」을 계속 덮게 하고, 옛 픽스처(요청 있음)는 새 테스트가 맡는다. 코드를 되돌려 맞추지 않는다.
- `abort_run`: 상태 확인 뒤 끝난 run(가드 UPDATE가 0행) → 409, 행은 `completed` 그대로.
- 사유 쓰기 함수: `message`가 이미 있으면 덮지 않는다. `aborted`가 아니면 쓰지 않는다.
- 생성 도중 중단(§3.6): `enqueue` 뒤 다시 읽기가 `aborted`를 보면 디스패처가 불리지 않고, 코디네이터에 항목이 없고, 사유가 남고, 응답 본문의 상태가 `aborted`다. 풀 갈래는 예약이 풀린다.
- 풀 배정 실패 + 행이 `aborted` → 500이 아니라 정상 생성 응답. 행이 `aborted`가 아니면 지금처럼 500 + 「풀 워커 배정 실패…」.

**리포트**
- §3.5 표의 세 행 + 「`started_at` 없음·측정 창 없음」. 기존 픽스처(둘 다 있음)는 그대로.

**종단(`crates/controller/tests/e2e_test.rs` 방식, 실제 워커 바이너리)**
- 시험용 디스패처가 실제 워커 바이너리를 띄우되 **중단 요청이 끝난 뒤에** 띄우고 자식 핸들을 쥔다(지금 코드에서 RED가 띄우는 속도에 좌우되지 않게, 그리고 워커 종료를 직접 볼 수 있게 — `SubprocessDispatcher`는 자식 핸들을 내놓지 않는다).
- 단언: 자식이 몇 초 안에(60초 재시도 없이) 끝난다, 대상(wiremock)이 받은 요청 0건, `status = aborted`, 사유 = 상수.

## 6. 라이브 검증

run 생성·엔진 경로를 건드리므로 필수다(`/live-verify`, 워크트리 자체 바이너리).

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | subprocess 모드: `POST /api/runs` 직후 `POST …/abort`(§B77 (2)와 같은 8 VU · 30초). 10회 반복 | 응답기 요청 수 0, 워커 프로세스가 수 초 안에 사라짐(`pgrep -P <컨트롤러 PID>`), 컨트롤러 로그에 그 run의 60초 등록 기한 실패 없음 |
| 회귀(풀) | 풀 모드(`--worker-mode pool`, 워커 2대)에서 생성 직후 중단 — 풀은 생성 요청 안에서 배정이 끝나므로 재현이 아니라 회귀 확인 | 응답기 요청 수가 중단 뒤 늘지 않음, 풀 워커 2대가 `busy`로 남지 않음(`GET /api/pool/workers`), 다음 run에 다시 배정됨 |
| US2 | subprocess 2대(capacity를 낮춰 fan-out) run을 생성 뒤 0–300 ms 사이 여러 시점에 중단 | 중단 뒤 응답기 요청 수가 늘지 않음, run이 `aborted`로 끝남(`running` 정체·`failed` 없음) |
| US3 | US1의 run 상세 화면 | 「중단 사유: 부하를 시작하기 전에 중단했습니다」 보임. US2의 run 중 일부만 접속했던 것에는 「부하기 2대 중 1대만 접속한 상태에서 중단했습니다」. 실행 중 중단한 run에는 사유 없음. US1 run의 인쇄 보고서(`/runs/:id/print`) 요약에 같은 뜻의 문장이 한 번만 나옴 |
| US4 | US1의 run `/report` | `duration_seconds` 0, `rps` 0, 요청 0건 |
| 회귀 | 정상 run 1개(중단 없음) + 실행 중 중단 1개 | 완료·리포트 정상, 실행 중 중단은 지금처럼 수 초 안에 `aborted` |

K8s 모드는 이번 세션에 Docker가 꺼져 있어 kind 클러스터를 띄우지 못한다(사용자 확인 2026-11-21 — 나중에 따로 확인). 등록 처리는 모드와 무관하고 단위 테스트가 덮지만, Job `cleanup`이 중단 시점에 불리는 것은 실측하지 못한 것으로 build-log에 남긴다.

## 7. 제약

- 중단 표시는 잠금 안에서, 어떤 `AbortRun`도 보내기 전에 세운다(기존 불변식 `abort_flag_set_before_sends`). 3.2의 제거도 같은 잠금 블록 안이다.
- `cleanup_dispatcher`·DB 쓰기는 `runs` 잠금 밖에서.
- 주석은 사실(불변식·순서 제약)만 적는다. 이상한 동작을 설명하고 넘어가는 주석이 필요하면 코드를 고친다(working-rules §7).
- 정상 경로의 메시지 수·잠금 횟수를 늘리지 않는다(`register`의 추가 비용은 불리언 한 번 읽기).

## 8. roadmap §B에 남길 것 (마무리 때)

- **자동 정지 뒤 늦게 등록한 워커**: 이번에 막지 않았다. 비용 — 계단 자동 정지 뒤에 등록한 워커는 배정을 받아 자기 몫을 끝까지 돈다(전원 등록 전에 자동 정지가 일어나야 하므로 K8s처럼 Pod 기동이 느린 환경에서만 가능). 해소 — `register`가 `auto_stop.is_some()`도 막고, 자동 정지 최종화 조건이 「등록한 워커 전원」을 보도록 바꾼다.
- K8s 실측 공백(§6). 함께: §3.6 둘째 순서에서 `NotStarted` 정리(`cleanup`)가 디스패치의 Job 생성보다 먼저 돌 수 있다 — 그 Job은 Pod가 `NoRun`을 받고 끝난 뒤 TTL(600초)로 지워진다(부하 없음).
- **종료 때의 `abort_all`과 생성 도중 run**(§3.6 끝): 고치지 않았다. 비용 — 컨트롤러 종료 직전에 만들어지던 run이 디스패치될 수 있으나 컨트롤러가 죽으면 워커가 스스로 취소한다. 해소 — `abort_all`도 DB 기록을 먼저 하게 바꾼다.
- **요청이 있는 중단 run의 인쇄 요약에 사유가 없다**(§3.4b 끝): 「N대 중 M대만…」 사유가 상세 화면에만 보인다. 해소 — 인쇄 요약의 중단 줄에도 사유를 붙인다.
- **60초 동안 남는 코디네이터 항목**(§4의 두 행): 등록한 워커가 전부 끝 phase를 보고했고 나머지가 미등록인 run, 자동 정지 뒤 외부 중단된 일부 미등록 run. 비용 — 부하는 없고 DB도 맞지만 항목·K8s Job이 60초 기한까지 남는다. 해소 — `abort()`가 「살아 있는 송신자 0 ∧ 미등록 있음」도 즉시 정리.
- **DB 기록과 코디네이터 중단 사이에 등록한 워커**(§3.4의 틈): 요청 몇 건이 나갈 수 있다. 비용 — 수 ms 구간, 중단 직후 멈춘다. 해소 — 중단 표시를 DB 기록 전에 세우는 2단계 중단(표시 → DB → 송신·정리).
- **끝난 run에 verdict 배지**(선재): `persist_verdict` → `set_verdict`(`store/runs.rs` 558–566)에 상태 가드가 없어, 중단 API의 DB 기록과 코디네이터 중단 사이에 자연 완료가 끼면 `aborted` run에 verdict가 붙는다. 순서와 무관하게 지금도 있는 틈이다. 해소 — `set_verdict`에 `status = 'completed'` 가드.

## 9. 내가 정한 것 (사용자 확인 대상)

1. 중단 API를 「DB 먼저」 순서로 바꾸고, 이미 끝난 run은 덮어쓰지 않고 409를 돌려준다(§3.4) — 사유가 엉뚱한 문구로 남는 경합과 끝난 run 덮어쓰기를 없애려고.
2. 「시작 전 중단」 사유는 등록한 부하기가 **한 대도 없을 때만** 쓴다. 일부만 붙은 뒤의 중단에는 「부하기 N대 중 M대만 접속한 상태에서 중단했습니다」를 남긴다(사용자 지시 2026-11-21).
3. 사유 문구: 「부하를 시작하기 전에 중단했습니다」.
4. 자동 정지 뒤 늦게 붙는 부하기는 이번 범위 밖(§2·§8).
5. run 전용 부하기가 배정 전에 중단을 받으면 60초 재시도 없이 바로 끝난다(풀 부하기는 그대로).
6. 인쇄 보고서에서 요청 0건·시작 전 중단 run의 요약에 같은 뜻의 문장이 두 번 나오는 것을 함께 고친다(§3.4b, 사용자 지시 2026-11-21).
7. run을 만드는 도중에 온 중단도 막는다(§3.6) — 같은 버그의 더 좁은 틈이고, 비용은 생성당 DB 조회 한 번이다.
8. 시작 시각이 없는데 요청이 있는 run의 리포트 기간은 「측정된 초 구간」으로 계산한다(§3.5) — 0으로 두면 「요청 18,967건, 초당 0건」이라는 다른 거짓 숫자가 된다.
