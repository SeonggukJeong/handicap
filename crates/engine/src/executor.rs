use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::cookie::Jar;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::cast::{Cast, coerce_bool, coerce_num, parse_cast_leaf};
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
    /// Back-compat constructor: 30s total request timeout (pre-S-A default).
    pub fn new(cookie_mode: CookieJarMode) -> Result<Self> {
        Self::with_timeout(cookie_mode, Duration::from_secs(30))
    }

    /// Build a client with an explicit total request timeout. `run_vu` uses this
    /// to thread `RunPlan.http_timeout`; `new` delegates here with the 30s default.
    pub fn with_timeout(cookie_mode: CookieJarMode, timeout: Duration) -> Result<Self> {
        let mut builder = reqwest::Client::builder()
            .timeout(timeout)
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
    /// Body-download time (headers-received → body-complete). `Some` only on the
    /// success path (`bytes().await` reached); `None` on transport failure. TTFB is
    /// `latency` (measured at `send().await`, before body). Phase-breakdown (B7-C).
    pub download: Option<Duration>,
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
        Value::String(s) => match parse_cast_leaf(s) {
            // :str 캐스트 = bare 토큰을 문자열로(접미사만 제거).
            Some((bare, Cast::Str)) => Value::String(render(&bare, ctx)?),
            Some((bare, Cast::Num)) => {
                let r = render(&bare, ctx)?; // strict: 미바인딩이면 여기서 UnknownVar
                coerce_num(&r).ok_or(EngineError::CastFailed {
                    var: bare,
                    cast: "num",
                    value: r,
                })?
            }
            Some((bare, Cast::Bool)) => {
                let r = render(&bare, ctx)?;
                coerce_bool(&r).ok_or(EngineError::CastFailed {
                    var: bare,
                    cast: "bool",
                    value: r,
                })?
            }
            // 캐스트 없음/미지원 keyword/혼합/env → parse_cast_leaf None → 원문 s 그대로 렌더(byte-identical).
            None => Value::String(render(s, ctx)?),
        },
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
    if let Some(secs) = step.timeout_seconds.filter(|s| *s > 0) {
        req = req.timeout(Duration::from_secs(u64::from(secs)));
    }

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
            let dl_start = Instant::now();
            let body_bytes = match resp.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    return Ok(ExecOutcome {
                        step_id: step.id.clone(),
                        status,
                        latency,
                        download: None, // body read failed → no clean download sample
                        error: Some(format!("read body: {e}")),
                        extracted: BTreeMap::new(),
                    });
                }
            };
            let download = Some(dl_start.elapsed());

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
                download,
                error,
                extracted,
            })
        }
        Err(e) => Ok(ExecOutcome {
            step_id: step.id.clone(),
            status: 0,
            latency,
            download: None,
            error: Some(e.to_string()),
            extracted: BTreeMap::new(),
        }),
    }
}

