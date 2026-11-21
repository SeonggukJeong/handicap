# 생성 도중 중단된 run의 생성 실패 응답 정리 (pool-prefail-response)

- 날짜: 2026-11-21 · 유형: `correctness-bug`
- 상태: 완료 (2026-11-21, 코드 `18065799`..`831ed9be`, 판단·연기 roadmap §B80)
- 출처: roadmap §B79 (2) 첫 항목 「풀 사전 실패 응답은 그대로다」
- 사용자 결정(2026-11-21, 다시 묻지 않는다): 풀 사전 실패 다섯 곳에 더해 **디스패치 실패도 같은 규칙으로** 바꾼다 · US 3개

## 사용자 스토리 (US)

버그 슬라이스라 `재현 / 기대 / 실측` 형식이다.

- **US1 — 중단한 run이 스케줄 기록에 「발사 실패」로 남지 않는다** (운영자)
  - 재현: 스케줄이 발사한 run의 생성이 실패하는 상황에서, run 행이 생긴 직후 그 run이 중단된다(중단 버튼, 데스크톱 앱 종료, 모드 전환). 생성이 실패하는 상황은 둘이다 — LAN 풀 모드에서 풀이 비었거나 용량·unique 행이 부족한 경우, 풀이 아닌 모드(이 PC 부하기·K8s)에서 부하기를 띄우지 못한 경우(디스패치 실패).
  - 기대: 스케줄 기록에 「발사됨」과 run 번호가 남는다. 그 run은 `aborted`다. 풀 모드의 경우에는 사유도 있다(없었으면 「부하를 시작하기 전에 중단했습니다」). 디스패치 실패의 경우 사유는 중단 API가 정한다(§4.2).
  - 한계: 앱 종료·모드 전환은 스케줄러 자체도 멈추므로(`in_process.rs` 399–402의 `select!`), 그 순간 기록을 쓰기 전이면 기록이 아예 남지 않을 수 있다. 이 수정은 기록이 쓰이는 경우의 내용을 바로잡는다.
  - 실측: 코드상 `spawn_run`이 오류를 돌려주므로 스케줄러가 run 번호 없는 「발사 실패: …」를 기록한다(§1). 라이브 실측 전.
- **US2 — 중단한 run을 만든 요청이 오류로 끝나지 않는다** (QA)
  - 재현: 같은 두 상황에서 `POST /api/runs`로 run을 만든다.
  - 기대: 201과 `status: "aborted"`인 run이 온다.
  - 실측: 풀 모드는 400(빈 풀·unique 행 부족) 또는 500(용량 부족), 풀이 아닌 모드의 디스패치 실패는 500이 온다. 행은 `aborted`로 남아 응답과 어긋난다.
- **US3 — 중단이 끼지 않은 생성 실패는 지금과 같다** (QA)
  - 재현: 같은 조건에서 중단 없이 run을 만든다.
  - 기대: 응답 코드·오류 문구·행의 `failed` 상태와 사유가 지금과 글자까지 같다. 풀 예약도 지금처럼 풀린다.

> US 초안 대비 변경(사용자에게 고지): 디스패치 실패는 풀이 아닌 모드에서만 일어나므로(풀 모드는 `spawn_run`의 풀 갈래 안에서 끝난다) US1·US2의 재현을 「풀 모드의 사전 실패」와 「풀이 아닌 모드의 디스패치 실패」 둘로 나눠 적었다. US1에 앱 종료·모드 전환의 한계를 더했다.

## 1. 지금 동작 (코드 확인)

줄번호는 base `a94017bf`의 `crates/controller/src/api/runs.rs`, `grep -n "mark_failed_if_active" crates/controller/src/api/runs.rs`로 확인했다.

`spawn_run`(716–1022)에서 `runs::insert`(745) 뒤에 「생성 실패」로 판단해 끝나는 곳은 일곱이다(저장소 오류로 끝나는 길은 §2 비목표).

| # | 줄 | 갈래 | 사유 | 응답 | `enqueue` 전/후 |
|---|---|---|---|---|---|
| 1 | 872 | 용량 고려 | 빈 풀 | 400 | 전 |
| 2 | 882 | 용량 고려 | 용량 부족(사전 검사 뒤 풀이 줄어듦) | 500 | 전 |
| 3 | 895 | 용량 고려 | unique 행 수 < 풀 부하기 수 | 400 | 전 |
| 4 | 950 | `?force` | 빈 풀 | 400 | 전 |
| 5 | 961 | `?force` | unique 행 수 < 풀 부하기 수 | 400 | 전 |
| 6 | 1017 | 풀 아님 | 디스패치 실패 | 500 | 후 |
| 7 | 919·985 → `fail_pool_assignment`(1388–1402) | 풀 | 배정 실패(부하기 이탈) | 500 | 후 |

