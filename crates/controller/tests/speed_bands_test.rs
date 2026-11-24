use handicap_controller::latency_stats::value_at_milli;
use handicap_controller::speed_bands::*;
use handicap_controller::store::runs::{Criteria, Criterion};
use handicap_controller::store::runs::{LATENCY_RULE_CURRENT, LATENCY_RULE_LEGACY};
use hdrhistogram::Histogram;

const LEGACY: u8 = LATENCY_RULE_LEGACY;
use std::collections::BTreeMap;

fn hist() -> Histogram<u64> {
    Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap()
}

/// ms 값을 µs로 `n`번 기록.
fn rec_ms(h: &mut Histogram<u64>, ms: u64, n: u64) {
    h.record_n(ms * 1_000, n).unwrap();
}

fn crit(f: impl FnOnce(&mut Criteria)) -> Criteria {
    let mut c = Criteria::default();
    f(&mut c);
    c
}

fn sc(metric: &str, op: &str, threshold: f64, target: &str) -> Criterion {
    Criterion {
        metric: metric.into(),
        op: op.into(),
        threshold,
        target: target.into(),
    }
}

#[test]
fn boundary_priority_p95_then_p99_then_p50_then_default() {
    let c = crit(|c| {
        c.max_p95_ms = Some(3000);
        c.max_p99_ms = Some(9000);
        c.max_p50_ms = Some(100);
    });
    assert_eq!(run_boundary(Some(&c)), (3000, "p95"));
    let c = crit(|c| {
        c.max_p99_ms = Some(5000);
        c.max_p50_ms = Some(100);
    });
    assert_eq!(run_boundary(Some(&c)), (5000, "p99"));
    let c = crit(|c| c.max_p50_ms = Some(800));
    assert_eq!(run_boundary(Some(&c)), (800, "p50"));
    assert_eq!(run_boundary(Some(&Criteria::default())), (3000, "default"));
    assert_eq!(run_boundary(None), (3000, "default"));
}

#[test]
fn step_boundary_takes_min_and_floors() {
    let c = crit(|c| {
        c.step_criteria = vec![
            sc("p95_ms", "max", 5000.0, "A"),
            sc("p95_ms", "max", 3000.0, "A"),
        ];
    });
    assert_eq!(step_boundary(Some(&c), "A"), Some((3000, "p95")));

    let c = crit(|c| c.step_criteria = vec![sc("p95_ms", "max", 2999.5, "A")]);
    assert_eq!(step_boundary(Some(&c), "A"), Some((2999, "p95")));

    // op "min"과 비-응답시간 metric은 무시
    let c = crit(|c| {
        c.step_criteria = vec![
            sc("p95_ms", "min", 100.0, "A"),
            sc("error_rate", "max", 0.5, "A"),
        ];
    });
    assert_eq!(step_boundary(Some(&c), "A"), None);

    // 다른 target
    let c = crit(|c| c.step_criteria = vec![sc("p95_ms", "max", 100.0, "B")]);
    assert_eq!(step_boundary(Some(&c), "A"), None);
    assert_eq!(step_boundary(None, "A"), None);
}

#[test]
fn step_boundary_prefers_p95_over_p99() {
    let c = crit(|c| {
        c.step_criteria = vec![
            sc("p99_ms", "max", 1000.0, "A"),
            sc("p95_ms", "max", 4000.0, "A"),
        ];
    });
    assert_eq!(step_boundary(Some(&c), "A"), Some((4000, "p95")));
    let c = crit(|c| {
        c.step_criteria = vec![
            sc("p50_ms", "max", 100.0, "A"),
            sc("p99_ms", "max", 900.0, "A"),
        ];
    });
    assert_eq!(step_boundary(Some(&c), "A"), Some((900, "p99")));
}

#[test]
fn counts_three_bands() {
    let mut h = hist();
    rec_ms(&mut h, 500, 10);
    rec_ms(&mut h, 2000, 5);
    rec_ms(&mut h, 4000, 2);
    let r = count_bands(&h, 3000, "p95", false);
    assert_eq!(r.fast, Some(10));
    assert_eq!(r.within, 5);
    assert_eq!(r.over, 2);
    assert_eq!(r.slow_ms, 3000);
    assert_eq!(r.basis, "p95");
    assert!(!r.own);
}

