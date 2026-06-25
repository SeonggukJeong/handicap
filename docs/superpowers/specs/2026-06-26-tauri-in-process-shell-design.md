# Tauri 데스크톱 셸 → in-process 백엔드 전환 (ADR-0040 접근 2, 슬라이스 2/2)

- 날짜: 2026-06-26
- 상태: 설계 (구현 전)
- 관련: [ADR-0040](../../adr/0040-tauri-desktop-wrapper.md)(사이드카 셸·R7 backend 경계), [ADR-0039](../../adr/0039-windows-desktop-distribution.md)(옵션 A 단일 exe·LAN feasibility), `2026-06-26-tauri-in-process-backend-design.md`(**슬라이스 1** — 이 spec의 직전 단계), `desktop/CLAUDE.md`, `crates/controller/CLAUDE.md`, `crates/worker/src/lib.rs`(WorkerArgs/run_dispatch)
- **이 spec = 슬라이스 2** (desktop 셸 교체 + 워커 멀티콜 가드 + `externalBin` 제거 + async shutdown 브리지). **슬라이스 1**(컨트롤러 in-process lib + R4b 워커 disconnect-cancel + graceful shutdown)은 이미 구현·머지 완료(`54b7382`/`4d84c43`/`16ed2bc`/`8d809aa`/`4b84666`).
- 슬라이스 1+2 완료 → 새 ADR **0042**(접근 2 채택) 작성(§10).

## 1. 배경 & 동기

ADR-0040은 Tauri 데스크톱 셸을 **접근 1(사이드카)** 로 구현했다: bundle `controller` exe를 별도 *프로세스*로 spawn, stdout 로그에서 REST 포트 파싱(`parse_rest_port`), `/api/health` 폴링 후 네이티브 창을 navigate, 창 닫힘 시 `killpg`(Unix)/Job Object(Windows)로 트리 종료. R7 `ControllerBackend{base_url(), shutdown()}` 추상을 교체 지점으로 남겼다.

슬라이스 1은 그 교체를 *가능*하게 하는 백엔드 경계를 깔았다: `run_in_process(InProcessConfig) -> RunningController`(bundle-gated, REST/gRPC 사전바인딩 후 실주소 동기 반환·serve/scheduler/heartbeat를 취소 토큰과 함께 spawn), `RunningController::shutdown()`(graceful **bounded-drain** — §6 절대 hang 안 함), 워커 **R4b disconnect-cancel**(인바운드 스트림이 명시적 `Abort` 없이 닫히면=컨트롤러 소멸 시 run 취소·크로스플랫폼·loopback 거의 즉시).

이 슬라이스 2는 desktop 셸이 사이드카 spawn 대신 그 in-process 경계를 **소비**하도록 전환한다. 사이드카·로그파싱·health폴링·OS 트리종료가 사라지고, 데스크톱 바이너리가 컨트롤러를 자기 프로세스에 임베드한다.

**핵심 결과로 생기는 새 책임 — 워커 멀티콜:** in-process `SubprocessDispatcher`는 워커를 `current_exe worker …`로 self-spawn한다(슬라이스 1 `in_process.rs:258-265`). in-process 모드에서 `current_exe`는 이제 **데스크톱(Tauri) 바이너리**다. 따라서 데스크톱 바이너리가 **멀티콜**이 돼야 한다 — 평범하게 실행하면 GUI, `<app> worker …`로 실행하면 워커. GUI init *전에* argv를 검사하는 가드가 슬라이스 2의 load-bearing 신규 코드다.

**비-목표:** Windows Job(R4d, §3 R7로 연기)·코드서명/SmartScreen/인스톨러 메타데이터(연기)·트레이/자동업데이트(연기)·LAN 분산 워커 오케스트레이션(연기)·부하 모델 변경(엔진 0-diff)·standalone bundle `controller.exe`(ADR-0039 옵션 A) 동작 변경(별개 산출물·무변경).

