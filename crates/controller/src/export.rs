//! CSV/XLSX serialization of reports (single-run + N-run comparison).
//! Pure functions over `ReportJson` (built via build_report_for_run).
use crate::report::ReportJson;

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
                p50_ms: 0,
                p95_ms: 0,
                p99_ms: 0,
            },
            windows: vec![],
            steps,
            status_distribution: BTreeMap::new(),
            if_breakdown: vec![],
            verdict: None,
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
