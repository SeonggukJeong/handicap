//! JSON body 타입 캐스트(`{{var:num}}` / `{{var:bool}}` / `{{var:str}}`) 순수 헬퍼.
//! 캐스트는 JSON 문자열 leaf가 **순수 단일 flow 토큰**일 때만 의미를 가진다
//! (executor.rs::render_json_value / render_json_collecting 에서 호출).
//! 이 모듈은 변수를 렌더하지 않는다 — bare 토큰 문자열을 만들어 주고, 렌더된
//! 결과 문자열의 coerce만 담당한다.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cast {
    Str,
    Num,
    Bool,
}

/// `s`(trim 후)가 정확히 하나의 flow 토큰 `{{ inner }}`이고 inner가 trailing
/// `:num`/`:bool`/`:str` 캐스트로 끝나면 `(bare_token, cast)`를 반환. 그 외 `None`.
/// `bare_token`은 캐스트 접미사를 뗀 `{{name}}` 형태로, 호출부가 기존 `render`에
/// 그대로 넘길 수 있다.
///
/// - `${env}` 토큰·혼합 문자열·캐스트 없는 토큰·미지원 keyword(`:int` 등)는 `None`
///   → 호출부가 일반 문자열 경로로 처리한다(미지원 keyword는 결국 `UnknownVar`).
pub(crate) fn parse_cast_leaf(s: &str) -> Option<(String, Cast)> {
    let t = s.trim();
    let inner = t.strip_prefix("{{")?.strip_suffix("}}")?;
    // 단일 토큰만: 내부에 또 다른 brace 페어가 있으면 거부.
    if inner.contains("{{") || inner.contains("}}") {
        return None;
    }
    let (name, kw) = inner.rsplit_once(':')?; // 콜론 없으면 캐스트 아님
    let cast = match kw.trim() {
        "str" => Cast::Str,
        "num" => Cast::Num,
        "bool" => Cast::Bool,
        _ => return None, // 미지원 keyword → 캐스트 아님
    };
    let bare = ["{{", name.trim(), "}}"].concat();
    Some((bare, cast))
}

/// 렌더된 문자열을 JSON 숫자로 coerce. JSON number 문법만 통과(leading-zero·
/// `"true"`·`"abc"`·빈 문자열 실패; 앞뒤 공백은 허용). 실패 시 `None`.
pub(crate) fn coerce_num(v: &str) -> Option<serde_json::Value> {
    match serde_json::from_str::<serde_json::Value>(v) {
        Ok(val @ serde_json::Value::Number(_)) => Some(val),
        _ => None,
    }
}

/// 렌더된 문자열을 불리언으로 coerce. 정확히 `"true"`/`"false"`만. 실패 시 `None`.
pub(crate) fn coerce_bool(v: &str) -> Option<serde_json::Value> {
    match v {
        "true" => Some(serde_json::Value::Bool(true)),
        "false" => Some(serde_json::Value::Bool(false)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_pure_num_bool_str() {
        assert_eq!(
            parse_cast_leaf("{{age:num}}"),
            Some(("{{age}}".into(), Cast::Num))
        );
        assert_eq!(
            parse_cast_leaf("{{ok:bool}}"),
            Some(("{{ok}}".into(), Cast::Bool))
        );
        assert_eq!(
            parse_cast_leaf("{{zip:str}}"),
            Some(("{{zip}}".into(), Cast::Str))
        );
    }

    #[test]
    fn parse_trims_and_keeps_name() {
        // 토큰 앞뒤 공백 + 내부 공백 모두 정규화되어 bare는 깔끔한 {{name}}.
        assert_eq!(
            parse_cast_leaf("  {{ age : num }}  "),
            Some(("{{age}}".into(), Cast::Num))
        );
    }

    #[test]
    fn parse_rejects_non_cast() {
        assert_eq!(parse_cast_leaf("{{name}}"), None); // 캐스트 없음
        assert_eq!(parse_cast_leaf("{{age:int}}"), None); // 미지원 keyword
        assert_eq!(parse_cast_leaf("x {{age:num}} y"), None); // 혼합(순수 토큰 아님)
        assert_eq!(parse_cast_leaf("{{a}}{{b:num}}"), None); // 다중 토큰
        assert_eq!(parse_cast_leaf("${X:num}"), None); // env 토큰
        assert_eq!(parse_cast_leaf("literal"), None);
    }

    #[test]
    fn coerce_num_accepts_int_float_signed_exp() {
        assert_eq!(coerce_num("30"), Some(json!(30)));
        assert_eq!(coerce_num("9.5"), Some(json!(9.5)));
        assert_eq!(coerce_num("-5"), Some(json!(-5)));
        assert_eq!(coerce_num("1e3"), Some(json!(1000.0)));
        assert_eq!(coerce_num(" 30 "), Some(json!(30))); // 앞뒤 공백 허용
    }

    #[test]
    fn coerce_num_rejects_non_number() {
        assert_eq!(coerce_num("abc"), None);
        assert_eq!(coerce_num("01234"), None); // leading-zero = JSON 위반
        assert_eq!(coerce_num(""), None);
        assert_eq!(coerce_num("true"), None); // bool은 숫자 아님
        assert_eq!(coerce_num("30 40"), None); // 추가 토큰
    }

    #[test]
    fn coerce_bool_exact_only() {
        assert_eq!(coerce_bool("true"), Some(json!(true)));
        assert_eq!(coerce_bool("false"), Some(json!(false)));
        assert_eq!(coerce_bool("True"), None);
        assert_eq!(coerce_bool("1"), None);
        assert_eq!(coerce_bool(""), None);
    }
}
