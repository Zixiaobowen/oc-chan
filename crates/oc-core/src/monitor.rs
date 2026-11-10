//! Section-scoped monitor state, generation-owned builtins and serialized settings.
//! Content and source observations have separate latest-value watch slots.
mod state;
mod builtins;
#[cfg(test)] mod tests;

use crate::{agents::{AgentCollector, AgentPaths}, error::{Error, Result, check_cancel, timestamp, validate_text},
    events::{EventCallbacks, EventInput, EventPaths, EventService, NotificationAdapter, SectionEnabled}, io::BoundedIo, model::*,
    plugins::{BoxFuture, CollectionPlugin, PluginDefinition, PluginPhase, PluginStatus, Registry, RegistryEvent, SnapshotData},
    process::ProcessIdentity, schedules::{ScheduleCollector, SchedulePaths}, settings::{AppSettings, Language, NotificationSettings, NotificationState, PluginSettings, ResolvedLanguage}, worker::DataWorker};
use futures_util::{FutureExt, future::Shared as SharedFuture};
use std::{collections::{BTreeMap, BTreeSet}, future::Future, path::PathBuf, sync::{Arc, Mutex, Weak, atomic::{AtomicBool, Ordering}}, time::Duration};
use tokio::sync::{Mutex as AsyncMutex, oneshot, watch};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use state::{RequestKey, Shared, index};
type Completion = SharedFuture<BoxFuture<'static, Result<()>>>;
struct Languages { system: ResolvedLanguage, preference: Language }
impl Languages { fn resolved(&self) -> ResolvedLanguage { match self.preference { Language::System => self.system, Language::Chinese => ResolvedLanguage::Chinese, Language::En => ResolvedLanguage::English } } }

