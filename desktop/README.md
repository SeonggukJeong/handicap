# Handicap 데스크톱 셸 (Tauri v2)

bundle-feature `controller` exe를 사이드카로 감싸는 네이티브 창. 빌드·실행·Windows 검증 절차는
**`docs/dev/tauri-desktop-build.md`**(런북)와 **ADR-0040**을 참조.

- `src-tauri/src/launch.rs` — 순수 글루(SpawnConfig·포트 파싱·헬스 URL)
- `src-tauri/src/backend.rs` — 사이드카 spawn·헬스폴·프로세스 트리 종료
- `src-tauri/src/lib.rs` — 셸 배선(setup→navigate→RunEvent::Exit 정리)
- `src/splash.html` — 기동 중 스플래시(실 UI는 controller가 서빙)
