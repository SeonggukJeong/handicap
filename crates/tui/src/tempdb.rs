//! 0600 임시 SQLite DB — 실행마다 만드는 **전용 0700 디렉터리**(`handicap-tui-<pid>-<무작위>/board.db`) 안에 둔다.
//! SQLite는 `-wal`/`-shm`을 O_EXCL·O_NOFOLLOW 없이 여므로, 공유 디렉터리(/tmp)에 예측 가능한 이름으로
//! 두면 다른 로컬 사용자가 부속 파일을 미리 만들어 둘 수 있다 — 무작위 이름의 0700 디렉터리가 이를 막는다.
//! 정상 종료 시 디렉터리째 삭제, 시작 시 죽은 pid 잔재 정리.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const PREFIX: &str = "handicap-tui-";

/// 이 프로세스가 만든 살아 있는 임시 디렉터리 — 시작 시 정리가 실수로 지우지 않게 한다.
static ACTIVE: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn active() -> std::sync::MutexGuard<'static, Vec<PathBuf>> {
    ACTIVE.lock().unwrap_or_else(|e| e.into_inner())
}

/// `$XDG_RUNTIME_DIR`(없으면 `std::env::temp_dir()`).
pub fn runtime_dir() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

#[derive(Debug)]
pub struct TempDb {
    // `TempDir`의 Drop이 디렉터리째(부속 파일 포함) 지운다.
    dir: tempfile::TempDir,
    path: PathBuf,
}

