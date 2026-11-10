use crate::{ensure, reject, FileIdentity, IoResult, Result};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha512};
use std::{ffi::CString, fs::{self, File, OpenOptions}, io::{Read, Write}, os::unix::{ffi::OsStrExt, fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt, symlink}, io::AsRawFd}, path::{Component, Path, PathBuf}, time::{Instant, SystemTime, UNIX_EPOCH}};

pub(crate) const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAX_DEPTH: usize = 64;

pub(crate) fn now_ms() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| reject(e.to_string()))?.as_millis() as u64)
}
pub(crate) fn deadline(deadline: Instant) -> Result<()> {
    ensure(Instant::now() < deadline, "installation deadline exceeded")
}
pub(crate) fn identity(path: &Path) -> Result<FileIdentity> {
    let m = fs::symlink_metadata(path).context(format!("stat {}", path.display()))?;
    ensure(!m.file_type().is_symlink(), "identity path is a symlink")?;
    Ok(FileIdentity { device: m.dev(), inode: m.ino() })
}
pub(crate) fn optional_identity(path: &Path) -> Result<Option<FileIdentity>> {
    match fs::symlink_metadata(path) {
        Ok(m) => {
            ensure(m.is_dir() && !m.file_type().is_symlink(), "bundle position contains a non-directory")?;
            Ok(Some(FileIdentity { device: m.dev(), inode: m.ino() }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(crate::Error::Io { operation: format!("stat {}", path.display()), source: e }),
    }
}
pub(crate) fn expect_identity(path: &Path, expected: FileIdentity) -> Result<()> {
    ensure(identity(path)? == expected, "file identity changed; preserving installation evidence")
}
/// Reject symlinks in *every* existing path component, not just the final component.
pub(crate) fn real_path(path: &Path) -> Result<PathBuf> {
    ensure(path.is_absolute() && path.as_os_str().len() <= 4096, "path must be absolute and bounded")?;
    let mut cursor = PathBuf::new();
    for component in path.components() {
        ensure(matches!(component, Component::RootDir | Component::Normal(_)), "non-normal path component")?;
        cursor.push(component);
        let m = fs::symlink_metadata(&cursor).context(format!("inspect {}", cursor.display()))?;
        ensure(!m.file_type().is_symlink(), "symlink in controlled path")?;
    }
    ensure(fs::canonicalize(path).context("canonicalize controlled path")? == path, "noncanonical controlled path")?;
    Ok(path.to_owned())
}
pub(crate) fn parent_directory(path: &Path) -> Result<FileIdentity> {
    real_path(path)?;
    let m = fs::symlink_metadata(path).context("inspect installation parent")?;
    // /Applications is commonly root:admin 0775. Group-write there is legitimate;
    // arbitrary user-owned parents must be private to that user.
    ensure(m.is_dir() && (m.uid() == unsafe { libc::geteuid() } || m.uid() == 0)
        && m.mode() & 0o002 == 0 && (m.uid() == 0 || m.mode() & 0o020 == 0),
        "unsafe installation parent owner or permissions")?;
    identity(path)
}
pub(crate) fn private_directory(path: &Path) -> Result<FileIdentity> {
    real_path(path)?;
    let m = fs::symlink_metadata(path).context("inspect private directory")?;
    ensure(m.is_dir() && m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o7777 == 0o700,
        "transaction directory must be owned 0700")?;
    identity(path)
}
pub(crate) fn mkdir_private(path: &Path) -> Result<()> {
    fs::DirBuilder::new().mode(0o700).create(path).context(format!("create {}", path.display()))?;
    sync_directory(path.parent().ok_or_else(|| reject("missing directory parent"))?)
}
pub(crate) fn sync_directory(path: &Path) -> Result<()> {
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(path).context(format!("open directory {}", path.display()))?;
    file.sync_all().context(format!("fsync directory {}", path.display()))
}
pub(crate) fn private_file(path: &Path) -> Result<File> {
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path).context(format!("open private file {}", path.display()))?;
    let m = file.metadata().context("inspect private file")?;
    ensure(m.is_file() && m.nlink() == 1 && m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o7777 == 0o600,
        "metadata must be an owned 0600 single-link regular file")?;
    Ok(file)
}
pub(crate) fn read_private_json<T: DeserializeOwned>(path: &Path, maximum: u64) -> Result<T> {
    private_directory(path.parent().ok_or_else(|| reject("metadata has no parent"))?)?;
    let mut file = private_file(path)?;
    let before = file.metadata().context("stat metadata")?;
    ensure(before.len() > 0 && before.len() <= maximum, "metadata exceeds size limit")?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file).take(maximum + 1).read_to_end(&mut bytes).context("read metadata")?;
    let after = file.metadata().context("restat metadata")?;
    ensure(bytes.len() as u64 == before.len() && same_metadata(&before, &after), "metadata changed during read")?;
    expect_identity(path, FileIdentity { device: before.dev(), inode: before.ino() })?;
    Ok(serde_json::from_slice(&bytes)?)
}
fn same_metadata(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino() && a.len() == b.len()
        && a.mtime() == b.mtime() && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime() && a.ctime_nsec() == b.ctime_nsec()
}
pub(crate) fn create_private(path: &Path) -> Result<File> {
    OpenOptions::new().write(true).create_new(true).mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path).context(format!("create {}", path.display()))
}
pub(crate) fn atomic_json<T: Serialize>(path: &Path, value: &T, maximum: usize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure(bytes.len() <= maximum, "serialized metadata exceeds budget")?;
    let parent = path.parent().ok_or_else(|| reject("metadata has no parent"))?;
    private_directory(parent)?;
    // Unique temporary names allow recovery of an interrupted record write without
    // overwriting or trusting the uncommitted temporary record.
    let pending = parent.join(format!(".record-{}.pending", uuid::Uuid::new_v4()));
    let mut file = create_private(&pending)?;
    file.write_all(&bytes).context("write journal")?;
    file.sync_all().context("fsync journal")?;
    drop(file);
    fs::rename(&pending, path).context("publish journal")?;
    sync_directory(parent)
}
pub(crate) fn publish_private_json<T: Serialize>(path: &Path, value: &T, maximum: usize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure(bytes.len() <= maximum, "receipt exceeds budget")?;
    let parent = path.parent().ok_or_else(|| reject("receipt has no parent"))?;
    private_directory(parent)?;
    let pending = parent.join(format!(".receipt-{}.pending", uuid::Uuid::new_v4()));
    let mut file = create_private(&pending)?;
    file.write_all(&bytes).context("write receipt")?;
    file.sync_all().context("fsync receipt")?;
    drop(file);
    // link is atomic and refuses an existing destination; unlink restores nlink=1
    // before the reader may accept the receipt. A transient nlink=2 is avoided by
    // using the platform exclusive rename primitive below.
    rename_exclusive(&pending, path)?;
    sync_directory(parent)
}
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> Result<()> {
    let from = CString::new(from.as_os_str().as_bytes()).map_err(|_| reject("NUL in rename path"))?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(|_| reject("NUL in rename path"))?;
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let result = unsafe { libc::renameat2(libc::AT_FDCWD, from.as_ptr(), libc::AT_FDCWD, to.as_ptr(), libc::RENAME_NOREPLACE) };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    compile_error!("oc-installer requires macOS; Linux is supported for filesystem recovery tests");
    if result != 0 { return Err(crate::Error::Io { operation: "exclusive rename".into(), source: std::io::Error::last_os_error() }); }
    Ok(())
}

