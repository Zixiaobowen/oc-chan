use super::*;
use crate::{filesystem as fsx, process::{GatedLaunch, Runtime, stop_exact}, signature::{BundleValidator, ValidatedBundle}, transaction::{prepare_with_validator, run_with_runtime, Transaction}};
use std::{cell::RefCell, collections::BTreeMap, ffi::OsString, fs, os::unix::fs::{symlink, PermissionsExt}, path::{Path, PathBuf}, process::{Command, Stdio}, time::{Duration, Instant}};

/// Test-only validator: an explicit isolated fixture trust root. Production
/// entry points cannot select this validator via JSON, environment or CLI.
struct FixtureValidator;
impl BundleValidator for FixtureValidator {
    fn validate(&self, path: &Path, _end: Instant) -> Result<ValidatedBundle> {
        let version = fs::read_to_string(path.join("Contents/Resources/version")).context("read fixture version")?;
        Ok(ValidatedBundle { version, team: "TESTTEAM01".into(), executable: "fixture".into(), digest: fsx::bundle_digest(path)? })
    }
}
struct Fixture {
    _temporary: tempfile::TempDir,
    target: PathBuf,
    handoff: PathBuf,
    directory: PathBuf,
}
impl Fixture {
    fn create() -> Self { Self::with_broken_binaries(false, false) }
    fn with_broken_binaries(old: bool, new: bool) -> Self {
        let temporary = tempfile::tempdir().expect("private fixture root");
        // macOS temporary directories include /var -> /private/var; use the real
        // path because the production path verifier deliberately rejects aliases.
        let root = fs::canonicalize(temporary.path()).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let target = root.join("OC Chan.app");
        let candidate = root.join("candidate.app");
        for (path, version) in [(&target, "1.0.0"), (&candidate, "2.0.0")] {
            fs::create_dir_all(path.join("Contents/MacOS")).unwrap();
            fs::create_dir_all(path.join("Contents/Resources")).unwrap();
            fs::copy("/bin/sleep", path.join("Contents/MacOS/fixture")).unwrap();
            // Copied Apple platform binaries retain launch constraints and are
            // killed by macOS outside the sealed system location. Give only this
            // isolated test executable an ad-hoc signature, before digesting it.
            #[cfg(target_os = "macos")]
            crate::process::bounded_command(Path::new("/usr/bin/codesign"),
                &["--force".into(), "--sign".into(), "-".into(), "--timestamp=none".into(), path.join("Contents/MacOS/fixture").into_os_string()],
                Instant::now() + Duration::from_secs(5)).unwrap();
            if (path == &target && old) || (path == &candidate && new) {
                fs::write(path.join("Contents/MacOS/fixture"), b"invalid executable fixture\n").unwrap();
            }
            fs::write(path.join("Contents/Resources/version"), version).unwrap();
        }
        let digest = fsx::bundle_digest(&candidate).unwrap();
        let prepared = prepare_with_validator(PrepareRequest {
            target: target.clone(), candidate, expected_version: "2.0.0".into(), candidate_sha512: digest,
            parent: ProcessIdentity::current().unwrap(),
        }, &FixtureValidator).unwrap();
        let handoff = prepared.detach_for_test();
        let directory = handoff.parent().unwrap().to_owned();
        Self { _temporary: temporary, target, handoff, directory }
    }
    fn record(&self) -> Handoff { fsx::read_private_json(&self.handoff, 64 * 1024).unwrap() }
    fn save(&self, record: &Handoff) { fsx::atomic_json(&self.handoff, record, 64 * 1024).unwrap(); }
    fn stage(&self) -> PathBuf { self.directory.join("stage/OC Chan.app") }
    fn backup(&self) -> PathBuf { self.directory.join("backup/OC Chan.app") }
    fn dead_parent(&self) {
        let mut child = Command::new("/bin/sleep").arg("30").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let identity = ProcessIdentity::inspect(child.id() as i32).unwrap().unwrap();
        child.kill().unwrap(); child.wait().unwrap();
        let mut record = self.record(); record.parent = identity; self.save(&record);
    }
    fn move_old(&self) { fsx::rename_exclusive(&self.target, &self.backup()).unwrap(); }
    fn move_new(&self) { fsx::rename_exclusive(&self.stage(), &self.target).unwrap(); }
    fn assert_restored(&self) {
        let record = self.record();
        assert_eq!(fsx::identity(&self.target).unwrap(), record.old_bundle);
        assert_eq!(fsx::identity(&self.stage()).unwrap(), record.new_bundle);
        assert!(!self.backup().exists());
        assert_eq!(record.stage, Stage::RolledBack);
    }
}
#[derive(Clone, Copy)]
enum ReceiptMode { Good, FakeUuid, Late, NoReceipt, FailNewLaunch, FailAllLaunches }
struct TestRuntime { mode: ReceiptMode, children: RefCell<Vec<ProcessIdentity>> }
impl TestRuntime {
    fn new(mode: ReceiptMode) -> Self { Self { mode, children: RefCell::new(Vec::new()) } }
}
impl Runtime for TestRuntime {
    fn launch(&self, executable: &Path, arguments: &[OsString]) -> Result<GatedLaunch> {
        if matches!(self.mode, ReceiptMode::FailAllLaunches)
            || matches!(self.mode, ReceiptMode::FailNewLaunch) && !arguments.is_empty() {
            return Err(reject("injected real launch admission failure"));
        }
        // A real native /bin/sleep executable is copied into each fixture bundle;
        // this tests process birth, gated exec, stop/reap and durable file effects.
        let child = GatedLaunch::create(executable, &["30".into()])?;
        self.children.borrow_mut().push(child.identity.clone());
        Ok(child)
    }
    fn ready_instance(&self, process: &ProcessIdentity, _bundle: &Path) -> Result<bool> { process.live() }
    fn on_launched(&self, request_path: &Path) -> Result<()> {
        if matches!(self.mode, ReceiptMode::NoReceipt) { return Ok(()); }
        let mut request: ReadyRequest = fsx::read_private_json(request_path, 16 * 1024)?;
        let checked_at_ms = match self.mode {
            ReceiptMode::FakeUuid => { request.transaction = uuid::Uuid::new_v4(); fsx::now_ms()? }
            ReceiptMode::Late => request.expires_at_ms + 1,
            _ => fsx::now_ms()?,
        };
        fsx::publish_private_json(&request_path.with_file_name("receipt.json"),
            &ReadyReceipt { request, checked_at_ms, evidence: evidence() }, 16 * 1024)
    }
}
impl Drop for TestRuntime {
    fn drop(&mut self) {
        for child in self.children.borrow().iter() {
            // The fixture target can have moved during rollback; only invoke the
            // real stopper while the registered pid/birth is still alive.
            if ProcessIdentity::inspect(child.pid).unwrap().is_some() {
                stop_exact(child, &ProcessIdentity::current().unwrap().executable, Instant::now() + Duration::from_secs(5)).unwrap();
            }
        }
    }
}
fn evidence() -> ReadyEvidence {
    let mut partitions = BTreeMap::new();
    for name in ["agents", "schedules", "events"] {
        partitions.insert(name.into(), PartitionEvidence { enabled: true, installed: true, state: PartitionReadiness::Ready, reason: None });
    }
    partitions.insert("system".into(), PartitionEvidence { enabled: false, installed: false, state: PartitionReadiness::NotInstalled, reason: None });
    ReadyEvidence { host_version: "2.0.0".into(), renderer_entry: "fixture-react-commit-7".into(), renderer_committed: true,
        ipc_round_trip: true, partitions, hermes_history: HistoryReadiness::Unavailable, history_entries: 0,
        history_reason: Some("no Hermes history database in isolated fixture".into()) }
}

