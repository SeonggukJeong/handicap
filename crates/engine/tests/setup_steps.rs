//! 준비 스텝(setup) closed-loop 배선: VU당 한 번 실행, 추출·쿠키 이어받기, 실패 VU, 전용 통계.
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use handicap_engine::{
    BindingPolicy, DataSet, EngineError, MetricFlush, RampDown, RunPlan, Scenario, Stage,
    run_scenario, run_scenario_open_loop, run_scenario_vu_curve,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const LOGIN_ID: &str = "01HX0000000000000000000001";
const ORDERS_ID: &str = "01HX0000000000000000000002";

#[derive(Clone, Copy)]
enum Mode {
    Closed,
    Curve,
    Open,
}

#[derive(Default)]
struct Seen {
    issued: Mutex<Vec<String>>,
    logins: AtomicUsize,
    orders_ok: AtomicUsize,
    orders_bad: AtomicUsize,
    order_tokens: Mutex<Vec<String>>,
}

struct Login(Arc<Seen>);

impl Respond for Login {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let n = self.0.logins.fetch_add(1, Ordering::SeqCst);
        let body = String::from_utf8_lossy(&req.body).to_string();
        if body.contains("user=bad") {
            return ResponseTemplate::new(401);
        }
        let token = format!("tok-{n}");
        self.0.issued.lock().unwrap().push(token.clone());
        ResponseTemplate::new(200)
            .set_body_json(serde_json::json!({ "token": token, "n": "from-setup" }))
    }
}

struct Orders(Arc<Seen>);

impl Respond for Orders {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let auth = req
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let token = auth.strip_prefix("Bearer ").unwrap_or("").to_string();
        let valid = self.0.issued.lock().unwrap().contains(&token);
        self.0.order_tokens.lock().unwrap().push(token);
        if valid {
            self.0.orders_ok.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(200)
        } else {
            self.0.orders_bad.fetch_add(1, Ordering::SeqCst);
            ResponseTemplate::new(401)
        }
    }
}

async fn server_with(seen: &Arc<Seen>) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/login"))
        .respond_with(Login(seen.clone()))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/orders"))
        .respond_with(Orders(seen.clone()))
        .mount(&server)
        .await;
    server
}

const TEMPLATE: &str = r#"version: 1
name: t
variables:
  user: good
setup:
  steps:
    - type: http
      id: @LOGIN_ID@
      name: login
      request: { method: POST, url: "@URI@/login", body: { raw: "@LOGIN_BODY@" } }
      assert:
        - status: 200
      extract:
        - { from: body, var: token, path: "$.token" }
@EXTRA@
@SETUP_THINK@
steps:
  - type: http
    id: @ORDERS_ID@
    name: orders
    request:
      method: GET
      url: "@URI@/orders?u={{user}}&row={{n}}"
      headers: { Authorization: "Bearer {{token}}" }
    think_time: { min_ms: 100, max_ms: 100 }
"#;

struct Yaml {
    login_body: &'static str,
    extra_extract: &'static str,
    setup_think: &'static str,
    orders_url_row: bool,
}

impl Default for Yaml {
    fn default() -> Self {
        Self {
            login_body: "user={{user}}",
            extra_extract: "",
            setup_think: "",
            orders_url_row: false,
        }
    }
}

fn build_yaml(uri: &str, y: &Yaml) -> String {
    let mut out = TEMPLATE
        .replace("@URI@", uri)
        .replace("@LOGIN_ID@", LOGIN_ID)
        .replace("@ORDERS_ID@", ORDERS_ID)
        .replace("@LOGIN_BODY@", y.login_body)
        .replace("@EXTRA@", y.extra_extract)
        .replace("@SETUP_THINK@", y.setup_think);
    if !y.orders_url_row {
        out = out.replace("&row={{n}}", "");
    }
    out
}

