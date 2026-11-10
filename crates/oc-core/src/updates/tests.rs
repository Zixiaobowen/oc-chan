use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use crate::resources::ResourceBudget;
use std::sync::atomic::{AtomicBool, Ordering};
fn config(profile: PathBuf) -> UpdateConfig {
    UpdateConfig { profile: profile.clone(), host_bundle: profile.join("Untrusted.app"), worker: profile.join("nonexistent-worker"), current_version: "0.1.0".into(), development: true }
}
fn controller(profile: PathBuf, disabled: Option<DisabledReason>) -> Arc<UpdateController> {
    UpdateController::construct(config(profile), BoundedIo::new(ResourceBudget::default()), disabled).unwrap()
}
fn candidate() -> Candidate {
    Candidate { version: "0.2.0".into(), asset: source::Asset { target: source::TARGET.into(), name: "OC-Chan-0.2.0-mac-arm64.zip".into(), size: 3, sha512: STANDARD.encode([0u8;64]) } }
}
fn ticket(controller: &UpdateController, kind: Kind) -> Ticket {
    match controller.admit(kind, None).unwrap() { Admission::New(ticket) => ticket, _ => panic!("new operation expected") }
}
fn offer(controller: &UpdateController) {
    controller.finish(ticket(controller, Kind::Check), Ok(Outcome::Checked(Some(candidate())))).unwrap();
}
#[tokio::test]
async fn unsupported_platform_never_starts_worker_or_creates_staging() {
    let temporary = tempfile::tempdir().unwrap(); let profile = temporary.path().canonicalize().unwrap();
    let controller = controller(profile.clone(), Some(DisabledReason::Platform)); controller.start();
    assert_eq!(controller.check().await.unwrap().phase, UpdatePhase::Disabled);
    assert_eq!(controller.download().await.unwrap_err().code, "OC_UPDATE_DISABLED");
    assert!(matches!(controller.prepare_install().await, Err(error) if error.code == "OC_UPDATE_DISABLED"));
    assert!(!profile.join("updates-v2").exists()); controller.stop().await.unwrap();
}
#[tokio::test]
async fn unsigned_and_development_allow_manual_checks_but_never_automatic_download_or_install() {
    let temporary = tempfile::tempdir().unwrap(); let profile = temporary.path().canonicalize().unwrap();
    for reason in [DisabledReason::Development, DisabledReason::Unsigned] {
        let controller = controller(profile.clone(), Some(reason)); controller.start();
        assert_eq!(controller.snapshot().phase, UpdatePhase::Idle);
        assert!(!controller.state.lock().unwrap().scheduler_started);
        let due = *controller.deadline.borrow();
        assert!(matches!(controller.admit(Kind::Check, Some(due)).unwrap(), Admission::Unchanged(_)));
        let first = ticket(&controller, Kind::Check);
        assert_eq!(controller.snapshot().phase, UpdatePhase::Checking);
        controller.finish(first, Ok(Outcome::Checked(Some(candidate())))).unwrap();
        assert_eq!(controller.snapshot().phase, UpdatePhase::Available);
        assert_eq!(controller.snapshot().disabled_reason, Some(reason));
        assert!(controller.snapshot().checked_at.is_some());
        assert_eq!(controller.download().await.unwrap_err().code, "OC_UPDATE_DISABLED");
        assert!(matches!(controller.prepare_install().await, Err(error) if error.code == "OC_UPDATE_DISABLED"));
        // The public check path really invokes transport. This fixture has no
        // worker executable, so it must report failure without public networking.
        assert!(controller.check().await.is_err());
        assert_eq!(controller.snapshot().phase, UpdatePhase::Error);
        assert!(controller.snapshot().error.is_some());
        let retry = ticket(&controller, Kind::Check);
        controller.finish(retry, Ok(Outcome::Checked(None))).unwrap();
        assert_eq!(controller.snapshot().phase, UpdatePhase::Idle);
        assert!(controller.snapshot().error.is_none());
        assert!(!profile.join("updates-v2").exists()); controller.stop().await.unwrap();
    }
}
#[tokio::test]
async fn checks_coalesce_revision_increases_and_never_downloads_automatically() {
    let temporary = tempfile::tempdir().unwrap(); let controller = controller(temporary.path().canonicalize().unwrap(), None);
    let initial = controller.snapshot().revision; let first = ticket(&controller, Kind::Check);
    let joined = match controller.admit(Kind::Download, None).unwrap() { Admission::Joined(done) => done, _ => panic!("operation must coalesce") };
    // Check takes precedence over the caller's requested download; an explicit
    // later action is required once the candidate actually becomes available.
    controller.finish(first, Ok(Outcome::Checked(Some(candidate())))).unwrap();
    let snapshot = await_done(joined).await.unwrap(); assert_eq!(snapshot.phase, UpdatePhase::Available); assert!(snapshot.revision > initial);
    assert!(controller.state.lock().unwrap().stage.is_none()); assert!(!controller.config.profile.join("updates-v2").exists());
    controller.stop().await.unwrap();
}
#[tokio::test]
async fn manual_check_replaces_startup_deadline_and_late_timer_is_ignored() {
    let temporary = tempfile::tempdir().unwrap(); let controller = controller(temporary.path().canonicalize().unwrap(), None);
    let startup = *controller.deadline.borrow(); let first = ticket(&controller, Kind::Check); let manual = *controller.deadline.borrow();
    assert!(manual > startup + Duration::from_secs(5 * 60 * 60));
    controller.finish(first, Err(Error::new("OC_UPDATE_HTTP", "controlled failure"))).unwrap_err();
    assert!(matches!(controller.admit(Kind::Check, Some(startup)).unwrap(), Admission::Unchanged(_)));
    assert_eq!(controller.snapshot().phase, UpdatePhase::Error); controller.stop().await.unwrap();
}
#[tokio::test]
async fn cancelled_operation_waits_for_real_owned_stage_cleanup() {
    let temporary = tempfile::tempdir().unwrap(); let controller = controller(temporary.path().canonicalize().unwrap(), None); offer(&controller);
    let active = ticket(&controller, Kind::Download);
    let stage = work::create_stage(&controller.io, controller.config.profile.clone(), &active.cancel).await.unwrap();
    std::fs::write(stage.directory.path.join("archive.part"), b"partial").unwrap(); let path = stage.directory.path.clone();
    controller.state.lock().unwrap().stage = Some(stage);
    let this = controller.clone(); let finished = Arc::new(AtomicBool::new(false)); let mark = finished.clone();
    controller.tasks.spawn(async move {
        active.cancel.cancelled().await;
        let cleanup = this.clean_stage().await; mark.store(true, Ordering::Release);
        let _completion = this.finish(active, merge(Err(Error::cancelled()), cleanup));
    });
    let snapshot = controller.cancel().await.unwrap();
    assert!(finished.load(Ordering::Acquire)); assert!(!path.exists()); assert_eq!(snapshot.phase, UpdatePhase::Available); assert_eq!(snapshot.available_version.as_deref(), Some("0.2.0"));
    controller.stop().await.unwrap();
}
#[tokio::test]
async fn cleanup_failure_wins_cancel_and_does_not_delete_replaced_or_other_stage() {
    let temporary = tempfile::tempdir().unwrap(); let controller = controller(temporary.path().canonicalize().unwrap(), None); offer(&controller);
    let active = ticket(&controller, Kind::Download); let stage = work::create_stage(&controller.io, controller.config.profile.clone(), &active.cancel).await.unwrap();
    let path = stage.directory.path.clone(); let saved = path.with_extension("saved");
    std::fs::rename(&path, &saved).unwrap(); std::fs::create_dir(&path).unwrap(); std::fs::write(path.join("user-owned"), b"keep").unwrap();
    controller.state.lock().unwrap().stage = Some(stage);
    let this = controller.clone(); controller.tasks.spawn(async move {
        active.cancel.cancelled().await; let cleanup = this.clean_stage().await;
        let _completion = this.finish(active, merge(Err(Error::cancelled()), cleanup));
    });
    let error = controller.cancel().await.unwrap_err(); assert!(error.is_cleanup()); assert_eq!(controller.snapshot().phase, UpdatePhase::Error);
    assert_eq!(std::fs::read(path.join("user-owned")).unwrap(), b"keep"); assert!(saved.exists());
    let replacement = path.with_extension("replacement"); std::fs::rename(&path, &replacement).unwrap(); std::fs::rename(&saved, &path).unwrap();
    controller.stop().await.unwrap(); assert!(!path.exists()); assert_eq!(std::fs::read(replacement.join("user-owned")).unwrap(), b"keep");
}
#[tokio::test]
async fn stop_discards_only_own_download_and_never_installs() {
    let temporary = tempfile::tempdir().unwrap(); let controller = controller(temporary.path().canonicalize().unwrap(), None); offer(&controller);
    let active = ticket(&controller, Kind::Download); let stage = work::create_stage(&controller.io, controller.config.profile.clone(), &active.cancel).await.unwrap();
    let other = stage.root.path.join("another-controller"); std::fs::create_dir(&other).unwrap(); std::fs::write(other.join("keep"), b"keep").unwrap();
    let own = stage.directory.path.clone(); std::fs::write(own.join("archive.zip"), b"download").unwrap(); controller.state.lock().unwrap().stage = Some(stage);
    controller.finish(active, Ok(Outcome::Downloaded)).unwrap(); controller.stop().await.unwrap();
    assert!(!own.exists()); assert_eq!(std::fs::read(other.join("keep")).unwrap(), b"keep"); assert!(!controller.state.lock().unwrap().handing_off);
}
#[tokio::test]
async fn stale_progress_cannot_change_newer_snapshot() {
    let temporary = tempfile::tempdir().unwrap(); let controller = controller(temporary.path().canonicalize().unwrap(), None); offer(&controller);
    let first = ticket(&controller, Kind::Download); let id = first.id; controller.finish(first, Err(Error::cancelled())).unwrap();
    let second = ticket(&controller, Kind::Check); let before = controller.snapshot();
    controller.progress(id, UpdateProgress { percent: 100.0, transferred: 3, total: 3, bytes_per_second: 3.0 }); assert_eq!(controller.snapshot(), before);
    controller.finish(second, Ok(Outcome::Checked(None))).unwrap(); controller.stop().await.unwrap();
}
#[tokio::test]
async fn deadline_waits_for_cleanup_and_preserves_cleanup_failure() {
    let cancel = CancellationToken::new(); let work_cancel = cancel.clone(); let drained = Arc::new(AtomicBool::new(false)); let mark = drained.clone();
    let error = deadline(cancel, Duration::from_millis(1), async move {
        work_cancel.cancelled().await; tokio::time::sleep(Duration::from_millis(10)).await; mark.store(true, Ordering::Release);
        Err::<(), _>(Error::cleanup("fixture close", Error::new("EIO", "controlled close failure")))
    }).await.unwrap_err();
    assert!(drained.load(Ordering::Acquire)); assert!(error.is_cleanup());
}
#[tokio::test]
async fn unsigned_host_rejection_uses_real_installer_boundary() {
    let temporary = tempfile::tempdir().unwrap(); let bundle = temporary.path().canonicalize().unwrap().join("Unsigned.app"); std::fs::create_dir(&bundle).unwrap();
    let io = BoundedIo::new(ResourceBudget::default());
    assert!(work::verify_host(&io, bundle, &CancellationToken::new()).await.is_err()); io.shutdown().await.unwrap();
}
#[test]
fn snapshot_wire_shape_matches_renderer_nullable_contract() {
    let snapshot = UpdateSnapshot { revision: 1, phase: UpdatePhase::Disabled, current_version: "0.1.0".into(), available_version: None, checked_at: None, progress: None, disabled_reason: Some(DisabledReason::Unsigned), error: None };
    let json = serde_json::to_value(snapshot).unwrap(); assert_eq!(json["currentVersion"], "0.1.0"); assert_eq!(json["disabledReason"], "unsigned");
    for field in ["availableVersion", "checkedAt", "progress", "error"] { assert!(json.get(field).unwrap().is_null()); }
}

