use super::model::*;
use crate::{error::{Error, Result}, io::{BoundedIo, CommandSpec}};
use std::{collections::BTreeMap, path::{Path, PathBuf}, time::Duration};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct BundledAssets { pub directory: PathBuf, pub catalog_sha256: String }
pub const HOST_BUNDLE_ID: &str = "local.oc-chan.desktop";
#[derive(Clone)]
pub(super) struct Trust {
    pub bundled: BTreeMap<String, CatalogEntry>, pub directory: PathBuf,
    pub host_bundle: PathBuf, pub host_bundle_id: String,
    #[cfg(feature = "acceptance")]
    fixtures: std::sync::Arc<std::sync::Mutex<BTreeMap<String, CatalogEntry>>>,
}
impl Trust {
    pub async fn load(io: &BoundedIo, assets: BundledAssets, host_bundle: PathBuf, host_bundle_id: String, app: &str, cancel: &CancellationToken) -> Result<Self> {
        if host_bundle_id != HOST_BUNDLE_ID { return Err(Error::invalid("fixed host bundle identifier")); }
        if !assets.directory.is_absolute() || !host_bundle.is_absolute() || !oc_plugin_sdk::valid_digest(&assets.catalog_sha256) { return Err(Error::invalid("bundled plugin trust root")); }
        let bytes = io.read_file("plugin-market", &assets.directory.join("catalog.json"), CATALOG_BYTES, true, cancel).await?.bytes;
        if oc_plugin_sdk::digest(&bytes) != assets.catalog_sha256 { return Err(Error::new("OC_PLUGIN_TRUST", "Bundled catalog differs from this build's pinned digest")); }
        let catalog = Catalog::parse(&bytes, app)?;
        Ok(Self { bundled: catalog.plugins.into_iter().map(|e| (e.manifest.id.clone(), e)).collect(), directory: assets.directory, host_bundle, host_bundle_id,
            #[cfg(feature = "acceptance")] fixtures: Default::default() })
    }
    pub fn pinned(&self, entry: &CatalogEntry) -> bool {
        if self.bundled.get(&entry.manifest.id) == Some(entry) { return true; }
        #[cfg(feature = "acceptance")]
        if self.fixture_pinned(entry) { return true; }
        false
    }
    #[cfg(feature = "acceptance")]
    pub fn fixture_pinned(&self, entry: &CatalogEntry) -> bool {
        self.fixtures.lock().expect("fixture trust poisoned").get(&entry.sha256) == Some(entry)
    }
    pub fn source_path(&self, entry: &CatalogEntry) -> Result<PathBuf> {
        if self.bundled.get(&entry.manifest.id) == Some(entry) { return Ok(self.directory.join(&entry.package)); }
        Err(Error::new("OC_PLUGIN_TRUST", "Package is not pinned to a local resource"))
    }
    #[cfg(feature = "acceptance")]
    pub async fn add_fixtures(&self, io: &BoundedIo, assets: &[BundledAssets], app: &str, cancel: &CancellationToken) -> Result<()> {
        let mut additions = BTreeMap::new();
        for assets in assets {
            if !assets.directory.is_absolute() || !oc_plugin_sdk::valid_digest(&assets.catalog_sha256) { return Err(Error::invalid("acceptance fixture trust root")); }
            let bytes = io.read_file("plugin-market", &assets.directory.join("catalog.json"), CATALOG_BYTES, true, cancel).await?.bytes;
            if oc_plugin_sdk::digest(&bytes) != assets.catalog_sha256 { return Err(Error::new("OC_PLUGIN_TRUST", "Acceptance fixture catalog digest mismatch")); }
            for entry in Catalog::parse(&bytes, app)?.plugins {
                if additions.get(&entry.sha256).is_some_and(|previous| previous != &entry) { return Err(Error::invalid("conflicting native fixture root")); }
                if !additions.contains_key(&entry.sha256) && additions.len() == 64 { return Err(Error::limit("fixture roots", 64, 65)); }
                additions.insert(entry.sha256.clone(), entry);
            }
        }
        crate::error::check_cancel(cancel)?;
        let mut roots = self.fixtures.lock().expect("fixture trust poisoned");
        let count = roots.len() + additions.keys().filter(|key| !roots.contains_key(*key)).count();
        if count > 64 { return Err(Error::limit("fixture roots", 64, count)); }
        if additions.iter().any(|(digest, entry)| roots.get(digest).is_some_and(|previous| previous != entry)) { return Err(Error::invalid("changed native fixture root")); }
        roots.extend(additions);
        Ok(())
    }
    pub async fn host_team(&self, io: &BoundedIo, cancel: &CancellationToken) -> Result<String> {
        validate_identifier(&self.host_bundle_id)?;
        let requirement = format!("anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and identifier \"{}\"", self.host_bundle_id);
        verify(io, &self.host_bundle, &requirement, cancel).await.map_err(|cause| Error { code: "OC_PLUGIN_ONLINE_DISABLED".into(), message: "在线原生包需要已验证的 Developer ID 宿主 / Online native packages require a verified Developer ID host".into(), os_error: cause.os_error, causes: vec![cause] })?;
        let output = io.command("plugin-market", CommandSpec::new("/usr/bin/codesign", ["-d".into(), "--verbose=4".into(), self.host_bundle.as_os_str().to_owned()], 16 * 1024, Duration::from_secs(10)), cancel).await?.success()?;
        let display = std::str::from_utf8(&output.stderr).map_err(|_| Error::invalid("signature display encoding"))?;
        let team = display.lines().find_map(|line| line.strip_prefix("TeamIdentifier=")).ok_or_else(|| Error::new("OC_PLUGIN_TRUST", "Verified host has no Team ID"))?;
        if team.len() != 10 || !team.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) { return Err(Error::invalid("host Team ID")); }
        Ok(team.to_owned())
    }
    pub async fn verify_bundle(&self, io: &BoundedIo, bundle: &Path, entry: &CatalogEntry, source: Source, cancel: &CancellationToken) -> Result<()> {
        let id = entry.manifest.bundle_id(); validate_identifier(&id)?;
        let local = source == Source::Bundled && self.pinned(entry);
        #[cfg(feature = "acceptance")]
        let local = local || self.fixture_pinned(entry);
        let requirement = if local { format!("identifier \"{id}\"") } else {
            let team = self.host_team(io, cancel).await?;
            format!("anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and identifier \"{id}\" and certificate leaf[subject.OU] = \"{team}\"")
        };
        verify(io, bundle, &requirement, cancel).await
    }
}
fn validate_identifier(id: &str) -> Result<()> { if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b)) { Err(Error::invalid("code signing identifier")) } else { Ok(()) } }
async fn verify(io: &BoundedIo, bundle: &Path, requirement: &str, cancel: &CancellationToken) -> Result<()> {
    // codesign treats -R arguments as filenames unless '=' marks an inline requirement.
    let args = vec!["--verify".into(), "--deep".into(), "--strict".into(), "--all-architectures".into(), "-R".into(), format!("={requirement}").into(), bundle.as_os_str().to_owned()];
    let output = io.command("plugin-market", CommandSpec::new("/usr/bin/codesign", args, 32 * 1024, Duration::from_secs(15)), cancel).await?;
    if output.exit_code != 0 {
        return Err(Error::new("OC_COMMAND_FAILED", format!("Native code signature verification failed (/usr/bin/codesign, exit={})", output.exit_code)));
    }
    Ok(())
}
