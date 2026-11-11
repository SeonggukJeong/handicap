//! 응답 값 목록 만들기(tui-2b spec §2.1, §4.1) — 순수 함수.
//!
//! 요청·응답 화면의 응답 하나에서 "대상 + 받은 값" 줄을 만든다(응답 코드 → 헤더 → 본문).
//! 본문은 키 순서를 지키는 작은 트리로 읽는다(`serde_json::Value`는 키를 정렬한다).
//! 값을 품는 타입은 손 `Debug`(종류·길이만) — 응답 값이 로그·패닉 문구로 새지 않게.

use std::collections::HashMap;
use std::fmt;

use handicap_controller::monitor::config::{
    Condition, ConditionOp, ConditionSource, DisplayItem, DisplaySource, PanelConfig,
};
use handicap_engine::{ScenarioTrace, StepKind, TracedResponse};
use serde::Deserialize;
use serde::de::{Deserializer, MapAccess, SeqAccess, Visitor};

use crate::input::{InputMode, LineInput};
use crate::inspect::{PRETTY_MAX_BYTES, PRETTY_MAX_DEPTH, sanitize};
use crate::names::Names;
use crate::panel_settings::condition_target;
use crate::text;
use crate::view::text_width;

/// 서버 `check.rs` `MAX_JSON_UNWRAP`과 같다.
const MAX_JSON_UNWRAP: usize = 3;

/// 고른 줄의 받은 값.
#[derive(Clone, PartialEq, Eq)]
pub enum PickValue {
    Status(u16),
    Header(String),
    Null,
    Bool(bool),
    /// 숫자 글자 — 정수는 그대로, 소수는 Rust `f64` `{}` 표기.
    Number(String),
    Str(String),
    BodyText,
}

impl fmt::Debug for PickValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PickValue::Status(_) => write!(f, "Status"),
            PickValue::Header(s) => write!(f, "Header(len={})", s.chars().count()),
            PickValue::Null => write!(f, "Null"),
            PickValue::Bool(_) => write!(f, "Bool"),
            PickValue::Number(s) => write!(f, "Number(len={})", s.chars().count()),
            PickValue::Str(s) => write!(f, "Str(len={})", s.chars().count()),
            PickValue::BodyText => write!(f, "BodyText"),
        }
    }
}

/// 줄의 종류 — 조건·표시 값의 `source`·`path`가 여기서 나온다.
#[derive(Clone, PartialEq, Eq)]
pub enum RowKind {
    Status,
    Header { name: String },
    Body { path: String },
    BodyText,
}

impl fmt::Debug for RowKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RowKind::Status => write!(f, "Status"),
            RowKind::Header { name } => write!(f, "Header(name_len={})", name.chars().count()),
            RowKind::Body { path } => write!(f, "Body(path_len={})", path.chars().count()),
            RowKind::BodyText => write!(f, "BodyText"),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ValueRow {
    pub kind: RowKind,
    pub value: PickValue,
}

impl fmt::Debug for ValueRow {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "ValueRow {{ kind: {:?}, value: {:?} }}",
            self.kind, self.value
        )
    }
}

impl ValueRow {
    /// 대상 글자 — 칸 설정 11·12번과 같은 함수(`condition_target`)로 만든다.
    pub fn target(&self) -> String {
        let (source, path) = match &self.kind {
            RowKind::Status => (ConditionSource::Status, String::new()),
            RowKind::Header { name } => (ConditionSource::Header, name.clone()),
            RowKind::Body { path } => (ConditionSource::Body, path.clone()),
            RowKind::BodyText => (ConditionSource::BodyText, String::new()),
        };
        condition_target(&Condition {
            source,
            path,
            ..Condition::default()
        })
    }

    /// 받은 값 글자 — 문자열은 `"…"`, `null`, `본문 전체` 줄은 안내 글자.
    pub fn shown(&self) -> String {
        match &self.value {
            PickValue::Status(c) => c.to_string(),
            PickValue::Header(s) => s.clone(),
            PickValue::Null => "null".to_string(),
            PickValue::Bool(b) => b.to_string(),
            PickValue::Number(n) => n.clone(),
            PickValue::Str(s) => format!("\"{s}\""),
            PickValue::BodyText => text::PICK_BODY_TEXT_VALUE.to_string(),
        }
    }
}

