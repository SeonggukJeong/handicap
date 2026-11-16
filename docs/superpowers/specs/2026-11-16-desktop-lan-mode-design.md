# 데스크톱 앱 서버 모드 1차 (desktop-lan-mode) — 설계

- 날짜: 2026-11-16
- 상태: 완료 (2026-11-17, 코드 `81348247`..`c6f5d791`, 라이브 US1–US5 통과; 판단·연기 roadmap §B64, 2차 = 부하기 쪽 버튼 §8)
- 유형: user-path (+ correctness-bug: 포터블 exe `--worker-mode pool` 무시)
- 출처: 사용자 요청(2026-11-16) — "그냥 프로그램 열고 서버 버튼 누르면 서버가 되고, 부하기들은 접속 버튼 눌러서 접속하고 그렇게는 안되나?"
- 관련: ADR-0041(LAN 풀 L1), ADR-0042(Tauri in-process 임베드), ADR-0039(라이트 Windows 배포), `docs/dev/lan-workers.md`
- 범위: **1차 = 서버 쪽.** 부하기 쪽 버튼(접속 코드 붙여넣기·상태 화면)은 2차(§8). 1차만으로도 부하기 PC는 앱 화면이 만들어 준 명령 한 줄을 붙여넣어 합류할 수 있다.

## 사용자 스토리 (US)

- **US1**: QA가 서버 PC 앱의 상단 메뉴에서 「모드 전환」을 눌러 역할 화면으로 가 「서버로 열기」를 누른다 — 성공하면 다시 켜지는 동안 화면 전체에 「서버 모드로 전환 중…」이 떠서 클릭이 막히고, 끝나면 역할 화면에 「서버로 열려 있음」과 이 PC의 IP가 보인다. 화면으로 돌아가면 앱의 모든 화면(모니터 전체 화면·인쇄 화면 제외 — `Layout` 밖) 상단에 「서버 · 부하기 N대」 표시가 보인다. 앱을 껐다 켜도 서버 모드로 다시 열린다. 같은 망의 다른 PC에서 서버의 화면 주소로 접속하면 연결되지 않는다.
- **US2**: QA가 서버 PC 역할 화면에서 「이 PC도 부하 내기」를 켠다(처음부터 켜져 있음) — 성공하면 「워커」 화면에 서버 PC 자신이 부하기로 나타나고, 테스트를 돌리면 그 PC에도 부하가 나눠진다. 그 PC가 테스트를 실행하는 중에는 토글이 잠겨 있다.
- **US3**: QA가 서버 PC 역할 화면에서 부하기 PC의 OS(Windows / macOS / Linux)를 고르고 「부하기 PC용 명령 복사」를 눌러 부하기 PC의 터미널(Windows는 PowerShell)에 붙여넣는다 — 성공하면 서버 「워커」 화면에 그 PC 이름이 나타나고, 테스트를 돌리면 그 PC로도 부하가 나눠진다. 8081이 이미 쓰이는 PC라 다른 포트로 열렸으면 역할 화면에 그 사실과 "부하기들에 새 명령을 주세요"가 보이고 복사되는 명령도 새 포트다.
- **US4**: QA가 테스트 실행 중에 역할을 바꾸려 한다(「혼자 쓰기로 돌아가기」 또는 「서버로 열기」) — 성공하면 「실행 중인 테스트 N개가 중단됩니다」 확인 창이 뜨고, 취소하면 아무것도 바뀌지 않는다. 확인하면 전환 중 표시 뒤 새 역할로 열린다: 혼자 쓰기로 갔으면 원래처럼 이 PC 혼자 부하를 내고, 서버로 갔으면 US1의 서버 상태가 된다. 어느 쪽이든 중단된 테스트의 상태 배지는 `failed`(빨강)가 아니라 `aborted`(주황)다(배지는 지금도 상태 원문을 그대로 쓴다 — `StatusBadge.tsx`).
- **US5** (버그): 도입담당이 포터블 exe를 `--worker-mode pool --grpc 0.0.0.0:8081 --worker-token T`로 실행한다 — 성공하면 「워커」 화면이 풀 모드 화면으로 뜨고, `worker --controller … --token T`로 붙인 부하기가 그 화면에 나타난다.

### 재현 / 기대 / 실측 (US5)

- **재현**: 포터블 exe(`cargo build -p handicap-controller --bin controller --features bundle`, `release.yml:95`)를 `--worker-mode pool`로 실행.
- **실측(지금)**: bundle 빌드는 `main.rs:151` `run_bundle(args)`로 가고, 그 `InProcessConfig` 리터럴(`main.rs:382-398`)이 `args.worker_mode`를 읽지 않아 `run_in_process`가 Subprocess로 뜬다(`in_process.rs:262-271`). 플래그는 **조용히 무시**된다 — 부하기를 붙여도 `pool_mode:false`라 풀에 안 들어간다. 또 gRPC는 `bind_with_fallback(…, true)`(`in_process.rs:258`)라 8081이 사용 중이면 조용히 다른 포트로 간다.
- **기대**: 풀 모드로 뜨고, 명시한 gRPC 포트가 사용 중이면 빈 포트로 가지 말고 에러로 멈춘다(비-bundle CLI와 같은 동작 — `launch.rs` 주석 "비-bundle은 현행처럼 사용 중이면 에러").

