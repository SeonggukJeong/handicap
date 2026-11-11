# 터미널(TUI) 운영 모니터 — 설계

- 날짜: 2026-11-07 · 유형: `user-path` + `platform` · 결정: [ADR-0055](../../adr/0055-tui-monitor.md)
- 범위: 설계는 세 슬라이스 전체(§0), **구현 계획은 슬라이스 1a만**(1b·2는 각각 별도 계획).
- 상태: **1a 완료**(2026-11-08, 코드 `0b2bb1a5`..`9eddb984`; 판단·연기 roadmap §B45 — 임시 DB는 §4.2의 `<pid>.db` 대신 `mkdtemp` 전용 디렉터리). **1b 완료**(2026-11-11, 코드 `98b2f6c`..`cbc053c`; plan `docs/superpowers/plans/2026-11-10-tui-monitor-1b.md`, 판단·연기 roadmap §B48), **2a 설계 확정**(2026-11-11, §6 — 목업 `2026-11-11-tui-2a-mockups/`), 2b 미착수.

## 사용자 스토리 (US)

- **US1** *(1a)*: 도입담당이 Ubuntu 19.04 저사양 PC에 릴리즈에서 받은 handicap TUI 바이너리 파일 하나를 복사해 실행한다 — 성공하면 추가 라이브러리 설치 없이, glibc 버전 오류 없이 화면이 뜬다.
- **US2** *(1a)*: 운영자가 자동 시작 설정(`~/.config/autostart`)에 TUI 실행 줄과 보드 json 경로를 넣어 둔다 — 성공하면 PC를 켜고 로그인되는 즉시 점검 화면이 뜨고 점검이 시작된다. 칸별 상태·최근 응답 시간·막대 이력과 화면 맨 아래 키 안내 줄이 보인다. json에 문제가 있으면 창이 닫히지 않고 원인이 화면에 남는다.
- **US3** *(1b)*: 운영자가 지나가 버린 실패를 확인하려 한다 — 방향키로 칸을 고르고 오류 보기 키를 누르면 최근 실패 목록에서 고른 회차의 **사유(HTTP 코드·전송 실패 내용)·판정에서 받은 값**이 보이고, 한 단계 더 들어가면 요청·응답 기록이 보인다.
- **US4** *(2a)*: 운영자가 칸 설정을 고쳐야 한다 — 칸에서 Enter → 번호로 항목 선택 → 값 수정하면 바로 점검에 반영되고 TUI를 재시작해도 유지된다(json에 저장, 백업 남김). 묶음 칸에서 미리 실행하면 **그 칸의 스텝만** 결과로 보인다. 도움말은 "새 파일로 바꾸면 이 PC에서 고친 값은 사라진다"를 알린다.
- **US7** *(2a, 사용자 추가 2026-11-11)*: 운영자가 서버 주소나 토큰이 바뀌어 점검이 실패하기 시작했다 — 칸 설정에서 그 칸이 쓰는 환경 변수 값을 고치면(같은 환경을 쓰는 칸이 여럿이면 그 수를 보고 확인) 다음 점검부터 새 값으로 돌고 TUI를 재시작해도 유지된다. 값은 화면에 기본으로 가려져 있다.
- **US8** *(2a, 사용자 추가 2026-11-11)*: 운영자가 시나리오 변수(`variables:`의 고정 값, 예: 조회할 주문 번호)를 바꿔야 한다 — 칸 설정에서 값만 고치면 다음 점검부터 반영되고, 저장된 파일의 그 시나리오 YAML은 그 값 한 줄 말고는(주석 포함) 글자 그대로다. 고칠 수 없는 모양의 값이면 저장하지 않고 "GUI에서" 안내가 보인다.
- **US9** *(2b)*: 운영자가 칸 설정에서 미리 실행한 뒤 응답의 값을 골라 성공 조건·화면 표시 값을 추가한다(2b 계획에서 구체화).
- **US5** *(1a)*: 운영자가 GUI에서 칸을 추가한 새 json을 받았다 — 파일을 교체하고 TUI를 다시 띄우면 새 칸을 포함해 점검이 시작된다.
- **US6** *(1a, 사용자 추가 요청 2026-11-07)*: 운영자가 자리를 비운 사이 오류가 잠시 발생했다가 지나갔다 — 막대 아래 시각 눈금(예: `09:15 … 09:41`)을 보고 그 실패 막대가 대략 몇 시 몇 분쯤이었는지 키를 누르거나 막대 수를 세지 않고 바로 읽는다. (회차별 정확한 시각은 1b 오류 보기 목록.)

## 0. 슬라이스

| 슬라이스 | 내용 | US |
|---|---|---|
| **1a** | 컨트롤러 `in-process` 기능 분리 · TUI 부트스트랩(로그·임시 DB·터미널 복구·워커 가드) · 모니터 화면(키보드·마우스 칸 선택) · 오류 화면 · `--check` · zigbuild 릴리즈 잡·게시 스크립트 · 매뉴얼 · 막대 시각 줄 | US1·2·5·6 |
| **1b** | 오류 보기(목록→상세→본문) · 칸 설정 보기(읽기 전용) · 이름 해석(번들 시나리오 파싱) | US3 |
| **2a** | 설정 수정·환경/시나리오 변수 값 수정·파일 되쓰기(백업)·미리 실행 · 1b 연기(꺼진 보드 빈 문구) | US4·US7·US8 |
| **2b** | 미리 실행 결과에서 조건·표시 값 추가 | US9 |

1a만으로 지금의 bash 모니터를 대체할 수 있다. 1b는 1a 직후 이어서 한다(오류 보기는 사용자가 "당장 필요"로 꼽은 기능).

## 1. 배경

- 모니터 PC는 저사양·EOL OS가 많다. 당장 대상은 **Ubuntu 19.04**(아키텍처 x86_64 — §10), 기본 Firefox만 있음, 회선이 좁아 새 브라우저 반입이 불확실.
- 현재 Linux 배포물은 `release.yml` `ubuntu-gui` 잡이 `ubuntu-24.04`에서 Tauri로 빌드 → glibc 2.39 + `libwebkit2gtk-4.1`(22.04+) 요구 → 19.04에서 실행 불가.
- 헤드리스 컨트롤러 + 브라우저 경로: UI는 Vite 5이고 `build`에 `target` 미지정 → Vite 5 기본(ES2020·firefox78). 19.04 기본 Firefox(66, 지원 종료 시점 업데이트 72 추정)는 `?.`·`??`를 못 읽어 빈 화면일 가능성이 크다(**추정 — 실기 미확인**).
- 그 PC는 지금 bash 스크립트 모니터를 `~/.config/autostart`의 `.desktop`으로 로그인 시 실행한다. 같은 방식으로 TUI를 띄운다.
- `ubuntu:19.04` amd64 Docker 이미지는 받을 수 있고 glibc 2.29다(2026-11-07 실측, python·curl 없음).

## 2. 목표 / 비목표 / 반목표

**목표**
- Ubuntu 19.04에서 단일 바이너리로 실행되는 운영 모니터 화면(점검 실행 포함).
- GUI에서 내보낸 `handicap-bundle` 파일 하나로 시작, 실행 즉시 점검 시작.
- 지나간 실패의 원인 확인(1b), 칸 단위 설정 수정(2).

**비목표**
- 부하 테스트(run)·리포트·시나리오 편집·보드/칸/묶음 **추가·삭제**(GUI에서).
- GUI 화면 장식 이식: `font_scale`·`display_style`·`blink`·포커스/스트립 배치·크기 측정. 값은 파일에 보존만 하고 화면엔 쓰지 않는다.
- 웹 UI 내장(TUI 바이너리에 `ui/dist`를 넣지 않는다 — §4.1).
- 원격 컨트롤러 접속 모드(경계만 열어 둔다), Windows/macOS용 TUI 배포.
- 오래된 점검 기록 보관(GUI와 같은 수준).

**반목표**
- 부팅 자동 실행에서 오류 시 **창이 닫혀 원인이 사라지는 것**(프로세스가 죽는 경우 포함 — §3).
- 로그·패닉 출력이 터미널에 섞여 **화면이 깨지는 것**.
- 같은 보드·같은 결과에서 GUI와 **다른 상태 문구·큰 값·연속 실패 줄**을 보이는 것.
- 실수 한 키로 모니터가 꺼지는 것(종료는 확인 필요).

## 3. 사용 흐름