#[test]
fn normal_success_requires_receipt_and_two_seconds_before_deleting_backup() {
    let fixture = Fixture::create();
    fixture.dead_parent();
    let record = fixture.record();
    let runtime = TestRuntime::new(ReceiptMode::Good);
    let started = Instant::now();
    run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap();
    assert!(started.elapsed() >= Duration::from_secs(2));
    assert_eq!(fsx::identity(&fixture.target).unwrap(), record.new_bundle);
    assert!(!fixture.directory.exists(), "committed metadata and old bundle removed only after receipt/liveness");
}

#[test]
fn backup_rename_before_completion_record_recovers_idempotently() {
    for stage in [Stage::WaitingParent, Stage::BackupIntent, Stage::OldBackedUp, Stage::InstallIntent] {
        let fixture = Fixture::create();
        let mut record = fixture.record(); record.stage = stage; fixture.save(&record);
        fixture.move_old(); // simulate crash immediately after rename, before record/fsync
        let runtime = TestRuntime::new(ReceiptMode::Good);
        run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap();
        fixture.assert_restored();
        run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap();
        fixture.assert_restored();
    }
}

#[test]
fn install_rename_before_completion_record_recovers_without_running_candidate() {
    for stage in [Stage::OldBackedUp, Stage::InstallIntent, Stage::NewInstalled, Stage::VerifyingStartup] {
        let fixture = Fixture::create();
        let mut record = fixture.record(); record.stage = stage; fixture.save(&record);
        fixture.move_old(); fixture.move_new();
        let runtime = TestRuntime::new(ReceiptMode::Good);
        run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap();
        fixture.assert_restored();
        assert!(runtime.children.borrow().is_empty(), "live old parent means recovery must not launch another app");
    }
}

