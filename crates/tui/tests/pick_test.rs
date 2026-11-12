//! 응답 값 목록 만들기(tui-2b Task 1, spec §2.1) — 순수 함수.

use std::collections::BTreeMap;

use handicap_controller::monitor::config::{
    Condition, ConditionOp, ConditionSource, DisplayItem, DisplaySource, PanelConfig,
};
use handicap_engine::extract::{jsonpath_first, jsonpath_is_simple, jsonpath_is_valid, stringify};
use handicap_engine::{ScenarioTrace, StepKind, StepTrace, TracedResponse};
use handicap_tui::inspect::{StepLine, sanitize};
use handicap_tui::names::Names;
use handicap_tui::pick::{
    AUTH_HEADERS, Blocked, Draft, Hint, ListNote, MAX_PATH_BYTES, PickValue, RowKind, Seg,
    ValueList, ValueRow, ValuesState, auto_target, cond_block, default_condition, display_block,
    display_full, display_item, is_auth_header, is_secret_name, marks, open_values,
    segments_to_path, value_list,
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

    // 7: 경로 글자 합계 — 경계 케이스를 먼저(상한 판정이 사라지면 아래 3만 자 케이스에서 멈추기 전에 여기서 RED)
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
    // 같은 꼴, 합계가 한도 아래 — 값 줄들·안내 없음
    let key100 = "k".repeat(100);
    let nums = vec!["0"; 1000].join(",");
    let b = format!(r#"{{"{key100}":[{nums}]}}"#);
    let l = value_list(&resp(200, &[], &b), false, 128);
    assert_eq!(body_rows(&l).len(), 1000);
    assert!(l.notes.is_empty());
    // 3만 자 키 아래 숫자 배열(본문은 64KB 이하)
    let long_key = "k".repeat(30_000);
    let nums = vec!["0"; 16_000].join(",");
    let b = format!(r#"{{"{long_key}":[{nums}]}}"#);
    assert!(b.len() <= 64 * 1024);
    let l = value_list(&resp(200, &[], &b), false, 128);
    assert_eq!(body_rows(&l), ["본문 전체"]);
    assert_eq!(l.notes, [ListNote::TooManyPaths]);
    assert_eq!(l.rows.len(), 2); // 코드 + 본문 전체
    assert_eq!(l.notes[0].text(), text::PICK_TOO_MANY_PATHS);
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
        (vec![k("a\u{202E}b")], "$['a\\u202eb']"),
        (vec![k("a\u{2028}b")], "$['a\\u2028b']"),
        (vec![k("a\u{85}b")], "$['a\\u0085b']"),
        (vec![k("a\u{7F}b")], "$['a\\u007fb']"),
        (vec![k("a\u{2066}b")], "$['a\\u2066b']"),
        (vec![k("a\u{200D}b")], "$['a\u{200D}b']"),
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

// ---------- Task 2: 기본 조건·막힘·표지·값 목록 상태 ----------

const SC: &str = r#"
version: 1
name: 흐름
steps:
  - { id: "01J00000000000000000000A01", name: 로그인, type: http, request: { method: GET, url: "/a" }, assert: [] }
  - { id: "01J00000000000000000000A02", name: 조회, type: http, request: { method: GET, url: "/b" }, assert: [] }
"#;
const A: &str = "01J00000000000000000000A01";
const B: &str = "01J00000000000000000000A02";

fn names() -> Names {
    let b = serde_json::json!({
        "format": "handicap-bundle", "format_version": 1, "boards": [],
        "scenarios": [{ "id": "S1", "yaml": SC }],
        "environments": []
    });
    Names::from_bundle(&serde_json::to_vec(&b).unwrap())
}

fn row(kind: RowKind, value: PickValue) -> ValueRow {
    ValueRow {
        kind,
        value,
        secret_name: false,
    }
}
fn hdr(name: &str, v: &str) -> ValueRow {
    row(
        RowKind::Header { name: name.into() },
        PickValue::Header(v.into()),
    )
}
fn body(path: &str, v: PickValue) -> ValueRow {
    row(RowKind::Body { path: path.into() }, v)
}
fn st(s: &str) -> PickValue {
    PickValue::Str(s.into())
}

/// `ui/src/monitor/conditions.ts` `defaultCondition`(190행~)과 같은 표.
#[test]
fn default_condition_table() {
    let d = default_condition(A, &row(RowKind::Status, PickValue::Status(200)));
    assert_eq!(d.cond.source, ConditionSource::Status);
    assert_eq!(d.cond.path, "");
    assert_eq!(d.cond.op, ConditionOp::Eq);
    assert_eq!(d.cond.value, "200");
    assert_eq!(d.hint, None);
    assert!(!d.focus_value);

    let x40 = "x".repeat(40);
    type Case<'a> = (
        ValueRow,
        ConditionSource,
        &'a str,
        ConditionOp,
        &'a str,
        Option<Hint>,
    );
    let all: Vec<Case> = vec![
        (
            body("$.a", PickValue::Null),
            ConditionSource::Body,
            "$.a",
            ConditionOp::Exists,
            "",
            None,
        ),
        (
            body("$.a", PickValue::Number("7".into())),
            ConditionSource::Body,
            "$.a",
            ConditionOp::Eq,
            "7",
            None,
        ),
        (
            body("$.a", PickValue::Bool(true)),
            ConditionSource::Body,
            "$.a",
            ConditionOp::Eq,
            "true",
            None,
        ),
        (
            body("$.a", st(&"x".repeat(40))),
            ConditionSource::Body,
            "$.a",
            ConditionOp::Eq,
            &x40,
            None,
        ),
        (
            body("$.a", st(&"x".repeat(41))),
            ConditionSource::Body,
            "$.a",
            ConditionOp::NotEmpty,
            "",
            Some(Hint::Volatile),
        ),
        (
            body("$.a", st("")),
            ConditionSource::Body,
            "$.a",
            ConditionOp::Eq,
            "",
            None,
        ),
        (
            hdr("x-id", "abc"),
            ConditionSource::Header,
            "x-id",
            ConditionOp::Eq,
            "abc",
            None,
        ),
        (
            hdr("x-id", &"h".repeat(41)),
            ConditionSource::Header,
            "x-id",
            ConditionOp::NotEmpty,
            "",
            Some(Hint::Volatile),
        ),
    ];
    for (r, src, path, op, val, hint) in all {
        let d = default_condition(B, &r);
        assert_eq!(d.cond.step_id, B);
        assert_eq!(d.cond.source, src, "{r:?}");
        assert_eq!(d.cond.path, path, "{r:?}");
        assert_eq!(d.cond.op, op, "{r:?}");
        assert_eq!(d.cond.value, val, "{r:?}");
        assert_eq!(d.hint, hint, "{r:?}");
        assert!(!d.cond.ignore_case && !d.cond.trim);
        assert!(!d.focus_value);
    }

    let d: Draft = default_condition(A, &row(RowKind::BodyText, PickValue::BodyText));
    assert_eq!(d.cond.source, ConditionSource::BodyText);
    assert_eq!(d.cond.path, "");
    assert_eq!(d.cond.op, ConditionOp::Contains);
    assert_eq!(d.cond.value, "");
    assert_eq!(d.hint, None);
    assert!(d.focus_value);
}

/// spec §2.4 ★ 두 행 — GUI와 일부러 다르다.
#[test]
fn default_condition_deviations() {
    for name in [
        "set-cookie",
        " Authorization ",
        "COOKIE",
        "proxy-authorization",
    ] {
        let d = default_condition(A, &hdr(name, "sid=••••"));
        assert_eq!(d.cond.op, ConditionOp::NotEmpty, "{name}");
        assert_eq!(d.cond.value, "", "{name}");
        assert_eq!(d.hint, Some(Hint::Masked), "{name}");
    }
    let d = default_condition(A, &hdr("authorization", &"•".repeat(60)));
    assert_eq!(d.hint, Some(Hint::Masked));
    for v in ["a\nb", "a\u{202e}b", "a\u{85}b"] {
        let d = default_condition(A, &body("$.a", st(v)));
        assert_eq!(d.cond.op, ConditionOp::NotEmpty, "{v:?}");
        assert_eq!(d.cond.value, "");
        assert_eq!(d.hint, Some(Hint::Volatile));
    }
}

#[test]
fn display_block_order() {
    let item = |src, path: &str, step: &str| DisplayItem {
        step_id: step.into(),
        source: src,
        path: path.into(),
    };
    let panel = |items: Vec<DisplayItem>| PanelConfig {
        scenario_id: "S1".into(),
        display_items: items,
        ..Default::default()
    };
    let target = item(DisplaySource::Body, "$.a", A);
    // 2개가 가장 먼저 — 같은 대상·인증 헤더보다도
    let full = panel(vec![target.clone(), item(DisplaySource::Body, "$.b", A)]);
    assert_eq!(display_block(&full, &target), Some(text::DISPLAY_MAX));
    let auth = item(DisplaySource::Header, "Authorization", A);
    assert_eq!(display_block(&full, &auth), Some(text::DISPLAY_MAX));
    // 1개(같은 대상) → 중복
    let one = panel(vec![target.clone()]);
    assert_eq!(display_block(&one, &target), Some(text::DISPLAY_DUP));
    // 인증 헤더
    assert_eq!(display_block(&one, &auth), Some(text::DISPLAY_AUTH_HEADER));
    // 같은 경로·다른 스텝은 중복 아님, 0개·보통 값은 None
    assert_eq!(
        display_block(&one, &item(DisplaySource::Body, "$.a", B)),
        None
    );
    assert_eq!(display_block(&panel(vec![]), &target), None);
    // 같은 대상이면서 인증 헤더 → 중복이 먼저
    let dup_auth = panel(vec![auth.clone()]);
    assert_eq!(display_block(&dup_auth, &auth), Some(text::DISPLAY_DUP));

    let conds = |n: usize| PanelConfig {
        conditions: vec![Condition::default(); n],
        ..Default::default()
    };
    assert_eq!(cond_block(&conds(9)), None);
    assert_eq!(cond_block(&conds(10)), Some(text::COND_MAX));
    // 하위 목록 12번 `a`가 쓰는 개수 판정 — `display_block`의 첫 갈래와 같은 함수.
    let disp = |n: usize| PanelConfig {
        display_items: vec![DisplayItem::default(); n],
        ..Default::default()
    };
    assert_eq!(display_full(&disp(1)), None);
    assert_eq!(display_full(&disp(2)), Some(text::DISPLAY_MAX));

    assert_eq!(
        display_item(A, &row(RowKind::BodyText, PickValue::BodyText)),
        None
    );
    let di = display_item(A, &hdr("x-id", "v")).unwrap();
    assert_eq!(di.source, DisplaySource::Header);
    assert_eq!(di.path, "x-id");
    assert_eq!(di.step_id, A);
    let di = display_item(A, &row(RowKind::Status, PickValue::Status(200))).unwrap();
    assert_eq!(di.source, DisplaySource::Status);
    assert_eq!(di.path, "");
    let di = display_item(A, &body("$.q", PickValue::Null)).unwrap();
    assert_eq!(di.source, DisplaySource::Body);
    assert_eq!(di.path, "$.q");
}

#[test]
fn marks_counts() {
    let c = |step: &str, src, path: &str| Condition {
        step_id: step.into(),
        source: src,
        path: path.into(),
        ..Default::default()
    };
    let mut p = PanelConfig::default();
    let r = body("$.a", PickValue::Number("1".into()));
    assert_eq!(marks(&p, A, &r), (0, false));
    p.conditions.push(c(A, ConditionSource::Body, "$.a"));
    assert_eq!(marks(&p, A, &r), (1, false));
    p.conditions.push(c(A, ConditionSource::Body, "$.a"));
    assert_eq!(marks(&p, A, &r), (2, false));
    // 다른 스텝·다른 대상·다른 source는 세지 않는다
    p.conditions.push(c(B, ConditionSource::Body, "$.a"));
    p.conditions.push(c(A, ConditionSource::Body, "$.b"));
    p.conditions.push(c(A, ConditionSource::Header, "$.a"));
    assert_eq!(marks(&p, A, &r), (2, false));
    p.display_items.push(DisplayItem {
        step_id: A.into(),
        source: DisplaySource::Body,
        path: "$.a".into(),
    });
    assert_eq!(marks(&p, A, &r), (2, true));
    assert_eq!(marks(&p, B, &r), (1, false));
    // 헤더는 이름 글자 그대로
    let h = hdr("X-Id", "v");
    p.conditions.push(c(A, ConditionSource::Header, "X-Id"));
    assert_eq!(marks(&p, A, &h), (1, false));
    assert_eq!(marks(&p, A, &hdr("x-id", "v")), (0, false));
    // 응답 코드·본문 전체
    p.conditions.push(c(A, ConditionSource::Status, ""));
    p.conditions.push(c(A, ConditionSource::BodyText, ""));
    assert_eq!(
        marks(&p, A, &row(RowKind::Status, PickValue::Status(200))),
        (1, false)
    );
    assert_eq!(
        marks(&p, A, &row(RowKind::BodyText, PickValue::BodyText)),
        (1, false)
    );
}

fn http_step(id: &str, status: Option<u16>) -> StepTrace {
    StepTrace {
        step_id: id.into(),
        kind: StepKind::Http,
        loop_index: None,
        branch: None,
        request: None,
        response: status.map(|s| resp(s, &[], r#"{"k":1}"#)),
        extracted: BTreeMap::new(),
        unbound_vars: vec![],
        error: None,
        branch_eval: vec![],
        timed_out: false,
    }
}
fn trace(steps: Vec<StepTrace>) -> ScenarioTrace {
    ScenarioTrace {
        ok: true,
        total_ms: 1,
        steps,
        final_vars: BTreeMap::new(),
        truncated: false,
        error: None,
    }
}

#[test]
fn open_values_rules() {
    let n = names();
    let flow = PanelConfig {
        scenario_id: "S1".into(),
        ..Default::default()
    };
    let t = trace(vec![http_step(A, Some(200)), http_step(B, Some(200))]);
    // 흐름 전체 칸 — 아무 스텝이나
    let v = open_values(&flow, &t, 1, false, 128, &n);
    assert_eq!(v.step_id, B);
    assert!(v.blocked.is_none());
    assert!(!v.list.rows.is_empty());
    assert_eq!(v.cursor, 0);

    // 스텝 칸(묶음 아님) + 다른 스텝 → 막힘, 줄 0개, 이름 해석
    let step_panel = PanelConfig {
        scenario_id: "S1".into(),
        step_id: Some(A.into()),
        ..Default::default()
    };
    let v = open_values(&step_panel, &t, 1, false, 128, &n);
    match &v.blocked {
        Some(Blocked::OtherStep { name }) => assert_eq!(name, "로그인"),
        o => panic!("{o:?}"),
    }
    assert!(v.list.rows.is_empty());
    assert_eq!(
        v.blocked.as_ref().unwrap().text(),
        text::pick_other_step("로그인")
    );
    // 이름을 못 찾으면 id
    let unknown = PanelConfig {
        scenario_id: "S1".into(),
        step_id: Some("ZZZ".into()),
        ..Default::default()
    };
    match open_values(&unknown, &t, 0, false, 128, &n).blocked {
        Some(Blocked::OtherStep { name }) => assert_eq!(name, "ZZZ"),
        o => panic!("{o:?}"),
    }
    // 같은 스텝이면 열림
    let v = open_values(&step_panel, &t, 0, false, 128, &n);
    assert!(v.blocked.is_none());
    assert_eq!(v.step_id, A);
    // 묶음 칸도 같다
    let mut grp = step_panel.clone();
    grp.group_id = Some("G".into());
    assert!(open_values(&grp, &t, 1, false, 128, &n).blocked.is_some());

    // trace_idx가 범위 밖이면 응답 없음 취급
    let v = open_values(&flow, &t, 99, false, 128, &n);
    assert_eq!(v.blocked, Some(Blocked::NoResponse));
    assert!(v.list.rows.is_empty());

    // 응답 없음
    let t2 = trace(vec![http_step(A, None)]);
    let v = open_values(&flow, &t2, 0, false, 128, &n);
    assert_eq!(v.blocked, Some(Blocked::NoResponse));
    assert!(v.list.rows.is_empty());
    assert_eq!(v.blocked.as_ref().unwrap().text(), text::PICK_NO_RESPONSE);

    // 뒤에 같은 스텝이 또 실행됨 → 앞 실행에만 LaterRun
    let mut ift = http_step("IF1", None);
    ift.kind = StepKind::If;
    let t3 = trace(vec![http_step(A, Some(200)), ift, http_step(A, Some(500))]);
    let v = open_values(&flow, &t3, 0, false, 128, &n);
    assert_eq!(v.list.notes.first(), Some(&ListNote::LaterRun));
    let v = open_values(&flow, &t3, 2, false, 128, &n);
    assert!(!v.list.notes.contains(&ListNote::LaterRun));
    // If 줄은 세지 않는다 — 뒤에 같은 id의 If 줄만 있으면 LaterRun 아님
    let mut if_same = http_step(A, None);
    if_same.kind = StepKind::If;
    let t4 = trace(vec![http_step(A, Some(200)), if_same]);
    let v = open_values(&flow, &t4, 0, false, 128, &n);
    assert!(!v.list.notes.contains(&ListNote::LaterRun));
}

#[test]
fn values_state_debug_hides_values() {
    let n = names();
    let mut t = trace(vec![http_step(A, Some(200))]);
    t.steps[0].response = Some(resp(
        200,
        &[("x-secret", "TOKEN123")],
        r#"{"k":"BODYSECRET"}"#,
    ));
    let flow = PanelConfig {
        scenario_id: "S1".into(),
        ..Default::default()
    };
    let v = open_values(&flow, &t, 0, false, 128, &n);
    let d = format!("{v:?}");
    for s in ["TOKEN123", "BODYSECRET", "x-secret", "$.k"] {
        assert!(!d.contains(s), "{s} leaked in {d}");
    }
    let step_panel = PanelConfig {
        scenario_id: "S1".into(),
        step_id: Some(B.into()),
        ..Default::default()
    };
    let d = format!("{:?}", open_values(&step_panel, &t, 0, false, 128, &n));
    assert!(!d.contains("TOKEN123"));
    // 스텝 칸(막힘) — 스텝 이름도 새지 않는다.
    let t2 = trace(vec![http_step(A, Some(200)), http_step(B, Some(200))]);
    let step_a = PanelConfig {
        scenario_id: "S1".into(),
        step_id: Some(A.into()),
        ..Default::default()
    };
    let blocked = open_values(&step_a, &t2, 1, false, 128, &n);
    match &blocked.blocked {
        Some(Blocked::OtherStep { name }) => assert_eq!(name, "로그인"),
        o => panic!("{o:?}"),
    }
    let d = format!("{blocked:?}");
    assert!(!d.contains("로그인"), "step name leaked in {d}");
}

#[test]
fn draft_debug_hides_values() {
    let d = default_condition("A", &hdr("x-id", "TOKEN123"));
    let s = format!("{d:?}");
    for leak in ["TOKEN123", "x-id"] {
        assert!(!s.contains(leak), "{leak} leaked in {s}");
    }
    let d = default_condition("A", &body("$.secretpath", st("BODYSECRET")));
    let s = format!("{d:?}");
    for leak in ["BODYSECRET", "secretpath"] {
        assert!(!s.contains(leak), "{leak} leaked in {s}");
    }
}

#[test]
fn auth_headers_match_controller() {
    let src = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../controller/src/monitor/config.rs"
    ))
    .unwrap();
    let start = src.find("const AUTH_HEADERS").expect("AUTH_HEADERS");
    let end = start + src[start..].find("];").unwrap();
    let block = &src[start..end];
    let mut found: Vec<String> = Vec::new();
    let mut parts = block.split('"');
    parts.next();
    while let Some(lit) = parts.next() {
        found.push(lit.to_string());
        parts.next();
    }
    found.sort();
    let mut mine: Vec<String> = AUTH_HEADERS.iter().map(|s| s.to_string()).collect();
    mine.sort();
    assert_eq!(found, mine);
    assert!(is_auth_header("  Set-Cookie "));
    assert!(!is_auth_header("x-id"));
}

fn list_of(rows: Vec<ValueRow>) -> ValueList {
    ValueList {
        rows,
        notes: Vec::new(),
    }
}

#[test]
fn values_state_texts() {
    let rows = vec![
        row(RowKind::Status, PickValue::Status(200)),
        hdr("한글한글한글", "a\u{1b}[31mb"),
        body("data.k", st("v\u{202e}w")),
    ];
    let state = ValuesState::new("S".into(), list_of(rows.clone()), None);
    assert_eq!(state.cursor, 0);
    assert_eq!(state.texts.len(), rows.len());
    for (t, r) in state.texts.iter().zip(&rows) {
        assert_eq!(t.target(), sanitize(&r.target()));
        assert_eq!(t.shown(), sanitize(&r.shown()));
    }
    assert!(state.texts[1].shown().contains('\u{FFFD}'));
    // 가장 넓은 대상 = `헤더 한글한글한글`(4 + 1 + 12 = 17칸) — 손 계산.
    assert_eq!(state.texts[1].target(), "헤더 한글한글한글");
    assert_eq!(state.target_width, 17);
    // 화면 폭 함수와 같은 결과.
    let by_view = state
        .texts
        .iter()
        .map(|t| ratatui::text::Span::raw(t.target().to_string()).width())
        .max();
    assert_eq!(Some(state.target_width), by_view);
    // 막힘 — 줄 없음.
    let blocked = ValuesState::new("S".into(), list_of(Vec::new()), Some(Blocked::NoResponse));
    assert!(blocked.texts.is_empty());
    assert_eq!(blocked.target_width, 0);
    let ro = ValuesState::new("S".into(), list_of(rows), Some(Blocked::NoResponse));
    assert!(ro.texts.is_empty() && ro.target_width == 0);
}

// ---------- tui-2b Task 7: 칸 설정 11·12의 `a` — 값 목록을 곧바로 열 줄(spec §2.7) ----------

fn hl(trace_idx: usize, loop_index: Option<u32>, focus: bool) -> StepLine {
    StepLine::Http {
        trace_idx,
        no: trace_idx + 1,
        loop_index,
        name: format!("s{trace_idx}"),
        method: None,
        url: None,
        status: Some(200),
        latency_ms: Some(1),
        error: None,
        timed_out: false,
        focus,
    }
}

fn if_line() -> StepLine {
    StepLine::If {
        branch: "then".into(),
    }
}

#[test]
fn auto_target_table() {
    // 스텝 칸: `◀ 이 칸` 줄(focus) 위치 — 다른 HTTP 줄이 있어도.
    let lines = vec![hl(0, None, false), if_line(), hl(2, None, true)];
    assert_eq!(auto_target(&lines, true), Some(2));
    // 스텝 칸인데 그 스텝이 이번 실행에 없음(focus 없음) → None.
    let lines = vec![hl(0, None, false), hl(1, None, false)];
    assert_eq!(auto_target(&lines, true), None);
    let lines = vec![hl(0, None, false)];
    assert_eq!(auto_target(&lines, true), None, "HTTP 1개여도 focus 없으면");
    // 흐름 전체 칸: HTTP 줄이 정확히 1개(+If 줄) → 그 줄.
    let lines = vec![if_line(), hl(1, None, false)];
    assert_eq!(auto_target(&lines, false), Some(1));
    // HTTP 2개 → None.
    let lines = vec![hl(0, None, false), if_line(), hl(2, None, false)];
    assert_eq!(auto_target(&lines, false), None);
    // 한 스텝 반복 2줄 → None(스텝이 하나여도 줄이 여럿).
    let lines = vec![hl(0, Some(0), false), hl(1, Some(1), false)];
    assert_eq!(auto_target(&lines, false), None);
    // 흐름 전체 칸은 focus를 보지 않는다(HTTP 2개면 focus가 있어도 None).
    let lines = vec![hl(0, None, true), hl(1, None, false)];
    assert_eq!(auto_target(&lines, false), None);
    // 빈 목록 → None.
    assert_eq!(auto_target(&[], true), None);
    assert_eq!(auto_target(&[], false), None);
    // If 줄만 → None.
    assert_eq!(auto_target(&[if_line()], false), None);
}

// ---------- tui-2b-polish: 숫자 글자 ----------

/// 본문 `{"v":<lit>}`의 `$.v` 줄 → (값 목록에 보이는 글자, 기본 조건의 비교값).
fn number_of(lit: &str) -> (String, String) {
    let l = value_list(&resp(200, &[], &format!("{{\"v\":{lit}}}")), false, 64);
    let row = l
        .rows
        .iter()
        .find(|r| matches!(&r.kind, RowKind::Body { path } if path == "$.v"))
        .unwrap_or_else(|| panic!("{lit}: no $.v row"));
    (row.shown(), default_condition("S1", row).cond.value)
}

/// spec §2.1-3 — `serde_json`이 정확히 읽는 글자. GUI `String(JSON.parse(x))`와 같은 글자
/// (마지막 행만 뜻대로 다르다 — 정수 꼴은 본문 값 그대로).
const EXACT: &[(&str, &str)] = &[
    ("1e300", "1e+300"),
    ("2.5e-300", "2.5e-300"),
    ("5e-324", "5e-324"),
    ("1.7976931348623157e308", "1.7976931348623157e+308"),
    ("1e21", "1e+21"),
    ("1e20", "100000000000000000000"),
    ("1e299", "1e+299"),
    ("1.0", "1"),
    ("1.5", "1.5"),
    ("1e5", "100000"),
    ("1E5", "100000"),
    ("18446744073709551616", "18446744073709552000"),
    ("1e-6", "0.000001"),
    ("1e-7", "1e-7"),
    ("0.00000123", "0.00000123"),
    ("1.5e-7", "1.5e-7"),
    ("-1e300", "-1e+300"),
    ("-2.5e-10", "-2.5e-10"),
    ("-0.0", "0"),
    ("0.0", "0"),
    ("100.25", "100.25"),
    ("3.0e2", "300"),
    ("0.1", "0.1"),
    ("1.5e-300", "1.5e-300"),
    ("9.720979928970337e2", "972.0979928970337"),
    ("4.5e250", "4.5e+250"),
    ("12345678901234567890", "12345678901234567890"),
];

#[test]
fn number_text_tables() {
    for (lit, want) in EXACT.iter() {
        let (shown, value) = number_of(lit);
        assert_eq!(shown, *want, "shown for {lit}");
        assert_eq!(value, *want, "condition value for {lit}");
    }
}

#[test]
fn number_text_reads_back_as_server_value() {
    // 서버: float_roundtrip이 켜져 있어 서버 값 = 정확한 값. 실제 값 = serde_json이 읽은 f64, 비교값 = str::parse(`parse_finite`) → `==`.
    for (lit, text) in EXACT.iter() {
        let server: f64 = serde_json::from_str(lit).unwrap();
        let back: f64 = text
            .parse()
            .unwrap_or_else(|_| panic!("{text} not a number"));
        assert_eq!(back, server, "{lit} -> {text}");
    }
}

#[test]
fn number_text_is_short() {
    use handicap_tui::pick::number_text;
    for v in [
        f64::MAX,
        f64::MIN,
        f64::MIN_POSITIVE,
        -f64::MIN_POSITIVE,
        5e-324,
        -5e-324,
        -1.2345678901234567e-100,
        -0.0000012345678901234567,
        1.2345678901234567e20,
    ] {
        let t = number_text(v);
        assert!(t.len() <= 26, "{t} is {} chars", t.len());
        assert_eq!(t.parse::<f64>().unwrap(), v, "{t}");
    }
    assert_eq!(number_text(0.0), "0");
    assert_eq!(number_text(-0.0), "0");
}

/// Keep in sync: GUI `isSecretName` 표(Task 5)와 같은 행·같은 순서.
#[test]
fn secret_name_table() {
    for n in [
        "session_id",
        "X-Api-Key",
        "csrfToken",
        "password",
        "author",
        "Set-Cookie",
        "user_pwd",
        "Authorization",
        "refresh_token",
    ] {
        assert!(is_secret_name(n), "{n}");
    }
    for n in ["name", "id", "count", "status", "url", "message"] {
        assert!(!is_secret_name(n), "{n}");
    }
}

#[test]
fn secret_name_from_value_list() {
    let r = resp(
        200,
        &[("X-Api-Key", "k")],
        r#"{"session_id":"s","items":[{"api_key":"k"}],"tokens":["t"],"name":"n","nested":{"session":{"id":"i"}}}"#,
    );
    let vl = value_list(&r, false, 64);
    let flag = |t: &str| {
        vl.rows
            .iter()
            .find(|x| match &x.kind {
                RowKind::Header { name } => name == t,
                RowKind::Body { path } => path == t,
                _ => false,
            })
            .unwrap_or_else(|| panic!("no row {t}"))
            .secret_name
    };
    for t in [
        "X-Api-Key",
        "$.session_id",
        "$.items[0].api_key",
        "$.tokens[0]",
    ] {
        assert!(flag(t), "{t}");
    }
    for t in ["$.name", "$.nested.session.id"] {
        assert!(!flag(t), "{t}");
    }
    assert!(!vl.rows[0].secret_name);
    let arr = value_list(&resp(200, &[], "[1]"), false, 64);
    let r0 = arr
        .rows
        .iter()
        .find(|x| matches!(&x.kind, RowKind::Body { path } if path == "$[0]"))
        .unwrap();
    assert!(!r0.secret_name);
}

/// Keep in sync: GUI 판정표(Task 5)와 같은 행.
#[test]
fn default_condition_prefill_parity() {
    let a32 = "a".repeat(32);
    let x41 = "x".repeat(41);
    let mkrow = |name: &str, v: PickValue, header: bool| ValueRow {
        kind: if header {
            RowKind::Header { name: name.into() }
        } else {
            RowKind::Body {
                path: format!("$.{name}"),
            }
        },
        value: v,
        secret_name: is_secret_name(name),
    };
    let cases: Vec<(ValueRow, ConditionOp, &str, Option<Hint>)> = vec![
        (
            mkrow("session_id", st(&a32), false),
            ConditionOp::NotEmpty,
            "",
            Some(Hint::SecretName),
        ),
        (
            mkrow("session_id", st(""), false),
            ConditionOp::Exists,
            "",
            Some(Hint::SecretName),
        ),
        (
            mkrow("token", st(&x41), false),
            ConditionOp::NotEmpty,
            "",
            Some(Hint::SecretName),
        ),
        (
            mkrow("name", st("web-1"), false),
            ConditionOp::Eq,
            "web-1",
            None,
        ),
        (
            mkrow("name", st(&x41), false),
            ConditionOp::NotEmpty,
            "",
            Some(Hint::Volatile),
        ),
        (
            mkrow("name", st("a\tb"), false),
            ConditionOp::NotEmpty,
            "",
            Some(Hint::Volatile),
        ),
        (
            mkrow("name", st("a\u{200F}b"), false),
            ConditionOp::NotEmpty,
            "",
            Some(Hint::Volatile),
        ),
        (
            mkrow("session_count", PickValue::Number("5".into()), false),
            ConditionOp::Eq,
            "5",
            None,
        ),
        (
            mkrow("Authorization", PickValue::Header("Bearer x".into()), true),
            ConditionOp::NotEmpty,
            "",
            Some(Hint::Masked),
        ),
    ];
    for (r, op, val, hint) in cases {
        let d = default_condition(A, &r);
        assert_eq!(d.cond.op, op, "{:?}", r);
        assert_eq!(d.cond.value, val, "{:?}", r);
        assert_eq!(d.hint, hint, "{:?}", r);
    }
}
