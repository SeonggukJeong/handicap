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

// ── 판정 (spec §5.3, bench `saturation.py` 이식) ──────────────────────────
// 모든 p99 비교는 정수 µs.

const ACHIEVED_MIN: f64 = 0.95;
const ERROR_MAX: f64 = 0.01;
const P99_MULT: u64 = 3;
const P99_FAST_US: u64 = 1000;
const P99_FAST_CAP_US: u64 = 5000;
/// knee: 바로 앞 정상 계단 대비 p99 ≥ 1.5× (정수로 `2·cur ≥ 3·prev`) ∧ p99 ≥ 1 ms.
const KNEE_MIN_US: u64 = 1000;

/// 판정에 쓰는 계단 하나의 숫자. `measured`는 호출자가 `2·measured_seconds ≥ hold − discard`로 채운다.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StepNumbers {
    pub target: u32,
    /// 달성한 초당 반복 수. 없으면 달성 조건을 보지 않는다.
    pub achieved: Option<f64>,
    /// 그 계단에서 생긴 dropped. 없으면 dropped 조건을 보지 않는다.
    pub dropped: Option<u64>,
    pub error_rate: f64,
    pub p99_us: u64,
    pub measured: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Ok,
    Spike,
    Saturated,
    Unconfirmed,
    After,
    NotMeasured,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasonKind {
    Achieved,
    Dropped,
    Errors,
    P99Cap,
    P99Relative,
}