fn row(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn dataset(policy: BindingPolicy, rows: Vec<BTreeMap<String, String>>) -> Arc<DataSet> {
    Arc::new(DataSet {
        policy,
        seed: 0,
        rows,
    })
}

fn plan(vus: u32, dur_ms: u64, bindings: Vec<Arc<DataSet>>) -> RunPlan {
    RunPlan {
        vus,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(dur_ms),
        env: Default::default(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_bindings: bindings,
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
        graceful_ramp_down: None,
        connect_timeout: None,
    }
}

async fn run(mode: Mode, yaml: &str, plan: RunPlan) -> (Result<(), EngineError>, Vec<MetricFlush>) {
    run_cancel_after(mode, yaml, plan, None).await
}

async fn run_cancel_after(
    mode: Mode,
    yaml: &str,
    plan: RunPlan,
    cancel_after: Option<Duration>,
) -> (Result<(), EngineError>, Vec<MetricFlush>) {
    let scenario = Arc::new(Scenario::from_yaml(yaml).unwrap());
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(256);
    let cancel = CancellationToken::new();
    if let Some(after) = cancel_after {
        let c = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(after).await;
            c.cancel();
        });
    }
    let h = match mode {
        Mode::Closed => tokio::spawn(run_scenario(scenario, plan, tx, cancel)),
        Mode::Curve => tokio::spawn(run_scenario_vu_curve(scenario, plan, tx, cancel)),
        Mode::Open => tokio::spawn(run_scenario_open_loop(scenario, plan, tx, cancel)),
    };
    let mut flushes = Vec::new();
    while let Some(f) = rx.recv().await {
        flushes.push(f);
    }
    (h.await.unwrap(), flushes)
}

fn curve_plan(stages: &[(u32, u32)], bindings: Vec<Arc<DataSet>>) -> RunPlan {
    let secs: u64 = stages.iter().map(|s| u64::from(s.1)).sum();
    let mut p = plan(0, secs * 1000, bindings);
    p.vu_stages = Some(
        stages
            .iter()
            .map(|&(target, duration_seconds)| Stage {
                target,
                duration_seconds,
            })
            .collect(),
    );
    p.ramp_down = RampDown::Immediate;
    p
}

fn open_plan(rps: u32, slots: u32, dur_ms: u64, bindings: Vec<Arc<DataSet>>) -> RunPlan {
    let mut p = plan(0, dur_ms, bindings);
    p.target_rps = Some(rps);
    p.max_in_flight = Some(slots);
    p
}

fn query_param(req: &Request, key: &str) -> Option<String> {
    req.url
        .query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.to_string())
}

#[tokio::test]
async fn closed_setup_runs_once_per_vu() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let (res, flushes) = run(Mode::Closed, &yaml, plan(3, 1500, vec![])).await;
    res.unwrap();
    assert_eq!(seen.logins.load(Ordering::SeqCst), 3);
    assert!(seen.orders_ok.load(Ordering::SeqCst) >= 3);
    assert_eq!(seen.orders_bad.load(Ordering::SeqCst), 0);
    assert!(
        flushes
            .iter()
            .flat_map(|f| &f.windows)
            .all(|w| w.step_id != LOGIN_ID)
    );
}

#[tokio::test]
async fn closed_main_steps_get_setup_token_every_iteration() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let (res, _) = run(Mode::Closed, &yaml, plan(1, 1500, vec![])).await;
    res.unwrap();
    let tokens = seen.order_tokens.lock().unwrap().clone();
    assert!(tokens.len() >= 2, "orders={}", tokens.len());
    assert!(
        tokens
            .iter()
            .all(|t| t == &tokens[0] && t.starts_with("tok-"))
    );
}

#[tokio::test]
async fn closed_cookie_carries_over() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/login"))
        .respond_with(ResponseTemplate::new(200).insert_header("Set-Cookie", "sid=abc; Path=/"))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/orders"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        r#"version: 1
name: t
setup:
  steps:
    - type: http
      id: {LOGIN_ID}
      name: login
      request: {{ method: POST, url: "{uri}/login" }}
      assert:
        - status: 200
steps:
  - type: http
    id: {ORDERS_ID}
    name: orders
    request: {{ method: GET, url: "{uri}/orders" }}
    think_time: {{ min_ms: 100, max_ms: 100 }}
"#,
        uri = server.uri()
    );
    let (res, _) = run(Mode::Closed, &yaml, plan(1, 1500, vec![])).await;
    res.unwrap();
    let received = server.received_requests().await.unwrap();
    let orders: Vec<_> = received
        .iter()
        .filter(|r| r.url.path() == "/orders")
        .collect();
    assert!(orders.len() >= 2);
    assert!(orders.iter().all(|r| {
        r.headers
            .get("cookie")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.contains("sid=abc"))
    }));
}

