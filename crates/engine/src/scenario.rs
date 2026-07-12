use serde::de::{self, MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;
use std::fmt;

use crate::error::{EngineError, Result};
use crate::pacing::ThinkTime;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub version: u32,
    pub name: String,
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
    #[serde(default = "default_cookie_jar")]
    pub cookie_jar: CookieJarMode,
    /// 시나리오 기본 think time. http 스텝에 `think_time`이 없으면 이 값을 상속하고,
    /// `{min_ms: 0, max_ms: 0}`이면 그 스텝만 대기 없음, 값이 있으면 override.
    /// **parallel 분기 서브트리에는 적용되지 않는다** — runner/trace의 Parallel arm이
    /// 분기 재귀에 `None`을 넘겨 구조적으로 강제한다(분기 = 동시 리소스 로딩이라 사람의
    /// 대기가 낄 자리가 아니고, 그룹/페이지 레이턴시 지표가 수면만큼 오염된다 — ADR-0033).
    /// 분기 스텝에 **명시된** `think_time`은 지금처럼 적용된다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_think_time: Option<ThinkTime>,
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
    Parallel(ParallelStep),
}

impl Step {
    pub fn id(&self) -> &str {
        match self {
            Step::Http(h) => &h.id,
            Step::Loop(l) => &l.id,
            Step::If(i) => &i.id,
            Step::Parallel(p) => &p.id,
        }
    }
    pub fn name(&self) -> &str {
        match self {
            Step::Http(h) => &h.name,
            Step::Loop(l) => &l.name,
            Step::If(i) => &i.name,
            Step::Parallel(p) => &p.name,
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
    /// Per-step total request timeout (seconds), overriding the run-level
    /// `http_timeout`. Absent → use the client default. Authoring-validated
    /// (1..=600) UI-side; the executor ignores `Some(0)` (lenient).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u32>,
    /// Per-step think time: pause AFTER this step's request runs (every time the
    /// step executes — per loop repeat, per chosen if-branch). Absent → no pause.
    /// Randomness uses the run-level `Profile.think_seed` (RNG threaded by the
    /// interpreter). Authoring-validated (min<=max<=600000) UI-side; engine lenient.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub think_time: Option<ThinkTime>,
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

/// Concurrent fan-out node. All `branches` run at once within one VU (shared
/// cookie jar / client, ADR-0018); the node completes when all finish (wait-all).
/// Like `LoopStep`/`IfStep` this is a plain-derive struct variant (round-trips in
/// serde_yaml 0.9; NOT a map-shape manual-serde enum). `Vec<Step>` per branch for
/// free nesting (single-level / top-level-only is the UI Zod gate). ADR-0033.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ParallelStep {
    pub id: String,
    pub name: String,
    pub branches: Vec<Branch>,
}

/// One lane of a `ParallelStep`. `name` is the namespace key for this branch's
/// outputs (`{{name.var}}` downstream) — required, unique within the node (UI Zod).
/// No `id` (like `ElifBranch`): the branch is a label/group, its http children
/// carry the metric ids.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Branch {
    pub name: String,
    pub steps: Vec<Step>,
}

impl Branch {
    /// Variable names this branch declares as extract outputs (http-only in v1).
    /// The parallel merge namespaces exactly these keys (key-origin, not value-diff
    /// — a branch that re-extracts a parent's value is still exposed; design §3.2).
    pub fn output_var_names(&self) -> Vec<&str> {
        let mut out = Vec::new();
        for s in &self.steps {
            if let Step::Http(h) = s {
                for e in &h.extract {
                    out.push(e.var());
                }
            }
        }
        out
    }
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
    /// Authoring-only "disabled" rows persisted in the scenario YAML. The
    /// executor NEVER reads this — disabled headers/form fields are kept here
    /// (not in `headers`/`body`) so they survive reload but are not sent during
    /// a run. Empty → omitted on serialize (byte-identical to pre-feature YAML).
    #[serde(default, skip_serializing_if = "DisabledRows::is_empty")]
    pub disabled: DisabledRows,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DisabledRows {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub form: BTreeMap<String, String>,
}

impl DisabledRows {
    pub fn is_empty(&self) -> bool {
        self.headers.is_empty() && self.form.is_empty()
    }
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

impl Extract {
    /// The flow variable this extract writes to.
    pub fn var(&self) -> &str {
        match self {
            Extract::Body { var, .. }
            | Extract::Header { var, .. }
            | Extract::Cookie { var, .. }
            | Extract::Status { var } => var,
        }
    }
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