/// 값 목록 위 안내 한 줄.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListNote {
    Unwrapped,
    EngineTruncated,
    Clipped(u32),
    TooLarge,
    TooDeep,
    TooManyPaths,
    LaterRun,
}

impl ListNote {
    pub fn text(&self) -> String {
        match self {
            ListNote::Unwrapped => text::PICK_UNWRAPPED.to_string(),
            ListNote::EngineTruncated => text::PICK_ENGINE_TRUNCATED.to_string(),
            ListNote::Clipped(kb) => text::record_clipped(*kb),
            ListNote::TooLarge => text::PICK_TOO_LARGE.to_string(),
            ListNote::TooDeep => text::PICK_TOO_DEEP.to_string(),
            ListNote::TooManyPaths => text::PICK_TOO_MANY_PATHS.to_string(),
            ListNote::LaterRun => text::PICK_LATER_RUN.to_string(),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ValueList {
    pub rows: Vec<ValueRow>,
    pub notes: Vec<ListNote>,
}

impl fmt::Debug for ValueList {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "ValueList {{ rows: {}, notes: {} }}",
            self.rows.len(),
            self.notes.len()
        )
    }
}

/// 경로의 한 마디.
#[derive(Clone, PartialEq, Eq)]
pub enum Seg {
    Key(String),
    Index(usize),
}

impl fmt::Debug for Seg {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Seg::Key(k) => write!(f, "Key(len={})", k.chars().count()),
            Seg::Index(i) => write!(f, "Index({i})"),
        }
    }
}

