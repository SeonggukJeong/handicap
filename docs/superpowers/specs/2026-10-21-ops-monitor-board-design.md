# 운영실 모니터 화면 본체 (ops-monitor-board) — 설계

- 날짜: 2026-10-21 · 유형: `user-path` · 슬라이스 ①/3 (② 내보내기/가져오기, ③ 자동 시작+전체화면 실행은 별도 spec)
- **결정 원천**: [`2026-10-21-ops-monitor-mockups/00-decisions.md`](2026-10-21-ops-monitor-mockups/00-decisions.md) + 같은 폴더 목업(`01-display-styles-ABC.html`, `01b-latency-options-chose-3.html`, `02-latency-bars-final.html`/`.png`). 이 spec이 결정 원천과 어긋나면 **결정 원천이 이긴다**. `[사용자]` 표시 결정은 사용자 확인 없이 바꾸지 않는다.
- 새 ADR: **ADR-0053 운영 모니터 모드** (§11).

## 사용자 스토리 (US)

- **US1**: 운영자가 운영실 벽 모니터를 방 반대편에서 볼 때 다가가지 않고 어느 시스템이 정상/느림/실패인지 판별한다 — 성공하면 칸마다 제목·상태 글자+아이콘·현재 응답 ms가 큰 글씨로 보이고, 실패 칸은 색과(켜 두었으면) 깜빡임으로 구분되며, ESC나 마우스 아무 버튼으로 전체화면을 빠져나와도 점검은 계속된다.
- **US2**: 운영자가 응답이 점점 느려질 때 기준선을 넘기 전에 추세를 알아챈다 — 성공하면 칸 폭을 꽉 채운 막대가 왼쪽부터 쌓이다 꽉 차면 왼쪽부터 밀려나며 높이가 올라가는 모양이 보이고, 막대는 넘은 기준선 색으로, 기준값 숫자는 그래프 밖 칸에 표시된다.
- **US3**: QA가 기존 시나리오로 칸을 만들며 미리 실행 결과의 응답 값을 클릭해 성공 조건을 정한다 — 성공하면 200이 와도 조건에 맞지 않는 응답일 때 그 칸이 실패가 되고, 어느 조건이 어떤 값 때문에 실패했는지 칸에 표시된다.
- **US4**: QA가 시스템마다 점검 주기·기준선(개수/색/값)·화면 방식(A/B/C)·글자 크기·깜빡임을 정한다 — 성공하면 칸마다 정한 주기대로 점검되고(예: 1.0은 10초, 2.0은 30초), 바꾼 설정은 저장 후 화면에 반영되며 앱을 다시 켜도 유지된다.
- **US5**: 운영자가 점검 자체가 멈췄을 때 오래된 초록불에 속지 않는다 — 성공하면 주기 대비 너무 오래 결과가 없는 칸이 회색 "확인 불가"로 바뀌고, 헤더의 마지막 점검 시각이 멈춘 시점을 보여준다.

## 1. 배경과 목표

통신사 회선 PC(Ubuntu)에서 셸 스크립트가 10초마다 로그인 API를 호출해 텍스트로 결과를 찍고 있다. 글씨가 작아 운영자가 "줄 길이 변화"로만 이상을 눈치채고 화면 앞까지 걸어간다. 이 슬라이스는 그 스크립트를 **Handicap 안의 운영 모니터 화면**으로 대체한다 — 첫날부터 PC에서 직접 설정하고 수동으로 띄우면 쓸 수 있는 상태가 완료 기준(자동 시작은 ③, 다른 PC로 옮기기는 ②).

**범용 API 모니터다**(`[사용자]`): 로그인 전용 판정(토큰 고정 검사)·비밀번호 식별 로직을 넣지 않는다.

### 비목표 (이 슬라이스)
- 내보내기/가져오기(②), 로그인 시 자동 시작·부팅 직후 전체화면(③).
- 소리 알림(스피커 없음 `[사용자]`), 메일/메신저 알림, 결과 장기 보관·리포트, 여러 PC 결과 모으기.
- "평소의 N배" 자동 기준선, 별도 느림 산출 로직(`[사용자]`: 막대 방식만).
- 부하 run·리포트·스케줄러 파이프라인 변경. 모니터 점검은 run 레코드를 만들지 않는다.

