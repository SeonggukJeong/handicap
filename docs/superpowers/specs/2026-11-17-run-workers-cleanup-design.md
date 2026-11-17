# 끝난 run 항목 정리 + 「제외」 틈 묘비 (run-workers-cleanup) — 설계

- 날짜: 2026-11-17
- 상태: **완료** (2026-11-17, 코드 `41198b75`..`c10ab48e`) — spec-plan-reviewer APPROVE (4라운드) · R9 편입 후 재검토 APPROVE · 최종 리뷰 READY-TO-MERGE · security APPROVE · 라이브 US1·US2·US4 통과(US3 가상 시계 테스트). 판단·연기 roadmap §B67
- 유형: correctness-bug (조용한 부하 이탈 — 「제외」했는데 부하기가 다시 들어와 부하를 받음 · run 직후 다음 run이 부하기를 덜 받음) + internal-polish (끝난 run 메모리)
- 출처: roadmap §B66 (3) 연기 3건 — ① `RunWorkers` 항목 미삭제 ② run 직후 틈의 「제외」 유실 ③ 재등록 대기 항목이 stale까지 「busy · 옛 run」. 사용자 결정(2026-11-17): ①②를 함께(§B66 원문 「같이」), ③도 같은 상태를 다루므로 이번 범위. spec 리뷰가 찾은 선재 버그(풀 배정 일부 실패 뒤 예약 워커가 「busy」로 굳음)도 사용자 결정(2026-11-17)으로 편입 — R9.
- 범위: **컨트롤러** (`crates/controller/src/grpc/coordinator.rs` 중심 + `api/runs.rs` 두 곳) + 낡은 주석·함정 노트(R8). proto·migration·UI·셸·워커 동작 무변경.

## 사용자 스토리 (US)

- **US1**: 운영자가 run이 막 끝난 직후 서버 「워커」 화면에서 부하기를 「제외」한다 — 성공하면 그 부하기가 다시 등록해 와도 풀에 들어가지 못하고 `Disconnect`를 받아 다음 run 부하를 받지 않으며, 부하기 쪽은 「제외됨」(데스크톱)·종료(CLI)로 멈춘다. (틈이 수 ms라 수동 재현 불가 → 가짜 워커 스트림 통합 테스트로 증명, R7.)
- **US2**: QA가 풀 부하기로 run을 연달아 돌린다 — 성공하면 run이 끝난 뒤 부하기가 곧바로 다시 등록해(컨트롤러 로그 `worker run status`(Completed) → `pool worker registered idle` 간격이 지금의 약 2초가 아니라 0.5초 미만), 앞 run이 끝나자마자 시작한 다음 run도 모든 부하기를 받는다(지금은 재등록 대기 중인 부하기가 예약에서 빠져 400 「연결된 LAN 워커가 없습니다」·용량 409 또는 부하기 수 감소). `GET /api/pool/workers`에서 `busy: false, run_id: null`.
- **US3**: 운영자의 부하기 PC가 run 직후 재등록 없이 사라진다 — 성공하면 서버 목록에서 그 부하기가 stale 시간(기본 30초)이 아니라 약 10초 뒤에 사라진다. (수정 뒤엔 재등록이 수 ms 안에 일어나 수동으로 그 틈에 끌 수 없음 → 가상 시계 테스트로 증명, R7.)
- **US4**: 운영자가 풀 부하기에 라벨·용량·「비우기」를 설정해 두고 run을 여러 번 돌린다(성공 run·실패 run·부하기 2대 run·사용자 중단 run) — 성공하면 설정이 그대로 남는다(09bb1914 동작 유지 — 회귀 가드).

US 정정(사용자 승인 뒤, spec 리뷰 반영 2026-11-17): 승인 초안 US5(「끝난 run 항목이 남지 않음을 테스트로 본다」)는 사용자가 관찰할 수 없는 R1 재진술이라 R1·R7 요구로 옮김. US2 측정 기준은 초안의 워커 로그 `worker done`이 2초 대기 **뒤**에 찍혀(`worker/src/lib.rs:429-430`) 지금 코드에서도 통과하므로 컨트롤러 로그 두 줄로 바꾸고, 지금 막히는 사용자 작업(연달아 시작한 run의 부하기 수)을 더함. US3는 라이브 절차가 수정 뒤 불가능해 테스트 증명으로.

## 1. 배경 — 지금 동작

(줄번호는 `grep -n`으로 확인 — §6 명령표.)

