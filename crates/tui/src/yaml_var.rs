//! 시나리오 `variables:` 고정 값 한 줄 교체(spec §6.4). 엔진·서버 없는 순수 함수.
//!
//! 주석·순서·나머지 글자는 그대로 두고 값 구간 하나만 바꾼 뒤, 옛·새를 구조로 다시 비교해
//! 잘못 잘랐으면 저장하지 않는다(fail-closed).

use handicap_engine::{Scenario, VarDecl};

/// 이 값을 TUI가 못 고치는 사유.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotEditable {
    /// 생성 변수(`{gen: …}`).
    Generated,
    /// 그 밖 — 여러 줄·앵커·흐름 표기·키 못 찾음·검증 실패.
    Shape,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaticVar {
    pub key: String,
    pub value: String,
    pub editable: Result<(), NotEditable>,
}

/// `Scenario::from_yaml`의 `variables` 순서(키 순). 고정 변수는 `value` = 값,
/// `editable` = 같은 값으로 `splice_static_var`를 한 번 돌린 결과. 생성 변수는 `value` = ""
/// + `Err(Generated)`. YAML을 못 읽으면 빈 목록.
pub fn static_vars(yaml: &str) -> Vec<StaticVar> {
    let Ok(sc) = Scenario::from_yaml(yaml) else {
        return Vec::new();
    };
    sc.variables
        .iter()
        .map(|(key, decl)| match decl {
            VarDecl::Static(value) => StaticVar {
                key: key.clone(),
                value: value.clone(),
                editable: splice_static_var(yaml, key, value).map(|_| ()),
            },
            VarDecl::Gen { .. } => StaticVar {
                key: key.clone(),
                value: String::new(),
                editable: Err(NotEditable::Generated),
            },
        })
        .collect()
}

/// 성공하면 `key` 값 구간만 `serde_json::to_string(new)`로 바뀐 전체 YAML.
pub fn splice_static_var(yaml: &str, key: &str, new: &str) -> Result<String, NotEditable> {
    let sc = Scenario::from_yaml(yaml).map_err(|_| NotEditable::Shape)?;
    match sc.variables.get(key) {
        Some(VarDecl::Static(_)) => {}
        Some(VarDecl::Gen { .. }) => return Err(NotEditable::Generated),
        None => return Err(NotEditable::Shape),
    }

    // ① 줄 + 줄 끝
    let lines: Vec<(&str, &str)> = yaml.split_inclusive('\n').map(split_eol).collect();

    // ② 열 0 `variables:` 줄 정확히 1개
    let mut headers = lines
        .iter()
        .enumerate()
        .filter(|(_, (body, _))| is_variables_header(body))
        .map(|(i, _)| i);
    let header = headers.next().ok_or(NotEditable::Shape)?;
    if headers.next().is_some() {
        return Err(NotEditable::Shape);
    }

    // ③ 블록 = 다음 "열 0이 공백도 `#`도 아닌 줄" 전까지
    let start = header + 1;
    let end = lines[start..]
        .iter()
        .position(
            |(body, _)| matches!(body.chars().next(), Some(c) if c != ' ' && c != '\t' && c != '#'),
        )
        .map_or(lines.len(), |p| start + p);
    let block = &lines[start..end];
    let indent = block
        .iter()
        .find(|(body, _)| {
            let t = body.trim_start_matches(' ');
            !t.is_empty() && !t.starts_with('#')
        })
        .map(|(body, _)| body.len() - body.trim_start_matches(' ').len())
        .filter(|&n| n > 0)
        .ok_or(NotEditable::Shape)?;

    // ④ 그 들여쓰기의 `key:` 줄 정확히 1개
    let mut hits = block
        .iter()
        .enumerate()
        .filter_map(|(i, (body, _))| key_value_start(body, indent, key).map(|v| (start + i, v)));
    let (line_idx, value_start) = hits.next().ok_or(NotEditable::Shape)?;
    if hits.next().is_some() {
        return Err(NotEditable::Shape);
    }

    // ⑤ 값 구간
    let (body, _) = lines[line_idx];
    let (vs, ve) = value_span(body, value_start).ok_or(NotEditable::Shape)?;

    // ⑥ 교체
    let literal = serde_json::to_string(new).map_err(|_| NotEditable::Shape)?;
    let mut out = String::with_capacity(yaml.len() + literal.len());
    for (i, (b, e)) in lines.iter().enumerate() {
        if i == line_idx {
            out.push_str(&b[..vs]);
            out.push_str(&literal);
            out.push_str(&b[ve..]);
        } else {
            out.push_str(b);
        }
        out.push_str(e);
    }

    // ⑦ 검증 — 잘못 자른 경우의 최종 방어선
    verify(yaml, &out, key, new)?;
    Ok(out)
}

