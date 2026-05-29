use std::collections::HashMap;
use std::time::SystemTime;

use hdrhistogram::Histogram;
use hdrhistogram::serialization::{Serializer, V2Serializer};

use crate::error::{EngineError, Result};

/// Overflow bucket key: any loop_index >= cap is folded here.
pub const LOOP_OVERFLOW: u32 = u32::MAX;

/// A per-(step_id, loop_index) request/error delta since the last drain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopStat {
    pub step_id: String,
    pub loop_index: u32, // LOOP_OVERFLOW = aggregated ">= cap" bucket
    pub count: u64,
    pub error_count: u64,
}

#[derive(Debug, Default, Clone, Copy)]
struct LoopCount {
    count: u64,
    error_count: u64,
}

/// One 1-second bucket of metrics for one step.
#[derive(Debug)]
pub struct StepWindow {
    pub step_id: String,
    pub ts_second: i64,
    pub count: u64,
    pub error_count: u64,
    pub status_counts: HashMap<u16, u64>,
    pub histogram: Histogram<u64>,
}

impl StepWindow {
    fn new(step_id: String, ts_second: i64) -> Self {
        // 1 microsecond to 60 seconds, 3 significant digits — covers all realistic web latencies.
        let h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).expect("valid bounds");
        Self {
            step_id,
            ts_second,
            count: 0,
            error_count: 0,
            status_counts: HashMap::new(),
            histogram: h,
        }
    }

    pub fn record(&mut self, latency_us: u64, status: u16, is_error: bool) {
        let v = latency_us.clamp(1, 60_000_000);
        let _ = self.histogram.record(v);
        self.count += 1;
        if is_error {
            self.error_count += 1;
        }
        *self.status_counts.entry(status).or_insert(0) += 1;
    }

    pub fn serialize_histogram(&self) -> Result<Vec<u8>> {
        let mut buf = Vec::new();
        let mut ser = V2Serializer::new();
        ser.serialize(&self.histogram, &mut buf)
            .map_err(|e| EngineError::Histogram(e.to_string()))?;
        Ok(buf)
    }
}

/// Accumulator keyed by (step_id, ts_second). Flush returns and drains all windows
/// whose ts_second is strictly less than `up_to_second` so the most recent (live)
/// bucket keeps accumulating.
#[derive(Debug, Default)]
pub struct Aggregator {
    windows: HashMap<(String, i64), StepWindow>,
    loop_counts: HashMap<(String, u32), LoopCount>,
    loop_cap: u32,
}

impl Aggregator {
    pub fn new(loop_breakdown_cap: u32) -> Self {
        Self {
            windows: HashMap::new(),
            loop_counts: HashMap::new(),
            loop_cap: loop_breakdown_cap,
        }
    }

    pub fn record(
        &mut self,
        step_id: &str,
        latency_us: u64,
        status: u16,
        is_error: bool,
        loop_index: Option<u32>,
    ) {
        let ts = current_second();
        let key = (step_id.to_string(), ts);
        let w = self
            .windows
            .entry(key)
            .or_insert_with(|| StepWindow::new(step_id.to_string(), ts));
        w.record(latency_us, status, is_error);

        if self.loop_cap > 0 {
            if let Some(i) = loop_index {
                let bucket = if i < self.loop_cap { i } else { LOOP_OVERFLOW };
                let c = self
                    .loop_counts
                    .entry((step_id.to_string(), bucket))
                    .or_default();
                c.count += 1;
                if is_error {
                    c.error_count += 1;
                }
            }
        }
    }

    /// Take and reset the accumulated per-(step_id, loop_index) deltas.
    pub fn drain_loop_deltas(&mut self) -> Vec<LoopStat> {
        std::mem::take(&mut self.loop_counts)
            .into_iter()
            .map(|((step_id, loop_index), c)| LoopStat {
                step_id,
                loop_index,
                count: c.count,
                error_count: c.error_count,
            })
            .collect()
    }

    pub fn drain_completed(&mut self, up_to_second: i64) -> Vec<StepWindow> {
        let keys: Vec<_> = self
            .windows
            .keys()
            .filter(|(_, ts)| *ts < up_to_second)
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|k| self.windows.remove(&k))
            .collect()
    }

    pub fn drain_all(&mut self) -> Vec<StepWindow> {
        std::mem::take(&mut self.windows).into_values().collect()
    }
}

