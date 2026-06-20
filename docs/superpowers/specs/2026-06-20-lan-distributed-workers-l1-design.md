# LAN 분산 워커 L1 — 상시 워커 풀(백엔드 제어판) (roadmap ADR-0039 후속 §관련검토·LAN 분산)

> **이 파일은 spec이다.** normative 척추는 **§2 요구사항 표(R-id)** — plan·구현·리뷰가 전부 이 ID를 참조한다.

- **날짜**: 2026-06-20
- **상태**: 설계 초안 → spec-plan-reviewer 2차 대기 (1차 NEEDS-REWORK 반영)
- **출처**: roadmap 현재상태 "LAN 분산 워커"(ADR-0039 §관련검토의 격차 3 = 바인딩·오케스트레이션·보안). **왜 지금**: 데스크톱 셸(ADR-0040)이 막 끝나 "라이트 데스크톱"이 단일 PC를 넘어 여러 LAN PC로 확장될 자연스러운 다음 수. 사용자 결정(2026-06-20): 상시 풀(수동 실행, 자동기동 후속) + 공유 토큰 + use-all 매칭 + **L1 백엔드만**.
- **연관**: ADR-0010(gRPC pull/등록), ADR-0019(dispatcher 추상화), ADR-0027(멀티워커 fan-out·shard_split·fail-fast·메트릭 머지), ADR-0038(open-loop fan-out·`reduce_open_loop_profile`), ADR-0039(LAN feasibility 기록), ADR-0012(워커 HDR 메트릭).
- **ADR**: **ADR-0041 신규** — 세 번째 워커 모드(`pool`) + 상시 워커 풀 제어판(pull→push 배정) + 채널 공유 토큰 인증은 ADR-0019(2 모드)·ADR-0010(per-run register)을 *확장*하는 새 제어판 결정이라 기록이 필요하다(재아키텍처 아님 — fan-out 기계장치 재사용).

---

## 1. 문제와 목표

오늘 워커는 **run마다 dispatcher가 spawn하며 시작 시 `--run-id`를 박는다**(subprocess N-spawn / K8s Indexed Job). 워커 register는 그 run_id로 이뤄지고(`coordinator.rs:201` `register`, 빈/미존재 run_id는 `NoRun`으로 거부), 워커는 한 run을 돌고 종료한다(`worker/lib.rs::run`은 단발). 따라서 **다른 PC에서 수동으로 띄운 워커가 컨트롤러에 붙어 '대기'하다 run에 배정**되는 길이 없다 — LAN 분산의 핵심 격차(ADR-0039 격차②). 더해 채널은 평문 h2c·인증 0(격차③), gRPC 기본 바인드는 `127.0.0.1`(격차①).

이 슬라이스(L1, 백엔드 전용)는 **상시 워커 풀 제어판**을 만든다: 워커가 `--run-id` 없이 컨트롤러에 붙어 유휴 풀에 등록하고, run 발사 시 컨트롤러가 **연결된 유휴 워커**(부하 단위로 cap)에 샤드를 push 배정해 기존 fan-out 기계장치(shard_split·메트릭 머지·`dropped` 합산·fail-fast)로 실행한다. 채널엔 선택적 공유 토큰 인증을 붙인다.

