use std::collections::BTreeMap;
use std::time::Duration;

use axum::Json;
use handicap_engine::{Scenario, ScenarioTrace, TraceOptions, trace_scenario};
use serde::Deserialize;

use crate::error::ApiError;

const DEFAULT_MAX_REQUESTS: u32 = 50;
const MAX_MAX_REQUESTS: u32 = 10_000;
const WALL_CLOCK_CEILING_SECS: u64 = 120;

fn default_max_requests() -> u32 {
    DEFAULT_MAX_REQUESTS
}

#[derive(Debug, Deserialize)]
pub struct TestRunRequest {
    pub scenario_yaml: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "default_max_requests")]
    pub max_requests: u32,
    /// Reserved for the future worker-based runner (spec §8-3). Ignored in v1.
    #[serde(default)]
    #[allow(dead_code)]
    pub runner: Option<String>,
}

/// `POST /api/test-runs` — run an inline scenario once (1 VU, single pass)
/// in-process and return a per-request trace. Ephemeral: nothing is persisted.
pub async fn create(Json(body): Json<TestRunRequest>) -> Result<Json<ScenarioTrace>, ApiError> {
    if body.max_requests < 1 || body.max_requests > MAX_MAX_REQUESTS {
        return Err(ApiError::Unprocessable(format!(
            "max_requests must be 1..={MAX_MAX_REQUESTS}, got {}",
            body.max_requests
        )));
    }
    let scenario = Scenario::from_yaml(&body.scenario_yaml)
        .map_err(|e| ApiError::Unprocessable(format!("scenario parse: {e}")))?;

    let opts = TraceOptions {
        env: body.env,
        max_requests: body.max_requests,
        max_wall: Duration::from_secs(WALL_CLOCK_CEILING_SECS),
    };
    let trace = trace_scenario(&scenario, &opts).await;
    Ok(Json(trace))
}