## 2. 사용자 결정 (이 설계 세션에서 확정)

1. **R4d(Windows Job) 연기 — R4b가 유일 크래시 teardown.** 근거(사용자와 확정): ① R4b는 OS-레벨 소켓 teardown에 기반해 정상종료·하드크래시 모두, **Windows에서 Unix와 동일하게** 워커를 자가 종료시킨다(컨트롤러 소멸→소켓 close→워커 abort_listener가 `Abort` 없는 close 감지→run 취소→프로세스 종료). ② 사이드카가 Job을 쓴 *원래 이유*(컨트롤러 자식이 시그널 핸들러 없이 손자 워커에 종료 미전파)는 in-process엔 컨트롤러 자식 자체가 없어 소멸 — R4b가 그 메커니즘을 대체. ③ Job이 닫는 유일 간극은 인바운드를 영영 폴 안 하는 *병적으로 wedged된 워커*(no-`await` CPU 루프 등)인데 이는 워커 버그·드물고 20s h2 keepalive가 추가 백스톱. ④ R4d는 Windows-전용·runbook-only 검증이라 macOS 개발기에서 실측 불가 → 지금 넣으면 미검증 코드. R4b가 이미 사용자 채택 조건("하드 크래시에도 워커 고아 0/bounded")을 크로스플랫폼·검증가능 형태로 충족. **연기 트리거(R7):** Windows에서 hung-워커 고아가 실제 관측되면 그때 Job 추가. **이 결정은 슬라이스 1 spec §10·§11(R4d를 슬라이스 2 scope로·ADR-0042가 "Windows Job belt-and-suspenders" 채택으로 스케치)을 *개정*한다** — in-process가 컨트롤러 자식을 없애 ADR-0040 R3의 "OS-레벨 트리킬이 load-bearing" 근거가 소멸했으므로 정당한 scope 정련. §10의 ADR-0042 산출물 텍스트가 이 트리거-기반 연기를 반영해야 한다.
2. **워커 멀티콜 가드는 controller lib(bundle-gated)에 — `run_worker_if_invoked()`.** 근거: 워커-arm 파싱이 `handicap_worker::WorkerArgs`(clap)를 **재사용**해 dispatcher가 내보내는 인자와 drift 0(struct 공유). 컨트롤러 `main.rs`의 기존 `Cmd::Worker` arm은 **무변경 유지**(byte-identical·R6) — 통합 시도(두 main이 한 함수 공유)는 컨트롤러를 `#[tokio::main]`에서 떼어내 bundle exe byte-identical 보장을 재오픈하므로 ~3줄 글루 제거 대비 blast radius가 더 커 기각. 워커 *동작*은 이미 `handicap_worker`가 단일소스.
3. **`SidecarBackend` 완전 제거** — 사이드카 spawn·`parse_rest_port`·health폴링·OS 트리종료(`killpg`/Job)·`reqwest`/`libc`/`win32job` 제거. **`ControllerBackend` 트레잇은 유지**(R7 LAN 전방호환). `InProcessBackend`가 유일 구현.
4. **async shutdown 브리지** — 트레잇 `shutdown(&self)`는 동기(sync `RunEvent::Exit`에서 호출), `RunningController::shutdown()`은 async → `InProcessBackend::shutdown`이 `tauri::async_runtime::block_on`으로 브리지.
5. **임베드 UI 인-프로세스 서빙** — desktop이 `handicap-controller` `bundle` feature 의존 → rust-embed가 `ui/dist`를 컴파일타임 임베드, in-process 컨트롤러가 서빙, 창은 in-process REST 포트로 navigate. `externalBin` 제거.

## 3. 요구사항 (R-번호)

