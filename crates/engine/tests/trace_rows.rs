use std::collections::BTreeMap;
use std::time::Duration;

use handicap_engine::{Scenario, TraceOptions, trace_scenario_rows};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn opts(max_requests: u32) -> TraceOptions {
    TraceOptions {
        env: BTreeMap::new(),
        max_requests,
        max_wall: Duration::from_secs(120),
        apply_think_time: false,
    }
}

fn seed(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// 한 http 스텝짜리 시나리오 (cookie_jar auto).
fn one_step_scenario(url: &str) -> Scenario {
    Scenario::from_yaml(&format!(
        r#"
version: 1
name: rows
cookie_jar: auto
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{url}" }}
"#
    ))
    .unwrap()
}

/// 두 http 스텝짜리 시나리오 (예산 케이스용).
fn two_step_scenario(base: &str) -> Scenario {
    Scenario::from_yaml(&format!(
        r#"
version: 1
name: rows2
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{base}/a" }}
  - type: http
    id: 01HX0000000000000000000011
    name: b
    request: {{ method: GET, url: "{base}/b" }}
"#
    ))
    .unwrap()
}

async fn mount_ok(server: &MockServer, p: &str) {
    Mock::given(method("GET"))
        .and(path(p))
        .respond_with(ResponseTemplate::new(200))
        .mount(server)
        .await;
}

#[tokio::test]
async fn rows_share_cookie_jar_across_rows() {
    // R5: 클라이언트(jar) 1회 빌드 — 행 0의 Set-Cookie가 행 1 요청에 실린다.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/bump"))
        .and(header("cookie", "sid=abc"))
        .respond_with(ResponseTemplate::new(200).set_body_string("seen"))
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/bump"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("Set-Cookie", "sid=abc; Path=/")
                .set_body_string("fresh"),
        )
        .with_priority(2)
        .mount(&server)
        .await;

    let scenario = one_step_scenario(&format!("{}/bump", server.uri()));
    let rows = vec![(0u64, seed(&[])), (1u64, seed(&[]))];
    let rt = trace_scenario_rows(&scenario, &opts(50), &rows).await;
    assert!(rt.ok, "{rt:?}");
    let body0 = &rt.rows[0].trace.steps[0].response.as_ref().unwrap().body;
    let body1 = &rt.rows[1].trace.steps[0].response.as_ref().unwrap().body;
    assert_eq!(body0, "fresh");
    assert_eq!(body1, "seen");
}

#[tokio::test]
async fn iter_id_advances_per_row_and_row_index_passes_through() {
    // R4: iter_id = 반복 순번(0..N-1), row_index = 호출자가 준 앵커 그대로.
    let server = MockServer::start().await;
    mount_ok(&server, "/i/0").await;
    mount_ok(&server, "/i/1").await;
    mount_ok(&server, "/i/2").await;
    let scenario = one_step_scenario(&format!("{}/i/${{iter_id}}", server.uri()));
    let rows = vec![(5u64, seed(&[])), (6u64, seed(&[])), (7u64, seed(&[]))];
    let rt = trace_scenario_rows(&scenario, &opts(50), &rows).await;
    assert!(rt.ok, "{rt:?}");
    for (i, r) in rt.rows.iter().enumerate() {
        assert_eq!(r.row_index, 5 + i as u64);
        let url = &r.trace.steps[0].request.as_ref().unwrap().url;
        assert!(url.ends_with(&format!("/i/{i}")), "{url}");
    }
}

#[tokio::test]
async fn vars_reset_between_rows_extracts_do_not_accumulate() {
    // R4: 행마다 iter_vars 리셋 — 행 0의 extract가 행 1로 새지 않는다.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"tok":"t0"}"#))
        .up_to_n_times(1)
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
        .with_priority(2)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/use/t0"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/use/"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let scenario = Scenario::from_yaml(&format!(
        r#"
version: 1
name: reset
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: get
    request: {{ method: GET, url: "{base}/a" }}
    extract:
      - var: tok
        from: body
        path: "$.tok"
  - type: http
    id: 01HX0000000000000000000011
    name: use
    request: {{ method: GET, url: "{base}/use/{{{{tok}}}}" }}
"#,
        base = server.uri()
    ))
    .unwrap();
    let rows = vec![(0u64, seed(&[])), (1u64, seed(&[]))];
    let rt = trace_scenario_rows(&scenario, &opts(50), &rows).await;
    // 행 0: tok=t0 추출·사용 / 행 1: 추출 실패 → tok 미바인딩(누적됐다면 t0가 남았을 것)
    let row1_use = rt.rows[1].trace.steps[1].request.as_ref().unwrap();
    assert!(row1_use.url.ends_with("/use/"), "{}", row1_use.url);
    assert!(
        rt.rows[1].trace.steps[1]
            .unbound_vars
            .contains(&"tok".to_string())
    );
    let row0_use = rt.rows[0].trace.steps[1].request.as_ref().unwrap();
    assert!(row0_use.url.ends_with("/use/t0"), "{}", row0_use.url);
}

