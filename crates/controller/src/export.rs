//! CSV/XLSX serialization of reports (single-run + N-run comparison).
//! Pure functions over `ReportJson` (built via build_report_for_run).
use crate::report::{ReportJson, SetupReport};
use crate::sample::{Sample, SampleBlock};
use crate::steady::{Basis, BasisState};
use rust_xlsxwriter::{Color, Format, Workbook, Worksheet};
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
    let lower_is_better = matches!(
        metric,
        "p50_ms" | "p95_ms" | "p99_ms" | "error_rate" | "setup_failed" | "setup_errors"
    );
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

/// pct 분수를 UI `formatPct`(CompareMatrix.tsx:12-14)와 동일하게: 부호 + 소수1자리 + '%'.
/// 음수 pct는 자체 '-'를 가지므로 양수/0에만 '+'를 붙인다.
fn format_pct(pct: f64) -> String {
    let sign = if pct >= 0.0 { "+" } else { "" };
    format!("{sign}{:.1}%", pct * 100.0)
}

/// 비교 Δ 셀 텍스트(글리프 + %)를 UI `DeltaChip`(CompareMatrix.tsx:17-49)과 1:1로 생성.
/// pct None(base=0) → value>0 ? "신규" : "동일". 글리프: Bad=▲, Good=▼, Neutral=없음.
fn delta_cell_text(d: &Delta, value: f64) -> String {
    let base = match d.pct {
        None => {
            if value > 0.0 {
                "신규".to_string()
            } else {
                "동일".to_string()
            }
        }
        Some(p) => format_pct(p),
    };
    match d.polarity {
        Polarity::Bad => format!("▲ {base}"),
        Polarity::Good => format!("▼ {base}"),
        Polarity::Neutral => base,
    }
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

/// 통과한 요청이 하나도 없어 응답 시간이 「값 없음」인가. 통과 = `count − errors`
/// (「보내지 않음」도 오류에 든다). 나눌 수 없는 옛 run은 `default == All`이라 늘 거짓.
fn latency_missing(sample: &SampleBlock, count: u64, errors: u64) -> bool {
    sample.default == Sample::Passed && count == errors
}

/// 비교용 요약 값. 응답 시간 지표가 값 없음이면 `None`.
fn summary_value(r: &ReportJson, metric: &str) -> Option<f64> {
    let latency = matches!(metric, "p50_ms" | "p95_ms" | "p99_ms");
    if latency && latency_missing(&r.sample, r.summary.count, r.summary.errors) {
        None
    } else {
        Some(summary_metric(&r.summary, metric))
    }
}

fn sample_label(s: Sample) -> &'static str {
    match s {
        Sample::Passed => "passed",
        Sample::Failed => "failed",
        Sample::All => "all",
    }
}

/// 응답 시간 값 하나를 CSV 칸 글자로(값 없음 → 빈 문자열).
fn latency_csv(missing: bool, ms: u64) -> String {
    if missing {
        String::new()
    } else {
        ms.to_string()
    }
}

const SUMMARY_METRICS: [&str; 5] = ["p50_ms", "p95_ms", "p99_ms", "rps", "error_rate"];

/// 모든 CSV/XLSX 인사이트 표면이 공유하는 정규 컬럼 순서(단일 소스).
/// `Insight` 구조체(insights.rs) 필드 순서와 일치. 비교 표면은 `run_id` 열을
/// 앞에 붙이고, 이 21열은 모든 표면에서 동일하다.
const INSIGHT_COLUMNS: [&str; 21] = [
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
    "achieved_per_sec",
    "target_per_sec",
    "runner_up_ms",
    "error_kind",
    "typical_in_flight",
    "max_in_flight",
    "drop_seconds",
    "measured_seconds",
];

/// 인사이트 하나를 21개 CSV 셀로(None → 빈 문자열), `INSIGHT_COLUMNS` 순서.
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
        f(ins.achieved_per_sec),
        f(ins.target_per_sec),
        f(ins.runner_up_ms),
        ins.error_kind.clone().unwrap_or_default(),
        ins.typical_in_flight
            .map(|x| x.to_string())
            .unwrap_or_default(),
        ins.max_in_flight.map(|x| x.to_string()).unwrap_or_default(),
        ins.drop_seconds.map(|x| x.to_string()).unwrap_or_default(),
        ins.measured_seconds
            .map(|x| x.to_string())
            .unwrap_or_default(),
    ]
}

/// 인사이트 하나의 21개 타입별 셀을 `ws`의 (row, col_offset + i)에 기록.
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
    if let Some(v) = ins.achieved_per_sec {
        ws.write_number(row, c(13), v).expect("w");
    }
    if let Some(v) = ins.target_per_sec {
        ws.write_number(row, c(14), v).expect("w");
    }
    if let Some(v) = ins.runner_up_ms {
        ws.write_number(row, c(15), v).expect("w");
    }
    if let Some(v) = &ins.error_kind {
        ws.write_string(row, c(16), v).expect("w");
    }
    if let Some(v) = ins.typical_in_flight {
        ws.write_number(row, c(17), v as f64).expect("w");
    }
    if let Some(v) = ins.max_in_flight {
        ws.write_number(row, c(18), f64::from(v)).expect("w");
    }
    if let Some(v) = ins.drop_seconds {
        ws.write_number(row, c(19), v as f64).expect("w");
    }
    if let Some(v) = ins.measured_seconds {
        ws.write_number(row, c(20), v as f64).expect("w");
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

/// 비교·내보내기에 찍는 집계 기준 글자. `basis` 블록이 없는 run은 전체 구간이다.
fn basis_label(r: &ReportJson) -> &'static str {
    match r.basis.as_ref().map(|b| b.selected) {
        Some(Basis::Steady) => "steady",
        _ => "whole",
    }
}

fn basis_state_label(s: BasisState) -> &'static str {
    match s {
        BasisState::Measured => "measured",
        BasisState::Partial => "partial",
        BasisState::NotReached => "not_reached",
        BasisState::NoCommonWindow => "no_common_window",
    }
}

/// Steps 표(머리 + 스텝 행)를 `first_row`부터 쓴다. `Steps`·`Other basis` 시트가 같은 열을 쓴다.
fn write_steps_table(
    ws: &mut Worksheet,
    first_row: u32,
    steps: &[crate::report::ReportStep],
    sample: &SampleBlock,
) {
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
        ws.write_string(first_row, c as u16, *h).expect("w");
    }
    for (i, st) in steps.iter().enumerate() {
        let r = first_row + 1 + i as u32;
        ws.write_string(r, 0, &st.step_id).expect("w");
        ws.write_number(r, 1, st.count as f64).expect("w");
        ws.write_number(r, 2, st.error_count as f64).expect("w");
        if !latency_missing(sample, st.count, st.error_count) {
            ws.write_number(r, 3, st.p50_ms as f64).expect("w");
            ws.write_number(r, 4, st.p95_ms as f64).expect("w");
            ws.write_number(r, 5, st.p99_ms as f64).expect("w");
        }
    }
}

/// 요약 숫자 일곱 행(count…p99_ms)을 `first_row`부터 쓴다. 응답 시간이 값 없음이면 라벨만 쓴다.
fn write_summary_numbers(
    ws: &mut Worksheet,
    first_row: u32,
    s: &crate::report::ReportSummary,
    sample: &SampleBlock,
) {
    let missing = latency_missing(sample, s.count, s.errors);
    let rows: [(&str, f64, bool); 7] = [
        ("count", s.count as f64, false),
        ("errors", s.errors as f64, false),
        ("rps", s.rps, false),
        ("duration_seconds", s.duration_seconds as f64, false),
        ("p50_ms", s.p50_ms as f64, true),
        ("p95_ms", s.p95_ms as f64, true),
        ("p99_ms", s.p99_ms as f64, true),
    ];
    for (i, (k, v, is_latency)) in rows.iter().enumerate() {
        ws.write_string(first_row + i as u32, 0, *k).expect("w");
        if !(*is_latency && missing) {
            ws.write_number(first_row + i as u32, 1, *v).expect("w");
        }
    }
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
        let base = summary_value(&reports[baseline_idx], metric);
        let mut rec = vec![metric.to_string()];
        for r in reports {
            rec.push(
                summary_value(r, metric)
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
            );
        }
        for (i, r) in reports.iter().enumerate() {
            if i != baseline_idx {
                let pct = match (base, summary_value(r, metric)) {
                    (Some(b), Some(v)) => delta(metric, b, v).pct,
                    _ => None,
                };
                rec.push(pct.map(|p| format!("{p:.6}")).unwrap_or_default());
            }
        }
        w.write_record(&rec).expect("row");
    }
    if reports.iter().any(|r| r.setup.is_some()) {
        for metric in ["setup_ok", "setup_failed"] {
            let vals: Vec<Option<f64>> = reports
                .iter()
                .map(|r| {
                    r.setup.as_ref().map(|s| {
                        if metric == "setup_ok" {
                            s.ok as f64
                        } else {
                            s.failed as f64
                        }
                    })
                })
                .collect();
            let mut rec = vec![metric.to_string()];
            rec.extend(
                vals.iter()
                    .map(|v| v.map(|x| x.to_string()).unwrap_or_default()),
            );
            for (i, v) in vals.iter().enumerate() {
                if i == baseline_idx {
                    continue;
                }
                let pct = match (vals[baseline_idx], *v) {
                    (Some(b), Some(x)) => delta(metric, b, x).pct,
                    _ => None,
                };
                rec.push(pct.map(|p| format!("{p:.6}")).unwrap_or_default());
            }
            w.write_record(&rec).expect("setup row");
        }
    }
    if reports.iter().any(|r| r.basis.is_some()) {
        let mut rec = vec!["basis".to_string()];
        rec.extend(reports.iter().map(|r| basis_label(r).to_string()));
        rec.extend((1..reports.len()).map(|_| String::new()));
        w.write_record(&rec).expect("basis row");
    }
    w.into_inner().expect("flush")
}

/// 비교의 준비 스텝 id 순서: 기준 run의 순서, 그 뒤 다른 run에만 있는 id(첫 등장 순).
fn setup_step_order(reports: &[ReportJson], baseline_idx: usize) -> Vec<String> {
    let mut order: Vec<String> = Vec::new();
    let baseline = std::iter::once(&reports[baseline_idx]);
    let others = reports
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != baseline_idx)
        .map(|(_, r)| r);
    for r in baseline.chain(others) {
        if let Some(s) = &r.setup {
            for st in &s.steps {
                if !order.contains(&st.step_id) {
                    order.push(st.step_id.clone());
                }
            }
        }
    }
    order
}

/// 비교 XLSX의 Δ 셀 하나: 폴라리티별 색 서식.
fn write_delta_cell(
    ws: &mut Worksheet,
    row: u32,
    col: u16,
    d: &Delta,
    value: f64,
    fmt_bad: &Format,
    fmt_good: &Format,
) {
    let text = delta_cell_text(d, value);
    match d.polarity {
        Polarity::Bad => ws.write_string_with_format(row, col, &text, fmt_bad),
        Polarity::Good => ws.write_string_with_format(row, col, &text, fmt_good),
        Polarity::Neutral => ws.write_string(row, col, &text),
    }
    .expect("w");
}

/// 준비 스텝 `id → name`. 시나리오를 못 읽으면 빈 맵.
fn setup_step_names(scenario_yaml: &str) -> std::collections::HashMap<String, String> {
    match handicap_engine::Scenario::from_yaml(scenario_yaml) {
        Ok(sc) => sc
            .setup_steps()
            .iter()
            .map(|s| (s.id().to_string(), s.name().to_string()))
            .collect(),
        Err(_) => std::collections::HashMap::new(),
    }
}

