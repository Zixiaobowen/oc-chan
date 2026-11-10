use std::{path::{Path, PathBuf}, sync::{Arc, atomic::{AtomicUsize, Ordering}}};
use futures_util::future::BoxFuture;
use serde::Serialize;
use tokio::sync::Mutex;
use crate::error::{Error, Result};
use super::{AppSettings, SettingsFailureReason, SettingsPatch, SettingsUpdateFailure, SETTINGS_MAX_BYTES};

pub const MAX_PENDING_UPDATES: usize = 16;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StartupFailureReason { InvalidJson, InvalidValues, InvalidEncoding, TooLarge, PermissionDenied, UnsafePath, Changed, Unknown }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLoadError {
    pub reason: StartupFailureReason,
    pub file_path: String,
    pub details: String,
}
impl SettingsLoadError {
    fn new(reason: StartupFailureReason, path: &Path, details: impl Into<String>) -> Self {
        Self { reason, file_path: path.to_string_lossy().into_owned(), details: details.into() }
    }
}
impl std::fmt::Display for SettingsLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{:?}: {}", self.reason, self.details) }
}
impl std::error::Error for SettingsLoadError {}

fn reason_for(error: &Error) -> StartupFailureReason {
    match error.code.as_str() {
        "EACCES" | "EPERM" => StartupFailureReason::PermissionDenied,
        "ELOOP" | "EISDIR" | "ENOTDIR" | "NOT_REGULAR_FILE" => StartupFailureReason::UnsafePath,
        "OC_COLLECTION_LIMIT" => StartupFailureReason::TooLarge,
        "OC_COLLECTION_CHANGED" => StartupFailureReason::Changed,
        _ => StartupFailureReason::Unknown,
    }
}
fn update_reason(error: &Error) -> SettingsFailureReason {
    match error.code.as_str() {
        "EACCES" | "EPERM" => SettingsFailureReason::PermissionDenied,
        "ENOSPC" | "EDQUOT" => SettingsFailureReason::StorageFull,
        "EROFS" => SettingsFailureReason::ReadOnly,
        "EISDIR" | "ENOTDIR" | "EEXIST" => SettingsFailureReason::PathConflict,
        "ENOENT" => SettingsFailureReason::PathUnavailable,
        "ETIMEDOUT" => SettingsFailureReason::Timeout,
        _ => SettingsFailureReason::Unknown,
    }
}

/// Only ENOENT selects defaults. The shared IO supervisor retains the file
/// lease through identity validation and actual descriptor closure.
pub async fn read_settings(io: &crate::io::BoundedIo, path: &Path) -> Result<AppSettings, SettingsLoadError> {
    let read = match io.read_file("settings", path, SETTINGS_MAX_BYTES as usize, true, &io.cancellation()).await {
        Ok(file) => file,
        Err(error) if error.code == "ENOENT" => return Ok(AppSettings::default()),
        Err(error) => return Err(SettingsLoadError::new(reason_for(&error), path, error.to_string())),
    };
    let text = std::str::from_utf8(&read.bytes)
        .map_err(|_| SettingsLoadError::new(StartupFailureReason::InvalidEncoding, path, "OC_SETTINGS_ENCODING_INVALID"))?;
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| SettingsLoadError::new(StartupFailureReason::InvalidJson, path, e.to_string()))?;
    let patch: SettingsPatch = serde_json::from_value(value)
        .map_err(|e| SettingsLoadError::new(StartupFailureReason::InvalidValues, path, e.to_string()))?;
    let mut settings = AppSettings::default();
    settings.apply(patch).map_err(|e| SettingsLoadError::new(StartupFailureReason::InvalidValues, path, e.message))?;
    Ok(settings)
}

pub async fn write_settings(io: &crate::io::BoundedIo, path: &Path, settings: &AppSettings) -> Result<()> {
    settings.validate()?;
    let mut bytes = serde_json::to_vec_pretty(settings).map_err(|e| Error::new("OC_SETTINGS_INVALID", e.to_string()))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > SETTINGS_MAX_BYTES { return Err(Error::new("OC_SETTINGS_TOO_LARGE", "设置超过64KiB / Settings exceed 64KiB")); }
    io.write_atomic("settings", path, bytes, &io.cancellation()).await
}

