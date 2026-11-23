# 준비 스텝 슬라이스 B2 (인쇄 본문·내보내기·비교·실행 중 준비 진행) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

REVIEW-GATE: APPROVED

**Goal:** 준비 스텝 통계를 인쇄 보고서 본문, CSV/XLSX 내보내기, run 비교(화면·내보내기·인쇄 비교 요약 한 줄)에 넣고, 실행 중 화면에 준비를 마친 VU 수를 보여 준다. 준비가 없는 run은 네 자리 모두 지금과 같다.

**Architecture:** 이미 있는 리포트 `setup` 블록(`ReportJson.setup` / UI `report.setup`)을 네 자리가 각자 읽는다 — 새 집계 없음. 서버는 `export.rs`가 `ReportJson.setup`에서 시트·구획을 만들고, UI는 인쇄(`ui/src/print/`)와 화면 비교(`ui/src/compare/`)가 `report.setup`에서 만든다. 실행 중 숫자만 `GET /api/runs/{id}` 응답에 새 키 `setup_live`로 싣는다(`run_section_outcomes` 합).

**Tech Stack:** Rust(axum · sqlx/SQLite · rust_xlsxwriter · csv · calamine[테스트]) · TypeScript/React · Zod · vitest/RTL · Playwright(라이브)

**Spec:** `docs/superpowers/specs/2026-11-23-vu-setup-steps-b2-design.md`. US 블록은 spec 머리(「사용자 스토리 (US)」). 이 plan의 `§N`은 그 spec의 절이다.

**목업(시각 기준, 사용자 승인 2026-11-23):** `docs/superpowers/specs/2026-11-23-vu-setup-steps-b2-mockups/b2-screens.html`. **이 파일의 CSS가 시각 기준이다**: 장면 1(인쇄 절 — `.p-line`·`.p-small`·표 열 폭), 장면 2(실행 중 줄 — `.setup-live`와 그 자식들), 장면 3(비교 묶음). 값을 그대로 옮긴다(목업의 `--s*`는 `slate-*`, `--a500`은 `accent-500`, `--am*`는 `amber-*`). 노란 바탕(`.new`·`mark`)은 「새로 생기는 곳」 표시라 구현하지 않는다. 목업과 다르게 가는 곳은 spec §9(절 번호 3 · 코드 0 낱말 「응답 없음」 · XLSX 영문 키 · CSV 머리 · 기존 차이 표시) — 사용자 승인.

## Global Constraints

