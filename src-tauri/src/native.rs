use std::{collections::BTreeMap, ffi::{c_char,c_void,CStr,CString}, panic::{catch_unwind,AssertUnwindSafe}, path::PathBuf, ptr, sync::{Arc,Mutex,OnceLock,atomic::{AtomicBool,AtomicU64,AtomicUsize,Ordering}}, time::Duration};
use futures_util::future::BoxFuture;
use serde::Deserialize;
use serde_json::{json,Value};
use tokio::sync::{oneshot,Notify,OwnedSemaphorePermit,Semaphore};
use tokio_util::sync::CancellationToken;
use oc_core::{diagnostics::DiagnosticNative,error::{Error,Result,check_cancel},events::{NotificationAdapter,NotificationMessage,NativeDelivery,NativeRemoval,NativeDrain},settings::NotificationPermission};
use oc_native_bridge as ffi;
type Sink=Arc<dyn Fn(Value)+Send+Sync>;
struct Pending { sender:oneshot::Sender<Result<Value>>, _permit:OwnedSemaphorePermit, owner:Option<u64> }
#[derive(Clone)]struct Owner { window:u64, cancel:CancellationToken }
struct Inner {
    context:AtomicUsize, userdata:AtomicUsize, app:OnceLock<tauri::AppHandle>,
    pending:Mutex<BTreeMap<u64,Pending>>, owners:Mutex<BTreeMap<u64,Owner>>,
    next:AtomicU64, permits:Arc<Semaphore>, settled:Notify, sink:Sink, fault:AtomicBool,
}
pub struct NativeBridge { inner:Arc<Inner> }
fn failure(code:&str)->Error {Error::new(code,format!("原生操作失败 / Native operation failed: {code}"))}
fn operation(command:&CStr)->&'static str {
    match command.to_bytes() {
        b"operationRead"=>"operationRead", b"systemRead"=>"systemRead", b"themeSet"=>"themeSet",
        b"dockSet"=>"dockSet", b"sleepSet"=>"sleepSet", b"loginRead"=>"loginRead", b"loginSet"=>"loginSet",
        b"windowRead"=>"windowRead", b"glassSet"=>"glassSet", b"clipboardWrite"=>"clipboardWrite",
        b"openReleaseNotes"=>"openReleaseNotes", b"notificationRemove"=>"notificationRemove",
        b"accessibilityRead"=>"accessibilityRead", b"openPermissionSettings"=>"openPermissionSettings",
        b"permissionQuery"=>"permissionQuery", b"permissionRequest"=>"permissionRequest",
        b"notificationSend"=>"notificationSend", b"notificationState"=>"notificationState", b"savePanel"=>"savePanel",
        _=>"unknown",
    }
}
fn with_operation(mut error:Error,operation:&'static str)->Error {
    error.message.push_str("; operation=");error.message.push_str(operation);error
}
fn boundary_error(message:&str,operation:&'static str)->Error {
    let Some((stage,reason))=message.split_once('\n') else{return with_operation(failure("OC_NATIVE_PROTOCOL"),operation);};
    if !matches!(stage,"boundary"|"mainThread"|"application"|"stateAllocation"|"launchEvent"|"activationPolicy"|"hiddenWindows"|"inactiveApplication"|"appearanceObserver"|"accessibilityObserver"|"sleepObserver"|"wakeObserver"|"launchObserver"|"localeObserver"|"notificationCenter"|"scheduleOperation") {
        return with_operation(failure("OC_NATIVE_PROTOCOL"),operation);
    }
    let mut error=with_operation(controlled(reason),operation);error.message.push_str("; stage=");error.message.push_str(stage);error
}
fn input(command:&str,args:Value)->Result<(CString,CString)>{
    if command.is_empty()||command.len()>64||!args.is_object(){return Err(Error::invalid("native input"));}
    let args=serde_json::to_vec(&args).map_err(|_|Error::invalid("native arguments"))?;
    if args.len()>256*1024{return Err(Error::limit("native arguments",256*1024,args.len()));}
    Ok((CString::new(command).map_err(|_|Error::invalid("native command"))?,CString::new(args).map_err(|_|Error::invalid("native arguments"))?))
}
/// Raw OS exception descriptions never enter IPC. Only known categories survive.
fn controlled(message:&str)->Error {
    let code=if message.contains("still pending")||message.contains("pending; context retained") {"OC_NATIVE_PENDING"}
        else if message.contains("revocation pending") {"OC_NATIVE_PENDING"}
        else if message.contains("forbidden in acceptance")||message.contains("native interaction forbidden") {"OC_NATIVE_HEADLESS"}
        else if message.contains("clipboard") {"OC_DIAGNOSTIC_CLIPBOARD"}
        else if message.contains("window")||message.contains("NSWindow") {"OC_NATIVE_WINDOW"}
        else if message.contains("main thread") {"OC_NATIVE_THREAD"}
        else if message.contains("SMAppService")||message.contains("login change") {"OC_NATIVE_LOGIN"}
        else if message.contains("UserNotifications") {"OC_NATIVE_NOTIFICATIONS"}
        else if message.contains("IOPM") {"OC_NATIVE_SLEEP"}
        else if message.contains("Glass")||message.contains("glass") {"OC_NATIVE_GLASS"}
        else {"OC_NATIVE_FAILURE"};failure(code)
}
unsafe fn native_error(pointer:*mut c_char,operation:&'static str)->Error {
    if pointer.is_null(){return with_operation(failure("OC_NATIVE_FAILURE"),operation);}
    let error=boundary_error(&unsafe{CStr::from_ptr(pointer)}.to_string_lossy(),operation);unsafe{ffi::oc_native_string_free(pointer)};error
}
unsafe fn native_result(status:i32,output:*mut c_char,error:*mut c_char,operation:&'static str)->Result<Value>{
    if status!=0 {if !output.is_null(){unsafe{ffi::oc_native_string_free(output)}}return Err(unsafe{native_error(error,operation)});}
    if !error.is_null(){unsafe{ffi::oc_native_string_free(error)}}
    if output.is_null(){return Err(with_operation(failure("OC_NATIVE_PROTOCOL"),operation));}
    let bytes=unsafe{CStr::from_ptr(output)}.to_bytes();
    let result=if bytes.len()>65536{Err(failure("OC_NATIVE_PROTOCOL"))}else{serde_json::from_slice(bytes).map_err(|_|failure("OC_NATIVE_PROTOCOL"))};
    unsafe{ffi::oc_native_string_free(output)};result.map_err(|error|with_operation(error,operation))
}
unsafe extern "C" fn callback(userdata:*mut c_void,text:*const c_char){
    if userdata.is_null()||text.is_null(){return;}
    let inner=unsafe{&*userdata.cast::<Inner>()};
    let outcome=catch_unwind(AssertUnwindSafe(||->Result<()>{
        let bytes=unsafe{CStr::from_ptr(text)}.to_bytes();if bytes.len()>65536{return Err(failure("OC_NATIVE_PROTOCOL"));}
        let envelope:Value=serde_json::from_slice(bytes).map_err(|_|failure("OC_NATIVE_PROTOCOL"))?;
        let id=envelope["requestId"].as_u64().ok_or_else(||failure("OC_NATIVE_PROTOCOL"))?;
        let event=envelope["event"].as_str().ok_or_else(||failure("OC_NATIVE_PROTOCOL"))?;
        if id>0 {
            if !matches!(event,"permission"|"notificationAccepted"|"notificationState"|"savePanel"|"operationSettled"|"operationFailed"){return Err(failure("OC_NATIVE_PROTOCOL"));}
            let pending=inner.pending.lock().map_err(|_|failure("OC_NATIVE_STATE"))?.remove(&id).ok_or_else(||failure("OC_NATIVE_PROTOCOL"))?;
            let value=if event=="operationSettled" {Err(Error::cancelled())}
                else if let Some(message)=envelope["error"].as_str(){Err(controlled(message))}
                else {envelope.get("value").cloned().ok_or_else(||failure("OC_NATIVE_PROTOCOL"))};
            let _=pending.sender.send(value);
            inner.settled.notify_waiters();
        }else{
            let envelope=if envelope.get("error").is_some(){json!({"event":event,"requestId":0,"error":controlled(envelope["error"].as_str().unwrap_or("unknown"))})}else{envelope};
            (inner.sink)(envelope);
        }
        Ok(())
    }));
    if !matches!(outcome,Ok(Ok(()))){inner.fault.store(true,Ordering::Release);eprintln!("OC_NATIVE_CALLBACK: callback failed; bridge retained");}
}
impl Inner {
    fn context(&self)->Result<*mut ffi::Context>{let address=self.context.load(Ordering::Acquire);if address==0{return Err(failure("OC_NATIVE_CLOSED"));}if self.fault.load(Ordering::Acquire){return Err(failure("OC_NATIVE_CALLBACK"));}Ok(address as *mut ffi::Context)}
    fn owner(&self,id:u64)->Result<Owner>{self.owners.lock().map_err(|_|failure("OC_NATIVE_STATE"))?.get(&id).cloned().ok_or_else(||failure("OC_NATIVE_OWNER"))}
    fn sync(&self,command:&CStr,args:&CStr)->Result<Value>{
        let context=self.context()?;let mut output=ptr::null_mut();let mut error=ptr::null_mut();
        let status=unsafe{ffi::oc_native_call(context,command.as_ptr(),args.as_ptr(),&mut output,&mut error)};
        unsafe{native_result(status,output,error,operation(command))}
    }
    async fn main<T:Send+'static>(self:&Arc<Self>,work:impl FnOnce(&Arc<Inner>)->Result<T>+Send+'static)->Result<T>{
        let app=self.app.get().ok_or_else(||failure("OC_NATIVE_UNATTACHED"))?;
        let (tx,rx)=oneshot::channel();let inner=self.clone();
        app.run_on_main_thread(move||{let result=catch_unwind(AssertUnwindSafe(||work(&inner))).unwrap_or_else(|_|Err(failure("OC_NATIVE_PANIC")));let _=tx.send(result);}).map_err(|_|failure("OC_NATIVE_DISPATCH"))?;
        rx.await.map_err(|_|failure("OC_NATIVE_DISPATCH"))?
    }
    fn cancel_main(&self,id:u64)->Result<()>{
        if !self.pending.lock().map_err(|_|failure("OC_NATIVE_STATE"))?.contains_key(&id){return Ok(());}
        let context=self.context()?;let mut output=ptr::null_mut();let mut error=ptr::null_mut();
        let status=unsafe{ffi::oc_native_cancel(context,id,&mut output,&mut error)};
        unsafe{native_result(status,output,error,"cancel")}.map(|_|()).map_err(|error|Error::cleanup("native request",error))
    }
    async fn wait_settled(&self,id:u64)->Result<()>{
        loop{
            let notified=self.settled.notified();tokio::pin!(notified);notified.as_mut().enable();
            if !self.pending.lock().map_err(|_|failure("OC_NATIVE_STATE"))?.contains_key(&id){return Ok(());}
            notified.await;
        }
    }
}
struct RequestGuard { inner:Arc<Inner>,id:Arc<AtomicU64>,cancel:CancellationToken,armed:bool }
impl Drop for RequestGuard {
    fn drop(&mut self){
        if !self.armed{return;}self.cancel.cancel();let id=self.id.load(Ordering::Acquire);if id==0{return;}
        let inner=self.inner.clone();if let Some(app)=self.inner.app.get(){
            if app.run_on_main_thread(move||{if let Err(error)=inner.cancel_main(id){eprintln!("abandoned native cancellation: {error}");}}).is_err(){self.inner.fault.store(true,Ordering::Release);eprintln!("OC_NATIVE_DISPATCH: abandoned native request retained");}
        }
    }
}
impl NativeBridge {
    /// Main thread in Tauri setup, after Tao initializes its NSApplication subclass.
    /// Only successful release frees the retained Arc used as C callback userdata.
    pub fn bootstrap(acceptance:bool,sink:Sink)->Result<Arc<Self>>{
        let inner=Arc::new(Inner{context:AtomicUsize::new(0),userdata:AtomicUsize::new(0),app:OnceLock::new(),pending:Mutex::new(BTreeMap::new()),owners:Mutex::new(BTreeMap::new()),next:AtomicU64::new(1),permits:Arc::new(Semaphore::new(8)),settled:Notify::new(),sink,fault:AtomicBool::new(false)});
        let userdata=Arc::into_raw(inner.clone());let mut context=ptr::null_mut();let mut error=ptr::null_mut();
        let status=unsafe{ffi::oc_native_create(i32::from(acceptance),callback,userdata.cast_mut().cast(),&mut context,&mut error)};
        if status!=0{unsafe{drop(Arc::from_raw(userdata))};return Err(unsafe{native_error(error,"create")});}
        inner.context.store(context as usize,Ordering::Release);inner.userdata.store(userdata as usize,Ordering::Release);
        Ok(Arc::new(Self{inner}))
    }
    pub fn attach(&self,app:tauri::AppHandle)->Result<()>{self.inner.app.set(app).map_err(|_|failure("OC_NATIVE_ATTACHED"))}
    pub fn register_owner(&self,owner:u64,window:u64)->Result<()>{
        if owner==0||window==0{return Err(Error::invalid("native owner"));}
        let mut owners=self.inner.owners.lock().map_err(|_|failure("OC_NATIVE_STATE"))?;
        if owners.len()>=8||owners.contains_key(&owner)||owners.values().any(|item|item.window==window){return Err(failure("OC_NATIVE_OWNER"));}
        owners.insert(owner,Owner{window,cancel:CancellationToken::new()});Ok(())
    }
    pub async fn revoke_owner(&self,owner:u64)->Result<()>{
        let removed=self.inner.owners.lock().map_err(|_|failure("OC_NATIVE_STATE"))?.remove(&owner);
        if let Some(removed)=removed{removed.cancel.cancel();}
        let ids:Vec<u64>=self.inner.pending.lock().map_err(|_|failure("OC_NATIVE_STATE"))?.iter().filter_map(|(id,pending)|(pending.owner==Some(owner)).then_some(*id)).collect();
        for id in ids{self.inner.main(move|inner|inner.cancel_main(id)).await?;self.inner.wait_settled(id).await?;}Ok(())
    }
    /// Main-thread read before attach; lets startup select language/login behavior
    /// without blocking Tauri's main-thread dispatcher.
    pub fn bootstrap_read(&self,command:&str)->Result<Value>{
        if self.inner.app.get().is_some()||!matches!(command,"systemRead"|"loginRead"){return Err(failure("OC_NATIVE_BOOTSTRAP_READ"));}
        let (command,args)=input(command,json!({}))?;self.inner.sync(&command,&args)
    }
    pub async fn call(&self,command:&str,args:Value)->Result<Value>{
        if !matches!(command,"systemRead"|"themeSet"|"dockSet"|"sleepSet"|"loginRead"|"loginSet"|"windowRead"|"glassSet"|"notificationRemove"|"accessibilityRead"|"openPermissionSettings"){return Err(Error::invalid("native command"));}
        let (command,args)=input(command,args)?;
        let permit=self.inner.permits.clone().try_acquire_owned().map_err(|_|failure("OC_NATIVE_BUSY"))?;
        self.inner.main(move|inner|{let _permit=permit;inner.sync(&command,&args)}).await
    }
    async fn request(&self,command:&str,args:Value,timeout:Duration,cancel:&CancellationToken,owner:Option<u64>,wait_cancel:bool)->Result<Value>{
        check_cancel(cancel)?;let (command,args)=input(command,args)?;
        let request_operation=operation(&command);
        let deadline=tokio::time::Instant::now()+timeout;
        let permit=self.inner.permits.clone().try_acquire_owned().map_err(|_|failure("OC_NATIVE_BUSY"))?;
        let token=cancel.child_token();let id_cell=Arc::new(AtomicU64::new(0));
        let mut guard=RequestGuard{inner:self.inner.clone(),id:id_cell.clone(),cancel:token.clone(),armed:true};
        let (tx,mut rx)=oneshot::channel();let start_token=token.clone();
        let id=self.inner.main(move|inner|{
            check_cancel(&start_token)?;if let Some(owner)=owner{let owner=inner.owner(owner)?;check_cancel(&owner.cancel)?;}
            let context=inner.context()?;let id=inner.next.fetch_add(1,Ordering::AcqRel);if id==0||id==u64::MAX{return Err(failure("OC_NATIVE_SEQUENCE"));}
            inner.pending.lock().map_err(|_|failure("OC_NATIVE_STATE"))?.insert(id,Pending{sender:tx,_permit:permit,owner});
            id_cell.store(id,Ordering::Release);
            if start_token.is_cancelled(){inner.pending.lock().map_err(|_|failure("OC_NATIVE_STATE"))?.remove(&id);return Err(Error::cancelled());}
            let mut error=ptr::null_mut();let status=unsafe{ffi::oc_native_start(context,id,command.as_ptr(),args.as_ptr(),&mut error)};
            if status!=0{
                let error=unsafe{native_error(error,operation(&command))};
                let (read,args)=input("operationRead",json!({}))?;
                match inner.sync(&read,&args){
                    Ok(state) if state["osPending"]==false || state["requestId"].as_u64().is_some_and(|pending|pending!=id)=>{inner.pending.lock().map_err(|_|failure("OC_NATIVE_STATE"))?.remove(&id);return Err(error);},
                    Ok(_)=>return Err(Error::aggregate(vec![error,failure("OC_NATIVE_PENDING")])),
                    Err(read_error)=>return Err(Error::aggregate(vec![error,read_error])),
                }
            }
            Ok(id)
        }).await?;
        let outcome=tokio::select!{
            value=&mut rx=>{guard.armed=false;return value.map_err(|_|failure("OC_NATIVE_CALLBACK"))?.map_err(|error|with_operation(error,request_operation));},
            _=cancel.cancelled()=>Error::cancelled(),
            _=tokio::time::sleep_until(deadline)=>Error::timeout("native request"),
        };
        token.cancel();
        let cancellation=self.inner.main(move|inner|inner.cancel_main(id)).await;
        guard.armed=false;
        cancellation.map_err(|error|Error::aggregate(vec![outcome.clone(),error]))?;
        // OS authorization cannot be dismissed. Its ledger/permit survives this
        // return until operationSettled. Owned panels must finish real cleanup.
        if wait_cancel{self.inner.wait_settled(id).await?;}
        Err(outcome)
    }
    /// Only for startup failure before attach, on the bootstrap main thread.
    pub fn release_before_attach(&self)->Result<()>{
        if self.inner.app.get().is_some(){return Err(failure("OC_NATIVE_ATTACHED"));}
        release_main(&self.inner)
    }
    pub async fn release(&self)->Result<()>{self.inner.main(|inner|release_main(inner)).await}
    pub async fn open_release_notes(&self,url:&str,cancel:&CancellationToken)->Result<()>{
        check_cancel(cancel)?;
        let base="https://github.com/Zixiaobowen/oc-chan/releases";
        if url.len()>2048||!(url==base||url.strip_prefix(&format!("{base}/tag/")).is_some_and(|tag|!tag.is_empty()&&tag.bytes().all(|b|b.is_ascii_alphanumeric()||b"._-".contains(&b)))){return Err(Error::invalid("release URL"));}
        let (command,args)=input("openReleaseNotes",json!({"url":url}))?;let cancel=cancel.clone();
        let permit=self.inner.permits.clone().try_acquire_owned().map_err(|_|failure("OC_NATIVE_BUSY"))?;
        self.inner.main(move|inner|{let _permit=permit;check_cancel(&cancel)?;inner.sync(&command,&args).map(|_|())}).await
    }
    async fn notification_state(&self,cancel:&CancellationToken)->Result<NotificationRead>{
        let value=self.request("notificationState",json!({}),Duration::from_secs(2),cancel,None,false).await?;
        let state:NotificationRead=serde_json::from_value(value).map_err(|_|failure("OC_NATIVE_PROTOCOL"))?;
        if [&state.pending,&state.delivered,&state.revoking,&state.owned].iter().any(|list|list.len()>8||list.iter().any(|id|id.len()>128)){return Err(failure("OC_NATIVE_PROTOCOL"));}Ok(state)
    }
}
#[derive(Deserialize)]struct NotificationRead{pending:Vec<String>,delivered:Vec<String>,revoking:Vec<String>,owned:Vec<String>}
impl NotificationAdapter for NativeBridge{
    fn permission<'a>(&'a self,request:bool,cancel:&'a CancellationToken)->BoxFuture<'a,Result<NotificationPermission>>{Box::pin(async move{
        let value=self.request(if request{"permissionRequest"}else{"permissionQuery"},json!({}),Duration::from_secs(if request{30}else{2}),cancel,None,false).await?;
        match value["permission"].as_str(){Some("not-determined")=>Ok(NotificationPermission::NotDetermined),Some("denied")=>Ok(NotificationPermission::Denied),Some("authorized")=>Ok(NotificationPermission::Authorized),Some("provisional")=>Ok(NotificationPermission::Provisional),_=>Err(failure("OC_NATIVE_PROTOCOL"))}
    })}
    fn submit<'a>(&'a self,message:NotificationMessage,cancel:&'a CancellationToken)->BoxFuture<'a,Result<NativeDelivery>>{Box::pin(async move{
        let value=self.request("notificationSend",serde_json::to_value(message).map_err(|_|Error::invalid("notification"))?,Duration::from_secs(3),cancel,None,false).await?;
        if value["scheduled"]!=true{return Err(failure("OC_NATIVE_NOTIFICATION"));}Ok(NativeDelivery::Pending)
    })}
    fn settle<'a>(&'a self,id:&'a str,cancel:&'a CancellationToken)->BoxFuture<'a,Result<NativeDelivery>>{Box::pin(async move{
        let state=self.notification_state(cancel).await?;
        Ok(if state.revoking.iter().any(|item|item==id){NativeDelivery::Pending}else if state.delivered.iter().any(|item|item==id){NativeDelivery::Displayed}else if state.pending.iter().any(|item|item==id){NativeDelivery::Pending}else if state.owned.iter().any(|item|item==id){NativeDelivery::Unconfirmed}else{NativeDelivery::Removed})
    })}
    fn remove<'a>(&'a self,id:&'a str)->BoxFuture<'a,Result<NativeRemoval>>{Box::pin(async move{
        let state=self.notification_state(&CancellationToken::new()).await?;
        if !state.owned.iter().any(|item|item==id){return Ok(NativeRemoval::Confirmed);}
        self.call("notificationRemove",json!({"id":id})).await?;
        let state=self.notification_state(&CancellationToken::new()).await?;
        Ok(if state.owned.iter().any(|item|item==id)||state.pending.iter().any(|item|item==id)||state.delivered.iter().any(|item|item==id){NativeRemoval::Pending}else{NativeRemoval::Confirmed})
    })}
    fn drain(&self)->BoxFuture<'_,Result<NativeDrain>>{Box::pin(async move{
        let cancel=CancellationToken::new();let state=self.notification_state(&cancel).await?;
        for id in &state.owned{self.call("notificationRemove",json!({"id":id})).await?;}
        let state=if state.owned.is_empty(){state}else{self.notification_state(&cancel).await?};
        Ok(if state.owned.is_empty()&&state.pending.is_empty()&&state.delivered.is_empty()&&state.revoking.is_empty(){NativeDrain::Complete}else{NativeDrain::Pending})
    })}
}
impl DiagnosticNative for NativeBridge{
    fn choose_file<'a>(&'a self,owner:u64,cancel:&'a CancellationToken)->BoxFuture<'a,Result<Option<PathBuf>>>{Box::pin(async move{
        let registered=self.inner.owner(owner)?;let combined=registered.cancel.child_token();
        let work=self.request("savePanel",json!({"window":registered.window}),Duration::from_secs(600),&combined,Some(owner),true);tokio::pin!(work);
        let value=tokio::select!{result=&mut work=>result,_=cancel.cancelled()=>{combined.cancel();work.await}}?;
        if value.get("path")==Some(&Value::Null){return Ok(None);}
        let path=value["path"].as_str().filter(|path|path.len()<=4096&&!path.chars().any(|c|c.is_control())).ok_or_else(||failure("OC_NATIVE_PROTOCOL"))?;
        if !PathBuf::from(path).is_absolute(){return Err(failure("OC_NATIVE_PROTOCOL"));}Ok(Some(PathBuf::from(path)))
    })}
    fn copy<'a>(&'a self,owner:u64,text:&'a str,cancel:&'a CancellationToken)->BoxFuture<'a,Result<()>>{Box::pin(async move{
        check_cancel(cancel)?;if text.is_empty()||text.len()>256*1024{return Err(Error::invalid("diagnostic clipboard"));}
        let text=CString::new(text).map_err(|_|Error::invalid("diagnostic clipboard"))?;let cancel=cancel.clone();
        let permit=self.inner.permits.clone().try_acquire_owned().map_err(|_|failure("OC_NATIVE_BUSY"))?;
        self.inner.main(move|inner|{
            let _permit=permit;check_cancel(&cancel)?;let owner=inner.owner(owner)?;check_cancel(&owner.cancel)?;
            let context=inner.context()?;let mut error=ptr::null_mut();
            if unsafe{ffi::oc_native_clipboard(context,owner.window,text.as_ptr(),&mut error)}!=0{return Err(unsafe{native_error(error,"clipboardWrite")});}Ok(())
        }).await
    })}
}

