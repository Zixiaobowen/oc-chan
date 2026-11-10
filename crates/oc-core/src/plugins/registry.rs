use super::BoxFuture;
use crate::{error::{Error, Result, check_cancel, validate_text}, io::BoundedIo, model::*};
use futures_util::{FutureExt, future::Shared};
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, BTreeSet}, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, time::Duration};
use tokio::sync::{Mutex as AsyncMutex, oneshot};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub const MAX_PLUGINS: usize = 16;
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "section", content = "snapshot", rename_all = "lowercase")]
pub enum SnapshotData { Agents(AgentSnapshot), Schedules(ScheduleSnapshot), System(SystemSnapshot), Events(EventSnapshot) }
impl SnapshotData {
    pub fn section(&self) -> MonitorSection { match self { Self::Agents(_) => MonitorSection::Agents, Self::Schedules(_) => MonitorSection::Schedules, Self::System(_) => MonitorSection::System, Self::Events(_) => MonitorSection::Events } }
    pub fn from_json(section: MonitorSection, bytes: &[u8]) -> Result<Self> {
        if bytes.len() > oc_plugin_sdk::MAX_RESULT { return Err(Error::limit("plugin result", oc_plugin_sdk::MAX_RESULT, bytes.len())); }
        let invalid = |error: serde_json::Error| Error::new("OC_PLUGIN_DATA", format!("插件返回无效分区数据 / Invalid plugin section data (category={:?}, line={}, column={})", error.classify(), error.line(), error.column()));
        let value = match section {
            MonitorSection::Agents => Self::Agents(serde_json::from_slice(bytes).map_err(invalid)?),
            MonitorSection::Schedules => Self::Schedules(serde_json::from_slice(bytes).map_err(invalid)?),
            MonitorSection::System => Self::System(serde_json::from_slice(bytes).map_err(invalid)?),
            MonitorSection::Events => Self::Events(serde_json::from_slice(bytes).map_err(invalid)?),
        };
        // serde enforces the complete DTO and rejects unknown keys. Native packages
        // currently declare system; additionally bound every business vector/value.
        if let Self::System(s) = &value {
            let percentage = |v: f64| v.is_finite() && (0.0..=100.0).contains(&v);
            let rate = |v: f64| v.is_finite() && v >= 0.0;
            if s.history.len() > 60 || s.processes.len() > 20 || s.memory_processes.len() > 20 || s.sources.len() > 64
                || !percentage(s.cpu_percent.unwrap_or(0.0)) || !rate(s.uptime_seconds)
                || s.cpu_cores == 0 || s.cpu_cores > 4096 || s.memory_used > s.memory_total || s.memory_available > s.memory_total
                || s.history.iter().any(|p| !percentage(p.memory_percent) || !percentage(p.cpu_percent.unwrap_or(0.0)) || !rate(p.rx_bytes_per_second.unwrap_or(0.0)) || !rate(p.tx_bytes_per_second.unwrap_or(0.0)))
                || s.processes.iter().chain(&s.memory_processes).any(|p| p.pid == 0 || p.name.len() > 1024 || !rate(p.cpu_percent))
                || !rate(s.rx_bytes_per_second.unwrap_or(0.0)) || !rate(s.tx_bytes_per_second.unwrap_or(0.0)) {
                return Err(Error::invalid("plugin system snapshot bounds"));
            }
            for (text, max) in [(&s.hostname, 512), (&s.platform, 64), (&s.os_version, 256), (&s.cpu_model, 1024)] { validate_text(text, max, max * 4, "plugin system text")?; }
            crate::model::validate_iso_time(&s.collected_at)?;
        }
        Ok(value)
    }
}
#[derive(Clone, Debug)]
pub struct Publication { pub id: String, pub generation: u64, pub section: MonitorSection, pub snapshot: SnapshotData, pub source_id: Option<String>, pub incremental: bool }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginPhase { Idle, Starting, Running, Stopping, Disabled, Failed }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatus { pub id: String, pub section: MonitorSection, pub enabled: bool, pub phase: PluginPhase, pub generation: u64, pub error: Option<String> }
#[derive(Clone, Debug)]
pub enum RegistryEvent {
    Snapshot(Publication), State(PluginStatus),
    Error { id: String, section: MonitorSection, source_id: Option<String>, error: Error },
    Removed { id: String, section: MonitorSection },
}
/// Observers enqueue notifications synchronously; they must not reenter a publisher.
pub type Observer = Arc<dyn Fn(RegistryEvent) + Send + Sync>;
#[derive(Clone)]
pub struct Publisher { id: String, section: MonitorSection, generation: u64, gate: Arc<Mutex<bool>>, observer: Observer }
impl Publisher {
    pub fn generation(&self) -> u64 { self.generation }
    pub(crate) fn report_error(&self, error: Error) {
        let active = self.gate.lock().expect("publisher poisoned");
        if !*active { return; }
        (self.observer)(RegistryEvent::Error { id: self.id.clone(), section: self.section, source_id: None, error });
    }
    pub fn publish(&self, snapshot: SnapshotData, source_id: Option<String>, incremental: bool) -> Result<bool> {
        if snapshot.section() != self.section { return Err(Error::invalid("plugin publication section")); }
        let active = self.gate.lock().expect("publisher poisoned");
        if !*active { return Ok(false); }
        #[cfg(feature = "acceptance")]
        {
            crate::performance::observe(|| serde_json::json!(["publish-batch", crate::performance::stamp(), self.section.as_str()]));
            if let SnapshotData::Agents(agents) = &snapshot { crate::performance::publication(agents); }
        }
        (self.observer)(RegistryEvent::Snapshot(Publication { id: self.id.clone(), generation: self.generation, section: self.section, snapshot, source_id, incremental }));
        Ok(true)
    }
    fn revoke(&self) { *self.gate.lock().expect("publisher poisoned") = false; }
}
#[derive(Clone)]
pub struct PluginContext { pub publisher: Publisher, pub io: BoundedIo, pub cancel: CancellationToken }
/// Every method owns and drains its IO after cancellation. A deadline cancels the
/// lifecycle but never drops its future and declares a still-running task stopped.
pub trait CollectionPlugin: Send + Sync {
    fn start(&self, cancel: CancellationToken) -> BoxFuture<'_, Result<()>>;
    fn collect(&self, cancel: CancellationToken, source: Option<String>) -> BoxFuture<'_, Result<Option<SnapshotData>>>;
    fn stop(&self) -> BoxFuture<'_, Result<()>>;
    fn history(&self, _job: ScheduledJob, _offset: usize, _cancel: CancellationToken) -> BoxFuture<'_, Result<ScheduleHistory>> { Box::pin(async { Err(Error::new("OC_PLUGIN_CAPABILITY", "Execution history unavailable")) }) }
    fn events(&self, _query: EventQuery, _cancel: CancellationToken) -> BoxFuture<'_, Result<EventPage>> { Box::pin(async { Err(Error::new("OC_PLUGIN_CAPABILITY", "Event queries unavailable")) }) }
}
pub type PluginFactory = Arc<dyn Fn(PluginContext) -> Result<Arc<dyn CollectionPlugin>> + Send + Sync>;
#[derive(Clone)]
pub struct PluginDefinition {
    pub id: String, pub section: MonitorSection, pub capabilities: Vec<String>, pub dependencies: Vec<String>,
    pub retry_sources: Vec<String>, pub interval: Duration, pub timeout: Duration, pub create: PluginFactory,
}
impl PluginDefinition {
    pub fn validate(&self) -> Result<()> {
        if !valid_name(&self.id) || !(Duration::from_millis(10)..=Duration::from_secs(60)).contains(&self.interval)
            || !(Duration::from_millis(10)..=Duration::from_secs(60)).contains(&self.timeout) { return Err(Error::invalid("plugin definition")); }
        for values in [&self.dependencies, &self.capabilities] {
            if values.len() > 16 || values.iter().any(|v| !valid_name(v)) || values.iter().collect::<BTreeSet<_>>().len() != values.len() { return Err(Error::invalid("plugin metadata names")); }
        }
        if self.retry_sources.len() > 64 || self.retry_sources.iter().collect::<BTreeSet<_>>().len() != self.retry_sources.len() { return Err(Error::invalid("plugin retry sources")); }
        for source in &self.retry_sources { validate_text(source, 128, 512, "plugin retry source")?; }
        Ok(())
    }
}
fn valid_name(s: &str) -> bool { !s.is_empty() && s.len() <= 64 && s.as_bytes()[0].is_ascii_lowercase() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') }
type Completion = Shared<BoxFuture<'static, Result<()>>>;
struct Lifecycle {
    enabled: bool, phase: PluginPhase, generation: u64, error: Option<Error>, poisoned: Option<Error>,
    instance: Option<Arc<dyn CollectionPlugin>>, publisher: Option<Publisher>, cancel: CancellationToken,
    pending: BTreeMap<Option<String>, Completion>, last: Option<Completion>, sequence: u64,
}
struct Entry { definition: PluginDefinition, state: Mutex<Lifecycle>, sample: AsyncMutex<()>, queries: tokio::sync::RwLock<()> }
pub struct Registry {
    io: BoundedIo, observer: Observer, entries: Mutex<BTreeMap<String, Arc<Entry>>>,
    coordination: Arc<AsyncMutex<()>>, closed: AtomicBool, generation: AtomicU64, tasks: TaskTracker,
}
impl Registry {
    pub fn new(io: BoundedIo, observer: Observer) -> Arc<Self> { Arc::new(Self { io, observer, entries: Mutex::new(BTreeMap::new()), coordination: Arc::new(AsyncMutex::new(())), closed: AtomicBool::new(false), generation: AtomicU64::new(0), tasks: TaskTracker::new() }) }
    pub fn coordination(&self) -> Arc<AsyncMutex<()>> { self.coordination.clone() }
    pub fn statuses(&self) -> Vec<PluginStatus> { self.entries.lock().expect("registry poisoned").values().map(|e| Self::status(e)).collect() }
    fn status(e: &Entry) -> PluginStatus { let s = e.state.lock().expect("lifecycle poisoned"); PluginStatus { id: e.definition.id.clone(), section: e.definition.section, enabled: s.enabled, phase: s.phase, generation: s.generation, error: s.error.as_ref().map(ToString::to_string) } }
    fn notify(&self, e: &Entry) { (self.observer)(RegistryEvent::State(Self::status(e))); }
    fn report(&self, e: &Entry, source: Option<String>, error: Error) {
        { let mut s = e.state.lock().expect("lifecycle poisoned"); s.phase = PluginPhase::Failed; s.error = Some(error.clone()); if error.is_cleanup() { s.poisoned = Some(error.clone()); } }
        self.notify(e); (self.observer)(RegistryEvent::Error { id: e.definition.id.clone(), section: e.definition.section, source_id: source, error });
    }
    fn entry(&self, id: &str) -> Result<Arc<Entry>> { self.entries.lock().expect("registry poisoned").get(id).cloned().ok_or_else(|| Error::new("OC_PLUGIN_UNKNOWN", "Unknown plugin")) }
    fn open(&self) -> Result<()> { if self.closed.load(Ordering::Acquire) { Err(Error::new("OC_PLUGIN_CLOSED", "Plugin registry closed")) } else { Ok(()) } }
    async fn supervise<T: Send + 'static>(self: &Arc<Self>, work: impl Future<Output = Result<T>> + Send + 'static) -> Result<T> {
        let (send, receive) = oneshot::channel();
        self.tasks.spawn(async move { if let Err(Err(error)) = send.send(work.await) { eprintln!("abandoned plugin operation: {error}"); } });
        receive.await.map_err(|_| Error::cleanup("plugin task", Error::new("OC_PLUGIN_PANIC", "Plugin task exited unexpectedly")))?
    }
    pub async fn register(self: &Arc<Self>, definition: PluginDefinition, enabled: bool) -> Result<()> {
        let this = self.clone(); self.supervise(async move { let _guard = this.coordination.lock().await; this.register_locked(definition, enabled).await }).await
    }
    pub async fn register_with_cancel_locked(self: &Arc<Self>, definition: PluginDefinition, enabled: bool, cancel: &CancellationToken) -> Result<()> {
        check_cancel(cancel)?;
        let id = definition.id.clone();
        let work = self.register_locked(definition, enabled); tokio::pin!(work);
        tokio::select! {
            biased;
            result = &mut work => result,
            _ = cancel.cancelled() => {
                if let Ok(entry) = self.entry(&id) { self.revoke(&entry); }
                match work.await { Err(error) if !error.is_cancelled() => Err(Error::aggregate(vec![Error::cancelled(), error])), _ => Err(Error::cancelled()) }
            }
        }
    }
    /// Caller holds coordination() across the entire settings/market transaction.
    pub async fn register_locked(self: &Arc<Self>, definition: PluginDefinition, enabled: bool) -> Result<()> {
        self.open()?; definition.validate()?;
        let entry = Arc::new(Entry { definition, sample: AsyncMutex::new(()), queries: tokio::sync::RwLock::new(()), state: Mutex::new(Lifecycle { enabled, phase: PluginPhase::Disabled, generation: 0, error: None, poisoned: None, instance: None, publisher: None, cancel: CancellationToken::new(), pending: BTreeMap::new(), last: None, sequence: 0 }) });
        {
            let mut entries = self.entries.lock().expect("registry poisoned");
            if entries.len() >= MAX_PLUGINS { return Err(Error::limit("plugins", MAX_PLUGINS, entries.len() + 1)); }
            if entries.contains_key(&entry.definition.id) { return Err(Error::invalid("duplicate plugin id")); }
            for dependency in &entry.definition.dependencies {
                let other = entries.get(dependency).ok_or_else(|| Error::new("OC_PLUGIN_DEPENDENCY", "Missing or cyclic plugin dependency"))?;
                if dependency == &entry.definition.id || (enabled && !other.state.lock().expect("lifecycle poisoned").enabled) { return Err(Error::new("OC_PLUGIN_DEPENDENCY", "Plugin dependency unavailable")); }
            }
            entries.insert(entry.definition.id.clone(), entry.clone());
        }
        if enabled {
            if let Err(error) = self.start_entry(&entry).await {
                match self.stop_entry(&entry).await {
                    Ok(()) => { self.entries.lock().expect("registry poisoned").remove(&entry.definition.id); (self.observer)(RegistryEvent::Removed { id: entry.definition.id.clone(), section: entry.definition.section }); return Err(error); }
                    Err(cleanup) => return Err(Error::aggregate(vec![error, cleanup])),
                }
            }
        } else { self.notify(&entry); }
        Ok(())
    }
    async fn start_entry(self: &Arc<Self>, entry: &Arc<Entry>) -> Result<()> {
        self.open()?;
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        if generation > oc_plugin_sdk::MAX_SAFE_INTEGER { return Err(Error::invalid("plugin generation exhausted")); }
        let cancel = self.io.cancellation();
        let publisher = Publisher { id: entry.definition.id.clone(), section: entry.definition.section, generation, gate: Arc::new(Mutex::new(true)), observer: self.observer.clone() };
        {
            let mut s = entry.state.lock().expect("lifecycle poisoned"); if let Some(error) = &s.poisoned { return Err(error.clone()); }
            s.enabled = true; s.phase = PluginPhase::Starting; s.generation = generation; s.error = None; s.cancel = cancel.clone(); s.publisher = Some(publisher.clone());
        }
        self.notify(entry);
        let instance = match (entry.definition.create)(PluginContext { publisher, io: self.io.clone(), cancel: cancel.clone() }) {
            Ok(instance) => instance,
            Err(error) => { self.revoke(entry); self.report(entry, None, error.clone()); return Err(error); }
        };
        entry.state.lock().expect("lifecycle poisoned").instance = Some(instance.clone());
        let result = drain_deadline(instance.start(cancel.clone()), &cancel, entry.definition.timeout, "plugin start").await;
        if let Err(error) = result { self.revoke(entry); self.report(entry, None, error.clone()); return Err(error); }
        self.collect(&entry.definition.id, None).await?;
        let weak = Arc::downgrade(self); let entry = entry.clone();
        self.tasks.spawn(async move {
            let mut timer = tokio::time::interval_at(tokio::time::Instant::now() + entry.definition.interval, entry.definition.interval);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! { biased; _ = cancel.cancelled() => break, _ = timer.tick() => {} }
                let Some(registry) = weak.upgrade() else { break; };
                let idle = entry.state.lock().expect("lifecycle poisoned").pending.is_empty();
                if idle { let _reported = registry.collect(&entry.definition.id, None).await; }
            }
        });
        Ok(())
    }
    pub async fn collect(self: &Arc<Self>, id: &str, source: Option<String>) -> Result<()> {
        self.open()?; let entry = self.entry(id)?;
        if source.as_ref().is_some_and(|s| !entry.definition.retry_sources.contains(s)) { return Err(Error::new("OC_PLUGIN_CAPABILITY", "Source does not support retry")); }
        let completion = {
            let mut state = entry.state.lock().expect("lifecycle poisoned");
            if !state.enabled || state.cancel.is_cancelled() { return Err(state.error.clone().unwrap_or_else(Error::cancelled)); }
            if let Some(error) = &state.poisoned { return Err(error.clone()); }
            if let Some(pending) = state.pending.get(&source) { pending.clone() } else {
                let (send, receive) = oneshot::channel();
                let completion = async move { receive.await.map_err(|_| Error::cleanup("collection task", Error::new("OC_PLUGIN_PANIC", "Collection task exited")))? }.boxed().shared();
                let previous = state.last.clone(); let cancel = state.cancel.clone(); let instance = state.instance.clone().ok_or_else(|| Error::invalid("plugin instance"))?;
                let publisher = state.publisher.clone().ok_or_else(|| Error::invalid("plugin publisher"))?;
                state.sequence += 1; let sequence = state.sequence;
                state.pending.insert(source.clone(), completion.clone()); state.last = Some(completion.clone());
                let this = self.clone(); let entry = entry.clone(); let source = source.clone();
                self.tasks.spawn(async move {
                    if let Some(previous) = previous { let _reported = previous.await; }
                    let _serial = entry.sample.lock().await;
                    let result: Result<()> = async {
                        check_cancel(&cancel)?;
                        let snapshot = drain_deadline(instance.collect(cancel.clone(), source.clone()), &cancel, entry.definition.timeout, "plugin collect").await?;
                        check_cancel(&cancel)?;
                        if let Some(snapshot) = snapshot { publisher.publish(snapshot, source.clone(), false)?; }
                        Ok(())
                    }.await;
                    if let Err(error) = &result { if !error.is_cancelled() { this.report(&entry, source.clone(), error.clone()); } }
                    { let mut state = entry.state.lock().expect("lifecycle poisoned"); state.pending.remove(&source); if state.sequence == sequence { state.last = None; } if result.is_ok() && !cancel.is_cancelled() { state.phase = PluginPhase::Running; if source.is_none() { state.error = None; } } }
                    this.notify(&entry); let _delivered = send.send(result);
                });
                completion
            }
        };
        completion.await
    }
    pub async fn refresh(self: &Arc<Self>, section: Option<MonitorSection>, source: Option<String>) -> Result<()> {
        let entries: Vec<_> = self.entries.lock().expect("registry poisoned").values().filter(|e| section.is_none_or(|s| e.definition.section == s) && source.as_ref().is_none_or(|s| e.definition.retry_sources.contains(s)) && e.state.lock().expect("lifecycle poisoned").enabled).map(|e| e.definition.id.clone()).collect();
        if source.is_some() && entries.is_empty() { return Err(Error::new("OC_PLUGIN_CAPABILITY", "Source does not support retry")); }
        let results = futures_util::future::join_all(entries.iter().map(|id| self.collect(id, source.clone()))).await;
        aggregate(results)
    }
    pub async fn set_enabled(self: &Arc<Self>, id: &str, enabled: bool) -> Result<()> {
        let this = self.clone(); let id = id.to_owned(); self.supervise(async move { let _guard = this.coordination.lock().await; this.set_enabled_locked(&id, enabled).await }).await
    }
    pub async fn set_enabled_locked(self: &Arc<Self>, id: &str, enabled: bool) -> Result<()> {
        self.open()?; let entry = self.entry(id)?;
        self.dependencies(&entry, enabled)?;
        let has_instance = {
            let s = entry.state.lock().expect("lifecycle poisoned"); if let Some(error) = &s.poisoned { return Err(error.clone()); }
            if s.enabled == enabled && (enabled || s.phase == PluginPhase::Disabled) { return s.error.clone().map_or(Ok(()), Err); }
            s.instance.is_some()
        };
        if enabled { if has_instance { self.stop_entry(&entry).await?; } self.start_entry(&entry).await } else { self.stop_entry(&entry).await }
    }
    fn dependencies(&self, entry: &Entry, enabling: bool) -> Result<()> {
        let entries = self.entries.lock().expect("registry poisoned");
        for other in entries.values() {
            let related = if enabling { entry.definition.dependencies.contains(&other.definition.id) } else { other.definition.dependencies.contains(&entry.definition.id) };
            if related { let s = other.state.lock().expect("lifecycle poisoned"); if (enabling && (!s.enabled || s.cancel.is_cancelled() || s.poisoned.is_some())) || (!enabling && s.enabled) { return Err(Error::new("OC_PLUGIN_DEPENDENCY", "Plugin dependency is in use or unavailable")); } }
        }
        Ok(())
    }
    fn revoke(&self, entry: &Entry) {
        let mut state = entry.state.lock().expect("lifecycle poisoned");
        if let Some(publisher) = &state.publisher { publisher.revoke(); }
        state.enabled = false; state.cancel.cancel(); state.phase = PluginPhase::Stopping;
    }
    async fn stop_entry(&self, entry: &Entry) -> Result<()> {
        self.revoke(entry); self.notify(entry);
        let (pending, instance, cancel, poison) = { let s = entry.state.lock().expect("lifecycle poisoned"); (s.pending.values().cloned().collect::<Vec<_>>(), s.instance.clone(), s.cancel.clone(), s.poisoned.clone()) };
        let mut failures: Vec<_> = poison.into_iter().collect();
        for result in futures_util::future::join_all(pending).await { if let Err(error) = result { if error.is_cleanup() { failures.push(error); } } }
        // Queries may overlap so the domain can cancel a superseded query. The
        // exclusive stop barrier waits for every admitted query's actual cleanup.
        let _queries = entry.queries.write().await;
        if let Some(instance) = instance {
            if let Err(error) = drain_deadline(instance.stop(), &cancel, entry.definition.timeout, "plugin stop").await { failures.push(Error::cleanup("plugin stop", error)); }
        }
        if !failures.is_empty() { let error = Error::aggregate(failures); self.report(entry, None, error.clone()); return Err(error); }
        { let mut s = entry.state.lock().expect("lifecycle poisoned"); s.instance = None; s.publisher = None; s.phase = PluginPhase::Disabled; s.error = None; }
        self.notify(entry); Ok(())
    }
    pub async fn unregister(self: &Arc<Self>, id: &str) -> Result<()> {
        let this = self.clone(); let id = id.to_owned(); self.supervise(async move { let _guard = this.coordination.lock().await; this.unregister_locked(&id).await }).await
    }
    pub async fn unregister_locked(&self, id: &str) -> Result<()> {
        let entry = self.entry(id)?;
        if self.entries.lock().expect("registry poisoned").values().any(|e| e.definition.dependencies.iter().any(|d| d == id)) { return Err(Error::new("OC_PLUGIN_DEPENDENCY", "Plugin is required by another registration")); }
        self.stop_entry(&entry).await?;
        self.entries.lock().expect("registry poisoned").remove(id);
        (self.observer)(RegistryEvent::Removed { id: id.to_owned(), section: entry.definition.section }); Ok(())
    }
    pub async fn close(self: &Arc<Self>) -> Result<()> {
        self.closed.store(true, Ordering::Release);
        for entry in self.entries.lock().expect("registry poisoned").values() { self.revoke(entry); }
        let this = self.clone();
        // Do not put the tracker wait inside a tracked task.
        let result = self.supervise(async move {
            let _guard = this.coordination.lock().await;
            let entries = this.entries.lock().expect("registry poisoned").clone();
            let mut order = Vec::new(); let mut seen = BTreeSet::new();
            fn visit(id: &str, entries: &BTreeMap<String, Arc<Entry>>, seen: &mut BTreeSet<String>, order: &mut Vec<Arc<Entry>>) { if !seen.insert(id.to_owned()) { return; } let e = &entries[id]; for dependency in &e.definition.dependencies { visit(dependency, entries, seen, order); } order.push(e.clone()); }
            for id in entries.keys() { visit(id, &entries, &mut seen, &mut order); }
            let mut results = Vec::new(); for entry in order.into_iter().rev() { results.push(this.stop_entry(&entry).await); } aggregate(results)
        }).await;
        self.tasks.close(); self.tasks.wait().await; result
    }
    pub async fn history(self: &Arc<Self>, id: &str, job: ScheduledJob, offset: usize, cancel: CancellationToken) -> Result<ScheduleHistory> {
        let entry = self.entry(id)?; let (instance, lifecycle) = self.query_instance(&entry)?;
        self.supervise(async move {
            let _query = entry.queries.read().await; check_cancel(&lifecycle)?; check_cancel(&cancel)?;
            let work = instance.history(job, offset, cancel.clone()); tokio::pin!(work);
            tokio::select! { result = &mut work => { check_cancel(&lifecycle)?; result }, _ = lifecycle.cancelled() => { cancel.cancel(); let result = work.await; match result { Err(e) if e.is_cleanup() => Err(e), _ => Err(Error::cancelled()) } } }
        }).await
    }
    pub async fn events(self: &Arc<Self>, id: &str, query: EventQuery, cancel: CancellationToken) -> Result<EventPage> {
        let entry = self.entry(id)?; let (instance, lifecycle) = self.query_instance(&entry)?;
        self.supervise(async move {
            let _query = entry.queries.read().await; check_cancel(&lifecycle)?; check_cancel(&cancel)?;
            let work = instance.events(query, cancel.clone()); tokio::pin!(work);
            tokio::select! { result = &mut work => { check_cancel(&lifecycle)?; result }, _ = lifecycle.cancelled() => { cancel.cancel(); let result = work.await; match result { Err(e) if e.is_cleanup() => Err(e), _ => Err(Error::cancelled()) } } }
        }).await
    }
    fn query_instance(&self, entry: &Entry) -> Result<(Arc<dyn CollectionPlugin>, CancellationToken)> {
        self.open()?; let s = entry.state.lock().expect("lifecycle poisoned"); check_cancel(&s.cancel)?;
        if !s.enabled { return Err(Error::new("OC_PLUGIN_DISABLED", "Plugin disabled")); }
        Ok((s.instance.clone().ok_or_else(|| Error::invalid("plugin instance"))?, s.cancel.clone()))
    }
}
async fn drain_deadline<T>(future: impl Future<Output = Result<T>>, cancel: &CancellationToken, deadline: Duration, operation: &str) -> Result<T> {
    tokio::pin!(future);
    tokio::select! {
        result = &mut future => result,
        _ = tokio::time::sleep(deadline) => { cancel.cancel(); match future.await { Err(error) if !error.is_cancelled() => Err(Error::aggregate(vec![Error::timeout(operation), error])), _ => Err(Error::timeout(operation)) } }
    }
}
fn aggregate(results: Vec<Result<()>>) -> Result<()> { let failures: Vec<_> = results.into_iter().filter_map(Result::err).collect(); if failures.is_empty() { Ok(()) } else { Err(Error::aggregate(failures)) } }
