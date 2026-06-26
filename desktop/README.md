# Handicap 데스크톱 셸 (Tauri v2)

`handicap-controller`(bundle feature)를 in-process로 임베드하는 네이티브 창. 빌드·실행·Windows 검증 절차는
**`docs/dev/tauri-desktop-build.md`**(런북)와 **ADR-0042**를 참조.

- `src-tauri/src/launch.rs` — 순수 글루(`base_url(u16)` 헬퍼·포트 유틸)
- `src-tauri/src/backend.rs` — `ControllerBackend` 트레잇·`InProcessBackend`(컨트롤러 in-process 기동·창 navigate·async shutdown 브리지)
- `src-tauri/src/lib.rs` — 셸 배선(setup→`InProcessBackend::start`→navigate→`RunEvent::Exit` 정리)
- `src/splash.html` — 기동 중 스플래시(실 UI는 in-process 컨트롤러가 서빙)

## 빌드 전제

- `ui/dist`가 존재해야 한다(`just ui-build`). controller bundle feature의 rust-embed가 컴파일타임에 `ui/dist`를 임베드한다(`$CARGO_MANIFEST_DIR/../../ui/dist`).
- `protoc`이 설치돼 있어야 한다 — desktop이 이제 `handicap-controller{bundle}` 그래프 전체를 컴파일하므로 `tonic-build`가 필요(루트 CLAUDE.md 개발환경 세팅에 포함).

## 멀티콜 바이너리

데스크톱 바이너리는 **멀티콜**이다. in-process `SubprocessDispatcher`가 워커를 `current_exe worker …`로 self-spawn하므로, `main()` 첫 문장 `run_worker_if_invoked()`가 GUI init 전 argv를 검사해 `<app> worker …` 형태면 워커로 동작 후 `process::exit`한다. `<app> worker --controller <grpc>` 직접 실행으로 창 없이 헤드리스 워커를 띄울 수 있다.

## DB override

`HANDICAP_DB` 환경변수로 DB 경로 지정 가능(기본: 앱 데이터 디렉터리).
