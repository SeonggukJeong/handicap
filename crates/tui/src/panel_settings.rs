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

/// 항목 라벨들로 정해지는 열 배치 — (값 시작 열, 값 칸 폭, 라벨 아래로 내림 여부 반대 = wide).
fn layout_for(labels: impl Iterator<Item = usize>, width: usize) -> (usize, bool) {
    let label_w = labels.max().unwrap_or(0);
    let value_x = NO_W + label_w + LABEL_GAP;
    (value_x, width >= value_x + VALUE_MIN)
}

/// `settings_lines`와 같은 줄 + 각 줄이 속한 항목 인덱스(0부터).
fn settings_lines_indexed(items: &[SettingItem], width: usize) -> Vec<(String, usize)> {
    let (value_x, wide) = layout_for(items.iter().map(|i| text_width(i.label)), width);
    let mut out = Vec::new();
    for (n, it) in items.iter().enumerate() {
        let head = format!("{:>2}  {}", n + 1, it.label);
        let (indent, room) = if wide {
            (value_x, width - value_x)
        } else {
            out.push((fit(&head, width), n));
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
                out.push((fit(&line, width), n));
            }
        }
    }
    out
}

/// `{번호 2칸 오른쪽 정렬}  {라벨, 가장 넓은 라벨 폭으로 채움}   {값}` 줄들. 값이 여럿이면 둘째부터
/// 값 칸에 맞춰 들여쓰고, 폭을 넘으면 값 칸 안에서 줄바꿈한다. 값 칸이 `VALUE_MIN`보다 좁으면
/// 라벨 줄 아래로 값을 내린다. `from_group` 항목은 첫 값 줄 끝에 `  (묶음)`. 값은 `sanitize`.
pub fn settings_lines(items: &[SettingItem], width: usize) -> Vec<String> {
    settings_lines_indexed(items, width)
        .into_iter()
        .map(|(l, _)| l)
        .collect()
}

/// 편집 메뉴의 선택 표시 `▶ ` 자리.
const GUTTER: usize = 2;

/// 13·14 값 칸 폭 — `edit_menu_lines`가 같은 규칙으로 줄을 만들므로 그 폭을 미리 구한다.
fn edit_value_room(base: &[SettingItem], width: usize) -> usize {
    let inner = width.saturating_sub(GUTTER);
    let labels = base.iter().map(|i| text_width(i.label)).chain([
        text_width(text::SET_ENV_VARS),
        text_width(text::SET_SCEN_VARS),
    ]);
    let (value_x, wide) = layout_for(labels, inner);
    if wide {
        inner - value_x
    } else {
        inner.saturating_sub(NARROW_INDENT).max(1)
    }
}

/// `{prefix}  ({키} · {키})` — 폭에 안 들어가면 키를 뒤에서부터 통째로 빼고 `  (… 외 N개)`를 붙인다.
/// 키를 글자 단위로 자르지 않는다. 접두만으로도 안 들어가면 접두만 돌려준다(줄바꿈이 처리).
fn keyed_value(prefix: &str, keys: &[String], room: usize) -> String {
    if keys.is_empty() {
        return prefix.to_string();
    }
    let keys: Vec<String> = keys.iter().map(|k| sanitize(k)).collect();
    let full = format!("{prefix}  ({})", keys.join(" · "));
    if text_width(&full) <= room {
        return full;
    }
    for shown in (0..keys.len()).rev() {
        let rest = text::more_keys(keys.len() - shown);
        let v = if shown == 0 {
            format!("{prefix}  {rest}")
        } else {
            format!("{prefix}  ({})  {rest}", keys[..shown].join(" · "))
        };
        if text_width(&v) <= room {
            return v;
        }
    }
    prefix.to_string()
}

/// 14개(1b 12개 + 13 환경 변수 + 14 시나리오 변수). 13 값 = `{환경 이름} · {N}개  ({키} · …)` / 환경 없음 → `없음`,
/// 14 = `{시나리오 이름} · {N}개  ({키} · …)` / 변수 없음 → `없음`. 키 목록은 폭(`edit_menu_lines`의 폭)에
/// 맞춰 통째 조각으로 줄인다.
pub fn settings_items_edit(p: &PanelConfig, names: &Names, width: usize) -> Vec<SettingItem> {
    let mut items = settings_items(p, names);
    let room = edit_value_room(&items, width);
    let env = match p.environment_id.as_deref() {
        None => text::NONE.to_string(),
        Some(id) => {
            let keys = names.env_keys(id).unwrap_or_default();
            let prefix = format!(
                "{} · {}개",
                sanitize(names.env_name(id).unwrap_or(id)),
                keys.len()
            );
            keyed_value(&prefix, keys, room)
        }
    };
    let sc = p.scenario_id.as_str();
    let scen = match names.scenario_vars(sc).filter(|v| !v.is_empty()) {
        None => text::NONE.to_string(),
        Some(vars) => {
            let keys: Vec<String> = vars.iter().map(|(k, _)| k.clone()).collect();
            let prefix = format!(
                "{} · {}개",
                sanitize(names.scenario_name(sc).unwrap_or(sc)),
                keys.len()
            );
            keyed_value(&prefix, &keys, room)
        }
    };
    items.push(SettingItem {
        label: text::SET_ENV_VARS,
        values: vec![env],
        from_group: false,
    });
    items.push(SettingItem {
        label: text::SET_SCEN_VARS,
        values: vec![scen],
        from_group: false,
    });
    items
}

/// `settings_lines`와 같은 규칙의 줄 + 각 줄이 속한 항목 번호(0부터). 12와 13 사이에 구분 줄(항목 번호 None).
/// 선택 표시 `▶ ` 2칸을 이 함수가 줄 앞에 예약한다 — 안쪽 폭 = `width.saturating_sub(2)`로 줄을 만든 뒤
/// 모든 줄 앞에 공백 2칸(고른 항목 첫 줄은 그리기에서 `▶ `).
pub fn edit_menu_lines(items: &[SettingItem], width: usize) -> Vec<(String, Option<usize>)> {
    let inner = width.saturating_sub(GUTTER);
    let pad = " ".repeat(GUTTER.min(width));
    let mut out = Vec::new();
    let mut divided = false;
    for (l, n) in settings_lines_indexed(items, inner) {
        if n >= 12 && !divided {
            divided = true;
            let wide = format!("── {} ──", text::EDIT_DIVIDER);
            let d = if text_width(&wide) + GUTTER <= width {
                wide
            } else {
                text::EDIT_DIVIDER.to_string()
            };
            out.push((fit(&format!("{pad}{d}"), width), None));
        }
        out.push((format!("{pad}{l}"), Some(n)));
    }
    out
}

/// 커서 항목의 줄이 `height`줄 창에 다 보이도록 하는 위쪽 줄 번호(0부터) — 맨 위부터 보이면 0, 아니면
/// 그 항목 마지막 줄이 창 맨 아래에 닿게(항목이 창보다 길면 첫 줄이 맨 위). 항목이 없으면 0.
pub fn ensure_visible(lines: &[(String, Option<usize>)], cursor: usize, height: usize) -> usize {
    let mut rows = lines
        .iter()
        .enumerate()
        .filter(|(_, (_, n))| *n == Some(cursor))
        .map(|(i, _)| i);
    let Some(first) = rows.next() else {
        return 0;
    };
    let last = rows.next_back().unwrap_or(first);
    if height == 0 || last < height {
        return 0;
    }
    (last + 1 - height).min(first)
}
