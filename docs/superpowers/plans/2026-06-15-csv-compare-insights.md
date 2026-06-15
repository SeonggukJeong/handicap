# CSV / Compare 인사이트 표면화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이미 계산돼 `ReportJson.insights[]`에 있는 인사이트를, 지금 버리고 있는 4개 표면(단일-run CSV·비교 CSV·비교 XLSX·비교 화면)에 노출하고, 부산물로 기존 단일-run XLSX `Insights` 시트의 `onset_second` 누락 열을 닫는다.

**Architecture:** 백엔드는 `export.rs`에 정규 컬럼 셋(단일 const) + 공유 CSV/XLSX 행-writer를 두고 4 export 표면이 재사용(드리프트 차단). 신규 export 함수 2개(단일/비교 인사이트 CSV) + 비교 XLSX `Insights` 시트 + 라우트 2개(기존 export 라우트 미러). 프론트는 다운로드 버튼 2개 + 비교 페이지에 `InsightCompareMatrix`(kind×run, 클라가 이미 fetch한 `/report.insights` 재사용). **엔진·워커·proto·migration·UI Zod 무변경, 읽기경로 only.**

**Tech Stack:** Rust(axum, `csv`, `rust_xlsxwriter`, `calamine` 테스트) + TypeScript/React(Vitest/RTL, Tailwind). spec: `docs/superpowers/specs/2026-06-15-csv-compare-insights-design.md` (R-id 척추 R1–R12).

<!-- REVIEW-GATE: APPROVED -->

---

## File Structure

**Backend (`crates/controller/`):**
- `src/export.rs` — 수정: `INSIGHT_COLUMNS` const + `insight_csv_cells` + `write_insight_xlsx_row` 헬퍼; 기존 `report_to_xlsx` Insights 시트를 헬퍼로 리팩터(+onset_second); 신규 `report_to_insights_csv`·`comparison_to_insights_csv`; `comparison_to_xlsx`에 `Insights` 시트. (한 책임 = 리포트 직렬화, 기존 파일 유지.)
- `src/api/runs.rs` — 수정: `report_insights_csv`·`compare_insights_csv` 핸들러(기존 `report_csv`/`compare_csv` 미러).
- `src/app.rs` — 수정: 라우트 2개 등록.
- `tests/export_routes_test.rs` — 수정: 신규 라우트 2개 통합 테스트(기존 헬퍼 `make_app`/`seed_run_with_metrics`/`seed_two_runs` 재사용).

**Frontend (`ui/`):**
- `src/api/client.ts` — 수정: `reportInsightsCsvUrl`·`compareInsightsCsvUrl` URL 빌더.
- `src/components/report/ReportView.tsx` — 수정: 단일 인사이트 CSV 다운로드 버튼.
- `src/pages/ScenarioComparePage.tsx` — 수정: 비교 인사이트 CSV export 버튼 + `<InsightCompareMatrix>` 렌더.
- `src/i18n/ko.ts` — 수정: `insightLabels`(kind→짧은 라벨) + `insightCompare`(매트릭스 문구).
- `src/components/compare/InsightCompareMatrix.tsx` — **신규**: kind×run 매트릭스(presentational).
- `src/components/compare/__tests__/InsightCompareMatrix.test.tsx` — **신규** 테스트.
- 기존 `ReportView.test.tsx`·`ScenarioComparePage.test.tsx` — 다운로드 버튼 테스트 확장.

**커밋 경계(green-fold):** cargo-영향 커밋마다 전체 워크스페이스 게이트 + 미사용/RED-only 단독 커밋 불가(루트 CLAUDE.md). 각 Task = 1 green 커밋. 신규 `pub fn`은 lib 공개 API라 호출자가 테스트뿐이어도 dead_code 경고 없음(기존 `report_to_csv`와 동일) — Task 1/2(export 함수)와 Task 3(라우트)를 안전히 분리할 수 있다.

---

## Task 1: 백엔드 — 정규 컬럼 셋 + 공유 writer + 단일-run 인사이트 CSV + 단일 XLSX `onset_second`

충족 R: R1, R4, R5, R9, R11.

**Files:**
- Modify: `crates/controller/src/export.rs` (헬퍼 추가 + `report_to_xlsx` Insights 시트 리팩터 + `report_to_insights_csv` 추가 + 인라인 테스트). `export.rs`는 이미 `#[cfg(test)] mod tests`가 있어 tdd-guard 자동 통과.

- [ ] **Step 1: 실패 테스트 — 기존 `xlsx_has_insights_sheet`에 `onset_second` 단언 추가 + 단일 인사이트 CSV 테스트 + 컬럼 parity 테스트**

`crates/controller/src/export.rs`의 `mod tests` 안. 먼저 기존 `xlsx_has_insights_sheet`에서 두 번째(`load_gen_saturated`) 인사이트의 `onset_second: None`을 `onset_second: Some(14)`로 바꾸고, 함수 끝(빈-셀 단언들 뒤)에 아래 단언을 추가:

```rust
        // 새 13번째 열 onset_second (col 12 = M)
        assert_eq!(
            ws.get_value((0, 12)),
            Some(&Data::String("onset_second".into()))
        );
        // 사이징 행(벡터 인덱스 1 → 시트 row 2)의 onset_second = 14
        assert_eq!(ws.get_value((2, 12)), Some(&Data::Float(14.0)));
        // slowest_step 행(row 1)은 onset None → 미기록(None 또는 Empty)
        assert!(matches!(ws.get_value((1, 12)), None | Some(Data::Empty)));
```

