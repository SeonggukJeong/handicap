use serde::de::{self, MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;
use std::fmt;

use crate::error::{EngineError, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub version: u32,
    pub name: String,
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
    #[serde(default = "default_cookie_jar")]
    pub cookie_jar: CookieJarMode,
    pub steps: Vec<Step>,
}

fn default_cookie_jar() -> CookieJarMode {
    CookieJarMode::Auto
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CookieJarMode {
    Auto,
    Off,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: StepKind,
    pub request: Request,
    #[serde(default)]
    pub assert: Vec<Assertion>,
    #[serde(default)]
    pub extract: Vec<Extract>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StepKind {
    Http,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub method: HttpMethod,
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<Body>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Head,
    Options,
}

/// Request body variant. Serializes/deserializes as a single-entry YAML map
/// `{json|form|raw: <value>}` to match the wire format the UI (`ui/src/scenario/`)
/// emits and the format documented in ADR-0014.
///
/// Manual impl required for the same reason as [`Assertion`] below: serde_yaml 0.9
/// derive on an externally-tagged enum with map-shaped variants emits/expects
/// `!variant value` YAML tags, not `{variant: value}` maps. This was silently
/// broken until Slice 3's BodyEditor became the first caller to actually use
/// a body — the Slice 1 fixture had no body field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body {
    Json(serde_json::Value),
    Form(BTreeMap<String, String>),
    Raw(String),
}

impl Serialize for Body {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(1))?;
        match self {
            Body::Json(v) => map.serialize_entry("json", v)?,
            Body::Form(m) => map.serialize_entry("form", m)?,
            Body::Raw(t) => map.serialize_entry("raw", t)?,
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Body {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct BodyVisitor;
        impl<'de> Visitor<'de> for BodyVisitor {
            type Value = Body;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a map with a single key: json, form, or raw")
            }
            fn visit_map<M: MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Body, M::Error> {
                let key: String = map
                    .next_key()?
                    .ok_or_else(|| de::Error::custom("empty body map"))?;
                let body = match key.as_str() {
                    "json" => Body::Json(map.next_value()?),
                    "form" => Body::Form(map.next_value()?),
                    "raw" => Body::Raw(map.next_value()?),
                    other => {
                        return Err(de::Error::unknown_field(other, &["json", "form", "raw"]));
                    }
                };
                if map.next_key::<String>()?.is_some() {
                    return Err(de::Error::custom(
                        "body map must have exactly one key (json|form|raw)",
                    ));
                }
                Ok(body)
            }
        }
        d.deserialize_map(BodyVisitor)
    }
}

/// Assertion variant. Serializes/deserializes as a YAML map `{status: <code>}`.
/// Manual impl required because serde_yaml 0.9 does not support externally-tagged
/// enums backed by map values (it expects a `!tag` anchor instead).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Assertion {
    Status(u16),
}

impl Serialize for Assertion {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Assertion::Status(code) => {
                let mut map = s.serialize_map(Some(1))?;
                map.serialize_entry("status", code)?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Assertion {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct AssertionVisitor;
        impl<'de> Visitor<'de> for AssertionVisitor {
            type Value = Assertion;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a map with a single key: status")
            }
            fn visit_map<M: MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Assertion, M::Error> {
                let key: String = map
                    .next_key()?
                    .ok_or_else(|| de::Error::custom("empty assertion map"))?;
                match key.as_str() {
                    "status" => {
                        let code: u16 = map.next_value()?;
                        // consume any extra keys — treat as unknown field error
                        if map.next_key::<String>()?.is_some() {
                            return Err(de::Error::custom("unknown field in assertion"));
                        }
                        Ok(Assertion::Status(code))
                    }
                    other => Err(de::Error::unknown_field(other, &["status"])),
                }
            }
        }
        d.deserialize_map(AssertionVisitor)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "from", rename_all = "lowercase", deny_unknown_fields)]
pub enum Extract {
    Body { var: String, path: String },
    Header { var: String, name: String },
    Cookie { var: String, name: String },
    Status { var: String },
}

impl Scenario {
    pub fn from_yaml(s: &str) -> Result<Self> {
        Ok(serde_yaml::from_str(s)?)
    }

    pub fn to_yaml(&self) -> Result<String> {
        serde_yaml::to_string(self).map_err(EngineError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/single_step.yaml");
    const TWO_STEP_FIXTURE: &str = include_str!("../tests/fixtures/two_step.yaml");

    #[test]
    fn parses_two_step_fixture() {
        let s = Scenario::from_yaml(TWO_STEP_FIXTURE).expect("parses");
        assert_eq!(s.steps.len(), 2);
        let login = &s.steps[0];
        assert_eq!(login.extract.len(), 1);
        match &login.extract[0] {
            Extract::Body { var, path } => {
                assert_eq!(var, "token");
                assert_eq!(path, "$.access_token");
            }
            other => panic!("expected Body extract, got {:?}", other),
        }
        assert_eq!(s.steps[1].extract.len(), 0);
    }

    #[test]
    fn parses_each_extract_variant() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request:
      method: GET
      url: "/"
    assert: []
    extract:
      - var: t
        from: body
        path: "$.a"
      - var: h
        from: header
        name: X-Trace
      - var: c
        from: cookie
        name: JSESSIONID
      - var: s
        from: status
"#;
        let s = Scenario::from_yaml(y).expect("parses");
        let xs = &s.steps[0].extract;
        assert_eq!(xs.len(), 4);
        assert!(matches!(xs[0], Extract::Body { .. }));
        assert!(matches!(xs[1], Extract::Header { .. }));
        assert!(matches!(xs[2], Extract::Cookie { .. }));
        assert!(matches!(xs[3], Extract::Status { .. }));
    }

    #[test]
    fn extract_round_trips() {
        let s = Scenario::from_yaml(TWO_STEP_FIXTURE).unwrap();
        let yaml = s.to_yaml().unwrap();
        let s2 = Scenario::from_yaml(&yaml).unwrap();
        assert_eq!(s, s2);
    }

    #[test]
    fn rejects_extract_with_unknown_from() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request: { method: GET, url: "/" }
    assert: []
    extract:
      - var: t
        from: nope
        path: "$.a"
"#;
        assert!(Scenario::from_yaml(y).is_err());
    }