### 슬라이스 2 핵심
- **R1 — `InProcessBackend`.** `desktop/src-tauri/src/backend.rs`에 `ControllerBackend` 구현 추가. `start(cfg: InProcessConfig) -> anyhow::Result<Self>` = `run_in_process(cfg).await` → `RunningController` 보유 + `base_url` 캐시(`http://127.0.0.1:<rest_port>/`). `base_url(&self)` = 캐시 반환. `shutdown(&self)` = `tauri::async_runtime::block_on(self.rc.shutdown())`. `Send+Sync` 컴파일타임 단언 유지(`SidecarBackend` 선례 — `RunningController`가 Send+Sync여야 `Box<dyn ControllerBackend>`로 manage).
- **R2 — `SidecarBackend` 및 사이드카 글루 제거.** `backend.rs`의 `SidecarBackend`·`ChildTree`·`kill_tree_on_failure`·`start`(spawn/drain/health)·`killpg`/Job shutdown·관련 테스트(`killpg_terminates_child_and_grandchild`) 삭제. `launch.rs`의 사이드카-전용(`SpawnConfig`·`resolve_sidecar_path`·`parse_rest_port`·`strip_ansi`·`health_url`·`HEALTH_POLL_*` 상수) 및 그 테스트 삭제. **`launch::base_url(port)`는 유지·InProcessBackend가 `launch::base_url(rc.rest_addr().port())`로 사용**(인라인 안 함 — dead-code 회피·기존 순수 헬퍼+테스트 보존). `launch.rs:202` `urls_are_localhost_with_health_path` 테스트는 `health_url` 단언을 드롭하도록 **수정**(예: `url_is_localhost`로 개명, `base_url`만 단언) — `health_url` 삭제로 컴파일 깨짐 방지. `ControllerBackend` 트레잇은 유지.
- **R3 — 워커 멀티콜 가드 `run_worker_if_invoked()` (controller lib, bundle-gated).** `crates/controller/src/in_process.rs`(전부 `#[cfg(feature="bundle")]`)에 `pub fn run_worker_if_invoked()`. 동작: argv[1]이 `"worker"`가 아니면 즉시 return; 맞으면 `WorkerArgs`를 argv에서 파싱(아래) → `tokio::runtime` 멀티스레드 빌드 → `handicap_worker::init_worker_tracing()` → `rt.block_on(handicap_worker::run_dispatch(args))` → 결과 코드로 `std::process::exit`. **never-returns-on-worker.**
  - **파싱은 `WorkerArgs::try_parse_from`을 *직접 쓰지 않는다*** — `WorkerArgs`는 `#[derive(clap::Args)]`(worker/src/lib.rs:28)라 `Parser`/`CommandFactory` 미구현이라 `try_parse_from`이 없다. 대신 `worker/src/main.rs:6-11` 패턴을 미러: `in_process.rs`(bundle-gated)에 private `#[derive(clap::Parser)] struct WorkerCli { #[command(flatten)] args: WorkerArgs }`를 두고 `WorkerCli::try_parse_from(...)`.
  - **argv 토큰 스킵이 필수** — dispatcher가 내보내는 argv는 `[exe, "worker", "--controller", …]`라, `worker` 서브커맨드가 없는 flatten 래퍼에 그대로 먹이면 `"worker"`가 예기치 못한 positional이 돼 파싱 실패한다. 따라서 `worker_args_from`은 ① `argv[1] == "worker"` 확인, ② `[synthetic_prog] ++ argv[2..]`(인덱스 1 토큰 드롭 + 합성 argv[0]) 구성, ③ `WorkerCli::try_parse_from(그것).ok().map(|c| c.args)`. 이는 standalone `controller.exe`의 clap `Cmd::Worker` 서브커맨드가 *같은* dispatcher argv를 소비하는 방식과 정합(둘 다 `worker` 토큰을 먹고 나머지를 `WorkerArgs`로).
  - 테스트 가능하게 순수 헬퍼 분리: `worker_args_from(argv) -> Option<WorkerArgs>`(위 ①②③) — 컨트롤러 crate 단위테스트(bundle-gated)가 detection+token-skip+parse parity를 잠근다. `run_worker_if_invoked`는 이 헬퍼 + 런타임/exit 부수효과 래퍼.
