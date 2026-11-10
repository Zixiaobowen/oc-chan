use super::*;
use crate::{events::{NativeDelivery, NativeDrain, NativeRemoval, NotificationMessage}, model::{SourceDiagnosticOperation, SourceDiagnosticStage, SourceDiagnosticCode}, settings::NotificationPermission};
use std::{os::unix::fs::PermissionsExt, sync::atomic::AtomicUsize};
use tokio::sync::Notify;

const T1: &str = "2026-11-10T10:00:00.000Z";
const T2: &str = "2026-11-10T10:00:02.000Z";
fn agents(at: &str) -> AgentSnapshot { AgentSnapshot { collected_at: at.into(), agents: Vec::new(), active_subagent_count: Some(0), sources: vec![SourceStatus::new("ps", "Processes", SourceState::Ok, "observed")] } }
fn owner(shared: &Shared, section: MonitorSection, generation: u64) { shared.observe(RegistryEvent::State(PluginStatus { id: section.as_str().into(), section, enabled: true, phase: PluginPhase::Running, generation, error: None })); }
fn publish(shared: &Shared, snapshot: SnapshotData, generation: u64, incremental: bool, source: Option<&str>) {
    let section = snapshot.section(); shared.observe(RegistryEvent::Snapshot(crate::plugins::Publication { id: section.as_str().into(), section, generation, snapshot, source_id: source.map(str::to_owned), incremental }));
}
#[test]
fn unchanged_content_uses_only_its_source_heartbeat_slot() {
    let shared = Shared::new(Vec::new()); owner(&shared, MonitorSection::Agents, 1);
    let mut agents_updates = shared.streams[0].updates.subscribe(); let mut agent_sources = shared.streams[0].sources.subscribe(); let schedule_updates = shared.streams[1].updates.subscribe();
    publish(&shared, SnapshotData::Agents(agents(T1)), 1, false, None);
    assert!(agents_updates.has_changed().unwrap()); agents_updates.borrow_and_update(); agent_sources.borrow_and_update();
    publish(&shared, SnapshotData::Agents(agents(T2)), 1, false, None);
    assert!(!agents_updates.has_changed().unwrap()); assert!(agent_sources.has_changed().unwrap()); assert!(!schedule_updates.has_changed().unwrap());
    let heartbeat = agent_sources.borrow_and_update().clone().unwrap(); assert_eq!(heartbeat.last_attempt_at.as_deref(), Some(T2)); assert_eq!(heartbeat.sources[0].last_success_at.as_deref(), Some(T2));
    let snapshot = shared.state.lock().unwrap().snapshot.clone(); assert_eq!(snapshot.agents.data.unwrap().collected_at, T2);
}
#[test]
fn incremental_updates_and_source_retries_preserve_collection_error() {
    let shared = Shared::new(vec!["launchctl:system".into()]); owner(&shared, MonitorSection::Agents, 1); owner(&shared, MonitorSection::Schedules, 2);
    publish(&shared, SnapshotData::Agents(agents(T1)), 1, false, None);
    shared.observe(RegistryEvent::Error { id: "agents".into(), section: MonitorSection::Agents, source_id: None, error: Error::new("DISCOVERY_FAILED", "discovery failed") });
    let error = shared.state.lock().unwrap().snapshot.agents.error.clone();
    let mut incremental = agents(T2); incremental.active_subagent_count = Some(1); publish(&shared, SnapshotData::Agents(incremental), 1, true, None);
    assert_eq!(shared.state.lock().unwrap().snapshot.agents.error, error);
    let schedule = |at: &str| ScheduleSnapshot { collected_at: at.into(), jobs: Vec::new(), sources: vec![SourceStatus::new("launchctl:system", "System launchd", SourceState::Ok, "observed")] };
    publish(&shared, SnapshotData::Schedules(schedule(T1)), 2, false, None);
    shared.observe(RegistryEvent::Error { id: "schedules".into(), section: MonitorSection::Schedules, source_id: None, error: Error::new("SCHEDULE_FAILED", "scan failed") });
    publish(&shared, SnapshotData::Schedules(schedule(T2)), 2, false, Some("launchctl:system"));
    let snapshot = shared.state.lock().unwrap().snapshot.clone(); assert!(snapshot.schedules.error.unwrap().contains("SCHEDULE_FAILED"));
    assert_eq!(snapshot.schedules.data.unwrap().sources[0].retry, Some(SourceRetry::Source));
    publish(&shared, SnapshotData::Schedules(schedule(T2)), 2, false, None); assert!(shared.state.lock().unwrap().snapshot.schedules.error.is_none());
}
#[test]
fn disable_retains_data_removal_clears_it_and_old_generations_cannot_publish() {
    let shared = Shared::new(Vec::new()); owner(&shared, MonitorSection::Agents, 1); publish(&shared, SnapshotData::Agents(agents(T1)), 1, false, None);
    shared.observe(RegistryEvent::State(PluginStatus { id: "agents".into(), section: MonitorSection::Agents, enabled: false, phase: PluginPhase::Disabled, generation: 1, error: None }));
    let snapshot = shared.state.lock().unwrap().snapshot.clone(); assert!(snapshot.agents.data.is_some()); assert_eq!(snapshot.agents.data.unwrap().sources[0].state, SourceState::Disabled);
    owner(&shared, MonitorSection::Agents, 2); publish(&shared, SnapshotData::Agents(agents(T2)), 1, false, None);
    assert_eq!(shared.state.lock().unwrap().snapshot.agents.data.as_ref().unwrap().collected_at, T1);
    shared.observe(RegistryEvent::Removed { id: "agents".into(), section: MonitorSection::Agents }); assert!(shared.state.lock().unwrap().snapshot.agents.data.is_none());
}
#[test]
fn same_business_source_diagnostics_ignore_observation_time_but_not_error_code() {
    let shared = Shared::new(Vec::new()); owner(&shared, MonitorSection::Agents, 1); let mut updates = shared.streams[0].updates.subscribe();
    let mut first = agents(T1); first.sources[0].diagnostics = Some(vec![SourceDiagnostic { source_id: "ps".into(), operation: SourceDiagnosticOperation::Services, stage: SourceDiagnosticStage::Command, code: SourceDiagnosticCode::CommandFailed, retryable: true, observed_at: T1.into(), exit_code: None }]);
    publish(&shared, SnapshotData::Agents(first.clone()), 1, false, None); updates.borrow_and_update();
    first.collected_at = T2.into(); first.sources[0].diagnostics.as_mut().unwrap()[0].observed_at = T2.into();
    publish(&shared, SnapshotData::Agents(first.clone()), 1, false, None); assert!(!updates.has_changed().unwrap());
    first.sources[0].diagnostics.as_mut().unwrap()[0].code = SourceDiagnosticCode::CommandMissing; publish(&shared, SnapshotData::Agents(first), 1, false, None); assert!(updates.has_changed().unwrap());
}
struct ForbiddenNative;
impl NotificationAdapter for ForbiddenNative {
    fn permission<'a>(&'a self, _: bool, _: &'a CancellationToken) -> BoxFuture<'a, Result<NotificationPermission>> { Box::pin(async { Err(Error::new("TEST_NATIVE", "Native permission must not be requested")) }) }
    fn submit<'a>(&'a self, _: NotificationMessage, _: &'a CancellationToken) -> BoxFuture<'a, Result<NativeDelivery>> { Box::pin(async { Err(Error::new("TEST_NATIVE", "Native submission must not occur")) }) }
    fn settle<'a>(&'a self, _: &'a str, _: &'a CancellationToken) -> BoxFuture<'a, Result<NativeDelivery>> { Box::pin(async { Err(Error::new("TEST_NATIVE", "No native delivery is pending")) }) }
    fn remove<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<NativeRemoval>> { Box::pin(async { Err(Error::new("TEST_NATIVE", "No native handle exists")) }) }
    fn drain(&self) -> BoxFuture<'_, Result<NativeDrain>> { Box::pin(async { Err(Error::new("TEST_NATIVE", "Native adapter was never used")) }) }
}
fn options(profile: &std::path::Path) -> MonitorOptions {
    MonitorOptions { io: BoundedIo::new(crate::resources::ResourceBudget::default()), worker: profile.join("oc-data-worker-not-started"), agent_paths: AgentPaths::for_home(profile.to_owned()), schedule_paths: SchedulePaths::new(profile.to_owned()),
        event_paths: EventPaths { home: profile.to_owned(), profile: profile.to_owned(), database: profile.join("events.db"), hermes_database: profile.join("hermes.db"), journal: profile.join("notifications.json") },
        native: Arc::new(ForbiddenNative), language: ResolvedLanguage::English, notification_changed: Arc::new(|_| {}) }
}
fn profile() -> tempfile::TempDir { let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap(); std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap(); directory }
fn disabled() -> AppSettings { let mut settings = AppSettings::default(); settings.plugins = PluginSettings { agents: false, schedules: false, system: false, events: false }; settings }
#[tokio::test]
async fn disabled_start_never_spawns_collectors_or_installs_system_and_close_is_terminal() {
    let profile = profile(); let monitor = Monitor::new(options(profile.path())).unwrap(); monitor.start(&disabled()).await.unwrap();
    assert_eq!(monitor.registry.statuses().len(), 3); assert!(monitor.registry.statuses().iter().all(|status| !status.enabled && status.phase == PluginPhase::Disabled));
    assert!(monitor.snapshot().system.data.is_none()); assert_eq!(monitor.events().notification_snapshot().phase, crate::settings::NotificationPhase::Off);
    assert!(monitor.history("absent", 0, CancellationToken::new()).await.is_err()); assert!(monitor.query_events(EventQuery::default(), CancellationToken::new()).await.is_err());
    monitor.stop().await.unwrap(); monitor.stop().await.unwrap(); assert!(monitor.start(&disabled()).await.is_err());
}
#[cfg(target_os="macos")]
#[tokio::test]
async fn long_empty_home_starts_with_optional_sources_and_unavailable_event_coverage() {
    let profile = profile(); let home = profile.path().join("long-home-".repeat(16)); std::fs::create_dir(&home).unwrap();
    let directory = home.join("Library/LaunchAgents"); let custom = home.join("custom-launch-agents");
    assert!(directory.to_str().unwrap().encode_utf16().count() > 128);
    assert!(std::fs::read_dir(&home).unwrap().next().is_none());
    let mut options = options(profile.path());
    options.worker = std::env::var_os("OC_DATA_WORKER_TEST_EXECUTABLE").expect("build worker and set OC_DATA_WORKER_TEST_EXECUTABLE").into();
    options.agent_paths = AgentPaths::for_home(home.clone()); options.schedule_paths = SchedulePaths::new(home.clone());
    options.schedule_paths.directories = vec![(directory.clone(),JobScope::User),(custom.clone(),JobScope::User)];
    options.event_paths.home = home.clone(); options.event_paths.hermes_database = home.join(".hermes/cron/executions.db");
    let io = options.io.clone(); let monitor = Monitor::new(options).unwrap(); let mut settings = disabled();
    settings.plugins.schedules = true; settings.plugins.events = true;
    monitor.start(&settings).await.unwrap();
    let snapshot = monitor.snapshot(); assert!(snapshot.schedules.error.is_none()); assert!(snapshot.events.error.is_none());
    let sources = &snapshot.schedules.data.as_ref().unwrap().sources;
    let missing_ids = [&directory,&custom].map(|path| {
        let source = sources.iter().find(|source| source.label == path.to_str().unwrap()).unwrap();
        assert_eq!(source.state,SourceState::Empty); assert!(source.detail.contains("ENOENT"));
        NavigationTarget::Source { id: source.id.clone(), section: MonitorSection::Schedules }.validate().unwrap();
        source.id.clone()
    });
    assert_eq!(missing_ids[0],"launchagents:user"); assert_ne!(missing_ids[0],missing_ids[1]);
    for id in ["omp-cron","hermes-cron"] { assert_eq!(sources.iter().find(|source| source.id == id).unwrap().state,SourceState::Empty); }
    let events = snapshot.events.data.as_ref().unwrap();
    assert!(events.sources.iter().any(|source| source.id == "hermes-events" && source.state == SourceState::Error));
    let unavailable = events.coverage.iter().find(|coverage| coverage.source_id == "hermes-events").unwrap();
    assert_eq!(unavailable.state,CoverageState::Unavailable); assert!(unavailable.last_gap.is_some());
    assert_eq!(events.retention.count,0);
    std::fs::create_dir_all(&directory).unwrap(); std::fs::create_dir(&custom).unwrap();
    monitor.refresh(Some(MonitorSection::Schedules)).await.unwrap(); monitor.refresh(Some(MonitorSection::Events)).await.unwrap();
    let restored = monitor.snapshot();
    for id in &missing_ids { assert_eq!(restored.schedules.data.as_ref().unwrap().sources.iter().find(|source| &source.id == id).unwrap().state,SourceState::Ok); }
    assert!(restored.events.error.is_none());
    assert_eq!(restored.events.data.as_ref().unwrap().coverage.iter().find(|coverage| coverage.source_id == "hermes-events").unwrap().state,CoverageState::Unavailable);
    monitor.stop().await.unwrap(); io.shutdown().await.unwrap();
}
struct Controlled {
    collected: AtomicUsize, stopped: AtomicUsize, entered: Notify, release: Notify, cancelled: Notify, cleanup: Notify,
}
impl Controlled { fn new() -> Arc<Self> { Arc::new(Self { collected: AtomicUsize::new(0), stopped: AtomicUsize::new(0), entered: Notify::new(), release: Notify::new(), cancelled: Notify::new(), cleanup: Notify::new() }) } }
impl CollectionPlugin for Controlled {
    fn start(&self, cancel: CancellationToken) -> BoxFuture<'_, Result<()>> { Box::pin(async move { check_cancel(&cancel) }) }
    fn collect(&self, cancel: CancellationToken, _: Option<String>) -> BoxFuture<'_, Result<Option<SnapshotData>>> {
        Box::pin(async move {
            if self.collected.fetch_add(1, Ordering::SeqCst) > 0 {
                self.entered.notify_one(); tokio::select! { _ = self.release.notified() => {}, _ = cancel.cancelled() => { self.cancelled.notify_one(); self.cleanup.notified().await; return Err(Error::cancelled()); } }
            }
            Ok(Some(SnapshotData::Agents(agents(T1))))
        })
    }
    fn stop(&self) -> BoxFuture<'_, Result<()>> { Box::pin(async { self.stopped.fetch_add(1, Ordering::SeqCst); Ok(()) }) }
}
async fn controlled(monitor: &Arc<Monitor>, plugin: Arc<Controlled>, publishers: Arc<Mutex<Vec<crate::plugins::Publisher>>>) {
    monitor.registry.unregister("agents").await.unwrap();
    monitor.registry.register(PluginDefinition { id: "agents".into(), section: MonitorSection::Agents, capabilities: Vec::new(), dependencies: Vec::new(), retry_sources: Vec::new(), interval: Duration::from_secs(60), timeout: Duration::from_secs(60), create: Arc::new(move |context| { publishers.lock().unwrap().push(context.publisher); Ok(plugin.clone()) }) }, true).await.unwrap();
}
#[tokio::test]
async fn refresh_coalesces_and_dropped_waiter_does_not_clear_the_running_operation() {
    let profile = profile(); let monitor = Monitor::new(options(profile.path())).unwrap(); monitor.start(&disabled()).await.unwrap();
    let plugin = Controlled::new(); controlled(&monitor, plugin.clone(), Arc::new(Mutex::new(Vec::new()))).await;
    let first = tokio::spawn({ let monitor = monitor.clone(); async move { monitor.refresh(Some(MonitorSection::Agents)).await } }); plugin.entered.notified().await;
    let (joined, waiting) = oneshot::channel();
    let second = tokio::spawn({ let monitor = monitor.clone(); async move { joined.send(()).unwrap(); monitor.refresh(Some(MonitorSection::Agents)).await } }); waiting.await.unwrap();
    first.abort(); assert!(monitor.snapshot().agents.refreshing); assert_eq!(plugin.collected.load(Ordering::SeqCst), 2);
    plugin.release.notify_one(); second.await.unwrap().unwrap(); assert!(!monitor.snapshot().agents.refreshing); monitor.stop().await.unwrap();
}
#[tokio::test]
async fn shutdown_waits_for_true_collection_cleanup_and_revokes_error_callbacks() {
    let profile = profile(); let monitor = Monitor::new(options(profile.path())).unwrap(); monitor.start(&disabled()).await.unwrap();
    let plugin = Controlled::new(); let publishers = Arc::new(Mutex::new(Vec::new())); controlled(&monitor, plugin.clone(), publishers.clone()).await;
    let refresh = tokio::spawn({ let monitor = monitor.clone(); async move { monitor.refresh(Some(MonitorSection::Agents)).await } }); plugin.entered.notified().await;
    let stop = tokio::spawn({ let monitor = monitor.clone(); async move { monitor.stop().await } }); plugin.cancelled.notified().await;
    assert!(!stop.is_finished()); assert_eq!(plugin.stopped.load(Ordering::SeqCst), 0);
    let publisher = publishers.lock().unwrap()[0].clone(); assert!(!publisher.publish(SnapshotData::Agents(agents(T2)), None, true).unwrap()); publisher.report_error(Error::new("STALE", "stale error"));
    plugin.cleanup.notify_one(); assert!(refresh.await.unwrap().unwrap_err().is_cancelled()); stop.await.unwrap().unwrap(); assert_eq!(plugin.stopped.load(Ordering::SeqCst), 1);
}