- **run 조정 표가 비지 않는다.** `enqueue`가 `runs` 맵에 `RunWorkers`를 넣고(`coordinator.rs:803`), 최종화 지점(`record_phase`의 Failed/Aborted/Completed, `worker_disconnected` fail-fast, `fail_run_hung`)은 `rw.terminal = true` + `rw.done.cancel()`만 한다(`:1013`·`:1023`·`:1049`·`:1148`·`:1187`). 맵에서 지우는 곳은 `cancel_dispatch_failed`의 `g.remove(run_id)`(`:1236`) 하나뿐이다. 그래서 끝난 run마다 `base`(시나리오 YAML·env·데이터 바인딩)와 워커별 송신 복사본(`WorkerEntry.tx`)이 컨트롤러 수명 내내 남는다.
- **워커의 2초 대기.** 워커는 마지막 `RunStatus`를 보낸 뒤 `drop(tx)`하고, 컨트롤러가 응답 쪽을 닫을 때까지 최대 2초 기다린다(`worker/src/lib.rs:417-429` — 같은 대기가 데이터셋 적재 중 중단·실패 경로 `:208`·`:226`에도 있다). 응답 스트림은 그 채널의 **모든** 송신 복사본이 놓여야 끝난다. 오래 사는 복사본은 셋이다: ① `RunWorkers.workers[*].tx` ② 풀 워커면 `PoolEntry.tx`(`pool_stream_closed`가 재등록 대기로 남길 때도 그대로 쥔다, `:577-600`) ③ 스트림 핸들러 태스크의 `tx`(inbound가 끝나고 close 처리 뒤 태스크와 함께 놓인다, `:1615-1627`). 나머지(예약→`assign_pool_workers` 반복, 하트비트 스냅숏, `fan_out_abort`/`abort()`)는 잠깐 쥐었다 놓는다. 그러므로 ①만 비워서는 풀 워커의 2초 대기가 안 없어진다.
- **연달아 시작한 run이 부하기를 덜 받는다.** 재등록 대기 항목은 `assigned_run`이 `Some`이라 예약 경로가 건너뛴다(`:316-318`·`:695-697`). 앞 run이 끝나고 약 2초 안에 다음 run을 만들면 그 부하기들이 빠진다.
- **풀 설정 유지가 run 항목에 기대고 있다.** `pool_stream_closed`는 「이 워커가 자기 몫을 끝냈나」를 `worker_finished_part`(`:604`, 호출부는 `:587` 하나)로 판정하는데, 이 함수는 `runs` 맵의 그 워커 `phase`·`self_aborted`를 읽는다. 마지막 워커는 보고 직후 스트림을 닫고, Failed run에서 fan-out을 받은 형제의 `Aborted`는 최종화 **뒤에** 온다(`record_phase`는 `rw.terminal`이어도 `e.phase`를 갱신한다, `:1001-1009`). 항목을 최종화 때 그냥 지우면 이 판정이 `false` → 항목 제거 → 라벨·용량·「비우기」 유실(09bb1914가 고친 버그의 재발).
- **「제외」 틈.** `pool_exclude`(`:666`)는 pool 락 안에서 항목을 지우고, 락을 놓은 뒤 실행 중이면 `worker_disconnected`를 부르고, 그 항목의 `tx`로 `Disconnect`를 `try_send`한다. 재등록 대기 직후 약 2초 동안은 ①②가 응답 쪽을 살려 두고 워커의 전달 태스크가 아직 읽으므로 `Disconnect`가 닿는다. 그 2초 상한이 지나 워커가 전달 태스크를 끝낸 뒤부터 재등록까지는 닿지 않는데 API는 200을 준다. 워커는 새 스트림으로 `Register`(빈 run_id)를 보내고 `pool_register_idle`(`:399`)이 새 항목을 넣는다 — 「제외」가 조용히 사라진다. **R4가 들어가면 재등록 대기 기간 전체가 전할 수 없는 구간이 되므로 R6은 R4와 같은 머지에 들어가야 한다.**
- **재등록 대기 항목의 수명.** 재등록 없이 떠난 워커의 대기 항목은 하트비트 점검(기본 10초 간격 — 데스크톱 `in_process.rs:45`, CLI `main.rs` 같은 기본값)이 stale(기본 30초, 설정상 86400초까지)을 넘겼다고 볼 때까지 남는다. 화면엔 「busy · 끝난 run」. 예약 불가라 부하는 없다.

