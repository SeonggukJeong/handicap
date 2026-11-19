//! 계단 run 실행 중 요약의 순수 모델 — `RunResponse.auto_stop_live` 와이어.
//! `Option`은 키를 생략하지 않고 항상 `null`로 직렬화한다.

use serde::Serialize;

use crate::auto_stop::{StopInfo, step_failed};
use crate::stair::{
    BandKind, Judgement, P99_FAST_US, Reason, SaturationStopMode, StairConfig, StepState,
    stop_row_state,
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

/// 계단 하나의 판정 사유 — 리포트 `ReportJson` 사유 칸과 같은 `Reason`.
/// `ref_fast`: 앞쪽 가장 가까운 정상 계단의 p99가 `P99_FAST_US` 미만(「p99 5 ms 이상」 문구 갈림).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveStepReasons {
    pub reasons: Vec<Reason>,
    pub slot_limited: bool,
    pub ref_fast: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveState {
    pub current_step: Option<u32>,
    pub phase: Option<BandKind>,
    pub step_states: Vec<LiveStepState>,
    pub step_reasons: Vec<LiveStepReasons>,
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
    /// 마지막 판정에 넣은 계단별 p99(µs, 인덱스 = 계단). 판정 전이면 빈 슬라이스.
    pub judged_p99_us: &'a [u64],
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

    let judged = judged_states.len();
    // 판정이 현재 구간을 앞질렀으면(감시가 구간 신호보다 먼저 판정) 다음 계단 상승 중으로 올려 보인다.
    let current = match inp.current {
        Some((c, _)) if (c as usize) < judged => {
            (judged < n).then_some((judged as u32, BandKind::Ramp))
        }
        other => other,
    };

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
            match current {
                Some((cur, _)) if i <= cur as usize => LiveStepState::Measuring,
                _ => LiveStepState::Pending,
            }
        })
        .collect();

    let mode = inp.cfg.auto_stop.as_ref().and_then(|a| a.saturation);
    let step_reasons = (0..n)
        .map(|i| match inp.judgement {
            Some(j) if i < judged => LiveStepReasons {
                reasons: j.reasons[i].clone(),
                slot_limited: j.slot_limited[i],
                ref_fast: (0..i)
                    .rev()
                    .find(|&k| j.states[k] == StepState::Ok)
                    .and_then(|k| inp.judged_p99_us.get(k))
                    .is_some_and(|&p| p < P99_FAST_US),
            },
            _ => LiveStepReasons {
                reasons: vec![],
                slot_limited: false,
                ref_fast: false,
            },
        })
        .collect();
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
        current_step: current.map(|c| c.0),
        phase: current.map(|c| c.1),
        step_states,
        step_reasons,
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
        AutoStopConfig, BandKind, ReasonKind, SaturationStopMode, StairConfig, StepNumbers,
        StepState, judge,
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
            judged_p99_us: &[],
        }
    }

    fn nums(c: &StairConfig, rows: &[(f64, u64)]) -> Vec<StepNumbers> {
        (0..c.targets.len())
            .map(|i| {
                let (error_rate, p99_us) = rows.get(i).copied().unwrap_or((0.0, 0));
                StepNumbers {
                    target: c.targets[i],
                    achieved: None,
                    dropped: Some(0),
                    error_rate,
                    p99_us,
                    measured: i < rows.len(),
                }
            })
            .collect()
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
        let c = cfg(6, Some(FirstFail));
        let j = jud("oo", 6);
        let mut i = inp(&c, 2, Some(&j));
        i.current = Some((4, BandKind::Measure));
        assert!(build_live(&i).next_fail_stops);
        i.frozen = true;
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
    fn recorded_stop_hides_forecast_without_stopped_flag() {
        let c = cfg(6, Some(TwoFails));
        let j = jud("ooof", 6);
        assert!(build_live(&inp(&c, 4, Some(&j))).next_fail_stops);
        let s = stop_info(StopKind::Saturation, 3, 3, T0 + 4 * step_ms(&c) + 2000);
        let mut i = inp(&c, 4, Some(&j));
        i.stop = Some(&s);
        i.stop_t0_ms = Some(T0);
        assert!(!build_live(&i).next_fail_stops);
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
    fn step_reasons_copy_judged_rows() {
        let c = cfg(5, None);
        let j = jud("ofoo", 5);
        let l = build_live(&LiveInputs {
            judged_p99_us: &[1000; 5],
            ..inp(&c, 4, Some(&j))
        });
        assert_eq!(l.step_reasons.len(), 5);
        assert_eq!(l.step_reasons[1].reasons, j.reasons[1]);
        assert_eq!(l.step_reasons[1].reasons[0].kind, ReasonKind::Errors);
        assert!(l.step_reasons[0].reasons.is_empty());
        assert_eq!(
            l.step_reasons[4],
            LiveStepReasons {
                reasons: vec![],
                slot_limited: false,
                ref_fast: false
            }
        );
    }

    #[test]
    fn ref_fast_uses_nearest_ok_not_prev() {
        let c = cfg(4, None);
        let p = [500, 6000, 8000, 7000];
        let j = judge(
            &nums(&c, &[(0.0, 500), (0.0, 6000), (0.0, 8000), (0.0, 7000)]),
            &c,
        );
        assert_eq!(
            j.states,
            vec![
                StepState::Ok,
                StepState::Saturated,
                StepState::Saturated,
                StepState::After
            ]
        );
        let l = build_live(&LiveInputs {
            judged_p99_us: &p,
            ..inp(&c, 4, Some(&j))
        });
        for i in 1..4 {
            assert_eq!(
                l.step_reasons[i].reasons[0].kind,
                ReasonKind::P99Relative,
                "step {i}"
            );
            assert!(l.step_reasons[i].ref_fast, "step {i}");
        }
    }

    #[test]
    fn ref_fast_false_without_ok_ref() {
        let c = cfg(2, None);
        let p = [500, 500];
        let j = judge(&nums(&c, &[(0.5, 500), (0.0, 500)]), &c);
        assert_eq!(j.states, vec![StepState::Saturated, StepState::After]);
        let l = build_live(&LiveInputs {
            judged_p99_us: &p,
            ..inp(&c, 2, Some(&j))
        });
        assert!(!l.step_reasons[0].ref_fast);
        assert!(!l.step_reasons[1].ref_fast);
    }

    #[test]
    fn unjudged_and_stop_rows_have_empty_reasons() {
        let c = cfg(6, Some(TwoFails));
        let j = jud("ooff", 6);
        let s = stop_info(StopKind::Saturation, 3, 3, T0 + 4 * step_ms(&c) + 2000);
        let mut i = inp(&c, 4, Some(&j));
        i.stop = Some(&s);
        i.stopped = true;
        i.stop_t0_ms = Some(T0);
        i.judged_p99_us = &[1000; 6];
        let l = build_live(&i);
        let empty = LiveStepReasons {
            reasons: vec![],
            slot_limited: false,
            ref_fast: false,
        };
        assert_eq!(l.step_reasons.len(), 6);
        assert!(!l.step_reasons[2].reasons.is_empty());
        for r in &l.step_reasons[4..] {
            assert_eq!(*r, empty);
        }
    }

    #[test]
    fn current_lifts_to_next_ramp_when_judged() {
        let c = cfg(4, Some(TwoFails));
        let j = jud("oo", 4);
        let l = build_live(&LiveInputs {
            current: Some((1, BandKind::Measure)),
            judged_p99_us: &[1000; 4],
            ..inp(&c, 2, Some(&j))
        });
        assert_eq!((l.current_step, l.phase), (Some(2), Some(BandKind::Ramp)));
        assert_eq!(l.step_states[2], L::Measuring);
        assert_eq!(l.step_states[3], L::Pending);
    }

    #[test]
    fn current_null_when_all_judged() {
        let c = cfg(4, None);
        let j = jud("oooo", 4);
        let mut i = inp(&c, 4, Some(&j));
        i.current = Some((3, BandKind::Measure));
        let l = build_live(&i);
        assert_eq!((l.current_step, l.phase), (None, None));
    }

    #[test]
    fn current_unchanged_when_not_behind() {
        let c = cfg(4, None);
        let j = jud("oo", 4);
        let mut i = inp(&c, 2, Some(&j));
        i.current = Some((2, BandKind::Discard));
        let l = build_live(&i);
        assert_eq!(
            (l.current_step, l.phase),
            (Some(2), Some(BandKind::Discard))
        );
        i.current = Some((3, BandKind::Ramp));
        let l = build_live(&i);
        assert_eq!((l.current_step, l.phase), (Some(3), Some(BandKind::Ramp)));
    }

    #[test]
    fn stop_record_with_lagging_current_lifts() {
        let c = cfg(6, Some(TwoFails));
        let j = jud("ooff", 6);
        let s = stop_info(StopKind::Saturation, 3, 3, T0 + 4 * step_ms(&c) + 2000);
        let mut i = inp(&c, 4, Some(&j));
        i.stop = Some(&s);
        i.stopped = true;
        i.stop_t0_ms = Some(T0);
        i.current = Some((3, BandKind::Measure));
        let l = build_live(&i);
        assert_eq!((l.current_step, l.phase), (Some(4), Some(BandKind::Ramp)));
    }

    #[test]
    fn frozen_lag_lifts_current_keeps_frozen_chips() {
        let c = cfg(4, None);
        let j = jud("oo", 4);
        let mut i = inp(&c, 2, Some(&j));
        i.frozen = true;
        i.current = Some((1, BandKind::Measure));
        let l = build_live(&i);
        assert_eq!((l.current_step, l.phase), (Some(2), Some(BandKind::Ramp)));
        assert_eq!(&l.step_states[2..], &[L::Frozen, L::Frozen]);
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
        let mut keys: Vec<&str> = v["step_reasons"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort();
        assert_eq!(keys, ["reasons", "ref_fast", "slot_limited"]);
        assert_eq!(v["step_reasons"][0]["reasons"], serde_json::json!([]));
    }

    fn cost_judgement(n: usize, with_reasons: bool) -> Judgement {
        let reasons = |i: usize| -> Vec<Reason> {
            if !with_reasons {
                return vec![];
            }
            let x = i as f64;
            vec![
                Reason {
                    kind: ReasonKind::Achieved,
                    value: 0.5 + x / 1000.0,
                },
                Reason {
                    kind: ReasonKind::Dropped,
                    value: 1000.0 + x,
                },
                Reason {
                    kind: ReasonKind::Errors,
                    value: 0.046 + x / 10_000.0,
                },
                Reason {
                    kind: ReasonKind::P99Relative,
                    value: 3.9 + x / 100.0,
                },
            ]
        };
        Judgement {
            states: vec![StepState::After; n],
            reasons: (0..n).map(reasons).collect(),
            slot_limited: vec![false; n],
            last_ok: None,
            spikes: vec![],
            saturation: Some(0),
            knee: None,
            headline: crate::stair::HeadlineKind::Saturated,
            later_ok_after_first_fail: false,
        }
    }

    /// 50계단 `build_live` + `clone` + JSON 직렬화 1회 비용 — 사유가 있는 판과 없는 판 비교(수동 실행).
    #[test]
    #[ignore]
    fn live_cost_50_steps() {
        const N: usize = 50;
        const ITERS: u32 = 10_000;
        let c = cfg(N, None);
        let p99 = [1_000u64; N];
        for with_reasons in [true, false] {
            let j = cost_judgement(N, with_reasons);
            let run = || {
                let l = build_live(&LiveInputs {
                    judged_p99_us: &p99,
                    ..inp(&c, N, Some(&j))
                });
                let cl = l.clone();
                serde_json::to_vec(&cl).unwrap()
            };
            let bytes = run().len();
            let t = std::time::Instant::now();
            for _ in 0..ITERS {
                std::hint::black_box(run());
            }
            let mean_ns = t.elapsed().as_nanos() / u128::from(ITERS);
            eprintln!(
                "live_cost_50_steps reasons={with_reasons} mean_ns={mean_ns} json_bytes={bytes}"
            );
        }
    }
}
