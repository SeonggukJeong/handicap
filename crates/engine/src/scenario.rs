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

/// A scenario step. Internally-tagged on `type` so the YAML shape is
/// `{type: http, ...}` / `{type: loop, ...}` — matching the UI wire format and
/// ADR-0020. Internal tagging round-trips in serde_yaml 0.9 (proven by the
/// `Extract` enum, Slice 4). NOTE: serde does not enforce `deny_unknown_fields`
/// through internal tagging, so the engine is lenient about unknown fields
/// inside a step; the UI Zod schema (`ui/src/scenario/model.ts`) is the strict
/// authoring gate. `do_` is `Vec<Step>` (not `Vec<HttpStep>`) so the engine
/// supports nesting for free; single-level is enforced UI-side for Slice 7.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Step {
    Http(HttpStep),
    Loop(LoopStep),
    If(IfStep),
}

impl Step {
    pub fn id(&self) -> &str {
        match self {
            Step::Http(h) => &h.id,
            Step::Loop(l) => &l.id,
            Step::If(i) => &i.id,
        }
    }
    pub fn name(&self) -> &str {
        match self {
            Step::Http(h) => &h.name,
            Step::Loop(l) => &l.name,
            Step::If(i) => &i.name,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HttpStep {
    pub id: String,
    pub name: String,
    pub request: Request,
    #[serde(default)]
    pub assert: Vec<Assertion>,
    #[serde(default)]
    pub extract: Vec<Extract>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LoopStep {
    pub id: String,
    pub name: String,
    pub repeat: u32,
    #[serde(rename = "do")]
    pub do_: Vec<Step>,
}

/// Branch control-flow node. `then` runs when `cond` is true; otherwise the first
/// `elif` whose cond is true runs; otherwise `else` (a top-level catch-all). The
/// engine type uses `Vec<Step>` for free nesting (single-level / mutual-1-level is
/// the UI Zod gate — 9b/9c), same as `LoopStep.do_`. Per-variant
/// `deny_unknown_fields` (internal `type` tag does not enforce it — engine CLAUDE.md).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IfStep {
    pub id: String,
    pub name: String,
    pub cond: Condition,
    #[serde(rename = "then")]
    pub then_: Vec<Step>,
    #[serde(default)]
    pub elif: Vec<ElifBranch>,
    #[serde(rename = "else", default)]
    pub else_: Vec<Step>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ElifBranch {
    pub cond: Condition,
    #[serde(rename = "then")]
    pub then_: Vec<Step>,
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

/// Comparison operator for a condition leaf. Plain unit-variant enum → `derive`
/// round-trips in serde_yaml 0.9 (same class as `CookieJarMode`/`HttpMethod`,
/// unlike the map-shaped `Condition` below which needs manual serde — engine CLAUDE.md).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CompareOp {
    Eq,
    Ne,
    Contains,
    Matches,
    Lt,
    Gt,
    Lte,
    Gte,
    Exists,
    Empty,
}

/// A recursive condition tree: a leaf comparison or an AND/OR group.
///
/// Map-shaped YAML (`{left, op, right?}` / `{all: [...]}` / `{any: [...]}`), so —
/// like [`Body`] and [`Assertion`] — it needs a **manual** `Serialize`/`Deserialize`:
/// serde_yaml 0.9 derive on an externally-tagged enum with map variants emits/expects
/// `!variant value` tags, breaking round-trip (engine CLAUDE.md). The three shapes are
/// disambiguated by key presence (`all` / `any` / `left`); `Compare` always carries
/// `left`, which never collides with `all`/`any`, so there is no ambiguity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Condition {
    Compare {
        left: String,
        op: CompareOp,
        right: Option<String>,
    },
    All(Vec<Condition>),
    Any(Vec<Condition>),
}

impl Serialize for Condition {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Condition::All(v) => {
                let mut map = s.serialize_map(Some(1))?;
                map.serialize_entry("all", v)?;
                map.end()
            }
            Condition::Any(v) => {
                let mut map = s.serialize_map(Some(1))?;
                map.serialize_entry("any", v)?;
                map.end()
            }
            Condition::Compare { left, op, right } => {
                let n = if right.is_some() { 3 } else { 2 };
                let mut map = s.serialize_map(Some(n))?;
                map.serialize_entry("left", left)?;
                map.serialize_entry("op", op)?;
                if let Some(r) = right {
                    map.serialize_entry("right", r)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Condition {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct CondVisitor;
        impl<'de> Visitor<'de> for CondVisitor {
            type Value = Condition;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a condition map: {all: [...]}, {any: [...]}, or {left, op, right?}")
            }
            fn visit_map<M: MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Condition, M::Error> {
                let mut left: Option<String> = None;
                let mut op: Option<CompareOp> = None;
                let mut right: Option<String> = None;
                let mut all: Option<Vec<Condition>> = None;
                let mut any: Option<Vec<Condition>> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "all" => {
                            if all.is_some() {
                                return Err(de::Error::duplicate_field("all"));
                            }
                            all = Some(map.next_value()?);
                        }
                        "any" => {
                            if any.is_some() {
                                return Err(de::Error::duplicate_field("any"));
                            }
                            any = Some(map.next_value()?);
                        }
                        "left" => {
                            if left.is_some() {
                                return Err(de::Error::duplicate_field("left"));
                            }
                            left = Some(map.next_value()?);
                        }
                        "op" => {
                            if op.is_some() {
                                return Err(de::Error::duplicate_field("op"));
                            }
                            op = Some(map.next_value()?);
                        }
                        "right" => {
                            if right.is_some() {
                                return Err(de::Error::duplicate_field("right"));
                            }
                            right = Some(map.next_value()?);
                        }
                        other => {
                            return Err(de::Error::unknown_field(
                                other,
                                &["all", "any", "left", "op", "right"],
                            ));
                        }
                    }
                }
                match (all, any, left) {
                    (Some(v), None, None) => {
                        if op.is_some() || right.is_some() {
                            return Err(de::Error::custom(
                                "`all` group cannot also have left/op/right",
                            ));
                        }
                        Ok(Condition::All(v))
                    }
                    (None, Some(v), None) => {
                        if op.is_some() || right.is_some() {
                            return Err(de::Error::custom(
                                "`any` group cannot also have left/op/right",
                            ));
                        }
                        Ok(Condition::Any(v))
                    }
                    (None, None, Some(l)) => {
                        let op = op.ok_or_else(|| de::Error::missing_field("op"))?;
                        Ok(Condition::Compare { left: l, op, right })
                    }
                    (None, None, None) => Err(de::Error::custom(
                        "condition must have `all`, `any`, or `left`",
                    )),
                    _ => Err(de::Error::custom(
                        "condition must be exactly one of: all-group, any-group, or compare",
                    )),
                }
            }
        }
        d.deserialize_map(CondVisitor)
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
    const TWO_STEP_FIXTURE: &str = include_str!("../tests/fixtures/two_step.yaml");

    #[test]
    fn parses_loop_step() {
        let y = r#"
version: 1
name: loopy
steps:
  - id: "01HX0000000000000000000001"
    name: repeat-add
    type: loop
    repeat: 3
    do:
      - id: "01HX0000000000000000000002"
        name: add
        type: http
        request: { method: POST, url: "/cart" }
        assert:
          - status: 200
"#;
        let s = Scenario::from_yaml(y).expect("parses loop");
        assert_eq!(s.steps.len(), 1);
        match &s.steps[0] {
            Step::Loop(l) => {
                assert_eq!(l.id, "01HX0000000000000000000001");
                assert_eq!(l.repeat, 3);
                assert_eq!(l.do_.len(), 1);
                assert!(matches!(l.do_[0], Step::Http(_)));
            }
            other => panic!("expected loop, got {other:?}"),
        }
    }

    #[test]
    fn loop_round_trips() {
        let y = r#"
version: 1
name: loopy
steps:
  - id: "01HX0000000000000000000001"
    name: repeat-add
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000002"
        name: add
        type: http
        request: { method: GET, url: "/x" }
        assert: []
"#;
        let s = Scenario::from_yaml(y).unwrap();
        let s2 = Scenario::from_yaml(&s.to_yaml().unwrap()).unwrap();
        assert_eq!(s, s2);
    }

    #[test]
    fn inner_http_step_keeps_type_tag_when_serialized() {
        let s = Scenario::from_yaml(
            "version: 1\nname: x\nsteps:\n  - id: \"01HX0000000000000000000001\"\n    name: l\n    type: loop\n    repeat: 1\n    do:\n      - id: \"01HX0000000000000000000002\"\n        name: h\n        type: http\n        request: { method: GET, url: \"/\" }\n        assert: []\n",
        )
        .unwrap();
        let out = s.to_yaml().unwrap();
        assert!(
            out.contains("type: http"),
            "inner step must keep type tag:\n{out}"
        );
        assert!(out.contains("type: loop"));
    }

    #[test]
    fn parses_two_step_fixture() {
        let s = Scenario::from_yaml(TWO_STEP_FIXTURE).expect("parses");
        assert_eq!(s.steps.len(), 2);
        let Step::Http(login) = &s.steps[0] else {
            panic!("expected http step");
        };
        assert_eq!(login.extract.len(), 1);
        match &login.extract[0] {
            Extract::Body { var, path } => {
                assert_eq!(var, "token");
                assert_eq!(path, "$.access_token");
            }
            other => panic!("expected Body extract, got {:?}", other),
        }
        let Step::Http(second) = &s.steps[1] else {
            panic!("expected http step");
        };
        assert_eq!(second.extract.len(), 0);
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
        let Step::Http(step) = &s.steps[0] else {
            panic!("expected http step");
        };
        let xs = &step.extract;
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
        let Step::Http(step) = &s.steps[0] else {
            panic!("expected http step");
        };
        assert_eq!(step.id, "root");
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
        let Step::Http(step) = &s.steps[0] else {
            panic!("expected http step");
        };
        match step.request.body.as_ref().expect("body present") {
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
        let Step::Http(step) = &s.steps[0] else {
            panic!("expected http step");
        };
        match step.request.body.as_ref().expect("body") {
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
        let Step::Http(step) = &s.steps[0] else {
            panic!("expected http step");
        };
        match step.request.body.as_ref().expect("body") {
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

    // ---- Slice 9a: Condition serde ----

    fn cond_round_trip(yaml: &str) -> Condition {
        let c: Condition = serde_yaml::from_str(yaml).expect("cond parses");
        let out = serde_yaml::to_string(&c).expect("cond serializes");
        let c2: Condition = serde_yaml::from_str(&out).expect("cond re-parses");
        assert_eq!(c, c2, "condition must round-trip:\n{out}");
        c
    }

    #[test]
    fn condition_compare_round_trips() {
        let c = cond_round_trip("{ left: \"{{code}}\", op: eq, right: \"200\" }");
        assert_eq!(
            c,
            Condition::Compare {
                left: "{{code}}".into(),
                op: CompareOp::Eq,
                right: Some("200".into()),
            }
        );
    }

    #[test]
    fn condition_exists_omits_right() {
        let c = cond_round_trip("{ left: \"{{token}}\", op: exists }");
        assert_eq!(
            c,
            Condition::Compare {
                left: "{{token}}".into(),
                op: CompareOp::Exists,
                right: None,
            }
        );
        // serialized form must NOT contain a `right:` key for exists.
        let out = serde_yaml::to_string(&c).unwrap();
        assert!(!out.contains("right"), "exists must omit right:\n{out}");
    }

    #[test]
    fn condition_nested_all_any_round_trips() {
        let c = cond_round_trip(
            "all:\n  - { left: \"{{a}}\", op: eq, right: \"1\" }\n  - any:\n      - { left: \"{{b}}\", op: contains, right: \"x\" }\n      - { left: \"{{c}}\", op: gte, right: \"3\" }\n",
        );
        match c {
            Condition::All(v) => {
                assert_eq!(v.len(), 2);
                assert!(matches!(v[0], Condition::Compare { .. }));
                assert!(matches!(v[1], Condition::Any(_)));
            }
            other => panic!("expected All, got {other:?}"),
        }
    }

    #[test]
    fn condition_key_order_independent() {
        // op/left/right in any order must parse to the same Compare.
        let c: Condition =
            serde_yaml::from_str("{ op: ne, right: \"x\", left: \"{{v}}\" }").unwrap();
        assert_eq!(
            c,
            Condition::Compare {
                left: "{{v}}".into(),
                op: CompareOp::Ne,
                right: Some("x".into()),
            }
        );
    }

    #[test]
    fn condition_rejects_malformed_map() {
        // No `all`/`any`/`left` key → cannot disambiguate → error.
        assert!(serde_yaml::from_str::<Condition>("{ op: eq, right: \"1\" }").is_err());
        // Unknown key.
        assert!(serde_yaml::from_str::<Condition>("{ left: \"a\", op: eq, bogus: 1 }").is_err());
        // Mixing group + compare.
        assert!(serde_yaml::from_str::<Condition>("{ all: [], left: \"a\", op: eq }").is_err());
        // Empty map has no discriminator → error.
        assert!(serde_yaml::from_str::<Condition>("{}").is_err());
    }
}
