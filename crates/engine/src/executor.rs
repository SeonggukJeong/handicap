use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::cookie::Jar;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::error::{EngineError, Result};
use crate::extract::{ResponseFacts, evaluate as evaluate_extracts};
use crate::scenario::{Assertion, Body, CookieJarMode, HttpMethod, HttpStep};
use crate::template::{TemplateContext, render, render_collecting};
use crate::trace::{HttpTrace, TracedRequest, TracedResponse};

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

/// Recursively render `{{var}}`/`${ENV}` in every string leaf of a JSON value.
/// Numbers, booleans, null, and object keys are preserved unchanged.
fn render_json_value(
    value: &serde_json::Value,
    ctx: &TemplateContext<'_>,
) -> Result<serde_json::Value> {
    use serde_json::Value;
    Ok(match value {
        Value::String(s) => Value::String(render(s, ctx)?),
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(render_json_value(item, ctx)?);
            }
            Value::Array(out)
        }
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k.clone(), render_json_value(v, ctx)?); // object keys preserved verbatim — only string-leaf values are rendered
            }
            Value::Object(out)
        }
        // Number / Bool / Null — preserved as-is.
        other => other.clone(),
    })
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
            Body::Json(v) => {
                let rendered = render_json_value(v, ctx)?;
                req.json(&rendered)
            }
            Body::Form(map) => {
                let mut rendered = BTreeMap::new();
                for (k, v) in map {
                    rendered.insert(k.clone(), render(v, ctx)?); // keys are authored identifiers, not user data — render values only
                }
                req.form(&rendered)
            }
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

/// Response bodies larger than this are truncated in the trace (UI display cap).
const MAX_TRACE_BODY_BYTES: usize = 16 * 1024;

