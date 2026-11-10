use crate::{error::{Error, Result, validate_text}, model::MonitorSection};
use oc_plugin_sdk::Capability;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const ARCHIVE_BYTES: usize = 2 * 1024 * 1024;
pub const MANIFEST_BYTES: usize = 16 * 1024;
pub const ENTRY_BYTES: usize = 8 * 1024 * 1024;
pub const EXPANDED_BYTES: usize = 9 * 1024 * 1024;
pub const CENTRAL_BYTES: usize = 64 * 1024;
pub const ZIP_ENTRIES: usize = 16;
pub const INSTALLED_LIMIT: usize = 16;
pub const DISK_BYTES: u64 = 32 * 1024 * 1024;
pub const CATALOG_BYTES: usize = 256 * 1024;
pub const OFFICIAL_BASE: &str = "https://raw.githubusercontent.com/Zixiaobowen/oc-chan/main/plugin-market/";
pub const OFFICIAL_CATALOG: &str = "https://raw.githubusercontent.com/Zixiaobowen/oc-chan/main/plugin-market/catalog.json";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifest {
    pub id: String, pub version: String, pub api_version: u8, pub target: String,
    pub name: String, pub name_en: String, pub description: String, pub description_en: String,
    pub publisher: String, pub section: MonitorSection, pub min_app_version: String,
    pub platforms: Vec<String>, pub permissions: Vec<String>,
}
impl PluginManifest {
    pub fn validate(&self, app_version: &str) -> Result<()> {
        plugin_id(&self.id)?;
        for value in [&self.name, &self.name_en, &self.publisher] { validate_text(value, 120, 480, "plugin label")?; }
        for value in [&self.description, &self.description_en] { validate_text(value, 2048, 8192, "plugin description")?; }
        let minimum = version(&self.min_app_version)?; version(&self.version)?;
        if version(app_version)? < minimum { return Err(Error::new("OC_PLUGIN_APP_VERSION", "Plugin requires a newer application")); }
        if self.api_version != 2 || self.target != "aarch64-apple-darwin" || self.platforms != ["darwin"] { return Err(Error::new("OC_PLUGIN_FORMAT", "Only native apiVersion 2 arm64 bundles are supported; legacy CommonJS packages are rejected")); }
        self.capabilities()?; Ok(())
    }
    pub fn capabilities(&self) -> Result<Vec<Capability>> {
        if self.permissions.len() > 3 || self.permissions.iter().collect::<BTreeSet<_>>().len() != self.permissions.len() { return Err(Error::invalid("plugin permissions")); }
        self.permissions.iter().map(|p| match p.as_str() { "system-metrics" => Ok(Capability::SystemMetrics), "process-ranking" => Ok(Capability::ProcessRanking), "read-default-network-interface" => Ok(Capability::ReadDefaultNetworkInterface), _ => Err(Error::new("OC_PLUGIN_CAPABILITY", "Unknown native plugin permission")) }).collect()
    }
    pub fn bundle_id(&self) -> String { format!("local.oc-chan.plugin.{}", self.id) }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogEntry { pub manifest: PluginManifest, pub package: String, pub sha256: String, pub bytes: usize }
impl CatalogEntry {
    pub fn validate(&self, app: &str) -> Result<()> {
        self.manifest.validate(app)?; package_name(&self.package)?;
        if !oc_plugin_sdk::valid_digest(&self.sha256) || self.bytes == 0 || self.bytes > ARCHIVE_BYTES { return Err(Error::invalid("plugin archive integrity metadata")); } Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Catalog { pub schema: u8, pub plugins: Vec<CatalogEntry> }
impl Catalog {
    pub fn parse(bytes: &[u8], app: &str) -> Result<Self> {
        if bytes.len() > CATALOG_BYTES { return Err(Error::limit("catalog", CATALOG_BYTES, bytes.len())); }
        let catalog: Self = serde_json::from_slice(bytes).map_err(|_| Error::invalid("plugin catalog JSON"))?;
        if catalog.schema != 1 || catalog.plugins.len() > 64 { return Err(Error::invalid("plugin catalog schema or count")); }
        let mut ids = BTreeSet::new(); for entry in &catalog.plugins { entry.validate(app)?; if !ids.insert(&entry.manifest.id) { return Err(Error::invalid("duplicate catalog plugin")); } } Ok(catalog)
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source { Bundled, Online, Installed }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Action { Install, Update, Uninstall }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase { Downloading, Verifying, Activating, Removing }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarketplaceItem { pub manifest: PluginManifest, pub installed: bool, pub installed_version: Option<String>, pub enabled: bool, pub update_available: bool, pub source: Source, pub error: Option<String> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation { pub id: String, pub action: Action, pub phase: Phase, pub received_bytes: usize, pub total_bytes: usize }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationError { pub id: String, pub action: Action, pub message: String }
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarketplaceSnapshot { pub items: Vec<MarketplaceItem>, pub checking: bool, pub checked_at: Option<String>, pub catalog_error: Option<String>, pub operation: Option<Operation>, pub error: Option<OperationError> }
pub fn plugin_id(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 48 || !value.as_bytes()[0].is_ascii_lowercase() || !value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') { return Err(Error::invalid("plugin id")); } Ok(())
}
pub fn package_name(value: &str) -> Result<()> {
    if value.len() > 128 || !value.ends_with(".ocplugin") || value.contains("..") || !value.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric) || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) { return Err(Error::invalid("plugin package name")); } Ok(())
}
pub fn version(value: &str) -> Result<semver::Version> { if value.len() > 64 { return Err(Error::invalid("plugin semantic version")); } semver::Version::parse(value).map_err(|_| Error::invalid("plugin semantic version")) }
