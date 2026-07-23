// 3개 부하 진입점(run_scenario/run_scenario_vu_curve/run_scenario_open_loop) 각각이
// 생성기를 시드하는지 — 한 진입점만 테스트하면 나머지 배선 누락이 green(레포 함정).
use handicap_engine::{
    MetricFlush, RampDown, RunPlan, Scenario, Stage, run_scenario, run_scenario_open_loop,
    run_scenario_vu_curve,
};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

#[derive(Clone, Copy)]
enum Mode {
    Closed,
    Curve,
    Open,
}

const TWO_STEP: &str = "version: 1
name: g
variables:
  oid: {gen: uuid}
  qty: {gen: random_int, min: 1000, max: 2000, step: 100}
steps:
  - id: \"01HX0000000000000000000001\"
    name: a
    type: http
    request: { method: GET, url: \"{URI}/a?oid={{oid}}&qty={{qty}}\" }
  - id: \"01HX0000000000000000000002\"
    name: b
    type: http
    request: { method: GET, url: \"{URI}/b?oid={{oid}}\" }
";

async fn run_and_collect(mode: Mode, dur_ms: u64) -> Vec<HashMap<String, String>> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = TWO_STEP.replace("{URI}", &server.uri());
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let mut plan = RunPlan {
        vus: 1,
        ramp_up: Duration::ZERO,
        duration: Duration::from_millis(dur_ms),
        env: Default::default(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_bindings: vec![],
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
    };
    match mode {
        Mode::Closed => {}
        Mode::Curve => {
            plan.vu_stages = Some(vec![Stage {
                target: 1,
                duration_seconds: 1,
            }])
        }
        Mode::Open => {
            plan.target_rps = Some(20);
            plan.max_in_flight = Some(4);
            plan.vus = 0;
        }
    }
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    let h = match mode {
        Mode::Closed => tokio::spawn(run_scenario(scenario, plan, tx, cancel)),
        Mode::Curve => tokio::spawn(run_scenario_vu_curve(scenario, plan, tx, cancel)),
        Mode::Open => tokio::spawn(run_scenario_open_loop(scenario, plan, tx, cancel)),
    };
    while rx.recv().await.is_some() {}
    h.await.unwrap().unwrap();
    server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|r| {
            let mut q: HashMap<String, String> = r
                .url
                .query_pairs()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            q.insert("__path".into(), r.url.path().to_string());
            q
        })
        .collect()
}

fn assert_generated(reqs: &[HashMap<String, String>], check_pair_share: bool) {
    assert!(reqs.len() >= 2, "at least one full iteration");
    let uuid_re =
        regex::Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
            .unwrap();
    for r in reqs {
        assert!(
            uuid_re.is_match(&r["oid"]),
            "리터럴 {{{{oid}}}}가 아니라 생성 값이어야: {:?}",
            r
        );
        if r["__path"] == "/a" {
            let q: i64 = r["qty"].parse().unwrap();
            assert!((1000..=2000).contains(&q) && (q - 1000) % 100 == 0, "{q}");
        }
    }
    // 같은 반복의 a/b는 같은 oid 공유 — **Closed/Curve만**(1 VU 순차라 /a 직후 /b가 같은
    // 반복). Open은 max_in_flight=4 동시 arrival이라 received-order 인접이 반복 경계를
    // 넘을 수 있어 false-fail 위험 → 검사 제외(반복 내 공유는 Closed/Curve가 증명).
    if check_pair_share {
        let pair = reqs
            .windows(2)
            .find(|w| w[0]["__path"] == "/a" && w[1]["__path"] == "/b");
        if let Some(w) = pair {
            assert_eq!(w[0]["oid"], w[1]["oid"], "반복 내 값 공유");
        }
    }
    // 반복 간 재평가: 서로 다른 oid가 존재(uuid 충돌 확률 0에 수렴).
    let oids: std::collections::HashSet<_> = reqs
        .iter()
        .filter(|r| r["__path"] == "/a")
        .map(|r| r["oid"].clone())
        .collect();
    if reqs.iter().filter(|r| r["__path"] == "/a").count() >= 2 {
        assert!(oids.len() >= 2, "반복마다 새 값이어야: {oids:?}");
    }
}

#[tokio::test]
async fn closed_loop_seeds_generators() {
    assert_generated(&run_and_collect(Mode::Closed, 500).await, true);
}
#[tokio::test]
async fn vu_curve_seeds_generators() {
    assert_generated(&run_and_collect(Mode::Curve, 1000).await, true);
}
#[tokio::test]
async fn open_loop_seeds_generators() {
    assert_generated(&run_and_collect(Mode::Open, 700).await, false);
}

#[tokio::test]
async fn trace_rows_regenerate_per_row() {
    // trace_scenario_rows: 행마다 trace_once → 생성기 행별 재평가 (spec §4).
    // steps: []라 HTTP 서버 불필요 — final_vars(시드 종점)로 단언.
    use handicap_engine::{TraceOptions, trace_scenario_rows};
    let scenario =
        Scenario::from_yaml("version: 1\nname: t\nvariables:\n  oid: {gen: uuid}\nsteps: []")
            .unwrap();
    let opts = TraceOptions {
        env: Default::default(),
        max_requests: 10,
        max_wall: Duration::from_secs(5),
        apply_think_time: false,
    };
    let rt = trace_scenario_rows(
        &scenario,
        &opts,
        &[(0, Default::default()), (1, Default::default())],
    )
    .await;
    assert_eq!(rt.rows.len(), 2);
    assert_ne!(
        rt.rows[0].trace.final_vars["oid"],
        rt.rows[1].trace.final_vars["oid"]
    );
}
