# A4b: Run 비교 + 리포트 Export (CSV/XLSX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 같은 시나리오의 종료된 run들을 화면에서 나란히 비교(2–5개, baseline 대비 Δ)하고, 단일 run 리포트와 비교 결과를 CSV/XLSX로 export한다.

**Architecture:** 하이브리드 — 비교(A)는 클라이언트가 기존 `GET /api/runs/{id}/report`를 N개 받아 브라우저에서 순수 변환, export(B)는 컨트롤러가 `build_report` 결과를 `csv`/`rust_xlsxwriter`로 직렬화. 엔진·워커·proto·SQLite 마이그레이션 무변경. 델타 공식은 한 곳(spec §4.3)에 정의해 Rust(export)·TS(화면)가 동일 적용하고 **공유 골든 fixture**로 교차 검증.

**Tech Stack:** Rust(axum 0.8, `csv` 1, `calamine` 0.26, `rust_xlsxwriter` 0.79), TypeScript/React(Vite, React Query v5, Zod, vitest + RTL).

**구현 순서(spec §3.7):** Phase 1 = export(B, Task 1–8) 먼저 — dep 이동·`build_report_for_run`·서버 델타를 안착(단일-run export는 그 자체로 출하 가능). Phase 2 = 비교(A, Task 9–14) — 클라가 서버와 동일 골든 fixture로 미러. Task 15 = 문서.

**스펙:** `docs/superpowers/specs/2026-06-03-run-comparison-report-export-design.md`

---

## 공유 계약 (모든 task가 따르는 단일 정의)

### 델타 공식 (spec §4.3 — Rust·TS 동일)
```
v_b = baseline 값, v_r = 대상 run 값
pct = (v_b == 0) ? null : (v_r - v_b) / v_b        // 분수(0.21 = +21%), 퍼센트 변환은 표시 계층
polarity:
  lower_is_better {p50_ms, p95_ms, p99_ms, error_rate}: v_r<v_b→"good", v_r>v_b→"bad", ==→"neutral"
  higher_is_better {rps}:                               v_r>v_b→"good", v_r<v_b→"bad", ==→"neutral"
  중립 {count, duration_seconds}: polarity 없음
verdict 행(숫자 아님): candidate FAIL & base PASS→"bad", candidate PASS & base FAIL→"good", 그 외 "neutral"
error_rate = (count==0) ? 0 : errors/count
v_b==0이고 v_r>0 → 라벨 "신규"; v_b==0이고 v_r==0 → "동일"
```
요약 비교 지표 순서: `p50_ms, p95_ms, p99_ms, rps, error_rate`. 스텝 비교 지표: `p95_ms`(+ count, error_count). 스텝 매칭 = **step_id 정확 일치만**, 행 = 모든 run step_id 합집합.

### 골든 fixture (Task 6에서 생성, Task 9에서 재사용)
경로: `testdata/compare_golden.json` (repo 루트). 형태:
```json
{
  "reports": [ <Report JSON>, <Report JSON> ],
  "baseline_id": "<run id of reports[0]>",
  "expected": {
    "summary": [
      {"metric":"p95_ms","values":[152,184],"deltas":[null,{"pct":0.2105263157894737,"polarity":"bad"}]}
    ]
  }
}
```
Rust 읽기: `include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../testdata/compare_golden.json"))`.
TS 읽기: `readFileSync(new URL("../../../../testdata/compare_golden.json", import.meta.url), "utf8")` (import 문 아님 → tsc rootDir 무관).

### terminal 정의
`RunStatus::{Completed, Failed, Aborted}` = terminal. `Pending`/`Running` = 비-terminal(비교/export 거부, UI 선택 불가). verdict는 `Completed` + 활성 criteria일 때만 존재.

---

## Task 1: `rust_xlsxwriter`를 dev-dep → 정식 dep로 이동 (C1)

**Files:**
- Modify: `Cargo.toml:20` (워크스페이스 주석)
- Modify: `crates/controller/Cargo.toml:23-25` (정식 dep 추가), `:53` (dev-dep 줄 제거)

- [ ] **Step 1: 워크스페이스 주석 갱신**

`Cargo.toml:20` 변경:
```toml
rust_xlsxwriter = "0.79"   # report XLSX export (prod) + test fixtures
```

- [ ] **Step 2: 컨트롤러 정식 dep 추가**

`crates/controller/Cargo.toml`의 `[dependencies]`(line 16~) 안, `csv.workspace = true` 근처에 추가:
```toml
rust_xlsxwriter.workspace = true
```

- [ ] **Step 3: 컨트롤러 dev-dep 줄 제거**

`crates/controller/Cargo.toml:53`의 `[dev-dependencies]` 아래 `rust_xlsxwriter.workspace = true` 줄을 **삭제**(정식 dep로 옮겼으므로 중복). dev-dep 섹션에 다른 줄이 있으면 그대로 둔다.

- [ ] **Step 4: 컴파일 확인**

