//! Per-step response extraction: JSONPath into body, header lookup, cookie
//! lookup, status code → named flow variable. Result goes into the per-VU
//! per-iteration `iter_vars` map consumed by subsequent steps.

use std::collections::BTreeMap;
use std::iter::Peekable;
use std::str::Chars;

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};

use crate::error::{EngineError, Result};
use crate::json_unwrap::{unwrap_json_str, unwrap_nested};
use crate::scenario::{Decode, Extract, HttpStep};

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
    let body_json = BodyCache::default();
    for e in extracts {
        let v = strict_item(e, facts, &body_json)?;
        out.insert(e.var().to_string(), v);
    }
    Ok(out)
}

/// 본문 JSON 읽기 결과(평가 한 번에 한 번만, Body 항목들이 공유). 찾기는 세 단계다 —
/// 원래 본문 → 뿌리가 감싼 문자열이면 푼 값 → 안쪽 필드까지 푼 값. 앞 단계에서 찾으면(`null` 포함) 멈춘다.
#[derive(Default)]
struct BodyCache {
    /// 오류는 최종 `body not JSON: …` 글자.
    parsed: std::cell::OnceCell<std::result::Result<serde_json::Value, String>>,
    /// 뿌리가 문자열이고 객체·배열로 풀릴 때만 Some (2단계).
    root: std::cell::OnceCell<Option<serde_json::Value>>,
    /// 안쪽 필드까지 푼 값 — 풀린 곳이 없으면 None (3단계).
    nested: std::cell::OnceCell<Option<serde_json::Value>>,
}

