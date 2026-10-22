//! Monitor board configuration: wire/storage shape + validation (spec §4).
//!
//! Defaults use container-level `#[serde(default)]` with hand-written `Default`
//! impls — a field-level `#[serde(default)]` would fill `u32` with 0.

use serde::{Deserialize, Serialize};
use ulid::Ulid;

pub const MAX_PANELS: usize = 9;
pub const MAX_THRESHOLDS: usize = 5;
pub const MAX_CONDITIONS: usize = 10;
const NAME_MAX_CHARS: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FontScale {
    Small,
    Medium,
    Large,
    /// Wire string is `"xlarge"` (`XLarge` would snake_case to `"x_large"`).
    Xlarge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Blink {
    Off,
    Fail,
    SlowAndFail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisplayStyle {
    Fill,
    Border,
    Focus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionSource {
    Body,
    Header,
    Status,
    BodyText,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionOp {
    Exists,
    NotEmpty,
    Eq,
    Ne,
    Contains,
    Gt,
    Lt,
}

impl ConditionOp {
    pub fn needs_value(self) -> bool {
        matches!(
            self,
            Self::Eq | Self::Ne | Self::Contains | Self::Gt | Self::Lt
        )
    }

    pub fn has_flags(self) -> bool {
        matches!(self, Self::Eq | Self::Ne | Self::Contains)
    }
}

impl ConditionSource {
    pub fn allows(self, op: ConditionOp) -> bool {
        use ConditionOp as O;
        match self {
            Self::Body | Self::Header => true,
            Self::Status => matches!(op, O::Eq | O::Ne | O::Gt | O::Lt),
            Self::BodyText => matches!(op, O::Contains | O::NotEmpty),
        }
    }
}

/// `s.trim().parse::<f64>()`, finite only.
pub fn parse_finite(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Condition {
    pub step_id: String,
    pub source: ConditionSource,
    pub path: String,
    pub op: ConditionOp,
    pub value: String,
    pub ignore_case: bool,
    pub trim: bool,
}

impl Default for Condition {
    fn default() -> Self {
        Self {
            step_id: String::new(),
            source: ConditionSource::Body,
            path: String::new(),
            op: ConditionOp::Exists,
            value: String::new(),
            ignore_case: false,
            trim: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LatencySource {
    Total,
    Step { step_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Threshold {
    pub ms: u32,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PanelConfig {
    pub id: String,
    pub title: String,
    pub scenario_id: String,
    pub environment_id: Option<String>,
    pub interval_seconds: u32,
    pub timeout_seconds: u32,
    pub latency_source: LatencySource,
    pub thresholds: Vec<Threshold>,
    pub bar_count: u32,
    pub graph_max_ms: u32,
    pub conditions: Vec<Condition>,
}

impl Default for PanelConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            scenario_id: String::new(),
            environment_id: None,
            interval_seconds: 10,
            timeout_seconds: 5,
            latency_source: LatencySource::Total,
            thresholds: Vec::new(),
            bar_count: 60,
            graph_max_ms: 2000,
            conditions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BoardConfig {
    pub font_scale: FontScale,
    pub blink: Blink,
    pub display_style: DisplayStyle,
    pub panels: Vec<PanelConfig>,
}

impl Default for BoardConfig {
    fn default() -> Self {
        Self {
            font_scale: FontScale::Large,
            blink: Blink::Fail,
            display_style: DisplayStyle::Border,
            panels: Vec::new(),
        }
    }
}

fn in_range(v: u32, lo: u32, hi: u32) -> bool {
    (lo..=hi).contains(&v)
}

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn check_name(label: &str, trimmed: &str) -> Result<(), String> {
    let n = trimmed.chars().count();
    if !(1..=NAME_MAX_CHARS).contains(&n) {
        return Err(format!("{label}은(는) 1~{NAME_MAX_CHARS}자여야 합니다"));
    }
    Ok(())
}

/// Validates one panel in place: assigns a ULID when `id` is empty, trims the
/// title. Independent of board-level checks (also used by the preview endpoint).
pub fn validate_panel(p: &mut PanelConfig) -> Result<(), String> {
    p.title = p.title.trim().to_string();
    check_name("칸 제목", &p.title)?;
    if p.id.is_empty() {
        p.id = Ulid::new().to_string();
    } else if Ulid::from_string(&p.id).is_err() {
        return Err("칸 id가 올바른 ULID 형식이 아닙니다".into());
    }
    if p.scenario_id.trim().is_empty() {
        return Err("시나리오를 선택해야 합니다".into());
    }
    if !in_range(p.interval_seconds, 1, 3600) {
        return Err("점검 주기는 1~3600초여야 합니다".into());
    }
    if !in_range(p.timeout_seconds, 1, 30) {
        return Err("제한 시간은 1~30초여야 합니다".into());
    }
    if p.thresholds.len() > MAX_THRESHOLDS {
        return Err(format!(
            "기준선은 최대 {MAX_THRESHOLDS}개까지 설정할 수 있습니다"
        ));
    }
    let mut prev = 0u32;
    for t in &p.thresholds {
        if !in_range(t.ms, 1, 600_000) {
            return Err("기준선 응답속도는 1~600000ms여야 합니다".into());
        }
        if t.ms <= prev {
            return Err("기준선 응답속도는 엄격한 오름차순이어야 합니다".into());
        }
        prev = t.ms;
        if !is_hex_color(&t.color) {
            return Err("기준선 색상은 #rrggbb 형식이어야 합니다".into());
        }
    }
    if !in_range(p.bar_count, 10, 300) {
        return Err("막대 개수는 10~300개여야 합니다".into());
    }
    if !in_range(p.graph_max_ms, 100, 600_000) {
        return Err("그래프 최대값은 100~600000ms여야 합니다".into());
    }
    validate_conditions(&mut p.conditions)
}

fn validate_conditions(conds: &mut [Condition]) -> Result<(), String> {
    if conds.len() > MAX_CONDITIONS {
        return Err(format!(
            "성공 조건은 최대 {MAX_CONDITIONS}개까지 설정할 수 있습니다"
        ));
    }
    for c in conds {
        if Ulid::from_string(&c.step_id).is_err() {
            return Err("조건 스텝 id가 올바른 ULID 형식이 아닙니다".into());
        }
        if !c.source.allows(c.op) {
            return Err("이 대상에 쓸 수 없는 조건 규칙입니다".into());
        }
        match c.source {
            ConditionSource::Body => {
                if !(1..=500).contains(&c.path.chars().count()) {
                    return Err("본문 경로는 1~500자여야 합니다".into());
                }
                if !handicap_engine::extract::jsonpath_is_valid(&c.path) {
                    return Err("본문 경로(JSONPath)가 올바르지 않습니다".into());
                }
                // Chained descendant segments blow up the evaluator's node list
                // (no dedup) on deeply nested bodies, and conditions run unattended
                // every interval inside the controller — allow at most one `..`.
                if handicap_engine::extract::jsonpath_descendant_segments(&c.path) > 1 {
                    return Err("본문 경로(JSONPath)가 올바르지 않습니다".into());
                }
                // A root query inside a filter (`$[?$[*]]`) is re-evaluated in full
                // for every candidate node (no caching), synchronously after the
                // check's timeout — nesting makes it polynomial. Only the leading `$`.
                if handicap_engine::extract::jsonpath_root_refs(&c.path) > 1 {
                    return Err("본문 경로(JSONPath)가 올바르지 않습니다".into());
                }
                // Any filter costs per tested node with no caching (root re-query,
                // per-node regex compile in match()/search(), nesting) — reject all
                // filters; the two checks above stay as defense in depth.
                if handicap_engine::extract::jsonpath_filter_selectors(&c.path) > 0 {
                    return Err("본문 경로(JSONPath)가 올바르지 않습니다".into());
                }
            }
            ConditionSource::Header => {
                c.path = c.path.trim().to_string();
                if !(1..=200).contains(&c.path.chars().count()) {
                    return Err("헤더 이름은 1~200자여야 합니다".into());
                }
            }
            ConditionSource::Status | ConditionSource::BodyText => c.path.clear(),
        }
        if !c.op.needs_value() {
            c.value.clear();
        }
        if !c.op.has_flags() {
            c.ignore_case = false;
            c.trim = false;
        }
        if c.value.chars().count() > 200 {
            return Err("비교값은 200자 이하여야 합니다".into());
        }
        if c.op == ConditionOp::Contains && c.value.is_empty() {
            return Err("포함 조건의 비교값을 입력해야 합니다".into());
        }
        if matches!(c.op, ConditionOp::Gt | ConditionOp::Lt) && parse_finite(&c.value).is_none() {
            return Err("크다·작다 조건의 비교값은 숫자여야 합니다".into());
        }
    }
    Ok(())
}

/// Validates a whole board in place; returns the trimmed board name.
pub fn validate_and_normalize(name: &str, cfg: &mut BoardConfig) -> Result<String, String> {
    let name = name.trim().to_string();
    check_name("보드 이름", &name)?;
    if !(1..=MAX_PANELS).contains(&cfg.panels.len()) {
        return Err(format!("칸은 1~{MAX_PANELS}개여야 합니다"));
    }
    for p in &mut cfg.panels {
        validate_panel(p)?;
    }
    let mut seen = std::collections::HashSet::new();
    for p in &cfg.panels {
        if !seen.insert(p.id.as_str()) {
            return Err("칸 id가 중복되었습니다".into());
        }
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ULID_A: &str = "01J0000000000000000000000A";
    const ULID_B: &str = "01J0000000000000000000000B";

    fn panel() -> PanelConfig {
        PanelConfig {
            scenario_id: "S".into(),
            title: "t".into(),
            ..PanelConfig::default()
        }
    }

    fn board() -> BoardConfig {
        BoardConfig {
            panels: vec![panel()],
            ..BoardConfig::default()
        }
    }

    #[test]
    fn defaults_fill_missing_fields() {
        let c: BoardConfig = serde_json::from_str(r#"{"panels":[{"scenario_id":"S"}]}"#).unwrap();
        assert_eq!(c.font_scale, FontScale::Large);
        assert_eq!(c.blink, Blink::Fail);
        let p = &c.panels[0];
        assert_eq!(p.interval_seconds, 10);
        assert_eq!(p.timeout_seconds, 5);
        assert_eq!(p.bar_count, 60);
        assert_eq!(p.graph_max_ms, 2000);
        assert!(p.thresholds.is_empty());
        assert_eq!(p.latency_source, LatencySource::Total);
        assert_eq!(p.environment_id, None);
        assert_eq!(p.id, "");
        assert_eq!(c.display_style, DisplayStyle::Border);
        assert!(p.conditions.is_empty());
        let cd: Condition = serde_json::from_str(r#"{"step_id":"S"}"#).unwrap();
        assert_eq!(cd.source, ConditionSource::Body);
        assert_eq!(cd.op, ConditionOp::Exists);
        assert!(!cd.ignore_case && !cd.trim);
    }

    #[test]
    fn enum_wire_strings_roundtrip() {
        for (v, s) in [
            (FontScale::Small, "small"),
            (FontScale::Medium, "medium"),
            (FontScale::Large, "large"),
            (FontScale::Xlarge, "xlarge"),
        ] {
            assert_eq!(serde_json::to_string(&v).unwrap(), format!("\"{s}\""));
            assert_eq!(
                serde_json::from_str::<FontScale>(&format!("\"{s}\"")).unwrap(),
                v
            );
        }
        for (v, s) in [
            (Blink::Off, "off"),
            (Blink::Fail, "fail"),
            (Blink::SlowAndFail, "slow_and_fail"),
        ] {
            assert_eq!(serde_json::to_string(&v).unwrap(), format!("\"{s}\""));
            assert_eq!(
                serde_json::from_str::<Blink>(&format!("\"{s}\"")).unwrap(),
                v
            );
        }
        for (v, s) in [
            (DisplayStyle::Fill, "fill"),
            (DisplayStyle::Border, "border"),
            (DisplayStyle::Focus, "focus"),
        ] {
            assert_eq!(serde_json::to_string(&v).unwrap(), format!("\"{s}\""));
            assert_eq!(
                serde_json::from_str::<DisplayStyle>(&format!("\"{s}\"")).unwrap(),
                v
            );
        }
        for (v, s) in [
            (ConditionSource::Body, "body"),
            (ConditionSource::Header, "header"),
            (ConditionSource::Status, "status"),
            (ConditionSource::BodyText, "body_text"),
        ] {
            assert_eq!(serde_json::to_string(&v).unwrap(), format!("\"{s}\""));
            assert_eq!(
                serde_json::from_str::<ConditionSource>(&format!("\"{s}\"")).unwrap(),
                v
            );
        }
        for (v, s) in [
            (ConditionOp::Exists, "exists"),
            (ConditionOp::NotEmpty, "not_empty"),
            (ConditionOp::Eq, "eq"),
            (ConditionOp::Ne, "ne"),
            (ConditionOp::Contains, "contains"),
            (ConditionOp::Gt, "gt"),
            (ConditionOp::Lt, "lt"),
        ] {
            assert_eq!(serde_json::to_string(&v).unwrap(), format!("\"{s}\""));
            assert_eq!(
                serde_json::from_str::<ConditionOp>(&format!("\"{s}\"")).unwrap(),
                v
            );
        }
        let t = LatencySource::Total;
        assert_eq!(serde_json::to_string(&t).unwrap(), r#"{"kind":"total"}"#);
        assert_eq!(
            serde_json::from_str::<LatencySource>(r#"{"kind":"total"}"#).unwrap(),
            t
        );
        let s = LatencySource::Step {
            step_id: ULID_A.into(),
        };
        let js = format!(r#"{{"kind":"step","step_id":"{ULID_A}"}}"#);
        assert_eq!(serde_json::to_string(&s).unwrap(), js);
        assert_eq!(serde_json::from_str::<LatencySource>(&js).unwrap(), s);
    }

    fn th(ms: u32, color: &str) -> Threshold {
        Threshold {
            ms,
            color: color.into(),
        }
    }

    #[test]
    fn validate_rejects_out_of_range() {
        let ok = |c: &mut BoardConfig| validate_and_normalize("보드", c);
        assert!(ok(&mut board()).is_ok());

        type Mutation = Box<dyn Fn(&mut PanelConfig)>;
        let cases: Vec<(&str, Mutation)> = vec![
            ("interval 0", Box::new(|p| p.interval_seconds = 0)),
            ("interval 3601", Box::new(|p| p.interval_seconds = 3601)),
            ("timeout 0", Box::new(|p| p.timeout_seconds = 0)),
            ("timeout 31", Box::new(|p| p.timeout_seconds = 31)),
            (
                "6 thresholds",
                Box::new(|p| p.thresholds = (1..=6).map(|i| th(i * 100, "#aabbcc")).collect()),
            ),
            (
                "equal thresholds",
                Box::new(|p| p.thresholds = vec![th(700, "#aabbcc"), th(700, "#aabbcc")]),
            ),
            (
                "descending thresholds",
                Box::new(|p| p.thresholds = vec![th(800, "#aabbcc"), th(700, "#aabbcc")]),
            ),
            (
                "threshold ms 0",
                Box::new(|p| p.thresholds = vec![th(0, "#aabbcc")]),
            ),
            (
                "threshold ms too big",
                Box::new(|p| p.thresholds = vec![th(600_001, "#aabbcc")]),
            ),
            (
                "color red",
                Box::new(|p| p.thresholds = vec![th(700, "red")]),
            ),
            (
                "color short",
                Box::new(|p| p.thresholds = vec![th(700, "#abc")]),
            ),
            (
                "color nonhex",
                Box::new(|p| p.thresholds = vec![th(700, "#gggggg")]),
            ),
            ("bar_count 9", Box::new(|p| p.bar_count = 9)),
            ("bar_count 301", Box::new(|p| p.bar_count = 301)),
            ("graph_max 99", Box::new(|p| p.graph_max_ms = 99)),
            ("graph_max big", Box::new(|p| p.graph_max_ms = 600_001)),
            ("blank title", Box::new(|p| p.title = "   ".into())),
            ("long title", Box::new(|p| p.title = "가".repeat(41))),
            ("empty scenario", Box::new(|p| p.scenario_id = "".into())),
            ("non-ulid id", Box::new(|p| p.id = "not-a-ulid".into())),
        ];
        for (name, f) in cases {
            let mut b = board();
            f(&mut b.panels[0]);
            assert!(ok(&mut b).is_err(), "{name} must be rejected");
        }

        let mut b = board();
        b.panels.clear();
        assert!(ok(&mut b).is_err(), "0 panels");
        let mut b = board();
        b.panels = (0..10).map(|_| panel()).collect();
        assert!(ok(&mut b).is_err(), "10 panels");
        let mut b = board();
        b.panels = vec![panel(), panel()];
        b.panels[0].id = ULID_A.into();
        b.panels[1].id = ULID_A.into();
        assert!(ok(&mut b).is_err(), "dup id");

        assert!(validate_and_normalize("   ", &mut board()).is_err());
        assert!(validate_and_normalize(&"가".repeat(41), &mut board()).is_err());
        assert!(validate_and_normalize(&"가".repeat(40), &mut board()).is_ok());
    }

    #[test]
    fn validate_accepts_boundaries() {
        let mut b = board();
        b.panels = (0..9).map(|_| panel()).collect();
        let p = &mut b.panels[0];
        p.interval_seconds = 3600;
        p.timeout_seconds = 30;
        p.bar_count = 300;
        p.graph_max_ms = 600_000;
        p.thresholds = vec![
            th(1, "#000000"),
            th(2, "#FFFFFF"),
            th(3, "#aabbcc"),
            th(4, "#aabbcc"),
            th(600_000, "#aabbcc"),
        ];
        assert!(validate_and_normalize("n", &mut b).is_ok());
    }

    #[test]
    fn validate_assigns_ids_and_trims() {
        let mut b = board();
        b.panels = vec![panel(), panel()];
        b.panels[0].title = "  제목  ".into();
        b.panels[1].id = ULID_B.into();
        let name = validate_and_normalize("  보드  ", &mut b).unwrap();
        assert_eq!(name, "보드");
        assert_eq!(b.panels[0].title, "제목");
        assert!(ulid::Ulid::from_string(&b.panels[0].id).is_ok());
        assert_ne!(b.panels[0].id, b.panels[1].id);
        assert_eq!(b.panels[1].id, ULID_B);
    }

    #[test]
    fn validate_panel_is_standalone() {
        let mut p = panel();
        assert!(validate_panel(&mut p).is_ok());
        assert!(!p.id.is_empty());
    }

    fn cond(source: ConditionSource, op: ConditionOp, path: &str, value: &str) -> Condition {
        Condition {
            step_id: ULID_A.into(),
            source,
            path: path.into(),
            op,
            value: value.into(),
            ..Condition::default()
        }
    }

    fn with(c: Condition) -> PanelConfig {
        PanelConfig {
            conditions: vec![c],
            ..panel()
        }
    }

    #[test]
    fn conditions_validate_rejects() {
        use ConditionOp as O;
        use ConditionSource as S;
        let mut bad_step = cond(S::Body, O::Exists, "$.a", "");
        bad_step.step_id = "x".into();
        let cases: Vec<(PanelConfig, &str)> = vec![
            (
                PanelConfig {
                    conditions: (0..11)
                        .map(|_| cond(S::Body, O::Exists, "$.a", ""))
                        .collect(),
                    ..panel()
                },
                "성공 조건은 최대 10개까지 설정할 수 있습니다",
            ),
            (with(bad_step), "조건 스텝 id가 올바른 ULID 형식이 아닙니다"),
            (
                with(cond(S::Status, O::Exists, "", "")),
                "이 대상에 쓸 수 없는 조건 규칙입니다",
            ),
            (
                with(cond(S::BodyText, O::Eq, "", "a")),
                "이 대상에 쓸 수 없는 조건 규칙입니다",
            ),
            (
                with(cond(S::Body, O::Exists, "", "")),
                "본문 경로는 1~500자여야 합니다",
            ),
            (
                with(cond(
                    S::Body,
                    O::Exists,
                    &format!("$.{}", "a".repeat(499)),
                    "",
                )),
                "본문 경로는 1~500자여야 합니다",
            ),
            (
                with(cond(S::Body, O::Exists, "a.b", "")),
                "본문 경로(JSONPath)가 올바르지 않습니다",
            ),
            (
                with(cond(S::Body, O::Exists, "$..*..*", "")),
                "본문 경로(JSONPath)가 올바르지 않습니다",
            ),
            (
                with(cond(S::Body, O::Exists, "$[?$[*]]", "")),
                "본문 경로(JSONPath)가 올바르지 않습니다",
            ),
            (
                with(cond(S::Body, O::Exists, "$[?$[?$..*]]", "")),
                "본문 경로(JSONPath)가 올바르지 않습니다",
            ),
            (
                with(cond(S::Body, O::Exists, "$..[?match(@, 'a')]", "")),
                "본문 경로(JSONPath)가 올바르지 않습니다",
            ),
            (
                with(cond(S::Body, O::Exists, "$[?@.code == 'E1']", "")),
                "본문 경로(JSONPath)가 올바르지 않습니다",
            ),
            (
                with(cond(S::Header, O::Exists, "   ", "")),
                "헤더 이름은 1~200자여야 합니다",
            ),
            (
                with(cond(S::Header, O::Exists, &"h".repeat(201), "")),
                "헤더 이름은 1~200자여야 합니다",
            ),
            (
                with(cond(S::Body, O::Eq, "$.a", &"v".repeat(201))),
                "비교값은 200자 이하여야 합니다",
            ),
            (
                with(cond(S::Body, O::Contains, "$.a", "")),
                "포함 조건의 비교값을 입력해야 합니다",
            ),
            (
                with(cond(S::Body, O::Gt, "$.a", "abc")),
                "크다·작다 조건의 비교값은 숫자여야 합니다",
            ),
            (
                with(cond(S::Body, O::Gt, "$.a", "inf")),
                "크다·작다 조건의 비교값은 숫자여야 합니다",
            ),
            (
                with(cond(S::Body, O::Lt, "$.a", "")),
                "크다·작다 조건의 비교값은 숫자여야 합니다",
            ),
        ];
        for (mut p, msg) in cases {
            assert_eq!(validate_panel(&mut p), Err(msg.to_string()), "{msg}");
        }
    }

    #[test]
    fn conditions_validate_normalizes() {
        use ConditionOp as O;
        use ConditionSource as S;
        let mut p = with(cond(S::Status, O::Eq, "$.x", "200"));
        validate_panel(&mut p).unwrap();
        assert_eq!(p.conditions[0].path, "");
        assert_eq!(p.conditions[0].value, "200");

        let mut p = with(cond(S::BodyText, O::Contains, "$.x", "ok"));
        validate_panel(&mut p).unwrap();
        assert_eq!(p.conditions[0].path, "");

        let mut p = with(cond(S::Body, O::Exists, "$.a", "z"));
        validate_panel(&mut p).unwrap();
        assert_eq!(p.conditions[0].value, "");

        let mut p = with(cond(S::Body, O::Exists, "$.a", &"v".repeat(201)));
        validate_panel(&mut p).unwrap();
        assert_eq!(p.conditions[0].value, "");

        let mut c = cond(S::Body, O::Gt, "$.a", "1");
        c.ignore_case = true;
        c.trim = true;
        let mut p = with(c);
        validate_panel(&mut p).unwrap();
        assert!(!p.conditions[0].ignore_case && !p.conditions[0].trim);

        let mut p = with(cond(S::Header, O::Exists, "  X-A ", ""));
        validate_panel(&mut p).unwrap();
        assert_eq!(p.conditions[0].path, "X-A");

        let mut c = cond(S::Body, O::Eq, "$.a", "v");
        c.ignore_case = true;
        let mut p = with(c);
        validate_panel(&mut p).unwrap();
        assert!(p.conditions[0].ignore_case);
    }

    #[test]
    fn conditions_validate_accepts_boundaries() {
        use ConditionOp as O;
        use ConditionSource as S;
        let mut p = PanelConfig {
            conditions: (0..10)
                .map(|_| cond(S::Body, O::Exists, "$.a", ""))
                .collect(),
            ..panel()
        };
        assert!(validate_panel(&mut p).is_ok());
        let long = format!("$.{}", "a".repeat(498));
        assert_eq!(long.chars().count(), 500);
        assert!(validate_panel(&mut with(cond(S::Body, O::Exists, &long, ""))).is_ok());
        assert!(validate_panel(&mut with(cond(S::Body, O::Eq, "$.a", &"v".repeat(200)))).is_ok());
        assert!(validate_panel(&mut with(cond(S::Body, O::Exists, "$..resultCode", ""))).is_ok());
        assert!(handicap_engine::extract::jsonpath_is_valid("$['a?$b']"));
        assert!(validate_panel(&mut with(cond(S::Body, O::Exists, "$['a?$b']", ""))).is_ok());
        assert!(validate_panel(&mut with(cond(S::Body, O::Gt, "$.a", " 12.5 "))).is_ok());
        assert_eq!(parse_finite(" 12.5 "), Some(12.5));
        assert_eq!(parse_finite("inf"), None);
    }
}
