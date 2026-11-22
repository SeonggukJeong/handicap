use handicap_engine::scenario::{DisabledRows, Extract};
use handicap_engine::{
    Assertion, CookieJarMode, ErrorClass, ExtractMode, HttpMethod, HttpStep, Request,
    TemplateContext, VuClient, execute_step, execute_step_with,
};
use std::collections::BTreeMap;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn step(url: String, assert: Vec<Assertion>, default: Option<&str>) -> HttpStep {
    HttpStep {
        id: "01HX0000000000000000000010".into(),
        name: "login".into(),
        request: Request {
            method: HttpMethod::Get,
            url,
            headers: BTreeMap::new(),
            body: None,
            disabled: DisabledRows::default(),
        },
        assert,
        extract: vec![Extract::Body {
            decode: None,
            claim: None,
            var: "var".into(),
            path: "$.missing".into(),
            default: default.map(String::from),
        }],
        timeout_seconds: None,
        think_time: None,
    }
}

async fn server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/p"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"code":"x"}"#))
        .mount(&server)
        .await;
    server
}

fn ctx<'a>(
    vars: &'a BTreeMap<String, String>,
    env: &'a BTreeMap<String, String>,
) -> TemplateContext<'a> {
    TemplateContext {
        vars,
        env,
        vu_id: 0,
        iter_id: 0,
        loop_index: None,
    }
}

#[tokio::test]
async fn strict_no_defaults_ignores_default() {
    let srv = server().await;
    let s = step(format!("{}/p", srv.uri()), vec![], Some("x"));
    let (vars, env) = (BTreeMap::new(), BTreeMap::new());
    let client = VuClient::new(CookieJarMode::Off).unwrap();

    let o = execute_step_with(
        &client,
        &s,
        &ctx(&vars, &env),
        ExtractMode::StrictNoDefaults,
    )
    .await
    .unwrap();
    assert!(o.error.is_some());
    assert_eq!(o.error_class, Some(ErrorClass::Extract));
    assert!(!o.extracted.contains_key("var"));

    let o = execute_step_with(&client, &s, &ctx(&vars, &env), ExtractMode::Strict)
        .await
        .unwrap();
    assert!(o.error.is_none(), "error: {:?}", o.error);
    assert!(!o.extracted.contains_key("var"));
}

#[tokio::test]
async fn error_class_matches_error() {
    let srv = server().await;
    let (vars, env) = (BTreeMap::new(), BTreeMap::new());
    let client = VuClient::new(CookieJarMode::Off).unwrap();

    let ok = step(format!("{}/p", srv.uri()), vec![], Some("x"));
    let o = execute_step(&client, &ok, &ctx(&vars, &env)).await.unwrap();
    assert!(o.error.is_none());
    assert_eq!(o.error_class, None);

    let bad_status = step(
        format!("{}/p", srv.uri()),
        vec![Assertion::Status(201)],
        None,
    );
    let o = execute_step(&client, &bad_status, &ctx(&vars, &env))
        .await
        .unwrap();
    assert_eq!(o.error_class, Some(ErrorClass::StatusAssert));

    let no_extract = step(format!("{}/p", srv.uri()), vec![], None);
    let o = execute_step(&client, &no_extract, &ctx(&vars, &env))
        .await
        .unwrap();
    assert_eq!(o.error_class, Some(ErrorClass::Extract));

    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    let dead = step(format!("http://127.0.0.1:{port}/p"), vec![], None);
    let o = execute_step(&client, &dead, &ctx(&vars, &env))
        .await
        .unwrap();
    assert_eq!(o.error_class, Some(ErrorClass::Send));
}

#[tokio::test]
async fn traced_strict_no_defaults_ignores_default() {
    let srv = server().await;
    let s = step(format!("{}/p", srv.uri()), vec![], Some("x"));
    let (vars, env) = (BTreeMap::new(), BTreeMap::new());
    let client = VuClient::new(CookieJarMode::Off).unwrap();

    let t = handicap_engine::execute_step_traced_with(
        &client,
        &s,
        &ctx(&vars, &env),
        ExtractMode::StrictNoDefaults,
    )
    .await;
    assert!(t.error.is_some());
    assert!(!t.extracted.contains_key("var"));

    let t = handicap_engine::execute_step_traced_with(
        &client,
        &s,
        &ctx(&vars, &env),
        ExtractMode::Strict,
    )
    .await;
    assert!(t.error.is_none(), "error: {:?}", t.error);
}
