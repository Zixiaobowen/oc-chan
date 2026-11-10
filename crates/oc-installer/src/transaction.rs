use crate::{
    combine, ensure, filesystem as fsx,
    process::{NativeRuntime, ProcessIdentity, Runtime, stop_exact},
    reject,
    signature::{stable_version, AppleValidator, BundleValidator},
    Error, FileIdentity, Handoff, IoResult, PrepareRequest, ReadyReceipt, ReadyRequest, Result, RollbackIntent, Stage,
    MAX_TRANSACTION_SECONDS, READY_ARGUMENT,
};
use std::{
    ffi::OsString,
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const RECORD: &str = "handoff.json";
const REQUEST: &str = "request.json";
const RECEIPT: &str = "receipt.json";
const MAX_RECORD: u64 = 64 * 1024;
const PARENT_EXIT: Duration = Duration::from_secs(20);
const READY_TIMEOUT: Duration = Duration::from_secs(45);
const SURVIVAL: Duration = Duration::from_secs(2);

/// A prepared transaction that owns the target-directory lock.
///
/// The host keeps this value until it has closed admission and drained real work,
/// then calls [`Self::spawn_helper`] and exits. Dropping it without either
/// `spawn_helper` or `abandon` reports the cleanup failure on stderr; hosts should
/// call `abandon` so a failed cleanup becomes a user-visible error.
pub struct PreparedInstallation {
    pub transaction: uuid::Uuid,
    pub handoff: PathBuf,
    pub target: PathBuf,
    directory: PathBuf,
    lock: fsx::InstallLock,
    handed_off: bool,
}

impl PreparedInstallation {
    /// The helper accepts only this journal path; it cannot carry commands.
    pub fn handoff_path(&self) -> &Path { &self.handoff }

    pub fn helper_path(&self) -> PathBuf { self.target.join("Contents/Resources/oc-installer") }

    /// Spawn the installer that lives inside the already-verified current app.
    /// The host must exit promptly afterwards: the helper waits for the exact
    /// parent birth and then acquires the lock this value holds.
    pub fn spawn_helper(&mut self) -> Result<()> {
        ensure(!self.handed_off, "installation was already handed off")?;
        self.lock.check(self.target.parent().ok_or_else(|| reject("target has no parent"))?)?;
        let helper = self.helper_path();
        fsx::real_path(&helper)?;
        let metadata = fs::symlink_metadata(&helper).context("stat installation helper")?;
        ensure(metadata.is_file() && metadata.mode() & 0o111 != 0 && metadata.mode() & 0o7000 == 0, "invalid installation helper mode")?;
        let mut record: Handoff = fsx::read_private_json(&self.handoff, MAX_RECORD)?;
        ensure(record.stage == Stage::Prepared && record.transaction == self.transaction, "transaction stage changed before handoff")?;
        let validated = AppleValidator.validate(&self.target, Instant::now() + Duration::from_secs(30))?;
        ensure(validated.digest == record.old_digest && validated.team == record.team,
            "current signed application changed before helper execution")?;
        record.helper = fsx::identity(&helper)?;
        fsx::atomic_json(&self.handoff, &record, MAX_RECORD as usize)?;
        // No shell, no inherited descriptors and no waiting: the helper owns the
        // transaction once the parent exits and releases the lock.
        let log = fsx::create_private(&self.directory.join("helper.log"))?;
        let mut command = std::process::Command::new(&helper);
        command.env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"] {
            if let Some(value) = std::env::var_os(key) {
                ensure(value.as_os_str().len() <= 4096, "helper environment exceeds bound")?;
                command.env(key, value);
            }
        }
        command.arg("--handoff").arg(&self.handoff).stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null()).stderr(log);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command.spawn().context("spawn installation helper")?;
        self.handed_off = true;
        Ok(())
    }

    /// Cancel a prepared installation. Only valid before handoff; removes the
    /// owned transaction directory and releases the target lock.
    pub fn abandon(mut self) -> Result<()> {
        ensure(!self.handed_off, "installation was already handed off and must finish or roll back")?;
        let record = load_handoff(&self.handoff)?;
        ensure(record.stage == Stage::Prepared, "only a prepared transaction can be cancelled")?;
        fsx::expect_identity(&self.directory, record.transaction_directory)?;
        let result = remove_tree(&self.directory);
        self.handed_off = true;
        result
    }
}
impl Drop for PreparedInstallation {
    fn drop(&mut self) {
        if !self.handed_off {
            // Drop cannot surface a filesystem failure. Keep the owned evidence;
            // the host must explicitly call abandon for a cancellable operation.
            eprintln!("oc-installer: unhanded prepared transaction retained at {}; call abandon to cancel", self.directory.display());
        }
    }
}