#[test]
fn rollback_renames_before_record_recover_from_all_three_positions() {
    for placement in 0..3 {
        let fixture = Fixture::create();
        let mut record = fixture.record(); record.stage = Stage::RollingBack;
        record.rollback_intent = Some(if placement == 2 { RollbackIntent::MoveNewToStage } else { RollbackIntent::RestoreOld });
        fixture.save(&record);
        if placement >= 1 { fixture.move_old(); }
        if placement == 2 { fixture.move_new(); }
        let runtime = TestRuntime::new(ReceiptMode::Good);
        run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap();
        fixture.assert_restored();
    }
}

#[test]
fn unfsynced_record_has_both_legal_durable_outcomes() {
    for durable_stage in [Stage::BackupIntent, Stage::OldBackedUp] {
        let fixture = Fixture::create();
        let mut record = fixture.record(); record.stage = Stage::BackupIntent; fixture.save(&record);
        fixture.move_old();
        record.stage = Stage::OldBackedUp;
        // The incomplete record is deliberately written without fsync. Recovery
        // must ignore it if the old durable name survived a power loss.
        let pending = fixture.directory.join(".record-test.pending");
        let mut file = fsx::create_private(&pending).unwrap();
        use std::io::Write;
        file.write_all(&serde_json::to_vec(&record).unwrap()).unwrap(); drop(file);
        if durable_stage == Stage::OldBackedUp {
            fs::rename(&pending, &fixture.handoff).unwrap(); // publication without directory fsync
        }
        let runtime = TestRuntime::new(ReceiptMode::Good);
        run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap();
        fixture.assert_restored();
    }
}

#[test]
fn unknown_target_identity_preserves_both_registered_bundles() {
    let fixture = Fixture::create();
    let mut record = fixture.record(); record.stage = Stage::InstallIntent; fixture.save(&record);
    fixture.move_old();
    fs::create_dir(&fixture.target).unwrap();
    let runtime = TestRuntime::new(ReceiptMode::Good);
    assert!(run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).is_err());
    assert_eq!(fsx::identity(&fixture.backup()).unwrap(), record.old_bundle);
    assert_eq!(fsx::identity(&fixture.stage()).unwrap(), record.new_bundle);
    assert!(fixture.target.is_dir());
}

#[test]
fn fake_and_late_receipts_stop_new_process_and_restore_old() {
    for mode in [ReceiptMode::FakeUuid, ReceiptMode::Late] {
        let fixture = Fixture::create(); fixture.dead_parent();
        let runtime = TestRuntime::new(mode);
        run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap_err();
        fixture.assert_restored();
        let launched = fixture.record().launched.unwrap();
        assert!(ProcessIdentity::inspect(launched.pid).unwrap().is_none());
        assert!(fixture.record().restored.unwrap().live().unwrap());
    }
}

#[test]
fn launch_failure_restores_and_restarts_old_executable() {
    let fixture = Fixture::create(); fixture.dead_parent();
    let runtime = TestRuntime::new(ReceiptMode::FailNewLaunch);
    let result = run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime);
    assert!(result.is_err()); fixture.assert_restored();
    assert!(fixture.record().restored.unwrap().live().unwrap());
}

#[test]
fn restoration_launch_failure_retains_both_bundles_and_aggregates_error() {
    let fixture = Fixture::create(); fixture.dead_parent();
    let runtime = TestRuntime::new(ReceiptMode::FailAllLaunches);
    let result = run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap_err();
    assert!(matches!(result, Error::Aggregate { .. }));
    let record = fixture.record();
    assert_eq!(record.stage, Stage::RollingBack);
    assert_eq!(fsx::identity(&fixture.target).unwrap(), record.old_bundle);
    assert_eq!(fsx::identity(&fixture.stage()).unwrap(), record.new_bundle);
    assert!(fixture.handoff.exists());
}