## 1. 배경 — 지금 동작

- **설치판 앱(Tauri, `desktop/`)** 은 컨트롤러를 앱 프로세스 안에서 띄운다(`desktop/src-tauri/src/lib.rs` → `backend.rs` `InProcessBackend::start` → `handicap_controller::in_process::run_in_process`). 이 경로는 **혼자 쓰기로 고정**이다(`in_process.rs:91` "고정: worker_mode = Subprocess", REST·gRPC `127.0.0.1:0`, dispatcher 항상 `SubprocessDispatcher`).
- 앱 창은 셸 페이지 `splash.html`(`desktop/src/`, frontendDist)로 열렸다가 컨트롤러가 뜨면 `http://127.0.0.1:<port>/`(컨트롤러가 서빙하는 React UI)로 navigate한다. UI는 Tauri API를 쓰지 않는다(`grep -rn "@tauri-apps\|__TAURI" ui/src ui/package.json` 0건). capability는 `core:default` 하나.
- **풀 모드는 비-bundle CLI 컨트롤러에만 있다**: `main.rs:225-229`(`WorkerMode::Pool` → `set_pool_mode(true)` + `NoopDispatcher`). bundle(포터블 exe·셸)이 쓰는 `run_in_process`엔 없다(US5).
- 워커 쪽 `run_pool`(`crates/worker/src/lib.rs:480`)은 bundle에서도 동작한다(`<exe> worker …` 멀티콜). 단 취소는 SIGTERM 토큰뿐(`spawn_sigterm`) — 외부에서 멈출 수단이 없다.
- `run_in_process` 호출부: 셸 `backend.rs:31`, 포터블 `main.rs:401`(리터럴이 **전 필드 명시 — 필드를 더하면 여기가 컴파일 에러**), TUI `crates/tui/src/session.rs:112`(`..Default`), 테스트 `in_process.rs:546`·`tests/in_process_feature_test.rs:10`(`..Default`).
- 셸 종료 브리지 `ControllerBackend::shutdown`은 동기 메서드 안에서 `tauri::async_runtime::block_on`(`backend.rs:42-46`) — `RunEvent::Exit`(메인 스레드)에서만 안전하다. 비동기 명령(tokio 워커 스레드) 안에서 부르면 nested-runtime panic.
- 재기동 시 실행 중 run: `abort_all`(`in_process.rs:152`)은 메모리상 abort만 보내고, 다음 `run_in_process`가 `mark_orphans_failed("controller restarted…")`(`in_process.rs:238`)로 **실패**로 찍는다. DB에 `aborted`를 쓰는 함수는 `store::runs::mark_aborted`(`store/runs.rs:429`).
- UI의 풀 데이터 훅 `usePoolWorkers`(`ui/src/api/hooks.ts:514`)는 `pool_mode`가 참일 때만 3초 폴링한다.

## 2. 접근

| 안 | 내용 | 판단 |
|---|---|---|
| **A (채택, 사용자 선택)** | 셸이 역할·토큰을 자기 설정 파일에 저장하고, 역할을 바꾸면 in-process 컨트롤러를 새 설정으로 **다시 띄운다**. 역할 조작은 **셸 자체 화면**(셸 origin)에서. | 검증된 기동·종료 경로 재사용. 엔진·run 배정 핵심 무변경. |
| B | 컨트롤러를 켠 채 dispatcher·풀 모드 런타임 교체 | 재기동 1~2초를 아끼려고 `spawn_run`·풀 예약을 런타임 가변으로. 기각. |
| C | 네이티브 메뉴바 + 별도 창 | 평소 화면과 떨어져 찾기 어려움. 기각(R6 탐지 실패 시의 대안으로만 남김). |

역할 조작 위치(사용자 결정 2026-11-16): React 「설정」 화면 안에 직접 두지 않고 **셸 자체 화면**으로. 이유 = 컨트롤러가 서빙하는 `http://127.0.0.1:<port>` 페이지(원격 origin)에서 셸 명령을 부르려면 원격 IPC 허용·UI CSP(`connect-src 'self'`, `ui/index.html:7-8`)·플랫폼별 IPC 전송 차이를 넘어야 하고 이 맥에서 Windows 동작을 확인할 수 없다. 또 UI에 XSS가 생기면 토큰·역할 전환까지 닿는다. 셸 화면은 셸 origin이라 IPC가 기본으로 되고, 토큰은 그 화면 밖으로 나가지 않는다.

다른 사용자 결정: 역할은 기억한다 · 서버 화면(REST)은 서버 PC에서만 · gRPC 포트가 막히면 빈 포트로 열고 저장 · 2회로 나눔(이 문서 = 1차) · 포터블 exe 버그를 같이 고침 · 「새 접속 코드 만들기」는 나중.

