# 운영실 모니터 ②a — 보드 설정 내보내기/가져오기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 여러 모니터 보드를 시나리오·환경째 파일 하나로 내보내고, 다른 PC(다른 DB)에서 겹침이 없으면 한 트랜잭션으로 그대로 가져오며, 겹치면 아무것도 넣지 않고 겹친 항목을 보여 준다.

**Architecture:** 컨트롤러에 순수 모듈 2개 — `monitor/board_file.rs`(파일 형식·검증 R0~R7·경고)와 `monitor/transfer.rs`(PC 스냅샷 대비 상태 판정·겹침·추가 계획·이름 규칙) — 를 두고, `api/monitor_transfer.rs`가 DB 읽기/쓰기와 세 엔드포인트(export·import/analyze·import)를 얇게 감싼다. UI는 `api/monitorTransfer.ts` 클라이언트 + 목록 화면(선택 내보내기·가져오기 흐름) + 설정 화면(저장 후 내보내기).

**Tech Stack:** Rust(axum 0.8, sqlx 0.8 SQLite, serde/serde_json, `serde_path_to_error` 0.1.20), TypeScript/React(Zod, React Query, vitest+RTL).

**Spec:** `docs/superpowers/specs/2026-10-29-ops-monitor-export-design.md` — **§0의 ②a 범위만**. 이 슬라이스 = US1·US5. US2~US4는 ②b(맥락용, 구현 금지).

REVIEW-GATE: APPROVED

## Global Constraints

- 파일 최상위: `format = "handicap-bundle"`, `format_version = 1`, 키 `format`·`format_version`·`exported_at`(i64 ms)·`app_version`(=`env!("CARGO_PKG_VERSION")`)·`boards`·`scenarios`·`environments`. 보드 항목 `{id,name,config}`, 시나리오 항목 `{id,yaml}`, 환경 항목 `{id,name,vars}` — 모두 `deny_unknown_fields`(vars는 열린 맵).
- 보드 1~50개. 본문 상한 32 MiB(`32 * 1024 * 1024`) — 가져오기 두 라우트에만. 초과는 axum이 413 평문.
- ID는 정규형 ULID: `Ulid::from_string(s).map(|u| u.to_string() == s)`.
- 상태 `absent`/`same`/`different`(serde snake_case). 시나리오 same = 같은 ID + YAML 문자열 완전 일치. 환경 same = 같은 ID + `vars` 완전 일치(**이름 비교 안 함**, 이름은 `trim`).
- 겹침 = (보드 ID가 PC에 있음) ∨ (그 보드가 쓰는 시나리오·환경 중 `different`가 하나라도 있음). ②a는 겹침이 하나라도 있으면 analyze는 그대로 보고, import는 409 `{ "error": "conflicts", "boards": [<겹침 보드 항목>] }`(`ApiError::ConflictJson`).
- 겹침 없을 때 처리: 보드는 원래 ID로 추가(enabled=0), `absent` 리소스는 원래 ID로 추가, `same` 리소스는 그대로 사용. ②a는 **행을 추가만** 한다(update·reconcile 없음).
- 이름: 보드·환경 이름이 PC의 다른 행 또는 이번 가져오기에서 이미 정한 이름과 같으면 `이름 (2)`, `(3)`…(처음 비는 것). 보드 이름은 문자 수 40 상한(`NAME_MAX_CHARS`) — 접미사를 붙여도 40자 이하가 되게 원래 이름을 **문자 단위로** 자른다. 시나리오 이름은 유일하지 않아 바꾸지 않는다. 결정 순서: 파일 순서.
- 오류 문구에 파일 속 **값**을 넣지 않는다(serde `Display` 금지 — 줄 번호·경로만).
- UI 문구는 전부 `ko.ts`의 `ko.monitor.transfer` 하위(ADR-0035). 아래 "문구" 표가 byte-exact 정본.
- 기존 `validate_and_normalize`(`monitor/config.rs:416`)를 가져온 모든 보드에 반드시 적용(roadmap §B38 (3)).

### 문구 (byte-exact — 서버 문자열은 Rust 리터럴, UI 문자열은 `ko.monitor.transfer`)

