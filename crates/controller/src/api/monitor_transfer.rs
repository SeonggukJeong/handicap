//! `/api/monitor-boards/export` — 보드 설정 내보내기(②a). 보드 + 쓰는 시나리오·환경을 한 JSON 파일로.
//!
//! 순서: 개수·중복 검사 → 보드 조회(없으면 404) → 시나리오·환경 조회(없으면 400)
//! → `BundleOut` → 직렬화 → `parse_bundle_bytes`로 자기 검증(Err면 400 그 사유) → 응답.

use std::collections::{BTreeMap, HashSet};

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

use crate::app::AppState;
use crate::error::ApiError;
use crate::monitor::board_file::{
    BoardOut, BundleOut, EnvOut, FORMAT, FORMAT_VERSION, MAX_BOARDS, ScenarioOut, ValidBundle,
    parse_bundle_bytes, parse_bundle_value, parse_json_bytes, type_error, unknown_key,
};
use crate::monitor::transfer::{
    AddPlan, Analysis, ImportResult, PcBoard, PcEnv, PcSnapshot, analyze, plan_add,
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
                    crate::monitor::config::replace_forbidden(&b.name)
                )));
            }
            if let Some(e) = &p.environment_id {
                if !envs.contains_key(e) {
                    return Err(ApiError::BadRequest(format!(
                        "보드 '{}' 칸 {n}: 환경이 없습니다",
                        crate::monitor::config::replace_forbidden(&b.name)
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

/// 이 PC의 현재 상태를 가져온다(겹침 판정용). 파일의 시나리오 ID만 조회한다.
pub async fn load_snapshot(
    conn: &mut SqliteConnection,
    b: &ValidBundle,
) -> sqlx::Result<PcSnapshot> {
    let boards = monitor_boards::list_names_enabled(&mut *conn)
        .await?
        .into_iter()
        .map(|(id, name, enabled)| PcBoard { id, name, enabled })
        .collect();
    let ids: Vec<String> = b.scenarios.iter().map(|s| s.id.clone()).collect();
    let scenarios = store::scenarios::yaml_by_ids(&mut *conn, &ids).await?;
    let environments = store::environments::list_all_conn(&mut *conn)
        .await?
        .into_iter()
        .map(|e| PcEnv {
            id: e.id,
            name: e.name,
            vars: e.vars,
        })
        .collect();
    Ok(PcSnapshot {
        boards,
        scenarios,
        environments,
    })
}

/// 시나리오 → 환경 → 보드 순으로 원래 ID로 추가한다.
pub async fn apply(conn: &mut SqliteConnection, plan: &AddPlan) -> sqlx::Result<()> {
    for (id, name, yaml) in &plan.scenarios {
        store::scenarios::insert_with_id(&mut *conn, id, name, yaml).await?;
    }
    for (id, name, vars) in &plan.environments {
        store::environments::insert_with_id(&mut *conn, id, name, vars).await?;
    }
    for (id, name, config) in &plan.boards {
        monitor_boards::insert_with_id(&mut *conn, id, name, config).await?;
    }
    Ok(())
}

/// 교차 사이트 `text/plain` 폼 전송(프리플라이트 없음)을 막는다 — 다른 쓰기 라우트의 `Json` 추출기와 같은 효과.
fn require_json(headers: &HeaderMap) -> Result<(), ApiError> {
    let ok = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|m| m.trim().eq_ignore_ascii_case("application/json"));
    if ok {
        Ok(())
    } else {
        Err(ApiError::UnsupportedMediaType(
            "요청 형식이 올바르지 않습니다(Content-Type: application/json 필요)".into(),
        ))
    }
}

/// POST /monitor-boards/import/analyze — 본문은 파일 바이트 그대로.
pub async fn analyze_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Analysis>, ApiError> {
    require_json(&headers)?;
    let bundle = parse_bundle_bytes(&body).map_err(ApiError::BadRequest)?;
    let mut conn = state.db.acquire().await?;
    let pc = load_snapshot(&mut conn, &bundle).await?;
    Ok(Json(analyze(&bundle, &pc)))
}

/// 요청 본문 `{"bundle": <파일>}` → 파일 값. 오류 문구에는 키 이름만 넣는다(값 금지).
fn parse_import_request(body: &[u8]) -> Result<Value, String> {
    let v = parse_json_bytes(body)?;
    let mut v = v;
    let Some(o) = v.as_object_mut() else {
        return Err(type_error("(본문)"));
    };
    if let Some(k) = o.keys().find(|k| k.as_str() != "bundle") {
        return Err(unknown_key(k));
    }
    o.remove("bundle").ok_or_else(|| type_error("bundle"))
}

/// POST /monitor-boards/import — 겹침이 있으면 409(아무것도 추가 안 함), 없으면 한 트랜잭션으로 추가.
pub async fn import(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<ImportResult>, ApiError> {
    require_json(&headers)?;
    let value = parse_import_request(&body).map_err(ApiError::BadRequest)?;
    let bundle = parse_bundle_value(value).map_err(ApiError::BadRequest)?;
    // 분석과 추가 사이에 다른 쓰기가 끼지 않도록 쓰기 잠금을 먼저 잡는다.
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    let pc = load_snapshot(&mut tx, &bundle).await?;
    let a = analyze(&bundle, &pc);
    let plan = match plan_add(&bundle, &pc, &a) {
        Ok(p) => p,
        Err(boards) => {
            return Err(ApiError::ConflictJson(
                json!({"error": "conflicts", "boards": boards}),
            ));
        }
    };
    apply(&mut tx, &plan).await?;
    tx.commit().await?;
    Ok(Json(plan.result))
}
