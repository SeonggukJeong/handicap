//! Per-step response extraction: JSONPath into body, header lookup, cookie
//! lookup, status code → named flow variable. Result goes into the per-VU
//! per-iteration `iter_vars` map consumed by subsequent steps.

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};

use crate::error::{EngineError, Result};
use crate::scenario::{Decode, Extract};

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
            Extract::Body {
                var,
                path,
                decode,
                claim,
            } => {
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
                let v = post_process(var, stringify(&value), *decode, claim.as_deref())?;
                out.insert(var.clone(), v);
            }
            Extract::Header {
                var,
                name,
                decode,
                claim,
            } => {
                let value = facts
                    .headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(name))
                    .map(|(_, v)| v.clone())
                    .ok_or_else(|| EngineError::ExtractFailed(format!("no header: {name}")))?;
                let v = post_process(var, value, *decode, claim.as_deref())?;
                out.insert(var.clone(), v);
            }
            Extract::Cookie {
                var,
                name,
                decode,
                claim,
            } => {
                let value = facts
                    .set_cookies
                    .iter()
                    .find_map(|sc| parse_cookie_value(sc, name))
                    .ok_or_else(|| EngineError::ExtractFailed(format!("no cookie: {name}")))?;
                let v = post_process(var, value, *decode, claim.as_deref())?;
                out.insert(var.clone(), v);
            }
            Extract::Status { var } => {
                out.insert(var.clone(), facts.status.to_string());
            }
        }
    }
    Ok(out)
}

pub fn jsonpath_first(json: &serde_json::Value, path: &str) -> Option<serde_json::Value> {
    use serde_json_path::JsonPath;
    let p = JsonPath::parse(path).ok()?;
    p.query(json).first().cloned()
}

/// True when `path` parses as a JSONPath (RFC 9535).
pub fn jsonpath_is_valid(path: &str) -> bool {
    serde_json_path::JsonPath::parse(path).is_ok()
}

pub fn stringify(v: &serde_json::Value) -> String {
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

/// Why base64 text decoding failed. Data-less on purpose: base64's
/// `DecodeError` Display echoes input bytes, so no library error may ride
/// into the (user-visible) extract failure message — spec §3.3 / R6.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Base64TextError {
    NotBase64,
    NotUtf8,
}

/// The value is not a 3-segment compact JWT. Data-less (see above).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct JwtShapeError;

/// R3: trim, drop trailing `=`, pick the alphabet by its distinguishing
/// characters (`-`/`_` url-safe, `+`/`/` standard, neither → standard), decode
/// unpadded, require UTF-8.
fn decode_base64_text(s: &str) -> std::result::Result<String, Base64TextError> {
    let t = s.trim().trim_end_matches('=');
    let url_safe = t.contains(['-', '_']);
    let standard = t.contains(['+', '/']);
    let bytes = match (url_safe, standard) {
        (true, true) => return Err(Base64TextError::NotBase64),
        (true, false) => URL_SAFE_NO_PAD.decode(t),
        _ => STANDARD_NO_PAD.decode(t),
    }
    .map_err(|_| Base64TextError::NotBase64)?;
    String::from_utf8(bytes).map_err(|_| Base64TextError::NotUtf8)
}

/// R4: strip a case-insensitive `Bearer ` prefix (and extra spaces), then
/// require exactly three `.`-separated segments; return the payload segment.
fn jwt_payload(s: &str) -> std::result::Result<&str, JwtShapeError> {
    let t = s.trim();
    let t = match t.get(..7) {
        Some(p) if p.eq_ignore_ascii_case("bearer ") => t[7..].trim_start(),
        _ => t,
    };
    let mut parts = t.split('.');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(_), Some(payload), Some(_), None) => Ok(payload),
        _ => Err(JwtShapeError),
    }
}