그리고 새 테스트 2개를 `mod tests` 끝에 추가:

```rust
    fn insight(kind: &str, severity: &str) -> crate::insights::Insight {
        crate::insights::Insight {
            kind: kind.into(),
            severity: severity.into(),
            step_id: None,
            metric: None,
            value: None,
            pct: None,
            count: None,
            status_class: None,
            window_seconds: None,
            recommended: None,
            cause: None,
            recommended_workers: None,
            onset_second: None,
        }
    }

    #[test]
    fn report_insights_csv_header_and_rows() {
        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.insights = vec![crate::insights::Insight {
            step_id: Some("a".into()),
            metric: Some("p95_ms".into()),
            value: Some(50.0),
            ..insight("slowest_step", "info")
        }];
        let csv = String::from_utf8(report_to_insights_csv(&r)).unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(
            lines[0],
            "kind,severity,step_id,metric,value,pct,count,status_class,window_seconds,recommended,cause,recommended_workers,onset_second"
        );
        assert_eq!(lines.len(), 2); // header + 1 insight
        assert!(lines[1].starts_with("slowest_step,info,a,p95_ms,50,,,,,,,,"));
    }

    #[test]
    fn report_insights_csv_empty_is_header_only() {
        let r = report_with_steps(vec![step("a", 1, 1)]); // insights: vec![]
        let csv = String::from_utf8(report_to_insights_csv(&r)).unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), 1); // header only, never 0-byte
        assert!(lines[0].starts_with("kind,severity,"));
    }

    #[test]
    fn insight_columns_are_single_source() {
        // 단일 CSV 헤더 ≡ 단일 XLSX 헤더 ≡ INSIGHT_COLUMNS (parity, R5).
        let r = {
            let mut r = report_with_steps(vec![step("a", 1, 1)]);
            r.insights = vec![insight("slo_pass", "info")];
            r
        };
        let csv = String::from_utf8(report_to_insights_csv(&r)).unwrap();
        let csv_header: Vec<&str> = csv.lines().next().unwrap().split(',').collect();
        assert_eq!(csv_header, INSIGHT_COLUMNS.to_vec());
    }
```

> 참고: `..insight(...)` struct-update는 `crate::insights::Insight`의 13필드를 전부 기본 None으로 채운 뒤 일부만 덮어쓰는 헬퍼. `insight()` 자체가 모든 필드를 명시하므로 새 `Insight` 필드가 추가되면 컴파일러가 이 헬퍼를 잡는다.

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cargo test -p handicap-controller --lib export 2>&1 | tail -20`
Expected: FAIL — `report_to_insights_csv` / `INSIGHT_COLUMNS` not found (+ `onset_second` 단언 미통과).

- [ ] **Step 3: 구현 — const + 헬퍼 + `report_to_xlsx` 리팩터 + `report_to_insights_csv`**

`export.rs` 상단 import를 수정: `use rust_xlsxwriter::Workbook;` → `use rust_xlsxwriter::{Workbook, Worksheet};`

`SUMMARY_METRICS` const 아래(또는 `report_to_csv` 위)에 추가:

```rust
/// 모든 CSV/XLSX 인사이트 표면이 공유하는 정규 컬럼 순서(단일 소스).
/// `Insight` 구조체(insights.rs) 필드 순서와 일치. 비교 표면은 `run_id` 열을
/// 앞에 붙이고, 이 13열은 모든 표면에서 동일하다.
const INSIGHT_COLUMNS: [&str; 13] = [
    "kind",
    "severity",
    "step_id",
    "metric",
    "value",
    "pct",
    "count",
    "status_class",
    "window_seconds",
    "recommended",
    "cause",
    "recommended_workers",
    "onset_second",
];

/// 인사이트 하나를 13개 CSV 셀로(None → 빈 문자열), `INSIGHT_COLUMNS` 순서.
fn insight_csv_cells(ins: &crate::insights::Insight) -> Vec<String> {
    let f = |v: Option<f64>| v.map(|x| x.to_string()).unwrap_or_default();
    let i = |v: Option<i64>| v.map(|x| x.to_string()).unwrap_or_default();
    vec![
        ins.kind.clone(),
        ins.severity.clone(),
        ins.step_id.clone().unwrap_or_default(),
        ins.metric.clone().unwrap_or_default(),
        f(ins.value),
        f(ins.pct),
        ins.count.map(|x| x.to_string()).unwrap_or_default(),
        ins.status_class.clone().unwrap_or_default(),
        i(ins.window_seconds),
        f(ins.recommended),
        ins.cause.clone().unwrap_or_default(),
        f(ins.recommended_workers),
        i(ins.onset_second),
    ]
}

