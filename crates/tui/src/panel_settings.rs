//! 칸 설정 보기 — 번호 목록 12개(spec §5.4, 목업 §4). 슬라이스 2 편집 메뉴가 같은 번호를 쓴다
//! — 항목 순서·번호를 바꾸지 말 것. 문구는 GUI(`ui/src/monitor/conditions.ts`
//! `targetLabel`·`conditionSummary`, `groups.ts` `groupNumber`)와 같다.

use handicap_controller::monitor::config::{
    BoardConfig, Condition, ConditionOp, ConditionSource, DisplayItem, DisplaySource,
    LatencySource, PanelConfig, one_of_candidates,
};

use crate::inspect::sanitize;
use crate::judge::format_stat_num;
use crate::names::Names;
use crate::text;
use crate::view::{fit, text_width, wrap_width};

fn body_target(path: &str) -> String {
    if path == "$" {
        return text::COND_TARGET_BODY_ROOT.to_string();
    }
    let rest = path
        .strip_prefix("$.")
        .or_else(|| path.strip_prefix('$'))
        .unwrap_or(path);
    rest.to_string()
}

/// GUI `targetLabel`: body "$" → "본문", "$.a.b" → "a.b", "$['a b']" → "['a b']", 그 외 원문 /
/// header → "헤더 {path}" / status → "상태코드" / body_text → "본문 전체".
pub fn condition_target(c: &Condition) -> String {
    match c.source {
        ConditionSource::Body => body_target(&c.path),
        ConditionSource::Header => text::cond_target_header(&c.path),
        ConditionSource::Status => text::COND_TARGET_STATUS.to_string(),
        ConditionSource::BodyText => text::COND_TARGET_BODY_TEXT.to_string(),
    }
}

/// `condition_target`과 같은 규칙(body/header/status).
pub fn display_target(d: &DisplayItem) -> String {
    match d.source {
        DisplaySource::Body => body_target(&d.path),
        DisplaySource::Header => text::cond_target_header(&d.path),
        DisplaySource::Status => text::COND_TARGET_STATUS.to_string(),
    }
}

/// GUI `conditionSummary`.
pub fn condition_summary(c: &Condition, step_name: Option<&str>) -> String {
    let mut s = format!("{} {}", condition_target(c), text::cond_op_label(c.op));
    if c.op == ConditionOp::OneOf {
        s.push_str(&format!(" {{{}}}", one_of_candidates(&c.value).join(", ")));
    } else if c.op.needs_value() {
        if c.value.is_empty() {
            s.push_str(" \"\"");
        } else {
            s.push_str(&format!(" {}", c.value));
        }
    }
    s.push_str(&format!(" · {}", step_name.unwrap_or(&c.step_id)));
    if c.ignore_case {
        s.push_str(&format!(" · {}", text::COND_IGNORE_CASE));
    }
    if c.trim {
        s.push_str(&format!(" · {}", text::COND_TRIM));
    }
    s
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingItem {
    pub label: &'static str,
    /// 1줄 이상
    pub values: Vec<String>,
    pub from_group: bool,
}

fn step_label(names: &Names, scenario_id: &str, step_id: &str) -> String {
    names
        .step_name(scenario_id, step_id)
        .unwrap_or(step_id)
        .to_string()
}

fn or_none(v: Vec<String>) -> Vec<String> {
    if v.is_empty() {
        vec![text::NONE.to_string()]
    } else {
        v
    }
}

/// 항상 12개(번호 = 인덱스 + 1). `from_group` = 묶음 칸(`group_id` 있음)의 2·3·5번.
pub fn settings_items(p: &PanelConfig, names: &Names) -> Vec<SettingItem> {
    let grouped = p.group_id.is_some();
    let sc = p.scenario_id.as_str();
    let item = |label, values: Vec<String>, from_group: bool| SettingItem {
        label,
        values,
        from_group: from_group && grouped,
    };
    let title = if p.title.is_empty() {
        text::NO_TITLE.to_string()
    } else {
        p.title.clone()
    };
    let scenario = if sc.is_empty() {
        text::NO_VALUE.to_string()
    } else {
        names.scenario_name(sc).unwrap_or(sc).to_string()
    };
    let env = match &p.environment_id {
        None => text::ENV_NONE.to_string(),
        Some(id) => names.env_name(id).unwrap_or(id).to_string(),
    };
    let step = match &p.step_id {
        None => text::WHOLE_SCENARIO.to_string(),
        Some(id) => match (names.step_infos(sc), names.step_info(sc, id)) {
            (_, Some((no, s))) => format!("{no} {}  {} {}", s.name, s.method, s.url),
            (Some(_), None) => format!("{id} {}", text::COND_STEP_GONE),
            (None, None) => id.clone(),
        },
    };
    let latency = match &p.latency_source {
        LatencySource::Total => text::LATENCY_TOTAL.to_string(),
        LatencySource::Step { step_id } if p.step_id.as_deref() == Some(step_id) => {
            text::THIS_STEP.to_string()
        }
        LatencySource::Step { step_id } => step_label(names, sc, step_id),
    };
    let thresholds = if p.thresholds.is_empty() {
        text::NONE.to_string()
    } else {
        p.thresholds
            .iter()
            .map(|t| {
                format!(
                    "{} {}",
                    format_stat_num(f64::from(t.ms)),
                    text::THRESHOLD_MS
                )
            })
            .collect::<Vec<_>>()
            .join(" · ")
    };
    let conditions = p
        .conditions
        .iter()
        .map(|c| condition_summary(c, names.step_name(sc, &c.step_id)))
        .collect();
    let display = p
        .display_items
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let rank = text::DISPLAY_RANK.get(i).copied().unwrap_or("");
            format!(
                "{rank} {} · {}",
                display_target(d),
                step_label(names, sc, &d.step_id)
            )
        })
        .collect();
    vec![
        item(text::SET_TITLE, vec![title], false),
        item(text::SET_SCENARIO, vec![scenario], true),
        item(text::SET_ENV, vec![env], true),
        item(text::SET_STEP, vec![step], false),
        item(
            text::SET_INTERVAL,
            vec![p.interval_seconds.to_string()],
            true,
        ),
        item(
            text::SET_TIMEOUT,
            vec![p.timeout_seconds.to_string()],
            false,
        ),
        item(text::SET_LATENCY, vec![latency], false),
        item(text::SET_THRESHOLDS, vec![thresholds], false),
        item(text::SET_BAR_COUNT, vec![p.bar_count.to_string()], false),
        item(
            text::SET_GRAPH_MAX,
            vec![format_stat_num(f64::from(p.graph_max_ms))],
            false,
        ),
        item(text::SET_CONDITIONS, or_none(conditions), false),
        item(text::SET_DISPLAY, or_none(display), false),
    ]
}