1–6은 같은 모양이다: (3·5는 예약 해제 →) `cancel_dispatch_failed` → `mark_failed_if_active(…)?` → `return Err(…)`. `mark_failed_if_active`의 반환값(행이 바뀌었나)을 보지 않으므로, 행이 이미 `aborted`여도 오류를 돌려준다.

7(`fail_pool_assignment`)만 반환값을 본다: 행이 안 바뀌었고 `aborted`면 그 행을 `Ok`로 돌려준다. `enqueue` 직후의 `row_if_no_longer_pending`(1408–1434)도 `aborted` 행을 `Ok`로 돌려주고 사유가 없으면 「부하를 시작하기 전에 중단했습니다」(`runs::ABORT_MSG_NOT_STARTED`)를 채운다.

호출하는 쪽:
- `create`(1024–1051): `Ok(row)` → 201, `Err` → 오류 응답.
- 스케줄러 `process_due_schedules`(`schedule/runner.rs` 211–253): `Ok(row)` → 기록 `fired` + run 번호, `Err(e)` → 기록 `error` + 「발사 실패: {e}」(run 번호 없음).

그 틈에 중단이 닿는 길:
- 중단 API `abort_run`(1436–1462): `abort_if_active`(DB) → `coord.abort`. `enqueue` 전이면 코디네이터에 run이 없어 `AbortOutcome::NoRun` → 사유를 쓰지 않는다.
- `abort_active_runs`(`in_process.rs` 223–243, 데스크톱 앱 종료·모드 전환): DB에서 `pending`/`running` 행을 전부 찾아 `mark_aborted_if_active`(사유 「앱 종료로 중단」 등 포함)로 바꾼다. 생성 요청 도중의 `pending` 행도 잡힌다.

틈의 크기: 1–5는 `insert`와 실패 사이에 메모리 안의 풀 잠금뿐이라 수 µs–ms다. 사람이 중단 버튼으로 맞추기는 어렵고 `abort_active_runs`가 현실적인 길이다. 6은 K8s에서 Job 생성이 몇 초 걸릴 수 있어 버튼으로도 닿는다. 그래서 1–5의 US1·US2는 시험용 트리거로만 확인할 수 있다(§6).

## 2. 목표 / 비목표

**목표**
- 일곱 곳 모두 「행이 이미 `aborted`면 그 행을 정상 생성으로 돌려준다」.
- `enqueue` 전의 다섯 곳(1–5)에서 그렇게 돌려준 행에 사유가 없으면 「부하를 시작하기 전에 중단했습니다」를 채운다.
- 중단이 끼지 않은 실패는 응답·행 상태·사유·풀 예약 해제가 지금과 같다.

**비목표**
- 행을 넣기 **전**의 거절(검증 400, 용량 부족 409 `ConflictJson`). run 행이 없어 중단될 수 없다.
- 저장소 오류로 끝나는 길: `row_if_no_longer_pending(…)?`(910·976·1003)와 그 안의 행 읽기 실패, `mark_failed_if_active(…)?` 자체의 DB 오류. 지금처럼 500이다.
- proto·마이그레이션·UI. 응답 모양(`RunResponse`)은 그대로이고 `status: "aborted"`인 생성 응답은 이미 있는 경우다(`row_if_no_longer_pending`).
- §B79의 다른 항목(`mark_aborted` 가시성, `abort_all`의 DB 기록, `set_verdict` 가드 등).

**안티목표**
- 이미 `completed`/`failed`인 행을 정상 생성으로 돌려주는 것. 그 경우는 지금처럼 원래 오류다.
- 중단이 끼지 않은 실패의 문구·코드가 한 글자라도 달라지는 것.

## 3. 접근

**정한 것 — 헬퍼 하나로 모은다.** 일곱 곳이 같은 헬퍼를 부른다. 한 곳씩 `if !mark_failed_if_active(…)` 가지를 복사해 넣는 방법은 같은 다섯 줄이 일곱 번 생기고 한 곳이 빠져도 컴파일러가 알려 주지 않아 버렸다. 호출하는 쪽(`create`·스케줄러)에서 오류를 받은 뒤 행을 다시 읽어 판단하는 방법은 `spawn_run`이 run 번호를 오류와 함께 넘겨야 하고 호출처마다 같은 처리를 반복해야 해 버렸다.