- **목표**: ① 워커 `pool` 모드(유휴 등록·배정 대기·실행·재사용) ② 컨트롤러 풀 레지스트리 + `pool` 발사 경로(use-all N·push 배정) ③ 공유 토큰 인증 ④ LAN 바인드 + 런북. **localhost에 워커 2개를 풀 모드로 띄워 curl/CLI로 end-to-end 검증 가능.**
- **비목표(연기)**: §7. UI 워커 대시보드(L2)·mTLS·RemoteDispatcher 자동기동·best-effort/degraded·persistent-stream 재사용(L1은 reconnect-per-run)·hostname/영속 worker_id(L2 가독성)·closed-loop 과부하 가드·번들 LAN 토글.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> MUST/SHOULD는 전부 여기 행으로. 산문(§3·§4)은 근거·방법만. **흘리기 쉬운 불변식/byte-identical/fallback/lifecycle을 특히 R로.**

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` 워커가 `--run-id` 생략 시 **풀 모드**로 동작: 연결→`Register`(빈 run_id)→유휴 등록→`RunAssignment` 대기→기존 엔진 경로로 실행→종료 후 **재연결해 다시 유휴**(reconnect-per-run; 매 run = 새 스트림·새 idle 등록). | 통합 `pool_worker_runs_then_reuses`(워커 1개가 연속 2 run 처리) / 라이브: 풀 워커가 run 완료 후 재등록 | |
| R2 | `MUST` proto `Register`에 `string token = 4` **가산**(additive). 워커가 채워 보내고(유일 리터럴 `client.rs:98`) 컨트롤러가 읽는다. | proto 빌드 + `cargo build --workspace`; 빈 토큰 = 미설정 컨트롤러서 wire byte-identical | ✅ proto wire (worker↔controller) |
| R3 | `MUST` 컨트롤러 `--worker-token <key>`(기본 None=인증 없음). 설정 시 `Register.token` **불일치는 거부**(풀·legacy per-run register 양쪽; 미설정이면 모든 토큰 수용=현행). 비교는 단순 `==`(L1 채널이 평문이라 타이밍 무의미 — constant-time은 mTLS 슬라이스와 함께, §3.6). | 단위 `token_mismatch_rejected`/`token_unset_accepts_any` / 라이브: 틀린 토큰 워커 풀 미진입 | |
| R4 | `MUST` 컨트롤러 `--worker-mode pool`(기존 enum에 변종 추가) 선택 시 run 발사 N = **min(유휴 풀 크기, 부하상한)**(use-all; 부하상한 = vu-curve:1 / open:`min(max_in_flight, 고정 target_rps · 곡선 max(stage.target))` / closed:`vus` — 모든 워커 ≥1 슬롯·≥1 rps/VU 보장). `subprocess`/`kubernetes` 무변경. | 단위 `pool_n_is_min_idle_and_load`(유휴 3·VU 2→N=2) / 라이브: 워커 2·VU≥2 = 샤드 2 | |
| R5 | `MUST` `CoordinatorState`에 **풀 레지스트리**(worker_id→`PoolEntry{tx, capacity, assigned_run: Option<run_id>}`): `pool_register_idle`는 **멱등**(재연결 시 tx 교체 **+ `assigned_run=None` 리셋**), 스트림 종료 시 엔트리 제거. | 단위 `pool_register_idempotent_resets_assigned`/`pool_disconnect_removes` | |
| R6 | `MUST` 풀 run 발사 순서: **유휴 워커 N개 예약**(reserve가 풀-락 안에서 `assigned_run=Some(run_id)`로 마킹=예약 락, R13) → `enqueue(expected=N)`(RunWorkers 선존재) → 예약 워커마다 `register()`+`assignment_for()`+tx push+`stream_dataset()`+`set_status(Running)`(첫 워커) 재구성. closed=VU N분할·open=레이트/슬롯 N분할(기존 `shard_split`/`reduce_open_loop_profile`, N≤부하상한이라 모든 워커 ≥1 슬롯·≥1 rps(open)/≥1 VU(closed)). | 단위 `pool_launch_assigns_shards`(N=2 샤드 0/1·open 레이트 분할) / 라이브 메트릭 머지 | |
| R7 | `MUST` 풀 모드 + **유휴 0** = run 즉시 **fail-fast**(명시 메시지 "연결된 LAN 워커 없음", `mark_failed`+`cancel_dispatch_failed`). 배정 push 중 `tx` 닫힘(워커 이탈) = **그 자리에서 즉시** `cancel_dispatch_failed`(60s watchdog 비의존). 영영 running 금지. | 단위 `pool_empty_fails_fast`/`pool_push_to_dead_tx_fails_fast` / 라이브: 워커 0서 run→failed+메시지 | |
| R8 | `MUST` Busy 풀 워커의 스트림 종료는 `PoolEntry.assigned_run`을 통해 기존 `worker_disconnected(run_id, worker_id)` fail-fast로 라우팅. **terminal-phase 보존 가드 유지**(coordinator.rs:429-440) + **불변식: 워커의 terminal `RunStatus`(→`record_phase`)는 같은 연결의 스트림-종료 `pool_disconnect`보다 먼저 처리**(같은 스트림, RunStatus가 drop(tx) 전 송신)되어 정상 종료가 fail-fast로 오탐되지 않음. | 단위 `pool_busy_disconnect_fails_run`/`pool_completed_then_close_no_fail` | |
| R9 | `MUST` 메트릭 머지(A3b worker_id PK)·`dropped` 합산·shard_split·fail-fast 종료집계·`record_phase`/`ingest`(메시지 run_id 키)를 **그대로 재사용** — 풀 run의 N워커 레이턴시/카운트가 dispatcher-spawn run과 동일 경로. | 라이브: 2워커 풀 run 리포트 `ReportSchema` 통과·count/p50 머지 정확 | |
| R10 | `MUST`(불변식) **byte-identical (조건부)**: `--worker-mode subprocess`(기본)·**`--worker-token` 미설정**·`--run-id` 명시 legacy 워커·비-풀 run = pre-slice 동작. (토큰 설정 시 legacy register 핸들러 arm에 토큰 검사 1개 선행 — 미설정이면 skip이라 byte-identical.) proto는 additive(`Register.token` 기본 빈), **migration 0**(풀은 인메모리). | 기존 controller/worker/engine 스위트 green(무수정·토큰 미설정)·`finalize_*`·`register_*` 단위 무수정 | ✅ proto additive |
| R11 | `MUST` gRPC를 LAN 도달가능하게 = 운영자가 **기존 `--grpc 0.0.0.0:8081`로 기본(`127.0.0.1`) 오버라이드**(코드 0). 런북(`docs/dev/lan-workers.md`)이 바인드 오버라이드·Windows 방화벽·워커 기동·토큰·use-all·**closed-loop 과부하 미가드 경고**·`vus`의 이중 의미(총부하+워커 상한)·단일PC 한도·평문(mTLS 후속)을 문서화. | 런북 존재 + 라이브를 `--grpc 127.0.0.1`(localhost 풀, 같은 머신)로 재현 | |
| R12 | `SHOULD` 풀 워커 `worker_id` 기본값 = **프로세스 시작 시 1회 생성한 랜덤 id**(ULID; 프로세스 수명 내 재연결에 안정·머신/프로세스 간 유일). `--worker-id` override 최우선. 워커 크레이트에 `ulid = { workspace = true }` 1개 추가(이미 워크스페이스 dep·MSRV-safe). hostname/영속은 L2 UI 가독성으로 연기. | 단위 `pool_worker_id_stable_within_process`/`pool_worker_id_explicit_override` | |
| R13 | `MUST`(lifecycle) `assigned_run`은 **reserve 시** `Some(run_id)`(예약 락=동시 발사 중복예약 차단, 풀-락 원자적), `pool_register_idle`(재연결 포함) 시 `None`(R5). 배정 실패/abort 워커는 abort→스트림종료→`pool_disconnect`→재연결→재등록(None)으로 자가복구. reconnect-per-run 재사용 = run 종료 후 워커가 **새 스트림으로 재등록**(fresh idle, `assigned_run=None`)이라 `reserve_idle_pool`이 재사용 워커를 유휴로 본다(재사용 정확성 블로커 해소). | 단위 `pool_reused_worker_is_idle_after_reconnect` | |
| R14 | `MUST` 풀 모드 신호·토큰을 **`CoordinatorState`에 setter로 보관**(`set_worker_token`·`set_pool_mode`, 기존 `set_dispatcher` 패턴, startup 1회) → `spawn_run`은 `state.coord` 경유로 읽음. **`AppState` 구조체 리터럴 무변경**(~20 테스트 파일 exhaustive churn 회피). | 단위 `coord_pool_mode_setter` + 기존 `AppState{…}` 리터럴 grep 0 변경 | |

- **`seam?`** — 유일한 와이어 변경은 R2(proto `Register.token` additive). DB/migration·UI 없음(R10·§5). R2는 plan에서 proto-먼저 task, 최종 리뷰가 worker 송신↔controller 수신 1:1 대조.

---

## 3. 핵심 통찰 (설계 근거)

1. **풀 워커의 '유휴 대기'는 `connect_and_register`의 `inbound.next().await`(`client.rs:109`)다.** 워커는 `run()`→`connect_with_backoff`(`lib.rs:88`→`reconnect.rs`)→`connect_and_register`로 들어가 Register 송신 후 **첫 `RunAssignment`를 블록 대기**한다(이 지점은 `forward_inbound` 스폰 *이전*, `client.rs:126`). 풀 모드는 컨트롤러가 빈-run_id Register를 풀에 넣고 배정을 *나중에* push할 때 이 대기가 풀린다 — 즉 늦은 assignment가 첫 inbound 메시지라 line 109가 정확히 깨어난다(FR1 검증). **단 line 109엔 cancel이 없다**(`connect_and_register`는 cancel 인자 없음; 현 cancel-awareness는 `retry_with_backoff`의 *backoff sleep*에만 있음). 따라서 R1의 "SIGTERM이 유휴 대기를 깨고 clean exit"는 **`connect_and_register`에 `CancellationToken`을 추가해 line 109를 `tokio::select!`로 감싸는 실 시그니처 변경**을 요한다(legacy 경로 `connect_with_backoff`의 `attempt_fn` 클로저 캡처 재컴파일 확인 필요). [R1·R14의 진짜 비용]

2. **컨트롤러 `register()`는 순수 상태변이라 풀 발사가 호출할 수 있으나, 그 뒤 배정 I/O 시퀀스는 핸들러에 *인라인*이라 재구성해야 한다.** `register()`(coordinator.rs:201-244, shard 배정+`RunWorkers` 삽입, I/O 없음) 자체는 재사용 가능하지만, 라이브 경로에서 그 직후 `assignment_for()`+`tx.send(Assignment)`+`set_status(Running)`+`stream_dataset()`(coordinator.rs:689-731)가 따라온다 — 이건 핸들러 `Register` arm 안에 인라인이지 함수가 아니다. `assign_pool_workers`는 이 시퀀스를 **발사 사이트에서 재구성**한다(하위 함수 `assignment_for`/`stream_dataset`는 재사용, 오케스트레이션은 net-new). 즉 "register→shard의 *주도권*을 push로 뒤집고, 분배·레이트분할·메트릭머지·fail-fast 로직은 재사용"이되 배선은 신규. [R6 재사용 정도의 정직한 범위]

3. **disconnect fail-fast는 풀이 worker→run을 보유해 라우팅**. 핸들러의 연결-로컬 `run_id`는 Register에서 오는데(coordinator.rs:636-649) 풀 워커는 빈 run_id라 로컬 run_id가 없다. `PoolEntry.assigned_run`을 두고(push 성공 시 set, R6/R13) 스트림 종료 시 풀이 그 run_id로 기존 `worker_disconnected`를 호출한다 — `record_phase`/`ingest`가 *메시지* run_id로 키잉하므로(coordinator.rs:739-743·850) 라우팅이 구조적으로 옳고, **terminal-phase 보존 가드**(coordinator.rs:429-440)가 reconnect-per-run의 정상 "run 끝→스트림 닫힘"을 오탐하지 않는다 — *단 워커의 terminal `RunStatus`가 같은 연결의 스트림-종료보다 먼저 처리된다는 불변식*에 의존(같은 스트림, RunStatus가 `drop(tx)`(lib.rs:439-453) 전 송신 → 핸들러가 close 전 처리). [R8 안전성 불변식]

4. **use-all 매칭은 부하상한으로 cap**(R4): N=min(유휴, {vu-curve:1 / open:min(max_in_flight, 고정 target_rps·곡선 max(stage.target)) / closed:vus}). 풀이 부하 단위보다 크면(예: 3워커·2VU) 초과 워커가 `shard_split`에서 0-share를 받아 무의미하다 — 슬롯뿐 아니라 **레이트도 cap에 포함**(open은 `max_in_flight`와 `target_rps`를 둘 다 봐서, `target_rps<N`이면 일부 워커가 슬롯은 받고 rps=0인 무의미 상태를 막는다). cap이 그 0-share 분기 자체를 비활성화한다(버그 수정이 아니라 미진입). **반대로 cap은 과부하를 막지 않는다** — closed 1000VU를 유휴 2워커에 돌리면 각 PC `capacity_vus` 무관하게 500VU씩(over-load). closed-loop 과부하 가드는 §7 연기라 L1은 런북 경고로만(R11). 발사 시 N을 **원자적 스냅샷+예약**(reserve가 풀-락 안에서 `assigned_run=Some(run_id)`로 마킹 → 동시 발사가 같은 워커를 중복 예약 못 함)해 `enqueue(expected=N)`과 실제 배정이 일치한다(R6). reserve~enqueue 사이 워커 이탈 시 `pool_disconnect`가 미-enqueue run에 `worker_disconnected`를 호출하지만 `runs.get=None`으로 무해 early-return(FR5). [R4·R6·R11 정합]

5. **reconnect-per-run(L1) vs persistent-stream(연기)**: L1은 워커가 run 종료 후 스트림을 닫고 재연결해 다시 유휴 등록한다(기존 단발 `run()` 본체 추출 재사용 = 최소 위험). 비용 = run 사이 sub-second 재연결 갭(그 순간 발사된 run은 그 워커 미사용). 운영자가 run을 순차 발사하는 L1 패턴에 무해. 한 스트림으로 N run 무재연결(persistent-stream)은 `run()` 루프 리팩터 + 컨트롤러 finalize-시-유휴복귀가 필요한 **L2 견고성 업그레이드**(§7). 재사용 정확성은 R13이 보장(재등록=fresh idle). [R1·R13 모델 선택]

6. **공유 토큰은 *접근 통제*이지 기밀성이 아니다**(R3): 토큰은 평문 와이어에 노출되나 *임의 머신의 풀 합류·run 탈취*(시나리오 YAML+해석된 env 수신)를 막는 값싼 통제. 평문에서 constant-time 비교는 theater(타이밍을 잴 수 있으면 토큰을 스니핑할 수 있음)라 L1은 단순 `==`; constant-time은 채널 암호화(mTLS, §7)와 함께 의미를 가진다. 미설정 시 현행과 동일(신뢰 LAN 기본). [R3 스코프·M2 해소]

---

## 4. 변경 상세

> 파일·함수 단위. 각 묶음 머리에 **충족 R**.

### 4.1 `crates/proto/proto/coordinator.proto` — 충족 R: R2, R10
- `Register`에 `string token = 4;` 추가(additive — field 1~3 무변경, 기존 워커는 빈 문자열 송신과 동치).

### 4.2 `crates/worker/src/lib.rs` + `worker-core/src/{client.rs,reconnect.rs}` — 충족 R: R1, R3, R12
- `WorkerArgs.run_id: String` → `Option<String>`(None/생략 = 풀 모드), `token: Option<String>` 추가.
- `run()`의 run 실행 본체(`assignment` 수신~종료, 현 lib.rs:115-456)를 `execute_assignment(link, run_id, cancel, …)`로 추출(동작 무변경).
- 신규 `run_pool(args)`: `loop { connect_with_backoff(…, token, cancel)로 유휴 등록·assignment 대기 → 수신 시 execute_assignment → 종료 후 재연결; cancel(SIGTERM)이면 break }`. `run_id` 있으면(legacy) 기존 단발 `run()` 유지.
- **라우팅(branch site)**: 신규 top-level `run_dispatch(args)`가 `args.run_id.is_none() ? run_pool(args) : run(args)`로 분기. 워커 bin(`worker/src/main.rs:16`, 현재 `run()` 직접 호출)과 번들 멀티콜 arm(`controller/src/main.rs:104`)이 `run` 대신 `run_dispatch` 호출.
- **cancel-aware 유휴 대기**(§3.1): `connect_and_register`에 `cancel: CancellationToken` 인자 추가 → line 109 `inbound.next()`를 `tokio::select!{ _ = cancel.cancelled() => Err(Cancelled), m = inbound.next() => … }`로 감싼다. `connect_with_backoff`/`retry_with_backoff`의 `attempt_fn` 클로저가 `cancel`을 캡처하도록 시그니처 갱신(legacy 경로 재컴파일 확인). `token`은 `Register.token`에 실음.
- `resolve_worker_id`: 풀 모드 기본값 = **프로세스 시작 시 1회 생성한 ULID**(`--worker-id` 미지정 시; 프로세스 수명 내 모든 재연결에 동일 값 재사용). `--worker-id` 명시가 최우선. legacy `JOB_COMPLETION_INDEX` 파생은 비-풀 경로에 유지. **`crates/worker/Cargo.toml`에 `ulid = { workspace = true }` 1개 추가**(이미 워크스페이스 dep — controller/engine이 사용; hostname/dirs는 불요·미사용, L2 연기).

### 4.3 `crates/controller/src/grpc/coordinator.rs` — 충족 R: R3, R5, R6, R7, R8, R13, R14
- `CoordinatorState`에 `pool: Arc<Mutex<HashMap<String, PoolEntry>>>`·`worker_token: Arc<OnceLock<String>>`(or `Option`)·`pool_mode: bool`(또는 `OnceLock`). **setter** `set_worker_token`/`set_pool_mode`(기존 `set_dispatcher` 패턴, startup 1회 — `AppState` 리터럴 churn 0, R14).
- 풀 메서드: `pool_register_idle(worker_id, tx, capacity)`(멱등 insert/replace, **`assigned_run=None` 리셋** R13)·`reserve_idle_pool(run_id, cap) -> Vec<(worker_id, tx)>`(원자적 풀-락: idle[`assigned_run=None`] 중 min(유휴,cap)개를 **`assigned_run=Some(run_id)`로 마킹[예약 락]** 후 반환 — 동시 발사 중복예약 차단)·`assign_pool_workers(run_id, reserved)`(예약마다 `register()`+`assignment_for()`+tx push+`stream_dataset()`+첫워커 `set_status(Running)`; `assigned_run`은 reserve가 이미 Some; **tx send 실패→즉시 `cancel_dispatch_failed`+Err** R7)·`pool_disconnect(worker_id)`(엔트리 제거; `assigned_run`이 Some면 기존 `worker_disconnected(run_id, worker_id)` 호출 R8).
- `channel` 핸들러 분기: 첫 메시지가 `Register` → **토큰 검사**(설정 시 불일치는 AbortRun+break, R3). `run_id` 빈 문자열 → **풀 경로**(`pool_register_idle`, 로컬 `pool_mode_conn=true`, 로컬 run_id 미설정, 배정 안 함 — 루프로 fall through). 비어있지 않음 → 기존 legacy register(토큰 검사만 선행 추가). 스트림 종료 시 `pool_mode_conn ? pool_disconnect(worker_id) : worker_disconnected(run_id, worker_id)`.
- `MetricBatch`/`RunStatus`/`Pong` arm 무변경(메시지 run_id로 라우팅).

### 4.4 `crates/controller/src/api/runs.rs::spawn_run` — 충족 R: R4, R6, R7, R14
- `state.coord` 경유로 `pool_mode` 판정(R14). **풀 모드**: 부하상한 `n_cap` = vu-curve:1 / open:`min(max_in_flight, 고정 target_rps | 곡선 max(stage.target))` / closed:`vus` (E2: 슬롯·레이트 둘 다 cap해 모든 워커 ≥1 rps) → `reserve_idle_pool(row.id, n_cap)` → 예약 N=len. N==0 → `cancel_dispatch_failed`+`mark_failed("연결된 LAN 워커가 없습니다 …")`+Err(기존 dispatch-실패 형태 재사용). `total_vus`는 기존식 유지(closed=`vus`·open=`max_in_flight`·vu-curve=`vu_curve_max`). **순서: insert → reserve → enqueue(N, total_vus) → `assign_pool_workers`**(enqueue가 reserve 뒤·assign 앞이라 RunWorkers가 push 전 존재 — FR5). `dispatcher.dispatch` **미호출**(배정은 `assign_pool_workers`).
- 비-풀 모드(subprocess/k8s)는 현행 경로 그대로(N=capacity/worker_count, `dispatcher.dispatch`). **closed-loop 풀 run의 `vus`는 총부하이자 워커 상한**(N=min(idle, vus)) — 런북 문서화(R11).

### 4.5 `crates/controller/src/main.rs` + `dispatcher/mod.rs` — 충족 R: R3, R4, R10, R11, R14
- `WorkerMode` enum(현 `Subprocess`/`Kubernetes`, main.rs:17-21)에 `Pool` 추가. `--worker-token <key>: Option<String>` arg(기본 None). `pool` 선택 시: dispatcher=`NoopDispatcher`(배정은 `assign_pool_workers`가 수행하므로 dispatch no-op이 정확) + `coord.set_pool_mode(true)` + `coord.set_worker_token(token)`. 비-풀은 토큰 setter만(있으면) + 현행.
- `--grpc` 무변경 — **기본 `127.0.0.1:8081`**(F3). LAN은 운영자가 `--grpc 0.0.0.0:8081`로 오버라이드(런북 R11). 토큰/풀 미설정 = byte-identical(R10).

### 4.6 `docs/dev/lan-workers.md` (신규) — 충족 R: R11
- 컨트롤러 기동(`--worker-mode pool --grpc 0.0.0.0:8081 --worker-token <key>`)·Windows 인바운드 방화벽·각 PC 워커 기동(`worker --controller http://<ip>:8081 --token <key>`, `--run-id` 없이)·use-all+부하상한 cap·빈 풀 동작·**closed `vus`=총부하&워커상한 + 과부하 미가드 경고**·단일PC 한도·평문(mTLS 후속).

