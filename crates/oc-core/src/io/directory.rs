use std::{ffi::{CStr, OsStr}, fs::{File, OpenOptions}, os::{fd::IntoRawFd, unix::{ffi::OsStrExt, fs::{MetadataExt, OpenOptionsExt}}}, path::{Path, PathBuf}};
use tokio_util::sync::CancellationToken;
use crate::error::{Error, Result, check_cancel};
use super::merge_close;

struct Directory(*mut libc::DIR);
impl Directory {
    fn close(mut self) -> Result<()> {
        let raw = std::mem::replace(&mut self.0, std::ptr::null_mut());
        if unsafe { libc::closedir(raw) } != 0 {
            return Err(Error::cleanup("directory", Error::io("closedir", std::io::Error::last_os_error())));
        }
        Ok(())
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        if !self.0.is_null() && unsafe { libc::closedir(self.0) } != 0 {
            eprintln!("directory unwind cleanup: {}", std::io::Error::last_os_error());
        }
    }
}
fn close_file(file: File) -> Result<()> { close_fd(file.into_raw_fd()) }
fn close_fd(fd: i32) -> Result<()> {
    if unsafe { libc::close(fd) } != 0 {
        return Err(Error::cleanup("directory descriptor", Error::io("close", std::io::Error::last_os_error())));
    }
    Ok(())
}
fn private_metadata(uid: u32, mode: u32) -> Result<()> {
    if uid != unsafe { libc::getuid() } || mode & 0o077 != 0 {
        return Err(Error::new("OC_PRIVATE_DIRECTORY", "目录所有者或权限不安全 / Directory owner or permissions are not private"));
    }
    Ok(())
}

/// The supervisor awaits this finite worker even after cancellation. The FILE
/// lease is retained through closedir, not merely until the caller drops a future.
pub(super) fn read(path: &Path, max_entries: usize, max_name_bytes: usize, max_bytes: usize, private: bool, cancel: &CancellationToken) -> Result<Vec<PathBuf>> {
    check_cancel(cancel)?;
    let file = OpenOptions::new().read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NONBLOCK | if private { libc::O_NOFOLLOW } else { 0 })
        .open(path).map_err(|e| Error::io("directory open", e))?;
    let metadata = match file.metadata() {
        Ok(meta) => meta,
        Err(error) => return merge_close(Err(Error::io("directory metadata", error)), close_file(file)),
    };
    if private {
        if let Err(error) = private_metadata(metadata.uid(), metadata.mode()) {
            return merge_close(Err(error), close_file(file));
        }
    }
    let fd = file.into_raw_fd();
    let raw = unsafe { libc::fdopendir(fd) };
    if raw.is_null() {
        let error = Error::io("fdopendir", std::io::Error::last_os_error());
        return merge_close(Err(error), close_fd(fd));
    }
    let directory = Directory(raw);
    let result = (|| {
        let mut used = max_entries.checked_mul(std::mem::size_of::<PathBuf>()).ok_or_else(|| Error::invalid("directory allocation size"))?;
        if used > max_bytes { return Err(Error::limit("directory path bytes", max_bytes, used)); }
        let mut paths = Vec::new();
        paths.try_reserve_exact(max_entries).map_err(|_| Error::new("OC_RESOURCE_LIMIT", "bounded directory allocation refused"))?;
        loop {
            check_cancel(cancel)?;
            // readdir reports EOF and failure with the same null pointer.
            unsafe { *libc::__error() = 0; }
            let entry = unsafe { libc::readdir(directory.0) };
            if entry.is_null() {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(0) { return Err(Error::io("readdir", error)); }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if name == b"." || name == b".." { continue; }
            if paths.len() == max_entries { return Err(Error::limit("directory entries", max_entries, max_entries + 1)); }
            if name.len() > max_name_bytes { return Err(Error::limit("directory name bytes", max_name_bytes, name.len())); }
            let capacity = path.as_os_str().len() + 1 + name.len();
            if capacity > max_bytes.saturating_sub(used) { return Err(Error::limit("directory path bytes", max_bytes, used.saturating_add(capacity))); }
            used += capacity;
            let mut full = PathBuf::with_capacity(capacity);
            full.push(path); full.push(OsStr::from_bytes(name)); paths.push(full);
        }
        check_cancel(cancel)?;
        if private {
            let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe { libc::fstat(libc::dirfd(directory.0), metadata.as_mut_ptr()) } != 0 {
                return Err(Error::io("directory final metadata", std::io::Error::last_os_error()));
            }
            let metadata = unsafe { metadata.assume_init() };
            private_metadata(metadata.st_uid, metadata.st_mode as u32)?;
        }
        Ok(paths)
    })();
    merge_close(result, directory.close())
}