| 위치 | 문구 |
|---|---|
| 서버 R0 | `파일을 읽을 수 없습니다(JSON 형식 오류, {line}번째 줄)` |
| 서버 R1 | `핸디캡 보드 파일이 아닙니다` |
| 서버 R2 | `더 새 버전의 핸디캡에서 만든 파일입니다(파일 형식 {n}, 이 프로그램은 1까지 읽습니다). 핸디캡을 업데이트하세요.` |
| 서버 R2' 타입 | `파일 형식이 올바르지 않습니다: {path}` |
| 서버 R2' 모르는 키 | `이 파일에는 이 버전의 핸디캡이 모르는 항목({path})이 있습니다. 핸디캡을 업데이트하세요.` |
| 서버 R3 | `가져올 보드가 없습니다` / `보드는 한 파일에 50개까지입니다` |
| 서버 R4 | `ID 형식이 올바르지 않습니다: {path}` / `ID가 중복되었습니다: {path}` |
| 서버 R5 접두 | `시나리오 '{name 또는 id}': ` |
| 서버 R5' 접두 | `환경 '{name}': ` |
| 서버 R6 | `파일 내용이 서로 맞지 않습니다(보드 '{board}' 칸 {n}의 시나리오가 파일에 없습니다)` / `…(보드 '{board}' 칸 {n}의 환경이 파일에 없습니다)` / `파일 내용이 서로 맞지 않습니다(쓰이지 않는 시나리오 '{name}')` / `…(쓰이지 않는 환경 '{name}')` |
| 서버 R7 접두 | `보드 '{name}' ` (뒤에 `validate_and_normalize` 사유 — 예 `칸 2: 본문 경로(JSONPath)가 올바르지 않습니다`) |
| 서버 경고 | `칸 {n}: 성공 조건이 가리키는 스텝이 시나리오에 없습니다` / `칸 {n}: 화면 표시 항목이 가리키는 스텝이 시나리오에 없습니다` / `칸 {n}: 응답 시간 기준 스텝이 시나리오에 없습니다(점검이 설정 오류로 표시됩니다)` |
| 서버 export | `내보낼 보드를 고르세요` / `보드는 한 번에 50개까지 내보낼 수 있습니다` / `보드가 중복되었습니다` / `보드 '{name}' 칸 {n}: 시나리오가 없습니다` / `보드 '{name}' 칸 {n}: 환경이 없습니다` |
| UI 목록 버튼 | `선택한 보드 내보내기 ({n})` · `파일에서 가져오기` |
| UI 50개 초과 | `한 번에 50개까지 내보낼 수 있습니다` |
| UI 선택 접근명 | `모든 보드 선택` · `'{name}' 선택` |
| UI 평문 안내 | `환경 값(비밀번호·토큰 포함)이 그대로 파일에 담깁니다. 파일 보관에 주의하세요.` |
| UI 설정 화면 버튼 | `파일로 내보내기` |
| UI 저장 확인 | 제목 `저장되지 않은 내용` · 본문 `저장되지 않은 내용이 있습니다. 저장 후 내보내시겠습니까?` · `취소` · `저장 후 내보내기` |
| UI 파일 오류 | `파일이 너무 큽니다(최대 32MB).` (JSON 형식 오류는 클라가 판정하지 않고 서버 R0 문구를 그대로 보인다 — 줄 번호 포함) |
| UI 오류 대화창 | 제목 `가져올 수 없습니다` · `닫기` |
| UI 겹침 대화창 | 제목 `이 PC에 이미 있는 항목과 겹칩니다` · `아무것도 가져오지 않았습니다. 겹치는 항목:` · `겹치는 보드를 덮어쓰거나 새 보드로 추가하는 기능은 아직 없습니다.` · `닫기` |
| UI 겹침 줄 | `보드 '{name}': 이 PC에 이미 있음` · `시나리오 '{name}': 이 PC의 것과 내용이 다름(보드 '{board}'이(가) 사용)` · `환경 '{name}': 이 PC의 것과 내용이 다름(보드 '{board}'이(가) 사용)` |
| UI 결과 | `보드 {n}개 가져옴({parts})` — parts는 0 아닌 것만 ` · `로: `새로 {a}` (②a는 이것뿐) · 시나리오 줄 `시나리오: 새로 {a} · 기존 것 사용 {u}`(0 생략, 둘 다 0이면 줄 생략) · 환경 줄 같은 형식 `환경: …` · 이름 바뀜 `이름이 겹쳐 '{to}'(으)로 추가: {kind} '{from}'` (kind = `보드`/`환경`/`시나리오`) · 경고 머리 `보드 '{name}' 확인 필요:` |
| (참고) | 시나리오·환경 요약을 두 줄로 나눈 것과 `(으)로`·kind 꼬리는 spec 예시 문장을 다듬은 것 — 이 표가 정본. 모르는 키 문구는 config 키도 `모르는 항목`으로 통일. |
| UI 기본 파일명 | 보드 1개 `{sanitizeFilename(name) \|\| "monitor-board"}.handicap-board.json` · 여러 개 `monitor-boards-{n}.handicap-board.json` |

## Review Focus

- **Windows 메모장으로 열었다 저장한 파일(UTF-8 BOM 접두)** — 사람은 그대로 가져와지길 기대한다. → Task 1 R0이 선행 `\u{feff}`를 벗기고 테스트 `bom_prefixed_file_is_accepted`.
- **같은 파일을 두 번 가져오기** — 두 번째는 "이미 있음" 겹침으로 거부되고 PC 행 수 불변. → Task 4 통합 테스트 `second_import_of_same_file_is_rejected_unchanged`.
- **PC에 이름은 같고 ID가 다른 환경("운영")이 이미 있음** — 새 환경이 `운영 (2)`로 들어가고 보드 칸은 원래 환경 ID를 가리켜 정상 점검. → Task 2 `env_name_clash_gets_suffix_and_keeps_id`.
- **40자 한글 보드 이름 + 이름 충돌** — 접미사 붙은 이름이 40자(문자) 이하, 바이트 단위 자르기로 깨진 글자 없음. → Task 2 `board_name_suffix_truncates_by_chars`.
- **내보내기 직전 다른 탭에서 보드나 칸의 시나리오를 지움** — 내 자리에서 404/400 사유가 화면에 뜨고 파일은 안 만들어진다. → Task 3 `export_missing_scenario_is_400` + Task 6 `export_error_is_shown_and_no_download`.

---

### Task 1: 파일 형식 + 검증 (순수, `monitor/board_file.rs`)