fn release_main(inner:&Arc<Inner>)->Result<()>{
    if inner.context.load(Ordering::Acquire)==0{return Ok(());}
    let mut error=ptr::null_mut();let context=inner.context.load(Ordering::Acquire) as *mut ffi::Context;
    if unsafe{ffi::oc_native_release(context,&mut error)}!=0{return Err(Error::cleanup("native context",unsafe{native_error(error,"release")}));}
    inner.context.store(0,Ordering::Release);inner.permits.close();
    let userdata=inner.userdata.swap(0,Ordering::AcqRel);
    if userdata!=0{unsafe{drop(Arc::from_raw(userdata as *const Inner))};}
    inner.pending.lock().map_err(|_|failure("OC_NATIVE_STATE"))?.clear();inner.settled.notify_waiters();
    inner.owners.lock().map_err(|_|failure("OC_NATIVE_STATE"))?.clear();Ok(())
}

#[cfg(test)]mod tests{
    use super::*;
    fn inner(sink:Sink)->Arc<Inner>{Arc::new(Inner{context:AtomicUsize::new(0),userdata:AtomicUsize::new(0),app:OnceLock::new(),pending:Mutex::new(BTreeMap::new()),owners:Mutex::new(BTreeMap::new()),next:AtomicU64::new(1),permits:Arc::new(Semaphore::new(8)),settled:Notify::new(),sink,fault:AtomicBool::new(false)})}
    #[tokio::test]async fn cancelled_waiter_retains_capacity_until_native_settlement(){
        let inner=inner(Arc::new(|_|{}));let (tx,rx)=oneshot::channel();
        let permit=inner.permits.clone().try_acquire_owned().unwrap();inner.pending.lock().unwrap().insert(9,Pending{sender:tx,_permit:permit,owner:Some(1)});
        drop(rx);assert_eq!(inner.permits.available_permits(),7);assert!(inner.pending.lock().unwrap().contains_key(&9));
        let event=CString::new(r#"{"event":"operationSettled","requestId":9,"value":{"cancelled":true}}"#).unwrap();
        unsafe{callback(Arc::as_ptr(&inner).cast_mut().cast(),event.as_ptr())};
        assert_eq!(inner.permits.available_permits(),8);assert!(inner.pending.lock().unwrap().is_empty());
    }
    #[test]fn callback_panic_never_unwinds_through_c_abi(){
        let inner=inner(Arc::new(|_|panic!("simulated sink panic")));
        let event=CString::new(r#"{"event":"systemChanged","requestId":0,"value":{}}"#).unwrap();
        unsafe{callback(Arc::as_ptr(&inner).cast_mut().cast(),event.as_ptr())};assert!(inner.fault.load(Ordering::Acquire));
    }
    #[test]fn malformed_callback_preserves_pending_identity(){
        let inner=inner(Arc::new(|_|{}));let (tx,_rx)=oneshot::channel();
        inner.pending.lock().unwrap().insert(1,Pending{sender:tx,_permit:inner.permits.clone().try_acquire_owned().unwrap(),owner:None});
        let event=CString::new("invalid").unwrap();unsafe{callback(Arc::as_ptr(&inner).cast_mut().cast(),event.as_ptr())};
        assert!(inner.pending.lock().unwrap().contains_key(&1));assert_eq!(inner.permits.available_permits(),7);assert!(inner.fault.load(Ordering::Acquire));
    }
    #[test]fn boundary_errors_preserve_only_known_operation_and_stage(){
        let error=boundary_error("activationPolicy\n/Users/private/credentials secret","create");
        assert_eq!(error.code,"OC_NATIVE_FAILURE");
        assert!(error.message.contains("operation=create; stage=activationPolicy"));
        assert!(!error.message.contains("private"));
        let error=boundary_error("notificationCenter\nUserNotifications requires a real application bundle identifier","permissionQuery");
        assert_eq!(error.code,"OC_NATIVE_NOTIFICATIONS");
        assert!(error.message.contains("operation=permissionQuery; stage=notificationCenter"));
        let error=boundary_error("/Users/private\nsecret","create");
        assert_eq!(error.code,"OC_NATIVE_PROTOCOL");assert!(!error.message.contains("private"));
        assert_eq!(boundary_error("missing stage","create").code,"OC_NATIVE_PROTOCOL");
        assert_eq!(operation(c"systemRead"),"systemRead");
        assert_eq!(operation(c"private"),"unknown");
    }
    #[test]fn os_errors_are_controlled_and_owner_reuse_is_rejected(){
        assert!(!controlled("/Users/private/credentials secret").message.contains("private"));
        let bridge=NativeBridge{inner:inner(Arc::new(|_|{}))};bridge.register_owner(1,42).unwrap();assert!(bridge.register_owner(1,43).is_err());assert!(bridge.register_owner(2,42).is_err());
    }
}
