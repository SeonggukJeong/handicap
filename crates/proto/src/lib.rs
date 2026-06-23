#![allow(clippy::all)]

pub mod coordinator {
    pub mod v1 {
        tonic::include_proto!("handicap.coordinator.v1");
    }
}

pub use coordinator::v1;

use coordinator::v1::Profile;

/// Total run duration the engine will run for: VU-curve stage sum > rate-curve
/// stage sum > flat `duration_seconds`. **Invariant: engine deadline = this value.**
/// Single source shared by the worker (builds `RunPlan.duration`) and the
/// controller's run-progress watchdog (B backstop). Mirrors the formula formerly
/// private in `crates/worker/src/lib.rs`.
pub fn run_duration_secs(p: &Profile) -> u64 {
    if !p.vu_stages.is_empty() {
        p.vu_stages
            .iter()
            .map(|s| u64::from(s.duration_seconds))
            .sum()
    } else if p.stages.is_empty() {
        u64::from(p.duration_seconds)
    } else {
        p.stages.iter().map(|s| u64::from(s.duration_seconds)).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::v1::{Profile, Stage};

    fn stage(dur: u32) -> Stage {
        Stage {
            target: 0,
            duration_seconds: dur,
        }
    }

    #[test]
    fn flat_duration_when_no_stages() {
        let p = Profile {
            duration_seconds: 30,
            ..Default::default()
        };
        assert_eq!(super::run_duration_secs(&p), 30);
    }

    #[test]
    fn rate_curve_sums_stages() {
        let p = Profile {
            duration_seconds: 999,
            stages: vec![stage(5), stage(3)],
            ..Default::default()
        };
        assert_eq!(super::run_duration_secs(&p), 8);
    }

    #[test]
    fn vu_curve_takes_precedence_over_rate_and_flat() {
        let p = Profile {
            duration_seconds: 999,
            stages: vec![stage(100)],
            vu_stages: vec![stage(4), stage(6)],
            ..Default::default()
        };
        assert_eq!(super::run_duration_secs(&p), 10);
    }
}
