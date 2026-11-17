use oc_core::{error::{Error, Result}, settings::{TrayClick, WindowBounds}};
use tokio::sync::oneshot;

pub struct MainThreadJob(Box<dyn FnOnce() + Send>);
impl MainThreadJob {
    pub fn run(self) {
        assert_ne!(unsafe { libc::pthread_main_np() }, 0, "native dispatch must execute on AppKit main thread");
        (self.0)();
    }
}
#[derive(Clone)]
pub struct MainThread(async_channel::Sender<MainThreadJob>);
pub struct MainThreadPump(async_channel::Receiver<MainThreadJob>);
impl MainThread {
    pub fn channel() -> (Self, MainThreadPump) {
        let (tx, rx) = async_channel::bounded(64);
        (Self(tx), MainThreadPump(rx))
    }
    pub fn dispatch(&self, work: impl FnOnce() + Send + 'static) -> Result<()> {
        self.0.try_send(MainThreadJob(Box::new(work))).map_err(|_| Error::new("OC_NATIVE_DISPATCH", "主线程队列已满或关闭 / Main thread queue full or closed"))
    }
}
impl MainThreadPump {
    pub async fn recv(&self) -> Option<MainThreadJob> { self.0.recv().await.ok() }
    pub fn drain(&self) { while let Ok(job) = self.0.try_recv() { job.run(); } }
}
#[derive(Clone, Debug)]
pub enum HostWindowAction {
    EnsureMain(Option<WindowBounds>), EnsureRecovery, CloseRecovery, ShowMain,
    ShowTray, HideTray, SetTrayClick(TrayClick), Close, Exit(i32),
}
pub struct HostWindowRequest {
    pub action: HostWindowAction,
    pub reply: oneshot::Sender<Result<()>>,
}
#[derive(Clone)]
pub struct WindowRequests(async_channel::Sender<HostWindowRequest>);
impl WindowRequests {
    pub fn channel() -> (Self, async_channel::Receiver<HostWindowRequest>) {
        let (tx, rx) = async_channel::bounded(32); (Self(tx), rx)
    }
    pub async fn request(&self, action: HostWindowAction) -> Result<()> {
        let (reply, receive) = oneshot::channel();
        self.0.try_send(HostWindowRequest { action, reply }).map_err(|_| Error::new("OC_WINDOW_BUSY", "窗口请求队列已满或关闭 / Window queue full or closed"))?;
        receive.await.map_err(|_| Error::new("OC_WINDOW_CLOSED", "窗口请求未完成 / Window request did not complete"))?
    }
    pub async fn ensure_main(&self, bounds: Option<WindowBounds>) -> Result<()> { self.request(HostWindowAction::EnsureMain(bounds)).await }
    pub async fn ensure_recovery(&self) -> Result<()> { self.request(HostWindowAction::EnsureRecovery).await }
    pub async fn close_recovery(&self) -> Result<()> { self.request(HostWindowAction::CloseRecovery).await }
    pub async fn show_main(&self) -> Result<()> { self.request(HostWindowAction::ShowMain).await }
    pub async fn set_tray_click(&self, value: TrayClick) -> Result<()> { self.request(HostWindowAction::SetTrayClick(value)).await }
    pub async fn close(&self) -> Result<()> { self.request(HostWindowAction::Close).await }
}
