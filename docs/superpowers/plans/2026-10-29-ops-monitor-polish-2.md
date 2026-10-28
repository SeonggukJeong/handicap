# 운영실 모니터 개선 2차 (ops-monitor-polish-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모니터 설정 화면의 칸을 한 줄 요약으로 접고 오른쪽 고정 목록으로 이동·오류 위치를 보이게 하며(⑥), 점검 1회의 요청·응답을 막대 구간만큼 메모리에 보관해 벽의 막대를 누르면 기록 창으로 보여 주고(⑦, 인증 값 서버 가림·요청 본문 화면 가림·보드 단위 상한), 설정 화면의 "벽" 문구를 "화면"으로 바꾼다(DW).

**Architecture:** 두 독립 덩어리를 따로 green인 task 묶음으로 — **A(Task 1–4)** = DW 문구 + ⑥(UI 위주 + 서버 오류 접두 `칸 N: `), **B(Task 5–9)** = ⑦. B의 서버는 순수 함수 `monitor/record.rs::build_record`(가림·변수 폐기·본문 상한)가 기록을 만들고, 감독자 `PanelBuf.records`(결과 버퍼와 별도, `bar_count`개)가 보관하며, `GET …/panels/{panel_id}/records/{at_ms}`가 `existing_slot`으로만 조회한다. UI는 `LatencyBars` 위 투명 오버레이 층이 클릭을 받아 `CheckRecordDialog`(단일 `Modal`, 인라인 본문 블록)를 연다.

**Tech Stack:** Rust(axum, serde, serde_json, tokio, wiremock), React+TS(Zod, React Query, react-router, Tailwind, vitest+RTL).

**Spec:** `docs/superpowers/specs/2026-10-29-ops-monitor-polish-2-design.md`(spec-plan-reviewer clean APPROVE 4라운드) · **결정 원천(최우선)** `docs/superpowers/specs/2026-10-28-ops-monitor-polish-mockups/00-decisions.md` §⑥·§⑦·§문구(D6.1–D6.4, D7.1–D7.10, DW.1–DW.2) · ⑥ 배치 정본 목업 `03-editor-collapse-nav.html`. spec과 결정 원천이 다르면 결정 원천이 이긴다. **목업에 없는 화면·배치를 만들지 않는다.** 각 task 구현자는 spec의 해당 절을 함께 읽는다(task마다 절 번호 표기).

REVIEW-GATE: APPROVED

## Global Constraints

- **엔진(`crates/engine`) 무변경.** `BodyBlock`·`TestRunPanel`·`PreviewResult`·`HeaderTable` 동작 무변경(`JsonValueTree`만 Task 8에서 버튼 선택 옵션).
- **새 저장 필드**: `BoardConfig.record_limit_kb: u32` 기본 **128**, 검증 `16..=1024`, 오류 `점검 기록 상한은 16~1024KB여야 합니다`(byte-exact). 컨테이너 `#[serde(default)]` + 손 `Default`에 명시, migration 없음. UI `BoardConfigSchema.record_limit_kb: z.number()` required.
- **서버 칸 오류 접두**: `validate_and_normalize`의 칸 오류만 `칸 {n}: {원 메시지}`(n=1부터). `validate_panel` 단독(`preview_check`)은 접두 없음.
- **와이어 `CheckRecord`**(spec §2.4, 모든 필드 항상 emit): `{ at_ms: i64, limit_kb: u32, result: CheckResult, trace: ScenarioTrace|null, clipped: [{ step: u32, side: "request"|"response" }] }`. Zod: `trace` `.nullable()`, 배열 required, `.optional()`/`.default()` 금지.
- **가림 문자열** `••••`(U+2022 ×4). 규칙 = spec §3.2 1–2(비어 있지 않은 비밀 부분만, 스킴·쿠키 이름 유지, URL 원문 구간 치환).
- **UI 문구는 `ko.monitor.*` 경유**(aria 포함). DW 8건·신규 키 = 아래 표가 정본(키 이름 고정 — task 간 공유).
- Rust: `cargo fmt`, `clippy -D warnings`(2-arm `match … _ => {}` 대신 `if let`), `str::floor_char_boundary` 금지(MSRV 1.85). 커밋은 `run_in_background`, 게이트 판정에 파이프 금지(`; echo exit=$?`), 커밋 후 `git log -1`. UI: `pnpm lint; echo exit=$?` · `pnpm test; echo exit=$?` · `pnpm build; echo exit=$?`(cwd `ui/`), 단일 파일은 `pnpm test <파일명>`.
- **`ui/src` 편집 전 테스트부터**(tdd-guard — pending test 없으면 차단). 무수정 리팩터는 `it.todo`로 언블록 후 커밋 전 제거.
- **회귀 가드 테스트는 고의 회귀 → RED → 원복 → GREEN 실증**(각 task "이빨" 스텝) — 결과를 리포트에 기록.
- 워크트리 격리: git은 단독 호출·리터럴 경로, 커밋 메시지는 `-F <파일>`(파일은 Write 도구로 scratchpad에).

**`ko.monitor` DW 변경 8건**(값만, byte-exact — spec §8 표): `condVolatileHint`=`매번 바뀌는 값이면 '='은 매 점검 실패하고 그 값이 화면에 표시됩니다` · `condChooseDisplay`=`화면에 추가` · `displayTitle`=`화면에 표시` · `displayEmpty`=`미리 실행 결과에서 값을 눌러 화면에 표시할 값을 고릅니다` · `displayMax`=`화면 표시는 최대 2개까지` · `displayDup`=`이미 화면에 표시 중` · `displayAuthHeader`=`인증 헤더는 화면에 표시할 수 없음` · `previewBodyClickHint`=`응답 본문 — 값을 누르면 조건이나 화면 표시를 추가합니다`.

**`ko.monitor` 신규 키**(이름 고정, 값 byte-exact):

