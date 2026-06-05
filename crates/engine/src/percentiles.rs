use hdrhistogram::{Histogram, serialization::Deserializer};
use std::io::Cursor;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Percentiles {
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

impl Percentiles {
    pub fn empty() -> Self {
        Self {
            p50_ms: 0,
            p95_ms: 0,
            p99_ms: 0,
        }
    }
}

#[derive(Debug, Error)]
pub enum PercentileError {
    #[error("failed to decode HDR Histogram V2 blob: {0}")]
    Decode(String),
}

/// Deserialize a V2-serialized HDR Histogram BLOB (microseconds).
/// Empty BLOB returns Ok(None) — caller can use Percentiles::empty().
pub fn decode_hdr(bytes: &[u8]) -> Result<Option<Histogram<u64>>, PercentileError> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let mut cur = Cursor::new(bytes);
    let mut deser = Deserializer::new();
    deser
        .deserialize(&mut cur)
        .map(Some)
        .map_err(|e| PercentileError::Decode(e.to_string()))
}

/// Read percentiles in milliseconds. Histogram stores microseconds; we divide.
pub fn percentiles_of(h: &Histogram<u64>) -> Percentiles {
    Percentiles {
        p50_ms: h.value_at_quantile(0.50) / 1_000,
        p95_ms: h.value_at_quantile(0.95) / 1_000,
        p99_ms: h.value_at_quantile(0.99) / 1_000,
    }
}

/// Merge `other` into `acc`. Both must have the same scale (microseconds).
/// HDR Histogram add is lossless when ranges overlap.
pub fn merge_into(acc: &mut Histogram<u64>, other: &Histogram<u64>) {
    acc.add(other).expect("histograms have compatible bounds");
}

/// Quantiles for the report percentile-distribution curve. Bookended by q=0.0
/// (min recorded) and q=1.0 (max) so the chart shows the full spread.
pub const CURVE_QUANTILES: [f64; 11] = [
    0.0, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99, 0.999, 0.9999, 1.0,
];

/// Number of log-spaced display bins for the latency histogram.
pub const HISTOGRAM_BINS: usize = 40;

/// Value (microseconds) at each requested quantile, paired with the quantile.
/// Caller skips this when the histogram is empty (`h.len() == 0`).
pub fn percentile_curve(h: &Histogram<u64>, quantiles: &[f64]) -> Vec<(f64, u64)> {
    quantiles
        .iter()
        .map(|&q| (q, h.value_at_quantile(q)))
        .collect()
}

/// Log-spaced histogram buckets as `(lower_us, upper_us, count)`.
///
/// Counts are an EXACT partition of the recorded samples: each recorded HDR
/// sub-bucket (yielded once by `iter_recorded`) is assigned to exactly one bin
/// by its value, so the per-bin counts sum to `h.len()`. We deliberately do NOT
/// use `count_between` half-open subtraction — its inclusive boundaries snap to
/// HDR sub-bucket edges and double-count at fine resolution.
pub fn log_buckets(h: &Histogram<u64>, bins: usize) -> Vec<(u64, u64, u64)> {
    if h.is_empty() || bins == 0 {
        return Vec::new();
    }
    let lo = h.min().max(1);
    let hi = h.max();
    if lo >= hi {
        // Degenerate min==max histogram — single bucket. (NB: identical recorded
        // samples normally have min<max via HDR sub-bucket bounds, so they instead
        // flow through the general loop below and still land in one bin.)
        return vec![(lo, hi, h.len())];
    }
    let log_lo = (lo as f64).ln();
    let span = (hi as f64).ln() - log_lo;
    let edge = |i: usize| -> f64 { (log_lo + span * (i as f64) / (bins as f64)).exp() };

    let mut counts = vec![0u64; bins];
    for it in h.iter_recorded() {
        let c = it.count_since_last_iteration();
        if c == 0 {
            continue;
        }
        let v = it.value_iterated_to().max(1);
        let frac = ((v as f64).ln() - log_lo) / span;
        let j = (frac * bins as f64).floor() as isize;
        let j = j.clamp(0, bins as isize - 1) as usize;
        counts[j] += c;
    }

    (0..bins)
        .map(|i| {
            (
                edge(i).round() as u64,
                edge(i + 1).round() as u64,
                counts[i],
            )
        })
        .collect()
}
