# 유지 구간 기준 리포트 — 슬라이스 B 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `steady` run의 값이 「어느 기준인지」를 비교 화면·비교 보고서·인쇄·내보내기에 표시하고, 인쇄·내려받기가 화면에서 보고 있던 기준을 따르게 하며, 리포트 시계열에 상승·버림 띠와 유지 구간 세로선을 그린다.

**Architecture:** 서버는 리포트 계산을 한 번 돌려 「고른 기준 리포트 + 다른 기준 리포트」 둘을 돌려주는 함수 하나를 두고, 내보내기 라우트가 `?basis=`를 받아 그 함수를 쓴다. 화면은 이미 있는 `report.basis` 블록만 읽는다 — 새 와이어 필드는 없다. 글자 만드는 함수(`basisLine`)를 `BasisBar`에서 순수 모듈로 빼 리포트 화면·인쇄가 같은 글자를 쓴다.

**Tech Stack:** Rust(controller — `export.rs`·`api/runs.rs`), TypeScript/React + Recharts + Zod, `rust_xlsxwriter`·`calamine`(테스트).

**Spec:** `docs/superpowers/specs/2026-11-21-steady-window-design.md` — 이 plan은 §3-1의 **슬라이스 B**(D9의 시계열 띠·세로선, D10 전부, R9의 B 몫·R10, US5와 US2의 인쇄·내보내기)를 구현한다. A의 판단·공백 = `docs/roadmap.md` §B82.

<!-- spec-plan-reviewer 3회차 clean APPROVE (2026-11-22) -->
REVIEW-GATE: APPROVED

## Global Constraints

- **US4 불변**: `steady`가 없는 run(= 리포트에 `basis` 키가 없는 run)은 리포트 화면·인쇄·CSV·XLSX·비교 CSV/XLSX 산출물이 이 plan 전과 같다. 새 줄·새 시트·새 열·파일 이름 접미사는 `basis` 블록이 있는 run(비교는 그런 run이 하나라도 낀 비교)에만 생긴다.
- **와이어·엔진·proto·마이그레이션 변경 없음.** `ReportJson`·`BasisBlock`·`ReportSchema` 필드를 더하지 않는다. 바뀌는 HTTP 표면은 내보내기 세 라우트의 `?basis=` 쿼리와 파일 이름뿐이다.
- **`?basis=` 값 규칙은 리포트 JSON 라우트와 같다**: `steady`·`whole`만, 그 밖은 400 「basis는 steady 또는 whole이어야 합니다」(`parse_basis` 재사용). `steady` 없는 run에서는 유효한 값을 무시한다.
- **기준 글자의 원천은 하나**: 「유지 구간 · 14:02:35–14:07:00 (265초) · 상승 30초·버림 5초 제외」류 글자는 `ui/src/components/report/basisText.ts`(Task 5에서 추출)만 만든다. 인쇄가 따로 조립하지 않는다.
- **문구**: 화면 문구는 전부 `ui/src/i18n/ko.ts` 경유(ADR-0035). 낱말은 「유지 구간」·「전체 구간」·「집계 기준」·「상승」·「앞부분 버림」. 인쇄본에 찍히는 글은 보고서 문체(working-rules §8), 번역투 명사구 금지.
- **주석 규칙(working-rules §7)**: 이상한 동작을 변호하는 주석을 새로 쓰지 않는다.
- **성능(working-rules §10)**: `steady` 없는 run의 내보내기 경로에 새 DB 조회·새 리포트 계산을 더하지 않는다. `steady` run은 지금도 두 기준을 다 계산한다(§B82 (2)) — 그 결과를 버리지 않고 돌려줄 뿐 세 번째 계산을 더하지 않는다.
- **커밋 게이트**: cargo-영향 커밋은 수 분. `--no-verify`·`| tail` 금지. UI 커밋 전 `pnpm lint && pnpm test && pnpm build`. `ui/src`를 건드리는 task는 테스트 파일 편집이 첫 스텝(tdd-guard).
- **줄 번호**: 이 문서의 줄 번호는 `fa604985`에서 `grep -n`으로 잰 값이다. 앞 task가 같은 파일을 고치면 밀리므로 편집 전에 다시 `grep -n` 한다.

## Review Focus

spec이 암시하지만 task의 기본 테스트가 저절로 밟지 않는 입력. 각 줄의 테스트는 괄호 안 task에 들어 있다.

1. **`not_reached`·`no_common_window` run을 `?basis=steady`로 내려받거나 인쇄한다** — 유지 구간 리포트가 없으므로 전체 구간 값이 나와야 하고, 파일 이름·인쇄 기준 줄이 「유지 구간」이라고 적으면 안 된다 (Task 1 `export_basis_steady_falls_back_to_whole_when_not_reached`, Task 5 `print_basis_line_follows_selected_not_requested`·`print_page_shows_whole_when_steady_requested_but_not_reached`).
2. **인쇄 화면에서 「표준 | 요약」을 바꾸거나 「돌아가기」를 누른다** — 주소의 `?basis=whole`이 사라지면 사용자가 모르는 사이 다른 기준이 인쇄된다 (Task 5 `kind_switch_keeps_basis_param`, `back_link_keeps_basis_param`).
3. **상승·버림만 다른 두 `steady` run, 또는 `steady` run과 「닿기 전에 끝난 `steady` run」을 비교한다** — 프로필이 같아도 리포트의 기준이 다르면 조건 점검이 「같음」이라고 하면 안 된다. 기준은 프로필이 아니라 `report.basis.selected`에서 읽는다 (Task 6 `basis_row_reads_report_not_profile`).
4. **메트릭 초가 비는 run(초당 요청이 없는 초)에서 띠를 그린다** — 가로축이 범주형이면 데이터에 없는 초의 세로선·띠는 그려지지 않고, 숫자 축이어도 마지막 데이터 초보다 뒤에 있는 끝 세로선은 축 범위 밖이라 사라진다(VU 1·긴 반복, 낮은 도착률) (Task 3 `marks_on_missing_second_are_drawn`·`end_line_after_last_data_point_is_drawn`).
5. **XLSX의 「다른 기준」 시트를 기대하는데 유지 구간 창이 없다** — 시트를 빈 채로 내지 않고 아예 내지 않으며 Summary의 기준 행은 남는다 (Task 2 `xlsx_without_other_basis_has_no_other_sheet`).

---

## 파일 구조

| 파일 | 책임 | task |
|---|---|---|
| `crates/controller/src/api/runs.rs` | `build_reports_for_run`(두 기준), 내보내기 라우트 `?basis=`·파일 이름 | 1 |
| `crates/controller/src/export.rs` | 단일 XLSX의 기준 행·「Other basis」 시트, 비교 CSV/XLSX의 기준 표시 | 2 |
| `crates/controller/tests/report_test.rs` | 내보내기 기준 통합 테스트(`seed_steady` 재사용) | 1·2 |
| `ui/src/components/report/steadyMarks.ts` (새 파일) | `basis` 블록 → 띠·세로선 좌표(순수) | 3 |
| `ui/src/components/report/TimeSeriesChart.tsx`, `ReportView.tsx` | 띠·세로선 그리기, 범례 한 줄 | 3 |
| `ui/src/api/client.ts`, `ReportView.tsx` | 내려받기 URL·인쇄 링크에 보고 있는 기준 | 4 |
| `ui/src/components/report/basisText.ts` (새 파일), `BasisBar.tsx` | 기준 줄·참고 줄 글자(순수, 추출) | 5 |
| `ui/src/pages/RunPrintPage.tsx`, `ui/src/print/buildPrintDoc.ts`, `print/components/ReportHeader.tsx` | 인쇄가 주소의 기준을 따르고 머리에 기준 줄·참고 줄 | 5 |
| `ui/src/print/chartModel.ts`, `print/sentences.ts`, `print/components/ErrorChart.tsx` | 인쇄 그림의 유지 구간 점선·읽는 법 문장, 요약 문장의 창 범위 | 5 |
| `ui/src/print/conditions.ts`, `ui/src/print/compare/fairness.ts` | 「시작 늘림」 줄이 `steady.ramp_seconds`도 읽기, 조건 점검 「집계 기준」 줄 | 6 |
| `ui/src/compare/basisNotice.ts` (새 파일), `pages/ScenarioComparePage.tsx` | 비교 화면 안내 한 줄 | 7 |
| `docs/adr/0061-steady-window-report-basis.md` (새 파일), 루트 `CLAUDE.md` 인덱스 | ADR-0061 | 8 |

