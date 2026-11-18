//! 계단 run 자동 정지 감시 — 받은 배치를 ingest와 같은 규칙으로 걸러 누적기에 쌓는다.
//! 수신 쪽(중복·타당성·시작 시각 전 보류 행)과 데이터 완결·계단 단위 포화 판정(spec §4.4)을 맡는다.

use std::collections::{BTreeMap, BTreeSet};

use handicap_engine::percentiles::decode_hdr;
use handicap_proto::v1 as pb;
use hdrhistogram::Histogram;
use tracing::warn;

use crate::auto_stop::{StopInfo, StopKind, saturation_stop};
use crate::grpc::coordinator::{plausible_second, plausible_start};
use crate::stair::{Bound, SaturationStopMode, StairAccumulator, StairConfig, judge};

/// 시작 시각 전 보류 행 버퍼 상한 — 초 단위.
pub const PENDING_MAX_SECONDS: usize = 30;

/// coordinator가 감시 채널로 보내는 메시지. 배치는 소유권째 옮겨 받는다(HDR 복사 없음, spec §4.5) — 그래서 상자에 넣지 않는다.
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
    cfg: StairConfig,
    /// 전체 계단 길이(ms) — 시간 기준 끝 계산용.
    total_ms: i64,
    acc: StairAccumulator,
    pub expected: u32,
    workers: BTreeMap<String, WorkerState>,
    shares: BTreeMap<String, Vec<u32>>,
    pub ended: BTreeSet<String>,
    /// 판정에 넣은 계단 수(앞에서부터 이어진 완결 계단).
    judged: usize,
    /// 시간 기준 끝 전에 end-phase를 보고한 워커가 있다 — 이후 포화 판정 없음.
    frozen: bool,
    /// 포화 정지를 이미 냈다.
    saturation_stopped: bool,
}