### 안티골 (기술적으로 돌아가도 실패)
- 멀리서 글씨가 안 읽힘(그래프가 글자를 밀어내 작게 만듦 — `[사용자]` v3 피드백).
- 기준값 숫자/선이 막대를 가림(`[사용자]`).
- 점검이 멈췄는데 초록불이 그대로 남음.
- 점검 주기가 사실상 고정(UI에 노출 안 되거나 10초 하드코딩 — `[사용자]` 우려 명시).
- 응답속도를 소수점 초로 표시(`[사용자]`: ms 정수).

## 2. 코드 사실 (이 설계가 기대는 것 — 각 줄은 재현 명령 포함)

| # | 사실 | 확인 명령 |
|---|---|---|
| F1 | `POST /api/test-runs`는 컨트롤러 in-process로 `trace_scenario`를 1패스 실행, 미저장 | `grep -n "pub async fn create" -A40 crates/controller/src/api/test_runs.rs` |
| F2 | `ScenarioTrace{ok,total_ms,steps,final_vars,truncated,error}`, `StepTrace{step_id,kind,loop_index,branch,request,response,extracted,unbound_vars,error}`, `TracedResponse{status,latency_ms,download_ms,headers,set_cookies,body,body_truncated}` | `grep -n "pub struct\|pub [a-z_]*:" crates/engine/src/trace.rs` |
| F3 | trace `ok` = 모든 step `error.is_none()`; status assert 불일치·extract 실패가 step error가 됨 | `grep -n "let ok = state.steps" crates/engine/src/trace.rs` · `grep -n "Assertion::Status(want)" crates/engine/src/executor.rs` · `grep -n "Err(e) => error = Some" crates/engine/src/executor.rs` |
| F4 | 시나리오 assertion은 `Status`뿐 | `grep -n -A3 "pub enum Assertion" crates/engine/src/scenario.rs` |
| F5 | JSON `null`은 extract 시 빈 문자열(성공) | `grep -n "Value::Null => String::new()" crates/engine/src/extract.rs` |
| F6 | 트레이스 본문 상한 1 MiB, 초과 시 `body_truncated` | `grep -n "MAX_TRACE_BODY_BYTES" crates/engine/src/executor.rs` |
| F7 | JSONPath는 `serde_json_path` 0.7, 엔진의 `jsonpath_first`는 private | `grep -n "serde_json_path" Cargo.toml crates/engine/Cargo.toml` · `grep -n "fn jsonpath_first" crates/engine/src/extract.rs` |
| F8 | 스케줄러 루프 `run_scheduler(state, tick)`; 독립 바이너리는 detached spawn, 데스크톱 in-process는 `CancellationToken`+`select!` | `grep -n "run_scheduler" crates/controller/src/main.rs crates/controller/src/in_process.rs crates/controller/src/schedule/runner.rs` |
| F9 | 환경 값 해석은 클라 오버레이(ADR-0025) — 서버에 environment_id 해석기 없음, `store::environments::get`은 있음 | `grep -rnE 'env_id\|environment_id\|environments::get' crates --include='*.rs'` |
| F10 | 마이그레이션은 `store/mod.rs` 순차 실행, 최신 = 0021(`ensure_runs_label`, Rust guard) → 다음 0022 | `ls crates/controller/src/store/migrations/` · `grep -n "0021\|ensure_runs_label" crates/controller/src/store/mod.rs` |
| F11 | UI 라우트 `ui/src/routes.tsx`(`Layout` 자식), 상단 nav `ui/src/components/Layout.tsx` 하드코딩 Link + `ko.nav.*`; `<main>`은 `max-w-6xl` | `grep -n "path:" ui/src/routes.tsx` · `grep -n "ko.nav" ui/src/components/Layout.tsx` |
| F12 | `ResponseBodyTree`(JSON && !truncated일 때만) 스칼라 leaf에 "+추출", `onCreate(extract)` prop; JSONPath 생성 `ui/src/scenario/jsonPath.ts` | `grep -n "onCreate\|segmentsToPath" ui/src/components/scenario/ResponseBodyTree.tsx` |
| F13 | UI에 fullscreen 코드 없음, `@tauri-apps/api` 미의존; 데스크톱 창은 in-process 컨트롤러의 `http://127.0.0.1:<port>/`를 navigate | `grep -rnE "fullscreen\|requestFullscreen" ui/src` · `grep -n tauri ui/package.json` · `grep -n navigate desktop/src-tauri/src/lib.rs` |
| F14 | trace는 호출마다 새 `VuClient`(쿠키 jar·커넥션 신규) | `grep -n "VuClient::new" crates/engine/src/trace.rs` |