## 2. 접근

| 안 | 내용 | 판정 |
|---|---|---|
| **A (채택)** | 최종화 순간 run 항목을 맵에서 지운다. 「몫을 끝냈나」는 `record_phase`가 풀 항목에 직접 기록해 run 항목 없이 판정한다. 송신 복사본은 각 워커가 끝 phase를 보고한 즉시, 재등록 대기 풀 항목에서도 놓는다. | 메모리·2초 대기를 둘 다 없애고 판정 정보의 주인이 풀 항목 하나로 모인다. |
| B | 최종화 때 무거운 내용(`base`·송신)만 비우고 뼈대는 모든 스트림이 닫히거나 기한이 될 때까지 둔다. | 판정 코드는 그대로지만 뼈대 수명용 타이머가 하나 더 생기고, 안 닫히는 연결이면 기한까지 남는다. 두 종류 수명을 관리해야 한다. |
| C | 하트비트가 끝난 지 N초 지난 항목을 청소. | 2초 대기를 못 없앤다(N초 동안 송신 복사본 유지). 기각. |

## 3. 요구사항

### R0 — 지킬 조건

- proto·migration·REST 응답 모양·UI·워커 동작 무변경.
- 락 규율(R14): `runs` 락과 `pool` 락을 겹쳐 잡지 않는다. 락 안에서 `.await` 없음.
- 09bb1914·e36daeed의 풀 항목 수명 규칙 유지: Completed/Failed/컨트롤러 요청 Aborted 뒤의 정상 close는 항목 유지(재등록 대기), 유휴 close·실행 중 close·스스로 Aborted close는 제거. 스트림 종료·리퍼·타이머 제거는 자기 등록만 건드린다(새 등록을 지우지 않는다 — R4 세대).
- 최종화의 DB 쓰기·verdict 영속·fan-out 순서·사유 문구는 그대로.

### R1 — 최종화 순간 run 항목 제거

- `rw.terminal = true`를 세우던 모든 지점(위 5곳)은 같은 락 블록 안에서 **`rw.done.cancel()`을 지금처럼 부르고**(토큰은 drop으로 취소되지 않는다 — 빠뜨리면 `run_watchdog`(`:1369-1412`)가 backstop까지 잠든 채 run마다 태스크가 샌다), fan-out 대상 송신 복사본을 모은 뒤 **맵에서 그 run을 제거**한다. 이후 그 run에 대한 늦은 메시지는 「run 없음」 경로를 탄다:
  - `record_phase`: run 없음 → 반환(지금의 terminal → `Finalize::None`과 같은 결과). 단 R3의 풀 기록은 run 유무와 무관하게 한다.
  - `worker_disconnected`·`fail_run_hung`·`fail_incomplete_registration`·`abort`: 지금도 run 없음이면 no-op/`false`. `abort`가 `false`를 돌려주는 호출부(`in_process.rs` `abort_all`·`abort_active_runs`, `api/runs.rs:1334`)는 그 값을 무시한다.
  - `register`(run_id가 있는 등록): 끝난 run이면 지금은 `Reject`(AbortRun 후 끊음), 바뀐 뒤엔 `NoRun`(끊음). 워커는 둘 다 `connect_with_backoff`의 재시도 대상이라 동작 차이 없음. `NoRun` 로그(`:1540`, 지금 `error!`)는 끝난 run에 늦게 붙는 워커(K8s 파드 재시작 등)가 정상적으로 닿는 경로가 되므로 `warn!`으로 낮춘다(문구 유지).
  - `assignment_for`(`:891-958`): `register`가 Assigned를 돌려준 뒤 그 run이 최종화·제거되면 `None`이 된다(지금은 terminal 항목을 읽어 성공). 풀 경로에선 `assign_pool_workers`가 `Err` → `api/runs.rs`의 두 호출부(`:903-911`·`:969-977`)가 가드 없는 `runs::mark_failed`(`store/runs.rs:461`)로 진짜 최종 상태·사유를 「풀 워커 배정 실패」로 덮는다. 이 두 곳을 `runs::mark_failed_if_active`로 바꾼다(이미 끝난 run은 그대로 둠 — 같은 덮어쓰기가 Reject/NoRun으로 이미 있으나 R1이 창을 넓힌다).
  - `ingest_metrics`: run 없음이면 `first_load` 취소만 건너뛰고 행은 지금처럼 DB에 넣는다.