**Files:**
- Create: `crates/controller/src/monitor/board_file.rs`
- Modify: `crates/controller/src/monitor/mod.rs`(`pub mod board_file;`) · `crates/controller/src/monitor/check.rs:451`(`collect_http_steps`를 `pub(crate)`) · `crates/controller/src/api/scenarios.rs:19`(`validate_parallel_branch_names`를 `pub(crate)`) · `crates/controller/src/api/environments.rs:72`(`validate_env`의 검사 본문을 `pub(crate) fn env_problem(name: &str, vars: &BTreeMap<String,String>) -> Option<String>`로 추출, `validate_env`는 그것을 `ApiError::BadRequest`로 감싸기만 — 기존 문구 byte-identical) · `crates/controller/Cargo.toml`(`serde_path_to_error = "0.1"` 직접 의존 — `Cargo.lock`의 0.1.20 재사용)
- Test: `board_file.rs` 인라인 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces:
  - `pub const FORMAT: &str = "handicap-bundle"; pub const FORMAT_VERSION: u32 = 1; pub const MAX_BOARDS: usize = 50;`
  - `#[derive(Serialize)] pub struct BundleOut { format, format_version, exported_at: i64, app_version: String, boards: Vec<BoardOut{id,name,config: BoardConfig}>, scenarios: Vec<ScenarioOut{id,yaml}>, environments: Vec<EnvOut{id,name,vars: BTreeMap<String,String>}> }`
  - `pub struct ValidBundle { pub boards: Vec<ValidBoard>, pub scenarios: Vec<ValidScenario>, pub environments: Vec<ValidEnv> }` — 파일 순서 유지.
    - `ValidBoard { id, name /*trim·검증 후*/, config: BoardConfig /*정규화 후*/, warnings: Vec<String> }`
    - `ValidScenario { id, name /*YAML name*/, yaml: String /*원문*/ }`
    - `ValidEnv { id, name /*trim*/, vars: BTreeMap<String,String> }`
  - `pub fn parse_bundle_bytes(bytes: &[u8]) -> Result<ValidBundle, String>` — BOM 제거 → R0 → `parse_bundle_value`.
  - `pub fn parse_bundle_value(v: serde_json::Value) -> Result<ValidBundle, String>` — R1·R2(머리 먼저) → R2'(타입 + 모르는 키) → R3~R7 → 경고.

- [ ] **Step 0: tdd-guard 언블록** — `monitor/mod.rs`·`api/environments.rs`엔 `#[cfg(test)]`가 없어 편집이 차단된다. 먼저 `crates/controller/tests/monitor_transfer_test.rs`를 `#[test] #[ignore] fn pending_board_file() { todo!() }` 한 개로 만든다(pending 테스트 파일 — tdd-guard 언블록용. Task 1 커밋에 포함되고, Task 2 Step 0이 stub을 하나 더 추가하며, Task 3 Step 1이 실제 테스트로 대체하며 둘 다 지운다). 그다음 `monitor/mod.rs`에 `pub mod board_file;`, `board_file.rs` 빈 파일 + `#[cfg(test)] mod tests {}`.

- [ ] **Step 1: 실패하는 표 테스트 작성** — 유효 최소 파일 픽스처 헬퍼 `fn ok_file() -> Value`(보드 1·칸 1·시나리오 1·환경 1, 칸이 둘 다 참조, 조건 1개가 실제 HTTP 스텝을 가리킴)로 시작해 한 곳씩 망가뜨린다. 테스트(모두 `parse_bundle_value`/`_bytes`의 `Err` 문구를 **정확히** 단언 — 문구 표 참조):
  - `bom_prefixed_file_is_accepted` (`"\u{feff}"` + 직렬화 바이트 → Ok)
  - `r0_not_json_reports_line_only` (`b"{\n  \"format\": 12345x"` → `파일을 읽을 수 없습니다(JSON 형식 오류, 2번째 줄)`, 문구에 `12345` 없음)
  - `r1_wrong_format` · `r1_missing_format_version` · `r2_newer_version_beats_shape_errors` (`format_version: 2` + `boards: "x"` → R2 문구, `{n}`=2)
  - `r2_type_error_reports_path_without_value` (`boards[0].config.panels[0].bar_count = "99999"` → `파일 형식이 올바르지 않습니다: boards[0].config.panels[0].bar_count`, 문구에 `99999` 없음)
  - `unknown_top_level_key_rejected` (`"extra": 1` → 모르는 항목 문구, path `extra`) · `unknown_board_item_key_rejected` (`boards[0].enabled` → path `boards[0].enabled`) · `unknown_config_key_rejected` (`boards[0].config.panels[0].new_key` → path `boards[0].config.panels[0].new_key`) · `config_reserialization_has_no_false_positive` (**손으로 쓴 JSON 리터럴** — `to_value`로 만들지 말 것: `latency_source` 두 변형(`{"kind":"total"}`·`{"kind":"step","step_id":…}`), `environment_id` 키 생략 칸과 `null` 칸, 비어 있지 않은 `thresholds`·`conditions`·`display_items`, 그리고 선택 필드를 전부 생략한 최소 보드 → 모두 Ok)
  - `r3_zero_boards` · `r3_fifty_one_boards`
  - `r4_lowercase_ulid_rejected` · `r4_duplicate_scenario_id_rejected`
  - `r5_bad_yaml_prefixed` · `r5_empty_parallel_branch_name_rejected`
  - `r5p_env_key_with_colon_rejected` (사유가 `환경 '운영': `으로 시작)
  - `r6_panel_scenario_missing` · `r6_unused_environment`
  - `r7_disallowed_jsonpath_prefixed` (조건 path `$..a..b` → `보드 '<이름>' 칸 1: 본문 경로(JSONPath)가 올바르지 않습니다`)
  - `warnings_for_missing_steps_in_panel_order` (칸 1 응답 시간 기준 = 없는 스텝, 칸 1 조건 = 없는 스텝, 칸 2 표시 항목 = loop 스텝 ID → 경고 3줄이 응답시간→조건→표시 순, 칸 번호 1·1·2; 파일은 Ok)
  - `normalized_config_is_returned` (빈 칸 제목 앞뒤 공백 → trim된 값)
  - `env_name_is_trimmed`

