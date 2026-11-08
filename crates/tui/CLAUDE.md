# TUI (`crates/tui`) 함정

이 파일은 `crates/tui/` 파일을 건드릴 때 자동 로드되는 중첩 CLAUDE.md다. 프로젝트 전역 규칙은 루트 `CLAUDE.md`, 컨트롤러(in-process 임베드 대상) 함정은 `crates/controller/CLAUDE.md`. 설계 정본 spec `docs/superpowers/specs/2026-11-07-tui-monitor-design.md`(ADR-0055), 운영자 매뉴얼 `docs/dev/tui-monitor.md`.

- **좁은 화면 문구는 통째 단위로 줄인다 — `fit()`의 `…`는 최후 수단** (tui-monitor 1a 라이브): 평균·최대 줄이 `최대 1,4…`로 숫자를 잘랐다. 줄마다 축약 단계(`text.rs` `stats_for_width`·연속 줄 `N회 연속`·머리 줄 날짜→접두→시계·키 줄 낮은 우선 조각부터)를 두고 따를 것.
- **SIGHUP 뒤 메인 스레드가 crossterm tty 읽기에서 돌아오지 않는다 — 종료 플래그만으론 임시 DB가 남는다** (1a): `shutdown.rs` 5 s 감시견이 디렉터리 삭제→터미널 복구→로그→exit 1. 원인 미규명(roadmap §B45).
- **신호 처리기는 프로세스 전역 — `cargo test`(CI)는 한 테스트 바이너리를 한 프로세스로 돌리므로 테스트에서 실제 `shutdown::install`(5 s `process::exit`) 금지, `install_with`로 주입** (1a 최종 리뷰).
- **TestBackend는 실제 터미널 수명·신호·마우스를 못 본다 — 라이브는 tmux** (1a): `new -d -x W -y H`·`send-keys`·`capture-pane -p [-e]`·`resize-window`, SGR 클릭은 `send-keys -l $'\e[<0;X;YM'`. 세션 종료 후 프로세스/임시 디렉터리 확인은 감시견 5 s 뒤에.
- **라이브 번들 fixture에 안 쓰는 시나리오를 넣으면 가져오기 거부("쓰이지 않는 시나리오"), python `http.server` 기본 listen backlog 5는 다중 TUI에서 가짜 전송 실패** (1a 라이브) — 응답기는 `request_queue_size`를 키울 것.
- **와이어 거울 타입(`wire.rs`)은 `deny_unknown_fields` + 실 in-process 응답 역직렬화 통합 테스트로 1:1 고정; crossterm은 `ratatui::crossterm` 재수출만(직접 의존 금지)** (1a).
- **칸 폭 계산(선택 `▶` 예약·상태 문구·제목)은 `saturating_sub`로, 테스트는 폭 1칸 단위 + 선택 칸 회전 + `점검 꺼짐`(가장 긴 상태 문구) 포함 스윕으로** (tui-readability 최종 리뷰): 고정 크기 6개·선택 0번 Ok 칸 스윕은 칸 28열 × 선택 `점검 꺼짐`의 `pad` 빼기 넘침 패닉을 통과시켰다(퍼즈 861/973,890).
- **라이브에서 `점검 꺼짐` 재현 = in-process REST로 보드 정지** (tui-readability): `tui.log`의 `listeners … rest=127.0.0.1:<port>`에서 포트를 얻어 `POST /api/monitor-boards/{id}/stop`. `tui.log`는 시작 때 `.1`로 회전하므로 오프셋 말고 새 파일 전체를 읽을 것.
- **CI 러너는 UTC, 개발기는 KST — 로컬 시각(`chrono::Local`) 표시를 단언하는 테스트는 기대값도 `Local`로 구할 것** (v0.13.0 릴리즈): `header_degrades_by_whole_parts`가 `"2023-11-15"`(KST)를 하드코딩해 pre-commit은 통과·첫 push의 CI만 실패했다. 재현은 `TZ=UTC cargo test -p handicap-tui`.
- **워크트리-격리 세션에서 tmux 매트릭스는 python 드라이버(`subprocess.run(["tmux", …])`)로** (tui-readability 라이브): `bash x.sh`·`$VAR`이 든 tmux 인자·`for` 루프는 git 검증 불가로 거부된다. 테스트용 `XDG_CONFIG_HOME`/`XDG_STATE_HOME`은 scratchpad로 격리(실 `~/.config/handicap/tui.json` 보호).