---

## 5. 무변경 / 불변식 (명시)

- **엔진(`crates/engine`)·migration·DB 스키마·리포트 빌드·CSV/XLSX/비교·UI 전부 무변경.** 풀 레지스트리는 **인메모리**(연결 워커=휘발성) → **migration 0**.
- proto는 **additive만**(`Register.token = 4`); 기존 message/field 무변경.
- **byte-identical (조건부, R10)**: `--worker-mode subprocess`(기본) **AND `--worker-token` 미설정**이면 pre-slice 동작과 동일. (토큰 설정 시 register 핸들러 arm에 검사 1개 선행 — 미설정 skip이라 와이어/동작 불변.) `register()`/`assignment_for`/`record_phase`/`worker_disconnected`/`reduce_open_loop_profile`/메트릭 머지 **함수 무수정**; 핸들러 `Register` arm만 분기 추가.
- `dispatcher.dispatch`/`cleanup` 시그니처 무변경(ADR-0019 trait 유지) — 풀은 `assign_pool_workers`로 우회, `NoopDispatcher` 재사용.
- `AppState` 구조체 리터럴 무변경(풀 신호는 `CoordinatorState` setter, R14).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `pool_worker_runs_then_reuses`(워커 1 연속 2 run; **신규 e2e 하네스** — 수동 spawn·`--run-id` 생략·`NoopDispatcher`·2 run 수명, §8 주의) | ✅ |
| R2 | proto 빌드 + worker↔controller 송수신 round-trip; 빈 토큰 byte-identical | |
| R3 | `token_mismatch_rejected`/`token_unset_accepts_any` | ✅ |
| R4 | `pool_n_is_min_idle_and_load`(유휴 3·VU 2→N=2) | ✅ |
| R5 | `pool_register_idempotent_resets_assigned`/`pool_disconnect_removes` | |
| R6 | `pool_launch_assigns_shards`(N=2 샤드 0/1·open 레이트 분할) | ✅ |
| R7 | `pool_empty_fails_fast`/`pool_push_to_dead_tx_fails_fast` | ✅ |
| R8 | `pool_busy_disconnect_fails_run`/`pool_completed_then_close_no_fail` | |
| R9 | 라이브 2워커 풀 run 리포트 `ReportSchema` + count/p50 머지 정확 | ✅ |
| R10 | 기존 controller/worker/engine 스위트 green(무수정·토큰 미설정) | |
| R11 | 런북 존재 + 라이브를 localhost 풀로 재현 | |
| R12 | `pool_worker_id_stable_within_process`/`pool_worker_id_explicit_override` | |
| R13 | `pool_reused_worker_is_idle_after_reconnect` | ✅ |
| R14 | `coord_pool_mode_setter` + `AppState{…}` 리터럴 grep 0 변경 | |

