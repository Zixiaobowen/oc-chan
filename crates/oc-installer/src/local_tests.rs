use super::*;
use crate::{HistoryReadiness, PartitionEvidence, PartitionReadiness};
use std::{collections::BTreeMap, fs::{OpenOptions, Permissions}, os::unix::fs::{OpenOptionsExt, PermissionsExt}, process::{Child, Command, Stdio}, time::{Duration, Instant}};

fn private_file_at(path: &Path) -> File { OpenOptions::new().read(true).write(true).create_new(true).mode(0o600).open(path).unwrap() }
fn directory() -> tempfile::TempDir { tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap() }
fn evidence(version: &str) -> ReadyEvidence {
    ReadyEvidence { host_version: version.into(), renderer_entry: "local-library-test".into(), renderer_committed: true, ipc_round_trip: true,
        partitions: ["agents", "schedules", "events", "system"].into_iter().map(|name| (name.to_owned(), PartitionEvidence { enabled: false, installed: true, state: PartitionReadiness::Disabled, reason: None })).collect::<BTreeMap<_, _>>(),
        hermes_history: HistoryReadiness::Disabled, history_entries: 0, history_reason: Some("Schedules disabled by test fixture".into()) }
}
fn shaped_authorization() -> LocalInstallAuthorization {
    let transaction = uuid::Uuid::new_v4();
    LocalInstallAuthorization { schema: 1, request: ReadyRequest { schema: 1, transaction, bundle: PathBuf::from("/Applications/Test.app"), version: "1.2.3".into(), issued_at_ms: 2_000, expires_at_ms: 3_000,
        process: ProcessIdentity { pid: 3, birth_seconds: 1, birth_fraction: 100, executable: PathBuf::from("/Applications/Test.app/Contents/MacOS/test") } },
        installer: ProcessIdentity { pid: 2, birth_seconds: 1, birth_fraction: 0, executable: PathBuf::from("/private/gate") },
        bundle_identity: LocalFileIdentity { dev: 1, ino: 2, uid: 501, mode: libc::S_IFDIR as u32 | 0o700, nlink: 2 },
        lock_identity: LocalFileIdentity { dev: 1, ino: 3, uid: 501, mode: libc::S_IFREG as u32 | 0o600, nlink: 1 },
        lock: PathBuf::from(format!("/private/oc-local-install-{transaction}/gate.lock")) }
}

#[test]
fn strict_schema_time_and_normalized_paths() {
    let authorization = shaped_authorization(); let parent = authorization.lock.parent().unwrap();
    validate_shape(&authorization, parent, 2_500).unwrap();
    let mut value = serde_json::to_value(&authorization).unwrap(); value["testTrust"] = true.into();
    assert!(serde_json::from_value::<LocalInstallAuthorization>(value).is_err());
    let mut future = authorization.clone(); future.request.issued_at_ms = 2_501;
    assert!(validate_shape(&future, parent, 2_500).is_err());
    assert!(validate_shape(&authorization, parent, 3_001).is_err());
    let mut overlong = authorization.clone(); overlong.request.expires_at_ms = overlong.request.issued_at_ms + MAX_AGE_MS + 1;
    assert!(validate_shape(&overlong, parent, 2_500).is_err());
    let mut wrong_directory = authorization.clone(); wrong_directory.request.transaction = uuid::Uuid::new_v4();
    assert!(validate_shape(&wrong_directory, parent, 2_500).is_err());
    let mut external_lock = authorization.clone(); external_lock.lock = PathBuf::from("/private/another/gate.lock");
    assert!(validate_shape(&external_lock, parent, 2_500).is_err());
    for path in ["relative", "/private/./gate", "/private/../gate", "/private//gate", "/private/gate/", "/"] { assert!(normal_path(Path::new(path)).is_err(), "{path}"); }
    normal_path(Path::new("/private/真实目录/gate")).unwrap();
}

#[test]
fn private_metadata_read_is_bounded_and_single_link() {
    let root = directory(); let path = root.path().join("authorization.json"); let mut file = private_file_at(&path);
    file.write_all(b"{}").unwrap(); assert_eq!(bounded_read(&mut file).unwrap().0, b"{}");
    fs::hard_link(&path, root.path().join("alias")).unwrap(); assert!(bounded_read(&mut file).is_err()); fs::remove_file(root.path().join("alias")).unwrap();
    fs::set_permissions(&path, Permissions::from_mode(0o644)).unwrap(); assert!(bounded_read(&mut file).is_err()); fs::set_permissions(&path, Permissions::from_mode(0o600)).unwrap();
    file.set_len(MAX_BYTES as u64 + 1).unwrap(); assert!(bounded_read(&mut file).is_err()); close(file).unwrap();
    let mut output = Limited { bytes: Vec::new() }; output.write_all(&vec![0; MAX_BYTES]).unwrap(); assert!(output.write_all(b"x").is_err()); assert_eq!(output.bytes.len(), MAX_BYTES);
}