## 3. 개념 모델

- **모니터 보드(board)**: 운영실 화면 하나. 이름(예 "SKT 회선"), 화면 방식, 글자 크기, 깜빡임, 칸 목록, **점검 켜짐 여부**.
- **칸(panel)**: 시나리오 1개를 주기적으로 1회 실행하는 단위. 제목은 칸 설정에 둔다(시나리오와 무관 — `[Claude]`, 결정 원천). 칸 = 시나리오 단위이며 스텝 단위가 아니다.
- **점검(check)**: 칸의 시나리오를 1패스 실행한 1회. 결과 = 시각, 판정(정상/느림/실패), 표시 ms, 실패 사유.

## 4. 저장 (migration 0022)

```sql
CREATE TABLE IF NOT EXISTS monitor_boards (
  id          TEXT PRIMARY KEY,           -- ULID (서버 생성)
  name        TEXT NOT NULL UNIQUE,       -- 중복 → 409 (environments 선례)
  config_json TEXT NOT NULL,              -- BoardConfig (아래) — 통째 JSON
  enabled     INTEGER NOT NULL DEFAULT 0, -- 점검 켜짐 (재시작 시 자동 재개)
  created_at  INTEGER NOT NULL,           -- epoch ms
  updated_at  INTEGER NOT NULL
);
```

**설정을 JSON 한 컬럼으로 두는 이유**(`[Claude]`): 칸 목록·기준선·조건은 항상 보드와 함께 읽고 쓰며, ②의 내보내기 파일이 같은 구조를 그대로 쓰게 된다. 칸별 행 분리는 이득 없음.

### BoardConfig (와이어 = 저장 형태, serde `snake_case`)

```jsonc
{
  "display_style": "signal" | "outline" | "focus",   // A=신호등 / B=어두운 칸+테두리 / C=실패만 크게
  "font_scale": "small" | "medium" | "large" | "xlarge", // 기본 "large"
  "blink": "off" | "fail" | "slow_and_fail",          // 기본 "fail"
  "panels": [ PanelConfig, ... ]                       // 1..=9개
}
```

```jsonc
// PanelConfig
{
  "id": "<ULID>",                    // 서버가 비어 있으면 발급, 이후 불변 (결과 버퍼 키)
  "title": "더비온 1.0",               // 1..=40자
  "scenario_id": "<ULID>",
  "environment_id": "<ULID>" | null, // null = 환경 없이 실행
  "interval_seconds": 10,            // 1..=3600, 새 칸 기본값 10 — 고정 아님 [사용자]
  "timeout_seconds": 5,              // 1..=120, 점검 1회 전체 제한 시간 [Claude]
  "latency_source": { "kind": "total" } | { "kind": "step", "step_id": "<ULID>" },
  "conditions": [ Condition, ... ],  // 0..=10개, 전부 만족해야 성공
  "thresholds": [ { "ms": 700, "color": "#facc15" }, ... ], // 0..=5개, ms 오름차순·중복 금지
  "bar_count": 60,                   // 10..=300
  "graph_max_ms": 2000               // 100..=600000, 초과 값은 맨 위에 붙음
}
```

```jsonc
// Condition — "응답에서 값을 골라 사용자 규칙" [사용자]
{
  "step_id": "<ULID>",               // 시나리오 안의 http 스텝
  "source": "body" | "header" | "status",
  "path": "$.data.token",            // body: JSONPath(RFC 9535) / header: 헤더 이름 / status: 빈 문자열
  "op": "exists" | "not_empty" | "equals" | "not_equals" | "contains" | "gt" | "lt",
  "value": "0000"                    // equals/not_equals/contains/gt/lt에서만 필수, 나머지는 무시
}
```

검증(저장 시 422, 한국어 메시지): 위 범위, `thresholds` 오름차순, `color`는 `#rrggbb`, `op`별 `value` 필수 여부, `gt/lt`의 `value`가 숫자, `source=status`면 `op`는 `equals/not_equals/gt/lt`만. **시나리오·환경·step_id 존재 여부는 저장 시 검사하지 않는다**(삭제·편집 후에도 보드는 저장 가능해야 함 — 실행 시점에 칸이 "설정 오류"로 표시, §6.4).

## 5. API (controller, `/api/monitor-boards`)