**서브에이전트 공통(orchestrator가 brief에 넣는다)**: prompt 첫 줄 `cd /Users/sgj/develop/handicap/.claude/worktrees/steady-window-b`. spec의 `사용자 스토리 (US)` 블록을 매 brief에 첨부. 리뷰 라우팅: Task 1·2는 path-gate(내보내기 와이어)라 code-quality 리뷰 `model: opus`, 나머지는 Sonnet.

**이 plan이 정한 것(spec에 글자로 없던 것 — 마무리 때 roadmap §B에 「부재 중 판단」으로 옮긴다)**:

- **XLSX의 본 시트들은 요청한 기준**(없으면 기본 기준)이고 「Other basis」 시트가 그 반대 기준이다. spec D10은 「지금의 시트들은 기본 기준 값」이라 적었지만 D7 표는 XLSX도 `?basis=`를 받는다고 한다 — 화면에서 보던 기준이 본 시트에 오는 쪽을 택했다. Summary 시트의 `basis` 행이 어느 기준인지 적는다.
- **시트 이름은 `Other basis`**(영문). 기존 시트가 모두 영문 키(`Summary`·`Steps`…)다.
- **파일 이름에 기준 접미사**: `basis` 블록이 있는 run의 `report.csv`·`report.xlsx`·`insights.csv`는 `run-{id}-report-steady.csv`처럼 고른 기준을 붙인다. CSV 본문(스텝 표)에는 기준을 적을 칸이 없어서다.
- **유지 구간 창이 없는 run(`not_reached`·`no_common_window`)은 시계열에 띠를 그리지 않는다.** `basis` 블록에는 워커 시작 시각이 없어 띠 위치를 정확히 알 수 없다. 화면에는 이미 「닿기 전에 끝남」 안내가 있다.
- **인쇄본의 시계열 그림은 run 전체를 그대로 그리고 유지 구간 시작·끝에 긴 점선 둘과 읽는 법 한 문장을 더한다**(띠는 넣지 않는다). 그림 아래 문장과 오류 표시는 run 전체에서 읽은 것이라, 유지 구간 기준 인쇄본에서 표의 오류 0건과 「N초에 오류」 문장이 함께 찍힐 수 있다 — 긴 점선과 「표와 판정은 이 구간의 값입니다」가 둘을 이어 준다.
- **「집계 기준」은 「부하 조건」 항목이다** — 기준이 다른 두 run의 비교 보고서는 「부하 조건」 카드가 「다름」이 되고 머리말이 「※ 참고」로 바뀐다(`headline.ts`의 `anyDiff`). 새 `steady` run과 예전 run의 비교가 모두 여기에 든다. 숫자 차이가 집계 기준 차이일 수 있다는 것이 US5의 요지라 「같은 조건의 개선·악화」로 적지 않는 쪽을 택했다.
- **비교 CSV는 맨 아래 `basis` 행, 비교 XLSX는 `Runs` 시트의 `basis` 열**로 run별 기준을 적는다(값 `steady`/`whole`).

---

### Task 1: 내보내기 라우트가 `?basis=`를 받는다 (R10, D7)

**Files:**
- Modify: `crates/controller/src/api/runs.rs` — `build_report_for_run`(`:1146`), 선택 블록(`:1286-1330`), `report_csv`(`:1381`)·`report_xlsx`(`:1396`)·`report_insights_csv`(`:1411`)
- Test: `crates/controller/tests/report_test.rs` — `exports_use_default_basis`(`:1040`) 옆

**Interfaces:**
- Produces:
  - `pub async fn build_reports_for_run(db: &Db, run_id: &str, basis: Option<Basis>) -> Result<(ReportJson, Option<ReportJson>), ApiError>` — 첫째 = 지금 `build_report_for_run`이 돌려주던 리포트(같은 `basis` 블록). 둘째 = 반대 기준의 리포트 전체(유지 구간 창이 없거나 `steady` 없는 run이면 `None`). 둘째는 `?basis=<반대 기준>`으로 받은 리포트와 JSON이 같아야 한다(`basis` 블록 포함 — `selected`가 반대, `other`가 첫째의 요약 숫자).
  - `build_report_for_run`은 `build_reports_for_run(..).map(|(r, _)| r)`로 남긴다. 호출부 7곳(`coordinator.rs:1440`, `runs.rs:1357,1387,1402,1417,1432,1489`) 가운데 이 task가 고치는 것은 내보내기 세 곳(`:1387,1402,1417`)뿐이다.
  - 내보내기 세 라우트: `axum::extract::Query<ReportParams>` 추가, `parse_basis` 재사용.
  - `fn export_stem(id: &str, kind: &str, report: &ReportJson) -> String` — `basis` 블록이 없으면 `run-{id}-{kind}`, 있으면 `run-{id}-{kind}-{steady|whole}`(`report.basis.selected`).

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`report_test.rs`, 기존 `seed_steady`·`get_report`·`report_json` 사용)

```rust
#[tokio::test]
async fn export_csv_follows_basis_param() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, SteadySeed::closed()).await;
    for basis in ["steady", "whole"] {
        let json = report_json(&db, &format!("/api/runs/{id}/report?basis={basis}")).await;
        let (st, csv) = get_report(&db, &format!("/api/runs/{id}/report.csv?basis={basis}")).await;
        assert_eq!(st, StatusCode::OK);
        let text = String::from_utf8(csv).unwrap();
        let count = json["steps"][0]["count"].as_u64().unwrap();
        assert_eq!(text.lines().nth(1).unwrap().split(',').nth(1).unwrap(), count.to_string());
    }
    // 두 기준의 요청 수가 달라야 이 테스트가 의미가 있다.
    let s = report_json(&db, &format!("/api/runs/{id}/report?basis=steady")).await;
    let w = report_json(&db, &format!("/api/runs/{id}/report?basis=whole")).await;
    assert_ne!(s["steps"][0]["count"], w["steps"][0]["count"]);
}

#[tokio::test]
async fn export_filename_carries_basis_only_for_steady_runs() {
    // steady run: attachment; filename="run-{id}-report-whole.csv" (?basis=whole),
    //             "run-{id}-report-steady.csv" (파라미터 없음 = 기본 기준)
    // steady 없는 run(seed_run_with_metrics): "run-{id}-report.csv" — ?basis=steady를 붙여도 같다
    // report.xlsx·report-insights.csv도 같은 규칙(-report-…/-insights-…)
}

#[tokio::test]
async fn export_basis_steady_falls_back_to_whole_when_not_reached() {
    // aborted_before_window_falls_back_to_whole와 같은 시드.
    // report.csv?basis=steady 본문 == report.csv?basis=whole 본문, 파일 이름은 "-report-whole.csv"
}

#[tokio::test]
async fn export_invalid_basis_is_400() {
    // report.csv / report.xlsx / report-insights.csv 각각 ?basis=x → 400
}

#[tokio::test]
async fn both_reports_are_consistent() {
    // build_reports_for_run(&db, &id, None): 첫째.basis.selected == Steady, 둘째 = Some.
    // serde_json::to_value(둘째) == report_json(?basis=whole)  — 리포트 전체가 같다
    //   (ReportJson에는 PartialEq가 없다 — JSON 값으로 비교한다).
    // build_reports_for_run(&db, &id, Some(Basis::Whole))의 둘째 == report_json(?basis=steady).
    // steady 없는 run: 둘째 == None, 첫째.basis == None.
}
```

