//! 세션 = 임시 DB + in-process 컨트롤러 + 번들 가져오기 + 모든 보드 시작.

use std::io::{ErrorKind, Read};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use handicap_controller::in_process::{InProcessConfig, RunningController, run_in_process};

use crate::api::Api;
use crate::filesave::{FileTarget, Fingerprint, fingerprint};
use crate::names::Names;
use crate::tempdb::TempDb;

/// 보드 파일 크기 상한 — 이보다 크면 읽지 않고 거절한다.
pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const NOT_A_FILE: &str = "일반 파일이 아닙니다";
const FILE_TOO_BIG: &str = "파일이 너무 큽니다(최대 32 MB)";

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
    /// 저장 대상(시작 때 canonicalize — 실패하면 받은 경로 그대로).
    pub target: FileTarget,
    /// 시작 때 읽은 내용의 지문.
    pub start_fp: Fingerprint,
    /// 시작 때 읽은 번들 바이트(`.orig.bak`용 — 작업자에게 `take()`로 넘긴다).
    pub start_bytes: Option<Vec<u8>>,
    /// 번들 파일에서 푼 시나리오·스텝·환경 이름(파일을 다시 읽지 않는다).
    pub names: Names,
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

/// 크기를 먼저 보고, 읽기도 상한+1바이트에서 끊는다(메타데이터와 실제 길이가 어긋나도 안전).
pub(crate) fn read_capped(file: &Path) -> Result<Vec<u8>, (Stage, String)> {
    let err = |e: &std::io::Error| (Stage::ReadFile, read_error_message(e).to_string());
    // FIFO·장치는 열기/읽기에서 영원히 막힐 수 있다 — 열기 전에 종류부터 본다(링크는 따라간다).
    if !std::fs::metadata(file).map_err(|e| err(&e))?.is_file() {
        return Err((Stage::ReadFile, NOT_A_FILE.to_string()));
    }
    let f = std::fs::File::open(file).map_err(|e| err(&e))?;
    let len = f.metadata().map_err(|e| err(&e))?.len();
    if len > MAX_FILE_BYTES {
        return Err((Stage::ReadFile, FILE_TOO_BIG.to_string()));
    }
    let mut buf = Vec::new();
    f.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| err(&e))?;
    if buf.len() as u64 > MAX_FILE_BYTES {
        return Err((Stage::ReadFile, FILE_TOO_BIG.to_string()));
    }
    Ok(buf)
}

impl Session {
    pub async fn start(file: &Path, db_dir: &Path) -> Result<Session, StartError> {
        // 파일 종류·크기 검사와 읽기를 임시 디렉터리·컨트롤러보다 먼저 — 막히는 경로에서 아무것도 남기지 않는다.
        let bytes = read_capped(file).map_err(|(stage, message)| StartError {
            stage,
            message,
            rest_addr: None,
        })?;
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

        match Self::bootstrap(&api, &bytes).await {
            Ok(boards) => {
                let names = Names::from_bundle(&bytes);
                Ok(Session {
                    api,
                    boards,
                    file: file.to_path_buf(),
                    target: FileTarget {
                        given: file.to_path_buf(),
                        real: std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf()),
                    },
                    start_fp: fingerprint(&bytes),
                    start_bytes: Some(bytes),
                    names,
                    controller,
                    db,
                })
            }
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

    async fn bootstrap(api: &Api, bytes: &[u8]) -> Result<Vec<BoardRef>, (Stage, String)> {
        let result = api
            .import(import_body(bytes))
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