Run: `cargo build -p handicap-controller`
Expected: 성공 (정식 dep로 인식). `cargo tree -p handicap-controller | grep rust_xlsxwriter`로 정식 의존성 트리에 있는지 확인.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml crates/controller/Cargo.toml
git commit -m "build(controller): move rust_xlsxwriter dev-dep -> dep for prod XLSX export"
```

---

## Task 2: `build_report_for_run` 헬퍼 추출 (M1)

`report()` 핸들러의 4-fetch + build 블록을 헬퍼로 추출해 단일·비교 export가 공유.

**Files:**
- Modify: `crates/controller/src/api/runs.rs:247-263`

- [ ] **Step 1: 헬퍼 추가**

`crates/controller/src/api/runs.rs`에 추가 (report 핸들러 위):
```rust
/// Fetch a run's metrics and build its full report. Shared by the `report`
/// JSON handler, single-run export, and N-run comparison export. Returns
/// `NotFound` if the run id doesn't exist.
pub async fn build_report_for_run(
    db: &crate::store::Db,
    run_id: &str,
) -> Result<crate::report::ReportJson, ApiError> {
    let row = runs::get(db, run_id).await?.ok_or(ApiError::NotFound)?;
    let rows = crate::store::metrics::windows_with_hdr(db, run_id).await?;
    let loops = crate::store::metrics::loop_breakdown(db, run_id).await?;
    let branches = crate::store::metrics::if_breakdown(db, run_id).await?;
    let scenario_yaml = row.scenario_yaml.clone();
    Ok(crate::report::build_report(
        &row, &scenario_yaml, &rows, &loops, &branches,
    ))
}
```

- [ ] **Step 2: `report` 핸들러를 헬퍼로 교체**

`runs.rs:247-263`의 `report` 핸들러 본문을:
```rust
pub async fn report(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<crate::report::ReportJson>, ApiError> {
    Ok(Json(build_report_for_run(&state.db, &id).await?))
}
```

- [ ] **Step 3: 기존 테스트로 회귀 확인**

Run: `cargo test -p handicap-controller`
Expected: PASS (report e2e/단위 테스트가 헬퍼 경유로도 동일 결과 — 리팩터라 동작 불변).

- [ ] **Step 4: Commit**

```bash
git add crates/controller/src/api/runs.rs
git commit -m "refactor(controller): extract build_report_for_run helper (shared by export)"
```

---

## Task 3: 단일-run CSV 직렬화 (`report_to_csv`)

**Files:**
- Create: `crates/controller/src/export.rs`
- Modify: `crates/controller/src/lib.rs` (모듈 등록)
- Test: `crates/controller/src/export.rs` 내 `#[cfg(test)] mod tests`

- [ ] **Step 1: 모듈 등록 + 실패 테스트 작성**

`crates/controller/src/lib.rs`에 `pub mod export;` 추가.

`crates/controller/src/export.rs` 생성:
```rust
//! CSV/XLSX serialization of reports (single-run + N-run comparison).
//! Pure functions over `ReportJson` (built via build_report_for_run).
use crate::report::ReportJson;

/// Single-run CSV = the per-step headline table (fixed columns).
pub fn report_to_csv(report: &ReportJson) -> Vec<u8> {
    let mut w = csv::Writer::from_writer(Vec::new());
    w.write_record(["step_id", "count", "error_count", "p50_ms", "p95_ms", "p99_ms"])
        .expect("csv header");
    for s in &report.steps {
        w.write_record([
            s.step_id.as_str(),
            &s.count.to_string(),
            &s.error_count.to_string(),
            &s.p50_ms.to_string(),
            &s.p95_ms.to_string(),
            &s.p99_ms.to_string(),
        ])
        .expect("csv row");
    }
    w.into_inner().expect("csv flush")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::*;
    use std::collections::BTreeMap;

    fn step(id: &str, count: u64, p95: u64) -> ReportStep {
        ReportStep {
            step_id: id.into(), count, error_count: 0,
            status_counts: BTreeMap::new(),
            p50_ms: 1, p95_ms: p95, p99_ms: p95, loop_breakdown: vec![],
        }
    }
    fn report_with_steps(steps: Vec<ReportStep>) -> ReportJson {
        ReportJson {
            run: ReportRun { id: "r1".into(), scenario_id: "s1".into(),
                status: "completed".into(), profile: serde_json::Value::Null,
                env: serde_json::Value::Null, started_at: Some(0), ended_at: Some(1000),
                created_at: 0 },
            scenario_yaml: String::new(),
            summary: ReportSummary { count: 0, errors: 0, rps: 0.0, duration_seconds: 1,
                p50_ms: 0, p95_ms: 0, p99_ms: 0 },
            windows: vec![], steps, status_distribution: BTreeMap::new(),
            if_breakdown: vec![], verdict: None,
        }
    }

    #[test]
    fn csv_has_header_and_one_row_per_step() {
        let r = report_with_steps(vec![step("a", 10, 50), step("b", 20, 99)]);
        let csv = String::from_utf8(report_to_csv(&r)).unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "step_id,count,error_count,p50_ms,p95_ms,p99_ms");
        assert_eq!(lines.len(), 3); // header + 2 steps
        assert!(lines[1].starts_with("a,10,0,1,50,50"));
    }
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller export::tests::csv_has_header`
Expected: 컴파일 후 PASS (구현이 같은 커밋에 포함됨 — 인라인 `#[cfg(test)]`라 TDD-guard 자동 통과). 만약 RED가 필요하면 먼저 `report_to_csv` 본문을 `Vec::new()` 반환으로 두고 확인 후 채운다.

- [ ] **Step 3: 테스트 통과 확인**

Run: `cargo test -p handicap-controller export::`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add crates/controller/src/export.rs crates/controller/src/lib.rs
git commit -m "feat(controller): report_to_csv (single-run per-step CSV)"
```

---

## Task 4: 단일-run XLSX 직렬화 (`report_to_xlsx`) + calamine 라운드트립

**Files:**
- Modify: `crates/controller/src/export.rs`

- [ ] **Step 1: XLSX 직렬화 + 라운드트립 테스트 작성**

`export.rs`에 추가:
```rust
use rust_xlsxwriter::Workbook;

/// Single-run XLSX: Summary + Steps + Windows + Status (+ Branches if any).
pub fn report_to_xlsx(report: &ReportJson) -> Vec<u8> {
    let mut wb = Workbook::new();

    // --- Summary sheet ---
    let ws = wb.add_worksheet();
    ws.set_name("Summary").expect("sheet name");
    let s = &report.summary;
    let rows: [(&str, f64); 7] = [
        ("count", s.count as f64), ("errors", s.errors as f64), ("rps", s.rps),
        ("duration_seconds", s.duration_seconds as f64),
        ("p50_ms", s.p50_ms as f64), ("p95_ms", s.p95_ms as f64), ("p99_ms", s.p99_ms as f64),
    ];
    for (i, (k, v)) in rows.iter().enumerate() {
        ws.write_string(i as u32, 0, *k).expect("w");
        ws.write_number(i as u32, 1, *v).expect("w");
    }

    // --- Steps sheet ---
    let ws = wb.add_worksheet();
    ws.set_name("Steps").expect("sheet name");
    for (c, h) in ["step_id","count","error_count","p50_ms","p95_ms","p99_ms"].iter().enumerate() {
        ws.write_string(0, c as u16, *h).expect("w");
    }
    for (i, st) in report.steps.iter().enumerate() {
        let r = (i + 1) as u32;
        ws.write_string(r, 0, &st.step_id).expect("w");
        ws.write_number(r, 1, st.count as f64).expect("w");
        ws.write_number(r, 2, st.error_count as f64).expect("w");
        ws.write_number(r, 3, st.p50_ms as f64).expect("w");
        ws.write_number(r, 4, st.p95_ms as f64).expect("w");
        ws.write_number(r, 5, st.p99_ms as f64).expect("w");
    }

    // --- Windows sheet ---
    let ws = wb.add_worksheet();
    ws.set_name("Windows").expect("sheet name");
    for (c, h) in ["ts_second","step_id","count","error_count","p50_ms","p95_ms","p99_ms"].iter().enumerate() {
        ws.write_string(0, c as u16, *h).expect("w");
    }
    for (i, win) in report.windows.iter().enumerate() {
        let r = (i + 1) as u32;
        ws.write_number(r, 0, win.ts_second as f64).expect("w");
        ws.write_string(r, 1, &win.step_id).expect("w");
        ws.write_number(r, 2, win.count as f64).expect("w");
        ws.write_number(r, 3, win.error_count as f64).expect("w");
        ws.write_number(r, 4, win.p50_ms as f64).expect("w");
        ws.write_number(r, 5, win.p95_ms as f64).expect("w");
        ws.write_number(r, 6, win.p99_ms as f64).expect("w");
    }

    // --- Status sheet ---
    let ws = wb.add_worksheet();
    ws.set_name("Status").expect("sheet name");
    ws.write_string(0, 0, "status").expect("w");
    ws.write_string(0, 1, "count").expect("w");
    for (i, (k, v)) in report.status_distribution.iter().enumerate() {
        let r = (i + 1) as u32;
        ws.write_string(r, 0, k).expect("w");
        ws.write_number(r, 1, *v as f64).expect("w");
    }

    // --- Branches sheet (only if present) ---
    if !report.if_breakdown.is_empty() {
        let ws = wb.add_worksheet();
        ws.set_name("Branches").expect("sheet name");
        for (c, h) in ["step_id","branch","count"].iter().enumerate() {
            ws.write_string(0, c as u16, *h).expect("w");
        }
        let mut r = 1u32;
        for ib in &report.if_breakdown {
            for b in &ib.branches {
                ws.write_string(r, 0, &ib.step_id).expect("w");
                ws.write_string(r, 1, &b.branch).expect("w");
                ws.write_number(r, 2, b.count as f64).expect("w");
                r += 1;
            }
        }
    }

    wb.save_to_buffer().expect("xlsx buffer")
}
```

라운드트립 테스트(`#[cfg(test)] mod tests`에 추가, calamine 0.26 API는 controller CLAUDE.md 패턴):
```rust
#[test]
fn xlsx_roundtrips_summary_and_steps() {
    use calamine::{Reader, Xlsx, open_workbook_from_rs, Data};
    use std::io::Cursor;

    let mut r = report_with_steps(vec![step("a", 10, 50)]);
    r.summary.count = 123;
    let bytes = report_to_xlsx(&r);

    let mut wb: Xlsx<Cursor<Vec<u8>>> =
        open_workbook_from_rs(Cursor::new(bytes)).expect("read xlsx");
    let summary = wb.worksheet_range("Summary").expect("Summary sheet");
    // row 0 col1 = count value
    assert_eq!(summary.get_value((0, 1)), Some(&Data::Float(123.0)));
    let steps = wb.worksheet_range("Steps").expect("Steps sheet");
    assert_eq!(steps.get_value((1, 0)), Some(&Data::String("a".into())));
    assert_eq!(steps.get_value((1, 4)), Some(&Data::Float(50.0)));
}
```

- [ ] **Step 2: 테스트 실행**

Run: `cargo test -p handicap-controller export::tests::xlsx_roundtrips`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/controller/src/export.rs
git commit -m "feat(controller): report_to_xlsx multi-sheet + calamine round-trip test"
```

---

## Task 5: 단일-run export 라우트 배선

**Files:**
- Modify: `crates/controller/src/api/runs.rs` (핸들러 2개 + `file_response` 헬퍼)
- Modify: `crates/controller/src/app.rs:45` 근처 (라우트 2개)
- Test: `crates/controller/tests/export_routes_test.rs`

- [ ] **Step 1: 실패 테스트 작성**

`crates/controller/tests/export_routes_test.rs` 생성 (기존 `api_test.rs`의 `make_app`/`NoopDispatcher` 패턴 차용 — 그 파일에서 헬퍼 import 또는 복제):
```rust
// 사용 패턴은 crates/controller/tests/api_test.rs 참고:
//  - make_app() -> (Router, Db)  (NoopDispatcher 사용)
//  - tower::ServiceExt::oneshot 으로 요청
// 본 테스트는 completed run 하나를 만들고 run_metrics 한 행을 넣은 뒤
// GET /api/runs/{id}/report.csv 가 200 + text/csv + 헤더 포함을 단언.
#[tokio::test]
async fn single_run_csv_export_returns_csv() {
    // 1) make_app(); 2) seed scenario + completed run + 1 metric row
    //    (api_test.rs 의 seed 헬퍼 재사용);
    // 3) oneshot GET /api/runs/{id}/report.csv
    // 4) assert status 200, content-type starts_with "text/csv",
    //    content-disposition contains "attachment", body 첫 줄 == CSV 헤더.
}

#[tokio::test]
async fn export_of_nonterminal_run_is_rejected() {
    // pending/running run 에 대해 GET .../report.csv -> 400/409.
}
```
> 구현 메모: `api_test.rs`가 seed 헬퍼를 `pub`로 노출하지 않으면, 그 파일의 `make_app` + run-seed 로직을 이 테스트 파일로 복제한다(통합 테스트는 crate 외부라 `#[cfg(test)]` 공유 불가). 메트릭 행은 `crate`가 아니라 REST 경유가 어려우면 `handicap_controller::store::metrics::insert_batch`로 직접 1행 삽입.

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller --test export_routes_test`
Expected: FAIL (라우트 없음 → 404).

- [ ] **Step 3: `file_response` 헬퍼 + 핸들러 구현**

`runs.rs`에 추가:
```rust
fn file_response(content_type: &str, filename: &str, bytes: Vec<u8>) -> axum::response::Response {
    use axum::http::header;
    axum::response::Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(axum::body::Body::from(bytes))
        .expect("valid file response")
}

fn ensure_terminal(row: &runs::RunRow) -> Result<(), ApiError> {
    match row.status {
        runs::RunStatus::Completed | runs::RunStatus::Failed | runs::RunStatus::Aborted => Ok(()),
        _ => Err(ApiError::BadRequest(
            "run is not finished; export is available after a run completes".into(),
        )),
    }
}

pub async fn report_csv(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    ensure_terminal(&row)?;
    let report = build_report_for_run(&state.db, &id).await?;
    let bytes = crate::export::report_to_csv(&report);
    Ok(file_response("text/csv; charset=utf-8", &format!("run-{id}-report.csv"), bytes))
}

pub async fn report_xlsx(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    ensure_terminal(&row)?;
    let report = build_report_for_run(&state.db, &id).await?;
    let bytes = crate::export::report_to_xlsx(&report);
    Ok(file_response(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        &format!("run-{id}-report.xlsx"),
        bytes,
    ))
}
```
> `ApiError::BadRequest`가 없으면 `crates/controller/src/error.rs`에서 정확한 변형명 확인(레거시 400 변형). 없으면 `ApiError::Conflict`로 대체하고 메시지 유지.

- [ ] **Step 4: 라우트 등록**

`app.rs`의 `/runs/{id}/report` 줄(45) 아래 추가:
```rust
        .route("/runs/{id}/report.csv", get(runs_api::report_csv))
        .route("/runs/{id}/report.xlsx", get(runs_api::report_xlsx))
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cargo test -p handicap-controller --test export_routes_test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/controller/src/api/runs.rs crates/controller/src/app.rs crates/controller/tests/export_routes_test.rs
git commit -m "feat(controller): single-run report.csv/.xlsx export routes (terminal-gated)"
```

---

## Task 6: 비교 델타 계산(Rust) + 비교 CSV + 골든 fixture

**Files:**
- Create: `testdata/compare_golden.json`
- Modify: `crates/controller/src/export.rs` (`Polarity`, `delta`, `comparison_to_csv`)

- [ ] **Step 1: 공유 델타 + 비교 모델 구현**

`export.rs`에 추가:
```rust
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Polarity { Good, Bad, Neutral }

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Delta { pub pct: Option<f64>, pub polarity: Polarity }

/// lower_is_better 지표는 true. count/duration 은 중립(여기 안 옴 — 호출자가 제외).
fn delta(metric: &str, base: f64, val: f64) -> Delta {
    let lower_is_better = matches!(metric, "p50_ms" | "p95_ms" | "p99_ms" | "error_rate");
    let pct = if base == 0.0 { None } else { Some((val - base) / base) };
    let polarity = if val == base {
        Polarity::Neutral
    } else if (val < base) == lower_is_better {
        Polarity::Good
    } else {
        Polarity::Bad
    };
    Delta { pct, polarity }
}

/// 요약 지표 한 run 의 값 추출 (error_rate 는 분수).
fn summary_metric(s: &crate::report::ReportSummary, metric: &str) -> f64 {
    match metric {
        "p50_ms" => s.p50_ms as f64,
        "p95_ms" => s.p95_ms as f64,
        "p99_ms" => s.p99_ms as f64,
        "rps" => s.rps,
        "error_rate" => if s.count == 0 { 0.0 } else { s.errors as f64 / s.count as f64 },
        _ => 0.0,
    }
}

const SUMMARY_METRICS: [&str; 5] = ["p50_ms", "p95_ms", "p99_ms", "rps", "error_rate"];

/// 비교 CSV = 요약 매트릭스. 열: metric, 각 run 값, 각 비-baseline run 의 delta_pct.
/// reports[0..] 순서대로, baseline 은 baseline_idx.
pub fn comparison_to_csv(reports: &[ReportJson], baseline_idx: usize) -> Vec<u8> {
    let mut w = csv::Writer::from_writer(Vec::new());
    let mut header = vec!["metric".to_string()];
    for (i, r) in reports.iter().enumerate() {
        header.push(if i == baseline_idx { format!("{} (base)", r.run.id) } else { r.run.id.clone() });
    }
    for (i, r) in reports.iter().enumerate() {
        if i != baseline_idx { header.push(format!("delta_pct {}", r.run.id)); }
    }
    w.write_record(&header).expect("hdr");

    for metric in SUMMARY_METRICS {
        let base = summary_metric(&reports[baseline_idx].summary, metric);
        let mut rec = vec![metric.to_string()];
        for r in reports {
            rec.push(summary_metric(&r.summary, metric).to_string());
        }
        for (i, r) in reports.iter().enumerate() {
            if i != baseline_idx {
                let d = delta(metric, base, summary_metric(&r.summary, metric));
                rec.push(d.pct.map(|p| format!("{p:.6}")).unwrap_or_default());
            }
        }
        w.write_record(&rec).expect("row");
    }
    w.into_inner().expect("flush")
}
```

- [ ] **Step 2: 골든 fixture 작성**

`testdata/compare_golden.json` 생성. `reports`는 최소 `Report` shape 2개(run.id 다름, summary 다름)를 직접 손으로 작성. 예: baseline summary `{p50_ms:9,p95_ms:152,p99_ms:240,rps:20400,count:10000,errors:10,...}`, candidate `{p50_ms:11,p95_ms:184,p99_ms:251,rps:19800,count:10000,errors:20,...}`. `expected.summary`에 각 metric의 `values`(2개)와 `deltas`(baseline=null, candidate={pct,polarity}) 기재 — **pct는 위 공식으로 손계산**(예 p95: (184-152)/152=0.21052631578…, polarity bad).
> 정확한 `Report` JSON 키는 `report.rs`의 직렬화(snake_case)와 `schemas.ts`의 `ReportSchema`를 따른다. `windows`/`steps`/`status_distribution`은 `[]`/`{}`로 둬도 요약 비교엔 무관.

- [ ] **Step 3: 골든 크로스체크 테스트(Rust 측)**

`export.rs` tests에 추가:
```rust
#[test]
fn golden_summary_deltas_match() {
    #[derive(serde::Deserialize)]
    struct Golden { reports: Vec<ReportJson>, baseline_id: String,
        expected: serde_json::Value }
    let g: Golden = serde_json::from_str(include_str!(
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../testdata/compare_golden.json")
    )).expect("golden parse");
    let base_idx = g.reports.iter().position(|r| r.run.id == g.baseline_id).unwrap();
    for row in g.expected["summary"].as_array().unwrap() {
        let metric = row["metric"].as_str().unwrap();
        let base = summary_metric(&g.reports[base_idx].summary, metric);
        for (i, r) in g.reports.iter().enumerate() {
            let exp = &row["deltas"][i];
            let d = delta(metric, base, summary_metric(&r.summary, metric));
            if exp.is_null() {
                assert_eq!(i, base_idx, "{metric}: null delta only for baseline");
            } else {
                let exp_pct = exp["pct"].as_f64().unwrap();
                assert!((d.pct.unwrap() - exp_pct).abs() < 1e-9, "{metric} pct");
                assert_eq!(format!("{:?}", d.polarity).to_lowercase(), exp["polarity"].as_str().unwrap());
            }
        }
    }
}
```

- [ ] **Step 4: 테스트 실행**

Run: `cargo test -p handicap-controller export::tests::golden_summary_deltas_match`
Expected: PASS (손계산 expected와 일치).

- [ ] **Step 5: Commit**

```bash
git add testdata/compare_golden.json crates/controller/src/export.rs
git commit -m "feat(controller): comparison delta + comparison_to_csv + shared golden fixture"
```

---

## Task 7: 비교 XLSX 직렬화 + 라운드트립

**Files:**
- Modify: `crates/controller/src/export.rs`

- [ ] **Step 1: `comparison_to_xlsx` 구현 + 라운드트립 테스트**

`export.rs`에 추가 — 시트 `Summary`(요약 매트릭스: metric 행, run 값 열 + delta_pct 열), `Steps`(step_id 행 × run p95), `Status`, `Runs`(run 메타):
```rust
pub fn comparison_to_xlsx(reports: &[ReportJson], baseline_idx: usize) -> Vec<u8> {
    let mut wb = Workbook::new();

    // Summary: row0 = header(metric + run ids + delta cols), rows = metrics.
    let ws = wb.add_worksheet();
    ws.set_name("Summary").expect("name");
    ws.write_string(0, 0, "metric").expect("w");
    let mut col = 1u16;
    for (i, r) in reports.iter().enumerate() {
        let h = if i == baseline_idx { format!("{} (base)", r.run.id) } else { r.run.id.clone() };
        ws.write_string(0, col, &h).expect("w"); col += 1;
    }
    let delta_start = col;
    for (i, r) in reports.iter().enumerate() {
        if i != baseline_idx { ws.write_string(0, col, &format!("Δ% {}", r.run.id)).expect("w"); col += 1; }
    }
    for (ri, metric) in SUMMARY_METRICS.iter().enumerate() {
        let row = (ri + 1) as u32;
        ws.write_string(row, 0, *metric).expect("w");
        let base = summary_metric(&reports[baseline_idx].summary, metric);
        for (i, r) in reports.iter().enumerate() {
            ws.write_number(row, (1 + i) as u16, summary_metric(&r.summary, metric)).expect("w");
        }
        let mut dcol = delta_start;
        for (i, r) in reports.iter().enumerate() {
            if i != baseline_idx {
                if let Some(p) = delta(metric, base, summary_metric(&r.summary, metric)).pct {
                    ws.write_number(row, dcol, p).expect("w");
                }
                dcol += 1;
            }
        }
    }

    // Steps: union of step_ids (sorted), columns = run p95.
    let ws = wb.add_worksheet();
    ws.set_name("Steps").expect("name");
    ws.write_string(0, 0, "step_id").expect("w");
    for (i, r) in reports.iter().enumerate() {
        ws.write_string(0, (1 + i) as u16, &r.run.id).expect("w");
    }
    let mut step_ids: Vec<String> = reports.iter()
        .flat_map(|r| r.steps.iter().map(|s| s.step_id.clone())).collect();
    step_ids.sort(); step_ids.dedup();
    for (ri, sid) in step_ids.iter().enumerate() {
        let row = (ri + 1) as u32;
        ws.write_string(row, 0, sid).expect("w");
        for (i, r) in reports.iter().enumerate() {
            if let Some(st) = r.steps.iter().find(|s| &s.step_id == sid) {
                ws.write_number(row, (1 + i) as u16, st.p95_ms as f64).expect("w");
            }
        }
    }

    // Runs meta: id, status, started_at, ended_at, count.
    let ws = wb.add_worksheet();
    ws.set_name("Runs").expect("name");
    for (c, h) in ["run_id","status","started_at","ended_at","count"].iter().enumerate() {
        ws.write_string(0, c as u16, *h).expect("w");
    }
    for (i, r) in reports.iter().enumerate() {
        let row = (i + 1) as u32;
        ws.write_string(row, 0, &r.run.id).expect("w");
        ws.write_string(row, 1, &r.run.status).expect("w");
        ws.write_number(row, 2, r.run.started_at.unwrap_or(0) as f64).expect("w");
        ws.write_number(row, 3, r.run.ended_at.unwrap_or(0) as f64).expect("w");
        ws.write_number(row, 4, r.summary.count as f64).expect("w");
    }

    wb.save_to_buffer().expect("xlsx")
}
```
테스트:
```rust
#[test]
fn comparison_xlsx_roundtrips() {
    use calamine::{Reader, Xlsx, open_workbook_from_rs, Data};
    use std::io::Cursor;
    let mut a = report_with_steps(vec![step("s", 1, 100)]);
    a.run.id = "A".into(); a.summary.p95_ms = 100;
    let mut b = report_with_steps(vec![step("s", 1, 150)]);
    b.run.id = "B".into(); b.summary.p95_ms = 150;
    let bytes = comparison_to_xlsx(&[a, b], 0);
    let mut wb: Xlsx<Cursor<Vec<u8>>> = open_workbook_from_rs(Cursor::new(bytes)).unwrap();
    let sum = wb.worksheet_range("Summary").unwrap();
    // metric col0 of p95 row should be "p95_ms"; base value 100, candidate 150.
    // (정확한 행 인덱스는 SUMMARY_METRICS 순서로 계산: p95_ms = index 1 → row 2)
    assert_eq!(sum.get_value((2, 1)), Some(&Data::Float(100.0)));
    assert_eq!(sum.get_value((2, 2)), Some(&Data::Float(150.0)));
}
```

- [ ] **Step 2: 테스트 실행**

Run: `cargo test -p handicap-controller export::tests::comparison_xlsx_roundtrips`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/controller/src/export.rs
git commit -m "feat(controller): comparison_to_xlsx (Summary/Steps/Runs sheets) + round-trip"
```

---

## Task 8: 비교 export 라우트 + run_ids 검증

**Files:**
- Modify: `crates/controller/src/api/runs.rs` (비교 핸들러 2개 + 검증)
- Modify: `crates/controller/src/app.rs` (라우트 2개, 시나리오 하위)
- Test: `crates/controller/tests/export_routes_test.rs`

- [ ] **Step 1: 실패 테스트 추가**

`export_routes_test.rs`에 추가:
```rust
#[tokio::test]
async fn comparison_csv_validates_and_returns() {
    // seed scenario S with 2 completed runs (메트릭 각 1행);
    // GET /api/scenarios/{S}/runs/compare.csv?run_ids=A,B&baseline=A -> 200 text/csv,
    //   첫 줄에 "metric" + "A (base)" + "B" 포함.
    // GET ...?run_ids=A,X&baseline=A  (X 가 다른 시나리오/없음) -> 400.
    // GET ...?run_ids=A&baseline=A    (1개) -> 400 (비교는 2개 이상).
    // GET ...?run_ids=A,B&baseline=Z  (baseline 미포함) -> 400.
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller --test export_routes_test comparison_csv`
Expected: FAIL (라우트 없음).

- [ ] **Step 3: 핸들러 구현**

`runs.rs`에 추가:
```rust
#[derive(serde::Deserialize)]
pub struct CompareParams { pub run_ids: String, pub baseline: String }

const MAX_COMPARE_RUNS: usize = 50;

/// 검증된 (reports, baseline_idx) 반환. run_ids 는 콤마 구분, 순서 보존.
async fn resolve_comparison(
    state: &AppState, scenario_id: &str, params: &CompareParams,
) -> Result<(Vec<crate::report::ReportJson>, usize), ApiError> {
    let _ = scenarios::get(&state.db, scenario_id).await?.ok_or(ApiError::NotFound)?;
    let ids: Vec<String> = params.run_ids.split(',')
        .map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if ids.len() < 2 {
        return Err(ApiError::BadRequest("comparison needs at least 2 runs".into()));
    }
    if ids.len() > MAX_COMPARE_RUNS {
        return Err(ApiError::BadRequest(format!("at most {MAX_COMPARE_RUNS} runs")));
    }
    let baseline_idx = ids.iter().position(|id| id == &params.baseline)
        .ok_or_else(|| ApiError::BadRequest("baseline must be one of run_ids".into()))?;
    let mut reports = Vec::with_capacity(ids.len());
    for id in &ids {
        let row = runs::get(&state.db, id).await?.ok_or(ApiError::NotFound)?;
        if row.scenario_id != scenario_id {
            return Err(ApiError::BadRequest(format!("run {id} is not in this scenario")));
        }
        ensure_terminal(&row)?;
        reports.push(build_report_for_run(&state.db, id).await?);
    }
    Ok((reports, baseline_idx))
}

pub async fn compare_csv(
    State(state): State<AppState>,
    Path(scenario_id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<CompareParams>,
) -> Result<axum::response::Response, ApiError> {
    let (reports, base) = resolve_comparison(&state, &scenario_id, &params).await?;
    let bytes = crate::export::comparison_to_csv(&reports, base);
    Ok(file_response("text/csv; charset=utf-8", "comparison.csv", bytes))
}

pub async fn compare_xlsx(
    State(state): State<AppState>,
    Path(scenario_id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<CompareParams>,
) -> Result<axum::response::Response, ApiError> {
    let (reports, base) = resolve_comparison(&state, &scenario_id, &params).await?;
    let bytes = crate::export::comparison_to_xlsx(&reports, base);
    Ok(file_response(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "comparison.xlsx", bytes,
    ))
}
```

- [ ] **Step 4: 라우트 등록**

`app.rs`의 `/scenarios/{id}/runs` 줄(41) 아래 추가:
```rust
        .route("/scenarios/{id}/runs/compare.csv", get(runs_api::compare_csv))
        .route("/scenarios/{id}/runs/compare.xlsx", get(runs_api::compare_xlsx))
```
> 주의: `Path` 추출 이름은 라우트 `{id}`와 일치해야 하므로 핸들러 시그니처에서 `Path(scenario_id)`로 받되 라우트는 `{id}`. axum은 이름이 아니라 위치로 바인딩하므로 단일 path param이면 OK.

- [ ] **Step 5: 테스트 통과 확인**

Run: `cargo test -p handicap-controller --test export_routes_test`
Expected: PASS (모든 검증 케이스).

- [ ] **Step 6: Commit**

```bash
git add crates/controller/src/api/runs.rs crates/controller/src/app.rs crates/controller/tests/export_routes_test.rs
git commit -m "feat(controller): comparison export routes (scenario-scoped, validated)"
```

---

## Task 9: `compareReports` 순수 함수(TS) + 골든 크로스체크

**Files:**
- Create: `ui/src/compare/compareReports.ts`
- Test: `ui/src/compare/__tests__/compareReports.test.ts`

- [ ] **Step 1: 실패 테스트 작성(골든 + 단위)**

`ui/src/compare/__tests__/compareReports.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compareReports, computeDelta } from "../compareReports";

const golden = JSON.parse(
  readFileSync(new URL("../../../../testdata/compare_golden.json", import.meta.url), "utf8"),
);

describe("computeDelta (matches Rust §4.3)", () => {
  it("lower_is_better p95: increase = bad", () => {
    expect(computeDelta("p95_ms", 152, 184)).toEqual({
      pct: (184 - 152) / 152, polarity: "bad",
    });
  });
  it("higher_is_better rps: decrease = bad", () => {
    expect(computeDelta("rps", 20400, 19800).polarity).toBe("bad");
  });
  it("baseline 0 -> pct null", () => {
    expect(computeDelta("error_rate", 0, 0.01).pct).toBeNull();
  });
  it("equal -> neutral", () => {
    expect(computeDelta("p50_ms", 9, 9)).toEqual({ pct: 0, polarity: "neutral" });
  });
});

describe("golden cross-check vs Rust", () => {
  it("summary deltas match the shared fixture", () => {
    const baseIdx = golden.reports.findIndex(
      (r: { run: { id: string } }) => r.run.id === golden.baseline_id,
    );
    for (const row of golden.expected.summary) {
      const base = golden.reports[baseIdx].summary[row.metric === "error_rate" ? "errors" : row.metric];
      // error_rate 는 별도 계산 — computeDelta 입력은 metric 값. 여기선 expected.deltas 와 직접 비교:
      row.deltas.forEach((exp: null | { pct: number; polarity: string }, i: number) => {
        if (exp === null) { expect(i).toBe(baseIdx); return; }
        const result = compareReports(golden.reports, golden.baseline_id);
        const r = result.summary.find((m) => m.metric === row.metric)!;
        const cell = r.cells[i];
        expect(cell.delta!.pct).toBeCloseTo(exp.pct, 9);
        expect(cell.delta!.polarity).toBe(exp.polarity);
      });
    }
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test compareReports`
Expected: FAIL (`compareReports`/`computeDelta` 미정의).

- [ ] **Step 3: 구현**

`ui/src/compare/compareReports.ts`:
```ts
import type { Report } from "../api/schemas";

export type Polarity = "good" | "bad" | "neutral";
export type Delta = { pct: number | null; polarity: Polarity };
export type Cell = { value: number | null; delta: Delta | null };
export type CompareRow = { label: string; metric: string; cells: Cell[] };
export type CompareResult = {
  runIds: string[];
  baselineIdx: number;
  summary: CompareRow[];
  steps: CompareRow[];
  status: CompareRow[];
  verdict: { passed: (boolean | null)[] }; // run별 PASS/FAIL/없음
  stepMismatch: boolean;
};

const LOWER_IS_BETTER = new Set(["p50_ms", "p95_ms", "p99_ms", "error_rate"]);
const SUMMARY_METRICS = ["p50_ms", "p95_ms", "p99_ms", "rps", "error_rate"] as const;

export function computeDelta(metric: string, base: number, val: number): Delta {
  const pct = base === 0 ? null : (val - base) / base;
  let polarity: Polarity;
  if (val === base) polarity = "neutral";
  else polarity = (val < base) === LOWER_IS_BETTER.has(metric) ? "good" : "bad";
  return { pct, polarity };
}

function summaryValue(r: Report, metric: string): number {
  const s = r.summary;
  if (metric === "error_rate") return s.count === 0 ? 0 : s.errors / s.count;
  return (s as unknown as Record<string, number>)[metric];
}

export function compareReports(reports: Report[], baselineId: string): CompareResult {
  const runIds = reports.map((r) => r.run.id);
  const baselineIdx = Math.max(0, runIds.indexOf(baselineId));

  const summary: CompareRow[] = SUMMARY_METRICS.map((metric) => {
    const base = summaryValue(reports[baselineIdx], metric);
    return {
      label: metric, metric,
      cells: reports.map((r, i) => {
        const value = summaryValue(r, metric);
        return { value, delta: i === baselineIdx ? null : computeDelta(metric, base, value) };
      }),
    };
  });

  // steps: union of step_ids, metric = p95_ms
  const stepIds = Array.from(
    new Set(reports.flatMap((r) => r.steps.map((s) => s.step_id))),
  ).sort();
  const steps: CompareRow[] = stepIds.map((sid) => {
    const baseStep = reports[baselineIdx].steps.find((s) => s.step_id === sid);
    const base = baseStep ? baseStep.p95_ms : null;
    return {
      label: sid, metric: "p95_ms",
      cells: reports.map((r, i) => {
        const st = r.steps.find((s) => s.step_id === sid);
        const value = st ? st.p95_ms : null;
        if (i === baselineIdx || value === null || base === null) {
          return { value, delta: null };
        }
        return { value, delta: computeDelta("p95_ms", base, value) };
      }),
    };
  });

  // status: union of status keys, value = count (neutral, no delta polarity)
  const statusKeys = Array.from(
    new Set(reports.flatMap((r) => Object.keys(r.status_distribution))),
  ).sort();
  const status: CompareRow[] = statusKeys.map((k) => ({
    label: k, metric: "status",
    cells: reports.map((r) => ({ value: r.status_distribution[k] ?? 0, delta: null })),
  }));

  const verdict = {
    passed: reports.map((r) => (r.verdict ? r.verdict.passed : null)),
  };

  // step mismatch: union != intersection of step_id sets
  const sets = reports.map((r) => new Set(r.steps.map((s) => s.step_id)));
  const union = new Set(sets.flatMap((s) => [...s]));
  const intersection = [...union].filter((id) => sets.every((s) => s.has(id)));
  const stepMismatch = intersection.length !== union.size;

  return { runIds, baselineIdx, summary, steps, status, verdict, stepMismatch };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test compareReports`
Expected: PASS. 그다음 `pnpm build`로 타입 확인.

- [ ] **Step 5: Commit**

```bash
git add ui/src/compare/compareReports.ts ui/src/compare/__tests__/compareReports.test.ts
git commit -m "feat(ui): compareReports pure fn + golden cross-check vs Rust"
```

---

## Task 10: `<CompareMatrix>` 프레젠테이셔널 컴포넌트

**Files:**
- Create: `ui/src/components/compare/CompareMatrix.tsx`
- Test: `ui/src/components/compare/__tests__/CompareMatrix.test.tsx`

- [ ] **Step 1: 실패 테스트 작성**

`CompareMatrix.test.tsx` — `compareReports`로 만든 `CompareResult`(+ run 라벨 맵)를 넘겨 ① 요약/스텝/status 3 섹션 렌더, ② baseline 헤더 클릭 시 `onBaselineChange(runId)` 호출, ③ `stepMismatch=true`면 배너(role="status" 또는 텍스트 "일부만 비교") 노출, ④ Δ 셀에 polarity 클래스/▲▼ 기호 표시를 단언.
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompareMatrix } from "../CompareMatrix";
import type { CompareResult } from "../../../compare/compareReports";

