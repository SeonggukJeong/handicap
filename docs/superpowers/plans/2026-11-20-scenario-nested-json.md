# 시나리오 쪽 감싼 JSON 풀기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 엔진 본문 추출과 에디터 미리 실행 트리가 모니터와 같은 규칙으로 문자열에 감싼 JSON을 풀어, 트리에서 `+추출`한 경로가 부하 run에서 같은 값을 낸다.

**Architecture:** 풀기 함수 묶음을 엔진 새 모듈 `json_unwrap`으로 옮기고 모니터가 그것을 쓴다. 엔진 본문 추출은 원래 본문에서 못 찾을 때만 바깥 푼 값 → 안쪽까지 푼 값 순으로 다시 찾는다(응답당 한 번 만들어 나눠 씀). UI는 `parseBodyJson`을 공용 위치로 옮기고 `TestRunPanel`이 그 값으로 트리를 그린다. Rust↔TS는 `testdata/nested_json_vectors.json` 하나를 세 곳이 읽어 묶는다.

**Tech Stack:** Rust(`serde_json`·`serde_json_path`), React/TS(vitest·RTL).

**Spec:** `docs/superpowers/specs/2026-11-20-scenario-nested-json-design.md` — 매 task brief에 spec의 `사용자 스토리 (US)` 블록을 첨부한다.

REVIEW-GATE: APPROVED

## Global Constraints

- 지금 값을 찾던 추출 경로의 값·문구는 그대로다. 기존 `crates/engine/src/extract.rs` 단위 테스트와 `crates/engine/tests/extract_*.rs`, `crates/controller` 모니터 테스트는 **무수정 통과**(테스트를 고쳐서 통과시키지 않는다 — 고쳐야 하면 STOP·보고).
- 에러 문구를 새로 만들지 않는다. `no match: {path}`·`body not JSON: {e}` 그대로. 풀기 중 파싱 실패는 조용히 "안 풀림".
- 경로를 찾은 요청에는 풀기 일(훑기·복사·파싱)이 붙지 않는다.
- 풀기 규칙(바꾸지 않는다): JSON 공백 4종(` `·`\t`·`\n`·`\r`) 뒤 첫 글자가 `{`·`[`·`"`인 문자열만 후보, 문자열 하나 최대 3번 파싱(`MAX_JSON_UNWRAP = 3`)해 객체·배열이 되면 그 값, 푼 값 안의 문자열도 다시 후보.
- UI 문구는 `ko.ts` 경유. 안내 글자 = `문자열로 감싼 JSON을 풀어서 표시 중`(모니터와 같은 글자).
- 커밋: 구현자는 커밋·게이트를 단일 foreground 호출로, `| tail`·`| head` 금지, 판정은 `; echo exit=$?`, `--no-verify` 금지. 커밋 뒤 `git log -1`로 확인.
- 결함을 변호하는 주석 금지 — 코드로 고친다(`docs/dev/working-rules.md` §7). 회귀 가드 테스트는 되돌려 확인(teeth check: 고의 회귀 → RED → 원복 → GREEN)을 실행하고 보고에 적는다.
- 순서: Task 1 → 2 → 3(엔진) 뒤에 Task 4 → 5(UI). UI가 먼저 들어가면 엔진이 못 찾는 `+추출` 경로가 생긴다.

## Review Focus

1. 원래 본문에서 `null`을 찾은 추출 — 풀기로 넘어가지 않아야 한다(엄격 `""`, 너그러운 쪽 못 뽑음). 2·3단계에서 찾은 `null`도 같은 규칙. → Task 2 Step 1 `order_*` 테스트.
2. `[INFO] …`·`{name}`처럼 후보이지만 안 풀리는 문자열이 든 본문 — 값이 안 바뀌고 본문 복사도 없어야 한다. → Task 1 Step 1 `has_unwrappable_table`, Task 3 측정.
3. 잘못된 JSONPath 글자(`$[`)가 든 추출 항목 — 지금처럼 `no match: $[`, panic 없음. → Task 2 Step 1 `invalid_path_still_no_match`.
4. 본문 뿌리가 감싼 JSON인 응답에서 `$` 추출 — 원래 문자열 통째(풀린 객체 글자 아님). → Task 2 Step 1 `order_root_dollar_keeps_original_string`.
5. 풀기 사슬로 아주 깊어진 본문 — 스택이 넘치지 않아야 한다. → Task 3 Step 1.
6. 잘린 본문·JSON 아닌 본문의 미리 실행 — 지금의 「본문 필드 추출 불가」 안내 그대로, 풀기 안내 없음. → Task 5 Step 1.

## 파일 지도

