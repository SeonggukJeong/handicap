//! 컨트롤러 `api/monitor_boards.rs` 응답 구조체의 거울. `deny_unknown_fields`로 서버가
//! 필드를 늘리면 통합 테스트가 RED가 된다(거울 드리프트 감지).

use handicap_controller::monitor::check::CheckResult;
use handicap_controller::monitor::config::BoardConfig;
use handicap_engine::ScenarioTrace;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BoardResponse {
    pub id: String,
    pub name: String,
    pub config: BoardConfig,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PanelStatus {
    pub panel_id: String,
    pub results: Vec<CheckResult>,
    pub consecutive_fail: u32,
    pub fail_since_ms: Option<i64>,
    pub running: bool,
    pub check_budget_seconds: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusResponse {
    pub now_ms: i64,
    pub board_updated_at: i64,
    pub enabled: bool,
    pub started_at_ms: Option<i64>,
    pub panels: Vec<PanelStatus>,
}

/// 컨트롤러 `monitor/record.rs` `ClipSide`의 거울.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipSide {
    Request,
    Response,
}

/// 기록 상한에 잘린 본문 — `step`은 `trace.steps` 배열 인덱스(시나리오 스텝 순번 아님).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Clipped {
    pub step: u32,
    pub side: ClipSide,
}

/// 컨트롤러 `monitor/record.rs` `CheckRecord`(손으로 쓴 `Serialize` — at_ms, limit_kb,
/// result, trace, clipped)의 거울. 원본은 `Deserialize`가 없어 재사용할 수 없다.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckRecord {
    pub at_ms: i64,
    pub limit_kb: u32,
    pub result: CheckResult,
    pub trace: Option<ScenarioTrace>,
    pub clipped: Vec<Clipped>,
}

/// 컨트롤러 `api/environments.rs` `EnvironmentResponse`의 거울.
/// `Debug`는 손으로 — `vars` 값 대신 키 수만(값이 `{:?}`로 로그에 새지 않게).
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentResponse {
    pub id: String,
    pub name: String,
    pub vars: BTreeMap<String, String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl std::fmt::Debug for EnvironmentResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnvironmentResponse")
            .field("id", &self.id)
            .field("vars", &format_args!("<{} keys>", self.vars.len()))
            .finish_non_exhaustive()
    }
}

/// 컨트롤러 `api/scenarios.rs` `ScenarioResponse`의 거울.
/// `Debug`는 손으로 — `yaml`(변수 값·인라인 토큰)은 길이만.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScenarioResponse {
    pub id: String,
    pub name: String,
    pub yaml: String,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl std::fmt::Debug for ScenarioResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScenarioResponse")
            .field("id", &self.id)
            .field("yaml", &format_args!("<{} bytes>", self.yaml.len()))
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REC: &str = r#"{"at_ms":5,"limit_kb":16,"result":{"at_ms":5,"verdict":"config_error","latency_ms":null,"reason":"x","detail":null,"display":[]},"trace":null,"clipped":[{"step":0,"side":"request"},{"step":2,"side":"response"}]}"#;

    #[test]
    fn record_trace_null_and_clipped_deserialize() {
        let r: CheckRecord = serde_json::from_str(REC).unwrap();
        assert_eq!(r.at_ms, 5);
        assert_eq!(r.limit_kb, 16);
        assert!(r.trace.is_none());
        assert_eq!(
            r.clipped,
            vec![
                Clipped {
                    step: 0,
                    side: ClipSide::Request
                },
                Clipped {
                    step: 2,
                    side: ClipSide::Response
                },
            ]
        );
    }

    #[test]
    fn record_rejects_unknown_field() {
        let extra = REC.replacen("{\"at_ms\":5,", "{\"extra\":1,\"at_ms\":5,", 1);
        assert!(serde_json::from_str::<CheckRecord>(&extra).is_err());
        let clip = REC.replacen("{\"step\":0,", "{\"x\":1,\"step\":0,", 1);
        assert_ne!(clip, REC);
        assert!(serde_json::from_str::<CheckRecord>(&clip).is_err());
    }
}
