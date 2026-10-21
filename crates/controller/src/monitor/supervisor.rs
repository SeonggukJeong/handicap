//! 운영실 모니터 감독자 — spec §6.3.
//!
//! 보드마다 칸 수만큼 점검 루프(tokio task)를 띄우고, 결과를 칸별 메모리 링버퍼에 쌓는다.
//! 모든 상태 변경은 [`MonitorSupervisor::reconcile`] 하나로만 들어온다(REST 쓰기·기동 재개).
//!
//! 락 순서(교착 방지):
//! 1. `Inner.boards` (`std::sync::Mutex`) — 보드 슬롯 조회/생성만. `.await` 넘어 잡지 않는다.
//!    슬롯은 한 번 생기면 프로세스 수명 동안 남는다(꺼진 보드는 빈 슬롯 — 수백 바이트). 지우면
//!    대기 중인 reconcile과 새로 생긴 슬롯이 같은 보드를 따로 직렬화하는 경합이 생기므로.
//! 2. `BoardSlot.op` (`tokio::sync::Mutex`) — 그 보드의 reconcile/stop_all 전체 구간을 직렬화.
//!    다른 보드와는 독립이라 보드 A의 reconcile이 보드 B를 막지 않는다.
//! 3. `BoardSlot.view` / `PanelBuf` (`std::sync::Mutex`) — 짧은 동기 구간만, `.await` 없음.
//!
//! 1을 잡은 채 2를 기다리지 않는다(슬롯 `Arc`를 복제한 뒤 1을 놓고 2를 잡는다).

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::check::{CheckResult, Verdict, run_check};
use super::config::PanelConfig;
use crate::store::{self, Db};

/// 칸별 링버퍼 최대 길이.
pub const BUFFER_CAP: usize = 300;

/// 감독자 전체에서 동시에 도는 점검 수 상한 — 칸이 많아도 컨트롤러·대상 서버에 점검이 몰리지 않게.
pub const MAX_CONCURRENT_CHECKS: usize = 32;

/// 정지 시 task가 취소에 응하기를 기다리는 상한 — 넘으면 `abort` 백스톱.
const STOP_GRACE: Duration = Duration::from_secs(2);

/// 칸 하나의 점검 결과 버퍼. `std::sync::Mutex`로 감싸 보관하고 `.await` 넘어 잡지 않는다.
#[derive(Debug, Default)]
pub struct PanelBuf {
    results: VecDeque<CheckResult>,
    running: bool,
}

type SharedBuf = Arc<std::sync::Mutex<PanelBuf>>;
type PanelBufs = HashMap<String, SharedBuf>;
type BoardSlots = HashMap<String, Arc<BoardSlot>>;

/// `GET …/status`가 읽는 보드 상태 사본.
#[derive(Debug, Clone)]
pub struct BoardSnapshot {
    pub started_at_ms: i64,
    pub panels: HashMap<String, PanelSnapshot>,
}

#[derive(Debug, Clone)]
pub struct PanelSnapshot {
    /// 오래된 것 → 최신, 버퍼 전체.
    pub results: Vec<CheckResult>,
    pub running: bool,
}

/// 최신 결과부터 거꾸로 연속된 `Fail`/`ConfigError` 수와, 그 연속 구간의 가장 오래된 결과 시각.
pub fn consecutive_fail(results: &[CheckResult]) -> (u32, Option<i64>) {
    let mut count = 0u32;
    let mut since = None;
    for r in results.iter().rev() {
        if r.verdict == Verdict::Ok {
            break;
        }
        count += 1;
        since = Some(r.at_ms);
    }
    (count, since)
}

/// `running`을 켜고, 점검이 끝나든 취소로 drop되든 반드시 끈다.
struct RunningGuard<'a> {
    buf: &'a std::sync::Mutex<PanelBuf>,
}

impl<'a> RunningGuard<'a> {
    fn start(buf: &'a std::sync::Mutex<PanelBuf>) -> Self {
        lock(buf).running = true;
        Self { buf }
    }

    /// 결과 기록과 `running` 해제를 한 번의 락 안에서.
    fn finish(self, result: CheckResult) {
        let mut b = lock(self.buf);
        if b.results.len() >= BUFFER_CAP {
            b.results.pop_front();
        }
        b.results.push_back(result);
        b.running = false;
        drop(b);
        std::mem::forget(self);
    }
}

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        lock(self.buf).running = false;
    }
}

