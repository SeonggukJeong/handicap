# 운영실 모니터 ①b — 클릭으로 성공 조건 + 화면 방식 A·C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모니터 칸 설정에 "미리 실행 결과에서 값을 눌러 만드는 성공 조건"을 더하고(시나리오 무변경), 보드 화면 방식 A(신호등)·C(실패만 크게)를 기존 B 옆에 추가한다.

**Architecture:** 조건은 controller `monitor/` 안에서만 평가한다 — `judge`가 시나리오 판정 통과 자리에서 조건을 평가하고, 실패면 `reason`(실제 값)+`detail`(경로·규칙·스텝)을 싣는다. 엔진은 JSONPath/문자열화 헬퍼만 공개한다. UI는 에디터의 응답 트리·본문 블록·헤더 표를 공용 컴포넌트로 추출한 뒤, 모니터 미리 실행 결과에서 그것을 조건용으로 재사용한다. A·C는 전시 화면 표시 계층만 바꾸며, C의 글자 배율은 가능한 모든 C 배치를 설정 시점에 미리 재는 별도 탐색 그룹으로 고정한다.

**Tech Stack:** Rust(axum, serde, serde_json_path[엔진만], wiremock), React+TS(Zod, React Query, Tailwind container queries, vitest+RTL).

**Spec:** `docs/superpowers/specs/2026-10-22-ops-monitor-1b-design.md`(spec-plan-reviewer clean APPROVE 4라운드) · 목업 정본 `docs/superpowers/specs/2026-10-22-ops-monitor-1b-mockups/`(01 조건 만들기 · 02 조건 사유 · 03 A · 04 C 세 장면) · ①a spec §7.3(극단값 표시 정책 — 유지). **목업에 없는 화면·배치를 만들지 않는다**(`[사용자]` D9).

개정: r2 — plan 리뷰 1차(APPROVE-WITH-FIXES: `addCondition` 미사용 커밋 차단·Task 10 공허 테스트 3건 등 12건) 반영. r3 — 2차(`cond_flags` 기대값 오류·`React.memo`의 `reasonFit` 회귀·이빨 실증 ② 공허 등 7건) 반영, spec-plan-reviewer clean APPROVE(3라운드).

REVIEW-GATE: APPROVED

## Global Constraints

- **와이어 enum 문자열 정확히**: `display_style` `"fill"|"border"|"focus"`(기본 `"border"`) · `source` `"body"|"header"|"status"|"body_text"` · `op` `"exists"|"not_empty"|"eq"|"ne"|"contains"|"gt"|"lt"`. Rust enum은 `#[serde(rename_all = "snake_case")]`(`BodyText`→`"body_text"`, `NotEmpty`→`"not_empty"`).
- **저장 형태**(spec §3): `BoardConfig.display_style`, `PanelConfig.conditions: Vec<Condition>`, `Condition { step_id, source, path, op, value, ignore_case: bool, trim: bool }` — 셋 다 컨테이너 `#[serde(default)]` + 손 `Default`(①a F1 방식, migration 없음). `Condition::default()` = `source: Body, op: Exists`, 나머지 빈 값/`false`.
- **source별 허용 op**: `body`·`header` = 7종 전부 / `status` = `eq`·`ne`·`gt`·`lt` / `body_text` = `contains`·`not_empty`.
- **`CheckResult.detail: Option<String>`** — 항상 직렬화(`skip_serializing_if` 금지), UI Zod `.nullable()`. 조건 판정 결과(§4의 2·3·4·5 단계 + "조건 기준 스텝 없음")에만 `Some`, 그 외 항상 `None`. 조건 결과의 `reason`엔 ` · {스텝 이름}` 접미를 붙이지 않는다.
- **서버 고정 문구**(`check.rs` 상수, byte-exact): `조건 기준 스텝 없음` · `조건 스텝 미실행` · `본문이 JSON 아님` · `응답 본문이 너무 큼` · `값 없음` · `비어 있음` · 포함 실패 `"{비교값}" 포함 안 됨`. 규칙 문구(detail): `값이 있음` · `비어 있지 않음` · `같음` · `같지 않음` · `포함` · `보다 큼` · `보다 작음`. 대상 문구(detail): body = JSONPath에서 선두 `$.` 제거(`$`만이면 `본문`, `$[`로 시작하면 `$`만 제거), header = `헤더 {이름}`, status = `상태코드`, body_text = `본문 전체`.
- **`detail` 형식**: `{대상} · {규칙}[ {비교값}][ · {스텝 이름}]` — 비교값은 eq/ne/contains/gt/lt에서만(빈 비교값이면 `""` 두 글자), 스텝 이름은 시나리오에 **정의된** http 스텝이 2개 이상일 때만, "조건 기준 스텝 없음"이면 스텝 부분 없음.
- **서버 상한·정규화**(조건 결과의 `reason`·`detail`에만): 제어 문자(`char::is_control`)·줄/문단 구분자 U+2028·U+2029(Cc도 Cf도 아니라 따로 지정)·Cf 코드포인트(Task 2 표)를 공백 하나로 바꾼 뒤 200자(char) 초과면 앞 199자 + `…`. 포함 실패는 비교값을 먼저 줄여(`"` + 비교값 + `" 포함 안 됨`이 200자 이하가 되게, 비교값 꼬리에 `…`) 꼬리 `" 포함 안 됨`이 항상 남는다.
- **저장 검증 400 문구**(`config.rs`, `validate_panel` 공유라 `preview-check`에도 적용): `성공 조건은 최대 10개까지 설정할 수 있습니다` · `조건 스텝 id가 올바른 ULID 형식이 아닙니다` · `이 대상에 쓸 수 없는 조건 규칙입니다` · `본문 경로는 1~500자여야 합니다` · `본문 경로(JSONPath)가 올바르지 않습니다` · `헤더 이름은 1~200자여야 합니다` · `비교값은 200자 이하여야 합니다` · `포함 조건의 비교값을 입력해야 합니다` · `크다·작다 조건의 비교값은 숫자여야 합니다`.
- **`/status`**: 칸마다 최신 결과 1개에만 `reason`·`detail`, 그 이전 결과는 둘 다 `null`(링버퍼는 그대로).
- **A 색**: 정상 `#15803d` · 느림 = 넘은 기준선 색(`barColor`) · 실패 `#b91c1c` · 설정 오류·확인 불가(`stale`·`stale_off`) `#475569` · 확인 중(`pending`) = B 렌더 그대로. 글자 = 배경 대비색 `#ffffff` 또는 `#0b0f14`(WCAG 대비비 큰 쪽, 동률이면 흰색).
- **C 배치**: 실패(`fail`) 칸 f개, 0 또는 n이면 B와 같은 그리드·같은 배율. 1≤f<n이면 큰 영역 = 실패 칸 `gridFor(f)`, 띠 = 나머지 칸 한 줄/한 열 같은 크기 카드(줄바꿈·스크롤 없음). f=1 → 띠 오른쪽 세로 열(`3fr 1fr` 열), f≥2 → 띠 아래 가로 줄(`3fr 1fr` 행). 순서 = 칸 추가 순서. 애니메이션·히스테리시스 없음.
- **배율 키에 결과 금지**(ui CLAUDE.md 운영 모니터 함정): 모든 배율 탐색 키 = 뷰포트·전체화면 여부·font_scale·display_style·칸 id/제목/제한 시간뿐.
- **UI 문구는 `ko.monitor.*` 경유**(ADR-0035, aria-label 포함). 새 키는 Task 5~9 각 task가 자기 것을 추가: `displayStyle: "화면 방식"`, `displayStyleOptions: { fill: "신호등 (칸 전체 색)", border: "테두리 (기본)", focus: "실패만 크게" }`, `conditions: "성공 조건"`, `conditionsIntro: "모두 만족해야 정상 · 시나리오 자체 판정에 더해서"`, `conditionsEmpty: "미리 실행 결과에서 값을 눌러 조건을 만듭니다"`, `condAdd: "+ 조건"`, `condAddBodyText: "+ 본문 전체 포함 조건"`, `condAddAria: (target: string) => \`+ 조건 (${target})\``(가시 라벨 `+ 조건`을 접근명에 포함 — WCAG 2.5.3), `condOp: "규칙"`, `condOpOptions: { eq: "같음", ne: "같지 않음", exists: "값이 있음", not_empty: "비어 있지 않음", contains: "포함", gt: "숫자 크다", lt: "숫자 작다" }`(select 표시 — 목업 01), `condOpLabel: { eq: "같음", ne: "같지 않음", exists: "값이 있음", not_empty: "비어 있지 않음", contains: "포함", gt: "보다 큼", lt: "보다 작음" }`(요약 행 — 서버 detail과 같은 말), `condValue: "비교값"`, `condPath: "대상 경로"`, `condIgnoreCase: "대소문자 무시"`, `condTrim: "앞뒤 공백 무시"`, `condConfirm: "추가"`, `condSave: "저장"`, `condCancel: "취소"`, `condVolatileHint: "매번 바뀌는 값이면 '같음'은 매 점검 실패하고 그 값이 벽에 표시됩니다"`, `condStepGone: "⚠ 스텝 없음"`, `condEdit: (n: number) => \`조건 ${n} 편집\``, `condRemove: (n: number) => \`조건 ${n} 삭제\``, `condMax: "조건은 최대 10개까지 추가할 수 있습니다"`, `condErrValue: "비교값을 입력하세요"`, `condErrNumber: "숫자를 입력하세요"`, `condErrTooLong: "비교값은 200자 이하여야 합니다"`, `condErrPath: "대상 경로를 입력하세요"`, `condTargetBody: (p: string) => \`본문 ${p}\``, `condTargetBodyRoot: "본문"`, `condTargetHeader: (n: string) => \`헤더 ${n}\``, `condTargetStatus: "상태코드"`, `condTargetBodyText: "본문 전체"`, `previewHeaders: "응답 헤더"`, `previewBodyClickHint: "응답 본문 — 값을 누르면 조건을 만듭니다"`, `previewOpenFullCondition: "전체 보기·조건"`. (요약 행의 body 대상은 목업 01대로 `본문 {경로}` — 서버 detail의 `{경로}`와 다르다.)
- Rust: `cargo fmt`, `clippy -D warnings`(2-arm `match … _ => {}` 대신 `if let`). UI: `pnpm lint; echo exit=$?` · `pnpm test; echo exit=$?` · `pnpm build; echo exit=$?` — 게이트 판정에 파이프 금지. `pnpm test <파일명>`(`--` 없이)로 단일 파일.
- **`ui/src` 편집 전 테스트 파일부터**(tdd-guard). 새 응답 스키마 필드는 required → **그 필드를 추가하는 task가 기존 RTL fixture를 같은 커밋에서 갱신**(아래 각 task의 fixture 목록; 확인 `grep -rln "graph_max_ms\|latency_ms" ui/src --include='*.test.tsx' --include='*.test.ts'`).