| 파일 | 역할 |
|---|---|
| Create `crates/engine/src/json_unwrap.rs` | 풀기 함수 묶음(순수 함수 + 단위 테스트) |
| Modify `crates/engine/src/lib.rs` | `pub mod json_unwrap;` |
| Modify `crates/engine/src/extract.rs` | `BodyCache` 구조체화, 3단계 찾기, fixture·순서 테스트 |
| Modify `crates/controller/src/monitor/check.rs` | 로컬 풀기 함수 삭제 → 엔진 것 사용, fixture 테스트 |
| Modify `crates/tui/src/pick.rs`, `crates/tui/tests/pick_test.rs` | 주석 포인터만 |
| Create `testdata/nested_json_vectors.json` | 공유 fixture |
| Create `crates/engine/tests/nested_json_depth.rs`, `crates/engine/tests/nested_json_perf.rs` | 깊이 테스트, `#[ignore]` 미세 측정 |
| Create `ui/src/scenario/bodyJson.ts` + `ui/src/scenario/__tests__/bodyJson.test.ts`, `…/nestedJsonVectors.test.ts` | `parseBodyJson` 공용 위치, fixture 테스트 |
| Modify `ui/src/monitor/conditions.ts`, `ui/src/monitor/__tests__/conditions.test.ts`, `ui/src/components/monitor/PreviewResult.tsx`, `ui/src/components/monitor/RecordBody.tsx`, `ui/src/i18n/ko.ts` | import 경로·문구 키 이동 |
| Modify `ui/src/components/scenario/TestRunPanel.tsx`, `ui/src/components/scenario/__tests__/TestRunPanel.extract.test.tsx` | 트리에 푼 값 + 안내 |

---

### Task 1: 풀기 함수 묶음을 엔진 `json_unwrap` 모듈로 (+ 복사 없는 `unwrap_nested`)

**Files:**
- Create: `crates/engine/src/json_unwrap.rs`, `crates/engine/tests/json_unwrap_api.rs`
- Modify: `crates/engine/src/lib.rs`(모듈 선언 한 줄), `crates/controller/src/monitor/check.rs`(`MAX_JSON_UNWRAP`·`unwrap_json_str`·`parse_body_json`·`unwrap_nested` 정의 삭제 + `use`), `crates/tui/src/pick.rs`·`crates/tui/tests/pick_test.rs`(주석)

**Interfaces:**
- Produces (모두 `handicap_engine::json_unwrap::`):
  - `pub const MAX_JSON_UNWRAP: usize = 3;`
  - `pub fn unwrap_json_str(s: &str) -> Option<serde_json::Value>` — 지금 `check.rs`의 것과 같은 본문.
  - `pub fn parse_body_json(body: &str) -> Option<serde_json::Value>` — 같은 본문.
  - `pub fn has_unwrappable(root: &serde_json::Value) -> bool` — 읽기 전용 반복 순회, `unwrap_json_str`가 `Some`인 문자열을 처음 만나면 `true`.
  - `pub fn unwrap_nested(root: &serde_json::Value) -> Option<serde_json::Value>` — `has_unwrappable`가 `false`면 복사 없이 `None`, 아니면 지금과 같은 복사+순회.

- [ ] **Step 1: 새 모듈을 테스트와 함께 쓴다** (`Write`로 새 파일 — 파일에 `#[cfg(test)]`가 있어 tdd-guard 통과). 테스트:
  - `unwrap_json_str_table`: `{"code":1}`을 1·2·3겹 감싼 글자 → `Some(json!({"code":1}))`, 4겹 → `None`, `"hello"`·`12`·`{oops`·빈 글자 → `None`, `" \n[1,2] "` → `Some(json!([1,2]))`.
  - `has_unwrappable_table`: `json!({"a":1,"b":"x"})` → false · `json!({"a":"[INFO] x","b":"{name}","c":"\"12\""})` → false(후보지만 안 풀림) · `json!({"a":{"b":["{\"k\":1}"]}})` → true · `json!("{\"k\":1}")`(뿌리 문자열) → true.
  - `unwrap_nested_matches_old_impl`: 테스트 모듈 안에 옛 구현(`root.clone()` 뒤 순회, `changed.then_some(out)` — 지금 `check.rs`의 본문 그대로)을 `fn old_unwrap_nested`로 두고, 위 표의 값들 + `json!({"data": inner, "empty":"[]", "eobj":" {} ", "n":"007"})`(`inner` = `{"id":7,"deep":"{\"k\":\"x\"}"}` 글자)에 대해 `unwrap_nested(v) == old_unwrap_nested(v)`.
  - `has_unwrappable_deep_is_iterative`: 2만 겹 배열 안에 감싼 `{"k":1}` 값을 **반복문으로** 만든다(`serde_json::from_str`는 128겹에서 거절한다). 2 MiB 스택 스레드(`std::thread::Builder::new().stack_size(2 * 1024 * 1024)`) 안에서 `has_unwrappable` → `true`. 값은 그 스레드 안에서 해제하지 않는다(해제가 재귀다 — 값을 스레드 밖에서 만들어 참조로 넘기고, 끝난 뒤 16 MiB 스레드로 옮겨 drop). 참조를 넘기려면 `std::thread::scope` + `Builder::spawn_scoped`(`Builder::spawn`은 `'static`을 요구한다).
  - `unwrap_nested_deep_value`: 같은 값에 `unwrap_nested` → `Some`. 처음부터 16 MiB 스택 스레드에서 돌린다 — `root.clone()`과 해제가 재귀라서다(순회가 반복문임은 위 테스트가 본다).
  - 통합 테스트 `crates/engine/tests/json_unwrap_api.rs`(같은 Step에서 먼저 쓴다 — `lib.rs`엔 `#[cfg(test)]`가 없어 이 파일이 없으면 Step 2의 `lib.rs` 편집을 tdd-guard가 막는다): `handicap_engine::json_unwrap::{parse_body_json, has_unwrappable, unwrap_nested}`를 밖에서 불러 — 감싼 `{"a":1}` 본문 글자에 `parse_body_json` → `Some(json!({"a":1}))`, `has_unwrappable(&json!({"a":"{\"k\":1}"}))` → true, `unwrap_nested(&json!({"a":1}))` → `None`. 테스트 함수 이름은 `json_unwrap_public_api`(Step 2의 이름 필터에 걸리게). 모듈 선언 전엔 컴파일 실패(RED).