#[tokio::test]
async fn closed_failed_vu_sends_no_main_requests() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let ds = dataset(
        BindingPolicy::PerVu,
        vec![row(&[("user", "good")]), row(&[("user", "bad")])],
    );
    let (res, _) = run(Mode::Closed, &yaml, plan(2, 1500, vec![ds])).await;
    res.unwrap();
    assert_eq!(seen.logins.load(Ordering::SeqCst), 2);
    let received = server.received_requests().await.unwrap();
    let orders: Vec<_> = received
        .iter()
        .filter(|r| r.url.path() == "/orders")
        .collect();
    assert!(!orders.is_empty());
    assert!(
        orders
            .iter()
            .all(|r| query_param(r, "u").as_deref() == Some("good"))
    );
}

#[tokio::test]
async fn closed_all_failed_is_all_vus_failed() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let ds = dataset(BindingPolicy::PerVu, vec![row(&[("user", "bad")])]);
    let (res, flushes) = run(Mode::Closed, &yaml, plan(2, 1500, vec![ds])).await;
    let failed_outcomes: u64 = flushes
        .iter()
        .flat_map(|f| &f.section_outcomes)
        .map(|o| o.failed)
        .sum();
    assert_eq!(failed_outcomes, 2);
    match res {
        Err(EngineError::AllVusFailed {
            failed,
            total,
            cause,
        }) => {
            assert_eq!((failed, total), (2, 2));
            let cause = cause.expect("cause");
            assert!(cause.contains("준비 스텝"), "{cause}");
            assert!(cause.contains("status_assert"), "{cause}");
        }
        other => panic!("expected AllVusFailed, got {other:?}"),
    }
    assert_eq!(seen.orders_ok.load(Ordering::SeqCst), 0);
    assert_eq!(seen.orders_bad.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn first_iteration_reuses_selected_rows() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(
        &server.uri(),
        &Yaml {
            login_body: "user={{user}}&n={{n}}",
            orders_url_row: true,
            ..Yaml::default()
        },
    );
    let ds = dataset(
        BindingPolicy::IterSequential,
        (1..=4).map(|i| row(&[("n", &i.to_string())])).collect(),
    );
    let (res, _) = run(Mode::Closed, &yaml, plan(1, 1500, vec![ds])).await;
    res.unwrap();
    let received = server.received_requests().await.unwrap();
    let rows: Vec<usize> = received
        .iter()
        .filter(|r| r.url.path() == "/orders")
        .map(|r| query_param(r, "row").unwrap().parse().unwrap())
        .collect();
    assert!(rows.len() >= 5, "rows={rows:?}");
    for (i, r) in rows.iter().enumerate() {
        assert_eq!(*r, i % 4 + 1, "rows={rows:?}");
    }
    let login = received
        .iter()
        .find(|r| r.url.path() == "/login")
        .expect("login");
    assert!(String::from_utf8_lossy(&login.body).contains("n=1"));
}

#[tokio::test]
async fn dataset_wins_over_setup_extract_on_same_name() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(
        &server.uri(),
        &Yaml {
            extra_extract: "        - { from: body, var: n, path: \"$.n\" }",
            orders_url_row: true,
            login_body: "user={{user}}&n={{n}}",
            ..Yaml::default()
        },
    );
    let ds = dataset(BindingPolicy::PerVu, vec![row(&[("n", "ds")])]);
    let (res, _) = run(Mode::Closed, &yaml, plan(1, 1500, vec![ds])).await;
    res.unwrap();
    let received = server.received_requests().await.unwrap();
    let rows: Vec<String> = received
        .iter()
        .filter(|r| r.url.path() == "/orders")
        .map(|r| query_param(r, "row").unwrap())
        .collect();
    assert!(rows.len() >= 2, "rows={rows:?}");
    assert!(rows.iter().all(|r| r == "ds"), "rows={rows:?}");
}

#[tokio::test]
async fn section_stats_flushed() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let (res, flushes) = run(Mode::Closed, &yaml, plan(3, 1500, vec![])).await;
    res.unwrap();
    let count: u64 = flushes
        .iter()
        .flat_map(|f| &f.section_step_stats)
        .filter(|s| s.step_id == LOGIN_ID)
        .map(|s| s.count)
        .sum();
    assert_eq!(count, 3);
    let outcomes: Vec<_> = flushes.iter().flat_map(|f| &f.section_outcomes).collect();
    assert_eq!(outcomes.iter().map(|o| o.ok).sum::<u64>(), 3);
    assert_eq!(outcomes.iter().map(|o| o.failed).sum::<u64>(), 0);
    assert!(outcomes.iter().any(|o| o.last_done_ms.is_some()));
}