## Review Focus

1. **조건을 걸어 둔 스텝을 나중에 시나리오에서 지움** — 요청을 보내지 않고 `⚠ 설정 오류` "조건 기준 스텝 없음"(작은 줄 `{대상} · {규칙}`), 설정 화면 행엔 `⚠ 스텝 없음`, 저장은 막지 않음 → Task 2 `run_check_condition_step_missing_sends_nothing`(wiremock `expect(0)`), Task 5 `condition_row_marks_missing_step`.
2. **①a 시절 저장된 보드를 그대로 엶·재저장** — 새 키가 없어도 읽히고(`conditions: []`, `display_style: "border"`), UI가 다시 저장해도 조건이 사라지지 않음 → Task 1 `defaults_fill_missing_fields` 확장, Task 3 `legacy_board_row_loads_with_defaults`, Task 8 `resave_keeps_conditions_and_display_style`.
3. **값에 한글·이모지·양방향 제어·줄바꿈이 섞이고 200자를 넘음** — 문자 경계에서 잘리고 위장 문자는 공백, 꼬리 `…` → Task 2 `shown_cuts_at_char_boundary_with_ellipsis`, `shown_replaces_cf_and_controls`.
4. **헤더 이름 대소문자가 응답과 다름**(`Content-Type` 조건 vs trace의 `content-type`) — 통과 → Task 2 `header_lookup_ignores_case`.
5. **켜 둔 전시 화면에서 화면 방식을 바꿈 / C 장애 중 실패 칸 수가 1↔2로 바뀜** — 설정 재조회 뒤 수 초 안에 반영, 장애 배율은 그대로 → Task 8 `display_style_change_applies_after_board_refetch`, Task 10 `incident_fit_unchanged_when_fail_count_changes`.

---

### Task 1: 엔진 헬퍼 공개 + 조건·화면 방식 설정 타입과 저장 검증

**Files:**
- Modify: `crates/engine/src/extract.rs`(`jsonpath_first`·`stringify`를 `pub`, 신규 `jsonpath_is_valid`)
- Modify: `crates/controller/src/monitor/config.rs`

**Interfaces:**
- Produces (engine, `handicap_engine::extract::`):
  - `pub fn jsonpath_first(json: &serde_json::Value, path: &str) -> Option<serde_json::Value>`(본문 무변경 — 가시성만)
  - `pub fn stringify(v: &serde_json::Value) -> String`(본문 무변경)
  - `pub fn jsonpath_is_valid(path: &str) -> bool` = `serde_json_path::JsonPath::parse(path).is_ok()`
- Produces (`monitor::config`):
  - `pub enum DisplayStyle { Fill, Border, Focus }`, `pub enum ConditionSource { Body, Header, Status, BodyText }`, `pub enum ConditionOp { Exists, NotEmpty, Eq, Ne, Contains, Gt, Lt }` — 모두 `Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize` + snake_case.
  - `pub struct Condition { pub step_id: String, pub source: ConditionSource, pub path: String, pub op: ConditionOp, pub value: String, pub ignore_case: bool, pub trim: bool }`
  - `BoardConfig.display_style: DisplayStyle`(기본 `Border`), `PanelConfig.conditions: Vec<Condition>`(기본 빈).
  - `pub const MAX_CONDITIONS: usize = 10;`
  - `impl ConditionOp { pub fn needs_value(self) -> bool /* Eq|Ne|Contains|Gt|Lt */; pub fn has_flags(self) -> bool /* Eq|Ne|Contains */ }`, `impl ConditionSource { pub fn allows(self, op: ConditionOp) -> bool }`
  - `pub fn parse_finite(s: &str) -> Option<f64>` — `s.trim().parse::<f64>()`이고 `is_finite()`일 때만 `Some`(Task 2 판정도 이걸 쓴다).
  - `validate_panel`이 조건을 제자리 정규화·검증(아래 순서).

- [ ] **Step 1: 실패 테스트 작성**
  - engine `extract.rs` 테스트 모듈: `jsonpath_is_valid_accepts_and_rejects` — `"$.a"`, `"$['a b'][0]"`, `"$"` → true; `"a.b"`, `"$.["`, `""` → false.
  - `config.rs`:
    - `defaults_fill_missing_fields` 확장: `c.display_style == DisplayStyle::Border`, `p.conditions.is_empty()`; 조건 JSON `{"step_id":"S"}`를 역직렬화하면 `source == Body`, `op == Exists`, `!ignore_case && !trim`.
    - `enum_wire_strings_roundtrip` 확장: `("fill","border","focus")`, `source` 4종(`"body_text"` 포함), `op` 7종(`"not_empty"` 포함) 왕복.
    - `conditions_validate_rejects` — 표 테스트(각 케이스 `validate_panel` Err + **메시지 정확 일치**): 11개 · `step_id` `"x"` · status+`exists` · body_text+`eq` · body path `""` · body path 501자 · body path `"a.b"`(파싱 실패) · header path `"   "` · header path 201자 · **eq** value 201자(값을 쓰는 op여야 한다 — 기본 `Exists`면 정규화가 값을 비워 통과) · contains value `""` · gt value `"abc"` · gt value `"inf"` · lt value `""`.
    - `conditions_validate_normalizes` — status 조건 path `"$.x"` → `""`; body_text path → `""`; exists value `"z"` → `""`; gt `ignore_case:true, trim:true` → 둘 다 `false`; header path `"  X-A "` → `"X-A"`; eq `ignore_case:true` 유지.
    - `conditions_validate_accepts_boundaries` — 10개 · body path 500자 유효 JSONPath(`"$." + "a".repeat(498)`) · value 200자 · gt `" 12.5 "`.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-engine extract` · `cargo nextest run -p handicap-controller monitor::config` → 컴파일 에러/FAIL.
- [ ] **Step 3: 구현** — `validate_panel` 끝(기존 범위 검사 뒤)에서 조건마다 이 순서로: 개수 → ULID → `source.allows(op)` → path(body: char 1..=500 → `jsonpath_is_valid`; header: trim 후 저장·char 1..=200; status/body_text: `""`로) → `!op.needs_value()`면 `value = ""` → `!op.has_flags()`면 두 플래그 `false` → value char ≤200 → contains면 비어 있지 않음 → gt/lt면 `parse_finite(value).is_some()`(정규화를 길이 검사보다 먼저 — UI `normalizeCondition`과 같은 순서). `conditions_validate_normalizes`에 "exists + 201자 value → 통과하고 `value == \"\"`" 케이스 추가. 스텝 존재는 검사하지 않는다(spec §3).
- [ ] **Step 4: 통과 확인** — 위 두 명령 + `cargo nextest run -p handicap-controller` PASS(컴파일러가 요구하는 `PanelConfig`/`BoardConfig` 리터럴은 `..Default::default()`가 대부분 — 깨지는 곳만 필드 추가).
- [ ] **Step 5: 커밋** — `feat(monitor): 칸 성공 조건·보드 화면 방식 설정 타입과 저장 검증` (cargo 게이트라 `run_in_background`, 커밋 후 `git log -1`).

### Task 2: 조건 판정 + `detail` 와이어 + 요청 전 조건 스텝 확인

**Files:**
- Modify: `crates/controller/src/monitor/check.rs`(파일 머리 주석도 갱신 — "조건 판정 결과일 때만 사용자가 고른 경로의 실제 값·비교값이 나간다")
- Modify: `crates/controller/src/monitor/supervisor.rs`, `crates/controller/src/api/monitor_boards.rs`(테스트 헬퍼의 `CheckResult` 리터럴에 `detail: None`만)

**Interfaces:**
- Consumes: Task 1 `Condition`/`ConditionOp`/`ConditionSource`/`parse_finite`, engine `jsonpath_first`/`stringify`.
- Produces:
  - `CheckResult.detail: Option<String>`(`with_reason`은 `None`).
  - 상수 `REASON_COND_STEP_MISSING`, `REASON_COND_STEP_NOT_RUN`, `REASON_BODY_NOT_JSON`, `REASON_BODY_TOO_LARGE`, `REASON_NO_VALUE`, `REASON_EMPTY`(Global Constraints 문구), `pub const SHOWN_MAX_CHARS: usize = 200;`
  - `pub(crate) fn shown(s: &str) -> String` — 정규화(제어·Cf → `' '`) + 200자 상한(`…`).
  - `fn reason_not_contained(needle: &str) -> String` — 따옴표 안 축약.
  - `fn condition_detail(c: &Condition, step_name: Option<&str>) -> String`(정규화 전 원문; 호출부가 `shown`).
  - `fn condition_step_missing(scenario: &Scenario, panel: &PanelConfig, at_ms: i64) -> Option<CheckResult>` — `run_check`와 `judge`가 공유.
  - `fn eval_conditions(all: &[&HttpStep], panel: &PanelConfig, trace: &ScenarioTrace, at_ms: i64) -> Option<CheckResult>` — 첫 실패만, 전부 통과면 `None`.
