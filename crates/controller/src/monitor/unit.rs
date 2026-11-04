//! 실행 단위 — 점검 묶음/단독 칸을 한 번의 trace로 돌리는 계획·제한·실행.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use handicap_engine::{Scenario, ScenarioTrace, Step, TraceOptions, trace_scenario};

use super::check::{
    CheckResult, MONITOR_MAX_REQUESTS, REASON_LATENCY_STEP_MISSING, Verdict, collect_http_steps,
    load_scenario_env, reason_timeout,
};
use super::config::{BoardConfig, PanelConfig};
use super::step_judge::judge_unit;
use crate::store::{self, Db};

/// 칸이 없는 http 스텝의 기본 요청 제한(초).
pub const UNPANELED_STEP_TIMEOUT_SECS: u32 = 5;
pub const STEP_TIMEOUT_MAX_SECS: u32 = 30;
pub const FLOW_CAP_MAX_SECS: u32 = 120;
/// 바깥 타임아웃 여유(초).
pub const OUTER_GRACE_SECS: u32 = 32;
/// 첫 실행 전(또는 설정 오류) 단위 예산 = 흐름 상한 최대 + 여유.
pub const INITIAL_STEP_BUDGET_SECS: u32 = FLOW_CAP_MAX_SECS + OUTER_GRACE_SECS;

/// 한 번의 trace로 돌리는 실행 단위(스텝 칸들).
#[derive(Debug, Clone)]
pub struct CheckUnit {
    pub scenario_id: String,
    pub environment_id: Option<String>,
    pub interval_seconds: u32,
    pub panels: Vec<PanelConfig>,
}

#[derive(Debug, Clone)]
pub enum UnitPlan {
    /// 흐름 전체 단독 칸 — 기존 `run_check`.
    Whole(PanelConfig),
    Steps(CheckUnit),
}

/// 칸 순서대로 실행 단위를 만든다. 묶음은 첫 소속 칸 위치에 한 번.
pub fn plan_units(cfg: &BoardConfig) -> Vec<UnitPlan> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out = Vec::new();
    for p in &cfg.panels {
        let group = p
            .group_id
            .as_deref()
            .and_then(|g| cfg.groups.iter().find(|x| x.id == g));
        if let Some(g) = group {
            if !seen.insert(g.id.as_str()) {
                continue;
            }
            out.push(UnitPlan::Steps(CheckUnit {
                scenario_id: g.scenario_id.clone(),
                environment_id: g.environment_id.clone(),
                interval_seconds: g.interval_seconds,
                panels: cfg
                    .panels
                    .iter()
                    .filter(|q| q.group_id.as_deref() == Some(g.id.as_str()))
                    .cloned()
                    .collect(),
            }));
        } else if p.step_id.is_some() {
            out.push(UnitPlan::Steps(CheckUnit {
                scenario_id: p.scenario_id.clone(),
                environment_id: p.environment_id.clone(),
                interval_seconds: p.interval_seconds,
                panels: vec![p.clone()],
            }));
        } else {
            out.push(UnitPlan::Whole(p.clone()));
        }
    }
    out
}

fn walk_http_mut(steps: &mut [Step], f: &mut impl FnMut(&mut handicap_engine::HttpStep)) {
    for s in steps {
        match s {
            Step::Http(h) => f(h),
            Step::Loop(l) => walk_http_mut(&mut l.do_, f),
            Step::If(i) => {
                walk_http_mut(&mut i.then_, f);
                for e in &mut i.elif {
                    walk_http_mut(&mut e.then_, f);
                }
                walk_http_mut(&mut i.else_, f);
            }
            Step::Parallel(p) => {
                for b in &mut p.branches {
                    walk_http_mut(&mut b.steps, f);
                }
            }
        }
    }
}

