// refresh: request 배선 (spec 2026-10-17-genvar-per-request §4.2·§9) — 부하 3진입점을 Mode로 직접
// spawn(run_scenario만 테스트하면 곡선·open 누락이 green — 엔진 CLAUDE.md 함정) + trace.
use handicap_engine::{
    BindingPolicy, DataSet, MetricFlush, RampDown, RunPlan, Scenario, Stage, TraceOptions,
    run_scenario, run_scenario_open_loop, run_scenario_vu_curve, trace_scenario,
    trace_scenario_rows,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[derive(Clone, Copy)]
enum Mode {
    Closed,
    Curve,
    Open,
}

fn base_plan(dur_ms: u64) -> RunPlan {
    RunPlan {
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
        connect_timeout: None,
    }
}

/// 요청 순서대로 (path, query map). Open은 max_in_flight=1이라 arrival이 순차 → 반복 경계가 순서를 지킨다.
async fn run_collect(
    mode: Mode,
    yaml_tpl: &str,
    dur_ms: u64,
    tweak: impl FnOnce(&mut RunPlan),
    server: &MockServer,
) -> Vec<(String, HashMap<String, String>)> {
    let yaml = yaml_tpl.replace("{URI}", &server.uri());
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let mut plan = base_plan(dur_ms);
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
            plan.max_in_flight = Some(1);
            plan.vus = 0;
        }
    }
    tweak(&mut plan);
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
            let q = r
                .url
                .query_pairs()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            (r.url.path().to_string(), q)
        })
        .collect()
}

async fn ok_server() -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&s)
        .await;
    s
}

/// 연속한 같은 `o`(반복당 1회 uuid) 묶음 = 한 반복. 각 묶음 안에서 `f`는 전부 서로 달라야 하고,
/// 묶음 크기 ≥2가 최소 하나 있어야 한다(아니면 단언이 공허).
fn assert_f_fresh_within_iteration(reqs: &[(String, HashMap<String, String>)]) {
    let mut groups: Vec<Vec<&HashMap<String, String>>> = Vec::new();
    for (_, q) in reqs {
        match groups.last_mut() {
            Some(g) if g[0]["o"] == q["o"] => g.push(q),
            _ => groups.push(vec![q]),
        }
    }
    assert!(
        groups.iter().any(|g| g.len() >= 2),
        "반복 내 요청 2개 이상 필요: {reqs:?}"
    );
    for g in &groups {
        let fs: HashSet<&String> = g.iter().map(|q| &q["f"]).collect();
        assert_eq!(fs.len(), g.len(), "반복 안에서 f가 요청마다 달라야: {g:?}");
    }
    let os: HashSet<&String> = groups.iter().map(|g| &g[0]["o"]).collect();
    assert_eq!(
        os.len(),
        groups.len(),
        "o(iteration)는 반복마다 새 값이어야 묶음이 반복과 일치"
    );
}

const TWO_STEP: &str = "version: 1
name: g
variables:
  f: {gen: uuid, refresh: request}
  o: {gen: uuid}
