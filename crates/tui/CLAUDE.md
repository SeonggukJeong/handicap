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
- **막대↔시각 줄 정렬 렌더 테스트는 막대 높이를 이웃끼리 다르게 하고, 기대 시각은 시각 줄 글자가 아니라 막대 데이터 위치에서 구할 것** (tui-axis-ticks 최종 리뷰): 모든 결과를 100 ms로 두고 `▲` 열의 기대 시각을 오른쪽 눈금과의 거리로 계산하면, 시각 줄 전체가 한 칸 밀려도 두 값이 함께 움직여 통과한다. 지연을 순환(예: 200/700/1200/1800/400)시키고, 맨 오른쪽 막대 글자를 기준으로 열→결과를 대응시켜 `▲` 아래 막대와 ±1열 막대가 다른지까지 단언한다.
- **꺼진 보드의 `/status`는 칸마다 `results: []`, 기록 API는 404 — "결과 0개"가 "실패 없음"과 구분되지 않는다** (tui-monitor-1b 라이브): 빈 목록 문구를 고를 때 보드·칸의 꺼짐 상태를 먼저 볼 것(roadmap §B48 (2)).
- **조건 칸 `CheckResult`의 `reason`은 받은 값, `detail`은 조건식** (tui-monitor-1b 라이브): "판정 상세 = 받은 값"으로 문구를 쓰면 틀린다. 미치환 `${ENV}` URL은 trace를 남긴다(`builder error`) — trace가 null인 설정 오류는 조건 스텝이 없는 칸.
- **tmux `send-keys question`은 `?`가 아니라 글자** (tui-monitor-1b 라이브): `send-keys -l '?'`로.
- **원격 문자열은 `inspect::sanitize`를 폭 계산 *전에* — 제어 문자·U+2028/2029·bidi 제어(202A–202E·2066–2069 등)를 `�`로** (tui-monitor-1b 보안 리뷰): ratatui가 ESC grapheme을 이미 걸러 `\x1b` 부재 단언은 공허, 회귀 가드는 `\u{FFFD}`가 *보이는지* 긍정 단언.
- **tokio mpsc는 Sender를 다 버려도 남은 큐를 다 꺼낸 뒤 `None`** (tui-monitor-1b 최종 리뷰): 세션을 내릴 때 작업자는 통로 닫기만이 아니라 `JoinHandle` abort·await.
- **입력줄 키 판정은 "적용 뒤 버퍼"를 함께 돌려줄 것 — 결과만 돌려주면 호출 쪽 이중 적용·미적용 함정, 글자 그대로임은 `text()`로 단언** (tui-2a-1 Task 7 리뷰): `edit_key`가 복제본에 키를 넣어 `Input(Edited)`만 돌려주던 때는 정규화된 키(`ㅂ`→`q`)를 넣어도 테스트가 통과했다. `EditAction::Input(결과, 적용 뒤 LineInput)` + 편집 화면의 모든 키 뒤 `track_digit`.
- **값을 품는 타입은 derive `Debug` 금지 — `LineInput`·`Overlay`·`EditReq`·`EditDone`·`ScenarioResponse`는 손 Debug(종류·길이만)** (tui-2a-1): `Vec<char>` 버퍼는 `'T', 'Y'`로 찍혀 값 부분문자열 단언을 빠져나간다. `Saving{restore}`도 입력값을 품는다 — 5분 복귀(`idle_drop`)에서 비울 것.
- **YAML 글자 교체의 구조 재검증은 주석을 못 본다 + "정확히 1개" 가드 테스트는 닮은 줄을 진짜 줄 *뒤*에** (tui-2a-1 Task 2 리뷰): `값<탭># 주석`을 값으로 삼켜 주석이 조용히 지워졌다(탭+`#`도 주석). 닮은 줄이 앞이면 다른 경로로 거절돼 가드를 지워도 통과한다 — 변이로 RED를 확인할 것.
- **목록을 그릴 때 항목마다 전체 파싱 금지 — `static_vars`가 변수마다 YAML을 4번 파싱해 UI 스레드가 분 단위로 멈췄다** (tui-2a-1 보안 F1): 편집 가능 판정은 글자 위치 찾기만, 검증은 저장 때. tui-2b도 같다 — 값 목록의 화면 글자·칸 폭은 열 때 한 번(`ValuesState::new`), 표지처럼 그릴 때 계산하는 것은 보이는 줄에만(클로저), `sanitize`를 마친 글자는 생성자로만 만들 수 있게 필드 비공개 (tui-2b).
- **TestBackend에서 넓은 글자의 둘째 칸은 공백 — 줄 문자열 검색은 그 칸을 건너뛰고, 고른 줄 바탕 단언은 머리 줄(y=0)이 아닌 본문 줄에서** (tui-2a-1 Task 9 리뷰): `find_cell("A")`가 머리 줄 칸을 집어 머리 줄끼리 비교하는 공허 단언이 됐다. 선택 스타일을 지워 RED 확인.
- **`key_bar`는 앞 조각부터 뺀다 — 가장 중요한 `Enter 저장`을 끝까지 남기려면 `view::edit::fit_keys`(표시 순서는 그대로, 빠지는 순서만 따로)** (tui-2a-1 Task 10 리뷰).
- **도움말의 경로 줄은 `fit` 한 줄 금지 — 실제 경로 길이에선 뒤쪽 경로가 통째로 잘린다, `wrap_width`로** (tui-2a-1 라이브).
- **root 컨테이너에선 `chmod`로 쓰기 실패를 못 만든다 — 실패 주입은 권한이 아니라 모양으로(`<파일>.bak` 자리에 디렉터리, FIFO는 `mkfifo` + 5초 제한 스레드)** (tui-2a-1).
- **tmux 붙여넣기 검증은 `load-buffer` + `paste-buffer -p`(브래킷), 마우스는 SGR 누름+뗌 둘 다** (tui-2a-1 라이브).
- **`App::pump`에서 조회 결과를 `SubViews::accept` 전에 가로채면 `views.clear()` 보호를 건너뛴다 — 세션 재시작(`start_session`)이 그 통로를 직접 비울 것** (tui-check-now Task 4 리뷰).
- **tmux 라이브에서 화면 전체로 `지금 점검`을 찾으면 키 줄 `r 지금 점검`에 먼저 맞는다 — 머리 줄 알림은 첫 줄만 읽고, 자세히가 `불러오는 중…`인 동안의 `Enter`는 무동작이라 스텝 표가 뜬 뒤 누를 것; 80×24 도움말 백업 줄은 경로가 길면 먼저 빠지므로 짧은 경로(심볼릭 링크)로 확인** (tui-check-now 라이브).
- **줄마다 경로 전체를 드는 목록은 64KB 본문에서도 수백 MB가 된다(긴 키 × 많은 값) — 줄 수가 아니라 글자 합계에 상한(`pick::MAX_PATH_BYTES`), 상한 테스트는 경계 케이스를 폭발 케이스보다 앞에** (tui-2b): 회귀가 멈춤이 아니라 빠른 실패가 되게.
- **아래에 붙는 창의 줄 수 한도는 호출 쪽이 쓰는 줄(제목 줄 + 고른 줄)을 빼야 한다 — 빼먹으면 목록이 0줄** (tui-2b): "고른 줄이 보인다"를 낮은 높이를 반복해 단언.
- **"성질 테스트"가 "만든 것이 맞다"만 보면 덜 만든 회귀를 못 잡는다 — 개수(잎 수 == 줄 수) 단언을 같이** (tui-2b).
- **화면 집합 판정(`is_edit_screen`)은 순수 함수로 빼 "새 화면을 편집 화면 목록에 안 넣음"을 테스트로 잡는다** (tui-2b).
