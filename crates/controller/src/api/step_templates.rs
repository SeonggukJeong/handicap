use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::app::AppState;
use crate::error::ApiError;
use crate::store::step_templates;

#[derive(Debug, Deserialize)]
pub struct StepTemplateBody {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub steps_yaml: String,
}

#[derive(Debug, Serialize)]
pub struct StepTemplateResponse {
    pub id: String,
    pub name: String,
    pub description: String,
    pub steps_yaml: String,
    pub step_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Lightweight list row (no steps_yaml body — the insert modal list only needs these).
#[derive(Debug, Serialize)]
pub struct StepTemplateSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub step_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct StepTemplateListResponse {
    pub templates: Vec<StepTemplateSummary>,
}

fn to_response(r: step_templates::StepTemplateRow) -> StepTemplateResponse {
    StepTemplateResponse {
        id: r.id,
        name: r.name,
        description: r.description,
        steps_yaml: r.steps_yaml,
        step_count: r.step_count,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

const CONFLICT_MSG: &str = "같은 이름의 템플릿이 이미 있습니다";

/// 409 carrying the conflicting row's id so the UI overwrite flow can PUT it
/// (spec §4.3 — plain Conflict has no id, so the client wouldn't know the target).
fn conflict(id: &str) -> ApiError {
    ApiError::ConflictJson(json!({ "error": CONFLICT_MSG, "id": id }))
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .map(|d| d.is_unique_violation())
        .unwrap_or(false)
}

fn validate_name(name: &str) -> Result<(), ApiError> {
    if name.trim().is_empty() {
        return Err(ApiError::BadRequest("이름은 비어 있을 수 없습니다".into()));
    }
    Ok(())
}

/// steps_yaml 최소 검증: 엔진 serde로 Vec<Step> 파싱 + 비어있지 않음 → step_count 반환.
/// 422 = test-run 선례(본문 구조 해석 불가). serde_yaml::Error는 ApiError From이 없으므로
/// 명시 map_err 필수 (`?`로 흘리면 다른 variant로 샌다). 스텝 id의 ULID 유효성·UI 중첩
/// 규칙은 의도적으로 안 본다 — 삽입 시 클라가 id를 전부 재발급, 엄격 검증은 UI Zod 게이트.
fn validate_steps_yaml(steps_yaml: &str) -> Result<i64, ApiError> {
    let steps: Vec<handicap_engine::Step> = serde_yaml::from_str(steps_yaml)
        .map_err(|e| ApiError::Unprocessable(format!("steps parse: {e}")))?;
    if steps.is_empty() {
        return Err(ApiError::Unprocessable(
            "스텝이 한 개 이상 필요합니다".into(),
        ));
    }
    Ok(steps.len() as i64)
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<StepTemplateBody>,
) -> Result<(StatusCode, Json<StepTemplateResponse>), ApiError> {
    validate_name(&body.name)?;
    let step_count = validate_steps_yaml(&body.steps_yaml)?;
    let name = body.name.trim().to_string();
    if let Some(existing) = step_templates::find_by_name(&state.db, &name).await? {
        return Err(conflict(&existing.id));
    }
    let row = match step_templates::insert(
        &state.db,
        &name,
        &body.description,
        &body.steps_yaml,
        step_count,
    )
    .await
    {
        Ok(r) => r,
        // pre-check와 INSERT 사이 race 백스톱 — id 재조회로 ConflictJson 유지.
        Err(e) if is_unique_violation(&e) => {
            return Err(
                match step_templates::find_by_name(&state.db, &name).await? {
                    Some(x) => conflict(&x.id),
                    None => ApiError::Conflict(CONFLICT_MSG.into()),
                },
            );
        }
        Err(e) => return Err(e.into()),
    };
    Ok((StatusCode::CREATED, Json(to_response(row))))
}

pub async fn list(
    State(state): State<AppState>,
) -> Result<Json<StepTemplateListResponse>, ApiError> {
    let rows = step_templates::list(&state.db).await?;
    let templates = rows
        .into_iter()
        .map(|r| StepTemplateSummary {
            id: r.id,
            name: r.name,
            description: r.description,
            step_count: r.step_count,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
        .collect();
    Ok(Json(StepTemplateListResponse { templates }))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<StepTemplateResponse>, ApiError> {
    let row = step_templates::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<StepTemplateBody>,
) -> Result<Json<StepTemplateResponse>, ApiError> {
    validate_name(&body.name)?;
    let step_count = validate_steps_yaml(&body.steps_yaml)?;
    let name = body.name.trim().to_string();
    if let Some(existing) = step_templates::find_by_name(&state.db, &name).await? {
        if existing.id != id {
            return Err(conflict(&existing.id));
        }
    }
    let row = match step_templates::update(
        &state.db,
        &id,
        &name,
        &body.description,
        &body.steps_yaml,
        step_count,
    )
    .await
    {
        Ok(r) => r,
        Err(e) if is_unique_violation(&e) => {
            return Err(
                match step_templates::find_by_name(&state.db, &name).await? {
                    Some(x) => conflict(&x.id),
                    None => ApiError::Conflict(CONFLICT_MSG.into()),
                },
            );
        }
        Err(e) => return Err(e.into()),
    };
    let row = row.ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    step_templates::delete(&state.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
