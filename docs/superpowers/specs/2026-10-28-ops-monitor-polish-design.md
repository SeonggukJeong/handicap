# 운영실 모니터 개선 1차 (ops-monitor-polish) — 조건 `∈`·기호 표기·감싼 JSON·표시 전용 값·평균/최대·막대 방향 — 설계

- 날짜: 2026-10-28 · 유형: `user-path` (+ ③은 `correctness-bug`) · 1차 = 사용자 요청 ①③⑤②④, 2차(별도 슬라이스) = ⑥⑦
- **결정 원천(최우선)**: [`2026-10-28-ops-monitor-polish-mockups/00-decisions.md`](2026-10-28-ops-monitor-polish-mockups/00-decisions.md) — 이 spec의 `D…` 번호는 그 파일의 번호다. **이 spec이 결정 원천과 다르면 결정 원천이 이긴다**(사용자 지시: "목업에서 결정한거 잘 기록해서 구현할때 다르게 구현하는 일 없도록"). 그다음 원천: ①b spec [`2026-10-22-ops-monitor-1b-design.md`](2026-10-22-ops-monitor-1b-design.md), ①a spec [`2026-10-21-ops-monitor-board-design.md`](2026-10-21-ops-monitor-board-design.md) §7.3 극단값 표시 정책(**유지**).
- **목업 정본**: [`02-split-stats-chosen.html`](2026-10-28-ops-monitor-polish-mockups/02-split-stats-chosen.html) **1번 보드**(벽 화면 배치·정보 구성). `01-shown-values-ABC.html`은 C 채택 근거, 2번 보드는 비교용. 목업은 **배치·정보 구성**의 정본이고 글자 크기·간격 정본은 이 spec §6의 비율 상수와 ①a §7.3 규칙이다. **목업에 없는 화면을 새로 만들지 않는다**(①b D9 유지).
- **상태: 구현·머지 완료 (2026-10-29, 코드 `cec16f48`..`9993098d`)** — 라이브 US1~US5+극단값 PROVEN(`docs/build-log.md`). 라이브가 항목 칸 프로브 높이 결함(확인 불가 상태 넘침)을 적발해 수정(`9993098d`). 판단·연기·보안 잔여 위험 → roadmap §B39. 2차(⑥⑦)는 별도 슬라이스.
- ADR: 새 ADR 없음. **ADR-0053에 보완 절 `## 보완 — ops-monitor-polish (2026-10-28)` 추가**(§9) — 정상일 때도 사용자 값이 벽에 나가는 두 번째 예외.

## 사용자 스토리 (US)

- **US1 (①)**: QA가 `resultCode`가 1 또는 20일 때만 정상인 API의 칸을 설정한다 — 성공하면 `resultCode ∈ {1, 20}` 조건 하나로 저장되고, 다음 점검부터 2~19가 오면 그 칸이 `✖ 실패`, 1·20이면 `✔ 정상`이다.
- **US2 (⑤)**: QA가 조건 줄을 보고 비교 방향과 "만족하면 정상"을 헷갈리지 않고 안다 — 성공하면 설정 줄이 `resultCode [≥] [1]`처럼 대상→기호→값 순서로 읽히고, 목록 머리에 "아래 조건을 모두 만족하면 정상 (AND)"이, `키 있음`/`값 있음` 선택 시 비교값 칸이 비활성으로 보이며, 벽의 실패 사유 작은 줄도 같은 기호 표기다.
- **US3 (③, 재현/기대)**: 재현 — 응답 본문이 `"{\"code\":1}"`(JSON 문자열로 감싼 JSON)인 API를 미리 실행하면 본문 트리가 **문자열 잎 하나**로만 보여 안쪽 값(`code`)을 눌러 조건을 만들 수 없고, 손으로 만든 `$.code` 조건은 `값 없음`으로 실패한다(본문 자체는 유효한 JSON 문자열이라 `본문이 JSON 아님`이 아니다 — `check.rs` `jsonpath_first`가 문자열에서 `None`). 기대 — 본문이 풀린 JSON 트리로 "문자열로 감싼 JSON을 풀어서 표시 중" 안내와 함께 보이고, 안쪽 값을 눌러 만든 `$.code` 조건이 벽에서 정상 판정된다.
- **US4 (②)**: 운영자가 정상인 칸에서도 서버 자체 결과 코드·메시지를 보고 "같은 정상이라도 실제 상황"을 구분한다 — 성공하면 표시 전용으로 고른 코드가 칸 왼쪽에 큰 글자로, 메시지가 그 아래 작은 줄(길면 `…`)로 매 점검 최신 값으로 보이고, 메시지가 빠진 응답이 와도 판정은 바뀌지 않고 `—`로 보인다.
- **US5 (② 평균·최대 + ④)**: 운영자가 막대그래프로 흐름을 볼 때 최신이 항상 오른쪽 끝이고, 그래프 상한을 넘었던 튐을 숫자로 안다 — 성공하면 새 막대는 오른쪽 끝에 붙고 이전은 왼쪽으로 밀리며(점검이 적으면 왼쪽이 빔), 현재 응답 속도 아래에 `평균 N 최대 M`(보이는 막대 구간, 실패 점검 제외)이 보인다. 보드 화면 도구 줄에서 `평균·최대`를 끄면 그 줄이 사라지고 (표시 항목이 없는 칸은) 그래프가 원래 높이로 돌아오며, 점검은 재시작되지 않고 새로고침 후에도 꺼진 상태가 유지된다.

## 1. 배경·목표·비목표

①a·①b로 운영실 보드(칸별 주기 점검 + 벽 화면)와 클릭 성공 조건이 출하됐다. 도그푸딩에서 7개 요청이 나왔고 1차는 "조건과 값이 어떻게 판정되고 벽에 어떻게 보이는가" 묶음이다(00-decisions §슬라이스 분할).

**목표**: ① `∈`(여러 값 중 하나)·AND 명시 ③ 문자열로 감싼 JSON 자동 풀기(판정+미리 실행 보기) ⑤ 기호 표기 + `≥`/`≤` ② 표시 전용 항목(칸당 ≤2) + 반반 배치 + 평균·최대 ④ 막대 오른쪽부터.