- [ ] **Step 2: 실패 확인** — Run: `cargo nextest run -p handicap-controller monitor::board_file` · Expected: 컴파일 실패 또는 FAIL.

- [ ] **Step 3: 구현** — 입력 전용 타입은 `#[derive(Deserialize)] #[serde(deny_unknown_fields)]` 4종(최상위·보드·시나리오·환경), 보드 `config`는 `serde_json::Value`로 받는다. 타입 읽기는 `serde_path_to_error::deserialize`로 감싸 `err.path()`를 **그대로** 쓰고(모르는 키는 이미 경로 끝에 들어 있다 — `boards[0].enabled`; 필드명을 다시 붙이지 말 것), 안쪽 메시지는 "`unknown field`로 시작하나" 판정에만 쓴다. 보드 `config`는 `Value`로 받았으므로 `BoardConfig` 타입 읽기는 보드마다 두 번째 `serde_path_to_error::deserialize` 호출이고 그 경로 앞에 `boards[{i}].config.`를 붙인다. config 모르는 키 = 원본 `Value`와 `serde_json::to_value(&BoardConfig 파싱값)`을 재귀 비교해 원본에만 있는 키(배열은 인덱스별)를 첫 하나 경로로. R5는 `Scenario::from_yaml` → `validate_parallel_branch_names` → `validate_scenario_think_times`. 경고의 스텝 존재 판정은 `collect_http_steps`(HTTP 스텝만).

- [ ] **Step 4: 통과 확인** — Run: `cargo nextest run -p handicap-controller monitor::board_file` · Expected: PASS(전부). 이어 `cargo nextest run -p handicap-controller environments` PASS(문구 무변경).

- [ ] **Step 5: 이빨 실증** — `config_reserialization`의 모르는 키 비교를 일시적으로 `return None`으로 바꿔 `unknown_config_key_rejected`가 RED인지 확인 → 원복 → GREEN. 비교 방향을 뒤집어(재직렬화에만 있는 키를 잡게) `config_reserialization_has_no_false_positive`가 RED인지 확인 → 원복. R4의 `to_string()==s` 비교를 빼 `r4_lowercase_ulid_rejected` RED 확인 → 원복.

- [ ] **Step 6: Commit** — `git add crates/controller` → `git commit -F <msg>` (`feat(monitor): 보드 파일 형식·검증(R0~R7)·경고`).

### Task 2: 상태 판정·겹침·추가 계획 (순수, `monitor/transfer.rs`)

**Files:**
- Create: `crates/controller/src/monitor/transfer.rs`
- Modify: `crates/controller/src/monitor/mod.rs`(`pub mod transfer;`)
- Test: 인라인 `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 1 `ValidBundle`·`ValidBoard`·`ValidScenario`·`ValidEnv`.
- Produces:
  - `pub struct PcSnapshot { pub boards: Vec<PcBoard{id,name,enabled: bool}>, pub scenarios: BTreeMap<String /*id*/, String /*yaml*/>, pub environments: Vec<PcEnv{id,name,vars}> }` — `boards`/`environments`는 **PC 전체**(이름 충돌 판정용), `scenarios`는 파일에 든 ID만.
  - `#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)] #[serde(rename_all="snake_case")] pub enum ResState { Absent, Same, Different }`
  - `#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)] pub struct ResourceInfo { pub id: String, pub name: String, pub state: ResState }`
  - `#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)] pub struct BoardAnalysis { pub id, pub name, pub pc_name: Option<String>, pub conflict: bool, pub exists: bool, pub enabled: bool, pub scenarios: Vec<ResourceInfo>, pub environments: Vec<ResourceInfo>, pub warnings: Vec<String> }` — 리소스 순서 = 칸 순서대로 처음 쓰인 순서.
  - `#[derive(Serialize, Deserialize, …)] pub struct Analysis { pub boards: Vec<BoardAnalysis>, pub summary: AnalysisSummary{boards,conflicts,scenarios,environments: usize} }`
  - `pub fn analyze(b: &ValidBundle, pc: &PcSnapshot) -> Analysis`
  - `pub struct AddPlan { pub boards: Vec<(String /*id*/, String /*final name*/, BoardConfig)>, pub scenarios: Vec<(String, String /*name*/, String /*yaml*/)>, pub environments: Vec<(String, String /*final name*/, BTreeMap<String,String>)>, pub result: ImportResult }` — `scenarios`/`environments`는 `Absent`인 것만(추가할 것).
  - `#[derive(Serialize, Deserialize, …)] pub struct ImportResult { pub boards: Vec<BoardResult{id,name,action: String /*"added"*/, warnings}>, pub scenarios: Counts{added,updated,copied,unchanged: usize}, pub environments: Counts, pub renamed: Vec<Renamed{kind: String /*"board"|"environment"*/, from, to, reason: String /*"name_taken"*/}> }`
  - `pub fn plan_add(b: &ValidBundle, pc: &PcSnapshot, a: &Analysis) -> Result<AddPlan, Vec<BoardAnalysis> /*겹침 보드들*/>`
  - `pub fn unique_name(base: &str, taken: &BTreeSet<String>, max_chars: Option<usize>) -> String`

