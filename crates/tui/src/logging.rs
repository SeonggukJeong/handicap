//! 파일 전용 tracing(터미널에 로그·패닉 기본 출력 금지). 프로세스당 1회 회전·설치.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::Context;
use tracing_subscriber::EnvFilter;

/// 화면·패닉 훅이 받는 로그 위치. 실패 시 `로그 없음: <원인>`으로 표시한다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogLoc {
    Path(PathBuf),
    Unavailable(String),
}

/// `$XDG_STATE_HOME/handicap`(기본 `~/.local/state/handicap`).
pub fn state_dir() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|v| !v.is_empty())
                .map(|h| PathBuf::from(h).join(".local/state"))
        })
        .unwrap_or_else(std::env::temp_dir);
    base.join("handicap")
}

static INSTALLED: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 첫 호출만 직전 로그를 `<name>.1`로 회전하고 구독자를 설치한다. 이후 호출은 같은 경로를 돌려준다.
/// 실패하면 구독자 없이 `Err` — 호출부는 그대로 진행한다.
pub fn init(dir: &Path, file_name: &str) -> anyhow::Result<PathBuf> {
    let mut guard = INSTALLED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = guard.as_ref() {
        return Ok(p.clone());
    }
    std::fs::create_dir_all(dir).with_context(|| format!("{} 만들기", dir.display()))?;
    let path = dir.join(file_name);
    if path.exists() {
        let prev = dir.join(format!("{file_name}.1"));
        std::fs::rename(&path, &prev).with_context(|| format!("{} 회전", path.display()))?;
    }
    let file: File = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .with_context(|| format!("{} 열기", path.display()))?;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_writer(Mutex::new(file))
        .with_ansi(false)
        .with_env_filter(filter)
        .try_init()
        .map_err(|e| anyhow::anyhow!("로그 구독자 설치: {e}"))?;
    *guard = Some(path.clone());
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_twice_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let a = init(tmp.path(), "tui.log").unwrap();
        let b = init(tmp.path(), "tui.log").unwrap();
        assert_eq!(a, b);
        assert!(a.exists());
        assert!(!tmp.path().join("tui.log.1").exists());
    }
}
