//! 세션 = 임시 DB + in-process 컨트롤러 + 번들 가져오기 + 모든 보드 시작.

use std::io::ErrorKind;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use handicap_controller::in_process::{InProcessConfig, RunningController, run_in_process};

use crate::api::Api;
use crate::tempdb::TempDb;

const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

pub fn strip_bom(b: &[u8]) -> &[u8] {
    b.strip_prefix(&BOM[..]).unwrap_or(b)
}

/// `{"bundle":` + 파일(BOM 제외) + `}` — 재직렬화 없이 바이트 그대로 감싼다.
pub fn import_body(file: &[u8]) -> Vec<u8> {
    [&b"{\"bundle\":"[..], strip_bom(file), &b"}"[..]].concat()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    ReadFile,
    Controller,
    Import,
    StartBoard,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartError {
    pub stage: Stage,
    pub message: String,
    /// 컨트롤러가 떴다면 그 주소(진단·정리 검증용).
    pub rest_addr: Option<SocketAddr>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardRef {
    pub id: String,
    pub name: String,
}

pub struct Session {
    pub api: Api,
    pub boards: Vec<BoardRef>,
    pub file: PathBuf,
    // 선언 순서 = drop 순서: 컨트롤러(풀)가 먼저 닫힌 뒤 DB 파일을 지운다.
    controller: RunningController,
    db: TempDb,
}

fn read_error_message(e: &std::io::Error) -> &'static str {
    match e.kind() {
        ErrorKind::NotFound => "파일을 찾을 수 없습니다",
        ErrorKind::PermissionDenied => "파일을 읽을 권한이 없습니다",
        _ => "파일을 읽을 수 없습니다",
    }
}

impl Session {
    pub async fn start(file: &Path, db_dir: &Path) -> Result<Session, StartError> {
        let db = TempDb::create(db_dir).map_err(|e| StartError {
            stage: Stage::Controller,
            message: format!("점검 엔진을 시작하지 못했습니다: {e}"),
            rest_addr: None,
        })?;
        let cfg = InProcessConfig {
            db: Some(db.path().display().to_string()),
            scheduler_disabled: true,
            ..InProcessConfig::default()
        };
        let controller = run_in_process(cfg).await.map_err(|e| StartError {
            stage: Stage::Controller,
            message: format!("점검 엔진을 시작하지 못했습니다: {e:#}"),
            rest_addr: None,
        })?;
        let rest_addr = controller.rest_addr();
        let api = Api::new(rest_addr);

        match Self::bootstrap(&api, file).await {
            Ok(boards) => Ok(Session {
                api,
                boards,
                file: file.to_path_buf(),
                controller,
                db,
            }),
            Err((stage, message)) => {
                // 이미 start된 감독자·serve 태스크가 남지 않게 정리한 뒤 돌려준다.
                controller.shutdown().await;
                drop(controller);
                drop(db);
                Err(StartError {
                    stage,
                    message,
                    rest_addr: Some(rest_addr),
                })
            }
        }
    }

    async fn bootstrap(api: &Api, file: &Path) -> Result<Vec<BoardRef>, (Stage, String)> {
        let bytes = std::fs::read(file)
            .map_err(|e| (Stage::ReadFile, read_error_message(&e).to_string()))?;
        let result = api
            .import(import_body(&bytes))
            .await
            .map_err(|e| (Stage::Import, e.message))?;
        let boards: Vec<BoardRef> = result
            .boards
            .into_iter()
            .map(|b| BoardRef {
                id: b.id,
                name: b.name,
            })
            .collect();
        for b in &boards {
            api.start(&b.id)
                .await
                .map_err(|e| (Stage::StartBoard, e.message))?;
        }
        Ok(boards)
    }

    pub fn db_path(&self) -> &Path {
        self.db.path()
    }

    pub async fn shutdown(self) {
        self.controller.shutdown().await;
        // controller → db 순으로 drop.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_bom_cases() {
        assert_eq!(strip_bom(&[0xEF, 0xBB, 0xBF, b'{']), b"{");
        assert_eq!(strip_bom(b"{}"), b"{}");
        assert_eq!(strip_bom(b""), b"");
    }

    #[test]
    fn import_body_is_byte_exact() {
        assert_eq!(
            import_body(b" {\"a\" : 1}\n"),
            b"{\"bundle\": {\"a\" : 1}\n}"
        );
        assert_eq!(import_body(&[0xEF, 0xBB, 0xBF, b'1']), b"{\"bundle\":1}");
    }
}