pub fn failure_from_error(error: &Error, path: &Path) -> SettingsUpdateFailure {
    SettingsUpdateFailure { reason: update_reason(error), details: error.message.clone(), file_path: path.to_string_lossy().into_owned() }
}

pub type SettingsEffect = Arc<dyn Fn(AppSettings) -> BoxFuture<'static, Result<()>> + Send + Sync>;
pub type SettingsWriter = Arc<dyn Fn(PathBuf, AppSettings) -> BoxFuture<'static, Result<()>> + Send + Sync>;

struct State { current: AppSettings, fatal: Option<Error> }
pub struct SettingsStore {
    path: PathBuf,
    state: Mutex<State>,
    pending: AtomicUsize,
    effect: SettingsEffect,
    writer: SettingsWriter,
}

impl SettingsStore {
    pub fn new(io: crate::io::BoundedIo, path: PathBuf, initial: AppSettings, effect: SettingsEffect) -> Self {
        Self::with_writer(path, initial, effect, Arc::new(move |path, settings| {
            let io = io.clone();
            Box::pin(async move { write_settings(&io, &path, &settings).await })
        }))
    }
    pub fn with_writer(path: PathBuf, initial: AppSettings, effect: SettingsEffect, writer: SettingsWriter) -> Self {
        Self { path, state: Mutex::new(State { current: initial, fatal: None }), pending: AtomicUsize::new(0), effect, writer }
    }
    pub fn path(&self) -> &Path { &self.path }
    pub async fn value(&self) -> Result<AppSettings> {
        let state = self.state.lock().await;
        state.fatal.clone().map_or_else(|| Ok(state.current.clone()), Err)
    }
    /// Applies effects, persists, then commits in-memory state. A persistence or
    /// effect failure restores the previous effects; a failed restore is fatal.
    pub async fn update(&self, patch: SettingsPatch) -> Result<AppSettings> {
        loop {
            let current = self.pending.load(Ordering::Acquire);
            if current >= MAX_PENDING_UPDATES { return Err(Error::new("OC_SETTINGS_BUSY", "设置更新已达在途上限，请等待当前操作完成 / Settings update limit reached")); }
            if self.pending.compare_exchange_weak(current, current + 1, Ordering::AcqRel, Ordering::Acquire).is_ok() { break; }
        }
        struct Pending<'a>(&'a AtomicUsize);
        impl Drop for Pending<'_> { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::AcqRel); } }
        let _pending = Pending(&self.pending);
        let mut state = self.state.lock().await;
        if let Some(error) = &state.fatal { return Err(error.clone()); }
        let previous = state.current.clone();
        let mut next = previous.clone();
        next.apply(patch)?;
        if next == previous { return Ok(previous); }
        let effect_error = (self.effect)(next.clone()).await.err();
        if effect_error.is_none() {
            match (self.writer)(self.path.clone(), next.clone()).await {
                Ok(()) => { state.current = next.clone(); return Ok(next); }
                Err(error) => {
                    let restore_disk = if error.code == "OC_ATOMIC_COMMIT" {
                        (self.writer)(self.path.clone(), previous.clone()).await.err()
                    } else { None };
                    let restore_effect = (self.effect)(previous.clone()).await.err();
                    if restore_disk.is_some() || restore_effect.is_some() {
                        let mut failures = vec![error];
                        failures.extend(restore_disk);
                        failures.extend(restore_effect);
                        let mut fatal = Error::aggregate(failures);
                        fatal.code = "OC_SETTINGS_ROLLBACK".into();
                        state.fatal = Some(fatal.clone());
                        return Err(fatal);
                    }
                    return Err(error);
                }
            }
        }
        let failure = effect_error.expect("effect failure");
        match (self.effect)(previous).await {
            Ok(()) => Err(failure),
            Err(rollback) => {
                let fatal = Error::new("OC_SETTINGS_ROLLBACK", format!("设置回滚失败 / Settings rollback failed: {}; {}", failure.message, rollback.message));
                state.fatal = Some(fatal.clone());
                Err(fatal)
            }
        }
    }
}
