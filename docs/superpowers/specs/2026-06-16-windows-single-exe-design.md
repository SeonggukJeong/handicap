# 단일 self-contained 바이너리 모드 (ADR-0039 옵션 A · 슬라이스 1) — 설계

- Status: approved (spec-plan-reviewer clean APPROVE, 2026-06-16) — plan 작성 단계
- Date: 2026-06-16
- 관련 결정: ADR-0039 (라이트 Windows 데스크톱 배포 — 옵션 A 단일 exe → 후속 옵션 B Tauri)

## 1. 배경 / 목표

핸디캡은 현재 조각난 형상으로 실행된다 — `controller`와 `worker`가 **별도 바이너리 2개**, UI는
`ui/dist` **폴더**, 데이터는 SQLite **파일**, 실행하려면 명령줄 플래그(`--db`/`--ui-dir`/…)가 필요하다.

ADR-0039는 "K8s 없이 자기 PC에서 소규모 테스트를 돌리는 가볍게 쓰는 사용자"를 위해 **단일
self-contained 실행 파일**(옵션 A)을 첫 슬라이스로 정했다. 이 spec은 옵션 A를 구현한다.

**목표**: 인자 없이 실행(=더블클릭)하면 →

1. 안에서 worker를 자동 기동하고,
2. 바이너리에 임베드된 UI를 서빙하고,
3. 사용자 데이터 폴더(`%LOCALAPPDATA%`/`~/Library/Application Support`)에 DB를 두고,
4. 기본 브라우저로 `http://localhost:<port>`를 자동으로 연다.

K8s·명령줄 플래그 불필요. 단일 워커(라이트 부하). **이 개발 머신은 macOS이므로, 위 로직을
OS-이식적으로 구현해 macOS에서 단일 바이너리로 완전히 검증한다.** 실제 Windows `.exe` 생산은
Windows 머신/CI가 필요하므로 **빌드 레시피(런북) 문서로만** 남기고 이 슬라이스에서 굽지 않는다.

## 2. 확정된 결정 (브레인스토밍 산출)

| # | 결정 | 근거 |
|---|---|---|
| D1 | **범위 = 자체완결 모드(macOS 검증) + Windows 빌드 레시피 문서.** 실제 `.exe` 생산·GUI 클릭 테스트는 슬라이스 밖 | macOS에선 Windows `.exe`를 만들기 까다롭고 실행/클릭 검증 불가. ADR-0039의 "진짜 일거리 = 자체완결 로컬 모드"와 일치 |
| D2 | **worker 묶기 = 방법 1(멀티콜).** 본체가 자기 자신을 `worker` 서브커맨드로 재실행. "embed+extract"(방법 2) 거절 | 진짜 단일 파일(디스크에 임시 exe 안 꺼냄 → 백신/권한 함정 적음), 빌드 순서 단순. ADR-0039 "단일 self-contained .exe"에 충실 |
| D3 | **모든 신규 동작은 cargo 기능 `bundle`로 게이트(기본 off).** off = 현행 byte-identical | 개발(`cargo run --bin controller --ui-dir …`)·통합/e2e 테스트·K8s 경로를 건드리지 않음 |
| D4 | **기존 `worker` 별도 바이너리는 유지.** 멀티콜은 *추가* 능력 | e2e 테스트(`CARGO_BIN_EXE_worker`)·K8s Indexed Job·dev 워크플로 무변경 |
| D5 | **포트 자동 회피**: bundle 모드에서 기본 포트가 사용 중이면 OS-할당 빈 포트로 폴백, 실제 포트로 브라우저 오픈·worker dial | 다른 워크트리/앱이 8080·8081을 점유해도 더블클릭 실행이 깨지지 않게 |

## 3. 범위 / 비범위

### 범위 (이 슬라이스)
- worker 실행 로직의 라이브러리 추출 + 얇은 main 래퍼.
- 컨트롤러의 선택적 `worker` 서브커맨드(멀티콜).
- cargo 기능 `bundle`(off=현행).
- bundle 시: UI 임베드 서빙 / 사용자 데이터 폴더 기본 경로 / 브라우저 자동 오픈 / worker self-spawn / 포트 자동 회피.
- 초보자용 Windows(+macOS/Linux) 빌드 런북 문서.

