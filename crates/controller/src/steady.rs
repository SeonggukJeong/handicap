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
                "도착률 고정에 상승 시간을 쓰려면 steady.target과 max_in_flight가 필요합니다"
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
