//! 운영실 모니터 감독자 — spec §6.3.
//!
//! 보드마다 **실행 단위**(점검 묶음 하나·단독 스텝 칸 하나·흐름 전체 칸 하나)마다 점검 루프
//! (tokio task)를 띄우고, 결과를 칸별 메모리 링버퍼에 쌓는다. 묶음은 회차마다 trace 1회를
//! 소속 칸들이 공유한다(기록 본문 `Arc` 1벌, 판정은 칸별).
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
use super::record::{CheckRecord, build_record, build_record_body};
use super::unit::{CheckUnit, INITIAL_STEP_BUDGET_SECS, UnitPlan, plan_units, run_unit_check};
use crate::store::{self, Db};

/// 칸별 링버퍼 최대 길이.
pub const BUFFER_CAP: usize = 300;

/// 감독자 전체에서 동시에 도는 점검 수 상한 — 칸이 많아도 컨트롤러·대상 서버에 점검이 몰리지 않게.
pub const MAX_CONCURRENT_CHECKS: usize = 32;

/// 정지 시 task가 취소에 응하기를 기다리는 상한 — 넘으면 `abort` 백스톱.
const STOP_GRACE: Duration = Duration::from_secs(2);

/// 지금 점검으로 깨운 회차와 직전 회차 시작 사이의 최소 간격(주기 최솟값 1초와 같다) — 지금 점검을
/// 아무리 눌러도 한 실행 단위가 설정으로 허용된 가장 빠른 주기보다 자주 돌지 않게.
pub(crate) const CHECK_NOW_MIN_GAP: Duration = Duration::from_secs(1);

/// 칸 하나의 점검 결과 버퍼. `std::sync::Mutex`로 감싸 보관하고 `.await` 넘어 잡지 않는다.
///
/// `records`는 `results`와 별도(최대 그 칸의 `bar_count`) — `snapshot()`(매 1초 `/status`)이
/// 기록을 복제하지 않게. 기록은 수 MB일 수 있어 `Arc`로 들고 조회 시 `Arc`만 복제한다.
#[derive(Debug, Default)]
pub struct PanelBuf {
    results: VecDeque<CheckResult>,
    records: VecDeque<Arc<CheckRecord>>,
    running: bool,
    /// 이 칸 실행 단위의 바깥 제한(초) — 회차마다 갱신, reconcile 때 초기값으로 재설정.
    budget_secs: u32,
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
    /// 이 칸 실행 단위의 바깥 제한(초) — `/status`의 `check_budget_seconds`.
    pub budget_secs: u32,
}

/// 첫 회차 전(·reconcile 직후)의 예산 — 스텝 칸은 152초(흐름 상한 최대 + 여유),
/// 흐름 전체 칸은 `timeout_seconds`(그 칸 점검의 바깥 제한 그대로).
pub fn initial_budget_secs(p: &PanelConfig) -> u32 {
    if p.step_id.is_some() {
        INITIAL_STEP_BUDGET_SECS
    } else {
        p.timeout_seconds
    }
}