### 비범위 (명시적 제외)
- 실제 Windows `.exe` 생산·서명·GUI 클릭 테스트 (Windows 필요).
- 옵션 B(Tauri 래퍼), 인스톨러(MSI/NSIS), 트레이 아이콘, 자동 업데이트.
- LAN 분산 워커, 멀티워커 fan-out (단일 워커 고정).
- in-process 워커(별도 프로세스 spawn 모델 유지).
- GitHub Actions 워크플로의 *실제 운영* (예시 YAML은 런북에 *선택적* 부록으로만; remote 미설정).

## 4. 아키텍처 개요

```
handicap(.exe)  ── 단일 바이너리, cargo build --release --features bundle
  ├─ (인자 없음)            → 컨트롤러 자체완결 모드
  │     ├─ 임베드 UI 서빙 (rust-embed, --ui-dir 없을 때)
  │     ├─ DB = <user-data-dir>/handicap/handicap.db
  │     ├─ REST/gRPC 포트 자동 회피 (사용 중이면 빈 포트)
  │     ├─ 브라우저로 http://localhost:<rest_port> 오픈
  │     └─ SubprocessDispatcher가 worker를 self-spawn:
  │            current_exe()  worker  --controller http://127.0.0.1:<grpc_port> --run-id … --worker-id …
  └─ (worker 서브커맨드)     → 워커로 동작 (= 기존 worker 바이너리와 동일 로직, 공용 lib 호출)
```

비-bundle 빌드(기본)는 `worker` 서브커맨드·임베드 UI·자동 경로·브라우저 오픈·포트 폴백이 전부
컴파일 제외되어 현행과 동일하게 동작한다.

## 5. 상세 설계

### 5.1 worker 실행 로직 라이브러리 추출 (`crates/worker`)

- 현재 `crates/worker`는 **bin-only**(`src/main.rs`, `lib.rs` 없음). 새 `src/lib.rs`를 추가한다.
  Cargo가 `src/lib.rs`를 자동 인식해 lib 타깃(기본 이름 `handicap_worker`)을 만든다 — `[lib]` 명시
  불필요(`handicap_worker::run` 경로가 그대로 성립). `[[bin]] worker`는 유지.
- `main.rs`의 실행 본문(현 `#[tokio::main] async fn main`의 파싱 이후 전부, ~454줄)을
  **`pub async fn run(args: WorkerArgs) -> anyhow::Result<()>`** 로 이동.
- **함께 이동(중요)**: 그 본문이 의존하는 자유 함수(`map_policy`, `proto_is_open_loop`,
  `proto_is_vu_curve`, `run_duration_secs`, `resolve_worker_id`, `phase_for_result`)와 그들의
  인라인 `#[cfg(test)] mod tests`(현 main.rs ~454–639)도 lib로 옮긴다 — 테스트의 `super::*` 경로가
  lib 기준으로 재해석된다. **로직은 한 줄도 안 바꾸되 인라인 테스트는 사는 파일이 바뀐다**(통과는
  유지). 그래서 §7.1은 "unchanged"가 아니라 "relocate"로 기술.
- **인자 구조체는 lib이 단일 소스**: `#[derive(clap::Args, Debug)] pub struct WorkerArgs`
  (`controller: String`, `run_id: String`, `worker_id: Option<String>`, `capacity_vus: u32`)를 lib에
  정의한다. worker crate는 이미 clap 의존이므로 lib에서 그대로 쓴다(clap을 lib API에 노출하는 것은
  **의도** — 중복 clap 구조체를 0으로 만들기 위함). **두 진입점이 이 한 구조체를 재사용**:
  - worker bin(`main.rs`, 얇은 래퍼): `#[derive(Parser)] struct Cli { #[command(flatten)] args: WorkerArgs }`
    → `init_worker_tracing(); handicap_worker::run(cli.args).await`.
  - controller `worker` 서브커맨드(§5.2): `Cmd::Worker(handicap_worker::WorkerArgs)`.
  → 별도 `WorkerCliArgs`·`.into()` 변환 불필요.