- **준비가 없는 run의 출력은 바뀌지 않는다**(US5): 인쇄 블록 목록·절 제목 글자, CSV 바이트, XLSX 시트 목록, `compareReports`의 기존 칸, run 조회 응답 키. 각 task의 「불변」 테스트가 이것을 지킨다.
- 준비 숫자를 본 집계(요약·단계별 결과·판정·비교의 요약/스텝 묶음)에 섞지 않는다(ADR-0062 D7).
- 새 폴링·push를 만들지 않는다(ADR-0051·0059). proto·엔진·워커·마이그레이션 **0-diff**.
- UI 문구는 전부 `ui/src/i18n/ko.ts` 경유(ADR-0035). 인쇄·보고서 문구는 보고서 문체(working-rules §8), 화면 문구에 「로그인」을 쓰지 않는다. 값 뒤 조사는 인쇄 비교에서 `josa()`.
- 서버 내보내기 머리글은 영문 키(기존 시트 관례). 실패 종류는 와이어 글자 그대로.
- `ko.ts` 키를 옮기거나 지우는 task는 `grep -rn "<키>" crates/`를 돌려 Rust 쪽 소비처가 없음을 확인한다.
- 놀라운 동작을 변호하는 주석을 쓰지 않는다(working-rules §7) — 고치거나 report에 적는다.
- 회귀 가드 테스트는 되돌려 확인한다(고친 줄을 옛 상태로 → RED → 원복 → GREEN). 결과를 task report에 적는다.
- UI 테스트 파일은 `__tests__/` 안에만(vitest `include`). **테스트 파일을 먼저 고친 뒤 src를 고친다**(`tdd-guard`). `ko.x(n)` 문구 단언은 자기참조를 피한다(리터럴 한 건 또는 숫자 단언 병기).
- src 편집은 Edit 도구로만(python·sed 금지 — 훅을 건너뛴다).
- UI task 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`(인자 없는 전체). cargo task 커밋은 pre-commit이 cargo 게이트 전체를 돈다(수 분) — 단일 foreground 호출(600000ms), `| tail` 금지, `--no-verify` 금지, 그동안 다른 `cargo` 금지. 커밋 메시지 끝에 저장소의 attribution 줄(디스패치 brief가 준다).
- 워크트리-격리 세션: git은 단독 호출·리터럴 경로로(`cd … && git …`·`;` 복합 금지), 커밋 메시지는 `-F <파일>`.
- task report는 `.superpowers/sdd/`에만. 워크트리 루트에 `.md`를 만들거나 `git add`하지 않는다.

## Review Focus

1. **준비가 없는 실행 중 run의 조회 응답에 `setup_live`가 실리는 것** — `SUM`만 읽고 `COALESCE`하면 생긴다. 기대: 키 없음. → Task 8 `get_running_run_without_setup_rows_has_no_setup_live_key`.
2. **이름이 같은 준비 스텝 둘을 비교** — React key 충돌(행이 사라지거나 경고). 기대: 두 행 모두, `console.error` 없음. → Task 4 `console.error` 스파이 테스트.
3. **비교하는 run의 준비 스텝 구성이 다름**(한쪽에만 있는 스텝, 순서 다름) — 기대: 기준 run 순서 + 첫 등장 순, 없는 칸은 「—」·델타 없음, 화면과 XLSX의 행 순서가 같다. → Task 3·4의 3-run 픽스처.
4. **준비 스텝이 많아 인쇄 표가 쪽을 넘김** — 이어지는 쪽 제목에 요약 줄이 다시 찍히면 안 되고 조각은 2행 이상. → Task 6 렌더 테스트 + Task 10 라이브(20개).
5. **실행 중 줄의 분모보다 완료+실패가 큼**(풀에서 줄여 실행·옛 프로필) 또는 `max_in_flight` 없는 open-loop — 기대: 막대는 100%에서 잘리고 글은 사실 그대로, 분모 없으면 막대 없음. → Task 9 테스트.

---

### Task 1: 단일 run 내보내기 — XLSX `Setup` 시트 · CSV 준비 구획 (spec §4.1·§4.2)

**Files:**
- Modify: `crates/controller/src/export.rs` (`report_to_csv`, `report_to_xlsx`, 새 도우미, `mod tests`)

**Interfaces:**
- Consumes: `crate::report::{ReportJson, SetupReport, SetupStepReport}`(`report.rs` — `setup: Option<SetupReport>`, `SetupReport { ok, failed, interrupted, steps }`, `SetupStepReport { step_id, count, errors, p50_ms, p95_ms, max_ms, status_counts: BTreeMap<String,u64>, failure_kinds: BTreeMap<String,u64> }`), `handicap_engine::Scenario::{from_yaml, setup_steps}`.
- Produces(이 task 안에서 쓴다 — Task 3은 `report_with_setup` 픽스처만 쓴다):
  - `fn setup_step_names(scenario_yaml: &str) -> std::collections::HashMap<String, String>` — 준비 스텝 `id → name`. YAML을 못 읽으면 빈 맵(fail-soft).
  - `fn status_counts_text(m: &std::collections::BTreeMap<String, u64>) -> String` — `"0: 1, 200: 47, 503: 2"`(맵 순서, `", "`로 이음).
  - `fn merged_failure_kinds(s: &SetupReport) -> std::collections::BTreeMap<String, u64>` — 스텝들의 `failure_kinds` 합.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `export.rs` `mod tests`에. 픽스처 도우미 `fn report_with_setup() -> ReportJson`: `report_with_steps(...)`에 `scenario_yaml`(준비 스텝 둘 `01HZZZZZZZZZZZZZZZZZZZZZA1` 이름 `sign-in`, `…B2` 이름 `roles` + 본 스텝 하나, `version: 1`)과 `setup: Some(SetupReport { ok: 47, failed: 3, interrupted: 0, steps: [A1 {count 50, errors 3, p50 92, p95 410, max 5004, status {"0":1,"200":47,"503":2}, kinds {"status_assert":2,"connect_timeout":1}}, B2 {count 47, errors 0, p50 33, p95 51, max 70, status {"200":47}, kinds {}}] })`를 채운다(ULID 픽스처에 `I`·`L`·`O`·`U` 금지).

```rust
#[test]
fn xlsx_setup_sheet_follows_steps_and_holds_setup_numbers() {
    // 시트 순서: Summary, Steps, Setup, Windows, Status …
    // Setup!A1:B3 = ("setup_ok",47) ("setup_failed",3) ("setup_interrupted",0)
    // 5행 머리 = step_id,name,count,error_count,p50_ms,p95_ms,max_ms,status_counts
    // 6행 = A1 id,"sign-in",50,3,92,410,5004,"0: 1, 200: 47, 503: 2"
    // 7행 = B2 id,"roles",47,0,33,51,70,"200: 47"
    // 9행 머리 = failure_kind,count ; 10–11행 = ("connect_timeout",1) ("status_assert",2)  (BTreeMap 순서)
}
#[test]
fn xlsx_setup_sheet_omits_failure_kind_table_when_no_kinds() { /* kinds 전부 빈 맵 → 8행 이후 빈 칸 */ }
#[test]
fn xlsx_setup_sheet_name_blank_when_scenario_unreadable() { /* scenario_yaml = "{{{ not yaml" → name 칸 None|Empty, 숫자는 그대로 */ }
#[test]
fn xlsx_without_setup_has_no_setup_sheet() { /* report_with_steps(...) → sheet_names()에 "Setup" 없음, 목록이 추가 전과 같다 */ }
#[test]
fn csv_setup_section_follows_steps_after_blank_line() {
    // String::from_utf8(report_to_csv(&report_with_setup())) 가
    // "<기존 본 스텝 표>\n\nsetup_ok,setup_failed,setup_interrupted\n47,3,0\nsetup_step_id,count,error_count,p50_ms,p95_ms,max_ms\n<A1>,50,3,92,410,5004\n<B2>,47,0,33,51,70\n" 로 끝난다
}
#[test]
fn csv_without_setup_is_unchanged() { /* report_with_steps 픽스처의 출력 바이트를 리터럴로 고정 */ }
```

XLSX 읽기는 같은 파일의 기존 calamine 왕복 테스트(`xlsx_other_basis_sheet_holds_other_summary_and_steps`)의 방식을 따른다. 빈 칸 단언은 `matches!(v, None | Some(Data::Empty))`.

- [ ] **Step 2: 실패를 확인한다** — `cargo nextest run -p handicap-controller export::tests::` → 새 테스트 가운데 4건 FAIL(시트·구획 없음), 「불변」 2건(`xlsx_without_setup_has_no_setup_sheet`·`csv_without_setup_is_unchanged`)은 PASS. 「불변」 2건의 기대값은 구현 **전에** 지금 출력으로 리터럴을 박는다.

- [ ] **Step 3: 구현한다**
  - 도우미 셋(Interfaces의 시그니처)과 `fn write_setup_sheet(wb: &mut Workbook, s: &SetupReport, names: &HashMap<String, String>)` — 레이아웃은 spec §4.1 그대로(1–3행 요약, 5행 머리, 6행부터 스텝, 빈 행 하나, `failure_kind`/`count` 표는 합친 맵이 비어 있지 않을 때만). 숫자는 `write_number`.
  - `report_to_xlsx`: Steps 시트를 쓴 직후 `if let Some(s) = &report.setup { write_setup_sheet(...) }`.
  - `report_to_csv`: 준비가 있으면 본 스텝 표 `into_inner()` → `push(b'\n')` → 새 `csv::Writer`(3열 요약: 머리 + 한 행) → `into_inner()` → 새 `csv::Writer`(6열 스텝 표). 선례 `report_to_stairs_csv`. `flexible` 금지. 준비가 없으면 지금 코드 경로 그대로 반환.

- [ ] **Step 4: 통과를 확인한다** — `cargo nextest run -p handicap-controller export::` → 전부 PASS.

- [ ] **Step 5: 되돌려 확인** — `report_to_xlsx`의 `if let Some`을 무조건 빈 `SetupReport`로 쓰게 잠깐 바꿔 `xlsx_without_setup_has_no_setup_sheet` RED 확인 → 원복.

- [ ] **Step 6: 커밋** — `feat(controller): 단일 run 내보내기에 준비 스텝 — XLSX Setup 시트 · CSV 준비 구획`

---

### Task 2: 델타 극성 — 준비 metric 셋 + 패리티 픽스처 (spec §5.1 극성·패리티)

**Files:**
- Modify: `testdata/compare_golden.json` (`expected.polarity` 블록 추가 — 기존 `expected.summary`·`reports`는 한 글자도 안 바꾼다)
- Modify: `crates/controller/src/export.rs` (`delta`의 `lower_is_better`, `mod tests`)
- Modify: `ui/src/compare/compareReports.ts` (`LOWER_IS_BETTER`)
- Test: `ui/src/compare/__tests__/compareReports.test.ts`

**Interfaces:**
- Produces(Task 3·4가 쓴다): metric 글자 `"setup_ok"`(높을수록 좋음) · `"setup_failed"`·`"setup_errors"`(낮을수록 좋음). `delta("setup_failed", base, val)` / `computeDelta("setup_failed", base, val)`.

- [ ] **Step 1: 픽스처에 블록을 더한다** — `expected.polarity`: 객체 배열 `{ "metric", "base", "val", "pct", "polarity" }`(`pct`는 기준 0이면 `null`, `polarity`는 `"good"|"bad"|"neutral"`). 열두 항목 — metric 셋 × {늘어남, 줄어듦, 같음, 기준 0에서 늘어남}. 값은 손으로 계산한다:
  - `setup_ok`: (50→47) pct −0.06 bad · (47→50) pct 0.06382978723404255 good · (50→50) pct 0 neutral · (0→5) null good
  - `setup_failed`: (2→3) 0.5 bad · (3→2) −0.3333333333333333 good · (3→3) 0 neutral · (0→3) null bad
  - `setup_errors`: (4→6) 0.5 bad · (6→3) −0.5 good · (0→0) null neutral · (0→2) null bad

- [ ] **Step 2: 양쪽에 실패하는 테스트를 쓴다**
  - Rust `export::tests::golden_polarity_matches`: `expected["polarity"]` 배열을 돌며 `delta(metric, base, val)`의 `pct`(1e-12 허용)와 `polarity`를 대조. 배열 길이 12를 단언(빈 배열 공허 통과 방지).
  - TS `compareReports.test.ts`: 같은 배열을 `readFileSync`로 읽어 `computeDelta`와 대조(같은 파일의 기존 골든 읽기 방식), 길이 12 단언.

- [ ] **Step 3: 실패를 확인한다** — `cargo nextest run -p handicap-controller export::tests::golden_polarity_matches` FAIL(`setup_failed`·`setup_errors`가 bad↔good 뒤집힘), `cd ui && pnpm test compareReports` FAIL.

- [ ] **Step 4: 구현한다** — Rust `matches!(metric, "p50_ms" | "p95_ms" | "p99_ms" | "error_rate" | "setup_failed" | "setup_errors")`, TS `LOWER_IS_BETTER`에 같은 둘. `setup_ok`는 집합 밖(= 높을수록 좋음).

- [ ] **Step 5: 통과 + 되돌려 확인** — 양쪽 PASS. Rust 집합에서 `"setup_errors"`만 빼 Rust 테스트 RED 확인 → 원복. TS 집합에서 `"setup_failed"`만 빼 TS 테스트 RED 확인 → 원복. 기존 `golden_summary_deltas_match`와 TS 기존 골든 테스트가 그대로 PASS.

- [ ] **Step 6: 커밋** — `feat: 비교 델타 극성에 준비 metric(setup_ok·setup_failed·setup_errors) + 패리티 픽스처`(cargo + UI 게이트 둘 다 돈다)

---

### Task 3: 비교 내보내기 — CSV 두 행 · XLSX `Setup` 시트 (spec §4.3)

**Files:**
- Modify: `crates/controller/src/export.rs` (`comparison_to_csv`, `comparison_to_xlsx`, `mod tests`)

**Interfaces:**
- Consumes: Task 1의 `report_with_setup` 픽스처·도우미, Task 2의 metric 글자, 기존 `delta`·`delta_cell_text`·`fmt_bad`/`fmt_good`.
- Produces: `fn setup_step_order(reports: &[ReportJson], baseline_idx: usize) -> Vec<String>` — 준비 스텝 id 순서: 기준 run의 `setup.steps` 순서, 그 뒤 다른 run에만 있는 id를 리포트 순서·그 안의 스텝 순서로(첫 등장 순, 중복 없음). **Task 4의 TS 구현이 같은 규칙이다.**

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```rust
#[test]
fn setup_step_order_is_baseline_then_first_seen() {
    // A(기준): [s1, s2]  B: [s3, s1]  C: 준비 없음  → [s1, s2, s3]
    // 기준을 B로 바꾸면 → [s3, s1, s2]
}
#[test]
fn comparison_csv_setup_rows_before_basis() {
    // 3-run(A 기준 ok50/failed0, B 준비 없음, C ok47/failed3), basis 있는 픽스처
    // — 준비 없는 run을 **가운데**에 둔다(뒤 열이 밀리는지 보려면 그 뒤에 열이 있어야 한다).
    // 열: metric, A, B, C, delta_pct B, delta_pct C
    // 행 순서: … error_rate, setup_ok, setup_failed, basis
    // setup_ok 행: "setup_ok,50,,47,,-0.060000"   (B 값 칸·B 델타 칸 빈 칸)
    // setup_failed 행: "setup_failed,0,,3,,"       (기준 0 → pct 없음 → 빈 칸)
}
#[test]
fn comparison_csv_without_setup_is_unchanged() { /* 준비 없는 2-run 출력 바이트를 리터럴로 고정 */ }
#[test]
fn comparison_xlsx_setup_sheet() {
    // 픽스처: A(기준) 준비 [s1 {p95 120, errors 1}, s2 {p95 47, errors 0}] ok50/failed0
    //         B 준비 없음
    //         C 준비 [s3 {p95 30, errors 0}, s1 {p95 410, errors 3}] ok47/failed3
    // 시트 순서에 "Setup"이 "Steps" 다음. A1 머리 = "metric", 그 뒤 run id 셋, 그 뒤 "Δ% <B id>", "Δ% <C id>".
    // 행: setup_ok · setup_failed · "<s1> p95_ms" · "<s1> error_count" · "<s2> p95_ms" · "<s2> error_count" · "<s3> p95_ms" · "<s3> error_count"
    // - B(준비 없음)의 값 칸·Δ% B 칸은 모든 행에서 빈 칸(None|Empty)이고, **Δ% C 칸이 제 열에 있다**(열 정렬):
    //   "setup_ok" 행 Δ% C = "▲ -6.0%" (줄어듦 = 나빠짐), "<s1> p95_ms" 행 Δ% C = "▲ +241.7%" (120 → 410).
    // - "<s1> error_count" 행 Δ% C 는 나빠짐 표시("▲ +200.0%")  ← delta("setup_errors", 1, 3). delta("error_count", …)면 좋아짐으로 뒤집힌다.
    // - s2(C에 없음): C 값·Δ% C 빈 칸.  s3(기준에 없음): C 값은 숫자, Δ% C 빈 칸.
}
#[test]
fn comparison_xlsx_without_setup_has_no_setup_sheet() {}
```

Δ 글자의 정확한 모양은 같은 파일 `comparison_xlsx_steps_delta`의 기대값 표기를 따른다(`delta_cell_text`가 만든다).

- [ ] **Step 2: 실패를 확인한다** — 먼저 「불변」 둘(`comparison_csv_without_setup_is_unchanged`·`comparison_xlsx_without_setup_has_no_setup_sheet`)만 쓰고 `cargo nextest run -p handicap-controller export::tests::comparison_` → PASS(기대값은 지금 출력으로 박은 리터럴). 그다음 나머지 테스트와 `setup_step_order`의 빈 몸통(`todo!()`)을 더해 다시 돌린다 → 새 테스트 FAIL.

- [ ] **Step 3: 구현한다**
  - `setup_step_order`(Interfaces의 규칙).
  - `comparison_to_csv`: `reports.iter().any(|r| r.setup.is_some())`일 때만, `basis` 행 **앞**에 `setup_ok`·`setup_failed` 행. 값 칸은 준비가 없으면 빈 글자. 델타 칸은 기준·후보 둘 다 준비가 있고 `delta(..).pct`가 `Some`일 때만 `{:.6}`.
  - `comparison_to_xlsx`: Steps 시트 직후 `Setup` 시트(준비가 하나라도 있을 때만). `Steps` 시트의 루프와 같은 구조 — `base`/`val`을 `Option<f64>`로 두고 **둘 다 `Some`일 때만** Δ 기록, `dcol`은 비-기준 run마다 무조건 +1. `delta`에 넘기는 metric: `setup_ok` / `setup_failed` / `p95_ms` / `setup_errors`(행 이름 `error_count`와 다르다).

- [ ] **Step 4: 통과 + 되돌려 확인** — PASS. `delta("setup_errors", …)`를 `delta("error_count", …)`로 바꿔 `comparison_xlsx_setup_sheet` RED 확인 → 원복. `dcol` 전진을 조건부 기록 안으로 옮겨 열 정렬 단언(Δ% C가 제 열) RED 확인 → 원복 — 준비 없는 B가 가운데라서 RED가 난다.

- [ ] **Step 5: 커밋** — `feat(controller): 비교 내보내기에 준비 스텝 — CSV 두 행 · XLSX Setup 시트`

---

### Task 4: 화면 비교 — 「준비 스텝」 묶음 (spec §5.1)

**Files:**
- Modify: `ui/src/compare/compareReports.ts`
- Modify: `ui/src/components/compare/CompareMatrix.tsx`
- Modify: `ui/src/pages/ScenarioComparePage.tsx`
- Modify: `ui/src/i18n/ko.ts` (`ko.compare`)
- Test: `ui/src/compare/__tests__/compareReports.test.ts`, `ui/src/components/compare/__tests__/CompareMatrix.test.tsx`, `ui/src/pages/__tests__/`의 비교 페이지 테스트 파일(구현자가 `ls ui/src/pages/__tests__ | grep -i compare`로 찾는다 — 없으면 `ScenarioComparePage.setup.test.tsx` 새로)

**Interfaces:**
- Consumes: Task 2의 `computeDelta` 극성. `Report["setup"]`(`ReportSetupSchema` — `ui/src/api/schemas.ts`), `setupSteps(model)`(`ui/src/scenario/model.ts`).
- Produces:
  - `CompareRow`에 선택 칸 `id?: string`.
  - `CompareResult`에 `setup: CompareRow[]`.
  - 행 모양: `{ label: "setup_ok", metric: "setup_ok" }` · `{ label: "setup_failed", metric: "setup_failed" }` · 스텝마다 `{ label: <step_id>, id: <step_id>, metric: "p95_ms" }` · `{ label: <step_id>, id: <step_id>, metric: "setup_errors" }`. 순서는 Task 3의 `setup_step_order`와 같은 규칙.
  - `ko.compare.setupOk = "준비 성공"`, `ko.compare.setupFailed = "준비 실패"`, `ko.compare.setupStepP95 = (name: string) => \`${name} p95 ms\``, `ko.compare.setupStepErrors = (name: string) => \`${name} 오류\``.

