use super::*;
use oc_core::{diagnostics::{Diagnostics,DiagnosticsOptions,ReportMetadata,build_report},settings::SettingsPatch};
use serde::{Deserialize,Deserializer};
fn decode<T:serde::de::DeserializeOwned>(value:Value)->Result<T>{serde_json::from_value(value).map_err(|error|Error::new("OC_ACTION_INPUT",error.to_string()))}
fn reply<T:Serialize+?Sized>(value:&T)->Result<Value>{serde_json::to_value(value).map_err(|error|Error::new("OC_ACTION_OUTPUT",error.to_string()))}
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Sequence { sequence: u64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Refresh { #[serde(default, deserialize_with="present")] section: Option<MonitorSection> }
#[derive(Deserialize)] #[serde(rename_all="camelCase", deny_unknown_fields)] struct Source { source_id: String }
#[derive(Deserialize)] #[serde(rename_all="camelCase", deny_unknown_fields)] struct Agent { agent_id: String }
#[derive(Deserialize)] #[serde(rename_all="camelCase", deny_unknown_fields)] struct History { job_id: String, offset: usize }
#[derive(Deserialize)] #[serde(rename_all="camelCase", deny_unknown_fields)] struct ScheduleDetailInput { job_id: String, identity: String }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Events { query: EventQuery }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Identifier { id: String }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Patch { patch: SettingsPatch }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Preview { #[serde(deserialize_with="nullable")] intensity: Option<f64> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Enabled { enabled: bool }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct ShowMain { #[serde(default, deserialize_with="present")] target: Option<NavigationTarget> }
#[derive(Deserialize)] #[serde(rename_all="lowercase")] enum PermissionTarget { Accessibility, Notifications }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct PermissionSettings { target: PermissionTarget }
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(input: D) -> std::result::Result<Option<T>, D::Error> { T::deserialize(input).map(Some) }
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(input: D) -> std::result::Result<Option<T>, D::Error> { Option::<T>::deserialize(input) }
impl Desktop {
 pub(super) fn session(&self,owner:u64)->Result<Arc<Session>>{self.sessions.lock().map_err(|_|Error::invalid("sessions"))?.get(&owner).cloned().ok_or_else(||Error::invalid("view owner"))}
 fn authorize(&self,view:View)->Result<()>{
  if self.shutting.load(Ordering::Acquire){return Err(Error::new("OC_HOST_CLOSING","应用正在退出 / Application is closing"));}
  match &*self.phase.lock().map_err(|_|Error::invalid("phase"))?{Phase::Running if view!=View::Recovery=>Ok(()),Phase::Recovery(_) if view==View::Recovery=>Ok(()),Phase::Fault(error)=>Err(error.clone()),_=>Err(Error::new("OC_HOST_PHASE","当前状态不支持此操作 / Operation unavailable in this phase"))}
 }
 pub async fn register(self:&Arc<Self>,view:View,address:u64)->Result<u64>{
  self.authorize(view)?;
  let owner=self.next_owner.fetch_add(1,Ordering::AcqRel);if owner==0||owner==u64::MAX{return Err(Error::invalid("owner sequence"));}
  let diagnostics=if view==View::Main{let monitor=self.services()?.monitor;let io=self.io.clone();let os_release=self.config.os_release.clone();Some(Diagnostics::new(DiagnosticsOptions{io:self.io.clone(),native:self.native.clone(),headless:self.config.headless,owner,build:Arc::new(move||build_report(&monitor.snapshot(),&io.resources().snapshot(),&ReportMetadata{version:env!("CARGO_PKG_VERSION").into(),gpui:"0.2.2".into(),platform:"darwin".into(),arch:std::env::consts::ARCH.into(),os_release:os_release.clone()}))}))}else{None};
  let session=Arc::new(Session::new(owner,view,diagnostics));
  {let mut sessions=self.sessions.lock().map_err(|_|Error::invalid("sessions"))?;if sessions.len()>=8||sessions.values().any(|item|item.view==view){return Err(Error::invalid("duplicate window owner"));}sessions.insert(owner,session.clone());}
  let result=async{self.native.register_owner(owner,address)?;session.native_registered.store(true,Ordering::Release);if view!=View::Recovery{session.settings_registered.store(true,Ordering::Release);self.services()?.settings.register_window(owner,address).await?;}self.authorize(view)?;Ok(owner)}.await;
  match result{Ok(owner)=>Ok(owner),Err(error)=>match self.revoke(owner).await{Ok(())=>Err(error),Err(cleanup)=>Err(Error::aggregate(vec![error,cleanup]))}}
 }
 pub async fn revoke(&self,owner:u64)->Result<()>{
  let session=self.session(owner)?;session.invalidate();let mut errors=Vec::new();
  if let Some(diagnostics)=&session.diagnostics{if let Err(error)=diagnostics.close().await{errors.push(error);}}
  if let Err(error)=session.history.cancel().await{errors.push(error);}if let Err(error)=session.events.cancel().await{errors.push(error);}
  if let Err(error)=session.schedule_detail.cancel().await{errors.push(error);}
  let components=self.components.lock().map_err(|_|Error::invalid("components"))?.clone();
  if session.view==View::Main{if let Some(tern)=&components.tern{if let Err(error)=tern.cancel().await{errors.push(error);}}}
  session.tasks.wait().await;
  if session.settings_registered.load(Ordering::Acquire){if let Some(settings)=components.settings{match settings.unregister_window(owner).await{Ok(())=>session.settings_registered.store(false,Ordering::Release),Err(error)=>errors.push(error)}}}
  if session.native_registered.load(Ordering::Acquire){match self.native.revoke_owner(owner).await{Ok(())=>session.native_registered.store(false,Ordering::Release),Err(error)=>errors.push(error)}}
  if errors.is_empty(){self.sessions.lock().map_err(|_|Error::invalid("sessions"))?.remove(&owner);Ok(())}else{Err(Error::aggregate(errors))}
 }
 pub async fn action(self:&Arc<Self>,owner:u64,command:&str,args:Value)->Result<Value>{
  let document=self.session(owner)?;self.authorize(document.view)?;
  if !document.view.permits(command){return Err(Error::new("OC_VIEW_CAPABILITY","当前窗口不允许此操作 / Operation is not permitted for this view"));}
  let _admission=self.slots.acquire(command)?;let _request=self.requests.token();check_cancel(&document.cancel)?;
  match command{
   "recovery_snapshot"=>return self.recovery_value(),
   "recovery_retry"=>return if self.retry_startup().await?{reply(&json!({"ready":true}))}else{reply(&json!({"ready":false,"snapshot":self.recovery_value()?}))},
   "recovery_quit"=>{self.request_quit(0);return reply(&());},_=>{}
  }
  let _owner=document.tasks.token();
  let services=self.services()?;
        match command {
            "tray_preferences_snapshot" => reply(&self.tray_preferences_snapshot().await?),
            "tray_preferences_save" => reply(&self.tray_preferences_save(decode(args)?).await?),
            "monitor_snapshot" => reply(&services.monitor.snapshot()),
            "monitor_refresh" => { let input: Refresh = decode(args)?; services.monitor.refresh(input.section).await?; reply(&()) },
            "monitor_retry_source" => { let input: Source = decode(args)?; services.monitor.retry_source(&input.source_id).await?; reply(&()) },
            "monitor_focus_agent_in_tern" => { let input: Agent = decode(args)?; let error = services.tern.focus(&input.agent_id).await.err().map(|error| error.to_string()); reply(&json!({"error":error})) },
            "monitor_schedule_history" => { let input: History = decode(args)?;
                let result = document.history.run(&document.cancel, |cancel| services.monitor.history(&input.job_id, input.offset, cancel)).await?; reply(&result) },
            "monitor_cancel_schedule_history" => { document.history.cancel().await?; reply(&()) },
            "monitor_schedule_detail" => { let input: ScheduleDetailInput = decode(args)?;
                let result = document.schedule_detail.run(&document.cancel, |cancel| services.monitor.schedule_detail(&input.job_id, &input.identity, cancel)).await?; reply(&result) },
            "monitor_cancel_schedule_detail" => { document.schedule_detail.cancel().await?; reply(&()) },
            "monitor_events" => { let input: Events = decode(args)?;
                let result = document.events.run(&document.cancel, |cancel| services.monitor.query_events(input.query, cancel)).await;
                reply(&result?) },
            "monitor_cancel_events" => { document.events.cancel().await?; reply(&()) },
            "monitor_navigation" => reply(&self.navigation.read()?),
            "monitor_acknowledge_navigation" => { let input: Sequence = decode(args)?; self.navigation.acknowledge(input.sequence)?; reply(&()) },
            "diagnostics_generate" => reply(&document.diagnostics.as_ref().ok_or_else(|| Error::invalid("diagnostic owner"))?.generate().await),
            "diagnostics_copy" => { let input: Identifier = decode(args)?; reply(&document.diagnostics.as_ref().ok_or_else(|| Error::invalid("diagnostic owner"))?.copy(&input.id).await) },
            "diagnostics_save" => { let input: Identifier = decode(args)?; reply(&document.diagnostics.as_ref().ok_or_else(|| Error::invalid("diagnostic owner"))?.save(&input.id).await) },
            "diagnostics_cancel" => { document.diagnostics.as_ref().ok_or_else(|| Error::invalid("diagnostic owner"))?.cancel().await?; reply(&()) },
            "settings_snapshot" => reply(&services.settings.snapshot().await?),
            "settings_update" => { let input: Patch = decode(args)?; reply(&services.settings.update(input.patch).await?) },
            "settings_retry_geometry" => reply(&services.settings.retry_geometry().await?),
            "settings_preview_glass" => { let input: Preview = decode(args)?; services.settings.preview_glass(owner, input.intensity).await?; reply(&()) },
            "settings_update_login_item" => { let input: Enabled = decode(args)?; reply(&services.settings.update_login_item(input.enabled).await?) },
            "settings_request_notification_permission" => reply(&services.settings.request_notification_permission().await?),
            "settings_accessibility_state" => {
                if self.config.headless { return reply(&json!({"availability":"headless","status":"unknown","details":"无头实例不查询辅助功能授权 / Accessibility authorization is unavailable in headless mode"})); }
                reply(&self.native.call("accessibilityRead", json!({})).await?)
            },
            "settings_open_permission_settings" => {
                let input: PermissionSettings = decode(args)?;
                if self.config.headless { return Err(Error::new("OC_HEADLESS", "无头实例不能打开系统设置 / Headless instances cannot open System Settings")); }
                let target = match input.target { PermissionTarget::Accessibility => "accessibility", PermissionTarget::Notifications => "notifications" };
                self.native.call("openPermissionSettings", json!({"target":target})).await?; reply(&())
            },
            "settings_show_main_window" => { let input: ShowMain = decode(args)?; self.show_main(input.target).await?; reply(&()) },
            "updates_snapshot" => reply(&crate::updates::decode(self.native.call("updaterRead", json!({})).await?)?),
            "updates_check" => reply(&crate::updates::decode(self.native.call("updaterCheck", json!({})).await?)?),
            "updates_set_automatic_checks" => {
                let input: crate::updates::AutomaticChecks = decode(args)?;
                reply(&crate::updates::decode(self.native.call("updaterSetAutomaticChecks", json!({"enabled": input.enabled})).await?)?)
            },
            "updates_open_release_notes" => {
                if self.config.headless { return Err(Error::new("OC_HEADLESS", "无头实例不能打开外部页面 / Headless instances cannot open external pages")); }
                self.native.open_release_notes("https://github.com/Zixiaobowen/oc-chan/releases", &document.cancel).await?; reply(&())
            },
            "marketplace_snapshot" => reply(&services.market.snapshot()),
            "marketplace_check" => reply(&services.market.check().await?),
            "marketplace_install" => { let input: Identifier = decode(args)?; reply(&services.market.install(&input.id).await?) },
            "marketplace_update" => { let input: Identifier = decode(args)?; reply(&services.market.update(&input.id).await?) },
            "marketplace_uninstall" => { let input: Identifier = decode(args)?; reply(&services.market.uninstall(&input.id).await?) },
            "marketplace_cancel" => { services.market.cancel().await?; reply(&()) },
            _ => Err(Error::invalid("desktop command")),
        }
 }
    fn recovery_value(&self) -> Result<Value> {
        match &*self.phase.lock().map_err(|_| Error::invalid("recovery state"))? {
            Phase::Recovery(failure) => Ok(json!({"failure":failure,"language":self.system_language})),
            _ => Err(Error::new("OC_RECOVERY_INACTIVE", "启动恢复已结束 / Startup recovery is no longer active")),
        }
    }
}

#[cfg(test)]
mod schedule_detail_input_tests {
    use super::*;
    #[test]
    fn schedule_detail_requires_selection_identity() {
        assert!(decode::<ScheduleDetailInput>(json!({"jobId":"hermes-job:one"})).is_err());
        assert!(decode::<ScheduleDetailInput>(json!({"jobId":"hermes-job:one","identity":null})).is_err());
        let input = decode::<ScheduleDetailInput>(json!({"jobId":"hermes-job:one","identity":"selected-identity"})).unwrap();
        assert_eq!(input.identity,"selected-identity");
    }
}