- **tracing 초기화는 호출자가 한다** — `run()`은 `tracing_subscriber::*::init()`을 호출하지 않는다
  (전역 subscriber 이중 set 패닉 방지). 현 main.rs의 인라인
  `tracing_subscriber::fmt().with_env_filter(EnvFilter…).init()`을 **신규 헬퍼
  `init_worker_tracing()`** 로 함수화해 worker bin과 컨트롤러 worker-arm이 각각 1회 호출.
- 검증: 통합/e2e 테스트는 무변경 통과, 인라인 단위 테스트는 lib로 이동 후 통과(아래 §7.1).

### 5.2 컨트롤러 선택적 `worker` 서브커맨드 — 멀티콜 (`crates/controller`, `bundle`)

- 컨트롤러 `Cargo.toml`: `handicap-worker = { path = "../worker", optional = true }`. (worker는
  controller에 의존하지 **않으므로** 순환 없음 — 확인됨.)
- `[features]`에 `bundle`을 정의하고 `dep:handicap-worker`(및 5.4·5.5·5.6의 dep)를 포함.
- 컨트롤러 clap을 **top-level 평면 필드 + 선택적 서브커맨드**로 확장:
  ```rust
  #[derive(Parser)]
  struct Cli {
      #[command(subcommand)]
      cmd: Option<Cmd>,            // None = 컨트롤러(현행 평면 플래그)
      #[command(flatten)]
      controller: ControllerArgs,  // 현 `Args`를 `ControllerArgs`로 개명 (--db/--rest/--grpc/…)
  }
  #[cfg(feature = "bundle")]
  #[derive(Subcommand)]
  enum Cmd { Worker(handicap_worker::WorkerArgs) }   // §5.1의 단일 lib 구조체 재사용
  ```
  - 서브커맨드 없음(`None`) → 현행 컨트롤러 경로(평면 플래그 그대로, **byte-identical**).
  - `worker …`(bundle만) → `init_worker_tracing()` 후 `handicap_worker::run(args).await`
    (§5.1의 단일 `WorkerArgs`라 변환 불필요 — `.into()` 없음).
- **tracing 이중 init 방지(중요)**: 현재 `main.rs`는 함수 맨 위(파싱 전)에서 무조건
  `tracing_subscriber::fmt()…init()`을 호출한다(main.rs:74-78). 멀티콜에서 worker arm이 또
  `init_worker_tracing()`을 부르면 **전역 subscriber 이중 set 패닉**(§8). → 컨트롤러의 그 top-of-main
  init을 **컨트롤러(`None`) arm 안으로 이동**해, worker arm은 `init_worker_tracing()`이 유일한 init이
  되게 한다(옮긴 컨트롤러 init은 현재와 관측상 동일 → 컨트롤러 경로 byte-identical).
- **함정 회피**: clap에서 "평면 필드 + optional subcommand" 혼용은 합법이지만, 서브커맨드 이름
  (`worker`)이 평면 인자와 충돌하지 않게 한다. 기존 `--bin controller --db … --ui-dir …`(서브커맨드
  없음) 호출이 깨지지 않는지 단위 테스트로 락(아래 §7).
- 비-bundle 빌드는 `Cmd`·worker dep이 통째로 컴파일 제외 → 현행 CLI와 동일.

### 5.3 cargo 기능 `bundle` (기본 off)

- `crates/controller/Cargo.toml`:
  ```toml
  [features]
  bundle = ["dep:handicap-worker", "dep:rust-embed", "rust-embed/mime-guess", "dep:dirs", "dep:open"]
  ```
  (`rust-embed`·`dirs`·`open`·`handicap-worker`는 `[dependencies]`에 `optional = true`로 선언. UI
  content-type은 별도 `mime_guess` dep 없이 **rust-embed의 `mime-guess` 기능**으로 처리 — §5.4.)
  **버전 핀**: plan은 `rust-embed`를 구체 버전(예 `8.x`)으로 핀한다 — `mime-guess` 기능명과
  `EmbeddedFile.metadata().mimetype()` 접근자는 신버전(≥6.3)에서 안정적이나 구버전은 노출이 달랐다.
