# 0042. 라이트 Windows 데스크톱 배포 — 옵션 B 접근 2: Tauri in-process 컨트롤러

- 상태: 채택 (2026-06-26) — ADR-0040(접근 1 사이드카)을 대체
- 관련: [ADR-0040](0040-tauri-desktop-wrapper.md)(접근 1·R7 backend 경계), [ADR-0039](0039-windows-desktop-distribution.md)(옵션 A/B·LAN feasibility), `docs/superpowers/specs/2026-06-26-tauri-in-process-backend-design.md`(슬라이스 1), `docs/superpowers/specs/2026-06-26-tauri-in-process-shell-design.md`(슬라이스 2)

## 맥락

ADR-0040은 Tauri 셸을 접근 1(bundle `controller` exe를 사이드카 프로세스로 spawn·로그에서 포트 파싱·health 폴링·OS 트리종료)로 구현하고, 접근 2(in-process 임베드)를 R7 `ControllerBackend{base_url(),shutdown()}` 추상 뒤로 예고했다. 접근 2는 사이드카·로그파싱·health폴링·별도 프로세스 트리종료를 제거한다.

## 결정

**컨트롤러를 Tauri 프로세스에 in-process 임베드한다(접근 2).** 두 슬라이스로 구현:

- **슬라이스 1(백엔드):** 컨트롤러 부트스트랩을 `run_in_process(InProcessConfig) -> RunningController`로 추출(bundle-gated, REST/gRPC 사전바인딩→실주소 동기 반환·serve/scheduler/heartbeat를 취소 토큰과 함께 spawn). `RunningController::shutdown()` = graceful **bounded-drain**(절대 hang 안 함: active run abort → 토큰 cancel → 5s drain → hard-stop). 워커 **R4b disconnect-cancel**(인바운드 스트림이 명시적 `Abort` 없이 닫히면=컨트롤러 소멸 시 run 취소·크로스플랫폼·loopback 거의 즉시).
- **슬라이스 2(셸):** desktop `SidecarBackend`→`InProcessBackend`(`run_in_process` 보유·창을 in-process REST 포트로 navigate·async shutdown을 `tauri::async_runtime::block_on`으로 브리지). 데스크톱 바이너리 **멀티콜**(`run_worker_if_invoked` — in-process `SubprocessDispatcher`가 `current_exe worker …`로 self-spawn하므로 GUI init 전 argv 가드). `externalBin`·사이드카·health폴링 제거.

**크래시-견고 워커 teardown은 계층화:** R4b disconnect-cancel(1차·크로스플랫폼·검증가능) + `abort_all` graceful(정상종료) + `mark_orphans_failed`(영속 백스톱). **Windows Job(R4d)은 트리거-기반 연기** — in-process가 컨트롤러 자식 프로세스를 없애 ADR-0040 R3의 "OS-레벨 트리킬이 load-bearing" 근거가 소멸했고, R4b가 사용자 채택 조건("하드 크래시에도 워커 고아 0/bounded")을 크로스플랫폼·검증가능 형태로 충족한다. Windows에서 hung-워커 고아가 실제 관측되면 그때 desktop-only로 Job을 추가한다(트레잇 경계 보존).

## 근거

- **사이드카 제거가 단순화:** 별도 프로세스·로그 포트파싱(ANSI strip)·health 폴링·bind-ok-but-health-failed 좀비가 구조적으로 소멸. 창은 `rest_addr()`로 직접 navigate.
- **R4b가 OS-레벨 소켓 teardown 기반이라 Windows=Unix:** 컨트롤러 소멸→소켓 close→워커가 `Abort` 없는 close 감지→run 취소→종료. 사이드카가 Job/killpg를 쓴 *원래 이유*(컨트롤러 자식이 시그널 핸들러 없이 손자 워커에 미전파)를 R4b가 대체.
- **R7 backend 경계·byte-identical-when-off 계승:** `ControllerBackend` 트레잇 유지(LAN 전방호환). 신규 컨트롤러 심볼은 전부 `#[cfg(feature="bundle")]` → 비-bundle 바이너리 byte-identical. engine/proto/migration 0-diff.

## 대안 (기각)

- **접근 1 사이드카 유지:** 로그파싱·health폴링·좀비 복잡성. (단 LAN 헤드리스 워커 분리가 중요해지면 사이드카가 정답일 수 있어 standalone bundle `controller.exe`[ADR-0039 옵션 A]는 별도 산출물로 유지.)
- **Windows Job 지금 구현:** self-assign(WebView2 nested-job·자가-kill 타이밍 캐벗)·controller-passthrough(Windows API를 컨트롤러에 — blast radius)·runbook-only 검증(macOS 실측 불가). R4b가 1차를 충족하므로 트리거-기반 연기.

## 결과

- 검증 = macOS 라이브(슬라이스 1: bundle in-process boot→health→self-spawn 워커→run 완주→R4b 크래시 backstop·좀비0; 슬라이스 2: 데스크톱 바이너리가 풀 워커로 멀티콜 가드 실측·R4b). GUI 렌더(창 navigate)·WebView2·Windows 인스톨러는 runbook(headless 한계).
- standalone bundle `controller.exe` 보존(LAN·수동 fallback).
- 연기: R4d Windows Job(트리거)·코드서명/SmartScreen/인스톨러 메타데이터·트레이/자동업데이트·LAN 자동등록·Windows CI.