## 4. 설계

### 4.1 헬퍼

`api/runs.rs`에 둔다(이름은 구현자가 정한다 — 아래는 `fail_run_start`로 부른다).

입력: `coord`, `db`, `run_id`, 실패 사유 글자, 돌려줄 `ApiError`, 그리고 **`enqueue` 전인지 후인지**. `AppState`가 아니라 `coord`+`db`를 받는다 — `fail_pool_assignment`와 그 테스트 셋이 그렇게 부른다.

순서:
1. `coord.cancel_dispatch_failed(run_id)`. `enqueue` 전이면 코디네이터에 항목이 없어 아무 일도 하지 않는다(지금도 1–5가 부른다).
2. `runs::mark_failed_if_active(db, run_id, 사유)?`. 행이 바뀌었으면 받은 `ApiError`를 그대로 돌려준다 — 지금 동작.
3. 행이 안 바뀌었으면:
   - `enqueue` **전**이면 `runs::set_abort_reason_if_absent(db, run_id, ABORT_MSG_NOT_STARTED)?`. 이 UPDATE는 `aborted`이고 사유가 빈 행에만 닿는다.
   - `runs::get`으로 행을 읽어 `aborted`면 `Ok(row)`, 아니면(끝난 run·행 없음) 받은 `ApiError`.
   - `Ok(row)`로 돌려줄 때 `tracing::info!`로 run 번호와 넘겨받은 실패 사유를 남긴다. 응답에서 빠지는 실패 사유(빈 풀 등)가 로그에는 남는다.

풀 예약 해제(3·5의 `release_pool_reservation`)는 헬퍼 밖, 지금 자리에 둔다 — 예약 목록은 그 두 곳에만 있다.

### 4.2 사유를 `enqueue` 전에만 채우는 이유

- `enqueue` 전(1–5): 코디네이터에 run이 없으므로 중단 API는 「시작 전」인지 알 수 없어 사유를 쓰지 않는다(§1). 이 다섯 곳은 부하기에 아무것도 보내지 않았음이 확실하므로 여기서 채운다. 앱 종료·모드 전환이 남긴 사유는 이미 있어 덮이지 않는다.
- `enqueue` 후(6·7): 코디네이터에 run이 있어 중단 API가 실제 접속 상태를 보고 사유를 정한다(「시작 전」 또는 「부하기 N대 중 M대만…」). 여기서 「시작 전」을 먼저 채우면 일부 접속 사유가 「이미 사유 있음」으로 밀려 틀린 사유가 남는다. 그래서 채우지 않는다 — `fail_pool_assignment`의 지금 동작과 같다(`fail_pool_assignment_returns_row_when_aborted`가 `message == None`을 단언한다).
  - 비용 ①: 헬퍼의 `cancel_dispatch_failed`가 중단 API의 `coord.abort`보다 먼저 run을 지우면 중단 API는 `NoRun`을 받아 사유 없는 `aborted` 행이 남는다. 평소 실행 중 중단도 사유가 없으므로 거짓 정보는 아니다.
  - 비용 ②: 헬퍼가 행을 읽은 뒤에 중단 API가 사유를 쓰면 생성 응답의 `message`는 비어 있고 DB에는 사유가 있다(상세 화면은 다시 읽으므로 사유가 보인다).
  - 둘 다 roadmap §B에 남긴다. 해소 경로: `cancel_dispatch_failed`가 지운 run의 (접속한 부하기 수, 기대 수)를 돌려주면 헬퍼가 6·7에서도 맞는 사유를 쓸 수 있다 — 7의 지금 동작이 바뀌므로 이번에는 하지 않는다.

### 4.3 호출처