#[tokio::test]
async fn explicit_prepare_rejects_invalid_archive_and_removes_owned_staging() {
    let temporary = tempfile::tempdir().unwrap(); let controller = controller(temporary.path().canonicalize().unwrap(), None); offer(&controller);
    let active = ticket(&controller, Kind::Download); let stage = work::create_stage(&controller.io, controller.config.profile.clone(), &active.cancel).await.unwrap();
    let own = stage.directory.path.clone(); std::fs::write(own.join("archive.zip"), b"invalid archive").unwrap();
    controller.state.lock().unwrap().stage = Some(stage); controller.finish(active, Ok(Outcome::Downloaded)).unwrap();
    assert!(controller.prepare_install().await.is_err()); assert!(!own.exists());
    assert_eq!(controller.snapshot().phase, UpdatePhase::Error); assert!(controller.state.lock().unwrap().active.is_none());
    assert!(!controller.state.lock().unwrap().handing_off); controller.stop().await.unwrap();
}

#[tokio::test]
async fn prepare_cancellation_waits_for_file_budget_and_real_cleanup() {
    let temporary = tempfile::tempdir().unwrap(); let controller = controller(temporary.path().canonicalize().unwrap(), None); offer(&controller);
    let active = ticket(&controller, Kind::Download); let stage = work::create_stage(&controller.io, controller.config.profile.clone(), &active.cancel).await.unwrap();
    let own = stage.directory.path.clone(); std::fs::write(own.join("archive.zip"), b"archive").unwrap();
    controller.state.lock().unwrap().stage = Some(stage); controller.finish(active, Ok(Outcome::Downloaded)).unwrap();
    let held = controller.io.resources().acquire("update-test", crate::resources::Request::File { bytes: 16 * 1024 * 1024 }, &CancellationToken::new()).await.unwrap();
    let this = controller.clone(); let mut snapshots = controller.subscribe();
    let preparing = tokio::spawn(async move { this.prepare_install().await });
    loop { if snapshots.borrow().phase == UpdatePhase::Installing { break; } snapshots.changed().await.unwrap(); }
    let cancellation = controller.cancel(); tokio::pin!(cancellation);
    tokio::select! {
        _ = &mut cancellation => panic!("cancel returned before owned file cleanup acquired its lease"),
        _ = tokio::time::sleep(Duration::from_millis(10)) => (),
    }
    drop(held); assert_eq!(cancellation.await.unwrap().phase, UpdatePhase::Available);
    let result = preparing.await.unwrap(); assert!(matches!(result, Err(error) if error.is_cancelled()));
    assert!(!own.exists()); controller.stop().await.unwrap();
}

