use std::{future::Future,sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}}};
use oc_core::{diagnostics::Diagnostics,error::{Error,Result,check_cancel}};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::{sync::CancellationToken,task::TaskTracker};
use crate::api::View;
#[derive(Default)]
pub struct QuerySlot { token: Mutex<Option<CancellationToken>>, gate: AsyncMutex<()>, cleanup: Mutex<Option<Error>> }
impl QuerySlot {
    pub async fn run<T, F, Fut>(&self, parent: &CancellationToken, work: F) -> Result<T>
    where F: FnOnce(CancellationToken) -> Fut, Fut: Future<Output = Result<T>> {
        check_cancel(parent)?;
        let token = parent.child_token();
        if let Some(previous) = self.token.lock().map_err(|_| Error::invalid("query state"))?.replace(token.clone()) { previous.cancel(); }
        let _gate = tokio::select! { biased; _ = token.cancelled() => return Err(Error::cancelled()), gate = self.gate.lock() => gate };
        check_cancel(&token)?;
        let result = work(token).await;
        if let Err(error) = &result { if error.is_cleanup() { *self.cleanup.lock().map_err(|_| Error::invalid("query cleanup"))? = Some(error.clone()); } }
        result
    }
    pub async fn cancel(&self) -> Result<()> {
        if let Some(token) = self.token.lock().map_err(|_| Error::invalid("query state"))?.take() { token.cancel(); }
        let _gate = self.gate.lock().await;
        match self.cleanup.lock().map_err(|_| Error::invalid("query cleanup"))?.clone() { Some(error) => Err(error), None => Ok(()) }
    }
}


pub struct Session {
 pub id:u64,pub view:View,pub cancel:CancellationToken,pub tasks:TaskTracker,
 pub history:QuerySlot,pub events:QuerySlot,pub diagnostics:Option<Arc<Diagnostics>>,
 pub native_registered:AtomicBool,pub settings_registered:AtomicBool,
 pub committed:AtomicBool,pub action_completed:AtomicBool,
}
impl Session {
 pub fn new(id:u64,view:View,diagnostics:Option<Arc<Diagnostics>>)->Self { Self{id,view,cancel:CancellationToken::new(),tasks:TaskTracker::new(),history:QuerySlot::default(),events:QuerySlot::default(),diagnostics,native_registered:AtomicBool::new(false),settings_registered:AtomicBool::new(false),committed:AtomicBool::new(false),action_completed:AtomicBool::new(false)} }
 pub fn invalidate(&self){self.cancel.cancel();self.tasks.close();}
}