/// Response bodies larger than this are truncated in the trace. UI display cap:
/// the editor shows a short inline preview and the full body in a modal. Per-step,
/// so worst-case trace memory ≈ max_requests × this. Future: expose via an options
/// menu (see docs/roadmap.md §B2'' "운영 상한 관리자 화면").
const MAX_TRACE_BODY_BYTES: usize = 1024 * 1024;

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
        Value::String(s) => match parse_cast_leaf(s) {
            Some((bare, Cast::Str)) => Value::String(render_collecting(&bare, ctx, unbound)),
            Some((bare, Cast::Num)) => {
                let r = render_collecting(&bare, ctx, unbound);
                coerce_num(&r).unwrap_or(Value::String(r)) // best-effort: 실패 시 문자열
            }
            Some((bare, Cast::Bool)) => {
                let r = render_collecting(&bare, ctx, unbound);
                coerce_bool(&r).unwrap_or(Value::String(r))
            }
            // 캐스트 없음/미지원 keyword/혼합/env → parse_cast_leaf None → 원문 s 그대로 렌더(byte-identical).
            None => Value::String(render_collecting(s, ctx, unbound)),
        },
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
    if let Some(secs) = step.timeout_seconds.filter(|s| *s > 0) {
        req = req.timeout(Duration::from_secs(u64::from(secs)));
    }
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

    // A token may render in the url, headers, and body, so the same name can be
    // collected non-consecutively — Vec::dedup only collapses *adjacent* dups.
    // De-duplicate order-preservingly (keep first occurrence) so unbound_vars is a set.
    let mut seen = std::collections::HashSet::new();
    unbound.retain(|name| seen.insert(name.clone()));
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
    use crate::scenario::{Body, DisabledRows, Extract, HttpMethod, HttpStep, Request};
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
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![Extract::Body {
                var: "token".into(),
                path: "$.access_token".into(),
            }],
            timeout_seconds: None,
            think_time: None,
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
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![Extract::Body {
                var: "t".into(),
                path: "$.no".into(),
            }],
            timeout_seconds: None,
            think_time: None,
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
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
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
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
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
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
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
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
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
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
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
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
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

    #[tokio::test]
    async fn traced_step_dedups_nonconsecutive_unbound_vars() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/p"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        // {{a}} appears in the url, then {{b}} in a header, then {{a}} again in
        // another header — non-consecutive accumulation order [a, b, a].
        let mut headers = BTreeMap::new();
        headers.insert("h1".to_string(), "{{b}}".to_string());
        headers.insert("h2".to_string(), "{{a}}".to_string());
        let step = HttpStep {
            id: "01HX0000000000000000000005".into(),
            name: "dup".into(),
            request: Request {
                method: HttpMethod::Get,
                url: format!("{}/p?x={{{{a}}}}", server.uri()),
                headers,
                body: None,
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
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
        // "a" must appear exactly once despite rendering in url + h2.
        assert_eq!(
            t.unbound_vars.iter().filter(|n| *n == "a").count(),
            1,
            "got {:?}",
            t.unbound_vars
        );
        let mut sorted = t.unbound_vars.clone();
        sorted.sort();
        assert_eq!(sorted, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn json_cast_num_and_bool_coerce() {
        let vars: BTreeMap<String, String> =
            [("age".into(), "30".into()), ("vip".into(), "true".into())]
                .into_iter()
                .collect();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({ "age": "{{age:num}}", "vip": "{{vip:bool}}" });
        let out = render_json_value(&input, &ctx).unwrap();
        assert_eq!(out, serde_json::json!({ "age": 30, "vip": true }));
    }

    #[test]
    fn json_cast_str_and_no_cast_stay_string() {
        let vars: BTreeMap<String, String> = [
            ("zip".into(), "01234".into()),
            ("name".into(), "Lee".into()),
        ]
        .into_iter()
        .collect();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({ "zip": "{{zip:str}}", "name": "{{name}}" });
        let out = render_json_value(&input, &ctx).unwrap();
        assert_eq!(out, serde_json::json!({ "zip": "01234", "name": "Lee" }));
    }

    #[test]
    fn json_cast_failure_errors_strict() {
        let vars: BTreeMap<String, String> = [("age".into(), "abc".into())].into_iter().collect();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({ "age": "{{age:num}}" });
        assert!(matches!(
            render_json_value(&input, &ctx),
            Err(EngineError::CastFailed { .. })
        ));
    }

    #[test]
    fn json_cast_leading_zero_to_num_fails() {
        let vars: BTreeMap<String, String> = [("zip".into(), "01234".into())].into_iter().collect();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({ "zip": "{{zip:num}}" });
        assert!(matches!(
            render_json_value(&input, &ctx),
            Err(EngineError::CastFailed { .. })
        ));
    }

    #[test]
    fn json_mixed_leaf_cast_is_unknown_var() {
        // 혼합 leaf는 캐스트 미발동 → 일반 문자열 경로 → render가 "age:num" 변수를 못 찾음.
        let vars = BTreeMap::new();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({ "msg": "no {{age:num}} here" });
        assert!(matches!(
            render_json_value(&input, &ctx),
            Err(EngineError::UnknownVar(_))
        ));
    }

    #[test]
    fn json_without_casts_is_byte_identical() {
        // 하위호환 불변식: 캐스트 토큰이 없으면 8a 동작 그대로(문자열 leaf 치환, 타입 보존).
        let vars: BTreeMap<String, String> = [("n".into(), "Lee".into())].into_iter().collect();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({ "s": "hi {{n}}", "k": 7, "b": false, "z": null });
        let out = render_json_value(&input, &ctx).unwrap();
        assert_eq!(
            out,
            serde_json::json!({ "s": "hi Lee", "k": 7, "b": false, "z": null })
        );
    }

    #[test]
    fn json_cast_str_on_missing_var_still_errors_strict() {
        // :str도 bare 토큰을 strict render → 미바인딩이면 coerce 전에 UnknownVar.
        let vars = BTreeMap::new();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({ "zip": "{{zip:str}}" });
        assert!(matches!(
            render_json_value(&input, &ctx),
            Err(EngineError::UnknownVar(_))
        ));
    }

    #[test]
    fn trace_json_cast_coerces_and_keeps_string_on_failure() {
        let vars: BTreeMap<String, String> =
            [("age".into(), "30".into()), ("bad".into(), "abc".into())]
                .into_iter()
                .collect();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({ "age": "{{age:num}}", "bad": "{{bad:num}}" });
        let mut unbound = Vec::new();
        let out = render_json_collecting(&input, &ctx, &mut unbound);
        // 성공한 캐스트는 number, 실패한 캐스트는 렌더된 문자열 유지(Err 없음).
        assert_eq!(out, serde_json::json!({ "age": 30, "bad": "abc" }));
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

    #[tokio::test]
    async fn disabled_header_and_form_rows_are_not_sent() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/submit"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let mut headers = BTreeMap::new();
        headers.insert("X-Active".to_string(), "on".to_string());
        let mut disabled_headers = BTreeMap::new();
        disabled_headers.insert("X-Disabled".to_string(), "off".to_string());
        let mut form = BTreeMap::new();
        form.insert("keep".to_string(), "1".to_string());
        let mut disabled_form = BTreeMap::new();
        disabled_form.insert("skip".to_string(), "2".to_string());

        let step = HttpStep {
            id: "01HX0000000000000000000099".into(),
            name: "submit".into(),
            request: Request {
                method: HttpMethod::Post,
                url: format!("{}/submit", server.uri()),
                headers,
                body: Some(Body::Form(form)),
                disabled: DisabledRows {
                    headers: disabled_headers,
                    form: disabled_form,
                },
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
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

        let reqs = server.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1);
        let req = &reqs[0];
        assert!(
            req.headers.get("x-disabled").is_none(),
            "disabled header must not be sent"
        );
        assert_eq!(
            req.headers.get("x-active").map(|v| v.to_str().unwrap()),
            Some("on"),
        );
        let body = String::from_utf8_lossy(&req.body);
        assert!(body.contains("keep=1"), "active form field present: {body}");
        assert!(
            !body.contains("skip"),
            "disabled form field must not be sent: {body}"
        );
    }

    #[tokio::test]
    async fn traced_body_under_cap_is_not_truncated() {
        // 17 KiB ASCII — old 16 KiB cap WOULD truncate (RED), 1 MiB cap does not.
        let big = "a".repeat(17 * 1024);
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/big"))
            .respond_with(ResponseTemplate::new(200).set_body_string(big.clone()))
            .mount(&server)
            .await;
        let step = HttpStep {
            id: "01HX0000000000000000000021".into(),
            name: "big".into(),
            request: Request {
                method: HttpMethod::Get,
                url: format!("{}/big", server.uri()),
                headers: BTreeMap::new(),
                body: None,
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
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
        let resp = t.response.expect("response captured");
        assert!(!resp.body_truncated, "17 KiB must fit under the 1 MiB cap");
        assert_eq!(resp.body.len(), 17 * 1024);
    }

    #[tokio::test]
    async fn execute_step_measures_download_on_success() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/dl"))
            .respond_with(ResponseTemplate::new(200).set_body_string("x".repeat(2048)))
            .mount(&server)
            .await;
        let step = HttpStep {
            id: "01HX0000000000000000000041".into(),
            name: "dl".into(),
            request: Request {
                method: HttpMethod::Get,
                url: format!("{}/dl", server.uri()),
                headers: BTreeMap::new(),
                body: None,
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
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
        assert!(
            outcome.download.is_some(),
            "download phase measured on success"
        );
    }

    #[tokio::test]
    async fn execute_step_no_download_on_connection_error() {
        let step = HttpStep {
            id: "01HX0000000000000000000042".into(),
            name: "down".into(),
            request: Request {
                method: HttpMethod::Get,
                url: "http://127.0.0.1:1/nope".into(), // refused fast — never reaches body
                headers: BTreeMap::new(),
                body: None,
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
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
        assert_eq!(outcome.status, 0);
        assert!(
            outcome.download.is_none(),
            "no download phase on transport failure"
        );
    }

    #[tokio::test]
    async fn traced_body_over_cap_is_truncated() {
        // cap + 1 KiB ASCII — must truncate at the cap, byte-length robust to U+FFFD.
        let big = "a".repeat(MAX_TRACE_BODY_BYTES + 1024);
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/huge"))
            .respond_with(ResponseTemplate::new(200).set_body_string(big))
            .mount(&server)
            .await;
        let step = HttpStep {
            id: "01HX0000000000000000000022".into(),
            name: "huge".into(),
            request: Request {
                method: HttpMethod::Get,
                url: format!("{}/huge", server.uri()),
                headers: BTreeMap::new(),
                body: None,
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
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
        let resp = t.response.expect("response captured");
        assert!(resp.body_truncated, "body over cap must be truncated");
        // from_utf8_lossy can add a U+FFFD (3 bytes) at the boundary → not strict ==.
        assert!(resp.body.len() <= MAX_TRACE_BODY_BYTES + 2);
    }
}