**비목표**(범위 밖 — 하지 않는다):
- 조건 그룹/트리·항목 간 OR(D1.2). 조건 목록은 계속 전부 AND.
- ⑥ 설정 화면 접기·칸 목록, ⑦ 막대→요청·응답 기록 — **2차 슬라이스**. 1차 설정 화면은 기존 세로 나열 그대로.
- 시나리오 엔진의 값 추출(`extract`)·에디터 test-run 본문 보기(`TestRunPanel`)에 감싼 JSON 풀기 적용 — 모니터 경로만(§3.3). `BodyBlock` 공용 컴포넌트는 **수정하지 않는다**(§5.4).
- C 방식 띠(`StripCard` — 제목·상태·ms)에 표시 값·평균/최대 추가 — 띠는 무변경.
- `/status`·보관 버퍼 구조 변경(평균·최대는 클라 계산, D2.5).
- 로그인 특화 판정·문구(①a/①b 범용 원칙 유지).

## 2. 설정·와이어 변경 (`crates/controller/src/monitor/config.rs` ↔ `ui/src/api/monitors.ts` 1:1)

### 2.1 `ConditionOp` — 3개 추가

와이어(snake_case): 기존 `exists`·`not_empty`·`eq`·`ne`·`contains`·`gt`·`lt` + **`gte`·`lte`·`one_of`**(D5.3의 가칭을 이 이름으로 확정).

| op | `needs_value` | `has_flags`(대소문자·공백 체크박스) | 값 검증 |
|---|---|---|---|
| `gte`/`lte` | ✓ | ✗ | `parse_finite` 통과 — gt/lt와 **같은 검사**, 오류 문구를 기호로 교체: `크기 비교 조건(>, <, ≥, ≤)의 비교값은 숫자여야 합니다`(기존 "크다·작다 조건의…" 대체) |
| `one_of` | ✓ | ✓ | 후보 ≥1개(§3.1 분해 결과) — 오류 `여러 값 중 하나(∈) 조건의 후보값을 하나 이상 입력해야 합니다`; 원문 ≤200자(기존 공통 상한) |

`ConditionSource::allows`: `Body`·`Header` = 전부. `Status` = `eq·ne·gt·lt·gte·lte·one_of`. `BodyText` = `contains·not_empty`(무변경). TS `OPS_BY_SOURCE`·`needsValue`·`hasFlags`·`conditionError`·`normalizeCondition`이 같은 표를 미러한다.

### 2.2 표시 전용 항목 `display_items` (D2.9–D2.12)

```rust
// config.rs — Condition과 같은 container-level #[serde(default)] + 수제 Default 이디엄
pub struct DisplayItem { pub step_id: String, pub source: DisplaySource, pub path: String }
pub enum DisplaySource { Body, Header, Status }   // snake_case; body_text 없음(본문 전체는 값이 아님)
pub const MAX_DISPLAY_ITEMS: usize = 2;
// PanelConfig에 추가 — 기존 저장 보드(필드 없음)는 container default로 빈 Vec
pub display_items: Vec<DisplayItem>,
```

- 순서 = 의미: `[0]` = 큰 글자, `[1]` = 작은 줄(D2.10).
- 검증(`validate_panel` 안, `validate_display_items`): 개수 ≤2 / `step_id` ULID / `Body`는 조건과 **같은** 경로 규칙(1~500자·`jsonpath_is_valid`·**`jsonpath_is_simple`** — 무인 반복 평가, controller CLAUDE.md 허용 문법 함정) / `Header`는 trim 후 1~200자 **+ 인증 헤더 거부**(아래) / `Status`는 `path`를 **비운다**(조건과 같은 정규화, 거부 아님). 오류 문구는 조건과 구별되게 "벽 표시 항목 …"으로 시작.
- **인증 헤더는 벽 표시 불가** `[Claude]`(D7.6 "공용 운영실 화면이라 인증 값은 가린다"와 같은 취지): 헤더 이름(대소문자 무시)이 `set-cookie`·`cookie`·`authorization`·`proxy-authorization`이면 서버 검증 거부(`벽 표시 항목에는 인증 헤더를 쓸 수 없습니다`) + 미리 실행의 `벽에 표시` 버튼 비활성(§5.4). 조건(실패 시에만 값 노출, ①b)은 무변경.
- **표시 항목의 스텝이 시나리오에 없어도 설정 오류가 아니다**(판정 무관 D2.12) — `condition_step_missing`에 넣지 않는다. 그 값이 `null`이 될 뿐이고 설정 화면이 `⚠ 스텝 없음`을 보인다.
- 중복 항목은 서버가 막지 않는다(무해). 설정 화면이 같은 대상 재추가를 막는다(§5.3).
- TS `PanelConfigSchema`에 `display_items: z.array(DisplayItemSchema)`(`.default()` 금지 — ui/CLAUDE.md), `newPanel()`에 `display_items: []`.

### 2.3 `CheckResult.display` + `/status` 최신만

```rust
pub struct CheckResult { /* 기존 at_ms, verdict, latency_ms, reason, detail */
    /// 표시 항목 값 — display_items와 같은 길이·순서(값 없음 = null). trace가 없으면 빈 Vec.
    pub display: Vec<Option<String>>,
}
```