/// 스텝별 요청 제한을 시나리오 복사본에 기록하고 (흐름 상한, 스텝별 제한)을 돌려준다.
pub fn apply_step_limits(sc: &mut Scenario, unit: &CheckUnit) -> (u32, HashMap<String, u32>) {
    let mut panel_limit: HashMap<&str, u32> = HashMap::new();
    for p in &unit.panels {
        if let Some(id) = p.step_id.as_deref() {
            let e = panel_limit.entry(id).or_insert(0);
            *e = (*e).max(p.timeout_seconds.min(STEP_TIMEOUT_MAX_SECS));
        }
    }
    let mut limits: HashMap<String, u32> = HashMap::new();
    walk_http_mut(&mut sc.steps, &mut |h| {
        let limit = match panel_limit.get(h.id.as_str()) {
            Some(&t) => t,
            None => match h.timeout_seconds {
                Some(v) if v > 0 => v.min(STEP_TIMEOUT_MAX_SECS),
                _ => UNPANELED_STEP_TIMEOUT_SECS,
            },
        };
        h.timeout_seconds = Some(limit);
        limits.insert(h.id.clone(), limit);
    });
    let sum: u32 = limits.values().sum();
    (sum.min(FLOW_CAP_MAX_SECS), limits)
}

pub fn outer_timeout_results(n: usize, at_ms: i64, flow_cap: u32) -> Vec<CheckResult> {
    (0..n)
        .map(|_| CheckResult {
            at_ms,
            verdict: Verdict::Fail,
            latency_ms: None,
            reason: Some(reason_timeout(flow_cap)),
            detail: None,
            display: Vec::new(),
        })
        .collect()
}

pub struct UnitOutcome {
    pub trace: Option<ScenarioTrace>,
    pub results: Vec<CheckResult>,
    pub budget_secs: u32,
}

