# 시나리오 그룹 (scenario-groups) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오마다 그룹 이름 한 칸을 두어 목록·선택 칸에서 묶어 보이게 하고, 여러 개를 한 번에 옮기고 그룹 이름을 바꿀 수 있게 한다.

**Architecture:** `scenarios.group_name`(NULL 허용) 칸 하나 + 전용 API 두 개(`assign`·`rename`). 그룹은 내용이 아니므로 시나리오 `version`·`updated_at`·YAML을 건드리지 않는다. 화면은 순수 함수 `ui/src/scenario/grouping.ts` 하나로 묶고, 목록·선택 칸 3곳이 그것을 공유한다.

**Tech Stack:** Rust(axum 0.8·sqlx/SQLite) · TypeScript/React(Zod·React Query·Tailwind·vitest/RTL) · TUI 와이어 거울(serde).

**Spec:** `docs/superpowers/specs/2026-11-20-scenario-groups-design.md` — 사용자 스토리(US1–5)와 화면 규칙의 정본. 목업: `docs/superpowers/specs/2026-11-20-scenario-groups-mockups/scenario-groups.html`(모양 참고용, 규범은 spec).

REVIEW-GATE: APPROVED

(spec — spec-plan-reviewer 3회차 APPROVE, plan — 3회차 APPROVE, 2026-11-20. spec은 승인 뒤 사용자 결정 두 가지[버튼 이름 「그룹 지정」 통일·안내 줄]만 반영했고 plan 리뷰가 그 상태를 함께 읽었다.)

## Global Constraints