`get_report`는 본문만 돌려준다 — 파일 이름 단언용으로 `Content-Disposition` 헤더까지 돌려주는 `get_with_headers`를 같은 파일에 더한다(`get_report`의 `oneshot` 호출을 복사해 헤더를 함께 반환).

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo nextest run -p handicap-controller --test report_test export_ both_reports`
Expected: 컴파일 실패(`build_reports_for_run` 없음) 또는 `export_csv_follows_basis_param`이 whole에서 FAIL(쿼리 무시).

- [ ] **Step 3: `build_reports_for_run`을 만든다**

`build_report_for_run` 본문을 `build_reports_for_run`으로 옮기고, `:1303-1313`의 `(chosen, other)` match가 반대 기준 리포트를 버리지 않고 함께 돌려주게 한다. `steady_inputs`가 없을 때의 이른 반환은 `Ok((whole, None))`. `basis` 블록을 만드는 코드(`:1314-1330`)를 `selected`와 `other`를 받는 클로저로 묶어 두 리포트에 각각 붙인다. 리포트 계산 횟수는 그대로다(새 `build(..)` 호출 없음).

- [ ] **Step 4: 세 라우트에 `?basis=`와 파일 이름을 넣는다**

`report_csv`·`report_xlsx`·`report_insights_csv`가 `Query<ReportParams>`를 받고 `parse_basis`를 **run 조회 전에** 부른다(리포트 JSON 라우트와 같은 순서 — 잘못된 값은 없는 run id에서도 400). `report_xlsx`는 `build_reports_for_run`을 부르고 둘째를 Task 2에서 쓸 수 있게 `report_to_xlsx(&report, other.as_ref())`로 넘긴다 — 이 task에서는 `export.rs` 시그니처에 둘째 인자 `other: Option<&ReportJson>`만 더하고 본문에서는 쓰지 않는다(`let _ = other;` 금지 — 인자 이름을 `_other`로 두고 Task 2가 이름을 바꾼다). `export.rs` 테스트의 `report_to_xlsx(..)` 호출 8곳(`grep -n 'report_to_xlsx(' crates/controller/src/export.rs` — 9줄 중 `:482`는 정의)에 `None`을 같은 커밋에서 붙인다. 파일 이름은 `export_stem`. `report_stairs_csv`·비교 라우트는 손대지 않는다.

- [ ] **Step 5: 통과를 확인한다**

Run: `cargo nextest run -p handicap-controller --test report_test`
Expected: 전부 PASS(기존 `exports_use_default_basis` 포함).

- [ ] **Step 6: 되돌려 확인** — `report_csv`에서 `basis`를 `None`으로 고정해 `export_csv_follows_basis_param`이 RED인지 보고 원복한다.

- [ ] **Step 7: 커밋** (`run_in_background`, 그동안 다른 cargo 금지)

```bash
git add crates/controller/src/api/runs.rs crates/controller/src/export.rs crates/controller/tests/report_test.rs
git commit -m "feat(controller): 리포트 내보내기 ?basis= — CSV·XLSX·인사이트 CSV가 고른 기준을 따른다 (R10)"
```

---

### Task 2: XLSX 두 기준 · 비교 내보내기의 기준 표시 (R10, D10)

**Files:**
- Modify: `crates/controller/src/export.rs` — `report_to_xlsx`(`:482`), `comparison_to_csv`(`:246`), `comparison_to_xlsx`의 `Runs` 시트(`:432`)
- Test: `crates/controller/src/export.rs` 인라인 `mod tests`(`report_with_steps` 픽스처 `:1133`), `crates/controller/tests/report_test.rs`

**Interfaces:**
- Consumes: Task 1의 `report_to_xlsx(report: &ReportJson, other: Option<&ReportJson>)`.
- Produces:
  - 단일 XLSX `Summary` 시트: `report.basis`가 있으면 기존 0–8행 뒤 9행부터 `(키, 값)` 행 — `basis`(글자 `steady`/`whole`), `basis_default`(글자), `basis_state`(글자, `measured` 등 와이어 값), `basis_ramp_seconds`·`basis_discard_seconds`(숫자), 창이 있으면 `basis_window_start_ms`·`basis_window_end_ms`·`basis_measured_seconds`(숫자). `basis`가 없으면 9행 이후를 쓰지 않는다.
  - 단일 XLSX `Other basis` 시트: `other`가 `Some`일 때만, 맨 끝에 더한다. 0행 `basis` + 그 리포트의 `basis.selected` 글자. 1–7행 = `Summary`와 같은 일곱 키·값(`count`…`p99_ms`). 9행 = 스텝 표 머리(`Steps` 시트와 같은 여섯 열), 10행부터 스텝 행.
  - 비교 CSV: `reports` 중 하나라도 `basis`가 있으면 마지막에 행 하나 — 첫 칸 `basis`, run 칸마다 `steady`/`whole`(`basis` 없는 run은 `whole`), `delta_pct` 칸은 빈 글자.
  - 비교 XLSX `Runs` 시트: 같은 조건에서 일곱째 열 `basis`(머리 + run별 값).
  - `fn basis_label(r: &ReportJson) -> &'static str` — `r.basis`의 `selected`가 `Steady`면 `"steady"`, 그 밖(없음 포함)은 `"whole"`. 위 세 곳이 함께 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`export.rs` `mod tests`, calamine로 읽는다 — 기존 `comparison_xlsx_steps_delta` 방식)

```rust
#[test]
fn xlsx_summary_has_basis_rows() {
    // report_with_steps(..)에 basis: Some(BasisBlock{ selected: Steady, default: Steady,
    //   state: Measured, config{ramp 30, hold 270, discard 5, target None},
    //   window: Some{start_ms 1_000_000, end_ms 1_265_000, measured_seconds 265}, .. })
    // Summary (9,0)="basis" (9,1)="steady"; (10,0)="basis_default"; (11,1)="measured";
    // (12,1)=30.0; (13,1)=5.0; (14,1)=1_000_000.0; (15,1)=1_265_000.0; (16,1)=265.0
}

#[test]
fn xlsx_other_basis_sheet_holds_other_summary_and_steps() {
    // other = 요청 수·p95가 다른 리포트(basis.selected = Whole).
    // 시트 "Other basis": (0,1)="whole", (1,0)="count" (1,1)=other.summary.count,
    // (9,0)="step_id", (10,0)=other.steps[0].step_id, (10,1)=other.steps[0].count
    // 본 "Steps" 시트 (1,1)은 첫째 리포트의 count(둘이 달라야 한다 — assert_ne로 고정)
}

#[test]
fn xlsx_without_other_basis_has_no_other_sheet() {
    // basis: Some(state NotReached, selected Whole, window None), other None
    // sheet_names()에 "Other basis" 없음, Summary (9,1)="whole", (11,1)="not_reached",
    // (14,0)은 None | Data::Empty
}

#[test]
fn xlsx_without_basis_is_unchanged() {
    // basis None, other None → sheet_names() == 이 plan 전 목록, Summary (9,0)은 None | Data::Empty
}

#[test]
fn comparison_exports_mark_basis_per_run() {
    // reports = [basis Steady, basis None]
    // CSV 마지막 줄 == "basis,steady,whole," (delta 칸 하나 빈 글자)
    // XLSX Runs (0,6)="basis", (1,6)="steady", (2,6)="whole"
}

#[test]
fn comparison_exports_unchanged_without_basis() {
    // reports 둘 다 basis None → CSV 줄 수 == 1 + SUMMARY_METRICS.len(), Runs (0,6)은 None | Data::Empty
}
```

`report_test.rs`에 종단 하나:

```rust
#[tokio::test]
async fn xlsx_route_carries_both_bases() {
    // seed_steady(closed). GET report.xlsx?basis=whole →
    // Summary "basis" 행 = "whole", "Other basis" (0,1) = "steady",
    // Steps (1,1) == ?basis=whole 리포트 steps[0].count,
    // Other basis (10,1) == ?basis=steady 리포트 steps[0].count
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo nextest run -p handicap-controller xlsx_ comparison_exports`
Expected: 새 테스트 FAIL(행·시트·열 없음).

- [ ] **Step 3: `report_to_xlsx`에 기준 행과 `Other basis` 시트를 넣는다** — 인자 이름 `_other` → `other`. 스텝 표 쓰기는 `Steps` 시트와 `Other basis`가 같은 열이므로 `fn write_steps_table(ws, first_row: u32, steps: &[ReportStep])` 하나로 묶는다.

- [ ] **Step 4: 비교 CSV·XLSX에 기준 표시를 넣는다** — `basis_label` 사용, `reports.iter().any(|r| r.basis.is_some())`일 때만.

- [ ] **Step 5: 통과를 확인한다**

Run: `cargo nextest run -p handicap-controller`
Expected: 전부 PASS(골든 `golden_summary_deltas_match` 포함 — 골든 파일은 고치지 않는다).