## 3. 요구사항

### R0 — 지킬 조건

- 셸 설정 파일이 없거나 역할이 「혼자 쓰기」면 앱 동작은 지금과 같다(REST·gRPC `127.0.0.1:0`, Subprocess, 토큰 없음). React UI에 새로 생기는 것은 상단 메뉴의 「모드 전환」 링크(데스크톱 앱 안에서만)와 풀 모드 칩(풀 모드일 때만)뿐. **의도된 차이 하나**: 앱 종료 시 실행 중이던 run을 `aborted`("앱 종료로 중단")로 기록한다(지금은 다음 시작 때 `failed` "controller restarted…"가 된다; R2·R8). 이 기록은 셸이 부르는 별도 함수이고 `RunningController::shutdown()` 자체는 바뀌지 않는다 — TUI(`crates/tui/src/session.rs`)는 무변경.
- 포터블 exe를 `--worker-mode` 없이(기본 subprocess) 실행하면 지금과 같다 — **단 하나의 의도된 차이**: gRPC 포트 fallback이 `AddrInUse`뿐 아니라 `PermissionDenied`(Windows Hyper-V/WSL 예약 포트 범위의 WSAEACCES)에도 빈 포트로 간다(R3; 지금은 그 경우 시작 에러로 멈춘다). REST fallback은 그대로.
- 포터블 exe의 **의도된 동작 변경**(지금까지 조용히 무시되던 플래그): `--worker-mode pool`은 풀로 뜨고 토큰이 필수, `--worker-mode kubernetes`는 bundle에서 지원하지 않는다는 에러로 멈춘다(지금은 조용히 subprocess). §7.3.
- 비-bundle CLI 컨트롤러·CLI 워커(`run`/`run_pool`)의 인자·동작·로그는 같다. TUI·테스트의 `run_in_process` 호출은 `..Default`라 무변경 — `InProcessConfig::default()`는 지금 값을 유지한다(단위 테스트로 잠금).
- proto·migration·REST 엔드포인트 추가 0(§5). 엔진 무변경.

### R1 — 역할 저장 (셸)

- 셸 설정 디렉터리(Tauri `app_config_dir`; 라이브 검증용 env override 허용)의 JSON 한 파일: 역할(`local` | `server`), 서버 설정(토큰, gRPC 포트 기본 `8081`, 「이 PC도 부하 내기」 기본 켜짐). 2차가 `worker` 역할과 부하기 설정을 더한다 — 모르는 역할 값은 R1 폴백 규칙을 따른다.
- 파일이 깨졌거나 모르는 역할이면 「혼자 쓰기」로 뜨고 역할 화면에 "저장된 역할 설정을 읽지 못해 혼자 쓰기로 열었습니다"를 보인다. 그 파일은 다음 저장 때 교체한다(그 전엔 덮어쓰지 않음).
- 역할은 **전환이 성공한 뒤에만** 저장한다. 앱 시작 시 저장된 역할로 바로 뜬다. 시작 시 서버 모드가 실패하면 R6 실패 화면.
- 순수 로직(읽기·폴백·쓰기 직렬화)은 §6의 워크스페이스 크레이트에.

### R2 — in-process 풀 모드 (컨트롤러, US1·US5)

- `InProcessConfig`에 워커 모드(Subprocess 기본 / Pool)와 gRPC 포트 fallback 여부(기본 `true` = 지금)를 더한다. Pool이면 `set_pool_mode(true)` + `NoopDispatcher` — 비-bundle `main.rs:225-229`와 같은 배선. 하트비트 리퍼는 이미 `is_pool_mode()`로 켜진다(`in_process.rs` 9단계).
- Pool인데 `worker_token`이 `None`이거나 **비었거나 공백뿐이면** `run_in_process`가 `Err`(풀을 무인증으로 열지 않음 — `--worker-token ""`은 `Some("")`이고 `--token` 없는 워커가 `""`를 보내 `check_token`이 통과시킨다, `worker/src/lib.rs:485`). 단위 테스트로 잠근다. 셸은 항상 토큰을 넣는다. 포터블 exe가 `--worker-mode pool`을 토큰 없이 받으면 같은 에러로 멈춘다 — **동작 변경**(비-bundle CLI는 토큰 없는 풀을 허용한다; 포터블은 지금까지 풀 자체가 안 됐으므로 회귀가 아니다). 에러 문구에 `--worker-token`을 적는다.
- `RunningController`에 활성 run 수 접근자와 "활성 run을 `aborted`로 기록하고 abort 전송" 함수를 더한다. 기록은 **가드 단일 UPDATE**(`SET status='aborted', ended_at=?, message=? WHERE id=? AND status IN ('pending','running')`) — 무가드 `mark_aborted`(`store/runs.rs:429-436`)를 쓰면 조회와 기록 사이에 끝난 run이 `completed`→`aborted`로 덮인다(테스트로 잠금). 메시지는 전환이면 "모드 전환으로 중단", 앱 종료면 "앱 종료로 중단"(R8 — 종료도 같은 기록을 써서 다음 시작 때 `failed`로 뒤집히지 않게). 재기동 뒤 `mark_orphans_failed`는 `WHERE status IN ('pending','running')`(`store/runs.rs:513-518`)라 이미 `aborted`인 행을 건드리지 않는다 — 테스트로 잠근다.
- `RunningController`에 풀 스냅샷 접근(이 PC 부하기가 실행 중인지 — R4 토글 잠금용).
- **포터블 exe**: `run_bundle`(`main.rs:382`)이 `args.worker_mode`를 새 필드로 넘긴다(Kubernetes는 bundle에서 거절 — 에러). Pool이면 gRPC fallback `false`(사용자가 명시한 포트), 아니면 `true`(지금 그대로). 이 리터럴은 bundle 전용이라 pre-commit이 컴파일하지 않는다 → §6 수동 게이트.