- off(기본): 개발/테스트/K8s = 현행 byte-identical(신규 코드 전부 `#[cfg(feature = "bundle")]`).
- on: `cargo build --release --features bundle` → 자체완결 바이너리. 산출물 이름은 여전히
  `controller`(`controller.exe`); 런북에서 배포 시 `handicap.exe`로 리네임(별도 bin 타깃 신설 안 함 —
  코드 중복 회피).
- **모든 bundle 동작은 명시 플래그로 override 가능**(파워 유저용): `--db`, `--rest`, `--grpc`,
  `--ui-dir`, `--no-open`.

### 5.4 UI 임베드 서빙 (`rust-embed`, `bundle`)

- `rust-embed`로 `ui/dist`를 컴파일 타임에 바이너리에 포함:
  ```rust
  #[cfg(feature = "bundle")]
  #[derive(rust_embed::RustEmbed)]
  #[folder = "$CARGO_MANIFEST_DIR/../../ui/dist"]
  struct EmbeddedUi;
  ```
  (folder는 controller crate 기준 `../../ui/dist`.)
- **컴파일 전 `ui/dist`가 있어야 한다** → 런북이 `pnpm build`를 cargo 빌드보다 먼저 실행.
- `app.rs` 라우터 분기:
  - `--ui-dir` 주어짐 → 현행 `ServeDir::new(dir).fallback(ServeFile::new(index))`(개발 override,
    bundle 빌드에서도 유효).
  - `--ui-dir` 없음 + bundle → **임베드 에셋 fallback 핸들러**:
    - 요청 경로의 에셋이 있으면 그 바이트 + content-type으로 200. content-type은 **rust-embed의
      `mime-guess` 기능**(Cargo feature `rust-embed/mime-guess`)이 채운
      `EmbeddedFile.metadata().mimetype()`을 사용(별도 `mime_guess` dep 불필요).
    - 없으면 **SPA fallback**: `index.html`을 **200**으로 반환(404 아님 — 기존 `ServeDir::fallback`
      함정과 동일 보장, React Router hard-refresh 대비).
  - `--ui-dir` 없음 + 비-bundle → 현행대로 SPA 미서빙.
- **rust-embed debug 빌드 함정**: rust-embed는 기본적으로 debug 빌드에서 디스크를 런타임에 읽는다
  (embed 아님). bundle은 *release* 산출물이므로 정상 임베드. `cargo run --features bundle`(debug)로
  돌리면 CWD 기준 `ui/dist`를 읽으니, 라이브 검증은 `--release`로 한다. (트랩 §8.)

### 5.5 사용자 데이터 폴더 기본 경로 (`dirs`, `bundle`)