- `judge` 순서(spec §4.1 고정): 기준 스텝 확인 → **조건 스텝 확인** → truncated → trace error → 실패 스텝 → **조건 평가** → `Ok`. `run_check`: 기준 스텝 확인 바로 뒤에 `condition_step_missing` → 있으면 `(None, r)` 반환(요청 없음).
- Cf 코드포인트(하드코딩, 새 의존성 없음): U+00AD · U+0600–0605 · U+061C · U+06DD · U+070F · U+0890–0891 · U+08E2 · U+180E · U+200B–200F · U+202A–202E · U+2060–2064 · U+2066–206F · U+FEFF · U+FFF9–FFFB · U+110BD · U+110CD · U+13430–1343F · U+1BCA0–1BCA3 · U+1D173–1D17A · U+E0001 · U+E0020–E007F.
- 실제 값(조건 스텝의 마지막 http 실행 `rfind`, `response`가 없으면 "미실행"과 같음): body — `body_truncated`면 `응답 본문이 너무 큼`, `serde_json::from_str` 실패면 `본문이 JSON 아님`, `jsonpath_first` 없음이면 값 없음, 있으면 텍스트 = `stringify`, JSON 숫자면 `as_f64()`도 보관 · header — `resp.headers`에서 `eq_ignore_ascii_case`로 찾음 · status — 10진 문자열 · body_text — 잘렸으면 `응답 본문이 너무 큼`, 아니면 본문 전체.
- op 평가(spec §4 표 그대로): 값 없음 → 모든 op `값 없음` · exists 통과 · not_empty `""`이면 `비어 있음` · eq/ne: 매치가 JSON 숫자이고 `parse_finite(value)`가 `Some`이면 f64 비교, 아니면 양쪽에 `trim`(켜졌을 때)→`to_lowercase`(켜졌을 때) 후 문자열 비교 · contains: 같은 정규화 후 `contains`, 실패 사유는 body_text면 `reason_not_contained(c.value 원문)`, 그 외 실제 값 · gt/lt: `parse_finite(실제)`·`parse_finite(비교)` 둘 다 `Some`일 때만 비교, 아니면 실패. 실패 사유는 정규화 전 실제 값(`""`이면 `비어 있음`)을 `shown`.

- [ ] **Step 1: 실패 테스트 작성**(`check.rs` 테스트 모듈 — 기존 `one_step()`/`two_steps()`/`st()`/`tr()` 헬퍼 재사용, 응답 본문·헤더를 지정하는 `resp_with(status, body, headers)` 헬퍼 추가)
  - `cond_eq_pass_and_fail_detail_one_step` — 본문 `{"resultCode":"E1023"}`, 조건 body `$.resultCode` eq `0000` → `Fail`, `reason == Some("E1023")`, `detail == Some("resultCode · 같음 0000")`, `latency_ms == None`; 본문 `0000`이면 `Ok`(`detail == None`).
  - `cond_detail_has_step_name_with_two_steps` — `two_steps()` → `detail == "resultCode · 같음 0000 · 인증"`, `reason`에 ` · ` 접미 없음.
  - `cond_ops_table` — 표 테스트(op × 실제 값 → 통과/사유): exists+`null` 통과 · exists+경로 없음 `값 없음` · not_empty+`null` `비어 있음` · not_empty+`""` `비어 있음` · not_empty+경로 없음 `값 없음` · ne `0000` vs `0000` 실패 `0000` · contains `OK` in `"ALL OK"` 통과 · gt `5` vs 비교 `3` 통과 · gt `"abc"` 실패 `abc` · gt `"inf"` 실패 `inf` · lt `"NaN"` 실패 · 객체 매치 eq 실패 사유 = JSON 문자열(`{"a":1}`).
  - `cond_flags` — eq `"OK "` vs `"ok"`: 플래그 둘 다 꺼짐 실패·사유 `"OK "` 원문(`shown`은 공백 보존) / `trim`만 → 실패 / `ignore_case`만 → 실패 / 둘 다 → 통과 · ne 같은 입력: 둘 다 꺼짐 통과, 둘 다 켜짐 실패 · contains `"Ok "`(뒤 공백) in `"ALL OK"`: `ignore_case`만 실패(`"ok "`는 `"all ok"`의 부분 문자열 아님), `trim`+`ignore_case` 통과 · gt는 플래그 무관.
  - `cond_json_number_compare` — 본문 `{"v":1.0}` eq `1` 통과 / 본문 `{"v":"0000"}` eq `0` 실패(문자열 유지).
  - `cond_body_text_not_contained` — 본문 `"fail"`, body_text contains `OK` → `reason == "\"OK\" 포함 안 됨"`, `detail == "본문 전체 · 포함 OK"`; 비교값 200자면 `reason.chars().count() <= 200`이고 `reason.ends_with("\" 포함 안 됨")`이고 `…`를 포함.
  - `cond_body_truncated_and_not_json` — `body_truncated: true` → `응답 본문이 너무 큼`(body와 body_text 둘 다) · 본문 `"not json"` → `본문이 JSON 아님`.
  - `header_lookup_ignores_case` — trace 헤더 `content-type: application/json`, 조건 header `Content-Type` contains `json` 통과 / 없는 헤더 `값 없음` + `detail` 대상 `헤더 X-None`.
  - `cond_status` — status eq `200` 통과, gt `300` 실패 사유 `200`, `detail == "상태코드 · 보다 큼 300"`.
  - `cond_uses_last_execution` — 같은 스텝 2회 실행(첫 `0000`, 둘째 `E1`) → 사유 `E1`.
  - `cond_step_not_run` — 조건 스텝이 시나리오엔 있으나 trace에 없음 → `Fail` `조건 스텝 미실행`, `detail.is_some()`.
  - `cond_first_failing_only` — 조건 2개 다 깨짐 → 첫 조건의 사유.
  - `scenario_failure_beats_conditions` — 스텝 503(status assert 실패) + 깨진 조건 → 사유 `HTTP 503`, `detail == None`.
  - `cond_step_missing_is_config_error_before_truncation` — 조건 step_id가 시나리오에 없음 + `trace.truncated = true` → `ConfigError` `조건 기준 스텝 없음`, `detail == Some("resultCode · 같음 0000")`(스텝 부분 없음).
  - `body_root_and_bracket_target_labels` — path `$` → detail 대상 `본문`, path `$['a b'][0]` → `['a b'][0]`.
  - `shown_cuts_at_char_boundary_with_ellipsis` — `"가".repeat(300)` → 200자이고 `…`로 끝; 이모지 300개도 패닉 없이 200자; 200자 정확은 그대로.
  - `shown_replaces_cf_and_controls` — `"a\u{202E}b\u{200B}c\u{FEFF}d\ne\tf\u{2028}g\u{2029}h"` → `"a b c d e f g h"`.
  - `no_condition_results_have_null_detail` — 기존 성공·실패 케이스 몇 개(`ok_when_all_steps_pass`의 기대 리터럴에 `detail: None` 추가 포함)가 `detail == None`.
  - (async) `run_check_condition_step_missing_sends_nothing` — wiremock `.expect(0)`, 시나리오 1스텝, 조건 step_id = 없는 ULID → `trace.is_none()`, `ConfigError`, `조건 기준 스텝 없음`.
  - (async) `run_check_condition_fail_against_wiremock` — wiremock 200 + `{"resultCode":"E1023"}` → `Fail`, `reason == "E1023"`.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller monitor::check` → FAIL/컴파일 에러.
- [ ] **Step 3: 구현** — Interfaces 그대로. 조건 결과의 `reason`·`detail` 둘 다 `shown()` 통과. 실행 시 JSONPath 파싱 실패(이론상)는 `jsonpath_first`가 `None` → 값 없음(패닉 금지, spec §7).
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller` PASS, `cargo clippy -p handicap-controller --all-targets -- -D warnings` exit 0.
- [ ] **Step 5: 커밋** — `feat(monitor): 칸 성공 조건 판정 + 결과 detail`.

### Task 3: `/status` 최신 결과에만 사유 + REST 통합 테스트 + ADR-0053 보완

**Files:**
- Modify: `crates/controller/src/api/monitor_boards.rs`(`build_panel_status`)
- Test: `crates/controller/tests/monitor_boards_api_test.rs`
- Modify: `docs/adr/0053-*.md`(보완 절 — `ls docs/adr | grep 0053`으로 파일명 확인)

**Interfaces:**
- Consumes: Task 2 `CheckResult.detail`.
- `build_panel_status`는 `consecutive_fail`을 **자르기 전 전체 버퍼로** 계산한 뒤(기존), 잘라낸 `results`에서 마지막을 뺀 나머지의 `reason`·`detail`을 `None`으로.
- 사실 확인(구현 전 재실행): UI가 최신 결과의 `reason`만 읽는다 — `grep -rn "\.reason\|\.detail" ui/src/monitor ui/src/components/monitor ui/src/pages/Monitor*.tsx`(현재 `logic.ts::bigValueText`의 `latest?.reason`과 `PreviewResult`의 단일 결과뿐).