- [ ] **Step 6: 되돌려 확인** — `Other basis` 시트가 `other` 대신 `report`를 쓰게 바꿔 `xlsx_other_basis_sheet_holds_other_summary_and_steps`가 RED인지 보고 원복한다.

- [ ] **Step 7: 커밋** (`run_in_background`)

```bash
git add crates/controller/src/export.rs crates/controller/tests/report_test.rs
git commit -m "feat(controller): XLSX에 두 기준 — Summary 기준 행·Other basis 시트, 비교 내보내기 run별 기준 (R10)"
```

---

### Task 3: 시계열에 상승·버림 띠와 유지 구간 세로선 (R9의 B 몫, D9)

**Files:**
- Create: `ui/src/components/report/steadyMarks.ts`
- Modify: `ui/src/components/report/TimeSeriesChart.tsx`, `ui/src/components/report/ReportView.tsx`(`:256-270`의 `TimeSeriesChart` 셋), `ui/src/i18n/ko.ts`(`report.basis`, `:1196`)
- Test: `ui/src/components/report/__tests__/steadyMarks.test.ts`(새 파일), `__tests__/TimeSeriesChart.marks.test.tsx`(새 파일), `__tests__/ReportView.basis.test.tsx`

**Interfaces:**
- Produces:

```ts
// steadyMarks.ts — x는 그림의 가로축 값(첫 메트릭 초부터 센 초)
export type SteadyMarks = {
  bands: Array<{ kind: "ramp" | "discard"; x1: number; x2: number }>;
  lines: Array<{ kind: "start" | "end"; x: number }>;
};
export function steadyMarks(basis: ReportBasis | undefined, firstTs: number | null): SteadyMarks | null;
```

  - `basis` 없음·`basis.window` 없음·`firstTs === null`이면 `null`.
  - `lo = window.start_ms / 1000`, `hi = window.end_ms / 1000`. 세로선: `start` = `lo − firstTs`, `end` = `hi − 1 − firstTs`(창에 든 첫 초와 마지막 초).
  - 띠: `discard` = `[lo − discard_seconds, lo] − firstTs`, `ramp` = `[lo − discard_seconds − ramp_seconds, lo − discard_seconds] − firstTs`. 길이 0인 띠는 내지 않는다. `x1`은 0 아래로 내려가지 않게 자르고, 잘라서 길이가 0 이하가 되면 내지 않는다.
  - `basis.selected`와 무관하다(두 기준 모두 같은 띠).
  - `TimeSeriesChart`에 `marks?: SteadyMarks | null` prop. 있으면 가로축을 `type="number"`, `domain={[0, max(마지막 데이터 x, marks의 가장 큰 x)]}`로 두고(Recharts의 `ReferenceLine`·`ReferenceArea`는 축 범위 밖이면 그리지 않는다 — 끝 세로선이 마지막 데이터 초보다 뒤일 수 있다) 띠는 `ReferenceArea`, 세로선은 `ReferenceLine`(점선)으로 그린다. 없으면 지금 렌더와 같다.
  - 색: 상승 띠 `#94a3b8` `fillOpacity 0.22`(계단 그림의 측정 밖 띠와 같다), 버림 띠 `#f59e0b` `fillOpacity 0.16`, 세로선 `#475569` `strokeDasharray="4 3"`.
  - `ko.report.basis.chartLegend`: 「회색 띠는 상승 구간, 노란 띠는 앞부분 버림 구간입니다. 점선 사이가 유지 구간입니다.」 — `ReportView`가 첫 `TimeSeriesChart` 바로 위에 `marks`가 있을 때만 한 번 보인다(`text-sm text-slate-500`). 버림 0이면 「노란 띠는 … 」 문장을 빼고 상승 0이면 「회색 띠는 …」 문장을 뺀 글자를 돌려주는 함수 `chartLegend(hasRamp: boolean, hasDiscard: boolean)`로 둔다. 두 인자는 설정값이 아니라 **실제로 그린 띠**(`marks.bands`에 그 `kind`가 있는가)에서 구한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// steadyMarks.test.ts
const basis = (over = {}) => ({
  selected: "steady", default: "steady", state: "measured",
  config: { ramp_seconds: 20, hold_seconds: 40, discard_seconds: 5 },
  window: { start_ms: 1_025_000, end_ms: 1_060_000, measured_seconds: 35 },
  t0_estimated: false, dropped_whole_run: false, other: null, ...over,
});

it("상승·버림 띠와 시작·끝 세로선", () => {
  expect(steadyMarks(basis(), 1000)).toEqual({
    bands: [{ kind: "ramp", x1: 0, x2: 20 }, { kind: "discard", x1: 20, x2: 25 }],
    lines: [{ kind: "start", x: 25 }, { kind: "end", x: 59 }],
  });
});
it("버림 0이면 버림 띠가 없다", ...);          // discard_seconds: 0, window.start_ms 1_020_000 → bands 길이 1
it("상승 0이면 상승 띠가 없다", ...);          // ramp_seconds: 0
it("첫 메트릭 초가 run 시작보다 늦으면 띠를 0에서 자른다", () => {
  // firstTs 1008 → ramp {x1: 0, x2: 12}
});
it("창이 없으면 null", ...);                  // window: null, state: "not_reached"
it("basis가 없으면 null", ...);
it("전체 구간을 보고 있어도 같은 띠", ...);    // selected: "whole" → 같은 결과
```

```tsx
// TimeSeriesChart.marks.test.tsx — width/height를 명시해 렌더(ResponsiveContainer 회피)
it("marks가 있으면 띠 2개와 세로선 2개를 그린다", () => {
  // container.querySelectorAll(".recharts-reference-area").length === 2
  // container.querySelectorAll(".recharts-reference-line").length === 2
});
it("marks가 없으면 띠·세로선이 없다", ...);
it("marks_on_missing_second_are_drawn: 데이터에 없는 초의 세로선·띠도 그려진다", () => {
  // data의 ts_second = [1000, 1001, 1002, 1010, 1011] (1003–1009 없음)
  // marks = { bands: [{ kind: "ramp", x1: 0, x2: 5 }], lines: [{ kind: "start", x: 5 }, { kind: "end", x: 10 }] }
  // .recharts-reference-line 2개, .recharts-reference-area 1개
  // (범주형 축이면 x=5는 축에 없는 값이라 그 세로선과 띠가 빠진다)
});
it("end_line_after_last_data_point_is_drawn: 끝 세로선이 마지막 데이터 초보다 뒤여도 그려진다", () => {
  // data의 ts_second = [1000 … 1010], marks.lines = [{ kind: "start", x: 5 }, { kind: "end", x: 14 }]
  // .recharts-reference-line 2개
});
```

`ReportView.basis.test.tsx`에: `basis.window`가 있는 리포트는 범례 글자(`ko.report.basis.chartLegend(true, true)`의 「점선 사이가 유지 구간」을 리터럴로 병기)가 한 번만 보이고, `basis` 없는 리포트는 보이지 않는다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cd ui && pnpm test steadyMarks TimeSeriesChart.marks ReportView.basis`
Expected: FAIL(모듈 없음).

- [ ] **Step 3: `steadyMarks.ts`를 쓴다.**

- [ ] **Step 4: `TimeSeriesChart`에 `marks`를 넣는다.** `marks`가 없을 때의 `XAxis` props는 한 글자도 바꾸지 않는다(`steady` 없는 run의 그림 불변).

- [ ] **Step 5: `ReportView`가 `marks`를 계산해 세 그림에 넘기고 범례를 보인다.** `const marks = useMemo(() => steadyMarks(report.basis, seconds[0]?.ts_second ?? null), [report.basis, seconds])`.

- [ ] **Step 6: 통과를 확인한다**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS.

- [ ] **Step 7: 되돌려 확인** — ① 가로축에서 `type="number"`를 빼 `marks_on_missing_second_are_drawn`이 RED인지 ② `domain`의 상한을 「마지막 데이터 x」로만 되돌려 `end_line_after_last_data_point_is_drawn`이 RED인지 보고 각각 원복한다. 둘 중 하나라도 RED가 나지 않으면 STOP — 그 테스트가 결함을 못 잡는 것이므로 orchestrator에 보고한다(Recharts 2.15.4가 축 밖 값을 다르게 다룬다는 뜻이다).

- [ ] **Step 8: 커밋**

