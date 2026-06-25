# 컨트롤러 in-process 백엔드 lib + 견고 워커 teardown (ADR-0040 접근 2, 슬라이스 1/2)

- 날짜: 2026-06-26
- 상태: 설계 (구현 전)
- 관련: [ADR-0040](../../adr/0040-tauri-desktop-wrapper.md)(사이드카 셸·R7 backend 경계), [ADR-0039](../../adr/0039-windows-desktop-distribution.md)(옵션 A 단일 exe·LAN feasibility), [ADR-0019](../../adr/0019-worker-dispatcher-abstraction.md)(dispatcher 추상), [ADR-0016](../../adr/0016-vu-execution-model.md)(VU=워커 프로세스 tokio task), `desktop/CLAUDE.md`, `crates/controller/CLAUDE.md`, `crates/worker-core/CLAUDE.md`
- **이 spec = 슬라이스 1** (백엔드: 컨트롤러 in-process lib 추출 + graceful shutdown + 크로스플랫폼 워커 크래시 백스톱). **슬라이스 2**(desktop `InProcessBackend` 교체 + Windows Job + `externalBin` 제거)는 별도 후속 spec.
- 새 ADR 필요(0042 — 접근 2 채택). 슬라이스 1+2 완료 시 작성(§11).

## 1. 배경 & 동기

ADR-0040은 Tauri 데스크톱 셸을 **접근 1(사이드카)** 로 구현했다: bundle `controller` exe를 별도 *프로세스*로 spawn, stdout 로그에서 REST 포트 파싱(`parse_rest_port`), `/api/health` 폴링 후 네이티브 창을 navigate. ADR-0040 §대안·결과는 **접근 2(in-process 임베드)** 를 후속으로 예고하고 R7 `ControllerBackend{base_url(), shutdown()}` 추상을 교체 지점으로 남겼다.

접근 2는 컨트롤러를 Tauri 프로세스에 in-process로 임베드해 사이드카·로그파싱·health폴링을 제거한다. 그런데 그 작업은 (a) 컨트롤러 부트스트랩의 lib 추출 + graceful shutdown(현재 부재), (b) desktop 셸 교체, (c) **크래시-견고 워커 teardown**(사용자 채택 조건) 등 blast radius가 큰 여러 부분을 포함한다. spec-plan-reviewer 1차 검토에서 단일 슬라이스로는 4개 독립 서브시스템이 섞인다고 분할 권고를 받았고, 사용자가 **둘로 분할**을 선택했다. 이 spec은 그 중 **슬라이스 1 — 백엔드 enabler + 견고 teardown**이다.

**슬라이스 1 동기:**
- 컨트롤러 부트스트랩을 lib 함수(`run_in_process`)로 추출해 in-process 임베드를 *가능*하게 한다(슬라이스 2가 desktop에서 소비). standalone bundle `controller.exe`도 같은 함수로 통일(serve 경로 단일화).
- **크래시-견고 워커 teardown을 우리 환경에서 검증 가능한 형태로 확립** — 워커가 컨트롤러 소멸을 스스로 감지해 run을 취소(크로스플랫폼·loopback에서 거의 즉시). 이게 사용자 채택 조건의 핵심이고, Windows Job(슬라이스 2)에 의존하지 않는 1차 방어선이다.
- graceful shutdown 시그널을 부트스트랩에 배선(현재 `try_join!`로 영원히 serve — shutdown 수단 전무).

**비-목표:** desktop 셸 변경(슬라이스 2)·Windows Job(슬라이스 2)·`externalBin` 제거(슬라이스 2)·코드서명/인스톨러(연기)·LAN 오케스트레이션·부하 모델 변경(VU=워커 프로세스 tokio task, ADR-0016 무변경).

## 2. 사용자 결정 (이 설계 세션에서 확정)