fn current_second() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_serializes() {
        let mut a = Aggregator::new(256);
        a.record("step1", 1_000, 200, false, None);
        a.record("step1", 2_000, 200, false, None);
        a.record("step1", 50_000, 500, true, None);
        let mut all = a.drain_all();
        assert_eq!(all.len(), 1);
        let w = all.pop().unwrap();
        assert_eq!(w.step_id, "step1");
        assert_eq!(w.count, 3);
        assert_eq!(w.error_count, 1);
        assert_eq!(w.status_counts.get(&200), Some(&2));
        assert_eq!(w.status_counts.get(&500), Some(&1));
        let bytes = w.serialize_histogram().expect("serializes");
        assert!(!bytes.is_empty(), "histogram bytes should be non-empty");
    }

    #[test]
    fn drain_completed_keeps_current_second() {
        let mut a = Aggregator::new(256);
        // Manually insert two windows at different seconds to be deterministic.
        let mut old = StepWindow::new("s".into(), 1_000);
        old.record(500, 200, false);
        let mut new_w = StepWindow::new("s".into(), 1_001);
        new_w.record(500, 200, false);
        a.windows.insert(("s".into(), 1_000), old);
        a.windows.insert(("s".into(), 1_001), new_w);

        let drained = a.drain_completed(1_001);
        assert_eq!(drained.len(), 1, "only ts<1001 should drain");
        assert_eq!(drained[0].ts_second, 1_000);
        assert!(a.windows.contains_key(&("s".into(), 1_001)));
    }

    #[test]
    fn loop_counts_by_index_within_cap() {
        let mut a = Aggregator::new(256);
        a.record("s", 1_000, 200, false, Some(0));
        a.record("s", 1_000, 200, false, Some(0));
        a.record("s", 1_000, 500, true, Some(1));
        let deltas = a.drain_loop_deltas();
        let mut m: std::collections::HashMap<(String, u32), (u64, u64)> = Default::default();
        for d in deltas {
            m.insert((d.step_id, d.loop_index), (d.count, d.error_count));
        }
        assert_eq!(m.get(&("s".to_string(), 0)), Some(&(2, 0)));
        assert_eq!(m.get(&("s".to_string(), 1)), Some(&(1, 1)));
    }

    #[test]
    fn loop_index_at_or_above_cap_folds_into_overflow_sentinel() {
        let mut a = Aggregator::new(4);
        a.record("s", 1_000, 200, false, Some(4)); // == cap -> overflow
        a.record("s", 1_000, 200, false, Some(99)); // > cap  -> overflow
        a.record("s", 1_000, 200, false, Some(3)); // < cap  -> own bucket
        let deltas = a.drain_loop_deltas();
        let by: std::collections::HashMap<u32, u64> = deltas
            .into_iter()
            .map(|d| (d.loop_index, d.count))
            .collect();
        assert_eq!(by.get(&3), Some(&1));
        assert_eq!(by.get(&u32::MAX), Some(&2), "overflow bucket = u32::MAX");
    }

    #[test]
    fn cap_zero_disables_breakdown() {
        let mut a = Aggregator::new(0);
        a.record("s", 1_000, 200, false, Some(0));
        a.record("s", 1_000, 200, false, Some(5));
        assert!(
            a.drain_loop_deltas().is_empty(),
            "cap=0 records no loop stats"
        );
    }

    #[test]
    fn none_loop_index_records_no_breakdown() {
        let mut a = Aggregator::new(256);
        a.record("s", 1_000, 200, false, None);
        assert!(a.drain_loop_deltas().is_empty());
    }

    #[test]
    fn drain_loop_deltas_resets_between_drains() {
        let mut a = Aggregator::new(256);
        a.record("s", 1_000, 200, false, Some(0));
        assert_eq!(a.drain_loop_deltas().len(), 1);
        assert!(
            a.drain_loop_deltas().is_empty(),
            "second drain empty (delta reset)"
        );
    }
}