#[test]
fn counts_two_bands_when_slow_at_most_one_second() {
    let mut h = hist();
    rec_ms(&mut h, 500, 3);
    rec_ms(&mut h, 900, 2);
    assert_eq!(count_bands(&h, 800, "p95", false).fast, None);
    assert_eq!(count_bands(&h, 1000, "p95", false).fast, None);
    assert!(count_bands(&h, 1001, "p95", false).fast.is_some());
    let r = count_bands(&h, 800, "p95", false);
    assert_eq!((r.within, r.over), (3, 2));
}

#[test]
fn boundary_edges_follow_ms_truncation() {
    let mut h = hist();
    rec_ms(&mut h, 3000, 1);
    rec_ms(&mut h, 3001, 1);
    rec_ms(&mut h, 999, 1);
    rec_ms(&mut h, 1000, 1);
    let r = count_bands(&h, 3000, "p95", false);
    assert_eq!(r.over, 1, "3001ms over, 3000ms within");
    assert_eq!(r.fast, Some(1), "999ms fast");
    assert_eq!(r.within, 2, "1000ms and 3000ms within");
}

#[test]
fn zero_boundary_puts_everything_over_except_sub_ms() {
    let mut h = hist();
    h.record(500).unwrap(); // 500µs -> ms 0
    h.record(2_000).unwrap(); // 2ms
    let r = count_bands(&h, 0, "p95", true);
    assert_eq!(r.fast, None);
    assert_eq!(r.within, 1);
    assert_eq!(r.over, 1);
    assert!(r.own);
}

#[test]
fn total_equals_recorded_len() {
    let mut h = hist();
    rec_ms(&mut h, 10, 7);
    rec_ms(&mut h, 1500, 3);
    rec_ms(&mut h, 9000, 4);
    for slow in [0, 500, 1000, 3000, 20_000] {
        let r = count_bands(&h, slow, "default", false);
        assert_eq!(r.fast.unwrap_or(0) + r.within + r.over, h.len());
    }
}

#[test]
fn build_none_when_overall_empty_and_skips_empty_steps() {
    let empty = hist();
    let mut per = BTreeMap::new();
    per.insert("A".to_string(), hist());
    assert_eq!(build(&empty, &per, None, LEGACY), None);

    let mut o = hist();
    rec_ms(&mut o, 100, 2);
    let mut a = hist();
    rec_ms(&mut a, 100, 2);
    let mut per = BTreeMap::new();
    per.insert("B".to_string(), a);
    per.insert("A".to_string(), hist());
    let sb = build(&o, &per, None, LEGACY).unwrap();
    assert_eq!(sb.overall.basis, "default");
    assert!(!sb.overall.own);
    assert_eq!(sb.steps.len(), 1);
    assert_eq!(sb.steps[0].step_id, "B");
}

#[test]
fn build_orders_steps_and_uses_own_boundary() {
    let mut o = hist();
    rec_ms(&mut o, 4000, 2);
    let mut per = BTreeMap::new();
    for id in ["B", "A"] {
        let mut h = hist();
        rec_ms(&mut h, 4000, 2);
        per.insert(id.to_string(), h);
    }
    let c = crit(|c| {
        c.max_p95_ms = Some(3000);
        c.step_criteria = vec![sc("p95_ms", "max", 5000.0, "A")];
    });
    let sb = build(&o, &per, Some(&c), LEGACY).unwrap();
    assert_eq!(sb.steps[0].step_id, "A");
    assert_eq!(sb.steps[0].row.slow_ms, 5000);
    assert!(sb.steps[0].row.own);
    assert_eq!(sb.steps[0].row.over, 0);
    assert_eq!(sb.steps[1].step_id, "B");
    assert_eq!(sb.steps[1].row.slow_ms, 3000);
    assert!(!sb.steps[1].row.own);
    assert_eq!(sb.steps[1].row.over, 2);
    assert_eq!(sb.overall.slow_ms, 3000);
}

