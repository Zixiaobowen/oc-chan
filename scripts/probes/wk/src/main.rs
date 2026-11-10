use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tauri::{Emitter, WebviewWindowBuilder, WebviewUrl};
#[path = "../../../../src-tauri/acceptance/driver.rs"]
mod driver;
unsafe extern "C" { fn oc_wk_prohibit_activation(); }
#[tauri::command]
fn probe_roundtrip(window: tauri::WebviewWindow, value: String) -> Result<String, String> {
    if window.label() != "probe" || value.len() > 128 { return Err("invalid probe request".into()); }
    window.emit("probe-event", format!("rust-event:{value}")).map_err(|e| e.to_string())?;
    Ok(format!("rust-invoke:{value}"))
}
fn main() {
    let stop = Arc::new(AtomicBool::new(false));
    let setup_stop = stop.clone();
    let worker = Arc::new(std::sync::Mutex::new(None));
    let setup_worker = worker.clone();
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe_roundtrip])
        .setup(move |app| {
            unsafe { oc_wk_prohibit_activation(); }
            WebviewWindowBuilder::new(app, "probe", WebviewUrl::App("index.html".into()))
                .title("OC WK hidden acceptance").visible(false).focused(false).focusable(false)
                .initialization_script("window.probeErrors=[];window.addEventListener('error',e=>{if(window.probeErrors.length<16)window.probeErrors.push({message:String(e.message).slice(0,2048),file:e.filename,line:e.lineno});});window.addEventListener('unhandledrejection',e=>{if(window.probeErrors.length<16)window.probeErrors.push({rejection:String(e.reason).slice(0,2048)});});")
                .inner_size(880.0, 640.0).build()?;
            *setup_worker.lock().map_err(|_| "worker lock poisoned")? = Some(driver::start(app.handle().clone(), setup_stop, &["probe"])?);
            Ok(())
        }).build(tauri::generate_context!()).expect("probe initialization failed");
    app.run(move |_app, event| {
        if let tauri::RunEvent::Exit = event {
            stop.store(true, Ordering::Release);
            if let Some(thread) = worker.lock().expect("worker lock").take() {
                if thread.join().is_err() { eprintln!("driver worker panicked"); }
            }
        }
    });
}