impl TempDb {
    /// `dir` 아래에 0700 전용 디렉터리를 만들고(mkdtemp 의미) 그 안에 DB 파일을 0600으로 **먼저 생성**한다
    /// (`store::connect`는 `create_if_missing`).
    pub fn create(dir: &Path) -> io::Result<TempDb> {
        let prefix = format!("{PREFIX}{}-", std::process::id());
        let mut builder = tempfile::Builder::new();
        builder.prefix(&prefix);
        // 기본값은 umask 의존(보통 0755)이라 mkdir 시점부터 0700을 명시한다.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let private = builder.tempdir_in(dir)?;
        let path = private.path().join("board.db");
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(&path)?;
        active().push(private.path().to_path_buf());
        Ok(TempDb { dir: private, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let d = self.dir.path();
        active().retain(|p| p != d);
    }
}

/// 살아 있는 임시 디렉터리를 지금 지운다 — 정상 종료 경로가 막혔을 때 감시견이 부르는 마지막 수단.
pub fn remove_active() {
    for d in active().iter() {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[cfg(test)]
fn sidecars(db: &Path) -> [PathBuf; 3] {
    let s = db.as_os_str().to_os_string();
    let with = |suffix: &str| {
        let mut o = s.clone();
        o.push(suffix);
        PathBuf::from(o)
    };
    [db.to_path_buf(), with("-wal"), with("-shm")]
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

/// 죽은 pid의 `handicap-tui-*` 디렉터리(와 옛 형식의 파일)를 지운다. 지운 항목 수를 돌려준다.
///
/// **프로세스 시작 시 첫 `TempDb`를 만들기 전에 한 번** 부른다. 같은 pid의 잔재(pid 재사용)도 지우는 것은
/// 그래서 안전하다 — 이 프로세스가 만든 디렉터리는 `ACTIVE`에 있어 건너뛰고, 그 밖의 같은 pid 항목은
/// 이전 프로세스의 것일 수밖에 없다.
pub fn sweep_stale(dir: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let me = std::process::id();
    let mut n = 0;
    for e in rd.filter_map(Result::ok) {
        let name = e.file_name();
        let Some(pid) = pid_of(&name.to_string_lossy()) else {
            continue;
        };
        if pid != me && pid_alive(pid) {
            continue;
        }
        let path = e.path();
        if active().iter().any(|a| a == &path) {
            continue;
        }
        let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
        let ok = if is_dir {
            std::fs::remove_dir_all(&path).is_ok()
        } else {
            std::fs::remove_file(&path).is_ok()
        };
        if ok {
            n += 1;
        }
    }
    n
}
#[cfg(test)]
mod tests {
    use super::*;

    /// `ACTIVE`는 프로세스 전역이고 `remove_active`는 거기 든 디렉터리를 **전부** 지운다 — 같은
    /// 프로세스에서 나란히 도는 다른 테스트의 살아 있는 TempDb까지 지워 `active.path().exists()`가
    /// 가끔 실패했다(pre-commit에서 관측). TempDb를 만드는 테스트는 이 잠금으로 차례로 돈다.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[cfg(unix)]
    #[test]
    fn db_is_0600_in_0700_private_dir() {
        let _serial = serial();
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let db = TempDb::create(tmp.path()).unwrap();
        let fmode = std::fs::metadata(db.path()).unwrap().permissions().mode();
        assert_eq!(fmode & 0o777, 0o600);
        let dir = db.path().parent().unwrap();
        assert_ne!(dir, tmp.path());
        let dmode = std::fs::metadata(dir).unwrap().permissions().mode();
        assert_eq!(dmode & 0o777, 0o700);
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with(&format!("{PREFIX}{}-", std::process::id())),
            "{name}"
        );
    }

    #[test]
    fn drop_removes_whole_dir_including_sidecars() {
        let _serial = serial();
        let tmp = tempfile::tempdir().unwrap();
        let db = TempDb::create(tmp.path()).unwrap();
        let dir = db.path().parent().unwrap().to_path_buf();
        let [_, w, s] = sidecars(db.path());
        std::fs::write(&w, b"x").unwrap();
        std::fs::write(&s, b"x").unwrap();
        drop(db);
        assert!(!dir.exists());
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    }

    #[test]
    fn paths_are_unique_per_create() {
        let _serial = serial();
        let tmp = tempfile::tempdir().unwrap();
        let a = TempDb::create(tmp.path()).unwrap();
        let b = TempDb::create(tmp.path()).unwrap();
        assert_ne!(a.path(), b.path());
    }

    #[test]
    fn sweep_removes_dead_pid_dirs_and_legacy_files_only() {
        let tmp = tempfile::tempdir().unwrap();
        let dead_dir = tmp.path().join(format!("{PREFIX}{}-abc123", i32::MAX));
        std::fs::create_dir(&dead_dir).unwrap();
        std::fs::write(dead_dir.join("board.db-wal"), b"x").unwrap();
        let dead_legacy = tmp.path().join(format!("{PREFIX}{}-0.db", i32::MAX));
        let dead_legacy_wal = tmp.path().join(format!("{PREFIX}{}-0.db-wal", i32::MAX));
        // pid 1(init)은 항상 살아 있다(권한이 없어도 EPERM=살아 있음).
        let live_dir = tmp.path().join(format!("{PREFIX}1-abc123"));
        std::fs::create_dir(&live_dir).unwrap();
        let other = tmp.path().join("unrelated.db");
        for p in [&dead_legacy, &dead_legacy_wal, &other] {
            std::fs::write(p, b"x").unwrap();
        }
        assert_eq!(sweep_stale(tmp.path()), 3);
        assert!(live_dir.exists() && other.exists());
        assert!(!dead_dir.exists() && !dead_legacy.exists() && !dead_legacy_wal.exists());
    }

    /// N1: 시작 시 정리는 같은 pid(pid 재사용) 잔재도 지우되, 이 프로세스가 만든 살아 있는 TempDb는 건드리지 않는다.
    #[test]
    fn sweep_removes_own_pid_leftovers_but_not_active_tempdb() {
        let _serial = serial();
        let tmp = tempfile::tempdir().unwrap();
        let leftover = tmp
            .path()
            .join(format!("{PREFIX}{}-leftover", std::process::id()));
        std::fs::create_dir(&leftover).unwrap();
        let active = TempDb::create(tmp.path()).unwrap();
        assert_eq!(sweep_stale(tmp.path()), 1);
        assert!(!leftover.exists());
        assert!(active.path().exists());
    }

    /// 감시견이 부르는 강제 정리 — 살아 있는 TempDb 디렉터리도 지운다.
    #[test]
    fn remove_active_deletes_live_dirs() {
        let _serial = serial();
        let tmp = tempfile::tempdir().unwrap();
        let db = TempDb::create(tmp.path()).unwrap();
        let dir = db.path().parent().unwrap().to_path_buf();
        remove_active();
        assert!(!dir.exists());
        drop(db); // 이미 지워졌어도 Drop은 패닉하지 않는다.
    }
}