pub fn prepare(request: PrepareRequest) -> Result<PreparedInstallation> {
    let parent_executable = request.parent.executable.strip_prefix(request.target.join("Contents/MacOS"))
        .map_err(|_| reject("production parent must run inside the installed target"))?;
    ensure(parent_executable.components().count() == 1, "invalid production parent executable")?;
    crate::signature::verify_arm64_executable(&request.target.join("Contents/Resources/oc-installer"))?;
    prepare_with_validator(request, &AppleValidator)
}

pub fn prepare_with_validator<V: BundleValidator + ?Sized>(request: PrepareRequest, validator: &V)
    -> Result<PreparedInstallation> {
    ensure(request.parent == ProcessIdentity::current()?, "handoff parent must be the calling process")?;
    validate_target(&request.target)?;
    let parent = request.target.parent().ok_or_else(|| reject("target has no parent"))?.to_owned();
    let parent_identity = fsx::parent_directory(&parent)?;
    validate_installed(&request.target)?;
    ensure(fsx::real_path(&request.candidate)? != fsx::real_path(&request.target)?, "candidate cannot be the installed target")?;
    // Only the final stage must share the target volume; the downloaded source
    // can live on a different volume and is streamed into the private stage.
    stable_version(&request.expected_version)?;
    ensure(is_sha512(&request.candidate_sha512), "pinned candidate digest must be lowercase SHA-512")?;
    let end = Instant::now() + Duration::from_secs(MAX_TRANSACTION_SECONDS);
    let lock = fsx::InstallLock::acquire(&parent, None)?;
    lock.check(&parent)?;
    let mut count = 0usize;
    for entry in fs::read_dir(&parent).context("check interrupted transactions")? {
        count += 1;
        ensure(count <= 4096, "installation parent entry budget exceeded")?;
        let entry = entry.context("read installation parent entry")?;
        if entry.file_name().to_str().is_some_and(|name| name.starts_with(".oc-chan-transaction-")) {
            let journal = entry.path().join(RECORD);
            if !path_exists(&journal)? {
                let directory = entry.path();
                fsx::private_directory(&directory)?;
                let name = entry.file_name();
                let suffix = name.to_str().and_then(|name| name.strip_prefix(".oc-chan-transaction-"))
                    .ok_or_else(|| reject("invalid transaction directory name"))?;
                uuid::Uuid::parse_str(suffix).map_err(|_| reject("invalid transaction directory UUID"))?;
                // A committed cleanup unlinks its journal last. An empty owned
                // directory is the only safe journal-less recovery window.
                ensure(fs::read_dir(&directory).context("inspect journal-less transaction")?.next().is_none(),
                    "unfinished staging directory requires explicit recovery or cancellation")?;
                fs::remove_dir(&directory).context("finish empty committed directory cleanup")?;
                fsx::sync_directory(&parent)?;
                continue;
            }
            let prior = load_handoff(&journal)?;
            ensure(prior.stage == Stage::RolledBack, "an earlier installation must be recovered before preparing another")?;
        }
    }
    stage_transaction(request, &parent, parent_identity, lock, end, validator)
}