/// GUI `groupNumber`: `board.panels`를 앞에서부터 보며 처음 나온 순서로 센 1부터의 번호, 없으면 0
/// (`board.groups` 배열 순서가 아니다).
pub fn group_number(board: &BoardConfig, group_id: &str) -> usize {
    let mut seen: Vec<&str> = Vec::new();
    for p in &board.panels {
        if let Some(g) = p.group_id.as_deref().filter(|g| !g.is_empty())
            && !seen.contains(&g)
        {
            seen.push(g);
        }
    }
    seen.iter()
        .position(|g| *g == group_id)
        .map_or(0, |i| i + 1)
}

/// 묶음 칸이면 각주(번호가 0이면 번호 없는 문구), 단독 칸이면 None.
pub fn group_note(board: &BoardConfig, p: &PanelConfig) -> Option<String> {
    let gid = p.group_id.as_deref()?;
    Some(match group_number(board, gid) {
        0 => text::GROUP_NOTE_PLAIN.to_string(),
        n => text::group_note(n),
    })
}

/// 번호 칸 `{:>2}` + 2칸.
const NO_W: usize = 4;
/// 라벨과 값 사이.
const LABEL_GAP: usize = 3;
/// 값 칸이 이보다 좁으면 값을 라벨 아래 줄로 내린다.
const VALUE_MIN: usize = 10;
/// 값을 라벨 아래로 내렸을 때 들여쓰기.
const NARROW_INDENT: usize = 4;

fn pad_to(s: &str, w: usize) -> String {
    format!("{s}{}", " ".repeat(w.saturating_sub(text_width(s))))
}

/// `{번호 2칸 오른쪽 정렬}  {라벨, 가장 넓은 라벨 폭으로 채움}   {값}` 줄들. 값이 여럿이면 둘째부터
/// 값 칸에 맞춰 들여쓰고, 폭을 넘으면 값 칸 안에서 줄바꿈한다. 값 칸이 `VALUE_MIN`보다 좁으면
/// 라벨 줄 아래로 값을 내린다. `from_group` 항목은 첫 값 줄 끝에 `  (묶음)`. 값은 `sanitize`.
pub fn settings_lines(items: &[SettingItem], width: usize) -> Vec<String> {
    let label_w = items.iter().map(|i| text_width(i.label)).max().unwrap_or(0);
    let value_x = NO_W + label_w + LABEL_GAP;
    let wide = width >= value_x + VALUE_MIN;
    let mut out = Vec::new();
    for (n, it) in items.iter().enumerate() {
        let head = format!("{:>2}  {}", n + 1, it.label);
        let (indent, room) = if wide {
            (value_x, width - value_x)
        } else {
            out.push(fit(&head, width));
            let ind = NARROW_INDENT.min(width.saturating_sub(1));
            (ind, width.saturating_sub(ind).max(1))
        };
        for (vi, v) in it.values.iter().enumerate() {
            let mut v = sanitize(v);
            if vi == 0 && it.from_group {
                v.push_str("  ");
                v.push_str(text::GROUP_MARK);
            }
            for (ri, row) in wrap_width(&v, room).into_iter().enumerate() {
                let line = if wide && vi == 0 && ri == 0 {
                    format!("{}{row}", pad_to(&head, value_x))
                } else {
                    format!("{}{row}", " ".repeat(indent))
                };
                out.push(fit(&line, width));
            }
        }
    }
    out
}
