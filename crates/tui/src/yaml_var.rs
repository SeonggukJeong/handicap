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
/// `editable` = 글자 위치 찾기(①–⑤)만 돌린 결과 — `Ok(())`는 "한 줄 모양으로 보인다"는 뜻이다.
/// ⑦ 검증만이 잡는 드문 모양(예: 일반 스칼라가 다음 줄로 이어지는 값)은 여기선 `Ok(())`로 보이고,
/// 저장 때 `splice_static_var`가 `Err(Shape)`로 거절한다(fail-closed는 저장 경로에 남는다).
/// 생성 변수는 `value` = "" + `Err(Generated)`. YAML을 못 읽으면 빈 목록.
///
/// YAML 파싱은 한 번, 블록 훑기도 한 번(변수마다 다시 파싱하거나 블록을 다시 훑으면
/// 큰 시나리오에서 UI 스레드가 분 단위로 멈춘다).
pub fn static_vars(yaml: &str) -> Vec<StaticVar> {
    let Ok(sc) = Scenario::from_yaml(yaml) else {
        return Vec::new();
    };
    let lines = split_lines(yaml);
    let keys: Vec<&str> = sc
        .variables
        .iter()
        .filter(|(_, d)| matches!(d, VarDecl::Static(_)))
        .map(|(k, _)| k.as_str())
        .collect();
    let index = var_block(&lines).map(|b| key_index(&lines, b, &keys));
    sc.variables
        .iter()
        .map(|(key, decl)| match decl {
            VarDecl::Static(value) => StaticVar {
                key: key.clone(),
                value: value.clone(),
                editable: index.as_ref().map_err(|e| *e).and_then(|idx| {
                    match idx.get(key.as_str()) {
                        Some(&Hit {
                            lines: 1,
                            line,
                            value_start,
                        }) => value_span(lines[line].0, value_start)
                            .map(|_| ())
                            .ok_or(NotEditable::Shape),
                        _ => Err(NotEditable::Shape),
                    }
                }),
            },
            VarDecl::Gen { .. } => StaticVar {
                key: key.clone(),
                value: String::new(),
                editable: Err(NotEditable::Generated),
            },
        })
        .collect()
}

/// `key_index`의 키별 ④ 결과: 맞은 줄 수 + 첫 줄 · 값 시작.
#[derive(Debug, Clone, Copy)]
struct Hit {
    lines: usize,
    line: usize,
    value_start: usize,
}

/// 블록을 한 번 훑어 `keys` 각각의 ④ 결과를 모은다 — `locate_in`의 ④와 같은 판정.
/// 맞으려면 `key`·`"key"`·`'key'`가 들여쓰기 바로 뒤에서 `: ` 앞에서 끝나야 하므로, 줄마다
/// `: ` 위치에서 끝나는 후보만 키 목록에서 찾고 최종 판정은 `key_value_start`에 맡긴다.
fn key_index<'k>(
    lines: &[(&str, &str)],
    b: VarBlock,
    keys: &[&'k str],
) -> std::collections::HashMap<&'k str, Hit> {
    use std::collections::{HashMap, HashSet};
    let set: HashSet<&str> = keys.iter().copied().collect();
    let lens: HashSet<usize> = keys.iter().map(|k| k.len()).collect();
    let max_len = keys.iter().map(|k| k.len()).max().unwrap_or(0) + 2;
    let mut out: HashMap<&'k str, Hit> = HashMap::new();
    for (li, (body, _)) in lines.iter().enumerate().take(b.end).skip(b.start) {
        let Some(rest) = body.get(b.indent..) else {
            continue;
        };
        let quote = rest.chars().next().filter(|c| matches!(c, '"' | '\''));
        let mut seen: Vec<&str> = Vec::new();
        for (p, _) in rest.match_indices(": ") {
            if p > max_len {
                break;
            }
            let mut cands: [Option<&str>; 2] = [None, None];
            if lens.contains(&p) {
                cands[0] = rest.get(..p);
            }
            if let Some(q) = quote
                && p >= 2
                && lens.contains(&(p - 2))
                && rest[..p].ends_with(q)
            {
                cands[1] = rest.get(1..p - 1);
            }
            for c in cands.into_iter().flatten() {
                let Some(&k) = set.get(c) else { continue };
                if seen.contains(&k) {
                    continue;
                }
                if let Some(v) = key_value_start(body, b.indent, k) {
                    seen.push(k);
                    out.entry(k).and_modify(|h| h.lines += 1).or_insert(Hit {
                        lines: 1,
                        line: li,
                        value_start: v,
                    });
                }
            }
        }
    }
    out
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
    let lines = split_lines(yaml);
    // ②–⑤
    let (line_idx, vs, ve) = locate(&lines, key)?;

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