/// 인사이트 하나의 13개 타입별 셀을 `ws`의 (row, col_offset + i)에 기록.
/// 숫자 필드는 number로, `None`은 빈 셀(미기록). col_offset = 0(단일) | 1(비교 run_id 뒤).
fn write_insight_xlsx_row(ws: &mut Worksheet, row: u32, col_offset: u16, ins: &crate::insights::Insight) {
    let c = |i: u16| col_offset + i;
    ws.write_string(row, c(0), &ins.kind).expect("w");
    ws.write_string(row, c(1), &ins.severity).expect("w");
    if let Some(v) = &ins.step_id {
        ws.write_string(row, c(2), v).expect("w");
    }
    if let Some(v) = &ins.metric {
        ws.write_string(row, c(3), v).expect("w");
    }
    if let Some(v) = ins.value {
        ws.write_number(row, c(4), v).expect("w");
    }
    if let Some(v) = ins.pct {
        ws.write_number(row, c(5), v).expect("w");
    }
    if let Some(v) = ins.count {
        ws.write_number(row, c(6), v as f64).expect("w");
    }
    if let Some(v) = &ins.status_class {
        ws.write_string(row, c(7), v).expect("w");
    }
    if let Some(v) = ins.window_seconds {
        ws.write_number(row, c(8), v as f64).expect("w");
    }
    if let Some(v) = ins.recommended {
        ws.write_number(row, c(9), v).expect("w");
    }
    if let Some(v) = &ins.cause {
        ws.write_string(row, c(10), v).expect("w");
    }
    if let Some(v) = ins.recommended_workers {
        ws.write_number(row, c(11), v).expect("w");
    }
    if let Some(v) = ins.onset_second {
        ws.write_number(row, c(12), v as f64).expect("w");
    }
}

/// 단일-run 인사이트 CSV = 인사이트 1개당 1행(정규 컬럼). 인사이트가 없어도
/// 헤더는 항상 기록(0-byte 다운로드 방지, R11).
pub fn report_to_insights_csv(report: &ReportJson) -> Vec<u8> {
    let mut w = csv::Writer::from_writer(Vec::new());
    w.write_record(INSIGHT_COLUMNS).expect("csv header");
    for ins in &report.insights {
        w.write_record(insight_csv_cells(ins)).expect("csv row");
    }
    w.into_inner().expect("csv flush")
}
```

이어서 기존 `report_to_xlsx`의 `// --- Insights sheet (only if present) ---` 블록(현재 line 318–376, 하드코딩 12열 헤더 + 인라인 if-let 행 writer) **전체**를 아래로 교체:

```rust
    // --- Insights sheet (only if present) ---
    if !report.insights.is_empty() {
        let ws = wb.add_worksheet();
        ws.set_name("Insights").expect("sheet name");
        for (c, h) in INSIGHT_COLUMNS.iter().enumerate() {
            ws.write_string(0, c as u16, *h).expect("w");
        }
        for (i, ins) in report.insights.iter().enumerate() {
            write_insight_xlsx_row(ws, (i + 1) as u32, 0, ins);
        }
    }
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `cargo build -p handicap-worker && cargo test -p handicap-controller --lib export 2>&1 | tail -20`
Expected: PASS (`report_insights_csv_header_and_rows`, `report_insights_csv_empty_is_header_only`, `insight_columns_are_single_source`, `xlsx_has_insights_sheet` 모두 green). 기존 `csv_has_header_and_one_row_per_step`·`golden_summary_deltas_match`·`comparison_xlsx_roundtrips`도 무수정 통과(R9).

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/src/export.rs
git commit -m "feat(export): 정규 인사이트 컬럼 셋 + 단일-run 인사이트 CSV + 단일 XLSX onset_second 열"
```

---

## Task 2: 백엔드 — 비교 인사이트 CSV + 비교 XLSX `Insights` 시트

충족 R: R2, R3, R5, R9, R11.

**Files:**
- Modify: `crates/controller/src/export.rs` (`comparison_to_insights_csv` 추가 + `comparison_to_xlsx`에 `Insights` 시트 + 인라인 테스트).

- [ ] **Step 1: 실패 테스트 — 비교 인사이트 CSV(long-format) + 비교 XLSX 시트**

`mod tests` 끝에 추가:

```rust
    #[test]
    fn comparison_insights_csv_long_format() {
        let mut a = report_with_steps(vec![step("s", 1, 100)]);
        a.run.id = "A".into();
        a.insights = vec![
            crate::insights::Insight {
                step_id: Some("s".into()),
                value: Some(100.0),
                ..insight("slowest_step", "info")
            },
            crate::insights::Insight {
                status_class: Some("5xx".into()),
                pct: Some(0.1),
                count: Some(3),
                ..insight("status_class", "warning")
            },
        ];
        let mut b = report_with_steps(vec![step("s", 1, 50)]);
        b.run.id = "B".into();
        b.insights = vec![]; // B has no insights → contributes no rows

        let csv = String::from_utf8(comparison_to_insights_csv(&[a, b])).unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(
            lines[0],
            "run_id,kind,severity,step_id,metric,value,pct,count,status_class,window_seconds,recommended,cause,recommended_workers,onset_second"
        );
        assert_eq!(lines.len(), 3); // header + 2 rows (both from A)
        assert!(lines[1].starts_with("A,slowest_step,info,s,"));
        assert!(lines[2].starts_with("A,status_class,warning,,"));
    }

    #[test]
    fn comparison_insights_csv_empty_is_header_only() {
        let mut a = report_with_steps(vec![step("s", 1, 1)]);
        a.run.id = "A".into();
        let mut b = report_with_steps(vec![step("s", 1, 1)]);
        b.run.id = "B".into();
        let csv = String::from_utf8(comparison_to_insights_csv(&[a, b])).unwrap();
        assert_eq!(csv.lines().count(), 1); // header only
    }

    #[test]
    fn comparison_xlsx_has_insights_sheet() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;
        let mut a = report_with_steps(vec![step("s", 1, 100)]);
        a.run.id = "A".into();
        a.insights = vec![crate::insights::Insight {
            step_id: Some("s".into()),
            value: Some(100.0),
            ..insight("slowest_step", "info")
        }];
        let mut b = report_with_steps(vec![step("s", 1, 50)]);
        b.run.id = "B".into();
        let bytes = comparison_to_xlsx(&[a, b], 0);
        let mut wb: Xlsx<Cursor<Vec<u8>>> = open_workbook_from_rs(Cursor::new(bytes)).unwrap();
        let ws = wb.worksheet_range("Insights").expect("Insights sheet");
        // run_id 열 prepend + 정규 컬럼
        assert_eq!(ws.get_value((0, 0)), Some(&Data::String("run_id".into())));
        assert_eq!(ws.get_value((0, 1)), Some(&Data::String("kind".into())));
        // 첫 데이터 행(A의 slowest_step)
        assert_eq!(ws.get_value((1, 0)), Some(&Data::String("A".into())));
        assert_eq!(ws.get_value((1, 1)), Some(&Data::String("slowest_step".into())));
        // value는 col_offset 1 + value 인덱스 4 = 5
        assert_eq!(ws.get_value((1, 5)), Some(&Data::Float(100.0)));
    }
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cargo test -p handicap-controller --lib export 2>&1 | tail -20`
Expected: FAIL — `comparison_to_insights_csv` not found / `Insights` sheet 없음.