1. **in-process로 진행**(접근 2). auto-discovery 대안 대비 단일 PC 페르소나 부합·위험 한정.
2. **`SidecarBackend` 완전 대체**(슬라이스 2에서). R7 `ControllerBackend` trait은 유지(LAN 전방호환).
3. **크래시-견고 워커 teardown을 명시 요구사항으로** — 정상 종료뿐 아니라 하드 크래시에서도 워커 고아가 0/bounded.
4. **teardown 견고성 = 워커 disconnect-cancel(크로스플랫폼·검증 가능)** 채택. Windows Job은 그 위 belt-and-suspenders(슬라이스 2). 근거: ① macOS에서 실측 검증 가능(Windows Job은 런북-only) ② loopback에서 거의 즉시 ③ 단일 실패점(Windows Job) 제거 ④ pool 모드 잠복 버그 동시 해소. worker-0-diff 불변식을 "워커는 disconnect-cancel만 additive, 엔진 0-diff"로 완화.
5. **둘로 분할** — 슬라이스 1(이 spec, 백엔드·cargo-gated) / 슬라이스 2(desktop·off-gate).

## 3. 요구사항 (R-번호)

### 슬라이스 1 핵심
- **R1 — in-process lib 추출.** 현재 `crates/controller/src/main.rs`의 bundle 컨트롤러 부트스트랩(bind→DB→settings→dispatcher→scheduler/heartbeat→serve)을 lib 함수 `run_in_process(cfg) -> anyhow::Result<RunningController>`로 추출한다. 전부 `#[cfg(feature="bundle")]`.
- **R2 — 실주소 동기 반환.** `run_in_process`가 REST/gRPC 리스너를 **사전바인딩**(`bind_with_fallback`)하고 실제 `SocketAddr`을 핸들로 반환한다(`rest_addr()`/`grpc_addr()`). 로그 파싱·health 폴링 불필요(슬라이스 2의 desktop이 이 주소를 직접 navigate; 슬라이스 1은 standalone exe·유닛 테스트가 소비).
- **R3 — graceful shutdown 시그널.** 부트스트랩에 broadcast 가능·idempotent·multi-consumer 취소 토큰을 배선한다. **소비자 전원**: axum `serve(...).with_graceful_shutdown` + tonic `serve_with_incoming_shutdown` + **스케줄러 루프**(main.rs:299) + **pool heartbeat 리퍼 루프**(main.rs:312). `RunningController::shutdown()` 호출 시 토큰 cancel → 전원 종료. primitive = `tokio_util::sync::CancellationToken`(controller `Cargo.toml:45` `tokio-util = { features = ["rt"] }` 이미 존재; `CancellationToken`은 `tokio-util-0.7` `sync` 모듈에 feature-gate 없이 노출 — 검증 완료, 신규 dep 0).
- **R4 — 크래시-견고 워커 teardown (계층화, 슬라이스 1이 1·2차 / 슬라이스 2가 3차):**
  - **R4a (정상 종료 — `abort_all` 헬퍼, 크로스플랫폼·graceful):** `shutdown()`이 토큰 cancel *전에* 모든 active run(status `pending`/`running`)을 abort한다 → 워커가 `Phase::Aborted`로 최종 메트릭 flush 후 클린 종료. **신규 헬퍼 필요**(기존 단건 `abort(run_id)`만 존재): active run id를 DB(`SELECT id FROM runs WHERE status IN ('pending','running')`)에서 수집 → 각각 기존 `CoordinatorState::abort(id)`(`grpc/coordinator.rs`, 워커에 gRPC `Abort` 송신) 호출. 단일 PC 데스크톱은 보통 active run ≤1. **주의:** `abort(id)`는 in-memory `runs` 엔트리가 없는 run(워커 미등록 `pending`)엔 `false`를 반환·no-op한다 — 그 케이스는 R4b(워커 self-cancel)·R4c(mark_orphans)가 덮으므로 `false`를 에러로 취급하지 말 것(`abort_all`은 abort 시도 수만 반환).
  - **R4b (하드 크래시 — 워커 disconnect-cancel, 크로스플랫폼·1차 방어·검증 가능):** 워커 `execute_assignment`의 abort_listener가 inbound 스트림이 **명시적 `Abort` 없이 닫히면**(=컨트롤러 소멸) `run_cancel`을 cancel한다 → 엔진이 `EngineError::Aborted`로 즉시 중단, 워커 프로세스 종료. loopback에선 소켓 close가 즉시라 거의 즉시 감지(keepalive 타임아웃 비의존). **레거시 `run()`·`run_pool()` 양쪽에 적용**(공유 `execute_assignment`) — pool 모드의 동일 잠복 버그(컨트롤러 사망 시 워커가 duration 완주)도 함께 해소.
  - **R4c (영속 백스톱):** 다음 기동 시 `mark_orphans_failed`(기존)가 "running" 잔류 run을 failed 마킹(부분 메트릭 보존). 무변경.
  - **R4d (Windows OS 하드닝 — belt-and-suspenders, 슬라이스 2):** Tauri가 Job Object(`KILL_ON_JOB_CLOSE`)를 만들어 **워커 자식을 Job에 배정**(self-assign 아님 — 현 사이드카가 자식을 배정하는 기존 패턴 재사용; WebView2 nested-job 충돌·self-kill 타이밍 회피). 워커 disconnect-cancel이 1차라 Job은 최악 지연(혹시 모를 감지 지연)을 즉시-kill로 덮는 보강. **이 spec 범위 밖**(슬라이스 2).