- [ ] **Step 2: `lib.rs`에 `pub mod json_unwrap;` 추가, 실행** `cargo nextest run -p handicap-engine json_unwrap; echo exit=$?` → 단위 5 + 통합 1 PASS.
- [ ] **Step 3: `check.rs`에서 네 정의를 지우고** `use handicap_engine::json_unwrap::{parse_body_json, unwrap_json_str, unwrap_nested};`로 바꾼다(`MAX_JSON_UNWRAP`은 `check.rs` 안 다른 사용처가 없으면 가져오지 않는다 — `grep -n MAX_JSON_UNWRAP crates/controller/src`로 확인). `BodyJson`과 그 테스트는 그대로 둔다.
- [ ] **Step 4: TUI 주석 세 곳**(`pick.rs`의 「서버 `check.rs` `MAX_JSON_UNWRAP`과 같다」·「서버 `unwrap_json_str`과 같은 규칙」, `pick_test.rs`의 「서버(`check.rs` `parse_body_json`·…)」)을 `엔진 json_unwrap`(`BodyJson::path_first`는 `check.rs` 그대로)을 가리키게 고친다. 코드 무변경.
- [ ] **Step 5: 실행** `cargo nextest run -p handicap-controller; echo exit=$?`와 `cargo nextest run -p handicap-tui; echo exit=$?` → 전부 PASS. `check.rs`의 `#[cfg(test)]` 모듈은 한 글자도 안 바뀐다(`git diff crates/controller/src/monitor/check.rs`에 테스트 모듈 줄이 없음).
- [ ] **Step 6: 커밋** `refactor(engine): 감싼 JSON 풀기 함수를 json_unwrap 모듈로 — 풀 것이 없으면 복사 없음`

---

### Task 2: 공유 fixture + 엔진 3단계 찾기

**Files:**
- Create: `testdata/nested_json_vectors.json`
- Modify: `crates/engine/src/extract.rs`, `crates/controller/src/monitor/check.rs`(테스트만)

**Interfaces:**
- Consumes: Task 1의 `json_unwrap::{unwrap_json_str, unwrap_nested}`.
- Produces: fixture 모양(Task 4가 읽는다):
  ```json
  {
    "cases": [{ "name": "…", "body": "<본문 글자>", "leaves": [["$.a", 1], ["$.data.id", 7]] }],
    "known_divergence": [{ "name": "…", "body": "<본문 글자>", "path": "$.a.id", "ts": 7 }]
  }
  ```
  `leaves` = `parseBodyJson(body).value`의 스칼라 잎 전부(`[경로, JSON 값]`). `known_divergence`의 `ts` = TS 트리에 보이는 값, Rust는 그 경로를 못 찾는다.

