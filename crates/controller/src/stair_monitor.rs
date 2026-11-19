//! 계단 run 자동 정지 감시 — 받은 배치를 ingest와 같은 규칙으로 걸러 누적기에 쌓는다.
//! 수신 쪽(중복·타당성·시작 시각 전 보류 행)과 데이터 완결·계단 단위 포화 판정(spec §4.4),
//! 절대 초 단위 즉시 정지(spec §4.2(b))를 맡는다.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use handicap_engine::percentiles::{decode_hdr, merge_into};
use handicap_proto::v1 as pb;
use hdrhistogram::Histogram;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::auto_stop::{
    EmergencyHit, EmergencyStats, EmergencyTracker, StopInfo, StopKind, saturation_stop,
};
use crate::grpc::coordinator::{CoordinatorState, plausible_second, plausible_start};
use crate::stair::{
    BandKind, Bound, Judgement, SaturationStopMode, StairAccumulator, StairConfig, judge,
};
use crate::stair_live::{EmergencyNow, LiveInputs, LiveState, build_live};

/// 시작 시각 전 보류 행 버퍼 상한 — 초 단위.
pub const PENDING_MAX_SECONDS: usize = 30;

/// 즉시 정지용 초 버퍼 상한 — 넘으면 가장 오래된 초부터 판정 없이 버리고 보류로 센다.
pub const SECOND_BUFFER_MAX: usize = 30;

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

/// 감시 채널 송신 쪽 — 무제한이라 보내는 쪽이 막히거나 버리지 않는다(spec §4.5).
/// 큐 길이(보냈고 아직 안 받은 메시지 수)와 그 최댓값을 센다(spec §7 측정).
#[derive(Clone)]
pub struct MonitorHandle {
    tx: UnboundedSender<MonitorMsg>,
    queued: Arc<AtomicUsize>,
    queued_max: Arc<AtomicUsize>,
}

impl MonitorHandle {
    pub fn new() -> (Self, UnboundedReceiver<MonitorMsg>) {
        let (tx, rx) = unbounded_channel();
        (
            Self {
                tx,
                queued: Arc::new(AtomicUsize::new(0)),
                queued_max: Arc::new(AtomicUsize::new(0)),
            },
            rx,
        )
    }

    /// 감시 작업이 이미 끝났으면(수신자 drop) 메시지는 버려진다.
    pub fn send(&self, msg: MonitorMsg) {
        let n = self.queued.fetch_add(1, Ordering::Relaxed) + 1;
        self.queued_max.fetch_max(n, Ordering::Relaxed);
        if self.tx.send(msg).is_err() {
            self.queued.fetch_sub(1, Ordering::Relaxed);
        }
    }