/// 단위 점검 1회 — 시나리오를 한 번 실행하고 모든 스텝 칸을 판정한다.
pub async fn run_unit_check(db: &Db, unit: &CheckUnit) -> UnitOutcome {
    let at_ms = store::now_ms();
    let (mut scenario, env) =
        match load_scenario_env(db, &unit.scenario_id, unit.environment_id.as_deref()).await {
            Ok(v) => v,
            Err(reason) => {
                return UnitOutcome {
                    trace: None,
                    results: unit
                        .panels
                        .iter()
                        .map(|_| CheckResult {
                            at_ms,
                            verdict: Verdict::ConfigError,
                            latency_ms: None,
                            reason: Some(reason.to_string()),
                            detail: None,
                            display: Vec::new(),
                        })
                        .collect(),
                    budget_secs: INITIAL_STEP_BUDGET_SECS,
                };
            }
        };
    // 모든 칸의 스텝이 시나리오에 없으면 요청을 보내지 않는다(설정 오류에 부하를 쓰지 않음 —
    // 흐름 전체 칸과 같은 원칙). 판정은 `judge_unit`의 스텝 없음과 같다.
    let mut all = Vec::new();
    collect_http_steps(&scenario.steps, &mut all);
    let missing = |p: &PanelConfig| {
        let sid = p.step_id.as_deref().unwrap_or_default();
        !all.iter().any(|h| h.id == sid)
    };
    if !unit.panels.is_empty() && unit.panels.iter().all(missing) {
        return UnitOutcome {
            trace: None,
            results: unit
                .panels
                .iter()
                .map(|_| CheckResult {
                    at_ms,
                    verdict: Verdict::ConfigError,
                    latency_ms: None,
                    reason: Some(REASON_LATENCY_STEP_MISSING.to_string()),
                    detail: None,
                    display: Vec::new(),
                })
                .collect(),
            budget_secs: INITIAL_STEP_BUDGET_SECS,
        };
    }
    let (flow_cap, limits) = apply_step_limits(&mut scenario, unit);
    let opts = TraceOptions {
        env,
        max_requests: MONITOR_MAX_REQUESTS,
        max_wall: Duration::from_secs(u64::from(flow_cap)),
        apply_think_time: false,
    };
    let budget_secs = flow_cap + OUTER_GRACE_SECS;
    let outer = Duration::from_secs(u64::from(budget_secs));
    match tokio::time::timeout(outer, trace_scenario(&scenario, &opts)).await {
        Err(_) => UnitOutcome {
            trace: None,
            results: outer_timeout_results(unit.panels.len(), at_ms, flow_cap),
            budget_secs,
        },
        Ok(trace) => UnitOutcome {
            results: judge_unit(&scenario, &unit.panels, &trace, at_ms, flow_cap, &limits),
            trace: Some(trace),
            budget_secs,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::check::Verdict;
    use crate::monitor::config::{BoardConfig, CheckGroup, PanelConfig};
    use crate::store;
    use handicap_engine::Scenario;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn id(n: u32) -> String {
        format!("01HX00000000000000000000{n:02}")
    }

    fn step_yaml(n: u32, url: &str, timeout: Option<u32>) -> String {
        let t = timeout.map_or(String::new(), |t| format!("    timeout_seconds: {t}\n"));
        format!(
            "  - id: \"{}\"\n    name: s{n}\n    type: http\n    request: {{ method: GET, url: \"{url}\" }}\n{t}",
            id(n)
        )
    }

    fn scenario(steps: &[String]) -> Scenario {
        Scenario::from_yaml(&format!("version: 1\nname: s\nsteps:\n{}", steps.concat())).unwrap()
    }

    fn sp(panel_id: &str, step: u32, timeout: u32) -> PanelConfig {
        PanelConfig {
            id: panel_id.into(),
            scenario_id: "sc".into(),
            group_id: Some("g".into()),
            step_id: Some(id(step)),
            timeout_seconds: timeout,
            ..PanelConfig::default()
        }
    }

    fn unit(panels: Vec<PanelConfig>) -> CheckUnit {
        CheckUnit {
            scenario_id: "sc".into(),
            environment_id: None,
            interval_seconds: 10,
            panels,
        }
    }

    fn limit_of(sc: &Scenario, n: u32) -> Option<u32> {
        sc.steps.iter().find_map(|s| match s {
            handicap_engine::Step::Http(h) if h.id == id(n) => h.timeout_seconds,
            _ => None,
        })
    }

    #[test]
    fn plan_units_mixed() {
        let mut cfg = BoardConfig::default();
        cfg.groups.push(CheckGroup {
            id: "g".into(),
            scenario_id: "sc".into(),
            environment_id: None,
            interval_seconds: 20,
        });
        let whole = PanelConfig {
            id: "w".into(),
            scenario_id: "sc2".into(),
            ..PanelConfig::default()
        };
        let solo = PanelConfig {
            id: "solo".into(),
            scenario_id: "sc3".into(),
            step_id: Some(id(1)),
            ..PanelConfig::default()
        };
        cfg.panels = vec![sp("a", 1, 3), whole, sp("b", 2, 3), solo];
        let plans = plan_units(&cfg);
        assert_eq!(plans.len(), 3);
        match &plans[0] {
            UnitPlan::Steps(u) => {
                assert_eq!(u.panels.len(), 2);
                assert_eq!(u.panels[0].id, "a");
                assert_eq!(u.panels[1].id, "b");
                assert_eq!(u.interval_seconds, 20);
                assert_eq!(u.scenario_id, "sc");
            }
            UnitPlan::Whole(_) => panic!("expected Steps"),
        }
        assert!(matches!(&plans[1], UnitPlan::Whole(p) if p.id == "w"));
        match &plans[2] {
            UnitPlan::Steps(u) => {
                assert_eq!(u.panels.len(), 1);
                assert_eq!(u.scenario_id, "sc3");
            }
            UnitPlan::Whole(_) => panic!("expected Steps"),
        }
    }

    #[test]
    fn step_limits_table() {
        // 1,2: 칸 3초 / 3: 칸 없음, 시나리오 600 → 30 / 4: 칸 없음, 값 없음 → 5
        let mut sc = scenario(&[
            step_yaml(1, "http://x/1", None),
            step_yaml(2, "http://x/2", None),
            step_yaml(3, "http://x/3", Some(600)),
            step_yaml(4, "http://x/4", None),
        ]);
        let u = unit(vec![sp("a", 1, 3), sp("b", 2, 3)]);
        let (cap, limits) = apply_step_limits(&mut sc, &u);
        assert_eq!(cap, 41);
        assert_eq!(limits.get(&id(1)), Some(&3));
        assert_eq!(limits.get(&id(3)), Some(&30));
        assert_eq!(limits.get(&id(4)), Some(&5));
        assert_eq!(limit_of(&sc, 3), Some(30));
        assert_eq!(limit_of(&sc, 4), Some(5));
        assert_eq!(limit_of(&sc, 1), Some(3));
    }

    #[test]
    fn step_limits_unpaneled_keeps_smaller_scenario_value() {
        let mut sc = scenario(&[step_yaml(1, "http://x/1", Some(2))]);
        let (cap, _) = apply_step_limits(&mut sc, &unit(vec![]));
        assert_eq!(cap, 2);
        assert_eq!(limit_of(&sc, 1), Some(2));
    }

    #[test]
    fn step_limits_cap_120() {
        let steps: Vec<String> = (1..=7).map(|n| step_yaml(n, "http://x", None)).collect();
        let mut sc = scenario(&steps);
        let panels = (1..=7).map(|n| sp(&format!("p{n}"), n, 30)).collect();
        let (cap, _) = apply_step_limits(&mut sc, &unit(panels));
        assert_eq!(cap, 120);
    }

    #[test]
    fn step_limits_shared_step_uses_max_once() {
        let mut sc = scenario(&[step_yaml(1, "http://x/1", None)]);
        let u = unit(vec![sp("a", 1, 3), sp("b", 1, 7)]);
        let (cap, limits) = apply_step_limits(&mut sc, &u);
        assert_eq!(limits.get(&id(1)), Some(&7));
        assert_eq!(cap, 7);
        assert_eq!(limit_of(&sc, 1), Some(7));
    }

    #[test]
    fn outer_timeout_results_all_fail() {
        let rs = outer_timeout_results(3, 100, 41);
        assert_eq!(rs.len(), 3);
        for r in rs {
            assert_eq!(r.verdict, Verdict::Fail);
            assert_eq!(r.reason.as_deref(), Some("시간 초과(41초)"));
            assert_eq!(r.at_ms, 100);
        }
    }

    #[tokio::test]
    async fn run_unit_check_one_trace_per_round() {
        let server = MockServer::start().await;
        for p in ["/login1", "/login2", "/race"] {
            Mock::given(method("GET"))
                .and(path(p))
                .respond_with(ResponseTemplate::new(200))
                .expect(1)
                .mount(&server)
                .await;
        }
        let base = server.uri();
        let yaml = format!(
            "version: 1\nname: s\nsteps:\n{}",
            [
                step_yaml(1, &format!("{base}/login1"), None),
                step_yaml(2, &format!("{base}/login2"), None),
                step_yaml(3, &format!("{base}/race"), None),
            ]
            .concat()
        );
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sc = Scenario::from_yaml(&yaml).unwrap();
        let row = store::scenarios::insert(&db, &sc, &yaml).await.unwrap();
        let mut panels = vec![sp("a", 1, 5), sp("b", 2, 5), sp("c", 3, 5)];
        for p in &mut panels {
            p.scenario_id = row.id.clone();
        }
        let mut u = unit(panels);
        u.scenario_id = row.id;
        let out = run_unit_check(&db, &u).await;
        assert!(out.trace.is_some());
        assert_eq!(out.results.len(), 3);
        assert_eq!(out.budget_secs, 15 + OUTER_GRACE_SECS);
        let at = out.results[0].at_ms;
        for r in &out.results {
            assert_eq!(r.verdict, Verdict::Ok, "{r:?}");
            assert_eq!(r.at_ms, at);
        }
        drop(server); // expect(1) 검증
    }

    #[tokio::test]
    async fn run_unit_check_missing_scenario() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let mut u = unit(vec![sp("a", 1, 5), sp("b", 2, 5)]);
        u.scenario_id = "nope".into();
        let out = run_unit_check(&db, &u).await;
        assert!(out.trace.is_none());
        assert_eq!(out.budget_secs, INITIAL_STEP_BUDGET_SECS);
        assert_eq!(out.results.len(), 2);
        for r in &out.results {
            assert_eq!(r.verdict, Verdict::ConfigError);
            assert_eq!(r.reason.as_deref(), Some("시나리오를 찾을 수 없음"));
        }
    }

    fn ind(s: &str, k: usize) -> String {
        let pad = " ".repeat(k);
        s.lines().map(|l| format!("{pad}{l}\n")).collect()
    }

    /// loop { s1, IF { then: [s2], elif: [s3], else: [s4, parallel { x: [s5], y: [s6] }] } }
    fn nested_scenario() -> Scenario {
        let mut y = String::from("version: 1\nname: s\nsteps:\n");
        y += &format!(
            "  - id: \"{}\"\n    name: 반복\n    type: loop\n    repeat: 1\n    do:\n",
            id(90)
        );
        y += &ind(&step_yaml(1, "http://x/1", None), 4);
        y += &format!(
            "      - id: \"{}\"\n        name: 분기\n        type: if\n        cond: {{ left: \"{{{{a}}}}\", op: eq, right: \"1\" }}\n        then:\n",
            id(91)
        );
        y += &ind(&step_yaml(2, "http://x/2", None), 8);
        y += "        elif:\n          - cond: { left: \"{{a}}\", op: eq, right: \"2\" }\n            then:\n";
        y += &ind(&step_yaml(3, "http://x/3", Some(600)), 12);
        y += "        else:\n";
        y += &ind(&step_yaml(4, "http://x/4", None), 8);
        y += &format!(
            "          - id: \"{}\"\n            name: 동시\n            type: parallel\n            branches:\n              - name: x\n                steps:\n",
            id(92)
        );
        y += &ind(&step_yaml(5, "http://x/5", None), 16);
        y += "              - name: y\n                steps:\n";
        y += &ind(&step_yaml(6, "http://x/6", None), 16);
        Scenario::from_yaml(&y).unwrap()
    }

    #[test]
    fn step_limits_nested_walk() {
        let mut sc = nested_scenario();
        // 칸: 1(3초)·2(4초)·5(6초) / 칸 없음: 3(시나리오 600 → 30)·4·6(값 없음 → 5)
        let u = unit(vec![sp("a", 1, 3), sp("b", 2, 4), sp("c", 5, 6)]);
        let (cap, limits) = apply_step_limits(&mut sc, &u);
        let want = [(1, 3), (2, 4), (3, 30), (4, 5), (5, 6), (6, 5)];
        assert_eq!(limits.len(), want.len(), "{limits:?}");
        let mut all = Vec::new();
        crate::monitor::check::collect_http_steps(&sc.steps, &mut all);
        assert_eq!(all.len(), want.len());
        for (n, secs) in want {
            assert_eq!(limits.get(&id(n)), Some(&secs), "limits step {n}");
            let h = all.iter().find(|h| h.id == id(n)).unwrap();
            assert_eq!(h.timeout_seconds, Some(secs), "scenario step {n}");
        }
        // 각 스텝 한 번씩: 3+4+30+5+6+5
        assert_eq!(cap, 53);
    }

    #[tokio::test]
    async fn run_unit_check_all_steps_missing_sends_nothing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;
        let yaml = format!(
            "version: 1\nname: s\nsteps:\n{}",
            step_yaml(1, &format!("{}/x", server.uri()), None)
        );
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sc = Scenario::from_yaml(&yaml).unwrap();
        let row = store::scenarios::insert(&db, &sc, &yaml).await.unwrap();
        let mut panels = vec![sp("a", 98, 5), sp("b", 99, 5)];
        for p in &mut panels {
            p.scenario_id = row.id.clone();
        }
        let mut u = unit(panels);
        u.scenario_id = row.id;
        let out = run_unit_check(&db, &u).await;
        assert!(out.trace.is_none());
        assert_eq!(out.budget_secs, INITIAL_STEP_BUDGET_SECS);
        assert_eq!(out.results.len(), 2);
        for r in &out.results {
            assert_eq!(r.verdict, Verdict::ConfigError, "{r:?}");
            assert_eq!(
                r.reason.as_deref(),
                Some(crate::monitor::check::REASON_LATENCY_STEP_MISSING)
            );
        }
        drop(server); // expect(0) 검증
    }

    #[tokio::test]
    async fn run_unit_check_some_steps_missing_still_runs() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        let yaml = format!(
            "version: 1\nname: s\nsteps:\n{}",
            step_yaml(1, &format!("{}/x", server.uri()), None)
        );
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sc = Scenario::from_yaml(&yaml).unwrap();
        let row = store::scenarios::insert(&db, &sc, &yaml).await.unwrap();
        let mut panels = vec![sp("a", 1, 5), sp("b", 99, 5)];
        for p in &mut panels {
            p.scenario_id = row.id.clone();
        }
        let mut u = unit(panels);
        u.scenario_id = row.id;
        let out = run_unit_check(&db, &u).await;
        assert!(out.trace.is_some());
        assert_eq!(out.results[0].verdict, Verdict::Ok);
        assert_eq!(out.results[1].verdict, Verdict::ConfigError);
        drop(server); // expect(1) 검증
    }
}
