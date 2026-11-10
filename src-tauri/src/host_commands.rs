use super::*;
use oc_core::{diagnostics::{Diagnostics, DiagnosticsOptions, ReportMetadata, build_report}, settings::SettingsPatch};
use serde::{Deserialize, Deserializer};
use tauri::ipc::InvokeResponseBody;
use crate::{documents::{Document, Interest}, ipc::{decode, empty, reply}};

#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Frame { owner: u64, args: Value }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Interests { interest: Interest }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Sequence { sequence: u64 }
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Refresh { #[serde(default, deserialize_with="present")] section: Option<MonitorSection> }
#[derive(Deserialize)] #[serde(rename_all="camelCase", deny_unknown_fields)] struct Source { source_id: String }
#[derive(Deserialize)] #[serde(rename_all="camelCase", deny_unknown_fields)] struct Agent { agent_id: String }
#[derive(Deserialize)] #[serde(rename_all="camelCase", deny_unknown_fields)] struct History { job_id: String, offset: usize }
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

impl Host {
    fn authorize_phase(&self, view: View) -> Result<()> {
        if self.shutting.load(Ordering::Acquire) { return Err(Error::new("OC_HOST_CLOSING", "应用正在退出 / Application is closing")); }
        match &*self.phase.lock().map_err(|_| Error::invalid("host phase"))? {
            Phase::Running if view != View::Recovery => Ok(()),
            Phase::Recovery(_) if view == View::Recovery => Ok(()),
            Phase::Fault(error) => Err(error.clone()),
            _ => Err(Error::new("OC_HOST_PHASE", "当前应用状态不允许此窗口操作 / Operation is unavailable in this application phase")),
        }
    }
    async fn register(&self, view: View, key: &str) -> Result<InvokeResponseBody> {
        let _gate = self.documents.gates[index(view)].lock().await;
        self.authorize_phase(view)?;
        self.revoke_locked(view).await?;
        let identity = self.window_manager()?.identity(view).await?;
        if identity.view != view || identity.document_key != key { return Err(Error::invalid("registered document identity")); }
        let (id, epoch) = self.documents.allocate(view)?;
        let diagnostics = if view == View::Main {
            let monitor = self.services()?.monitor; let io = self.io.clone(); let os_release = self.config.os_release.clone();
            Some(Diagnostics::new(DiagnosticsOptions { io: self.io.clone(), native: self.native.clone(), headless: self.config.headless, owner: id,
                build: Arc::new(move || build_report(&monitor.snapshot(), &io.resources().snapshot(), &ReportMetadata {
                    version: env!("CARGO_PKG_VERSION").into(), tauri: tauri::VERSION.into(), platform: "darwin".into(), arch: "arm64".into(), os_release: os_release.clone(),
                })),
            }))
        } else { None };
        let window = self.app.get_webview_window(view.label()).ok_or_else(|| Error::invalid("registered window"))?;
        let visible = window.is_visible().map_err(|_| Error::invalid("window visibility"))? && !window.is_minimized().map_err(|_| Error::invalid("window minimization"))?;
        let document = Arc::new(Document::new(id, view, epoch, identity.document_key, visible, diagnostics));
        self.documents.insert(document.clone())?;
        let result = async {
            self.native.register_owner(id, identity.address)?;
            document.native_registered.store(true, Ordering::Release);
            if view != View::Recovery {
                document.settings_registered.store(true, Ordering::Release);
                self.services()?.settings.register_window(id, identity.address).await?;
            }
            check_cancel(&document.cancel)?;
            self.authorize_phase(view)?;
            document.ready.store(true, Ordering::Release);
            reply(&json!({"owner":id,"view":view,"headless":self.config.headless}))
        }.await;
        if let Err(error) = result {
            document.invalidate();
            return match self.revoke_locked(view).await { Ok(()) => Err(error), Err(cleanup) => Err(Error::aggregate(vec![error, cleanup])) };
        }
        result
    }
    pub async fn invoke(self: &Arc<Self>, view: View, key: &str, command: &str, body: Value) -> Result<InvokeResponseBody> {
        self.authorize_phase(view)?;
        if command == "desktop_register" { empty(&body)?; return self.register(view, key).await; }
        let Frame { owner, args } = decode(body)?;
        let document = self.documents.current(view, owner, key)?;
        let owner_bound = matches!(command, "monitor_schedule_history" | "monitor_cancel_schedule_history" | "monitor_events" | "monitor_cancel_events"
            | "monitor_focus_agent_in_tern" | "settings_preview_glass" | "diagnostics_generate" | "diagnostics_copy" | "diagnostics_save" | "diagnostics_cancel");
        let _owner_task = owner_bound.then(|| document.tasks.token());
        check_cancel(&document.cancel)?;
        if matches!(command, "desktop_committed" | "monitor_snapshot" | "monitor_cancel_schedule_history" | "monitor_cancel_events" | "monitor_navigation"
            | "diagnostics_generate" | "diagnostics_cancel" | "settings_snapshot" | "settings_retry_geometry" | "settings_request_notification_permission" | "settings_accessibility_state"
            | "updates_snapshot" | "updates_check" | "updates_download" | "updates_cancel" | "updates_install" | "updates_open_release_notes"
            | "marketplace_snapshot" | "marketplace_check" | "marketplace_cancel" | "recovery_snapshot" | "recovery_retry" | "recovery_quit") { empty(&args)?; }
        #[cfg(feature="acceptance")]
        self.acceptance.check_command(command)?;
        match command {
            "desktop_committed" => {
                if !document.committed.swap(true, Ordering::AcqRel) {
                    println!("{}", json!({"rendererReady":{"view":view,"owner":owner,"entry":view.label()}}));
                    if view == View::Main { self.start_receipt(document.clone()); }
                }
                return reply(&());
            },
            "desktop_interest" => { let input: Interests = decode(args)?; input.interest.validate(view)?;
                *document.interest.lock().map_err(|_| Error::invalid("subscriptions"))? = input.interest;
                document.listening.store(true, Ordering::Release); return reply(&()); },
            "desktop_ack" => { let input: Sequence = decode(args)?; if let Some(delivery) = document.acknowledge(input.sequence)? { self.deliver(&document, delivery)?; } return reply(&()); },
            "recovery_snapshot" => return self.recovery_snapshot(),
            "recovery_retry" => { return if self.retry_startup().await? { reply(&json!({"ready":true})) }
                else { let snapshot = self.recovery_value()?; reply(&json!({"ready":false,"snapshot":snapshot})) }; },
            "recovery_quit" => { self.request_quit(0); return reply(&()); },
            _ => {},
        }
        let services = self.services()?;
        match command {
            "monitor_snapshot" => reply(&services.monitor.snapshot()),
            "monitor_refresh" => { let input: Refresh = decode(args)?; services.monitor.refresh(input.section).await?; reply(&()) },
            "monitor_retry_source" => { let input: Source = decode(args)?; services.monitor.retry_source(&input.source_id).await?; reply(&()) },
            "monitor_focus_agent_in_tern" => { let input: Agent = decode(args)?; let error = services.tern.focus(&input.agent_id).await.err().map(|error| error.to_string()); reply(&json!({"error":error})) },
            "monitor_schedule_history" => { let input: History = decode(args)?;
                let result = document.history.run(&document.cancel, |cancel| services.monitor.history(&input.job_id, input.offset, cancel)).await?; reply(&result) },
            "monitor_cancel_schedule_history" => { document.history.cancel().await?; reply(&()) },
            "monitor_events" => { let input: Events = decode(args)?;
                #[cfg(feature="acceptance")]
                let observation = self.acceptance.begin_query(&input.query)?;
                let result = document.events.run(&document.cancel, |cancel| services.monitor.query_events(input.query, cancel)).await;
                #[cfg(feature="acceptance")]
                observation.finish(result.as_ref().err().is_some_and(Error::is_cancelled));
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
            "updates_snapshot" => reply(&services.updates.snapshot()),
            "updates_check" => reply(&services.updates.check().await?),
            "updates_download" => reply(&services.updates.download().await?),
            "updates_cancel" => reply(&services.updates.cancel().await?),
            "updates_install" => { let prepared = services.updates.prepare_install().await?; let snapshot = reply(&services.updates.snapshot()); self.request_install(prepared); snapshot },
            "updates_open_release_notes" => {
                if self.config.headless { return Err(Error::new("OC_HEADLESS", "无头实例不能打开外部页面 / Headless instances cannot open external pages")); }
                self.native.open_release_notes(oc_core::updates::RELEASES_URL, &document.cancel).await?; reply(&())
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
    fn recovery_snapshot(&self) -> Result<InvokeResponseBody> { reply(&self.recovery_value()?) }
}