fn verify(old: &str, new_yaml: &str, key: &str, new: &str) -> Result<(), NotEditable> {
    use serde_yaml::Value;
    let mut expected: Value = serde_yaml::from_str(old).map_err(|_| NotEditable::Shape)?;
    let actual: Value = serde_yaml::from_str(new_yaml).map_err(|_| NotEditable::Shape)?;
    let slot = expected
        .get_mut("variables")
        .and_then(|v| v.get_mut(key))
        .ok_or(NotEditable::Shape)?;
    *slot = Value::String(new.to_string());
    if expected != actual || Scenario::from_yaml(new_yaml).is_err() {
        return Err(NotEditable::Shape);
    }
    Ok(())
}

/// `(본문, 줄 끝)` — 줄 끝은 `\r\n` / `\n` / 없음.
fn split_eol(line: &str) -> (&str, &str) {
    if let Some(b) = line.strip_suffix("\r\n") {
        (b, "\r\n")
    } else if let Some(b) = line.strip_suffix('\n') {
        (b, "\n")
    } else {
        (line, "")
    }
}

fn is_variables_header(body: &str) -> bool {
    match body.strip_prefix("variables:") {
        Some(rest) => {
            let r = rest.trim_start_matches([' ', '\t']);
            r.is_empty() || r.starts_with('#')
        }
        None => false,
    }
}

/// `indent`칸 들여쓰기 + 키(`key`·`"key"`·`'key'`) + `:` + 공백 1개 이상이면 값이 시작하는 바이트 위치.
fn key_value_start(body: &str, indent: usize, key: &str) -> Option<usize> {
    if body.len() < indent || !body.as_bytes()[..indent].iter().all(|&b| b == b' ') {
        return None;
    }
    let rest = &body[indent..];
    if rest.starts_with([' ', '\t']) {
        return None;
    }
    let after_key = [key.to_string(), format!("\"{key}\""), format!("'{key}'")]
        .iter()
        .find_map(|k| rest.strip_prefix(k.as_str()))?;
    let after_colon = after_key.strip_prefix(':')?;
    let spaces = after_colon.len() - after_colon.trim_start_matches(' ').len();
    if spaces == 0 {
        return None;
    }
    Some(body.len() - after_colon.len() + spaces)
}

/// 값 구간 `[시작, 끝)`. 못 고치는 모양이면 None.
fn value_span(body: &str, start: usize) -> Option<(usize, usize)> {
    let v = &body[start..];
    let first = v.chars().next()?;
    if matches!(first, '|' | '>' | '&' | '*' | '!' | '{' | '[' | '#') {
        return None;
    }
    let bytes = v.as_bytes();
    match first {
        '\'' => {
            let mut i = 1;
            while i < bytes.len() {
                if bytes[i] == b'\'' {
                    if bytes.get(i + 1) == Some(&b'\'') {
                        i += 2;
                        continue;
                    }
                    return Some((start, start + i + 1));
                }
                i += 1;
            }
            None
        }
        '"' => {
            let mut i = 1;
            while i < bytes.len() {
                match bytes[i] {
                    b'\\' => i += 2,
                    b'"' => return Some((start, start + i + 1)),
                    _ => i += 1,
                }
            }
            None
        }
        _ => {
            let end = v.find(" #").unwrap_or(v.len());
            let trimmed = v[..end].trim_end_matches([' ', '\t']);
            if trimmed.is_empty() {
                None
            } else {
                Some((start, start + trimmed.len()))
            }
        }
    }
}
