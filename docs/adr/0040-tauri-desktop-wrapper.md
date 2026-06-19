# 0040. 라이트 Windows 데스크톱 배포 — 옵션 B(접근 1): Tauri 사이드카 셸

- 상태: 채택 (2026-06-19)
- 관련: [ADR-0039](0039-windows-desktop-distribution.md)(옵션 A/B 방향·LAN feasibility), [ADR-0019](0019-worker-dispatcher-abstraction.md)(dispatcher 추상), `docs/dev/tauri-desktop-build.md`(런북), `docs/dev/single-exe-build.md`(옵션 A)

## 맥락

ADR-0039는 사내 QA가 K8s 없이 자기 Windows PC에서 소규모 부하 테스트를 돌리는 "가볍게 쓰는 사용자" 배포로 **옵션 A(단일 self-contained `controller.exe`)**를 먼저 구현했다(더블클릭→브라우저로 localhost). 비기술 QA에게는 ① "exe 어디 뒀더라" 없이 아이콘 실행 ② 브라우저로 localhost 치는 단계 없이 **네이티브 창** ③ 정식 **인스톨러** 형태가 채택 장벽을 더 낮춘다. ADR-0039는 이를 **옵션 B(Tauri 래퍼)**로 예고하고 Flutter/RN을 거절했다(웹 UI[React Flow/Monaco/Zustand] 전면 리라이트 강요).

옵션 B 안에 두 접근이 있다: **접근 1**(기존 bundle `controller.exe`를 사이드카 *프로세스*로 spawn하고 창을 그 localhost로 가리킴) vs **접근 2**(controller를 Tauri 프로세스에 *in-process* 임베드). 무엇을 선택하나?

## 결정

**옵션 B 접근 1 — Tauri v2 데스크톱 셸이 bundle `controller` exe를 사이드카 서브프로세스로 감싼다.** 새 `desktop/` 크레이트가:

1. 부팅 시 controller를 `127.0.0.1:0`(OS가 빈 포트 원자 할당)로 **직접 spawn**(tokio `Command`, plugin-shell 아님 — 프로세스 그룹/Job 제어 위해), 자식 env `RUST_LOG=info`.
2. controller 로그 출력에서 **실제 바인딩 REST 포트를 파싱**(`parse_rest_port`)하고 `GET /api/health`==`ok`로 준비를 확인한 **뒤에만** 네이티브 창을 `http://127.0.0.1:<port>/`로 navigate.
3. 창 닫힘/앱 종료(`RunEvent::Exit`) 시 controller + 손자 워커를 **트리째 종료** — Unix `process_group(0)`+`killpg`(SIGTERM→유예→SIGKILL), Windows Job Object(`KILL_ON_JOB_CLOSE`).
4. controller 실행을 **`ControllerBackend{base_url(), shutdown()}` 추상** 뒤에 두어, 접근 2(in-process)는 backend 교체로 가능하게 한다(전방호환).
5. **`crates/**`·`ui/src` 0-diff**(controller/worker/engine/proto/UI를 소비만) — `desktop/`는 자체 빈 `[workspace]`로 루트 cargo 워크스페이스 밖에 둬 빌드 게이트에 무영향.

## 근거

- **"이미 가진 걸 감싼다"(ADR-0039)**: 옵션 A의 bundle controller가 임베드 UI 서빙·워커 self-spawn·포트 fallback을 *이미* 다 한다. 셸은 그 exe를 띄우고 창을 그 localhost로 가리키기만 하면 됨 → 새 Rust 최소, controller crate 0-diff. 접근 2(in-process)는 controller main.rs 부트스트랩을 lib로 추출해야 해 blast radius가 큼 → 후속.
- **포트는 controller가 원자적으로 정하고 셸은 로그에서 읽는다**: 셸이 빈 포트를 미리 골라 넘기면 bundle controller의 `bind_with_fallback`가 경합 시 다른 포트로 조용히 fallback해 셸이 틀린 포트를 폴링하는 함정. `--rest 127.0.0.1:0`으로 OS가 원자 할당하게 하고 기존 `info!` 로그에서 실제 포트를 파싱(crates 0-diff 유지).
- **OS-레벨 트리 종료가 load-bearing**: controller엔 시그널 핸들러가 없고 워커 종료가 전파되지 않으므로(repo 어디에도 `setsid`/`process_group` 없음), 셸이 직접 OS 메커니즘으로 트리를 잡아야 손자 워커 고아가 0이 된다.
- **backend 추상으로 접근 2·LAN 전방호환**: `base_url()`+`shutdown()` 2-메서드 경계 뒤에 두면 `SidecarBackend`→`InProcessBackend` 교체로 창/생명주기 코드 재사용. `SpawnConfig` 기본 localhost로 두면 미래 LAN 모드는 필드 추가만(ADR-0039 §LAN feasibility).

## 대안 (기각)

- **접근 2(in-process 단일 exe) 우선**: controller main.rs lib 추출 + Tauri 멀티콜 워커 필요 — blast radius 큼. R7 backend 경계로 문은 열어 둠(후속). (단 LAN이 중요해지면 사이드카 유지가 오히려 정답 — 헤드리스 워커 exe 분리.)
- **plugin-shell 관리 spawn**: 프로세스 그룹/Job Object 제어가 어려워 트리 종료(R3/R12)가 불확실 → tokio `Command` 직접 spawn.
- **Electron / Flutter / React Native**: ADR-0039에서 이미 기각(웹 UI 재사용 불가·번들 비대).

## 결과

- 검증 = macOS 라이브(R2 run 완료·R3 process_group+killpg 손자 워커 고아 0·R8 실 포트 파싱+헬스) 통과. **`NO_COLOR`는 파이프 출력엔 무력**이라 `parse_rest_port`의 ANSI strip이 실제 load-bearing 방어(런북·`desktop/CLAUDE.md`).
- Windows(인스톨러 설치→실행→run·Job Object 트리 정리·WebView2 다운로드)와 macOS GUI 렌더(R1)/WebView 회귀(R9)는 **런북 체크리스트로 연기**(가용 머신·headless 한계).
- 연기(roadmap §7): 접근 2 in-process·코드서명/SmartScreen·네이티브 다이얼로그·트레이/자동업데이트·LAN 분산 워커·Windows CI.