- 항상 직렬화(빈 배열 포함). TS `CheckResultSchema.display: z.array(z.string().nullable())`.
- 채우는 곳 = `run_check`: `judge` 후 **trace가 있으면 verdict와 무관하게**(실패 칸에도 D2.8) `display_values(panel, &trace)`. 시간 초과·설정 오류처럼 trace가 없으면 빈 Vec. `judge`는 순수 판정으로 둔다(`display`는 빈 Vec으로 생성).
- 값 규칙: 그 `step_id`의 **마지막 실행** http 스텝 응답(조건과 같은 `rfind`)에서 §3.2/§3.3과 같은 추출. 스텝 미실행·응답 없음·경로 없음·본문 비JSON·본문 잘림 → `null`. 값이 있으면 `shown()`(제어/서식 문자 → 공백, 200자 `…`) 통과 — 벽에 나가는 사용자 값 규칙(①b) 그대로. 빈 문자열·JSON null은 `Some("")`로 두고 화면이 `—`로 그린다(§6.2).
- `build_panel_status`(api/monitor_boards.rs): 기존 "사유·detail은 최신 결과에만" 루프에서 **`display`도 비운다**(최신 외 `Vec::new()`) — `/status` 1초 폴링 크기 보호(칸 9 × 막대 300 × 값 2 × 200자).
- 미리 실행(`preview_check`)도 `run_check`라 `display`가 실리지만 **설정 화면은 쓰지 않는다**(§5.4 — 항목을 바꾸면 순서가 어긋나는 stale 문제).
- **설정 변경 직후 과도 구간**: `reconcile`은 칸 버퍼를 유지하므로(`supervisor.rs`) 항목을 추가·삭제·순서 변경한 직후 첫 새 점검이 끝날 때까지(≤ `timeout_seconds` + 주기) 최신 결과의 `display`는 **옛 길이·옛 순서**다. 화면 규칙: `display[i]`가 없으면(undefined) `—`. 옛 순서 값이 잠깐 보이는 것은 수용한다(다음 점검에서 자동 정정).
- **테스트 fixture 영향**: `CheckResultSchema.display`·`PanelConfigSchema.display_items`·`BoardConfigSchema.show_latency_stats`(§6.4)가 필수라 보드 fixture·`MonitorEditPage`의 새 보드 리터럴(`show_latency_stats: true`)·Rust `impl Default for BoardConfig`(`show_latency_stats: true` — container default는 `Default`가 줘야 동작)도 함께 바뀌고, 기존 RTL fixture(`MonitorEditPage`·`MonitorDisplayPage`(2)·`monitors.test.ts`·`LatencyBars.test.tsx` 등)와 Rust `CheckResult {…}` 리터럴(`supervisor.rs`·`api/monitor_boards.rs` 테스트)이 새 필드를 받아야 한다 — plan이 목록화.

## 3. 판정 (`crates/controller/src/monitor/check.rs`)

### 3.1 `one_of` 후보 분해

`value.split(',')` → 각 `trim()` → 빈 것 버림 = 후보 목록. 후보 안의 쉼표는 표현 불가(알려진 한계 — 코드 값 용도라 수용, D1.4 쉼표 방식). 통과 = 후보 중 하나라도 `eq`와 **같은 비교**로 같음: 실제 값이 JSON 숫자이고 후보가 `parse_finite` 통과면 수치 비교(`1` = `1.0`), 아니면 `normalize_cmp`(체크박스 `ignore_case`·`trim` 적용) 문자열 비교. TS `conditionError`는 "후보 0개"를 새 키 `condErrOneOf`로 막는다(§4).

### 3.2 `gte`/`lte`

`gt`/`lt`와 같은 경로(`parse_finite(text)`·`parse_finite(value)` 둘 다 Some일 때만, 아니면 실패) + `>=`/`<=`.

### 3.3 문자열로 감싼 JSON 풀기 (D3.1–D3.5)

**정의(Rust·TS 동일)**: 본문을 JSON으로 읽는다(실패 → 비JSON). 읽은 값이 문자열이면 그 문자열을 다시 JSON으로 읽기를 **최대 3번** 반복한다. 반복 중 객체/배열에 도달하면 **그것**을 본문 JSON으로 쓰고(풀린 겹 수 1~3), 도달하지 못하면(일반 문자열 `"hello"`, 숫자 문자열 `"12"`, 3겹 초과) **처음 읽은 값 그대로** 쓴다(풀린 겹 0, D3.3).

- Rust: `check.rs`에 `fn parse_body_json(body: &str) -> Option<serde_json::Value>`(풀린 결과) — 조건 `Body` 소스와 표시 항목 `Body` 소스가 공유. `REASON_BODY_NOT_JSON`은 첫 읽기 실패일 때만.
- **파싱 캐시 — 함수별 지역 캐시**: `eval_conditions`(`judge` 안)와 `display_values`가 각자 **스텝 trace 인덱스 단위 지연 캐시**를 둔다 → 한 점검에서 같은 응답 본문은 최대 2번 파싱(판정 1 + 표시 1)이고, 조건 개수에 비례하지 않는다. `judge` 시그니처는 바꾸지 않는다(순수 판정·기존 테스트 호출부 유지). 기존 코드는 조건마다 `serde_json::from_str`을 다시 부른다(`actual_value`) — 이 슬라이스에서 캐시 경유로 바꾼다.
- **기존 조건의 동작 변화(수용)**: 감싼 JSON 응답에서 루트 문자열 잎을 눌러 만든 `$` 경로 조건(값 = 감싼 문자열 전체)은 이제 풀린 객체/배열을 본다(문자열화 결과가 달라짐). 이 응답 형태에선 그 조건이 원래 쓸모없던 우회였으므로 수용하고 별도 이행은 하지 않는다.
- `BodyText`(`본문 전체 글자 포함`)는 **수신한 원문 그대로**를 본다(풀지 않음) — "본문 전체"는 받은 그대로의 글자라는 의미 유지. `[Claude]` 판단, §10.
- TS: `ui/src/monitor/` 에 `parseBodyJson(body: string): { value: unknown; unwrapped: number } | null` — 미리 실행 본문 보기(§5.4)가 쓴다.

### 3.4 기호 표기 — 벽 실패 사유 작은 줄 (D5.8)

`rule_label`을 기호로, `condition_detail` 서식을 `{대상} {기호}[ {비교값}][ · {스텝 이름}]`로 바꾼다(`{대상}` = 기존 `target_label` 무변경).

| op | 기호 | 비교값 표기 | 예 |
|---|---|---|---|
| eq / ne | `=` / `≠` | 원문(빈 값이면 `""`, 기존 규칙) | `resultCode = 0000 · 로그인` |
| gt / lt / gte / lte | `>` / `<` / `≥` / `≤` | 원문 | `data.count ≥ 1` |
| one_of | `∈` | `{후보1, 후보2}` — §3.1 분해 후보를 `", "`로 결합 | `resultCode ∈ {0000, 0020}` |
| contains | `글자 포함` | 원문 | `본문 전체 글자 포함 OK` |
| exists | `키 있음` | (없음) | `data.token 키 있음` |
| not_empty | `값 있음` | (없음) | `data.token 값 있음` |

