use handicap_engine::Scenario;
use handicap_tui::names::{Names, StepInfo, VarKind, flatten_http_steps};

const NESTED: &str = r#"
version: 1
name: 중첩
steps:
  - { id: "01J00000000000000000000A01", name: a, type: http, request: { method: GET, url: "/a" }, assert: [] }
  - id: "01J00000000000000000000L01"
    name: 반복
    type: loop
    repeat: 2
    do:
      - { id: "01J00000000000000000000A02", name: b, type: http, request: { method: GET, url: "/b" }, assert: [] }
  - id: "01J00000000000000000000I01"
    name: 분기
    type: if
    cond: { left: "{{code}}", op: eq, right: "200" }
    then:
      - { id: "01J00000000000000000000A03", name: c, type: http, request: { method: GET, url: "/c" }, assert: [] }
    elif:
      - cond: { left: "{{code}}", op: eq, right: "404" }
        then:
          - { id: "01J00000000000000000000A04", name: d, type: http, request: { method: GET, url: "/d" }, assert: [] }
    else:
      - { id: "01J00000000000000000000A05", name: e, type: http, request: { method: GET, url: "/e" }, assert: [] }
  - id: "01J00000000000000000000P01"
    name: 동시
    type: parallel
    branches:
      - name: x
        steps:
          - { id: "01J00000000000000000000A06", name: f, type: http, request: { method: GET, url: "/f" }, assert: [] }
      - name: y
        steps:
          - { id: "01J00000000000000000000A07", name: g, type: http, request: { method: GET, url: "/g" }, assert: [] }
"#;

fn bundle(scenarios: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "format": "handicap-bundle",
        "format_version": 1,
        "boards": [],
        "scenarios": scenarios,
        "environments": [
            { "id": "E1", "name": "운영", "vars": { "K": "비밀" } }
        ]
    }))
    .unwrap()
}

#[test]
fn flatten_order_matches_gui() {
    let sc = Scenario::from_yaml(NESTED).unwrap();
    let names: Vec<&str> = flatten_http_steps(&sc.steps)
        .iter()
        .map(|h| h.name.as_str())
        .collect();
    assert_eq!(names, ["a", "b", "c", "d", "e", "f", "g"]);
}

#[test]
fn names_from_bundle_resolves() {
    let names = Names::from_bundle(&bundle(serde_json::json!([
        { "id": "S1", "yaml": NESTED }
    ])));
    assert_eq!(names.scenario_name("S1"), Some("중첩"));
    assert_eq!(
        names.step_name("S1", "01J00000000000000000000A04"),
        Some("d")
    );
    assert_eq!(names.step_infos("S1").unwrap().len(), 7);
    assert_eq!(
        names.step_info("S1", "01J00000000000000000000A04"),
        Some((
            4,
            &StepInfo {
                id: "01J00000000000000000000A04".into(),
                name: "d".into(),
                method: "GET".into(),
                url: "/d".into(),
                branch_hint: Some("분기".into()),
            }
        ))
    );
    let hints: Vec<_> = names
        .step_infos("S1")
        .unwrap()
        .iter()
        .map(|s| s.branch_hint.as_deref())
        .collect();
    // a, b(loop 밖 IF 아님), c·d·e(IF 분기), f·g(parallel, IF 밖)
    assert_eq!(
        hints,
        [
            None,
            None,
            Some("분기"),
            Some("분기"),
            Some("분기"),
            None,
            None
        ]
    );
    assert_eq!(names.env_name("E1"), Some("운영"));
    assert_eq!(names.env_name("E2"), None);
    assert_eq!(names.scenario_name("S2"), None);
    assert_eq!(names.step_infos("S2"), None);
    assert_eq!(names.step_info("S1", "nope"), None);
    assert_eq!(names.step_name("S1", "nope"), None);
    assert!(!format!("{names:?}").contains("비밀"));
}