- `dirs::data_local_dir()`로 OS별 폴더 해석 후 `handicap/` 서브디렉토리:
  - Windows: `%LOCALAPPDATA%\handicap\` (예: `C:\Users\<u>\AppData\Local\handicap\`).
  - macOS: `~/Library/Application Support/handicap/`.
  - Linux: `$XDG_DATA_HOME/handicap` 또는 `~/.local/share/handicap`.
- 폴더가 없으면 `create_dir_all`로 생성.
- **DB 경로 해석**: `--db`를 `Option<String>`으로 바꾼다(현재 `default_value = "./handicap.db"`).
  - 명시 `--db <path>` → 그대로(우선).
  - 없음 + bundle → `<data-dir>/handicap/handicap.db`.
  - 없음 + 비-bundle → `./handicap.db`(현행 기본 유지).
- 순수 함수로 분리해 단위 테스트: `fn resolve_db_path(explicit: Option<&str>, data_dir: Option<&Path>) -> String`
  (data_dir 주입으로 결정론 테스트; main에선 `dirs::data_local_dir()` 주입).

### 5.6 브라우저 자동 오픈 (`open`, `bundle`)

- REST 리스너 bind **성공 후** `open::that(format!("http://localhost:{rest_port}"))` 호출(실패는
  치명적 아님 — `warn!`만, 사용자가 URL을 직접 열 수 있게 로그에 URL 출력).
- 새 플래그 `--no-open`(bundle, 기본 false)으로 끌 수 있음(헤드리스·라이브 검증·CI용).
- bundle 빌드라도 `worker` 서브커맨드 경로에선 브라우저를 **열지 않는다**(서브커맨드 분기에서만
  컨트롤러 부팅이 일어나므로 자연히 분리).

### 5.7 worker self-spawn 배선 (`bundle`)

- `SubprocessDispatcher`는 현재 `worker_bin`(예: `target/debug/worker`)을 spawn하고
  `--controller/--run-id/--worker-id`를 붙인다(`crates/controller/src/dispatcher/subprocess.rs`).
- bundle 모드에선 **`current_exe()` + `worker` 서브커맨드**로 spawn해야 한다. 최소 변경 설계:
  - `SubprocessDispatcher`에 **`leading_args: Vec<String>` 필드(기본 `[]`)** + 빌더
    `fn with_leading_args(mut self, args: Vec<String>) -> Self`를 추가한다. **`new(worker_bin,
    grpc_addr, db)` 3-인자 시그니처는 유지** → 기존 24+ 생성 사이트(main.rs·api/runs.rs·통합/e2e
    테스트) **전부 무변경**. dispatch는 `Command::new(&self.worker_bin)` 뒤에 `self.leading_args`를
    먼저 push한 뒤 기존 `--controller …`를 붙인다(빈 벡터면 spawn 명령 byte-identical).
  - 비-bundle: `leading_args=[]`, `worker_bin="target/debug/worker"`(현행) → byte-identical.
  - bundle: **main.rs에서만** `worker_bin = std::env::current_exe()?`(문자열화) +
    `with_leading_args(vec!["worker".into()])`로 dispatcher 생성 → spawn 시
    `handicap(.exe) worker --controller … --run-id … --worker-id …`. **`current_exe()`는 main.rs 한
    곳에서만 해석**(dispatcher·lib은 self-exe를 모름).
- 단일 워커: 라이트 부하는 컨트롤러 fan-out 산식상 N=1(`--worker-capacity-vus` 기본 2000 ≫ 소규모
  VU). fan-out 로직은 건드리지 않는다. (worker 자신의 `--capacity-vus`(기본 1000)는 dispatcher가
  애초에 전달하지 않으므로 이 결정과 무관 — 혼동 주의.)

### 5.8 포트 자동 회피 (`bundle`, D5)

- 현재 `main.rs`는 `TcpListener::bind(args.rest)`(REST) + `tonic … .serve(args.grpc)`(gRPC)로
  **요청 주소에 고정 바인딩**한다. gRPC는 tonic이 내부 바인딩하므로 실제 포트를 되읽을 수 없다.
- **재배선(main.rs, bundle 경로)**:
  1. REST·gRPC **둘 다 우리가 `TcpListener`로 직접 바인딩**하고 `local_addr()`로 실제 포트를 읽는다.
  2. gRPC(**bundle 경로만**)는 `Server::builder().add_service(svc).serve_with_incoming(TcpListenerStream::new(grpc_listener))`로
     서빙(요청 주소 대신 우리가 바인딩한 리스너 사용). **비-bundle 경로는 현행 `.serve(args.grpc)`
     그대로**(아래 게이트 참조 — serve *메커니즘*까지 현행 유지).
  3. **SubprocessDispatcher는 실제 gRPC 주소로 생성**(요청 주소가 아님) — dispatcher 생성 순서를
     바인딩 이후로 이동.
  4. 브라우저 오픈·로그는 실제 REST 포트 사용.
  - **Cargo 변경 불필요**: `TcpListenerStream`은 `tokio-stream`의 `net` 기능에 있고, controller 빌드엔
    이미 `net`이 켜져 있다 — 단 이는 **tonic이 `tokio-stream`의 `net`을 켜서 feature-unification으로
    들어오는 것**이지 `net`이 tokio-stream의 *default*라서가 아니다(tokio-stream default = `time`만,
    워크스페이스 줄은 `features=["sync"]`라 그 줄 자체는 `{time,sync}`만 켠다). 이 재배선 패턴은 이미
    e2e 테스트(`e2e_test.rs`·`multi_worker_fanout_e2e.rs`)가 동일하게 쓰는 검증된 형태다. **새로
    `tokio-stream`을 추가할 필요는 없다**(tonic이 `net`을 끌어옴). 안전을 위해 plan 단계에서
    `cargo build -p handicap-controller --features bundle`로 `net` 가용을 재확인하고, 만약 tonic의
    feature 전파가 바뀌어 `net`이 빠지면 controller `Cargo.toml`의 `tokio-stream`에 `"net"`을 명시
    추가한다(default-features를 조이는 게 아니라 feature 가산).
- **빈 포트 선택 헬퍼**(controller lib, 단위 테스트 대상):
  ```rust
  pub fn bind_with_fallback(preferred: SocketAddr, allow_fallback: bool) -> std::io::Result<TcpListener>
  ```
  - 우선 `preferred`에 바인딩 시도.
  - `AddrInUse`이고 `allow_fallback`이면 같은 IP의 **포트 0**(OS-할당 빈 포트)로 재바인딩.
  - 그 외 에러는 전파.
- **게이트**: `allow_fallback`은 **bundle 모드일 때만 true**. 비-bundle은 false → 현행처럼 사용 중
  포트면 에러로 실패(개발자는 명시 포트를 기대; dev byte-identical).
- **분기 방식 확정**: main.rs의 serve 경로를 `#[cfg(feature = "bundle")]`로 **갈라** — 비-bundle은
  현행 그대로(REST `axum::serve(TcpListener::bind(args.rest))` + gRPC `.serve(args.grpc)`, 폴백 없음,
  serve 메커니즘까지 불변), bundle만 위 1–4 재배선(`serve_with_incoming` + `bind_with_fallback`). 한
  줄 통일(`bind_with_fallback(addr, cfg!(feature="bundle"))`)은 비-bundle의 gRPC serve 메커니즘까지
  `serve_with_incoming`으로 바꿔 "wiring byte-identical"을 깨므로 **채택하지 않는다**. `bind_with_fallback`
  자체는 격리 함수라 양쪽 빌드에서 단위 테스트(fallback on/off)로 락.
