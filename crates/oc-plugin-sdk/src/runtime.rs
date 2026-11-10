use crate::*;
use std::{collections::BTreeMap, io::{BufReader, Read, Write}, sync::{Arc, Condvar, Mutex, MutexGuard, atomic::{AtomicBool, Ordering}, mpsc::{self, Receiver, SyncSender, TrySendError}}, thread, time::{Duration, Instant}};

/// Collector-owned persistent memory must be included in business_bytes. IO buffers are
/// separately reserved. Implementations must check cancellation before committing
/// baselines/history, using CollectContext::commit for an atomic publication decision.
pub trait Collector: Send + 'static {
    fn id(&self) -> &'static str;
    fn io_reassembly_bytes(&self) -> usize;
    fn business_bytes(&self) -> usize;
    fn collect(&mut self, context: &CollectContext) -> Result<serde_json::Value>;
    fn stop(&mut self) -> Result<()>;
}
struct PendingRequest { call: u64, io: u64, operation: IoOperation, max_bytes: usize, timeout_ms: u64 }
struct PendingIo { request: PendingRequest, assembly: Reassembly, streams: [usize; 3], result: Option<Result<IoOutput>> }
struct Active { call: u64, deadline: Instant, cancelled: Arc<AtomicBool>, done: bool, completed: bool, cancelled_by_host: bool }
struct State {
    generation: u64, init: Option<Initialize>, active: Option<Active>, last_call: u64,
    next_io: u64, ios: BTreeMap<u64, PendingIo>, stopping: bool, fatal: Option<Error>,
}
impl State {
    fn new() -> Self { Self { generation: 0, init: None, active: None, last_call: 0, next_io: 0, ios: BTreeMap::new(), stopping: false, fatal: None } }
    fn check_call(&self, call: u64) -> Result<()> {
        if let Some(error) = &self.fatal { return Err(error.clone()); }
        let active = self.active.as_ref().filter(|a| a.call == call).ok_or_else(|| Error::protocol("inactive call"))?;
        if self.stopping || active.cancelled.load(Ordering::Acquire) { return Err(Error::new(ErrorCode::Cancelled, "collection cancelled")); }
        if Instant::now() >= active.deadline { return Err(Error::new(ErrorCode::Deadline, "collection deadline exceeded")); }
        Ok(())
    }
    fn revoke(&mut self) {
        if let Some(active) = &self.active { active.cancelled.store(true, Ordering::Release); }
        self.ios.retain(|_, io| { io.assembly.discard(); io.result.is_none() });
    }
}
struct Shared { state: Mutex<State>, changed: Condvar }
impl Shared {
    fn lock(&self) -> Result<MutexGuard<'_, State>> { self.state.lock().map_err(|_| Error::new(ErrorCode::Cleanup, "plugin state mutex poisoned")) }
    fn fail(&self, error: Error) {
        match self.state.lock() {
            Ok(mut state) => { state.fatal = Some(error); state.revoke(); self.changed.notify_all(); }
            Err(poisoned) => { let mut state = poisoned.into_inner(); state.fatal = Some(Error::new(ErrorCode::Cleanup, "plugin state mutex poisoned")); state.revoke(); self.changed.notify_all(); }
        }
    }
}
struct Outgoing { frame: Vec<u8> }
fn send_bounded<T>(tx: &SyncSender<T>, mut value: T, shutdown: &AtomicBool, cancelled: Option<&AtomicBool>) -> Result<()> {
    loop {
        if shutdown.load(Ordering::Acquire) { return Err(Error::new(ErrorCode::Io, "transport stopped")); }
        if cancelled.is_some_and(|c| c.load(Ordering::Acquire)) { return Err(Error::new(ErrorCode::Cancelled, "collection cancelled")); }
        match tx.try_send(value) {
            Ok(()) => return Ok(()),
            Err(TrySendError::Disconnected(_)) => return Err(Error::new(ErrorCode::Io, "transport channel disconnected")),
            Err(TrySendError::Full(v)) => { value = v; thread::park_timeout(Duration::from_millis(2)); }
        }
    }
}
#[derive(Clone)]
pub struct CollectContext {
    call: u64, generation: u64, shared: Arc<Shared>, output: SyncSender<Outgoing>, shutdown: Arc<AtomicBool>, cancelled: Arc<AtomicBool>,
}
impl CollectContext {
    pub fn call(&self) -> u64 { self.call }
    pub fn generation(&self) -> u64 { self.generation }
    pub fn check_cancelled(&self) -> Result<()> { self.shared.lock()?.check_call(self.call) }
    /// Serializes state commit against cancel/stop; closure must be short and perform no IO.
    pub fn commit<T>(&self, commit: impl FnOnce() -> T) -> Result<T> {
        let guard = self.shared.lock()?; guard.check_call(self.call)?; Ok(commit())
    }
    fn send(&self, body: PluginMessage, cancellable: bool) -> Result<()> {
        if cancellable { self.check_cancelled()?; }
        body.validate(Some(self.generation))?;
        let cancelled = cancellable.then_some(self.cancelled.as_ref());
        send_bounded(&self.output, Outgoing { frame: encode_frame(&body)? }, &self.shutdown, cancelled)
    }
    /// max_bytes counts stdout + stderr + data together. No raw stderr enters errors.
    /// Concurrent callers share a maximum of eight IO slots and a single reassembly reservation.
    pub fn request(&self, operation: IoOperation, max_bytes: usize, timeout_ms: u64) -> Result<IoOutput> {
        operation.validate()?;
        let request = {
            let mut state = self.shared.lock()?; state.check_call(self.call)?;
            let init = state.init.as_ref().ok_or_else(|| Error::protocol("IO before initialize"))?;
            if !init.capabilities.contains(&operation.capability()) { return Err(Error::new(ErrorCode::Capability, "host capability not granted")); }
            if max_bytes == 0 || max_bytes > MAX_IO_BYTES || timeout_ms == 0 || timeout_ms > 60_000
                || state.ios.len() >= init.budgets.max_io
                || max_bytes > init.budgets.io_reassembly_bytes.saturating_sub(state.ios.values().map(|p| p.request.max_bytes).sum::<usize>()) {
                return Err(Error::new(ErrorCode::Limit, "IO exceeds admitted reservation"));
            }
            let remaining = state.active.as_ref().unwrap().deadline.saturating_duration_since(Instant::now()).as_millis() as u64;
            let timeout_ms = timeout_ms.min(remaining); if timeout_ms == 0 { return Err(Error::new(ErrorCode::Deadline, "no IO deadline remaining")); }
            state.next_io = state.next_io.checked_add(1).filter(|n| *n <= MAX_SAFE_INTEGER).ok_or_else(|| Error::protocol("IO identifier exhausted"))?;
            let request = PendingRequest { call: self.call, io: state.next_io, operation, max_bytes, timeout_ms };
            state.ios.insert(request.io, PendingIo { request: PendingRequest { call: request.call, io: request.io, operation: request.operation.clone(), max_bytes: request.max_bytes, timeout_ms: request.timeout_ms }, assembly: Reassembly::new(max_bytes)?, streams: [0; 3], result: None });
            request
        };
        let message = PluginMessage::IoRequest { v: VERSION, generation: self.generation, call: request.call, io: request.io, operation: request.operation.clone(), max_bytes: request.max_bytes, timeout_ms: request.timeout_ms };
        if let Err(error) = self.send(message, true) {
            self.shared.lock()?.ios.remove(&request.io);
            return Err(error);
        }
        let mut state = self.shared.lock()?;
        loop {
            state.check_call(self.call)?;
            let pending = state.ios.get_mut(&request.io).ok_or_else(|| Error::protocol("missing IO request"))?;
            if let Some(result) = pending.result.take() { state.ios.remove(&request.io); return result; }
            let (next, _) = self.shared.changed.wait_timeout(state, Duration::from_millis(25)).map_err(|_| Error::new(ErrorCode::Cleanup, "IO wait mutex poisoned"))?;
            state = next;
        }
    }
    pub fn command(&self, command: Command, max_bytes: usize) -> Result<String> {
        self.request(IoOperation::Command { command }, max_bytes, 4000)?.text()
    }
    fn publish(&self, result: &serde_json::Value) -> Result<()> {
        // Publication is committed atomically: once the first chunk is accepted, all
        // chunks and the end marker are delivered regardless of a racing cancel.
        self.check_cancelled()?;
        let limit = self.shared.lock()?.init.as_ref().ok_or_else(|| Error::protocol("uninitialized result publication"))?.budgets.result_bytes;
        let bytes = encode_json(result, limit)?;
        for (seq, chunk) in bytes.chunks(MAX_CHUNK).enumerate() {
            self.send(PluginMessage::ResultChunk { v: VERSION, generation: self.generation, call: self.call, seq: seq as u64, data: encode_chunk(chunk)? }, false)?;
        }
        self.send(PluginMessage::ResultEnd { v: VERSION, generation: self.generation, call: self.call, bytes: bytes.len(), sha256: digest(&bytes) }, false)?;
        let _ = self.shared.lock().map(|mut state| { if let Some(active) = state.active.as_mut().filter(|a| a.call == self.call) { active.completed = true; } });
        Ok(())
    }
}

