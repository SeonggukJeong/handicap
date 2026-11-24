//! 시험 실행 trace도 같은 규칙으로 기본값을 채우고 `defaulted`에 싣는다(extract-default R2–R4).
use std::collections::BTreeMap;
use std::time::Duration;

use handicap_engine::{Scenario, StepKind, StepTrace, TraceOptions, trace_scenario};
use wiremock::matchers::path;
use wiremock::{Mock, MockServer, ResponseTemplate};

const POLL_ID: &str = "01HX0000000000000000000002";
const ORD_ID: &str = "01HX0000000000000000000003";
const PAGE_ID: &str = "01HX0000000000000000000004";
const A_ID: &str = "01HX0000000000000000000005";
const X_ID: &str = "01HX0000000000000000000006";
const Y_ID: &str = "01HX0000000000000000000007";
const IF_ID: &str = "01HX0000000000000000000009";

fn opts() -> TraceOptions {
    TraceOptions {
        env: BTreeMap::new(),
        max_requests: 50,
        max_wall: Duration::from_secs(20),
        apply_think_time: false,
    }
}

fn json_resp(body: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_string(body)
}

fn fill(tpl: &str, uri: &str, def: &str) -> String {
    tpl.replace("{URI}", uri).replace("{DEF}", def)
}

fn row<'a>(steps: &'a [StepTrace], id: &str) -> &'a StepTrace {
    steps
        .iter()
        .find(|s| s.step_id == id)
        .unwrap_or_else(|| panic!("no row for {id}"))
}

fn rows<'a>(steps: &'a [StepTrace], id: &str) -> Vec<&'a StepTrace> {
    steps.iter().filter(|s| s.step_id == id).collect()
}

fn url(r: &StepTrace) -> &str {
    &r.request.as_ref().expect("request").url
}

const US1: &str = r#"version: 1
name: ed-us1
variables: { state: "" }
steps:
  - id: "01HX0000000000000000000001"
    name: lp
    type: loop
    while: { left: "{{state}}", op: ne, right: "DONE" }
    repeat: 2
    do:
      - { id: "01HX0000000000000000000002", name: poll, type: http, request: { method: GET, url: "{URI}/poll" }, assert: [], extract: [{ var: state, from: body, path: "$.state" }, { var: orderId, from: body, path: "$.orderId", default: none }] }
  - { id: "01HX0000000000000000000003", name: ord, type: http, request: { method: GET, url: "{URI}/orders/{{orderId}}" }, assert: [] }
"#;

#[tokio::test]
async fn trace_us1_defaulted_marks_step() {
    let server = MockServer::start().await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"state":"DONE"}"#))
        .mount(&server)
        .await;
    let sc = Scenario::from_yaml(&fill(US1, &server.uri(), "")).unwrap();
    let t = trace_scenario(&sc, &opts()).await;
    let poll = row(&t.steps, POLL_ID);
    assert_eq!(poll.defaulted, vec!["orderId".to_string()]);
    assert_eq!(
        poll.extracted.get("orderId").map(String::as_str),
        Some("none")
    );
    let ord = row(&t.steps, ORD_ID);
    assert!(ord.blocked.is_none());
    assert!(url(ord).ends_with("/orders/none"), "{}", url(ord));
}

#[tokio::test]
async fn server_sent_same_text_is_not_defaulted() {
    let server = MockServer::start().await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"state":"DONE","orderId":"none"}"#))
        .mount(&server)
        .await;
    let sc = Scenario::from_yaml(&fill(US1, &server.uri(), "")).unwrap();
    let t = trace_scenario(&sc, &opts()).await;
    let poll = row(&t.steps, POLL_ID);
    assert!(poll.defaulted.is_empty());
    assert_eq!(
        poll.extracted.get("orderId").map(String::as_str),
        Some("none")
    );
    let v = serde_json::to_value(poll).unwrap();
    assert!(v.get("defaulted").is_none(), "{v}");
}

const US3: &str = r#"version: 1
name: ed-us3
steps:
  - { id: "01HX0000000000000000000005", name: a, type: http, request: { method: GET, url: "{URI}/a" }, assert: [], extract: [{ var: coupon, from: body, path: "$.couponId", default: none }] }
  - id: "01HX0000000000000000000009"
    name: c
    type: if
    cond: { left: "{{coupon}}", op: eq, right: "none" }
    then:
      - { id: "01HX0000000000000000000006", name: nc, type: http, request: { method: GET, url: "{URI}/no-coupon" }, assert: [] }
    else:
      - { id: "01HX0000000000000000000007", name: c, type: http, request: { method: GET, url: "{URI}/coupon" }, assert: [] }
"#;

