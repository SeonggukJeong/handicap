//! 응답 값 목록 만들기(tui-2b Task 1, spec §2.1) — 순수 함수.

use std::collections::BTreeMap;

use handicap_engine::TracedResponse;
use handicap_engine::extract::{jsonpath_first, jsonpath_is_simple, jsonpath_is_valid, stringify};
use handicap_tui::pick::{
    ListNote, MAX_PATH_BYTES, PickValue, RowKind, Seg, ValueList, segments_to_path, value_list,
};
use handicap_tui::text;

fn resp(status: u16, headers: &[(&str, &str)], body: &str) -> TracedResponse {
    TracedResponse {
        status,
        latency_ms: 1,
        download_ms: None,
        headers: headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect::<BTreeMap<_, _>>(),
        set_cookies: vec![],
        body: body.to_string(),
        body_truncated: false,
    }
}

fn targets(l: &ValueList) -> Vec<String> {
    l.rows.iter().map(|r| r.target()).collect()
}

fn shown(l: &ValueList) -> Vec<String> {
    l.rows.iter().map(|r| r.shown()).collect()
}

fn body_rows(l: &ValueList) -> Vec<String> {
    l.rows
        .iter()
        .filter(|r| matches!(r.kind, RowKind::Body { .. } | RowKind::BodyText))
        .map(|r| r.target())
        .collect()
}

#[test]
fn rows_in_order() {
    let r = resp(
        200,
        &[("content-type", "application/json"), ("a-header", "x")],
        r#"{"b":1,"a":"x","c":{"d":null,"e":[true,2.5]}}"#,
    );
    let l = value_list(&r, false, 128);
    assert_eq!(
        targets(&l),
        [
            "상태코드",
            "헤더 a-header",
            "헤더 content-type",
            "b",
            "a",
            "c.d",
            "c.e[0]",
            "c.e[1]"
        ]
    );
    assert_eq!(
        shown(&l),
        [
            "200",
            "x",
            "application/json",
            "1",
            "\"x\"",
            "null",
            "true",
            "2.5"
        ]
    );
    assert!(l.notes.is_empty());
}

