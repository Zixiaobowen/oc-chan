use std::{collections::{BTreeMap, VecDeque}, future::Future, sync::{Arc, Mutex}, time::Instant};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use crate::error::{Error, Result, check_cancel};

tokio::task_local! { static ACTIVE_IO: (); }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceLimits {
    pub commands: usize, pub files: usize, pub sockets: usize,
    pub command_bytes: usize, pub file_bytes: usize, pub socket_bytes: usize,
    pub plugin_processes: usize, pub plugin_protocol_bytes: usize,
    pub queued: usize, pub queued_per_source: usize, pub sources: usize, pub queue_timeout_ms: u64,
}
impl Default for ResourceLimits {
    fn default() -> Self {
        Self { commands: 8, files: 8, sockets: 8, command_bytes: 32 * 1024 * 1024, file_bytes: 16 * 1024 * 1024,
            socket_bytes: 512 * 1024, plugin_processes: 16, plugin_protocol_bytes: 8 * 1024 * 1024,
            queued: 256, queued_per_source: 128, sources: 32, queue_timeout_ms: 10_000 }
    }
}
impl ResourceLimits {
    fn valid(&self) -> bool {
        let default = Self::default();
        [(self.commands, default.commands), (self.files, default.files), (self.sockets, default.sockets),
            (self.command_bytes, default.command_bytes), (self.file_bytes, default.file_bytes),
            (self.socket_bytes, default.socket_bytes), (self.plugin_processes, default.plugin_processes),
            (self.plugin_protocol_bytes, default.plugin_protocol_bytes), (self.queued, default.queued),
            (self.queued_per_source, default.queued_per_source), (self.sources, default.sources)]
            .into_iter().all(|(actual, maximum)| actual > 0 && actual <= maximum)
            && self.queue_timeout_ms > 0 && self.queue_timeout_ms <= default.queue_timeout_ms
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceUsage {
    pub commands: usize, pub files: usize, pub sockets: usize,
    pub stdout_bytes: usize, pub stderr_bytes: usize, pub command_bytes: usize,
    pub file_bytes: usize, pub socket_bytes: usize,
    pub plugin_processes: usize, pub plugin_protocol_bytes: usize, pub queued: usize,
}
impl ResourceUsage {
    fn peak(&mut self, other: &Self) {
        self.commands = self.commands.max(other.commands); self.files = self.files.max(other.files);
        self.sockets = self.sockets.max(other.sockets); self.stdout_bytes = self.stdout_bytes.max(other.stdout_bytes);
        self.stderr_bytes = self.stderr_bytes.max(other.stderr_bytes); self.command_bytes = self.command_bytes.max(other.command_bytes);
        self.file_bytes = self.file_bytes.max(other.file_bytes); self.socket_bytes = self.socket_bytes.max(other.socket_bytes);
        self.plugin_processes = self.plugin_processes.max(other.plugin_processes);
        self.plugin_protocol_bytes = self.plugin_protocol_bytes.max(other.plugin_protocol_bytes); self.queued = self.queued.max(other.queued);
    }
    fn charge(&mut self, request: Request, add: bool) {
        fn change(current: &mut usize, value: usize, add: bool) {
            *current = if add { current.checked_add(value).expect("validated resource addition") }
                else { current.checked_sub(value).expect("resource lease released exactly once") };
        }
        match request {
            Request::Command { stdout_bytes, stderr_bytes, input_bytes } => {
                change(&mut self.commands, 1, add); change(&mut self.stdout_bytes, stdout_bytes, add);
                change(&mut self.stderr_bytes, stderr_bytes, add); change(&mut self.command_bytes, stdout_bytes + stderr_bytes, add);
                if let Some(bytes) = input_bytes { change(&mut self.files, 1, add); change(&mut self.file_bytes, bytes, add); }
            }
            Request::NetworkCommand { stdout_bytes, stderr_bytes, file_bytes, socket_bytes } => {
                change(&mut self.commands, 1, add); change(&mut self.stdout_bytes, stdout_bytes, add);
                change(&mut self.stderr_bytes, stderr_bytes, add); change(&mut self.command_bytes, stdout_bytes + stderr_bytes, add);
                change(&mut self.files, 1, add); change(&mut self.file_bytes, file_bytes, add);
                change(&mut self.sockets, 1, add); change(&mut self.socket_bytes, socket_bytes, add);
            }
            Request::File { bytes } => { change(&mut self.files, 1, add); change(&mut self.file_bytes, bytes, add); }
            Request::Socket { bytes } => { change(&mut self.sockets, 1, add); change(&mut self.socket_bytes, bytes, add); }
            Request::Plugin { bytes } => { change(&mut self.plugin_processes, 1, add); change(&mut self.plugin_protocol_bytes, bytes, add); }
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceStatistics {
    pub current: ResourceUsage, pub peak: ResourceUsage,
    pub admitted: u64, pub completed: u64, pub failed: u64, pub cancelled: u64, pub rejected: u64,
    pub queue_timeouts: u64, pub total_wait_ms: f64, pub max_wait_ms: f64,
    pub total_execution_ms: f64, pub max_execution_ms: f64,
}
impl ResourceStatistics {
    fn waiting(&mut self, milliseconds: f64) { self.total_wait_ms += milliseconds; self.max_wait_ms = self.max_wait_ms.max(milliseconds); }
    fn admit(&mut self, request: Request, wait_ms: f64) {
        self.current.charge(request, true); self.peak.peak(&self.current); self.admitted += 1; self.waiting(wait_ms);
    }
    fn release(&mut self, request: Request, outcome: Outcome, elapsed: f64) {
        self.current.charge(request, false);
        match outcome { Outcome::Completed => self.completed += 1, Outcome::Failed => self.failed += 1, Outcome::Cancelled => self.cancelled += 1 }
        self.total_execution_ms += elapsed; self.max_execution_ms = self.max_execution_ms.max(elapsed);
    }
    fn enqueue(&mut self) { self.current.queued += 1; self.peak.peak(&self.current); }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatistics { pub source: String, #[serde(flatten)] pub statistics: ResourceStatistics }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceBudgetSnapshot { pub limits: ResourceLimits, pub global: ResourceStatistics, pub sources: Vec<SourceStatistics> }

#[derive(Clone, Copy, Debug)]
pub enum Request {
    Command { stdout_bytes: usize, stderr_bytes: usize, input_bytes: Option<usize> },
    NetworkCommand { stdout_bytes: usize, stderr_bytes: usize, file_bytes: usize, socket_bytes: usize },
    File { bytes: usize }, Socket { bytes: usize }, Plugin { bytes: usize },
}
impl Request {
    fn kind(self) -> usize { match self { Self::Command { .. } | Self::NetworkCommand { .. } => 0, Self::File { .. } => 1, Self::Socket { .. } => 2, Self::Plugin { .. } => 3 } }
    fn valid(self, limits: &ResourceLimits) -> bool {
        match self {
            Self::Command { stdout_bytes, stderr_bytes, input_bytes } => stdout_bytes <= limits.command_bytes
                && stderr_bytes <= limits.command_bytes - stdout_bytes && input_bytes.is_none_or(|v| v <= limits.file_bytes),
            Self::NetworkCommand { stdout_bytes, stderr_bytes, file_bytes, socket_bytes } => stdout_bytes <= limits.command_bytes
                && stderr_bytes <= limits.command_bytes - stdout_bytes && file_bytes > 0 && file_bytes <= limits.file_bytes
                && socket_bytes > 0 && socket_bytes <= limits.socket_bytes,
            Self::File { bytes } => bytes <= limits.file_bytes,
            Self::Socket { bytes } => bytes <= limits.socket_bytes,
            Self::Plugin { bytes } => bytes <= limits.plugin_protocol_bytes,
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub enum Outcome { Completed, Failed, Cancelled }

struct Waiting { source: usize, request: Request, order: u64, enqueued: Instant, sender: oneshot::Sender<Lease> }
#[derive(Default)]
struct Queue { order: VecDeque<usize>, sources: BTreeMap<usize, VecDeque<Waiting>> }
impl Queue {
    fn front(&self) -> Option<&Waiting> { self.order.front().and_then(|source| self.sources.get(source)).and_then(VecDeque::front) }
    fn pop(&mut self) -> Waiting {
        let source = self.order.pop_front().expect("queue front");
        let queue = self.sources.get_mut(&source).expect("source queue");
        let waiting = queue.pop_front().expect("source queue front");
        if queue.is_empty() { self.sources.remove(&source); } else { self.order.push_back(source); }
        waiting
    }
    fn push(&mut self, entry: Waiting) {
        if !self.sources.contains_key(&entry.source) { self.order.push_back(entry.source); }
        self.sources.entry(entry.source).or_default().push_back(entry);
    }
    fn remove(&mut self, source: usize, order: u64) -> Option<Waiting> {
        let queue = self.sources.get_mut(&source)?;
        let index = queue.iter().position(|entry| entry.order == order)?;
        let removed = queue.remove(index);
        if queue.is_empty() { self.sources.remove(&source); self.order.retain(|value| *value != source); }
        removed
    }
}
struct State {
    global: ResourceStatistics, sources: Vec<SourceStatistics>, names: BTreeMap<String, usize>,
    queues: [Queue; 4], next_order: u64, closed: bool,
}
struct Inner { limits: ResourceLimits, state: Mutex<State> }
#[derive(Clone)]
pub struct ResourceBudget { inner: Arc<Inner> }

impl ResourceBudget {
    pub fn new(limits: ResourceLimits) -> Result<Self> {
        if !limits.valid() { return Err(Error::new("OC_RESOURCE_LIMIT", "invalid resource limits")); }
        let sources = Vec::with_capacity(limits.sources);
        Ok(Self { inner: Arc::new(Inner { limits, state: Mutex::new(State {
            global: ResourceStatistics::default(), sources, names: BTreeMap::new(), queues: std::array::from_fn(|_| Queue::default()), next_order: 0, closed: false,
        }) }) })
    }
    pub(crate) fn file_capacity(&self) -> usize { self.inner.limits.file_bytes }
    pub fn snapshot(&self) -> ResourceBudgetSnapshot {
        let state = self.inner.state.lock().expect("resource state poisoned");
        ResourceBudgetSnapshot { limits: self.inner.limits.clone(), global: state.global.clone(), sources: state.sources.clone() }
    }
    pub fn close(&self) {
        let mut state = self.inner.state.lock().expect("resource state poisoned");
        state.closed = true;
        for kind in 0..4 {
            while state.queues[kind].front().is_some() {
                let entry = state.queues[kind].pop();
                state.unqueue(&entry); state.global.cancelled += 1; state.sources[entry.source].statistics.cancelled += 1;
                // Dropping this sender wakes the waiter; active leases remain owned.
            }
        }
    }
    pub async fn acquire(&self, source: &str, request: Request, cancel: &CancellationToken) -> Result<Lease> {
        if ACTIVE_IO.try_with(|_| ()).is_ok() { return Err(Error::new("OC_RESOURCE_LIMIT", "nested resource request")); }
        check_cancel(cancel)?;
        let (receiver, order, source_id) = {
            let mut state = self.inner.state.lock().expect("resource state poisoned");
            if state.closed { return Err(Error::new("OC_RESOURCE_CLOSED", "resource admission is closed")); }
            if source.is_empty() || source.len() > 64 || !source.as_bytes()[0].is_ascii_lowercase()
                || !source.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
                state.global.rejected += 1;
                return Err(Error::new("OC_RESOURCE_LIMIT", "invalid source id"));
            }
            let source_id = if let Some(id) = state.names.get(source) { *id } else {
                if state.sources.len() >= self.inner.limits.sources {
                    state.global.rejected += 1; return Err(Error::new("OC_RESOURCE_LIMIT", "source count limit"));
                }
                let id = state.sources.len();
                state.sources.push(SourceStatistics { source: source.to_owned(), statistics: ResourceStatistics::default() });
                state.names.insert(source.to_owned(), id); id
            };
            if !request.valid(&self.inner.limits) {
                state.reject(source_id); return Err(Error::new("OC_RESOURCE_LIMIT", "request exceeds resource capacity"));
            }
            let kind = request.kind();
            if state.queues[kind].front().is_none() && state.fits(request, u64::MAX, &self.inner.limits) {
                return Ok(state.admit(&self.inner, source_id, request, 0.0));
            }
            if state.global.current.queued >= self.inner.limits.queued || state.sources[source_id].statistics.current.queued >= self.inner.limits.queued_per_source {
                state.reject(source_id); return Err(Error::new("OC_RESOURCE_LIMIT", "resource queue limit"));
            }
            let order = state.next_order;
            state.next_order = state.next_order.checked_add(1).ok_or_else(|| Error::new("OC_RESOURCE_LIMIT", "queue order exhausted"))?;
            let (sender, receiver) = oneshot::channel();
            state.queues[kind].push(Waiting { source: source_id, request, order, enqueued: Instant::now(), sender });
            state.global.enqueue(); state.sources[source_id].statistics.enqueue();
            state.drain(&self.inner);
            (receiver, order, source_id)
        };
        let mut registration = WaitingGuard { inner: self.inner.clone(), source: source_id, kind: request.kind(), order, active: true, timed_out: false };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(Error::cancelled()),
            result = receiver => {
                registration.active = false;
                result.map_err(|_| Error::new("OC_RESOURCE_CLOSED", "resource admission closed while waiting"))
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(self.inner.limits.queue_timeout_ms)) => {
                registration.timed_out = true;
                Err(Error::new("OC_RESOURCE_QUEUE_TIMEOUT", "采集资源排队超时 / Collection resource queue timed out"))
            }
        }
    }
    pub fn source_status(&self) -> crate::model::SourceStatus {
        use crate::model::{SourceState, SourceStatus};
        let resources = self.snapshot();
        let state = if resources.global.current.queued > 0 { SourceState::Partial } else { SourceState::Ok };
        let current = &resources.global.current;
        let detail = format!("命令 {}/{}, 文件 {}/{}, socket {}/{}, 插件 {}/{}；排队 {}/{}；拒绝 {}，排队超时 {}。原始 IO 预留，不代表进程内存。",
            current.commands, resources.limits.commands, current.files, resources.limits.files, current.sockets, resources.limits.sockets,
            current.plugin_processes, resources.limits.plugin_processes, current.queued, resources.limits.queued,
            resources.global.rejected, resources.global.queue_timeouts);
        let mut status = SourceStatus::new("collection-resources", "采集资源额度", state, detail);
        status.resources = Some(resources); status
    }
}
impl Default for ResourceBudget { fn default() -> Self { Self::new(ResourceLimits::default()).expect("valid fixed resource limits") } }

impl State {
    fn reject(&mut self, source: usize) { self.global.rejected += 1; self.sources[source].statistics.rejected += 1; }
    fn fits(&self, request: Request, order: u64, limits: &ResourceLimits) -> bool {
        let current = &self.global.current;
        match request {
            Request::Command { stdout_bytes, stderr_bytes, input_bytes } => {
                if current.commands >= limits.commands || stdout_bytes + stderr_bytes > limits.command_bytes - current.command_bytes { return false; }
                if let Some(bytes) = input_bytes {
                    if self.queues[1].front().is_some_and(|entry| entry.order < order) { return false; }
                    if current.files >= limits.files || bytes > limits.file_bytes - current.file_bytes { return false; }
                }
                true
            }
            Request::NetworkCommand { stdout_bytes, stderr_bytes, file_bytes, socket_bytes } => {
                if self.queues[2].front().is_some_and(|entry| entry.order < order) { return false; }
                current.sockets < limits.sockets && socket_bytes <= limits.socket_bytes - current.socket_bytes
                    && self.fits(Request::Command { stdout_bytes, stderr_bytes, input_bytes: Some(file_bytes) }, order, limits)
            }
            Request::File { bytes } => {
                if self.queues[0].front().is_some_and(|entry| entry.order < order && matches!(entry.request, Request::Command { input_bytes: Some(_), .. } | Request::NetworkCommand { .. })) { return false; }
                current.files < limits.files && bytes <= limits.file_bytes - current.file_bytes
            }
            Request::Socket { bytes } => {
                if self.queues[0].front().is_some_and(|entry| entry.order < order && matches!(entry.request, Request::NetworkCommand { .. })) { return false; }
                current.sockets < limits.sockets && bytes <= limits.socket_bytes - current.socket_bytes
            }
            Request::Plugin { bytes } => current.plugin_processes < limits.plugin_processes && bytes <= limits.plugin_protocol_bytes - current.plugin_protocol_bytes,
        }
    }
    fn admit(&mut self, inner: &Arc<Inner>, source: usize, request: Request, wait_ms: f64) -> Lease {
        self.global.admit(request, wait_ms); self.sources[source].statistics.admit(request, wait_ms);
        Lease { inner: inner.clone(), source, request, started: Instant::now(), active: true, queue_wait_ms: wait_ms }
    }
    fn unqueue(&mut self, entry: &Waiting) -> f64 {
        self.global.current.queued -= 1; self.sources[entry.source].statistics.current.queued -= 1;
        entry.enqueued.elapsed().as_secs_f64() * 1000.0
    }
    fn release(&mut self, lease: &mut Lease, outcome: Outcome) {
        if !lease.active { return; }
        lease.active = false;
        let elapsed = lease.started.elapsed().as_secs_f64() * 1000.0;
        self.global.release(lease.request, outcome, elapsed);
        self.sources[lease.source].statistics.release(lease.request, outcome, elapsed);
    }
    fn drain(&mut self, inner: &Arc<Inner>) {
        if self.closed { return; }
        loop {
            let mut advanced = false;
            for kind in 0..4 {
                while let Some(front) = self.queues[kind].front() {
                    if !self.fits(front.request, front.order, &inner.limits) { break; }
                    let entry = self.queues[kind].pop();
                    let wait_ms = self.unqueue(&entry);
                    let lease = self.admit(inner, entry.source, entry.request, wait_ms);
                    if let Err(mut abandoned) = entry.sender.send(lease) { self.release(&mut abandoned, Outcome::Cancelled); }
                    advanced = true;
                }
            }
            if !advanced { break; }
        }
    }
}
struct WaitingGuard { inner: Arc<Inner>, source: usize, kind: usize, order: u64, active: bool, timed_out: bool }
impl Drop for WaitingGuard {
    fn drop(&mut self) {
        if !self.active { return; }
        let mut state = self.inner.state.lock().expect("resource state poisoned");
        if let Some(entry) = state.queues[self.kind].remove(self.source, self.order) {
            let elapsed = state.unqueue(&entry);
            state.global.waiting(elapsed); state.sources[self.source].statistics.waiting(elapsed);
            if self.timed_out {
                state.global.queue_timeouts += 1; state.sources[self.source].statistics.queue_timeouts += 1; state.reject(self.source);
            } else { state.global.cancelled += 1; state.sources[self.source].statistics.cancelled += 1; }
        }
        state.drain(&self.inner);
    }
}

/// Owns reserved capacity until the actual operation and its cleanup finish.
/// The IO supervisor, never a caller-owned timeout future, owns this lease.
pub struct Lease { inner: Arc<Inner>, source: usize, request: Request, started: Instant, active: bool, pub queue_wait_ms: f64 }
impl Lease {
    pub fn finish(mut self, outcome: Outcome) {
        let inner = self.inner.clone();
        let mut state = inner.state.lock().expect("resource state poisoned");
        state.release(&mut self, outcome); state.drain(&inner);
    }
    pub async fn run<T>(self, work: impl Future<Output = Result<T>>) -> Result<T> {
        let result = ACTIVE_IO.scope((), work).await;
        let outcome = match &result { Ok(_) => Outcome::Completed, Err(error) if error.is_cancelled() => Outcome::Cancelled, Err(_) => Outcome::Failed };
        self.finish(outcome); result
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if !self.active { return; }
        let inner = self.inner.clone();
        let mut state = inner.state.lock().expect("resource state poisoned");
        state.release(self, Outcome::Cancelled); state.drain(&inner);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn network_workers_wait_without_partial_reservations_and_preserve_socket_order() {
        let pool = ResourceBudget::new(ResourceLimits { sockets: 1, ..ResourceLimits::default() }).unwrap();
        let cancel = CancellationToken::new();
        let occupied = pool.acquire("occupied", Request::Socket { bytes: 64 }, &cancel).await.unwrap();
        let socket = pool.acquire("socket", Request::Socket { bytes: 64 }, &cancel);
        tokio::pin!(socket); assert!(futures_util::poll!(&mut socket).is_pending());
        let network = pool.acquire("http", Request::NetworkCommand { stdout_bytes: 128, stderr_bytes: 32, file_bytes: 256, socket_bytes: 64 }, &cancel);
        tokio::pin!(network); assert!(futures_util::poll!(&mut network).is_pending());
        assert_eq!(pool.snapshot().global.current.commands, 0);
        assert_eq!(pool.snapshot().global.current.files, 0);
        occupied.finish(Outcome::Completed);
        let socket = socket.await.unwrap(); assert!(futures_util::poll!(&mut network).is_pending());
        socket.finish(Outcome::Completed);
        let network = network.await.unwrap();
        let current = pool.snapshot().global.current;
        assert_eq!((current.commands, current.files, current.sockets), (1, 1, 1));
        assert_eq!((current.command_bytes, current.file_bytes, current.socket_bytes), (160, 256, 64));
        network.finish(Outcome::Completed);
        assert_eq!(pool.snapshot().global.current, ResourceUsage::default());
    }
    #[tokio::test]
    async fn cancelled_waiter_does_not_own_capacity_and_active_work_keeps_it() {
        let pool = ResourceBudget::new(ResourceLimits { commands: 1, ..ResourceLimits::default() }).unwrap();
        let token = CancellationToken::new();
        let first = pool.acquire("first", Request::Command { stdout_bytes: 8, stderr_bytes: 8, input_bytes: None }, &token).await.unwrap();
        let second_token = CancellationToken::new();
        let future = pool.acquire("second", Request::Command { stdout_bytes: 8, stderr_bytes: 8, input_bytes: None }, &second_token);
        tokio::pin!(future);
        assert!(futures_util::poll!(&mut future).is_pending());
        second_token.cancel();
        assert_eq!(future.await.err().unwrap().code, "ABORT_ERR");
        let snapshot = pool.snapshot();
        assert_eq!(snapshot.global.current.commands, 1); assert_eq!(snapshot.global.current.queued, 0);
        first.finish(Outcome::Completed);
        assert_eq!(pool.snapshot().global.current.commands, 0);
    }
    #[tokio::test]
    async fn source_round_robin_prevents_flooded_source_from_starving_another() {
        let pool = ResourceBudget::new(ResourceLimits { commands: 1, ..ResourceLimits::default() }).unwrap();
        let cancel = CancellationToken::new();
        let request = Request::Command { stdout_bytes: 1, stderr_bytes: 1, input_bytes: None };
        let occupied = pool.acquire("occupied", request, &cancel).await.unwrap();
        let a1 = pool.acquire("a", request, &cancel); tokio::pin!(a1); assert!(futures_util::poll!(&mut a1).is_pending());
        let a2 = pool.acquire("a", request, &cancel); tokio::pin!(a2); assert!(futures_util::poll!(&mut a2).is_pending());
        let b1 = pool.acquire("b", request, &cancel); tokio::pin!(b1); assert!(futures_util::poll!(&mut b1).is_pending());
        occupied.finish(Outcome::Completed);
        let first = a1.await.unwrap(); assert!(futures_util::poll!(&mut b1).is_pending());
        first.finish(Outcome::Completed);
        let second = b1.await.unwrap(); assert!(futures_util::poll!(&mut a2).is_pending());
        second.finish(Outcome::Completed); a2.await.unwrap().finish(Outcome::Completed);
        assert_eq!(pool.snapshot().global.current.commands, 0);
    }
    #[tokio::test]
    async fn composite_command_preserves_older_file_request_turn() {
        let pool = ResourceBudget::new(ResourceLimits { files: 1, ..ResourceLimits::default() }).unwrap();
        let cancel = CancellationToken::new();
        let occupied = pool.acquire("occupied", Request::File { bytes: 1 }, &cancel).await.unwrap();
        let file = pool.acquire("reader", Request::File { bytes: 1 }, &cancel); tokio::pin!(file); assert!(futures_util::poll!(&mut file).is_pending());
        let command = pool.acquire("worker", Request::Command { stdout_bytes: 1, stderr_bytes: 1, input_bytes: Some(1) }, &cancel);
        tokio::pin!(command); assert!(futures_util::poll!(&mut command).is_pending());
        occupied.finish(Outcome::Completed);
        let file = file.await.unwrap(); assert!(futures_util::poll!(&mut command).is_pending());
        file.finish(Outcome::Completed); command.await.unwrap().finish(Outcome::Completed);
        assert_eq!(pool.snapshot().global.current.files, 0);
    }
}