| 키 | 값 |
|---|---|
| `expandAll` / `collapseAll` | `모두 펼치기` / `모두 접기` |
| `noTitle` | `(제목 없음)` |
| `noScenario` | `시나리오 —` |
| `summaryInterval(n)` / `summaryConds(n)` / `summaryDisplays(n)` | `` `${n}초` `` / `` `조건 ${n}` `` / `` `표시 ${n}` `` (요약 구분자 `" · "`) |
| `navTitle` | `칸 목록` |
| `navJumpActions` | `저장 · 모니터 시작 ↓` |
| `recordLimit` | `점검 기록 상한 (KB)` |
| `recordLimitHint(x: string)` | `` `이 보드 최대 약 ${x} MB (본문 기준)` `` |
| `recordLimitRange` | `16~1024 사이로 입력하세요` |
| `recordTitle(title: string, when: string)` | `` `${title} · ${when}` `` |
| `recordMissing` | `이 점검의 기록이 없습니다 — 기록은 막대 구간만큼만 보관되어 이미 지워졌습니다` |
| `recordLoadError(msg: string)` | `` `기록을 불러오지 못했습니다: ${msg}` `` |
| `recordNoTraceConfig` | `요청을 보내기 전에 멈췄습니다(설정 오류) — 요청·응답 기록 없음` |
| `recordNoTraceTimeout` | `응답이 오기 전에 시간 초과 — 요청·응답 기록 없음` |
| `recordTraceError(e: string)` | `` `점검 준비 중 오류: ${e}` `` |
| `recordTraceCut` | `점검이 중간에 끊겨 그 전 스텝까지만 기록됐습니다` |
| `recordReqHeaders` / `recordReqBody` / `recordRespHeaders` / `recordRespBody` | `요청 헤더` / `요청 본문` / `응답 헤더` / `응답 본문` |
| `recordIfRow(branch: string)` | `` `조건 분기 → ${branch}` `` |
| `recordMaskedHint` | `인증 값은 ••••로 가렸습니다` |
| `recordReqBodyHidden` | `요청 본문은 가려져 있습니다` |
| `recordReveal` / `recordHide` | `보기` / `가리기` |
| `recordClipped(kb: number)` | `` `기록 상한 ${kb}KB에서 잘림` `` |
| `recordEngineTruncated` | `1 MiB에서 잘림 — 실제 응답은 더 큼` |
| `recordTreeTooLarge` | `64KB를 넘는 본문은 원문으로 표시합니다` |
| `recordViewTree` / `recordViewRaw` | `트리` / `원문` |

로딩은 기존 `ko.monitor.loading`, 판정 라벨은 기존 `stateOk`/`stateFail`/`stateConfigError`, 감싼 JSON 안내는 기존 `previewUnwrapped`, 시나리오 필수는 기존 `scenarioRequired` 재사용.

## Review Focus

1. **조건 편집 중에 칸을 접었다 폄** — 커밋 안 한 편집값·미리 실행 결과가 남는다(본문 언마운트 금지) → Task 2 `collapse_keeps_body_state`.
2. **새 보드에 칸 3개를 펼쳐 둔 채 첫 저장** — `key` 재마운트 뒤에도 3개가 펼쳐져 있고, 새로고침하면 전부 접힘 → Task 2 `first_save_of_new_board_keeps_expanded`, `reload_after_first_save_collapses_all`.
3. **로그인 칸의 막대를 운영실에서 누름** — 요청 본문은 가려져 있고 `보기` 후에만 보이며, 창을 닫았다 다시 열면 다시 가려짐; `Authorization`은 `Bearer ••••` → Task 6 `mask_table`, Task 8 `request_body_hidden_until_reveal_and_rehidden_on_reopen`.
4. **막대 개수를 300→10으로 줄여 저장** — 다음 점검 한 번에 기록이 10개로 줄고, 옛 막대 클릭은 `기록 없음` → Task 7 `records_trim_to_bar_count_at_once`.
5. **1MiB JSON 응답 칸의 기록 창** — 트리를 그리지 않고 원문 + `recordTreeTooLarge`, 상한에 잘린 본문은 `<pre>` + `recordClipped` → Task 8 `large_json_body_shows_raw_not_tree`, `clipped_body_shows_limit_notice`.

---

## 덩어리 A — DW 문구 + ⑥ 설정 화면

### Task 1: 문구 "벽" → "화면" (서버 6 + UI 8) — spec §2.3·§4.6·§8

**Files:**
- Modify: `crates/controller/src/monitor/config.rs:375-400`(오류 문자열 6종) + 같은 파일 테스트 기대값(`config.rs:937-977`의 11개 문자열)
- Modify: `ui/src/i18n/ko.ts`(`monitor` DW 8건)

**Interfaces:** Produces 없음(값만).

