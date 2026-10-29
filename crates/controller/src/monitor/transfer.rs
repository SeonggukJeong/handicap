//! 가져오기 상태 판정·겹침·추가 계획 (순수 모듈 — DB를 읽지 않는다).
//!
//! `analyze`/`plan_add`는 호출자(Task 4)가 트랜잭션 안에서 읽은 `PcSnapshot`만 본다.
//! 분석·결과 DTO에는 `HashMap`/`HashSet`을 쓰지 않는다(`BTreeMap`/`Vec`만).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::board_file::ValidBundle;
use super::config::{BoardConfig, NAME_MAX_CHARS};

#[derive(Debug, Clone)]
pub struct PcBoard {
    pub id: String,
    pub name: String,
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct PcEnv {
    pub id: String,
    pub name: String,
    pub vars: BTreeMap<String, String>,
}

/// `boards`/`environments`는 PC 전체(이름 충돌 판정용), `scenarios`는 파일에 든 ID만(id → yaml).
#[derive(Debug, Clone, Default)]
pub struct PcSnapshot {
    pub boards: Vec<PcBoard>,
    pub scenarios: BTreeMap<String, String>,
    pub environments: Vec<PcEnv>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ResState {
    Absent,
    Same,
    Different,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ResourceInfo {
    pub id: String,
    pub name: String,
    pub state: ResState,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BoardAnalysis {
    pub id: String,
    pub name: String,
    pub pc_name: Option<String>,
    pub conflict: bool,
    pub exists: bool,
    pub enabled: bool,
    pub scenarios: Vec<ResourceInfo>,
    pub environments: Vec<ResourceInfo>,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AnalysisSummary {
    pub boards: usize,
    pub conflicts: usize,
    pub scenarios: usize,
    pub environments: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Analysis {
    pub boards: Vec<BoardAnalysis>,
    pub summary: AnalysisSummary,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BoardResult {
    pub id: String,
    pub name: String,
    /// ②a는 `"added"`뿐.
    pub action: String,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Counts {
    pub added: usize,
    pub unchanged: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Renamed {
    /// `"board"` | `"environment"`
    pub kind: String,
    pub from: String,
    pub to: String,
    /// ②a는 `"name_taken"`뿐.
    pub reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ImportResult {
    pub boards: Vec<BoardResult>,
    pub scenarios: Counts,
    pub environments: Counts,
    pub renamed: Vec<Renamed>,
}

#[derive(Debug)]
pub struct AddPlan {
    /// (id, 최종 이름, config)
    pub boards: Vec<(String, String, BoardConfig)>,
    /// `Absent`만 (id, 이름, yaml)
    pub scenarios: Vec<(String, String, String)>,
    /// `Absent`만 (id, 최종 이름, vars)
    pub environments: Vec<(String, String, BTreeMap<String, String>)>,
    pub result: ImportResult,
}

fn scenario_state(pc: &PcSnapshot, id: &str, yaml: &str) -> ResState {
    match pc.scenarios.get(id) {
        None => ResState::Absent,
        Some(y) if y == yaml => ResState::Same,
        Some(_) => ResState::Different,
    }
}

/// 환경은 ID + vars 완전 일치로만 비교한다(이름은 비교하지 않는다).
fn env_state(pc: &PcSnapshot, id: &str, vars: &BTreeMap<String, String>) -> ResState {
    match pc.environments.iter().find(|e| e.id == id) {
        None => ResState::Absent,
        Some(e) if &e.vars == vars => ResState::Same,
        Some(_) => ResState::Different,
    }
}

pub fn analyze(b: &ValidBundle, pc: &PcSnapshot) -> Analysis {
    let mut boards = Vec::with_capacity(b.boards.len());
    for vb in &b.boards {
        let mut scenarios: Vec<ResourceInfo> = Vec::new();
        let mut environments: Vec<ResourceInfo> = Vec::new();
        for p in &vb.config.panels {
            if !scenarios.iter().any(|r| r.id == p.scenario_id) {
                if let Some(s) = b.scenarios.iter().find(|s| s.id == p.scenario_id) {
                    scenarios.push(ResourceInfo {
                        id: s.id.clone(),
                        name: s.name.clone(),
                        state: scenario_state(pc, &s.id, &s.yaml),
                    });
                }
            }
            if let Some(eid) = &p.environment_id {
                if !environments.iter().any(|r| &r.id == eid) {
                    if let Some(e) = b.environments.iter().find(|e| &e.id == eid) {
                        environments.push(ResourceInfo {
                            id: e.id.clone(),
                            name: e.name.clone(),
                            state: env_state(pc, &e.id, &e.vars),
                        });
                    }
                }
            }
        }
        let pc_board = pc.boards.iter().find(|x| x.id == vb.id);
        let exists = pc_board.is_some();
        let conflict = exists
            || scenarios
                .iter()
                .chain(environments.iter())
                .any(|r| r.state == ResState::Different);
        boards.push(BoardAnalysis {
            id: vb.id.clone(),
            name: vb.name.clone(),
            pc_name: pc_board.map(|x| x.name.clone()),
            conflict,
            exists,
            enabled: pc_board.is_some_and(|x| x.enabled),
            scenarios,
            environments,
            warnings: vb.warnings.clone(),
        });
    }
    let summary = AnalysisSummary {
        boards: boards.len(),
        conflicts: boards.iter().filter(|x| x.conflict).count(),
        scenarios: b.scenarios.len(),
        environments: b.environments.len(),
    };
    Analysis { boards, summary }
}

/// `base`가 `taken`에 없으면 그대로, 있으면 `base (2)`, `base (3)`… 중 처음 비는 것.
/// `max_chars`가 있으면 접미사를 붙여도 그 문자 수 이하가 되게 `base`를 **문자 단위로** 자른다.
pub fn unique_name(base: &str, taken: &BTreeSet<String>, max_chars: Option<usize>) -> String {
    if !taken.contains(base) {
        return base.to_string();
    }
    let mut n: usize = 2;
    loop {
        let suffix = format!(" ({n})");
        let trunc: String = match max_chars {
            Some(m) => base
                .chars()
                .take(m.saturating_sub(suffix.chars().count()))
                .collect(),
            None => base.to_string(),
        };
        let cand = format!("{trunc}{suffix}");
        if !taken.contains(&cand) {
            return cand;
        }
        n += 1;
    }
}

/// 겹침이 하나라도 있으면 `Err(겹치는 보드들)`. 없으면 추가 계획(②a는 행을 추가만 한다).
pub fn plan_add(
    b: &ValidBundle,
    pc: &PcSnapshot,
    a: &Analysis,
) -> Result<AddPlan, Vec<BoardAnalysis>> {
    let conflicts: Vec<BoardAnalysis> = a.boards.iter().filter(|x| x.conflict).cloned().collect();
    if !conflicts.is_empty() {
        return Err(conflicts);
    }
    // 리소스 상태(id → state) — 분석 결과에서 모은다(공유 리소스는 한 번만).
    let mut scen_state: BTreeMap<&str, ResState> = BTreeMap::new();
    let mut env_state_map: BTreeMap<&str, ResState> = BTreeMap::new();
    for ba in &a.boards {
        for r in &ba.scenarios {
            scen_state.insert(r.id.as_str(), r.state);
        }
        for r in &ba.environments {
            env_state_map.insert(r.id.as_str(), r.state);
        }
    }

    let mut renamed = Vec::new();

    // 환경(파일 순서, Absent만)
    let mut env_taken: BTreeSet<String> = pc.environments.iter().map(|e| e.name.clone()).collect();
    let mut environments = Vec::new();
    for e in &b.environments {
        if env_state_map.get(e.id.as_str()) != Some(&ResState::Absent) {
            continue;
        }
        let name = unique_name(&e.name, &env_taken, None);
        if name != e.name {
            renamed.push(Renamed {
                kind: "environment".into(),
                from: e.name.clone(),
                to: name.clone(),
                reason: "name_taken".into(),
            });
        }
        env_taken.insert(name.clone());
        environments.push((e.id.clone(), name, e.vars.clone()));
    }

    // 시나리오(이름은 유일하지 않아 바꾸지 않는다)
    let scenarios: Vec<(String, String, String)> = b
        .scenarios
        .iter()
        .filter(|s| scen_state.get(s.id.as_str()) == Some(&ResState::Absent))
        .map(|s| (s.id.clone(), s.name.clone(), s.yaml.clone()))
        .collect();

    // 보드
    let mut board_taken: BTreeSet<String> = pc.boards.iter().map(|x| x.name.clone()).collect();
    let mut boards = Vec::new();
    let mut result_boards = Vec::new();
    for vb in &b.boards {
        let name = unique_name(&vb.name, &board_taken, Some(NAME_MAX_CHARS));
        if name != vb.name {
            renamed.push(Renamed {
                kind: "board".into(),
                from: vb.name.clone(),
                to: name.clone(),
                reason: "name_taken".into(),
            });
        }
        board_taken.insert(name.clone());
        result_boards.push(BoardResult {
            id: vb.id.clone(),
            name: name.clone(),
            action: "added".into(),
            warnings: vb.warnings.clone(),
        });
        boards.push((vb.id.clone(), name, vb.config.clone()));
    }

    let scen_same = scen_state
        .values()
        .filter(|s| **s == ResState::Same)
        .count();
    let env_same = env_state_map
        .values()
        .filter(|s| **s == ResState::Same)
        .count();
    let result = ImportResult {
        boards: result_boards,
        scenarios: Counts {
            added: scenarios.len(),
            unchanged: scen_same,
        },
        environments: Counts {
            added: environments.len(),
            unchanged: env_same,
        },
        renamed,
    };
    Ok(AddPlan {
        boards,
        scenarios,
        environments,
        result,
    })
}

#[cfg(test)]
mod tests {
    use super::super::board_file::{ValidBoard, ValidEnv, ValidScenario};
    use super::super::config::PanelConfig;
    use super::*;

    const B1: &str = "01J00000000000000000000001";
    const B2: &str = "01J00000000000000000000002";
    const B3: &str = "01J00000000000000000000003";
    const S1: &str = "01J00000000000000000000011";
    const S2: &str = "01J00000000000000000000012";
    const E1: &str = "01J00000000000000000000021";
    const E2: &str = "01J00000000000000000000022";

    fn panel(sid: &str, eid: Option<&str>) -> PanelConfig {
        let mut p: PanelConfig = serde_json::from_value(serde_json::json!({
            "title": "p", "scenario_id": sid
        }))
        .unwrap();
        p.environment_id = eid.map(String::from);
        p
    }

    fn board(id: &str, name: &str, panels: Vec<PanelConfig>) -> ValidBoard {
        let cfg = BoardConfig {
            panels,
            ..BoardConfig::default()
        };
        ValidBoard {
            id: id.into(),
            name: name.into(),
            config: cfg,
            warnings: vec![],
        }
    }

    fn scen(id: &str, name: &str, yaml: &str) -> ValidScenario {
        ValidScenario {
            id: id.into(),
            name: name.into(),
            yaml: yaml.into(),
        }
    }

    fn kv(kv: &[(&str, &str)]) -> BTreeMap<String, String> {
        kv.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn env(id: &str, name: &str, vars: &[(&str, &str)]) -> ValidEnv {
        ValidEnv {
            id: id.into(),
            name: name.into(),
            vars: kv(vars),
        }
    }

    fn pc_env(id: &str, name: &str, vars: &[(&str, &str)]) -> PcEnv {
        PcEnv {
            id: id.into(),
            name: name.into(),
            vars: kv(vars),
        }
    }

    fn pc_board(id: &str, name: &str, enabled: bool) -> PcBoard {
        PcBoard {
            id: id.into(),
            name: name.into(),
            enabled,
        }
    }

    /// 보드 1개(칸: S1+E1) 기본 번들.
    fn one() -> ValidBundle {
        ValidBundle {
            boards: vec![board(B1, "야간", vec![panel(S1, Some(E1))])],
            scenarios: vec![scen(S1, "결제", "yaml-a")],
            environments: vec![env(E1, "운영", &[("K", "v")])],
        }
    }

    #[test]
    fn empty_pc_all_absent_no_conflict() {
        let a = analyze(&one(), &PcSnapshot::default());
        let b = &a.boards[0];
        assert!(!b.conflict && !b.exists && !b.enabled);
        assert_eq!(b.pc_name, None);
        assert_eq!(b.scenarios[0].state, ResState::Absent);
        assert_eq!(b.environments[0].state, ResState::Absent);
        assert_eq!(b.scenarios[0].name, "결제");
    }

    #[test]
    fn scenario_same_when_yaml_identical() {
        let mut pc = PcSnapshot::default();
        pc.scenarios.insert(S1.into(), "yaml-a".into());
        let a = analyze(&one(), &pc);
        assert_eq!(a.boards[0].scenarios[0].state, ResState::Same);
        assert!(!a.boards[0].conflict);
    }

    #[test]
    fn scenario_different_makes_conflict() {
        let mut pc = PcSnapshot::default();
        pc.scenarios.insert(S1.into(), "yaml-b".into());
        let a = analyze(&one(), &pc);
        assert_eq!(a.boards[0].scenarios[0].state, ResState::Different);
        assert!(a.boards[0].conflict);
        assert!(!a.boards[0].exists);
    }

    #[test]
    fn env_same_ignores_name() {
        let mut pc = PcSnapshot::default();
        pc.environments.push(pc_env(E1, "다른 이름", &[("K", "v")]));
        let a = analyze(&one(), &pc);
        assert_eq!(a.boards[0].environments[0].state, ResState::Same);
        assert!(!a.boards[0].conflict);
    }

    #[test]
    fn env_vars_differ_conflict() {
        let mut pc = PcSnapshot::default();
        pc.environments.push(pc_env(E1, "운영", &[("K", "other")]));
        let a = analyze(&one(), &pc);
        assert_eq!(a.boards[0].environments[0].state, ResState::Different);
        assert!(a.boards[0].conflict);
    }

    #[test]
    fn board_exists_is_conflict() {
        let mut pc = PcSnapshot::default();
        pc.boards.push(pc_board(B1, "PC쪽 이름", true));
        let a = analyze(&one(), &pc);
        let b = &a.boards[0];
        assert!(b.conflict && b.exists && b.enabled);
        assert_eq!(b.pc_name.as_deref(), Some("PC쪽 이름"));
    }

    #[test]
    fn resources_listed_in_first_use_order() {
        let bundle = ValidBundle {
            boards: vec![board(
                B1,
                "a",
                vec![
                    panel(S2, Some(E2)),
                    panel(S1, Some(E1)),
                    panel(S2, Some(E2)),
                ],
            )],
            scenarios: vec![scen(S1, "s1", "y1"), scen(S2, "s2", "y2")],
            environments: vec![env(E1, "e1", &[]), env(E2, "e2", &[])],
        };
        let a = analyze(&bundle, &PcSnapshot::default());
        let sids: Vec<_> = a.boards[0]
            .scenarios
            .iter()
            .map(|r| r.id.as_str())
            .collect();
        let eids: Vec<_> = a.boards[0]
            .environments
            .iter()
            .map(|r| r.id.as_str())
            .collect();
        assert_eq!(sids, vec![S2, S1]);
        assert_eq!(eids, vec![E2, E1]);
    }

    fn three() -> ValidBundle {
        ValidBundle {
            boards: vec![
                board(B1, "a", vec![panel(S1, Some(E1))]),
                board(B2, "b", vec![panel(S1, None)]),
                board(B3, "c", vec![panel(S2, None)]),
            ],
            scenarios: vec![scen(S1, "s1", "y1"), scen(S2, "s2", "y2")],
            environments: vec![env(E1, "e1", &[])],
        }
    }

    #[test]
    fn summary_counts() {
        let mut pc = PcSnapshot::default();
        pc.boards.push(pc_board(B2, "b", false));
        let a = analyze(&three(), &pc);
        assert_eq!(
            a.summary,
            AnalysisSummary {
                boards: 3,
                conflicts: 1,
                scenarios: 2,
                environments: 1
            }
        );
    }

    #[test]
    fn plan_add_rejects_with_conflict_boards_only() {
        let bundle = three();
        let mut pc = PcSnapshot::default();
        pc.boards.push(pc_board(B2, "b", false));
        let a = analyze(&bundle, &pc);
        let err = plan_add(&bundle, &pc, &a).unwrap_err();
        assert_eq!(err.len(), 1);
        assert_eq!(err[0].id, B2);
    }

    #[test]
    fn shared_scenario_added_once() {
        let bundle = ValidBundle {
            boards: vec![
                board(B1, "a", vec![panel(S1, None)]),
                board(B2, "b", vec![panel(S1, None)]),
            ],
            scenarios: vec![scen(S1, "s1", "y1")],
            environments: vec![],
        };
        let plan = plan_for(&bundle, &PcSnapshot::default());
        assert_eq!(plan.scenarios.len(), 1);
        assert_eq!(plan.result.scenarios.added, 1);
        assert_eq!(plan.boards.len(), 2);
    }

    #[test]
    fn same_resources_counted_unchanged_not_inserted() {
        let bundle = one();
        let mut pc = PcSnapshot::default();
        pc.scenarios.insert(S1.into(), "yaml-a".into());
        pc.environments.push(pc_env(E1, "x", &[("K", "v")]));
        let plan = plan_for(&bundle, &pc);
        assert!(plan.scenarios.is_empty() && plan.environments.is_empty());
        assert_eq!(
            plan.result.scenarios,
            Counts {
                added: 0,
                unchanged: 1
            }
        );
        assert_eq!(
            plan.result.environments,
            Counts {
                added: 0,
                unchanged: 1
            }
        );
        assert_eq!(plan.boards.len(), 1);
    }

    fn plan_for(bundle: &ValidBundle, pc: &PcSnapshot) -> AddPlan {
        let a = analyze(bundle, pc);
        plan_add(bundle, pc, &a).unwrap()
    }

    #[test]
    fn board_name_clash_with_pc_gets_suffix() {
        let mut pc = PcSnapshot::default();
        pc.boards.push(pc_board(B3, "A", false));
        let mut bundle = one();
        bundle.boards[0].name = "A".into();
        let plan = plan_for(&bundle, &pc);
        assert_eq!(plan.boards[0].1, "A (2)");
        assert_eq!(plan.result.boards[0].name, "A (2)");
        assert_eq!(
            plan.result.renamed,
            vec![Renamed {
                kind: "board".into(),
                from: "A".into(),
                to: "A (2)".into(),
                reason: "name_taken".into()
            }]
        );
    }

    #[test]
    fn two_boards_same_name_in_file() {
        let bundle = ValidBundle {
            boards: vec![
                board(B1, "A", vec![panel(S1, None)]),
                board(B2, "A", vec![panel(S1, None)]),
            ],
            scenarios: vec![scen(S1, "s", "y")],
            environments: vec![],
        };
        let plan = plan_for(&bundle, &PcSnapshot::default());
        let names: Vec<_> = plan.boards.iter().map(|b| b.1.as_str()).collect();
        assert_eq!(names, vec!["A", "A (2)"]);
        assert_eq!(plan.result.renamed.len(), 1);
    }

    #[test]
    fn suffix_skips_taken_numbers() {
        let mut pc = PcSnapshot::default();
        pc.boards.push(pc_board(B2, "A", false));
        pc.boards.push(pc_board(B3, "A (2)", false));
        let mut bundle = one();
        bundle.boards[0].name = "A".into();
        let plan = plan_for(&bundle, &pc);
        assert_eq!(plan.boards[0].1, "A (3)");
    }

    #[test]
    fn env_name_clash_gets_suffix_and_keeps_id() {
        let mut pc = PcSnapshot::default();
        pc.environments.push(pc_env(E2, "운영", &[("Z", "1")]));
        let plan = plan_for(&one(), &pc);
        assert_eq!(plan.environments.len(), 1);
        assert_eq!(plan.environments[0].0, E1);
        assert_eq!(plan.environments[0].1, "운영 (2)");
        assert_eq!(
            plan.boards[0].2.panels[0].environment_id.as_deref(),
            Some(E1)
        );
        assert_eq!(plan.result.renamed[0].kind, "environment");
        assert_eq!(plan.result.renamed[0].reason, "name_taken");
    }

    #[test]
    fn board_name_suffix_truncates_by_chars() {
        let name: String = "가".repeat(40);
        let mut pc = PcSnapshot::default();
        pc.boards.push(pc_board(B3, &name, false));
        let mut bundle = one();
        bundle.boards[0].name = name.clone();
        let plan = plan_for(&bundle, &pc);
        let got = &plan.boards[0].1;
        assert_eq!(got.chars().count(), 40);
        assert!(got.ends_with(" (2)"));
        assert!(got.starts_with(&"가".repeat(36)));
    }

    #[test]
    fn result_actions_all_added() {
        let plan = plan_for(&three(), &PcSnapshot::default());
        assert_eq!(plan.result.boards.len(), 3);
        assert!(plan.result.boards.iter().all(|b| b.action == "added"));
    }

    #[test]
    fn analysis_serializes_pc_name_null() {
        let a = analyze(&one(), &PcSnapshot::default());
        let v = serde_json::to_value(&a).unwrap();
        let b = v["boards"][0].as_object().unwrap();
        assert!(b.contains_key("pc_name") && b["pc_name"].is_null());
        assert_eq!(v["boards"][0]["scenarios"][0]["state"], "absent");
    }
}
