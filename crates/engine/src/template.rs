use std::collections::BTreeMap;

use crate::error::{EngineError, Result};

#[derive(Debug, Clone)]
pub struct TemplateContext<'a> {
    pub vars: &'a BTreeMap<String, String>,
    pub vu_id: u32,
    pub iter_id: u32,
}

/// Substitute `{{var}}` (from `vars`) and `${vu_id}` / `${iter_id}` (system).
/// Unknown `{{name}}` → error. `${OTHER}` → error (env support is Slice 4).
pub fn render(input: &str, ctx: &TemplateContext) -> Result<String> {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'{' && bytes[i + 1] == b'{' {
            let end = find_pair(bytes, i + 2, b"}}").ok_or_else(|| {
                EngineError::MalformedTemplate(format!("unclosed {{{{ at byte {i}"))
            })?;
            let name = std::str::from_utf8(&bytes[i + 2..end])
                .map_err(|_| EngineError::MalformedTemplate("non-utf8 in {{ }}".into()))?
                .trim();
            let value = ctx
                .vars
                .get(name)
                .ok_or_else(|| EngineError::UnknownVar(name.to_string()))?;
            out.push_str(value);
            i = end + 2;
            continue;
        }
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'{' {
            let end = find_byte(bytes, i + 2, b'}').ok_or_else(|| {
                EngineError::MalformedTemplate(format!("unclosed ${{ at byte {i}"))
            })?;
            let name = std::str::from_utf8(&bytes[i + 2..end])
                .map_err(|_| EngineError::MalformedTemplate("non-utf8 in ${{ }}".into()))?
                .trim();
            let value = match name {
                "vu_id" => ctx.vu_id.to_string(),
                "iter_id" => ctx.iter_id.to_string(),
                other => return Err(EngineError::UnknownVar(other.to_string())),
            };
            out.push_str(&value);
            i = end + 1;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    Ok(out)
}

fn find_pair(b: &[u8], start: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || start >= b.len() {
        return None;
    }
    let mut i = start;
    while i + needle.len() <= b.len() {
        if &b[i..i + needle.len()] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn find_byte(b: &[u8], start: usize, needle: u8) -> Option<usize> {
    b[start..]
        .iter()
        .position(|c| *c == needle)
        .map(|p| p + start)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn renders_flow_var() {
        let v = vars(&[("base_url", "http://x")]);
        let ctx = TemplateContext {
            vars: &v,
            vu_id: 0,
            iter_id: 0,
        };
        assert_eq!(render("{{base_url}}/path", &ctx).unwrap(), "http://x/path");
    }

    #[test]
    fn renders_vu_id_and_iter_id() {
        let v = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &v,
            vu_id: 7,
            iter_id: 42,
        };
        assert_eq!(render("u${vu_id}-i${iter_id}", &ctx).unwrap(), "u7-i42");
    }

    #[test]
    fn unknown_flow_var_errors() {
        let v = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &v,
            vu_id: 0,
            iter_id: 0,
        };
        assert!(matches!(
            render("{{nope}}", &ctx),
            Err(EngineError::UnknownVar(_))
        ));
    }

    #[test]
    fn unknown_system_var_errors() {
        // ${ENV} substitution is slice 4 — currently errors.
        let v = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &v,
            vu_id: 0,
            iter_id: 0,
        };
        assert!(matches!(
            render("${SOMETHING}", &ctx),
            Err(EngineError::UnknownVar(_))
        ));
    }

    #[test]
    fn unclosed_brace_errors() {
        let v = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &v,
            vu_id: 0,
            iter_id: 0,
        };
        assert!(matches!(
            render("{{nope", &ctx),
            Err(EngineError::MalformedTemplate(_))
        ));
    }

    #[test]
    fn passthrough() {
        let v = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &v,
            vu_id: 0,
            iter_id: 0,
        };
        assert_eq!(
            render("no templates here", &ctx).unwrap(),
            "no templates here"
        );
    }
}