- [ ] **Step 0: tdd-guard 언블록 + 모듈 등록** — Task 1 커밋 후엔 stub 파일이 수정/미추적이 아니라 pending으로 안 친다(`tdd-guard.sh:92-107`). 먼저 `tests/monitor_transfer_test.rs`에 `#[test] #[ignore] fn pending_transfer() { todo!() }`를 **추가**해 수정 상태로 만든 뒤, `monitor/mod.rs`에 `pub mod transfer;` + 빈 `transfer.rs`(`#[cfg(test)] mod tests {}`).

- [ ] **Step 1: 실패하는 표 테스트** — 픽스처 빌더로 `ValidBundle`·`PcSnapshot`을 직접 만든다(파서 거치지 않음):
  - `empty_pc_all_absent_no_conflict` · `scenario_same_when_yaml_identical` · `scenario_different_makes_conflict` · `env_same_ignores_name` (ID·vars 같고 이름만 다름 → `Same`, 겹침 아님) · `env_vars_differ_conflict` · `board_exists_is_conflict` (`pc_name`=PC 이름, `enabled` 반영)
  - `resources_listed_in_first_use_order` · `summary_counts`
  - `plan_add_rejects_with_conflict_boards_only` (보드 3 중 1개 겹침 → `Err(vec![그 1개])`)
  - `shared_scenario_added_once` (보드 2개가 같은 `Absent` 시나리오 → `plan.scenarios.len()==1`, 결과 `scenarios.added==1`)
  - `same_resources_counted_unchanged_not_inserted`
  - `board_name_clash_with_pc_gets_suffix` (PC "A" 있음 → "A (2)", `renamed` 1건 `reason:"name_taken"`, kind `board`) · `two_boards_same_name_in_file` ("A","A" → "A","A (2)") · `suffix_skips_taken_numbers` ("A","A (2)" 있음 → "A (3)")
  - `env_name_clash_gets_suffix_and_keeps_id` (PC env "운영"(다른 ID) → 추가 env 이름 "운영 (2)", ID는 파일 ID, 보드 config의 `environment_id` 그대로)
  - `board_name_suffix_truncates_by_chars` (한글 40자 이름 + 충돌 → 결과 `chars().count()==40`, 끝이 ` (2)`)
  - `result_actions_all_added`

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller monitor::transfer` · FAIL.

- [ ] **Step 3: 구현** — `analyze`는 DB를 읽지 않는다. 이름 taken 집합(종류별) = PC 전 행 이름 + 이번에 정한 이름, 파일 순서로 결정. `unique_name`: `base`가 비었으면 그대로 시작, 없으면 `base`, 있으면 n=2..에서 `format!("{trunc} ({n})")` — `max_chars`가 있으면 `trunc` = base를 `max_chars - " (n)".chars().count()` 문자로 자른 것. 분석·결과 DTO에 `HashMap`/`HashSet` 금지(`BTreeMap`/`Vec`만 — ②b 지문 대비).

- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.

- [ ] **Step 5: 이빨 실증** — `env_same_ignores_name`: 환경 비교에 이름을 넣어 RED 확인 → 원복. `board_name_suffix_truncates_by_chars`: 자르기를 바이트(`&base[..k]`)로 바꾸면 패닉/RED인지 확인 → 원복.

- [ ] **Step 6: Commit** — `feat(monitor): 가져오기 상태 판정·겹침·추가 계획`.

### Task 3: 저장소 ID-insert + 내보내기 엔드포인트

**Files:**
- Modify: `crates/controller/src/store/scenarios.rs` · `store/environments.rs` · `store/monitor_boards.rs`(각 `insert_with_id` 추가 — 기존 `insert` 무변경)
- Create: `crates/controller/src/api/monitor_transfer.rs` · Modify: `crates/controller/src/api/mod.rs` · `crates/controller/src/app.rs`(라우트)
- Test: `crates/controller/tests/monitor_transfer_test.rs`(신규 — `monitor_boards_api_test.rs`의 `make_app`/`send` 패턴 복제)

**Interfaces:**
- Consumes: Task 1 `BundleOut`·`parse_bundle_bytes`.
- Produces:
  - `pub async fn insert_with_id(conn: &mut sqlx::SqliteConnection, id: &str, name: &str, yaml: &str) -> sqlx::Result<()>` (scenarios, version=1)
  - `pub async fn insert_with_id(conn: &mut sqlx::SqliteConnection, id: &str, name: &str, vars: &BTreeMap<String,String>) -> sqlx::Result<()>` (environments)
  - `pub async fn insert_with_id(conn: &mut sqlx::SqliteConnection, id: &str, name: &str, config: &BoardConfig) -> sqlx::Result<()>` (monitor_boards, enabled=0)
  - 연결을 받는 읽기(Task 4 `load_snapshot`이 트랜잭션 안에서 씀): `store::monitor_boards::list_names_enabled(conn) -> sqlx::Result<Vec<(String /*id*/, String /*name*/, bool /*enabled*/)>>` · `store::environments::list_all_conn(conn) -> sqlx::Result<Vec<EnvironmentRow>>` · `store::scenarios::yaml_by_ids(conn, ids: &[String]) -> sqlx::Result<BTreeMap<String, String>>` — 각 파일에 인라인 테스트 1개씩.
  - `POST /api/monitor-boards/export` 본문 `{"board_ids":[..]}`(`deny_unknown_fields`) → 200 `application/json`(`serde_json::to_vec_pretty(&BundleOut)`).
  - `pub async fn export(State, Json<ExportRequest>) -> Result<Response, ApiError>` in `api/monitor_transfer.rs`.

- [ ] **Step 1: 실패하는 통합 테스트**(Task 1·2의 stub 파일을 실제 테스트로 대체 — `pending_board_file`·`pending_transfer` 제거) — `export_two_boards_dedups_shared_scenario`(보드 2·공유 시나리오 1·환경 1 → `scenarios.len()==1`, `boards` 순서 = 요청 순서, 환경 `vars` 값 포함) · `export_empty_is_400` · `export_51_is_400` · `export_duplicate_ids_is_400` · `export_unknown_board_is_404` · `export_missing_scenario_is_400`(칸이 지운 시나리오를 가리킴 → `보드 '<이름>' 칸 1: 시나리오가 없습니다`) · `export_self_validation_rejects_bad_saved_board`(DB에 허용 문법 밖 경로를 직접 UPDATE로 심은 보드 → 400, 사유가 `보드 '`로 시작) · `export_output_parses_back`(응답 바이트 → `parse_bundle_bytes` Ok, `BoardConfig`가 원본과 `==` — `latency_source: Step`·`display_items`·`show_latency_stats=false`·`record_limit_kb=512` 포함 픽스처) · 인라인 store 테스트 `insert_with_id_keeps_id`(3종).

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --test monitor_transfer_test` · FAIL.

- [ ] **Step 3: 구현** — 순서: 0개/50 초과/중복 → 400(문구 표) → 각 보드 `get`(없으면 404) → 칸의 시나리오·환경 ID를 처음 등장 순서로 모아 `get`(없으면 400) → `BundleOut` → `to_vec_pretty` → `parse_bundle_bytes`로 자기 검증(Err면 400 그 사유) → 응답. 라우트는 `app.rs`의 기존 `/monitor-boards` 블록 옆에 `post(monitor_transfer_api::export)`.

- [ ] **Step 4: 통과 확인** — 같은 명령 PASS + `cargo nextest run -p handicap-controller --test monitor_boards_api_test` PASS(라우트 무충돌).

- [ ] **Step 5: Commit** — `feat(monitor): 보드 내보내기 엔드포인트 + ID-보존 insert`.

### Task 4: 가져오기 분석·적용 엔드포인트

**Files:**
- Modify: `crates/controller/src/api/monitor_transfer.rs` · `crates/controller/src/app.rs`
- Test: `crates/controller/tests/monitor_transfer_test.rs`

**Interfaces:**
- Consumes: Task 1 `parse_bundle_bytes`/`parse_bundle_value`, Task 2 `analyze`/`plan_add`/`PcSnapshot`, Task 3 `insert_with_id` ×3.
- Produces:
  - `POST /api/monitor-boards/import/analyze` — 본문 바이트(`axum::body::Bytes`) → 200 `Analysis` · 400 `{error}`.
  - `POST /api/monitor-boards/import` — 본문 `{"bundle": <파일>}`(바이트 → `Value` → `ImportRequest{bundle: Value}` `deny_unknown_fields`; 실패 문구는 R0/R2' 형식) → 200 `ImportResult` · 400 · 409 `{"error":"conflicts","boards":[BoardAnalysis…]}`.
  - 두 라우트에 `.layer(DefaultBodyLimit::max(32 * 1024 * 1024))`.
  - `async fn load_snapshot(conn: &mut SqliteConnection, b: &ValidBundle) -> sqlx::Result<PcSnapshot>`

- [ ] **Step 1: 실패하는 통합 테스트** — 컨트롤러 1개로 "A에서 export → DB 비우기 대신 **두 번째 `store::connect` DB로 만든 두 번째 app**에 import"(두 PC 흉내):
  - `analyze_on_empty_pc_has_no_conflicts`
  - `import_round_trip_creates_rows_with_original_ids` (B의 보드·시나리오·환경 ID = A의 ID, 보드 enabled=false, 공유 시나리오 1행, `ImportResult.boards[*].action=="added"`)
  - `imported_board_config_equals_exported`(B `GET /api/monitor-boards/{id}`의 config == A의 config)
  - `second_import_of_same_file_is_rejected_unchanged` (두 번째 → 409 `error=="conflicts"`, `boards[0].exists==true`, 세 테이블 행 수 불변)
  - `analyze_reports_scenario_different` (B의 같은 ID 시나리오를 수정 → analyze 200, `conflict=true`, 시나리오 `state=="different"`)
  - `import_rejects_when_conflict_appears_after_analyze` (analyze 200 무겹침 → B에 같은 ID 보드 생성 → import 409)
  - `import_failure_rolls_back_all_tables` (**엔드포인트 경유** — B DB에 `CREATE TRIGGER t BEFORE INSERT ON monitor_boards BEGIN SELECT RAISE(ABORT,'x'); END` → import POST가 5xx → 세 테이블 행 수가 요청 전과 같음, 즉 먼저 들어간 시나리오·환경도 없음. 핸들러가 트랜잭션 없이 풀로 넣으면 RED)
  - `analyze_400_has_reason` (format_version 2 → 400 R2 문구) · `import_body_with_extra_key_is_400` · `analyze_over_32mib_is_413` (33 MiB 공백 본문 → 413) + 짝 `analyze_3mib_is_not_413` (유효 파일 뒤에 3 MiB 공백을 붙인 본문 → 200 — axum 기본 2 MB 한도로는 413이라 레이어가 있어야만 통과)
  - `import_routes_do_not_hit_board_id_route` (POST `/api/monitor-boards/import/analyze`가 404/405 아님)

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --test monitor_transfer_test` · FAIL.

