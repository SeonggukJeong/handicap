//! 계단 run 실행 중 요약의 순수 모델 — `RunResponse.auto_stop_live` 와이어.
//! `Option`은 키를 생략하지 않고 항상 `null`로 직렬화한다.

use serde::Serialize;

use crate::auto_stop::{StopInfo, step_failed};
use crate::stair::{
    BandKind, Judgement, SaturationStopMode, StairConfig, StepState, stop_row_state,
};

/// 리포트 `StepState` 9종과 같은 이름·같은 직렬화 + 실행 중 전용 3종.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveStepState {
    Ok,
    Spike,
    Saturated,
    Unconfirmed,
    After,
    NotMeasured,
    EmergencyStopped,
    Partial,
    Skipped,
    Measuring,
    Pending,
    Frozen,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EmergencyNow {
    pub error_rate: f64,
    pub p99_us: u64,
    pub bad_streak: u32,
    pub held: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveState {
    pub current_step: Option<u32>,
    pub phase: Option<BandKind>,
    pub step_states: Vec<LiveStepState>,
    pub last_ok_step: Option<u32>,
    pub next_fail_stops: bool,
    pub emergency_now: Option<EmergencyNow>,
    pub suspended_seconds: u32,
    pub frozen: bool,
    pub stop: Option<StopInfo>,
}

pub struct LiveInputs<'a> {
    pub cfg: &'a StairConfig,
    /// 판정에 넣은 계단 수(앞에서부터).
    pub judged: usize,
    /// `judged` 계단까지 넣은 `judge` 결과. `judged == 0`이면 `None`.
    pub judgement: Option<&'a Judgement>,
    pub current: Option<(u32, BandKind)>,
    pub frozen: bool,
    /// 감시가 정지를 냈다(기록이 아직 없을 수 있음).
    pub stopped: bool,
    /// `stopped_at_ms`가 채워진 기록.
    pub stop: Option<&'a StopInfo>,
    /// 시작 시각을 보낸 워커 중 가장 이른 t0.
    pub stop_t0_ms: Option<i64>,
    pub emergency_now: Option<EmergencyNow>,
    pub suspended_seconds: u32,
}

pub fn live_step_state(s: StepState) -> LiveStepState {
    match s {
        StepState::Ok => LiveStepState::Ok,
        StepState::Spike => LiveStepState::Spike,
        StepState::Saturated => LiveStepState::Saturated,
        StepState::Unconfirmed => LiveStepState::Unconfirmed,
        StepState::After => LiveStepState::After,
        StepState::NotMeasured => LiveStepState::NotMeasured,
        StepState::EmergencyStopped => LiveStepState::EmergencyStopped,
        StepState::Partial => LiveStepState::Partial,
        StepState::Skipped => LiveStepState::Skipped,
    }
}

