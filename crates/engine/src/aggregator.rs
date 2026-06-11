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

/// A per-(if_id, branch) decision-count delta since the last drain. Branch metrics
/// are **decision counts** (which branch an `if` selected), not request counts — a
/// decision has no request and no error, so there is deliberately no `error_count`
/// here (contrast `LoopStat`). The `none` branch (no match + empty/absent else) is the
/// whole reason this is a dedicated counter: it has no http leaf to attach to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchStat {
    pub step_id: String, // the `if` node's id
    pub branch: String,  // "then" | "elif_0".. | "else" | "none"
    pub count: u64,
}

/// A per-(parallel_step_id, branch) group latency delta since the last drain — branch="" is the
/// page-load (whole concurrent block), else that branch's wall-clock. HDR (not
/// counts) — page latency is a distribution merged by the controller via
/// `Histogram::add` (delta-merge), unlike `LoopStat`/`BranchStat` count-sum. The
/// histogram is carried live; the worker serializes it at forward time (like StepWindow).
#[derive(Debug)]
pub struct GroupStat {
    pub step_id: String, // the `parallel` node's id
    pub branch: String,  // "" = page (whole block), else the branch name
    pub histogram: Histogram<u64>,
    pub count: u64,
}

impl GroupStat {
    pub fn serialize_histogram(&self) -> Result<Vec<u8>> {
        let mut buf = Vec::new();
        let mut ser = V2Serializer::new();
        ser.serialize(&self.histogram, &mut buf)
            .map_err(|e| EngineError::Histogram(e.to_string()))?;
        Ok(buf)
    }
}

/// A per-(step_id, phase) latency delta since the last drain. HDR (not counts) —
/// merged by the controller via `Histogram::add` (like `GroupStat`). v1 only ever
/// records phase = "download" (response-body download time); the `phase` key leaves
/// room for DNS/TCP/TLS/total later with no schema change (spec §4.2).
#[derive(Debug)]
pub struct PhaseStat {
    pub step_id: String,
    pub phase: String,
    pub histogram: Histogram<u64>,
    pub count: u64,
}

impl PhaseStat {
    pub fn serialize_histogram(&self) -> Result<Vec<u8>> {
        let mut buf = Vec::new();
        let mut ser = V2Serializer::new();
        ser.serialize(&self.histogram, &mut buf)
            .map_err(|e| EngineError::Histogram(e.to_string()))?;
        Ok(buf)
    }
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
    branch_counts: HashMap<(String, String), u64>,
    /// per-parallel-node accumulating page-load latency + sample count (A2-2);
    /// keyed by (step_id, branch) — branch = "" is the page (whole concurrent block),
    /// branch = <name> is one parallel branch's wall-clock (per-branch breakdown).
    group_hists: HashMap<(String, String), (Histogram<u64>, u64)>,
    /// per-(step_id, phase) accumulating latency-phase HDR + sample count (B7-C).
    phase_hists: HashMap<(String, String), (Histogram<u64>, u64)>,
}

impl Aggregator {
    pub fn new(loop_breakdown_cap: u32) -> Self {
        Self {
            windows: HashMap::new(),
            loop_counts: HashMap::new(),
            loop_cap: loop_breakdown_cap,
            branch_counts: HashMap::new(),
            group_hists: HashMap::new(),
            phase_hists: HashMap::new(),
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

    /// Record one branch decision for an `if` node. Unconditional (no cap): the branch
    /// set per `if` node is finite (then + #elif + else/none), unlike `loop_index`.
    pub fn record_branch(&mut self, step_id: &str, branch: &str) {
        *self
            .branch_counts
            .entry((step_id.to_string(), branch.to_string()))
            .or_default() += 1;
    }

    /// Take and reset the accumulated per-(if_id, branch) decision deltas.
    pub fn drain_branch_deltas(&mut self) -> Vec<BranchStat> {
        std::mem::take(&mut self.branch_counts)
            .into_iter()
            .map(|((step_id, branch), count)| BranchStat {
                step_id,
                branch,
                count,
            })
            .collect()
    }

    /// Record one parallel-node latency sample (µs). HDR-accumulating, unconditional
    /// (no cap). branch = "" → page (whole concurrent block); branch = <name> → that
    /// branch's wall-clock. One sample per (node, branch) per clean iteration.
    pub fn record_group(&mut self, step_id: &str, branch: &str, latency_us: u64) {
        let v = latency_us.clamp(1, 60_000_000);
        let e = self
            .group_hists
            .entry((step_id.to_string(), branch.to_string()))
            .or_insert_with(|| {
                (
                    Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).expect("valid bounds"),
                    0,
                )
            });
        let _ = e.0.record(v);
        e.1 += 1;
    }

    /// Take and reset the accumulated per-(parallel_step_id, branch) page-load histograms
    /// as deltas (the controller merges them via Histogram::add). Histograms returned live.
    pub fn drain_group_deltas(&mut self) -> Vec<GroupStat> {
        std::mem::take(&mut self.group_hists)
            .into_iter()
            .map(|((step_id, branch), (histogram, count))| GroupStat {
                step_id,
                branch,
                histogram,
                count,
            })
            .collect()
    }

    /// Record one latency-phase sample (µs) for (step_id, phase). HDR-accumulating,
    /// unconditional (no cap) — the caller (runner) gates on `measure_phases`.
    pub fn record_phase(&mut self, step_id: &str, phase: &str, latency_us: u64) {
        let v = latency_us.clamp(1, 60_000_000);
        let e = self
            .phase_hists
            .entry((step_id.to_string(), phase.to_string()))
            .or_insert_with(|| {
                (
                    Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).expect("valid bounds"),
                    0,
                )
            });
        let _ = e.0.record(v);
        e.1 += 1;
    }