- **연동 변경(필수)**: UI `display.ts` `reasonParts`의 `NOT_CONTAINED_HEAD = "본문 전체 · 포함 "`가 이 서식에 의존한다 → **`"본문 전체 글자 포함 "`로 동시 변경**(같은 task, 양쪽 테스트). 안 바꾸면 `"OK" 포함 안 됨` 큰 줄 렌더(①b D5)가 조용히 일반 detail 렌더로 떨어진다.
- 큰 줄(`reason`)의 실제 값·`값 없음`·`비어 있음`·`"…" 포함 안 됨` 규칙은 무변경.
- **대상 표기 통일**: UI `targetLabel`의 본문 경로 표기를 서버 `target_label`과 같게 바꾼다 — `condTargetBody` = 접두 `본문 ` **없이** 경로만(`resultCode`, `$[0]`→`[0]`, 루트 `$`는 `본문`). 헤더(`헤더 X`)·상태코드·본문 전체는 이미 같다. 이로써 설정 줄(`resultCode [≥] [1]`, US2)·목업 03·벽이 같은 말을 쓴다. `targetLabel`을 쓰는 aria(`+ 조건 (…)` → §5.4 `+ 추가 (…)`)도 따라 바뀐다.
- UI `conditionSummary`(설정 화면 조건 목록 한 줄) = `{대상} {기호}[ {비교값}] · {스텝 이름}` + 체크박스 표시(` · 대소문자 무시` 등) 유지. 서버 detail과 **스텝 이름 위치·대상·기호 서식이 같고**, 차이는 하나 — 서버는 http 스텝이 2개 이상일 때만 스텝 이름을 붙이고(`check.rs` `all.len() >= 2`), 설정 화면은 항상 붙인다(설정 중엔 어느 스텝인지 늘 필요 — 기존 동작 유지).

## 4. 문구 (`ui/src/i18n/ko.ts` `monitor`)

| 키 | 현재 | 바뀐 후 |
|---|---|---|
| `conditionsIntro` | 모두 만족해야 정상 · 시나리오 자체 판정에 더해서 | **아래 조건을 모두 만족하면 정상 (AND)** · 시나리오 자체 판정에 더해서 |
| `condOpOptions` (select 항목) | 같음/같지 않음/값이 있음/비어 있지 않음/포함/숫자 크다/숫자 작다 | `=` / `≠` / `키 있음 (null 허용)` / `값 있음 (null·빈값 아님)` / `글자 포함` / `>` / `<` + 신규 `≥` / `≤` / `∈ 여러 값 중 하나` |
| `condOpLabel` (요약·벽과 같은 기호) | 같음 … 보다 작음 | §3.4 표의 기호 열 |
| `condVolatileHint` | …'같음'은 매 점검 실패… | …`'='`은 매 점검 실패… |
| 신규 `condValueOneOfPlaceholder` | — | `0000, 0020` |
| 신규 `condErrOneOf` | — | 후보값을 하나 이상 입력하세요 |
| `condErrNumber` | 숫자를 입력하세요 | 유지(gte/lte도 사용) |
| `condTargetBody` | `본문 ${p}` | `${p}` (§3.4 대상 표기 통일) |
| `condAdd` | + 조건 | **+ 추가** (§5.4 선택 흐름) |
| `condAddAria` | `+ 조건 (${target})` | `+ 추가 (${target})` |
| `previewBodyClickHint` | 응답 본문 — 값을 누르면 조건을 만듭니다 | 응답 본문 — 값을 누르면 조건이나 벽 표시를 추가합니다 |
| 신규 `previewUnwrapped` | — | 문자열로 감싼 JSON을 풀어서 표시 중 |
| 신규 표시 항목 키 | — | §5.3·§5.4 문구(`벽에 표시` 영역 제목·안내·빈 상태·`① 큰 글자`/`② 작은 줄`·`순서 바꾸기`·삭제 aria·`조건으로 추가`/`벽에 표시` 버튼·비활성 사유 3종) |

`condOp` 레이블("규칙")·`condValue`("비교값")은 유지(aria). select 항목이 기호 한 글자뿐이라 스크린리더용으로 각 `<option>`에 `aria-label`/`title`로 말 표기(`같음`, `이상` …)를 붙인다 `[Claude]`.

## 5. 설정 화면 (`PanelEditor`·`ConditionRow`·`PreviewResult`)

### 5.1 조건 줄 `ConditionRow` (D5.2, D5.5)

- 순서 **대상 → 기호 select → 비교값 → (체크박스) → 추가/저장·취소** — 현재 DOM 순서와 같다(대상·select·값). 바뀌는 건 select 항목 문구(§4)와:
- `needsValue(op)`가 거짓(`exists`·`not_empty`)이면 비교값 입력칸을 **숨기지 않고** `disabled` + 값 `""` + placeholder `—`로 둔다(줄 모양 고정, D5.5). 현재는 렌더하지 않는다.
- `one_of`이면 비교값 placeholder `condValueOneOfPlaceholder`.
- select 폭은 가장 긴 항목(`값 있음 (null·빈값 아님)`)이 잘리지 않는 폭 — 라이브 실측으로 확정(`live-measurement-overrides-spec-constants`).

### 5.2 조건 목록 머리

`conditionsIntro` 새 문구(§4). 접힘 disclosure·`N개 설정됨` 힌트는 기존 그대로.

### 5.3 "벽에 표시" 영역 (D2.9–D2.11)

- `PanelEditor`의 성공 조건 fieldset **바로 아래**에 같은 이디엄의 접이식 fieldset `벽에 표시`(기본 접힘, 값이 있으면 `N개 설정됨` 힌트 — 기존 `condOpen` 패턴 복제, `ui-optional-sections-collapsible`).
- 펼치면: 안내 `판정과 무관 · 최대 2개 · 첫째는 큰 글자, 둘째는 작은 줄`, 항목 행 `① 큰 글자 {대상 표기} · {스텝 이름}` / `② 작은 줄 …` 각 행에 `🗑`(aria `표시 항목 N 삭제`) + 스텝이 시나리오에 없으면 `⚠ 스텝 없음`(조건과 같은 판정). 항목이 2개일 때만 목록 아래 **단일 버튼 `↕ 순서 바꾸기`**(두 항목 자리 교환 — 목업 03 그대로). 없으면 `미리 실행 결과에서 값을 눌러 벽에 표시할 값을 고릅니다`.
- `{대상 표기}` = 조건의 `targetLabel` 재사용(본문 경로·`헤더 X`·`상태코드`).

