# 4xx·5xx를 기본 오류로 ②a — 판정 (http-error-default-a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상태 코드 검사가 없는 http 스텝의 400 이상 응답을 엔진이 오류로 센다. 검사 표기에 목록과 `any`를 더한다. run마다 규칙 번호를 저장해서 리포트·인쇄·비교가 옛 run은 옛 규칙으로, 새 run은 새 규칙으로 사실대로 말하게 한다.

**Architecture:**
- 엔진에 판정 함수 `judge_status` 하나를 두고 부하·traced 두 경로와 모니터가 같이 쓴다.
- 컨트롤러는 `runs.status_rule`(0029)을 저장하고 리포트 `run.status_rule`로 내보낸다. 유효성(`derive_validity`)은 규칙 번호로 갈래를 나눈다.
- 화면은 새 검사 모델을 읽고 쓰기만 한다(에디터 UX는 ②b). 인쇄 분류와 비교 알림이 규칙 번호를 따른다.

**Tech Stack:** Rust(serde_yaml 0.9 수동 serde, sqlx SQLite, wiremock 테스트) · TypeScript/React(Zod, `yaml` Document API, vitest+RTL).

**검토:** spec-plan-reviewer 1차 APPROVE-WITH-FIXES(8건 반영) → 2차 clean APPROVE (2026-11-24).

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-24-http-error-default-design.md` — 이 plan은 §4.1–§4.6(R1–R17·R19·R23–R26)을 구현한다. R18·R20–R22·R27은 ②b plan이 맡는다.

## Global Constraints

- 기본 규칙: 검사 줄이 **0개**인 http 스텝은 상태 코드 ≥ 400이면 오류다. 399까지는 통과다. 검사 줄이 1개 이상이면 그 줄들만 따른다(모든 줄 만족). `any` 줄은 늘 만족이다.
- YAML 표기: `- status: 200` · `- status: [200, 409]` · `- status: any`. 빈 목록과 `any` 밖의 글자는 읽기 오류다. 엔진은 원소 하나짜리 목록을 숫자 하나로 다시 쓴다.
- 오류 글(계약 — 바꾸지 않는다): 기본 규칙은 `status <코드> (>= 400)`, 숫자 하나 불일치는 `status <코드> != <기대>`(지금 그대로), 목록 불일치는 `status <코드> not in [<a>, <b>]`(쉼표+공백).
- 규칙 번호 상수: `STATUS_RULE_LEGACY = 1`, `STATUS_RULE_CURRENT = 2`. DB 칸 기본값과 serde default가 LEGACY를, `runs::insert`가 CURRENT를 쓴다.
- 준비 구간 새 실패 종류는 `http_status`이고 화면 글은 「상태 코드 400 이상」이다. `status_assert`는 검사 불일치 전용으로 남긴다.
- 화면 글은 spec §6 표와 이 plan의 「카피 정본」 절을 글자 그대로 쓴다. 「합류」 대신 「머지」, 번역투 명사구 금지(working-rules §8).
- 규칙 1 run의 리포트(화면·인쇄·비교·XLSX)는 이 변경 전과 byte-identical 뜻이다. 사유·글·분류 모두 그렇다.
- 코드 주석으로 결함을 변호하지 않는다(working-rules §7). Edit 도구로 고치고 python 편집은 쓰지 않는다.
- 커밋은 task마다 하나, 게이트 통과로 한다. `--no-verify` 금지, 파이프 커밋 금지.

## Review Focus

1. **검사 줄이 둘 이상이고 그중 하나가 `any`인 스텝**(`[any, 200]`): 엔진은 `200` 줄로만 판정하고, `status_unchecked`는 거짓, 인쇄 분류는 「코드 줄」 행이어야 한다. → Task 1·Task 5 테스트.
2. **유지 구간 기준(`?basis=steady`) 리포트의 `status_unchecked_errors` 수**: 범위 밖 초의 4xx가 섞이면 안 된다. → Task 3 테스트.
3. **에디터가 손대지 않은 스텝의 YAML이 바뀌지 않는지**: 특히 `[200, 200]`, `[200]`, `any`, 주석이 달린 검사 줄. 기준은 「손대지 않은 문서를 `String(parseDocument(src))`로 다시 쓴 결과」다. `yaml` 2.9는 flow 목록을 `[ 200, 200 ]`처럼 늘 다시 그리므로 원문 글자와는 다르다(지금 모든 flow 표기에 이미 있는 동작). → Task 4 테스트.
4. **규칙 1 run에서 리포트의 모든 글이 그대로인지**: `silent_http_errors`·`no_response_validation`(규칙 1은 지금 글), 인쇄 「응답 코드 검사가 없어」 글·범례, 표본 설명. → Task 3·Task 5의 규칙 1 고정 테스트(되돌려 확인 포함).
5. **wiremock 짝 없는 경로(404)**를 쓰던 기존 테스트가 이제 오류를 센다: 고치지 않으면 게이트가 빨갛거나, 고치면서 테스트 뜻이 몰래 바뀐다. 통과는 하지만 뜻이 바뀌는 테스트(검사 없는 스텝 + 4xx를 받고도 그 결과를 보지 않는 테스트)도 있다. → Task 1 Step 6 처리 표(구현 중 실측 확정).

---

### Task 1: 엔진 — 검사 표기와 판정 규칙

경로 게이트: engine·와이어(YAML)라 code-quality 리뷰는 `model: opus`.

**Files:**
- Modify: `crates/engine/src/scenario.rs:384-433` (`Assertion`·serde)
- Create: `crates/engine/src/status_rule.rs` (판정 함수 둘 + 단위 테스트)
- Modify: `crates/engine/src/lib.rs` (`pub mod`·`pub use`)
- Modify: `crates/engine/src/executor.rs:93-100` (`ErrorClass`), `:313-322` (부하 경로), `:713-722` (traced 경로)
- Modify: `crates/engine/src/section.rs:228-246` (`KIND_HTTP_STATUS`·목록), `:330-336` (분류 match)
- Modify: `crates/controller/src/monitor/check.rs:552-560` (`status_mismatch`)
- Modify: `crates/engine/tests/proptests.rs:37-39`
- Modify (컴파일이 강제): `crates/engine/src/executor.rs:860`·`crates/engine/src/scenario.rs:1159`·`crates/engine/tests/executor_extract.rs:96`(이 자리는 201)의 `Assertion::Status(<코드>)` 리터럴 → `Assertion::Status(StatusExpect::One(<코드>))`
- Test: `crates/engine/tests/assertions.rs`·`setup_steps.rs`·`trace_rows.rs`·`trace_setup_followups.rs`, `crates/engine/src/section.rs` 테스트, `crates/tui/tests/check_mode_test.rs`·`record_test.rs`, `crates/controller/src/monitor/check.rs` 테스트

**Interfaces:**
- Produces (엔진 공개, `handicap_engine::`):
  - `enum StatusExpect { One(u16), AnyOf(Vec<u16>), Any }` (`Debug, Clone, PartialEq, Eq`)
  - `enum Assertion { Status(StatusExpect) }` (변형 이름은 그대로)
  - `enum StatusVerdict { Pass, Mismatch, DefaultRule }` (`Debug, Clone, Copy, PartialEq, Eq`)
  - `pub fn judge_status(asserts: &[Assertion], status: u16) -> StatusVerdict`
  - `pub fn status_unchecked(asserts: &[Assertion]) -> bool`
  - `pub fn status_error_text(asserts: &[Assertion], status: u16, v: StatusVerdict) -> Option<String>` — Global Constraints의 오류 글. `Pass`면 `None`. 목록 불일치 글은 **처음 어긋난 줄**의 기대값으로 쓴다.
  - `ErrorClass::HttpStatus`, `pub const KIND_HTTP_STATUS: &str = "http_status"` (`SECTION_FIXED_FAILURE_KINDS`는 길이 7)

- [ ] **Step 1: 실패하는 테스트 — 표기 round-trip** (`status_rule.rs` 또는 `scenario.rs` 테스트 모듈)

```rust
#[test] fn status_one_reads_and_writes_number() { /* "- status: 200" → Status(One(200)) → to_yaml 에 "status: 200" */ }
#[test] fn status_list_reads() { /* "status: [200, 409]" → AnyOf(vec![200,409]) */ }
#[test] fn status_single_list_reads_as_one() { /* "[200]" → One(200) (읽을 때 정규화), 다시 쓰면 "status: 200" */ }
#[test] fn status_rejects_bad_numbers() { /* -1, 70000, 200.5, [200, -1] → Err (지금 u16 읽기와 같음, R3) */ }
#[test] fn status_duplicate_list_accepted() { /* "[200, 200]" 읽힘 */ }
#[test] fn status_any_reads_and_writes() { /* "status: any" ↔ Any */ }
#[test] fn status_empty_list_is_error() { /* "status: []" → Err */ }
#[test] fn status_unknown_word_is_error() { /* "status: all" → Err, 메시지에 "any" */ }
```

- [ ] **Step 2: 실패하는 테스트 — 판정 표** (`status_rule.rs`)

```rust
// 검사 없음
assert_eq!(judge_status(&[], 200), Pass);  assert_eq!(judge_status(&[], 302), Pass);
assert_eq!(judge_status(&[], 399), Pass);  assert_eq!(judge_status(&[], 400), DefaultRule);
assert_eq!(judge_status(&[], 404), DefaultRule); assert_eq!(judge_status(&[], 500), DefaultRule);
// 숫자 하나
assert_eq!(judge_status(&[one(404)], 404), Pass); assert_eq!(judge_status(&[one(404)], 200), Mismatch);
// 목록
assert_eq!(judge_status(&[list(&[200,409])], 409), Pass); assert_eq!(judge_status(&[list(&[200,409])], 500), Mismatch);
// any
assert_eq!(judge_status(&[any()], 500), Pass);
// 여러 줄 — 모두 만족
assert_eq!(judge_status(&[one(200), one(201)], 200), Mismatch);
assert_eq!(judge_status(&[any(), one(200)], 200), Pass); assert_eq!(judge_status(&[any(), one(200)], 500), Mismatch);
// status_unchecked
assert!(!status_unchecked(&[])); assert!(!status_unchecked(&[one(200)]));
assert!(status_unchecked(&[any()])); assert!(status_unchecked(&[any(), any()]));
assert!(!status_unchecked(&[any(), one(200)]));
// 오류 글 (계약)
assert_eq!(status_error_text(&[], 404, DefaultRule).as_deref(), Some("status 404 (>= 400)"));
assert_eq!(status_error_text(&[one(200)], 503, Mismatch).as_deref(), Some("status 503 != 200"));
assert_eq!(status_error_text(&[list(&[200,409])], 503, Mismatch).as_deref(), Some("status 503 not in [200, 409]"));
assert_eq!(status_error_text(&[], 200, Pass), None);
```

- [ ] **Step 3: 실패 확인** — `cargo test -p handicap-engine status_` → 컴파일 오류(함수·타입 없음).

- [ ] **Step 4: 구현**
  - `scenario.rs` serde는 수동 `visit_map`을 유지한다. `status` 키의 값을 `serde_yaml::Value`로 받아 셋으로 나눈다. untagged derive는 쓰지 않는다(`crates/engine/CLAUDE.md`).
    - 숫자와 목록 원소는 `serde_yaml::from_value::<u16>`로 바꾼다. 그래서 음수·소수·범위 밖은 지금처럼 읽기 오류다.
    - `Number` → `One`. `Sequence` 원소가 하나면 `One`, 둘 이상이면 `AnyOf`.
    - 빈 목록은 `de::Error::custom("status list must not be empty")`.
    - `String("any")` → `Any`.
    - 그 밖은 `de::Error::custom("status must be a code, a list of codes, or \"any\"")`.
  - 쓰기: `One(c)`는 숫자, `AnyOf`는 목록, `Any`는 `"any"`. 읽기가 원소 하나짜리 목록을 `One`으로 바꾸므로 `AnyOf`는 늘 둘 이상이다. 코드에서 직접 만든 원소 하나짜리 `AnyOf`도 숫자로 쓴다.
  - `status_rule.rs`의 세 함수는 `_` 갈래 없는 전수 match로 쓴다. 할당은 오류 글을 만들 때만 한다.
  - executor 두 경로의 `for a in &step.assert { match … }` 루프를 `judge_status` + `status_error_text`로 바꾼다. 부하 경로의 `error_class`는 `Mismatch` → `StatusAssert`, `DefaultRule` → `HttpStatus`다. traced 경로는 지금처럼 `build_error`가 없을 때만 판정한다. 추출 생략(`error.is_none()`)은 그대로 둔다.
  - `section.rs`: `KIND_HTTP_STATUS`를 상수와 목록에 더하고, 분류 match에 `(None, Some(ErrorClass::HttpStatus)) => KIND_HTTP_STATUS`를 넣는다.
  - `check.rs` `status_mismatch`: `!matches!(judge_status(&h.assert, resp.status), StatusVerdict::Pass)`이면 `Some(resp.status)`다.
  - `proptests.rs` `arb_assertion`: `prop_oneof![(100u16..600).prop_map(One), vec(100u16..600, 2..5).prop_map(AnyOf), Just(Any)]`을 `Assertion::Status`로 감싼다. 원소 하나짜리 `AnyOf`는 round-trip에서 `One`이 되므로 생성하지 않는다(2..5).
  - `insights.rs:743` `http_step_has_status_assert`는 **고치지 않는다**(spec R7 예외 — 컴파일만 그대로 된다).

- [ ] **Step 5: 새 테스트 통과** — `cargo test -p handicap-engine status_` PASS.

- [ ] **Step 6: 기존 테스트 정리 — 전수**
  - 아래 명령으로 대상을 모은다.
    ```bash
    grep -rnE 'ResponseTemplate::new\((4|5)[0-9][0-9]\)' crates
    grep -rn 'status_assert' crates/engine/tests crates/controller/src crates/tui/tests
    ```
  - `cargo nextest run --workspace`를 한 번 돌려 실패 목록을 얻는다. wiremock 짝이 없어 404를 받는 테스트가 여기서 드러난다.
  - 테스트마다 둘 가운데 하나로 판정하고 리포트에 표로 적는다(`테스트 | 판정 | 이유`).
    - **(가) 새 규칙을 검증하도록 기대값을 고친다.** 그 테스트가 「검사 없는 스텝의 4xx·5xx」 결과를 보는 것이 본래 목적일 때다.
    - **(나) YAML에 `status: any`나 기대 코드를 적어 옛 뜻을 지킨다.** 4xx·5xx가 테스트 목적과 무관할 때다(예: 지연·재시도·추출 테스트).
  - 「짝 없는 경로」는 mock을 더하는 것도 (나)로 친다.
  - 이 처리 표는 **구현 중 실측 확정**이다(plan 작성 때 전수 목록을 만들지 않았다). nextest는 실패하는 테스트만 보여 준다. 그래서 통과하더라도 검사 없는 스텝이 4xx를 받는 테스트(`grep -rln "MockServer::start" crates`의 파일 가운데 `assert:`가 없는 시나리오를 쓰는 것)도 표에 넣어 뜻이 그대로인지 적는다.
  - `crates/tui/tests/judge_parity_test.rs`를 확인하고 표에 「확인, 변경 없음」 또는 변경 내용을 한 줄 적는다.
  - 새 회귀 테스트(`crates/engine/tests/assertions.rs`, 부하 경로 `execute_step`):
    - `no_assert_500_counts_as_error` — 검사 없는 스텝 + 500 → `outcome.error == Some("status 500 (>= 400)")`, `error_class == Some(HttpStatus)`, 추출 안 함.
    - `list_409_passes_and_extracts` — `status: [200, 409]` + 409 → 오류 없음, 추출 값 있음. 같은 스텝 + 500 → `status 500 not in [200, 409]`, `StatusAssert`.
    - `any_404_passes_and_extracts` — `status: any` + 404 → 오류 없음, 추출 값 있음.
  - traced 경로(`execute_step_traced`) 테스트: `traced_no_assert_404_is_error` — 검사 없는 스텝 + 404 → `StepTrace.error == Some("status 404 (>= 400)")`, 추출 안 함. `traced_any_404_passes` — 오류 없음.
  - `section.rs` 테스트: 검사 없는 준비 스텝 + 503 → `failure_kinds["http_status"] == 1`.
  - 모니터 테스트(`check.rs`): `fail_http_status_when_no_assert_and_5xx` — 검사 없는 스텝 + 응답 503 + 오류 글 `status 503 (>= 400)` → 사유 `HTTP 503`.

- [ ] **Step 7: 되돌려 확인** — `judge_status`의 `[]` 갈래를 일시적으로 `Pass`로 바꾼다. `no_assert_500_counts_as_error`·`fail_http_status_when_no_assert_and_5xx`·준비 테스트가 RED인지 확인하고 원복한다. 결과를 리포트에 적는다.

- [ ] **Step 8: 전체 확인** — `cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace` 모두 0. `grep -rn "Assertion::Status" crates/*/src`의 남은 줄이 serde·`status_rule.rs`·`insights.rs` `http_step_has_status_assert`·테스트뿐인지 확인한다.

- [ ] **Step 9: 커밋** — `feat(engine): 검사 없는 스텝의 400 이상을 오류로 + 상태 코드 목록·any 표기`

---

### Task 2: 컨트롤러 — run 규칙 번호 저장과 리포트 노출 (+ 화면 Zod 같은 커밋)

경로 게이트: migration·와이어라 code-quality는 `model: opus`.

**Files:**
- Modify: `crates/controller/src/store/mod.rs:100-101` (0029 호출), `mod.rs` 0028 가드 아래에 새 가드 함수
- Modify: `crates/controller/src/store/runs.rs` (상수·`RunRow.status_rule`·`insert`·SELECT 두 곳 `:339`·`:374`)
- Modify: `crates/controller/src/store/runs.rs:315·352·388` (`RunRow` 만드는 세 곳)
- Modify: `crates/controller/src/report.rs:163-174` (`ReportRun.status_rule`), `:1520` 부근 (채우기), 테스트 리터럴 `RunRow` `:1575`(`run_row()` — `steady_run`·`open_run`·`verdict_run`이 이것을 쓴다)·`ReportRun` `:5714`
- Modify: `crates/controller/src/export.rs` `ReportRun` 리터럴
- Modify: `ui/src/api/schemas.ts:669-684` (`ReportRunSchema`), `schemas.ts`에 `reportStatusRule`
- Test: `crates/controller/src/store/runs.rs`·`mod.rs` 테스트, `ui/src/api/__tests__/schemas*.test.ts`(있는 파일에)

**Interfaces:**
- Produces:
  - `pub const STATUS_RULE_LEGACY: u8 = 1; pub const STATUS_RULE_CURRENT: u8 = 2;` (`store/runs.rs`)
  - `RunRow.status_rule: u8`
  - `ReportRun.status_rule: u8` (`#[serde(default = "status_rule_legacy")]`, `fn status_rule_legacy() -> u8 { STATUS_RULE_LEGACY }`)
  - UI: `ReportRunSchema`에 `status_rule: z.union([z.literal(1), z.literal(2)]).optional()`, `export function reportStatusRule(r: Pick<Report, "run">): 1 | 2`(없으면 1 — `reportSample`과 같은 꼴)
  - spec R12와 다른 점: spec은 `.optional()`을 말하지 않는다. 이 plan은 `.optional()`로 한다. 그래야 모든 리포트 픽스처와 옛 내보내기 JSON이 그대로 읽히고, 키가 없으면 옛 규칙으로 읽는 것이 사실과 맞는다. 서버가 키를 늘 싣는지는 위 `report_json_always_has_status_rule`이 지킨다.

- [ ] **Step 1: 실패하는 테스트 (Rust)**
  - `migration_0029_idempotent`: `connect`를 같은 DB에 두 번 → 성공하고 `pragma_table_info('runs')`에 `status_rule` 1건.
  - `legacy_row_reads_status_rule_1`: 칸 없이 만든 옛 스키마 DB에 run 행을 넣고 connect → `get`이 `status_rule == 1`.
  - `insert_writes_current_rule`: `insert` → `get` → `status_rule == 2`, 반환값도 2.
  - `report_run_status_rule_default`: `serde_json::from_str::<ReportRun>`에 `status_rule` 키가 없으면 1.
  - `report_json_always_has_status_rule`: 만든 리포트를 `serde_json::to_value` → `v["run"].as_object().unwrap().contains_key("status_rule")`. 화면이 키 없음을 1로 읽기 때문에, 서버가 키를 빠뜨리면 새 run이 조용히 옛 규칙으로 보인다. 그래서 키가 있는지를 고정한다(`v["k"]`로는 없음과 null을 가를 수 없다 — controller/CLAUDE.md).
  - `testdata/compare_golden.json`을 읽는 기존 테스트가 그대로 통과한다(파일 수정 없음).

- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-controller status_rule` 컴파일 오류.

- [ ] **Step 3: 구현**
  - 가드 `ensure_runs_status_rule`: 0028과 같은 꼴로 `ALTER TABLE runs ADD COLUMN status_rule INTEGER NOT NULL DEFAULT 1`. 숫자 1은 SQL 글자라 상수를 `format!`으로 넣는다.
  - `insert`의 INSERT에 `status_rule` 칸과 `STATUS_RULE_CURRENT`를 바인드한다. 두 SELECT에 칸을 더하고 `r.get::<i64,_>("status_rule") as u8`.
  - 리포트를 만들 때 `status_rule: run.status_rule`.
  - 테스트 픽스처 `run_row()`(report.rs:1575)는 **`STATUS_RULE_LEGACY`**로 둔다. 그 위에 선 리포트 테스트(`report.rs:5333-5425`의 `no_response_validation` 등)가 Task 3 뒤에도 옛 규칙의 뜻을 그대로 지키게 하기 위해서다. 규칙 2를 보는 테스트는 Task 3에서 `STATUS_RULE_CURRENT`를 명시해 따로 만든다.
  - `ReportRun` 리터럴(report.rs:5714, export.rs)도 LEGACY다.

- [ ] **Step 4: 실패하는 테스트 (UI)** — 같은 커밋에서 한다.
  - `reportStatusRule`: 키 없음 → 1, `1` → 1, `2` → 2.
  - `ReportRunSchema`가 `status_rule: 3`을 거부한다.
  - 서버 응답 모양(`status_rule: 2` 포함 run 객체)이 `.strict()`를 통과한다.

- [ ] **Step 5: 구현 (UI)** — Interfaces대로. `.default()`는 쓰지 않는다(ui/CLAUDE.md default 누출).

- [ ] **Step 6: 확인** — `cargo nextest run -p handicap-controller` 0, `cd ui && pnpm lint && pnpm test && pnpm build` 0.

- [ ] **Step 7: 커밋** — `feat(controller): run별 상태 코드 규칙 번호(0029) + 리포트 run.status_rule`

---

### Task 3: 리포트 유효성 — 규칙 2 갈래 (+ 화면 띠 글)

**Files:**
- Modify: `crates/controller/src/validity.rs:67-130` (`derive_validity`), `:190-215` (`derive_narrative`)
- Modify: `crates/controller/src/insights.rs:738-750` 곁에 `pub(crate) fn http_step_status_unchecked(steps: &[Step], id: &str) -> bool` (`find_http_step` + `handicap_engine::status_unchecked`)
- Modify: `crates/controller/src/report.rs:1504-1512` (호출 인자)
- Modify: `ui/src/components/report/ValidityBanner.tsx:14-35` (새 kind·이름표 prop), `ui/src/components/report/ReportView.tsx:286` (이름표 전달)
- Modify: `ui/src/i18n/ko.ts:1745-1780` (사유·해석 글), `ko.ts:1540` 부근 `ko.report.errorKinds.labels`(`http_status` 라벨 — `SetupSection.tsx:20`·`print/setupTable.ts:74`·`print/stepStatus.ts:178`이 읽는다)
- Test: `crates/controller/src/validity.rs` 테스트, `crates/controller/src/report.rs` 테스트, `ui/src/components/report/__tests__/ValidityBanner.test.tsx`, `SetupSection` 테스트(있는 파일)

**Interfaces:**
- Consumes: Task 1 `status_unchecked`, Task 2 `RunRow.status_rule`·`STATUS_RULE_*`.
- Produces:
  - `derive_validity(summary, status_distribution, scenario_yaml, has_active_criteria, insights, stair_dropped_explained, status_rule: u8, steps: &[ReportStep], setup: Option<&SetupReport>) -> Validity`
    - `setup_failed: u64` 인자는 없앤다. 함수 안에서 `setup.map(|s| s.failed).unwrap_or(0)`로 얻는다.
    - 인자가 아홉 개라 `#[allow(clippy::too_many_arguments)]`를 단다(선례 `report.rs:658`·`insights.rs:393`).
  - 규칙 갈래: `status_rule == STATUS_RULE_LEGACY`면 옛 갈래, 그 밖의 값은 새 갈래.
  - 사유 kind `"status_unchecked_errors"`(severity `"warning"`, `step_id`·`count` 채움). 자리는 지금 `silent_http_errors`가 들어가는 자리(3번)다. 여러 개면 `count`가 큰 것부터, 같으면 준비 스텝 먼저, 그다음 시나리오 순서(안정 정렬).
  - 해석 키 `"unchecked_steps_error_free"`(cannot_claim)
  - UI: `ValidityBanner`에 prop `stepNames?: ReadonlyMap<string, string>`·`statusRule?: 1 | 2`(없으면 1). `no_response_validation` 글은 규칙 2면 새 글(`no_response_validation_rule2`), 규칙 1이면 지금 글이다.

- [ ] **Step 1: 실패하는 테스트 (Rust, `validity.rs`)**
  - `rule1_unchanged_*`: 기존 유효성 테스트 전부가 `status_rule = 1`로 그대로 통과한다. 기존 호출의 `setup_failed` 자리를 `1, &[], None`으로 바꾼다. `setup_failed > 0`을 보던 테스트는 `failed`를 채운 `SetupReport`를 넘긴다.
  - `report.rs`의 기존 유효성 테스트(`:5333-5425`)는 `run_row()`가 LEGACY라 그대로 통과한다. 같은 픽스처에 CURRENT를 넣은 짝 테스트 `rule2_no_assert_no_criteria_has_no_no_response_validation`을 더한다.
  - `rule2_no_silent_http_errors`: 4xx>0·errors=0·규칙 2 → `silent_http_errors` 없음.
  - `rule2_unchecked_errors_per_step`: `any` 스텝 A(4xx 3건)·B(5xx 7건)·검사 없는 C(4xx 5건) → 사유 둘, 순서 B(7)·A(3), `step_id`·`count`가 맞음. C는 없음.
  - `rule2_unchecked_counts_setup`: `setup.steps`의 `any` 준비 스텝 404×2 → 사유 하나, count 2.
  - `rule2_unchecked_uses_scoped_steps`: `steps[].status_counts`(범위 적용값)만 센다. 같은 스텝의 범위 밖 초가 들어간 `windows`를 줘도 count는 `steps` 값이다. 시그니처가 `windows`를 받지 않으니 호출부 테스트(`report.rs` steady 픽스처, `?basis=steady`)로 확인한다.
  - `rule2_no_response_validation_only_when_all_any`: 검사 없는 스텝뿐 + 기준 없음 → 사유 없음. 모두 `any` + 기준 없음 → 사유 있음. `any` + 검사 없음 섞임 → 없음.
  - `rule2_narrative_unchecked`: `status_unchecked_errors`가 있으면 cannot_claim에 `unchecked_steps_error_free`, `zero_engine_errors_means_ok`는 없음.

- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-controller validity` 컴파일 오류.

- [ ] **Step 3: 구현**
  - 규칙 1이면 지금 코드 경로를 그대로 탄다. 분기 위치는 `silent_http_errors`와 `no_response_validation` 두 블록이다.
  - 규칙 2 `no_response_validation`은 `collect_unconditional` id가 모두 `http_step_status_unchecked`일 때만 낸다.
  - `status_unchecked_errors`는 이렇게 센다.
    - 시나리오를 한 번 파싱한다. YAML 파싱이 실패하면 건너뛴다(지금 4번 블록과 같은 fail-soft).
    - `sc.setup_steps()`와 `sc.steps`를 재귀로 돌며(`find_http_step`과 같은 걸음 — loop·if·parallel 안 포함) `status_unchecked`인 http 스텝 id를 모은다.
    - 준비 스텝은 `setup.steps[]`, 본 스텝은 `steps[]`에서 그 id의 `status_counts`를 찾아 키 첫 글자 `'4'`·`'5'`의 합을 센다.

- [ ] **Step 4: 되돌려 확인** — 셋을 한 번씩 바꿔 RED인지 보고 원복한다. 결과를 리포트에 적는다.
  - `http_step_has_status_assert`를 `!status_unchecked(..)`로 → `no_response_validation_when_no_assert_no_criteria` RED.
  - 규칙 1 갈래를 규칙 2 갈래로 → `rule1_*` 하나 이상 RED.
  - `status_unchecked_errors` 원천을 `steps[]`에서 그 스텝의 `windows` 합으로 → steady 호출부 테스트 RED. `derive_validity`는 `windows`를 받지 않으므로, 이 확인 동안만 호출부에서 `windows`로 합친 가짜 `steps`를 넘긴다.

- [ ] **Step 5: 실패하는 테스트 (UI, `ValidityBanner.test.tsx`)**
  - `status_unchecked_errors` 사유 + `stepNames`에 `{A: "상태 확인"}` → 「상태 코드를 보지 않는 스텝 「상태 확인」이 4xx·5xx 응답 1,204건을 받았습니다. 상태 코드로는 오류로 세지 않았습니다」.
  - 이름표에 없는 id면 id를 그대로 쓴다.
  - `no_response_validation`: `statusRule` 2 → 새 글, 1·없음 → 지금 글.
  - 준비 실패 종류 `http_status`가 준비 표(`SetupSection`)에 「상태 코드 400 이상」으로 보인다(글자 `http_status`가 화면에 나오지 않는다).

- [ ] **Step 6: 구현 (UI)** — `ReportView`는 기존 `stepMeta`(id → name)에서 `Map<string,string>`을 만들어 넘기고, `statusRule={reportStatusRule(report)}`도 넘긴다. `stepMeta`는 `allSteps`를 쓰는데, `allSteps`는 준비 스텝을 포함한다(`model.ts:540-541`). 글은 아래 「카피 정본」 그대로.

- [ ] **Step 7: 확인** — `cargo nextest run -p handicap-controller` 0, `cd ui && pnpm lint && pnpm test && pnpm build` 0. XLSX `validity_reason_kinds` 기존 테스트가 통과한다(규칙 1 픽스처).

- [ ] **Step 8: 커밋** — `feat(report): 규칙 2 run의 유효성 — 보지 않는 스텝의 오류 응답 알림`

---

### Task 4: 화면 시나리오 모델 — 목록·`any` 읽고 쓰기 (+ 임시 검사 줄)

UI 테스트 먼저(tdd-guard). `tsc -b`가 다른 테스트 파일의 픽스처까지 잡으므로, `kind: "status", code` 픽스처가 든 테스트 파일 8개(그 grep에 걸리는 10개 가운데 `Inspector.tsx`·`yamlDoc.ts`는 제품 코드)를 같은 task에서 고친다.

**Files:**
- Modify: `ui/src/scenario/model.ts:41-44` (`AssertionModel`)
- Modify: `ui/src/scenario/yamlDoc.ts:89-91` (편집 타입), `:604-609` (`setStepAssert`), `:1044-1049` (`normalizeAssertion`)
- Modify: `ui/src/scenario/store.ts:107`·`:426` (시그니처)
- Modify: `ui/src/components/scenario/Inspector.tsx:623-700` (`AssertEditor` 임시 모양)
- Test: `ui/src/scenario/__tests__/yamlDoc.test.ts`·`model.test.ts`, `ui/src/components/scenario/__tests__/Inspector*.test.tsx`(있는 파일), 픽스처 파일들(`grep -rlE 'kind: "status", code' ui/src`)

**Interfaces:**
- Produces:
  - `AssertionModel = z.discriminatedUnion("kind", [ z.object({ kind: z.literal("status"), codes: z.array(z.number().int().min(100).max(599)).min(1) }).strict(), z.object({ kind: z.literal("status_any") }).strict() ])`
  - `type Assertion = z.infer<typeof AssertionModel>` (이름 그대로)
  - `setStepAssert(stepId: string, asserts: ReadonlyArray<Assertion>): void`
  - `export function assertionLabel(a: Assertion): string` (`ui/src/scenario/assertLabel.ts` 새 파일) — `codes`는 `·`로 잇고(「200·409」), `status_any`는 「보지 않음」(ko 경유).

- [ ] **Step 1: 실패하는 테스트**
  - `normalizeAssertion`: `{status: 200}` → `{kind:"status",codes:[200]}`, `{status:[200,409]}` → `codes:[200,409]`, `{status:"any"}` → `{kind:"status_any"}`, `{status:[]}` → Zod 실패(시나리오 파싱 오류로 드러남).
  - `setStepAssert` 쓰기: `codes:[200]` → `status: 200`, `codes:[200,409]` → `status: [ 200, 409 ]`(`yaml` 2.9의 flow 목록 출력 모양 — 아래 Step 3), `status_any` → `status: any`(따옴표 없음), 빈 배열 → `assert: []`(지금 동작).
  - **손대지 않은 스텝 보존**: `- status: [200, 200]  # 둘` · `- status: [200]` · `- status: any`가 있는 YAML에서 다른 스텝 이름만 바꾼다. 기대값은 셋이다.
    - 그 스텝들의 줄이 「손대지 않은 문서를 `String(parseDocument(src))`로 다시 쓴 결과」와 같다(`yaml`은 flow 목록을 `[ 200, 200 ]`처럼 다시 그린다 — 지금 모든 flow 표기에 이미 있는 동작).
    - 값은 `[200, 200]`·`[200]`이 그대로다(`[200]`이 `200`으로 바뀌지 않는다).
    - `any`는 따옴표가 없고, 주석 `# 둘`이 남는다.
  - `assertionLabel`: `[200,409]` → 「200·409」, any → 「보지 않음」.
  - Inspector 임시 모양: 목록 줄은 「200·409」 글과 × 단추로 보이고, × 단추가 그 줄을 지운다. 추가 칸에 201을 넣고 추가하면 `codes:[201]` 줄이 하나 더 생긴다.

- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/scenario src/components/scenario` FAIL.

- [ ] **Step 3: 구현**
  - `normalizeAssertion`은 `status`가 숫자면 `[n]`, 배열이면 그대로, `"any"`면 `status_any`다. 그 밖의 값은 그대로 넘겨 Zod가 거부하게 한다.
  - `setStepAssert`는 바깥 배열을 지금처럼 `doc.createNode(arr)`로 만든다. 각 원소의 `status` 값은 이렇게 쓴다.
    - `codes.length === 1`이면 숫자.
    - 아니면 `doc.createNode(codes, { flow: true })`로 만든 flow 노드를 그 원소 맵에 넣는다(바깥 `createNode` 안에 넣어도 flow가 유지된다 — 검토자 실측).
    - `status_any`는 글자 `any`.
  - serializeDoc 따옴표 가드(§B84)가 `any`를 따옴표로 감싸지 않는지 테스트로 고정한다.
  - `AssertEditor` 임시 모양: 줄마다 `assertionLabel` 글 + ×. 숫자 칸은 줄 편집에서 뺀다(②b가 바꾼다). 추가 칸은 지금 그대로 코드 하나짜리 줄을 더한다.
  - 숫자 칸이 없어지므로 기존 테스트 둘을 고친다.
    - `Inspector.test.tsx:1858-1875`: `inputs.find(i => i.placeholder !== "200")!`가 죽는다. 추가 칸 기준으로 다시 쓴다.
    - `:1769-1782`(`assertStatusField` 라벨): 임시 모양에 라벨이 없으면 지운다.
  - `scenarioFacts`는 YAML을 직접 읽으므로 이 task에서 손대지 않는다.
  - 픽스처 `{ kind: "status", code: N }` → `{ kind: "status", codes: [N] }`(`grep -rlE 'kind: "status", code' ui/src`가 0이 될 때까지).
  - `trust.ts`(`x.kind === "status"`)·`FlowOutline`(`step.assert.length`)·`trustPrefs`는 코드 변경 없이 컴파일된다. ②b가 판정을 바꾼다.
    - `status_any`만 있는 스텝은 지금 점검 A에서 「검사 없음」으로 잡힌다. ②b R22와 같은 결과다.
    - `trustPrefs` 지문에는 `canonJson(s.assert)`가 들어가므로, 모델이 `{code}` → `{codes}`로 바뀌면 검사가 있는 시나리오의 「미리 실행 확인됨」이 ②a에서 이미 한 번 풀린다. ①~④ 사이에 릴리즈하지 않으므로 해가 없다(마무리 §B에 적는다).

- [ ] **Step 4: 확인** — `cd ui && pnpm lint && pnpm test && pnpm build` 0.

- [ ] **Step 5: 커밋** — `feat(ui): 상태 코드 검사 모델을 목록·보지 않음으로 넓힘`

---

### Task 5: 인쇄 분류·표본 설명 — 규칙 번호를 따른다

**Files:**
- Modify: `ui/src/print/scenarioFacts.ts:3-55` (`statusCodes` → `statusChecks`)
- Modify: `ui/src/print/stepTable.ts:23-35` (`classifyCell`), `:185` (`buildStepTable` 인자)
- Modify: `ui/src/print/compare/errorCells.ts:48` (`classOn`), `ui/src/print/compare/fairness.ts:270-312` (검사 차이), `ui/src/print/buildPrintDoc.ts`(규칙 번호 전달), `ui/src/print/stepStatus.ts`·`sentences.ts`·`components/TableNotes.tsx:10-15`(규칙별 글 고르기, `SWATCH` 글→색 표에 규칙 2 범례 글 추가)
- Modify: `ui/src/components/report/SampleBar.tsx:21` (`Pick`에 `"run"` 추가)·`:81-82` (`passedHelp` 규칙별). `ReportView`는 이미 `report` 전체를 넘긴다(`ReportView.tsx:181-186`).
- Modify: `ui/src/i18n/ko.ts` (인쇄 규칙 2 글 — 카피 정본)
- Test: `ui/src/print/__tests__/stepTable.test.ts`·`scenarioFacts.test.ts`·`fairness.test.ts`·`sentences.test.ts`·`stepStatus.test.ts`(있는 파일), `ui/src/components/report/__tests__/SampleBar.test.tsx`

**Interfaces:**
- Consumes: Task 2 `reportStatusRule`.
- Produces:
  - `type StatusCheck = number[] | "any"`, `StepFacts.statusChecks: StatusCheck[]` (`statusCodes` 삭제). 이름이 `statusLines`가 아닌 것은 `fairness.ts:341 statusLine`(run 상태 줄)과 헷갈리지 않게 하려는 것이다.
  - `classifyCell(code: number, facts: Pick<StepFacts,"statusChecks"|"fallibleExtract"> | null, rule: 1 | 2): CellClass`
  - `buildStepTable(steps, facts, rule: 1 | 2)`

- [ ] **Step 1: 실패하는 테스트 — 규칙 1 고정**
  - 지금 `classifyCell` 테스트 전부를 `rule = 1`로 그대로 둔다. 숫자 하나 줄은 `[[n]]`이다.
  - 새 행: 규칙 1에서 목록 `[[200,409]]` + 409 → `expected`, `[["any"]]` + 404 → 검사 없음과 같음(`uncounted`/`unknown`). 옛 run이 새 표기를 담을 일은 없지만 같은 함수가 받으므로 정의한다.

- [ ] **Step 2: 실패하는 테스트 — 규칙 2 판정표** (spec R25 표)

```ts
// 검사 없음
expect(classifyCell(200, F([]), 2)).toBe("plain"); expect(classifyCell(404, F([]), 2)).toBe("counted");
expect(classifyCell(0, F([]), 2)).toBe("counted");
// 코드 줄 — 모든 줄에 들어 있음 (any 줄은 건너뜀)
expect(classifyCell(409, F([[200,409]]), 2)).toBe("expected"); expect(classifyCell(404, F([[404]]), 2)).toBe("expected");
expect(classifyCell(200, F(["any",[200]]), 2)).toBe("expected");
// 코드 줄 — 빠짐
expect(classifyCell(500, F([[200,409]]), 2)).toBe("counted"); expect(classifyCell(200, F([[404]]), 2)).toBe("counted");
// any 뿐
expect(classifyCell(200, F(["any"]), 2)).toBe("plain"); expect(classifyCell(404, F(["any"]), 2)).toBe("uncounted");
expect(classifyCell(404, F(["any"], true), 2)).toBe("unknown");
// 스텝 못 찾음
expect(classifyCell(200, null, 2)).toBe("plain"); expect(classifyCell(404, null, 2)).toBe("unknown");
```

- [ ] **Step 3: 실패하는 테스트 — 글**
  - 규칙 2 run의 인쇄 문서에서 `any` 스텝의 uncounted 글(콜아웃·한 줄·범례·문장)이 카피 정본의 규칙 2 글이다.
  - 규칙 1 run은 지금 글이다(기존 스냅샷·문장 테스트가 그대로 통과).
  - `scenarioFacts`: `[200, 409]` → `[[200,409]]`, `any` → `["any"]`, 숫자 문자열 `"200"` → `[[200]]`(지금 `statusCodeOf` 규칙 유지), 모델 모양(`{kind:"status",codes}`·`{kind:"status_any"}`)도 읽는다.
  - `fairness`: 이전 `[]` → 이후 `[[200]]`은 추가, `[[200]]` → `[]`은 제거, `[[200]]` → `[[200,409]]`는 변경, `[[200]]` → `["any"]`는 변경.
  - `SampleBar`: 규칙 2 run은 새 `passedHelp`, 규칙 1 run은 옛 글.

- [ ] **Step 4: 실패 확인** — `cd ui && pnpm vitest run src/print src/components/report` FAIL.

- [ ] **Step 5: 구현**
  - `classifyCell` 규칙 1 갈래는 지금 식을 `statusChecks`로 옮긴 것이다. 숫자 줄이 하나라도 있으면 `checks.some(l => l !== "any" && !l.includes(code)) ? counted : expected`이고, 숫자 줄이 없으면(전부 `any`이거나 비었으면) 지금의 「검사 없음」 갈래다. 규칙 2 갈래는 Step 2 표다.
  - 규칙 번호는 `buildPrintDoc`·`runModel`이 `reportStatusRule(report)`로 얻어 넘긴다.
  - 글 고르기는 규칙 2이면 카피 정본의 `*Rule2` 글을 쓴다. 규칙 2 범례 글은 `TableNotes.tsx` `SWATCH`(글 → 색 class)에도 같은 class(`p-sw p-cell--uncounted`)로 넣는다. 테스트로 규칙 2 범례에 색 견본이 붙는지 고정한다.
  - 규칙 2의 uncounted 콜아웃·문장에서 「검사를 추가하길 권합니다」는 뺀다. `any`는 일부러 고른 것이기 때문이다. 이것은 spec에 없는 plan 판단이라 마무리 §B에 「사용자 확인 대기」로 적는다.

- [ ] **Step 6: 확인** — `cd ui && pnpm lint && pnpm test && pnpm build` 0.

- [ ] **Step 7: 커밋** — `feat(print): 인쇄 오류 분류가 run의 상태 코드 규칙을 따른다`

---

### Task 6: 비교 — 규칙이 다른 두 run 알림

**Files:**
- Create: `ui/src/compare/statusRuleNotice.ts`
- Modify: `ui/src/pages/ScenarioComparePage.tsx:191` 부근 (알림 표시 — `sampleNote` 옆, 같은 모양)
- Modify: `ui/src/print/compare/fairness.ts:535` 부근 (`statusRuleLine`), `ui/src/print/compare/components/FairCards.tsx:39·57` 부근(`sampleLine`을 그리는 곳 바로 아래, 같은 모양). spec R26은 「조건 차이 표에 한 줄」이라 했지만, 같은 성격의 표본 알림이 카드 아래 줄로 그려지므로 그 자리를 따른다(plan 판단).
- Modify: `ui/src/i18n/ko.ts` (`ko.compare.statusRuleNotice`)
- Test: `ui/src/compare/__tests__/statusRuleNotice.test.ts`, `ScenarioComparePage` 테스트, `fairness` 테스트

**Interfaces:**
- Consumes: Task 2 `reportStatusRule`.
- Produces: `export function statusRuleNotice(reports: Array<Pick<Report, "run">>): string | null` — 규칙 번호가 모두 같으면 `null`, 아니면 `ko.compare.statusRuleNotice`.

- [ ] **Step 1: 실패하는 테스트** — `[1,1]` → null, `[2,2]` → null, `[1,2]` → 글, 키 없는 run(=1)과 2 → 글. 비교 화면에 두 리포트(1·2)를 주면 글이 보이고, 둘 다 2면 없다. 인쇄 비교 모델의 `statusRuleLine`도 같다.
- [ ] **Step 2: 실패 확인** — `pnpm vitest run src/compare src/print/compare src/pages` FAIL.
- [ ] **Step 3: 구현** — `sampleNotice`와 같은 꼴, 같은 자리, 같은 모양.
- [ ] **Step 4: 확인** — `cd ui && pnpm lint && pnpm test && pnpm build` 0.
- [ ] **Step 5: 커밋** — `feat(compare): 상태 코드 규칙이 다른 run을 비교할 때 알림`

---

## 카피 정본 (`ko.ts`, 글자 그대로)

| 키(제안) | 글 |
|---|---|
| `validity.reason.status_unchecked_errors(name, count)` | 상태 코드를 보지 않는 스텝 「${name}」이 4xx·5xx 응답 ${count}건을 받았습니다. 상태 코드로는 오류로 세지 않았습니다 |
| `validity.reason.no_response_validation` (규칙 1 — 지금 글, 바꾸지 않는다) | 응답 검증(status assert)과 SLO 기준이 없어 성공·실패를 확정할 수 없습니다 |
| `validity.reason.no_response_validation_rule2` | 상태 코드 검사와 판정 기준이 없어 성공·실패를 확정할 수 없습니다 |
| `validity.narrative.unchecked_steps_error_free` (cannot_claim 목록과 같은 자리) | 상태 코드를 보지 않는 스텝이 정상 응답했다 |
| 준비 실패 종류 `http_status` (`status_assert` 곁) | 상태 코드 400 이상 |
| `report.sample.passedHelpRule2` | 오류로 세지 않은 요청입니다. 상태 코드 검사를 적지 않은 스텝은 400 이상 응답을 오류로 셉니다. |
| `compare.statusRuleNotice` | 두 run이 오류를 세는 규칙이 다릅니다. 한쪽은 상태 코드 검사가 없는 스텝의 4xx·5xx를 오류로 세지 않았습니다 — 오류율을 그대로 견주지 마세요. |
| 임시 검사 줄 「보지 않음」 | 보지 않음 |
| 인쇄 콜아웃 uncounted (규칙 2, ko.ts:3159 곁) | 확인 필요: ${items}은 상태 코드를 보지 않도록 정한 단계라 오류율에 포함되지 않았습니다. 포함하면 오류율은 ${a} → ${b}${조사} 됩니다. |
| 인쇄 콜아웃 unknown (규칙 2, :3161 곁) | ${items}은 오류에 포함됐는지 확정할 수 없습니다(상태 코드를 보지 않고 값을 꺼내는 단계). |
| 인쇄 한 줄 (규칙 2, :3164 곁) | 확인 필요: 상태 코드를 보지 않는 단계 ${n}곳 — 표준판 참조 |
| 인쇄 범례 라벨 `print.legend.uncounted` (규칙 2, :3172 곁) | 오류에서 제외된 응답(상태 코드 안 봄) |
| 인쇄 용어 풀이 uncounted (규칙 2, :3316 곁) | term 「보지 않음(제외)」 · text 「상태 코드를 보지 않도록 정한 단계라 오류에서 제외된 응답」 |
| 인쇄 문장 (규칙 2, :3538 곁) | '${step}'에서 ${code} 응답 ${n}건이 있었지만 상태 코드를 보지 않도록 정한 단계라 오류에서 제외됐습니다. |

비교 공정성의 「응답 코드 검사 추가·제거·바뀜」 글(`ko.ts:2773-2775`)은 그대로 쓴다.

## 마무리 (task 밖 — orchestrator)

1. **성능**: `/perf-ab master`로 검사 없는 스텝 1개 시나리오의 요청당 CPU를 잰다. 결과를 build-log에 적는다.
2. **최종 리뷰**: `handicap-reviewer`(BASE = 이 plan 커밋 직전 커밋). 초점은 셋이다.
   - 옛 동작(검사 없음 = 통과)에 기대던 다른 크레이트 소비자가 없는가(TUI·desktop·schedule).
   - 규칙 1 run 리포트가 byte-identical인가.
   - `Assertion::Status` 남은 자리가 맞는가.
3. **보안**: `finish-slice` §0 grep 결과로 판단한다. 요청 실행 경로를 건드리므로 `security-reviewer`를 돌린다. 오류 글에 주소·본문이 없는지 본다.
4. **라이브**(`/live-verify`, spec §8 표의 ②a 행): 먼저 master 바이너리로 규칙 1 run을 만든 DB를 준비하고, 워크트리 바이너리 + `cargo build -p handicap-worker`로 확인한다.
   - US1과 US1 변형(VU 멈춤 실측)
   - US2(YAML 목록)
   - US3 리포트 부분(YAML `any`)
   - US5(GUI 보드 + `handicap-tui`)
   - 비교 알림, 인쇄 보고서(규칙 1·2)
5. **기록**: build-log 단락, roadmap §B 새 블록(번호는 `grep -n '^### B' docs/roadmap.md` 마지막+1). ADR-0064와 CLAUDE.md 인덱스 한 줄도 쓴다. ②b는 같은 브랜치에서 이어 하므로 머지는 사용자 지시를 따른다. §B 블록에 넣을 것:
   - 판단·연기(spec §10)와 릴리즈 노트 줄(spec §5)
   - plan 판단(사용자 확인 대기): 인쇄 규칙 2 글 다섯 줄과 「검사 추가 권함」 뺌, 비교 인쇄 알림 자리, `status_rule` `.optional()`
   - `trustPrefs` 지문이 ②a에서 이미 한 번 풀림
   - 모니터 사유 변화: 검사 없는 스텝이 503을 받고 본문 읽기도 실패하면 사유가 「본문 읽기 실패」에서 「HTTP 503」으로 바뀐다. 검사 있는 스텝과 같은 순서다.