- **테스트 한계 인지**: main.rs 배선(리스너 바인딩 순서·dispatcher 생성)은 in-process 통합/e2e가
  안 거치는 main-only 와이어링(controller CLAUDE.md). 따라서 `bind_with_fallback`·`resolve_db_path`
  같은 **순수/격리 함수는 단위 테스트**, 통합 배선은 **라이브 검증**(§7)으로 확인.

## 6. 빌드 레시피 런북 (문서 산출물)

`docs/dev/single-exe-build.md`(신규)에 **초보자가 그대로 따라할 수 있는** 단계별 가이드를 쓴다.
spec은 런북이 *담아야 할 내용*을 규정한다(실제 문장은 plan/구현에서 작성):

### 6.1 macOS/Linux 자체완결 바이너리 (이 머신에서 검증용)
1. 사전: Rust toolchain·protoc·Node+pnpm(개발 환경 세팅 — 루트 CLAUDE.md 참조).
2. `cd ui && pnpm install && pnpm build` → `ui/dist` 생성(임베드 입력).
3. `cargo build --release --features bundle` → `target/release/controller`.
4. 실행: `./target/release/controller`(인자 없음) → 브라우저 자동 오픈.

### 6.2 Windows `.exe` 빌드 — **초보자용 상세** (필수)
런북은 아래를 **명령·스크린샷 수준 단계로** 기술한다(D1: 이 머신에선 검증 불가, 문서만):