#[tokio::test]
async fn section_only_flush_is_sent() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(
        &server.uri(),
        &Yaml {
            setup_think: "      think_time: { min_ms: 1500, max_ms: 1500 }",
            ..Yaml::default()
        },
    );
    let (res, flushes) = run(Mode::Closed, &yaml, plan(1, 4000, vec![])).await;
    res.unwrap();
    assert!(
        flushes
            .iter()
            .any(|f| f.windows.is_empty() && !f.section_step_stats.is_empty()),
        "no section-only flush"
    );
}

#[tokio::test]
async fn no_setup_flush_has_no_section_stats() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = format!(
        r#"version: 1
name: t
variables:
  token: x
steps:
  - type: http
    id: {ORDERS_ID}
    name: orders
    request: {{ method: GET, url: "{}/orders" }}
    think_time: {{ min_ms: 100, max_ms: 100 }}
"#,
        server.uri()
    );
    let (res, flushes) = run(Mode::Closed, &yaml, plan(2, 1200, vec![])).await;
    res.unwrap();
    assert!(!flushes.is_empty());
    assert!(
        flushes
            .iter()
            .all(|f| f.section_step_stats.is_empty() && f.section_outcomes.is_empty())
    );
}

#[tokio::test]
async fn curve_setup_runs_once_per_activated_vu() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let (res, _) = run(
        Mode::Curve,
        &yaml,
        curve_plan(&[(3, 1), (1, 1), (3, 2)], vec![]),
    )
    .await;
    res.unwrap();
    assert_eq!(seen.logins.load(Ordering::SeqCst), 3);
    assert!(seen.orders_ok.load(Ordering::SeqCst) >= 3);
    assert_eq!(seen.orders_bad.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn curve_failed_vu_sends_no_main_requests() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let ds = dataset(
        BindingPolicy::PerVu,
        vec![row(&[("user", "good")]), row(&[("user", "bad")])],
    );
    let (res, _) = run(Mode::Curve, &yaml, curve_plan(&[(2, 1), (2, 2)], vec![ds])).await;
    res.unwrap();
    assert_eq!(seen.logins.load(Ordering::SeqCst), 2);
    let received = server.received_requests().await.unwrap();
    let orders: Vec<_> = received
        .iter()
        .filter(|r| r.url.path() == "/orders")
        .collect();
    assert!(!orders.is_empty());
    assert!(
        orders
            .iter()
            .all(|r| query_param(r, "u").as_deref() == Some("good"))
    );
}

#[tokio::test]
async fn curve_all_failed_is_all_vus_failed() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let ds = dataset(BindingPolicy::PerVu, vec![row(&[("user", "bad")])]);
    let (res, flushes) = run(Mode::Curve, &yaml, curve_plan(&[(2, 1), (2, 2)], vec![ds])).await;
    match res {
        Err(EngineError::AllVusFailed {
            failed,
            total,
            cause,
        }) => {
            assert_eq!((failed, total), (2, 2));
            let cause = cause.expect("cause");
            assert!(cause.contains("준비 스텝"), "{cause}");
            assert!(cause.contains("status_assert"), "{cause}");
        }
        other => panic!("expected AllVusFailed, got {other:?}"),
    }
    let failed_outcomes: u64 = flushes
        .iter()
        .flat_map(|f| &f.section_outcomes)
        .map(|o| o.failed)
        .sum();
    assert_eq!(failed_outcomes, 2);
    assert_eq!(seen.orders_ok.load(Ordering::SeqCst), 0);
    assert_eq!(seen.orders_bad.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn curve_main_window_has_no_setup_step_id() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let (res, flushes) = run(Mode::Curve, &yaml, curve_plan(&[(2, 1), (2, 1)], vec![])).await;
    res.unwrap();
    assert!(
        flushes
            .iter()
            .flat_map(|f| &f.windows)
            .any(|w| w.step_id == ORDERS_ID)
    );
    assert!(
        flushes
            .iter()
            .flat_map(|f| &f.windows)
            .all(|w| w.step_id != LOGIN_ID)
    );
}

