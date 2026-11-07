//! 파일 전용 tracing(터미널에 로그·패닉 기본 출력 금지). 프로세스당 1회 회전·설치.
//! 로그에는 점검 대상 URL·오류 문구가 남을 수 있으므로 파일은 0600, 디렉터리는 새로 만들 때 0700이며
//! 심볼릭 링크를 따라 열지 않는다(`O_NOFOLLOW`).

use std::ffi::OsString;
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

/// `$XDG_STATE_HOME/handicap`(기본 `~/.local/state/handicap`). 둘 다 쓸 수 없으면 `None` —
/// 공유 임시 디렉터리로 폴백하지 않는다.
pub fn state_dir() -> Option<PathBuf> {
    state_dir_from(std::env::var_os("XDG_STATE_HOME"), std::env::var_os("HOME"))
}

pub fn state_dir_from(xdg: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    let base = xdg
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            home.filter(|v| !v.is_empty())
                .map(|h| PathBuf::from(h).join(".local/state"))
        })?;
    Some(base.join("handicap"))
}

static INSTALLED: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 디렉터리를 만들고(없을 때만 0700), 직전 로그를 `<name>.1`로 회전한 뒤 0600·`O_NOFOLLOW`로 연다.
fn open_log(dir: &Path, file_name: &str) -> anyhow::Result<(File, PathBuf)> {
    let mut db = std::fs::DirBuilder::new();
    db.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        db.mode(0o700);
    }
    db.create(dir)
        .with_context(|| format!("{} 만들기", dir.display()))?;
    let path = dir.join(file_name);
    // 링크 자체의 존재를 본다(`exists()`는 링크를 따라가 끊긴 링크를 놓친다). rename은 링크 자체를 치운다.
    if std::fs::symlink_metadata(&path).is_ok() {
        let prev = dir.join(format!("{file_name}.1"));
        std::fs::rename(&path, &prev).with_context(|| format!("{} 회전", path.display()))?;
    }
    let mut opts = OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = opts
        .open(&path)
        .with_context(|| format!("{} 열기", path.display()))?;
    Ok((file, path))
}

/// 첫 호출만 직전 로그를 `<name>.1`로 회전하고 구독자를 설치한다. 이후 호출은 같은 경로를 돌려준다.
/// 실패하면 구독자 없이 `Err` — 호출부는 그대로 진행한다.
pub fn init(dir: &Path, file_name: &str) -> anyhow::Result<PathBuf> {
    let mut guard = INSTALLED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = guard.as_ref() {
        return Ok(p.clone());
    }
    let (file, path) = open_log(dir, file_name)?;
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

    #[cfg(unix)]
    #[test]
    fn log_is_0600_and_new_dir_is_0700() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("state/handicap");
        let (_f, path) = open_log(&dir, "tui.log").unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&dir), 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn existing_dir_perms_are_left_alone() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = open_log(tmp.path(), "tui.log").unwrap();
        let m = std::fs::metadata(tmp.path()).unwrap().permissions().mode();
        assert_eq!(m & 0o777, 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_log_is_replaced_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let victim = tmp.path().join("victim.txt");
        std::fs::write(&victim, b"keep").unwrap();
        let dir = tmp.path().join("d");
        std::fs::create_dir(&dir).unwrap();
        std::os::unix::fs::symlink(&victim, dir.join("tui.log")).unwrap();
        let (mut f, path) = open_log(&dir, "tui.log").unwrap();
        std::io::Write::write_all(&mut f, b"log line").unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        assert!(!std::fs::symlink_metadata(&path).unwrap().is_symlink());
        // 회전된 `.1`은 링크 자체다.
        assert!(
            std::fs::symlink_metadata(dir.join("tui.log.1"))
                .unwrap()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn dangling_symlink_is_not_opened_through() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("d");
        std::fs::create_dir(&dir).unwrap();
        let target = tmp.path().join("not-created");
        std::os::unix::fs::symlink(&target, dir.join("tui.log")).unwrap();
        let _ = open_log(&dir, "tui.log").unwrap();
        assert!(!target.exists());
    }

    #[test]
    fn state_dir_has_no_temp_fallback() {
        let os = |s: &str| Some(OsString::from(s));
        assert_eq!(state_dir_from(None, None), None);
        assert_eq!(state_dir_from(os(""), os("")), None);
        assert_eq!(
            state_dir_from(os("/x"), os("/h")),
            Some(PathBuf::from("/x/handicap"))
        );
        assert_eq!(
            state_dir_from(None, os("/h")),
            Some(PathBuf::from("/h/.local/state/handicap"))
        );
    }
}