### R3 — 서버 모드 바인드 (셸)

- REST는 **언제나 `127.0.0.1:0`**(사용자 결정 — 다른 PC에서 화면 접근 불가). gRPC만 `0.0.0.0:<저장된 포트>`, fallback `true`. gRPC fallback은 `AddrInUse`와 `PermissionDenied` 둘 다에서 빈 포트로 간다(Windows 예약 포트 범위는 `PermissionDenied` — 그대로 두면 사용자 결정 "막히면 빈 포트"가 서버 모드 실패로 바뀐다; R0 의도된 차이). REST bind의 fallback 규칙은 무변경 — 지금 두 bind가 `bind_with_fallback`을 공유하므로(`in_process.rs:256,258`, 유일한 호출부 둘) gRPC 전용 변형을 두고, 에러 종류 판정은 순수 술어(`AddrInUse | PermissionDenied`)로 단위 테스트한다(EACCES는 플랫폼마다 재현이 안 된다 — macOS는 일반 사용자도 낮은 포트 bind 가능).
- 실제 gRPC 포트(`RunningController::grpc_addr()`)가 저장 포트와 다르면: 새 포트를 저장하고, 역할 화면에 "부하기 접속 포트 <옛>을 다른 프로그램이 쓰고 있어 <새>로 열었습니다 — 부하기들에 새 명령을 주세요"를 보인다(사용자가 닫을 때까지). 옛 포트로 붙던 부하기는 연결 실패 재시도 상태가 된다(지금 CLI 워커 동작).
- 토큰: 서버 모드를 처음 켤 때 OS CSPRNG로 128비트 이상(ULID 금지 — 무작위 80비트), 영숫자 인코딩(PowerShell 인용 없이 안전). 저장 후 재사용.

### R4 — 이 PC도 부하 내기 (US2)

- 켜져 있으면 셸이 in-process 풀 워커 하나를 `http://127.0.0.1:<실제 gRPC 포트>` + 토큰 + 부하기 ID = PC 이름(`stable_id`)으로 돌린다. 끄면 멈춘다. 컨트롤러 재기동 없이 즉시.
- worker lib에 **외부 취소 토큰을 받는 풀 진입점**을 더하고 CLI `run_pool`은 그것을 SIGTERM 토큰으로 부르는 래퍼로(R0 — 동작·로그 동일, 테스트로 잠금). 1차는 상태 보고 훅을 더하지 않는다(2차).
- 토글 잠금: 이 PC 부하기가 run을 실행 중일 때만(R2 풀 스냅샷). 잠금 문구 "이 PC가 테스트를 실행하는 중이라 끝난 뒤 바꿀 수 있습니다".
- 대시보드 「제외」로 서버가 이 PC 부하기를 내보내면(`Disconnect` → 워커가 취소 토큰을 cancel하고 끝남) 토글을 꺼짐으로 바꾸고 저장, "워커 화면에서 이 PC를 제외해 꺼졌습니다" 표시. 셸이 끈 것과 구별하려면 셸이 넘긴 토큰의 자식 토큰을 워커에 준다(누가 cancel했는지 셸이 안다).
- PC 이름이 비면 R4를 시작하지 않고 토글 옆에 "PC 이름을 읽지 못해 쓸 수 없습니다".
- 같은 PC 이름의 부하기가 둘이면 대시보드가 하나로 합쳐 보인다(`pool_register_idle`가 같은 ID의 tx 교체, `coordinator.rs:398-406`) — 알려진 한계로 문서화(복제 이미지 PC).

### R5 — 부하기 PC용 명령 (US3)

