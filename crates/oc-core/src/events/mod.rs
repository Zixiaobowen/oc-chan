//! Tauri-independent event service. Worker requests and native notification calls
//! remain owned by supervised tasks until cancellation and cleanup have finished.
pub mod collector;
pub mod contracts;
pub mod journal;
pub mod notifications;
pub use notifications::{NotificationAdapter,NotificationMessage,NativeDelivery,NativeRemoval,NativeDrain};
use std::{path::{Path,PathBuf},sync::{Arc,Mutex}};
use tokio::sync::{Mutex as AsyncMutex,Semaphore,oneshot,watch};
use tokio_util::{sync::CancellationToken,task::TaskTracker};
use crate::{error::{Error,Result,check_cancel,timestamp},io::BoundedIo,model::*,settings::*,worker::DataWorker};
use contracts::*;
use notifications::{EventNotifications,NotificationOptions};

#[derive(Clone,Debug)]
pub struct EventPaths {pub home:PathBuf,pub profile:PathBuf,pub database:PathBuf,pub hermes_database:PathBuf,pub journal:PathBuf}
impl EventPaths {
    pub fn validate(&self)->Result<()> {
        for path in [&self.home,&self.profile,&self.database,&self.hermes_database,&self.journal]{if !path.is_absolute()||path.as_os_str().len()>4096||path.components().any(|p|matches!(p,std::path::Component::ParentDir)){return Err(Error::invalid("event paths"));}}
        if !self.database.starts_with(&self.profile)||!self.journal.starts_with(&self.profile)||self.database==self.journal||self.database==self.hermes_database||self.journal==self.hermes_database||self.profile==self.database||self.profile==self.journal{return Err(Error::invalid("event profile isolation"));}Ok(())
    }
}
pub struct EventCallbacks {
    pub notification_changed:Arc<dyn Fn(NotificationState)+Send+Sync>,
    pub task_name:Arc<dyn Fn(&NavigationTarget)->Option<String>+Send+Sync>,
}
#[derive(Clone,Copy,Debug)]
pub struct SectionEnabled {pub agents:bool,pub schedules:bool,pub system:bool}
impl Default for SectionEnabled {fn default()->Self{Self{agents:true,schedules:true,system:true}}}
#[derive(Clone)]
pub struct EventInput {pub snapshot:MonitorSnapshot,pub enabled:SectionEnabled}
struct Admission {active:bool,cancel:CancellationToken}
struct QueryFlight {cancel:CancellationToken,done:watch::Receiver<Option<Result<()>>>}
struct Inner {
    io:BoundedIo,worker:DataWorker,paths:EventPaths,notifications:EventNotifications,
    preferences:Arc<Mutex<NotificationSettings>>,language:Arc<Mutex<ResolvedLanguage>>,
    admission:Mutex<Admission>,tasks:TaskTracker,queue:Arc<Semaphore>,lifecycle:AsyncMutex<()>,
    collection:AsyncMutex<()>,latest:Mutex<Option<EventSnapshot>>,generation:Mutex<u64>,
    store_identity:Mutex<Option<String>>,
    query:Mutex<Option<QueryFlight>>,query_gate:AsyncMutex<()>,
    errors:Mutex<Vec<Error>>,
}
#[derive(Clone)]
pub struct EventService {inner:Arc<Inner>}
#[cfg(feature = "acceptance")]
impl EventService {
    pub fn acceptance_notifications(&self) -> Result<serde_json::Value> { self.inner.notifications.acceptance_snapshot() }
}
impl EventService {
    pub fn new(io:BoundedIo,worker:DataWorker,paths:EventPaths,adapter:Arc<dyn NotificationAdapter>,language:ResolvedLanguage,callbacks:EventCallbacks)->Result<Self>{
        paths.validate()?;let preferences=Arc::new(Mutex::new(NotificationSettings::default()));let language=Arc::new(Mutex::new(language));let pref=preferences.clone();let lang=language.clone();
        let notifications=EventNotifications::new(NotificationOptions{journal:paths.journal.clone(),worker:worker.clone(),preferences:Arc::new(move||pref.lock().expect("event preference lock").clone()),language:Arc::new(move||*lang.lock().expect("event language lock")),adapter,task_name:callbacks.task_name,changed:callbacks.notification_changed});
        Ok(Self{inner:Arc::new(Inner{io,worker,paths,notifications,preferences,language,admission:Mutex::new(Admission{active:false,cancel:CancellationToken::new()}),tasks:TaskTracker::new(),queue:Arc::new(Semaphore::new(16)),lifecycle:AsyncMutex::new(()),collection:AsyncMutex::new(()),latest:Mutex::new(None),generation:Mutex::new(0),store_identity:Mutex::new(None),query:Mutex::new(None),query_gate:AsyncMutex::new(()),errors:Mutex::new(vec![])})})
    }
    pub async fn start(&self)->Result<()> {
        let _lifecycle=self.inner.lifecycle.lock().await;
        let parent=self.inner.io.cancellation();check_cancel(&parent)?;
        {let admission=self.inner.admission.lock().expect("event admission lock");if admission.active{return Ok(());}}
        self.inner.tasks.reopen();
        {let mut admission=self.inner.admission.lock().expect("event admission lock");admission.cancel=parent.child_token();admission.active=true;}
        self.run(CancellationToken::new(),|inner,cancel|async move{inner.notifications.start(&cancel).await}).await
    }
    /// Closes admission first, cancels all real work, waits for worker/native futures,
    /// then removes pending notifications. Failed cleanup remains retryable.
    pub async fn stop(&self)->Result<()> {
        {let mut admission=self.inner.admission.lock().expect("event admission lock");admission.active=false;admission.cancel.cancel();self.inner.tasks.close();}
        self.inner.notifications.cancel();
        let _lifecycle=self.inner.lifecycle.lock().await;
        {let mut admission=self.inner.admission.lock().expect("event admission lock");admission.active=false;admission.cancel.cancel();self.inner.tasks.close();}
        self.inner.tasks.wait().await;
        let mut errors=std::mem::take(&mut *self.inner.errors.lock().expect("event errors lock"));
        if let Err(e)=self.inner.notifications.stop().await{errors.push(e);}
        if errors.is_empty(){Ok(())}else{Err(Error::aggregate(errors))}
    }
    pub async fn disable(&self)->Result<()>{self.stop().await}
    pub async fn quit(&self)->Result<()>{self.stop().await}
    pub async fn sleep(&self)->Result<()> {
        self.inner.notifications.set_sleeping(true);
        self.run(CancellationToken::new(),|inner,_|async move{inner.notifications.sleep().await}).await
    }
    pub async fn wake(&self)->Result<()> {
        self.run(CancellationToken::new(),|inner,_|async move{inner.notifications.wake().await}).await
    }
    pub async fn update_notification_preferences(&self,preferences:NotificationSettings)->Result<()> {
        preferences.validate()?;if !preferences.enabled{self.inner.notifications.cancel();}
        *self.inner.preferences.lock().expect("event preference lock")=preferences;
        let active=self.inner.admission.lock().expect("event admission lock").active;
        if !active{return self.inner.notifications.stop().await;}
        self.run(CancellationToken::new(),|inner,cancel|async move{inner.notifications.refresh(&cancel).await}).await
    }
    pub fn set_language(&self,language:ResolvedLanguage){*self.inner.language.lock().expect("event language lock")=language;}
    pub fn notification_snapshot(&self)->NotificationState{self.inner.notifications.snapshot()}
    pub async fn request_notification_permission(&self)->Result<NotificationState>{self.run(CancellationToken::new(),|inner,_|async move{inner.notifications.request_permission().await}).await}
    pub fn snapshot(&self)->Option<EventSnapshot>{self.inner.latest.lock().expect("event snapshot lock").clone()}
    pub async fn collect(&self,input:EventInput,cancel:&CancellationToken)->Result<EventSnapshot> {
        let generation=*self.inner.generation.lock().expect("event generation lock");
        self.run(cancel.clone(),move|inner,cancel|async move{
            let _collection=inner.collection.lock().await;check_cancel(&cancel)?;
            if *inner.generation.lock().expect("event generation lock")!=generation{if let Some(snapshot)=inner.latest.lock().expect("event snapshot lock").clone(){return Ok(snapshot);}}
            let snapshot=inner.collect(input,&cancel).await?;check_cancel(&cancel)?;
            {let mut generation=inner.generation.lock().expect("event generation lock");*generation=generation.checked_add(1).ok_or_else(||Error::invalid("event collection generation"))?;}
            *inner.latest.lock().expect("event snapshot lock")=Some(snapshot.clone());Ok(snapshot)
        }).await
    }
    pub async fn query(&self,query:EventQuery,cancel:&CancellationToken)->Result<EventPage> {
        query.validate()?;let query_cancel=cancel.child_token();let (sender,done)=watch::channel(None);
        {let mut current=self.inner.query.lock().expect("event query lock");if let Some(old)=current.replace(QueryFlight{cancel:query_cancel.clone(),done}){old.cancel.cancel();}}
        let completion=sender.clone();
        let result=self.run(query_cancel,move|inner,cancel|async move{
            let result=async{let _query=inner.query_gate.lock().await;check_cancel(&cancel)?;inner.request::<EventPage>("events-query",&inner.paths.database,serde_json::json!({"now":timestamp(),"query":query}),&cancel).await}.await;
            completion.send_replace(Some(result.as_ref().map(|_|()).map_err(Clone::clone)));result
        }).await;
        sender.send_replace(Some(result.as_ref().map(|_|()).map_err(Clone::clone)));result
    }
    pub async fn cancel_query(&self)->Result<()> {
        let flight=self.inner.query.lock().expect("event query lock").take();
        let Some(mut flight)=flight else{return Ok(())};flight.cancel.cancel();
        loop{
            let result=flight.done.borrow().clone();
            if let Some(result)=result{return match result{Err(error) if error.is_cancelled()=>Ok(()),other=>other};}
            flight.done.changed().await.map_err(|_|Error::new("OC_RESOURCE_CLOSE","事件查询未确认排空 / Event query cleanup was not confirmed"))?;
        }
    }
    async fn run<T,F,Fut>(&self,caller:CancellationToken,work:F)->Result<T>
    where T:Send+'static,F:FnOnce(Arc<Inner>,CancellationToken)->Fut+Send+'static,Fut:Future<Output=Result<T>>+Send+'static {
        check_cancel(&caller)?;
        let permit=self.inner.queue.clone().try_acquire_owned().map_err(|_|Error::limit("event pending operations",16,17))?;
        let (receiver,abandoned)={
            let admission=self.inner.admission.lock().expect("event admission lock");
            if !admission.active{return Err(Error::new("OC_EVENTS_DISABLED","本地事件已停用 / Local events disabled"));}
            let cancel=admission.cancel.child_token();check_cancel(&cancel)?;let abandoned=cancel.clone().drop_guard();
            let inner=self.inner.clone();let (sender,receiver)=oneshot::channel();
            self.inner.tasks.spawn(async move{
                let _permit=permit;let future=work(inner.clone(),cancel.clone());tokio::pin!(future);
                let result=tokio::select!{result=&mut future=>result,_=caller.cancelled()=>{cancel.cancel();future.await}};
                if let Err(result)=sender.send(result){if let Err(error)=result{if !error.is_cancelled(){let mut errors=inner.errors.lock().expect("event errors lock");if errors.len()<16{errors.push(error);}}}}
            });(receiver,abandoned)
        };
        let result=receiver.await.map_err(|_|Error::new("OC_EVENT_SUPERVISOR","事件监督任务异常结束 / Event supervisor exited unexpectedly"))?;abandoned.disarm();result
    }
}
impl Inner {
    async fn request<T:serde::de::DeserializeOwned>(&self,operation:&str,path:&Path,input:serde_json::Value,cancel:&CancellationToken)->Result<T>{let value=self.worker.request(operation,path,input,cancel).await?;serde_json::from_value(value).map_err(|_|Error::invalid("event worker response"))}
    async fn collect(&self,input:EventInput,cancel:&CancellationToken)->Result<EventSnapshot>{
        let loaded:StoredState=self.request("events-load",&self.paths.database,serde_json::json!({"now":timestamp()}),cancel).await?;
        let replaced=self.store_identity.lock().expect("event identity lock").as_ref().is_some_and(|identity|identity!=&loaded.identity);
        // The timestamp follows checkpoint IO and the caller's source sample.
        let now=timestamp();let checkpoint=loaded.checkpoint.unwrap_or_default();
        let transition=collector::observe(&checkpoint.sources,&observations(&input)?,&now)?;let mut events=transition.events;let mut sources=vec![];let mut hermes=checkpoint.hermes.clone();
        let hermes_coverage=if !input.enabled.schedules{EventCoverage{source_id:"hermes-events".into(),state:CoverageState::Disabled,since:hermes.as_ref().map(|c|c.since.clone()),observed_at:Some(now.clone()),code:Some("schedule-collection-disabled".into()),last_gap:None}}else{
            let read:Result<HermesRead>=self.request("hermes-events",&self.paths.hermes_database,serde_json::json!({"now":now,"cursor":hermes}),cancel).await;
            match read{Ok(read)=>{let jobs=input.snapshot.schedules.data.as_ref().map_or(&[][..],|d|d.jobs.as_slice());events.extend(collector::execution_events(&read,jobs,&now)?);hermes=Some(read.cursor);read.coverage},Err(error)=>{if error.is_cancelled()||error.is_cleanup(){return Err(error);}sources.push(SourceStatus::new("hermes-events","Hermes 异常记录 / Hermes events",SourceState::Error,error.message.clone()));EventCoverage{source_id:"hermes-events".into(),state:CoverageState::Unavailable,since:hermes.as_ref().map(|c|c.since.clone()),observed_at:Some(now.clone()),code:Some(error.code),last_gap:None}}}
        };
        if events.len()>EVENT_BATCH_LIMIT{return Err(Error::limit("event batch",EVENT_BATCH_LIMIT,events.len()));}
        let prior=checkpoint.coverage.iter().find(|c|c.source_id=="source-events");
        let source_coverage=EventCoverage{source_id:"source-events".into(),state:if transition.gap{CoverageState::Gap}else if transition.deferred{CoverageState::CatchingUp}else{CoverageState::Observing},since:prior.and_then(|c|c.since.clone()).or(Some(now.clone())),observed_at:Some(now.clone()),code:if transition.gap{Some("source-observation-gap".into())}else if transition.deferred{Some("source-event-backlog".into())}else{None},last_gap:None};
        let mut coverage=vec![collector::preserve_gap(hermes_coverage,checkpoint.coverage.iter().find(|c|c.source_id=="hermes-events"),&now),collector::preserve_gap(source_coverage,prior,&now)];
        let store_prior=checkpoint.coverage.iter().find(|c|c.source_id=="event-store");
        if replaced||store_prior.is_some(){
            let mut store=collector::preserve_gap(EventCoverage{source_id:"event-store".into(),state:if replaced{CoverageState::Gap}else{CoverageState::Observing},since:Some(now.clone()),observed_at:Some(now.clone()),code:if replaced{Some("event-store-replaced".into())}else{None},last_gap:None},store_prior,&now);
            if replaced&&store_prior.is_none(){if let Some(previous)=self.latest.lock().expect("event snapshot lock").as_ref(){if let Some(gap)=&mut store.last_gap{gap.from=previous.collected_at.clone().min(now.clone());}}}
            coverage.push(store);
        }
        let next=Checkpoint{version:1,hermes,sources:transition.sources,coverage,observed_at:Some(now.clone())};
        let committed:CommitResult=self.request("events-commit",&self.paths.database,serde_json::json!({"identity":loaded.identity,"now":now,"revision":loaded.revision,"checkpoint":next,"events":events}),cancel).await?;check_cancel(cancel)?;
        *self.store_identity.lock().expect("event identity lock")=Some(committed.identity.clone());
        let mut added=vec![];for row in &committed.added{let event=events.get(row.index).ok_or_else(||Error::invalid("event commit index"))?;added.push((row.sequence,event.clone()));}
        if let Err(error)=self.notifications.committed_cancellable(NotificationBatch{identity:committed.identity,events:added},cancel).await{
            sources.push(SourceStatus::new("event-notifications","系统通知 / System notifications",SourceState::Error,format!("{} ({})",error.message,error.code)));
            if error.is_cleanup(){let mut errors=self.errors.lock().expect("event errors lock");if errors.len()<16{errors.push(error);}}
        }
        check_cancel(cancel)?;
        for coverage in &committed.checkpoint.coverage{if coverage.source_id=="event-store"||sources.iter().any(|s|s.id==coverage.source_id){continue;}let state=match coverage.state{CoverageState::Disabled=>SourceState::Disabled,CoverageState::Unavailable=>SourceState::Error,CoverageState::Gap|CoverageState::CatchingUp=>SourceState::Partial,_=>SourceState::Ok};sources.push(SourceStatus::new(&coverage.source_id,if coverage.source_id=="hermes-events"{"Hermes 异常记录 / Hermes events"}else{"来源可用性事件 / Source availability events"},state,format!("覆盖状态 / Coverage: {:?}{}",coverage.state,coverage.code.as_ref().map_or(String::new(),|c|format!(" ({c})")))));}
        sources.insert(0,SourceStatus::new("event-store","本地事件存储 / Local event store",if replaced{SourceState::Partial}else if committed.retention.count==0{SourceState::Empty}else{SourceState::Ok},format!("7天 / 10000条 / 20MiB；当前 {} 条，已移除 {} 条{}",committed.retention.count,committed.retention.deleted_count,if replaced{"；数据库已替换 / Database replaced"}else{""})));
        Ok(EventSnapshot{collected_at:now,sources,revision:committed.revision,retention:committed.retention,coverage:committed.checkpoint.coverage})
    }
}
fn observations(input:&EventInput)->Result<Vec<collector::Observation>> {
    fn add<T>(out:&mut Vec<collector::Observation>,section:MonitorSection,enabled:bool,state:&CollectorState<T>,sources:&[SourceStatus])->Result<()>{
        if let Some(at)=&state.last_attempt_at{out.push(collector::Observation{id:format!("collection:{}",section.as_str()),section,state:if !enabled{SourceState::Disabled}else if state.error.is_some(){SourceState::Error}else if state.last_success_at.is_some(){SourceState::Ok}else{SourceState::Unsupported},observed_at:at.clone()});}
        for source in sources{if let Some(at)=&source.last_attempt_at{out.push(collector::Observation{id:source.id.clone(),section,state:if enabled{source.state}else{SourceState::Disabled},observed_at:at.clone()});}if out.len()>64{return Err(Error::limit("event sources",64,out.len()));}}
        if out.len()>64{return Err(Error::limit("event sources",64,out.len()));}Ok(())
    }
    let mut out=vec![];let snapshot=&input.snapshot;
    add(&mut out,MonitorSection::Agents,input.enabled.agents,&snapshot.agents,snapshot.agents.data.as_ref().map_or(&[][..],|d|d.sources.as_slice()))?;
    add(&mut out,MonitorSection::Schedules,input.enabled.schedules,&snapshot.schedules,snapshot.schedules.data.as_ref().map_or(&[][..],|d|d.sources.as_slice()))?;
    add(&mut out,MonitorSection::System,input.enabled.system,&snapshot.system,snapshot.system.data.as_ref().map_or(&[][..],|d|d.sources.as_slice()))?;Ok(out)
}

#[cfg(test)]
mod service_tests;