- [ ] **Step 1: fixture를 쓰고 엔진·모니터 테스트를 먼저 쓴다.**
  - fixture `cases`(spec §6 목록 전부): 평범한 객체 · 필드 1겹·3겹·4겹(4겹은 잎이 문자열 통째) · 뿌리 1겹·3겹 · 뿌리 평범한 문자열(`"hello"` → `[["$", "hello"]]`) · 푼 값 안의 감싼 필드 · 배열 원소가 감싼 JSON · 감싼 빈 객체·빈 배열(잎 없음) · `{oops`·`[INFO] x` · `" \n{\"k\":1} "` · 감싼 값 안 `null`·`1.5`·`true` · 키에 점·작은따옴표·공백(`a.b`, `it's`).  수는 `1`·`7`·`1.5`처럼 두 언어가 같은 글자로 쓰는 것만.
  - **`leaves`는 손으로 적지 않는다**: `body`만 적은 뒤, 버리는 vitest(`ui/src/monitor/__tests__/` 아래 임시 파일 — 커밋하지 않는다)가 지금의 `parseBodyJson`(`ui/src/monitor/conditions.ts`)과 `segmentsToPath`로 스칼라 잎 전부를 뽑아 fixture에 채운다. 채운 결과를 한 번 훑어 spec §6 사례 뜻과 맞는지 본다. **채운 뒤 그 임시 테스트 파일을 지운다**(`git status`에 남지 않음 확인 — 남으면 Task 4에서 `../conditions` import가 깨지고, 이후 tdd-guard의 "대기 중 테스트" 판정도 그 파일 때문에 항상 통과해 버린다).
  - fixture `known_divergence` 세 건(**건마다 어긋남 하나씩**): 감싼 값 안에 ① `\ud800`(짝 없는 서러게이트) ② `1e400` ③ 129겹 배열 — 각각 평범한 잎과 함께 들어 있고 `path`는 그 감싼 값 안의 평범한 잎(`$.a.id`, `ts: 7`). 어긋나는 글자는 `body` 글자 안에만 둔다(fixture 파일 자체는 `serde_json`이 읽을 수 있어야 한다). **구현 중 실측 확정**: 각 건이 정말 Rust에서 못 찾는지 Step 3에서 확인하고, 안 어긋나는 건은 `cases`로 옮기고 보고에 적는다.
  - `extract.rs` 테스트(읽기: `include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../testdata/nested_json_vectors.json"))`):
    - `vectors_every_leaf_resolves`: 사례·잎마다 — 엄격 `evaluate` 결과 == `stringify(값)`; `evaluate_lenient` 결과 == 값이 `null`이면 키 없음, 아니면 `stringify(값)`.
    - `vectors_known_divergence_is_missing`: 건마다 엄격 `evaluate`가 `ExtractFailed("no match: {path}")`.
    - `order_root_dollar_keeps_original_string`: 본문 `"{\"id\":7}"`(JSON 문자열) + `$` → `{"id":7}` 글자 그대로(원래 문자열).
    - `order_original_string_field_wins`: 본문 `{"data":"{ \"id\": 7 }"}` + `$.data` → `{ "id": 7 }`(공백 보존 = 원래 문자열), `$.data.id` → `7`.
    - `order_null_in_original_does_not_fall_through`: 본문 `{"w":"{\"id\":7}","x":{"id":null}}` + `$..id` → 엄격 `""`, 너그러운 쪽 키 없음. (원래 본문의 첫 일치는 `null`, 푼 값의 첫 일치는 `7` — "찾은 `null`이면 계속 찾는" 틀린 구현은 `7`을 낸다.)
    - `order_null_in_unwrapped_follows_same_rule`: 본문 `{"w":"{\"id\":null}"}` + `$.w.id` → 엄격 `""`, 너그러운 쪽 키 없음.
    - `order_descendant_prefers_original`: 본문 `{"w":"{\"id\":7}","x":{"id":1}}` + `$..id` → `1`(푼 값을 먼저 보는 틀린 구현은 `7`).
    - `unwrap_nested_matches_old_impl_on_vectors`(`json_unwrap.rs` 테스트에 추가): fixture `cases`·`known_divergence`의 `body`마다 `serde_json::from_str`이 되는 것에 대해 `unwrap_nested == old_unwrap_nested`(spec §6 "fixture 본문 전부").
    - `invalid_path_still_no_match`: `$[` → `ExtractFailed("no match: $[")`.
    - `not_json_body_message_unchanged`: 본문 `<html>` → 메시지가 `body not JSON: `로 시작(기존 `body_not_json_is_error`는 그대로 두고 문구 접두만 추가 단언).
  - `check.rs` 테스트 `vectors_every_leaf_resolves_in_monitor`: 사례·잎마다 `BodyJson::parse(body).unwrap().path_first(path) == Some(값)`. 단 뿌리가 감싼 JSON이 아닌 문자열 사례(`"hello"`)는 `$` → 그 문자열. (모니터는 바깥을 먼저 풀지만 fixture 잎 경로에선 값이 같다 — 다르게 나오는 사례가 있으면 STOP·보고.) `known_divergence` 건은 `path_first(path) == None`.
