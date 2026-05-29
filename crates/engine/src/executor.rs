use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::cookie::Jar;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::error::{EngineError, Result};
use crate::extract::{ResponseFacts, evaluate as evaluate_extracts};
use crate::scenario::{Assertion, Body, CookieJarMode, HttpMethod, HttpStep, Scenario};
use crate::template::{TemplateContext, render};

/// Per-VU HTTP client. Holds its own cookie jar so sessions are isolated.
pub struct VuClient {
    inner: reqwest::Client,
}

impl VuClient {
    pub fn new(cookie_mode: CookieJarMode) -> Result<Self> {
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("handicap/0.1");
        if let CookieJarMode::Auto = cookie_mode {
            let jar = Arc::new(Jar::default());
            builder = builder.cookie_provider(jar);
        }
        let inner = builder.build()?;
        Ok(Self { inner })
    }
}

#[derive(Debug, Clone)]
pub struct ExecOutcome {
    pub step_id: String,
    pub status: u16,
    pub latency: Duration,
    pub error: Option<String>,
    pub extracted: BTreeMap<String, String>,
}

pub async fn execute_step(
    client: &VuClient,
    step: &HttpStep,
    ctx: &TemplateContext<'_>,
) -> Result<ExecOutcome> {
    let url = render(&step.request.url, ctx)?;
    let mut headers = HeaderMap::new();
    for (k, v) in &step.request.headers {
        let v = render(v, ctx)?;
        let name = HeaderName::from_bytes(k.as_bytes())
            .map_err(|e| EngineError::MalformedTemplate(format!("header name {k}: {e}")))?;
        let value = HeaderValue::from_str(&v)
            .map_err(|e| EngineError::MalformedTemplate(format!("header value {k}: {e}")))?;
        headers.insert(name, value);
    }

    let method = match step.request.method {
        HttpMethod::Get => reqwest::Method::GET,
        HttpMethod::Post => reqwest::Method::POST,
        HttpMethod::Put => reqwest::Method::PUT,
        HttpMethod::Patch => reqwest::Method::PATCH,
        HttpMethod::Delete => reqwest::Method::DELETE,
        HttpMethod::Head => reqwest::Method::HEAD,
        HttpMethod::Options => reqwest::Method::OPTIONS,
    };

    let mut req = client.inner.request(method, &url).headers(headers);

    if let Some(body) = &step.request.body {
        req = match body {
            Body::Json(v) => req.json(v),
            Body::Form(map) => req.form(map),
            Body::Raw(s) => {
                let rendered = render(s, ctx)?;
                req.body(rendered)
            }
        };
    }

    let started = Instant::now();
    let outcome = req.send().await;
    let latency = started.elapsed();

    match outcome {
        Ok(resp) => {
            let status = resp.status().as_u16();
            // Collect headers + Set-Cookie before consuming the response.
            let resp_headers: Vec<(String, String)> = resp
                .headers()
                .iter()
                .filter_map(|(k, v)| {
                    v.to_str()
                        .ok()
                        .map(|s| (k.as_str().to_string(), s.to_string()))
                })
                .collect();
            let set_cookies: Vec<String> = resp
                .headers()
                .get_all(reqwest::header::SET_COOKIE)
                .iter()
                .filter_map(|v| v.to_str().ok().map(String::from))
                .collect();
            let body_bytes = match resp.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    return Ok(ExecOutcome {
                        step_id: step.id.clone(),
                        status,
                        latency,
                        error: Some(format!("read body: {e}")),
                        extracted: BTreeMap::new(),
                    });
                }
            };

            let mut error: Option<String> = None;
            for a in &step.assert {
                match a {
                    Assertion::Status(want) if *want != status => {
                        error = Some(format!("status {} != {}", status, want));
                        break;
                    }
                    _ => {}
                }
            }

            let mut extracted = BTreeMap::new();
            if error.is_none() && !step.extract.is_empty() {
                let facts = ResponseFacts {
                    status,
                    headers: &resp_headers,
                    set_cookies: &set_cookies,
                    body: &body_bytes,
                };
                match evaluate_extracts(&step.extract, &facts) {
                    Ok(map) => extracted = map,
                    Err(e) => error = Some(e.to_string()),
                }
            }

            Ok(ExecOutcome {
                step_id: step.id.clone(),
                status,
                latency,
                error,
                extracted,
            })
        }
        Err(e) => Ok(ExecOutcome {
            step_id: step.id.clone(),
            status: 0,
            latency,
            error: Some(e.to_string()),
            extracted: BTreeMap::new(),
        }),
    }
}

/// Convenience for callers that always want the scenario's cookie_jar mode.
pub fn client_for_scenario(s: &Scenario) -> Result<VuClient> {
    VuClient::new(s.cookie_jar)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::{Extract, HttpMethod, HttpStep, Request};
    use std::collections::BTreeMap;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn empty_env() -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    #[tokio::test]
    async fn extract_token_from_body_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"access_token":"T0K3N"}"#))
            .mount(&server)
            .await;

        let step = HttpStep {
            id: "01HX0000000000000000000001".into(),
            name: "login".into(),
            request: Request {
                method: HttpMethod::Post,
                url: format!("{}/login", server.uri()),
                headers: BTreeMap::new(),
                body: None,
            },
            assert: vec![],
            extract: vec![Extract::Body {
                var: "token".into(),
                path: "$.access_token".into(),
            }],
        };
        let vars = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();
        let outcome = execute_step(&client, &step, &ctx).await.unwrap();
        assert_eq!(outcome.status, 200);
        assert!(outcome.error.is_none(), "no error: {:?}", outcome.error);
        assert_eq!(
            outcome.extracted.get("token").map(String::as_str),
            Some("T0K3N")
        );
    }

    #[tokio::test]
    async fn extract_failure_records_step_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/empty"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;

        let step = HttpStep {
            id: "01HX0000000000000000000002".into(),
            name: "x".into(),
            request: Request {
                method: HttpMethod::Get,
                url: format!("{}/empty", server.uri()),
                headers: BTreeMap::new(),
                body: None,
            },
            assert: vec![],
            extract: vec![Extract::Body {
                var: "t".into(),
                path: "$.no".into(),
            }],
        };
        let vars = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();
        let outcome = execute_step(&client, &step, &ctx).await.unwrap();
        assert!(outcome.error.is_some(), "expected error");
        assert!(outcome.extracted.is_empty());
    }
}