- [ ] **Step 1: 실패 테스트** — `config.rs` 테스트 모듈: 기존 표시 항목 오류 기대값 6종의 `벽 표시 항목` → `화면 표시 항목`. UI: `ui/src/i18n/__tests__/ko.test.ts`에 `dw_copy_has_no_wall_word` — `Object.values(ko.monitor)` 중 문자열 값에 `"벽"` 포함 0건 + `ko.monitor.condChooseDisplay === "화면에 추가"`, `ko.monitor.displayTitle === "화면에 표시"`.
- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller --lib monitor::config; echo exit=$?`(실패), `cd ui && pnpm test ko.test; echo exit=$?`(실패).
- [ ] **Step 3: 구현** — 서버 문자열 6종·ko 8건 교체(Global Constraints 값 그대로).
- [ ] **Step 4: GREEN + 전수 확인** — 위 두 명령 PASS. `grep -rn '"[^"]*벽[^"]*"' crates/controller/src` → 0건, `grep -rn "벽" ui/src/i18n/ko.ts` → 0건.
- [ ] **Step 5: 커밋** `fix(monitor): 설정 화면 문구 '벽' → '화면'`.

### Task 2: 칸 카드 접기·한 줄 요약·펼침 상태 — spec §4.1·§4.2

**Files:**
- Modify: `ui/src/components/monitor/PanelEditor.tsx`(머리 줄 → 토글 + 요약, 본문 `hidden`, 새 props)
- Modify: `ui/src/pages/MonitorEditPage.tsx`(펼침 집합·`모두 펼치기/접기`·칸 추가 펼침·재마운트 state 넘김·state 비움·카드 간격 `gap-2`)
- Create: `ui/src/monitor/panelSummary.ts`(+ `ui/src/monitor/__tests__/panelSummary.test.ts`)
- Modify: `ui/src/i18n/ko.ts`(신규 키 `expandAll`·`collapseAll`·`noTitle`·`noScenario`·`summaryInterval`·`summaryConds`·`summaryDisplays`)
- Test: `ui/src/pages/__tests__/MonitorEditPage.test.tsx`

**Interfaces:**
- Produces: `panelSummary(p: PanelConfig, scenarioName: string | undefined): string` → `` `${scenarioName ?? ko.monitor.noScenario} · ${summaryInterval(p.interval_seconds)} · ${summaryConds(p.conditions.length)} · ${summaryDisplays(p.display_items.length)}` ``.
- Produces: `PanelEditor` 새 props `expanded: boolean`, `onToggle: () => void`, (`error?: string`은 **Task 3이 추가** — 이 task에서 미사용 prop을 넣으면 `--max-warnings=0` lint 실패). 카드 루트 `id={`panel-${panel.id}`}`, 토글 `<button aria-expanded={expanded}>`(내용 `▸|▾ 칸 N  {제목 또는 noTitle}  {요약}`), `칸 삭제`는 토글의 **형제**(펼침일 때만, 기존 `canRemove`). 접힘: 카드 `px-4 py-2`·머리 줄 `mb-3` 없음, 본문 래퍼 HTML `hidden` 속성. 펼침: 지금처럼 `p-4`, accent 테두리(`border-accent-…` 디자인 토큰 — ADR-0043).
- 테스트 라우터는 `MemoryRouter`(`MonitorEditPage.test.tsx:113`)라 `window.history`에 쓰지 않는다 — router state는 기존 `LocationProbe`(`:105`)를 `data-testid="location-state"`로 `JSON.stringify(useLocation().state)`도 보이게 확장해 읽는다.
- Produces(BoardForm): `expanded: Set<string>` 상태 + `setExpanded`; Task 3·4가 사용. navigate state 형태 `{ startError?: string; expanded?: string[] }`.

- [ ] **Step 1: 기존 테스트 이행(먼저 — RED 기대)** — `MonitorEditPage.test.tsx`에 헬퍼 `async function expandAll()`(로드 후 `ko.monitor.expandAll` 버튼 클릭) 추가, 기존 보드(`/monitors/B1`)를 렌더하는 48곳 중 칸 내부를 질의하는 케이스에 로드 직후 `await expandAll()`. 칸 제목 텍스트 질의는 `within(screen.getByRole("region"|"group", {name: …}))`처럼 카드로 범위를 좁힌다(제목이 토글 요약에도 나타남). 지금은 버튼이 없어 RED.
- [ ] **Step 2: 신규 실패 테스트**(`MonitorEditPage.test.tsx`)
  - `existing_board_opens_all_collapsed`: 칸 2개 보드 → 토글 2개 `aria-expanded="false"`, `queryByRole("textbox", { name: ko.monitor.panelTitle })` 없음(`*ByLabelText`·`*ByText`는 `hidden` 안도 찾으므로 쓰지 말 것 — `*ByRole`만 `hidden`을 건너뜀).
  - `collapsed_header_shows_summary`: 토글 텍스트에 `칸 1`·칸 제목·`{시나리오 이름} · 10초 · 조건 0 · 표시 0`; 제목 빈 칸 → `(제목 없음)`; 시나리오 없는 칸 → `시나리오 —`.
  - `new_board_opens_default_panel_expanded`, `added_panel_is_expanded`, `expand_all_and_collapse_all`.
  - `collapse_keeps_body_state`(Review Focus 1): 펼침 → 조건 목록의 조건 `✎` 편집을 열고 비교값 칸에 **커밋하지 않은** 값 `XYZ`를 입력(`ConditionRow` 로컬 draft — 본문 하위 트리 안의 상태; 미리 실행 결과는 `PanelEditor` 자체 state라 이 가드가 되지 못함) → 접기 → 펼치기 → 비교값 칸 값이 여전히 `XYZ`.
  - `first_save_of_new_board_keeps_expanded`(Review Focus 2): `/monitors/new`에서 칸 3개 추가·펼침 → 저장(생성 모킹, 응답 칸 id 동일) → 재마운트 후 3개 `aria-expanded="true"`.
  - `reload_after_first_save_collapses_all`: 위 뒤 `location-state` 텍스트가 `null`(state 비움 — 새로고침 시 D6.4로 복귀).
  - `panelSummary.test.ts`: 위 요약 문자열 표.
- [ ] **Step 3: RED 확인** — `cd ui && pnpm test MonitorEditPage panelSummary; echo exit=$?`.
- [ ] **Step 4: 구현** — 위 Interfaces대로. BoardForm 초기 펼침 = `location.state?.expanded`(배열) ?? (`initial` 있으면 빈 집합, 없으면 기본 칸 id 하나). 두 `navigate('/monitors/{id}', {replace})`(첫 저장 `:128`·시작 실패 `:162`)의 state에 `expanded: [...expanded]` 추가. BoardForm 마운트 effect에서 `location.state`가 있으면 `navigate(location.pathname, { replace: true, state: null })`(초기값은 `useState` 초기화에서 이미 읽음). `+ 칸 추가` 줄 = `[+ 칸 추가] [모두 펼치기] [모두 접기]`(목업 배치). 칸 삭제 시 집합에서 제거. 칸 목록 간격 `gap-2`.
- [ ] **Step 5: GREEN** — `pnpm test MonitorEditPage panelSummary` PASS, 이어서 `pnpm lint; echo exit=$?` · `pnpm test; echo exit=$?` · `pnpm build; echo exit=$?`.
- [ ] **Step 6: 이빨** — `PanelEditor`의 `hidden` 래퍼를 조건부 렌더(`{expanded && …}`)로 바꾸면 `collapse_keeps_body_state` RED → 원복 GREEN. navigate state에서 `expanded`를 빼면 `first_save_of_new_board_keeps_expanded` RED → 원복. state 비우는 `navigate(…, {state: null})`를 빼면 `reload_after_first_save_collapses_all` RED → 원복.
- [ ] **Step 7: 커밋** `feat(monitor-ui): 설정 화면 칸 접기·한 줄 요약·모두 펼치기/접기`.

### Task 3: 칸 오류 — 서버 접두 `칸 N: ` + 오류 칸 자동 펼침·`⚠` — spec §2.2·§4.3

**Files:**
- Modify: `crates/controller/src/monitor/config.rs`(`validate_and_normalize` 칸 루프)
- Modify: `ui/src/pages/MonitorEditPage.tsx`, `ui/src/components/monitor/PanelEditor.tsx`(빨간 테두리 + `⚠ 사유`)
- Create: `ui/src/monitor/panelErrors.ts`(+ 테스트)

**Interfaces:**
- Consumes: Task 2의 BoardForm `expanded`. (`PanelEditor`의 `error?` prop은 **이 task가 추가**.)
- Produces: `parsePanelError(message: string): { index: number; reason: string } | null` — `/^칸 (\d+): (.+)$/s`, `index` = n−1. BoardForm 상태 `panelErrors: Record<string /*panel id*/, string>` — Task 4 목록이 읽음.

- [ ] **Step 1: 실패 테스트**
  - Rust(`config.rs` 테스트): `panel_error_prefixed_with_index` — 칸 2개 중 둘째 칸 `interval_seconds = 0` → `Err("칸 2: 점검 주기는 1~3600초여야 합니다")`; `board_level_error_has_no_prefix` — 칸 0개 → `칸은 1~9개여야 합니다`(접두 없음); `validate_panel_alone_has_no_prefix`. 기존 `validate_and_normalize` 경유 칸 오류 정확 단언은 접두 반영(`grep -n "validate_and_normalize" crates/controller/src/monitor/config.rs`로 전수).
  - Rust 통합(`crates/controller/tests/monitor_boards_api_test.rs`): `save_400_message_has_panel_prefix` — 첫 칸 시나리오 공백 PUT → 400 `error`가 `칸 1: `로 시작.
  - UI `panelErrors.test.ts`: `"칸 3: 시나리오를 선택해야 합니다"` → `{index: 2, reason: "시나리오를 선택해야 합니다"}`; `"칸은 1~9개여야 합니다"` → `null`.
  - UI `MonitorEditPage.test.tsx`: `server_panel_error_expands_and_marks_panel` — 칸 3개 기존 보드, 저장 400 `칸 3: X` → 칸 3 토글 `aria-expanded="true"`·카드에 `⚠ X`, 하단 Callout 원문; `missing_scenario_marks_every_such_panel` — 시나리오 빈 칸 2개 → 둘 다 펼침·`⚠ ${scenarioRequired}`; `editing_panel_clears_only_its_error`; `start_failure_error_survives_remount` — 새 보드 시작 실패(400 `칸 1: X`, 모킹) → 재마운트 후 칸 1 `⚠ X`(실제 `POST /start`는 설정 검증을 안 해 이 400을 내지 않는다 — spec이 정한 복원 경로를 모킹으로 고정).
- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller monitor; echo exit=$?`, `cd ui && pnpm test panelErrors MonitorEditPage; echo exit=$?`.
- [ ] **Step 3: 구현** — 서버: 칸 루프를 `enumerate`로 `validate_panel(p).map_err(|e| format!("칸 {}: {e}", i + 1))?`. UI: `valid()`가 시나리오 빈 칸마다 `panelErrors[id] = scenarioRequired`; `onSave`/`onStart` catch에서 `e instanceof ApiError && e.status === 400`이면 `parsePanelError` → 해당 칸 id에 사유; 오류 칸 id를 `expanded`에 추가; 저장/시작 시작 시 맵 비움; `setPanel(i, …)`이 그 칸 오류 삭제; 재마운트 초기값 = `startError`를 `parsePanelError`로. `PanelEditor`: prop `error?: string` 추가, 있으면 빨간 테두리(오류 우선) + 요약 대신 `` {`⚠ ${error}`} `` — **단일 텍스트 노드**로(`<span>⚠</span><span>{error}</span>`처럼 나누면 기존 `findByText(ko.monitor.scenarioRequired)`(`MonitorEditPage.test.tsx:333`·`:569`)가 중복 매치로 깨진다 — 필드 오류와 `⚠ …`는 정확 일치 문자열이 다르므로 단일 노드면 공존).
- [ ] **Step 4: GREEN + 게이트** — 위 명령 PASS, `cargo clippy -p handicap-controller --all-targets -- -D warnings; echo exit=$?`, UI 3종 게이트.
- [ ] **Step 5: 이빨** — `parsePanelError` 정규식 `^칸 `을 `^칸:`로 바꾸면 `server_panel_error_expands_and_marks_panel` RED → 원복.
- [ ] **Step 6: 커밋** `feat(monitor): 저장 오류 칸 번호 접두 + 오류 칸 자동 펼침`.

