//! main.rs 와이어링용 격리 헬퍼(런타임 경로/포트 결정). main-only 와이어링은 통합/e2e가
//! 안 거치므로(controller CLAUDE.md) 여기 순수 함수를 단위 테스트로 잠근다.

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
}
