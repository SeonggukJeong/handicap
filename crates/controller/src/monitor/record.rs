//! 점검 기록 가공 — 순수 함수 (spec `2026-10-29-ops-monitor-polish-2-design.md` §3.2).
//!
//! 점검 trace는 원래 판정 후 버려졌다. 이 모듈이 만든 `CheckRecord`는 막대 구간 동안
//! 컨트롤러 메모리에 남고 인증 없는 REST로 조회되므로, 보관 **전에** 인증 값을 가리고
//! 흐름 변수를 비우고 본문을 상한으로 자른다.

use handicap_engine::{ScenarioTrace, TracedRequest, TracedResponse};
use std::sync::Arc;

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

use super::check::CheckResult;
use super::config::AUTH_HEADERS;

/// 가림 문자열(U+2022 ×4).
pub const MASK: &str = "••••";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipSide {
    Request,
    Response,
}

/// 기록 상한에 잘린 본문 — `step`은 `trace.steps` 배열 인덱스(시나리오 스텝 순번 아님).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Clipped {
    pub step: u32,
    pub side: ClipSide,
}

/// 기록 본문 — 한 번의 점검에서 여러 칸이 `Arc`로 공유한다.
#[derive(Debug, Clone)]
pub struct RecordBody {
    /// 이 기록을 만들 때 적용된 상한(KB).
    pub limit_kb: u32,
    pub trace: Option<ScenarioTrace>,
    pub clipped: Vec<Clipped>,
}

/// 점검 1회의 기록 — 와이어(spec §2.4)와 1:1, 모든 필드 항상 직렬화.
#[derive(Debug, Clone)]
pub struct CheckRecord {
    pub at_ms: i64,
    pub result: CheckResult,
    pub body: Arc<RecordBody>,
}

// serde `rc` feature가 없어 `Arc<T>`는 Serialize가 아니다 — 손으로 평탄화한다.
impl Serialize for CheckRecord {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let mut st = ser.serialize_struct("CheckRecord", 5)?;
        st.serialize_field("at_ms", &self.at_ms)?;
        st.serialize_field("limit_kb", &self.body.limit_kb)?;
        st.serialize_field("result", &self.result)?;
        st.serialize_field("trace", &self.body.trace)?;
        st.serialize_field("clipped", &self.body.clipped)?;
        st.end()
    }
}

/// 점검 결과와 (있으면) trace로 보관용 기록을 만든다 — spec §3.2 1–7.
///
/// 인증 헤더 4종(요청·응답)·`set_cookies`·URL 사용자정보의 비어 있지 않은 비밀 부분을
/// `MASK`로 가리고, 흐름 변수(`final_vars`·`extracted`)를 비우고, 본문을
/// `limit_kb × 1024`바이트 예산 안으로 자른다(스텝 순서, 스텝마다 요청 → 응답).
/// 요청 본문은 가리지 않는다(화면에서 기본 가림 — spec §5.3).
pub fn build_record(
    result: &CheckResult,
    trace: Option<ScenarioTrace>,
    limit_kb: u32,
) -> CheckRecord {
    CheckRecord {
        at_ms: result.at_ms,
        result: result.clone(),
        body: Arc::new(build_record_body(trace, limit_kb)),
    }
}

/// 가림·자르기·흐름 변수/`branch_eval` 폐기를 마친 공유용 본문.
pub fn build_record_body(trace: Option<ScenarioTrace>, limit_kb: u32) -> RecordBody {
    let mut clipped = Vec::new();
    let trace = trace.map(|mut t| {
        let mut budget = limit_kb as usize * 1024;
        t.final_vars.clear();
        for (i, s) in t.steps.iter_mut().enumerate() {
            s.extracted.clear();
            s.branch_eval.clear();
            let step = u32::try_from(i).unwrap_or(u32::MAX);
            if let Some(req) = s.request.as_mut() {
                mask_request(req);
                if let Some(body) = req.body.as_mut()
                    && clip_body(body, &mut budget)
                {
                    clipped.push(Clipped {
                        step,
                        side: ClipSide::Request,
                    });
                }
            }
            if let Some(resp) = s.response.as_mut() {
                mask_response(resp);
                if clip_body(&mut resp.body, &mut budget) {
                    clipped.push(Clipped {
                        step,
                        side: ClipSide::Response,
                    });
                }
            }
        }
        t
    });
    RecordBody {
        limit_kb,
        trace,
        clipped,
    }
}

