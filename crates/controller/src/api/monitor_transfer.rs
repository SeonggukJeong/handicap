//! `/api/monitor-boards/export` — 보드 설정 내보내기(②a). 보드 + 쓰는 시나리오·환경을 한 JSON 파일로.
//!
//! 순서: 개수·중복 검사 → 보드 조회(없으면 404) → 시나리오·환경 조회(없으면 400)
//! → `BundleOut` → 직렬화 → `parse_bundle_bytes`로 자기 검증(Err면 400 그 사유) → 응답.

use std::collections::{BTreeMap, HashSet};

use axum::Json;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::app::AppState;
use crate::error::ApiError;
use crate::monitor::board_file::{
    BoardOut, BundleOut, EnvOut, FORMAT, FORMAT_VERSION, MAX_BOARDS, ScenarioOut,
    parse_bundle_bytes,
};
use crate::store;
use crate::store::monitor_boards;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportRequest {
    pub board_ids: Vec<String>,
}

pub async fn export(
    State(state): State<AppState>,
    Json(req): Json<ExportRequest>,
) -> Result<Response, ApiError> {
    if req.board_ids.is_empty() {
        return Err(ApiError::BadRequest("내보낼 보드를 고르세요".into()));
    }
    if req.board_ids.len() > MAX_BOARDS {
        return Err(ApiError::BadRequest(format!(
            "보드는 한 번에 {MAX_BOARDS}개까지 내보낼 수 있습니다"
        )));
    }
    let mut seen = HashSet::new();
    if !req.board_ids.iter().all(|id| seen.insert(id.as_str())) {
        return Err(ApiError::BadRequest("보드가 중복되었습니다".into()));
    }

    let mut rows = Vec::with_capacity(req.board_ids.len());
    for id in &req.board_ids {
        rows.push(
            monitor_boards::get(&state.db, id)
                .await?
                .ok_or(ApiError::NotFound)?,
        );
    }

    // 쓰는 시나리오·환경 ID를 처음 등장 순서로 모은다.
    let mut scenario_ids: Vec<String> = Vec::new();
    let mut env_ids: Vec<String> = Vec::new();
    for b in &rows {
        for p in &b.config.panels {
            if !scenario_ids.contains(&p.scenario_id) {
                scenario_ids.push(p.scenario_id.clone());
            }
            if let Some(e) = &p.environment_id {
                if !env_ids.contains(e) {
                    env_ids.push(e.clone());
                }
            }
        }
    }

    let mut yamls: BTreeMap<String, String> = BTreeMap::new();
    for id in &scenario_ids {
        if let Some(s) = store::scenarios::get(&state.db, id).await? {
            yamls.insert(id.clone(), s.yaml);
        }
    }
    let mut envs: BTreeMap<String, store::environments::EnvironmentRow> = BTreeMap::new();
    for id in &env_ids {
        if let Some(e) = store::environments::get(&state.db, id).await? {
            envs.insert(id.clone(), e);
        }
    }

    // 없는 참조는 어느 보드 몇 번째 칸인지 알려 준다.
    for b in &rows {
        for (i, p) in b.config.panels.iter().enumerate() {
            let n = i + 1;
            if !yamls.contains_key(&p.scenario_id) {
                return Err(ApiError::BadRequest(format!(
                    "보드 '{}' 칸 {n}: 시나리오가 없습니다",
                    b.name
                )));
            }
            if let Some(e) = &p.environment_id {
                if !envs.contains_key(e) {
                    return Err(ApiError::BadRequest(format!(
                        "보드 '{}' 칸 {n}: 환경이 없습니다",
                        b.name
                    )));
                }
            }
        }
    }

    let bundle = BundleOut {
        format: FORMAT,
        format_version: FORMAT_VERSION,
        exported_at: store::now_ms(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        boards: rows
            .into_iter()
            .map(|b| BoardOut {
                id: b.id,
                name: b.name,
                config: b.config,
            })
            .collect(),
        scenarios: scenario_ids
            .iter()
            .map(|id| ScenarioOut {
                id: id.clone(),
                yaml: yamls[id].clone(),
            })
            .collect(),
        environments: env_ids
            .iter()
            .map(|id| {
                let e = &envs[id];
                EnvOut {
                    id: e.id.clone(),
                    name: e.name.clone(),
                    vars: e.vars.clone(),
                }
            })
            .collect(),
    };
    let bytes = serde_json::to_vec_pretty(&bundle).map_err(|e| anyhow::anyhow!(e))?;
    // 자기 검증: 저장된 보드가 가져오기 규칙을 못 넘으면 파일을 만들지 않는다.
    parse_bundle_bytes(&bytes).map_err(ApiError::BadRequest)?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        bytes,
    )
        .into_response())
}