- 1–5: 지금의 세 줄(`cancel_dispatch_failed`·`mark_failed_if_active`·`return Err`)을 `return fail_run_start(…, 전).await`로 바꾼다. 오류 종류와 문구는 지금 것을 그대로 넘긴다.
- 6: 같은 식으로 `후`. `tracing::error!` 로그는 그대로 둔다 — 행이 `aborted`라 응답에서 빠지는 디스패치 오류 글자가 로그에 남는다.
- 7: `fail_pool_assignment`는 남긴다. 몸통이 헬퍼를 `후` + `POOL_ASSIGN_FAILED_MSG` + `ApiError::Internal`로 부르는 한 줄이 된다. 동작은 지금과 같아야 한다 — 기존 테스트 셋(`fail_pool_assignment_*`)이 고치지 않은 채 통과한다(달라지는 것은 `aborted` 가지의 `info!` 로그뿐).
- 설명 글을 지금 동작으로 고친다: `spawn_run` 머리 주석, `cancel_dispatch_failed` 문서 주석(`grpc/coordinator.rs` 1555–1563, 호출처 동작을 적고 있다), `crates/controller/CLAUDE.md`의 「dispatch 실패는 권위 있는 run-start 실패다 …」 줄(같은 줄 안의 「run 단위 Failed 전이(dispatch 실패·풀 사전 실패 …)」 문장 포함)·「중단 API는 …」 줄·풀 발사 줄의 `fail_pool_assignment` 설명.

스케줄러·`create`는 손대지 않는다. `Ok(row)`를 받으면 이미 「발사됨」+run 번호 / 201을 낸다.

## 5. 테스트

모두 `api/runs.rs` 인라인 테스트(기존 틀 `abort_on_insert_trigger`·`call_spawn_run`·`pool_state_with_two_workers` 재사용)와 `schedule/runner.rs` 인라인 테스트다. 운영 코드에 시험용 틈을 내지 않는다.

- **중단이 낀 경우(US1·US2)** — 곳마다 한 테스트: `Ok(row)`, `row.status == Aborted`, 1–5는 `row.message == ABORT_MSG_NOT_STARTED`, 6은 `message == None`.
  - 1·4: `abort_on_insert` 트리거 + 빈 풀. 기존 `spawn_run_pool_empty_failure_keeps_aborted_row`(「응답은 기존과 같다」를 단언)는 새 기대로 바꾼다.
  - 3·5: 트리거 + 유휴 부하기 2대 + unique 바인딩 행 1개. 예약이 풀렸는지도 본다(`assert_pool_released`). **그 곳에 실제로 닿았음을 보여야 한다** — unique 가지에 닿지 않으면 run은 `enqueue` → `row_if_no_longer_pending`으로 가서 같은 결과(`Ok`·`aborted`·「시작 전」·예약 해제)를 내고, 그러면 테스트가 고치기 전 코드에서도 통과한다. 지금의 `call_spawn_run`은 바인딩 없는 프로필과 빈 `validated_metas`를 넘기므로(바인딩과 메타를 짝지어 0개가 된다) unique 가지에 닿지 않는다. 그래서 unique 프로필(`unique_profile`)과 `row_count: 1`인 메타를 넘기는 호출 틀을 새로 두고, **같은 틀을 트리거 없이 돌려 400 「unique 데이터셋 행 수가…」가 나오는지**(= US3 테스트)로 도달을 보인다.
  - 2: 사전 검사와 예약 사이에 풀이 줄어야 닿는다. 트리거로는 못 만든다. 방법 — 다른 연결이 쓰기 잠금(`BEGIN IMMEDIATE`)을 쥐어 `runs::insert`를 붙잡아 둔 채 `spawn_run`을 태스크로 띄우고, 그 사이에 부하기 한 대를 풀에서 뺀 뒤 잠금을 푼다. 사전 검사는 멈출 지점이 없이 끝나고 `insert`는 잠금이 풀릴 때까지 끝나지 못하므로, 부하기를 빼는 시점이 「사전 검사 뒤·예약 앞」으로 고정된다. 「한 번 양보하고 빼기」만으로는 안 된다 — `insert`가 양보 중에 끝나 예약까지 지나갈 수 있다. **이 방법이 결정적으로 되는지는 구현 중 실측으로 확정**한다. 닿지 못했을 때 드러나는 모양: 너무 일찍 빼면 409(중단 유·무 모두 실패로 드러난다). 너무 늦게 빼면 중단 없는 경우는 201로 드러나지만, **중단이 낀 경우는 `row_if_no_longer_pending`이 같은 결과를 내어 고치기 전 코드에서도 통과한다**. 그래서 중단이 낀 경우에는 도달 확인을 더한다 — 세는 디스패처를 `coord.set_dispatcher`로 끼워 `cleanup` 호출이 0인지 본다(2번 곳은 `enqueue` 전이라 `cancel_dispatch_failed`가 `cleanup`을 부르지 않고, 늦은 길은 `enqueue`된 run을 정리하며 한 번 부른다). 안 되면 2번 곳은 중단이 낀 경우·없는 경우 둘 다 헬퍼 테스트와 코드 대조로만 덮고 roadmap §B 검증 공백에 적는다.
  - 6: 트리거를 쓰면 `row_if_no_longer_pending`이 먼저 잡아 디스패치까지 가지 않는다. 시험용 디스패처로 만든다(`state.dispatcher`를 바꿔 끼운다, `state_with_counting`과 같은 식). 두 가지 — ⓐ `dispatch` 안에서 DB에 `abort_if_active`만 쓰고 오류: `Ok`·`aborted`·`message == None`. ⓑ `dispatch` 안에서 중단 API(`abort_run`)를 부르고 오류: `Ok`·`aborted`이고 DB의 사유가 「부하를 시작하기 전에 중단했습니다」(중단 API가 쓴 것 — §4.2의 순서 주장을 고정한다).
  - 사유 보존: 행이 「앱 종료로 중단」 사유로 중단된 경우 1번 곳에서 사유가 그대로다. 기존 트리거는 `status`만 바꾸므로 `message`도 쓰는 둘째 트리거를 둔다.