### Task 4: 오른쪽 고정 칸 목록 — spec §4.4

**Files:**
- Create: `ui/src/components/monitor/PanelNav.tsx`(+ `__tests__/PanelNav.test.tsx`)
- Modify: `ui/src/pages/MonitorEditPage.tsx`(2열 레이아웃·버튼 줄 `id`), `ui/src/i18n/ko.ts`(`navTitle`·`navJumpActions`)

**Interfaces:**
- Consumes: BoardForm `expanded`·`panelErrors`, 카드 `id="panel-{id}"`.
- Produces: `PanelNav({ panels, expanded, errors, onJump, onJumpActions }: { panels: PanelConfig[]; expanded: Set<string>; errors: Record<string,string>; onJump: (id: string) => void; onJumpActions: () => void })`. `onJump`(BoardForm 구현) = 펼침 집합에 추가 → 다음 렌더 후 `document.getElementById('panel-'+id)?.scrollIntoView({ block: "start" })` → 그 카드 토글 버튼 `focus()`. 버튼 줄 컨테이너 `id="monitor-actions"`.

- [ ] **Step 1: 실패 테스트** — `PanelNav.test.tsx`: 항목 `1 제목`/`2 (제목 없음)`, 오류 칸 `⚠`, 펼친 칸 항목 `aria-current="true"`(강조 판정용), 클릭 → `onJump(id)`, `저장 · 모니터 시작 ↓` → `onJumpActions`. `MonitorEditPage.test.tsx`: `nav_jump_expands_scrolls_and_focuses` — `Element.prototype.scrollIntoView = vi.fn()` 후 목록 `3` 클릭 → 칸 3 `aria-expanded="true"`·`scrollIntoView` 호출(`{block:"start"}`)·토글 포커스; `nav_jump_actions_scrolls_to_buttons` — `저장 · 모니터 시작 ↓` 클릭 → `#monitor-actions` 요소의 `scrollIntoView` 호출. (jsdom은 CSS가 없어 `hidden lg:block`이어도 목록이 렌더된다.)
- [ ] **Step 2: RED 확인** — `cd ui && pnpm test PanelNav MonitorEditPage; echo exit=$?`.
- [ ] **Step 3: 구현** — `BoardForm` 반환을 `<div className="lg:grid lg:grid-cols-[minmax(0,1fr)_14rem] lg:gap-6">` 왼쪽 본문 + `<aside className="hidden lg:block"><div className="sticky top-4 self-start">…</div></aside>`. 항목 = 버튼, 한 줄 말줄임(`truncate`), 펼친 칸 배경 + 왼쪽 막대(accent), 오류 칸 `⚠`.
- [ ] **Step 4: GREEN + UI 3종 게이트.**
- [ ] **Step 5: 이빨** — `onJump`에서 펼침 추가를 빼면 `nav_jump_expands_scrolls_and_focuses` RED → 원복.
- [ ] **Step 6: 커밋** `feat(monitor-ui): 설정 화면 오른쪽 고정 칸 목록`.