enum Event { Host(HostMessage), Fault(Error), Eof, Done { call: u64, outcome: Result<()> }, Stopped(Result<()>) }
enum Work { Collect(CollectContext), Stop }

fn receive_io(state: &mut State, message: &HostMessage) -> Result<()> {
    let (call, io) = match message { HostMessage::IoChunk { call, io, .. } | HostMessage::IoEnd { call, io, .. } | HostMessage::IoError { call, io, .. } => (*call, *io), _ => return Err(Error::protocol("not an IO reply")) };
    let cancelled = state.active.as_ref().filter(|a| a.call == call).ok_or_else(|| Error::protocol("IO reply for inactive call"))?.cancelled.load(Ordering::Acquire);
    let pending = state.ios.get_mut(&io).filter(|p| p.request.call == call && p.result.is_none()).ok_or_else(|| Error::protocol("unknown IO or duplicate completion"))?;
    let command = matches!(pending.request.operation, IoOperation::Command { .. });
    match message {
        HostMessage::IoChunk { seq, stream, data, .. } => {
            if (command && *stream == Stream::Data) || (!command && *stream != Stream::Data) { return Err(Error::protocol("wrong stream for IO operation")); }
            let index = match stream { Stream::Stdout => 0, Stream::Stderr => 1, Stream::Data => 2 };
            let n = pending.assembly.push_filtered(*seq, data, *stream != Stream::Stderr)?;
            pending.streams[index] += n;
        }
        HostMessage::IoEnd { bytes, sha256, stdout_bytes, stderr_bytes, data_bytes, exit_code, identity, .. } => {
            if pending.streams != [*stdout_bytes, *stderr_bytes, *data_bytes]
                || pending.streams.iter().sum::<usize>() != *bytes || command != exit_code.is_some() {
                return Err(Error::protocol("IO stream totals or exit identity mismatch"));
            }
            let data = pending.assembly.finish(*bytes, sha256)?;
            pending.result = Some(if exit_code.is_some_and(|code| code != 0) { Err(Error::new(ErrorCode::Io, "host command exited unsuccessfully")) }
                else { Ok(IoOutput { data, exit_code: *exit_code, identity: identity.clone() }) });
        }
        HostMessage::IoError { code, message: text, .. } => {
            if *code == ErrorCode::Cleanup { return Err(Error::new(ErrorCode::Cleanup, "host IO cleanup failed")); }
            pending.result = Some(Err(Error::new(*code, text.clone())));
        }
        _ => unreachable!(),
    }
    if cancelled && pending.result.is_some() { state.ios.remove(&io); }
    Ok(())
}
fn emit(output: &SyncSender<Outgoing>, shutdown: &AtomicBool, message: PluginMessage) -> Result<()> {
    message.validate(Some(message.generation()))?;
    send_bounded(output, Outgoing { frame: encode_frame(&message)? }, shutdown, None)
}