1. Windows GUI에서 보드를 만들고 **내보내기**(ADR-0054) → json 파일.
2. 19.04 PC에 `handicap-tui`와 json 복사.
3. `~/.config/autostart/handicap-tui.desktop`:
   ```ini
   [Desktop Entry]
   Type=Application
   Name=Handicap 모니터
   Exec=gnome-terminal --full-screen -- sh -c '/opt/handicap/handicap-tui /home/ops/board.json; echo; echo "핸디캡 모니터가 종료됐습니다. Enter를 누르면 창이 닫힙니다."; read x'
   X-GNOME-Autostart-enabled=true
   ```
   - `--full-screen`: 상단 바·Ubuntu Dock까지 가림(F11로 해제) — **사용자 선택**. 매뉴얼엔 `--maximize` 대안도 적는다.
   - `sh -c '…; read x'` 감싸기: glibc 로더 오류·크래시처럼 **TUI 밖에서 프로세스가 죽어도** 창이 남아 원인이 보이게(반목표 1).
   - 네트워크가 늦게 오르면 `X-GNOME-Autostart-Delay=<초>`(Xorg) 또는 명령 앞 `sleep N;`(Wayland). 로그인 시점 실행이라 자동 로그인 전제(현재 bash 방식과 동일).
4. 로그인 → 터미널 전체 화면 → 파일 가져오기 → 점검 시작 → 모니터 화면.
5. 새 칸이 필요하면 GUI에서 다시 내보내 파일 교체 → TUI 재시작(US5).

## 4. 구조

### 4.1 crate·기능 구성

- **컨트롤러 기능 분리(1a 첫 코드 변경)**: 지금 `in_process` 모듈은 `bundle` 기능에만 있다(`crates/controller/src/lib.rs` `#[cfg(feature = "bundle")] pub mod in_process`). `bundle`은 `rust-embed`로 `ui/dist`를 컴파일 타임에 넣으므로, TUI가 `bundle`을 켜면 workspace feature 통합 때문에 `ui/dist` 없는 CI `rust` 잡·새 워크트리·pre-commit 빌드가 깨지고 `target/debug/controller`가 bundle 모드로 바뀐다(`desktop/CLAUDE.md`가 desktop을 별도 workspace로 둔 이유). 그래서:
  - 새 기능 `in-process = ["dep:handicap-worker", "dep:dirs"]`, `bundle = ["in-process", "dep:rust-embed", …, "dep:open"]`.
  - `lib.rs`의 `in_process` 게이트만 `in-process`로 바꾼다. `bundle` 모듈·`main.rs`·`app.rs`의 `bundle` 게이트는 그대로 → `in-process`가 workspace 전체에서 켜져도 컨트롤러 바이너리·테스트 동작 불변.
  - 근거: `in_process.rs`가 쓰는 선택 의존은 `dirs`·`handicap_worker`뿐(`grep -n "dirs::\|handicap_worker\|rust_embed\|open::\|crate::bundle" crates/controller/src/in_process.rs`).
- 새 crate `crates/tui`, 바이너리 `handicap-tui`, 의존 `handicap-controller = { features = ["in-process"] }`. workspace glob이라 기존 cargo 게이트·CI가 덮는다. 웹 UI가 들어가지 않으므로 바이너리가 작다.
- `main` 첫 문장 = `handicap_controller::in_process::run_worker_if_invoked()`: in-process 디스패처는 자기 실행 파일을 워커로 띄우므로(`in_process.rs` Subprocess), 누군가 루프백 API로 run을 만들면 `handicap-tui worker …`가 뜬다 — 이 가드가 없으면 두 번째 TUI가 같은 터미널에 그려진다.
- 컨트롤러: `run_in_process(InProcessConfig{ db: Some(<임시 DB>), scheduler_disabled: true, ..Default })`. 기본 `rest`/`grpc` = `127.0.0.1:0`. `run_in_process`는 `db`를 줘도 `~/.local/share/handicap`(data-local-dir)을 만든다 — 실패 시 기동 실패(오류 화면, §4.3).
- TUI는 `rest_addr()`의 루프백 REST를 부르는 클라이언트(reqwest). 컨트롤러 내부 함수를 직접 부르지 않는다(쓰기 핸들러의 "DB 쓰기 → reconcile" 규약, `api/monitor_boards.rs` 모듈 주석).
- **와이어 타입**: `BoardConfig`·`CheckResult`·`ImportResult`(컨트롤러)·`ScenarioTrace`(엔진)는 이미 `Deserialize`라 재사용. `StatusResponse`/`PanelStatus`/`BoardResponse`처럼 `Serialize`만 있는 응답 래퍼는 TUI에 거울 타입을 두고, **실제 in-process 컨트롤러 응답을 역직렬화하는 통합 테스트**로 1:1을 고정한다. 컨트롤러 와이어 0-diff.
- 1a 엔드포인트: `POST /api/monitor-boards/import` · `POST /{id}/start` · `GET /{id}` · `GET /{id}/status`. 1b: `GET /{id}/panels/{panel_id}/records/{at_ms}`. 2: `PUT /{id}` · `POST /export` · `POST /preview-check`.

### 4.2 부트스트랩

- **로그**: 컨트롤러는 tracing을 초기화하지 않는다(호출자 소유, `in_process.rs` `run_worker_if_invoked` 주석). TUI가 구독자를 **파일 전용**으로 초기화 — `$XDG_STATE_HOME/handicap/tui.log`(기본 `~/.local/state/handicap/tui.log`), 실행마다 새로 쓰고 직전 것은 `.1`로 하나 보존(`--check`는 돌고 있는 화면의 로그를 건드리지 않게 `tui-check.log`), 기본 수준 `info`, `RUST_LOG`가 있으면 따른다. stderr 출력 0을 통합 테스트로 고정.
- **패닉**: 프로세스 전역 패닉 훅은 **로그 파일에만** 기록하고 stderr 기본 훅을 부르지 않는다. 터미널 복구는 **UI 스레드의 패닉일 때만**(컨트롤러 백그라운드 태스크 패닉은 tokio가 잡으므로 화면을 유지한다). 정상 종료·UI 스레드 unwind는 drop 가드가 raw mode·대체 화면을 되돌린다. UI 스레드 패닉 후엔 터미널에 "로그: <경로>" 한 줄을 남기고 종료(§3의 `read x`로 창 유지).
- **임시 DB**: `$XDG_RUNTIME_DIR/handicap-tui-<pid>.db`(없으면 `std::env::temp_dir()`). `connect` 전에 0600으로 **먼저 생성**(`store::connect`는 `create_if_missing`). 정상 종료 시 `-wal`/`-shm`까지 삭제, 시작 시 같은 디렉토리의 죽은 pid 잔재 정리.

### 4.3 시작 순서와 오류 화면

1. 인자: `handicap-tui <bundle.json>` · `handicap-tui --check <bundle.json>` · `--version` · `--help`.
2. 로그 → 임시 DB → 컨트롤러 기동.
3. 파일 읽기 → **선행 UTF-8 BOM 제거**(Windows 편집 파일; 서버 R0는 요청 본문 맨 앞 BOM만 지운다 — `board_file.rs` `parse_json_bytes`) → `{"bundle":` + 파일 텍스트 + `}`로 감싸 `import`(재직렬화 금지, ADR-0054) → 가져온 보드 **전부** `start`.
4. 모니터 화면.

2–3 실패 시 **오류 화면**에 머문다: 실패 단계(파일 없음·권한·서버 거부 문구[R0–R7 그대로, 값 비노출]·컨트롤러 기동 실패), 파일 경로, 로그 경로, `r` 다시 시도 / `q` 종료. **`r`은 컨트롤러부터 다시** — 컨트롤러 종료 → 임시 DB 삭제 → 새 임시 DB → 컨트롤러 기동 → 3단계(가져오기 성공 후 `start`만 실패한 경우 같은 DB에 재가져오기하면 409라서). **로그 초기화·회전은 프로세스당 1회**만 — 재시도가 전역 tracing 구독자를 다시 설치하거나(패닉) 원래 실패 로그를 `.1`로 밀어내지 않게. 인자 없이 실행하면 사용법·매뉴얼 위치를 같은 화면에.