pub fn build_live(inp: &LiveInputs) -> LiveState {
    let n = inp.cfg.targets.len();
    let judged_states: &[StepState] = inp
        .judgement
        .map_or(&[][..], |j| &j.states[..inp.judged.min(j.states.len())]);

    let step_states = (0..n)
        .map(|i| {
            if let Some(stop) = inp.stop
                && i as i64 > stop.judged_through
            {
                return live_step_state(stop_row_state(inp.cfg, stop, inp.stop_t0_ms, i).0);
            }
            if let Some(&s) = judged_states.get(i) {
                return live_step_state(s);
            }
            if inp.frozen {
                return LiveStepState::Frozen;
            }
            match inp.current {
                Some((cur, _)) if i <= cur as usize => LiveStepState::Measuring,
                _ => LiveStepState::Pending,
            }
        })
        .collect();

    let mode = inp.cfg.auto_stop.as_ref().and_then(|a| a.saturation);
    let judged = judged_states.len();
    let next_fail_stops = mode.is_some_and(|mode| {
        !inp.stopped
            && inp.stop.is_none()
            && !inp.frozen
            && judged + 1 < n
            && !judged_states.contains(&StepState::NotMeasured)
            && (mode == SaturationStopMode::FirstFail
                || (judged >= 1 && inp.judgement.is_some_and(|j| step_failed(j, judged - 1))))
    });

    LiveState {
        current_step: inp.current.map(|c| c.0),
        phase: inp.current.map(|c| c.1),
        step_states,
        last_ok_step: inp.judgement.and_then(|j| j.last_ok).map(|i| i as u32),
        next_fail_stops,
        emergency_now: inp.emergency_now.clone(),
        suspended_seconds: inp.suspended_seconds,
        frozen: inp.frozen,
        stop: inp.stop.cloned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auto_stop::{StopInfo, StopKind};
    use crate::stair::{
        AutoStopConfig, BandKind, SaturationStopMode, StairConfig, StepNumbers, StepState, judge,
    };
    use SaturationStopMode::{FirstFail, TwoFails};

    const T0: i64 = 1_000_000;

    fn cfg(n: usize, mode: Option<SaturationStopMode>) -> StairConfig {
        StairConfig {
            targets: (1..=n as u32).map(|i| i * 100).collect(),
            hold_seconds: 60,
            ramp_seconds: 5,
            discard_seconds: 10,
            p99_cap_ms: None,
            auto_stop: mode.map(|m| AutoStopConfig {
                saturation: Some(m),
                emergency: None,
            }),
        }
    }

    fn step_ms(c: &StairConfig) -> i64 {
        i64::from(c.ramp_seconds + c.hold_seconds) * 1000
    }

    /// 'o' 정상 · 'f' 오류율 실패 · 'n' 측정 안 됨. spec 길이 뒤는 측정 안 됨.
    fn jud(spec: &str, n: usize) -> Judgement {
        let c = cfg(n, None);
        let chars: Vec<char> = spec.chars().collect();
        let nums: Vec<StepNumbers> = (0..n)
            .map(|i| {
                let ch = chars.get(i).copied().unwrap_or('n');
                StepNumbers {
                    target: c.targets[i],
                    achieved: None,
                    dropped: Some(0),
                    error_rate: if ch == 'f' { 0.5 } else { 0.0 },
                    p99_us: 1_000,
                    measured: ch != 'n',
                }
            })
            .collect();
        judge(&nums, &c)
    }

    fn inp<'a>(c: &'a StairConfig, judged: usize, j: Option<&'a Judgement>) -> LiveInputs<'a> {
        LiveInputs {
            cfg: c,
            judged,
            judgement: j,
            current: None,
            frozen: false,
            stopped: false,
            stop: None,
            stop_t0_ms: None,
            emergency_now: None,
            suspended_seconds: 0,
        }
    }

    use LiveStepState as L;

    #[test]
    fn maps_report_states() {
        let all = [
            (StepState::Ok, L::Ok),
            (StepState::Spike, L::Spike),
            (StepState::Saturated, L::Saturated),
            (StepState::Unconfirmed, L::Unconfirmed),
            (StepState::After, L::After),
            (StepState::NotMeasured, L::NotMeasured),
            (StepState::EmergencyStopped, L::EmergencyStopped),
            (StepState::Partial, L::Partial),
            (StepState::Skipped, L::Skipped),
        ];
        for (s, l) in all {
            assert_eq!(live_step_state(s), l);
            assert_eq!(
                serde_json::to_value(s).unwrap(),
                serde_json::to_value(l).unwrap()
            );
        }
    }

    #[test]
    fn no_data_all_pending() {
        let c = cfg(4, Some(TwoFails));
        let l = build_live(&inp(&c, 0, None));
        assert_eq!(l.step_states, vec![L::Pending; 4]);
        assert_eq!(l.last_ok_step, None);
        assert!(!l.next_fail_stops);
    }

    #[test]
    fn judged_then_measuring_then_pending() {
        let c = cfg(6, Some(TwoFails));
        let j = jud("ooof", 6);
        let mut i = inp(&c, 4, Some(&j));
        i.current = Some((4, BandKind::Measure));
        let l = build_live(&i);
        assert_eq!(
            l.step_states,
            vec![
                L::Ok,
                L::Ok,
                L::Ok,
                L::Unconfirmed,
                L::Measuring,
                L::Pending
            ]
        );
        assert_eq!(l.last_ok_step, Some(2));
    }

    #[test]
    fn unconfirmed_then_spike_or_saturated() {
        let c = cfg(6, Some(TwoFails));
        let states = |spec: &str, judged: usize| {
            let j = jud(spec, 6);
            build_live(&inp(&c, judged, Some(&j))).step_states
        };
        assert_eq!(states("oof", 3)[2], L::Unconfirmed);
        assert_eq!(states("oofo", 4)[2], L::Spike);
        let s = states("ooff", 4);
        assert_eq!((s[2], s[3]), (L::Saturated, L::Saturated));
        let s = states("ooffo", 5);
        assert_eq!((s[2], s[3]), (L::Saturated, L::Saturated));
        assert_eq!(states("f", 1)[0], L::Unconfirmed);
        let s = states("fo", 2);
        assert_eq!((s[0], s[1]), (L::Saturated, L::After));
    }

    #[test]
    fn lagging_steps_are_measuring() {
        let c = cfg(6, Some(TwoFails));
        let j = jud("oo", 6);
        let mut i = inp(&c, 2, Some(&j));
        i.current = Some((4, BandKind::Ramp));
        let l = build_live(&i);
        assert_eq!(
            &l.step_states[2..],
            &[L::Measuring, L::Measuring, L::Measuring, L::Pending]
        );
    }

    #[test]
    fn forecast_two_fails() {
        let fc = |n: usize, spec: &str, judged: usize, mode| {
            let c = cfg(n, mode);
            let j = jud(spec, n);
            build_live(&inp(&c, judged, Some(&j))).next_fail_stops
        };
        assert!(fc(6, "ooof", 4, Some(TwoFails)));
        assert!(!fc(6, "oooo", 4, Some(TwoFails)));
        assert!(!fc(5, "ooof", 4, Some(TwoFails)));
        assert!(!fc(6, "ooof", 4, None));
    }

    #[test]
    fn forecast_first_fail() {
        let c = cfg(6, Some(FirstFail));
        let j = jud("oo", 6);
        assert!(build_live(&inp(&c, 2, Some(&j))).next_fail_stops);
        let j = jud("ooooo", 6);
        assert!(!build_live(&inp(&c, 5, Some(&j))).next_fail_stops);
    }

    #[test]
    fn forecast_off_after_not_measured() {
        let c = cfg(6, Some(FirstFail));
        let j = jud("on", 6);
        assert!(!build_live(&inp(&c, 2, Some(&j))).next_fail_stops);
    }

    #[test]
    fn stopped_hides_forecast() {
        let c = cfg(6, Some(TwoFails));
        let j = jud("ooof", 6);
        assert!(build_live(&inp(&c, 4, Some(&j))).next_fail_stops);
        let mut i = inp(&c, 4, Some(&j));
        i.stopped = true;
        assert!(!build_live(&i).next_fail_stops);
    }

    #[test]
    fn frozen_marks_unjudged_and_hides_forecast() {
        let c = cfg(6, Some(TwoFails));
        let j = jud("oo", 6);
        let mut i = inp(&c, 2, Some(&j));
        i.frozen = true;
        i.current = Some((4, BandKind::Measure));
        let l = build_live(&i);
        assert_eq!(&l.step_states[2..], &[L::Frozen; 4]);
        assert!(!l.next_fail_stops);
        assert!(l.frozen);
    }

    fn stop_info(kind: StopKind, decided: u32, through: i64, stopped_at: i64) -> StopInfo {
        StopInfo {
            kind,
            mode: Some(TwoFails),
            failed_steps: vec![decided],
            decided_step: decided,
            judged_through: through,
            phase: None,
            decided_at_ms: stopped_at,
            stopped_at_ms: stopped_at,
            emergency: None,
            slot_limited: false,
        }
    }

    #[test]
    fn saturation_stop_states_match_stop_row_state() {
        let c = cfg(6, Some(TwoFails));
        let j = jud("ooff", 6);
        let s = stop_info(StopKind::Saturation, 3, 3, T0 + 4 * step_ms(&c) + 2000);
        let mut i = inp(&c, 4, Some(&j));
        i.stop = Some(&s);
        i.stopped = true;
        i.stop_t0_ms = Some(T0);
        let l = build_live(&i);
        assert_eq!(
            l.step_states,
            vec![
                L::Ok,
                L::Ok,
                L::Saturated,
                L::Saturated,
                L::Partial,
                L::Skipped
            ]
        );
    }

    #[test]
    fn emergency_stop_states() {
        let c = cfg(5, None);
        let j = jud("o", 5);
        let s = stop_info(StopKind::Emergency, 2, 0, T0 + 2 * step_ms(&c) + 1500);
        let mut i = inp(&c, 1, Some(&j));
        i.stop = Some(&s);
        i.stopped = true;
        i.stop_t0_ms = Some(T0);
        let l = build_live(&i);
        assert_eq!(
            l.step_states,
            vec![
                L::Ok,
                L::NotMeasured,
                L::EmergencyStopped,
                L::Skipped,
                L::Skipped
            ]
        );
    }

    #[test]
    fn serializes_nulls() {
        let c = cfg(3, Some(TwoFails));
        let v = serde_json::to_value(build_live(&inp(&c, 0, None))).unwrap();
        let o = v.as_object().unwrap();
        for k in [
            "current_step",
            "phase",
            "emergency_now",
            "stop",
            "last_ok_step",
        ] {
            assert!(o.contains_key(k), "{k}");
            assert!(o[k].is_null(), "{k}");
        }
        assert_eq!(v["step_states"][0], "pending");
    }
}