- **중단이 없는 경우(US3)** — 1–6 각각 `Err` 종류·문구, 행 `failed`·사유를 단언한다. 기존 테스트가 이미 덮는 곳은 그 테스트 이름을 plan에 적고, 없는 곳만 더한다.
- **끝난 run**: 행이 `completed`면 원래 오류(기존 `fail_pool_assignment_keeps_finished_run`).
- **스케줄러(US1)**: 풀 모드·빈 풀·트리거로 `process_due_schedules`를 돌려 기록이 `fired` + run 번호인지, 트리거 없이는 `error` + 「발사 실패: …」인지.
- **되돌려 확인**: 곳마다 한다 — 그 곳의 호출을 옛 세 줄로 되돌리면 그 곳의 「중단이 낀 경우」 테스트가 실패하는지 본다. 헬퍼에서 사유 채우기를 지우면 1–5의 사유 단언이, `enqueue` 후에도 채우게 바꾸면 6ⓐ와 `fail_pool_assignment_returns_row_when_aborted`가 실패하는지도 본다.

## 6. 라이브 검증

run 생성 경로를 건드리므로 필수다. 워크트리 자체 바이너리, 파일 DB(`--db /tmp/pool-prefail-response.db`), 풀 모드(`--worker-mode pool`), 부하기 없음, `--scheduler-tick-seconds 1`. 스케줄은 「지금 발사」가 없으므로 `POST /api/schedules`로 몇 초 뒤 시각의 1회 스케줄을 만든다. 1회 스케줄은 발사 뒤 꺼지므로 다시 발사할 때는 새 스케줄을 만든다.

| US | 절차 | 통과 신호 |
|---|---|---|
| US3 | 빈 풀에서 `POST /api/runs` | 400 「연결된 LAN 워커가 없습니다…」, 행 `failed` + 같은 사유 |
| US2 | 컨트롤러 DB 파일에 `sqlite3`로 `abort_on_insert` 트리거(테스트와 같은 SQL)를 만든 뒤 `POST /api/runs` | 201, `status: "aborted"`, `message` 「부하를 시작하기 전에 중단했습니다」. 화면 run 상세에 중단 사유가 보인다 |
| US2 | 같은 트리거 상태에서 `POST /api/runs?force=true`(4번 곳) | 201, `status: "aborted"`, 같은 사유 |
| US1 | 같은 트리거 상태에서 1회 스케줄을 발사시킨다 | 스케줄 기록이 「발사됨」+run 번호(전: 「발사 실패」) |
| US3 | 트리거를 지우고(`DROP TRIGGER`) 새 1회 스케줄을 발사 | 기록이 「발사 실패: …」 |

트리거는 「생성 도중의 중단」을 만드는 시험 장치다(운영 코드 무변경). 2번(용량 부족)·3·5번(unique)·6번(디스패치 실패)은 라이브에서 틈을 맞출 수 없어 단위 테스트로만 본다 — build-log에 그렇게 적는다.

## 7. 연기·기록할 것 (roadmap §B 새 블록)

- §4.2의 비용 둘과 해소 경로.
- US1의 한계(앱 종료·모드 전환 때 스케줄 기록이 아예 안 남을 수 있음).
- 2번 곳 테스트가 결정적으로 안 되면 그 공백.
- 라이브로 못 본 곳(위).
- §B79 (2) 첫 항목에 해소 표시.
- 다음 릴리즈 노트 줄: 「run을 만드는 도중에 중단하면 생성 요청·스케줄 기록이 실패가 아니라 중단된 run으로 남음」.