/// Real stdio transport uses poll plus O_NONBLOCK, so cancel/stop never strand an
/// unjoinable reader or writer. Five seconds of zero write progress is an error.
#[cfg(unix)]
struct Pipe { fd: i32, stop: Arc<AtomicBool>, flags: i32 }
#[cfg(unix)]
impl Pipe {
    fn new(fd: i32, stop: Arc<AtomicBool>) -> Result<Self> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 { return Err(std::io::Error::last_os_error().into()); }
        Ok(Self { fd, stop, flags })
    }
    fn ready(&self, events: i16, deadline: Option<Instant>) -> std::io::Result<()> {
        loop {
            if self.stop.load(Ordering::Acquire) { return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "transport stopped")); }
            if deadline.is_some_and(|d| Instant::now() >= d) { return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "stdio backpressure deadline")); }
            let mut poll = libc::pollfd { fd: self.fd, events, revents: 0 };
            let result = unsafe { libc::poll(&mut poll, 1, 50) };
            if result > 0 { if poll.revents & libc::POLLNVAL != 0 { return Err(std::io::Error::other("invalid protocol pipe")); } return Ok(()); }
            if result < 0 { let error = std::io::Error::last_os_error(); if error.kind() != std::io::ErrorKind::Interrupted { return Err(error); } }
        }
    }
    fn restore(&mut self) -> Result<()> {
        if unsafe { libc::fcntl(self.fd, libc::F_SETFL, self.flags) } < 0 { return Err(Error::new(ErrorCode::Cleanup, "failed restoring protocol pipe flags")); } Ok(())
    }
}
#[cfg(unix)]
impl Read for Pipe {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        loop {
            self.ready(libc::POLLIN, None)?;
            let n = unsafe { libc::read(self.fd, bytes.as_mut_ptr().cast(), bytes.len()) };
            if n >= 0 { return Ok(n as usize); }
            let e = std::io::Error::last_os_error(); if !matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) { return Err(e); }
        }
    }
}
#[cfg(unix)]
impl Write for Pipe {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            self.ready(libc::POLLOUT, Some(deadline))?;
            let n = unsafe { libc::write(self.fd, bytes.as_ptr().cast(), bytes.len()) };
            if n >= 0 { return Ok(n as usize); }
            let e = std::io::Error::last_os_error(); if !matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) { return Err(e); }
        }
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

