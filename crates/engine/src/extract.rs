//! Per-step response extraction: JSONPath into body, header lookup, cookie
//! lookup, status code → named flow variable. Result goes into the per-VU
//! per-iteration `iter_vars` map consumed by subsequent steps.

use std::collections::BTreeMap;

use crate::error::{EngineError, Result};
use crate::scenario::Extract;

/// Captured response artifacts for a single step.
pub struct ResponseFacts<'a> {
    pub status: u16,
    pub headers: &'a [(String, String)],
    /// Raw `Set-Cookie` header values for this response (not the merged jar).
    pub set_cookies: &'a [String],
    /// Body bytes. Body is parsed lazily so non-body extracts don't pay.
    pub body: &'a [u8],
}

/// Apply each `Extract` against `facts`. On the first failure (missing JSON
/// path, missing header, etc.) return `Err` — the executor decides whether
/// that means the step is errored.
pub fn evaluate(
    extracts: &[Extract],
    facts: &ResponseFacts<'_>,
) -> Result<BTreeMap<String, String>> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    let mut body_json: Option<serde_json::Value> = None;

    for e in extracts {
        match e {
            Extract::Body { var, path } => {
                let json = match body_json.as_ref() {
                    Some(v) => v,
                    None => {
                        let v: serde_json::Value =
                            serde_json::from_slice(facts.body).map_err(|e| {
                                EngineError::ExtractFailed(format!("body not JSON: {e}"))
                            })?;
                        body_json = Some(v);
                        body_json.as_ref().unwrap()
                    }
                };
                let value = jsonpath_first(json, path)
                    .ok_or_else(|| EngineError::ExtractFailed(format!("no match: {path}")))?;
                out.insert(var.clone(), stringify(&value));
            }
            Extract::Header { var, name } => {
                let value = facts
                    .headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(name))
                    .map(|(_, v)| v.clone())
                    .ok_or_else(|| EngineError::ExtractFailed(format!("no header: {name}")))?;
                out.insert(var.clone(), value);
            }
            Extract::Cookie { var, name } => {
                let value = facts
                    .set_cookies
                    .iter()
                    .find_map(|sc| parse_cookie_value(sc, name))
                    .ok_or_else(|| EngineError::ExtractFailed(format!("no cookie: {name}")))?;
                out.insert(var.clone(), value);
            }
            Extract::Status { var } => {
                out.insert(var.clone(), facts.status.to_string());
            }
        }
    }
    Ok(out)
}

fn jsonpath_first(json: &serde_json::Value, path: &str) -> Option<serde_json::Value> {
    use serde_json_path::JsonPath;
    let p = JsonPath::parse(path).ok()?;
    p.query(json).first().cloned()
}

fn stringify(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn parse_cookie_value(set_cookie: &str, name: &str) -> Option<String> {
    // "JSESSIONID=abc; Path=/; HttpOnly" → if name == "JSESSIONID", return "abc"
    let first = set_cookie.split(';').next()?.trim();
    let (k, v) = first.split_once('=')?;
    if k.trim() == name {
        Some(v.trim().to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_facts(body: &str) -> ResponseFacts<'_> {
        ResponseFacts {
            status: 200,
            headers: &[],
            set_cookies: &[],
            body: body.as_bytes(),
        }
    }

    #[test]
    fn body_jsonpath_string() {
        let body = r#"{"access_token":"T0K3N"}"#;
        let facts = body_facts(body);
        let xs = vec![Extract::Body {
            var: "token".into(),
            path: "$.access_token".into(),
        }];
        let out = evaluate(&xs, &facts).unwrap();
        assert_eq!(out.get("token").map(String::as_str), Some("T0K3N"));
    }

    #[test]
    fn body_jsonpath_number_coerced() {
        let facts = body_facts(r#"{"id": 42}"#);
        let xs = vec![Extract::Body {
            var: "id".into(),
            path: "$.id".into(),
        }];
        let out = evaluate(&xs, &facts).unwrap();
        assert_eq!(out.get("id").map(String::as_str), Some("42"));
    }

    #[test]
    fn body_jsonpath_miss_is_error() {
        let facts = body_facts(r#"{}"#);
        let xs = vec![Extract::Body {
            var: "t".into(),
            path: "$.nope".into(),
        }];
        assert!(matches!(
            evaluate(&xs, &facts),
            Err(EngineError::ExtractFailed(_))
        ));
    }

    #[test]
    fn body_not_json_is_error() {
        let facts = body_facts("<html>");
        let xs = vec![Extract::Body {
            var: "t".into(),
            path: "$.a".into(),
        }];
        assert!(matches!(
            evaluate(&xs, &facts),
            Err(EngineError::ExtractFailed(_))
        ));
    }

    #[test]
    fn header_lookup_case_insensitive() {
        let headers = vec![("X-Trace".into(), "abc".into())];
        let facts = ResponseFacts {
            status: 200,
            headers: &headers,
            set_cookies: &[],
            body: b"",
        };
        let xs = vec![Extract::Header {
            var: "tr".into(),
            name: "x-trace".into(),
        }];
        let out = evaluate(&xs, &facts).unwrap();
        assert_eq!(out.get("tr").map(String::as_str), Some("abc"));
    }

    #[test]
    fn header_missing_is_error() {
        let facts = body_facts("");
        let xs = vec![Extract::Header {
            var: "x".into(),
            name: "X-None".into(),
        }];
        assert!(matches!(
            evaluate(&xs, &facts),
            Err(EngineError::ExtractFailed(_))
        ));
    }

    #[test]
    fn cookie_extracts_first_attr_pair() {
        let set_cookies = vec!["JSESSIONID=abc123; Path=/; HttpOnly".into()];
        let facts = ResponseFacts {
            status: 200,
            headers: &[],
            set_cookies: &set_cookies,
            body: b"",
        };
        let xs = vec![Extract::Cookie {
            var: "jsession".into(),
            name: "JSESSIONID".into(),
        }];
        let out = evaluate(&xs, &facts).unwrap();
        assert_eq!(out.get("jsession").map(String::as_str), Some("abc123"));
    }

    #[test]
    fn cookie_missing_is_error() {
        let facts = body_facts("");
        let xs = vec![Extract::Cookie {
            var: "x".into(),
            name: "None".into(),
        }];
        assert!(matches!(
            evaluate(&xs, &facts),
            Err(EngineError::ExtractFailed(_))
        ));
    }

    #[test]
    fn status_extract() {
        let facts = ResponseFacts {
            status: 503,
            headers: &[],
            set_cookies: &[],
            body: b"",
        };
        let xs = vec![Extract::Status { var: "code".into() }];
        let out = evaluate(&xs, &facts).unwrap();
        assert_eq!(out.get("code").map(String::as_str), Some("503"));
    }

    #[test]
    fn multiple_extracts_in_order() {
        let body = r#"{"a":"x","b":"y"}"#;
        let facts = body_facts(body);
        let xs = vec![
            Extract::Body {
                var: "first".into(),
                path: "$.a".into(),
            },
            Extract::Body {
                var: "second".into(),
                path: "$.b".into(),
            },
        ];
        let out = evaluate(&xs, &facts).unwrap();
        assert_eq!(out.get("first").map(String::as_str), Some("x"));
        assert_eq!(out.get("second").map(String::as_str), Some("y"));
    }
}
