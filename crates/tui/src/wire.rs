//! 컨트롤러 `api/monitor_boards.rs` 응답 구조체의 거울. `deny_unknown_fields`로 서버가
//! 필드를 늘리면 통합 테스트가 RED가 된다(거울 드리프트 감지).

use handicap_controller::monitor::check::CheckResult;
use handicap_controller::monitor::config::BoardConfig;
use serde::Deserialize;

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