    #[test]
    fn rejects_body_extract_without_path() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request: { method: GET, url: "/" }
    assert: []
    extract:
      - var: t
        from: body
"#;
        assert!(Scenario::from_yaml(y).is_err());
    }

    #[test]
    fn parses_single_step_fixture() {
        let s = Scenario::from_yaml(FIXTURE).expect("parses");
        assert_eq!(s.version, 1);
        assert_eq!(s.name, "GET status root");
        assert_eq!(s.steps.len(), 1);
        let step = &s.steps[0];
        assert_eq!(step.id, "root");
        assert_eq!(step.kind, StepKind::Http);
        assert_eq!(step.request.method, HttpMethod::Get);
        assert_eq!(step.request.url, "{{base_url}}/");
        assert_eq!(step.assert, vec![Assertion::Status(200)]);
        assert_eq!(s.cookie_jar, CookieJarMode::Auto);
    }

    #[test]
    fn round_trips() {
        let s = Scenario::from_yaml(FIXTURE).unwrap();
        let yaml = s.to_yaml().unwrap();
        let s2 = Scenario::from_yaml(&yaml).unwrap();
        assert_eq!(s, s2);
    }

    #[test]
    fn rejects_unknown_field() {
        let bad = r#"
version: 1
name: x
mystery_field: nope
steps: []
"#;
        assert!(Scenario::from_yaml(bad).is_err());
    }

    #[test]
    fn cookie_jar_off_parses() {
        let y = r#"
version: 1
name: x
cookie_jar: off
steps: []
"#;
        let s = Scenario::from_yaml(y).unwrap();
        assert_eq!(s.cookie_jar, CookieJarMode::Off);
    }

    // Slice 3 UI writes `body: { form: {...} }` / `{ json: ... }` / `{ raw: ... }`
    // as plain YAML maps (matching the ADR-0014 wire format). The engine must
    // accept that shape — not require serde_yaml's `!form value` external tag
    // form, which was the silent default of `derive(Deserialize)` on this enum
    // before the manual impl was added.

    #[test]
    fn parses_body_form_in_map_shape() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: login
    type: http
    request:
      method: POST
      url: "/login"
      body:
        form:
          user: "a"
          pass: "b"
    assert: []
"#;
        let s = Scenario::from_yaml(y).expect("parses with map-shaped body");
        match s.steps[0].request.body.as_ref().expect("body present") {
            Body::Form(m) => {
                assert_eq!(m.get("user").map(String::as_str), Some("a"));
                assert_eq!(m.get("pass").map(String::as_str), Some("b"));
            }
            other => panic!("expected Form, got {:?}", other),
        }
    }

    #[test]
    fn parses_body_json_in_map_shape() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request:
      method: POST
      url: "/"
      body:
        json:
          a: 1
          b: [1, 2]
    assert: []
"#;
        let s = Scenario::from_yaml(y).expect("parses");
        match s.steps[0].request.body.as_ref().expect("body") {
            Body::Json(v) => {
                assert_eq!(v["a"], 1);
                assert_eq!(v["b"], serde_json::json!([1, 2]));
            }
            other => panic!("expected Json, got {:?}", other),
        }
    }

    #[test]
    fn parses_body_raw_in_map_shape() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request:
      method: POST
      url: "/"
      body:
        raw: "hello"
    assert: []
"#;
        let s = Scenario::from_yaml(y).expect("parses");
        match s.steps[0].request.body.as_ref().expect("body") {
            Body::Raw(t) => assert_eq!(t, "hello"),
            other => panic!("expected Raw, got {:?}", other),
        }
    }

    #[test]
    fn body_round_trips_map_shape() {
        let original = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request:
      method: POST
      url: "/"
      body:
        form:
          a: "1"
    assert: []
"#;
        let parsed = Scenario::from_yaml(original).unwrap();
        let re_serialized = parsed.to_yaml().unwrap();
        assert!(
            re_serialized.contains("form:"),
            "serialized output should contain `form:` map key, got:\n{re_serialized}"
        );
        assert!(
            !re_serialized.contains("!form"),
            "serialized output should NOT contain external `!form` tag, got:\n{re_serialized}"
        );
        let re_parsed = Scenario::from_yaml(&re_serialized).unwrap();
        assert_eq!(parsed, re_parsed);
    }

    #[test]
    fn body_map_rejects_multiple_top_level_keys() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request:
      method: POST
      url: "/"
      body:
        form: { a: "1" }
        bogus: 42
    assert: []
"#;
        assert!(
            Scenario::from_yaml(y).is_err(),
            "body map must have exactly one key (json|form|raw)"
        );
    }

    #[test]
    fn body_map_rejects_unknown_variant() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request:
      method: POST
      url: "/"
      body:
        xml: "<a/>"
    assert: []
"#;
        assert!(
            Scenario::from_yaml(y).is_err(),
            "unknown body variant must be rejected"
        );
    }
}
