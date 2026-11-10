//! Read-only local launch evidence. This entry point does not prepare, install,
//! replace, sign or upgrade a bundle and never consumes a production handoff.
use crate::{combine, ensure, filesystem as fsx, reject, IoResult, ProcessIdentity, ReadyEvidence, ReadyReceipt, ReadyRequest, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ffi::{CStr, CString, OsStr}, fs::{self, File, Metadata}, io::{Read, Seek, SeekFrom, Write}, os::{fd::{AsRawFd, FromRawFd, IntoRawFd}, unix::{ffi::OsStrExt, fs::MetadataExt}}, path::{Component, Path, PathBuf}};

pub const LOCAL_READY_ARGUMENT: &str = "--oc-local-install-receipt=";
const MAX_BYTES: usize = 16 * 1024;
const MAX_AGE_MS: u64 = 120_000;
const DIRECTORY: usize = 0;
const AUTHORIZATION: usize = 1;
const LOCK: usize = 2;
const BUNDLE: usize = 3;

/// Exact lstat/fstat fields, including the file-type bits in mode. Directory
/// nlink records its real value; only ordinary files must have a single link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFileIdentity { pub dev: u64, pub ino: u64, pub uid: u32, pub mode: u32, pub nlink: u64 }
impl LocalFileIdentity {
    fn metadata(metadata: &Metadata) -> Self { Self { dev: metadata.dev(), ino: metadata.ino(), uid: metadata.uid(), mode: metadata.mode(), nlink: metadata.nlink() } }
    fn stat(stat: &libc::stat) -> Self { Self { dev: stat.st_dev as u64, ino: stat.st_ino as u64, uid: stat.st_uid, mode: stat.st_mode as u32, nlink: stat.st_nlink as u64 } }
    fn same_directory(&self, other: &Self) -> bool { self.dev == other.dev && self.ino == other.ino && self.uid == other.uid && self.mode == other.mode && self.nlink > 0 && other.nlink > 0 }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalInstallAuthorization {
    pub schema: u32,
    pub request: ReadyRequest,
    pub installer: ProcessIdentity,
    pub bundle_identity: LocalFileIdentity,
    pub lock_identity: LocalFileIdentity,
    pub lock: PathBuf,
}

/// Authenticate a local gate's child without invoking production install policy.
/// The direct parent must still hold an actual whole-file POSIX write record lock.
pub fn read_local_ready_request(path: &Path) -> Result<ReadyRequest> {
    let session = Session::load(path)?;
    let request = session.authorization.request.clone();
    merge(Ok(request), session.files.close())
}
/// The caller supplies evidence from its real renderer, IPC and collectors.
/// Publication is exclusive and authentication is repeated before and after fsync.
pub fn write_local_ready_receipt(path: &Path, evidence: ReadyEvidence) -> Result<()> {
    let mut session = Session::load(path)?;
    let result = publish(&mut session, evidence);
    merge(result, session.files.close())
}
struct Files { values: [Option<File>; 4] }
impl Files {
    fn new() -> Self { Self { values: std::array::from_fn(|_| None) } }
    fn get(&self, index: usize) -> &File { self.values[index].as_ref().expect("owned local descriptor") }
    fn get_mut(&mut self, index: usize) -> &mut File { self.values[index].as_mut().expect("owned local descriptor") }
    fn close(mut self) -> Result<()> {
        let mut result = Ok(());
        for file in self.values.iter_mut().rev().filter_map(Option::take) { result = merge(result, close(file)); }
        result
    }
}
struct Session {
    files: Files, authorization: LocalInstallAuthorization, path: PathBuf,
    directory_identity: LocalFileIdentity, authorization_metadata: Metadata, authorization_digest: [u8; 32],
}
impl Session {
    fn load(path: &Path) -> Result<Self> {
        ensure(cfg!(target_os = "macos"), "local launch authentication requires macOS libproc and POSIX lock ownership")?;
        normal_path(path)?;
        fsx::real_path(path)?;
        ensure(path.file_name() == Some(OsStr::new("authorization.json")), "unexpected local authorization filename")?;
        let parent = path.parent().ok_or_else(|| reject("local authorization has no parent"))?;
        let mut files = Files::new();
        let loaded: Result<(LocalInstallAuthorization, LocalFileIdentity, Metadata, [u8; 32])> = (|| {
            files.values[DIRECTORY] = Some(open_directory(parent)?);
            let directory = files.get(DIRECTORY).metadata().context("inspect local authorization directory")?;
            private_directory(&directory)?;
            files.values[AUTHORIZATION] = Some(open_at(files.get(DIRECTORY), c"authorization.json", libc::O_RDONLY)?);
            let (bytes, authorization_metadata) = bounded_read(files.get_mut(AUTHORIZATION))?;
            let authorization: LocalInstallAuthorization = serde_json::from_slice(&bytes)?;
            validate_shape(&authorization, parent, fsx::now_ms()?)?;
            files.values[LOCK] = Some(open_at(files.get(DIRECTORY), c"gate.lock", libc::O_RDONLY)?);
            files.values[BUNDLE] = Some(open_directory(&authorization.request.bundle)?);
            Ok((authorization, LocalFileIdentity::metadata(&directory), authorization_metadata, Sha256::digest(&bytes).into()))
        })();
        let (authorization, directory_identity, authorization_metadata, authorization_digest) = match loaded { Ok(value) => value, Err(error) => return merge(Err(error), files.close()) };
        let mut session = Self { files, authorization, path: path.to_owned(), directory_identity, authorization_metadata, authorization_digest };
        match session.validate() { Ok(()) => Ok(session), Err(error) => merge(Err(error), session.files.close()) }
    }
    fn validate(&mut self) -> Result<()> {
        let parent = self.path.parent().ok_or_else(|| reject("local authorization parent disappeared"))?;
        fsx::real_path(&self.path)?;
        let directory = self.files.get(DIRECTORY).metadata().context("reinspect local authorization directory")?; private_directory(&directory)?;
        ensure(self.directory_identity.same_directory(&LocalFileIdentity::metadata(&directory)), "authorization directory descriptor changed")?;
        let named_directory = fs::symlink_metadata(parent).context("reinspect local authorization directory name")?;
        ensure(named_directory.is_dir() && self.directory_identity.same_directory(&LocalFileIdentity::metadata(&named_directory)), "authorization directory path was replaced")?;
        let (bytes, metadata) = bounded_read(self.files.get_mut(AUTHORIZATION))?;
        ensure(same_metadata(&metadata, &self.authorization_metadata) && <[u8;32]>::from(Sha256::digest(&bytes)) == self.authorization_digest, "local authorization changed")?;
        ensure(named_identity(self.files.get(DIRECTORY), c"authorization.json")? == LocalFileIdentity::metadata(&metadata), "local authorization name was replaced")?;
        validate_shape(&self.authorization, parent, fsx::now_ms()?)?;
        let bundle = self.files.get(BUNDLE).metadata().context("inspect authorized bundle descriptor")?;
        ensure(bundle.is_dir() && bundle.uid() == unsafe { libc::geteuid() } && bundle.mode() & 0o7022 == 0 && bundle.nlink() > 0, "unsafe local bundle ownership or permissions")?;
        ensure(LocalFileIdentity::metadata(&bundle) == self.authorization.bundle_identity, "authorized bundle inode or metadata changed")?;
        fsx::real_path(&self.authorization.request.bundle)?;
        let named_bundle = fs::symlink_metadata(&self.authorization.request.bundle).context("inspect authorized bundle name")?;
        ensure(named_bundle.is_dir() && LocalFileIdentity::metadata(&named_bundle) == self.authorization.bundle_identity, "authorized bundle path was replaced")?;
        let actual = ProcessIdentity::current()?;
        ensure(actual == self.authorization.request.process, "local request is for another child process or executable")?;
        let executable = &actual.executable;
        fsx::real_path(executable)?;
        ensure(executable.parent() == Some(self.authorization.request.bundle.join("Contents/MacOS").as_path()), "local child executable is outside the authorized bundle")?;
        crate::signature::executable_name(executable.file_name().and_then(OsStr::to_str).ok_or_else(|| reject("invalid executable name"))?)?;
        let executable_metadata = fs::symlink_metadata(executable).context("inspect current child executable")?;
        ensure(executable_metadata.is_file() && executable_metadata.nlink() == 1 && executable_metadata.uid() == unsafe { libc::geteuid() }
            && executable_metadata.mode() & 0o7022 == 0 && executable_metadata.mode() & 0o100 != 0, "unsafe current child executable")?;
        check_parent(&self.authorization.installer, &actual)?;
        let lock = self.files.get(LOCK).metadata().context("inspect local gate lock descriptor")?; private_file(&lock)?;
        ensure(lock.len() <= MAX_BYTES as u64 && LocalFileIdentity::metadata(&lock) == self.authorization.lock_identity, "local gate lock descriptor identity changed")?;
        ensure(named_identity(self.files.get(DIRECTORY), c"gate.lock")? == self.authorization.lock_identity, "local gate lock name was replaced")?;
        check_record_lock(self.files.get(LOCK), self.authorization.installer.pid)?;
        ensure(unsafe { libc::getppid() } == self.authorization.installer.pid, "local gate parent exited during authentication")
    }
}
fn validate_shape(authorization: &LocalInstallAuthorization, directory: &Path, now: u64) -> Result<()> {
    let request = &authorization.request;
    ensure(authorization.schema == 1 && request.schema == 1 && !request.transaction.is_nil(), "invalid local authorization schema or transaction")?;
    ensure(directory.file_name().and_then(OsStr::to_str) == Some(format!("oc-local-install-{}", request.transaction).as_str()), "local transaction directory does not match its UUID")?;
    ensure(authorization.lock == directory.join("gate.lock"), "local lock is outside its authorization directory")?;
    ensure(request.bundle.extension() == Some(OsStr::new("app")), "authorized path is not an application bundle")?;
    for path in [&request.bundle, &request.process.executable, &authorization.installer.executable, &authorization.lock] { normal_path(path)?; }
    ensure(request.version.len() <= 128, "local version exceeds bound")?;
    let version = semver::Version::parse(&request.version).map_err(|_| reject("invalid local bundle semver"))?;
    ensure(version.to_string() == request.version, "local version is not canonical semver")?;
    ensure(request.expires_at_ms.checked_sub(request.issued_at_ms).is_some_and(|duration| duration > 0 && duration <= MAX_AGE_MS)
        && request.issued_at_ms <= now && now <= request.expires_at_ms, "local authorization expired, future-dated or overlong")?;
    for identity in [&request.process, &authorization.installer] {
        ensure(identity.pid > 1 && identity.birth_seconds > 0 && identity.birth_fraction < 1_000_000, "invalid local process birth identity")?;
    }
    let born = request.process.birth_seconds.checked_mul(1000).and_then(|seconds| seconds.checked_add(request.process.birth_fraction / 1000)).ok_or_else(|| reject("child birth time overflow"))?;
    ensure(born <= request.issued_at_ms && (authorization.installer.birth_seconds, authorization.installer.birth_fraction) <= (request.process.birth_seconds, request.process.birth_fraction), "local authorization predates its child or parent")?;
    ensure(request.process.pid != authorization.installer.pid, "local gate cannot authenticate itself as its child")
}
fn normal_path(path: &Path) -> Result<()> {
    let bytes = path.as_os_str().as_bytes();
    ensure(path.is_absolute() && bytes.len() <= 4096 && !bytes.contains(&0) && path.to_str().is_some(), "local path must be absolute, UTF-8 and bounded")?;
    ensure(bytes[1..].split(|byte| *byte == b'/').all(|part| !part.is_empty() && part != b"." && part != b".."), "noncanonical local path component")
}
#[cfg(target_os = "macos")]
fn check_parent(expected: &ProcessIdentity, child: &ProcessIdentity) -> Result<()> {
    ensure(unsafe { libc::getuid() } == unsafe { libc::geteuid() }, "set-id local launch is not allowed")?;
    ensure(unsafe { libc::getppid() } == expected.pid, "local installer is not this child's direct parent")?;
    let inspect = |pid: i32| -> Result<libc::proc_bsdinfo> {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit(); let size = std::mem::size_of::<libc::proc_bsdinfo>();
        let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size as i32) };
        ensure(read == size as i32, "libproc could not establish local parent/child identity")?;
        let info = unsafe { info.assume_init() };
        ensure(info.pbi_pid == pid as u32 && info.pbi_status != 5 && info.pbi_uid == unsafe { libc::geteuid() } && info.pbi_ruid == unsafe { libc::getuid() }, "local parent or child UID/liveness mismatch")?; Ok(info)
    };
    let current = inspect(child.pid)?;
    ensure(current.pbi_ppid == expected.pid as u32 && current.pbi_start_tvsec == child.birth_seconds && current.pbi_start_tvusec == child.birth_fraction, "child parent or microsecond birth identity changed")?;
    let parent = inspect(expected.pid)?;
    ensure(parent.pbi_start_tvsec == expected.birth_seconds && parent.pbi_start_tvusec == expected.birth_fraction && expected.live()?, "local installer parent identity changed or exited")?;
    fsx::real_path(&expected.executable)?; Ok(())
}
#[cfg(not(target_os = "macos"))]
fn check_parent(_: &ProcessIdentity, _: &ProcessIdentity) -> Result<()> { Err(reject("local parent identity requires macOS libproc")) }
fn check_record_lock(file: &File, installer: i32) -> Result<()> {
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = libc::F_WRLCK as _; lock.l_whence = libc::SEEK_SET as _; lock.l_start = 0; lock.l_len = 0;
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &mut lock) } == -1 { return Err(last("query local POSIX record lock")); }
    ensure(lock.l_type == libc::F_WRLCK as libc::c_short && lock.l_pid == installer && lock.l_whence == libc::SEEK_SET as libc::c_short && lock.l_start == 0 && lock.l_len == 0,
        "live local installer does not hold the whole-file POSIX write lock")
}
fn private_directory(metadata: &Metadata) -> Result<()> { ensure(metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o7777 == 0o700 && metadata.nlink() > 0, "local authorization directory must be owned 0700") }
fn private_file(metadata: &Metadata) -> Result<()> { ensure(metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o7777 == 0o600 && metadata.nlink() == 1, "local metadata must be owned 0600 single-link regular file") }
fn same_metadata(a: &Metadata, b: &Metadata) -> bool { LocalFileIdentity::metadata(a) == LocalFileIdentity::metadata(b) && a.len() == b.len() && a.mtime() == b.mtime() && a.mtime_nsec() == b.mtime_nsec() && a.ctime() == b.ctime() && a.ctime_nsec() == b.ctime_nsec() }
fn bounded_read(file: &mut File) -> Result<(Vec<u8>, Metadata)> {
    let before = file.metadata().context("stat local authorization")?; private_file(&before)?;
    ensure(before.len() > 0 && before.len() <= MAX_BYTES as u64, "local authorization exceeds 16KiB")?;
    file.seek(SeekFrom::Start(0)).context("seek local authorization")?;
    let mut bytes = Vec::with_capacity(before.len() as usize); let mut chunk = [0u8; 4096];
    loop { let count = file.read(&mut chunk).context("read local authorization")?; if count == 0 { break; } ensure(count <= (before.len() as usize).saturating_sub(bytes.len()), "local authorization grew while reading")?; bytes.extend_from_slice(&chunk[..count]); }
    let after = file.metadata().context("restat local authorization")?;
    ensure(bytes.len() as u64 == before.len() && same_metadata(&before, &after), "local authorization changed during read")?; Ok((bytes, after))
}
fn open_directory(path: &Path) -> Result<File> {
    fsx::real_path(path)?;
    let raw = unsafe { libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if raw < 0 { return Err(last("open local directory root")); }
    let mut directory = unsafe { File::from_raw_fd(raw) };
    for component in path.components() {
        let Component::Normal(name) = component else { continue; };
        let name = match CString::new(name.as_bytes()) { Ok(name) => name, Err(_) => return merge(Err(reject("NUL in local directory component")), close(directory)) };
        let next = open_at(&directory, &name, libc::O_RDONLY | libc::O_DIRECTORY);
        directory = match (next, close(directory)) { (Ok(next), Ok(())) => next, (Err(error), cleanup) => return merge(Err(error), cleanup), (Ok(next), Err(error)) => return merge(Err(error), close(next)) };
    }
    Ok(directory)
}
fn open_at(directory: &File, name: &CStr, flags: i32) -> Result<File> {
    let raw = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC, 0o600) };
    if raw < 0 { Err(last("open anchored local entry")) } else { Ok(unsafe { File::from_raw_fd(raw) }) }
}
fn named_identity(directory: &File, name: &CStr) -> Result<LocalFileIdentity> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstatat(directory.as_raw_fd(), name.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 { return Err(last("inspect anchored local entry")); }
    Ok(LocalFileIdentity::stat(&unsafe { stat.assume_init() }))
}
struct Limited { bytes: Vec<u8> }
impl Write for Limited {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_BYTES.saturating_sub(self.bytes.len()) { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "local receipt exceeds 16KiB")); }
        self.bytes.extend_from_slice(bytes); Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
