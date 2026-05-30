use std::collections::BTreeMap;

use crate::error::{EngineError, Result};

#[derive(Debug, Clone)]
pub struct TemplateContext<'a> {
    pub vars: &'a BTreeMap<String, String>,
    pub env: &'a BTreeMap<String, String>,
    pub vu_id: u32,
    pub iter_id: u32,
    /// Current loop iteration index (0-based), or `None` outside any loop.
    pub loop_index: Option<u32>,
}

/// Substitute `{{var}}` (from `vars`) and `${NAME}` (system vars or env). Strict:
/// any unresolved token errors (fail-fast at request build time).
/// - `${vu_id}` / `${iter_id}` resolve to their numeric values.
/// - `${loop_index}` resolves to the current 0-based loop index, or errors outside a loop.
/// - `${NAME}` resolves against `ctx.env`; unknown name with no default → error.
/// - `${NAME:-default}` falls back to `default` when `NAME` is absent from env.
/// - Unknown `{{name}}` → error.
pub fn render(input: &str, ctx: &TemplateContext) -> Result<String> {
    render_inner(input, ctx, false)
}

/// Lenient variant for **condition evaluation** (spec §3.1). Shares the parser
/// with [`render`] but every unresolved token (`{{var}}`, undefined `${NAME}`,
/// `${loop_index}` outside a loop) renders to the empty string, and an unclosed
/// `{{`/`${` marker is emitted literally. It never returns `Err` — condition
/// evaluation must never kill a run (extract failure → natural branching). Mirrors
/// the UI `resolveForDisplay` philosophy (preserve/soften unresolved tokens).
pub fn render_lenient(input: &str, ctx: &TemplateContext) -> String {
    // `render_inner(.., true)` provably never returns Err; default-guard is defensive.
    render_inner(input, ctx, true).unwrap_or_default()
}