| 메서드 | 경로 | 동작 |
|---|---|---|
| POST | `/monitor-boards` | 생성 `{name, config}` → 201 Board |
| GET | `/monitor-boards` | 목록 `{"boards":[Board…]}` (래퍼 — scenarios 선례) |
| GET | `/monitor-boards/{id}` | 단건 |
| PUT | `/monitor-boards/{id}` | 수정 `{name, config}` — 켜져 있으면 점검 재구성(§6.3) |
| DELETE | `/monitor-boards/{id}` | 삭제(점검 중이면 먼저 정지) → 204 |
| POST | `/monitor-boards/{id}/start` · `/stop` | `enabled` 영속 + 점검 시작/정지 → 200 Board |
| GET | `/monitor-boards/{id}/status` | 화면용 상태(§6.5) |
| POST | `/monitor-boards/preview-check` | 칸 설정 1개로 **점검 1회를 즉시 실행**, 저장 안 함 → `{trace: ScenarioTrace, result: CheckResult}` |

`Board = {id, name, config, enabled, created_at, updated_at}`.

`preview-check`는 루프와 **같은 함수**(§6.1)를 부른다 — 미리 실행 판정과 실제 점검 판정이 갈라지지 않게(`[Claude]`). 에디터 test-run(`POST /api/test-runs`)을 재사용하지 않는 이유: 그쪽은 env를 클라에서 병합해 받는데(F9) 모니터 루프는 서버에서 `environment_id`로 env를 읽어야 하므로, 미리 실행도 같은 서버 경로여야 "미리 실행은 성공인데 실제 점검은 실패" 같은 불일치가 없다.

## 6. 점검 동작 (controller `monitor` 모듈)

### 6.1 점검 1회 `run_check(state, panel) -> (ScenarioTrace?, CheckResult)`
1. DB에서 시나리오 YAML(`scenario_id`)과 환경 vars(`environment_id`, `store::environments::get`)를 **매 점검마다** 읽는다 → 에디터에서 시나리오를 고치면 다음 점검부터 반영. 없으면 `CheckResult{verdict: config_error, reason: "시나리오를 찾을 수 없음"|"환경을 찾을 수 없음"}`.
2. `trace_scenario(&scenario, &TraceOptions{ env, max_requests: settings.max_test_run_requests(), max_wall: timeout_seconds, apply_think_time: false })`. think time 미적용(`[Claude]` — 점검은 즉시 1패스). 매번 새 클라이언트(F14) = 매 점검이 처음부터 새로 로그인(현재 셸 스크립트와 같은 의미).
3. 판정(§6.2) → `CheckResult`.

```jsonc
// CheckResult (와이어)
{
  "at_ms": 1792583530000,          // 점검 시작 시각 (epoch ms)
  "verdict": "ok" | "slow" | "fail" | "config_error",
  "latency_ms": 1350 | null,       // latency_source 기준, 측정 불가면 null
  "reason": "HTTP 503" | null,     // fail/config_error일 때 한 줄 사유 (화면 표시용, ≤ 120자)
  "threshold_index": 1 | null      // 넘은 가장 높은 기준선 index (색 결정)
}
```

### 6.2 판정 규칙 (위에서부터 첫 해당)
1. 시나리오/환경 없음, 시나리오 파싱 실패, `latency_source`/`conditions`의 `step_id`가 시나리오에 없음 → `config_error`.
2. trace `error`가 있거나, trace가 `truncated`(제한 시간/요청 상한 도달)면 → `fail`, 사유 "시간 초과(N초)" 또는 trace error 요약.
3. 실행된 스텝 중 첫 `error` 스텝 → `fail`. 사유: HTTP 응답이 있으면 `HTTP {status}`(status assert 불일치), 없으면 error 문자열 앞 80자(연결 실패 등 — trace `StepTrace`에는 ADR-0050 error kind 필드가 없다: `grep -n "error_kind" crates/engine/src/trace.rs` 0건. 사람이 읽을 라벨 매핑은 구현 계획에서 error 문자열 기준으로 정한다).
4. 조건을 순서대로 평가, 첫 불만족 → `fail`. 사유 `"{표시 경로} = {실제 값}"`(값 60자 절단, 값 없음이면 `"{경로} 없음"`), 예 `resultCode = E1023`, `$.data.token 없음`.
   - 조건의 `step_id` 스텝이 실행되지 않았으면(앞 스텝 실패로 중단 등) 사유 "스텝 미실행: {스텝 이름}".
   - 같은 step_id가 루프/분기로 여러 번 실행됐으면 **마지막 실행**의 응답을 쓴다(`[Claude]`).
   - `body`: 응답 본문 JSON 파싱 → JSONPath 첫 매치. 본문이 JSON이 아니거나 truncated(1 MiB, F6)면 "값 없음"으로 취급.
   - 값 문자열화: 문자열은 그대로, 숫자/불리언은 JSON 표기, `null`은 **값 없음이 아니라 빈 값**으로 본다 → `exists` 통과·`not_empty` 실패(F5와 같은 의미, 결정 원천의 "토큰 비어 있음 = 실패" 요구를 `not_empty`가 만족).
   - `exists`=경로/헤더가 있음, `not_empty`=있고 빈 문자열 아님(공백만도 빈 값), `equals`/`not_equals`=문자열 완전 일치, `contains`=부분 문자열, `gt`/`lt`=양쪽을 f64로 파싱해 비교(실제 값이 숫자 아니면 불만족).
   - `header`: 이름 대소문자 무시, 여러 개면 첫 값. `status`: 응답 status 코드를 숫자 문자열로.
