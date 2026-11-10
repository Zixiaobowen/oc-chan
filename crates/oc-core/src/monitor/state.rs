use super::*;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct RequestKey { pub section: MonitorSection, pub source: Option<String> }
pub(super) struct Streams { pub updates: watch::Sender<MonitorUpdate>, pub sources: watch::Sender<Option<SourceHeartbeat>> }
pub(super) struct State {
    pub snapshot: MonitorSnapshot, pub owners: [Option<PluginStatus>; 4], pub enabled: PluginSettings,
    collection_errors: [Option<String>; 4], pending: BTreeSet<RequestKey>,
}
pub(super) struct Shared {
    pub state: Mutex<State>, pub streams: [Streams; 4], pub closed: AtomicBool,
    pub agent: Mutex<Option<(u64, Weak<AgentCollector>)>>, pub retry_sources: Vec<String>,
}
pub(super) fn index(section: MonitorSection) -> usize { match section { MonitorSection::Agents => 0, MonitorSection::Schedules => 1, MonitorSection::System => 2, MonitorSection::Events => 3 } }
impl Shared {
    pub fn new(retry_sources: Vec<String>) -> Arc<Self> {
        Arc::new(Self { state: Mutex::new(State { snapshot: MonitorSnapshot::default(), owners: std::array::from_fn(|_| None), enabled: PluginSettings::default(), collection_errors: std::array::from_fn(|_| None), pending: BTreeSet::new() }),
            streams: std::array::from_fn(|i| Streams { updates: watch::channel(match i { 0 => MonitorUpdate::Agents(CollectorState::default()), 1 => MonitorUpdate::Schedules(CollectorState::default()), 2 => MonitorUpdate::System(CollectorState::default()), _ => MonitorUpdate::Events(CollectorState::default()) }).0, sources: watch::channel(None).0 }),
            closed: AtomicBool::new(false), agent: Mutex::new(None), retry_sources })
    }
    pub fn observe(&self, event: RegistryEvent) {
        if self.closed.load(Ordering::Acquire) { return; }
        let mut state = self.state.lock().expect("monitor state poisoned");
        if self.closed.load(Ordering::Acquire) { return; }
        match event {
            RegistryEvent::State(status) => {
                let section = status.section; let slot = index(section);
                if state.owners[slot].as_ref().is_some_and(|owner| owner.id != status.id) { return; }
                let disabled = !status.enabled; let clear = status.phase == PluginPhase::Disabled;
                state.owners[slot] = Some(status);
                if disabled {
                    if clear { state.collection_errors[slot] = None; }
                    match section {
                        MonitorSection::Agents => self.disable(section, &mut state.snapshot.agents, clear),
                        MonitorSection::Schedules => self.disable(section, &mut state.snapshot.schedules, clear),
                        MonitorSection::System => self.disable(section, &mut state.snapshot.system, clear),
                        MonitorSection::Events => self.disable(section, &mut state.snapshot.events, clear),
                    }
                }
            }
            RegistryEvent::Snapshot(publication) => {
                let section = publication.section; let slot = index(section);
                if !state.owners[slot].as_ref().is_some_and(|owner| owner.id == publication.id && owner.generation == publication.generation && owner.enabled) { return; }
                if !publication.incremental && publication.source_id.is_none() { state.collection_errors[slot] = None; }
                let error = state.collection_errors[slot].clone();
                let refreshing = state.pending.iter().any(|key| key.section == section && key.source != publication.source_id);
                let source = publication.source_id.as_deref(); let incremental = publication.incremental;
                match publication.snapshot {
                    SnapshotData::Agents(data) => self.data(section, &mut state.snapshot.agents, data, error, refreshing, source, incremental),
                    SnapshotData::Schedules(data) => self.data(section, &mut state.snapshot.schedules, data, error, refreshing, source, incremental),
                    SnapshotData::System(data) => self.data(section, &mut state.snapshot.system, data, error, refreshing, source, incremental),
                    SnapshotData::Events(data) => self.data(section, &mut state.snapshot.events, data, error, refreshing, source, incremental),
                }
            }
            RegistryEvent::Error { id, section, source_id, error } => {
                let slot = index(section);
                let Some(owner) = state.owners[slot].as_ref().filter(|owner| owner.id == id) else { return; };
                let attempted = source_id.is_none() && owner.enabled;
                let message = error.to_string(); if source_id.is_none() { state.collection_errors[slot] = Some(message.clone()); }
                match section {
                    MonitorSection::Agents => self.error(section, &mut state.snapshot.agents, message, attempted),
                    MonitorSection::Schedules => self.error(section, &mut state.snapshot.schedules, message, attempted),
                    MonitorSection::System => self.error(section, &mut state.snapshot.system, message, attempted),
                    MonitorSection::Events => self.error(section, &mut state.snapshot.events, message, attempted),
                }
            }
            RegistryEvent::Removed { id, section } => {
                let slot = index(section); if !state.owners[slot].as_ref().is_some_and(|owner| owner.id == id) { return; }
                state.owners[slot] = None; state.collection_errors[slot] = None; state.pending.retain(|key| key.section != section);
                let update = match section {
                    MonitorSection::Agents => { state.snapshot.agents = CollectorState::default(); MonitorUpdate::Agents(state.snapshot.agents.clone()) },
                    MonitorSection::Schedules => { state.snapshot.schedules = CollectorState::default(); MonitorUpdate::Schedules(state.snapshot.schedules.clone()) },
                    MonitorSection::System => { state.snapshot.system = CollectorState::default(); MonitorUpdate::System(state.snapshot.system.clone()) },
                    MonitorSection::Events => { state.snapshot.events = CollectorState::default(); MonitorUpdate::Events(state.snapshot.events.clone()) },
                };
                self.streams[slot].sources.send_replace(None); self.streams[slot].updates.send_replace(update);
            }
        }
    }
    fn data<T: Snapshot>(&self, section: MonitorSection, state: &mut CollectorState<T>, mut data: T, error: Option<String>, refreshing: bool, observed: Option<&str>, incremental: bool) {
        let sampled = !incremental; let collected = data.collected_at().to_owned();
        for (position, source) in data.sources_mut().iter_mut().enumerate() {
            let previous = state.data.as_ref().and_then(|data| data.sources().get(position).filter(|old| old.id == source.id).or_else(|| data.sources().iter().find(|old| old.id == source.id)));
            let attempted = sampled && !matches!(source.state, SourceState::Disabled | SourceState::Unsupported) && observed.is_none_or(|id| id == source.id);
            if source.last_attempt_at.is_none() { source.last_attempt_at = if attempted { Some(collected.clone()) } else { previous.and_then(|old| old.last_attempt_at.clone()) }; }
            if source.last_success_at.is_none() { source.last_success_at = if attempted && matches!(source.state, SourceState::Ok | SourceState::Empty) { Some(collected.clone()) } else { previous.and_then(|old| old.last_success_at.clone()) }; }
            source.retry = if matches!(source.state, SourceState::Disabled | SourceState::Unsupported) { None }
                else if section == MonitorSection::Schedules && self.retry_sources.contains(&source.id) { Some(SourceRetry::Source) }
                else if source.state == SourceState::Error { Some(SourceRetry::Section) } else { None };
        }
        let error = if incremental { state.error.clone() } else { error };
        let refreshing = if incremental { state.refreshing } else { refreshing };
        let last_attempt = if sampled && observed.is_none() { Some(collected.clone()) } else { state.last_attempt_at.clone() };
        let last_success = if sampled && observed.is_none() && error.is_none() { Some(collected) } else { state.last_success_at.clone() };
        let changed = state.error != error || state.refreshing != refreshing || state.data.as_ref().is_none_or(|old| !old.same_content(&data) || !same_sources(old.sources(), data.sources()));
        let heartbeat = state.last_attempt_at != last_attempt || state.last_success_at != last_success || state.data.as_ref().is_some_and(|old| !same_observations(old.sources(), data.sources()));
        state.data = Some(data); state.error = error; state.refreshing = refreshing; state.last_attempt_at = last_attempt; state.last_success_at = last_success;
        self.emit(section, state, changed, heartbeat);
    }
    fn emit<T: Snapshot>(&self, section: MonitorSection, state: &CollectorState<T>, changed: bool, heartbeat: bool) {
        let stream = &self.streams[index(section)];
        if changed { stream.sources.send_replace(None); stream.updates.send_replace(T::update(state.clone())); }
        else if heartbeat { stream.sources.send_replace(Some(SourceHeartbeat { section, last_attempt_at: state.last_attempt_at.clone(), last_success_at: state.last_success_at.clone(), sources: state.data.as_ref().map_or_else(Vec::new, |data| data.sources().iter().map(SourceStatus::observation).collect()) })); }
    }
    fn disable<T: Snapshot>(&self, section: MonitorSection, state: &mut CollectorState<T>, clear: bool) {
        let mut changed = state.refreshing || (clear && state.error.is_some()); state.refreshing = false; if clear { state.error = None; }
        if let Some(data) = &mut state.data { for source in data.sources_mut() { changed |= source.state != SourceState::Disabled || source.retry.is_some(); source.state = SourceState::Disabled; source.retry = None; } }
        self.emit(section, state, changed, false);
    }
    fn error<T: Snapshot>(&self, section: MonitorSection, state: &mut CollectorState<T>, message: String, attempted: bool) {
        let changed = state.error.as_ref() != Some(&message) || state.refreshing; state.error = Some(message); state.refreshing = false;
        if attempted { state.last_attempt_at = Some(timestamp()); }
        self.emit(section, state, changed, attempted);
    }
    pub fn begin(&self, key: &RequestKey) -> Result<String> {
        let mut state = self.state.lock().expect("monitor state poisoned"); let owner = state.owners[index(key.section)].as_ref().ok_or_else(|| Error::new("OC_PLUGIN_UNKNOWN", "Collection section has no installed plugin"))?;
        if !owner.enabled { return Err(Error::new("OC_PLUGIN_DISABLED", "Collection section is disabled")); } let id = owner.id.clone();
        let prior_retry = state.pending.iter().any(|pending| pending.section == key.section && pending.source.is_some()); state.pending.insert(key.clone());
        let attempted = key.source.is_some() || !prior_retry;
        match key.section {
            MonitorSection::Agents => self.busy(key.section, &mut state.snapshot.agents, true, attempted),
            MonitorSection::Schedules => self.busy(key.section, &mut state.snapshot.schedules, true, attempted),
            MonitorSection::System => self.busy(key.section, &mut state.snapshot.system, true, attempted),
            MonitorSection::Events => self.busy(key.section, &mut state.snapshot.events, true, attempted),
        }
        Ok(id)
    }
    pub fn finish(&self, key: &RequestKey, result: &Result<()>) {
        if self.closed.load(Ordering::Acquire) { return; }
        let mut state = self.state.lock().expect("monitor state poisoned"); state.pending.remove(key);
        let enabled = state.owners[index(key.section)].as_ref().is_some_and(|owner| owner.enabled);
        let busy = enabled && state.pending.iter().any(|pending| pending.section == key.section);
        let error = result.as_ref().err().filter(|error| !error.is_cancelled()).filter(|_| enabled);
        macro_rules! finish { ($field:ident) => {{ let collector = &mut state.snapshot.$field; if collector.error.is_none() { if let Some(error) = error { self.error(key.section, collector, error.to_string(), false); } } self.busy(key.section, collector, busy, false); }}; }
        match key.section { MonitorSection::Agents => finish!(agents), MonitorSection::Schedules => finish!(schedules), MonitorSection::System => finish!(system), MonitorSection::Events => finish!(events) }
    }
    fn busy<T: Snapshot>(&self, section: MonitorSection, state: &mut CollectorState<T>, busy: bool, attempted: bool) {
        let changed = state.refreshing != busy; state.refreshing = busy; if attempted { state.last_attempt_at = Some(timestamp()); } self.emit(section, state, changed, attempted);
    }
    pub fn retry(&self, source: &str) -> Result<RequestKey> {
        let state = self.state.lock().expect("monitor state poisoned");
        if self.retry_sources.iter().any(|id| id == source) { return Ok(RequestKey { section: MonitorSection::Schedules, source: Some(source.to_owned()) }); }
        for section in MonitorSection::ALL {
            let sources = match section { MonitorSection::Agents => state.snapshot.agents.data.as_ref().map(|data| data.sources.as_slice()), MonitorSection::Schedules => state.snapshot.schedules.data.as_ref().map(|data| data.sources.as_slice()), MonitorSection::System => state.snapshot.system.data.as_ref().map(|data| data.sources.as_slice()), MonitorSection::Events => state.snapshot.events.data.as_ref().map(|data| data.sources.as_slice()) };
            if sources.is_some_and(|sources| sources.iter().any(|item| item.id == source && item.retry == Some(SourceRetry::Section))) { return Ok(RequestKey { section, source: None }); }
        }
        Err(Error::new("OC_PLUGIN_CAPABILITY", "Source does not support retry"))
    }
    pub fn require_job(&self, job: &ScheduledJob) -> Result<()> {
        let state = self.state.lock().expect("monitor state poisoned");
        if state.snapshot.schedules.data.as_ref().is_some_and(|data| data.jobs.iter().any(|current| current.id == job.id && current.source == job.source && current.scope == job.scope && current.file == job.file && current.executable == job.executable)) { Ok(()) }
        else { Err(Error::new("OC_SCHEDULE_IDENTITY", "Scheduled job identity changed")) }
    }
    pub fn task_name(&self, target: &NavigationTarget) -> Option<String> {
        let state = self.state.lock().expect("monitor state poisoned");
        match target {
            NavigationTarget::Agent { id, .. } => state.snapshot.agents.data.as_ref()?.agents.iter().find(|agent| &agent.id == id && NavigationTarget::agent(agent) == *target).map(|agent| agent.name.clone()),
            NavigationTarget::Schedule { id, .. } => state.snapshot.schedules.data.as_ref()?.jobs.iter().find(|job| &job.id == id && NavigationTarget::schedule(job) == *target).map(|job| job.name.clone()),
            _ => None,
        }
    }
}
fn same_observations(a: &[SourceStatus], b: &[SourceStatus]) -> bool { a.len() == b.len() && a.iter().zip(b).all(|(a,b)| a.id == b.id && a.last_attempt_at == b.last_attempt_at && a.last_success_at == b.last_success_at) }
fn same_sources(a: &[SourceStatus], b: &[SourceStatus]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(a,b)| a.id == b.id && a.label == b.label && a.state == b.state && a.detail == b.detail && a.retry == b.retry && a.resources == b.resources && match (&a.diagnostics, &b.diagnostics) {
        (None,None) => true, (Some(a),Some(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a,b)| a.source_id == b.source_id && a.operation == b.operation && a.stage == b.stage && a.code == b.code && a.retryable == b.retryable && a.exit_code == b.exit_code), _ => false,
    })
}
trait Snapshot: Clone {
    fn collected_at(&self) -> &str; fn sources(&self) -> &[SourceStatus]; fn sources_mut(&mut self) -> &mut [SourceStatus]; fn same_content(&self, other: &Self) -> bool;
    fn update(state: CollectorState<Self>) -> MonitorUpdate;
}
macro_rules! shape { ($kind:ident, $variant:ident, $left:ident, $right:ident, $body:expr) => { impl Snapshot for $kind {
    fn collected_at(&self) -> &str { &self.collected_at } fn sources(&self) -> &[SourceStatus] { &self.sources } fn sources_mut(&mut self) -> &mut [SourceStatus] { &mut self.sources }
    fn same_content(&self, other: &Self) -> bool { let $left = self; let $right = other; $body }
    fn update(state: CollectorState<Self>) -> MonitorUpdate { MonitorUpdate::$variant(state) }
} }; }
shape!(AgentSnapshot, Agents, a, b, a.agents == b.agents && a.active_subagent_count == b.active_subagent_count);
shape!(ScheduleSnapshot, Schedules, a, b, a.jobs == b.jobs);
shape!(EventSnapshot, Events, a, b, a.revision == b.revision && a.retention == b.retention && a.coverage == b.coverage);
shape!(SystemSnapshot, System, a, b,
    a.hostname == b.hostname && a.platform == b.platform && a.os_version == b.os_version && a.cpu_model == b.cpu_model && a.cpu_cores == b.cpu_cores && a.uptime_seconds == b.uptime_seconds && a.cpu_percent == b.cpu_percent
    && a.memory_total == b.memory_total && a.memory_used == b.memory_used && a.memory_available == b.memory_available && a.memory_app == b.memory_app && a.memory_wired == b.memory_wired && a.memory_compressed == b.memory_compressed && a.swap_used == b.swap_used
    && a.disk_total == b.disk_total && a.disk_used == b.disk_used && a.disk_available == b.disk_available && a.rx_bytes_per_second == b.rx_bytes_per_second && a.tx_bytes_per_second == b.tx_bytes_per_second && a.network_interface == b.network_interface
    && a.processes == b.processes && a.memory_processes == b.memory_processes && a.history == b.history);