- `RunWorkers.terminal` 필드는 맵에 terminal 항목이 더는 없으므로 제거한다. `RegisterOutcome::Reject`는 초과 등록용으로 남는다(문서 주석의 「already-terminal」을 지운다, R8).

### R2 — 워커가 끝 phase를 보고하면 그 워커의 송신 복사본을 놓는다

- `WorkerEntry.tx`를 `Option<WorkerTx>`로 바꾸고, `record_phase`가 그 워커의 phase를 Completed/Failed/Aborted로 기록할 때 놓는다. fan-out 목록은 남은(`Some`) 것만 모은다 — 이미 끝을 보고한 워커에 Abort를 보내는 것은 지금도 무의미하다.
- 효과: 부하기 2대 run에서 먼저 끝난 워커도 형제를 기다리지 않고 응답 쪽이 닫힌다(R4와 합쳐).

### R3 — 「몫을 끝냈나」를 풀 항목에 기록

- `record_phase`는 runs 락 블록 안에서 분류를 정하고(아래 표는 **위에서부터 먼저 맞는 줄이 이긴다**), 락을 놓은 직후(**최종화의 `.await`들 — DB 쓰기·`fan_out_abort` — 보다 먼저**) pool 락으로 그 워커의 풀 항목이 있고 `assigned_run == Some(run_id)`이면 「몫을 끝냄」 표시를 세운다. 분류:
  - run 항목 있음, 워커가 구성원 아님 → 표시 안 함(phase 무관).
  - Completed·Failed(run 항목 유무 무관 — 항목 없음은 최종화 뒤에 도착한 보고다) → 끝냄.
  - Aborted, run 항목 있음, 워커가 그 run의 구성원, 스스로 중단(`abort_requested` 없음 → 지금의 `self_aborted = true`) → **끝냄 아님**.
  - Aborted, run 항목 있음, 컨트롤러 요청(`abort_requested`) → 끝냄.
  - Aborted, run 항목 없음(최종화 뒤 fan-out에 대한 답, 또는 `cancel_dispatch_failed`가 지운 run의 배정된 워커) → 끝냄. **행동 변화**: 부분 배정 실패 run의 배정된 워커가 Aborted 뒤 close하면 지금은 제거되지만(`:604-616` 판정 false) 바뀐 뒤엔 재등록 대기로 남아 설정이 유지된다 — 더 나은 결과로 받아들인다.
- `pool_stream_closed`는 `worker_finished_part` 대신 이 표시로 판정한다(`worker_finished_part` 제거). 재등록(`pool_register_idle`)은 표시를 지운다.
- 같은 스트림 핸들러 태스크 안에서 `RunStatus` 처리(`record_phase`)가 close 처리(`pool_stream_closed`)보다 순서대로 먼저 끝나므로 둘 사이 경쟁은 없다.

### R4 — 재등록 대기 풀 항목은 송신 복사본을 쥐지 않는다 + 등록 세대

- `PoolEntry.tx`를 `Option<WorkerTx>`로 바꾸고 `pool_stream_closed`가 항목을 재등록 대기로 남길 때 놓는다. 예약 경로는 `assigned_run`이 `Some`인 대기 항목을 이미 건너뛰고, 하트비트는 대기 항목에 Ping하지 않는다(`pool_heartbeat_tick`의 `if awaiting` 분기) — 둘 다 `None`을 안전하게 건너뛰게 한다.
- **등록 세대**: `PoolEntry`에 `generation: u64`를 두고 `pool_register_idle`이 등록·재등록마다 새 값(코디네이터 단위 단조 증가)을 매겨 핸들러에 돌려준다. `same_channel` 비교(`pool_evict_if_same`·`pool_stream_closed`)를 세대 비교로 바꾼다 — 송신이 없는 대기 항목도 자기 것을 알아본다. R5 타이머는 대기 진입 때의 세대를 잡고, stale 리퍼 스냅숏도 세대를 잡는다. (R6 제외는 무조건 제거라 세대 가드가 필요 없다.)
- R1+R2+R4가 모두 들어가면, 워커의 요청 스트림 종료 → 핸들러 close 처리 → 핸들러 태스크 종료 순으로 오래 사는 복사본이 모두 놓이고, 잠깐 쥐는 복사본(하트비트·fan-out)이 놓이는 대로 응답이 끝나 워커의 대기가 곧 끝난다(US2). 핸들러가 inbound 종료 뒤에야 `tx`를 놓으므로 응답 종료는 항상 워커의 END_STREAM 뒤다 — 마지막 `RunStatus`·메트릭은 이미 읽혔다. 데이터셋 적재 경로의 2초 대기(`worker/src/lib.rs:208`·`:226`)도 같이 짧아진다.

