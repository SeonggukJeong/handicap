//! 루프백 REST 클라이언트(컨트롤러 in-process, `127.0.0.1:<임시 포트>`).

use std::net::SocketAddr;
use std::time::Duration;

use handicap_controller::monitor::transfer::ImportResult;
use serde::de::DeserializeOwned;

use crate::wire::{BoardResponse, StatusResponse};

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

fn transport(e: reqwest::Error) -> ApiError {
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
    resp.json::<T>().await.map_err(|_| ApiError {
        status: None,
        message: "점검 엔진의 응답을 해석하지 못했습니다".to_string(),
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
}