**`--check <file>`**: 화면 없이 2–3 수행 → `/status`를 1초 간격으로 읽어 **모든 칸에 결과가 1개 이상** 생길 때까지 대기(감독자는 시작 즉시 첫 점검을 돈다 — `supervisor.rs` `unit_loop`: 점검 후 `sleep_until(started + interval)`). 점검은 전역 동시 상한 `MAX_CONCURRENT_CHECKS = 32`(`supervisor.rs`)를 공유하므로 실행 단위가 32개를 넘으면 첫 회차가 줄을 선다 → 대기 상한 = ⌈실행 단위 수 / 32⌉ × 칸들의 `check_budget_seconds` 최댓값 + 10초(실행 단위 = 묶음 1개 또는 단독 칸 1개, **시작한 모든 보드에 걸쳐** 센다 — 상한은 컨트롤러 전체 공유). 칸마다 `제목  상태 문구  큰 값` 한 줄 출력(상태 판정은 §4.4 규칙 그대로). exit: 0 = 모든 칸 결과 수신(점검 실패 여부 무관) · 1 = 기동·가져오기·`start` 실패 · 2 = 대기 상한 초과. 용도: 대상 OS 기동 스모크(§7)·사용자 파일 사전 점검. crossterm 경로는 검증하지 않는다(→ §8 라이브).

### 4.4 화면 판정 규칙 이식 (GUI와 같은 결과)

`ui/src/monitor/logic.ts`·`display.ts`·`MonitorDisplayPage.tsx`·`MonitorPanel.tsx`에서 **판정·문구 규칙만** Rust snake_case 순수 함수로 옮긴다.

- 함수: `bar_color` · `stale_after_ms` · `panel_state` · `bar_slots` · `latency_stats` · `show_consecutive` · `big_value_text` · `format_ms` · `grid_for`(GUI `gridFor` 표 그대로: 1→1×1, 2→2×1, 3→3×1, 4→2×2, 5–6→3×2, 7–9→3×3) · `split_reason` · `reason_parts`(세 갈래 `split`/`detail`/`not_contained` 전부 — `display.test.ts` 케이스 1:1).
- **호출부 규칙**(`MonitorDisplayPage.tsx`):
  - `nowMs` = 서버 `status.now_ms`(로컬 시계 아님). `budgetSec` = `check_budget_seconds`(없으면 `timeout_seconds`).
  - 서버 끊김 = **연속 3회** 폴링 실패(`SERVER_DOWN_AFTER = 3`), 폴링 1회 제한 3000 ms(`STATUS_TIMEOUT_MS`), 404는 실패로 세지 않는다.
  - 첫 status 도착 전: 끊김이면 stale, 아니면 pending.
- **칸 표시 게이트**(`MonitorPanel.tsx`): 연속 실패 줄은 `state == fail` ∧ `consecutive_fail ≥ 2` ∧ `fail_since_ms` 있음일 때만, 문구 `N회 연속 · HH:MM:SS부터`(`ko.monitor.consecutive`). 평균·최대 줄은 `show_latency_stats` ∧ state ∈ {ok, slow, fail}. 실패류 큰 값은 `reason_parts`로 나눠 고정부 크게·스텝부 작게.
- 상태 문구는 `ko.ts` `stateOk`…`statePending` 값 그대로.
- **동등성 테스트**: 위 함수의 `ui/src/monitor/__tests__` 케이스를 Rust 단위 테스트로 1:1 옮긴다. 계획에 "TS 케이스 ↔ Rust 테스트" 대조표를 둔다. 공용 골든 파일은 만들지 않는다(규모 대비 과함).

## 5. 화면

### 5.1 모니터 화면 (1a)

> 2026-11-08 [tui-readability](2026-11-08-tui-readability-design.md)가 칸 배치·막대·기준선·테두리·선택 표시를 개정했다 — 충돌 시 그 문서가 우선.

```
 Handicap 모니터 · 운영 API 보드 (1/2)                         2026-11-07 09:41:03  점검 중
┌ 로그인 ────────────────────┐┌ 주문 조회 ─────────────────┐┌ 결제 ──────────────────────┐
│ ✔ 정상          182 ms     ││ ✖ 실패   HTTP 503          ││ ▲ 느림        1,350 ms     │
│                            ││ 4회 연속 · 09:39:51부터    ││                            │
│ ▂▂▃▂▂▂▅█▂▂▂▃▂▂▂▂▂▂▂▂▂▂▃▂▂▂ ││ ▂▂▂▂▂▃▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂████ ││ ▂▃▃▅▅▆▆▆▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇ │
│ 09:15     09:28      09:41 ││ 09:15     09:28      09:41 ││ 09:15     09:28      09:41 │
│ 평균 190 · 최대 512 ms     ││ 평균 201 · 최대 340 ms     ││ 평균 980 · 최대 1,402 ms   │
└────────────────────────────┘└────────────────────────────┘└────────────────────────────┘
 ←↑↓→ 칸 이동  Tab 다음 보드  ? 도움말  q 종료
```
(배치 예시 — 글자 배치는 구현 재량. 1b에서 `e 오류 보기`·`Enter 칸 설정`이 키 안내 줄에 추가된다. "로그인" 칸의 8번째 막대 `█`가 지나간 실패 — 시각 줄로 09:22쯤임을 읽는다(US6).)

- **머리 줄**: 보드 이름, 순번(여러 개일 때), 서버 시각, 점검 상태(끊김이면 원인).
- **칸 격자**: `grid_for`. 선택된 칸은 테두리 강조.
- **칸 내용**: 제목 · 상태 문구 + 큰 값 · 연속 실패 줄 · 막대 이력(`bar_slots`로 `bar_count` 슬롯을 만들고 칸 폭에 들어가는 최신 쪽만, 높이 = 지연/`graph_max_ms` 8단계 블록, 색 = 성공은 `bar_color`·실패는 빨강·설정 오류/확인 못 함/분기 제외는 회색 — GUI `LatencyBars.tsx`와 같게, 1a plan 리뷰에서 정정) · **시각 줄**(아래) · 평균·최대 줄 · 칸 높이가 남으면 벽 표시 값(`display_items` 최대 2개, 최신 결과의 `display`).
- **시각 줄 (US6, 사용자 요청 2026-11-07 — TUI 전용)**: 막대 줄 바로 아래 한 줄에 그 막대들의 **실제 점검 시각**(`CheckResult.at_ms`, PC 로컬 시각)을 눈금으로 쓴다. GUI는 축에 "N분 전 … 지금"을 쓰고 마우스를 올리면 시각을 보여 주지만(`LatencyBars.tsx` `axisAgoLabel`·hover `formatHms`) TUI엔 hover가 없어 시각을 직접 쓴다 — GUI 0-diff.
  - 눈금 = 보이는 막대 중 **가장 오래된 막대**(왼쪽 끝, 그 막대 칸에서 시작 — 결과가 몇 개뿐이라 폭을 넘으면 오른쪽 끝에 붙임) · **최신 막대**(오른쪽 끝, 그 막대 칸에서 끝남) · 폭이 남으면 그 사이 **중간 눈금**(눈금 글자 범위 안에 자기 막대가 있다). 눈금끼리는 2칸 이상 띄우고, 겹치거나 **이웃 눈금(앞·뒤, 오른쪽 끝 포함)과 글자가 같으면** 생략. 둘 다 못 들어가면 왼쪽 끝만(최신 쪽은 머리 줄 서버 시각이 대신한다). 빈 슬롯(결과가 아직 없는 왼쪽)엔 눈금 없음, 결과가 하나도 없으면 빈 줄.
  - 형식: 보이는 구간이 **10분 이상이면 `HH:MM`, 미만이면 `HH:MM:SS`**(사용자 선택 2026-11-07). 구간은 **명목값** `(보이는 막대 칸 수 − 1) × interval_seconds`로 잰다 — 실측 `at_ms` 차이로 재면 정확히 10분 근처에서 ms 흔들림으로 매초 형식이 바뀌어 벽 모니터가 깜박인다(1a 리뷰). 하루(24시간)를 넘는 구간은 날짜가 없어 끝 시각이 같아 보일 수 있다 — §10 한계.
  - 막대와 시각 줄은 **같은 가로 범위**(칸 안쪽 왼쪽부터 `min(bar_count, 안쪽 폭)`칸)에 그린다.
  - 막대는 결과 순서대로 놓이므로 점검이 밀리거나 끊긴 구간은 눈금 간격이 고르지 않다 — 그대로 보인다(시각을 지어내지 않는다).
