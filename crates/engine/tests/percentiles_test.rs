use handicap_engine::percentiles::{Percentiles, decode_hdr, merge_into, percentiles_of};
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