fn is_ident(k: &str) -> bool {
    let mut it = k.chars();
    matches!(it.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && it.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// GUI `segmentsToPath`(`ui/src/scenario/jsonPath.ts`)와 글자까지 같다.
pub fn segments_to_path(segs: &[Seg]) -> String {
    let mut out = String::from("$");
    for seg in segs {
        match seg {
            Seg::Index(i) => out.push_str(&format!("[{i}]")),
            Seg::Key(k) if is_ident(k) => {
                out.push('.');
                out.push_str(k);
            }
            Seg::Key(k) => {
                out.push_str("['");
                for ch in k.chars() {
                    match ch {
                        '\\' => out.push_str("\\\\"),
                        '\'' => out.push_str("\\'"),
                        c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                        c => out.push(c),
                    }
                }
                out.push_str("']");
            }
        }
    }
    out
}

/// 본문 값 줄들의 경로 글자 바이트 합계 상한(spec §2.1 표 7행).
pub const MAX_PATH_BYTES: usize = 4 * 1024 * 1024;

/// `segments_to_path(segs).len()`을 문자열을 만들지 않고 센다.
fn path_len(segs: &[Seg]) -> usize {
    let mut n = 1;
    for seg in segs {
        n += match seg {
            Seg::Index(i) => 2 + i.checked_ilog10().map_or(1, |d| d as usize + 1),
            Seg::Key(k) if is_ident(k) => 1 + k.len(),
            Seg::Key(k) => {
                4 + k
                    .chars()
                    .map(|c| match c {
                        '\\' | '\'' => 2,
                        c if (c as u32) < 0x20 => 6,
                        c => c.len_utf8(),
                    })
                    .sum::<usize>()
            }
        };
    }
    n
}

/// 걷기를 멈춘 이유.
enum Stop {
    Deep,
    Paths,
}

// ---------- 순서를 지키는 본문 트리 ----------

enum Node {
    Null,
    Bool(bool),
    Num(String),
    Str(String),
    Arr(Vec<Node>),
    /// 같은 키가 다시 나오면 자리는 처음 것, 값은 뒤 것.
    Obj(Vec<(String, Node)>),
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Node;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "JSON value")
            }
            fn visit_unit<E>(self) -> Result<Node, E> {
                Ok(Node::Null)
            }
            fn visit_bool<E>(self, v: bool) -> Result<Node, E> {
                Ok(Node::Bool(v))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Node, E> {
                Ok(Node::Num(v.to_string()))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Node, E> {
                Ok(Node::Num(v.to_string()))
            }
            fn visit_f64<E>(self, v: f64) -> Result<Node, E> {
                Ok(Node::Num(format!("{v}")))
            }
            fn visit_str<E>(self, v: &str) -> Result<Node, E> {
                Ok(Node::Str(v.to_string()))
            }
            fn visit_string<E>(self, v: String) -> Result<Node, E> {
                Ok(Node::Str(v))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Node, A::Error> {
                let mut v = Vec::new();
                while let Some(n) = a.next_element::<Node>()? {
                    v.push(n);
                }
                Ok(Node::Arr(v))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Node, A::Error> {
                let mut v: Vec<(String, Node)> = Vec::new();
                let mut index: HashMap<String, usize> = HashMap::new();
                while let Some((k, n)) = a.next_entry::<String, Node>()? {
                    match index.get(&k) {
                        Some(&i) => v[i].1 = n,
                        None => {
                            index.insert(k.clone(), v.len());
                            v.push((k, n));
                        }
                    }
                }
                Ok(Node::Obj(v))
            }
        }
        d.deserialize_any(V)
    }
}

/// 서버 `unwrap_json_str`과 같은 규칙 — 객체·배열이 되면 그 값.
fn unwrap_str(s: &str) -> Option<Node> {
    let head = s.trim_start_matches([' ', '\t', '\n', '\r']);
    if !head.starts_with(['{', '[', '"']) {
        return None;
    }
    let mut cur = s.to_owned();
    for _ in 0..MAX_JSON_UNWRAP {
        match serde_json::from_str::<Node>(&cur) {
            Ok(n @ (Node::Arr(_) | Node::Obj(_))) => return Some(n),
            Ok(Node::Str(next)) => cur = next,
            _ => return None,
        }
    }
    None
}

struct Walker {
    rows: Vec<ValueRow>,
    segs: Vec<Seg>,
    unwrapped: bool,
    path_bytes: usize,
}

/// 깊이가 `PRETTY_MAX_DEPTH`를 넘거나 경로 글자 합계가 `MAX_PATH_BYTES`를 넘으면 `Err` — 거기서 멈춘다.
impl Walker {
    fn push(&mut self, value: PickValue) -> Result<(), Stop> {
        self.path_bytes += path_len(&self.segs);
        if self.path_bytes > MAX_PATH_BYTES {
            return Err(Stop::Paths);
        }
        self.rows.push(ValueRow {
            kind: RowKind::Body {
                path: segments_to_path(&self.segs),
            },
            value,
        });
        Ok(())
    }

    fn walk(&mut self, node: &Node, depth: usize) -> Result<(), Stop> {
        match node {
            Node::Null => self.push(PickValue::Null)?,
            Node::Bool(b) => self.push(PickValue::Bool(*b))?,
            Node::Num(n) => self.push(PickValue::Number(n.clone()))?,
            Node::Str(s) => match unwrap_str(s) {
                Some(inner) => {
                    self.unwrapped = true;
                    self.walk(&inner, depth)?;
                }
                None => self.push(PickValue::Str(s.clone()))?,
            },
            Node::Arr(items) => {
                if depth + 1 > PRETTY_MAX_DEPTH {
                    return Err(Stop::Deep);
                }
                for (i, n) in items.iter().enumerate() {
                    self.segs.push(Seg::Index(i));
                    let r = self.walk(n, depth + 1);
                    self.segs.pop();
                    r?;
                }
            }
            Node::Obj(entries) => {
                if depth + 1 > PRETTY_MAX_DEPTH {
                    return Err(Stop::Deep);
                }
                for (k, n) in entries {
                    self.segs.push(Seg::Key(k.clone()));
                    let r = self.walk(n, depth + 1);
                    self.segs.pop();
                    r?;
                }
            }
        }
        Ok(())
    }
}

fn body_text_row() -> ValueRow {
    ValueRow {
        kind: RowKind::BodyText,
        value: PickValue::BodyText,
    }
}

/// 응답 하나에서 값 목록을 만든다(spec §2.1). `LaterRun` 안내는 내지 않는다(`open_values`).
pub fn value_list(resp: &TracedResponse, clipped_resp: bool, limit_kb: u32) -> ValueList {
    let mut rows = vec![ValueRow {
        kind: RowKind::Status,
        value: PickValue::Status(resp.status),
    }];
    for (name, value) in &resp.headers {
        rows.push(ValueRow {
            kind: RowKind::Header { name: name.clone() },
            value: PickValue::Header(value.clone()),
        });
    }
    let mut notes = Vec::new();

    // 본문 표(§2.1)의 첫 번째로 맞는 행.
    if resp.body.is_empty() && !resp.body_truncated && !clipped_resp {
        // 1: 본문 없음
    } else if resp.body_truncated {
        // 2: 엔진이 자름 — 서버가 늘 실패시키므로 본문 줄도 `본문 전체`도 없다
        notes.push(ListNote::EngineTruncated);
    } else if clipped_resp {
        // 3: 기록 상한에 잘림 — 서버는 온전한 본문으로 판정하니 `본문 전체`는 괜찮다
        rows.push(body_text_row());
        notes.push(ListNote::Clipped(limit_kb));
    } else if resp.body.len() > PRETTY_MAX_BYTES {
        // 4
        rows.push(body_text_row());
        notes.push(ListNote::TooLarge);
    } else {
        match serde_json::from_str::<Node>(&resp.body) {
            Err(e) if e.to_string().starts_with("recursion limit exceeded") => {
                // 6: serde 재귀 상한(128단)
                rows.push(body_text_row());
                notes.push(ListNote::TooDeep);
            }
            Err(_) => {
                // 5: JSON 아님
                rows.push(body_text_row());
            }
            Ok(root) => {
                let mut w = Walker {
                    rows: Vec::new(),
                    segs: Vec::new(),
                    unwrapped: false,
                    path_bytes: 0,
                };
                match w.walk(&root, 0) {
                    Ok(()) => {
                        // 8
                        rows.append(&mut w.rows);
                        if w.unwrapped {
                            notes.push(ListNote::Unwrapped);
                        }
                    }
                    Err(Stop::Deep) => {
                        // 6: 풀기까지 마친 값의 중첩이 64단 초과
                        rows.push(body_text_row());
                        notes.push(ListNote::TooDeep);
                    }
                    Err(Stop::Paths) => {
                        // 7: 경로 글자 합계 초과 — 모은 줄은 버린다
                        rows.push(body_text_row());
                        notes.push(ListNote::TooManyPaths);
                    }
                }
            }
        }
    }
    ValueList { rows, notes }
}

// ---------- 기본 조건·막힘·표지·값 목록 상태 (tui-2b Task 2, spec §2.2–§2.6) ----------

/// 서버 `monitor/config.rs`의 `AUTH_HEADERS`와 같은 4종(컨트롤러 쪽은 `pub(crate)` — 어긋남은
/// `auth_headers_match_controller` 테스트가 막는다).
pub const AUTH_HEADERS: [&str; 4] = [
    "set-cookie",
    "cookie",
    "authorization",
    "proxy-authorization",
];

/// 인증 헤더인가 — 앞뒤 공백·대소문자 무시.
pub fn is_auth_header(name: &str) -> bool {
    let n = name.trim();
    AUTH_HEADERS.iter().any(|h| n.eq_ignore_ascii_case(h))
}

/// 조건 칸 위에 붙는 안내.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hint {
    Volatile,
    Masked,
}

impl Hint {
    pub fn text(&self) -> &'static str {
        match self {
            Hint::Volatile => text::COND_VOLATILE_HINT,
            Hint::Masked => text::PICK_MASKED_HINT,
        }
    }
}