```bash
git add ui/src/components/report/steadyMarks.ts ui/src/components/report/TimeSeriesChart.tsx ui/src/components/report/ReportView.tsx ui/src/i18n/ko.ts ui/src/components/report/__tests__
git commit -m "feat(ui): 리포트 시계열에 상승·버림 띠와 유지 구간 세로선 (R9)"
```

---

### Task 4: 내려받기·인쇄 링크가 보고 있는 기준을 넘긴다 (R10, D10)

**Files:**
- Modify: `ui/src/api/client.ts`(`:317-324`의 `reportCsvUrl`·`reportXlsxUrl`·`reportInsightsCsvUrl`), `ui/src/components/report/ReportView.tsx`(`:150-185`의 인쇄 링크와 `DownloadMenu`)
- Test: `ui/src/components/report/__tests__/ReportView.basis.test.tsx`, `ui/src/api/__tests__/`의 client 테스트(없으면 `ReportView` 테스트에서 URL로 단언)

**Interfaces:**
- Produces:
  - `reportCsvUrl(runId: string, basis?: "steady" | "whole")`, `reportXlsxUrl(..)`, `reportInsightsCsvUrl(..)` — `basis`가 있으면 `?basis=…`를 붙인다. 없으면 지금 URL과 같다.
  - `ReportView`: `const viewBasis = report.basis?.selected`(`basis` 블록이 없으면 `undefined`). 세 내려받기가 `viewBasis`를 넘기고, 저장 파일 이름은 `viewBasis`가 있으면 `run-{id}-report-{viewBasis}.csv`·`…-report-{viewBasis}.xlsx`·`…-insights-{viewBasis}.csv`(서버 `export_stem`과 같은 규칙), 없으면 지금 이름.
  - 인쇄 링크: `report.basis`가 있고 `selected !== default`면 `/runs/{id}/print?basis={selected}`, 그 밖은 지금 주소(`/runs/{id}/print`). 리포트 화면의 주소 규칙(기본 기준이면 넣지 않는다, spec D9)과 같다.
  - JSON 내려받기(`downloadJson`)·계단 CSV는 그대로.

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`ReportView.basis.test.tsx`; `downloadFile`은 `vi.mock`으로 가로채 인자를 본다)

```tsx
// URL·파일 이름은 리터럴 글자로 단언한다(`api.reportCsvUrl(id, "whole")`를 기대값으로 쓰면 자기참조).
it("steady run에서 전체 구간을 보고 있으면 CSV·XLSX·인사이트 CSV가 ?basis=whole과 -whole 이름으로", ...);
//   예: URL이 "/report.csv?basis=whole"로 끝나고 이름 === `run-${id}-report-whole.csv`
it("steady run에서 기본 기준을 보고 있으면 ?basis=steady와 -steady 이름으로", ...);
it("basis 없는 리포트는 URL·파일 이름이 그대로", () => {
  // URL에 "basis" 없음, 이름 === `run-${id}-report.csv`
});
it("인쇄 링크: 기본 기준이 아니면 ?basis=를 싣고, 기본 기준·basis 없음이면 싣지 않는다", ...);
```

- [ ] **Step 2: 실패를 확인한다** — `cd ui && pnpm test ReportView.basis` → FAIL.

- [ ] **Step 3: `client.ts` 세 함수에 `basis` 인자를 넣는다.**

- [ ] **Step 4: `ReportView`의 내려받기·인쇄 링크를 고친다.**

- [ ] **Step 5: 통과를 확인한다** — `cd ui && pnpm lint && pnpm test && pnpm build`.

- [ ] **Step 6: 커밋**

```bash
git add ui/src/api/client.ts ui/src/components/report/ReportView.tsx ui/src/components/report/__tests__
git commit -m "feat(ui): 내려받기·인쇄 링크가 보고 있는 집계 기준을 넘긴다 (R10)"
```

---

### Task 5: 인쇄 단일 보고서가 보고 있던 기준으로 찍힌다 (R10, D10)

**Files:**
- Create: `ui/src/components/report/basisText.ts`
- Modify: `ui/src/components/report/BasisBar.tsx`(`basisLine`·`clock`·참고 줄 조립을 `basisText.ts`로 옮기고 import), `ui/src/pages/RunPrintPage.tsx`, `ui/src/print/buildPrintDoc.ts`(`meta`, `summaryLines`에 넘기는 `windows`, `readingLine`), `ui/src/print/chartModel.ts`(`ChartModel.steady`), `ui/src/print/sentences.ts`(`scopeEndSec`), `ui/src/print/components/ErrorChart.tsx`, `ui/src/print/components/ReportHeader.tsx`, `ui/src/i18n/ko.ts`(`print.doc`, `:3157` 근처)
- Test: `ui/src/components/report/__tests__/BasisBar.test.tsx`(무변경으로 green — 추출 가드), `ui/src/print/__tests__/buildPrintDoc.test.ts`, `ui/src/pages/__tests__/RunPrintPage.basis.test.tsx`(새 파일)

**Interfaces:**
- Produces:

```ts
// basisText.ts
export function basisLine(basis: ReportBasis): string;          // BasisBar에서 그대로 옮긴다
export function basisOtherLine(basis: ReportBasis): string | null; // basis.other 없으면 null. 지금 BasisBar JSX 안의 t.otherLine(..) 조립
```

  - `PrintDoc.meta`에 선택 필드 둘: `basis?: string`(= `basisLine`), `basisOther?: string`(= `basisOtherLine`이 `null`이 아닐 때). `report.basis`가 없으면 두 키 모두 없다.
  - `ReportHeader`: `doc.meta.basis`가 있으면 「측정 일시」 줄 다음에 `[D.metaBasis, doc.meta.basis]`, `doc.meta.basisOther`가 있으면 그 다음에 `[D.metaBasisOther, doc.meta.basisOther]`. 없으면 지금의 네 줄.
  - `ko.print.doc.metaBasis`: 「집계 기준」, `ko.print.doc.metaBasisOther`: 「참고」.
  - `RunPrintPage`: `searchParams.get("basis")`가 `steady`/`whole`이면 `useRunReport(id, terminal, basis)`. `setKind`는 `basis` 파라미터를 지우지 않는다(지금은 `setSearchParams({ kind: k })`로 통째 교체). 「돌아가기」 링크는 `basis` 파라미터가 있으면 `/runs/{id}?basis=…`.
  - `buildPrintDoc`: `report.basis?.selected === "steady"`이고 창이 있으면 `summaryLines`에 넘기는 `windows`를 `ts_second ∈ [start_ms/1000, end_ms/1000)`인 것만으로 줄이고, `SummaryInput`의 새 선택 필드 `scopeEndSec?: number`(= `end_ms/1000 − t0`, 경과 초)를 함께 넘긴다. `identityLine`의 「계속 나타남」 비율(`sentences.ts:141-144`)은 `scopeEndSec`이 있으면 `startSec < scopeEndSec`인 칸까지만 센다(`scopeEndSec`은 창의 끝 — 그 초 자체는 창 밖이다. 창 뒤의 칸이 분모에 들어가 「계속 나타남」이 「처음 나타남」으로 바뀌지 않게). `t0`·`chart`는 run 전체 그대로(경과 시각의 원점이 그림과 같다).
  - 인쇄 그림: `ChartModel`에 선택 필드 `steady?: { startSec: number; endSec: number }`(경과 초, `report.basis.window`와 `t0`가 있을 때만 — 두 기준 모두). `startSec = start_ms/1000 − t0`, `endSec = end_ms/1000 − 1 − t0`(창에 든 첫 초와 마지막 초 — 화면 그림의 세로선과 같은 뜻). `steady`가 있으면 `durationSec = max(지금 값, endSec + 1)`로 넓힌다 — 칸 크기(`pickBinSeconds`)와 시간 눈금을 계산하기 **전에**(`durationSec`은 마지막 메트릭 초에서 나오고 `markerX`는 자르지 않는다 — 창의 마지막 초들에 메트릭이 없으면 점선이 그림 오른쪽 밖으로 나간다). 원점은 인쇄 그림의 `t0`(`runT0` — run 시작 시각과 첫 메트릭 초 중 이른 쪽)이고 화면 그림의 원점은 첫 메트릭 초다. 두 그림의 원점이 원래 다르므로 같은 run의 점선 위치가 그 차이만큼 다르게 찍히는 것은 그대로 둔다. `buildChartModel`의 넷째 선택 인자로 받는다. `print/components/ErrorChart.tsx`는 `chart.steady`가 있으면 `markerX(startSec, durationSec)`·`markerX(endSec, durationSec)`에 그림 높이만큼의 점선 둘을 그린다(`stroke="#475569"`, `strokeDasharray="3 1.5"` — 오류 시작 표시선이 이미 `"1 1"` 점선이라(`ErrorChart.tsx:122`) 흑백 인쇄에서 구분되게 다른 무늬를 쓴다. `data-steady-line` 속성을 단다). 없으면 지금 그림과 같다.
  - 그림 아래 문장: `chart.steady`가 없으면 `PrintDoc.readingLine`은 지금의 `chartReadingLine(chart)` 그대로다. 있으면 `chartReadingLine(chart)`(끝이 마침표가 아니면 마침표를 붙인다 — `readingErrors`·`readingDrop`은 마침표 없이 끝난다, `ko.ts:3146-3147`) + 공백 하나 + `ko.print.chart.readingSteady(from, to, selected)`. `readingSteady`는 `selected === "steady"`면 「긴 점선 사이(25초–1분)가 유지 구간입니다. 표와 판정은 이 구간의 값입니다.」, `whole`이면 「긴 점선 사이(25초–1분)가 유지 구간입니다.」(앞 공백 없음). 시각 글자는 `chartModel.ts`의 `elapsedText`(`formatDurationKo` 꼴 — 「25초」·「1분」), `from = elapsedText(startSec)`, `to = elapsedText(endSec + 1)`. 키 위치는 `ko.print.chart`(`chartModel.ts:6`의 `K`, `readingNone` 옆 `ko.ts:3148`). `elapsedText`는 지금 모듈 안 함수다(`chartModel.ts:61`) — `buildPrintDoc`이 쓰도록 `export`한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// buildPrintDoc.test.ts (기존 픽스처 도우미 사용)