#[test]
fn duplicate_key_last_value_first_position() {
    let l = value_list(&resp(200, &[], r#"{"a":1,"b":2,"a":3}"#), false, 128);
    assert_eq!(body_rows(&l), ["a", "b"]);
    assert_eq!(shown(&l)[1..], ["3", "2"]);
}

#[test]
fn root_scalar_and_empty_containers() {
    let l = value_list(&resp(200, &[], "7"), false, 128);
    assert_eq!(body_rows(&l), ["본문"]);
    match &l.rows[1].kind {
        RowKind::Body { path } => assert_eq!(path, "$"),
        k => panic!("{k:?}"),
    }
    assert_eq!(l.rows[1].shown(), "7");

    let l = value_list(&resp(200, &[], r#""hello""#), false, 128);
    assert_eq!(body_rows(&l), ["본문"]);
    assert_eq!(l.rows[1].shown(), "\"hello\"");

    for b in ["{}", "[]", r#"{"a":{},"b":[]}"#] {
        let l = value_list(&resp(200, &[], b), false, 128);
        assert!(body_rows(&l).is_empty(), "{b}");
        assert!(
            !targets(&l).contains(&text::COND_TARGET_BODY_TEXT.to_string()),
            "{b}"
        );
        assert!(l.notes.is_empty(), "{b}");
    }
}

fn nested_arrays(n: usize, inner: &str) -> String {
    format!("{}{}{}", "[".repeat(n), inner, "]".repeat(n))
}

#[test]
fn body_table() {
    // 1: 본문 없음
    let l = value_list(&resp(200, &[], ""), false, 128);
    assert!(body_rows(&l).is_empty());
    assert!(l.notes.is_empty());

    // 2: 엔진이 자름 — 본문 전체 없음
    let mut r = resp(200, &[], r#"{"a":1}"#);
    r.body_truncated = true;
    let l = value_list(&r, false, 128);
    assert!(body_rows(&l).is_empty());
    assert_eq!(l.notes, [ListNote::EngineTruncated]);
    // 2행이 3행을 이긴다
    let l = value_list(&r, true, 128);
    assert!(body_rows(&l).is_empty());
    assert_eq!(l.notes, [ListNote::EngineTruncated]);
    // 빈 본문이라도 엔진이 잘랐으면 2행
    let mut r2 = resp(200, &[], "");
    r2.body_truncated = true;
    let l = value_list(&r2, false, 128);
    assert!(body_rows(&l).is_empty());
    assert_eq!(l.notes, [ListNote::EngineTruncated]);

    // 3: 기록 상한에 잘림
    let l = value_list(&resp(200, &[], r#"{"a":"#), true, 128);
    assert_eq!(body_rows(&l), ["본문 전체"]);
    assert_eq!(l.notes, [ListNote::Clipped(128)]);
    let l = value_list(&resp(200, &[], ""), true, 128);
    assert_eq!(body_rows(&l), ["본문 전체"]);
    assert_eq!(l.notes, [ListNote::Clipped(128)]);
    assert_eq!(l.notes[0].text(), text::record_clipped(128));

    // 4: 64KB 초과
    let big = format!(r#"{{"a":"{}"}}"#, "x".repeat(65 * 1024));
    let l = value_list(&resp(200, &[], &big), false, 128);
    assert_eq!(body_rows(&l), ["본문 전체"]);
    assert_eq!(l.notes, [ListNote::TooLarge]);

    // 5: JSON 아님
    let l = value_list(&resp(200, &[], "not json"), false, 128);
    assert_eq!(body_rows(&l), ["본문 전체"]);
    assert!(l.notes.is_empty());
    assert_eq!(l.rows.last().unwrap().kind, RowKind::BodyText);
    assert_eq!(l.rows.last().unwrap().value, PickValue::BodyText);
    assert_eq!(l.rows.last().unwrap().shown(), text::PICK_BODY_TEXT_VALUE);

    // 6: 너무 깊음 — 65단은 안 되고 64단은 된다
    let l = value_list(&resp(200, &[], &nested_arrays(65, "1")), false, 128);
    assert_eq!(body_rows(&l), ["본문 전체"]);
    assert_eq!(l.notes, [ListNote::TooDeep]);
    let l = value_list(&resp(200, &[], &nested_arrays(64, "1")), false, 128);
    assert_eq!(body_rows(&l).len(), 1);
    assert_ne!(body_rows(&l), ["본문 전체"]);
    assert!(l.notes.is_empty());
    // serde 재귀 상한(128단)을 넘는 본문도 6행
    let l = value_list(&resp(200, &[], &nested_arrays(200, "1")), false, 128);
    assert_eq!(body_rows(&l), ["본문 전체"]);
    assert_eq!(l.notes, [ListNote::TooDeep]);

    // 7: 경로 글자 합계 초과 — 3만 자 키 아래 숫자 배열(본문은 64KB 이하)
    let long_key = "k".repeat(30_000);
    let nums = vec!["0"; 16_000].join(",");
    let b = format!(r#"{{"{long_key}":[{nums}]}}"#);
    assert!(b.len() <= 64 * 1024);
    let l = value_list(&resp(200, &[], &b), false, 128);
    assert_eq!(body_rows(&l), ["본문 전체"]);
    assert_eq!(l.notes, [ListNote::TooManyPaths]);
    assert_eq!(l.rows.len(), 2); // 코드 + 본문 전체
    assert_eq!(l.notes[0].text(), text::PICK_TOO_MANY_PATHS);
    // 같은 꼴, 합계가 한도 아래 — 값 줄들·안내 없음
    let key100 = "k".repeat(100);
    let nums = vec!["0"; 1000].join(",");
    let b = format!(r#"{{"{key100}":[{nums}]}}"#);
    let l = value_list(&resp(200, &[], &b), false, 128);
    assert_eq!(body_rows(&l).len(), 1000);
    assert!(l.notes.is_empty());
    // 경계: 원소 1000개, 키 길이 L → 경로 합계 = 1000L + 6890
    let nums = vec!["0"; 1000].join(",");
    let sum = |len: usize| 1000 * len + 6890;
    let fit = (MAX_PATH_BYTES - 6890) / 1000;
    assert!(sum(fit) <= MAX_PATH_BYTES && sum(fit + 1) > MAX_PATH_BYTES);
    let b = format!(r#"{{"{}":[{nums}]}}"#, "k".repeat(fit));
    let l = value_list(&resp(200, &[], &b), false, 128);
    assert_eq!(body_rows(&l).len(), 1000);
    assert!(l.notes.is_empty());
    let b = format!(r#"{{"{}":[{nums}]}}"#, "k".repeat(fit + 1));
    let l = value_list(&resp(200, &[], &b), false, 128);
    assert_eq!(body_rows(&l), ["본문 전체"]);
    assert_eq!(l.notes, [ListNote::TooManyPaths]);
}

fn wrap(s: &str, layers: usize) -> String {
    let mut cur = s.to_string();
    for _ in 0..layers {
        cur = serde_json::to_string(&cur).unwrap();
    }
    cur
}

#[test]
fn unwrap_rules() {
    // 뿌리: body 자체가 1·2·3겹 감싼 JSON
    for layers in 1..=3 {
        let b = wrap(r#"{"a":1}"#, layers);
        let l = value_list(&resp(200, &[], &b), false, 128);
        assert_eq!(body_rows(&l), ["a"], "layers={layers}");
        assert_eq!(l.notes, [ListNote::Unwrapped], "layers={layers}");
    }
    // 4겹은 풀지 않는다 — 뿌리 스칼라(문자열) 한 줄
    let l = value_list(&resp(200, &[], &wrap(r#"{"a":1}"#, 4)), false, 128);
    assert_eq!(body_rows(&l), ["본문"]);
    assert!(l.notes.is_empty());

    // 필드
    let l = value_list(&resp(200, &[], r#"{"p":"{\"id\":7}"}"#), false, 128);
    assert_eq!(body_rows(&l), ["p.id"]);
    assert_eq!(l.rows.last().unwrap().shown(), "7");
    assert_eq!(l.notes, [ListNote::Unwrapped]);
    // 필드 2겹
    let inner = wrap(r#"{"id":7}"#, 2);
    let b = format!(r#"{{"p":{}}}"#, serde_json::to_string(&inner).unwrap());
    let l = value_list(&resp(200, &[], &b), false, 128);
    assert_eq!(body_rows(&l), ["p.id"]);

    // 풀리지 않는 문자열
    for b in [r#"{"p":"plain {"}"#, r#"{"p":"  [1"}"#, r#"{"p":"7"}"#] {
        let l = value_list(&resp(200, &[], b), false, 128);
        assert_eq!(body_rows(&l), ["p"], "{b}");
        assert!(l.notes.is_empty(), "{b}");
    }

    // 풀기 포함 깊이 상한
    let b = nested_arrays(63, r#""[[[1]]]""#);
    let l = value_list(&resp(200, &[], &b), false, 128);
    assert_eq!(body_rows(&l), ["본문 전체"]);
    assert_eq!(l.notes, [ListNote::TooDeep]);
    // 정확한 경계: 62단 + 3단 = 65는 초과
    let b = nested_arrays(62, r#""[[[1]]]""#);
    let l = value_list(&resp(200, &[], &b), false, 128);
    assert_eq!(body_rows(&l), ["본문 전체"]);
    assert_eq!(l.notes, [ListNote::TooDeep]);
    // 한 단 모자라면 된다(61단 + 3단 = 64)
    let b = nested_arrays(61, r#""[[[1]]]""#);
    let l = value_list(&resp(200, &[], &b), false, 128);
    assert_eq!(body_rows(&l).len(), 1);
    assert_ne!(body_rows(&l), ["본문 전체"]);
}

#[test]
fn paths_match_gui_shape() {
    // ui/src/scenario/jsonPath.ts `segmentsToPath`(24–32행) + `escapeBracketKey`(10–21행) 대조표.
    // IDENT_RE(4행) = /^[A-Za-z_][A-Za-z0-9_]*$/ — ASCII만 식별자.
    let k = |s: &str| Seg::Key(s.to_string());
    let cases: Vec<(Vec<Seg>, &str)> = vec![
        (vec![k("a")], "$.a"),
        (vec![k("a_1"), Seg::Index(0)], "$.a_1[0]"),
        (vec![k("1a")], "$['1a']"),
        (vec![k("a.b")], "$['a.b']"),
        (vec![k("it's")], "$['it\\'s']"),
        (vec![k("a\\b")], "$['a\\\\b']"),
        (vec![k("\u{1f}")], "$['\\u001f']"),
        (vec![k("")], "$['']"),
        (vec![k("한글")], "$['한글']"),
        (vec![], "$"),
    ];
    for (segs, want) in cases {
        assert_eq!(segments_to_path(&segs), want, "{segs:?}");
    }
}

/// 서버(`check.rs` `parse_body_json`·`unwrap_json_str`·`BodyJson::path_first`) 규칙을 다시 적은 것.
fn server_unwrap_str(s: &str) -> Option<serde_json::Value> {
    use serde_json::Value;
    let head = s.trim_start_matches([' ', '\t', '\n', '\r']);
    if !head.starts_with(['{', '[', '"']) {
        return None;
    }
    let mut cur = s.to_owned();
    for _ in 0..3 {
        match serde_json::from_str::<Value>(&cur) {
            Ok(v) if v.is_object() || v.is_array() => return Some(v),
            Ok(Value::String(next)) => cur = next,
            _ => return None,
        }
    }
    None
}

fn unwrap_all(v: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::String(s) => match server_unwrap_str(s) {
            Some(inner) => unwrap_all(&inner),
            None => v.clone(),
        },
        Value::Array(a) => Value::Array(a.iter().map(unwrap_all).collect()),
        Value::Object(o) => {
            Value::Object(o.iter().map(|(k, x)| (k.clone(), unwrap_all(x))).collect())
        }
        other => other.clone(),
    }
}

fn count_leaves(v: &serde_json::Value) -> usize {
    use serde_json::Value;
    match v {
        Value::Array(a) => a.iter().map(count_leaves).sum(),
        Value::Object(o) => o.values().map(count_leaves).sum(),
        _ => 1,
    }
}

fn server_nested(body: &str) -> serde_json::Value {
    let first: serde_json::Value = serde_json::from_str(body).unwrap();
    let shallow = match &first {
        serde_json::Value::String(s0) => server_unwrap_str(s0).unwrap_or_else(|| first.clone()),
        _ => first.clone(),
    };
    unwrap_all(&shallow)
}

fn server_find(body: &str, path: &str) -> Option<serde_json::Value> {
    let first: serde_json::Value = serde_json::from_str(body).ok()?;
    let shallow = match &first {
        serde_json::Value::String(s0) => server_unwrap_str(s0).unwrap_or_else(|| first.clone()),
        _ => first.clone(),
    };
    let nested = unwrap_all(&shallow);
    jsonpath_first(&shallow, path).or_else(|| jsonpath_first(&nested, path))
}

#[test]
fn every_path_resolves_like_server() {
    let wrapped_root = wrap(r#"{"id":7,"s":"x","n":null}"#, 2);
    let wrapped_field = format!(
        r#"{{"p":{},"q":[{}]}}"#,
        serde_json::to_string(r#"{"k":"v","l":[1,2],"it's":true}"#).unwrap(),
        serde_json::to_string(r#"{"deep":{"x":1.5}}"#).unwrap()
    );
    let bodies: Vec<String> = vec![
        r#"{"a":1,"b_2":"two","_c":true,"d":null}"#.into(),
        r#"{"a.b":1,"a b":2,"it's":3,"say \"hi\"":4,"back\\slash":5}"#.into(),
        r#"{"ctl\u001f":1,"nl\n":2,"tab\t":3,"\u0000":4}"#.into(),
        r#"{"한글":"값","":"empty key","1a":2,"a-b":3,"$":4}"#.into(),
        r#"[1,[2,[3,{"x":[4,5]}]],"s",null,false]"#.into(),
        r#"{"a":{"b":{"c":[{"d":1},{"d":2}]}}}"#.into(),
        r#"{"a":1,"a":2,"b":{"c":1,"c":3}}"#.into(),
        wrapped_root,
        wrapped_field,
        r#"{"data":{"items":[{"sku":"A-100","qty":3}],"queue":12}}"#.into(),
        r#"{"[0]":1,"['x']":2,"a[0]":3,"..":4,"*":5}"#.into(),
        r#""just a string""#.into(),
        "42".into(),
    ];
    for b in &bodies {
        let l = value_list(&resp(200, &[], b), false, 128);
        let mut seen = 0;
        for row in &l.rows {
            let RowKind::Body { path } = &row.kind else {
                continue;
            };
            seen += 1;
            assert!(jsonpath_is_simple(path), "not simple: {path:?} in {b}");
            assert!(jsonpath_is_valid(path), "not valid: {path:?} in {b}");
            let found = server_find(b, path)
                .unwrap_or_else(|| panic!("server finds nothing at {path:?} in {b}"));
            let got = stringify(&found);
            match &row.value {
                PickValue::Str(s) => assert_eq!(&got, s, "{path:?} in {b}"),
                PickValue::Null => assert_eq!(got, "", "{path:?} in {b}"),
                PickValue::Bool(v) => assert_eq!(got, v.to_string(), "{path:?} in {b}"),
                PickValue::Number(n) => {
                    assert_eq!(
                        got.parse::<f64>().unwrap(),
                        n.parse::<f64>().unwrap(),
                        "{path:?} in {b}"
                    );
                }
                other => panic!("unexpected value {other:?}"),
            }
        }
        assert!(seen > 0, "no body rows for {b}");
        assert_eq!(
            seen,
            count_leaves(&server_nested(b)),
            "leaf count differs in {b}"
        );
    }
}

/// 성질 테스트가 공허해지지 않게 — 감싼 JSON 안쪽 경로가 실제로 목록에 나온다.
#[test]
fn property_fixtures_include_unwrapped_paths() {
    let field = format!(
        r#"{{"q":[{}]}}"#,
        serde_json::to_string(r#"{"deep":{"x":1.5}}"#).unwrap()
    );
    let l = value_list(&resp(200, &[], &field), false, 128);
    let paths: Vec<&str> = l
        .rows
        .iter()
        .filter_map(|r| match &r.kind {
            RowKind::Body { path } => Some(path.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(paths, ["$.q[0].deep.x"]);
    assert_eq!(
        server_find(&field, "$.q[0].deep.x"),
        Some(serde_json::json!(1.5))
    );
}

#[test]
fn debug_hides_values() {
    let l = value_list(
        &resp(200, &[("x-secret", "TOKEN123")], r#"{"k":"BODYSECRET"}"#),
        false,
        128,
    );
    let d = format!("{l:?}");
    for s in ["TOKEN123", "BODYSECRET", "x-secret", "$.k"] {
        assert!(!d.contains(s), "{s} leaked in {d}");
    }
    assert!(d.contains('3'), "row count missing: {d}");
    for row in &l.rows {
        let d = format!("{row:?}");
        for s in ["TOKEN123", "BODYSECRET", "x-secret", "$.k"] {
            assert!(!d.contains(s), "{s} leaked in {d}");
        }
        let d = format!("{:?}", row.value);
        for s in ["TOKEN123", "BODYSECRET"] {
            assert!(!d.contains(s), "{s} leaked in {d}");
        }
    }
}