- **R4 — desktop `main.rs` 멀티콜 진입.** `main()`의 **첫 문장**으로 `handicap_controller::in_process::run_worker_if_invoked();` 호출 → 그 다음 `desktop_lib::run()`. 가드는 어떤 Tauri 상태에도 의존하지 않으며 GUI init 전에 워커 경로를 분기한다. `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` 라인 유지(워커 모드도 GUI-subsystem 바이너리지만 워커는 창 미생성·헤드리스 — windowless=콘솔 로그 없음은 §6 runbook 노트).
- **R5 — desktop `lib.rs` in-process 배선.** `setup` 훅의 `tauri::async_runtime::spawn` 본체에서 `SidecarBackend::start(sidecar, SpawnConfig::default())` → `InProcessBackend::start(cfg)`로 교체. `cfg = InProcessConfig{ db: env HANDICAP_DB override else None, ..Default::default() }`(rest/grpc `127.0.0.1:0`·scheduler enabled·`worker_token=None`). 성공 시 창을 `be.base_url()`로 navigate, 실패 시 splash `__setError`(현 구조 보존). `RunEvent::Exit` → `be.shutdown()`(현 구조 보존). `BackendState(Mutex<Option<Box<dyn ControllerBackend>>>)` 그대로.
- **R6 — `externalBin` 제거.** `tauri.conf.json`의 `"externalBin": ["binaries/controller"]` 제거. `binaries/.gitkeep`는 유지 가능(무해)하나 사이드카 복사 단계는 런북에서 삭제. desktop 빌드는 이제 `ui/dist` 존재를 컴파일타임 요구(rust-embed) — 런북에 반영.
- **R7 — R4d(Windows Job) 연기.** §2.1. 이 슬라이스 범위 밖. `win32job`/`libc` desktop 의존 제거(사이드카 트리종료 소멸). 트레잇 경계(R1)는 미래 Windows Job 하드닝을 desktop-only 추가로 받을 수 있게 유지.

### 보조
- **R8 — Cargo 의존 조정.** `desktop/src-tauri/Cargo.toml`: `handicap-controller = { path = "../../crates/controller", features = ["bundle"] }` 추가(워크스페이스 경계 넘는 path 의존 — cargo가 멤버십 무관 해석, pre-commit `cargo build --workspace`는 desktop 비대상 유지; controller는 `edition.workspace=true`/`rust-version.workspace=true`를 *루트* 워크스페이스에서 상속하므로 desktop 의존과 무관하게 해석된다 — **첫 빌드로 확인**). `reqwest`(health폴링)·`[target.'cfg(unix)'] libc`·`[target.'cfg(windows)'] win32job` 제거. `tauri`/`serde`/`serde_json`/`tokio`/`anyhow` 유지(`tokio`는 backend.rs 삭제 후 desktop *직접* 사용처가 줄 수 있으나 무해·유지). desktop은 `handicap-worker`를 직접 의존하지 않음(controller가 bundle feature로 추이 제공). **`desktop/src-tauri/Cargo.lock` 재생성 필수** — sqlx/tonic/axum/kube/engine 등 controller 그래프 전체가 desktop 락파일에 새로 들어온다(빌드 단계로 명시). **바이너리 비대 노트(블로커 아님):** `kube`/`k8s-openapi`는 controller의 *비-optional* 의존이라 in-process에선 죽은 K8s dispatcher까지 링크된다 — standalone bundle exe와 동일 수준이나 ADR-0039/0040의 "라이트 데스크톱" 의도 대비 빌드시간·바이너리 크기 증가를 build-log에 한 줄 기록.
- **R9 — 비-bundle controller byte-identical · engine/proto/migration 0-diff.** 슬라이스 2의 유일한 `crates/**` 변경 = `in_process.rs`(bundle-gated)에 `run_worker_if_invoked`+`worker_args_from` *additive*. 비-bundle 빌드엔 신규 심볼 0(byte-identical). 컨트롤러 `main.rs`·`grpc`·`store`·엔진·proto·migration·DB 스키마 **0-diff**. 워커 crate 0-diff(R4b는 슬라이스 1에서 이미 머지).
- **R10 — standalone bundle `controller.exe` 보존.** ADR-0039 옵션 A 빌드 타깃·동작 무변경(LAN 헤드리스 워커·수동 fallback). desktop과 별개 산출물. 슬라이스 2는 이 경로를 건드리지 않음.