#[tokio::test]
async fn curve_retire_during_setup_redoes_setup() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(
        &server.uri(),
        &Yaml {
            setup_think: "      think_time: { min_ms: 2500, max_ms: 2500 }",
            ..Yaml::default()
        },
    );
    let (res, flushes) = run(
        Mode::Curve,
        &yaml,
        curve_plan(&[(1, 1), (0, 1), (1, 1), (1, 3)], vec![]),
    )
    .await;
    res.unwrap();
    assert_eq!(seen.logins.load(Ordering::SeqCst), 2);
    assert!(seen.orders_ok.load(Ordering::SeqCst) >= 1);
    assert_eq!(seen.orders_bad.load(Ordering::SeqCst), 0);
    let outcomes: Vec<_> = flushes.iter().flat_map(|f| &f.section_outcomes).collect();
    assert_eq!(outcomes.iter().map(|o| o.interrupted).sum::<u64>(), 0);
    assert_eq!(outcomes.iter().map(|o| o.failed).sum::<u64>(), 0);
    assert!(outcomes.iter().map(|o| o.ok).sum::<u64>() >= 1);
}

#[tokio::test]
async fn curve_run_cancel_during_setup_counts_interrupted() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(
        &server.uri(),
        &Yaml {
            setup_think: "      think_time: { min_ms: 2500, max_ms: 2500 }",
            ..Yaml::default()
        },
    );
    let (res, flushes) = run_cancel_after(
        Mode::Curve,
        &yaml,
        curve_plan(&[(1, 1), (1, 5)], vec![]),
        Some(Duration::from_millis(1500)),
    )
    .await;
    assert!(matches!(res, Err(EngineError::Aborted)), "{res:?}");
    let outcomes: Vec<_> = flushes.iter().flat_map(|f| &f.section_outcomes).collect();
    assert_eq!(outcomes.iter().map(|o| o.interrupted).sum::<u64>(), 1);
    assert_eq!(outcomes.iter().map(|o| o.failed).sum::<u64>(), 0);
    assert_eq!(seen.logins.load(Ordering::SeqCst), 1);
}

fn open_seconds(flushes: &[MetricFlush]) -> (u64, u64, u64) {
    flushes
        .iter()
        .flat_map(|f| &f.open_loop_seconds)
        .fold((0, 0, 0), |a, s| {
            (a.0 + s.launched, a.1 + s.completed, a.2 + s.dropped)
        })
}

fn bad_account_in_slot_one() -> Vec<Arc<DataSet>> {
    vec![dataset(
        BindingPolicy::PerVu,
        vec![
            row(&[("user", "good")]),
            row(&[("user", "bad")]),
            row(&[("user", "good")]),
            row(&[("user", "good")]),
        ],
    )]
}

fn count_bad_logins(received: &[Request]) -> usize {
    received
        .iter()
        .filter(|r| {
            r.url.path() == "/login" && String::from_utf8_lossy(&r.body).contains("user=bad")
        })
        .count()
}

#[tokio::test]
async fn open_setup_runs_once_per_used_slot() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let (res, _) = run(Mode::Open, &yaml, open_plan(20, 4, 1550, vec![])).await;
    res.unwrap();
    assert_eq!(seen.logins.load(Ordering::SeqCst), 4);
    assert!(seen.orders_ok.load(Ordering::SeqCst) >= 4);
}

#[tokio::test]
async fn open_main_steps_get_slot_token() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let (res, _) = run(Mode::Open, &yaml, open_plan(20, 4, 1550, vec![])).await;
    res.unwrap();
    assert!(seen.orders_ok.load(Ordering::SeqCst) >= 4);
    assert_eq!(seen.orders_bad.load(Ordering::SeqCst), 0);
    let tokens = seen.order_tokens.lock().unwrap().clone();
    assert!(tokens.iter().all(|t| t.starts_with("tok-")), "{tokens:?}");
}

#[tokio::test]
async fn open_cookie_carries_over() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/login"))
        .respond_with(ResponseTemplate::new(200).insert_header("Set-Cookie", "sid=abc; Path=/"))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/orders"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        r#"version: 1
name: t
setup:
  steps:
    - type: http
      id: {LOGIN_ID}
      name: login
      request: {{ method: POST, url: "{uri}/login" }}
      assert:
        - status: 200
steps:
  - type: http
    id: {ORDERS_ID}
    name: orders
    request: {{ method: GET, url: "{uri}/orders" }}
"#,
        uri = server.uri()
    );
    let (res, _) = run(Mode::Open, &yaml, open_plan(10, 2, 1050, vec![])).await;
    res.unwrap();
    let received = server.received_requests().await.unwrap();
    let orders: Vec<_> = received
        .iter()
        .filter(|r| r.url.path() == "/orders")
        .collect();
    assert!(orders.len() >= 5, "orders={}", orders.len());
    assert!(orders.iter().all(|r| {
        r.headers
            .get("cookie")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.contains("sid=abc"))
    }));
}

