//! Filesystem operations are descriptor-relative; downloaded paths never select
//! a profile, an installation target, or an executable. Call only inside a lease.
use crate::error::{Error, Result};
use std::{ffi::{CStr, CString}, fs::File, os::{fd::{AsRawFd, FromRawFd, IntoRawFd}, unix::fs::MetadataExt}, path::{Component, Path, PathBuf}};

pub(super) struct Dir { file: File, pub path: PathBuf }
impl Dir {
    pub fn profile(path: &Path) -> Result<Self> {
        if !path.is_absolute() || path.as_os_str().len() > 4096 || path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) { return Err(Error::invalid("update profile")); }
        let raw = unsafe { libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
        if raw < 0 { return Err(last("open update profile root")); }
        let mut dir = Self { file: unsafe { File::from_raw_fd(raw) }, path: PathBuf::from("/") };
        for component in path.components() {
            if let Component::Normal(name) = component {
                let name = name.to_str().ok_or_else(|| Error::invalid("update profile encoding"))?;
                let next = dir.child(name)?; close(dir.file)?; dir = next;
            }
        }
        dir.private(false)?;
        match dir.mkdir("updates-v2", 0o700) { Ok(()) => (), Err(e) if e.code == "EEXIST" => (), Err(e) => return Err(e) }
        let root = dir.child("updates-v2")?; root.private(true)?; dir.sync()?; close(dir.file)?; Ok(root)
    }
    pub fn private(&self, strict: bool) -> Result<()> {
        let m = self.file.metadata().map_err(|e| Error::io("update directory metadata", e))?;
        if m.uid() != unsafe { libc::getuid() } || m.mode() & (if strict { 0o077 } else { 0o022 }) != 0 { return Err(Error::invalid("update directory ownership/permissions")); }
        Ok(())
    }
    pub fn identity(&self) -> Result<crate::io::FileIdentity> {
        Ok(crate::io::FileIdentity::from_metadata(&self.file.metadata().map_err(|e| Error::io("update directory identity", e))?))
    }
    pub fn verify_path(&self) -> Result<()> {
        let m = std::fs::symlink_metadata(&self.path).map_err(|e| Error::io("update directory path", e))?;
        let own = self.file.metadata().map_err(|e| Error::io("update directory handle", e))?;
        if !m.is_dir() || m.dev() != own.dev() || m.ino() != own.ino() { return Err(Error::invalid("update directory replaced")); }
        Ok(())
    }
    pub fn mkdir(&self, name: &str, mode: u32) -> Result<()> {
        let name = name_c(name)?;
        if unsafe { libc::mkdirat(self.file.as_raw_fd(), name.as_ptr(), mode as libc::mode_t) } != 0 { return Err(last("update directory create")); }
        Ok(())
    }
    pub fn child(&self, name: &str) -> Result<Self> {
        let cname = name_c(name)?;
        let raw = unsafe { libc::openat(self.file.as_raw_fd(), cname.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if raw < 0 { return Err(last("update directory open")); }
        Ok(Self { file: unsafe { File::from_raw_fd(raw) }, path: self.path.join(name) })
    }
    pub fn descend(&self, components: &[&str]) -> Result<Self> {
        let raw = unsafe { libc::openat(self.file.as_raw_fd(), c".".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if raw < 0 { return Err(last("update directory duplicate")); }
        let mut dir = Self { file: unsafe { File::from_raw_fd(raw) }, path: self.path.clone() };
        for component in components { let next = dir.child(component)?; close(dir.file)?; dir = next; }
        Ok(dir)
    }
    pub fn create(&self, name: &str) -> Result<File> {
        let name = name_c(name)?;
        let raw = unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC, 0o600) };
        if raw < 0 { return Err(last("update file create")); }
        Ok(unsafe { File::from_raw_fd(raw) })
    }
    pub fn read(&self, name: &str) -> Result<File> {
        let name = name_c(name)?;
        let raw = unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC) };
        if raw < 0 { return Err(last("update file open")); }
        let file = unsafe { File::from_raw_fd(raw) }; let m = file.metadata().map_err(|e| Error::io("update file metadata", e))?;
        if !m.is_file() || m.nlink() != 1 || m.uid() != unsafe { libc::getuid() } { return merge(Err(Error::invalid("update file identity")), close(file)); }
        Ok(file)
    }
    pub fn symlink(&self, name: &str, target: &str) -> Result<()> {
        let name = name_c(name)?; let target = CString::new(target).map_err(|_| Error::invalid("update link NUL"))?;
        if unsafe { libc::symlinkat(target.as_ptr(), self.file.as_raw_fd(), name.as_ptr()) } != 0 { return Err(last("update symlink create")); }
        self.sync()
    }
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let from = name_c(from)?; let to = name_c(to)?;
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::renameatx_np(self.file.as_raw_fd(), from.as_ptr(), self.file.as_raw_fd(), to.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(target_os = "linux")]
        let result = unsafe { libc::renameat2(self.file.as_raw_fd(), from.as_ptr(), self.file.as_raw_fd(), to.as_ptr(), libc::RENAME_NOREPLACE) };
        if result != 0 { return Err(last("update exclusive rename")); }
        self.sync()
    }
    pub fn unlink(&self, name: &str) -> Result<()> {
        let name = name_c(name)?;
        if unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0) } != 0 { return Err(last("update unlink")); }
        self.sync()
    }
    pub fn remove_tree(&self, name: &str) -> Result<()> { let mut count = 0; self.remove_inner(name, 0, &mut count) }
    fn remove_inner(&self, name: &str, depth: usize, count: &mut usize) -> Result<()> {
        if depth > 66 || *count > 4106 { return Err(Error::invalid("update cleanup tree bounds")); }
        let dir = self.child(name)?;
        // Signed bundles may contain read-only directories; cleanup owns this
        // staging copy and restores owner access through the verified descriptor.
        dir.permissions(0o700)?;
        // Reserve the whole enumerated batch before recursion; malicious nested
        // directories cannot retain one maximum-size name list per level.
        let names = dir.names(4106 - *count)?; *count += names.len();
        for entry in names {
            let cname = name_c(&entry)?; let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe { libc::fstatat(dir.file.as_raw_fd(), cname.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 { return Err(last("update cleanup metadata")); }
            let stat = unsafe { stat.assume_init() };
            if stat.st_mode & libc::S_IFMT == libc::S_IFDIR { dir.remove_inner(&entry, depth + 1, count)?; } else { dir.unlink(&entry)?; }
        }
        close(dir.file)?;
        let name = name_c(name)?;
        if unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } != 0 { return Err(last("update remove directory")); }
        self.sync()
    }
    pub fn names(&self, maximum: usize) -> Result<Vec<String>> {
        let raw = unsafe { libc::openat(self.file.as_raw_fd(), c".".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if raw < 0 { return Err(last("update enumerate open")); }
        let dir = unsafe { libc::fdopendir(raw) };
        if dir.is_null() { let error = last("update enumerate"); return merge(Err(error), close_raw(raw)); }
        let result = (|| {
            let mut names = Vec::new();
            loop {
                set_errno(0); let entry = unsafe { libc::readdir(dir) };
                if entry.is_null() { if errno() != 0 { return Err(last("update readdir")); } break; }
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_str().map_err(|_| Error::invalid("update entry encoding"))?;
                if name == "." || name == ".." { continue; }
                if names.len() == maximum { return Err(Error::limit("update directory", maximum, maximum + 1)); }
                name_c(name)?; names.push(name.to_owned());
            }
            Ok(names)
        })();
        let closed = if unsafe { libc::closedir(dir) } == 0 { Ok(()) } else { Err(Error::cleanup("update directory stream", last("closedir"))) };
        merge(result, closed)
    }
    pub fn space(&self, size: u64) -> Result<()> {
        let required = size.checked_mul(5).and_then(|n| n.checked_add(256 * 1024 * 1024)).ok_or_else(|| Error::invalid("update disk bound"))?;
        let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if unsafe { libc::fstatvfs(self.file.as_raw_fd(), stat.as_mut_ptr()) } != 0 { return Err(last("update available disk")); }
        let stat = unsafe { stat.assume_init() }; let available = (stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64);
        if available < required { return Err(Error::new("OC_UPDATE_SPACE", "更新空间不足 / Insufficient update disk space")); }
        Ok(())
    }
    pub fn permissions(&self, mode: u32) -> Result<()> {
        if unsafe { libc::fchmod(self.file.as_raw_fd(), mode as libc::mode_t) } != 0 { return Err(last("update directory permissions")); }
        self.sync()
    }
    pub fn sync(&self) -> Result<()> { self.file.sync_all().map_err(|e| Error::io("update directory fsync", e)) }
    pub fn close(self) -> Result<()> { close(self.file) }
}
fn name_c(name: &str) -> Result<CString> {
    if name.is_empty() || name.len() > 255 || name == "." || name == ".." || name.contains(['/', '\\']) { return Err(Error::invalid("update child name")); }
    CString::new(name).map_err(|_| Error::invalid("update child NUL"))
}
fn last(context: &str) -> Error { Error::io(context, std::io::Error::last_os_error()) }
#[cfg(target_os = "macos")]
fn set_errno(value: i32) { unsafe { *libc::__error() = value; } }
#[cfg(target_os = "macos")]
fn errno() -> i32 { unsafe { *libc::__error() } }
#[cfg(target_os = "linux")]
fn set_errno(value: i32) { unsafe { *libc::__errno_location() = value; } }
#[cfg(target_os = "linux")]
fn errno() -> i32 { unsafe { *libc::__errno_location() } }
fn close_raw(raw: i32) -> Result<()> { if unsafe { libc::close(raw) } == 0 { Ok(()) } else { Err(Error::cleanup("update file descriptor", last("close"))) } }
pub(super) fn close(file: File) -> Result<()> { close_raw(file.into_raw_fd()) }
pub(super) fn merge<T>(result: Result<T>, cleanup: Result<()>) -> Result<T> {
    match (result, cleanup) { (result, Ok(())) => result, (Ok(_), Err(error)) => Err(error), (Err(error), Err(cleanup)) => Err(Error::aggregate(vec![error, cleanup])) }
}