    // ---- Slice 9a: IfStep / ElifBranch round-trip ----

    #[test]
    fn if_step_round_trips() {
        // Case 1: minimal IfStep — empty elif and else_ verify that
        // `#[serde(default)]` empty-vec behavior and the `then`/`else` renames
        // hold in both directions.
        let minimal = r#"
version: 1
name: if-minimal
steps:
  - id: "01HX0000000000000000000001"
    name: check-status
    type: if
    cond: { left: "{{code}}", op: eq, right: "200" }
    then:
      - id: "01HX0000000000000000000002"
        name: ok-step
        type: http
        request: { method: GET, url: "/ok" }
        assert: []
"#;
        let s = Scenario::from_yaml(minimal).unwrap();
        let yaml = s.to_yaml().unwrap();
        let s2 = Scenario::from_yaml(&yaml).unwrap();
        assert_eq!(s, s2, "minimal IfStep must round-trip:\n{yaml}");

        // Serialized form must use `then:` (not `then_:`).
        // `elif:` and `else:` are emitted even when empty (no skip_serializing_if),
        // and the `#[serde(default)]` annotation means they round-trip correctly
        // when deserialized from an empty list or when absent.
        assert!(
            yaml.contains("then:"),
            "serialized form must use `then:` key:\n{yaml}"
        );
        assert!(
            !yaml.contains("then_:"),
            "serialized form must NOT use `then_:` key:\n{yaml}"
        );

        // Case 2: full IfStep — populated elif (≥1 ElifBranch) and non-empty else_
        // to verify that the rename/default annotations survive a full round-trip.
        let full = r#"
version: 1
name: if-full
steps:
  - id: "01HX0000000000000000000003"
    name: branch
    type: if
    cond: { left: "{{code}}", op: eq, right: "200" }
    then:
      - id: "01HX0000000000000000000004"
        name: then-step
        type: http
        request: { method: GET, url: "/then" }
        assert: []
    elif:
      - cond: { left: "{{code}}", op: eq, right: "404" }
        then:
          - id: "01HX0000000000000000000005"
            name: elif-step
            type: http
            request: { method: GET, url: "/not-found" }
            assert: []
    else:
      - id: "01HX0000000000000000000006"
        name: else-step
        type: http
        request: { method: GET, url: "/fallback" }
        assert: []
"#;
        let s = Scenario::from_yaml(full).unwrap();
        let yaml = s.to_yaml().unwrap();
        let s2 = Scenario::from_yaml(&yaml).unwrap();
        assert_eq!(s, s2, "full IfStep must round-trip:\n{yaml}");

        // Confirm the serde renames appear in the wire form.
        assert!(
            yaml.contains("then:"),
            "serialized form must use `then:` key:\n{yaml}"
        );
        assert!(
            yaml.contains("else:"),
            "non-empty else_ must serialize as `else:` key:\n{yaml}"
        );
        assert!(
            !yaml.contains("then_:"),
            "serialized form must NOT use `then_:` key:\n{yaml}"
        );
        assert!(
            !yaml.contains("else_:"),
            "serialized form must NOT use `else_:` key:\n{yaml}"
        );
    }

    // ---- B4: DisabledRows serde ----