- **R5 — 비-bundle 컨트롤러 byte-identical.** 신규 심볼(`run_in_process`·`RunningController`·`InProcessConfig`·`abort_all`) 전부 `#[cfg(feature="bundle")]`. 비-bundle `main.rs`의 serve 경로(`try_join!`)는 **무수정** — graceful shutdown 배선은 bundle serve 분기에만(현 main.rs가 이미 serve future를 cfg-split하므로 그 분할을 확장). 워커 disconnect-cancel(R4b)은 `#[cfg]` 없이 항상 적용되지만 **정상 동작에선 관측 불가**(컨트롤러가 정상이면 inbound가 Abort 없이 안 닫힘) → 모든 기존 워커 테스트·동작 byte-identical, LAN 재검증으로 확인.
- **R6 — standalone bundle `controller.exe` 행동 보존.** bundle `main.rs`를 `run_in_process` 호출 + `join().await`(영원 serve)로 리팩터. 관측 가능 행동(포트 fallback·임베드 UI·워커 self-spawn·`--no-open`·browser-open·영원 serve)은 동일. 라이브 재검증 필수(LAN/fallback 아티팩트).
- **R7 — worker 멀티콜: 슬라이스 1은 기존 clap arm 유지.** standalone bundle exe는 이미 clap `Cmd::Worker(WorkerArgs)` 서브커맨드(`main.rs:37/124`)로 워커 self-spawn을 지원한다 — `run_in_process`의 `SubprocessDispatcher`도 `current_exe worker …`로 이 arm을 호출한다(§4.1). 따라서 **슬라이스 1은 이 clap arm을 그대로 유지(byte-identical), 신규 워커-가드 함수 도입 없음.** lib 함수 `run_worker_if_invoked()`(GUI init *전* argv를 봐야 하는 desktop main 전용)는 그게 실제로 필요한 **슬라이스 2에서 도입** — 이 spec 범위 밖(§10).
- **R8 — tracing 단일 init.** `run_in_process`는 전역 `tracing_subscriber::*.init()`를 **호출하지 않는다**(caller 소유, 전역 1회 충돌 방지). bundle/비-bundle `main.rs`는 기존대로 자기 init(비-bundle byte-identical). 워커 멀티콜 프로세스는 `init_worker_tracing()`(별도 프로세스).