- **라이브 검증 필수**(`/live-verify`): run-생성·배정·메트릭 머지 경로 변경. **localhost 풀 스택** = 컨트롤러 `--worker-mode pool --grpc 127.0.0.1:8081 --worker-token X` + `worker --controller http://127.0.0.1:8081 --token X`(`--run-id` 없이) ×2 유휴 → curl `POST /api/runs` → ① use-all(워커 2=샤드 2) ② 토큰 거부 ③ 빈 풀 fail-fast ④ 연속 2 run 재사용 ⑤ 리포트 `ReportSchema` 머지(S-D 갭 차단). **cold-build 워커 race(CLAUDE.md S-A) 주의** — 장시간 2-run 테스트 전 `cargo build -p handicap-worker` 워밍.

---

## 7. 의도적 연기 (roadmap §LAN 분산에 누적)

- **L2 — UI**: 연결 워커 대시보드(유휴/Busy·worker_id·capacity) + RunDialog 풀 통합("워커 N대 사용"). L1은 백엔드 전용·curl/CLI 검증.
- **hostname/영속 worker_id**: L1은 프로세스-수명 랜덤 ULID(워커에 `ulid` dep 1개). 사람이 읽기 좋은 `{hostname}-{영속 suffix}`(재시작 간 안정·UI 표시용)는 **L2**(워커에 hostname+`dirs` dep 추가 동반).
- **L3 — mTLS**(tonic+rustls 채널 암호화+인증서, constant-time 토큰 비교 동반) · **RemoteDispatcher**(SSH/WinRM/에이전트 자동기동 — 풀 워커를 원격에서 켜는 레이어, 이 설계가 seam) · **best-effort/degraded**(샤드 일부 실패 시 잔여 지속, 현재 fail-fast) · per-worker 리소스 한도 · 번들 LAN 토글.
- **persistent-stream 워커 재사용**: L1 reconnect-per-run의 run-사이 갭 제거(한 스트림 N run). `run()` 루프 리팩터+finalize-시-유휴복귀 → L2 견고성(§3.5).
- **closed-loop 과부하 가드**: use-all에서 `vus/N > 워커 capacity`면 경고(인사이트). L1은 런북 경고만(R11).
- **풀 관측/하트비트**: idle keep-alive Ping·stale TTL·풀 용량 합산. L1은 스트림 종료=제거로 충분.