    #[test]
    fn request_disabled_round_trips() {
        let yaml = r#"
method: POST
url: https://api/login
headers:
  Content-Type: application/json
disabled:
  headers:
    X-Debug: "on"
  form:
    skip: "2"
"#;
        let req: Request = serde_yaml::from_str(yaml).expect("parses disabled");
        assert_eq!(
            req.disabled.headers.get("X-Debug").map(String::as_str),
            Some("on")
        );
        assert_eq!(req.disabled.form.get("skip").map(String::as_str), Some("2"));
        assert!(req.headers.contains_key("Content-Type")); // active untouched
        let out = serde_yaml::to_string(&req).expect("serializes");
        assert!(
            out.contains("disabled:"),
            "round-trip keeps disabled: {out}"
        );
        assert!(out.contains("X-Debug"));
    }

    #[test]
    fn request_without_disabled_parses_and_omits_on_serialize() {
        let yaml = "method: GET\nurl: https://api/x\n";
        let req: Request = serde_yaml::from_str(yaml).expect("parses w/o disabled");
        assert!(req.disabled.is_empty());
        let out = serde_yaml::to_string(&req).expect("serializes");
        assert!(
            !out.contains("disabled"),
            "empty disabled must be omitted: {out}"
        );
    }

    #[test]
    fn request_still_rejects_unknown_fields() {
        let yaml = "method: GET\nurl: https://api/x\nbogus: 1\n";
        assert!(serde_yaml::from_str::<Request>(yaml).is_err());
    }

    // ---- Parallel: serde round-trip ----

    #[test]
    fn parses_parallel_step() {
        let y = r#"
version: 1
name: par
steps:
  - id: "01HX0000000000000000000010"
    name: fanout
    type: parallel
    branches:
      - name: user
        steps:
          - id: "01HX0000000000000000000011"
            name: get-user
            type: http
            request: { method: GET, url: "/api/user" }
            assert: []
      - name: feed
        steps:
          - id: "01HX0000000000000000000012"
            name: get-feed
            type: http
            request: { method: GET, url: "/api/feed" }
            assert: []
"#;
        let s = Scenario::from_yaml(y).expect("parses parallel");
        let Step::Parallel(p) = &s.steps[0] else {
            panic!("expected parallel");
        };
        assert_eq!(p.id, "01HX0000000000000000000010");
        assert_eq!(p.branches.len(), 2);
        assert_eq!(p.branches[0].name, "user");
        assert_eq!(p.branches[0].steps.len(), 1);
        assert!(matches!(p.branches[0].steps[0], Step::Http(_)));
    }

    #[test]
    fn parallel_round_trips_keeping_inner_type_tag() {
        let y = r#"
version: 1
name: par
steps:
  - id: "01HX0000000000000000000010"
    name: fanout
    type: parallel
    branches:
      - name: a
        steps:
          - id: "01HX0000000000000000000011"
            name: h
            type: http
            request: { method: GET, url: "/x" }
            assert: []
"#;
        let s = Scenario::from_yaml(y).unwrap();
        let out = s.to_yaml().unwrap();
        assert!(out.contains("type: parallel"), "keeps parallel tag:\n{out}");
        assert!(out.contains("type: http"), "inner http keeps tag:\n{out}");
        assert!(out.contains("branches:"));
        let s2 = Scenario::from_yaml(&out).unwrap();
        assert_eq!(s, s2, "parallel must round-trip");
    }

    #[test]
    fn parallel_rejects_unknown_field() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000010"
    name: p
    type: parallel
    branches: []
    bogus: 1
"#;
        assert!(Scenario::from_yaml(y).is_err());
    }

    #[test]
    fn branch_output_var_names_lists_extract_vars() {
        let b = Branch {
            name: "user".into(),
            steps: vec![Step::Http(HttpStep {
                id: "01HX0000000000000000000011".into(),
                name: "h".into(),
                request: Request {
                    method: HttpMethod::Get,
                    url: "/u".into(),
                    headers: BTreeMap::new(),
                    body: None,
                    disabled: DisabledRows::default(),
                },
                assert: vec![],
                extract: vec![
                    Extract::Body {
                        var: "id".into(),
                        path: "$.id".into(),
                    },
                    Extract::Status { var: "code".into() },
                ],
                timeout_seconds: None,
                think_time: None,
            })],
        };
        assert_eq!(b.output_var_names(), vec!["id", "code"]);
    }