- [ ] **Step 2: 실행해 RED 확인** `cargo nextest run -p handicap-engine extract::tests; echo exit=$?` → `vectors_every_leaf_resolves`·`order_original_string_field_wins`(`$.data.id`)·`order_null_in_unwrapped_follows_same_rule`이 `no match`로 FAIL.
- [ ] **Step 3: 3단계 찾기 구현** (`extract.rs`):
  - `type BodyCache = Option<Result<Value, String>>`를 구조체로 바꾼다:
    ```rust
    #[derive(Default)]
    struct BodyCache {
        parsed: std::cell::OnceCell<std::result::Result<serde_json::Value, String>>,
        /// 뿌리가 문자열이고 객체·배열로 풀릴 때만 Some (2단계).
        root: std::cell::OnceCell<Option<serde_json::Value>>,
        /// 안쪽 필드까지 푼 값 — 풀린 곳이 없으면 None (3단계).
        nested: std::cell::OnceCell<Option<serde_json::Value>>,
    }
    ```
  - `fn body_path_first(cache: &BodyCache, facts: &ResponseFacts<'_>, path: &str) -> std::result::Result<Option<serde_json::Value>, String>` — `Err` = `body not JSON: {e}` 글자(지금과 같은 글자), `Ok(None)` = 못 찾음. 경로는 `JsonPath::parse(path)`를 **한 번만**(실패면 `Ok(None)` — 지금 `jsonpath_first`가 `None`을 내는 것과 같다). 순서: `parsed` → (뿌리가 `Value::String`일 때만) `root` → `nested`(`unwrap_nested(root가 Some이면 그것, 아니면 parsed)`). 뿌리가 문자열인데 `root`가 `None`이면(안 풀림) `nested`를 만들지 않고 바로 못 찾음(spec §4.1 — 뿌리 문자열을 다시 파싱하지 않는다). 1단계에서 찾으면 `root`·`nested`를 건드리지 않는다.
  - `strict_item`·`lenient_item`의 `Extract::Body` 가지가 이것을 부른다. 너그러운 쪽의 `.filter(|v| !v.is_null())`은 찾은 값에 그대로 적용. `evaluate`·`evaluate_lenient`·`evaluate_with_defaults`의 `let mut body_json: BodyCache = None;`은 `BodyCache::default()`로.
  - 공개 `jsonpath_first`는 그대로 둔다(모니터·TUI가 쓴다).
- [ ] **Step 4: 실행** `cargo nextest run -p handicap-engine; echo exit=$?`·`cargo nextest run -p handicap-controller; echo exit=$?` → PASS. `git diff --stat crates/engine/tests`가 비어 있음(기존 통합 테스트 무수정).
- [ ] **Step 5: 되돌려 확인** — ① `body_path_first`에서 3단계를 지우면 `vectors_every_leaf_resolves` RED ② `nested`를 먼저 보게 바꾸면 `order_original_string_field_wins`·`order_descendant_prefers_original` RED ③ 1단계에서 찾은 `null`을 못 찾음으로 보고 계속 찾게 바꾸면 `order_null_in_original_does_not_fall_through` RED. 각각 원복 후 GREEN. 결과를 보고에 적는다.
- [ ] **Step 6: 커밋** `feat(engine): 본문 추출이 감싼 JSON 안쪽 경로를 찾는다 — 원래 본문 먼저`

---

### Task 3: 깊이 테스트 + 못 찾는 경로 비용 측정

**Files:**
- Create: `crates/engine/tests/nested_json_depth.rs`, `crates/engine/tests/nested_json_perf.rs`

**Interfaces:**
- Consumes: `handicap_engine::{evaluate_extracts, evaluate_lenient, ResponseFacts}`, `handicap_engine::extract::jsonpath_first`, `handicap_engine::json_unwrap::{has_unwrappable, unwrap_nested}`, `handicap_engine::scenario::Extract`.