- **칸 높이가 모자랄 때 줄 우선순위**: 상태 줄 > 막대 > 시각 줄 > 연속 실패 줄 > 사유 작은 줄 > 평균·최대 줄 > 벽 표시 값(사용자 승인 순서 그대로, 사유 작은 줄은 연속 실패 줄 다음에 끼움). **사유 작은 줄** = 실패류 큰 값을 `reason_parts`로 나눈 스텝부/detail부(GUI `MonitorPanel.tsx` `smallLine` — 큰 값 아래 별도 줄, 안쪽 폭에서 잘림). 화면 순서는 상태 · 사유 작은 줄 · 연속 실패 · 막대 · 시각 · 평균·최대 · 벽 표시 값. 칸 최소 24×6(안쪽 4줄)이면 상태·막대·시각이 항상 보이고, 연속 실패 중인 칸이면 넷째 줄은 연속 실패 줄이고, 사유 작은 줄은 안쪽 5줄 이상일 때 보인다(연속 실패가 아니면 넷째 줄이 사유 작은 줄).
- **색**: hex → 터미널 RGB(gnome-terminal 3.32 truecolor 지원 — 대상 환경 한정 판단, 256색 폴백 비목표).
- **키 안내 줄**: 맨 아래 항상, 현재 화면에서 쓸 수 있는 키만.
- **작은 터미널**: 칸 최소 크기를 못 채우면 "창을 키워 주세요(현재 W×H, 필요 W×H)".
- **폴링 범위**: 보드는 파일의 것 **전부 start**, `/status` 폴링은 **보이는 보드만**(GUI와 같음). 한 파일 최대 50보드(`board_file.rs` `MAX_BOARDS`)는 그대로 허용 — 저사양 PC 부담은 사용자가 내보낼 보드를 고르는 것으로 관리(매뉴얼에 안내).

### 5.2 키

| 키 | 동작 | 슬라이스 |
|---|---|---|
| 방향키 / `h j k l` | 칸 선택 이동 | 1a |
| `Tab` / `Shift+Tab` | 다음/이전 보드(2개 이상일 때) | 1a |
| `?` | 도움말(모든 키·파일 경로·로그 경로) | 1a |
| `q` / `Ctrl+C` | 종료 확인창(`y` 종료 / 그 외 취소) | 1a |
| `Esc` | 한 단계 뒤로 | 1a |
| 마우스 왼쪽 클릭 | 그 칸 선택(모니터 화면 칸 격자에서만) | 1a |
| `e` | 선택 칸 오류 보기 | 1b |
| `Enter` | 선택 칸 설정(1b 읽기 전용, 2 수정) | 1b |

마우스(사용자 결정 2026-11-07: "작업량 차이가 없다면 지원"): 렌더 때 계산한 칸 사각형에 클릭 좌표를 대조하는 수준이라 1a에 포함. crossterm 마우스 이벤트 받기 모드를 켜므로 평범한 드래그 복사는 막히고 Shift+드래그로 복사한다(사용자: 복사할 일 거의 없음 — 도움말에 한 줄 안내). 종료·패닉 복구 때 마우스 모드도 끈다. 목록·메뉴 클릭은 비목표.

### 5.3 오류 보기 (1b, US3)

1. **목록**: 선택 칸의 현재 막대 구간 결과 중 verdict ∈ {`fail`, `config_error`, `upstream_failed`}, 최신 순. 줄 = 시각 · 상태 문구 · 사유. `a`로 전체 회차 토글. `/status`는 최신 결과에만 사유를 싣기 때문에(`api/monitor_boards.rs` "사유·detail은 최신 결과에만") 사유는 **화면에 보이는 줄만 기록 API로 지연 조회**(404면 "기록이 지났습니다").
2. **상세**: 시각 · 상태 · **사유** · **판정 상세**(`result.detail` — 컨트롤러가 주는 판정 근거: 조건 칸이면 조건식, 받은 값은 `사유`에 실린다 — 라이브 2026-11-11 확인) · 지연 · 스텝 표(스텝 이름 · 메서드 · URL · HTTP 상태 · 지연 · **오류 내용**(`StepTrace.error` 문자열) · 시간 초과 표시(`timed_out`)). 스텝 칸이면 그 스텝 행 강조. `StepTrace`엔 구조화된 전송 실패 종류·스텝 이름이 없다(`crates/engine/src/trace.rs`) — 이름은 아래 이름 해석으로.
3. **trace 없는/특수 기록**: `trace: null`(설정 오류·바깥 시간 초과), `if` 행, `trace.error`, `truncated`를 GUI `CheckRecordDialog.tsx`와 같은 구분으로 문구 표시(문구는 `ko.ts` 해당 키 값 그대로).
4. **본문**: 요청/응답 헤더·본문, PgUp/PgDn·↑↓ 스크롤. 서버가 가린 값 그대로. **요청 본문은 기본 가림 + `v`로 보기**. `clipped`면 "기록 상한(N KB)에서 잘림"(화면 문구는 `ko.monitor.recordClipped` 그대로 `기록 상한 NKB에서 잘림`).
- **이름 해석**: 시나리오·스텝·환경 이름은 TUI가 이미 가진 **번들 파일**의 `scenarios[].yaml`을 엔진 시나리오 모델로 파싱하고 `environments[].name`을 읽어 얻는다(추가 엔드포인트 없음). loop/parallel/if 안의 HTTP 스텝까지 GUI `flattenHttpSteps`와 같은 순서로 평탄화 — 1b 계획에서 엔진 쪽 대응 함수를 확정(없으면 TUI에 이식). → 1b 계획 확정: 공개된 엔진 대응 함수 없음(`reqgen::collect_http` 비공개·컨트롤러 `collect_http_steps` `pub(crate)`), TUI `names.rs`에 같은 순서로 이식.

**1b 확정 (사용자 2026-11-10, 목업 [01-screens.html](2026-11-10-tui-1b-mockups/01-screens.html))** — 위 본문과 다르면 이 블록이 우선.
- **화면 전체 전환**: 오류 보기(목록·자세히·요청·응답)와 칸 설정 보기는 모니터 위 창이 아니라 화면 전체를 쓴다. 맨 윗줄은 모니터와 같은 머리 줄(보드 이름·시각·점검 상태).
- **무입력 5분 자동 복귀**(새 규칙): 이 네 화면(그 위에 뜬 종료 확인창 포함)에서 키·마우스 입력 없이 5분이 지나면 모니터 화면으로 돌아간다 — 벽 모니터가 목록에 멈춰 있지 않게. 요청 본문 보기는 다시 가려진다. 도움말·모니터 위 종료 확인창에는 적용하지 않는다. 운영자에게 알림: 네 화면의 키 줄 바로 위에 `5분 동안 입력이 없으면 모니터로 돌아갑니다`(높이 10줄 미만이거나 폭이 모자라면 통째 생략), 도움말(`?`)과 매뉴얼에도 같은 문장.
- **목록**: 열어 둔 동안 새 결과는 위에 더하고 고른 줄은 같은 회차(`at_ms`)에 머문다. 머리 오른쪽 `실패 N회 · 최근 M회(약 X분) 중`(`a` 뒤 `전체 M회`). `a`로 본 정상·느림 줄은 사유 칸에 응답 시간. 지워진 기록(404)의 사유 칸은 `기록 지남`(자세히 화면은 GUI 문구 `ko.monitor.recordMissing` 그대로). 실패가 없으면 `이 구간에 실패가 없습니다`. 판정 상세는 목록이 아니라 자세히 화면에.
- **자세히**: 스텝 칸이면 그 스텝 줄에 `◀ 이 칸`을 붙이고 처음부터 그 줄을 고른다.
- **요청·응답**: 본문이 JSON이면 들여써서(키 순서·숫자 표기 불변), 아니면 원문. GUI와 같은 한도로 원문: 64KB 초과(안내문 `ko.monitor.recordTreeTooLarge`)·중첩 64단 초과(안내문 `ko.monitor.recordTreeTooDeep` — TUI가 직접 센다)·파싱 실패·잘린 본문. `←`/`→`로 자세히로 돌아가지 않고 같은 기록의 이전·다음 HTTP 스텝(조건 분기 줄 건너뜀).

