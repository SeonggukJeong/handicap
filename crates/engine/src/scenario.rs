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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub enum Body {
    #[serde(rename = "json")]
    Json(serde_json::Value),
    #[serde(rename = "form")]
    Form(BTreeMap<String, String>),
    #[serde(rename = "raw")]
    Raw(String),
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
}