### R5 — 재등록 대기 항목의 자체 기한 10초

- 재등록 대기에 들어갈 때 그 항목 전용 타이머(10초, 상수)를 건다(`tokio::spawn` + `tokio::time::sleep` — 가상 시계 테스트 가능). 기한에 그 항목이 아직 대기 상태이고 세대가 같으면 조용히 지운다(그 워커는 이미 몫을 끝냈으므로 run 쪽 처리 없음).
- 하트비트 점검 간격(기본 10초, 설정 가능)에 묶지 않는다 — 점검에서 보면 실제 제거가 10–20초 뒤가 된다.
- stale 리퍼는 지금처럼 대기 항목도 stale이면 지운다(stale이 10초보다 짧게 설정된 경우 그쪽이 먼저).
- **비용**: 재접속이 10초를 넘는 워커(컨트롤러 잠깐 끊김·백오프)는 새 항목으로 들어온다 — 고정 ID 워커는 DB(`pool_overrides`)에서 설정이 복원되고, 고정 ID 없는 워커는 라벨·용량·「비우기」를 잃는다. 정상 run 사이 재등록은 R4 뒤 수 ms라 해당 없음.

### R6 — 「제외」 묘비

- **저장 위치·원자성**: 묘비 표(워커 ID → (`reason`, 만든 시각 `tokio::time::Instant`))는 **pool 락이 지키는 같은 데이터** 안에 둔다(예: pool 맵을 `{ entries, tombstones }` 구조로). `pool_exclude`는 항목을 지우는 **같은 락 구간**에서 전달 가능 여부를 정한다 — `tx`가 `None`(재등록 대기)이거나 `tx.is_closed()`(스트림이 죽었는데 close 처리 전)면 그 자리에서 묘비를 넣는다. `.await`가 없으므로 R14 유지. 락을 놓은 뒤의 순서(실행 중이면 `worker_disconnected` → `Disconnect` `try_send`)는 지금 그대로 — `Disconnect`를 먼저 보내면 실행 중 워커가 스스로 중단(R8 경로)해 run 사유가 틀어진다. 반환은 지금처럼 `true`(200).
- **등록 쪽**: `pool_register_idle`이 자기 락 구간 안에서 묘비를 먼저 보고, 있으면 묘비를 지우고(한 번만 씀) 항목을 넣지 않은 채 `Tombstoned(reason)` 결과를 돌려준다(아니면 `Registered { generation }`). 확인과 소비가 등록과 같은 락 구간이라 「제외 → 등록 확인(묘비 없음) → 묘비 삽입 → 새 항목 생존」 경쟁이 없다.
- **핸들러**: 묘비 확인은 `check_token`·풀 모드 검사(`:1461-1483`, 묘비 확인은 `:1483` 뒤 `pool_register_idle` 직전) **뒤**에만 일어난다(인증 안 된 상대가 워커 ID만 알고 묘비를 소비해 제외된 워커를 들여보내지 못하게). `Tombstoned`면 그 스트림으로 `Disconnect{reason}`을 보내고(수락 Ping 없음) 다른 거절 경로처럼 **`break`** 한다 — `continue`하면 `worker_id`가 `Some`·`pool_conn`이 false라 종료 신호를 안 듣는 핸들러가 남는다(`:1442`). 워커는 대기 중 `Disconnect`를 받아 취소·종료한다(`worker-core/src/client.rs:279-283` — CLI는 프로세스 토큰이라 `run_pool_until` 종료, 데스크톱은 자식 토큰 취소 → `Err` 분기에서 `PoolEvent::Excluded`, `worker/src/lib.rs:720-724`).
- 묘비를 늘 남기지 않는 이유: 정상 전달된 「제외」 뒤 사용자가 부하기에서 「다시 접속」을 누르면 다시 튕기기 때문이다. 같은 이유로 한 번 쓰면 지운다.
- **만료**: `pool_heartbeat_tick`(주입된 `now`·`stale`)이 만든 지 `max(stale, 60초)`보다 오래된 묘비를 지운다(구현 중 최종 리뷰 반영 — 60초 하한 `TOMBSTONE_MIN_LIFETIME`은 워커 재접속 상한 `reconnect::TOTAL_CAP`과 같아, stale을 짧게 둔 서버에서도 백오프 중인 부하기가 묘비 만료 뒤에 돌아와 「제외」가 사라지지 않게 한다). **비용**: stale을 길게(최대 86400초) 둔 서버에서 몇 시간 뒤 일부러 다시 켠 그 부하기는 한 번 튕긴다(한 번 쓰면 지우므로 그다음 시작은 정상).
- 묘비는 메모리에만(컨트롤러 재시작 = 풀도 비므로 같이 사라짐).