- [ ] **Step 1: 실패하는 테스트를 쓴다**
  - `compareReports.test.ts`:
    - `setup rows: baseline order then first-seen` — A(기준) `[s1,s2]`, B `[s3,s1]`, C 준비 없음 → `result.setup.map(r => [r.label, r.metric])`가 `[["setup_ok","setup_ok"],["setup_failed","setup_failed"],["s1","p95_ms"],["s1","setup_errors"],["s2","p95_ms"],["s2","setup_errors"],["s3","p95_ms"],["s3","setup_errors"]]`.
    - `setup rows: run without setup → null cells, no delta` — C의 모든 칸 `{ value: null, delta: null }`.
    - `setup rows: step missing in baseline → no delta` — s3 행의 B 칸 `delta === null`, 값은 숫자.
    - `setup rows: polarity` — `setup_ok` 50→47 bad, `setup_failed` 0→3 bad(pct null), `setup_errors` 3→0 good.
    - `no setup anywhere → setup is []` 그리고 **기존 결과 칸이 그대로** — 준비 없는 픽스처에서 `summary`·`steps`·`status`·`verdict`·`stepMismatch`를 `toEqual`. 기대값은 src를 고치기 **전에** 지금 출력을 리터럴로 박는다(같은 함수를 다시 불러 만든 기대값은 자기참조라 공허하다).
    - `stepMismatch ignores setup steps` — 본 스텝이 같고 준비 스텝만 다른 두 리포트 → `false`.
  - `CompareMatrix.test.tsx`(이 파일의 기존 `CompareResult` 리터럴 세 곳에 `setup: []`를 더한다 — 안 하면 `tsc -b`가 깨진다):
    - `renders 준비 스텝 section between 스텝 and 상태` — 묶음 머리(`th[colspan]`) 글자의 순서가 `[요약 제목, 스텝 제목, "준비 스텝", 상태 제목]`.
    - `no setup rows → no 준비 스텝 section` — 묶음 머리 수가 3.
    - `same-named setup steps render both rows without key warning` — `label`이 같은 두 행(`id` 다름) → `vi.spyOn(console, "error")`의 호출 인자 어디에도 `"same key"`가 없고 행이 둘.
    - `null cell renders —`.
  - 페이지 테스트: 기준 run의 `scenario_yaml`에 준비 스텝 `{id: s1, name: "sign-in"}` → 행 머리 글자 `"sign-in p95 ms"`·`"sign-in 오류"`·`"준비 성공"`·`"준비 실패"`가 보인다(리터럴로 단언). 이름이 빈 준비 스텝은 `"POST /login p95 ms"`(본 스텝과 같은 대체값). 기준 시나리오에 없고 다른 run 시나리오에만 있는 스텝은 그쪽 이름, 어디에도 없으면 `step_id`.

