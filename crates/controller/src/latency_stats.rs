//! 응답 시간 통계 블록(µs) — 리포트가 이미 가진 HDR 분포에서 계산한다.
//! 백분위는 정수 순위로(부동소수 순위 금지), 60초 칸(`CAP_US`)은 그 값으로 잘라 보여 준다.

use hdrhistogram::Histogram;
use serde::{Deserialize, Serialize};

/// 표시 상한(µs). 이 값 이상이 들어 있는 분포는 `capped`.
pub const CAP_US: u64 = 60_000_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct LatencyStats {
    pub min_us: u64,
    pub mean_us: u64,
    pub max_us: u64,
    pub stdev_us: u64,
    pub p50_us: u64,
    pub p90_us: u64,
    pub p95_us: u64,
    pub p99_us: u64,
    pub capped: bool,
}

/// 정수 순위 백분위(`n_milli` = 백분위 × 1000, 예: p99.9 → 99_900). 60초로 자른다. 빈 분포는 None.
/// 전제: `n_milli`는 0 < n < 100_000(검증된 백분위)이다.
pub fn value_at_milli(h: &Histogram<u64>, n_milli: u32) -> Option<u64> {
    value_at_milli_capped(h, n_milli).map(|(v, _)| v)
}

/// `value_at_milli`와 같은 값 + 그 순위 표본이 60초 칸에 들어 있는지(판정의 `capped`).
pub fn value_at_milli_capped(h: &Histogram<u64>, n_milli: u32) -> Option<(u64, bool)> {
    debug_assert!(n_milli > 0 && n_milli < 100_000, "n_milli={n_milli}");
    let total = h.len();
    if total == 0 {
        return None;
    }
    let rank = (n_milli as u128 * total as u128).div_ceil(100_000).max(1) as u64;
    let mut seen = 0u64;
    for v in h.iter_recorded() {
        seen += v.count_at_value();
        if seen >= rank {
            let raw = v.value_iterated_to();
            return Some((h.highest_equivalent(raw).min(CAP_US), is_cap_value(h, raw)));
        }
    }
    None
}

/// 최대(60초로 자름). 빈 분포는 None.
pub fn max_us(h: &Histogram<u64>) -> Option<u64> {
    (!h.is_empty()).then(|| h.max().min(CAP_US))
}

/// `v_raw`가 60초 칸에 들어 있는 값인가.
pub fn is_cap_value(h: &Histogram<u64>, v_raw: u64) -> bool {
    v_raw >= h.lowest_equivalent(CAP_US)
}

/// 분포 안에 60초 칸 값이 있는가.
pub fn is_capped(h: &Histogram<u64>) -> bool {
    is_cap_value(h, h.max())
}

/// 평균(µs, 반올림, 60초로 자름). 빈 분포는 None — `latency_stats`·리포트 창·초별 합계의 단일 소스.
pub fn mean_us(h: &Histogram<u64>) -> Option<u64> {
    let max = max_us(h)?;
    Some((h.mean().round() as u64).min(max))
}