### R9 — 풀 배정 일부 실패 뒤 배정 못 받은 예약 워커 풀어 주기 (선재 버그, 사용자 결정 2026-11-17로 편입)

- **재현**: 풀 부하기 여러 대로 run을 만들 때 `assign_pool_workers`(`coordinator.rs:335`)가 예약 목록을 차례로 돌다 k번째에서 실패한다(`register`가 Assigned 아님·`assignment_for` `None`·배정 전송 실패 — 워커가 예약과 전송 사이에 떠남).
- **실측(지금)**: 호출부(`api/runs.rs`)는 `cancel_dispatch_failed`로 run 항목을 지우고 이미 등록된 0..k-1번에 Abort를 보내지만, 풀은 건드리지 않는다. k+1번 이후(그리고 실패 원인이 그 워커의 이탈이 아닌 k번)는 배정을 한 번도 못 받았는데 `assigned_run = Some(run_id)`가 남고, 연결이 살아 Pong이 stale도 막아 **재접속 전까지 「busy」로 예약 불가**다.
- **기대**: `assign_pool_workers`가 실패로 돌아가기 직전, **`register`가 Assigned를 돌려주지 않은** 예약 워커의 예약을 푼다 — `register` 비-Assigned 분기면 k번부터, `assignment_for` `None`·배정 전송 실패 분기면 k+1번부터(k는 이미 run 구성원). 각 항목은 `assigned_run == Some(run_id)`이고 송신이 살아 있을 때만(`tx`가 `Some`이고 `!is_closed()`) `assigned_run = None`. **k를 `assignment_for` `None` 분기에서 풀면 안 되는 이유**: k는 구성원이라 그 run의 최종화 fan-out(형제 실패·스스로 중단·`worker_disconnected`·`fail_run_hung`·`abort()`)에서 Abort가 오는 중인데, 풀려서 곧 다음 run에 예약·배정되면 옛 Abort가 배정 대기 중에 도착해 `AbortedBeforeAssignment`(`worker-core/src/client.rs:285-293`)로 워커가 스트림을 끊고, 그 close가 새 run을 `worker_disconnected`로 실패시킨다. 안 풀면 k는 Abort를 받고 재접속해 정상으로 돌아온다. 송신이 닫힌 워커(이탈)는 풀지 않는다(풀면 죽은 송신이 다음 run에 예약된다 — 하트비트가 `Closed`로 지운다, 지금과 같음). 0..k-1번은 Abort → Aborted 보고 → R3(run 없음 Aborted = 끝냄) → 재등록 대기로 돌아오므로 건드리지 않는다.
- 기존 `release_pool_reservation`(`:761`, enqueue 전 예약 해제용 — run 가드 없음)은 바꾸지 않고, run 가드·송신 확인이 있는 별도 함수로.
- US2(연달아 시작한 run이 모든 부하기를 받는다)의 연장 — 배정 일부 실패 뒤에도 남은 부하기가 다음 run에 잡힌다.

### R7 — 검증 (테스트)

빌더가 정한 이름으로, 회귀 가드 테스트는 고의 회귀 → RED → 원복 → GREEN(되돌려 확인)을 실행한다.

