//! 유지 구간(steady window) — profile.steady 설정·저장 모양 정규화.
//! 와이어(proto)엔 없다: 워커는 정규화된 `stages`/`target_rps`/`vus`+`ramp_up_seconds`만 받는다.

use handicap_engine::Stage;
use serde::{Deserialize, Serialize};

use crate::store::runs::Profile;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SteadyConfig {
    pub ramp_seconds: u32,
    pub hold_seconds: u32,
    pub discard_seconds: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<u32>,
}

pub fn validate_steady(c: &SteadyConfig) -> Result<(), String> {
    if c.ramp_seconds > 3600 {
        return Err("상승 시간은 0초 이상 3600초 이하여야 합니다".into());
    }
    if !(1..=86_400).contains(&c.hold_seconds) {
        return Err("유지 시간은 1초 이상 86400초 이하여야 합니다".into());
    }
    if c.discard_seconds > 3600 {
        return Err("앞부분 버림은 0초 이상 3600초 이하여야 합니다".into());
    }
    if c.hold_seconds.saturating_sub(c.discard_seconds) < 5 {
        return Err("앞부분 버림을 뺀 유지 시간이 5초 이상 남아야 합니다".into());
    }
    if let Some(t) = c.target
        && !(1..=1_000_000).contains(&t)
    {
        return Err("목표 도착률은 1 이상 1,000,000 이하여야 합니다".into());
    }
    if c.ramp_seconds == 0 && c.discard_seconds == 0 {
        return Err("상승 시간과 앞부분 버림이 모두 0이면 steady를 쓸 수 없습니다".into());
    }
    Ok(())
}

fn has_stages(p: &Profile) -> bool {
    p.stages.as_ref().is_some_and(|s| !s.is_empty())
}

/// `steady`가 없으면 no-op. 있으면 저장 모양(도착률+상승 → stages, 도착률 버림만 →
/// duration, 고정 VU → duration)으로 채우고, 이미 값이 있으면 일치할 때만 통과한다.
/// 반드시 `normalize_stair` 뒤, `validate_run_config` 앞에서.
pub fn normalize_steady(p: &mut Profile) -> Result<(), String> {
    let Some(c) = p.steady.clone() else {
        return Ok(());
    };
    validate_steady(&c)?;
    if p.stair.is_some() {
        return Err("유지 구간 설정(steady)과 계단 시험(stair)은 함께 쓸 수 없습니다".into());
    }
    if p.vu_stages.as_ref().is_some_and(|s| !s.is_empty()) {
        return Err("유지 구간 설정(steady)과 vu_stages는 함께 쓸 수 없습니다".into());
    }
    if let Some(target) = c.target {
        if c.ramp_seconds < 1 || p.max_in_flight.is_none() {
            return Err(
                "도착률 고정에 상승 시간을 쓰려면 steady.target과 max_in_flight가 필요합니다"
                    .into(),
            );
        }
        if p.target_rps.is_some() || p.vus > 0 || p.ramp_up_seconds > 0 || p.duration_seconds > 0 {
            return Err(
                "steady.target을 쓸 때는 target_rps·vus·ramp_up_seconds·duration_seconds를 비워야 합니다"
                    .into(),
            );
        }
        let w = p.worker_count.unwrap_or(1);
        if w > 1 && target < w {
            return Err(format!(
                "worker_count={w}이면 steady.target >= {w} 필요 (워커당 1 iter/s 이상)"
            ));
        }
        let expanded = vec![
            Stage {
                target,
                duration_seconds: c.ramp_seconds,
            },
            Stage {
                target,
                duration_seconds: c.hold_seconds,
            },
        ];
        return match p.stages.as_deref() {
            None | Some([]) => {
                p.stages = Some(expanded);
                Ok(())
            }
            Some(existing) if existing == expanded.as_slice() => Ok(()),
            Some(_) => Err(
                "유지 구간 설정(steady)과 stages가 일치하지 않습니다 — stages를 비우세요".into(),
            ),
        };
    }
    if p.target_rps.is_some() {
        if c.ramp_seconds != 0 {
            return Err(
                "도착률 고정에 상승 시간을 쓰려면 target_rps 대신 steady.target을 넣어야 합니다"
                    .into(),
            );
        }
        if has_stages(p) {
            return Err(
                "유지 구간 설정(steady)과 stages가 일치하지 않습니다 — stages를 비우세요".into(),
            );
        }
        return fill_duration(p, c.hold_seconds);
    }
    if has_stages(p) {
        return Err(
            "유지 구간 설정(steady)이 있는 고정 VU 부하에는 stages를 쓸 수 없습니다".into(),
        );
    }
    if p.ramp_up_seconds != c.ramp_seconds {
        return Err("steady.ramp_seconds와 ramp_up_seconds가 같아야 합니다".into());
    }
    fill_duration(p, c.ramp_seconds + c.hold_seconds)
}

