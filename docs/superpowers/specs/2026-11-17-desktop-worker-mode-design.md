# 데스크톱 앱 부하기 모드 2차 (desktop-worker-mode) — 설계

- 날짜: 2026-11-17
- 상태: 설계
- 유형: user-path (+ correctness-bug: 한 부하기가 정상 종료로 빠지면 run은 `aborted`인데 다른 부하기는 계속 부하 — R8)
- 출처: 사용자 요청(2026-11-16) "부하기들은 접속 버튼 눌러서 접속" — 1차(desktop-lan-mode, ADR-0057) spec §8 「2차 = 부하기 쪽 버튼」 ①–⑦
- 관련: ADR-0057, ADR-0041, `docs/superpowers/specs/2026-11-16-desktop-lan-mode-design.md`(1차 — 이 문서는 그 R-번호를 `1차-R4`처럼 인용), `docs/dev/lan-workers.md`, roadmap §B64
- 범위: **설치판 앱만**(1차 사용자 결정 — 포터블 exe에는 버튼 방식 없음).
- **슬라이스 나눔(사용자 결정 2026-11-17)**: spec은 이 한 문서, plan·머지는 둘. **2a = 라이브러리·와이어**(R3·R4·R8 — 화면 변화 없음, 헤드리스 검증), **2b = 설치 ID·접속 코드·셸**(R1·R2·R5·R6·R7 — US1–US4 라이브). 2b plan은 2a가 master에 들어간 뒤 그 실제 코드 위에서 쓴다(2a의 통로 모양이 2b 설계의 전제라서 — 추측 대신 사실).

## 사용자 스토리 (US)

- **US1**: QA가 서버 PC 역할 화면에서 「접속 코드 복사」를 눌러 메신저로 부하기 PC에 보내고, 부하기 PC의 앱 「모드 전환」에서 「부하기로 접속」 칸에 붙여넣어 누른다 — 성공하면 부하기 PC 화면에 「연결됨 · 대기 중」과 서버 주소가 보이고, 서버 「워커」 화면에 그 PC가 나타난다. 서버를 다시 시작하거나 테스트가 끝난 뒤에도 부하기 PC에는 「연결 중」 깜빡임 없이 대기 상태가 유지된다.
- **US2**: QA가 부하기 PC 화면을 보며 서버에서 테스트를 돌린다 — 성공하면 실행 동안 「테스트 실행 중 · <시나리오 이름> · #<run 끝 6자>」가 보이고, 끝나면 「연결됨 · 대기 중」으로 돌아온다. 실행 중 「접속 끊기」나 역할 전환을 누르면 「실행 중인 테스트가 중단됩니다 — 다른 부하기도 함께 멈춥니다」 확인 창이 뜨고, 취소하면 아무것도 바뀌지 않는다. 확인하면 서버의 그 run은 `aborted`가 되고 다른 부하기의 부하도 멈춘다.
- **US3**: QA가 잘못된 코드를 붙여넣거나 서버에 닿지 않는 상황(서버 꺼짐·방화벽·토큰 불일치)에서 접속한다 — 성공하면 잘못된 코드는 바로 「접속 코드 형식이 아닙니다」가 뜬다. 닿지 않으면 첫 실패부터 몇 초 안에 「다시 시도 중」과 이유(「서버에 연결할 수 없습니다」·「접속 코드의 토큰이 맞지 않습니다」 등)가 보이고, 서버가 살아나면 손대지 않아도 연결된다. 서버 「워커」 화면에서 「제외」하면 부하기 PC에 「서버에서 제외됨」이 보이고 재접속하지 않는다.
- **US4**: QA가 PC 이름이 같은 부하기 PC 두 대를 각각 버튼으로 접속시킨다 — 성공하면 서버 「워커」 화면에 두 줄로 따로 보이고(같은 호스트 이름, 다른 워커 ID), 테스트를 돌리면 둘 다 부하를 나눠 낸다. 부하기 PC의 앱을 껐다 켜면 저장된 코드로 다시 접속되고, 서버 화면에는 같은 워커 ID로 돌아와 라벨·「비우기」 설정이 이어진다.

US 문구 정정(사용자 승인 뒤, 리뷰 반영 — 2026-11-17): US2의 확인 창은 승인 초안 「이 PC 몫만큼 줄어듭니다」가 코드와 달라(R8) 사용자 결정 「전체 중단」으로, 실행 중 표시는 run 라벨이 와이어에 없어 시나리오 이름 + 끝 6자로(§5.4) · US4의 「제외」는 DB에 남지 않는 동작이라(`pool_exclude` = 메모리 항목 제거 + `Disconnect`, `coordinator.rs:590-609`) DB에 남는 「비우기」로.

### 재현 / 기대 / 실측 (R8 — 2a)

- **재현**: 부하기 2대(풀 또는 subprocess fan-out)로 run 실행 중 한 부하기를 정상 종료(SIGTERM/Ctrl+C, 또는 앱의 셸 취소)한다.
- **실측(지금)**: 그 부하기는 엔진 취소 → `Phase::Aborted` 보고 → 컨트롤러 `record_phase`가 `Finalize::Aborted`로 **run 전체를 `aborted`** 기록(`coordinator.rs:925-928`·`970-978`)하지만 형제 부하기에 abort를 보내지 않는다(`Finalize::Failed`만 `fan_out_abort`, `coordinator.rs:915-924`·`979-983`). 다른 부하기는 run 길이가 끝날 때까지 부하를 계속 낸다 — 화면은 `aborted`인데 부하가 나간다.
- **기대**: run이 `aborted`로 끝나는 순간 아직 끝나지 않은 형제 부하기에도 abort가 간다(실패 때와 같은 fan-out). 부하기가 *갑자기* 죽는 경우(`worker_disconnected` → `failed` + fan-out)와 동작이 통일된다.