### 5.4 미리 실행 결과 (`PreviewResult`)

- **클릭 → 선택 (D2.11)**: 값 옆 버튼 `+ 조건` → **`+ 추가`**로 바꾸고, 누르면 그 자리에 두 버튼 `조건으로 추가` / `벽에 표시`를 보인다. `조건으로 추가` = 지금의 `ConditionRow`(create) 흐름 그대로. `벽에 표시` = 즉시 표시 항목 추가(편집 단계 없음) 후 닫힘. 대상별:
  - 본문 JSON 값(트리)·헤더·상태코드: 둘 다 가능.
  - `+ 본문 전체 포함 조건`(비JSON 본문): 조건만(표시 불가 — 본문 전체는 값이 아님).
  - `벽에 표시` 비활성 사유(3종): 표시 항목 2개 도달(`벽 표시는 최대 2개까지`) / 같은 스텝·대상·경로 항목이 이미 있음(`이미 벽에 표시 중`) / 인증 헤더(`set-cookie`·`cookie`·`authorization`·`proxy-authorization`, §2.2 — `인증 헤더는 벽에 표시할 수 없음`). 조건 10개 상한 사유(`condMax`)는 `조건으로 추가` 쪽에만.
- **감싼 JSON 풀기 (D3.2, D3.4)**: `PreviewResult`의 트리 판정(`isJsonBody`)과 `tree.render`가 쓰는 값을 §3.3 `parseBodyJson` 결과로 바꾼다. `BodyBlock`은 **수정하지 않는다** — 감싼 본문도 유효한 JSON이라 `BodyBlock`이 이미 `tree.render(parsed)`를 부르고(`BodyBlock.tsx` `JSON.parse(body)` 성공 경로), `PreviewResult`의 `render`가 넘겨받은 값 대신 자기 `parseBodyJson` 결과(풀린 값)로 `JsonValueTree`를 그린다. 전체 보기 모달도 같은 `render`라 동일, "원본" 보기는 받은 그대로의 본문. `unwrapped ≥ 1`이면 본문 제목 줄(`previewBodyClickHint`) 옆에 `previewUnwrapped` 안내. 트리에서 누른 경로(`$.code`)는 **풀린 값 기준**이라 서버 판정(§3.3)과 일치한다.
- 미리 실행 결과의 `result.display`는 **그리지 않는다** — 항목을 추가·삭제·순서 변경하면 실행 시점 순서와 어긋나고(stale) 클라엔 재계산할 JSONPath 평가기가 없다. 목업에도 없다(①b D9).

## 6. 벽 화면 (`MonitorPanel`·`PanelProbe`·`LatencyBars`·`logic.ts`·`display.ts`)

### 6.1 상태별 배치 (목업 `02` 1번 보드가 정본)

"항목 칸" = `display_items`가 1개 이상인 칸.

| 상태 | 항목 칸 | 항목 없는 칸 |
|---|---|---|
| `ok`·`slow` | 제목·상태 줄 아래 **반반 줄**(D2.3): 왼쪽 = `display[0]` 큰 글자 + 아래 `display[1]` 작은 줄(둘 다 **왼쪽 정렬**, D2.2) / 오른쪽 = 현재 응답 속도(오른쪽 정렬) + 아래 평균·최대 줄 | 지금처럼 응답 속도 전체 너비 + 아래 평균·최대 줄(D2.7) |
| `fail` | 위에서부터 **실패 사유 큰 줄(전체 너비) → 사유 작은 줄 → 연속 실패 줄**(셋 다 지금 그대로·지금 순서) → **표시 값 한 줄**(`{v0}` 굵게 + 공백 + `{v1}`, 왼쪽 정렬, 넘치면 `…`) → **평균·최대 줄**(D2.8). 표시 값 한 줄은 그릴 값이 하나도 없으면(빈 배열, 또는 모든 값이 null/`""`) **줄째 생략**(`— —` 금지) | 지금 그대로 + 연속 실패 줄 아래 평균·최대 줄 |
| `config_error`·`stale`·`stale_off`·`pending` | 지금 그대로(표시 값·평균/최대 **없음**) | 지금 그대로 |

- 표시 값은 `status.results`의 **최신 결과**의 `display`(D2.13 — 서버는 최신에만 싣는다 §2.3). `null`·`""`·**인덱스 없음(undefined — 설정 변경 직후 과도 구간 §2.3)** → `—`(D2.12). 칸의 항목이 1개면 왼쪽은 큰 글자 한 줄만. "항목 칸" 여부는 **현재 설정**(`display_items.length`)으로 정한다.
- 반반 줄 = `grid-template-columns: minmax(0,1fr) minmax(0,1fr)`, `column-gap` 3cqw(목업 값). 실패 칸·항목 없는 칸은 반반이 아니다.
- 색(목업 v2 값을 토큰으로 고정): 오른쪽 응답 속도 = 기존 `bigColor` 규칙(정상 `COLOR.text`, 느림 = 기준선 색). 왼쪽 `display[0]` = **항상 `COLOR.text`**(느림에도 기준선 색 아님 — 상태색은 응답 속도와 상태 라벨이 맡는다). `display[1]`·실패 칸 표시 값 줄의 `{v1}` = 신규 `COLOR.soft = "#cbd5e1"`(목업 메시지 색). 평균·최대 라벨 = `COLOR.muted`, 숫자 = `COLOR.text`. **A(fill) 방식은 전부 `ink`**(기존 `contrastText` 단일 대비색 원칙).
- C(focus) 방식: 큰 칸은 `MonitorPanel`이라 위 규칙을 그대로 따르고(사건 배율), **띠(`StripCard`)는 무변경**.

### 6.2 글자 크기·맞춤 (①a §7.3 유지 — 배율은 설정으로만 고정)

