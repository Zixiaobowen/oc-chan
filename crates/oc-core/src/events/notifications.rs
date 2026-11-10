use std::{path::PathBuf, sync::{Arc, Mutex}, time::Duration};
use chrono::{DateTime, Local, Timelike, Utc};
use futures_util::future::BoxFuture;
use serde::Serialize;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;
use crate::{error::{Error, Result, check_cancel, validate_text}, model::*, settings::*, worker::DataWorker};
use super::{contracts::{NotificationBatch, SAFE_INTEGER, digest, validate_event}, journal::{Journal, Cooldown, Cursor}};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct NotificationMessage { pub id:String, pub title:String, pub body:String, pub target:NavigationTarget }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeDelivery { Pending, Displayed, Removed, Unconfirmed }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeRemoval { Pending, Confirmed }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeDrain { Pending, Complete }
/// Every future must retain ownership until its native request has settled or is
/// registered in the adapter's drain ledger. Pending is not display/removal proof.
pub trait NotificationAdapter:Send+Sync {
    fn permission<'a>(&'a self,request:bool,cancel:&'a CancellationToken)->BoxFuture<'a,Result<NotificationPermission>>;
    fn submit<'a>(&'a self,message:NotificationMessage,cancel:&'a CancellationToken)->BoxFuture<'a,Result<NativeDelivery>>;
    fn settle<'a>(&'a self,id:&'a str,cancel:&'a CancellationToken)->BoxFuture<'a,Result<NativeDelivery>>;
    fn remove<'a>(&'a self,id:&'a str)->BoxFuture<'a,Result<NativeRemoval>>;
    fn drain(&self)->BoxFuture<'_,Result<NativeDrain>>;
}
pub struct NotificationOptions {
    pub journal:PathBuf,
    pub worker:DataWorker,
    pub preferences:Arc<dyn Fn()->NotificationSettings+Send+Sync>,
    pub language:Arc<dyn Fn()->ResolvedLanguage+Send+Sync>,
    pub adapter:Arc<dyn NotificationAdapter>,
    pub task_name:Arc<dyn Fn(&NavigationTarget)->Option<String>+Send+Sync>,
    pub changed:Arc<dyn Fn(NotificationState)+Send+Sync>,
}
struct State {
    visible:NotificationState, active:bool, sleeping:bool, blocked:bool,
    controller:CancellationToken, show:Option<CancellationToken>, journal:Option<Journal>,
    last_clock:Option<i64>, handles:Vec<String>, native_used:bool, journal_uncertain:bool,
}
pub struct EventNotifications { options:NotificationOptions, state:Mutex<State>, gate:AsyncMutex<()> }
struct Message { value:NotificationMessage, summary:bool, count:u64 }
impl EventNotifications {
    pub fn new(options:NotificationOptions)->Self {
        Self{options,state:Mutex::new(State{visible:NotificationState::default(),active:false,sleeping:false,blocked:false,controller:CancellationToken::new(),show:None,journal:None,last_clock:None,handles:vec![],native_used:false,journal_uncertain:false}),gate:AsyncMutex::new(())}
    }
    pub fn snapshot(&self)->NotificationState {self.state.lock().expect("notification lock").visible.clone()}
    #[cfg(feature = "acceptance")]
    pub fn acceptance_snapshot(&self) -> Result<serde_json::Value> {
        let state = self.state.lock().map_err(|_| Error::invalid("notification observation lock"))?;
        let journal = state.journal.as_ref().map(|journal| serde_json::json!({
            "identity": journal.identity, "cursor": journal.cursor, "summaryCount": journal.summary_count,
            "cooldownCount": journal.cooldowns.len(), "sentAtCount": journal.sent_at.len()
        }));
        Ok(serde_json::json!({"state":state.visible,"journal":journal,"journalUncertain":state.journal_uncertain,
            "active":state.active,"sleeping":state.sleeping,"blocked":state.blocked,"nativeHandles":state.handles.len(),
            "scope":"in-memory controller journal; not an independent disk persistence read"}))
    }
    fn update(&self,apply:impl FnOnce(&mut NotificationState)) {
        let changed={let mut state=self.state.lock().expect("notification lock");let old=state.visible.clone();apply(&mut state.visible);if old!=state.visible{Some(state.visible.clone())}else{None}};
        if let Some(state)=changed{(self.options.changed)(state);}
    }
    pub fn cancel(&self) {let state=self.state.lock().expect("notification lock");state.controller.cancel();if let Some(show)=&state.show{show.cancel();}}
    pub fn set_sleeping(&self,sleeping:bool) {let mut state=self.state.lock().expect("notification lock");state.sleeping=sleeping;if sleeping{if let Some(show)=&state.show{show.cancel();}}}
    fn failure(&self,error:&Error) {
        if error.is_cancelled(){self.update(|s|s.last_outcome=Some(NotificationOutcome::Cancelled));return;}
        self.state.lock().expect("notification lock").blocked=true;
        self.update(|s|{s.phase=NotificationPhase::Error;s.detail=Some(format!("通知操作失败 / Notification operation failed ({})",error.code));});
    }
    pub async fn start(&self,parent:&CancellationToken)->Result<()> {
        let _gate=self.gate.lock().await;
        {let mut state=self.state.lock().expect("notification lock");state.active=true;state.controller=parent.child_token();}
        let result=self.initialize().await;if let Err(e)=&result{self.failure(e);}result
    }
    pub async fn refresh(&self,parent:&CancellationToken)->Result<()> {
        if !(self.options.preferences)().enabled{self.cancel();}
        let _gate=self.gate.lock().await;
        let active=self.state.lock().expect("notification lock").active;
        let result=if !active || !(self.options.preferences)().enabled{self.release(false).await}else{
            {let mut state=self.state.lock().expect("notification lock");state.controller=parent.child_token();}
            self.initialize().await
        };
        if let Err(e)=&result{self.failure(e);}result
    }
    async fn initialize(&self)->Result<()> {
        let settings=(self.options.preferences)();settings.validate()?;
        if !settings.enabled{self.update(|s|s.phase=NotificationPhase::Off);return Ok(());}
        if self.state.lock().expect("notification lock").blocked{self.drain_native().await?;}
        self.update(|s|{s.phase=NotificationPhase::Starting;s.detail=None;});
        let cancel=self.state.lock().expect("notification lock").controller.clone();
        let value=self.options.worker.request("events-journal-read",&self.options.journal,serde_json::json!({}),&cancel).await?;
        let journal:Journal=serde_json::from_value(value).map_err(|_|Error::invalid("notification journal"))?;journal.validate()?;
        {let mut state=self.state.lock().expect("notification lock");state.journal=Some(journal.clone());state.journal_uncertain=false;state.native_used=true;}
        let permission=self.permission(false,&cancel).await?;
        check_cancel(&cancel)?;
        {let mut state=self.state.lock().expect("notification lock");state.journal=Some(journal.clone());state.last_clock=None;state.blocked=false;}
        self.update(|s|{s.permission=permission;s.pending_count=journal.summary_count as usize;if journal.cursor.unconfirmed{s.last_outcome=Some(NotificationOutcome::Unconfirmed);s.detail=Some("上次发送未确认，不会重放 / Previous delivery unconfirmed; no replay".into());}});
        self.availability(Utc::now());Ok(())
    }
    async fn permission(&self,request:bool,parent:&CancellationToken)->Result<NotificationPermission> {
        let cancel=parent.child_token();let future=self.options.adapter.permission(request,&cancel);tokio::pin!(future);
        tokio::select!{result=&mut future=>result,_=tokio::time::sleep(Duration::from_secs(30))=>{cancel.cancel();match future.await{Err(e) if !e.is_cancelled()=>Err(e),_=>Err(Error::new("OC_NOTIFICATION_PERMISSION_TIMEOUT","通知权限尚未确认 / Notification permission remains unconfirmed"))}}}
    }
    pub async fn request_permission(&self)->Result<NotificationState> {
        let _gate=self.gate.lock().await;
        if !self.state.lock().expect("notification lock").active||!(self.options.preferences)().enabled{return Err(Error::new("OC_NOTIFICATIONS_DISABLED","请先启用事件和通知 / Enable events and notifications first"));}
        let cancel=self.state.lock().expect("notification lock").controller.clone();
        self.state.lock().expect("notification lock").native_used=true;
        match self.permission(true,&cancel).await{Ok(permission)=>{self.update(|s|{s.permission=permission;s.detail=None;});self.availability(Utc::now());Ok(self.snapshot())},Err(e)=>{self.failure(&e);Err(e)}}
    }
    pub async fn committed(&self,batch:NotificationBatch)->Result<()> {
        self.committed_cancellable(batch,&CancellationToken::new()).await
    }
    pub async fn committed_cancellable(&self,batch:NotificationBatch,caller:&CancellationToken)->Result<()> {
        let _gate=self.gate.lock().await;
        let active=self.state.lock().expect("notification lock").active;
        if !active||!(self.options.preferences)().enabled{return Ok(());}
        if self.state.lock().expect("notification lock").blocked{return Err(Error::new("OC_NOTIFICATION_BLOCKED","通知等待显式刷新，认领不会重放 / Notification failure requires explicit refresh; claims are not replayed"));}
        let operation=self.state.lock().expect("notification lock").controller.child_token();
        let future=self.consume_with_cancel(batch,Utc::now(),&operation);tokio::pin!(future);
        let result=tokio::select!{result=&mut future=>result,_=caller.cancelled()=>{operation.cancel();future.await}};
        if let Err(error)=&result{self.failure(error);}result
    }
    pub async fn sleep(&self)->Result<()> {
        self.set_sleeping(true);
        let _gate=self.gate.lock().await;
        let result=self.drain_native().await;
        if let Err(e)=&result{self.failure(e);}else{self.availability(Utc::now());}result
    }
    pub async fn wake(&self)->Result<()> {
        let _gate=self.gate.lock().await;
        self.set_sleeping(false);self.availability(Utc::now());Ok(())
    }
    pub async fn stop(&self)->Result<()> {
        self.cancel();
        let _gate=self.gate.lock().await;
        self.state.lock().expect("notification lock").active=false;
        let result=self.release(true).await;if let Err(e)=&result{self.failure(e);}result
    }
    async fn release(&self,events_disabled:bool)->Result<()> {
        self.cancel();let mut errors=vec![];
        if let Err(e)=self.drain_native().await{errors.push(e);}
        let uncertain=self.state.lock().expect("notification lock").journal_uncertain;
        if uncertain{
            let result=async{let value=self.options.worker.request("events-journal-read",&self.options.journal,serde_json::json!({}),&CancellationToken::new()).await?;let journal:Journal=serde_json::from_value(value).map_err(|_|Error::invalid("notification journal recovery"))?;journal.validate()?;Ok(journal)}.await;
            match result{Ok(journal)=>{let mut state=self.state.lock().expect("notification lock");state.journal=Some(journal);state.journal_uncertain=false;},Err(error)=>errors.push(error)}
        }
        let journal=self.state.lock().expect("notification lock").journal.clone();
        if let Some(mut journal)=journal{if journal.summary_count>0{journal.summary_count=0;match self.save(&journal,&CancellationToken::new()).await{Ok(())=>self.state.lock().expect("notification lock").journal=Some(journal),Err(e)=>errors.push(e)}}}
        if !errors.is_empty(){return Err(Error::cleanup("notifications",Error::aggregate(errors)));}
        {let mut state=self.state.lock().expect("notification lock");state.journal=None;state.last_clock=None;state.show=None;state.blocked=false;}
        self.update(|s|{s.phase=if events_disabled&&(self.options.preferences)().enabled{NotificationPhase::EventsDisabled}else{NotificationPhase::Off};s.pending_count=0;});Ok(())
    }
    async fn drain_native(&self)->Result<()> {
        let (handles,used)={let state=self.state.lock().expect("notification lock");(state.handles.clone(),state.native_used)};
        let mut errors=vec![];
        for id in handles{match self.options.adapter.remove(&id).await{Ok(NativeRemoval::Confirmed)=>self.state.lock().expect("notification lock").handles.retain(|value|value!=&id),Ok(NativeRemoval::Pending)=>errors.push(Error::new("OC_NOTIFICATION_REMOVAL_PENDING","原生通知移除尚未确认 / Notification removal remains pending")),Err(e)=>errors.push(e)}}
        if used{match self.options.adapter.drain().await{Ok(NativeDrain::Complete)=>{let mut state=self.state.lock().expect("notification lock");state.handles.clear();state.native_used=false;errors.retain(|e|e.code!="OC_NOTIFICATION_REMOVAL_PENDING");},Ok(NativeDrain::Pending)=>errors.push(Error::new("OC_NOTIFICATION_DRAIN_PENDING","原生通知或权限请求仍在排空 / Native notification or permission request remains pending")),Err(e)=>errors.push(e)}}
        if errors.is_empty(){Ok(())}else{Err(Error::cleanup("native notifications",Error::aggregate(errors)))}
    }
    fn availability(&self,now:DateTime<Utc>) {
        let state=self.state.lock().expect("notification lock");let active=state.active;let sleeping=state.sleeping;let permission=state.visible.permission;let blocked=state.blocked;drop(state);
        if blocked{return;}let settings=(self.options.preferences)();
        let phase=if !settings.enabled{NotificationPhase::Off}else if !active{NotificationPhase::EventsDisabled}else{match permission{NotificationPermission::Denied=>NotificationPhase::Denied,NotificationPermission::Unsupported=>NotificationPhase::Unavailable,NotificationPermission::Authorized|NotificationPermission::Provisional=>if sleeping{NotificationPhase::Sleeping}else if quiet(&settings,local_minute(now)){NotificationPhase::Quiet}else{NotificationPhase::Ready},_=>NotificationPhase::PermissionRequired}};
        self.update(|s|s.phase=phase);
    }
    fn message(&self,event:&LocalEvent,identity:&str)->NotificationMessage {
        let mut name=format!("#{}",&digest(&event.entity_id)[..10]);
        if (self.options.preferences)().show_task_names{if let Some(target@NavigationTarget::Schedule{..})=&event.target{if let Some(resolved)=(self.options.task_name)(target){let bounded:String=resolved.chars().scan(0,|used,c|{*used+=c.len_utf16();(*used<=80).then_some(if c.is_control(){' '}else{c})}).collect();if !bounded.is_empty(){name=bounded;}}}}
        let label=match ((self.options.language)(),event.event_type){(ResolvedLanguage::Chinese,LocalEventType::ExecutionFailed)=>"任务执行失败",(ResolvedLanguage::Chinese,LocalEventType::DeliveryFailed)=>"任务投递失败",(ResolvedLanguage::Chinese,LocalEventType::SourceUnavailable)=>"数据来源不可用",(ResolvedLanguage::Chinese,LocalEventType::SourceRecovered)=>"数据来源已恢复",(ResolvedLanguage::English,LocalEventType::ExecutionFailed)=>"Task execution failed",(ResolvedLanguage::English,LocalEventType::DeliveryFailed)=>"Task delivery failed",(ResolvedLanguage::English,LocalEventType::SourceUnavailable)=>"Source unavailable",(ResolvedLanguage::English,LocalEventType::SourceRecovered)=>"Source recovered"};
        NotificationMessage{id:digest(format!("{identity}:{}",event.id)),title:"OC Chan".into(),body:format!("{label} · {name}"),target:event.target.clone().unwrap_or(NavigationTarget::Page{page:AppPage::Events})}
    }
    async fn save(&self,journal:&Journal,cancel:&CancellationToken)->Result<()> {
        journal.validate()?;
        let result=self.options.worker.request("events-journal-write",&self.options.journal,serde_json::to_value(journal).map_err(|_|Error::invalid("notification journal"))?,cancel).await;
        if let Err(error)=result{let mut state=self.state.lock().expect("notification lock");state.journal=None;state.journal_uncertain=true;state.blocked=true;return Err(error);}
        self.state.lock().expect("notification lock").journal_uncertain=false;Ok(())
    }
    #[cfg(test)]
    async fn consume(&self,batch:NotificationBatch,date:DateTime<Utc>)->Result<()> {
        let cancel=self.state.lock().expect("notification lock").controller.clone();
        self.consume_with_cancel(batch,date,&cancel).await
    }
    async fn consume_with_cancel(&self,batch:NotificationBatch,date:DateTime<Utc>,cancel:&CancellationToken)->Result<()> {
        validate_text(&batch.identity,128,512,"notification database identity")?;
        if batch.events.len()>100||batch.events.iter().any(|(s,_)|*s==0||*s>SAFE_INTEGER)||batch.events.windows(2).any(|w|w[0].0>=w[1].0){return Err(Error::invalid("notification batch"));}
        for (_,event) in &batch.events{validate_event(event)?;}
        let now=date.timestamp_millis();if now<0||now as u64>SAFE_INTEGER-8_000{return Err(Error::invalid("notification clock"));}
        let settings=(self.options.preferences)();settings.validate()?;
        let (previous,last_clock,sleeping,permission)={let state=self.state.lock().expect("notification lock");(state.journal.clone().ok_or_else(||Error::invalid("uninitialized notification journal"))?,state.last_clock,state.sleeping,state.visible.permission)};
        check_cancel(&cancel)?;
        let mut next=previous.clone();
        if previous.identity.as_deref()!=Some(batch.identity.as_str()){next.identity=Some(batch.identity.clone());next.cursor=Cursor::default();next.cooldowns.clear();next.summary_count=0;if previous.identity.is_some(){self.update(|s|s.detail=Some("事件数据库身份变化，通知游标已重置 / Event database identity changed; notification cursor reset".into()));}}
        next.rebase(now,last_clock);
        let allowed=!sleeping&&!quiet(&settings,local_minute(date))&&matches!(permission,NotificationPermission::Authorized|NotificationPermission::Provisional);
        let native_capacity=self.state.lock().expect("notification lock").handles.len();
        if native_capacity>61{self.drain_native().await?;}
        let mut messages=vec![];
        if allowed&&next.summary_count>0&&next.sent_at.len()<3{let count=next.summary_count;let body=match (self.options.language)(){ResolvedLanguage::Chinese=>format!("已合并 {count} 条事件通知"),ResolvedLanguage::English=>format!("{count} event notifications grouped")};messages.push(Message{value:NotificationMessage{id:digest(format!("{}:summary:{}:{now}",batch.identity,next.cursor.sequence)),title:"OC Chan".into(),body,target:NavigationTarget::Page{page:AppPage::Events}},summary:true,count});next.summary_count=0;next.sent_at.push(now);}
        for (sequence,event) in batch.events{if sequence<=next.cursor.sequence{continue;}next.cursor.sequence=sequence;
            let key=digest(serde_json::to_vec(&[&event.source_id,&event.entity_id]).expect("string pair serializes"));let index=next.cooldowns.iter().position(|c|c.key==key);
            if event.event_type==LocalEventType::SourceRecovered{if let Some(index)=index{next.cooldowns.remove(index);}}
            if !selected(&event,&settings){continue;}
            let cooling=event.event_type!=LocalEventType::SourceRecovered&&(index.is_some()||next.cooldowns.len()>=64);
            if event.event_type!=LocalEventType::SourceRecovered&&!cooling{next.cooldowns.push(Cooldown{key,at:now});}
            if !allowed||cooling||next.sent_at.len()>=3{next.suppress(1)?;continue;}
            messages.push(Message{value:self.message(&event,&batch.identity),summary:false,count:1});next.sent_at.push(now);
        }
        let first=next.sent_at.len()-messages.len();
        if !messages.is_empty(){next.cursor.unconfirmed=true;for at in &mut next.sent_at[first..]{*at=now+8_000;}}
        if next!=previous{self.save(&next,&cancel).await?;self.state.lock().expect("notification lock").journal=Some(next.clone());}
        self.state.lock().expect("notification lock").last_clock=Some(now);
        self.update(|s|{s.pending_count=next.summary_count as usize;if next.summary_count>0{s.last_outcome=Some(NotificationOutcome::Suppressed);}});
        self.availability(date);
        if messages.is_empty(){return Ok(());}
        let show=cancel.child_token();
        {let mut state=self.state.lock().expect("notification lock");if state.sleeping{show.cancel();}state.show=Some(show.clone());}
        let deadline=tokio::time::Instant::now()+Duration::from_secs(8);let mut attempted=0;let mut failure=None;
        for (index,message) in messages.iter().enumerate(){
            if let Err(e)=check_cancel(&show){failure=Some(e);break;}
            attempted=index+1;
            {let mut state=self.state.lock().expect("notification lock");if state.handles.len()>=64{failure=Some(Error::limit("native notification handles",64,state.handles.len()+1));break;}state.handles.push(message.value.id.clone());state.native_used=true;}
            let work=async{let state=self.options.adapter.submit(message.value.clone(),&show).await?;if state==NativeDelivery::Pending{self.options.adapter.settle(&message.value.id,&show).await}else{Ok(state)}};
            tokio::pin!(work);
            let result=tokio::select!{result=&mut work=>result,_=tokio::time::sleep_until(deadline)=>{show.cancel();match work.await{Err(e) if e.is_cleanup()=>Err(e),Err(e) if !e.is_cancelled()=>Err(e),_=>Err(Error::timeout("notification delivery"))}}};
            match result{
                Ok(NativeDelivery::Displayed)=>{let sent=Utc::now();next.sent_at[first+index]=sent.timestamp_millis().max(now);self.update(|s|{s.last_sent_at=Some(sent.to_rfc3339_opts(chrono::SecondsFormat::Millis,true));s.last_outcome=Some(if message.summary{NotificationOutcome::Summary}else{NotificationOutcome::Sent});});},
                Ok(NativeDelivery::Removed)=>{self.state.lock().expect("notification lock").handles.retain(|id|id!=&message.value.id);failure=Some(Error::cancelled());break;},
                Ok(NativeDelivery::Pending|NativeDelivery::Unconfirmed)=>{failure=Some(Error::new("OC_NOTIFICATION_UNCONFIRMED","系统尚未确认通知显示，不会重放 / Notification display unconfirmed; no replay"));break;},
                Err(e)=>{failure=Some(e);break;}
            }
        }
        self.state.lock().expect("notification lock").show=None;
        if let Some(error)=failure{
            let sleeping=self.state.lock().expect("notification lock").sleeping;
            self.update(|s|{s.last_outcome=Some(if show.is_cancelled(){NotificationOutcome::Cancelled}else{NotificationOutcome::Unconfirmed});s.detail=Some("发送未确认，不会重放 / Delivery unconfirmed; no replay".into());});
            let mut errors=vec![error];
            if sleeping&&!cancel.is_cancelled()&&attempted<messages.len(){let result=async{for message in &messages[attempted..]{next.suppress(message.count)?;}next.sent_at.truncate(first+attempted);self.save(&next,&cancel).await?;self.state.lock().expect("notification lock").journal=Some(next.clone());self.update(|s|s.pending_count=next.summary_count as usize);Ok(())}.await;if let Err(e)=result{errors.push(e);}}
            if show.is_cancelled(){if let Err(e)=self.drain_native().await{errors.push(e);}}
            return Err(Error::aggregate(errors));
        }
        next.cursor.unconfirmed=false;
        self.save(&next,&cancel).await?;self.state.lock().expect("notification lock").journal=Some(next);Ok(())
    }
}
fn local_minute(now:DateTime<Utc>)->u32{let local=now.with_timezone(&Local);local.hour()*60+local.minute()}
pub fn quiet(settings:&NotificationSettings,minute:u32)->bool{let q=&settings.quiet;q.enabled&&if q.start_minute<q.end_minute{minute>=q.start_minute&&minute<q.end_minute}else{minute>=q.start_minute||minute<q.end_minute}}
pub fn selected(event:&LocalEvent,settings:&NotificationSettings)->bool{settings.event_types.contains(&event.event_type)&&(settings.source_ids.contains(&event.source_id)||event.target.as_ref().is_some_and(|target|matches!(target,NavigationTarget::Schedule{..})&&settings.tasks.contains(target)))}