### 보조
- **R9 — engine/proto/migration 0-diff.** DB 스키마·gRPC·엔진 무변경. 워커는 R4b disconnect-cancel만 additive(`crates/worker`·필요 시 `worker-core`).
- **R10 — LAN/fallback 아티팩트 보존.** standalone bundle `controller.exe`(ADR-0039 옵션 A) 빌드 타깃 유지 — LAN 헤드리스 워커(`controller.exe worker --controller …`)·수동 fallback. 슬라이스 2 desktop과 별개 산출물.

## 4. 아키텍처

### 4.1 신규 lib API (`crates/controller`, 전부 `#[cfg(feature="bundle")]`)

위치: 기존 bundle 헬퍼 모듈 `crates/controller/src/launch.rs`에 추가(또는 `in_process.rs` 서브모듈).

```rust
/// in-process 임베드 설정. localhost 기본값. LAN은 필드 추가로 전방호환.
pub struct InProcessConfig {
    pub db: Option<String>,            // None → dirs data_local_dir(app_data_dir)
    pub rest: SocketAddr,              // 기본 127.0.0.1:0 (OS 원자 할당)
    pub grpc: SocketAddr,              // 기본 127.0.0.1:0
    pub worker_token: Option<String>,  // LAN 공유키, None = 인증 없음
    pub scheduler_disabled: bool,      // 기본 false
    pub scheduler_timezone: String,    // 기본 "Asia/Seoul"
    pub settings_seeds: SettingsSeeds, // ↓ 8종 시드 (FR4): pool_heartbeat_interval/stale/
                                       //   keepalive, run_startup_grace/backstop_grace,
                                       //   worker_capacity_vus, dataset_max_rows, scheduler_tick.
                                       //   기본 = 현행 CLI 기본과 동일. stale≤interval clamp 보존.
    // 고정: worker_mode = Subprocess(self-exe 멀티콜), ui_dir = None(임베드 UI).
}

/// 실행 중 컨트롤러 핸들. serve/scheduler/heartbeat 태스크는 tokio::spawn이라
/// caller 런타임에서 계속 돈다(start 반환 후에도).
pub struct RunningController { /* rest_addr, grpc_addr, CancellationToken, JoinHandle 들, coord, db */ }
impl RunningController {
    pub fn rest_addr(&self) -> SocketAddr;
    pub fn grpc_addr(&self) -> SocketAddr;
    /// graceful: active run abort_all → 토큰 cancel → axum/tonic/scheduler/heartbeat 드레인.
    pub async fn shutdown(&self);
    /// serve 완료 대기. standalone bundle main이 await(토큰 미-cancel = 영원).
    pub async fn join(self);
}

/// 컨트롤러 부트스트랩 + serve 태스크 spawn + 실주소 핸들 반환.
/// tracing init·browser-open 비호출(caller 소유, R8).
pub async fn run_in_process(cfg: InProcessConfig) -> anyhow::Result<RunningController>;

/// 모든 active run(pending/running)을 abort(워커 graceful 종료 유도). R4a.
/// shutdown()이 내부 호출; 테스트용으로도 노출. `grpc/coordinator.rs::abort` 재사용.
pub async fn abort_all(coord: &CoordinatorState, db: &Db) -> anyhow::Result<usize>;
// (run_worker_if_invoked = 슬라이스 2. 슬라이스 1 standalone exe는 기존 clap Cmd::Worker arm 유지 — R7.)
```

