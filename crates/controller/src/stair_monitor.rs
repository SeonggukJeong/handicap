//! 계단 run 자동 정지 감시 — 받은 배치를 ingest와 같은 규칙으로 걸러 누적기에 쌓는다.
//! 이 파일은 수신 쪽(중복·타당성·시작 시각 전 보류 행)만 맡는다.

use std::collections::{BTreeMap, BTreeSet};

use handicap_engine::percentiles::decode_hdr;
use handicap_proto::v1 as pb;
use hdrhistogram::Histogram;
use tracing::warn;

use crate::auto_stop::StopInfo;
use crate::grpc::coordinator::{plausible_second, plausible_start};
use crate::stair::{Bound, StairAccumulator, StairConfig};

/// 시작 시각 전 보류 행 버퍼 상한 — 초 단위.
pub const PENDING_MAX_SECONDS: usize = 30;

/// coordinator가 감시 채널로 보내는 메시지. 배치를 상자에 넣지 않는다 — 배치당 할당 0(spec §4.5).
#[allow(clippy::large_enum_variant)]
pub enum MonitorMsg {
    Batch(pb::MetricBatch),
    /// 워커별 계단 몫(축소된 hold stage target).
    Worker {
        worker_id: String,
        step_targets: Vec<u32>,
    },
    WorkerEnded {
        worker_id: String,
    },
}

#[derive(Debug, Default)]
pub struct Outcome {
    /// `stopped_at_ms = 0` — coordinator가 채운다.
    pub stop: Option<StopInfo>,
    pub newly_suspended: u32,
}

enum Row {
    OpenLoop {
        launched: i64,
        completed: i64,
        dropped: i64,
    },
    Metric {
        count: i64,
        errors: i64,
        hist: Option<Histogram<u64>>,
    },
}

#[derive(Default)]
struct WorkerState {
    t0_ms: Option<i64>,
    /// 받은 open-loop 초의 최댓값.
    level: Option<i64>,
    /// launched > 0 ∨ dropped > 0 인 초의 최댓값.
    max_scheduled: Option<i64>,
    /// 이전 배치들까지 받은 최대 초(중복 제거 기준) — open-loop·metric 각각.
    prev_open_loop: Option<i64>,
    prev_metric: Option<i64>,
    /// 시작 시각 전에 온 행(초별).
    pending: BTreeMap<i64, Vec<Row>>,
}

pub struct StairMonitor {
    acc: StairAccumulator,
    pub expected: u32,
    workers: BTreeMap<String, WorkerState>,
    shares: BTreeMap<String, Vec<u32>>,
    pub ended: BTreeSet<String>,
}

impl StairMonitor {
    /// `cfg`는 `monitor_wanted`를 통과한 설정.
    pub fn new(cfg: &StairConfig, expected: u32) -> Self {
        Self {
            acc: StairAccumulator::new(cfg, false),
            expected,
            workers: BTreeMap::new(),
            shares: BTreeMap::new(),
            ended: BTreeSet::new(),
        }
    }

    pub fn on_msg(&mut self, msg: MonitorMsg, now_ms: i64) -> Outcome {
        match msg {
            MonitorMsg::Batch(b) => self.on_batch(b, now_ms),
            MonitorMsg::Worker {
                worker_id,
                step_targets,
            } => {
                // Resend 재등록이 같은 몫을 다시 알린다 — 첫 값 유지.
                self.shares.entry(worker_id).or_insert(step_targets);
            }
            MonitorMsg::WorkerEnded { worker_id } => {
                self.ended.insert(worker_id);
            }
        }
        Outcome::default()
    }

