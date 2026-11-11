//! 시나리오 고정 변수 한 줄 교체(spec §6.4). 엔진·서버 없는 순수 함수 테스트.
use handicap_engine::Scenario;
use handicap_tui::yaml_var::{NotEditable, StaticVar, splice_static_var, static_vars};

const STEP: &str = "steps:\n  - { id: \"01J00000000000000000000A01\", name: a, type: http, request: { method: GET, url: \"/a\" }, assert: [] }\n";

/// 조립한 YAML이 실제 시나리오로 유효함을 못박는다 — 아니면 거절 케이스가 공허하게 `Shape`가 된다.
fn scenario(head: &str, vars_block: &str) -> String {
    let y = format!("version: 1\nname: s\n{head}{vars_block}{STEP}");
    assert!(
        Scenario::from_yaml(&y).is_ok(),
        "fixture must be a valid Scenario:\n{y}"
    );
    y
}

fn fixture(vars_block: &str) -> String {
    scenario("", vars_block)
}

/// 1부터 센, 내용이 다른 줄 번호(줄 수는 같아야 한다).
fn changed_lines(a: &str, b: &str) -> Vec<usize> {
    let la: Vec<&str> = a.split_inclusive('\n').collect();
    let lb: Vec<&str> = b.split_inclusive('\n').collect();
    assert_eq!(la.len(), lb.len(), "line count changed");
    (0..la.len())
        .filter(|&i| la[i] != lb[i])
        .map(|i| i + 1)
        .collect()
}

/// 새 YAML에서 `variables[key]` 문자열.
fn read_var(yaml: &str, key: &str) -> String {
    let v: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
    v["variables"][key].as_str().unwrap().to_string()
}

fn line_no(yaml: &str, needle: &str) -> usize {
    yaml.split_inclusive('\n')
        .position(|l| l.contains(needle))
        .unwrap()
        + 1
}

#[test]
fn plain_single_quoted_double_quoted_replace_one_line() {
    for v in [
        "  order_id: A-1\n",
        "  order_id: 'A-1'\n",
        "  order_id: \"A-1\"\n",
    ] {
        let y = fixture(&format!("variables:\n{v}"));
        let out = splice_static_var(&y, "order_id", "Z").unwrap();
        assert_eq!(changed_lines(&y, &out), vec![line_no(&y, "order_id")]);
        assert!(out.contains("  order_id: \"Z\"\n"), "{out}");
        assert_eq!(read_var(&out, "order_id"), "Z");
    }
}

#[test]
fn trailing_comment_preserved() {
    let y = fixture("variables:\n  order_id: \"A-1\"  # 주문\n");
    let out = splice_static_var(&y, "order_id", "Z").unwrap();
    assert!(out.contains("  order_id: \"Z\"  # 주문\n"), "{out}");
    assert_eq!(changed_lines(&y, &out).len(), 1);
}

#[test]
fn hash_without_space_is_part_of_plain_value() {
    let y = fixture("variables:\n  tag: a#b\n");
    let out = splice_static_var(&y, "tag", "Z").unwrap();
    assert!(out.contains("  tag: \"Z\"\n"), "{out}");
    assert!(!out.contains("a#b"));
    assert_eq!(read_var(&out, "tag"), "Z");
}

#[test]
fn escaped_quotes_inside_quoted_values() {
    let y = fixture("variables:\n  a: 'it''s'\n  b: \"a\\\"b\"\n");
    let out = splice_static_var(&y, "a", "Z").unwrap();
    assert!(
        out.contains("  a: \"Z\"\n") && out.contains("  b: \"a\\\"b\"\n"),
        "{out}"
    );
    assert_eq!(changed_lines(&y, &out), vec![line_no(&y, "a: ")]);
    let out = splice_static_var(&y, "b", "Z").unwrap();
    assert!(
        out.contains("  a: 'it''s'\n") && out.contains("  b: \"Z\"\n"),
        "{out}"
    );
    assert_eq!(changed_lines(&y, &out).len(), 1);
}

