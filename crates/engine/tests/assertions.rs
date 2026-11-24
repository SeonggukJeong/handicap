use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RampDown, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// When the target returns 500 but the step asserts `status: 200`, the engine
/// must count every request as an error.  This verifies the full path:
///   executor: `Assertion::Status(200) != 500`  → `ExecOutcome { error: Some(_) }`
///   aggregator: `is_error = outcome.error.is_some()` → `error_count += 1`
///   flush: `StepWindow { error_count, count }` sent to the caller
///
/// followups-after-mvp1 #11
#[tokio::test]
async fn assertion_failure_increments_error_count() {
    let server = MockServer::start().await;

    // Always return 500 so the `assert: [{ status: 200 }]` always fires.
    Mock::given(method("GET"))
        .and(path("/always-500"))
        .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: assert-failure
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000040"
    name: failing-assert
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/always-500"
    assert:
      - status: 200
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(1),
        env: BTreeMap::new(),
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
    };

    let cancel = CancellationToken::new();
    let scenario_clone = scenario.clone();
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel_clone)
            .await
            .expect("run_scenario itself should not fail");
    });

    let mut total: u64 = 0;
    let mut errors: u64 = 0;
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");

    assert!(total > 0, "at least one request must have been recorded");
    assert_eq!(
        errors, total,
        "every request should have been counted as an error (got {errors} errors out of {total} requests)"
    );
}

// ---- 상태 코드 기본 규칙·목록·any (http-error-default ②a) ----

mod status_rule_paths {
    use handicap_engine::scenario::{DisabledRows, Extract};
    use handicap_engine::{
        Assertion, CookieJarMode, ErrorClass, HttpMethod, HttpStep, Request, StatusExpect,
        TemplateContext, VuClient, execute_step, execute_step_traced,
    };
    use std::collections::BTreeMap;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn step(url: String, assert: Vec<Assertion>) -> HttpStep {
        HttpStep {
            id: "01HX0000000000000000000050".into(),
            name: "s".into(),
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
                var: "code".into(),
                path: "$.code".into(),
                default: None,
            }],
            timeout_seconds: None,
            think_time: None,
        }
    }

    async fn server_with(status: u16) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/p"))
            .respond_with(ResponseTemplate::new(status).set_body_string(r#"{"code":"x"}"#))
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
    async fn no_assert_500_counts_as_error() {
        let srv = server_with(500).await;
        let (vars, env) = (BTreeMap::new(), BTreeMap::new());
        let client = VuClient::new(CookieJarMode::Off).unwrap();
        let s = step(format!("{}/p", srv.uri()), vec![]);
        let o = execute_step(&client, &s, &ctx(&vars, &env)).await.unwrap();
        assert_eq!(o.error.as_deref(), Some("status 500 (>= 400)"));
        assert_eq!(o.error_class, Some(ErrorClass::HttpStatus));
        assert!(o.extracted.is_empty());
    }

    #[tokio::test]
    async fn list_409_passes_and_extracts() {
        let srv = server_with(409).await;
        let (vars, env) = (BTreeMap::new(), BTreeMap::new());
        let client = VuClient::new(CookieJarMode::Off).unwrap();
        let s = step(
            format!("{}/p", srv.uri()),
            vec![Assertion::Status(StatusExpect::AnyOf(vec![200, 409]))],
        );
        let o = execute_step(&client, &s, &ctx(&vars, &env)).await.unwrap();
        assert!(o.error.is_none(), "error: {:?}", o.error);
        assert_eq!(o.extracted.get("code").map(String::as_str), Some("x"));

        let srv = server_with(500).await;
        let s = step(
            format!("{}/p", srv.uri()),
            vec![Assertion::Status(StatusExpect::AnyOf(vec![200, 409]))],
        );
        let o = execute_step(&client, &s, &ctx(&vars, &env)).await.unwrap();
        assert_eq!(o.error.as_deref(), Some("status 500 not in [200, 409]"));
        assert_eq!(o.error_class, Some(ErrorClass::StatusAssert));
    }

    #[tokio::test]
    async fn any_404_passes_and_extracts() {
        let srv = server_with(404).await;
        let (vars, env) = (BTreeMap::new(), BTreeMap::new());
        let client = VuClient::new(CookieJarMode::Off).unwrap();
        let s = step(
            format!("{}/p", srv.uri()),
            vec![Assertion::Status(StatusExpect::Any)],
        );
        let o = execute_step(&client, &s, &ctx(&vars, &env)).await.unwrap();
        assert!(o.error.is_none(), "error: {:?}", o.error);
        assert_eq!(o.extracted.get("code").map(String::as_str), Some("x"));
    }

    #[tokio::test]
    async fn traced_no_assert_404_is_error() {
        let srv = server_with(404).await;
        let (vars, env) = (BTreeMap::new(), BTreeMap::new());
        let client = VuClient::new(CookieJarMode::Off).unwrap();
        let s = step(format!("{}/p", srv.uri()), vec![]);
        let t = execute_step_traced(&client, &s, &ctx(&vars, &env)).await;
        assert_eq!(t.error.as_deref(), Some("status 404 (>= 400)"));
        assert!(t.extracted.is_empty());
    }

    #[tokio::test]
    async fn traced_list_mismatch_is_error() {
        let srv = server_with(500).await;
        let (vars, env) = (BTreeMap::new(), BTreeMap::new());
        let client = VuClient::new(CookieJarMode::Off).unwrap();
        let s = step(
            format!("{}/p", srv.uri()),
            vec![Assertion::Status(StatusExpect::AnyOf(vec![200, 409]))],
        );
        let t = execute_step_traced(&client, &s, &ctx(&vars, &env)).await;
        assert_eq!(t.error.as_deref(), Some("status 500 not in [200, 409]"));
        assert!(t.extracted.is_empty());
    }

    #[tokio::test]
    async fn traced_any_404_passes() {
        let srv = server_with(404).await;
        let (vars, env) = (BTreeMap::new(), BTreeMap::new());
        let client = VuClient::new(CookieJarMode::Off).unwrap();
        let s = step(
            format!("{}/p", srv.uri()),
            vec![Assertion::Status(StatusExpect::Any)],
        );
        let t = execute_step_traced(&client, &s, &ctx(&vars, &env)).await;
        assert!(t.error.is_none(), "error: {:?}", t.error);
    }
}