/// ① 줄 + 줄 끝.
fn split_lines(yaml: &str) -> Vec<(&str, &str)> {
    yaml.split_inclusive('\n').map(split_eol).collect()
}

/// `variables` 블록: `[start, end)` 줄 범위 + 키 들여쓰기.
#[derive(Debug, Clone, Copy)]
struct VarBlock {
    start: usize,
    end: usize,
    indent: usize,
}

/// ②–⑤ 파싱 없는 글자 위치 찾기: `(줄 번호, 값 시작, 값 끝)`.
fn locate(lines: &[(&str, &str)], key: &str) -> Result<(usize, usize, usize), NotEditable> {
    locate_in(lines, var_block(lines)?, key)
}

/// ②–③: 머리 줄 정확히 1개 → 블록 → 들여쓰기.
fn var_block(lines: &[(&str, &str)]) -> Result<VarBlock, NotEditable> {
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
    let indent = lines[start..end]
        .iter()
        .find(|(body, _)| {
            let t = body.trim_start_matches(' ');
            !t.is_empty() && !t.starts_with('#')
        })
        .map(|(body, _)| body.len() - body.trim_start_matches(' ').len())
        .filter(|&n| n > 0)
        .ok_or(NotEditable::Shape)?;
    Ok(VarBlock { start, end, indent })
}

/// ④–⑤: 블록 안 그 들여쓰기의 `key:` 줄 정확히 1개 → 값 구간.
fn locate_in(
    lines: &[(&str, &str)],
    b: VarBlock,
    key: &str,
) -> Result<(usize, usize, usize), NotEditable> {
    // ④ 그 들여쓰기의 `key:` 줄 정확히 1개
    let mut hits = lines[b.start..b.end]
        .iter()
        .enumerate()
        .filter_map(|(i, (body, _))| {
            key_value_start(body, b.indent, key).map(|v| (b.start + i, v))
        });
    let (line_idx, value_start) = hits.next().ok_or(NotEditable::Shape)?;
    if hits.next().is_some() {
        return Err(NotEditable::Shape);
    }

    // ⑤ 값 구간
    let (body, _) = lines[line_idx];
    let (vs, ve) = value_span(body, value_start).ok_or(NotEditable::Shape)?;
    Ok((line_idx, vs, ve))
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
    // `key` → `"key"` → `'key'` 순(할당 없이 — 변수마다 블록 전체를 훑는다).
    let quoted = |q: char| rest.strip_prefix(q)?.strip_prefix(key)?.strip_prefix(q);
    let after_key = rest
        .strip_prefix(key)
        .or_else(|| quoted('"'))
        .or_else(|| quoted('\''))?;
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
            // 주석 = 공백 **또는 탭** 뒤의 `#`. 주석은 ⑦의 구조 비교에 안 잡히므로 여기서 놓치면 조용히 지워진다.
            let end = bytes
                .windows(2)
                .position(|w| matches!(w[0], b' ' | b'\t') && w[1] == b'#')
                .unwrap_or(v.len());
            let trimmed = v[..end].trim_end_matches([' ', '\t']);
            if trimmed.is_empty() {
                None
            } else {
                Some((start, start + trimmed.len()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `static_vars`의 한 번 훑기 색인이 변수마다 `locate`를 돈 결과와 같은지.
    #[test]
    fn index_matches_locate() {
        let step = "steps:\n  - { id: \"01J00000000000000000000A01\", name: a, type: http, request: { method: GET, url: \"/a\" }, assert: [] }\n";
        let blocks = [
            "variables:\n  a: x\n  b: 'y'\n  c: \"z\"  # c\n",
            "variables:\n  \"a\": x\n  'b': y\n  c: q\n",
            "variables:\n  a: x\n  b: \"q\n  a: y\"\n",
            "variables:\n  a: \"x\n  a: y\"\n  b: z\n",
            "variables:\n  a: &x \"a1\"\n  b: |\n    t\n  c: {gen: uuid}\n",
            "variables:\n  order_id: A-1\n    B-2\n  t: a#b\n",
            "variables: # c\n  # note\n  a: x\r\n  b: y\r\n",
            "variables:\n  a: \"x: y\"\n  \"x: y\": z\n  'it''s': q\n",
            "variables: {a: x, b: y}\n",
        ];
        for blk in blocks {
            let y = format!("version: 1\nname: s\n{blk}{step}");
            let Ok(sc) = Scenario::from_yaml(&y) else {
                panic!("fixture invalid:\n{y}");
            };
            let lines = split_lines(&y);
            let got = static_vars(&y);
            assert_eq!(got.len(), sc.variables.len());
            for v in got {
                if v.editable == Err(NotEditable::Generated) {
                    continue;
                }
                let want = locate(&lines, &v.key).map(|_| ());
                assert_eq!(v.editable, want, "key {:?} in\n{y}", v.key);
            }
        }
    }
}