/// `"0: 1, 200: 47, 503: 2"` — 맵 순서대로.
fn status_counts_text(m: &std::collections::BTreeMap<String, u64>) -> String {
    m.iter()
        .map(|(k, v)| format!("{k}: {v}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 준비 스텝들의 `failure_kinds` 합.
fn merged_failure_kinds(s: &SetupReport) -> std::collections::BTreeMap<String, u64> {
    let mut out = std::collections::BTreeMap::new();
    for st in &s.steps {
        for (k, v) in &st.failure_kinds {
            *out.entry(k.clone()).or_insert(0) += v;
        }
    }
    out
}

/// Excel 셀 한 칸은 32,767자까지다(그 위는 rust_xlsxwriter가 거절).
fn xlsx_text(s: &str) -> &str {
    match s.char_indices().nth(32_767) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// `Setup` 시트: 요약 3행 → 빈 행 → 스텝 표 → (실패 종류가 있으면) 빈 행 → 실패 종류 표.
fn write_setup_sheet(
    wb: &mut Workbook,
    s: &SetupReport,
    names: &std::collections::HashMap<String, String>,
) {
    let ws = wb.add_worksheet();
    ws.set_name("Setup").expect("sheet name");
    for (i, (k, v)) in [
        ("setup_ok", s.ok),
        ("setup_failed", s.failed),
        ("setup_interrupted", s.interrupted),
    ]
    .iter()
    .enumerate()
    {
        ws.write_string(i as u32, 0, *k).expect("w");
        ws.write_number(i as u32, 1, *v as f64).expect("w");
    }
    for (c, h) in [
        "step_id",
        "name",
        "count",
        "error_count",
        "p50_ms",
        "p95_ms",
        "max_ms",
        "status_counts",
    ]
    .iter()
    .enumerate()
    {
        ws.write_string(4, c as u16, *h).expect("w");
    }
    let mut r = 5u32;
    for st in &s.steps {
        ws.write_string(r, 0, xlsx_text(&st.step_id)).expect("w");
        if let Some(name) = names.get(&st.step_id) {
            ws.write_string(r, 1, xlsx_text(name)).expect("w");
        }
        ws.write_number(r, 2, st.count as f64).expect("w");
        ws.write_number(r, 3, st.errors as f64).expect("w");
        ws.write_number(r, 4, st.p50_ms as f64).expect("w");
        ws.write_number(r, 5, st.p95_ms as f64).expect("w");
        ws.write_number(r, 6, st.max_ms as f64).expect("w");
        ws.write_string(r, 7, status_counts_text(&st.status_counts))
            .expect("w");
        r += 1;
    }
    let kinds = merged_failure_kinds(s);
    if !kinds.is_empty() {
        r += 1;
        ws.write_string(r, 0, "failure_kind").expect("w");
        ws.write_string(r, 1, "count").expect("w");
        for (k, v) in &kinds {
            r += 1;
            ws.write_string(r, 0, k).expect("w");
            ws.write_number(r, 1, *v as f64).expect("w");
        }
    }
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
        let missing = latency_missing(&report.sample, s.count, s.error_count);
        w.write_record([
            s.step_id.as_str(),
            &s.count.to_string(),
            &s.error_count.to_string(),
            &latency_csv(missing, s.p50_ms),
            &latency_csv(missing, s.p95_ms),
            &latency_csv(missing, s.p99_ms),
        ])
        .expect("csv row");
    }
    let mut out = w.into_inner().expect("csv flush");
    let Some(s) = &report.setup else {
        return out;
    };
    out.push(b'\n');
    let mut w = csv::Writer::from_writer(out);
    w.write_record(["setup_ok", "setup_failed", "setup_interrupted"])
        .expect("csv header");
    w.write_record([
        s.ok.to_string(),
        s.failed.to_string(),
        s.interrupted.to_string(),
    ])
    .expect("csv row");
    let out = w.into_inner().expect("csv flush");
    let mut w = csv::Writer::from_writer(out);
    w.write_record([
        "setup_step_id",
        "count",
        "error_count",
        "p50_ms",
        "p95_ms",
        "max_ms",
    ])
    .expect("csv header");
    for st in &s.steps {
        w.write_record([
            st.step_id.clone(),
            st.count.to_string(),
            st.errors.to_string(),
            st.p50_ms.to_string(),
            st.p95_ms.to_string(),
            st.max_ms.to_string(),
        ])
        .expect("csv row");
    }
    w.into_inner().expect("csv flush")
}

/// Multi-run comparison XLSX: Summary + Steps + Runs sheets.
pub fn comparison_to_xlsx(reports: &[ReportJson], baseline_idx: usize) -> Vec<u8> {
    let mut wb = Workbook::new();
    // Δ 셀 polarity 색(Excel 옅은 fill). set_background_color만으로 solid(0.79.4 기본).
    // 1회 생성·재사용(루프마다 재생성 금지). neutral은 plain write_string(fill 없음).
    let fmt_bad = Format::new()
        .set_background_color(Color::RGB(0xFFC7CE))
        .set_font_color(Color::RGB(0x9C0006));
    let fmt_good = Format::new()
        .set_background_color(Color::RGB(0xC6EFCE))
        .set_font_color(Color::RGB(0x006100));

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
        let base = summary_value(&reports[baseline_idx], metric);
        for (i, r) in reports.iter().enumerate() {
            if let Some(v) = summary_value(r, metric) {
                ws.write_number(row, (1 + i) as u16, v).expect("w");
            }
        }
        let mut dcol = delta_start;
        for (i, r) in reports.iter().enumerate() {
            if i != baseline_idx {
                if let (Some(b), Some(val)) = (base, summary_value(r, metric)) {
                    let d = delta(metric, b, val);
                    write_delta_cell(ws, row, dcol, &d, val, &fmt_bad, &fmt_good);
                }
                dcol += 1;
            }
        }
    }

    // Steps: union of step_ids (sorted), columns = run p95, then per-step p95 Δ.
    // Δ presence는 compareReports.ts step 행(62-75) 미러: baseline·candidate 둘 다
    // 그 스텝을 가질 때만 Δ 셀 기록(하나라도 없으면 블랭크). absent-baseline은
    // 화면이 블랭크라 export도 블랭크 — unwrap_or(0.0)로 "신규"를 내면 parity 깨짐.
    let ws = wb.add_worksheet();
    ws.set_name("Steps").expect("name");
    ws.write_string(0, 0, "step_id").expect("w");
    for (i, r) in reports.iter().enumerate() {
        ws.write_string(0, (1 + i) as u16, &r.run.id).expect("w");
    }
    let steps_delta_start = (1 + reports.len()) as u16;
    {
        let mut col = steps_delta_start;
        for (i, r) in reports.iter().enumerate() {
            if i != baseline_idx {
                ws.write_string(0, col, format!("\u{0394}% {}", r.run.id))
                    .expect("w");
                col += 1;
            }
        }
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
        // baseline p95 (그 스텝이 있을 때만 Some — absent면 None, unwrap_or 금지).
        // 값 없음(통과한 요청 없음)인 스텝도 None.
        let step_p95 = |r: &ReportJson| {
            r.steps
                .iter()
                .find(|s| &s.step_id == sid)
                .filter(|s| !latency_missing(&r.sample, s.count, s.error_count))
                .map(|s| s.p95_ms as f64)
        };
        let base = step_p95(&reports[baseline_idx]);
        for (i, r) in reports.iter().enumerate() {
            if let Some(v) = step_p95(r) {
                ws.write_number(row, (1 + i) as u16, v).expect("w");
            }
        }
        // Δ 셀: 비-baseline run마다 dcol 무조건 전진, 기록은 base·val 둘 다 Some일 때만.
        let mut dcol = steps_delta_start;
        for (i, r) in reports.iter().enumerate() {
            if i != baseline_idx {
                let val = step_p95(r);
                if let (Some(b), Some(v)) = (base, val) {
                    let d = delta("p95_ms", b, v);
                    write_delta_cell(ws, row, dcol, &d, v, &fmt_bad, &fmt_good);
                }
                dcol += 1;
            }
        }
    }

    if reports.iter().any(|r| r.setup.is_some()) {
        let ws = wb.add_worksheet();
        ws.set_name("Setup").expect("name");
        ws.write_string(0, 0, "metric").expect("w");
        for (i, r) in reports.iter().enumerate() {
            let h = if i == baseline_idx {
                format!("{} (base)", r.run.id)
            } else {
                r.run.id.clone()
            };
            ws.write_string(0, (1 + i) as u16, &h).expect("w");
        }
        let setup_delta_start = (1 + reports.len()) as u16;
        {
            let mut col = setup_delta_start;
            for (i, r) in reports.iter().enumerate() {
                if i != baseline_idx {
                    ws.write_string(0, col, format!("\u{0394}% {}", r.run.id))
                        .expect("w");
                    col += 1;
                }
            }
        }
        // (행 이름, delta에 넘기는 metric, run별 값 — 그 run에 없으면 None)
        let mut rows: Vec<(String, &str, Vec<Option<f64>>)> = vec![
            (
                "setup_ok".to_string(),
                "setup_ok",
                reports
                    .iter()
                    .map(|r| r.setup.as_ref().map(|s| s.ok as f64))
                    .collect(),
            ),
            (
                "setup_failed".to_string(),
                "setup_failed",
                reports
                    .iter()
                    .map(|r| r.setup.as_ref().map(|s| s.failed as f64))
                    .collect(),
            ),
        ];
        for sid in setup_step_order(reports, baseline_idx) {
            let find = |r: &ReportJson| {
                r.setup
                    .as_ref()
                    .and_then(|s| s.steps.iter().find(|st| st.step_id == sid))
                    .map(|st| (st.p95_ms as f64, st.errors as f64))
            };
            rows.push((
                format!("{sid} p95_ms"),
                "p95_ms",
                reports.iter().map(|r| find(r).map(|v| v.0)).collect(),
            ));
            rows.push((
                format!("{sid} error_count"),
                "setup_errors",
                reports.iter().map(|r| find(r).map(|v| v.1)).collect(),
            ));
        }
        for (ri, (label, metric, vals)) in rows.iter().enumerate() {
            let row = (ri + 1) as u32;
            ws.write_string(row, 0, label).expect("w");
            for (i, v) in vals.iter().enumerate() {
                if let Some(x) = v {
                    ws.write_number(row, (1 + i) as u16, *x).expect("w");
                }
            }
            let mut dcol = setup_delta_start;
            for (i, v) in vals.iter().enumerate() {
                if i != baseline_idx {
                    if let (Some(b), Some(x)) = (vals[baseline_idx], *v) {
                        let d = delta(metric, b, x);
                        write_delta_cell(ws, row, dcol, &d, x, &fmt_bad, &fmt_good);
                    }
                    dcol += 1;
                }
            }
        }
    }

    // Runs meta: id, label, status, started_at, ended_at, count.
    let ws = wb.add_worksheet();
    ws.set_name("Runs").expect("name");
    for (c, h) in [
        "run_id",
        "label",
        "status",
        "started_at",
        "ended_at",
        "count",
    ]
    .iter()
    .enumerate()
    {
        ws.write_string(0, c as u16, *h).expect("w");
    }
    let mark_basis = reports.iter().any(|r| r.basis.is_some());
    if mark_basis {
        ws.write_string(0, 6, "basis").expect("w");
    }
    let sample_col: u16 = if mark_basis { 7 } else { 6 };
    ws.write_string(0, sample_col, "latency_sample").expect("w");
    for (i, r) in reports.iter().enumerate() {
        let row = (i + 1) as u32;
        if mark_basis {
            ws.write_string(row, 6, basis_label(r)).expect("w");
        }
        ws.write_string(row, sample_col, sample_label(r.sample.default))
            .expect("w");
        ws.write_string(row, 0, &r.run.id).expect("w");
        ws.write_string(row, 1, r.run.label.as_deref().unwrap_or(""))
            .expect("w");
        ws.write_string(row, 2, &r.run.status).expect("w");
        ws.write_number(row, 3, r.run.started_at.unwrap_or(0) as f64)
            .expect("w");
        ws.write_number(row, 4, r.run.ended_at.unwrap_or(0) as f64)
            .expect("w");
        ws.write_number(row, 5, r.summary.count as f64).expect("w");
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
pub fn report_to_xlsx(report: &ReportJson, other: Option<&ReportJson>) -> Vec<u8> {
    let mut wb = Workbook::new();

    // --- Summary sheet ---
    let ws = wb.add_worksheet();
    ws.set_name("Summary").expect("sheet name");
    write_summary_numbers(ws, 0, &report.summary, &report.sample);
    // H2: validity is not f64 — separate string writes (rows 7–8).
    let validity_kinds = report
        .validity
        .reasons
        .iter()
        .map(|r| r.kind.as_str())
        .collect::<Vec<_>>()
        .join(",");
    ws.write_string(7, 0, "validity_level").expect("w");
    ws.write_string(7, 1, &report.validity.level).expect("w");
    ws.write_string(8, 0, "validity_reason_kinds").expect("w");
    ws.write_string(8, 1, &validity_kinds).expect("w");
    let mut next_row = 9u32;
    if let Some(b) = &report.basis {
        let default = match b.default {
            Basis::Steady => "steady",
            Basis::Whole => "whole",
        };
        let texts = [
            ("basis", basis_label(report)),
            ("basis_default", default),
            ("basis_state", basis_state_label(b.state)),
        ];
        let mut nums = vec![
            ("basis_ramp_seconds", f64::from(b.config.ramp_seconds)),
            ("basis_discard_seconds", f64::from(b.config.discard_seconds)),
        ];
        if let Some(w) = &b.window {
            nums.push(("basis_window_start_ms", w.start_ms as f64));
            nums.push(("basis_window_end_ms", w.end_ms as f64));
            nums.push(("basis_measured_seconds", w.measured_seconds as f64));
        }
        for (k, v) in texts {
            ws.write_string(next_row, 0, k).expect("w");
            ws.write_string(next_row, 1, v).expect("w");
            next_row += 1;
        }
        for (k, v) in nums {
            ws.write_string(next_row, 0, k).expect("w");
            ws.write_number(next_row, 1, v).expect("w");
            next_row += 1;
        }
    }
    ws.write_string(next_row, 0, "latency_sample").expect("w");
    ws.write_string(next_row, 1, sample_label(report.sample.default))
        .expect("w");

    // --- Steps sheet ---
    let ws = wb.add_worksheet();
    ws.set_name("Steps").expect("sheet name");
    write_steps_table(ws, 0, &report.steps, &report.sample);

    if let Some(s) = &report.setup {
        write_setup_sheet(&mut wb, s, &setup_step_names(&report.scenario_yaml));
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
        if !latency_missing(&report.sample, win.count, win.error_count) {
            ws.write_number(r, 4, win.p50_ms as f64).expect("w");
            ws.write_number(r, 5, win.p95_ms as f64).expect("w");
            ws.write_number(r, 6, win.p99_ms as f64).expect("w");
        }
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

    if let Some(st) = &report.stair {
        write_stairs_sheet(&mut wb, st);
    }

    if let Some(o) = other {
        let ws = wb.add_worksheet();
        ws.set_name("Other basis").expect("sheet name");
        ws.write_string(0, 0, "basis").expect("w");
        ws.write_string(0, 1, basis_label(o)).expect("w");
        write_summary_numbers(ws, 1, &o.summary, &o.sample);
        write_steps_table(ws, 9, &o.steps, &o.sample);
    }

    wb.save_to_buffer().expect("xlsx buffer")
}

/// JS `Number.prototype.toFixed(d)`와 같은 결과(정확히 반 남으면 올림). Rust `{:.d$}`는
/// 반 남으면 짝수로 맞춰(2.25 → "2.2") 화면(`toFixed`, 2.25 → "2.3")과 글자가 달라진다.
fn js_to_fixed(x: f64, d: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e15 {
        return format!("{x:.d$}");
    }
    if x < 0.0 {
        let s = js_to_fixed(-x, d);
        return if s.bytes().all(|b| b == b'0' || b == b'.') {
            s
        } else {
            format!("-{s}")
        };
    }
    // f64는 소수 1074자리 안에서 정확히 끝난다 — 이 자릿수의 문자열은 값 그대로다.
    let exact = format!("{x:.1100}");
    let (int, frac) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut n: u128 = format!("{int}{}", &frac[..d]).parse().unwrap_or(0);
    if frac.as_bytes().get(d).is_some_and(|&b| b >= b'5') {
        n += 1;
    }
    if d == 0 {
        return n.to_string();
    }
    let p = 10u128.pow(d as u32);
    format!("{}.{:0d$}", n / p, n % p)
}

/// UI `floorPct1`: 비율을 % 소수 첫째로 *내림*(94.96% → "94.9%").
fn floor_pct1(ratio: f64) -> String {
    format!(
        "{}%",
        js_to_fixed((ratio * 1000.0 + 1e-9).floor() / 10.0, 1)
    )
}

/// 머리말 첫 줄. UI 짝 = `ui/src/components/report/stair/stairFormat.ts` `headlineParts().first`.
fn stair_headline_first(st: &crate::stair::StairReport) -> String {
    use crate::stair::HeadlineKind::*;
    let h = &st.headline;
    let n = |v: Option<u32>| v.map_or("—".to_string(), |v| v.to_string());
    let last_or_through = h.last_ok_target.or(h.through_target);
    match h.kind {
        Saturated => match h.last_ok_target {
            Some(l) => format!(
                "포화 계단 {} iter/s · 마지막 정상 {l} iter/s",
                n(h.saturated_target)
            ),
            None => format!(
                "포화 계단 {} iter/s · 정상 계단 없음 — 첫 계단부터 실패",
                n(h.saturated_target)
            ),
        },
        Unconfirmed => match h.last_ok_target {
            Some(l) => format!(
                "포화 의심 {} iter/s — 확인할 다음 계단 전에 run이 끝남 · 마지막 정상 {l} iter/s",
                n(h.saturated_target)
            ),
            None => format!(
                "포화 의심 {} iter/s — 확인할 다음 계단 전에 run이 끝남 · 정상 계단 없음",
                n(h.saturated_target)
            ),
        },
        AllOk => format!(
            "{} iter/s까지 정상 (포화 못 찾음 — 더 높은 목표로 다시)",
            n(last_or_through)
        ),
        OkThenUnmeasured => format!(
            "{} iter/s까지 정상 · 이후 계단은 측정 안 됨",
            n(last_or_through)
        ),
        NoData => "판정할 수 없음 — 측정이 끝난 계단이 없습니다".to_string(),
    }
}

/// 이 계단 앞에서 가장 가까운 `ok` 계단(판정 기준 계단). UI `refStep`과 같다.
fn stair_ref_step(st: &crate::stair::StairReport, idx: usize) -> Option<&crate::stair::StairStep> {
    st.steps[..idx.min(st.steps.len())]
        .iter()
        .rev()
        .find(|s| s.state == crate::stair::StepState::Ok)
}

/// UI `errorRateText`: 0.1% 내림, 0이 아닌데 0.0%면 「<0.1%」.
fn stair_error_rate_text(r: f64) -> String {
    let txt = floor_pct1(r);
    if r > 0.0 && txt == "0.0%" {
        "<0.1%".to_string()
    } else {
        txt
    }
}

/// UI `formatMs`: 1 ms 미만은 소수 둘째, 이상은 정수(반 올림).
fn stair_ms_text(us: u64) -> String {
    let ms = us as f64 / 1000.0;
    js_to_fixed(ms, if us < 1000 { 2 } else { 0 })
}

/// 일부 실행 구간별 문구 조각(「N계단」 뒤에 붙는다). 상승은 「상승 S초 진입 후」, 버림·측정은
/// 계단 시작부터 센 초라 「시작 S초 뒤(…중)」로 적는다.
fn stair_partial_where(p: &crate::stair::PartialRun) -> String {
    use crate::stair::BandKind::*;
    match p.phase {
        Ramp => format!("상승 {}초 진입 후", p.seconds),
        Discard => format!("시작 {}초 뒤(버림 중)", p.seconds),
        Measure => format!("시작 {}초 뒤(측정 중)", p.seconds),
    }
}

/// 자동 정지 정지 줄(spec §5.3). 기록된 정지가 없으면 `None`. `time_text` = 정지 시각 글자.
pub(crate) fn stair_stop_line(st: &crate::stair::StairReport, time_text: &str) -> Option<String> {
    use crate::auto_stop::StopKind;
    use crate::stair::{BandKind, SaturationStopMode, StepState};
    let stop = st.auto_stop.as_ref()?.stop.as_ref()?;
    let label = |i: usize| match st.steps.get(i) {
        Some(s) => format!("{}계단({} iter/s)", i + 1, s.target),
        None => format!("{}계단", i + 1),
    };
    let d = stop.decided_step as usize;
    let mut parts: Vec<String> = Vec::new();
    let head = match stop.kind {
        StopKind::Saturation => {
            let list: Vec<String> = stop
                .failed_steps
                .iter()
                .map(|i| (i + 1).to_string())
                .collect();
            let mut reason = match stop.mode {
                Some(SaturationStopMode::FirstFail) => format!(
                    "{}계단 실패, 첫 실패에서 정지(포화 확인 못 함)",
                    list.join("·")
                ),
                _ => format!("{}계단 연속 실패", list.join("·")),
            };
            if stop.slot_limited {
                reason.push_str(" (슬롯 부족 의심 — 부하기 한계일 수 있음)");
            }
            parts.push(reason);
            format!("{} 판정 뒤 자동 정지", label(d))
        }
        StopKind::Emergency => {
            let phase = match stop.phase {
                Some(BandKind::Ramp) => "상승",
                Some(BandKind::Discard) => "버림",
                _ => "측정",
            };
            if let Some(e) = &stop.emergency {
                let secs = format!("{}초 연속", e.seconds);
                let err = format!("오류율 {}", stair_error_rate_text(e.max_error_rate));
                let p99 = format!("p99 {} ms", stair_ms_text(e.max_p99_us));
                match (e.error_hit, e.p99_hit) {
                    (true, true) => {
                        parts.push(err);
                        parts.push(format!("{p99} {secs}"));
                    }
                    (true, false) => parts.push(format!("{err} {secs}")),
                    // (false, false)는 기록상 불가능한 조합 — 화면과 같은 p99 꼴.
                    (false, true) | (false, false) => parts.push(format!("{p99} {secs}")),
                }
            }
            parts.push(match st.headline.last_ok_target {
                Some(t) => match st.steps.iter().position(|s| s.target == t) {
                    Some(i) => format!("마지막 정상 {}", label(i)),
                    None => format!("마지막 정상 {t} iter/s"),
                },
                None => "정상 계단 없음".to_string(),
            });
            format!("{} {phase} 중 즉시 정지", label(d))
        }
    };
    for (i, s) in st.steps.iter().enumerate() {
        if let Some(p) = &s.partial {
            parts.push(format!("{}계단 {} 멈춤", i + 1, stair_partial_where(p)));
        }
    }
    let skipped: Vec<usize> = st
        .steps
        .iter()
        .enumerate()
        .filter(|(_, s)| s.state == StepState::Skipped)
        .map(|(i, _)| i + 1)
        .collect();
    if let (Some(a), Some(b)) = (skipped.first(), skipped.last()) {
        parts.push(if a == b {
            format!("{a}계단 실행 안 함")
        } else {
            format!("{a}–{b}계단 실행 안 함")
        });
    }
    parts.push(time_text.to_string());
    Some(format!("{head} — {}", parts.join(" · ")))
}

/// 정지는 없고 감시 보류만 있었을 때의 줄.
pub(crate) fn stair_suspended_line(st: &crate::stair::StairReport) -> Option<String> {
    let rec = st.auto_stop.as_ref()?;
    if rec.stop.is_some() || rec.suspended_seconds == 0 {
        return None;
    }
    Some(format!(
        "자동 정지 감시가 {}초 보류됐습니다(부하기 등록·데이터 지연) — 그동안 즉시 정지는 동작하지 않았습니다",
        rec.suspended_seconds
    ))
}

/// 계단 머리말 줄들 — 화면 판정 상자(`headlineParts`: 첫 줄 → 힌트 → 지연 상승 시작 →
/// 튄 계단 → dropped 설명 → 슬롯 부족)와 같은 순서·글자, 그 뒤 안내 줄(`t0_estimated`,
/// `open_loop_unknown`). CSV·XLSX 시트 첫 줄들에 그대로 쓴다.
pub fn stair_headline_lines(st: &crate::stair::StairReport) -> Vec<String> {
    use crate::stair::HeadlineKind;
    let h = &st.headline;
    let mut out = Vec::new();
    let stop_line = st
        .auto_stop
        .as_ref()
        .and_then(|r| r.stop.as_ref())
        .and_then(|stop| stair_stop_line(st, &stair_iso(stop.stopped_at_ms)));
    out.extend(stop_line.or_else(|| stair_suspended_line(st)));
    out.push(stair_headline_first(st));
    if h.kind == HeadlineKind::Saturated && h.last_ok_target.is_none() && h.first_fail_hint {
        out.push(
            "첫 계단만 일시적으로 튀었을 수 있습니다 — 앞부분 버림을 늘려 다시 실행해 보세요"
                .to_string(),
        );
    }
    if let Some(k) = st.knee_target {
        let ki = st.steps.iter().position(|s| s.target == k);
        let ratio = ki.filter(|&i| i > 0).and_then(|i| {
            stair_ref_step(st, i)
                .filter(|r| r.p99_us > 0)
                .map(|r| st.steps[i].p99_us as f64 / r.p99_us as f64)
        });
        out.push(match ratio {
            Some(x) => format!(
                "지연 상승 시작 ≈ {k} iter/s (p99가 아래 계단의 {}배 — 판정 기준 안이지만 참고)",
                js_to_fixed(x, 1)
            ),
            None => format!("지연 상승 시작 ≈ {k} iter/s (판정 기준 안이지만 참고)"),
        });
    }
    if !st.spike_targets.is_empty() {
        let list: Vec<String> = st.spike_targets.iter().map(u32::to_string).collect();
        out.push(format!(
            "튄 계단 {}개({} iter/s) 넘김",
            st.spike_targets.len(),
            list.join(", ")
        ));
    }
    let dropped_total = st.dropped_total.unwrap_or(0);
    if st.dropped_explained && dropped_total > 0 {
        out.push(format!(
            "부하기가 못 보낸 요청 {}개는 모두 지연·오류로 무너진 계단에서 발생 — 시스템 포화로 판정에 반영됨",
            group_thousands(dropped_total)
        ));
    }
    if !st.slot_limited_targets.is_empty() {
        let list: Vec<String> = st.slot_limited_targets.iter().map(u32::to_string).collect();
        let cap = match st.max_in_flight {
            Some(m) => format!("max_in_flight = {m}"),
            None => "max_in_flight".to_string(),
        };
        out.push(format!(
            "계단 {} iter/s은(는) 지연·오류는 정상인데 요청을 다 못 보냄 — 동시 실행 한도({cap})가 부족할 수 있어 시스템 한계로 단정할 수 없음. 한도를 늘려 다시 실행하세요",
            list.join(", ")
        ));
    }
    if st.notes.t0_estimated {
        out.push("ⓘ 부하기 일부가 예전 버전이라 계단 시작 시각을 첫 데이터로 추정했습니다(±1초). 측정 구간 경계가 조금 어긋날 수 있습니다.".to_string());
    }
    if st.notes.open_loop_unknown {
        out.push(
            "ⓘ 예전 버전 부하기라 계단별 달성·dropped를 모릅니다 — 판정은 지연·오류로만 했습니다."
                .to_string(),
        );
    }
    out
}

fn group_thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// 계단 행의 실패 사유 — 화면 표(`reasonTexts`)와 같은 글자. `p99_relative`의 기준(앞 정상)
/// 계단이 1 ms 미만이면 배수 대신 절대 기준(5 ms 이상)으로 적는다(판정 규칙 5와 같음).
pub(crate) fn stair_reason_texts(st: &crate::stair::StairReport, idx: usize) -> Vec<String> {
    use crate::stair::ReasonKind;
    let step = &st.steps[idx];
    match step.state {
        crate::stair::StepState::EmergencyStopped => return vec!["즉시 정지".to_string()],
        crate::stair::StepState::Skipped => return vec!["실행 안 함".to_string()],
        crate::stair::StepState::Partial => {
            return vec![match &step.partial {
                Some(p) => {
                    let lead = if p.phase == crate::stair::BandKind::Ramp {
                        ""
                    } else {
                        "계단 "
                    };
                    format!("일부 실행 — {lead}{} 정지", stair_partial_where(p))
                }
                None => "일부 실행".to_string(),
            }];
        }
        _ => {}
    }
    let ref_p99 = stair_ref_step(st, step.index as usize).map(|s| s.p99_us);
    let mut out: Vec<String> = step
        .reasons
        .iter()
        .map(|r| match r.kind {
            ReasonKind::Achieved => format!("달성 {}", floor_pct1(r.value)),
            ReasonKind::Dropped => format!("dropped {}", group_thousands(r.value.round() as u64)),
            ReasonKind::Errors => format!("오류 {}", floor_pct1(r.value)),
            ReasonKind::P99Cap => "p99 상한 초과".to_string(),
            ReasonKind::P99Relative => match ref_p99 {
                Some(p) if p < 1000 => "p99 5 ms 이상".to_string(),
                _ => format!("p99 {}×", js_to_fixed(r.value, 1)),
            },
        })
        .collect();
    if step.slot_limited {
        out.push("슬롯 부족 의심".to_string());
    }
    out
}

/// 사유 칸 한 줄(화면 표와 같은 ` · ` 구분).
pub(crate) fn stair_reasons_text(st: &crate::stair::StairReport, idx: usize) -> String {
    stair_reason_texts(st, idx).join(" · ")
}

fn stair_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

fn stair_ms(us: u64) -> String {
    format!("{:.3}", us as f64 / 1000.0)
}

const STAIR_CSV_COLUMNS: [&str; 13] = [
    "index",
    "target_per_s",
    "achieved_per_s",
    "throughput_rps",
    "p50_ms",
    "p95_ms",
    "p99_ms",
    "error_rate",
    "dropped",
    "measure_start",
    "measure_end",
    "state",
    "reasons",
];

fn stair_state_name(s: crate::stair::StepState) -> &'static str {
    use crate::stair::StepState::*;
    match s {
        Ok => "ok",
        Spike => "spike",
        Saturated => "saturated",
        Unconfirmed => "unconfirmed",
        After => "after",
        NotMeasured => "not_measured",
        EmergencyStopped => "emergency_stopped",
        Partial => "partial",
        Skipped => "skipped",
    }
}

/// 오류율(비율) 칸: 소수 여섯째 자리 고정. 0이 아닌데 그 자리에서 0으로 보일 값은 반올림하지
/// 않고 전체 자릿수로 적는다 — 오류가 있었는데 없던 것처럼 읽히지 않게(화면 「<0.1%」와 같은 뜻).
fn stair_rate(r: f64) -> String {
    let fixed = format!("{r:.6}");
    if r > 0.0 && fixed == "0.000000" {
        r.to_string()
    } else {
        fixed
    }
}

/// 계단 표 CSV: 머리말 줄마다 한 행(칸 하나, `stair_headline_lines` — 화면 판정 상자와 같은
/// 줄·순서 + 안내 줄), 빈 줄 하나, 그다음 머리글+표. 머리말 줄 수는 run마다 다르니 읽는 쪽은
/// 첫 빈 줄까지 건너뛴다. 측정 안 된 계단의 숫자 칸은 빈 칸. 계단 run이 아니면 `None`.
pub fn report_to_stairs_csv(report: &ReportJson) -> Option<Vec<u8>> {
    let st = report.stair.as_ref()?;
    let mut head = csv::Writer::from_writer(Vec::new());
    for line in stair_headline_lines(st) {
        head.write_record([line]).expect("csv headline");
    }
    let mut out = head.into_inner().expect("csv flush");
    out.push(b'\n');
    let mut w = csv::Writer::from_writer(out);
    w.write_record(STAIR_CSV_COLUMNS).expect("csv header");
    for (i, s) in st.steps.iter().enumerate() {
        let measured = s.state.shows_numbers();
        let num = |v: String| if measured { v } else { String::new() };
        // 분포의 바닥이 1µs라 p99 0은 표본 없음뿐이다 — 화면 계단 표와 같은 규칙.
        let timed = measured && s.p99_us > 0;
        let ms = |us: u64| if timed { stair_ms(us) } else { String::new() };
        w.write_record([
            s.index.to_string(),
            s.target.to_string(),
            num(s.achieved.map(|a| format!("{a:.2}")).unwrap_or_default()),
            num(format!("{:.2}", s.throughput_rps)),
            ms(s.p50_us),
            ms(s.p95_us),
            ms(s.p99_us),
            num(stair_rate(s.error_rate)),
            num(s.dropped.map(|d| d.to_string()).unwrap_or_default()),
            num(stair_iso(s.measure_start_ms)),
            num(stair_iso(s.measure_end_ms)),
            stair_state_name(s.state).to_string(),
            stair_reasons_text(st, i),
        ])
        .expect("csv row");
    }
    Some(w.into_inner().expect("csv flush"))
}

/// `Stairs` 시트: 머리말 줄들(CSV와 같은 `stair_headline_lines`) → 빈 행 → 머리글 → 표.
fn write_stairs_sheet(wb: &mut Workbook, st: &crate::stair::StairReport) {
    let ws = wb.add_worksheet();
    ws.set_name("Stairs").expect("sheet name");
    let lines = stair_headline_lines(st);
    for (r, line) in lines.iter().enumerate() {
        ws.write_string(r as u32, 0, line).expect("w");
    }
    let header_row = lines.len() as u32 + 1;
    let cols = [
        "index",
        "target_per_s",
        "achieved_per_s",
        "launched_per_s",
        "throughput_rps",
        "p50_ms",
        "p95_ms",
        "p99_ms",
        "error_rate",
        "dropped",
        "measured_seconds",
        "measure_start",
        "measure_end",
        "state",
        "reasons",
    ];
    for (c, h) in cols.iter().enumerate() {
        ws.write_string(header_row, c as u16, *h).expect("w");
    }
    for (i, s) in st.steps.iter().enumerate() {
        let r = header_row + 1 + i as u32;
        let measured = s.state.shows_numbers();
        ws.write_number(r, 0, f64::from(s.index)).expect("w");
        ws.write_number(r, 1, f64::from(s.target)).expect("w");
        if measured {
            if let Some(a) = s.achieved {
                ws.write_number(r, 2, a).expect("w");
            }
            if let Some(l) = s.launched_rate {
                ws.write_number(r, 3, l).expect("w");
            }
            ws.write_number(r, 4, s.throughput_rps).expect("w");
            // p99 0 = 표본 없음(CSV와 같은 규칙) — 세 칸을 비운다.
            if s.p99_us > 0 {
                ws.write_number(r, 5, s.p50_us as f64 / 1000.0).expect("w");
                ws.write_number(r, 6, s.p95_us as f64 / 1000.0).expect("w");
                ws.write_number(r, 7, s.p99_us as f64 / 1000.0).expect("w");
            }
            ws.write_number(r, 8, s.error_rate).expect("w");
            if let Some(d) = s.dropped {
                ws.write_number(r, 9, d as f64).expect("w");
            }
        }
        ws.write_number(r, 10, f64::from(s.measured_seconds))
            .expect("w");
        if measured {
            ws.write_string(r, 11, stair_iso(s.measure_start_ms))
                .expect("w");
            ws.write_string(r, 12, stair_iso(s.measure_end_ms))
                .expect("w");
        }
        ws.write_string(r, 13, stair_state_name(s.state))
            .expect("w");
        ws.write_string(r, 14, stair_reasons_text(st, i))
            .expect("w");
    }
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
            wait: None,
            loop_split: None,
            not_sent: None,
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
                label: None,
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
            error_kinds: vec![],
            loop_exits: vec![],
            verdict: None,
            insights: vec![],
            dropped: 0,
            latency: None,
            group_latency: vec![],
            active_vu_series: vec![],
            active_vu_by_worker: vec![],
            worker_breakdown: vec![],
            connection: None,
            validity: Default::default(),
            narrative: Default::default(),
            stair: None,
            speed_bands: None,
            basis: None,
            setup: None,
            sample: Default::default(),
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
    fn golden_polarity_matches() {
        let g: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/compare_golden.json"
        )))
        .expect("golden parse");
        let rows = g["expected"]["polarity"].as_array().unwrap();
        assert_eq!(rows.len(), 12);
        for row in rows {
            let metric = row["metric"].as_str().unwrap();
            let base = row["base"].as_f64().unwrap();
            let val = row["val"].as_f64().unwrap();
            let d = delta(metric, base, val);
            match row["pct"].as_f64() {
                None => assert!(d.pct.is_none(), "{metric} {base}->{val}: pct null"),
                Some(p) => assert!(
                    (d.pct.unwrap() - p).abs() < 1e-12,
                    "{metric} {base}->{val}: pct"
                ),
            }
            assert_eq!(
                format!("{:?}", d.polarity).to_lowercase(),
                row["polarity"].as_str().unwrap(),
                "{metric} {base}->{val}"
            );
        }
    }

    #[test]
    fn xlsx_roundtrips_summary_and_steps() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;

        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.summary.count = 123;
        let bytes = report_to_xlsx(&r, None);

        let mut wb: Xlsx<Cursor<Vec<u8>>> =
            open_workbook_from_rs(Cursor::new(bytes)).expect("read xlsx");
        let summary = wb.worksheet_range("Summary").expect("Summary sheet");
        assert_eq!(summary.get_value((0, 1)), Some(&Data::Float(123.0)));
        let steps = wb.worksheet_range("Steps").expect("Steps sheet");
        assert_eq!(steps.get_value((1, 0)), Some(&Data::String("a".into())));
        assert_eq!(steps.get_value((1, 4)), Some(&Data::Float(50.0)));
    }

    #[test]
    fn xlsx_summary_includes_validity_rows() {
        // H2: rows 0–6 remain numeric; 7–8 Data::String.
        use crate::validity::{Validity, ValidityReason};
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;

        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.summary.count = 123;
        r.validity = Validity {
            level: "suspect".into(),
            reasons: vec![
                ValidityReason {
                    kind: "transport_heavy".into(),
                    severity: "critical".into(),
                    pct: Some(0.8),
                    count: Some(80),
                    step_id: None,
                    metric: None,
                    value: None,
                },
                ValidityReason {
                    kind: "load_not_delivered".into(),
                    severity: "warning".into(),
                    pct: None,
                    count: Some(7),
                    step_id: None,
                    metric: None,
                    value: None,
                },
            ],
        };
        let bytes = report_to_xlsx(&r, None);
        let mut wb: Xlsx<Cursor<Vec<u8>>> =
            open_workbook_from_rs(Cursor::new(bytes)).expect("read xlsx");
        let summary = wb.worksheet_range("Summary").expect("Summary sheet");
        // rows 0–6 numeric summary unchanged
        assert_eq!(summary.get_value((0, 1)), Some(&Data::Float(123.0)));
        assert_eq!(
            summary.get_value((7, 0)),
            Some(&Data::String("validity_level".into()))
        );
        assert_eq!(
            summary.get_value((7, 1)),
            Some(&Data::String("suspect".into()))
        );
        assert_eq!(
            summary.get_value((8, 0)),
            Some(&Data::String("validity_reason_kinds".into()))
        );
        assert_eq!(
            summary.get_value((8, 1)),
            Some(&Data::String("transport_heavy,load_not_delivered".into()))
        );
        // 이 테스트의 워크시트 바인딩명은 `summary`다(위 `let summary = ...`) —
        // 옆 테스트(`xlsx_roundtrips_summary_and_steps`)의 `ws`가 아니다.
        // narrative_events_count 행은 제거됨: 9행은 맨 끝 latency_sample이고 그 뒤는 비어 있다.
        assert_eq!(
            summary.get_value((9, 0)),
            Some(&Data::String("latency_sample".into()))
        );
        assert_eq!(summary.get_value((9, 1)), Some(&Data::String("all".into())));
        assert!(
            matches!(summary.get_value((10, 0)), None | Some(Data::Empty)),
            "narrative_events_count 행 제거됨"
        );
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
                achieved_per_sec: None,
                target_per_sec: None,
                runner_up_ms: Some(90.0),
                error_kind: None,
                typical_in_flight: None,
                max_in_flight: None,
                drop_seconds: None,
                measured_seconds: None,
            },
            // 사이징 3필드 + achieved/target_per_sec를 모두 채운 합성 행: 다섯 새 열
            // writer를 모두 운동시킨다. (실제 인사이트는 원인별로 이 필드 중 일부만
            // 채우지만, 그 배타성은 insights.rs의 불변식이지 export writer의 관심사가
            // 아니다.)
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
                achieved_per_sec: Some(2.5),
                target_per_sec: Some(20.0),
                runner_up_ms: None,
                error_kind: Some("connection_reset".into()),
                typical_in_flight: None,
                max_in_flight: None,
                drop_seconds: None,
                measured_seconds: None,
            },
        ];
        let bytes = report_to_xlsx(&r, None);
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
        // 새 14/15번째 열 achieved_per_sec/target_per_sec (col 13/14 = N/O)
        assert_eq!(
            ws.get_value((0, 13)),
            Some(&Data::String("achieved_per_sec".into()))
        );
        assert_eq!(
            ws.get_value((0, 14)),
            Some(&Data::String("target_per_sec".into()))
        );
        // 사이징 행(벡터 인덱스 1 → 시트 row 2)의 achieved/target_per_sec = 2.5/20.0
        assert_eq!(ws.get_value((2, 13)), Some(&Data::Float(2.5)));
        assert_eq!(ws.get_value((2, 14)), Some(&Data::Float(20.0)));
        // slowest_step 행(row 1)은 achieved/target None → 미기록(None 또는 Empty)
        assert!(matches!(ws.get_value((1, 13)), None | Some(Data::Empty)));
        assert!(matches!(ws.get_value((1, 14)), None | Some(Data::Empty)));
        // 16번째 열 runner_up_ms (col 15 = P)
        assert_eq!(
            ws.get_value((0, 15)),
            Some(&Data::String("runner_up_ms".into()))
        );
        // slowest_step 행은 runner_up_ms 보유
        assert_eq!(ws.get_value((1, 15)), Some(&Data::Float(90.0)));
        // 사이징 행은 None → 미기록(None 또는 Empty 양쪽 허용)
        assert!(matches!(ws.get_value((2, 15)), None | Some(Data::Empty)));
        // 17번째 열 error_kind (col 16 = Q, F2 — 이전엔 두 픽스처 모두 None이라
        // if let Some 분기가 어떤 테스트에서도 실행되지 않았다).
        assert_eq!(
            ws.get_value((0, 16)),
            Some(&Data::String("error_kind".into()))
        );
        // 사이징 행(벡터 인덱스 1 → 시트 row 2)의 error_kind = "connection_reset"
        assert_eq!(
            ws.get_value((2, 16)),
            Some(&Data::String("connection_reset".into()))
        );
        // slowest_step 행(row 1)은 error_kind None → 미기록(None 또는 Empty)
        assert!(matches!(ws.get_value((1, 16)), None | Some(Data::Empty)));
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
        // Δ 열(col 3 = delta_start = 1 metric + 2 run 값 뒤). p95 100→150:
        // lower_is_better, val>base → Bad, pct=+50.0% → "▲ +50.0%".
        assert_eq!(
            sum.get_value((2, 3)),
            Some(&calamine::Data::String("▲ +50.0%".into()))
        );

        // Steps 시트: A·B 둘 다 step "s"를 가짐. row1 = "s",
        // col1 = A p95 = 100, col2 = B p95 = 150, Δ start = 1+N = 3 → Δ%B col3.
        let st = wb.worksheet_range("Steps").unwrap();
        assert_eq!(st.get_value((1, 1)), Some(&Data::Float(100.0)));
        assert_eq!(st.get_value((1, 2)), Some(&Data::Float(150.0)));
        assert_eq!(st.get_value((1, 3)), Some(&Data::String("▲ +50.0%".into())));
    }

    #[test]
    fn comparison_xlsx_runs_sheet_has_label_column() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;
        let mut a = report_with_steps(vec![step("s", 1, 100)]);
        a.run.id = "A".into();
        a.run.label = Some("기준 라벨".into());
        let mut b = report_with_steps(vec![step("s", 1, 150)]);
        b.run.id = "B".into();
        // b.run.label 은 무라벨(None) 그대로 — 빈 셀 기대.
        let bytes = comparison_to_xlsx(&[a, b], 0);
        let mut wb: Xlsx<Cursor<Vec<u8>>> = open_workbook_from_rs(Cursor::new(bytes)).unwrap();
        let runs = wb.worksheet_range("Runs").unwrap();

        // 헤더 6열 정확일치, label이 2번째.
        assert_eq!(runs.get_value((0, 0)), Some(&Data::String("run_id".into())));
        assert_eq!(runs.get_value((0, 1)), Some(&Data::String("label".into())));
        assert_eq!(runs.get_value((0, 2)), Some(&Data::String("status".into())));
        assert_eq!(
            runs.get_value((0, 3)),
            Some(&Data::String("started_at".into()))
        );
        assert_eq!(
            runs.get_value((0, 4)),
            Some(&Data::String("ended_at".into()))
        );
        assert_eq!(runs.get_value((0, 5)), Some(&Data::String("count".into())));

        // row1 = A(유라벨): label 셀에 문자열.
        assert_eq!(runs.get_value((1, 0)), Some(&Data::String("A".into())));
        assert_eq!(
            runs.get_value((1, 1)),
            Some(&Data::String("기준 라벨".into()))
        );
        // M5 fix: status/count 열도 단언(이전엔 col 0·1만 확인) — report_with_steps 픽스처는
        // status="completed"·summary.count=0 고정(둘 다 오버라이드 안 됨, 위에서 확인).
        assert_eq!(
            runs.get_value((1, 2)),
            Some(&Data::String("completed".into()))
        );
        assert_eq!(runs.get_value((1, 5)), Some(&Data::Float(0.0)));

        // row2 = B(무라벨): label 셀 빈 문자열(`write_string("")`)
        // — calamine은 이를 `Data::Empty`로 읽는다(빈 셀과 구별 불가, export.rs 기존 blank 관례).
        assert_eq!(runs.get_value((2, 0)), Some(&Data::String("B".into())));
        assert!(matches!(runs.get_value((2, 1)), None | Some(Data::Empty)));
    }

    #[test]
    fn comparison_xlsx_steps_delta() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;
        // A = baseline(idx0), B(idx1), C(idx2).
        // 스텝 이름을 알파벳순으로 둬 union sort 후 행 인덱스를 고정한다.
        let mut a = report_with_steps(vec![
            step("b_align", 1, 100),      // A·C에 있고 B엔 없음 → 정렬 테스트
            step("c_candabsent", 1, 100), // A·B에 있고 C엔 없음 → candidate-absent
            step("d_newbase0", 1, 0),     // A에 p95=0(present-but-zero), C는 >0
        ]);
        a.run.id = "A".into();
        let mut b = report_with_steps(vec![step("c_candabsent", 1, 100)]);
        b.run.id = "B".into();
        let mut c = report_with_steps(vec![
            step("a_absentbase", 1, 80), // C에만 있음(A 없음) → absent-baseline
            step("b_align", 1, 200),
            step("d_newbase0", 1, 50),
        ]);
        c.run.id = "C".into();
        let bytes = comparison_to_xlsx(&[a, b, c], 0);
        let mut wb: Xlsx<Cursor<Vec<u8>>> = open_workbook_from_rs(Cursor::new(bytes)).unwrap();
        let st = wb.worksheet_range("Steps").unwrap();
        // 열: step_id=0, A=1, B=2, C=3; delta_start = 1+3 = 4 → Δ%B=4, Δ%C=5.
        // 행(union sort): a_absentbase=1, b_align=2, c_candabsent=3, d_newbase0=4.
        let blank = |v: Option<&Data>| matches!(v, None | Some(Data::Empty));

        // row1 a_absentbase: A 없음·C=80, base=None → Δ 둘 다 블랭크
        // (unwrap_or(0.0)였다면 Δ%C가 "▲ 신규" → 이 단언이 회귀 가드).
        assert!(blank(st.get_value((1, 1))));
        assert_eq!(st.get_value((1, 3)), Some(&Data::Float(80.0)));
        assert!(blank(st.get_value((1, 4))));
        assert!(blank(st.get_value((1, 5))));

        // row2 b_align: A=100·B 없음·C=200 → 정렬: Δ%B(4) 블랭크, Δ%C(5)="▲ +100.0%"
        // (B의 블랭크가 C의 Δ를 col4로 당기지 않음 = Finding 2 가드).
        assert_eq!(st.get_value((2, 1)), Some(&Data::Float(100.0)));
        assert!(blank(st.get_value((2, 2))));
        assert_eq!(st.get_value((2, 3)), Some(&Data::Float(200.0)));
        assert!(blank(st.get_value((2, 4))));
        assert_eq!(
            st.get_value((2, 5)),
            Some(&Data::String("▲ +100.0%".into()))
        );

        // row3 c_candabsent: A=100·B=100·C 없음 → C 값 셀·Δ%C 블랭크.
        assert!(blank(st.get_value((3, 3))));
        assert!(blank(st.get_value((3, 5))));

        // row4 d_newbase0: A=0(present)·C=50 → present-but-zero → Δ%C="▲ 신규"
        // (row1 absent=블랭크와 대조: present-but-zero만 "신규").
        assert_eq!(st.get_value((4, 1)), Some(&Data::Float(0.0)));
        assert_eq!(st.get_value((4, 5)), Some(&Data::String("▲ 신규".into())));
    }

    fn basis_block(
        selected: crate::steady::Basis,
        state: crate::steady::BasisState,
        window: Option<crate::steady::BasisWindow>,
    ) -> crate::steady::BasisBlock {
        crate::steady::BasisBlock {
            selected,
            default: crate::steady::Basis::Steady,
            state,
            config: crate::steady::SteadyConfig {
                ramp_seconds: 30,
                hold_seconds: 270,
                discard_seconds: 5,
                target: None,
            },
            window,
            t0_estimated: false,
            dropped_whole_run: false,
            other: None,
        }
    }

    fn read_xlsx(bytes: Vec<u8>) -> calamine::Xlsx<std::io::Cursor<Vec<u8>>> {
        use calamine::open_workbook_from_rs;
        open_workbook_from_rs(std::io::Cursor::new(bytes)).unwrap()
    }

    fn is_blank(v: Option<&calamine::Data>) -> bool {
        matches!(v, None | Some(calamine::Data::Empty))
    }

    #[test]
    fn xlsx_summary_has_basis_rows() {
        use crate::steady::{Basis, BasisState, BasisWindow};
        use calamine::{Data, Reader};
        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.basis = Some(basis_block(
            Basis::Steady,
            BasisState::Measured,
            Some(BasisWindow {
                start_ms: 1_000_000,
                end_ms: 1_265_000,
                measured_seconds: 265,
            }),
        ));
        let mut wb = read_xlsx(report_to_xlsx(&r, None));
        let ws = wb.worksheet_range("Summary").unwrap();
        assert_eq!(ws.get_value((9, 0)), Some(&Data::String("basis".into())));
        assert_eq!(ws.get_value((9, 1)), Some(&Data::String("steady".into())));
        assert_eq!(
            ws.get_value((10, 0)),
            Some(&Data::String("basis_default".into()))
        );
        assert_eq!(ws.get_value((10, 1)), Some(&Data::String("steady".into())));
        assert_eq!(
            ws.get_value((11, 0)),
            Some(&Data::String("basis_state".into()))
        );
        assert_eq!(
            ws.get_value((11, 1)),
            Some(&Data::String("measured".into()))
        );
        let keys = [
            (12, "basis_ramp_seconds", 30.0),
            (13, "basis_discard_seconds", 5.0),
            (14, "basis_window_start_ms", 1_000_000.0),
            (15, "basis_window_end_ms", 1_265_000.0),
            (16, "basis_measured_seconds", 265.0),
        ];
        for (row, key, v) in keys {
            assert_eq!(ws.get_value((row, 0)), Some(&Data::String(key.into())));
            assert_eq!(ws.get_value((row, 1)), Some(&Data::Float(v)), "{key}");
        }
        assert_eq!(
            ws.get_value((17, 0)),
            Some(&Data::String("latency_sample".into()))
        );
        assert_eq!(ws.get_value((17, 1)), Some(&Data::String("all".into())));
        assert!(is_blank(ws.get_value((18, 0))));
    }

    #[test]
    fn xlsx_other_basis_sheet_holds_other_summary_and_steps() {
        use crate::steady::{Basis, BasisState};
        use calamine::{Data, Reader};
        let mut first = report_with_steps(vec![step("a", 10, 50)]);
        first.summary.count = 100;
        first.basis = Some(basis_block(Basis::Steady, BasisState::Measured, None));
        let mut other = report_with_steps(vec![step("a", 77, 90)]);
        other.summary.count = 300;
        other.summary.p95_ms = 90;
        other.basis = Some(basis_block(Basis::Whole, BasisState::Measured, None));
        let mut wb = read_xlsx(report_to_xlsx(&first, Some(&other)));
        let ob = wb.worksheet_range("Other basis").unwrap();
        assert_eq!(ob.get_value((0, 0)), Some(&Data::String("basis".into())));
        assert_eq!(ob.get_value((0, 1)), Some(&Data::String("whole".into())));
        assert_eq!(ob.get_value((1, 0)), Some(&Data::String("count".into())));
        assert_eq!(ob.get_value((1, 1)), Some(&Data::Float(300.0)));
        assert_eq!(ob.get_value((6, 0)), Some(&Data::String("p95_ms".into())));
        assert_eq!(ob.get_value((6, 1)), Some(&Data::Float(90.0)));
        assert_eq!(ob.get_value((9, 0)), Some(&Data::String("step_id".into())));
        assert_eq!(ob.get_value((10, 0)), Some(&Data::String("a".into())));
        assert_eq!(ob.get_value((10, 1)), Some(&Data::Float(77.0)));
        let steps = wb.worksheet_range("Steps").unwrap();
        assert_eq!(steps.get_value((1, 1)), Some(&Data::Float(10.0)));
        assert_ne!(steps.get_value((1, 1)), ob.get_value((10, 1)));
        let summary = wb.worksheet_range("Summary").unwrap();
        assert_eq!(summary.get_value((0, 1)), Some(&Data::Float(100.0)));
        assert_ne!(summary.get_value((0, 1)), ob.get_value((1, 1)));
    }

    #[test]
    fn xlsx_without_other_basis_has_no_other_sheet() {
        use crate::steady::{Basis, BasisState};
        use calamine::{Data, Reader};
        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.basis = Some(basis_block(Basis::Whole, BasisState::NotReached, None));
        let mut wb = read_xlsx(report_to_xlsx(&r, None));
        assert!(!wb.sheet_names().iter().any(|n| n == "Other basis"));
        let ws = wb.worksheet_range("Summary").unwrap();
        assert_eq!(ws.get_value((9, 1)), Some(&Data::String("whole".into())));
        assert_eq!(
            ws.get_value((11, 1)),
            Some(&Data::String("not_reached".into()))
        );
        assert_eq!(
            ws.get_value((14, 0)),
            Some(&Data::String("latency_sample".into()))
        );
        assert_eq!(ws.get_value((14, 1)), Some(&Data::String("all".into())));
        assert!(is_blank(ws.get_value((15, 0))));
    }

    #[test]
    fn xlsx_without_basis_is_unchanged() {
        use calamine::{Data, Reader};
        let r = report_with_steps(vec![step("a", 10, 50)]);
        let mut wb = read_xlsx(report_to_xlsx(&r, None));
        assert_eq!(
            wb.sheet_names(),
            vec!["Summary", "Steps", "Windows", "Status"]
        );
        let ws = wb.worksheet_range("Summary").unwrap();
        assert_eq!(
            ws.get_value((9, 0)),
            Some(&Data::String("latency_sample".into()))
        );
        assert_eq!(ws.get_value((9, 1)), Some(&Data::String("all".into())));
        assert!(is_blank(ws.get_value((10, 0))));
    }

    #[test]
    fn comparison_exports_mark_basis_per_run() {
        use crate::steady::{Basis, BasisState};
        use calamine::{Data, Reader};
        let mut a = report_with_steps(vec![step("a", 1, 10)]);
        a.run.id = "A".into();
        a.basis = Some(basis_block(Basis::Steady, BasisState::Measured, None));
        let mut b = report_with_steps(vec![step("a", 1, 10)]);
        b.run.id = "B".into();
        let reports = [a, b];
        let csv = String::from_utf8(comparison_to_csv(&reports, 0)).unwrap();
        assert_eq!(csv.lines().last().unwrap(), "basis,steady,whole,");
        assert_eq!(csv.lines().count(), 2 + SUMMARY_METRICS.len());
        let mut wb = read_xlsx(comparison_to_xlsx(&reports, 0));
        let runs = wb.worksheet_range("Runs").unwrap();
        assert_eq!(runs.get_value((0, 6)), Some(&Data::String("basis".into())));
        assert_eq!(runs.get_value((1, 6)), Some(&Data::String("steady".into())));
        assert_eq!(runs.get_value((2, 6)), Some(&Data::String("whole".into())));
    }

    #[test]
    fn comparison_exports_unchanged_without_basis() {
        use calamine::{Data, Reader};
        let mut a = report_with_steps(vec![step("a", 1, 10)]);
        a.run.id = "A".into();
        let mut b = report_with_steps(vec![step("a", 1, 10)]);
        b.run.id = "B".into();
        let reports = [a, b];
        let csv = String::from_utf8(comparison_to_csv(&reports, 0)).unwrap();
        assert_eq!(csv.lines().count(), 1 + SUMMARY_METRICS.len());
        let mut wb = read_xlsx(comparison_to_xlsx(&reports, 0));
        let runs = wb.worksheet_range("Runs").unwrap();
        assert_eq!(
            runs.get_value((0, 6)),
            Some(&Data::String("latency_sample".into()))
        );
        assert!(is_blank(runs.get_value((0, 7))));
    }

    #[test]
    fn format_pct_mirrors_ui() {
        assert_eq!(format_pct(0.5), "+50.0%");
        assert_eq!(format_pct(-0.029), "-2.9%");
        assert_eq!(format_pct(0.0), "+0.0%");
        assert_eq!(format_pct(1.0), "+100.0%");
    }

    #[test]
    fn delta_cell_text_mirrors_deltachip() {
        use Polarity::*;
        // 일반 pct + 글리프
        assert_eq!(
            delta_cell_text(
                &Delta {
                    pct: Some(0.5),
                    polarity: Bad
                },
                150.0
            ),
            "▲ +50.0%"
        );
        assert_eq!(
            delta_cell_text(
                &Delta {
                    pct: Some(-0.182),
                    polarity: Good
                },
                9.0
            ),
            "▼ -18.2%"
        );
        // 동률(val==base) → Neutral, 글리프 없음
        assert_eq!(
            delta_cell_text(
                &Delta {
                    pct: Some(0.0),
                    polarity: Neutral
                },
                100.0
            ),
            "+0.0%"
        );
        // base=0 → "신규"/"동일" (골든 fixture 미커버 분기 — spec §5.1 nit)
        assert_eq!(
            delta_cell_text(
                &Delta {
                    pct: None,
                    polarity: Good
                },
                9.0
            ),
            "▼ 신규"
        );
        assert_eq!(
            delta_cell_text(
                &Delta {
                    pct: None,
                    polarity: Bad
                },
                5.0
            ),
            "▲ 신규"
        );
        assert_eq!(
            delta_cell_text(
                &Delta {
                    pct: None,
                    polarity: Neutral
                },
                0.0
            ),
            "동일"
        );
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
            achieved_per_sec: None,
            target_per_sec: None,
            runner_up_ms: None,
            error_kind: None,
            typical_in_flight: None,
            max_in_flight: None,
            drop_seconds: None,
            measured_seconds: None,
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
            "kind,severity,step_id,metric,value,pct,count,status_class,window_seconds,recommended,cause,recommended_workers,onset_second,achieved_per_sec,target_per_sec,runner_up_ms,error_kind,typical_in_flight,max_in_flight,drop_seconds,measured_seconds"
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
    fn insight_error_kind_column_round_trips() {
        // E2: 17번째 열 `error_kind`. Some이면 셀에 kind 문자열, None이면 빈 셀.
        // error_kind는 17번째 열(인덱스 16)이고, 이제 마지막 열은 `measured_seconds`다.
        assert_eq!(
            INSIGHT_COLUMNS.len(),
            21,
            "stall이 숫자 4열을 더해 17→21이어야 한다"
        );
        assert_eq!(INSIGHT_COLUMNS[16], "error_kind");
        assert_eq!(
            *INSIGHT_COLUMNS.last().expect("non-empty"),
            "measured_seconds"
        );

        let mut ins = insight("midrun_error_onset", "critical");
        ins.error_kind = Some("connection_reset".to_string());
        let cells = insight_csv_cells(&ins);
        assert_eq!(cells.len(), 21);
        assert_eq!(cells[16], "connection_reset");

        let bare = insight("slo_pass", "info");
        let bare_cells = insight_csv_cells(&bare);
        assert_eq!(bare_cells.len(), 21);
        assert_eq!(bare_cells[16], "", "None → 빈 문자열");
    }

    fn stall_insight() -> crate::insights::Insight {
        crate::insights::Insight {
            cause: Some("stall".into()),
            typical_in_flight: Some(14),
            max_in_flight: Some(2500),
            drop_seconds: Some(18),
            measured_seconds: Some(60),
            ..insight("load_gen_saturated", "warning")
        }
    }

    #[test]
    fn insight_stall_columns_round_trip() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;
        let stall = stall_insight();
        let slots = insight("load_gen_saturated", "warning");
        let cells = insight_csv_cells(&stall);
        assert_eq!(cells.len(), 21);
        assert_eq!(&cells[17..=20], ["14", "2500", "18", "60"]);
        let bare = insight_csv_cells(&slots);
        assert_eq!(&bare[17..=20], ["", "", "", ""]);

        let names = [
            "typical_in_flight",
            "max_in_flight",
            "drop_seconds",
            "measured_seconds",
        ];
        let vals = [14.0, 2500.0, 18.0, 60.0];

        // 단일 XLSX
        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.insights = vec![stall.clone(), slots.clone()];
        let mut wb: Xlsx<Cursor<Vec<u8>>> =
            open_workbook_from_rs(Cursor::new(report_to_xlsx(&r, None))).unwrap();
        let ws = wb.worksheet_range("Insights").expect("Insights sheet");
        for i in 0..4u32 {
            let c = 17 + i;
            assert_eq!(
                ws.get_value((0, c)),
                Some(&Data::String(names[i as usize].into()))
            );
            assert_eq!(ws.get_value((1, c)), Some(&Data::Float(vals[i as usize])));
            assert!(matches!(ws.get_value((2, c)), None | Some(Data::Empty)));
        }

        // 비교 XLSX (run_id 열 뒤로 한 칸)
        let mut a = report_with_steps(vec![step("s", 1, 100)]);
        a.run.id = "A".into();
        a.insights = vec![stall.clone(), slots.clone()];
        let mut b = report_with_steps(vec![step("s", 1, 50)]);
        b.run.id = "B".into();
        let pair = [a, b];
        let mut wb: Xlsx<Cursor<Vec<u8>>> =
            open_workbook_from_rs(Cursor::new(comparison_to_xlsx(&pair, 0))).unwrap();
        let ws = wb.worksheet_range("Insights").expect("Insights sheet");
        for i in 0..4u32 {
            let c = 18 + i;
            assert_eq!(
                ws.get_value((0, c)),
                Some(&Data::String(names[i as usize].into()))
            );
            assert_eq!(ws.get_value((1, c)), Some(&Data::Float(vals[i as usize])));
            assert!(matches!(ws.get_value((2, c)), None | Some(Data::Empty)));
        }

        // 비교 CSV
        let csv = String::from_utf8(comparison_to_insights_csv(&pair)).unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert!(lines[1].ends_with(",14,2500,18,60"), "{}", lines[1]);
        assert!(
            lines[2].ends_with("warning,,,,,,,,,,,,,,,,,,,"),
            "{}",
            lines[2]
        );
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
            "run_id,kind,severity,step_id,metric,value,pct,count,status_class,window_seconds,recommended,cause,recommended_workers,onset_second,achieved_per_sec,target_per_sec,runner_up_ms,error_kind,typical_in_flight,max_in_flight,drop_seconds,measured_seconds"
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

    fn stair_step(
        index: u32,
        target: u32,
        state: crate::stair::StepState,
        p99_us: u64,
        reasons: Vec<crate::stair::Reason>,
    ) -> crate::stair::StairStep {
        crate::stair::StairStep {
            index,
            target,
            achieved: Some(target as f64),
            launched_rate: Some(target as f64),
            throughput_rps: target as f64,
            p50_us: 4001,
            p95_us: 5000,
            p99_us,
            error_rate: 0.0,
            dropped: Some(0),
            measured_seconds: 20,
            measure_start_ms: 1_700_000_000_000 + i64::from(index) * 1000,
            measure_end_ms: 1_700_000_020_000 + i64::from(index) * 1000,
            state,
            reasons,
            knee: false,
            slot_limited: false,
            head_p99_ratio: None,
            discard_warning: false,
            partial: None,
        }
    }

    fn stair_report(
        kind: crate::stair::HeadlineKind,
        sat: Option<u32>,
        last: Option<u32>,
        through: Option<u32>,
        hint: bool,
        steps: Vec<crate::stair::StairStep>,
    ) -> crate::stair::StairReport {
        crate::stair::StairReport {
            config: crate::stair::StairConfig {
                targets: steps.iter().map(|s| s.target).collect(),
                hold_seconds: 25,
                ramp_seconds: 1,
                discard_seconds: 5,
                p99_cap_ms: None,
                auto_stop: None,
            },
            steps,
            headline: crate::stair::StairHeadline {
                kind,
                saturated_target: sat,
                last_ok_target: last,
                through_target: through,
                first_fail_hint: hint,
            },
            knee_target: None,
            spike_targets: vec![],
            max_in_flight: None,
            dropped_total: None,
            dropped_explained: false,
            slot_limited_targets: vec![],
            notes: Default::default(),
            seconds: vec![],
            bands: vec![],
            target_line: vec![],
            auto_stop: None,
        }
    }

    fn saturated_sample() -> crate::stair::StairReport {
        use crate::stair::{HeadlineKind, Reason, ReasonKind, StepState};
        let mut bad = stair_step(
            1,
            200,
            StepState::Saturated,
            1_234_000,
            vec![
                Reason {
                    kind: ReasonKind::Achieved,
                    value: 0.93,
                },
                Reason {
                    kind: ReasonKind::Dropped,
                    value: 12.0,
                },
                Reason {
                    kind: ReasonKind::Errors,
                    value: 0.02,
                },
                Reason {
                    kind: ReasonKind::P99Relative,
                    value: 3.4,
                },
            ],
        );
        bad.achieved = Some(186.0);
        bad.dropped = Some(12);
        bad.error_rate = 0.02;
        // 측정 안 된 계단도 숫자 필드가 채워져 있을 수 있다 — 내보내기는 화면처럼 빈 칸으로.
        let miss = stair_step(2, 300, StepState::NotMeasured, 0, vec![]);
        stair_report(
            HeadlineKind::Saturated,
            Some(200),
            Some(100),
            None,
            false,
            vec![stair_step(0, 100, StepState::Ok, 40_010, vec![]), bad, miss],
        )
    }

    #[test]
    fn stairs_csv_none_for_non_stair() {
        let r = report_with_steps(vec![step("a", 1, 1)]);
        assert!(report_to_stairs_csv(&r).is_none());
    }

    #[test]
    fn stairs_csv_header_and_rows() {
        let mut r = report_with_steps(vec![step("a", 1, 1)]);
        r.stair = Some(saturated_sample());
        let csv = String::from_utf8(report_to_stairs_csv(&r).unwrap()).unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "포화 계단 200 iter/s · 마지막 정상 100 iter/s");
        assert_eq!(lines[1], "");
        assert_eq!(
            lines[2],
            "index,target_per_s,achieved_per_s,throughput_rps,p50_ms,p95_ms,p99_ms,error_rate,dropped,measure_start,measure_end,state,reasons"
        );
        assert_eq!(
            lines[3],
            "0,100,100.00,100.00,4.001,5.000,40.010,0.000000,0,2023-11-14T22:13:20Z,2023-11-14T22:13:40Z,ok,"
        );
        assert_eq!(
            lines[4],
            "1,200,186.00,200.00,4.001,5.000,1234.000,0.020000,12,2023-11-14T22:13:21Z,2023-11-14T22:13:41Z,saturated,달성 93.0% · dropped 12 · 오류 2.0% · p99 3.4×"
        );
        assert_eq!(lines[5], "2,300,,,,,,,,,,not_measured,");
    }

    /// 측정된 계단인데 통과한 요청이 없다(`p99_us == 0`) — 응답 시간 세 칸은 0.000이 아니라 빈 칸.
    /// 나머지 숫자 칸은 그대로 쓴다. 화면 `StairTable`과 같은 규칙(`p99_us > 0` = 표본 있음).
    fn no_sample_stair_report() -> crate::stair::StairReport {
        use crate::stair::{HeadlineKind, StepState};
        let mut empty = stair_step(1, 200, StepState::Ok, 0, vec![]);
        empty.p50_us = 0;
        empty.p95_us = 0;
        empty.error_rate = 1.0;
        stair_report(
            HeadlineKind::Saturated,
            Some(200),
            Some(100),
            None,
            false,
            vec![stair_step(0, 100, StepState::Ok, 40_010, vec![]), empty],
        )
    }

    #[test]
    fn stairs_csv_blank_latency_when_no_passed_sample() {
        let mut r = report_with_steps(vec![step("a", 1, 1)]);
        r.stair = Some(no_sample_stair_report());
        let csv = String::from_utf8(report_to_stairs_csv(&r).unwrap()).unwrap();
        let rows: Vec<&str> = csv.lines().skip_while(|l| !l.is_empty()).skip(2).collect();
        assert!(rows[0].contains(",4.001,5.000,40.010,"), "{}", rows[0]);
        let cells: Vec<&str> = rows[1].split(',').collect();
        assert_eq!(&cells[4..7], &["", "", ""], "{}", rows[1]);
        assert_eq!(cells[3], "200.00", "처리량은 그대로");
        assert_eq!(cells[7], "1.000000", "오류율은 그대로");
    }

    #[test]
    fn xlsx_stairs_blank_latency_when_no_passed_sample() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;
        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.stair = Some(no_sample_stair_report());
        let mut wb: Xlsx<Cursor<Vec<u8>>> =
            open_workbook_from_rs(Cursor::new(report_to_xlsx(&r, None))).unwrap();
        let ws = wb.worksheet_range("Stairs").unwrap();
        // 머리말 1줄 + 빈 행 + 머리글 → 계단 0은 3행, 계단 1은 4행.
        assert_eq!(ws.get_value((2, 0)), Some(&Data::String("index".into())));
        assert_eq!(ws.get_value((3, 7)), Some(&Data::Float(40.01)));
        for c in [5u32, 6, 7] {
            assert!(
                matches!(ws.get_value((4, c)), None | Some(Data::Empty)),
                "col {c}: {:?}",
                ws.get_value((4, c))
            );
        }
        assert_eq!(ws.get_value((4, 4)), Some(&Data::Float(200.0)));
        assert_eq!(ws.get_value((4, 8)), Some(&Data::Float(1.0)));
    }

    #[test]
    fn stairs_csv_error_rate_fixed_and_never_rounds_errors_away() {
        assert_eq!(stair_rate(0.0), "0.000000");
        assert_eq!(stair_rate(1.0 / 3.0), "0.333333");
        assert_eq!(stair_rate(0.02), "0.020000");
        // 0이 아닌 미세값은 0.000000으로 적지 않는다.
        assert_eq!(stair_rate(2.5e-10), "0.00000000025");
    }

    #[test]
    fn js_to_fixed_rounds_ties_up_like_the_ui() {
        // Rust `{:.1}`은 2.25 → "2.2"(짝수), JS toFixed(1)은 "2.3".
        assert_eq!(format!("{:.1}", 2.25), "2.2");
        assert_eq!(js_to_fixed(2.25, 1), "2.3");
        assert_eq!(js_to_fixed(0.25, 1), "0.3");
        assert_eq!(js_to_fixed(2.5, 0), "3");
        // 정확히 반이 아닌 값(0.15 = 0.1499…)은 내림 — JS와 같다.
        assert_eq!(js_to_fixed(0.15, 1), "0.1");
        assert_eq!(js_to_fixed(1.05, 1), "1.1");
        assert_eq!(js_to_fixed(94.9, 1), "94.9");
        assert_eq!(js_to_fixed(3.0, 1), "3.0");
        assert_eq!(floor_pct1(0.9496), "94.9%");
        assert_eq!(floor_pct1(0.95), "95.0%");
    }

    #[test]
    fn stairs_reasons_match_screen_wording() {
        use crate::stair::{HeadlineKind, Reason, ReasonKind, StepState};
        let reason = |kind, value| Reason { kind, value };
        let mut bad = stair_step(
            1,
            200,
            StepState::Saturated,
            9000,
            vec![
                reason(ReasonKind::Achieved, 0.9496),
                reason(ReasonKind::Dropped, 1234.0),
                reason(ReasonKind::Errors, 0.0234),
                reason(ReasonKind::P99Cap, 25.0),
                reason(ReasonKind::P99Relative, 2.25),
            ],
        );
        bad.slot_limited = true;
        let st = stair_report(
            HeadlineKind::Saturated,
            Some(200),
            Some(100),
            None,
            false,
            vec![stair_step(0, 100, StepState::Ok, 4000, vec![]), bad],
        );
        assert_eq!(
            stair_reason_texts(&st, 1),
            vec![
                "달성 94.9%",
                "dropped 1,234",
                "오류 2.3%",
                "p99 상한 초과",
                "p99 2.3×",
                "슬롯 부족 의심"
            ]
        );
        assert_eq!(
            stair_reasons_text(&st, 1),
            "달성 94.9% · dropped 1,234 · 오류 2.3% · p99 상한 초과 · p99 2.3× · 슬롯 부족 의심"
        );
    }

    #[test]
    fn stairs_reason_p99_relative_uses_absolute_rule_when_ref_under_1ms() {
        use crate::stair::{HeadlineKind, Reason, ReasonKind, StepState};
        let mut r = report_with_steps(vec![step("a", 1, 1)]);
        r.stair = Some(stair_report(
            HeadlineKind::Saturated,
            Some(200),
            Some(100),
            None,
            false,
            vec![
                stair_step(0, 100, StepState::Ok, 800, vec![]),
                stair_step(
                    1,
                    200,
                    StepState::Saturated,
                    6000,
                    vec![Reason {
                        kind: ReasonKind::P99Relative,
                        value: 7.5,
                    }],
                ),
            ],
        ));
        let csv = String::from_utf8(report_to_stairs_csv(&r).unwrap()).unwrap();
        assert!(
            csv.lines()
                .nth(4)
                .unwrap()
                .ends_with("saturated,p99 5 ms 이상")
        );
    }

    #[test]
    fn stair_headline_first_line_seven_variants() {
        use crate::stair::HeadlineKind::*;
        let h = |k, sat, last, thr, hint| {
            stair_headline_lines(&stair_report(k, sat, last, thr, hint, vec![]))
        };
        assert_eq!(
            h(Saturated, Some(200), Some(100), None, false),
            vec!["포화 계단 200 iter/s · 마지막 정상 100 iter/s"]
        );
        assert_eq!(
            h(Saturated, Some(200), None, None, false),
            vec!["포화 계단 200 iter/s · 정상 계단 없음 — 첫 계단부터 실패"]
        );
        // 힌트는 화면처럼 따로 한 줄.
        assert_eq!(
            h(Saturated, Some(200), None, None, true),
            vec![
                "포화 계단 200 iter/s · 정상 계단 없음 — 첫 계단부터 실패",
                "첫 계단만 일시적으로 튀었을 수 있습니다 — 앞부분 버림을 늘려 다시 실행해 보세요"
            ]
        );
        assert_eq!(
            h(Unconfirmed, Some(200), Some(100), None, false),
            vec![
                "포화 의심 200 iter/s — 확인할 다음 계단 전에 run이 끝남 · 마지막 정상 100 iter/s"
            ]
        );
        assert_eq!(
            h(Unconfirmed, Some(200), None, None, false),
            vec!["포화 의심 200 iter/s — 확인할 다음 계단 전에 run이 끝남 · 정상 계단 없음"]
        );
        assert_eq!(
            h(AllOk, None, Some(300), Some(300), false),
            vec!["300 iter/s까지 정상 (포화 못 찾음 — 더 높은 목표로 다시)"]
        );
        assert_eq!(
            h(OkThenUnmeasured, None, Some(300), Some(300), false),
            vec!["300 iter/s까지 정상 · 이후 계단은 측정 안 됨"]
        );
        assert_eq!(
            h(NoData, None, None, None, false),
            vec!["판정할 수 없음 — 측정이 끝난 계단이 없습니다"]
        );
    }

    #[test]
    fn stairs_csv_writes_every_headline_line_then_blank_then_table() {
        use crate::stair::{HeadlineKind, Reason, ReasonKind, StepState};
        let mut slot = stair_step(
            1,
            200,
            StepState::Saturated,
            4100,
            vec![Reason {
                kind: ReasonKind::Achieved,
                value: 0.9,
            }],
        );
        slot.slot_limited = true;
        let mut st = stair_report(
            HeadlineKind::Saturated,
            Some(200),
            Some(100),
            None,
            false,
            vec![stair_step(0, 100, StepState::Ok, 4000, vec![]), slot],
        );
        st.slot_limited_targets = vec![200];
        st.max_in_flight = Some(8);
        st.notes.t0_estimated = true;
        let mut r = report_with_steps(vec![step("a", 1, 1)]);
        r.stair = Some(st.clone());
        let lines = stair_headline_lines(&st);
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert!(lines[1].contains("max_in_flight = 8"), "{lines:?}");
        assert!(
            lines[2].starts_with("ⓘ 부하기 일부가 예전 버전"),
            "{lines:?}"
        );

        let csv = String::from_utf8(report_to_stairs_csv(&r).unwrap()).unwrap();
        let mut rd = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_reader(csv.as_bytes());
        let recs: Vec<Vec<String>> = rd
            .records()
            .map(|r| r.unwrap().iter().map(str::to_string).collect())
            .collect();
        // csv 리더는 빈 줄을 건너뛴다 — 머리말 3줄 바로 뒤가 머리글.
        for (i, l) in lines.iter().enumerate() {
            assert_eq!(recs[i], vec![l.clone()]);
        }
        assert_eq!(recs[3][0], "index");
        assert_eq!(csv.lines().nth(3), Some(""), "머리말 뒤 빈 줄 하나");
    }

    #[test]
    fn xlsx_has_stairs_sheet_only_for_stair_run() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;
        let plain = report_with_steps(vec![step("a", 10, 50)]);
        let wb: Xlsx<Cursor<Vec<u8>>> =
            open_workbook_from_rs(Cursor::new(report_to_xlsx(&plain, None))).unwrap();
        assert_eq!(
            wb.sheet_names(),
            vec!["Summary", "Steps", "Windows", "Status"]
        );

        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.stair = Some(saturated_sample());
        let mut wb: Xlsx<Cursor<Vec<u8>>> =
            open_workbook_from_rs(Cursor::new(report_to_xlsx(&r, None))).unwrap();
        assert_eq!(
            wb.sheet_names(),
            vec!["Summary", "Steps", "Windows", "Status", "Stairs"]
        );
        let ws = wb.worksheet_range("Stairs").unwrap();
        assert_eq!(
            ws.get_value((0, 0)),
            Some(&Data::String(
                "포화 계단 200 iter/s · 마지막 정상 100 iter/s".into()
            ))
        );
        assert_eq!(ws.get_value((2, 0)), Some(&Data::String("index".into())));
        assert_eq!(ws.get_value((4, 1)), Some(&Data::Float(200.0)));
        let last_col = ws.width() as u32 - 1;
        assert_eq!(
            ws.get_value((4, last_col)),
            Some(&Data::String(
                "달성 93.0% · dropped 12 · 오류 2.0% · p99 3.4×".into()
            ))
        );
        // 측정 안 된 계단: 달성·launched·dropped도 빈 칸.
        for c in [2u32, 3, 9] {
            assert!(
                matches!(ws.get_value((5, c)), None | Some(Data::Empty)),
                "col {c}: {:?}",
                ws.get_value((5, c))
            );
        }

        // 머리말이 여러 줄이면 머리글이 그만큼 내려간다.
        let mut st = saturated_sample();
        st.notes.open_loop_unknown = true;
        st.spike_targets = vec![150];
        let mut r2 = report_with_steps(vec![step("a", 10, 50)]);
        r2.stair = Some(st.clone());
        let mut wb: Xlsx<Cursor<Vec<u8>>> =
            open_workbook_from_rs(Cursor::new(report_to_xlsx(&r2, None))).unwrap();
        let ws = wb.worksheet_range("Stairs").unwrap();
        let lines = stair_headline_lines(&st);
        assert_eq!(lines.len(), 3);
        for (i, l) in lines.iter().enumerate() {
            assert_eq!(ws.get_value((i as u32, 0)), Some(&Data::String(l.clone())));
        }
        assert_eq!(ws.get_value((4, 0)), Some(&Data::String("index".into())));
    }

    // ---- 자동 정지 줄·행 상태 (stage-auto-stop Task 11) ----

    use crate::auto_stop::{AutoStopRecord, EmergencyStats, StopInfo, StopKind};
    use crate::stair::{BandKind, HeadlineKind, PartialRun, SaturationStopMode, StepState};

    /// 10계단(100..1000 iter/s) 리포트. `states`는 계단별 상태, 정지 기록 = `rec`.
    fn auto_report(
        states: [StepState; 10],
        last_ok: Option<u32>,
        rec: Option<AutoStopRecord>,
    ) -> crate::stair::StairReport {
        let steps = states
            .iter()
            .enumerate()
            .map(|(i, s)| stair_step(i as u32, 100 * (i as u32 + 1), *s, 4000, vec![]))
            .collect();
        let mut st = stair_report(
            HeadlineKind::Saturated,
            Some(300),
            last_ok,
            None,
            false,
            steps,
        );
        st.auto_stop = rec;
        st
    }

    fn sat_info(mode: SaturationStopMode, failed: &[u32], slot: bool) -> StopInfo {
        StopInfo {
            kind: StopKind::Saturation,
            mode: Some(mode),
            failed_steps: failed.to_vec(),
            decided_step: *failed.last().unwrap(),
            judged_through: i64::from(*failed.last().unwrap()),
            phase: None,
            decided_at_ms: 1_700_000_000_000,
            stopped_at_ms: 1_700_000_001_000,
            emergency: None,
            slot_limited: slot,
        }
    }

    fn emg_info(
        decided: u32,
        phase: BandKind,
        err: f64,
        p99_us: u64,
        hits: (bool, bool),
    ) -> StopInfo {
        StopInfo {
            kind: StopKind::Emergency,
            mode: None,
            failed_steps: vec![],
            decided_step: decided,
            judged_through: i64::from(decided) - 1,
            phase: Some(phase),
            decided_at_ms: 1_700_000_000_000,
            stopped_at_ms: 1_700_000_001_000,
            emergency: Some(EmergencyStats {
                max_error_rate: err,
                max_p99_us: p99_us,
                seconds: 3,
                error_hit: hits.0,
                p99_hit: hits.1,
            }),
            slot_limited: false,
        }
    }

    fn rec(stop: StopInfo) -> Option<AutoStopRecord> {
        Some(AutoStopRecord {
            stop: Some(stop),
            suspended_seconds: 0,
        })
    }

    fn with_partial(
        mut st: crate::stair::StairReport,
        idx: usize,
        s: u32,
        phase: BandKind,
    ) -> crate::stair::StairReport {
        st.steps[idx].partial = Some(PartialRun { seconds: s, phase });
        st
    }

    fn two_fails_report() -> crate::stair::StairReport {
        use StepState::*;
        let mut s = [Ok; 10];
        s[6] = Saturated;
        s[7] = Saturated;
        s[8] = Partial;
        s[9] = Skipped;
        with_partial(
            auto_report(
                s,
                Some(600),
                rec(sat_info(SaturationStopMode::TwoFails, &[6, 7], false)),
            ),
            8,
            2,
            BandKind::Ramp,
        )
    }

    fn first_fail_report() -> crate::stair::StairReport {
        use StepState::*;
        let mut s = [Ok; 10];
        s[6] = Saturated;
        s[7] = Partial;
        s[8] = Skipped;
        s[9] = Skipped;
        with_partial(
            auto_report(
                s,
                Some(600),
                rec(sat_info(SaturationStopMode::FirstFail, &[6], false)),
            ),
            7,
            1,
            BandKind::Ramp,
        )
    }

    fn emergency_report() -> crate::stair::StairReport {
        use StepState::*;
        let mut s = [Skipped; 10];
        for st in s.iter_mut().take(4) {
            *st = Ok;
        }
        s[4] = EmergencyStopped;
        auto_report(
            s,
            Some(400),
            rec(emg_info(4, BandKind::Ramp, 0.12, 100_000, (true, false))),
        )
    }

    #[test]
    fn stop_line_two_fails() {
        assert_eq!(
            stair_stop_line(&two_fails_report(), "TIME").unwrap(),
            "8계단(800 iter/s) 판정 뒤 자동 정지 — 7·8계단 연속 실패 · 9계단 상승 2초 진입 후 멈춤 · 10계단 실행 안 함 · TIME"
        );
    }

    #[test]
    fn stop_line_first_fail() {
        assert_eq!(
            stair_stop_line(&first_fail_report(), "TIME").unwrap(),
            "7계단(700 iter/s) 판정 뒤 자동 정지 — 7계단 실패, 첫 실패에서 정지(포화 확인 못 함) · 8계단 상승 1초 진입 후 멈춤 · 9–10계단 실행 안 함 · TIME"
        );
    }

    #[test]
    fn stop_line_emergency() {
        assert_eq!(
            stair_stop_line(&emergency_report(), "TIME").unwrap(),
            "5계단(500 iter/s) 상승 중 즉시 정지 — 오류율 12.0% 3초 연속 · 마지막 정상 4계단(400 iter/s) · 6–10계단 실행 안 함 · TIME"
        );
    }

    #[test]
    fn stop_line_golden() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/stair_stop_line_golden.json"
        );
        let want: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let got = serde_json::json!({
            "two_fails": stair_stop_line(&two_fails_report(), "TIME").unwrap(),
            "first_fail": stair_stop_line(&first_fail_report(), "TIME").unwrap(),
            "emergency": stair_stop_line(&emergency_report(), "TIME").unwrap(),
        });
        assert_eq!(got, want);
    }

    #[test]
    fn stop_line_from_task10_golden_report_discard_phase() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/stair_autostop_report_golden.json"
        );
        let st: crate::stair::StairReport =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            stair_stop_line(&st, "TIME").unwrap(),
            "4계단(400 iter/s) 판정 뒤 자동 정지 — 3·4계단 연속 실패 · 5계단 시작 4초 뒤(버림 중) 멈춤 · 6계단 실행 안 함 · TIME"
        );
    }

    #[test]
    fn partial_wording_by_phase() {
        let st = with_partial(two_fails_report(), 8, 7, BandKind::Discard);
        let line = stair_stop_line(&st, "T").unwrap();
        assert!(
            line.contains(" · 9계단 시작 7초 뒤(버림 중) 멈춤 · "),
            "{line}"
        );
        assert_eq!(
            stair_reason_texts(&st, 8),
            vec!["일부 실행 — 계단 시작 7초 뒤(버림 중) 정지"]
        );
        let st = with_partial(two_fails_report(), 8, 12, BandKind::Measure);
        let line = stair_stop_line(&st, "T").unwrap();
        assert!(
            line.contains(" · 9계단 시작 12초 뒤(측정 중) 멈춤 · "),
            "{line}"
        );
        assert_eq!(
            stair_reason_texts(&st, 8),
            vec!["일부 실행 — 계단 시작 12초 뒤(측정 중) 정지"]
        );
        let st = two_fails_report();
        assert_eq!(
            stair_reason_texts(&st, 8),
            vec!["일부 실행 — 상승 2초 진입 후 정지"]
        );
    }

    #[test]
    fn multiple_partial_rows_each_get_a_clause() {
        let mut st = two_fails_report();
        st.steps[9].state = StepState::Partial;
        st.steps[9].partial = Some(PartialRun {
            seconds: 1,
            phase: BandKind::Ramp,
        });
        let line = stair_stop_line(&st, "T").unwrap();
        assert!(
            line.contains(" · 9계단 상승 2초 진입 후 멈춤 · 10계단 상승 1초 진입 후 멈춤 · T"),
            "{line}"
        );
        assert!(!line.contains("실행 안 함"), "{line}");
    }

    #[test]
    fn stop_line_p99_only() {
        let mut st = emergency_report();
        st.auto_stop = rec(emg_info(
            4,
            BandKind::Measure,
            0.0,
            2_500_000,
            (false, true),
        ));
        st.steps[4].state = StepState::EmergencyStopped;
        let line = stair_stop_line(&st, "T").unwrap();
        assert!(
            line.starts_with(
                "5계단(500 iter/s) 측정 중 즉시 정지 — p99 2500 ms 3초 연속 · 마지막 정상"
            ),
            "{line}"
        );
    }

    #[test]
    fn stop_line_neither_hit_reads_like_p99() {
        let mut st = emergency_report();
        st.auto_stop = rec(emg_info(
            4,
            BandKind::Measure,
            0.0,
            2_500_000,
            (false, false),
        ));
        st.steps[4].state = StepState::EmergencyStopped;
        let line = stair_stop_line(&st, "T").unwrap();
        assert!(
            line.starts_with(
                "5계단(500 iter/s) 측정 중 즉시 정지 — p99 2500 ms 3초 연속 · 마지막 정상"
            ),
            "{line}"
        );
    }

    #[test]
    fn stop_line_both_conditions() {
        let mut st = emergency_report();
        st.auto_stop = rec(emg_info(4, BandKind::Discard, 0.5, 2_500_000, (true, true)));
        let line = stair_stop_line(&st, "T").unwrap();
        assert!(
            line.starts_with("5계단(500 iter/s) 버림 중 즉시 정지 — 오류율 50.0% · p99 2500 ms 3초 연속 · 마지막 정상"),
            "{line}"
        );
    }

    #[test]
    fn emergency_without_ok_step() {
        let mut st = emergency_report();
        st.headline.last_ok_target = None;
        let line = stair_stop_line(&st, "T").unwrap();
        assert!(line.contains(" · 정상 계단 없음 · "), "{line}");
    }

    #[test]
    fn stop_line_slot_limited_suffix() {
        let mut st = two_fails_report();
        st.auto_stop = rec(sat_info(SaturationStopMode::TwoFails, &[6, 7], true));
        let line = stair_stop_line(&st, "T").unwrap();
        assert!(
            line.contains("7·8계단 연속 실패 (슬롯 부족 의심 — 부하기 한계일 수 있음) · 9계단"),
            "{line}"
        );
    }

    #[test]
    fn skipped_single_and_range() {
        assert!(
            stair_stop_line(&two_fails_report(), "T")
                .unwrap()
                .contains(" · 10계단 실행 안 함 · ")
        );
        assert!(
            stair_stop_line(&first_fail_report(), "T")
                .unwrap()
                .contains(" · 9–10계단 실행 안 함 · ")
        );
    }

    #[test]
    fn no_partial_omits_clause() {
        let mut st = two_fails_report();
        st.steps[8].state = StepState::Skipped;
        st.steps[8].partial = None;
        assert_eq!(
            stair_stop_line(&st, "T").unwrap(),
            "8계단(800 iter/s) 판정 뒤 자동 정지 — 7·8계단 연속 실패 · 9–10계단 실행 안 함 · T"
        );
    }

    #[test]
    fn tiny_error_rate_text() {
        assert_eq!(stair_error_rate_text(0.0004), "<0.1%");
        assert_eq!(stair_error_rate_text(0.0), "0.0%");
        assert_eq!(stair_error_rate_text(0.12), "12.0%");
        assert_eq!(stair_error_rate_text(0.0129), "1.2%");
        assert_eq!(stair_ms_text(500), "0.50");
        assert_eq!(stair_ms_text(999), "1.00");
        assert_eq!(stair_ms_text(1000), "1");
        assert_eq!(stair_ms_text(2_500_000), "2500");
        assert_eq!(stair_ms_text(2500), "3");
    }

    #[test]
    fn suspended_line_only() {
        let mut st = two_fails_report();
        st.auto_stop = Some(AutoStopRecord {
            stop: None,
            suspended_seconds: 4,
        });
        assert_eq!(stair_stop_line(&st, "T"), None);
        assert_eq!(
            stair_suspended_line(&st).unwrap(),
            "자동 정지 감시가 4초 보류됐습니다(부하기 등록·데이터 지연) — 그동안 즉시 정지는 동작하지 않았습니다"
        );
        assert_eq!(
            stair_headline_lines(&st)[0],
            stair_suspended_line(&st).unwrap()
        );
        st.auto_stop = Some(AutoStopRecord {
            stop: None,
            suspended_seconds: 0,
        });
        assert_eq!(stair_suspended_line(&st), None);
        assert!(!stair_headline_lines(&st)[0].contains("자동 정지"));
    }

    #[test]
    fn stairs_csv_starts_with_stop_line_and_blank_numbers() {
        let st = two_fails_report();
        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.stair = Some(st.clone());
        let csv = String::from_utf8(report_to_stairs_csv(&r).unwrap()).unwrap();
        let first = csv.lines().next().unwrap();
        let want = stair_stop_line(&st, "2023-11-14T22:13:21Z").unwrap();
        assert!(
            first.contains(&want) || first.trim_matches('"') == want,
            "{first}"
        );
        let mut rd = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_reader(csv.as_bytes());
        let recs: Vec<csv::StringRecord> = rd.records().map(|x| x.unwrap()).collect();
        assert_eq!(recs[0][0], want);
        let hdr = recs.iter().position(|r| &r[0] == "index").unwrap();
        for (i, (state, reason)) in [
            (8, ("partial", "일부 실행 — 상승 2초 진입 후 정지")),
            (9, ("skipped", "실행 안 함")),
        ] {
            let row = &recs[hdr + 1 + i];
            assert_eq!(&row[11], state);
            assert_eq!(&row[12], reason);
            for c in 2..11 {
                assert_eq!(&row[c], "", "row {i} col {c}");
            }
        }
        // 판정 계단 행은 숫자가 있다.
        assert_ne!(&recs[hdr + 1 + 6][2], "");
        // 즉시 정지 행.
        let mut r2 = report_with_steps(vec![step("a", 10, 50)]);
        r2.stair = Some(emergency_report());
        let csv = String::from_utf8(report_to_stairs_csv(&r2).unwrap()).unwrap();
        let mut rd = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_reader(csv.as_bytes());
        let recs: Vec<csv::StringRecord> = rd.records().map(|x| x.unwrap()).collect();
        let hdr = recs.iter().position(|r| &r[0] == "index").unwrap();
        let row = &recs[hdr + 1 + 4];
        assert_eq!((&row[11], &row[12]), ("emergency_stopped", "즉시 정지"));
        assert_eq!(&row[2], "");
        assert_eq!(&row[9], "");
    }

    #[test]
    fn xlsx_stairs_sheet_has_stop_line() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;
        let st = two_fails_report();
        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.stair = Some(st.clone());
        let mut wb: Xlsx<Cursor<Vec<u8>>> =
            open_workbook_from_rs(Cursor::new(report_to_xlsx(&r, None))).unwrap();
        let ws = wb.worksheet_range("Stairs").unwrap();
        let want = stair_stop_line(&st, "2023-11-14T22:13:21Z").unwrap();
        assert_eq!(ws.get_value((0, 0)), Some(&Data::String(want)));
        let lines = stair_headline_lines(&st).len() as u32;
        let first = lines + 2;
        let last_col = ws.width() as u32 - 1;
        assert_eq!(
            ws.get_value((first + 8, last_col - 1)),
            Some(&Data::String("partial".into()))
        );
        assert_eq!(
            ws.get_value((first + 9, last_col - 1)),
            Some(&Data::String("skipped".into()))
        );
        for c in [2u32, 3, 4, 5, 8, 9, 11, 12] {
            assert!(
                matches!(ws.get_value((first + 8, c)), None | Some(Data::Empty)),
                "partial col {c}: {:?}",
                ws.get_value((first + 8, c))
            );
        }
    }

    #[test]
    fn non_autostop_csv_unchanged() {
        let st = saturated_sample();
        assert!(stair_stop_line(&st, "T").is_none());
        assert!(stair_suspended_line(&st).is_none());
        let lines = stair_headline_lines(&st);
        assert_eq!(
            lines,
            vec!["포화 계단 200 iter/s · 마지막 정상 100 iter/s".to_string()]
        );
    }

    const SETUP_ID_A: &str = "01HZZZZZZZZZZZZZZZZZZZZZA1";
    const SETUP_ID_B: &str = "01HZZZZZZZZZZZZZZZZZZZZZB2";

    fn setup_yaml() -> String {
        format!(
            "version: 1
name: s
setup:
  steps:
    - type: http
      id: {SETUP_ID_A}
      name: sign-in
      request: {{ method: POST, url: \"http://x/login\" }}
    - type: http
      id: {SETUP_ID_B}
      name: roles
      request: {{ method: GET, url: \"http://x/roles\" }}
steps:
  - type: http
    id: 01HZZZZZZZZZZZZZZZZZZZZZC3
    name: main
    request: {{ method: GET, url: \"http://x/\" }}
"
        )
    }

    fn setup_step_report(
        id: &str,
        count: u64,
        errors: u64,
        ms: (u64, u64, u64),
        status: &[(&str, u64)],
        kinds: &[(&str, u64)],
    ) -> SetupStepReport {
        SetupStepReport {
            step_id: id.into(),
            count,
            errors,
            p50_ms: ms.0,
            p95_ms: ms.1,
            max_ms: ms.2,
            status_counts: status.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            failure_kinds: kinds.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        }
    }

    pub fn report_with_setup() -> ReportJson {
        let mut r = report_with_steps(vec![step("a", 10, 50), step("b", 20, 99)]);
        r.scenario_yaml = setup_yaml();
        r.setup = Some(SetupReport {
            ok: 47,
            failed: 3,
            interrupted: 0,
            steps: vec![
                setup_step_report(
                    SETUP_ID_A,
                    50,
                    3,
                    (92, 410, 5004),
                    &[("0", 1), ("200", 47), ("503", 2)],
                    &[("status_assert", 2), ("connect_timeout", 1)],
                ),
                setup_step_report(SETUP_ID_B, 47, 0, (33, 51, 70), &[("200", 47)], &[]),
            ],
        });
        r
    }

    fn cell(ws: &calamine::Range<calamine::Data>, r: u32, c: u32) -> Option<&calamine::Data> {
        ws.get_value((r, c))
    }

    #[test]
    fn xlsx_setup_sheet_follows_steps_and_holds_setup_numbers() {
        use calamine::{Data, Reader};
        let mut wb = read_xlsx(report_to_xlsx(&report_with_setup(), None));
        assert_eq!(
            wb.sheet_names(),
            vec!["Summary", "Steps", "Setup", "Windows", "Status"]
        );
        let ws = wb.worksheet_range("Setup").unwrap();
        for (row, key, v) in [
            (0, "setup_ok", 47.0),
            (1, "setup_failed", 3.0),
            (2, "setup_interrupted", 0.0),
        ] {
            assert_eq!(cell(&ws, row, 0), Some(&Data::String(key.into())));
            assert_eq!(cell(&ws, row, 1), Some(&Data::Float(v)), "{key}");
        }
        assert!(is_blank(cell(&ws, 3, 0)));
        let head = [
            "step_id",
            "name",
            "count",
            "error_count",
            "p50_ms",
            "p95_ms",
            "max_ms",
            "status_counts",
        ];
        for (c, h) in head.iter().enumerate() {
            assert_eq!(cell(&ws, 4, c as u32), Some(&Data::String((*h).into())));
        }
        let rows: [(&str, &str, [f64; 5], &str); 2] = [
            (
                SETUP_ID_A,
                "sign-in",
                [50.0, 3.0, 92.0, 410.0, 5004.0],
                "0: 1, 200: 47, 503: 2",
            ),
            (
                SETUP_ID_B,
                "roles",
                [47.0, 0.0, 33.0, 51.0, 70.0],
                "200: 47",
            ),
        ];
        for (i, (id, name, nums, status)) in rows.iter().enumerate() {
            let r = 5 + i as u32;
            assert_eq!(cell(&ws, r, 0), Some(&Data::String((*id).into())));
            assert_eq!(cell(&ws, r, 1), Some(&Data::String((*name).into())));
            for (j, n) in nums.iter().enumerate() {
                assert_eq!(cell(&ws, r, 2 + j as u32), Some(&Data::Float(*n)));
            }
            assert_eq!(cell(&ws, r, 7), Some(&Data::String((*status).into())));
        }
        assert!(is_blank(cell(&ws, 7, 0)));
        assert_eq!(cell(&ws, 8, 0), Some(&Data::String("failure_kind".into())));
        assert_eq!(cell(&ws, 8, 1), Some(&Data::String("count".into())));
        assert_eq!(
            cell(&ws, 9, 0),
            Some(&Data::String("connect_timeout".into()))
        );
        assert_eq!(cell(&ws, 9, 1), Some(&Data::Float(1.0)));
        assert_eq!(
            cell(&ws, 10, 0),
            Some(&Data::String("status_assert".into()))
        );
        assert_eq!(cell(&ws, 10, 1), Some(&Data::Float(2.0)));
        assert!(is_blank(cell(&ws, 11, 0)));
    }

    #[test]
    fn xlsx_setup_sheet_truncates_overlong_step_name() {
        use calamine::{Data, Reader};
        for ch in ['a', '가'] {
            let mut r = report_with_setup();
            let long: String = std::iter::repeat_n(ch, 40_000).collect();
            r.scenario_yaml = r.scenario_yaml.replace("sign-in", &long);
            let mut wb = read_xlsx(report_to_xlsx(&r, None));
            let ws = wb.worksheet_range("Setup").unwrap();
            let want: String = std::iter::repeat_n(ch, 32_767).collect();
            assert_eq!(cell(&ws, 5, 1), Some(&Data::String(want)));
            assert_eq!(cell(&ws, 5, 2), Some(&Data::Float(50.0)));
            assert_eq!(cell(&ws, 5, 6), Some(&Data::Float(5004.0)));
        }
    }

    #[test]
    fn xlsx_setup_sheet_omits_failure_kind_table_when_no_kinds() {
        use calamine::Reader;
        let mut r = report_with_setup();
        for s in &mut r.setup.as_mut().unwrap().steps {
            s.failure_kinds.clear();
        }
        let mut wb = read_xlsx(report_to_xlsx(&r, None));
        let ws = wb.worksheet_range("Setup").unwrap();
        for row in 7..12 {
            for c in 0..2 {
                assert!(is_blank(cell(&ws, row, c)), "row {row} col {c}");
            }
        }
    }

    #[test]
    fn xlsx_setup_sheet_name_blank_when_scenario_unreadable() {
        use calamine::{Data, Reader};
        let mut r = report_with_setup();
        r.scenario_yaml = "{{{ not yaml".into();
        let mut wb = read_xlsx(report_to_xlsx(&r, None));
        let ws = wb.worksheet_range("Setup").unwrap();
        assert_eq!(cell(&ws, 5, 0), Some(&Data::String(SETUP_ID_A.into())));
        assert!(is_blank(cell(&ws, 5, 1)));
        assert_eq!(cell(&ws, 5, 2), Some(&Data::Float(50.0)));
        assert_eq!(cell(&ws, 6, 3), Some(&Data::Float(0.0)));
    }

    #[test]
    fn xlsx_without_setup_has_no_setup_sheet() {
        use calamine::Reader;
        let r = report_with_steps(vec![step("a", 10, 50)]);
        let wb = read_xlsx(report_to_xlsx(&r, None));
        assert!(!wb.sheet_names().iter().any(|n| n == "Setup"));
        assert_eq!(
            wb.sheet_names(),
            vec!["Summary", "Steps", "Windows", "Status"]
        );
    }

    #[test]
    fn csv_setup_section_follows_steps_after_blank_line() {
        let csv = String::from_utf8(report_to_csv(&report_with_setup())).unwrap();
        let expected = format!(
            "step_id,count,error_count,p50_ms,p95_ms,p99_ms\n\
             a,10,0,1,50,50\n\
             b,20,0,1,99,99\n\
             \n\
             setup_ok,setup_failed,setup_interrupted\n\
             47,3,0\n\
             setup_step_id,count,error_count,p50_ms,p95_ms,max_ms\n\
             {SETUP_ID_A},50,3,92,410,5004\n\
             {SETUP_ID_B},47,0,33,51,70\n"
        );
        assert_eq!(csv, expected);
    }

    #[test]
    fn csv_without_setup_is_unchanged() {
        let r = report_with_steps(vec![step("a", 10, 50), step("b", 20, 99)]);
        let csv = String::from_utf8(report_to_csv(&r)).unwrap();
        assert_eq!(
            csv,
            "step_id,count,error_count,p50_ms,p95_ms,p99_ms\na,10,0,1,50,50\nb,20,0,1,99,99\n"
        );
    }

    fn named_run(id: &str, steps: Vec<ReportStep>) -> ReportJson {
        let mut r = report_with_steps(steps);
        r.run.id = id.into();
        r
    }

    fn setup_of(
        ok: u64,
        failed: u64,
        steps: Vec<(&str, u64, u64, u64)>, // (id, p95, errors, count)
    ) -> Option<SetupReport> {
        Some(SetupReport {
            ok,
            failed,
            interrupted: 0,
            steps: steps
                .into_iter()
                .map(|(id, p95, errors, count)| {
                    setup_step_report(id, count, errors, (1, p95, p95), &[], &[])
                })
                .collect(),
        })
    }

    #[test]
    fn comparison_csv_without_setup_is_unchanged() {
        let a = named_run("A", vec![step("a", 10, 50)]);
        let b = named_run("B", vec![step("a", 10, 60)]);
        let csv = String::from_utf8(comparison_to_csv(&[a, b], 0)).unwrap();
        assert_eq!(
            csv,
            "metric,A (base),B,delta_pct B\n\
             p50_ms,0,0,\n\
             p95_ms,0,0,\n\
             p99_ms,0,0,\n\
             rps,0,0,\n\
             error_rate,0,0,\n"
        );
    }

    #[test]
    fn comparison_xlsx_without_setup_has_no_setup_sheet() {
        use calamine::Reader;
        let a = named_run("A", vec![step("a", 10, 50)]);
        let b = named_run("B", vec![step("a", 10, 60)]);
        let wb = read_xlsx(comparison_to_xlsx(&[a, b], 0));
        assert_eq!(wb.sheet_names(), vec!["Summary", "Steps", "Runs"]);
    }

    #[test]
    fn merged_failure_kinds_sums_across_steps() {
        let s = SetupReport {
            ok: 0,
            failed: 3,
            interrupted: 0,
            steps: vec![
                setup_step_report("A", 3, 2, (1, 1, 1), &[], &[("status_assert", 2)]),
                setup_step_report(
                    "B",
                    2,
                    2,
                    (1, 1, 1),
                    &[],
                    &[("connect_timeout", 1), ("status_assert", 1)],
                ),
            ],
        };
        let want: std::collections::BTreeMap<String, u64> = [
            ("connect_timeout".to_string(), 1),
            ("status_assert".to_string(), 3),
        ]
        .into();
        assert_eq!(merged_failure_kinds(&s), want);
    }

    #[test]
    fn setup_step_order_is_baseline_then_first_seen() {
        let mut a = named_run("A", vec![]);
        a.setup = setup_of(1, 0, vec![("s1", 1, 0, 1), ("s2", 1, 0, 1)]);
        let mut b = named_run("B", vec![]);
        b.setup = setup_of(1, 0, vec![("s3", 1, 0, 1), ("s1", 1, 0, 1)]);
        let c = named_run("C", vec![]);
        let reports = [a, b, c];
        assert_eq!(setup_step_order(&reports, 0), vec!["s1", "s2", "s3"]);
        assert_eq!(setup_step_order(&reports, 1), vec!["s3", "s1", "s2"]);
    }

    #[test]
    fn comparison_csv_setup_rows_before_basis() {
        use crate::steady::{Basis, BasisState};
        let mut a = named_run("A", vec![]);
        a.setup = setup_of(50, 0, vec![]);
        a.basis = Some(basis_block(Basis::Steady, BasisState::Measured, None));
        let mut b = named_run("B", vec![]);
        b.basis = Some(basis_block(Basis::Steady, BasisState::Measured, None));
        let mut c = named_run("C", vec![]);
        c.setup = setup_of(47, 3, vec![]);
        c.basis = Some(basis_block(Basis::Steady, BasisState::Measured, None));
        let csv = String::from_utf8(comparison_to_csv(&[a, b, c], 0)).unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "metric,A (base),B,C,delta_pct B,delta_pct C");
        assert_eq!(lines[5], "error_rate,0,0,0,,");
        assert_eq!(lines[6], "setup_ok,50,,47,,-0.060000");
        assert_eq!(lines[7], "setup_failed,0,,3,,");
        assert_eq!(lines[8], "basis,steady,steady,steady,,");
        assert_eq!(lines.len(), 9);
    }

    #[test]
    fn comparison_xlsx_setup_sheet() {
        use calamine::{Data, Reader};
        let mut a = named_run("A", vec![]);
        a.setup = setup_of(50, 0, vec![("s1", 120, 1, 5), ("s2", 47, 0, 5)]);
        let b = named_run("B", vec![]);
        let mut c = named_run("C", vec![]);
        c.setup = setup_of(47, 3, vec![("s3", 30, 0, 5), ("s1", 410, 3, 5)]);
        let mut wb = read_xlsx(comparison_to_xlsx(&[a, b, c], 0));
        assert_eq!(wb.sheet_names(), vec!["Summary", "Steps", "Setup", "Runs"]);
        let ws = wb.worksheet_range("Setup").unwrap();
        let s = |t: &str| Some(Data::String(t.into()));
        for (c, h) in ["metric", "A (base)", "B", "C", "Δ% B", "Δ% C"]
            .iter()
            .enumerate()
        {
            assert_eq!(cell(&ws, 0, c as u32).cloned(), s(h), "header {c}");
        }
        let names = [
            "setup_ok",
            "setup_failed",
            "s1 p95_ms",
            "s1 error_count",
            "s2 p95_ms",
            "s2 error_count",
            "s3 p95_ms",
            "s3 error_count",
        ];
        for (i, n) in names.iter().enumerate() {
            assert_eq!(cell(&ws, 1 + i as u32, 0).cloned(), s(n), "row {i}");
        }
        for row in 1..=8u32 {
            assert!(is_blank(cell(&ws, row, 2)), "B value row {row}");
            assert!(is_blank(cell(&ws, row, 4)), "Δ% B row {row}");
        }
        assert_eq!(cell(&ws, 1, 1), Some(&Data::Float(50.0)));
        assert_eq!(cell(&ws, 1, 3), Some(&Data::Float(47.0)));
        assert_eq!(cell(&ws, 1, 5).cloned(), s("▲ -6.0%"));
        assert_eq!(cell(&ws, 2, 5).cloned(), s("▲ 신규"));
        assert_eq!(cell(&ws, 3, 5).cloned(), s("▲ +241.7%"));
        assert_eq!(cell(&ws, 4, 5).cloned(), s("▲ +200.0%"));
        assert!(is_blank(cell(&ws, 5, 3)));
        assert!(is_blank(cell(&ws, 5, 5)));
        assert_eq!(cell(&ws, 7, 3), Some(&Data::Float(30.0)));
        assert!(is_blank(cell(&ws, 7, 5)));
    }

    fn abc_setup_reports() -> [ReportJson; 3] {
        let mut a = named_run("A", vec![]);
        a.setup = setup_of(50, 0, vec![("s1", 120, 1, 5), ("s2", 47, 0, 5)]);
        let b = named_run("B", vec![]);
        let mut c = named_run("C", vec![]);
        c.setup = setup_of(47, 3, vec![("s3", 30, 0, 5), ("s1", 410, 3, 5)]);
        [a, b, c]
    }

    #[test]
    fn comparison_xlsx_setup_sheet_with_non_first_baseline() {
        use calamine::{Data, Reader};
        let mut wb = read_xlsx(comparison_to_xlsx(&abc_setup_reports(), 2));
        let ws = wb.worksheet_range("Setup").unwrap();
        let s = |t: &str| Some(Data::String(t.into()));
        for (c, h) in ["metric", "A", "B", "C (base)", "Δ% A", "Δ% B"]
            .iter()
            .enumerate()
        {
            assert_eq!(cell(&ws, 0, c as u32).cloned(), s(h), "header {c}");
        }
        let names = [
            "setup_ok",
            "setup_failed",
            "s3 p95_ms",
            "s3 error_count",
            "s1 p95_ms",
            "s1 error_count",
            "s2 p95_ms",
            "s2 error_count",
        ];
        for (i, n) in names.iter().enumerate() {
            assert_eq!(cell(&ws, 1 + i as u32, 0).cloned(), s(n), "row {i}");
        }
        assert_eq!(cell(&ws, 1, 4).cloned(), s("▼ +6.4%"));
        assert_eq!(cell(&ws, 2, 4).cloned(), s("▼ -100.0%"));
        assert_eq!(cell(&ws, 5, 4).cloned(), s("▼ -70.7%"));
        assert_eq!(cell(&ws, 6, 4).cloned(), s("▼ -66.7%"));
        for row in [3u32, 4, 7, 8] {
            assert!(is_blank(cell(&ws, row, 4)), "A absent or base absent {row}");
        }
        for row in 1..=8u32 {
            assert!(is_blank(cell(&ws, row, 5)), "Δ% B row {row}");
        }
    }

    #[test]
    fn comparison_setup_exports_blank_deltas_when_baseline_has_no_setup() {
        use calamine::{Data, Reader};
        let reports = abc_setup_reports();
        let mut wb = read_xlsx(comparison_to_xlsx(&reports, 1));
        let ws = wb.worksheet_range("Setup").unwrap();
        assert_eq!(cell(&ws, 0, 2), Some(&Data::String("B (base)".into())));
        for row in 1..=8u32 {
            assert!(is_blank(cell(&ws, row, 2)), "B value row {row}");
            assert!(is_blank(cell(&ws, row, 4)), "Δ% A row {row}");
            assert!(is_blank(cell(&ws, row, 5)), "Δ% C row {row}");
        }
        assert_eq!(cell(&ws, 1, 1), Some(&Data::Float(50.0)));
        assert_eq!(cell(&ws, 1, 3), Some(&Data::Float(47.0)));
        let csv = String::from_utf8(comparison_to_csv(&reports, 1)).unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "metric,A,B (base),C,delta_pct A,delta_pct C");
        assert_eq!(lines[6], "setup_ok,50,,47,,");
        assert_eq!(lines[7], "setup_failed,0,,3,,");
        assert_eq!(lines.len(), 8);
    }

    fn passed_split() -> crate::sample::SampleBlock {
        crate::sample::SampleBlock {
            selected: crate::sample::Sample::Passed,
            default: crate::sample::Sample::Passed,
            split: true,
        }
    }

    /// 나눌 수 있는 run. `all_failed`면 모든 요청이 실패해 통과한 요청이 없다.
    fn split_run(id: &str, all_failed: bool, p95: u64) -> ReportJson {
        let mut st = step("s", 5, p95);
        let mut r = report_with_steps(vec![]);
        r.run.id = id.into();
        r.sample = passed_split();
        r.summary.count = 10;
        r.summary.p50_ms = p95 / 2;
        r.summary.p95_ms = p95;
        r.summary.p99_ms = p95;
        if all_failed {
            r.summary.errors = 10;
            r.summary.p50_ms = 0;
            r.summary.p95_ms = 0;
            r.summary.p99_ms = 0;
            st.error_count = 5;
            st.p50_ms = 0;
            st.p95_ms = 0;
            st.p99_ms = 0;
        }
        r.steps = vec![st];
        r.windows = vec![
            ReportWindow {
                ts_second: 1,
                step_id: "s".into(),
                count: 3,
                error_count: if all_failed { 3 } else { 0 },
                status_counts: BTreeMap::new(),
                p50_ms: if all_failed { 0 } else { 7 },
                p95_ms: if all_failed { 0 } else { 8 },
                p99_ms: if all_failed { 0 } else { 9 },
            },
            ReportWindow {
                ts_second: 2,
                step_id: "s".into(),
                count: 3,
                error_count: 1,
                status_counts: BTreeMap::new(),
                p50_ms: 7,
                p95_ms: 8,
                p99_ms: 9,
            },
        ];
        r
    }

    #[test]
    fn xlsx_summary_has_latency_sample_last_row() {
        use calamine::{Data, Reader};
        let mut wb = read_xlsx(report_to_xlsx(&split_run("a", false, 40), None));
        let ws = wb.worksheet_range("Summary").unwrap();
        let (last, _) = ws.end().unwrap();
        assert_eq!(
            ws.get_value((last, 0)),
            Some(&Data::String("latency_sample".into()))
        );
        assert_eq!(
            ws.get_value((last, 1)),
            Some(&Data::String("passed".into()))
        );
        let mut wb = read_xlsx(report_to_xlsx(&report_with_steps(vec![]), None));
        let ws = wb.worksheet_range("Summary").unwrap();
        let (last, _) = ws.end().unwrap();
        assert_eq!(
            ws.get_value((last, 0)),
            Some(&Data::String("latency_sample".into()))
        );
        assert_eq!(ws.get_value((last, 1)), Some(&Data::String("all".into())));
        // 내보내기는 기본 표본만 쓴다: 표시 표본이 달라도 적는 값은 default다.
        let mut shown = split_run("s", false, 40);
        shown.sample.selected = crate::sample::Sample::Failed;
        let mut wb = read_xlsx(report_to_xlsx(&shown, None));
        let ws = wb.worksheet_range("Summary").unwrap();
        let (last, _) = ws.end().unwrap();
        assert_eq!(
            ws.get_value((last, 1)),
            Some(&Data::String("passed".into()))
        );
        let mut wb = read_xlsx(comparison_to_xlsx(&[shown], 0));
        let runs = wb.worksheet_range("Runs").unwrap();
        assert_eq!(runs.get_value((1, 6)), Some(&Data::String("passed".into())));
    }

    #[test]
    fn compare_xlsx_runs_has_latency_sample_last_column() {
        use calamine::{Data, Reader};
        let plain_b = || {
            let mut b = report_with_steps(vec![]);
            b.run.id = "B".into();
            b
        };
        let a = split_run("A", false, 40);
        let b = plain_b();
        let mut wb = read_xlsx(comparison_to_xlsx(&[a, b], 0));
        let runs = wb.worksheet_range("Runs").unwrap();
        assert_eq!(
            runs.get_value((0, 6)),
            Some(&Data::String("latency_sample".into()))
        );
        assert_eq!(runs.get_value((1, 6)), Some(&Data::String("passed".into())));
        assert_eq!(runs.get_value((2, 6)), Some(&Data::String("all".into())));
        assert!(is_blank(runs.get_value((0, 7))));

        let mut a = split_run("A", false, 40);
        let b = plain_b();
        a.basis = Some(basis_block(
            crate::steady::Basis::Steady,
            crate::steady::BasisState::Measured,
            None,
        ));
        let mut wb = read_xlsx(comparison_to_xlsx(&[a, b], 0));
        let runs = wb.worksheet_range("Runs").unwrap();
        assert_eq!(runs.get_value((0, 6)), Some(&Data::String("basis".into())));
        assert_eq!(
            runs.get_value((0, 7)),
            Some(&Data::String("latency_sample".into()))
        );
        assert_eq!(runs.get_value((1, 7)), Some(&Data::String("passed".into())));
        assert_eq!(runs.get_value((2, 7)), Some(&Data::String("all".into())));
        assert!(is_blank(runs.get_value((0, 8))));
    }

    #[test]
    fn missing_latency_is_blank_not_zero() {
        use calamine::{Data, Reader};
        let r = split_run("a", true, 40);
        // 단일 CSV: 전부 실패한 스텝의 p50·p95·p99 칸은 빈 문자열.
        let csv = String::from_utf8(report_to_csv(&r)).unwrap();
        assert_eq!(csv.lines().nth(1).unwrap(), "s,5,5,,,");
        // 단일 XLSX Summary: 라벨은 있고 값 칸은 빈 칸.
        let mut wb = read_xlsx(report_to_xlsx(&r, None));
        let ws = wb.worksheet_range("Summary").unwrap();
        for row in 4..=6u32 {
            assert!(matches!(ws.get_value((row, 0)), Some(Data::String(_))));
            assert!(is_blank(ws.get_value((row, 1))), "summary row {row}");
        }
        assert_eq!(ws.get_value((1, 1)), Some(&Data::Float(10.0)));
        // Steps 시트
        let steps = wb.worksheet_range("Steps").unwrap();
        for col in 3..=5u32 {
            assert!(is_blank(steps.get_value((1, col))), "steps col {col}");
        }
        assert_eq!(steps.get_value((1, 2)), Some(&Data::Float(5.0)));
        // Windows 시트: 통과한 요청이 없는 초(1행)만 빈 칸, 통과한 요청이 있는 초(2행)는 값.
        let win = wb.worksheet_range("Windows").unwrap();
        for col in 4..=6u32 {
            assert!(is_blank(win.get_value((1, col))), "window col {col}");
        }
        assert_eq!(win.get_value((2, 4)), Some(&Data::Float(7.0)));
        // Other basis 시트: 그 리포트 자신의 sample 블록으로 판정한다. 본 리포트(옛 run, 같은
        // 숫자)는 값을 그대로 두고, 다른 기준(나눌 수 있는 run)만 빈 칸이다.
        let mut main = split_run("m", true, 40);
        main.sample = Default::default();
        let mut wb = read_xlsx(report_to_xlsx(&main, Some(&r)));
        let ws = wb.worksheet_range("Summary").unwrap();
        for row in 4..=6u32 {
            assert_eq!(
                ws.get_value((row, 1)),
                Some(&Data::Float(0.0)),
                "main {row}"
            );
        }
        let steps = wb.worksheet_range("Steps").unwrap();
        for col in 3..=5u32 {
            assert_eq!(
                steps.get_value((1, col)),
                Some(&Data::Float(0.0)),
                "main {col}"
            );
        }
        let other = wb.worksheet_range("Other basis").unwrap();
        for row in 5..=7u32 {
            assert!(is_blank(other.get_value((row, 1))), "other row {row}");
        }
        for col in 3..=5u32 {
            assert!(is_blank(other.get_value((10, col))), "other steps {col}");
        }
        assert_eq!(other.get_value((10, 2)), Some(&Data::Float(5.0)));
        // 요청이 0건인 요약·스텝·초도 통과한 요청이 없다: 0이 아니라 빈 칸.
        let mut z = split_run("z", false, 40);
        z.summary.count = 0;
        z.steps = vec![step("z", 0, 40)];
        z.windows.truncate(1);
        z.windows[0].count = 0;
        z.windows[0].error_count = 0;
        let csv = String::from_utf8(report_to_csv(&z)).unwrap();
        assert_eq!(csv.lines().nth(1).unwrap(), "z,0,0,,,");
        let mut wb = read_xlsx(report_to_xlsx(&z, None));
        let ws = wb.worksheet_range("Summary").unwrap();
        for row in 4..=6u32 {
            assert!(is_blank(ws.get_value((row, 1))), "zero summary row {row}");
        }
        let steps = wb.worksheet_range("Steps").unwrap();
        for col in 3..=5u32 {
            assert!(is_blank(steps.get_value((1, col))), "zero step col {col}");
        }
        let win = wb.worksheet_range("Windows").unwrap();
        for col in 4..=6u32 {
            assert!(is_blank(win.get_value((1, col))), "zero window col {col}");
        }
        // 옛 run(default == all)은 같은 숫자라도 칸을 비우지 않는다.
        let mut old = split_run("o", true, 40);
        old.sample = Default::default();
        let csv = String::from_utf8(report_to_csv(&old)).unwrap();
        assert_eq!(csv.lines().nth(1).unwrap(), "s,5,5,0,0,0");
    }

    fn compare_trio(missing_idx: usize) -> [ReportJson; 3] {
        let mut v = [
            split_run("A", false, 100),
            split_run("B", false, 100),
            split_run("C", false, 150),
        ];
        v[missing_idx] = split_run(["A", "B", "C"][missing_idx], true, 100);
        v
    }

    #[test]
    fn compare_skips_value_and_delta_when_either_side_missing() {
        use calamine::{Data, Reader};
        let blank = |v: Option<&Data>| matches!(v, None | Some(Data::Empty));
        // 가운데(B)가 값 없음. 열: A=1, B=2, C=3, Δ B=4, Δ C=5.
        let reports = compare_trio(1);
        let csv = String::from_utf8(comparison_to_csv(&reports, 0)).unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "metric,A (base),B,C,delta_pct B,delta_pct C");
        assert_eq!(lines[1], "p50_ms,50,,75,,0.500000");
        assert_eq!(lines[2], "p95_ms,100,,150,,0.500000");
        assert!(lines[4].starts_with("rps,"));
        let mut wb = read_xlsx(comparison_to_xlsx(&reports, 0));
        let ws = wb.worksheet_range("Summary").unwrap();
        for row in 1..=3u32 {
            assert!(!blank(ws.get_value((row, 1))), "base row {row}");
            assert!(blank(ws.get_value((row, 2))), "B value row {row}");
            assert!(blank(ws.get_value((row, 4))), "Δ B row {row}");
            assert_eq!(
                ws.get_value((row, 5)),
                Some(&Data::String("▲ +50.0%".into())),
                "Δ C is in its own column, row {row}"
            );
        }
        let st = wb.worksheet_range("Steps").unwrap();
        assert!(blank(st.get_value((1, 2))));
        assert!(blank(st.get_value((1, 4))));
        assert_eq!(st.get_value((1, 5)), Some(&Data::String("▲ +50.0%".into())));
        // 기준(A)이 값 없음: 값 칸과 모든 Δ 칸이 빈 칸.
        let reports = compare_trio(0);
        let csv = String::from_utf8(comparison_to_csv(&reports, 0)).unwrap();
        assert_eq!(csv.lines().nth(1).unwrap(), "p50_ms,,50,75,,");
        let mut wb = read_xlsx(comparison_to_xlsx(&reports, 0));
        let ws = wb.worksheet_range("Summary").unwrap();
        assert!(blank(ws.get_value((1, 1))));
        assert!(blank(ws.get_value((1, 4))));
        assert!(blank(ws.get_value((1, 5))));
        let st = wb.worksheet_range("Steps").unwrap();
        assert!(blank(st.get_value((1, 1))));
        assert!(blank(st.get_value((1, 4))));
        assert!(blank(st.get_value((1, 5))));
        // 비교 run(C)이 값 없음: 그 값 칸과 Δ 칸만 빈 칸.
        let reports = compare_trio(2);
        let csv = String::from_utf8(comparison_to_csv(&reports, 0)).unwrap();
        assert_eq!(csv.lines().nth(1).unwrap(), "p50_ms,50,50,,0.000000,");
        let mut wb = read_xlsx(comparison_to_xlsx(&reports, 0));
        let ws = wb.worksheet_range("Summary").unwrap();
        assert!(blank(ws.get_value((1, 3))));
        assert!(blank(ws.get_value((1, 5))));
        assert!(!blank(ws.get_value((1, 4))));
    }

    #[test]
    fn golden_missing_cases_match() {
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            reports: Vec<ReportJson>,
            baseline_id: String,
            expected: serde_json::Value,
        }
        #[derive(serde::Deserialize)]
        struct Golden {
            missing_cases: Vec<Case>,
        }
        let g: Golden = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/compare_golden.json"
        )))
        .expect("golden parse");
        assert_eq!(g.missing_cases.len(), 2);
        for case in &g.missing_cases {
            let base_idx = case
                .reports
                .iter()
                .position(|r| r.run.id == case.baseline_id)
                .unwrap();
            for row in case.expected["summary"].as_array().unwrap() {
                let metric = row["metric"].as_str().unwrap();
                let base = summary_value(&case.reports[base_idx], metric);
                for (i, r) in case.reports.iter().enumerate() {
                    let val = summary_value(r, metric);
                    let exp_val = &row["values"][i];
                    match val {
                        None => assert!(exp_val.is_null(), "{}: {metric} value {i}", case.name),
                        Some(v) => assert!(
                            (v - exp_val.as_f64().unwrap()).abs() < 1e-9,
                            "{}: {metric} value {i}",
                            case.name
                        ),
                    }
                    let exp = &row["deltas"][i];
                    match (i == base_idx, base, val) {
                        (false, Some(b), Some(v)) => {
                            let d = delta(metric, b, v);
                            assert!(
                                (d.pct.unwrap() - exp["pct"].as_f64().unwrap()).abs() < 1e-9,
                                "{}: {metric} pct {i}",
                                case.name
                            );
                            assert_eq!(
                                format!("{:?}", d.polarity).to_lowercase(),
                                exp["polarity"].as_str().unwrap(),
                                "{}: {metric} polarity {i}",
                                case.name
                            );
                        }
                        _ => assert!(exp.is_null(), "{}: {metric} delta {i}", case.name),
                    }
                }
            }
        }
    }
}
