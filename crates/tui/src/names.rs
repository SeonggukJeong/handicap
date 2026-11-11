//! 번들 파일 → 시나리오·스텝·환경 이름(spec §5.3 "이름 해석").
//!
//! wire.rs의 `deny_unknown_fields`를 일부러 따르지 않는다 — 이름 표시용이고, 형식 검증은
//! 서버 가져오기가 이미 했다. 필요한 키(`scenarios[].{id,yaml}`, `environments[].{id,name}`)만
//! 읽고, 환경 `vars`는 역직렬화하지 않는다(값을 메모리에 들지 않는다). 실패해도 이름이 id로
//! 보일 뿐이라 절대 실패하지 않는다(fail-soft).

use std::collections::HashMap;

use handicap_engine::{HttpStep, Scenario, Step};
use serde::Deserialize;

use crate::session::strip_bom;

/// GUI `flattenHttpSteps`와 같은 순서: http → loop.do → if(then, elif[].then, else) →
/// parallel(branches[].steps), 깊이 우선.
pub fn flatten_http_steps(steps: &[Step]) -> Vec<&HttpStep> {
    let mut out = Vec::new();
    collect(steps, &mut out);
    out
}

fn collect<'a>(steps: &'a [Step], out: &mut Vec<&'a HttpStep>) {
    for s in steps {
        // 와일드카드 금지 — 엔진이 변형을 더하면 컴파일 오류로 알게.
        match s {
            Step::Http(h) => out.push(h),
            Step::Loop(l) => collect(&l.do_, out),
            Step::If(i) => {
                collect(&i.then_, out);
                for elif in &i.elif {
                    collect(&elif.then_, out);
                }
                collect(&i.else_, out);
            }
            Step::Parallel(p) => {
                for b in &p.branches {
                    collect(&b.steps, out);
                }
            }
        }
    }
}

/// `method` = `HttpMethod`의 serde 문자열("GET"), `url` = YAML에 적힌 그대로
/// (`{{var}}`·`${ENV}` 미치환).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepInfo {
    pub id: String,
    pub name: String,
    pub method: String,
    pub url: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ScenarioNames {
    name: String,
    /// 평탄화 순서. YAML을 못 읽은 시나리오는 맵에 없다(맵에 없음 = 못 읽음).
    steps: Vec<StepInfo>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Names {
    scenarios: HashMap<String, ScenarioNames>,
    environments: HashMap<String, String>,
}

#[derive(Deserialize)]
struct BundleLite {
    #[serde(default)]
    scenarios: Vec<ScenarioLite>,
    #[serde(default)]
    environments: Vec<EnvLite>,
}

#[derive(Deserialize)]
struct ScenarioLite {
    id: String,
    yaml: String,
}

#[derive(Deserialize)]
struct EnvLite {
    id: String,
    name: String,
}

fn method_str(h: &HttpStep) -> String {
    serde_json::to_value(h.request.method)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

impl Names {
    /// `file` = 번들 파일 바이트(BOM 있어도 됨). JSON이 깨졌으면 빈 Names,
    /// 시나리오 YAML 하나가 깨졌으면 그 시나리오만 빠진다. 절대 실패하지 않는다.
    pub fn from_bundle(file: &[u8]) -> Names {
        let Ok(lite) = serde_json::from_slice::<BundleLite>(strip_bom(file)) else {
            return Names::default();
        };
        let scenarios = lite
            .scenarios
            .into_iter()
            .filter_map(|s| {
                let sc = Scenario::from_yaml(&s.yaml).ok()?;
                let steps = flatten_http_steps(&sc.steps)
                    .into_iter()
                    .map(|h| StepInfo {
                        id: h.id.clone(),
                        name: h.name.clone(),
                        method: method_str(h),
                        url: h.request.url.clone(),
                    })
                    .collect();
                Some((
                    s.id,
                    ScenarioNames {
                        name: sc.name,
                        steps,
                    },
                ))
            })
            .collect();
        let environments = lite
            .environments
            .into_iter()
            .map(|e| (e.id, e.name))
            .collect();
        Names {
            scenarios,
            environments,
        }
    }

    pub fn scenario_name(&self, scenario_id: &str) -> Option<&str> {
        self.scenarios.get(scenario_id).map(|s| s.name.as_str())
    }

    /// `None` = 그 시나리오를 못 읽음. `Some(목록)` = 평탄화 순서.
    pub fn step_infos(&self, scenario_id: &str) -> Option<&[StepInfo]> {
        self.scenarios.get(scenario_id).map(|s| s.steps.as_slice())
    }

    /// (평탄화 순번 1부터, 정보)
    pub fn step_info(&self, scenario_id: &str, step_id: &str) -> Option<(usize, &StepInfo)> {
        self.step_infos(scenario_id)?
            .iter()
            .enumerate()
            .find(|(_, s)| s.id == step_id)
            .map(|(i, s)| (i + 1, s))
    }

    pub fn step_name(&self, scenario_id: &str, step_id: &str) -> Option<&str> {
        self.step_info(scenario_id, step_id)
            .map(|(_, s)| s.name.as_str())
    }

    pub fn env_name(&self, environment_id: &str) -> Option<&str> {
        self.environments.get(environment_id).map(String::as_str)
    }
}
