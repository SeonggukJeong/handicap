use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::cookie::Jar;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::error::{EngineError, Result};
use crate::scenario::{Assertion, Body, CookieJarMode, HttpMethod, Scenario, Step};
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
}

pub async fn execute_step(
    client: &VuClient,
    step: &Step,
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
            // Drain body so connection returns to pool — but cap to avoid huge bodies hurting numbers.
            let _ = resp.bytes().await;
            let mut error = None;
            for a in &step.assert {
                match a {
                    Assertion::Status(want) if *want != status => {
                        error = Some(format!("status {} != {}", status, want));
                        break;
                    }
                    _ => {}
                }
            }
            Ok(ExecOutcome {
                step_id: step.id.clone(),
                status,
                latency,
                error,
            })
        }
        Err(e) => Ok(ExecOutcome {
            step_id: step.id.clone(),
            status: 0,
            latency,
            error: Some(e.to_string()),
        }),
    }
}

/// Convenience for callers that always want the scenario's cookie_jar mode.
pub fn client_for_scenario(s: &Scenario) -> Result<VuClient> {
    VuClient::new(s.cookie_jar)
}