/// 실패 사유. `value`: achieved = 달성 비율(0..1), dropped = 개수, errors = 오류 비율,
/// p99_cap = p99 ms, p99_relative = 기준 계단 대비 배수.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Reason {
    pub kind: ReasonKind,
    pub value: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HeadlineKind {
    Saturated,
    Unconfirmed,
    AllOk,
    OkThenUnmeasured,
    NoData,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Judgement {
    pub states: Vec<StepState>,
    pub reasons: Vec<Vec<Reason>>,
    pub slot_limited: Vec<bool>,
    pub last_ok: Option<usize>,
    pub spikes: Vec<usize>,
    pub saturation: Option<usize>,
    pub knee: Option<usize>,
    pub headline: HeadlineKind,
    pub later_ok_after_first_fail: bool,
}

/// bench `step_ok`와 같은 조건·순서. 실패 사유는 해당하는 것을 모두 담는다.
/// `p99_cap_ms`가 있으면 배수 규칙 대신 `p99 < cap`만 보고, 첫 계단에도 적용한다.
pub fn step_ok(
    cur: &StepNumbers,
    prev_ok: Option<&StepNumbers>,
    p99_cap_ms: Option<u32>,
) -> (bool, Vec<Reason>) {
    let mut reasons = Vec::new();
    if let Some(a) = cur.achieved
        && a < ACHIEVED_MIN * f64::from(cur.target)
    {
        reasons.push(Reason {
            kind: ReasonKind::Achieved,
            value: a / f64::from(cur.target),
        });
    }
    if let Some(d) = cur.dropped
        && d != 0
    {
        reasons.push(Reason {
            kind: ReasonKind::Dropped,
            value: d as f64,
        });
    }
    if cur.error_rate >= ERROR_MAX {
        reasons.push(Reason {
            kind: ReasonKind::Errors,
            value: cur.error_rate,
        });
    }
    if let Some(cap) = p99_cap_ms {
        if cur.p99_us >= u64::from(cap) * 1000 {
            reasons.push(Reason {
                kind: ReasonKind::P99Cap,
                value: cur.p99_us as f64 / 1000.0,
            });
        }
    } else if let Some(prev) = prev_ok {
        let limit = if prev.p99_us < P99_FAST_US {
            P99_FAST_CAP_US
        } else {
            P99_MULT.saturating_mul(prev.p99_us)
        };
        if cur.p99_us >= limit {
            reasons.push(Reason {
                kind: ReasonKind::P99Relative,
                value: cur.p99_us as f64 / prev.p99_us.max(1) as f64,
            });
        }
    }
    (reasons.is_empty(), reasons)
}

fn is_slot_limited(reasons: &[Reason]) -> bool {
    !reasons.is_empty()
        && reasons
            .iter()
            .all(|r| matches!(r.kind, ReasonKind::Achieved | ReasonKind::Dropped))
}

/// 계단 표 판정. 걷기는 bench `_walk`와 같고, `unconfirmed`·`after`·`not_measured`는 표시 전용.
pub fn judge(steps: &[StepNumbers], cfg: &StairConfig) -> Judgement {
    let cap = cfg.p99_cap_ms;
    let n = steps.len();
    let mut states = vec![StepState::NotMeasured; n];
    let mut reasons: Vec<Vec<Reason>> = vec![Vec::new(); n];
    let mut slot_limited = vec![false; n];
    let mut last: Option<usize> = None;
    let mut spikes = Vec::new();
    let mut saturation = None;
    let mut stopped_unmeasured = false;

    let mut i = 0;
    while i < n {
        if !steps[i].measured {
            stopped_unmeasured = true;
            break;
        }
        let prev = last.map(|l| &steps[l]);
        let (ok, r) = step_ok(&steps[i], prev, cap);
        if ok {
            states[i] = StepState::Ok;
            last = Some(i);
            i += 1;
            continue;
        }
        slot_limited[i] = is_slot_limited(&r);
        reasons[i] = r;
        if last.is_some()
            && i + 1 < n
            && steps[i + 1].measured
            && step_ok(&steps[i + 1], prev, cap).0
        {
            states[i] = StepState::Spike;
            spikes.push(i);
            i += 1;
            continue;
        }
        saturation = Some(i);
        break;
    }

    let mut headline = match (saturation, last) {
        (None, None) => HeadlineKind::NoData,
        (None, Some(_)) if stopped_unmeasured => HeadlineKind::OkThenUnmeasured,
        (None, Some(_)) => HeadlineKind::AllOk,
        (Some(_), _) => HeadlineKind::Saturated,
    };

    let mut later_ok_after_first_fail = false;
    if let Some(k) = saturation {
        let ref_ok = last.map(|l| &steps[l]);
        // 확정 계단 뒤로 판정에 쓰이지 않은 계단: 측정됐으면 after(사유는 고정 ref로 표시), 아니면 not_measured.
        let mut rest = k + 1;
        if k + 1 < n && !steps[k + 1].measured {
            states[k] = StepState::Unconfirmed;
            headline = HeadlineKind::Unconfirmed;
            rest = n;
        } else {
            states[k] = StepState::Saturated;
            if k + 1 < n {
                let (ok, r) = step_ok(&steps[k + 1], ref_ok, cap);
                if !ok {
                    states[k + 1] = StepState::Saturated;
                    slot_limited[k + 1] = is_slot_limited(&r);
                    reasons[k + 1] = r;
                    rest = k + 2;
                }
            }
        }
        for j in rest..n {
            if steps[j].measured {
                states[j] = StepState::After;
                reasons[j] = step_ok(&steps[j], ref_ok, cap).1;
            }
        }
        later_ok_after_first_fail = last.is_none()
            && k == 0
            && steps[1..]
                .iter()
                .any(|st| st.measured && step_ok(st, None, cap).0);
    }

    let mut knee = None;
    let mut prev_ok: Option<u64> = None;
    for (idx, st) in states.iter().enumerate() {
        if *st != StepState::Ok {
            continue;
        }
        let p = steps[idx].p99_us;
        if let Some(pp) = prev_ok
            && p >= KNEE_MIN_US
            && p.saturating_mul(2) >= pp.saturating_mul(3)
        {
            knee = Some(idx);
            break;
        }
        prev_ok = Some(p);
    }

    Judgement {
        states,
        reasons,
        slot_limited,
        last_ok: last,
        spikes,
        saturation,
        knee,
        headline,
        later_ok_after_first_fail,
    }
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

/// 표 테스트 — bench `rllb/saturation.py`의 `_walk`(redis-large-list-bench, 읽기 전용 참조)를
/// 같은 입력으로 손으로 따라가 `(마지막 정상 index, blips, 걷기가 멈춘 index)`를 주석에 적었다.
/// bench는 포화 index를 반환하지 않고 걷기를 `break`한 i가 곧 포화 지점이다(끝까지 걸으면 없음).
#[cfg(test)]
mod judge_tests {
    use super::*;

    fn s(target: u32, achieved: f64, p99_us: u64, err: f64, dropped: u64) -> StepNumbers {
        StepNumbers {
            target,
            achieved: Some(achieved),
            dropped: Some(dropped),
            error_rate: err,
            p99_us,
            measured: true,
        }
    }

    fn nm(target: u32) -> StepNumbers {
        StepNumbers {
            target,
            achieved: None,
            dropped: None,
            error_rate: 0.0,
            p99_us: 0,
            measured: false,
        }
    }

    /// 목표 100,200,…에 달성 = 목표, 오류·dropped 0, p99만 다른 계단들.
    fn p99s(us: &[u64]) -> Vec<StepNumbers> {
        us.iter()
            .enumerate()
            .map(|(i, &p)| {
                let t = 100 * (i as u32 + 1);
                s(t, f64::from(t), p, 0.0, 0)
            })
            .collect()
    }

    fn cfg(cap: Option<u32>) -> StairConfig {
        StairConfig {
            targets: vec![100, 200],
            hold_seconds: 60,
            ramp_seconds: 5,
            discard_seconds: 10,
            p99_cap_ms: cap,
        }
    }

    fn walk(j: &Judgement) -> (Option<usize>, Vec<usize>, Option<usize>) {
        (j.last_ok, j.spikes.clone(), j.saturation)
    }

    use StepState::*;

    #[test]
    fn all_ok() {
        let j = judge(&p99s(&[10000, 12000, 15000]), &cfg(None));
        // bench _walk: last=2, blips=[], 끝까지 걸음(포화 없음)
        assert_eq!(walk(&j), (Some(2), vec![], None));
        assert_eq!(j.headline, HeadlineKind::AllOk);
        assert_eq!(j.states, vec![Ok, Ok, Ok]);
    }

    #[test]
    fn one_spike() {
        let j = judge(&p99s(&[10000, 12000, 40000, 15000, 18000]), &cfg(None));
        // bench _walk: 2(40000 ≥ 3×12000) 실패, 3(15000 < 36000) 정상 → blip 2; last=4, blips=[2], 포화 없음
        assert_eq!(walk(&j), (Some(4), vec![2], None));
        assert_eq!(j.states[2], Spike);
        assert_eq!(j.headline, HeadlineKind::AllOk);
    }

    #[test]
    fn consecutive_fail() {
        let j = judge(&p99s(&[10000, 12000, 40000, 50000, 60000]), &cfg(None));
        // bench _walk: 2 실패, 3(50000 vs ref 12000) 실패 → break i=2; last=1, blips=[]
        assert_eq!(walk(&j), (Some(1), vec![], Some(2)));
        assert_eq!(j.states, vec![Ok, Ok, Saturated, Saturated, After]);
        assert_eq!(j.headline, HeadlineKind::Saturated);
    }

    #[test]
    fn spike_then_consecutive_fail() {
        let j = judge(
            &p99s(&[10000, 12000, 40000, 15000, 50000, 60000]),
            &cfg(None),
        );
        // bench _walk: blip 2, last=3(15000); 4(50000 ≥ 45000) 실패, 5(60000) 실패 → break i=4
        assert_eq!(walk(&j), (Some(3), vec![2], Some(4)));
        assert_eq!(j.states, vec![Ok, Ok, Spike, Ok, Saturated, Saturated]);
    }

    #[test]
    fn first_fail_then_ok_is_not_spike() {
        let steps = vec![s(100, 100.0, 10000, 0.0, 5), s(200, 200.0, 12000, 0.0, 0)];
        let j = judge(&steps, &cfg(None));
        // bench _walk: 0 실패(dropped), last=None이라 blip 아님 → break i=0; last=None, blips=[]
        assert_eq!(walk(&j), (None, vec![], Some(0)));
        assert_eq!(j.states, vec![Saturated, After]);
        assert!(j.later_ok_after_first_fail);
        assert_eq!(j.headline, HeadlineKind::Saturated);
    }

    #[test]
    fn later_ok_flag_false_when_later_also_fails() {
        let steps = vec![s(100, 100.0, 10000, 0.0, 5), s(200, 200.0, 12000, 0.0, 3)];
        let j = judge(&steps, &cfg(None));
        assert_eq!(walk(&j), (None, vec![], Some(0)));
        assert!(!j.later_ok_after_first_fail);
    }

    #[test]
    fn last_step_fails() {
        let j = judge(&p99s(&[10000, 12000, 40000]), &cfg(None));
        // bench _walk: 2 실패, 다음 계단 없음 → break i=2; last=1, blips=[]
        assert_eq!(walk(&j), (Some(1), vec![], Some(2)));
        assert_eq!(j.states[2], Saturated);
        assert_eq!(j.headline, HeadlineKind::Saturated);
    }

    #[test]
    fn sub_ms_ref_cap_5ms() {
        let j = judge(&p99s(&[500, 4999]), &cfg(None));
        // bench _walk: ref 500 < 1000 → 4999 < 5000 정상; last=1, blips=[], 포화 없음
        assert_eq!(walk(&j), (Some(1), vec![], None));
        let j = judge(&p99s(&[500, 5000]), &cfg(None));
        // bench _walk: 5000 < 5000 거짓 → 실패, 다음 없음 → break i=1; last=0
        assert_eq!(walk(&j), (Some(0), vec![], Some(1)));
        assert_eq!(
            j.reasons[1],
            vec![Reason {
                kind: ReasonKind::P99Relative,
                value: 10.0
            }]
        );
    }

    #[test]
    fn abs_cap_applies_to_first_step() {
        let j = judge(&p99s(&[25000, 25000]), &cfg(Some(20)));
        // bench _walk(p99_abs_us=20000): 0 실패(첫 계단에도 적용), last=None → break i=0
        assert_eq!(walk(&j), (None, vec![], Some(0)));
        assert_eq!(
            j.reasons[0],
            vec![Reason {
                kind: ReasonKind::P99Cap,
                value: 25.0
            }]
        );
    }

    #[test]
    fn abs_cap_replaces_multiple_rule() {
        let j = judge(&p99s(&[10000, 90000]), &cfg(Some(100)));
        // bench _walk(p99_abs_us=100000): 90000 < 100000 정상(배수 9× 무시); last=1, 포화 없음
        assert_eq!(walk(&j), (Some(1), vec![], None));
        assert_eq!(j.headline, HeadlineKind::AllOk);
    }

    #[test]
    fn abs_cap_boundary_is_strict() {
        let j = judge(&p99s(&[10000, 100_000]), &cfg(Some(100)));
        assert_eq!(walk(&j), (Some(0), vec![], Some(1)));
    }

    #[test]
    fn not_measured_stops_walk() {
        let mut steps = p99s(&[10000, 12000]);
        steps.push(nm(300));
        steps.push(nm(400));
        let j = judge(&steps, &cfg(None));
        // bench엔 미측정 계단 개념이 없다(valid=False면 ValueError) — 걷기를 2에서 멈춘 것 = bench에 0..=1만 넘긴 결과: last=1, 포화 없음
        assert_eq!(walk(&j), (Some(1), vec![], None));
        assert_eq!(j.headline, HeadlineKind::OkThenUnmeasured);
        assert_eq!(&j.states[2..], &[NotMeasured, NotMeasured]);
        assert!(j.reasons[2].is_empty());
    }

    #[test]
    fn unconfirmed_when_next_not_measured() {
        let mut steps = p99s(&[10000, 40000]);
        steps.push(nm(300));
        let j = judge(&steps, &cfg(None));
        // bench에 0..=1만 넘긴 결과: 1 실패, 다음 없음 → break i=1; last=0, blips=[]
        assert_eq!(walk(&j), (Some(0), vec![], Some(1)));
        assert_eq!(j.states, vec![Ok, Unconfirmed, NotMeasured]);
        assert_eq!(j.headline, HeadlineKind::Unconfirmed);
    }

    #[test]
    fn no_data() {
        let j = judge(&[nm(100), nm(200)], &cfg(None));
        assert_eq!(walk(&j), (None, vec![], None));
        assert_eq!(j.headline, HeadlineKind::NoData);
        assert_eq!(j.states, vec![NotMeasured, NotMeasured]);
    }

    #[test]
    fn achieved_boundary() {
        let (ok, r) = step_ok(&s(100, 94.9, 10000, 0.0, 0), None, None);
        assert!(!ok);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].kind, ReasonKind::Achieved);
        assert!((r[0].value - 0.949).abs() < 1e-9);
        assert_eq!(
            step_ok(&s(100, 95.0, 10000, 0.0, 0), None, None),
            (true, vec![])
        );
    }

    #[test]
    fn achieved_none_is_not_judged() {
        let mut cur = s(100, 0.0, 10000, 0.0, 0);
        cur.achieved = None;
        cur.dropped = None;
        assert_eq!(step_ok(&cur, None, None), (true, vec![]));
    }

    #[test]
    fn error_rate_boundary() {
        assert_eq!(
            step_ok(&s(100, 100.0, 10000, 0.0099, 0), None, None),
            (true, vec![])
        );
        let (ok, r) = step_ok(&s(100, 100.0, 10000, 0.01, 0), None, None);
        assert!(!ok);
        assert_eq!(
            r,
            vec![Reason {
                kind: ReasonKind::Errors,
                value: 0.01
            }]
        );
    }

    #[test]
    fn all_failing_reasons_are_recorded() {
        let prev = s(100, 100.0, 10000, 0.0, 0);
        let (ok, r) = step_ok(&s(200, 100.0, 40000, 0.5, 7), Some(&prev), None);
        assert!(!ok);
        let kinds: Vec<ReasonKind> = r.iter().map(|x| x.kind).collect();
        assert_eq!(
            kinds,
            vec![
                ReasonKind::Achieved,
                ReasonKind::Dropped,
                ReasonKind::Errors,
                ReasonKind::P99Relative
            ]
        );
    }

    #[test]
    fn slot_limited_only_drop() {
        let mut steps = p99s(&[10000, 12000]);
        steps[1].dropped = Some(4);
        let j = judge(&steps, &cfg(None));
        assert_eq!(j.saturation, Some(1));
        assert_eq!(j.slot_limited, vec![false, true]);

        let mut steps = p99s(&[10000, 40000]);
        steps[1].dropped = Some(4);
        let j = judge(&steps, &cfg(None));
        assert_eq!(j.saturation, Some(1));
        assert_eq!(j.slot_limited, vec![false, false]);
    }

    #[test]
    fn after_steps_are_not_slot_limited() {
        let mut steps = p99s(&[10000, 12000, 40000, 50000, 60000]);
        steps[4].dropped = Some(9);
        let j = judge(&steps, &cfg(None));
        assert_eq!(j.states[4], After);
        assert!(!j.slot_limited[4]);
        assert!(j.reasons[4].iter().any(|r| r.kind == ReasonKind::Dropped));
    }

    #[test]
    fn knee_at_1_5x() {
        let j = judge(&p99s(&[10000, 12000, 18000]), &cfg(None));
        assert_eq!(walk(&j), (Some(2), vec![], None));
        assert_eq!(j.knee, Some(2));
        let j = judge(&p99s(&[10000, 12000, 17999]), &cfg(None));
        assert_eq!(j.knee, None);
    }

    #[test]
    fn knee_ignores_sub_ms() {
        let j = judge(&p99s(&[400, 700]), &cfg(None));
        assert_eq!(j.knee, None);
    }

    #[test]
    fn enums_serialize_snake_case() {
        assert_eq!(
            serde_json::to_value(NotMeasured).unwrap(),
            serde_json::json!("not_measured")
        );
        assert_eq!(
            serde_json::to_value(ReasonKind::P99Relative).unwrap(),
            serde_json::json!("p99_relative")
        );
        assert_eq!(
            serde_json::to_value(HeadlineKind::OkThenUnmeasured).unwrap(),
            serde_json::json!("ok_then_unmeasured")
        );
    }
}