`run_in_process` 본체 = 현 `main.rs`의 **bundle-path 부트스트랩**(대략 line 184–403 구간의 bundle 분기)을 lib로 옮긴 것: `bind_with_fallback`(rest/grpc) → `local_addr()` → DB connect/`mark_orphans_failed` → settings build(8 seeds + stale clamp) → `SubprocessDispatcher::new(current_exe, grpc_addr, db).with_leading_args(["worker"])` → scheduler+heartbeat를 **취소 토큰과 함께** spawn → axum+tonic을 **graceful-shutdown 배선과 함께** `tokio::spawn` → 핸들 반환. 단 그 구간엔 bundle/비-bundle 공유 부트스트랩(dispatcher·settings·scheduler·heartbeat, ~247–338)도 섞여 있다 — `run_in_process`는 bundle-gated라 이 공유 로직을 **재구현**하고, 비-bundle `main.rs`는 같은 로직을 인라인으로 유지한다(의도된 복제, R5 byte-identical 보존). 즉 "단일 공유 함수로 추출"이 아니라 "bundle 경로용 부트스트랩 함수 신설".

### 4.2 워커 disconnect-cancel (R4b) — `crates/worker/src/lib.rs`

현 `execute_assignment`의 abort_listener:
```rust
let abort_listener = tokio::spawn(async move {
    while let Some(msg) = inbound_rx.recv().await {
        if let Some(ServerPayload::Abort(a)) = msg.payload {
            if a.run_id == abort_run_id { cancel_for_listener.cancel(); break; }
        }
    }
    // ← 현재: 여기서 그냥 종료(컨트롤러 사망 시 cancel 안 함 = F1 버그)
});
```
변경: `while let` 루프가 **명시적 Abort 없이 종료**(inbound 채널 close = 컨트롤러 소멸)하면 `run_cancel`을 cancel. 정상 완료 경로에선 run_res 직후 `abort_listener.abort()`(line 430)가 listener를 *먼저* 죽이므로, listener가 자력으로 루프를 빠져나오는 건 컨트롤러가 inbound를 예기치 않게 닫은 경우뿐 → 오탐 없음. 레거시·pool 공유라 양쪽 robust.

### 4.3 컴포넌트 책임

| 컴포넌트 | 책임 | 변경 |
|---|---|---|
| `controller::launch::run_in_process` | bind+serve+scheduler+heartbeat spawn, shutdown 토큰, 실주소 핸들. tracing/browser 비호출. | 신규(bundle-gated) |
| `controller::launch::abort_all` | active run 전부 abort(정상종료 graceful) | 신규(bundle-gated) |
| `controller::main`(bundle) | clap `Cmd::Worker` arm 유지(R7) + 컨트롤러 경로 `run_in_process`→browser-open→`join().await` | 리팩터 |
| `controller::main`(비-bundle) | **무변경**(byte-identical) | 0-diff |
| `worker::execute_assignment` | inbound close(Abort 없음)→run_cancel cancel | additive(R4b) |
| `CoordinatorState` | (기존 `abort` 재사용) | 0-diff |

## 5. 데이터 흐름

### 5.1 기동 (슬라이스 1: standalone bundle exe 관점)
```
controller.exe (bundle)
 ├─ clap `worker` 서브커맨드? → 기존 Cmd::Worker arm → 워커 dispatch → exit (R7, byte-identical)
 └─ main: tracing init(자기) → run_in_process(cfg).await
       └─ bind_with_fallback(rest/grpc)→실주소 / DB connect / mark_orphans_failed
          / settings(8 seeds+clamp) / dispatcher=Subprocess(current_exe+["worker"])
          / scheduler+heartbeat spawn(취소 토큰) / axum+tonic serve spawn(graceful 토큰)
    → browser-open(!no_open) → handle.join().await   (토큰 미-cancel = 영원 serve, R6)
```
(슬라이스 2 desktop은 `run_in_process` 후 `rest_addr()`로 즉시 navigate — 이 spec 밖.)

