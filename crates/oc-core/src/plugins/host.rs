use super::{BoxFuture, CollectionPlugin, PluginContext, SnapshotData, host_io};
use crate::{error::{Error, Result, check_cancel}, model::MonitorSection, process::ProcessIdentity, resources::{Outcome, Request}};
use oc_plugin_sdk::{self as sdk, Budgets, Capability, ErrorCode, HostMessage, PluginMessage, Reassembly, Stream, VERSION};
use sha2::{Digest, Sha256};
use std::{os::unix::process::CommandExt, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}}, time::Duration};
use tokio::{io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader}, process::Child, sync::{mpsc, oneshot, watch}, task::JoinSet};
use tokio_util::sync::CancellationToken;

/// Revalidation is supplied by the authenticated package loader, never by renderer
/// arguments. It rechecks archive, expanded files and native signature on every start.
#[derive(Clone)]
pub struct NativePluginSpec {
    pub id: String, pub app_version: String, pub section: MonitorSection, pub executable: PathBuf,
    pub capabilities: Vec<Capability>, pub timeout: Duration,
    pub verify: Arc<dyn Fn(CancellationToken) -> BoxFuture<'static, Result<()>> + Send + Sync>,
}
struct Handle { requests: mpsc::Sender<Collect>, finished: watch::Receiver<Option<Result<()>>> }
struct Collect { cancel: CancellationToken, response: oneshot::Sender<Result<Option<SnapshotData>>> }
pub struct NativePlugin { spec: NativePluginSpec, context: PluginContext, handle: Mutex<Option<Handle>> }
impl NativePlugin { pub fn new(spec: NativePluginSpec, context: PluginContext) -> Self { Self { spec, context, handle: Mutex::new(None) } } }
impl CollectionPlugin for NativePlugin {
    fn start(&self, cancel: CancellationToken) -> BoxFuture<'_, Result<()>> { Box::pin(async move {
        check_cancel(&cancel)?;
        (self.spec.verify)(cancel.clone()).await?;
        let (requests, receiver) = mpsc::channel(1); let (finished, completion) = watch::channel(None);
        let (ready, initialized) = oneshot::channel();
        { let mut handle = self.handle.lock().expect("native host poisoned"); if handle.is_some() { return Err(Error::invalid("duplicate native start")); } *handle = Some(Handle { requests, finished: completion }); }
        let spec = self.spec.clone(); let context = self.context.clone();
        tokio::spawn(async move {
            let publisher = context.publisher.clone();
            let result = supervise(spec, context, receiver, ready).await;
            if let Err(error) = &result { publisher.report_error(error.clone()); }
            finished.send_replace(Some(result));
        });
        initialized.await.map_err(|_| Error::new("OC_PLUGIN_START", "Native plugin exited during startup"))?
    }) }
    fn collect(&self, cancel: CancellationToken, source: Option<String>) -> BoxFuture<'_, Result<Option<SnapshotData>>> { Box::pin(async move {
        if source.is_some() { return Err(Error::new("OC_PLUGIN_CAPABILITY", "Native plugin has no source retry capability")); }
        let requests = self.handle.lock().expect("native host poisoned").as_ref().ok_or_else(|| Error::invalid("native plugin not started"))?.requests.clone();
        let (response, receive) = oneshot::channel();
        requests.send(Collect { cancel, response }).await.map_err(|_| Error::new("OC_PLUGIN_EXIT", "Native plugin is not running"))?;
        receive.await.map_err(|_| Error::new("OC_PLUGIN_EXIT", "Native plugin exited during collection"))?
    }) }
    fn stop(&self) -> BoxFuture<'_, Result<()>> { Box::pin(async move {
        self.context.cancel.cancel();
        let handle = self.handle.lock().expect("native host poisoned").take();
        let Some(mut handle) = handle else { return Ok(()); };
        loop {
            if let Some(result) = handle.finished.borrow().clone() {
                // Operational/protocol faults were published by the supervisor.
                // Only a true release failure prevents uninstall or a new lifecycle.
                return match result { Err(error) if error.is_cleanup() => Err(error), _ => Ok(()) };
            }
            handle.finished.changed().await.map_err(|_| Error::cleanup("native plugin supervisor", Error::new("OC_PLUGIN_PANIC", "Native supervisor disappeared")))?;
        }
    }) }
}
fn protocol(message: &str) -> Error { Error::new("OC_PLUGIN_PROTOCOL", message) }
fn sdk_error(error: sdk::Error) -> Error { match error.code { ErrorCode::Cancelled => Error::cancelled(), ErrorCode::Cleanup => Error::cleanup("native plugin", protocol(&error.message)), _ => protocol(&error.message) } }
async fn send(tx: &mpsc::Sender<Vec<u8>>, message: HostMessage) -> Result<()> { enqueue(tx, move || Ok(message)).await }
async fn enqueue(tx: &mpsc::Sender<Vec<u8>>, make: impl FnOnce() -> Result<HostMessage> + Send) -> Result<()> {
    let permit = tokio::time::timeout(Duration::from_secs(5), tx.reserve()).await.map_err(|_| Error::timeout("plugin write backpressure"))?
        .map_err(|_| protocol("Plugin stdin closed"))?;
    // Pending writers retain their already-accounted raw IO buffer. No base64 or
    // encoded frame exists until one of the four transport slots is owned.
    let message = make()?; message.validate(None).map_err(sdk_error)?;
    permit.send(sdk::encode_frame(&message).map_err(sdk_error)?); Ok(())
}
async fn read_frame(reader: &mut BufReader<impl AsyncRead + Unpin>) -> Result<Option<PluginMessage>> {
    let mut bytes = Vec::with_capacity(sdk::MAX_FRAME);
    loop {
        let buffer = reader.fill_buf().await.map_err(|e| Error::io("plugin stdout", e))?;
        if buffer.is_empty() { return if bytes.is_empty() { Ok(None) } else { Err(protocol("Truncated plugin frame")) }; }
        let count = buffer.iter().position(|b| *b == b'\n').map_or(buffer.len(), |n| n + 1);
        if count > sdk::MAX_FRAME - bytes.len() { return Err(protocol("Plugin frame exceeds 64KiB")); }
        let complete = buffer[count - 1] == b'\n'; bytes.extend_from_slice(&buffer[..count]); reader.consume(count);
        if complete { return serde_json::from_slice(&bytes).map(Some).map_err(|_| protocol("Malformed plugin frame")); }
    }
}
struct Active {
    call: u64, cancel: CancellationToken, io_cancel: CancellationToken, io_bytes: Arc<AtomicUsize>,
    assembly: Reassembly, response: oneshot::Sender<Result<Option<SnapshotData>>>,
    deadline: tokio::time::Instant,
}
struct IoReservation { bytes: usize, total: Arc<AtomicUsize> }
impl IoReservation {
    fn acquire(total: &Arc<AtomicUsize>, bytes: usize, pending: usize) -> Result<Self> {
        if pending >= sdk::MAX_IO { return Err(protocol("Too many host IO requests")); }
        if bytes > sdk::MAX_IO_BYTES.saturating_sub(total.load(Ordering::Acquire)) { return Err(protocol("Host IO exceeds negotiated reassembly reservation")); }
        total.fetch_add(bytes, Ordering::AcqRel);
        Ok(Self { bytes, total: total.clone() })
    }
}
impl Drop for IoReservation { fn drop(&mut self) { self.total.fetch_sub(self.bytes, Ordering::AcqRel); } }
struct HostIo { generation: u64, call: u64, io: u64, reservation: IoReservation, cancel: CancellationToken }
type IoCompletion = (HostIo, Result<HostMessage>);
impl HostIo {
    async fn perform(self, host: crate::io::BoundedIo, operation: sdk::IoOperation, timeout: Duration, writer: mpsc::Sender<Vec<u8>>, plugin_id: String) -> IoCompletion {
        let (generation, call, io) = (self.generation, self.call, self.io);
        let result = host_io::perform(host, operation, self.reservation.bytes, timeout, self.cancel.clone(), move |output, cancel| Box::pin(async move {
            let mut hash = Sha256::new(); let mut bytes = 0; let mut counts = [0usize; 3]; let mut seq = 0;
            for (stream, data) in output.streams {
                counts[match stream { Stream::Stdout => 0, Stream::Stderr => 1, Stream::Data => 2 }] += data.len();
                for chunk in data.chunks(sdk::MAX_CHUNK) {
                    check_cancel(&cancel)?; hash.update(chunk); bytes += chunk.len();
                    enqueue(&writer, || Ok(HostMessage::IoChunk { v: VERSION, generation, call, io, seq, stream, data: sdk::encode_chunk(chunk).map_err(sdk_error)? })).await?; seq += 1;
                }
            }
            check_cancel(&cancel)?;
            let identity = format!("plugin={plugin_id};generation={generation};call={call};io={io};{}", output.identity);
            Ok(HostMessage::IoEnd { v: VERSION, generation, call, io, bytes, sha256: format!("{:x}", hash.finalize()), stdout_bytes: counts[0], stderr_bytes: counts[1], data_bytes: counts[2], exit_code: output.exit_code, identity })
        })).await;
        (self, result)
    }
}
async fn finish_io(joined: std::result::Result<IoCompletion, tokio::task::JoinError>, writer: &mpsc::Sender<Vec<u8>>) -> Result<()> {
    let (HostIo { generation, call, io, reservation, .. }, result) = joined.map_err(|_| Error::cleanup("plugin host IO", protocol("IO supervisor panicked")))?;
    // A terminal frame grants the plugin permission to request more IO or end
    // its call. Publish only after JoinSet removal and reservation release.
    drop(reservation);
    match result {
        Ok(message) => send(writer, message).await,
        Err(error) => {
            let code = if error.is_cleanup() { ErrorCode::Cleanup } else if error.is_cancelled() { ErrorCode::Cancelled } else { ErrorCode::Io };
            match send(writer, HostMessage::IoError { v: VERSION, generation, call, io, code, message: error.code.clone() }).await {
                Err(delivery) => Err(Error::aggregate(vec![error, delivery])),
                Ok(()) if error.is_cleanup() => Err(error),
                Ok(()) => Ok(()),
            }
        }
    }
}
async fn supervise(spec: NativePluginSpec, context: PluginContext, mut requests: mpsc::Receiver<Collect>, ready: oneshot::Sender<Result<()>>) -> Result<()> {
    // Both processes' protocol buffers and plugin IO reassembly are in the same
    // accounting ledger. Host command outputs have their own BoundedIo leases.
    const IO_RESERVATION: usize = sdk::MAX_IO_BYTES;
    const RESULT_RESERVATION: usize = 512 * 1024;
    const BUSINESS_RESERVATION: usize = sdk::MAX_RESULT;
    const PROTOCOL: usize = sdk::TRANSPORT_RESERVATION + RESULT_RESERVATION + IO_RESERVATION;
    const RESERVATION: usize = PROTOCOL + sdk::TRANSPORT_RESERVATION + RESULT_RESERVATION + BUSINESS_RESERVATION + sdk::MAX_FRAME;
    let lease = match context.io.resources().acquire("plugin-host", Request::Plugin { bytes: RESERVATION }, &context.cancel).await {
        Ok(lease) => lease, Err(error) => { let _sent = ready.send(Err(error.clone())); return Err(error); }
    };
    let generation = context.publisher.generation();
    let mut command = tokio::process::Command::new(&spec.executable);
    command.env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").env("LC_ALL", "C")
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = match command.spawn() { Ok(child) => child, Err(error) => { let error = Error::io("native plugin spawn", error); let _sent = ready.send(Err(error.clone())); lease.finish(Outcome::Failed); return Err(error); } };
    let identity = ProcessIdentity::read(child.id().expect("spawned plugin PID"));
    let pipes = CancellationToken::new();
    let (writer, mut writes) = mpsc::channel::<Vec<u8>>(sdk::WRITE_QUEUE);
    let mut stdin = child.stdin.take().expect("plugin stdin"); let writer_stop = pipes.clone();
    let mut write_task = tokio::spawn(async move {
        let work = async {
            while let Some(frame) = writes.recv().await {
                tokio::time::timeout(Duration::from_secs(5), stdin.write_all(&frame)).await.map_err(|_| Error::timeout("plugin stdin"))?.map_err(|e| Error::io("plugin stdin", e))?;
            }
            stdin.shutdown().await.map_err(|e| Error::io("plugin stdin shutdown", e))
        };
        tokio::select! { result = work => result, _ = writer_stop.cancelled() => Ok(()) }
    });
    let (frames, mut messages) = mpsc::channel(1); let stdout = child.stdout.take().expect("plugin stdout"); let reader_stop = pipes.clone();
    let mut read_task = tokio::spawn(async move {
        let work = async {
            let mut reader = BufReader::with_capacity(sdk::MAX_FRAME, stdout);
            loop {
                let frame = read_frame(&mut reader).await;
                let terminal = !matches!(frame, Ok(Some(_)));
                if frames.send(frame).await.is_err() { return Ok(()); }
                if terminal { return Ok(()); }
            }
        };
        tokio::select! { result = work => result, _ = reader_stop.cancelled() => Ok(()) }
    });
    let mut stderr = child.stderr.take().expect("plugin stderr"); let error_stop = pipes.clone();
    let mut stderr_task = tokio::spawn(async move {
        let work = async {
            let mut bytes = 0usize; let mut chunk = [0u8; 4096];
            loop { let n = stderr.read(&mut chunk).await.map_err(|e| Error::io("plugin stderr", e))?; if n == 0 { return Ok(()); } bytes += n; if bytes > sdk::MAX_FRAME { return Err(protocol("Plugin stderr exceeds 64KiB")); } }
        };
        tokio::select! { result = work => result, _ = error_stop.cancelled() => Ok(()) }
    });
    let mut ios: JoinSet<IoCompletion> = JoinSet::new();
    let mut active: Option<Active> = None; let mut ready = Some(ready); let mut initialized = false;
    let mut call = 0u64; let mut last_io = 0u64; let mut stopping = false; let mut stopped = false; let mut stderr_done = false;
    let mut stop_deadline = tokio::time::Instant::now() + spec.timeout;
    let result: Result<()> = async {
        identity.as_ref().map_err(Clone::clone)?;
        send(&writer, HostMessage::Initialize { v: VERSION, generation, id: spec.id.clone(), app_version: spec.app_version.clone(), capabilities: spec.capabilities.clone(), budgets: Budgets { frame_bytes: sdk::MAX_FRAME, chunk_bytes: sdk::MAX_CHUNK, result_bytes: RESULT_RESERVATION, max_io: sdk::MAX_IO, io_reassembly_bytes: IO_RESERVATION, protocol_bytes: PROTOCOL } }).await?;
        loop {
            if stopped { break; }
            let should_stop = context.cancel.is_cancelled() || active.as_ref().is_some_and(|a| a.cancel.is_cancelled() || tokio::time::Instant::now() >= a.deadline);
            if should_stop && !stopping {
                stopping = true; stop_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
                if let Some(a) = &mut active { a.io_cancel.cancel(); a.assembly.discard(); }
                // Stop revokes the entire generation. Unlike a call-only Cancel it
                // remains valid if resultEnd crossed cancellation in the pipes.
                send(&writer, HostMessage::Stop { v: VERSION, generation }).await?;
            }
            let tick = tokio::time::sleep(Duration::from_millis(10));
            tokio::select! {
                biased;
                joined = ios.join_next(), if !ios.is_empty() => {
                    finish_io(joined.expect("nonempty IO set"), &writer).await?;
                }
                stderr = &mut stderr_task, if !stderr_done => { stderr_done = true; stderr.map_err(|_| protocol("Plugin stderr reader panicked"))??; }
                message = messages.recv() => {
                    let message = message.ok_or_else(|| protocol("Plugin reader disconnected"))??.ok_or_else(|| protocol("Plugin exited before stopped"))?;
                    message.validate(Some(generation)).map_err(sdk_error)?;
                    match message {
                        PluginMessage::Ready { protocol_bytes, io_reassembly_bytes, business_bytes, .. } => {
                            if initialized || stopping || protocol_bytes != sdk::TRANSPORT_RESERVATION + RESULT_RESERVATION + io_reassembly_bytes || io_reassembly_bytes > IO_RESERVATION || business_bytes > BUSINESS_RESERVATION { return Err(protocol("Unexpected ready or unreserved plugin memory")); }
                            initialized = true; if let Some(ready) = ready.take() { let _sent = ready.send(Ok(())); }
                        }
                        PluginMessage::IoRequest { call, io, operation, max_bytes, timeout_ms, .. } => {
                            let a = active.as_mut().filter(|a| a.call == call).ok_or_else(|| protocol("IO outside active call"))?;
                            if io <= last_io { return Err(protocol("Duplicate/nonmonotonic IO identifier")); } last_io = io;
                            if stopping || a.cancel.is_cancelled() || a.io_cancel.is_cancelled() {
                                send(&writer, HostMessage::IoError { v: VERSION, generation, call, io, code: ErrorCode::Cancelled, message: "Host IO admission revoked".into() }).await?;
                                continue;
                            }
                            if !spec.capabilities.contains(&operation.capability()) { return Err(protocol("Undeclared host IO capability")); }
                            let reservation = IoReservation::acquire(&a.io_bytes, max_bytes, ios.len())?;
                            let request = HostIo { generation, call, io, reservation, cancel: a.io_cancel.child_token() };
                            let remaining = a.deadline.saturating_duration_since(tokio::time::Instant::now());
                            ios.spawn(request.perform(context.io.clone(), operation, Duration::from_millis(timeout_ms).min(remaining), writer.clone(), spec.id.clone()));
                        }
                        PluginMessage::ResultChunk { call, seq, data, .. } => {
                            let a = active.as_mut().filter(|a| a.call == call).ok_or_else(|| protocol("Result outside active call"))?;
                            a.assembly.push(seq, &data).map_err(sdk_error)?;
                        }
                        PluginMessage::ResultEnd { call, bytes, sha256, .. } => {
                            let mut a = active.take().filter(|a| a.call == call).ok_or_else(|| protocol("Duplicate or wrong result completion"))?;
                            if !ios.is_empty() { return Err(protocol("Result arrived before host IO drained")); }
                            let bytes = a.assembly.finish(bytes, &sha256).map_err(sdk_error)?;
                            let result = if stopping || a.cancel.is_cancelled() { Err(Error::cancelled()) } else { SnapshotData::from_json(spec.section, &bytes).map(Some) };
                            let _sent = a.response.send(result);
                        }
                        PluginMessage::Error { call, code, .. } => {
                            if code == ErrorCode::Cleanup || call.is_none() { return Err(Error::cleanup("native plugin", protocol("Plugin lifecycle failure"))); }
                            let a = active.take().filter(|a| Some(a.call) == call).ok_or_else(|| protocol("Error outside active call"))?;
                            a.io_cancel.cancel();
                            let mut failures = vec![Error::new("OC_PLUGIN_COLLECT", format!("Native collection failed: {code:?}"))];
                            while let Some(result) = ios.join_next().await { if let Err(error) = finish_io(result, &writer).await { failures.push(error); } }
                            let fatal = failures.len() > 1;
                            let error = Error::aggregate(failures); let _sent = a.response.send(Err(error.clone()));
                            if fatal { return Err(error); }
                        }
                        PluginMessage::Cancelled { call, .. } => {
                            let a = active.take().filter(|a| a.call == call).ok_or_else(|| protocol("Cancellation outside active call"))?;
                            if !stopping || !ios.is_empty() { return Err(protocol("Premature cancellation acknowledgement")); }
                            let _sent = a.response.send(Err(Error::cancelled()));
                        }
                        PluginMessage::Stopped { .. } => {
                            if !stopping || !ios.is_empty() { return Err(protocol("Premature stop acknowledgement")); }
                            if let Some(a) = active.take() { let _sent = a.response.send(Err(Error::cancelled())); }
                            stopped = true;
                        }
                    }
                }
                request = requests.recv(), if initialized && active.is_none() && !stopping => {
                    let Some(request) = request else { return Err(protocol("Native owner disconnected")); };
                    check_cancel(&request.cancel)?;
                    call = call.checked_add(1).filter(|v| *v <= sdk::MAX_SAFE_INTEGER).ok_or_else(|| protocol("Call identifier exhausted"))?;
                    let timeout = spec.timeout.min(Duration::from_secs(60));
                    active = Some(Active { call, cancel: request.cancel, io_cancel: CancellationToken::new(), io_bytes: Arc::new(AtomicUsize::new(0)), assembly: Reassembly::new(RESULT_RESERVATION).map_err(sdk_error)?, response: request.response, deadline: tokio::time::Instant::now() + timeout });
                    send(&writer, HostMessage::Collect { v: VERSION, generation, call, deadline_ms: timeout.as_millis() as u64 }).await?;
                }
                _ = tick => { if (!initialized || stopping) && tokio::time::Instant::now() >= stop_deadline { return Err(Error::timeout("plugin lifecycle acknowledgement")); } }
            }
        }
        Ok(())
    }.await;
    if let Some(ready) = ready.take() { let _sent = ready.send(result.clone().and_then(|_| Err(protocol("Plugin stopped before ready")))); }
    if let Some(a) = &active { a.io_cancel.cancel(); }
    let mut failures: Vec<Error> = result.err().into_iter().collect();
    while let Some(result) = ios.join_next().await { if let Err(error) = finish_io(result, &writer).await { failures.push(error); } }
    drop(writer);
    let mut read_done = false; let mut write_done = false; let mut terminated = false;
    if stopped {
        let deadline = tokio::time::sleep(Duration::from_secs(2)); tokio::pin!(deadline);
        while !(read_done && write_done && stderr_done) {
            tokio::select! {
                value = &mut read_task, if !read_done => { read_done = true; record_join(value, &mut failures); }
                value = &mut write_task, if !write_done => { write_done = true; record_join(value, &mut failures); }
                value = &mut stderr_task, if !stderr_done => { stderr_done = true; record_join(value, &mut failures); }
                frame = messages.recv(), if !read_done => {
                    match frame { Some(Ok(Some(_))) => { failures.push(protocol("Plugin emitted a message after stopped")); break; }, Some(Err(error)) => { failures.push(error); break; }, _ => {} }
                }
                _ = &mut deadline => { failures.push(Error::timeout("plugin pipes after stopped")); break; }
            }
        }
    }
    if !stopped || !(read_done && write_done && stderr_done) {
        if let Err(error) = terminate(&mut child, identity.as_ref().ok()).await { failures.push(error); }
        terminated = true;
    }
    if !terminated {
        match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
            Ok(Ok(status)) if status.success() => {},
            Ok(Ok(_)) => failures.push(protocol("Native plugin exited unsuccessfully")),
            Ok(Err(error)) => failures.push(Error::cleanup("plugin wait", Error::io("wait", error))),
            Err(_) => { failures.push(Error::timeout("plugin exit after stdio closed")); if let Err(error) = terminate(&mut child, identity.as_ref().ok()).await { failures.push(error); } }
        }
    }
    pipes.cancel();
    if !read_done { record_join(read_task.await, &mut failures); }
    if !write_done { record_join(write_task.await, &mut failures); }
    if !stderr_done { record_join(stderr_task.await, &mut failures); }
    let result = if failures.is_empty() { Ok(()) } else { Err(Error::aggregate(failures)) };
    if let Some(a) = active.take() { let _sent = a.response.send(Err(result.clone().err().unwrap_or_else(Error::cancelled))); }
    lease.finish(if result.is_ok() { Outcome::Completed } else { Outcome::Failed }); result
}
fn record_join(value: std::result::Result<Result<()>, tokio::task::JoinError>, failures: &mut Vec<Error>) {
    match value { Ok(Ok(())) => {}, Ok(Err(error)) => failures.push(error), Err(_) => failures.push(Error::cleanup("plugin pipe", protocol("Pipe worker panicked"))) }
}
async fn terminate(child: &mut Child, identity: Option<&ProcessIdentity>) -> Result<()> {
    let mut failures = Vec::new();
    // The spawned leader has not been waited/reaped yet. Its PID and original
    // process-group number cannot be reused even if it exited before its children.
    if let Some(identity) = identity.filter(|identity| child.id() == Some(identity.pid)) {
        if identity.process_group != identity.pid { failures.push(Error::cleanup("plugin identity", protocol("Plugin changed its process group"))); }
        else if unsafe { libc::kill(-(identity.pid as i32), libc::SIGKILL) } != 0 {
            let error = std::io::Error::last_os_error(); if error.raw_os_error() != Some(libc::ESRCH) { failures.push(Error::cleanup("plugin group", Error::io("kill", error))); }
        }
    }
    // Tokio's Child is the unreaped child handle, so this does not target a reused PID.
    if let Err(error) = child.start_kill() { if error.raw_os_error() != Some(libc::ESRCH) { failures.push(Error::cleanup("plugin child", Error::io("kill", error))); } }
    if let Err(error) = child.wait().await { failures.push(Error::cleanup("plugin wait", Error::io("wait", error))); }
    if failures.is_empty() { Ok(()) } else { Err(Error::aggregate(failures)) }
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;
