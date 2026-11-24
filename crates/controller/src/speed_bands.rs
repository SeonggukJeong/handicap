//! 응답 속도 구간 건수 — 판정(`evaluate_criteria`)과 같은 ms 버림 잣대로 센다.

use crate::store::runs::{Criteria, LATENCY_RULE_CURRENT};
use hdrhistogram::Histogram;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const FAST_MS: u64 = 1_000;
pub const DEFAULT_SLOW_MS: u64 = 3_000;

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SpeedBandRow {
    pub slow_ms: u64,
    /// 규칙 2(`latency_rule` 2) run만: 경계를 µs로 정확히(`round(기준 ms × 1000)`).
    /// 규칙 1 run은 없다 — `slow_ms`(버림한 ms)가 경계다. 있으면 `slow_ms = slow_us / 1000`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slow_us: Option<u64>,
    pub basis: String,
    pub own: bool,
    pub fast: Option<u64>,
    pub within: u64,
    pub over: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SpeedBandStep {
    pub step_id: String,
    #[serde(flatten)]
    pub row: SpeedBandRow,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SpeedBands {
    pub overall: SpeedBandRow,
    pub steps: Vec<SpeedBandStep>,
}

/// run 수준 경계: p95 → p99 → p50 → (3000, "default").
pub fn run_boundary(c: Option<&Criteria>) -> (u64, &'static str) {
    if let Some(c) = c {
        if let Some(v) = c.max_p95_ms {
            return (v, "p95");
        }
        if let Some(v) = c.max_p99_ms {
            return (v, "p99");
        }
        if let Some(v) = c.max_p50_ms {
            return (v, "p50");
        }
    }
    (DEFAULT_SLOW_MS, "default")
}

/// 단계 경계: 같은 우선순위, 같은 metric 여럿이면 가장 작은 값의 floor.
pub fn step_boundary(c: Option<&Criteria>, step_id: &str) -> Option<(u64, &'static str)> {
    let c = c?;
    for (metric, basis) in [("p95_ms", "p95"), ("p99_ms", "p99"), ("p50_ms", "p50")] {
        let min = c
            .step_criteria
            .iter()
            .filter(|sc| sc.op == "max" && sc.metric == metric && sc.target == step_id)
            .map(|sc| sc.threshold)
            .fold(None, |acc: Option<f64>, t| {
                Some(acc.map_or(t, |a| a.min(t)))
            });
        if let Some(t) = min {
            return Some((t.floor().max(0.0) as u64, basis));
        }
    }
    None
}

/// 히스토그램 한 번 훑기. ms = value_iterated_to()/1000.
pub fn count_bands(
    h: &Histogram<u64>,
    slow_ms: u64,
    basis: &'static str,
    own: bool,
) -> SpeedBandRow {
    let has_fast = slow_ms > FAST_MS;
    let (mut fast, mut within, mut over) = (0u64, 0u64, 0u64);
    for v in h.iter_recorded() {
        let ms = v.value_iterated_to() / 1_000;
        let n = v.count_at_value();
        if ms > slow_ms {
            over += n;
        } else if has_fast && ms < FAST_MS {
            fast += n;
        } else {
            within += n;
        }
    }
    SpeedBandRow {
        slow_ms,
        slow_us: None,
        basis: basis.to_string(),
        own,
        fast: has_fast.then_some(fast),
        within,
        over,
    }
}

/// 규칙 2 단계 경계(µs): `floor` 대신 `round(t * 1000)` — 판정의 `round(threshold*1000)`과 같다.
pub fn step_boundary_us(c: Option<&Criteria>, step_id: &str) -> Option<(u64, &'static str)> {
    let c = c?;
    for (metric, basis) in [("p95_ms", "p95"), ("p99_ms", "p99"), ("p50_ms", "p50")] {
        let min = c
            .step_criteria
            .iter()
            .filter(|sc| sc.op == "max" && sc.metric == metric && sc.target == step_id)
            .map(|sc| sc.threshold)
            .fold(None, |acc: Option<f64>, t| {
                Some(acc.map_or(t, |a| a.min(t)))
            });
        if let Some(t) = min {
            return Some(((t * 1000.0).round().max(0.0) as u64, basis));
        }
    }
    None
}

/// 규칙 2: `count_bands`와 같은 한 번 훑기지만 µs 경계(`slow_us`)와 µs 값을 직접 비교한다.
/// `slow_ms`는 `slow_us / 1000`(표시용), `slow_us`는 `Some`.
pub fn count_bands_us(
    h: &Histogram<u64>,
    slow_us: u64,
    basis: &'static str,
    own: bool,
) -> SpeedBandRow {
    let slow_ms = slow_us / 1_000;
    let has_fast = slow_ms > FAST_MS;
    let (mut fast, mut within, mut over) = (0u64, 0u64, 0u64);
    for v in h.iter_recorded() {
        let us = v.value_iterated_to();
        let n = v.count_at_value();
        if us > slow_us {
            over += n;
        } else if has_fast && us < FAST_MS * 1_000 {
            fast += n;
        } else {
            within += n;
        }
    }
    SpeedBandRow {
        slow_ms,
        slow_us: Some(slow_us),
        basis: basis.to_string(),
        own,
        fast: has_fast.then_some(fast),
        within,
        over,
    }
}

pub fn build(
    overall: &Histogram<u64>,
    per_step: &BTreeMap<String, Histogram<u64>>,
    c: Option<&Criteria>,
    latency_rule: u8,
) -> Option<SpeedBands> {
    if overall.is_empty() {
        return None;
    }
    let (slow, basis) = run_boundary(c);
    if latency_rule == LATENCY_RULE_CURRENT {
        let steps = per_step
            .iter()
            .filter(|(_, h)| !h.is_empty())
            .map(|(id, h)| {
                let row = match step_boundary_us(c, id) {
                    Some((s, b)) => count_bands_us(h, s, b, true),
                    None => count_bands_us(h, slow * 1_000, basis, false),
                };
                SpeedBandStep {
                    step_id: id.clone(),
                    row,
                }
            })
            .collect();
        return Some(SpeedBands {
            overall: count_bands_us(overall, slow * 1_000, basis, false),
            steps,
        });
    }
    let steps = per_step
        .iter()
        .filter(|(_, h)| !h.is_empty())
        .map(|(id, h)| {
            let row = match step_boundary(c, id) {
                Some((s, b)) => count_bands(h, s, b, true),
                None => count_bands(h, slow, basis, false),
            };
            SpeedBandStep {
                step_id: id.clone(),
                row,
            }
        })
        .collect();
    Some(SpeedBands {
        overall: count_bands(overall, slow, basis, false),
        steps,
    })
}

/// 판정과 같은 정수식: 초과 몫이 그 basis의 허용 몫을 넘는가.
pub fn exceeds_allowance(basis: &str, over: u64, total: u64) -> bool {
    match basis {
        "p95" => 20 * over > total,
        "p99" => 100 * over > total,
        "p50" => 2 * over > total,
        _ => false,
    }
}
