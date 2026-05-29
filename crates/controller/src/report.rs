use crate::store::metrics::WindowWithHdr;
use crate::store::runs::RunRow;
use handicap_engine::percentiles::{Percentiles, decode_hdr, merge_into, percentiles_of};
use hdrhistogram::Histogram;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize)]
pub struct ReportJson {
    pub run: ReportRun,
    pub scenario_yaml: String,
    pub summary: ReportSummary,
    pub windows: Vec<ReportWindow>,
    pub steps: Vec<ReportStep>,
    pub status_distribution: BTreeMap<String, u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReportRun {
    pub id: String,
    pub scenario_id: String,
    pub status: String,
    pub profile: serde_json::Value,
    pub env: serde_json::Value,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReportSummary {
    pub count: u64,
    pub errors: u64,
    pub rps: f64,
    pub duration_seconds: i64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReportWindow {
    pub ts_second: i64,
    pub step_id: String,
    pub count: u64,
    pub error_count: u64,
    pub status_counts: BTreeMap<String, u64>,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReportStep {
    pub step_id: String,
    pub count: u64,
    pub error_count: u64,
    pub status_counts: BTreeMap<String, u64>,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

fn parse_status_counts(s: &str) -> BTreeMap<String, u64> {
    serde_json::from_str(s).unwrap_or_default()
}

fn add_status(into: &mut BTreeMap<String, u64>, from: &BTreeMap<String, u64>) {
    for (k, v) in from {
        *into.entry(k.clone()).or_insert(0) += v;
    }
}

const HDR_LO_US: u64 = 1;
const HDR_HI_US: u64 = 60_000_000;
const HDR_SIGFIG: u8 = 3;

fn fresh_hist() -> Histogram<u64> {
    Histogram::<u64>::new_with_bounds(HDR_LO_US, HDR_HI_US, HDR_SIGFIG)
        .expect("HDR bounds are valid")
}

pub fn build_report(run: &RunRow, scenario_yaml: &str, rows: &[WindowWithHdr]) -> ReportJson {
    let mut windows: Vec<ReportWindow> = Vec::with_capacity(rows.len());
    let mut overall = fresh_hist();
    let mut per_step: BTreeMap<String, Histogram<u64>> = BTreeMap::new();
    // (count, error_count, status_counts)
    let mut per_step_count: BTreeMap<String, (u64, u64, BTreeMap<String, u64>)> = BTreeMap::new();
    let mut status_dist: BTreeMap<String, u64> = BTreeMap::new();
    let mut total_count: u64 = 0;
    let mut total_errors: u64 = 0;

    for r in rows {
        let sc = parse_status_counts(&r.status_counts);
        let mut wp = Percentiles::empty();
        if let Ok(Some(h)) = decode_hdr(&r.hdr_histogram) {
            wp = percentiles_of(&h);
            merge_into(&mut overall, &h);
            let entry = per_step.entry(r.step_id.clone()).or_insert_with(fresh_hist);
            merge_into(entry, &h);
        }
        total_count += r.count as u64;
        total_errors += r.error_count as u64;
        add_status(&mut status_dist, &sc);
        let step_acc = per_step_count.entry(r.step_id.clone()).or_default();
        step_acc.0 += r.count as u64;
        step_acc.1 += r.error_count as u64;
        add_status(&mut step_acc.2, &sc);

        windows.push(ReportWindow {
            ts_second: r.ts_second,
            step_id: r.step_id.clone(),
            count: r.count as u64,
            error_count: r.error_count as u64,
            status_counts: sc,
            p50_ms: wp.p50_ms,
            p95_ms: wp.p95_ms,
            p99_ms: wp.p99_ms,
        });
    }

    let overall_p = percentiles_of(&overall);
    let profile_val = serde_json::to_value(&run.profile).unwrap_or(serde_json::Value::Null);
    let env_val = run.env.clone();
    // runs.started_at / ended_at are wall-clock milliseconds (now_ms in store/runs.rs).
    // Convert to seconds for the report; keep ms for rps so sub-second resolution survives.
    let duration_ms = run
        .ended_at
        .unwrap_or(0)
        .saturating_sub(run.started_at.unwrap_or(0));
    let duration_seconds = duration_ms / 1_000;
    let rps = if duration_ms > 0 {
        total_count as f64 * 1_000.0 / duration_ms as f64
    } else {
        0.0
    };

    let mut steps: Vec<ReportStep> = per_step_count
        .into_iter()
        .map(|(step_id, (count, errors, status_counts))| {
            let p = per_step
                .get(&step_id)
                .map(percentiles_of)
                .unwrap_or_else(Percentiles::empty);
            ReportStep {
                step_id,
                count,
                error_count: errors,
                status_counts,
                p50_ms: p.p50_ms,
                p95_ms: p.p95_ms,
                p99_ms: p.p99_ms,
            }
        })
        .collect();
    steps.sort_by(|a, b| a.step_id.cmp(&b.step_id));

    ReportJson {
        run: ReportRun {
            id: run.id.clone(),
            scenario_id: run.scenario_id.clone(),
            status: run.status.as_str().to_string(),
            profile: profile_val,
            env: env_val,
            started_at: run.started_at,
            ended_at: run.ended_at,
            created_at: run.created_at,
        },
        scenario_yaml: scenario_yaml.to_string(),
        summary: ReportSummary {
            count: total_count,
            errors: total_errors,
            rps,
            duration_seconds,
            p50_ms: overall_p.p50_ms,
            p95_ms: overall_p.p95_ms,
            p99_ms: overall_p.p99_ms,
        },
        windows,
        steps,
        status_distribution: status_dist,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::runs::{Profile, RunStatus};
    use hdrhistogram::serialization::{Serializer, V2Serializer};

    fn make_hdr_bytes(samples_us: &[u64]) -> Vec<u8> {
        let mut h = fresh_hist();
        for &v in samples_us {
            h.record(v).unwrap();
        }
        let mut buf = Vec::new();
        V2Serializer::new().serialize(&h, &mut buf).unwrap();
        buf
    }

    fn run_row() -> RunRow {
        RunRow {
            id: "R1".into(),
            scenario_id: "S1".into(),
            scenario_yaml: "version: 1\nname: x\nsteps: []\n".into(),
            profile: Profile {
                vus: 1,
                ramp_up_seconds: 0,
                duration_seconds: 2,
                loop_breakdown_cap: 256,
            },
            env: serde_json::Value::Object(serde_json::Map::new()),
            status: RunStatus::Completed,
            // ms wall-clock — a 2-second run (now_ms semantics from store/runs.rs).
            started_at: Some(100_000),
            ended_at: Some(102_000),
            created_at: 99_000,
            message: None,
        }
    }

    fn win(
        ts: i64,
        step: &str,
        count: i64,
        errors: i64,
        sc: &str,
        samples: &[u64],
    ) -> WindowWithHdr {
        WindowWithHdr {
            ts_second: ts,
            step_id: step.into(),
            count,
            error_count: errors,
            status_counts: sc.into(),
            hdr_histogram: make_hdr_bytes(samples),
        }
    }

    #[test]
    fn build_report_aggregates_totals() {
        let r = run_row();
        let rows = vec![
            win(
                100,
                "stepA",
                10,
                1,
                r#"{"200":9,"500":1}"#,
                &[10_000, 20_000],
            ),
            win(101, "stepA", 5, 0, r#"{"200":5}"#, &[15_000]),
            win(101, "stepB", 3, 1, r#"{"200":2,"500":1}"#, &[25_000]),
        ];
        let yaml = r.scenario_yaml.clone();
        let rpt = build_report(&r, &yaml, &rows);
        assert_eq!(rpt.summary.count, 18);
        assert_eq!(rpt.summary.errors, 2);
        assert_eq!(rpt.summary.duration_seconds, 2);
        assert!(rpt.summary.rps > 8.9 && rpt.summary.rps < 9.1);
        assert_eq!(rpt.windows.len(), 3);
        assert_eq!(rpt.steps.len(), 2);
        assert_eq!(rpt.status_distribution.get("200").copied(), Some(16));
        assert_eq!(rpt.status_distribution.get("500").copied(), Some(2));
        assert!(rpt.summary.p95_ms > 0);
    }

    #[test]
    fn build_report_tolerates_bad_hdr_blob() {
        let r = run_row();
        let bad = WindowWithHdr {
            ts_second: 100,
            step_id: "stepA".into(),
            count: 5,
            error_count: 0,
            status_counts: r#"{"200":5}"#.into(),
            hdr_histogram: vec![0xff, 0xff, 0xff, 0xff],
        };
        let yaml = r.scenario_yaml.clone();
        let rpt = build_report(&r, &yaml, &[bad]);
        assert_eq!(rpt.summary.count, 5);
        assert_eq!(rpt.status_distribution.get("200").copied(), Some(5));
        assert_eq!(rpt.windows[0].p95_ms, 0);
        assert_eq!(rpt.summary.p95_ms, 0);
    }
}