- 사용자 결정(2026-11-17): Windows 전용으로 만들지 않는다. 역할 화면에서 **부하기 PC의 OS**(Windows / macOS / Linux — 기본값은 서버 PC의 OS)를 고르면 그 OS용 복사 명령을 만든다. 공통 꼴: `<실행 파일> worker --controller http://<IP>:<포트> --token <토큰> --worker-id <PC 이름>`.
  - **Windows**(PowerShell): 실행 파일 `.\Handicap_<앱 버전>_x64-portable.exe`(`release.yml:140` 규칙), PC 이름 `$env:COMPUTERNAME`. 안내: "같은 버전의 포터블 exe를 받아 두고 그 폴더의 PowerShell에 붙여넣으세요".
  - **macOS**(터미널): 실행 파일 = 설치한 앱 번들 안의 실행 파일(이름은 `desktop` — desktop/CLAUDE.md "dmg 안의 실행파일 이름"; 기본 설치 경로 `/Applications/Handicap.app/Contents/MacOS/desktop`), PC 이름 `"$(hostname)"`. 안내: "같은 버전의 앱을 응용 프로그램 폴더에 설치하고 한 번 열어 허용한 뒤(또는 `xattr -dr com.apple.quarantine /Applications/Handicap.app`) 터미널에 붙여넣으세요"(ad-hoc 서명이라 격리 표시가 남아 있으면 Gatekeeper가 막는다 — README §C).
  - **Linux**(터미널): 실행 파일 = AppImage(`./<AppImage 파일 이름>` — 파일 이름 규칙은 구현 시 `release.yml` ubuntu-gui 잡 산출물로 확정) 또는 deb 설치 경로(구현 시 `.deb` 내용으로 확정), PC 이름 `"$(hostname)"`. 안내: "AppImage 폴더에서 붙여넣으세요(실행 권한 필요)".
  - macOS·Linux엔 포터블 exe가 없다 — 설치판 바이너리의 멀티콜 `worker …`(desktop `main.rs` `run_worker_if_invoked`)가 같은 역할을 한다. 각 OS 명령의 실행 파일 경로는 **구현 중 실제 빌드 산출물로 확정**(이 문서의 경로는 가설 — 불일치 시 plan 정정).
  - 토큰·주소는 셸 인용 없이 안전한 문자만 쓰므로(R3 토큰 영숫자) 세 셸 모두 그대로 붙여넣어 동작해야 한다.
- IP 후보: 켜진 인터페이스의 사설 IPv4(10/8·172.16/12·192.168/16), loopback·link-local 제외. 사설이 0개면 loopback·link-local 아닌 IPv4 전부. 여러 개면 목록으로 보이고 고른 IP로 명령을 만든다(첫 항목 기본). 0개면 "이 PC의 망 주소를 찾지 못했습니다"(명령 칸 비움). 역할 화면을 열 때마다 다시 읽는다(IP가 바뀌는 경우).
- 순수 함수(IP 선택·명령 조립)는 §6 크레이트에, 인터페이스 목록은 주입.

### R6 — 역할 화면·전환 흐름 (US1·US4)

- **진입**: React 상단 메뉴(`Layout` nav, 「워커」 옆)에 「모드 전환」 링크(데스크톱 앱 안에서만). (「설정」이라 불렀던 `/settings` 화면은 실제 제목이 「운영 상한」이라 역할 조작과 맞지 않아 상단 메뉴로 — plan 작성 중 정정 2026-11-17.) 데스크톱 판별과 셸 화면 주소는 셸이 페이지에 넣어 주는 **읽기 전용 표지**로 안다(Tauri 초기화 스크립트 — 원격 origin 페이지에도 들어가는지, 그리고 `tauri.conf.json`에 정의된 창엔 초기화 스크립트를 달 수 없으므로 어떻게 설치하는지(예: `setup`에서 창을 직접 만들기·플러그인 `js_init_script`)를 §9 첫 task에서 실측). 표지는 `{rolePageUrl}` 하나 — 앱 실행 동안 불변이라 창을 재사용해도 낡지 않는다. 현재 역할은 넣지 않는다(칩은 REST `pool_mode`를 읽는다). 비밀 없음. 표지가 없으면 링크를 그리지 않는다(브라우저·포터블 exe = R0).
- **역할 화면(셸 페이지)**: 틀(frame) 안에서 열리면 아무것도 그리지 않고 명령도 부르지 않는다(`window.top !== window.self` 가드 — 토큰·IPC가 있는 화면을 다른 페이지가 감싸 클릭을 유도하는 것 차단; meta CSP로는 `frame-ancestors`를 못 건다). 화면 제목 「모드 전환」. 내용: 현재 모드 줄(「현재 모드: 혼자 쓰기」 / 「현재 모드: 서버로 열려 있음」), 「서버로 열기」 또는 「혼자 쓰기로 돌아가기」, 서버일 때 IP 목록·부하기 명령 + 「복사」(복사됨 피드백)·포트 변경 안내·「이 PC도 부하 내기」 토글·방화벽 안내(서버 PC의 OS별 한 줄 — Windows: "처음에 묻는 「액세스 허용」을 눌러 주세요 — 놓쳤다면 docs/dev/lan-workers.md §1" / macOS: "「들어오는 네트워크 연결을 허용하겠습니까?」 창이 뜨면 허용을 눌러 주세요"(macOS 방화벽은 기본 꺼짐이라 안 뜰 수 있음) / Linux: "방화벽(ufw)을 쓰고 있다면 `sudo ufw allow <포트>/tcp`"), 「화면으로 돌아가기」. 설정 읽기 실패 안내(R1).
- **확인 창**: 활성 run이 1개 이상이면 "실행 중인 테스트 N개가 중단됩니다". 취소 = 아무 변화 없음. 0개면 확인 창 없이 전환.
- **전환 중 표시**: 역할 화면에서 확인하면 같은 셸 화면이 「서버 모드로 전환 중…」/「혼자 쓰기로 돌아가는 중…」과 진행 표시로 바뀌고 버튼이 모두 막힌다. 최소 표시 시간(구현 판단 ~600ms)으로 깜빡임 방지. 끝나면 역할 화면에 결과(「서버로 열려 있음」 등)를 보인다 — 사용자가 결과를 읽고 「화면으로 돌아가기」로 UI에 간다.
- **전환 순서**(R8 정지 경로와 같음): 활성 run aborted 기록·abort → 이 PC 부하기 정지 → 컨트롤러 shutdown → 새 설정으로 `run_in_process` → (서버 + 토글 켜짐이면) 이 PC 부하기 시작 → 역할 저장.
- **실패**(DB·bind 등): 역할 화면에 사유 + 「혼자 쓰기로 돌아가기」. 저장된 역할은 그대로(성공 후 저장 규칙).
- **상단 칩**: React UI 네비게이션에 `pool_mode`가 참이면 「서버 · 부하기 N대」(N = `usePoolWorkers`의 연결된 워커 수, 이 PC 부하기·배정 중단 워커 포함). 클릭 → `/workers`. `pool_mode`가 거짓이면 없음. 데스크톱 판별과 무관(풀 모드 CLI 컨트롤러에서도 보임 — 의도: 풀 모드임을 늘 알림). 기존 훅의 폴링 규칙 그대로(풀 모드면 모든 화면에서 3초 폴링 — 예상된 비용). `Layout`에 훅을 넣으면 `Layout.test.tsx`(QueryClient 없음·`useVersion`만 mock)가 깨지므로 plan의 UI task가 그 테스트의 mock을 함께 고친다.
- 탐지 실패 대안(§9 STOP 조건): 초기화 스크립트가 원격 페이지에 안 들어가면 셸 네이티브 메뉴 「모드 전환…」로 역할 화면을 연다(웹 화면의 링크는 없음). US1 관찰("상단 메뉴에서")만 "앱 메뉴바에서"로 바뀐다 — 그 경우 사용자 확인 후 plan을 고친다.