    fn received(&self) {
        self.queued.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn queue_max(&self) -> usize {
        self.queued_max.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
}

/// run 하나의 감시 작업. `done`(run finalize) 취소나 정지 결정에서 끝난다.
/// 정지는 `CoordinatorState::auto_stop`으로만 실행한다(spec §4.5).
pub async fn run_monitor(
    coord: CoordinatorState,
    run_id: String,
    mut monitor: StairMonitor,
    mut rx: UnboundedReceiver<MonitorMsg>,
    done: CancellationToken,
    handle: MonitorHandle,
) {
    let mut batches: u64 = 0;
    loop {
        let msg = tokio::select! {
            biased;
            _ = done.cancelled() => break,
            m = rx.recv() => match m {
                Some(m) => m,
                // 닿지 않음 — 이 작업이 송신자 복제(`handle`)를 들고 있어 채널이 닫히지 않는다.
                // 끝은 `done` 취소나 정지 결정뿐.
                None => break,
            },
        };
        handle.received();
        if matches!(msg, MonitorMsg::Batch(_)) {
            batches += 1;
        }
        // ingest의 타당성 필터와 같은 시계(`store::now_ms`) — 차이는 큐에서 기다린 시간뿐.
        let out = monitor.on_msg(msg, crate::store::now_ms());
        if out.newly_suspended > 0 {
            coord.add_suspended(&run_id, out.newly_suspended).await;
        }
        if let Some(stop) = out.stop {
            coord.auto_stop(&run_id, stop).await;
            break;
        }
    }
    info!(
        run_id = %run_id,
        queue_max = handle.queue_max(),
        batches,
        "auto-stop monitor finished"
    );
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

/// 한 절대 초의 전 워커·전 스텝 합.
#[derive(Default)]
struct SecAcc {
    count: u64,
    errors: u64,
    hist: Option<Histogram<u64>>,
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
    /// 계수를 해제한 계단 수 — 동결·정지 뒤에도 완결되는 대로 해제한다(메모리 상한, spec §4.4).
    released: usize,
    /// 시간 기준 끝 전에 end-phase를 보고한 워커가 있다 — 이후 포화 판정 없음.
    frozen: bool,
    /// 정지(어느 쪽이든)를 이미 냈다 — 이후 정지·판정 없음.
    stopped: bool,
    /// 즉시 정지 계수기(칸이 꺼져 있으면 None — 초 버퍼도 쌓지 않는다).
    emergency: Option<EmergencyTracker>,
    /// 아직 완결 안 된 절대 초.
    secs: BTreeMap<i64, SecAcc>,
    /// 판정했거나 보류로 버린 마지막 초 — 이 초 이하의 행은 다시 쌓지 않는다.
    secs_done: Option<i64>,
    /// `judged` 계단까지 넣은 마지막 `judge` 결과(자동 정지 칸과 무관하게 계산).
    judgement: Option<Judgement>,
    /// 즉시 정지 계수기에 넣은 마지막 초.
    last_second: Option<LastSecond>,
    /// 보류로 버린 초의 누적(`Outcome.newly_suspended` 합).
    suspended_total: u32,
    /// coordinator가 `stopped_at_ms`를 채운 정지 기록.
    stop_record: Option<StopInfo>,
    /// 직전에 만든 요약의 키.
    last_key: Option<LiveKey>,
    /// metric window HDR 해석 횟수.
    #[cfg(test)]
    decodes: usize,
}

#[derive(Clone, Copy)]
struct LastSecond {
    ts: i64,
    count: u64,
    errors: u64,
    p99_us: u64,
}

/// 요약을 결정하는 값만 — 같으면 요약도 같다.
#[derive(PartialEq, Clone, Copy)]
struct LiveKey {
    judged: usize,
    current: Option<(u32, BandKind)>,
    frozen: bool,
    stopped: bool,
    stop_set: bool,
    stop_t0_ms: Option<i64>,
    last_second_ts: Option<i64>,
    streak: u32,
    held: bool,
    suspended_total: u32,
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
            released: 0,
            frozen: false,
            stopped: false,
            emergency: cfg
                .auto_stop
                .as_ref()
                .and_then(|a| a.emergency.as_ref())
                .map(EmergencyTracker::new),
            secs: BTreeMap::new(),
            secs_done: None,
            judgement: None,
            last_second: None,
            suspended_total: 0,
            stop_record: None,
            last_key: None,
            #[cfg(test)]
            decodes: 0,
        }
    }

    /// coordinator가 `stopped_at_ms`를 채운 정지 기록을 보관한다(요약의 정지 줄·정지 뒤 칩).
    pub fn set_stop(&mut self, stop: StopInfo) {
        self.stop_record = Some(stop);
    }

    /// 실행 중 요약.
    pub fn live(&self) -> LiveState {
        build_live(&LiveInputs {
            cfg: &self.cfg,
            judged: self.judged,
            judgement: self.judgement.as_ref(),
            current: self.current(),
            frozen: self.frozen,
            stopped: self.stopped,
            stop: self.stop_record.as_ref(),
            stop_t0_ms: self.stop_t0_ms(),
            emergency_now: self.emergency_now(),
            suspended_seconds: self.suspended_total,
        })
    }

    /// 직전 요약 뒤로 요약을 결정하는 값이 바뀌었을 때만 새 요약.
    pub fn live_if_changed(&mut self) -> Option<LiveState> {
        let key = self.live_key();
        if self.last_key == Some(key) {
            return None;
        }
        self.last_key = Some(key);
        Some(self.live())
    }

    fn live_key(&self) -> LiveKey {
        let shown = self.shown_second();
        LiveKey {
            judged: self.judged,
            current: self.current(),
            frozen: self.frozen,
            stopped: self.stopped,
            stop_set: self.stop_record.is_some(),
            stop_t0_ms: self.stop_t0_ms(),
            last_second_ts: shown.map(|s| s.ts),
            streak: self.emergency.as_ref().map_or(0, EmergencyTracker::streak),
            held: shown.is_some_and(|s| self.held(&s)),
            suspended_total: self.suspended_total,
        }
    }

    /// 지금 구간 — 등록이 다 차고 open-loop 초가 하나라도 왔을 때만(가장 높은 수위 기준).
    fn current(&self) -> Option<(u32, BandKind)> {
        self.registered_t0s()?;
        let level = self.workers.values().filter_map(|s| s.level).max()?;
        Some(self.band_of(level))
    }

    /// 시작 시각을 보낸 워커 중 가장 이른 t0 — 리포트 `stop_t0`(`starts` 최솟값)와 같은 규칙.
    fn stop_t0_ms(&self) -> Option<i64> {
        self.workers.values().filter_map(|s| s.t0_ms).min()
    }

    /// 즉시 정지 칸이 켜져 있을 때 계수기에 넣은 마지막 초.
    fn shown_second(&self) -> Option<LastSecond> {
        self.emergency.as_ref()?;
        self.last_second
    }

    /// 표본이 적어 판정을 보류한 초인가 — `EmergencyTracker::observe`와 같은 조건.
    fn held(&self, s: &LastSecond) -> bool {
        let min = self
            .cfg
            .auto_stop
            .as_ref()
            .and_then(|a| a.emergency.as_ref())
            .map_or(0, |e| u64::from(e.min_requests));
        s.count == 0 || s.count < min
    }

    fn emergency_now(&self) -> Option<EmergencyNow> {
        let s = self.shown_second()?;
        Some(EmergencyNow {
            error_rate: if s.count == 0 {
                0.0
            } else {
                s.errors as f64 / s.count as f64
            },
            p99_us: s.p99_us,
            bad_streak: self.emergency.as_ref().map_or(0, EmergencyTracker::streak),
            held: self.held(&s),
        })
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
        let saturation = self.judge_steps(now_ms);
        let emergency = self.judge_seconds(now_ms);
        // 같은 처리 순간 두 정지가 다 성립하면 즉시 정지가 이긴다.
        let stop = emergency.or(saturation);
        if stop.is_some() {
            self.stopped = true;
        }
        let newly_suspended = if self.stopped {
            self.secs.clear();
            0
        } else {
            self.cap_seconds()
        };
        self.suspended_total = self.suspended_total.saturating_add(newly_suspended);
        Outcome {
            stop,
            newly_suspended,
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

    /// 새로 완결된 계단을 한 계단씩 판정한다(첫 정지에서 멈춤). 완결된 계단은 계수를 해제한다 —
    /// 동결·정지 뒤에는 판정 없이 해제만 하고 `judged`는 그대로 둔다.
    fn judge_steps(&mut self, now_ms: i64) -> Option<StopInfo> {
        let n = self.cfg.targets.len();
        let mode = self.cfg.auto_stop.as_ref().and_then(|a| a.saturation);
        while self.released < n && self.step_complete(self.released) {
            let i = self.released;
            let judging = !self.frozen && !self.stopped;
            let mut stop = None;
            if judging {
                let done: Vec<bool> = (0..n).map(|k| k <= i).collect();
                let nums = self.acc.numbers(&done, false);
                let j = judge(&nums, &self.cfg);
                stop = mode.and_then(|mode| saturation_stop(&j, &done, mode).map(|s| (mode, s)));
                self.judgement = Some(j);
            }
            self.acc.release_step(i, false);
            self.released = i + 1;
            if judging {
                self.judged = i + 1;
            }
            if let Some((mode, s)) = stop {
                return Some(saturation_info(mode, &s, now_ms));
            }
        }
        None
    }

    /// 시작 시각을 보낸 워커들의 t0(등록 미달이면 None).
    fn registered_t0s(&self) -> Option<(i64, i64)> {
        let mut t0s = self.workers.values().filter_map(|st| st.t0_ms);
        let first = t0s.next()?;
        let (mut lo, mut hi, mut n) = (first, first, 1u32);
        for t0 in t0s {
            lo = lo.min(t0);
            hi = hi.max(t0);
            n += 1;
        }
        (n >= self.expected).then_some((lo, hi))
    }

    /// 초 t가 감시 범위(첫 워커 t0 ~ 마지막 워커의 마지막 계단 끝)에 드나. 등록 미달이면 모름(None).
    fn in_range(&self, t: i64) -> Option<bool> {
        let (lo, hi) = self.registered_t0s()?;
        let start = t.saturating_mul(1000);
        Some(start.saturating_add(1000) > lo && start < hi.saturating_add(self.total_ms))
    }

    /// 초 t의 데이터가 다 왔나: 등록 완료 ∧ 시작 시각을 보낸 워커마다 끝났거나 수위 ≥ t.
    fn second_complete(&self, t: i64) -> bool {
        let mut registered = 0u32;
        for (w, st) in &self.workers {
            if st.t0_ms.is_none() {
                continue;
            }
            registered += 1;
            if !(self.finished(w, st) || st.level.is_some_and(|l| l >= t)) {
                return false;
            }
        }
        registered > 0 && registered >= self.expected
    }

    /// 완결된 초를 시각 순서로 계수기에 넣는다. 첫 정지만 쓴다(계수기는 그 뒤에도 Some을 낸다).
    fn judge_seconds(&mut self, now_ms: i64) -> Option<StopInfo> {
        self.emergency.as_ref()?;
        let mut stop = None;
        while let Some(&t) = self.secs.keys().next() {
            if !self.second_complete(t) {
                break;
            }
            let Some((_, acc)) = self.secs.pop_first() else {
                break;
            };
            self.secs_done = Some(t);
            if self.stopped || stop.is_some() || self.in_range(t) != Some(true) {
                continue;
            }
            let p99 = acc.hist.as_ref().map_or(0, |h| h.value_at_quantile(0.99));
            self.last_second = Some(LastSecond {
                ts: t,
                count: acc.count,
                errors: acc.errors,
                p99_us: p99,
            });
            let hit = self
                .emergency
                .as_mut()
                .and_then(|e| e.observe(t, acc.count, acc.errors, p99));
            if let Some(hit) = hit {
                stop = Some(self.emergency_info(&hit, now_ms));
            }
        }
        stop
    }

    /// 초 버퍼가 상한을 넘으면 가장 오래된 초부터 판정 없이 버린다 — 감시 범위 밖으로 확인된 초는 세지 않는다.
    fn cap_seconds(&mut self) -> u32 {
        let mut suspended = 0;
        while self.secs.len() > SECOND_BUFFER_MAX {
            let Some((t, _)) = self.secs.pop_first() else {
                break;
            };
            self.secs_done = Some(t);
            if self.in_range(t) != Some(false) {
                suspended += 1;
                // 모르는 초는 표본 적은 보류 초와 다르다 — 「N초 연속」이 그 초를 건너뛰지 않게 끊는다.
                if let Some(e) = self.emergency.as_mut() {
                    e.reset();
                }
            }
        }
        suspended
    }

    /// 초 t 시작(`t·1000`)이 가장 이른 t0 워커 기준 어느 계단·구간인가. t0 이전이면 계단 0 상승.
    fn band_of(&self, t: i64) -> (u32, BandKind) {
        let Some((t0, _)) = self.registered_t0s() else {
            return (0, BandKind::Ramp);
        };
        let elapsed = t.saturating_mul(1000).saturating_sub(t0);
        if elapsed < 0 {
            return (0, BandKind::Ramp);
        }
        let n = self.cfg.targets.len().max(1) as i64;
        let step_ms = (i64::from(self.cfg.ramp_seconds + self.cfg.hold_seconds) * 1000).max(1);
        // 가장 이른 워커의 스케줄 끝을 넘은 꼬리 초(늦게 시작한 워커)는 마지막 계단(측정)으로 붙인다.
        let i = (elapsed / step_ms).min(n - 1);
        let within = elapsed - i * step_ms;
        let ramp_ms = i64::from(self.cfg.ramp_seconds) * 1000;
        let discard_end_ms = ramp_ms + i64::from(self.cfg.discard_seconds) * 1000;
        let kind = if within < ramp_ms {
            BandKind::Ramp
        } else if within < discard_end_ms {
            BandKind::Discard
        } else {
            BandKind::Measure
        };
        (i as u32, kind)
    }

    fn emergency_info(&self, hit: &EmergencyHit, now_ms: i64) -> StopInfo {
        let (step, phase) = self.band_of(hit.last_bad_ts);
        StopInfo {
            kind: StopKind::Emergency,
            mode: self.cfg.auto_stop.as_ref().and_then(|a| a.saturation),
            failed_steps: Vec::new(),
            decided_step: step,
            // 동결됐으면 동결값 그대로.
            judged_through: self.judged_through(),
            phase: Some(phase),
            decided_at_ms: now_ms,
            stopped_at_ms: 0,
            emergency: Some(EmergencyStats {
                max_error_rate: hit.max_error_rate,
                max_p99_us: hit.max_p99_us,
                seconds: hit.seconds,
                error_hit: hit.error_hit,
                p99_hit: hit.p99_hit,
            }),
            slot_limited: false,
        }
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
            // 즉시 정지 초 버퍼 — 판정했거나 버린 초는 다시 쌓지 않는다.
            let to_secs = self.emergency.is_some()
                && !self.stopped
                && self.secs_done.is_none_or(|d| win.ts_second > d);
            // 보류 버퍼(나중에 재생)·초 버퍼·누적기 어디에도 안 쓰이는 줄은 HDR을 해석하지 않는다 —
            // `route`해도 `push_metric`이 버리는 줄이다.
            if st.t0_ms.is_some() && !to_secs && !self.acc.accepts(w, win.ts_second) {
                continue;
            }
            #[cfg(test)]
            {
                self.decodes += 1;
            }
            let hist = decode_hdr(&win.hdr_histogram).ok().flatten();
            if to_secs {
                let sec = self.secs.entry(win.ts_second).or_default();
                sec.count = sec.count.saturating_add(win.count);
                sec.errors = sec.errors.saturating_add(win.error_count);
                if let Some(h) = &hist {
                    merge_into(sec.hist.get_or_insert_with(crate::report::fresh_hist), h);
                }
            }
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
    fn sec_buffer_len(&self) -> usize {
        self.secs.len()
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

    struct GenRun {
        m: StairMonitor,
        rows: Vec<WindowWithHdr>,
        ol: Vec<OpenLoopSecondRow>,
        starts: Vec<WorkerStartRow>,
        first_stop: Option<StopInfo>,
    }

    /// 시작 시각이 어긋난 두 워커, 스텝 2개, 초마다 다른 값을 감시에 밀어 넣고 같은 행을 DB 행으로도 모은다.
    /// `fail_from` = dropped가 생기기 시작하는 절대 초.
    fn gen_run(c: &StairConfig, fail_from: i64) -> GenRun {
        let t0s = [("w0", T0MS + 300), ("w1", T0MS + 2700)];
        let mut rows: Vec<WindowWithHdr> = Vec::new();
        let mut ol: Vec<OpenLoopSecondRow> = Vec::new();
        let mut m = StairMonitor::new(c, 2);
        let mut first_stop = None;
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
                    // dropped는 계단 3부터만 — 앞 계단은 정상, 뒤 계단은 실패로 상태가 섞인다.
                    let d = if ts >= fail_from { k % 17 / 16 } else { 0 };
                    let (l, cpl) = (40 + (k * 7 % 13), 40 + (k * 7 % 13) - k % 3);
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
                let o = m.on_msg(MonitorMsg::Batch(b), NOW2);
                if first_stop.is_none() {
                    first_stop = o.stop;
                }
            }
        }
        let starts = t0s
            .iter()
            .map(|&(w, ms)| WorkerStartRow {
                worker_id: w.into(),
                started_at_ms: ms,
            })
            .collect();
        GenRun {
            m,
            rows,
            ol,
            starts,
            first_stop,
        }
    }

    fn report_of(
        c: &StairConfig,
        g: &GenRun,
        auto_stop: Option<AutoStopRecord>,
    ) -> crate::stair::StairReport {
        let mut profile: crate::store::runs::Profile =
            serde_json::from_value(serde_json::json!({"duration_seconds": 0, "max_in_flight": 50}))
                .unwrap();
        profile.stair = Some(c.clone());
        let inp = StairInputs {
            open_loop: g.ol.clone(),
            starts: g.starts.clone(),
            auto_stop,
        };
        build_stair_report(&profile, 0, &g.rows, &inp).unwrap()
    }

    #[test]
    fn monitor_matches_report_for_completed_steps() {
        let c = cfg5(None);
        let measure_len = c.hold_seconds - c.discard_seconds;
        let GenRun {
            m,
            rows,
            ol,
            starts,
            ..
        } = gen_run(&c, T0 + 70);
        assert_eq!(m.judged_through(), 4);
        let mut profile: crate::store::runs::Profile =
            serde_json::from_value(serde_json::json!({"duration_seconds": 0, "max_in_flight": 50}))
                .unwrap();
        profile.stair = Some(c.clone());
        let inp = StairInputs {
            open_loop: ol,
            starts,
            auto_stop: None,
        };
        let rep = build_stair_report(&profile, 0, &rows, &inp).unwrap();
        let mon: Vec<StepNumbers> = m.judged_numbers();
        let mon_states = judge(&mon, &c).states;
        assert_eq!(mon.len(), 5);
        for (i, n) in mon.iter().enumerate() {
            let s = &rep.steps[i];
            assert_eq!(n.achieved, s.achieved, "step {i} achieved");
            assert_eq!(n.dropped, s.dropped, "step {i} dropped");
            assert_eq!(n.error_rate, s.error_rate, "step {i} error_rate");
            assert_eq!(n.p99_us, s.p99_us, "step {i} p99");
            // 리포트 계단엔 `measured` 칸이 없다 — 같은 규칙(2·측정 초 ≥ 유지 − 버림)을 리포트 측정 초에 적용.
            assert_eq!(
                n.measured,
                s.measured_seconds * 2 >= measure_len,
                "step {i} measured"
            );
        }
        assert!(mon.iter().any(|n| n.dropped.unwrap() > 0));
        assert!(mon.iter().any(|n| n.error_rate > 0.0));
        // 판정 상태도 같다 — 정상과 실패가 섞여 있어야 대조가 공허하지 않다(계단 0–2 정상, 3–4 dropped 실패).
        for (i, st) in mon_states.iter().enumerate() {
            assert_eq!(*st, rep.steps[i].state, "step {i} state");
        }
        let states: Vec<_> = rep.steps.iter().map(|s| s.state).collect();
        assert!(states.contains(&crate::stair::StepState::Ok));
        assert!(states.iter().any(|s| *s != crate::stair::StepState::Ok));
    }

    // ── 즉시 정지 — 초 버퍼·보류·두 정지 우선순위 ──────────────────────────
    // 기준: 오류율 5 % · p99 2000 ms · 3초 연속 · 최소 20건. ERR = 오류율 50 %(나쁜 초).

    use crate::auto_stop::EmergencyStats;
    use crate::stair::{BandKind, EmergencyStop};

    fn em() -> EmergencyStop {
        EmergencyStop {
            error_rate_pct: 5.0,
            p99_ms: 2000,
            consecutive_seconds: 3,
            min_requests: 20,
        }
    }

    fn cfg_em(mode: Option<SaturationStopMode>) -> StairConfig {
        let mut c = cfg5(mode);
        c.auto_stop.as_mut().unwrap().emergency = Some(em());
        c
    }

    /// 워커마다 (id, t0_ms, from, to, 값)을 `chunk`초씩 번갈아 보낸다. 받은 Outcome을 모은다.
    #[allow(clippy::type_complexity)]
    fn interleave(
        m: &mut StairMonitor,
        ws: &[(&str, i64, i64, i64, &dyn Fn(i64) -> Sec)],
        chunk: i64,
    ) -> Vec<Outcome> {
        let lo = ws.iter().map(|w| w.2).min().unwrap();
        let hi = ws.iter().map(|w| w.3).max().unwrap();
        let mut out = Vec::new();
        let mut c = lo;
        while c <= hi {
            for &(w, t0, from, to, f) in ws {
                let a = c.max(from);
                let b = (c + chunk - 1).min(to);
                if a <= b {
                    out.push(m.on_msg(span(w, t0, a, b, f), NOW2));
                }
            }
            c += chunk;
        }
        out
    }

    fn stops(o: &[Outcome]) -> Vec<&StopInfo> {
        o.iter().filter_map(|o| o.stop.as_ref()).collect()
    }

    fn suspended(o: &[Outcome]) -> u32 {
        o.iter().map(|o| o.newly_suspended).sum()
    }

    #[test]
    fn emergency_stops_after_n_bad_seconds() {
        let mut m = StairMonitor::new(&cfg_em(None), 1);
        assert!(
            m.on_msg(span("w", T0MS, T0, T0 + 9, |_| OK), NOW2)
                .stop
                .is_none()
        );
        assert!(
            m.on_msg(span("w", T0MS, T0 + 10, T0 + 11, |_| ERR), NOW2)
                .stop
                .is_none()
        );
        let stop = m
            .on_msg(span("w", T0MS, T0 + 12, T0 + 12, |_| ERR), NOW2)
            .stop
            .expect("나쁜 초 3개째에서 정지");
        assert_eq!(stop.kind, StopKind::Emergency);
        assert_eq!(stop.mode, None);
        assert!(stop.failed_steps.is_empty());
        // T0+12: 계단 0, 상승 1초·버림 5초 뒤 → 측정.
        assert_eq!(stop.decided_step, 0);
        assert_eq!(stop.phase, Some(BandKind::Measure));
        assert_eq!(stop.judged_through, -1);
        assert_eq!(stop.decided_at_ms, NOW2);
        assert_eq!(stop.stopped_at_ms, 0);
        assert!(!stop.slot_limited);
        assert_eq!(
            stop.emergency,
            Some(EmergencyStats {
                max_error_rate: 0.5,
                max_p99_us: 2000,
                seconds: 3,
                error_hit: true,
                p99_hit: false,
            })
        );
        // 정지는 한 번만 — 뒤이은 나쁜 초(계수기는 계속 Some)로 다시 정지하지 않는다.
        assert!(
            m.on_msg(span("w", T0MS, T0 + 13, T0 + 16, |_| ERR), NOW2)
                .stop
                .is_none()
        );
        // 한 배치 안에서도 첫 정지(3번째 나쁜 초 T0+12)만 쓴다 — 뒤 초(T0+25, 계단 1)가 덮지 않는다.
        let mut m = StairMonitor::new(&cfg_em(None), 1);
        let stop = m
            .on_msg(
                span(
                    "w",
                    T0MS,
                    T0,
                    T0 + 25,
                    |ts| if ts >= T0 + 10 { ERR } else { OK },
                ),
                NOW2,
            )
            .stop
            .expect("정지");
        assert_eq!(stop.decided_step, 0);
        assert_eq!(stop.emergency.unwrap().seconds, 3);
    }

    #[test]
    fn emergency_waits_for_slow_worker() {
        /// 오류 없는 큰 표본 — w0의 50 % 오류를 5 % 밑으로 희석한다.
        const BIG: Sec = Sec {
            launched: 1000,
            completed: 1000,
            count: 1000,
            errors: 0,
            p99_us: 2000,
        };
        let mut m = StairMonitor::new(&cfg_em(None), 2);
        m.on_msg(span("w0", T0MS, T0, T0 + 9, |_| OK), NOW2);
        m.on_msg(span("w1", T0MS, T0, T0 + 9, |_| BIG), NOW2);
        // w0만 나쁜 초 3개 — w1 수위(T0+9)가 그 초들보다 낮아 판정하지 않는다.
        assert!(
            m.on_msg(span("w0", T0MS, T0 + 10, T0 + 12, |_| ERR), NOW2)
                .stop
                .is_none()
        );
        // w1이 오면 합산 오류율 90/3060 < 5 % → 정상.
        assert!(
            m.on_msg(span("w1", T0MS, T0 + 10, T0 + 12, |_| BIG), NOW2)
                .stop
                .is_none()
        );
        m.on_msg(span("w0", T0MS, T0 + 13, T0 + 15, |_| ERR), NOW2);
        let stop = m
            .on_msg(span("w1", T0MS, T0 + 13, T0 + 15, |_| ERR), NOW2)
            .stop
            .expect("두 워커 다 나쁘면 정지");
        assert_eq!(stop.kind, StopKind::Emergency);
    }

    #[test]
    fn held_second_during_first_ramp_no_false_stop() {
        const FEW: Sec = Sec {
            launched: 3,
            completed: 3,
            count: 3,
            errors: 3,
            p99_us: 2000,
        };
        let mut m = StairMonitor::new(&cfg_em(None), 1);
        // 표본 3개뿐인 초(오류 100 %)가 10초 이어져도 보류 — 정지 없음.
        assert!(
            m.on_msg(span("w", T0MS, T0, T0 + 9, |_| FEW), NOW2)
                .stop
                .is_none()
        );
        // 판정은 살아 있다.
        assert!(
            m.on_msg(span("w", T0MS, T0 + 10, T0 + 12, |_| ERR), NOW2)
                .stop
                .is_some()
        );
    }

    #[test]
    fn buffer_over_30s_suspends_and_resumes() {
        let mut m = StairMonitor::new(&cfg_em(None), 2);
        let mut out = vec![m.on_msg(span("w1", T0MS, T0, T0, |_| OK), NOW2)];
        // w0 끝 3초가 나쁜 초.
        let w0 = |ts: i64| if ts >= T0 + 38 { ERR } else { OK };
        for (a, b) in [(T0, T0 + 9), (T0 + 10, T0 + 19), (T0 + 20, T0 + 29)] {
            out.push(m.on_msg(span("w0", T0MS, a, b, w0), NOW2));
        }
        assert_eq!(suspended(&out), 0);
        out.push(m.on_msg(span("w0", T0MS, T0 + 30, T0 + 40, w0), NOW2));
        // w1이 40초 늦다 — T0+1..T0+40 중 가장 오래된 10초를 판정 없이 버린다.
        assert_eq!(suspended(&out), 10);
        assert_eq!(m.sec_buffer_len(), 30);
        assert!(stops(&out).is_empty());
        // w1이 따라잡는다. 버린 초(T0+5..T0+7)의 나쁜 행은 다시 쌓이지 않는다.
        let w1 = |ts: i64| {
            if (T0 + 5..=T0 + 7).contains(&ts) || ts >= T0 + 38 {
                ERR
            } else {
                OK
            }
        };
        let o = m.on_msg(span("w1", T0MS, T0 + 1, T0 + 40, w1), NOW2);
        assert_eq!(o.newly_suspended, 0);
        let stop = o.stop.expect("판정 재개 — 끝 3초에서 정지");
        // T0+40: 계단 1(T0+21..), 측정 → 버린 T0+7(계단 0)이 아니다.
        assert_eq!(stop.decided_step, 1);
        assert_eq!(stop.phase, Some(BandKind::Measure));
        assert_eq!(m.sec_buffer_len(), 0);
    }

    #[test]
    fn finished_worker_does_not_hold_seconds() {
        // w1은 3초 늦게 시작 — 시간 기준 끝 w0 = T0+104, w1 = T0+107. 감시 범위 끝 = T0+107.
        let w1_t0 = T0MS + 3000;
        let w1 = |ts: i64| if ts >= T0 + 105 { ERR } else { OK };
        let ok = |_: i64| OK;

        // (a) w0가 시간 기준 끝(−1 경계)에 도달.
        let mut m = StairMonitor::new(&cfg_em(None), 2);
        let out = interleave(
            &mut m,
            &[
                ("w0", T0MS, T0, T0 + 104, &ok),
                ("w1", w1_t0, T0 + 3, T0 + 107, &w1),
            ],
            10,
        );
        assert_eq!(suspended(&out), 0);
        let s = stops(&out);
        assert_eq!(s.len(), 1, "w1 꼬리 초가 판정된다");
        assert_eq!(s[0].kind, StopKind::Emergency);
        assert_eq!(s[0].decided_step, 4);

        // (b) w0가 end-phase 보고(시간 기준 끝 전) — 포화는 동결, 즉시 정지는 계속.
        let mut m = StairMonitor::new(&cfg_em(None), 2);
        let mut out = interleave(
            &mut m,
            &[
                ("w0", T0MS, T0, T0 + 100, &ok),
                ("w1", w1_t0, T0 + 3, T0 + 100, &ok),
            ],
            10,
        );
        out.push(m.on_msg(ended("w0"), NOW2));
        out.push(m.on_msg(span("w1", w1_t0, T0 + 101, T0 + 107, w1), NOW2));
        assert_eq!(suspended(&out), 0);
        let s = stops(&out);
        assert_eq!(s.len(), 1, "끝난 w0가 w1 꼬리를 막지 않는다");
        assert_eq!(s[0].kind, StopKind::Emergency);
    }

    #[test]
    fn emergency_phase_and_step_from_earliest_t0() {
        // 상승 5 · 유지 20 · 버림 5 → 계단 25초. 이른 워커 기준 T0+50..52 = 계단 2 상승,
        // 늦은 워커(t0 +3초) 기준이면 계단 1 측정.
        let mut c = cfg_em(None);
        c.ramp_seconds = 5;
        let mut m = StairMonitor::new(&c, 2);
        let f = |ts: i64| if ts >= T0 + 50 { ERR } else { OK };
        let out = interleave(
            &mut m,
            &[
                ("w0", T0MS, T0, T0 + 52, &f),
                ("w1", T0MS + 3000, T0 + 3, T0 + 52, &f),
            ],
            10,
        );
        let s = stops(&out);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].decided_step, 2);
        assert_eq!(s[0].phase, Some(BandKind::Ramp));
    }

    #[test]
    fn emergency_records_judged_through_at_decision() {
        let mut m = StairMonitor::new(&cfg_em(Some(TwoFails)), 1);
        assert!(
            m.on_msg(span("w", T0MS, T0, end(1), |_| OK), NOW2)
                .stop
                .is_none()
        );
        assert_eq!(m.judged_through(), 1);
        // T0+45..47: 계단 2(T0+42..) 상승 1초 뒤 버림 구간.
        let stop = m
            .on_msg(
                span("w", T0MS, end(1) + 1, T0 + 47, |ts| {
                    if ts >= T0 + 45 { ERR } else { OK }
                }),
                NOW2,
            )
            .stop
            .expect("즉시 정지");
        assert_eq!(stop.kind, StopKind::Emergency);
        assert_eq!(stop.mode, Some(TwoFails));
        assert_eq!(stop.decided_step, 2);
        assert_eq!(stop.phase, Some(BandKind::Discard));
        assert_eq!(stop.judged_through, 1);
    }

    #[test]
    fn emergency_wins_same_message() {
        let mut m = StairMonitor::new(&cfg_em(Some(TwoFails)), 2);
        let base = steps(&[OK, OK, SLOW, SLOW, OK]);
        // 계단 3 측정 끝 3초는 나쁜 초(오류 50 %) — 계단 3도 여전히 실패.
        let f = move |ts: i64| {
            if (end(3) - 2..=end(3)).contains(&ts) {
                Sec { errors: 30, ..SLOW }
            } else {
                base(ts)
            }
        };
        let out = interleave(
            &mut m,
            &[("w0", T0MS, T0, end(2), &f), ("w1", T0MS, T0, end(2), &f)],
            10,
        );
        assert!(stops(&out).is_empty());
        assert_eq!(m.judged_through(), 2);
        assert!(
            m.on_msg(span("w0", T0MS, end(2) + 1, end(3), &f), NOW2)
                .stop
                .is_none()
        );
        // w1의 한 배치가 계단 쌍 실패(2·3)와 3번째 나쁜 초를 함께 완결한다.
        let stop = m
            .on_msg(span("w1", T0MS, end(2) + 1, end(3), &f), NOW2)
            .stop
            .expect("정지");
        assert_eq!(stop.kind, StopKind::Emergency);
        assert_eq!(stop.decided_step, 3);
        assert_eq!(stop.phase, Some(BandKind::Measure));
        assert!(stop.emergency.is_some());
        assert!(stop.failed_steps.is_empty());
    }

    #[test]
    fn emergency_continues_after_freeze() {
        let mut m = StairMonitor::new(&cfg_em(Some(TwoFails)), 2);
        let ok = |_: i64| OK;
        interleave(
            &mut m,
            &[("w0", T0MS, T0, end(0), &ok), ("w1", T0MS, T0, end(0), &ok)],
            10,
        );
        assert_eq!(m.judged_through(), 0);
        m.on_msg(span("w1", T0MS, end(0) + 1, T0 + 30, |_| OK), NOW2);
        assert!(m.on_msg(ended("w1"), NOW2).stop.is_none());
        let stop = m
            .on_msg(
                span("w0", T0MS, end(0) + 1, T0 + 40, |ts| {
                    if (T0 + 35..=T0 + 37).contains(&ts) {
                        ERR
                    } else {
                        OK
                    }
                }),
                NOW2,
            )
            .stop
            .expect("동결 뒤에도 즉시 정지");
        assert_eq!(stop.kind, StopKind::Emergency);
        assert_eq!(stop.judged_through, 0);
        assert_eq!(stop.decided_step, 1);
        assert_eq!(m.judged_through(), 0);
    }

    #[test]
    fn step_hdr_released_after_judgement() {
        let mut m = StairMonitor::new(&cfg5(Some(FirstFail)), 1);
        // 같은 행을 받되 등록 미달(expected 2)이라 판정·해제를 안 하는 비교용 감시.
        let mut unjudged = StairMonitor::new(&cfg5(Some(FirstFail)), 2);
        let f = steps(&[OK, MID, OK, OK, OK]);
        for x in [&mut m, &mut unjudged] {
            x.on_msg(span("w", T0MS, T0, end(0), &f), NOW2);
            x.on_msg(span("w", T0MS, end(0) + 1, T0 + 35, &f), NOW2);
        }
        assert_eq!(m.judged_through(), 0);
        assert!(!m.acc().step_hist_held(0), "판정 끝난 계단 HDR 해제");
        assert!(m.acc().step_hist_held(1), "진행 중 계단은 유지");
        assert!(unjudged.acc().step_hist_held(0));
        let all = [true; 5];
        assert_eq!(
            m.acc().numbers(&all, false)[0],
            unjudged.acc().numbers(&all, false)[0]
        );
    }

    #[test]
    fn freeze_still_releases_step_hdrs() {
        let mut m = StairMonitor::new(&cfg5(Some(TwoFails)), 2);
        let ok = |_: i64| OK;
        interleave(
            &mut m,
            &[("w0", T0MS, T0, end(0), &ok), ("w1", T0MS, T0, end(0), &ok)],
            10,
        );
        m.on_msg(span("w1", T0MS, end(0) + 1, T0 + 30, |_| OK), NOW2);
        m.on_msg(ended("w1"), NOW2);
        for (a, b) in [
            (end(0) + 1, end(1)),
            (end(1) + 1, end(2)),
            (end(2) + 1, T0 + 70),
        ] {
            m.on_msg(span("w0", T0MS, a, b, |_| OK), NOW2);
        }
        // 판정은 동결값, 그래도 완결된 계단 1·2의 HDR는 해제된다(메모리 상한 §4.4).
        assert_eq!(m.judged_through(), 0);
        assert!(!m.acc().step_hist_held(1));
        assert!(!m.acc().step_hist_held(2));
        assert!(m.acc().step_hist_held(3), "미완결 계단 3은 유지");
    }

    #[test]
    fn suspended_seconds_break_emergency_streak() {
        // 나쁜 초 T0+10·11 관측(연속 2) → T0+12..21은 30초 상한으로 버려짐(보류) → T0+22 나쁜 초.
        // 가운데 10초는 모르는 초라 연속이 아니다 — T0+22에서 정지하면 안 된다.
        let bad = [10, 11, 22, 40, 41, 42];
        let f = move |ts: i64| if bad.contains(&(ts - T0)) { ERR } else { OK };
        let mut m = StairMonitor::new(&cfg_em(None), 2);
        let out = interleave(
            &mut m,
            &[("w0", T0MS, T0, T0 + 11, &f), ("w1", T0MS, T0, T0 + 11, &f)],
            10,
        );
        assert!(stops(&out).is_empty());
        let o = m.on_msg(span("w0", T0MS, T0 + 12, T0 + 51, f), NOW2);
        assert_eq!(o.newly_suspended, 10);
        assert!(
            m.on_msg(span("w1", T0MS, T0 + 12, T0 + 30, f), NOW2)
                .stop
                .is_none(),
            "버린 초를 사이에 둔 나쁜 초는 이어 세지 않는다"
        );
        let stop = m
            .on_msg(span("w1", T0MS, T0 + 31, T0 + 51, f), NOW2)
            .stop
            .expect("새 나쁜 초 3개에서 정지");
        assert_eq!(stop.emergency.unwrap().seconds, 3);
        // T0+42: 계단 2 첫 초 → 상승.
        assert_eq!(stop.decided_step, 2);
        assert_eq!(stop.phase, Some(BandKind::Ramp));
    }

    // ── 실행 중 요약(c) ──────────────────────────────────────────────────

    use crate::auto_stop::AutoStopRecord;
    use crate::stair_live::{LiveStepState, live_step_state};

    #[test]
    fn decode_skipped_outside_use() {
        // 계단 0 전체 초(상승 1 + 버림 5 + 측정 15)의 window 하나씩, t0 = 초 경계.
        let feed = |c: &StairConfig| {
            let mut m = StairMonitor::new(c, 1);
            m.on_msg(span("w", T0MS, T0, end(0), |_| OK), NOW2);
            m.decodes
        };
        assert_eq!(feed(&cfg5(None)), 15, "즉시 정지 끔: 측정 초만");
        assert_eq!(
            feed(&cfg_em(None)),
            21,
            "즉시 정지 켬: 초 버퍼로 가는 줄 전부"
        );
        // 시작 시각을 아직 안 보낸 워커의 줄은 보류 버퍼로 간다(나중에 재생) — 해석한다.
        let mut m = StairMonitor::new(&cfg5(None), 1);
        m.on_msg(span("w", 0, T0, T0 + 2, |_| OK), NOW2);
        assert_eq!(m.decodes, 3);
        // 해제된 계단의 늦은 줄: open-loop 초만으로 계단 0을 완결·해제한 뒤 window 하나.
        let mut m = StairMonitor::new(&cfg5(None), 1);
        let ol: Vec<_> = (T0..=end(0)).map(|ts| (ts, 60, 60, 0)).collect();
        m.on_msg(batch("w", T0MS, &ol, &[]), NOW2);
        assert_eq!(m.judged_through(), 0);
        assert_eq!(m.decodes, 0);
        m.on_msg(batch("w", T0MS, &[], &[(T0 + 10, 60, 0, 2000)]), NOW2);
        assert_eq!(m.decodes, 0, "해제된 계단의 늦은 줄은 해석하지 않는다");
    }

    fn stop_fixture() -> StopInfo {
        StopInfo {
            kind: StopKind::Saturation,
            mode: Some(TwoFails),
            failed_steps: vec![0],
            decided_step: 0,
            judged_through: 0,
            phase: None,
            decided_at_ms: NOW2,
            stopped_at_ms: NOW2 + 20,
            emergency: None,
            slot_limited: false,
        }
    }

    #[test]
    fn live_if_changed_only_on_change() {
        let mut m = StairMonitor::new(&cfg5(None), 1);
        m.on_msg(span("w", T0MS, T0, T0 + 5, |_| OK), NOW2);
        let l = m.live_if_changed().expect("첫 요약");
        assert_eq!(
            (l.current_step, l.phase),
            (Some(0), Some(BandKind::Discard))
        );
        // 계단 0 안의 구간 변화(버림 → 측정) — 판정 계단 수는 그대로.
        m.on_msg(span("w", T0MS, T0 + 6, T0 + 7, |_| OK), NOW2);
        let l = m.live_if_changed().expect("구간 변화");
        assert_eq!(
            (l.current_step, l.phase),
            (Some(0), Some(BandKind::Measure))
        );
        assert_eq!(m.judged_through(), -1);
        m.on_msg(span("w", T0MS, T0 + 8, T0 + 8, |_| OK), NOW2);
        let _ = m.live_if_changed();
        m.on_msg(span("w", T0MS, T0 + 9, T0 + 9, |_| OK), NOW2);
        assert!(m.live_if_changed().is_none(), "바뀐 것 없음");
        let s = stop_fixture();
        m.set_stop(s.clone());
        let l = m.live_if_changed().expect("정지 기록");
        assert_eq!(l.stop, Some(s));

        // 즉시 정지 현재값: 같은 구간에서 정상 초(streak 0·held false 그대로)가 하나씩 늘 때마다.
        let mut m = StairMonitor::new(&cfg_em(None), 1);
        m.on_msg(span("w", T0MS, T0, T0 + 9, |_| OK), NOW2);
        let _ = m.live_if_changed();
        m.on_msg(span("w", T0MS, T0 + 10, T0 + 10, |_| OK), NOW2);
        let e = m
            .live_if_changed()
            .expect("새 판정 초")
            .emergency_now
            .unwrap();
        assert_eq!((e.bad_streak, e.held), (0, false));
        m.on_msg(span("w", T0MS, T0 + 11, T0 + 11, |_| OK), NOW2);
        let e = m
            .live_if_changed()
            .expect("또 새 판정 초")
            .emergency_now
            .unwrap();
        assert_eq!((e.bad_streak, e.held), (0, false));
    }

    #[test]
    fn live_matches_report_for_completed_steps() {
        let c = cfg5(None);
        let g = gen_run(&c, T0 + 70);
        let rep = report_of(&c, &g, None);
        let live = g.m.live();
        assert_eq!(live.step_states.len(), 5);
        for i in 0..5 {
            assert_eq!(
                live.step_states[i],
                live_step_state(rep.steps[i].state),
                "step {i}"
            );
        }
        assert!(live.step_states.contains(&LiveStepState::Ok));
        assert!(live.step_states.iter().any(|s| *s != LiveStepState::Ok));
    }

    #[test]
    fn live_matches_report_after_stop() {
        let c = cfg5(Some(TwoFails));
        let mut g = gen_run(&c, T0 + 49);
        let mut s = g.first_stop.clone().expect("정지");
        assert_eq!(s.decided_step, 3);
        s.stopped_at_ms = s.decided_at_ms + 20;
        g.m.set_stop(s.clone());
        let rep = report_of(
            &c,
            &g,
            Some(AutoStopRecord {
                stop: Some(s),
                suspended_seconds: 0,
            }),
        );
        let live = g.m.live();
        for i in 0..5 {
            assert_eq!(
                live.step_states[i],
                live_step_state(rep.steps[i].state),
                "step {i}"
            );
        }
        assert_eq!(live.step_states[4], LiveStepState::Partial);
        assert!(live.step_states[2..4].contains(&LiveStepState::Saturated));
    }

    #[test]
    fn no_auto_stop_never_stops_but_judges() {
        let c = StairConfig {
            auto_stop: None,
            ..cfg5(None)
        };
        let g = gen_run(&c, T0 + 49);
        assert_eq!(g.first_stop, None);
        let live = g.m.live();
        assert!(live.step_states.contains(&LiveStepState::Saturated));
        assert!(!live.next_fail_stops);
        assert_eq!(live.emergency_now, None);
    }

    #[test]
    fn live_current_step_and_emergency_now() {
        const LOW: Sec = Sec { count: 5, ..OK };
        let mut m = StairMonitor::new(&cfg_em(None), 1);
        // 계단 1 측정 [T0+27, T0+42) 안까지.
        m.on_msg(span("w", T0MS, T0, T0 + 30, |_| OK), NOW2);
        let l = m.live();
        assert_eq!(l.current_step, Some(1));
        assert_eq!(l.phase, Some(BandKind::Measure));
        let e = l.emergency_now.expect("판정한 초");
        assert_eq!((e.bad_streak, e.held, e.error_rate), (0, false, 0.0));
        assert!(e.p99_us > 0);
        m.on_msg(span("w", T0MS, T0 + 31, T0 + 32, |_| ERR), NOW2);
        let e = m.live().emergency_now.unwrap();
        assert_eq!((e.bad_streak, e.held, e.error_rate), (2, false, 0.5));
        // 완료 < min_requests 초 — 보류: 연속을 끊지도 늘리지도 않는다.
        m.on_msg(span("w", T0MS, T0 + 33, T0 + 33, |_| LOW), NOW2);
        let e = m.live().emergency_now.unwrap();
        assert_eq!((e.bad_streak, e.held), (2, true));
    }

    #[test]
    fn live_current_waits_for_registration() {
        let mut m = StairMonitor::new(&cfg5(None), 2);
        m.on_msg(span("w0", T0MS, T0, end(1) + 5, |_| OK), NOW2);
        let l = m.live();
        assert_eq!((l.current_step, l.phase), (None, None));
    }

    #[test]
    fn live_frozen_after_early_end() {
        let mut m = StairMonitor::new(&cfg5(Some(TwoFails)), 2);
        m.on_msg(span("w0", T0MS, T0, end(0), |_| OK), NOW2);
        m.on_msg(span("w1", T0MS, T0, end(0), |_| OK), NOW2);
        m.on_msg(span("w1", T0MS, end(0) + 1, T0 + 37, |_| OK), NOW2);
        m.on_msg(span("w1", T0MS, T0 + 38, T0 + 40, |_| TAIL), NOW2);
        m.on_msg(ended("w1"), NOW2);
        m.on_msg(
            span(
                "w0",
                T0MS,
                end(0) + 1,
                end(3),
                steps(&[OK, ERR, ERR, ERR, OK]),
            ),
            NOW2,
        );
        let l = m.live();
        assert!(l.frozen);
        assert_eq!(l.step_states[0], LiveStepState::Ok);
        assert_eq!(&l.step_states[1..], &[LiveStepState::Frozen; 4]);
    }
}

/// spec §7.1 수동 성능 측정 — 감시 배치당 처리 시간(`#[ignore]`, 게이트 밖).
#[cfg(test)]
mod perf {
    use super::*;
    use crate::report::fresh_hist;
    use crate::stair::{AutoStopConfig, EmergencyStop};
    use hdrhistogram::serialization::{Serializer, V2Serializer};
    use std::time::{Duration, Instant};