- [ ] **Step 1: 깊이 테스트** `deep_unwrap_chain_does_not_overflow`: 풀기 사슬 본문을 안에서 밖으로 만든다 — 고리 하나 = 100겹 배열 안의 `{"w": "<다음 고리의 JSON 글자>"}`, 가장 안쪽 = `{"x":1}`. 글자 크기가 목표(① ≈1 MiB ② ≈16 MiB)를 넘을 때까지 고리를 감는다. `std::thread::Builder::new().stack_size(2 * 1024 * 1024)` 스레드 안에서 그 본문에 엄격 `evaluate`를 다섯 경로로(경로마다 따로 호출 — `evaluate`는 첫 실패에서 돌아온다) — 못 찾는 `$.a.b`·`$..zzz` → `ExtractFailed("no match: …")`; 찾는 `$..x` → `"1"`(가장 안쪽 잎, 3단계); `$..w` → `Ok`(원래 본문에선 첫 고리의 `w`가 문자열이라 1단계가 그 문자열을 낸다); **3단계에서만 찾히는 깊은 컨테이너** 경로 하나(첫 고리 배열을 `[0]` 100번으로 내려가 `.w` 뒤 `[0]` — 둘째 고리의 배열 뿌리; 찾은 깊은 값을 복사·글자화한다) → `Ok`. 본문 만들기는 스레드 밖. 넘침은 프로세스 abort로 나타난다(`join()`으로는 못 잡는다 — Step 2의 종료 상태가 판정).
- [ ] **Step 2: 실행** `cargo nextest run -p handicap-engine --test nested_json_depth; echo exit=$?` → PASS. **스택이 넘치면(SIGSEGV/abort) STOP**: nextest는 debug 빌드라 재귀 한 단계의 스택이 release보다 몇 배 크다 — `cargo test -p handicap-engine --release --test nested_json_depth; echo exit=$?`도 돌려 **debug·release 두 결과를 함께** 보고한다(워커·컨트롤러 배포는 release). 고치지 말고 재현 크기·경로를 보고한다(spec §6 — 풀기 사슬 길이 한도를 세 구현에 넣는 설계 변경 대상; 미리 실행·모니터 점검은 컨트롤러 프로세스 안에서 돌아 넘침이 프로세스를 죽인다).
- [ ] **Step 3: 미세 측정** `nested_json_perf.rs`, 모든 테스트 `#[ignore]`:
  - 본문 A(후보 없음, ≈100 KiB): 짧은 글자 필드를 가진 객체 배열. 본문 B(후보만, 안 풀림): A의 글자 필드를 `[INFO] …`로. 본문 C(풀림): A에 감싼 객체 필드 추가.
  - `old_miss(body)` = `serde_json::from_slice::<Value>` + `jsonpath_first(&v, "$.nope")`(옛 길 사본). `new_miss(body)` = `evaluate_lenient(&[Extract::Body{path:"$.nope", …}], &facts)`.
  - `miss_ratio_no_candidates`: 각 200회씩 5회 반복의 최솟값 비율 `new/old`를 `eprintln!`, `assert!(ratio <= 1.25)`(본문 A). 본문 B·C는 비율을 출력만.
  - `scan_vs_clone`: `has_unwrappable(&a)` 대 `a.clone()` 시간을 출력(복사가 파싱에 묻히는지 보는 보조 수치).
- [ ] **Step 4: 실행·기록** `cargo test -p handicap-engine --release --test nested_json_perf -- --ignored --nocapture; echo exit=$?` → 비율 세 개와 보조 수치를 보고에 적는다(build-log로 간다). **본문 A 비율이 1.25를 넘으면 STOP·보고.**
- [ ] **Step 5: 되돌려 확인** — `json_unwrap::unwrap_nested`의 `has_unwrappable` 조기 반환을 임시로 지우고(항상 복사) Step 4를 다시 돌려 본문 A 비율이 1.25를 넘는지 본다. 넘으면 그 측정이 복사를 지킨다 → 원복. **안 넘으면** `scan_vs_clone`에 단언을 더한다: `has_unwrappable` 시간 ≤ `clone` 시간 × 0.5가 아니면 실패 — 그리고 `unwrap_nested`(후보 없음) 시간 ≤ `clone` 시간 × 0.5 단언으로 복사 부활을 잡는다. 어느 쪽이었는지 보고에 적는다.
- [ ] **Step 6: 커밋** `test(engine): 감싼 JSON 풀기 깊이·못 찾는 경로 비용`

---

### Task 4: `parseBodyJson` 공용 위치 + TS fixture 테스트

**Files:**
- Create: `ui/src/scenario/bodyJson.ts`, `ui/src/scenario/__tests__/bodyJson.test.ts`, `ui/src/scenario/__tests__/nestedJsonVectors.test.ts`
- Modify: `ui/src/monitor/conditions.ts`, `ui/src/monitor/__tests__/conditions.test.ts`, `ui/src/components/monitor/PreviewResult.tsx`, `ui/src/components/monitor/RecordBody.tsx`, `ui/src/components/monitor/__tests__/PreviewResult.test.tsx`, `ui/src/components/monitor/__tests__/CheckRecordDialog.test.tsx`, `ui/src/i18n/ko.ts`

**Interfaces:**
- Consumes: Task 2의 fixture 모양.
- Produces:
  - `ui/src/scenario/bodyJson.ts`: `export function parseBodyJson(body: string): { value: unknown; unwrapped: number } | null`(지금 `conditions.ts`의 것 + 도우미 `unwrapJsonString`·`unwrapNestedInPlace`·`MAX_JSON_UNWRAP`를 그대로 옮김, 동작 무변경).
  - `ko.common.jsonUnwrappedNotice = "문자열로 감싼 JSON을 풀어서 표시 중"`. `ko.monitor.previewUnwrapped`는 삭제하고 사용처(`PreviewResult.tsx`·`RecordBody.tsx`·테스트)를 새 키로 — `grep -rn previewUnwrapped ui/src` 출력 0.

