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
