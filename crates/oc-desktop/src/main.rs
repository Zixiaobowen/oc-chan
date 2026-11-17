mod api;
mod config;
mod host;
mod native;
mod platform;
mod session;
mod settings;
mod windows;
mod views;
mod topology;
mod tray;
mod visibility;
#[cfg(feature="acceptance")]
#[path="../acceptance/driver.rs"]
mod acceptance;

use std::{cell::RefCell, rc::Rc, sync::{Arc,atomic::{AtomicI32,Ordering}}};
use gpui::{App, Application, actions, KeyBinding};
use oc_core::{error::{Error, Result}, settings::ResolvedLanguage};
use platform::{MainThread, WindowRequests, HostWindowAction};
use windows::{Windows,SharedWindows};
use api::View;
actions!(oc_chan,[Quit,ShowMain]);
static EXIT_CODE:AtomicI32=AtomicI32::new(0);

fn main() {
    log::set_logger(&LOGGER).expect("install application logger");log::set_max_level(log::LevelFilter::Warn);
    if let Err(error)=run(){eprintln!("OC Chan startup failed: {error}");std::process::exit(1);}
    let code=EXIT_CODE.load(Ordering::Acquire);if code!=0{std::process::exit(code);}
}
fn run()->std::result::Result<(),Box<dyn std::error::Error>> {
    let runtime=tokio::runtime::Builder::new_multi_thread().worker_threads(4).max_blocking_threads(8).enable_all().build()?;
    let _runtime_guard=runtime.enter();
    let config=config::Config::read()?;
    let headless=config.headless;
    let application=Application::new().with_assets(BrandAssets);
    let slot:Rc<RefCell<Option<Arc<host::Desktop>>>>=Rc::new(RefCell::new(None));
    let reopen=slot.clone();
    application.on_reopen(move |_|{
        if let Some(host)=reopen.borrow().as_ref().cloned(){if !host.config.headless{tokio::spawn(async move{if let Err(error)=host.windows.show_main().await{host.report(error);}});}}
    });
    application.run(move |cx:&mut App|{
        if headless {windows::prohibit_activation();}
        #[cfg(feature="acceptance")]
        unsafe {acceptance::oc_gpui_capture_init();}
        let initialized=(||->Result<_>{
            let (native_sender,native_receiver)=tokio::sync::mpsc::channel(64);
            let bridge=native::NativeBridge::bootstrap(headless,Arc::new(move|event|{if let Err(error)=native_sender.try_send(event){eprintln!("OC_NATIVE_EVENT_QUEUE: {error}");}}))?;
            let language=(|| {let system=bridge.bootstrap_read("systemRead")?;serde_json::from_value::<ResolvedLanguage>(system["systemLanguage"].clone()).map_err(|_|Error::invalid("system language"))})();
            let language=match language {Ok(language)=>language,Err(error)=>return match bridge.release_before_attach(){Ok(())=>Err(error),Err(cleanup)=>Err(Error::aggregate(vec![error,cleanup]))}};
            let (sender,pump)=MainThread::channel();bridge.attach(sender)?;
            let (requests,receive)=WindowRequests::channel();
            let host=host::Desktop::new(config,bridge,language,requests);
            let windows:SharedWindows=Rc::new(RefCell::new(Windows::new(headless)));
            cx.spawn(async move |_|{while let Some(job)=pump.recv().await{job.run();}}).detach();
            let receiver_host=host.clone();let receiver_windows=windows.clone();
            cx.spawn(async move|cx|{
                while let Ok(request)=receive.recv().await {
                    let result=cx.update(|cx|window_action(request.action,&receiver_windows,&receiver_host,cx)).map_err(|error|Error::new("OC_WINDOW_DISPATCH",error.to_string())).and_then(|value|value);
                    if let Err(error)=request.reply.send(result){if let Err(error)=error{receiver_host.report(error);}}
                }
            }).detach();
            if !headless {
                let icon=tray::install(host.clone(),windows.clone(),cx)?;
                cx.on_app_quit(move |_| { let _keep_alive=&icon; async {} }).detach();
            }
            #[cfg(feature="acceptance")]
            acceptance::start(&host,windows.clone(),cx)?;
            let quitting=host.clone();cx.on_action(move|_:&Quit,_|quitting.request_quit(0));
            let showing=host.clone();cx.on_action(move|_:&ShowMain,_|{let host=showing.clone();tokio::spawn(async move{if let Err(error)=host.windows.show_main().await{host.report(error);}});});
            cx.bind_keys([KeyBinding::new("cmd-q",Quit,None),KeyBinding::new("cmd-1",ShowMain,None)]);
            let os_quit=host.clone();
            cx.on_app_quit(move |_| {let host=os_quit.clone();async move{if let Err(error)=host.quit_from_os().await{host.report(error);}}}).detach();
            let boot=host.clone();tokio::spawn(async move{if let Err(error)=boot.run(native_receiver).await{boot.startup_failed(error);}});
            let signal_host=host.clone();tokio::spawn(async move{
                let terminate=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate());
                let interrupt=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt());
                match(terminate,interrupt){(Ok(mut term),Ok(mut int))=>{tokio::select!{_=term.recv()=>{},_=int.recv()=>{}}signal_host.request_quit(0);},(Err(error),_)|(_,Err(error))=>signal_host.report(Error::io("termination signal",error))}
            });
            Ok(host)
        })();
        match initialized {Ok(host)=>*slot.borrow_mut()=Some(host),Err(error)=>{eprintln!("OC_GPUI_STARTUP: {error}");EXIT_CODE.store(1,Ordering::Release);cx.quit();}}
    });
    Ok(())
}
fn window_action(action:HostWindowAction,windows:&SharedWindows,host:&Arc<host::Desktop>,cx:&mut App)->Result<()> {
    let mut windows=windows.borrow_mut();
    match action {
        HostWindowAction::EnsureMain(bounds)=>windows.ensure(View::Main,bounds,host.clone(),cx),
        HostWindowAction::EnsureRecovery=>windows.ensure(View::Recovery,None,host.clone(),cx),
        HostWindowAction::CloseRecovery=>windows.close(View::Recovery,cx),
        HostWindowAction::ShowMain=>{windows.ensure(View::Main,None,host.clone(),cx)?;windows.show(View::Main,cx)},
        HostWindowAction::ShowTray=>{windows.ensure(View::Tray,None,host.clone(),cx)?;windows.show(View::Tray,cx)},
        HostWindowAction::HideTray=>windows.hide(View::Tray,cx),
        HostWindowAction::SetTrayClick(value)=>{windows.tray_click=value;Ok(())},
        HostWindowAction::Close=>{for view in [View::Main,View::Tray,View::Recovery]{windows.close(view,cx)?;}Ok(())},
        HostWindowAction::Exit(code)=>{EXIT_CODE.store(code,Ordering::Release);cx.quit();Ok(())},
    }
}

struct BrandAssets;
impl gpui::AssetSource for BrandAssets {
    fn load(&self,path:&str)->anyhow::Result<Option<std::borrow::Cow<'static,[u8]>>> {
        Ok(match path {"resources/brand/oc-chan-mono.svg"=>Some(std::borrow::Cow::Borrowed(include_bytes!("../../../resources/brand/oc-chan-mono.svg"))),_=>None})
    }
    fn list(&self,path:&str)->anyhow::Result<Vec<gpui::SharedString>> {
        Ok(if path=="resources/brand"{vec!["resources/brand/oc-chan-mono.svg".into()]}else{vec![]})
    }
}

struct AppLogger;
static LOGGER:AppLogger=AppLogger;
impl log::Log for AppLogger {
 fn enabled(&self,metadata:&log::Metadata<'_>)->bool{metadata.level()<=log::Level::Warn}
 fn log(&self,record:&log::Record<'_>){if self.enabled(record.metadata()){eprintln!("OC_GPUI_{} {}: {}",record.level(),record.target(),record.args());}}
 fn flush(&self){}
}
