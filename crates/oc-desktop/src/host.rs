use std::{sync::{Arc, Mutex, Weak, atomic::{AtomicBool, AtomicU64, Ordering}}, time::Duration};
use oc_core::{agents::AgentPaths, error::{Error, Result, check_cancel}, events::EventPaths, io::BoundedIo,
    marketplace::{BundledAssets, Marketplace, MarketplaceOptions, MarketplaceSnapshot}, model::*, monitor::{Monitor, MonitorOptions},
    navigation::NavigationController, resources::ResourceBudget, schedules::SchedulePaths,
    settings::{AppSettings, ResolvedLanguage, SettingsLoadError, read_settings}, tern::{TernNavigation, TernOptions}};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore, mpsc, watch};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use crate::{api::View,config::Config,native::NativeBridge,settings::{SettingsCoordinator,SettingsOptions},session::Session,platform::{WindowRequests,HostWindowAction}};
#[path="actions.rs"] mod actions;
#[path="readiness.rs"] mod readiness;
#[path="tray_preferences.rs"] mod tray_preferences;
#[derive(Clone)]
pub enum Phase { Starting, Recovery(SettingsLoadError), Running, Fault(Error), Stopping, Stopped }
#[derive(Clone, Default)]
struct Components {
    monitor: Option<Arc<Monitor>>, market: Option<Arc<Marketplace>>, settings: Option<Arc<SettingsCoordinator>>,
    tern: Option<Arc<TernNavigation>>,
}
pub struct Services { pub monitor: Arc<Monitor>, pub market: Arc<Marketplace>, pub settings: Arc<SettingsCoordinator>, pub tern: Arc<TernNavigation> }