### 5.2 종료 & 워커 teardown
```
정상 종료 (slice 2 desktop의 RunEvent::Exit → backend.shutdown(); slice 1은 exe 종료/SIGTERM)
 └─ RunningController::shutdown()
      ├─ abort_all() → active run 전부 abort → 워커 Phase::Aborted 최종 flush 후 클린 종료  (R4a, 크로스플랫폼)
      └─ 토큰 cancel → axum/tonic/scheduler/heartbeat 드레인  (R3, abort_all 후라 bidi 스트림 교착 없음)

하드 크래시 (컨트롤러 프로세스 급사 — abort_all 못 돎)
 ├─ gRPC inbound 소켓 close → 워커 abort_listener가 Abort 없이 루프 종료 → run_cancel cancel
 │     → 엔진 EngineError::Aborted → 워커 프로세스 종료   (R4b, 크로스플랫폼·loopback 거의 즉시)
 └─ (슬라이스 2 Windows) Job 핸들 close → 잔여 워커 즉시 kill (belt-and-suspenders, R4d)

다음 기동 → mark_orphans_failed가 "running" 잔류 run failed 마킹   (R4c)
```

## 6. 에러 처리
- **기동 실패**(bind fallback·DB/migration·dispatcher) → `run_in_process` `Err` → caller가 표면화(슬라이스 1: exe 비정상 종료 로그; 슬라이스 2: splash `__setError`). serve spawn *전* 실패면 워커 자식 없음(dispatcher는 run 시작 시 spawn) → 누수 0. 사이드카의 "bind-ok-but-health-failed 좀비"는 health-poll 자체가 없어 구조적 소멸.
- **tonic graceful-shutdown vs bidi 스트림 교착 — bounded drain 필수(요구사항):** 워커 연결은 장수 bidi in-flight 요청이라, 순수 graceful(in-flight 완료 대기)은 워커가 안 끝나면 무한 대기할 수 있다. 정상 종료는 **abort_all 먼저**(워커가 끝나도록) → 그 후 토큰 cancel/드레인(§5.2 순서)이지만, `abort(id)`→`fan_out_abort`는 `Abort`를 **송신만** 하고 스트림 close를 *기다리지 않는다* → `abort_all` 반환 후에도 워커 스트림이 아직 안 닫혀 graceful drain이 매달릴 잔여 윈도가 있다. 따라서 **`shutdown()`은 graceful drain을 무한정 await하지 않는다 — 반드시 bounded deadline(`select!`로 drain vs 타임아웃, 초과 시 hard-stop[serve JoinHandle abort])으로 감싼다.** `shutdown()`이 절대 hang하지 않음이 acceptance(유닛 테스트가 Abort 무시 워커를 모사해 deadline-내 반환 확인). 정확한 타임아웃 값·hard-stop 메커니즘은 plan이 못박는다. abort_all이 불가한 하드 크래시는 R4b가 처리.
- **tracing 전역 init 충돌** → `run_in_process` 비-init로 회피(R8).
- **포트 경합** → `bind_with_fallback(addr, true)`가 `127.0.0.1:0` 폴백(현행). 실주소는 `local_addr()`로 정확.

## 7. 테스트 전략

### 7.1 유닛 (`crates/controller`·`crates/worker`, pre-commit cargo 게이트 내)
- `run_in_process`가 실주소 반환 + `GET /api/health`==`ok`(tokio 테스트, `127.0.0.1:0`).
- `RunningController::shutdown()` 후 serve/scheduler/heartbeat 태스크 종료(후속 연결 거부 또는 핸들 완료).
- **bounded shutdown(§6)**: 워커 연결이 `Abort`를 무시(스트림 안 닫음)하는 상황을 모사 → `shutdown()`이 deadline 내 반환(무한 hang 0)·hard-stop 발동.
- `abort_all`: running run 2개 → 둘 다 abort 호출(coordinator mock/실제). in-memory 엔트리 없는 run은 `false`라도 에러 아님(R4a 주의).
- **R4b**: inbound 스트림을 Abort 없이 drop → `execute_assignment`이 run_cancel cancel(엔진 mock 또는 run_cancel 관찰). 정상 완료(run_res 후 listener abort)에선 cancel 안 됨(오탐 0) 회귀 테스트.
- bundle `cli_tests`(`flat_controller_invocation_still_parses`·`worker_subcommand_parses`) 회귀 0(R7 clap arm 유지).
- 비-bundle `cargo build -p handicap-controller`(feature off) 신규 심볼 0(byte-identical).

