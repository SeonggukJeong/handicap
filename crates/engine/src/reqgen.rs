//! 생성 변수 요청 단위 재평가 (spec 2026-10-17-genvar-per-request §4.2–4.4).

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use rand::rngs::StdRng;
use rand::{RngCore, SeedableRng};

use crate::executor::request_flow_refs;
use crate::genvars::{GenSpec, Refresh, VarDecl, eval_gen};
use crate::scenario::{HttpStep, Scenario, Step};

/// run당 1회 계산(부하 3진입점은 VU spawn 전, test-run은 trace 호출당) — `Arc`로 VU 공유.
#[derive(Debug)]
#[allow(dead_code)] // Task 3 배선 후 제거
pub(crate) struct RequestGenPlan {
    names: Vec<String>,
    specs: Vec<GenSpec>,
    /// step_id → 재평가 대상(names 인덱스). 같은 step_id 여러 스텝은 합집합(§4.3).
    by_step: HashMap<String, Vec<usize>>,
}

impl RequestGenPlan {
    /// `refresh: request` 선언이 없으면 `None` — 호출부는 상태를 만들지 않는다(hot path 분기 1회).
    #[allow(dead_code)] // Task 3 배선 후 제거
    pub(crate) fn build(scenario: &Scenario) -> Option<Arc<Self>> {
        let mut names = Vec::new();
        let mut specs = Vec::new();
        for (k, d) in &scenario.variables {
            if let VarDecl::Gen {
                spec,
                refresh: Refresh::Request,
            } = d
            {
                names.push(k.clone());
                specs.push(spec.clone());
            }
        }
        if names.is_empty() {
            return None;
        }
        let mut https: Vec<&HttpStep> = Vec::new();
        collect_http(&scenario.steps, &mut https);
        let mut by_step: HashMap<String, Vec<usize>> = HashMap::new();
        for h in https {
            let refs = request_flow_refs(&h.request, &names);
            if refs.is_empty() {
                continue;
            }
            let e = by_step.entry(h.id.clone()).or_default();
            for i in refs {
                if !e.contains(&i) {
                    e.push(i);
                }
            }
        }
        Some(Arc::new(Self {
            names,
            specs,
            by_step,
        }))
    }

    #[allow(dead_code)] // Task 3 배선 후 제거
    pub(crate) fn targets(&self, step_id: &str) -> &[usize] {
        self.by_step.get(step_id).map(Vec::as_slice).unwrap_or(&[])
    }
}

fn collect_http<'a>(steps: &'a [Step], out: &mut Vec<&'a HttpStep>) {
    for s in steps {
        match s {
            Step::Http(h) => out.push(h),
            Step::Loop(l) => collect_http(&l.do_, out),
            Step::If(i) => {
                collect_http(&i.then_, out);
                for e in &i.elif {
                    collect_http(&e.then_, out);
                }
                collect_http(&i.else_, out);
            }
            Step::Parallel(p) => {
                for b in &p.branches {
                    collect_http(&b.steps, out);
                }
            }
        }
    }
}

/// 반복(또는 parallel 분기) 단위 재평가 상태 — 생성기 rng + 죽은 집합(§4.2).
#[allow(dead_code)] // Task 3 배선 후 제거
pub(crate) struct ReqGen {
    plan: Arc<RequestGenPlan>,
    rng: StdRng,
    dead: Vec<bool>,
}

impl ReqGen {
    /// `seed`는 호출부의 **생성기** rng에서 뽑는다(think rng 금지).
    #[allow(dead_code)] // Task 3 배선 후 제거
    pub(crate) fn new(plan: Arc<RequestGenPlan>, seed: u64) -> Self {
        let n = plan.names.len();
        Self {
            plan,
            rng: StdRng::seed_from_u64(seed),
            dead: vec![false; n],
        }
    }