fn publish(session: &mut Session, evidence: ReadyEvidence) -> Result<()> {
    evidence.validate(&session.authorization.request.version)?;
    if let Some(reason) = &evidence.history_reason { ensure(!reason.is_empty() && reason.len() <= 512, "invalid local history evidence reason")?; }
    let receipt = ReadyReceipt { request: session.authorization.request.clone(), checked_at_ms: fsx::now_ms()?, evidence };
    let mut encoded = Limited { bytes: Vec::with_capacity(MAX_BYTES) }; serde_json::to_writer(&mut encoded, &receipt)?;
    let pending = CString::new(format!(".receipt-{}.pending", uuid::Uuid::new_v4())).expect("UUID filename");
    let mut output = None; let mut created = None; let mut opened = false; let mut published = false;
    let result = (|| {
        session.validate()?;
        output = Some(open_at(session.files.get(DIRECTORY), &pending, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)?);
        opened = true;
        let file = output.as_mut().expect("created local receipt"); let metadata = file.metadata().context("inspect created local receipt")?; created = Some(LocalFileIdentity::metadata(&metadata)); private_file(&metadata)?;
        file.write_all(&encoded.bytes).context("write local receipt")?; file.sync_all().context("fsync local receipt")?;
        close(output.take().expect("close local receipt"))?;
        session.validate()?;
        rename_exclusive(session.files.get(DIRECTORY), &pending, c"receipt.json")?; published = true;
        session.files.get(DIRECTORY).sync_all().context("fsync local receipt directory")?;
        session.validate()?;
        ensure(named_identity(session.files.get(DIRECTORY), c"receipt.json")? == *created.as_ref().expect("created identity"), "local receipt name or ownership changed")
    })();
    let result = if let Some(file) = output { merge(result, close(file)) } else { result };
    if result.is_err() {
        if let Some(identity) = created {
            let name = if published { c"receipt.json" } else { pending.as_c_str() };
            return merge(result, remove_owned(session.files.get(DIRECTORY), name, &identity));
        } else if opened {
            return merge(result, Err(reject("local pending receipt identity could not be established; preserving the entry for diagnosis")));
        }
    }
    result
}
fn rename_exclusive(directory: &File, from: &CStr, to: &CStr) -> Result<()> {
    #[cfg(target_os = "macos")]
    let status = unsafe { libc::renameatx_np(directory.as_raw_fd(), from.as_ptr(), directory.as_raw_fd(), to.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let status = unsafe { libc::renameat2(directory.as_raw_fd(), from.as_ptr(), directory.as_raw_fd(), to.as_ptr(), libc::RENAME_NOREPLACE) };
    if status == 0 { Ok(()) } else { Err(last("publish exclusive local receipt")) }
}
fn remove_owned(directory: &File, name: &CStr, expected: &LocalFileIdentity) -> Result<()> {
    ensure(named_identity(directory, name)? == *expected, "refusing to remove a replaced local receipt")?;
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0 { return Err(last("remove failed local receipt")); }
    directory.sync_all().context("fsync local receipt cleanup")
}
fn close(file: File) -> Result<()> { if unsafe { libc::close(file.into_raw_fd()) } == 0 { Ok(()) } else { Err(last("close local readiness descriptor")) } }
fn last(operation: &str) -> crate::Error { crate::Error::Io { operation: operation.into(), source: std::io::Error::last_os_error() } }
fn merge<T>(result: Result<T>, cleanup: Result<()>) -> Result<T> { match (result, cleanup) { (result, Ok(())) => result, (Ok(_), Err(error)) => Err(error), (Err(first), Err(last)) => Err(combine(first, last)) } }

#[cfg(test)]
#[path = "local_tests.rs"]
mod tests;