5. 여기까지 통과 = 성공. `latency_ms`가 기준선 `ms` 이상인 것 중 가장 높은 것이 있으면 `slow`(+`threshold_index`), 없으면 `ok`.

`latency_ms`: `total` = trace `total_ms`, `step` = 그 스텝 마지막 실행의 `response.latency_ms`(없으면 null). **표시 ms는 정수 ms**(`[사용자]`).

### 6.3 루프 (`MonitorSupervisor` — `AppState`에 `Arc` 보관)
- 켜진 보드마다, 칸마다 tokio task 1개. 컨트롤러 시작 시 `enabled=1` 보드 자동 재개(③ 자동 시작의 전제, `[Claude]`).
- 주기 = **시작-시작 간격 `interval_seconds`**. 점검이 주기보다 오래 걸리면 끝나자마자 다음 점검(겹쳐 돌리지 않음). 첫 점검은 시작 즉시.
- 결과는 칸별 메모리 링버퍼(`VecDeque<CheckResult>`, 최대 300 = `bar_count` 상한)에만 보관 — 재시작 시 비어 있다(`[Claude]`, 결정 원천).
- 보드 PUT: 켜져 있으면 그 보드 task 전부 정지 후 새 설정으로 재시작. **칸 `id`가 그대로면 링버퍼 유지**, 사라진 칸 버퍼는 폐기.
- stop/delete: task 정지, 버퍼 폐기.
- 종료: 데스크톱 in-process는 스케줄러와 같은 `CancellationToken` 패턴으로 정지(F8). 독립 바이너리는 스케줄러와 동일하게 detached.
- 동시성 상한: 전체 동시 점검 수 = 켜진 칸 수(보드당 ≤9). 별도 세마포어는 두지 않는다(`[Claude]` — 운영 PC 1대에 보드 1~2개 규모).

### 6.4 실패 표시용 파생값 (서버 계산 — 화면은 받아서 그리기만)
- `consecutive_fail`: 최신부터 연속 `fail`/`config_error` 개수, `fail_since_ms`: 그 연속의 첫 `at_ms`.

### 6.5 `GET /monitor-boards/{id}/status`
```jsonc
{
  "now_ms": 1792583531000,        // 서버 시각 — 멈춤 판정 기준 (클라 시계 차이 회피)
  "enabled": true,
  "panels": [{
    "panel_id": "...",
    "results": [CheckResult, ...], // 오래된 것 → 최신, 최대 bar_count개
    "consecutive_fail": 3, "fail_since_ms": 1792583510000,
    "running": true                // 지금 점검 진행 중
  }]
}
```

## 7. 화면 (UI)

### 7.1 라우트·메뉴
- 상단 메뉴에 **"모니터"** 추가(`ko.nav.monitors`) → `/monitors`(목록: 이름·칸 수·켜짐 여부·"화면 열기").
- `/monitors/new`, `/monitors/:id` — 설정 화면(`Layout` 안).
- `/monitors/:id/display` — **전시 화면, `Layout` 밖**(헤더·`max-w-6xl` 없이 창 전체 — F11).