- [ ] **Step 2: 실패를 확인한다** — `cd ui && pnpm test compareReports` / `pnpm test CompareMatrix` / 페이지 테스트 → FAIL.

- [ ] **Step 3: 구현한다**
  - `compareReports`: `reports.some(r => r.setup)`이 거짓이면 `setup: []`. 값 추출 — `setup_ok` → `r.setup?.ok ?? null`, `setup_failed` → `r.setup?.failed ?? null`, 스텝 행 → 그 run의 `setup.steps.find(s => s.step_id === id)`의 `p95_ms` / `errors`(없으면 `null`). 델타는 기준·후보 값이 둘 다 `null`이 아닐 때만 `computeDelta(metric, base, val)`. `stepMismatch` 계산은 건드리지 않는다.
  - `CompareMatrix`: `SectionRows`의 key를 `row.metric + (row.id ?? row.label)`로. `<SectionRows title={ko.report.setup.title} rows={result.setup} runCount={colCount} />`를 스텝 묶음과 상태 묶음 사이에.
  - `ScenarioComparePage`: 준비 스텝 전용 이름 맵을 **따로** 만든다(본 스텝의 `stepLabelMap`에 섞지 않는다 — id가 겹치면 본 스텝 행 이름이 바뀐다). 기준 리포트를 먼저, 그다음 나머지 리포트를 순서대로 훑어 **아직 없는 id만** 채운다. 본 스텝의 기존 맵은 건드리지 않는다. `labeledResult`에 `setup: result.setup.map(...)` — `metric === "setup_ok"` → `ko.compare.setupOk`, `"setup_failed"` → `ko.compare.setupFailed`, `id`가 있으면 이름(`map.get(id) ?? id`)에 metric에 따라 `setupStepP95`/`setupStepErrors`.

- [ ] **Step 4: 통과 + 되돌려 확인** — PASS. key를 옛 식(`row.metric + row.label`)으로 되돌려 key 경고 테스트 RED 확인 → 원복. `compareReports`의 `some` 가드를 지워(항상 두 행) 「no setup anywhere」 RED 확인 → 원복.

- [ ] **Step 5: 게이트 + 커밋** — `cd ui && pnpm lint && pnpm test && pnpm build` → `feat(ui): run 비교 표에 준비 스텝 묶음`

---

### Task 5: 인쇄 절 번호를 계산으로 (동작 불변 리팩터, spec §3.1)

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`ko.print.section`)
- Modify: `ui/src/print/buildPrintDoc.ts` (`PrintDoc.sectionNo`, 번호 계산)
- Modify: `ui/src/print/components/SpeedBandTable.tsx` (`SpeedTableTitle`, 표 `aria-label`)
- Modify: `ui/src/print/PrintDocument.tsx` (`SpeedTableTitle`·`SpeedBandTable` 호출 두 곳씩)
- Modify: `crates/controller/src/report.rs` (`speed_bands` doc 주석 한 줄 — 「인쇄 보고서 3절」 → 「인쇄 보고서의 응답 속도 구간 절」)
- Test: `ui/src/print/__tests__/buildPrintDoc.test.ts`, `speedBandTable.test.tsx`, `PrintDocument.test.tsx`

**Interfaces:**
- Produces(Task 6이 쓴다):
  - `ko.print.section`: `overview`·`summaryBox`·`steps`·`appendix`·`continued`는 그대로(고정 글자). `speed`·`chart`·`conditions`·`glossary`는 `(n: number) => string`(`\`${n}. 단계별 응답 속도 구간\`` 등 — 번호 뒤 글자는 지금과 같다). `chartShifted`·`conditionsShifted`·`glossaryShifted`는 지운다. 새 `setup: (n: number) => \`${n}. 준비 스텝 결과\``.
  - `PrintDoc.sectionNo: { setup: string | null; speed: string | null; chart: string; conditions: string; glossary: string }` — 있는 절만 준비 → 속도 구간 → 그림 → 조건 → 용어 순서로 3부터 센다. 이 task에서는 `setup`이 항상 `null`(Task 6이 켠다) — 계산 함수는 `sectionNumbers(a: { setup: boolean; speed: boolean })`로 `buildPrintDoc.ts`에 두고 export한다.
  - `SpeedTableTitle({ title, continued, measure })` · `SpeedBandTable`에 `title: string` prop(표 `aria-label`).

- [ ] **Step 1: 테스트를 먼저 고친다**
  - `buildPrintDoc.test.ts`의 `sectionNo` `toEqual` 두 건을 새 모양으로 **확장**한다(지우지 않는다) — 글자는 리터럴:
    - 속도 구간 없음: `{ setup: null, speed: null, chart: "3. 시간에 따른 변화", conditions: "4. 측정 조건과 해석 범위", glossary: "5. 용어 풀이" }`
    - 속도 구간 있음: `{ setup: null, speed: "3. 단계별 응답 속도 구간", chart: "4. 시간에 따른 변화", conditions: "5. 측정 조건과 해석 범위", glossary: "6. 용어 풀이" }`
  - 새 테스트 `sectionNumbers: four combinations` — `{setup:true,speed:false}` → setup 3·chart 4·conditions 5·glossary 6, `{setup:true,speed:true}` → setup 3·speed 4·chart 5·conditions 6·glossary 7(글자 리터럴).
  - `speedBandTable.test.tsx`의 제목 단언을 리터럴로(`"3. 단계별 응답 속도 구간"`, 이어짐 `"3. 단계별 응답 속도 구간 (이어짐)"`) + `title` prop 전달. `PrintDocument.test.tsx`의 `sectionNo` 픽스처를 새 모양으로.
  - `PrintDocument.test.tsx`에 `speed section title comes from doc.sectionNo` — `sectionNo.speed = "9. X"`인 doc을 그리면 속도 구간 제목 `h2` 글자가 `"9. X"`.

- [ ] **Step 2: 실패를 확인한다** — `cd ui && pnpm test buildPrintDoc` 등 → FAIL(타입·값).

- [ ] **Step 3: 구현한다** — 위 Interfaces대로. `grep -rn "chartShifted\|conditionsShifted\|glossaryShifted" ui/src crates/` → 0건(테스트 포함). `speed`는 grep으로 못 잡는다 — `SpeedBandTable.tsx`가 `const s = ko.print.section; … s.speed`로 읽고, 함수를 템플릿 글자에 끼워도 tsc가 오류를 내지 않는다. 그 파일의 두 자리(`SpeedTableTitle`의 `h2`, 표 `aria-label`)를 `title` prop으로 바꿨는지 직접 본다(Step 1의 「`9. X`」 테스트가 가드).