## 4. 아키텍처

### 4.1 컴포넌트 책임

| 컴포넌트 | 책임 | 변경 |
|---|---|---|
| `controller::in_process::run_worker_if_invoked` | argv[1]=="worker"면 워커 런타임 빌드+dispatch+exit, 아니면 return | 신규(bundle-gated, additive) |
| `controller::in_process::worker_args_from` | argv→`Option<WorkerArgs>`(순수, 테스트용) | 신규(bundle-gated) |
| `controller::main`·`grpc`·`store`·엔진·proto·migration | — | **0-diff** |
| `desktop::backend::InProcessBackend` | `run_in_process` 보유·base_url 캐시·async shutdown 브리지 | 신규 |
| `desktop::backend::SidecarBackend` 외 사이드카 글루 | — | **삭제** |
| `desktop::backend::ControllerBackend` 트레잇 | base_url()/shutdown() 경계(R7 전방호환) | 유지 |
| `desktop::lib::run` | setup가 InProcessBackend::start, Exit가 shutdown | 리팩터 |
| `desktop::main` | 첫 문장 `run_worker_if_invoked()` | 리팩터 |
| `desktop::launch` | `base_url`만 잔존(InProcessBackend가 호출), 사이드카 글루 삭제 | 축소 |
| `tauri.conf.json` | externalBin 제거 | 수정 |
| `desktop/README.md`·`desktop/CLAUDE.md` | 사이드카/`parse_rest_port`/`externalBin` 복사 문구 삭제·"빌드는 `ui/dist` 필요"·"워커 멀티콜=같은 바이너리"·"Windows windowless 워커=콘솔 로그 없음" 추가 | 수정 |

### 4.2 `run_worker_if_invoked` 스케치 (controller, bundle-gated)

```rust
use clap::Parser;
/// in_process.rs(bundle-gated) private 래퍼 — worker/src/main.rs:6-11 미러.
/// WorkerArgs는 derive(Args)라 자체 파싱 불가 → flatten 래퍼가 Parser를 제공.
#[cfg(feature = "bundle")]
#[derive(clap::Parser)]
struct WorkerCli { #[command(flatten)] args: handicap_worker::WorkerArgs }

/// 멀티콜 가드. argv[1]=="worker"면 워커로 실행 후 프로세스 종료(절대 return 안 함);
/// 아니면 return해 호출자가 GUI를 띄우게 한다. desktop main의 *첫 문장*으로 호출해야 한다
/// (Tauri/런타임 init 전). 워커 *동작*은 handicap_worker(run_dispatch)가 단일소스.
#[cfg(feature = "bundle")]
pub fn run_worker_if_invoked() {
    let Some(args) = worker_args_from(std::env::args_os()) else { return };
    handicap_worker::init_worker_tracing();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all().build().expect("build worker runtime");
    let code = match rt.block_on(handicap_worker::run_dispatch(args)) {
        Ok(()) => 0,
        Err(e) => { tracing::error!(error = ?e, "worker failed"); 1 }
    };
    std::process::exit(code);
}

/// 순수: argv[1]=="worker"면 토큰을 드롭하고 나머지를 WorkerArgs로 파싱.
/// dispatcher argv = [exe, "worker", "--controller", …] → [synthetic_prog] ++ argv[2..]를
/// WorkerCli::try_parse_from에 먹인다(standalone controller.exe의 Cmd::Worker와 동일 소비).
#[cfg(feature = "bundle")]
fn worker_args_from<I, T>(argv: I) -> Option<handicap_worker::WorkerArgs>
where I: IntoIterator<Item = T>, T: Into<std::ffi::OsString> + Clone {
    let v: Vec<std::ffi::OsString> = argv.into_iter().map(Into::into).collect();
    if v.get(1)?.to_str()? != "worker" { return None; }
    let synth = std::iter::once(std::ffi::OsString::from("worker"))
        .chain(v.into_iter().skip(2));
    WorkerCli::try_parse_from(synth).ok().map(|c| c.args)
}
```
(정확한 제네릭 형태는 플랜이 확정 — 핵심: derive(Args)라 Parser 래퍼 필수 + "worker" 토큰 스킵 + `WorkerArgs` struct 재사용으로 dispatcher 인자와 drift 0.)

