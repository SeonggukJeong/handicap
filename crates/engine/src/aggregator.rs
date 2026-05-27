use std::collections::HashMap;
use std::time::SystemTime;

use hdrhistogram::Histogram;
use hdrhistogram::serialization::{Serializer, V2Serializer};

use crate::error::{EngineError, Result};

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
}

impl Aggregator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&mut self, step_id: &str, latency_us: u64, status: u16, is_error: bool) {
        let ts = current_second();
        let key = (step_id.to_string(), ts);
        let w = self
            .windows
            .entry(key)
            .or_insert_with(|| StepWindow::new(step_id.to_string(), ts));
        w.record(latency_us, status, is_error);
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
        let mut a = Aggregator::new();
        a.record("step1", 1_000, 200, false);
        a.record("step1", 2_000, 200, false);
        a.record("step1", 50_000, 500, true);
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
        let mut a = Aggregator::new();
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
}