- [ ] **Step 4: 통과 + 게이트** — `cd ui && pnpm lint && pnpm test && pnpm build`. `report.rs` 주석 한 줄만 바꾼 `.rs` diff라 cargo 게이트는 fmt·build·clippy만 돈다.

- [ ] **Step 5: 커밋** — `refactor(ui): 인쇄 절 번호를 계산으로 — 준비 절이 들어갈 자리`

---

### Task 6: 인쇄 보고서 「준비 스텝 결과」 절 (spec §3.2–§3.5)

**Files:**
- Create: `ui/src/print/setupTable.ts` (순수 모델)
- Create: `ui/src/print/components/SetupPrintTable.tsx`
- Modify: `ui/src/print/buildPrintDoc.ts` (`PrintDoc.setup`, `sectionNo.setup`, `MEASURE_IDS`, `standardBlocks`)
- Modify: `ui/src/print/PrintDocument.tsx` (`MeasureSheet`·`PageBody`의 표 분기, `AtomicContent`의 `setup:kinds`)
- Modify: `ui/src/print/print.css` (요약 줄·실패 종류 줄)
- Modify: `ui/src/i18n/ko.ts` (`ko.print.setup`)
- Test: `ui/src/print/__tests__/setupTable.test.ts`(새), `SetupPrintTable.test.tsx`(새), `buildPrintDoc.setup.test.ts`(있음 — 확장), `PrintDocument.test.tsx`

**Interfaces:**
- Consumes: Task 5의 `sectionNumbers`·`ko.print.section.setup`. `report.setup`(`ReportSetup`), `readScenarioFacts(...).setupSteps`(`StepFacts { id, name, method, url, … }`), `requestLine(method, url)`·`middleEllipsis`·`requestLineBudget`(`print/redact.ts`), `fmtCount`(`print/format.ts` — 요청 수·오류·**응답 시간 칸 모두**. `fmtMs`는 「0.41초」처럼 단위를 붙이므로 쓰지 않는다: 머리 칸에 이미 `ms`가 있다), `LinePart`·`plain`·`strong`·`partsText`(`i18n/lineParts.ts`), `deriveLoadMode`(`components/run/loadModel.ts`), `ko.print.table.none`(「응답 없음」), `ko.report.errorKinds.labels`, `ko.print.fmt.noTarget`(「–」), `ko.print.section.continued`.
- Produces:

```ts
// print/setupTable.ts
export type SetupRow = {
  stepId: string;
  no: number;                 // 1부터
  name: string;               // 시나리오 이름, 없으면 step_id
  requestLine: string | null; // 본 스텝 표와 같은 가림 경로
  count: number;
  errors: number;
  p50Ms: number | null;       // count === 0이면 null
  p95Ms: number | null;
  maxMs: number | null;
  codes: { label: string; count: number }[]; // 코드 오름차순, "0" → ko.print.table.none
};
export type SetupPrintModel = {
  open: boolean;
  ok: number; failed: number; interrupted: number;
  lead: LinePart[];           // §3.3 요약 줄. 굵은 조각: 준비를 마친 수("47명"), 실패("3명이 실패" — tone "bad")
  rows: SetupRow[];
  kindsLine: string | null;   // "실패 종류: 연결 수립 타임아웃 1 · 상태 코드 검증 실패 2"(종류 글자 오름차순), 없으면 null
};
export function buildSetupModel(a: {
  setup: ReportSetup;
  facts: StepFacts[];         // scenarioFacts.setupSteps (읽지 못했으면 [])
  open: boolean;
}): SetupPrintModel;
```

  - `PrintDoc.setup: SetupPrintModel | null`.
  - `MEASURE_IDS.setupTitle = "setup:title"`, `setupHeader = "setup:header"`, `setupRowId = (stepId) => \`setup:row:${stepId}\``.
  - 블록: `{ kind: "table", id: "setup", titleMm, headerMm, rowsMm }` + atomic `"setup:kinds"`(`kindsLine !== null`일 때만). 위치는 `standardBlocks`의 `notes:unreadable` 뒤 · `speed` 앞.
  - `SetupTableTitle({ title, lead, continued, measure })` — `continued`가 아닐 때만 `lead`를 그린다. `SetupPrintTable({ model, from, to, measure })`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**
  - `setupTable.test.ts` — 요약 줄은 `partsText(model.lead)`를 **리터럴**과 비교한다(숫자 `fmtCount` 포함). 굵은 조각도 단언한다: 실패 경우 `model.lead`에 `{ text: "47명", strong: true }`와 `{ text: "3명이 실패", strong: true, tone: "bad" }`가 있고, 성공만이면 `{ text: "50명", strong: true }`(open은 `"180개"`·`"20개가 실패"`):
    - 성공만(closed, ok 50): `"가상 사용자 50명이 모두 준비를 마쳤습니다. 준비 스텝은 사용자마다 한 번 실행하며, 위 단계별 결과와 요약 숫자에는 들어가지 않습니다."`
    - 중단만(ok 48, interrupted 2): `"가상 사용자 50명 중 48명이 준비를 마쳤습니다. 2명은 준비 도중 측정이 끝났습니다. 준비 스텝은 사용자마다 한 번 실행하며, 위 단계별 결과와 요약 숫자에는 들어가지 않습니다."`
    - 실패(ok 47, failed 3): `"가상 사용자 50명 중 47명이 준비를 마쳤고 3명이 실패했습니다. 실패한 사용자는 본 스텝을 실행하지 않았습니다. 준비 스텝은 사용자마다 한 번 실행하며, 위 단계별 결과와 요약 숫자에는 들어가지 않습니다."`
    - 실패+중단(ok 45, failed 3, interrupted 2): 실패 문장 뒤에 `"2명은 준비 도중 측정이 끝났습니다."`가 오고 그 뒤 끝 문장.
    - open-loop(ok 180, failed 20): `"슬롯 200개 중 180개가 준비를 마쳤고 20개가 실패했습니다. 실패한 슬롯은 run에서 빠졌습니다. 준비 스텝은 슬롯마다 한 번 실행하며, 위 단계별 결과와 요약 숫자에는 들어가지 않습니다."` / 성공만 open: `"슬롯 200개가 모두 준비를 마쳤습니다. …"`
    - 큰 수: ok 123456 → 글에 `"123,456"`.
    - 행: 이름은 facts에서, facts에 없는 id는 `name === stepId`·`requestLine === null`. `count === 0` → `p50Ms`·`p95Ms`·`maxMs`가 `null`. `codes`가 `[{label:"응답 없음",count:1},{label:"200",count:47},{label:"503",count:2}]`.
    - `kindsLine`: 스텝 A `{status_assert: 2}` + 스텝 B `{connect_timeout: 1, status_assert: 1}` → `"실패 종류: 연결 수립 타임아웃 1 · 상태 코드 검증 실패 3"`(리터럴 — 종류 글자 오름차순, 건수 합). 카탈로그에 없는 글자(`"constructor"`·`"zzz_new"`)는 글자 그대로. 종류가 없으면 `null`.
  - `SetupPrintTable.test.tsx`: 머리 칸 글자 `["준비 스텝","요청 수","오류","50% 응답","95% 응답","최대","응답 코드별 건수"]`(작은 글자 `ms` 포함은 `toHaveTextContent`로), 오류 > 0 행에 `p-row--bad`·오류 칸에 `p-bad`, 오류 0 행에는 없음, `count 0` 행의 응답 시간 칸 `"–"`, 최대 5004인 행의 칸 글자가 정확히 `"5,004"`(단위 글자 없음), 코드 칸 글자 `"응답 없음: 1 · 200: 47 · 503: 2"`, `from/to` 조각이 그 행만 그림. 제목: `continued=false`면 `h2` + 요약 줄, `continued=true`면 `h2` 글자가 `"3. 준비 스텝 결과 (이어짐)"`이고 요약 줄 요소가 없다. 요약 줄의 굵은 조각은 `<b>`로, `tone: "bad"` 조각에는 `p-bad` 클래스(목업 `<b class="p-bad">3명이 실패</b>`).
  - `buildPrintDoc.setup.test.ts`(확장): 준비 있는 리포트 → `doc.setup !== null`, `doc.sectionNo.setup === "3. 준비 스텝 결과"`, `chart === "4. 시간에 따른 변화"`; 속도 구간도 있으면 `speed === "4. 단계별 응답 속도 구간"`. `standardBlocks(doc, new Map()).map(b => b.id)`에서 `"setup"`이 `"table"` 뒤·`"chart"` 앞(속도 구간 있으면 `"speed"` 앞), `"setup:kinds"`는 실패 종류가 있을 때만. **준비 없는 리포트**: `doc.setup === null`, 블록 id 목록이 추가 전과 같다(리터럴 배열로 고정 — 속도 구간 있음/없음 둘). `summaryBlocks`의 id 목록에는 준비가 있어도 `"setup"`이 없다. `meta.setupNote`는 그대로 있다.
  - `PrintDocument.test.tsx`:
    - 측정 시트: 준비 있는 doc에 `data-measure="setup:title"`·`"setup:header"`·`"setup:row:<id>"`가 있고 `"table:title"`도 하나(`MeasureSheet` 분기 가드). 측정 시트는 배치가 끝나면 내려가므로 이 단언은 `ready()` **전에** 한다(같은 파일의 속도 구간 측정 테스트 방식).
    - 쪽 렌더(같은 파일의 `spyHeights` 도우미로 높이를 주입해 쪽을 나눈다 — 기존 속도 구간 테스트의 「2절 표는 한 번만」 방식): 준비 스텝 6개, `setup:row:` 높이 60mm(그 밖은 10mm)로 준비 표가 두 쪽 이상에 걸치게 한다 — 본문 한계가 259mm라 행이 125mm를 넘으면 한 쪽에 한 행만 들어가 코드가 맞아도 「2행 이상」이 깨진다. 단언 — 쪽 전체에서 `"2. 단계별 결과"` `h2`가 정확히 1개, `"3. 준비 스텝 결과"` `h2`가 1개, `"3. 준비 스텝 결과 (이어짐)"` `h2`가 1개 이상, 요약 줄 요소는 문서 전체에 정확히 1개(이어지는 쪽에 없다), 준비 표 조각마다 `tbody tr`이 2개 이상(`PageBody` 분기 가드 + Review Focus 4).

