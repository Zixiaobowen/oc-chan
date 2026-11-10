use std::{collections::BTreeMap, future::Future, path::PathBuf, sync::{Arc,Mutex,Weak}, time::Duration};
use futures_util::future::BoxFuture;
use serde::Deserialize;
use serde_json::{json,Value};
use tokio::{sync::{Mutex as AsyncMutex,Semaphore,oneshot,watch},task::JoinHandle};
use tokio_util::{sync::CancellationToken,task::TaskTracker};
use oc_core::{error::{Error,Result},io::BoundedIo,settings::*};
use crate::native::NativeBridge;

type NotificationReader=Arc<dyn Fn()->NotificationState+Send+Sync>;
type PermissionRequest=Arc<dyn Fn()->BoxFuture<'static,Result<NotificationState>>+Send+Sync>;
type SleepChanged=Arc<dyn Fn(bool)->BoxFuture<'static,Result<()>>+Send+Sync>;
pub struct SettingsOptions {
    pub io:BoundedIo, pub path:PathBuf, pub initial:AppSettings, pub native:Arc<NativeBridge>,
    pub headless:bool, pub development:bool, pub login_startup:bool, pub system_language:ResolvedLanguage,
    pub effect:SettingsEffect, pub notifications:NotificationReader, pub request_permission:PermissionRequest, pub sleep_changed:SleepChanged,
}
trait SettingsNative:Send+Sync {fn call(&self,command:&'static str,args:Value)->BoxFuture<'_,Result<Value>>;}
impl SettingsNative for NativeBridge {fn call(&self,command:&'static str,args:Value)->BoxFuture<'_,Result<Value>>{Box::pin(NativeBridge::call(self,command,args))}}
#[derive(Clone,Copy,Debug,Default,PartialEq)]struct Overrides { dock:bool, sleep:bool }
struct Transition { previous:AppSettings, before:Overrides, after:Overrides }
struct Runtime { overrides:Overrides, transition:Option<Transition>, appearance:Option<Appearance> }
#[derive(Clone,Copy,Debug,PartialEq)]struct Material { intensity:f64, dark:bool }
#[derive(Clone)]struct Window { address:u64, preview:Option<f64>, applied:Option<Material> }
#[derive(Clone,Debug,Deserialize)]
#[serde(rename_all="camelCase")]
struct SystemRead { dark:bool,reduce_transparency:bool,increase_contrast:bool,glass_supported:bool,dock_visible:bool,prevent_sleep:bool,system_language:ResolvedLanguage }
struct Engine {
    native:Arc<dyn SettingsNative>, headless:bool, development:bool, login_startup:bool, system_language:Mutex<ResolvedLanguage>,
    effect:SettingsEffect, notifications:NotificationReader, request_permission:PermissionRequest, sleep_changed:SleepChanged,
    runtime:Mutex<Runtime>, windows:Mutex<BTreeMap<u64,Window>>,
}
#[derive(Default)]struct Geometry { latest:Option<WindowBounds>,revision:u64,saved:u64,error:Option<SettingsUpdateFailure> }
pub struct SettingsCoordinator {
    store:SettingsStore, engine:Arc<Engine>, gate:AsyncMutex<()>, admission:Mutex<bool>, slots:Arc<Semaphore>, tasks:TaskTracker,
    published:watch::Sender<SettingsSnapshot>, geometry:Mutex<Geometry>, geometry_signal:watch::Sender<u64>,
    geometry_stop:CancellationToken, geometry_worker:Mutex<Option<JoinHandle<Result<()>>>>, fatal:Mutex<Option<Error>>, close_gate:AsyncMutex<()>, closed:Mutex<bool>,
}
fn error(code:&str)->Error {Error::new(code,format!("桌面设置操作失败 / Desktop settings operation failed: {code}"))}
fn native_decode<T:serde::de::DeserializeOwned>(value:Value)->Result<T>{serde_json::from_value(value).map_err(|_|error("OC_SETTINGS_NATIVE_PROTOCOL"))}
fn language(settings:&AppSettings,system:ResolvedLanguage)->ResolvedLanguage {match settings.language{Language::System=>system,Language::Chinese=>ResolvedLanguage::Chinese,Language::En=>ResolvedLanguage::English}}
fn effective_flags(settings:&AppSettings,headless:bool,overrides:Overrides)->(bool,bool){(!headless&&!overrides.dock&&settings.show_dock,!headless&&!overrides.sleep&&settings.prevent_sleep)}
fn material(system:&SystemRead,settings:&AppSettings,preview:Option<f64>)->Material{
    Material{dark:system.dark,intensity:if system.glass_supported&&!system.reduce_transparency&&!system.increase_contrast{preview.unwrap_or(settings.glass_intensity)}else{0.0}}
}
fn notification_state(settings:&AppSettings,mut state:NotificationState)->NotificationState{
    if settings.notifications.enabled&&!settings.plugins.events{state.phase=NotificationPhase::EventsDisabled;}state
}
fn unknown_login(availability:LoginAvailability,details:Option<String>)->LoginItemState{
    LoginItemState{availability,status:LoginStatus::Unknown,open_at_login:None,was_opened_at_login:false,details}
}
impl Engine {
    async fn system(&self)->Result<SystemRead>{
        let system:SystemRead=native_decode(self.native.call("systemRead",json!({})).await?)?;
        *self.system_language.lock().map_err(|_|error("OC_SETTINGS_STATE"))?=system.system_language;Ok(system)
    }
    fn overrides(&self,settings:&AppSettings)->Result<Overrides>{
        let runtime=self.runtime.lock().map_err(|_|error("OC_SETTINGS_STATE"))?;
        Ok(match &runtime.transition{Some(transition) if settings==&transition.previous=>transition.before,Some(transition)=>transition.after,None=>runtime.overrides})
    }
    async fn apply(&self,settings:AppSettings)->Result<()>{
        // SettingsStore invokes this same composition for both forward and rollback.
        (self.effect)(settings.clone()).await?;
        self.apply_native(&settings).await
    }
    async fn apply_native(&self,settings:&AppSettings)->Result<()>{
        let appearance=self.runtime.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.appearance;
        let mut system=if appearance!=Some(settings.appearance){
            let mode=match settings.appearance{Appearance::System=>"system",Appearance::Light=>"light",Appearance::Dark=>"dark"};
            self.runtime.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.appearance=None;
            let result=native_decode(self.native.call("themeSet",json!({"mode":mode})).await?);
            match result{Ok(system)=>{self.runtime.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.appearance=Some(settings.appearance);system},Err(error)=>{self.runtime.lock().map_err(|_|self::error("OC_SETTINGS_STATE"))?.appearance=None;return Err(error);}}
        }else{self.system().await?};
        let (dock,sleep)=effective_flags(settings,self.headless,self.overrides(settings)?);
        if self.headless {
            if system.dock_visible||system.prevent_sleep{return Err(error("OC_SETTINGS_HEADLESS_READBACK"));}
        }else{
            if system.dock_visible!=dock{system=native_decode(self.native.call("dockSet",json!({"visible":dock})).await?)?;if system.dock_visible!=dock{return Err(error("OC_SETTINGS_DOCK_READBACK"));}}
            if system.prevent_sleep!=sleep{let value=self.native.call("sleepSet",json!({"enabled":sleep})).await?;if value["preventSleep"].as_bool()!=Some(sleep){return Err(error("OC_SETTINGS_SLEEP_READBACK"));}}
            system=self.system().await?;
            if system.dock_visible!=dock||system.prevent_sleep!=sleep{return Err(error("OC_SETTINGS_EFFECT_READBACK"));}
        }
        self.apply_materials(settings,&system).await
    }
    async fn apply_materials(&self,settings:&AppSettings,system:&SystemRead)->Result<()>{
        let windows:Vec<(u64,Option<f64>)>=self.windows.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.iter().map(|(owner,window)|(*owner,window.preview)).collect();
        for (owner,preview) in windows{self.set_material(owner,material(system,settings,preview)).await?;}Ok(())
    }
    async fn set_material(&self,owner:u64,material:Material)->Result<()>{
        let window=self.windows.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.get(&owner).cloned().ok_or_else(||error("OC_SETTINGS_WINDOW"))?;
        if window.applied==Some(material){return Ok(());}
        let outcome=self.native.call("glassSet",json!({"window":window.address,"intensity":material.intensity,"dark":material.dark})).await.and_then(|value|{
            if value["active"].as_bool()!=Some(material.intensity>0.0)||value["viewCount"].as_u64()!=Some(u64::from(material.intensity>0.0)){return Err(error("OC_SETTINGS_GLASS_READBACK"));}Ok(())
        });
        let mut windows=self.windows.lock().map_err(|_|error("OC_SETTINGS_STATE"))?;
        let current=windows.get_mut(&owner).filter(|current|current.address==window.address).ok_or_else(||error("OC_SETTINGS_WINDOW"))?;
        current.applied=if outcome.is_ok(){Some(material)}else{None};outcome
    }
    async fn strict_login(&self)->Result<LoginItemState>{
        if self.headless||self.development{return Ok(unknown_login(LoginAvailability::Development,None));}
        let value=self.native.call("loginRead",json!({})).await?;
        parse_login(value,self.login_startup)
    }
    async fn login(&self)->LoginItemState{
        match self.strict_login().await{Ok(state)=>state,Err(error)=>unknown_login(LoginAvailability::Available,Some(error.message))}
    }
}
fn parse_login(value:Value,known_login_startup:bool)->Result<LoginItemState>{
    let installed=value["installed"].as_bool().ok_or_else(||error("OC_LOGIN_INVALID_STATUS"))?;
    let observed=value["launchEventObserved"].as_bool().ok_or_else(||error("OC_LOGIN_INVALID_STATUS"))?;
    let opened=value["openAtLogin"].as_bool().ok_or_else(||error("OC_LOGIN_INVALID_STATUS"))?;
    let status=match value["status"].as_str(){Some("not-registered")=>LoginStatus::NotRegistered,Some("enabled")=>LoginStatus::Enabled,Some("requires-approval")=>LoginStatus::RequiresApproval,Some("not-found")=>LoginStatus::NotFound,_=>return Err(error("OC_LOGIN_INVALID_STATUS"))};
    if opened!=(status==LoginStatus::Enabled){return Err(error("OC_LOGIN_INVALID_STATUS"));}
    let was_opened=if observed{value["wasOpenedAtLogin"].as_bool().ok_or_else(||error("OC_LOGIN_INVALID_STATUS"))?}else{
        if !value.get("wasOpenedAtLogin").is_some_and(Value::is_null){return Err(error("OC_LOGIN_INVALID_STATUS"));}known_login_startup
    };
    Ok(LoginItemState{availability:if installed{LoginAvailability::Available}else{LoginAvailability::NotInstalled},status,open_at_login:Some(opened),was_opened_at_login:was_opened,
        details:(!observed&&!known_login_startup).then(||"未观察到启动 Apple event，登录启动来源未知 / Launch Apple event was not observed; login launch origin is unknown".into())})
}
impl SettingsCoordinator {
    pub async fn new(options:SettingsOptions)->Result<Arc<Self>>{
        options.initial.validate()?;
        let engine=Arc::new(Engine{native:options.native,headless:options.headless,development:options.development,login_startup:options.login_startup,system_language:Mutex::new(options.system_language),
            effect:options.effect,notifications:options.notifications,request_permission:options.request_permission,sleep_changed:options.sleep_changed,
            runtime:Mutex::new(Runtime{overrides:Overrides{dock:options.login_startup,sleep:options.login_startup},transition:None,appearance:None}),windows:Mutex::new(BTreeMap::new())});
        if let Err(failure)=engine.apply(options.initial.clone()).await{return Err(cleanup_startup(&engine,&options.initial,failure).await);}
        let effect_engine=engine.clone();let effect:SettingsEffect=Arc::new(move|settings|{let engine=effect_engine.clone();Box::pin(async move{engine.apply(settings).await})});
        let store=SettingsStore::new(options.io,options.path,options.initial.clone(),effect);
        match Self::assemble(store,engine.clone(),options.initial.clone()).await{Ok(coordinator)=>Ok(coordinator),Err(failure)=>Err(cleanup_startup(&engine,&options.initial,failure).await)}
    }
    async fn assemble(store:SettingsStore,engine:Arc<Engine>,settings:AppSettings)->Result<Arc<Self>>{
        let system=engine.system().await?;let login=engine.login().await;
        let initial=make_snapshot(&engine,settings,&system,login,None,(engine.notifications)())?;
        let (published,_)=watch::channel(initial);let (geometry_signal,geometry_rx)=watch::channel(0);
        let this=Arc::new(Self{store,engine,gate:AsyncMutex::new(()),admission:Mutex::new(true),slots:Arc::new(Semaphore::new(MAX_PENDING_UPDATES)),tasks:TaskTracker::new(),published,
            geometry:Mutex::new(Geometry::default()),geometry_signal,geometry_stop:CancellationToken::new(),geometry_worker:Mutex::new(None),fatal:Mutex::new(None),close_gate:AsyncMutex::new(()),closed:Mutex::new(false)});
        let weak=Arc::downgrade(&this);let stop=this.geometry_stop.clone();
        *this.geometry_worker.lock().map_err(|_|error("OC_SETTINGS_STATE"))?=Some(tokio::spawn(geometry_loop(weak,geometry_rx,stop)));
        Ok(this)
    }
    pub fn subscribe(&self)->watch::Receiver<SettingsSnapshot>{self.published.subscribe()}
    async fn run<T,F,Fut>(self:&Arc<Self>,work:F)->Result<T> where T:Send+'static,F:FnOnce(Arc<Self>)->Fut+Send+'static,Fut:Future<Output=Result<T>>+Send+'static{
        let (tx,rx)=oneshot::channel();
        {
            let admission=self.admission.lock().map_err(|_|error("OC_SETTINGS_STATE"))?;
            if !*admission{return Err(error("OC_SETTINGS_CLOSED"));}
            if let Some(fatal)=self.fatal.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.clone(){return Err(fatal);}
            let permit=self.slots.clone().try_acquire_owned().map_err(|_|error("OC_SETTINGS_BUSY"))?;let this=self.clone();
            self.tasks.spawn(async move{
                let _permit=permit;let _gate=this.gate.lock().await;
                let fatal=this.fatal.lock().map_err(|_|error("OC_SETTINGS_STATE")).map(|fatal|fatal.clone());
                let result=match fatal{Ok(None)=>work(this.clone()).await,Ok(Some(fatal))=>Err(fatal),Err(error)=>Err(error)};
                if let Err(failure)=&result{if failure.code=="OC_SETTINGS_ROLLBACK"{if let Ok(mut fatal)=this.fatal.lock(){*fatal=Some(failure.clone());}}}
                if let Err(result)=tx.send(result){if let Err(error)=result{eprintln!("abandoned settings operation: {error}");}}
            });
        }
        rx.await.map_err(|_|error("OC_SETTINGS_TASK"))?
    }
    pub async fn snapshot(self:&Arc<Self>)->Result<SettingsSnapshot>{self.run(|this|async move{this.refresh().await}).await}
    async fn refresh(&self)->Result<SettingsSnapshot>{
        let settings=self.store.value().await?;let system=self.engine.system().await?;let login=self.engine.login().await;
        let geometry_error=self.geometry.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.error.clone();
        let snapshot=make_snapshot(&self.engine,settings,&system,login,geometry_error,(self.engine.notifications)())?;
        self.published.send_if_modified(|current|{if *current==snapshot{false}else{*current=snapshot.clone();true}});Ok(snapshot)
    }
    pub fn notifications_changed(&self,state:NotificationState)->Result<()>{
        if !*self.admission.lock().map_err(|_|error("OC_SETTINGS_STATE"))?{return Err(error("OC_SETTINGS_CLOSED"));}
        self.published.send_if_modified(|snapshot|{let state=notification_state(&snapshot.settings,state);if snapshot.notifications==state{false}else{snapshot.notifications=state;true}});Ok(())
    }
    pub async fn update(self:&Arc<Self>,patch:SettingsPatch)->Result<SettingsUpdateResult>{self.run(move|this|async move{this.update_inner(patch).await}).await}
    async fn update_inner(&self,patch:SettingsPatch)->Result<SettingsUpdateResult>{
        if self.engine.headless&&(patch.show_dock==Some(true)||patch.prevent_sleep==Some(true)){return Ok(SettingsUpdateResult::error(failure_from_error(&error("OC_SETTINGS_HEADLESS"),self.store.path())));}
        let previous=self.store.value().await?;let mut next=previous.clone();
        if let Err(error)=next.apply(patch.clone()){return Ok(SettingsUpdateResult::error(failure_from_error(&error,self.store.path())));}
        let (before,after)={let mut runtime=self.engine.runtime.lock().map_err(|_|error("OC_SETTINGS_STATE"))?;let before=runtime.overrides;let mut after=before;
            if patch.show_dock.is_some(){after.dock=false;}if patch.prevent_sleep.is_some(){after.sleep=false;}
            runtime.transition=Some(Transition{previous:previous.clone(),before,after});(before,after)};
        // Saved settings always replace an in-progress visual preview.
        for window in self.engine.windows.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.values_mut(){window.preview=None;}
        let mut outcome=self.store.update(patch).await;
        if outcome.is_ok()&&next==previous&&before!=after{
            self.engine.runtime.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.overrides=after;
            self.engine.runtime.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.transition=None;
            if let Err(error)=self.engine.apply_native(&next).await{
                self.engine.runtime.lock().map_err(|_|self::error("OC_SETTINGS_STATE"))?.overrides=before;
                outcome=match self.engine.apply_native(&previous).await{Ok(())=>Err(error),Err(rollback)=>{let mut fatal=Error::aggregate(vec![error,rollback]);fatal.code="OC_SETTINGS_ROLLBACK".into();Err(fatal)}};
            }
        }
        {let mut runtime=self.engine.runtime.lock().map_err(|_|error("OC_SETTINGS_STATE"))?;runtime.overrides=if outcome.is_ok(){after}else{before};runtime.transition=None;}
        match outcome{
            Ok(_)=>{let settings=self.store.value().await?;self.engine.apply_materials(&settings,&self.engine.system().await?).await?;Ok(SettingsUpdateResult::ok(self.refresh().await?))},
            Err(error) if error.code=="OC_SETTINGS_ROLLBACK"=>Err(error),
            Err(error)=>{self.refresh().await?;Ok(SettingsUpdateResult::error(failure_from_error(&error,self.store.path())))},
        }
    }
    pub async fn register_window(self:&Arc<Self>,owner:u64,address:u64)->Result<()>{self.run(move|this|async move{
        if owner==0||address==0{return Err(Error::invalid("settings window"));}
        {let mut windows=this.engine.windows.lock().map_err(|_|error("OC_SETTINGS_STATE"))?;if windows.len()>=8||windows.contains_key(&owner)||windows.values().any(|window|window.address==address){return Err(error("OC_SETTINGS_WINDOW"));}windows.insert(owner,Window{address,preview:None,applied:None});}
        let settings=this.store.value().await?;let system=this.engine.system().await?;
        if let Err(failure)=this.engine.set_material(owner,material(&system,&settings,None)).await{
            match this.engine.set_material(owner,Material{intensity:0.0,dark:system.dark}).await{
                Ok(())=>{this.engine.windows.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.remove(&owner);return Err(failure);},
                Err(cleanup)=>return Err(Error::aggregate(vec![failure,Error::cleanup("window glass",cleanup)])),
            }
        }Ok(())
    }).await}
    pub async fn unregister_window(self:&Arc<Self>,owner:u64)->Result<()>{self.run(move|this|async move{
        this.engine.set_material(owner,Material{intensity:0.0,dark:false}).await?;this.engine.windows.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.remove(&owner);Ok(())
    }).await}
    pub async fn preview_glass(self:&Arc<Self>,owner:u64,intensity:Option<f64>)->Result<()>{self.run(move|this|async move{
        if intensity.is_some_and(|value|!value.is_finite()||value.fract()!=0.0||!(0.0..=100.0).contains(&value)){return Err(Error::invalid("glass preview"));}
        let settings=this.store.value().await?;let system=this.engine.system().await?;
        let old={let mut windows=this.engine.windows.lock().map_err(|_|error("OC_SETTINGS_STATE"))?;let window=windows.get_mut(&owner).ok_or_else(||error("OC_SETTINGS_WINDOW"))?;let old=window.preview;window.preview=intensity;old};
        if let Err(failure)=this.engine.set_material(owner,material(&system,&settings,intensity)).await{
            this.engine.windows.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.get_mut(&owner).ok_or_else(||error("OC_SETTINGS_WINDOW"))?.preview=old;
            if let Err(rollback)=this.engine.set_material(owner,material(&system,&settings,old)).await{let mut fatal=Error::aggregate(vec![failure,rollback]);fatal.code="OC_SETTINGS_ROLLBACK".into();return Err(fatal);}return Err(failure);
        }Ok(())
    }).await}
    pub async fn request_notification_permission(self:&Arc<Self>)->Result<NotificationState>{self.run(|this|async move{
        if this.engine.headless{return Err(error("OC_SETTINGS_HEADLESS"));}
        let settings=this.store.value().await?;if !settings.notifications.enabled||!settings.plugins.events{return Err(error("OC_NOTIFICATION_DISABLED"));}
        let state=(this.engine.request_permission)().await?;this.notifications_changed(state.clone())?;Ok(notification_state(&settings,state))
    }).await}
    pub async fn native_event(self:&Arc<Self>,envelope:Value)->Result<()>{self.run(move|this|async move{
        if envelope.get("error").is_some(){return Err(error("OC_SETTINGS_NATIVE_EVENT"));}
        let event=envelope["event"].as_str().ok_or_else(||error("OC_SETTINGS_NATIVE_PROTOCOL"))?;
        match event{
            "systemSleeping"=>(this.engine.sleep_changed)(true).await?,
            "systemAwake"=>(this.engine.sleep_changed)(false).await?,
            "systemChanged"|"applicationLaunched"=>{},
            _=>return Err(error("OC_SETTINGS_NATIVE_EVENT")),
        }
        let settings=this.store.value().await?;let system=this.engine.system().await?;this.engine.apply_materials(&settings,&system).await?;this.refresh().await?;Ok(())
    }).await}
    pub async fn update_login_item(self:&Arc<Self>,enabled:bool)->Result<LoginItemUpdateResult>{self.run(move|this|async move{
        let before=this.engine.login().await;
        if before.availability!=LoginAvailability::Available||before.status==LoginStatus::Unknown{return Ok(LoginItemUpdateResult{ok:false,details:Some(before.details.clone().unwrap_or_else(||error("OC_LOGIN_UNAVAILABLE").message)),state:before,rollback_failed:false});}
        if login_applied(&before,enabled){return Ok(LoginItemUpdateResult{ok:true,state:before,details:None,rollback_failed:false});}
        let forward=async{this.engine.native.call("loginSet",json!({"enabled":enabled})).await?;let after=this.engine.strict_login().await?;if !login_applied(&after,enabled){return Err(error("OC_LOGIN_NOT_APPLIED"));}Ok(after)}.await;
        let result=match forward{
            Ok(state)=>LoginItemUpdateResult{ok:true,state,details:None,rollback_failed:false},
            Err(failure)=>{
                let mut state=this.engine.login().await;let mut failures=vec![failure];let mut rollback_failed=false;
                if state.status!=before.status||state.open_at_login!=before.open_at_login{
                    let rollback=async{this.engine.native.call("loginSet",json!({"enabled":matches!(before.status,LoginStatus::Enabled|LoginStatus::RequiresApproval)})).await?;let restored=this.engine.strict_login().await?;
                        if restored.status!=before.status||restored.open_at_login!=before.open_at_login{return Err(error("OC_LOGIN_ROLLBACK_FAILED"));}Ok(restored)}.await;
                    match rollback{Ok(restored)=>state=restored,Err(error)=>{rollback_failed=true;failures.push(error);state=this.engine.login().await;}}
                }
                LoginItemUpdateResult{ok:false,state,details:Some(Error::aggregate(failures).message),rollback_failed}
            }
        };
        this.refresh().await?;Ok(result)
    }).await}
    pub async fn on_geometry(&self,bounds:WindowBounds)->Result<()>{
        if !bounds.validate(){return Err(Error::invalid("window geometry"));}
        let admission=self.admission.lock().map_err(|_|error("OC_SETTINGS_STATE"))?;if !*admission{return Err(error("OC_SETTINGS_CLOSED"));}
        let mut geometry=self.geometry.lock().map_err(|_|error("OC_SETTINGS_STATE"))?;if geometry.latest==Some(bounds){return Ok(());}
        geometry.revision=geometry.revision.checked_add(1).ok_or_else(||error("OC_SETTINGS_GEOMETRY_SEQUENCE"))?;geometry.latest=Some(bounds);self.geometry_signal.send_replace(geometry.revision);Ok(())
    }
    pub async fn retry_geometry(self:&Arc<Self>)->Result<SettingsUpdateResult>{self.run(|this|async move{this.persist_geometry(true).await}).await}
    async fn persist_geometry(&self,required:bool)->Result<SettingsUpdateResult>{
        let (bounds,revision,saved,failed)={let geometry=self.geometry.lock().map_err(|_|error("OC_SETTINGS_STATE"))?;(geometry.latest,geometry.revision,geometry.saved,geometry.error.is_some())};
        let Some(bounds)=bounds else{if required{return Ok(SettingsUpdateResult::error(failure_from_error(&error("OC_SETTINGS_GEOMETRY_UNAVAILABLE"),self.store.path())));}return Ok(SettingsUpdateResult::ok(self.refresh().await?));};
        if revision==saved&&!failed{return Ok(SettingsUpdateResult::ok(self.refresh().await?));}
        let outcome=self.store.update(SettingsPatch{window_bounds:Some(Some(bounds)),..Default::default()}).await;
        {let mut geometry=self.geometry.lock().map_err(|_|error("OC_SETTINGS_STATE"))?;match &outcome{Ok(_)=>{geometry.saved=revision;geometry.error=None;},Err(error)=>geometry.error=Some(failure_from_error(error,self.store.path()))}}
        match outcome{Ok(_)=>Ok(SettingsUpdateResult::ok(self.refresh().await?)),Err(error) if error.code=="OC_SETTINGS_ROLLBACK"=>Err(error),Err(error)=>{self.refresh().await?;Ok(SettingsUpdateResult::error(failure_from_error(&error,self.store.path())))}}
    }
    pub async fn close(self:&Arc<Self>)->Result<()>{
        let _close=self.close_gate.lock().await;if *self.closed.lock().map_err(|_|error("OC_SETTINGS_STATE"))?{return Ok(());}
        *self.admission.lock().map_err(|_|error("OC_SETTINGS_STATE"))?=false;self.geometry_stop.cancel();self.tasks.close();
        let worker=self.geometry_worker.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.take();let mut failures=Vec::new();
        if let Some(worker)=worker{match worker.await{Ok(Ok(()))=>{},Ok(Err(error))=>failures.push(error),Err(_)=>failures.push(error("OC_SETTINGS_GEOMETRY_TASK"))}}
        self.tasks.wait().await;let _gate=self.gate.lock().await;
        match self.persist_geometry(false).await{Ok(result) if !result.ok=>{if let Some(failure)=result.error{failures.push(Error::new("OC_SETTINGS_GEOMETRY",failure.details));}},Ok(_)=>{},Err(error)=>failures.push(error)}
        let owners:Vec<u64>=self.engine.windows.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.keys().copied().collect();
        for owner in owners{match self.engine.set_material(owner,Material{intensity:0.0,dark:false}).await{Ok(())=>{self.engine.windows.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.remove(&owner);},Err(error)=>failures.push(Error::cleanup("window glass",error))}}
        if !self.engine.headless{match self.engine.native.call("sleepSet",json!({"enabled":false})).await{Ok(value) if value["preventSleep"]==false=>{},Ok(_)=>failures.push(error("OC_SETTINGS_SLEEP_READBACK")),Err(error)=>failures.push(Error::cleanup("sleep assertion",error))}}
        if failures.is_empty(){*self.closed.lock().map_err(|_|error("OC_SETTINGS_STATE"))?=true;Ok(())}else{Err(Error::aggregate(failures))}
    }
}
fn login_applied(state:&LoginItemState,enabled:bool)->bool{if enabled{state.status==LoginStatus::RequiresApproval||(state.status==LoginStatus::Enabled&&state.open_at_login==Some(true))}else{state.status==LoginStatus::NotRegistered&&state.open_at_login==Some(false)}}
fn make_snapshot(engine:&Engine,mut settings:AppSettings,system:&SystemRead,login_item:LoginItemState,geometry_error:Option<SettingsUpdateFailure>,notifications:NotificationState)->Result<SettingsSnapshot>{
    // Expose the runtime switches while retaining original persistent preferences
    // in SettingsStore. Unrelated edits must never persist a login-start override.
    settings.show_dock=system.dock_visible;settings.prevent_sleep=system.prevent_sleep;
    let system_language=*engine.system_language.lock().map_err(|_|error("OC_SETTINGS_STATE"))?;
    Ok(SettingsSnapshot{resolved_theme:if system.dark{ResolvedTheme::Dark}else{ResolvedTheme::Light},resolved_language:language(&settings,system_language),platform:"darwin".into(),
        liquid_glass:LiquidGlassState{available:system.glass_supported,reduced_transparency:system.reduce_transparency,increased_contrast:system.increase_contrast},geometry_error,login_item,
        notifications:notification_state(&settings,notifications),settings})
}
async fn geometry_loop(weak:Weak<SettingsCoordinator>,mut changes:watch::Receiver<u64>,stop:CancellationToken)->Result<()>{
    loop{
        tokio::select!{_ = stop.cancelled()=>return Ok(()),changed=changes.changed()=>{if changed.is_err(){return Ok(());}}}
        loop{tokio::select!{_ = stop.cancelled()=>return Ok(()),changed=changes.changed()=>{if changed.is_err(){return Ok(());}},_ = tokio::time::sleep(Duration::from_millis(500))=>break}}
        let Some(this)=weak.upgrade()else{return Ok(())};if stop.is_cancelled(){return Ok(());}
        let permit=tokio::select!{_ = stop.cancelled()=>return Ok(()),permit=this.slots.clone().acquire_owned()=>permit.map_err(|_|error("OC_SETTINGS_CLOSED"))?};
        let _gate=this.gate.lock().await;if stop.is_cancelled(){return Ok(());}
        let outcome=this.persist_geometry(false).await;drop(permit);
        if let Err(failure)=outcome{
            let visible=failure_from_error(&failure,this.store.path());
            this.geometry.lock().map_err(|_|error("OC_SETTINGS_STATE"))?.error=Some(visible.clone());
            this.published.send_modify(|snapshot|snapshot.geometry_error=Some(visible));
            if failure.code=="OC_SETTINGS_ROLLBACK"{*this.fatal.lock().map_err(|_|error("OC_SETTINGS_STATE"))?=Some(failure.clone());return Err(failure);}
        }
    }
}
async fn cleanup_startup(engine:&Engine,initial:&AppSettings,failure:Error)->Error{
    let mut errors=vec![failure];let mut disabled=initial.clone();
    disabled.plugins=PluginSettings{agents:false,schedules:false,system:false,events:false};disabled.notifications.enabled=false;
    if let Err(error)=(engine.effect)(disabled).await{errors.push(Error::cleanup("initial settings effects",error));}
    if !engine.headless{match engine.native.call("sleepSet",json!({"enabled":false})).await{Ok(value) if value["preventSleep"]==false=>{},Ok(_)=>errors.push(error("OC_SETTINGS_SLEEP_READBACK")),Err(error)=>errors.push(Error::cleanup("initial sleep assertion",error))}}
    Error::aggregate(errors)
}
#[cfg(test)]#[path="settings_tests.rs"]mod tests;