1. **Visual Studio C++ 빌드 도구 설치** (Rust MSVC 링커가 필요):
   - "Build Tools for Visual Studio" 다운로드 페이지 안내 → 설치 시 **"C++를 사용한 데스크톱
     개발"(Desktop development with C++)** 워크로드 체크. 왜 필요한지 한 줄 설명(Rust가 링킹에 MSVC
     사용).
2. **Rust 설치**: `rustup` (`https://rustup.rs`) 실행 → 기본(MSVC) toolchain 선택. 설치 후
   `rustc --version` 확인.
3. **protoc(Protocol Buffers 컴파일러) 설치**: `winget install protobuf`(또는 수동 다운로드 +
   PATH 추가) → `protoc --version` 확인. 왜 필요한지(tonic-build이 빌드 타임에 사용).
4. **Node.js + pnpm 설치**: Node LTS 설치(`winget install OpenJS.NodeJS.LTS`) → `npm i -g pnpm`
   (또는 `corepack enable`) → `pnpm --version` 확인.
5. **소스 가져오기**: repo 클론 또는 소스 복사.
6. **UI 빌드**: `cd ui` → `pnpm install` → `pnpm build`(`ui\dist` 생성).
7. **단일 exe 빌드**: 저장소 루트에서 `cargo build --release --features bundle`.
8. **결과물**: `target\release\controller.exe` → `handicap.exe`로 리네임.
9. **실행**: `handicap.exe` 더블클릭 → 브라우저가 `http://localhost:<port>` 자동 오픈. (포트 충돌
   시 자동 회피됨을 안내.)
10. **데이터 위치**: `%LOCALAPPDATA%\handicap\`(DB 등). 삭제/백업 방법 한 줄.
11. **문제 해결**: 백신/SmartScreen 경고(서명 안 된 exe), 방화벽 프롬프트(localhost는 허용),
    포트 안내.

### 6.3 (선택) CI 부록
- GitHub Actions `windows-latest` 러너에서 위 단계를 자동화하는 워크플로 **예시 YAML**을 *부록*으로.
  **remote 미설정이라 지금은 동작 안 함** — "GitHub에 올리면 쓸 수 있는 참고용"이라 명시.

## 7. 검증 계획

### 7.1 단위 테스트 (macOS에서 실행)
- worker lib 추출: 인라인 단위 테스트는 헬퍼와 함께 `lib.rs`로 **이동**해 통과(파일 위치만 변경,
  로직 불변), 통합/e2e 테스트는 무변경 통과(회귀 가드).
- `resolve_db_path`: (명시 우선 / bundle→data-dir / 비-bundle→`./handicap.db`) 케이스.
- `bind_with_fallback`: 사용 중 포트 + fallback=true → 다른 포트 바인딩 성공 / fallback=false →
  `AddrInUse` 에러 전파.
- 멀티콜 arg 파싱: 서브커맨드 없음=컨트롤러 / `worker …`=worker args 파싱(기존 컨트롤러 평면 호출
  `--db … --ui-dir …`이 여전히 파싱되는지 회귀).
- 임베드 UI fallback 핸들러(bundle): 존재 에셋→200+content-type / 미존재 경로→index.html 200.

### 7.2 라이브 검증 (`/live-verify`, macOS — 슬라이스 "완료" 기준)
- `cd ui && pnpm build && cd .. && cargo build --release --features bundle`.
- `./target/release/controller --no-open --rest 127.0.0.1:0`(또는 기본 포트) 기동 →
  - 로그에 실제 REST/gRPC 포트 + 데이터 폴더 경로 출력 확인.
  - `GET /`(UI index) 200, 임베드 자산 200.
  - 시나리오 생성 → run 1개 생성 → **worker가 `controller worker …` self-spawn으로 도는지** 로그
    확인 → run `completed` → `/report`가 `ReportSchema` 통과(S-D 갭 차단).
- 포트 충돌 회피: 8080을 먼저 점유한 뒤 인자 없이 기동 → 자동으로 다른 포트 바인딩 + 그 포트
  로그 확인.

### 7.3 게이트
- 비-bundle: `cargo build --workspace` / `cargo clippy --workspace --all-targets -D warnings` /
  `cargo nextest run --workspace` + doctest / UI `pnpm lint && pnpm test && pnpm build` 전부 green
  (현행 byte-identical 확인).
- bundle: `cargo build --release --features bundle` + bundle-게이트 단위 테스트 green.

## 8. 함정 / 위험

- **rust-embed debug 빌드는 디스크 런타임 읽기**(임베드 아님) → 라이브 검증·배포는 `--release`(§5.4).
- **`ui/dist` 미존재 시 bundle 컴파일 실패** → 런북·라이브 검증이 항상 `pnpm build` 선행(§6).
- **main-only 와이어링은 통합/e2e가 안 잡는다**(controller CLAUDE.md) → 격리 함수 단위 + 라이브
  검증으로 커버(§5.8, §7).
- **tracing 전역 subscriber 이중 init 패닉** → `run()`은 init 안 함, 호출자가 1회(§5.1).
- **clap 평면 필드 + optional 서브커맨드 혼용**으로 기존 `--db …` 평면 호출이 깨질 위험 → 회귀
  단위 테스트로 락(§7.1).
- **포트 0 폴백 시 실제 포트 전파 누락**(브라우저/worker가 옛 포트를 봄) → dispatcher를 바인딩
  *이후* 실제 주소로 생성, 브라우저도 실제 포트(§5.8).
- **prost/struct-literal 함정 없음**(proto·DB·migration 무변경) — 이 슬라이스는 패키징·배선이 주.
- **tdd-guard C-1(keepalive)**: 새 `crates/worker/src/lib.rs`를 만들면서 같은 task에서 `main.rs`를
  편집하면 가드가 막힐 수 있다 — 인라인 `#[cfg(test)]`를 lib로 *이동*하므로 lib.rs엔 디스크 시점에
  `#[cfg(test)]`가 있어 자동통과 대상이지만, 첫 Write 타이밍에 따라 `crates/worker/tests/_tdd_keepalive.rs`
  (trivial `#[test]`) 선깔기가 필요할 수 있다(task 끝에 `rm`). plan task 1이 명시.