**1b 구현 확정 (2026-11-11, 코드 `98b2f6c`..`568631f`)** — 구현하며 정한 것. 목업과 다르게 둔 것의 전체 목록은 plan "목업과 다른 점" 절.
- **빈 줄 없음**: 목업 그림의 구획 사이 빈 줄(머리 줄 아래·제목 아래·표 앞·키 줄 위)은 그리지 않는다 — 낮은 터미널에서 내용 줄을 하나라도 더 보이게. 요청·응답 화면의 헤더·본문 구획은 내용이 없으면 제목째 생략하고, 가림 안내(`요청 본문은 가려져 있습니다`)는 `요청 본문` 제목 아래 별도 줄.
- **응답 코드에 실패색 없음**: 자세히 스텝 표의 응답 칸은 응답이 없을 때(`—`)만 실패색. 4xx/5xx 코드 자체는 칠하지 않는다 — 칸 조건이 `status = 404`면 404가 정상이라 코드를 빨강으로 칠하면 벽의 색 규칙(빨강 = 실패 판정)과 어긋난다(GUI `StepRow`와 같음).
- **줄 위치 표시**: 요청·응답 화면의 `{끝}/{전체}줄`은 본문 영역 첫 줄(머리 줄 바로 아래) 오른쪽 끝. 전체가 한 화면에 들어가거나 폭이 모자라면 통째 생략.
- **좁은·낮은 화면에서 통째로 빼는 순서**: 공통 — 키 줄은 앞 조각부터, 무입력 안내 줄은 높이 10줄 미만이거나 폭이 (문구 폭 + 1)보다 좁으면. 목록 — 머리 오른쪽 개수 → 상태 열 → 시각 열(사유 칸이 4칸 미만이 되면). 자세히 — 스텝 줄이 최소 1줄 남게 `시나리오` 줄 → `판정 상세` 줄 → 표 머리, 폭이 모자라면 `METHOD URL` 칸 → 스텝 이름 말줄임(반복 회차 ` #n`은 지킨다), `◀ 이 칸`은 통째. 칸 설정 — `보기 전용 — …`는 폭이 모자라면, 각주는 body 높이 3줄 미만이면. 헤더·본문 들여쓰기(2칸)는 남는 폭이 2칸 이상일 때만.
- **엔진이 자른 본문**(`body_truncated`, 1 MiB): GUI는 64KB 초과면 `recordTreeTooLarge` 안내도 띄우지만 TUI는 잘린 본문을 들여쓰기 시도 없이 원문으로 두므로 `1 MiB에서 잘림 — 실제 응답은 더 큼` 안내만 띄운다.
- **키 줄**: 모니터 키 줄 조각 순서가 `b 테두리 · Tab · 칸 이동 · e 오류 보기 · Enter 칸 설정 · ? · q`가 되어 좁을 때 빼는 순서가 `b` → `Tab` → `칸 이동`으로 바뀐다(1a·tui-readability는 `칸 이동` → `Tab` → `b`). 새 화면 넷의 키 줄엔 `q 종료`를 쓰지 않는다(`q`는 동작). `Ctrl`+글자 키(`Ctrl+C`·`Ctrl+Q` 밖)는 모니터·새 화면 넷에서 무동작(`Ctrl+B` ≠ `b`). 한글 2벌식 `ㄷ`·`ㅁ`·`ㅍ`도 `e`·`a`·`v`.
- **도움말**: `e` 줄 설명은 50칸 상자에 통째로 들어가게 `선택 칸 오류 보기(실패 목록)`로 줄였다.
- **무입력 5분**: 키·마우스 이벤트만 입력으로 센다(폴링 갱신·조회 도착·크기 바뀜·마우스 단순 이동은 세지 않음 — 마우스 캡처가 움직임 보고까지 켜서 스치기만 해도 복귀가 미뤄지지 않게, Task 8 리뷰).

### 5.4 칸 설정 보기 (1b)

Enter → 번호 목록(제목·시나리오·환경·스텝·주기·요청 제한·응답 시간 기준·기준선·막대 수·그래프 최대·조건·벽 표시 값), "수정은 다음 버전" 안내. 이 번호 목록을 슬라이스 2가 편집 메뉴로 쓴다.

**1b 확정 (사용자 2026-11-10, 목업 [01-screens.html](2026-11-10-tui-1b-mockups/01-screens.html))**
- 화면 전체 전환·모니터와 같은 머리 줄·무입력 5분 자동 복귀(+ 화면 안내 문구)는 §5.3 확정 블록과 같다.
- `볼 스텝`의 URL 등 `{{변수}}`·`${ENV}`는 **시나리오에 적힌 그대로** 보여 준다(값을 채우지 않는다 — 실제 값은 오류 보기의 요청·응답에서).
- 묶음 칸의 시나리오·환경·주기에는 `(묶음)`을 붙이고 맨 아래에 각주(`(묶음) = 점검 묶음 N의 값 — 칸마다 따로 못 바꿉니다`) — N은 GUI와 같은 번호(칸 목록에서 그 묶음이 처음 나오는 순서)). 항목 이름은 GUI 칸 편집기 문구(`ko.ts`) 그대로.

## 6. 슬라이스 2 — 설정 수정·변수 값 수정·미리 실행·파일 저장 (US4·US7·US8)

**나눔 (사용자 2026-11-11)**: **2a** = 이 절 전부. **2b** = 미리 실행 결과의 응답에서 값을 골라 성공 조건·화면 표시 값을 **추가**(GUI ①b의 응답 트리 클릭 대응) — 2a에선 이미 있는 조건·표시 값의 수정·삭제만. 화면 배치의 기준 = 목업 [2026-11-11-tui-2a-mockups/01-screens.html](2026-11-11-tui-2a-mockups/01-screens.html)(사용자 승인 2026-11-11, "정할 것" Q1–Q4 추천안 채택).

### 6.1 편집 메뉴 (목업 §1)

1b 칸 설정 화면(§5.4)을 그대로 편집 메뉴로 쓴다 — 번호 1–12 불변. 그 아래 구분 줄(`── 이 칸이 쓰는 값 · 같은 값을 쓰는 다른 칸도 함께 바뀝니다 ──`)과 **13 환경 변수 · 14 시나리오 변수**를 더한다. 머리 오른쪽 안내는 `고친 값은 바로 점검에 반영·파일에 저장`(1b의 `보기 전용 — 수정은 다음 버전` 대체). 고른 줄은 흰 바탕 `▶`(모니터 칸 선택과 같은 모양). 키: `↑↓` 고르기 · 번호(`1`–`9` 즉시, `1` 뒤 1초 안에 `0`–`4`면 10–14) · `Enter` 수정 · `p` 미리 실행 · `Esc` 모니터로. 마우스(Q4): 줄 클릭 = 고르기, 고른 줄 다시 클릭 = `Enter`. 입력줄·목록 창 안은 키보드만.

| # | 항목 | 편집 | 고칠 수 없을 때(안내 줄) |
|---|---|---|---|
| 1 | 제목 | 글자 입력줄 | — |
| 2 | 시나리오 | **항상 읽기 전용** | `시나리오는 GUI에서 바꿉니다` |
| 3 | 환경 | 목록(파일의 환경 + `환경 없음`) | 묶음 칸 → `묶음의 값입니다 — 묶음 설정은 GUI에서` |
| 4 | 볼 스텝 | 목록(시나리오의 HTTP 스텝, `names::flatten_http_steps` 순) — **묶음 칸만**(GUI `PanelEditor`와 같음) | 단독 칸 → `볼 스텝은 GUI에서 바꿉니다` |
| 5 | 점검 주기(초) | 숫자 입력줄 1~3600 | 묶음 칸 → 3번과 같은 안내 |
| 6 | 제한 시간(초) | 숫자 1~30 | — |
| 7 | 표시할 응답 시간 | 목록(`흐름 전체` + HTTP 스텝) — **`step_id` 없는 칸만**(GUI `!group`) | 스텝 칸 → `스텝 칸은 그 스텝의 응답 시간을 씁니다` |
| 8 | 응답속도 기준선 | 하위 목록: ms 수정·`a` 추가·`d` 삭제 | — |
| 9 | 막대 개수 | 숫자 10~300 | — |
| 10 | 그래프 최대 높이(ms) | 숫자 100~600000 | — |
| 11 | 성공 조건 | 하위 목록: 규칙·값·대소문자 무시·앞뒤 공백 제거 수정, `d` 삭제 | — |
| 12 | 화면에 표시 | 하위 목록: `d` 삭제, `s` ①②자리 바꾸기 | — |
| 13 | 환경 변수 | §6.3 | 환경 없음 → `이 칸은 환경을 쓰지 않습니다` |
| 14 | 시나리오 변수 | §6.4 | `variables:` 없음 → `이 시나리오에는 변수가 없습니다` |

