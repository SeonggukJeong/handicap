# 운영실 모니터 화면 본체 ①a (ops-monitor-board) — 설계

- 날짜: 2026-10-21 · 유형: `user-path` · 슬라이스 **①a** — 전체 순서 ①a 점검·전시 화면 → ①b 클릭으로 성공 조건 + 화면 방식 A·C → ② 내보내기/가져오기 → ③ 자동 시작+부팅 전체화면 (①b·②·③은 각자 별도 spec)
- **결정 원천**: [`2026-10-21-ops-monitor-mockups/00-decisions.md`](2026-10-21-ops-monitor-mockups/00-decisions.md) + 같은 폴더 목업(`02-latency-bars-final.html`/`.png`가 레이아웃 정본). 이 spec이 결정 원천과 어긋나면 **결정 원천이 이긴다**. `[사용자]` 표시 결정은 사용자 확인 없이 바꾸지 않는다.
- 새 ADR: **ADR-0053 운영 모니터 모드** (§11).
- 개정: r2 — spec-plan-reviewer 1차(APPROVE-WITH-FIXES 20건) 반영 + 사용자 결정 2건(설정 단위 = 보드 전체, ①을 ①a/①b로 분할).

## 사용자 스토리 (US)

- **US1**: 운영자가 운영실 벽 모니터를 방 반대편에서 볼 때 다가가지 않고 어느 시스템이 정상/느림/실패인지 판별한다 — 성공하면 칸마다 제목·상태 글자+아이콘·현재 응답 ms가 큰 글씨로 보이고, 실패 칸은 색과(켜 두었으면) 깜빡임으로 구분되며, ESC나 마우스 아무 버튼으로 전체화면을 빠져나와도 점검은 계속된다.
- **US2**: 운영자가 응답이 점점 느려질 때 기준선을 넘기 전에 추세를 알아챈다 — 성공하면 칸 폭을 꽉 채운 막대가 왼쪽부터 쌓이다 꽉 차면 왼쪽부터 밀려나며 높이가 올라가는 모양이 보이고, 막대는 넘은 기준선 색으로, 기준값 숫자는 그래프 밖 칸에 표시된다.
- **US4**: QA가 시스템(칸)마다 점검 주기·기준선(개수/색/값)을, 보드 전체에 글자 크기·깜빡임을 정한다 — 성공하면 칸마다 정한 주기대로 점검되고(예: 1.0은 10초, 2.0은 30초), 바꾼 설정은 저장 후 켜져 있는 전시 화면에 수 초 안에 반영되며 앱을 다시 켜도 유지된다.
- **US5**: 운영자가 점검 자체가 멈췄을 때 오래된 초록불에 속지 않는다 — 성공하면 주기 대비 너무 오래 결과가 없는 칸이 회색 "확인 불가"로 바뀌고, 헤더의 마지막 점검 시각이 멈춘 시점을 보여준다.
- (US3 — 미리 실행 결과의 응답 값을 클릭해 성공 조건 만들기 — 와 화면 방식 A/C 선택은 **①b**로 이동. ①a의 성공 판정은 시나리오 자체 판정: 상태코드 assert·값 추출 실패. 즉 "토큰이 응답에 없으면 실패"는 ①a에서도 시나리오에 토큰 extract를 두면 동작한다 — F3.)

## 1. 배경과 목표

통신사 회선 PC(Ubuntu)에서 셸 스크립트가 10초마다 로그인 API를 호출해 텍스트로 결과를 찍는다. 글씨가 작아 운영자가 "줄 길이 변화"로만 이상을 눈치채고 화면 앞까지 걸어간다. ①a는 그 스크립트를 **Handicap 안의 운영 모니터 전시 화면**으로 대체한다 — PC에서 직접 설정하고 수동으로 띄우면 셸 스크립트를 대체할 수 있는 상태가 완료 기준.

**범용 API 모니터다**(`[사용자]`): 로그인 전용 판정·문구·비밀번호 식별 로직을 넣지 않는다.

### 비목표 (①a)
- ①b(성공 조건 작성·평가, 화면 방식 A/C), ②, ③.
- 소리·메일·메신저 알림, 결과 장기 보관·리포트, 여러 PC 결과 모으기, 칸 순서 바꾸기(칸 순서 = 추가 순서).
- "평소의 N배" 자동 기준선(`[사용자]`: 막대 방식만).
- 부하 run·리포트·스케줄러 파이프라인 변경. 모니터 점검은 run 레코드를 만들지 않는다.