- [ ] **Step 1: 실패 테스트 작성**
  - `monitor_boards.rs` 단위: `status_reasons_only_on_latest_result` — 결과 5개 전부 `reason: Some("x")`, `detail: Some("d")` → 응답 `results[0..4]` 둘 다 `None`, `results[4]`는 그대로; `consecutive_fail`은 5.
  - 통합(`monitor_boards_api_test.rs`, 기존 `make_app`/`send`/`create_scenario` 재사용 — 응답 JSON 본문을 주는 wiremock):
    - `preview_check_condition_fail_reports_value_and_detail` — 본문 `{"resultCode":"E1023"}`, 패널 조건 body `$.resultCode` eq `0000`(시나리오 스텝 id 사용) → 200, `result.verdict == "fail"`, `result.reason == "E1023"`, `result.detail == "resultCode · 같음 0000"`.
    - `preview_check_400_on_invalid_condition` — gt value `"abc"` → 400, `error == "크다·작다 조건의 비교값은 숫자여야 합니다"`.
    - `board_roundtrip_keeps_conditions_and_display_style` — POST(`display_style: "focus"`, 조건 1개) → GET이 같은 값.
    - `legacy_board_row_loads_with_defaults` — `sqlx::query("UPDATE monitor_boards SET config_json = ? WHERE id = ?")`로 ①a 형태 JSON(새 키 없음)을 넣고 GET → `config.display_style == "border"`, `config.panels[0].conditions == []`.
    - `status_detail_is_serialized_as_null` — 조건 없는 보드 시작 후 status 결과 객체에 `detail` 키가 **존재하고** `null`(`as_object().unwrap().contains_key("detail")` — serde Index는 부재 키도 Null이라 공허, controller CLAUDE.md 테스트 함정).
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --test monitor_boards_api_test` · `cargo nextest run -p handicap-controller api::monitor_boards`.
- [ ] **Step 3: 구현** — `build_panel_status`만. ADR-0053에 `## 보완 — ①b (2026-10-22)` 절을 spec §9 문장 그대로 추가(상태 줄 변경 없음).
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller` PASS.
- [ ] **Step 5: 커밋** — `feat(monitor): status 최신 결과에만 사유 + 조건 통합 테스트 + ADR-0053 보완`.

### Task 4: 응답 트리·본문 블록·헤더 표를 공용 컴포넌트로 추출 (에디터 무동작 변경)

**Files:**
- Create: `ui/src/components/response/JsonValueTree.tsx`, `ui/src/components/response/BodyBlock.tsx`, `ui/src/components/response/HeaderTable.tsx`
- Modify: `ui/src/components/scenario/ResponseBodyTree.tsx`(얇은 래퍼로), `ui/src/components/scenario/TestRunPanel.tsx`(비공개 `BodyViewer`/`BodyBlock`/`HeaderTable` 제거 → import)
- Test: `ui/src/components/response/__tests__/sharedResponse.test.tsx`(신규)
- **회귀 가드(수정 금지)**: `ui/src/components/scenario/__tests__/{ResponseBodyTree,TestRunPanel,TestRunPanel.extract,TestRunSection,ExtractConfirmRow}.test.tsx` — 무수정 green이 이 task의 합격선.

**Interfaces:**
- Produces:
  - `export type JsonLeaf = { segments: ReadonlyArray<Segment>; path: string; value: string | number | boolean | null; key: string }` — `path = segmentsToPath(segments)`, `key` = 가장 가까운 객체 키(없으면 `"value"`; 기존 `lastKey`).
  - `export function JsonValueTree(props: { value: unknown; actionLabel: string; actionAriaLabel?: (leaf: JsonLeaf) => string; renderConfirm: (leaf: JsonLeaf, close: () => void) => ReactNode })` — 기존 `TreeNode` 마크업·클래스 그대로, 스칼라 leaf마다 `actionLabel` 버튼(`actionAriaLabel` 없으면 aria-label 속성 자체를 안 단다 — 에디터 접근명 불변), 누르면 그 leaf 아래 `renderConfirm(leaf, close)`.
  - `ResponseBodyTree({ value, onCreate })` 시그니처 불변 — `actionLabel="+추출"`, `renderConfirm`이 기존 `ExtractConfirmRow`(제안 `{ var: suggestVarName(leaf.key), from: "body", path: leaf.path }`, preview 40자 규칙 그대로).
  - `export type BodyTreeBinding = { render: (value: unknown) => ReactNode; openLabel: string; fallbackNotice?: (truncated: boolean) => ReactNode }`
  - `export function BodyBlock(props: { body: string; truncated?: boolean; label: string; tree?: BodyTreeBinding })` — 기존 로직에서 `onExtract`를 `tree`로 치환(JSON 파싱 memo의 dep은 `tree !== undefined` 불리언 — 객체 dep 금지), 긴 JSON의 버튼 문구 = `tree.openLabel`, 비-JSON/잘림 안내 = `tree.fallbackNotice?.(truncated)`.
  - `export function BodyViewer(props: { body: string; truncated: boolean; value?: unknown; renderTree?: (value: unknown) => ReactNode })` — 트리 토글은 `value !== undefined && renderTree !== undefined`일 때.
  - `export const INLINE_PREVIEW_CHARS = 500;`
  - `export function HeaderTable(props: { title: string; rows: [string, string][]; action?: { label: string; ariaLabelFor: (rowKey: string) => string; onClick: (rowKey: string) => void } })`
  - `TestRunPanel`은 `tree={{ render: (v) => <ResponseBodyTree value={v} onCreate={onCreate} />, openLabel: "전체 보기·추출", fallbackNotice: (t) => <Callout …>(기존 문구 그대로)</Callout> }}`, 헤더 `action={{ label: "추출", ariaLabelFor: (k) => \`${k} 추출\`, onClick }}`, 쿠키는 기존 `extractLabelFor`를 `ariaLabelFor`로.

- [ ] **Step 1: 실패 테스트 작성**(`sharedResponse.test.tsx`)
  - `json_value_tree_custom_action_opens_confirm` — `value={{a:{b:"x"}, n:null}}`, `actionLabel="+ 조건"`, `actionAriaLabel={(l)=>\`${l.path} 조건 추가\`}` → `getByRole("button",{name:"$.a.b 조건 추가"})` 클릭 → `renderConfirm`이 `{path:"$.a.b", value:"x", key:"b"}`로 호출되고 렌더한 노드가 보임; `close()` 호출 시 사라짐; null leaf 버튼도 존재.
  - `json_value_tree_without_aria_uses_text_name` — `actionAriaLabel` 생략 → 버튼 `aria-label` 속성 없음(`not.toHaveAttribute("aria-label")`).
  - `header_table_custom_action` — `action.label="+ 조건"` → 행마다 그 문구 버튼, 클릭 시 `onClick("content-type")`.
  - `body_block_long_json_uses_open_label_and_modal_tree` — 600자 JSON + `tree.openLabel="전체 보기·조건"` → 그 버튼 클릭 → 다이얼로그 안에 `tree.render` 결과.
  - `body_block_non_json_shows_fallback_notice` — 비-JSON 본문 → `fallbackNotice(false)` 렌더, 트리 미렌더.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test sharedResponse` → 모듈 없음 FAIL.
- [ ] **Step 3: 구현** — 코드 이동 + 위 시그니처. 동작·마크업·문구 무변경.
- [ ] **Step 4: 통과 확인** — `pnpm test sharedResponse; echo exit=$?` · `pnpm test ResponseBodyTree; echo exit=$?` · `pnpm test TestRunPanel; echo exit=$?` · `pnpm test TestRunSection; echo exit=$?`(회귀 가드 무수정 green) · `git diff --stat -- 'ui/src/components/scenario/__tests__'`가 **빈 출력** · `pnpm lint`/`pnpm test`/`pnpm build` 각 exit 0.
- [ ] **Step 5: 커밋** — `refactor(ui): 응답 트리·본문 블록·헤더 표를 공용 컴포넌트로 추출`.

### Task 5: UI 와이어(조건·detail) + 조건 순수 로직 + 칸 편집기 "성공 조건" 섹션

**Files:**
- Modify: `ui/src/api/monitors.ts`(`ConditionSchema`, `PanelConfigSchema.conditions`, `CheckResultSchema.detail`, `newPanel().conditions = []`)
- Create: `ui/src/monitor/conditions.ts`, `ui/src/components/monitor/ConditionRow.tsx`
- Modify: `ui/src/components/monitor/PanelEditor.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/monitor/__tests__/conditions.test.ts`(신규), `ui/src/pages/__tests__/MonitorEditPage.test.tsx`
- Fixture 갱신(같은 커밋): `panel` fixture에 `conditions: []` — `MonitorEditPage.test.tsx`, `MonitorDisplayPage.test.tsx`, `MonitorDisplayPage.fullscreen.test.tsx`, `MonitorListPage.test.tsx`, `ui/src/api/__tests__/monitors.test.ts`; 결과 fixture에 `detail: null` — `logic.test.ts`, `LatencyBars.test.tsx`, `monitors.test.ts`, 두 `MonitorDisplayPage*` 테스트, `MonitorEditPage.test.tsx`.

**Interfaces:**
- Produces (`api/monitors.ts`): `ConditionSchema = z.object({ step_id: z.string(), source: z.enum(["body","header","status","body_text"]), path: z.string(), op: z.enum(["exists","not_empty","eq","ne","contains","gt","lt"]), value: z.string(), ignore_case: z.boolean(), trim: z.boolean() })`, `type Condition`, `type ConditionSource`, `type ConditionOp`. `.default()` 금지.
- Produces (`monitor/conditions.ts`):
  - `export const OPS_BY_SOURCE: Record<ConditionSource, readonly ConditionOp[]>` — body/header `["eq","ne","exists","not_empty","contains","gt","lt"]`(목업 01 select 순서), status `["eq","ne","gt","lt"]`, body_text `["contains","not_empty"]`.
  - `export const needsValue = (op: ConditionOp): boolean`, `export const hasFlags = (op: ConditionOp): boolean` — 서버와 같은 집합.
  - `export function isFiniteNumberText(s: string): boolean` — `s.trim()`이 `/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/`에 맞고 `Number.isFinite(Number(s.trim()))`(JS `Number("")===0`·`Number("0x10")===16`을 막아 Rust `parse_finite`와 맞춤).
  - `export function normalizeCondition(c: Condition): Condition` — 서버 정규화와 같음(status/body_text path `""`, header path trim, 값 불요 op면 value `""`, 플래그 불요 op면 `false`).
  - `export function conditionError(c: Condition): string | null` — 서버 검증 중 JSONPath 파싱을 뺀 나머지(body path 비었거나 500자 초과 또는 `$`로 시작 안 함 → `condErrPath`; header path trim 후 비었거나 200자 초과 → `condErrPath`; value 200자 초과 → `condErrTooLong`; contains 빈 값 → `condErrValue`; gt/lt 숫자 아님 → `condErrNumber`). 글자 수는 `[...s].length`.
  - `export function targetLabel(c: Pick<Condition, "source" | "path">): string` — body: `$`면 `condTargetBodyRoot`, 아니면 `condTargetBody(선두 "$." 제거 또는 "$[…"면 "$"만 제거)`; header `condTargetHeader(path)`; status/body_text 고정.
  - `export function conditionSummary(c: Condition, stepName: string | undefined): string` — `${stepName ?? c.step_id} · ${targetLabel(c)} ${condOpLabel[op]}` + (값 필요 op면 ` ${value}`, 빈 값이면 ` ""`) + (`ignore_case`면 ` · 대소문자 무시`) + (`trim`이면 ` · 앞뒤 공백 무시`).
  - `export type ConditionClick = { kind: "body"; path: string; value: string | number | boolean | null } | { kind: "header"; name: string; value: string } | { kind: "status"; status: number } | { kind: "body_text" }`
  - `export function defaultCondition(stepId: string, click: ConditionClick): { condition: Condition; volatileHint: boolean }` — spec §5.2 표: 문자열 `[...v].length <= 40` → eq + 지금 값 / 40 초과 → not_empty + `volatileHint: true` / 숫자 → eq + `String(v)` / 불리언 → eq + `"true"|"false"` / `null` → exists / 헤더 = 문자열 규칙(path = 헤더 이름) / 상태코드 → eq + `String(status)` / 본문 전체 → contains + `""`. 플래그 기본 `false`.
- Produces (`ConditionRow.tsx`): `export function ConditionRow(props: { initial: Condition; mode: "create" | "edit"; volatileHint?: boolean; blockedReason?: string; onSubmit: (c: Condition) => void; onCancel: () => void })` — 인라인 JSX(Modal 금지 — 모달 안 본문 트리에서도 쓰인다, scenario CLAUDE.md ESC 함정), `rounded bg-accent-50 text-slate-700` 띠(목업 01 보라 띠 — `ExtractConfirmRow`와 같은 계열; **글자 색 명시 필수** — 본문 트리 컨테이너가 `bg-slate-900 text-slate-100`[`ResponseBodyTree.tsx:35`]라 상속하면 밝은 띠 위 밝은 글씨가 된다), `font-sans`. 내용: `targetLabel` 텍스트(create) 또는 대상 경로 `Input`(edit, body·header만) · 규칙 `Select`(`OPS_BY_SOURCE[source]`, 표시 `condOpOptions`) · 비교값 `Input`(`needsValue`일 때만) · 체크박스 2개(`hasFlags`일 때만, 라벨 `condIgnoreCase`/`condTrim`) · `volatileHint`면 안내 한 줄 · `conditionError(normalizeCondition(draft)) ?? blockedReason`이 있으면(정규화 후 검사 — 숨겨진 비교값이 제출을 막지 않게, 서버와 같은 순서) 그 문구를 작은 글씨로 + 제출 버튼 `disabled`(문구는 `aria-describedby`로 연결) · 제출(`create`=`condConfirm`, `edit`=`condSave`)은 `onSubmit(normalizeCondition(draft))`, `condCancel`.
- `PanelEditor`: 섹션은 카드 **맨 아래**(미리 실행 버튼·결과 뒤 — 목업 01 배치). `<fieldset className="mb-3 min-w-0">` + legend 안 `aria-expanded` 토글 `▸/▾ 성공 조건`(①a 고급 섹션 이디엄), 초기 펼침 = `panel.conditions.length > 0`, 접힌 채 조건 있으면 `advancedSet(n)`. 펼치면 `conditionsIntro` → 목록(없으면 `conditionsEmpty`). 행 = `conditionSummary` + (시나리오가 로드됐고 `stepNames`에 step_id가 없으면 `condStepGone`) + `✎`(aria `condEdit(i+1)`) + `🗑`(aria `condRemove(i+1)`). `✎`는 그 행 자리에 `ConditionRow mode="edit"`; 저장 → `set({ conditions })`(로컬 편집, 보드 저장 흐름 그대로). 섹션 펼침 상태는 `const [condOpen, setCondOpen]`로 두어 Task 6이 `addCondition`에서 쓸 수 있게 한다(**`addCondition` 자체는 Task 6에서 만든다** — 여기서 미리 만들면 미사용 지역 변수가 `noUnusedLocals`[`ui/tsconfig.json:15`]·eslint `no-unused-vars`에 걸려 커밋이 깨진다).

- [ ] **Step 1: 실패 테스트 작성**
  - `conditions.test.ts`: `ops_by_source_matches_server` · `default_condition_table`(spec §5.2 7행 각각: 40자 문자열→eq+값, 41자→not_empty+hint, `12`→eq `"12"`, `false`→eq `"false"`, `null`→exists, 헤더 50자→not_empty+hint, status 200→eq `"200"`, body_text→contains `""`) · `condition_error_cases`(contains `""`, gt `"abc"`, gt `""`, gt `"0x10"`, value 201자, body path `""`, header `"  "` → 각 키 문구 / gt `" 1e3 "`, eq `""` → null) · `normalize_condition_mirrors_server`(Task 1 `conditions_validate_normalizes`와 같은 입력·기대) · `target_and_summary_labels`(`$.data.items[0].code` → `본문 data.items[0].code`, `$` → `본문`, `$['a b']` → `본문 ['a b']`, 요약 `로그인 · 본문 resultCode 같음 0000 · 대소문자 무시`, exists 요약에 비교값 없음, eq 빈 값 `같음 ""`).
  - `MonitorEditPage.test.tsx`(기존 `panel()` fixture에 조건 주입): `conditions_section_collapsed_with_count_when_none_open` — 조건 0개면 접힘·힌트 없음; `conditions_section_auto_open_when_present` — 조건 2개 fixture면 펼쳐져 요약 2줄; `conditions_section_collapsed_hint` — 접으면 `2개 설정됨`; `condition_row_edit_changes_op_and_clears_value` — `✎` → 규칙 `값이 있음` 선택 → 비교값 입력 사라짐 → `저장` → 보드 저장 PUT 본문의 조건 `{op:"exists", value:""}`(fetch mock 본문 단언); `condition_row_delete`; `condition_row_marks_missing_step` — 시나리오에 없는 step_id 행에 `⚠ 스텝 없음`, 저장 버튼 활성; `resave_keeps_conditions` — 조건 있는 보드 열고 바로 저장 → PUT 본문에 조건 그대로.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test conditions` · `pnpm test MonitorEditPage` → FAIL.
- [ ] **Step 3: 구현** — Interfaces 그대로 + fixture 갱신 + ko 키(이 task의 것: `conditions*`·`cond*`·`condTarget*`·`condOp*`·`condErr*`·`condVolatileHint`·`condStepGone`·`condMax`).
- [ ] **Step 4: 통과 확인** — `pnpm lint; echo exit=$?` · `pnpm test; echo exit=$?`(전체 — fixture 누락은 다른 파일에서 Zod throw로 드러난다) · `pnpm build; echo exit=$?` 모두 0.
- [ ] **Step 5: 커밋** — `feat(ui): 모니터 칸 성공 조건 섹션 (목록·편집·삭제)`.

### Task 6: 미리 실행 결과에서 클릭으로 조건 만들기

**Files:**
- Modify: `ui/src/components/monitor/PreviewResult.tsx`, `ui/src/components/monitor/PanelEditor.tsx`(props 연결), `ui/src/i18n/ko.ts`
- Test: `ui/src/pages/__tests__/MonitorEditPage.test.tsx`(기존 `preview_shows_verdict_and_raw_error` 등 미리 실행 테스트와 같은 fetch mock 패턴)

**Interfaces:**
- Consumes: Task 4 `JsonValueTree`/`BodyBlock`/`HeaderTable`, Task 5 `ConditionRow`/`defaultCondition`/`targetLabel`/`condOpen`·`setCondOpen`.
- `PanelEditor`에 `const addCondition = (c: Condition) => { set({ conditions: [...panel.conditions, c] }); setCondOpen(true); }`를 만들어 `PreviewResult onAddCondition={addCondition}`로 넘긴다.
- `PreviewResult` props 추가: `onAddCondition?: (c: Condition) => void`, `conditionCount: number`(10 이상이면 확인 줄 `blockedReason = condMax`).
- 판정 줄: `reason` 옆에 `detail`이 있으면 `whitespace-pre-wrap break-all` span으로 전체 표시.
- 스텝마다(`s.kind === "http" && s.response && onAddCondition`): 상태 `dd`에 상태코드 + `condAdd` 버튼(aria `condAddAria(condTargetStatus)`) · 응답 헤더가 있으면 `HeaderTable title={previewHeaders}` + `action={{ label: condAdd, ariaLabelFor: (k) => condAddAria(condTargetHeader(k)), … }}` · 본문: `BodyBlock`에 `tree={{ render: (v) => <JsonValueTree value={v} actionLabel={condAdd} actionAriaLabel={(l) => condAddAria(targetLabel({ source: "body", path: l.path }))} renderConfirm={…ConditionRow create…} />, openLabel: previewOpenFullCondition }}`, 트리 모드일 때 본문 제목은 `previewBodyClickHint`; 본문이 JSON이 아니거나 잘렸으면 본문 블록 위에 `condAddBodyText` 버튼. 상태·헤더·본문 전체의 확인 줄은 스텝 행마다 하나(`useState<ConditionClick | null>`), 헤더 표 아래에 `ConditionRow`.
- `onAddCondition`이 없으면(다른 소비처) 지금처럼 텍스트 전용 — 단 본문은 `BodyBlock`(500자 미리보기 + 전체 보기 모달)으로 렌더.

- [ ] **Step 1: 실패 테스트 작성**
  - `preview_tree_click_creates_eq_condition` — 미리 실행 응답 본문 `{"resultCode":"0000"}`(기존 fixture 스텝 `STEP_A` = `로그인 호출`) → `getByRole("button",{name:"+ 조건 (본문 resultCode)"})` → 확인 줄 규칙 `같음`·비교값 `0000`·체크박스 2개 해제 → `추가` → 성공 조건 섹션이 펼쳐지고 요약 `로그인 호출 · 본문 resultCode 같음 0000`.
  - `preview_long_string_defaults_not_empty_with_hint` — 41자 토큰 값 → 규칙 `비어 있지 않음`, 비교값 입력 없음, `condVolatileHint` 문구.
  - `preview_null_defaults_exists` · `preview_status_click_eq_200` · `preview_header_click` (헤더 `x-trace: abc` → 요약 `… · 헤더 x-trace 같음 abc`).
  - `preview_non_json_body_offers_body_text_contains` — 본문 `"pong"` → `+ 본문 전체 포함 조건` → 비교값 빈 칸이면 `추가` disabled, `OK` 입력하면 활성.
  - `preview_gt_non_number_disables_add` — 숫자 leaf에서 규칙 `숫자 크다`로 바꾸고 비교값 `abc` → `추가` disabled + `condErrNumber` 문구.
  - `preview_verdict_shows_detail` — 결과 `{verdict:"fail", reason:"E1023", detail:"resultCode · 같음 0000"}` → 두 문자열 모두 표시.
  - `preview_add_blocked_at_10_conditions` — 조건 10개 fixture → 확인 줄 `추가` disabled + `condMax`.
  - `preview_rerun_sends_conditions` — 조건 추가 후 다시 `미리 실행` → `preview-check` 요청 본문 `conditions` 길이 1; 확인 줄이 열려 있는 미완성 상태에서 미리 실행하면 본문 `conditions` 길이 0(spec §5.2 "미완성 값은 보내지 않는다").
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test MonitorEditPage` → FAIL.
- [ ] **Step 3: 구현** — Interfaces 그대로.
- [ ] **Step 4: 통과 확인** — `pnpm lint`/`pnpm test`/`pnpm build` 각 `; echo exit=$?` 0.
- [ ] **Step 5: 커밋** — `feat(ui): 미리 실행 결과의 값·헤더·상태코드를 눌러 성공 조건 만들기`.

### Task 7: 전시 화면 조건 실패 사유 렌더 (공통 — 세 방식)

**Files:**
- Modify: `ui/src/monitor/display.ts`(순수 함수), `ui/src/monitor/reasons.ts`, `ui/src/components/monitor/MonitorPanel.tsx`
- Test: `ui/src/monitor/__tests__/display.test.ts`, `ui/src/pages/__tests__/MonitorDisplayPage.test.tsx`

**Interfaces:**
- Produces (`display.ts`):
  - `export type ReasonParts = { kind: "split"; fixed: string; step: string | null } | { kind: "detail"; big: string; small: string } | { kind: "not_contained"; needle: string; small: string }`
  - `export function reasonParts(reason: string, detail: string | null): ReasonParts` — `detail === null` → 기존 `splitReason` 결과(`kind:"split"`); `detail.startsWith("본문 전체 · 포함 ") && reason.startsWith('"') && reason.endsWith('" 포함 안 됨')` → `not_contained`(needle = 앞 `"`과 뒤 `" 포함 안 됨` 제거); 그 외 → `detail`(분할 안 함).
- `reasons.ts` `WIDEST_REASON_CANDIDATES`에 6개 추가: `조건 기준 스텝 없음`·`조건 스텝 미실행`·`본문이 JSON 아님`·`응답 본문이 너무 큼`·`값 없음`·`비어 있음`(주석의 "keep in sync with check.rs" 대상).
- `MonitorPanel`: `reason` 분기를 `reasonParts(bigText, latest?.detail ?? null)`로. `split`은 기존 마크업 그대로(byte-identical). `detail`: 큰 줄 = 기존 사유 `FitLine`(같은 글자 크기·`--reason-fit`·`REASON_CLASS`), 작은 줄 = 기존 스텝 이름 줄과 같은 `div`(`truncate text-right font-bold`, `PANEL_TEXT.step`). `not_contained`: 큰 줄 자리에 `data-testid="reason-not-contained"` 가로 flex(`justify-end`, 사유 줄과 같은 font-size/스타일) = `"` span(`shrink-0`) + needle span(`min-w-0 truncate`) + `" 포함 안 됨` span(`shrink-0`, `whitespace-nowrap`).

- [ ] **Step 1: 실패 테스트 작성**
  - `display.test.ts`: `reason_parts_without_detail_splits_as_before`(`"HTTP 503 · 인증"` → split) · `reason_parts_detail_never_splits`(`reason="a · b"`, `detail="x · 같음 y"` → `{kind:"detail", big:"a · b"}`) · `reason_parts_not_contained_three_conditions`(정상 식별 / `detail="본문 전체 · 비어 있지 않음"` + `reason="비어 있음"` → detail / `detail="본문 전체 · 포함 OK"` + `reason="응답 본문이 너무 큼"` → detail / `detail="본문 · 포함 OK"` + 따옴표 모양 reason → detail / `detail="본문 전체 · 포함 OK"` + `reason="\"OK"`(따옴표로 시작하나 꼬리 없음) → detail).
  - `MonitorDisplayPage.test.tsx`: `condition_fail_shows_value_big_and_detail_small`(결과 `reason:"E1023", detail:"resultCode · 같음 0000 · 로그인"` → 칸 안에 두 텍스트, 값에 ` · `가 있어도(`reason:"a · b"`) 큰 줄 텍스트가 `"a · b"` 전체) · `not_contained_reason_keeps_tail_span`(`reason-not-contained` 안에 needle span과 `" 포함 안 됨` span이 별개 요소, 꼬리 span 클래스 `shrink-0`) · `condition_config_error_shows_detail`(`verdict:"config_error"`, `reason:"조건 기준 스텝 없음"`, detail → 상태 `⚠ 설정 오류` + 두 줄) · `reason_probes_include_condition_fixed_reasons`(`reason-probe` 텍스트에 6개 포함).
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test display` · `pnpm test MonitorDisplayPage` → FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `pnpm lint`/`pnpm test`/`pnpm build` 0.
- [ ] **Step 5: 커밋** — `feat(ui): 전시 화면 조건 실패 사유 — 큰 줄 값·작은 줄 경로·포함 실패 꼬리 보존`.

### Task 8: 화면 방식 선택 + A(신호등) 렌더

**Files:**
- Modify: `ui/src/api/monitors.ts`(`DisplayStyleSchema`, `BoardConfigSchema.display_style`), `ui/src/pages/MonitorEditPage.tsx`(선택 컨트롤 + 새 보드 초기값 `display_style: "border"`), `ui/src/monitor/display.ts`, `ui/src/components/monitor/MonitorPanel.tsx`, `ui/src/components/monitor/LatencyBars.tsx`, `ui/src/pages/MonitorDisplayPage.tsx`(prop 전달), `ui/src/i18n/ko.ts`
- Test: `ui/src/monitor/__tests__/display.test.ts`, `ui/src/pages/__tests__/MonitorEditPage.test.tsx`, `ui/src/pages/__tests__/MonitorDisplayPage.test.tsx`
- Fixture 갱신(같은 커밋): board config fixture에 `display_style: "border"` — `MonitorDisplayPage.test.tsx`, `MonitorDisplayPage.fullscreen.test.tsx`, `MonitorEditPage.test.tsx`, `MonitorListPage.test.tsx`, `monitors.test.ts`.

**Interfaces:**
- Produces (`api/monitors.ts`): `DisplayStyleSchema = z.enum(["fill","border","focus"])`, `type DisplayStyle`.
- Produces (`display.ts`):
  - `export const FILL = { ok: "#15803d", fail: "#b91c1c", gray: "#475569" } as const;`
  - `export function fillBackground(state: PanelState, latencyMs: number | null, thresholds: Threshold[]): string | null` — Global Constraints A 색, `pending` → `null`.
  - `export function contrastText(bg: string): "#ffffff" | "#0b0f14"` — WCAG 상대휘도(sRGB 선형화) 대비비 비교.
  - `GRAPH_CHROME`에 `insetPad: 1`, `insetRadius: 1.2` 추가(cqw).
  - `barsAreaHeight(w, h, textH, fontScale, inset = false)` — `inset`이면 `2 * GRAPH_CHROME.insetPad * cqw`를 더 뺀다. `graphFits({ w, h, textH, fontScale, inset? })`도 전달.
- `MonitorPanel` prop `displayStyle?: DisplayStyle`(기본 `"border"`): `fill`이고 `fillBackground`가 색이면 상자 배경·테두리 색 = 그 색, 제목·상태·큰 값·사유·작은 줄·연속 실패 줄 색 = `contrastText(배경)`; `LatencyBars inset`; `useGraphShown`에 `inset` 전달. `pending`이면 B와 동일. `PanelProbe`는 무변경(spec §6.2 — 칸 기하·배율 B와 동일).
- `LatencyBars` 루트 div에 `data-testid="latency-bars"`(테스트 핸들) + prop `inset?: boolean` — 루트 grid div에 `background: COLOR.bg`, `padding: ${insetPad}cqw`, `borderRadius: ${insetRadius}cqw`(막대·기준선·기준값 열·시간축은 그대로 그 안).
- `MonitorEditPage` 보드 설정 카드: 기존 3개 `Field` 옆에 `Field label={displayStyle}` + `Select id="monitor-style"`(옵션 `displayStyleOptions`), 그리드 `sm:grid-cols-2 lg:grid-cols-4`.

- [ ] **Step 1: 실패 테스트 작성**
  - `display.test.ts`: `contrast_text_picks_readable`(`#facc15`·`#f59e0b` → `#0b0f14`; `#15803d`·`#b91c1c`·`#475569` → `#ffffff`) · `fill_background_by_state`(ok/slow[기준선 `#facc15` 넘음]/fail/config_error/stale/stale_off/pending) · `bars_area_height_subtracts_inset_only_when_inset`(같은 입력에서 차 = `2 * insetPad * w/100`).
  - `MonitorEditPage.test.tsx`: `display_style_select_saves`(기본 `테두리 (기본)` 선택됨 → `신호등 (칸 전체 색)` → 저장 PUT 본문 `display_style:"fill"`) · `resave_keeps_conditions_and_display_style`(focus+조건 fixture → 그대로 저장).
  - `MonitorDisplayPage.test.tsx`: `fill_panel_background_is_state_color`(fill 보드, 실패 칸 `panel-box` `style.background`가 `#b91c1c`/`rgb(185, 28, 28)`, 제목 색 흰색) · `fill_slow_yellow_threshold_uses_dark_text`(기준선 `#facc15` 넘은 느림 칸 → 큰 값 색 `#0b0f14`) · `fill_pending_matches_border`(pending 칸 배경 = `COLOR.panel`) · `fill_graph_inside_dark_box`(`latency-bars` 배경 `COLOR.bg`) · `border_board_unchanged`(border 보드 `latency-bars`에 배경 없음) · `display_style_change_applies_after_board_refetch`(status `board_updated_at` 변경 → 재조회된 보드가 `fill` → 칸 배경 변경).
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test display` · `pnpm test MonitorEditPage` · `pnpm test MonitorDisplayPage` → FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `pnpm lint`/`pnpm test`/`pnpm build` 0.
- [ ] **Step 5: 커밋** — `feat(ui): 모니터 화면 방식 선택 + A(신호등) 렌더`.

### Task 9: C(실패만 크게) 배치 + 띠 카드

**Files:**
- Modify: `ui/src/monitor/logic.ts`, `ui/src/pages/MonitorDisplayPage.tsx`, `ui/src/monitor/display.ts`, `ui/src/components/monitor/MonitorPanel.tsx`(상태 라벨·색 규칙을 `display.ts`로 이동 — 무동작 변경)
- Create: `ui/src/components/monitor/StripCard.tsx`
- Test: `ui/src/monitor/__tests__/logic.test.ts`, `ui/src/pages/__tests__/MonitorDisplayPage.test.tsx`

**Interfaces:**
- Produces (`logic.ts`): `export type FocusLayout = { kind: "grid" } | { kind: "focus"; big: number[]; strip: number[]; side: "right" | "bottom" }`, `export function focusLayout(states: PanelState[]): FocusLayout` — Global Constraints C 배치(인덱스는 칸 추가 순서).
- Produces (`display.ts`): `export const CARD_TEXT = { title: { cqh: 22, cqw: 10 }, state: { cqh: 20, cqw: 9 } } as const;`(실측 조정 가능), `export const CARD_BOX = { border: 2, pad: 6, radius: 4 } as const;`(cqmin), `export function cardFont(r: { cqh: number; cqw: number }, scale: number): string` → `calc(min(${cqh·scale}cqh, ${cqw·scale}cqw) * var(--card-fit, 1))`.
- Produces (`StripCard.tsx`): `export function StripCard(props: { panel: PanelConfig; state: PanelState; latest: CheckResult | undefined; fontScale: number; blinkOn: boolean; cardFit?: number })` — `<article data-testid="strip-card" aria-label={title} style={{containerType:"size"}}>` + 상자(`absolute inset-0` — `[data-blink="on"]::after`가 `position:absolute; inset:0`이라 상자가 포함 블록이어야 한다[`index.css:38`], `panel-box`와 같은 구조; `COLOR.panel` 배경, 테두리 = B 칸과 같은 `borderColor` 규칙, `data-blink`, `--card-fit`), 1줄 제목(`truncate`), 2줄 `data-testid="strip-status"` `whitespace-nowrap` = 상태 라벨(`STATE_LABEL`, 상태 색 — B와 같은 `stateColor` 규칙) + ms(`ok`/`slow`면 `formatMs(latency)`, 그 외 `—`). 그래프·사유 없음. `STATE_LABEL`과 B 칸의 상태 색·테두리 색 규칙은 `MonitorPanel.tsx`에서 `display.ts`로 옮겨(`export const STATE_LABEL`, `export function stateColorOf(state, latencyMs, thresholds): string`, `export function borderColorOf(state, stateColor): string`) 두 컴포넌트가 공유한다 — 복제 금지, 그리고 컴포넌트 파일에서 비-컴포넌트를 export하면 `react-refresh/only-export-components` 경고(`--max-warnings=0` = 실패)라 `MonitorPanel.tsx`에서 export하지 않는다.
- `MonitorDisplayPage`: `layout = board.config.display_style === "focus" ? focusLayout(views.map(v => v.state)) : { kind: "grid" }`. `grid` → 기존 렌더 그대로. `focus` → `main`의 grid가 `side === "right"`면 `gridTemplateColumns: "3fr 1fr"`·행 1개, `"bottom"`이면 `gridTemplateRows: "3fr 1fr"`·열 1개(gap·padding 기존과 같음); 첫 칸 = 큰 영역 div(`gridFor(big.length)` 그리드, gap `1vw`, `min-h-0 min-w-0`)에 `MonitorPanel`(이 task에선 `fit`/`reasonFit` = 평소 값, Task 10에서 장애 배율로 교체), 둘째 칸 = 띠 div(right면 열 1·행 `strip.length`, bottom이면 행 1·열 `strip.length`, 모두 `minmax(0,1fr)`)에 `StripCard`. 깜빡임은 두 영역 모두 기존 `blinks(mode, state)`. 크기 probe 오버레이(B 그리드)는 그대로 유지.

- [ ] **Step 1: 실패 테스트 작성**
  - `logic.test.ts`: `focus_layout_cases` — `[]`·`[ok,ok]`(f=0) → grid · `[fail,fail]`(f=n) → grid · `[ok,fail,slow,ok]` → `{big:[1], strip:[0,2,3], side:"right"}` · `[fail,ok,fail,config_error]` → `{big:[0,2], strip:[1,3], side:"bottom"}` · `[stale,fail]` → `{big:[1], strip:[0], side:"right"}`.
  - `MonitorDisplayPage.test.tsx`: `focus_no_fail_renders_plain_grid`(4칸 focus 보드 모두 정상 → `monitor-panel` 4개, `strip-card` 0) · `focus_one_fail_big_plus_right_strip`(1개 실패 → `monitor-panel` 1개[그 칸 제목], `strip-card` 3개 순서 = 추가 순서, `main` `gridTemplateColumns === "3fr 1fr"`) · `focus_two_fail_bottom_strip`(`gridTemplateRows === "3fr 1fr"`, `strip-card` 2개) · `focus_all_fail_plain_grid` · `focus_recovers_to_grid`(다음 폴링에 전부 정상 → `strip-card` 0) · `strip_card_shows_state_and_ms`(느림 카드 `▲ 느림`+`1,350 ms`, 설정 오류 카드 `—`, 사유 텍스트 없음) · `strip_slow_card_blinks_with_slow_and_fail`(`data-blink="on"`) · `border_board_never_focus_layout`(border 보드 실패 1개 → `strip-card` 0).
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test logic` · `pnpm test MonitorDisplayPage` → FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `pnpm lint`/`pnpm test`/`pnpm build` 0.
- [ ] **Step 5: 커밋** — `feat(ui): 모니터 C 방식 — 실패 칸 크게·나머지 띠 카드`.

### Task 10: C 글자 배율 — 평소/장애/띠 카드 배율을 설정 시점에 고정

**Files:**
- Create: `ui/src/monitor/useScaleSearch.ts`
- Modify: `ui/src/pages/MonitorDisplayPage.tsx`, `ui/src/components/monitor/StripCard.tsx`(`StripCardProbe`), `ui/src/monitor/display.ts`, `ui/src/monitor/logic.ts`
- Test: `ui/src/monitor/__tests__/logic.test.ts`, `ui/src/monitor/__tests__/display.test.ts`, `ui/src/pages/__tests__/MonitorDisplayPage.test.tsx`

**Interfaces:**
- Produces (`useScaleSearch.ts`): `export type ProbeReport = { fit: number; need: number; reasonNeed: number }`, `export function useScaleSearch(scaleKey: string, probeCount: number): { fit: number; reasonFit: number; cand: number; done: boolean; report: (id: string, r: ProbeReport) => void }`(`report`는 렌더 간 안정 — `useCallback([])`) — 지금 `MonitorDisplayPage`의 탐색(`SEARCH_START`·`probeOk`·`reasonNeeds`·`nextSearch`·`useLayoutEffect([scaleKey])` 리셋)을 **그대로** 옮긴 것; 판정 `ok = !Number.isFinite(r.need)`. 페이지는 `PanelProbe`의 `PanelMeasure`를 `{ fit: m.fit, need: requiredFit(m), reasonNeed: m.reasonNeed }`로 바꿔 보고.
- Produces (`logic.ts`): `export function focusGeometries(n: number): { big: { key: string; f: number }[]; strip: { key: string; f: number }[] }` — f=1..n−1 중 기하가 같은 것은 첫 f만(big key `right:1x1` 또는 `bottom:{cols}x{rows}` of `gridFor(f)`; strip key `right:{n-1}` 또는 `bottom:{n-f}`).
- Produces (`display.ts`): `export function cardNeed(m: { fit: number; contentH: number; textH: number; lineClientW: number; lineScrollW: number }): number` — 세로 넘침이면 `fit * contentH / textH * 0.98`, 가로 넘침이면 `fit * lineClientW / lineScrollW * 0.98`, 둘 중 작은 값, 다 맞으면 `Infinity`.
- 세 탐색 그룹(페이지에서 `useScaleSearch` 3회, 키 = 기존 `scaleKey` + `display_style`):
  - **평소**(기존 B 그리드 probe, 개수 n) → 그리드 배치(B·A·C의 f=0/n)의 `fit`/`reasonFit`. B·A 보드는 이 그룹만 존재 → probe DOM 무변경.
  - **장애**(focus일 때만): `focusGeometries(n).big`마다 보이지 않는 레이아웃 1개(`data-testid="incident-probe-layout"`, `absolute inset-0`, 실제 focus `main`과 같은 바깥 grid·padding·gap + 큰 영역 `gridFor(f)` 그리드)를 두고, 그 큰 영역 grid의 `gridArea: "1 / 1"`에 **모든 칸의** `PanelProbe`를 겹쳐 둔다(id `${key}|${panel.id}`, 개수 = 기하 수 × n). 큰 칸 `MonitorPanel`은 이 그룹의 `fit`/`reasonFit`.
  - **띠 카드**(focus일 때만): `focusGeometries(n).strip`마다 레이아웃 1개(`data-testid="card-probe-layout"`)의 띠 grid `gridArea: "1 / 1"`에 `StripCardProbe` 1개 — 최악 내용 = 제목 1줄(`가`) + `⚠ 설정 오류` + `formatMs(max(timeout_seconds)*1000)`. `StripCardProbe`는 `data-testid="card-probe"`(상자)·`"card-probe-text"`(텍스트 블록)·`"card-probe-status"`(상태 줄)를 재서(0×0 상자면 보고하지 않음 — `useBoxMeasure`와 같은 가드) `{ fit, need: cardNeed(…), reasonNeed: Infinity }` 보고. 모든 `StripCard`는 이 그룹의 `fit`을 `cardFit`으로.
- probe는 결과·상태를 절대 받지 않는다(제목·제한 시간·설정만).
- 각 probe 레이아웃 루트에 `data-geometry={key}`(테스트가 기하별로 다른 크기를 stub하는 핸들).
- **비용**: focus 9칸이면 `PanelProbe` 63개(각 사유 probe 줄 18개)가 1초 폴링마다 리렌더되고 `useBoxMeasure`는 매 렌더 측정한다(`MonitorPanel.tsx`의 deps 없는 `useEffect`). `PanelProbe`·`StripCardProbe`를 `React.memo`로 감싸고, 페이지가 넘기는 `report` 어댑터·sample 객체는 `useCallback`/`useMemo`로 안정화해 폴링 리렌더가 probe까지 내려가지 않게 한다. **memo 함정**: 지금 사유 줄 배율(`reasonFit`)은 탐색 완료 *뒤의* 측정에서 모은다(`MonitorDisplayPage.tsx:97-103`) — 그 측정은 완료 렌더가 probe를 다시 렌더해서 생기는데, 마지막 `cand`가 직전 시험값과 같으면(예: 처음부터 1에서 다 맞음 → `{cand:1, done:true}`) memo된 probe는 prop 변화가 없어 다시 렌더되지 않고 `reasonFit`이 영영 안 정해진다. 그래서 `useScaleSearch`가 `done: boolean`도 돌려주고 페이지가 그것을 각 probe의 prop(`searchDone`)으로 넘긴다(완료 시 반드시 한 번 재렌더·재측정). memo 적용 뒤 **기존 `MonitorDisplayPage` 테스트 전부 무수정 green**(특히 `reason_line_has_its_own_settings_scale`)이 합격선.

- [ ] **Step 1: 실패 테스트 작성**
  - `logic.test.ts`: `focus_geometries_dedup` — n=9 big keys `["right:1x1","bottom:2x1","bottom:3x1","bottom:2x2","bottom:3x2","bottom:3x3"]`, strip 8개(`right:8`, `bottom:7`…`bottom:1`); n=4 big 3개·strip 3개; n=1 둘 다 빈 배열.
  - `display.test.ts`: `card_need_cases`(다 맞음 → Infinity / 세로 2배 → ≈0.49·fit / 가로 넘침).
  - `MonitorDisplayPage.test.tsx` — 기존 `stubLayout`을 **기하 인식형으로 확장**: `probe-text` 높이 콜백이 `this.closest("[data-geometry]")?.getAttribute("data-geometry") ?? "grid"`를 받아 기하마다 다른 높이를 줄 수 있게(지금 stub은 모든 `panel-probe`가 같은 300×300이라 기하가 달라도 같은 수가 나와 아래 테스트들이 공허해진다). 기존 테스트 호출부는 기하 인자를 무시하는 형태로 그대로 동작해야 한다.
    - `border_board_has_no_focus_probes` — B·A 보드 → 두 레이아웃 0개, `panel-probe` 개수 = n(기존과 같음).
    - `focus_probe_counts` — focus 9칸 → `incident-probe-layout` 6개(`data-geometry` 값 = `focusGeometries(9).big` 키)·그 안 `panel-probe` 54개, `card-probe-layout` 8개.
    - `normal_fit_equals_border_board` — stub: `grid`는 맞음, `bottom:*`/`right:*`는 넘침 → focus 보드 f=0 칸 `--fit` = 같은 설정 border 보드의 `--fit`(=1), f=1 큰 칸 `--fit` < 1(평소 배율을 그리드에 썼는지·장애 배율을 큰 칸에 썼는지를 둘 다 가른다).
    - `incident_fit_is_min_over_geometries` — stub: `right:1x1`만 맞고 `bottom:2x1`만 크게 넘침 → f=1 큰 칸 `--fit`이 `bottom:2x1` 기하가 요구하는 값과 같음(f=1 기하만 보고 고르면 1이 나온다).
    - `incident_fit_unchanged_when_fail_count_changes` — 위 stub 그대로 4칸 focus, f=1 폴링 → 큰 칸 `--fit` 기록 → f=2 폴링 → 큰 칸 `--fit` 같은 값(현재 f의 기하만 재는 구현은 f=1에서 1, f=2에서 <1로 갈라져 RED).
    - `scale_not_keyed_by_results` — 탐색 완료 후, 결과만 다른 폴링(f=1 → f=2, 제목·설정 동일) 동안 `incident-probe-layout` 안 `probe-text`에 대한 `getBoundingClientRect` 호출 수가 **0**(stub spy를 폴링 직전에 `mockClear`, 폴링 `tick` 뒤 `this`가 incident 레이아웃 안 `probe-text`인 호출만 센다). 키에 결과가 새면 탐색이 재시작돼 probe `fit` prop이 바뀌고 재측정이 일어나 > 0(텍스트·최종 `--fit`은 같은 값으로 수렴해 버리므로 그쪽 단언은 이 누출을 못 잡는다).
    - `strip_cards_share_card_fit` — `stubLayout`이 `card-probe`(예: 400×120)·`card-probe-text`(기하별 높이)·`card-probe-status`(`scrollWidth`/`clientWidth` spy)를 처리; `card-probe-layout` 중 하나만 넘침 → 모든 `strip-card` 상자의 `--card-fit`이 같은 값 < 1.
  - **이빨 실증 의무(brief에 명시)**: ① 장애 그룹 probe를 현재 f의 기하 하나만 렌더하도록 고의 변경 → `incident_fit_is_min_over_geometries`·`incident_fit_unchanged_when_fail_count_changes` RED → 원복 GREEN. ② `scaleKey`에 실패 칸 수를 고의로 넣음 → `scale_not_keyed_by_results` RED → 원복 GREEN. ③ 그리드 칸에 장애 배율을 고의로 넘김 → `normal_fit_equals_border_board` RED → 원복 GREEN. 결과를 implementer 리포트에 적는다.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test logic` · `pnpm test display` · `pnpm test MonitorDisplayPage` → FAIL.
- [ ] **Step 3: 구현** — 먼저 `useScaleSearch` 추출(기존 `MonitorDisplayPage` 테스트 전부 무수정 green 확인 — 이 시점 `pnpm test MonitorDisplayPage` 실행), 이어서 두 그룹 추가.
- [ ] **Step 4: 통과 확인** — `pnpm lint`/`pnpm test`/`pnpm build` 0.
- [ ] **Step 5: 커밋** — `feat(ui): 모니터 C 방식 글자 배율 — 평소·장애·카드 배율을 설정 시점에 고정`.

---

## 구현 후 (파이프라인 4–6단계 — task 아님)

- **리뷰 라우팅**: code-quality `model: opus` = Task 1(엔진)·Task 2(응답 값 → 벽 sink, 정규화)·Task 3(와이어)·Task 10(대형 diff·배율 알고리즘). 나머지 Sonnet. Task 4는 "회귀 가드 테스트 무수정"을 spec-compliance 리뷰가 `git diff --stat`로 직접 확인.
- **최종 리뷰**: `handicap-reviewer` — 와이어 1:1(Rust `Condition`/`DisplayStyle`/`CheckResult.detail` ↔ Zod, enum 문자열), 서버 정규화 ↔ `normalizeCondition`·`conditionError` ↔ `parse_finite`/`isFiniteNumberText` 대칭, `WIDEST_REASON_CANDIDATES` ↔ `check.rs` 상수, 조건이 run 경로에 닿지 않음(`grep -rnE "\.conditions\b|ConditionOp|ConditionSource|eval_conditions" crates/controller/src crates/engine/src | grep -v "^\S*:\s*//"`의 매치가 `crates/controller/src/monitor/`·`crates/controller/src/api/monitor_boards.rs` 안에만. baseline[plan 작성 시 실행]은 매치 0건·exit 1. bare `Condition`은 엔진 if-노드 타입[`scenario.rs:467`]과 겹쳐 패턴에서 뺐다). **`security-reviewer` 필수**(spec §8 — 응답 값이 벽·`/status`라는 새 sink로 나감; 중점: 정규화 우회[Cf 목록 누락], 최신 결과 외 사유 누출, 확인 줄 기본값이 긴 비밀 값에 `같음`을 만들지 않음).
- **라이브 검증**(`/live-verify`, 필수 — spec §8 표 US1~US4 + US4 극단값 + 보드 이전 행 호환 1회). 극단값은 rect 교차로 실측(메모리 live-verify-extreme-values-readable): 값 300자·` · ` 포함 값·빈 문자열·`null`·경로 없음·`body_text` 포함 실패 × 1920×1080 2칸/9칸 × `아주 크게`, C n=3·f=2 / n=9·f=1 / n=9·f=2 × 40자 제목. US1은 같은 시나리오로 run 1회를 돌려 리포트 에러 0(조건 무관)까지. `CARD_TEXT`/띠 두께가 실측에서 판독 불가면 값 조정 fix 커밋(spec "실측 조정 가능").
- **finish**: build-log 단락(증명/미증명 US), roadmap §B37 갱신(①b 판단·연기 — 비용+해소법), 현황판 frontier ①b 완료 → 추천 다음 ②, CLAUDE 상태줄, 메모리 `ops-monitor-board`.
