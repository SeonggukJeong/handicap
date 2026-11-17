//! 계단 시험(stage-saturation-table) — profile.stair 설정·stages 펼침·정규화.
//! 와이어(proto)엔 없다: 워커는 펼쳐진 `stages`만 받는다.

use handicap_engine::Stage;
use serde::{Deserialize, Serialize};

use crate::store::runs::Profile;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StairConfig {
    pub targets: Vec<u32>,
    pub hold_seconds: u32,
    pub ramp_seconds: u32,
    pub discard_seconds: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p99_cap_ms: Option<u32>,
}

/// 계단 i마다 `[상승 t_i, 유지 t_i]`. 엔진 stage는 앞 목표→이 목표 선형 보간이라
/// 상승 stage가 경사, 유지 stage가 평평한 구간이 된다.
pub fn expand_stair(c: &StairConfig) -> Vec<Stage> {
    c.targets
        .iter()
        .flat_map(|&t| {
            [
                Stage {
                    target: t,
                    duration_seconds: c.ramp_seconds,
                },
                Stage {
                    target: t,
                    duration_seconds: c.hold_seconds,
                },
            ]
        })
        .collect()
}

pub fn validate_stair(c: &StairConfig) -> Result<(), String> {
    if !(2..=50).contains(&c.targets.len()) {
        return Err("계단 목표는 2개 이상 50개 이하여야 합니다".into());
    }
    if c.targets.iter().any(|t| !(1..=1_000_000).contains(t)) {
        return Err("계단 목표는 각각 1 이상 1,000,000 이하여야 합니다".into());
    }
    if c.targets.windows(2).any(|w| w[1] <= w[0]) {
        return Err("계단 목표는 앞보다 커지는 순서(중복 불가)여야 합니다".into());
    }
    if !(20..=3600).contains(&c.hold_seconds) {
        return Err("계단 유지 시간은 20초 이상 3600초 이하여야 합니다".into());
    }
    if !(1..=600).contains(&c.ramp_seconds) {
        return Err("계단 상승 시간은 1초 이상 600초 이하여야 합니다".into());
    }
    if c.discard_seconds > c.hold_seconds - 10 {
        return Err(format!(
            "앞부분 버림은 {}초 이하여야 합니다 (측정 구간이 10초 이상 남아야 함)",
            c.hold_seconds - 10
        ));
    }
    if let Some(cap) = c.p99_cap_ms
        && !(1..=600_000).contains(&cap)
    {
        return Err("p99 상한은 1ms 이상 600,000ms 이하여야 합니다".into());
    }
    Ok(())
}