struct RequestAdmission { total: Arc<Semaphore>, data: Arc<Semaphore> }
impl RequestAdmission {
    fn new() -> Self { Self { total: Arc::new(Semaphore::new(16)), data: Arc::new(Semaphore::new(12)) } }
    fn acquire(&self, command: &str) -> Result<(OwnedSemaphorePermit, Option<OwnedSemaphorePermit>)> {
        let busy = |_| Error::new("OC_DESKTOP_BUSY", "桌面请求已达上限，请等待 / Desktop request limit reached");
        // Reserve four admission slots for cancellation and shutdown controls.
        let control = matches!(command, "monitor_cancel_schedule_detail" | "monitor_cancel_schedule_history" | "monitor_cancel_events" | "diagnostics_cancel"
            | "marketplace_cancel" | "recovery_quit");
        let data = if control { None } else { Some(self.data.clone().try_acquire_owned().map_err(busy)?) };
        let total = self.total.clone().try_acquire_owned().map_err(busy)?;
        Ok((total, data))
    }
}
#[derive(Clone)]
pub struct DesktopState {pub phase:Phase,pub events:BTreeMap<String,Value>,pub last_error:Option<Error>}
pub struct Desktop {
 pub config:Config,pub native:Arc<NativeBridge>,pub io:BoundedIo,pub windows:WindowRequests,
 phase:Mutex<Phase>, components:Mutex<Components>,sessions:Mutex<BTreeMap<u64,Arc<Session>>>,next_owner:AtomicU64,
 pub requests:TaskTracker,slots:RequestAdmission,background:TaskTracker,background_stop:CancellationToken,boot_cancel:CancellationToken,
 boot_gate:AsyncMutex<()>,close_gate:AsyncMutex<()>,pub shutting:AtomicBool,pub exit_ready:AtomicBool,
 launch:watch::Sender<bool>,system_language:ResolvedLanguage,settings_link:Arc<Mutex<Option<Weak<SettingsCoordinator>>>>,
 pub navigation:NavigationController,published:watch::Sender<DesktopState>,
 receipt_started:AtomicBool,
 tray_preferences:AsyncMutex<Option<Error>>,
}
impl Desktop {
 pub fn new(config:Config,native:Arc<NativeBridge>,language:ResolvedLanguage,windows:WindowRequests)->Arc<Self>{
  let (launch,_)=watch::channel(false);let (published,_)=watch::channel(DesktopState{phase:Phase::Starting,events:BTreeMap::new(),last_error:None});
  Arc::new(Self{config,native,windows,io:BoundedIo::new(ResourceBudget::default()),phase:Mutex::new(Phase::Starting),components:Mutex::new(Components::default()),sessions:Mutex::new(BTreeMap::new()),next_owner:AtomicU64::new(1),requests:TaskTracker::new(),slots:RequestAdmission::new(),background:TaskTracker::new(),background_stop:CancellationToken::new(),boot_cancel:CancellationToken::new(),boot_gate:AsyncMutex::new(()),close_gate:AsyncMutex::new(()),shutting:AtomicBool::new(false),exit_ready:AtomicBool::new(false),launch,system_language:language,settings_link:Arc::new(Mutex::new(None)),navigation:NavigationController::new(),published,receipt_started:AtomicBool::new(false),tray_preferences:AsyncMutex::new(None)})
 }
 pub fn subscribe(&self)->watch::Receiver<DesktopState>{self.published.subscribe()}
 pub fn snapshot(&self)->DesktopState {self.published.borrow().clone()}
 fn publish_phase(&self,phase:Phase)->Result<()>{*self.phase.lock().map_err(|_|Error::invalid("host phase"))?=phase.clone();self.published.send_modify(|state|state.phase=phase);Ok(())}
 pub fn report(&self,error:Error){eprintln!("{error}");self.published.send_modify(|state|state.last_error=Some(error));}
 pub fn services(&self)->Result<Services>{
        let components = self.components.lock().map_err(|_| Error::invalid("host component state"))?;
        match (&components.monitor, &components.market, &components.settings, &components.tern) {
            (Some(monitor), Some(market), Some(settings), Some(tern)) => Ok(Services { monitor: monitor.clone(), market: market.clone(), settings: settings.clone(), tern: tern.clone() }),
            _ => Err(Error::new("OC_HOST_NOT_READY", "桌面服务尚未就绪 / Desktop services are not ready")),
        }
 }
 fn window_manager(&self)->Result<&WindowRequests>{Ok(&self.windows)}
 fn sessions(&self)->Result<Vec<Arc<Session>>>{Ok(self.sessions.lock().map_err(|_|Error::invalid("sessions"))?.values().cloned().collect())}
 pub async fn run(self:&Arc<Self>,mut native_events:mpsc::Receiver<Value>)->Result<()>{
        let host = self.clone();
        self.background.spawn(async move { loop {
            let event = tokio::select! { _ = host.background_stop.cancelled() => break, event = native_events.recv() => match event { Some(event) => event, None => { host.report(Error::new("OC_NATIVE_EVENTS_CLOSED", "原生事件连接已关闭 / Native event connection closed")); break; } } };
            if event["event"] == "applicationLaunched" { host.launch.send_replace(true); }
            if event["event"] == "updaterInstallRequested" { host.request_sparkle_install(); continue; }
            if event["event"] == "updaterChanged" {
                match crate::updates::decode(event["value"].clone()) {
                    Ok(snapshot) => if let Err(error) = host.emit("updates-changed", &snapshot) { host.report(error); },
                    Err(error) => host.report(error),
                }
                continue;
            }
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
  self.retry_startup().await.map(|_|())
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
 pub async fn retry_startup(self:&Arc<Self>)->Result<bool>{
  let _boot=self.boot_gate.lock().await;check_cancel(&self.boot_cancel)?;
  if matches!(*self.phase.lock().map_err(|_|Error::invalid("phase"))?,Phase::Running){return Ok(true);}
  self.config.prepare_profile(&self.io).await?;
  let initial=match read_settings(&self.io,&self.config.profile.join("settings.json")).await{
   Ok(value)=>value,Err(failure)=>{self.publish_phase(Phase::Recovery(failure.clone()))?;if self.config.headless&&!self.config.recovery_acceptance{return Err(Error::new("OC_SETTINGS_STARTUP",failure.details));}self.windows.ensure_recovery().await?;return Ok(false);}
  };
  let login=self.login_startup().await?;check_cancel(&self.boot_cancel)?;
  self.initialize_services(initial.clone(),login).await?;check_cancel(&self.boot_cancel)?;
  self.publish_phase(Phase::Running)?;
  if !login {self.windows.ensure_main(initial.window_bounds).await?;}
  for session in self.sessions()?{if session.view==View::Recovery{self.revoke(session.id).await?;}}
  self.windows.close_recovery().await?;Ok(true)
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
        let market_fixture_roots = market_fixture_roots(self.config.headless, self.config.development)?;
        let market = Marketplace::open(MarketplaceOptions { profile: self.config.profile.clone(), io: self.io.clone(), registry: monitor.registry(),
            worker: self.config.resources.join("oc-data-worker"), bundled: BundledAssets { directory: self.config.resources.join("plugin-market"), catalog_sha256: self.config.catalog_digest().into() },
            host_bundle: self.config.bundle.clone(), host_bundle_id: oc_installer::BUNDLE_ID.into(), app_version: env!("CARGO_PKG_VERSION").into(),
            enabled: Arc::new(move |section| enabled_monitor.enabled(section)), changed: Arc::new(move |snapshot| { market_changed.send_replace(snapshot); }),
            #[cfg(feature = "acceptance")] fixture_roots: market_fixture_roots,
        }, &self.boot_cancel).await?;
        self.components.lock().map_err(|_| Error::invalid("host components"))?.market = Some(market);
        let updates = crate::updates::decode(self.native.call("updaterStart", json!({"development": self.config.development})).await?)?;
        self.emit("updates-changed", &updates)?;
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
        self.watch(settings.subscribe(), "settings-changed", ""); self.watch(market_updates, "marketplace-changed", "");
        Ok(())
    }
    fn watch<T: Serialize + Clone + Send + Sync + 'static>(self: &Arc<Self>, mut receiver: watch::Receiver<T>, channel: &'static str, stream: &'static str) {
        let weak = Arc::downgrade(self); let stop = self.background_stop.clone();
        self.background.spawn(async move { loop {
            tokio::select! { _ = stop.cancelled() => break, change = receiver.changed() => if change.is_err() { break; } }
            let Some(host) = weak.upgrade() else { break; };
            if let Err(error) = host.emit_stream(channel, stream, &*receiver.borrow_and_update()) { host.report(error); }
        } });
    }
 fn emit<T:Serialize+?Sized>(&self,channel:&'static str,value:&T)->Result<()>{self.emit_stream(channel,"",value)}
 fn emit_stream<T:Serialize+?Sized>(&self,channel:&'static str,stream:&str,value:&T)->Result<()>{
  let value=serde_json::to_value(value).map_err(|_|Error::invalid("desktop state"))?;
  let key=if stream.is_empty(){channel.to_owned()}else{format!("{channel}:{stream}")};
  self.published.send_modify(|state|{state.events.insert(key,value);});Ok(())
 }
 pub async fn geometry(&self,bounds:oc_core::settings::WindowBounds)->Result<()>{self.services()?.settings.on_geometry(bounds).await}
 pub async fn blur(&self,owner:u64)->Result<()>{let session=self.session(owner)?;if session.view==View::Main {let services=self.services()?;services.settings.preview_glass(owner,None).await?;services.tern.cancel().await?;}Ok(())}
 pub async fn show_main(&self,target:Option<NavigationTarget>)->Result<()>{
  if self.config.headless{return Err(Error::new("OC_HEADLESS","无头实例不能显示窗口 / Headless instances cannot show windows"));}
  let services=self.services()?;if let Some(target)=target{self.navigation.put(target,&services.monitor.snapshot())?;}
  self.windows.ensure_main(services.settings.snapshot().await?.settings.window_bounds).await?;
  self.windows.show_main().await?;self.emit("monitor-navigation",&self.navigation.read()?)
 }
 pub fn request_quit(self:&Arc<Self>,code:i32){if self.shutting.swap(true,Ordering::AcqRel){return;}self.boot_cancel.cancel();let host=self.clone();tokio::spawn(async move{match host.shutdown().await{Ok(())=>{host.exit_ready.store(true,Ordering::Release);if let Err(error)=host.windows.request(HostWindowAction::Exit(code)).await{host.report(error);}},Err(error)=>{host.report(error);host.shutting.store(false,Ordering::Release);}}});}
 fn request_sparkle_install(self:&Arc<Self>){
  if self.shutting.swap(true,Ordering::AcqRel){return;}
  self.boot_cancel.cancel();let host=self.clone();
  tokio::spawn(async move {
   match host.shutdown().await {
    Ok(())=>{host.exit_ready.store(true,Ordering::Release);if let Err(error)=host.native.call("updaterResumeInstallation",json!({})).await{host.report(error);}},
    Err(error)=>{host.report(error);host.shutting.store(false,Ordering::Release);}
   }
  });
 }
 pub async fn quit_from_os(self:&Arc<Self>)->Result<()> {
  if self.exit_ready.load(Ordering::Acquire){return Ok(());}
  if !self.shutting.swap(true,Ordering::AcqRel){self.boot_cancel.cancel();self.shutdown().await?;self.exit_ready.store(true,Ordering::Release);return Ok(());}
  let mut state=self.subscribe();
  loop {if matches!(state.borrow().phase,Phase::Stopped){return Ok(());}state.changed().await.map_err(|_|Error::new("OC_SHUTDOWN_STATE","Shutdown state channel closed"))?;}
 }
    async fn shutdown(&self) -> Result<()> {
        let _close = self.close_gate.lock().await; let _boot = self.boot_gate.lock().await;
        *self.phase.lock().map_err(|_| Error::invalid("shutdown state"))? = Phase::Stopping;
        self.requests.close();
        *self.settings_link.lock().map_err(|_| Error::invalid("settings notification link"))? = None;
        let components = self.components.lock().map_err(|_| Error::invalid("host components"))?.clone();
        let result = async {
            let retain_native = self.native.call("updaterPrepareToQuit", json!({})).await?["retainContext"].as_bool().ok_or_else(|| Error::invalid("Sparkle quit response"))?;
            // Final geometry writes still apply collection preferences. Drain them before stopping plugins.
            if let Some(settings) = &components.settings { settings.close().await?; }
            for document in self.sessions()? {
                document.invalidate();
                if let Some(diagnostics) = &document.diagnostics { diagnostics.close().await?; }
                document.history.cancel().await?; document.schedule_detail.cancel().await?; document.events.cancel().await?;
            }
            if let Some(tern) = &components.tern { tern.close().await?; }
            if let Some(market) = &components.market { market.close().await?; }
            if let Some(monitor) = &components.monitor { monitor.stop().await?; }
            self.requests.wait().await;
            for document in self.sessions()? {
                document.tasks.wait().await;
                if document.native_registered.load(Ordering::Acquire) { self.native.revoke_owner(document.id).await?; document.native_registered.store(false, Ordering::Release); }
                self.sessions.lock().map_err(|_| Error::invalid("sessions"))?.remove(&document.id);
            }
            self.background_stop.cancel(); self.background.close(); self.background.wait().await;
            // Active Sparkle drivers and installation continuations live until
            // process termination, including installs scheduled for normal quit.
            if !retain_native { self.native.release().await?; }
            self.io.shutdown().await?;
            self.windows.close().await?;
            self.publish_phase(Phase::Stopped)?;
            Ok(())
        }.await;
        result
    }
 pub fn startup_failed(self:&Arc<Self>,error:Error){if let Err(failure)=self.publish_phase(Phase::Fault(error.clone())){self.report(failure);}self.report(error);self.request_quit(1);}
}

#[cfg(feature="acceptance")]
fn market_fixture_roots(headless:bool,development:bool)->Result<Vec<BundledAssets>>{
    #[derive(serde::Deserialize)]
    #[serde(rename_all="camelCase",deny_unknown_fields)]
    struct TrustedAsset{directory:std::path::PathBuf,catalog_sha256:String}
    let Some(raw)=std::env::var_os("OC_CHAN_ACCEPTANCE_MARKET_FIXTURES") else{return Ok(Vec::new());};
    if !headless||!development{return Err(Error::invalid("acceptance market fixture launch mode"));}
    let text=raw.into_string().map_err(|_|Error::invalid("acceptance fixture encoding"))?;
    if text.len()>64*1024{return Err(Error::limit("acceptance fixture bytes",64*1024,text.len()));}
    let roots:Vec<TrustedAsset>=serde_json::from_str(&text).map_err(|_|Error::invalid("acceptance fixtures"))?;
    if roots.is_empty()||roots.len()>16{return Err(Error::invalid("acceptance fixture count"));}
    roots.into_iter().map(|asset|{
        if !asset.directory.is_absolute()||asset.directory.as_os_str().len()>4096||asset.directory.components().any(|part|matches!(part,std::path::Component::ParentDir)){return Err(Error::invalid("acceptance fixture directory"));}
        let directory=std::fs::canonicalize(asset.directory).map_err(|error|Error::io("acceptance fixture directory",error))?;
        Ok(BundledAssets{directory,catalog_sha256:asset.catalog_sha256})
    }).collect()
}

impl Desktop {
 pub async fn hide(&self,view:View)->Result<()>{
  let mut failures=Vec::new();
  for session in self.sessions()?{
   if session.view!=view{continue;}
   if let Err(error)=session.history.cancel().await{failures.push(error);}
   if let Err(error)=session.schedule_detail.cancel().await{failures.push(error);}
   if let Err(error)=session.events.cancel().await{failures.push(error);}
   if let Some(diagnostics)=&session.diagnostics{if let Err(error)=diagnostics.cancel().await{failures.push(error);}}
   if let Err(error)=self.blur(session.id).await{failures.push(error);}
  }
  if failures.is_empty(){Ok(())}else{Err(Error::aggregate(failures))}
 }
}