fn stage_transaction<V: BundleValidator + ?Sized>(request: PrepareRequest, parent: &Path, parent_identity: FileIdentity,
    lock: fsx::InstallLock, end: Instant, validator: &V) -> Result<PreparedInstallation> {
    let old = validator.validate(&request.target, end)?;
    ensure(old.version != request.expected_version, "candidate version is not an upgrade")?;
    ensure(stable_version(&request.expected_version)? > stable_version(&old.version)?, "candidate must be a strict upgrade")?;
    let candidate = validator.validate(&request.candidate, end)?;
    ensure(candidate.version == request.expected_version, "candidate version differs from request")?;
    ensure(candidate.team == old.team, "candidate and installed application must share a Team")?;
    ensure(candidate.digest == request.candidate_sha512, "candidate digest differs from the pinned release digest")?;
    let uuid = uuid::Uuid::new_v4();
    // The staging location is on the target's own volume so both renames stay
    // atomic; it is created 0700 before anything is copied into it.
    let directory = parent.join(format!(".oc-chan-transaction-{uuid}"));
    fsx::mkdir_private(&directory)?;
    let staged = directory.join("stage").join("OC Chan.app");
    let backup = directory.join("backup").join("OC Chan.app");
    let built = (|| -> Result<()> {
        fs::create_dir(directory.join("stage")).context("create stage directory")?;
        fs::create_dir(directory.join("backup")).context("create backup directory")?;
        fsx::sync_directory(&directory)?;
        fsx::copy_bundle(&request.candidate, &staged, end)?;
        let staged_validation = validator.validate(&staged, end)?;
        ensure(staged_validation.digest == candidate.digest && staged_validation.version == candidate.version
            && staged_validation.team == candidate.team && staged_validation.executable == candidate.executable,
            "staged copy differs from the validated candidate")?;
        let record = Handoff {
            schema: 1,
            transaction: uuid,
            created_at_ms: fsx::now_ms()?,
            target: request.target.clone(),
            parent_directory: parent_identity,
            transaction_directory: fsx::private_directory(&directory)?,
            lock: lock.identity,
            parent: request.parent.clone(),
            old_bundle: fsx::identity(&request.target)?,
            new_bundle: fsx::identity(&staged)?,
            helper: fsx::identity(&ProcessIdentity::current()?.executable)?,
            old_digest: old.digest.clone(),
            new_digest: candidate.digest.clone(),
            old_version: old.version.clone(),
            expected_version: candidate.version.clone(),
            team: candidate.team.clone(),
            old_executable: old.executable.clone(),
            new_executable: candidate.executable.clone(),
            stage: Stage::Prepared,
            rollback_intent: None,
            launched: None,
            restored: None,
            launch_at_ms: None,
        };
        ensure(record.old_digest != record.new_digest, "candidate content equals the installed application")?;
        ensure(fsx::private_directory(&directory)? == record.transaction_directory, "transaction directory changed while sealing")?;
        fsx::atomic_json(&directory.join(RECORD), &record, MAX_RECORD as usize)?;
        // Both durable intents are checked against live paths before the record is
        // accepted as the transaction seal.
        ensure(fsx::identity(&request.target)? == record.old_bundle, "installed application changed during prepare")?;
        ensure(fsx::identity(&staged)? == record.new_bundle, "staged application changed during prepare")?;
        ensure(!path_exists(&backup)?, "backup position is occupied")?;
        Ok(())
    })();
    if let Err(error) = built {
        drop(lock);
        return Err(match fs::remove_dir_all(&directory) {
            Ok(()) => error,
            Err(cleanup) => combine(error, Error::Io { operation: format!("remove {}", directory.display()), source: cleanup }),
        });
    }
    Ok(PreparedInstallation {
        transaction: uuid, handoff: directory.join(RECORD), target: request.target, directory, lock, handed_off: false,
    })
}

pub(crate) fn validate_target(target: &Path) -> Result<()> {
    ensure(target.is_absolute() && target.as_os_str().len() <= 4096, "installation target must be absolute")?;
    ensure(target.file_name().is_some_and(|name| name == "OC Chan.app"), "installation target must be OC Chan.app")?;
    let parent = target.parent().ok_or_else(|| reject("target has no parent"))?;
    fsx::real_path(parent)?;
    ensure(!target.as_os_str().as_encoded_bytes().contains(&0), "invalid target")
}
fn validate_installed(target: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(target).context("installed application is required")?;
    ensure(metadata.is_dir() && !metadata.file_type().is_symlink(), "installed application must be a real directory")?;
    fsx::real_path(target)?;
    Ok(())
}
pub(crate) fn is_sha512(value: &str) -> bool {
    value.len() == 128 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn path_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(Error::Io { operation: format!("stat {}", path.display()), source: e }),
    }
}
fn remove_tree(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            ensure(!metadata.file_type().is_symlink(), "refusing to remove a symlink")?;
            fs::remove_dir_all(path).context(format!("remove {}", path.display()))?;
            if let Some(parent) = path.parent() { fsx::sync_directory(parent)?; }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::Io { operation: format!("stat {}", path.display()), source: e }),
    }
}