- 범위 힌트(입력줄 오른쪽)는 서버 `validate_panel`의 범위와 같은 값. **검증의 권위는 서버** — 거절되면 서버 문구를 입력줄 아래에 그대로(입력줄은 열린 채, 목업 §2).
- 숫자 입력줄은 ASCII 숫자만 받는다(최대 6자리). 글자 입력줄은 IME 입력 그대로, 제어 문자는 받지 않는다. `Ctrl+U` 지우기, `←→`·`Home`·`End`·`Backspace`·`Delete`.
- **볼 스텝 변경**은 GUI `setPanelStep`과 같다 — `step_id`·`latency_source`(그 스텝)·조건·표시 값의 `step_id`를 새 스텝으로(서버 `normalize_step_panel`도 같은 일을 한다). 조건·표시 값이 하나라도 있으면 저장 전 한 줄 확인 `조건 N개·표시 값 M개도 이 스텝으로 바뀝니다 — Enter 계속 · Esc 취소`.
- **기준선**: 추가 = ms 입력줄(미리 채움 = GUI `addThreshold`의 `마지막 + 1000`, 없으면 1000), 색은 GUI `THRESHOLD_COLORS[개수 % 5]`(`#f59e0b #ef4444 #a855f7 #3b82f6 #14b8a6`) 자동. 색 바꾸기는 GUI에서. 삭제·조건 삭제·표시 값 삭제는 확인 `N번 …을 지울까요? y 지우기 · 다른 키 취소`.
- **성공 조건 수정**(목업 §4 오른쪽): 대상(`source`+`path`)과 스텝은 읽기 전용. 규칙 목록은 `ConditionSource::allows`가 허용하는 것만(GUI `OPS_BY_SOURCE`와 같은 집합), 값 칸은 `needs_value()`일 때만, 두 체크는 GUI `hasFlags`(= `Eq | Ne | Contains | OneOf`)일 때만. `Tab` 다음 칸, `Space` 체크 켜기·끄기, `Enter` 저장.

### 6.2 저장 (US4 — 항목마다 즉시)

확정할 때마다 **저장 한 번**. 저장 중엔 `저장 중…`을 입력줄 자리에 두고 다른 편집 키를 받지 않는다(Esc는 저장을 취소하지 않는다 — 서버 반영은 원자적이라 반쯤 남지 않는다).

1. **서버 반영** — 칸 항목 1–12: `PUT /api/monitor-boards/{id}` `{name, config}`(캐시된 보드 설정에서 그 칸만 바꾼 전체 설정) / 13: `PUT /api/environments/{id}` `{name, vars}` / 14: `PUT /api/scenarios/{id}` `{yaml, version}`(§6.4). 실패 = 서버 문구 표시, 아무것도 안 바뀜, 파일 안 건드림.
2. **캐시 갱신** — 칸 항목은 PUT 응답 보드로, 13·14는 영향받는 값만(보드 설정은 그대로). 보드 수정은 `reconcile`이 살아남은 칸의 결과 버퍼를 유지한다(막대가 비지 않는다 — GUI 저장과 같음).
3. **내보내기** — `POST /api/monitor-boards/export` `{board_ids: [파일의 보드 전부, 가져온 순서]}` → 바이트.
4. **파일 쓰기** — ① `<file>.orig.bak`이 없으면 **지금 파일**을 그 이름으로 복사(이후 안 덮음 — GUI에서 받은 원본 보존, Q2) ② 지금 파일을 `<file>.bak`로 복사(매번 덮음 — 직전 상태) ③ 같은 디렉터리 임시 파일(`.<이름>.tmp-<pid>`, 원본과 같은 권한)에 쓰고 `fsync` → `rename`으로 교체. 대상 경로는 시작 때 연 경로(링크면 링크가 가리키는 실제 파일 — `canonicalize`).
5. 성공 → 머리 줄 `저장됨 HH:MM:SS`(5초). 3·4 실패 → 머리 줄 `파일에 저장 못 함 — 재시작하면 사라짐`을 **다음 파일 쓰기 성공까지 모든 화면에** 유지(점검은 이미 새 값으로 돈다). 로그엔 단계·`io::ErrorKind`만.

저장은 1b 기록 조회 작업자와 **다른** 작업자 태스크 하나가 차례로 처리한다(사유 조회 큐 뒤에서 기다리지 않게 — roadmap §B48 (2) "조회 큐 순서" 교훈). 세션을 내릴 때 abort·await(`crates/tui/CLAUDE.md` mpsc 함정).

### 6.3 환경 변수 (13, US7 — 목업 §5 왼쪽)

- 열 때 `GET /api/environments/{id}` → 키 목록(`BTreeMap` 순). **값은 전부 기본 가림** `••••••••`(Q1), `v`로 이 화면에서만 보기/가리기(화면을 나가면 다시 가림). 값만 고친다 — 키 추가·삭제·이름 바꾸기는 GUI.
- `Enter` → 입력줄에 **그 값만** 평문(고치려면 보여야 한다). 공유 확인(사용자 2026-11-11): 이 환경을 쓰는 칸이 2개 이상이면 입력줄 위에 노란 글자 `이 값을 쓰는 칸 N개(보드 M개)가 함께 바뀝니다`(1개면 문구 없음). 칸 수 = 세션의 모든 보드 설정에서 `environment_id`가 같은 칸.
- 저장 = 받은 `{name, vars}`에서 그 키 값만 바꿔 PUT. 다음 점검부터 새 값(점검은 매번 DB에서 환경을 읽는다 — `monitor/check.rs`).
- 메모리: 값은 이 화면이 열린 동안만 든다(닫으면 버린다). 로그·`tracing`엔 키 이름도 값도 남기지 않는다.

### 6.4 시나리오 변수 (14, US8 — 목업 §5 오른쪽)

- §2 비목표 "시나리오 편집"의 **유일한 예외**(사용자 2026-11-11): `variables:` 고정 값 한 줄. 스텝·URL·헤더·본문은 여전히 GUI.
- 열 때 `GET /api/scenarios/{id}` → `yaml`·`version`. `Scenario::from_yaml`의 `variables`에서 `VarDecl::Static`만 고칠 수 있고, `Gen`은 흐린 글자 `생성 변수 — GUI에서`. 값은 평문 표시(`sanitize`). 공유 확인은 §6.3과 같은 규칙(`scenario_id` 기준).
- **한 줄 교체 (사용자 2026-11-11 — 주석·순서·나머지 글자 보존)**: 순수 함수 `splice_static_var(yaml, key, new) -> Result<String, NotEditable>`.
  1. 맨 앞 칸(열 0)의 `variables:` 줄을 찾는다(뒤에 공백·주석만 허용, 정확히 1개). 그 아래 블록 = 다음 "열 0에서 시작하는, 공백도 `#`도 아닌 줄" 전까지.
  2. 블록 첫 항목의 들여쓰기와 같은 들여쓰기로 시작하는 `key:` 줄(키는 그대로·`"key"`·`'key'`)을 **정확히 1개** 찾는다.
  3. 값 = 한 줄 스칼라(일반·`'…'`·`"…"`). `|`·`>`·`&`·`*`·`!`·`{`·`[`로 시작하거나 비었으면 `NotEditable`. 값 구간만 `serde_json::to_string(new)`(= YAML 큰따옴표 문자열)로 바꾸고 뒤 주석은 둔다.
  4. **검증**: 옛·새 YAML을 `serde_yaml::Value`로 읽어 `새 == 옛(variables[key] = 새 문자열)`이고 `Scenario::from_yaml(새)` 성공일 때만 `Ok`. 아니면 `NotEditable` — 잘못 자른 경우도 여기서 막힌다(저장하지 않음).
- 화면을 열 때 각 고정 변수에 같은 값으로 한 번 돌려 보아 `NotEditable`이면 그 줄을 `이 값은 TUI에서 못 고칩니다 — GUI에서`로 표시(여러 줄 값·앵커·흐름 표기 `variables: {…}` 등).
- 저장 = `PUT /api/scenarios/{id}` `{yaml: 교체본, version}`. 409(버전 어긋남)면 `다른 곳에서 시나리오가 바뀌었습니다 — 다시 열어 주세요`. 입력값에 줄바꿈은 들어올 수 없다(입력줄).
- 시나리오 이름·스텝은 안 바뀌므로 `Names`(번들 파일에서 푼 이름)는 다시 읽지 않는다.

### 6.5 미리 실행 (US4 — 목업 §6)

- 칸 설정 메뉴에서 `p` → `POST /api/monitor-boards/preview-check`(본문 = 캐시된 칸 설정, 즉 저장된 지금 값). 실행 중 `실행 중…`(`ko.monitor.previewRunning`), 한 번에 하나, `Esc`만 받는다(Esc = 결과를 버리고 메뉴로).
- 응답 `{trace, result}`(거울 `wire::PreviewResponse`)는 받자마자 컨트롤러 `monitor::record::build_record_body(trace, 보드 record_limit_kb)`로 **가리고 자른 뒤** 든다 — 미리 실행 응답은 서버가 가리지 않으므로(기록 API만 가림) 1b 요청·응답 화면의 "인증 값 가림"을 같게 유지.
- 화면 = 1b 자세히(§5.3-2)와 같은 구성(결과·응답 시간·사유·판정 상세·스텝 표). **스텝 칸이면 그 칸 스텝 줄만**, 흐름 전체 칸이면 전체. 생략한 스텝이 있으면 `이 칸의 스텝만 보여 줍니다(묶음의 다른 스텝 생략 N개)`. `Enter` → 1b 요청·응답 화면(요청 본문 기본 가림), `p` 다시 실행, `Esc` 칸 설정으로. 미리 실행은 점검 기록·막대에 들어가지 않는다(서버 그대로).