#[test]
fn missing_receipt_respects_supplied_deadline() {
    let fixture = Fixture::create();
    let runtime = TestRuntime::new(ReceiptMode::NoReceipt);
    let executable = fixture.target.join("Contents/MacOS/fixture");
    let launched = runtime.launch(&executable, &[]).unwrap().release().unwrap();
    let end = Instant::now() + Duration::from_secs(2);
    while !launched.live().unwrap_or(false) && Instant::now() < end { std::thread::yield_now(); }
    let record = fixture.record();
    let lock = fsx::InstallLock::acquire(fixture.target.parent().unwrap(), None).unwrap();
    let tx = Transaction { directory: fixture.directory.clone(), record, lock, validator: &FixtureValidator, runtime: &runtime,
        end: Instant::now() + Duration::from_secs(2) };
    let now = fsx::now_ms().unwrap();
    let request = ReadyRequest { schema: 1, transaction: tx.record.transaction, bundle: fixture.target.clone(), version: "2.0.0".into(),
        issued_at_ms: now, expires_at_ms: now + 45_000, process: launched };
    assert!(tx.await_receipt(&request, Instant::now() + Duration::from_millis(100)).is_err());
}

#[test]
fn lock_competition_and_replaced_parent_are_rejected() {
    let fixture = Fixture::create();
    let lock = fsx::InstallLock::acquire(fixture.target.parent().unwrap(), None).unwrap();
    assert!(fsx::InstallLock::acquire(fixture.target.parent().unwrap(), None).is_err());
    drop(lock);
    let mut record = fixture.record(); record.parent.birth_fraction += 1; fixture.save(&record);
    let runtime = TestRuntime::new(ReceiptMode::Good);
    assert!(run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).is_err());
    assert_eq!(fsx::identity(&fixture.target).unwrap(), record.old_bundle);
}

#[test]
fn handoff_rejects_symlinks_hardlinks_permissions_and_unknown_fields() {
    let fixture = Fixture::create();
    let runtime = TestRuntime::new(ReceiptMode::Good);
    fs::set_permissions(&fixture.handoff, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).is_err());
    fs::set_permissions(&fixture.handoff, fs::Permissions::from_mode(0o600)).unwrap();
    let alias = fixture.directory.join("alias"); fs::hard_link(&fixture.handoff, &alias).unwrap();
    assert!(run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).is_err());
    fs::remove_file(&alias).unwrap();
    let original = fixture.directory.join("original"); fs::rename(&fixture.handoff, &original).unwrap();
    symlink(&original, &fixture.handoff).unwrap();
    assert!(run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).is_err());
    fs::remove_file(&fixture.handoff).unwrap(); fs::rename(original, &fixture.handoff).unwrap();
    let mut value = serde_json::to_value(fixture.record()).unwrap(); value["command"] = serde_json::json!("arbitrary script");
    fsx::atomic_json(&fixture.handoff, &value, 64 * 1024).unwrap();
    assert!(run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).is_err());
}

#[test]
fn tampered_candidate_is_rejected_and_never_started() {
    let fixture = Fixture::create(); fixture.dead_parent();
    fs::write(fixture.stage().join("Contents/Resources/version"), "2.0.1").unwrap();
    let runtime = TestRuntime::new(ReceiptMode::Good);
    assert!(run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).is_err());
    fixture.assert_restored();
    assert!(fixture.record().launched.is_none());
}

#[test]
fn readiness_rejects_installed_failed_system_and_fake_renderer() {
    let mut value = evidence();
    value.partitions.insert("system".into(), PartitionEvidence { installed: true, enabled: true,
        state: PartitionReadiness::Unavailable, reason: Some("plugin process failed".into()) });
    assert!(value.validate("2.0.0").is_err());
    let mut value = evidence(); value.renderer_committed = false; assert!(value.validate("2.0.0").is_err());
    assert!(evidence().validate("2.0.0").is_ok());
}

#[test]
fn gated_process_cannot_exec_before_durable_identity_and_drop_reaps_it() {
    let executable = fs::canonicalize("/bin/sleep").unwrap();
    let gate = GatedLaunch::create(&executable, &["30".into()]).unwrap();
    let actual = ProcessIdentity::inspect(gate.identity.pid).unwrap().unwrap();
    assert!(actual.same_birth(&gate.identity));
    assert_ne!(actual.executable, executable);
    assert_eq!(unsafe { libc::getpgid(gate.identity.pid) }, gate.identity.pid);
    let pid = gate.identity.pid;
    drop(gate);
    assert!(ProcessIdentity::inspect(pid).unwrap().is_none());
}