#[test]
fn wire_shape_flattens_step_and_serializes_null_fast() {
    let mut o = hist();
    rec_ms(&mut o, 100, 1);
    let mut per = BTreeMap::new();
    per.insert("A".to_string(), o.clone());
    let c = crit(|c| c.max_p95_ms = Some(800));
    let v = serde_json::to_value(build(&o, &per, Some(&c), LEGACY).unwrap()).unwrap();
    assert!(v["overall"]["fast"].is_null());
    assert!(v["overall"].as_object().unwrap().contains_key("fast"));
    assert_eq!(v["steps"][0]["step_id"], "A");
    assert_eq!(v["steps"][0]["slow_ms"], 800);
}

#[test]
fn exceeds_allowance_table() {
    assert!(!exceeds_allowance("p95", 5, 100));
    assert!(exceeds_allowance("p95", 6, 100));
    assert!(!exceeds_allowance("p99", 1, 100));
    assert!(exceeds_allowance("p99", 2, 100));
    assert!(!exceeds_allowance("p50", 50, 100));
    assert!(exceeds_allowance("p50", 51, 100));
    assert!(!exceeds_allowance("default", 100, 100));
}

/// 안내 문장이 뒤집히는 경계를 고정값으로 박는다: 느린 쪽 개수가 허용 몫 바로 아래/위일 때
/// 서버의 `value_at_quantile` 통과 여부와 `exceeds_allowance`가 같은 답을 낸다.
#[test]
fn allowance_boundary_flips_where_percentile_flips() {
    // (기준 basis, 분위수, 전체 N, 느린 쪽 개수, 허용 몫 초과 여부)
    let cases = [
        ("p95", 0.95, 100u64, 5u64, false),
        ("p95", 0.95, 100, 6, true),
        ("p99", 0.99, 200, 2, false),
        ("p99", 0.99, 200, 3, true),
        ("p50", 0.5, 2, 1, false),
        ("p50", 0.5, 4, 2, false),
        ("p50", 0.5, 4, 3, true),
    ];
    let slow_ms = 3000;
    for (basis, q, n, over, exceeded) in cases {
        let mut h = hist();
        rec_ms(&mut h, 500, n - over);
        rec_ms(&mut h, 4000, over);
        let row = count_bands(&h, slow_ms, basis, false);
        let total = row.fast.unwrap_or(0) + row.within + row.over;
        assert_eq!((total, row.over), (n, over), "{basis} n={n} over={over}");
        let passes = h.value_at_quantile(q) / 1_000 <= slow_ms;
        assert_eq!(
            exceeds_allowance(basis, row.over, total),
            exceeded,
            "{basis} n={n} over={over}: 허용 몫 초과 여부"
        );
        assert_eq!(
            passes,
            !exceeds_allowance(basis, row.over, total),
            "{basis} n={n} over={over}: 분위수 통과 여부와 일치"
        );
    }
}

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 11
    }
    fn unit(&mut self) -> f64 {
        (self.next() as f64) / ((1u64 << 53) as f64)
    }
}

#[test]
fn verdict_agrees_with_over_share() {
    let mut rng = Lcg(0x5eed_1234_abcd_ef01);
    for case in 0..300 {
        let n = 1 + (rng.next() % 5000);
        let slow_ms = match rng.next() % 4 {
            0 => 0,
            1 => 1 + rng.next() % 50,
            2 => 800 + rng.next() % 3000,
            _ => 1 + rng.next() % 9000,
        };
        let mut h = hist();
        for _ in 0..n {
            let us = if rng.next() % 4 == 0 {
                // 기준 ±1ms 근처
                let base = (slow_ms * 1_000) as i64;
                let off = (rng.next() % 4_001) as i64 - 2_000;
                (base + off).max(1) as u64
            } else {
                // 1µs..10s 로그 분포
                let e = rng.unit() * (10_000_000f64).ln();
                (e.exp() as u64).clamp(1, 10_000_000)
            };
            h.record(us).unwrap();
        }
        let row = count_bands(&h, slow_ms, "p95", false);
        let total = row.fast.unwrap_or(0) + row.within + row.over;
        assert_eq!(total, h.len());
        for (q, basis) in [(0.95, "p95"), (0.99, "p99"), (0.5, "p50")] {
            let passes = h.value_at_quantile(q) / 1_000 <= slow_ms;
            assert_eq!(
                passes,
                !exceeds_allowance(basis, row.over, total),
                "case {case} q={q} slow_ms={slow_ms} n={n} over={} total={total}",
                row.over
            );
        }
    }
}

