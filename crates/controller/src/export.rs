//! CSV/XLSX serialization of reports (single-run + N-run comparison).
//! Pure functions over `ReportJson` (built via build_report_for_run).
use crate::report::ReportJson;
use rust_xlsxwriter::{Workbook, Worksheet};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Polarity {
    Good,
    Bad,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Delta {
    pub pct: Option<f64>,
    pub polarity: Polarity,
}

/// lower_is_better metrics return true. count/duration are neutral (caller excludes them).
fn delta(metric: &str, base: f64, val: f64) -> Delta {
    let lower_is_better = matches!(metric, "p50_ms" | "p95_ms" | "p99_ms" | "error_rate");
    let pct = if base == 0.0 {
        None
    } else {
        Some((val - base) / base)
    };
    let polarity = if val == base {
        Polarity::Neutral
    } else if (val < base) == lower_is_better {
        Polarity::Good
    } else {
        Polarity::Bad
    };
    Delta { pct, polarity }
}

/// Extract one summary metric's value from a run (error_rate is a fraction).
fn summary_metric(s: &crate::report::ReportSummary, metric: &str) -> f64 {
    match metric {
        "p50_ms" => s.p50_ms as f64,
        "p95_ms" => s.p95_ms as f64,
        "p99_ms" => s.p99_ms as f64,
        "rps" => s.rps,
        "error_rate" => {
            if s.count == 0 {
                0.0
            } else {
                s.errors as f64 / s.count as f64
            }
        }
        _ => 0.0,
    }
}

const SUMMARY_METRICS: [&str; 5] = ["p50_ms", "p95_ms", "p99_ms", "rps", "error_rate"];

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
fn write_insight_xlsx_row(
    ws: &mut Worksheet,
    row: u32,
    col_offset: u16,
    ins: &crate::insights::Insight,
) {
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

/// Comparison CSV = summary matrix. Columns: metric, each run's value, each
/// non-baseline run's delta_pct. Rows in SUMMARY_METRICS order.
pub fn comparison_to_csv(reports: &[ReportJson], baseline_idx: usize) -> Vec<u8> {
    let mut w = csv::Writer::from_writer(Vec::new());
    let mut header = vec!["metric".to_string()];
    for (i, r) in reports.iter().enumerate() {
        header.push(if i == baseline_idx {
            format!("{} (base)", r.run.id)
        } else {
            r.run.id.clone()
        });
    }
    for (i, r) in reports.iter().enumerate() {
        if i != baseline_idx {
            header.push(format!("delta_pct {}", r.run.id));
        }
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

/// Single-run CSV = the per-step headline table (fixed columns).
pub fn report_to_csv(report: &ReportJson) -> Vec<u8> {
    let mut w = csv::Writer::from_writer(Vec::new());
    w.write_record([
        "step_id",
        "count",
        "error_count",
        "p50_ms",
        "p95_ms",
        "p99_ms",
    ])
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

/// Multi-run comparison XLSX: Summary + Steps + Runs sheets.
pub fn comparison_to_xlsx(reports: &[ReportJson], baseline_idx: usize) -> Vec<u8> {
    let mut wb = Workbook::new();

    // Summary: row0 = header(metric + run ids + delta cols), rows = metrics.
    let ws = wb.add_worksheet();
    ws.set_name("Summary").expect("name");
    ws.write_string(0, 0, "metric").expect("w");
    let mut col = 1u16;
    for (i, r) in reports.iter().enumerate() {
        let h = if i == baseline_idx {
            format!("{} (base)", r.run.id)
        } else {
            r.run.id.clone()
        };
        ws.write_string(0, col, &h).expect("w");
        col += 1;
    }
    let delta_start = col;
    for (i, r) in reports.iter().enumerate() {
        if i != baseline_idx {
            ws.write_string(0, col, format!("\u{0394}% {}", r.run.id))
                .expect("w");
            col += 1;
        }
    }
    for (ri, metric) in SUMMARY_METRICS.iter().enumerate() {
        let row = (ri + 1) as u32;
        ws.write_string(row, 0, *metric).expect("w");
        let base = summary_metric(&reports[baseline_idx].summary, metric);
        for (i, r) in reports.iter().enumerate() {
            ws.write_number(row, (1 + i) as u16, summary_metric(&r.summary, metric))
                .expect("w");
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
    let mut step_ids: Vec<String> = reports
        .iter()
        .flat_map(|r| r.steps.iter().map(|s| s.step_id.clone()))
        .collect();
    step_ids.sort();
    step_ids.dedup();
    for (ri, sid) in step_ids.iter().enumerate() {
        let row = (ri + 1) as u32;
        ws.write_string(row, 0, sid).expect("w");
        for (i, r) in reports.iter().enumerate() {
            if let Some(st) = r.steps.iter().find(|s| &s.step_id == sid) {
                ws.write_number(row, (1 + i) as u16, st.p95_ms as f64)
                    .expect("w");
            }
        }
    }

    // Runs meta: id, status, started_at, ended_at, count.
    let ws = wb.add_worksheet();
    ws.set_name("Runs").expect("name");
    for (c, h) in ["run_id", "status", "started_at", "ended_at", "count"]
        .iter()
        .enumerate()
    {
        ws.write_string(0, c as u16, *h).expect("w");
    }
    for (i, r) in reports.iter().enumerate() {
        let row = (i + 1) as u32;
        ws.write_string(row, 0, &r.run.id).expect("w");
        ws.write_string(row, 1, &r.run.status).expect("w");
        ws.write_number(row, 2, r.run.started_at.unwrap_or(0) as f64)
            .expect("w");
        ws.write_number(row, 3, r.run.ended_at.unwrap_or(0) as f64)
            .expect("w");
        ws.write_number(row, 4, r.summary.count as f64).expect("w");
    }

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

    wb.save_to_buffer().expect("xlsx")
}

/// Single-run XLSX: Summary + Steps + Windows + Status (+ Branches if any).
pub fn report_to_xlsx(report: &ReportJson) -> Vec<u8> {
    let mut wb = Workbook::new();

    // --- Summary sheet ---
    let ws = wb.add_worksheet();
    ws.set_name("Summary").expect("sheet name");
    let s = &report.summary;
    let rows: [(&str, f64); 7] = [
        ("count", s.count as f64),
        ("errors", s.errors as f64),
        ("rps", s.rps),
        ("duration_seconds", s.duration_seconds as f64),
        ("p50_ms", s.p50_ms as f64),
        ("p95_ms", s.p95_ms as f64),
        ("p99_ms", s.p99_ms as f64),
    ];
    for (i, (k, v)) in rows.iter().enumerate() {
        ws.write_string(i as u32, 0, *k).expect("w");
        ws.write_number(i as u32, 1, *v).expect("w");
    }

    // --- Steps sheet ---
    let ws = wb.add_worksheet();
    ws.set_name("Steps").expect("sheet name");
    for (c, h) in [
        "step_id",
        "count",
        "error_count",
        "p50_ms",
        "p95_ms",
        "p99_ms",
    ]
    .iter()
    .enumerate()
    {
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
    for (c, h) in [
        "ts_second",
        "step_id",
        "count",
        "error_count",
        "p50_ms",
        "p95_ms",
        "p99_ms",
    ]
    .iter()
    .enumerate()
    {
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
        for (c, h) in ["step_id", "branch", "count"].iter().enumerate() {
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

    wb.save_to_buffer().expect("xlsx buffer")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::*;
    use std::collections::BTreeMap;

    fn step(id: &str, count: u64, p95: u64) -> ReportStep {
        ReportStep {
            step_id: id.into(),
            count,
            error_count: 0,
            status_counts: BTreeMap::new(),
            p50_ms: 1,
            p95_ms: p95,
            p99_ms: p95,
            loop_breakdown: vec![],
            download: None,
        }
    }

    pub fn report_with_steps(steps: Vec<ReportStep>) -> ReportJson {
        ReportJson {
            run: ReportRun {
                id: "r1".into(),
                scenario_id: "s1".into(),
                status: "completed".into(),
                profile: serde_json::Value::Null,
                env: serde_json::Value::Null,
                started_at: Some(0),
                ended_at: Some(1000),
                created_at: 0,
            },
            scenario_yaml: String::new(),
            summary: ReportSummary {
                count: 0,
                errors: 0,
                rps: 0.0,
                duration_seconds: 1,
                mean_ms: 0,
                p50_ms: 0,
                p95_ms: 0,
                p99_ms: 0,
            },
            windows: vec![],
            steps,
            status_distribution: BTreeMap::new(),
            if_breakdown: vec![],
            verdict: None,
            insights: vec![],
            dropped: 0,
            latency: None,
            group_latency: vec![],
            active_vu_series: vec![],
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

    #[test]
    fn golden_summary_deltas_match() {
        #[derive(serde::Deserialize)]
        struct Golden {
            reports: Vec<ReportJson>,
            baseline_id: String,
            expected: serde_json::Value,
        }
        let g: Golden = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/compare_golden.json"
        )))
        .expect("golden parse");
        let base_idx = g
            .reports
            .iter()
            .position(|r| r.run.id == g.baseline_id)
            .unwrap();
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
                    assert!(
                        (d.pct.unwrap() - exp_pct).abs() < 1e-9,
                        "{metric} pct mismatch"
                    );
                    assert_eq!(
                        format!("{:?}", d.polarity).to_lowercase(),
                        exp["polarity"].as_str().unwrap()
                    );
                }
            }
        }
    }

    #[test]
    fn xlsx_roundtrips_summary_and_steps() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;

        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.summary.count = 123;
        let bytes = report_to_xlsx(&r);

        let mut wb: Xlsx<Cursor<Vec<u8>>> =
            open_workbook_from_rs(Cursor::new(bytes)).expect("read xlsx");
        let summary = wb.worksheet_range("Summary").expect("Summary sheet");
        assert_eq!(summary.get_value((0, 1)), Some(&Data::Float(123.0)));
        let steps = wb.worksheet_range("Steps").expect("Steps sheet");
        assert_eq!(steps.get_value((1, 0)), Some(&Data::String("a".into())));
        assert_eq!(steps.get_value((1, 4)), Some(&Data::Float(50.0)));
    }

    #[test]
    fn xlsx_has_insights_sheet() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;
        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.insights = vec![
            crate::insights::Insight {
                kind: "slowest_step".into(),
                severity: "info".into(),
                step_id: Some("a".into()),
                metric: Some("p95_ms".into()),
                value: Some(50.0),
                pct: None,
                count: None,
                status_class: None,
                window_seconds: None,
                recommended: None,
                cause: None,
                recommended_workers: None,
                onset_second: None,
            },
            // 사이징 3필드를 모두 채운 합성 행: 세 새 열 writer를 모두 운동시킨다.
            // (실제 인사이트는 recommended[slots] ⊕ recommended_workers[loadgen]로 배타적이지만,
            //  그 배타성은 insights.rs의 불변식이지 export writer의 관심사가 아니다.)
            crate::insights::Insight {
                kind: "load_gen_saturated".into(),
                severity: "warning".into(),
                step_id: None,
                metric: None,
                value: Some(1200.0),
                pct: None,
                count: Some(8181),
                status_class: None,
                window_seconds: None,
                recommended: Some(106.0),
                cause: Some("slots".into()),
                recommended_workers: Some(6.0),
                onset_second: Some(14),
            },
        ];
        let bytes = report_to_xlsx(&r);
        let mut wb: Xlsx<Cursor<Vec<u8>>> = open_workbook_from_rs(Cursor::new(bytes)).unwrap();
        let ws = wb.worksheet_range("Insights").expect("Insights sheet");
        // 기존 헤더/데이터 단언 (유지)
        assert_eq!(ws.get_value((0, 0)), Some(&Data::String("kind".into())));
        assert_eq!(
            ws.get_value((1, 0)),
            Some(&Data::String("slowest_step".into()))
        );
        assert_eq!(ws.get_value((1, 4)), Some(&Data::Float(50.0)));
        // 새 헤더 3열 (col 9/10/11 = J/K/L)
        assert_eq!(
            ws.get_value((0, 9)),
            Some(&Data::String("recommended".into()))
        );
        assert_eq!(ws.get_value((0, 10)), Some(&Data::String("cause".into())));
        assert_eq!(
            ws.get_value((0, 11)),
            Some(&Data::String("recommended_workers".into()))
        );
        // 사이징 행(벡터 인덱스 1 → 시트 row 2)의 새 3열 값
        assert_eq!(ws.get_value((2, 9)), Some(&Data::Float(106.0)));
        assert_eq!(ws.get_value((2, 10)), Some(&Data::String("slots".into())));
        assert_eq!(ws.get_value((2, 11)), Some(&Data::Float(6.0)));
        // 빈-셀 불변식: slowest_step 행(row 1)은 사이징 필드 None → 미기록.
        // calamine은 used-range 안의 미기록 셀을 None 또는 Data::Empty로 돌려준다(둘 다 허용).
        assert!(matches!(ws.get_value((1, 9)), None | Some(Data::Empty)));
        assert!(matches!(ws.get_value((1, 10)), None | Some(Data::Empty)));
        assert!(matches!(ws.get_value((1, 11)), None | Some(Data::Empty)));
        // 새 13번째 열 onset_second (col 12 = M)
        assert_eq!(
            ws.get_value((0, 12)),
            Some(&Data::String("onset_second".into()))
        );
        // 사이징 행(벡터 인덱스 1 → 시트 row 2)의 onset_second = 14
        assert_eq!(ws.get_value((2, 12)), Some(&Data::Float(14.0)));
        // slowest_step 행(row 1)은 onset None → 미기록(None 또는 Empty)
        assert!(matches!(ws.get_value((1, 12)), None | Some(Data::Empty)));
    }

    #[test]
    fn comparison_xlsx_roundtrips() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;
        let mut a = report_with_steps(vec![step("s", 1, 100)]);
        a.run.id = "A".into();
        a.summary.p95_ms = 100;
        let mut b = report_with_steps(vec![step("s", 1, 150)]);
        b.run.id = "B".into();
        b.summary.p95_ms = 150;
        let bytes = comparison_to_xlsx(&[a, b], 0);
        let mut wb: Xlsx<Cursor<Vec<u8>>> = open_workbook_from_rs(Cursor::new(bytes)).unwrap();
        let sum = wb.worksheet_range("Summary").unwrap();
        // SUMMARY_METRICS = [p50_ms, p95_ms, p99_ms, rps, error_rate]; p95_ms is index 1 → row 2.
        // col 0 = metric label, col 1 = base run value, col 2 = candidate value.
        assert_eq!(sum.get_value((2, 1)), Some(&Data::Float(100.0)));
        assert_eq!(sum.get_value((2, 2)), Some(&Data::Float(150.0)));
    }

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
        // 단일 CSV 헤더 ≡ INSIGHT_COLUMNS (parity, R5).
        let r = {
            let mut r = report_with_steps(vec![step("a", 1, 1)]);
            r.insights = vec![insight("slo_pass", "info")];
            r
        };
        let csv = String::from_utf8(report_to_insights_csv(&r)).unwrap();
        let csv_header: Vec<&str> = csv.lines().next().unwrap().split(',').collect();
        assert_eq!(csv_header, INSIGHT_COLUMNS.to_vec());
    }

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
        assert_eq!(ws.get_value((0, 0)), Some(&Data::String("run_id".into())));
        assert_eq!(ws.get_value((0, 1)), Some(&Data::String("kind".into())));
        assert_eq!(ws.get_value((1, 0)), Some(&Data::String("A".into())));
        assert_eq!(
            ws.get_value((1, 1)),
            Some(&Data::String("slowest_step".into()))
        );
        // value는 col_offset 1 + value 인덱스 4 = 5
        assert_eq!(ws.get_value((1, 5)), Some(&Data::Float(100.0)));
    }
}