/// 독(poison)된 락도 데이터는 단순 값이라 그대로 쓴다 — 감독자 전체가 패닉 전파로 죽지 않게.
fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 점검 루프 코어 — 시작-시작 간격, 첫 점검 즉시, 겹침 없음(점검이 길면 끝나자마자 다음).
/// 취소되면 진행 중 점검도 drop한다(결과 미기록).
pub(crate) async fn panel_loop<F, Fut>(
    interval: Duration,
    check: F,
    buf: SharedBuf,
    token: CancellationToken,
) where
    F: Fn() -> Fut,
    Fut: Future<Output = CheckResult>,
{
    loop {
        let started = tokio::time::Instant::now();
        let guard = RunningGuard::start(&buf);
        let result = tokio::select! {
            biased;
            _ = token.cancelled() => return,
            r = check() => r,
        };
        guard.finish(result);
        tokio::select! {
            biased;
            _ = token.cancelled() => return,
            _ = tokio::time::sleep_until(started + interval) => {}
        }
    }
}

/// 허가(permit)를 얻은 뒤 `fut`를 실행하고 끝나면(또는 drop되면) 반납한다.
/// 허가 대기도 이 future 안이라, `panel_loop`의 취소 select가 대기 중인 루프도 즉시 끝낸다.
pub(crate) async fn with_permit<Fut: Future>(
    sem: Arc<tokio::sync::Semaphore>,
    fut: Fut,
) -> Fut::Output {
    // 세마포어는 닫지 않으므로 acquire는 실패하지 않는다.
    let _permit = sem.acquire_owned().await.ok();
    fut.await
}

/// 살아 있는 루프 수 — 루프 task 진입 시 +1, 종료(정상·취소·abort) 시 −1.
struct LiveGuard(Arc<AtomicUsize>);