struct StartFailure { stopped: AtomicUsize }
impl CollectionPlugin for StartFailure {
    fn start(&self, _: CancellationToken) -> BoxFuture<'_, Result<()>> { Box::pin(async { Err(Error::new("TEST_START", "collector initialization failed")) }) }
    fn collect(&self, _: CancellationToken, _: Option<String>) -> BoxFuture<'_, Result<Option<SnapshotData>>> { Box::pin(async { Err(Error::new("TEST_COLLECT", "failed startup must not collect")) }) }
    fn stop(&self) -> BoxFuture<'_, Result<()>> { Box::pin(async { self.stopped.fetch_add(1, Ordering::SeqCst); Ok(()) }) }
}
#[tokio::test]
async fn settings_failure_is_returned_and_rollback_drains_a_failed_startup() {
    let profile = profile(); let monitor = Monitor::new(options(profile.path())).unwrap(); monitor.start(&disabled()).await.unwrap();
    monitor.registry.unregister("agents").await.unwrap(); let failed = Arc::new(StartFailure { stopped: AtomicUsize::new(0) }); let factory = failed.clone();
    monitor.registry.register(PluginDefinition { id: "agents".into(), section: MonitorSection::Agents, capabilities: Vec::new(), dependencies: Vec::new(), retry_sources: Vec::new(), interval: Duration::from_secs(60), timeout: Duration::from_secs(1), create: Arc::new(move |_| Ok(factory.clone())) }, false).await.unwrap();
    let mut enabled = disabled(); enabled.plugins.agents = true;
    assert_eq!(monitor.apply_settings(enabled).await.unwrap_err().code, "TEST_START"); assert!(monitor.snapshot().agents.error.is_some());
    monitor.apply_settings(disabled()).await.unwrap(); assert_eq!(failed.stopped.load(Ordering::SeqCst), 1); assert!(!monitor.enabled(MonitorSection::Agents));
    assert!(monitor.snapshot().agents.error.is_none()); assert_eq!(monitor.registry.statuses().iter().find(|status| status.id == "agents").unwrap().phase, PluginPhase::Disabled);
    monitor.stop().await.unwrap();
}
#[test]
fn schedule_identity_is_checked_beyond_the_displayed_job_id() {
    let shared = Shared::new(Vec::new());
    let job = ScheduledJob { id: "hermes-job:job".into(), name: "Job".into(), source: "hermes".into(), scope: JobScope::User, origin: JobOrigin::Personal, kind: JobKind::Interval, schedule: "hourly".into(), state: JobState::Waiting, state_reason: None, last_run: None, pid: None, last_exit_code: None, file: Some("/private/first.json".into()), executable: None, next_run: None };
    owner(&shared, MonitorSection::Schedules, 1); publish(&shared, SnapshotData::Schedules(ScheduleSnapshot { collected_at: T1.into(), jobs: vec![job.clone()], sources: Vec::new() }), 1, false, None);
    shared.require_job(&job).unwrap(); let mut replaced = job; replaced.file = Some("/private/replaced.json".into()); assert_eq!(shared.require_job(&replaced).unwrap_err().code, "OC_SCHEDULE_IDENTITY");
}

