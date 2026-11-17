//! Authenticated local installation startup evidence and readiness receipts.
mod filesystem;
mod local;
mod process;

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};
use uuid::Uuid;

pub use process::ProcessIdentity;
pub use local::{LOCAL_READY_ARGUMENT, LocalFileIdentity, LocalInstallAuthorization, read_local_ready_request, write_local_ready_receipt};
pub const BUNDLE_ID: &str = "local.oc-chan.desktop";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Rejected(String),
    #[error("{operation}: {source}")]
    Io { operation: String, #[source] source: std::io::Error },
    #[error("invalid installer JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{primary}; recovery/cleanup also failed: {secondary}; evidence preserved")]
    Aggregate { primary: Box<Error>, secondary: Box<Error> },
}
pub type Result<T, E = Error> = std::result::Result<T, E>;
pub(crate) fn reject(message: impl Into<String>) -> Error { Error::Rejected(message.into()) }
pub(crate) fn ensure(value: bool, message: &str) -> Result<()> {
    if value { Ok(()) } else { Err(reject(message)) }
}
pub(crate) trait IoResult<T> {
    fn context(self, operation: impl Into<String>) -> Result<T>;
}
impl<T> IoResult<T> for std::io::Result<T> {
    fn context(self, operation: impl Into<String>) -> Result<T> {
        self.map_err(|source| Error::Io { operation: operation.into(), source })
    }
}
pub(crate) fn combine(primary: Error, secondary: Error) -> Error {
    Error::Aggregate { primary: Box::new(primary), secondary: Box::new(secondary) }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadyRequest {
    pub schema: u32,
    pub transaction: Uuid,
    pub bundle: PathBuf,
    pub version: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub process: ProcessIdentity,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PartitionReadiness { Ready, Disabled, NotInstalled, Unsupported, Unavailable }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartitionEvidence {
    pub enabled: bool,
    pub installed: bool,
    pub state: PartitionReadiness,
    /// A bounded diagnostic/source capability reason for unavailable/unsupported.
    pub reason: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryReadiness { Available, Unavailable, Disabled, Unsupported }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadyEvidence {
    pub host_version: String,
    /// An actual committed renderer entry identifier; not a first-frame flag.
    pub renderer_entry: String,
    pub renderer_committed: bool,
    pub action_round_trip: bool,
    /// Exactly agents, schedules, events and system.
    pub partitions: BTreeMap<String, PartitionEvidence>,
    pub hermes_history: HistoryReadiness,
    pub history_entries: u32,
    pub history_reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadyReceipt {
    pub request: ReadyRequest,
    pub checked_at_ms: u64,
    pub evidence: ReadyEvidence,
}

impl ReadyEvidence {
    pub(crate) fn validate(&self, version: &str) -> Result<()> {
        ensure(self.host_version == version && self.renderer_committed && self.action_round_trip,
            "host version, real renderer commit or view action round trip is missing")?;
        ensure(!self.renderer_entry.is_empty() && self.renderer_entry.len() <= 512,
            "renderer entry identifier is missing or oversized")?;
        ensure(self.partitions.len() == 4, "unexpected readiness partitions")?;
        for name in ["agents", "schedules", "events", "system"] {
            let p = self.partitions.get(name).ok_or_else(|| reject("missing readiness partition"))?;
            if let Some(reason) = &p.reason { ensure(!reason.is_empty() && reason.len() <= 512, "invalid partition reason")?; }
            match p.state {
                PartitionReadiness::Ready => ensure(p.enabled && p.installed, "ready partition is not enabled/installed")?,
                PartitionReadiness::Disabled => ensure(!p.enabled && p.installed, "disabled partition is inconsistent")?,
                PartitionReadiness::NotInstalled => ensure(name == "system" && !p.installed && !p.enabled, "invalid not-installed partition")?,
                PartitionReadiness::Unsupported | PartitionReadiness::Unavailable => {
                    ensure(name != "system" && p.installed && p.enabled && p.reason.is_some(),
                        "installed system failure or unexplained source unavailability cannot pass readiness")?;
                }
            }
        }
        ensure(self.history_entries <= 25, "history readiness exceeds page budget")?;
        if self.hermes_history != HistoryReadiness::Available {
            ensure(self.history_entries == 0 && self.history_reason.as_ref().is_some_and(|r| !r.is_empty() && r.len() <= 512),
                "unavailable history requires a bounded actual reason and zero entries")?;
        }
        Ok(())
    }
}