- **R1**: Completed(N=1·N=2)·Failed·컨트롤러 Aborted·스스로 Aborted·`worker_disconnected` fail-fast·watchdog(`fail_run_hung`)·registration-deadline 각 경로 뒤 `runs` 맵에 그 run이 없고 **`done`이 취소됐다**. `assign_pool_workers` 쪽은 둘로 나눈다: (a) 이미 제거된 run에 `assign_pool_workers`가 `Err`를 돌려주고 DB를 건드리지 않는다(코디네이터 단위) (b) 배정 실패 처리(두 호출부)를 작은 함수로 뽑아, 이미 끝난(비활성) run의 상태·사유를 덮지 않음을 따로 테스트한다.
- **US2**: 풀 워커의 끝 보고 + 요청 스트림 종료 뒤 **응답 쪽 수신기가 `None`을 받는다**(모든 송신 복사본이 놓임) — 부하기 2대에서 먼저 끝난 워커도. 재등록 뒤 즉시 예약에 잡힌다.
- **US4**: 마지막 워커 Completed 뒤 close · Failed run에서 형제의 늦은 Aborted 뒤 close(run 항목이 이미 없는 상태) · 컨트롤러 abort 뒤 close → 항목 유지(재등록 대기)·라벨/용량/「비우기」 유지, 재등록 후 그대로. 스스로 Aborted 뒤 close·실행 중 close·유휴 close → 제거(기존 테스트 유지). 옛 스트림 close가 새 등록(세대)을 지우지 않는다.
- **US3**: 가상 시계로 대기 진입 후 10초 → 제거, 그 전에 재등록하면 유지(타이머가 새 세대를 지우지 않음).
- **R9**: (분기 3) 예약 4대 `a,b,c,d`(`b`·`d`의 수신기를 drop해 `b`에서 배정 전송이 실패하게, `reserve_idle_pool`은 `HashMap` 순서라 반환 Vec을 테스트가 재정렬) → `assign_pool_workers` `Err` → `c`는 `assigned_run == None`(유휴, 다음 예약에 잡힘), `d`는 닫힌 송신이라 풀지 않음(송신 가드), 실패 지점 `b`도 그대로(닫힌 송신이라 송신 가드가 막는다 — k+1 규칙의 증거는 아님), 앞서 배정받은 `a`는 그대로. 그 사이 같은 ID가 다시 등록한 항목(다른 `assigned_run`)은 건드리지 않음. (분기 1) 이미 제거된 run에 `assign_pool_workers` → `register` `NoRun` at k=0 → 예약 2대 모두 유휴. (분기 2·3의 「k+1부터」) 분기 2는 결정적으로 만들기 어렵고(`register`와 `assignment_for` 사이 최종화) 분기 3의 k는 늘 닫힌 송신이라 관찰 불가 → 「실패 분기 → 해제 시작 번호」를 작은 순수 함수로 빼서 단위 테스트한다(분기 1 → k, 분기 2·3 → k+1).
- **US1**: 대기 항목 「제외」 → `true` + 묘비; 같은 ID의 빈 run_id `Register`(올바른 토큰) → 그 스트림에 `Disconnect{reason}`, 풀에 없음, 수락 Ping 없음, 핸들러 종료; 두 번째 `Register` → 정상 등록. 토큰이 틀린 `Register`는 묘비를 소비하지 않는다. 살아 있는 항목 「제외」 → 묘비 없음(그다음 `Register`는 정상). `is_closed()` 송신 항목 「제외」 → 묘비. 묘비 stale 만료. 제외와 등록을 엇갈려 부르는 경쟁 테스트(제외 먼저 → 등록은 튕김 / 등록 먼저 → 새 항목에 대한 제외는 정상 전달).

### R8 — 낡은 주석·함정 노트

바뀐 사실에 맞게 고친다(동작 무변경):
- `worker/src/lib.rs:417-429` 주석(「컨트롤러가 응답 쪽을 안 닫는다(§B66)」 → 닫으므로 대기가 곧 끝남, 2초는 상한).
- `crates/worker-core/CLAUDE.md:23`(`inbound_fwd`가 어느 모드에서도 스스로 끝나지 않는다는 서술).
- `crates/controller/CLAUDE.md:88`(`terminal` 플래그 서술)·`:202`(`same_channel`만으로 식별·대기 항목이 죽은 `tx`를 쥔다는 서술).
- 문서 주석: `pool_exclude`(「absorbed by the terminal guard」, `:663`)·`RegisterOutcome::Reject`(「already-terminal」, `:210`)·`PoolEntry.awaiting_reregister`(「dead `tx`」).

## 4. 범위 밖

- `try_send`가 `Full`이라 `Disconnect`가 안 들어간 경우(워커가 읽지 않는 막힌 연결) — 지금과 같다.
- 묘비 영속(DB)·여러 컨트롤러 간 공유.
- 워커 쪽 동작 변경(2초 상한 값 등).
- 끝난 run에 늦게 붙는 legacy 워커에 `AbortRun`을 다시 보내는 것 — 워커 동작 차이가 없다(R1).
- **roadmap §B 기록 대상(R9 분기 2의 k)**: 경쟁으로만 닿는 분기 2에서 k는 배정 대기 중 Abort를 받아 `Aborted` 보고 없이 스트림을 닫으므로(`AbortedBeforeAssignment`) 「몫을 끝냄」 표시가 없어 항목이 제거된다 — 고정 ID 없는 워커는 라벨·용량·「비우기」를 잃는다(지금과 같음).

