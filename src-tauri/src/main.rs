mod api;
mod config;
mod documents;
mod host;
mod ipc;
mod native;
mod settings;
mod windows;
#[cfg(feature="acceptance")]
#[path="../acceptance/driver.rs"]
mod driver;

use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use oc_core::{error::Error, settings::ResolvedLanguage};
use tauri::Manager;

fn main() {
    if let Err(error) = run() { eprintln!("OC Chan startup failed: {error}"); std::process::exit(1); }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(4).max_blocking_threads(8).enable_all().build()?;
    tauri::async_runtime::set(runtime.handle().clone());
    let headless = config::headless()?;
    #[cfg(feature="acceptance")]
    let driver_stop = Arc::new(AtomicBool::new(false));
    #[cfg(feature="acceptance")]
    let driver_worker = Arc::new(Mutex::new(None::<std::thread::JoinHandle<()>>));
    #[cfg(feature="acceptance")]
    let (setup_driver_stop, setup_driver_worker) = (driver_stop.clone(), driver_worker.clone());
    let mut app = tauri::Builder::default()
        .activate_ignoring_other_apps(!headless)
        .invoke_handler(ipc::handle)
        .setup(move |app| {
            if headless { app.set_activation_policy(tauri::ActivationPolicy::Prohibited); }
            // Tao must create its NSApplication subclass before the native bridge.
            let (native_sender, native_receiver) = tokio::sync::mpsc::channel(64);
            let native = native::NativeBridge::bootstrap(headless, Arc::new(move |event| {
                if let Err(error) = native_sender.try_send(event) { eprintln!("OC_NATIVE_EVENT_QUEUE: {error}"); }
            }))?;
            let language = (|| {
                let system = native.bootstrap_read("systemRead")?;
                serde_json::from_value::<ResolvedLanguage>(system["systemLanguage"].clone()).map_err(|_| Error::invalid("system language"))
            })();
            let language = match language { Ok(language) => language, Err(error) => { return match native.release_before_attach() { Ok(()) => Err(error.into()), Err(cleanup) => Err(Error::aggregate(vec![error, cleanup]).into()) }; } };
            native.attach(app.handle().clone())?;
            let config = config::Config::read(app.handle())?;
            let (host, window_receiver) = host::Host::new(app.handle().clone(), config, native, language);
            app.manage(host.clone());
            let boot = host.clone();
            tauri::async_runtime::spawn(async move { if let Err(error) = boot.run(native_receiver, window_receiver).await { boot.startup_failed(error); } });
            #[cfg(feature="acceptance")]
            if headless {
                *setup_driver_worker.lock().map_err(|_| "driver state poisoned")? = Some(driver::start(app.handle().clone(), setup_driver_stop, &["main", "tray", "recovery"])?);
            }
            tauri::async_runtime::spawn(async move {
                let terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate());
                let interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt());
                match (terminate, interrupt) {
                    (Ok(mut terminate), Ok(mut interrupt)) => { tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} } host.request_quit(0); },
                    (Err(error), _) | (_, Err(error)) => host.startup_failed(Error::io("termination signal", error)),
                }
            });
            Ok(())
        }).build(tauri::generate_context!())?;
    // Tao applies this policy before emitting Ready and invoking setup.
    if headless { app.set_activation_policy(tauri::ActivationPolicy::Prohibited); }
    app.run(move |app, event| {
        let host = app.state::<Arc<host::Host>>();
        match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                if !host.exit_ready.load(Ordering::Acquire) { api.prevent_exit(); host.inner().request_quit(0); }
            },
            tauri::RunEvent::Reopen { .. } => {
                if !headless { let host = host.inner().clone(); tauri::async_runtime::spawn(async move { if let Err(error) = host.show_main(None).await { host.report(error); } }); }
            },
            tauri::RunEvent::Exit => {
                #[cfg(feature="acceptance")]
                {
                    driver_stop.store(true, Ordering::Release);
                    if let Some(worker) = driver_worker.lock().expect("driver worker state").take() { if worker.join().is_err() { eprintln!("OC_DRIVER_JOIN: acceptance driver panicked"); } }
                }
            },
            _ => {},
        }
    });
    Ok(())
}
