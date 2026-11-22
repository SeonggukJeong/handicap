use handicap_engine::{Scenario, Step};

const TWO: &str = include_str!("fixtures/two_step.yaml");

/// two_step.yaml을 `setup` 필드가 생기기 전 코드로 왕복해 낸 글자.
const TWO_BASELINE_YAML: &str = "version: 1
name: two step token flow
variables:
  base: http://placeholder
cookie_jar: auto
steps:
- type: http
  id: 01HX0000000000000000000001
  name: login
  request:
    method: POST
    url: '{{base}}/login'
    headers: {}
    body:
      json:
        password: ${PASSWORD:-pw}
        username: ${USERNAME:-demo}
  assert:
  - status: 200
  extract:
  - from: body
    var: token
    path: $.access_token
- type: http
  id: 01HX0000000000000000000002
  name: profile
  request:
    method: GET
    url: '{{base}}/me'
    headers:
      Authorization: Bearer {{token}}
    body: null
  assert:
  - status: 200
  extract: []
";

fn http(id: &str) -> String {
    format!(
        "  - type: http\n    id: {id}\n    name: n{id}\n    request:\n      method: GET\n      url: http://x/{id}\n"
    )
}

fn yaml_with(setup_block: &str, step_ids: &[&str]) -> String {
    let steps: String = step_ids.iter().map(|i| http(i)).collect();
    format!("version: 1\nname: s\n{setup_block}steps:\n{steps}")
}

#[test]
fn no_setup_yaml_is_byte_identical() {
    let out = Scenario::from_yaml(TWO).unwrap().to_yaml().unwrap();
    assert_eq!(out, TWO_BASELINE_YAML);
    assert!(!out.contains("setup"));
}

#[test]
fn setup_round_trips() {
    let y = yaml_with(&format!("setup:\n  steps:\n{}", http("A1")), &["B1"]);
    let first = Scenario::from_yaml(&y).unwrap();
    assert_eq!(first.setup_steps().len(), 1);
    let again = Scenario::from_yaml(&first.to_yaml().unwrap()).unwrap();
    assert_eq!(first, again);
}

#[test]
fn setup_null_is_none() {
    let s = Scenario::from_yaml(&yaml_with("setup:\n", &["B1"])).unwrap();
    assert!(s.setup.is_none());
    assert!(s.setup_steps().is_empty());
}

#[test]
fn setup_empty_object_rejected() {
    assert!(Scenario::from_yaml(&yaml_with("setup: {}\n", &["B1"])).is_err());
}

#[test]
fn setup_unknown_key_rejected() {
    assert!(Scenario::from_yaml(&yaml_with("setup: { steps: [], every: 5m }\n", &["B1"])).is_err());
}

#[test]
fn setup_non_http_rejected() {
    let block = "setup:\n  steps:\n    - type: loop\n      id: L1\n      name: l\n      repeat: 2\n      do: []\n";
    let err = Scenario::from_yaml(&yaml_with(block, &["B1"])).unwrap_err();
    assert!(err.to_string().contains("only http steps"), "{err}");
}

#[test]
fn all_steps_order() {
    let y = yaml_with(&format!("setup:\n  steps:\n{}", http("A1")), &["B1", "B2"]);
    let s = Scenario::from_yaml(&y).unwrap();
    let ids: Vec<&str> = s.all_steps().map(Step::id).collect();
    assert_eq!(ids, ["A1", "B1", "B2"]);
}

#[test]
fn empty_steps_setup_counts_as_none() {
    let s = Scenario::from_yaml(&yaml_with("setup:\n  steps: []\n", &["B1"])).unwrap();
    assert!(s.setup_steps().is_empty());
    assert!(s.to_yaml().unwrap().contains("setup:"));
    assert!(s.setup.is_some());
}
