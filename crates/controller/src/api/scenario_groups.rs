use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::monitor::config::is_forbidden_text_char;
use crate::store::scenarios;

pub const MAX_GROUP_CHARS: usize = 40;
pub const MAX_ASSIGN_IDS: usize = 500;

const ERR_TOO_LONG: &str = "그룹 이름은 40자까지 쓸 수 있습니다";
const ERR_FORBIDDEN: &str = "그룹 이름에 쓸 수 없는 글자가 들어 있습니다";

/// 그룹 이름 정규화: 앞뒤 공백·U+FEFF를 자르고 비면 `None`(그룹에 넣지 않음).
/// 길이(코드 포인트)를 먼저, 그다음 금지 글자(안쪽 U+FEFF 포함)를 검사한다.
pub fn normalize_group(input: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = input else {
        return Ok(None);
    };
    let s = raw.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
    if s.is_empty() {
        return Ok(None);
    }
    if s.chars().count() > MAX_GROUP_CHARS {
        return Err(ERR_TOO_LONG.into());
    }
    if s.chars()
        .any(|c| is_forbidden_text_char(c) || c == '\u{FEFF}')
    {
        return Err(ERR_FORBIDDEN.into());
    }
    Ok(Some(s.to_string()))
}

#[derive(Debug, Deserialize)]
pub struct AssignRequest {
    pub scenario_ids: Vec<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub group: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RenameRequest {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Serialize)]
pub struct UpdatedResponse {
    pub updated: u64,
}

pub async fn assign(
    State(state): State<AppState>,
    Json(body): Json<AssignRequest>,
) -> Result<Json<UpdatedResponse>, ApiError> {
    if body.scenario_ids.is_empty() || body.scenario_ids.len() > MAX_ASSIGN_IDS {
        return Err(ApiError::BadRequest(format!(
            "scenario_ids는 1개 이상 {MAX_ASSIGN_IDS}개 이하여야 합니다"
        )));
    }
    let group = normalize_group(body.group.as_deref()).map_err(ApiError::BadRequest)?;
    let updated = scenarios::assign_group(&state.db, &body.scenario_ids, group.as_deref()).await?;
    Ok(Json(UpdatedResponse { updated }))
}

pub async fn rename(
    State(state): State<AppState>,
    Json(body): Json<RenameRequest>,
) -> Result<Json<UpdatedResponse>, ApiError> {
    let from = normalize_group(Some(&body.from)).map_err(ApiError::BadRequest)?;
    let to = normalize_group(Some(&body.to)).map_err(ApiError::BadRequest)?;
    let (Some(from), Some(to)) = (from, to) else {
        return Err(ApiError::BadRequest(
            "바꿀 그룹 이름과 새 이름을 모두 입력해야 합니다".into(),
        ));
    };
    if from == to {
        return Err(ApiError::BadRequest(
            "새 이름이 현재 이름과 같습니다".into(),
        ));
    }
    let updated = scenarios::rename_group(&state.db, &from, &to).await?;
    Ok(Json(UpdatedResponse { updated }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CASES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/group_name_cases.json"
    ));

    #[test]
    fn name_cases_match_shared_table() {
        let cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
        assert!(!cases.is_empty());
        for case in &cases {
            let input = case["input"].as_str();
            let got = normalize_group(input);
            let expect = &case["expect"];
            match expect {
                Value::String(k) if k == "none" => assert_eq!(got, Ok(None), "{input:?}"),
                Value::String(k) if k == "too_long" => {
                    assert_eq!(got, Err(ERR_TOO_LONG.to_string()), "{input:?}")
                }
                Value::String(k) if k == "forbidden" => {
                    assert_eq!(got, Err(ERR_FORBIDDEN.to_string()), "{input:?}")
                }
                other => {
                    let v = other["value"].as_str().expect("value case");
                    assert_eq!(got, Ok(Some(v.to_string())), "{input:?}");
                }
            }
        }
    }
}