/// `stair`가 있으면 stages를 펼쳐 채운다(없으면 no-op). 이미 stages가 있으면
/// 펼친 결과와 같을 때만 통과(저장본 재제출 round-trip). 반드시 `validate_run_config` 앞에서.
pub fn normalize_stair(p: &mut Profile) -> Result<(), String> {
    let Some(stair) = p.stair.as_ref() else {
        return Ok(());
    };
    validate_stair(stair)?;
    if p.target_rps.is_some() {
        return Err("계단 시험(stair)과 target_rps는 함께 쓸 수 없습니다".into());
    }
    if p.vu_stages.is_some() {
        return Err("계단 시험(stair)과 vu_stages는 함께 쓸 수 없습니다".into());
    }
    if p.duration_seconds > 0 {
        return Err(
            "계단 시험(stair)에선 duration_seconds를 비워야 합니다 (총 길이 = 계단 합)".into(),
        );
    }
    let expanded = expand_stair(stair);
    match p.stages.as_deref() {
        None | Some([]) => p.stages = Some(expanded),
        Some(existing) if existing == expanded.as_slice() => {}
        Some(_) => {
            return Err("계단 시험(stair)과 stages가 일치하지 않습니다 — stages를 비우세요".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> StairConfig {
        StairConfig {
            targets: vec![100, 200],
            hold_seconds: 60,
            ramp_seconds: 5,
            discard_seconds: 10,
            p99_cap_ms: None,
        }
    }

    fn profile(stair: Option<StairConfig>) -> Profile {
        serde_json::from_value(serde_json::json!({
            "duration_seconds": 0,
            "max_in_flight": 50,
        }))
        .map(|mut p: Profile| {
            p.stair = stair;
            p
        })
        .unwrap()
    }

    fn st(target: u32, d: u32) -> Stage {
        Stage {
            target,
            duration_seconds: d,
        }
    }

    #[test]
    fn expand_two_targets() {
        assert_eq!(
            expand_stair(&cfg()),
            vec![st(100, 5), st(100, 60), st(200, 5), st(200, 60)]
        );
    }

    #[test]
    fn validate_accepts_valid() {
        assert!(validate_stair(&cfg()).is_ok());
    }

    #[test]
    fn validate_rejects_bad_configs() {
        let bad: Vec<(&str, StairConfig)> = vec![
            (
                "one target",
                StairConfig {
                    targets: vec![100],
                    ..cfg()
                },
            ),
            (
                "51 targets",
                StairConfig {
                    targets: (1..=51).collect(),
                    ..cfg()
                },
            ),
            (
                "decreasing",
                StairConfig {
                    targets: vec![200, 100],
                    ..cfg()
                },
            ),
            (
                "duplicate",
                StairConfig {
                    targets: vec![100, 100],
                    ..cfg()
                },
            ),
            (
                "zero target",
                StairConfig {
                    targets: vec![0, 100],
                    ..cfg()
                },
            ),
            (
                "huge target",
                StairConfig {
                    targets: vec![100, 1_000_001],
                    ..cfg()
                },
            ),
            (
                "hold 19",
                StairConfig {
                    hold_seconds: 19,
                    discard_seconds: 0,
                    ..cfg()
                },
            ),
            (
                "hold 3601",
                StairConfig {
                    hold_seconds: 3601,
                    ..cfg()
                },
            ),
            (
                "ramp 0",
                StairConfig {
                    ramp_seconds: 0,
                    ..cfg()
                },
            ),
            (
                "ramp 601",
                StairConfig {
                    ramp_seconds: 601,
                    ..cfg()
                },
            ),
            (
                "discard too big",
                StairConfig {
                    discard_seconds: 51,
                    ..cfg()
                },
            ),
            (
                "cap 0",
                StairConfig {
                    p99_cap_ms: Some(0),
                    ..cfg()
                },
            ),
            (
                "cap huge",
                StairConfig {
                    p99_cap_ms: Some(600_001),
                    ..cfg()
                },
            ),
        ];
        for (name, c) in bad {
            assert!(validate_stair(&c).is_err(), "{name} should be rejected");
        }
    }

    #[test]
    fn validate_accepts_boundaries() {
        let c = StairConfig {
            targets: vec![1, 1_000_000],
            hold_seconds: 20,
            ramp_seconds: 1,
            discard_seconds: 10,
            p99_cap_ms: Some(600_000),
        };
        assert!(validate_stair(&c).is_ok());
        let c50 = StairConfig {
            targets: (1..=50).collect(),
            discard_seconds: 0,
            ..cfg()
        };
        assert!(validate_stair(&c50).is_ok());
    }

    #[test]
    fn normalize_fills_stages() {
        let mut p = profile(Some(cfg()));
        normalize_stair(&mut p).unwrap();
        assert_eq!(p.stages.unwrap(), expand_stair(&cfg()));
    }

    #[test]
    fn normalize_accepts_identical_stages_roundtrip() {
        let mut p = profile(Some(cfg()));
        p.stages = Some(expand_stair(&cfg()));
        assert!(normalize_stair(&mut p).is_ok());
        assert_eq!(p.stages.unwrap(), expand_stair(&cfg()));
    }

    #[test]
    fn normalize_rejects_different_stages() {
        let mut p = profile(Some(cfg()));
        p.stages = Some(vec![st(100, 5)]);
        assert!(normalize_stair(&mut p).is_err());
    }

    #[test]
    fn normalize_rejects_target_rps_vu_stages_and_duration() {
        let mut p = profile(Some(cfg()));
        p.target_rps = Some(10);
        assert!(normalize_stair(&mut p).is_err());
        let mut p = profile(Some(cfg()));
        p.vu_stages = Some(vec![st(1, 1)]);
        assert!(normalize_stair(&mut p).is_err());
        let mut p = profile(Some(cfg()));
        p.duration_seconds = 30;
        assert!(normalize_stair(&mut p).is_err());
    }

    #[test]
    fn normalize_rejects_invalid_config() {
        let mut p = profile(Some(StairConfig {
            targets: vec![100],
            ..cfg()
        }));
        assert!(normalize_stair(&mut p).is_err());
    }

    #[test]
    fn normalize_noop_without_stair() {
        let mut p = profile(None);
        p.target_rps = Some(10);
        normalize_stair(&mut p).unwrap();
        assert!(p.stages.is_none());
        assert_eq!(p.target_rps, Some(10));
    }

    #[test]
    fn profile_without_stair_serializes_without_key() {
        let p = profile(None);
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("stair").is_none());
        let p = profile(Some(cfg()));
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("stair").is_some());
        assert!(v["stair"].get("p99_cap_ms").is_none());
    }
}
