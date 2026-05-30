use axum::Json;
use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use serde::Serialize;
use std::collections::BTreeMap;

use crate::app::AppState;
use crate::datasets::{ParseOptions, ParsedDataset, parse_upload};
use crate::error::ApiError;
use crate::store;

#[derive(Debug, Serialize)]
pub struct DatasetResponse {
    pub id: String,
    pub name: String,
    pub columns: Vec<String>,
    pub row_count: i64,
    pub byte_size: i64,
    pub created_at: i64,
    pub sample: Vec<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheets: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct PreviewResponse {
    pub columns: Vec<String>,
    pub row_count: i64,
    pub sample: Vec<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheets: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct DatasetListResponse {
    pub datasets: Vec<store::datasets::DatasetMeta>,
}

const SAMPLE_LIMIT: usize = 20;

/// multipart에서 파일 바이트 + 옵션 + 기본 이름(파일명에서 확장자 제거)을 추출.
struct Upload {
    file: Vec<u8>,
    name: String,
    opts: ParseOptions,
}

async fn read_multipart(mut mp: Multipart) -> Result<Upload, ApiError> {
    let mut file: Option<Vec<u8>> = None;
    let mut name: Option<String> = None;
    let mut opts = ParseOptions::default();

    while let Some(field) = mp
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        let fname = field.name().map(str::to_string);
        match fname.as_deref() {
            Some("file") => {
                if name.is_none() {
                    if let Some(filename) = field.file_name() {
                        name = Some(strip_ext(filename));
                    }
                }
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
                file = Some(data.to_vec());
            }
            Some("name") => {
                name = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| ApiError::BadRequest(e.to_string()))?,
                );
            }
            Some("header") => {
                let v = field
                    .text()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
                opts.has_header = Some(v == "true" || v == "1");
            }
            Some("delimiter") => {
                let v = field
                    .text()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
                opts.delimiter = Some(parse_delimiter(&v));
            }
            Some("encoding") => {
                opts.encoding = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| ApiError::BadRequest(e.to_string()))?,
                );
            }
            Some("sheet") => {
                opts.sheet = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| ApiError::BadRequest(e.to_string()))?,
                );
            }
            _ => {
                let _ = field.bytes().await; // 알 수 없는 필드는 소비하고 무시
            }
        }
    }

    let file = file.ok_or_else(|| ApiError::BadRequest("file 파트가 필요합니다".into()))?;
    Ok(Upload {
        file,
        name: name.unwrap_or_else(|| "dataset".into()),
        opts,
    })
}

fn strip_ext(filename: &str) -> String {
    match filename.rsplit_once('.') {
        Some((stem, _ext)) if !stem.is_empty() => stem.to_string(),
        _ => filename.to_string(),
    }
}

/// "," / ";" / "\t" / 리터럴 탭 → 단일 바이트.
fn parse_delimiter(v: &str) -> u8 {
    match v {
        "\\t" | "tab" | "\t" => b'\t',
        s => s.as_bytes().first().copied().unwrap_or(b','),
    }
}

fn sample_objects(parsed: &ParsedDataset, limit: usize) -> Vec<BTreeMap<String, String>> {
    parsed
        .rows
        .iter()
        .take(limit)
        .map(|cells| {
            parsed
                .columns
                .iter()
                .enumerate()
                .map(|(i, col)| (col.clone(), cells.get(i).cloned().unwrap_or_default()))
                .collect()
        })
        .collect()
}

/// POST /api/datasets — 파싱 + 저장.
pub async fn upload(
    State(state): State<AppState>,
    mp: Multipart,
) -> Result<Json<DatasetResponse>, ApiError> {
    let Upload { file, name, opts } = read_multipart(mp).await?;
    let byte_size = file.len() as i64;
    let parsed = parse_upload(&file, &opts).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let sample = sample_objects(&parsed, SAMPLE_LIMIT);

    let id =
        store::datasets::insert(&state.db, &name, &parsed.columns, &parsed.rows, byte_size).await?;
    let meta = store::datasets::get_meta(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("방금 저장한 데이터셋을 못 읽음")))?;

    Ok(Json(DatasetResponse {
        id: meta.id,
        name: meta.name,
        columns: meta.columns,
        row_count: meta.row_count,
        byte_size: meta.byte_size,
        created_at: meta.created_at,
        sample,
        sheets: parsed.sheets,
    }))
}

/// POST /api/datasets/preview — 파싱만(저장 안 함).
pub async fn preview(
    _state: State<AppState>,
    mp: Multipart,
) -> Result<Json<PreviewResponse>, ApiError> {
    let Upload { file, opts, .. } = read_multipart(mp).await?;
    let parsed = parse_upload(&file, &opts).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let sample = sample_objects(&parsed, SAMPLE_LIMIT);
    Ok(Json(PreviewResponse {
        columns: parsed.columns.clone(),
        row_count: parsed.rows.len() as i64,
        sample,
        sheets: parsed.sheets,
    }))
}

/// GET /api/datasets
pub async fn list(State(state): State<AppState>) -> Result<Json<DatasetListResponse>, ApiError> {
    let datasets = store::datasets::list(&state.db).await?;
    Ok(Json(DatasetListResponse { datasets }))
}

/// GET /api/datasets/{id}
pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<DatasetResponse>, ApiError> {
    let meta = store::datasets::get_meta(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let sample = store::datasets::get_sample(&state.db, &id, SAMPLE_LIMIT as i64).await?;
    Ok(Json(DatasetResponse {
        id: meta.id,
        name: meta.name,
        columns: meta.columns,
        row_count: meta.row_count,
        byte_size: meta.byte_size,
        created_at: meta.created_at,
        sample,
        sheets: None,
    }))
}

/// DELETE /api/datasets/{id} — 8c: 비종료(pending/running) run이 참조하면 409.
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if crate::store::runs::dataset_in_use(&state.db, &id).await? {
        return Err(ApiError::Conflict(
            "이 데이터셋을 참조하는 실행 중(pending/running) run이 있어 삭제할 수 없습니다".into(),
        ));
    }
    store::datasets::delete(&state.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
