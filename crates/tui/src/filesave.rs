//! 보드 파일 저장 — 지문 확인·백업·원자 교체(spec §6.2-4·5). 상태 디렉터리는 인자로 주입한다.
//! 로그에는 단계 이름과 `io::ErrorKind`만 남긴다(경로·내용 금지).

use std::collections::BTreeMap;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::session::MAX_FILE_BYTES;

pub type Fingerprint = [u8; 32];

pub fn fingerprint(bytes: &[u8]) -> Fingerprint {
    Sha256::digest(bytes).into()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileTarget {
    pub given: PathBuf,
    pub real: PathBuf,
}

impl FileTarget {
    fn suffixed(&self, suffix: &str) -> PathBuf {
        let mut s = self.real.clone().into_os_string();
        s.push(suffix);
        PathBuf::from(s)
    }
    pub fn bak(&self) -> PathBuf {
        self.suffixed(".bak")
    }
    pub fn orig_bak(&self) -> PathBuf {
        self.suffixed(".orig.bak")
    }
}

#[derive(Debug, Clone)]
pub struct FileState {
    pub target: FileTarget,
    pub start: Fingerprint,
    pub expected: Fingerprint,
    pub first_done: bool,
    pub state_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteStage {
    ReadCurrent,
    ChangedOutside,
    OrigBackup,
    Backup,
    Temp,
    Persist,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteError {
    pub stage: WriteStage,
    pub kind: Option<ErrorKind>,
}

fn werr(stage: WriteStage, e: &std::io::Error) -> WriteError {
    WriteError {
        stage,
        kind: Some(e.kind()),
    }
}

/// 임시 파일 → 권한 → fsync → persist. 단계 이름은 호출자가 정한다.
fn replace_staged(
    real: &Path,
    bytes: &[u8],
    perm: std::fs::Permissions,
    temp: WriteStage,
    persist: WriteStage,
) -> Result<(), WriteError> {
    let dir = match real.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| werr(temp, &e))?;
    tmp.write_all(bytes).map_err(|e| werr(temp, &e))?;
    tmp.as_file()
        .set_permissions(perm)
        .map_err(|e| werr(temp, &e))?;
    tmp.as_file().sync_all().map_err(|e| werr(temp, &e))?;
    // 실패하면 PersistError가 임시 파일을 돌려준다 — 버려서 지운다.
    tmp.persist(real).map_err(|e| {
        let we = werr(persist, &e.error);
        drop(e.file);
        we
    })?;
    #[cfg(unix)]
    if let Err(e) = std::fs::File::open(dir).and_then(|d| d.sync_all()) {
        tracing::warn!(kind = ?e.kind(), "dir fsync failed");
    }
    Ok(())
}

pub fn replace_atomic(
    real: &Path,
    bytes: &[u8],
    perm: std::fs::Permissions,
) -> Result<(), WriteError> {
    replace_staged(real, bytes, perm, WriteStage::Temp, WriteStage::Persist)
}

fn backup(
    path: &Path,
    bytes: &[u8],
    perm: &std::fs::Permissions,
    stage: WriteStage,
) -> Result<(), WriteError> {
    replace_staged(path, bytes, perm.clone(), stage, stage)
}

fn read_current(real: &Path) -> Result<Vec<u8>, WriteError> {
    let rc = |kind| WriteError {
        stage: WriteStage::ReadCurrent,
        kind,
    };
    let md = std::fs::metadata(real).map_err(|e| rc(Some(e.kind())))?;
    // FIFO·장치로 바뀐 경로에서 작업자가 막히지 않게 읽기 전에 본다.
    if !md.is_file() || md.len() > MAX_FILE_BYTES {
        return Err(rc(None));
    }
    std::fs::read(real).map_err(|e| rc(Some(e.kind())))
}

pub fn write_bundle(
    st: &mut FileState,
    start_bytes: &[u8],
    new_bytes: &[u8],
) -> Result<(), WriteError> {
    let real = st.target.real.clone();
    // ⓐ
    let current = read_current(&real)?;
    if fingerprint(&current) != st.expected {
        return Err(WriteError {
            stage: WriteStage::ChangedOutside,
            kind: None,
        });
    }
    let perm = std::fs::metadata(&real)
        .map_err(|e| werr(WriteStage::ReadCurrent, &e))?
        .permissions();
    // ⓑ
    if !st.first_done {
        let ours = st.state_dir.as_deref().and_then(|d| last_written(d, &real)) == Some(st.start);
        if !ours {
            backup(
                &st.target.orig_bak(),
                start_bytes,
                &perm,
                WriteStage::OrigBackup,
            )?;
        }
    }
    // ⓒ
    backup(&st.target.bak(), &current, &perm, WriteStage::Backup)?;
    // ⓓ
    replace_atomic(&real, new_bytes, perm)?;
    // ⓔ
    st.expected = fingerprint(new_bytes);
    st.first_done = true;
    if let Some(d) = &st.state_dir
        && let Err(e) = record_written(d, &real, &st.expected)
    {
        tracing::warn!(kind = ?e.kind(), "record_written failed");
    }
    Ok(())
}

const RECORD_FILE: &str = "tui-writes.json";

fn hex(fp: &Fingerprint) -> String {
    fp.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Fingerprint> {
    if s.len() != 64 || !s.is_ascii() {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn read_map(state_dir: &Path) -> BTreeMap<String, String> {
    std::fs::read(state_dir.join(RECORD_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn last_written(state_dir: &Path, real: &Path) -> Option<Fingerprint> {
    read_map(state_dir)
        .get(real.to_string_lossy().as_ref())
        .and_then(|s| unhex(s))
}

pub fn record_written(state_dir: &Path, real: &Path, fp: &Fingerprint) -> std::io::Result<()> {
    let mut map = read_map(state_dir);
    map.insert(real.to_string_lossy().into_owned(), hex(fp));
    let body = serde_json::to_vec(&map).map_err(std::io::Error::other)?;
    std::fs::create_dir_all(state_dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(state_dir)?;
    tmp.write_all(&body)?;
    tmp.persist(state_dir.join(RECORD_FILE))
        .map_err(|e| e.error)?;
    Ok(())
}