### 7.2 라이브 검증 (run-생성/엔진 경로 → S-D 갭 → 필수)
1. **standalone bundle `controller.exe` 회귀**(R6·R10) — 단일 exe로 run 1개 완주(포트 fallback·임베드 UI·워커 self-spawn byte-identical 행동).
2. **R4b 크래시 teardown**(macOS·헤드리스 가능) — controller subprocess + 워커로 run 시작 → 컨트롤러 `kill -9` → 워커가 run을 cancel하고 종료(`ps`로 고아 0; loopback 거의 즉시). **이 슬라이스의 핵심 검증**(우리 환경에서 실측 가능 — Windows Job과 달리).
3. **R4a 정상 종료** — run 중 컨트롤러 SIGTERM(abort_all 경로) → 워커 클린 종료·run Aborted.
4. **LAN 풀 재검증**(R4b가 `execute_assignment` 공유 변경) — pool 모드 run 1개 정상 완주 + 컨트롤러 사망 시 pool 워커가 run cancel 후 idle 복귀 시도(잠복 버그 해소 확인). subprocess 하니스로.

## 8. byte-identical 불변식 요약

| 대상 | 불변식 | 근거 |
|---|---|---|
| 비-bundle `controller` 바이너리 | **byte-identical**(신규 심볼 0) | 신규 코드 전부 `#[cfg(feature="bundle")]`, 비-bundle serve 무수정 (R5) |
| standalone bundle `controller.exe` | 행동 동일(라이브 재검증) | `run_in_process` 위임 = 동일 부트스트랩, 토큰 미-cancel=영원 serve (R6) |
| 기존 워커 동작(정상 컨트롤러) | 관측상 동일(LAN 재검증) | R4b는 inbound가 Abort 없이 닫힐 때만 발화 — 정상엔 안 닫힘 (R5) |
| engine / proto / migration / DB | **0-diff** | 무변경 (R9) |

## 9. LAN 보존
standalone bundle `controller.exe`(ADR-0039 옵션 A)는 별도 빌드 타깃으로 유지(R10) — LAN 헤드리스 워커·수동 fallback. 슬라이스 1·2 어느 것도 이 경로를 막지 않는다.

## 10. 미해결/연기
- **슬라이스 2**(별도 spec): desktop `SidecarBackend`→`InProcessBackend`·Windows Job(워커 배정·R4d)·`externalBin` 제거·`run_worker_if_invoked()` lib 함수 도입(GUI init 전 argv 가드, R7)·`ControllerBackend::shutdown()` trait의 async `RunningController::shutdown()` 수용·macOS GUI 라이브·Windows 런북.
- Windows 코드서명·SmartScreen·인스톨러 메타데이터 — ADR-0040 연기 유지.
- 자동 포트 탐색·mDNS·LAN 워커 자동 등록·트레이/자동업데이트 — 연기.
- Windows CI — 런북 수동 검증 유지.

## 11. ADR 영향
슬라이스 1+2 완료 시 새 ADR **0042**(접근 2 in-process 채택) 작성: ADR-0040 접근 1(사이드카)을 superseding하되 R7 backend 경계·standalone LAN 아티팩트(R10) 계승. 결정 = "in-process 임베드 + 계층화 크래시-견고 teardown(워커 disconnect-cancel 1차[크로스플랫폼·검증가능] + Windows Job belt-and-suspenders + abort_all graceful + mark_orphans 영속) + 비-bundle byte-identical." ADR-0040 상태를 "접근 1 채택 → 접근 2로 대체(0042)"로 갱신.