---

## 덩어리 B — ⑦ 막대 → 요청·응답 기록

### Task 5: 보드 단위 기록 상한 `record_limit_kb` — 서버 설정 + 설정 화면 필드 — spec §2.1·§4.5

**Files:**
- Modify: `crates/controller/src/monitor/config.rs`(필드·`Default`·검증)
- Modify: `ui/src/api/monitors.ts`(`BoardConfigSchema`), `ui/src/pages/MonitorEditPage.tsx`(초기 config + 다섯째 필드 + 힌트), `ui/src/i18n/ko.ts`(`recordLimit`·`recordLimitHint`·`recordLimitRange`)
- Create: `ui/src/monitor/recordLimit.ts`(+ 테스트)
- Modify(fixture, 같은 커밋 — **파일 5개 안의 인라인 `config:` 리터럴 전부**; `monitors.test.ts:76` 공유 `cfg`에도 넣어야 "`show_latency_stats` 없으면 throw" 단언이 계속 그 필드 하나만 증명): `ui/src/api/__tests__/monitors.test.ts`·`ui/src/pages/__tests__/MonitorEditPage.test.tsx`·`MonitorListPage.test.tsx`·`MonitorDisplayPage.test.tsx`·`MonitorDisplayPage.fullscreen.test.tsx`(확인 `grep -rln "show_latency_stats" ui/src --include='*.test.ts' --include='*.test.tsx'` → 이 5개)

**Interfaces:**
- Produces: `BoardConfig.record_limit_kb`(Rust `u32` / TS `number`). `pub const RECORD_LIMIT_KB_DEFAULT: u32 = 128;` `pub const RECORD_LIMIT_KB_RANGE: RangeInclusive<u32> = 16..=1024;`(config.rs).
- Produces: `worstCaseMb(panels: PanelConfig[], limitKb: number): string` — `Σ bar_count × limitKb / 1024`, `< 10`이면 `toFixed(1)`, 아니면 반올림 정수 `toLocaleString("en-US")`.

- [ ] **Step 1: 실패 테스트** — Rust: `record_limit_default_128`(`BoardConfig::default()` + 키 없는 옛 JSON 역직렬화), `record_limit_range` 표(15 거부·16 허용·1024 허용·1025 거부, 문구 `점검 기록 상한은 16~1024KB여야 합니다`, 접두 없음). UI: `recordLimit.test.ts` — 칸 1개 bar 10 × 16 → `"0.2"`, 칸 9개 bar 300 × 512 → `"1,350"`, 칸 1개 bar 60 × 128 → `"7.5"`; `MonitorEditPage.test.tsx` `record_limit_field_shows_hint_and_range_error` — `/monitors/new`: 기본 `128`, 힌트 `이 보드 최대 약 7.5 MB (본문 기준)`(기본 칸 bar 60), `2000` 입력 → `16~1024 사이로 입력하세요`; `/monitors/B1`(칸 bar 60, fixture `record_limit_kb: 128`): `512`로 저장 → **PUT** 본문 `config.record_limit_kb === 512`.
- [ ] **Step 2: RED 확인**(cargo + `pnpm test recordLimit MonitorEditPage`).
- [ ] **Step 3: 구현** — 필드·검증(보드 단위, 칸 루프 뒤)·Zod required·초기 config·5개 fixture에 `record_limit_kb: 128`·보드 설정 박스 다섯째 `Field`(`type="number" numeric min=16 max=1024`) + 힌트/범위 오류.
- [ ] **Step 4: GREEN + 게이트**(cargo test·clippy, UI 3종).
- [ ] **Step 5: 커밋** `feat(monitor): 보드 단위 점검 기록 상한 설정`.

### Task 6: 기록 가공 순수 함수 `build_record` — spec §3.2

**Files:**
- Create: `crates/controller/src/monitor/record.rs`(인라인 `#[cfg(test)]`), `crates/controller/tests/monitor_record_test.rs`(pending 테스트 — `monitor/mod.rs`엔 `#[cfg(test)]`가 없어 tdd-guard가 `pub mod record;` 편집을 막는다)
- Modify: `crates/controller/src/monitor/mod.rs`(`pub mod record;`), `crates/controller/src/monitor/config.rs`(`AUTH_HEADERS` → `pub(crate)`)

**Interfaces:**
- Produces:
  ```rust
  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
  #[serde(rename_all = "lowercase")]
  pub enum ClipSide { Request, Response }
  #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
  pub struct Clipped { pub step: u32, pub side: ClipSide }
  #[derive(Debug, Clone, Serialize)]
  pub struct CheckRecord { pub at_ms: i64, pub limit_kb: u32, pub result: CheckResult, pub trace: Option<ScenarioTrace>, pub clipped: Vec<Clipped> }
  pub const MASK: &str = "••••";
  pub fn build_record(result: &CheckResult, trace: Option<ScenarioTrace>, limit_kb: u32) -> CheckRecord;
  ```
  (`CheckResult`는 이미 `Clone`+`Serialize` — `check.rs:134`.)
- 내부 헬퍼(이름 구현 재량): 헤더 가림(spec §3.2-1 규칙 그대로), URL 사용자정보 구간 치환(§3.2-2), 문자 경계 자르기(`is_char_boundary` 뒤로 걷기).