## 1. 배경 — 지금 동작

- **지금 막힌 것**: 부하기 PC는 터미널 명령 한 줄로만 합류할 수 있다(Windows는 포터블 exe를 따로 받아야 한다). 합류가 됐는지·왜 안 되는지는 터미널 로그로만 보이고, 실패 이유는 60초가 지나야 에러 값으로 나온다.
- **1차 결과**(ADR-0057): 설치판 앱 「모드 전환」(셸 origin 화면 `desktop/src/role.html`) → 「서버로 열기」/「혼자 쓰기로 돌아가기」. 서버 모드 = in-process 컨트롤러 풀 모드(gRPC `0.0.0.0:<포트>`, 토큰), 「이 PC도 부하 내기」(`role.rs` `spawn_self_worker` → `handicap_worker::run_pool_until`, 용량 1000), OS별 부하기 명령 복사(`desktop-core` `command.rs`). 토큰은 `worker_command` 응답에만 실린다(`commands.rs:3-4`, 테스트 `role_state_never_contains_token`).
- **역할 설정** `desktop-role.json`(`desktop-core` `config.rs`): `version: 1`, `role: local|server`, `server{token, grpc_port, self_worker}`. 모르는 역할 = 혼자 쓰기 + 경고(서버 설정 보존, `config.rs:99-103`). 설정 디렉터리 env override 있음(`config_store.rs`).
- **앱 창**은 `splash.html`로 열려(`tauri.conf.json` `"url": "splash.html"`, `create: false` — `setup`이 직접 만든다) `boot` 결과에 따라 컨트롤러 UI 또는 `role.html`로 navigate한다(`lib.rs`).
- **셸 상태** `Running{controller, base_url, self_worker}` — 컨트롤러가 필수 필드(`role.rs:74-78`). 정지·활성 run 수·이 PC 부하기 실행 중 판정(`self_worker_busy_locked` — `pool_workers()` 조회)이 모두 컨트롤러를 거친다.
- **풀 워커 루프**(`crates/worker/src/lib.rs` `run_pool_until`): `connect_with_backoff`(worker-core `reconnect.rs` — 1·2·4·8s, 누적 60s `TOTAL_CAP`) → 배정 실행 → **매 run 뒤 재접속·재등록**(reconnect-per-run). `TOTAL_CAP` 실패면 `warn!` 후 루프가 **곧바로** 다시 돈다. 60s 시계(`reconnect.rs:95` `started`)는 `connect_and_register`의 **배정 대기 시간까지 포함**한다 — 60s 넘게 대기하다 스트림이 끊기면 첫 실패에서 바로 포기하고 0초 뒤 새 사이클.
- **등록 직후 신호 없음**: 풀 등록(`coordinator.rs` `pool_register_idle`) 뒤 첫 하트비트 `Ping`까지 최대 `pool_heartbeat_interval_seconds`(in-process 기본 10s `in_process.rs:45`, DB 설정으로 변경 가능).
- **토큰 불일치**: 컨트롤러가 `Abort{reason:"authentication failed"}` 전송 후 스트림 종료(`coordinator.rs:1323-1333`, 문자열 1329행). 워커 배정 대기(`client.rs` `connect_and_register`)는 `Assignment`/`Ping`/`Disconnect` 외를 `NoAssignment`("missing assignment after register")로 뭉개 **사유가 사라진다**(`client.rs:166-169`).
- **연결 타임아웃 없음**: `connect_and_register`의 `Channel::…connect()`에 connect timeout이 없다(`client.rs:112-117`) — 방화벽이 패킷을 버리면 OS SYN 타임아웃(Windows ~21s, macOS ~75s)을 그대로 기다린다.
- **부하기 ID**: 1차 Windows 명령 `--worker-id $env:COMPUTERNAME`, macOS·Linux `"$(hostname)"`, 「이 PC도 부하 내기」 `resolve_hostname()`. 같은 ID 등록은 한 항목으로 합쳐진다(`pool_register_idle` tx 교체, `coordinator.rs:411-420`). ① 같은 PC가 경로를 바꾸면 두 대 ② 이름이 같은 다른 PC(사용자: "PC이름이 동일한 경우가 꽤 있어서")는 한 대로 보인다.
- **워커 화면**(`WorkerDashboardPage.tsx`)은 「호스트 이름」·「워커 ID」 열이 따로다. 고정 ID(`stable_id` — `--worker-id` 명시, `lib.rs:106`)만 「비우기」·용량·라벨이 DB에 남아 재접속 때 이어진다. 「제외」는 DB에 안 남는다(위 US 정정). 「제외」 확인 문구는 "다시 추가하려면 해당 PC에서 워커를 직접 재실행해야 합니다"(`ko.ts` `excludeConfirmBody`).
- `RunAssignment`(proto)엔 run 라벨이 없다(`run_id`·`scenario_yaml`·`profile`·… `coordinator.proto:131-142`).

## 2. 접근

| 안 | 내용 | 판단 |
|---|---|---|
| **A (채택, 사용자 승인)** | 부하기 모드에서 셸이 in-process 풀 워커를 돌린다(1차 `spawn_self_worker` 진입점). worker-core에 상태 사건 통로(선택)를 더하고 셸이 그것으로 상태 화면을 그린다. CLI는 통로 없이 지금 경로 그대로. | 1차의 시작·정지·제외 경로 재사용, 상태 정확, 프로세스 하나. |
| B | 셸이 `worker …` 자식 프로세스를 띄우고 로그 줄로 상태 추정 | 로그 문구 변경이 화면을 조용히 깨고 OS별 자식 정리 위험. 기각. |
| C | 부하기 모드에서도 컨트롤러 유지 | 1차 §8 "부하기 모드에선 컨트롤러 미기동"과 충돌. 기각. |

