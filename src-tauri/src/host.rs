use std::{sync::{Arc, Mutex, OnceLock, Weak, atomic::{AtomicBool, Ordering}}, time::Duration};
use oc_core::{agents::AgentPaths, error::{Error, Result, check_cancel}, events::EventPaths, io::BoundedIo,
    marketplace::{BundledAssets, Marketplace, MarketplaceOptions, MarketplaceSnapshot}, model::*, monitor::{Monitor, MonitorOptions},
    navigation::NavigationController, resources::ResourceBudget, schedules::SchedulePaths,
    settings::{AppSettings, ResolvedLanguage, SettingsLoadError, read_settings}, tern::{TernNavigation, TernOptions}, updates::{UpdateConfig, UpdateController}};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{Emitter, Manager};
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore, mpsc, watch};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use crate::{api::View, config::Config, documents::{Documents, index}, native::NativeBridge,
    settings::{SettingsCoordinator, SettingsOptions}, windows::{Windows, WindowSignal}};

#[path="host_commands.rs"] mod commands;
#[path="readiness.rs"] mod readiness;
#[cfg(feature="acceptance")]
#[path="../acceptance/host.rs"] mod acceptance;
#[cfg(feature="acceptance")]
pub use acceptance::request as acceptance_request;

#[derive(Clone)]
pub(super) enum Phase { Starting, Recovery(SettingsLoadError), Running, Fault(Error), Stopping, Stopped }
#[derive(Clone, Default)]
struct Components {
    monitor: Option<Arc<Monitor>>, market: Option<Arc<Marketplace>>, settings: Option<Arc<SettingsCoordinator>>,
    updates: Option<Arc<UpdateController>>, tern: Option<Arc<TernNavigation>>,
}
pub(super) struct Services { pub monitor: Arc<Monitor>, pub market: Arc<Marketplace>, pub settings: Arc<SettingsCoordinator>, pub updates: Arc<UpdateController>, pub tern: Arc<TernNavigation> }

struct RequestAdmission { total: Arc<Semaphore>, data: Arc<Semaphore> }
impl RequestAdmission {
    fn new() -> Self { Self { total: Arc::new(Semaphore::new(16)), data: Arc::new(Semaphore::new(12)) } }
    fn acquire(&self, command: &str) -> Result<(OwnedSemaphorePermit, Option<OwnedSemaphorePermit>)> {
        let busy = |_| Error::new("OC_IPC_BUSY", "桌面请求已达上限，请等待 / Desktop request limit reached");
        // Bulk operations may use twelve of the sixteen total slots. Replies,
        // subscription handshakes and cancellation must still make progress.
        let control = matches!(command, "desktop_register" | "desktop_interest" | "desktop_committed" | "desktop_ack"
            | "monitor_cancel_schedule_history" | "monitor_cancel_events" | "diagnostics_cancel"
            | "updates_cancel" | "marketplace_cancel" | "recovery_quit");
        let data = if control { None } else { Some(self.data.clone().try_acquire_owned().map_err(busy)?) };
        let total = self.total.clone().try_acquire_owned().map_err(busy)?;
        Ok((total, data))
    }
}

pub struct Host {
    pub(super) app: tauri::AppHandle, pub(super) config: Config, pub(super) native: Arc<NativeBridge>, pub(super) io: BoundedIo,
    pub(super) windows: OnceLock<Arc<Windows>>, pub(super) documents: Documents, pub(super) phase: Mutex<Phase>,
    components: Mutex<Components>, pub requests: TaskTracker, slots: RequestAdmission,
    background: TaskTracker, background_stop: CancellationToken, boot_cancel: CancellationToken,
    boot_gate: AsyncMutex<()>, close_gate: AsyncMutex<()>, pub(super) shutting: AtomicBool, pub exit_ready: AtomicBool,
    window_sender: mpsc::Sender<WindowSignal>, launch: watch::Sender<bool>, system_language: ResolvedLanguage,
    settings_link: Arc<Mutex<Option<Weak<SettingsCoordinator>>>>, pub(super) navigation: NavigationController,
    pub(super) receipt_started: AtomicBool, last_error: Mutex<Option<Error>>,
    #[cfg(feature="acceptance")]
    acceptance: acceptance::State,
}