/// Run a sealed handoff or recover an interrupted transaction. Production trust
/// is not selected by fields inside the journal or by CLI flags.
pub fn run_handoff(path: &Path) -> Result<()> {
    let end = Instant::now() + Duration::from_secs(MAX_TRANSACTION_SECONDS);
    let record = load_handoff(path)?;
    let current = ProcessIdentity::current()?;
    if record.stage == Stage::Committed {
        ensure(current.executable == record.target.join("Contents/Resources/oc-installer"),
            "committed recovery must use the installed application's helper")?;
        let new = AppleValidator.validate(&record.target, Instant::now() + Duration::from_secs(20))?;
        ensure(new.team == record.team && new.digest == record.new_digest, "committed application trust changed")?;
    } else {
        fsx::expect_identity(&current.executable, record.helper)?;
        let old_location = if fsx::optional_identity(&record.target)? == Some(record.old_bundle) {
            record.target.clone()
        } else { path.parent().ok_or_else(|| reject("missing transaction parent"))?.join("backup/OC Chan.app") };
        ensure(current.executable == old_location.join("Contents/Resources/oc-installer"),
            "installer is not running from the registered old application's resource")?;
        let old = AppleValidator.validate(&old_location, Instant::now() + Duration::from_secs(20))?;
        ensure(old.team == record.team && old.digest == record.old_digest, "old application trust changed")?;
    }
    run_until(path, &AppleValidator, &NativeRuntime, end)
}

pub fn run_handoff_with_validator<V: BundleValidator + ?Sized>(path: &Path, validator: &V) -> Result<()> {
    run_with_runtime(path, validator, &NativeRuntime)
}

fn load_handoff(path: &Path) -> Result<Handoff> {
    ensure(path.file_name().is_some_and(|n| n == RECORD), "only handoff.json can be executed")?;
    let directory = path.parent().ok_or_else(|| reject("handoff has no parent"))?;
    let record: Handoff = fsx::read_private_json(path, MAX_RECORD)?;
    ensure(record.schema == 1, "unsupported handoff schema")?;
    validate_target(&record.target)?;
    let parent = record.target.parent().ok_or_else(|| reject("target has no parent"))?;
    ensure(directory == parent.join(format!(".oc-chan-transaction-{}", record.transaction)), "handoff path is not the controlled UUID directory")?;
    ensure(fsx::private_directory(directory)? == record.transaction_directory, "transaction directory identity changed")?;
    ensure(fsx::parent_directory(parent)? == record.parent_directory, "target parent identity changed")?;
    fsx::expect_identity(&parent.join(".oc-chan-install.lock"), record.lock)?;
    ensure(record.old_bundle.device == record.parent_directory.device && record.new_bundle.device == record.parent_directory.device
        && record.old_bundle != record.new_bundle, "bundle identities must be distinct on the target volume")?;
    ensure(stable_version(&record.expected_version)? > stable_version(&record.old_version)?, "handoff version is not an upgrade")?;
    ensure(is_sha512(&record.old_digest) && is_sha512(&record.new_digest), "invalid journal digest")?;
    ensure(!record.team.is_empty() && record.team.len() <= 64, "invalid journal Team")?;
    crate::signature::executable_name(&record.old_executable)?;
    crate::signature::executable_name(&record.new_executable)?;
    ensure(record.created_at_ms <= fsx::now_ms()?, "handoff creation is in the future")?;
    for process in [&record.parent].into_iter().chain(record.launched.iter()).chain(record.restored.iter()) {
        ensure(process.pid > 1 && process.birth_seconds > 0 && process.executable.is_absolute()
            && process.executable.as_os_str().len() <= 4096, "invalid recorded process identity")?;
    }
    if let Some(launched) = &record.launched {
        ensure(launched.executable == record.target.join("Contents/MacOS").join(&record.new_executable), "new process executable differs from bundle")?;
    }
    if let Some(restored) = &record.restored {
        ensure(restored.executable == record.target.join("Contents/MacOS").join(&record.old_executable), "restored process executable differs from bundle")?;
    }
    Ok(record)
}

pub(crate) fn validate_ready_path(path: &Path, id: uuid::Uuid, bundle: &Path) -> Result<()> {
    validate_target(bundle)?;
    ensure(path == bundle.parent().ok_or_else(|| reject("bundle has no parent"))?
        .join(format!(".oc-chan-transaction-{id}")).join(REQUEST), "readiness request path is not controlled")?;
    let record = load_handoff(&path.with_file_name(RECORD))?;
    ensure(record.transaction == id && record.stage == Stage::VerifyingStartup, "readiness request transaction is not launching")?;
    fsx::expect_identity(bundle, record.new_bundle)
}

pub(crate) fn run_with_runtime<V: BundleValidator + ?Sized, R: Runtime>(path: &Path, validator: &V, runtime: &R) -> Result<()> {
    run_until(path, validator, runtime, Instant::now() + Duration::from_secs(MAX_TRANSACTION_SECONDS))
}