pub(crate) struct InstallLock { file: File, pub identity: FileIdentity }
impl InstallLock {
    pub fn acquire(parent: &Path, wait_until: Option<Instant>) -> Result<Self> {
        parent_directory(parent)?;
        let path = parent.join(".oc-chan-install.lock");
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&path).context("open installation lock")?;
        let m = file.metadata().context("stat lock")?;
        ensure(m.is_file() && m.nlink() == 1 && m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o7777 == 0o600,
            "unsafe installation lock")?;
        loop {
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 { break; }
            let e = std::io::Error::last_os_error();
            if e.kind() != std::io::ErrorKind::WouldBlock { return Err(crate::Error::Io { operation: "lock installation".into(), source: e }); }
            let end = wait_until.ok_or_else(|| reject("another installation owns the lock"))?;
            deadline(end)?;
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let identity = FileIdentity { device: m.dev(), inode: m.ino() };
        expect_identity(&path, identity)?;
        Ok(Self { file, identity })
    }
    pub fn check(&self, parent: &Path) -> Result<()> {
        let m = self.file.metadata().context("restat held lock")?;
        ensure(m.nlink() == 1, "held lock was unlinked")?;
        expect_identity(&parent.join(".oc-chan-install.lock"), self.identity)
    }
}

struct Inventory {
    entries: Vec<(PathBuf, fs::Metadata)>,
    bytes: u64,
}
fn inventory(root: &Path, end: Instant) -> Result<Inventory> {
    real_path(root)?;
    ensure(fs::symlink_metadata(root).context("stat bundle")?.is_dir(), "bundle is not a directory")?;
    let mut result = Inventory { entries: Vec::new(), bytes: 0 };
    let mut directories = vec![(root.to_owned(), 0usize)];
    while let Some((directory, depth)) = directories.pop() {
        deadline(end)?;
        ensure(depth < MAX_DEPTH, "bundle directory depth exceeded")?;
        for entry in fs::read_dir(&directory).context("enumerate bundle")? {
            deadline(end)?;
            ensure(result.entries.len() < MAX_ENTRIES, "bundle entry limit exceeded")?;
            let path = entry.context("read bundle entry")?.path();
            let relative = path.strip_prefix(root).map_err(|_| reject("bundle path escape"))?.to_owned();
            ensure(relative.as_os_str().len() <= 4096, "bundle path too long")?;
            let m = fs::symlink_metadata(&path).context("inspect bundle entry")?;
            ensure(m.mode() & 0o7000 == 0, "special bundle mode")?;
            if m.file_type().is_symlink() {
                let target = fs::read_link(&path).context("read bundle symlink")?;
                ensure(!target.is_absolute() && target.as_os_str().len() <= 4096, "absolute or oversized bundle symlink")?;
                let resolved = fs::canonicalize(&path).context("resolve bundle symlink")?;
                ensure(resolved.starts_with(root), "bundle symlink escapes bundle")?;
            } else if m.is_dir() { directories.push((path.clone(), depth + 1)); }
            else {
                ensure(m.is_file() && m.nlink() == 1, "bundle contains hardlinks or special files")?;
                result.bytes = result.bytes.checked_add(m.len()).ok_or_else(|| reject("bundle size overflow"))?;
                ensure(result.bytes <= MAX_BYTES, "expanded bundle exceeds 2 GiB")?;
            }
            result.entries.push((relative, m));
        }
    }
    result.entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(result)
}
/// SHA-512 over length-delimited relative paths, type, mode, size and bytes.
/// Symlinks are hashed as relative link text; no symlink target is read as a file.
/// Bounded to 20,000 entries, depth 64, 2 GiB and 30 seconds.
pub fn bundle_digest(root: &Path) -> Result<String> {
    digest_until(root, Instant::now() + std::time::Duration::from_secs(30))
}
pub(crate) fn digest_until(root: &Path, end: Instant) -> Result<String> {
    let entries = inventory(root, end)?;
    let mut digest = Sha512::new();
    let mut buffer = [0u8; 64 * 1024];
    for (relative, m) in entries.entries {
        deadline(end)?;
        let bytes = relative.as_os_str().as_bytes();
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
        digest.update((m.mode() & 0o7777).to_le_bytes());
        let path = root.join(relative);
        if m.file_type().is_symlink() {
            digest.update(b"L");
            let link = fs::read_link(&path).context("hash symlink")?;
            digest.update((link.as_os_str().len() as u64).to_le_bytes());
            digest.update(link.as_os_str().as_bytes());
        } else if m.is_dir() { digest.update(b"D"); }
        else {
            digest.update(b"F");
            digest.update(m.len().to_le_bytes());
            let mut file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&path).context("open bundle file")?;
            ensure(same_metadata(&m, &file.metadata().context("stat bundle file")?), "bundle changed before hash")?;
            let mut count = 0u64;
            loop {
                deadline(end)?;
                let n = file.read(&mut buffer).context("hash bundle file")?;
                if n == 0 { break; }
                count += n as u64;
                ensure(count <= m.len(), "bundle grew during hash")?;
                digest.update(&buffer[..n]);
            }
            ensure(count == m.len() && same_metadata(&m, &file.metadata().context("restat hashed file")?), "bundle changed during hash")?;
        }
        ensure(same_metadata(&m, &fs::symlink_metadata(&path).context("restat hashed path")?), "bundle entry changed during hash")?;
    }
    Ok(format!("{:x}", digest.finalize()))
}
pub(crate) fn copy_bundle(source: &Path, destination: &Path, end: Instant) -> Result<()> {
    let entries = inventory(source, end)?;
    check_space(destination.parent().ok_or_else(|| reject("stage has no parent"))?, entries.bytes)?;
    let root_mode = fs::symlink_metadata(source).context("stat source bundle")?.permissions();
    fs::create_dir(destination).context("create stage bundle")?;
    for (relative, m) in &entries.entries {
        deadline(end)?;
        let from = source.join(relative);
        let to = destination.join(relative);
        if m.is_dir() { fs::create_dir(&to).context("create staged directory")?; }
        else if m.file_type().is_symlink() { symlink(fs::read_link(&from).context("read source symlink")?, &to).context("copy bundle symlink")?; }
        else {
            let mut input = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&from).context("open source file")?;
            ensure(same_metadata(m, &input.metadata().context("stat source file")?), "source changed before copy")?;
            let mut output = OpenOptions::new().write(true).create_new(true).mode(m.mode() & 0o777)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&to).context("create staged file")?;
            let mut buffer = [0u8; 64 * 1024];
            let mut copied = 0u64;
            loop {
                deadline(end)?;
                let n = input.read(&mut buffer).context("read source chunk")?;
                if n == 0 { break; }
                copied += n as u64;
                ensure(copied <= m.len(), "source grew while copying")?;
                output.write_all(&buffer[..n]).context("write staged chunk")?;
            }
            ensure(copied == m.len() && same_metadata(m, &input.metadata().context("restat source file")?), "source changed during copy")?;
            output.set_permissions(fs::Permissions::from_mode(m.mode() & 0o777)).context("set staged file mode")?;
            output.sync_all().context("fsync staged file")?;
        }
    }
    for (relative, m) in entries.entries.iter().rev() {
        if m.is_dir() {
            let path = destination.join(relative);
            fs::set_permissions(&path, fs::Permissions::from_mode(m.mode() & 0o777)).context("set staged directory mode")?;
            sync_directory(&path)?;
        }
    }
    fs::set_permissions(destination, root_mode).context("set staged bundle mode")?;
    sync_directory(destination)?;
    sync_directory(destination.parent().ok_or_else(|| reject("stage has no parent"))?)
}
pub(crate) fn check_space(directory: &Path, bytes: u64) -> Result<()> {
    let path = CString::new(directory.as_os_str().as_bytes()).map_err(|_| reject("NUL in volume path"))?;
    let mut info = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), info.as_mut_ptr()) } != 0 {
        return Err(crate::Error::Io { operation: "stat free volume space".into(), source: std::io::Error::last_os_error() });
    }
    let info = unsafe { info.assume_init() };
    let available = u128::from(info.f_bavail) * u128::from(info.f_frsize);
    ensure(available >= u128::from(bytes) * 5 + 256 * 1024 * 1024, "insufficient disk space for transaction")
}
