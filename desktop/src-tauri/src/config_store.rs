//! 역할 설정 파일(`desktop-role.json`) 읽기·쓰기 (spec R1). 해석·직렬화는 `handicap_desktop_core::config`.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use handicap_desktop_core::config::{
    parse_config, serialize_config, DesktopConfig, Loaded, CONFIG_FILE_NAME,
};
use tauri::Manager;

/// 설정 디렉터리. env `HANDICAP_DESKTOP_CONFIG_DIR`(라이브 검증 격리) 우선, 없으면 Tauri `app_config_dir`.
pub fn config_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Some(d) = std::env::var_os("HANDICAP_DESKTOP_CONFIG_DIR") {
        return PathBuf::from(d);
    }
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// 파일이 없으면 `parse_config(None)`(경고 없음). 읽기 자체가 실패하면(권한·디렉터리 아님 등)
/// 깨진 파일과 같이 기본값 + 경고 — 그 파일은 다음 저장 때 교체된다(R1).
pub fn load(dir: &Path) -> Loaded {
    match std::fs::read_to_string(dir.join(CONFIG_FILE_NAME)) {
        Ok(raw) => parse_config(Some(&raw)),
        Err(e) if e.kind() == ErrorKind::NotFound => parse_config(None),
        Err(_) => parse_config(Some("")),
    }
}

/// `create_dir_all` + 같은 디렉터리의 임시 파일에 쓰고 rename(반쯤 쓴 파일이 남지 않게).
/// unix에선 파일 0o600·디렉터리 0o700(토큰이 들어 있다 — 같은 PC의 다른 사용자가 못 읽게).
/// rename은 임시 파일의 권한을 그대로 가져간다.
pub fn save(dir: &Path, c: &DesktopConfig) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let tmp = dir.join(format!("{CONFIG_FILE_NAME}.tmp"));
    write_private(&tmp, serialize_config(c).as_bytes())?;
    std::fs::rename(&tmp, dir.join(CONFIG_FILE_NAME))
}

/// 새 파일로 만들어 쓴다(남은 임시 파일은 지운다 — `mode`는 생성 때만 적용되므로).
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use handicap_desktop_core::config::{Role, ServerSettings};

    fn server_cfg() -> DesktopConfig {
        DesktopConfig {
            role: Role::Server,
            server: ServerSettings {
                token: Some("ab".repeat(16)),
                grpc_port: 8093,
                self_worker: false,
            },
        }
    }

    #[test]
    fn save_then_load_round_trips() {
        let d = tempfile::tempdir().unwrap();
        save(d.path(), &server_cfg()).unwrap();
        let l = load(d.path());
        assert_eq!(l.config, server_cfg());
        assert!(!l.warning);
    }

    #[cfg(unix)]
    #[test]
    fn saved_file_and_dir_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("cfg");
        save(&dir, &server_cfg()).unwrap();
        let fm = std::fs::metadata(dir.join(CONFIG_FILE_NAME))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(fm & 0o077, 0, "file mode {fm:o}");
        let dm = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(dm & 0o077, 0, "dir mode {dm:o}");
        // 덮어쓰기(기존 파일 교체)도 같은 권한.
        save(&dir, &server_cfg()).unwrap();
        let fm2 = std::fs::metadata(dir.join(CONFIG_FILE_NAME))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(fm2 & 0o077, 0, "file mode after overwrite {fm2:o}");
    }

    #[test]
    fn save_into_unwritable_dir_errors() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("file");
        std::fs::write(&f, "x").unwrap();
        assert!(save(&f.join("sub"), &server_cfg()).is_err());
    }

    #[test]
    fn missing_file_loads_default_without_warning() {
        let d = tempfile::tempdir().unwrap();
        let l = load(d.path());
        assert_eq!(l.config, DesktopConfig::default());
        assert!(!l.warning);
    }

    #[test]
    fn save_replaces_corrupt_file() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(CONFIG_FILE_NAME), "{not json").unwrap();
        assert!(load(d.path()).warning);
        save(d.path(), &server_cfg()).unwrap();
        assert_eq!(load(d.path()).config, server_cfg());
        assert!(!d.path().join(format!("{CONFIG_FILE_NAME}.tmp")).exists());
    }
}