#[test]
fn rule2_counts_by_us() {
    let mut h = hist();
    h.record(43_900).unwrap();
    let r1 = count_bands(&h, 43, "p95", false);
    assert_eq!((r1.within, r1.over), (1, 0));
    assert_eq!(r1.slow_us, None);
    let r2 = count_bands_us(&h, 43_000, "p95", false);
    assert_eq!((r2.within, r2.over), (0, 1));
    assert_eq!(r2.slow_ms, 43);
    assert_eq!(r2.slow_us, Some(43_000));
}

#[test]
fn rule2_step_fraction() {
    let c = crit(|c| c.step_criteria = vec![sc("p95_ms", "max", 43.5, "s1")]);
    assert_eq!(step_boundary_us(Some(&c), "s1"), Some((43_500, "p95")));
    assert_eq!(step_boundary(Some(&c), "s1"), Some((43, "p95")));
}

#[test]
fn rule2_build_sets_slow_us() {
    let mut o = hist();
    rec_ms(&mut o, 10, 5);
    let mut per = BTreeMap::new();
    per.insert("s1".to_string(), o.clone());
    let c = crit(|c| {
        c.max_p95_ms = Some(200);
        c.step_criteria = vec![sc("p95_ms", "max", 43.5, "s1")];
    });
    let sb = build(&o, &per, Some(&c), LATENCY_RULE_CURRENT).unwrap();
    assert_eq!(sb.overall.slow_us, Some(200_000));
    assert_eq!(sb.steps[0].row.slow_us, Some(43_500));
    assert_eq!(sb.steps[0].row.slow_ms, 43);
    let l = build(&o, &per, Some(&c), LATENCY_RULE_LEGACY).unwrap();
    assert_eq!(l.overall.slow_us, None);
    assert_eq!(l.steps[0].row.slow_us, None);
    assert_eq!(l.steps[0].row.slow_ms, 43);
    assert_eq!(sb.overall.within, l.overall.within);
}

#[test]
fn verdict_agrees_with_over_share_rule2() {
    let mut rng = Lcg(0x5eed_9876_abcd_ef01);
    for case in 0..300 {
        let n = 1 + (rng.next() % 5000);
        let slow_ms = match rng.next() % 4 {
            0 => 0,
            1 => 1 + rng.next() % 50,
            2 => 800 + rng.next() % 3000,
            _ => 1 + rng.next() % 9000,
        };
        let slow_us = slow_ms * 1_000 + rng.next() % 1_000;
        let mut h = hist();
        for _ in 0..n {
            let us = if rng.next() % 4 == 0 {
                let off = (rng.next() % 4_001) as i64 - 2_000;
                (slow_us as i64 + off).max(1) as u64
            } else {
                let e = rng.unit() * (10_000_000f64).ln();
                (e.exp() as u64).clamp(1, 10_000_000)
            };
            h.record(us).unwrap();
        }
        let row = count_bands_us(&h, slow_us, "p95", false);
        let total = row.fast.unwrap_or(0) + row.within + row.over;
        assert_eq!(total, h.len());
        for (milli, basis) in [(95_000, "p95"), (99_000, "p99"), (50_000, "p50")] {
            let passes = value_at_milli(&h, milli).unwrap() <= slow_us;
            assert_eq!(
                passes,
                !exceeds_allowance(basis, row.over, total),
                "case {case} milli={milli} slow_us={slow_us} n={n} over={} total={total}",
                row.over
            );
        }
    }
}