- [ ] **Step 2: 실패를 확인한다** — `cd ui && pnpm test setupTable` 등 → FAIL(모듈 없음).

- [ ] **Step 3: 구현한다**
  - `ko.print.setup`: 요약 줄 조각(closed/open 변형), `kindsLead = "실패 종류: "`, 열 머리(`colStep = "준비 스텝"`, `colCount = "요청 수"`, `colErrors = "오류"`, `colP50 = "50% 응답"`, `colP95 = "95% 응답"`, `colMax = "최대"`, `colCodes = "응답 코드별 건수"`, `unitMs = "ms"`). 문장은 Step 1의 리터럴과 글자가 같아야 한다.
  - `buildSetupModel`: `open`은 호출자가 넘긴다 — `buildPrintDoc`에서 `parsed.success ? deriveLoadMode(parsed.data).loadModel === "open" : false`.
  - 표 열 폭(mm, 본문 180): 이름 = 나머지, 요청 수 15, 오류 13, 50% 15, 95% 15, 최대 15, 코드 36(`<colgroup>`, `StepCodeTable`의 방식). 이름 칸은 `p-name`(3줄 clamp) + `p-req`(요청 줄, `middleEllipsis(requestLine, requestLineBudget(nameMm))`). 표 클래스 `p-table p-setup`, `aria-label`은 절 제목.
  - `print.css`: `.p-root .p-setup-lead { margin: 0 0 2mm; }`(목업 `.p-line`), `.p-root .p-setup-kinds { font-size: 8pt; color: var(--sub); margin: 0; }`(목업 `.p-small` — 위 간격은 블록 padding이 맡는다: `.p-block--setup` 규칙이 필요하면 `padding-top: 1.5mm`). 모든 규칙은 `.p-root` 아래.
  - `PrintDocument.tsx`: `MeasureSheet`와 `PageBody` **둘 다**에 `b.id === "setup" && doc.setup` 분기(제목 + 표). `AtomicContent`에 `case "setup:kinds"`.
  - `standardBlocks`: Interfaces의 위치에 삽입. `sectionNo`는 `sectionNumbers({ setup: report.setup != null, speed: speed !== null })`.

- [ ] **Step 4: 통과 + 되돌려 확인** — PASS. `PageBody`의 `setup` 분기를 지워 쪽 렌더 테스트(「2. 단계별 결과」 `h2`가 1개) RED 확인 → 원복. `MeasureSheet`의 `setup` 분기를 지워 측정 시트 테스트 RED 확인 → 원복. `standardBlocks`의 준비 삽입을 무조건으로 바꿔 「준비 없는 리포트 블록 목록」 RED 확인 → 원복.

- [ ] **Step 5: 게이트 + 커밋** — `cd ui && pnpm lint && pnpm test && pnpm build` → `feat(ui): 인쇄 보고서에 준비 스텝 결과 절`

- [ ] **Step 6 (orchestrator): 목업 대조** — 이 커밋 직후 컨트롤러를 띄워(워크트리 자체 바이너리, `/live-verify` 골격) 준비 실패가 있는 run의 인쇄 표준판을 목업 장면 1과 나란히 본다(스크린샷 둘). 어긋난 디자인은 이 task의 fix로 접는다. 구현 subagent에게 맡기지 않는다.

---

### Task 7: 인쇄 비교 — 요약 한 줄 (spec §5.2)

**Files:**
- Modify: `ui/src/print/compare/headline.ts` (`CmpSummaryLine.id`, `cmpSummaryLines`)
- Modify: `ui/src/i18n/ko.ts` (`ko.print.cmp.lines`)
- Test: `ui/src/print/compare/__tests__/headline.test.ts`, `ui/src/print/compare/__tests__/CompareDocument.test.tsx`(`HeadlineBox`는 여기서 그려진다)

**Interfaces:**
- Consumes: `RunModel.report.setup`·`RunModel.profile`(`print/compare/runModel.ts`), `deriveLoadMode`, `josa`(`i18n/josa.ts`), `line()`·`plain`·`strong`(`headline.ts`·`i18n/lineParts.ts`).
- Produces: `CmpSummaryLine.id`가 `1 | 2 | 3 | 4 | 5`. id 5 줄은 `cmpSummaryLines`의 **맨 뒤**.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — 줄 글자는 리터럴:
  - 둘 다 closed, failed 0 → 3: 마지막 줄 `id === 5`, `text === "준비에 실패한 사용자가 0명에서 3명으로 늘었습니다."`
  - failed 5 → 2: `"준비에 실패한 사용자가 5명에서 2명으로 줄었습니다."`
  - 둘 다 open, 1 → 4: `"준비에 실패한 슬롯이 1개에서 4개로 늘었습니다."`
  - 부하 방식이 다름(closed vs open), 0 → 3: `"준비 실패가 0에서 3으로 늘었습니다."`(조사는 `josa`가 숫자 끝소리로 — 1 → 6이면 `"1에서 6으로"`, 2 → 0이면 `"2에서 0으로"`)
  - failed 같음 → id 5 줄 없음. 한쪽만 준비 있음 → 없음. `headline.answer === "incomparable"` → 없음.
  - `text`는 `parts`를 이은 글과 같다(`partsText(parts) === text`).
  - 기존 줄 불변: 준비 없는 두 run의 `cmpSummaryLines` 결과의 `id` 목록과 `text` 목록 — 기대값은 src를 고치기 **전에** 지금 출력을 리터럴로 박는다.
  - 프로필을 읽지 못한 run(`profile: null`)이 한쪽이라도 있으면 단위 없는 문장(단일 인쇄 보고서의 「closed 문구로」와 다르다 — 두 run의 단위가 같은지 알 수 없기 때문).
  - `CompareDocument.test.tsx`: `HeadlineBox` 짧은 판(`short`)에는 id 5 줄이 그려지지 않고, 긴 판에는 `<li>`로 그려진다(key 경고 없음).
  - 알아 둘 것(의도한 동작): 비교 **요약판**도 사다리 단계 3 미만에서는 긴 판 줄 목록(`cmp:lines:full`)을 쓰므로 id 5 줄이 요약판에 나올 수 있고, 한 쪽에 맞추는 단계가 하나 올라갈 수 있다. 준비 실패 수가 다른 두 run에서만 생긴다(준비 없는 비교는 불변).