### 4.3 `InProcessBackend` 스케치 (desktop)

```rust
pub struct InProcessBackend { rc: RunningController, base_url: String }
const _: fn() = || { fn a<T: Send + Sync>() {} a::<InProcessBackend>(); }; // R1 Send+Sync

impl InProcessBackend {
    pub async fn start(cfg: InProcessConfig) -> anyhow::Result<Self> {
        let rc = run_in_process(cfg).await?;
        let base_url = crate::launch::base_url(rc.rest_addr().port()); // R2: 인라인 안 함
        Ok(Self { rc, base_url })
    }
}
impl ControllerBackend for InProcessBackend {
    fn base_url(&self) -> String { self.base_url.clone() }
    fn shutdown(&self) { tauri::async_runtime::block_on(self.rc.shutdown()); }
}
```

## 5. 데이터 흐름

```
기동:
 desktop main()
  ├─ run_worker_if_invoked()  → argv[1]!="worker" → return
  └─ desktop_lib::run()
       ├─ window shows splash.html
       ├─ setup: async_runtime::spawn(InProcessBackend::start(cfg))
       │    └─ run_in_process: bind 127.0.0.1:0(rest/grpc)→실주소 / DB(HANDICAP_DB|default)
       │       / dispatcher=Subprocess(current_exe + ["worker"]) / serve+scheduler+heartbeat spawn(취소토큰)
       │    → Ok: window.navigate(base_url)   // in-process 컨트롤러가 임베드 UI 서빙
       │    → Err: splash __setError
       └─ run loop

run 발사 → in-process SubprocessDispatcher가 spawn:
 <app-binary> worker --controller <grpc> --run-id … --worker-id …
  └─ 그 프로세스: run_worker_if_invoked() → argv[1]=="worker" → WorkerArgs 파싱
       → run_dispatch → 종료(GUI init 도달 안 함)

정상 종료: window close → RunEvent::Exit → be.shutdown()
  └─ block_on(rc.shutdown()): abort_all(active run→워커 Aborted) → 토큰 cancel
       → axum/tonic/scheduler/heartbeat drain → bounded 5s(초과 시 hard-stop)   // 절대 hang 안 함

하드 크래시(Tauri kill -9): OS가 gRPC 소켓 close → 각 워커 abort_listener가 Abort-없는 close 감지
  → run 취소 → 워커 종료(R4b, 크로스플랫폼·loopback 거의 즉시) → 다음 기동 mark_orphans_failed(R4c)
```

## 6. 에러 처리 & 운영 노트

