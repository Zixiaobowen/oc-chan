use std::{collections::BTreeMap, ffi::OsString, os::{fd::IntoRawFd, unix::fs::MetadataExt}, path::{Path, PathBuf}, sync::Arc, time::Duration};
use serde::{Deserialize, Serialize};
use tokio::{io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt}, sync::oneshot};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use crate::{error::{Error, Result, check_cancel}, resources::{Request, ResourceBudget}};
mod directory;
#[cfg(test)]
mod tests;

pub const READ_CHUNK_BYTES: usize = 64 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileIdentity {
    pub dev: u64, pub ino: u64, pub size: u64,
    pub uid: u32, pub mode: u32, pub nlink: u64,
    pub mtime: i64, pub mtime_nanos: i64, pub ctime: i64, pub ctime_nanos: i64,
}
impl FileIdentity {
    pub fn from_metadata(meta: &std::fs::Metadata) -> Self {
        Self { dev: meta.dev(), ino: meta.ino(), size: meta.len(), uid: meta.uid(), mode: meta.mode(), nlink: meta.nlink(),
            mtime: meta.mtime(), mtime_nanos: meta.mtime_nsec(), ctime: meta.ctime(), ctime_nanos: meta.ctime_nsec() }
    }
    pub fn same_file(&self, other: &Self) -> bool { self.dev == other.dev && self.ino == other.ino }
}
#[derive(Clone, Debug)]
pub struct FileRead { pub bytes: Vec<u8>, pub identity: FileIdentity }
#[derive(Clone, Debug)]
pub struct FileMetadata { pub identity: FileIdentity, pub is_file: bool, pub is_dir: bool, pub is_symlink: bool }
#[derive(Clone, Debug)]
pub struct InputFile { pub path: PathBuf, pub max_bytes: usize, pub identity: Option<FileIdentity> }
pub type StdoutObserver = Arc<dyn Fn(&[u8]) -> Result<()> + Send + Sync>;
#[derive(Clone)]
pub struct CommandSpec {
    pub executable: PathBuf, pub args: Vec<OsString>, pub timeout: Duration,
    pub stdout_limit: usize, pub stderr_limit: usize, pub input: Vec<u8>,
    pub input_file: Option<InputFile>, pub env: BTreeMap<OsString, OsString>,
    /// A synchronous bounded parser; observed chunks are not also retained in stdout.
    pub stdout_observer: Option<StdoutObserver>,
    /// Atomically reserves command, file and socket capacity for an HTTP worker.
    pub network_file_bytes: Option<usize>,
}
impl CommandSpec {
    pub fn new(executable: impl Into<PathBuf>, args: impl IntoIterator<Item = impl Into<OsString>>, limit: usize, timeout: Duration) -> Self {
        Self { executable: executable.into(), args: args.into_iter().map(Into::into).collect(), timeout,
            stdout_limit: limit, stderr_limit: limit, input: Vec::new(), input_file: None, env: BTreeMap::new(),
            stdout_observer: None, network_file_bytes: None }
    }
}
#[derive(Clone, Debug)]
pub struct CommandOutput {
    pub stdout: Vec<u8>, pub stderr: Vec<u8>, pub exit_code: i32, pub pid: u32,
    pub identity: Option<crate::process::ProcessIdentity>, pub identity_error: Option<Error>,
}
impl CommandOutput {
    pub fn success(self) -> Result<Self> {
        if self.exit_code != 0 { return Err(Error::new("OC_COMMAND_FAILED", format!("命令失败 / Command failed (exit={})", self.exit_code))); }
        Ok(self)
    }
    pub fn stdout_text(&self) -> Result<&str> { std::str::from_utf8(&self.stdout).map_err(|_| Error::new("OC_COLLECTION_ENCODING", "命令输出不是UTF-8 / Command output is not UTF-8")) }
}
struct Inner { resources: ResourceBudget, stop: CancellationToken, tasks: TaskTracker, admission: std::sync::Mutex<bool> }
#[derive(Clone)]
pub struct BoundedIo { inner: Arc<Inner> }
impl BoundedIo {
    pub fn new(resources: ResourceBudget) -> Self { Self { inner: Arc::new(Inner { resources, stop: CancellationToken::new(), tasks: TaskTracker::new(), admission: std::sync::Mutex::new(true) }) } }
    pub fn resources(&self) -> &ResourceBudget { &self.inner.resources }
    pub async fn with_file_budget<T, F, Fut>(&self, source: &str, bytes: usize, cancel: &CancellationToken, work: F) -> Result<T>
    where T: Send + 'static, F: FnOnce(CancellationToken) -> Fut + Send + 'static, Fut: Future<Output = Result<T>> + Send + 'static {
        self.supervise(source, Request::File { bytes }, cancel, work).await
    }
    pub fn cancellation(&self) -> CancellationToken { self.inner.stop.child_token() }
    pub(crate) async fn supervise<T, F, Fut>(&self, source: &str, request: Request, cancel: &CancellationToken, work: F) -> Result<T>
    where T: Send + 'static, F: FnOnce(CancellationToken) -> Fut + Send + 'static, Fut: Future<Output = Result<T>> + Send + 'static {
        let registration = {
            let admission = self.inner.admission.lock().expect("IO admission poisoned");
            if !*admission { return Err(Error::new("OC_RESOURCE_CLOSED", "IO admission is closed")); }
            self.inner.tasks.token()
        };
        check_cancel(&self.inner.stop)?;
        let lease = self.inner.resources.acquire(source, request, cancel).await?;
        let operation = self.inner.stop.child_token();
        let abandoned = operation.clone().drop_guard();
        let caller = cancel.clone();
        let (sender, receiver) = oneshot::channel();
        tokio::spawn(async move {
            let _registration = registration;
            let work = work(operation.clone()); tokio::pin!(work);
            let result = lease.run(async {
                tokio::select! {
                    result = &mut work => result,
                    _ = caller.cancelled() => { operation.cancel(); work.await }
                }
            }).await;
            if let Err(undelivered) = sender.send(result) {
                if let Err(error) = undelivered { if !error.is_cancelled() { eprintln!("abandoned IO cleanup: {error}"); } }
            }
        });
        let result = receiver.await.map_err(|_| Error::new("OC_IO_SUPERVISOR", "资源监督任务异常退出 / IO supervisor exited unexpectedly"))?;
        abandoned.disarm(); result
    }
    pub async fn shutdown(&self) -> Result<()> {
        {
            let mut admission = self.inner.admission.lock().expect("IO admission poisoned");
            *admission = false;
            self.inner.resources.close(); self.inner.stop.cancel(); self.inner.tasks.close();
        }
        tokio::time::timeout(Duration::from_secs(15), self.inner.tasks.wait()).await
            .map_err(|_| Error::new("OC_RESOURCE_CLOSE", "资源仍在排空 / IO remains active after shutdown deadline"))
    }
    pub async fn read_file(&self, source: &str, path: &Path, max_bytes: usize, nofollow: bool, cancel: &CancellationToken) -> Result<FileRead> {
        let path = path.to_owned();
        let reserved = max_bytes.checked_add(1).ok_or_else(|| Error::invalid("file byte limit"))?;
        self.supervise(source, Request::File { bytes: reserved }, cancel,
            move |cancel| async move { read_file_inner(&path, max_bytes, nofollow, None, &cancel).await }).await
    }
    pub async fn write_atomic(&self, source: &str, path: &Path, bytes: Vec<u8>, cancel: &CancellationToken) -> Result<()> {
        let path = path.to_owned();
        self.supervise(source, Request::File { bytes: bytes.len() }, cancel, move |cancel| async move {
            check_cancel(&cancel)?;
            let parent = path.parent().ok_or_else(|| Error::invalid("atomic file parent"))?;
            tokio::fs::create_dir_all(parent).await.map_err(|e| Error::io("file directory", e))?;
            match tokio::fs::symlink_metadata(&path).await {
                Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => return Err(Error::new("ELOOP", "原子写入目标不是普通文件 / Atomic write target is not a regular file")),
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(Error::io("atomic target metadata", error)),
            }
            let name = path.file_name().ok_or_else(|| Error::invalid("atomic file name"))?;
            let mut temporary_name = name.to_os_string();
            temporary_name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
            let temporary = parent.join(temporary_name);
            let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&temporary).await.map_err(|e| Error::io("atomic file open", e))?;
            let writing = async {
                for chunk in bytes.chunks(READ_CHUNK_BYTES) {
                    check_cancel(&cancel)?;
                    file.write_all(chunk).await.map_err(|e| Error::io("atomic file write", e))?;
                }
                file.sync_all().await.map_err(|e| Error::io("atomic file sync", e))?;
                check_cancel(&cancel)
            }.await;
            let writing = merge_close(writing, close_file(file).await);
            let committed = match writing {
                Ok(()) => tokio::fs::rename(&temporary, &path).await.map_err(|e| Error::io("atomic file rename", e)),
                Err(error) => Err(error),
            };
            if let Err(error) = committed {
                return match tokio::fs::remove_file(&temporary).await {
                    Ok(()) => Err(error),
                    Err(cleanup) => Err(Error::cleanup("atomic temporary file", Error::aggregate(vec![error, Error::io("unlink", cleanup)]))),
                };
            }
            // Cancellation after rename does not undo a committed write. Report
            // an unconfirmed durability boundary separately so owners can recover.
            let sync_directory = async {
                let directory = tokio::fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                    .open(parent).await.map_err(|e| Error::io("atomic parent open", e))?;
                let result = directory.sync_all().await.map_err(|e| Error::io("atomic parent sync", e));
                merge_close(result, close_file(directory).await)
            }.await;
            sync_directory.map_err(|cause| Error { code: "OC_ATOMIC_COMMIT".into(), message: "文件已替换但持久同步未确认 / File replaced but durability not confirmed".into(), os_error: cause.os_error, causes: vec![cause] })
        }).await
    }
    pub async fn read_range(&self, source: &str, path: &Path, offset: u64, max_bytes: usize, cancel: &CancellationToken) -> Result<FileRead> {
        let path = path.to_owned();
        self.supervise(source, Request::File { bytes: max_bytes }, cancel, move |cancel| async move {
            let mut file = open_regular(&path, true).await?;
            let result = async {
                check_cancel(&cancel)?;
                let before = FileIdentity::from_metadata(&file.metadata().await.map_err(|e| Error::io("file metadata", e))?);
                file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| Error::io("file seek", e))?;
                let available = before.size.saturating_sub(offset).min(max_bytes as u64) as usize;
                let mut bytes = vec![0u8; available];
                let mut used = 0;
                while used < bytes.len() {
                    check_cancel(&cancel)?;
                    let end = (used + READ_CHUNK_BYTES).min(bytes.len());
                    let read = file.read(&mut bytes[used..end]).await.map_err(|e| Error::io("file range read", e))?;
                    if read == 0 { break; }
                    used += read;
                }
                bytes.truncate(used);
                check_cancel(&cancel)?;
                let after = FileIdentity::from_metadata(&file.metadata().await.map_err(|e| Error::io("file metadata", e))?);
                if !before.same_file(&after) || after.size < offset + used as u64 {
                    return Err(Error::new("OC_COLLECTION_CHANGED", "文件读取期间发生替换或截断 / File replaced or truncated while reading"));
                }
                Ok(FileRead { bytes, identity: after })
            }.await;
            merge_close(result, close_file(file).await)
        }).await
    }
    pub async fn read_directory(&self, source: &str, path: &Path, max_entries: usize, max_name_bytes: usize, cancel: &CancellationToken) -> Result<Vec<PathBuf>> {
        self.directory(source, path, max_entries, max_name_bytes, false, cancel).await
    }
    pub async fn read_private_directory(&self, source: &str, path: &Path, max_entries: usize, max_name_bytes: usize, cancel: &CancellationToken) -> Result<Vec<PathBuf>> {
        self.directory(source, path, max_entries, max_name_bytes, true, cancel).await
    }
    async fn directory(&self, source: &str, path: &Path, max_entries: usize, max_name_bytes: usize, private: bool, cancel: &CancellationToken) -> Result<Vec<PathBuf>> {
        if max_entries == 0 || max_entries > 4096 || max_name_bytes == 0 || max_name_bytes > 4096 || path.as_os_str().len() > 4096 {
            return Err(Error::invalid("directory limits"));
        }
        let bytes = max_entries.checked_mul(path.as_os_str().len() + 1 + max_name_bytes + std::mem::size_of::<PathBuf>())
            .ok_or_else(|| Error::invalid("directory byte limit"))?.min(self.resources().file_capacity());
        let path = path.to_owned();
        self.supervise(source, Request::File { bytes }, cancel, move |cancel| async move {
            tokio::task::spawn_blocking(move || directory::read(&path, max_entries, max_name_bytes, bytes, private, &cancel))
                .await.map_err(|_| Error::new("OC_RESOURCE_CLOSE", "Directory worker exited before cleanup was confirmed"))?
        }).await
    }
    pub async fn metadata(&self, source: &str, path: &Path, nofollow: bool, cancel: &CancellationToken) -> Result<FileMetadata> {
        let path = path.to_owned();
        self.supervise(source, Request::File { bytes: 0 }, cancel, move |cancel| async move {
            check_cancel(&cancel)?;
            let metadata = if nofollow { tokio::fs::symlink_metadata(&path).await } else { tokio::fs::metadata(&path).await }
                .map_err(|e| Error::io("path metadata", e))?;
            check_cancel(&cancel)?;
            Ok(FileMetadata { identity: FileIdentity::from_metadata(&metadata), is_file: metadata.is_file(),
                is_dir: metadata.is_dir(), is_symlink: metadata.file_type().is_symlink() })
        }).await
    }
    pub async fn command(&self, source: &str, spec: CommandSpec, cancel: &CancellationToken) -> Result<CommandOutput> {
        self.command_with_output(source, spec, cancel, |output, _| async move { Ok(output) }).await
    }
    pub async fn command_with_output<T, F, Fut>(&self, source: &str, spec: CommandSpec, cancel: &CancellationToken, consume: F) -> Result<T>
    where T: Send + 'static, F: FnOnce(CommandOutput, CancellationToken) -> Fut + Send + 'static, Fut: Future<Output = Result<T>> + Send + 'static {
        if spec.timeout.is_zero() || spec.timeout > Duration::from_secs(900) || !spec.executable.is_absolute()
            || (spec.input_file.is_some() && !spec.input.is_empty()) {
            return Err(Error::invalid("command specification"));
        }
        let input_bytes = match &spec.input_file { Some(file) => Some(file.max_bytes.checked_add(1).ok_or_else(|| Error::invalid("command input limit"))?), None if !spec.input.is_empty() => Some(spec.input.len()), None => None };
        let request = match spec.network_file_bytes {
            Some(bytes) => Request::NetworkCommand { stdout_bytes: spec.stdout_limit, stderr_bytes: spec.stderr_limit,
                file_bytes: bytes.checked_add(input_bytes.unwrap_or(0)).ok_or_else(|| Error::invalid("HTTP worker buffer limit"))?, socket_bytes: 64 * 1024 },
            None => Request::Command { stdout_bytes: spec.stdout_limit, stderr_bytes: spec.stderr_limit, input_bytes },
        };
        self.supervise(source, request, cancel, move |cancel| async move {
            let output = command_inner(spec, cancel.clone()).await?;
            consume(output, cancel).await
        }).await
    }
    pub async fn socket(&self, source: &str, path: &Path, input: Vec<u8>, max_bytes: usize, timeout: Duration, cancel: &CancellationToken) -> Result<Vec<u8>> {
        if timeout.is_zero() || input.len() > 64 * 1024 { return Err(Error::invalid("socket limits")); }
        let path = path.to_owned();
        let bytes = max_bytes.checked_add(input.len()).ok_or_else(|| Error::invalid("socket limits"))?;
        self.supervise(source, Request::Socket { bytes }, cancel, move |cancel| async move {
            let work = async {
                let mut stream = tokio::net::UnixStream::connect(&path).await.map_err(|e| Error::io("socket connect", e))?;
                stream.write_all(&input).await.map_err(|e| Error::io("socket write", e))?;
                read_line_stream(stream, max_bytes, &cancel).await
            };
            tokio::select! {
                result = work => result,
                _ = cancel.cancelled() => Err(Error::cancelled()),
                _ = tokio::time::sleep(timeout) => Err(Error::timeout("socket")),
            }
        }).await
    }
}