fn mask_request(req: &mut TracedRequest) {
    for (name, value) in req.headers.iter_mut() {
        mask_header(name, value);
    }
    req.url = mask_url_userinfo(&req.url);
}

fn mask_response(resp: &mut TracedResponse) {
    for (name, value) in resp.headers.iter_mut() {
        mask_header(name, value);
    }
    for c in resp.set_cookies.iter_mut() {
        *c = mask_set_cookie(c);
    }
}

/// 이름이 인증 헤더 4종(앞뒤 공백 무시·대소문자 무시)이면 그 규칙으로 값을 가린다.
/// 그 외 헤더는 원문. 엔진은 `HeaderName`이 거부한 저작 이름(`"Authorization "`)도
/// 렌더된 값과 함께 trace에 싣으므로 trim이 필요하다(`PreviewResult.tsx`와 같은 규칙).
fn mask_header(name: &str, value: &mut String) {
    let name = name.trim();
    let Some(h) = AUTH_HEADERS.iter().find(|h| name.eq_ignore_ascii_case(h)) else {
        return;
    };
    *value = match *h {
        "cookie" => mask_cookie(value),
        "set-cookie" => mask_set_cookie(value),
        // authorization · proxy-authorization
        _ => mask_authorization(value),
    };
}

/// `Bearer abc` → `Bearer ••••` (첫 공백까지 = 스킴 유지), 공백 없으면 값 전체가 비밀.
/// 비밀 부분이 비었거나 공백뿐이면 그대로.
fn mask_authorization(v: &str) -> String {
    match v.find(' ') {
        Some(sp) => {
            let (scheme, rest) = v.split_at(sp + 1);
            if rest.trim().is_empty() {
                v.to_string()
            } else {
                format!("{scheme}{MASK}")
            }
        }
        None if v.trim().is_empty() => v.to_string(),
        None => MASK.to_string(),
    }
}

