# `Tauri 데스크톱 셸` — `controller 사이드카를 감싸는 네이티브 창 + Windows 인스톨러` (ADR-0039 옵션 B, 접근 1)

> **이 파일은 spec이다.** 핵심은 **§2 요구사항 표(R-id)** — plan·구현·리뷰가 전부 이 ID를 참조한다.

- **날짜**: 2026-06-19
- **상태**: 설계 승인(사용자 2026-06-19) + spec/plan reviewer APPROVE(2026-06-19) → 구현 대기(STOP-gate)
- **출처**: 사용자 요청(Windows에서 "여러 사람이 쓸 수 있게" 배포). **왜 지금**: 옵션 A(단일 exe)는 "더블클릭→브라우저"까지 줬으나, 비기술 QA에게는 "네이티브 창 + 정식 인스톨러"가 채택 장벽을 더 낮춘다(공공기관 타깃·최신 Windows 전제라 WebView2 기본 탑재·서명없는 실행/관리자 설치 허용).
- **연관**: ADR-0039(옵션 A/B 방향·LAN feasibility), `2026-06-16-windows-single-exe-design.md`(옵션 A — bundle feature·임베드 UI·워커 self-spawn·포트 fallback), `docs/dev/single-exe-build.md`(옵션 A 런북).
- **ADR**: **ADR-0040 신규**(데스크톱 셸 = Tauri 사이드카, 접근 1 채택; 접근 2[in-process]·LAN 전방호환을 결정에 명시). 근거: 새 배포 형태이자 새 셸 기술 도입 = 결정 기록 가치.

---

## 1. 문제와 목표

옵션 A는 controller 단일 exe(임베드 UI + 워커 self-spawn + 브라우저 오픈)를 줬지만, 사용자는 ① "exe 어디 뒀더라" 없이 아이콘으로 실행되고 ② 브라우저로 localhost를 치는 단계 없이 **네이티브 창**으로 뜨며 ③ 정식 **인스톨러**로 여러 PC에 배포되는 형태를 원한다. 이 슬라이스는 **기존 bundle controller exe를 사이드카로 감싸는 Tauri v2 데스크톱 셸**을 추가한다 — controller/worker/engine/UI는 한 줄도 안 고친다(소비만).