### R7 — 셸 명령 (IPC, 셸 origin 페이지 전용)

- 역할 화면만 쓰는 명령: 상태 조회(역할·포트·포트 변경 안내·토글·이 PC 부하기 실행 중 여부·설정 읽기 실패·IP 후보·명령 문자열), 역할 전환, 토글 설정, 활성 run 수 조회, 안내 닫기, 화면으로 돌아가기(navigate).
- capability는 셸 origin 창 한정. **원격 origin(`127.0.0.1`)에는 IPC를 열지 않는다.** 토큰은 셸 페이지의 명령 응답에만 실리고 REST·로그·리포트에는 없다(`InProcessConfig` Debug 가림 유지·새 필드도 비밀이면 가림).

### R8 — 종료와 정지 경로

- 역할 전환·앱 종료가 같은 정지 경로: 활성 run `aborted` 기록·abort 전송(R2, 메시지만 다름) → 이 PC 부하기 취소·대기(bounded) → 컨트롤러 shutdown(drain, bounded). **기록이 먼저**: 실행 중인 이 PC 부하기를 먼저 끊으면 `worker_disconnected`가 `mark_failed_if_active`로 `failed`를 먼저 써서 뒤의 가드 UPDATE가 그 행을 건너뛴다(US4가 `failed`로 보임). 기록 뒤의 쓰기는 모두 가드되어 있어(`set_status`의 `status != 'aborted'`·`mark_failed_if_active`의 `IN ('pending','running')`, `store/runs.rs:411·466`) `aborted`가 유지된다. 부하기는 컨트롤러 **전에** 멈춘다(죽어 가는 컨트롤러에 재접속 루프를 돌지 않게).
- 셸 상태는 "백엔드 없음 / 컨트롤러 + (선택) 이 PC 부하기"를 담는 구조로 바꾸고, 정지는 **비동기** 경로를 둔다(명령 안에서 `block_on` 금지). `RunEvent::Exit`의 동기 브리지는 지금처럼 메인 스레드에서 비동기 경로를 `block_on`.

## 4. 범위 밖 (하지 않는 것)

- 부하기 PC의 버튼 방식(접속 코드·상태 화면) — 2차(§8).
- 같은 망 자동 찾기 — 2차 뒤(사용자: "나중에 브로드캐스트까지 시도해보자").
- 「새 접속 코드 만들기」(토큰 재발급) — 사용자 결정 "나중에".
- 다른 PC에서 서버 화면 접근·로그인 — 사용자 결정(아니요).
- 사용자가 포트를 직접 고르는 칸, 방화벽 규칙 자동 생성, gRPC TLS.
- 포터블 exe의 버튼 방식 — 사용자 결정(설치판만). 포터블은 US5 버그 수정만.

