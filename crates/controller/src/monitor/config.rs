//! Monitor board configuration: wire/storage shape + validation (spec §4).
//!
//! Defaults use container-level `#[serde(default)]` with hand-written `Default`
//! impls — a field-level `#[serde(default)]` would fill `u32` with 0.

use serde::{Deserialize, Serialize};
use ulid::Ulid;

pub const MAX_PANELS: usize = 9;
pub const MAX_THRESHOLDS: usize = 5;
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
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BoardConfig {
    pub font_scale: FontScale,
    pub blink: Blink,
    pub panels: Vec<PanelConfig>,
}

impl Default for BoardConfig {
    fn default() -> Self {
        Self {
            font_scale: FontScale::Large,
            blink: Blink::Fail,
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
}
