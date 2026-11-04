//! Monitor board configuration: wire/storage shape + validation (spec §4).
//!
//! Defaults use container-level `#[serde(default)]` with hand-written `Default`
//! impls — a field-level `#[serde(default)]` would fill `u32` with 0.

use serde::{Deserialize, Serialize};
use ulid::Ulid;

pub const MAX_PANELS: usize = 9;
pub const MAX_THRESHOLDS: usize = 5;
pub const MAX_CONDITIONS: usize = 10;
pub const MAX_DISPLAY_ITEMS: usize = 2;
pub(crate) const NAME_MAX_CHARS: usize = 40;

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
    Gte,
    Lte,
    OneOf,
}

/// `one_of` 후보값 분해 — `split(',')` → `trim` → 빈 것 제외.
pub fn one_of_candidates(value: &str) -> Vec<&str> {
    value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

impl ConditionOp {
    pub fn needs_value(self) -> bool {
        matches!(
            self,
            Self::Eq
                | Self::Ne
                | Self::Contains
                | Self::Gt
                | Self::Lt
                | Self::Gte
                | Self::Lte
                | Self::OneOf
        )
    }

    pub fn has_flags(self) -> bool {
        matches!(self, Self::Eq | Self::Ne | Self::Contains | Self::OneOf)
    }
}

impl ConditionSource {
    pub fn allows(self, op: ConditionOp) -> bool {
        use ConditionOp as O;
        match self {
            Self::Body | Self::Header => true,
            Self::Status => matches!(
                op,
                O::Eq | O::Ne | O::Gt | O::Lt | O::Gte | O::Lte | O::OneOf
            ),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisplaySource {
    Body,
    Header,
    Status,
}

/// 벽에 판정과 무관하게 보여 줄 값 1개(칸당 최대 `MAX_DISPLAY_ITEMS`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DisplayItem {
    pub step_id: String,
    pub source: DisplaySource,
    pub path: String,
}

impl Default for DisplayItem {
    fn default() -> Self {
        Self {
            step_id: String::new(),
            source: DisplaySource::Body,
            path: String::new(),
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
    pub display_items: Vec<DisplayItem>,
    /// 소속 점검 묶음 id. None = 단독 실행(직렬화 생략).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// 볼 스텝 id. None = 흐름 전체(직렬화 생략).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
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
            display_items: Vec::new(),
            group_id: None,
            step_id: None,
        }
    }
}

/// 점검 묶음 — 한 번의 실행(시나리오·환경·주기)을 여러 스텝 칸이 공유한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CheckGroup {
    pub id: String,
    pub scenario_id: String,
    pub environment_id: Option<String>,
    pub interval_seconds: u32,
}

impl Default for CheckGroup {
    fn default() -> Self {
        Self {
            id: String::new(),
            scenario_id: String::new(),
            environment_id: None,
            interval_seconds: 10,
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
    /// 벽의 평균·최대 줄 표시 여부(표시 전용 — 점검 동작 무관).
    pub show_latency_stats: bool,
    /// 점검 하나의 기록 본문 예산(KB) — 보드 단위.
    pub record_limit_kb: u32,
    /// 점검 묶음(없으면 직렬화 생략 — 묶음 없는 보드는 바이트 동일).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<CheckGroup>,
}

pub const RECORD_LIMIT_KB_DEFAULT: u32 = 128;
pub const RECORD_LIMIT_KB_RANGE: std::ops::RangeInclusive<u32> = 16..=1024;

impl Default for BoardConfig {
    fn default() -> Self {
        Self {
            show_latency_stats: true,
            record_limit_kb: RECORD_LIMIT_KB_DEFAULT,
            font_scale: FontScale::Large,
            blink: Blink::Fail,
            display_style: DisplayStyle::Border,
            panels: Vec::new(),
            groups: Vec::new(),
        }
    }
}

/// 묶음 칸의 시나리오·환경·주기를 소속 묶음 값으로 덮어쓴다(묶음 값이 권위).
pub fn apply_group_mirror(cfg: &mut BoardConfig) {
    for p in &mut cfg.panels {
        let Some(gid) = &p.group_id else { continue };
        if let Some(g) = cfg.groups.iter().find(|g| &g.id == gid) {
            p.scenario_id.clone_from(&g.scenario_id);
            p.environment_id.clone_from(&g.environment_id);
            p.interval_seconds = g.interval_seconds;
        }
    }
}

/// 스텝 칸(`step_id: Some`)의 응답 시간 기준·조건·표시 값을 칸의 스텝으로 맞춘다.
pub fn normalize_step_panel(p: &mut PanelConfig) {
    let Some(step) = p.step_id.clone() else {
        return;
    };
    p.latency_source = LatencySource::Step {
        step_id: step.clone(),
    };
    for c in &mut p.conditions {
        c.step_id.clone_from(&step);
    }
    for d in &mut p.display_items {
        d.step_id.clone_from(&step);
    }
}

/// 칸 `step_id`(있으면)의 ULID 형식 검사 — `normalize_step_panel` **전에** 부른다
/// (정규화가 잘못된 id를 조건·표시 항목에 복사해 다른 문구로 바뀌지 않게). 존재 여부는 실행 시 판정.
pub fn check_step_id(p: &PanelConfig) -> Result<(), String> {
    match &p.step_id {
        Some(s) if Ulid::from_string(s).is_err() => {
            Err("스텝 id가 올바른 ULID 형식이 아닙니다".into())
        }
        _ => Ok(()),
    }
}

fn validate_groups(cfg: &mut BoardConfig) -> Result<(), String> {
    // panels 첫 등장 순으로 정렬(칸 없는 묶음은 원래 순서대로 뒤 — 안정 정렬).
    let first = |g: &CheckGroup| {
        cfg.panels
            .iter()
            .position(|p| p.group_id.as_deref() == Some(g.id.as_str()))
            .unwrap_or(usize::MAX)
    };
    let mut keyed: Vec<(usize, CheckGroup)> =
        cfg.groups.drain(..).map(|g| (first(&g), g)).collect();
    keyed.sort_by_key(|(k, _)| *k);
    cfg.groups = keyed.into_iter().map(|(_, g)| g).collect();

    let mut seen = std::collections::HashSet::new();
    for (i, g) in cfg.groups.iter().enumerate() {
        let n = i + 1;
        if Ulid::from_string(&g.id).is_err() {
            return Err(format!(
                "점검 묶음 {n}: 묶음 id가 올바른 ULID 형식이 아닙니다"
            ));
        }
        if !seen.insert(g.id.as_str()) {
            return Err(format!("점검 묶음 {n}: 묶음 id가 중복됩니다"));
        }
        if g.scenario_id.trim().is_empty() {
            return Err(format!("점검 묶음 {n}: 시나리오를 선택해야 합니다"));
        }
        if !in_range(g.interval_seconds, 1, 3600) {
            return Err(format!("점검 묶음 {n}: 점검 주기는 1~3600초여야 합니다"));
        }
        if !cfg
            .panels
            .iter()
            .any(|p| p.group_id.as_deref() == Some(g.id.as_str()))
        {
            return Err(format!("점검 묶음 {n}: 칸이 없는 점검 묶음입니다"));
        }
    }
    // 칸 배치: 존재 · 연속 · 묶음 칸은 스텝 필수.
    let mut closed: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut prev: Option<&str> = None;
    for (i, p) in cfg.panels.iter().enumerate() {
        let n = i + 1;
        let cur = p.group_id.as_deref();
        if let Some(gid) = cur {
            if !cfg.groups.iter().any(|g| g.id == gid) {
                return Err(format!("칸 {n}: 없는 점검 묶음을 가리킵니다"));
            }
            if prev != Some(gid) && closed.contains(gid) {
                return Err(format!("칸 {n}: 같은 점검 묶음의 칸은 붙어 있어야 합니다"));
            }
            if p.step_id.is_none() {
                return Err(format!("칸 {n}: 점검 묶음 칸은 볼 스텝을 골라야 합니다"));
            }
        }
        if prev != cur {
            if let Some(pg) = prev {
                closed.insert(pg);
            }
        }
        prev = cur;
    }
    Ok(())
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
    validate_conditions(&mut p.conditions)?;
    validate_display_items(&mut p.display_items)
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
                // Conditions run unattended every interval inside the controller, and
                // the evaluator neither caches nor dedups (filters, selector lists,
                // chained `..` blow up) — allow only the simple-path subset.
                if !handicap_engine::extract::jsonpath_is_simple(&c.path) {
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
        if matches!(
            c.op,
            ConditionOp::Gt | ConditionOp::Lt | ConditionOp::Gte | ConditionOp::Lte
        ) && parse_finite(&c.value).is_none()
        {
            return Err("크기 비교 조건(>, <, ≥, ≤)의 비교값은 숫자여야 합니다".into());
        }
        if c.op == ConditionOp::OneOf && one_of_candidates(&c.value).is_empty() {
            return Err("여러 값 중 하나(∈) 조건의 후보값을 하나 이상 입력해야 합니다".into());
        }
    }
    Ok(())
}

// Keep in sync with AUTH_HEADERS in ui/src/components/monitor/PreviewResult.tsx.
pub(crate) const AUTH_HEADERS: [&str; 4] = [
    "set-cookie",
    "cookie",
    "authorization",
    "proxy-authorization",
];

fn validate_display_items(items: &mut [DisplayItem]) -> Result<(), String> {
    if items.len() > MAX_DISPLAY_ITEMS {
        return Err(format!(
            "화면 표시 항목은 최대 {MAX_DISPLAY_ITEMS}개까지 설정할 수 있습니다"
        ));
    }
    for it in items {
        if Ulid::from_string(&it.step_id).is_err() {
            return Err("화면 표시 항목 스텝 id가 올바른 ULID 형식이 아닙니다".into());
        }
        match it.source {
            DisplaySource::Body => {
                if !(1..=500).contains(&it.path.chars().count()) {
                    return Err("화면 표시 항목 본문 경로는 1~500자여야 합니다".into());
                }
                // Same unattended-evaluation cost argument as conditions: simple subset only.
                if !handicap_engine::extract::jsonpath_is_valid(&it.path)
                    || !handicap_engine::extract::jsonpath_is_simple(&it.path)
                {
                    return Err("화면 표시 항목 본문 경로(JSONPath)가 올바르지 않습니다".into());
                }
            }
            DisplaySource::Header => {
                it.path = it.path.trim().to_string();
                if !(1..=200).contains(&it.path.chars().count()) {
                    return Err("화면 표시 항목 헤더 이름은 1~200자여야 합니다".into());
                }
                if AUTH_HEADERS.iter().any(|h| it.path.eq_ignore_ascii_case(h)) {
                    return Err("화면 표시 항목에는 인증 헤더를 쓸 수 없습니다".into());
                }
            }
            DisplaySource::Status => it.path.clear(),
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
    validate_groups(cfg)?;
    for (i, p) in cfg.panels.iter().enumerate() {
        check_step_id(p).map_err(|e| format!("칸 {}: {e}", i + 1))?;
    }
    apply_group_mirror(cfg);
    for p in &mut cfg.panels {
        normalize_step_panel(p);
    }
    for (i, p) in cfg.panels.iter_mut().enumerate() {
        validate_panel(p).map_err(|e| format!("칸 {}: {e}", i + 1))?;
    }
    let mut seen = std::collections::HashSet::new();
    for p in &cfg.panels {
        if !seen.insert(p.id.as_str()) {
            return Err("칸 id가 중복되었습니다".into());
        }
    }
    if !RECORD_LIMIT_KB_RANGE.contains(&cfg.record_limit_kb) {
        return Err("점검 기록 상한은 16~1024KB여야 합니다".into());
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
    fn record_limit_default_128() {
        assert_eq!(BoardConfig::default().record_limit_kb, 128);
        let c: BoardConfig = serde_json::from_str(r#"{"panels":[{"scenario_id":"S"}]}"#).unwrap();
        assert_eq!(c.record_limit_kb, RECORD_LIMIT_KB_DEFAULT);
        assert_eq!(c.record_limit_kb, 128);
    }

    #[test]
    fn record_limit_range() {
        for (kb, ok) in [(15u32, false), (16, true), (1024, true), (1025, false)] {
            let mut b = board();
            b.record_limit_kb = kb;
            let r = validate_and_normalize("보드", &mut b);
            if ok {
                assert!(r.is_ok(), "{kb}");
            } else {
                assert_eq!(
                    r.unwrap_err(),
                    "점검 기록 상한은 16~1024KB여야 합니다",
                    "{kb}"
                );
            }
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
        assert!(c.show_latency_stats);
        assert!(BoardConfig::default().show_latency_stats);
        assert!(p.conditions.is_empty());
        assert!(p.display_items.is_empty());
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
            (ConditionOp::Gte, "gte"),
            (ConditionOp::Lte, "lte"),
            (ConditionOp::OneOf, "one_of"),
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

    #[test]
    fn panel_error_prefixed_with_index() {
        let mut b = board();
        b.panels = vec![panel(), panel()];
        b.panels[1].interval_seconds = 0;
        assert_eq!(
            validate_and_normalize("보드", &mut b),
            Err("칸 2: 점검 주기는 1~3600초여야 합니다".to_string())
        );
    }

    #[test]
    fn board_level_error_has_no_prefix() {
        let mut b = board();
        b.panels.clear();
        assert_eq!(
            validate_and_normalize("보드", &mut b),
            Err("칸은 1~9개여야 합니다".to_string())
        );
    }

    #[test]
    fn validate_panel_alone_has_no_prefix() {
        let mut p = panel();
        p.interval_seconds = 0;
        assert_eq!(
            validate_panel(&mut p),
            Err("점검 주기는 1~3600초여야 합니다".to_string())
        );
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
                with(cond(S::Body, O::Exists, "$[0,0][0,0]", "")),
                "본문 경로(JSONPath)가 올바르지 않습니다",
            ),
            (
                with(cond(S::Body, O::Exists, "$[0:1]", "")),
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
                "크기 비교 조건(>, <, ≥, ≤)의 비교값은 숫자여야 합니다",
            ),
            (
                with(cond(S::Body, O::Gt, "$.a", "inf")),
                "크기 비교 조건(>, <, ≥, ≤)의 비교값은 숫자여야 합니다",
            ),
            (
                with(cond(S::Body, O::Lt, "$.a", "")),
                "크기 비교 조건(>, <, ≥, ≤)의 비교값은 숫자여야 합니다",
            ),
            (
                with(cond(S::Body, O::Gt, "$.a", "abc")),
                "크기 비교 조건(>, <, ≥, ≤)의 비교값은 숫자여야 합니다",
            ),
            (
                with(cond(S::Body, O::Gte, "$.a", "abc")),
                "크기 비교 조건(>, <, ≥, ≤)의 비교값은 숫자여야 합니다",
            ),
            (
                with(cond(S::Body, O::Lte, "$.a", "")),
                "크기 비교 조건(>, <, ≥, ≤)의 비교값은 숫자여야 합니다",
            ),
            (
                with(cond(S::Body, O::OneOf, "$.a", " , ,")),
                "여러 값 중 하나(∈) 조건의 후보값을 하나 이상 입력해야 합니다",
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

        let mut c = cond(S::Body, O::Gte, "$.a", "1");
        c.ignore_case = true;
        let mut p = with(c);
        validate_panel(&mut p).unwrap();
        assert!(!p.conditions[0].ignore_case);

        let mut c = cond(S::Body, O::OneOf, "$.a", "a,b");
        c.ignore_case = true;
        let mut p = with(c);
        validate_panel(&mut p).unwrap();
        assert!(p.conditions[0].ignore_case);

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
    fn allows_table_new_ops() {
        use ConditionOp as O;
        use ConditionSource as S;
        for op in [O::Gte, O::Lte, O::OneOf] {
            assert!(S::Status.allows(op), "{op:?}");
        }
        for op in [O::Gte, O::OneOf] {
            let mut p = with(cond(S::BodyText, op, "", "1"));
            assert_eq!(
                validate_panel(&mut p),
                Err("이 대상에 쓸 수 없는 조건 규칙입니다".to_string()),
                "{op:?}"
            );
        }
    }

    #[test]
    fn one_of_candidates_splits_trims_skips_empty() {
        assert_eq!(one_of_candidates(" 0000 ,, ok "), vec!["0000", "ok"]);
        assert!(one_of_candidates(" , ,").is_empty());
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
        assert!(handicap_engine::extract::jsonpath_is_valid("$['a,b']"));
        assert!(validate_panel(&mut with(cond(S::Body, O::Exists, "$['a,b']", ""))).is_ok());
        assert!(validate_panel(&mut with(cond(S::Body, O::Gt, "$.a", " 12.5 "))).is_ok());
        assert_eq!(parse_finite(" 12.5 "), Some(12.5));
        assert_eq!(parse_finite("inf"), None);
    }

    fn ditem(source: DisplaySource, path: &str) -> DisplayItem {
        DisplayItem {
            step_id: ULID_A.into(),
            source,
            path: path.into(),
        }
    }

    fn with_items(items: Vec<DisplayItem>) -> PanelConfig {
        PanelConfig {
            display_items: items,
            ..panel()
        }
    }

    #[test]
    fn display_items_validate_rejects() {
        use DisplaySource as D;
        let mut bad_step = ditem(D::Body, "$.a");
        bad_step.step_id = "x".into();
        let cases: Vec<(PanelConfig, &str)> = vec![
            (
                with_items(vec![ditem(D::Status, ""); 3]),
                "화면 표시 항목은 최대 2개까지 설정할 수 있습니다",
            ),
            (
                with_items(vec![bad_step]),
                "화면 표시 항목 스텝 id가 올바른 ULID 형식이 아닙니다",
            ),
            (
                with_items(vec![ditem(D::Body, "")]),
                "화면 표시 항목 본문 경로는 1~500자여야 합니다",
            ),
            (
                with_items(vec![ditem(D::Body, "$..*..*")]),
                "화면 표시 항목 본문 경로(JSONPath)가 올바르지 않습니다",
            ),
            (
                with_items(vec![ditem(D::Body, "a.b")]),
                "화면 표시 항목 본문 경로(JSONPath)가 올바르지 않습니다",
            ),
            (
                with_items(vec![ditem(D::Header, &"h".repeat(201))]),
                "화면 표시 항목 헤더 이름은 1~200자여야 합니다",
            ),
            (
                with_items(vec![ditem(D::Header, "  ")]),
                "화면 표시 항목 헤더 이름은 1~200자여야 합니다",
            ),
            (
                with_items(vec![ditem(D::Header, "Set-Cookie")]),
                "화면 표시 항목에는 인증 헤더를 쓸 수 없습니다",
            ),
            (
                with_items(vec![ditem(D::Header, "cookie")]),
                "화면 표시 항목에는 인증 헤더를 쓸 수 없습니다",
            ),
            (
                with_items(vec![ditem(D::Header, "Authorization")]),
                "화면 표시 항목에는 인증 헤더를 쓸 수 없습니다",
            ),
            (
                with_items(vec![ditem(D::Header, " proxy-authorization ")]),
                "화면 표시 항목에는 인증 헤더를 쓸 수 없습니다",
            ),
        ];
        for (mut p, msg) in cases {
            assert_eq!(validate_panel(&mut p).unwrap_err(), msg);
        }
    }

    #[test]
    fn display_items_validate_normalizes() {
        use DisplaySource as D;
        let mut p = with_items(vec![ditem(D::Status, "$.x"), ditem(D::Header, " X-Trace ")]);
        validate_panel(&mut p).unwrap();
        assert_eq!(p.display_items[0].path, "");
        assert_eq!(p.display_items[1].path, "X-Trace");
    }

    #[test]
    fn display_items_validate_accepts_boundaries() {
        use DisplaySource as D;
        let long = format!("$.{}", "a".repeat(498));
        assert_eq!(long.chars().count(), 500);
        let mut p = with_items(vec![ditem(D::Body, &long), ditem(D::Header, "X-Trace")]);
        assert!(validate_panel(&mut p).is_ok());
        let mut p = with_items(vec![ditem(D::Header, &"h".repeat(200))]);
        assert!(validate_panel(&mut p).is_ok());
    }
}
#[cfg(test)]
mod group_tests {
    use super::*;

    fn u(n: u32) -> String {
        format!("01J{n:023}")
    }

    fn solo(title: &str) -> PanelConfig {
        PanelConfig {
            scenario_id: "S".into(),
            title: title.into(),
            ..PanelConfig::default()
        }
    }

    fn group(n: u32) -> CheckGroup {
        CheckGroup {
            id: u(n),
            scenario_id: "S".into(),
            environment_id: None,
            interval_seconds: 10,
        }
    }

    fn member(gid: u32, step: Option<u32>) -> PanelConfig {
        PanelConfig {
            group_id: Some(u(gid)),
            step_id: step.map(u),
            ..solo("m")
        }
    }

    fn cfg(groups: Vec<CheckGroup>, panels: Vec<PanelConfig>) -> BoardConfig {
        BoardConfig {
            groups,
            panels,
            ..BoardConfig::default()
        }
    }

    fn err(mut c: BoardConfig) -> String {
        validate_and_normalize("보드", &mut c).unwrap_err()
    }

    fn cond(step: &str) -> Condition {
        serde_json::from_str(&format!(r#"{{"step_id":"{step}"}}"#)).unwrap()
    }

    #[test]
    fn legacy_config_serializes_without_new_keys() {
        let c = cfg(vec![], vec![solo("t")]);
        let s = serde_json::to_string(&c).unwrap();
        assert!(!s.contains("groups"), "{s}");
        assert!(!s.contains("group_id"), "{s}");
        assert!(!s.contains("step_id"), "{s}");
    }

    #[test]
    fn mixed_board_solo_panel_serializes_without_new_keys() {
        let c = cfg(vec![group(1)], vec![member(1, Some(9)), solo("s")]);
        let v = serde_json::to_value(&c).unwrap();
        assert!(v["groups"].is_array());
        let solo_p = v["panels"][1].as_object().unwrap();
        assert!(!solo_p.contains_key("group_id"));
        assert!(!solo_p.contains_key("step_id"));
        assert!(v["panels"][0].as_object().unwrap().contains_key("group_id"));
    }

    #[test]
    fn groups_sorted_by_first_appearance() {
        let mut c = cfg(
            vec![group(2), group(1)],
            vec![member(1, Some(9)), member(2, Some(9))],
        );
        validate_and_normalize("보드", &mut c).unwrap();
        assert_eq!(c.groups[0].id, u(1));
        assert_eq!(c.groups[1].id, u(2));
    }

    #[test]
    fn mirror_overwrites_member_fields() {
        let mut g = group(1);
        g.interval_seconds = 30;
        g.environment_id = Some("E".into());
        let mut p = member(1, Some(9));
        p.scenario_id = "x".into();
        p.interval_seconds = 99;
        p.environment_id = Some("y".into());
        let mut c = cfg(vec![g], vec![p]);
        apply_group_mirror(&mut c);
        assert_eq!(c.panels[0].scenario_id, "S");
        assert_eq!(c.panels[0].interval_seconds, 30);
        assert_eq!(c.panels[0].environment_id.as_deref(), Some("E"));
    }

    #[test]
    fn step_panel_normalizes_latency_condition_display_steps() {
        let mut p = solo("t");
        p.step_id = Some(u(7));
        p.conditions = vec![cond("old")];
        p.display_items = vec![DisplayItem {
            step_id: "old".into(),
            ..DisplayItem::default()
        }];
        normalize_step_panel(&mut p);
        assert_eq!(p.latency_source, LatencySource::Step { step_id: u(7) });
        assert_eq!(p.conditions[0].step_id, u(7));
        assert_eq!(p.display_items[0].step_id, u(7));
        let mut q = solo("t");
        q.conditions = vec![cond("old")];
        normalize_step_panel(&mut q);
        assert_eq!(q.conditions[0].step_id, "old");
    }

    #[test]
    fn validate_applies_mirror_and_step_normalization() {
        let mut g = group(1);
        g.interval_seconds = 30;
        let mut c = cfg(vec![g], vec![member(1, Some(9))]);
        validate_and_normalize("보드", &mut c).unwrap();
        assert_eq!(c.panels[0].interval_seconds, 30);
        assert_eq!(
            c.panels[0].latency_source,
            LatencySource::Step { step_id: u(9) }
        );
    }

    #[test]
    fn error_table() {
        assert_eq!(
            err(cfg(vec![group(1)], vec![solo("a")])),
            "점검 묶음 1: 칸이 없는 점검 묶음입니다"
        );
        assert_eq!(
            err(cfg(
                vec![group(1)],
                vec![member(1, Some(9)), solo("s"), member(1, Some(9))]
            )),
            "칸 3: 같은 점검 묶음의 칸은 붙어 있어야 합니다"
        );
        assert_eq!(
            err(cfg(vec![group(1)], vec![member(1, None)])),
            "칸 1: 점검 묶음 칸은 볼 스텝을 골라야 합니다"
        );
        assert_eq!(
            err(cfg(vec![], vec![member(1, Some(9))])),
            "칸 1: 없는 점검 묶음을 가리킵니다"
        );
        let mut g = group(1);
        g.interval_seconds = 0;
        assert_eq!(
            err(cfg(vec![g], vec![member(1, Some(9))])),
            "점검 묶음 1: 점검 주기는 1~3600초여야 합니다"
        );
        assert_eq!(
            err(cfg(
                vec![group(1), group(1)],
                vec![member(1, Some(9)), solo("s")]
            )),
            "점검 묶음 2: 묶음 id가 중복됩니다"
        );
        let mut bad_id = group(1);
        bad_id.id = "nope".into();
        assert_eq!(
            err(cfg(vec![bad_id], vec![solo("s")])),
            "점검 묶음 1: 묶음 id가 올바른 ULID 형식이 아닙니다"
        );
        let mut no_scn = group(1);
        no_scn.scenario_id = " ".into();
        assert_eq!(
            err(cfg(vec![no_scn], vec![member(1, Some(9))])),
            "점검 묶음 1: 시나리오를 선택해야 합니다"
        );
        let mut p = solo("t");
        p.step_id = Some("bad".into());
        p.conditions = vec![cond("x")];
        assert_eq!(
            err(cfg(vec![], vec![p])),
            "칸 1: 스텝 id가 올바른 ULID 형식이 아닙니다"
        );
    }
}
