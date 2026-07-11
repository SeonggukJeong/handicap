//! JSON body 타입 캐스트(`{{var:num}}` / `{{var:bool}}` / `{{var:str}}` / `{{var:json}}`,
//! 그리고 env/시스템 `${VAR:num}` 등) 순수 헬퍼.
//! 캐스트는 JSON 문자열 leaf가 **순수 단일 토큰**일 때만 의미를 가진다
//! (executor.rs::render_json_value / render_json_collecting 에서 호출).
//! 이 모듈은 변수를 렌더하지 않는다 — bare 토큰 문자열을 만들어 주고, 렌더된
//! 결과 문자열의 coerce만 담당한다.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cast {
    Str,
    Num,
    Bool,
    Json,
}

/// `s`(trim 후)가 정확히 하나의 토큰(flow `{{ inner }}` 또는 env/시스템 `${ inner }`)이고
/// inner가 trailing `:num`/`:bool`/`:str`/`:json` 캐스트로 끝나면 `(bare_token, cast)` 반환.
/// `bare_token`은 캐스트 접미사를 뗀 `{{name}}` 또는 `${name}` 형태로, 호출부가 기존 `render`에
/// 그대로 넘긴다. 그 외(캐스트 없음·미지원 keyword·혼합·다중 토큰·`${VAR:-default}`)는 `None`.
pub(crate) fn parse_cast_leaf(s: &str) -> Option<(String, Cast)> {
    let t = s.trim();
    // flow `{{...}}` 또는 env/시스템 `${...}` — 순수 단일 토큰만.
    let (open, close, inner) =
        if let Some(i) = t.strip_prefix("{{").and_then(|x| x.strip_suffix("}}")) {
            // flow 가드(현행 byte-identical): 내부에 또 다른 brace 페어면 거부.
            if i.contains("{{") || i.contains("}}") {
                return None;
            }
            ("{{", "}}", i)
        } else {
            let i = t.strip_prefix("${").and_then(|x| x.strip_suffix('}'))?;
            // env 가드(신규): 내부에 또 다른 토큰 마커(`{`/`}`/`$`)면 다중/비순수 → 거부.
            if i.contains('{') || i.contains('}') || i.contains('$') {
                return None;
            }
            ("${", "}", i)
        };
    let (name, kw) = inner.rsplit_once(':')?; // 콜론 없으면 캐스트 아님
    let cast = match kw.trim() {
        "str" => Cast::Str,
        "num" => Cast::Num,
        "bool" => Cast::Bool,
        "json" => Cast::Json,
        _ => return None, // 미지원 keyword·`-default` → 캐스트 아님
    };
    let bare = [open, name.trim(), close].concat();
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

/// 렌더된 문자열을 임의 JSON 값으로 파싱. 객체/배열/숫자/불리언/문자열/null 전부 허용.
/// 전체가 단일 JSON 값이어야 하며(후행 문자 거부·앞뒤 공백 허용), 실패 시 `None`.
pub(crate) fn coerce_json(v: &str) -> Option<serde_json::Value> {
    serde_json::from_str(v).ok()
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
        assert_eq!(parse_cast_leaf("literal"), None);
    }

    #[test]
    fn parse_env_and_system_token_casts() {
        assert_eq!(
            parse_cast_leaf("${PORT:num}"),
            Some(("${PORT}".into(), Cast::Num))
        );
        assert_eq!(
            parse_cast_leaf("${FLAG:bool}"),
            Some(("${FLAG}".into(), Cast::Bool))
        );
        assert_eq!(
            parse_cast_leaf("${ZIP:str}"),
            Some(("${ZIP}".into(), Cast::Str))
        );
        // 시스템 토큰도 같은 ${} 문법 → 공짜로 지원.
        assert_eq!(
            parse_cast_leaf("${vu_id:num}"),
            Some(("${vu_id}".into(), Cast::Num))
        );
    }

    #[test]
    fn parse_json_cast_flow_and_env() {
        assert_eq!(
            parse_cast_leaf("{{obj:json}}"),
            Some(("{{obj}}".into(), Cast::Json))
        );
        assert_eq!(
            parse_cast_leaf("${cfg:json}"),
            Some(("${cfg}".into(), Cast::Json))
        );
    }

    #[test]
    fn parse_env_default_is_not_a_cast() {
        // `${VAR:-default}` 기본값 연산자는 캐스트가 아님(키워드 후보에 선행 `-` 잔류).
        assert_eq!(parse_cast_leaf("${PORT:-8080}"), None);
        assert_eq!(parse_cast_leaf("${PORT:-num}"), None);
        // 경계(R3): default가 `:keyword`로 *끝나면* 마지막 콜론이 캐스트로 해석됨
        // (엔진=UI 동일 판정이라 seam 어긋남 없음).
        assert_eq!(
            parse_cast_leaf("${FOO:-bar:num}"),
            Some(("${FOO:-bar}".into(), Cast::Num))
        );
    }

    #[test]
    fn parse_env_rejects_multi_and_mixed() {
        assert_eq!(parse_cast_leaf("${a}${b}"), None); // 다중 토큰
        assert_eq!(parse_cast_leaf("x ${a:num} y"), None); // 혼합(순수 토큰 아님)
    }

    #[test]
    fn coerce_json_parses_any_json_value() {
        assert_eq!(coerce_json("{\"a\":1}"), Some(json!({"a":1})));
        assert_eq!(coerce_json("[1,2,3]"), Some(json!([1, 2, 3])));
        assert_eq!(coerce_json("42"), Some(json!(42)));
        assert_eq!(coerce_json("true"), Some(json!(true)));
        assert_eq!(coerce_json("null"), Some(serde_json::Value::Null)); // 변수 기반 null
        assert_eq!(coerce_json("\"hi\""), Some(json!("hi")));
    }

    #[test]
    fn coerce_json_rejects_invalid() {
        assert_eq!(coerce_json(""), None);
        assert_eq!(coerce_json("abc"), None); // bare word는 유효 JSON 아님
        assert_eq!(coerce_json("30 40"), None); // 후행 토큰
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
