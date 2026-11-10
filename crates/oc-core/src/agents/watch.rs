//! Event-only vnode descriptors avoid notify/kqueue's blocking File::open on a replaced FIFO.
//! One kqueue owns at most 128 registrations. Kernel events coalesce per registration;
//! each readiness drain copies at most 32 metadata events and retains no file contents.
use std::{collections::BTreeMap, ffi::CString, os::{fd::{AsRawFd, RawFd}, unix::ffi::OsStrExt}, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use tokio::io::unix::AsyncFd;
use crate::{error::{Error, Result}, io::FileIdentity};

pub(super) struct Signal { pub path: PathBuf, pub revision: u64, pub invalid: bool }
struct Descriptor { fd: RawFd, errors: Arc<Mutex<Vec<Error>>> }
impl AsRawFd for Descriptor { fn as_raw_fd(&self) -> RawFd { self.fd } }
impl Drop for Descriptor {
    fn drop(&mut self) {
        if unsafe { libc::close(self.fd) } != 0 {
            let error = Error::cleanup("vnode descriptor", Error::io("watch close", std::io::Error::last_os_error()));
            let mut errors = self.errors.lock().expect("watch close errors");
            if errors.len() < 16 { errors.push(error); }
        }
    }
}
struct Registration { descriptor: Descriptor, revision: u64 }
pub(super) struct FileWatcher {
    queue: AsyncFd<Descriptor>, files: BTreeMap<PathBuf, Registration>,
    by_fd: BTreeMap<RawFd, PathBuf>, errors: Arc<Mutex<Vec<Error>>>,
}
impl FileWatcher {
    pub(super) fn len(&self) -> usize { self.files.len() }
    pub(super) fn new() -> Result<Self> {
        let errors = Arc::new(Mutex::new(Vec::new()));
        let fd = unsafe { libc::kqueue() };
        if fd < 0 { return Err(Error::io("watch kqueue", std::io::Error::last_os_error())); }
        let descriptor = Descriptor { fd, errors: errors.clone() };
        // kqueue does not support F_SETFL/O_NONBLOCK on macOS; kevent's zero
        // timeout in next() makes the drain nonblocking after readiness.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            let error = Error::io("watch descriptor flags", std::io::Error::last_os_error()); drop(descriptor);
            let mut causes = errors.lock().expect("watch close errors"); causes.push(error); return Err(Error::aggregate(std::mem::take(&mut *causes)));
        }
        // Descriptor exclusively owns this open kqueue and never changes its fd.
        let queue = match unsafe { AsyncFd::register_with_interest(descriptor, tokio::io::Interest::READABLE) } {
            Ok(queue) => queue,
            Err(error) => {
                let (descriptor, error) = error.into_parts(); drop(descriptor);
                let mut causes = errors.lock().expect("watch close errors"); causes.push(Error::io("watch readiness", error));
                return Err(Error::aggregate(std::mem::take(&mut *causes)));
            },
        };
        Ok(Self { queue, files: BTreeMap::new(), by_fd: BTreeMap::new(), errors })
    }
    pub(super) fn watch(&mut self, path: &Path, revision: u64, expected: &FileIdentity) -> Result<()> {
        if self.files.len() >= super::MAX_SESSIONS { return Err(Error::limit("session watches", super::MAX_SESSIONS, self.files.len()+1)); }
        if self.files.contains_key(path) { return Err(Error::new("OC_WATCH_DUPLICATE", "会话监听重复注册")); }
        let name = CString::new(path.as_os_str().as_bytes()).map_err(|_| Error::invalid("watch path"))?;
        // O_EVTONLY does not read session data and never waits for a FIFO writer.
        let fd = unsafe { libc::open(name.as_ptr(), libc::O_EVTONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { return Err(Error::io("session watch open", std::io::Error::last_os_error())); }
        let descriptor = Descriptor { fd, errors: self.errors.clone() };
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 { return Err(Error::io("session watch identity", std::io::Error::last_os_error())); }
        let stat = unsafe { stat.assume_init() };
        if stat.st_mode & libc::S_IFMT != libc::S_IFREG || stat.st_dev as u64 != expected.dev || stat.st_ino != expected.ino {
            return Err(Error::new("OC_COLLECTION_CHANGED", "会话监听目标已替换或不是普通文件"));
        }
        let change = libc::kevent { ident: fd as libc::uintptr_t, filter: libc::EVFILT_VNODE,
            flags: libc::EV_ADD | libc::EV_CLEAR | libc::EV_ENABLE,
            fflags: libc::NOTE_WRITE | libc::NOTE_EXTEND | libc::NOTE_ATTRIB | libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_REVOKE,
            data: 0, udata: revision as usize as *mut libc::c_void };
        if unsafe { libc::kevent(self.queue.as_raw_fd(), &change, 1, std::ptr::null_mut(), 0, std::ptr::null()) } < 0 { return Err(Error::io("session watch registration", std::io::Error::last_os_error())); }
        self.by_fd.insert(fd, path.to_owned()); self.files.insert(path.to_owned(), Registration { descriptor, revision }); Ok(())
    }
    pub(super) fn unwatch(&mut self, path: &Path) -> Result<()> {
        let Some(registration) = self.files.remove(path) else { return Ok(()); };
        let fd = registration.descriptor.as_raw_fd(); self.by_fd.remove(&fd);
        let change = libc::kevent { ident: fd as libc::uintptr_t, filter: libc::EVFILT_VNODE, flags: libc::EV_DELETE, fflags: 0, data: 0, udata: std::ptr::null_mut() };
        let removed = unsafe { libc::kevent(self.queue.as_raw_fd(), &change, 1, std::ptr::null_mut(), 0, std::ptr::null()) };
        let error = if removed < 0 { Some(std::io::Error::last_os_error()) } else { None };
        drop(registration);
        if let Some(error) = error { if error.raw_os_error() != Some(libc::ENOENT) { return Err(Error::cleanup("vnode registration", Error::io("watch remove", error))); } }
        Ok(())
    }
    pub(super) async fn next(&self) -> Result<Vec<Signal>> {
        loop {
            let mut ready = self.queue.readable().await.map_err(|error| Error::io("watch readiness", error))?;
            let mut events = [std::mem::MaybeUninit::<libc::kevent>::uninit(); 32];
            let timeout = libc::timespec { tv_sec: 0, tv_nsec: 0 };
            let count = unsafe { libc::kevent(self.queue.as_raw_fd(), std::ptr::null(), 0, events.as_mut_ptr().cast(), events.len() as i32, &timeout) };
            if count < 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) { continue; }
                if error.raw_os_error() == Some(libc::EAGAIN) { ready.clear_ready(); continue; }
                return Err(Error::io("watch events", error));
            }
            if count == 0 { ready.clear_ready(); continue; }
            let mut signals = Vec::with_capacity(count as usize);
            for event in events.iter().take(count as usize) {
                let event = unsafe { event.assume_init() };
                let fd = event.ident as RawFd;
                let Some(path) = self.by_fd.get(&fd) else { continue; };
                let Some(registration) = self.files.get(path) else { continue; };
                let revision = event.udata as usize as u64;
                if registration.revision != revision { continue; }
                let invalid = event.flags & (libc::EV_ERROR | libc::EV_EOF) != 0 || event.fflags & (libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_REVOKE) != 0;
                signals.push(Signal { path: path.clone(), revision, invalid });
            }
            if !signals.is_empty() { return Ok(signals); }
        }
    }
    pub(super) fn close(self) -> Result<()> {
        let Self { queue, files, by_fd, errors } = self;
        drop(files); drop(by_fd); drop(queue);
        let mut errors = errors.lock().expect("watch close errors");
        if errors.is_empty() { Ok(()) } else { Err(Error::aggregate(std::mem::take(&mut *errors))) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn fifo_symlink_and_directory_replacements_never_open_a_read_stream() {
        let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("session.jsonl");
        std::fs::write(&path, b"").unwrap(); let expected = FileIdentity::from_metadata(&std::fs::metadata(&path).unwrap());
        std::fs::remove_file(&path).unwrap(); let name = CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let mut watcher = FileWatcher::new().unwrap();
        assert!(watcher.watch(&path, 1, &expected).is_err()); assert_eq!(watcher.len(), 0);
        std::fs::remove_file(&path).unwrap(); std::os::unix::fs::symlink(directory.path(), &path).unwrap();
        assert!(watcher.watch(&path, 2, &expected).is_err());
        std::fs::remove_file(&path).unwrap(); std::fs::create_dir(&path).unwrap();
        assert!(watcher.watch(&path, 3, &expected).is_err()); watcher.close().unwrap();
    }
    #[tokio::test]
    async fn vnode_cap_and_multibatch_events_close_all_registrations() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap(); let mut watcher = FileWatcher::new().unwrap(); let mut paths = Vec::new();
        for index in 0..129 {
            let path = directory.path().join(format!("{index}.jsonl")); std::fs::write(&path, b"").unwrap();
            let expected = FileIdentity::from_metadata(&std::fs::metadata(&path).unwrap());
            let result = watcher.watch(&path, index + 1, &expected);
            if index < 128 { result.unwrap(); paths.push(path); } else { assert_eq!(result.unwrap_err().code, "OC_COLLECTION_LIMIT"); }
        }
        assert_eq!(watcher.len(), 128);
        for path in &paths { std::fs::OpenOptions::new().append(true).open(path).unwrap().write_all(b"event\n").unwrap(); }
        let mut observed = std::collections::BTreeSet::new();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while observed.len() < 128 { let events = watcher.next().await.unwrap(); assert!(events.len() <= 32); for event in events { assert!(!event.invalid); observed.insert(event.path); } }
        }).await.unwrap();
        for path in paths { watcher.unwatch(&path).unwrap(); }
        assert_eq!(watcher.len(), 0); watcher.close().unwrap();
    }
}