/// 조건 칸에 미리 채울 것.
#[derive(Clone)]
pub struct Draft {
    pub cond: Condition,
    pub hint: Option<Hint>,
    /// `본문 전체` — 커서가 값 칸에서 시작.
    pub focus_value: bool,
}

impl fmt::Debug for Draft {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Draft {{ op: {:?}, value_len: {}, hint: {:?}, focus_value: {} }}",
            self.cond.op,
            self.cond.value.chars().count(),
            self.hint,
            self.focus_value
        )
    }
}

/// GUI `VOLATILE_LEN`(`ui/src/monitor/conditions.ts`)과 같다.
const VOLATILE_LEN: usize = 40;

/// 입력줄이 받는 글자만으로 된 값인가.
fn input_accepts(v: &str) -> bool {
    LineInput::new(v, InputMode::Text { max_chars: 2000 }).text() == v
}

/// spec §2.4 표 — GUI `defaultCondition` + ★ 인증 헤더·입력줄 두 행(앞선 순서대로).
pub fn default_condition(step_id: &str, row: &ValueRow) -> Draft {
    let mk = |source, path: &str, op, value: &str| Condition {
        step_id: step_id.to_string(),
        source,
        path: path.to_string(),
        op,
        value: value.to_string(),
        ignore_case: false,
        trim: false,
    };
    let plain = |cond| Draft {
        cond,
        hint: None,
        focus_value: false,
    };
    // 문자열(본문·헤더) — 인증 헤더 → 길이 → 입력줄 순(긴 값을 한 글자씩 입력줄에 넣지 않는다).
    let string = |source, path: &str, v: &str, auth: bool| {
        if auth {
            Draft {
                cond: mk(source, path, ConditionOp::NotEmpty, ""),
                hint: Some(Hint::Masked),
                focus_value: false,
            }
        } else if v.chars().count() > VOLATILE_LEN || !input_accepts(v) {
            Draft {
                cond: mk(source, path, ConditionOp::NotEmpty, ""),
                hint: Some(Hint::Volatile),
                focus_value: false,
            }
        } else {
            plain(mk(source, path, ConditionOp::Eq, v))
        }
    };
    match (&row.kind, &row.value) {
        (RowKind::Status, PickValue::Status(c)) => plain(mk(
            ConditionSource::Status,
            "",
            ConditionOp::Eq,
            &c.to_string(),
        )),
        (RowKind::Header { name }, PickValue::Header(v)) => {
            string(ConditionSource::Header, name, v, is_auth_header(name))
        }
        (RowKind::Body { path }, PickValue::Null) => {
            plain(mk(ConditionSource::Body, path, ConditionOp::Exists, ""))
        }
        (RowKind::Body { path }, PickValue::Str(v)) => {
            string(ConditionSource::Body, path, v, false)
        }
        (RowKind::Body { path }, PickValue::Bool(b)) => plain(mk(
            ConditionSource::Body,
            path,
            ConditionOp::Eq,
            &b.to_string(),
        )),
        (RowKind::Body { path }, PickValue::Number(n)) => {
            plain(mk(ConditionSource::Body, path, ConditionOp::Eq, n))
        }
        // 종류와 값이 어긋난 줄은 만들어지지 않는다 — 안전하게 `본문 전체` 꼴.
        _ => Draft {
            cond: mk(ConditionSource::BodyText, "", ConditionOp::Contains, ""),
            hint: None,
            focus_value: true,
        },
    }
}