## 5. 와이어

- proto·migration·REST 추가 0. 엔진 0.
- 셸 ↔ 셸 페이지 IPC는 새 계약(같은 `desktop/` 안 — Rust 타입과 셸 페이지 JS를 1:1 대조).
- React UI ↔ 셸: 읽기 전용 표지(전역 객체 이름·모양을 spec 수준에서 고정 — 이름 `__HANDICAP_DESKTOP__`, 필드 `rolePageUrl` 하나). UI는 Zod로 검증하고 실패 시 표지 없음 취급.

## 6. 검증

- **게이트 위치**: 순수 로직(설정 파일 읽기·폴백, IP 후보 선택, 명령 조립, 토큰 형식)은 **새 워크스페이스 크레이트**(`crates/desktop-core`, Tauri 무의존)에 둬 pre-commit·CI nextest가 돌게 한다. `desktop/`은 게이트 밖이라(desktop/CLAUDE.md) 셸 글루만 두고 커밋 전 `cd desktop/src-tauri && cargo test` 수동.
- **bundle 수동 게이트**(pre-commit이 안 봄): `just ui-build` 후 `cargo build/clippy/nextest -p handicap-controller --features bundle`(필터 없이 전체).
- 단위: `InProcessConfig::default()` 불변, Pool+토큰 없음 Err, Pool이면 `is_pool_mode()`, gRPC fallback 플래그, 활성 run aborted 기록 + 재기동 후에도 aborted 유지, CLI `run_pool` 래퍼 동일성(본문 이동만 — 리뷰로 확인), 크레이트 순수 함수들.
- UI(RTL): 표지 없음 → 「모드 전환」 링크 미렌더 / 표지 있음 → 링크 / `pool_mode` 참 → 칩과 N / 거짓 → 칩 없음.
- **라이브(필수)**:
  - 헤드리스(내가): 포터블 bundle 바이너리 `--worker-mode pool --worker-token` + CLI 워커 2개(`--worker-id` 다르게) → `GET /api/pool/workers` 풀 등록 → run 생성 → 부하 분배 리포트(US5·US3의 서버 쪽). 토큰 없음 에러, 명시 포트 사용 중 에러.
  - GUI(데스크톱 앱): US1·US2·US4와 US3의 포트 변경 안내. 이 맥은 computer-use 권한 미허용 이력이 있어 라이브 때 권한 또는 사용자 조작을 요청한다. US1 "다른 PC에서 안 열림"은 서버 PC의 LAN IP:REST 포트 curl 연결 거부로 갈음. 원격 페이지 초기화 스크립트(§9 1번)를 여기서도 재확인. GUI 라이브 전에 `lsof -iTCP:8081`이 비었는지 확인(Unix `SO_REUSEADDR`로 `0.0.0.0:8081`이 다른 프로세스의 `127.0.0.1:8081`과 함께 bind돼, 이 PC 부하기가 엉뚱한 개발 컨트롤러에 붙을 수 있다).
- **macOS 부하기 명령**: 라이브에서 맥 명령(R5 macOS)을 실제로 붙여넣어 합류 확인 — 사용자 결정(2026-11-17) "당장 Windows PC는 테스트하기 힘드니" 이 맥이 1차 검증 플랫폼. 서버와 같은 맥이므로 ① 이 확인 동안 R4(「이 PC도 부하 내기」)를 끄거나 붙여넣은 명령의 `--worker-id`를 다른 값으로 바꾼다(같은 `hostname`이면 `pool_register_idle`이 한 항목으로 합쳐 US3을 관찰할 수 없다, `coordinator.rs:398-406`) ② 실행 파일은 `/Applications/...`가 아니라 **워크트리에서 빌드한 바이너리**(`desktop/src-tauri/target/<profile>/desktop` 또는 빌드한 `.app`)로 바꿔 실행한다(설치된 옛 버전이면 결과가 무의미). `/Applications` 경로는 명령 문자열 형식만 대조한다. Linux 명령은 경로 확정(산출물 확인)까지만, 실기 합류는 연기.
- **Windows 실기(사용자, Windows PC를 쓸 수 있을 때 — 머지 차단 아님, roadmap §B에 대기 항목으로)**: 방화벽 「액세스 허용」 창, 다른 PC의 PowerShell 명령 합류, 초기화 스크립트·셸 화면 이동, 예약 포트 범위의 포트로 저장됐을 때 빈 포트로 가는지(`netsh int ipv4 show excludedportrange protocol=tcp`).
- 보안 리뷰 필수(토큰 생성·저장·표시, 0.0.0.0 바인드, 표지, IPC 범위).

## 7. 판단 (틀렸을 때 비용 · 해소 경로) — 마무리 때 roadmap §B에 옮긴다

