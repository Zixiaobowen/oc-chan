mod input;
mod pages;
mod preferences;
mod labels;
use gpui::{prelude::*, *};
use oc_core::{model::*, settings::*, marketplace::MarketplaceSnapshot, updates::UpdateSnapshot};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};
use crate::{host::Desktop, topology::{TopologyView, TopologyEvent}};
use input::TextInput;

#[derive(Clone, Copy, PartialEq)] enum Mode { Main, Tray, Recovery }
#[derive(Clone)] enum Action {
    Navigate(NavigationTarget), Command(&'static str, Value), Patch(Value), Pause, Sidebar,
    Filter(&'static str, usize), History(usize), EventsApply, EventsClear, EventsNext, EventsPrevious,
    CloseDetail, Confirm(&'static str,String), CancelConfirm, AcceptConfirm, Subscribe(NavigationTarget),
    TrayPanel(usize), QuietSave, Glass(bool),
}
use crate::topology::style::Palette;
struct Request { generation:u64, busy:bool, error:Option<String> }
#[derive(serde::Deserialize)] struct DiagnosticPreview {id:String,#[serde(flatten)] content:oc_core::diagnostics::ReportContent}
#[derive(serde::Deserialize)] #[serde(tag="status",rename_all="lowercase")] enum DiagnosticReply {Ready{preview:DiagnosticPreview},Copied,Saved,Cancelled,Error{reason:String,details:String}}

struct PanelMotion { from:f32, to:f32, started:std::time::Instant }
impl PanelMotion {
    fn value(&self,now:std::time::Instant)->f32{let t=(now.saturating_duration_since(self.started).as_secs_f32()/0.2).clamp(0.,1.);self.from+(self.to-self.from)*(1.-(1.-t).powi(3))}
    fn active(&self,now:std::time::Instant)->bool{now.saturating_duration_since(self.started)<std::time::Duration::from_millis(200)&&self.from!=self.to}
}
pub struct RootView {
    host:Arc<Desktop>, owner:u64, mode:Mode, focus:FocusHandle,
    page:AppPage, monitor:MonitorSnapshot, settings:Option<SettingsSnapshot>, market:Option<MarketplaceSnapshot>, updates:Option<UpdateSnapshot>,
    topology:Entity<TopologyView>, search:Entity<TextInput>, source_search:Entity<TextInput>, quiet_start:Entity<TextInput>,quiet_end:Entity<TextInput>,
    selection:Option<NavigationTarget>, history:Option<ScheduleHistory>, event_page:Option<EventPage>, event_query:EventQuery,event_stack:Vec<EventQuery>,
    filters:BTreeMap<&'static str,usize>, requests:BTreeMap<&'static str,Request>,
    paused:bool, visible:bool, latest:BTreeMap<String,Value>, applied:BTreeMap<String,Value>,
    confirmation:Option<(&'static str,String)>, diagnostic:Option<DiagnosticPreview>, notice:Option<String>, error:Option<String>, recovery:Option<Value>,
    tray_panels:[bool;5], scrolls:Vec<ScrollHandle>, subscriptions:Vec<Subscription>, watch_task:Option<Task<()>>,
    interaction_pending: bool,
    tray_excluded:Vec<String>,
    sidebar_drag:Option<f32>,
    page_searches:BTreeMap<usize,String>, page_selections:BTreeMap<usize,NavigationTarget>, history_offset:usize,
    pending_events:Option<(EventQuery,Vec<EventQuery>)>, deferred_queries:BTreeMap<&'static str,Value>,
    quiet_saved:Option<(String,String)>, glass_input:Entity<TextInput>, theme_preview:Option<SettingsSnapshot>,
    preview_tail:Option<tokio::sync::oneshot::Receiver<()>>,
    preview_pending:Option<Value>,
    glass_preview:Option<f64>,
    stable_focus:std::cell::RefCell<BTreeMap<String,(FocusHandle,u64)>>,
    focus_frame:std::cell::Cell<u64>, inert_detail:std::cell::Cell<bool>, building_detail:std::cell::Cell<bool>,focus_overflow:std::cell::Cell<bool>,
    pending_focus:Option<FocusHandle>, detail_scroll:ScrollHandle,
    source_jump:std::rc::Rc<std::cell::Cell<bool>>,
    navigation_sequence:Option<u64>,
    target_bounds:std::rc::Rc<std::cell::RefCell<BTreeMap<String,Bounds<Pixels>>>>,
    panel_motion:PanelMotion, detail_exit:Option<NavigationTarget>,
    #[cfg(feature="acceptance")]
    button_bounds:std::rc::Rc<std::cell::RefCell<BTreeMap<String,Bounds<Pixels>>>>,
    #[cfg(feature="acceptance")]
    button_overflow:std::rc::Rc<std::cell::Cell<bool>>,
    #[cfg(feature="acceptance")]
    input_bounds:std::rc::Rc<std::cell::RefCell<BTreeMap<String,Bounds<Pixels>>>>,
}
impl RootView {
    pub fn new(host:Arc<Desktop>,owner:u64,window:&mut Window,cx:&mut Context<Self>)->Self {Self::create(host,owner,Mode::Main,window,cx)}
    pub fn tray(host:Arc<Desktop>,owner:u64,window:&mut Window,cx:&mut Context<Self>)->Self {Self::create(host,owner,Mode::Tray,window,cx)}
    pub fn recovery(host:Arc<Desktop>,owner:u64,window:&mut Window,cx:&mut Context<Self>)->Self {Self::create(host,owner,Mode::Recovery,window,cx)}
    fn create(host:Arc<Desktop>,owner:u64,mode:Mode,window:&mut Window,cx:&mut Context<Self>)->Self {
        TextInput::init(cx);let focus=cx.focus_handle();focus.focus(window);
        let topology=cx.new(TopologyView::new);let search=cx.new(|cx|TextInput::new("搜索 / Search",cx));
        let source_search=cx.new(|cx|TextInput::new("精确来源 ID / Exact source ID",cx));
        let quiet_start=cx.new(|cx|TextInput::new("22:00",cx));let quiet_end=cx.new(|cx|TextInput::new("08:00",cx));
        let glass_input=cx.new(|cx|TextInput::new("0–100",cx));
        let subscriptions=vec![cx.subscribe(&topology,|this,_,event,cx|match event {
            TopologyEvent::Select(id)=>{if let Some(agent)=this.monitor.agents.data.as_ref().and_then(|s|s.agents.iter().find(|a|&a.id==id)){let target=NavigationTarget::agent(agent);this.navigate(target,cx);}},
            TopologyEvent::FocusTern(id)=>this.request("monitor_focus_agent_in_tern",json!({"agentId":id}),cx),
        }),cx.subscribe(&search,|this,entity,_:&input::Changed,cx|{if this.page==AppPage::Agents{let query=entity.read(cx).text.clone();this.topology.update(cx,|v,cx|{v.set_query(query);cx.notify();});}cx.notify();})];
        let mut receiver=host.subscribe();
        let watch_task=cx.spawn(async move |weak,cx|{loop {let state=receiver.borrow_and_update().clone();if weak.update(cx,|this,cx|{
            this.latest=state.events.clone();if let Some(error)=state.last_error{this.error=Some(error.to_string());}
            if this.visible {this.apply_latest(cx);cx.notify();}
        }).is_err(){break;}if receiver.changed().await.is_err(){break;}}});
        let preview_tail=None;
        let mut this=Self{host,owner,mode,focus,page:AppPage::Overview,monitor:MonitorSnapshot::default(),settings:None,market:None,updates:None,topology,search,source_search,quiet_start,quiet_end,selection:None,history:None,event_page:None,event_query:EventQuery::default(),event_stack:vec![],filters:BTreeMap::new(),requests:BTreeMap::new(),paused:false,visible:true,latest:BTreeMap::new(),applied:BTreeMap::new(),confirmation:None,diagnostic:None,notice:None,error:None,recovery:None,tray_panels:[true;5],scrolls:(0..8).map(|_|ScrollHandle::new()).collect(),subscriptions,watch_task:Some(watch_task),interaction_pending:false,tray_excluded:vec![],sidebar_drag:None,page_searches:BTreeMap::new(),page_selections:BTreeMap::new(),history_offset:0,pending_events:None,deferred_queries:BTreeMap::new(),quiet_saved:None,glass_input,theme_preview:None,preview_tail,
            preview_pending:None,
            glass_preview:None,
            stable_focus:Default::default(),pending_focus:None,detail_scroll:ScrollHandle::new(),source_jump:Default::default(),navigation_sequence:None,target_bounds:Default::default(),
            focus_frame:Default::default(),inert_detail:Default::default(),building_detail:Default::default(),focus_overflow:Default::default(),
            panel_motion:PanelMotion{from:0.,to:0.,started:std::time::Instant::now()},detail_exit:None,
            #[cfg(feature="acceptance")] button_bounds:Default::default(),
            #[cfg(feature="acceptance")] button_overflow:Default::default(),
            #[cfg(feature="acceptance")] input_bounds:Default::default(),
        };
        if mode==Mode::Recovery{this.request("recovery_snapshot",json!({}),cx);}else{for command in ["monitor_snapshot","settings_snapshot","marketplace_snapshot"]{this.request(command,json!({}),cx);}if mode==Mode::Main{this.request("updates_snapshot",json!({}),cx);}}
        if mode==Mode::Tray{this.request("tray_preferences_snapshot",json!({}),cx);}
        if mode==Mode::Main{this.request("monitor_navigation",json!({}),cx);}
        this
    }
    pub fn set_visible(&mut self,visible:bool,cx:&mut Context<Self>){if self.visible==visible{return;}self.visible=visible;if visible{self.apply_latest(cx);if self.mode==Mode::Main{self.request("monitor_navigation",json!({}),cx);}if self.page==AppPage::Events{self.load_events(cx);}if self.page==AppPage::Schedules{self.load_history(self.history_offset,cx);}}else{self.panel_motion.from=self.panel_motion.to;if self.panel_motion.to==0.{self.detail_exit=None;}self.cancel_queries(cx);if self.page==AppPage::Settings{self.end_preview(cx);}}cx.notify();}
    pub fn visible(&self)->bool {self.visible}
    pub fn window_blurred(&mut self,cx:&mut Context<Self>){self.sidebar_drag=None;if self.mode==Mode::Main{self.end_preview(cx);}cx.notify();}
    #[cfg(feature="acceptance")]
    pub fn inspect(&self)->Value {json!({"page":self.page,"visible":self.visible,"paused":self.paused,"error":self.error,"selection":self.selection,"agentsSampled":self.monitor.agents.data.is_some(),"agents":self.monitor.agents.data.as_ref().map(|snapshot|snapshot.agents.iter().map(|agent|json!({"id":agent.id,"pid":agent.pid})).collect::<Vec<_>>()),"schedulesSampled":self.monitor.schedules.data.is_some(),"eventsLoaded":self.event_page.is_some(),"historyLoaded":self.history.is_some(),"settingsLoaded":self.settings.is_some(),"theme":self.settings.as_ref().map(|s|s.resolved_theme),"language":self.settings.as_ref().map(|s|s.resolved_language),"pending":self.requests.iter().filter(|(_,r)|r.busy).map(|(k,_)|*k).collect::<Vec<_>>(),"buttons":self.button_bounds.borrow().iter().map(|(id,b)|(id.clone(),json!({"x":f32::from(b.left()),"y":f32::from(b.top()),"width":f32::from(b.size.width),"height":f32::from(b.size.height)}))).collect::<BTreeMap<_,_>>(),"eventQuery":self.event_query,"eventStack":self.event_stack,"historyOffset":self.history_offset})}
    #[cfg(feature="acceptance")]
    pub fn inspect_in(&self,cx:&App)->Value{
        let mut state=self.inspect();
        state["buttonsLimited"]=json!(self.button_overflow.get());
        state["settings"]=json!(self.settings);state["market"]=json!(self.market);state["monitor"]=json!(self.monitor);
        state["drafts"]=json!({"quietStart":self.quiet_start.read(cx).text,"quietEnd":self.quiet_end.read(cx).text,"glass":self.glass_input.read(cx).text});
        state["inputs"]=json!(self.input_bounds.borrow().iter().map(|(id,b)|(id.clone(),json!({"x":f32::from(b.left()),"y":f32::from(b.top()),"width":f32::from(b.size.width),"height":f32::from(b.size.height)}))).collect::<BTreeMap<_,_>>());
        state["requests"]=json!(self.requests.iter().map(|(command,request)|(*command,json!({"generation":request.generation,"busy":request.busy,"error":request.error}))).collect::<BTreeMap<_,_>>());
        state["topology"]=self.topology.read(cx).inspect();state
    }
    #[cfg(feature="acceptance")]
    pub fn navigate_for_acceptance(&mut self,page:&str,_window:&mut Window,cx:&mut Context<Self>)->Result<(),String>{let page=match page{"overview"=>AppPage::Overview,"agents"=>AppPage::Agents,"schedules"=>AppPage::Schedules,"events"=>AppPage::Events,"system"=>AppPage::System,"plugins"=>AppPage::Plugins,"sources"=>AppPage::Sources,"settings"=>AppPage::Settings,_=>return Err("Unknown page".into())};self.navigate(NavigationTarget::Page{page},cx);Ok(())}
    fn decode<T:DeserializeOwned>(&mut self,value:Value)->Option<T>{match serde_json::from_value(value){Ok(v)=>Some(v),Err(e)=>{self.error=Some(format!("数据格式错误 / Invalid response: {e}"));None}}}
    fn apply_latest(&mut self,cx:&mut Context<Self>){
        let changed:Vec<_>=self.latest.iter().filter(|(k,v)|self.applied.get(*k)!=Some(*v)&&(!self.paused||!k.starts_with("monitor-")||k.starts_with("monitor-navigation"))).map(|(k,v)|(k.clone(),v.clone())).collect();
        for (key,value) in changed{self.applied.insert(key.clone(),value.clone());if key.starts_with("monitor-changed"){
            if let Some(update)=self.decode::<MonitorUpdate>(value){match update{MonitorUpdate::Agents(v)=>self.monitor.agents=v,MonitorUpdate::Schedules(v)=>self.monitor.schedules=v,MonitorUpdate::System(v)=>self.monitor.system=v,MonitorUpdate::Events(v)=>self.monitor.events=v}self.sync_topology(cx);}
        }else if key.starts_with("monitor-sources"){if let Some(heartbeat)=self.decode::<SourceHeartbeat>(value){self.heartbeat(heartbeat);}}
        else if key.starts_with("settings-changed"){if let Some(settings)=self.decode(value){self.settings=Some(settings);self.sync_theme(cx);}}
        else if key.starts_with("marketplace-changed"){self.market=self.decode(value);}
        else if key.starts_with("updates-changed"){self.updates=self.decode(value);}
        else if key.starts_with("monitor-navigation")&&self.mode==Mode::Main{self.request("monitor_navigation",json!({}),cx);}
        else if key=="tray-preferences-changed"{self.accept("tray_preferences_snapshot",value,cx);}
        }
    }
    fn heartbeat(&mut self,h:SourceHeartbeat){let sources=match h.section{MonitorSection::Agents=>self.monitor.agents.data.as_mut().map(|s|&mut s.sources),MonitorSection::Schedules=>self.monitor.schedules.data.as_mut().map(|s|&mut s.sources),MonitorSection::System=>self.monitor.system.data.as_mut().map(|s|&mut s.sources),MonitorSection::Events=>self.monitor.events.data.as_mut().map(|s|&mut s.sources)};if let Some(sources)=sources{for observation in h.sources{if let Some(source)=sources.iter_mut().find(|s|s.id==observation.id){source.last_attempt_at=observation.last_attempt_at;source.last_success_at=observation.last_success_at;}}}}
    fn sync_theme(&mut self,cx:&mut Context<Self>){self.sync_drafts(cx);let dark=self.dark();for input in [&self.search,&self.source_search,&self.quiet_start,&self.quiet_end,&self.glass_input]{input.update(cx,|i,cx|{i.dark=dark;cx.notify();});}if let Some(settings)=&self.settings{self.topology.update(cx,|v,cx|{v.set_settings(settings);cx.notify();});if (!settings.settings.plugins.schedules&&self.busy("monitor_schedule_history"))||(!settings.settings.plugins.events&&self.busy("monitor_events")){self.cancel_queries(cx);}}}
    fn sync_topology(&mut self,cx:&mut Context<Self>){let agents=self.monitor.agents.data.as_ref().map(|s|s.agents.clone()).unwrap_or_default();let current=!self.paused&&self.monitor.agents.error.is_none()&&self.settings.as_ref().is_some_and(|s|s.settings.plugins.agents);self.topology.update(cx,|v,cx|{v.update_agents(agents);v.set_evidence_current(current);cx.notify();});}
    fn request(&mut self,command:&'static str,args:Value,cx:&mut Context<Self>){
        if command=="settings_update"&&self.busy(command){return;}
        if command=="settings_preview_glass"&&self.busy(command){self.preview_pending=Some(args);return;}
        if command=="settings_update"{self.preview_pending=None;}
        if defer_until_cancelled(command,&args,&self.requests,&mut self.deferred_queries){return;}
        if command=="monitor_events"&&self.pending_events.is_none(){if let Some(query)=args.get("query").cloned().and_then(|q|serde_json::from_value(q).ok()){self.pending_events=Some((query,self.event_stack.clone()));}}
        let slot=self.requests.entry(command).or_insert(Request{generation:0,busy:false,error:None});slot.generation+=1;slot.busy=true;slot.error=None;let generation=slot.generation;
        let preview_intensity=if command=="settings_preview_glass"{Some(args.get("intensity").and_then(Value::as_f64))}else{None};
        let preview_generation=self.filter("preview-generation");
        let host=self.host.clone();let owner=self.owner;
        let interaction=std::mem::take(&mut self.interaction_pending)||command=="monitor_snapshot";
        let (previous,done)=if command=="settings_preview_glass"||command=="settings_update"{let previous=self.preview_tail.take();let(tx,rx)=tokio::sync::oneshot::channel();self.preview_tail=Some(rx);(previous,Some(tx))}else{(None,None)};
        let task=tokio::spawn(async move{if let Some(previous)=previous{previous.await.map_err(|_|oc_core::Error::invalid("preview operation interrupted"))?;}let result=host.action(owner,command,args).await;if let Some(done)=done{let _=done.send(());}result});
        cx.spawn(async move|weak,cx|{let result=match task.await{Ok(result)=>result.map_err(|e|e.to_string()),Err(e)=>Err(format!("操作中断 / Operation interrupted: {e}"))};let _=weak.update(cx,|this,cx|{
            let Some(slot)=this.requests.get_mut(command)else{return;};if slot.generation!=generation{return;}slot.busy=false;
            if result.is_ok()&&preview_generation==this.filters.get("preview-generation").copied().unwrap_or(0){if let Some(intensity)=preview_intensity{this.glass_preview=intensity;}if command=="settings_update"{this.glass_preview=None;}}
            match result{Ok(value)=>{this.accept(command,value,cx);if interaction{if let Err(error)=this.host.action_completed(this.owner){this.error=Some(error.to_string());}}},Err(error)=>{slot.error=Some(error.clone());this.error=Some(error);if command=="monitor_events"{this.pending_events=None;}if command=="monitor_cancel_events"{this.deferred_queries.remove("monitor_events");}if command=="monitor_cancel_schedule_history"{this.deferred_queries.remove("monitor_schedule_history");}}}cx.notify();
            if command=="settings_preview_glass"{if let Some(args)=this.preview_pending.take(){this.request("settings_preview_glass",args,cx);}}
        });}).detach();cx.notify();
    }
    fn accept(&mut self,command:&str,value:Value,cx:&mut Context<Self>){match command{
        "tray_preferences_snapshot"|"tray_preferences_save"=>{if let Some(excluded)=value.get("excluded"){if let Some(excluded)=self.decode::<Vec<String>>(excluded.clone()){self.tray_excluded=excluded;for(index,id)in ["overview","cpu","memory","disk","network"].iter().enumerate(){self.tray_panels[index]=!self.tray_excluded.iter().any(|excluded|excluded==id);}}}},
        "monitor_navigation"=>{if !value.is_null(){if let Some(intent)=self.decode::<NavigationIntent>(value){if self.navigation_sequence!=Some(intent.sequence){self.navigation_sequence=Some(intent.sequence);self.navigate(intent.target,cx);}self.request("monitor_acknowledge_navigation",json!({"sequence":intent.sequence}),cx);}}},
        "monitor_cancel_events"|"monitor_cancel_schedule_history"=>{let query=if command=="monitor_cancel_events"{"monitor_events"}else{"monitor_schedule_history"};if let Some(args)=self.deferred_queries.remove(query){self.request(query,args,cx);}},
        "monitor_snapshot"=>{if let Some(snapshot)=self.decode(value){self.monitor=snapshot;self.applied.retain(|k,_|!k.starts_with("monitor-"));self.apply_latest(cx);self.sync_topology(cx);}},
        "settings_snapshot"=>{self.settings=self.decode(value);self.sync_theme(cx);},
        "settings_update"|"settings_retry_geometry"=>{if let Some(result)=self.decode::<SettingsUpdateResult>(value){if let Some(error)=result.error{self.error=Some(format!("{} · {}",error.details,error.file_path));}if let Some(snapshot)=result.snapshot{self.settings=Some(snapshot);self.sync_theme(cx);self.sync_topology(cx);}}},
        "settings_update_login_item"=>{if let Some(result)=self.decode::<LoginItemUpdateResult>(value){if !result.ok{self.error=result.details;}if let Some(snapshot)=&mut self.settings{snapshot.login_item=result.state;}}},
        "settings_request_notification_permission"=>{self.request("settings_snapshot",json!({}),cx);},
        "marketplace_snapshot"|"marketplace_check"|"marketplace_install"|"marketplace_update"|"marketplace_uninstall"=>{self.market=self.decode(value);},
        "updates_snapshot"|"updates_check"|"updates_download"|"updates_cancel"|"updates_install"=>{self.updates=self.decode(value);},
        "monitor_schedule_history"=>{if let Some(history)=self.decode::<ScheduleHistory>(value){self.history_offset=history.offset;self.history=Some(history);}},"monitor_events"=>{let result=serde_json::from_value::<EventPage>(value).map_err(|e|e.to_string());if let Err(error)=commit_event_result(&mut self.event_query,&mut self.event_stack,&mut self.event_page,&mut self.pending_events,result){self.error=Some(error);}},
        "monitor_focus_agent_in_tern"=>{if let Some(error)=value.get("error").and_then(Value::as_str){self.error=Some(error.into());}},
        "diagnostics_generate"|"diagnostics_copy"|"diagnostics_save"=>{if let Some(reply)=self.decode::<DiagnosticReply>(value){match reply{DiagnosticReply::Ready{preview}=>self.diagnostic=Some(preview),DiagnosticReply::Copied=>self.notice=Some(self.t("已复制诊断报告","Diagnostic report copied").into()),DiagnosticReply::Saved=>self.notice=Some(self.t("已保存诊断报告","Diagnostic report saved").into()),DiagnosticReply::Cancelled=>self.notice=Some(self.t("已取消","Cancelled").into()),DiagnosticReply::Error{reason,details}=>self.error=Some(format!("{reason}: {details}"))}}},
        "diagnostics_cancel"=>{self.diagnostic=None;self.notice=Some(self.t("已取消","Cancelled").into());},
        "recovery_snapshot"=>self.recovery=Some(value),"recovery_retry"=>{if let Some(snapshot)=value.get("snapshot"){self.recovery=Some(snapshot.clone());}},
        "settings_accessibility_state"=>{self.notice=Some(format!("{}: {}",self.t("辅助功能权限","Accessibility permission"),value.get("status").and_then(Value::as_str).unwrap_or("unknown")));},_=>{}
    }}
    fn cancel_queries(&mut self,cx:&mut Context<Self>){if self.mode!=Mode::Main{return;}self.deferred_queries.clear();self.pending_events=None;for (query,cancel) in [("monitor_events","monitor_cancel_events"),("monitor_schedule_history","monitor_cancel_schedule_history")]{if let Some(request)=self.requests.get_mut(query){request.generation+=1;request.busy=false;}if !self.busy(cancel){self.request(cancel,json!({}),cx);}}}
    fn navigate(&mut self,target:NavigationTarget,cx:&mut Context<Self>){
        if self.mode==Mode::Tray{self.request("settings_show_main_window",json!({"target":target}),cx);return;}
        let next=target.page();
        self.source_jump.set(matches!(target,NavigationTarget::Source{..}));
        if matches!(target,NavigationTarget::Schedule{..}|NavigationTarget::Agent{..}){
            self.set_panel_open(true);self.detail_exit=None;
            let key=if next==AppPage::Schedules{"job-close"}else{"close-agent"};self.pending_focus=self.stable_handle(key,cx);
            if self.selection.as_ref()!=Some(&target){self.detail_scroll.set_offset(point(px(0.),px(0.)));}
        }
        if next==AppPage::System{self.filters.insert("plugins-expanded",1);}
        if next!=self.page{
            self.detail_exit=None;if !matches!(target,NavigationTarget::Schedule{..}|NavigationTarget::Agent{..}){self.panel_motion=PanelMotion{from:0.,to:0.,started:std::time::Instant::now()};}
            self.page_searches.insert(self.page as usize,self.search.read(cx).text.clone());
            if let Some(selection)=self.selection.take(){self.page_selections.insert(self.page as usize,selection);}
            if self.page==AppPage::Settings{self.end_preview(cx);}
            self.cancel_queries(cx);self.page=next;
            let text=self.page_searches.get(&(next as usize)).cloned().unwrap_or_default();self.search.update(cx,|input,cx|input.set(text,cx));
            if next==AppPage::Agents{let query=self.search.read(cx).text.clone();self.topology.update(cx,|v,cx|{v.set_query(query);cx.notify();});}
            self.selection=self.page_selections.get(&(next as usize)).cloned();
        }
        if matches!(target,NavigationTarget::Page{..})&&matches!(self.selection,Some(NavigationTarget::Schedule{..}|NavigationTarget::Agent{..})){self.panel_motion=PanelMotion{from:1.,to:1.,started:std::time::Instant::now()};}
        if !matches!(target,NavigationTarget::Page{..}){if self.selection.as_ref()!=Some(&target)&&matches!(target,NavigationTarget::Schedule{..}){self.history_offset=0;self.history=None;self.cancel_queries(cx);}self.selection=Some(target);}
        if self.page==AppPage::Events{self.load_events(cx);}if self.page==AppPage::Schedules{self.load_history(self.history_offset,cx);}cx.notify();
    }
    fn load_history(&mut self,offset:usize,cx:&mut Context<Self>){if self.paused||!self.visible||!self.settings.as_ref().is_some_and(|s|s.settings.plugins.schedules){return;}if let Some(NavigationTarget::Schedule{id,..})=&self.selection{if offset<=MAX_HISTORY_OFFSET{self.request("monitor_schedule_history",json!({"jobId":id,"offset":offset}),cx);}}}
    fn load_events(&mut self,cx:&mut Context<Self>){if !self.paused&&self.visible&&self.settings.as_ref().is_some_and(|s|s.settings.plugins.events){self.request("monitor_events",json!({"query":self.event_query}),cx);}}
    fn query_events(&mut self,query:EventQuery,stack:Vec<EventQuery>,cx:&mut Context<Self>){self.pending_events=Some((query.clone(),stack));self.request("monitor_events",json!({"query":query}),cx);}
    fn act(&mut self,action:Action,cx:&mut Context<Self>){self.interaction_pending=true;match action{
        Action::Navigate(target)=>self.navigate(target,cx),Action::Command(command,args)=>{if command=="settings_preview_glass"&&args.get("intensity").is_some_and(Value::is_null){self.end_preview(cx);}else{self.request(command,args,cx);}},Action::Patch(patch)=>self.request("settings_update",json!({"patch":patch}),cx),
        Action::Pause=>{self.paused=!self.paused;if self.paused{self.cancel_queries(cx);}else{self.apply_latest(cx);if self.page==AppPage::Events{self.load_events(cx);}if self.page==AppPage::Schedules{self.load_history(self.history_offset,cx);}}self.sync_topology(cx);},
        Action::Sidebar=>{if let Some(s)=&self.settings{self.request("settings_update",json!({"patch":{"sidebarCollapsed":!s.settings.sidebar_collapsed}}),cx);}},
        Action::Filter(key,index)=>{self.filters.insert(key,index);},Action::History(offset)=>self.load_history(offset,cx),
        Action::EventsApply=>{let source=self.source_search.read(cx).text.trim().to_owned();let mut query=EventQuery{source_id:(!source.is_empty()).then_some(source),event_type:self.filter("event-type").checked_sub(1).and_then(|i|LocalEventType::ALL.get(i).copied()),..EventQuery::default()};let hours=match self.filter("event-time"){1=>1,2=>24,3=>168,_=>0};if hours>0{query.from=Some((chrono::Utc::now()-chrono::Duration::hours(hours)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true));}self.query_events(query,vec![],cx);},
        Action::EventsClear=>{self.filters.insert("event-type",0);self.filters.insert("event-time",0);self.source_search.update(cx,|i,cx|i.set(String::new(),cx));self.query_events(EventQuery::default(),vec![],cx);},
        Action::EventsNext=>{if let Some(next)=self.event_page.as_ref().and_then(|p|p.next){let mut stack=self.event_stack.clone();stack.push(self.event_query.clone());let mut query=self.event_query.clone();query.before=Some(next);self.query_events(query,stack,cx);}},
        Action::EventsPrevious=>{let mut stack=self.event_stack.clone();if let Some(query)=stack.pop(){self.query_events(query,stack,cx);}},
        Action::CloseDetail=>{self.close_detail(cx);},Action::Confirm(command,id)=>self.confirmation=Some((command,id)),Action::CancelConfirm=>self.confirmation=None,
        Action::AcceptConfirm=>{if let Some((command,id))=self.confirmation.take(){self.request(command,json!({"id":id}),cx);}},
        Action::Subscribe(target)=>{if let Some(s)=&self.settings{let mut n=s.settings.notifications.clone();if let Some(index)=n.tasks.iter().position(|t|t==&target){n.tasks.remove(index);}else{n.tasks.push(target);}self.request("settings_update",json!({"patch":{"notifications":n}}),cx);}},
        Action::TrayPanel(index)=>{let id=["overview","cpu","memory","disk","network"][index];let mut excluded=self.tray_excluded.clone();if let Some(i)=excluded.iter().position(|s|s==id){excluded.remove(i);}else{excluded.push(id.into());}self.request("tray_preferences_save",json!({"excluded":excluded}),cx);},
        Action::Glass(save)=>{let intensity=self.glass_input.read(cx).text.parse::<u8>();match intensity{Ok(intensity) if intensity<=100=>{if save{self.request("settings_update",json!({"patch":{"glassIntensity":intensity}}),cx);}else{self.request("settings_preview_glass",json!({"intensity":intensity}),cx);}},_=>self.error=Some(self.t("玻璃强度必须是 0–100 的整数","Glass intensity must be an integer from 0 to 100").into())}},
        Action::QuietSave=>{let parse=|s:&str|->Option<u32>{let(h,m)=s.split_once(':')?;let h=h.parse::<u32>().ok()?;let m=m.parse::<u32>().ok()?;(h<24&&m<60).then_some(h*60+m)};if let (Some(start),Some(end),Some(s))=(parse(&self.quiet_start.read(cx).text),parse(&self.quiet_end.read(cx).text),&self.settings){let mut n=s.settings.notifications.clone();n.quiet.start_minute=start;n.quiet.end_minute=end;self.request("settings_update",json!({"patch":{"notifications":n}}),cx);}else{self.error=Some(self.t("请使用 00:00–23:59 时间格式","Use a time between 00:00 and 23:59").into());}},
    }self.interaction_pending=false;cx.notify();}
    fn end_preview(&mut self,cx:&mut Context<Self>){self.theme_preview=None;self.glass_preview=None;self.preview_pending=None;self.filters.insert("glass-drag",0);for key in ["glass-key-generation","preview-generation"]{let generation=self.filter(key).wrapping_add(1);self.filters.insert(key,generation);}if let Some(s)=&self.settings{self.glass_input.update(cx,|input,cx|input.set(s.settings.glass_intensity.to_string(),cx));}self.request("settings_preview_glass",json!({"intensity":null}),cx);}
    fn sync_drafts(&mut self,cx:&mut Context<Self>){if let Some(s)=&self.settings{let q=&s.settings.notifications.quiet;let saved=(format!("{:02}:{:02}",q.start_minute/60,q.start_minute%60),format!("{:02}:{:02}",q.end_minute/60,q.end_minute%60));for (input,new,old) in [(&self.quiet_start,&saved.0,self.quiet_saved.as_ref().map(|s|s.0.as_str())),(&self.quiet_end,&saved.1,self.quiet_saved.as_ref().map(|s|s.1.as_str()))]{if let Some(text)=synced_draft(&input.read(cx).text,old,new){input.update(cx,|i,cx|i.set(text,cx));}}self.quiet_saved=Some(saved);if self.glass_input.read(cx).text.is_empty(){self.glass_input.update(cx,|i,cx|i.set(s.settings.glass_intensity.to_string(),cx));}}}
    fn t<'a>(&self,zh:&'a str,en:&'a str)->&'a str{if self.settings.as_ref().is_some_and(|s|s.resolved_language==ResolvedLanguage::English)||self.recovery.as_ref().and_then(|v|v.get("language")).and_then(Value::as_str)==Some("en"){en}else{zh}}
    fn label<T:labels::UiLabel>(&self,value:T)->&'static str{let(zh,en)=value.labels();self.t(zh,en)}
    fn dark(&self)->bool{self.theme_preview.as_ref().or(self.settings.as_ref()).is_some_and(|s|s.resolved_theme==ResolvedTheme::Dark)}
    fn palette(&self)->Palette{self.theme_preview.as_ref().or(self.settings.as_ref()).map(Palette::from_settings).unwrap_or_default()}
    // Native NSGlassEffectView sits below GPUI; only chrome exposes it. Data surfaces stay opaque.
    fn chrome_color(&self,color:u32)->Rgba{let intensity=self.settings.as_ref().filter(|s|s.liquid_glass.available&&!s.liquid_glass.reduced_transparency&&!s.liquid_glass.increased_contrast).map(|s|self.glass_preview.unwrap_or(s.settings.glass_intensity)).unwrap_or(0.);let mut color=rgb(color);color.a=1.-(intensity.clamp(0.,100.)as f32/100.);color}
    fn filter(&self,key:&'static str)->usize{self.filters.get(key).copied().unwrap_or(0)}
    fn finish_sidebar_drag(&mut self,cx:&mut Context<Self>){if let Some(width)=self.sidebar_drag.take(){let patch=if width<160.{json!({"sidebarCollapsed":true})}else{json!({"sidebarWidth":(width as f64).round().clamp(MIN_SIDEBAR_WIDTH,MAX_SIDEBAR_WIDTH)})};self.act(Action::Patch(patch),cx);}}
    fn busy(&self,command:&str)->bool{self.requests.get(command).is_some_and(|r|r.busy)}
    fn title(&self,page:AppPage)->&str{match page{AppPage::Overview=>self.t("本机概览","Overview"),AppPage::Agents=>self.t("协作拓扑","Agent topology"),AppPage::Schedules=>self.t("定时任务","Schedules"),AppPage::Events=>self.t("事件","Events"),AppPage::System=>self.t("系统监控","System"),AppPage::Plugins=>self.t("插件市场","Marketplace"),AppPage::Sources=>self.t("数据来源","Sources"),AppPage::Settings=>self.t("设置","Settings")}}
    fn stable_handle(&self,id:&str,cx:&mut Context<Self>)->Option<FocusHandle>{
        let mut handles=self.stable_focus.borrow_mut();
        if let Some((handle,frame))=handles.get_mut(id){*frame=self.focus_frame.get();return Some(handle.clone());}
        if handles.len()>=FOCUS_BUDGET{self.focus_overflow.set(true);return None;}
        let handle=cx.focus_handle();handles.insert(id.to_owned(),(handle.clone(),self.focus_frame.get()));Some(handle)
    }
    fn set_panel_open(&mut self,open:bool){let now=std::time::Instant::now();let to=if open{1.}else{0.};let from=if !self.visible||self.settings.as_ref().is_some_and(|s|s.reduced_motion){to}else{self.panel_motion.value(now)};self.panel_motion=PanelMotion{from,to,started:now};}
    fn detail_target(&self)->Option<&NavigationTarget>{self.selection.as_ref().or(self.detail_exit.as_ref())}
    fn close_detail(&mut self,cx:&mut Context<Self>){
        if !matches!(self.selection,Some(NavigationTarget::Schedule{..}|NavigationTarget::Agent{..})){return;}
        self.pending_focus=match &self.selection{
            Some(target @ NavigationTarget::Schedule{id,..}) if self.row_visible(&format!("job-{id}"))&&self.monitor.schedules.data.as_ref().is_some_and(|s|s.jobs.iter().any(|job|NavigationTarget::schedule(job)==*target&&self.schedule_matches(job,cx)))=>self.stable_handle(&format!("job-{id}"),cx),
            Some(NavigationTarget::Agent{..})=>Some(self.topology.read(cx).focus_handle(cx)),
            _=>Some(self.search.read(cx).focus_handle(cx)),
        };
        if matches!(self.selection,Some(NavigationTarget::Schedule{..}|NavigationTarget::Agent{..})){self.detail_exit=self.selection.clone();self.set_panel_open(false);}
        self.selection=None;self.page_selections.remove(&(self.page as usize));self.cancel_queries(cx);
    }
    fn row_visible(&self,id:&str)->bool{let bounds=self.target_bounds.borrow();match(bounds.get(id),bounds.get("workspace")){(Some(row),Some(workspace))=>bounds_overlap(*row,*workspace),_=>false}}
    fn mark_bounds(&self,id:&str,element:Stateful<Div>,cx:&Context<Self>)->Stateful<Div>{
        let bounds=self.target_bounds.clone();let id=id.to_owned();let entity=cx.entity().downgrade();
        element.child(canvas(move|rect,window,_|{if id.starts_with("job-")&&!bounds_overlap(rect,Bounds::new(point(px(0.),px(0.)),window.viewport_size())){return;}let mut bounds=bounds.borrow_mut();if bounded_insert(&mut bounds,id,rect,TARGET_BUDGET).is_err(){window.on_next_frame(move|_,cx|{let _=entity.update(cx,|this,cx|{let message="布局目标超过安全预算 / Layout target budget exceeded";if this.error.as_deref()!=Some(message){this.error=Some(message.into());cx.notify();}});});}},|_,_,_,_|{}).absolute().top_0().left_0().size_full())
    }
    #[cfg(feature="acceptance")]
    pub fn inspect_window(&self,window:&Window,cx:&App)->Value{
        let mut state=self.inspect_in(cx);
        state["focusedId"]=json!(self.stable_focus.borrow().iter().find(|(_, (h,_))|h.is_focused(window)).map(|(id,_)|id.clone()).or_else(||self.search.read(cx).focus_handle(cx).is_focused(window).then(||"search".into())).or_else(||self.topology.read(cx).focus_handle(cx).is_focused(window).then(||"topology".into())));
        state["targets"]=json!(self.target_bounds.borrow().iter().map(|(id,b)|(id.clone(),json!({"x":f32::from(b.left()),"y":f32::from(b.top()),"width":f32::from(b.size.width),"height":f32::from(b.size.height)}))).collect::<BTreeMap<_,_>>());
        let now=std::time::Instant::now();state["panelProgress"]=json!(self.panel_motion.value(now));state["panelAnimating"]=json!(self.panel_motion.active(now)&&self.visible);state["drafts"]["search"]=json!(self.search.read(cx).text);
        state["pageScrollY"]=json!(f32::from(self.scrolls[self.page as usize].offset().y));state["detailScrollY"]=json!(f32::from(self.detail_scroll.offset().y));state["sourceJumpPending"]=json!(self.source_jump.get());state
    }
    fn button(&self,id:impl Into<SharedString>,label:impl Into<SharedString>,action:Action,enabled:bool,cx:&mut Context<Self>)->AnyElement{
        let enabled=enabled&&match &action{Action::Patch(_)|Action::Subscribe(_)|Action::QuietSave|Action::Glass(true)=>!self.busy("settings_update"),_=>true};
        let p=self.palette();let id:SharedString=id.into();let action_key=action.clone();
        if self.inert_detail.get(){return div().px_3().py_2().rounded_md().border_1().border_color(rgb(p.line)).bg(rgb(p.surface)).text_color(rgb(p.muted)).text_sm().child(label.into()).into_any_element();}
        let detail_target=self.building_detail.get().then(||self.selection.clone()).flatten();let key_target=detail_target.clone();let row_id=id.to_string();
        #[cfg(feature="acceptance")]
        let marker={let bounds=self.button_bounds.clone();let overflow=self.button_overflow.clone();let id=id.to_string();canvas(move|rect,window,_|{if id.starts_with("job-")&&!bounds_overlap(rect,Bounds::new(point(px(0.),px(0.)),window.viewport_size())){return;}if bounded_insert(&mut bounds.borrow_mut(),id,rect,512).is_err(){overflow.set(true);}},|_,_,_,_|{}).absolute().top_0().left_0().size_full()};
        let Some(handle)=self.stable_handle(id.as_ref(),cx)else{return self.note("交互控件超过安全预算 / Interaction control budget exceeded").into_any_element();};
        let button=div().id(id).relative().px_3().py_2().rounded_md().border_1().border_color(rgb(p.line)).bg(rgb(p.surface)).text_color(rgb(if enabled{p.accent}else{p.muted})).text_sm().cursor_pointer().track_focus(&handle)
            .when(enabled,|el|el.hover(move|s|s.bg(rgb(p.selected))).on_click(cx.listener(move|this,_,_,cx|{if detail_action_allowed(&detail_target,&this.selection){this.act(action.clone(),cx);}})).on_key_down(cx.listener(move|this,event:&KeyDownEvent,_,cx|{if event.keystroke.key=="enter"||event.keystroke.key=="space"{if detail_action_allowed(&key_target,&this.selection){this.act(action_key.clone(),cx);}cx.stop_propagation();}})))
            .focus(|s|s.border_color(rgb(p.accent))).child(label.into());
        #[cfg(feature="acceptance")] let button=button.child(marker);
        let button=if row_id.starts_with("job-"){self.mark_bounds(&row_id,button,cx)}else{button};
        button.into_any_element()
    }
    fn setting_input(&self,_id:&'static str,input:Entity<TextInput>)->Div{
        let font=self.settings.as_ref().map(|s|match s.settings.code_font{CodeFont::System|CodeFont::Menlo=>"Menlo",CodeFont::Monaco=>"Monaco"}).unwrap_or("Menlo");
        let element=div().relative().font_family(font).child(input);
        #[cfg(feature="acceptance")]
        let element={let bounds=self.input_bounds.clone();element.child(canvas(move|rect,_,_|{let mut bounds=bounds.borrow_mut();if bounds.len()<3{bounds.insert(_id.to_owned(),rect);}},|_,_,_,_|{}).absolute().top_0().left_0().size_full())};
        element
    }
    fn search_input(&self)->Div{
        let element=div().relative().child(self.search.clone());
        #[cfg(feature="acceptance")]
        let element={let bounds=self.input_bounds.clone();element.child(canvas(move|rect,_,_|{bounds.borrow_mut().insert("search".into(),rect);},|_,_,_,_|{}).absolute().top_0().left_0().size_full())};
        element
    }
    fn command(&self,command:&'static str,label:&str,cx:&mut Context<Self>)->AnyElement{self.button(command,label.to_owned(),Action::Command(command,json!({})),!self.busy(command),cx)}
    fn toolbar(&self)->Div{div().flex().flex_wrap().items_center().gap_2()}
    fn section(&self,title:impl Into<SharedString>)->Div{div().flex().flex_col().gap_3().mt_5().child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(title.into()))}
    fn row(&self,label:impl Into<SharedString>,value:impl Into<SharedString>)->Div{div().flex().flex_wrap().gap_4().py_2().border_b_1().border_color(rgb(self.palette().line)).child(div().w(px(160.)).text_color(rgb(self.palette().muted)).child(label.into())).child(div().flex_1().min_w(px(140.)).child(value.into()))}
    fn note(&self,text:impl Into<SharedString>)->Div{div().py_2().text_sm().text_color(rgb(self.palette().muted)).child(text.into())}
    fn status<T>(&self,state:&CollectorState<T>,enabled:bool)->AnyElement{let message=if let Some(error)=&state.error{format!("{} · {error}",self.t("采集失败，保留上次快照","Collection failed; showing the last snapshot"))}else if !enabled{self.t("采集已停用；现有快照不是实时状态","Collection disabled; retained data is not current").into()}else if state.refreshing{self.t("正在采集…","Collecting…").into()}else if state.data.is_none(){self.t("尚未采样","Not sampled yet").into()}else{format!("{} {}",self.t("上次成功","Last success"),state.last_success_at.as_deref().unwrap_or("—"))};self.note(message).into_any_element()}
}
impl Render for RootView {
    fn render(&mut self,window:&mut Window,cx:&mut Context<Self>)->impl IntoElement{
        #[cfg(feature="acceptance")] self.button_bounds.borrow_mut().clear();
        #[cfg(feature="acceptance")] self.button_overflow.set(false);
        #[cfg(feature="acceptance")] self.input_bounds.borrow_mut().clear();
        self.target_bounds.borrow_mut().clear();
        self.focus_overflow.set(false);
        self.focus_frame.set(self.focus_frame.get().wrapping_add(1));
        let now=std::time::Instant::now();
        if !self.visible||self.settings.as_ref().is_some_and(|s|s.reduced_motion){self.panel_motion.from=self.panel_motion.to;}
        if self.panel_motion.active(now)&&self.visible{window.request_animation_frame();}else if self.panel_motion.to==0.{self.detail_exit=None;}
        let p=self.palette();let text_size=self.settings.as_ref().map(|s|match s.settings.text_size{TextSize::Small=>13.,TextSize::Default=>14.,TextSize::Large=>16.}).unwrap_or(14.);
        let font=self.settings.as_ref().map(|s|match s.settings.ui_font{UiFont::Pingfang=>"PingFang SC",UiFont::Helvetica=>"Helvetica Neue",UiFont::System=>".AppleSystemUIFont"}).unwrap_or(".AppleSystemUIFont");
        let mut root=div().id("oc-root").size_full().flex().flex_col().text_color(rgb(p.text)).font_family(font).text_size(px(text_size)).track_focus(&self.focus)
            .on_key_down(cx.listener(|this,event:&KeyDownEvent,window,cx|{if event.keystroke.modifiers.control&&event.keystroke.modifiers.platform&&event.keystroke.key=="s"{this.act(Action::Sidebar,cx);}if event.keystroke.key=="tab"{if event.keystroke.modifiers.shift{window.focus_prev();}else{window.focus_next();}}if event.keystroke.key=="escape"{this.confirmation=None;this.close_detail(cx);if this.page==AppPage::Settings{this.end_preview(cx);}cx.notify();}}));
        let host=self.host.clone();let owner=self.owner;
        root=root.child(div().bg(rgb(p.bg)).child(canvas(|_,_,_|(),move|_,_,_,_|{if let Err(error)=host.frame_committed(owner){host.report(error);}}).h(px(1.)).w_full()));
        if self.mode==Mode::Recovery{return root.bg(rgb(p.bg)).child(self.recovery_page(cx)).into_any_element();}
        if self.mode==Mode::Tray{return root.bg(rgb(p.bg)).child(self.tray_page(cx)).into_any_element();}
        let mut header=self.toolbar().px_5().py_3().border_b_1().border_color(rgb(p.line)).bg(self.chrome_color(p.surface))
            .child(div().flex().items_center().gap_1().child(svg().path("resources/brand/oc-chan-mono.svg").size(px(14.)).text_color(rgb(p.accent))).child(div().font_weight(FontWeight::BOLD).text_sm().child("OC Chan")))
            .child(self.button("sidebar",self.t("导航","Navigation"),Action::Sidebar,true,cx))
            .child(div().flex_1().child(self.title(self.page).to_owned()))
            .child(self.button("pause",if self.paused{self.t("恢复显示","Resume display")}else{self.t("暂停显示","Pause display")},Action::Pause,true,cx))
            .child(self.command("monitor_refresh",self.t("刷新","Refresh"),cx));
        if self.updates.as_ref().is_some_and(|u|matches!(u.phase,oc_core::updates::UpdatePhase::Available|oc_core::updates::UpdatePhase::Downloaded)){header=header.child(self.button("update-banner",self.t("有可用更新","Update available"),Action::Navigate(NavigationTarget::Page{page:AppPage::Settings}),true,cx));}
        root=root.child(header);
        if let Some(error)=&self.error{root=root.child(div().px_5().py_2().bg(rgb(if self.dark(){0x482c37}else{0xffe9ee})).child(error.clone()));}
        if let Some(notice)=&self.notice{root=root.child(self.note(notice.clone()).px_5());}
        if let Some((command,id))=&self.confirmation{root=root.child(self.toolbar().p_4().bg(rgb(p.selected)).child(format!("{} {id}?",match *command{"marketplace_install"=>self.t("确认安装","Confirm installation of"),"marketplace_update"=>self.t("确认更新","Confirm update of"),"marketplace_uninstall"=>self.t("确认卸载","Confirm removal of"),_=>self.t("确认操作","Confirm operation on")})).child(self.button("confirm",self.t("确认","Confirm"),Action::AcceptConfirm,true,cx)).child(self.button("cancel-confirm",self.t("取消","Cancel"),Action::CancelConfirm,true,cx)));}
        let collapsed=self.settings.as_ref().is_some_and(|s|s.settings.sidebar_collapsed)||window.viewport_size().width<px(1020.);
        let pages=[AppPage::Overview,AppPage::Agents,AppPage::Schedules,AppPage::Events];
        let installed=self.market.as_ref().is_some_and(|m|m.items.iter().any(|i|i.installed&&i.manifest.section==MonitorSection::System));
        let mut navigation=pages.iter().map(|page|self.button(format!("nav-{page:?}"),self.title(*page).to_owned(),Action::Navigate(NavigationTarget::Page{page:*page}),true,cx)).collect::<Vec<_>>();
        let expanded=self.filter("plugins-expanded")==1;let toggle=Action::Filter("plugins-expanded",if expanded{0}else{1});
        let arrow=canvas(move|bounds,_,_|bounds,move|bounds,_,window,_|{let mut path=PathBuilder::stroke(px(1.5));let x=bounds.left()+px(4.);let y=bounds.top()+px(4.);let points=if expanded{[point(x,y),point(x+px(4.),y+px(4.)),point(x+px(8.),y)]}else{[point(x,y),point(x+px(4.),y+px(4.)),point(x,y+px(8.))]};path.move_to(points[0]);path.line_to(points[1]);path.line_to(points[2]);window.paint_path(path.build().expect("three finite chevron points"),rgb(p.text));}).size(px(16.));
        navigation.push(self.toolbar().child(self.button("nav-plugins",self.t("插件","Plugins"),Action::Navigate(NavigationTarget::Page{page:AppPage::Plugins}),true,cx)).child(div().id("plugins-expand").p_2().focusable().cursor_pointer().hover(move|s|s.bg(rgb(p.selected))).focus(move|s|s.bg(rgb(p.selected))).on_click(cx.listener(move|this,_,_,cx|this.act(toggle.clone(),cx))).on_key_down(cx.listener(move|this,event:&KeyDownEvent,_,cx|{if matches!(event.keystroke.key.as_str(),"enter"|"space"){this.act(Action::Filter("plugins-expanded",if expanded{0}else{1}),cx);cx.stop_propagation();}})).child(arrow)).into_any_element());
        if self.filter("plugins-expanded")==1{if installed{navigation.push(div().pl_4().child(self.button("nav-system",self.title(AppPage::System).to_owned(),Action::Navigate(NavigationTarget::Page{page:AppPage::System}),true,cx)).into_any_element());}else{navigation.push(self.note(self.t("尚未安装系统插件","No system plugin installed")).into_any_element());}}
        if collapsed{root=root.child(self.toolbar().bg(self.chrome_color(p.bg)).px_4().py_2().children(std::mem::take(&mut navigation)).child(self.button("nav-sources",self.title(AppPage::Sources).to_owned(),Action::Navigate(NavigationTarget::Page{page:AppPage::Sources}),true,cx)).child(self.button("nav-settings",self.title(AppPage::Settings).to_owned(),Action::Navigate(NavigationTarget::Page{page:AppPage::Settings}),true,cx)));}
        let content=match self.page{AppPage::Overview=>self.overview(cx),AppPage::Agents=>self.agents(cx),AppPage::Schedules=>self.schedules(cx),AppPage::Events=>self.events(cx),AppPage::System=>self.system(cx),AppPage::Plugins=>self.marketplace(cx),AppPage::Sources=>self.sources(cx),AppPage::Settings=>self.preferences(cx)};
        let mut body=div().flex().flex_1().min_h_0();if !collapsed{let width=self.sidebar_drag.unwrap_or_else(||self.settings.as_ref().map(|s|s.settings.sidebar_width as f32).unwrap_or(214.)).clamp(140.,320.);body=body.child(div().w(px(width)).flex_shrink_0().p_3().flex().flex_col().gap_2().border_r_1().border_color(rgb(p.line)).children(navigation).child(div().flex_1()).child(self.button("sidebar-sources",self.title(AppPage::Sources).to_owned(),Action::Navigate(NavigationTarget::Page{page:AppPage::Sources}),true,cx)).child(self.button("sidebar-settings",self.title(AppPage::Settings).to_owned(),Action::Navigate(NavigationTarget::Page{page:AppPage::Settings}),true,cx)).child(self.note("⌃⌘S"))).child(div().id("sidebar-resize").w(px(6.)).h_full().focusable().cursor(CursorStyle::ResizeLeftRight).hover(|s|s.bg(rgb(p.selected))).on_mouse_down(MouseButton::Left,cx.listener(|this,event:&MouseDownEvent,_,cx|{this.sidebar_drag=Some(f32::from(event.position.x));cx.notify();})).on_mouse_move(cx.listener(|this,event:&MouseMoveEvent,_,cx|{if this.sidebar_drag.is_some(){this.sidebar_drag=Some(f32::from(event.position.x));cx.notify();}})).on_mouse_up(MouseButton::Left,cx.listener(|this,_,_,cx|this.finish_sidebar_drag(cx))).on_mouse_up_out(MouseButton::Left,cx.listener(|this,_,_,cx|this.finish_sidebar_drag(cx))).on_key_down(cx.listener(|this,event:&KeyDownEvent,_,cx|{if let Some(s)=&this.settings{let delta=match event.keystroke.key.as_str(){"left"=>-16.,"right"=>16.,_=>0.};if delta!=0.{this.act(Action::Patch(json!({"sidebarWidth":(s.settings.sidebar_width+delta).clamp(MIN_SIDEBAR_WIDTH,MAX_SIDEBAR_WIDTH)})),cx);}}})));}
        body=body.bg(self.chrome_color(p.bg));
        let page=div().id("page-scroll").bg(rgb(p.bg)).track_scroll(&self.scrolls[self.page as usize]).overflow_y_scroll().size_full().min_w_0().p_6().child(div().text_2xl().font_weight(FontWeight::SEMIBOLD).mb_4().child(self.title(self.page).to_owned())).child(content);
        let mut workspace=self.mark_bounds("workspace",div().id("workspace").relative().flex_1().min_w_0().min_h_0().overflow_hidden().child(page),cx);
        if matches!((&self.page,self.detail_target()),(AppPage::Schedules,Some(NavigationTarget::Schedule{..}))|(AppPage::Agents,Some(NavigationTarget::Agent{..}))){let sidebar=if collapsed{0.}else{self.sidebar_drag.unwrap_or_else(||self.settings.as_ref().map(|s|s.settings.sidebar_width as f32).unwrap_or(214.)).clamp(140.,320.)+6.};let available=(f32::from(window.viewport_size().width)-sidebar).max(0.);let width=if available<720.{available}else{(available*0.48).clamp(460.,520.)};workspace=workspace.child(self.detail_panel(width,self.panel_motion.value(now),cx));}
        body=body.child(workspace);
        if let Some(handle)=self.pending_focus.take(){handle.focus(window);}
        let frame=self.focus_frame.get();
        retain_recent_focus(&mut self.stable_focus.borrow_mut(),frame,|handle|handle.is_focused(window)||self.pending_focus.as_ref()==Some(handle));
        if self.focus_overflow.get(){root=root.child(self.note("交互控件超过安全预算（16384） / Interaction control budget exceeded (16384)"));}
        root.child(body).into_any_element()
    }
}
const FOCUS_BUDGET:usize=16_384;
const TARGET_BUDGET:usize=8_192;
fn bounded_insert<K:Ord,V>(entries:&mut BTreeMap<K,V>,key:K,value:V,budget:usize)->Result<(),()>{if entries.len()>=budget&&!entries.contains_key(&key){return Err(());}entries.insert(key,value);Ok(())}
fn retain_recent_focus<K:Ord,V>(entries:&mut BTreeMap<K,(V,u64)>,frame:u64,protected:impl Fn(&V)->bool){entries.retain(|_,(value,last)|*last==frame||protected(value));}
fn detail_action_allowed(expected:&Option<NavigationTarget>,current:&Option<NavigationTarget>)->bool{expected.is_none()||expected==current}
fn bounds_overlap(row:Bounds<Pixels>,clip:Bounds<Pixels>)->bool{row.bottom()>clip.top()&&row.top()<clip.bottom()&&row.right()>clip.left()&&row.left()<clip.right()}
fn bytes(value:u64)->String{let value=value as f64;if value>=1_073_741_824.{format!("{:.1} GB",value/1_073_741_824.)}else if value>=1_048_576.{format!("{:.1} MB",value/1_048_576.)}else{format!("{:.1} KB",value/1024.)}}
fn percent(value:Option<f64>)->String{value.map(|v|format!("{v:.1}%")).unwrap_or_else(||"—".into())}
fn synced_draft(current:&str,previous:Option<&str>,saved:&str)->Option<String>{previous.map_or(current.is_empty(),|old|current==old).then(||saved.to_owned())}
fn glass_position_value(position:f32,width:f32)->u8{((position/width.max(1.)).clamp(0.,1.)*100.).round()as u8}
fn defer_until_cancelled(command:&'static str,args:&Value,requests:&BTreeMap<&'static str,Request>,pending:&mut BTreeMap<&'static str,Value>)->bool{let cancel=match command{"monitor_events"=>"monitor_cancel_events","monitor_schedule_history"=>"monitor_cancel_schedule_history",_=>return false};if requests.get(cancel).is_some_and(|r|r.busy){pending.insert(command,args.clone());true}else{false}}
fn commit_event_result(query:&mut EventQuery,stack:&mut Vec<EventQuery>,page:&mut Option<EventPage>,pending:&mut Option<(EventQuery,Vec<EventQuery>)>,result:Result<EventPage,String>)->Result<(),String>{
    let candidate=pending.take();let result=result?;
    if let Some((mut next,history))=candidate{next.upper=Some(result.upper);*query=next;*stack=history;}
    *page=Some(result);Ok(())
}
#[cfg(test)] mod regression_tests {
    use super::*;
    use core::prelude::v1::test;
    #[test] fn focus_cache_reclaims_departed_rows_and_preserves_active_and_pending(){let mut entries=BTreeMap::from([(0,(0,1)),(1,(1,2)),(2,(2,1)),(3,(3,1))]);retain_recent_focus(&mut entries,2,|v|*v==2||*v==3);assert_eq!(entries.keys().copied().collect::<Vec<_>>(),vec![1,2,3]);retain_recent_focus(&mut entries,3,|_|false);assert!(entries.is_empty());}
    #[test] fn bounds_budget_rejects_growth_but_allows_existing_target_refresh(){let mut entries=BTreeMap::new();for key in 0..TARGET_BUDGET{assert!(bounded_insert(&mut entries,key,1,TARGET_BUDGET).is_ok());}assert!(bounded_insert(&mut entries,TARGET_BUDGET,2,TARGET_BUDGET).is_err());assert!(bounded_insert(&mut entries,0,3,TARGET_BUDGET).is_ok());assert_eq!(entries.len(),TARGET_BUDGET);assert_eq!(entries[&0],3);entries.clear();assert!(bounded_insert(&mut entries,TARGET_BUDGET,4,TARGET_BUDGET).is_ok());}
    #[test] fn exiting_detail_rejects_stale_actions_but_preserves_workspace_actions(){let target=Some(NavigationTarget::Source{id:"old".into(),section:MonitorSection::Schedules});let replacement=Some(NavigationTarget::Source{id:"new".into(),section:MonitorSection::Schedules});assert!(detail_action_allowed(&target,&target));assert!(!detail_action_allowed(&target,&None));assert!(!detail_action_allowed(&target,&replacement));assert!(detail_action_allowed(&None,&replacement));}
    #[test] fn close_focus_requires_actual_row_in_workspace_clip(){let clip=Bounds::new(point(px(100.),px(100.)),size(px(800.),px(500.)));let row=|y|Bounds::new(point(px(110.),px(y)),size(px(700.),px(40.)));assert!(bounds_overlap(row(120.),clip));assert!(bounds_overlap(row(80.),clip));assert!(!bounds_overlap(row(60.),clip));assert!(!bounds_overlap(row(600.),clip));}
    #[test] fn panel_motion_reverses_from_current_position_without_queuing(){
        let start=std::time::Instant::now();let open=PanelMotion{from:0.,to:1.,started:start};let middle=start+std::time::Duration::from_millis(80);let position=open.value(middle);assert!(position>0.&&position<1.);
        let close=PanelMotion{from:position,to:0.,started:middle};assert_eq!(close.value(middle),position);assert_eq!(close.value(middle+std::time::Duration::from_millis(200)),0.);assert!(!close.active(middle+std::time::Duration::from_millis(200)));
        let reduced=PanelMotion{from:1.,to:1.,started:middle};assert_eq!(reduced.value(middle),1.);assert!(!reduced.active(middle));
    }
    fn page(upper:u64)->EventPage{EventPage{entries:vec![],next:Some(upper.saturating_sub(50)),upper,revision:1,retention:EventRetention::default(),coverage:vec![]}}
    #[test] fn event_pagination_commits_boundary_and_history_only_on_success(){
        let mut query=EventQuery::default();let mut stack=vec![];let mut shown=None;let mut pending=Some((query.clone(),vec![]));
        commit_event_result(&mut query,&mut stack,&mut shown,&mut pending,Ok(page(100))).unwrap();assert_eq!(query.upper,Some(100));
        let first=query.clone();let mut next=first.clone();next.before=Some(50);pending=Some((next.clone(),vec![first.clone()]));
        assert!(commit_event_result(&mut query,&mut stack,&mut shown,&mut pending,Err("read failed".into())).is_err());assert_eq!(query,first);assert!(stack.is_empty());assert_eq!(shown.as_ref().unwrap().upper,100);
        pending=Some((next,vec![first.clone()]));commit_event_result(&mut query,&mut stack,&mut shown,&mut pending,Ok(page(100))).unwrap();assert_eq!(query.before,Some(50));assert_eq!(stack,vec![first.clone()]);
        pending=Some((stack[0].clone(),vec![]));commit_event_result(&mut query,&mut stack,&mut shown,&mut pending,Ok(page(100))).unwrap();assert_eq!(query,first);assert!(stack.is_empty());
    }
    #[test] fn quiet_drafts_fill_saved_values_without_clobbering_edits(){assert_eq!(synced_draft("",None,"21:30"),Some("21:30".into()));assert_eq!(synced_draft("21:30",Some("21:30"),"22:00"),Some("22:00".into()));assert_eq!(synced_draft("23:15",Some("21:30"),"22:00"),None);assert_eq!(synced_draft("08:00",Some("08:00"),"09:00"),Some("09:00".into()));}
    #[test] fn glass_slider_reaches_every_integer(){for value in 0..=100{assert_eq!(glass_position_value(value as f32*2.,200.),value);}assert_eq!(glass_position_value(-10.,200.),0);assert_eq!(glass_position_value(210.,200.),100);}
    #[test] fn replacement_queries_wait_for_cancel_completion(){let mut requests=BTreeMap::new();requests.insert("monitor_cancel_events",Request{generation:1,busy:true,error:None});let mut pending=BTreeMap::new();assert!(defer_until_cancelled("monitor_events",&json!({"query":{"upper":1}}),&requests,&mut pending));assert!(defer_until_cancelled("monitor_events",&json!({"query":{"upper":2}}),&requests,&mut pending));assert_eq!(pending.len(),1);assert_eq!(pending["monitor_events"]["query"]["upper"],2);requests.get_mut("monitor_cancel_events").unwrap().busy=false;let latest=pending.remove("monitor_events").unwrap();assert!(!defer_until_cancelled("monitor_events",&latest,&requests,&mut pending));assert!(pending.is_empty());}
}