- [ ] **Step 1: 테스트 먼저** — `conditions.test.ts`의 `parseBodyJson` 테스트들(`parse_body_json_*`)을 `scenario/__tests__/bodyJson.test.ts`로 옮기고 import를 `../bodyJson`으로. `nestedJsonVectors.test.ts`를 쓴다: fixture를 `readFileSync(path.resolve(__dirname, "../../../../testdata/nested_json_vectors.json"), "utf8")`로 읽고, 테스트 안 순수 함수 `leavesOf(value): [string, unknown][]`(스칼라 = `null` 또는 `typeof !== "object"`, 경로는 `segmentsToPath`, 반복 순회)로 —
  - `cases`: `leavesOf(parseBodyJson(body)!.value)`를 경로로 정렬한 것이 `leaves`를 경로로 정렬한 것과 `toEqual`(집합 비교 — 순서 비교 금지).
  - `known_divergence`: `leavesOf(...)`에 `[path, ts]`가 들어 있다.
- [ ] **Step 2: 실행해 RED** `pnpm test bodyJson; echo exit=$?`와 `pnpm test nestedJsonVectors; echo exit=$?`(cwd `ui/`) → 둘 다 `../bodyJson` 없음으로 FAIL.
- [ ] **Step 3: 함수 이동·import 갱신·`ko` 키 이동.** `conditions.ts`에는 재수출을 남기지 않는다(사용처 두 곳을 직접 고친다).
- [ ] **Step 4: 실행** `pnpm lint; echo exit=$?`·`pnpm test; echo exit=$?`·`pnpm build; echo exit=$?` → 전부 0. `find ui/src -name '*.test.ts*' | grep -v __tests__` 출력 0.
- [ ] **Step 5: fixture 어긋남 대응** — fixture `leaves`는 Task 2에서 옛 위치의 같은 함수로 만든 것이라 여기서 어긋나면 이동 중 함수가 바뀐 것이다: 이동을 고친다(fixture를 고치지 않는다).
- [ ] **Step 6: 커밋** `refactor(ui): parseBodyJson을 공용 위치로 + Rust와 같은 fixture로 대조`

---

### Task 5: 에디터 미리 실행 트리에 푼 값 + 안내

**Files:**
- Modify: `ui/src/components/scenario/TestRunPanel.tsx`(`HttpRow`)
- Test: `ui/src/components/scenario/__tests__/TestRunPanel.extract.test.tsx`

**Interfaces:**
- Consumes: `parseBodyJson`(`ui/src/scenario/bodyJson.ts`), `ko.common.jsonUnwrappedNotice`.

- [ ] **Step 1: 테스트 먼저**(기존 파일의 `httpStep`·`trace`·`expand` 도우미 사용, `onAddExtract` 스파이):
  - `wrapped body shows inner leaves and the notice`: 응답 본문 `JSON.stringify({ data: JSON.stringify({ id: 7, token: "T" }) })` → 펼치면 `ko.common.jsonUnwrappedNotice` 글자가 있고, `id` 잎의 `+추출` → 확정 → `onAddExtract`가 `path: "$.data.id"`인 본문 추출로 불린다(기존 추출 테스트의 확정 절차를 그대로 따른다). `+추출` 버튼은 잎마다 같은 이름이라(`id`·`token` 둘) bare `getByRole`은 다중 일치로 던진다 — `getAllByRole("button", { name: "+추출" })[0]`(트리 순서상 `id`가 먼저)을 쓰고, 확정 뒤 `path` 단언으로 어느 잎이었는지 잠근다.
  - `collapsed row does not parse the body`: `parseBodyJson`을 `vi.mock`(실 모듈 spread + 스파이)으로 감싸, 줄을 펼치기 전엔 호출 0회, 펼친 뒤 1회 이상. 스파이는 파일 전체에 걸리므로 `beforeEach`에서 `vi.clearAllMocks()`.
  - `plain body shows no notice`: 기존 본문(`{data:{token}}`) → `queryByText(ko.common.jsonUnwrappedNotice)`가 `null`.
  - `long wrapped body shows the notice inside the full-view dialog`: 감싼 값에 500자 넘는 필드를 더한 본문 → 「전체 보기·추출」 클릭 → `within(screen.getByRole("dialog")).getByText(ko.common.jsonUnwrappedNotice)`.
  - `truncated or non-JSON body keeps the fallback notice`: 감싼 본문 + `body_truncated: true` / 본문 `<html>` 각각 → 「본문 필드 추출 불가」 안내가 있고 풀기 안내는 없다.
