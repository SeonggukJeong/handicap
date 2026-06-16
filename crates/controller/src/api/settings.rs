//! REST handlers: GET/PUT/DELETE /api/settings (spec R1/R2/R3).
//! SettingsState가 검증·스냅샷 권위; store::settings가 DB 영속.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::settings::{Group, SETTINGS, validate};
use crate::store::{self, settings as settings_store};

// ── 내부 헬퍼 ─────────────────────────────────────────────────────────────

fn item_of(v: crate::settings::SettingView) -> SettingItem {
    SettingItem {
        key: v.def.key,
        label: v.def.label,
        group: v.def.group,
        value: v.value,
        default: v.default,
        min: v.def.min,
        max: v.def.max,
        unit: v.def.unit,
        mutable: v.def.mutable,
        source: v.source,
    }
}

fn one_item(state: &AppState, key: &str) -> SettingItem {
    let v = state
        .settings
        .view()
        .into_iter()
        .find(|v| v.def.key == key)
        .expect("key exists — validated before calling");
    item_of(v)
}

// ── 응답 DTO ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SettingItem {
    pub key: &'static str,
    pub label: &'static str,
    pub group: Group,
    pub value: i64,
    pub default: i64,
    pub min: i64,
    pub max: i64,
    pub unit: &'static str,
    pub mutable: bool,
    pub source: &'static str, // "default" | "override" | "readonly"
}

#[derive(Debug, Serialize)]
pub struct SettingsListResponse {
    pub settings: Vec<SettingItem>,
}

// ── 요청 DTO ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PutBody {
    pub value: i64,
}

// ── 핸들러 ───────────────────────────────────────────────────────────────

/// GET /api/settings — 전체 레지스트리(가변+읽기전용)를 유효값·메타와 함께 반환.
pub async fn list(State(state): State<AppState>) -> Json<SettingsListResponse> {
    let views = state.settings.view();
    let settings = views.into_iter().map(item_of).collect();
    Json(SettingsListResponse { settings })
}

/// PUT /api/settings/{key} — 검증 후 DB 영속 + 인메모리 스냅샷 갱신. 200 + 갱신된 SettingItem.
pub async fn put(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<PutBody>,
) -> Result<Json<SettingItem>, ApiError> {
    // R2: 검증(키 존재·가변·범위). BadRequest → 400.
    validate(&key, body.value).map_err(ApiError::BadRequest)?;

    // 키가 존재하는 건 validate가 보장함. 정적 키 참조를 얻기 위해 레지스트리에서 재탐색.
    let def = SETTINGS
        .iter()
        .find(|d| d.key == key)
        .expect("validate passed so key exists");

    // DB 영속 → 인메모리 스냅샷.
    settings_store::upsert(&state.db, def.key, body.value, store::now_ms())
        .await
        .map_err(ApiError::Db)?;
    state.settings.apply_override(def.key, body.value);

    // R2: 갱신된 DTO 반환 (source == "override").
    Ok(Json(one_item(&state, def.key)))
}

/// DELETE /api/settings/{key} — DB 오버라이드 제거 + 인메모리 시드 복원. 204 No Content.
/// 미지 키 → 400, 읽기전용 키 → 400 (R3).
pub async fn delete(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<StatusCode, ApiError> {
    // R3: 미지 키 → 400.
    let def = SETTINGS
        .iter()
        .find(|d| d.key == key.as_str())
        .ok_or_else(|| ApiError::BadRequest(format!("알 수 없는 설정 키: {key}")))?;

    // R3: 읽기전용 키 → 400.
    if !def.mutable {
        return Err(ApiError::BadRequest(format!(
            "'{}'은(는) 변경할 수 없습니다",
            def.label
        )));
    }

    // 가변 키: DB 삭제 + 인메모리 시드 복원.
    settings_store::delete(&state.db, def.key)
        .await
        .map_err(ApiError::Db)?;
    state.settings.revert(def.key);

    Ok(StatusCode::NO_CONTENT)
}