/// `a=1; b=2` → `a=••••; b=••••` — 쌍마다 `=` 앞 이름 유지, 값이 비면 그대로.
/// `=` 없는 쌍은 통째로 비밀(빈 쌍은 그대로). 쌍 앞 공백은 유지.
fn mask_cookie(v: &str) -> String {
    v.split(';')
        .map(|pair| match pair.find('=') {
            Some(eq) => {
                if pair[eq + 1..].trim().is_empty() {
                    pair.to_string()
                } else {
                    format!("{}{MASK}", &pair[..=eq])
                }
            }
            None if pair.trim().is_empty() => pair.to_string(),
            None => {
                let lead = pair.len() - pair.trim_start().len();
                format!("{}{MASK}", &pair[..lead])
            }
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// `sid=x; Path=/` → `sid=••••`, `sid=; Max-Age=0` → `sid=` — 첫 `=` 앞 이름만 남기고
/// 속성은 버린다. 첫 `;` 전에 `=`가 없으면 통째로 `••••`(빈 값은 그대로).
fn mask_set_cookie(v: &str) -> String {
    let head = v.split(';').next().unwrap_or("");
    match head.find('=') {
        Some(eq) => {
            if head[eq + 1..].trim().is_empty() {
                head[..=eq].to_string()
            } else {
                format!("{}{MASK}", &head[..=eq])
            }
        }
        // 값 전체가 비었을 때만 그대로. 머리만 빈 경우(`; sid=x`)도 속성은 버린다.
        None if v.trim().is_empty() => v.to_string(),
        None if head.trim().is_empty() => head.to_string(),
        None => MASK.to_string(),
    }
}

/// `MASK`가 `Url` 사용자정보에 들어가면 보이는 모양(퍼센트 인코딩).
const MASK_URL_ENCODED: &str = "%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2";

/// URL 사용자정보를 가린다. 평소엔 원문 문자열만 고친다(`splice_url_userinfo` — 경로·쿼리
/// 정규화 방지). 그 결과를 `Url`(= reqwest가 실제로 보내는 해석)로 다시 읽어 아직 살아 있는
/// 자격 증명이 있으면 — `http:user:pw@h`·`http:\\user:pw@h`처럼 `://`가 없는 관대한 형태,
/// 또는 쿼리 속 `://`가 문자열 경로를 속인 경우 — 정규화된 직렬화 위에서 다시 가린다.
/// 그래도 남으면 URL 전체를 가린다.
fn mask_url_userinfo(url: &str) -> String {
    let spliced = splice_url_userinfo(url);
    let Ok(parsed) = reqwest::Url::parse(&spliced) else {
        return spliced;
    };
    if !has_live_credentials(&parsed) {
        return spliced;
    }
    // 정규화된 직렬화는 `scheme://userinfo@host…` 꼴이고 사용자정보 안의 `/?#@:`는 인코딩돼
    // 있어 문자열 경로가 정확하다.
    let again = splice_url_userinfo(parsed.as_str());
    match reqwest::Url::parse(&again) {
        Ok(u) if !has_live_credentials(&u) => again,
        _ => MASK.to_string(),
    }
}

/// `Url`의 사용자정보에 가려지지 않은 자격 증명이 있나. 비밀번호가 있으면 비밀번호가,
/// 비밀번호가 비면 사용자 이름이 자격 증명이다(`splice_url_userinfo`와 같은 규칙).
fn has_live_credentials(u: &reqwest::Url) -> bool {
    match u.password() {
        Some(p) if !p.is_empty() => p != MASK_URL_ENCODED,
        _ => !u.username().is_empty() && u.username() != MASK_URL_ENCODED,
    }
}

/// URL 사용자정보(`scheme://` 뒤 첫 `/`·`?`·`#` 전의 마지막 `@` 앞)만 원문 문자열에서 바꾼다.
/// `user:pass@` → `user:••••@`, `token@` → `••••@`.
/// 비밀번호가 빈 `user:@`는 `••••:@` — reqwest가 사용자 이름을 Basic 인증으로 보내므로
/// 이때는 사용자 이름이 자격 증명이다(보안 리뷰 판정: spec §3.2의 "비면 그대로"를 대체, `tok@`와 같은 취급).
/// `Url`로 다시 직렬화하지 않는다(경로·쿼리 정규화 방지).
fn splice_url_userinfo(url: &str) -> String {
    let Some(sep) = url.find("://") else {
        return url.to_string();
    };
    let start = sep + 3;
    let rest = &url[start..];
    let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let Some(at) = rest[..auth_end].rfind('@') else {
        return url.to_string();
    };
    let userinfo = &rest[..at];
    let masked = match userinfo.find(':') {
        Some(colon) if colon + 1 < userinfo.len() => format!("{}{MASK}", &userinfo[..=colon]),
        Some(0) => return url.to_string(),
        Some(_) => format!("{MASK}:"),
        None if userinfo.is_empty() => return url.to_string(),
        None => MASK.to_string(),
    };
    format!("{}{masked}{}", &url[..start], &rest[at..])
}

/// 남은 예산 안으로 본문을 자른다(UTF-8 문자 경계). 잘렸으면 `true`.
/// 원래 빈 본문은 예산과 무관하게 `false`.
fn clip_body(body: &mut String, budget: &mut usize) -> bool {
    if body.len() <= *budget {
        *budget -= body.len();
        return false;
    }
    // MSRV 1.85: `str::floor_char_boundary` 대신 `is_char_boundary`로 뒤로 걷는다.
    let mut cut = *budget;
    while !body.is_char_boundary(cut) {
        cut -= 1;
    }
    body.truncate(cut);
    *budget -= cut;
    true
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use handicap_engine::{StepKind, StepTrace};

    use super::super::check::Verdict;
    use super::*;

    fn result() -> CheckResult {
        CheckResult {
            at_ms: 1_700_000_000_123,
            verdict: Verdict::Fail,
            latency_ms: Some(42),
            reason: Some("응답 코드 500".into()),
            detail: Some("기대 200".into()),
            display: vec![Some("v1".into()), None],
        }
    }

    fn req(url: &str, headers: &[(&str, &str)], body: Option<&str>) -> TracedRequest {
        TracedRequest {
            method: "POST".into(),
            url: url.into(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body: body.map(str::to_string),
        }
    }

    fn resp(headers: &[(&str, &str)], set_cookies: &[&str], body: &str) -> TracedResponse {
        TracedResponse {
            status: 200,
            latency_ms: 5,
            download_ms: Some(1),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            set_cookies: set_cookies.iter().map(|s| s.to_string()).collect(),
            body: body.into(),
            body_truncated: false,
        }
    }

    fn step(request: Option<TracedRequest>, response: Option<TracedResponse>) -> StepTrace {
        StepTrace {
            step_id: "01HZZZZZZZZZZZZZZZZZZZZZZZ".into(),
            kind: StepKind::Http,
            loop_index: None,
            branch: None,
            request,
            response,
            extracted: BTreeMap::new(),
            unbound_vars: Vec::new(),
            error: None,
            branch_eval: Vec::new(),
            timed_out: false,
        }
    }

    fn trace(steps: Vec<StepTrace>) -> ScenarioTrace {
        ScenarioTrace {
            ok: true,
            total_ms: 10,
            steps,
            final_vars: BTreeMap::new(),
            truncated: false,
            error: None,
        }
    }

    /// 넉넉한 상한(본문 상한이 끼어들지 않게).
    const BIG: u32 = 1024;

    fn one(s: StepTrace) -> StepTrace {
        let rec = build_record(&result(), Some(trace(vec![s])), BIG);
        rec.body
            .trace
            .clone()
            .unwrap()
            .steps
            .into_iter()
            .next()
            .unwrap()
    }

    fn req_header(name: &str, value: &str) -> String {
        let s = one(step(Some(req("https://h/x", &[(name, value)], None)), None));
        s.request.unwrap().headers[name].clone()
    }

    fn resp_header(name: &str, value: &str) -> String {
        let s = one(step(None, Some(resp(&[(name, value)], &[], ""))));
        s.response.unwrap().headers[name].clone()
    }

    fn set_cookie_item(value: &str) -> String {
        let s = one(step(None, Some(resp(&[], &[value], ""))));
        s.response.unwrap().set_cookies[0].clone()
    }

    #[test]
    fn mask_table() {
        // (이름, 값, 기대) — 요청 헤더와 응답 헤더 둘 다 같은 규칙.
        let rows: &[(&str, &str, &str)] = &[
            ("authorization", "Bearer x", "Bearer ••••"),
            ("authorization", "Bearer ", "Bearer "),
            ("authorization", "Bearer   ", "Bearer   "),
            ("authorization", "x", "••••"),
            ("authorization", "", ""),
            ("Authorization", "Bearer x", "Bearer ••••"),
            ("Authorization", "x", "••••"),
            ("AUTHORIZATION", "Bearer x", "Bearer ••••"),
            ("proxy-authorization", "Basic y", "Basic ••••"),
            ("Proxy-Authorization", "Basic y", "Basic ••••"),
            ("cookie", "a=1; b=2", "a=••••; b=••••"),
            ("cookie", "a=; b=2", "a=; b=••••"),
            ("cookie", "abc123", "••••"),
            ("Cookie", "a=1; b=2", "a=••••; b=••••"),
            ("cookie", "", ""),
            ("set-cookie", "sid=x; Path=/", "sid=••••"),
            ("set-cookie", "sid=; Max-Age=0", "sid="),
            ("set-cookie", "abc; Path=/", "••••"),
            ("Set-Cookie", "sid=x; Path=/", "sid=••••"),
            ("set-cookie", "", ""),
            ("set-cookie", "   ", "   "),
            // 첫 `;` 앞이 비어도 속성(뒤쪽 비밀)은 버린다 — 머리만 남김.
            ("set-cookie", "; sid=x", ""),
            ("set-cookie", " ; Path=/", " "),
            ("set-cookie", " ; token=abc", " "),
            // 이름 앞뒤 공백(엔진은 HeaderName 거부 시에도 저작 이름 그대로 trace에 싣는다).
            ("Authorization ", "Bearer x", "Bearer ••••"),
            (" authorization", "x", "••••"),
            (" cookie", "a=1", "a=••••"),
            ("set-cookie\t", "sid=x; Path=/", "sid=••••"),
            ("x-api-key", "k", "k"),
            ("content-type", "application/json", "application/json"),
        ];
        for (name, value, want) in rows {
            assert_eq!(&req_header(name, value), want, "request {name}: {value:?}");
            assert_eq!(
                &resp_header(name, value),
                want,
                "response {name}: {value:?}"
            );
        }
    }

    /// `set_cookies` 항목도 set-cookie 규칙 — 헤더 표와 독립적으로 RED가 나도록 분리.
    #[test]
    fn mask_table_set_cookies_items() {
        let items: &[(&str, &str)] = &[
            ("sid=x; Path=/", "sid=••••"),
            ("sid=; Max-Age=0", "sid="),
            ("abc; Path=/", "••••"),
            ("sid=x", "sid=••••"),
            ("", ""),
            ("   ", "   "),
            ("; sid=x", ""),
            (" ; Path=/", " "),
            (" ; token=abc", " "),
        ];
        for (value, want) in items {
            assert_eq!(&set_cookie_item(value), want, "set_cookies {value:?}");
        }
    }

    #[test]
    fn mask_constant_is_u2022_x4() {
        assert_eq!(MASK, "\u{2022}\u{2022}\u{2022}\u{2022}");
    }

    fn masked_url(url: &str) -> String {
        let s = one(step(Some(req(url, &[], None)), None));
        s.request.unwrap().url
    }

    #[test]
    fn url_userinfo_table() {
        let rows: &[(&str, &str)] = &[
            ("https://u:p@h/x", "https://u:••••@h/x"),
            ("https://tok@h", "https://••••@h"),
            // 비밀번호가 비면 사용자 이름이 자격 증명(reqwest가 Basic으로 보냄) — 가린다.
            ("https://u:@h", "https://••••:@h"),
            ("https://sk_live_SECRET:@h/x", "https://••••:@h/x"),
            ("https://:@h/x", "https://:@h/x"),
            ("https://h/a@b", "https://h/a@b"),
            ("https://h/경로?q=한글", "https://h/경로?q=한글"),
            ("https://h?x=a@b", "https://h?x=a@b"),
            ("https://h#a@b", "https://h#a@b"),
            ("https://u:p:q@h:8080/x?y=1", "https://u:••••@h:8080/x?y=1"),
            ("https://u:p@x@h/x", "https://u:••••@h/x"),
            ("http://h", "http://h"),
        ];
        for (url, want) in rows {
            assert_eq!(&masked_url(url), want, "url {url:?}");
        }
    }

    /// `://` 없이도 `url` 크레이트(=reqwest)가 사용자정보로 읽는 형태 — 원문 비밀이 남으면 안 된다.
    #[test]
    fn url_userinfo_lenient_forms_masked() {
        let rows = [
            "http:user:SECRET@host/x",
            "http:/user:SECRET@host/x",
            "http:\\\\user:SECRET@host/x",
            "http:/\t/user:SECRET@host/x",
            "HTTP:user:SECRET@host/x",
            // 쿼리 속 `://`가 문자열 경로를 속여도 진짜 사용자정보는 가린다.
            "http:user:SECRET@host/x?next=http://a@b",
            "http:SECRET@host/x",
            "http:SECRET:@host/x",
        ];
        for url in rows {
            let out = masked_url(url);
            assert!(!out.contains("SECRET"), "url {url:?} → {out:?}");
            assert!(out.contains(MASK), "url {url:?} → {out:?}");
        }
        assert_eq!(
            masked_url("http:user:SECRET@host/x"),
            "http://user:••••@host/x"
        );
    }

    #[test]
    fn vars_cleared() {
        let mut s = step(Some(req("https://h", &[], None)), None);
        s.extracted.insert("token".into(), "secret".into());
        s.unbound_vars = vec!["missing".into()];
        s.error = Some("요청 실패".into());
        let mut t = trace(vec![s]);
        t.final_vars.insert("token".into(), "secret".into());
        t.truncated = true;
        t.error = Some("setup".into());
        let rec = build_record(&result(), Some(t), BIG);
        let t = rec.body.trace.clone().unwrap();
        assert!(t.final_vars.is_empty());
        assert!(t.steps[0].extracted.is_empty());
        assert_eq!(t.steps[0].unbound_vars, vec!["missing".to_string()]);
        assert_eq!(t.steps[0].error.as_deref(), Some("요청 실패"));
        assert!(t.truncated);
        assert_eq!(t.error.as_deref(), Some("setup"));
    }

    #[test]
    fn budget_exact_not_clipped() {
        let body = "a".repeat(16 * 1024);
        let rec = build_record(
            &result(),
            Some(trace(vec![step(None, Some(resp(&[], &[], &body)))])),
            16,
        );
        assert!(rec.body.clipped.is_empty());
        let t = rec.body.trace.clone().unwrap();
        assert_eq!(t.steps[0].response.as_ref().unwrap().body.len(), 16384);
    }

    #[test]
    fn budget_plus_one_clipped() {
        let body = "a".repeat(16 * 1024 + 1);
        let rec = build_record(
            &result(),
            Some(trace(vec![step(None, Some(resp(&[], &[], &body)))])),
            16,
        );
        assert_eq!(
            rec.body.clipped,
            vec![Clipped {
                step: 0,
                side: ClipSide::Response
            }]
        );
        let t = rec.body.trace.clone().unwrap();
        assert_eq!(t.steps[0].response.as_ref().unwrap().body.len(), 16384);
    }

    #[test]
    fn cut_on_char_boundary() {
        // 16383바이트 ASCII + "가"(3바이트) → 예산 16384는 "가" 중간.
        let body = format!("{}가나", "a".repeat(16383));
        let rec = build_record(
            &result(),
            Some(trace(vec![step(None, Some(resp(&[], &[], &body)))])),
            16,
        );
        let t = rec.body.trace.clone().unwrap();
        let got = &t.steps[0].response.as_ref().unwrap().body;
        assert!(got.len() <= 16384);
        assert_eq!(got, &"a".repeat(16383));
        assert_eq!(rec.body.clipped.len(), 1);
        // 경계 앞 문자까지 남는 경우: 16381 ASCII + "가"(→16384) + "나".
        let body = format!("{}가나", "a".repeat(16381));
        let rec = build_record(
            &result(),
            Some(trace(vec![step(None, Some(resp(&[], &[], &body)))])),
            16,
        );
        let t = rec.body.trace.clone().unwrap();
        let got = &t.steps[0].response.as_ref().unwrap().body;
        assert_eq!(got, &format!("{}가", "a".repeat(16381)));
        assert_eq!(got.len(), 16384);
    }

    #[test]
    fn order_request_then_response_then_next_step() {
        let b = "a".repeat(10240);
        let mk = || {
            step(
                Some(req("https://h", &[], Some(&b))),
                Some(resp(&[], &[], &b)),
            )
        };
        let rec = build_record(&result(), Some(trace(vec![mk(), mk()])), 16);
        assert_eq!(
            rec.body.clipped,
            vec![
                Clipped {
                    step: 0,
                    side: ClipSide::Response
                },
                Clipped {
                    step: 1,
                    side: ClipSide::Request
                },
                Clipped {
                    step: 1,
                    side: ClipSide::Response
                },
            ]
        );
        let t = rec.body.trace.clone().unwrap();
        assert_eq!(
            t.steps[0].request.as_ref().unwrap().body.as_deref(),
            Some(b.as_str())
        );
        assert_eq!(t.steps[0].response.as_ref().unwrap().body.len(), 6144);
        assert_eq!(
            t.steps[1].request.as_ref().unwrap().body.as_deref(),
            Some("")
        );
        assert_eq!(t.steps[1].response.as_ref().unwrap().body, "");
    }

    #[test]
    fn record_clears_branch_eval() {
        use handicap_engine::BranchEval;
        let row = StepTrace {
            kind: StepKind::If,
            branch: Some("then".into()),
            branch_eval: vec![BranchEval {
                branch: "then".into(),
                passed: true,
                leaf: None,
            }],
            ..step(None, None)
        };
        assert!(!row.branch_eval.is_empty());
        let got = one(row);
        assert!(got.branch_eval.is_empty());
        assert_eq!(got.branch.as_deref(), Some("then"));
    }

    #[test]
    fn empty_or_none_bodies_not_marked() {
        let big = "a".repeat(16 * 1024 + 5);
        let rec = build_record(
            &result(),
            Some(trace(vec![
                step(None, Some(resp(&[], &[], &big))),
                // 예산 소진 뒤: 요청 None + 응답 "" / 요청 "" + 응답 없음 / if 행.
                step(Some(req("https://h", &[], None)), Some(resp(&[], &[], ""))),
                step(Some(req("https://h", &[], Some(""))), None),
                StepTrace {
                    kind: StepKind::If,
                    branch: Some("then".into()),
                    ..step(None, None)
                },
            ])),
            16,
        );
        assert_eq!(
            rec.body.clipped,
            vec![Clipped {
                step: 0,
                side: ClipSide::Response
            }]
        );
        let t = rec.body.trace.clone().unwrap();
        assert_eq!(t.steps[1].request.as_ref().unwrap().body, None);
        assert_eq!(
            t.steps[2].request.as_ref().unwrap().body.as_deref(),
            Some("")
        );
    }

    #[test]
    fn engine_truncated_flag_kept() {
        let mut r = resp(&[], &[], "abc");
        r.body_truncated = true;
        let s = one(step(None, Some(r)));
        let r = s.response.unwrap();
        assert!(r.body_truncated);
        assert_eq!(r.body, "abc");
    }

    #[test]
    fn none_trace_passes_through() {
        let rec = build_record(&result(), None, 128);
        assert!(rec.body.trace.is_none());
        assert!(rec.body.clipped.is_empty());
        assert_eq!(rec.result, result());
        assert_eq!(rec.at_ms, result().at_ms);
        assert_eq!(rec.body.limit_kb, 128);
    }

    #[test]
    fn untouched_fields_preserved() {
        let s = step(
            Some(req("https://h/x", &[("x-a", "1")], Some("{\"a\":1}"))),
            Some(resp(&[("x-b", "2")], &[], "ok")),
        );
        let t = trace(vec![s.clone()]);
        let rec = build_record(&result(), Some(t.clone()), BIG);
        assert!(rec.body.clipped.is_empty());
        assert_eq!(rec.body.trace.clone().unwrap(), t);
    }

    #[test]
    fn serializes_wire_shape() {
        let rec = build_record(&result(), None, 16);
        let v = serde_json::to_value(&rec).unwrap();
        let obj = v.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["at_ms", "clipped", "limit_kb", "result", "trace"]);
        assert_eq!(obj["at_ms"], serde_json::json!(1_700_000_000_123_i64));
        assert_eq!(obj["limit_kb"], serde_json::json!(16));
        assert!(obj["trace"].is_null());
        assert_eq!(obj["clipped"], serde_json::json!([]));
        assert_eq!(obj["result"], serde_json::to_value(result()).unwrap());

        let big = "a".repeat(16 * 1024 + 1);
        let rec = build_record(
            &result(),
            Some(trace(vec![step(
                Some(req("https://h", &[], Some(&big))),
                Some(resp(&[], &[], "x")),
            )])),
            16,
        );
        let v = serde_json::to_value(&rec).unwrap();
        assert_eq!(
            v["clipped"],
            serde_json::json!([
                {"step": 0, "side": "request"},
                {"step": 0, "side": "response"}
            ])
        );
        assert!(v["trace"].is_object());
    }

    #[test]
    fn shared_body_serializes_per_panel_result() {
        let body = Arc::new(build_record_body(
            Some(trace(vec![step(None, Some(resp(&[], &[], "x")))])),
            16,
        ));
        let mut r2 = result();
        r2.verdict = Verdict::UpstreamFailed;
        let a = CheckRecord {
            at_ms: 1,
            result: result(),
            body: Arc::clone(&body),
        };
        let b = CheckRecord {
            at_ms: 1,
            result: r2,
            body,
        };
        let (va, vb) = (
            serde_json::to_value(&a).unwrap(),
            serde_json::to_value(&b).unwrap(),
        );
        assert_ne!(va["result"]["verdict"], vb["result"]["verdict"]);
        assert_eq!(vb["result"]["verdict"], "upstream_failed");
        assert!(va["trace"].is_object());
        assert_eq!(va["trace"], vb["trace"]);
    }
}