pub async fn open_regular(path: &Path, nofollow: bool) -> Result<tokio::fs::File> {
    let flags = libc::O_NONBLOCK | if nofollow { libc::O_NOFOLLOW } else { 0 };
    let file = tokio::fs::OpenOptions::new().read(true).custom_flags(flags).open(path).await.map_err(|e| Error::io("file open", e))?;
    if !file.metadata().await.map_err(|e| Error::io("file metadata", e))?.is_file() {
        return merge_close(Err(Error::new("NOT_REGULAR_FILE", "路径不是普通文件 / Path is not a regular file")), close_file(file).await);
    }
    Ok(file)
}
pub async fn close_file(file: tokio::fs::File) -> Result<()> {
    let file = file.into_std().await;
    let fd = file.into_raw_fd();
    // Never retry close(EINTR): the descriptor may already be released and reused.
    if unsafe { libc::close(fd) } != 0 { return Err(Error::cleanup("file", Error::io("close", std::io::Error::last_os_error()))); }
    Ok(())
}
pub fn merge_close<T>(result: Result<T>, cleanup: Result<()>) -> Result<T> {
    match (result, cleanup) { (result, Ok(())) => result, (Ok(_), Err(error)) => Err(error), (Err(first), Err(last)) => Err(Error::aggregate(vec![first, last])) }
}
async fn read_file_inner(path: &Path, max_bytes: usize, nofollow: bool, expected: Option<&FileIdentity>, cancel: &CancellationToken) -> Result<FileRead> {
    let mut file = open_regular(path, nofollow).await?;
    let result = async {
        check_cancel(cancel)?;
        let before = FileIdentity::from_metadata(&file.metadata().await.map_err(|e| Error::io("file metadata", e))?);
        if before.size > max_bytes as u64 { return Err(Error::limit("file bytes", max_bytes, before.size.min(usize::MAX as u64) as usize)); }
        if expected.is_some_and(|identity| identity != &before) { return Err(Error::new("OC_COLLECTION_CHANGED", "文件身份已改变 / File identity changed")); }
        let mut bytes = vec![0u8; before.size as usize + 1];
        let mut used = 0;
        while used < bytes.len() {
            check_cancel(cancel)?;
            let end = (used + READ_CHUNK_BYTES).min(bytes.len());
            let count = file.read(&mut bytes[used..end]).await.map_err(|e| Error::io("file read", e))?;
            if count == 0 { break; }
            used += count;
        }
        check_cancel(cancel)?;
        let after = FileIdentity::from_metadata(&file.metadata().await.map_err(|e| Error::io("file metadata", e))?);
        if used as u64 != before.size || after != before { return Err(Error::new("OC_COLLECTION_CHANGED", "文件读取期间发生改变 / File changed while reading")); }
        bytes.truncate(used); Ok(FileRead { bytes, identity: before })
    }.await;
    merge_close(result, close_file(file).await)
}
async fn read_stream(mut stream: impl AsyncRead + Unpin, maximum: usize, cancel: &CancellationToken, observer: Option<&StdoutObserver>) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut total = 0usize;
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let read = tokio::select! {
            read = stream.read(&mut chunk) => read.map_err(|e| Error::io("pipe read", e))?,
            _ = cancel.cancelled() => return Err(Error::cancelled()),
        };
        if read == 0 { break; }
        if read > maximum.saturating_sub(total) { return Err(Error::limit("stream bytes", maximum, total.saturating_add(read))); }
        total += read;
        if let Some(observer) = observer { observer(&chunk[..read])?; }
        else {
            bytes.try_reserve_exact(read).map_err(|_| Error::new("OC_RESOURCE_LIMIT", "bounded output allocation refused"))?;
            bytes.extend_from_slice(&chunk[..read]);
        }
    }
    Ok(bytes)
}