#[tokio::test]
async fn open_main_window_has_no_setup_step_id() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let (res, flushes) = run(Mode::Open, &yaml, open_plan(20, 4, 1050, vec![])).await;
    res.unwrap();
    let windows: Vec<_> = flushes.iter().flat_map(|f| &f.windows).collect();
    assert!(windows.iter().any(|w| w.step_id == ORDERS_ID));
    assert!(windows.iter().all(|w| w.step_id != LOGIN_ID));
}

#[tokio::test]
async fn setup_failed_arrival_is_in_no_counter() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    // 10/s = 100ms 간격, 도착 11번(0..=1000ms) + 반 간격 — 마지막 도착이 deadline에 걸리지 않는다.
    let (res, flushes) = run(
        Mode::Open,
        &yaml,
        open_plan(10, 4, 1050, bad_account_in_slot_one()),
    )
    .await;
    res.unwrap();
    let (launched, completed, dropped) = open_seconds(&flushes);
    assert_eq!(
        launched, completed,
        "launched={launched} completed={completed}"
    );
    assert_eq!(dropped, 0);
    let failed: u64 = flushes
        .iter()
        .flat_map(|f| &f.section_outcomes)
        .map(|o| o.failed)
        .sum();
    assert_eq!(failed, 1);
    let received = server.received_requests().await.unwrap();
    assert_eq!(count_bad_logins(&received), 1);
    let orders = received
        .iter()
        .filter(|r| r.url.path() == "/orders")
        .count();
    assert_eq!(launched as usize, orders);
}

#[tokio::test]
async fn open_retired_slot_is_not_reused() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let (res, _) = run(
        Mode::Open,
        &yaml,
        open_plan(10, 4, 1050, bad_account_in_slot_one()),
    )
    .await;
    res.unwrap();
    let received = server.received_requests().await.unwrap();
    let orders: Vec<_> = received
        .iter()
        .filter(|r| r.url.path() == "/orders")
        .collect();
    assert!(!orders.is_empty());
    assert!(
        orders
            .iter()
            .all(|r| query_param(r, "u").as_deref() == Some("good"))
    );
    assert_eq!(count_bad_logins(&received), 1);
}

#[tokio::test]
async fn open_all_slots_failed_fails_run() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let ds = dataset(BindingPolicy::PerVu, vec![row(&[("user", "bad")])]);
    let started = std::time::Instant::now();
    let (res, flushes) = run(Mode::Open, &yaml, open_plan(20, 3, 5000, vec![ds])).await;
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    match res {
        Err(EngineError::AllVusFailed {
            failed,
            total,
            cause,
        }) => {
            assert_eq!((failed, total), (3, 3));
            let cause = cause.expect("cause");
            assert!(cause.contains("준비 스텝"), "{cause}");
            assert!(cause.contains("status_assert"), "{cause}");
        }
        other => panic!("expected AllVusFailed, got {other:?}"),
    }
    assert_eq!(seen.logins.load(Ordering::SeqCst), 3);
    assert_eq!(seen.orders_ok.load(Ordering::SeqCst), 0);
    assert_eq!(seen.orders_bad.load(Ordering::SeqCst), 0);
    let (launched, completed, _) = open_seconds(&flushes);
    assert_eq!((launched, completed), (0, 0));
}

#[tokio::test]
async fn curve_section_stats_flushed() {
    let seen = Arc::new(Seen::default());
    let server = server_with(&seen).await;
    let yaml = build_yaml(&server.uri(), &Yaml::default());
    let (res, flushes) = run(Mode::Curve, &yaml, curve_plan(&[(3, 1), (3, 2)], vec![])).await;
    res.unwrap();
    let count: u64 = flushes
        .iter()
        .flat_map(|f| &f.section_step_stats)
        .filter(|s| s.step_id == LOGIN_ID)
        .map(|s| s.count)
        .sum();
    assert_eq!(count, 3);
    let outcomes: Vec<_> = flushes.iter().flat_map(|f| &f.section_outcomes).collect();
    assert_eq!(outcomes.iter().map(|o| o.ok).sum::<u64>(), 3);
    assert_eq!(outcomes.iter().map(|o| o.failed).sum::<u64>(), 0);
    assert!(outcomes.iter().any(|o| o.last_done_ms.is_some()));
}