사용자 결정(2026-11-17): 접속 코드는 **복사·붙여넣기 전용**(손 입력 짧은 코드는 보안상 기각) · 부하기 ID = **설치마다 하나인 무작위 ID**(명령 경로가 다른 ID가 되는 것은 감수 — "버튼 생기면 버튼만 쓰지 명령 붙여쓰는 경우는 거의 없을거") · 서버 화면의 명령 복사는 접어 둔다(같은 대화에서 제안·수용) · 부하기 쪽 흐름 R5–R6 "내가 생각하던 방식" · **실행 중 부하기가 빠지면 run 전체 중단**, 남은 부하기로 계속은 후속(§6) · 2a/2b 나눔.

---

## 2a — 라이브러리·와이어

### R0a — 지킬 조건 (2a)

- **CLI 워커**(`run`/`run_pool`/`run_pool_until`)의 인자·로그·재시도 일정(1·2·4·8s, 60s 포기 후 재사이클)은 그대로. 새 통로·연결 루프는 별도 진입점이고 CLI는 부르지 않는다. 기존 `retry_with_backoff(f, cancel)`·`connect_with_backoff` 시그니처는 바꾸지 않는다(`reconnect_backoff_test.rs`가 직접 부른다) — 필요한 것은 새 함수로.
- **모든 워커가 받는 컨트롤러 변경 2건**: R3 등록 직후 `Ping`(기존 워커는 `Pong` 답 후 계속 대기 — 하위 호환), R8 `aborted` fan-out(기존 워커는 run id가 같은 `Abort`를 이미 처리 — 취소는 멱등).
- proto 메시지·필드·migration·REST 추가 0. 엔진 무변경.

### R3 — 컨트롤러·워커 신호 (1차 §8 ②·③)

- **등록 직후 Ping**: 풀 등록 경로에서 그 스트림의 `tx`로 `Ping`을 **`pool_register_idle`이 끝난 뒤에** 보낸다 — 워커가 받는 첫 수락 신호 = 「서버 풀 목록에 들어감」(토큰 통과 + 목록 반영). 그 사이 동시 `assign_pool_workers`가 `Assignment`를 먼저 밀어 넣으면 워커는 그것을 묵시적 수락으로 받고(R4 `Accepted`), 뒤따른 `Ping`은 `forward_inbound`가 답한다. 단위/통합 테스트: 실행이 없을 때 등록 직후 첫 서버 메시지가 `Ping`, `Accepted` 직후 풀 목록에 그 워커가 있음.
  - 구현 중 정정(2026-11-17, Task 5 리뷰): 처음 설계는 「`pool_register_idle` 호출 **전**」이었다. 그러면 고정 ID의 DB 읽기 동안 워커가 「연결됨」인데 서버 목록엔 없는 틈이 생겼고, 테스트가 그 틈을 변호하는 주석을 달았다. `pool_register_idle`엔 거절 경로가 없고 `Assignment`-먼저는 묵시적 수락이 이미 덮으므로 뒤로 옮겼다.
- **배정 전 Abort 사유 보존**: `connect_and_register`의 배정 대기에서 `Abort`를 받으면 그 `reason`을 에러 값에 담는다. 에러 `Display`는 지금 그대로 `"missing assignment after register"`(로그 불변), 사유는 별도 접근자로. **사유 문자열 `"authentication failed"`는 `handicap-proto` 크레이트의 공개 상수 하나**로 두고 컨트롤러(`coordinator.rs:1329`)와 워커 분류가 함께 쓴다(두 크레이트 모두 이미 의존).

### R4 — 상태 사건 통로·연결 루프 (worker-core + worker, 1차 §8 ①·④)

- **사건 타입과 사건 → 상태 순수 함수는 worker-core에**(pre-commit nextest 대상; desktop-core는 tonic·엔진 무의존이라 두지 않는다). 셸(2b)은 상태 값을 받아 화면 문구로만 바꾼다.
- **사건**(통로가 알리는 것):
  - `Probing{후보 수}` — 접속 사이클 시작(IP 탐침 전)
  - `AttemptFailed{이유, 다음 시도까지 대기}` — 한 번의 시도가 **수락 전에** 실패(탐침 전부 실패 포함)
  - `Accepted{주소}` — 등록 뒤 첫 `Ping` 또는 첫 `Assignment`(Assignment = 묵시적 수락 — R3: 동시 배정이 `Ping`보다 먼저 올 수 있다)
  - `SessionLost{이유}` — **수락된 뒤** 대기 중 스트림이 끊김(서버 재시작·망 끊김) — `AttemptFailed`와 구별
  - `RunStarted{run_id, 시나리오 이름}`(이름 = `scenario_yaml`의 `name`, 파싱 실패면 없음, **Rust에서 80자로 자름**) / `RunEnded`
  - `Excluded` — **대기 중이든 실행 중이든** 서버의 `Disconnect`(지금처럼 그 뒤 워커는 끝난다). 실행 중 `Disconnect`는 `forward_inbound`(`client.rs:66-69`)가 받아 넘겨준 취소 토큰을 cancel할 뿐이라, 새 루프는 `connect_and_register`에 **호출자 토큰의 자식 토큰**을 넘기고 "자식 취소 ∧ 호출자 미취소"를 제외로 판정한다(1차 `role.rs` parent/child 판정과 같은 방식 — `client.rs` 무변경). 이 경우 `RunEnded`보다 `Excluded`가 우선(유예로 「연결됨 · 대기」가 보이면 안 된다).