impl StairMonitor {
    /// `cfg`는 `monitor_wanted`를 통과한 설정.
    pub fn new(cfg: &StairConfig, expected: u32) -> Self {
        let step_ms = i64::from(cfg.ramp_seconds + cfg.hold_seconds) * 1000;
        Self {
            cfg: cfg.clone(),
            total_ms: step_ms.saturating_mul(cfg.targets.len() as i64),
            acc: StairAccumulator::new(cfg, false),
            expected,
            workers: BTreeMap::new(),
            shares: BTreeMap::new(),
            ended: BTreeSet::new(),
            judged: 0,
            frozen: false,
            saturation_stopped: false,
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
                // 시간 기준 끝 전 end-phase(데이터셋 소진 등) = 설정한 부하가 아니다 → 포화 판정 동결.
                let natural = self
                    .workers
                    .get(&worker_id)
                    .is_some_and(|st| self.reached_end(st));
                if !natural {
                    self.frozen = true;
                }
                self.ended.insert(worker_id);
            }
        }
        Outcome {
            stop: self.judge_steps(now_ms),
            newly_suspended: 0,
        }
    }

    /// 판정에 넣은 마지막 계단(없으면 −1).
    pub fn judged_through(&self) -> i64 {
        self.judged as i64 - 1
    }

    /// 수위가 그 워커의 시간 기준 끝(`floor((t0 + 전체 계단)/1000) − 1`)에 닿았나.
    fn reached_end(&self, st: &WorkerState) -> bool {
        let Some(t0) = st.t0_ms else {
            return false;
        };
        let end = t0.saturating_add(self.total_ms).div_euclid(1000) - 1;
        st.level.is_some_and(|l| l >= end)
    }

    /// 끝난 워커: 시간 기준 끝에 닿았거나 end-phase를 보고했다 — 이후 모든 초·계단 완결.
    fn finished(&self, w: &str, st: &WorkerState) -> bool {
        self.ended.contains(w) || self.reached_end(st)
    }

    /// 워커 `w`에서 계단 `i`의 데이터가 다 왔나: 수위 ≥ 측정 끝 초 ∧ (스케줄 증거 ∨ 몫 0).
    fn step_complete_for(&self, w: &str, st: &WorkerState, i: usize) -> bool {
        if self.finished(w, st) {
            return true;
        }
        let Some((_, hi)) = self.acc.window(w, i) else {
            return false;
        };
        let last = hi - 1;
        let level_ok = st.level.is_some_and(|l| l >= last);
        let evidence = st.max_scheduled.is_some_and(|s| s >= last)
            || self.shares.get(w).and_then(|s| s.get(i)) == Some(&0);
        level_ok && evidence
    }

    /// 계단 `i`가 모든 워커에서 완결인가. 시작 시각을 보낸 워커가 `expected`보다 적으면 판정 안 함.
    fn step_complete(&self, i: usize) -> bool {
        let mut registered = 0u32;
        for (w, st) in &self.workers {
            if st.t0_ms.is_none() {
                continue;
            }
            registered += 1;
            if !self.step_complete_for(w, st, i) {
                return false;
            }
        }
        registered > 0 && registered >= self.expected
    }

    /// 새로 완결된 계단을 한 계단씩 판정한다(첫 정지에서 멈춤). 판정한 계단은 계수를 해제한다.
    fn judge_steps(&mut self, now_ms: i64) -> Option<StopInfo> {
        if self.frozen || self.saturation_stopped {
            return None;
        }
        let n = self.cfg.targets.len();
        let mode = self.cfg.auto_stop.as_ref().and_then(|a| a.saturation);
        while self.judged < n && self.step_complete(self.judged) {
            let i = self.judged;
            let stop = mode.and_then(|mode| {
                let done: Vec<bool> = (0..n).map(|k| k <= i).collect();
                let nums = self.acc.numbers(&done, false);
                let j = judge(&nums, &self.cfg);
                saturation_stop(&j, &done, mode).map(|s| (mode, s))
            });
            self.acc.release_step(i, false);
            self.judged = i + 1;
            if let Some((mode, s)) = stop {
                self.saturation_stopped = true;
                return Some(saturation_info(mode, &s, now_ms));
            }
        }
        None
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

fn saturation_info(
    mode: SaturationStopMode,
    s: &crate::auto_stop::SaturationStop,
    now_ms: i64,
) -> StopInfo {
    StopInfo {
        kind: StopKind::Saturation,
        mode: Some(mode),
        failed_steps: s.failed_steps.iter().map(|&i| i as u32).collect(),
        decided_step: s.decided_step as u32,
        // saturation 기록은 정의상 판정 계단까지 판정에 넣었다(spec §4.4).
        judged_through: s.decided_step as i64,
        phase: None,
        decided_at_ms: now_ms,
        stopped_at_ms: 0,
        emergency: None,
        slot_limited: s.slot_limited,
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
    /// 판정에 쓴 계단 숫자(해제된 계단은 캐시값).
    fn judged_numbers(&self) -> Vec<crate::stair::StepNumbers> {
        let n = self.cfg.targets.len();
        let mut v = self.acc.numbers(&vec![true; n], false);
        v.truncate(self.judged);
        v
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
        // t0를 과거로 이틀 — 시작 시각은 30일까지 허용, open-loop 초 필터(하루)는 넘는다.
        let far = T0 - 2 * 86_400;
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

    // ── 데이터 완결·계단 단위 포화 판정 ──────────────────────────────────
    // ramp 1 · hold 20 · discard 5 → 계단 길이 21초. t0 = T0 정각이면 계단 i 측정 초 =
    // [T0+21i+6, T0+21i+21), 마지막 측정 초 = `end(i)`. 5계단 전체 105초.

    use crate::auto_stop::StopKind;
    use crate::stair::{
        AutoStopConfig, HeadlineKind, SaturationStopMode, StairInputs, StepNumbers,
        build_stair_report, judge,
    };
    use crate::store::metrics::WindowWithHdr;
    use crate::store::open_loop::{OpenLoopSecondRow, WorkerStartRow};
    use SaturationStopMode::{FirstFail, TwoFails};

    const STEP: i64 = 21;
    const NOW2: i64 = (T0 + 300) * 1000;
    const T0MS: i64 = T0 * 1000;

    fn cfg5(mode: Option<SaturationStopMode>) -> StairConfig {
        StairConfig {
            targets: vec![10, 20, 30, 40, 50],
            hold_seconds: 20,
            ramp_seconds: 1,
            discard_seconds: 5,
            p99_cap_ms: None,
            auto_stop: Some(AutoStopConfig {
                saturation: mode,
                emergency: None,
            }),
        }
    }

    fn end(i: i64) -> i64 {
        T0 + STEP * i + STEP - 1
    }

    #[derive(Clone, Copy)]
    struct Sec {
        launched: u64,
        completed: u64,
        count: u64,
        errors: u64,
        p99_us: u64,
    }
    const OK: Sec = Sec {
        launched: 60,
        completed: 60,
        count: 60,
        errors: 0,
        p99_us: 2000,
    };
    const ERR: Sec = Sec { errors: 30, ..OK };
    const SLOW: Sec = Sec {
        p99_us: 100_000,
        ..OK
    };
    /// 기준 계단 p99 2000 µs면 한도 6000 µs 안(정상), 기준이 0이면 한도 5000 µs 넘음(실패).
    const MID: Sec = Sec { p99_us: 5500, ..OK };
    /// 소진 뒤 완료 꼬리: 도착 없음, 늦게 끝난 요청만.
    const TAIL: Sec = Sec {
        launched: 0,
        completed: 5,
        count: 5,
        errors: 5,
        p99_us: 900_000,
    };
    /// 0행 채우기(도착 없음).
    const IDLE: Sec = Sec {
        launched: 0,
        completed: 0,
        count: 0,
        errors: 0,
        p99_us: 0,
    };

    /// 계단별 값(t0 = T0 기준).
    fn steps(v: &'static [Sec]) -> impl Fn(i64) -> Sec {
        move |ts| v[(((ts - T0) / STEP) as usize).min(v.len() - 1)]
    }

    /// 초 [from, to]를 한 배치로.
    fn span(w: &str, t0_ms: i64, from: i64, to: i64, f: impl Fn(i64) -> Sec) -> MonitorMsg {
        let secs: Vec<(i64, Sec)> = (from..=to).map(|ts| (ts, f(ts))).collect();
        let ol: Vec<_> = secs
            .iter()
            .map(|&(ts, s)| (ts, s.launched, s.completed, 0))
            .collect();
        let win: Vec<_> = secs
            .iter()
            .filter(|(_, s)| s.count > 0)
            .map(|&(ts, s)| (ts, s.count, s.errors, s.p99_us))
            .collect();
        batch(w, t0_ms, &ol, &win)
    }

    fn ended(w: &str) -> MonitorMsg {
        MonitorMsg::WorkerEnded {
            worker_id: w.into(),
        }
    }

    #[test]
    fn late_worker_blocks_judging_then_judges() {
        let mut m = StairMonitor::new(&cfg5(Some(TwoFails)), 2);
        assert!(
            m.on_msg(span("w0", T0MS, T0, end(1), |_| OK), NOW2)
                .stop
                .is_none()
        );
        assert!(
            m.on_msg(span("w1", T0MS, T0, T0 + 2, |_| OK), NOW2)
                .stop
                .is_none()
        );
        assert_eq!(m.judged_through(), -1);
        m.on_msg(span("w1", T0MS, T0 + 3, end(1), |_| OK), NOW2);
        assert_eq!(m.judged_through(), 1);
    }

    #[test]
    fn registration_shortfall_no_judging() {
        let mut m = StairMonitor::new(&cfg5(Some(TwoFails)), 2);
        let f = steps(&[OK, ERR, ERR, OK, OK]);
        assert!(
            m.on_msg(span("w0", T0MS, T0, end(3), &f), NOW2)
                .stop
                .is_none()
        );
        // w1은 시작 시각을 아직 안 보냄 — 행은 보류 버퍼에.
        assert!(
            m.on_msg(span("w1", 0, T0, T0 + 20, &f), NOW2)
                .stop
                .is_none()
        );
        assert_eq!(m.judged_through(), -1);
    }

    #[test]
    fn two_fails_stops_at_pair() {
        let mut m = StairMonitor::new(&cfg5(Some(TwoFails)), 2);
        let f = steps(&[OK, OK, SLOW, SLOW, OK]);
        assert!(
            m.on_msg(span("w0", T0MS, T0, end(3), &f), NOW2)
                .stop
                .is_none()
        );
        assert!(
            m.on_msg(span("w1", T0MS, T0, end(2), &f), NOW2)
                .stop
                .is_none()
        );
        assert_eq!(m.judged_through(), 2);
        let stop = m
            .on_msg(span("w1", T0MS, end(2) + 1, end(3), &f), NOW2)
            .stop
            .expect("계단 3 완결에서 정지");
        assert_eq!(stop.kind, StopKind::Saturation);
        assert_eq!(stop.mode, Some(TwoFails));
        assert_eq!(stop.failed_steps, vec![2, 3]);
        assert_eq!(stop.decided_step, 3);
        assert_eq!(stop.judged_through, 3);
        assert_eq!(stop.phase, None);
        assert_eq!(stop.emergency, None);
        assert_eq!(stop.decided_at_ms, NOW2);
        assert_eq!(stop.stopped_at_ms, 0);
        assert!(!stop.slot_limited);
        assert_eq!(m.judged_through(), 3);
    }

    #[test]
    fn first_fail_stops_and_judged_through_is_decided() {
        let mut m = StairMonitor::new(&cfg5(Some(FirstFail)), 2);
        let f = steps(&[OK, OK, ERR, OK, OK]);
        m.on_msg(span("w0", T0MS, T0, end(2), &f), NOW2);
        let stop = m
            .on_msg(span("w1", T0MS, T0, end(2), &f), NOW2)
            .stop
            .expect("계단 2 완결에서 정지");
        assert_eq!(stop.failed_steps, vec![2]);
        assert_eq!(stop.decided_step, 2);
        assert_eq!(stop.judged_through, 2);
        assert_eq!(m.judged_through(), 2);
        // 정지 뒤에는 더 판정하지 않는다.
        assert!(
            m.on_msg(span("w0", T0MS, end(2) + 1, end(3), &f), NOW2)
                .stop
                .is_none()
        );
        assert!(
            m.on_msg(span("w1", T0MS, end(2) + 1, end(3), &f), NOW2)
                .stop
                .is_none()
        );
        assert_eq!(m.judged_through(), 2);
    }

    #[test]
    fn one_message_completes_two_steps_first_fail() {
        // k = 1: 앞에 정상 계단 0이 있어야 계단 1이 Spike가 될 수 있다.
        let c = cfg5(Some(FirstFail));
        let mut m = StairMonitor::new(&c, 2);
        let f = steps(&[OK, ERR, OK, OK, OK]);
        m.on_msg(span("w0", T0MS, T0, end(3), &f), NOW2);
        assert!(
            m.on_msg(span("w1", T0MS, T0, end(0), &f), NOW2)
                .stop
                .is_none()
        );
        assert_eq!(m.judged_through(), 0);
        // 늦던 w1의 한 배치가 계단 1(실패)과 2(정상)를 함께 완결한다.
        let stop = m
            .on_msg(span("w1", T0MS, end(0) + 1, end(2), &f), NOW2)
            .stop
            .expect("계단 1에서 정지");
        assert_eq!(stop.failed_steps, vec![1]);
        assert_eq!(stop.judged_through, 1);
        assert_eq!(m.judged_through(), 1);
        // 리포트 §5.1 강제(judged_through 뒤 계단 measured=false)로 「포화 확인 못 함」이 남는다.
        let mut nums = m.acc().numbers(&[true, true, true, false, false], false);
        for (i, n) in nums.iter_mut().enumerate() {
            if i as i64 > stop.judged_through {
                n.measured = false;
            }
        }
        assert_eq!(judge(&nums, &c).headline, HeadlineKind::Unconfirmed);
    }

    /// w0: t0 = T0·1000 + 300 ms, 시간 기준 끝 = floor((t0 + 105 s)/1000) − 1 = T0 + 104.
    /// 마지막 초는 0행(엔진 `end_s`가 마감 초보다 1 작음) — 스케줄 증거는 T0 + 103까지.
    fn boundary_run(w0_last: i64) -> StairMonitor {
        let mut m = StairMonitor::new(&cfg5(Some(TwoFails)), 2);
        let w0_t0 = T0MS + 300;
        assert_eq!((w0_t0 + 105_000).div_euclid(1000) - 1, T0 + 104);
        m.on_msg(span("w1", T0MS, T0, end(4), |_| OK), NOW2);
        m.on_msg(
            span("w0", w0_t0, T0, w0_last, |ts| {
                if ts >= T0 + 104 { IDLE } else { OK }
            }),
            NOW2,
        );
        m
    }

    #[test]
    fn finished_worker_boundary_minus_one() {
        // 수위 = 끝 − 1 → 끝난 워커 → 마지막 계단도 완결.
        assert_eq!(boundary_run(T0 + 104).judged_through(), 4);
        // 수위 = 끝 − 2 → 아직 아님.
        assert_eq!(boundary_run(T0 + 103).judged_through(), 3);
    }

    #[test]
    fn end_phase_worker_counts_complete() {
        let mut m = StairMonitor::new(&cfg5(Some(TwoFails)), 2);
        let f = steps(&[OK, ERR, ERR, OK, OK]);
        // w0: 시간 기준 끝(T0 + 104)까지 보내고 end-phase 보고 — 자연 종료라 동결 아님.
        m.on_msg(
            span("w0", T0MS, T0, T0 + 104, |ts| {
                if ts == T0 + 104 { IDLE } else { f(ts) }
            }),
            NOW2,
        );
        assert!(m.on_msg(ended("w0"), NOW2).stop.is_none());
        // 늦던 w1이 따라잡으면 판정이 진행된다.
        let stop = m
            .on_msg(span("w1", T0MS, T0, end(2), &f), NOW2)
            .stop
            .expect("자연 종료 워커는 판정을 막지 않는다");
        assert_eq!(stop.failed_steps, vec![1, 2]);
        assert_eq!(m.judged_through(), 2);
    }

    #[test]
    fn early_end_phase_freezes_saturation() {
        let mut m = StairMonitor::new(&cfg5(Some(TwoFails)), 2);
        m.on_msg(span("w0", T0MS, T0, end(0), |_| OK), NOW2);
        m.on_msg(span("w1", T0MS, T0, end(0), |_| OK), NOW2);
        assert_eq!(m.judged_through(), 0);
        // w1: 계단 1 측정 [T0+27, T0+42) 중 T0+37까지 11초(절반 넘게) 측정 후 데이터셋 소진,
        // 완료 꼬리 3초, 그리고 시간 기준 끝 전에 end-phase.
        m.on_msg(span("w1", T0MS, end(0) + 1, T0 + 37, |_| OK), NOW2);
        m.on_msg(span("w1", T0MS, T0 + 38, T0 + 40, |_| TAIL), NOW2);
        assert!(m.on_msg(ended("w1"), NOW2).stop.is_none());
        // w0 쪽 숫자는 연속 실패처럼 보인다 — 그래도 포화 정지 없음.
        let o = m.on_msg(
            span(
                "w0",
                T0MS,
                end(0) + 1,
                end(3),
                steps(&[OK, ERR, ERR, ERR, OK]),
            ),
            NOW2,
        );
        assert!(o.stop.is_none());
        assert_eq!(m.judged_through(), 0);
    }

    #[test]
    fn schedule_evidence_blocks_tail_completion() {
        let mut m = StairMonitor::new(&cfg5(Some(FirstFail)), 2);
        m.on_msg(span("w0", T0MS, T0, end(1), |_| OK), NOW2);
        m.on_msg(span("w1", T0MS, T0, T0 + 37, |_| OK), NOW2);
        assert_eq!(m.judged_through(), 0);
        // 꼬리가 계단 1 측정 끝(T0+41)을 넘는다 — 수위는 충족, 스케줄 증거는 T0+37.
        let o = m.on_msg(span("w1", T0MS, T0 + 38, T0 + 43, |_| TAIL), NOW2);
        assert_eq!(m.level("w1"), Some(T0 + 43));
        assert!(o.stop.is_none());
        assert_eq!(m.judged_through(), 0);
    }

    #[test]
    fn zero_share_worker_completes_without_evidence() {
        const ONE: Sec = Sec {
            launched: 1,
            completed: 1,
            count: 1,
            errors: 0,
            p99_us: 2000,
        };
        let run = |with_share: bool| {
            let mut m = StairMonitor::new(&cfg5(Some(TwoFails)), 2);
            if with_share {
                m.on_msg(
                    MonitorMsg::Worker {
                        worker_id: "w1".into(),
                        step_targets: vec![1, 0, 1, 1, 1],
                    },
                    NOW2,
                );
            }
            m.on_msg(span("w0", T0MS, T0, end(1), |_| OK), NOW2);
            m.on_msg(span("w1", T0MS, T0, end(1), steps(&[ONE, IDLE])), NOW2);
            m.judged_through()
        };
        assert_eq!(run(true), 1);
        // 몫을 모르면 증거가 필요하다.
        assert_eq!(run(false), 0);
    }

    #[test]
    fn release_keeps_numbers_for_prev_ok() {
        let mut m = StairMonitor::new(&cfg5(Some(FirstFail)), 1);
        // 같은 행을 받되 등록 미달(expected 2)이라 판정·해제를 안 하는 비교용 감시.
        let mut unjudged = StairMonitor::new(&cfg5(Some(FirstFail)), 2);
        let f = steps(&[OK, MID, OK, OK, OK]);
        m.on_msg(span("w", T0MS, T0, end(0), &f), NOW2);
        unjudged.on_msg(span("w", T0MS, T0, end(0), &f), NOW2);
        assert_eq!(m.judged_through(), 0);
        assert_eq!(unjudged.judged_through(), -1);
        let before = unjudged.acc().numbers(&[true; 5], false)[0].clone();
        assert_eq!(m.acc().numbers(&[true; 5], false)[0], before);
        // 계단 1 p99 5500 µs는 계단 0 p99(2000 µs) 기준 한도 6000 µs 안 — 정상.
        assert!(
            m.on_msg(span("w", T0MS, end(0) + 1, end(1), &f), NOW2)
                .stop
                .is_none()
        );
        assert_eq!(m.judged_through(), 1);
    }

    #[test]
    fn monitor_matches_report_for_completed_steps() {
        let c = cfg5(None);
        // 시작 시각이 어긋난 두 워커, 스텝 2개, 초마다 다른 값.
        let t0s = [("w0", T0MS + 300), ("w1", T0MS + 2700)];
        let mut rows: Vec<WindowWithHdr> = Vec::new();
        let mut ol: Vec<OpenLoopSecondRow> = Vec::new();
        let mut m = StairMonitor::new(&c, 2);
        let last = T0 + 108;
        for chunk in (T0..=last).step_by(5) {
            for (wi, &(w, t0)) in t0s.iter().enumerate() {
                let mut b = pb::MetricBatch {
                    run_id: "R".into(),
                    worker_id: w.into(),
                    open_loop_started_at_ms: t0,
                    ..Default::default()
                };
                for ts in chunk..=(chunk + 4).min(last) {
                    let k = ts + wi as i64 * 7;
                    let (l, cpl, d) = (40 + (k * 7 % 13), 40 + (k * 7 % 13) - k % 3, k % 17 / 16);
                    b.open_loop_seconds.push(pb::OpenLoopSecond {
                        ts_second: ts,
                        launched: l as u64,
                        completed: cpl as u64,
                        dropped: d as u64,
                    });
                    ol.push(OpenLoopSecondRow {
                        worker_id: w.into(),
                        ts_second: ts,
                        launched: l,
                        completed: cpl,
                        dropped: d,
                    });
                    for (si, step) in ["a", "b"].iter().enumerate() {
                        let count = 20 + (k + si as i64) % 5;
                        let errors = if (k + si as i64) % 11 == 0 { 2 } else { 0 };
                        let h = hdr(1000 + ((k * 37 + si as i64 * 101) % 5000) as u64);
                        b.windows.push(pb::MetricWindow {
                            ts_second: ts,
                            step_id: (*step).into(),
                            count: count as u64,
                            error_count: errors as u64,
                            hdr_histogram: h.clone(),
                            status_counts: Default::default(),
                        });
                        rows.push(WindowWithHdr {
                            ts_second: ts,
                            step_id: (*step).into(),
                            worker_id: w.into(),
                            count,
                            error_count: errors,
                            status_counts: "{}".into(),
                            hdr_histogram: h,
                        });
                    }
                }
                m.on_msg(MonitorMsg::Batch(b), NOW2);
            }
        }
        assert_eq!(m.judged_through(), 4);
        let mut profile: crate::store::runs::Profile =
            serde_json::from_value(serde_json::json!({"duration_seconds": 0, "max_in_flight": 50}))
                .unwrap();
        profile.stair = Some(c);
        let inp = StairInputs {
            open_loop: ol,
            starts: t0s
                .iter()
                .map(|&(w, ms)| WorkerStartRow {
                    worker_id: w.into(),
                    started_at_ms: ms,
                })
                .collect(),
        };
        let rep = build_stair_report(&profile, 0, &rows, &inp).unwrap();
        let mon: Vec<StepNumbers> = m.judged_numbers();
        assert_eq!(mon.len(), 5);
        for (i, n) in mon.iter().enumerate() {
            let s = &rep.steps[i];
            assert_eq!(n.achieved, s.achieved, "step {i} achieved");
            assert_eq!(n.dropped, s.dropped, "step {i} dropped");
            assert_eq!(n.error_rate, s.error_rate, "step {i} error_rate");
            assert_eq!(n.p99_us, s.p99_us, "step {i} p99");
        }
        assert!(mon.iter().any(|n| n.dropped.unwrap() > 0));
        assert!(mon.iter().any(|n| n.error_rate > 0.0));
    }
}