async fn command_inner(spec: CommandSpec, cancel: CancellationToken) -> Result<CommandOutput> {
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    check_cancel(&cancel)?;
    let input = if let Some(input) = &spec.input_file {
        read_file_inner(&input.path, input.max_bytes, false, input.identity.as_ref(), &cancel).await?.bytes
    } else { spec.input };
    check_cancel(&cancel)?;
    let mut command = tokio::process::Command::new(&spec.executable);
    command.args(&spec.args).env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").env("LC_ALL", "C").envs(&spec.env)
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command.spawn().map_err(|e| Error::io("command spawn", e))?;
    let pid = child.id().ok_or_else(|| Error::new("OC_COMMAND_IDENTITY", "spawned child has no PID"))?;
    let identity = crate::process::ProcessIdentity::read(pid);
    #[cfg(feature = "acceptance")]
    crate::performance::observe(|| serde_json::json!(["spawn", crate::performance::stamp(), pid, std::process::id(), identity.as_ref().ok()]));
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let mut stdin = child.stdin.take().expect("piped stdin");
    let pipes_cancel = CancellationToken::new();
    let output = read_stream(stdout, spec.stdout_limit, &pipes_cancel, spec.stdout_observer.as_ref()); tokio::pin!(output);
    let error_output = read_stream(stderr, spec.stderr_limit, &pipes_cancel, None); tokio::pin!(error_output);
    let stdin_cancel = pipes_cancel.clone();
    let input_write = async move {
        let result = tokio::select! {
            result = stdin.write_all(&input) => result.map_err(|e| Error::io("command stdin", e)),
            _ = stdin_cancel.cancelled() => Err(Error::cancelled()),
        };
        // Pipe shutdown does not imply EOF; the owned write descriptor must close.
        drop(stdin); result
    }; tokio::pin!(input_write);
    let deadline = tokio::time::sleep(spec.timeout); tokio::pin!(deadline);
    let mut out = None; let mut err = None; let mut input_result = None; let mut status = None;
    let mut stop_reason = None; let mut cleanup_failure = None;
    loop {
        if out.is_some() && err.is_some() && input_result.is_some() && status.is_some() { break; }
        tokio::select! {
            value = &mut output, if out.is_none() => { if value.is_err() && stop_reason.is_none() { stop_reason = value.as_ref().err().cloned(); } out = Some(value); }
            value = &mut error_output, if err.is_none() => { if value.is_err() && stop_reason.is_none() { stop_reason = value.as_ref().err().cloned(); } err = Some(value); }
            value = &mut input_write, if input_result.is_none() => { if value.is_err() && stop_reason.is_none() { stop_reason = value.as_ref().err().cloned(); } input_result = Some(value); }
            value = child.wait(), if status.is_none() && out.is_some() && err.is_some() && input_result.is_some() => { status = Some(value.map_err(|e| Error::cleanup("command wait", Error::io("wait", e)))); }
            _ = cancel.cancelled(), if stop_reason.is_none() => { stop_reason = Some(Error::cancelled()); }
            _ = &mut deadline, if stop_reason.is_none() => { stop_reason = Some(Error::timeout("command")); }
        }
        if stop_reason.is_some() && !pipes_cancel.is_cancelled() {
            // Do not reap the leader while descendants may still own its pipes.
            // The owned, unreaped child reserves its PID even after exit, so this
            // process-group ID cannot have been reused by an unrelated process.
            if status.is_none() && unsafe { libc::kill(-(pid as i32), libc::SIGKILL) } != 0 {
                let failure = std::io::Error::last_os_error();
                if failure.raw_os_error() != Some(libc::ESRCH) {
                    cleanup_failure = Some(Error::cleanup("command group", Error::io("kill", failure)));
                }
            }
            pipes_cancel.cancel();
        }
    }
    #[cfg(feature = "acceptance")]
    crate::performance::observe(|| serde_json::json!(["exit", crate::performance::stamp(), pid]));
    if let Some(cleanup) = cleanup_failure { return Err(Error::aggregate(vec![stop_reason.unwrap_or_else(Error::cancelled), cleanup])); }
    if let Some(error) = stop_reason { return Err(error); }
    input_result.expect("stdin completed")?;
    let status = status.expect("child reaped")?;
    let (identity, identity_error) = match identity { Ok(identity) => (Some(identity), None), Err(error) => (None, Some(error)) };
    Ok(CommandOutput { stdout: out.expect("stdout closed")?, stderr: err.expect("stderr closed")?,
        exit_code: status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0)), pid, identity, identity_error })
}

async fn read_line_stream(mut stream: impl AsyncRead + Unpin, maximum: usize, cancel: &CancellationToken) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = tokio::select! {
            read = stream.read(&mut chunk) => read.map_err(|e| Error::io("socket read", e))?,
            _ = cancel.cancelled() => return Err(Error::cancelled()),
        };
        if read == 0 { return Err(Error::new("OC_SOCKET_PROTOCOL", "socket closed before a complete response line")); }
        let newline = chunk[..read].iter().position(|byte| *byte == b'\n');
        let used = newline.map_or(read, |index| index + 1);
        if used > maximum.saturating_sub(bytes.len()) { return Err(Error::limit("socket response bytes", maximum, bytes.len().saturating_add(used))); }
        bytes.try_reserve_exact(used).map_err(|_| Error::new("OC_RESOURCE_LIMIT", "bounded socket allocation refused"))?;
        bytes.extend_from_slice(&chunk[..used]);
        if newline.is_some() { return Ok(bytes); }
    }
}