### 7.2 설정 화면
- 보드: 이름, 화면 방식 A/B/C(세 목업 썸네일 라디오), 글자 크기(작게/보통/크게/아주 크게), 깜빡임(끄기/실패만/느림+실패).
- 칸 목록(추가·삭제·순서 위/아래 버튼): 제목, 시나리오(선택), 환경(선택/없음), 점검 주기(초, 입력칸 — 기본 10), 제한 시간(초, 기본 5), 표시할 응답 시간(전체 / 특정 스텝), 기준선 목록(값 ms + 색 `<input type="color">` + 삭제, "+ 기준선 추가", 최대 5), 막대 개수, 그래프 최대 높이(ms).
- **미리 실행**(칸마다): `preview-check` 호출 → 스텝별 상태·ms·응답 본문 + 이번 판정(`CheckResult`)을 보여준다. 본문은 기존 `ResponseBodyTree`(F12)를 재사용하되 leaf 버튼이 "+추출" 대신 **"+조건"** → 클릭하면 `{step_id, source:"body", path, op:"not_empty"}` 조건 행이 추가되고 규칙·값을 고친다. 헤더는 응답 헤더 표에 "+조건"(source header). status는 조건 목록의 "상태코드 조건 추가" 버튼.
  - `ResponseBodyTree`는 `onCreate(extract)` 계약이라 그대로 못 쓴다 → leaf 액션 라벨·콜백을 받는 일반화(기존 에디터 동작 불변)가 필요. 방식은 구현 계획에서 정한다.
- 조건 행: `[스텝 이름] [출처] [경로] [규칙 ▼] [값]` + 삭제. 규칙 라벨: 값이 있음 / 비어 있지 않음 / 같음 / 같지 않음 / 포함 / 숫자가 크다 / 숫자가 작다.
- 저장 버튼, "모니터 시작"(= start + 전시 화면으로 이동 + 전체화면 요청), 켜져 있으면 "점검 정지".
- 선택적·대량 섹션은 접이식(사용자 선호 — 기준선·조건·고급(제한 시간/표시 응답 시간/막대 개수/최대 높이)은 접힌 disclosure, 값이 있으면 "N개 설정됨").

### 7.3 전시 화면 (목업 `02-latency-bars-final.*` 가 레이아웃 정본)
- 배경 `#0b0f14` 계열 어두운 고대비. 헤더 한 줄: `{보드 이름} · 로그인 모니터`가 아니라 **`{보드 이름}`**(범용 — "로그인" 문구 금지) + 오른쪽 `마지막 점검 HH:MM:SS`(칸들 중 최신 `at_ms`).
- 칸 배치: 1개=전체, 2=좌우, 3=3열, 4=2×2, 5–6=3×2, 7–9=3×3(`[Claude]`). C 방식은 아래 7.4.
- 칸 내부(위→아래): **1줄** 제목(왼쪽) + 상태(오른쪽: `✔ 정상`/`▲ 느림`/`✖ 실패`/`– 확인 불가`/`… 확인 중`), **2줄** 현재 값 크게(정상/느림 = `1,350 ms`(천 단위 쉼표, 상태 색) / 실패 = 사유 `HTTP 503`, `resultCode = E1023` / 연속 실패면 아래 작게 `3회 연속 · 14:31:50부터`), **나머지 공간** 막대 그래프.
- 글자 크기: 칸 크기 기준 상대 단위(`cqw` 등)로 목업 v4 비율을 "크게" 기본값으로, 작게/보통/아주 크게는 비율 배수(예 0.7/0.85/1.0/1.2 — 정확한 값은 구현 중 실측). 글자가 커지면 그래프 영역이 줄어든다(그래프는 남는 공간). **안티골 가드**: 칸 높이가 부족해 그래프가 일정 높이 미만이 되면 그래프를 줄이지 글자를 줄이지 않는다.
- 막대 그래프 (`[사용자]` 요구 전부):
  - 칸 좌우 폭을 꽉 채움. 막대 개수 = `bar_count` 슬롯 고정 폭, **결과가 적으면 왼쪽부터 채움**, 꽉 차면 가장 오래된 것이 왼쪽으로 빠지고 최신이 오른쪽 끝.
  - 높이 = `latency_ms / graph_max_ms`(초과는 100%), 색 = `threshold_index` 기준선 색(없으면 초록 `#22c55e`), `fail` = 풀높이 빨강 빗금 + ✖, `config_error` = 풀높이 회색 빗금.
  - 기준선 = 점선(기준선 색), **그래프 영역 안에서만** 그리고, 기준값 숫자(쉼표, 단위 없이)는 **그래프 오른쪽 전용 열**에 그 높이로 표시. 단위 `(ms)`는 그 열 아래 한 번. 열 폭은 가장 긴 숫자에 맞춘다(5자리 이상도 막대 침범 금지).
  - 시간축 라벨: 왼쪽 `{bar_count×interval}` 환산(예 "10분 전"), 오른쪽 "지금".