it("basis 없는 리포트의 meta는 네 키 그대로", () => {
  expect(Object.keys(doc.meta).sort()).toEqual(["ident", "load", "targets", "window"]);
});
it("steady 기준 리포트: meta.basis가 화면 기준 줄과 같은 글자, meta.basisOther가 참고 줄", () => {
  expect(doc.meta.basis).toBe(basisLine(report.basis!));
  expect(doc.meta.basis).toContain("유지 구간");           // 리터럴 병기(자기참조 방지)
  expect(doc.meta.basisOther).toContain("전체 구간");
});
it("print_basis_line_follows_selected_not_requested: selected whole(not_reached)이면 기준 줄이 '전체 구간'으로 시작하고 basisOther가 없다", ...);
it("창이 있는 리포트: chart.steady가 경과 초이고 readingLine이 '긴 점선 사이'를 담는다 — steady 기준은 '표와 판정은 이 구간의 값', whole 기준은 그 문장이 없다", ...);
it("오류가 있는 리포트: 앞 문장과 유지 구간 문장 사이에 마침표가 있다", () => {
  // 리터럴로: expect(doc.readingLine).toContain("생깁니다. 긴 점선 사이(")   (하락 문장이 붙는 픽스처면 "내려갑니다. 긴 점선 사이(")
});
it("창의 마지막 초들에 메트릭이 없어도 끝 점선이 그림 안에 있다", () => {
  // windows의 마지막 ts_second = t0 + 50, 창 끝 = t0 + 60 → chart.steady.endSec === 59, chart.durationSec === 60
  // markerX(chart.steady.endSec, chart.durationSec) <= PLOT_X1_MM
});
it("basis 없는 리포트: chart.steady가 없고 readingLine이 chartReadingLine(chart)와 같다", ...);
it("유지 구간 기준에서 창 안 내내 난 오류는 창 뒤에 칸이 더 있어도 '계속 나타남'이다", () => {
  // 창 = 25~60초, run은 90초까지(창 뒤 30초는 오류 없음), 오류는 25~59초 매 초
  // scopeEndSec을 넘기지 않게 되돌리면 비율이 0.5 아래로 떨어져 '처음 나타남'이 된다(되돌려 확인 대상)
});
it("유지 구간 기준에서 '처음 보인 시각'은 창 안의 초만 본다", () => {
  // 오류가 run 3초(상승 중)와 run 40초(창 안)에 있는 windows, 창 = 25초~60초
  // steady 기준 → 요약 문장에 elapsed(40) 글자, elapsed(3) 글자는 없음
  // whole 기준(같은 windows, basis.selected "whole") → elapsed(3) 글자
});
```

```tsx
// RunPrintPage.basis.test.tsx — api.getRunReport를 vi.mock으로 가로챈다
it("?basis=whole이면 그 기준으로 리포트를 받는다", ...);            // getRunReport(id, "whole")
it("basis 파라미터가 없으면 기준 없이 받는다", ...);                // getRunReport(id, undefined)
it("kind_switch_keeps_basis_param: 요약으로 바꿔도 basis=whole이 주소에 남는다", ...);
it("back_link_keeps_basis_param: 돌아가기가 /runs/{id}?basis=whole", ...);
it("머리에 집계 기준 줄과 참고 줄이 찍힌다", ...);                   // getByText("집계 기준") + 기준 줄 글자
it("print_page_shows_whole_when_steady_requested_but_not_reached", () => {
  // 주소 ?basis=steady, 가로챈 getRunReport가 selected "whole"·state "not_reached" 리포트를 준다
  // 머리의 집계 기준 줄이 "전체 구간"으로 시작하고 "유지 구간 ·" 글자가 없다
});
```

- [ ] **Step 2: 실패를 확인한다** — `cd ui && pnpm test buildPrintDoc RunPrintPage.basis BasisBar` → 새 테스트 FAIL, `BasisBar` 기존 테스트 PASS.

- [ ] **Step 3: `basisText.ts`로 추출한다.** `BasisBar.tsx`는 두 함수를 import해 같은 글자를 렌더한다. `BasisBar.test.tsx`를 고치지 않고 green이어야 한다.

- [ ] **Step 4: `buildPrintDoc`의 `meta`·`windows` 범위·`scopeEndSec`·`chart.steady`·`readingLine`을 고치고 `ErrorChart`에 점선을 넣는다.** 새 테스트 파일 `ui/src/print/__tests__/ErrorChart.steady.test.tsx`(지금 `ErrorChart` 전용 테스트는 없다)에 「`chart.steady`가 있으면 `data-steady-line` 속성을 단 점선 둘, 없으면 0」을 쓴다.

- [ ] **Step 5: `ReportHeader`에 두 줄을 넣는다.**

- [ ] **Step 6: `RunPrintPage`가 `basis`를 읽고 지킨다.**

- [ ] **Step 7: 통과를 확인한다** — `cd ui && pnpm lint && pnpm test && pnpm build`.

- [ ] **Step 8: 되돌려 확인** — `buildPrintDoc`의 `windows` 거르기를 빼 「처음 보인 시각」 테스트가 RED인지, `scopeEndSec`을 넘기지 않게 해 「계속 나타남」 테스트가 RED인지, `setKind`를 `setSearchParams({ kind: k })`로 되돌려 `kind_switch_keeps_basis_param`이 RED인지 보고 각각 원복한다.

- [ ] **Step 9: 커밋**

```bash
git add ui/src/components/report/basisText.ts ui/src/components/report/BasisBar.tsx ui/src/pages/RunPrintPage.tsx ui/src/print ui/src/i18n/ko.ts ui/src/pages/__tests__
git commit -m "feat(ui): 인쇄 보고서가 보고 있던 집계 기준으로 — 머리에 기준 줄·참고 줄 (R10)"
```

---

### Task 6: 비교 보고서 조건 점검에 「집계 기준」 줄 (US5, D10)

**Files:**
- Modify: `ui/src/print/conditions.ts`(`:96`의 「시작 늘림」 줄), `ui/src/print/compare/fairness.ts`(`ItemKey`·`ITEM_ORDER` `:82-108`, `itemValues` `:137`, `itemLabel`, `itemText`, `buildFairness`의 `optional` 집합), `ui/src/i18n/ko.ts`(`print.cmp.fair` `:2584`, `print.cmp.cond` `:2636`)
- Test: `ui/src/print/compare/__tests__/fairness.test.ts`, `ui/src/print/__tests__/`의 conditions 테스트(없으면 `buildPrintDoc.test.ts`)

**Interfaces:**
- Produces:
  - `export function rampSeconds(p: Pick<Profile, "ramp_up_seconds" | "steady">): number` (`conditions.ts`) — `p.steady ? p.steady.ramp_seconds : p.ramp_up_seconds`. `conditionsBox`의 「시작 늘림」 줄과 `fairness.ts`의 `itemValues.ramp`가 이 함수를 쓴다(도착률 고정 + 상승 run은 `ramp_up_seconds`가 0이고 `steady.ramp_seconds`에 값이 있다).
  - `ItemKey`에 `"basis"`를 더하고 `ITEM_ORDER`에서 `"ramp"` 바로 뒤에 둔다.
  - `export function basisCondText(m: RunModel): string | null` (`fairness.ts`) — `m.report.basis`가 없으면 `null`. `selected === "steady"`면 `C.basisSteady(config.ramp_seconds, config.discard_seconds)`, `whole`이면 `C.basisWhole`.
  - 비교값: `itemValues`의 `basis` = `basisCondText(m) ?? C.basisWhole`(= `basis` 없는 run은 전체 구간으로 본다). 글자: `itemText`의 `basis` = 두 run 중 하나라도 `report.basis`가 있으면 `basisCondText(m) ?? C.basisWhole`, 둘 다 없으면 `null`(줄을 내지 않는다 — `optional` 집합에 `"basis"` 추가).
  - `itemValues`·`itemText`는 지금 `(p, workers)`·`(box, p, key)`만 받는다 — `basis` 값을 넘길 인자를 더한다(`buildFairness`가 `basisCondText(before)`·`basisCondText(after)`를 계산해 넘긴다).
  - `F.basis`: 「집계 기준」(줄 이름·「부하 조건」 카드의 다른 항목 이름). `C.basisSteady(ramp, discard)`: 「유지 구간(상승 30초·버림 5초 제외)」 — 0인 쪽은 빼고(「유지 구간(버림 5초 제외)」), `C.basisWhole`: 「전체 구간」.

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`fairness.test.ts`의 `fair`·`model`·`prof` 도우미 사용. `model`의 `Opts`에 `basis`를 더해 `report.basis`를 넣을 수 있게 한다)

```ts
const steadyBasis = (over = {}) => ({
  selected: "steady", default: "steady", state: "measured",
  config: { ramp_seconds: 30, hold_seconds: 270, discard_seconds: 5 },
  window: { start_ms: 1_000_000, end_ms: 1_265_000, measured_seconds: 265 },
  t0_estimated: false, dropped_whole_run: false, other: null, ...over,
});
const row = (f: Fairness, label: string) => f.condRows.find((r) => r.label === label);

