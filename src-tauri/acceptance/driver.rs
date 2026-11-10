//! Acceptance-only authenticated Unix driver; never linked into production.
//! One connection/request, four still-live native calls, bounded IO and cancellation.
use std::{ffi::{CStr, CString, c_char, c_void}, fs::{self, OpenOptions}, io::{Read, Write}, os::{fd::AsRawFd, unix::{fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt}, net::{UnixListener, UnixStream}}}, path::PathBuf, sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}, mpsc}, time::{Duration, Instant}};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
const INPUT: usize = 256 * 1024;
const OUTPUT: usize = 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(15);
const SLICE: Duration = Duration::from_millis(50);
const MARKER: &str = "OC_CHAN_ACCEPTANCE_DRIVER_V1";
unsafe extern "C" {
    fn oc_wk_request(view: *mut c_void, operation: *const c_char, payload: *const c_char, callback: extern "C" fn(*mut c_void, *const c_char), context: *mut c_void);
}
struct Completion { sender: mpsc::SyncSender<Value>, cancelled: Arc<AtomicBool>, count: Arc<AtomicUsize> }
extern "C" fn completed(context: *mut c_void, reply: *const c_char) {
    let context = unsafe { Box::from_raw(context.cast::<Completion>()) };
    context.count.fetch_sub(1, Ordering::AcqRel);
    if context.cancelled.load(Ordering::Acquire) { return; }
    let value = if reply.is_null() { json!({"ok":false,"error":"null native completion"}) }
        else { serde_json::from_slice(unsafe { CStr::from_ptr(reply) }.to_bytes()).unwrap_or_else(|e| json!({"ok":false,"error":e.to_string()})) };
    let _ = context.sender.try_send(value); // A cancelled receiver owns no native resources.
}
fn remaining(started: Instant, stop: &AtomicBool) -> Result<Duration, String> {
    if stop.load(Ordering::Acquire) { return Err("driver stopping".into()); }
    DEADLINE.checked_sub(started.elapsed()).filter(|value| !value.is_zero()).ok_or_else(|| "request deadline".into())
}
fn native(app: &AppHandle, label: &str, command: &str, payload: &str, count: &Arc<AtomicUsize>, started: Instant, stop: &Arc<AtomicBool>) -> Result<Value, String> {
    remaining(started, stop)?;
    let window = app.get_webview_window(label).ok_or("window not created or closed")?;
    let operation = CString::new(command).map_err(|e| e.to_string())?;
    let payload = CString::new(payload).map_err(|e| e.to_string())?;
    count.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| (n < 4).then_some(n + 1)).map_err(|_| "four native operations still pending")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let cancelled = Arc::new(AtomicBool::new(false));
    let context = Box::into_raw(Box::new(Completion { sender, cancelled: cancelled.clone(), count: count.clone() })) as usize;
    let dispatch_cancelled = cancelled.clone();
    let dispatch_stop = stop.clone();
    if let Err(error) = window.with_webview(move |view| unsafe {
        if dispatch_cancelled.load(Ordering::Acquire) || dispatch_stop.load(Ordering::Acquire) {
            completed(context as *mut c_void, c"{\"ok\":false,\"error\":\"cancelled before native dispatch\"}".as_ptr());
        } else { oc_wk_request(view.inner().cast(), operation.as_ptr(), payload.as_ptr(), completed, context as *mut c_void); }
    }) {
        unsafe { drop(Box::from_raw(context as *mut Completion)); }
        count.fetch_sub(1, Ordering::AcqRel);
        return Err(error.to_string());
    }
    let result = loop {
        let time = match remaining(started, stop) { Ok(time) => time, Err(error) => break Err(error) };
        match receiver.recv_timeout(time.min(SLICE)) {
            Ok(value) => break Ok(value),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(error) => break Err(format!("native completion disconnected: {error}")),
        }
    };
    cancelled.store(true, Ordering::Release);
    result
}
struct Instance { directory: PathBuf }
impl Drop for Instance {
    fn drop(&mut self) {
        for name in ["driver.sock", "token"] {
            if let Err(error) = fs::remove_file(self.directory.join(name)) {
                if error.kind() != std::io::ErrorKind::NotFound { eprintln!("driver cleanup {name}: {error}"); }
            }
        }
        if let Err(error) = fs::remove_dir(&self.directory) { eprintln!("driver cleanup directory: {error}"); }
    }
}
fn transient(error: &std::io::Error) -> bool { matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted) }
fn read_frame(stream: &mut UnixStream, started: Instant, stop: &AtomicBool) -> Result<Value, String> {
    let mut bytes = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        stream.set_read_timeout(Some(remaining(started, stop)?.min(SLICE))).map_err(|e| e.to_string())?;
        let length = match stream.read(&mut chunk) {
            Ok(0) => return Err("session disconnected".into()), Ok(length) => length,
            Err(error) if transient(&error) => continue, Err(error) => return Err(error.to_string()),
        };
        if let Some(end) = chunk[..length].iter().position(|byte| *byte == b'\n') {
            if end + 1 != length { return Err("pipelining is prohibited".into()); }
            if bytes.len() + end > INPUT { return Err("input exceeds 256KiB".into()); }
            bytes.extend_from_slice(&chunk[..end]);
            return serde_json::from_slice(&bytes).map_err(|e| e.to_string());
        }
        if bytes.len() + length > INPUT { return Err("input exceeds 256KiB".into()); }
        bytes.extend_from_slice(&chunk[..length]);
    }
}
fn write_frame(stream: &mut UnixStream, bytes: &[u8], started: Instant, stop: &AtomicBool) -> Result<(), String> {
    let mut offset = 0;
    while offset < bytes.len() {
        stream.set_write_timeout(Some(remaining(started, stop)?.min(SLICE))).map_err(|e| e.to_string())?;
        match stream.write(&bytes[offset..]) {
            Ok(0) => return Err("session write closed".into()), Ok(length) => offset += length,
            Err(error) if transient(&error) => continue, Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}
fn dispatch(app: &AppHandle, request: &Value, views: &[&str], count: &Arc<AtomicUsize>, started: Instant, stop: &Arc<AtomicBool>) -> Result<Value, String> {
    let command = request["command"].as_str().ok_or("command required")?;
    let view = match request.get("view") { None => views[0], Some(value) => value.as_str().ok_or("view must be a string")? };
    if !views.contains(&view) { return Err("view is not permitted by this instance".into()); }
    match command {
        "eval" => native(app, view, "eval", request["script"].as_str().ok_or("script required")?, count, started, stop),
        "inspect" | "capture" | "reload" => native(app, view, command, "", count, started, stop),
        "mouse" | "key" | "text" | "select-all" => {
            let input = request.get("input").filter(|value| value.is_object()).ok_or("input object required")?;
            native(app, view, command, &input.to_string(), count, started, stop)
        }
        "resize" => {
            let width = request["width"].as_u64().ok_or("width required")?;
            let height = request["height"].as_u64().ok_or("height required")?;
            if !(320..=1920).contains(&width) || !(240..=1200).contains(&height) { return Err("resize outside 320..1920 x 240..1200".into()); }
            native(app, view, command, &json!({"width":width,"height":height}).to_string(), count, started, stop)
        }
        #[cfg(feature = "acceptance")]
        "host" => {
            let app = app.clone(); let mut request = request.clone();
            let action = request.as_object_mut().ok_or("host request must be an object")?;
            for key in ["token", "id", "command", "view"] { action.remove(key); }
            let (tx, rx) = mpsc::sync_channel(1);
            let task = tauri::async_runtime::spawn(async move { let _ = tx.send(crate::host::acceptance_request(app, request).await); });
            let result = loop {
                let time = match remaining(started, stop) { Ok(time) => time, Err(error) => break Err(error) };
                match rx.recv_timeout(time.min(SLICE)) {
                    Ok(Ok(value)) => break Ok(json!({"ok":true,"value":value})),
                    Ok(Err(error)) => break Err(error.to_string()),
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(error) => break Err(error.to_string()),
                }
            };
            if result.is_err() { task.abort(); }
            result
        }
        "quit" => Ok(json!({"ok":true,"value":"exit requested"})),
        _ => Err("unknown command".into()),
    }
}
pub fn start(app: AppHandle, stop: Arc<AtomicBool>, views: &'static [&'static str]) -> Result<std::thread::JoinHandle<()>, Box<dyn std::error::Error>> {
    if std::env::var("OC_CHAN_HEADLESS").as_deref() != Ok("1") { return Err("acceptance driver requires explicit headless mode".into()); }
    if views.is_empty() || views.len() > 3 || views.iter().enumerate().any(|(i, value)| !["main", "tray", "recovery", "probe"].contains(value) || views[..i].contains(value)) {
        return Err("invalid fixed acceptance views".into());
    }
    let mut random = [0u8; 32]; std::fs::File::open("/dev/urandom")?.read_exact(&mut random)?;
    let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let directory = PathBuf::from(format!("/tmp/ocwk-{}-{}", std::process::id(), &token[..12]));
    fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let instance = Instance { directory };
    let socket = instance.directory.join("driver.sock");
    if socket.as_os_str().len() >= 104 { return Err("Unix socket path exceeds macOS limit".into()); }
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(instance.directory.join("token"))?;
    file.write_all(token.as_bytes())?; drop(file);
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    if unsafe { libc::listen(listener.as_raw_fd(), 1) } != 0 { return Err(std::io::Error::last_os_error().into()); }
    listener.set_nonblocking(true)?;
    println!("{}", json!({"driverDirectory":instance.directory,"pid":std::process::id(),"views":views,"protocol":std::hint::black_box(MARKER)}));
    Ok(std::thread::spawn(move || {
        let _instance = instance;
        let count = Arc::new(AtomicUsize::new(0));
        while !stop.load(Ordering::Acquire) {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(error) if transient(&error) => { std::thread::sleep(Duration::from_millis(25)); continue; }
                Err(error) => { eprintln!("driver accept: {error}"); break; }
            };
            if let Err(error) = stream.set_nonblocking(false) { eprintln!("driver socket mode: {error}"); continue; }
            let mut uid = 0; let mut gid = 0;
            if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 || uid != unsafe { libc::geteuid() } { continue; }
            let mut last_id = 0u64;
            while !stop.load(Ordering::Acquire) {
                let started = Instant::now();
                let request = match read_frame(&mut stream, started, &stop) { Ok(value) => value, Err(error) => { if !stop.load(Ordering::Acquire) { eprintln!("driver session: {error}"); } break; } };
                let supplied = request["token"].as_str().unwrap_or("");
                if supplied.len() != token.len() || supplied.bytes().zip(token.bytes()).fold(0u8, |value, (a, b)| value | (a ^ b)) != 0 { break; }
                let id = match request["id"].as_u64() { Some(id) if id > last_id => id, _ => break };
                last_id = id;
                let value = dispatch(&app, &request, views, &count, started, &stop).unwrap_or_else(|error| json!({"ok":false,"error":error}));
                let mut bytes = match serde_json::to_vec(&json!({"id":id,"result":value})) { Ok(value) => value, Err(error) => { eprintln!("driver serialization: {error}"); break; } };
                if bytes.len() > OUTPUT { bytes = format!("{{\"id\":{id},\"result\":{{\"ok\":false,\"error\":\"result exceeds 1MiB\"}}}}").into_bytes(); }
                bytes.push(b'\n');
                if let Err(error) = write_frame(&mut stream, &bytes, started, &stop) { eprintln!("driver response: {error}"); break; }
                if request["command"] == "quit" { app.exit(0); break; }
            }
        }
    }))
}