- **worker-core 상태 집합**: {연결 중, 연결됨 · 대기(수락 뒤 15초 유예 포함 — R5), 실행 중, 다시 시도 중(이유 + 다음 시도까지 남은 초), 제외됨}. 「끊김」(사용자 끊기·저장된 `connected:false`·저장된 코드 해석 실패)은 워커가 돌지 않는 상태라 **셸(2b)이 덧씌우는 층**이다 — worker-core 함수에는 없다. 사건 → 상태 함수는 시계를 주입받는다(유예 테스트).
- **이유 종류**: `unreachable`(전송 연결 실패·탐침 전부 실패), `auth_failed`(R3 상수와 같은 사유), `rejected{사유}`(그 밖의 배정 전 `Abort` — 사유는 **Rust에서 200자로 자름**), `protocol`(그 밖의 RPC/스트림 에러·`NoAssignment`). 분류는 순수 함수 + 단위 테스트.
- **연결 루프(새 진입점, 데스크톱 전용)**: 입력 = IP 후보 목록 + 포트 + 토큰 + 워커 ID + 용량 + 취소 토큰 + 사건 받는 쪽. 동작:
  - 사이클마다 **후보가 1개여도** 모든 후보에 동시에 짧은 타임아웃(구현 판단 ~2s)으로 TCP 연결을 시도해 처음 성공한 주소로 gRPC 접속(OS SYN 타임아웃 회피). 연결 단계에도 같은 상한을 둔다. 전부 실패 = `AttemptFailed{unreachable}`.
  - 재시도 일정은 CLI와 같은 1·2·4·8s(이후 8s)이되 **포기하지 않는다**(60s `TOTAL_CAP` 없음). 수락된 세션이 생기면 시도 카운터를 0으로.
  - 배정 실행은 기존 `execute_assignment` 재사용(reconnect-per-run 유지).
  - 탐침은 주입 가능한 연결 함수로 단위 테스트(첫 성공·전부 실패·느린 후보 무시·후보 1개).
- **1차 「이 PC도 부하 내기」**는 2a에서 바꾸지 않는다(2b가 새 진입점으로 옮길지 결정 — 셸 몫).

### R8 — 한 부하기 중단 = run 전체 중단 (컨트롤러, 사용자 결정)

- `record_phase`가 `Finalize::Aborted`로 run을 끝낼 때, `Finalize::Failed`처럼 **아직 terminal이 아닌 형제 부하기에 `fan_out_abort`**(사유 예: "sibling worker aborted")를 보낸다. 실패 fan-out·`worker_disconnected`·`fail_run_hung`·dispatch 실패는 이미 run을 terminal로 만들어 `Finalize::None`이 된다 — 남는 것은 부하기가 스스로 중단한 경우와 컨트롤러가 `abort()`로 중단을 요청한 경우이고, 아래 표시로 둘을 가른다.
- **컨트롤러가 요청한 중단과 구별**: `coord.abort(run_id)`를 부르는 곳이 셋이다 — REST 중단(`api/runs.rs:1334`, abort를 **먼저** 보내고 그 뒤 무가드 `mark_aborted` — DB가 아직 `running`일 수 있다), 컨트롤러 종료 `abort_all`(`in_process.rs:179`, DB 쓰기 없음), 1차 정지 경로 `abort_active_runs`(`in_process.rs:233`, DB 먼저). 그래서 DB 상태로는 구별할 수 없다. **`abort()`가 그 run의 메모리 상태(`RunWorkers`)에 "컨트롤러가 중단 요청함" 표시를 남기고**, `record_phase`의 `Aborted`는 그 표시가 있으면 지금 동작 그대로(`set_status`, 사유 없음 — 형제는 `abort()`가 이미 전원에 보냄), 없을 때만 R8(형제 fan-out + 사유)을 한다. **표시는 `abort()`가 워커 목록을 복사하는 바로 그 runs 잠금 블록 안에서, 잠금을 풀기 전·어떤 Abort도 보내기 전에** 세운다(`coordinator.rs:1129-1146` — 지금은 잠금 안에서 tx를 복사하고 잠금 밖에서 차례로 보낸다; 보낸 뒤나 별도 잠금에서 세우면 첫 워커의 `Aborted`가 둘째 워커 전송 중에 도착해 표시 없이 R8을 탄다).
- **사유 남기기(R8 경로만)**: 지금 `Finalize::Aborted`는 `set_status`(message 칸 안 씀)라 사유 없는 `aborted`가 된다. R8 경로는 **가드 단일 UPDATE**(`status IN ('pending','running')`일 때만 — `mark_aborted_if_active`(`store/runs.rs:441`)와 같은 가드)로 message "worker <id> stopped mid-run — run aborted (other workers stopped)"(기존 실패 메시지들처럼 영어 원문)를 남긴다.
- 단위: ① 2워커 run에서 한쪽이 스스로 `Aborted` → terminal 아닌 다른 쪽 tx가 `Abort` 수신 + run `aborted` + 위 message ② `abort()` 뒤(DB는 아직 `running` — REST 순서 재현) 워커가 곧바로 `Aborted` → status `aborted`·message **`NULL`**(R8 문구 아님) + 형제에 두 번째 fan-out 없음. **표시 위치를 잠그는 변형**: 2워커 run에서 한 워커 tx(테스트가 만든 작은 채널)를 가득 채워 `abort()`가 전송 중에 멈추게 한 상태로(전송 순서는 `HashMap` 순이라 어느 전송에서 멈출지는 가정하지 않는다), 그 사이 다른 워커의 `Aborted`를 `record_phase`에 넣는다 → 여전히 message `NULL`(표시를 전송 뒤로 옮기면 RED). 틀린 배치에선 R8 경로가 같은 가득 찬 채널에 보내다 멈추므로 `record_phase`와 DB 확인을 타임아웃으로 감싸고, message는 전송 *앞*의 가드 UPDATE 뒤에 읽고, 끝에 채널을 비워 두 태스크를 끝낸다(회귀가 테스트 러너 타임아웃이 아니라 단언 실패로 보이게). 이빨 실증(표시를 전송 뒤로 → RED → 원복) 필수 ③ `mark_aborted_if_active(…, "X")` + `abort()` 뒤 워커 `Aborted` → message `"X"` 그대로 ④ 1차 정지 순서 테스트(`role.rs` `switch_marks_self_worker_run_aborted_not_failed` 등 — `message == ABORT_MSG_ROLE_SWITCH` 단언) 그대로 green(순서를 뒤집으면 여전히 RED).
- 영향: K8s·subprocess fan-out에서도 한 Pod/프로세스가 SIGTERM으로 빠지면(예: Pod 퇴출) 형제도 멈춘다 — run이 이미 `aborted`로 표시되던 것과 실제 부하가 맞춰진다(릴리즈 노트 줄에 포함).