fn run_until<V: BundleValidator + ?Sized, R: Runtime>(path: &Path, validator: &V, runtime: &R, end: Instant) -> Result<()> {
    let initial = load_handoff(path)?;
    let parent = initial.target.parent().ok_or_else(|| reject("missing target parent"))?;
    let lock = fsx::InstallLock::acquire(parent, Some(end.min(Instant::now() + PARENT_EXIT)))?;
    // Re-read under the acquired lock; nothing read while the host owned the
    // lock is used as an unlocked authorization for a rename.
    let record = load_handoff(path)?;
    ensure(lock.identity == record.lock, "lock identity differs from sealed transaction")?;
    let directory = path.parent().ok_or_else(|| reject("missing transaction directory"))?.to_owned();
    let mut tx = Transaction { directory, record, lock, validator, runtime, end };
    match tx.record.stage {
        Stage::Prepared => {
            if fsx::now_ms()?.saturating_sub(tx.record.created_at_ms) > MAX_TRANSACTION_SECONDS * 1000 {
                tx.rollback()?;
                return Err(reject("prepared handoff expired; old application retained"));
            }
            // Reserve the last 20 seconds for stopping the failed generation,
            // restoring its old bundle and restarting that real executable.
            tx.end = end - Duration::from_secs(20);
            let installed = tx.install();
            tx.end = end;
            if let Err(primary) = installed {
                if tx.record.stage == Stage::Committed { return Err(primary); }
                return match tx.rollback() {
                    Ok(()) => Err(reject(format!("installation failed; old application restored: {primary}"))),
                    Err(secondary) => Err(combine(primary, secondary)),
                };
            }
            Ok(())
        }
        Stage::Committed => tx.cleanup_committed(),
        _ => tx.rollback(),
    }
}

