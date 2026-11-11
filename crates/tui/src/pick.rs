//! 응답 값 목록 만들기(tui-2b spec §2.1, §4.1) — 순수 함수.
//!
//! 요청·응답 화면의 응답 하나에서 "대상 + 받은 값" 줄을 만든다(응답 코드 → 헤더 → 본문).
//! 본문은 키 순서를 지키는 작은 트리로 읽는다(`serde_json::Value`는 키를 정렬한다).
//! 값을 품는 타입은 손 `Debug`(종류·길이만) — 응답 값이 로그·패닉 문구로 새지 않게.

use std::collections::HashMap;
use std::fmt;

use handicap_controller::monitor::config::{Condition, ConditionSource};
use handicap_engine::TracedResponse;
use serde::Deserialize;
use serde::de::{Deserializer, MapAccess, SeqAccess, Visitor};

use crate::inspect::{PRETTY_MAX_BYTES, PRETTY_MAX_DEPTH};
use crate::panel_settings::condition_target;
use crate::text;

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
}

/// 깊이가 `PRETTY_MAX_DEPTH`를 넘으면 `Err(())` — 재귀는 그 깊이에서 멈춘다.
impl Walker {
    fn push(&mut self, value: PickValue) {
        self.rows.push(ValueRow {
            kind: RowKind::Body {
                path: segments_to_path(&self.segs),
            },
            value,
        });
    }

    fn walk(&mut self, node: &Node, depth: usize) -> Result<(), ()> {
        match node {
            Node::Null => self.push(PickValue::Null),
            Node::Bool(b) => self.push(PickValue::Bool(*b)),
            Node::Num(n) => self.push(PickValue::Number(n.clone())),
            Node::Str(s) => match unwrap_str(s) {
                Some(inner) => {
                    self.unwrapped = true;
                    self.walk(&inner, depth)?;
                }
                None => self.push(PickValue::Str(s.clone())),
            },
            Node::Arr(items) => {
                if depth + 1 > PRETTY_MAX_DEPTH {
                    return Err(());
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
                    return Err(());
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
                };
                match w.walk(&root, 0) {
                    Ok(()) => {
                        // 7
                        rows.append(&mut w.rows);
                        if w.unwrapped {
                            notes.push(ListNote::Unwrapped);
                        }
                    }
                    Err(()) => {
                        // 6: 풀기까지 마친 값의 중첩이 64단 초과
                        rows.push(body_text_row());
                        notes.push(ListNote::TooDeep);
                    }
                }
            }
        }
    }
    ValueList { rows, notes }
}