it("basis 없는 두 run: 집계 기준 줄이 없고 부하 조건 카드는 그대로", () => {
  const f = fair();
  expect(row(f, "집계 기준")).toBeUndefined();
  expect(card(f, "load").same).toBe(true);
});
it("steady 기준 run과 basis 없는 run: 줄이 '다름'이고 부하 조건이 같지 않다", () => {
  const f = fair({ basis: steadyBasis() }, {});
  expect(row(f, "집계 기준")).toMatchObject({
    before: "유지 구간(상승 30초·버림 5초 제외)", after: "전체 구간", differs: true,
  });
  expect(card(f, "load").same).toBe(false);
  expect(card(f, "load").line).toContain("집계 기준");
  expect(f.anyDiff).toBe(true);   // → 비교 머리말이 「※ 참고」(headline.ts의 anyDiff 분기)
});
it("basis_row_reads_report_not_profile: 프로필이 같은 두 steady run인데 한쪽이 닿기 전에 끝났다", () => {
  const p = prof({ steady: { ramp_seconds: 30, hold_seconds: 270, discard_seconds: 5 }, ramp_up_seconds: 30 });
  const f = fair(
    { profile: p, basis: steadyBasis() },
    { profile: p, basis: steadyBasis({ selected: "whole", default: "whole", state: "not_reached", window: null }) },
  );
  expect(row(f, "집계 기준")).toMatchObject({ after: "전체 구간", differs: true });
});
it("버림만 다른 두 steady run: 집계 기준 줄이 다르다", () => {
  // 기존 steady_run_reads_as_fixed_everywhere(:292)의 steadyOpen(5)·steadyOpen(10)에 각각 맞는 basis
  // before "유지 구간(상승 30초·버림 5초 제외)", after "유지 구간(상승 30초·버림 10초 제외)", differs true
});
it("같은 기준의 두 steady run: 줄이 있고 '다름'이 아니다", ...);
it("도착률 고정 + 상승 run: 시작 늘림 줄이 steady.ramp_seconds를 보인다", () => {
  // profile: { target 없음, stages 둘, ramp_up_seconds: 0, steady: { target: 80, ramp_seconds: 30, .. } }
  // row(f, "시작 늘림")의 before에 "30초"
});
it("상승 0·버림 5: '유지 구간(버림 5초 제외)'", ...);
```

기존 `steady_run_reads_as_fixed_everywhere`(`:292`)는 「그 밖의 설정 줄이 없다」를 단언한다 — `basis`를 넣지 않는 픽스처이므로 그대로 green이어야 한다.

- [ ] **Step 2: 실패를 확인한다** — `cd ui && pnpm test fairness` → 새 테스트 FAIL.

- [ ] **Step 3: `rampSeconds`를 넣고 `conditionsBox`·`itemValues.ramp`가 쓰게 한다.**

- [ ] **Step 4: `basis` 항목을 넣는다**(`ItemKey`·`ITEM_ORDER`·`itemValues`·`itemLabel`·`itemText`·`optional`·ko 키 셋).

- [ ] **Step 5: 통과를 확인한다** — `cd ui && pnpm lint && pnpm test && pnpm build`. `fair()` 도우미의 불변식 둘(글자가 다르면 다름 / 다름이면 글자가 다르다)이 모든 픽스처에서 성립해야 한다.

- [ ] **Step 6: 되돌려 확인** — `basisCondText`가 `m.report.basis` 대신 `m.profile?.steady` 유무로 판정하게 바꿔 `basis_row_reads_report_not_profile`이 RED인지 보고 원복한다.

- [ ] **Step 7: 커밋**

```bash
git add ui/src/print/conditions.ts ui/src/print/compare/fairness.ts ui/src/i18n/ko.ts ui/src/print
git commit -m "feat(ui): 비교 보고서 조건 점검에 집계 기준 줄 — 시작 늘림 줄은 steady 상승도 읽는다 (US5)"
```

---

### Task 7: 비교 화면의 기준 안내 (US5, D10)

**Files:**
- Create: `ui/src/compare/basisNotice.ts`
- Modify: `ui/src/pages/ScenarioComparePage.tsx`(오류 배너 `:239-250`와 `CompareMatrix` `:252` 사이), `ui/src/i18n/ko.ts`(`compare`, `:2039`)
- Test: `ui/src/compare/__tests__/basisNotice.test.ts`(새 파일), `ui/src/pages/__tests__/`의 `ScenarioComparePage` 테스트

**Interfaces:**
- Produces:

```ts
// basisNotice.ts
export function basisNotice(
  reports: Array<Pick<Report, "run" | "basis">>,
  labels: Record<string, string>,   // run id → 화면 표시 이름(ScenarioComparePage의 runLabels)
): string | null;
```

  - run마다 기준 = `report.basis?.selected ?? "whole"`. 모든 run의 기준이 같으면 `null`.
  - 다르면 `ko.compare.basisMismatch(parts)` — `parts` = run 순서대로 `「{이름}: 유지 구간」`/`「{이름}: 전체 구간」`을 `, `로 이은 글자. 결과 예: 「집계 기준이 다릅니다 — #a1b2c3: 유지 구간, #d4e5f6: 전체 구간」.
  - 기준 이름은 `ko.report.basis.steady`·`ko.report.basis.whole`을 쓴다(리포트 화면과 같은 낱말).
  - `ScenarioComparePage`: `basisNotice(reports, runLabels)`가 `null`이 아니면 `CompareMatrix` 위에 `<Callout variant="info" role="status" className="mb-4">`로 보인다(`info`는 `Callout`의 기본 variant다).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// basisNotice.test.ts
const rep = (id: string, selected?: "steady" | "whole") =>
  ({ run: { id }, basis: selected ? { selected } : undefined }) as never;
const labels = { a: "#aaa111", b: "#bbb222", c: "#ccc333" };

it("모두 basis 없음 → null", () => expect(basisNotice([rep("a"), rep("b")], labels)).toBeNull());
it("모두 유지 구간 → null", ...);
it("steady 기준과 basis 없는 run이 섞이면 run 순서대로 적는다", () => {
  expect(basisNotice([rep("a", "steady"), rep("b")], labels)).toBe(
    "집계 기준이 다릅니다 — #aaa111: 유지 구간, #bbb222: 전체 구간",
  );
});
it("steady run이지만 전체 구간으로 떨어진 것(selected whole)은 전체 구간", ...);
it("세 run", ...);   // 세 이름이 순서대로
```