    /// 데이터셋 주입·추출이 **실제로 쓴** 키 — 그 반복(분기)의 남은 요청에서 재평가 중지
    /// (우선순위 생성 < 데이터셋 < 추출 유지).
    #[allow(dead_code)] // Task 3 배선 후 제거
    pub(crate) fn mark_written<'a>(&mut self, keys: impl IntoIterator<Item = &'a String>) {
        for k in keys {
            if let Some(i) = self.plan.names.iter().position(|n| n == k) {
                self.dead[i] = true;
            }
        }
    }

    /// 요청 직전: 이 스텝이 참조하는 살아 있는 refresh 변수만 새로 평가해 덮어쓴다.
    #[allow(dead_code)] // Task 3 배선 후 제거
    pub(crate) fn refresh(&mut self, step_id: &str, vars: &mut BTreeMap<String, String>) {
        let targets = self.plan.targets(step_id);
        if targets.is_empty() {
            return;
        }
        let now = chrono::Utc::now();
        for &i in targets {
            if !self.dead[i] {
                let v = eval_gen(&self.plan.specs[i], &mut self.rng, now);
                vars.insert(self.plan.names[i].clone(), v);
            }
        }
    }

    /// parallel 분기용 복제 — 죽은 집합 복사 + 부모 생성기 rng에서 시드 1개.
    #[allow(dead_code)] // Task 3 배선 후 제거
    pub(crate) fn fork(&mut self) -> Self {
        Self {
            plan: self.plan.clone(),
            rng: StdRng::seed_from_u64(self.rng.next_u64()),
            dead: self.dead.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::Scenario;
    use std::collections::BTreeMap;

    fn sc(vars: &str, steps: &str) -> Scenario {
        Scenario::from_yaml(&format!(
            "version: 1\nname: t\nvariables:\n{vars}\nsteps:\n{steps}"
        ))
        .unwrap()
    }
    fn http(id: &str, url: &str) -> String {
        format!(
            "  - {{ id: \"{id}\", name: s, type: http, request: {{ method: GET, url: \"{url}\" }} }}\n"
        )
    }
    const ID_A: &str = "01HX0000000000000000000001";
    const ID_B: &str = "01HX0000000000000000000002";

    #[test]
    fn no_request_vars_builds_none() {
        let s = sc("  f: {gen: uuid}", &http(ID_A, "http://x/{{f}}"));
        assert!(
            RequestGenPlan::build(&s).is_none(),
            "refresh 없으면 상태 없음(hot path 0)"
        );
    }

    fn names_for(plan: &RequestGenPlan, id: &str) -> Vec<String> {
        plan.targets(id)
            .iter()
            .map(|&i| plan.names[i].clone())
            .collect()
    }

    /// 필드별 lockstep(spec §4.3): url·헤더 값·JSON leaf·JSON 캐스트 leaf·form 값·raw·공백 토큰.
    #[test]
    fn refs_per_field_lockstep() {
        let cases: &[(&str, &str)] = &[
            ("url", "request: { method: GET, url: \"http://x/{{f}}\" }"),
            (
                "header",
                "request: { method: GET, url: \"http://x/\", headers: { X-A: \"{{f}}\" } }",
            ),
            (
                "json leaf",
                "request: { method: POST, url: \"http://x/\", body: { json: { a: \"p-{{f}}\" } } }",
            ),
            (
                "json cast",
                "request: { method: POST, url: \"http://x/\", body: { json: { a: \"{{f:json}}\" } } }",
            ),
            (
                "form",
                "request: { method: POST, url: \"http://x/\", body: { form: { a: \"{{f}}\" } } }",
            ),
            (
                "raw",
                "request: { method: POST, url: \"http://x/\", body: { raw: \"v={{f}}\" } }",
            ),
            (
                "spaced",
                "request: { method: GET, url: \"http://x/{{ f }}\" }",
            ),
        ];
        for (label, req) in cases {
            let s = sc(
                "  f: {gen: uuid, refresh: request}",
                &format!("  - id: \"{ID_A}\"\n    name: s\n    type: http\n    {req}\n"),
            );
            let p = RequestGenPlan::build(&s).unwrap();
            assert_eq!(names_for(&p, ID_A), vec!["f".to_string()], "field {label}");
        }
    }

    #[test]
    fn env_and_system_tokens_are_not_targets() {
        // ${f}·"${f:json}"는 env 토큰 — 이름이 같아도 대상 아님(spec §4.3 더미 env).
        // ${loop_index}·${BASE_URL}은 교집합에서 빠짐.
        let s = sc(
            "  f: {gen: uuid, refresh: request}",
            &format!(
                "  - id: \"{ID_A}\"\n    name: s\n    type: http\n    request: {{ method: POST, url: \"${{BASE_URL}}/${{f}}/${{loop_index}}\", body: {{ json: {{ a: \"${{f:json}}\" }} }} }}\n"
            ),
        );
        let p = RequestGenPlan::build(&s).unwrap();
        assert!(p.targets(ID_A).is_empty(), "{:?}", names_for(&p, ID_A));
    }

    #[test]
    fn nested_steps_and_unreferenced_step() {
        let steps = format!(
            "  - id: \"01HX00000000000000000000M0\"\n    name: lp\n    type: loop\n    repeat: 2\n    do:\n      - {{ id: \"{ID_A}\", name: a, type: http, request: {{ method: GET, url: \"http://x/{{{{f}}}}\" }} }}\n{}",
            http(ID_B, "http://x/none")
        );
        let s = sc("  f: {gen: uuid, refresh: request}", &steps);
        let p = RequestGenPlan::build(&s).unwrap();
        assert_eq!(names_for(&p, ID_A), vec!["f".to_string()]);
        assert!(p.targets(ID_B).is_empty());
    }

    #[test]
    fn duplicate_step_id_unions_targets() {
        let steps = format!(
            "{}{}",
            http(ID_A, "http://x/{{f}}"),
            http(ID_A, "http://x/{{g}}")
        );
        let s = sc(
            "  f: {gen: uuid, refresh: request}\n  g: {gen: uuid, refresh: request}",
            &steps,
        );
        let p = RequestGenPlan::build(&s).unwrap();
        let mut got = names_for(&p, ID_A);
        got.sort();
        assert_eq!(got, vec!["f".to_string(), "g".to_string()]);
    }

    #[test]
    fn iteration_vars_are_never_targets() {
        let s = sc(
            "  f: {gen: uuid, refresh: request}\n  o: {gen: uuid}",
            &http(ID_A, "http://x/{{f}}/{{o}}"),
        );
        let p = RequestGenPlan::build(&s).unwrap();
        assert_eq!(names_for(&p, ID_A), vec!["f".to_string()]);
    }

    #[test]
    fn refresh_regenerates_only_alive_targets() {
        let s = sc(
            "  f: {gen: uuid, refresh: request}\n  g: {gen: uuid, refresh: request}",
            &http(ID_A, "http://x/{{f}}/{{g}}"),
        );
        let p = RequestGenPlan::build(&s).unwrap();
        let mut rg = ReqGen::new(p, 7);
        let mut vars: BTreeMap<String, String> = [
            ("f".to_string(), "F0".to_string()),
            ("g".to_string(), "G0".to_string()),
        ]
        .into();
        rg.mark_written([&"g".to_string()]);
        rg.refresh(ID_A, &mut vars);
        assert_ne!(vars["f"], "F0", "살아 있는 f는 재평가");
        assert_eq!(vars["g"], "G0", "쓰인 g는 재평가 안 함");
        let f1 = vars["f"].clone();
        rg.refresh(ID_A, &mut vars);
        assert_ne!(vars["f"], f1, "요청마다 새 값");
        rg.refresh("unknown-step", &mut vars); // 대상 없는 스텝은 no-op
    }

    #[test]
    fn fork_copies_dead_set_and_diverges() {
        let s = sc(
            "  f: {gen: uuid, refresh: request}\n  g: {gen: uuid, refresh: request}",
            &http(ID_A, "http://x/{{f}}/{{g}}"),
        );
        let p = RequestGenPlan::build(&s).unwrap();
        let mut parent = ReqGen::new(p, 7);
        parent.mark_written([&"g".to_string()]);
        let mut a = parent.fork();
        let mut b = parent.fork();
        let mut va: BTreeMap<String, String> = [("g".to_string(), "G".to_string())].into();
        let mut vb = va.clone();
        a.refresh(ID_A, &mut va);
        b.refresh(ID_A, &mut vb);
        assert_eq!(va["g"], "G");
        assert_eq!(vb["g"], "G");
        assert_ne!(va["f"], vb["f"], "분기마다 다른 rng");
    }
}