- [ ] **Step 3: 구현** — analyze: 파싱 → `db.acquire()` → `load_snapshot` → `analyze` → 200. import: 파싱 → `let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?` → `load_snapshot(&mut tx)` → `analyze` → `plan_add`(Err면 `ConflictJson(json!({"error":"conflicts","boards":…}))` — tx는 drop으로 롤백) → 시나리오·환경·보드 순으로 `insert_with_id(&mut tx, …)` → `commit` → 200 `plan.result`. 적용부는 `async fn apply(conn: &mut SqliteConnection, plan: &AddPlan) -> sqlx::Result<()>`로 분리(시나리오 → 환경 → 보드 순).

- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller --test monitor_transfer_test` PASS. 이어 전체 `cargo nextest run -p handicap-controller` PASS.

- [ ] **Step 5: 이빨 실증** — ① `plan_add`의 겹침 거부를 일시 무력화(`Ok`)하면 `second_import_of_same_file_is_rejected_unchanged`가 RED인지 ② analyze 라우트의 `DefaultBodyLimit` 레이어를 빼면 `analyze_3mib_is_not_413`이 RED인지 ③ `apply`에 `&mut tx` 대신 풀 연결을 넘기면 `import_failure_rolls_back_all_tables`가 RED인지 — 각각 확인 → 원복.

- [ ] **Step 6: Commit** — `feat(monitor): 보드 가져오기 분석·적용(겹침 시 거부)`.

### Task 5: UI 클라이언트 (`api/monitorTransfer.ts`)

**Files:**
- Create: `ui/src/api/monitorTransfer.ts` · Test: `ui/src/api/__tests__/monitorTransfer.test.ts`
- Modify: `ui/src/i18n/ko.ts`(`ko.monitor.transfer` — 문구 표의 UI 행 전부; 이 task는 키만 추가)

**Interfaces:**
- Produces:
  - Zod(`.strict()`, `pc_name`은 `.nullable()` — `.nullish()` 금지): `ResStateSchema`, `ResourceInfoSchema`, `BoardAnalysisSchema`, `AnalysisSchema`, `ImportResultSchema`(`boards[].action: z.literal("added")`는 쓰지 말고 `z.string()` — ②b 확장 대비), `ConflictBodySchema = z.object({ error: z.literal("conflicts"), boards: z.array(BoardAnalysisSchema) }).strict()`
  - `export class ImportConflictError extends Error { constructor(public readonly boards: BoardAnalysis[]) }`
  - `export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;`
  - `export async function exportBoards(ids: string[]): Promise<string>` — 응답 텍스트 그대로(서버가 pretty JSON). 실패 → `ApiError`. `monitors.ts`의 private `errorMessage`는 `export`로 열어 재사용(복제 금지).
  - `export async function downloadBoardFile(filename: string, text: string): Promise<void>` — `downloadText(filename, text, "application/json", JSON_TYPES)`; `downloadJson.ts`의 `JSON_TYPES`를 `export`로 연다.
  - `export function exportFileName(boardNames: string[]): string` — 문구 표의 기본 파일명.
  - `export async function analyzeImport(text: string): Promise<Analysis>` — 본문 = `text` 그대로. 413 → `ApiError(413, ko.monitor.transfer.tooLarge)`.
  - `export async function applyImport(text: string): Promise<ImportResult>` — 본문 = `'{"bundle":' + text + '}'`(재직렬화 금지 — spec J13). 409 + `ConflictBodySchema` 통과 → `ImportConflictError`. 413 → 위와 같음.

- [ ] **Step 1: 실패하는 테스트** — `fetch` 모킹: `applyImport_splices_raw_text`(요청 본문이 `'{"bundle":' + text + '}'`와 문자열 동일, 텍스트에 `1.0`·키 순서가 그대로) · `applyImport_409_conflicts_throws_ImportConflictError` · `applyImport_409_other_is_ApiError` · `analyzeImport_413_message` · `analysis_accepts_null_pc_name`(서버가 보내는 `null`) · `exportFileName_single_sanitized` · `exportFileName_empty_name_fallback` · `exportFileName_multiple` · 기존 `downloadJson.test.ts` GREEN 유지.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/api/__tests__/monitorTransfer.test.ts` · FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 5: Commit** — `cd ui && pnpm lint && pnpm test && pnpm build` 통과 후 `feat(monitor-ui): 보드 내보내기/가져오기 클라이언트`.