1. **gRPC 포트가 막히면 빈 포트 + 저장**(사용자 결정) — 비용: 이미 나눠 준 명령이 죽는다(안내로 고지). 해소: 포트 직접 고르기(후속).
2. **방화벽은 각 OS의 기본 안내에 맡김**(Windows 「액세스 허용」·macOS 연결 허용 창·Linux ufw 안내 문구) — 비용: 창을 놓치거나 회사 정책으로 막히면 부하기가 연결 실패 재시도에서 멈춤. 해소: 관리자 권한 규칙 버튼(후속, 실측 후).
3. **포터블 exe의 무시되던 플래그가 살아남** — `--worker-mode pool`은 토큰 필수(빈 값 거절), `kubernetes`는 에러. 비용: 토큰 없이 풀을 쓰던 사람은 없음(지금까지 동작 안 함), 비-bundle CLI와 달라짐; `kubernetes`를 넣어 두고 subprocess로 쓰던 사람은 시작이 안 됨(오설정이 드러나는 것). 해소: 필요하면 토큰 없는 풀 허용 논의.
4. **칩이 풀 모드 CLI 컨트롤러에도 보임** — 비용: 비-데스크톱 화면이 바뀐다(정보 추가뿐). 해소: 데스크톱 표지 조건으로 좁히기.
5. **같은 PC 이름 부하기 합쳐짐** — 비용: 복제 이미지 PC에서 한 대처럼 보임. 해소: 2차의 부하기 ID 폴백 규칙 또는 대시보드 경고.

## 8. 연기 (조건과 함께)

- **2차 = 부하기 쪽 버튼**(이 슬라이스 머지 직후 다음 후보): 역할 「부하기」 추가 · 부하기 모드에선 컨트롤러 미기동(예약 실행·모니터 정지 고지) · 접속 코드(형식 버전 + IPv4 후보 + 포트 + 토큰, 셸 화면에 표시·붙여넣기) · 상태 화면(연결 중 / 연결됨·대기 / 실행 중 / 다시 시도 중 + 이유 / 제외됨 / 끊김). 1차 리뷰가 미리 짚은 2차 설계 요구: ① worker-core `retry_with_backoff`가 시도마다 이유를 보고하는 선택 훅(CLI는 없음 — 지금은 60s `TOTAL_CAP` 뒤에만 에러가 보인다) ② 「연결됨」 신호: 컨트롤러가 풀 등록 직후 `Ping`을 바로 보내기(지금은 첫 하트비트까지 최대 10s 무신호) ③ 배정 전 `Abort` 사유를 에러 값에 담되 `Display`("missing assignment after register")·로그 동일 ④ IP 후보는 짧은 타임아웃으로 동시 탐침(방화벽 drop이면 Windows SYN 타임아웃 ~21s) ⑤ 같은 맥 라이브는 부하기 ID env override + R4 끔 ⑥ 부하기 실행 중 끊기 확인 창 ⑦ 부하기 ID 규칙 통일: 1차의 R5 명령은 `$env:COMPUTERNAME`(대문자 NetBIOS, ≤15자), R4는 `resolve_hostname()`(DNS 호스트명) — 같은 PC가 두 경로를 오가면 다른 안정 ID가 되어 제어 상태가 안 이어진다. 2차에서 한 규칙으로.
- 같은 망 자동 찾기 — 2차 뒤.
- 토큰 재발급 — 코드 유출 대응이 필요해질 때.

## 9. 구현 순서 (plan에 대한 요구)

1. **첫 task = 셸 스파이크(맥)**: ⓪ 설정 파일로 만든 `main` 창에 초기화 스크립트를 어떻게 설치하는지(`setup`에서 창 생성 / 플러그인 `js_init_script` 등) ① 그 스크립트가 `http://127.0.0.1:<port>` 페이지에 들어가는지 ② 그 페이지에서 셸 화면(셸 origin)으로 navigate가 되는지 ③ 셸 화면에서 앱 명령 IPC가 기본 capability로 되는지(셸 origin). 안 되면 R6 대안으로 plan을 고친다(STOP — 사용자 확인). 스파이크 코드는 버린다.
2. `desktop-core` 크레이트(순수 로직).
3. 컨트롤러: `InProcessConfig` 풀·fallback·토큰 검사, `RunningController` 접근자·aborted 기록, 포터블 `run_bundle` 배선(US5).
4. worker lib: 외부 취소 풀 진입점 + CLI 래퍼.
5. 셸: 상태 구조·비동기 정지·역할 전환·이 PC 부하기·IPC 명령·초기화 스크립트·역할 화면 페이지.
6. UI: 상단 메뉴 「모드 전환」 링크·상단 칩.
7. 문서: `docs/dev/lan-workers.md`(앞머리에 설치판 앱 방식 + 포터블 풀 모드가 이번 버전부터 동작한다는 정정), `desktop/CLAUDE.md` 함정, ADR-0057.

## 10. 문서

- ADR-0057: 데스크톱 역할 전환(셸 소유 설정 + 컨트롤러 재기동, 역할 조작은 셸 origin 화면, REST loopback 고정).
- 릴리즈 노트 한 줄: 포터블 exe `--worker-mode pool`이 실제로 동작(이전 버전은 무시됨) + 토큰 필수.