#[cfg(target_os = "macos")]
#[test]
fn stop_exact_reaps_zombie_before_declaring_process_group_absent() {
    let executable = fs::canonicalize("/bin/sleep").unwrap();
    let process = GatedLaunch::create(&executable, &["30".into()]).unwrap().release().unwrap();
    assert_eq!(unsafe { libc::kill(process.pid, libc::SIGKILL) }, 0);
    // WNOWAIT observes termination without reaping: keep the zombie's group
    // present deterministically, rather than depending on the SIGTERM race.
    let mut status = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
    assert_eq!(unsafe { libc::waitid(libc::P_PID, process.pid as _, status.as_mut_ptr(),
        libc::WEXITED | libc::WNOWAIT) }, 0);
    assert!(ProcessIdentity::inspect(process.pid).unwrap().is_none());
    assert!(crate::process::group_exists(process.pid).unwrap());
    stop_exact(&process, &ProcessIdentity::current().unwrap().executable,
        Instant::now() + Duration::from_secs(5)).unwrap();
    assert!(!crate::process::group_exists(process.pid).unwrap());
    let mut status = 0;
    assert_eq!(unsafe { libc::waitpid(process.pid, &mut status, libc::WNOHANG) }, -1);
    assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::ECHILD));
}

#[test]
fn bundle_symlink_escape_and_insufficient_space_are_rejected() {
    let fixture = Fixture::create();
    symlink("../../../../etc/passwd", fixture.stage().join("Contents/Resources/escape")).unwrap();
    assert!(fsx::bundle_digest(&fixture.stage()).is_err());
    assert!(fsx::check_space(fixture.target.parent().unwrap(), u64::MAX).is_err());
}

#[test]
fn durable_commit_keeps_new_target_and_finishes_partial_old_cleanup() {
    let fixture = Fixture::create();
    let mut record = fixture.record();
    fixture.move_old(); fixture.move_new();
    record.stage = Stage::Committed; fixture.save(&record);
    fs::remove_file(fixture.backup().join("Contents/Resources/version")).unwrap();
    let runtime = TestRuntime::new(ReceiptMode::Good);
    run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap();
    assert_eq!(fsx::identity(&fixture.target).unwrap(), record.new_bundle);
    assert!(!fixture.directory.exists());
}

#[test]
fn commit_record_without_fsync_recovers_either_durable_name() {
    for commit_survived in [false, true] {
        let fixture = Fixture::create();
        let mut record = fixture.record();
        fixture.move_old(); fixture.move_new();
        record.stage = Stage::VerifyingStartup; fixture.save(&record);
        record.stage = Stage::Committed;
        let pending = fixture.directory.join(".record-commit.pending");
        use std::io::Write;
        let mut file = fsx::create_private(&pending).unwrap();
        file.write_all(&serde_json::to_vec(&record).unwrap()).unwrap(); drop(file);
        if commit_survived { fs::rename(&pending, &fixture.handoff).unwrap(); }
        let runtime = TestRuntime::new(ReceiptMode::Good);
        run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap();
        if commit_survived {
            assert_eq!(fsx::identity(&fixture.target).unwrap(), record.new_bundle);
            assert!(!fixture.directory.exists());
        } else { fixture.assert_restored(); }
    }
}

#[test]
fn live_uncommitted_process_is_stopped_and_reaped_before_restore() {
    let fixture = Fixture::create();
    fixture.move_old(); fixture.move_new();
    let runtime = TestRuntime::new(ReceiptMode::Good);
    let process = runtime.launch(&fixture.target.join("Contents/MacOS/fixture"), &[]).unwrap().release().unwrap();
    let end = Instant::now() + Duration::from_secs(3);
    loop {
        if process.live().unwrap_or(false) { break; }
        assert!(Instant::now() < end); std::thread::yield_now();
    }
    let mut record = fixture.record(); record.stage = Stage::VerifyingStartup; record.launched = Some(process.clone()); fixture.save(&record);
    run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap();
    fixture.assert_restored();
    assert!(ProcessIdentity::inspect(process.pid).unwrap().is_none());
}

#[test]
fn written_backup_intent_without_rename_preserves_old_target() {
    for stage in [Stage::WaitingParent, Stage::BackupIntent] {
        let fixture = Fixture::create();
        let mut record = fixture.record(); record.stage = stage; fixture.save(&record);
        let runtime = TestRuntime::new(ReceiptMode::Good);
        run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap();
        fixture.assert_restored();
        assert!(runtime.children.borrow().is_empty());
    }
}