#[tokio::test]
async fn trace_us3_outside_loop_ok() {
    let server = MockServer::start().await;
    Mock::given(path("/a"))
        .respond_with(json_resp("{}"))
        .mount(&server)
        .await;
    Mock::given(path("/no-coupon"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let sc = Scenario::from_yaml(&fill(US3, &server.uri(), "")).unwrap();
    let t = trace_scenario(&sc, &opts()).await;
    assert_eq!(row(&t.steps, A_ID).error, None);
    assert!(t.ok, "{:?}", t.steps);
    assert_eq!(row(&t.steps, IF_ID).branch.as_deref(), Some("then"));
    assert_eq!(row(&t.steps, X_ID).kind, StepKind::Http);
}

const TRANSPORT: &str = r#"version: 1
name: ed-transport
steps:
  - { id: "01HX0000000000000000000005", name: dead, type: http, request: { method: GET, url: "http://127.0.0.1:1/t" }, assert: [], extract: [{ var: t, from: body, path: "$.t", default: none }] }
  - { id: "01HX0000000000000000000006", name: next, type: http, request: { method: GET, url: "{URI}/next/{{t}}" }, assert: [] }
"#;

#[tokio::test]
async fn trace_outside_loop_transport_failure_fills_default() {
    let server = MockServer::start().await;
    let sc = Scenario::from_yaml(&fill(TRANSPORT, &server.uri(), "")).unwrap();
    let t = trace_scenario(&sc, &opts()).await;
    assert_eq!(row(&t.steps, A_ID).defaulted, vec!["t".to_string()]);
    let next = row(&t.steps, X_ID);
    assert!(url(next).ends_with("/next/none"), "{}", url(next));
    assert!(next.unbound_vars.is_empty());
}

const BLOCKED: &str = r#"version: 1
name: ed-blocked
variables: { state: "" }
steps:
  - id: "01HX0000000000000000000001"
    name: lp
    type: loop
    while: { left: "{{state}}", op: ne, right: "DONE" }
    repeat: 2
    do:
      - { id: "01HX0000000000000000000002", name: poll, type: http, request: { method: GET, url: "{URI}/poll" }, assert: [], extract: [{ var: state, from: body, path: "$.state" }, { var: id, from: body, path: "$.id" }] }
  - { id: "01HX0000000000000000000006", name: x, type: http, request: { method: GET, url: "{URI}/x/{{id}}" }, assert: [], extract: [{ var: r, from: body, path: "$.r", default: none }] }
  - { id: "01HX0000000000000000000007", name: y, type: http, request: { method: GET, url: "{URI}/y/{{r}}" }, assert: [] }
"#;

#[tokio::test]
async fn trace_outside_loop_blocked_fills_default() {
    let server = MockServer::start().await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"state":"DONE"}"#))
        .mount(&server)
        .await;
    let sc = Scenario::from_yaml(&fill(BLOCKED, &server.uri(), "")).unwrap();
    let t = trace_scenario(&sc, &opts()).await;
    let x = row(&t.steps, X_ID);
    assert!(x.blocked.is_some(), "{x:?}");
    assert_eq!(x.defaulted, vec!["r".to_string()]);
    let y = row(&t.steps, Y_ID);
    assert!(url(y).ends_with("/y/none"), "{}", url(y));
}

const US2: &str = r#"version: 1
name: ed-us2
variables: { cursor: start, state: "" }
steps:
  - id: "01HX0000000000000000000001"
    name: lp
    type: loop
    while: { left: "{{state}}", op: ne, right: "DONE" }
    repeat: 5
    do:
      - { id: "01HX0000000000000000000004", name: page, type: http, request: { method: GET, url: "{URI}/page/{{cursor}}" }, assert: [], extract: [{ var: state, from: body, path: "$.state" }, { var: cursor, from: body, path: "$.next", default: restart }] }
"#;

#[tokio::test]
async fn trace_us2_self_cursor_recovers() {
    let server = MockServer::start().await;
    Mock::given(path("/page/start"))
        .respond_with(json_resp(r#"{"state":"WAIT"}"#))
        .mount(&server)
        .await;
    Mock::given(path("/page/restart"))
        .respond_with(json_resp(r#"{"state":"DONE","next":"n2"}"#))
        .mount(&server)
        .await;
    let sc = Scenario::from_yaml(&fill(US2, &server.uri(), "")).unwrap();
    let t = trace_scenario(&sc, &opts()).await;
    let pages = rows(&t.steps, PAGE_ID);
    assert_eq!(pages.len(), 2, "{pages:?}");
    assert_eq!(pages[0].defaulted, vec!["cursor".to_string()]);
    assert!(
        url(pages[1]).ends_with("/page/restart"),
        "{}",
        url(pages[1])
    );
    assert!(pages[1].blocked.is_none());
    assert_eq!(t.ended_by_loop, None);
}

const REGEN: &str = r#"version: 1
name: ed-regen
variables: { tok: { gen: uuid, refresh: request } }
steps:
  - { id: "01HX0000000000000000000008", name: s1, type: http, request: { method: GET, url: "{URI}/s1" }, assert: [], extract: [{ var: tok, from: body, path: "$.tok", default: fixed }] }
  - { id: "01HX0000000000000000000006", name: u2, type: http, request: { method: GET, url: "{URI}/u/{{tok}}" }, assert: [] }
  - { id: "01HX0000000000000000000007", name: u3, type: http, request: { method: GET, url: "{URI}/u/{{tok}}" }, assert: [] }
"#;

#[tokio::test]
async fn trace_default_stops_request_regen() {
    let server = MockServer::start().await;
    Mock::given(path("/s1"))
        .respond_with(json_resp("{}"))
        .mount(&server)
        .await;
    let sc = Scenario::from_yaml(&fill(REGEN, &server.uri(), "")).unwrap();
    let t = trace_scenario(&sc, &opts()).await;
    assert!(url(row(&t.steps, X_ID)).ends_with("/u/fixed"));
    assert!(url(row(&t.steps, Y_ID)).ends_with("/u/fixed"));
}

const STRICT_ERR: &str = r#"version: 1
name: ed-strict-err
steps:
  - { id: "01HX0000000000000000000005", name: a, type: http, request: { method: GET, url: "{URI}/a" }, assert: [], extract: [{ var: x, from: body, path: "$.zz" }, { var: a, from: body, path: "$.a", default: d }] }
"#;

#[tokio::test]
async fn trace_strict_err_keeps_default_item_value() {
    let server = MockServer::start().await;
    Mock::given(path("/a"))
        .respond_with(json_resp(r#"{"a":"A"}"#))
        .mount(&server)
        .await;
    let sc = Scenario::from_yaml(&fill(STRICT_ERR, &server.uri(), "")).unwrap();
    let t = trace_scenario(&sc, &opts()).await;
    let r = row(&t.steps, A_ID);
    assert!(r.error.is_some());
    assert_eq!(
        r.extracted,
        BTreeMap::from([("a".to_string(), "A".to_string())])
    );
    assert!(r.defaulted.is_empty());
}

const CLEAR: &str = r#"version: 1
name: ed-clear
variables: { state: "" }
steps:
  - id: "01HX0000000000000000000001"
    name: lp
    type: loop
    while: { left: "{{state}}", op: ne, right: "DONE" }
    repeat: 2
    do:
      - { id: "01HX0000000000000000000002", name: poll, type: http, request: { method: GET, url: "{URI}/poll" }, assert: [], extract: [{ var: state, from: body, path: "$.state" }, { var: id, from: body, path: "$.id" }] }
  - { id: "01HX0000000000000000000005", name: mid, type: http, request: { method: GET, url: "{URI}/mid" }, assert: [], extract: [{ var: id, from: body, path: "$.id"{DEF} }] }
  - { id: "01HX0000000000000000000006", name: z, type: http, request: { method: GET, url: "{URI}/z/{{id}}" }, assert: [] }
"#;

async fn clear_trace(def: &str) -> handicap_engine::ScenarioTrace {
    let server = MockServer::start().await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"state":"DONE"}"#))
        .mount(&server)
        .await;
    Mock::given(path("/mid"))
        .respond_with(json_resp("{}"))
        .mount(&server)
        .await;
    let sc = Scenario::from_yaml(&fill(CLEAR, &server.uri(), def)).unwrap();
    trace_scenario(&sc, &opts()).await
}

// 앞서 비워진 이름이 뒤 스텝의 기본값으로 주소에 쓸 수 있게 되는 흐름을 고정한다.
// 비움 표 항목이 지워지는지는 고정하지 않는다: `blank_guard::check`는 이름이 표에 있고 값이 비어 있을
// 때만 막는데 기본값은 비지 않아 관찰할 수 없다(`filled.defaulted`를 note_step에 넘겨도 초록이었다).
#[tokio::test]
async fn trace_default_unblocks_name_blanked_earlier() {
    let t = clear_trace(", default: none").await;
    assert_eq!(row(&t.steps, A_ID).defaulted, vec!["id".to_string()]);
    let z = row(&t.steps, X_ID);
    assert!(z.blocked.is_none(), "{z:?}");
    assert!(url(z).ends_with("/z/none"), "{}", url(z));
}

#[tokio::test]
async fn trace_default_unblocks_name_blanked_earlier_control_without_default_stays_blocked() {
    let t = clear_trace("").await;
    assert!(row(&t.steps, X_ID).blocked.is_some());
}