- **목표**: 더블클릭 → 네이티브 창에 앱 / 백그라운드 controller(+self-spawn 워커) 자동 기동 / 창 닫으면 프로세스 트리 깨끗이 종료(워커 고아 0) / Tauri 번들러로 Windows 인스톨러 산출. 접근 2(in-process)·LAN 분산 워커로의 확장 문을 열어 둔다.
- **비목표(연기)**: §7 참조. in-process 임베드·코드서명·네이티브 다이얼로그·트레이·자동업데이트·LAN 분산·Windows CI.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST: Tauri v2 데스크톱 셸이 기동 시 controller를 사이드카로 spawn하고, **준비 확인(R8) 후에만** 단일 창을 그 controller의 `http://127.0.0.1:<actual-port>`로 navigate해 앱을 표시한다. | macOS 라이브: 창에 핸디캡 UI 렌더 + R2 run 완료 | |
| R2 | MUST: 사이드카 controller가 self-spawn 워커로 **실제 run을 끝까지 실행**한다(셸이 controller/worker 동작을 깨지 않음). | macOS 라이브: 50ms responder 대상 run 1개 `completed` + 리포트 표시 | |
| R3 | MUST(macOS, **검증됨**): 셸은 controller를 **자기 자신을 리더로 하는 새 프로세스 그룹**으로 spawn하고, 창 닫힘/앱 종료 시 `killpg`(SIGTERM→유예후 SIGKILL)로 controller + **손자 워커**까지 트리째 종료한다(고아 0). | macOS 라이브: **run 진행 중(워커 살아있음)** 앱 종료 → `pgrep -f 'controller|worker'` = 0 | |
| R4 | MUST(불변식): `crates/**`(controller·worker·engine·proto·migration) **0-diff**, `ui/src` **0-diff**. 이 슬라이스 변경 표면 = `desktop/`(신규) + `docs/`(런북·ADR) 뿐. | `git diff --stat master..` 에 `crates/`·`ui/src` 변경 0 | |
| R5 | MUST(불변식): `desktop/`는 cargo **workspace 멤버가 아니다**(`crates/*` glob 밖, `.githooks/pre-commit` `CARGO_PATHS` 정규식 `^(crates/|Cargo\.toml$|...)` 비매치) → `cargo build --workspace`·pre-commit cargo 게이트가 Tauri 시스템 의존 없이 byte-identical green. | `cargo metadata`에 desktop 부재 + `desktop/**` staged 시 cargo 게이트 미발동 | |
| R6 | MUST(전방호환): controller 기동 파라미터를 **`SpawnConfig` 구조체**로 캡슐화하며 **기본값은 localhost**(rest·grpc 모두 `127.0.0.1:0`[OS가 빈 포트를 *원자적으로* 할당 — pick-then-bind TOCTOU 없음], `no_open=true`). 미래 LAN 모드는 필드 세팅 *추가*만으로 가능(리팩터 0). | 단위: 기본 `SpawnConfig`→`to_args()`가 `127.0.0.1`·`--no-open` 포함, 네트워크 노출 주소(`0.0.0.0`) 부재 | ✅ 내부(LAN 전방호환) |
| R7 | MUST(확장 이음새): Tauri 셸은 controller 실행 방식에 대해 **`base_url()` + `shutdown()` 두 연산(backend 추상)** 에만 의존한다. v1=사이드카 backend, 접근 2(in-process)=backend 교체로 가능. | 코드: 창/navigate/종료가 `ControllerBackend` 경계만 통과(트레잇 모킹 가능) | ✅ 내부(접근2 전방호환) |
| R8 | MUST: 셸은 사이드카의 **실제 바인딩 REST 포트를 controller 로그 출력(stdout/stderr)에서 파싱**해 얻고(자식 env `RUST_LOG=info` 강제), `GET http://127.0.0.1:<port>/api/health`가 **상태 200 + 본문 `ok`** 일 때만 준비로 본다. 타임아웃/실패 시 **창에 사람 읽는 에러를 띄우고 navigate하지 않는다**(미확인 포트로 절대 이동 금지). | 단위: 실측 controller 로그 라인 fixture→`parse_rest_port`가 포트 추출(드리프트 가드); `health_url` 구성; macOS 라이브: 정상 navigate | |
| R9 | SHOULD(회귀 점검): 기존 웹 기능 중 WebView 동작이 갈릴 수 있는 3종 — **리포트 CSV/XLSX 다운로드 · HAR 파일 업로드 · 클립보드 복사** — 가 WKWebView(macOS)에서 동작한다. WebView2(Windows) 특이사항은 §6 Windows-검증 갭으로 문서화. | macOS 라이브: 3종 수동 확인(다운로드 저장·파일 선택·복사) | |
| R10 | MUST: 빌드 파이프라인을 런북 `docs/dev/tauri-desktop-build.md`에 단계별로 — UI build → controller `--features bundle --release` build → 사이드카 복사(`binaries/controller-<target-triple>`) → `tauri build` → Windows 인스톨러. WebView2 전제(최신 Windows 기본 탑재) + "없으면 확인" 1줄 포함. | 런북 파일 존재 + macOS에서 `tauri build` 산출물 1회 | |
| R11 | MUST: 순수 글루(`SpawnConfig::to_args`·`parse_rest_port`·`health_url`·`base_url`)를 **Tauri 런타임 없이 단위 테스트 가능한 순수 함수**로 격리(controller `launch.rs` 패턴 차용). | `cargo test`(desktop 크레이트, Tauri 런타임 불요)로 green | |
| R12 | MUST(Windows, **구현하되 검증은 §6 갭**): 셸은 controller를 **Job Object(`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)에 워커 spawn 전에 배정**하고, 손자 워커는 (`CREATE_BREAKAWAY_FROM_JOB` 미사용으로) 자동 enrolled → 앱 종료 시 job 핸들 close가 트리 전체를 OS-레벨로 종료. | 코드 존재 + Windows-검증 체크리스트(§6); macOS에선 미검증 | |
| R13 | MUST(위생): `desktop/.gitignore`가 `desktop/src-tauri/target`·`desktop/src-tauri/binaries/`·`node_modules`를 무시(루트 surface 안 건드림). 사이드카 바이너리는 **빌드타임 복사물(커밋 안 함)**. | 빌드 후 `git status --porcelain`에 desktop 빌드 산출물·바이너리 부재 | |
| R14 | MUST: 사이드카 의존(bundle controller)이 빌드·테스트 green(`cargo test -p handicap-controller --features bundle` 전체). 기본 pre-commit 게이트는 bundle을 컴파일하지 않으므로(controller CLAUDE.md), 데스크톱이 의존하는 이 경로를 명시 검증. | `cargo test -p handicap-controller --features bundle` green | |

- **`seam?` 주의**: 이 슬라이스는 **와이어 계약(UI Zod↔engine serde / proto / migration / CSV·XLSX)을 전혀 건드리지 않는다**(§5). R6·R7의 `seam`은 *내부 전방호환 경계*(LAN·접근2)일 뿐 와이어 계약이 아니다. 최종 리뷰의 와이어 1:1 대상은 0(있어야 할 와이어 변경이 0임을 확인하는 게 포인트).

---

## 3. 핵심 통찰 (설계 근거)

1. **사이드카(접근 1)를 고른 이유** = ADR-0039의 "이미 가진 걸 감싼다". 옵션 A의 bundle controller exe가 임베드 UI 서빙(`app.rs:157` — `--ui-dir` 없이 rust-embed fallback) + 워커 self-spawn(`main.rs:174` `current_exe`) + 포트 fallback(`launch.rs:29`)을 *이미* 다 한다. 셸은 그 exe를 띄우고 창을 그 localhost로 가리키기만 하면 된다 → **새 Rust 최소, controller crate 0-diff**(R4). in-process(접근 2)는 main.rs 부트스트랩을 lib로 추출해야 해 blast radius가 크다 → 후속.
2. **포트는 controller가 원자적으로 정하고 셸은 로그에서 읽는다(R8)**. 셸이 빈 포트를 미리 골라 `--rest <port>`로 넘기면, bundle controller가 항상 `bind_with_fallback(args.rest, true)`(`main.rs:157`)라 pick↔bind 사이 경합 시 **다른 포트로 조용히 fallback**(`launch.rs:35`)하고 실제 포트는 로그로만 나간다 → 셸이 틀린 포트를 영영 폴링하는 함정. 해결: `--rest 127.0.0.1:0`을 넘겨 **OS가 한 syscall로 빈 포트를 원자 할당**(TOCTOU 자체가 없음)하게 하고, 셸은 controller의 기존 `info!` 로그(`main.rs:167,293` — `rest=`/`addr=` 필드)에서 **실제 포트를 파싱**한다. controller가 어느 스트림(stdout/stderr)에 찍든 둘 다 읽고, 자식 env `RUST_LOG=info`를 강제해 라인 누락을 막는다. 로그 포맷 드리프트는 **실측 라인 fixture 단위 테스트(드리프트 가드)** 로 잠근다. 이로써 R4(crates 0-diff)를 깨지 않고 포트 결정이 robust해진다.
3. **준비 신호는 `GET /api/health`==`ok`만 신뢰(R8)**. bundle 모드는 알 수 없는 경로에 **SPA fallback으로 200 HTML**을 돌려준다(`bundle.rs:24`) → `/`나 `/health`에 "200이면 준비"로 보면 API가 안 떴어도 **조기 false-positive**. 실제 헬스 엔드포인트는 `/api/health`(`app.rs:38`, `/api` 하위)로 본문 `"ok"`. 그래서 상태코드만이 아니라 **본문까지** 확인한다.
4. **R3/R12: OS-레벨 트리 종료가 load-bearing(backstop 아님)**. controller에는 **시그널 핸들러가 없고**(`main.rs:300` 맨 `tokio::try_join!` — ctrl_c/SIGTERM 처리 0), repo 어디에도 `setsid`/`process_group`/`creation_flags`가 없다(워커는 `current_exe`로 spawn된 controller의 손자, `dispatcher/subprocess.rs`). 따라서 controller를 죽여도 워커에 종료가 전파되지 않는다 → **셸이 직접 OS 메커니즘으로 트리를 잡아야** 한다. macOS: controller를 **새 프로세스 그룹 리더**로 spawn(`process_group`) → 워커가 그 pgid 상속 → `killpg`가 손자까지 도달(워커는 SIGTERM 핸들러로 graceful, controller는 핸들러 없이 종료; 유예 후 SIGKILL 백업). Windows: **Job Object `KILL_ON_JOB_CLOSE`** 에 controller를 워커 spawn 전 배정 → 손자 자동 enrolled(breakaway 미사용) → job 핸들 close가 트리 강제 종료.
5. **R7(backend 추상)로 접근 2 확장이 추가+교체가 되게** 한다. 셸이 사이드카 내부에 직접 의존하면 접근 2 이전이 리라이트가 된다. `base_url()`+`shutdown()` 2-메서드 경계 뒤에 두면 `SidecarBackend`→`InProcessBackend` 교체로 창/생명주기/스플래시 코드가 전부 재사용된다.
6. **R6(SpawnConfig, 기본 localhost)로 LAN 전방호환**. LAN 분산의 격차①(gRPC `0.0.0.0` 바인딩)은 controller spawn 인자 하나다. 기동 인자를 config 구조체로 두고 기본을 localhost로 고정하면, 미래 LAN 토글은 필드 추가다. 또한 사이드카는 **헤드리스 controller/worker exe를 별도 아티팩트로 유지** → 워커 PC는 GUI 없이 그 exe를 `controller worker --controller http://<ip>` 로 띄울 수 있다(멀티콜 보존). 즉 사이드카 구조는 LAN을 막지 않고 거든다.
7. **R5(workspace 비-멤버)로 게이트 무영향**. `desktop/`을 `crates/*` glob 밖에 두면 `cargo build --workspace`(pre-commit 게이트)가 Tauri 시스템 의존(webkit/WebView2) 없이 그대로 green — 옵션 A의 `bundle` feature가 기본 off로 게이트 byte-identical을 지킨 것과 같은 정신.

---

## 4. 변경 상세

> 변경 표면은 전부 신규 `desktop/` + docs. 기존 코드 수정 0(R4).

### 4.1 `desktop/src-tauri/src/launch.rs` (순수 글루) — 충족 R: R6, R8, R11
- `SpawnConfig`(rest/grpc 주소·`no_open`·db 옵션, **기본 rest/grpc=`127.0.0.1:0`·no_open=true**) + `to_args() -> Vec<String>`(예: `["--rest","127.0.0.1:0","--grpc","127.0.0.1:0","--no-open"]`). (R6)
- `parse_rest_port(log_line: &str) -> Option<u16>` — controller `info!` 라인(`rest=127.0.0.1:NNNN` / `REST listening addr=127.0.0.1:NNNN`)에서 실제 포트 추출. **실측 라인 fixture로 드리프트 가드**(R8/R11).
- `health_url(port) -> String`(`http://127.0.0.1:<port>/api/health`) / `base_url(port) -> String`. health-poll 파라미터(시도·간격·타임아웃)도 여기. 전부 Tauri 불요 순수 함수(R11).

### 4.2 `desktop/src-tauri/src/backend.rs` (controller 실행 추상) — 충족 R: R3, R7, R12
- **`ControllerBackend` 트레잇** = `base_url()` + `shutdown()`(R7).
- `SidecarBackend` — Tauri가 번들한 사이드카 경로를 resolve해 **std/tokio `Command`로 직접 spawn**(plugin-shell 관리 spawn 대신 — 프로세스 그룹/Job 제어 위해), 자식 env `RUST_LOG=info`. stdout/stderr를 읽어 `parse_rest_port`로 포트 확보 후 health-poll(R8).
  - Unix: `Command::process_group(0)`로 controller를 새 그룹 리더로 → `shutdown()`이 `killpg(pid, SIGTERM)` 후 유예→`SIGKILL`(R3).
  - Windows: Job Object(`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) 생성·controller 배정(워커 spawn 전)·핸들 보관 → `shutdown()`/drop이 핸들 close로 트리 종료(R12). `windows`/`win32job` 류 크레이트.

### 4.3 `desktop/src-tauri/src/{main,lib}.rs` (셸 배선) — 충족 R: R1, R3, R8
- 창을 스플래시로 연다 → `ControllerBackend` 기동 → **준비 확인(R8) 성공 시에만** 창을 `base_url()`로 navigate, 실패 시 에러 표시. 창 close/앱 quit 훅에서 `shutdown()`(R3/R12).

### 4.4 `desktop/src-tauri/{Cargo.toml,tauri.conf.json}` + `desktop/splash/index.html` — 충족 R: R1, R5, R10
- `Cargo.toml` — Tauri v2 의존(+shell/process 등). **`crates/*` glob 밖**(R5).
- `tauri.conf.json` — `frontendDist`=스플래시, 단일 창, `externalBin`=`binaries/controller`(번들·경로 resolve용; 실제 spawn은 §4.2). 번들 타깃=Windows NSIS/MSI(+macOS 검증용).
- `splash/index.html` — "핸디캡 시작 중…" 미니 페이지(실 UI는 controller가 서빙).

### 4.5 `desktop/.gitignore` (위생) — 충족 R: R13
- `src-tauri/target/`·`src-tauri/binaries/`·`node_modules/` 무시. 사이드카 바이너리는 빌드타임 복사물(커밋 X). 루트 `.gitignore` 무수정(R4 surface 유지).

### 4.6 `docs/dev/tauri-desktop-build.md` (런북) — 충족 R: R10, R14
- 단계: `pnpm --dir ui build` → `cargo build -p handicap-controller --features bundle --release` → `controller`를 `desktop/src-tauri/binaries/controller-<target-triple>`로 복사 → `tauri build`. Windows 전제(Rust MSVC·Node·Tauri CLI·WebView2 기본 탑재[없으면 확인]) + macOS 검증 절차 + `cargo test -p handicap-controller --features bundle`(R14) + **Windows-검증 갭 체크리스트**(§6).

---

## 5. 무변경 / 불변식 (명시)

- **`crates/**` 전부 0-diff** — controller·worker·engine·proto·migration·controller `bundle` 코드까지 *소비만*, 수정 0(R4). bundle controller의 *행동*도 byte-identical(셸은 기존 인자·로그만 소비).
- **`ui/src` 0-diff** — UI는 controller가 그대로 서빙(R4).
- **와이어/계약 무변경** — proto·migration·UI Zod↔serde·CSV/XLSX export **전부 byte-identical**(§2 seam 주의).
- **루트 `.gitignore`·`Cargo.toml`·`.githooks/` 무변경** — `desktop/`가 workspace·게이트 정규식 밖(R5), gitignore는 `desktop/.gitignore`로 국소화(R13).
- **웹·단일 exe(옵션 A)·K8s 경로 byte-identical** — 데스크톱은 순수 *추가 아티팩트*.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | macOS 라이브: `tauri dev`/빌드 앱 기동 → 창에 UI 렌더 | ✅ |
| R2 | macOS 라이브: 50ms responder 대상 run 1개 `completed`+리포트 | ✅ |
| R3 | macOS 라이브: **run 진행 중** 앱 종료 후 `pgrep -f 'controller|worker'` = 0 | ✅ |
| R4 | `git diff --stat`: `crates/`·`ui/src` 변경 0 | |
| R5 | `cargo metadata`에 desktop 부재 + `desktop/**` staged 시 cargo 게이트 미발동 | |
| R6 | 단위: 기본 `SpawnConfig`→`to_args()`에 `127.0.0.1`·`--no-open`, `0.0.0.0` 부재 | |
| R7 | 코드 구조: 창/navigate/종료가 `ControllerBackend` 경계만 통과 | |
| R8 | 단위: 실측 로그 fixture→`parse_rest_port`(드리프트 가드)·`health_url`; 라이브: 정상 navigate | |
| R9 | macOS 라이브: 리포트 다운로드·HAR 업로드·클립보드 복사 3종 | ✅ |
| R10 | 런북 존재 + macOS `tauri build` 산출물 1회 | |
| R11 | `cargo test`(desktop 크레이트) green, Tauri 런타임 불요 | |
| R12 | 코드 존재(Job Object 배선) + Windows-검증 체크리스트(macOS 미검증) | |
| R13 | 빌드 후 `git status --porcelain`에 desktop 빌드 산출물·바이너리 부재 | |
| R14 | `cargo test -p handicap-controller --features bundle` green | |

- **라이브 검증 필수(macOS)**: 셸이 *실행 형태*(WebView·사이드카·생명주기)를 바꾸므로 run-생성 코드(byte-identical)와 무관하게 **엔드투엔드 라이브 1회 필수**. run/responder 스택은 `/live-verify` 재사용(단, controller를 Tauri가 spawn하는 형태로 띄움). R3은 **워커가 살아있는 run 진행 중** 종료를 단언(idle 종료는 고아 대상이 없어 무의미).
- **Windows-검증 갭(런북 체크리스트로 연기)**: 실제 인스톨러 설치→실행→run · **R12 Job Object 트리 정리** · WebView2 다운로드(R9) 동작. 옵션 A와 동일 정책(가용 머신이 macOS뿐).

---

## 7. 의도적 연기 (roadmap에 누적)

- **접근 2(in-process 단일 exe)**: controller main.rs 부트스트랩 lib 추출 + Tauri 멀티콜 워커 필요 — blast radius 큼. R7 backend 경계로 문은 열어 둠. (단 LAN이 중요해지면 사이드카 유지가 오히려 정답 — §3.6.)
- **코드서명 / SmartScreen 해소**: 사내 인증서 필요. 타깃이 서명-없는 실행 허용이라 v1 비차단.
- **네이티브 파일 다이얼로그**: R9에서 WebView2 다운로드가 깨질 경우의 폴백 — Windows 검증 후 필요시 후속.
- **시스템 트레이/메뉴 · 자동 업데이트**: 순수 편의, v1 밖.
- **LAN 분산 워커**: 별도 ADR(ADR-0039 §관련 검토 — RemoteDispatcher + `0.0.0.0` 바인딩 + mTLS). 이 슬라이스의 R6/R7이 전방호환만 보장.
- **Windows CI 자동빌드**: remote 미설정.

---

## 8. 구현 순서 (plan 입력)

> `desktop/`는 cargo workspace 밖이라 pre-commit cargo 게이트와 분리된다(R5). 단 desktop 크레이트 자체의 `cargo test`(R11)·`tauri build`(R10)·bundle controller 검증(R14)은 별도로 돌린다. 순수 글루(R6/R8/R11)는 Tauri 없이 테스트 가능하므로 **TDD로 먼저**, 셸 배선·생명주기(R1/R3/R7/R12)는 그 위에 fold.

1. **스캐폴드 + 순수 글루(TDD)** — `desktop/` Tauri v2 프로젝트(workspace 밖, R5) + `desktop/.gitignore`(R13) + `launch.rs` 순수 함수(`SpawnConfig`/`to_args`/`parse_rest_port`[드리프트 가드]/`health_url`/`base_url`) + 단위 테스트(R6·R8·R11). 한 green 커밋.
2. **backend 추상 + 사이드카 생명주기** — `ControllerBackend` 트레잇(R7) + `SidecarBackend`(spawn·env·로그파싱·health-poll·프로세스그룹 killpg[R3]·Job Object[R12]). 트레잇 모킹 단위 테스트.
3. **셸 배선 + 스플래시** — 창 기동→backend→준비확인→navigate→종료 훅(R1) + `splash/index.html` + `tauri.conf.json`·`externalBin`.
4. **런북 + 빌드 파이프라인**(R10·R14) — `docs/dev/tauri-desktop-build.md` + 사이드카 복사 스텝 + macOS `tauri build` 1회 + `cargo test -p handicap-controller --features bundle` green.
5. **macOS 라이브 검증**(R1·R2·R3·R9) — `/live-verify` 스택을 Tauri-spawn 형태로 + run 완료 + **run 진행 중 종료 후 고아 0** + WebView 회귀 3종.
6. **마무리 docs**(ADR-0040 · build-log · roadmap · 루트 상태줄 · 메모리) — 별도 마지막 커밋.
