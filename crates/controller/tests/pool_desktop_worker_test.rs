#![cfg(feature = "in-process")]
//! 데스크톱 풀 진입점 `run_pool_desktop`: 탐침·포기 없는 재시도·상태 사건을 진짜 풀 컨트롤러에 붙여 검증한다.
//! 사건은 모아 두고, 조건이 참이 될 때까지 기한 안에서 폴링한다(고정 sleep으로 단언하지 않는다).

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use handicap_controller::in_process::{
    InProcessConfig, InProcessWorkerMode, RunningController, run_in_process,
};
use handicap_worker::pool_status::{EventSink, FailReason, PoolEvent};
use handicap_worker::{PoolTarget, run_pool_desktop};
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::any;
use wiremock::{Mock, MockServer, ResponseTemplate};

const TOKEN: &str = "t";
const WORKER_ID: &str = "desk-w1";

type Events = Arc<Mutex<Vec<(tokio::time::Instant, PoolEvent)>>>;

fn tmp_db() -> String {
    let tmp = tempfile::tempdir().unwrap();
    let p = tmp.path().join("c.db").display().to_string();
    std::mem::forget(tmp);
    p
}

fn free_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

async fn start_pool(grpc_port: u16) -> RunningController {
    run_in_process(InProcessConfig {
        db: Some(tmp_db()),
        scheduler_disabled: true,
        worker_mode: InProcessWorkerMode::Pool,
        worker_token: Some(TOKEN.into()),
        grpc: SocketAddr::from(([127, 0, 0, 1], grpc_port)),
        grpc_port_fallback: false,
        ..InProcessConfig::default()
    })
    .await
    .expect("start pool controller")
}

struct Desk {
    events: Events,
    cancel: CancellationToken,
    handle: JoinHandle<anyhow::Result<()>>,
}

fn spawn_desktop(port: u16, token: &str) -> Desk {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink_events = events.clone();
    let sink: EventSink = Arc::new(move |ev| {
        sink_events
            .lock()
            .unwrap()
            .push((tokio::time::Instant::now(), ev));
    });
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(run_pool_desktop(
        PoolTarget {
            ips: vec![Ipv4Addr::LOCALHOST],
            port,
            token: token.into(),
            worker_id: WORKER_ID.into(),
            capacity_vus: 10,
        },
        cancel.clone(),
        sink,
    ));
    Desk {
        events,
        cancel,
        handle,
    }
}

impl Desk {
    fn snapshot(&self) -> Vec<PoolEvent> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .map(|(_, e)| e.clone())
            .collect()
    }

    /// 조건이 참이 되면 true, 기한이 지나면 false. 한 번 더 확인해 경계 경쟁을 없앤다.
    async fn wait_until(&self, within: Duration, pred: impl Fn(&[PoolEvent]) -> bool) -> bool {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            if pred(&self.snapshot()) {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return pred(&self.snapshot());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn stop(self) {
        self.cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(10), self.handle).await;
    }
}

fn count(evs: &[PoolEvent], f: impl Fn(&PoolEvent) -> bool) -> usize {
    evs.iter().filter(|e| f(e)).count()
}

fn accepted_count(evs: &[PoolEvent]) -> usize {
    count(evs, |e| matches!(e, PoolEvent::Accepted { .. }))
}

fn rest(rc: &RunningController, path: &str) -> String {
    format!("http://{}{}", rc.rest_addr(), path)
}

async fn pool_worker(rc: &RunningController) -> Option<Value> {
    let v: Value = reqwest::get(rest(rc, "/api/pool/workers"))
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    v["workers"]
        .as_array()?
        .iter()
        .find(|w| w["worker_id"] == WORKER_ID)
        .cloned()
}