/// Lenient+collecting JSON render (trace sibling of `render_json_value`): renders
/// every string leaf via `render_collecting`, preserving numbers/bools/null and
/// object keys, and appending unresolved token names to `unbound`.
fn render_json_collecting(
    value: &serde_json::Value,
    ctx: &TemplateContext<'_>,
    unbound: &mut Vec<String>,
) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::String(s) => Value::String(render_collecting(s, ctx, unbound)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|i| render_json_collecting(i, ctx, unbound))
                .collect(),
        ),
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k.clone(), render_json_collecting(v, ctx, unbound));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Trace sibling of [`execute_step`]: renders leniently (collecting unbound tokens)
/// and KEEPS the resolved request + response detail. Never errors — failures are
/// captured in the returned `HttpTrace.error`. Does not touch the load hot path.
pub async fn execute_step_traced(
    client: &VuClient,
    step: &HttpStep,
    ctx: &TemplateContext<'_>,
) -> HttpTrace {
    let mut unbound: Vec<String> = Vec::new();
    let url = render_collecting(&step.request.url, ctx, &mut unbound);

    let (method_str, method) = match step.request.method {
        HttpMethod::Get => ("GET", reqwest::Method::GET),
        HttpMethod::Post => ("POST", reqwest::Method::POST),
        HttpMethod::Put => ("PUT", reqwest::Method::PUT),
        HttpMethod::Patch => ("PATCH", reqwest::Method::PATCH),
        HttpMethod::Delete => ("DELETE", reqwest::Method::DELETE),
        HttpMethod::Head => ("HEAD", reqwest::Method::HEAD),
        HttpMethod::Options => ("OPTIONS", reqwest::Method::OPTIONS),
    };

    let mut header_display: BTreeMap<String, String> = BTreeMap::new();
    let mut headers = HeaderMap::new();
    let mut build_error: Option<String> = None;
    for (k, v) in &step.request.headers {
        let rv = render_collecting(v, ctx, &mut unbound);
        header_display.insert(k.clone(), rv.clone());
        match (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(&rv),
        ) {
            (Ok(name), Ok(val)) => {
                headers.insert(name, val);
            }
            _ => {
                if build_error.is_none() {
                    build_error = Some(format!("invalid header {k}"));
                }
            }
        }
    }

    // Render + record the body (display form) and attach to the request builder.
    let mut body_display: Option<String> = None;
    let mut req = client.inner.request(method, &url).headers(headers);
    if let Some(body) = &step.request.body {
        req = match body {
            Body::Json(v) => {
                let rendered = render_json_collecting(v, ctx, &mut unbound);
                body_display = serde_json::to_string(&rendered).ok();
                req.json(&rendered)
            }
            Body::Form(map) => {
                let mut rendered = BTreeMap::new();
                for (k, v) in map {
                    rendered.insert(k.clone(), render_collecting(v, ctx, &mut unbound));
                }
                body_display = Some(
                    rendered
                        .iter()
                        .map(|(k, v)| format!("{k}={v}"))
                        .collect::<Vec<_>>()
                        .join("&"),
                );
                req.form(&rendered)
            }
            Body::Raw(s) => {
                let rendered = render_collecting(s, ctx, &mut unbound);
                body_display = Some(rendered.clone());
                req.body(rendered)
            }
        };
    }

    unbound.dedup();
    let request = TracedRequest {
        method: method_str.to_string(),
        url,
        headers: header_display,
        body: body_display,
    };

    let started = std::time::Instant::now();
    let outcome = req.send().await;
    let latency_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;

    let resp = match outcome {
        Ok(r) => r,
        Err(e) => {
            return HttpTrace {
                request,
                response: None,
                extracted: BTreeMap::new(),
                unbound_vars: unbound,
                error: Some(build_error.unwrap_or_else(|| e.to_string())),
            };
        }
    };

    let status = resp.status().as_u16();
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
            return HttpTrace {
                request,
                response: Some(TracedResponse {
                    status,
                    latency_ms,
                    headers: resp_headers.iter().cloned().collect(),
                    set_cookies,
                    body: String::new(),
                    body_truncated: false,
                }),
                extracted: BTreeMap::new(),
                unbound_vars: unbound,
                error: Some(format!("read body: {e}")),
            };
        }
    };

    let full_len = body_bytes.len();
    let body_truncated = full_len > MAX_TRACE_BODY_BYTES;
    let body =
        String::from_utf8_lossy(&body_bytes[..full_len.min(MAX_TRACE_BODY_BYTES)]).into_owned();

    let mut error: Option<String> = build_error;
    if error.is_none() {
        for a in &step.assert {
            match a {
                Assertion::Status(want) if *want != status => {
                    error = Some(format!("status {} != {}", status, want));
                    break;
                }
                _ => {}
            }
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

    HttpTrace {
        request,
        response: Some(TracedResponse {
            status,
            latency_ms,
            headers: resp_headers.into_iter().collect(),
            set_cookies,
            body,
            body_truncated,
        }),
        extracted,
        unbound_vars: unbound,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::{Body, Extract, HttpMethod, HttpStep, Request};
    use std::collections::BTreeMap;
    use wiremock::matchers::{body_json, body_string_contains, method, path};
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

    #[tokio::test]
    async fn form_body_values_are_templated() {
        let server = MockServer::start().await;
        // 치환이 됐을 때만(user=alice) 200, 아니면 매칭 실패로 404.
        Mock::given(method("POST"))
            .and(path("/login"))
            .and(body_string_contains("user=alice"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let mut form = BTreeMap::new();
        form.insert("user".to_string(), "{{username}}".to_string());
        let step = HttpStep {
            id: "01HX0000000000000000000010".into(),
            name: "login".into(),
            request: Request {
                method: HttpMethod::Post,
                url: format!("{}/login", server.uri()),
                headers: BTreeMap::new(),
                body: Some(Body::Form(form)),
            },
            assert: vec![],
            extract: vec![],
        };
        let mut vars = BTreeMap::new();
        vars.insert("username".to_string(), "alice".to_string());
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
        assert_eq!(
            outcome.status, 200,
            "form value must be templated to user=alice"
        );
        assert!(outcome.error.is_none(), "no error: {:?}", outcome.error);
    }

    #[tokio::test]
    async fn json_body_string_leaves_are_templated_numbers_preserved() {
        let server = MockServer::start().await;
        // user는 치환되어 "alice", age는 number 30 그대로여야 매칭 → 200.
        Mock::given(method("POST"))
            .and(path("/signup"))
            .and(body_json(serde_json::json!({ "user": "alice", "age": 30 })))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let step = HttpStep {
            id: "01HX0000000000000000000011".into(),
            name: "signup".into(),
            request: Request {
                method: HttpMethod::Post,
                url: format!("{}/signup", server.uri()),
                headers: BTreeMap::new(),
                body: Some(Body::Json(serde_json::json!({
                    "user": "{{username}}",
                    "age": 30
                }))),
            },
            assert: vec![],
            extract: vec![],
        };
        let mut vars = BTreeMap::new();
        vars.insert("username".to_string(), "alice".to_string());
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
        assert_eq!(
            outcome.status, 200,
            "JSON string leaf must template (user=alice) and number 30 must be preserved"
        );
        assert!(outcome.error.is_none(), "no error: {:?}", outcome.error);
    }

    #[tokio::test]
    async fn form_body_unknown_var_propagates_err() {
        let mut form = BTreeMap::new();
        form.insert("user".to_string(), "{{missing}}".to_string());
        let step = HttpStep {
            id: "01HX0000000000000000000012".into(),
            name: "x".into(),
            request: Request {
                method: HttpMethod::Post,
                url: "http://127.0.0.1:1/x".into(),
                headers: BTreeMap::new(),
                body: Some(Body::Form(form)),
            },
            assert: vec![],
            extract: vec![],
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
        let result = execute_step(&client, &step, &ctx).await;
        assert!(
            matches!(result, Err(EngineError::UnknownVar(_))),
            "got: {result:?}"
        );
    }

    #[tokio::test]
    async fn json_body_unknown_var_propagates_err() {
        let step = HttpStep {
            id: "01HX0000000000000000000013".into(),
            name: "x".into(),
            request: Request {
                method: HttpMethod::Post,
                url: "http://127.0.0.1:1/x".into(),
                headers: BTreeMap::new(),
                body: Some(Body::Json(serde_json::json!({ "user": "{{missing}}" }))),
            },
            assert: vec![],
            extract: vec![],
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
        let result = execute_step(&client, &step, &ctx).await;
        assert!(
            matches!(result, Err(EngineError::UnknownVar(_))),
            "got: {result:?}"
        );
    }

    #[tokio::test]
    async fn traced_step_captures_request_response_and_unbound() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ping"))
            .respond_with(
                ResponseTemplate::new(201)
                    .insert_header("x-trace", "yes")
                    .set_body_string("pong-body"),
            )
            .mount(&server)
            .await;

        let mut headers = BTreeMap::new();
        headers.insert("x-token".to_string(), "{{missing}}".to_string()); // unbound → empty
        let step = HttpStep {
            id: "01HX0000000000000000000002".into(),
            name: "ping".into(),
            request: Request {
                method: HttpMethod::Get,
                url: format!("{}/ping", server.uri()),
                headers,
                body: None,
            },
            assert: vec![],
            extract: vec![],
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
        let t = execute_step_traced(&client, &step, &ctx).await;

        assert_eq!(t.request.method, "GET");
        assert_eq!(
            t.request.headers.get("x-token").map(String::as_str),
            Some("")
        ); // rendered empty
        assert_eq!(t.unbound_vars, vec!["missing".to_string()]);
        let resp = t.response.expect("response captured");
        assert_eq!(resp.status, 201);
        assert_eq!(resp.body, "pong-body");
        assert!(!resp.body_truncated);
        assert_eq!(resp.headers.get("x-trace").map(String::as_str), Some("yes"));
        assert!(t.error.is_none(), "{:?}", t.error);
    }

    #[tokio::test]
    async fn traced_step_reports_connection_error_with_request_kept() {
        let step = HttpStep {
            id: "01HX0000000000000000000003".into(),
            name: "down".into(),
            request: Request {
                method: HttpMethod::Get,
                url: "http://127.0.0.1:1/nope".into(), // refused fast
                headers: BTreeMap::new(),
                body: None,
            },
            assert: vec![],
            extract: vec![],
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
        let t = execute_step_traced(&client, &step, &ctx).await;
        assert!(t.response.is_none());
        assert!(t.error.is_some());
        assert_eq!(t.request.url, "http://127.0.0.1:1/nope"); // request still captured
    }

    #[test]
    fn render_json_value_recurses_objects_and_arrays_preserving_types() {
        let mut vars = BTreeMap::new();
        vars.insert("name".to_string(), "alice".to_string());
        vars.insert("tag".to_string(), "vip".to_string());
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({
            "outer": { "user": "{{name}}", "age": 30, "active": true, "note": null },
            "tags": ["{{tag}}", "static", 7]
        });
        let out = render_json_value(&input, &ctx).unwrap();
        assert_eq!(
            out,
            serde_json::json!({
                "outer": { "user": "alice", "age": 30, "active": true, "note": null },
                "tags": ["vip", "static", 7]
            })
        );
    }
}
