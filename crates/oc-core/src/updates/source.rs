use super::{fs::{Dir, close, merge}, model::UpdateProgress};
use crate::{error::{Error, Result, check_cancel}, http::{HttpTransport, HttpRequest, HttpPurpose, HttpResponse, HttpProgress, Progress}, io::{BoundedIo, FileIdentity}};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{sync::{Arc, Mutex}, time::{Duration, Instant}};
use tokio_util::sync::CancellationToken;

pub const RELEASES_URL: &str = "https://github.com/Zixiaobowen/oc-chan-releases/releases";
pub const METADATA_URL: &str = "https://github.com/Zixiaobowen/oc-chan-releases/releases/latest/download/latest.json";
pub const MAX_METADATA_BYTES: usize = 64 * 1024;
pub const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;
pub const TARGET: &str = concat!("darwin", "-aarch64");

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Asset { pub target: String, pub name: String, pub size: u64, pub sha512: String }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Metadata { pub schema: u8, pub version: String, pub assets: Vec<Asset> }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Candidate { pub version: String, pub asset: Asset }
impl Candidate {
    fn url(&self) -> String { format!("{RELEASES_URL}/download/v{}/{}", self.version, self.asset.name) }
}
pub(super) fn stable_version(value: &str) -> Result<semver::Version> {
    if value.len() > 64 { return Err(Error::invalid("update version")); }
    let version = semver::Version::parse(value).map_err(|_| Error::invalid("update version"))?;
    if !version.pre.is_empty() || !version.build.is_empty() || version.to_string() != value { return Err(Error::invalid("stable update version")); }
    Ok(version)
}
pub(super) fn parse_metadata(bytes: &[u8], current: &str) -> Result<Option<Candidate>> {
    if bytes.len() > MAX_METADATA_BYTES { return Err(Error::limit("update metadata", MAX_METADATA_BYTES, bytes.len())); }
    let metadata: Metadata = serde_json::from_slice(bytes).map_err(|_| Error::invalid("update metadata JSON"))?;
    if metadata.schema != 2 || metadata.assets.is_empty() || metadata.assets.len() > 8 { return Err(Error::invalid("update metadata schema/assets")); }
    let version = stable_version(&metadata.version)?; let current = stable_version(current)?;
    let name = format!("OC-Chan-{}-mac-arm64.zip", metadata.version); let mut selected = None;
    // Every asset is validated, even for an older feed. Only one fixed arm64
    // package is meaningful; duplicate/unsupported targets cannot hide data.
    for asset in metadata.assets {
        if asset.target != TARGET || asset.name != name || asset.size == 0 || asset.size > MAX_UPDATE_BYTES || asset.sha512.len() != 88 { return Err(Error::invalid("update asset")); }
        let digest = STANDARD.decode(&asset.sha512).map_err(|_| Error::invalid("update SHA-512"))?;
        if digest.len() != 64 || STANDARD.encode(&digest) != asset.sha512 || selected.is_some() { return Err(Error::invalid("update SHA-512 or duplicate asset")); }
        selected = Some(asset);
    }
    Ok(if version > current { Some(Candidate { version: metadata.version, asset: selected.expect("nonempty validated assets") }) } else { None })
}
pub(super) async fn fetch(io: &BoundedIo, transport: &HttpTransport, current: String, cancel: &CancellationToken) -> Result<Option<Candidate>> {
    let response = transport.get(HttpRequest { purpose: HttpPurpose::Update, url: METADATA_URL.into(), target: None, target_parent: None,
        max_bytes: MAX_METADATA_BYTES, expected_size: None, timeout_ms: 30_000, disk_budget: None }, cancel, None).await?;
    // Parsing reserves its own phase after the HTTP process has exited; no
    // nested command/file lease and no detached reqwest connection driver.
    io.with_file_budget("app-updates", 1024 * 1024, cancel, move |cancel| async move {
        check_cancel(&cancel)?;
        if response.bytes != response.body.len() as u64 { return Err(Error::invalid("update metadata length")); }
        parse_metadata(&response.body, &current)
    }).await
}
struct ProgressClock { started: Instant, last: Instant, received: u64 }
impl ProgressClock {
    fn new(now: Instant) -> Self { Self { started: now, last: now, received: 0 } }
    fn observe(&mut self, value: HttpProgress, total: u64, now: Instant) -> Result<Option<UpdateProgress>> {
        if value.received_bytes < self.received || value.received_bytes > total || value.total_bytes.is_some_and(|bytes| bytes != total) { return Err(Error::invalid("update progress size")); }
        self.received = value.received_bytes;
        if now.duration_since(self.last) < Duration::from_millis(250) { return Ok(None); }
        self.last = now; Ok(Some(progress_value(self.received, total, now.duration_since(self.started))))
    }
}
pub(super) async fn download(io: &BoundedIo, transport: &HttpTransport, directory: Arc<Dir>, candidate: Candidate, cancel: &CancellationToken, progress: Arc<dyn Fn(UpdateProgress) + Send + Sync>) -> Result<()> {
    let dir = directory.clone(); let size = candidate.asset.size;
    let parent = io.with_file_budget("app-updates", 64 * 1024, cancel, move |cancel| async move {
        tokio::task::spawn_blocking(move || { check_cancel(&cancel)?; dir.private(true)?; dir.verify_path()?; dir.space(size)?; dir.identity() }).await.map_err(|_| worker_error())?
    }).await?;
    check_cancel(cancel)?;
    let started = Instant::now(); let clock = Mutex::new(ProgressClock::new(started)); let publish = progress.clone();
    let observer: Progress = Arc::new(move |value| {
        if let Some(value) = clock.lock().expect("update progress poisoned").observe(value, size, Instant::now())? { publish(value); }
        Ok(())
    });
    let response = transport.get(HttpRequest { purpose: HttpPurpose::Update, url: candidate.url(), target: Some(directory.path.join("archive.part")),
        target_parent: Some(parent), max_bytes: MAX_UPDATE_BYTES as usize, expected_size: Some(size), timeout_ms: 900_000, disk_budget: None }, cancel, Some(observer)).await?;
    let dir = directory.clone();
    io.with_file_budget("app-updates", 64 * 1024, cancel, move |cancel| async move {
        tokio::task::spawn_blocking(move || {
            check_cancel(&cancel)?; verify_download(&dir, &candidate.asset, &response)?;
            check_cancel(&cancel)?; dir.rename("archive.part", "archive.zip")
        }).await.map_err(|_| worker_error())?
    }).await?;
    progress(progress_value(size, size, started.elapsed())); Ok(())
}
fn verify_download(directory: &Dir, asset: &Asset, response: &HttpResponse) -> Result<()> {
    if response.bytes != asset.size || response.sha512 != asset.sha512 || !response.body.is_empty() {
        return Err(Error::new("OC_UPDATE_INTEGRITY", "更新大小或摘要不符 / Update size or SHA-512 mismatch"));
    }
    let expected = response.file_identity.as_ref().ok_or_else(|| Error::invalid("update worker file identity"))?;
    directory.verify_path()?; let file = directory.read("archive.part")?;
    let result = (|| {
        let identity = FileIdentity::from_metadata(&file.metadata().map_err(|e| Error::io("downloaded update identity", e))?);
        if &identity != expected || identity.size != asset.size || identity.mode & 0o777 != 0o600 { return Err(Error::new("OC_UPDATE_INTEGRITY", "下载文件已改变 / Downloaded file changed")); }
        Ok(())
    })();
    merge(result, close(file))
}
fn progress_value(transferred: u64, total: u64, elapsed: Duration) -> UpdateProgress {
    UpdateProgress { percent: transferred as f64 * 100.0 / total as f64, transferred, total, bytes_per_second: transferred as f64 / elapsed.as_secs_f64().max(0.001) }
}
pub(super) fn worker_error() -> Error { Error::cleanup("update worker", Error::new("OC_UPDATE_WORKER", "更新任务异常退出 / Update worker exited unexpectedly")) }

#[cfg(test)]
mod tests;