fn fill_duration(p: &mut Profile, total: u32) -> Result<(), String> {
    match p.duration_seconds {
        0 => p.duration_seconds = total,
        d if d == total => {}
        _ => return Err("steady의 상승·유지 시간과 duration_seconds가 맞지 않습니다".into()),
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BasisState {
    Measured,
    Partial,
    NotReached,
    NoCommonWindow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Basis {
    Steady,
    Whole,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BasisWindow {
    pub start_ms: i64,
    pub end_ms: i64,
    pub measured_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BasisOther {
    pub rps: f64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub error_rate: f64,
    pub count: u64,
    pub duration_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BasisBlock {
    pub selected: Basis,
    pub default: Basis,
    pub state: BasisState,
    pub config: SteadyConfig,
    pub window: Option<BasisWindow>,
    pub t0_estimated: bool,
    pub dropped_whole_run: bool,
    pub other: Option<BasisOther>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SteadyWindow {
    /// ts_second 반열린 구간 [lo, hi). 창이 비면 None.
    pub range: Option<(i64, i64)>,
    pub state: BasisState,
    pub t0_estimated: bool,
}

fn ceil_sec(ms: i64) -> i64 {
    ms.div_euclid(1000) + i64::from(ms.rem_euclid(1000) > 0)
}

/// 워커별 (첫, 마지막) 메트릭 초. 키 = 메트릭 행이 있는 워커 id(서로 다름).
pub fn worker_spans(
    rows: &[crate::store::metrics::WindowWithHdr],
) -> std::collections::HashMap<&str, (i64, i64)> {
    let mut span: std::collections::HashMap<&str, (i64, i64)> = std::collections::HashMap::new();
    for r in rows {
        let e = span
            .entry(r.worker_id.as_str())
            .or_insert((r.ts_second, r.ts_second));
        e.0 = e.0.min(r.ts_second);
        e.1 = e.1.max(r.ts_second);
    }
    span
}

/// `rows`에서 `worker_spans`를 구해 `steady_window_from_spans`를 부른다.
#[cfg(test)]
pub fn steady_window(
    cfg: &SteadyConfig,
    completed: bool,
    ended_at_ms: Option<i64>,
    rows: &[crate::store::metrics::WindowWithHdr],
    starts: &[crate::store::open_loop::WorkerStartRow],
) -> SteadyWindow {
    steady_window_from_spans(
        cfg,
        completed,
        ended_at_ms,
        &worker_spans(rows),
        starts,
        &std::collections::HashMap::new(),
    )
}

/// 일한 워커(`span` 키)마다 시작 시각 기준 [lo, hi) 초를 구해 공통 구간을 낸다.
/// `ended_at_ms`: run의 끝 시각. completed가 아니면 끝(없으면 마지막 메트릭 초의 끝),
/// completed이면 있을 때만 `floor(ended_at_ms / 1000)`로 예정 끝을 줄인다(없으면 예정 끝).
pub fn steady_window_from_spans(
    cfg: &SteadyConfig,
    completed: bool,
    ended_at_ms: Option<i64>,
    span: &std::collections::HashMap<&str, (i64, i64)>,
    starts: &[crate::store::open_loop::WorkerStartRow],
    setup_done: &std::collections::HashMap<&str, i64>,
) -> SteadyWindow {
    let state_of = |found: bool| match (completed, found) {
        (true, true) => BasisState::Measured,
        (true, false) => BasisState::NoCommonWindow,
        (false, true) => BasisState::Partial,
        (false, false) => BasisState::NotReached,
    };
    if span.is_empty() {
        return SteadyWindow {
            range: None,
            state: state_of(false),
            t0_estimated: false,
        };
    }

    let last_metric = span.values().map(|s| s.1).max().unwrap_or(0);
    let end_sec = if completed {
        ended_at_ms.map(|ms| ms.div_euclid(1000))
    } else {
        let end_ms =
            ended_at_ms.unwrap_or_else(|| last_metric.saturating_add(1).saturating_mul(1000));
        Some(end_ms.div_euclid(1000))
    };
    let lead_ms = (i64::from(cfg.ramp_seconds) + i64::from(cfg.discard_seconds)) * 1000;
    let plan_ms = (i64::from(cfg.ramp_seconds) + i64::from(cfg.hold_seconds)) * 1000;

    let mut estimated = false;
    let mut lo = i64::MIN;
    let mut hi = i64::MAX;
    for (worker, (first, last)) in span {
        let known = starts
            .iter()
            .find(|s| s.worker_id == *worker)
            .map(|s| s.started_at_ms);
        let t0 = known.unwrap_or_else(|| {
            estimated = true;
            first.saturating_mul(1000)
        });
        let mut lo_w = ceil_sec(t0.saturating_add(lead_ms));
        if let Some(done) = setup_done.get(worker) {
            lo_w = lo_w.max(ceil_sec(*done));
        }
        let mut hi_w = t0.saturating_add(plan_ms).div_euclid(1000);
        if let Some(e) = end_sec {
            hi_w = hi_w.min(e);
        }
        if known.is_none() {
            hi_w = hi_w.min(last.saturating_add(1));
        }
        lo = lo.max(lo_w);
        hi = hi.min(hi_w);
    }

    let range = (lo < hi).then_some((lo, hi));
    SteadyWindow {
        range,
        state: state_of(range.is_some()),
        t0_estimated: estimated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Profile {
        Profile {
            vus: 0,
            ramp_up_seconds: 0,
            duration_seconds: 0,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            data_bindings: vec![],
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
            worker_count: None,
            apply_scenario_think_time: true,
            stair: None,
            steady: None,
        }
    }

    fn st(target: u32, d: u32) -> Stage {
        Stage {
            target,
            duration_seconds: d,
        }
    }

    fn sc(ramp: u32, hold: u32, discard: u32, target: Option<u32>) -> SteadyConfig {
        SteadyConfig {
            ramp_seconds: ramp,
            hold_seconds: hold,
            discard_seconds: discard,
            target,
        }
    }

    fn open_ramp() -> Profile {
        Profile {
            max_in_flight: Some(50),
            steady: Some(sc(20, 40, 5, Some(40))),
            ..base()
        }
    }

    fn open_discard() -> Profile {
        Profile {
            target_rps: Some(40),
            max_in_flight: Some(50),
            steady: Some(sc(0, 60, 5, None)),
            ..base()
        }
    }

    fn closed() -> Profile {
        Profile {
            vus: 10,
            ramp_up_seconds: 10,
            steady: Some(sc(10, 50, 5, None)),
            ..base()
        }
    }

    fn json(p: &Profile) -> serde_json::Value {
        serde_json::to_value(p).unwrap()
    }

    #[test]
    fn open_ramp_fills_stages() {
        let mut p = open_ramp();
        normalize_steady(&mut p).unwrap();
        assert_eq!(p.stages, Some(vec![st(40, 20), st(40, 40)]));
        assert_eq!(p.duration_seconds, 0);
        assert_eq!(p.target_rps, None);
    }

    #[test]
    fn open_ramp_requires_ramp_and_slots() {
        let mut p = open_ramp();
        p.steady = Some(sc(0, 40, 5, Some(40)));
        assert!(normalize_steady(&mut p).is_err());
        let mut p = open_ramp();
        p.max_in_flight = None;
        assert!(normalize_steady(&mut p).is_err());
    }

    #[test]
    fn open_ramp_rejects_extra_knobs() {
        let muts: [fn(&mut Profile); 4] = [
            |p| p.target_rps = Some(40),
            |p| p.vus = 3,
            |p| p.ramp_up_seconds = 5,
            |p| p.duration_seconds = 60,
        ];
        for m in muts {
            let mut p = open_ramp();
            m(&mut p);
            assert!(normalize_steady(&mut p).is_err());
        }
    }

    #[test]
    fn open_ramp_rejects_mismatched_stages() {
        let mut p = open_ramp();
        p.stages = Some(vec![st(40, 20), st(40, 41)]);
        let e = normalize_steady(&mut p).unwrap_err();
        assert!(e.contains("stages"), "{e}");
    }

    #[test]
    fn open_discard_only_fills_duration() {
        let mut p = open_discard();
        normalize_steady(&mut p).unwrap();
        assert_eq!(p.duration_seconds, 60);
        assert_eq!(p.stages, None);
    }

    #[test]
    fn open_discard_only_rejects() {
        let muts: [fn(&mut Profile); 3] = [
            |p| p.steady = Some(sc(10, 60, 5, None)),
            |p| p.stages = Some(vec![st(5, 10)]),
            |p| p.duration_seconds = 61,
        ];
        for m in muts {
            let mut p = open_discard();
            m(&mut p);
            assert!(normalize_steady(&mut p).is_err());
        }
        let mut p = open_discard();
        p.steady = Some(sc(10, 60, 5, None));
        let e = normalize_steady(&mut p).unwrap_err();
        assert!(e.contains("target_rps 대신"), "{e}");
    }

    #[test]
    fn closed_fills_duration() {
        let mut p = closed();
        normalize_steady(&mut p).unwrap();
        assert_eq!(p.duration_seconds, 60);
    }

    #[test]
    fn closed_requires_equal_ramp() {
        let mut p = closed();
        p.ramp_up_seconds = 0;
        assert!(normalize_steady(&mut p).is_err());
        let mut p = closed();
        p.duration_seconds = 61;
        assert!(normalize_steady(&mut p).is_err());
    }

    #[test]
    fn closed_rejects_stages() {
        let mut p = closed();
        p.stages = Some(vec![st(5, 10)]);
        assert!(normalize_steady(&mut p).is_err());
    }

    #[test]
    fn rejects_stair_and_vu_stages() {
        let mut p = closed();
        p.stair = Some(crate::stair::StairConfig {
            targets: vec![1, 2],
            hold_seconds: 20,
            ramp_seconds: 1,
            discard_seconds: 0,
            p99_cap_ms: None,
            auto_stop: None,
        });
        assert!(normalize_steady(&mut p).is_err());
        let mut p = closed();
        p.vu_stages = Some(vec![st(5, 10)]);
        assert!(normalize_steady(&mut p).is_err());
    }

    #[test]
    fn range_limits() {
        let bad = [
            sc(3601, 40, 5, Some(40)),
            sc(20, 0, 0, Some(40)),
            sc(20, 86_401, 5, Some(40)),
            sc(20, 40, 3601, Some(40)),
            sc(20, 9, 5, Some(40)),
            sc(20, 40, 5, Some(0)),
            sc(20, 40, 5, Some(1_000_001)),
            sc(0, 40, 0, None),
        ];
        for c in &bad {
            assert!(validate_steady(c).is_err(), "{c:?}");
        }
        assert!(validate_steady(&sc(20, 10, 5, Some(40))).is_ok());
    }

    #[test]
    fn open_ramp_rejects_target_below_worker_count() {
        let mut p = open_ramp();
        p.worker_count = Some(4);
        p.steady = Some(sc(20, 40, 5, Some(3)));
        let e = normalize_steady(&mut p).unwrap_err();
        assert!(e.contains("worker_count"), "{e}");
    }

    fn assert_renormalize_identity(mut p: Profile) {
        normalize_steady(&mut p).unwrap();
        let first = json(&p);
        let mut again = p.clone();
        normalize_steady(&mut again).unwrap();
        assert_eq!(json(&again), first);
    }

    #[test]
    fn renormalize_is_identity_open_ramp() {
        assert_renormalize_identity(open_ramp());
    }

    #[test]
    fn renormalize_is_identity_open_discard() {
        assert_renormalize_identity(open_discard());
    }

    #[test]
    fn renormalize_is_identity_closed() {
        assert_renormalize_identity(closed());
    }

    #[test]
    fn no_steady_is_noop() {
        let mut p = Profile {
            vus: 5,
            duration_seconds: 10,
            ..base()
        };
        let before = json(&p);
        normalize_steady(&mut p).unwrap();
        assert_eq!(json(&p), before);
    }

    #[test]
    fn serde_omits_absent_and_rejects_unknown() {
        assert!(!json(&base()).as_object().unwrap().contains_key("steady"));
        assert!(
            json(&open_ramp())
                .as_object()
                .unwrap()
                .contains_key("steady")
        );
        let bad = r#"{"ramp_seconds":1,"hold_seconds":10,"discard_seconds":0,"x":1}"#;
        assert!(serde_json::from_str::<SteadyConfig>(bad).is_err());
    }
}

#[cfg(test)]
mod window_tests {
    use super::*;
    use crate::store::metrics::WindowWithHdr;
    use crate::store::open_loop::WorkerStartRow;

    fn row(worker: &str, ts: i64) -> WindowWithHdr {
        WindowWithHdr {
            failed_hdr_histogram: None,
            ts_second: ts,
            step_id: "s".into(),
            worker_id: worker.into(),
            count: 1,
            error_count: 0,
            status_counts: "{}".into(),
            hdr_histogram: Vec::new(),
        }
    }

    fn rows(worker: &str, range: std::ops::RangeInclusive<i64>) -> Vec<WindowWithHdr> {
        range.map(|ts| row(worker, ts)).collect()
    }

    fn start(worker: &str, ms: i64) -> WorkerStartRow {
        WorkerStartRow {
            worker_id: worker.into(),
            started_at_ms: ms,
        }
    }

    fn cfg(ramp: u32, hold: u32, discard: u32) -> SteadyConfig {
        SteadyConfig {
            ramp_seconds: ramp,
            hold_seconds: hold,
            discard_seconds: discard,
            target: None,
        }
    }

    fn default_cfg() -> SteadyConfig {
        cfg(10, 30, 5)
    }

    #[test]
    fn single_worker_on_second_boundary() {
        let w = steady_window(
            &default_cfg(),
            true,
            None,
            &rows("w1", 100..=139),
            &[start("w1", 100_000)],
        );
        assert_eq!(w.range, Some((115, 140)));
        assert_eq!(w.state, BasisState::Measured);
        assert!(!w.t0_estimated);
    }

    #[test]
    fn partial_second_at_start_is_dropped() {
        let w = steady_window(
            &default_cfg(),
            true,
            None,
            &rows("w1", 100..=140),
            &[start("w1", 100_400)],
        );
        assert_eq!(w.range, Some((116, 140)));
    }

    #[test]
    fn zero_discard() {
        let w = steady_window(
            &cfg(10, 30, 0),
            true,
            None,
            &rows("w1", 100..=139),
            &[start("w1", 100_000)],
        );
        assert_eq!(w.range, Some((110, 140)));
    }

    #[test]
    fn zero_ramp() {
        let w = steady_window(
            &cfg(0, 30, 5),
            true,
            None,
            &rows("w1", 100..=129),
            &[start("w1", 100_000)],
        );
        assert_eq!(w.range, Some((105, 130)));
    }

    fn two_worker_rows() -> Vec<WindowWithHdr> {
        let mut r = rows("w1", 100..=139);
        r.extend(rows("w2", 102..=141));
        r
    }

    #[test]
    fn two_workers_use_common_range() {
        let w = steady_window(
            &default_cfg(),
            true,
            None,
            &two_worker_rows(),
            &[start("w1", 100_000), start("w2", 102_300)],
        );
        assert_eq!(w.range, Some((118, 140)));
        assert_eq!(w.state, BasisState::Measured);
    }

    #[test]
    fn idle_worker_is_ignored() {
        let w = steady_window(
            &default_cfg(),
            true,
            None,
            &two_worker_rows(),
            &[
                start("w1", 100_000),
                start("w2", 102_300),
                start("w3", 500_000),
            ],
        );
        assert_eq!(w.range, Some((118, 140)));
    }

    #[test]
    fn start_gap_larger_than_hold_is_no_common_window() {
        let mut r = rows("w1", 100..=139);
        r.extend(rows("w2", 130..=159));
        let w = steady_window(
            &default_cfg(),
            true,
            None,
            &r,
            &[start("w1", 100_000), start("w2", 130_000)],
        );
        assert_eq!(w.range, None);
        assert_eq!(w.state, BasisState::NoCommonWindow);
    }

    #[test]
    fn completed_run_without_metric_in_last_second_is_measured() {
        let w = steady_window(
            &default_cfg(),
            true,
            None,
            &rows("w1", 100..=136),
            &[start("w1", 100_000)],
        );
        assert_eq!(w.range, Some((115, 140)));
        assert_eq!(w.state, BasisState::Measured);
    }

    #[test]
    fn completed_run_that_ended_early_is_capped_at_ended_at() {
        let w = steady_window(
            &default_cfg(),
            true,
            Some(125_000),
            &rows("w1", 100..=124),
            &[start("w1", 100_000)],
        );
        assert_eq!(w.range, Some((115, 125)));
        assert_eq!(w.state, BasisState::Measured);
    }

    #[test]
    fn completed_run_ending_after_plan_is_not_shrunk() {
        let w = steady_window(
            &default_cfg(),
            true,
            Some(140_600),
            &rows("w1", 100..=136),
            &[start("w1", 100_000)],
        );
        assert_eq!(w.range, Some((115, 140)));
        assert_eq!(w.state, BasisState::Measured);
    }

    #[test]
    fn aborted_mid_window_is_partial() {
        let w = steady_window(
            &default_cfg(),
            false,
            Some(125_000),
            &rows("w1", 100..=124),
            &[start("w1", 100_000)],
        );
        assert_eq!(w.range, Some((115, 125)));
        assert_eq!(w.state, BasisState::Partial);
    }

    #[test]
    fn aborted_before_window_is_not_reached() {
        let w = steady_window(
            &default_cfg(),
            false,
            Some(112_000),
            &rows("w1", 100..=111),
            &[start("w1", 100_000)],
        );
        assert_eq!(w.range, None);
        assert_eq!(w.state, BasisState::NotReached);
    }

    #[test]
    fn aborted_run_with_one_worker_in_window_is_not_no_common_window() {
        let mut r = rows("w1", 100..=117);
        r.extend(rows("w2", 111..=117));
        let w = steady_window(
            &default_cfg(),
            false,
            Some(118_000),
            &r,
            &[start("w1", 100_000), start("w2", 111_000)],
        );
        assert_eq!(w.range, None);
        assert_eq!(w.state, BasisState::NotReached);
    }

    #[test]
    fn aborted_without_ended_at_uses_last_metric_second() {
        let w = steady_window(
            &default_cfg(),
            false,
            None,
            &rows("w1", 100..=124),
            &[start("w1", 100_000)],
        );
        assert_eq!(w.range, Some((115, 125)));
        assert_eq!(w.state, BasisState::Partial);
    }

    #[test]
    fn aborted_run_with_start_gap_larger_than_hold_is_not_reached() {
        let mut r = rows("w1", 100..=159);
        r.extend(rows("w2", 130..=159));
        let w = steady_window(
            &default_cfg(),
            false,
            Some(160_000),
            &r,
            &[start("w1", 100_000), start("w2", 130_000)],
        );
        assert_eq!(w.range, None);
        assert_eq!(w.state, BasisState::NotReached);
    }

    #[test]
    fn missing_start_is_estimated_from_first_metric() {
        let w = steady_window(&default_cfg(), true, None, &rows("w1", 103..=139), &[]);
        assert!(w.t0_estimated);
        assert_eq!(w.range, Some((118, 140)));
        assert_eq!(w.state, BasisState::Measured);
    }

    fn spans_of(worker: &str, a: i64, b: i64) -> std::collections::HashMap<&str, (i64, i64)> {
        std::collections::HashMap::from([(worker, (a, b))])
    }

    #[test]
    fn steady_lo_waits_for_setup_done() {
        let c = cfg(0, 30, 1);
        let starts = [start("w1", 100_000)];
        let span = spans_of("w1", 100, 139);
        let base = steady_window_from_spans(
            &c,
            true,
            None,
            &span,
            &starts,
            &std::collections::HashMap::new(),
        );
        assert_eq!(base.range, Some((101, 130)));
        let done = std::collections::HashMap::from([("w1", 102_400)]);
        let w = steady_window_from_spans(&c, true, None, &span, &starts, &done);
        assert_eq!(w.range, Some((ceil_sec(102_400), 130)));
        assert_eq!(w.range.unwrap().0, 103);
    }

    #[test]
    fn steady_setup_done_ignored_when_earlier() {
        let c = cfg(0, 30, 1);
        let starts = [start("w1", 100_000)];
        let span = spans_of("w1", 100, 139);
        let done = std::collections::HashMap::from([("w1", 100_200)]);
        let w = steady_window_from_spans(&c, true, None, &span, &starts, &done);
        assert_eq!(w.range, Some((101, 130)));
    }

    #[test]
    fn estimated_hi_capped_at_last_metric_plus_one() {
        let w = steady_window(&default_cfg(), true, None, &rows("w1", 103..=130), &[]);
        assert!(w.t0_estimated);
        assert_eq!(w.range, Some((118, 131)));
        assert_eq!(w.state, BasisState::Measured);
    }

    #[test]
    fn garbage_start_times_do_not_panic() {
        let c = default_cfg();
        let r1 = rows("w1", 100..=110);
        let _ = steady_window(&c, true, None, &r1, &[start("w1", i64::MAX)]);
        let _ = steady_window(&c, true, None, &r1, &[start("w1", i64::MIN)]);
        let _ = steady_window(&c, false, Some(i64::MAX), &r1, &[start("w1", i64::MIN)]);
        let mut r2 = rows("w1", 100..=110);
        r2.extend(rows("w2", 100..=110));
        let w = steady_window(
            &c,
            true,
            None,
            &r2,
            &[start("w1", i64::MAX), start("w2", i64::MIN)],
        );
        assert_eq!(w.range, None);
    }
}