/// `Accepted` 직후엔 Ping이 풀 등록보다 먼저라 아직 풀에 없을 수 있다 — REST로 무언가 하기 전에 호출.
async fn wait_pool_idle(rc: &RunningController) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(w) = pool_worker(rc).await {
            if w["busy"] == false {
                return w;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "worker never appeared idle in the pool"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn target() -> MockServer {
    let s = MockServer::start().await;
    Mock::given(any())
        .respond_with(ResponseTemplate::new(200))
        .mount(&s)
        .await;
    s
}

async fn create_scenario(rc: &RunningController, name: &str, base: &str) -> String {
    let yaml = format!(
        "version: 1\nname: {name}\nsteps:\n  - id: root\n    name: GET /\n    type: http\n    request:\n      method: GET\n      url: \"{base}/\"\n"
    );
    let resp = reqwest::Client::new()
        .post(rest(rc, "/api/scenarios"))
        .json(&json!({ "yaml": yaml }))
        .send()
        .await
        .unwrap();
    assert!(
        resp.status().is_success(),
        "create scenario: {}",
        resp.status()
    );
    let v: Value = resp.json().await.unwrap();
    v["id"].as_str().unwrap().to_string()
}

async fn start_run(rc: &RunningController, scenario_id: &str, seconds: u32) {
    let resp = reqwest::Client::new()
        .post(rest(rc, "/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 1, "duration_seconds": seconds },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "create run: {}", resp.status());
}

async fn exclude(rc: &RunningController) {
    let resp = reqwest::Client::new()
        .post(rest(rc, &format!("/api/pool/workers/{WORKER_ID}/exclude")))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "exclude: {}", resp.status());
}

const WAIT: Duration = Duration::from_secs(10);

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn events_idle_run_idle() {
    let port = free_port();
    let rc = start_pool(port).await;
    let t = target().await;
    let desk = spawn_desktop(port, TOKEN);
    assert!(
        desk.wait_until(WAIT, |e| accepted_count(e) >= 1).await,
        "{:?}",
        desk.snapshot()
    );
    wait_pool_idle(&rc).await;
    let sid = create_scenario(&rc, "lv-desktop", &t.uri()).await;
    start_run(&rc, &sid, 1).await;
    assert!(
        desk.wait_until(Duration::from_secs(20), |e| accepted_count(e) >= 2
            && e.iter().any(|x| matches!(x, PoolEvent::RunEnded)))
            .await,
        "{:?}",
        desk.snapshot()
    );
    let evs = desk.snapshot();
    assert!(
        matches!(evs[0], PoolEvent::Probing { candidates: 1 }),
        "{evs:?}"
    );
    let pos = |f: &dyn Fn(&PoolEvent) -> bool| evs.iter().position(f).unwrap();
    let first_acc = pos(&|e| matches!(e, PoolEvent::Accepted { .. }));
    let started = pos(&|e| matches!(e, PoolEvent::RunStarted { .. }));
    let ended = pos(&|e| matches!(e, PoolEvent::RunEnded));
    let second_acc = evs
        .iter()
        .enumerate()
        .filter(|(_, e)| matches!(e, PoolEvent::Accepted { .. }))
        .nth(1)
        .unwrap()
        .0;
    assert!(
        first_acc < started && started < ended && ended < second_acc,
        "{evs:?}"
    );
    match &evs[started] {
        PoolEvent::RunStarted { scenario_name, .. } => {
            assert_eq!(scenario_name.as_deref(), Some("lv-desktop"))
        }
        _ => unreachable!(),
    }
    desk.stop().await;
    rc.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scenario_name_is_clipped_to_80() {
    let port = free_port();
    let rc = start_pool(port).await;
    let t = target().await;
    let desk = spawn_desktop(port, TOKEN);
    assert!(desk.wait_until(WAIT, |e| accepted_count(e) >= 1).await);
    wait_pool_idle(&rc).await;
    let sid = create_scenario(&rc, &"가".repeat(100), &t.uri()).await;
    start_run(&rc, &sid, 1).await;
    assert!(
        desk.wait_until(Duration::from_secs(20), |e| e
            .iter()
            .any(|x| matches!(x, PoolEvent::RunStarted { .. })))
            .await
    );
    let name = desk
        .snapshot()
        .into_iter()
        .find_map(|e| match e {
            PoolEvent::RunStarted { scenario_name, .. } => scenario_name,
            _ => None,
        })
        .expect("scenario name present");
    assert_eq!(name.chars().count(), 80);
    desk.stop().await;
    rc.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wrong_token_reports_auth_failed() {
    let port = free_port();
    let rc = start_pool(port).await;
    let desk = spawn_desktop(port, "x");
    let is_auth = |e: &PoolEvent| {
        matches!(
            e,
            PoolEvent::AttemptFailed {
                reason: FailReason::AuthFailed,
                ..
            }
        )
    };
    assert!(
        desk.wait_until(Duration::from_secs(3), |e| e.iter().any(is_auth))
            .await,
        "{:?}",
        desk.snapshot()
    );
    assert!(
        desk.wait_until(Duration::from_secs(8), |e| count(e, is_auth) >= 2)
            .await,
        "{:?}",
        desk.snapshot()
    );
    assert_eq!(accepted_count(&desk.snapshot()), 0);
    desk.stop().await;
    rc.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unreachable_reports_within_probe_timeout() {
    let desk = spawn_desktop(free_port(), TOKEN);
    assert!(
        desk.wait_until(Duration::from_secs(3), |e| e.iter().any(|x| matches!(
            x,
            PoolEvent::AttemptFailed {
                reason: FailReason::Unreachable,
                ..
            }
        )))
        .await,
        "{:?}",
        desk.snapshot()
    );
    desk.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retry_counter_resets_after_accept() {
    let port = free_port();
    let desk = spawn_desktop(port, TOKEN);
    let retry = |s: u64| {
        move |e: &[PoolEvent]| {
            e.iter().any(|x| {
                matches!(x, PoolEvent::AttemptFailed { retry_in, .. } if *retry_in == Duration::from_secs(s))
            })
        }
    };
    assert!(desk.wait_until(WAIT, retry(1)).await);
    assert!(desk.wait_until(WAIT, retry(2)).await);
    let rc = start_pool(port).await;
    assert!(
        desk.wait_until(WAIT, |e| accepted_count(e) >= 1).await,
        "{:?}",
        desk.snapshot()
    );
    wait_pool_idle(&rc).await;
    rc.shutdown().await;
    assert!(
        desk.wait_until(WAIT, |e| e
            .iter()
            .any(|x| matches!(x, PoolEvent::SessionLost { .. })))
            .await,
        "{:?}",
        desk.snapshot()
    );
    // SessionLost 뒤 첫 실패: 리셋 뒤 SessionLost 대기가 index 0, 이 실패가 index 1 → 2s.
    assert!(
        desk.wait_until(WAIT, |e| {
            let lost = e
                .iter()
                .position(|x| matches!(x, PoolEvent::SessionLost { .. }))
                .unwrap();
            e[lost..]
                .iter()
                .any(|x| matches!(x, PoolEvent::AttemptFailed { .. }))
        })
        .await,
        "{:?}",
        desk.snapshot()
    );
    let evs = desk.snapshot();
    let lost = evs
        .iter()
        .position(|x| matches!(x, PoolEvent::SessionLost { .. }))
        .unwrap();
    let next = evs[lost..]
        .iter()
        .find_map(|x| match x {
            PoolEvent::AttemptFailed { retry_in, .. } => Some(*retry_in),
            _ => None,
        })
        .unwrap();
    assert_eq!(next, Duration::from_secs(2), "{evs:?}");
    desk.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn controller_restart_emits_session_lost_then_accepted() {
    let port = free_port();
    let rc = start_pool(port).await;
    let desk = spawn_desktop(port, TOKEN);
    assert!(desk.wait_until(WAIT, |e| accepted_count(e) >= 1).await);
    wait_pool_idle(&rc).await;
    tokio::time::timeout(Duration::from_secs(15), rc.shutdown())
        .await
        .expect("shutdown must not hang");
    drop(rc);
    let rc2 = start_pool(port).await;
    assert!(
        desk.wait_until(Duration::from_secs(15), |e| {
            match e
                .iter()
                .position(|x| matches!(x, PoolEvent::SessionLost { .. }))
            {
                Some(i) => accepted_count(&e[i..]) >= 1,
                None => false,
            }
        })
        .await,
        "{:?}",
        desk.snapshot()
    );
    desk.stop().await;
    rc2.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn excluded_while_idle_emits_excluded() {
    let port = free_port();
    let rc = start_pool(port).await;
    let mut desk = spawn_desktop(port, TOKEN);
    assert!(desk.wait_until(WAIT, |e| accepted_count(e) >= 1).await);
    wait_pool_idle(&rc).await;
    exclude(&rc).await;
    assert!(
        desk.wait_until(WAIT, |e| e.iter().any(|x| matches!(x, PoolEvent::Excluded)))
            .await,
        "{:?}",
        desk.snapshot()
    );
    let res = tokio::time::timeout(Duration::from_secs(5), &mut desk.handle)
        .await
        .expect("function must return after Excluded");
    assert!(res.unwrap().is_ok());
    rc.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn excluded_while_running_emits_excluded() {
    let port = free_port();
    let rc = start_pool(port).await;
    let t = target().await;
    let mut desk = spawn_desktop(port, TOKEN);
    assert!(desk.wait_until(WAIT, |e| accepted_count(e) >= 1).await);
    wait_pool_idle(&rc).await;
    let sid = create_scenario(&rc, "lv-desktop", &t.uri()).await;
    start_run(&rc, &sid, 30).await;
    assert!(
        desk.wait_until(WAIT, |e| e
            .iter()
            .any(|x| matches!(x, PoolEvent::RunStarted { .. })))
            .await,
        "{:?}",
        desk.snapshot()
    );
    exclude(&rc).await;
    assert!(
        desk.wait_until(WAIT, |e| e.iter().any(|x| matches!(x, PoolEvent::Excluded)))
            .await,
        "{:?}",
        desk.snapshot()
    );
    let res = tokio::time::timeout(Duration::from_secs(10), &mut desk.handle)
        .await
        .expect("function must return after Excluded");
    assert!(res.unwrap().is_ok());
    let evs = desk.snapshot();
    assert!(matches!(evs.last(), Some(PoolEvent::Excluded)), "{evs:?}");
    let started = evs
        .iter()
        .position(|x| matches!(x, PoolEvent::RunStarted { .. }))
        .unwrap();
    assert!(
        !evs[started..]
            .iter()
            .any(|x| matches!(x, PoolEvent::RunEnded)),
        "{evs:?}"
    );
    rc.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_returns_without_excluded() {
    let port = free_port();
    let rc = start_pool(port).await;
    let mut desk = spawn_desktop(port, TOKEN);
    assert!(desk.wait_until(WAIT, |e| accepted_count(e) >= 1).await);
    desk.cancel.cancel();
    let res = tokio::time::timeout(Duration::from_secs(10), &mut desk.handle)
        .await
        .expect("function must return after cancel");
    assert!(res.unwrap().is_ok());
    assert!(
        !desk
            .snapshot()
            .iter()
            .any(|x| matches!(x, PoolEvent::Excluded))
    );
    rc.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn worker_id_is_stable() {
    let port = free_port();
    let rc = start_pool(port).await;
    let desk = spawn_desktop(port, TOKEN);
    assert!(desk.wait_until(WAIT, |e| accepted_count(e) >= 1).await);
    let w = wait_pool_idle(&rc).await;
    assert_eq!(w["stable"], true);
    assert_eq!(w["worker_id"], WORKER_ID);
    desk.stop().await;
    rc.shutdown().await;
}