- [ ] **Step 2: 실패를 확인한다** — `cd ui && pnpm test headline` → FAIL.

- [ ] **Step 3: 구현한다** — `cmpSummaryLines`의 끝에서: `answer !== "incomparable"` 이고 `before.report.setup`·`after.report.setup` 둘 다 있고 `failed`가 다를 때 `line(5, …)`을 push. 단위는 두 run의 `deriveLoadMode(profile).loadModel`이 둘 다 `"closed"`면 사용자/명, 둘 다 `"open"`이면 슬롯/개, 다르거나 프로필이 `null`이면 단위 없는 문장. 문구는 `ko.print.cmp.lines`의 새 키(조각 함수) — 숫자는 `fmtCount`.

- [ ] **Step 4: 통과 + 되돌려 확인** — PASS. 「한쪽만 준비」 가드를 지워 그 테스트 RED 확인 → 원복.

- [ ] **Step 5: 게이트 + 커밋** — `feat(ui): 인쇄 비교 요약에 준비 실패 수 차이 한 줄`

---

### Task 8: 와이어 — run 조회 응답의 `setup_live` (spec §6.1)

**Files:**
- Modify: `crates/controller/src/store/section.rs` (새 읽기 함수 + 테스트)
- Modify: `crates/controller/src/api/runs.rs` (`RunResponse`, `to_response`, `get`, `mod tests`)
- Modify: `ui/src/api/schemas.ts` (`RunSchema`)
- Test: `ui/src/api/__tests__/schemas.setup.test.ts`(있는 파일에 더한다)

**Interfaces:**
- Produces(Task 9가 쓴다):
  - Rust: `pub struct SectionTotals { pub ok: i64, pub failed: i64, pub interrupted: i64 }` · `pub async fn section_outcome_totals(db: &Db, run_id: &str, section: &str) -> sqlx::Result<Option<SectionTotals>>` — 행이 0개면 `None`.
  - Rust: `pub struct SetupLive { pub ok: u64, pub failed: u64, pub interrupted: u64 }`(`Serialize`) · `RunResponse.setup_live: Option<SetupLive>` + `#[serde(skip_serializing_if = "Option::is_none")]`.
  - TS: `SetupLiveSchema = z.object({ ok: z.number().int(), failed: z.number().int(), interrupted: z.number().int() })` · `RunSchema.setup_live: SetupLiveSchema.optional()` · `export type SetupLive`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**
  - `store/section.rs` `mod tests`:
    - `section_outcome_totals_none_without_rows` — 빈 DB → `None`.
    - `section_outcome_totals_sums_workers_and_batches` — 워커 둘·배치 셋의 `setup` 행(ok 10+20+7, failed 0+1+1, interrupted 0) → `Some { ok: 37, failed: 2, interrupted: 0 }`.
    - `section_outcome_totals_ignores_other_sections_and_runs` — 다른 `section` 글자·다른 `run_id` 행은 세지 않는다. 다른 구간 행만 있으면 `None`.
  - `api/runs.rs` `mod tests`(같은 파일 `get_json`·`get_running_stair_run_includes_live`의 방식):
    - `get_running_run_with_setup_rows_includes_setup_live` — running run + `setup` 행 → `v["setup_live"] == json!({"ok":37,"failed":2,"interrupted":0})`.
    - `get_running_run_without_setup_rows_has_no_setup_live_key` — `v.as_object().unwrap().contains_key("setup_live") == false`.
    - `get_completed_run_with_setup_rows_has_no_setup_live_key` — 끝난 run은 행이 있어도 키 없음.
    - `get_pending_run_has_no_setup_live_key`.
  - TS: 키 없는 run 응답이 `RunSchema`를 통과하고 `setup_live === undefined`, 키 있는 응답이 통과, `setup_live: null`은 **거절**(서버는 `null`을 내지 않는다 — 스키마가 `.optional()`임을 못박는다).

- [ ] **Step 2: 실패를 확인한다** — `cargo nextest run -p handicap-controller section_outcome_totals setup_live` → FAIL(컴파일).

- [ ] **Step 3: 구현한다**
  - `section_outcome_totals`: `SELECT COUNT(*) AS n, COALESCE(SUM(ok),0) AS ok, COALESCE(SUM(failed),0) AS failed, COALESCE(SUM(interrupted),0) AS interrupted FROM run_section_outcomes WHERE run_id = ? AND section = ?` — `n == 0`이면 `None`.
  - `to_response`의 구조체 리터럴에 `setup_live: None`(다른 `RunResponse {…}` 리터럴이 있으면 컴파일러가 알려 준다 — 전부 `None`).
  - `get`: `row.status == RunStatus::Running`일 때만 `section_outcome_totals(&state.db, &id, handicap_engine::Section::Setup.as_str())`를 읽어 `resp.setup_live`를 채운다(음수는 `max(0) as u64`). DB 오류는 `?`로 500.
  - `RunSchema`에 한 줄.

- [ ] **Step 4: 통과 + 되돌려 확인** — PASS. 쿼리에서 `n == 0 → None`을 지워(항상 `Some`) `…without_setup_rows_has_no_setup_live_key` RED 확인 → 원복. `get`의 `Running` 조건을 지워 `…completed…` RED 확인 → 원복.

- [ ] **Step 5: 게이트 + 커밋** — cargo + UI 게이트. `feat: run 조회 응답에 실행 중 준비 진행(setup_live)`

---

### Task 9: 실행 중 화면 — 준비 진행 한 줄 (spec §6.2·§6.3)

**Files:**
- Create: `ui/src/components/run/setupLive.ts` (순수 뷰 모델)
- Create: `ui/src/components/run/SetupLiveLine.tsx`
- Modify: `ui/src/pages/RunDetailPage.tsx`
- Modify: `ui/src/i18n/ko.ts` (`ko.runDetail.setupLive`)
- Test: `ui/src/components/run/__tests__/setupLive.test.ts`(새), `SetupLiveLine.test.tsx`(새), `ui/src/pages/__tests__/RunDetailPage.setupLive.test.tsx`(새)

**Interfaces:**
- Consumes: Task 8의 `SetupLive` 타입·`run.setup_live`. `deriveLoadMode`(`components/run/loadModel.ts`), `parseScenarioDoc`(`scenario/yamlDoc.ts`), `setupSteps`(`scenario/model.ts`).
- Produces:

