//! 사용자 설정 — 칸 테두리 모양과 그 설정 파일 입출력.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 칸 테두리 모양 — 굵은 선(기본) 또는 반 칸 블록.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BorderStyle {
    #[default]
    Heavy,
    Block,
}

impl BorderStyle {
    pub fn toggled(self) -> Self {
        match self {
            Self::Heavy => Self::Block,
            Self::Block => Self::Heavy,
        }
    }
}

/// TUI 설정 파일의 내용. 모르는 키는 무시한다 — `wire.rs`의 `deny_unknown_fields`를 일부러
/// 따르지 않는다(서버 응답이 아니라 TUI 자신의 취향 파일이라 나중 버전의 키에 무너지지 않게).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    pub border: BorderStyle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Loaded {
    Missing,
    Ok(Prefs),
    /// 못 읽음·형식 오류 — 로그에 남길 경고 문구.
    Invalid(String),
}

/// `logging::state_dir_from`과 같은 판정(빈 값은 없는 것으로 본다).
pub fn config_dir_from(xdg: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    let base = xdg
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            home.filter(|v| !v.is_empty())
                .map(|h| PathBuf::from(h).join(".config"))
        })?;
    Some(base.join("handicap"))
}

pub fn config_dir() -> Option<PathBuf> {
    config_dir_from(
        std::env::var_os("XDG_CONFIG_HOME"),
        std::env::var_os("HOME"),
    )
}

pub fn prefs_path() -> Option<PathBuf> {
    Some(config_dir()?.join("tui.json"))
}

pub fn load(path: &Path) -> Loaded {
    match std::fs::read_to_string(path) {
        Ok(s) => match serde_json::from_str::<Prefs>(&s) {
            Ok(p) => Loaded::Ok(p),
            Err(e) => Loaded::Invalid(format!("{}: 형식 오류 — {e}", path.display())),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Loaded::Missing,
        Err(e) => Loaded::Invalid(format!("{}: 읽을 수 없음 — {e}", path.display())),
    }
}

/// 같은 디렉터리의 고유한 임시 파일에 쓴 뒤 이름을 바꾼다(중간에 꺼져도 깨진 파일이 남지 않게).
pub fn save(path: &Path, p: &Prefs) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    let json = serde_json::to_string_pretty(p).map_err(std::io::Error::other)?;
    tmp.write_all(json.as_bytes())?;
    tmp.write_all(b"\n")?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}
