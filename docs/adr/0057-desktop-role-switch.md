# 0057. 데스크톱 모드 전환 — 셸 소유 설정 + 컨트롤러 재기동 + 셸 origin 「모드 전환」 화면

- Status: Accepted (2026-11-17, 1차 = 서버 쪽 버튼. 부하기 쪽 버튼은 2차)
- Date: 2026-11-17
- 관련: ADR-0041(풀 모드·토큰), ADR-0042(in-process 임베드 — 이 결정이 확장), ADR-0039(LAN 가능성)
- 설계: `docs/superpowers/specs/2026-11-16-desktop-lan-mode-design.md`

## Context

LAN 분산 부하(ADR-0041)는 명령줄로만 켤 수 있어, 설치판 데스크톱 앱 사용자(QA)는 쓸 수 없었다. 앱 안의 버튼으로 "이 PC를 서버로 열고 다른 PC를 부하기로 붙이는" 흐름이 필요하다. 이때 컨트롤러 런타임(`spawn_run`·풀 예약·dispatcher)은 기동 시점 설정에 묶여 있다.

## Decision

**셸(Tauri)이 역할(혼자 쓰기/서버)·토큰·포트·「이 PC도 부하 내기」를 자기 설정 파일에 저장하고, 역할을 바꾸면 in-process 컨트롤러를 새 설정으로 다시 띄운다.** 역할 조작은 React 화면이 아니라 **셸 자체 화면(`role.html`, 셸 origin)** 에서 한다.

- **재기동 방식**: 정지 순서는 활성 run `aborted` 기록·abort → 이 PC 부하기 정지 → 컨트롤러 shutdown → 새 설정으로 `run_in_process` → (서버+토글이면) 이 PC 부하기 시작 → 역할 저장(성공 후에만). 기록이 먼저인 이유: 부하기를 먼저 끊으면 `worker_disconnected`가 `failed`를 먼저 써서 뒤의 가드 UPDATE가 건너뛴다. 앱 종료도 같은 경로(메시지만 「앱 종료로 중단」).
- **셸 origin 화면**: 컨트롤러가 서빙하는 `http://127.0.0.1:<port>`(원격 origin)에는 앱 명령 IPC가 거절된다(스파이크 실측: `not allowed. Plugin not found`). 그래서 토큰·역할 전환은 셸 origin(`tauri://localhost`, Windows `http://tauri.localhost`)에서만. React UI는 셸이 넣는 읽기 전용 표지 `{rolePageUrl}` 하나로 「모드 전환」 링크를 그리고, 클릭하면 셸 화면으로 이동한다. 표지에 비밀·현재 역할은 없다. 역할 화면은 `window.top !== window.self`이면 아무것도 그리지 않는다(클릭 유도 차단).
- **창 생성 방식(스파이크 결과)**: `tauri.conf.json`의 창에는 초기화 스크립트를 달 수 없으므로 `windows[0]`에 `"create": false`를 두고 `setup`에서 `WebviewWindowBuilder::from_config(..).initialization_script(..)`로 만든다. 셸 origin은 Tauri 규칙(비-Windows `tauri://localhost`, Windows `http://tauri.localhost`)을 `cfg!`로 미러링하고 build 뒤 `win.url()`과 비교해 불일치면 경고한다.
- **REST는 loopback 고정**: 서버 모드에서도 gRPC만 `0.0.0.0`에 열고 REST는 `127.0.0.1`이다(서버 화면은 서버 PC에서만 — 토큰 없는 REST를 LAN에 열지 않는다). 부하기는 gRPC + 토큰으로 접속한다.
- **포트·토큰**: gRPC 기본 8081이 막혀 있으면 빈 포트로 열고 저장 + 안내(이미 나눠 준 명령이 죽는다는 고지). 토큰은 첫 서버 모드 때 생성해 셸 설정 파일에만 저장하고 셸 페이지의 명령 응답에만 실린다(REST·로그·리포트 없음, `InProcessConfig` Debug 가림).
- **부하기 PC용 복사 명령**: 부하기 PC의 OS(Windows/macOS/Linux)별 명령을 셸이 조립한다. 설치판 바이너리의 멀티콜 `worker …`가 포터블 exe 대신 쓰인다.
- **포터블 exe 정정**: `--worker-mode pool`이 이번 버전부터 실제로 동작한다(v0.14.0 이하는 조용히 무시되어 subprocess로 떴다). 토큰 필수(빈 값 거절), `--worker-mode kubernetes`는 거절. subprocess 워커의 gRPC 폴백은 `PermissionDenied`에서도 동작.

## 대안 (기각)

- **B — 컨트롤러를 켠 채 dispatcher·풀 모드를 런타임 교체**: 재기동 1~2초를 아끼려고 `spawn_run`·풀 예약을 런타임 가변으로 만들어야 한다. 핵심 경로 변경 대비 이득이 작아 기각.
- **C — 네이티브 메뉴바 + 별도 창**: 평소 화면과 떨어져 찾기 어렵다. 표지 탐지가 실패할 때의 대안으로만 남겼다(스파이크에서 표지가 원격 페이지에 들어가 불필요해짐).
- **React 「설정」 화면에 직접 두기**: 원격 origin IPC 허용·UI CSP(`connect-src 'self'`)·플랫폼별 IPC 전송 차이를 넘어야 하고(Windows는 이 환경에서 확인 불가), UI XSS가 토큰·전환까지 닿는다.

## Consequences

- 전환 중 run은 중단된다(확인 창으로 고지). 재기동 동안 컨트롤러가 잠시 내려간다.
- 셸 상태는 한 Mutex 뒤에 있고 긴 작업(`run_in_process`·정지 대기)은 잠금 밖에서 한다. 정지는 비동기 경로이며 동기 `block_on`은 `RunEvent::Exit`(메인 스레드)에만 있다.
- 연기: 부하기 쪽 버튼·접속 코드·같은 망 자동 찾기·토큰 재발급·방화벽 규칙 버튼·Windows/Linux 실기 검증(spec §7·§8, roadmap §B).