/// 통계 블록의 단일 소스 — 리포트 표시와 규칙 2 판정이 같은 값을 쓴다(R15).
pub fn latency_stats(h: &Histogram<u64>) -> Option<LatencyStats> {
    let max = max_us(h)?;
    Some(LatencyStats {
        min_us: if is_cap_value(h, h.min()) {
            CAP_US
        } else {
            h.min()
        },
        mean_us: mean_us(h)?,
        max_us: max,
        stdev_us: h.stdev().round() as u64,
        p50_us: value_at_milli(h, 50_000)?,
        p90_us: value_at_milli(h, 90_000)?,
        p95_us: value_at_milli(h, 95_000)?,
        p99_us: value_at_milli(h, 99_000)?,
        capped: is_capped(h),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hist(vals: &[u64]) -> Histogram<u64> {
        let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
        for &v in vals {
            h.record(v).unwrap();
        }
        h
    }

    #[test]
    fn mean_us_matches_block() {
        assert_eq!(mean_us(&hist(&[1000, 2000, 3000])), Some(2000));
        assert_eq!(mean_us(&hist(&[])), None);
        assert_eq!(mean_us(&hist(&[60_000_000])), Some(60_000_000));
    }

    #[test]
    fn bucket_edges() {
        let h = hist(&[1]);
        assert_eq!(h.lowest_equivalent(60_000_000), 59_998_208);
        assert_eq!(h.highest_equivalent(60_000_000), 60_030_975);
    }

    #[test]
    fn integer_rank_matches_value_at_quantile_for_fixed() {
        let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
        for i in 1..=2_000u64 {
            h.record((i * 37) % 50_000 + 1).unwrap();
            for (milli, q) in [(50_000u32, 0.50), (95_000, 0.95), (99_000, 0.99)] {
                assert_eq!(
                    value_at_milli(&h, milli),
                    Some(h.value_at_quantile(q)),
                    "n={i} milli={milli}"
                );
            }
        }
    }

    #[test]
    fn p999_rank_exact() {
        let h = hist(&(1..=1000).collect::<Vec<_>>());
        assert_eq!(value_at_milli(&h, 99_900), Some(h.highest_equivalent(999)));
        assert_ne!(
            value_at_milli(&h, 99_900),
            Some(h.value_at_quantile(99.9 / 100.0))
        );
        assert_ne!(value_at_milli(&h, 99_900), Some(h.value_at_quantile(1.0)));
        let h = hist(&(1..=10_000).map(|i| 10 * i).collect::<Vec<_>>());
        assert_eq!(
            value_at_milli(&h, 99_900),
            Some(h.highest_equivalent(99_900))
        );
    }

    #[test]
    fn all_capped() {
        let h = hist(&[60_000_000]);
        let s = latency_stats(&h).unwrap();
        assert_eq!(max_us(&h), Some(60_000_000));
        assert_eq!(s.max_us, 60_000_000);
        assert_eq!(s.mean_us, 60_000_000);
        assert!(s.capped);
        assert_eq!(s.p99_us, 60_000_000);
    }

    #[test]
    fn capped_boundary() {
        assert!(!latency_stats(&hist(&[59_000_000])).unwrap().capped);
        assert!(latency_stats(&hist(&[59_998_208])).unwrap().capped);
        assert!(!latency_stats(&hist(&[59_998_207])).unwrap().capped);
    }

    #[test]
    fn basic_values() {
        let mut v = vec![1000u64; 9];
        v.push(100_000);
        let h = hist(&v);
        let s = latency_stats(&h).unwrap();
        assert_eq!(s.min_us, 1000);
        assert_eq!(s.p50_us, h.highest_equivalent(1000));
        assert_eq!(s.p90_us, h.highest_equivalent(1000));
        assert_eq!(s.p95_us, h.highest_equivalent(100_000));
        assert_eq!(s.p99_us, h.highest_equivalent(100_000));
        assert_eq!(s.max_us, h.highest_equivalent(100_000));
        assert_eq!(s.mean_us, h.mean().round() as u64);
        assert_eq!(s.stdev_us, h.stdev().round() as u64);
        assert!(!s.capped);
    }

    #[test]
    fn mean_error_within_0_1_pct() {
        let vals: Vec<u64> = (0..5_000)
            .map(|i| (200_000f64.powf(i as f64 / 4_999.0)).round().max(1.0) as u64)
            .collect();
        let exact = vals.iter().sum::<u64>() as f64 / vals.len() as f64;
        let s = latency_stats(&hist(&vals)).unwrap();
        assert!(
            ((s.mean_us as f64) - exact).abs() / exact <= 0.001,
            "mean {} vs exact {exact}",
            s.mean_us
        );
    }

    #[test]
    fn min_is_cap_value_in_cap_bucket() {
        // 60초 칸 값이면 최소도 그 칸의 값(60,000,000)으로 — 칸 아래 끝(59,998,208)이 아니다.
        assert_eq!(
            latency_stats(&hist(&[60_000_000])).unwrap().min_us,
            60_000_000
        );
        // 60초 미만 값은 그대로(칸 안의 값).
        assert_eq!(
            latency_stats(&hist(&[59_000_000])).unwrap().min_us,
            58_982_400
        );
        // 60초 칸 아래 표본이 하나라도 있으면 그 최소.
        assert_eq!(
            latency_stats(&hist(&[1000, 60_000_000])).unwrap().min_us,
            1000
        );
    }

    #[test]
    fn empty_is_none() {
        let h = hist(&[]);
        assert!(latency_stats(&h).is_none());
        assert!(value_at_milli(&h, 50_000).is_none());
    }
}