#[test]
fn unknown_backup_prevents_recovery_without_deleting_candidate() {
    let fixture = Fixture::create();
    let mut record = fixture.record(); record.stage = Stage::NewInstalled;
    fixture.move_old(); fixture.move_new(); fixture.save(&record);
    let saved = fixture.directory.join("preserved-old.app"); fs::rename(fixture.backup(), &saved).unwrap();
    fs::create_dir(fixture.backup()).unwrap();
    let runtime = TestRuntime::new(ReceiptMode::Good);
    assert!(run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).is_err());
    assert_eq!(fsx::identity(&fixture.target).unwrap(), record.new_bundle);
    assert_eq!(fsx::identity(&saved).unwrap(), record.old_bundle);
    assert!(fixture.backup().is_dir());
}

#[test]
fn committed_cleanup_recovers_after_container_directories_were_removed() {
    let fixture = Fixture::create();
    let mut record = fixture.record(); fixture.move_old(); fixture.move_new();
    record.stage = Stage::Committed; fixture.save(&record);
    fs::remove_dir_all(fixture.directory.join("backup")).unwrap();
    fs::remove_dir(fixture.directory.join("stage")).unwrap();
    let runtime = TestRuntime::new(ReceiptMode::Good);
    run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap();
    assert_eq!(fsx::identity(&fixture.target).unwrap(), record.new_bundle);
    assert!(!fixture.directory.exists());
}

#[test]
fn fixed_command_timeout_and_output_limit_report_failure_after_reaping() {
    use crate::process::bounded_command;
    let timeout = bounded_command(Path::new("/bin/sleep"), &["10".into()], Instant::now() + Duration::from_millis(50));
    assert!(timeout.unwrap_err().to_string().contains("deadline"));
    let overflow = bounded_command(Path::new("/usr/bin/yes"), &[], Instant::now() + Duration::from_secs(2));
    assert!(overflow.unwrap_err().to_string().contains("128 KiB"));
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn production_validator_rejects_a_real_adhoc_signed_arm64_bundle() {
    let fixture = Fixture::create();
    fs::copy("/bin/sleep", fixture.target.join("Contents/Resources/oc-installer")).unwrap();
    let mut info = plist::Dictionary::new();
    for (key, value) in [("CFBundleIdentifier", BUNDLE_ID), ("CFBundlePackageType", "APPL"),
        ("CFBundleExecutable", "fixture"), ("CFBundleShortVersionString", "1.0.0")] {
        info.insert(key.into(), plist::Value::String(value.into()));
    }
    plist::Value::Dictionary(info).to_file_xml(fixture.target.join("Contents/Info.plist")).unwrap();
    crate::process::bounded_command(Path::new("/usr/bin/codesign"),
        &["--force".into(), "--deep".into(), "--sign".into(), "-".into(), fixture.target.as_os_str().to_owned()],
        Instant::now() + Duration::from_secs(15)).unwrap();
    assert!(crate::signature::AppleValidator.validate(&fixture.target, Instant::now() + Duration::from_secs(15)).is_err());
}

#[test]
fn real_exec_failure_stops_new_generation_and_restarts_old() {
    let fixture = Fixture::with_broken_binaries(false, true); fixture.dead_parent();
    let runtime = TestRuntime::new(ReceiptMode::Good);
    let error = run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime).unwrap_err();
    assert!(error.to_string().contains("exited before exec"));
    fixture.assert_restored();
    assert!(fixture.record().restored.unwrap().live().unwrap());
    assert!(ProcessIdentity::inspect(fixture.record().launched.unwrap().pid).unwrap().is_none());
}

#[test]
fn real_restore_exec_failure_preserves_both_bundles() {
    let fixture = Fixture::with_broken_binaries(true, true); fixture.dead_parent();
    let runtime = TestRuntime::new(ReceiptMode::Good);
    assert!(matches!(run_with_runtime(&fixture.handoff, &FixtureValidator, &runtime), Err(Error::Aggregate { .. })));
    let record = fixture.record();
    assert_eq!(record.stage, Stage::RollingBack);
    assert_eq!(fsx::identity(&fixture.target).unwrap(), record.old_bundle);
    assert_eq!(fsx::identity(&fixture.stage()).unwrap(), record.new_bundle);
    assert!(fixture.handoff.exists());
}