- [ ] **Step 3: 구현 — `comparison_to_insights_csv` + 비교 XLSX 시트**

`report_to_insights_csv` 아래에 추가:

```rust
/// 비교 인사이트 CSV = long-format, (run, insight)당 1행, 선두 `run_id` 열.
/// 헤더는 항상 기록(R11). baseline 무관(인사이트엔 run간 delta 의미가 없음).
pub fn comparison_to_insights_csv(reports: &[ReportJson]) -> Vec<u8> {
    let mut w = csv::Writer::from_writer(Vec::new());
    let mut header = vec!["run_id"];
    header.extend(INSIGHT_COLUMNS);
    w.write_record(&header).expect("hdr");
    for r in reports {
        for ins in &r.insights {
            let mut rec = vec![r.run.id.clone()];
            rec.extend(insight_csv_cells(ins));
            w.write_record(&rec).expect("row");
        }
    }
    w.into_inner().expect("flush")
}
```

이어서 `comparison_to_xlsx` 함수의 마지막 줄 `wb.save_to_buffer().expect("xlsx")` **앞에** 추가:

```rust
    // Insights: long-format, run_id prepend (어느 run이라도 인사이트 있을 때만).
    if reports.iter().any(|r| !r.insights.is_empty()) {
        let ws = wb.add_worksheet();
        ws.set_name("Insights").expect("name");
        ws.write_string(0, 0, "run_id").expect("w");
        for (c, h) in INSIGHT_COLUMNS.iter().enumerate() {
            ws.write_string(0, (1 + c) as u16, *h).expect("w");
        }
        let mut row = 1u32;
        for r in reports {
            for ins in &r.insights {
                ws.write_string(row, 0, &r.run.id).expect("w");
                write_insight_xlsx_row(ws, row, 1, ins);
                row += 1;
            }
        }
    }
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `cargo test -p handicap-controller --lib export 2>&1 | tail -20`
Expected: PASS (신규 3 + 기존 전부). 특히 기존 `comparison_xlsx_roundtrips`(insight-free reports)는 `Insights` 시트가 안 생겨 무수정 통과(R9).

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/src/export.rs
git commit -m "feat(export): 비교 인사이트 CSV(long-format) + 비교 XLSX Insights 시트"
```

---

## Task 3: 백엔드 — 라우트 2개 (`report-insights.csv` / `compare-insights.csv`)

충족 R: R1, R2.

**Files:**
- Modify: `crates/controller/src/api/runs.rs` (핸들러 2개; 파일에 인라인 test `state_with`가 있어 tdd-guard 통과).
- Modify: `crates/controller/src/app.rs` (라우트 2개).
- Modify: `crates/controller/tests/export_routes_test.rs` (통합 테스트 2개 — test-path 파일이라 app.rs 편집의 tdd-guard도 충족).

- [ ] **Step 1: 실패 테스트 — 신규 라우트 통합 테스트**

`crates/controller/tests/export_routes_test.rs` 끝에 추가(기존 `make_app`/`seed_run_with_metrics`/`seed_two_runs` 재사용):

```rust
#[tokio::test]
async fn single_run_insights_csv_export_returns_csv() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (run_id, _) = seed_run_with_metrics(&db).await;
    let app = make_app(db);

    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/runs/{run_id}/report-insights.csv"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let cd = resp
        .headers()
        .get("content-disposition")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(cd.contains(&format!("run-{run_id}-insights.csv")), "filename: {cd}");

    let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    let first = text.lines().next().unwrap();
    assert_eq!(
        first,
        "kind,severity,step_id,metric,value,pct,count,status_class,window_seconds,recommended,cause,recommended_workers,onset_second"
    );
}

#[tokio::test]
async fn comparison_insights_csv_returns_long_format() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (s, a, b) = seed_two_runs(&db).await;
    let app = make_app(db);

    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!(
                    "/api/scenarios/{s}/runs/compare-insights.csv?run_ids={a},{b}&baseline={a}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(
        text.lines().next().unwrap().starts_with("run_id,kind,severity,"),
        "header: {}",
        text.lines().next().unwrap()
    );
}
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cargo test -p handicap-controller --test export_routes_test 2>&1 | tail -20`
Expected: FAIL — 라우트 미존재 → 404(또는 컴파일 에러 `compare_insights_csv` 미존재).

- [ ] **Step 3: 구현 — 핸들러 + 라우트**