## 5. 라이브 검증 (`/live-verify`, 맥)

컨트롤러 `--worker-mode pool` + CLI 풀 워커 2대(고정 ID 1대·고정 ID 없음 1대). baseline(master 바이너리)과 수정본 둘 다에서 US2 행을 잰다.

| US | 절차 | 통과 신호 |
|---|---|---|
| US2 | 짧은 run 3번 연속, 앞 run 끝나자마자 다음 run 생성 | 컨트롤러 로그 `worker run status`(Completed) → `pool worker registered idle` 간격: baseline 약 2.0초, 수정본 < 0.5초. 수정본에선 다음 run 진행 중 `GET /api/pool/workers`의 두 워커가 모두 `busy: true, run_id: <새 id>`(또는 그 run id의 `worker run status` 로그 2줄) |
| US4 | 두 워커에 라벨·용량 설정(둘 다 비우기 없음) → 부하기 2대 성공 run · 부하기 2대 실패 run(VU 전원이 실패해 워커가 `Failed`를 보고하는 시나리오 — plan이 코드로 확정한 방법. 두 워커가 거의 동시에 실패해 형제가 늦은 `Aborted` 대신 늦은 `Failed`를 보낼 수 있다 — 둘 다 통과로 치고 어느 쪽이었는지 컨트롤러 `worker run status` 로그로 기록; 늦은 `Aborted` 경로 자체는 R7 US4 단위 테스트가 결정적으로 증명) · 부하기 2대 사용자 중단 run → 마지막으로 하나 「비우기」 후 나머지 1대로 run(비운 워커는 예약되지 않음 — `!e.drained`) | 매 run 뒤 `GET /api/pool/workers`에서 라벨·용량 유지, 마지막 run 뒤 `drained` 유지 |
| US1 | 일반 「제외」(유휴 워커) | 워커 종료·목록에서 사라짐(기존 동작 회귀 없음). 틈 「제외」는 R7 통합 테스트가 증명 |
| US3 | — | R7 가상 시계 테스트로 증명(라이브 불가 — US3 본문) |

## 6. 사실 주장 명령표 (claims-ledger — 디스패치 전 재실행)

| 주장 | 명령 |
|---|---|
| 맵 제거는 `cancel_dispatch_failed` 한 곳, terminal 세우는 곳 5곳 | `grep -n "rw.terminal = true\|g.remove(run_id)" crates/controller/src/grpc/coordinator.rs` (테스트 영역 1900행 이후 제외) |
| `worker_finished_part`는 `pool_stream_closed`만 부른다 | `grep -rn "worker_finished_part" crates/controller/src` |
| 워커 2초 대기 주석이 §B66을 가리키고 `worker done`은 그 뒤 | `grep -n "keeps a copy of our stream\|worker done\|from_secs(2), inbound_fwd" crates/worker/src/lib.rs` |
| 하트비트 기본 10초·stale 30초 | `grep -n "pool_heartbeat_interval_seconds: 10\|pool_stale_timeout_seconds: 30" crates/controller/src/in_process.rs` |
| `abort` false를 호출부가 무시 | `grep -rn "coord.abort(" crates/controller/src --include='*.rs'` |
| 풀 배정 실패 뒤 가드 없는 `mark_failed` = `:910`·`:976`(파일 전체 8곳 중 `assign_pool_workers` 실패 분기 둘) | `grep -n "runs::mark_failed(\|assign_pool_workers" crates/controller/src/api/runs.rs` |
| REST 필드는 `busy`·`run_id` | `grep -n "busy:\|run_id: i.assigned_run" crates/controller/src/api/pool.rs` |
| 등록 대기 중 `Disconnect` → 취소 | `grep -n "requested disconnect while idle" crates/worker-core/src/client.rs` |
| 데스크톱은 자식 토큰 취소로 「제외됨」 | `grep -n "PoolEvent::Excluded" crates/worker/src/lib.rs` |
| `NoRun` 로그가 `error!` | `grep -n "no pending run for worker" crates/controller/src/grpc/coordinator.rs` |