    /// Take and reset the accumulated per-(step_id, phase) histograms as deltas
    /// (the controller merges them via Histogram::add). Histograms returned live.
    pub fn drain_phase_deltas(&mut self) -> Vec<PhaseStat> {
        std::mem::take(&mut self.phase_hists)
            .into_iter()
            .map(|((step_id, phase), (histogram, count))| PhaseStat {
                step_id,
                phase,
                histogram,
                count,
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

    #[test]
    fn branch_counts_accumulate_per_if_and_branch() {
        // cap is irrelevant to branch counting — pass 0 to prove independence.
        let mut a = Aggregator::new(0);
        a.record_branch("if1", "then");
        a.record_branch("if1", "then");
        a.record_branch("if1", "elif_0");
        a.record_branch("if2", "none");
        let m: std::collections::HashMap<(String, String), u64> = a
            .drain_branch_deltas()
            .into_iter()
            .map(|b| ((b.step_id, b.branch), b.count))
            .collect();
        assert_eq!(m.get(&("if1".into(), "then".into())), Some(&2));
        assert_eq!(m.get(&("if1".into(), "elif_0".into())), Some(&1));
        assert_eq!(m.get(&("if2".into(), "none".into())), Some(&1));
    }

    #[test]
    fn drain_branch_deltas_resets_between_drains() {
        let mut a = Aggregator::new(0);
        a.record_branch("if1", "then");
        assert_eq!(a.drain_branch_deltas().len(), 1);
        assert!(
            a.drain_branch_deltas().is_empty(),
            "second drain empty (delta reset)"
        );
    }

    #[test]
    fn record_group_accumulates_and_drains_as_delta() {
        let mut a = Aggregator::new(0); // cap irrelevant to group latency
        a.record_group("p1", "", 100_000); // page 100 ms
        a.record_group("p1", "", 300_000); // page 300 ms
        a.record_group("p1", "a", 100_000); // branch a
        a.record_group("p2", "", 50_000); // page
        let mut by: std::collections::HashMap<(String, String), (u64, u64)> = Default::default();
        for g in a.drain_group_deltas() {
            by.insert(
                (g.step_id.clone(), g.branch.clone()),
                (g.count, g.histogram.max()),
            );
        }
        assert_eq!(
            by.get(&("p1".into(), "".into())).map(|x| x.0),
            Some(2),
            "p1 page 2 samples"
        );
        assert_eq!(
            by.get(&("p1".into(), "a".into())).map(|x| x.0),
            Some(1),
            "p1 branch a 1 sample"
        );
        assert_eq!(
            by.get(&("p2".into(), "".into())).map(|x| x.0),
            Some(1),
            "p2 page 1 sample"
        );
        assert!(
            by[&("p1".into(), "".into())].1 >= 290_000,
            "p1 page max ~= 300ms"
        );
        assert!(
            a.drain_group_deltas().is_empty(),
            "drain resets group hists"
        );
    }

    #[test]
    fn group_stat_serializes_histogram() {
        let mut a = Aggregator::new(0);
        a.record_group("p1", "", 12_345);
        let g = a.drain_group_deltas().pop().expect("one group stat");
        let bytes = g.serialize_histogram().expect("serializes");
        assert!(!bytes.is_empty(), "group histogram bytes non-empty");
    }

    #[test]
    fn record_phase_accumulates_and_drains_as_delta() {
        let mut a = Aggregator::new(0); // cap irrelevant to phase latency
        a.record_phase("s1", "download", 100_000); // 100 ms
        a.record_phase("s1", "download", 300_000); // 300 ms
        a.record_phase("s2", "download", 50_000);
        let mut by: std::collections::HashMap<(String, String), (u64, u64)> = Default::default();
        for p in a.drain_phase_deltas() {
            by.insert(
                (p.step_id.clone(), p.phase.clone()),
                (p.count, p.histogram.max()),
            );
        }
        assert_eq!(
            by.get(&("s1".into(), "download".into())).map(|x| x.0),
            Some(2)
        );
        assert_eq!(
            by.get(&("s2".into(), "download".into())).map(|x| x.0),
            Some(1)
        );
        assert!(by[&("s1".into(), "download".into())].1 >= 290_000);
        assert!(
            a.drain_phase_deltas().is_empty(),
            "drain resets phase hists"
        );
    }

    #[test]
    fn phase_stat_serializes_histogram() {
        let mut a = Aggregator::new(0);
        a.record_phase("s1", "download", 12_345);
        let p = a.drain_phase_deltas().pop().expect("one phase stat");
        assert!(!p.serialize_histogram().expect("serializes").is_empty());
    }
}