### 2a 검증

- 단위: R3 첫 메시지 `Ping`·사유 보존 + `Display` 불변·사유 상수 공유 / 사건 → 상태(R4 상태 집합의 전이 전부 + 유예 15초 경계 + 실행 중 제외 → 제외됨) / 이유 분류 / 탐침 / 새 루프가 포기하지 않음·수락 뒤 카운터 리셋(`tokio::time::pause` — worker-core 함정: `tokio::time::Instant`) / CLI 경로 무변경(기존 테스트 green) / R8 fan-out.
- 통합(헤드리스, in-process 컨트롤러 풀 모드 — 1차 `in_process_pool_rejoin_test` 류): 새 루프로 붙은 워커의 사건 순서 `Probing → Accepted → RunStarted → RunEnded → Accepted`, 토큰 틀림 → `AttemptFailed{auth_failed}` 반복, 컨트롤러 재시작 → `SessionLost` 뒤 `Accepted`, 대시보드 제외 → `Excluded`(**대기 중과 실행 중 둘 다**).
- **라이브(필수 — R8은 엔진 경로)**: 컨트롤러 풀 모드 + CLI 부하기 2개로 run → 한 부하기 SIGTERM → run `aborted` + 다른 부하기 로그에 abort 수신·부하 정지(대상 응답기 요청 수가 멈춤).
- US: 2a 단독으론 사용자 화면 변화 없음 — US1–US4는 2b에서 확인. R8만 위 재현/기대/실측으로.

---

## 2b — 설치 ID·접속 코드·셸 (2a 머지 뒤 plan)

### R0b — 지킬 조건 (2b)

- 설정 `version: 1` 유지, 칸만 더한다(`role: "worker"`, `worker{code, connected}`, 최상위 `install_id`). 2차 앱은 1차 파일을 그대로 읽는다.
- 혼자 쓰기·서버 역할은 1차와 같다 — **의도된 차이**: ① 「이 PC도 부하 내기」 부하기 ID가 PC 이름 → 설치 ID(R1) ② 그래서 "PC 이름을 읽지 못해 쓸 수 없습니다"(1차-R4)가 사라진다 ③ 서버 화면 주 경로가 접속 코드, 명령 복사는 기본 접힘(R2) ④ 워커 화면 「제외」 확인 문구에 "버튼으로 접속한 PC는 그 PC에서 「다시 접속」" 안내 추가(`ui/src` `ko.ts` 한 줄 — UI 테스트 동반).
- migration·REST·proto 추가 0(2a 위).

### R1 — 설치 ID (1차 §8 ⑦)

- 셸이 처음 서버 또는 부하기 역할로 시작할 때 무작위 ID(OS CSPRNG 128비트 이상, ASCII 영숫자 — 1차 `generate_token` 재사용 가능)를 만들어 `install_id`에 저장, 이후 재사용. 비밀 아님(워커 화면에 보인다).
- 서버의 「이 PC도 부하 내기」와 부하기 역할 워커 둘 다 `worker_id = install_id`(고정 ID → 「비우기」·용량·라벨이 재시작·역할 전환을 넘어 이어짐). `Register.hostname`은 `resolve_hostname()`(표시용).
- 형식이 깨진 `install_id`(빈 값·영숫자 아님·32자 미만)는 조용히 새로 만든다. 저장 실패면 이번 실행은 메모리 ID, 1차 저장 실패 안내 그대로.
- 알려진 한계(문서화): 서버/부하기로 켠 뒤 PC 이미지를 복제하면 `install_id`도 복사된다 → "복제 전엔 켜지 말 것, 켰다면 `install_id` 줄 삭제". 명령 경로(R2 접힌 묶음)는 PC 이름 ID를 유지 — 같은 PC가 버튼과 명령을 오가면 두 대(사용자 수용).

### R2 — 접속 코드 (서버 쪽)

- **형식**: `HANDICAP1-` + ASCII 영숫자 본문. 담는 것: 형식 버전, 서버 IPv4 후보(1차 `candidate_ipv4s` 결과 전부·순서 유지, **최대 16개**), gRPC 포트, 토큰, **검사값**(본문 어느 한 글자가 바뀌거나 잘려도 형식 오류 — 체크섬 필수). 인코딩·검사 방식은 builder 판단.
- **해석기 = 신뢰 안 되는 입력**: 디코드 전 길이 상한(4096자), 앞뒤 공백·줄바꿈 제거, 모르는 버전 = 형식 오류(문구에 "앱 버전이 다를 수 있습니다"), IP 0개·17개 이상·포트 0·토큰이 `is_usable_token` 위반 또는 256자 초과 = 형식 오류. 순수 함수는 desktop-core(왕복·한 글자 변조·잘림·모르는 버전·공백·상한).
- **서버 역할 화면**: 「부하기 PC 접속 코드」(한 줄 말줄임 + 「복사」·복사됨 피드백) + 안내 "부하기 PC의 앱에서 「모드 전환」 → 「부하기로 접속」에 붙여넣으세요 — 같은 버전의 앱이어야 합니다". IP 후보 0개면 1차 "이 PC의 망 주소를 찾지 못했습니다". 화면을 열 때마다 다시 만든다.
- 코드는 **비밀**: 1차 토큰 규칙 — **별도 IPC 명령의 응답에만**(1차 `worker_command`처럼 요청 시), `role_state`·로그·Debug에는 없다(1차 테스트 `role_state_never_contains_token` 유지·코드도 같은 테스트에 추가).
- 1차의 IP·OS 고르기·명령 복사는 「명령으로 붙이기 (포터블 exe·터미널)」 접이식 묶음(기본 접힘) 안으로. 포트 변경 안내 문구 "부하기들에 새 명령을 주세요" → "부하기들에 새 접속 코드(또는 명령)를 주세요".

