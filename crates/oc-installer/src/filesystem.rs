use crate::{ensure, reject, IoResult, Result};
use std::{fs, path::{Component, Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

pub(crate) fn now_ms() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| reject(e.to_string()))?.as_millis() as u64)
}
/// Reject symlinks in *every* existing path component, not just the final component.
pub(crate) fn real_path(path: &Path) -> Result<PathBuf> {
    ensure(path.is_absolute() && path.as_os_str().len() <= 4096, "path must be absolute and bounded")?;
    let mut cursor = PathBuf::new();
    for component in path.components() {
        ensure(matches!(component, Component::RootDir | Component::Normal(_)), "non-normal path component")?;
        cursor.push(component);
        let m = fs::symlink_metadata(&cursor).context(format!("inspect {}", cursor.display()))?;
        ensure(!m.file_type().is_symlink(), "symlink in controlled path")?;
    }
    ensure(fs::canonicalize(path).context("canonicalize controlled path")? == path, "noncanonical controlled path")?;
    Ok(path.to_owned())
}
