use super::*;
use std::{collections::VecDeque, path::PathBuf};
use serde::Deserialize;
use oc_core::{events::contracts::{CommitResult, StoredState}, settings::AppSettings, worker::DataWorker};

#[derive(Default, Serialize)]
struct Queries { active: usize, total: u64, cancelled: u64, recent: VecDeque<EventQuery> }
struct Seed { settings: AppSettings, loaded: StoredState, target: NavigationTarget, now: i64, next: usize, count_before: usize }
#[derive(Default)]
pub(super) struct State {
    faults: Mutex<[bool; 2]>, queries: Mutex<Queries>, seed: AsyncMutex<Option<Seed>>, seeded: AtomicBool,
    pub shutdown_report: AtomicBool,
}
pub(super) struct QueryObservation<'a> { queries: &'a Mutex<Queries> }
impl QueryObservation<'_> {
    pub fn finish(self, cancelled: bool) { if cancelled { self.queries.lock().expect("query observation").cancelled += 1; } }
}
impl Drop for QueryObservation<'_> { fn drop(&mut self) { self.queries.lock().expect("query observation").active -= 1; } }
impl State {
    pub fn check_command(&self, command: &str) -> Result<()> {
        let index = match command { "monitor_snapshot" => 0, "monitor_events" => 1, _ => return Ok(()) };
        if self.faults.lock().map_err(|_| Error::invalid("acceptance command fault"))?[index] { Err(Error::new("OC_ACCEPTANCE_REJECTION", "Requested real command rejection")) } else { Ok(()) }
    }
    pub fn begin_query(&self, query: &EventQuery) -> Result<QueryObservation<'_>> {
        let mut queries = self.queries.lock().map_err(|_| Error::invalid("query observation"))?;
        queries.active += 1; queries.total += 1;
        if queries.recent.len() == 16 { queries.recent.pop_front(); }
        queries.recent.push_back(query.clone());
        Ok(QueryObservation { queries: &self.queries })
    }
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct TrustedAsset { directory: PathBuf, catalog_sha256: String }
/// Launch-supplied fixture trust roots, read from an explicit, size- and count-bounded
/// environment JSON before the marketplace initializes. This is the only way an
/// installed, fixture-signed package can survive a restart: the installed directory is
/// never treated as a trust root, and production builds never read this environment.
pub(super) fn market_fixture_roots(headless: bool, development: bool) -> Result<Vec<BundledAssets>> {
    let Some(raw) = std::env::var_os("OC_CHAN_ACCEPTANCE_MARKET_FIXTURES") else { return Ok(Vec::new()) };
    if !headless || !development { return Err(Error::invalid("acceptance market fixture launch mode")); }
    let text = raw.into_string().map_err(|_| Error::invalid("acceptance market fixture roots encoding"))?;
    if text.len() > 64 * 1024 { return Err(Error::limit("acceptance market fixture roots bytes", 64 * 1024, text.len())); }
    let roots: Vec<TrustedAsset> = serde_json::from_str(&text).map_err(|_| Error::invalid("acceptance market fixture roots"))?;
    if roots.is_empty() { return Err(Error::invalid("acceptance market fixture roots")); }
    if roots.len() > 16 { return Err(Error::limit("acceptance market fixture roots", 16, roots.len())); }
    roots.into_iter().map(|asset| {
        if !asset.directory.is_absolute() || asset.directory.as_os_str().len() > 4096 || asset.directory.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
            return Err(Error::invalid("acceptance market fixture directory"));
        }
        let directory = std::fs::canonicalize(&asset.directory).map_err(|error| Error::io("acceptance market fixture directory", error))?;
        Ok(BundledAssets { directory, catalog_sha256: asset.catalog_sha256 })
    }).collect()
}
#[derive(Deserialize)]
#[serde(tag="action", rename_all="kebab-case", deny_unknown_fields)]
enum Action {
    Info, EnsureTray, ShutdownReport,
    PerformanceStart, PerformanceDrain, PerformanceStop, PerformanceClock,
    FaultCommand { #[serde(rename="targetCommand")] command: String, enabled: bool },
    SeedEvents { start: usize, count: usize, #[serde(rename="final")] final_batch: bool },
    #[serde(rename_all="camelCase")]
    MarketplaceFeed { catalog_url: String, catalog_sha256: String, trusted_assets: Vec<TrustedAsset> },
}

pub async fn request(app: tauri::AppHandle, request: Value) -> Result<Value> {
    let host = app.state::<Arc<Host>>().inner().clone();
    if !host.config.headless || host.shutting.load(Ordering::Acquire) { return Err(Error::invalid("acceptance host state")); }
    let action: Action = serde_json::from_value(request).map_err(|_| Error::invalid("acceptance host action"))?;
    match action {
        Action::Info => info(&host).await,
        Action::EnsureTray => { host.window_manager()?.ensure_tray().await?; Ok(json!({"ready":true})) },
        Action::ShutdownReport => { host.acceptance.shutdown_report.store(true, Ordering::Release); Ok(json!({"enabled":true})) },
        Action::PerformanceStart => { oc_core::performance::install()?; Ok(json!({"started":true})) },
        Action::PerformanceDrain => oc_core::performance::drain(),
        Action::PerformanceStop => oc_core::performance::uninstall(),
        Action::PerformanceClock => Ok(oc_core::performance::clock()),
        Action::FaultCommand { command, enabled } => {
            let index = match command.as_str() { "monitor_snapshot" => 0, "monitor_events" => 1, _ => return Err(Error::invalid("acceptance fault command")) };
            host.acceptance.faults.lock().map_err(|_| Error::invalid("acceptance fault state"))?[index] = enabled;
            Ok(json!({"command":command,"enabled":enabled}))
        },
        Action::SeedEvents { start, count, final_batch } => seed_events(&host, start, count, final_batch).await,
        Action::MarketplaceFeed { catalog_url, catalog_sha256, trusted_assets } => {
            if trusted_assets.is_empty() || trusted_assets.len() > 16 || trusted_assets.iter().any(|asset| !asset.directory.is_absolute()) { return Err(Error::invalid("fixture asset directories")); }
            host.services()?.market.set_acceptance_feed(oc_core::marketplace::AcceptanceFeed { catalog_url, catalog_sha256,
                trusted_assets: trusted_assets.into_iter().map(|asset| BundledAssets { directory: asset.directory, catalog_sha256: asset.catalog_sha256 }).collect() }).await?;
            Ok(json!({"configured":true}))
        },
    }
}
async fn info(host: &Arc<Host>) -> Result<Value> {
    let (send, receive) = tokio::sync::oneshot::channel(); let app = host.app.clone();
    host.app.run_on_main_thread(move || {
        let result = (|| {
            let mut values = Vec::with_capacity(3);
            for view in [View::Main, View::Tray, View::Recovery] {
                if let Some(window) = app.get_webview_window(view.label()) {
                    let pointer = window.ns_window().map_err(|_| Error::invalid("acceptance native window"))?;
                    let native = unsafe { (pointer as *const objc2_app_kit::NSWindow).as_ref() }.ok_or_else(|| Error::invalid("acceptance NSWindow"))?;
                    values.push(json!({"view":view,"visible":window.is_visible().map_err(|_| Error::invalid("window visibility"))?,"focusable":native.canBecomeKeyWindow()}));
                }
            }
            Ok::<_, Error>(values)
        })();
        if send.send(result).is_err() { eprintln!("acceptance window observation recipient closed"); }
    }).map_err(|_| Error::invalid("window observation dispatch"))?;
    let mut windows = receive.await.map_err(|_| Error::invalid("window observation completion"))??;
    for window in &mut windows {
        let view = View::from_label(window["view"].as_str().ok_or_else(|| Error::invalid("window view"))?).ok_or_else(|| Error::invalid("window view"))?;
        if let Some(document) = host.documents.get(view)? {
            let object = window.as_object_mut().expect("window observation object");
            object.insert("owner".into(), json!(document.id)); object.insert("epoch".into(), json!(document.epoch));
            object.insert("committed".into(), json!(document.committed.load(Ordering::Acquire)));
            object.insert("subscribed".into(), serde_json::to_value(*document.interest.lock().map_err(|_| Error::invalid("window subscriptions"))?).map_err(|_| Error::invalid("window subscriptions"))?);
            object.insert("push".into(), document.push_statistics()?);
        }
    }
    let monitor = host.components.lock().map_err(|_| Error::invalid("acceptance components"))?.monitor.clone();
    let notifications = monitor.as_ref().map(|monitor| monitor.events().acceptance_notifications()).transpose()?;
    Ok(json!({"profile":host.config.profile,"home":host.config.home,"windows":windows,"resources":host.io.resources().snapshot(),
        "monitor":monitor.as_ref().map(|monitor| monitor.snapshot()),"plugins":monitor.as_ref().map(|monitor| monitor.registry().statuses()),
        "notifications":notifications,"eventQueries":&*host.acceptance.queries.lock().map_err(|_| Error::invalid("query observations"))?}))
}
fn time(milliseconds: i64) -> Result<String> {
    chrono::DateTime::from_timestamp_millis(milliseconds).map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).ok_or_else(|| Error::invalid("fixture event time"))
}
async fn seed_events(host: &Arc<Host>, start: usize, count: usize, final_batch: bool) -> Result<Value> {
    if count == 0 || count > 100 || start > 5000 - count || final_batch != (start + count == 5000) || host.acceptance.seeded.load(Ordering::Acquire) { return Err(Error::invalid("event fixture batch")); }
    let mut slot = host.acceptance.seed.lock().await;
    let services = host.services()?;
    let worker = DataWorker::new(host.io.clone(), host.config.resources.join("oc-data-worker"));
    let database = host.config.profile.join("events/events.sqlite");
    let cancel = host.io.cancellation();
    if slot.is_none() {
        if start != 0 { return Err(Error::invalid("event seed sequence")); }
        let snapshot = services.monitor.snapshot();
        let prefix = host.config.home.to_str().ok_or_else(|| Error::invalid("fixture home encoding"))?;
        let job = snapshot.schedules.data.as_ref().and_then(|data| data.jobs.iter().find(|job| job.id.starts_with("hermes-job:") && job.file.as_ref().is_some_and(|file| std::path::Path::new(file).starts_with(prefix))))
            .ok_or_else(|| Error::invalid("current fixture schedule identity"))?;
        let target = NavigationTarget::schedule(job);
        let settings = services.settings.snapshot().await?.settings;
        if !settings.plugins.events { return Err(Error::invalid("events must be enabled before seed")); }
        let mut paused = settings.clone(); paused.plugins.events = false;
        services.monitor.apply_settings(paused).await?;
        let now = chrono::Utc::now().timestamp_millis();
        let load = async {
            let loaded: StoredState = serde_json::from_value(worker.request("events-load", &database, json!({"now":time(now)?}), &cancel).await?).map_err(|_| Error::invalid("event seed state"))?;
            if loaded.checkpoint.is_none() { return Err(Error::invalid("event checkpoint must exist before seed")); }
            Ok::<_, Error>(loaded)
        }.await;
        match load {
            Ok(loaded) => { let count_before = loaded.retention.count; *slot = Some(Seed { settings, loaded, target, now, next:0, count_before }); },
            Err(error) => { return match services.monitor.apply_settings(settings).await { Ok(()) => Err(error), Err(cleanup) => Err(Error::aggregate(vec![error, cleanup])) }; },
        }
    }
    let seed = slot.as_mut().expect("seed initialized");
    if seed.next != start { return Err(Error::invalid("event seed order")); }
    let write = async {
        let types = [LocalEventType::ExecutionFailed, LocalEventType::DeliveryFailed, LocalEventType::SourceUnavailable, LocalEventType::SourceRecovered];
        let sources = ["smoke-events-a", "smoke-events-b", "collection:system"];
        let id = match &seed.target { NavigationTarget::Schedule { id, .. } => id, _ => return Err(Error::invalid("fixture event target")) };
        let mut events = Vec::with_capacity(count);
        for index in start..start + count {
            let age = if index >= 4997 { 60_000 } else { match index % 3 { 0 => 30 * 60_000, 1 => 12 * 3_600_000, _ => 3 * 86_400_000 } };
            events.push(LocalEvent { id:format!("smoke-f05-{index:05}"), source_id:sources[index % 3].into(),
                entity_id:if index == 4999 { "synthetic-long-entity-".repeat(11) } else { id.clone() }, event_type:types[index % 4],
                observed_at:time(seed.now - age)?, occurred_at:if index == 4997 { None } else { Some(time(seed.now - age - 3_600_000)?) },
                result_code:if index == 4999 { "synthetic-long-result-".repeat(2) } else { "SMOKE_SYNTHETIC".into() },
                target:if index == 4997 { None } else if index == 4998 { Some(NavigationTarget::Schedule { id:id.clone(), identity:"[\"smoke-obsolete-identity\"]".into() }) } else { Some(seed.target.clone()) } });
        }
        let result: CommitResult = serde_json::from_value(worker.request("events-commit", &database, json!({"identity":seed.loaded.identity,"revision":seed.loaded.revision,"checkpoint":seed.loaded.checkpoint,"events":events,"now":time(seed.now)?}), &cancel).await?)
            .map_err(|_| Error::invalid("event seed commit"))?;
        if result.added.len() != count || result.retention.count != seed.count_before + start + count { return Err(Error::invalid("event seed retained count")); }
        seed.next += count;
        seed.loaded = StoredState { identity:result.identity, revision:result.revision, checkpoint:Some(result.checkpoint), retention:result.retention };
        Ok(json!({"count":seed.next,"batches":seed.next.div_ceil(100),"batchSize":count,"countBefore":seed.count_before,"retention":seed.loaded.retention,"target":seed.target,
            "validId":"smoke-f05-04999","obsoleteId":"smoke-f05-04998","nullId":"smoke-f05-04997","now":time(seed.now)?}))
    }.await;
    if final_batch || write.is_err() {
        let seed = slot.take().expect("seed retained");
        let cleanup = async { services.monitor.apply_settings(seed.settings).await?; services.monitor.refresh(Some(MonitorSection::Events)).await }.await;
        match (write, cleanup) {
            (Ok(value), Ok(())) => { host.acceptance.seeded.store(true, Ordering::Release); Ok(value) },
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(error), Err(cleanup)) => Err(Error::aggregate(vec![error, cleanup])),
        }
    } else { write }
}