### 6.6 그 밖 (목업 §7)

- 도움말에 `Enter 칸 설정 보기·수정`, `새 파일로 바꾸면 이 PC에서 고친 값은 사라집니다`(노랑), `보드 파일: <경로> (백업 <이름>.bak)`.
- 자리 비움 5분(1b 규칙)은 편집 화면·입력줄·목록에도 적용 — 입력 중이던 값은 **버린다**(Q3). 이미 저장한 값은 그대로.
- **1b 연기 접음**(roadmap §B48 (2)): 꺼진 보드(`/status` `enabled: false`)의 오류 목록 빈 문구 = `점검이 꺼져 있어 결과가 없습니다`.
- 문구는 `text.rs` 한 곳, GUI와 같은 뜻이면 `ko.ts` 값 그대로(`mirrored_text_exists_in_ko_ts`).

## 7. 빌드·배포 (1a)

- **첫 task = 빌드 스파이크**: zig·`cargo-zigbuild` 버전 고정 → `cargo zigbuild --release -p handicap-tui --target x86_64-unknown-linux-gnu.2.27`. 근거: TLS `rustls`+`ring`(OpenSSL·aws-lc 없음), SQLite `libsqlite3-sys` `bundled`. **폴백** = `ubuntu:18.04`(glibc 2.27) 컨테이너 안에서 rustup + 일반 `cargo build` — protoc는 apt 판(3.0.x)이 `coordinator.proto`의 proto3 `optional`을 못 읽으므로 **protoc 릴리즈 바이너리를 내려받는다**. 둘 다 막히면 **STOP → 사용자에게 보고**. 이후 task(화면 등)는 빌드 방식과 독립이라 스파이크 결과에 묶이지 않는다.
- `release.yml`에 `linux-tui` 잡: protoc·zig·cargo-zigbuild 설치 → 빌드 → **게이트**: ① `objdump -T`의 `GLIBC_x.y` 최댓값 ≤ 2.27 ② `readelf -d` NEEDED ⊆ {libc, libm, libpthread, libdl, librt, libutil, libgcc_s, ld-linux}(모두 19.04 기본 glibc·gcc 런타임 구성요소) ③ 호스트에서 테스트 응답기(python `http.server`)를 띄우고 `docker run --network host --platform linux/amd64 ubuntu:19.04 … handicap-tui --check <fixture>` exit 0(fixture 칸은 그 응답기를 가리킨다 — HTTP 경로까지 19.04에서 실증). 산출물 `handicap-tui_<ver>_linux-x86_64.tar.gz`(바이너리 + 매뉴얼).
- `publish` 잡: `needs`에 `linux-tui` 추가, **차단하지 않음**(macOS와 같은 선택 에셋 — zig 툴체인 문제로 Windows 릴리즈가 멈추지 않게). `scripts/publish-release.sh`의 `find` 필터에 `*.tar.gz`, 누락 점검 목록에 `linux-x86_64.tar.gz` 추가.
- **매뉴얼** `docs/dev/tui-monitor.md`: 설치(복사·실행 권한), 자동 시작 `.desktop`(§3, `--full-screen` 기본·`--maximize` 대안·지연·`read x` 감싸기 이유), 키 표, 파일 교체(US5), 로그 위치, `--check`, 보드 수와 PC 부담.

## 8. 테스트·검증

- **단위**: §4.4 함수(TS 1:1 대조표), 인자 해석, BOM 제거, 임시 DB 잔재 정리.
- **화면**: ratatui `TestBackend`로 모니터 화면·오류 화면·작은 터미널·도움말·종료 확인 렌더 버퍼 단언. 클릭 좌표 → 칸 선택(경계·테두리·칸 밖) 단위 테스트. 시각 줄: 눈금 배치 순수 함수(겹침 없음·간격 2·양 끝 정렬·자기 막대 포함·중복 글자 생략·폭 부족 시 왼쪽만·빈 슬롯/결과 0, 촘촘한(1초)·성긴(60초)·고르지 않은 간격) + 10분 경계 형식 전환(명목 구간) + `format_hm` 모양 + 줄 우선순위(안쪽 4줄에서 상태·막대·시각 유지, 실패 칸 사유 작은 줄) — 시각 문자열 함수를 인자로 받아 TZ와 무관하게 테스트.
- **통합**: in-process 컨트롤러 + 로컬 HTTP 응답기(성공/503/지연) + 번들 fixture → 가져오기·시작·상태 표시, 거울 타입 역직렬화, 잘못된 파일 → 오류 화면(종료 안 함), `r` 재시도가 새 DB로 성공(로그 재초기화 없이 — 원래 실패 로그가 같은 파일에 남음), BOM 파일 성공, stderr 출력 0, `--check` exit 0/1/2.
- **라이브(머지 전 필수)**: ① macOS 실제 터미널(키·리사이즈·한글 폭·종료 확인) ② `ubuntu:19.04` amd64 컨테이너에서 zigbuild 산출물 `--check` + tmux로 TUI 화면 캡처 ③ US1·2·5·6 통과 신호 표(US6: macOS에서 응답기를 30초쯤 멈췄다 다시 띄우고 `date +%T`로 그 시각을 적은 뒤, 화면 캡처에서 실패 막대(`█`, 성공 막대는 낮은 지연이라 `▁`) 근처 눈금 시각이 적은 구간과 맞는지 + 9칸 배치(80×24)에서도 눈금이 겹치거나 잘리지 않는지).
- **실기(사용자, 머지 후)**: 19.04 PC 자동 시작·`--full-screen`·ko_KR 로케일에서 모호 폭 문자(`▂…█`, `┌─│`, `▲ ○ – ― …`) 정렬. 결과를 build-log에.

## 9. 보안 표면

- **보안 경계를 정직하게**: 컨트롤러 REST는 루프백 바인드지만 **인증이 없다** — 같은 PC의 다른 사용자·프로세스는 `GET /api/environments`로 환경 값 평문까지 읽을 수 있다. 데스크톱 앱(ADR-0042)과 같은 자세이며 **전용 단일 사용자 모니터 PC**를 전제한다(매뉴얼에 명시). 임시 DB 0600은 이 전제 아래의 위생일 뿐 경계가 아니다.
- 요청·응답 본문 표시는 서버가 가린 기록 그대로(1b). 대체 화면이라 스크롤백에 남지 않는다.
- 로그 파일: 컨트롤러·엔진에 비테스트 `println!`/`eprintln!` 없음(리뷰 확인). 요청/응답 본문·환경 값이 tracing 필드로 나가지 않는지 1a 계획에서 grep으로 확정.
- 2a 파일 되쓰기: `.bak`·`.orig.bak`·임시 파일은 원본과 같은 권한으로 만든다(환경 값 평문이 들어 있다 — 원본 파일과 같은 수준). 미리 실행 trace는 받자마자 `build_record_body`로 가린다(§6.5). 시나리오 변수 교체는 검증(§6.4-4) 통과분만 저장.
- 1b·2의 기록 뷰어·파일 되쓰기는 `finish-slice` §0 보안 grep으로 `security-reviewer` 필요 여부 확정.
- 기록 메모리 최악치(9칸 × 300막대 × 기록 상한)는 GUI와 같다 — 저사양 PC에서는 `record_limit_kb`를 낮게 잡으라고 매뉴얼에 안내.

## 10. 열린 질문 / 알려진 한계

