use super::{fs::Dir, model::*};
use crate::{error::{Error, Result, check_cancel}, http::{HttpDiskBudget, HttpPurpose, HttpRequest, HttpTransport}, io::BoundedIo};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

#[cfg(feature = "acceptance")]
#[derive(Clone)]
pub struct AcceptanceFeed {
    pub catalog_url: String,
    pub catalog_sha256: String,
    pub trusted_assets: Vec<super::BundledAssets>,
}
#[derive(Clone)]
pub(super) enum Feed {
    Official,
    #[cfg(feature = "acceptance")]
    Acceptance(AcceptanceFeed),
}
impl Feed {
    fn purpose(&self) -> HttpPurpose {
        match self { Self::Official => HttpPurpose::Marketplace, #[cfg(feature = "acceptance")] Self::Acceptance(_) => HttpPurpose::AcceptanceMarketplace }
    }
    fn catalog_url(&self) -> &str {
        match self { Self::Official => OFFICIAL_CATALOG, #[cfg(feature = "acceptance")] Self::Acceptance(feed) => &feed.catalog_url }
    }
    fn package_url(&self, package: &str) -> String {
        let base = self.catalog_url().strip_suffix("catalog.json").expect("validated catalog filename");
        format!("{base}{package}")
    }
}
pub(super) async fn catalog(client: HttpTransport, feed: &Feed, cancel: &CancellationToken) -> Result<Vec<u8>> {
    client.get(HttpRequest { purpose: feed.purpose(), url: feed.catalog_url().into(), target: None, target_parent: None,
        max_bytes: CATALOG_BYTES, expected_size: None, timeout_ms: 30_000, disk_budget: None }, cancel, None).await.map(|response| response.body)
}
pub(super) async fn download(io: &BoundedIo, root: Arc<Dir>, entry: CatalogEntry, client: HttpTransport, feed: &Feed, cancel: &CancellationToken, progress: Arc<dyn Fn(usize) + Send + Sync>) -> Result<()> {
    let prepare = root.clone(); let id = entry.manifest.id.clone(); let bytes = entry.bytes;
    let (target, parent) = io.with_file_budget("plugin-market", 64 * 1024, cancel, move |cancel| async move {
        tokio::task::spawn_blocking(move || {
            check_cancel(&cancel)?; let used = prepare.disk_usage()?;
            if bytes as u64 > DISK_BYTES.saturating_sub(used) { return Err(Error::limit("plugin disk", DISK_BYTES as usize, used as usize + bytes)); }
            let pending = prepare.child(&id, false)?.child("pending", false)?;
            Ok((pending.path.join("archive.ocplugin"), pending.identity()?))
        }).await.map_err(|_| Error::cleanup("HTTP target preparation", Error::new("OC_PLUGIN_IO", "Download preparation failed")))?
    }).await?;
    // The preparation lease is released before HTTP atomically reserves its
    // command/file/socket lease. Cleanup belongs to the enclosing transaction,
    // which cannot run until the worker has actually exited.
    let response = client.get(HttpRequest { purpose: feed.purpose(), url: feed.package_url(&entry.package), target: Some(target), target_parent: Some(parent),
        max_bytes: entry.bytes, expected_size: Some(entry.bytes as u64), timeout_ms: 30_000,
        disk_budget: Some(HttpDiskBudget { root: root.path.clone(), max_bytes: DISK_BYTES }) }, cancel,
        Some(Arc::new(move |value| { progress(value.received_bytes as usize); Ok(()) }))).await?;
    if response.bytes != entry.bytes as u64 || response.sha256 != entry.sha256 { return Err(Error::new("OC_PLUGIN_INTEGRITY", "Plugin download digest/size mismatch")); }
    Ok(())
}
pub(super) async fn copy_bundled(io: &BoundedIo, root: Arc<Dir>, entry: CatalogEntry, source: PathBuf, cancel: &CancellationToken) -> Result<()> {
    io.with_file_budget("plugin-market", 128 * 1024, cancel, move |cancel| async move {
        tokio::task::spawn_blocking(move || {
            use std::{io::{Read, Write}, os::unix::fs::{MetadataExt, OpenOptionsExt}};
            check_cancel(&cancel)?;
            let mut input = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(source).map_err(|e| Error::io("bundled archive open", e))?;
            let pending = root.child(&entry.manifest.id, false)?.child("pending", false)?;
            let mut output = pending.create("archive.ocplugin")?;
            let work = (|| {
                let metadata = input.metadata().map_err(|e| Error::io("bundled archive metadata", e))?;
                if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() != entry.bytes as u64 || metadata.len() > ARCHIVE_BYTES as u64 { return Err(Error::invalid("bundled archive identity/size")); }
                let before = crate::io::FileIdentity::from_metadata(&metadata);
                let mut count = 0usize; let mut hash = Sha256::new(); let mut chunk = [0u8; 64 * 1024];
                loop {
                    check_cancel(&cancel)?; let n = input.read(&mut chunk).map_err(|e| Error::io("bundled archive read", e))?; if n == 0 { break; }
                    if n > entry.bytes - count { return Err(Error::limit("bundled archive", entry.bytes, count + n)); }
                    let used = root.disk_usage()?; if n as u64 > DISK_BYTES.saturating_sub(used) { return Err(Error::limit("plugin disk", DISK_BYTES as usize, used as usize + n)); }
                    output.write_all(&chunk[..n]).map_err(|e| Error::io("bundled archive copy", e))?; count += n; hash.update(&chunk[..n]);
                }
                let after = crate::io::FileIdentity::from_metadata(&input.metadata().map_err(|e| Error::io("bundled archive metadata", e))?);
                if after != before || count != entry.bytes || format!("{:x}", hash.finalize()) != entry.sha256 { return Err(Error::new("OC_PLUGIN_INTEGRITY", "Bundled archive differs from pinned catalog")); }
                output.sync_all().map_err(|e| Error::io("bundled archive fsync", e))?; pending.sync()
            })();
            let work = super::fs::merge(work, super::fs::close(input));
            super::fs::merge(work, super::fs::close(output))
        }).await.map_err(|_| Error::cleanup("bundled copy", Error::new("OC_PLUGIN_IO", "Bundled copy task failed")))?
    }).await
}