impl LiveGuard {
    fn enter(c: &Arc<AtomicUsize>) -> Self {
        c.fetch_add(1, Ordering::SeqCst);
        Self(c.clone())
    }
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 실행 중인 보드의 task 묶음.
struct Running {
    token: CancellationToken,
    handles: Vec<JoinHandle<()>>,
}

impl Running {
    /// 취소 후 모든 task가 끝날 때까지 기다린다. `STOP_GRACE` 안에 안 끝나면 abort 후 대기 —
    /// 반환 시점엔 이 보드의 루프가 하나도 살아 있지 않다.
    async fn stop(self) {
        self.token.cancel();
        let deadline = tokio::time::Instant::now() + STOP_GRACE;
        for mut h in self.handles {
            if tokio::time::timeout_at(deadline, &mut h).await.is_err() {
                h.abort();
                let _ = h.await;
            }
        }
    }
}

/// 화면에 보이는 상태(스냅샷 원천). 꺼진 보드는 `None`.
struct BoardView {
    started_at_ms: i64,
    bufs: PanelBufs,
}

struct BoardSlot {
    /// reconcile/stop_all 직렬화 + 실행 중 task 소유.
    op: tokio::sync::Mutex<Option<Running>>,
    view: std::sync::Mutex<Option<BoardView>>,
    live: Arc<AtomicUsize>,
}

impl BoardSlot {
    fn new() -> Self {
        Self {
            op: tokio::sync::Mutex::new(None),
            view: std::sync::Mutex::new(None),
            live: Arc::new(AtomicUsize::new(0)),
        }
    }
}

struct Inner {
    root: CancellationToken,
    checks: Arc<tokio::sync::Semaphore>,
    boards: std::sync::Mutex<BoardSlots>,
}

/// 운영실 모니터 감독자. `Clone`은 같은 내부 상태를 공유한다.
#[derive(Clone)]
pub struct MonitorSupervisor {
    inner: Arc<Inner>,
}

impl Default for MonitorSupervisor {
    fn default() -> Self {
        Self::with_root(CancellationToken::new())
    }
}

impl MonitorSupervisor {
    /// `root`가 취소되면 모든 루프가 멈추고 이후 reconcile은 아무것도 시작하지 않는다.
    pub fn with_root(root: CancellationToken) -> Self {
        Self {
            inner: Arc::new(Inner {
                root,
                checks: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_CHECKS)),
                boards: std::sync::Mutex::new(HashMap::new()),
            }),
        }
    }

    fn slot(&self, board_id: &str) -> Arc<BoardSlot> {
        lock(&self.inner.boards)
            .entry(board_id.to_string())
            .or_insert_with(|| Arc::new(BoardSlot::new()))
            .clone()
    }

    fn existing_slot(&self, board_id: &str) -> Option<Arc<BoardSlot>> {
        lock(&self.inner.boards).get(board_id).cloned()
    }

    /// DB 행을 다시 읽어 실제 실행 상태를 맞춘다 — 없음/꺼짐이면 정지·버퍼 폐기, 켜짐이면
    /// 기존 task를 완전히 정지한 뒤 행의 설정으로 재시작(남은 칸 id 버퍼 유지).
    ///
    /// 본문은 별도 task에서 돈다: reconcile이 시작된 뒤 호출자 future가 drop돼도(예: 클라이언트
    /// 연결 끊김으로 axum 핸들러 취소) "기존 task 꺼냄 → 정지 대기" 사이에서 끊겨 루프가
    /// 고아가 되지 않게. DB 쓰기가 커밋된 뒤 reconcile이 호출되기 전에 핸들러가 drop되면
    /// DB `enabled`와 실제 실행이 잠시 어긋나며, 다음 쓰기나 재시작 때 수렴한다.
    pub async fn reconcile(&self, db: &Db, board_id: &str) -> anyhow::Result<()> {
        let (this, db, board_id) = (self.clone(), db.clone(), board_id.to_string());
        tokio::spawn(async move {
            let slot = this.slot(&board_id);
            this.reconcile_slot(&db, &board_id, &slot).await
        })
        .await
        .map_err(|e| anyhow::anyhow!("monitor reconcile task failed: {e}"))?
    }

    async fn reconcile_slot(
        &self,
        db: &Db,
        board_id: &str,
        slot: &BoardSlot,
    ) -> anyhow::Result<()> {
        let mut running = slot.op.lock().await;
        // 행은 직렬화 락 안에서 읽는다 — 마지막 reconcile이 본 DB 상태로 수렴.
        let row = store::monitor_boards::get(db, board_id).await?;
        if let Some(r) = running.take() {
            r.stop().await;
        }
        let Some(row) = row.filter(|r| r.enabled && !self.inner.root.is_cancelled()) else {
            *lock(&slot.view) = None;
            return Ok(());
        };

        let mut old = lock(&slot.view).take().map(|v| v.bufs).unwrap_or_default();
        let token = self.inner.root.child_token();
        let mut bufs = PanelBufs::new();
        let mut handles = Vec::with_capacity(row.config.panels.len());
        for panel in row.config.panels {
            let buf = old.remove(&panel.id).unwrap_or_default();
            bufs.insert(panel.id.clone(), buf.clone());
            handles.push(spawn_panel(
                db.clone(),
                panel,
                buf,
                token.clone(),
                slot.live.clone(),
                self.inner.checks.clone(),
            ));
        }
        *lock(&slot.view) = Some(BoardView {
            started_at_ms: store::now_ms(),
            bufs,
        });
        *running = Some(Running { token, handles });
        Ok(())
    }

    /// 켜진 보드의 시작 시각과 칸별 버퍼 사본. 꺼진/없는 보드는 `None`.
    pub async fn snapshot(&self, board_id: &str) -> Option<BoardSnapshot> {
        let slot = self.existing_slot(board_id)?;
        let view = lock(&slot.view);
        let v = view.as_ref()?;
        let panels = v
            .bufs
            .iter()
            .map(|(id, buf)| {
                let b = lock(buf);
                (
                    id.clone(),
                    PanelSnapshot {
                        results: b.results.iter().cloned().collect(),
                        running: b.running,
                    },
                )
            })
            .collect();
        Some(BoardSnapshot {
            started_at_ms: v.started_at_ms,
            panels,
        })
    }

    /// 데스크톱 종료용 — 루트 취소 + 모든 보드 task 완료 대기(abort 백스톱).
    pub async fn stop_all(&self) {
        self.inner.root.cancel();
        let slots: Vec<Arc<BoardSlot>> = lock(&self.inner.boards).values().cloned().collect();
        for slot in slots {
            let mut running = slot.op.lock().await;
            if let Some(r) = running.take() {
                r.stop().await;
            }
            *lock(&slot.view) = None;
        }
    }

    #[cfg(test)]
    pub(crate) fn live_task_count(&self, board_id: &str) -> usize {
        self.existing_slot(board_id)
            .map_or(0, |s| s.live.load(Ordering::SeqCst))
    }
}