/// `Err` = `body not JSON: …`, `Ok(None)` = 못 찾음.
fn body_path_first(
    cache: &BodyCache,
    facts: &ResponseFacts<'_>,
    path: &str,
) -> std::result::Result<Option<serde_json::Value>, String> {
    use serde_json_path::JsonPath;
    let parsed = cache
        .parsed
        .get_or_init(|| {
            serde_json::from_slice(facts.body).map_err(|e| format!("body not JSON: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)?;
    let Ok(p) = JsonPath::parse(path) else {
        return Ok(None);
    };
    if let Some(v) = p.query(parsed).first() {
        return Ok(Some((*v).clone()));
    }
    let base = if let serde_json::Value::String(s) = parsed {
        // 뿌리 문자열이 안 풀리면 3단계도 없다(뿌리 문자열을 다시 파싱하지 않는다).
        let Some(root) = cache.root.get_or_init(|| unwrap_json_str(s)) else {
            return Ok(None);
        };
        if let Some(v) = p.query(root).first() {
            return Ok(Some((*v).clone()));
        }
        root
    } else {
        parsed
    };
    Ok(cache
        .nested
        .get_or_init(|| unwrap_nested(base))
        .as_ref()
        .and_then(|n| p.query(n).first().map(|v| (*v).clone())))
}

/// One item under the strict rules (body JSON parsed once, lazily).
fn strict_item(e: &Extract, facts: &ResponseFacts<'_>, body_json: &BodyCache) -> Result<String> {
    match e {
        Extract::Body {
            var,
            path,
            decode,
            claim,
            ..
        } => {
            let value = body_path_first(body_json, facts, path)
                .map_err(EngineError::ExtractFailed)?
                .ok_or_else(|| EngineError::ExtractFailed(format!("no match: {path}")))?;
            post_process(var, stringify(&value), *decode, claim.as_deref())
        }
        Extract::Header {
            var,
            name,
            decode,
            claim,
            ..
        } => {
            let value = facts
                .headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())
                .ok_or_else(|| EngineError::ExtractFailed(format!("no header: {name}")))?;
            post_process(var, value, *decode, claim.as_deref())
        }
        Extract::Cookie {
            var,
            name,
            decode,
            claim,
            ..
        } => {
            let value = facts
                .set_cookies
                .iter()
                .find_map(|sc| parse_cookie_value(sc, name))
                .ok_or_else(|| EngineError::ExtractFailed(format!("no cookie: {name}")))?;
            post_process(var, value, *decode, claim.as_deref())
        }
        Extract::Status { .. } => Ok(facts.status.to_string()),
    }
}

/// Lenient sibling of [`evaluate`]: each item is evaluated on its own; found
/// values are kept and failed items (missing path/header/cookie, non-JSON body,
/// a body path or decoded claim that finds JSON `null`, decode/claim failure)
/// are simply absent.
/// Never errors.
pub fn evaluate_lenient(
    extracts: &[Extract],
    facts: &ResponseFacts<'_>,
) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    // Body JSON parse outcome, computed once and shared by every Body item.
    let body_json = BodyCache::default();
    for e in extracts {
        if let Some(v) = lenient_item(e, facts, &body_json) {
            out.insert(e.var().to_string(), v);
        }
    }
    out
}

/// One item under the lenient rules; `None` = "could not extract".
fn lenient_item(e: &Extract, facts: &ResponseFacts<'_>, body_json: &BodyCache) -> Option<String> {
    match e {
        Extract::Body {
            var,
            path,
            decode,
            claim,
            ..
        } => {
            // JSON `null`은 "응답에 없는 값"으로 본다 — 빠뜨려서 비움 표에 오르게 한다
            // (blank-var-url-guard F1; 엄격 모드는 여전히 `""`로 뽑는다).
            let value = body_path_first(body_json, facts, path)
                .ok()
                .flatten()
                .filter(|v| !v.is_null())?;
            post_process_lenient(var, stringify(&value), *decode, claim.as_deref())
        }
        Extract::Header {
            var,
            name,
            decode,
            claim,
            ..
        } => {
            let value = facts
                .headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())?;
            post_process_lenient(var, value, *decode, claim.as_deref())
        }
        Extract::Cookie {
            var,
            name,
            decode,
            claim,
            ..
        } => {
            let value = facts
                .set_cookies
                .iter()
                .find_map(|sc| parse_cookie_value(sc, name))?;
            post_process_lenient(var, value, *decode, claim.as_deref())
        }
        Extract::Status { .. } => Some(facts.status.to_string()),
    }
}

/// Result of [`evaluate_with_defaults`].
#[derive(Debug)]
pub struct StrictOutcome {
    pub extracted: BTreeMap<String, String>,
    pub error: Option<EngineError>,
}

/// Strict evaluation where items with a `default` are lenient (a failure just
/// skips them so [`fill_missing_extracts`] can supply the default). Every item
/// is evaluated in declaration order. Items without a `default` follow
/// [`evaluate`]'s rules and messages; the first such failure becomes `error`.
/// On error `extracted` keeps only values from `default` items.
pub fn evaluate_with_defaults(extracts: &[Extract], facts: &ResponseFacts<'_>) -> StrictOutcome {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    let mut from_default_items: BTreeMap<String, String> = BTreeMap::new();
    let mut error: Option<EngineError> = None;
    let body_json = BodyCache::default();
    for e in extracts {
        if e.default_value().is_some() {
            if let Some(v) = lenient_item(e, facts, &body_json) {
                from_default_items.insert(e.var().to_string(), v.clone());
                out.insert(e.var().to_string(), v);
            }
            continue;
        }
        match strict_item(e, facts, &body_json) {
            Ok(v) => {
                out.insert(e.var().to_string(), v);
            }
            Err(err) => {
                if error.is_none() {
                    error = Some(err);
                }
            }
        }
    }
    StrictOutcome {
        extracted: if error.is_some() {
            from_default_items
        } else {
            out
        },
        error,
    }
}

/// True when any item declares a `default`.
pub fn has_default(extracts: &[Extract]) -> bool {
    extracts.iter().any(|e| e.default_value().is_some())
}

/// Names filled by [`fill_missing_extracts`].
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Filled {
    pub blanked: Vec<String>,
    pub defaulted: Vec<String>,
}

/// Declared names absent from `extracted` get their `default` (the last item
/// of that name that has one) in both `extracted` and `iter_vars`; otherwise,
/// when `blank`, `""`. Duplicate names are handled once, in first-seen order.
pub fn fill_missing_extracts(
    step: &HttpStep,
    extracted: &mut BTreeMap<String, String>,
    iter_vars: &mut BTreeMap<String, String>,
    blank: bool,
) -> Filled {
    let any_default = has_default(&step.extract);
    if !blank && !any_default {
        return Filled::default();
    }
    let mut filled = Filled::default();
    if !any_default {
        // 기본값 항목이 없다: 못 뽑은 이름만 비운다(실제로 비울 때만 할당).
        for e in &step.extract {
            let var = e.var();
            if !extracted.contains_key(var) {
                extracted.insert(var.to_string(), String::new());
                iter_vars.insert(var.to_string(), String::new());
                filled.blanked.push(var.to_string());
            }
        }
        return filled;
    }
    // 이름별 "기본값 있는 마지막 항목"을 한 번에 모은다(뒤 항목이 덮어쓴다).
    let mut defaults: BTreeMap<&str, &str> = BTreeMap::new();
    for e in &step.extract {
        if let Some(d) = e.default_value() {
            defaults.insert(e.var(), d);
        }
    }
    // 첫 항목에서 채운 이름은 extracted에 들어가므로 같은 이름의 뒤 항목은 건너뛴다.
    for e in &step.extract {
        let var = e.var();
        if extracted.contains_key(var) {
            continue;
        }
        if let Some(d) = defaults.get(var) {
            extracted.insert(var.to_string(), (*d).to_string());
            iter_vars.insert(var.to_string(), (*d).to_string());
            filled.defaulted.push(var.to_string());
        } else if blank {
            extracted.insert(var.to_string(), String::new());
            iter_vars.insert(var.to_string(), String::new());
            filled.blanked.push(var.to_string());
        }
    }
    filled
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

/// True when `path` is in the small JSONPath subset that is safe to evaluate
/// repeatedly and unattended. The grammar admits no whitespace:
///
/// ```text
/// path    := '$' segment*            (at most one '..' in the whole path)
/// segment := '.' name | '.*' | '[' bracket ']' | '..' (name | '*' | '[' bracket ']')
/// bracket := quoted | '-'? digit+ | '*'
/// quoted  := one '…' or "…" string, backslash escapes (no selector lists)
/// name    := (ALPHA | '_' | >= U+0080) (ALPHA | '_' | DIGIT | >= U+0080)*
/// ```
///
/// This is an allowlist, not a blacklist. `serde_json_path` evaluates a query without
/// caching or deduplication: a filter re-runs per tested node (root re-queries,
/// `match()`/`search()` regex compiles), a selector list such as `[0,0]` duplicates
/// every node it selects (2^k refs after k segments), and chained `..` repeat
/// overlapping subtrees. Three blacklist rounds were each bypassed by another of
/// these. In the subset, every segment maps distinct nodes to distinct nodes (one
/// `..` starts from same-depth, disjoint subtrees), so cost is O(n × segments) on a
/// body of n nodes (≤1 MiB). It covers every path the UI click flow `segmentsToPath`
/// (`ui/src/scenario/jsonPath.ts`) emits, plus wildcards and one `..`. It is lexical
/// only: callers still require [`jsonpath_is_valid`] (e.g. for escape validity).
pub fn jsonpath_is_simple(path: &str) -> bool {
    let mut it = path.chars().peekable();
    if it.next() != Some('$') {
        return false;
    }
    let mut descended = false;
    while let Some(c) = it.next() {
        let ok = match c {
            '.' if it.peek() == Some(&'.') => {
                it.next();
                if descended {
                    return false;
                }
                descended = true;
                match it.next() {
                    Some('*') => true,
                    Some('[') => simple_bracket(&mut it),
                    Some(c) => simple_name(c, &mut it),
                    None => false,
                }
            }
            '.' => match it.next() {
                Some('*') => true,
                Some(c) => simple_name(c, &mut it),
                None => false,
            },
            '[' => simple_bracket(&mut it),
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    true
}

fn is_name_first(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || c >= '\u{80}'
}

/// Member-name shorthand starting with `first`; consumes the rest of the name.
fn simple_name(first: char, it: &mut Peekable<Chars<'_>>) -> bool {
    if !is_name_first(first) {
        return false;
    }
    while it
        .peek()
        .is_some_and(|&c| is_name_first(c) || c.is_ascii_digit())
    {
        it.next();
    }
    true
}

/// Bracket body after `[` through the closing `]`: one quoted name, one integer
/// index, or `*`.
fn simple_bracket(it: &mut Peekable<Chars<'_>>) -> bool {
    match it.next() {
        Some('*') => {}
        Some(q @ ('\'' | '"')) => loop {
            match it.next() {
                Some('\\') => {
                    if it.next().is_none() {
                        return false;
                    }
                }
                Some(c) if c == q => break,
                Some(_) => {}
                None => return false,
            }
        },
        Some(c) if c == '-' || c.is_ascii_digit() => {
            let mut digits = usize::from(c != '-');
            while it.peek().is_some_and(char::is_ascii_digit) {
                it.next();
                digits += 1;
            }
            if digits == 0 {
                return false;
            }
        }
        _ => return false,
    }
    it.next() == Some(']')
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
    Ok(match post_process_value(var, raw, decode, claim)? {
        Processed::Text(s) => s,
        Processed::Claim(v) => stringify(&v),
    })
}

/// 너그러운 쪽: 실패와 JSON `null` claim은 "못 뽑음"(`None`) — 본문 경로의 null 규칙과 같다
/// (blank-var-url-guard G6). 엄격 [`post_process`]는 null claim을 `""`로 뽑는다.
fn post_process_lenient(
    var: &str,
    raw: String,
    decode: Option<Decode>,
    claim: Option<&str>,
) -> Option<String> {
    match post_process_value(var, raw, decode, claim).ok()? {
        Processed::Text(s) => Some(s),
        Processed::Claim(v) if v.is_null() => None,
        Processed::Claim(v) => Some(stringify(&v)),
    }
}

enum Processed {
    Text(String),
    Claim(serde_json::Value),
}

fn post_process_value(
    var: &str,
    raw: String,
    decode: Option<Decode>,
    claim: Option<&str>,
) -> Result<Processed> {
    let fail = |reason: &str| EngineError::ExtractFailed(format!("{var}: {reason}"));
    let Some(decode) = decode else {
        return match claim {
            Some(_) => Err(fail("claim requires decode")),
            None => Ok(Processed::Text(raw)),
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
        return Ok(Processed::Text(text));
    }
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| fail("decoded value is not JSON"))?;
    let Some(claim) = claim else {
        return Ok(Processed::Text(text)); // jwt without claim → payload JSON text verbatim (R5)
    };
    let path = serde_json_path::JsonPath::parse(claim)
        .map_err(|_| fail(&format!("invalid claim path: {claim}")))?;
    let first = path
        .query(&json)
        .first()
        .cloned()
        .ok_or_else(|| fail(&format!("claim not found: {claim}")))?;
    Ok(Processed::Claim(first))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::Decode;

    #[test]
    fn found_path_does_no_unwrap_work() {
        let body = br#"{"data":"{\"id\":7}","plain":1}"#;
        let facts = lenient_facts(body, &[]);
        let cache = BodyCache::default();
        let v = body_path_first(&cache, &facts, "$.plain").unwrap();
        assert_eq!(v, Some(serde_json::json!(1)));
        assert!(cache.root.get().is_none() && cache.nested.get().is_none());
    }

    fn lenient_facts<'a>(body: &'a [u8], headers: &'a [(String, String)]) -> ResponseFacts<'a> {
        ResponseFacts {
            status: 200,
            headers,
            set_cookies: &[],
            body,
        }
    }

    fn body_extract(var: &str, path: &str) -> Extract {
        Extract::Body {
            var: var.into(),
            path: path.into(),
            decode: None,
            claim: None,
            default: None,
        }
    }

    #[test]
    fn lenient_keeps_found_and_drops_missing() {
        let extracts = vec![
            body_extract("code", "$.code"),
            body_extract("orderId", "$.orderId"),
        ];
        let facts = lenient_facts(br#"{"code":"WAIT"}"#, &[]);
        let out = evaluate_lenient(&extracts, &facts);
        assert_eq!(out.len(), 1);
        assert_eq!(out.get("code").map(String::as_str), Some("WAIT"));
    }

    #[test]
    fn lenient_non_json_body_drops_body_items_keeps_header() {
        let extracts = vec![
            body_extract("code", "$.code"),
            Extract::Header {
                var: "rid".into(),
                name: "X-Rid".into(),
                decode: None,
                claim: None,
                default: None,
            },
        ];
        let headers = vec![("x-rid".to_string(), "R1".to_string())];
        let facts = lenient_facts(b"not json", &headers);
        let out = evaluate_lenient(&extracts, &facts);
        assert_eq!(out.len(), 1);
        assert_eq!(out.get("rid").map(String::as_str), Some("R1"));
    }

    #[test]
    fn lenient_decode_failure_drops_item() {
        let extracts = vec![
            Extract::Body {
                var: "t".into(),
                path: "$.t".into(),
                decode: Some(Decode::Jwt),
                claim: Some("sub".into()),
                default: None,
            },
            body_extract("code", "$.code"),
        ];
        let facts = lenient_facts(br#"{"t":"not-a-jwt","code":"OK"}"#, &[]);
        let out = evaluate_lenient(&extracts, &facts);
        assert!(!out.contains_key("t"));
        assert_eq!(out.get("code").map(String::as_str), Some("OK"));
    }

    #[test]
    fn lenient_json_null_is_not_extracted() {
        let extracts = vec![body_extract("orderId", "$.orderId")];
        let facts = lenient_facts(br#"{"orderId":null}"#, &[]);
        let out = evaluate_lenient(&extracts, &facts);
        assert!(!out.contains_key("orderId"), "{out:?}");
    }

    #[test]
    fn lenient_real_empty_string_is_extracted() {
        let extracts = vec![body_extract("orderId", "$.orderId")];
        let facts = lenient_facts(br#"{"orderId":""}"#, &[]);
        let out = evaluate_lenient(&extracts, &facts);
        assert_eq!(out.get("orderId").map(String::as_str), Some(""));
    }

    #[test]
    fn strict_json_null_still_extracts_empty() {
        let extracts = vec![body_extract("orderId", "$.orderId")];
        let facts = lenient_facts(br#"{"orderId":null}"#, &[]);
        let out = evaluate(&extracts, &facts).expect("strict null is a match");
        assert_eq!(out.get("orderId").map(String::as_str), Some(""));
    }

    /// JWT 페이로드 `{"sub":null,"name":""}` — base64url(no pad).
    fn null_claim_jwt() -> String {
        format!(
            "eyJhbGciOiJub25lIn0.{}.c2ln",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"sub":null,"name":""}"#)
        )
    }

    /// body·header·cookie 세 출처에서 같은 JWT를 같은 claim으로 뽑는다.
    fn claim_extracts(claim: &str) -> Vec<Extract> {
        vec![
            Extract::Body {
                var: "b".into(),
                path: "$.t".into(),
                decode: Some(Decode::Jwt),
                claim: Some(claim.into()),
                default: None,
            },
            Extract::Header {
                var: "h".into(),
                name: "X-T".into(),
                decode: Some(Decode::Jwt),
                claim: Some(claim.into()),
                default: None,
            },
            Extract::Cookie {
                var: "c".into(),
                name: "t".into(),
                decode: Some(Decode::Jwt),
                claim: Some(claim.into()),
                default: None,
            },
        ]
    }

    fn eval_claims(
        claim: &str,
        lenient: bool,
    ) -> std::result::Result<BTreeMap<String, String>, String> {
        let jwt = null_claim_jwt();
        let body = format!(r#"{{"t":"{jwt}"}}"#);
        let headers = vec![("X-T".to_string(), jwt.clone())];
        let cookies = vec![format!("t={jwt}; Path=/")];
        let facts = ResponseFacts {
            status: 200,
            headers: &headers,
            set_cookies: &cookies,
            body: body.as_bytes(),
        };
        let extracts = claim_extracts(claim);
        if lenient {
            Ok(evaluate_lenient(&extracts, &facts))
        } else {
            evaluate(&extracts, &facts).map_err(|e| format!("{e:?}"))
        }
    }

    #[test]
    fn lenient_null_claim_is_not_extracted() {
        let out = eval_claims("$.sub", true).unwrap();
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn strict_null_claim_still_extracts_empty() {
        let out = eval_claims("$.sub", false).unwrap();
        for v in ["b", "h", "c"] {
            assert_eq!(out.get(v).map(String::as_str), Some(""), "{v}: {out:?}");
        }
    }

    #[test]
    fn lenient_real_empty_claim_is_extracted() {
        let out = eval_claims("$.name", true).unwrap();
        for v in ["b", "h", "c"] {
            assert_eq!(out.get(v).map(String::as_str), Some(""), "{v}: {out:?}");
        }
    }

    #[test]
    fn strict_evaluate_unchanged() {
        let extracts = vec![
            body_extract("code", "$.code"),
            body_extract("orderId", "$.orderId"),
        ];
        let facts = lenient_facts(br#"{"code":"WAIT"}"#, &[]);
        assert!(evaluate(&extracts, &facts).is_err());
    }

    #[test]
    fn blank_missing_fills_only_declared_and_missing() {
        use crate::scenario::{DisabledRows, HttpMethod, HttpStep, Request};
        let step = HttpStep {
            id: "01HX0000000000000000000001".into(),
            name: "s".into(),
            request: Request {
                method: HttpMethod::Get,
                url: "http://x".into(),
                headers: BTreeMap::new(),
                body: None,
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![
                body_extract("code", "$.code"),
                body_extract("orderId", "$.orderId"),
            ],
            timeout_seconds: None,
            think_time: None,
        };
        let mut extracted = BTreeMap::from([("code".to_string(), "WAIT".to_string())]);
        let mut iter_vars = BTreeMap::from([
            ("orderId".to_string(), "old".to_string()),
            ("other".to_string(), "x".to_string()),
        ]);
        let blanked = fill_missing_extracts(&step, &mut extracted, &mut iter_vars, true).blanked;
        assert_eq!(blanked, vec!["orderId".to_string()]);
        assert_eq!(iter_vars.get("orderId").map(String::as_str), Some(""));
        assert_eq!(iter_vars.get("other").map(String::as_str), Some("x"));
        assert_eq!(extracted.get("orderId").map(String::as_str), Some(""));
        assert_eq!(extracted.get("code").map(String::as_str), Some("WAIT"));
    }
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};

    #[test]
    fn escaped_bidi_quoted_name_selects_raw_key() {
        for (esc, ch) in [
            ("202e", '\u{202E}'),
            ("2028", '\u{2028}'),
            ("0085", '\u{85}'),
            ("2066", '\u{2066}'),
        ] {
            let path = format!("$['a\\u{esc}b']");
            assert!(jsonpath_is_valid(&path), "{path} must parse");
            assert!(jsonpath_is_simple(&path), "{path} must be simple");
            let key = format!("a{ch}b");
            let mut m = serde_json::Map::new();
            m.insert(key, serde_json::json!(7));
            let body = serde_json::Value::Object(m);
            assert_eq!(
                jsonpath_first(&body, &path),
                Some(serde_json::json!(7)),
                "{path}"
            );
        }
    }

    #[test]
    fn jsonpath_is_valid_accepts_and_rejects() {
        for ok in ["$.a", "$['a b'][0]", "$"] {
            assert!(jsonpath_is_valid(ok), "{ok}");
        }
        for bad in ["a.b", "$.[", ""] {
            assert!(!jsonpath_is_valid(bad), "{bad}");
        }
    }

    #[test]
    fn jsonpath_is_simple_allowlist() {
        for path in [
            "$",
            "$.a",
            "$.a.b[0]",
            "$['a b'][0]",
            "$[\"x\\\"y\"]",
            "$.data.items[-1].code",
            "$.*",
            "$[*]",
            "$..a",
            "$..*",
            "$..['k']",
            "$..[0]",
            "$.가나",
            "$['a?$b']",
            "$['a,b']",
            // Every shape the UI click flow `segmentsToPath` (ui/src/scenario/jsonPath.ts)
            // emits: `$`, `.ident`, `[index]`, and `['…']` with `\\`/`\'`/`\uXXXX` escapes.
            "$.data.token",
            "$.items[0].sku",
            "$['weird.key']",
            "$['has space']",
            "$['it\\'s']",
            "$['a\\\\b']",
            "$['a\\u0009b']",
            "$['a\\u000ab']",
            "$['']",
            "$['가나']",
            "$['0abc']",
            "$[2147483647]",
        ] {
            assert!(jsonpath_is_valid(path), "{path} must parse");
            assert!(jsonpath_is_simple(path), "{path} must be simple");
        }
        for path in [
            "$..a..b",
            "$[?@.a]",
            "$..[?match(@,'x')]",
            "$[?$[*]]",
            "$[0,0]",
            "$[*,*]",
            "$['a','b']",
            "$[0:2]",
            "$.a ",
            "$ .a",
            "a.b",
            "$[",
            "$.",
            "$[a]",
            "$...a",
            "$..",
            "$['a'",
            "$[-]",
            "$['a']x",
            "$[0]]",
            "",
        ] {
            assert!(!jsonpath_is_simple(path), "{path} must not be simple");
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
    fn body_float_extract_exact() {
        for (lit, want) in [
            ("972.0979928970337", "972.0979928970337"),
            ("1.5e-300", "1.5e-300"),
            ("4.5e250", "4.5e+250"),
        ] {
            let body = format!(r#"{{"v":{lit}}}"#);
            let facts = body_facts(&body);
            let xs = vec![Extract::Body {
                decode: None,
                claim: None,
                var: "v".into(),
                path: "$.v".into(),
                default: None,
            }];
            let out = evaluate(&xs, &facts).unwrap();
            assert_eq!(out["v"], want, "text for {lit}");
            assert_eq!(
                out["v"].parse::<f64>().unwrap(),
                lit.parse::<f64>().unwrap(),
                "value for {lit}"
            );
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
            default: None,
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
            default: None,
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
            default: None,
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
            default: None,
        }];
        assert!(matches!(
            evaluate(&xs, &facts),
            Err(EngineError::ExtractFailed(_))
        ));
    }

    const NESTED_VECTORS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/nested_json_vectors.json"
    ));

    fn strict_one(body: &str, path: &str) -> Result<String> {
        let facts = body_facts(body);
        evaluate(&[body_extract("t", path)], &facts).map(|m| m["t"].clone())
    }

    fn lenient_one(body: &str, path: &str) -> Option<String> {
        let facts = body_facts(body);
        evaluate_lenient(&[body_extract("t", path)], &facts)
            .get("t")
            .cloned()
    }

    #[test]
    fn vectors_every_leaf_resolves() {
        let fx: serde_json::Value = serde_json::from_str(NESTED_VECTORS).unwrap();
        let mut checked = 0;
        for case in fx["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let body = case["body"].as_str().unwrap();
            for leaf in case["leaves"].as_array().unwrap() {
                let path = leaf[0].as_str().unwrap();
                let want = &leaf[1];
                assert_eq!(
                    strict_one(body, path).unwrap(),
                    stringify(want),
                    "{name} {path} strict"
                );
                let lenient = lenient_one(body, path);
                if want.is_null() {
                    assert_eq!(lenient, None, "{name} {path} lenient");
                } else {
                    assert_eq!(lenient, Some(stringify(want)), "{name} {path} lenient");
                }
                checked += 1;
            }
        }
        assert!(checked > 20, "fixture leaves read: {checked}");
    }

    #[test]
    fn vectors_known_divergence_is_missing() {
        let fx: serde_json::Value = serde_json::from_str(NESTED_VECTORS).unwrap();
        let list = fx["known_divergence"].as_array().unwrap();
        assert_eq!(list.len(), 3);
        for case in list {
            let name = case["name"].as_str().unwrap();
            let path = case["path"].as_str().unwrap();
            match strict_one(case["body"].as_str().unwrap(), path) {
                Err(EngineError::ExtractFailed(m)) => {
                    assert_eq!(m, format!("no match: {path}"), "{name}")
                }
                other => panic!("{name}: {other:?}"),
            }
        }
    }

    #[test]
    fn order_root_dollar_keeps_original_string() {
        assert_eq!(strict_one(r#""{\"id\":7}""#, "$").unwrap(), r#"{"id":7}"#);
    }

    #[test]
    fn order_original_string_field_wins() {
        let body = r#"{"data":"{ \"id\": 7 }"}"#;
        assert_eq!(strict_one(body, "$.data").unwrap(), r#"{ "id": 7 }"#);
        assert_eq!(strict_one(body, "$.data.id").unwrap(), "7");
    }

    #[test]
    fn order_null_in_original_does_not_fall_through() {
        let body = r#"{"w":"{\"id\":7}","x":{"id":null}}"#;
        assert_eq!(strict_one(body, "$..id").unwrap(), "");
        assert_eq!(lenient_one(body, "$..id"), None);
    }

    #[test]
    fn order_null_in_unwrapped_follows_same_rule() {
        let body = r#"{"w":"{\"id\":null}"}"#;
        assert_eq!(strict_one(body, "$.w.id").unwrap(), "");
        assert_eq!(lenient_one(body, "$.w.id"), None);
    }

    #[test]
    fn order_descendant_prefers_original() {
        let body = r#"{"w":"{\"id\":7}","x":{"id":1}}"#;
        assert_eq!(strict_one(body, "$..id").unwrap(), "1");
    }

    #[test]
    fn invalid_path_still_no_match() {
        match strict_one(r#"{"a":1}"#, "$[") {
            Err(EngineError::ExtractFailed(m)) => assert_eq!(m, "no match: $["),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn not_json_body_message_unchanged() {
        match strict_one("<html>", "$.a") {
            Err(EngineError::ExtractFailed(m)) => {
                assert!(m.starts_with("body not JSON: "), "{m}")
            }
            other => panic!("{other:?}"),
        }
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
            default: None,
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
            default: None,
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
            default: None,
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
            default: None,
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
                default: None,
            },
            Extract::Body {
                decode: None,
                claim: None,
                var: "second".into(),
                path: "$.b".into(),
                default: None,
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
            default: None,
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
            default: None,
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
            default: None,
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
            default: None,
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
            default: None,
        };
        let m = err_msg(evaluate(&[x], &body_facts("")));
        assert_eq!(m, "no header: X-None");
    }

    fn ys(y: &str) -> Vec<Extract> {
        serde_yaml::from_str(y).unwrap()
    }

    fn step_with(extract: Vec<Extract>) -> HttpStep {
        use crate::scenario::{DisabledRows, HttpMethod, Request};
        HttpStep {
            id: "01HX0000000000000000000001".into(),
            name: "s".into(),
            request: Request {
                method: HttpMethod::Get,
                url: "http://x".into(),
                headers: BTreeMap::new(),
                body: None,
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract,
            timeout_seconds: None,
            think_time: None,
        }
    }

    #[test]
    fn strict_default_items_skip_all_seven_failures() {
        let jwt = jwt_with(r#"{"n":null}"#);
        let body = format!(r#"{{"a":"A","n":null,"bad":"!!!","jwt":"{jwt}"}}"#);
        let items = ys(r#"
- {var: f_path, from: body, path: $.zz, default: d}
- {var: f_null, from: body, path: $.n, default: d}
- {var: f_header, from: header, name: X-None, default: d}
- {var: f_cookie, from: cookie, name: none, default: d}
- {var: f_decode, from: body, path: $.bad, decode: base64, default: d}
- {var: f_claim_missing, from: body, path: $.jwt, decode: jwt, claim: $.missing, default: d}
- {var: f_claim_null, from: body, path: $.jwt, decode: jwt, claim: $.n, default: d}
"#);
        let facts = body_facts(&body);
        let o = evaluate_with_defaults(&items, &facts);
        assert!(o.error.is_none(), "{:?}", o.error);
        for v in [
            "f_path",
            "f_null",
            "f_header",
            "f_cookie",
            "f_decode",
            "f_claim_missing",
            "f_claim_null",
        ] {
            assert!(!o.extracted.contains_key(v), "{v}: {:?}", o.extracted);
        }
        assert!(o.extracted.is_empty(), "{:?}", o.extracted);
        // 일곱째 실패 종류: 본문이 JSON이 아님.
        let items = ys("- {var: f_nonjson, from: body, path: $.a, default: d}\n");
        let o = evaluate_with_defaults(&items, &body_facts("not json"));
        assert!(o.error.is_none(), "{:?}", o.error);
        assert!(!o.extracted.contains_key("f_nonjson"));
    }

    #[test]
    fn strict_keeps_later_default_item_value_on_err() {
        let items = ys(r#"
- {var: x, from: body, path: $.zz}
- {var: a, from: body, path: $.a, default: d}
"#);
        let facts = body_facts(r#"{"a":"A"}"#);
        let want = evaluate(&items[..1], &facts).unwrap_err().to_string();
        let o = evaluate_with_defaults(&items, &facts);
        assert_eq!(o.error.unwrap().to_string(), want);
        assert_eq!(o.extracted.get("a").map(String::as_str), Some("A"));
        assert!(!o.extracted.contains_key("x"));
    }

    #[test]
    fn strict_err_drops_values_of_items_without_default() {
        let items = ys(r#"
- {var: k, from: body, path: $.a}
- {var: x, from: body, path: $.zz}
- {var: a, from: body, path: $.a, default: d}
"#);
        let o = evaluate_with_defaults(&items, &body_facts(r#"{"a":"A"}"#));
        assert!(o.error.is_some());
        assert_eq!(
            o.extracted,
            BTreeMap::from([("a".to_string(), "A".to_string())])
        );
    }

    #[test]
    fn strict_without_failure_matches_evaluate_for_non_default_items() {
        let items = ys(r#"
- {var: k, from: body, path: $.a}
- {var: n, from: body, path: $.n}
- {var: a, from: body, path: $.n, default: d}
"#);
        let o = evaluate_with_defaults(&items, &body_facts(r#"{"a":"A","n":null}"#));
        assert!(o.error.is_none());
        assert_eq!(
            o.extracted,
            BTreeMap::from([
                ("k".to_string(), "A".to_string()),
                ("n".to_string(), String::new())
            ])
        );
    }

    #[test]
    fn fill_table_four_cells_and_duplicate_rule() {
        let step = step_with(ys(r#"
- {var: a, from: body, path: $.a, default: d1}
- {var: a, from: body, path: $.a, default: d2}
- {var: b, from: body, path: $.b}
- {var: c, from: body, path: $.c, default: dc}
"#));
        for blank in [true, false] {
            let mut extracted = BTreeMap::from([("c".to_string(), "C".to_string())]);
            let mut iter_vars = BTreeMap::new();
            let f = fill_missing_extracts(&step, &mut extracted, &mut iter_vars, blank);
            assert_eq!(f.defaulted, vec!["a".to_string()], "blank={blank}");
            assert_eq!(extracted.get("a").map(String::as_str), Some("d2"));
            assert_eq!(iter_vars.get("a").map(String::as_str), Some("d2"));
            assert_eq!(extracted.get("c").map(String::as_str), Some("C"));
            assert!(!iter_vars.contains_key("c"));
            if blank {
                assert_eq!(f.blanked, vec!["b".to_string()]);
                assert_eq!(extracted.get("b").map(String::as_str), Some(""));
                assert_eq!(iter_vars.get("b").map(String::as_str), Some(""));
            } else {
                assert!(f.blanked.is_empty());
                assert!(!extracted.contains_key("b"));
                assert!(!iter_vars.contains_key("b"));
            }
        }
        // 한 이름을 [default d1, default 없음]으로 선언하고 못 뽑으면 default 있는 마지막 항목.
        let step = step_with(ys(r#"
- {var: a, from: body, path: $.a, default: d1}
- {var: a, from: body, path: $.a}
"#));
        let mut extracted = BTreeMap::new();
        let mut iter_vars = BTreeMap::new();
        let f = fill_missing_extracts(&step, &mut extracted, &mut iter_vars, true);
        assert_eq!(extracted.get("a").map(String::as_str), Some("d1"));
        assert_eq!(f.defaulted, vec!["a".to_string()]);
        assert!(f.blanked.is_empty());
        // 조건 반복 밖 + 기본값 없음 = 아무것도 안 한다.
        let step = step_with(ys("- {var: b, from: body, path: $.b}\n"));
        let mut extracted = BTreeMap::new();
        let f = fill_missing_extracts(&step, &mut extracted, &mut iter_vars, false);
        assert!(f.blanked.is_empty() && f.defaulted.is_empty() && extracted.is_empty());
    }

    #[test]
    fn fill_scale_many_items_keeps_order_and_duplicate_rule() {
        // 규모 확인용 정확성 고정(성능 단언 아님 — 느슨한 5초 상한만).
        let n = 20_000usize;
        let mut items = Vec::new();
        for i in 0..n {
            items.push(Extract::Body {
                var: format!("v{i}"),
                path: "$.zz".to_string(),
                decode: None,
                claim: None,
                default: Some(format!("d{i}")),
            });
            if i % 1000 == 0 {
                // 같은 이름을 기본값 없이 다시 선언: 기본값 있는 마지막 항목이 이긴다.
                items.push(Extract::Body {
                    var: format!("v{i}"),
                    path: "$.zz".to_string(),
                    decode: None,
                    claim: None,
                    default: None,
                });
            }
            if i % 1000 == 1 {
                // 같은 이름을 다른 기본값으로 다시 선언: 마지막 기본값이 이긴다.
                items.push(Extract::Body {
                    var: format!("v{i}"),
                    path: "$.zz".to_string(),
                    decode: None,
                    claim: None,
                    default: Some("last".to_string()),
                });
            }
        }
        items.push(Extract::Body {
            var: "plain".to_string(),
            path: "$.p".to_string(),
            decode: None,
            claim: None,
            default: None,
        });
        let step = step_with(items);
        let start = std::time::Instant::now();
        let mut extracted = BTreeMap::from([("v7".to_string(), "kept".to_string())]);
        let mut iter_vars = BTreeMap::new();
        let f = fill_missing_extracts(&step, &mut extracted, &mut iter_vars, true);
        let elapsed = start.elapsed();
        let want: Vec<String> = (0..n)
            .filter(|i| *i != 7)
            .map(|i| format!("v{i}"))
            .collect();
        assert_eq!(f.defaulted, want);
        assert_eq!(f.blanked, vec!["plain".to_string()]);
        assert_eq!(extracted.get("v0").map(String::as_str), Some("d0"));
        assert_eq!(extracted.get("v1").map(String::as_str), Some("last"));
        assert_eq!(extracted.get("v7").map(String::as_str), Some("kept"));
        assert_eq!(iter_vars.len(), n);
        assert!(elapsed.as_secs() < 5, "{elapsed:?}");
        eprintln!("fill_scale elapsed = {elapsed:?}");
    }

    #[test]
    fn strict_non_json_body_reports_first_error_and_keeps_no_values() {
        let items = ys(r#"
- {var: x, from: body, path: $.a}
- {var: y, from: body, path: $.b}
- {var: a, from: body, path: $.a, default: d}
"#);
        let facts = body_facts("not json");
        let want = evaluate(&items[..1], &facts).unwrap_err().to_string();
        let o = evaluate_with_defaults(&items, &facts);
        assert_eq!(o.error.unwrap().to_string(), want);
        assert!(o.extracted.is_empty(), "{:?}", o.extracted);
    }

    #[test]
    fn strict_mixed_default_and_plain_body_items_values() {
        let items = ys(r#"
- {var: k, from: body, path: $.a}
- {var: d1, from: body, path: $.zz, default: d}
- {var: d2, from: body, path: $.b, default: d}
- {var: m, from: body, path: $.b}
"#);
        let o = evaluate_with_defaults(&items, &body_facts(r#"{"a":"A","b":"B"}"#));
        assert!(o.error.is_none());
        assert_eq!(
            o.extracted,
            BTreeMap::from([
                ("k".to_string(), "A".to_string()),
                ("d2".to_string(), "B".to_string()),
                ("m".to_string(), "B".to_string()),
            ])
        );
    }
}