- **대상 PC 아키텍처**: x86_64 확정(사용자 2026-11-07: "굳이 확인 안 해도 됨 — 동일한 모델의 PC에 Windows도 설치해서 사용 중", `uname -m` 확인은 생략). 보강 근거: Ubuntu 18.04부터 32비트 데스크톱 설치본이 없다. 남는 위험 = 32비트 사용자 공간으로 업그레이드해 온 설치본 — 실기에서 `exec format error`면 이것(매뉴얼 문제 해결에 한 줄).
- 19.04 기본 Firefox 판정은 추정(이 설계의 동기 중 하나일 뿐, TUI 필요성은 브라우저와 무관하게 유효).
- 시각 줄은 날짜가 없다 — `interval_seconds`가 커서(최대 3600) 보이는 구간이 24시간을 넘으면 양 끝 눈금이 같은 글자로 보이거나 생략될 수 있다(모니터 PC 용도상 드묾, 수용 — 필요해지면 `MM-DD HH:MM` 형식 추가).
- 재시작마다 링버퍼·기록이 비고 보드를 새로 가져온다(GUI 재시작과 같은 수준).
- `run_in_process`가 `~/.local/share/handicap`을 만든다(쓰지 않지만 생성 실패 시 기동 실패).
- 누군가 루프백 API로 run을 만들면 자기 실행 파일 워커가 뜨고(가드 덕에 TUI는 아님), 그 워커는 stdout/stderr를 물려받아(`dispatcher/subprocess.rs`) 로그가 TUI 화면에 섞일 수 있다. TUI는 run을 만들지 않으므로 수용(전용 디스패처는 YAGNI).

## 10.1 계획에 넘기는 주의

- `in-process`가 workspace 전체에서 켜지면 `in_process.rs`와 그 테스트가 **처음으로** pre-commit·CI의 `clippy -D warnings`·nextest에 들어간다(지금까진 clippy 없는 Windows 릴리즈 잡만 빌드). 기능 분리 task에서 lint·테스트 낙진을 예상하고 처리한다.
- "UI 스레드 패닉일 때만 터미널 복구"는 UI 루프가 **메인 스레드에서 `block_on`**으로 돈다는 전제다(`tokio::spawn` 안이면 스레드 판정이 틀린다) — 계획에서 실행 구조를 고정한다.

## 11. 구현자 재량

글자 배치·테두리·막대 문자·도움말 문구, 오류 목록 페이지 크기, reqwest 클라이언트 구성, pid 생존 확인 수단, 모듈 분할, ratatui·crossterm 버전(툴체인 `rust-toolchain.toml` 고정 버전에서 빌드되는 최신 안정판 — workspace `rust-version`과의 관계는 계획에서 확인).

## 12. 사실 근거 (claims-ledger)

| 주장 | 명령 |
|---|---|
| Linux GUI 빌드가 ubuntu-24.04·webkit2gtk-4.1 | `grep -n "ubuntu-24.04\|webkit2gtk" .github/workflows/release.yml` |
| Vite 5, build.target 미지정 | `grep -n '"vite"' ui/package.json; sed -n '/build: {/,/},/p' ui/vite.config.ts` (outDir·sourcemap만) |
| rustls·ring, OpenSSL·aws-lc 없음 | `grep -n 'rustls\|openssl\|native-tls' Cargo.toml crates/*/Cargo.toml; grep -n '^name = "\(ring\|aws-lc-sys\|openssl-sys\)"' Cargo.lock` |
| sqlite 번들 | `cargo tree -e features -i libsqlite3-sys` |
| `in_process`가 `bundle` 게이트, 선택 의존은 dirs·worker뿐 | `grep -n 'cfg(feature' crates/controller/src/lib.rs; sed -n '/\[features\]/,/^$/p' crates/controller/Cargo.toml; grep -n "dirs::\|handicap_worker\|rust_embed\|open::\|crate::bundle" crates/controller/src/in_process.rs` |
| 게시 스크립트가 tar.gz 미수집 | `grep -nF 'find "$assets_dir"' scripts/publish-release.sh` |
| StepTrace에 이름·전송 종류 없음 | `sed -n '/pub struct StepTrace/,/^}/p' crates/engine/src/trace.rs` |
| import 본문 `{"bundle": …}`, BOM은 본문 맨 앞만 | `grep -n "fn parse_import_request" -A10 crates/controller/src/api/monitor_transfer.rs; grep -n "fn parse_json_bytes" -A3 crates/controller/src/monitor/board_file.rs` |
| status는 최신 결과에만 사유 | `grep -n "사유·detail은 최신 결과에만" crates/controller/src/api/monitor_boards.rs` |
| 끊김 3회·3000ms·now_ms·budget 폴백 | `grep -n "SERVER_DOWN_AFTER\|now_ms\|check_budget_seconds" ui/src/pages/MonitorDisplayPage.tsx; grep -n "STATUS_TIMEOUT_MS =" ui/src/api/monitors.ts` |
| 칸 표시 게이트 | `grep -n "const consecutive =\|const stats =" -A5 ui/src/components/monitor/MonitorPanel.tsx` |
| gridFor 표 | `grep -n "export function gridFor" -A8 ui/src/monitor/logic.ts` |
| 감독자 첫 점검 즉시 | `grep -n "sleep_until(started + interval)" crates/controller/src/monitor/supervisor.rs` |
| 전역 점검 동시 상한 32 | `grep -n "MAX_CONCURRENT_CHECKS" crates/controller/src/monitor/supervisor.rs` |
| `ImportResult`는 Deserialize | `grep -n "pub struct ImportResult" -B2 crates/controller/src/monitor/transfer.rs` |
| reasonParts 세 갈래 | `grep -n "kind:" ui/src/monitor/display.ts` |
| 한 파일 최대 50보드 | `grep -n "MAX_BOARDS: usize" crates/controller/src/monitor/board_file.rs` |
| GUI 축은 "N분 전 … 지금"+hover 시각 | `grep -n "axisAgoLabel\|formatHms\|axisNow" ui/src/components/monitor/LatencyBars.tsx` |
| 결과 시각 필드 `at_ms`(epoch ms) | `grep -n "pub at_ms: i64" crates/controller/src/monitor/check.rs` |
| 빈 슬롯은 왼쪽에만(`barSlots` 앞 채움) | `grep -n "export function barSlots" -A5 ui/src/monitor/logic.ts` |
| 사유 작은 줄은 큰 값 아래 별도 줄 | `grep -n "const smallLine =" ui/src/components/monitor/MonitorPanel.tsx` |
| `bar_count` 10–300 | `grep -n "in_range(p.bar_count, 10, 300)" crates/controller/src/monitor/config.rs` |
| GUI 축 글자색 `#7b8794` | `grep -n 'axis: "#7b8794"' ui/src/monitor/display.ts` |
| ubuntu:19.04 이미지·glibc 2.29 | `docker run --rm --platform linux/amd64 ubuntu:19.04 ldd --version` |
| (2a) 보드 PUT 본문 `{name, config}`, 응답 = 보드, 저장 뒤 `reconcile` | `grep -n "pub struct BoardBody" -A5 crates/controller/src/api/monitor_boards.rs; grep -n "pub async fn update" -A12 crates/controller/src/api/monitor_boards.rs` |
| (2a) reconcile이 살아남은 칸 결과 버퍼 유지 | `grep -n "살아남은 칸은 결과 버퍼를 유지" crates/controller/src/monitor/supervisor.rs` |
| (2a) 환경 PUT `{name, vars: BTreeMap}` / 시나리오 PUT `{yaml, version}`·버전 어긋남 409 | `grep -n "pub struct EnvironmentBody" -A4 crates/controller/src/api/environments.rs; grep -n "pub struct UpdateRequest" -A4 crates/controller/src/api/scenarios.rs; grep -n "VersionMismatch" crates/controller/src/api/scenarios.rs` |
| (2a) 점검은 매번 DB에서 시나리오를 읽는다 | `grep -n "store::scenarios::get" crates/controller/src/monitor/check.rs` |
| (2a) 고정 변수는 YAML 문자열만(`visit_str`) | `grep -n "impl<'de> Deserialize<'de> for VarDecl" -A12 crates/engine/src/genvars.rs` |
| (2a) export 본문 `{board_ids}` | `grep -n "pub struct ExportRequest" -A3 crates/controller/src/api/monitor_transfer.rs` |
| (2a) preview 응답 `{trace, result}`, 가림 없음 / `build_record_body` pub·가림+자르기 | `grep -n "pub struct PreviewResponse" -A3 crates/controller/src/api/monitor_boards.rs; grep -n "pub fn build_record_body" -B6 crates/controller/src/monitor/record.rs` |
| (2a) GUI 볼 스텝 고르기는 묶음 칸만, 응답 시간 기준은 `!group`만, 기준선 색 팔레트 | `grep -n "group ? (\|{!group && (\|THRESHOLD_COLORS =" ui/src/components/monitor/PanelEditor.tsx` |
| (2a) 조건 규칙 허용 표·체크 표시 규칙 | `grep -n "pub fn allows" -A10 crates/controller/src/monitor/config.rs; grep -n "hasFlags" ui/src/components/monitor/ConditionRow.tsx` |
| (2a) 꺼진 보드 `/status` `enabled` 필드 | `grep -n "pub enabled" crates/tui/src/wire.rs` |
