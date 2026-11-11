//! 번들 파일 → 시나리오·스텝·환경 이름(spec §5.3 "이름 해석").
//!
//! wire.rs의 `deny_unknown_fields`를 일부러 따르지 않는다 — 이름 표시용이고, 형식 검증은
//! 서버 가져오기가 이미 했다. 필요한 키(`scenarios[].{id,yaml}`, `environments[].{id,name}`)만
//! 읽고, 환경 `vars`는 키 이름만 읽는다(값은 `IgnoredAny`로 버려 메모리에 들지 않는다). 실패해도 이름이 id로
//! 보일 뿐이라 절대 실패하지 않는다(fail-soft).

use std::collections::{BTreeMap, HashMap};

use handicap_engine::{HttpStep, Scenario, Step, VarDecl};
use serde::Deserialize;
use serde::de::IgnoredAny;

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
    /// `variables`의 (키, 종류), 키 순.
    vars: Vec<(String, VarKind)>,
}

/// 시나리오 변수 종류 — 엔진 `VarDecl`의 고정/생성 구분.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VarKind {
    Static,
    Generated,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Names {
    scenarios: HashMap<String, ScenarioNames>,
    environments: HashMap<String, String>,
    /// 번들 `environments[]` 순서의 (id, 이름).
    env_order: Vec<(String, String)>,
    /// 환경 id → 변수 키(키 순). 값은 들지 않는다.
    env_keys: HashMap<String, Vec<String>>,
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
    /// 키만 남고 값은 버려진다.
    #[serde(default)]
    vars: VarKeys,
}

/// 환경 `vars`의 키 이름만(키 순). 값은 `IgnoredAny`로 버려 메모리에 들지 않는다.
/// 객체가 아닌 모양(null·문자열·배열·숫자)이면 빈 목록 — 이 모듈은 절대 실패하지 않는다(fail-soft).
#[derive(Default)]
struct VarKeys(Vec<String>);

impl<'de> Deserialize<'de> for VarKeys {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = VarKeys;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("anything")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut m: A,
            ) -> Result<VarKeys, A::Error> {
                let mut keys = BTreeMap::new();
                while let Some((k, _)) = m.next_entry::<String, IgnoredAny>()? {
                    keys.insert(k, ());
                }
                Ok(VarKeys(keys.into_keys().collect()))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> Result<VarKeys, A::Error> {
                while a.next_element::<IgnoredAny>()?.is_some() {}
                Ok(VarKeys::default())
            }
            fn visit_unit<E>(self) -> Result<VarKeys, E> {
                Ok(VarKeys::default())
            }
            fn visit_bool<E>(self, _: bool) -> Result<VarKeys, E> {
                Ok(VarKeys::default())
            }
            fn visit_i64<E>(self, _: i64) -> Result<VarKeys, E> {
                Ok(VarKeys::default())
            }
            fn visit_u64<E>(self, _: u64) -> Result<VarKeys, E> {
                Ok(VarKeys::default())
            }
            fn visit_f64<E>(self, _: f64) -> Result<VarKeys, E> {
                Ok(VarKeys::default())
            }
            fn visit_str<E>(self, _: &str) -> Result<VarKeys, E> {
                Ok(VarKeys::default())
            }
        }
        d.deserialize_any(V)
    }
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
                let vars = sc
                    .variables
                    .iter()
                    .map(|(k, d)| {
                        let kind = match d {
                            VarDecl::Static(_) => VarKind::Static,
                            VarDecl::Gen { .. } => VarKind::Generated,
                        };
                        (k.clone(), kind)
                    })
                    .collect();
                Some((
                    s.id,
                    ScenarioNames {
                        name: sc.name,
                        steps,
                        vars,
                    },
                ))
            })
            .collect();
        let mut environments = HashMap::new();
        let mut env_order = Vec::new();
        let mut env_keys = HashMap::new();
        for e in lite.environments {
            environments.insert(e.id.clone(), e.name.clone());
            env_keys.insert(e.id.clone(), e.vars.0);
            env_order.push((e.id, e.name));
        }
        Names {
            scenarios,
            environments,
            env_order,
            env_keys,
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

    /// 번들 `environments[]` 순서의 (id, 이름).
    pub fn env_order(&self) -> &[(String, String)] {
        &self.env_order
    }

    /// 그 환경의 변수 키(키 순). 모르는 환경이면 None.
    pub fn env_keys(&self, environment_id: &str) -> Option<&[String]> {
        self.env_keys.get(environment_id).map(Vec::as_slice)
    }

    /// 그 시나리오 `variables`의 (키, 종류), 키 순. 못 읽은 시나리오면 None.
    pub fn scenario_vars(&self, scenario_id: &str) -> Option<&[(String, VarKind)]> {
        self.scenarios.get(scenario_id).map(|s| s.vars.as_slice())
    }
}