#[cfg(test)]mod tests {
    use super::*;
    #[test]fn quiet_crosses_midnight_and_stops_at_end(){let mut settings=NotificationSettings::default();settings.quiet.enabled=true;assert!(quiet(&settings,23*60));assert!(quiet(&settings,7*60+59));assert!(!quiet(&settings,8*60));assert!(!quiet(&settings,21*60+59));settings.quiet.start_minute=60;settings.quiet.end_minute=120;assert!(quiet(&settings,60));assert!(!quiet(&settings,120));}
    #[test]fn task_identity_and_type_are_required(){let mut settings=NotificationSettings::default();settings.tasks.push(NavigationTarget::Schedule{id:"hermes-job:a".into(),identity:"one".into()});let mut event=LocalEvent{id:"id".into(),source_id:"hermes-events".into(),entity_id:"a".into(),event_type:LocalEventType::ExecutionFailed,occurred_at:None,observed_at:"2026-11-09T00:00:00.000Z".into(),result_code:"failed".into(),target:Some(NavigationTarget::Schedule{id:"hermes-job:a".into(),identity:"two".into()})};assert!(!selected(&event,&settings));event.target=Some(settings.tasks[0].clone());assert!(selected(&event,&settings));settings.event_types.clear();assert!(!selected(&event,&settings));}
}

#[cfg(test)]
#[path="notification_tests.rs"]
mod worker_behavior_tests;