- `PANEL_TEXT`에 비율 추가 `[Claude]`(목업 v2 값): **`splitBig: 11.2`**(반반 줄의 왼쪽 큰 값·오른쪽 응답 속도 — 목업 v2 "지금의 약 60%", D2.6), **`stats: 5.4`**(평균·최대 줄). 작은 줄(`display[1]`)과 실패 칸의 표시 값 한 줄은 기존 `step: 6.4`.
- **맞춤 원칙**: 설정만으로 정해지는 최악 폭은 프로브가 재서 배율에 반영하고, 사용자 값(표시 값)은 측정하지 않고 `…`로 자른다 — 실패 사유와 같은 원칙(장애 중 배율 불변).
- **반반 줄 전용 배율 `--split-fit` (기존 `--reason-fit`과 같은 방식)**: 반반 오른쪽(응답 속도·평균/최대)은 보드 공통 `--fit`에 넣지 않는다. 넣으면 **항목을 켠 칸 하나 때문에 9칸 전부의 제목·상태 글자가 작아진다**(`--fit`은 보드 단일 — 30초 × xlarge에서 약 0.7) — D2.6이 수용한 건 "항목을 켠 칸의 큰 숫자 ≈ 60%"뿐이다. 그래서:
  - 항목 칸 프로브의 텍스트 블록에 반반 줄을 실제와 같은 구조로 넣고, 오른쪽 두 줄 = `formatMs(timeout_seconds*1000)`(splitBig) · 평균/최대 최악 문구(`평균 {T} 최대 {T}`, `T` = 시간 초과 ms, §6.3 서식, stats)에 **`data-split-probe`**를 단다(`data-fit-line` 아님 → `widthNeed`에서 제외). `useBoxMeasure`가 `reasonNeed`처럼 `splitNeed = min(box/natural × 0.98)`를 보고하고, `useScaleSearch`가 `reasonFit`과 같은 방식으로 **`splitFit = min(1, 모든 프로브의 splitNeed)`**를 낸다(검색 인스턴스별 — 일반·C 사건 배율 각각).
  - 실제 반반 줄 **네 줄 모두**(왼쪽 큰 값·작은 줄, 오른쪽 응답 속도·평균/최대) 글자 크기 = `calc(panelFont(비율) * var(--split-fit, 1))` — 왼쪽 큰 값과 오른쪽 응답 속도가 목업처럼 같은 크기로 보이게. 왼쪽은 측정에 참여하지 않고 넘치면 `…`.
  - 프로브 왼쪽 = 항목 수만큼 **자리 채움 줄**(1줄째 splitBig·`line-height` 1.18 = `BigValueLine`과 같음, 2줄째 step 6.4·실제 작은 줄과 같은 `line-height`, 투명, 내용 `"\u00a0"(이스케이프 표기 — 일반 공백 금지)` — 빈 truncate 줄은 줄 상자 높이가 0이라 높이가 안 잡힌다) — 텍스트 블록 높이(`textH` → 세로 배율·그래프 자리)만 맞추고 폭 측정 제외. 프로브 오른쪽 두 줄은 reason 프로브처럼 `whitespace-nowrap overflow-hidden`(그래야 `scrollWidth`가 자연 폭).
  - `PanelMeasure.splitNeed` 추가 → `probeReport`·`StripCardProbe` 보고 리터럴(`splitNeed: Infinity`)·`MonitorPanel`의 `splitFit` prop(`--reason-fit`처럼 상자에 `--split-fit`)까지 배선. C 사건(incident) 검색도 `splitFit`을 내지만 C 큰 칸은 실패 칸뿐이라 반반 줄을 그리지 않아 **쓰이지 않는다**(무해 — 사건 프로브에 반반 줄이 들어가 사건 `--fit`이 약간 보수적이 되는 것도 기존 "시간 초과 ms 줄" 보수성과 같은 결).
  - 프로브 텍스트 높이는 `--split-fit` 미적용 크기로 재므로 실제보다 같거나 크다(보수적 — 그래프 자리가 모자라 잘리는 일 없음).
- **평균·최대 줄(모든 `ok`/`slow`/`fail` 칸에 추가되는 고정 줄)**: 항목 없는 칸 프로브에도 큰 값 줄 아래 평균·최대 최악 문구 줄(전체 너비, stats 비율, `data-fit-line`)을 넣는다 → 텍스트 블록이 그 줄만큼 높아져 **기존 보드도 업그레이드 후 그래프가 그 줄 높이만큼 낮아지거나 보드 배율이 약간 줄 수 있다** — 목업 1번 보드(전 칸에 평균·최대)를 사용자가 채택했으므로 수용(§10).
- 실패 칸의 표시 값 한 줄은 프로브에 넣지 않는다 — 연속 실패 줄처럼 그래프 자리를 가져가는 **실시간 줄**(①a §7.3의 "실시간 줄은 배율에 닿지 않고 그 칸의 그래프 자리를 가져간다" 원칙).
- 왼쪽 큰 값·작은 줄은 `FitLine`이 아니다(사용자 값이 배율을 흔들면 안 됨) — `truncate`.
- **실제 평균·최대 줄은 `FitLine`이 아니라** 라벨(muted)·숫자(굵게) span을 담은 `truncate` div다(`FitLine`은 `text: string`만 받는다). 최악 폭 측정은 프로브의 평문 줄이 맡는다.
- **배율 재측정 키**: `MonitorDisplayPage`의 `scaleKey`(현재 `id|title|timeout_seconds`)에 **`display_items.length`**를 추가한다 — 벽이 켜진 채 항목을 추가·삭제하면 프로브 구조(반반 여부·왼쪽 줄 수)가 바뀌는데 키가 그대로면 검색이 `done`인 채 옛 배율이 남는다(`useScaleSearch.report`는 현재 후보 외 보고를 무시). RTL로 키 변화 → 재검색 단언.

### 6.3 평균·최대 (D2.4, D2.5)

- 대상 = `status.results`(서버가 이미 `bar_count`로 자른 = 화면 막대 구간) 중 `verdict === "ok"` 이고 `latency_ms !== null`(느림 포함, 실패·설정 오류 제외).
- `avg = Math.round(평균)`, `max = 최댓값`. 서식 `평균 {avg} 최대 {max}` — 숫자는 `toLocaleString("en-US")`(**천 단위 쉼표 — 사용자 확정**, `formatMs`와 같은 규칙), 단위 없음(바로 위 큰 값이 `ms`), 숫자 굵게·라벨 muted, 라벨-숫자 사이 공백 1칸·항목 사이 넓은 간격(목업 v2). 오른쪽 정렬.
- 대상이 0개면 줄을 그리지 않는다(빈 자리도 두지 않음).
- 순수 함수 `latencyStats(results): { avg: number; max: number } | null`(`logic.ts`) + 단위 테스트.