- 엔진·워커·proto·시나리오 YAML 무변경. 새 테이블 없음.
- 그룹 이름: 앞뒤 공백(`char::is_whitespace` 또는 U+FEFF)을 자르고, 비면 "그룹에 넣지 않음"(`NULL`/`null`). **40 코드 포인트** 초과 거부. `is_forbidden_text_char`(`crates/controller/src/monitor/config.rs`) 글자와 안쪽 U+FEFF 거부. 대소문자 보존.
- `assign` 한 번에 **1–500개**. `assign`·`rename`은 `version`·`updated_at`을 바꾸지 않는다.
- 「그룹 없음」이라는 말을 화면에 쓰지 않는다. 그룹이 없을 때 버튼 글자는 「그룹 지정」.
- 화면 문구는 전부 `ui/src/i18n/ko.ts` 경유(`aria-label` 포함). 아래 [문구 표](#문구-표-koscenariogroups--글자-그대로)를 글자 그대로 쓴다.
- 그룹이 하나도 없으면 목록의 행·순서·기존 동작(복제·삭제·실행 목록)과 선택 칸 3곳의 DOM이 지금과 같다.
- 커밋: `--no-verify` 금지, 커밋·게이트에 `| tail`/`| head` 금지, 메시지는 `-F <파일>`, 커밋 뒤 `git log -1`로 확인. implementer의 커밋은 단일 FOREGROUND 호출(timeout 600000ms). 워크트리 안에서는 단독 git 명령만(`cd … &&`·`;` 복합 금지).
- 회귀를 지킨다고 내세우는 테스트는 **되돌려 확인**(고친 코드를 일부러 되돌려 RED → 원복 GREEN)을 실행하고 결과를 보고에 적는다. 대상은 각 task에 표시.
- 결함을 변호하는 주석 금지(코드로 고친다). `tdd-guard` 때문에 **각 task의 첫 편집은 테스트 파일**이다.
- UI 테스트 파일은 반드시 `__tests__/` 아래(`vitest include`). ES2023 배열 메서드(`findLast` 등) 금지(tsconfig lib ES2022).

## Review Focus

spec이 암시하지만 task 테스트가 놓치기 쉬운 입력. 각 줄의 테스트는 표시한 task에 넣는다.

1. **공백만 있는 그룹 이름**(`"   "`, 전각 공백, U+FEFF만) → 빈 이름의 그룹이 생기지 않고 "그룹에 넣지 않음"이 된다. (Task 2 서버 표 · Task 4 UI 표)
2. **검색으로 가려진 채 체크된 시나리오** → 「전체 선택」은 지금 검색에 맞는 것만 바꾸고, 가려진 선택은 유지되며 개수 표시에 들어간다. (Task 9)
3. **체크해 둔 시나리오가 다른 곳에서 지워진 뒤 목록을 다시 읽음** → 선택에서 빠지고 개수가 줄어든다. (Task 9)
4. **localStorage 값이 깨졌거나(JSON 아님·배열 아님·문자열 아닌 원소) 접근이 throw** → 목록이 정상으로 그려지고 전부 펼쳐진다. (Task 6)
5. **내용 저장(PUT) 직후의 편집 화면** → 그룹 버튼이 그대로다(PUT 응답이 그룹을 싣는다). (Task 2 서버 · Task 7 화면)

## 문구 표 (`ko.scenarioGroups`) — 글자 그대로

| 키 | 값 |
|---|---|
| `searchPlaceholder` | `이름으로 검색` |
| `searchEmpty` | `검색 결과가 없습니다` |
| `createHint` | `묶고 싶은 시나리오를 체크한 뒤 「그룹 지정」을 누르면 그룹이 만들어집니다.` |
| `selectedCount(n)` | `${n}개 선택됨` |
| `assign` | `그룹 지정` |
| `clearSelection` | `선택 해제` |
| `tooMany` | `한 번에 500개까지 옮길 수 있습니다` |
| `assignManyText(n)` | `고른 시나리오 ${n}개를 옮길 그룹을 정해 주세요. 비워 두면 그룹에서 뺍니다.` |
| `assignOneText` | `이 시나리오를 넣을 그룹을 정해 주세요. 비워 두면 그룹에서 뺍니다.` |
| `apply` | `적용` |
| `chip(name)` | `그룹: ${name}` |
| `fieldLabel` | `그룹 이름` |
| `fieldPlaceholder` | `비워 두면 그룹에 넣지 않습니다` |
| `errTooLong` | `그룹 이름은 40자까지 쓸 수 있습니다` |
| `errForbidden` | `그룹 이름에 쓸 수 없는 글자가 들어 있습니다` |
| `rename` | `이름 바꾸기` |
| `renameTitle` | `그룹 이름 바꾸기` |
| `renameText(name)` | `「${name}」 그룹의 새 이름을 입력해 주세요.` |
| `renameOk` | `바꾸기` |
| `mergeHint(a, b)` | `이미 있는 그룹입니다. 바꾸면 두 그룹이 합쳐집니다(${a}개 + ${b}개).` |
| `mergeOk` | `합치기` |
| `selectAll` | `전체 선택` |
| `selectRow(name)` | `${name} 선택` |
| `selectGroup(name)` | `${name} 그룹 전체 선택` |
| `groupCount(n)` | `(${n})` |
| `failed(msg)` | `그룹을 바꾸지 못했습니다: ${msg}` |

서버의 400 사유도 `errTooLong`·`errForbidden`과 같은 글자를 쓴다. 「취소」는 기존 `ko.common.cancel`. 그룹을 정하는 창(`GroupDialog`)의 제목은 일괄·한 개 모두 `assign`(「그룹 지정」).

## 파일 구성

| 파일 | 책임 |
|---|---|
| `crates/controller/src/store/mod.rs` | migration 0026 가드(`ensure_scenarios_group_name`) + 배선 |
| `crates/controller/src/store/scenarios.rs` | `ScenarioRow.group`, `insert_grouped`, `assign_group`, `rename_group`, 읽기 3곳·`update`가 그룹을 싣기 |
| `crates/controller/src/api/scenario_groups.rs` (신규) | `normalize_group`, `assign`·`rename` 핸들러 |
| `crates/controller/src/api/scenarios.rs` | `ScenarioResponse.group`, `CreateRequest.group` |
| `crates/controller/src/api/mod.rs`, `crates/controller/src/app.rs` | 모듈 등록, 라우트 2개 |
| `crates/controller/tests/scenario_groups_api_test.rs` (신규) | API 통합 테스트 |
| `crates/tui/src/wire.rs` | `ScenarioResponse.group` 거울 |
| `ui/src/api/schemas.ts`, `client.ts`, `hooks.ts` | 와이어·호출·캐시 |
| `ui/src/scenario/grouping.ts` (신규) | 묶기·검색·이름 규칙(순수 함수) |
| `ui/src/scenario/groupPrefs.ts` (신규) | 접힘 기억(localStorage) |
| `ui/src/components/scenario-groups/GroupField.tsx`·`GroupDialog.tsx`·`RenameGroupDialog.tsx`·`GroupButton.tsx`·`ScenarioOptions.tsx` (신규) | 공용 그룹 입력·창·버튼·선택 칸 항목 |
| `ui/src/pages/ScenarioListPage.tsx` | 묶음 목록·검색·체크·띠 |
| `ui/src/pages/ScenarioEditPage.tsx`, `ScenarioNewPage.tsx` | 그룹 버튼 |
| `ui/src/components/run/ScheduleForm.tsx`, `ui/src/pages/SchedulesPage.tsx`, `ui/src/components/monitor/PanelEditor.tsx`, `GroupBox.tsx` | 선택 칸 묶기 |
| `docs/adr/0060-scenario-groups.md`, 루트 `CLAUDE.md` | 결정 기록 |

---

### Task 1: 저장 — migration 0026과 store 함수

**Files:**
- Modify: `crates/controller/src/store/mod.rs`(0025 배선 줄 뒤 + `ensure_runs_label` 옆에 가드 함수 + 테스트)
- Modify: `crates/controller/src/store/scenarios.rs`

**Interfaces:**
- Produces:
  - `ScenarioRow { …, pub group: Option<String> }`
  - `pub async fn insert_grouped(db: &Db, scenario: &Scenario, yaml: &str, group: Option<&str>) -> sqlx::Result<ScenarioRow>` — `insert`는 이것을 `None`으로 부르는 얇은 함수로 남는다(호출 19곳 무변경).
  - `pub async fn assign_group(db: &Db, ids: &[String], group: Option<&str>) -> sqlx::Result<u64>` — WHERE에 맞은 행 수. `ids`가 비면 0.
  - `pub async fn rename_group(db: &Db, from: &str, to: &str) -> sqlx::Result<u64>`
  - `get`·`list`·`update`의 `ScenarioRow`가 DB의 `group_name`을 싣는다.

- [ ] **Step 1: 실패하는 테스트 쓰기** — `store/mod.rs`의 `mod tests`에 `ensure_scenarios_group_name_is_idempotent`(`ensure_runs_label_is_idempotent`와 같은 모양: `MIGRATION_SQL_0001`만 실행한 DB에 가드를 두 번 부르고 `pragma_table_info('scenarios')`에 `group_name`이 정확히 1개). `store/scenarios.rs`에 `#[cfg(test)] mod group_tests`:

```rust
// db = super::super::connect("sqlite::memory:") 로 만든 완전한 스키마
#[tokio::test] async fn insert_defaults_to_no_group()        // insert(..) → get(..).group == None
#[tokio::test] async fn insert_grouped_round_trips()         // Some("서비스A") → get·list 둘 다 Some("서비스A")
#[tokio::test] async fn assign_sets_and_clears_without_touching_version() {
    // a,b,c 삽입 → 직접 UPDATE로 세 행을 updated_at = 1, version = 7 로 맞춘다
    //   (삽입과 같은 밀리초에 assign이 돌면 updated_at을 건드려도 값이 같아 못 잡는다)
    // assign_group(&[a,b,"없는ID"], Some("G")) == 2 ; a,b = Some("G"), c = None
    // assign_group(&[a], None) == 1 ; a = None
    // a,b,c 모두 여전히 updated_at == 1, version == 7
}
#[tokio::test] async fn assign_empty_ids_is_zero()
#[tokio::test] async fn rename_moves_all_and_merges() {
    // a,b ∈ "A", c ∈ "B" → rename_group("A","B") == 2 → 셋 다 Some("B")
    // rename_group("없는그룹","X") == 0
}
#[tokio::test] async fn update_returns_stored_group() {
    // insert_grouped(.., Some("G")) → update(..) → Updated(row).group == Some("G")
    // 그리고 뒤이은 get(..).group == Some("G")
}
```

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller group_tests ensure_scenarios_group_name` → 컴파일 실패(함수·필드 없음).
- [ ] **Step 3: 구현**
  - `ensure_scenarios_group_name(db)`: `pragma_table_info('scenarios')`에 `group_name`이 없을 때만 `ALTER TABLE scenarios ADD COLUMN group_name TEXT`. 문서 주석 `/// migration 0026 (Rust-guarded): scenarios.group_name (nullable).` `connect()`에서 `ensure_runs_auto_stop_json` 줄 바로 뒤에 `ensure_scenarios_group_name(&pool).await?; // migration 0026 (Rust-guarded; see fn)`.
  - `get`·`list`의 SELECT에 `group_name` 추가. `update`는 `created_at`을 다시 읽는 SELECT를 `SELECT created_at, group_name`으로 넓혀 응답 행에 싣는다(UPDATE 문은 `group_name`을 쓰지 않는다).
  - `assign_group`: `ids`가 비면 `Ok(0)`. 아니면 `UPDATE scenarios SET group_name = ? WHERE id IN (?,…)`(자리표시는 개수만큼, 값은 전부 바인딩 — `yaml_by_ids` 모양). `rows_affected()` 반환.
  - `rename_group`: `UPDATE scenarios SET group_name = ? WHERE group_name = ?`.
  - `insert_with_id`(보드 파일 가져오기)는 그대로 둔다 → `NULL`.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS. 이어서 `cargo build --workspace --tests`(`ScenarioRow {` 리터럴 누락이 없는지).
- [ ] **Step 5: 되돌려 확인** — `update`의 응답 행을 `group: None`으로 잠시 바꿔 `update_returns_stored_group`이 RED인지, `assign_group`에 `updated_at = <지금>`을 잠시 넣었을 때, 그리고 따로 `version = version + 1`을 잠시 넣었을 때 각각 `assign_sets_and_clears_without_touching_version`이 RED인지 본 뒤 원복.
- [ ] **Step 6: 커밋** — `feat(controller): scenarios.group_name 칸(migration 0026) + 그룹 store 함수`

---

### Task 2: API — 응답 필드·만들 때 그룹·assign·rename + TUI 거울

서버가 응답에 새 키를 보내는 순간 TUI 거울(`deny_unknown_fields`)이 깨지므로 **같은 커밋**에 넣는다(`crates/tui/tests/edit_api_test.rs`·`save_flow_test.rs`가 실제 컨트롤러를 띄워 읽는다).

**Files:**
- Create: `crates/controller/src/api/scenario_groups.rs`, `crates/controller/tests/scenario_groups_api_test.rs`, `testdata/group_name_cases.json`
- Modify: `crates/controller/src/api/scenarios.rs`, `crates/controller/src/api/mod.rs`, `crates/controller/src/app.rs`, `crates/tui/src/wire.rs`

**Interfaces:**
- Consumes: Task 1의 store 함수.
- Produces(와이어):
  - `ScenarioResponse`에 `group: Option<String>` — `skip_serializing_if` 없음(항상 `null` 또는 문자열). POST·GET(단건·목록)·PUT 응답 전부.
  - `POST /api/scenarios` 요청 `{ "yaml": "...", "group"?: string | null }`.
  - `POST /api/scenario-groups/assign` 요청 `{ "scenario_ids": [string], "group": string | null }`(`group` 키 필수) → 200 `{ "updated": number }`.
  - `POST /api/scenario-groups/rename` 요청 `{ "from": string, "to": string }` → 200 `{ "updated": number }`.
  - `pub fn normalize_group(input: Option<&str>) -> Result<Option<String>, String>`, `pub const MAX_GROUP_CHARS: usize = 40`, `pub const MAX_ASSIGN_IDS: usize = 500`.

- [ ] **Step 1: 실패하는 테스트 쓰기**
  - 이름 규칙 표는 **파일 하나**(`testdata/group_name_cases.json`, repo 루트 — `compare_golden.json` 선례)에 두고 서버와 UI 테스트가 같이 읽는다. 원소 모양 `{ "input": string | null, "expect": "none" | "too_long" | "forbidden" | { "value": string } }`. 다루기 힘든 글자는 JSON `\uXXXX`로 쓴다.
  - `api/scenario_groups.rs` 인라인 `mod tests`가 그 파일을 `include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../testdata/group_name_cases.json"))`로 읽어 전 원소를 대조한다. 파일에 넣을 경우(아래 표 + `"가"`×41 안에 금지 글자가 하나 든 입력 → `too_long`, 길이 검사가 먼저다):

    | 입력 | 기대 |
    |---|---|
    | `None` | `Ok(None)` |
    | `""`, `"   "`, `"\u{3000}"`, `"\u{FEFF}"`, `"\u{0085}"` | `Ok(None)` |
    | `"  서비스A  "`, `"\u{FEFF}서비스A\u{0085}"` | `Ok(Some("서비스A"))` |
    | `"서비스a"` | `Ok(Some("서비스a"))` (대소문자 보존) |
    | `"가"`×40, `"😀"`×40 | `Ok(Some(..))` |
    | `"가"`×41 | `Err("그룹 이름은 40자까지 쓸 수 있습니다")` |
    | `"a\u{0007}b"`, `"a\u{202E}b"`, `"a\u{2028}b"`, `"a\u{FEFF}b"` | `Err("그룹 이름에 쓸 수 없는 글자가 들어 있습니다")` |

  - `tests/scenario_groups_api_test.rs`(앱 구성은 `scenario_delete_api_test.rs`의 `make_app` 모양, `NoopDispatcher`). 본문 검사는 `serde_json::Value`로 하고 **키 존재는 `as_object().unwrap().contains_key("group")`**(`Value` Index는 없는 키도 `Null`):

```rust
create_without_group_returns_null_group_key      // 201, contains_key("group"), is_null
create_with_group_stores_trimmed                 // group "  서비스A " → 응답·GET 둘 다 "서비스A"
create_with_bad_group_is_400                     // 41자 → 400, 목록에 안 생김
list_and_get_carry_group_key
put_response_carries_stored_group                // create(group G) → PUT(yaml 바꿈) 응답 본문 group == "G"
assign_many_and_clear                            // 2개 + 없는 ID → {"updated":2}; 다시 group:null → 빠짐
assign_keeps_version_and_updated_at              // GET 응답의 version·updated_at을 assign 전후로 비교하되, 전에 2ms 이상 쉬어(tokio::time::sleep) 같은 밀리초 우연을 없앤다
assign_without_group_key_is_422_and_changes_nothing   // {"scenario_ids":[a]} → 422, a의 그룹 그대로
assign_zero_ids_is_400 / assign_501_ids_is_400
assign_bad_group_is_400
rename_moves_and_merges                          // {"updated":n}; 합쳐짐
rename_missing_group_is_zero
rename_same_name_is_400 / rename_blank_from_or_to_is_400
```

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --test scenario_groups_api_test`(통합)와 `cargo nextest run -p handicap-controller --lib scenario_groups`(인라인 표) → 컴파일 실패. 이름 필터만으로는 통합 테스트가 안 잡힌다(테스트 이름에 `scenario_groups`가 없다).
- [ ] **Step 3: 구현**
  - `normalize_group`: 자르는 술어는 `|c: char| c.is_whitespace() || c == '\u{FEFF}'`(`trim_matches`). 글자 수는 `chars().count()`. 금지 판정은 `crate::monitor::config::is_forbidden_text_char(c) || c == '\u{FEFF}'`(경로는 실제 공개 경로에 맞춘다).
  - `AssignRequest { scenario_ids: Vec<String>, #[serde(deserialize_with = "Option::deserialize")] group: Option<String> }` — 키가 없으면 axum `Json` 추출기가 422. `scenario_ids.len()`이 `1..=MAX_ASSIGN_IDS` 밖이면 `ApiError::BadRequest`.
  - `rename`: `from`·`to` 각각 `normalize_group` → 어느 쪽이든 `None`이면 400, 같으면 400.
  - 두 핸들러 모두 `Json<…>` 추출기 사용(Content-Type 검사 유지).
  - `ScenarioResponse`에 `group` 추가. 응답 조립 4곳이 같은 변환을 쓰도록 `impl From<ScenarioRow> for ScenarioResponse`. `CreateRequest`에 `#[serde(default)] group: Option<String>` → `normalize_group` → `insert_grouped`.
  - `app.rs`: `/scenario-groups/assign`·`/scenario-groups/rename`(둘 다 `post`)을 `/scenarios` 라우트 근처에.
  - `crates/tui/src/wire.rs` `ScenarioResponse`에 `pub group: Option<String>`, 손으로 쓴 `Debug`에 `.field("group", &self.group)`.
- [ ] **Step 4: 통과 확인** — Step 2의 두 명령 PASS(실행된 테스트 수가 0이 아닌지 확인), `cargo nextest run -p handicap-tui` PASS(`edit_api_test`·`save_flow_test` 포함), `cargo build --workspace --tests`.
- [ ] **Step 5: 되돌려 확인** — ① TUI 거울의 `group` 필드와 `Debug`의 `.field("group", …)` 줄을 **함께** 잠시 지워 `cargo nextest run -p handicap-tui --test edit_api_test`가 RED(응답 파싱 실패)인지 — 필터 이름으로 돌리면 맞는 테스트가 없어 항상 실패처럼 보인다 ② `AssignRequest.group`의 `deserialize_with`를 잠시 지워 `assign_without_group_key_is_422_and_changes_nothing`이 RED인지. 원복.
- [ ] **Step 6: 커밋** — `feat(controller,tui): 시나리오 그룹 API(assign·rename) + 응답 group 필드`

---

### Task 3: UI 와이어 — 스키마·호출·훅 + 픽스처 전수 갱신

`ScenarioSchema`에 필수 필드가 생기면 기존 테스트 픽스처가 깨지므로 **같은 커밋**에서 전수 갱신한다.

**Files:**
- Modify: `ui/src/api/schemas.ts`, `ui/src/api/client.ts`, `ui/src/api/hooks.ts`
- Modify: `ui/src/pages/ScenarioNewPage.tsx`(`useCreateScenario` 호출 인자 모양만)
- Modify: 시나리오 객체를 짓는 테스트 파일 전부(아래 Step 3)
- Test: `ui/src/__tests__/schemas.test.ts`, `ui/src/api/__tests__/scenarioGroups.client.test.ts`(신규)

**Interfaces:**
- Produces:
  - `ScenarioSchema.group: z.string().nullable()` → `Scenario["group"]: string | null`
  - `api.createScenario(yaml: string, group?: string | null)` — `group`이 `undefined`·`null`이면 본문에 키를 넣지 않는다.
  - `api.assignScenarioGroup(ids: string[], group: string | null): Promise<{ updated: number }>` — 본문에 `group` 키를 **항상** 넣는다(`null` 포함).
  - `api.renameScenarioGroup(from: string, to: string): Promise<{ updated: number }>`
  - `useCreateScenario()`의 변수 `{ yaml: string; group?: string | null }`
  - `useCloneScenario()`의 변수에 `sourceGroup?: string | null` 추가 → `createScenario(newYaml, sourceGroup)`
  - `useAssignScenarioGroup()` — 변수 `{ ids: string[]; group: string | null }`, 성공 시 `queryKeys.scenarios()` 무효화 한 번(`["scenarios"]`가 단건 키 `["scenarios", id]`의 접두라 단건도 함께 다시 읽힌다).
  - `useRenameScenarioGroup()` — 변수 `{ from: string; to: string }`, 같은 무효화.

- [ ] **Step 1: 실패하는 테스트 쓰기**
  - `schemas.test.ts`: `ScenarioSchema`가 `group: null`·`group: "서비스A"`를 받고, **`group` 키가 없는 객체는 거부**한다.
  - `scenarioGroups.client.test.ts`(`fetch` mock, 기존 client 테스트 모양):
    - `createScenario("y")` 본문에 `group` 키가 없다(`JSON.parse(body)`에 `"group" in` 거짓). `createScenario("y", "G")` 본문 `group === "G"`.
    - `assignScenarioGroup(["a"], null)` 본문에 `"group" in` 참이고 값 `null`, 경로 `/api/scenario-groups/assign`, `POST`.
    - `renameScenarioGroup("A","B")` 본문 `{from:"A",to:"B"}`, 경로 `/api/scenario-groups/rename`.
- [ ] **Step 2: 실패 확인** — `pnpm test schemas`, `pnpm test scenarioGroups.client`.
- [ ] **Step 3: 구현 + 픽스처 전수 갱신**
  - 스키마·호출·훅을 위 Interfaces대로.
  - 픽스처: `grep -rln "updated_at" ui/src --include="*.test.ts" --include="*.test.tsx"`(zsh면 따옴표 필수)로 후보를 뽑고, **시나리오 응답 모양**(`id`·`name`·`yaml`·`version`·`created_at`·`updated_at`)을 짓는 객체마다 `group: null`을 넣는다. run·프리셋·환경 등 다른 리소스 객체에는 넣지 않는다. 한 파일에 같은 모양이 여럿이면 그 파일 안의 작은 도우미로 묶어도 된다.
  - 타입 붙은 mock은 `tsc -b`가, `fetch` mock은 실행 중 Zod 파싱이 잡는다 → 둘 다 돌려야 전수 확인이 된다.
- [ ] **Step 4: 통과 확인** — `pnpm lint`, `pnpm test`(인자 없이 전체), `pnpm build` 모두 exit 0.
- [ ] **Step 5: 되돌려 확인** — `assignScenarioGroup`이 `group === null`일 때 키를 빼도록 잠시 바꿔 client 테스트가 RED인지 확인 후 원복(이 층이 본문 리터럴을 만드는 유일한 곳이다 — `ui/CLAUDE.md` "byte-identical 이빨 실증은 client.ts 층").
- [ ] **Step 6: 커밋** — `feat(ui): 시나리오 그룹 와이어(스키마·호출·훅) + 픽스처 갱신`

---

### Task 4: 묶는 규칙의 단일 소스 `grouping.ts` + 문구

**Files:**
- Create: `ui/src/scenario/grouping.ts`, `ui/src/scenario/__tests__/grouping.test.ts`
- Modify: `ui/src/i18n/ko.ts`(`scenarioGroups` 묶음 — 위 문구 표)

**Interfaces:**
- Produces:

```ts
export const MAX_GROUP_CHARS = 40;
export const MAX_ASSIGN = 500;
export type Grouped<T> = { groups: { name: string; items: T[] }[]; ungrouped: T[] };
export function groupScenarios<T extends { group?: string | null }>(list: readonly T[]): Grouped<T>;
export function groupNames(list: readonly { group?: string | null }[]): string[];
export function filterScenarios<T extends { name: string; group?: string | null }>(list: readonly T[], query: string): T[];
export type GroupNameCheck = { ok: true; value: string | null } | { ok: false; reason: "too_long" | "forbidden" };
export function validateGroupName(input: string): GroupNameCheck;
```

- [ ] **Step 1: 실패하는 테스트 쓰기**
  - `groupScenarios`: 그룹은 `localeCompare(…, "ko")` 이름순, 묶음 안과 `ungrouped`는 **입력 순서 그대로**. `group`이 `null`·`undefined`·`""`면 `ungrouped`. 그룹이 없으면 `groups: []`이고 `ungrouped`가 입력과 같은 순서·같은 원소.
  - `groupNames`: 중복 없이 이름순.
  - `filterScenarios`: 빈 검색어(공백만 포함)는 전부. 이름 부분 일치(대소문자 무시). 그룹 이름이 맞으면 그 그룹 원소 전부. 맞는 것이 없으면 `[]`. 결과는 입력 순서.
  - `validateGroupName` — Task 2가 만든 `testdata/group_name_cases.json`을 `readFileSync`로 읽어 **전 원소**를 대조한다(손으로 옮기지 않는다). `"none"` ↔ `{ok:true,value:null}`, `{value}` ↔ `{ok:true,value}`, `"too_long"`·`"forbidden"` ↔ `{ok:false,reason}`. `input: null`인 원소는 건너뛴다(UI 함수는 문자열만 받는다).
- [ ] **Step 2: 실패 확인** — `pnpm test grouping`.
- [ ] **Step 3: 구현**
  - 자르기는 **`String.prototype.trim()`을 쓰지 않는다**(U+0085를 안 잘라 서버와 갈린다). 서버와 같은 집합을 직접 자른다: 유니코드 `White_Space`(`/\p{White_Space}/u`) 또는 U+FEFF.
  - 글자 수는 `[...s].length`.
  - 금지 판정은 기존 `isForbiddenTextChar`(`ui/src/scenario/jsonPath.ts`) + U+FEFF.
  - `ko.scenarioGroups`를 문구 표대로 추가.
- [ ] **Step 4: 통과 확인** — `pnpm test grouping`, `pnpm lint`, `pnpm build`.
- [ ] **Step 5: 커밋** — `feat(ui): 시나리오 그룹 묶기·검색·이름 규칙(grouping.ts) + 문구`

---

### Task 5: 공용 그룹 입력·창·버튼

**Files:**
- Create: `ui/src/components/scenario-groups/GroupField.tsx`, `GroupDialog.tsx`, `RenameGroupDialog.tsx`, `GroupButton.tsx`
- Test: `ui/src/components/scenario-groups/__tests__/GroupDialog.test.tsx`, `RenameGroupDialog.test.tsx`, `GroupButton.test.tsx`

**Interfaces:**
- Consumes: Task 4의 `validateGroupName`·`ko.scenarioGroups`, 기존 `Modal`(`ui/src/components/Modal.tsx`)·`Input`·`Button`.
- Produces:

```ts
// 입력칸 + <datalist> 자동 완성. 라벨 = ko.scenarioGroups.fieldLabel.
GroupField(props: { id: string; value: string; onChange: (v: string) => void; names: string[] })

// 그룹 하나를 정하는 창(일괄·한 개 공용). onSubmit에는 정규화된 값(없으면 null).
GroupDialog(props: {
  open: boolean; title: string; text: string; initial: string | null; names: string[];
  pending?: boolean; error?: string | null;
  onSubmit: (group: string | null) => void; onClose: () => void;
})

RenameGroupDialog(props: {
  open: boolean; name: string; counts: Record<string, number>; // 그룹 이름 → 시나리오 수
  pending?: boolean; error?: string | null;
  onSubmit: (to: string) => void; onClose: () => void;
})

// 편집·새 화면 머리 줄의 버튼. 누르면 GroupDialog(text = assignOneText)를 연다.
GroupButton(props: {
  group: string | null; names: string[]; pending?: boolean; error?: string | null;
  // true를 돌려주면 버튼이 창을 닫는다. false면 창을 연 채 둔다(error를 보여 준다).
  onPick: (group: string | null) => boolean | Promise<boolean>;
  // 창이 열리고 닫힐 때 알린다(부모가 mutation.reset()을 부르는 자리).
  onOpenChange?: (open: boolean) => void;
})
```

- [ ] **Step 1: 실패하는 테스트 쓰기**
  - `GroupDialog`: `initial`이 입력칸에 시드된다 · `"  새 그룹 "` 입력 후 「적용」 → `onSubmit("새 그룹")` · 비우고 「적용」 → `onSubmit(null)` · 41자 → `errTooLong`이 보이고 「적용」 `disabled`, `onSubmit` 미호출 · 금지 글자 → `errForbidden` · `error`가 있으면 `role="alert"`로 `failed(error)` · `pending`이면 「적용」 `disabled` · 다시 열 때(`open` false→true) 입력칸이 새 `initial`로 돌아간다.
  - `RenameGroupDialog`(`name="A"`, `counts={A:3,B:9}`): 처음엔 버튼 글자 `renameOk` · `B` 입력 → `mergeHint(3, 9)`가 보이고 버튼 글자 `mergeOk` · `C` 입력 → 안내 없음 · 비었거나 `A`와 같으면 버튼 `disabled` · `"  B "`처럼 공백이 붙어도 **정규화한 값**으로 판정해 합치기 안내가 뜨고 `onSubmit("B")` · 41자·금지 글자는 `GroupDialog`와 같은 사유를 보이고 버튼 `disabled`.
  - `GroupButton`: `group="서비스A"` → 버튼 글자 `chip("서비스A")` · `group=null` → 글자 `assign`(「그룹 지정」)이고 **「그룹 없음」이라는 글자가 문서에 없다** · 누르면 창이 열리고 적용 시 `onPick` 호출 · `onPick`이 `true`(또는 `true`로 끝나는 Promise)면 창이 닫히고, `false`면 **창이 열린 채** 남는다 · 열고 닫을 때 `onOpenChange(true/false)`가 불린다 · `names`가 `<datalist>`의 `<option>`으로 그려진다.
  - 숫자가 들어가는 문구 단언은 `ko.x(n)` 비교에 더해 **렌더된 숫자 글자**(`"3"`, `"9"`)를 따로 단언한다(자기참조 단언 방지).
- [ ] **Step 2: 실패 확인** — `pnpm test GroupDialog`, `pnpm test RenameGroupDialog`, `pnpm test GroupButton`.
- [ ] **Step 3: 구현** — `Modal` 관례를 따른다(파괴적 버튼에 `autoFocus` 금지, 닫을 때 포커스 복원은 `Modal` 기본에 맡긴다). 자동 완성은 `<input list>`(이 입력의 ARIA role은 `combobox` — 테스트는 `getByRole("combobox")` 또는 `getByLabelText`). 버튼의 `aria-label`을 따로 주지 않는다(보이는 글자가 접근 이름).
- [ ] **Step 4: 통과 확인** — 위 세 테스트 + `pnpm lint` + `pnpm build`.
- [ ] **Step 5: 커밋** — `feat(ui): 그룹 입력칸·지정 창·이름 바꾸기 창·그룹 버튼`

---

### Task 6: 목록 — 묶음 상자와 접기 (US1)

**Files:**
- Create: `ui/src/scenario/groupPrefs.ts`, `ui/src/scenario/__tests__/groupPrefs.test.ts`
- Modify: `ui/src/pages/ScenarioListPage.tsx`
- Test: `ui/src/pages/__tests__/ScenarioListPage.groups.test.tsx`(신규)

**Interfaces:**
- Consumes: `groupScenarios`, `ko.scenarioGroups`.
- Produces:
  - `loadCollapsedGroups(): string[]`, `saveCollapsedGroups(names: string[]): void` — 키 `handicap:scenarios:collapsed-groups:v1`, 실패는 조용히 `[]`/무시.
  - 목록 DOM 규약(뒤 task·라이브 검증이 쓴다): 묶음 상자 `data-testid="scenario-group"` + `data-group-name`, 그룹에 넣지 않은 행들의 감싸는 요소 `data-testid="scenario-ungrouped"`, 시나리오 행 `data-testid="scenario-row"`.

- [ ] **Step 1: 실패하는 테스트 쓰기**
  - `groupPrefs.test.ts`: 저장→읽기 왕복 · 값이 JSON이 아님/배열이 아님/문자열 아닌 원소 → `[]` · `localStorage.getItem`이 throw해도 `[]`, `setItem`이 throw해도 예외 없음.
  - `ScenarioListPage.groups.test.tsx`(파일 `beforeEach`에 `localStorage.clear()`):
    - **그룹 0개**: `queryAllByTestId("scenario-group")` 길이 0, 행 이름 순서가 서버 응답 순서와 같다, 복제·삭제·실행 목록이 행마다 있다.
    - **그룹 있음**: 묶음 상자가 이름순으로 먼저 오고 `scenario-ungrouped`가 **DOM 순서상 마지막 묶음 뒤**(`compareDocumentPosition`). 각 상자 머리의 접기 버튼 접근 이름에 그룹 이름과 개수 숫자가 들어 있다.
    - 접기 버튼: 기본 `aria-expanded="true"`, 누르면 `"false"`가 되고 그 묶음의 행이 사라진다. 다시 마운트해도 접힌 채다(localStorage). 머리 행의 다른 곳을 눌러서는 접히지 않는다.
    - 이제 없는 그룹 이름이 저장돼 있어도 오류 없이 그려지고, **다음에 접기 버튼을 눌러 저장할 때 그 이름이 저장값에서 빠진다**. 정리는 **접기 버튼 처리 안에서만** 한다(그 순간의 그룹 이름과 대조) — `saveCollapsedGroups`는 받은 배열을 그대로 쓰는 단순 저장이고, 저장값을 지금 그룹 이름으로 다시 쓰는 effect를 두지 않는다(Task 9의 이름 바꾸기가 목록이 다시 읽히기 전에 새 이름을 써 넣는데, 그때 정리가 돌면 새 이름이 지워진다).
    - 같은 이름의 시나리오가 두 묶음에 있어도 각각 자기 묶음 `within`에서 찾아진다.
- [ ] **Step 2: 실패 확인** — `pnpm test groupPrefs`, `pnpm test ScenarioListPage.groups`.
- [ ] **Step 3: 구현**
  - `<table>`을 CSS grid 행으로 바꾼다. **모든 행(열 머리·묶음 안·묶음 밖)이 같은 열 폭을 쓴다** — 버전·수정·동작 열의 왼쪽 좌표가 묶음 안팎에서 같아야 한다. 묶음 안 행은 이름 칸 쪽으로 들여 쓴다(왼쪽 padding). 화면 낭독기가 열을 읽도록 `role="table"`/`"row"`/`"columnheader"`/`"cell"`을 준다.
  - 묶음: 둥근 테두리 상자 + 옅은 바탕의 머리. 머리 = (Task 9에서 체크 칸) + **전용 접기 버튼**(`▾`/`▸`는 `aria-hidden`, 그룹 이름, `groupCount(n)`) + (Task 9에서 「이름 바꾸기」). 마지막 묶음과 `scenario-ungrouped` 사이에 간격.
  - 그룹 이름·시나리오 이름은 `truncate` + `title`.
  - 기존 동작(복제·삭제·실행 목록·온보딩·빈 상태·오류 Callout)은 그대로. 기존 `ScenarioListPage.{home,clone,delete}.test.tsx`가 표 역할(`row`/`cell`)에 기대면 같은 의미로 고친다.
- [ ] **Step 4: 통과 확인** — `pnpm test ScenarioListPage`(4파일), `pnpm lint`, `pnpm build`.
- [ ] **Step 5: 되돌려 확인** — 묶음과 `scenario-ungrouped`의 렌더 순서를 잠시 바꿔 순서 테스트가 RED인지, 그룹 0개일 때 빈 상자를 그리게 잠시 바꿔 "그룹 0개" 테스트가 RED인지 확인 후 원복.
- [ ] **Step 6: 커밋** — `feat(ui): 시나리오 목록 그룹 묶음·접기(US1)`

---

### Task 7: 편집·새 시나리오 화면의 그룹 버튼 + 복제가 그룹을 따라감 (US2)

**Files:**
- Modify: `ui/src/pages/ScenarioEditPage.tsx`, `ui/src/pages/ScenarioNewPage.tsx`, `ui/src/pages/ScenarioListPage.tsx`(복제 호출에 `sourceGroup`)
- Test: `ui/src/pages/__tests__/ScenarioEditPage.group.test.tsx`(신규), `ScenarioNewPage.group.test.tsx`(신규), `ScenarioListPage.clone.test.tsx`·`ScenarioEditPage.clone.test.tsx`(케이스 추가)

**Interfaces:**
- Consumes: `GroupButton`, `groupNames`, `useAssignScenarioGroup`, `useCreateScenario`, `useCloneScenario`.

- [ ] **Step 1: 실패하는 테스트 쓰기**(페이지 render는 `<React.StrictMode>`로 감싼다 — 기존 dirty/name 테스트 선례)
  - 편집 화면: 그룹이 있는 시나리오 → 머리 줄에 `chip("서비스A")`, 없는 시나리오 → 「그룹 지정」. 버튼 → 새 이름 적용 → `POST /api/scenario-groups/assign` 본문 `{scenario_ids:[id], group:"…"}` 1회. **그 뒤에도 「저장」 버튼의 상태(dirty 표시)가 바뀌지 않고 `PUT /api/scenarios/{id}`가 호출되지 않는다.** 실패 응답이면 창 안에 `failed(...)`.
  - 편집 화면(Review Focus 5, **동작 확인용(스모크)** — 저장 뒤 단건이 다시 읽히므로 이 테스트만으로는 PUT 응답 결함을 못 가른다. 실제 방어는 Task 1 `update_returns_stored_group`·Task 2 `put_response_carries_stored_group`): 내용을 저장한 뒤에도 버튼이 `chip("서비스A")`다.
  - 새 화면: 그룹 버튼은 **편집기 단계에서만** 보인다(템플릿 고르기 단계엔 없음). 그룹을 정하고 「저장」 → `POST /api/scenarios` 본문 `group`이 그 값. 그룹을 안 정하면 본문에 `group` 키가 없다.
  - 복제(목록·편집 두 곳): 원본이 `group: "서비스A"`면 `POST /api/scenarios` 본문 `group === "서비스A"`, 원본이 `null`이면 키가 없다.
  - 호출 횟수는 URL로 걸러 센다(`url.includes("/api/scenario-groups/assign")`).
- [ ] **Step 2: 실패 확인** — `pnpm test ScenarioEditPage.group`, `pnpm test ScenarioNewPage.group`, `pnpm test clone`.
- [ ] **Step 3: 구현**
  - 편집 화면: 이름 옆에 `GroupButton`(이름 `<h…>`의 **형제**로 — heading 안에 넣지 않는다). `names`는 `useScenarios()` 목록에서 `groupNames`. `onPick` → `mutateAsync({ids:[id], group})`가 성공하면 `true`, 실패하면 잡아서 `false`를 돌려준다(버튼이 그에 따라 창을 닫거나 연 채 둔다). `onOpenChange`에서 `mutation.reset()`. **버튼은 이름 편집 삼항(`nameEditing ? <Input> : <div>`) 밖에 둔다** — 안에 두면 이름을 고치는 동안 버튼이 사라진다.
  - 새 화면: 화면 상태 `group`(`useState<string | null>(null)`)에 담아 두었다가 저장 때 `mutate({ yaml, group })`(`onPick`은 상태를 바꾸고 `true`). 가져오기(HAR)에서 넘어온 편집기에도 같은 버튼이 보인다. 자동 완성용으로 `useScenarios()`를 새로 부르게 되는데, **목록 읽기가 실패하거나 모양이 틀려도 화면이 그대로 동작해야 한다**(`names = []`) — 기존 새 화면 테스트들은 모르는 주소에 `{}`나 500을 돌려준다(`ui/CLAUDE.md` "무조건 발화하는 훅을 추가하면 one-shot fetchMock이 깨진다").
  - 복제: 두 호출부에서 `sourceGroup: 원본.group`.
- [ ] **Step 4: 통과 확인** — 위 테스트 + `pnpm test ScenarioEditPage`·`pnpm test ScenarioNewPage`(기존 파일 전부) + `pnpm lint` + `pnpm build`.
- [ ] **Step 5: 커밋** — `feat(ui): 편집·새 시나리오 화면의 그룹 버튼, 복제가 그룹을 따라감(US2)`

---

### Task 8: 시나리오 선택 칸 3곳 (US5)

**Files:**
- Create: `ui/src/components/scenario-groups/ScenarioOptions.tsx`, `__tests__/ScenarioOptions.test.tsx`
- Modify: `ui/src/components/run/ScheduleForm.tsx`, `ui/src/pages/SchedulesPage.tsx`, `ui/src/components/monitor/PanelEditor.tsx`, `ui/src/components/monitor/GroupBox.tsx`
- Test: `ui/src/pages/__tests__/SchedulesPage.test.tsx`·`MonitorEditPage.test.tsx`(케이스 추가)

**Interfaces:**
- Consumes: `groupScenarios`.
- Produces: `ScenarioOptions(props: { scenarios: readonly { id: string; name: string; group?: string | null }[] })` — `<select>` 안에 넣는 조각. 그룹은 `<optgroup label={이름}>` 아래로 먼저, 그룹에 넣지 않은 것은 그 뒤에 `<optgroup>` 밖 `<option>`. `ScenarioOption` 타입(`ScheduleForm.tsx`)에 `group?: string | null`.

- [ ] **Step 1: 실패하는 테스트 쓰기**
  - `ScenarioOptions.test.tsx`: 그룹 0개 → `<optgroup>`이 없고 `<option>`의 순서·`value`·글자가 입력과 같다 · 그룹 있음 → `<optgroup>`이 이름순으로 먼저, 밖의 `<option>`이 그 뒤 · 같은 이름의 시나리오 둘이 서로 다른 `<optgroup>` 아래에 있다(`within(getByRole("group", {name: "서비스A"}))`).
  - `SchedulesPage.test.tsx`: 목록 응답에 그룹이 있으면 스케줄 폼의 시나리오 `<select>`에 그 `<optgroup>`이 있다(= `SchedulesPage`의 변환이 `group`을 넘긴다).
  - `MonitorEditPage.test.tsx`: 칸 편집기의 시나리오 `<select>`와 묶음 상자의 시나리오 `<select>`에 `<optgroup>`이 있다.
- [ ] **Step 2: 실패 확인** — `pnpm test ScenarioOptions`, `pnpm test SchedulesPage`, `pnpm test MonitorEditPage`.
- [ ] **Step 3: 구현** — 세 곳의 `scenarios.map(… <option>)`을 `<ScenarioOptions scenarios={…} />`로 바꾼다. 앞의 빈 항목(`선택…`·`noValue`)은 그대로 첫 자리. `SchedulesPage`의 변환에 `group: s.group` 추가.
- [ ] **Step 4: 통과 확인** — 위 테스트 + `pnpm test ScheduleForm` + `pnpm lint` + `pnpm build`.
- [ ] **Step 5: 되돌려 확인** — `SchedulesPage`의 변환에서 `group`을 잠시 빼 스케줄 테스트가 RED인지 확인 후 원복.
- [ ] **Step 6: 커밋** — `feat(ui): 시나리오 선택 칸을 그룹별로 묶기(US5)`

---

### Task 9: 목록 — 검색·체크·일괄 지정·이름 바꾸기·안내 줄 (US3·US4)

**Files:**
- Modify: `ui/src/pages/ScenarioListPage.tsx`
- Test: `ui/src/pages/__tests__/ScenarioListPage.bulk.test.tsx`(신규), `ScenarioListPage.search.test.tsx`(신규)

**Interfaces:**
- Consumes: `filterScenarios`, `groupScenarios`, `groupNames`, `MAX_ASSIGN`, `GroupDialog`, `RenameGroupDialog`, `useAssignScenarioGroup`, `useRenameScenarioGroup`, `loadCollapsedGroups`/`saveCollapsedGroups`.

- [ ] **Step 1: 실패하는 테스트 쓰기**
  - 검색(`search.test.tsx`): 검색 칸(접근 이름 `searchPlaceholder`)과 체크 칸이 **그룹이 0개일 때도 보인다** · 이름 일부 → 맞는 행만 · 그룹 이름 → 그 묶음 전부 · **접어 둔 묶음도 검색 중엔 펼쳐 보이고**, 검색어를 지우면 다시 접힌다(저장된 접힘 상태가 안 바뀐다) · 맞는 것이 없는 묶음은 상자째 사라진다 · 결과 0 → `searchEmpty`.
  - 체크·띠(`bulk.test.tsx`):
    - 아무것도 체크 안 함 → 띠 없음. 1개 체크 → 띠에 `selectedCount(1)`(숫자 `1` 별도 단언)·「그룹 지정」·「선택 해제」.
    - 묶음 머리 체크 칸(접근 이름 `selectGroup(name)`): 일부만 체크면 `indeterminate`, 누르면 그 묶음 전부.
    - 「전체 선택」: 지금 검색에 맞는 것 전부(접힌 묶음 안 포함).
    - **Review Focus 2**: A를 체크 → A가 안 맞는 검색어 입력 → 개수는 그대로 1 → 「전체 선택」 → 개수 = 1 + 보이는 수 → 「전체 선택」 해제 → 개수 1(가려진 A 유지).
    - **Review Focus 3**: A·B 체크 뒤 목록 응답에서 B가 사라지게 다시 읽힘 → 개수 1.
    - 「그룹 지정」 → 창의 글이 `assignManyText(n)` → 적용 → `POST /api/scenario-groups/assign` 본문의 `scenario_ids`가 체크한 ID 집합과 같고 `group`이 입력값 → 성공 뒤 창이 닫히고 체크가 풀린다. 실패 응답이면 창이 열린 채 `failed(...)`, 체크 유지.
    - 501개 체크 → 「그룹 지정」 `disabled` + `tooMany`가 보인다. 500개면 눌린다.
    - 이름 바꾸기: 묶음 머리 「이름 바꾸기」 → 다른 기존 그룹 이름 입력 → `mergeHint` → 제출 → `POST /api/scenario-groups/rename` 본문 `{from,to}`. 성공 뒤 접힘 기억에서 옛 이름이 새 이름으로 바뀐다(옛 이름이 접혀 있었다면 새 이름이 접혀 있다) — 저장값을 **다시 읽힌 목록(새 이름 포함)이 도착하기 전과 후 두 시점**에 확인하고, 도착 뒤 새 이름의 묶음이 접힌 채 그려지는지 본다. 이 경로는 정리 없이 옛 이름→새 이름 치환만 한다.
    - 안내 줄: 그룹 0개 + 체크 0개 → `createHint`가 보인다. 1개 체크하면 사라진다. 그룹이 1개라도 있으면 없다.
- [ ] **Step 2: 실패 확인** — `pnpm test ScenarioListPage.bulk`, `pnpm test ScenarioListPage.search`.
- [ ] **Step 3: 구현**
  - 선택은 `Set<string>`(ID) 화면 상태. 목록 데이터가 바뀌면 없는 ID를 뺀다.
  - 검색어는 화면 상태(URL에 싣지 않는다). 검색 중에는 접힘 상태를 **읽지 않고** 전부 펼친 것으로 그리며 접기 버튼은 동작하지 않는다(`aria-expanded="true"` 고정).
  - 띠는 표 위에. 창을 열고 닫을 때 `mutation.reset()`(오래된 오류가 다음에 다시 보이지 않게). 창이 열린 동안 「그룹 지정」을 다시 누를 수 없다.
  - 체크 칸의 접근 이름: 행 `selectRow(name)`, 묶음 `selectGroup(name)`, 열 머리 `selectAll`.
- [ ] **Step 4: 통과 확인** — `pnpm test ScenarioListPage`(전 파일) + `pnpm lint` + `pnpm test`(전체) + `pnpm build`.
- [ ] **Step 5: 되돌려 확인** — 선택 정리(없는 ID 빼기)를 잠시 꺼 Review Focus 3 테스트가 RED인지, 검색 중 접힘 무시를 잠시 꺼 "접어 둔 묶음도 펼쳐 보인다"가 RED인지 확인 후 원복.
- [ ] **Step 6: 커밋** — `feat(ui): 시나리오 목록 검색·일괄 그룹 지정·그룹 이름 바꾸기(US3·US4)`

---

### Task 10: 결정 기록

**Files:**
- Create: `docs/adr/0060-scenario-groups.md`(MADR — 맥락 / 결정 = 시나리오당 글자 칸 1개 + 일괄 지정·이름 바꾸기 / 기각 = 태그·이름 규칙·고정 2칸·폴더·별도 그룹 테이블 / 결과 = 빈 그룹 없음·그룹 변경은 버전 무관·보드 파일 미포함)
- Modify: 루트 `CLAUDE.md` "알아둘 결정들"에 한 줄 — `- **0060** 시나리오 그룹: 시나리오당 글자 칸 1개 + 일괄 지정·이름 바꾸기 (태그·폴더·그룹 테이블 기각)`

- [ ] **Step 1: 작성** — 내용은 spec의 「접근」·「설계 §1–§3」에서 옮긴다.
- [ ] **Step 2: 확인** — `just doc-budget` → FAIL 0, 그리고 WARN이 이 커밋 전보다 늘지 않는다(기준선에 이미 WARN 2가 있다 — 커밋 전 한 번 돌려 수를 적어 둔다).
- [ ] **Step 3: 커밋** — `docs(adr): 0060 시나리오 그룹`

---

## 구현 뒤 (파이프라인 4–6단계 — task 아님)

- **전체 게이트**: `cargo build --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo nextest run --workspace`, `cd ui && pnpm lint && pnpm test && pnpm build`. bundle 구성은 건드리지 않았지만 `ScenarioResponse`가 바뀌었으므로 `cargo build -p handicap-controller --features bundle`을 1회(`ui/dist` 선빌드).
- **최종 리뷰**: `handicap-reviewer`(와이어 1:1 — 서버 `ScenarioResponse`/`AssignRequest`/`RenameRequest` ↔ UI Zod·client ↔ TUI 거울). 보안 표면은 `finish-slice` §0 grep을 직접 돌려 판정한다.
- **라이브 검증**(필수 — 응답 파싱 경로 변경): spec §7. US1–5 각각, 극단값(40자 그룹 이름·그룹 30개·한 그룹 200개·긴 시나리오 이름 — 잘림과 **묶음 안팎 열의 왼쪽 좌표 일치**를 rect로), 진입 화면 전부(목록·편집·새 시나리오·스케줄 폼·모니터 칸 편집기·모니터 묶음 상자), 「펼친 묶음 바로 아래의 그룹 없는 행」 화면 캡처, 좁은 화면 폭, TUI 1회(그룹 있는 시나리오가 든 DB).
- **마무리**(`/finish-slice`): build-log 단락, roadmap §B(번호는 `grep -n '^### B' docs/roadmap.md` 마지막 +1 — 연기: 보드 파일에 그룹 싣기[연기 조건: 보드 파일 형식 v1 유지]·TUI 표시·태그·그룹 순서·닫힌 선택 칸의 같은 이름 구분 / 사용자 결정 2026-11-20: 그룹이 위·테두리 상자·안내 줄·「그룹 지정」 통일), 상태줄, `ui/CLAUDE.md`·`crates/controller/CLAUDE.md`에 새로 배운 함정 한 줄씩.