- **백엔드 start 실패**(bind/DB/migration) → `run_in_process` `Err` → splash `__setError`(navigate 금지). dispatcher는 run 시점에만 워커 spawn하므로 start 실패 시 워커 자식 누수 0.
- **shutdown bounded** — 슬라이스 1 `bounded_drain`(5s + hard-abort)이라 앱 종료가 결정적(절대 hang 안 함). `tauri::async_runtime::block_on`은 메인(이벤트루프) 스레드 — tokio 워커 스레드가 아니라 nested-runtime panic 없음(라이브 검증으로 확인).
- **Windows windowless 워커** — desktop 바이너리가 `windows_subsystem="windows"`라 워커 서브프로세스도 콘솔 없음 → 워커 로그 비가시. 프로덕션엔 바람직(콘솔 깜빡임 0), dev는 debug 빌드(콘솔 유지) 또는 로그파일. `desktop/CLAUDE.md`/런북 노트.
- **빌드는 `ui/dist` 필요** — rust-embed 컴파일타임. desktop 빌드 전 `just ui-build`. externalBin 복사 단계 대체.
- **워커 dispatch/exit 실패** → 기존 컨트롤러 reaper + `worker_disconnected` fail-fast(0-diff).

## 7. 테스트 전략

### 7.1 단위 (pre-commit 게이트 내 — controller crate, bundle-gated)
- `worker_args_from`: `["app","worker","--controller","u","--run-id","r","--worker-id","w"]` → `Some(WorkerArgs{controller,run_id,worker_id,…})`; `["app"]`/`["app","--rest","…"]` → `None`(컨트롤러 모드 통과). detection+parse parity를 `WorkerArgs` 재사용으로 잠금.
- 비-bundle `cargo build -p handicap-controller`(feature off) 신규 심볼 0(byte-identical 회귀).
- **bundle FULL suite**(`cargo test -p handicap-controller --features bundle`, 필터 없이 — 단일 self-contained 바이너리 노트 "필터된 bundle 테스트는 기존-깨짐 테스트를 놓친다") 0-failed.

### 7.2 desktop crate 테스트 (게이트 밖 — `cd desktop/src-tauri && cargo test` 수동)
- `InProcessBackend::base_url` 캐시 형태(가능하면 — `run_in_process` 없이 base_url 포맷 순수 단언)·`launch::base_url` 잔존 테스트. `lib.rs` 대부분은 Tauri 런타임 바운드라 단위 불가.
- `Send+Sync` 단언은 컴파일타임(R1).

### 7.3 라이브 검증 — 헤드리스 가능 (S-D 갭 → 필수). **이 슬라이스의 신규 load-bearing 코드 = 데스크톱 바이너리의 워커 멀티콜 가드**

**함정(리뷰 적발): 데스크톱 바이너리를 *컨트롤러로* 헤드리스 부팅할 수 없다** — `desktop main()`이 무조건 `desktop_lib::run()`(Tauri 창 빌드, WindowServer 필요)을 호출하므로 SSH/CI 헤드리스에서 in-process 컨트롤러를 띄울 길이 없다(헤드리스 escape 없음). 그리고 standalone bundle `controller.exe`로 in-process 부팅을 검증해도(슬라이스 1이 이미 함) *데스크톱* 바이너리의 가드는 안 거친다(`controller.exe`의 self-spawn은 `controller.exe worker`→clap `Cmd::Worker`이지 `run_worker_if_invoked`가 아님). 따라서 가드를 헤드리스로 실측하려면 **데스크톱 바이너리를 워커로 직접 띄운다**(가드가 GUI init *전*에 `process::exit`):

1. **데스크톱 바이너리 = 풀 워커 (가드 헤드리스 실측, 필수):** ① 컨트롤러를 **pool 모드**로 기동(비-bundle `controller --worker-mode pool` 또는 standalone bundle `controller.exe`, `HANDICAP_DB`/임시 DB·`ui/dist` 불요시 비-bundle), ② `<desktop-exe> worker --controller <grpc-url>`를 **직접 실행**(창 안 뜸 — 가드가 `WorkerCli` 파싱→`run_dispatch`→exit, `desktop_lib::run()` 도달 안 함) → 풀에 idle 등록 확인(`GET /api/pool/workers`에 데스크톱-워커 1), ③ run 1개 생성 → 풀 워커(=데스크톱 바이너리)가 실행·완주. **핵심 단언: 데스크톱 바이너리가 멀티콜 가드를 타고 워커로 동작**(argv 토큰 스킵·`WorkerArgs` 파싱 parity 실측).
2. **R4b 크래시 teardown (macOS 실측 가능, 필수):** 위 풀 run 중 컨트롤러 `kill -9`(또는 데스크톱-워커 `kill -9`) → 데스크톱-워커가 인바운드 close 감지하고 run 취소 후 종료(`ps`로 고아 0; loopback 거의 즉시). 슬라이스 1 메커니즘이나 *데스크톱 바이너리*로 재확인.
3. (선택) **비-bundle/bundle 컨트롤러 in-process 회귀** — `run_in_process` 자체는 슬라이스 1이 standalone `controller.exe`로 이미 검증(데스크톱 `InProcessBackend::start`는 `run_in_process` + base_url 포맷일 뿐 신규 집계 0). 새로 깨질 게 없으면 생략하고 build-log에 근거 기록.