#[test]
fn quoted_key_forms_match() {
    let y = fixture("variables:\n  \"a\": x1\n  'b': x2\n");
    assert_eq!(
        read_var(&splice_static_var(&y, "a", "Z").unwrap(), "a"),
        "Z"
    );
    assert_eq!(
        read_var(&splice_static_var(&y, "b", "Z").unwrap(), "b"),
        "Z"
    );
}

#[test]
fn new_value_with_special_chars_round_trips() {
    for new in [
        "a\"b",
        "c\\d",
        "한글 값",
        "${BASE_URL}/x",
        "tab\there",
        "x # y",
    ] {
        let y = fixture("variables:\n  order_id: A-1\n");
        let out = splice_static_var(&y, "order_id", new).unwrap();
        assert_eq!(read_var(&out, "order_id"), new);
        assert_eq!(changed_lines(&y, &out).len(), 1);
        assert!(Scenario::from_yaml(&out).is_ok());
    }
}

#[test]
fn crlf_preserved_one_line_changed() {
    let y = fixture("variables:\n  order_id: A-1\n  other: B-2\n").replace('\n', "\r\n");
    assert!(Scenario::from_yaml(&y).is_ok());
    let out = splice_static_var(&y, "order_id", "Z").unwrap();
    assert_eq!(out.matches("\r\n").count(), y.matches("\r\n").count());
    assert_eq!(out.matches('\n').count(), out.matches("\r\n").count());
    assert_eq!(changed_lines(&y, &out).len(), 1);
    assert!(out.contains("  order_id: \"Z\"\r\n"));
}

#[test]
fn no_trailing_newline_ok() {
    let y = fixture("variables:\n  order_id: A-1\n");
    // 마지막 줄 끝 개행 없음 (steps 줄은 변수 줄 뒤).
    let y = y.trim_end_matches('\n').to_string();
    let out = splice_static_var(&y, "order_id", "Z").unwrap();
    assert!(!out.ends_with('\n'));
    assert_eq!(read_var(&out, "order_id"), "Z");
}

#[test]
fn notes_block_lookalike_lines_are_ignored() {
    let head = "notes: |\n  variables:\n    order_id: X\n  order_id: X\n";
    let y = scenario(head, "variables:\n  order_id: A-1\n");
    let out = splice_static_var(&y, "order_id", "Z").unwrap();
    let v: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
    assert_eq!(
        v["notes"].as_str().unwrap(),
        "variables:\n  order_id: X\norder_id: X\n"
    );
    assert_eq!(v["variables"]["order_id"].as_str().unwrap(), "Z");
    assert_eq!(changed_lines(&y, &out), vec![line_no(&y, "order_id: A-1")]);
}

#[test]
fn deeper_indented_lookalike_is_not_matched() {
    let y = fixture("variables:\n  a: \"1\"\n    # a: \"2\"\n  b: \"3\"\n");
    let out = splice_static_var(&y, "a", "Z").unwrap();
    assert!(out.contains("  a: \"Z\"\n    # a: \"2\"\n"), "{out}");
    assert_eq!(changed_lines(&y, &out).len(), 1);
}

#[test]
fn flow_mapping_variables_is_shape() {
    let y = fixture("variables: {a: \"1\"}\n");
    assert_eq!(splice_static_var(&y, "a", "Z"), Err(NotEditable::Shape));
}

#[test]
fn anchor_and_alias_are_shape() {
    let y = fixture("variables:\n  a: &x \"1\"\n  b: *x\n");
    assert_eq!(splice_static_var(&y, "a", "Z"), Err(NotEditable::Shape));
    assert_eq!(splice_static_var(&y, "b", "Z"), Err(NotEditable::Shape));
}

#[test]
fn block_scalar_value_is_shape() {
    let y = fixture("variables:\n  a: |\n    x\n");
    assert_eq!(splice_static_var(&y, "a", "Z"), Err(NotEditable::Shape));
    let y = fixture("variables:\n  a: >\n    x\n");
    assert_eq!(splice_static_var(&y, "a", "Z"), Err(NotEditable::Shape));
}