```ts
// components/run/setupLive.ts
export type SetupLiveView = {
  unit: "vu" | "slot";
  ok: number;
  failed: number;
  total: number | null;        // 분모. VU 곡선·max_in_flight 없음 → null
  okPct: number;               // 0–100, total null이면 0
  failedPct: number;           // okPct + failedPct ≤ 100 으로 자른다
};
export function setupLiveView(
  profile: Pick<Profile, "vus" | "max_in_flight" | "target_rps" | "stages" | "vu_stages" | "stair" | "steady">,
  live: SetupLive | undefined,
): SetupLiveView;
```

  - `SetupLiveLine({ view }: { view: SetupLiveView })`.
  - `ko.runDetail.setupLive`: `label = "준비 스텝"`, `ofTotal = (total: string, slot: boolean) => slot ? \` / ${total} 슬롯 완료\` : \` / ${total}명 완료\``, `doneSuffix = (slot: boolean) => slot ? " 슬롯 완료" : "명 완료"`(완료 수는 컴포넌트가 굵은 `<b>`로 따로 그린다 — 목업 `<b>37</b> / 50명 완료`), `failed = (n, slot) => slot ? \`실패 ${n} 슬롯\` : \`실패 ${n}명\``, `hintVu = "준비에 실패한 사용자는 본 스텝을 실행하지 않습니다. 끝난 뒤 리포트의 「준비 스텝」에서 원인을 볼 수 있습니다."`, `hintSlot = "준비에 실패한 슬롯은 run에서 빠집니다. 끝난 뒤 리포트의 「준비 스텝」에서 원인을 볼 수 있습니다."`. 숫자는 `toLocaleString("en-US")`로 넘긴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**
  - `setupLive.test.ts`:
    - 고정 VU `{vus: 50}` + `{ok: 37, failed: 2, interrupted: 0}` → `{unit:"vu", ok:37, failed:2, total:50, okPct:74, failedPct:4}`.
    - `live === undefined` → ok 0·failed 0·total 50·okPct 0.
    - open 고정 `{target_rps: 100, max_in_flight: 200}` → unit `"slot"`, total 200. open 곡선(`stages`)·계단(`stair`)·유지 구간 open(`steady.target`)도 slot + `max_in_flight`.
    - open인데 `max_in_flight`가 `null`/없음 → total `null`, pct 0.
    - VU 곡선(`vu_stages`) → unit `"vu"`, total `null`.
    - 넘침: `{vus: 10}` + ok 12, failed 3 → okPct 100, failedPct 0. ok 8, failed 5 → okPct 80, failedPct 20.
    - `vus: 0`(이상 값) → total `null`(0으로 나누지 않는다).
  - `SetupLiveLine.test.tsx`(글자는 리터럴. 숫자 줄은 `<b>`와 나머지 글자로 나뉘어 `getByText("37 / 50명 완료")`로는 못 찾는다 — 이 파일과 페이지 테스트의 숫자 줄 단언은 모두 `data-testid="setup-live-num"`의 `textContent`로 한다):
    - `{unit:"vu", ok:37, failed:0, total:50,…}` → `"준비 스텝"` 보임, 숫자 줄 요소(`data-testid="setup-live-num"`)의 `textContent`가 정확히 `"37 / 50명 완료"`이고 그 안의 `<b>` 글자가 `"37"`, 막대 요소(`data-testid="setup-live-bar"`) 있음·`aria-hidden="true"`, 경고 클래스(`border-amber-300`) 없음, 설명 줄 없음.
    - 실패 2 → `"실패 2명"`, 루트에 `border-amber-300`·`bg-amber-50`, 설명 줄 글자가 `hintVu` 리터럴.
    - slot → `"180 / 200 슬롯 완료"`, 실패면 `"실패 3 슬롯"`·`hintSlot`.
    - total null → `"120명 완료"`, 막대 요소 없음.
    - 큰 수 `ok: 12345, total: 20000` → `"12,345 / 20,000명 완료"`.
    - live region이 아니다: 루트에 `role`·`aria-live` 속성이 없다.
  - `RunDetailPage.setupLive.test.tsx`(같은 폴더의 기존 `RunDetailPage` 테스트의 fetch 목 방식을 따르고 `React.StrictMode`로 감싼다):
    - running run + `scenario_yaml`에 준비 스텝 + `setup_live` → 줄이 보이고 `"run-cards"` 뒤에 온다(DOM 순서: `compareDocumentPosition`).
    - running + 준비 스텝 있음 + `setup_live` 키 없음 → `"0 / 50명 완료"`.
    - running + 스냅샷에 준비 없음 → 줄 없음(`setup_live`가 응답에 실려 있어도).
    - **현재 시나리오**(`GET /api/scenarios/{id}`)에는 준비가 없고 **run 스냅샷**에는 있음 → 줄이 보인다. 반대(현재에만 있음) → 없다.
    - completed run → 줄 없음.
    - 스냅샷이 읽히지 않는 YAML → 줄 없음, 페이지가 깨지지 않는다.

- [ ] **Step 2: 실패를 확인한다** — `cd ui && pnpm test setupLive` / `pnpm test SetupLiveLine` / `pnpm test RunDetailPage.setupLive` → FAIL.

- [ ] **Step 3: 구현한다**
  - `setupLiveView`: `deriveLoadMode(profile)` — `loadModel === "open"`이면 slot + `max_in_flight`, closed + `rateMode === "curve"`면 vu + `null`, 그 밖 closed는 vu + `vus`. 분모가 양의 정수가 아니면 `null`. `okPct = min(100, ok / total * 100)`, `failedPct = min(100 - okPct, failed / total * 100)`.
  - `SetupLiveLine`: 목업 `.setup-live`를 Tailwind로 — 루트 `flex flex-wrap items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm mb-6`(아래 간격만 목업의 8px이 아니라 `mb-6` — 목업은 장면을 세로로 쌓느라 좁혔고, 실제 페이지는 숫자 카드와 같은 간격을 쓴다)(경고면 `border-amber-300 bg-amber-50`), 라벨 `font-semibold text-slate-700 shrink-0`, 숫자 `tabular-nums shrink-0`(완료 수 `<b className="font-semibold">`), 실패 `font-semibold text-amber-800 shrink-0`, 막대 `flex h-1.5 min-w-[80px] flex-1 basis-[120px] overflow-hidden rounded-full bg-slate-100`(안쪽 완료 `bg-accent-500`, 실패 `bg-amber-500`, 폭은 `style={{ width: \`${pct}%\` }}`), 설명 줄 `basis-full text-xs text-amber-800`.
  - `RunDetailPage`: 새 `useMemo` — `r.scenario_yaml`을 `parseScenarioDoc`으로 읽어 `"model" in parsed ? setupSteps(parsed.model).length > 0 : false`(의존성은 `run.data?.scenario_yaml`). `r.status === "running" && hasSetup`이면 `<SetupLiveLine view={setupLiveView(r.profile, r.setup_live)} />`를 `data-testid="run-cards"` 블록 바로 뒤(실패·중단 사유 Callout 앞)에 둔다. 훅은 조기 return들 **앞**에 둔다(기존 `stepOrder` memo 옆).

- [ ] **Step 4: 통과 + 되돌려 확인** — PASS. memo의 입력을 `scenario.data?.yaml`(현재 시나리오)로 바꿔 「스냅샷에만 있음」 테스트 RED 확인 → 원복. `failedPct`의 `min(100 - okPct, …)`를 지워 넘침 테스트 RED 확인 → 원복.

- [ ] **Step 5: 게이트 + 커밋** — `cd ui && pnpm lint && pnpm test && pnpm build` → `feat(ui): run 상세 — 실행 중 준비 진행 한 줄`

- [ ] **Step 6 (orchestrator): 목업 대조** — 지연 응답기로 준비가 느린 run을 띄워 실행 중 줄을 목업 장면 2와 나란히 본다(스크린샷 둘). 어긋난 디자인은 이 task의 fix로 접는다.

---

### Task 10 (orchestrator): 최종 리뷰 · 라이브 검증 · 기록

구현 subagent에게 맡기지 않는다.

- [ ] **Step 1: whole-branch 리뷰** — `handicap-reviewer`(BASE = Task 1 디스패치 직전 커밋 `3fc448ac` 다음의 plan 커밋). 초점: 와이어 1:1(`SetupLive` ↔ `SetupLiveSchema`, `.optional()` vs 서버 키 생략), 화면 비교 ↔ XLSX의 준비 행 순서 규칙이 같은지, TS·Rust 극성 집합, 준비 없는 run 불변 테스트가 실제로 준비 가지를 꺼 보는지, `ko.ts`에서 지운 키의 Rust 소비처.
- [ ] **Step 2: 보안 게이트** — `/finish-slice` §0 grep을 직접 돌린다. 인쇄 준비 표의 요청 줄이 본 스텝과 같은 가림 경로(`redact.ts`)를 타는지 판단으로도 본다(준비 스텝 URL은 로그인 주소다) — 매치하거나 의심되면 `security-reviewer`.
- [ ] **Step 3: 라이브 검증** — `/live-verify`, spec §8의 표(US1·US1 극단·US2·US3·US4·US5) 전부. 워크트리 자체 바이너리(`cargo build -p handicap-worker` 포함). 추가로:
  - 실행 중 run의 실제 `GET /api/runs/{id}` 응답을 저장해 `RunSchema.safeParse`로 읽는 일회 테스트(`__tests__/`에 두고 돌린 뒤 지운다).
  - 인쇄: 쪽별 rect(본문 한계 안), 헤드리스 Chrome `--print-to-pdf` + `pdfinfo` Pages == 화면 `.p-page` 수, `letter-spacing: 0.12em` 주입으로 머리 칸 줄바꿈 확인.
  - US5: 준비 없는 run의 CSV를 master 바이너리 출력과 `cmp`.
  - 실행 중 줄: 폭 390·768·1440에서 겹침 없음(rect 교차).
- [ ] **Step 4: 기록** — `/finish-slice`: build-log 단락(증명된 US / 못 한 US), roadmap §B 새 블록(번호는 `grep -n '^### B' docs/roadmap.md`의 마지막 + 1 — 판단과 비용·해소, spec §11의 연기 넷, 릴리즈 노트 줄), 현황판, 루트 상태줄, 도메인 CLAUDE.md 함정(있으면). 머지는 사용자 확인 뒤.