`crates/controller/src/api/runs.rs`의 `report_xlsx` 핸들러 뒤(line ~717)에 추가:

```rust
pub async fn report_insights_csv(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    ensure_terminal(&row)?;
    let report = build_report_for_run(&state.db, &id).await?;
    let bytes = crate::export::report_to_insights_csv(&report);
    Ok(file_response(
        "text/csv; charset=utf-8",
        &format!("run-{id}-insights.csv"),
        bytes,
    ))
}
```

`compare_xlsx` 핸들러 뒤(line ~798)에 추가:

```rust
pub async fn compare_insights_csv(
    State(state): State<AppState>,
    Path(scenario_id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<CompareParams>,
) -> Result<axum::response::Response, ApiError> {
    // baseline은 게이트(resolve_comparison) 통과용 — 인사이트엔 delta가 없어 content엔 미사용.
    let (reports, _base) = resolve_comparison(&state, &scenario_id, &params).await?;
    let bytes = crate::export::comparison_to_insights_csv(&reports);
    Ok(file_response(
        "text/csv; charset=utf-8",
        "comparison-insights.csv",
        bytes,
    ))
}
```

`crates/controller/src/app.rs`에서 기존 라우트 옆에 등록 — `compare.xlsx` 라우트(line 52–54) 뒤:

```rust
        .route(
            "/scenarios/{id}/runs/compare-insights.csv",
            get(runs_api::compare_insights_csv),
        )
```

그리고 `report.xlsx` 라우트(line 60) 뒤:

```rust
        .route(
            "/runs/{id}/report-insights.csv",
            get(runs_api::report_insights_csv),
        )
```

> 라우트 트랩(controller CLAUDE.md): `report-insights.csv`·`compare-insights.csv`는 리터럴 세그먼트라 `{id}` 캡처와 무충돌. 비교는 반드시 `/scenarios/{id}/runs/...` 하위(스코프 검증 재사용).

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `cargo build -p handicap-worker && cargo test -p handicap-controller --test export_routes_test 2>&1 | tail -20`
Expected: PASS (신규 2 + 기존 export route 테스트 전부).

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/src/api/runs.rs crates/controller/src/app.rs crates/controller/tests/export_routes_test.rs
git commit -m "feat(api): 인사이트 CSV 다운로드 라우트 2개 (단일/비교)"
```

---

## Task 4: UI — 다운로드 URL 빌더 + 버튼 2개

충족 R: R10.

**Files:**
- Modify: `ui/src/api/client.ts` (URL 빌더 2개).
- Modify: `ui/src/components/report/ReportView.tsx` (단일 인사이트 CSV 버튼).
- Modify: `ui/src/pages/ScenarioComparePage.tsx` (비교 인사이트 CSV 버튼).
- Modify: `ui/src/components/report/__tests__/ReportView.test.tsx` (버튼 테스트; 기존 test-path 파일).

> tdd-guard: `ReportView.test.tsx`가 이미 test-path 파일로 디스크에 있어 client.ts/ReportView.tsx/ScenarioComparePage.tsx 편집이 unblock된다.

- [ ] **Step 1: 실패 테스트 — 단일 인사이트 CSV 버튼이 올바른 URL로 다운로드**

기존 `ui/src/components/report/__tests__/ReportView.test.tsx`의 `vi.mock("../../../api/download", ...)` 패턴을 따른다(없으면 추가). 새 테스트:

```tsx
it("인사이트 CSV 다운로드 버튼이 report-insights.csv를 받는다", async () => {
  const user = userEvent.setup();
  // 기존 테스트의 report 픽스처 + render 헬퍼 재사용
  renderReport(); // 기존 헬퍼 (없으면 기존 첫 it의 render 블록을 복제)
  await user.click(screen.getByRole("button", { name: "Download 인사이트 CSV" }));
  expect(downloadFileMock).toHaveBeenCalledWith(
    expect.stringContaining("/report-insights.csv"),
    expect.stringContaining("-insights.csv"),
    "text/csv",
  );
});
```

> 실제 mock 변수명/픽스처는 기존 파일 관례를 따른다. 기존에 `downloadFile` mock이 없다면: `vi.mock("../../../api/download", () => ({ downloadFile: vi.fn(() => Promise.resolve()) }));` 추가 + `import { downloadFile } from "../../../api/download";` 후 `const downloadFileMock = vi.mocked(downloadFile);`.

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd ui && pnpm test ReportView 2>&1 | tail -20`
Expected: FAIL — "Download 인사이트 CSV" 버튼 없음.

- [ ] **Step 3: 구현 — URL 빌더 + 버튼 2개**

`ui/src/api/client.ts`의 `compareXlsxUrl` 뒤(line 177, `};` 앞)에 추가:

```ts
  reportInsightsCsvUrl: (runId: string) =>
    `${BASE}/runs/${encodeURIComponent(runId)}/report-insights.csv`,
  compareInsightsCsvUrl: (scenarioId: string, runIds: string[], baseline: string) =>
    `${BASE}/scenarios/${encodeURIComponent(scenarioId)}/runs/compare-insights.csv?run_ids=${runIds.map(encodeURIComponent).join(",")}&baseline=${encodeURIComponent(baseline)}`,
```

`ui/src/components/report/ReportView.tsx`의 `Download XLSX` 버튼(line 122–134) 뒤에 추가:

```tsx
          <button
            type="button"
            onClick={() =>
              downloadFile(
                api.reportInsightsCsvUrl(report.run.id),
                `run-${report.run.id}-insights.csv`,
                "text/csv",
              ).catch((e) => setDlErr((e as Error).message))
            }
            className="inline-block px-3 py-1.5 text-sm bg-slate-700 text-white rounded hover:bg-slate-800"
          >
            Download 인사이트 CSV
          </button>
```

`ui/src/pages/ScenarioComparePage.tsx`는 **두 컴포넌트로 분리돼 있다**: 외부 `ScenarioComparePage`(line 14–93, 로딩/에러 게이트) + 내부 `ScenarioCompareInner`(line 106–220). **아래 모든 편집은 내부 `ScenarioCompareInner`에 들어간다** — `scenarioId`/`runIds`/`baseline`/`setErr`/`reports`/`stepLabelMap`/`api`/`downloadFile`가 전부 그 안에서 스코프에 있다(외부 컴포넌트엔 `stepLabelMap`이 없으니 외부에 넣지 말 것).

`ScenarioCompareInner` 내부의 `handleExportXlsx`(line 161–167) 뒤에 추가:

```tsx
  const handleExportInsightsCsv = () => {
    downloadFile(
      api.compareInsightsCsvUrl(scenarioId, runIds, baseline),
      "comparison-insights.csv",
      "text/csv",
    ).catch((e) => setErr((e as Error).message));
  };
```

그리고 `Export XLSX` 버튼(line 186–192) 뒤에 추가:

```tsx
          <button
            type="button"
            onClick={handleExportInsightsCsv}
            className="px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Export 인사이트 CSV
          </button>
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `cd ui && pnpm test ReportView 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add ui/src/api/client.ts ui/src/components/report/ReportView.tsx ui/src/pages/ScenarioComparePage.tsx ui/src/components/report/__tests__/ReportView.test.tsx
git commit -m "feat(ui): 인사이트 CSV 다운로드 버튼 2개 (리포트/비교) + URL 빌더"
```

---

## Task 5: UI — `InsightCompareMatrix` (kind×run) + ko 라벨 + 비교 페이지 렌더

충족 R: R6, R7, R8, R11, R12.

**Files:**
- Create: `ui/src/components/compare/__tests__/InsightCompareMatrix.test.tsx` (테스트 먼저 → tdd-guard unblock).
- Create: `ui/src/components/compare/InsightCompareMatrix.tsx`.
- Modify: `ui/src/i18n/ko.ts` (`insightLabels` + `insightCompare`).
- Modify: `ui/src/pages/ScenarioComparePage.tsx` (매트릭스 렌더).

- [ ] **Step 1: 실패 테스트 — 매트릭스 동작(union 행·셀·numberless·미보유·빈 상태·step 라벨)**

Create `ui/src/components/compare/__tests__/InsightCompareMatrix.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { InsightCompareMatrix } from "../InsightCompareMatrix";
import type { Insight } from "../../../api/schemas";

function ins(p: Partial<Insight> & { kind: string; severity: string }): Insight {
  return {
    step_id: undefined,
    metric: undefined,
    value: undefined,
    pct: undefined,
    count: undefined,
    status_class: undefined,
    window_seconds: undefined,
    recommended: undefined,
    cause: undefined,
    recommended_workers: undefined,
    onset_second: undefined,
    ...p,
  } as Insight;
}

const stepLabelMap = new Map<string, string>([["s1", "로그인"]]);