### R5 — 부하기 상태 화면 (셸)

| 상태 | 문구 | 들어가는 때 |
|---|---|---|
| 연결 중 | 「서버에 연결하는 중…」 + 코드의 서버 주소(들) | 시작 직후 ~ 첫 수락 또는 첫 실패 |
| 연결됨 · 대기 | 「연결됨 · 대기 중」 + 탐침으로 고른 IP:포트 | `Accepted` / 아래 유예 중 |
| 실행 중 | 「테스트 실행 중 · <시나리오 이름> · #<run id 끝 6자>」(이름 없으면 생략) | `RunStarted` |
| 다시 시도 중 | 「다시 시도 중 — <이유>」 + "N초 뒤 다시 시도" | 수락 전 `AttemptFailed`, 또는 유예 초과 |
| 제외됨 | 「서버에서 제외됨 — 서버 「워커」 화면에서 제외했습니다」 + 「다시 접속」 | `Excluded` |
| 끊김 | 「접속 끊김」 + 「다시 접속」 | 사용자 「접속 끊기」·저장된 `connected:false`·저장된 코드 해석 실패 |

- **유예(US1 "깜빡임 없음")**: 수락된 적이 있는 세션에서 `RunEnded` 뒤 재등록 중이거나 `SessionLost` 뒤 재시도 중이면 **15초 동안 「연결됨 · 대기」를 유지**한다. 그 안에 `Accepted`면 화면은 그대로, 15초가 지나도 안 붙으면 「다시 시도 중 — <마지막 이유>」. 근거: 서버 역할 전환 재시작 4–10초(§B64 (3)). 이 규칙은 R4 사건 → 상태 순수 함수에 넣어 시계 주입으로 테스트(2a). 수락 전 첫 접속은 유예 없음(US3 "첫 실패부터 몇 초 안에").
- 이유 문구: `unreachable` "서버에 연결할 수 없습니다 — 서버 PC가 켜져 있고 서버 모드인지, 방화벽이 막지 않는지 확인해 주세요" / `auth_failed` "접속 코드의 토큰이 맞지 않습니다 — 서버 화면에서 새 코드를 받아 주세요" / `rejected` "서버가 접속을 거절했습니다: <사유>"(텍스트로만 삽입) / `protocol` "서버와 통신하지 못했습니다 — 두 PC의 앱 버전이 같은지 확인해 주세요".
- 다시 시도는 제외·끊김이 아니면 이유와 상관없이 계속(토큰 불일치 포함 — §5.2).
- 셸은 상태를 메모리에 두고 역할 화면이 ~1s 폴링으로 읽는다.
- 버튼: 「접속 끊기」(연결 중·대기·실행 중·다시 시도 중) / 「다시 접속」(제외됨·끊김) / 「다른 접속 코드로 바꾸기」 / 「혼자 쓰기로 돌아가기」·「서버로 열기」. 「화면으로 돌아가기」는 부하기 역할에선 없다.
- 표시: 이 PC의 워커 ID(설치 ID, 작게 — 서버 화면 대조용)·PC 이름. 극단값(긴 시나리오 이름·사유·IP 16개·32자 ID)에서 잘림/겹침 없음.

### R6 — 역할 전환 (부하기 역할 추가)

- `Role::Worker`, 설정 `worker{code, connected}`(코드는 비밀 — Debug 가림). 셸 상태는 컨트롤러가 없는 역할을 담도록 바꾼다(예: `Running`을 「컨트롤러 실행」/「부하기 실행」 두 갈래로). 부하기 역할의 실행 중 판정은 R4 상태(`실행 중`)에서 — `pool_workers()` 아님.
- **「부하기로 접속」**: 코드 붙여넣기 → 형식 검사(오류면 즉시 「접속 코드 형식이 아닙니다」, 전환 없음) → **확인 창에 대상 표시**: "이 서버에 부하기로 접속합니다: <IP 목록>:<포트> — 이 서버가 보내는 테스트를 이 PC가 실행합니다"(사설 망 주소가 아닌 IP가 있으면 1차와 같은 「사설 망 주소가 아닙니다」 경고 줄) + 다른 역할에서 올 때 "이 PC의 시나리오 화면·예약 실행·운영 모니터가 멈춥니다(다른 역할로 돌아오면 다시 켜집니다)" + 활성 run이 있으면 1차 "실행 중인 테스트 N개가 중단됩니다". 확인 = 1차 정지 경로(활성 run aborted 기록 → 이 PC 부하기 정지 → 컨트롤러 shutdown) 뒤 컨트롤러 없이 부하기 시작(용량 1000 — 1차와 같음), 역할·코드·`connected:true` 저장.
- **부하기 → 다른 역할 / 「접속 끊기」 / 「다른 접속 코드로 바꾸기」 / 「다시 접속」**: 부하기가 실행 중이면 확인 창 「실행 중인 테스트가 중단됩니다 — 다른 부하기도 함께 멈춥니다」(US2·R8), 취소 = 변화 없음. 확인 = 부하기 정지(bounded, 1차 `SELF_WORKER_STOP_TIMEOUT`) → 다음 동작. 「접속 끊기」는 역할을 부하기로 둔 채 `connected:false` 저장. (1차 서버 화면의 「이 PC도 부하 내기」 토글은 실행 중 *잠금*이다 — 부하기 역할은 그 PC의 유일한 일이라 잠그지 않고 확인 창으로 — 의도된 차이.)
- **저장 규칙**: 부하기 역할은 "부하기를 시작했다"가 성공(접속 성공을 기다리지 않음).
- **앱 시작**: 부하기 + `connected:true` → 창을 `role.html`로 navigate하고 부하기 시작. `connected:false` → 끊김. 저장된 코드가 해석 안 되면 끊김 + 안내 "저장된 접속 코드를 읽지 못했습니다 — 새 코드를 붙여넣어 주세요".
- **제외 뒤**: 「제외됨」, `connected:false` 저장(재시작해도 재접속 안 함 — US3).
- **앱 종료**: 부하기 취소·bounded 대기(1차 `RunEvent::Exit` 브리지). 실행 중이었으면 그 부하기는 `Aborted` 보고 → R8로 run 전체 `aborted` + 형제 중단(5s 상한 초과 시 끊김 → `failed` + fan-out — 기존).
- 상단 「모드 전환」 링크·칩(1차-R6)은 React UI 안이라 부하기 모드엔 보일 곳이 없다 — 무변경.

