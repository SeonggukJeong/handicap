use handicap_engine::Scenario;
use handicap_tui::names::{Names, StepInfo, flatten_http_steps};

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
            }
        ))
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
