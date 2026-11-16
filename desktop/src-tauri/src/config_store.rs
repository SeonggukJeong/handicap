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
pub fn save(dir: &Path, c: &DesktopConfig) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{CONFIG_FILE_NAME}.tmp"));
    std::fs::write(&tmp, serialize_config(c))?;
    std::fs::rename(&tmp, dir.join(CONFIG_FILE_NAME))
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