### R7 — 셸 명령 (IPC)

- 1차 규칙 그대로(셸 origin 호출만·명령마다 origin 대조·토큰·코드는 요청형 명령 응답에만).
- 더할 것: 상태 조회에 부하기 상태·설치 ID(코드·토큰 제외), 접속 코드 받기(서버, 요청형), 코드 검사(대상 미리보기 반환 — IP·포트, 토큰 제외), 부하기로 전환, 접속 끊기, 다시 접속, 코드 바꾸기. 명령 이름·DTO는 2b plan이 정하고 Rust ↔ `role.html` 1:1.

### 2b 검증

- 단위: 코드(위 R2 목록) / `install_id` 생성·유지·깨짐 재생성 / 설정 `worker` 역할 왕복·1차 파일 / 셸: 부하기 전환 → 컨트롤러 없음·부하기 시작, 끊기·제외 → `connected:false`, 서버 「이 PC도 부하 내기」 ID = 설치 ID, `role_state`에 코드·토큰 없음. `node desktop/tests/role-page.check.cjs` 갱신. UI: `ko.ts` 제외 문구 RTL.
- **라이브(필수, 맥)**: 같은 맥에서 데스크톱 앱 **세 인스턴스**(서버 1 + 부하기 2 — 설정 디렉터리·DB env override, 번들 실행 파일 직접 실행 — desktop/CLAUDE.md 「GUI 라이브는 `.app` 번들로」)를 2b plan 첫 task 스파이크로 실측(단일 인스턴스 플러그인 없음 — `Cargo.toml`). 같은 번들 ID 창 셋을 computer-use가 구별하는지도 확인, 안 되면 부하기 쪽 조작은 사용자 확인으로. US 행:
  - US1: 코드 복사 → 붙여넣기 → 대상 확인 창 → 「연결됨 · 대기 중」 + 서버 워커 화면 / 서버 혼자 쓰기→서버로 열기(15초 안) 뒤 깜빡임 없이 대기 / run 뒤 대기 유지.
  - US2: 실행 중 문구 / 「접속 끊기」 확인 창·취소 무변화 / 확인 → run `aborted` + 다른 부하기 부하 정지.
  - US3: 한 글자 바꾼 코드 → 형식 오류 / 서버 끔 → 「다시 시도 중 — 서버에 연결할 수 없습니다」(첫 접속은 몇 초 안, 수락 뒤면 15초 뒤) → 서버 켬 → 자동 연결 / 토큰만 다른 코드(인코딩 함수로 생성) → 토큰 문구 / 제외 → 「서버에서 제외됨」 + 재시작 뒤에도 재접속 없음.
  - US4: 같은 호스트 이름·다른 설정 디렉터리 부하기 2대 → 서버 화면 두 줄·둘 다 부하 / 「비우기」·라벨 설정 → 부하기 재시작 → 같은 ID로 복귀·설정 유지.
  - 극단값: 긴 시나리오 이름·긴 사유·IP 다수·32자 ID — 부하기 상태 화면과 서버 워커 화면 모두 rect 실측.
- **Windows·Linux 실기**: §B64 (3) 대기 목록에 "Windows 설치판 부하기 모드 → 맥 서버" 추가(머지 차단 아님).
- 보안 리뷰 필수(코드 = 토큰 운반·저장·표시, 해석기 = 신뢰 안 되는 입력, 대상 확인, IPC 범위, 서버 문자열 길이).

---

## 3. 범위 밖

- **실행 중 부하기가 빠져도 남은 부하기로 계속**(사용자의 원래 생각) — 후속(§6). 이번엔 전체 중단(R8).
- 같은 망 자동 찾기 — 사용자 "나중에".
- 손 입력 짧은 코드·페어링 PIN — 사용자 결정.
- 토큰 재발급, gRPC TLS, 방화벽 자동 규칙, 포트 직접 고르기 — 1차 그대로 연기.
- 포터블 exe 버튼 방식 — 1차 결정.
- 같은 이름 PC 겹침 감지 경고 — 설치 ID로 대체.
- 명령 경로 ID를 설치 ID로 — 사용자 수용.
- **§B64 (3) `HANDICAP_WORKER_TOKEN` env**(1차가 "2차에서"로 적은 것) — **다시 연기**: 버튼 경로는 토큰이 셸 기록에 안 남아 필요가 줄었고, 명령 경로 전용이라 이 슬라이스 US와 무관. 마무리 때 §B에 "2차에서 재연기 — 명령 경로 토큰 노출이 보고될 때" 기록.
- §B64 (3)의 나머지(Register 전 메시지 제한·SO_REUSEADDR·chmod·다크 모드 등) — 무관하게 남는다.