### 안티골 (돌아가도 실패)
- 멀리서 글씨가 안 읽힘 / 그래프가 글자를 밀어내 작게 만듦(`[사용자]` v3 피드백).
- 기준값 숫자·선이 막대를 가림(`[사용자]`).
- 점검이 멈췄는데 초록불이 그대로 남음.
- 점검 주기가 사실상 고정(UI 미노출·하드코딩 — `[사용자]` 우려).
- 응답속도를 소수점 초로 표시(`[사용자]`).
- 제한 시간을 넘긴 응답이 "정상"으로 표시됨(r2 리뷰 #1).

## 2. 코드 사실 (각 줄 재현 명령 포함)

| # | 사실 | 확인 명령 |
|---|---|---|
| F1 | `POST /api/test-runs`는 in-process로 `trace_scenario` 1패스, 미저장 | `grep -n "pub async fn create" -A40 crates/controller/src/api/test_runs.rs` |
| F2 | `ScenarioTrace{ok,total_ms,steps,final_vars,truncated,error}`, `StepTrace{step_id,kind,loop_index,branch,request,response,extracted,unbound_vars,error}`, `TracedResponse{status,latency_ms,download_ms,headers(BTreeMap — 중복 헤더는 마지막 값),set_cookies,body,body_truncated}` | `grep -n "pub struct\|pub [a-z_]*:" crates/engine/src/trace.rs` · `grep -n "headers: resp_headers.into_iter().collect()" crates/engine/src/executor.rs` |
| F3 | trace `ok` = 모든 step `error.is_none()`; status assert 불일치는 `"status {got} != {want}"`, extract 실패·본문 읽기 실패(`"read body: …"`)도 **응답이 있는 채로** step error | `grep -n "let ok = state.steps" crates/engine/src/trace.rs` · `grep -n "status {} != {}\|read body:\|Err(e) => error = Some" crates/engine/src/executor.rs` |
| F4 | 시나리오 assertion은 `Status`뿐 | `grep -n -A3 "pub enum Assertion" crates/engine/src/scenario.rs` |
| F5 | `ExtractFailed` 문자열은 응답 본문/JSON 파싱 오류 조각을 담을 수 있다(그래서 `safe_cause` 허용목록 밖) | `grep -n "ExtractFailed (may embed" crates/engine/src/error.rs` |
| F6 | trace 제한 시간은 **스텝 사이에서만** 확인(`Instant::now() >= deadline`) — 진행 중 요청은 안 끊김; trace 클라이언트 요청 타임아웃 30초 | `grep -n "Instant::now() >= deadline" crates/engine/src/trace.rs` · `grep -n "Duration::from_secs(30)" crates/engine/src/executor.rs` |
| F7 | trace 본문 상한 1 MiB(`MAX_TRACE_BODY_BYTES`), 스텝마다 본문을 메모리에 보관 | `grep -n "MAX_TRACE_BODY_BYTES" crates/engine/src/executor.rs` |
| F8 | `max_test_run_requests` 기본 10,000 | `grep -n -A8 '"max_test_run_requests"' crates/controller/src/settings.rs` |
| F9 | 스케줄러: 독립 바이너리는 detached `tokio::spawn`, 데스크톱 in-process는 `CancellationToken`+`select!` | `grep -n "run_scheduler" crates/controller/src/main.rs crates/controller/src/in_process.rs` |
| F10 | `AppState {` 구조체 리터럴이 src+tests에 55곳 | `grep -rn "AppState {" crates/controller/src crates/controller/tests \| wc -l` |
| F11 | 환경 값 해석은 클라 오버레이(ADR-0025) — 서버에 environment_id 해석기 없음, `store::environments::get`은 있음 | `grep -rnE 'env_id\|environment_id\|environments::get' crates --include='*.rs'` |
| F12 | 마이그레이션 최신 = 0021(`ensure_runs_label`) → 다음 0022 | `grep -n "0021\|ensure_runs_label" crates/controller/src/store/mod.rs` |
| F13 | 일반 CRUD 검증 오류는 400(`ApiError::BadRequest`), 422는 test-run 계열 | `grep -n "BadRequest" crates/controller/src/api/environments.rs` |
| F14 | UI 라우트 `ui/src/routes.tsx`(`Layout` 자식), nav `Layout.tsx` 하드코딩 + `ko.nav.*`, `<main>` `max-w-6xl` | `grep -n "path:" ui/src/routes.tsx` · `grep -n "ko.nav\|max-w-6xl" ui/src/components/Layout.tsx` |
| F15 | 전역 QueryClient `retry: 1`, `refetchOnWindowFocus: false` | `grep -n "retry\|refetchOnWindowFocus" ui/src/App.tsx` |
| F16 | UI에 fullscreen 코드 없음, `@tauri-apps/api` 미의존, 데스크톱 창은 in-process 컨트롤러 `http://127.0.0.1:<port>/`를 navigate | `grep -rnE "fullscreen\|requestFullscreen" ui/src` · `grep -n tauri ui/package.json` · `grep -n "navigate(u)" desktop/src-tauri/src/lib.rs` |
| F17 | 사용자의 다른 Tauri v2 앱(`~/develop/timer`, 대상 Win11 WebView2)은 Tauri 권한 없이 DOM `requestFullscreen()`을 F 키로 토글 | `grep -n "requestFullscreen" ~/develop/timer/app/index.html` |
| F18 | 목업 v4는 `.scr`(화면 전체)만 `container-type` — 글자 `cqw`는 **화면 폭** 기준(칸 아님) | `grep -n "container-type" docs/superpowers/specs/2026-10-21-ops-monitor-mockups/02-latency-bars-final.html` |

## 3. 개념 모델

- **보드(board)**: 운영실 화면 하나. 이름(예 "SKT 회선"), **보드 전체 표시 설정**(글자 크기·깜빡임 — `[사용자]` 2026-10-21: 설정 단위 = 보드 전체), 칸 목록, 점검 켜짐 여부.
- **칸(panel)**: 시나리오 1개를 주기적으로 1회 실행하는 단위. 제목·시나리오·환경·주기·제한 시간·표시 응답 시간·기준선·막대 설정은 칸마다. 칸 = 시나리오 단위(스텝 단위 아님).
- **점검(check)**: 칸 시나리오 1패스 1회. 서버 판정은 `ok`/`fail`/`config_error` 3종. **"느림"은 서버가 아니라 화면이 현재 기준선으로 계산**(r2 #3 — 기준선을 바꿔도 지난 막대 색이 즉시 새 기준선을 따른다).

## 4. 저장 (migration 0022)

```sql
CREATE TABLE IF NOT EXISTS monitor_boards (
  id          TEXT PRIMARY KEY,           -- ULID (서버 생성)
  name        TEXT NOT NULL UNIQUE,       -- 중복 → 409 (environments 선례)
  config_json TEXT NOT NULL,              -- BoardConfig 통째 JSON
  enabled     INTEGER NOT NULL DEFAULT 0, -- 점검 켜짐 (컨트롤러 재시작 시 자동 재개)
  created_at  INTEGER NOT NULL,           -- epoch ms
  updated_at  INTEGER NOT NULL
);
```

JSON 한 컬럼(`[Claude]`): 칸·기준선은 항상 보드와 함께 읽고 쓰며 ②의 내보내기가 같은 구조를 쓴다.

### BoardConfig (와이어 = 저장 형태, serde `snake_case`, 모든 필드 serde default — ①b가 `display_style`·`conditions`를 **추가**해도 기존 행이 그대로 읽힘)

```jsonc
{
  "font_scale": "small" | "medium" | "large" | "xlarge", // 기본 "large" (= 목업 v4 크기)
  "blink": "off" | "fail" | "slow_and_fail",          // 기본 "fail"
  "panels": [ PanelConfig, ... ]                       // 1..=9개
}
// PanelConfig
{
  "id": "<ULID>",                    // 비어 있으면 서버 발급, 보드 안 유일, 이후 불변
  "title": "더비온 1.0",               // 1..=40자 (trim 후)
  "scenario_id": "<ULID>",
  "environment_id": "<ULID>" | null, // null = 환경 없이
  "interval_seconds": 10,            // 1..=3600 정수, 새 칸 기본값 10 — 고정 아님 [사용자]
  "timeout_seconds": 5,              // 1..=120 정수, 점검 1회 전체 제한 시간 [Claude]
  "latency_source": { "kind": "total" } | { "kind": "step", "step_id": "<ULID>" },
  "thresholds": [ { "ms": 700, "color": "#facc15" }, ... ], // 0..=5개, ms 1..=600000 엄격 오름차순
  "bar_count": 60,                   // 10..=300
  "graph_max_ms": 2000               // 100..=600000, 초과 값은 맨 위에 붙음
}
```

저장 시 검증 → **400**(F13, 한국어 메시지): 위 범위·개수, 칸 `id` 유효 ULID·보드 안 중복 금지, `scenario_id` 비어 있지 않음(r3 R4 — 존재 여부는 아래대로 미검사, 설정 폼도 시나리오 선택 필수), `color` `#rrggbb`, `thresholds` 엄격 오름차순. **시나리오·환경·step_id 존재 여부는 저장 시 검사하지 않는다**(삭제·편집 후에도 저장 가능 — 실행 시 `config_error`, §6.2).

## 5. API (`/api/monitor-boards`)

| 메서드 | 경로 | 동작 |
|---|---|---|
| POST | `/monitor-boards` | 생성 `{name, config}` → 201 Board |
| GET | `/monitor-boards` | `{"boards":[Board…]}` |
| GET | `/monitor-boards/{id}` | 단건 |
| PUT | `/monitor-boards/{id}` | 수정 `{name, config}` — 켜져 있으면 점검 재구성(§6.3) |
| DELETE | `/monitor-boards/{id}` | 점검 정지 후 삭제 → 204 |
| POST | `/monitor-boards/{id}/start` · `/stop` | `enabled` 영속 + 점검 시작/정지 → 200 Board |
| GET | `/monitor-boards/{id}/status` | 전시 화면용 상태(§6.5) |
| POST | `/monitor-boards/preview-check` | 본문 `PanelConfig` 1개로 점검 1회 즉시 실행, 미저장 → `{trace: ScenarioTrace \| null, result: CheckResult}` |

`Board = {id, name, config, enabled, created_at, updated_at}`. `preview-check`는 루프와 **같은 점검 함수**(§6.1)를 부른다(`[Claude]` — 서버에서 `environment_id`로 env를 읽으므로 클라 병합 경로인 test-run(F11)과 달리 미리 실행=실제 점검).

## 6. 점검 동작 (controller `monitor` 모듈)

### 6.1 점검 1회 `run_check(db, panel) -> (Option<ScenarioTrace>, CheckResult)`
1. 매 점검마다 DB에서 시나리오 YAML과 환경 vars(`store::environments::get`)를 읽는다(에디터 수정이 다음 점검부터 반영). 없음/파싱 실패 → `config_error`.
2. **제한 시간은 바깥에서 강제**(r2 #1, F6): `tokio::time::timeout(timeout_seconds, trace_scenario(&scenario, &opts))`. 초과 시 future drop(진행 중 요청 취소) → `fail`, 사유 "시간 초과(N초)", `latency_ms: null`, trace `null`. `opts = TraceOptions{ env, max_requests: MONITOR_MAX_REQUESTS(=50, 상수), max_wall: timeout_seconds(보조), apply_think_time: false }`.
   - 50 상수(`[Claude]`, r2 #12): 반복·자동 재개되는 점검이 앱 안 부하 발생기가 되지 않게 — 설정 `max_test_run_requests`(기본 10,000, F8)와 분리. trace(스텝별 본문 최대 1 MiB, F7)는 판정 직후 버리고 `CheckResult`만 남긴다.
   - 매 점검 새 클라이언트(쿠키 jar·연결 신규) = 매번 처음부터 새로 로그인(현재 셸 스크립트와 같은 의미).
3. 판정(§6.2).

```jsonc
// CheckResult (와이어·메모리)
{
  "at_ms": 1792583530000,                       // 점검 시작 시각 epoch ms
  "verdict": "ok" | "fail" | "config_error",
  "latency_ms": 1350 | null,                    // latency_source 기준 정수 ms, 측정 불가 null
  "reason": "HTTP 503" | null                   // fail/config_error 한 줄 사유 (§6.2 고정 문구만)
}
```

### 6.2 판정 (위에서부터 첫 해당)
1. 시나리오/환경 없음, 시나리오 파싱 실패, `latency_source.step_id`가 시나리오 http 스텝이 아님 → `config_error`. 사유 고정 문구: "시나리오를 찾을 수 없음" / "환경을 찾을 수 없음" / "시나리오 오류" / "응답 시간 기준 스텝 없음".
2. 바깥 timeout → `fail` "시간 초과(N초)". trace `truncated`이면 → `fail`: 요청 수가 상한에 닿았으면 "요청 수 상한(50) 초과", 아니면 "시간 초과(N초)"(r2 #20). trace `error`(setup 실패) → `fail` "시나리오 실행 오류".
3. 실행된 스텝 중 첫 `error` 스텝에 치환되지 않은 변수(`unbound_vars` 비어 있지 않음 — 예: "환경 없음" 칸에서 `${BASE_URL}`)가 있으면 → `config_error` "변수 미설정"(설정 문제는 깜빡이지 않게 — §7.5; 최종 리뷰 반영 2026-10-22). 그 외 첫 `error` 스텝 → `fail`. **사유는 원문 error 문자열을 쓰지 않고 구조로 분류**(r2 E2·#13, F3·F5 — 벽 화면에 응답 조각·URL이 나가지 않게):
   - 응답 있음 + 그 스텝의 `assert: status` 중 응답 status와 다른 값이 있음 → `HTTP {status}`.
   - 응답 있음 + error가 `invalid header`로 시작(헤더 이름/값이 잘못돼 그 헤더 없이 전송됨 — `executor.rs`의 `build_error`, status assert 생략) → "요청 구성 오류"(r3 R3).
   - 응답 있음 + error가 `read body:`로 시작 → "응답 본문 읽기 실패".
   - 응답 있음 + 그 외(값 추출 실패) → "값 추출 실패".
   - 응답 없음 → "요청 실패"(연결 거부·DNS·TLS 등). 세분 라벨은 비목표 — 원문은 설정 화면 미리 실행에서만 본다.
   - 사유 뒤에 스텝이 2개 이상인 시나리오면 ` · {스텝 이름}`(시나리오 작성자가 쓴 이름 — 실행 값 아님).
4. 통과 → `ok`.

`latency_ms`: `total` = trace `total_ms`; `step` = 그 스텝 **마지막 실행**의 `response.latency_ms`(루프/분기 반복 시 — `[Claude]`), 응답 없음 → null.

### 6.3 루프 (`MonitorSupervisor`)
- `AppState`에 `Arc<MonitorSupervisor>` 필드 추가 — **`AppState {` 리터럴 55곳(F10) churn**을 plan이 처리(헬퍼/기본 생성자 도입 여부는 plan 결정).
- 감독자는 루트 `CancellationToken`을 갖고 칸마다 `child_token()`으로 tokio task를 띄운다. 보드 단위 `tokio::sync::Mutex`로 PUT/start/stop/delete 직렬화(r2 #8).
- 기동 시 `enabled=1` 보드 자동 재개 — **`main.rs`와 `in_process.rs` 두 시작 경로 모두**에 배선(F9). in-process는 데스크톱 종료 토큰의 `child_token()`을 감독자 루트로 넘기고 `RunningController`에 감독자 정지 + abort 백스톱을 둔다. 두 경로 배선은 통합 테스트가 못 잡으므로 라이브 검증 항목(§9).
- 주기 = **시작-시작 간격** `interval_seconds`. 점검이 주기보다 길면 끝나자마자 다음 점검(겹침 없음). 첫 점검은 시작 즉시.
- 결과는 칸별 메모리 링버퍼(키 `(board_id, panel_id)`, 최대 300)에만 — 재시작 시 비어 있음(`[Claude]`, 결정 원천).
- PUT: 켜져 있으면 그 보드 task 정지 후 새 설정으로 재시작. 칸 `id`가 남아 있으면 버퍼 유지(색은 화면이 현재 기준선으로 다시 계산하므로 안전 — §3), 사라진 칸 버퍼 폐기.
- stop/delete: task 정지, 버퍼 폐기, `started_at_ms` 제거.
- `started_at_ms`는 그 보드 task가 (재)시작될 때마다 — start·자동 재개·**PUT 재구성 포함** — 현재 시각으로 갱신(r3 R2: PUT으로 추가된 칸이 오래된 시작 시각 때문에 "확인 중" 대신 "확인 불가"로 뜨지 않게).
- 루프 타이밍 로직은 **점검 함수·시계를 주입받는 제네릭**으로 작성해 SQLite 없이 tokio time pause로 테스트(r2 #9 — paused time + sqlx = `PoolTimedOut` 함정).

### 6.4 `GET /monitor-boards/{id}/status`
```jsonc
{
  "now_ms": 1792583531000,          // 서버 시각 — 멈춤 판정 기준
  "board_updated_at": 1792583000000, // 바뀌면 화면이 보드 설정을 다시 읽는다 (r2 #4, US4)
  "enabled": true,
  "started_at_ms": 1792583400000 | null, // 이번 점검 시작(재개 포함) 시각, 꺼짐이면 null (r2 #5)
  "panels": [{
    "panel_id": "...",
    "results": [CheckResult, ...],  // 오래된 것 → 최신, 최대 그 칸 bar_count개
    "consecutive_fail": 3,          // 최신부터 연속 fail/config_error 수
    "fail_since_ms": 1792583510000 | null,
    "running": true                 // 지금 점검 진행 중
  }]
}
```

## 7. 화면 (UI)

### 7.1 라우트·메뉴
- 상단 메뉴 **"모니터"**(`ko.nav.monitors`) → `/monitors` 목록(이름·칸 수·켜짐·"화면 열기").
- `/monitors/new`, `/monitors/:id` — 설정 화면(`Layout` 안).
- `/monitors/:id/display` — **전시 화면, `Layout` 밖**(F14 — 헤더·`max-w-6xl` 없이 창 전체).

### 7.2 설정 화면
- 보드: 이름, 글자 크기(작게/보통/크게/아주 크게), 깜빡임(끄기/실패만/느림+실패).
- 칸 목록(추가·삭제, 순서 = 추가 순서): 제목, 시나리오, 환경(없음 가능), 점검 주기(초 입력칸, 기본 10), 기준선(값 ms + 색 `<input type="color">` + 삭제, "+ 기준선 추가", 최대 5).
- 칸의 **고급**(접힌 disclosure, 값이 기본과 다르면 "N개 설정됨"): 제한 시간(초), 표시할 응답 시간(시나리오 전체 / 특정 스텝 — 스텝 목록은 선택한 시나리오 YAML을 불러와 기존 UI 파서로 http 스텝 이름 나열, r2 #14), 막대 개수, 그래프 최대 높이(ms).
- **미리 실행**(칸마다): `preview-check` → 스텝별 상태·ms·error 원문·응답 본문(텍스트) + 이번 판정. 본문 트리 클릭 조건 작성은 ①b.
- 버튼: **저장**, **모니터 시작**, 켜져 있으면 **점검 정지**. "모니터 시작" 클릭 핸들러 순서(r2 #10a): ① `requestFullscreen()`을 **동기 호출**(사용자 제스처 유효 시점) ② 변경이 있으면 저장 ③ start ④ 전시 화면으로 이동. 저장/시작 실패 시 전체화면 해제 + 오류 표시.

### 7.3 전시 화면 (목업 `02-latency-bars-final.*`이 정본)
- 어두운 고대비 배경. 헤더 한 줄: 왼쪽 **보드 이름**(범용 — "로그인" 문구 없음), 오른쪽 `마지막 점검 HH:MM:SS`(칸들 최신 `at_ms`) + 모든 칸 주기가 같으면 `· 10초 주기`(다르면 각 칸 시간축에 `N초 주기`) — r2 #7.
- 칸 배치: 1=전체, 2=좌우, 3=3열, 4=2×2, 5–6=3×2, 7–9=3×3(`[Claude]`).
- 칸(목업 B 방식 = 어두운 칸 + 상태 색 굵은 테두리): **1줄** 제목(왼) + 상태(오른: `✔ 정상` / `▲ 느림` / `✖ 실패` / `⚠ 설정 오류` / `– 확인 불가` / `… 확인 중`), **2줄** 큰 값(정상·느림 = `1,350 ms` 천 단위 쉼표 — 정상은 흰색, 느림은 넘은 기준선 색 `[사용자 2026-10-22: 정상은 흰색이 상태 변경 시 대비가 더 큼]` / 실패·설정 오류 = 사유), 연속 실패면 그 아래 `3회 연속 · 14:31:50부터`, **나머지** 막대 그래프.
- **글자 크기 기준**(r2 #2, F18): 목업 v4 글자는 화면 폭 기준이다. 구현은 칸 박스 기준 단위로 하되, **1920×1080·칸 2개·"크게"일 때 목업 v4의 글자 크기를 ±10% 안에서 재현**하도록 비율을 맞춘다(라이브 실측 — §9). 칸 수가 늘어 칸이 작아지면 글자도 칸에 비례해 작아진다(그리드상 불가피 — 수용). 작게/보통/아주 크게 = "크게" 대비 배수(초기값 0.7/0.85/1.2, 구현 중 실측 조정).
- **글자 우선 규칙**(r2 #18): 글자 크기는 글자 크기 설정과 칸 크기로만 정해지고 그래프 때문에 줄지 않는다. 그래프는 남는 공간을 쓰며, 남는 높이가 칸 높이의 15% 미만이면 그래프를 숨긴다(글자 유지).
- 막대 그래프(`[사용자]` 요구 전부):
  - 칸 좌우 폭을 꽉 채움. `bar_count` 슬롯 고정 폭, 결과가 적으면 **왼쪽부터** 채움, 꽉 차면 가장 오래된 것이 왼쪽으로 빠지고 최신이 오른쪽 끝.
  - 높이 = `latency_ms / graph_max_ms`(초과 100%). 색 = **화면이 현재 기준선으로 계산**: `latency_ms` ≥ 기준선 ms인 것 중 가장 높은 기준선 색, 없으면 초록 `#22c55e`. `fail` = 풀높이 빨강 빗금 + ✖, `config_error` = 풀높이 회색 빗금.
  - 기준선 = 기준선 색 점선, **그래프 영역 안에서만**. 기준값 숫자(쉼표, 단위 없음)는 **그래프 오른쪽 전용 열**에 그 높이로, 단위 `(ms)`는 열 아래 한 번. 열 폭은 가장 긴 숫자에 맞춤(막대 침범 금지).
  - 시간축: 왼쪽 `bar_count×interval` 환산(예 "10분 전"), 오른쪽 "지금".
- 칸 상태(최신 결과 기준): `fail` → 실패(빨강), `config_error` → 설정 오류(회색), `ok` + 기준선 초과 → 느림(그 기준선 색), `ok` → 정상(초록). 상태는 항상 아이콘+글자 병기.

### 7.4 갱신·멈춤 (US5)
- 전시 화면은 `status`를 1초 간격 폴링: **`retry: false`, `refetchIntervalInBackground: true`**(F15 — 전역 retry 1이 실패 감지를 늦추고, 가려진 창에서 폴링이 멈추면 멈춤 판정도 멈춘다; r2 #11). 실패 횟수는 화면이 직접 센다.
- `board_updated_at`이 바뀌면 보드 설정을 다시 읽는다.
- **확인 불가**(클라, 서버 `now_ms` 기준, `[Claude]`): 칸 최신 `at_ms`(없으면 `started_at_ms`)로부터 `interval×3 + timeout + 5초`가 지났으면. 보드가 꺼져 있으면 모든 칸 "확인 불가 · 점검 꺼짐". **폴링 연속 3회 실패**면 모든 칸 확인 불가 + 헤더 "서버 응답 없음".
- 첫 결과 전이고 위 시간이 안 지났으면 "확인 중".

### 7.5 깜빡임
- `fail` → `fail` 칸만, `slow_and_fail` → `fail` + 느림 칸. **설정 오류·확인 불가는 깜빡이지 않는다**(점검/설정 문제와 서비스 장애 구분 — `[Claude]`, r2 #17).
- 1초 주기 배경 밝기 ease-in-out, 초당 3회 이상 번쩍임 없음. `prefers-reduced-motion`이어도 켰으면 깜빡인다(명시 설정 우선 — `[Claude]`).

### 7.6 전체화면 (US1)
- 진입: "모니터 시작"(§7.2 순서) / 전시 화면의 "전체화면" 버튼 / **F 키 토글**(`[Claude]` — 사용자의 다른 운영 화면 앱과 같은 키, F17). 모두 `document.documentElement.requestFullscreen()`(SPA 라우트 이동에도 유지).
- 해제: ESC(브라우저 기본) / F 키 / **`mousedown` 아무 버튼** → `document.exitFullscreen()`(`[사용자]`). 전체화면 중 `contextmenu` 기본 동작 억제. 마우스 이동만으로는 해제 안 함.
- 전체화면 중 커서 숨김, 마우스 이동 시 3초 표시.
- 해제 후 **같은 화면 창 모드 유지 + 점검 계속**. 창 모드에서만 작은 도구 줄(전체화면 · 설정으로 · 점검 정지).
- **웹뷰 엔진별 실측**(r2 #10b·c): macOS 데스크톱 앱(WKWebView)과 브라우저(Chromium)에서 실측하고 결과를 build-log에 엔진별로 기록. Windows(WebView2)는 F17이 간접 근거, **Ubuntu(WebKitGTK — 실제 운영 PC)는 실행해 보기 전까지 "미검증"으로 roadmap §B에 기록**. 거부되는 엔진에서의 대체 = 헤더 없는 전시 화면을 사용자가 창 최대화로 띄움(웹 페이지는 창 최대화를 못 함). 창 자체 전체화면은 ③(Tauri 창 생성 시 `fullscreen` 옵션 — F17 앱 선례).

## 8. 오류·엣지
- 칸 0개 보드: 저장 거부(400).
- 점검 중 시나리오/환경 삭제: 다음 점검 `config_error`. 삭제 가드(ADR-0045)에 보드 참조 반영은 **연기** → roadmap §B(비용: 경고 없이 보드를 깨뜨리는 삭제 가능 / 해소: soft 409 카운트에 `config_json` 스캔 추가).
- 벽 화면에는 §6.2 고정 문구 + 작성자가 쓴 스텝 이름만 나간다(실행 중 받은 값·URL·응답 조각 없음). 원문 error는 설정 화면 미리 실행에서만.

## 9. 검증 계획
- 컨트롤러 단위: §6.2 각 분기(바깥 timeout: 1스텝·3초 응답·timeout 1 → `fail "시간 초과(1초)"`, truncated 사유 둘, 사유 분류 4종, 마지막 실행 스텝 선택), 링버퍼 순서·상한, PUT 시 칸 id 유지 버퍼 보존, 400 검증, 주입형 루프의 시작-시작·겹침 없음(time pause, fake check).
- UI RTL: 막대 슬롯 왼쪽 채움·탈락, 현재 기준선 기반 색, 기준값 열과 막대 영역 분리(구조), 확인 불가·서버 응답 없음 판정, `board_updated_at` 변경 시 재조회, 깜빡임 대상, mousedown/F → `exitFullscreen` 호출, 모니터 시작 핸들러가 `requestFullscreen`을 await 전에 호출.
- **라이브(필수)** — US 척추:
  | US | 절차 | 통과 신호 |
  |---|---|---|
  | US1 | responder(200 ↔ 503 토글, 시나리오에 `status: 200` assert)로 2칸 보드, 1920×1080 전체화면 | 제목·상태·큰 값 글자 높이(`getBoundingClientRect`)가 목업 v4(1920 폭 렌더) 대비 ±10%, 503 시 그 칸만 빨강+깜빡임, mousedown 후 `document.fullscreenElement === null`이고 다음 폴링에 새 결과 |
  | US2 | responder 지연을 점차 증가, bar_count 10 | 막대가 왼쪽부터 채워지고 11번째부터 왼쪽 탈락, 기준선 넘은 막대 색 변화, 기준값 열 사각형과 막대 사각형 비교차 |
  | US4 | 칸 A 3초·칸 B 9초 주기 30초 관찰 → 기준선 삭제 PUT → 컨트롤러 재시작 | 결과 개수 비 ≈ 3:1, PUT 후 수 초 내 전시 화면 기준선·막대 색 갱신, 재시작 후 설정 유지·자동 재개(독립 바이너리 + 데스크톱 in-process 두 경로) |
  | US5 | 점검 중 컨트롤러 kill / 보드 stop | 수 초 내 전 칸 확인 불가 + "서버 응답 없음" / "점검 꺼짐" |
  | 안티골 | responder 20초 지연, timeout 5 | 칸 `✖ 시간 초과(5초)` (정상 아님) |
- 웹뷰 엔진별 전체화면 실측(§7.6).
- **bundle 빌드 수동 게이트**(r3 R1): `in_process.rs`는 `#[cfg(feature = "bundle")]`(`crates/controller/src/lib.rs:11-12`)라 pre-commit 훅이 컴파일하지 않는다 → `ui/dist` 빌드 후 `cargo build`·`cargo clippy -- -D warnings`·`cargo nextest run`을 `-p handicap-controller --features bundle`로 수동 실행(in_process 배선 task마다 + 머지 전).
- 보안 리뷰 게이트: 요청 실행·env 바인딩 경로 → `security-reviewer` 필수 예상(판정은 finish-slice §0 grep).

## 10. 연기 / 후속
- **①b (다음 슬라이스, 결정 원천 §① 성공 판정·화면 방식)**: 칸별 성공 조건(`step_id/source/path/op/value`, 연산자 7종, `null`=빈 값 → `not_empty` 실패, JSONPath 저장 시 문법 검증), 미리 실행 본문 트리·헤더 표·상태의 "+조건"(ResponseBodyTree 단독이 아니라 `ExtractConfirmRow`·`BodyBlock`/`BodyViewer`·`HeaderTable`·`HttpRow`·`TraceStepList` extract 체인 일반화 — r2 E4), 실패 사유 `{경로} = {값}`/`{경로} 비어 있음`/`{경로} 없음`(표시 경로 정의 필요), 화면 방식 A(신호등)·C(실패만 크게 — 그리드 가중 정의 필요, r2 #19) + 보드의 `display_style` 필드. 조건 사유에는 실제 응답 값이 벽에 나간다 → ①b spec에서 보안 검토.
- ② 내보내기/가져오기, ③ 자동 시작+부팅 전체화면.
- 시나리오/환경 삭제 가드의 보드 참조(§8), Ubuntu WebKitGTK 전체화면 실측(§7.6), 결과 영속·외부 알림.

## 11. ADR-0053 (①a에서 작성)
"운영 모니터 모드: Handicap 안 별도 기능 영역으로 주기 점검 보드 — 엔진 1패스 trace 재사용(바깥 timeout·요청 상한 50), run/리포트/스케줄러와 분리, 결과 메모리 링버퍼, 느림 판정은 화면". ADR-0009 범위가 **부하 테스트 실행 중 대시보드**였음을 명시(번복 아님 — `[사용자]` 교정).

## 12. Claude가 내린 판단 (사용자 확인 대상)
결정 원천 `[Claude]` 항목 + 이 spec: JSON 한 컬럼 저장 · `preview-check` = 루프와 같은 서버 경로 · 제한 시간 기본 5초(1–120, 바깥 강제) · 점검 요청 상한 50 고정 · 주기 1–3600초 · 칸 최대 9 · 기준선 최대 5 · 표시 응답 시간 기본 = 시나리오 전체 · think time 미적용 · 반복 스텝은 마지막 응답 · 느림은 화면이 현재 기준선으로 계산 · 사유는 고정 문구 분류(원문 미노출) · 확인 불가 = 3주기+제한시간+5초 · 폴링 3연속 실패 = 서버 응답 없음 · 설정 오류/확인 불가는 안 깜빡임 · 켜진 보드 재시작 시 자동 재개 · 헤더에 "로그인" 없음 · F 키 토글 · 그래프 15% 미만이면 숨김 · 칸 순서 = 추가 순서.