pub struct MonitorOptions {
    pub io: BoundedIo, pub worker: PathBuf, pub agent_paths: AgentPaths, pub schedule_paths: SchedulePaths, pub event_paths: EventPaths,
    pub native: Arc<dyn NotificationAdapter>, pub language: ResolvedLanguage, pub notification_changed: Arc<dyn Fn(NotificationState) + Send + Sync>,
}
pub struct Monitor {
    shared: Arc<Shared>, registry: Arc<Registry>, events: EventService, definitions: [PluginDefinition; 3], language: Mutex<Languages>,
    initialized: AtomicBool, started: AtomicBool, admission: Mutex<bool>, tasks: TaskTracker,
    flights: Mutex<BTreeMap<RequestKey, Completion>>, stopping: Mutex<Option<Completion>>, abandoned: Mutex<Vec<Error>>,
    notification_preferences: Mutex<NotificationSettings>,
}
impl Monitor {
    pub fn new(options: MonitorOptions) -> Result<Arc<Self>> {
        if !options.worker.is_absolute() { return Err(Error::invalid("monitor worker path")); }
        let uid = options.schedule_paths.uid;
        let shared = Shared::new(vec![format!("launchctl:gui/{uid}"), format!("launchctl:user/{uid}"), "launchctl:system".into()]);
        let observer = Arc::downgrade(&shared);
        let registry = Registry::new(options.io.clone(), Arc::new(move |event| { if let Some(shared) = observer.upgrade() { shared.observe(event); } }));
        let names = Arc::downgrade(&shared); let worker = DataWorker::new(options.io.clone(), options.worker);
        let events = EventService::new(options.io.clone(), worker.clone(), options.event_paths, options.native, options.language,
            EventCallbacks { notification_changed: options.notification_changed, task_name: Arc::new(move |target| names.upgrade().and_then(|shared| shared.task_name(target))) })?;
        let definitions = builtins::definitions(options.io, worker, options.agent_paths, options.schedule_paths, events.clone(), &shared)?;
        Ok(Arc::new(Self { shared, registry, events, definitions, language: Mutex::new(Languages { system: options.language, preference: Language::System }),
            initialized: AtomicBool::new(false), started: AtomicBool::new(false), admission: Mutex::new(true), tasks: TaskTracker::new(),
            flights: Mutex::new(BTreeMap::new()), stopping: Mutex::new(None), abandoned: Mutex::new(Vec::new()), notification_preferences: Mutex::new(NotificationSettings::default()) }))
    }
    pub fn registry(&self) -> Arc<Registry> { self.registry.clone() }
    pub fn snapshot(&self) -> MonitorSnapshot { self.shared.state.lock().expect("monitor state poisoned").snapshot.clone() }
    pub fn enabled(&self, section: MonitorSection) -> bool { self.shared.state.lock().expect("monitor state poisoned").enabled.get(section) }
    pub fn updates(&self, section: MonitorSection) -> watch::Receiver<MonitorUpdate> { self.shared.streams[index(section)].updates.subscribe() }
    pub fn sources(&self, section: MonitorSection) -> watch::Receiver<Option<SourceHeartbeat>> { self.shared.streams[index(section)].sources.subscribe() }
    pub fn events(&self) -> EventService { self.events.clone() }
    pub fn set_system_language(&self, system: ResolvedLanguage) {
        let mut language = self.language.lock().expect("monitor language poisoned"); language.system = system; self.events.set_language(language.resolved());
    }
    fn open(&self) -> Result<()> { if self.shared.closed.load(Ordering::Acquire) { Err(Error::cancelled()) } else { Ok(()) } }
    fn ready(&self) -> Result<()> { self.open()?; if self.started.load(Ordering::Acquire) { Ok(()) } else { Err(Error::new("OC_MONITOR_NOT_STARTED", "Monitor is not ready")) } }
    async fn supervise<T: Send + 'static>(self: &Arc<Self>, work: impl Future<Output = Result<T>> + Send + 'static) -> Result<T> {
        let receive = {
            let admission = self.admission.lock().expect("monitor admission poisoned"); if !*admission { return Err(Error::cancelled()); }
            let (send, receive) = oneshot::channel(); let this = self.clone();
            self.tasks.spawn(async move { if let Err(Err(error)) = send.send(work.await) { if !error.is_cancelled() { let mut errors = this.abandoned.lock().expect("monitor error log poisoned"); if errors.len() < 16 { errors.push(error); } } } });
            receive
        };
        receive.await.map_err(|_| Error::cleanup("monitor operation", Error::new("OC_MONITOR_TASK", "Monitor operation exited unexpectedly")))?
    }
    pub async fn start(self: &Arc<Self>, settings: &AppSettings) -> Result<()> {
        settings.validate()?; let settings = settings.clone(); let this = self.clone();
        self.supervise(async move {
            let coordination = this.registry.coordination(); let _guard = coordination.lock().await; this.open()?;
            if !this.initialized.load(Ordering::Acquire) {
                let mut registered = Vec::new();
                for definition in &this.definitions {
                    if let Err(error) = this.registry.register_locked(definition.clone(), false).await {
                        let mut errors = vec![error]; for id in registered.into_iter().rev() { if let Err(cleanup) = this.registry.unregister_locked(id).await { errors.push(Error::cleanup("monitor initialization", cleanup)); } }
                        return Err(Error::aggregate(errors));
                    }
                    registered.push(definition.id.as_str());
                }
                this.initialized.store(true, Ordering::Release);
            }
            this.apply_locked(settings).await?; this.open()?; this.started.store(true, Ordering::Release); Ok(())
        }).await
    }
    pub async fn apply_settings(self: &Arc<Self>, settings: AppSettings) -> Result<()> {
        settings.validate()?; let this = self.clone();
        self.supervise(async move {
            let coordination = this.registry.coordination(); let _guard = coordination.lock().await; this.open()?;
            if !this.initialized.load(Ordering::Acquire) { return Err(Error::new("OC_MONITOR_NOT_STARTED", "Monitor settings require initialization")); }
            this.apply_locked(settings).await
        }).await
    }
    async fn apply_locked(self: &Arc<Self>, settings: AppSettings) -> Result<()> {
        self.open()?;
        // Market reads this preference only while holding the same coordination
        // lock. A failed application is deliberately visible to SettingsStore,
        // which re-applies the prior complete settings to perform rollback.
        self.shared.state.lock().expect("monitor state poisoned").enabled = settings.plugins.clone();
        let statuses = self.registry.statuses();
        for section in MonitorSection::ALL.into_iter().rev() {
            if !settings.plugins.get(section) { for status in statuses.iter().filter(|status| status.section == section && (status.enabled || status.phase != PluginPhase::Disabled)) { self.open()?; self.registry.set_enabled_locked(&status.id, false).await?; } }
        }
        { let mut language = self.language.lock().expect("monitor language poisoned"); language.preference = settings.language; self.events.set_language(language.resolved()); }
        let preferences_changed = {
            let mut previous = self.notification_preferences.lock().expect("monitor notification preferences poisoned");
            if *previous == settings.notifications { false } else { *previous = settings.notifications.clone(); true }
        };
        if preferences_changed { self.events.update_notification_preferences(settings.notifications).await?; }
        let statuses = self.registry.statuses();
        for section in MonitorSection::ALL {
            if settings.plugins.get(section) { for status in statuses.iter().filter(|status| status.section == section && !status.enabled) { self.open()?; self.registry.set_enabled_locked(&status.id, true).await?; } }
        }
        self.open()
    }
    pub async fn stop(self: &Arc<Self>) -> Result<()> {
        let completion = {
            let mut stopping = self.stopping.lock().expect("monitor stop poisoned");
            if let Some(completion) = stopping.as_ref() { completion.clone() } else {
                { let mut admission = self.admission.lock().expect("monitor admission poisoned"); *admission = false; self.shared.closed.store(true, Ordering::Release); self.tasks.close(); }
                let (send, receive) = oneshot::channel();
                let completion = async move { receive.await.map_err(|_| Error::cleanup("monitor shutdown", Error::new("OC_MONITOR_TASK", "Monitor shutdown exited unexpectedly")))? }.boxed().shared();
                *stopping = Some(completion.clone()); let this = self.clone();
                // The shutdown supervisor is outside the tracker it drains.
                tokio::spawn(async move {
                    let mut errors = Vec::new();
                    let (registry, events) = tokio::join!(this.registry.close(), this.events.quit());
                    if let Err(error) = registry { errors.push(error); }
                    if let Err(error) = events { errors.push(error); }
                    this.tasks.wait().await;
                    errors.extend(std::mem::take(&mut *this.abandoned.lock().expect("monitor error log poisoned")));
                    this.shared.agent.lock().expect("agent instance poisoned").take();
                    let result = if errors.is_empty() { Ok(()) } else { Err(Error::aggregate(errors)) }; let _completed = send.send(result);
                }); completion
            }
        };
        completion.await
    }
    async fn request(self: &Arc<Self>, key: RequestKey) -> Result<()> {
        self.ready()?;
        let completion = {
            let admission = self.admission.lock().expect("monitor admission poisoned"); if !*admission { return Err(Error::cancelled()); }
            let mut flights = self.flights.lock().expect("monitor requests poisoned");
            if let Some(completion) = flights.get(&key) { completion.clone() } else {
                let id = self.shared.begin(&key)?; let (send, receive) = oneshot::channel();
                let completion = async move { receive.await.map_err(|_| Error::cleanup("monitor refresh", Error::new("OC_MONITOR_TASK", "Monitor refresh exited unexpectedly")))? }.boxed().shared();
                flights.insert(key.clone(), completion.clone()); let this = self.clone();
                self.tasks.spawn(async move {
                    let result = this.registry.collect(&id, key.source.clone()).await;
                    this.shared.finish(&key, &result); this.flights.lock().expect("monitor requests poisoned").remove(&key); let _completed = send.send(result);
                }); completion
            }
        };
        completion.await
    }
    pub async fn refresh(self: &Arc<Self>, section: Option<MonitorSection>) -> Result<()> {
        self.ready()?;
        if let Some(section) = section { return self.request(RequestKey { section, source: None }).await; }
        let sections: Vec<_> = { let state = self.shared.state.lock().expect("monitor state poisoned"); MonitorSection::ALL.into_iter().filter(|section| state.owners[index(*section)].as_ref().is_some_and(|owner| owner.enabled)).collect() };
        let errors: Vec<_> = futures_util::future::join_all(sections.into_iter().map(|section| self.request(RequestKey { section, source: None }))).await.into_iter().filter_map(Result::err).collect();
        if errors.is_empty() { Ok(()) } else { Err(Error::aggregate(errors)) }
    }
    pub async fn retry_source(self: &Arc<Self>, source_id: &str) -> Result<()> {
        self.ready()?; validate_text(source_id, MAX_SOURCE_ID_LENGTH, 512, "source id")?; self.request(self.shared.retry(source_id)?).await
    }
    pub async fn process_identity(&self, agent_id: &str) -> Result<ProcessIdentity> {
        self.ready()?; validate_text(agent_id, MAX_AGENT_ID_LENGTH, 2048, "agent id")?;
        let generation = {
            let state = self.shared.state.lock().expect("monitor state poisoned");
            let owner = state.owners[index(MonitorSection::Agents)].as_ref().filter(|owner| owner.enabled).ok_or_else(|| Error::new("OC_PLUGIN_DISABLED", "Agent collection is disabled"))?;
            if !state.snapshot.agents.data.as_ref().is_some_and(|data| data.agents.iter().any(|agent| agent.id == agent_id)) { return Err(Error::new("OC_AGENT_IDENTITY", "Agent is absent from the current snapshot")); } owner.generation
        };
        let collector = self.shared.agent.lock().expect("agent instance poisoned").as_ref().filter(|(current,_)| *current == generation).and_then(|(_,collector)| collector.upgrade()).ok_or_else(|| Error::new("OC_AGENT_IDENTITY", "Agent lifecycle is no longer current"))?;
        collector.process_identity(agent_id).await
    }
    pub async fn history(self: &Arc<Self>, job_id: &str, offset: usize, cancel: CancellationToken) -> Result<ScheduleHistory> {
        self.ready()?; check_cancel(&cancel)?; validate_text(job_id, MAX_SCHEDULE_ID_LENGTH, 1024, "schedule job id")?;
        if offset > MAX_HISTORY_OFFSET || offset % HISTORY_PAGE_SIZE != 0 { return Err(Error::invalid("history offset")); }
        let (id, job) = {
            let state = self.shared.state.lock().expect("monitor state poisoned"); let owner = state.owners[index(MonitorSection::Schedules)].as_ref().filter(|owner| owner.enabled).ok_or_else(|| Error::new("OC_PLUGIN_DISABLED", "Schedule collection is disabled"))?;
            let job = state.snapshot.schedules.data.as_ref().and_then(|data| data.jobs.iter().find(|job| job.id == job_id)).cloned().ok_or_else(|| Error::new("ENOENT", "Unknown scheduled job"))?; (owner.id.clone(), job)
        };
        let result = self.registry.history(&id, job.clone(), offset, cancel).await?; self.shared.require_job(&job)?; self.open()?; Ok(result)
    }
    pub async fn query_events(self: &Arc<Self>, query: EventQuery, cancel: CancellationToken) -> Result<EventPage> {
        self.ready()?; check_cancel(&cancel)?; query.validate()?;
        let id = { let state = self.shared.state.lock().expect("monitor state poisoned"); state.owners[index(MonitorSection::Events)].as_ref().filter(|owner| owner.enabled).ok_or_else(|| Error::new("OC_EVENTS_DISABLED", "Local events are disabled"))?.id.clone() };
        self.registry.events(&id, query, cancel).await
    }
}