### 7.4 runbook-only — GUI 세션 필요 (macOS 헤드리스 불가 — 연기, 슬라이스 1 선례)
- **통합 부팅**(로그인된 GUI 세션 필요·SSH/CI 불가): 데스크톱 앱 실행 → `InProcessBackend::start`가 `run_in_process` → 창이 in-process REST 포트로 navigate → React UI 렌더 → UI로 run 생성·완주 → 창 닫기 시 `RunEvent::Exit`→`block_on(shutdown())` bounded 종료(앱이 매달리지 않음·워커 클린 종료). `tauri::async_runtime::block_on` 브리지(R1·§6)의 실측 지점.
- WebView2 다운로드·Windows 인스톨러(NSIS/MSI). `desktop/CLAUDE.md` 헤드리스 한계 — 가용 GUI/Windows 머신 체크리스트.

## 8. byte-identical 불변식 요약

| 대상 | 불변식 | 근거 |
|---|---|---|
| 비-bundle `controller` 바이너리 | **byte-identical**(신규 심볼 0) | `run_worker_if_invoked`/`worker_args_from` 전부 `#[cfg(feature="bundle")]` additive (R9) |
| 컨트롤러 `main.rs`·`Cmd::Worker` arm | **0-diff** | 멀티콜 통합 안 함(R6 byte-identical 보존, §2.2) |
| standalone bundle `controller.exe` | 동작 무변경 | 슬라이스 2가 이 경로 미접촉 (R10) |
| engine / proto / migration / DB / worker crate | **0-diff** | 무변경 (R9; R4b는 슬라이스 1) |

## 9. 미해결 / 연기
- **R4d Windows Job** — §2.1. 트리거(Windows hung-워커 고아 관측) 시 desktop-only 추가(트레잇 경계 보존).
- **macOS GUI / Windows 인스톨러 라이브** — runbook-only(§7.4).
- Windows 코드서명·SmartScreen·인스톨러 메타데이터·트레이/자동업데이트·LAN 자동등록 — ADR-0040/0039 연기 유지.

## 10. ADR 영향
슬라이스 1+2 완료 → 새 ADR **0042**(접근 2 in-process 채택) 작성: ADR-0040 접근 1(사이드카)을 superseding하되 R7 `ControllerBackend` 트레잇 경계·standalone LAN 아티팩트(R10)·byte-identical-when-off를 계승. 결정 = "데스크톱 셸이 컨트롤러를 in-process 임베드(사이드카·로그파싱·health폴링 제거) + 워커 멀티콜(`run_worker_if_invoked`, `WorkerArgs` 단일소스) + 계층화 크래시-견고 teardown(R4b disconnect-cancel 1차[크로스플랫폼·검증가능] + abort_all graceful + mark_orphans 영속; R4d Windows Job은 트리거-기반 후속) + 비-bundle byte-identical." ADR-0040 상태를 "접근 1 채택 → 접근 2로 대체(0042)"로 갱신.

<!-- REVIEW-GATE: 미설정 — spec-plan-reviewer clean APPROVE 후 plan에 마커 추가 -->
