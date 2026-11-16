//! 비움 표 — 추출 못 해 `""`로 비워진 flow 변수를 주소에 쓰는 요청을 막는 순수 판정
//! (blank-var-url-guard R1·R2). runner·trace 공통.

use std::collections::BTreeMap;

use crate::template::{TemplateContext, render_collecting_reads};

/// 이름 → 그 값을 비운 http 스텝 id.
pub type BlankTable = BTreeMap<String, String>;

/// 차단된 스텝의 고정 에러 문자열(값·이름 없음).
pub const BLOCKED_ERROR: &str = "not sent: blank value in url";

#[derive(Clone, PartialEq, Eq)]
pub struct Blocked {
    pub vars: Vec<String>,
    pub by_step: String,
    /// lenient 렌더 결과 — 풀린 `${ENV}` 값·userinfo·쿼리 비밀이 들 수 있다(Debug에 싣지 않는다).
    pub url: String,
}

impl std::fmt::Debug for Blocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Blocked")
            .field("vars", &self.vars)
            .field("by_step", &self.by_step)
            .field("url", &"<redacted>")
            .finish()
    }
}

/// R2: 주소가 읽는 이름 중 (비움 표에 있고 ∧ ctx.vars 값이 지금도 "")인 것이 있으면 Some.
/// vars = 주소에 나온 순서·중복 제거, by_step = 첫 이름의 원인, url = lenient 렌더 결과.
pub fn check(url_template: &str, ctx: &TemplateContext, table: &BlankTable) -> Option<Blocked> {
    // 비움 표가 비면(조건 반복이 없는 시나리오 전부) 렌더하지 않는다 — 핫 패스 비용 0.
    if table.is_empty() {
        return None;
    }
    let mut reads = Vec::new();
    let url = render_collecting_reads(url_template, ctx, &mut reads);
    let mut vars: Vec<String> = Vec::new();
    for name in reads {
        if table.contains_key(&name)
            && ctx.vars.get(&name).is_some_and(|v| v.is_empty())
            && !vars.contains(&name)
        {
            vars.push(name);
        }
    }
    let by_step = table.get(vars.first()?)?.clone();
    Some(Blocked { vars, by_step, url })
}

/// 정상 실행된 http 스텝 뒤: `blanked`에 든 이름은 table에 (이름 → step_id)로 적고,
/// `extracted`의 나머지 키는 table에서 지운다.
pub fn note_step(
    table: &mut BlankTable,
    step_id: &str,
    extracted: &BTreeMap<String, String>,
    blanked: &[String],
) {
    for k in extracted.keys() {
        if !blanked.contains(k) {
            table.remove(k);
        }
    }
    for k in blanked {
        table.insert(k.clone(), step_id.to_string());
    }
}

/// parallel 병합: `names` 중 `branch_vars`에 있는 k마다 key = "{branch_name}.{k}" —
/// branch_table에 k가 있으면 parent에 (key → 그 원인) 삽입, 없으면 parent에서 key 제거.
pub fn merge_branch(
    parent: &mut BlankTable,
    branch_table: &BlankTable,
    branch_name: &str,
    names: &[&str],
    branch_vars: &BTreeMap<String, String>,
) {
    for k in names {
        if !branch_vars.contains_key(*k) {
            continue;
        }
        let key = format!("{branch_name}.{k}");
        match branch_table.get(*k) {
            Some(cause) => {
                parent.insert(key, cause.clone());
            }
            None => {
                parent.remove(&key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn ctx<'a>(
        vars: &'a BTreeMap<String, String>,
        env: &'a BTreeMap<String, String>,
    ) -> TemplateContext<'a> {
        TemplateContext {
            vars,
            env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        }
    }

    #[test]
    fn reads_follow_strict_tokenizer() {
        let vars = m(&[("orderId", "1"), ("b.orderId", "2"), ("a", "3")]);
        let env = BTreeMap::new();
        let c = ctx(&vars, &env);
        let input = "/a/{{ orderId }}/{{b.orderId}}/${X:-{{a}}}";
        let mut reads = Vec::new();
        let out = render_collecting_reads(input, &c, &mut reads);
        assert_eq!(reads, vec!["orderId", "b.orderId"]);
        assert_eq!(out, crate::template::render(input, &c).unwrap());
    }

    #[test]
    fn check_blocks_blank_in_url() {
        let vars = m(&[("orderId", "")]);
        let env = BTreeMap::new();
        let t = m(&[("orderId", "S1")]);
        assert_eq!(
            check("/orders/{{orderId}}", &ctx(&vars, &env), &t),
            Some(Blocked {
                vars: vec!["orderId".into()],
                by_step: "S1".into(),
                url: "/orders/".into()
            })
        );
    }

    #[test]
    fn blocked_debug_omits_url() {
        let b = Blocked {
            vars: vec!["orderId".into()],
            by_step: "S1".into(),
            url: "https://user:pw@host/orders/?token=SECRET".into(),
        };
        let s = format!("{b:?}");
        assert_eq!(
            s,
            r#"Blocked { vars: ["orderId"], by_step: "S1", url: "<redacted>" }"#
        );
        assert!(!s.contains("SECRET") && !s.contains("host/orders"), "{s}");
    }

    #[test]
    fn check_passes_when_value_refilled() {
        let vars = m(&[("orderId", "7")]);
        let env = BTreeMap::new();
        let t = m(&[("orderId", "S1")]);
        assert_eq!(check("/orders/{{orderId}}", &ctx(&vars, &env), &t), None);
    }

    #[test]
    fn check_passes_when_not_in_table() {
        let vars = m(&[("orderId", "")]);
        let env = BTreeMap::new();
        let t = BlankTable::new();
        assert_eq!(check("/orders/{{orderId}}", &ctx(&vars, &env), &t), None);
    }

    #[test]
    fn check_ignores_env_and_system() {
        let vars = m(&[("BASE", ""), ("vu_id", "")]);
        let env = BTreeMap::new();
        let t = m(&[("BASE", "S1"), ("vu_id", "S1")]);
        assert_eq!(check("${BASE}/x/${vu_id}", &ctx(&vars, &env), &t), None);
    }

    #[test]
    fn check_orders_and_dedups() {
        let vars = m(&[("a", ""), ("b", "")]);
        let env = BTreeMap::new();
        let t = m(&[("a", "S1"), ("b", "S2")]);
        let b = check("/{{b}}/{{a}}/{{b}}", &ctx(&vars, &env), &t).unwrap();
        assert_eq!(b.vars, vec!["b", "a"]);
        assert_eq!(b.by_step, "S2");
    }

    #[test]
    fn check_wins_over_unknown_var() {
        let vars = m(&[("orderId", "")]);
        let env = BTreeMap::new();
        let t = m(&[("orderId", "S1")]);
        assert!(check("/{{orderId}}/{{nope}}", &ctx(&vars, &env), &t).is_some());
    }

    #[test]
    fn note_step_sets_and_clears() {
        let mut t = m(&[("a", "S0")]);
        note_step(
            &mut t,
            "S1",
            &m(&[("a", ""), ("b", "")]),
            &["b".to_string()],
        );
        assert_eq!(t, m(&[("b", "S1")]));
    }

    #[test]
    fn merge_branch_prefixes_and_clears() {
        let mut parent = m(&[("br.v", "OLD"), ("br.w", "OLD")]);
        let bt = m(&[("v", "S9")]);
        merge_branch(
            &mut parent,
            &bt,
            "br",
            &["v", "w"],
            &m(&[("v", ""), ("w", "ok")]),
        );
        assert_eq!(parent, m(&[("br.v", "S9")]));
    }
}