### 6.4 평균·최대 켜기/끄기 (D2.14–D2.16)

- 설정: `BoardConfig.show_latency_stats: bool`(container default **true** — 기존 저장 보드도 켜짐). TS `BoardConfigSchema`에 필수 boolean(`.default()` 금지).
- 끄면 평균·최대 줄을 **실제 칸과 프로브 모두에서** 그리지 않는다 → **항목 없는 칸**은 그래프가 지금(이 슬라이스 전) 높이로 돌아옴(항목 칸은 반반 줄이 남으므로 "이전 높이"가 없다 — 평균·최대 줄 높이만큼만 회복). `scaleKey`에 이 값을 넣는다(켜고 끄면 프로브 구조가 바뀜 — §6.2 키 규칙과 같은 이유).
- 조작: 보드 화면 **창 모드 도구 줄**(`전체화면`·`설정으로` 옆)의 토글 버튼 `평균·최대`(`aria-pressed`). 전체화면엔 도구 줄이 없으므로 창 모드에서 켜고 끈 뒤 전체화면(기존 흐름).
- 저장: **전용 엔드포인트 `PUT /api/monitor-boards/{id}/latency-stats`**, 본문 `{ "show": bool }` → 응답 = 기존 보드 응답(`BoardResponse`). 서버는 `config_json`의 이 필드만 **단일 원자 SQL**로 바꾸고 `updated_at`을 올린다: `UPDATE monitor_boards SET config_json = json_set(config_json, '$.show_latency_stats', json(?)), updated_at = ? WHERE id = ?`(바인드 `"true"`/`"false"`; 키가 없는 옛 행엔 삽입) → 영향 행 0이면 404, 이후 행을 다시 읽어 응답. **읽고-고쳐-쓰기 금지** — 토글이 옛 config를 읽은 사이 설정 화면 저장(+reconcile)이 끼면 토글이 옛 칸 목록을 되써서 DB(옛 칸)와 감독자(새 칸)가 어긋나고 사용자 칸 편집이 오류 없이 사라진다. SQLite JSON 함수는 sqlx `sqlite` 번들(libsqlite3-sys 0.30.1)에 내장 — 통합 테스트가 실제로 증명. **`reconcile`을 부르지 않는다** — 기존 `PUT /{id}`(update)는 `reconcile`로 칸 점검 task를 전부 멈췄다 다시 띄우고 `started_at_ms`를 새로 찍는다(`supervisor.rs` `reconcile_slot`). 화면 표시 옵션 하나에 점검 재시작·확인 불가 판정 기준 변경이 따라오면 안 된다(감독자는 `row.config.panels`만 읽으므로 보드 수준 표시 플래그는 reconcile 불필요). 보드 없음 404. `config_json`이 손상돼 JSON으로 안 읽히는 행이면 `json_set`이 SQL 오류 → 500(손상 행 한정이라 수용 — 일반 GET은 기본 config 폴백). `api/monitor_boards.rs` 모듈 doc의 "쓰기 = DB 쓰기 → reconcile" 불변식에 **이 핸들러가 의도된 예외**라는 주석을 추가하고, controller `CLAUDE.md`에 한 줄(표시 전용 필드는 reconcile 없이 원자 갱신 — 칸 목록·점검 설정 필드에 이 경로를 쓰지 말 것)을 남긴다. 벽은 기존 `board_updated_at` 변화 감지로 보드를 다시 읽어 반영(이미 있는 경로 — plan이 확인).
- 설정 화면은 이 값을 표시·편집하지 않지만 저장 시 읽어 온 값을 그대로 돌려보낸다(round-trip). 설정 화면을 열어 둔 채 벽에서 토글한 뒤 설정 화면에서 저장하면 옛 값으로 덮인다 — 보드 하나에 화면 하나 운영(사용자 확인)이라 수용.

### 6.5 막대 방향 (D4.1, D4.2)

`barSlots`: 결과가 `barCount`보다 적으면 **빈 칸(null)을 앞(왼쪽)에** 채운다 — 최신이 항상 마지막(오른쪽) 칸. 넘치면 오래된 것부터 버림(무변경). 시간축 `N분 전`(왼쪽)·`지금`(오른쪽)은 이미 이 방향이라 무변경(D4.2 확인). JSDoc `filled from the left` 정정.

## 7. 극단값 (①a §7.3 + 메모리 `live-verify-extreme-values-readable`)

라이브에서 rect 교차로 실측(겹침·잘림 금지, `…`는 의도된 잘림만):
- 칸 9개 × 글자 크기 `xlarge` × 시간 제한 30초(`30,000 ms` — 반반 오른쪽 최악) × 표시 값 2개 각 200자 × 긴 제목(40자).
- 실패 칸: 긴 실패 사유 + 스텝 이름 + 연속 실패 + 표시 값 한 줄 동시.
- A(fill)·B(border)·C(focus 1·2개 실패) 각각.
- 설정 화면: `∈` 후보 200자, select 가장 긴 항목.

## 8. 테스트·검증