#[tokio::test]
async fn budget_exhausts_at_row_boundary() {
    // R6: 2스텝 × max_requests 4 → 행 0·1 완주, 행 2는 미실행(rows에 없음).
    let server = MockServer::start().await;
    mount_ok(&server, "/a").await;
    mount_ok(&server, "/b").await;
    let scenario = two_step_scenario(&server.uri());
    let rows = vec![(0u64, seed(&[])), (1u64, seed(&[])), (2u64, seed(&[]))];
    let rt = trace_scenario_rows(&scenario, &opts(4), &rows).await;
    assert_eq!(rt.rows.len(), 2);
    assert!(rt.truncated);
    assert!(!rt.ok, "truncated ⟹ ok=false (R8)");
    assert!(!rt.rows[0].trace.truncated);
    assert!(!rt.rows[1].trace.truncated);
}

#[tokio::test]
async fn budget_exhausts_mid_row() {
    // R6: max_requests 3 → 행 1이 스텝 1개만 돌고 mid-cut(그 행 truncated).
    let server = MockServer::start().await;
    mount_ok(&server, "/a").await;
    mount_ok(&server, "/b").await;
    let scenario = two_step_scenario(&server.uri());
    let rows = vec![(0u64, seed(&[])), (1u64, seed(&[]))];
    let rt = trace_scenario_rows(&scenario, &opts(3), &rows).await;
    assert_eq!(rt.rows.len(), 2);
    assert!(rt.truncated);
    assert!(rt.rows[1].trace.truncated);
    assert_eq!(rt.rows[1].trace.steps.len(), 1);
}

#[tokio::test]
async fn exact_budget_exhaustion_on_last_row_is_not_truncated() {
    // R6: 요청 구간 전부 완료 + 예산 정확 소진 → truncated=false.
    let server = MockServer::start().await;
    mount_ok(&server, "/a").await;
    mount_ok(&server, "/b").await;
    let scenario = two_step_scenario(&server.uri());
    let rows = vec![(0u64, seed(&[])), (1u64, seed(&[]))];
    let rt = trace_scenario_rows(&scenario, &opts(4), &rows).await;
    assert_eq!(rt.rows.len(), 2);
    assert!(!rt.truncated);
    assert!(rt.ok);
}

#[tokio::test]
async fn failed_row_does_not_stop_the_loop() {
    // R10: 실패 행 뒤 행도 실행 — fail-fast 없음.
    let server = MockServer::start().await;
    mount_ok(&server, "/s/okv").await;
    Mock::given(method("GET"))
        .and(path("/s/bad"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let scenario = Scenario::from_yaml(&format!(
        r#"
version: 1
name: cont
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: s
    request: {{ method: GET, url: "{base}/s/{{{{code}}}}" }}
    assert:
      - status: 200
"#,
        base = server.uri()
    ))
    .unwrap();
    let rows = vec![
        (0u64, seed(&[("code", "okv")])),
        (1u64, seed(&[("code", "bad")])),
        (2u64, seed(&[("code", "okv")])),
    ];
    let rt = trace_scenario_rows(&scenario, &opts(50), &rows).await;
    assert_eq!(rt.rows.len(), 3);
    assert!(rt.rows[0].trace.ok);
    assert!(rt.rows[1].trace.error.is_none()); // per-step 에러지 setup 에러 아님
    assert!(!rt.rows[1].trace.ok);
    assert!(rt.rows[2].trace.ok);
    assert!(!rt.ok);
    assert!(!rt.truncated);
}