pub fn run_stdio<C: Collector>(collector: C) -> Result<()> {
    let shared = Arc::new(Shared { state: Mutex::new(State::new()), changed: Condvar::new() });
    let shutdown = Arc::new(AtomicBool::new(false));
    let read_stop = Arc::new(AtomicBool::new(false));
    let mut input = Pipe::new(libc::STDIN_FILENO, read_stop.clone())?;
    let output_pipe = match Pipe::new(libc::STDOUT_FILENO, shutdown.clone()) { Ok(p) => p, Err(error) => { input.restore()?; return Err(error); } };
    let (events_tx, events) = mpsc::sync_channel(1);
    let (output, outgoing) = mpsc::sync_channel::<Outgoing>(WRITE_QUEUE);
    let (work, work_rx) = mpsc::sync_channel(1);
    let id = collector.id(); let io_bytes = collector.io_reassembly_bytes(); let business_bytes = collector.business_bytes();
    let reader = {
        let tx = events_tx.clone(); let stop = read_stop.clone();
        thread::spawn(move || {
            let mut reader = BufReader::with_capacity(8192, input);
            loop {
                let event = match read_frame::<_, HostMessage>(&mut reader) { Ok(Some(m)) => Event::Host(m), Ok(None) => Event::Eof, Err(e) => Event::Fault(e) };
                let terminal = !matches!(event, Event::Host(_));
                if stop.load(Ordering::Acquire) { break; }
                if send_bounded(&tx, event, &stop, None).is_err() { break; }
                if terminal { break; }
            }
            reader.get_mut().restore()
        })
    };
    let writer = {
        let shared = shared.clone();
        thread::spawn(move || {
            let mut pipe = output_pipe;
            let outcome = (|| -> Result<()> {
                while let Ok(message) = outgoing.recv() {
                    pipe.write_all(&message.frame)?;
                }
                Ok(())
            })();
            if let Err(error) = &outcome { shared.fail(error.clone()); }
            pipe.restore()?; outcome
        })
    };
    let worker = {
        let tx = events_tx.clone(); let stop = shutdown.clone();
        thread::spawn(move || {
            let mut collector = collector;
            while let Ok(work) = work_rx.recv() {
                match work {
                    Work::Collect(context) => {
                        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| collector.collect(&context).and_then(|value| context.publish(&value))))
                            .unwrap_or_else(|_| Err(Error::new(ErrorCode::Collect, "collector panicked")));
                        if send_bounded(&tx, Event::Done { call: context.call, outcome }, &stop, None).is_err() { break; }
                    }
                    Work::Stop => break,
                }
            }
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| collector.stop()))
                .unwrap_or_else(|_| Err(Error::new(ErrorCode::Cleanup, "collector cleanup panicked")));
            if !stop.load(Ordering::Acquire) { send_bounded(&tx, Event::Stopped(result.clone()), &stop, None)?; }
            result
        })
    };
    drop(events_tx);
    let outcome = coordinate(&shared, &shutdown, &output, &events, &work, id, io_bytes, business_bytes);
    if let Err(error) = &outcome { shared.fail(error.clone()); shutdown.store(true, Ordering::Release); }
    read_stop.store(true, Ordering::Release);
    drop(work);
    let worker_result = worker.join().map_err(|_| Error::new(ErrorCode::Cleanup, "collector thread panicked")).and_then(|r| r);
    drop(output);
    let writer_result = writer.join().map_err(|_| Error::new(ErrorCode::Cleanup, "writer thread panicked")).and_then(|r| r);
    shutdown.store(true, Ordering::Release);
    let reader_result = reader.join().map_err(|_| Error::new(ErrorCode::Cleanup, "reader thread panicked")).and_then(|r| r);
    let failures: Vec<_> = [worker_result, writer_result, reader_result].into_iter().filter_map(std::result::Result::err).collect();
    if !failures.is_empty() { return Err(Error::new(ErrorCode::Cleanup, format!("transport cleanup failed: {failures:?}; primary: {outcome:?}"))); }
    outcome
}
fn coordinate(shared: &Arc<Shared>, shutdown: &Arc<AtomicBool>, output: &SyncSender<Outgoing>, events: &Receiver<Event>, work: &SyncSender<Work>, id: &str, io_bytes: usize, business_bytes: usize) -> Result<()> {
    let mut stopping_worker = false;
    loop {
        {
            let state = shared.lock()?;
            if let Some(error) = &state.fatal { return Err(error.clone()); }
            if let Some(active) = &state.active {
                if Instant::now() >= active.deadline + Duration::from_secs(5) { return Err(Error::new(ErrorCode::Deadline, "collection or host IO failed to drain")); }
            }
        }
        let event = match events.recv_timeout(Duration::from_millis(25)) { Ok(e) => Some(e), Err(mpsc::RecvTimeoutError::Timeout) => None, Err(_) => return Err(Error::new(ErrorCode::Io, "all transport workers disconnected")) };
        if let Some(event) = event {
            match event {
                Event::Fault(e) => return Err(e), Event::Eof => return Err(Error::protocol("host disconnected without stop")),
                Event::Stopped(result) => { result?; let generation = shared.lock()?.generation; emit(output, shutdown, PluginMessage::Stopped { v: VERSION, generation })?; return Ok(()); }
                Event::Done { call, outcome } => {
                    let mut state = shared.lock()?;
                    state.active.as_mut().filter(|a| a.call == call && !a.done).ok_or_else(|| Error::protocol("duplicate collector completion"))?.done = true;
                    if let Err(error) = outcome {
                        if error.code == ErrorCode::Cleanup { return Err(error); }
                        state.revoke();
                        if error.code != ErrorCode::Cancelled {
                            let generation = state.generation; drop(state);
                            emit(output, shutdown, PluginMessage::Error { v: VERSION, generation, call: Some(call), code: error.code, message: error.message })?;
                            continue;
                        }
                    }
                }
                Event::Host(message) => {
                    let mut state = shared.lock()?;
                    message.validate(state.init.as_ref().map(|_| state.generation))?;
                    match message {
                        HostMessage::Initialize { generation, id: plugin_id, app_version, capabilities, budgets, .. } => {
                            if state.init.is_some() || plugin_id != id || io_bytes > budgets.io_reassembly_bytes || business_bytes > MAX_RESULT { return Err(Error::protocol("duplicate initialization, identity or reservation mismatch")); }
                            let protocol_bytes = TRANSPORT_RESERVATION + budgets.result_bytes + io_bytes;
                            state.generation = generation; state.init = Some(Initialize { id: plugin_id, app_version, capabilities, budgets }); drop(state);
                            emit(output, shutdown, PluginMessage::Ready { v: VERSION, generation, protocol_bytes, io_reassembly_bytes: io_bytes, business_bytes })?;
                        }
                        HostMessage::Collect { call, deadline_ms, .. } => {
                            if state.init.is_none() || state.stopping || state.active.is_some() || call <= state.last_call { return Err(Error::protocol("uninitialized, overlapping or nonmonotonic collect")); }
                            let cancelled = Arc::new(AtomicBool::new(false)); state.last_call = call;
                            state.active = Some(Active { call, deadline: Instant::now() + Duration::from_millis(deadline_ms), cancelled: cancelled.clone(), done: false, completed: false, cancelled_by_host: false });
                            let context = CollectContext { call, generation: state.generation, shared: shared.clone(), output: output.clone(), shutdown: shutdown.clone(), cancelled };
                            drop(state); work.try_send(Work::Collect(context)).map_err(|_| Error::protocol("collector work queue is not empty"))?;
                        }
                        HostMessage::Cancel { call, .. } => {
                            if state.active.as_ref().is_none_or(|a| a.call != call || a.cancelled.load(Ordering::Acquire)) { return Err(Error::protocol("cancel for inactive or cancelled call")); }
                            state.active.as_mut().unwrap().cancelled_by_host = true; state.revoke(); shared.changed.notify_all();
                        }
                        HostMessage::Stop { .. } => {
                            if state.stopping { return Err(Error::protocol("duplicate stop")); }
                            state.stopping = true; state.revoke(); shared.changed.notify_all();
                        }
                        reply => { receive_io(&mut state, &reply)?; shared.changed.notify_all(); }
                    }
                }
            }
        }
        let mut state = shared.lock()?;
        let complete = state.active.as_ref().is_some_and(|a| a.done) && state.ios.is_empty();
        if complete {
            let active = state.active.take().unwrap();
            if active.cancelled_by_host && !active.completed { let generation = state.generation; drop(state); emit(output, shutdown, PluginMessage::Cancelled { v: VERSION, generation, call: active.call })?; state = shared.lock()?; }
        }
        if state.stopping && state.active.is_none() && !stopping_worker {
            stopping_worker = true; drop(state); work.try_send(Work::Stop).map_err(|_| Error::protocol("stop work queue is not empty"))?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state_with_io() -> State {
        let mut state = State::new(); state.generation = 1;
        state.active = Some(Active { call: 1, deadline: Instant::now() + Duration::from_secs(5), cancelled: Arc::new(AtomicBool::new(false)), done: false, completed: false, cancelled_by_host: false });
        let request = PendingRequest { call: 1, io: 1, operation: IoOperation::Command { command: Command::Processes }, max_bytes: 100, timeout_ms: 1000 };
        state.ios.insert(1, PendingIo { request, assembly: Reassembly::new(100).unwrap(), streams: [0; 3], result: None }); state
    }
    fn end() -> HostMessage { HostMessage::IoEnd { v: 2, generation: 1, call: 1, io: 1, bytes: 3, sha256: digest(b"abc"), stdout_bytes: 3, stderr_bytes: 0, data_bytes: 0, exit_code: Some(0), identity: "pid:1/birth:1/pgid:1".into() } }
    #[test] fn cancellation_revokes_io_and_drains_terminal_reply() {
        let mut state = state_with_io(); state.revoke();
        assert_eq!(state.check_call(1).unwrap_err().code, ErrorCode::Cancelled);
        receive_io(&mut state, &HostMessage::IoChunk { v: 2, generation: 1, call: 1, io: 1, seq: 0, stream: Stream::Stdout, data: encode_chunk(b"abc").unwrap() }).unwrap();
        receive_io(&mut state, &end()).unwrap(); assert!(state.ios.is_empty());
        assert!(receive_io(&mut state, &end()).is_err());
    }
    #[test] fn stream_totals_and_cleanup_failures_cannot_be_hidden() {
        let mut state = state_with_io();
        receive_io(&mut state, &HostMessage::IoChunk { v: 2, generation: 1, call: 1, io: 1, seq: 0, stream: Stream::Stderr, data: encode_chunk(b"abc").unwrap() }).unwrap();
        assert!(receive_io(&mut state, &end()).is_err()); state.revoke();
        assert_eq!(receive_io(&mut state, &HostMessage::IoError { v: 2, generation: 1, call: 1, io: 1, code: ErrorCode::Cleanup, message: "cleanup failed".into() }).unwrap_err().code, ErrorCode::Cleanup);
    }
    #[test] fn stop_wakes_waiting_io_without_waiting_for_reply() {
        let shared = Arc::new(Shared { state: Mutex::new(state_with_io()), changed: Condvar::new() });
        let (tx, _rx) = mpsc::sync_channel(4);
        let context = CollectContext { call: 1, generation: 1, shared: shared.clone(), output: tx, shutdown: Arc::new(AtomicBool::new(false)), cancelled: shared.lock().unwrap().active.as_ref().unwrap().cancelled.clone() };
        { let mut state = shared.lock().unwrap(); state.stopping = true; state.revoke(); shared.changed.notify_all(); }
        assert_eq!(context.check_cancelled().unwrap_err().code, ErrorCode::Cancelled);
        assert!(context.commit(|| panic!("cancelled state must not commit")).is_err());
    }
    #[test] fn bounded_output_queue_is_interruptible() {
        let (tx, _rx) = mpsc::sync_channel(1); tx.send(1).unwrap();
        let cancelled = AtomicBool::new(true);
        assert_eq!(send_bounded(&tx, 2, &AtomicBool::new(false), Some(&cancelled)).unwrap_err().code, ErrorCode::Cancelled);
    }
}
