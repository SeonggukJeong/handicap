//! main.rs 와이어링용 격리 헬퍼(런타임 경로/포트 결정). main-only 와이어링은 통합/e2e가
//! 안 거치므로(controller CLAUDE.md) 여기 순수 함수를 단위 테스트로 잠근다.

use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};

/// DB 파일 경로를 결정한다.
/// - `explicit`(명시 `--db`)이 있으면 그대로.
/// - 없고 `data_dir`(bundle: 사용자 데이터 폴더)가 있으면 `<data_dir>/handicap.db`.
/// - 둘 다 없으면 현행 기본 `./handicap.db`.
pub fn resolve_db_path(explicit: Option<&str>, data_dir: Option<&Path>) -> String {
    if let Some(p) = explicit {
        return p.to_string();
    }
    match data_dir {
        Some(dir) => dir.join("handicap.db").display().to_string(),
        None => "./handicap.db".to_string(),
    }
}

/// `<data_local_dir>/handicap` 형태의 앱 데이터 폴더 경로(존재 보장 X — 호출자가 create_dir_all).
pub fn app_data_dir(base: &Path) -> PathBuf {
    base.join("handicap")
}

/// `preferred`에 바인딩을 시도하고, 이미 사용 중(`AddrInUse`)이며 `allow_fallback`이면
/// 같은 IP의 포트 0(OS-할당 빈 포트)로 재바인딩한다. 그 외 에러는 전파.
/// (bundle 모드에서만 fallback=true — 비-bundle은 현행처럼 사용 중이면 에러.)
pub fn bind_with_fallback(
    preferred: SocketAddr,
    allow_fallback: bool,
) -> std::io::Result<TcpListener> {
    match TcpListener::bind(preferred) {
        Ok(l) => Ok(l),
        Err(e) if allow_fallback && e.kind() == std::io::ErrorKind::AddrInUse => {
            let fallback = SocketAddr::new(preferred.ip(), 0);
            TcpListener::bind(fallback)
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn explicit_db_wins() {
        assert_eq!(
            resolve_db_path(Some("/tmp/x.db"), Some(Path::new("/data"))),
            "/tmp/x.db"
        );
    }

    #[test]
    fn data_dir_used_when_no_explicit() {
        assert_eq!(
            resolve_db_path(None, Some(Path::new("/data/handicap"))),
            "/data/handicap/handicap.db"
        );
    }

    #[test]
    fn falls_back_to_cwd_when_nothing() {
        assert_eq!(resolve_db_path(None, None), "./handicap.db");
    }

    #[test]
    fn app_data_dir_appends_handicap() {
        assert_eq!(
            app_data_dir(Path::new("/data")),
            Path::new("/data/handicap")
        );
    }

    #[test]
    fn fallback_picks_free_port_when_busy() {
        let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
        let busy_addr = occupied.local_addr().unwrap();
        // 같은 주소를 fallback=true로 다시 바인딩 → 다른 포트로 성공.
        let l = bind_with_fallback(busy_addr, true).expect("should fall back");
        assert_ne!(l.local_addr().unwrap().port(), busy_addr.port());
    }

    #[test]
    fn no_fallback_errors_when_busy() {
        let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
        let busy_addr = occupied.local_addr().unwrap();
        let err = bind_with_fallback(busy_addr, false);
        assert!(err.is_err(), "without fallback, busy port must error");
    }
}