- [ ] **Step 0: pending 통합 테스트** — `crates/controller/tests/monitor_record_test.rs`: `mask_constant_is_four_bullets` — `assert_eq!(handicap_controller::monitor::record::MASK, "••••")`(모듈 선언 전이라 컴파일 RED; `monitor`가 lib에서 `pub`인지 `grep -n "pub mod monitor" crates/controller/src/lib.rs`로 확인).
- [ ] **Step 1: 실패 테스트**(`record.rs`, `ScenarioTrace`/`StepTrace`/`TracedRequest`/`TracedResponse`를 직접 구성하는 헬퍼)
  - `mask_table`(Review Focus 3) — 헤더 값 가림 표: `authorization: Bearer x`→`Bearer ••••` · `Bearer `→`Bearer ` · `Bearer   `→`Bearer   ` · `x`→`••••` · `""`→`""` · `Authorization`(대문자 이름)도 동일 · `proxy-authorization: Basic y`→`Basic ••••` · `cookie: a=1; b=2`→`a=••••; b=••••` · `a=; b=2`→`a=; b=••••` · `abc123`→`••••` · 응답 `set-cookie: sid=x; Path=/`→`sid=••••` · `sid=; Max-Age=0`→`sid=` · `abc; Path=/`→`••••` · `set_cookies` 항목도 같은 규칙 · 비인증 `x-api-key: k`→`k`(원문).
  - `url_userinfo_table`: `https://u:p@h/x`→`https://u:••••@h/x` · `https://tok@h`→`https://••••@h` · `https://u:@h`→그대로 · `https://h/a@b`→그대로 · `https://h/경로?q=한글`→바이트 동일.
  - `vars_cleared`: `final_vars`·각 스텝 `extracted` 비움, `unbound_vars`·`error`·`truncated` 보존.
  - `budget_exact_not_clipped` / `budget_plus_one_clipped`: `limit_kb=16`, 응답 본문 16384바이트 → 안 잘림·`clipped` 빈; 16385 → 16384바이트로·`clipped == [{step:0, side:Response}]`.
  - `cut_on_char_boundary`: 예산 경계가 한글(3바이트) 중간 → 결과가 유효 UTF-8이고 길이 ≤ 예산, 경계 앞 문자까지.
  - `order_request_then_response_then_next_step`: 2스텝, 요청·응답 본문 각 10240바이트, `limit_kb=16`(예산 16384) → 0번 요청 원문(10240 소비), 0번 응답 6144바이트로 잘림(`{0,Response}`), 1번 요청·응답 빈 문자열 + `{1,Request}`·`{1,Response}` — `clipped` 순서도 이대로.
  - `empty_or_none_bodies_not_marked`: 예산 소진 뒤에도 원래 `""`·`None` 본문은 `clipped`에 없음.
  - `engine_truncated_flag_kept`: `body_truncated: true` 보존.
  - `none_trace_passes_through`: `trace None` → `trace None`·`clipped []`, `result` 전체 보존(reason·detail·display).
  - `serializes_wire_shape`: `serde_json::to_value` → `{"at_ms":…, "limit_kb":16, "result":{…}, "trace":null, "clipped":[]}` 키 5개, `ClipSide` → `"request"`/`"response"`.
- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller --lib monitor::record; echo exit=$?`.
- [ ] **Step 3: 구현** `build_record`(spec §3.2 1–7 순서).
- [ ] **Step 4: GREEN + clippy.**
- [ ] **Step 5: 이빨** — 헤더 이름 비교를 대소문자 구분(`==`)으로 바꾸면 `mask_table` RED → 원복.
- [ ] **Step 6: 커밋** `feat(monitor): 점검 기록 가공 — 인증 값 가림·변수 폐기·본문 상한`.

### Task 7: 감독자 기록 보관 + 기록 조회 API + ADR 보완 — spec §2.4·§3.1·§10

**Files:**
- Modify: `crates/controller/src/monitor/supervisor.rs`(`PanelBuf.records`·`finish`·`panel_loop`·`spawn_panel`·`record()`·기존 `panel_loop` 테스트 호출부 6곳 :428·:467·:500·:531·:559·:597)
- Modify: `crates/controller/src/api/monitor_boards.rs`(핸들러 `record`), `crates/controller/src/app.rs`(라우트)
- Modify: `crates/controller/tests/monitor_boards_api_test.rs`
- Modify: `docs/adr/0053-*.md`(spec §10 보완 절 그대로 append)

**Interfaces:**
- Consumes: Task 6 `build_record`·`CheckRecord`, Task 5 `record_limit_kb`.
- Produces:
  - `pub(crate) async fn panel_loop<F, Fut>(interval: Duration, bar_count: usize, check: F, buf: SharedBuf, token: CancellationToken) where Fut: Future<Output = (CheckResult, Arc<CheckRecord>)>`.
  - `RunningGuard::finish(self, result: CheckResult, record: Arc<CheckRecord>, bar_count: usize)` — 한 락 안에서 `results` push(기존 `BUFFER_CAP` 처리) + `records` push + `while records.len() > bar_count { evicted.push(pop_front) }`; 락 해제 **뒤** `drop(evicted)`.
  - `fn spawn_panel(db, panel, record_limit_kb: u32, buf, token, live, checks)` — 클로저 `let (trace, result) = run_check(&db, &panel).await; let rec = Arc::new(build_record(&result, trace, record_limit_kb)); (result, rec)`.
  - `pub async fn record(&self, board_id: &str, panel_id: &str, at_ms: i64) -> Option<Arc<CheckRecord>>` — `existing_slot` 전용.
  - REST `GET /api/monitor-boards/{id}/panels/{panel_id}/records/{at_ms}` → 200 = `serde_json::to_vec(&*rec)` + `content-type: application/json` / 404 `ApiError::NotFound`.

- [ ] **Step 1: 실패 테스트**
  - `supervisor.rs`: `records_trim_to_bar_count_at_once`(Review Focus 4) — `bar_count` 5로 기록 5개 채운 뒤 `bar_count` 2로 `finish` 1회 → `records.len() == 2`(가장 최근 2개 `at_ms`); `record_lookup_hit_and_miss`; `record_on_unknown_board_creates_no_slot` — `record("nope", …)` 뒤 `inner.boards` 크기 불변; `record_none_after_board_disabled`(reconcile로 끈 뒤 `None`); `snapshot_has_no_records_field_change`(기존 snapshot 테스트가 그대로 통과 — 별도 단언 불필요하면 생략 가). 기존 `panel_loop` 테스트 6곳은 새 시그니처로(점검 클로저가 `(result, Arc::new(build_record(&result, None, 128)))` 반환, `bar_count` = 300).
  - 통합(`monitor_boards_api_test.rs`, wiremock — 기존 파일 헬퍼 재사용): `record_endpoint_returns_masked_record` — 시나리오 요청 헤더 `Authorization: Bearer s3cret`(엔진은 헤더 이름 대소문자를 그대로 보존 — `executor.rs:446`; 기존 `create_scenario` 헬퍼(`:58`)는 헤더를 못 넣으므로 헤더를 받는 변형 헬퍼를 추가), 응답 `{"ok":true}` → 보드 시작 → `/status` 첫 결과 `at_ms` 폴링 → 기록 200: `trace.steps[0].request.headers["Authorization"] == "Bearer ••••"`, `trace.steps[0].response.body == "{\"ok\":true}"`, `clipped == []`, `limit_kb == 128`, `result.at_ms == at_ms`; `record_endpoint_404s` — 없는 `at_ms`·없는 칸·꺼진 보드·없는 보드 각각 404; `record_uses_board_limit` — 보드 `record_limit_kb: 512`로 시작 → 기록 `limit_kb == 512`(US5 배선).
- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller monitor; echo exit=$?`, `cargo test -p handicap-controller --test monitor_boards_api_test; echo exit=$?`.
- [ ] **Step 3: 구현** — Interfaces대로. `reconcile_slot`의 `spawn_panel` 호출에 `row.config.record_limit_kb`. 라우트는 `app.rs`의 `/monitor-boards/{id}/status` 옆. 모듈 문서(`monitor_boards.rs` 머리)에 새 경로 한 줄.
- [ ] **Step 4: ADR** — `docs/adr/0053-*.md` 끝에 spec §10 절 그대로.
- [ ] **Step 5: GREEN + 게이트** — `cargo fmt --check; echo exit=$?`, `cargo clippy --workspace --all-targets -- -D warnings; echo exit=$?`, `cargo nextest run -p handicap-controller; echo exit=$?`.
- [ ] **Step 6: 이빨** — `while`을 `if`로 바꾸면 `records_trim_to_bar_count_at_once` RED → 원복; `record()`에서 `existing_slot`을 `slot`으로 바꾸면 `record_on_unknown_board_creates_no_slot` RED → 원복; `spawn_panel` 인자를 `RECORD_LIMIT_KB_DEFAULT`로 고정하면 `record_uses_board_limit` RED → 원복.
- [ ] **Step 7: 커밋** `feat(monitor): 점검 기록 메모리 보관 + 기록 조회 API`.