#[test]
fn generated_variable_is_generated() {
    let y = fixture("variables:\n  a: {gen: uuid}\n  s: x\n");
    assert_eq!(splice_static_var(&y, "a", "Z"), Err(NotEditable::Generated));
    assert!(splice_static_var(&y, "s", "Z").is_ok());
}

#[test]
fn missing_key_is_shape() {
    let y = fixture("variables:\n  a: x\n");
    assert_eq!(splice_static_var(&y, "nope", "Z"), Err(NotEditable::Shape));
}

#[test]
fn no_variables_block_is_shape() {
    let y = fixture("");
    assert_eq!(splice_static_var(&y, "a", "Z"), Err(NotEditable::Shape));
}

#[test]
fn duplicate_variables_header_is_shape() {
    // 유효 YAML이 아니므로(중복 키) fixture 검증을 거치지 않고 원문으로 건다.
    let y = format!("version: 1\nname: s\nvariables:\n  a: x\nvariables:\n  a: y\n{STEP}");
    assert_eq!(splice_static_var(&y, "a", "Z"), Err(NotEditable::Shape));
}

#[test]
fn duplicate_key_line_is_shape() {
    let y = format!("version: 1\nname: s\nvariables:\n  a: x\n  a: y\n{STEP}");
    assert_eq!(splice_static_var(&y, "a", "Z"), Err(NotEditable::Shape));
}

#[test]
fn multiline_plain_rejected_by_verify() {
    // 일반 스칼라의 줄 이어짐: 값 = "A-1 B-2". ⑤는 첫 줄 `A-1`만 잘라 결과가 무효 → ⑦만이 막는다.
    let y = fixture("variables:\n  order_id: A-1\n    B-2\n");
    assert_eq!(read_var(&y, "order_id"), "A-1 B-2");
    assert_eq!(
        splice_static_var(&y, "order_id", "Z"),
        Err(NotEditable::Shape)
    );
}

#[test]
fn static_vars_lists_in_key_order_with_editability() {
    let y =
        fixture("variables:\n  zeta: z1\n  gen_id: {gen: uuid}\n  alpha: &x \"a1\"\n  mid: m1\n");
    let got = static_vars(&y);
    let keys: Vec<&str> = got.iter().map(|v| v.key.as_str()).collect();
    assert_eq!(keys, vec!["alpha", "gen_id", "mid", "zeta"]);
    let by = |k: &str| -> &StaticVar { got.iter().find(|v| v.key == k).unwrap() };
    assert_eq!(by("alpha").value, "a1");
    assert_eq!(by("alpha").editable, Err(NotEditable::Shape));
    assert_eq!(by("gen_id").value, "");
    assert_eq!(by("gen_id").editable, Err(NotEditable::Generated));
    assert_eq!(by("mid").value, "m1");
    assert_eq!(by("mid").editable, Ok(()));
    assert_eq!(by("zeta").editable, Ok(()));
}

#[test]
fn static_vars_unreadable_yaml_is_empty() {
    assert!(static_vars("not: [valid").is_empty());
    assert!(static_vars("hello: world\n").is_empty());
}

#[test]
fn key_lookalike_inside_multiline_quoted_value_is_shape() {
    // 유효 YAML(따옴표 값이 다음 줄로 이어짐)이라 ④의 "정확히 1개"가 실제로 막는다.
    let y = fixture("variables:\n  a: \"x\n  a: y\"\n  b: z\n");
    assert_eq!(splice_static_var(&y, "a", "Z"), Err(NotEditable::Shape));
}

#[test]
fn header_lookalike_at_column_zero_in_quoted_notes_is_shape() {
    // 유효 YAML(따옴표 값 이어짐)이라 ②의 "정확히 1개"가 실제로 막는다.
    let y = scenario("notes: \"x\nvariables:\n  y\"\n", "variables:\n  a: y\n");
    assert_eq!(splice_static_var(&y, "a", "Z"), Err(NotEditable::Shape));
}