    const WORKERS: usize = 4;
    const STEPS: i64 = 50;
    const RAMP: i64 = 5;
    const HOLD: i64 = 60;
    const STEP_S: i64 = RAMP + HOLD;
    const T0: i64 = 1_000_000;

    /// 1 µs–10 s 로그 간격에 수천 표본을 기록한 실제 크기 HDR.
    fn real_hdr(seed: u64) -> Vec<u8> {
        let mut h = fresh_hist();
        let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        for _ in 0..3000 {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let frac = (x >> 11) as f64 / (1u64 << 53) as f64;
            let us = 10f64.powf(frac * 7.0).max(1.0) as u64; // 1 µs .. 10 s
            h.record(us).unwrap();
        }
        let mut b = Vec::new();
        V2Serializer::new().serialize(&h, &mut b).unwrap();
        b
    }

    /// `skew`: 마지막 워커 t0 +3 s, 세 번째 워커는 초 1000–1010분 배치가 10초 늦게 한꺼번에 도착.
    fn run(skew: bool) {
        let targets: Vec<u32> = (1..=STEPS as u32).map(|i| i * 40).collect();
        let cfg = StairConfig {
            targets: targets.clone(),
            hold_seconds: HOLD as u32,
            ramp_seconds: RAMP as u32,
            discard_seconds: 10,
            p99_cap_ms: None,
            auto_stop: Some(AutoStopConfig {
                saturation: Some(SaturationStopMode::TwoFails),
                emergency: Some(EmergencyStop {
                    error_rate_pct: 50.0,
                    p99_ms: 600_000,
                    consecutive_seconds: 60,
                    min_requests: 20,
                }),
            }),
        };
        let mut m = StairMonitor::new(&cfg, WORKERS as u32);
        let share: Vec<u32> = targets.iter().map(|t| t / WORKERS as u32).collect();
        for w in 0..WORKERS {
            m.on_msg(
                MonitorMsg::Worker {
                    worker_id: format!("w{w}"),
                    step_targets: share.clone(),
                },
                T0 * 1000,
            );
        }

        let hdrs: Vec<Vec<u8>> = (0..16).map(real_hdr).collect();
        let total_s = STEPS * STEP_S;
        // (도착 시각 ms, 순번, 메시지). 배치 = 초 2개 + 시나리오 스텝 16개 x 2초 = window 32개.
        let mut batches: Vec<(i64, usize, MonitorMsg)> = Vec::new();
        let mut seq = 0;
        let mut sec = 0;
        while sec + 1 < total_s {
            for w in 0..WORKERS {
                let off = if skew && w == WORKERS - 1 { 3 } else { 0 };
                let t0 = T0 + off;
                let mut ol = Vec::new();
                let mut windows = Vec::new();
                for ts in [t0 + sec, t0 + sec + 1] {
                    let step = (((ts - t0) / STEP_S) as usize).min(share.len() - 1);
                    let per = share[step] as u64;
                    ol.push(pb::OpenLoopSecond {
                        ts_second: ts,
                        launched: per,
                        completed: per,
                        dropped: 0,
                    });
                    for k in 0..16 {
                        windows.push(pb::MetricWindow {
                            ts_second: ts,
                            step_id: format!("s{k}"),
                            count: (per / 16).max(1),
                            error_count: 0,
                            hdr_histogram: hdrs[(ts as usize + k + w) % hdrs.len()].clone(),
                            status_counts: Default::default(),
                        });
                    }
                }
                let mut now_ms = (t0 + sec + 2) * 1000;
                if skew && w == 2 && (1000..1010).contains(&sec) {
                    now_ms = (T0 + 1010) * 1000;
                }
                batches.push((
                    now_ms,
                    seq,
                    MonitorMsg::Batch(pb::MetricBatch {
                        run_id: "R".into(),
                        worker_id: format!("w{w}"),
                        windows,
                        open_loop_seconds: ol,
                        open_loop_started_at_ms: t0 * 1000,
                        ..Default::default()
                    }),
                ));
                seq += 1;
            }
            sec += 2;
        }
        batches.sort_by_key(|b| (b.0, b.1));

        let n = batches.len();
        let mut times: Vec<Duration> = Vec::with_capacity(n);
        let mut judging: Vec<Duration> = Vec::new();
        // 복제는 측정 밖. 미리 만든 배치를 on_msg 안에서 소유권째 해제하면 한꺼번에 깔린 메모리를
        // 되돌려주는 비용(max 약 10–20 ms, 계단 경계와 무관한 고정 색인)이 들어가 실제(배치마다
        // 새로 받아 바로 해제)와 달라진다 — 진단: 복제해 넣으면 max 1.5 ms.
        for (now_ms, _, orig) in &batches {
            let msg = match orig {
                MonitorMsg::Batch(b) => MonitorMsg::Batch(b.clone()),
                _ => unreachable!(),
            };
            let now_ms = *now_ms;
            let before = m.judged_through();
            let t = Instant::now();
            let o = m.on_msg(msg, now_ms);
            let d = t.elapsed();
            times.push(d);
            if m.judged_through() > before {
                judging.push(d);
            }
            assert!(o.stop.is_none(), "정지가 걸리면 측정이 짧아진다");
        }
        // 판정·해제 경로가 실제로 돌았는가 — 아니면 p99가 공허하다.
        assert_eq!(m.judged_through(), STEPS - 1);
        assert_eq!(m.released, STEPS as usize);
        assert!(
            m.secs_done.unwrap() >= T0 + total_s - 10,
            "{:?}",
            m.secs_done
        );
        assert!(!judging.is_empty());
        times.sort();
        judging.sort();
        let p = |v: &[Duration], q: f64| v[((v.len() as f64 * q) as usize).min(v.len() - 1)];
        println!(
            "monitor_batch_cost skew={skew}: batches={n} p50={:?} p99={:?} max={:?} | judging batches={} p50={:?} p99={:?} max={:?}",
            p(&times, 0.5),
            p(&times, 0.99),
            times[n - 1],
            judging.len(),
            p(&judging, 0.5),
            p(&judging, 0.99),
            judging[judging.len() - 1]
        );
        assert!(
            p(&times, 0.99) < Duration::from_millis(5),
            "p99 {:?}",
            p(&times, 0.99)
        );
        assert!(
            *judging.last().unwrap() < Duration::from_millis(5),
            "판정 배치 max {:?}",
            judging.last()
        );
    }

    #[test]
    #[ignore = "수동 성능 측정 — cargo test -p handicap-controller --release monitor_batch_cost -- --ignored --nocapture"]
    fn monitor_batch_cost_worst_case() {
        run(false);
    }

    #[test]
    #[ignore = "수동 성능 측정 — cargo test -p handicap-controller --release monitor_batch_cost -- --ignored --nocapture"]
    fn monitor_batch_cost_skewed_lagging() {
        run(true);
    }
}
