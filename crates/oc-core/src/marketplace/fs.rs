//! All transaction filesystem work runs under BoundedIo::with_file_budget. Openat
//! anchors every component to an owned directory descriptor; no symlink traversal.
use super::model::DISK_BYTES;
use crate::{error::{Error, Result, check_cancel}, io::FileIdentity};
use std::{ffi::{CStr, CString}, fs::File, io::{Read, Write}, os::{fd::{AsRawFd, FromRawFd, IntoRawFd}, unix::{ffi::OsStrExt, fs::MetadataExt}}, path::{Component, Path, PathBuf}, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) struct Dir { file: File, pub path: PathBuf }
impl Dir {
    pub fn profile(profile: &Path) -> Result<Arc<Self>> {
        if !profile.is_absolute() || profile.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) { return Err(Error::invalid("market profile path")); }
        let mut fd = unsafe { libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
        if fd < 0 { return Err(last("open profile root")); }
        for component in profile.components() {
            let Component::Normal(name) = component else { continue; };
            let name = CString::new(name.as_bytes()).map_err(|_| Error::invalid("profile component"))?;
            let next = unsafe { libc::openat(fd, name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
            let error = if next < 0 { Some(last("open profile component")) } else { None };
            let closed = close_fd(fd); if let Some(error) = error { closed?; return Err(error); } closed?; fd = next;
        }
        let dir = Self { file: unsafe { File::from_raw_fd(fd) }, path: profile.to_owned() };
        let metadata = dir.file.metadata().map_err(|e| Error::io("profile metadata", e))?;
        if metadata.uid() != unsafe { libc::getuid() } || metadata.mode() & 0o022 != 0 { return Err(Error::invalid("profile ownership/permissions")); }
        Ok(Arc::new(dir.child("plugins-v2", true)?))
    }
    pub fn identity(&self) -> Result<FileIdentity> { Ok(FileIdentity::from_metadata(&self.file.metadata().map_err(|e| Error::io("directory metadata", e))?)) }
    pub fn child(&self, name: &str, create: bool) -> Result<Self> {
        let cname = name_c(name)?;
        if create && unsafe { libc::mkdirat(self.file.as_raw_fd(), cname.as_ptr(), 0o700) } != 0 {
            let e = std::io::Error::last_os_error(); if e.raw_os_error() != Some(libc::EEXIST) { return Err(Error::io("private directory create", e)); }
        }
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), cname.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { return Err(last("private directory open")); }
        let dir = Self { file: unsafe { File::from_raw_fd(fd) }, path: self.path.join(name) };
        let m = dir.file.metadata().map_err(|e| Error::io("private directory metadata", e))?;
        if m.uid() != unsafe { libc::getuid() } || m.mode() & 0o077 != 0 { return Err(Error::invalid("private directory ownership/permissions")); }
        Ok(dir)
    }
    pub fn exists(&self, name: &str) -> Result<bool> {
        let name = name_c(name)?; let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstatat(self.file.as_raw_fd(), name.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } == 0 { return Ok(true); }
        let e = std::io::Error::last_os_error(); if e.raw_os_error() == Some(libc::ENOENT) { Ok(false) } else { Err(Error::io("private entry metadata", e)) }
    }
    pub fn names(&self, maximum: usize) -> Result<Vec<String>> {
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), c".".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { return Err(last("private directory enumerate open")); }
        let dir = unsafe { libc::fdopendir(fd) }; if dir.is_null() { let error = last("private directory enumerate"); close_fd(fd)?; return Err(error); }
        let result = (|| {
            let mut names = Vec::new();
            loop {
                unsafe { *libc::__error() = 0; }
                let entry = unsafe { libc::readdir(dir) };
                if entry.is_null() { if unsafe { *libc::__error() } != 0 { return Err(last("private directory read")); } break; }
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_str().map_err(|_| Error::invalid("private directory name encoding"))?;
                if name == "." || name == ".." { continue; }
                if names.len() >= maximum { return Err(Error::limit("private directory entries", maximum, names.len() + 1)); }
                name_c(name)?; names.push(name.to_owned());
            }
            names.sort(); Ok(names)
        })();
        let close = if unsafe { libc::closedir(dir) } == 0 { Ok(()) } else { Err(Error::cleanup("directory enumeration", last("closedir"))) };
        merge(result, close)
    }
    pub fn open_read(&self, name: &str) -> Result<File> {
        let name = name_c(name)?;
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC) };
        if fd < 0 { return Err(last("private file open")); }
        let file = unsafe { File::from_raw_fd(fd) }; regular(&file)?; Ok(file)
    }
    pub fn create(&self, name: &str) -> Result<File> {
        let name = name_c(name)?;
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC, 0o600) };
        if fd < 0 { return Err(last("private file create")); }
        let file = unsafe { File::from_raw_fd(fd) }; regular(&file)?; Ok(file)
    }
    pub fn read(&self, name: &str, maximum: usize, cancel: &CancellationToken) -> Result<Vec<u8>> {
        let mut file = self.open_read(name)?;
        let result = (|| {
            check_cancel(cancel)?;
            let before = regular(&file)?;
            if before.size > maximum as u64 { return Err(Error::limit("private file", maximum, before.size as usize)); }
            let mut bytes = Vec::with_capacity(before.size as usize); let mut chunk = [0u8; 64 * 1024];
            loop { check_cancel(cancel)?; let count = file.read(&mut chunk).map_err(|e| Error::io("private file read", e))?; if count == 0 { break; } if count > maximum - bytes.len() { return Err(Error::limit("private file", maximum, bytes.len() + count)); } bytes.extend_from_slice(&chunk[..count]); }
            if regular(&file)? != before || bytes.len() as u64 != before.size { return Err(Error::new("OC_PLUGIN_CHANGED", "Private file changed during read")); }
            Ok(bytes)
        })(); merge(result, close(file))
    }
    pub fn write(&self, name: &str, bytes: &[u8], cancel: &CancellationToken) -> Result<()> {
        let mut file = self.create(name)?;
        let result = (|| { for chunk in bytes.chunks(64 * 1024) { check_cancel(cancel)?; file.write_all(chunk).map_err(|e| Error::io("private file write", e))?; } file.sync_all().map_err(|e| Error::io("private file fsync", e)) })();
        merge(result, close(file))
    }
    pub fn atomic(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let temporary = format!("{name}.new");
        if self.exists(&temporary)? { return Err(Error::new("OC_PLUGIN_INTERRUPTED", "Unfinished journal write requires recovery")); }
        self.write(&temporary, bytes, &CancellationToken::new())?;
        self.rename(&temporary, name)?; self.sync()
    }
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let from = name_c(from)?; let to = name_c(to)?;
        if unsafe { libc::renameat(self.file.as_raw_fd(), from.as_ptr(), self.file.as_raw_fd(), to.as_ptr()) } != 0 { return Err(last("private atomic rename")); }
        self.sync()
    }
    pub fn unlink(&self, name: &str) -> Result<()> {
        let name = name_c(name)?;
        if unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0) } != 0 { return Err(last("private file unlink")); } self.sync()
    }
    pub fn remove_tree(&self, name: &str) -> Result<()> {
        let dir = self.child(name, false)?;
        for entry in dir.names(32)? {
            let cname = name_c(&entry)?; let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe { libc::fstatat(dir.file.as_raw_fd(), cname.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 { return Err(last("private delete metadata")); }
            let stat = unsafe { stat.assume_init() };
            match stat.st_mode & libc::S_IFMT {
                libc::S_IFDIR => dir.remove_tree(&entry)?,
                // Unlinking a symlink removes the link itself without following it;
                // this allows explicit uninstall of a damaged package safely.
                libc::S_IFREG | libc::S_IFLNK => dir.unlink(&entry)?,
                _ => return Err(Error::invalid("unexpected private file type")),
            }
        }
        drop(dir); let cname = name_c(name)?;
        if unsafe { libc::unlinkat(self.file.as_raw_fd(), cname.as_ptr(), libc::AT_REMOVEDIR) } != 0 { return Err(last("private directory remove")); } self.sync()
    }
    pub fn sync(&self) -> Result<()> { self.file.sync_all().map_err(|e| Error::io("private directory fsync", e)) }
    pub fn disk_usage(&self) -> Result<u64> { self.usage(0) }
    fn usage(&self, depth: usize) -> Result<u64> {
        if depth > 10 { return Err(Error::invalid("private directory nesting")); }
        let mut total = 0u64;
        for name in self.names(64)? {
            let cname = name_c(&name)?; let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe { libc::fstatat(self.file.as_raw_fd(), cname.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 { return Err(last("private disk metadata")); }
            let stat = unsafe { stat.assume_init() };
            let size = match stat.st_mode & libc::S_IFMT { libc::S_IFDIR => self.child(&name, false)?.usage(depth + 1)?, libc::S_IFREG if stat.st_nlink == 1 && stat.st_size >= 0 => stat.st_size as u64, _ => return Err(Error::invalid("private disk entry type")) };
            total = total.checked_add(size).ok_or_else(|| Error::invalid("private disk total"))?;
            if total > DISK_BYTES { return Err(Error::limit("plugin installation disk", DISK_BYTES as usize, total as usize)); }
        }
        Ok(total)
    }
    pub fn executable(&self, name: &str) -> Result<()> {
        let file = self.open_read(name)?;
        let result = if unsafe { libc::fchmod(file.as_raw_fd(), 0o700) } == 0 { file.sync_all().map_err(|e| Error::io("executable fsync", e)) } else { Err(last("executable permissions")) };
        merge(result, close(file))
    }
}
fn name_c(name: &str) -> Result<CString> {
    if name.is_empty() || name.len() > 255 || name == "." || name == ".." || name.contains('/') || name.contains('\\') { return Err(Error::invalid("private child name")); }
    CString::new(name).map_err(|_| Error::invalid("private child NUL"))
}
pub(super) fn regular(file: &File) -> Result<FileIdentity> {
    let metadata = file.metadata().map_err(|e| Error::io("private file metadata", e))?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != unsafe { libc::getuid() } || metadata.mode() & 0o077 != 0 { return Err(Error::invalid("private file identity or permissions")); }
    Ok(FileIdentity::from_metadata(&metadata))
}
pub(super) fn close(file: File) -> Result<()> { close_fd(file.into_raw_fd()) }
fn close_fd(fd: i32) -> Result<()> { if unsafe { libc::close(fd) } == 0 { Ok(()) } else { Err(Error::cleanup("private file descriptor", last("close"))) } }
fn last(operation: &str) -> Error { Error::io(operation, std::io::Error::last_os_error()) }
pub(super) fn merge<T>(result: Result<T>, cleanup: Result<()>) -> Result<T> { match (result, cleanup) { (result, Ok(())) => result, (Ok(_), Err(error)) => Err(error), (Err(error), Err(cleanup)) => Err(Error::aggregate(vec![error, cleanup])) } }