### Task 8: 기록 창 `CheckRecordDialog` + API 클라이언트 + `JsonValueTree` 읽기 전용 — spec §5.3·§5.4

**Files:**
- Modify: `ui/src/api/monitors.ts`(`CheckRecordSchema`·`getRecord`), `ui/src/components/response/JsonValueTree.tsx`, `ui/src/monitor/time.ts`(`formatDateHms`), `ui/src/i18n/ko.ts`(`record*` 키)
- Create: `ui/src/components/monitor/CheckRecordDialog.tsx`(+ `__tests__/CheckRecordDialog.test.tsx`), `ui/src/components/monitor/RecordBody.tsx`(인라인 본문 블록)
- Test: `ui/src/components/response/__tests__/sharedResponse.test.tsx`(기존 — `JsonValueTree` 케이스 추가), `ui/src/api/__tests__/monitors.test.ts`

**Interfaces:**
- Produces: `CheckRecordSchema = z.object({ at_ms: z.number(), limit_kb: z.number(), result: CheckResultSchema, trace: ScenarioTraceSchema.nullable(), clipped: z.array(z.object({ step: z.number().int(), side: z.enum(["request","response"]) })) })`; `getRecord(boardId: string, panelId: string, atMs: number): Promise<CheckRecord>`(404 → `ApiError` status 404 그대로 throw).
- Produces: `formatDateHms(ms: number): string` → 로컬 `YYYY-MM-DD HH:MM:SS`.
- Produces: `CheckRecordDialog({ boardId, panel, clicked, onClose }: { boardId: string; panel: PanelConfig; clicked: CheckResult; onClose: () => void })` — 항상 열린 상태로 렌더(부모가 조건부 마운트 → 닫으면 언마운트되어 `보기` 상태 초기화). 루트는 기존 `Modal`(`open`, 제목 `recordTitle(panel.title, formatDateHms(clicked.at_ms))`).
- `JsonValueTree`: `actionLabel?`·`renderConfirm?` — 둘 중 하나라도 없으면 잎 버튼 미렌더.
- `RecordBody({ body, clippedKb, engineTruncated }: { body: string; clippedKb: number | null; engineTruncated: boolean })` — spec §5.3 본문 규칙(64KB = `new TextEncoder().encode(body).length`, `parseBodyJson` 재사용, 최대 높이 + 내부 스크롤, `BodyBlock` 사용 금지).

- [ ] **Step 1: 실패 테스트**
  - `sharedResponse.test.tsx`: `json_value_tree_no_action_renders_no_buttons` — `actionLabel` 없이 렌더 → `queryAllByRole("button")` 0; 기존 호출 형태는 버튼 있음.
  - `monitors.test.ts`: `record_schema_parses_server_shape` — `trace: null`·`clipped: []` 포함 객체 파싱 성공, `clipped` 누락 → 실패.
  - `CheckRecordDialog.test.tsx`(`getRecord` 모킹, React Query wrapper):
    - `header_shows_clicked_result_immediately`(로딩 중에도 `stateFail`·`1,234 ms`) + 로딩 `ko.monitor.loading`; `header_reason_from_record`(누른 막대 `reason: null` → 기록 도착 후 기록 `result.reason`·`detail` 표시).
    - `step_row_loop_chip_and_error`: `loop_index: 2` → `#2` 칩, 스텝 `error` → 빨간 오류 문구.
    - `time.test.ts`(없으면 `ui/src/monitor/__tests__/time.test.ts` 생성): `formatDateHms` 로컬 `YYYY-MM-DD HH:MM:SS`(TZ 무관하게 `new Date(y,m,d,h,mi,s).getTime()`으로 입력).
    - `missing_record_shows_message`(404) · `load_error_shows_message`(500).
    - `null_trace_config_error` / `null_trace_timeout` · `trace_error_line` · `truncated_trace_notice`.
    - `steps_collapsed_by_default_single_step_expanded`: 2스텝 → 둘 다 접힘(헤더 표 없음), 1스텝 → 펼침.
    - `step_row_summary`: `스텝 이름 · GET https://h/x · 200 · 12 ms`(이름은 `useScenarios` 모킹 시나리오에서), 이름 없으면 `step_id`; if 행 `조건 분기 → ` + `branchText("then")`.
    - `masked_hint_only_when_masked`.
    - `request_body_hidden_until_reveal_and_rehidden_on_reopen`(Review Focus 3): 요청 본문 `{"pw":"p"}` 텍스트 없음 + `recordReqBodyHidden` → `보기` 클릭 → `"p"` 보임·버튼 `가리기` → 언마운트·재마운트 → 다시 가림.
    - `clipped_body_shows_limit_notice`(`clipped:[{step:0,side:"response"}]`, `limit_kb:128` → `기록 상한 128KB에서 잘림`) · `engine_truncated_notice`.
    - `large_json_body_shows_raw_not_tree`(Review Focus 5): 70KB JSON → `<pre>` + `recordTreeTooLarge`, 트리 토글 없음; 1KB JSON → 트리 기본 + `원문` 토글; 감싼 JSON → `previewUnwrapped`.