- 화면 방식:
  - **A signal**: 칸 배경 = 상태 색(정상 초록·느림 = 해당 기준선 색·실패 빨강·확인 불가 회색), 글자 흰색. 막대 색은 배경과 구분되게 한 단계 진하게/밝게(구현 중 대비 실측).
  - **B outline**: 어두운 칸 + 상태 색 굵은 테두리, 상태 글자·현재 값이 상태 색(목업 v4 그대로).
  - **C focus**: B 스타일 기반, 실패/확인 불가 칸이 하나라도 있으면 그 칸들이 넓어지고(가중치 약 1.45:0.55) 정상 칸은 줄어든다. 모두 정상이면 균등.
- 상태 문구는 항상 아이콘+글자 병기(색만으로 구분 금지).

### 7.4 갱신·멈춤(US5)
- 전시 화면은 `status`를 1초 간격 폴링(React Query `refetchInterval`).
- **확인 불가** 판정(클라, `now_ms` 기준): 칸의 최신 결과가 `now_ms - at_ms > interval×3 + timeout + 5초`이거나 결과가 없고 보드가 켜진 지 같은 시간이 지났으면(`[Claude]`). 보드가 꺼져 있으면 모든 칸 "확인 불가 · 점검 꺼짐".
- **폴링 자체가 연속 3회 실패**(컨트롤러 응답 없음)하면 모든 칸 확인 불가 + 헤더에 "서버 응답 없음"(`[Claude]`).
- 아직 첫 결과 전이면 "확인 중".

### 7.5 깜빡임
- `blink`가 `fail`이면 `fail`/`config_error` 칸, `slow_and_fail`이면 `slow` 칸도. 1초 주기 배경 밝기 ease-in-out(빠른 점멸 금지 — 초당 3회 이상 번쩍임 없음). 확인 불가는 깜빡이지 않는다(`[Claude]` — 점검 멈춤과 서비스 장애를 구분).
- `prefers-reduced-motion`이어도 사용자가 켰으면 깜빡인다(명시 설정 우선 — `[Claude]`).

### 7.6 전체화면 (US1)
- "모니터 시작"/전시 화면의 "전체화면" 버튼 클릭(사용자 제스처) → `document.documentElement.requestFullscreen()`.
- 전체화면 중: **ESC(브라우저 기본) 또는 `mousedown` 아무 버튼** → `document.exitFullscreen()`. 우클릭 메뉴는 전체화면 중 `contextmenu` 기본 동작 억제. 마우스 이동만으로는 빠져나가지 않는다.
- 전체화면 중 커서 숨김(`cursor: none`), 마우스 이동 시 3초 보였다 숨김.
- 빠져나와도 **같은 화면 창 모드로 남고 점검 계속**. 창 모드에서만 화면 위에 작은 도구 줄(전체화면 · 설정으로 · 점검 정지)이 보인다.
- **데스크톱 웹뷰 리스크**: Tauri 창(WebKitGTK/WebView2/WKWebView)이 DOM Fullscreen API를 따르는지 미검증(F13). 구현 중 macOS 데스크톱 앱에서 실측한다. 따르지 않으면 이 슬라이스에서는 "창 최대화 + 헤더 없는 전시 화면"으로 동작을 보장하고, 창 자체 전체화면은 ③에서 Tauri 창 API로 처리한다 — 이 경우 build-log와 roadmap §B에 기록하고 사용자에게 보고한다.

## 8. 오류·엣지
- 칸 0개 보드: 저장 거부(422, panels 1..=9).
- 점검 중 시나리오 삭제: 다음 점검이 `config_error`("시나리오를 찾을 수 없음"), 칸 회색. 시나리오 삭제 가드(ADR-0045)에 보드 참조를 넣는 건 **연기** — roadmap §B에 비용(사용자가 보드를 깨뜨리는 삭제를 경고 없이 할 수 있음)과 해소법(soft 409 카운트에 `config_json` 스캔 추가) 기록.
- 응답 본문이 JSON이 아닌 API: body 조건은 "값 없음". header/status 조건과 지연 막대는 정상 동작.
- 조건의 실제 값이 화면에 그대로 나간다(예 `resultCode = E1023`). 사용자가 토큰 경로에 `equals`를 걸면 실패 시 토큰 값이 벽에 표시될 수 있다 → 사유 값 60자 절단만 하고 마스킹은 하지 않는다(범용 도구, 비밀번호 판단 금지 `[사용자]`). 보안 리뷰에서 재검토.