#[test]
fn exclusive_receipt_publication_preserves_existing_and_rejects_replaced_cleanup() {
    let root = directory(); let directory = open_directory(root.path()).unwrap();
    let mut receipt = private_file_at(&root.path().join("receipt.json")); receipt.write_all(b"original").unwrap(); close(receipt).unwrap();
    let pending = private_file_at(&root.path().join("pending")); let identity = LocalFileIdentity::metadata(&pending.metadata().unwrap()); close(pending).unwrap();
    assert!(rename_exclusive(&directory, c"pending", c"receipt.json").is_err()); assert_eq!(fs::read(root.path().join("receipt.json")).unwrap(), b"original");
    fs::rename(root.path().join("pending"), root.path().join("retained")).unwrap(); let replacement = private_file_at(&root.path().join("pending")); close(replacement).unwrap();
    assert!(remove_owned(&directory, c"pending", &identity).is_err()); assert!(root.path().join("pending").is_file());
    remove_owned(&directory, c"retained", &identity).unwrap(); close(directory).unwrap();
}

struct OwnedChild(Option<Child>);
impl OwnedChild {
    fn output(mut self) -> std::process::Output {
        let end = Instant::now() + Duration::from_secs(15);
        loop {
            if self.0.as_mut().unwrap().try_wait().unwrap().is_some() { return self.0.take().unwrap().wait_with_output().unwrap(); }
            assert!(Instant::now() < end, "local authentication child exceeded deadline");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for OwnedChild { fn drop(&mut self) { if let Some(mut child) = self.0.take() { let _ = child.kill(); let _ = child.wait(); } } }

#[cfg(target_os = "macos")]
#[test]
fn real_parent_lock_birth_identity_and_write_time_reauthentication() {
    let root = directory(); let bundle = root.path().join("Test.app"); let executable = bundle.join("Contents/MacOS/local-probe");
    fs::create_dir_all(executable.parent().unwrap()).unwrap(); fs::set_permissions(&bundle, Permissions::from_mode(0o700)).unwrap();
    fs::copy(std::env::current_exe().unwrap(), &executable).unwrap(); fs::set_permissions(&executable, Permissions::from_mode(0o700)).unwrap();
    for mode in ["valid", "no-lock", "parent-birth", "child-birth", "lock-inode", "expired", "bad-mode", "hardlink", "symlink", "oversized", "invalid-evidence", "changed-lock", "changed-authorization", "changed-bundle"] {
        let transaction = uuid::Uuid::new_v4(); let directory = root.path().join(format!("oc-local-install-{transaction}"));
        fs::create_dir(&directory).unwrap(); fs::set_permissions(&directory, Permissions::from_mode(0o700)).unwrap();
        let lock_path = directory.join("gate.lock"); let lock_file = private_file_at(&lock_path);
        if mode != "no-lock" {
            let mut lock: libc::flock = unsafe { std::mem::zeroed() }; lock.l_type = libc::F_WRLCK as _; lock.l_whence = libc::SEEK_SET as _;
            assert_eq!(unsafe { libc::fcntl(lock_file.as_raw_fd(), libc::F_SETLK, &lock) }, 0);
        }
        let path = directory.join("authorization.json");
        let child = Command::new(&executable).args(["--ignored", "--exact", "local::tests::local_child_probe", "--test-threads=1", "--nocapture"])
            .env("OC_INSTALLER_LOCAL_TEST_AUTH", &path).env("OC_INSTALLER_LOCAL_TEST_MODE", mode)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let mut child = OwnedChild(Some(child)); let process = ProcessIdentity::inspect(child.0.as_ref().unwrap().id() as i32).unwrap().unwrap();
        let now = fsx::now_ms().unwrap(); let mut authorization = LocalInstallAuthorization { schema: 1,
            request: ReadyRequest { schema: 1, transaction, bundle: bundle.clone(), version: "1.2.3".into(), issued_at_ms: now, expires_at_ms: now + 10_000, process },
            installer: ProcessIdentity::current().unwrap(), bundle_identity: LocalFileIdentity::metadata(&fs::symlink_metadata(&bundle).unwrap()),
            lock_identity: LocalFileIdentity::metadata(&lock_file.metadata().unwrap()), lock: lock_path };
        match mode {
            "parent-birth" => authorization.installer.birth_fraction = (authorization.installer.birth_fraction + 1) % 1_000_000,
            "child-birth" => authorization.request.process.birth_fraction = (authorization.request.process.birth_fraction + 1) % 1_000_000,
            "lock-inode" => authorization.lock_identity.ino += 1,
            "expired" => { authorization.request.issued_at_ms = now.saturating_sub(2_000); authorization.request.expires_at_ms = now.saturating_sub(1); },
            _ => {}
        }
        let mut file = private_file_at(&path); serde_json::to_writer(&mut file, &authorization).unwrap(); file.sync_all().unwrap(); close(file).unwrap();
        match mode {
            "bad-mode" => fs::set_permissions(&path, Permissions::from_mode(0o644)).unwrap(),
            "hardlink" => fs::hard_link(&path, directory.join("authorization.alias")).unwrap(),
            "symlink" => { let target = directory.join("authorization.real"); fs::rename(&path, &target).unwrap(); std::os::unix::fs::symlink(target, &path).unwrap(); },
            "oversized" => { let file = OpenOptions::new().write(true).open(&path).unwrap(); file.set_len(MAX_BYTES as u64 + 1).unwrap(); close(file).unwrap(); },
            _ => {}
        }
        let mut input = child.0.as_mut().unwrap().stdin.take().unwrap(); input.write_all(b"x").unwrap(); drop(input);
        let output = child.output(); close(lock_file).unwrap();
        assert!(output.status.success(), "{mode}: {}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        if mode == "valid" {
            let receipt: ReadyReceipt = serde_json::from_slice(&fs::read(directory.join("receipt.json")).unwrap()).unwrap(); assert_eq!(receipt.request, authorization.request);
            assert_eq!(fs::read_dir(&directory).unwrap().count(), 3, "failed duplicate publication left a pending file");
        } else { assert!(!directory.join("receipt.json").exists(), "{mode}: unauthorized receipt published"); }
    }
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "invoked only as a bounded real child of the local authentication test"]
fn local_child_probe() {
    let path = PathBuf::from(std::env::var_os("OC_INSTALLER_LOCAL_TEST_AUTH").expect("parent auth path")); let mode = std::env::var("OC_INSTALLER_LOCAL_TEST_MODE").unwrap();
    std::io::stdin().read_exact(&mut [0u8; 1]).unwrap();
    let request = read_local_ready_request(&path);
    if !["valid", "invalid-evidence", "changed-lock", "changed-authorization", "changed-bundle"].contains(&mode.as_str()) {
        let error = request.unwrap_err().to_string(); if mode == "no-lock" { assert!(error.contains("whole-file POSIX write lock"), "{error}"); } return;
    }
    let request = request.unwrap(); let parent = path.parent().unwrap();
    match mode.as_str() {
        "valid" => {
            write_local_ready_receipt(&path, evidence(&request.version)).unwrap(); let before = fs::read(parent.join("receipt.json")).unwrap();
            assert!(write_local_ready_receipt(&path, evidence(&request.version)).is_err()); assert_eq!(before, fs::read(parent.join("receipt.json")).unwrap());
            private_file(&fs::symlink_metadata(parent.join("receipt.json")).unwrap()).unwrap();
        }
        "invalid-evidence" => { let mut invalid = evidence(&request.version); invalid.renderer_committed = false; assert!(write_local_ready_receipt(&path, invalid).is_err()); }
        "changed-lock" => { fs::rename(parent.join("gate.lock"), parent.join("gate.retired")).unwrap(); close(private_file_at(&parent.join("gate.lock"))).unwrap(); assert!(write_local_ready_receipt(&path, evidence(&request.version)).is_err()); }
        "changed-authorization" => {
            let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap(); value["schema"] = 2.into();
            let mut file = OpenOptions::new().write(true).truncate(true).open(&path).unwrap(); serde_json::to_writer(&mut file, &value).unwrap(); file.sync_all().unwrap(); close(file).unwrap();
            assert!(write_local_ready_receipt(&path, evidence(&request.version)).is_err());
        }
        "changed-bundle" => { fs::rename(&request.bundle, request.bundle.with_file_name("Moved.app")).unwrap(); fs::create_dir(&request.bundle).unwrap(); fs::set_permissions(&request.bundle, Permissions::from_mode(0o700)).unwrap(); assert!(write_local_ready_receipt(&path, evidence(&request.version)).is_err()); }
        _ => unreachable!()
    }
}