`ScenarioComparePage` 테스트: 기준이 섞인 두 리포트로 렌더하면 `role="status"` 안에 「집계 기준이 다릅니다」가 보이고, 둘 다 `basis` 없는 리포트면 그 글자가 없다.

- [ ] **Step 2: 실패를 확인한다** — `cd ui && pnpm test basisNotice ScenarioComparePage` → FAIL.

- [ ] **Step 3: `basisNotice.ts`와 ko 키를 쓴다.**

- [ ] **Step 4: `ScenarioComparePage`에 안내를 넣는다.**

- [ ] **Step 5: 통과를 확인한다** — `cd ui && pnpm lint && pnpm test && pnpm build`.

- [ ] **Step 6: 커밋**

```bash
git add ui/src/compare ui/src/pages/ScenarioComparePage.tsx ui/src/pages/__tests__ ui/src/i18n/ko.ts
git commit -m "feat(ui): 비교 화면 — 집계 기준이 다른 run이 섞이면 안내 한 줄 (US5)"
```

---

### Task 8: ADR-0061

**Files:**
- Create: `docs/adr/0061-steady-window-report-basis.md`
- Modify: 루트 `CLAUDE.md`의 「알아둘 결정들」 인덱스(0060 줄 다음에 한 줄)

- [ ] **Step 1: ADR을 쓴다** — MADR 포맷(`docs/adr/0060-scenario-groups.md`의 절 구성을 따른다). 담을 것:
  - 맥락: 리포트 요약이 run 전체 구간으로 계산돼 상승 구간이 평균에 섞인다. 리포트는 열 때마다 저장된 1초 창에서 다시 계산한다.
  - 결정: ① run에 저장한 `steady` 표시가 있는 run만 새 기준(옛 run 숫자 불변) ② 리포트를 기준별로 통째로 만들고 `?basis=steady|whole`로 고른다 ③ 기본 기준 = 유지 구간에 닿았으면 유지 구간 ④ 모든 워커에 공통인 창 하나 ⑤ 구간으로 나눌 수 없는 집계는 run 전체 값 + 표지 ⑥ 저장 판정 배지 = 기본 기준 ⑦ 비교는 run마다 기본 기준 + 「집계 기준」 표시, 인쇄는 한 번에 한 기준, XLSX는 두 기준.
  - 기각한 것: `ramp_up_seconds > 0`이면 자동으로 유지 구간 기준(옛 run 숫자가 바뀐다) · 곡선에서 유지 구간 자동 추정(계단 설계에서 이미 기각) · 요약·판정만 유지 구간이고 나머지는 전체 구간(초안 — 한 리포트 안에서 기준이 섞인다) · 워커별 창 합산(요약·스텝 표·판정이 다른 초를 본다).
  - spec과 다르게 구현한 것(A): 유지 구간 리포트의 「보내지 않음」 수는 창 안에서 직접 센다 · 완료 run도 창 끝을 `ended_at`에서 자른다(§B82 (0)).
  - 결과·한계: spec §6의 (1)·(2)·(8)·(10)을 한 줄씩, 상세는 spec과 roadmap §B82를 가리킨다.

- [ ] **Step 2: 인덱스 한 줄** — `- **0061** 유지 구간 기준 리포트: run에 저장한 `steady` 표시 + 기준별 리포트(`?basis=`) + 기본 기준 (옛 run 숫자 불변)`

- [ ] **Step 3: 커밋** (docs-only)

```bash
git add docs/adr/0061-steady-window-report-basis.md CLAUDE.md
git commit -m "docs(adr): 0061 유지 구간 기준 리포트"
```

---

## 구현 뒤 (orchestrator)

- **최종 리뷰**: `handicap-reviewer`. 초점 — 서버 `export_stem`과 UI 파일 이름 규칙이 같은가, `basis` 없는 run의 산출물 불변(US4), `build_reports_for_run`의 둘째 리포트가 `?basis=<반대>` 리포트와 같은가.
- **보안 게이트**: `finish-slice` §0 grep을 직접 돌린다. 이 plan은 새 값을 새 sink로 옮기지 않는다(이미 리포트 JSON에 있는 `basis` 숫자를 XLSX·인쇄에 적는다) — grep이 매치하면 `security-reviewer`.
- **라이브 검증(`/live-verify`, 필수 — 리포트 파싱·내보내기 경로)**: spec §5 라이브 표의 US5와 「그 밖」 줄, 그리고 A가 B로 미룬 것(§B82 (6)의 「인쇄 화면에서 `steady` run」).
  - US1 띠: 도착률 고정 40 iter/s·60초·상승 20초·버림 5초 run의 시계열 세 그림에서 회색 띠가 0–20초, 노란 띠가 20–25초, 점선이 25초와 끝에 있다 — `ReferenceArea`·`ReferenceLine`의 rect를 재고 스크린샷을 눈으로 본다. 「전체 구간」으로 바꿔도 같은 띠.
  - US5: 그 run과 `steady` 없는 run을 비교 → 화면 안내 한 줄, 비교 보고서 인쇄 → 조건 점검 「집계 기준 … 다름」.
  - 인쇄: 리포트에서 「전체 구간」으로 바꾼 뒤 「인쇄용 보기」 → 머리의 「집계 기준」이 「전체 구간 …」, 참고 줄이 유지 구간 숫자. 「요약」으로 바꿔도 기준 유지. 헤드리스 Chrome `--print-to-pdf` + `pdfinfo` Pages == 화면 `.p-page` 수(머리가 두 줄 늘었다).
  - 내보내기: 두 기준 각각에서 CSV(첫 스텝 요청 수가 화면과 같다)·XLSX(`Summary`의 `basis` 행, `Other basis` 시트)를 받아 연다.
  - US4: `steady` 없는 run의 리포트 화면(띠·범례 없음)·인쇄 머리(네 줄)·CSV·XLSX(시트 목록 그대로)·비교 화면(안내 없음).
  - 여러 워커: VU > 워커 용량인 `steady` run(컨트롤러 `--worker-capacity-vus`를 낮춰 2워커)에서 기준 줄의 초 수와 띠 위치가 맞는지(§B82 (6)에서 못 한 것).
  - 인쇄 그림: 점선 둘이 그림 안에 있고 오류 표시 글자와 겹치지 않는지(rect 교차), 읽는 법 문장이 한 쪽을 넘기지 않는지.
  - 극단값: 상승 3600초·버림 3600초 글자가 든 기준 줄이 인쇄 머리 폭을 넘지 않는지(1em 글꼴 흉내 `letter-spacing: 0.12em` 주입 포함), 비교 5개 run에서 안내 줄이 읽히는지, 좁은 폭(390px)에서 범례 줄, 버림 1초처럼 얇은 띠가 보이는지.
  - 모든 진입 화면: `TimeSeriesChart`는 `RunDetailPage`의 실행 중 그림(`:376`)에서도 쓰인다 — `marks`를 넘기지 않으므로 그대로인지 확인.
- **마무리(`/finish-slice`)**: build-log 단락, roadmap §B83(「이 plan이 정한 것」 일곱 줄 + 못 한 검증 + spec D10 「지금의 시트들은 기본 기준 값」 문장 정정), 현황판·상태줄, 릴리즈 노트 줄(§B82 (5) + 「비교·인쇄·내보내기에 집계 기준 표시, 시계열에 상승·버림 띠」). **A와 B가 함께 들어갔으므로 릴리즈 금지가 풀린다**는 것을 현황판에 적는다.