#[test]
fn names_tolerates_bad_input() {
    assert_eq!(Names::from_bundle(b"not json"), Names::default());

    let names = Names::from_bundle(&bundle(serde_json::json!([
        { "id": "BAD", "yaml": "::" },
        { "id": "S1", "yaml": NESTED }
    ])));
    assert_eq!(names.step_infos("BAD"), None);
    assert!(names.step_infos("S1").is_some());

    let mut bom = vec![0xEF, 0xBB, 0xBF];
    bom.extend_from_slice(&bundle(serde_json::json!([{ "id": "S1", "yaml": NESTED }])));
    assert_eq!(Names::from_bundle(&bom).scenario_name("S1"), Some("중첩"));

    assert_eq!(Names::from_bundle(b"{}"), Names::default());
}

const WITH_VARS: &str = r#"
version: 1
name: 변수
variables:
  zeta: "고정"
  alpha: "1"
  mid: { gen: uuid }
steps:
  - { id: "01J00000000000000000000A01", name: a, type: http, request: { method: GET, url: "/a" }, assert: [] }
"#;

fn bundle2(scenarios: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "format": "handicap-bundle",
        "format_version": 1,
        "boards": [],
        "scenarios": scenarios,
        "environments": [
            { "id": "E2", "name": "스테이징" },
            { "id": "E1", "name": "운영", "vars": { "BASE_URL": "비밀1", "API_TOKEN": "비밀2" } }
        ]
    }))
    .unwrap()
}

#[test]
fn env_order_and_keys() {
    let names = Names::from_bundle(&bundle2(serde_json::json!([])));
    assert_eq!(
        names.env_order(),
        [
            ("E2".to_string(), "스테이징".to_string()),
            ("E1".to_string(), "운영".to_string())
        ]
    );
    assert_eq!(
        names.env_keys("E1"),
        Some(&["API_TOKEN".to_string(), "BASE_URL".to_string()][..])
    );
    assert_eq!(names.env_keys("E2"), Some(&[][..]));
    assert_eq!(names.env_keys("NOPE"), None);
    let dbg = format!("{names:?}");
    assert!(!dbg.contains("비밀1") && !dbg.contains("비밀2"));
}

#[test]
fn scenario_vars_keys_and_kinds() {
    let names = Names::from_bundle(&bundle2(serde_json::json!([
        { "id": "S1", "yaml": WITH_VARS },
        { "id": "BAD", "yaml": "::" }
    ])));
    assert_eq!(
        names.scenario_vars("S1"),
        Some(
            &[
                ("alpha".to_string(), VarKind::Static),
                ("mid".to_string(), VarKind::Generated),
                ("zeta".to_string(), VarKind::Static),
            ][..]
        )
    );
    assert_eq!(names.scenario_vars("BAD"), None);
    assert_eq!(names.scenario_vars("NOPE"), None);
}

#[test]
fn malformed_env_vars_do_not_drop_names() {
    // fail-soft: 환경 하나의 `vars`가 객체가 아니어도 다른 이름 해석은 그대로다(그 환경의 키만 비어 있다).
    for bad in [
        serde_json::json!(null),
        serde_json::json!("x"),
        serde_json::json!([1, "a"]),
        serde_json::json!(7),
    ] {
        let file = serde_json::to_vec(&serde_json::json!({
            "scenarios": [{ "id": "S1", "yaml": WITH_VARS }],
            "environments": [
                { "id": "E1", "name": "운영", "vars": bad },
                { "id": "E2", "name": "스테이징", "vars": { "K": { "nested": 1 } } }
            ]
        }))
        .unwrap();
        let names = Names::from_bundle(&file);
        assert_eq!(names.scenario_name("S1"), Some("변수"), "{bad}");
        assert_eq!(names.env_name("E1"), Some("운영"), "{bad}");
        assert_eq!(names.env_keys("E1"), Some(&[][..]), "{bad}");
        assert_eq!(names.env_keys("E2"), Some(&["K".to_string()][..]), "{bad}");
    }
}