    #[test]
    fn http_step_timeout_seconds_round_trips_and_omits_when_absent() {
        let with = r#"
version: 1
name: t
steps:
  - id: "01HX0000000000000000000051"
    name: slow
    type: http
    timeout_seconds: 5
    request: { method: GET, url: "/x" }
    assert: []
"#;
        let s = Scenario::from_yaml(with).unwrap();
        let Step::Http(h) = &s.steps[0] else {
            panic!("http")
        };
        assert_eq!(h.timeout_seconds, Some(5));
        let out = s.to_yaml().unwrap();
        assert!(out.contains("timeout_seconds: 5"), "round-trips:\n{out}");
        let s2 = Scenario::from_yaml(&out).unwrap();
        assert_eq!(s, s2);

        // Absent → field None → key omitted on serialize (byte-identical).
        let without = r#"
version: 1
name: t
steps:
  - id: "01HX0000000000000000000052"
    name: x
    type: http
    request: { method: GET, url: "/x" }
    assert: []
"#;
        let s3 = Scenario::from_yaml(without).unwrap();
        let Step::Http(h3) = &s3.steps[0] else {
            panic!("http")
        };
        assert_eq!(h3.timeout_seconds, None);
        assert!(!s3.to_yaml().unwrap().contains("timeout_seconds"));
    }

    #[test]
    fn http_step_think_time_round_trips_and_omits_when_absent() {
        let yaml = r#"
version: 1
name: t
steps:
  - type: http
    id: s1
    name: pace
    request:
      method: GET
      url: http://x/
    think_time:
      min_ms: 100
      max_ms: 500
"#;
        let s = Scenario::from_yaml(yaml).unwrap();
        let Step::Http(h) = &s.steps[0] else {
            panic!("expected http")
        };
        assert_eq!(
            h.think_time,
            Some(ThinkTime {
                min_ms: 100,
                max_ms: 500
            })
        );
        let out = s.to_yaml().unwrap();
        assert!(out.contains("min_ms: 100"), "round-trips:\n{out}");

        // absent → no key (byte-identical to pre-feature YAML)
        let yaml2 = r#"
version: 1
name: t
steps:
  - type: http
    id: s2
    name: nopace
    request:
      method: GET
      url: http://x/
"#;
        let s2 = Scenario::from_yaml(yaml2).unwrap();
        let Step::Http(h2) = &s2.steps[0] else {
            panic!()
        };
        assert_eq!(h2.think_time, None);
        assert!(!s2.to_yaml().unwrap().contains("think_time"));
    }

    #[test]
    fn scenario_default_think_time_round_trips_and_omits_when_absent() {
        let yaml = "version: 1
name: t
default_think_time:
  min_ms: 500
  max_ms: 1000
steps:
  - type: http
    id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
    name: s
    request:
      method: GET
      url: http://x/
";
        let s = Scenario::from_yaml(yaml).unwrap();
        assert_eq!(
            s.default_think_time,
            Some(ThinkTime {
                min_ms: 500,
                max_ms: 1000
            })
        );
        // round-trip: 재직렬화 → 재파싱해도 같은 값
        let s2 = Scenario::from_yaml(&s.to_yaml().unwrap()).unwrap();
        assert_eq!(s2.default_think_time, s.default_think_time);

        // 없으면 키 자체가 안 나간다(기존 시나리오 byte-identical)
        let bare = "version: 1
name: t
steps: []
";
        let b = Scenario::from_yaml(bare).unwrap();
        assert_eq!(b.default_think_time, None);
        assert!(!b.to_yaml().unwrap().contains("default_think_time"));
    }
}