## 9. 검증 계획

- 엔진·컨트롤러 단위: 판정 규칙 §6.2 각 분기(특히 `null`→`not_empty` 실패, 미실행 스텝, 마지막 실행 선택, gt/lt 비숫자), 링버퍼 왼→오 순서·상한, PUT 시 칸 id 유지 버퍼 보존, 주기 시작-시작·겹침 없음(tokio time pause).
- UI RTL: 막대 슬롯 왼쪽 채움, 기준선 숫자 열이 막대 영역과 겹치지 않음(구조 단언), 확인 불가 판정, 깜빡임 클래스, 전체화면 mousedown → exitFullscreen 호출.
- **라이브(필수)** — US 척추:
  | US | 절차 | 통과 신호 |
  |---|---|---|
  | US1 | 로컬 responder(200 + `{"data":{"token":"x"}}` ↔ 503 토글)로 2칸 보드, 1920×1080 전체화면 스크린샷 | 상태·제목·ms 글자 높이 실측(`getBoundingClientRect`) ≥ 목업 v4 비율, 503 시 해당 칸만 빨강/깜빡임, mousedown 후 `document.fullscreenElement === null` + 다음 폴링에 새 결과 |
  | US2 | responder 지연을 점차 증가 | 막대가 왼쪽부터 채워지고 bar_count 초과 후 왼쪽 탈락, 기준선 넘은 막대 색 변화, 기준 숫자 열과 막대 사각형 비교차 |
  | US3 | 200 + `{"data":{"token":null}}` 응답, 미리 실행에서 token "+조건"(비어 있지 않음) | 칸 `✖ $.data.token` 사유 + 실패 막대 |
  | US4 | 칸 A 3초·칸 B 9초 주기로 30초 관찰, 앱(컨트롤러) 재시작 | 결과 개수 비 ≈ 3:1, 재시작 후 설정 유지·자동 재개 |
  | US5 | 점검 중 컨트롤러 kill | 수 초 내 전 칸 "확인 불가" + "서버 응답 없음" |
- 데스크톱 전체화면 실측(§7.6 리스크).
- 보안 리뷰 게이트: 요청 실행 경로·env 바인딩을 건드리므로 `security-reviewer` 필수 예상(최종 판정은 finish-slice §0 grep).

## 10. 연기 / 후속
- ② 내보내기/가져오기 · ③ 자동 시작+부팅 전체화면(결정 원천 §②·§③).
- 시나리오/환경 삭제 가드에 보드 참조 반영(§8).
- 결과 영속·이력 조회, 외부 알림.

## 11. ADR-0053 (이 슬라이스에서 작성)
"운영 모니터 모드: Handicap 안의 별도 기능 영역으로 주기 점검 보드 제공 — 엔진 1패스 trace 재사용, run/리포트/스케줄러와 분리, 결과는 메모리 링버퍼". ADR-0009의 범위가 **부하 테스트 실행 중 대시보드**였음을 명시(번복 아님 — `[사용자]` 교정).

## 12. Claude가 내린 판단 (사용자 확인 대상 목록)
결정 원천의 `[Claude]` 항목 + 이 spec에서 새로 정한 것: 저장을 JSON 한 컬럼 · `preview-check`를 루프와 같은 서버 경로로 · 제한 시간 기본 5초(1–120) · 주기 범위 1–3600초 · 칸 최대 9 · 기준선 최대 5 · 조건 최대 10 · 표시 응답 시간 기본 = 시나리오 전체 · think time 미적용 · 반복 실행 스텝은 마지막 응답 · `null`은 빈 값 · 확인 불가 = 3주기+제한시간+5초 · 폴링 3연속 실패 = 서버 응답 없음 · 확인 불가는 안 깜빡임 · 켜진 보드 재시작 시 자동 재개 · 헤더에 "로그인" 문구 없음 · 화면 방식 C의 확대 비율.