/// 최신 결과부터 거꾸로 연속된 `Fail`/`ConfigError` 수와, 그 연속 구간의 가장 오래된 결과 시각.
pub fn consecutive_fail(results: &[CheckResult]) -> (u32, Option<i64>) {
    let mut count = 0u32;
    let mut since = None;
    for r in results.iter().rev() {
        if !matches!(r.verdict, Verdict::Fail | Verdict::ConfigError) {
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

    #[cfg(test)]
    fn finish(self, result: CheckResult, record: Arc<CheckRecord>, bar_count: usize) {
        self.finish_round(result, record, bar_count, None);
    }

    /// 결과·기록 추가·예산 저장(`Some`일 때)과 `running` 해제를 한 번의 락 안에서.
    ///
    /// 기록은 `bar_count`까지 **`while`**로 줄인다 — 막대 개수를 줄여 저장하면 다음 점검 한 번에
    /// 줄어야 한다. 버린 기록(수백 MB일 수 있음)은 락을 푼 **뒤** drop한다 — `snapshot()`이
    /// 같은 락을 잡으므로 해제 비용을 그 안에서 치르지 않게.
    fn finish_round(
        self,
        result: CheckResult,
        record: Arc<CheckRecord>,
        bar_count: usize,
        budget_secs: Option<u32>,
    ) {
        let mut evicted = Vec::new();
        let mut b = lock(self.buf);
        if b.results.len() >= BUFFER_CAP {
            b.results.pop_front();
        }
        b.results.push_back(result);
        b.records.push_back(record);
        while b.records.len() > bar_count {
            if let Some(old) = b.records.pop_front() {
                evicted.push(old);
            }
        }
        if let Some(v) = budget_secs {
            b.budget_secs = v;
        }
        b.running = false;
        drop(b);
        drop(evicted);
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

/// 실행 단위 점검 루프 코어 — 시작-시작 간격, 첫 점검 즉시, 겹침 없음(점검이 길면 끝나자마자
/// 다음). `members`(칸 버퍼, 그 칸 `bar_count`)는 `check` 결과와 **같은 순서**다: 회차마다 모든
/// 칸의 `running`을 켜고, 결과를 각 칸 버퍼에 push하며 예산(초)을 저장한다. 취소되면 진행 중
/// 점검도 drop한다(결과·기록 미기록, `running`은 가드가 끈다). 기록은 칸마다 최근 `bar_count`개.
/// 지금 점검으로 깨우면(`kick.notify_waiters()`) 주기를 기다리지 않는다(바닥 1초, 점검 중 요청은
/// 버린다 — 허가를 저장하지 않으므로). 깨우는 쪽은 `notify_waiters()`만 써야 한다:
/// `notify_one()`은 허가를 저장해 점검 중 요청이 다음 회차를 예약한다(규칙 3 위반).
pub(crate) async fn unit_loop<F, Fut>(
    interval: Duration,
    members: Vec<(SharedBuf, usize)>,
    check: F,
    token: CancellationToken,
    kick: Arc<tokio::sync::Notify>,
) where
    F: Fn() -> Fut,
    Fut: Future<Output = (Vec<(CheckResult, Arc<CheckRecord>)>, u32)>,
{
    loop {
        let started = tokio::time::Instant::now();
        let guards: Vec<RunningGuard<'_>> = members
            .iter()
            .map(|(buf, _)| RunningGuard::start(buf))
            .collect();
        let (pairs, budget_secs) = tokio::select! {
            biased;
            _ = token.cancelled() => return,
            r = check() => r,
        };
        // 결과를 버퍼에 넣기 **전에** 만든다: 이 결과를 본 뒤에 온 지금-점검 요청(요청한 쪽은 새
        // 결과를 기준으로 읽는다)을 놓치지 않게. push 뒤에 만들면 그 사이에 떨어진 깨우기가 사라져
        // 요청한 쪽이 다음 정기 회차까지 기다리는 틈이 생긴다. 점검 중(`check()` 동안)에는 만들지
        // 않으므로 그때 온 요청은 버려진다(규칙 3). 이 순서는 가상 시계 단일 스레드 테스트로 지킬
        // 수 없다(push와 생성 사이에 다른 태스크가 끼지 않는다) — 이 주석과 리뷰로 지킨다.
        let kicked = kick.notified();
        tokio::pin!(kicked);
        // 결과가 모자라면 남은 가드는 drop되며 `running`만 끈다(실제로는 칸 수와 같다).
        for ((guard, (_, bar_count)), (result, record)) in
            guards.into_iter().zip(&members).zip(pairs)
        {
            guard.finish_round(result, record, *bar_count, Some(budget_secs));
        }
        let floor = started + interval.min(CHECK_NOW_MIN_GAP);
        tokio::select! {
            biased;
            _ = token.cancelled() => return,
            _ = tokio::time::sleep_until(started + interval) => {}
            _ = async {
                kicked.as_mut().await;
                tokio::time::sleep_until(floor).await;
            } => {}
        }
    }
}

/// 칸 1개짜리 [`unit_loop`] — 기존 루프 테스트용(예산은 0으로 붙인다).
#[cfg(test)]
pub(crate) async fn panel_loop<F, Fut>(
    interval: Duration,
    bar_count: usize,
    check: F,
    buf: SharedBuf,
    token: CancellationToken,
) where
    F: Fn() -> Fut,
    Fut: Future<Output = (CheckResult, Arc<CheckRecord>)>,
{
    panel_loop_kick(
        interval,
        bar_count,
        check,
        buf,
        token,
        Arc::new(tokio::sync::Notify::new()),
    )
    .await;
}

/// [`panel_loop`]에 깨우기 신호를 직접 넘기는 판 — 지금 점검 테스트용.
#[cfg(test)]
pub(crate) async fn panel_loop_kick<F, Fut>(
    interval: Duration,
    bar_count: usize,
    check: F,
    buf: SharedBuf,
    token: CancellationToken,
    kick: Arc<tokio::sync::Notify>,
) where
    F: Fn() -> Fut,
    Fut: Future<Output = (CheckResult, Arc<CheckRecord>)>,
{
    let wrapped = || {
        let fut = check();
        async move {
            let (result, record) = fut.await;
            (vec![(result, record)], 0)
        }
    };
    unit_loop(interval, vec![(buf, bar_count)], wrapped, token, kick).await;
}

/// 허가(permit)를 얻은 뒤 `fut`를 실행하고 끝나면(또는 drop되면) 반납한다.
/// 허가 대기도 이 future 안이라, `unit_loop`의 취소 select가 대기 중인 루프도 즉시 끝낸다.
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

/// `check_now` 결과.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckNow {
    /// 깨움 신호를 보냈다(점검 중이면 버려진다). `last_at_ms` = 요청 직전 그 칸의 마지막 결과 시각.
    Requested { last_at_ms: Option<i64> },
    /// 보드가 없거나 꺼져 있다.
    Off,
    /// 켜진 보드에 그 칸이 없다.
    NoPanel,
}

/// 화면에 보이는 상태(스냅샷 원천). 꺼진 보드는 `None`.
struct BoardView {
    started_at_ms: i64,
    bufs: PanelBufs,
    /// 칸 id → 그 칸이 속한 실행 단위의 깨우기 신호(묶음 칸들은 같은 `Arc`).
    kicks: HashMap<String, Arc<tokio::sync::Notify>>,
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
        let mut kicks: HashMap<String, Arc<tokio::sync::Notify>> = HashMap::new();
        let plans = plan_units(&row.config);
        let mut handles = Vec::with_capacity(plans.len());
        for plan in plans {
            let panels: &[PanelConfig] = match &plan {
                UnitPlan::Whole(p) => std::slice::from_ref(p),
                UnitPlan::Steps(u) => &u.panels,
            };
            // 실행 단위마다 깨우기 신호 하나 — 그 단위의 모든 칸 id가 같은 신호를 가리킨다.
            let kick = Arc::new(tokio::sync::Notify::new());
            let members = panels
                .iter()
                .map(|p| {
                    kicks.insert(p.id.clone(), kick.clone());
                    // 살아남은 칸은 결과 버퍼를 유지하되 예산은 초기값으로 — 편집 전의 작은 예산이
                    // 첫 긴 회차에 "확인 불가"를 내지 않게(spec §4).
                    let buf = old.remove(&p.id).unwrap_or_default();
                    lock(&buf).budget_secs = initial_budget_secs(p);
                    bufs.insert(p.id.clone(), buf.clone());
                    (buf, p.bar_count as usize)
                })
                .collect();
            handles.push(spawn_unit(
                db.clone(),
                plan,
                row.config.record_limit_kb,
                members,
                token.clone(),
                slot.live.clone(),
                self.inner.checks.clone(),
                kick,
            ));
        }
        *lock(&slot.view) = Some(BoardView {
            started_at_ms: store::now_ms(),
            bufs,
            kicks,
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
                        budget_secs: b.budget_secs,
                    },
                )
            })
            .collect();
        Some(BoardSnapshot {
            started_at_ms: v.started_at_ms,
            panels,
        })
    }

    /// 켜진 보드의 칸 기록 하나(`at_ms` = 그 점검의 `CheckResult.at_ms`). 꺼진/없는 보드·칸·
    /// 이미 밀려난 기록은 `None`. **`existing_slot`만** — 미지의 id로 슬롯을 만들지 않는다
    /// (슬롯은 지우지 않으므로 메모리 무한 증가).
    pub async fn record(
        &self,
        board_id: &str,
        panel_id: &str,
        at_ms: i64,
    ) -> Option<Arc<CheckRecord>> {
        let slot = self.existing_slot(board_id)?;
        let view = lock(&slot.view);
        let buf = view.as_ref()?.bufs.get(panel_id)?.clone();
        drop(view);
        let b = lock(&buf);
        b.records.iter().rev().find(|r| r.at_ms == at_ms).cloned()
    }

    /// 지금 점검 — 그 칸이 속한 실행 단위를 깨운다(spec tui-check-now §3.2). **`existing_slot`만**
    /// (미지의 id로 슬롯을 만들지 않는다).
    ///
    /// 순서가 load-bearing: ① 락은 겹쳐 잡지 않는다(view 락에서 버퍼·신호 `Arc`만 복제하고 해제,
    /// 그다음 버퍼 락) ② 마지막 결과 시각 `last_at_ms`를 **깨우기 전에** 서버가 읽어 돌려준다 —
    /// 클라이언트가 따로 읽으면 요청과 읽기 사이에 새 결과가 끼어 "요청 뒤 결과"를 구별 못 한다.
    /// 버퍼를 읽은 **뒤에** 깨운다 — 기준에 든 결과는 그 회차의 `Notified`가 만들어진 뒤 push된
    /// 것이므로(`unit_loop`), 읽은 뒤의 `notify_waiters()`는 반드시 그 대기에 닿는다. 반대 순서면
    /// 점검 중에 버려진 깨우기 뒤에 push된 결과가 기준이 되어 요청한 쪽이 다음 정기 회차까지 기다린다.
    /// 깨우기는 `notify_waiters()`만 쓴다 — `notify_one()`은 허가를 저장해 점검 중 요청이 다음
    /// 회차를 예약한다(규칙 3 위반).
    pub fn check_now(&self, board_id: &str, panel_id: &str) -> CheckNow {
        let Some(slot) = self.existing_slot(board_id) else {
            return CheckNow::Off;
        };
        let (buf, kick) = {
            let view = lock(&slot.view);
            let Some(v) = view.as_ref() else {
                return CheckNow::Off;
            };
            match (v.bufs.get(panel_id), v.kicks.get(panel_id)) {
                (Some(b), Some(k)) => (b.clone(), k.clone()),
                _ => return CheckNow::NoPanel,
            }
        };
        let last_at_ms = lock(&buf).results.back().map(|r| r.at_ms);
        kick.notify_waiters();
        CheckNow::Requested { last_at_ms }
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

/// 실행 단위 하나의 루프 task. 세마포어 허가는 단위당 1개(회차 전체를 감싼다).
/// `members`는 단위의 칸 순서(= `run_unit_check` 결과 순서).
#[allow(clippy::too_many_arguments)]
fn spawn_unit(
    db: Db,
    plan: UnitPlan,
    record_limit_kb: u32,
    members: Vec<(SharedBuf, usize)>,
    token: CancellationToken,
    live: Arc<AtomicUsize>,
    checks: Arc<tokio::sync::Semaphore>,
    kick: Arc<tokio::sync::Notify>,
) -> JoinHandle<()> {
    match plan {
        UnitPlan::Whole(panel) => {
            let interval = Duration::from_secs(u64::from(panel.interval_seconds.max(1)));
            let check = move || {
                let (db, panel, checks) = (db.clone(), panel.clone(), checks.clone());
                // `at_ms`는 run_check 안에서 찍히므로 허가를 얻은 뒤의 실제 시작 시각이다.
                with_permit(checks, async move {
                    let (trace, result) = run_check(&db, &panel).await;
                    let rec = Arc::new(build_record(&result, trace, record_limit_kb));
                    (vec![(result, rec)], panel.timeout_seconds)
                })
            };
            spawn_loop(interval, members, check, token, live, kick)
        }
        UnitPlan::Steps(unit) => {
            let interval = Duration::from_secs(u64::from(unit.interval_seconds.max(1)));
            let unit: Arc<CheckUnit> = Arc::new(unit);
            let check = move || {
                let (db, unit, checks) = (db.clone(), unit.clone(), checks.clone());
                // `at_ms`는 run_unit_check 안에서 한 번 찍혀 소속 칸 모두 같다(기록 조회 키).
                with_permit(checks, async move {
                    let out = run_unit_check(&db, &unit).await;
                    let body = Arc::new(build_record_body(out.trace, record_limit_kb));
                    let pairs = out
                        .results
                        .into_iter()
                        .map(|result| {
                            let rec = Arc::new(CheckRecord {
                                at_ms: result.at_ms,
                                result: result.clone(),
                                body: Arc::clone(&body),
                            });
                            (result, rec)
                        })
                        .collect();
                    (pairs, out.budget_secs)
                })
            };
            spawn_loop(interval, members, check, token, live, kick)
        }
    }
}

fn spawn_loop<F, Fut>(
    interval: Duration,
    members: Vec<(SharedBuf, usize)>,
    check: F,
    token: CancellationToken,
    live: Arc<AtomicUsize>,
    kick: Arc<tokio::sync::Notify>,
) -> JoinHandle<()>
where
    F: Fn() -> Fut + Send + 'static,
    Fut: Future<Output = (Vec<(CheckResult, Arc<CheckRecord>)>, u32)> + Send + 'static,
{
    tokio::spawn(async move {
        let _live = LiveGuard::enter(&live);
        unit_loop(interval, members, check, token, kick).await;
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
            detail: None,
            display: vec![],
        }
    }

    fn new_buf() -> SharedBuf {
        Arc::new(std::sync::Mutex::new(PanelBuf::default()))
    }

    fn buf_results(buf: &SharedBuf) -> Vec<CheckResult> {
        buf.lock().unwrap().results.iter().cloned().collect()
    }

    /// 가짜 점검이 내는 (결과, 기록) 쌍 — 실제 `spawn_panel` 클로저와 같은 모양.
    fn pair(r: CheckResult) -> (CheckResult, Arc<CheckRecord>) {
        let rec = Arc::new(build_record(&r, None, 128));
        (r, rec)
    }

    fn buf_record_ats(buf: &SharedBuf) -> Vec<i64> {
        buf.lock()
            .unwrap()
            .records
            .iter()
            .map(|r| r.at_ms)
            .collect()
    }

    // ---- 기록 보관 (spec §3.1) ----

    #[test]
    fn records_trim_to_bar_count_at_once() {
        let buf = new_buf();
        for k in 1..=5 {
            let (r, rec) = pair(res(k, Verdict::Ok));
            RunningGuard::start(&buf).finish(r, rec, 5);
        }
        assert_eq!(buf_record_ats(&buf), vec![1, 2, 3, 4, 5]);
        // 막대 개수를 줄여 저장한 뒤의 첫 점검 — 한 번에 bar_count까지 줄어야 한다.
        let (r, rec) = pair(res(6, Verdict::Ok));
        RunningGuard::start(&buf).finish(r, rec, 2);
        assert_eq!(buf_record_ats(&buf), vec![5, 6]);
        // 결과 버퍼는 기록 상한과 무관(BUFFER_CAP)하게 그대로 쌓인다.
        assert_eq!(buf_results(&buf).len(), 6);
        assert!(!buf.lock().unwrap().running);
    }

    #[tokio::test]
    async fn record_lookup_hit_and_miss() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let id = enabled_board(&db, "b", &[P1]).await;
        sup.reconcile(&db, &id).await.unwrap();
        let snap = wait_results(&sup, &id, &[P1]).await;
        let first = snap.panels[P1].results[0].clone();

        let rec = sup.record(&id, P1, first.at_ms).await.expect("hit");
        assert_eq!(rec.at_ms, first.at_ms);
        assert_eq!(rec.result, first);
        assert_eq!(rec.body.limit_kb, 128);
        // 설정 오류(시나리오 없음)는 요청 전에 멈춰 trace가 없다.
        assert!(rec.body.trace.is_none());

        assert!(sup.record(&id, P1, first.at_ms - 1).await.is_none());
        assert!(sup.record(&id, P2, first.at_ms).await.is_none());
        sup.stop_all().await;
    }

    #[tokio::test]
    async fn record_on_unknown_board_creates_no_slot() {
        let sup = MonitorSupervisor::default();
        let before = lock(&sup.inner.boards).len();
        assert!(sup.record("nope", P1, 1).await.is_none());
        assert_eq!(lock(&sup.inner.boards).len(), before);
        assert!(!lock(&sup.inner.boards).contains_key("nope"));
    }

    #[tokio::test]
    async fn record_none_after_board_disabled() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let id = enabled_board(&db, "b", &[P1]).await;
        sup.reconcile(&db, &id).await.unwrap();
        let snap = wait_results(&sup, &id, &[P1]).await;
        let at = snap.panels[P1].results[0].at_ms;
        assert!(sup.record(&id, P1, at).await.is_some());

        monitor_boards::set_enabled(&db, &id, false).await.unwrap();
        sup.reconcile(&db, &id).await.unwrap();
        assert!(sup.record(&id, P1, at).await.is_none());
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
                pair(res(0, Verdict::Ok))
            }
        };
        let token = CancellationToken::new();
        let h = tokio::spawn(panel_loop(
            Duration::from_secs(10),
            BUFFER_CAP,
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
                pair(res(0, Verdict::Ok))
            }
        };
        let token = CancellationToken::new();
        let h = tokio::spawn(panel_loop(
            Duration::from_secs(2),
            BUFFER_CAP,
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
                pair(res(k as i64, Verdict::Ok))
            }
        };
        let buf = new_buf();
        let token = CancellationToken::new();
        let h = tokio::spawn(panel_loop(
            Duration::from_secs(1),
            BUFFER_CAP,
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
                pair(res(0, Verdict::Ok))
            }
        };
        let token = CancellationToken::new();
        let h = tokio::spawn(panel_loop(
            Duration::from_secs(1),
            BUFFER_CAP,
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
                pair(res(0, Verdict::Ok))
            }
        };
        let buf = new_buf();
        let token = CancellationToken::new();
        let h = tokio::spawn(panel_loop(
            Duration::from_secs(1),
            BUFFER_CAP,
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

    // ---- 지금 점검 깨우기 (paused time) ----

    /// 점검이 `dur` 동안 돌고 시작 시각을 남기는 칸 1개 루프.
    fn spawn_kick_loop(
        interval: Duration,
        dur: Duration,
    ) -> (
        Starts,
        Arc<tokio::sync::Notify>,
        CancellationToken,
        JoinHandle<()>,
    ) {
        let t0 = Instant::now();
        let starts: Starts = Arc::default();
        let s2 = starts.clone();
        let check = move || {
            let s = s2.clone();
            async move {
                s.lock().unwrap().push(t0.elapsed());
                tokio::time::sleep(dur).await;
                pair(res(0, Verdict::Ok))
            }
        };
        let kick = Arc::new(tokio::sync::Notify::new());
        let token = CancellationToken::new();
        let h = tokio::spawn(panel_loop_kick(
            interval,
            BUFFER_CAP,
            check,
            new_buf(),
            token.clone(),
            kick.clone(),
        ));
        (starts, kick, token, h)
    }

    fn secs(v: &[u64]) -> Vec<Duration> {
        v.iter().map(|s| Duration::from_secs(*s)).collect()
    }

    async fn stop_and_starts(
        starts: &Starts,
        token: CancellationToken,
        h: JoinHandle<()>,
    ) -> Vec<Duration> {
        token.cancel();
        h.await.unwrap();
        starts.lock().unwrap().clone()
    }

    #[tokio::test(start_paused = true)]
    async fn kick_while_waiting_runs_early_and_resets_schedule() {
        // 규칙 1·5: 주기 60초, 점검 1초. 10초에 깨우면 10초에 시작, 다음 정기는 70초.
        let (starts, kick, token, h) =
            spawn_kick_loop(Duration::from_secs(60), Duration::from_secs(1));
        tokio::time::sleep(Duration::from_secs(10)).await;
        kick.notify_waiters();
        tokio::time::sleep(Duration::from_millis(65_500)).await; // t = 75.5초
        assert_eq!(stop_and_starts(&starts, token, h).await, secs(&[0, 10, 70]));
    }

    #[tokio::test(start_paused = true)]
    async fn kick_respects_min_gap() {
        // 규칙 2: 점검 0.1초, 0.3초에 깨우면 다음 시작은 정확히 1초(버리지 않고 미룬다).
        let (starts, kick, token, h) =
            spawn_kick_loop(Duration::from_secs(60), Duration::from_millis(100));
        tokio::time::sleep(Duration::from_millis(300)).await;
        kick.notify_waiters();
        tokio::time::sleep(Duration::from_millis(4_700)).await; // t = 5초
        assert_eq!(stop_and_starts(&starts, token, h).await, secs(&[0, 1]));
    }

    #[tokio::test(start_paused = true)]
    async fn kick_during_check_is_dropped() {
        // 규칙 3: 점검 5초, 2초(점검 중)에 깨움 → 추가 회차 없음, 다음은 정기 60초.
        let (starts, kick, token, h) =
            spawn_kick_loop(Duration::from_secs(60), Duration::from_secs(5));
        tokio::time::sleep(Duration::from_secs(2)).await;
        kick.notify_waiters();
        tokio::time::sleep(Duration::from_millis(63_500)).await; // t = 65.5초
        assert_eq!(stop_and_starts(&starts, token, h).await, secs(&[0, 60]));
    }

    #[tokio::test(start_paused = true)]
    async fn repeated_kicks_while_waiting_run_once() {
        // 규칙 4: 대기 중 연달아 3번 → 1회.
        let (starts, kick, token, h) =
            spawn_kick_loop(Duration::from_secs(60), Duration::from_millis(100));
        tokio::time::sleep(Duration::from_secs(10)).await;
        kick.notify_waiters();
        kick.notify_waiters();
        kick.notify_waiters();
        tokio::time::sleep(Duration::from_secs(20)).await; // t = 30초
        assert_eq!(stop_and_starts(&starts, token, h).await, secs(&[0, 10]));
    }

    #[tokio::test(start_paused = true)]
    async fn kicks_never_beat_one_second_interval() {
        // 주기 1초: 0.3초·1.3초·2.3초에 깨워도 시작 간격은 1초 그대로.
        let (starts, kick, token, h) =
            spawn_kick_loop(Duration::from_secs(1), Duration::from_millis(100));
        for _ in 0..3 {
            tokio::time::sleep(Duration::from_millis(300)).await;
            kick.notify_waiters();
            tokio::time::sleep(Duration::from_millis(700)).await;
        }
        tokio::time::sleep(Duration::from_millis(500)).await; // t = 3.5초
        assert_eq!(
            stop_and_starts(&starts, token, h).await,
            secs(&[0, 1, 2, 3])
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_while_waiting_for_min_gap_stops_at_once() {
        // 깨운 뒤 바닥(1초)을 기다리는 중 취소 → 다음 회차 없이 끝난다.
        let (starts, kick, token, h) =
            spawn_kick_loop(Duration::from_secs(60), Duration::from_millis(100));
        tokio::time::sleep(Duration::from_millis(300)).await;
        kick.notify_waiters();
        tokio::time::sleep(Duration::from_millis(200)).await; // t = 0.5초 — 바닥 대기 중
        token.cancel();
        tokio::time::timeout(Duration::from_millis(1), h)
            .await
            .expect("루프가 즉시 끝나야 한다")
            .unwrap();
        assert_eq!(starts.lock().unwrap().clone(), secs(&[0]));
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
                    pair(res(0, Verdict::Ok))
                })
            };
            handles.push(tokio::spawn(panel_loop(
                Duration::from_secs(1),
                BUFFER_CAP,
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

    #[test]
    fn consecutive_fail_stops_at_new_states() {
        let v = vec![
            res(0, Verdict::Fail),
            res(1, Verdict::Fail),
            res(2, Verdict::UpstreamFailed),
        ];
        assert_eq!(consecutive_fail(&v), (0, None));
        let v = vec![
            res(0, Verdict::BranchSkipped),
            res(1, Verdict::Fail),
            res(2, Verdict::ConfigError),
        ];
        assert_eq!(consecutive_fail(&v), (2, Some(1)));
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

    // ---- 실행 단위 (점검 묶음 spec §4) ----

    const G1: &str = "01J000000000000000000000G1";
    const S1: &str = "01J000000000000000000000S1";
    const S2: &str = "01J000000000000000000000S2";

    fn group(id: &str, scenario_id: &str) -> crate::monitor::config::CheckGroup {
        crate::monitor::config::CheckGroup {
            id: id.into(),
            scenario_id: scenario_id.into(),
            environment_id: None,
            interval_seconds: 1,
        }
    }

    fn step_panel(id: &str, scenario_id: &str, group_id: Option<&str>, step: &str) -> PanelConfig {
        PanelConfig {
            id: id.into(),
            title: "t".into(),
            scenario_id: scenario_id.into(),
            interval_seconds: 1,
            group_id: group_id.map(Into::into),
            step_id: Some(step.into()),
            ..PanelConfig::default()
        }
    }

    async fn enabled_cfg(db: &Db, cfg: &BoardConfig) -> String {
        let row = monitor_boards::insert(db, "b", cfg).await.unwrap();
        monitor_boards::set_enabled(db, &row.id, true)
            .await
            .unwrap();
        row.id
    }

    /// `url`로 GET하는 스텝 하나(`S1`)짜리 시나리오를 DB에 넣는다.
    async fn insert_scenario(db: &Db, url: &str) -> String {
        let yaml = format!(
            "version: 1\nname: s\nsteps:\n  - id: \"{S1}\"\n    name: s1\n    type: http\n    request: {{ method: GET, url: \"{url}\" }}\n"
        );
        let sc = handicap_engine::Scenario::from_yaml(&yaml).unwrap();
        store::scenarios::insert(db, &sc, &yaml).await.unwrap().id
    }

    fn view_buf(sup: &MonitorSupervisor, board_id: &str, panel_id: &str) -> SharedBuf {
        let slot = sup.existing_slot(board_id).unwrap();
        let view = lock(&slot.view);
        view.as_ref().unwrap().bufs[panel_id].clone()
    }

    #[tokio::test(start_paused = true)]
    async fn unit_loop_pushes_all_members_same_at() {
        let n = Arc::new(AtomicU64::new(0));
        let n2 = n.clone();
        let check = move || {
            let n = n2.clone();
            async move {
                let k = n.fetch_add(1, Ordering::SeqCst) as i64 + 1;
                let a = pair(res(k * 1000, Verdict::Ok));
                let b = pair(res(k * 1000, Verdict::Fail));
                (vec![a, b], 41)
            }
        };
        let (b1, b2) = (new_buf(), new_buf());
        let token = CancellationToken::new();
        let h = tokio::spawn(unit_loop(
            Duration::from_secs(10),
            vec![(b1.clone(), 5), (b2.clone(), 5)],
            check,
            token.clone(),
            Arc::new(tokio::sync::Notify::new()),
        ));
        tokio::time::sleep(Duration::from_millis(500)).await;
        token.cancel();
        h.await.unwrap();
        assert_eq!(n.load(Ordering::SeqCst), 1);
        let (r1, r2) = (buf_results(&b1), buf_results(&b2));
        assert_eq!((r1.len(), r2.len()), (1, 1));
        assert_eq!(r1[0].at_ms, r2[0].at_ms);
        // members 순서대로 결과가 들어간다.
        assert_eq!(r1[0].verdict, Verdict::Ok);
        assert_eq!(r2[0].verdict, Verdict::Fail);
        for b in [&b1, &b2] {
            let g = b.lock().unwrap();
            assert_eq!(g.budget_secs, 41);
            assert_eq!(g.records.len(), 1);
            assert!(!g.running);
        }
    }

    #[tokio::test]
    async fn mixed_board_runs_whole_and_unit() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let cfg = BoardConfig {
            groups: vec![group(G1, "no-such-scenario")],
            panels: vec![
                step_panel(P1, "no-such-scenario", Some(G1), S1),
                step_panel(P2, "no-such-scenario", Some(G1), S2),
                panel(P3),
            ],
            ..BoardConfig::default()
        };
        let id = enabled_cfg(&db, &cfg).await;
        sup.reconcile(&db, &id).await.unwrap();
        let snap = wait_results(&sup, &id, &[P1, P2, P3]).await;
        // 묶음 1개 + 흐름 전체 칸 1개 = task 2개(칸별이면 3).
        assert_eq!(sup.live_task_count(&id), 2);
        assert_eq!(snap.panels[P1].budget_secs, 152);
        assert_eq!(snap.panels[P2].budget_secs, 152);
        assert_eq!(snap.panels[P3].budget_secs, panel(P3).timeout_seconds);
        assert_eq!(snap.panels[P3].results[0].verdict, Verdict::ConfigError);
        sup.stop_all().await;
    }

    #[tokio::test]
    async fn reconcile_resets_budget() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::any())
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_delay(Duration::from_millis(1500)),
            )
            .mount(&server)
            .await;
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sid = insert_scenario(&db, &server.uri()).await;
        let sup = MonitorSupervisor::default();
        let cfg = BoardConfig {
            panels: vec![step_panel(P1, &sid, None, S1)],
            ..BoardConfig::default()
        };
        let id = enabled_cfg(&db, &cfg).await;
        sup.reconcile(&db, &id).await.unwrap();
        let first = wait_results(&sup, &id, &[P1]).await;
        // 실제 회차가 계산한 예산 = 흐름 상한(칸 5초) + 32.
        assert_eq!(first.panels[P1].budget_secs, 37);
        view_buf(&sup, &id, P1).lock().unwrap().budget_secs = 41;

        // 다음 회차(1.5초 지연)가 끝나기 전에 스냅샷 — reconcile이 초기값으로 되돌렸어야 한다.
        sup.reconcile(&db, &id).await.unwrap();
        let snap = sup.snapshot(&id).await.unwrap();
        assert_eq!(snap.panels[P1].budget_secs, 152);
        assert!(!snap.panels[P1].results.is_empty(), "results kept");
        sup.stop_all().await;
    }

    #[tokio::test]
    async fn record_lookup_group_member() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::any())
            .respond_with(wiremock::ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sid = insert_scenario(&db, &server.uri()).await;
        let sup = MonitorSupervisor::default();
        // P2의 스텝(S2)은 시나리오에 없다 → 그 칸만 설정 오류, P1은 정상 판정(칸마다 다른 결과).
        let cfg = BoardConfig {
            groups: vec![group(G1, &sid)],
            panels: vec![
                step_panel(P1, &sid, Some(G1), S1),
                step_panel(P2, &sid, Some(G1), S2),
            ],
            ..BoardConfig::default()
        };
        let id = enabled_cfg(&db, &cfg).await;
        sup.reconcile(&db, &id).await.unwrap();
        let snap = wait_results(&sup, &id, &[P1, P2]).await;
        let at = snap.panels[P1].results[0].at_ms;
        assert_eq!(
            snap.panels[P2].results[0].at_ms, at,
            "same round, same at_ms"
        );

        let a = sup.record(&id, P1, at).await.expect("P1 record");
        let b = sup.record(&id, P2, at).await.expect("P2 record");
        assert_eq!(a.result, snap.panels[P1].results[0]);
        assert_eq!(b.result, snap.panels[P2].results[0]);
        assert_ne!(a.result.verdict, Verdict::ConfigError);
        assert_eq!(b.result.verdict, Verdict::ConfigError);
        assert!(Arc::ptr_eq(&a.body, &b.body), "trace body shared");
        assert!(a.body.trace.is_some());
        sup.stop_all().await;
    }

    // ---- check_now ----

    #[tokio::test]
    async fn check_now_off_and_no_panel() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        // 모르는 보드: Off, 슬롯을 만들지 않는다.
        assert_eq!(sup.check_now("nope", P1), CheckNow::Off);
        assert!(sup.existing_slot("nope").is_none());
        // 꺼진 보드(reconcile 전 = 실행 중 아님): Off.
        let row = monitor_boards::insert(&db, "off", &board(&[P1]))
            .await
            .unwrap();
        assert_eq!(sup.check_now(&row.id, P1), CheckNow::Off);
        // 켜진 보드의 없는 칸: NoPanel.
        let id = enabled_board(&db, "on", &[P1]).await;
        sup.reconcile(&db, &id).await.unwrap();
        wait_results(&sup, &id, &[P1]).await;
        assert_eq!(sup.check_now(&id, P2), CheckNow::NoPanel);
        // 슬롯은 있는데 `view`가 `None`(켜졌다 꺼진 보드): 뒷 갈래의 Off.
        monitor_boards::set_enabled(&db, &id, false).await.unwrap();
        sup.reconcile(&db, &id).await.unwrap();
        assert!(sup.existing_slot(&id).is_some());
        assert!(lock(&sup.existing_slot(&id).unwrap().view).is_none());
        assert_eq!(sup.check_now(&id, P1), CheckNow::Off);
    }

    #[tokio::test]
    async fn check_now_runs_long_interval_panel_early() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let mut cfg = board(&[P1]);
        cfg.panels[0].interval_seconds = 3600;
        let id = enabled_cfg(&db, &cfg).await;
        sup.reconcile(&db, &id).await.unwrap();
        // 순서 전제: 첫 결과가 들어온 뒤에 요청한다(점검 중 요청은 버려진다 — 규칙 3).
        let first = wait_results(&sup, &id, &[P1]).await;
        let last = first.panels[P1].results.last().unwrap().at_ms;
        assert_eq!(
            sup.check_now(&id, P1),
            CheckNow::Requested {
                last_at_ms: Some(last)
            }
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let s = sup.snapshot(&id).await.unwrap();
            if s.panels[P1].results.len() == 2 {
                assert!(s.panels[P1].results[1].at_ms > last);
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "지금 점검 회차가 오지 않음"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn check_now_group_runs_all_members_once() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let mut g = group(G1, "no-such-scenario");
        g.interval_seconds = 3600;
        let cfg = BoardConfig {
            groups: vec![g],
            panels: vec![
                step_panel(P1, "no-such-scenario", Some(G1), S1),
                step_panel(P2, "no-such-scenario", Some(G1), S2),
            ],
            ..BoardConfig::default()
        };
        let id = enabled_cfg(&db, &cfg).await;
        sup.reconcile(&db, &id).await.unwrap();
        wait_results(&sup, &id, &[P1, P2]).await;
        assert!(matches!(sup.check_now(&id, P2), CheckNow::Requested { .. }));
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let s = sup.snapshot(&id).await.unwrap();
            let (a, b) = (&s.panels[P1].results, &s.panels[P2].results);
            if a.len() == 2 && b.len() == 2 {
                assert_eq!(a[1].at_ms, b[1].at_ms, "묶음은 한 회차를 나눠 쓴다");
                break;
            }
            assert!(a.len() <= 2 && b.len() <= 2, "한 번만 돌아야 한다");
            assert!(
                std::time::Instant::now() < deadline,
                "묶음 회차가 오지 않음"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn check_now_during_running_check_adds_no_round() {
        // 규칙 3의 **실제 호출 경로** 가드: `check_now`가 `notify_one`(허가 저장)을 쓰면 점검이 끝난 뒤 한 번 더 돈다.
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::any())
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_delay(Duration::from_millis(1500)),
            )
            .mount(&server)
            .await;
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sup = MonitorSupervisor::default();
        let sid = insert_scenario(&db, &server.uri()).await;
        let mut cfg = board(&[P1]);
        cfg.panels[0].scenario_id = sid;
        cfg.panels[0].interval_seconds = 3600;
        let id = enabled_cfg(&db, &cfg).await;
        sup.reconcile(&db, &id).await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await; // 첫 점검(1.5초)이 도는 중
        assert!(sup.snapshot(&id).await.unwrap().panels[P1].running);
        assert_eq!(
            sup.check_now(&id, P1),
            CheckNow::Requested { last_at_ms: None }
        );
        wait_results(&sup, &id, &[P1]).await;
        tokio::time::sleep(Duration::from_millis(2500)).await; // 바닥 1초가 지나고도 남는 시간
        assert_eq!(
            sup.snapshot(&id).await.unwrap().panels[P1].results.len(),
            1,
            "점검 중 요청은 회차를 예약하지 않는다"
        );
    }
}