fn spawn_panel(
    db: Db,
    panel: PanelConfig,
    buf: SharedBuf,
    token: CancellationToken,
    live: Arc<AtomicUsize>,
    checks: Arc<tokio::sync::Semaphore>,
) -> JoinHandle<()> {
    let interval = Duration::from_secs(u64::from(panel.interval_seconds.max(1)));
    tokio::spawn(async move {
        let _live = LiveGuard::enter(&live);
        let check = || {
            let (db, panel, checks) = (db.clone(), panel.clone(), checks.clone());
            // `at_ms`는 run_check 안에서 찍히므로 허가를 얻은 뒤의 실제 시작 시각이다.
            with_permit(checks, async move { run_check(&db, &panel).await.1 })
        };
        panel_loop(interval, check, buf, token).await;
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::check::{REASON_SCENARIO_MISSING, Verdict};
    use crate::monitor::config::{BoardConfig, PanelConfig};
    use crate::store::{self, monitor_boards};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use tokio::time::Instant;

    #[test]
    fn default_is_constructible() {
        let s = MonitorSupervisor::default();
        let _c = s.clone();
        let _r = MonitorSupervisor::with_root(tokio_util::sync::CancellationToken::new());
    }

    fn res(at_ms: i64, verdict: Verdict) -> CheckResult {
        CheckResult {
            at_ms,
            verdict,
            latency_ms: None,
            reason: None,
        }
    }

    fn new_buf() -> SharedBuf {
        Arc::new(std::sync::Mutex::new(PanelBuf::default()))
    }

    fn buf_results(buf: &SharedBuf) -> Vec<CheckResult> {
        buf.lock().unwrap().results.iter().cloned().collect()
    }

    type Starts = Arc<std::sync::Mutex<Vec<Duration>>>;

    // ---- panel_loop (paused time, fake check, no SQLite) ----

    #[tokio::test(start_paused = true)]
    async fn first_check_immediate_then_start_to_start() {
        let t0 = Instant::now();
        let starts: Starts = Arc::default();
        let s2 = starts.clone();
        let check = move || {
            let s = s2.clone();
            async move {
                s.lock().unwrap().push(t0.elapsed());
                tokio::time::sleep(Duration::from_secs(1)).await;
                res(0, Verdict::Ok)
            }
        };
        let token = CancellationToken::new();
        let h = tokio::spawn(panel_loop(
            Duration::from_secs(10),
            check,
            new_buf(),
            token.clone(),
        ));
        tokio::time::sleep(Duration::from_millis(25_500)).await;
        token.cancel();
        h.await.unwrap();
        let got = starts.lock().unwrap().clone();
        assert_eq!(
            got,
            vec![
                Duration::from_secs(0),
                Duration::from_secs(10),
                Duration::from_secs(20)
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn slow_check_does_not_overlap() {
        let t0 = Instant::now();
        let starts: Starts = Arc::default();
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let (s2, a2, m2) = (starts.clone(), active.clone(), max_active.clone());
        let check = move || {
            let (s, a, m) = (s2.clone(), a2.clone(), m2.clone());
            async move {
                s.lock().unwrap().push(t0.elapsed());
                let now = a.fetch_add(1, Ordering::SeqCst) + 1;
                m.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_secs(5)).await;
                a.fetch_sub(1, Ordering::SeqCst);
                res(0, Verdict::Ok)
            }
        };
        let token = CancellationToken::new();
        let h = tokio::spawn(panel_loop(
            Duration::from_secs(2),
            check,
            new_buf(),
            token.clone(),
        ));
        tokio::time::sleep(Duration::from_millis(12_000)).await;
        token.cancel();
        h.await.unwrap();
        assert_eq!(
            starts.lock().unwrap().clone(),
            vec![
                Duration::from_secs(0),
                Duration::from_secs(5),
                Duration::from_secs(10)
            ]
        );
        assert_eq!(max_active.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn buffer_capped_and_ordered() {
        let n = Arc::new(AtomicU64::new(0));
        let n2 = n.clone();
        let check = move || {
            let n = n2.clone();
            async move {
                let k = n.fetch_add(1, Ordering::SeqCst) + 1;
                res(k as i64, Verdict::Ok)
            }
        };
        let buf = new_buf();
        let token = CancellationToken::new();
        let h = tokio::spawn(panel_loop(
            Duration::from_secs(1),
            check,
            buf.clone(),
            token.clone(),
        ));
        // checks at t = 0..=304 s → 305 checks
        tokio::time::sleep(Duration::from_millis(304_500)).await;
        token.cancel();
        h.await.unwrap();
        assert_eq!(n.load(Ordering::SeqCst), 305);
        let got = buf_results(&buf);
        assert_eq!(got.len(), BUFFER_CAP);
        assert_eq!(got.first().unwrap().at_ms, 6);
        assert_eq!(got.last().unwrap().at_ms, 305);
        assert!(got.windows(2).all(|w| w[0].at_ms < w[1].at_ms));
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_stops_loop() {
        // (a) cancel between checks: no further checks afterwards.
        let n = Arc::new(AtomicU64::new(0));
        let n2 = n.clone();
        let check = move || {
            let n = n2.clone();
            async move {
                n.fetch_add(1, Ordering::SeqCst);
                res(0, Verdict::Ok)
            }
        };
        let token = CancellationToken::new();
        let h = tokio::spawn(panel_loop(
            Duration::from_secs(1),
            check,
            new_buf(),
            token.clone(),
        ));
        tokio::time::sleep(Duration::from_millis(5_500)).await;
        token.cancel();
        h.await.unwrap();
        let after_cancel = n.load(Ordering::SeqCst);
        assert_eq!(after_cancel, 6);
        tokio::time::sleep(Duration::from_secs(10)).await;
        assert_eq!(n.load(Ordering::SeqCst), after_cancel);

        // (b) cancel mid-check: the in-flight check is dropped, no result is
        // recorded and `running` is reset.
        let finished = Arc::new(AtomicUsize::new(0));
        let f2 = finished.clone();
        let slow = move || {
            let f = f2.clone();
            async move {
                tokio::time::sleep(Duration::from_secs(10)).await;
                f.fetch_add(1, Ordering::SeqCst);
                res(0, Verdict::Ok)
            }
        };
        let buf = new_buf();
        let token = CancellationToken::new();
        let h = tokio::spawn(panel_loop(
            Duration::from_secs(1),
            slow,
            buf.clone(),
            token.clone(),
        ));
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(buf.lock().unwrap().running, "running while check in flight");
        token.cancel();
        h.await.unwrap();
        assert!(!buf.lock().unwrap().running, "running reset on cancel");
        assert!(buf_results(&buf).is_empty());
        tokio::time::sleep(Duration::from_secs(20)).await;
        assert_eq!(finished.load(Ordering::SeqCst), 0);
    }

    // ---- 동시 점검 상한 (paused time, fake check, no SQLite) ----

    #[tokio::test(start_paused = true)]
    async fn permit_gate_caps_concurrent_checks_and_cancel_frees_waiters() {
        let sem = Arc::new(tokio::sync::Semaphore::new(2));
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let token = CancellationToken::new();
        let bufs: Vec<SharedBuf> = (0..5).map(|_| new_buf()).collect();
        let mut handles = Vec::new();
        for buf in &bufs {
            let (sem, a, m) = (sem.clone(), active.clone(), max_active.clone());
            let check = move || {
                let (sem, a, m) = (sem.clone(), a.clone(), m.clone());
                with_permit(sem, async move {
                    let now = a.fetch_add(1, Ordering::SeqCst) + 1;
                    m.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    a.fetch_sub(1, Ordering::SeqCst);
                    res(0, Verdict::Ok)
                })
            };
            handles.push(tokio::spawn(panel_loop(
                Duration::from_secs(1),
                check,
                buf.clone(),
                token.clone(),
            )));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(max_active.load(Ordering::SeqCst), 2, "never above the cap");
        assert_eq!(active.load(Ordering::SeqCst), 2);
        assert_eq!(sem.available_permits(), 0);
        // 3 loops are parked on the permit; cancelling must end every loop promptly
        // and give all permits back.
        token.cancel();
        for h in handles {
            tokio::time::timeout(Duration::from_secs(1), h)
                .await
                .expect("loop exits promptly")
                .unwrap();
        }
        assert_eq!(sem.available_permits(), 2);
        assert!(max_active.load(Ordering::SeqCst) <= 2);
    }

    // ---- consecutive_fail (pure) ----

    #[test]
    fn consecutive_counts_from_newest_over_full_buffer() {
        let mut v: Vec<CheckResult> = (0..288).map(|i| res(i, Verdict::Ok)).collect();
        for i in 288..300 {
            let verdict = if i % 2 == 0 {
                Verdict::Fail
            } else {
                Verdict::ConfigError
            };
            v.push(res(i, verdict));
        }
        assert_eq!(v.len(), 300);
        assert_eq!(consecutive_fail(&v), (12, Some(288)));

        // fails before an ok are not counted
        v.push(res(300, Verdict::Ok));
        assert_eq!(consecutive_fail(&v), (0, None));
        assert_eq!(consecutive_fail(&[]), (0, None));

        // whole buffer failing counts all of it (not capped by bar_count etc.)
        let all: Vec<CheckResult> = (0..300).map(|i| res(i, Verdict::Fail)).collect();
        assert_eq!(consecutive_fail(&all), (300, Some(0)));
    }

    // ---- reconcile (real time, in-memory DB) ----

    const P1: &str = "01J0000000000000000000000A";
    const P2: &str = "01J0000000000000000000000B";
    const P3: &str = "01J0000000000000000000000C";

    fn panel(id: &str) -> PanelConfig {
        PanelConfig {
            id: id.into(),
            title: "t".into(),
            scenario_id: "no-such-scenario".into(),
            interval_seconds: 1,
            ..PanelConfig::default()
        }
    }

    fn board(ids: &[&str]) -> BoardConfig {
        BoardConfig {
            panels: ids.iter().map(|i| panel(i)).collect(),
            ..BoardConfig::default()
        }
    }

    async fn enabled_board(db: &Db, name: &str, ids: &[&str]) -> String {
        let row = monitor_boards::insert(db, name, &board(ids)).await.unwrap();
        monitor_boards::set_enabled(db, &row.id, true)
            .await
            .unwrap();
        row.id
    }

    /// Waits (real time, ≤3s) until every listed panel has at least one result.
    async fn wait_results(sup: &MonitorSupervisor, board_id: &str, ids: &[&str]) -> BoardSnapshot {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(s) = sup.snapshot(board_id).await
                && ids
                    .iter()
                    .all(|i| s.panels.get(*i).is_some_and(|p| !p.results.is_empty()))
            {
                return s;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for results"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn reconcile_starts_enabled_and_stops_disabled() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let id = enabled_board(&db, "b", &[P1, P2]).await;

        sup.reconcile(&db, &id).await.unwrap();
        let snap = wait_results(&sup, &id, &[P1, P2]).await;
        assert_eq!(snap.panels.len(), 2);
        let r = &snap.panels[P1].results[0];
        assert_eq!(r.verdict, Verdict::ConfigError);
        assert_eq!(r.reason.as_deref(), Some(REASON_SCENARIO_MISSING));
        assert_eq!(sup.live_task_count(&id), 2);

        monitor_boards::set_enabled(&db, &id, false).await.unwrap();
        sup.reconcile(&db, &id).await.unwrap();
        assert!(sup.snapshot(&id).await.is_none());
        assert_eq!(sup.live_task_count(&id), 0);
    }

    #[tokio::test]
    async fn reconcile_keeps_buffer_for_same_panel_id() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let id = enabled_board(&db, "b", &[P1, P2]).await;
        sup.reconcile(&db, &id).await.unwrap();
        let before = wait_results(&sup, &id, &[P1, P2]).await;
        let first_p1 = before.panels[P1].results[0].clone();

        monitor_boards::update(&db, &id, "b", &board(&[P1, P3]))
            .await
            .unwrap();
        sup.reconcile(&db, &id).await.unwrap();
        let after = wait_results(&sup, &id, &[P1, P3]).await;
        assert_eq!(
            after.panels[P1].results[0], first_p1,
            "P1 buffer carried over"
        );
        assert!(after.panels[P1].results.len() >= before.panels[P1].results.len());
    }

    #[tokio::test]
    async fn reconcile_drops_removed_panel() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let id = enabled_board(&db, "b", &[P1, P2]).await;
        sup.reconcile(&db, &id).await.unwrap();
        wait_results(&sup, &id, &[P1, P2]).await;

        monitor_boards::update(&db, &id, "b", &board(&[P1]))
            .await
            .unwrap();
        sup.reconcile(&db, &id).await.unwrap();
        let snap = sup.snapshot(&id).await.unwrap();
        assert_eq!(snap.panels.len(), 1);
        assert!(!snap.panels.contains_key(P2));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(sup.live_task_count(&id), 1);

        // re-adding P2 starts from an empty buffer (at most the fresh first check)
        monitor_boards::update(&db, &id, "b", &board(&[P1, P2]))
            .await
            .unwrap();
        sup.reconcile(&db, &id).await.unwrap();
        let snap = sup.snapshot(&id).await.unwrap();
        assert!(snap.panels[P2].results.len() <= 1);
    }

    #[tokio::test]
    async fn started_at_resets_on_reconcile() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let id = enabled_board(&db, "b", &[P1]).await;
        let t_before = store::now_ms();
        sup.reconcile(&db, &id).await.unwrap();
        let s1 = sup.snapshot(&id).await.unwrap().started_at_ms;
        assert!(s1 >= t_before);
        tokio::time::sleep(Duration::from_millis(20)).await;
        // an unchanged config still counts as a (re)start
        sup.reconcile(&db, &id).await.unwrap();
        let s2 = sup.snapshot(&id).await.unwrap().started_at_ms;
        assert!(s2 > s1, "{s2} > {s1}");
    }

    #[tokio::test]
    async fn reconcile_deleted_row_stops() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let id = enabled_board(&db, "b", &[P1, P2]).await;
        sup.reconcile(&db, &id).await.unwrap();
        wait_results(&sup, &id, &[P1, P2]).await;

        monitor_boards::delete(&db, &id).await.unwrap();
        sup.reconcile(&db, &id).await.unwrap();
        assert!(sup.snapshot(&id).await.is_none());
        assert_eq!(sup.live_task_count(&id), 0);
        // reconcile of an unknown id is a harmless no-op
        sup.reconcile(&db, "nope").await.unwrap();
        assert!(sup.snapshot("nope").await.is_none());
    }

    #[tokio::test]
    async fn live_task_count_after_rapid_reconcile() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let ids = [P1, P2, P3];
        let id = enabled_board(&db, "b", &ids).await;
        for _ in 0..5 {
            sup.reconcile(&db, &id).await.unwrap();
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(sup.live_task_count(&id), ids.len());

        // concurrent reconciles of the same board also converge
        let (a, b, c, d, e) = tokio::join!(
            sup.reconcile(&db, &id),
            sup.reconcile(&db, &id),
            sup.reconcile(&db, &id),
            sup.reconcile(&db, &id),
            sup.reconcile(&db, &id),
        );
        for r in [a, b, c, d, e] {
            r.unwrap();
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(sup.live_task_count(&id), ids.len());
    }

    #[tokio::test]
    async fn concurrent_reconcile_ends_in_db_state() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let id = enabled_board(&db, "b", &[P1, P2]).await;
        sup.reconcile(&db, &id).await.unwrap();
        monitor_boards::set_enabled(&db, &id, false).await.unwrap();
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let (s, d, i) = (sup.clone(), db.clone(), id.clone());
                tokio::spawn(async move { s.reconcile(&d, &i).await })
            })
            .collect();
        for t in tasks {
            t.await.unwrap().unwrap();
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(sup.snapshot(&id).await.is_none());
        assert_eq!(sup.live_task_count(&id), 0);
    }

    #[tokio::test]
    async fn reconcile_completes_even_if_caller_dropped() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let id = enabled_board(&db, "b", &[P1, P2]).await;
        // Poll once, then drop the caller's future (like an axum handler cancelled on disconnect).
        use futures::FutureExt;
        let r = sup.reconcile(&db, &id).now_or_never();
        assert!(r.is_none(), "future must still be pending when dropped");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(sup.snapshot(&id).await.is_some());
        assert_eq!(sup.live_task_count(&id), 2);
    }

    #[tokio::test]
    async fn stop_all_stops_everything() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let a = enabled_board(&db, "a", &[P1, P2]).await;
        let b = enabled_board(&db, "b", &[P3]).await;
        sup.reconcile(&db, &a).await.unwrap();
        sup.reconcile(&db, &b).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(sup.live_task_count(&a), 2);
        assert_eq!(sup.live_task_count(&b), 1);

        sup.stop_all().await;
        assert_eq!(sup.live_task_count(&a), 0);
        assert_eq!(sup.live_task_count(&b), 0);
        assert!(sup.snapshot(&a).await.is_none());
        assert!(sup.snapshot(&b).await.is_none());

        // after shutdown, reconcile never restarts anything
        sup.reconcile(&db, &a).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(sup.live_task_count(&a), 0);
        assert!(sup.snapshot(&a).await.is_none());
    }
}
