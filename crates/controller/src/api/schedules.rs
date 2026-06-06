use std::collections::BTreeMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::schedule::trigger::{Trigger, next_fire_after, next_fires, validate_trigger};
use crate::store::runs::Profile;
use crate::store::{now_ms, scenarios, schedules};

/// 와이어 트리거(요청). discriminated union(kind) — UI Zod와 1:1.
#[derive(Debug, Deserialize)]
pub struct TriggerBody {
    pub kind: String, // 'once' | 'cron'
    #[serde(default)]
    pub cron_expr: Option<String>,
    #[serde(default)]
    pub run_at: Option<i64>,
}

impl TriggerBody {
    fn to_trigger(&self) -> Result<Trigger, ApiError> {
        match self.kind.as_str() {
            "once" => self
                .run_at
                .map(|run_at| Trigger::Once { run_at })
                .ok_or_else(|| ApiError::BadRequest("once 트리거는 run_at이 필요합니다".into())),
            "cron" => self
                .cron_expr
                .clone()
                .filter(|s| !s.trim().is_empty())
                .map(|expr| Trigger::Cron { expr })
                .ok_or_else(|| ApiError::BadRequest("cron 트리거는 cron_expr이 필요합니다".into())),
            other => Err(ApiError::BadRequest(format!(
                "알 수 없는 트리거 종류: {other}"
            ))),
        }
    }
}

/// 와이어 트리거(응답). internally-tagged → {"kind":"once","run_at":..} / {"kind":"cron","cron_expr":".."}.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TriggerResponse {
    Once { run_at: i64 },
    Cron { cron_expr: String },
}