/// 표시 값 후보 — `본문 전체` 줄은 `None`.
pub fn display_item(step_id: &str, row: &ValueRow) -> Option<DisplayItem> {
    let (source, path) = match &row.kind {
        RowKind::Status => (DisplaySource::Status, String::new()),
        RowKind::Header { name } => (DisplaySource::Header, name.clone()),
        RowKind::Body { path } => (DisplaySource::Body, path.clone()),
        RowKind::BodyText => return None,
    };
    Some(DisplayItem {
        step_id: step_id.to_string(),
        source,
        path,
    })
}

/// 조건이 이미 10개면 막는 이유.
pub fn cond_block(p: &PanelConfig) -> Option<&'static str> {
    (p.conditions.len() >= handicap_controller::monitor::config::MAX_CONDITIONS)
        .then_some(text::COND_MAX)
}

/// 표시 값 추가를 막는 이유 — 2개 → 같은 대상 → 인증 헤더 순(GUI와 같다).
pub fn display_block(p: &PanelConfig, item: &DisplayItem) -> Option<&'static str> {
    if p.display_items.len() >= handicap_controller::monitor::config::MAX_DISPLAY_ITEMS {
        return Some(text::DISPLAY_MAX);
    }
    if p.display_items
        .iter()
        .any(|d| d.step_id == item.step_id && d.source == item.source && d.path == item.path)
    {
        return Some(text::DISPLAY_DUP);
    }
    if item.source == DisplaySource::Header && is_auth_header(&item.path) {
        return Some(text::DISPLAY_AUTH_HEADER);
    }
    None
}

/// 줄 오른쪽 표지 — (그 스텝·그 대상의 조건 수, 표시 값 있음). `source`·`path` 글자 그대로.
pub fn marks(p: &PanelConfig, step_id: &str, row: &ValueRow) -> (usize, bool) {
    let (csrc, path) = match &row.kind {
        RowKind::Status => (ConditionSource::Status, ""),
        RowKind::Header { name } => (ConditionSource::Header, name.as_str()),
        RowKind::Body { path } => (ConditionSource::Body, path.as_str()),
        RowKind::BodyText => (ConditionSource::BodyText, ""),
    };
    let conds = p
        .conditions
        .iter()
        .filter(|c| c.step_id == step_id && c.source == csrc && c.path == path)
        .count();
    let shown = display_item(step_id, row).is_some_and(|d| {
        p.display_items
            .iter()
            .any(|x| x.step_id == d.step_id && x.source == d.source && x.path == d.path)
    });
    (conds, shown)
}