describe("InsightCompareMatrix", () => {
  it("run 합집합으로 행을 만들고 미보유 셀은 —", () => {
    const reports = [
      {
        run: { id: "RUNAAAAAA" },
        insights: [
          ins({ kind: "slowest_step", severity: "info", step_id: "s1", value: 120 }),
          ins({ kind: "status_class", severity: "warning", status_class: "5xx", pct: 0.1, count: 3 }),
        ],
      },
      {
        run: { id: "RUNBBBBBB" },
        insights: [ins({ kind: "slowest_step", severity: "info", step_id: "s1", value: 90 })],
      },
    ];
    render(<InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />);

    // 2 distinct identity 행
    expect(screen.getByText(/가장 느린 스텝 · 로그인/)).toBeInTheDocument();
    expect(screen.getByText(/상태 코드 비율 · 5xx/)).toBeInTheDocument();

    // status_class는 B엔 없음 → — 가 최소 1개
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
    // slowest_step 대표 수치(value) 병기
    expect(screen.getByText(/120/)).toBeInTheDocument();
  });

  it("numberless 인사이트(slo_pass)는 배지만(수치 없음)", () => {
    const reports = [
      { run: { id: "R1" }, insights: [ins({ kind: "slo_pass", severity: "info" })] },
      { run: { id: "R2" }, insights: [] },
    ];
    render(<InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />);
    expect(screen.getByText("SLO 통과")).toBeInTheDocument();
    // 셀에 severity 배지는 있고(보유 신호), 미보유 R2는 —
    expect(screen.getAllByText("—").length).toBe(1);
  });

  it("합집합이 비면 빈 상태", () => {
    const reports = [
      { run: { id: "R1" }, insights: [] },
      { run: { id: "R2" }, insights: [] },
    ];
    render(<InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />);
    expect(screen.getByText("감지된 인사이트가 없습니다.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd ui && pnpm test InsightCompareMatrix 2>&1 | tail -20`
Expected: FAIL — 컴포넌트 미존재.

- [ ] **Step 3: 구현 — ko 라벨 + 컴포넌트 + 렌더**

`ui/src/i18n/ko.ts`의 `insightActions` 블록(line 314–323) **앞**에 추가:

```ts
  // 비교 화면 인사이트 매트릭스(kind×run). 행 = 인사이트, 열 = run.
  insightCompare: {
    title: "인사이트 비교",
    colInsight: "인사이트",
    empty: "감지된 인사이트가 없습니다.",
  },
  // 인사이트 kind → 짧은 라벨(매트릭스 행 머리). InsightPanel.message()의 산문과 별개.
  insightLabels: {
    slowest_step: "가장 느린 스텝",
    error_hotspot: "에러 핫스팟",
    no_request_step: "요청 없는 스텝",
    slo_failure: "SLO 실패",
    slo_pass: "SLO 통과",
    status_class: "상태 코드 비율",
    status_temporal: "후반 5xx 등장",
    load_gen_saturated: "부하 생성기 포화",
  },
```

Create `ui/src/components/compare/InsightCompareMatrix.tsx`:

```tsx
import type { Insight } from "../../api/schemas";
import { ko } from "../../i18n/ko";

// 클라가 이미 fetch한 리포트의 최소 형태만 소비(Report 전체 픽스처 불요 — R7).
type MatrixReport = { run: { id: string }; insights?: Insight[] };
type Props = { reports: MatrixReport[]; stepLabelMap: Map<string, string> };

const SEV_CLASS: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-300",
  warning: "bg-amber-100 text-amber-800 border-amber-300",
  info: "bg-slate-100 text-slate-700 border-slate-300",
};
// `as const` 객체는 string 인덱싱 불가 → 넓힌 lookup 뷰(InsightPanel 패턴).
const LABELS: Record<string, string | undefined> = ko.insightLabels;

// 행 identity: 같은 kind라도 step/status_class별로 별 행(R8).
function identity(i: Insight): string {
  return `${i.kind}|${i.step_id ?? i.status_class ?? ""}`;
}

// 대표 수치: value → pct(%) → count → window_seconds. 전부 없으면 null(배지만, R12).
function repNumber(i: Insight): string | null {
  if (i.value != null) return i.value.toLocaleString("en-US");
  if (i.pct != null) return `${(i.pct * 100).toFixed(1)}%`;
  if (i.count != null) return i.count.toLocaleString("en-US");
  if (i.window_seconds != null) return `${i.window_seconds}s`;
  return null;
}

function rowLabel(i: Insight, stepLabelMap: Map<string, string>): string {
  const base = LABELS[i.kind] ?? i.kind;
  if (i.step_id) return `${base} · ${stepLabelMap.get(i.step_id) ?? i.step_id}`;
  if (i.status_class) return `${base} · ${i.status_class}`;
  return base;
}

export function InsightCompareMatrix({ reports, stepLabelMap }: Props) {
  // 합집합: run 순회 first-seen(각 run insights는 백엔드 order_rank 정렬 → 결정적, R8).
  const rows: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  const byRun = new Map<string, Map<string, Insight>>();
  for (const r of reports) {
    const m = new Map<string, Insight>();
    for (const i of r.insights ?? []) {
      const k = identity(i);
      m.set(k, i);
      if (!seen.has(k)) {
        seen.add(k);
        rows.push({ key: k, label: rowLabel(i, stepLabelMap) });
      }
    }
    byRun.set(r.run.id, m);
  }

  return (
    <section aria-label={ko.insightCompare.title} className="mt-8">
      <h3 className="text-lg font-semibold mb-2">{ko.insightCompare.title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{ko.insightCompare.empty}</p>
      ) : (
        <table className="text-sm border-collapse">
          <thead>
            <tr>
              <th className="text-left px-2 py-1 border-b border-slate-200 dark:border-slate-700">
                {ko.insightCompare.colInsight}
              </th>
              {reports.map((r) => (
                <th
                  key={r.run.id}
                  className="px-2 py-1 border-b border-slate-200 dark:border-slate-700 text-center"
                >
                  #{r.run.id.slice(-6)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="px-2 py-1 border-b border-slate-100 dark:border-slate-800">
                  {row.label}
                </td>
                {reports.map((r) => {
                  const i = byRun.get(r.run.id)?.get(row.key);
                  if (!i) {
                    return (
                      <td
                        key={r.run.id}
                        className="px-2 py-1 border-b border-slate-100 dark:border-slate-800 text-center text-slate-400"
                      >
                        —
                      </td>
                    );
                  }
                  const num = repNumber(i);
                  return (
                    <td
                      key={r.run.id}
                      className="px-2 py-1 border-b border-slate-100 dark:border-slate-800 text-center"
                    >
                      <span
                        className={[
                          "inline-block rounded border px-1.5 py-0.5 text-xs",
                          SEV_CLASS[i.severity] ?? SEV_CLASS.info,
                        ].join(" ")}
                      >
                        {i.severity}
                        {num != null ? ` ${num}` : ""}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

`ui/src/pages/ScenarioComparePage.tsx`: import 추가 + 내부 `ScenarioCompareInner`의 `<CompareMatrix .../>` 뒤에 렌더.

파일 상단 import 블록(기존 `import { CompareMatrix } …` 다음 줄, line 8 부근)에:
```tsx
import { InsightCompareMatrix } from "../components/compare/InsightCompareMatrix";
```

`ScenarioCompareInner`의 `<CompareMatrix result={labeledResult} labels={runLabels} onBaselineChange={onBaselineChange} />`(line 213–217) 뒤(이 컴포넌트의 닫는 `</div>` 전)에 — `reports`/`stepLabelMap`는 `ScenarioCompareInner`의 props/메모라 그대로 스코프에 있음:
```tsx
      <InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `cd ui && pnpm test InsightCompareMatrix 2>&1 | tail -20`
Expected: PASS (3 테스트).

- [ ] **Step 5: 전체 UI 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build 2>&1 | tail -25`
Expected: lint 0 warnings, 전체 test green(ScenarioComparePage.test.tsx 포함 — 매트릭스 추가로 기존 비교 페이지 테스트가 깨지지 않는지 확인), `tsc -b` clean.

> 함정: `Report[]` → `MatrixReport[]`는 구조적 할당 가능(Report.run.id: string, Report.insights?: Insight[]). 만약 `tsc -b`가 거부하면 ScenarioComparePage에서 `reports={reports}` 그대로 두고 컴포넌트 prop을 점검(넓은 타입이 좁은 구조 타입에 할당되는 방향이라 통과해야 함).

- [ ] **Step 6: 커밋**

```bash
git add ui/src/components/compare/InsightCompareMatrix.tsx ui/src/components/compare/__tests__/InsightCompareMatrix.test.tsx ui/src/i18n/ko.ts ui/src/pages/ScenarioComparePage.tsx
git commit -m "feat(ui): 비교 화면 인사이트 매트릭스(kind×run) + kind 라벨 카탈로그"
```

---

## Task 6: 라이브 라이트 검증 (비-커밋)

충족 R: R1, R2, R6 (end-to-end 표면 확인). spec §6 "라이브 라이트 권장".

- [ ] **Step 1: `/live-verify` 스택 기동** — 워크트리 자체 바이너리 + 격리 DB + responder(인사이트가 뜨도록 일부 5xx·지연 섞기). 완료 run 2개 생성(같은 시나리오).
- [ ] **Step 2: 단일 리포트** — RunDetail에서 "Download 인사이트 CSV" → 받은 `run-<id>-insights.csv` 헤더가 13열인지, `pandas.read_csv`(또는 헤더/행 육안)로 깨끗이 파싱되는지.
- [ ] **Step 3: 비교 페이지** — `/scenarios/{id}/compare?runs=a,b&baseline=a` 열어 `InsightCompareMatrix`가 kind×run으로 렌더되는지(콘솔 Zod 0). "Export 인사이트 CSV" → `comparison-insights.csv` long-format(run_id 열) 파싱 + 비교 XLSX 다운로드 → `Insights` 시트 존재 확인.
- [ ] **Step 4: 정리** — responder/controller/worker kill, 격리 DB 삭제, `.playwright-mcp`·루트 png 정리(루트 CLAUDE.md).

> production diff가 읽기경로뿐이고 백엔드는 calamine 라운드트립+CSV 단언이 직렬화 계약이라, 시간 제약 시 Step 3(비교 매트릭스 실렌더 + 신규 CSV 파싱)만으로도 핵심 갭(UI 신규 표면 + 다운로드 와이어)을 닫는다.

---

## Self-Review

**1. Spec coverage (R1–R12):**
- R1 단일 인사이트 CSV → Task 1(함수)+Task 3(라우트). ✓
- R2 비교 인사이트 CSV → Task 2(함수)+Task 3(라우트). ✓
- R3 비교 XLSX Insights 시트 → Task 2. ✓
- R4 단일 XLSX onset_second → Task 1. ✓
- R5 정규 컬럼 단일 소스 parity → Task 1(const+헬퍼+`insight_columns_are_single_source` 테스트). ✓
- R6 비교 매트릭스 렌더 → Task 5. ✓
- R7 스키마 무변경(기존 fetch 재사용) → Task 5(`MatrixReport` 최소 타입, Zod 무변경). ✓ (변경 0은 §무변경 + 리뷰에서 확인)
- R8 행 identity + 순서 → Task 5(`identity`/first-seen + 테스트). ✓
- R9 byte-identical → Task 1/2 기존 export 테스트 무수정 통과 확인. ✓
- R10 다운로드 버튼 2개 → Task 4. ✓
- R11 빈 상태 → Task 1/2(CSV header-only 테스트) + Task 5(빈 매트릭스 테스트). ✓
- R12 셀 presence/number + 라벨 소스 → Task 5(`repNumber`/`rowLabel` + numberless 테스트). ✓

**2. Placeholder scan:** 모든 코드 블록은 실제 코드. "기존 헬퍼 재사용" 지점(ReportView 테스트 mock 변수명)은 파일 관례 위임이 명시적. 없음.

**3. Type consistency:** `insight_csv_cells`/`write_insight_xlsx_row`/`INSIGHT_COLUMNS`는 Task 1에서 정의, Task 2가 동일 시그니처로 재사용. `report_to_insights_csv`(R1)/`comparison_to_insights_csv`(R2) 함수명이 Task 3 핸들러/Task 4 URL 빌더와 일치(`reportInsightsCsvUrl`→`report-insights.csv`→`report_insights_csv`). `MatrixReport` 구조 타입은 Task 5 내부에서만 사용. ✓

**4. Repo traps 반영:** export pub fn = no dead_code(green-fold 분리 가능) · 라우트 리터럴 세그먼트 + 비교 scenario-scoped(controller CLAUDE.md) · calamine 빈 셀 `None|Data::Empty` · 신규 src 파일 전 테스트 먼저(tdd-guard) · ko 라벨은 신규 맵(message() 재사용 아님, R12) · 전체 `pnpm test`로 ScenarioComparePage 회귀 확인 · `cargo build -p handicap-worker` 워밍 후 controller 테스트(cold-build flake).