const result: CompareResult = {
  runIds: ["A", "B"], baselineIdx: 0,
  summary: [{ label: "p95_ms", metric: "p95_ms", cells: [
    { value: 152, delta: null }, { value: 184, delta: { pct: 0.21, polarity: "bad" } }] }],
  steps: [], status: [],
  verdict: { passed: [true, false] }, stepMismatch: true,
};

it("renders sections, fires baseline change, shows mismatch banner", async () => {
  const user = userEvent.setup();
  const onBaselineChange = vi.fn();
  render(<CompareMatrix result={result} labels={{ A: "#A", B: "#B" }} onBaselineChange={onBaselineChange} />);
  expect(screen.getByText("p95_ms")).toBeInTheDocument();
  expect(screen.getByText(/일부만 비교/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /#B/ }));
  expect(onBaselineChange).toHaveBeenCalledWith("B");
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test CompareMatrix`
Expected: FAIL.

- [ ] **Step 3: 구현**

`CompareMatrix.tsx` — 순수 렌더러(데이터 fetch 없음). props: `{ result: CompareResult; labels: Record<string,string>; onBaselineChange: (runId: string) => void }`. 섹션 3개를 같은 `<Section>` 헬퍼로 렌더, 헤더는 `<button onClick={() => onBaselineChange(runId)}>`(baseline은 "(base)" 뱃지), Δ 셀은 `pct`를 `%`로 포맷 + polarity 색(`text-red-600`/`text-green-600`/`text-slate-500`) + 기호(bad=▲ 또는 값방향, good=▼). `pct===null`이면 value>0 → "신규", ==0 → "동일". verdict 행은 `passed` 배열을 PASS/FAIL/"—"로. mismatch면 상단 `<p role="status">스텝 구성이 달라 일부만 비교</p>`.
> a11y: 색 단독 금지 — ▲▼ 기호 동반(ui/CLAUDE.md). fieldset/그리드 폭 함정(`min-w-0`)은 표라 무관하나, 긴 step_id는 `truncate` 대신 `break-all` 또는 `title`.

- [ ] **Step 4: 테스트 통과 + 빌드**

Run: `cd ui && pnpm test CompareMatrix && pnpm build`
Expected: PASS + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/compare/CompareMatrix.tsx ui/src/components/compare/__tests__/CompareMatrix.test.tsx
git commit -m "feat(ui): CompareMatrix presentational component"
```

---

## Task 11: byte-blob 다운로드 헬퍼 + export URL 빌더 (I2)

**Files:**
- Create: `ui/src/api/download.ts`
- Modify: `ui/src/api/client.ts` (`api` export URL 빌더)
- Test: `ui/src/api/__tests__/download.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`download.test.ts` — `downloadFile(url, filename)`가 ① `fetch` 200 시 blob→picker/anchor로 저장(picker 폴리필 mock), ② `fetch` 4xx 시 `ApiError`(서버 `{error}` 본문 메시지)로 throw 함을 단언. (jsdom `URL.createObjectURL`/`showSaveFilePicker` 폴리필은 `test/setup.ts` 패턴 재사용.)

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test download`
Expected: FAIL.

- [ ] **Step 3: 구현**

`ui/src/api/download.ts` — `DownloadJsonButton`의 picker/blob 패턴을 **bytes(Blob)** 용으로 일반화:
```ts
import { ApiError } from "./client";
import { ApiErrorSchema } from "./schemas";

export async function downloadFile(url: string, filename: string, mime: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    let msg = text;
    try { msg = ApiErrorSchema.parse(JSON.parse(text)).error; } catch { /* raw */ }
    throw new ApiError(resp.status, msg || `${resp.status} ${resp.statusText}`);
  }
  const blob = await resp.blob();
  await saveBlob(blob, filename, mime);
}
// saveBlob: showSaveFilePicker 우선, 실패 시 anchor+createObjectURL (DownloadJsonButton 패턴 복제)
```
`client.ts`의 `api` 객체에 URL 빌더 추가(쿼리 인코딩):
```ts
  reportCsvUrl: (runId: string) => `${BASE}/runs/${encodeURIComponent(runId)}/report.csv`,
  reportXlsxUrl: (runId: string) => `${BASE}/runs/${encodeURIComponent(runId)}/report.xlsx`,
  compareCsvUrl: (scenarioId: string, runIds: string[], baseline: string) =>
    `${BASE}/scenarios/${encodeURIComponent(scenarioId)}/runs/compare.csv?run_ids=${runIds.map(encodeURIComponent).join(",")}&baseline=${encodeURIComponent(baseline)}`,
  compareXlsxUrl: (scenarioId: string, runIds: string[], baseline: string) =>
    `${BASE}/scenarios/${encodeURIComponent(scenarioId)}/runs/compare.xlsx?run_ids=${runIds.map(encodeURIComponent).join(",")}&baseline=${encodeURIComponent(baseline)}`,
```
> `BASE`는 `client.ts`의 `/api`. URL 빌더는 `request`를 안 거치므로 `BASE`를 그대로 붙인다.

- [ ] **Step 4: 테스트 통과 + 빌드**

Run: `cd ui && pnpm test download && pnpm build`
Expected: PASS + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/download.ts ui/src/api/client.ts ui/src/api/__tests__/download.test.ts
git commit -m "feat(ui): downloadFile (fetch->blob, surfaces 4xx) + export URL builders"
```

---

## Task 12: `ScenarioComparePage` + 라우트

**Files:**
- Create: `ui/src/pages/ScenarioComparePage.tsx`
- Modify: `ui/src/routes.tsx`
- Modify: `ui/src/api/hooks.ts` (N개 report fetch 훅)
- Test: `ui/src/pages/__tests__/ScenarioComparePage.test.tsx`

- [ ] **Step 1: 실패 테스트 작성**

`ScenarioComparePage.test.tsx` — `?runs=A,B&baseline=A` 쿼리로 마운트, `api`를 mock해 두 Report를 주고, `<CompareMatrix>`가 렌더되고 CSV/XLSX export 버튼이 있는지, export 버튼 클릭 시 `downloadFile`이 `compareCsvUrl(...)`로 호출되는지 단언. (React Query는 `QueryClientProvider` 래핑 + `MemoryRouter` initialEntries.)

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test ScenarioComparePage`
Expected: FAIL.

- [ ] **Step 3: 다중 report 훅 + 페이지 구현**

`hooks.ts`에 추가:
```ts
export function useReports(runIds: string[]) {
  return useQueries({
    queries: runIds.map((id) => ({
      queryKey: ["report", id],
      queryFn: () => api.getReport(id),
      staleTime: Infinity,
      refetchInterval: false as const,
    })),
  });
}
```
> `api.getReport`가 없으면 추가: `getReport: (id) => request(\`/runs/${encodeURIComponent(id)}/report\`, {method:"GET"}, ReportSchema)`. `useQueries`는 `@tanstack/react-query`.

`ScenarioComparePage.tsx` — `useParams`로 scenarioId, `useSearchParams`로 `runs`(콤마분리)·`baseline`. `useReports(runIds)`로 N개 fetch → 전부 success면 `compareReports(reports, baseline)` 메모 → `<CompareMatrix onBaselineChange={(id)=>setSearchParams({runs, baseline:id})}>`. 헤더에 CSV/XLSX 버튼(`onClick={() => downloadFile(api.compareCsvUrl(scenarioId, runIds, baseline), "comparison.csv", "text/csv").catch(setErr)}`). 라벨 맵은 baseline run의 `scenario_yaml`을 `parseScenarioDoc`→`findStepById`로 step_id→표시명(TestRunPanel/ReportView 패턴), run 칼럼 라벨은 `#<짧은 id>` + created_at. 로딩/에러는 `role="status"`/`role="alert"`.

- [ ] **Step 4: 라우트 등록**

`routes.tsx` children에 추가(`scenarios/:id/runs` 아래):
```tsx
      { path: "scenarios/:id/compare", element: <ScenarioComparePage /> },
```
import도 추가.

- [ ] **Step 5: 테스트 통과 + 빌드**

Run: `cd ui && pnpm test ScenarioComparePage && pnpm build`
Expected: PASS + tsc clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/ScenarioComparePage.tsx ui/src/routes.tsx ui/src/api/hooks.ts ui/src/pages/__tests__/ScenarioComparePage.test.tsx
git commit -m "feat(ui): ScenarioComparePage (fetch N reports, render CompareMatrix, export)"
```

---

## Task 13: `ScenarioRunsPage` 선택 UI

**Files:**
- Modify: `ui/src/pages/ScenarioRunsPage.tsx`
- Test: `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx` (없으면 생성)

- [ ] **Step 1: 실패 테스트 작성**

테스트 — runs 목록(완료 2 + running 1)을 mock해 ① running 행 체크박스 `disabled`, ② 2개 체크 후 "비교 (2)" 버튼 활성·클릭 시 `/scenarios/{id}/compare?runs=...&baseline=...`로 navigate, ③ 6개 체크 시 "화면 5개까지" 안내 + 비교 버튼 비활성(또는 export 안내), ④ 50개 초과 가드 단언.

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test ScenarioRunsPage`
Expected: FAIL.

- [ ] **Step 3: 구현**

`ScenarioRunsPage.tsx` — `selectedIds: Set<string>` state. 각 행 첫 칸에 체크박스(`disabled={!isTerminal(r.status)}`, `isTerminal = ["completed","failed","aborted"].includes(status)`). 헤더에 "비교 (N)" 버튼: `N>=2 && N<=5`면 `navigate(\`/scenarios/${id}/compare?runs=${[...selected].join(",")}&baseline=${[...selected][0]}\`)`; `N>5 && N<=50`면 export 안내(비교 export URL은 화면 상한 무관 — "5개 초과: export로 보기" + XLSX 버튼); `N>50`이면 비활성+"최대 50개". baseline 기본 = 선택 중 가장 오래된(목록은 최신순일 수 있으니 created_at 최소). 기존 "다시 실행/즉시 재실행/view" 칼럼·`?retry=` 로직은 보존.
> 함정: 기존 effect deps(`react-hooks/exhaustive-deps`) 깨지 말 것 — `pnpm lint` 통과 필수(ui/CLAUDE.md).

- [ ] **Step 4: 테스트 통과 + 빌드 + 린트**

Run: `cd ui && pnpm test ScenarioRunsPage && pnpm lint && pnpm build`
Expected: PASS + 0 warnings + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/ScenarioRunsPage.tsx ui/src/pages/__tests__/ScenarioRunsPage.test.tsx
git commit -m "feat(ui): run selection + compare entry on ScenarioRunsPage"
```

---

## Task 14: 단일-run 리포트 export 버튼

**Files:**
- Modify: `ui/src/components/report/ReportView.tsx`
- Test: `ui/src/components/report/__tests__/ReportView.test.tsx`

- [ ] **Step 1: 실패 테스트 추가**

기존 `ReportView.test.tsx`에 추가 — CSV/XLSX 버튼 존재 + 클릭 시 `downloadFile`이 `api.reportCsvUrl(run.id)`/`reportXlsxUrl(run.id)`로 호출됨을 단언(`downloadFile` mock).

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test ReportView`
Expected: FAIL (버튼 없음).

- [ ] **Step 3: 구현**

`ReportView.tsx` — 기존 `<DownloadJsonButton>` 옆에 "Download CSV"/"Download XLSX" 버튼 추가:
```tsx
<button type="button" onClick={() =>
  downloadFile(api.reportCsvUrl(report.run.id), `run-${report.run.id}-report.csv`, "text/csv").catch((e) => setDlErr((e as Error).message))
} className="...">Download CSV</button>
```
(XLSX 동일, mime = spreadsheetml). 에러는 기존 패턴대로 `role="alert"` 배너.

- [ ] **Step 4: 테스트 통과 + 빌드**

Run: `cd ui && pnpm test ReportView && pnpm build`
Expected: PASS + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/report/ReportView.tsx ui/src/components/report/__tests__/ReportView.test.tsx
git commit -m "feat(ui): CSV/XLSX download buttons on single-run report"
```

---

## Task 15: 문서 — ADR-0030 + CLAUDE.md + 로드맵

**Files:**
- Create: `docs/adr/0030-run-comparison-report-export.md`
- Modify: `CLAUDE.md` ("알아둘 결정들" + 상태 한 줄)
- Modify: `crates/controller/CLAUDE.md` (export.rs/route 함정), `ui/CLAUDE.md` (compare/download 함정)
- Modify: `docs/roadmap.md` (§A4 A4b 완료 표시, §B 연기 항목)

- [ ] **Step 1: ADR-0030 작성 (MADR 포맷)**

결정: 하이브리드(클라 비교 / 서버 export), 같은-시나리오·terminal-only, N 상한 5(설정화 연기), CSV=1표/XLSX=멀티시트, 델타 공식 골든 fixture 교차검증, 엔진·proto·마이그레이션 무변경.

- [ ] **Step 2: 루트 CLAUDE.md 갱신**

"알아둘 결정들"에 `- **0030** Run 비교 + 리포트 export: 하이브리드(클라 비교/서버 CSV·XLSX), same-scenario terminal-only, N≤5 화면·>5 export, 골든 fixture 델타 패리티, 엔진/proto/마이그레이션 무변경` 한 줄 + 상태 줄에 A4b 완료 추가.

- [ ] **Step 3: 도메인 CLAUDE.md 갱신**

`crates/controller/CLAUDE.md`: `rust_xlsxwriter` dev→prod dep 함정, calamine 라운드트립 테스트 패턴, 비교 export 라우트의 시나리오-하위 배치(=`{id}` 충돌 회피), `build_report_for_run` 공유 헬퍼.
`ui/CLAUDE.md`: `compareReports` 골든 패리티, `downloadFile`(fetch→blob, 4xx 배너) vs `DownloadJsonButton`(JSON 전용) 구분, ScenarioRunsPage 선택 게이트(terminal/5/50).

- [ ] **Step 4: 로드맵 갱신**

`docs/roadmap.md` §A4에 A4b "✅ 완료" + 연기(D 히스토그램·C 트랜잭션분해·per-second 오버레이·N 상한 설정화·크로스시나리오)를 §B 신규 항목으로.

- [ ] **Step 5: Commit (docs-only — cargo 훅 skip)**

```bash
git add docs/adr/0030-run-comparison-report-export.md CLAUDE.md crates/controller/CLAUDE.md ui/CLAUDE.md docs/roadmap.md
git commit -m "docs: ADR-0030 + gotchas + roadmap close for A4b run comparison + export"
```

---

## Self-Review 체크 (작성자 기록)

- **Spec 커버리지**: §4(비교 모델/델타)→T6,T9; §5(비교 UI)→T10,T12,T13; §6(export 라우트/시트)→T3–T8; §7(엣지: 비-terminal/스텝불일치/0-base/verdict)→T5,T6,T8,T9,T10; §9(테스트: 골든 크로스체크·calamine 라운드트립)→T4,T6,T7,T9; C1→T1; M1→T2; I2→T11; §8 와이어 무변경(Report 재사용)→T9,T12.
- **타입 일관성**: `Delta{pct,polarity}`·`Cell{value,delta}`·`CompareRow`·`CompareResult`가 T9에서 정의되고 T10/T12에서 동일 사용. Rust `Delta{pct:Option<f64>,polarity:Polarity}`(T6)와 TS `Delta{pct:number|null,polarity}`(T9) 1:1. `SUMMARY_METRICS` 순서 양쪽 동일(p50,p95,p99,rps,error_rate).
- **placeholder 없음**: 모든 코드 step에 실제 코드/시그니처. UI 컴포넌트 일부는 구조+핵심 로직 명시(구현자가 JSX 살 채움) — 인터페이스·테스트는 구체.
- **TDD-guard**: Rust 인라인 `#[cfg(test)]`(T3·T4·T6·T7)는 자동 통과, 통합 테스트 파일(T5·T8)은 test-path라 통과. UI는 각 task Step1이 `*.test.ts(x)` 먼저 생성.