## 9. ADR 필요 여부

이 작업은 **ADR-0039 옵션 A의 구현**이라 새 ADR이 필수는 아니다. 다만 "멀티콜(방법 1) 채택 +
embed/extract(방법 2) 거절"은 기록할 가치가 있으므로:
- 1차안: 본 spec + `docs/build-log.md`에 결정 근거를 남긴다(새 ADR 없음).
- 마무리 시 ADR-0039에 **한 줄 보강**("구현은 멀티콜 단일 바이너리 + cargo `bundle` 기능")을 검토.

새 ADR을 만들지는 finish 단계에서 결정한다(현 인덱스 규칙: 새 결정만 ADR).

## 10. 작업 분해 (plan에서 상세화)

대략적 순서(각 독립 green 커밋 가능하게 plan이 task로 분해):
1. worker lib 추출(`run()` + 헬퍼 + 인라인 테스트 lib로 이동, `WorkerArgs` lib 정의) + main 얇은
   래퍼 + `init_worker_tracing()` (로직 불변, 테스트 relocate 후 green; 필요 시 keepalive).
2. controller `bundle` 기능 + 선택적 worker dep + 멀티콜 서브커맨드 (+arg 파싱 테스트).
3. `resolve_db_path` + `dirs` 데이터 폴더 (+단위 테스트).
4. `bind_with_fallback` 포트 회피 + main.rs 바인딩 재배선(dispatcher 실제-주소 생성) (+단위 테스트).
5. rust-embed UI 임베드 + app.rs 임베드 fallback (+핸들러 테스트).
6. 브라우저 자동 오픈 + `--no-open` + worker self-spawn 배선(dispatcher leading-args).
7. 빌드 런북 문서(`docs/dev/single-exe-build.md`) — 초보자 Windows 상세 + macOS/Linux + CI 부록.
8. 라이브 검증.