struct QueryReplacement { current: Mutex<Option<CancellationToken>>, entered: Notify }
impl CollectionPlugin for QueryReplacement {
    fn start(&self, cancel: CancellationToken) -> BoxFuture<'_, Result<()>> { Box::pin(async move { check_cancel(&cancel) }) }
    fn collect(&self, _: CancellationToken, _: Option<String>) -> BoxFuture<'_, Result<Option<SnapshotData>>> { Box::pin(async { Ok(Some(SnapshotData::Agents(agents(T1)))) }) }
    fn events(&self, _: EventQuery, cancel: CancellationToken) -> BoxFuture<'_, Result<EventPage>> {
        Box::pin(async move {
            let previous = self.current.lock().unwrap().replace(cancel.clone());
            if let Some(previous) = previous { previous.cancel(); Err(Error::new("TEST_QUERY_REPLACED", "replacement reached the domain")) }
            else { self.entered.notify_one(); cancel.cancelled().await; Err(Error::cancelled()) }
        })
    }
    fn stop(&self) -> BoxFuture<'_, Result<()>> { Box::pin(async { if let Some(cancel) = self.current.lock().unwrap().take() { cancel.cancel(); } Ok(()) }) }
}
#[tokio::test]
async fn query_domain_can_cancel_its_predecessor_without_waiting_for_the_old_query_gate() {
    let profile = profile(); let monitor = Monitor::new(options(profile.path())).unwrap(); monitor.start(&disabled()).await.unwrap(); monitor.registry.unregister("agents").await.unwrap();
    let query = Arc::new(QueryReplacement { current: Mutex::new(None), entered: Notify::new() }); let factory = query.clone();
    monitor.registry.register(PluginDefinition { id: "agents".into(), section: MonitorSection::Agents, capabilities: Vec::new(), dependencies: Vec::new(), retry_sources: Vec::new(), interval: Duration::from_secs(60), timeout: Duration::from_secs(1), create: Arc::new(move |_| Ok(factory.clone())) }, true).await.unwrap();
    let first = tokio::spawn({ let registry = monitor.registry(); async move { registry.events("agents", EventQuery::default(), CancellationToken::new()).await } }); query.entered.notified().await;
    let second = tokio::time::timeout(Duration::from_secs(1), monitor.registry.events("agents", EventQuery::default(), CancellationToken::new())).await.unwrap();
    assert_eq!(second.unwrap_err().code, "TEST_QUERY_REPLACED"); assert!(first.await.unwrap().unwrap_err().is_cancelled()); monitor.stop().await.unwrap();
}
#[tokio::test]
async fn system_locale_changes_preserve_explicit_language_and_apply_when_returning_to_system() {
    let profile = profile(); let monitor = Monitor::new(options(profile.path())).unwrap(); monitor.start(&disabled()).await.unwrap();
    let mut settings = disabled(); settings.language = Language::En; monitor.apply_settings(settings.clone()).await.unwrap();
    monitor.set_system_language(ResolvedLanguage::Chinese); assert_eq!(monitor.language.lock().unwrap().resolved(), ResolvedLanguage::English);
    settings.language = Language::System; monitor.apply_settings(settings).await.unwrap(); assert_eq!(monitor.language.lock().unwrap().resolved(), ResolvedLanguage::Chinese);
    monitor.stop().await.unwrap();
}