fn render_inner(input: &str, ctx: &TemplateContext, lenient: bool) -> Result<String> {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    // Track the start of the current literal run so we can push it as a
    // UTF-8 slice rather than byte-by-byte (which would corrupt multi-byte
    // characters like Korean/emoji).
    let mut lit_start = 0;

    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'{' && bytes[i + 1] == b'{' {
            // Flush any pending literal bytes before this substitution.
            out.push_str(&input[lit_start..i]);
            let end = match find_pair(bytes, i + 2, b"}}") {
                Some(e) => e,
                None => {
                    if lenient {
                        out.push_str(&input[i..]);
                        return Ok(out);
                    }
                    return Err(EngineError::MalformedTemplate(format!(
                        "unclosed {{{{ at byte {i}"
                    )));
                }
            };
            let name = std::str::from_utf8(&bytes[i + 2..end])
                .map_err(|_| EngineError::MalformedTemplate("non-utf8 in {{ }}".into()))?
                .trim();
            match ctx.vars.get(name) {
                Some(value) => out.push_str(value),
                None => {
                    if !lenient {
                        return Err(EngineError::UnknownVar(name.to_string()));
                    }
                    // lenient: push nothing (empty string).
                }
            }
            i = end + 2;
            lit_start = i;
            continue;
        }
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'{' {
            // Flush any pending literal bytes before this substitution.
            out.push_str(&input[lit_start..i]);
            let end = match find_byte(bytes, i + 2, b'}') {
                Some(e) => e,
                None => {
                    if lenient {
                        out.push_str(&input[i..]);
                        return Ok(out);
                    }
                    return Err(EngineError::MalformedTemplate(format!(
                        "unclosed ${{ at byte {i}"
                    )));
                }
            };
            let inner = std::str::from_utf8(&bytes[i + 2..end])
                .map_err(|_| EngineError::MalformedTemplate("non-utf8 in ${ }".into()))?;
            let (name, default) = match inner.find(":-") {
                Some(p) => (inner[..p].trim(), Some(inner[p + 2..].to_string())),
                None => (inner.trim(), None),
            };
            let value: Option<String> = match name {
                "vu_id" => Some(ctx.vu_id.to_string()),
                "iter_id" => Some(ctx.iter_id.to_string()),
                "loop_index" => ctx.loop_index.map(|x| x.to_string()),
                other => match ctx.env.get(other) {
                    Some(v) => Some(v.clone()),
                    None => default,
                },
            };
            match value {
                Some(v) => out.push_str(&v),
                None => {
                    if !lenient {
                        return Err(EngineError::UnknownVar(name.to_string()));
                    }
                    // lenient: push nothing.
                }
            }
            i = end + 1;
            lit_start = i;
            continue;
        }
        // Advance one byte; the literal slice will be flushed at the next
        // substitution boundary or at the end of input.
        i += 1;
    }
    // Flush any remaining literal tail.
    out.push_str(&input[lit_start..]);
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

    fn empty_env() -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    #[test]
    fn renders_flow_var() {
        let v = vars(&[("base_url", "http://x")]);
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(render("{{base_url}}/path", &ctx).unwrap(), "http://x/path");
    }

    #[test]
    fn renders_loop_index_when_set() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: Some(2),
        };
        assert_eq!(render("item-${loop_index}", &ctx).unwrap(), "item-2");
    }

    #[test]
    fn loop_index_outside_loop_errors() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert!(matches!(
            render("${loop_index}", &ctx),
            Err(EngineError::UnknownVar(_))
        ));
    }

    #[test]
    fn renders_vu_id_and_iter_id() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 7,
            iter_id: 42,
            loop_index: None,
        };
        assert_eq!(render("u${vu_id}-i${iter_id}", &ctx).unwrap(), "u7-i42");
    }

    #[test]
    fn unknown_flow_var_errors() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert!(matches!(
            render("{{nope}}", &ctx),
            Err(EngineError::UnknownVar(_))
        ));
    }

    #[test]
    fn unknown_system_var_errors() {
        // ${SOMETHING} with empty env and no default — still errors.
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert!(matches!(
            render("${SOMETHING}", &ctx),
            Err(EngineError::UnknownVar(_))
        ));
    }

    #[test]
    fn unclosed_brace_errors() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert!(matches!(
            render("{{nope", &ctx),
            Err(EngineError::MalformedTemplate(_))
        ));
    }

    #[test]
    fn passthrough() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(
            render("no templates here", &ctx).unwrap(),
            "no templates here"
        );
    }

    #[test]
    fn renders_env_var() {
        let v = BTreeMap::new();
        let env: BTreeMap<String, String> =
            [("BASE_URL".to_string(), "https://prod.example".to_string())]
                .into_iter()
                .collect();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(
            render("${BASE_URL}/x", &ctx).unwrap(),
            "https://prod.example/x"
        );
    }

    #[test]
    fn env_var_default_used_when_missing() {
        let v = BTreeMap::new();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(
            render("${MISSING:-localhost}/x", &ctx).unwrap(),
            "localhost/x"
        );
    }

    #[test]
    fn env_var_default_ignored_when_present() {
        let v = BTreeMap::new();
        let env: BTreeMap<String, String> = [("HOST".to_string(), "prod".to_string())]
            .into_iter()
            .collect();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(render("${HOST:-fallback}", &ctx).unwrap(), "prod");
    }

    #[test]
    fn empty_default_is_valid() {
        let v = BTreeMap::new();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(render("[${X:-}]", &ctx).unwrap(), "[]");
    }

    #[test]
    fn unknown_env_var_without_default_errors() {
        let v = BTreeMap::new();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert!(matches!(
            render("${MISSING}", &ctx),
            Err(EngineError::UnknownVar(_))
        ));
    }

    #[test]
    fn preserves_non_ascii_literals() {
        // Non-ASCII in the literal segments, plus substitutions of both kinds.
        // "상품" and "검색" are Korean (each char = 3 UTF-8 bytes).
        // "값" is the substituted flow-var value (also non-ASCII).
        let v = vars(&[("name", "값")]);
        let env: BTreeMap<String, String> = [("BASE_URL".to_string(), "http://x".to_string())]
            .into_iter()
            .collect();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(
            render("${BASE_URL}/상품/{{name}}/검색", &ctx).unwrap(),
            "http://x/상품/값/검색"
        );
    }

    #[test]
    fn system_var_still_works_alongside_env() {
        let v = BTreeMap::new();
        let env: BTreeMap<String, String> = [("HOST".to_string(), "h".to_string())]
            .into_iter()
            .collect();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 9,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(render("${HOST}/${vu_id}", &ctx).unwrap(), "h/9");
    }

    #[test]
    fn lenient_unknown_flow_var_is_empty() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(render_lenient("[{{missing}}]", &ctx), "[]");
    }

    #[test]
    fn lenient_unknown_env_var_is_empty() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(render_lenient("[${NOPE}]", &ctx), "[]");
        // ...but a default still resolves.
        assert_eq!(render_lenient("${NOPE:-fb}", &ctx), "fb");
    }

    #[test]
    fn lenient_loop_index_outside_loop_is_empty() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(render_lenient("i${loop_index}", &ctx), "i");
    }

    #[test]
    fn lenient_resolves_known_vars_same_as_strict() {
        let v = vars(&[("code", "200")]);
        let env: BTreeMap<String, String> =
            [("H".to_string(), "x".to_string())].into_iter().collect();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 7,
            iter_id: 0,
            loop_index: Some(2),
        };
        assert_eq!(
            render_lenient("${H}/{{code}}/${vu_id}/${loop_index}", &ctx),
            "x/200/7/2"
        );
    }

    #[test]
    fn lenient_unclosed_marker_is_literal_and_never_errors() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        // No panic, no error path — unclosed braces pass through literally.
        assert_eq!(render_lenient("a{{unclosed", &ctx), "a{{unclosed");
        assert_eq!(render_lenient("b${unclosed", &ctx), "b${unclosed");
    }
}