    fn on_batch(&mut self, b: pb::MetricBatch, now_ms: i64) {
        let now_s = now_ms.div_euclid(1000);
        let w = b.worker_id.as_str();
        let st = self.workers.entry(w.to_string()).or_default();

        // 시작 시각: ingest와 같은 필터, 첫 유효 값 유지.
        if b.open_loop_started_at_ms > 0
            && st.t0_ms.is_none()
            && plausible_start(b.open_loop_started_at_ms, now_ms)
        {
            let t0 = b.open_loop_started_at_ms;
            st.t0_ms = Some(t0);
            self.acc.set_worker(w, t0, Bound::Open);
            for (ts, rows) in std::mem::take(&mut st.pending) {
                for r in rows {
                    push_row(&mut self.acc, w, ts, r);
                }
            }
        }

        // open-loop 초: 시계 필터 → 이전 배치 최대 초보다 이른 행 버림.
        let prev = st.prev_open_loop;
        let mut batch_max = prev;
        for s in &b.open_loop_seconds {
            if !plausible_second(s.ts_second, now_s) || prev.is_some_and(|p| s.ts_second < p) {
                continue;
            }
            batch_max = batch_max.max(Some(s.ts_second));
            st.level = st.level.max(Some(s.ts_second));
            if s.launched > 0 || s.dropped > 0 {
                st.max_scheduled = st.max_scheduled.max(Some(s.ts_second));
            }
            let row = Row::OpenLoop {
                launched: s.launched as i64,
                completed: s.completed as i64,
                dropped: s.dropped as i64,
            };
            route(&mut self.acc, st, w, s.ts_second, row);
        }
        st.prev_open_loop = batch_max;

        // metric window: ingest가 받은 그대로 저장하므로 시각으로 거르지 않는다.
        let prev = st.prev_metric;
        let mut batch_max = prev;
        for win in &b.windows {
            if prev.is_some_and(|p| win.ts_second < p) {
                continue;
            }
            batch_max = batch_max.max(Some(win.ts_second));
            let hist = decode_hdr(&win.hdr_histogram).ok().flatten();
            let row = Row::Metric {
                count: win.count as i64,
                errors: win.error_count as i64,
                hist,
            };
            route(&mut self.acc, st, w, win.ts_second, row);
        }
        st.prev_metric = batch_max;
    }

    #[cfg(test)]
    fn acc(&self) -> &StairAccumulator {
        &self.acc
    }
}

fn push_row(acc: &mut StairAccumulator, w: &str, ts: i64, row: Row) {
    match row {
        Row::OpenLoop {
            launched,
            completed,
            dropped,
        } => acc.push_open_loop(w, ts, launched, completed, dropped),
        Row::Metric {
            count,
            errors,
            hist,
        } => {
            acc.push_metric(w, ts, count, errors, hist.as_ref());
        }
    }
}

/// 시작 시각이 있으면 누적기로, 없으면 보류 버퍼로(30초 분량 상한).
fn route(acc: &mut StairAccumulator, st: &mut WorkerState, w: &str, ts: i64, row: Row) {
    if st.t0_ms.is_some() {
        push_row(acc, w, ts, row);
        return;
    }
    st.pending.entry(ts).or_default().push(row);
    while st.pending.len() > PENDING_MAX_SECONDS {
        if let Some((old, _)) = st.pending.pop_first() {
            warn!(worker_id = %w, second = old, "dropping pending rows before open-loop start (30s cap)");
        }
    }
}