#[tokio::test]
async fn checking_preserves_an_already_downloaded_candidate() {
    let temporary = tempfile::tempdir().unwrap(); let controller = controller(temporary.path().canonicalize().unwrap(), None); offer(&controller);
    let active = ticket(&controller, Kind::Download); let stage = work::create_stage(&controller.io, controller.config.profile.clone(), &active.cancel).await.unwrap();
    let own = stage.directory.path.clone(); std::fs::write(own.join("archive.zip"), b"download").unwrap(); controller.state.lock().unwrap().stage = Some(stage);
    controller.finish(active, Ok(Outcome::Downloaded)).unwrap();
    assert_eq!(controller.check().await.unwrap().phase, UpdatePhase::Downloaded); assert!(own.join("archive.zip").exists()); controller.stop().await.unwrap();
}

#[tokio::test]
async fn development_prerelease_can_manually_check_and_reports_worker_errors() {
    let temporary = tempfile::tempdir().unwrap(); let mut options = config(temporary.path().canonicalize().unwrap()); options.current_version = "0.2.0-dev.1".into();
    let controller = UpdateController::new(options, BoundedIo::new(ResourceBudget::default())).await.unwrap();
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        assert_eq!(controller.snapshot().disabled_reason, Some(DisabledReason::Development));
        assert_eq!(controller.snapshot().phase, UpdatePhase::Idle);
        assert!(controller.check().await.is_err());
        assert_eq!(controller.snapshot().phase, UpdatePhase::Error);
    } else {
        assert_eq!(controller.check().await.unwrap().phase, UpdatePhase::Disabled);
    }
    controller.stop().await.unwrap();
}