#[derive(Debug, Deserialize)]
pub struct ScheduleBody {
    pub name: String,
    pub scenario_id: String,
    pub profile: Profile,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub trigger: TriggerBody,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
pub struct ScheduleResponse {
    pub id: String,
    pub name: String,
    pub scenario_id: String,
    pub profile: Profile,
    pub env: BTreeMap<String, String>,
    pub trigger: TriggerResponse,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
    pub last_run_id: Option<String>,
    pub last_fired_at: Option<i64>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct ScheduleSummary {
    pub id: String,
    pub name: String,
    pub scenario_id: String,
    pub trigger: TriggerResponse,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
    pub last_status: Option<String>,
    pub last_fired_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ScheduleListResponse {
    pub schedules: Vec<ScheduleSummary>,
}

#[derive(Debug, Serialize)]
pub struct EventResponse {
    pub id: String,
    pub at: i64,
    pub kind: String,
    pub run_id: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EventsResponse {
    pub events: Vec<EventResponse>,
}

#[derive(Debug, Deserialize)]
pub struct PreviewBody {
    pub trigger: TriggerBody,
    #[serde(default = "default_preview_count")]
    pub count: usize,
}

fn default_preview_count() -> usize {
    3
}

#[derive(Debug, Serialize)]
pub struct PreviewResponse {
    pub next: Vec<i64>,
}

fn trigger_response(row: &schedules::ScheduleRow) -> TriggerResponse {
    match row.trigger() {
        Trigger::Once { run_at } => TriggerResponse::Once { run_at },
        Trigger::Cron { expr } => TriggerResponse::Cron { cron_expr: expr },
    }
}

fn to_response(row: schedules::ScheduleRow) -> ScheduleResponse {
    let trigger = trigger_response(&row);
    ScheduleResponse {
        id: row.id,
        name: row.name,
        scenario_id: row.scenario_id,
        profile: row.profile,
        env: row.env,
        trigger,
        enabled: row.enabled,
        next_run_at: row.next_run_at,
        last_run_id: row.last_run_id,
        last_fired_at: row.last_fired_at,
        last_status: row.last_status,
        last_error: row.last_error,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// UNIQUE(name) → 409, 그 외 → 500. environments::map_db_err 미러.
fn map_db_err(e: sqlx::Error) -> ApiError {
    if e.as_database_error()
        .map(|d| d.is_unique_violation())
        .unwrap_or(false)
    {
        return ApiError::Conflict("같은 이름의 스케줄이 이미 있습니다".into());
    }
    ApiError::from(e)
}

/// 공통 검증 게이트: 시나리오 존재(404) → profile(`validate_run_config`, 400) →
/// trigger(`validate_trigger`, 400). 통과 시 trigger + next_run_at 계산값 반환.
async fn gate(state: &AppState, body: &ScheduleBody) -> Result<(Trigger, Option<i64>), ApiError> {
    if body.name.trim().is_empty() {
        return Err(ApiError::BadRequest("이름은 비어 있을 수 없습니다".into()));
    }
    scenarios::get(&state.db, &body.scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    // run/preset과 공유하는 권위 게이트(데이터셋/open-loop 검증).
    crate::api::runs::validate_run_config(state, &body.profile).await?;
    let trigger = body.trigger.to_trigger()?;
    let now = now_ms();
    validate_trigger(&trigger, now).map_err(ApiError::BadRequest)?;
    let next_run_at = next_fire_after(&trigger, now, state.scheduler_tz);
    Ok((trigger, next_run_at))
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<ScheduleBody>,
) -> Result<(StatusCode, Json<ScheduleResponse>), ApiError> {
    let (trigger, next_run_at) = gate(&state, &body).await?;
    let row = schedules::insert(
        &state.db,
        body.name.trim(),
        &body.scenario_id,
        &body.profile,
        &body.env,
        &trigger,
        body.enabled,
        next_run_at,
    )
    .await
    .map_err(map_db_err)?;
    Ok((StatusCode::CREATED, Json(to_response(row))))
}

pub async fn list(State(state): State<AppState>) -> Result<Json<ScheduleListResponse>, ApiError> {
    let rows = schedules::list(&state.db).await?;
    let schedules = rows
        .into_iter()
        .map(|r| {
            let trigger = trigger_response(&r);
            ScheduleSummary {
                id: r.id,
                name: r.name,
                scenario_id: r.scenario_id,
                trigger,
                enabled: r.enabled,
                next_run_at: r.next_run_at,
                last_status: r.last_status,
                last_fired_at: r.last_fired_at,
            }
        })
        .collect();
    Ok(Json(ScheduleListResponse { schedules }))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ScheduleResponse>, ApiError> {
    let row = schedules::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ScheduleBody>,
) -> Result<Json<ScheduleResponse>, ApiError> {
    let (trigger, next_run_at) = gate(&state, &body).await?;
    let row = schedules::update(
        &state.db,
        &id,
        body.name.trim(),
        &body.scenario_id,
        &body.profile,
        &body.env,
        &trigger,
        body.enabled,
        next_run_at,
    )
    .await
    .map_err(map_db_err)?
    .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    // 멱등: 없어도 204(events 선삭제 트랜잭션).
    schedules::delete(&state.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn events(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<EventsResponse>, ApiError> {
    // 404 if schedule absent.
    schedules::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let rows = schedules::recent_events(&state.db, &id, 100).await?;
    let events = rows
        .into_iter()
        .map(|e| EventResponse {
            id: e.id,
            at: e.at,
            kind: e.kind,
            run_id: e.run_id,
            detail: e.detail,
        })
        .collect();
    Ok(Json(EventsResponse { events }))
}

pub async fn preview_next(
    State(state): State<AppState>,
    Json(body): Json<PreviewBody>,
) -> Result<Json<PreviewResponse>, ApiError> {
    let trigger = body.trigger.to_trigger()?;
    let now = now_ms();
    validate_trigger(&trigger, now).map_err(ApiError::BadRequest)?;
    let count = body.count.clamp(1, 50);
    let next = next_fires(&trigger, now, state.scheduler_tz, count);
    Ok(Json(PreviewResponse { next }))
}