## 4. 와이어

- proto 메시지·필드·migration·REST 추가 0.
- 컨트롤러 행동 2건(R3 등록 직후 `Ping`, R8 aborted fan-out) + 사유 문자열 상수를 `handicap-proto`로(컨트롤러·워커 공유).
- 셸 ↔ 셸 페이지 IPC: 새 명령·DTO(2b).
- 접속 코드: 새 계약 — 만들기·읽기 모두 `desktop-core` 같은 함수(서버·부하기가 같은 앱 버전 전제, 형식 버전 칸으로 거절 가능).

## 5. 판단 (틀렸을 때 비용 · 해소 경로) — 마무리 때 roadmap §B에

1. **설치 ID**(사용자) — 비용: 명령으로 붙인 같은 PC는 두 대, 복제 후 겹침. 해소: 명령이 설정 파일의 ID를 읽는 옵션 / 겹침 감지.
2. **토큰 불일치도 계속 재시도** — 비용: 영영 안 붙는 PC가 8초마다 시도(서버 로그에 경고 반복). 해소: N회 뒤 멈춤.
3. **「접속 끊기」·제외가 저장돼 재시작 후에도 끊김** — 비용: 잊으면 다음 날 안 붙음(화면엔 보임). 해소: 시작 시 자동 재접속 옵션.
4. **실행 중 문구 = 시나리오 이름 + #끝6자**(라벨이 와이어에 없음) — 비용: 같은 시나리오 run끼리 라벨로 구분 못 함. 해소: `RunAssignment`에 라벨 필드.
5. **부하기로 바꿀 때 활성 run 0개여도 확인 창**(대상 확인·멈추는 것 고지) — 비용: 클릭 1회. 해소: 없음(대상 확인은 보안상 유지).
6. **한 부하기 중단 = run 전체 중단**(사용자, R8) — 비용: 부하기 한 대 문제로 긴 테스트가 통째로 끝난다. 해소: §6 「남은 부하기로 계속」.
7. **수락 뒤 15초 유예** — 비용: 서버가 진짜 죽어도 15초간 「연결됨」으로 보인다. 해소: 유예 단축·「확인 중」 보조 문구.

## 6. 연기 (조건과 함께)

- **남은 부하기로 계속**(사용자 원래 생각) — 이 슬라이스 뒤 후보. 갑작스런 죽음(`worker_disconnected` fail-fast)과 정상 이탈 둘 다 바꾸고, 리포트에 "중간에 부하 줄어듦" 표시가 따라온다(설정과 다른 부하 = 설명 의무).
- 같은 망 자동 찾기 — 사용자가 다음 후보로 지목할 때.
- 접속 시 앱 버전 일치 확인 — 버전 불일치 사고가 보고될 때(지금은 `protocol` 문구로 암시).
- 서버에서 코드 폐기·재발급 — 토큰 재발급과 함께.

## 7. 구현 순서 (plan에 대한 요구)

**2a plan**: ① R3 사유 상수(`handicap-proto`) + 컨트롤러 등록 직후 Ping(테스트 먼저) ② R8 aborted fan-out(테스트 먼저) ③ worker-core 배정 전 Abort 사유 보존(`Display` 불변 잠금) ④ worker-core 사건·이유 분류·사건 → 상태(유예 포함) ⑤ worker-core 탐침 + 새 연결 루프 ⑥ worker lib 새 풀 진입점(사건 통로 + `execute_assignment` 재사용) ⑦ 통합 테스트(in-process 풀) ⑧ 라이브 R8(CLI 부하기 2개) ⑨ 문서(build-log·§B·worker-core CLAUDE.md 함정).

**2b plan**(2a 머지 뒤): ① 세 인스턴스 스파이크(STOP 조건 — 안 되면 라이브 절 수정, 사용자 확인) ② desktop-core 코드·`install_id`·설정 ③ 셸 상태 구조(컨트롤러 없는 역할) ④ 설치 ID(서버 「이 PC도 부하 내기」 포함) ⑤ 부하기 역할 전환·끊기·다시 접속·시작·종료 + IPC ⑥ `role.html` ⑦ `ko.ts` 제외 문구 ⑧ 문서(`docs/dev/lan-workers.md`·`desktop/CLAUDE.md`·ADR-0058·§B·릴리즈 노트 줄).

## 8. 문서

- ADR-0058(2b에서): 데스크톱 부하기 모드 — 접속 코드(복사 전용·검사값)·설치 ID·in-process 워커 + worker-core 상태 통로.
- 릴리즈 노트 줄: (2a) "실행 중 부하기 한 대를 멈추면(Ctrl+C·SIGTERM·K8s Pod 퇴출 포함) 다른 부하기도 함께 멈추고 그 사유가 run 기록(API·인쇄 보고서)에 남습니다(이전엔 run은 중단으로 표시되는데 다른 부하기가 끝까지 부하를 냈습니다). 또 풀 모드가 아닌 컨트롤러는 풀 부하기 등록을 「controller is not in pool mode」로 거절합니다(이전엔 배정받지 못한 채 기다렸습니다)." — 실행 화면은 `aborted` run의 사유를 아직 보여 주지 않는다(`RunDetailPage`는 `failed`만) — 2b plan이 넣는다(roadmap §B). (2b) "부하기 PC도 앱 「모드 전환」 → 「부하기로 접속」에 서버 화면의 접속 코드를 붙여넣으면 합류합니다. 부하기 ID는 설치마다 하나라 PC 이름이 같아도 따로 보입니다."
