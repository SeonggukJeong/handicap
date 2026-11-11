//! 루프백 REST 클라이언트(컨트롤러 in-process, `127.0.0.1:<임시 포트>`).

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::time::Duration;

use handicap_controller::monitor::transfer::ImportResult;
use serde::de::DeserializeOwned;

use handicap_controller::monitor::config::BoardConfig;

use crate::wire::{
    BoardResponse, CheckRecord, EnvironmentResponse, ScenarioResponse, StatusResponse,
};

/// 폴링 요청 제한(ms).
pub const POLL_TIMEOUT: Duration = Duration::from_millis(3000);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    /// 4xx/5xx면 HTTP 상태, 연결/시간초과면 `None`.
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(s) => write!(f, "{} ({s})", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for ApiError {}

#[derive(Debug, Clone)]
pub struct Api {
    client: reqwest::Client,
    base: String,
}

/// 실패 종류만 로그에 남긴다 — URL·본문·헤더 값은 절대 남기지 않는다(reqwest Display는 URL 포함).
fn error_kind(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect"
    } else if e.is_decode() {
        "decode"
    } else if e.is_body() {
        "body"
    } else if e.is_request() {
        "request"
    } else {
        "other"
    }
}

/// 원인 체인에서 첫 `std::io::Error`의 종류(`ConnectionRefused` 등)만 — 메시지는 절대 남기지 않는다.
fn io_kind(e: &reqwest::Error) -> Option<std::io::ErrorKind> {
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            return Some(io.kind());
        }
        src = s.source();
    }
    None
}

fn transport(e: reqwest::Error) -> ApiError {
    tracing::warn!(
        kind = error_kind(&e),
        io_kind = ?io_kind(&e),
        http_status = e.status().map(|s| s.as_u16()),
        "api call failed"
    );
    // reqwest Display(URL 포함)를 그대로 노출하지 않는다.
    let message = if e.is_timeout() {
        "응답 시간이 초과되었습니다"
    } else if e.is_connect() {
        "점검 엔진에 연결하지 못했습니다"
    } else {
        "점검 엔진과 통신하지 못했습니다"
    };
    ApiError {
        status: None,
        message: message.to_string(),
    }
}

async fn error_of(resp: reqwest::Response) -> ApiError {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let message = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or_else(|| format!("요청이 실패했습니다 ({})", status.as_u16()));
    ApiError {
        status: Some(status.as_u16()),
        message,
    }
}

async fn parse<T: DeserializeOwned>(resp: reqwest::Response) -> Result<T, ApiError> {
    if !resp.status().is_success() {
        return Err(error_of(resp).await);
    }
    let http_status = resp.status().as_u16();
    resp.json::<T>().await.map_err(|e| {
        tracing::warn!(
            kind = error_kind(&e),
            io_kind = ?io_kind(&e),
            http_status,
            "api response decode failed"
        );
        ApiError {
            status: None,
            message: "점검 엔진의 응답을 해석하지 못했습니다".to_string(),
        }
    })
}

impl Api {
    pub fn new(base: SocketAddr) -> Api {
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("reqwest client");
        Api {
            client,
            base: format!("http://{base}/api"),
        }
    }

    /// `body`는 `{"bundle": <파일>}` 요청 본문. `Content-Type: application/json` 필수(없으면 415).
    pub async fn import(&self, body: Vec<u8>) -> Result<ImportResult, ApiError> {
        let resp = self
            .client
            .post(format!("{}/monitor-boards/import", self.base))
            .header("content-type", "application/json")
            .timeout(WRITE_TIMEOUT)
            .body(body)
            .send()
            .await
            .map_err(transport)?;
        parse(resp).await
    }

