//! 계단 시험 자동 정지의 순수 규칙(포화 정지·즉시 정지)과 정지 기록 타입 (spec §4.2·§4.6).
//! 기록 타입의 직렬화는 `runs.auto_stop_json`·`RunResponse.auto_stop`의 와이어 계약이다 —
//! `Option`은 키를 생략하지 않고 항상 `null`로 낸다.

use serde::{Deserialize, Serialize};

use crate::stair::{BandKind, EmergencyStop, Judgement, SaturationStopMode, StepState};

/// 계단 `i`가 정지 판정상 실패인가 (완결 여부는 호출자가 `done`으로 따로 거른다).
pub fn step_failed(j: &Judgement, i: usize) -> bool {
    match j.states[i] {
        StepState::Saturated | StepState::Unconfirmed | StepState::Spike => true,
        StepState::After => !j.reasons[i].is_empty(),
        // 표시 상태 셋은 `judge`가 내지 않는다(리포트가 판정 뒤에 얹는다).
        StepState::Ok
        | StepState::NotMeasured
        | StepState::EmergencyStopped
        | StepState::Partial
        | StepState::Skipped => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaturationStop {
    pub failed_steps: Vec<usize>,
    pub decided_step: usize,
    pub slot_limited: bool,
}

/// 포화 정지. `done[i]` = 모든 워커에서 계단 i의 측정 구간이 끝났는가.
/// 마지막 계단까지 완결이면 항상 `None`(자연 종료와 같다).
pub fn saturation_stop(
    j: &Judgement,
    done: &[bool],
    mode: SaturationStopMode,
) -> Option<SaturationStop> {
    let n = done.len().min(j.states.len());
    if done.iter().all(|d| *d) {
        return None;
    }
    let fail = |i: usize| done[i] && step_failed(j, i);
    let failed_steps: Vec<usize> = match mode {
        SaturationStopMode::FirstFail => vec![(0..n).find(|&i| fail(i))?],
        SaturationStopMode::TwoFails => {
            let i = (0..n.saturating_sub(1)).find(|&i| fail(i) && fail(i + 1))?;
            vec![i, i + 1]
        }
    };
    let decided_step = *failed_steps.last()?;
    let slot_limited = failed_steps.iter().any(|&i| j.slot_limited[i]);
    Some(SaturationStop {
        failed_steps,
        decided_step,
        slot_limited,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmergencyHit {
    pub last_bad_ts: i64,
    pub max_error_rate: f64,
    pub max_p99_us: u64,
    pub seconds: u32,
    pub error_hit: bool,
    pub p99_hit: bool,
}

/// 즉시 정지 연속 계수기. 보류 초(`count < min_requests`)는 계수를 끊지도 늘리지도 않는다.
#[derive(Debug)]
pub struct EmergencyTracker {
    error_rate_pct: f64,
    p99_us_limit: u64,
    need: u32,
    min_requests: u64,
    streak: u32,
    last_bad_ts: i64,
    max_error_rate: f64,
    max_p99_us: u64,
    error_hit: bool,
    p99_hit: bool,
}

impl EmergencyTracker {
    pub fn new(c: &EmergencyStop) -> Self {
        Self {
            error_rate_pct: c.error_rate_pct,
            p99_us_limit: u64::from(c.p99_ms) * 1000,
            need: c.consecutive_seconds.max(1),
            min_requests: u64::from(c.min_requests),
            streak: 0,
            last_bad_ts: 0,
            max_error_rate: 0.0,
            max_p99_us: 0,
            error_hit: false,
            p99_hit: false,
        }
    }

    /// 연속 계수와 그 통계를 처음으로 — 판정 못 하고 버린 초(감시 보류)가 연속을 끊는다.
    pub fn reset(&mut self) {
        self.streak = 0;
        self.max_error_rate = 0.0;
        self.max_p99_us = 0;
        self.error_hit = false;
        self.p99_hit = false;
    }

    /// 한 절대 초의 합산값을 넣는다. 연속 N초가 채워지면 `Some`.
    pub fn observe(
        &mut self,
        ts: i64,
        count: u64,
        errors: u64,
        p99_us: u64,
    ) -> Option<EmergencyHit> {
        if count == 0 || count < self.min_requests {
            return None;
        }
        // 엄격한 초과 — 같으면 정상.
        let err_bad = (errors as f64) * 100.0 > self.error_rate_pct * (count as f64);
        let p99_bad = p99_us > self.p99_us_limit;
        if !(err_bad || p99_bad) {
            self.reset();
            return None;
        }
        self.streak += 1;
        self.last_bad_ts = ts;
        self.max_error_rate = self.max_error_rate.max(errors as f64 / count as f64);
        self.max_p99_us = self.max_p99_us.max(p99_us);
        self.error_hit |= err_bad;
        self.p99_hit |= p99_bad;
        (self.streak >= self.need).then_some(EmergencyHit {
            last_bad_ts: self.last_bad_ts,
            max_error_rate: self.max_error_rate,
            max_p99_us: self.max_p99_us,
            seconds: self.streak,
            error_hit: self.error_hit,
            p99_hit: self.p99_hit,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopKind {
    Saturation,
    Emergency,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EmergencyStats {
    pub max_error_rate: f64,
    pub max_p99_us: u64,
    pub seconds: u32,
    pub error_hit: bool,
    pub p99_hit: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StopInfo {
    pub kind: StopKind,
    pub mode: Option<SaturationStopMode>,
    pub failed_steps: Vec<u32>,
    pub decided_step: u32,
    pub judged_through: i64,
    pub phase: Option<BandKind>,
    pub decided_at_ms: i64,
    pub stopped_at_ms: i64,
    pub emergency: Option<EmergencyStats>,
    pub slot_limited: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AutoStopRecord {
    pub stop: Option<StopInfo>,
    pub suspended_seconds: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stair::{StairConfig, StepNumbers, judge};

    /// 'o' 정상 · 'f' 오류율 실패 · 'd' dropped만 실패 · 'n' 측정 미완결.
    fn steps(spec: &str, mode: SaturationStopMode) -> Option<SaturationStop> {
        let done: Vec<bool> = spec.chars().map(|c| c != 'n').collect();
        let nums: Vec<StepNumbers> = spec
            .chars()
            .enumerate()
            .map(|(i, c)| StepNumbers {
                target: 100 * (i as u32 + 1),
                achieved: None,
                dropped: Some(if c == 'd' { 5 } else { 0 }),
                error_rate: if c == 'f' { 0.5 } else { 0.0 },
                p99_us: 1_000,
                measured: done[i] && c != 'n',
            })
            .collect();
        let cfg = StairConfig {
            targets: nums.iter().map(|n| n.target).collect(),
            hold_seconds: 60,
            ramp_seconds: 5,
            discard_seconds: 10,
            p99_cap_ms: None,
            auto_stop: None,
        };
        let j = judge(&nums, &cfg);
        saturation_stop(&j, &done, mode)
    }

    use SaturationStopMode::{FirstFail, TwoFails};

    fn stop(failed: &[usize], decided: usize, slot: bool) -> Option<SaturationStop> {
        Some(SaturationStop {
            failed_steps: failed.to_vec(),
            decided_step: decided,
            slot_limited: slot,
        })
    }

    #[test]
    fn two_fails_consecutive() {
        assert_eq!(steps("ooffn", TwoFails), stop(&[2, 3], 3, false));
    }

    #[test]
    fn two_fails_spike_then_continue() {
        assert_eq!(steps("ofon", TwoFails), None);
        assert_eq!(steps("ofoffn", TwoFails), stop(&[3, 4], 4, false));
    }

    #[test]
    fn two_fails_first_step_fail_then_ok_continues() {
        assert_eq!(steps("fon", TwoFails), None);
    }

    #[test]
    fn two_fails_after_pair_stops() {
        assert_eq!(steps("fofffn", TwoFails), stop(&[2, 3], 3, false));
    }

    #[test]
    fn two_fails_last_step_done_no_stop() {
        assert_eq!(steps("ooff", TwoFails), None);
        assert_eq!(steps("ooff", FirstFail), None);
    }

    #[test]
    fn first_fail_stops_at_first() {
        assert_eq!(steps("ofn", FirstFail), stop(&[1], 1, false));
    }

    #[test]
    fn first_fail_first_step() {
        assert_eq!(steps("fn", FirstFail), stop(&[0], 0, false));
    }

    #[test]
    fn slot_limited_reason_counts_as_fail() {
        assert_eq!(steps("oddn", TwoFails), stop(&[1, 2], 2, true));
        assert_eq!(steps("odn", FirstFail), stop(&[1], 1, true));
    }

    fn emergency(n: u32, min: u32) -> EmergencyTracker {
        EmergencyTracker::new(&EmergencyStop {
            error_rate_pct: 5.0,
            p99_ms: 2000,
            consecutive_seconds: n,
            min_requests: min,
        })
    }

    const BAD_ERR: (u64, u64, u64) = (100, 50, 1000);

    fn obs(t: &mut EmergencyTracker, ts: i64, v: (u64, u64, u64)) -> Option<EmergencyHit> {
        t.observe(ts, v.0, v.1, v.2)
    }

    #[test]
    fn streak_n_seconds_stops() {
        let mut t = emergency(3, 20);
        assert!(obs(&mut t, 10, BAD_ERR).is_none());
        assert!(obs(&mut t, 11, BAD_ERR).is_none());
        let h = obs(&mut t, 12, BAD_ERR).unwrap();
        assert_eq!(h.last_bad_ts, 12);
        assert_eq!(h.seconds, 3);
        assert!(h.error_hit && !h.p99_hit);
        assert_eq!(h.max_error_rate, 0.5);
    }

    #[test]
    fn held_seconds_skip_without_breaking_streak() {
        let mut t = emergency(3, 20);
        assert!(obs(&mut t, 1, BAD_ERR).is_none());
        assert!(t.observe(2, 5, 0, 0).is_none());
        assert!(obs(&mut t, 3, BAD_ERR).is_none());
        let h = obs(&mut t, 4, BAD_ERR).unwrap();
        assert_eq!(h.last_bad_ts, 4);
    }

    #[test]
    fn good_second_resets_streak() {
        let mut t = emergency(3, 20);
        obs(&mut t, 1, BAD_ERR);
        obs(&mut t, 2, BAD_ERR);
        assert!(t.observe(3, 100, 0, 1000).is_none());
        assert!(obs(&mut t, 4, BAD_ERR).is_none());
        assert!(obs(&mut t, 5, BAD_ERR).is_none());
        assert!(obs(&mut t, 6, BAD_ERR).is_some());
    }

    #[test]
    fn min_requests_boundary() {
        let mut t = emergency(1, 20);
        assert!(t.observe(1, 19, 19, 0).is_none());
        assert!(t.observe(2, 20, 20, 0).is_some());
        // 0건 초도 보류
        let mut t = emergency(1, 0);
        assert!(t.observe(1, 0, 0, 9_000_000).is_none());
    }

    #[test]
    fn both_conditions_same_second() {
        let mut t = emergency(1, 20);
        let h = t.observe(1, 100, 50, 3_100_000).unwrap();
        assert!(h.error_hit && h.p99_hit);
        assert_eq!(h.max_p99_us, 3_100_000);
    }

    #[test]
    fn equal_to_threshold_is_ok() {
        let mut t = emergency(1, 20);
        assert!(t.observe(1, 20, 1, 2_000_000).is_none());
        assert!(t.observe(2, 20, 2, 2_000_000).is_some());
        assert!(t.observe(3, 20, 1, 2_000_001).is_some());
    }

    #[test]
    fn hit_stats_are_max_or_and_reset_by_good_second() {
        let mut t = emergency(3, 20);
        // p99만 나쁜 초 → 정상 초로 끊김(통계도 같이 초기화돼야 한다)
        assert!(t.observe(1, 100, 0, 3_000_000).is_none());
        assert!(t.observe(2, 100, 0, 1_000).is_none());
        // 오류율만 나쁜 3초: 0.2, 0.5, 0.3 / p99는 한도 안에서 가운데가 최대
        assert!(t.observe(3, 100, 20, 1_000).is_none());
        assert!(t.observe(4, 100, 50, 1_900_000).is_none());
        let h = t.observe(5, 100, 30, 500).unwrap();
        assert!(h.error_hit && !h.p99_hit);
        assert_eq!(h.max_error_rate, 0.5);
        assert_eq!(h.max_p99_us, 1_900_000);
        assert_eq!(h.seconds, 3);

        // 서로 다른 초에 걸린 두 조건은 OR로 합쳐진다.
        let mut t = emergency(3, 20);
        assert!(t.observe(1, 100, 0, 3_000_000).is_none());
        assert!(t.observe(2, 100, 50, 1_000).is_none());
        let h = t.observe(3, 100, 10, 1_000).unwrap();
        assert!(h.error_hit && h.p99_hit);
        assert_eq!(h.max_error_rate, 0.5);
        assert_eq!(h.max_p99_us, 3_000_000);
    }

    #[test]
    fn record_json_shape() {
        let r = AutoStopRecord {
            stop: None,
            suspended_seconds: 4,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v, serde_json::json!({"stop": null, "suspended_seconds": 4}));

        let sat = StopInfo {
            kind: StopKind::Saturation,
            mode: Some(SaturationStopMode::TwoFails),
            failed_steps: vec![6, 7],
            decided_step: 7,
            judged_through: 7,
            phase: None,
            decided_at_ms: 1,
            stopped_at_ms: 2,
            emergency: None,
            slot_limited: false,
        };
        let v = serde_json::to_value(&sat).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "decided_at_ms",
                "decided_step",
                "emergency",
                "failed_steps",
                "judged_through",
                "kind",
                "mode",
                "phase",
                "slot_limited",
                "stopped_at_ms"
            ]
        );
        assert_eq!(v["kind"], "saturation");
        assert_eq!(v["mode"], "two_fails");
        assert!(v["phase"].is_null() && v["emergency"].is_null());

        let em = StopInfo {
            kind: StopKind::Emergency,
            mode: None,
            failed_steps: vec![],
            decided_step: 3,
            judged_through: -1,
            phase: Some(BandKind::Discard),
            decided_at_ms: 1,
            stopped_at_ms: 2,
            emergency: Some(EmergencyStats {
                max_error_rate: 0.12,
                max_p99_us: 3_100_000,
                seconds: 3,
                error_hit: true,
                p99_hit: false,
            }),
            slot_limited: false,
        };
        let rec = AutoStopRecord {
            stop: Some(em),
            suspended_seconds: 0,
        };
        let v = serde_json::to_value(&rec).unwrap();
        assert!(v["stop"]["mode"].is_null());
        assert_eq!(v["stop"]["phase"], "discard");
        assert_eq!(v["stop"]["kind"], "emergency");
        let back: AutoStopRecord = serde_json::from_value(v).unwrap();
        assert_eq!(back, rec);
        let back: StopInfo = serde_json::from_value(serde_json::to_value(&sat).unwrap()).unwrap();
        assert_eq!(back, sat);
    }
}