pub(crate) struct Transaction<'a, V: BundleValidator + ?Sized, R: Runtime> {
    pub(crate) directory: PathBuf,
    pub(crate) record: Handoff,
    pub(crate) lock: fsx::InstallLock,
    pub(crate) validator: &'a V,
    pub(crate) runtime: &'a R,
    pub(crate) end: Instant,
}
impl<V: BundleValidator + ?Sized, R: Runtime> Transaction<'_, V, R> {
    fn stage_path(&self) -> PathBuf { self.directory.join("stage/OC Chan.app") }
    fn backup_path(&self) -> PathBuf { self.directory.join("backup/OC Chan.app") }
    fn record_path(&self) -> PathBuf { self.directory.join(RECORD) }
    fn guard(&self) -> Result<()> {
        fsx::deadline(self.end)?;
        ensure(fsx::private_directory(&self.directory)? == self.record.transaction_directory, "transaction directory replaced")?;
        let parent = self.record.target.parent().ok_or_else(|| reject("target has no parent"))?;
        ensure(fsx::parent_directory(parent)? == self.record.parent_directory, "target parent replaced")?;
        self.lock.check(parent)?;
        // Stage and backup are structural fixed subdirectories, never symlinks.
        for child in ["stage", "backup"] {
            let path = self.directory.join(child);
            if self.record.stage == Stage::Committed && !path_exists(&path)? { continue; }
            fsx::real_path(&path)?;
            ensure(fs::metadata(&path).context("stat bundle container")?.is_dir(), "bundle container is not a directory")?;
        }
        Ok(())
    }
    pub(crate) fn save(&mut self, stage: Stage) -> Result<()> {
        self.guard()?;
        self.record.stage = stage;
        fsx::atomic_json(&self.record_path(), &self.record, MAX_RECORD as usize)?;
        fsx::sync_directory(self.record.target.parent().ok_or_else(|| reject("target has no parent"))?)
    }
    fn verify(&self, path: &Path, identity: FileIdentity, old: bool) -> Result<()> {
        self.guard()?;
        fsx::expect_identity(path, identity)?;
        let validated = self.validator.validate(path, self.end)?;
        let (version, digest, executable) = if old {
            (&self.record.old_version, &self.record.old_digest, &self.record.old_executable)
        } else { (&self.record.expected_version, &self.record.new_digest, &self.record.new_executable) };
        ensure(&validated.version == version && &validated.digest == digest && validated.team == self.record.team
            && &validated.executable == executable, "registered bundle contents or signature changed")?;
        fsx::expect_identity(path, identity)
    }
    fn move_bundle(&self, from: &Path, to: &Path, identity: FileIdentity) -> Result<()> {
        self.guard()?;
        fsx::expect_identity(from, identity)?;
        ensure(!path_exists(to)?, "rename destination contains an unexpected identity")?;
        fsx::rename_exclusive(from, to)?;
        fsx::sync_directory(from.parent().ok_or_else(|| reject("rename source has no parent"))?)?;
        fsx::sync_directory(to.parent().ok_or_else(|| reject("rename target has no parent"))?)?;
        fsx::expect_identity(to, identity)
    }
    pub(crate) fn install(&mut self) -> Result<()> {
        let operation_end = self.end;
        self.verify(&self.record.target, self.record.old_bundle, true)?;
        self.verify(&self.stage_path(), self.record.new_bundle, false)?;
        ensure(fsx::optional_identity(&self.backup_path())?.is_none(), "backup position is already occupied")?;
        self.save(Stage::WaitingParent)?;
        let wait_end = operation_end.min(Instant::now() + PARENT_EXIT);
        while self.record.parent.live()? {
            fsx::deadline(wait_end)?;
            std::thread::sleep(Duration::from_millis(50));
        }
        self.verify(&self.record.target, self.record.old_bundle, true)?;
        self.verify(&self.stage_path(), self.record.new_bundle, false)?;
        self.save(Stage::BackupIntent)?;
        self.move_bundle(&self.record.target, &self.backup_path(), self.record.old_bundle)?;
        self.save(Stage::OldBackedUp)?;
        self.save(Stage::InstallIntent)?;
        self.move_bundle(&self.stage_path(), &self.record.target, self.record.new_bundle)?;
        self.save(Stage::NewInstalled)?;
        self.verify(&self.record.target, self.record.new_bundle, false)?;
        self.save(Stage::VerifyingStartup)?;
        let executable = self.record.target.join("Contents/MacOS").join(&self.record.new_executable);
        let request_path = self.directory.join(REQUEST);
        let args = [OsString::from(format!("{READY_ARGUMENT}{}", request_path.display()))];
        let child = self.runtime.launch(&executable, &args)?;
        let sealed_request = (|| -> Result<ReadyRequest> {
            let issued_at = fsx::now_ms()?;
            self.record.launched = Some(child.identity.clone());
            self.record.launch_at_ms = Some(issued_at);
            self.save(Stage::VerifyingStartup)?;
            let request = ReadyRequest {
                schema: 1, transaction: self.record.transaction, bundle: self.record.target.clone(),
                version: self.record.expected_version.clone(), issued_at_ms: issued_at,
                expires_at_ms: issued_at + READY_TIMEOUT.as_millis() as u64, process: child.identity.clone(),
            };
            fsx::publish_private_json(&request_path, &request, 16 * 1024)?;
            Ok(request)
        })();
        let request = match sealed_request {
            Ok(request) => request,
            Err(error) => return match child.cancel() { Ok(()) => Err(error), Err(cleanup) => Err(combine(error, cleanup)) },
        };
        let launched = child.release()?;
        self.wait_exec(&launched, operation_end.min(Instant::now() + Duration::from_secs(3)))?;
        #[cfg(test)]
        self.runtime.on_launched(&request_path)?;
        self.await_receipt(&request, operation_end.min(Instant::now() + READY_TIMEOUT))?;
        self.verify(&self.record.target, self.record.new_bundle, false)?;
        self.save(Stage::Committed)?;
        self.cleanup_committed()
    }
    fn wait_exec(&self, expected: &ProcessIdentity, end: Instant) -> Result<()> {
        loop {
            fsx::deadline(end)?;
            let actual = ProcessIdentity::inspect(expected.pid)?.ok_or_else(|| crate::process::exit_error(expected.pid, "application exited before exec"))?;
            ensure(expected.same_birth(&actual), "launched PID identity changed")?;
            if actual.executable == expected.executable { return Ok(()); }
            let helper = ProcessIdentity::current()?.executable;
            ensure(actual.executable == helper, "gated child exec'd an unexpected executable")?;
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    pub(crate) fn await_receipt(&self, expected: &ReadyRequest, end: Instant) -> Result<()> {
        let receipt_path = self.directory.join(RECEIPT);
        loop {
            fsx::deadline(end)?;
            ensure(expected.process.live()?, "new application exited before readiness")?;
            if path_exists(&receipt_path)? {
                let receipt: ReadyReceipt = fsx::read_private_json(&receipt_path, 16 * 1024)?;
                ensure(receipt.request == *expected && receipt.checked_at_ms >= expected.issued_at_ms
                    && receipt.checked_at_ms <= expected.expires_at_ms && receipt.checked_at_ms <= fsx::now_ms()?
                    && fsx::now_ms()? <= expected.expires_at_ms, "forged, late or mismatched readiness receipt")?;
                receipt.evidence.validate(&self.record.expected_version)?;
                if !self.runtime.ready_instance(&expected.process, &self.record.target)? {
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
                let survive_until = Instant::now() + SURVIVAL;
                ensure(survive_until < end, "receipt arrived too late for sustained liveness verification")?;
                while Instant::now() < survive_until {
                    ensure(self.runtime.ready_instance(&expected.process, &self.record.target)?, "new application did not survive readiness")?;
                    std::thread::sleep(Duration::from_millis(50));
                }
                ensure(self.runtime.ready_instance(&expected.process, &self.record.target)?, "new application exited after readiness")?;
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl<V: BundleValidator + ?Sized, R: Runtime> Transaction<'_, V, R> {
    /// Rollback is driven by registered inode placement, not an optimistic stage
    /// counter. Every rename accepts both the before and after crash window.
    pub(crate) fn rollback(&mut self) -> Result<()> {
        self.guard()?;
        ensure(self.record.stage != Stage::Committed, "cannot roll back a committed transaction")?;
        let target = fsx::optional_identity(&self.record.target)?;
        let staged = fsx::optional_identity(&self.stage_path())?;
        let backup = fsx::optional_identity(&self.backup_path())?;
        let old = self.record.old_bundle;
        let new = self.record.new_bundle;
        let before = target == Some(old) && staged == Some(new) && backup.is_none();
        let backed_up = target.is_none() && staged == Some(new) && backup == Some(old);
        let installed = target == Some(new) && staged.is_none() && backup == Some(old);
        ensure(before || backed_up || installed, "unknown or impossible bundle identity combination; preserving both locations")?;
        match self.record.stage {
            Stage::Prepared => ensure(before, "prepared transaction has unexpected rename effects")?,
            Stage::WaitingParent | Stage::BackupIntent => ensure(before || backed_up, "backup stage has unexpected new target")?,
            Stage::OldBackedUp | Stage::InstallIntent => ensure(backed_up || installed, "install stage has unexpected old target")?,
            Stage::NewInstalled | Stage::VerifyingStartup => ensure(installed, "new-installed stage has inconsistent positions")?,
            Stage::RolledBack => ensure(before, "rolled-back state has inconsistent positions")?,
            Stage::RollingBack => {},
            Stage::Committed => return Err(reject("committed transaction cannot roll back")),
        }
        // Recovery never executes or trusts the candidate. Only validate the old
        // bundle before restoring or launching it. A damaged candidate is kept.
        let old_path = if before { self.record.target.clone() } else { self.backup_path() };
        self.verify(&old_path, old, true)?;
        self.record.rollback_intent = Some(RollbackIntent::StopNew);
        self.save(Stage::RollingBack)?;
        if let Some(launched) = &self.record.launched {
            let gate_executable = ProcessIdentity::current()?.executable;
            stop_exact(launched, &gate_executable, self.end)?;
        }
        if installed {
            self.record.rollback_intent = Some(RollbackIntent::MoveNewToStage);
            self.save(Stage::RollingBack)?;
            self.move_bundle(&self.record.target, &self.stage_path(), new)?;
            self.save(Stage::RollingBack)?;
        }
        if !before {
            self.record.rollback_intent = Some(RollbackIntent::RestoreOld);
            self.save(Stage::RollingBack)?;
            self.move_bundle(&self.backup_path(), &self.record.target, old)?;
            self.save(Stage::RollingBack)?;
        }
        self.verify(&self.record.target, old, true)?;
        self.record.rollback_intent = Some(RollbackIntent::RestartOld);
        self.save(Stage::RollingBack)?;
        let parent_alive = match ProcessIdentity::inspect(self.record.parent.pid)? {
            None => false,
            Some(actual) => {
                ensure(self.record.parent.same_birth(&actual) && actual.executable == self.record.parent.executable,
                    "parent identity changed during recovery")?;
                true
            }
        };
        if !parent_alive { self.restart_old()?; }
        self.record.rollback_intent = None;
        self.save(Stage::RolledBack)
        // Keep the rejected candidate, journal, receipt and errors for diagnosis.
        // A later explicit recovery remains idempotent; no evidence is deleted.
    }

    fn restart_old(&mut self) -> Result<()> {
        if let Some(restored) = &self.record.restored {
            if let Some(actual) = ProcessIdentity::inspect(restored.pid)? {
                ensure(restored.same_birth(&actual), "restored PID was reused")?;
                if actual.executable == restored.executable {
                    let ready_end = self.end.min(Instant::now() + Duration::from_secs(10));
                    while !self.runtime.ready_instance(restored, &self.record.target)? {
                        ensure(restored.live()?, "restored application exited before readiness")?;
                        fsx::deadline(ready_end)?;
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    return Ok(());
                }
                // Journal publication can precede exec. A surviving gated fork
                // is a legal crash window, not an unknown application instance.
                let gate = ProcessIdentity::current()?.executable;
                ensure(actual.executable == gate, "unexpected restored executable")?;
                stop_exact(restored, &gate, self.end)?;
            }
        }
        let executable = self.record.target.join("Contents/MacOS").join(&self.record.old_executable);
        let child = self.runtime.launch(&executable, &[])?;
        self.record.restored = Some(child.identity.clone());
        if let Err(error) = self.save(Stage::RollingBack) {
            return match child.cancel() { Ok(()) => Err(error), Err(cleanup) => Err(combine(error, cleanup)) };
        }
        let restored = child.release()?;
        let end = self.end.min(Instant::now() + Duration::from_secs(10));
        if let Err(error) = self.wait_exec(&restored, end) {
            return match stop_exact(&restored, &ProcessIdentity::current()?.executable, self.end) {
                Ok(()) => Err(error), Err(cleanup) => Err(combine(error, cleanup)),
            };
        }
        while !self.runtime.ready_instance(&restored, &self.record.target)? {
            if !restored.live()? {
                let error = reject("restored application exited");
                return match stop_exact(&restored, &ProcessIdentity::current()?.executable, self.end) {
                    Ok(()) => Err(error), Err(cleanup) => Err(combine(error, cleanup)),
                };
            }
            fsx::deadline(end)?;
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(())
    }

    fn cleanup_committed(&mut self) -> Result<()> {
        self.guard()?;
        ensure(self.record.stage == Stage::Committed, "backup cleanup requires a durable commit")?;
        ensure(fsx::optional_identity(&self.stage_path())?.is_none(), "committed transaction has an unexpected stage bundle")?;
        self.verify(&self.record.target, self.record.new_bundle, false)?;
        let backup = self.backup_path();
        if let Some(identity) = fsx::optional_identity(&backup)? {
            ensure(identity == self.record.old_bundle, "committed backup identity changed")?;
            // A previous committed cleanup may have removed some sealed resources;
            // re-validating the partially deleted old signature would incorrectly
            // block recovery. Only the registered old root can be deleted here.
            remove_tree(&backup)?;
        }
        // Limit and check owned metadata before removing the private transaction.
        // Unknown files/subdirectories retain the whole scene and cause failure.
        let mut count = 0usize;
        let mut removable = Vec::new();
        for entry in fs::read_dir(&self.directory).context("enumerate committed transaction")? {
            count += 1;
            ensure(count <= 128, "transaction metadata count exceeded")?;
            let entry = entry.context("read transaction metadata entry")?;
            let name = entry.file_name();
            let text = name.to_str().ok_or_else(|| reject("invalid transaction metadata name"))?;
            if text == "stage" || text == "backup" {
                let mut entries = fs::read_dir(entry.path()).context("inspect empty bundle container")?;
                ensure(entries.next().is_none(), "committed bundle container is not empty")?;
            } else {
                ensure(matches!(text, RECORD | REQUEST | RECEIPT | "helper.log")
                    || (text.starts_with(".record-") || text.starts_with(".receipt-")) && text.ends_with(".pending"),
                    "unknown transaction metadata; preserving evidence")?;
                let file = fsx::private_file(&entry.path())?;
                ensure(file.metadata().context("stat committed metadata")?.len() <= MAX_RECORD, "oversized committed metadata")?;
            }
            if text != RECORD { removable.push((entry.path(), text == "stage" || text == "backup")); }
        }
        // Keep the durable commit journal until every other entry is removed.
        // A crash after unlinking the journal can leave only an empty directory.
        for (path, directory) in removable {
            if directory { fs::remove_dir(&path).context("remove committed bundle container")?; }
            else { fs::remove_file(&path).context("remove committed metadata")?; }
        }
        fsx::sync_directory(&self.directory)?;
        fs::remove_file(self.record_path()).context("remove final committed journal")?;
        fsx::sync_directory(&self.directory)?;
        fs::remove_dir(&self.directory).context("remove empty committed transaction")?;
        fsx::sync_directory(self.record.target.parent().ok_or_else(|| reject("target has no parent"))?)
    }
}

#[cfg(test)]
impl PreparedInstallation {
    pub(crate) fn detach_for_test(mut self) -> PathBuf {
        self.handed_off = true;
        self.handoff.clone()
    }
}