    pub async fn start(&self, id: &str) -> Result<(), ApiError> {
        let resp = self
            .client
            .post(format!("{}/monitor-boards/{id}/start", self.base))
            .timeout(WRITE_TIMEOUT)
            .send()
            .await
            .map_err(transport)?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(error_of(resp).await)
        }
    }

    pub async fn board(&self, id: &str) -> Result<BoardResponse, ApiError> {
        let resp = self
            .client
            .get(format!("{}/monitor-boards/{id}", self.base))
            .timeout(POLL_TIMEOUT)
            .send()
            .await
            .map_err(transport)?;
        parse(resp).await
    }

    pub async fn status(&self, id: &str) -> Result<StatusResponse, ApiError> {
        let resp = self
            .client
            .get(format!("{}/monitor-boards/{id}/status", self.base))
            .timeout(POLL_TIMEOUT)
            .send()
            .await
            .map_err(transport)?;
        parse(resp).await
    }

    /// 점검 1회의 기록(요청·응답, 가림·상한 적용본).
    /// 없는 보드·칸·밀려난 기록은 모두 `ApiError{status: Some(404)}`.
    pub async fn record(
        &self,
        board_id: &str,
        panel_id: &str,
        at_ms: i64,
    ) -> Result<CheckRecord, ApiError> {
        let resp = self
            .client
            .get(format!(
                "{}/monitor-boards/{board_id}/panels/{panel_id}/records/{at_ms}",
                self.base
            ))
            .timeout(POLL_TIMEOUT)
            .send()
            .await
            .map_err(transport)?;
        parse(resp).await
    }

    /// PUT /monitor-boards/{id} — 정규화된 보드(묶음 미러 적용본)를 돌려준다.
    pub async fn put_board(
        &self,
        id: &str,
        name: &str,
        config: &BoardConfig,
    ) -> Result<BoardResponse, ApiError> {
        let resp = self
            .client
            .put(format!("{}/monitor-boards/{id}", self.base))
            .timeout(WRITE_TIMEOUT)
            .json(&serde_json::json!({ "name": name, "config": config }))
            .send()
            .await
            .map_err(transport)?;
        parse(resp).await
    }

    /// POST /monitor-boards/export — 응답 바이트 그대로(재직렬화 금지).
    pub async fn export(&self, board_ids: &[String]) -> Result<Vec<u8>, ApiError> {
        let resp = self
            .client
            .post(format!("{}/monitor-boards/export", self.base))
            .timeout(WRITE_TIMEOUT)
            .json(&serde_json::json!({ "board_ids": board_ids }))
            .send()
            .await
            .map_err(transport)?;
        if !resp.status().is_success() {
            return Err(error_of(resp).await);
        }
        resp.bytes().await.map(|b| b.to_vec()).map_err(transport)
    }

    pub async fn environment(&self, id: &str) -> Result<EnvironmentResponse, ApiError> {
        let resp = self
            .client
            .get(format!("{}/environments/{id}", self.base))
            .timeout(POLL_TIMEOUT)
            .send()
            .await
            .map_err(transport)?;
        parse(resp).await
    }

    pub async fn put_environment(
        &self,
        id: &str,
        name: &str,
        vars: &BTreeMap<String, String>,
    ) -> Result<EnvironmentResponse, ApiError> {
        let resp = self
            .client
            .put(format!("{}/environments/{id}", self.base))
            .timeout(WRITE_TIMEOUT)
            .json(&serde_json::json!({ "name": name, "vars": vars }))
            .send()
            .await
            .map_err(transport)?;
        parse(resp).await
    }

    pub async fn scenario(&self, id: &str) -> Result<ScenarioResponse, ApiError> {
        let resp = self
            .client
            .get(format!("{}/scenarios/{id}", self.base))
            .timeout(POLL_TIMEOUT)
            .send()
            .await
            .map_err(transport)?;
        parse(resp).await
    }

    /// 409 = 버전 어긋남(`ApiError.status == Some(409)`).
    pub async fn put_scenario(
        &self,
        id: &str,
        yaml: &str,
        version: i64,
    ) -> Result<ScenarioResponse, ApiError> {
        let resp = self
            .client
            .put(format!("{}/scenarios/{id}", self.base))
            .timeout(WRITE_TIMEOUT)
            .json(&serde_json::json!({ "yaml": yaml, "version": version }))
            .send()
            .await
            .map_err(transport)?;
        parse(resp).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn io_kind_reports_connection_refused() {
        // 곧바로 닫은 리스너 포트 → 연결 거부.
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        let e = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{addr}/"))
            .send()
            .await
            .unwrap_err();
        assert_eq!(io_kind(&e), Some(std::io::ErrorKind::ConnectionRefused));
    }
}
