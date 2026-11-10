use super::*;
use std::sync::atomic::{AtomicUsize,Ordering};
use crate::{model::MonitorSnapshot,resources::ResourceBudget};
struct Native { path:Mutex<Option<PathBuf>>, calls:AtomicUsize, block:bool, entered:tokio::sync::Notify, cleaned:AtomicUsize }
impl Native {
    fn new(path:Option<PathBuf>,block:bool)->Arc<Self>{Arc::new(Self{path:Mutex::new(path),calls:AtomicUsize::new(0),block,entered:tokio::sync::Notify::new(),cleaned:AtomicUsize::new(0)})}
}
impl DiagnosticNative for Native {
    fn choose_file<'a>(&'a self,_owner:u64,cancel:&'a CancellationToken)->BoxFuture<'a,Result<Option<PathBuf>>>{Box::pin(async move{
        self.calls.fetch_add(1,Ordering::SeqCst);self.entered.notify_one();
        if self.block{cancel.cancelled().await;tokio::task::yield_now().await;self.cleaned.fetch_add(1,Ordering::SeqCst);return Err(Error::cancelled());}
        Ok(self.path.lock().unwrap().clone())
    })}
    fn copy<'a>(&'a self,_owner:u64,text:&'a str,cancel:&'a CancellationToken)->BoxFuture<'a,Result<()>>{Box::pin(async move{
        check_cancel(cancel)?;assert!(text.starts_with('{'));self.calls.fetch_add(1,Ordering::SeqCst);Ok(())
    })}
}
fn controller(native:Arc<Native>,headless:bool)->Arc<Diagnostics>{
    let io=BoundedIo::new(ResourceBudget::default());let budget=io.resources().clone();
    Diagnostics::new(DiagnosticsOptions{io,native,headless,owner:1,build:Arc::new(move||build_report(&MonitorSnapshot::default(),&budget.snapshot(),&ReportMetadata{version:"1.0.0".into(),tauri:"2.0.0".into(),platform:"darwin".into(),arch:"arm64".into(),os_release:"27.2.0".into()}))})
}
async fn preview(controller:&Arc<Diagnostics>)->DiagnosticPreview{match controller.generate().await{DiagnosticResult::Ready{preview}=>preview,other=>panic!("unexpected result: {other:?}")}}
#[tokio::test]async fn replacement_and_expiry_reject_old_ids(){
    let native=Native::new(None,false);let controller=controller(native.clone(),false);
    let first=preview(&controller).await;let second=preview(&controller).await;
    assert_ne!(first.id,second.id);assert!(matches!(controller.copy(&first.id).await,DiagnosticResult::Error{reason,..} if reason=="expired"));
    controller.state.lock().unwrap().preview.as_mut().unwrap().expires=Instant::now()-Duration::from_secs(1);
    assert!(matches!(controller.copy(&second.id).await,DiagnosticResult::Error{reason,..} if reason=="expired"));assert_eq!(native.calls.load(Ordering::SeqCst),0);
    controller.close().await.unwrap();
}
#[tokio::test]async fn headless_never_calls_clipboard_or_dialog_adapter(){
    let native=Native::new(None,false);let controller=controller(native.clone(),true);let preview=preview(&controller).await;
    for outcome in [controller.copy(&preview.id).await,controller.save(&preview.id).await]{assert!(matches!(outcome,DiagnosticResult::Error{reason,..} if reason=="unavailable"));}
    assert_eq!(native.calls.load(Ordering::SeqCst),0);controller.close().await.unwrap();
}
#[tokio::test]async fn cancellation_waits_for_owned_dialog_cleanup(){
    let native=Native::new(None,true);let controller=controller(native.clone(),false);let preview=preview(&controller).await;
    let save={let controller=controller.clone();tokio::spawn(async move{controller.save(&preview.id).await})};
    native.entered.notified().await;assert!(matches!(controller.generate().await,DiagnosticResult::Error{reason,..} if reason=="busy"));
    controller.cancel().await.unwrap();assert_eq!(native.cleaned.load(Ordering::SeqCst),1);assert!(matches!(save.await.unwrap(),DiagnosticResult::Cancelled));
    assert!(controller.state.lock().unwrap().preview.is_none());controller.close().await.unwrap();
}
#[tokio::test]async fn export_creates_new_file_and_never_overwrites(){
    let directory=tempfile::tempdir().unwrap();let file=directory.path().join("report.json");
    let io=BoundedIo::new(ResourceBudget::default());let cancel=CancellationToken::new();
    save_report(&io,file.clone(),"{\"first\":true}".into(),&cancel).await.unwrap();
    let error=save_report(&io,file.clone(),"{\"second\":true}".into(),&cancel).await.unwrap_err();assert_eq!(error.code,"EEXIST");
    assert_eq!(std::fs::read_to_string(file).unwrap(),"{\"first\":true}");assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(),1);io.shutdown().await.unwrap();
}
#[tokio::test]async fn export_rejects_symlink_and_pre_cancelled_writes(){
    let directory=tempfile::tempdir().unwrap();let original=directory.path().join("original");let destination=directory.path().join("report.json");
    std::fs::write(&original,"retained").unwrap();std::os::unix::fs::symlink(&original,&destination).unwrap();
    let io=BoundedIo::new(ResourceBudget::default());let cancel=CancellationToken::new();
    assert_eq!(save_report(&io,destination,"{}".into(),&cancel).await.unwrap_err().code,"EEXIST");
    cancel.cancel();assert!(save_report(&io,directory.path().join("cancelled"),"{}".into(),&cancel).await.unwrap_err().is_cancelled());
    assert_eq!(std::fs::read_to_string(original).unwrap(),"retained");assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(),2);io.shutdown().await.unwrap();
}
