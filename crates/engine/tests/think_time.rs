// run-level think time: with a fixed inter-iteration delay, fewer iterations run
// in a fixed window than with no delay. Uses a stub HTTP target.
use handicap_engine::{MetricFlush, RunPlan, Scenario, ThinkTime, run_scenario};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn count_requests(plan_think: Option<ThinkTime>, dur_ms: u64) -> u64 {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        "version: 1\nname: t\nsteps:\n  - type: http\n    id: s\n    name: s\n    request:\n      method: GET\n      url: {}/\n",
        server.uri()
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(dur_ms),
        env: Default::default(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_binding: None,
        http_timeout: Duration::from_secs(30),
        think_time: plan_think,
        think_seed: None,
    };
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    let h = tokio::spawn(run_scenario(scenario, plan, tx, cancel));
    let mut total = 0u64;
    while let Some(f) = rx.recv().await {
        for w in f.windows {
            if w.step_id == "s" {
                total += w.count;
            }
        }
    }
    h.await.unwrap().unwrap();
    total
}

#[tokio::test]
async fn run_level_think_time_reduces_iterations() {
    // No think time: many iterations against a localhost stub in ~600ms.
    let none = count_requests(None, 600).await;
    // 200ms inter-iteration pause: far fewer (~3-4) in the same window.
    let paced = count_requests(
        Some(ThinkTime {
            min_ms: 200,
            max_ms: 200,
        }),
        600,
    )
    .await;
    assert!(
        none > paced,
        "expected fewer paced iterations: none={none} paced={paced}"
    );
    assert!(paced >= 1, "at least one iteration must run");
}
