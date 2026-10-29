//! 모니터 보드 내보내기/가져오기 파일 형식(`handicap-bundle`)과 검증 R0~R7 (순수 모듈).
//!
//! 오류 문구에는 파일 속 **값**을 넣지 않는다 — 줄 번호·경로·구조 키만(serde `Display` 금지).

use std::collections::{BTreeMap, HashMap, HashSet};

use handicap_engine::{EngineError, Scenario};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ulid::Ulid;

use super::check::collect_http_steps;
use super::config::{BoardConfig, LatencySource, validate_and_normalize};
use crate::api::environments::env_problem;
use crate::api::scenarios::{validate_parallel_branch_names, validate_scenario_think_times};

pub const FORMAT: &str = "handicap-bundle";
pub const FORMAT_VERSION: u32 = 1;
pub const MAX_BOARDS: usize = 50;

// ---- 내보내기 쪽 와이어 ----

#[derive(Debug, Serialize)]
pub struct BoardOut {
    pub id: String,
    pub name: String,
    pub config: BoardConfig,
}

#[derive(Debug, Serialize)]
pub struct ScenarioOut {
    pub id: String,
    pub yaml: String,
}

#[derive(Debug, Serialize)]
pub struct EnvOut {
    pub id: String,
    pub name: String,
    pub vars: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct BundleOut {
    pub format: &'static str,
    pub format_version: u32,
    pub exported_at: i64,
    pub app_version: String,
    pub boards: Vec<BoardOut>,
    pub scenarios: Vec<ScenarioOut>,
    pub environments: Vec<EnvOut>,
}

// ---- 가져오기 쪽 (입력 전용) ----

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleIn {
    #[allow(dead_code)]
    format: String,
    #[allow(dead_code)]
    format_version: u32,
    #[serde(default)]
    #[allow(dead_code)]
    exported_at: i64,
    #[serde(default)]
    #[allow(dead_code)]
    app_version: String,
    #[serde(default)]
    boards: Vec<BoardIn>,
    #[serde(default)]
    scenarios: Vec<ScenarioIn>,
    #[serde(default)]
    environments: Vec<EnvIn>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BoardIn {
    id: String,
    name: String,
    config: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScenarioIn {
    id: String,
    yaml: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnvIn {
    id: String,
    name: String,
    vars: BTreeMap<String, String>,
}

// ---- 검증 결과 ----

#[derive(Debug)]
pub struct ValidBoard {
    pub id: String,
    pub name: String,
    pub config: BoardConfig,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
pub struct ValidScenario {
    pub id: String,
    pub name: String,
    pub yaml: String,
}

#[derive(Debug)]
pub struct ValidEnv {
    pub id: String,
    pub name: String,
    pub vars: BTreeMap<String, String>,
}

#[derive(Debug)]
pub struct ValidBundle {
    pub boards: Vec<ValidBoard>,
    pub scenarios: Vec<ValidScenario>,
    pub environments: Vec<ValidEnv>,
}

const MSG_NOT_BUNDLE: &str = "핸디캡 보드 파일이 아닙니다";

pub fn type_error(path: &str) -> String {
    format!("파일 형식이 올바르지 않습니다: {path}")
}

pub fn unknown_key(path: &str) -> String {
    format!(
        "이 파일에는 이 버전의 핸디캡이 모르는 항목({path})이 있습니다. 핸디캡을 업데이트하세요."
    )
}

/// R0: BOM 제거 → JSON 파싱(오류는 줄 번호만).
pub fn parse_json_bytes(bytes: &[u8]) -> Result<Value, String> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    serde_json::from_slice(bytes).map_err(|e| {
        format!(
            "파일을 읽을 수 없습니다(JSON 형식 오류, {}번째 줄)",
            e.line()
        )
    })
}

/// R0 → `parse_bundle_value`.
pub fn parse_bundle_bytes(bytes: &[u8]) -> Result<ValidBundle, String> {
    parse_bundle_value(parse_json_bytes(bytes)?)
}

/// 정규형 ULID(대문자) 여부.
fn is_canonical_ulid(s: &str) -> bool {
    Ulid::from_string(s).is_ok_and(|u| u.to_string() == s)
}

/// 원본 `config`에는 있고 재직렬화본에는 없는 첫 키의 경로(배열은 인덱스별).
fn first_unknown_key(orig: &Value, reser: &Value, path: &str) -> Option<String> {
    match (orig, reser) {
        (Value::Object(o), Value::Object(r)) => {
            for (k, v) in o {
                let p = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                match r.get(k) {
                    None => return Some(p),
                    Some(rv) => {
                        if let Some(found) = first_unknown_key(v, rv, &p) {
                            return Some(found);
                        }
                    }
                }
            }
            None
        }
        (Value::Array(o), Value::Array(r)) => {
            for (i, (v, rv)) in o.iter().zip(r.iter()).enumerate() {
                if let Some(found) = first_unknown_key(v, rv, &format!("{path}[{i}]")) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

/// R1·R2(머리 먼저) → R2'(타입 + 모르는 키) → R3~R7 → 경고.
pub fn parse_bundle_value(v: Value) -> Result<ValidBundle, String> {
    // R1
    if v.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(MSG_NOT_BUNDLE.into());
    }
    // R2 (머리만 먼저)
    let version = match v.get("format_version") {
        Some(Value::Number(n)) => n.as_u64().filter(|n| *n >= 1),
        _ => None,
    };
    let Some(version) = version else {
        return Err(MSG_NOT_BUNDLE.into());
    };
    if version > u64::from(FORMAT_VERSION) {
        return Err(format!(
            "더 새 버전의 핸디캡에서 만든 파일입니다(파일 형식 {version}, 이 프로그램은 {FORMAT_VERSION}까지 읽습니다). 핸디캡을 업데이트하세요."
        ));
    }
    // R2' 타입 구조
    let input: BundleIn = serde_path_to_error::deserialize(&v).map_err(|e| {
        let path = e.path().to_string();
        if e.inner().to_string().starts_with("unknown field") {
            unknown_key(&path)
        } else {
            type_error(&path)
        }
    })?;
    // R2' 보드 config 타입 + 모르는 키
    let mut configs: Vec<BoardConfig> = Vec::with_capacity(input.boards.len());
    for (i, b) in input.boards.iter().enumerate() {
        let base = format!("boards[{i}].config");
        let cfg: BoardConfig = serde_path_to_error::deserialize(&b.config).map_err(|e| {
            let p = e.path().to_string();
            if p == "." {
                type_error(&base)
            } else {
                type_error(&format!("{base}.{p}"))
            }
        })?;
        let reser = serde_json::to_value(&cfg).map_err(|_| type_error(&base))?;
        if let Some(p) = first_unknown_key(&b.config, &reser, "") {
            return Err(unknown_key(&format!("{base}.{p}")));
        }
        configs.push(cfg);
    }
    // R3
    if input.boards.is_empty() {
        return Err("가져올 보드가 없습니다".into());
    }
    if input.boards.len() > MAX_BOARDS {
        return Err(format!("보드는 한 파일에 {MAX_BOARDS}개까지입니다"));
    }
    // R4
    let id_lists: [(&str, Vec<&str>); 3] = [
        (
            "boards",
            input.boards.iter().map(|b| b.id.as_str()).collect(),
        ),
        (
            "scenarios",
            input.scenarios.iter().map(|s| s.id.as_str()).collect(),
        ),
        (
            "environments",
            input.environments.iter().map(|e| e.id.as_str()).collect(),
        ),
    ];
    for (group, ids) in &id_lists {
        for (i, id) in ids.iter().enumerate() {
            if !is_canonical_ulid(id) {
                return Err(format!("ID 형식이 올바르지 않습니다: {group}[{i}].id"));
            }
        }
    }
    for (group, ids) in &id_lists {
        let mut seen = HashSet::new();
        for (i, id) in ids.iter().enumerate() {
            if !seen.insert(*id) {
                return Err(format!("ID가 중복되었습니다: {group}[{i}].id"));
            }
        }
    }
    // R5 시나리오
    let mut scenarios = Vec::with_capacity(input.scenarios.len());
    let mut http_steps: HashMap<String, HashSet<String>> = HashMap::new();
    for s in &input.scenarios {
        let parsed = match Scenario::from_yaml(&s.yaml) {
            Ok(p) => p,
            Err(e) => {
                let line = match &e {
                    EngineError::ScenarioParse(y) => y.location().map(|l| l.line()),
                    _ => None,
                };
                let detail = match line {
                    Some(l) => format!("YAML 형식이 올바르지 않습니다({l}번째 줄)"),
                    None => "YAML 형식이 올바르지 않습니다".to_string(),
                };
                return Err(format!("시나리오 '{}': {detail}", s.id));
            }
        };
        let prefix = format!("시나리오 '{}': ", parsed.name);
        validate_parallel_branch_names(&parsed.steps).map_err(|m| format!("{prefix}{m}"))?;
        validate_scenario_think_times(&parsed.steps, &parsed.default_think_time)
            .map_err(|m| format!("{prefix}{m}"))?;
        let mut all = Vec::new();
        collect_http_steps(&parsed.steps, &mut all);
        http_steps.insert(s.id.clone(), all.iter().map(|h| h.id.clone()).collect());
        scenarios.push(ValidScenario {
            id: s.id.clone(),
            name: parsed.name.clone(),
            yaml: s.yaml.clone(),
        });
    }
    // R5' 환경
    let mut environments = Vec::with_capacity(input.environments.len());
    for e in &input.environments {
        let name = e.name.trim().to_string();
        if let Some(m) = env_problem(&e.name, &e.vars) {
            return Err(format!("환경 '{name}': {m}"));
        }
        environments.push(ValidEnv {
            id: e.id.clone(),
            name,
            vars: e.vars.clone(),
        });
    }
    // R6 참조 정합
    let scenario_ids: HashSet<&str> = scenarios.iter().map(|s| s.id.as_str()).collect();
    let env_ids: HashSet<&str> = environments.iter().map(|e| e.id.as_str()).collect();
    let mut used_scenarios: HashSet<&str> = HashSet::new();
    let mut used_envs: HashSet<&str> = HashSet::new();
    for (b, cfg) in input.boards.iter().zip(&configs) {
        let board = b.name.trim();
        for (n, p) in cfg.panels.iter().enumerate() {
            let n = n + 1;
            if !scenario_ids.contains(p.scenario_id.as_str()) {
                return Err(format!(
                    "파일 내용이 서로 맞지 않습니다(보드 '{board}' 칸 {n}의 시나리오가 파일에 없습니다)"
                ));
            }
            used_scenarios.insert(p.scenario_id.as_str());
            if let Some(e) = &p.environment_id {
                if !env_ids.contains(e.as_str()) {
                    return Err(format!(
                        "파일 내용이 서로 맞지 않습니다(보드 '{board}' 칸 {n}의 환경이 파일에 없습니다)"
                    ));
                }
                used_envs.insert(e.as_str());
            }
        }
    }
    if let Some(s) = scenarios
        .iter()
        .find(|s| !used_scenarios.contains(s.id.as_str()))
    {
        return Err(format!(
            "파일 내용이 서로 맞지 않습니다(쓰이지 않는 시나리오 '{}')",
            s.name
        ));
    }
    if let Some(e) = environments
        .iter()
        .find(|e| !used_envs.contains(e.id.as_str()))
    {
        return Err(format!(
            "파일 내용이 서로 맞지 않습니다(쓰이지 않는 환경 '{}')",
            e.name
        ));
    }
    // R7 + 경고
    let mut boards = Vec::with_capacity(input.boards.len());
    for (b, mut cfg) in input.boards.iter().zip(configs) {
        let name = validate_and_normalize(&b.name, &mut cfg)
            .map_err(|r| format!("보드 '{}' {r}", b.name.trim()))?;
        let warnings = board_warnings(&cfg, &http_steps);
        boards.push(ValidBoard {
            id: b.id.clone(),
            name,
            config: cfg,
            warnings,
        });
    }
    Ok(ValidBundle {
        boards,
        scenarios,
        environments,
    })
}

/// 파일 쪽 시나리오에 없는 스텝을 가리키는 칸의 경고(거부하지 않는다). 칸 순서 ×
/// (응답 시간 기준 → 성공 조건 → 표시 항목).
fn board_warnings(cfg: &BoardConfig, http_steps: &HashMap<String, HashSet<String>>) -> Vec<String> {
    let mut out = Vec::new();
    let empty = HashSet::new();
    for (i, p) in cfg.panels.iter().enumerate() {
        let n = i + 1;
        let steps = http_steps.get(&p.scenario_id).unwrap_or(&empty);
        if let LatencySource::Step { step_id } = &p.latency_source {
            if !steps.contains(step_id) {
                out.push(format!(
                    "칸 {n}: 응답 시간 기준 스텝이 시나리오에 없습니다(점검이 설정 오류로 표시됩니다)"
                ));
            }
        }
        if p.conditions.iter().any(|c| !steps.contains(&c.step_id)) {
            out.push(format!(
                "칸 {n}: 성공 조건이 가리키는 스텝이 시나리오에 없습니다"
            ));
        }
        if p.display_items.iter().any(|d| !steps.contains(&d.step_id)) {
            out.push(format!(
                "칸 {n}: 화면 표시 항목이 가리키는 스텝이 시나리오에 없습니다"
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BOARD: &str = "01J00000000000000000000001";
    const SCEN: &str = "01J00000000000000000000002";
    const ENV: &str = "01J00000000000000000000003";
    const PANEL: &str = "01J00000000000000000000004";
    const STEP: &str = "01J00000000000000000000005";
    const LOOP: &str = "01J00000000000000000000006";
    const CHILD: &str = "01J00000000000000000000007";
    const MISSING: &str = "01J00000000000000000000008";
    const SCEN2: &str = "01J00000000000000000000009";
    const ENV2: &str = "01J0000000000000000000000A";

    fn yaml() -> String {
        format!(
            "version: 1\nname: 결제 흐름\nsteps:\n  - id: \"{STEP}\"\n    name: 조회\n    type: http\n    request: {{ method: GET, url: \"http://x/ping\" }}\n  - id: \"{LOOP}\"\n    name: 반복\n    type: loop\n    repeat: 2\n    do:\n      - id: \"{CHILD}\"\n        name: 안쪽\n        type: http\n        request: {{ method: GET, url: \"http://x/in\" }}\n"
        )
    }

    fn ok_file() -> Value {
        json!({
            "format": "handicap-bundle",
            "format_version": 1,
            "exported_at": 1761700000000i64,
            "app_version": "0.9.0",
            "boards": [{
                "id": BOARD,
                "name": "야간 결제 점검",
                "config": {
                    "font_scale": "large", "blink": "fail", "display_style": "border",
                    "show_latency_stats": true, "record_limit_kb": 128,
                    "panels": [{
                        "id": PANEL, "title": "결제", "scenario_id": SCEN,
                        "environment_id": ENV,
                        "interval_seconds": 10, "timeout_seconds": 5,
                        "latency_source": {"kind": "total"},
                        "thresholds": [], "bar_count": 60, "graph_max_ms": 2000,
                        "conditions": [{
                            "step_id": STEP, "source": "status", "path": "", "op": "eq",
                            "value": "200", "ignore_case": false, "trim": false
                        }],
                        "display_items": []
                    }]
                }
            }],
            "scenarios": [{"id": SCEN, "yaml": yaml()}],
            "environments": [{"id": ENV, "name": "운영", "vars": {"PASSWORD": "pw"}}]
        })
    }

    fn err_of(v: Value) -> String {
        parse_bundle_value(v).unwrap_err()
    }

    fn panel_mut(v: &mut Value) -> &mut Value {
        &mut v["boards"][0]["config"]["panels"][0]
    }

    #[test]
    fn ok_file_is_accepted() {
        let b = parse_bundle_value(ok_file()).unwrap();
        assert_eq!(b.boards.len(), 1);
        assert_eq!(b.scenarios[0].name, "결제 흐름");
        assert_eq!(b.scenarios[0].yaml, yaml());
        assert!(b.boards[0].warnings.is_empty());
    }

    #[test]
    fn bom_prefixed_file_is_accepted() {
        let mut bytes = "\u{feff}".as_bytes().to_vec();
        bytes.extend(serde_json::to_vec(&ok_file()).unwrap());
        assert!(parse_bundle_bytes(&bytes).is_ok());
    }

    #[test]
    fn r0_not_json_reports_line_only() {
        let e = parse_bundle_bytes(b"{\n  \"format\": 12345x").unwrap_err();
        assert_eq!(e, "파일을 읽을 수 없습니다(JSON 형식 오류, 2번째 줄)");
        assert!(!e.contains("12345"));
    }

    #[test]
    fn r1_wrong_format() {
        let mut v = ok_file();
        v["format"] = json!("other");
        assert_eq!(err_of(v), "핸디캡 보드 파일이 아닙니다");
    }

    #[test]
    fn r1_missing_format_version() {
        let mut v = ok_file();
        v.as_object_mut().unwrap().remove("format_version");
        assert_eq!(err_of(v), "핸디캡 보드 파일이 아닙니다");
    }

    #[test]
    fn r2_newer_version_beats_shape_errors() {
        let mut v = ok_file();
        v["format_version"] = json!(2);
        v["boards"] = json!("x");
        assert_eq!(
            err_of(v),
            "더 새 버전의 핸디캡에서 만든 파일입니다(파일 형식 2, 이 프로그램은 1까지 읽습니다). 핸디캡을 업데이트하세요."
        );
    }

    #[test]
    fn r2_type_error_reports_path_without_value() {
        let mut v = ok_file();
        panel_mut(&mut v)["bar_count"] = json!("99999");
        let e = err_of(v);
        assert_eq!(
            e,
            "파일 형식이 올바르지 않습니다: boards[0].config.panels[0].bar_count"
        );
        assert!(!e.contains("99999"));
    }

    #[test]
    fn unknown_top_level_key_rejected() {
        let mut v = ok_file();
        v["extra"] = json!(1);
        assert_eq!(
            err_of(v),
            "이 파일에는 이 버전의 핸디캡이 모르는 항목(extra)이 있습니다. 핸디캡을 업데이트하세요."
        );
    }

    #[test]
    fn unknown_board_item_key_rejected() {
        let mut v = ok_file();
        v["boards"][0]["enabled"] = json!(true);
        assert_eq!(
            err_of(v),
            "이 파일에는 이 버전의 핸디캡이 모르는 항목(boards[0].enabled)이 있습니다. 핸디캡을 업데이트하세요."
        );
    }

    #[test]
    fn unknown_config_key_rejected() {
        let mut v = ok_file();
        panel_mut(&mut v)["new_key"] = json!(1);
        assert_eq!(
            err_of(v),
            "이 파일에는 이 버전의 핸디캡이 모르는 항목(boards[0].config.panels[0].new_key)이 있습니다. 핸디캡을 업데이트하세요."
        );
    }

    #[test]
    fn config_reserialization_has_no_false_positive() {
        let v: Value = serde_json::from_str(&format!(
            r##"{{
  "format": "handicap-bundle", "format_version": 1,
  "boards": [
    {{"id": "{BOARD}", "name": "보드1", "config": {{
      "font_scale": "xlarge", "blink": "slow_and_fail", "display_style": "focus",
      "show_latency_stats": false, "record_limit_kb": 64,
      "panels": [
        {{"id": "{PANEL}", "title": "p1", "scenario_id": "{SCEN}", "environment_id": "{ENV}",
          "interval_seconds": 5, "timeout_seconds": 3,
          "latency_source": {{"kind": "step", "step_id": "{STEP}"}},
          "thresholds": [{{"ms": 100, "color": "#00ff00"}}, {{"ms": 500, "color": "#ff0000"}}],
          "bar_count": 30, "graph_max_ms": 1000,
          "conditions": [{{"step_id": "{STEP}", "source": "body", "path": "$.ok", "op": "eq", "value": "true", "ignore_case": true, "trim": true}}],
          "display_items": [{{"step_id": "{STEP}", "source": "body", "path": "$.a"}}]}},
        {{"title": "p2", "scenario_id": "{SCEN}", "latency_source": {{"kind": "total"}}}},
        {{"title": "p3", "scenario_id": "{SCEN}", "environment_id": null}}
      ]}}}},
    {{"id": "{SCEN2}", "name": "보드2", "config": {{"panels": [{{"title": "x", "scenario_id": "{SCEN}"}}]}}}}
  ],
  "scenarios": [{{"id": "{SCEN}", "yaml": {y}}}],
  "environments": [{{"id": "{ENV}", "name": "운영", "vars": {{}}}}]
}}"##,
            y = serde_json::to_string(&yaml()).unwrap()
        ))
        .unwrap();
        let b = parse_bundle_value(v).unwrap();
        assert_eq!(b.boards.len(), 2);
    }

    fn many_boards(n: usize) -> Value {
        let mut v = ok_file();
        let b = v["boards"][0].clone();
        v["boards"] = Value::Array(vec![b; n]);
        v
    }

    #[test]
    fn r3_zero_boards() {
        let mut v = ok_file();
        v["boards"] = json!([]);
        assert_eq!(err_of(v), "가져올 보드가 없습니다");
    }

    #[test]
    fn r3_fifty_one_boards() {
        assert_eq!(err_of(many_boards(51)), "보드는 한 파일에 50개까지입니다");
    }

    #[test]
    fn r4_lowercase_ulid_rejected() {
        let mut v = ok_file();
        v["scenarios"][0]["id"] = json!(SCEN.to_lowercase());
        assert_eq!(err_of(v), "ID 형식이 올바르지 않습니다: scenarios[0].id");
    }

    #[test]
    fn r4_duplicate_scenario_id_rejected() {
        let mut v = ok_file();
        let s = v["scenarios"][0].clone();
        v["scenarios"].as_array_mut().unwrap().push(s);
        assert_eq!(err_of(v), "ID가 중복되었습니다: scenarios[1].id");
    }

    #[test]
    fn r5_bad_yaml_prefixed() {
        let mut v = ok_file();
        v["scenarios"][0]["yaml"] = json!("name: [");
        let e = err_of(v);
        assert!(e.starts_with(&format!("시나리오 '{SCEN}': ")), "{e}");
    }

    #[test]
    fn r5_empty_parallel_branch_name_rejected() {
        let mut v = ok_file();
        let y = format!(
            "version: 1\nname: 결제 흐름\nsteps:\n  - id: \"{LOOP}\"\n    name: 병렬\n    type: parallel\n    branches:\n      - name: \"\"\n        steps:\n          - id: \"{STEP}\"\n            name: a\n            type: http\n            request: {{ method: GET, url: \"http://x\" }}\n"
        );
        v["scenarios"][0]["yaml"] = json!(y);
        let e = err_of(v);
        assert!(e.starts_with("시나리오 '결제 흐름': "), "{e}");
        assert!(e.contains("branch name required"), "{e}");
    }

    #[test]
    fn r5p_env_key_with_colon_rejected() {
        let mut v = ok_file();
        v["environments"][0]["vars"] = json!({"A:B": "x"});
        let e = err_of(v);
        assert!(e.starts_with("환경 '운영': "), "{e}");
    }

    #[test]
    fn r6_panel_scenario_missing() {
        let mut v = ok_file();
        panel_mut(&mut v)["scenario_id"] = json!(MISSING);
        assert_eq!(
            err_of(v),
            "파일 내용이 서로 맞지 않습니다(보드 '야간 결제 점검' 칸 1의 시나리오가 파일에 없습니다)"
        );
    }

    #[test]
    fn r6_panel_environment_missing() {
        let mut v = ok_file();
        panel_mut(&mut v)["environment_id"] = json!(MISSING);
        assert_eq!(
            err_of(v),
            "파일 내용이 서로 맞지 않습니다(보드 '야간 결제 점검' 칸 1의 환경이 파일에 없습니다)"
        );
    }

    #[test]
    fn r6_unused_environment() {
        let mut v = ok_file();
        v["environments"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id": ENV2, "name": "스테이징", "vars": {}}));
        assert_eq!(
            err_of(v),
            "파일 내용이 서로 맞지 않습니다(쓰이지 않는 환경 '스테이징')"
        );
    }

    #[test]
    fn r6_unused_scenario() {
        let mut v = ok_file();
        let y2 = yaml().replace("name: 결제 흐름", "name: 남는 흐름");
        v["scenarios"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id": SCEN2, "yaml": y2}));
        assert_eq!(
            err_of(v),
            "파일 내용이 서로 맞지 않습니다(쓰이지 않는 시나리오 '남는 흐름')"
        );
    }

    #[test]
    fn r7_disallowed_jsonpath_prefixed() {
        let mut v = ok_file();
        panel_mut(&mut v)["conditions"] = json!([{
            "step_id": STEP, "source": "body", "path": "$..a..b", "op": "exists"
        }]);
        assert_eq!(
            err_of(v),
            "보드 '야간 결제 점검' 칸 1: 본문 경로(JSONPath)가 올바르지 않습니다"
        );
    }

    #[test]
    fn warnings_for_missing_steps_in_panel_order() {
        let mut v = ok_file();
        let p = panel_mut(&mut v);
        p["latency_source"] = json!({"kind": "step", "step_id": MISSING});
        p["conditions"] = json!([{
            "step_id": MISSING, "source": "status", "op": "eq", "value": "200"
        }]);
        let p2 = json!({
            "id": "01J0000000000000000000000B", "title": "둘째", "scenario_id": SCEN,
            "display_items": [{"step_id": LOOP, "source": "status"}]
        });
        v["boards"][0]["config"]["panels"]
            .as_array_mut()
            .unwrap()
            .push(p2);
        let b = parse_bundle_value(v).unwrap();
        assert_eq!(
            b.boards[0].warnings,
            vec![
                "칸 1: 응답 시간 기준 스텝이 시나리오에 없습니다(점검이 설정 오류로 표시됩니다)",
                "칸 1: 성공 조건이 가리키는 스텝이 시나리오에 없습니다",
                "칸 2: 화면 표시 항목이 가리키는 스텝이 시나리오에 없습니다",
            ]
        );
    }

    #[test]
    fn normalized_config_is_returned() {
        let mut v = ok_file();
        panel_mut(&mut v)["title"] = json!("  결제  ");
        v["boards"][0]["name"] = json!("  야간 결제 점검  ");
        let b = parse_bundle_value(v).unwrap();
        assert_eq!(b.boards[0].config.panels[0].title, "결제");
        assert_eq!(b.boards[0].name, "야간 결제 점검");
    }

    #[test]
    fn env_name_is_trimmed() {
        let mut v = ok_file();
        v["environments"][0]["name"] = json!("  운영 ");
        let b = parse_bundle_value(v).unwrap();
        assert_eq!(b.environments[0].name, "운영");
    }
}