impl Host {
    pub fn new(app: tauri::AppHandle, config: Config, native: Arc<NativeBridge>, language: ResolvedLanguage) -> (Arc<Self>, mpsc::Receiver<WindowSignal>) {
        let (window_sender, window_receiver) = mpsc::channel(64); let (launch, _) = watch::channel(false);
        (Arc::new(Self { app, config, native, io: BoundedIo::new(ResourceBudget::default()), windows: OnceLock::new(), documents: Documents::default(),
            phase: Mutex::new(Phase::Starting), components: Mutex::new(Components::default()), requests: TaskTracker::new(), slots: RequestAdmission::new(),
            background: TaskTracker::new(), background_stop: CancellationToken::new(), boot_cancel: CancellationToken::new(), boot_gate: AsyncMutex::new(()), close_gate: AsyncMutex::new(()),
            shutting: AtomicBool::new(false), exit_ready: AtomicBool::new(false), window_sender, launch, system_language: language,
            settings_link: Arc::new(Mutex::new(None)), navigation: NavigationController::new(), receipt_started: AtomicBool::new(false), last_error: Mutex::new(None),
            #[cfg(feature="acceptance")] acceptance: acceptance::State::default() }), window_receiver)
    }
    pub fn admit(&self, command: &str) -> Result<(OwnedSemaphorePermit, Option<OwnedSemaphorePermit>)> {
        if self.shutting.load(Ordering::Acquire) { return Err(Error::new("OC_HOST_CLOSING", "应用正在退出 / Application is closing")); }
        self.slots.acquire(command)
    }
    pub(super) fn services(&self) -> Result<Services> {
        let components = self.components.lock().map_err(|_| Error::invalid("host component state"))?;
        match (&components.monitor, &components.market, &components.settings, &components.updates, &components.tern) {
            (Some(monitor), Some(market), Some(settings), Some(updates), Some(tern)) => Ok(Services { monitor: monitor.clone(), market: market.clone(), settings: settings.clone(), updates: updates.clone(), tern: tern.clone() }),
            _ => Err(Error::new("OC_HOST_NOT_READY", "桌面服务尚未就绪 / Desktop services are not ready")),
        }
    }
    pub(super) fn window_manager(&self) -> Result<&Arc<Windows>> { self.windows.get().ok_or_else(|| Error::new("OC_WINDOWS_NOT_READY", "窗口服务尚未就绪 / Window service is not ready")) }
    pub fn report(&self, error: Error) {
        eprintln!("{}", json!({"hostError":error}));
        if let Ok(mut last) = self.last_error.lock() { *last = Some(error.clone()); }
        if let Err(emit) = self.emit("desktop-failure", &error) { eprintln!("desktop failure delivery: {emit}"); }
    }
    fn signal(&self, signal: WindowSignal) {
        if let WindowSignal::DocumentStarted(view) | WindowSignal::Destroyed(view) = &signal {
            if let Err(error) = self.documents.invalidate(*view) { self.report(error); }
        }
        if let WindowSignal::Visibility(view, visible) = &signal {
            match self.documents.get(*view) {
                Ok(Some(document)) => { document.visible.store(*visible, Ordering::Release); if !visible { if let Err(error) = document.pause_pushes() { self.report(error); } } },
                Ok(None) => {}, Err(error) => self.report(error),
            }
        }
        if self.background_stop.is_cancelled() { return; }
        if self.window_sender.try_send(signal).is_err() { self.report(Error::new("OC_WINDOW_EVENT_LIMIT", "窗口事件队列已满或关闭 / Window event queue is full or closed")); }
    }
    pub async fn run(self: &Arc<Self>, mut native_events: mpsc::Receiver<Value>, mut window_events: mpsc::Receiver<WindowSignal>) -> Result<()> {
        let weak = Arc::downgrade(self);
        let windows = Windows::new(self.app.clone(), self.config.headless, Arc::new(move |signal| { if let Some(host) = weak.upgrade() { host.signal(signal); } })).await?;
        self.windows.set(windows).map_err(|_| Error::invalid("window service initialization"))?;
        let host = self.clone();
        self.background.spawn(async move { loop {
            let event = tokio::select! { _ = host.background_stop.cancelled() => break, event = native_events.recv() => match event { Some(event) => event, None => { host.report(Error::new("OC_NATIVE_EVENTS_CLOSED", "原生事件连接已关闭 / Native event connection closed")); break; } } };
            if event["event"] == "applicationLaunched" { host.launch.send_replace(true); }
            if host.shutting.load(Ordering::Acquire) { continue; }
            let settings = host.components.lock().expect("component state").settings.clone();
            if let Some(settings) = settings {
                if event["event"] == "systemChanged" {
                    match host.native.call("systemRead", json!({})).await {
                        Ok(system) => match serde_json::from_value::<ResolvedLanguage>(system["systemLanguage"].clone()) {
                            Ok(language) => if let Some(monitor) = &host.components.lock().expect("component state").monitor { monitor.set_system_language(language); },
                            Err(_) => host.report(Error::invalid("system language readback")),
                        },
                        Err(error) => host.report(error),
                    }
                }
                if let Err(error) = settings.native_event(event).await { host.report(error); }
            }
        } });
        let host = self.clone();
        self.background.spawn(async move { loop {
            let signal = tokio::select! { _ = host.background_stop.cancelled() => break, signal = window_events.recv() => match signal { Some(signal) => signal, None => break } };
            if let Err(error) = host.window_signal(signal).await { host.report(error); }
        } });
        self.retry_startup().await.map(|_| ())
    }
    async fn login_startup(&self) -> Result<bool> {
        let mut launch = self.launch.subscribe();
        let read = self.native.call("loginRead", json!({})).await?;
        if read["launchEventObserved"] != true {
            tokio::select! {
                _ = self.boot_cancel.cancelled() => return Err(Error::cancelled()),
                result = tokio::time::timeout(Duration::from_secs(10), async {
                    while !*launch.borrow_and_update() { launch.changed().await.map_err(|_| Error::invalid("application launch observation"))?; }
                    Ok::<(), Error>(())
                }) => result.map_err(|_| Error::timeout("application launch observation"))??,
            }
        }
        let read = self.native.call("loginRead", json!({})).await?;
        if read["launchEventObserved"] != true { return Err(Error::new("OC_LOGIN_STARTUP_UNKNOWN", "无法确认应用启动来源 / Application launch origin is unconfirmed")); }
        read["wasOpenedAtLogin"].as_bool().ok_or_else(|| Error::invalid("login launch readback"))
    }
    pub(super) async fn retry_startup(self: &Arc<Self>) -> Result<bool> {
        let _boot = self.boot_gate.lock().await; check_cancel(&self.boot_cancel)?;
        if matches!(*self.phase.lock().map_err(|_| Error::invalid("startup state"))?, Phase::Running) { return Ok(true); }
        self.config.prepare_profile(&self.io).await?;
        let initial = match read_settings(&self.io, &self.config.profile.join("settings.json")).await {
            Ok(initial) => initial,
            Err(failure) => {
                *self.phase.lock().map_err(|_| Error::invalid("startup state"))? = Phase::Recovery(failure.clone());
                if self.config.headless && !self.config.recovery_acceptance { return Err(Error::new("OC_SETTINGS_STARTUP", failure.details)); }
                self.window_manager()?.ensure_recovery().await?; return Ok(false);
            },
        };
        let login_startup = self.login_startup().await?; check_cancel(&self.boot_cancel)?;
        self.initialize_services(initial.clone(), login_startup).await?; check_cancel(&self.boot_cancel)?;
        *self.phase.lock().map_err(|_| Error::invalid("startup state"))? = Phase::Running;
        if !login_startup { self.window_manager()?.ensure_main(initial.window_bounds).await?; }
        if self.documents.get(View::Recovery)?.is_some() {
            self.revoke(View::Recovery).await?;
            self.window_manager()?.close_recovery().await?;
        }
        Ok(true)
    }
    async fn initialize_services(self: &Arc<Self>, initial: AppSettings, login_startup: bool) -> Result<()> {
        let link = self.settings_link.clone(); let weak = Arc::downgrade(self);
        let monitor = Monitor::new(MonitorOptions { io: self.io.clone(), worker: self.config.resources.join("oc-data-worker"),
            agent_paths: AgentPaths::for_home(self.config.home.clone()), schedule_paths: SchedulePaths::new(self.config.home.clone()),
            event_paths: EventPaths { home: self.config.home.clone(), profile: self.config.profile.clone(), database: self.config.profile.join("events/events.sqlite"),
                hermes_database: self.config.home.join(".hermes/cron/executions.db"), journal: self.config.profile.join("events/notifications.json") },
            native: self.native.clone(), language: self.system_language,
            notification_changed: Arc::new(move |state| { let settings = link.lock().expect("settings notification link").as_ref().and_then(Weak::upgrade);
                if let Some(settings) = settings { if let Err(error) = settings.notifications_changed(state) { if let Some(host) = weak.upgrade() { host.report(error); } } } }),
        })?;
        self.components.lock().map_err(|_| Error::invalid("host components"))?.monitor = Some(monitor.clone());
        monitor.start(&initial).await?;
        let (market_changed, market_updates) = watch::channel(MarketplaceSnapshot::default());
        let enabled_monitor = monitor.clone();
        #[cfg(feature = "acceptance")]
        let market_fixture_roots = acceptance::market_fixture_roots(self.config.headless, self.config.development)?;
        let market = Marketplace::open(MarketplaceOptions { profile: self.config.profile.clone(), io: self.io.clone(), registry: monitor.registry(),
            worker: self.config.resources.join("oc-data-worker"), bundled: BundledAssets { directory: self.config.resources.join("plugin-market"), catalog_sha256: self.config.catalog_digest().into() },
            host_bundle: self.config.bundle.clone(), host_bundle_id: oc_installer::BUNDLE_ID.into(), app_version: env!("CARGO_PKG_VERSION").into(),
            enabled: Arc::new(move |section| enabled_monitor.enabled(section)), changed: Arc::new(move |snapshot| { market_changed.send_replace(snapshot); }),
            #[cfg(feature = "acceptance")] fixture_roots: market_fixture_roots,
        }, &self.boot_cancel).await?;
        self.components.lock().map_err(|_| Error::invalid("host components"))?.market = Some(market);
        let updates = UpdateController::new(UpdateConfig { profile: self.config.profile.clone(), host_bundle: self.config.bundle.clone(), worker: self.config.resources.join("oc-data-worker"),
            current_version: env!("CARGO_PKG_VERSION").into(), development: self.config.development }, self.io.clone()).await?;
        self.components.lock().map_err(|_| Error::invalid("host components"))?.updates = Some(updates.clone());
        let effect_monitor = monitor.clone(); let windows = self.window_manager()?.clone();
        let notifications = monitor.events(); let permissions = monitor.events(); let sleep_monitor = monitor.clone();
        let settings = SettingsCoordinator::new(SettingsOptions { io: self.io.clone(), path: self.config.profile.join("settings.json"), initial,
            native: self.native.clone(), headless: self.config.headless, development: self.config.development, login_startup, system_language: self.system_language,
            effect: Arc::new(move |settings| { let monitor = effect_monitor.clone(); let windows = windows.clone(); Box::pin(async move {
                monitor.apply_settings(settings.clone()).await?; windows.set_tray_click(settings.tray_click).await
            }) }),
            notifications: Arc::new(move || notifications.notification_snapshot()),
            request_permission: Arc::new(move || { let events = permissions.clone(); Box::pin(async move { events.request_notification_permission().await }) }),
            sleep_changed: Arc::new(move |sleeping| { let monitor = sleep_monitor.clone(); Box::pin(async move {
                if monitor.enabled(MonitorSection::Events) { if sleeping { monitor.events().sleep().await } else { monitor.events().wake().await } } else { Ok(()) }
            }) }),
        }).await?;
        self.components.lock().map_err(|_| Error::invalid("host components"))?.settings = Some(settings.clone());
        *self.settings_link.lock().map_err(|_| Error::invalid("settings notification link"))? = Some(Arc::downgrade(&settings));
        let agent_monitor = monitor.clone(); let identity_monitor = monitor.clone();
        let tern = TernNavigation::new(TernOptions { io: self.io.clone(), resources: self.config.resources.join("tern-navigation"), home: self.config.home.clone(), tmp: self.config.tmp.clone(), headless: self.config.headless,
            agents: Arc::new(move || agent_monitor.snapshot().agents.data.map(|data| data.agents).unwrap_or_default()),
            process_identity: Arc::new(move |id| { let monitor = identity_monitor.clone(); Box::pin(async move { monitor.process_identity(&id).await }) }),
        })?;
        self.components.lock().map_err(|_| Error::invalid("host components"))?.tern = Some(tern);
        for section in MonitorSection::ALL {
            let stream = match section { MonitorSection::Agents => "agents", MonitorSection::Schedules => "schedules", MonitorSection::System => "system", MonitorSection::Events => "events" };
            self.watch(monitor.updates(section), "monitor-changed", stream);
            let mut sources = monitor.sources(section); let weak = Arc::downgrade(self); let stop = self.background_stop.clone();
            self.background.spawn(async move { loop {
                tokio::select! { _ = stop.cancelled() => break, change = sources.changed() => if change.is_err() { break; } }
                let Some(host) = weak.upgrade() else { break; };
                if let Some(value) = &*sources.borrow_and_update() { if let Err(error) = host.emit_stream("monitor-sources", stream, value) { host.report(error); } }
            } });
        }
        self.watch(settings.subscribe(), "settings-changed", ""); self.watch(updates.subscribe(), "updates-changed", ""); self.watch(market_updates, "marketplace-changed", "");
        updates.start(); Ok(())
    }
    fn watch<T: Serialize + Clone + Send + Sync + 'static>(self: &Arc<Self>, mut receiver: watch::Receiver<T>, channel: &'static str, stream: &'static str) {
        let weak = Arc::downgrade(self); let stop = self.background_stop.clone();
        self.background.spawn(async move { loop {
            tokio::select! { _ = stop.cancelled() => break, change = receiver.changed() => if change.is_err() { break; } }
            let Some(host) = weak.upgrade() else { break; };
            if let Err(error) = host.emit_stream(channel, stream, &*receiver.borrow_and_update()) { host.report(error); }
        } });
    }
    pub(super) fn emit<T: Serialize + ?Sized>(&self, channel: &'static str, value: &T) -> Result<()> { self.emit_stream(channel, "", value) }
    fn emit_stream<T: Serialize + ?Sized>(&self, channel: &'static str, stream: &'static str, value: &T) -> Result<()> {
        let documents = self.documents.all()?;
        let mut serialized: Option<Arc<str>> = None;
        for document in documents {
            if !document.can_receive(channel, self.config.headless)? { continue; }
            let value = match &serialized { Some(value) => value.clone(), None => { let value: Arc<str> = crate::ipc::serialized(value)?.into(); serialized = Some(value.clone()); value } };
            if let Some(delivery) = document.push(channel, stream, value)? { self.deliver(&document, delivery)?; }
        }
        Ok(())
    }
    pub(super) fn deliver(&self, document: &crate::documents::Document, delivery: crate::documents::Delivery) -> Result<()> {
        if let Err(error) = self.app.emit_str_to(tauri::EventTarget::webview_window(document.view.label()), delivery.channel, delivery.payload) {
            eprintln!("desktop delivery: {error}"); document.failed_delivery()?;
            return Err(Error::new("OC_IPC_EVENT", "桌面事件发送失败 / Desktop event delivery failed"));
        }
        Ok(())
    }
    async fn window_signal(self: &Arc<Self>, signal: WindowSignal) -> Result<()> {
        match signal {
            WindowSignal::DocumentStarted(view) | WindowSignal::Destroyed(view) => {
                let _gate = self.documents.gates[index(view)].lock().await;
                if self.documents.get(view)?.is_some_and(|document| document.cancel.is_cancelled()) { self.revoke_locked(view).await?; }
                Ok(())
            },
            WindowSignal::Visibility(view, visible) => {
                if let Some(document) = self.documents.get(view)? { document.visible.store(visible, Ordering::Release); }
                if !visible { self.blur(view).await?; } Ok(())
            },
            WindowSignal::Blur(view) => self.blur(view).await,
            WindowSignal::Geometry(bounds) => {
                let settings = self.components.lock().map_err(|_| Error::invalid("host components"))?.settings.clone();
                if let Some(settings) = settings { if !self.shutting.load(Ordering::Acquire) { settings.on_geometry(bounds).await?; } } Ok(())
            },
            WindowSignal::ShowMain => self.show_main(None).await,
            WindowSignal::Quit => { self.request_quit(0); Ok(()) },
            WindowSignal::Failed(error) => Err(error),
        }
    }
    async fn blur(&self, view: View) -> Result<()> {
        if view != View::Main || self.shutting.load(Ordering::Acquire) { return Ok(()); }
        if let Some(document) = self.documents.get(view)? {
            let services = self.services()?;
            services.settings.preview_glass(document.id, None).await?;
            services.tern.cancel().await?;
        }
        Ok(())
    }
    pub(super) async fn revoke(&self, view: View) -> Result<()> {
        let _gate = self.documents.gates[index(view)].lock().await;
        self.revoke_locked(view).await
    }
    pub(super) async fn revoke_locked(&self, view: View) -> Result<()> {
        let Some(document) = self.documents.get(view)? else { return Ok(()); };
        document.invalidate();
        let mut failures = Vec::new();
        if let Err(error) = document.pause_pushes() { failures.push(error); }
        if let Some(diagnostics) = &document.diagnostics { if let Err(error) = diagnostics.close().await { failures.push(error); } }
        if let Err(error) = document.history.cancel().await { failures.push(error); }
        if let Err(error) = document.events.cancel().await { failures.push(error); }
        let components = self.components.lock().map_err(|_| Error::invalid("host components"))?.clone();
        if view == View::Main { if let Some(tern) = components.tern { if let Err(error) = tern.cancel().await { failures.push(error); } } }
        document.tasks.wait().await;
        if document.settings_registered.load(Ordering::Acquire) {
            if let Some(settings) = components.settings {
                match settings.unregister_window(document.id).await { Ok(()) => document.settings_registered.store(false, Ordering::Release), Err(error) => failures.push(error) }
            }
        }
        if document.native_registered.load(Ordering::Acquire) {
            match self.native.revoke_owner(document.id).await { Ok(()) => document.native_registered.store(false, Ordering::Release), Err(error) => failures.push(error) }
        }
        if failures.is_empty() { self.documents.take(view)?; Ok(()) } else { Err(Error::aggregate(failures)) }
    }
    pub(super) async fn show_main(&self, target: Option<NavigationTarget>) -> Result<()> {
        if self.config.headless { return Err(Error::new("OC_HEADLESS", "无头实例不能显示窗口 / Headless instances cannot show windows")); }
        let services = self.services()?;
        if let Some(target) = target { self.navigation.put(target, &services.monitor.snapshot())?; }
        let settings = services.settings.snapshot().await?;
        self.window_manager()?.ensure_main(settings.settings.window_bounds).await?;
        self.window_manager()?.show_main().await?;
        self.emit("monitor-navigation", &Value::Null)
    }
    pub fn request_quit(self: &Arc<Self>, code: i32) {
        if self.shutting.swap(true, Ordering::AcqRel) { return; }
        self.boot_cancel.cancel(); let host = self.clone();
        tauri::async_runtime::spawn(async move {
            match host.shutdown(None).await {
                Ok(()) => { host.exit_ready.store(true, Ordering::Release); host.app.exit(code); },
                Err(error) => { host.report(error); host.shutting.store(false, Ordering::Release); },
            }
        });
    }
    pub(super) fn request_install(self: &Arc<Self>, prepared: oc_installer::PreparedInstallation) {
        self.shutting.store(true, Ordering::Release); self.boot_cancel.cancel(); let host = self.clone();
        tauri::async_runtime::spawn(async move {
            match host.shutdown(Some(prepared)).await {
                Ok(()) => { host.exit_ready.store(true, Ordering::Release); host.app.exit(0); },
                Err(error) => { if let Ok(services) = host.services() { services.updates.fail(error.clone()); } host.report(error); host.shutting.store(false, Ordering::Release); },
            }
        });
    }
    async fn shutdown(&self, mut installation: Option<oc_installer::PreparedInstallation>) -> Result<()> {
        let _close = self.close_gate.lock().await; let _boot = self.boot_gate.lock().await;
        *self.phase.lock().map_err(|_| Error::invalid("shutdown state"))? = Phase::Stopping;
        self.requests.close();
        *self.settings_link.lock().map_err(|_| Error::invalid("settings notification link"))? = None;
        let components = self.components.lock().map_err(|_| Error::invalid("host components"))?.clone();
        let result = async {
            // Final geometry writes still apply collection preferences. Drain them before stopping plugins.
            if let Some(settings) = &components.settings { settings.close().await?; }
            for document in self.documents.all()? {
                document.invalidate();
                if let Some(diagnostics) = &document.diagnostics { diagnostics.close().await?; }
                document.history.cancel().await?; document.events.cancel().await?;
            }
            if let Some(tern) = &components.tern { tern.close().await?; }
            if let Some(market) = &components.market { market.close().await?; }
            if let Some(updates) = &components.updates { updates.stop().await?; }
            if let Some(monitor) = &components.monitor { monitor.stop().await?; }
            self.requests.wait().await;
            for document in self.documents.all()? {
                document.tasks.wait().await;
                if document.native_registered.load(Ordering::Acquire) { self.native.revoke_owner(document.id).await?; document.native_registered.store(false, Ordering::Release); }
                self.documents.take(document.view)?;
            }
            self.background_stop.cancel(); self.background.close(); self.background.wait().await;
            self.native.release().await?;
            if let Some(prepared) = installation.take() {
                self.io.with_file_budget("application-install", 64 * 1024, &self.io.cancellation(), move |_| async move {
                    tokio::task::spawn_blocking(move || {
                        let mut prepared = prepared;
                        if let Err(error) = prepared.spawn_helper() {
                            let failure = Error::new("OC_UPDATE_HANDOFF", error.to_string());
                            return match prepared.abandon() { Ok(()) => Err(failure), Err(cleanup) => Err(Error::aggregate(vec![failure, Error::new("OC_RESOURCE_CLOSE", cleanup.to_string())])) };
                        }
                        Ok(())
                    }).await.map_err(|_| Error::new("OC_UPDATE_HANDOFF", "安装移交任务异常 / Installer handoff task failed"))?
                }).await?;
            }
            self.io.shutdown().await?;
            if let Some(windows) = self.windows.get() { windows.close().await?; }
            *self.phase.lock().map_err(|_| Error::invalid("shutdown state"))? = Phase::Stopped;
            #[cfg(feature="acceptance")]
            if self.acceptance.shutdown_report.load(Ordering::Acquire) { println!("{}", json!({"shutdownReport":{"resources":self.io.resources().snapshot(),"documents":self.documents.all()?.len(),"requests":self.requests.len()}})); }
            Ok(())
        }.await;
        if let Some(prepared) = installation {
            let cleanup = tokio::task::spawn_blocking(move || prepared.abandon()).await
                .map_err(|_| Error::new("OC_RESOURCE_CLOSE", "安装事务清理任务异常 / Installer cleanup task failed"))?
                .map_err(|error| Error::new("OC_RESOURCE_CLOSE", error.to_string()));
            return match (result, cleanup) { (Ok(()), result) => result, (Err(error), Ok(())) => Err(error), (Err(error), Err(cleanup)) => Err(Error::aggregate(vec![error, cleanup])) };
        }
        result
    }
    pub fn startup_failed(self: &Arc<Self>, error: Error) {
        *self.phase.lock().expect("host startup state") = Phase::Fault(error.clone()); self.report(error); self.request_quit(1);
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    #[test]
    fn saturated_collection_keeps_control_progress_within_total_budget() {
        let slots = RequestAdmission::new();
        let mut data: Vec<_> = (0..12).map(|_| slots.acquire("monitor_refresh").unwrap()).collect();
        assert_eq!(slots.acquire("monitor_refresh").unwrap_err().code, "OC_IPC_BUSY");
        let controls: Vec<_> = ["desktop_ack", "desktop_interest", "monitor_cancel_schedule_history", "monitor_cancel_events"]
            .into_iter().map(|command| slots.acquire(command).unwrap()).collect();
        assert_eq!(slots.total.available_permits(), 0);
        assert_eq!(slots.acquire("desktop_ack").unwrap_err().code, "OC_IPC_BUSY");
        data.pop();
        data.push(slots.acquire("monitor_refresh").unwrap());
        drop(controls); drop(data);
        assert_eq!(slots.total.available_permits(), 16);
        assert_eq!(slots.data.available_permits(), 12);
    }
    #[test]
    fn total_rejection_returns_the_partial_data_reservation() {
        let slots = RequestAdmission::new();
        let controls: Vec<_> = (0..16).map(|_| slots.acquire("desktop_ack").unwrap()).collect();
        assert_eq!(slots.acquire("monitor_refresh").unwrap_err().code, "OC_IPC_BUSY");
        assert_eq!(slots.data.available_permits(), 12);
        drop(controls);
        assert_eq!(slots.total.available_permits(), 16);
    }
}