---

## 8. 구현 순서 (plan 입력)

> cargo-영향 커밋마다 전체 워크스페이스 게이트 → 미사용 헬퍼/RED-only 단독 커밋 불가. **green fold** 지점 명시. 와이어(R2)는 worker 송신+controller 수신이 **한 커밋**(한쪽만 머지 = 드리프트). **Phase 1(토큰/인증/바인드/런북)은 push-inversion과 독립이라 먼저 green 커밋 가능 — 리뷰어 권고대로 위험 격리**(원하면 별도 머지 웨이브).

1. **proto + 토큰 인증 + 바인드/런북** (R2·R3·R10·R11·F3): `Register.token` 추가 → 워커 송신(`connect_and_register` token 인자) + 컨트롤러 검사(`set_worker_token`·`--worker-token`) 한 green 커밋. 토큰 미설정 byte-identical 단위. 런북 초안(바인드 오버라이드·방화벽). **(push-inversion 없이 독립 green.)**
2. **풀 레지스트리 + 연결 핸들러 분기 + lifecycle** (R5·R8·R13·R14): `CoordinatorState.pool`·`pool_mode`/`worker_token` setter·풀 메서드·`channel` 빈-run_id 분기·`pool_disconnect` 라우팅·`assigned_run` lifecycle. 단위(멱등 리셋·disconnect fail-fast·terminal 보존·재사용 idle).
3. **풀 발사 배정** (R4·R6·R7): `reserve_idle_pool`/`assign_pool_workers`·`spawn_run` 풀 N 분기(순서 insert→reserve→enqueue→assign)·빈 풀/dead-tx fail-fast. 단위(N=min·샤드 0/1·빈 풀·dead tx).
4. **워커 풀 모드** (R1·R12): `WorkerArgs` optional run_id+token·`execute_assignment` 추출·`run_pool` 루프·**cancel-aware `connect_and_register`**(legacy 클로저 재컴파일 확인)·프로세스-수명 worker_id. `--worker-mode pool`+`NoopDispatcher`+`set_pool_mode` 와이어. 신규 e2e 하네스(R1)·worker_id 단위.
5. **라이브 검증**(§6 localhost 풀 5종, 워커 워밍) → 런북 마무리 → finish.