- [ ] **Step 2: 실행해 RED** `pnpm test TestRunPanel.extract; echo exit=$?` → 감싼 본문 두 테스트 FAIL(안내 없음, `id` 잎 없음), 접힌 줄 테스트는 펼친 뒤에도 호출 0회라 FAIL.
- [ ] **Step 3: 구현** — `HttpRow`에서 `const parsedBody = useMemo(() => (canTree ? parseBodyJson(body) : null), [canTree, body])` `canTree` = **줄이 펼쳐져 있고(`open`)** `onCreate`가 있고 응답이 있고 본문이 비지 않았고 `body_truncated`가 아님 — 접힌 줄은 본문을 읽지 않는다(미리 실행 한 번에 요청이 수천 줄, 줄마다 본문 최대 1 MiB일 수 있다. 지금도 `BodyBlock`의 `JSON.parse`는 펼친 줄에서만 돈다). `tree.render`를 `(v) => (<>{parsedBody !== null && parsedBody.unwrapped >= 1 && <p className="mb-1 text-xs text-slate-600">{ko.common.jsonUnwrappedNotice}</p>}<ResponseBodyTree value={parsedBody !== null ? parsedBody.value : v} onCreate={onCreate} /></>)`로. `BodyBlock`은 고치지 않는다(`heading`을 넘기지 않는다).
- [ ] **Step 4: 실행** `pnpm lint; echo exit=$?`·`pnpm test; echo exit=$?`·`pnpm build; echo exit=$?` → 전부 0.
- [ ] **Step 5: 되돌려 확인** — ① `value={v}`로 되돌리면 첫째 테스트 RED(`id` 잎 없음) ② 안내 `<p>`를 지우면 감싼 본문 두 테스트 RED ③ `>= 1`을 `>= 0`으로 바꾸면 `plain body shows no notice` RED ④ `canTree`에서 `open`을 빼면 `collapsed row does not parse the body` RED. 각각 원복 후 GREEN. 보고에 적는다.
- [ ] **Step 6: 커밋** `feat(ui): 미리 실행 본문 트리가 문자열로 감싼 JSON을 풀어 보인다`

---

## Task 뒤 (파이프라인 4–6단계 — task가 아니다)

1. **최종 리뷰** `handicap-reviewer`(BASE = 이 plan 커밋 직후) + **`security-reviewer` 필수**(본문 추출 경로 — spec §8의 세 초점). 초점 한 줄 추가: "옛 `no match` 실패·기본값 대체에 기대던 소비자"(모니터 칸·조건 반복·비움 표).
2. **라이브 검증** `/live-verify` — spec §7 표 전부(US1 진입 화면 넷, US2–US4, 극단값, 성능 ⓐⓑⓒ — master 대 master 흔들림 먼저, 바이너리당 3회 중앙값, 모니터 칸 행). 워크트리 자체 바이너리로. 사용자는 자리에 없다 — 관람 안내 없이 진행.
3. **마무리** `/finish-slice` — 단, **master 합류(ff-merge)는 하지 말고** 사용자 확인을 기다린다(사용자 부재 중 시작한 작업). build-log·roadmap §B 새 블록(번호는 `grep -n '^### B' docs/roadmap.md`로 마지막+1)까지 워크트리 브랜치에 커밋하고 멈춘다.

**roadmap §B 새 블록에 남길 것**
- 부재 중 판단(사용자 2026-11-20 취침 중): ① 안내 문구 위치 = 트리 바로 위(`tree.render` 안) — cost: 풀린 응답에서 트리 위 한 줄, 되돌리는 법 = `<p>` 위치 이동. ② `ko.monitor.previewUnwrapped` → `ko.common.jsonUnwrappedNotice` 키 이동(글자 동일).
- 판단: 엔진은 원래 본문을 모니터보다 한 단계 먼저 본다(뿌리 감싼 응답의 `$`가 엔진은 원래 문자열, 모니터는 풀린 값) — cost·해소 적기.
- 연기: TUI `pick.rs` 풀기 사본을 `json_unwrap`으로 교체 · 파서 어긋남 세 건(`known_divergence` — 엄격은 `no match`로 드러나고 기본값·너그러운 추출은 조용히 기본값/빈 값) · 미리 실행 본문 1 MiB 잘림·깨진 UTF-8 대체 문자와 엔진 원 바이트의 선재 어긋남 · 트리 객체·배열 칸 `+추출`(§B47 (1) 그대로) · 에디터 트리 깊이 상한(라이브 극단값에서 멈춤이 없었다면 연기로).
- §B47 (2)에 "해소 → 이 블록" 표시, `docs/roadmap-status.md` 템플릿·캐스트 행 갱신, 릴리즈 노트 한 줄(시나리오 추출·모니터 칸 둘 다 언급).
- Task 3의 비율 수치와 라이브 성능 표.