steps:
  - { id: \"01HX0000000000000000000001\", name: a, type: http, request: { method: GET, url: \"{URI}/a?f={{f}}&o={{o}}\" } }
  - { id: \"01HX0000000000000000000002\", name: b, type: http, request: { method: GET, url: \"{URI}/b?f={{f}}&o={{o}}\" } }
";

#[tokio::test]
async fn closed_regenerates_per_request() {
    let s = ok_server().await;
    let reqs = run_collect(Mode::Closed, TWO_STEP, 400, |_| {}, &s).await;
    assert_f_fresh_within_iteration(&reqs);
}
#[tokio::test]
async fn curve_regenerates_per_request() {
    let s = ok_server().await;
    let reqs = run_collect(Mode::Curve, TWO_STEP, 1000, |_| {}, &s).await;
    assert_f_fresh_within_iteration(&reqs);
}
#[tokio::test]
async fn open_regenerates_per_request() {
    let s = ok_server().await;
    let reqs = run_collect(Mode::Open, TWO_STEP, 700, |_| {}, &s).await;
    assert_f_fresh_within_iteration(&reqs);
}

#[tokio::test]
async fn loop_regenerates_each_round() {
    let s = ok_server().await;
    let yaml = "version: 1
name: g
variables:
  f: {gen: uuid, refresh: request}
  o: {gen: uuid}
steps:
  - id: \"01HX00000000000000000000M0\"
    name: lp
    type: loop
    repeat: 3
    do:
      - { id: \"01HX0000000000000000000001\", name: a, type: http, request: { method: GET, url: \"{URI}/l?f={{f}}&o={{o}}\" } }
";
    let reqs = run_collect(Mode::Closed, yaml, 300, |_| {}, &s).await;
    assert_f_fresh_within_iteration(&reqs);
}

#[tokio::test]
async fn parallel_branches_regenerate() {
    let s = ok_server().await;
    let yaml = "version: 1
name: g
variables:
  f: {gen: uuid, refresh: request}
  o: {gen: uuid}
steps:
  - id: \"01HX00000000000000000000P0\"
    name: par
    type: parallel
    branches:
      - name: x
        steps:
          - { id: \"01HX0000000000000000000011\", name: p1, type: http, request: { method: GET, url: \"{URI}/p1?f={{f}}&o={{o}}\" } }
      - name: y
        steps:
          - { id: \"01HX0000000000000000000012\", name: p2, type: http, request: { method: GET, url: \"{URI}/p2?f={{f}}&o={{o}}\" } }
  - { id: \"01HX0000000000000000000013\", name: z, type: http, request: { method: GET, url: \"{URI}/z?f={{f}}&o={{o}}\" } }
";
    let reqs = run_collect(Mode::Closed, yaml, 400, |_| {}, &s).await;
    // 분기는 동시 실행이라 순서 대신 o(반복)로 묶는다.
    let mut by_o: HashMap<String, Vec<String>> = HashMap::new();
    for (_, q) in &reqs {
        by_o.entry(q["o"].clone()).or_default().push(q["f"].clone());
    }
    let full: Vec<_> = by_o.values().filter(|fs| fs.len() == 3).collect();
    assert!(!full.is_empty(), "완전한 반복 1개 이상: {reqs:?}");
    for fs in full {
        let set: HashSet<_> = fs.iter().collect();
        assert_eq!(set.len(), 3, "p1·p2·z가 서로 다른 f: {fs:?}");
    }
}

#[tokio::test]
async fn dataset_bound_name_is_not_regenerated() {
    let s = ok_server().await;
    let row: BTreeMap<String, String> = [("f".to_string(), "DS".to_string())].into();
    let ds = DataSet {
        policy: BindingPolicy::PerVu,
        seed: 0,
        rows: vec![row],
    };
    let reqs = run_collect(
        Mode::Closed,
        TWO_STEP,
        300,
        |p| p.data_bindings = vec![Arc::new(ds)],
        &s,
    )
    .await;
    assert!(!reqs.is_empty());
    assert!(
        reqs.iter().all(|(_, q)| q["f"] == "DS"),
        "데이터셋 우선: {reqs:?}"
    );
}

const EXTRACT: &str = "version: 1
name: g
variables:
  f: {gen: uuid, refresh: request}
  o: {gen: uuid}
steps:
  - id: \"01HX0000000000000000000001\"
    name: a
    type: http
    request: { method: GET, url: \"{URI}/a?f={{f}}&o={{o}}\" }
    extract:
      - var: f
        from: body
        path: \"{PATH}\"
  - { id: \"01HX0000000000000000000002\", name: b, type: http, request: { method: GET, url: \"{URI}/b?f={{f}}&o={{o}}\" } }
";

async fn extract_server() -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{\"tok\":\"X\"}"))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&s)
        .await;
    s
}

/// a/b 연속 쌍(같은 o)만 뽑는다.
fn pairs(
    reqs: &[(String, HashMap<String, String>)],
) -> Vec<(HashMap<String, String>, HashMap<String, String>)> {
    reqs.windows(2)
        .filter(|w| w[0].0 == "/a" && w[1].0 == "/b" && w[0].1["o"] == w[1].1["o"])
        .map(|w| (w[0].1.clone(), w[1].1.clone()))
        .collect()
}

#[tokio::test]
async fn extract_written_key_stops_regeneration() {
    // Review Focus 4: a는 f를 참조하면서 같은 이름으로 추출 — a에는 새 uuid, b에는 추출 값.
    let s = extract_server().await;
    let yaml = EXTRACT.replace("{PATH}", "$.tok");
    let reqs = run_collect(Mode::Closed, &yaml, 300, |_| {}, &s).await;
    let ps = pairs(&reqs);
    assert!(!ps.is_empty(), "{reqs:?}");
    for (a, b) in ps {
        assert_ne!(a["f"], "X", "a는 요청 직전 재평가 값");
        assert_eq!(b["f"], "X", "추출이 쓴 뒤로는 추출 값");
    }
}

#[tokio::test]
async fn failed_extract_keeps_regenerating() {
    // 추출은 전부-아니면-전무 — 실패하면 아무 키도 안 쓰므로 f는 계속 재평가(spec §4.2).
    let s = extract_server().await;
    let yaml = EXTRACT.replace("{PATH}", "$.missing");
    let reqs = run_collect(Mode::Closed, &yaml, 300, |_| {}, &s).await;
    let ps = pairs(&reqs);
    assert!(!ps.is_empty(), "{reqs:?}");
    for (a, b) in ps {
        assert_ne!(a["f"], b["f"], "추출 실패면 b도 새 값");
    }
}

#[tokio::test]
async fn condition_only_reference_does_not_break_run() {
    // Review Focus 2: if 조건에서만 참조 — 재평가 대상이 없고 run은 정상 진행.
    let s = ok_server().await;
    let yaml = "version: 1
name: g
variables:
  f: {gen: uuid, refresh: request}
  o: {gen: uuid}
steps:
  - id: \"01HX00000000000000000000F0\"
    name: c
    type: if
    cond: {left: \"{{f}}\", op: exists}
    then:
      - { id: \"01HX0000000000000000000001\", name: a, type: http, request: { method: GET, url: \"{URI}/t?o={{o}}\" } }
";
    let reqs = run_collect(Mode::Closed, yaml, 200, |_| {}, &s).await;
    assert!(!reqs.is_empty(), "then 분기 실행(조건이 반복 시작 값을 봄)");
}

#[tokio::test]
async fn trace_rows_rebuild_state_per_row() {
    // 행마다 상태 재생성 — 행 0은 f를 바인딩(재평가 중지), 행 1은 f 없음(재평가 재개).
    // trace의 seed_vars mark_written이 행을 넘어 새면 행 1도 재평가되지 않는다.
    let server = ok_server().await;
    let yaml = TWO_STEP.replace("{URI}", &server.uri());
    let sc = Scenario::from_yaml(&yaml).unwrap();
    let opts = TraceOptions {
        env: Default::default(),
        max_requests: 10,
        max_wall: Duration::from_secs(5),
        apply_think_time: false,
    };
    let row0: BTreeMap<String, String> = [("f".to_string(), "ROW".to_string())].into();
    let row1: BTreeMap<String, String> = [("x".to_string(), "1".to_string())].into();
    let rt = trace_scenario_rows(&sc, &opts, &[(0, row0), (1, row1)]).await;
    let urls = |i: usize| -> Vec<String> {
        rt.rows[i]
            .trace
            .steps
            .iter()
            .map(|st| st.request.as_ref().unwrap().url.clone())
            .collect()
    };
    // URL 전체가 아니라 f 쿼리 값을 비교한다 — 행 1의 두 요청은 경로(/a·/b)가 달라 URL 비교는 항상 통과(공허).
    let f_of = |u: &str| -> String {
        reqwest::Url::parse(u)
            .unwrap()
            .query_pairs()
            .find(|(k, _)| k == "f")
            .map(|(_, v)| v.into_owned())
            .unwrap()
    };
    assert!(urls(0).iter().all(|u| f_of(u) == "ROW"), "{:?}", urls(0));
    let r1: Vec<String> = urls(1).iter().map(|u| f_of(u)).collect();
    assert_eq!(r1.len(), 2);
    assert!(r1.iter().all(|f| f != "ROW"), "{r1:?}");
    assert_ne!(
        r1[0], r1[1],
        "행 1은 요청마다 새 f — 행 0의 죽은 집합이 새면 같아진다"
    );
}

#[tokio::test]
async fn parallel_branch_extract_kills_only_in_that_branch() {
    // 분기 x: x1이 f를 추출 → x2는 추출 값. 분기 y: 같은 반복이어도 재평가 계속(분기 스코프).
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/x1"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{\"tok\":\"X\"}"))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&s)
        .await;
    let yaml = "version: 1
name: g
variables:
  f: {gen: uuid, refresh: request}
  o: {gen: uuid}
steps:
  - id: \"01HX00000000000000000000P0\"
    name: par
    type: parallel
    branches:
      - name: x
        steps:
          - id: \"01HX0000000000000000000021\"
            name: x1
            type: http
            request: { method: GET, url: \"{URI}/x1?f={{f}}&o={{o}}\" }
            extract:
              - var: f
                from: body
                path: \"$.tok\"
          - { id: \"01HX0000000000000000000022\", name: x2, type: http, request: { method: GET, url: \"{URI}/x2?f={{f}}&o={{o}}\" } }
      - name: y
        steps:
          - { id: \"01HX0000000000000000000023\", name: y1, type: http, request: { method: GET, url: \"{URI}/y1?f={{f}}&o={{o}}\" } }
          - { id: \"01HX0000000000000000000024\", name: y2, type: http, request: { method: GET, url: \"{URI}/y2?f={{f}}&o={{o}}\" } }
";
    let reqs = run_collect(Mode::Closed, yaml, 400, |_| {}, &s).await;
    let mut by_o: HashMap<String, HashMap<String, String>> = HashMap::new();
    for (p, q) in &reqs {
        by_o.entry(q["o"].clone())
            .or_default()
            .insert(p.clone(), q["f"].clone());
    }
    let full: Vec<_> = by_o.values().filter(|m| m.len() == 4).collect();
    assert!(!full.is_empty(), "{reqs:?}");
    for m in full {
        assert_eq!(m["/x2"], "X", "x 분기는 추출 이후 추출 값");
        assert_ne!(m["/y1"], "X");
        assert_ne!(m["/y1"], m["/y2"], "y 분기는 계속 재평가");
    }
}

#[tokio::test]
async fn trace_pick_array_differs_per_step() {
    // US1 엔진 측 증거 — test-run 1회에서 스텝 3개의 배열이 서로 다르고 선택 개수 10.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let mut steps = String::new();
    for i in 1..=3 {
        steps.push_str(&format!(
            "  - id: \"01HX000000000000000000000{i}\"\n    name: s{i}\n    type: http\n    request:\n      method: POST\n      url: \"{}/p\"\n      body:\n        json:\n          flags: \"{{{{flags:json}}}}\"\n",
            server.uri()
        ));
    }
    let yaml = format!(
        "version: 1\nname: t\nvariables:\n  flags: {{gen: pick_array, length: 20, min: 10, max: 10, refresh: request}}\nsteps:\n{steps}"
    );
    let sc = Scenario::from_yaml(&yaml).unwrap();
    let opts = TraceOptions {
        env: Default::default(),
        max_requests: 10,
        max_wall: Duration::from_secs(5),
        apply_think_time: false,
    };
    let t = trace_scenario(&sc, &opts).await;
    let arrays: Vec<Vec<bool>> = t
        .steps
        .iter()
        .map(|st| {
            let body = st.request.as_ref().unwrap().body.as_ref().unwrap();
            let v: serde_json::Value = serde_json::from_str(body).unwrap();
            serde_json::from_value(v["flags"].clone()).unwrap()
        })
        .collect();
    assert_eq!(arrays.len(), 3);
    for a in &arrays {
        assert_eq!(a.len(), 20);
        assert_eq!(a.iter().filter(|b| **b).count(), 10);
    }
    let set: HashSet<_> = arrays.iter().collect();
    assert_eq!(set.len(), 3, "스텝마다 다른 배열");
}

#[tokio::test]
async fn trace_rows_seed_shadows_refresh_var() {
    // 데이터셋 행(seed_vars) 키는 trace에서도 재평가 안 됨.
    let server = ok_server().await;
    let yaml = TWO_STEP.replace("{URI}", &server.uri());
    let sc = Scenario::from_yaml(&yaml).unwrap();
    let opts = TraceOptions {
        env: Default::default(),
        max_requests: 10,
        max_wall: Duration::from_secs(5),
        apply_think_time: false,
    };
    let row: BTreeMap<String, String> = [("f".to_string(), "ROW".to_string())].into();
    let rt = trace_scenario_rows(&sc, &opts, &[(0, row)]).await;
    for st in &rt.rows[0].trace.steps {
        assert!(
            st.request.as_ref().unwrap().url.contains("f=ROW"),
            "{}",
            st.request.as_ref().unwrap().url
        );
    }
}

const PAR_MERGE: &str = "version: 1
name: g
variables:
  x.f: {gen: uuid, refresh: request}
  o: {gen: uuid}
steps:
  - id: \"01HX00000000000000000000P0\"
    name: par
    type: parallel
    branches:
      - name: x
        steps:
          - id: \"01HX0000000000000000000021\"
            name: x1
            type: http
            request: { method: GET, url: \"{URI}/a\" }
            extract:
              - var: f
                from: body
                path: \"$.tok\"
  - { id: \"01HX0000000000000000000002\", name: z, type: http, request: { method: GET, url: \"{URI}/z?f={{x.f}}&o={{o}}\" } }
";

#[tokio::test]
async fn parallel_merge_back_stops_regeneration_of_namespaced_key() {
    // M1: 분기 x가 추출한 f가 부모에 `x.f`로 병합되면 그 키는 더 이상 재평가되지 않는다(generated < extract).
    let s = extract_server().await;
    let reqs = run_collect(Mode::Closed, PAR_MERGE, 300, |_| {}, &s).await;
    let zs: Vec<_> = reqs.iter().filter(|(p, _)| p == "/z").collect();
    assert!(!zs.is_empty(), "{reqs:?}");
    for (_, q) in zs {
        assert_eq!(q["f"], "X", "병합된 추출 값이 나가야 한다");
    }
}

fn trace_opts() -> TraceOptions {
    TraceOptions {
        env: Default::default(),
        max_requests: 10,
        max_wall: Duration::from_secs(5),
        apply_think_time: false,
    }
}

#[tokio::test]
async fn trace_parallel_merge_back_stops_regeneration() {
    let s = extract_server().await;
    let yaml = PAR_MERGE.replace("{URI}", &s.uri());
    let sc = Scenario::from_yaml(&yaml).unwrap();
    let t = trace_scenario(&sc, &trace_opts()).await;
    let z = t
        .steps
        .iter()
        .find(|st| st.request.as_ref().is_some_and(|r| r.url.contains("/z?")))
        .expect("z step");
    assert!(
        z.request.as_ref().unwrap().url.contains("f=X"),
        "{}",
        z.request.as_ref().unwrap().url
    );
}

#[tokio::test]
async fn trace_extract_stops_regeneration() {
    // M2: test-run도 추출이 쓴 키는 재평가 중지 — a는 새 값, b는 추출 값.
    let s = extract_server().await;
    let yaml = EXTRACT
        .replace("{PATH}", "$.tok")
        .replace("{URI}", &s.uri());
    let sc = Scenario::from_yaml(&yaml).unwrap();
    let t = trace_scenario(&sc, &trace_opts()).await;
    let url = |i: usize| t.steps[i].request.as_ref().unwrap().url.clone();
    assert!(!url(0).contains("f=X"), "{}", url(0));
    assert!(url(1).contains("f=X"), "{}", url(1));
}
