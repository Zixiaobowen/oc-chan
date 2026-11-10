use std::future::Future;
mod report;
pub use report::*;
use std::{path::PathBuf, sync::{Arc, Mutex}, time::Duration};
use futures_util::future::BoxFuture;
use serde::Serialize;
use tokio::{sync::watch, time::Instant};
use tokio_util::sync::CancellationToken;
use crate::{error::{Error, Result, check_cancel}, io::BoundedIo};

/// The adapter owns native pending identities until completion or confirmed cancellation.
/// Returning Ok from copy means the actual clipboard write committed.
pub trait DiagnosticNative:Send+Sync {
    fn choose_file<'a>(&'a self,owner:u64,cancel:&'a CancellationToken)->BoxFuture<'a,Result<Option<PathBuf>>>;
    fn copy<'a>(&'a self,owner:u64,text:&'a str,cancel:&'a CancellationToken)->BoxFuture<'a,Result<()>>;
}
pub struct DiagnosticsOptions {
    pub io:BoundedIo, pub native:Arc<dyn DiagnosticNative>, pub build:Arc<dyn Fn()->Result<ReportContent>+Send+Sync>, pub headless:bool, pub owner:u64,
}
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct DiagnosticPreview { pub id:String, #[serde(flatten)] pub content:ReportContent }
#[derive(Clone,Debug,Serialize)]
#[serde(tag="status",rename_all="lowercase")]
pub enum DiagnosticResult { Ready{preview:DiagnosticPreview}, Copied, Saved, Cancelled, Error{reason:String,details:String} }
#[derive(Clone)] struct Active { cancel:CancellationToken, done:watch::Receiver<Option<Result<DiagnosticResult>>> }
struct Preview { value:DiagnosticPreview, expires:Instant, expiry_cancel:CancellationToken }
#[derive(Default)] struct State { active:Option<Active>,preview:Option<Preview>,closed:bool,cleanup:Option<Error> }
pub struct Diagnostics { options:DiagnosticsOptions,state:Mutex<State> }
enum Action { Generate, Copy(String), Save(String) }
fn failure(code:&str)->Error {Error::new(code,format!("诊断操作失败 / Diagnostic operation failed: {code}"))}
impl Diagnostics {
    pub fn new(options:DiagnosticsOptions)->Arc<Self> {Arc::new(Self{options,state:Mutex::new(State::default())})}
    pub async fn generate(self:&Arc<Self>)->DiagnosticResult {self.run(Action::Generate).await}
    pub async fn copy(self:&Arc<Self>,id:&str)->DiagnosticResult {self.run(Action::Copy(id.to_owned())).await}
    pub async fn save(self:&Arc<Self>,id:&str)->DiagnosticResult {self.run(Action::Save(id.to_owned())).await}
    async fn run(self:&Arc<Self>,action:Action)->DiagnosticResult {
        let cancel=CancellationToken::new();let (tx,rx)=watch::channel(None);
        {
            let mut state=match self.state.lock(){Ok(state)=>state,Err(_)=>return result(Err(failure("OC_DIAGNOSTIC_CLEANUP")))};
            if let Some(error)=&state.cleanup{return result(Err(error.clone()));}
            if state.closed{return result(Err(failure("OC_DIAGNOSTIC_UNAVAILABLE")));}
            if state.active.is_some(){return result(Err(failure("OC_DIAGNOSTIC_BUSY")));}
            state.active=Some(Active{cancel:cancel.clone(),done:rx.clone()});
        }
        let this=self.clone();
        tokio::spawn(async move {
            let outcome=this.execute(action,&cancel).await;
            if let Ok(mut state)=this.state.lock(){
                if let Err(error)=&outcome {if error.is_cleanup() {state.cleanup=Some(error.clone());}}
                state.active=None;
            }
            tx.send_replace(Some(outcome));
        });
        result(wait(rx).await)
    }
    async fn execute(self:&Arc<Self>,action:Action,cancel:&CancellationToken)->Result<DiagnosticResult>{
        check_cancel(cancel)?;
        match action {
            Action::Generate=>{
                self.clear()?;tokio::task::yield_now().await;check_cancel(cancel)?;
                let content=(self.options.build)()?;
                if content.json.is_empty() || content.json.len()>MAX_BYTES || content.bytes!=content.json.len(){return Err(failure("OC_DIAGNOSTIC_LIMIT"));}
                check_cancel(cancel)?;
                let preview=DiagnosticPreview{id:uuid::Uuid::new_v4().to_string(),content};
                let expiry_cancel=CancellationToken::new();let expires=Instant::now()+Duration::from_secs(600);
                {
                    let mut state=self.state.lock().map_err(|_|failure("OC_DIAGNOSTIC_CLEANUP"))?;
                    check_cancel(cancel)?;
                    state.preview=Some(Preview{value:preview.clone(),expires,expiry_cancel:expiry_cancel.clone()});
                }
                let weak=Arc::downgrade(self);let id=preview.id.clone();
                tokio::spawn(async move {tokio::select!{_ = expiry_cancel.cancelled()=>{},_ = tokio::time::sleep_until(expires)=>{
                    if let Some(this)=weak.upgrade(){if let Ok(mut state)=this.state.lock(){if state.preview.as_ref().is_some_and(|preview|preview.value.id==id){state.preview=None;}}}
                }}});
                Ok(DiagnosticResult::Ready{preview})
            }
            Action::Copy(id)=>{
                let preview=self.current(&id)?;if self.options.headless{return Err(failure("OC_DIAGNOSTIC_UNAVAILABLE"));}
                self.deadline(cancel,|token|async move{self.options.native.copy(self.options.owner,&preview.content.json,&token).await}).await?;
                Ok(DiagnosticResult::Copied)
            }
            Action::Save(id)=>{
                self.current(&id)?;if self.options.headless{return Err(failure("OC_DIAGNOSTIC_UNAVAILABLE"));}
                let filename=self.options.native.choose_file(self.options.owner,cancel).await?;
                check_cancel(cancel)?;
                let Some(filename)=filename else{return Ok(DiagnosticResult::Cancelled)};
                // A dialog may stay open past expiry; do not export stale preview data.
                let preview=self.current(&id)?;
                self.deadline(cancel,|token|async move{save_report(&self.options.io,filename,preview.content.json,&token).await}).await?;
                Ok(DiagnosticResult::Saved)
            }
        }
    }
    async fn deadline<F,Fut>(&self,cancel:&CancellationToken,work:F)->Result<()> where F:FnOnce(CancellationToken)->Fut,Fut:Future<Output=Result<()>> {
        let token=cancel.child_token();let future=work(token.clone());tokio::pin!(future);
        tokio::select!{
            result=&mut future=>result,
            _=tokio::time::sleep(Duration::from_secs(5))=>{token.cancel();match future.await{Err(error) if error.is_cancelled()=>Err(Error::timeout("diagnostic IO")),result=>result}}
        }
    }
    fn current(&self,id:&str)->Result<DiagnosticPreview>{
        if uuid::Uuid::parse_str(id).is_err(){return Err(failure("OC_DIAGNOSTIC_EXPIRED"));}
        let mut state=self.state.lock().map_err(|_|failure("OC_DIAGNOSTIC_CLEANUP"))?;
        if state.preview.as_ref().is_some_and(|preview|Instant::now()>=preview.expires){if let Some(preview)=state.preview.take(){preview.expiry_cancel.cancel();}}
        state.preview.as_ref().filter(|preview|preview.value.id==id).map(|preview|preview.value.clone()).ok_or_else(||failure("OC_DIAGNOSTIC_EXPIRED"))
    }
    fn clear(&self)->Result<()>{
        if let Some(preview)=self.state.lock().map_err(|_|failure("OC_DIAGNOSTIC_CLEANUP"))?.preview.take(){preview.expiry_cancel.cancel();}Ok(())
    }
    pub async fn cancel(&self)->Result<()>{
        let active={let mut state=self.state.lock().map_err(|_|failure("OC_DIAGNOSTIC_CLEANUP"))?;
            if let Some(preview)=state.preview.take(){preview.expiry_cancel.cancel();}
            if let Some(active)=&state.active{active.cancel.cancel();}state.active.clone()};
        if let Some(active)=active{if let Err(error)=wait(active.done).await{if error.is_cleanup(){return Err(error);}}}
        if let Some(error)=&self.state.lock().map_err(|_|failure("OC_DIAGNOSTIC_CLEANUP"))?.cleanup{return Err(error.clone());}Ok(())
    }
    pub async fn close(&self)->Result<()>{self.state.lock().map_err(|_|failure("OC_DIAGNOSTIC_CLEANUP"))?.closed=true;self.cancel().await}
}
async fn wait(mut rx:watch::Receiver<Option<Result<DiagnosticResult>>>)->Result<DiagnosticResult>{
    loop{if let Some(result)=rx.borrow().clone(){return result;}rx.changed().await.map_err(|_|failure("OC_DIAGNOSTIC_CLEANUP"))?;}
}
fn result(value:Result<DiagnosticResult>)->DiagnosticResult{
    match value{Ok(value)=>value,Err(error) if error.is_cancelled()=>DiagnosticResult::Cancelled,Err(error)=>{
        let reason=match error.code.as_str(){"OC_RESOURCE_CLOSE"|"OC_DIAGNOSTIC_CLEANUP"=>"cleanup","OC_DIAGNOSTIC_BUSY"=>"busy","OC_DIAGNOSTIC_EXPIRED"=>"expired","OC_DIAGNOSTIC_UNAVAILABLE"=>"unavailable","EEXIST"=>"exists","EACCES"|"EPERM"|"EROFS"=>"permission","ENOSPC"|"EDQUOT"=>"storage","ETIMEDOUT"=>"timeout","OC_DIAGNOSTIC_CLIPBOARD"=>"clipboard","EIO"|"ENOENT"|"ENOTDIR"|"EISDIR"|"ELOOP"=>"io",_=>"unknown"};
        DiagnosticResult::Error{reason:reason.into(),details:format!("诊断操作失败 / Diagnostic operation failed: {}",error.code)}
    }}
}
/// New destination only. The directory FD pins all open/link/unlink operations to
/// one directory; successful linkat is the commit point and is never rolled back.
pub async fn save_report(io:&BoundedIo,path:PathBuf,text:String,cancel:&CancellationToken)->Result<()>{
    if text.is_empty()||text.len()>MAX_BYTES||!path.is_absolute()||path.as_os_str().len()>4096{return Err(failure("OC_DIAGNOSTIC_UNAVAILABLE"));}
    io.with_file_budget("diagnostic-export",text.len(),cancel,move|token|async move{
        tokio::task::spawn_blocking(move||save_blocking(path,text,token)).await.map_err(|_|failure("OC_DIAGNOSTIC_CLEANUP"))?
    }).await
}
fn save_blocking(path:PathBuf,text:String,cancel:CancellationToken)->Result<()>{
    use std::{ffi::CString,os::unix::ffi::OsStrExt};
    check_cancel(&cancel)?;
    let parent=path.parent().ok_or_else(||failure("OC_DIAGNOSTIC_UNAVAILABLE"))?;
    let name=path.file_name().ok_or_else(||failure("OC_DIAGNOSTIC_UNAVAILABLE"))?;
    let parent=CString::new(parent.as_os_str().as_bytes()).map_err(|_|failure("OC_DIAGNOSTIC_UNAVAILABLE"))?;
    let name=CString::new(name.as_bytes()).map_err(|_|failure("OC_DIAGNOSTIC_UNAVAILABLE"))?;
    let temporary=CString::new(format!(".oc-chan-diagnostic-{}.tmp",uuid::Uuid::new_v4())).map_err(|_|failure("OC_DIAGNOSTIC_UNAVAILABLE"))?;
    let directory=unsafe{libc::open(parent.as_ptr(),libc::O_RDONLY|libc::O_DIRECTORY|libc::O_NOFOLLOW|libc::O_CLOEXEC)};
    if directory<0{return Err(Error::io("open diagnostic directory",std::io::Error::last_os_error()));}
    let mut file=-1;let mut created=false;
    let outcome=(||{
        check_cancel(&cancel)?;
        file=unsafe{libc::openat(directory,temporary.as_ptr(),libc::O_WRONLY|libc::O_CREAT|libc::O_EXCL|libc::O_NOFOLLOW|libc::O_CLOEXEC,0o600)};
        if file<0{return Err(Error::io("create diagnostic temporary",std::io::Error::last_os_error()));}created=true;
        let mut offset=0;
        while offset<text.len(){
            check_cancel(&cancel)?;let bytes=&text.as_bytes()[offset..text.len().min(offset+16384)];
            let written=unsafe{libc::write(file,bytes.as_ptr().cast(),bytes.len())};
            if written<0{let error=std::io::Error::last_os_error();if error.kind()==std::io::ErrorKind::Interrupted{continue;}return Err(Error::io("write diagnostic",error));}
            if written==0{return Err(failure("EIO"));}offset+=written as usize;
        }
        if unsafe{libc::fsync(file)}!=0{return Err(Error::io("sync diagnostic",std::io::Error::last_os_error()));}
        let closing=file;file=-1;if unsafe{libc::close(closing)}!=0{return Err(Error::cleanup("diagnostic file",Error::io("close",std::io::Error::last_os_error())));}
        check_cancel(&cancel)?;
        if unsafe{libc::linkat(directory,temporary.as_ptr(),directory,name.as_ptr(),0)}!=0{return Err(Error::io("commit diagnostic",std::io::Error::last_os_error()));}
        if unsafe{libc::fsync(directory)}!=0{return Err(Error::cleanup("committed diagnostic directory",Error::io("sync",std::io::Error::last_os_error())));}Ok(())
    })();
    let mut errors=Vec::new();if let Err(error)=outcome{errors.push(error);}
    if file>=0&&unsafe{libc::close(file)}!=0{errors.push(Error::cleanup("diagnostic file",Error::io("close",std::io::Error::last_os_error())));}
    if created&&unsafe{libc::unlinkat(directory,temporary.as_ptr(),0)}!=0{errors.push(Error::cleanup("diagnostic temporary",Error::io("unlink",std::io::Error::last_os_error())));}
    if unsafe{libc::close(directory)}!=0{errors.push(Error::cleanup("diagnostic directory",Error::io("close",std::io::Error::last_os_error())));}
    if errors.is_empty(){Ok(())}else{Err(Error::aggregate(errors))}
}
#[cfg(test)]mod tests;