/// Optional decode + claim on an already-extracted raw value (spec §4.3).
/// Check order is fixed so multi-fault inputs report deterministically:
/// claim⇒decode → jwt shape → base64 → UTF-8 → JSON → claim parse → query.
/// Messages are `"{var}: <fixed reason>"` — never the value, never a library
/// error's Display (R6).
fn post_process(
    var: &str,
    raw: String,
    decode: Option<Decode>,
    claim: Option<&str>,
) -> Result<String> {
    let fail = |reason: &str| EngineError::ExtractFailed(format!("{var}: {reason}"));
    let Some(decode) = decode else {
        return match claim {
            Some(_) => Err(fail("claim requires decode")),
            None => Ok(raw),
        };
    };
    let segment = match decode {
        Decode::Base64 => raw.as_str(),
        Decode::Jwt => jwt_payload(&raw).map_err(|_| fail("not a JWT (expected 3 segments)"))?,
    };
    let text = decode_base64_text(segment).map_err(|e| match e {
        Base64TextError::NotBase64 => fail("not base64"),
        Base64TextError::NotUtf8 => fail("not UTF-8 text"),
    })?;
    if decode == Decode::Base64 && claim.is_none() {
        return Ok(text);
    }
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| fail("decoded value is not JSON"))?;
    let Some(claim) = claim else {
        return Ok(text); // jwt without claim → payload JSON text verbatim (R5)
    };
    let path = serde_json_path::JsonPath::parse(claim)
        .map_err(|_| fail(&format!("invalid claim path: {claim}")))?;
    let first = path
        .query(&json)
        .first()
        .cloned()
        .ok_or_else(|| fail(&format!("claim not found: {claim}")))?;
    Ok(stringify(&first))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::Decode;
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};

    #[test]
    fn jsonpath_is_valid_accepts_and_rejects() {
        for ok in ["$.a", "$['a b'][0]", "$"] {
            assert!(jsonpath_is_valid(ok), "{ok}");
        }
        for bad in ["a.b", "$.[", ""] {
            assert!(!jsonpath_is_valid(bad), "{bad}");
        }
    }

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
            decode: None,
            claim: None,
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
            decode: None,
            claim: None,
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
            decode: None,
            claim: None,
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
            decode: None,
            claim: None,
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
            decode: None,
            claim: None,
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
            decode: None,
            claim: None,
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
            decode: None,
            claim: None,
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
            decode: None,
            claim: None,
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
                decode: None,
                claim: None,
                var: "first".into(),
                path: "$.a".into(),
            },
            Extract::Body {
                decode: None,
                claim: None,
                var: "second".into(),
                path: "$.b".into(),
            },
        ];
        let out = evaluate(&xs, &facts).unwrap();
        assert_eq!(out.get("first").map(String::as_str), Some("x"));
        assert_eq!(out.get("second").map(String::as_str), Some("y"));
    }

    fn header_facts<'a>(headers: &'a [(String, String)]) -> ResponseFacts<'a> {
        ResponseFacts {
            status: 200,
            headers,
            set_cookies: &[],
            body: b"",
        }
    }

    fn hdr(var: &str, decode: Decode, claim: Option<&str>) -> Extract {
        Extract::Header {
            var: var.into(),
            name: "X-V".into(),
            decode: Some(decode),
            claim: claim.map(Into::into),
        }
    }

    fn eval_header(value: &str, x: Extract) -> Result<BTreeMap<String, String>> {
        let headers = vec![("X-V".to_string(), value.to_string())];
        evaluate(&[x], &header_facts(&headers))
    }

    fn err_msg(r: Result<BTreeMap<String, String>>) -> String {
        match r {
            Err(EngineError::ExtractFailed(m)) => m,
            other => panic!("expected ExtractFailed, got {other:?}"),
        }
    }

    /// R6: strip author text (`{var}: ` prefix + echoed claim) then require
    /// no 4-char window of any secret to remain. Fixtures are chosen so no
    /// secret shares a 4-char run with the fixed reason literals.
    fn assert_no_leak(msg: &str, var: &str, claim: Option<&str>, secrets: &[&str]) {
        let mut rest = msg
            .strip_prefix(&format!("{var}: "))
            .unwrap_or_else(|| panic!("missing var prefix: {msg:?}"))
            .to_string();
        if let Some(c) = claim {
            rest = rest.replace(c, "");
        }
        for s in secrets {
            let chars: Vec<char> = s.chars().collect();
            for w in chars.windows(4) {
                let sub: String = w.iter().collect();
                assert!(!rest.contains(&sub), "leaked {sub:?} in {msg:?}");
            }
        }
    }

    fn jwt_with(payload_json: &str) -> String {
        format!(
            "eyJhbGciOiJub25lIn0.{}.c2ln",
            URL_SAFE_NO_PAD.encode(payload_json)
        )
    }

    #[test]
    fn decode_base64_text_four_variants_same_text() {
        let original = "hello?>~"; // bytes that make '/' (standard) vs '_' (url-safe)
        let variants = [
            STANDARD.encode(original),
            STANDARD_NO_PAD.encode(original),
            URL_SAFE.encode(original),
            URL_SAFE_NO_PAD.encode(original),
        ];
        assert!(variants[0].contains('/') && variants[2].contains('_'));
        for v in variants {
            let out = eval_header(&v, hdr("t", Decode::Base64, None)).unwrap();
            assert_eq!(
                out.get("t").map(String::as_str),
                Some(original),
                "variant {v}"
            );
        }
    }

    #[test]
    fn decode_base64_edge_pins() {
        // over-padding is tolerated by trim_end_matches('=')
        let out = eval_header("QQ=====", hdr("t", Decode::Base64, None)).unwrap();
        assert_eq!(out.get("t").map(String::as_str), Some("A"));
        // non-canonical trailing bits rejected by base64 0.22 defaults
        let m = err_msg(eval_header("AAAAQR", hdr("t", Decode::Base64, None)));
        assert_eq!(m, "t: not base64");
    }

    #[test]
    fn decode_base64_failures_are_value_free() {
        for (input, reason) in [
            ("ab+c-d__", "not base64"), // mixed alphabets
            ("!!!!", "not base64"),
            ("/w==", "not UTF-8 text"), // 0xFF
        ] {
            let m = err_msg(eval_header(input, hdr("blob", Decode::Base64, None)));
            assert_no_leak(&m, "blob", None, &[input]);
            assert_eq!(m, format!("blob: {reason}"), "input {input}");
        }
    }

    #[test]
    fn jwt_bearer_prefix_variants() {
        let jwt = jwt_with(r#"{"sub":"u-9f3k"}"#);
        for v in [
            jwt.clone(),
            format!("Bearer {jwt}"),
            format!("bearer {jwt}"),
            format!("BEARER  {jwt}"),
        ] {
            let out = eval_header(&v, hdr("uid", Decode::Jwt, Some("$.sub"))).unwrap();
            assert_eq!(out.get("uid").map(String::as_str), Some("u-9f3k"), "{v}");
        }
    }

    #[test]
    fn jwt_without_claim_yields_payload_text_verbatim() {
        let payload = r#"{"sub":"u-9f3k","n":42}"#;
        let out = eval_header(&jwt_with(payload), hdr("p", Decode::Jwt, None)).unwrap();
        assert_eq!(out.get("p").map(String::as_str), Some(payload));
    }

    #[test]
    fn jwt_shape_and_json_failures_are_value_free() {
        for input in ["aaaa.bbbb", "aaaa.bbbb.cccc.dddd"] {
            let m = err_msg(eval_header(input, hdr("uid", Decode::Jwt, None)));
            assert_no_leak(&m, "uid", None, &[input]);
            assert_eq!(m, "uid: not a JWT (expected 3 segments)");
        }
        let token = format!("eyJh.{}.c2ln", URL_SAFE_NO_PAD.encode("plain text"));
        let m = err_msg(eval_header(&token, hdr("uid", Decode::Jwt, None)));
        assert_no_leak(&m, "uid", None, &[&token, "plain text"]);
        assert_eq!(m, "uid: decoded value is not JSON");
    }

    #[test]
    fn claim_stringifies_like_body_extract() {
        let jwt = jwt_with(r#"{"sub":"u-9f3k","n":42,"o":{"k":"zz"}}"#);
        let cases = [("$.sub", "u-9f3k"), ("$.n", "42"), ("$.o", r#"{"k":"zz"}"#)];
        for (claim, want) in cases {
            let out = eval_header(&jwt, hdr("v", Decode::Jwt, Some(claim))).unwrap();
            assert_eq!(out.get("v").map(String::as_str), Some(want), "{claim}");
        }
    }

    #[test]
    fn claim_failures_are_value_free() {
        let payload = r#"{"sub":"u-9f3k"}"#;
        let jwt = jwt_with(payload);
        let m = err_msg(eval_header(&jwt, hdr("uid", Decode::Jwt, Some("$["))));
        assert_no_leak(&m, "uid", Some("$["), &[&jwt, payload]);
        assert_eq!(m, "uid: invalid claim path: $[");

        let m = err_msg(eval_header(&jwt, hdr("uid", Decode::Jwt, Some("$.nope"))));
        assert_no_leak(&m, "uid", Some("$.nope"), &[&jwt, payload]);
        assert_eq!(m, "uid: claim not found: $.nope");

        // base64 + claim on non-JSON decoded text
        let blob = STANDARD.encode("plain text");
        let m = err_msg(eval_header(&blob, hdr("b", Decode::Base64, Some("$.k"))));
        assert_no_leak(&m, "b", Some("$.k"), &[&blob, "plain text"]);
        assert_eq!(m, "b: decoded value is not JSON");

        // Order pin (spec §4.3): JSON parse (⑤) precedes claim-path parse (⑥) —
        // non-JSON decoded text + invalid claim path must report the JSON reason.
        let m = err_msg(eval_header(&blob, hdr("b", Decode::Base64, Some("$["))));
        assert_no_leak(&m, "b", Some("$["), &[&blob, "plain text"]);
        assert_eq!(m, "b: decoded value is not JSON");
    }

    #[test]
    fn claim_without_decode_is_rejected_at_eval() {
        let headers = vec![("X-V".to_string(), "zq9Xw8".to_string())];
        let x = Extract::Header {
            var: "h".into(),
            name: "X-V".into(),
            decode: None,
            claim: Some("$.k".into()),
        };
        let m = err_msg(evaluate(&[x], &header_facts(&headers)));
        assert_no_leak(&m, "h", Some("$.k"), &["zq9Xw8"]);
        assert_eq!(m, "h: claim requires decode");
    }

    #[test]
    fn cookie_and_body_paths_decode_too() {
        let set_cookies = vec![format!("SID={}; Path=/", STANDARD.encode("tok:42"))];
        let facts = ResponseFacts {
            status: 200,
            headers: &[],
            set_cookies: &set_cookies,
            body: b"",
        };
        let x = Extract::Cookie {
            var: "sid".into(),
            name: "SID".into(),
            decode: Some(Decode::Base64),
            claim: None,
        };
        let out = evaluate(&[x], &facts).unwrap();
        assert_eq!(out.get("sid").map(String::as_str), Some("tok:42"));

        let body = format!(
            r#"{{"access_token":"{}"}}"#,
            jwt_with(r#"{"sub":"u-9f3k"}"#)
        );
        let x = Extract::Body {
            var: "uid".into(),
            path: "$.access_token".into(),
            decode: Some(Decode::Jwt),
            claim: Some("$.sub".into()),
        };
        let out = evaluate(&[x], &body_facts(&body)).unwrap();
        assert_eq!(out.get("uid").map(String::as_str), Some("u-9f3k"));
    }

    #[test]
    fn raw_extract_failure_precedes_decode_and_keeps_old_text() {
        // Fixed pin (passes before the feature too). R7 + order: missing header fails before any decode step, old wording.
        let x = Extract::Header {
            var: "x".into(),
            name: "X-None".into(),
            decode: Some(Decode::Jwt),
            claim: Some("$.sub".into()),
        };
        let m = err_msg(evaluate(&[x], &body_facts("")));
        assert_eq!(m, "no header: X-None");
    }
}