/// 값 목록을 열 수 없는 이유.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Blocked {
    OtherStep { name: String },
    NoResponse,
}

impl Blocked {
    pub fn text(&self) -> String {
        match self {
            Blocked::OtherStep { name } => text::pick_other_step(name),
            Blocked::NoResponse => text::PICK_NO_RESPONSE.to_string(),
        }
    }
}

/// 값 목록 화면 상태 — 열 때 한 번 만든다.
#[derive(Clone)]
pub struct ValuesState {
    pub step_id: String,
    pub list: ValueList,
    pub blocked: Option<Blocked>,
    pub cursor: usize,
    /// 줄마다 `sanitize`를 마친 글자 — 열 때 한 번 만든다(막힘이면 비어 있다).
    pub texts: Vec<RowText>,
    /// 모든 줄의 대상 표시 폭 중 최대.
    pub target_width: usize,
}

/// 화면에 쓸 한 줄의 글자(`inspect::sanitize`를 마친 대상·받은 값). 값이 들어 있어 `Debug`를 달지 않는다.
#[derive(Clone)]
pub struct RowText {
    target: String,
    shown: String,
}

impl RowText {
    /// 원격 글자를 받아 `sanitize`해 든다 — 이 생성자가 유일한 길이라 뷰는 다시 `sanitize`하지 않아도 된다.
    pub fn new(target: &str, shown: &str) -> RowText {
        RowText {
            target: sanitize(target),
            shown: sanitize(shown),
        }
    }

    pub fn target(&self) -> &str {
        &self.target
    }

    pub fn shown(&self) -> &str {
        &self.shown
    }
}

impl ValuesState {
    /// 커서 0. `texts`·`target_width`를 `list.rows`에서 한 번 만든다(막힘이면 줄을 그리지 않으니 비운다).
    pub fn new(step_id: String, list: ValueList, blocked: Option<Blocked>) -> ValuesState {
        let mut texts = Vec::new();
        let mut target_width = 0;
        if blocked.is_none() {
            texts.reserve(list.rows.len());
            for r in &list.rows {
                let t = RowText::new(&r.target(), &r.shown());
                target_width = target_width.max(text_width(t.target()));
                texts.push(t);
            }
        }
        ValuesState {
            step_id,
            list,
            blocked,
            cursor: 0,
            texts,
            target_width,
        }
    }
}

impl fmt::Debug for ValuesState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "ValuesState {{ list: {:?}, blocked: {}, cursor: {}, texts: {}, target_width: {} }}",
            self.list,
            self.blocked.is_some(),
            self.cursor,
            self.texts.len(),
            self.target_width
        )
    }
}

/// spec §2.2 — 스텝 칸 제한·응답 없음이면 이유만, 아니면 값 목록(+ 반복 안내).
pub fn open_values(
    panel: &PanelConfig,
    trace: &ScenarioTrace,
    trace_idx: usize,
    clipped_resp: bool,
    limit_kb: u32,
    names: &Names,
) -> ValuesState {
    let empty = ValueList {
        rows: Vec::new(),
        notes: Vec::new(),
    };
    let Some(step) = trace.steps.get(trace_idx) else {
        return ValuesState::new(String::new(), empty, Some(Blocked::NoResponse));
    };
    if let Some(own) = &panel.step_id
        && own != &step.step_id
    {
        let name = names
            .step_name(&panel.scenario_id, own)
            .unwrap_or(own)
            .to_string();
        return ValuesState::new(own.clone(), empty, Some(Blocked::OtherStep { name }));
    }
    let Some(resp) = &step.response else {
        return ValuesState::new(step.step_id.clone(), empty, Some(Blocked::NoResponse));
    };
    let mut list = value_list(resp, clipped_resp, limit_kb);
    let later = trace.steps[trace_idx + 1..]
        .iter()
        .any(|s| matches!(s.kind, StepKind::Http) && s.step_id == step.step_id);
    if later {
        list.notes.insert(0, ListNote::LaterRun);
    }
    ValuesState::new(step.step_id.clone(), list, None)
}
