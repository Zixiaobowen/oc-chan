//! Persistent, same-volume macOS application installation.
//!
//! The host keeps `PreparedInstallation` alive, closes admission and drains its real
//! work, calls `spawn_helper`, then exits. The helper waits for that exact process
//! birth and for the retained lock. New applications receive `READY_ARGUMENT`
//! followed by a private request path, and publish evidence only after their real
//! React commit, IPC round trip and enabled collectors have completed.
//! Production entry points always use Apple Developer ID validation. Test trust
//! injection is compiled exclusively by unit tests or the non-default acceptance feature.
//!
//! Durable stage order: prepared → waiting-parent → backup-intent → old-backed-up
//! → install-intent → new-installed → verifying-startup → committed. Both forward
//! renames and rollback renames have fsynced write-ahead intents. A child cannot
//! exec until its pid/birth and readiness request have been durably published.
//! Any uncommitted resumed transaction is rolled back, including the interval
//! between a rename and its completion record. Rollback records stop-new,
//! move-new-to-stage, restore-old and restart-old intents before their effects.
//!
//! `PrepareRequest::candidate_sha512` is the `bundle_digest` inventory digest,
//! separate from the archive hash validated by the download controller. Bundle
//! inventory bounds are 20,000 entries, depth 64 and 2 GiB; no archive extraction
//! or network operation is performed by the helper. Journals are at most 64 KiB,
//! readiness requests/receipts 16 KiB, and command output 128 KiB.
//!
//! Before handoff, cancellation and ordinary host shutdown must explicitly call
//! `PreparedInstallation::abandon` and surface cleanup errors. After handoff the
//! helper finishes or restores the transaction. A failed transaction retains its
//! two bundles and journal for diagnosis; successful commit removes the registered
//! old bundle only after an authenticated receipt and two seconds of survival.
//! The persistent target-directory lock file is never unlinked (flock owns it),
//! preventing lock-inode replacement races. Committed recovery uses the new signed
//! application's helper; uncommitted recovery uses the registered old helper,
//! which may be inside the transaction's backup bundle.
mod filesystem;
mod local;
mod process;
mod signature;
mod transaction;

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::{Path, PathBuf}};
use uuid::Uuid;

pub use process::ProcessIdentity;
pub use transaction::{PreparedInstallation, prepare, run_handoff};
pub use filesystem::bundle_digest;
pub use local::{LOCAL_READY_ARGUMENT, LocalFileIdentity, LocalInstallAuthorization, read_local_ready_request, write_local_ready_receipt};
pub const BUNDLE_ID: &str = "local.oc-chan.desktop";
pub const READY_ARGUMENT: &str = "--oc-install-receipt=";
pub const MAX_TRANSACTION_SECONDS: u64 = 120;

/// Verify the complete installed bundle before enabling online updates.
pub fn verify_host(bundle: &Path) -> Result<String> {
    signature::BundleValidator::validate(&signature::AppleValidator, bundle,
        std::time::Instant::now() + std::time::Duration::from_secs(30))
        .map(|validated| validated.version)
}

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

#[derive(Debug, Clone)]
pub struct PrepareRequest {
    pub target: PathBuf,
    pub candidate: PathBuf,
    pub expected_version: String,
    /// SHA-512 of the canonical bounded bundle inventory, computed after unpacking.
    /// This is separate from the release archive SHA-512 verified by the downloader.
    pub candidate_sha512: String,
    pub parent: ProcessIdentity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileIdentity { pub device: u64, pub inode: u64 }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    Prepared, WaitingParent, BackupIntent, OldBackedUp, InstallIntent,
    NewInstalled, VerifyingStartup, Committed, RollingBack, RolledBack,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RollbackIntent { StopNew, MoveNewToStage, RestoreOld, RestartOld }

/// Persisted journal, not a caller-supplied command language. Paths are derived
/// from the UUID/target; no executable, shell command or script is accepted here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Handoff {
    pub schema: u32,
    pub transaction: Uuid,
    pub created_at_ms: u64,
    pub target: PathBuf,
    pub parent_directory: FileIdentity,
    pub transaction_directory: FileIdentity,
    pub lock: FileIdentity,
    pub parent: ProcessIdentity,
    pub old_bundle: FileIdentity,
    pub new_bundle: FileIdentity,
    pub helper: FileIdentity,
    pub old_digest: String,
    pub new_digest: String,
    pub old_version: String,
    pub expected_version: String,
    pub team: String,
    pub old_executable: String,
    pub new_executable: String,
    pub stage: Stage,
    pub rollback_intent: Option<RollbackIntent>,
    pub launched: Option<ProcessIdentity>,
    pub restored: Option<ProcessIdentity>,
    pub launch_at_ms: Option<u64>,
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
    pub ipc_round_trip: bool,
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
        ensure(self.host_version == version && self.renderer_committed && self.ipc_round_trip,
            "host version, real renderer commit or IPC round trip is missing")?;
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

/// Read and authenticate a request in this process, including current pid/birth,
/// current executable, bundle identity and the private transaction directory.
pub fn read_ready_request(path: &Path) -> Result<ReadyRequest> {
    let request: ReadyRequest = filesystem::read_private_json(path, 16 * 1024)?;
    transaction::validate_ready_path(path, request.transaction, &request.bundle)?;
    ensure(request.schema == 1 && request.process == ProcessIdentity::current()?, "request is for another process")?;
    ensure(request.issued_at_ms <= filesystem::now_ms()? && filesystem::now_ms()? <= request.expires_at_ms,
        "readiness request expired or is from the future")?;
    ensure(request.process.executable.starts_with(request.bundle.join("Contents/MacOS")), "readiness executable outside bundle")?;
    Ok(request)
}

/// Exclusive, fsynced publication. Calling this asserts that the evidence was
/// obtained from real host/renderer services; this library does not invent probes.
pub fn write_ready_receipt(path: &Path, evidence: ReadyEvidence) -> Result<()> {
    let request = read_ready_request(path)?;
    evidence.validate(&request.version)?;
    let receipt = ReadyReceipt { request, checked_at_ms: filesystem::now_ms()?, evidence };
    let output = path.with_file_name("receipt.json");
    filesystem::publish_private_json(&output, &receipt, 16 * 1024)
}

#[cfg(any(test, feature = "acceptance"))]
pub mod acceptance {
    pub use crate::signature::{BundleValidator, ValidatedBundle};
    pub use crate::transaction::{prepare_with_validator, run_handoff_with_validator};
}

#[cfg(test)]
mod tests;