- [ ] **Step 2: RED 확인** — `cd ui && pnpm test sharedResponse monitors CheckRecordDialog; echo exit=$?`.
- [ ] **Step 3: 구현** — Interfaces대로. React Query 키 `["monitor-record", boardId, panel.id, clicked.at_ms]`, `staleTime: Infinity`, `retry: false`. 스텝 이름 = `useScenarios()` → `panel.scenario_id` 시나리오 → `parseScenarioDoc`+`flattenHttpSteps`(`PanelEditor`와 같은 방법). 헤더는 `HeaderTable`(action 없이). 스텝 줄은 `<button aria-expanded>`; 요청 본문 `보기` 상태는 스텝별 로컬 `useState`.
- [ ] **Step 4: GREEN + UI 3종 게이트.**
- [ ] **Step 5: 이빨** — 요청 본문 기본값을 드러냄으로 바꾸면 `request_body_hidden_until_reveal_and_rehidden_on_reopen` RED → 원복.
- [ ] **Step 6: 커밋** `feat(monitor-ui): 점검 기록 창(요청 본문 기본 가림)`.

### Task 9: 막대 클릭 오버레이 + 벽 연결 + 전체화면 예외 — spec §5.1·§5.2

**Files:**
- Modify: `ui/src/components/monitor/LatencyBars.tsx`(오버레이 층), `ui/src/components/monitor/MonitorPanel.tsx`(`onSelect` 전달), `ui/src/pages/MonitorDisplayPage.tsx`(창 상태·전체화면 예외)
- Test: `ui/src/components/monitor/__tests__/LatencyBars.test.tsx`, `ui/src/pages/__tests__/MonitorDisplayPage.test.tsx`, `ui/src/pages/__tests__/MonitorDisplayPage.fullscreen.test.tsx`

**Interfaces:**
- Consumes: Task 8 `CheckRecordDialog`, `formatHms`(`ui/src/monitor/time.ts`).
- Produces: `LatencyBars` prop `onSelect?: (r: CheckResult) => void`. 오버레이: 막대 영역 컨테이너 안 `absolute inset-0 flex` 층(막대 층과 같은 `barSlots(results, barCount)`·같은 `slotPad`), **결과 있는 열에만** `data-bar-hit=""`·`onClick`·`cursor: pointer`(빈 열은 속성 없음 — 전체화면에서 빈 열 누름은 현행대로 전체화면 종료, 죽은 영역 방지), hover 열 강조 + 막대 영역 위쪽 `HH:MM:SS` 라벨(`pointer-events: none`, `data-testid="bar-hover-time"`). 막대 층 DOM·스타일 무변경, `onSelect` 없으면 오버레이 없음.
- `MonitorPanel` prop `onSelectResult?: (r: CheckResult) => void` → `LatencyBars.onSelect`. `MonitorDisplayPage` 상태 `selected: { panel: PanelConfig; result: CheckResult } | null` + ref `recordOpenRef`(전체화면 `mousedown` 리스너가 읽음).

- [ ] **Step 1: 실패 테스트**
  - `LatencyBars.test.tsx`: `overlay_click_selects_result`(결과 3개·`barCount` 5 → `[data-bar-hit]` 3개, 그중 마지막(오른쪽 끝) 클릭 → `onSelect`가 최신 결과), `empty_column_not_clickable`(빈 열에 `data-bar-hit` 없음), `no_overlay_without_onSelect`(`[data-bar-hit]` 0), `hover_shows_time`(`mouseEnter` → `bar-hover-time` 텍스트 `formatHms(at_ms)`), `bar_layer_unchanged_with_overlay`(`onSelect` 유무로 `[data-testid=bar-slot]` 들의 `style` 문자열 동일).
  - `MonitorDisplayPage.test.tsx`: `bar_click_opens_record_dialog`(`getRecord` 모킹 → 대화상자 제목 `칸 제목 · YYYY-MM-DD …`), `dialog_open_keeps_polling`(열린 채 `getBoardStatus` 호출 수 증가).
  - `MonitorDisplayPage.fullscreen.test.tsx`(기존 전체화면 모킹 재사용): `mousedown_on_bar_keeps_fullscreen`, `mousedown_while_dialog_open_keeps_fullscreen`, `mousedown_elsewhere_still_exits`(현행).
- [ ] **Step 2: RED 확인** — `cd ui && pnpm test LatencyBars MonitorDisplayPage; echo exit=$?`.
- [ ] **Step 3: 구현** — Interfaces대로. `onDown`: `if (recordOpenRef.current) return; if ((e.target as Element | null)?.closest?.("[data-bar-hit]")) return;` 뒤 현행. `selected`가 있으면 `<CheckRecordDialog boardId panel clicked={result} onClose={() => setSelected(null)} />` 조건부 마운트, `recordOpenRef.current = selected !== null` 동기화.
- [ ] **Step 4: GREEN + UI 3종 게이트.**
- [ ] **Step 5: 이빨** — `onDown`에서 `[data-bar-hit]` 예외를 빼면 `mousedown_on_bar_keeps_fullscreen` RED → 원복; ref 대신 state를 읽게 바꾸면(리스너 1회 등록) `mousedown_while_dialog_open_keeps_fullscreen` RED → 원복.
- [ ] **Step 6: 커밋** `feat(monitor-ui): 막대 클릭으로 점검 기록 창 열기(전체화면 유지)`.

---

## 구현 후 (파이프라인 4–6단계 — task 아님)

1. **최종 리뷰** `handicap-reviewer`(BASE = 첫 task 디스패치 직전 커밋) — 초점: 와이어 1:1(`CheckRecord` Rust↔Zod), 감독자 락 순서·기록 해제 위치, `/status` 무변경, 재마운트 state, "옛 동작에 기대던 소비자"(`panel_loop` 시그니처·`AUTH_HEADERS` 가시성).
2. **보안 게이트** `security-reviewer` **필수**(spec §6 — ephemeral → retained 새 sink). 잔여 위험은 roadmap §B에 비용+해소 경로로.
3. **라이브** `/live-verify` — spec §9 라이브 행 전부(US1–US6 척추, ⑥/DW와 ⑦ 행 분리, 극단값, 모든 마운트 화면, 전체화면 ESC 실측).
4. `/finish-slice` — build-log·roadmap(§B 판단·잔여)·현황판·상태줄·메모리.
