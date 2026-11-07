//! 0600 임시 SQLite DB(`handicap-tui-<pid>-<seq>.db`) — 정상 종료 시 `-wal`/`-shm`까지 삭제,
//! 시작 시 죽은 pid 잔재 정리.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

const PREFIX: &str = "handicap-tui-";
static SEQ: AtomicU32 = AtomicU32::new(0);

/// `$XDG_RUNTIME_DIR`(없으면 `std::env::temp_dir()`).
pub fn runtime_dir() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

#[derive(Debug)]
pub struct TempDb {
    path: PathBuf,
}

impl TempDb {
    /// 0600으로 **먼저 생성**한다(`store::connect`는 `create_if_missing`).
    pub fn create(dir: &Path) -> io::Result<TempDb> {
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!("{PREFIX}{}-{seq}.db", std::process::id()));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(&path)?;
        Ok(TempDb { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn sidecars(db: &Path) -> [PathBuf; 3] {
    let s = db.as_os_str().to_os_string();
    let with = |suffix: &str| {
        let mut o = s.clone();
        o.push(suffix);
        PathBuf::from(o)
    };
    [db.to_path_buf(), with("-wal"), with("-shm")]
}

impl Drop for TempDb {
    fn drop(&mut self) {
        for p in sidecars(&self.path) {
            let _ = std::fs::remove_file(p);
        }
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let Ok(p) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0은 존재 확인만 한다.
    let r = unsafe { libc::kill(p, 0) };
    r == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool {
    true
}

fn pid_of(name: &str) -> Option<u32> {
    let rest = name.strip_prefix(PREFIX)?;
    let end = rest.find(|c: char| !c.is_ascii_digit())?;
    if end == 0 {
        return None;
    }
    rest[..end].parse().ok()
}

/// 살아 있지 않은 pid의 `handicap-tui-*` 파일을 지운다. 지운 파일 수를 돌려준다.
pub fn sweep_stale(dir: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut n = 0;
    for e in rd.filter_map(Result::ok) {
        let name = e.file_name();
        let Some(pid) = pid_of(&name.to_string_lossy()) else {
            continue;
        };
        if !pid_alive(pid) && std::fs::remove_file(e.path()).is_ok() {
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn create_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let db = TempDb::create(tmp.path()).unwrap();
        let mode = std::fs::metadata(db.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn drop_removes_wal_shm() {
        let tmp = tempfile::tempdir().unwrap();
        let db = TempDb::create(tmp.path()).unwrap();
        let [d, w, s] = sidecars(db.path());
        std::fs::write(&w, b"x").unwrap();
        std::fs::write(&s, b"x").unwrap();
        drop(db);
        assert!(!d.exists() && !w.exists() && !s.exists());
    }

    #[test]
    fn paths_are_unique_per_create() {
        let tmp = tempfile::tempdir().unwrap();
        let a = TempDb::create(tmp.path()).unwrap();
        let b = TempDb::create(tmp.path()).unwrap();
        assert_ne!(a.path(), b.path());
    }

    #[test]
    fn sweep_stale_skips_live_pid() {
        let tmp = tempfile::tempdir().unwrap();
        let live = tmp
            .path()
            .join(format!("{PREFIX}{}-0.db", std::process::id()));
        let dead = tmp.path().join(format!("{PREFIX}{}-0.db", i32::MAX));
        let dead_wal = tmp.path().join(format!("{PREFIX}{}-0.db-wal", i32::MAX));
        let other = tmp.path().join("unrelated.db");
        for p in [&live, &dead, &dead_wal, &other] {
            std::fs::write(p, b"x").unwrap();
        }
        assert_eq!(sweep_stale(tmp.path()), 2);
        assert!(live.exists() && other.exists());
        assert!(!dead.exists() && !dead_wal.exists());
    }
}