### Task 6: 목록 화면 — 선택 내보내기 + 가져오기 흐름

**Files:**
- Modify: `ui/src/pages/MonitorListPage.tsx`
- Create: `ui/src/components/monitor/ImportBoards.tsx`(버튼 + 숨은 input + 흐름 상태 + 오류/겹침 대화창) · `ui/src/components/monitor/ImportConflictList.tsx`(겹침 목록 — analyze 겹침과 409 공용) · `ui/src/components/monitor/ImportResultCallout.tsx`
- Test: `ui/src/pages/__tests__/MonitorListPage.test.tsx`(확장) · `ui/src/components/monitor/__tests__/ImportBoards.test.tsx`

**Interfaces:**
- Consumes: Task 5 전부, 기존 `Modal`(`title` 필수)·`Button`·`Callout`·`readTextFile`.
- Produces: `ImportBoards({ onDone: (r: ImportResult) => void })` · `ImportConflictList({ boards: BoardAnalysis[] })` · `ImportResultCallout({ result: ImportResult })`.

- [ ] **Step 1: 실패하는 테스트**:
  - 목록: `select_all_and_row_checkboxes_have_names` · `export_button_disabled_when_none_selected` · `export_button_disabled_over_50_with_message` · `export_downloads_selected_in_list_order`(목록 2번째 행을 **먼저** 체크하고 1번째를 나중에 체크 → 요청 `board_ids`가 목록 순서; `downloadBoardFile` 모킹으로 파일명·텍스트 확인) · `export_error_is_shown_and_no_download` · `import_button_visible_on_empty_list` · `plaintext_notice_visible`.
  - 가져오기: `oversize_file_shows_error_without_request`(`MAX_IMPORT_BYTES + 1`) · `analyze_400_shows_reason_and_no_import` · `no_conflict_imports_and_shows_result`(결과 문구 `보드 2개 가져옴(새로 2)`, 시나리오 줄 `시나리오: 새로 1`) · `conflicts_show_list_and_no_import`(겹침 줄 3형식 문구 확인, `applyImport` 미호출) · `import_409_shows_same_list` · `result_shows_renamed_and_warnings` · `result_omits_zero_parts`.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/pages/__tests__/MonitorListPage.test.tsx src/components/monitor/__tests__/ImportBoards.test.tsx` · FAIL.
- [ ] **Step 3: 구현** — 선택 상태는 `Set<string>`; 내보내기 순서 = 목록에 보이는 순서. 숨은 input은 `YamlFileActions`의 트리플가드(`className="hidden"`·`tabIndex={-1}`·`aria-hidden="true"`)와 `accept=".json,application/json"`, 같은 파일 재선택 위해 처리 후 `value=""`. 성공 시 `MONITOR_LIST_KEY` 무효화 + 결과 Callout을 목록 위에 표시. 결과의 보드 이름은 `/monitors/{id}` 링크.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 5: Commit** — `pnpm lint && pnpm test && pnpm build` 통과 후 `feat(monitor-ui): 목록에서 보드 선택 내보내기·파일 가져오기`.

### Task 7: 설정 화면 — 파일로 내보내기 + 저장 후 내보내기

**Files:**
- Modify: `ui/src/pages/MonitorEditPage.tsx`
- Test: `ui/src/pages/__tests__/MonitorEditPage.test.tsx`(확장)

**Interfaces:**
- Consumes: Task 5 `exportBoards`·`exportFileName`·`downloadBoardFile`.
- Produces: 없음(화면 내부). `onSave`를 `const saveBoard = async (): Promise<Board | null>`(기존 `onSave` 동작 그대로 — 검사·`persist(true)`·`adopt`·새 보드면 `navigate(..., replace)`·실패 시 `setError`/`markFromServer`·성공=Board, 실패=null)로 추출하고 `onSave = () => void saveBoard()`.

- [ ] **Step 1: 실패하는 테스트** — `export_without_changes_downloads_immediately` · `export_with_changes_opens_dialog`(제목·본문·두 버튼 문구) · `dialog_cancel_does_nothing` · `save_then_export_saves_and_downloads`(PUT 1회 후 export 요청의 `board_ids==[id]`) · `save_failure_closes_dialog_and_no_download`(PUT 400 `칸 1: …` → 칸 오류 표시, `downloadText` 미호출) · `new_board_save_then_export_uses_created_id` · 기존 저장 테스트 전부 GREEN 유지.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/pages/__tests__/MonitorEditPage.test.tsx` · FAIL.
- [ ] **Step 3: 구현** — 버튼은 `#monitor-actions` 안 기존 버튼들 뒤, 평문 안내 문구를 버튼 아래 작은 글씨로. `busy` 동안 비활성.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 5: Commit** — `pnpm lint && pnpm test && pnpm build` 통과 후 `feat(monitor-ui): 설정 화면에서 파일로 내보내기(저장 후 내보내기)`.

