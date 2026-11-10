use super::*;
use std::sync::atomic::{AtomicBool,AtomicUsize,Ordering};

struct NativeState { system:Value, login:Value, glass:BTreeMap<u64,Material>, calls:Vec<&'static str>, fail_after:Option<&'static str>, fail_always:Option<&'static str>, approval:bool }
struct FakeNative { state:Mutex<NativeState> }
impl FakeNative {
    fn new()->Arc<Self>{Arc::new(Self{state:Mutex::new(NativeState{system:json!({"dark":false,"reduceTransparency":false,"increaseContrast":false,"glassSupported":true,"dockVisible":true,"preventSleep":false,"systemLanguage":"en"}),
        login:json!({"status":"not-registered","openAtLogin":false,"wasOpenedAtLogin":false,"launchEventObserved":true,"installed":true}),glass:BTreeMap::new(),calls:Vec::new(),fail_after:None,fail_always:None,approval:false})})}
}
impl SettingsNative for FakeNative {
    fn call(&self,command:&'static str,args:Value)->BoxFuture<'_,Result<Value>>{Box::pin(async move{
        let mut state=self.state.lock().unwrap();state.calls.push(command);
        let value=match command{
            "systemRead"=>state.system.clone(),
            "themeSet"=>{state.system["dark"]=json!(args["mode"]=="dark");state.system.clone()},
            "dockSet"=>{state.system["dockVisible"]=args["visible"].clone();state.system.clone()},
            "sleepSet"=>{state.system["preventSleep"]=args["enabled"].clone();json!({"preventSleep":state.system["preventSleep"]})},
            "glassSet"=>{let intensity=args["intensity"].as_f64().unwrap();let material=Material{intensity,dark:args["dark"].as_bool().unwrap()};state.glass.insert(args["window"].as_u64().unwrap(),material);json!({"active":intensity>0.0,"viewCount":u64::from(intensity>0.0)})},
            "loginRead"=>state.login.clone(),
            "loginSet"=>{let enabled=args["enabled"].as_bool().unwrap();let status=if !enabled{"not-registered"}else if state.approval{"requires-approval"}else{"enabled"};state.login["status"]=json!(status);state.login["openAtLogin"]=json!(status=="enabled");state.login.clone()},
            _=>return Err(error("TEST_UNEXPECTED_NATIVE_COMMAND")),
        };
        if state.fail_always==Some(command){return Err(error("TEST_NATIVE_FAILURE"));}
        if state.fail_after==Some(command){state.fail_after=None;return Err(error("TEST_NATIVE_FAILURE"));}Ok(value)
    })}
}
struct Fixture {
    coordinator:Arc<SettingsCoordinator>,native:Arc<FakeNative>,disk:Arc<Mutex<AppSettings>>,fail_write:Arc<AtomicBool>,writes:Arc<AtomicUsize>,permissions:Arc<AtomicUsize>,effects:Arc<Mutex<AppSettings>>,
}
async fn fixture(initial:AppSettings,login:bool,headless:bool)->Fixture{
    let native=FakeNative::new();if headless{native.state.lock().unwrap().system["dockVisible"]=json!(false);}
    let disk=Arc::new(Mutex::new(initial.clone()));let fail_write=Arc::new(AtomicBool::new(false));let writes=Arc::new(AtomicUsize::new(0));let permissions=Arc::new(AtomicUsize::new(0));let effects=Arc::new(Mutex::new(initial.clone()));
    let effect_state=effects.clone();let effect:SettingsEffect=Arc::new(move|settings|{let effect_state=effect_state.clone();Box::pin(async move{*effect_state.lock().unwrap()=settings;Ok(())})});
    let requests=permissions.clone();let engine=Arc::new(Engine{native:native.clone(),headless,development:false,login_startup:login,system_language:Mutex::new(ResolvedLanguage::English),effect,
        notifications:Arc::new(NotificationState::default),request_permission:Arc::new(move||{let requests=requests.clone();Box::pin(async move{requests.fetch_add(1,Ordering::SeqCst);Ok(NotificationState{permission:NotificationPermission::Authorized,..Default::default()})})}),sleep_changed:Arc::new(|_|Box::pin(async{Ok(())})),
        runtime:Mutex::new(Runtime{overrides:Overrides{dock:login,sleep:login},transition:None,appearance:None}),windows:Mutex::new(BTreeMap::new())});
    engine.apply(initial.clone()).await.unwrap();let effect_engine=engine.clone();let combined:SettingsEffect=Arc::new(move|settings|{let engine=effect_engine.clone();Box::pin(async move{engine.apply(settings).await})});
    let output=disk.clone();let failure=fail_write.clone();let count=writes.clone();let writer:SettingsWriter=Arc::new(move|_,settings|{let output=output.clone();let failure=failure.clone();let count=count.clone();Box::pin(async move{
        count.fetch_add(1,Ordering::SeqCst);if failure.load(Ordering::SeqCst){return Err(Error::new("ENOSPC","settings fixture storage full"));}*output.lock().unwrap()=settings;Ok(())
    })});
    let store=SettingsStore::with_writer(PathBuf::from("/private/tmp/settings-fixture.json"),initial.clone(),combined,writer);
    let coordinator=SettingsCoordinator::assemble(store,engine,initial).await.unwrap();Fixture{coordinator,native,disk,fail_write,writes,permissions,effects}
}
#[tokio::test]async fn login_start_overrides_do_not_persist_during_other_updates(){
    let initial=AppSettings{show_dock:true,prevent_sleep:true,..Default::default()};let fixture=fixture(initial,true,false).await;
    let snapshot=fixture.coordinator.snapshot().await.unwrap();assert!(!snapshot.settings.show_dock);assert!(!snapshot.settings.prevent_sleep);
    assert!(fixture.coordinator.update(SettingsPatch{language:Some(Language::Chinese),..Default::default()}).await.unwrap().ok);
    assert!(fixture.disk.lock().unwrap().show_dock);assert!(fixture.disk.lock().unwrap().prevent_sleep);assert_eq!(fixture.writes.load(Ordering::SeqCst),1);
    let result=fixture.coordinator.update(SettingsPatch{show_dock:Some(true),..Default::default()}).await.unwrap();assert!(result.ok);assert!(result.snapshot.unwrap().settings.show_dock);assert_eq!(fixture.writes.load(Ordering::SeqCst),1);
    assert!(!fixture.native.state.lock().unwrap().system["preventSleep"].as_bool().unwrap());fixture.coordinator.close().await.unwrap();
}
#[tokio::test]async fn persistence_failure_restores_native_and_injected_effects(){
    let fixture=fixture(AppSettings::default(),false,false).await;fixture.fail_write.store(true,Ordering::SeqCst);
    let result=fixture.coordinator.update(SettingsPatch{appearance:Some(Appearance::Dark),prevent_sleep:Some(true),plugins:Some(PluginPatch{agents:Some(false),..Default::default()}),..Default::default()}).await.unwrap();
    assert!(!result.ok);assert_eq!(result.error.unwrap().reason,SettingsFailureReason::StorageFull);
    let native=fixture.native.state.lock().unwrap();assert_eq!(native.system["dark"],false);assert_eq!(native.system["preventSleep"],false);drop(native);
    assert!(fixture.effects.lock().unwrap().plugins.agents);assert_eq!(fixture.disk.lock().unwrap().appearance,Appearance::System);
    fixture.fail_write.store(false,Ordering::SeqCst);fixture.coordinator.close().await.unwrap();
}
#[tokio::test]async fn failed_theme_write_invalidates_cached_mode_before_rollback(){
    let fixture=fixture(AppSettings::default(),false,false).await;fixture.native.state.lock().unwrap().fail_after=Some("themeSet");
    let result=fixture.coordinator.update(SettingsPatch{appearance:Some(Appearance::Dark),..Default::default()}).await.unwrap();assert!(!result.ok);
    assert_eq!(fixture.native.state.lock().unwrap().system["dark"],false);assert_eq!(fixture.writes.load(Ordering::SeqCst),0);fixture.coordinator.close().await.unwrap();
}
#[tokio::test]async fn accessibility_overrides_preview_and_restores_saved_material(){
    let fixture=fixture(AppSettings::default(),false,false).await;fixture.coordinator.register_window(1,42).await.unwrap();fixture.coordinator.preview_glass(1,Some(95.0)).await.unwrap();
    assert_eq!(fixture.native.state.lock().unwrap().glass[&42].intensity,95.0);
    fixture.native.state.lock().unwrap().system["reduceTransparency"]=json!(true);fixture.coordinator.native_event(json!({"event":"systemChanged"})).await.unwrap();assert_eq!(fixture.native.state.lock().unwrap().glass[&42].intensity,0.0);
    fixture.coordinator.preview_glass(1,None).await.unwrap();fixture.native.state.lock().unwrap().system["reduceTransparency"]=json!(false);fixture.coordinator.native_event(json!({"event":"systemChanged"})).await.unwrap();
    assert_eq!(fixture.native.state.lock().unwrap().glass[&42].intensity,65.0);fixture.coordinator.unregister_window(1).await.unwrap();assert_eq!(fixture.native.state.lock().unwrap().glass[&42].intensity,0.0);fixture.coordinator.close().await.unwrap();
}
#[tokio::test]async fn headless_blocks_permissions_login_and_dock_mutations(){
    let mut initial=AppSettings::default();initial.notifications.enabled=true;let fixture=fixture(initial,false,true).await;
    assert!(fixture.coordinator.request_notification_permission().await.is_err());assert!(!fixture.coordinator.update_login_item(true).await.unwrap().ok);
    assert!(!fixture.coordinator.update(SettingsPatch{show_dock:Some(true),..Default::default()}).await.unwrap().ok);
    assert!(!fixture.coordinator.update(SettingsPatch{prevent_sleep:Some(true),..Default::default()}).await.unwrap().ok);
    assert_eq!(fixture.permissions.load(Ordering::SeqCst),0);assert!(!fixture.native.state.lock().unwrap().calls.iter().any(|call|matches!(*call,"loginSet"|"dockSet"|"sleepSet")));fixture.coordinator.close().await.unwrap();
}
#[tokio::test]async fn disabled_notifications_do_not_request_permission(){
    let fixture=fixture(AppSettings::default(),false,false).await;assert!(fixture.coordinator.request_notification_permission().await.is_err());assert_eq!(fixture.permissions.load(Ordering::SeqCst),0);fixture.coordinator.close().await.unwrap();
}
#[tokio::test]async fn login_approval_is_not_reported_as_enabled_and_failed_write_rolls_back(){
    let fixture=fixture(AppSettings::default(),false,false).await;fixture.native.state.lock().unwrap().approval=true;
    let approval=fixture.coordinator.update_login_item(true).await.unwrap();assert!(approval.ok);assert_eq!(approval.state.status,LoginStatus::RequiresApproval);assert_eq!(approval.state.open_at_login,Some(false));
    fixture.native.state.lock().unwrap().fail_after=Some("loginSet");let failed=fixture.coordinator.update_login_item(false).await.unwrap();assert!(!failed.ok);assert!(!failed.rollback_failed);assert_eq!(failed.state.status,LoginStatus::RequiresApproval);fixture.coordinator.close().await.unwrap();
}
#[tokio::test]async fn geometry_failure_is_visible_and_retry_uses_latest_host_bounds(){
    let fixture=fixture(AppSettings::default(),false,false).await;fixture.fail_write.store(true,Ordering::SeqCst);
    fixture.coordinator.on_geometry(WindowBounds{x:10.0,y:20.0,width:1000.0,height:700.0}).await.unwrap();
    assert!(!fixture.coordinator.retry_geometry().await.unwrap().ok);assert!(fixture.coordinator.snapshot().await.unwrap().geometry_error.is_some());
    let latest=WindowBounds{x:30.0,y:40.0,width:1200.0,height:800.0};fixture.coordinator.on_geometry(latest).await.unwrap();fixture.fail_write.store(false,Ordering::SeqCst);
    assert!(fixture.coordinator.retry_geometry().await.unwrap().ok);assert_eq!(fixture.disk.lock().unwrap().window_bounds,Some(latest));assert!(fixture.coordinator.snapshot().await.unwrap().geometry_error.is_none());fixture.coordinator.close().await.unwrap();
}
#[tokio::test]async fn close_flushes_latest_geometry_and_rejects_new_operations(){
    let fixture=fixture(AppSettings::default(),false,false).await;
    fixture.coordinator.on_geometry(WindowBounds{x:1.0,y:2.0,width:1000.0,height:700.0}).await.unwrap();let final_bounds=WindowBounds{x:9.0,y:8.0,width:1100.0,height:720.0};fixture.coordinator.on_geometry(final_bounds).await.unwrap();
    fixture.coordinator.close().await.unwrap();assert_eq!(fixture.disk.lock().unwrap().window_bounds,Some(final_bounds));assert_eq!(fixture.writes.load(Ordering::SeqCst),1);
    assert!(fixture.coordinator.update(SettingsPatch::default()).await.is_err());assert!(fixture.coordinator.snapshot().await.is_err());
}
#[tokio::test]async fn native_locale_change_publishes_actual_system_language(){
    let fixture=fixture(AppSettings::default(),false,false).await;let mut watcher=fixture.coordinator.subscribe();
    fixture.native.state.lock().unwrap().system["systemLanguage"]=json!("zh-CN");fixture.coordinator.native_event(json!({"event":"systemChanged"})).await.unwrap();watcher.changed().await.unwrap();assert_eq!(watcher.borrow().resolved_language,ResolvedLanguage::Chinese);
    fixture.coordinator.update(SettingsPatch{language:Some(Language::En),..Default::default()}).await.unwrap();assert_eq!(fixture.coordinator.snapshot().await.unwrap().resolved_language,ResolvedLanguage::English);fixture.coordinator.close().await.unwrap();
}
#[test]fn missing_launch_evidence_remains_explicit(){
    let state=parse_login(json!({"status":"not-registered","openAtLogin":false,"wasOpenedAtLogin":null,"launchEventObserved":false,"installed":true}),false).unwrap();assert!(state.details.is_some());assert!(!state.was_opened_at_login);
    assert!(parse_login(json!({"status":"enabled","openAtLogin":false,"wasOpenedAtLogin":false,"launchEventObserved":true,"installed":true}),false).is_err());
}
#[tokio::test]async fn rollback_failure_is_fatal_and_not_published_as_success(){
    let fixture=fixture(AppSettings::default(),false,false).await;fixture.native.state.lock().unwrap().fail_always=Some("themeSet");
    let failure=fixture.coordinator.update(SettingsPatch{appearance:Some(Appearance::Dark),..Default::default()}).await.unwrap_err();assert_eq!(failure.code,"OC_SETTINGS_ROLLBACK");assert!(fixture.coordinator.snapshot().await.is_err());assert_eq!(fixture.writes.load(Ordering::SeqCst),0);
    assert!(fixture.coordinator.close().await.is_err());
}
#[tokio::test]async fn dropped_caller_does_not_interrupt_an_authorized_transaction(){
    let fixture=fixture(AppSettings::default(),false,false).await;let entered=Arc::new(tokio::sync::Notify::new());let (release,waiting)=oneshot::channel();
    let started=entered.clone();let coordinator=fixture.coordinator.clone();
    let caller=tokio::spawn(async move{coordinator.run(move|this|async move{started.notify_one();waiting.await.map_err(|_|error("TEST_RELEASE"))?;this.update_inner(SettingsPatch{language:Some(Language::Chinese),..Default::default()}).await}).await});
    entered.notified().await;caller.abort();let coordinator=fixture.coordinator.clone();let closing=tokio::spawn(async move{coordinator.close().await});
    release.send(()).unwrap();closing.await.unwrap().unwrap();assert_eq!(fixture.disk.lock().unwrap().language,Language::Chinese);assert_eq!(fixture.writes.load(Ordering::SeqCst),1);
}
#[tokio::test]async fn operation_admission_never_exceeds_sixteen(){
    let fixture=fixture(AppSettings::default(),false,false).await;let gate=fixture.coordinator.gate.lock().await;let mut callers=Vec::new();
    for _ in 0..MAX_PENDING_UPDATES{let coordinator=fixture.coordinator.clone();callers.push(tokio::spawn(async move{coordinator.snapshot().await}));}
    tokio::time::timeout(Duration::from_secs(2),async{while fixture.coordinator.slots.available_permits()!=0{tokio::task::yield_now().await;}}).await.unwrap();
    assert_eq!(fixture.coordinator.snapshot().await.unwrap_err().code,"OC_SETTINGS_BUSY");drop(gate);
    for caller in callers{caller.await.unwrap().unwrap();}fixture.coordinator.close().await.unwrap();
}