- **Rust**(`config.rs`·`check.rs`·`api/monitor_boards.rs` 인라인 테스트): 새 op 3종 통과/실패 표(숫자 동치 `1`=`1.0`, `ignore_case`/`trim`, 후보 공백·빈 후보), `allows` 표, 검증 오류(후보 0, gte 비숫자, 표시 항목 3개·잘못된 경로·`jsonpath_is_simple` 위반), 감싼 JSON 0·1·2·3·4겹/일반 문자열/숫자 문자열, `BodyText`는 원문, 표시 값(스텝 미실행·경로 없음·실패 verdict에도 채움·trace 없음 빈 Vec·200자 `shown`), 표시 항목 스텝 부재가 설정 오류 **아님**, 새 detail 서식 표, `build_panel_status`가 최신 외 `display` 비움, 기존 저장 JSON(필드 없음) 역직렬화 = 빈 `display_items`·`show_latency_stats = true`, 인증 헤더 표시 항목 거부.
- **통합 테스트**(`crates/controller/tests/monitor_boards_api_test.rs` — 이미 `started_at_ms`를 단언하는 파일): `PUT …/latency-stats`가 필드만 바꾸고(칸 목록 불변) `updated_at`을 올리며 **`reconcile`을 부르지 않음** — 시작 후 ≥5ms 대기 뒤 토글하고 `/status`의 `started_at_ms` 불변 단언(ms 해상도라 대기 없으면 reconcile해도 같은 값일 수 있음). **이빨 실증**: 핸들러에 일부러 reconcile을 넣으면 RED. 키 없는 옛 행에도 `json_set` 삽입 동작, 없는 보드 404.
- **UI 추가**: 도구 줄 `평균·최대` 토글(`aria-pressed`, 호출 후 끔/켬 반영), 꺼짐이면 실제 칸·프로브 모두 평균·최대 줄 없음, `scaleKey`에 `display_items.length`·`show_latency_stats` 포함.
- **UI**(vitest/RTL): `parseBodyJson` 표(Rust와 같은 케이스), `latencyStats`, `barSlots` 오른쪽 정렬, `reasonParts` 새 헤드, `conditionSummary`·`conditionError`·`OPS_BY_SOURCE`, `ConditionRow` 비활성 입력칸, 미리 실행 `+ 추가` → 두 선택·비활성 사유·풀기 안내, 표시 항목 순서 바꾸기/삭제, `MonitorPanel` 상태별 배치 표(§6.1)·`—`.
- **회귀 가드 테스트는 고의 회귀 → RED → 원복 → GREEN 실증**(메모리 `plan-mandated-vacuous-tests`) — 특히 `NOT_CONTAINED_HEAD` 연동, `barSlots`, 최신-외 `display` 비움.
- **라이브(필수 — run/report 경로는 아니지만 판정·`/status` 와이어 변경)** `/live-verify`: US1~US5 척추 행 + §7 극단값. 감싼 JSON은 응답기가 `"{\"code\":1,\"message\":\"정상\"}"`를 돌려주게. 컴포넌트가 마운트되는 **모든 화면**(보드 창 모드·전체화면, A/B/C, C 큰 칸) + 설정 화면 신규/기존 보드(메모리 `live-verify-all-mount-paths`).
- **보안 표면**: 본문 파싱·값 표시 경로 변경 — `finish-slice` §0 grep 결과로 `security-reviewer` 필요 여부를 정한다(grep N/A여도 판단 재검토: 메모리 `security-gate-judgment-override`). 새 sink 없음 예상(표시 값은 ①b 조건 값과 같은 `shown` 경로·같은 벽). 단 노출 **시점**이 넓어진다(조건 값은 실패 때만 → 표시 값은 상시). 인증 헤더 4종 거부(D2.19)는 **보안 경계가 아니라 가드레일**이다 — 본문 `$.token`·`x-api-key` 같은 값은 사용자가 고르면 벽에 나간다(사용자가 명시 선택한 값 = D2.9 의도). 이 잔여 위험은 수용으로 기록한다.

## 9. ADR-0053 보완 절 (구현 슬라이스에서 추가)

`## 보완 — ops-monitor-polish (2026-10-28)`: ①b는 "벽엔 고정 문구만"에 **조건 실패 값** 예외를 뒀다. 이번엔 **사용자가 고른 표시 전용 값이 정상일 때도** 벽에 나간다(칸당 ≤2, `shown` 정규화·200자, `/status`는 최신 결과에만). 평균·최대는 보관 구조 변경 없이 화면 계산(원칙 "느림은 화면 계산" 확장).

## 10. `[Claude]` 판단 목록 — 사용자 확인 결과는 `00-decisions.md` 각 절(D2.14–D2.21·D3.5–D3.6)에 기록

1. op 와이어 이름 `gte`·`lte`·`one_of`(D5.3 가칭 확정).
2. `one_of` 후보는 항상 trim, 빈 후보 버림, 체크박스(`ignore_case`·`trim`)는 `=`과 같이 적용. 후보 안 쉼표 불가(알려진 한계).
3. 감싼 JSON 최대 **3겹**(D3.5의 상한값).
4. `글자 포함`(본문 전체)은 감싼 JSON을 **풀지 않은 원문**에서 찾는다.
5. 표시 항목 대상 = 본문 값·헤더·상태코드(본문 전체 제외). **인증 헤더(`set-cookie`·`cookie`·`authorization`·`proxy-authorization`)는 표시 불가**(D7.6 취지).
6. 표시 항목 스텝이 없어져도 설정 오류 아님(값 `—` + 설정 화면 `⚠`).
7. 빈 문자열·JSON null·설정 변경 직후 없는 인덱스 표시 값은 `—`. 설정 변경 직후 한 점검 동안 옛 순서 값이 보일 수 있음(수용).
8. `config_error`·`stale`·`pending` 칸엔 표시 값·평균/최대 없음. 실패 칸 표시 값 줄은 값이 하나도 없으면 생략.
9. 실패 칸에서도 평균·최대 표시(목업 회원 조회·배당률).
10. 글자 비율 `splitBig 11.2`·`stats 5.4`(목업 v2). 반반 줄은 **자기 전용 배율**(`--split-fit`)로 맞춰 다른 칸 글자에 영향 없음. 평균·최대 줄이 모든 칸에 생기므로 기존 보드도 그래프가 그 줄 높이만큼 낮아질 수 있음(목업 채택안 그대로라 수용).
11. ~~평균·최대 숫자 서식~~ → **사용자 확정: 쉼표**(`2,410`) — D2.14.
12. 설정 화면 `벽에 표시` 영역은 성공 조건 바로 아래 접이식. 순서 바꾸기는 목업대로 단일 `↕` 버튼.
13. 기호 select 항목에 스크린리더용 말 표기.
14. C 방식 띠는 무변경.
15. 설정 화면 조건 대상 표기에서 `본문 ` 접두 제거(벽·목업 03과 통일), 값 옆 버튼 `+ 조건` → `+ 추가`(누르면 `조건으로 추가`/`벽에 표시`).
16. 감싼 JSON 응답에서 루트 문자열(`$`)로 만든 기존 조건은 이제 풀린 값을 봄(수용, 이행 없음).
17. 미리 실행 결과에 벽 표시 값 미리보기는 **넣지 않음**(항목 편집 시 어긋남 + 목업에 없음).
18. 평균·최대 켜기/끄기 저장은 전용 엔드포인트(점검 재시작 없음) — §6.4, D2.16.
