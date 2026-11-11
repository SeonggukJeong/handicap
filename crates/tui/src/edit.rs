//! 칸 설정 편집 규칙과 설정 변환(spec §6.1·§6.3) — 순수 함수만.
//!
//! 변환은 모두 `cfg`를 복제해 `panel_idx` 칸만 바꾼 새 `BoardConfig`를 돌려준다. `panel_idx`·
//! 목록 `i`가 범위 밖이면 패닉 없이 **설정을 그대로** 돌려준다. 값 검증의 권위는 서버
//! (`validate_panel`)다 — 숫자 파싱 실패는 0으로 보내 서버가 거절하게 한다.

use handicap_controller::monitor::config::{
    BoardConfig, ConditionOp, ConditionSource, LatencySource, PanelConfig, Threshold,
};

use crate::names::Names;
use crate::text;

/// GUI `PanelEditor.tsx` `THRESHOLD_COLORS`.
const THRESHOLD_COLORS: [&str; 5] = ["#f59e0b", "#ef4444", "#a855f7", "#3b82f6", "#14b8a6"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Title,
    Interval,
    Timeout,
    BarCount,
    GraphMax,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pick {
    Env,
    Step,
    Latency,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListKind {
    Thresholds,
    Conditions,
    Display,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditKind {
    Input(Field),
    Pick(Pick),
    List(ListKind),
    EnvVars,
    ScenarioVars,
    ReadOnly(&'static str),
}

/// 항목 번호 1..=14 → 편집 종류. 번호는 `panel_settings::settings_items`(1–12)와 같다.
pub fn edit_kind(no: usize, p: &PanelConfig, names: &Names) -> EditKind {
    let grouped = p.group_id.is_some();
    match no {
        1 => EditKind::Input(Field::Title),
        2 => EditKind::ReadOnly(text::EDIT_SCENARIO_READONLY),
        3 if grouped => EditKind::ReadOnly(text::EDIT_GROUP_VALUE),
        3 => EditKind::Pick(Pick::Env),
        4 if grouped => EditKind::Pick(Pick::Step),
        4 => EditKind::ReadOnly(text::EDIT_STEP_READONLY),
        5 if grouped => EditKind::ReadOnly(text::EDIT_GROUP_VALUE),
        5 => EditKind::Input(Field::Interval),
        6 => EditKind::Input(Field::Timeout),
        7 if grouped || p.step_id.is_some() => EditKind::ReadOnly(text::EDIT_STEP_PANEL_LATENCY),
        7 => EditKind::Pick(Pick::Latency),
        8 => EditKind::List(ListKind::Thresholds),
        9 => EditKind::Input(Field::BarCount),
        10 => EditKind::Input(Field::GraphMax),
        11 if p.conditions.is_empty() => EditKind::ReadOnly(text::EDIT_NO_CONDITIONS),
        11 => EditKind::List(ListKind::Conditions),
        12 if p.display_items.is_empty() => EditKind::ReadOnly(text::EDIT_NO_DISPLAY),
        12 => EditKind::List(ListKind::Display),
        13 => match p.environment_id.as_deref() {
            None => EditKind::ReadOnly(text::EDIT_NO_ENV),
            Some(id) if names.env_keys(id).is_none_or(<[String]>::is_empty) => {
                EditKind::ReadOnly(text::EDIT_NO_ENV_VARS)
            }
            Some(_) => EditKind::EnvVars,
        },
        14 if names
            .scenario_vars(&p.scenario_id)
            .is_none_or(<[(String, crate::names::VarKind)]>::is_empty) =>
        {
            EditKind::ReadOnly(text::EDIT_NO_SCENARIO_VARS)
        }
        14 => EditKind::ScenarioVars,
        _ => EditKind::ReadOnly(""),
    }
}

/// 서버 `validate_panel`과 같은 범위. Title이면 None.
pub fn field_range(f: Field) -> Option<(u32, u32)> {
    match f {
        Field::Title => None,
        Field::Interval => Some((1, 3600)),
        Field::Timeout => Some((1, 30)),
        Field::BarCount => Some((10, 300)),
        Field::GraphMax => Some((100, 600_000)),
    }
}

pub fn field_value(p: &PanelConfig, f: Field) -> String {
    match f {
        Field::Title => p.title.clone(),
        Field::Interval => p.interval_seconds.to_string(),
        Field::Timeout => p.timeout_seconds.to_string(),
        Field::BarCount => p.bar_count.to_string(),
        Field::GraphMax => p.graph_max_ms.to_string(),
    }
}

/// `cfg` 복제 → `panel_idx` 칸에 `f` 적용. 범위 밖이면 복제본 그대로.
fn with_panel(
    cfg: &BoardConfig,
    panel_idx: usize,
    f: impl FnOnce(&mut PanelConfig),
) -> BoardConfig {
    let mut out = cfg.clone();
    if let Some(p) = out.panels.get_mut(panel_idx) {
        f(p);
    }
    out
}

fn parse_num(v: &str) -> u32 {
    v.trim().parse().unwrap_or(0)
}

pub fn set_field(cfg: &BoardConfig, panel_idx: usize, f: Field, v: &str) -> BoardConfig {
    with_panel(cfg, panel_idx, |p| match f {
        Field::Title => p.title = v.to_string(),
        Field::Interval => p.interval_seconds = parse_num(v),
        Field::Timeout => p.timeout_seconds = parse_num(v),
        Field::BarCount => p.bar_count = parse_num(v),
        Field::GraphMax => p.graph_max_ms = parse_num(v),
    })
}

pub fn set_env(cfg: &BoardConfig, panel_idx: usize, env: Option<String>) -> BoardConfig {
    with_panel(cfg, panel_idx, |p| p.environment_id = env)
}

/// GUI `setPanelStep`: `step_id`·`latency_source`(그 스텝)·조건·표시 값의 `step_id`를 새 스텝으로.
pub fn set_step(cfg: &BoardConfig, panel_idx: usize, step_id: &str) -> BoardConfig {
    with_panel(cfg, panel_idx, |p| {
        p.step_id = Some(step_id.to_string());
        p.latency_source = LatencySource::Step {
            step_id: step_id.to_string(),
        };
        for c in &mut p.conditions {
            c.step_id = step_id.to_string();
        }
        for d in &mut p.display_items {
            d.step_id = step_id.to_string();
        }
    })
}

/// `None` = 시나리오 전체.
pub fn set_latency(cfg: &BoardConfig, panel_idx: usize, step_id: Option<&str>) -> BoardConfig {
    with_panel(cfg, panel_idx, |p| {
        p.latency_source = match step_id {
            Some(s) => LatencySource::Step {
                step_id: s.to_string(),
            },
            None => LatencySource::Total,
        };
    })
}

pub fn threshold_add(cfg: &BoardConfig, panel_idx: usize, ms: u32) -> BoardConfig {
    with_panel(cfg, panel_idx, |p| {
        let color = THRESHOLD_COLORS[p.thresholds.len() % THRESHOLD_COLORS.len()];
        p.thresholds.push(Threshold {
            ms,
            color: color.to_string(),
        });
    })
}

pub fn threshold_set(cfg: &BoardConfig, panel_idx: usize, i: usize, ms: u32) -> BoardConfig {
    with_panel(cfg, panel_idx, |p| {
        if let Some(t) = p.thresholds.get_mut(i) {
            t.ms = ms;
        }
    })
}

/// GUI `addThreshold`: 마지막 + 1000, 없으면 1000.
pub fn threshold_default_ms(p: &PanelConfig) -> u32 {
    p.thresholds
        .last()
        .map_or(1000, |t| t.ms.saturating_add(1000))
}

pub fn remove_at(cfg: &BoardConfig, panel_idx: usize, kind: ListKind, i: usize) -> BoardConfig {
    fn rm<T>(v: &mut Vec<T>, i: usize) {
        if i < v.len() {
            v.remove(i);
        }
    }
    with_panel(cfg, panel_idx, |p| match kind {
        ListKind::Thresholds => rm(&mut p.thresholds, i),
        ListKind::Conditions => rm(&mut p.conditions, i),
        ListKind::Display => rm(&mut p.display_items, i),
    })
}

/// 표시 값이 2개일 때만 ①②를 맞바꾼다.
pub fn swap_display(cfg: &BoardConfig, panel_idx: usize) -> BoardConfig {
    with_panel(cfg, panel_idx, |p| {
        if p.display_items.len() == 2 {
            p.display_items.swap(0, 1);
        }
    })
}

/// 대상(`source`·`path`)과 스텝은 그대로, 규칙·값·두 체크만 바꾼다.
pub fn set_condition(
    cfg: &BoardConfig,
    panel_idx: usize,
    i: usize,
    op: ConditionOp,
    value: &str,
    ignore_case: bool,
    trim: bool,
) -> BoardConfig {
    with_panel(cfg, panel_idx, |p| {
        if let Some(c) = p.conditions.get_mut(i) {
            c.op = op;
            c.value = value.to_string();
            c.ignore_case = ignore_case;
            c.trim = trim;
        }
    })
}

/// 그 대상에서 고를 수 있는 규칙 — **GUI 드롭다운과 같은 순서**(`ui/src/monitor/conditions.ts` `OPS_BY_SOURCE`:
/// 본문 값·헤더는 `=` `≠` `키 있음` `값 있음` `글자 포함` `>` `<` `≥` `≤` `∈`, 본문 전체 글자는 `글자 포함` `값 있음`).
/// 집합은 서버 허용 표(`ConditionSource::allows`)와 같다 — 테스트가 둘 다 대조한다.
pub fn ops_for(source: ConditionSource) -> Vec<ConditionOp> {
    use ConditionOp as O;
    const TEN: [ConditionOp; 10] = [
        O::Eq,
        O::Ne,
        O::Exists,
        O::NotEmpty,
        O::Contains,
        O::Gt,
        O::Lt,
        O::Gte,
        O::Lte,
        O::OneOf,
    ];
    let order: &[ConditionOp] = match source {
        ConditionSource::Body | ConditionSource::Header => &TEN,
        ConditionSource::Status => &[O::Eq, O::Ne, O::Gt, O::Lt, O::Gte, O::Lte, O::OneOf],
        ConditionSource::BodyText => &[O::Contains, O::NotEmpty],
    };
    // 서버가 안 받는 규칙은 순서 표에 있어도 내놓지 않는다(순서는 GUI, 허용 여부는 서버).
    order
        .iter()
        .copied()
        .filter(|o| source.allows(*o))
        .collect()
}

/// (조건 수, 표시 값 수) — 둘 다 0이면 확인 없음.
pub fn step_change_counts(p: &PanelConfig) -> (usize, usize) {
    (p.conditions.len(), p.display_items.len())
}

/// 이 칸의 환경을 `new`로 바꾸면 어느 보드의 어느 칸도 안 쓰게 되는 옛 환경 id. 아니면 None.
pub fn dropped_env(
    boards: &[BoardConfig],
    board_idx: usize,
    panel_idx: usize,
    new: Option<&str>,
) -> Option<String> {
    let old = boards
        .get(board_idx)?
        .panels
        .get(panel_idx)?
        .environment_id
        .as_deref()?;
    if new == Some(old) {
        return None;
    }
    let used_elsewhere = boards.iter().enumerate().any(|(bi, b)| {
        b.panels.iter().enumerate().any(|(pi, p)| {
            !(bi == board_idx && pi == panel_idx) && p.environment_id.as_deref() == Some(old)
        })
    });
    (!used_elsewhere).then(|| old.to_string())
}

/// (칸 수, 보드 수) — `pred`를 만족하는 칸.
pub fn usage(boards: &[BoardConfig], pred: impl Fn(&PanelConfig) -> bool) -> (usize, usize) {
    let mut panels = 0;
    let mut bs = 0;
    for b in boards {
        let n = b.panels.iter().filter(|p| pred(p)).count();
        panels += n;
        if n > 0 {
            bs += 1;
        }
    }
    (panels, bs)
}

/// 서버 문구 맨 앞 `칸 {panel_no}: `만 뗀다(번호가 다르면 그대로).
pub fn strip_panel_prefix(msg: &str, panel_no: usize) -> &str {
    msg.strip_prefix(&format!("칸 {panel_no}: ")).unwrap_or(msg)
}

/// 볼 스텝 목록 줄(spec §6.1 4번). 이름·URL은 번들에서 온 원문 그대로다(미-sanitize) — 그리는 쪽이
/// 폭 계산 전에 `inspect::sanitize`를 건다.
pub fn step_options(names: &Names, scenario_id: &str) -> Vec<(String, String)> {
    names
        .step_infos(scenario_id)
        .unwrap_or(&[])
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let mut line = format!("{} {}  {} {}", i + 1, s.name, s.method, s.url);
            if let Some(h) = &s.branch_hint {
                line.push_str(&format!("  ({h} 분기)"));
            }
            (s.id.clone(), line)
        })
        .collect()
}