#[cfg(test)]
impl StairMonitor {
    fn level(&self, w: &str) -> Option<i64> {
        self.workers.get(w)?.level
    }
    fn max_scheduled(&self, w: &str) -> Option<i64> {
        self.workers.get(w)?.max_scheduled
    }
    fn t0(&self, w: &str) -> Option<i64> {
        self.workers.get(w)?.t0_ms
    }
    fn pending_seconds(&self, w: &str) -> usize {
        self.workers.get(w).map_or(0, |s| s.pending.len())
    }
    fn share(&self, w: &str) -> Option<&Vec<u32>> {
        self.shares.get(w)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::fresh_hist;
    use hdrhistogram::serialization::{Serializer, V2Serializer};

    const T0: i64 = 1_000_000; // 초
    const NOW_MS: i64 = (T0 + 5) * 1000;

    fn cfg() -> StairConfig {
        StairConfig {
            targets: vec![10, 20],
            hold_seconds: 10,
            ramp_seconds: 0,
            discard_seconds: 0,
            p99_cap_ms: None,
            auto_stop: None,
        }
    }

    fn hdr(p99_us: u64) -> Vec<u8> {
        let mut h = fresh_hist();
        h.record(p99_us).unwrap();
        let mut b = Vec::new();
        V2Serializer::new().serialize(&h, &mut b).unwrap();
        b
    }

    fn batch(
        w: &str,
        start_ms: i64,
        ol: &[(i64, u64, u64, u64)],
        win: &[(i64, u64, u64, u64)],
    ) -> MonitorMsg {
        MonitorMsg::Batch(pb::MetricBatch {
            run_id: "R".into(),
            worker_id: w.into(),
            windows: win
                .iter()
                .map(|&(ts, count, err, p99)| pb::MetricWindow {
                    ts_second: ts,
                    step_id: "_all".into(),
                    count,
                    error_count: err,
                    hdr_histogram: hdr(p99),
                    status_counts: Default::default(),
                })
                .collect(),
            open_loop_seconds: ol
                .iter()
                .map(|&(ts, l, c, d)| pb::OpenLoopSecond {
                    ts_second: ts,
                    launched: l,
                    completed: c,
                    dropped: d,
                })
                .collect(),
            open_loop_started_at_ms: start_ms,
            ..Default::default()
        })
    }

    fn mon() -> StairMonitor {
        StairMonitor::new(&cfg(), 1)
    }

    /// 계단 0의 (달성 = completed/10, dropped, 오류율).
    fn step0(m: &StairMonitor) -> (f64, u64, f64) {
        let n = m.acc().numbers(&[true, true], false);
        (
            n[0].achieved.unwrap(),
            n[0].dropped.unwrap(),
            n[0].error_rate,
        )
    }

    #[test]
    fn same_batch_many_seconds_all_taken() {
        let mut m = mon();
        m.on_msg(
            batch(
                "w",
                T0 * 1000,
                &[(T0 + 3, 5, 10, 1), (T0 + 1, 5, 20, 0), (T0 + 2, 5, 30, 0)],
                &[],
            ),
            NOW_MS,
        );
        assert_eq!(step0(&m).0, 6.0); // (10+20+30)/10
        assert_eq!(step0(&m).1, 1);
        assert_eq!(m.level("w"), Some(T0 + 3));
    }

    #[test]
    fn duplicate_older_second_ignored() {
        let mut m = mon();
        m.on_msg(
            batch(
                "w",
                T0 * 1000,
                &[(T0 + 4, 5, 10, 0)],
                &[(T0 + 4, 10, 1, 1000)],
            ),
            NOW_MS,
        );
        let before = step0(&m);
        // 재전송: 이전 최대 초(T0+4)보다 이른 초.
        m.on_msg(
            batch(
                "w",
                T0 * 1000,
                &[(T0 + 2, 5, 99, 0)],
                &[(T0 + 2, 99, 99, 1000)],
            ),
            NOW_MS,
        );
        assert_eq!(step0(&m), before);
        assert_eq!(m.level("w"), Some(T0 + 4));
    }

    #[test]
    fn implausible_open_loop_second_and_start_dropped() {
        let mut m = mon();
        // 시작 시각이 30일 넘게 과거 → 버림, t0 없음.
        m.on_msg(batch("w", NOW_MS - 31 * 86_400_000, &[], &[]), NOW_MS);
        assert_eq!(m.t0("w"), None);
        // 하루 넘게 먼 open-loop 초 → 버림.
        m.on_msg(
            batch("w", T0 * 1000, &[(T0 + 2 * 86_400, 5, 10, 0)], &[]),
            NOW_MS,
        );
        assert_eq!(m.t0("w"), Some(T0 * 1000));
        assert_eq!(m.level("w"), None);
        assert_eq!(step0(&m).0, 0.0);
    }

    #[test]
    fn metric_windows_not_time_filtered() {
        let mut m = mon();
        // t0를 시계에서 멀리(하루 안, 시작 시각 허용 범위 안) 잡아 구간이 시계와 멀다.
        let far = T0 + 80_000;
        m.on_msg(
            batch("w", far * 1000, &[], &[(far + 2, 10, 5, 1000)]),
            NOW_MS,
        );
        let n = m.acc().numbers(&[true, true], false);
        assert_eq!(n[0].error_rate, 0.5);
    }

    #[test]
    fn pending_rows_before_start_replayed() {
        let mut m = mon();
        m.on_msg(
            batch("w", 0, &[(T0 + 1, 5, 10, 2)], &[(T0 + 1, 10, 5, 1000)]),
            NOW_MS,
        );
        assert_eq!(m.pending_seconds("w"), 1);
        assert_eq!(m.level("w"), Some(T0 + 1));
        assert_eq!(step0(&m).0, 0.0);
        m.on_msg(batch("w", T0 * 1000, &[], &[]), NOW_MS);
        assert_eq!(m.pending_seconds("w"), 0);
        assert_eq!(step0(&m), (1.0, 2, 0.5));
    }

    #[test]
    fn pending_rows_cap_30s() {
        let mut m = mon();
        let ol: Vec<_> = (0..31).map(|i| (T0 + i, 5, 10, 0)).collect();
        m.on_msg(batch("w", 0, &ol, &[]), NOW_MS);
        assert_eq!(m.pending_seconds("w"), 30);
        m.on_msg(batch("w", T0 * 1000, &[], &[]), NOW_MS);
        // 가장 오래된 초(T0)가 버려져 계단 0엔 9개 초 × 10 = 90.
        assert_eq!(step0(&m).0, 9.0);
    }

    #[test]
    fn start_time_first_value_kept() {
        let mut m = mon();
        m.on_msg(batch("w", T0 * 1000, &[(T0 + 1, 5, 10, 0)], &[]), NOW_MS);
        m.on_msg(batch("w", (T0 + 3) * 1000, &[], &[]), NOW_MS);
        assert_eq!(m.t0("w"), Some(T0 * 1000));
        assert_eq!(step0(&m).0, 1.0);
        // 누적기도 첫 등록을 유지 — 다시 등록해도 계수가 지워지지 않는다.
        let mut a = StairAccumulator::new(&cfg(), false);
        a.set_worker("w", T0 * 1000, Bound::Open);
        a.push_open_loop("w", T0 + 1, 5, 10, 0);
        a.set_worker("w", (T0 + 3) * 1000, Bound::Open);
        assert_eq!(a.window("w", 0), Some((T0, T0 + 10)));
        assert_eq!(a.numbers(&[true, true], false)[0].achieved, Some(1.0));
    }

    #[test]
    fn worker_msg_twice_first_kept() {
        let mut m = mon();
        let msg = |t: Vec<u32>| MonitorMsg::Worker {
            worker_id: "w".into(),
            step_targets: t,
        };
        m.on_msg(msg(vec![5, 10]), NOW_MS);
        m.on_msg(msg(vec![99, 99]), NOW_MS);
        assert_eq!(m.share("w"), Some(&vec![5, 10]));
    }

    #[test]
    fn max_scheduled_tracks_launched_or_dropped() {
        let mut m = mon();
        m.on_msg(
            batch(
                "w",
                T0 * 1000,
                &[
                    (T0 + 1, 3, 3, 0),
                    (T0 + 2, 0, 1, 0),
                    (T0 + 3, 0, 0, 2),
                    (T0 + 4, 0, 0, 0),
                ],
                &[],
            ),
            NOW_MS,
        );
        assert_eq!(m.max_scheduled("w"), Some(T0 + 3));
        assert_eq!(m.level("w"), Some(T0 + 4));
    }
}
