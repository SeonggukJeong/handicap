use handicap_engine::percentiles::{
    CURVE_QUANTILES, HISTOGRAM_BINS, Percentiles, decode_hdr, log_buckets, merge_into,
    percentile_curve, percentiles_of,
};
use hdrhistogram::Histogram;
use hdrhistogram::serialization::{Serializer, V2Serializer};

fn record_us(h: &mut Histogram<u64>, samples_us: &[u64]) {
    for &v in samples_us {
        h.record(v).unwrap();
    }
}

fn serialize(h: &Histogram<u64>) -> Vec<u8> {
    let mut buf = Vec::new();
    V2Serializer::new().serialize(h, &mut buf).unwrap();
    buf
}

#[test]
fn percentiles_of_uniform_distribution() {
    // 1ms..100ms, 100 samples — p50 ~= 50ms, p95 ~= 95ms, p99 ~= 99ms
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(&mut h, &(1..=100).map(|i| i * 1_000).collect::<Vec<_>>());
    let p = percentiles_of(&h);
    assert!(p.p50_ms >= 49 && p.p50_ms <= 51, "p50={} not ~50", p.p50_ms);
    assert!(p.p95_ms >= 94 && p.p95_ms <= 96, "p95={} not ~95", p.p95_ms);
    assert!(
        p.p99_ms >= 98 && p.p99_ms <= 100,
        "p99={} not ~99",
        p.p99_ms
    );
}

#[test]
fn decode_roundtrip() {
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(&mut h, &[10_000, 20_000, 30_000, 40_000, 50_000]);
    let bytes = serialize(&h);
    let decoded = decode_hdr(&bytes).expect("decode ok").expect("non-empty");
    let p = percentiles_of(&decoded);
    let p_original = percentiles_of(&h);
    assert_eq!(p, p_original);
}

#[test]
fn decode_empty_returns_none() {
    assert!(decode_hdr(&[]).unwrap().is_none());
}

#[test]
fn decode_garbage_returns_err() {
    assert!(decode_hdr(&[0xFF, 0xFF, 0xFF, 0xFF]).is_err());
}

#[test]
fn merge_is_lossless_for_overlapping_samples() {
    let mut a = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    let mut b = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(&mut a, &[10_000, 20_000, 30_000]);
    record_us(&mut b, &[40_000, 50_000, 60_000]);

    let mut union = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(
        &mut union,
        &[10_000, 20_000, 30_000, 40_000, 50_000, 60_000],
    );

    merge_into(&mut a, &b);
    assert_eq!(percentiles_of(&a), percentiles_of(&union));
}

#[test]
fn empty_percentiles() {
    assert_eq!(
        Percentiles::empty(),
        Percentiles {
            p50_ms: 0,
            p95_ms: 0,
            p99_ms: 0
        }
    );
}

#[test]
fn percentile_curve_is_monotone_nondecreasing() {
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(&mut h, &(1..=1000).map(|i| i * 1_000).collect::<Vec<_>>());
    let curve = percentile_curve(&h, &CURVE_QUANTILES);
    assert_eq!(curve.len(), CURVE_QUANTILES.len());
    for (i, (q, _)) in curve.iter().enumerate() {
        assert_eq!(*q, CURVE_QUANTILES[i], "quantiles preserved in order");
    }
    for w in curve.windows(2) {
        assert!(w[1].1 >= w[0].1, "curve must be non-decreasing: {w:?}");
    }
    // p50 ~ 500ms = 500_000us (HDR 3-sigfig tolerance).
    let p50 = curve.iter().find(|(q, _)| *q == 0.50).unwrap().1;
    assert!((480_000..=520_000).contains(&p50), "p50_us={p50}");
}

#[test]
fn log_buckets_partition_sums_to_total() {
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(
        &mut h,
        &[
            500, 600, 700, 800, 900, 1_000, 2_000, 5_000, 50_000, 500_000,
        ],
    );
    let buckets = log_buckets(&h, HISTOGRAM_BINS);
    assert!(!buckets.is_empty());
    let sum: u64 = buckets.iter().map(|(_, _, c)| *c).sum();
    assert_eq!(sum, h.len(), "bucket counts must partition all samples");
    for (lo, hi, _) in &buckets {
        assert!(lo <= hi, "lower<=upper within a bucket");
    }
    for w in buckets.windows(2) {
        assert_eq!(w[0].1, w[1].0, "adjacent buckets share a boundary");
    }
}

#[test]
fn log_buckets_dense_low_latency_sums_exactly() {
    // 1000 samples packed at 1-3ms — the count_between double-count trap regime.
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(
        &mut h,
        &(0..1000).map(|i| 1_000 + (i % 2000)).collect::<Vec<_>>(),
    );
    let buckets = log_buckets(&h, HISTOGRAM_BINS);
    let sum: u64 = buckets.iter().map(|(_, _, c)| *c).sum();
    assert_eq!(sum, 1000);
}

#[test]
fn log_buckets_single_value_lands_in_one_bucket() {
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(&mut h, &[5_000, 5_000, 5_000]);
    let buckets = log_buckets(&h, HISTOGRAM_BINS);
    let nonzero: Vec<_> = buckets.iter().filter(|(_, _, c)| *c > 0).collect();
    assert_eq!(nonzero.len(), 1, "all identical samples in one bucket");
    assert_eq!(nonzero[0].2, 3);
}

#[test]
fn log_buckets_empty_and_curve_no_panic() {
    let h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    assert!(log_buckets(&h, HISTOGRAM_BINS).is_empty());
    let _ = percentile_curve(&h, &CURVE_QUANTILES); // empty → zeros, must not panic
}