### Task 8: ADR-0054 + 인덱스

**Files:**
- Create: `docs/adr/0054-board-bundle-file-format.md`(MADR — 결정: `handicap-bundle` v1 세 칸 구조·ID 보존·같음 판정(ID+내용, 환경 이름 제외)·겹침 정의·모르는 키 거부 + `format_version`은 구조·의미 변경 때만·귀결(보드 설정 필드 추가 후 파일은 옛 PC에서 거부)·②a 겹침 거부 / ②b 질문 흐름 예정. 기각: 이름 매칭·`format_version` 규율만으로 새 필드 처리·클라 재직렬화.)
- Modify: `CLAUDE.md` "알아둘 결정들"에 한 줄 `- **0054** 보드 파일 형식: \`handicap-bundle\` v1(보드·시나리오·환경) + ID 보존·내용 비교 + 모르는 키 거부`

- [ ] **Step 1: 작성** · **Step 2:** `just doc-budget` 통과 확인 · **Step 3: Commit** — `docs(adr): 0054 보드 파일 형식`.

---

## 구현 후 (파이프라인 — plan task 아님)

- 최종 리뷰 `handicap-reviewer` + 보안 게이트(env 값이 파일이라는 새 sink — grep 결과와 무관하게 `security-reviewer` 실행; [[security-gate-judgment-override]]).
- 라이브 검증(필수): 컨트롤러 2개(서로 다른 `--db`·`--rest`/`--grpc` 포트)로 spec §0 ②a 라이브 항목 — US1(빈 B에 보드 2개 가져오기·질문 0·결과 문구·공유 시나리오 1행·켜서 점검), US5(R7 위반·`format_version: 2`·모르는 키·깨진 JSON·BOM 파일 → 사유·B 불변; 설정 화면 dirty 내보내기 대화창·저장 실패 시 파일 없음), 겹침 거부(같은 파일 두 번). 극단값: 40자 이름 + 접미사, 겹침 목록 여러 줄·긴 이름이 대화창에서 겹치거나 잘리지 않음(rect 실측), 목록·설정 두 진입점.
