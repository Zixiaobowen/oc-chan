use std::{cell::RefCell, collections::BTreeMap, ptr::NonNull, sync::{Arc, Mutex, MutexGuard}, time::Duration};
use base64::Engine;
use block2::RcBlock;
use objc2::{MainThreadMarker, rc::Retained, runtime::ProtocolObject};
use objc2_app_kit::{NSEvent, NSScreen, NSWindow, NSWindowDidMiniaturizeNotification, NSWindowDidDeminiaturizeNotification, NSWindowDidChangeOcclusionStateNotification};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol, NSPoint, NSRect, NSSize};
use objc2_web_kit::WKWebViewConfiguration;
use oc_core::{error::{Error, Result}, settings::{TrayClick, WindowBounds}};
use tauri::{image::Image, menu::{Menu, MenuItem}, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}, webview::{NewWindowResponse, PageLoadEvent}, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::{oneshot, watch, Semaphore};
use crate::api::View;

pub enum WindowSignal {
    DocumentStarted(View), Destroyed(View), Blur(View), Visibility(View, bool), Geometry(WindowBounds),
    ShowMain, Quit, Failed(Error),
}
pub type Sink = Arc<dyn Fn(WindowSignal) + Send + Sync>;
pub struct WindowIdentity { pub view: View, pub address: u64, pub document_key: String }
struct Document { key: String, closing: bool, destroyed: watch::Sender<bool> }
struct State { closed: bool, tray: bool, tray_click: TrayClick, documents: BTreeMap<View, Document> }
impl Default for State {
    fn default() -> Self { Self { closed: false, tray: false, tray_click: TrayClick::Tray, documents: BTreeMap::new() } }
}
struct Inner { app: tauri::AppHandle, headless: bool, sink: Sink, state: Mutex<State>, slots: Arc<Semaphore> }
pub struct Windows { inner: Arc<Inner> }

fn failure(code: &str, operation: &str) -> Error { Error::new(code, format!("窗口操作失败 / Window operation failed: {operation}")) }
fn desktop<T>(result: tauri::Result<T>, operation: &str) -> Result<T> {
    result.map_err(|error| { eprintln!("window {operation}: {error}"); failure("OC_WINDOW_NATIVE", operation) })
}
fn main_thread() -> Result<MainThreadMarker> { MainThreadMarker::new().ok_or_else(|| failure("OC_WINDOW_THREAD", "main thread required")) }

impl Windows {
    pub async fn new(app: tauri::AppHandle, headless: bool, sink: Sink) -> Result<Arc<Self>> {
        let windows = Arc::new(Self { inner: Arc::new(Inner { app, headless, sink, state: Mutex::new(State::default()), slots: Arc::new(Semaphore::new(16)) }) });
        if !headless { windows.inner.main(|inner| inner.create_icon()).await?; }
        Ok(windows)
    }
    pub async fn set_tray_click(&self, value: TrayClick) -> Result<()> {
        self.inner.main(move |inner| {
            inner.open()?;
            inner.state()?.tray_click = value;
            Ok(())
        }).await
    }
    pub async fn ensure_main(&self, bounds: Option<WindowBounds>) -> Result<()> {
        if bounds.is_some_and(|value| !value.validate()) { return Err(Error::invalid("window bounds")); }
        self.inner.main(move |inner| inner.ensure(View::Main, bounds)).await
    }
    pub async fn ensure_recovery(&self) -> Result<()> {
        self.inner.main(|inner| { inner.ensure(View::Recovery, None)?; if !inner.headless { inner.show(View::Recovery)?; } Ok(()) }).await
    }
    pub async fn ensure_tray(&self) -> Result<()> { self.inner.main(|inner| inner.ensure(View::Tray, None)).await }
    pub async fn show_main(&self) -> Result<()> {
        self.inner.main(|inner| {
            if inner.headless { return Err(failure("OC_WINDOW_HEADLESS", "show main")); }
            inner.open()?;
            inner.hide(View::Tray)?;
            inner.ensure(View::Main, None)?;
            inner.show(View::Main)
        }).await
    }
    pub async fn identity(&self, view: View) -> Result<WindowIdentity> {
        self.inner.main(move |inner| {
            inner.open()?;
            let key = {
                let state = inner.state()?;
                let document = state.documents.get(&view).ok_or_else(|| failure("OC_WINDOW_MISSING", view.label()))?;
                if document.closing { return Err(failure("OC_WINDOW_CLOSING", view.label())); }
                document.key.clone()
            };
            let window = inner.window(view)?;
            let address = desktop(window.ns_window(), "window identity")? as usize as u64;
            if address == 0 { return Err(failure("OC_WINDOW_NATIVE", "null NSWindow")); }
            Ok(WindowIdentity { view, address, document_key: key })
        }).await
    }
    pub async fn close_recovery(&self) -> Result<()> {
        let pending = self.inner.main(|inner| inner.destroy(View::Recovery)).await?;
        settle_destroy(pending).await
    }
    pub async fn close(&self) -> Result<()> {
        let (pending, mut errors) = self.inner.main(|inner| {
            inner.state()?.closed = true;
            let mut errors = Vec::new();
            if inner.state()?.tray {
                if let Some(icon) = inner.app.remove_tray_by_id(TRAY_ID) {
                    if let Err(error) = desktop(icon.set_visible(false), "remove tray icon") { errors.push(error); }
                    if let Err(error) = desktop(icon.set_menu(None::<Menu<tauri::Wry>>), "release tray menu") { errors.push(error); }
                    drop(icon);
                } else { errors.push(failure("OC_WINDOW_MISSING", "tray icon")); }
                inner.state()?.tray = false;
            }
            let mut pending = Vec::with_capacity(3);
            for view in [View::Tray, View::Recovery, View::Main] {
                match inner.destroy(view) { Ok(waiter) => pending.push(waiter), Err(error) => errors.push(error) }
            }
            Ok((pending, errors))
        }).await?;
        for waiter in pending { if let Err(error) = settle_destroy(waiter).await { errors.push(error); } }
        if errors.is_empty() { Ok(()) } else { Err(Error::aggregate(errors)) }
    }
}

async fn settle_destroy(waiter: Option<watch::Receiver<bool>>) -> Result<()> {
    if let Some(mut waiter) = waiter {
        tokio::time::timeout(Duration::from_secs(10), async move {
            if !*waiter.borrow() { waiter.changed().await.map_err(|_| failure("OC_WINDOW_CLOSED", "destruction acknowledgement"))?; }
            if !*waiter.borrow() { return Err(failure("OC_WINDOW_CLOSED", "destruction not acknowledged")); }
            Ok(())
        }).await.map_err(|_| Error::timeout("window destruction"))??;
    }
    Ok(())
}

impl Inner {
    fn state(&self) -> Result<MutexGuard<'_, State>> { self.state.lock().map_err(|_| failure("OC_WINDOW_STATE", "state lock")) }
    fn open(&self) -> Result<()> {
        if self.state()?.closed { Err(failure("OC_WINDOW_CLOSED", "window controller closed")) } else { Ok(()) }
    }
    async fn main<T, F>(self: &Arc<Self>, work: F) -> Result<T>
    where T: Send + 'static, F: FnOnce(&Arc<Self>) -> Result<T> + Send + 'static {
        let permit = self.slots.clone().try_acquire_owned().map_err(|_| failure("OC_WINDOW_BUSY", "main-thread admission"))?;
        let (tx, rx) = oneshot::channel();
        let inner = self.clone();
        desktop(self.app.run_on_main_thread(move || {
            let _permit = permit;
            let result = main_thread().and_then(|_| work(&inner));
            let _ = tx.send(result);
        }), "dispatch main thread")?;
        rx.await.map_err(|_| failure("OC_WINDOW_DISPATCH", "main-thread completion"))?
    }
    // Native callbacks use the same bounded dispatch queue; they never spawn a task per event.
    fn event<F>(self: &Arc<Self>, work: F)
    where F: FnOnce(&Arc<Self>) -> Result<()> + Send + 'static {
        let permit = match self.slots.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => { (self.sink)(WindowSignal::Failed(failure("OC_WINDOW_BUSY", "event admission"))); return; }
        };
        let inner = self.clone();
        let result = self.app.run_on_main_thread(move || {
            let _permit = permit;
            if let Err(error) = main_thread().and_then(|_| work(&inner)) { (inner.sink)(WindowSignal::Failed(error)); }
        });
        if let Err(error) = desktop(result, "dispatch window event") { (self.sink)(WindowSignal::Failed(error)); }
    }
    fn window(&self, view: View) -> Result<WebviewWindow> {
        self.app.get_webview_window(view.label()).ok_or_else(|| failure("OC_WINDOW_MISSING", view.label()))
    }
    fn ensure(self: &Arc<Self>, view: View, bounds: Option<WindowBounds>) -> Result<()> {
        self.open()?;
        if let Some(document) = self.state()?.documents.get(&view) {
            return if document.closing { Err(failure("OC_WINDOW_CLOSING", view.label())) } else { Ok(()) };
        }
        let screens = Screens::read()?;
        let mut desired = bounds.unwrap_or(WindowBounds { x: 0.0, y: 0.0, width: 1280.0, height: 860.0 });
        desired.width = desired.width.max(880.0);
        desired.height = desired.height.max(640.0);
        let area = screens.area_for(if bounds.is_some() { desired } else { screens.areas[0].1 });
        let placement = fit(desired, area, bounds.is_none());
        let key = uuid::Uuid::new_v4().to_string();
        // Use WebKit's public keyboard policy for every view, including recovery.
        // SAFETY: configuration and preferences are created and used on the main thread.
        let configuration = unsafe { WKWebViewConfiguration::new(main_thread()?) };
        let preferences = unsafe { configuration.preferences() };
        unsafe { preferences.setTabFocusesLinks(true); }
        if !unsafe { preferences.tabFocusesLinks() } { return Err(failure("OC_WINDOW_NATIVE", "enable keyboard navigation")); }
        let script = format!("if(window===window.top){{Object.defineProperty(window,'__OC_DESKTOP_DOCUMENT__',{{value:'{key}',writable:false,configurable:false,enumerable:false}});}}");
        let weak = Arc::downgrade(self);
        let query = format!("view={}", view.label());
        let allowed_url = format!("tauri://localhost/index.html?{query}");
        let mut builder = WebviewWindowBuilder::new(&self.app, view.label(), WebviewUrl::App(format!("index.html?{query}").into()))
            .with_webview_configuration(configuration)
            .title(if view == View::Recovery { "OC Chan · 设置恢复 / Settings recovery" } else { "OC Chan" })
            .visible(false).focused(false).focusable(!self.headless)
            .initialization_script(script)
            .on_navigation(move |url| url.as_str().split('#').next() == Some(allowed_url.as_str()))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_page_load(move |_, payload| {
                if matches!(payload.event(), PageLoadEvent::Started) {
                    if let Some(inner) = weak.upgrade() { (inner.sink)(WindowSignal::DocumentStarted(view)); }
                }
            });
        // Headless documents are logically live even though their native windows
        // remain hidden. On macOS 14+, prevent WebKit from throttling/suspending
        // their JS; ordinary windows retain the platform's background policy.
        if self.headless {
            builder = builder.background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
        }
        #[cfg(feature = "acceptance")]
        {
            builder = builder.initialization_script(include_str!("../acceptance/renderer-errors.js"));
        }
        builder = match view {
            View::Main => builder.inner_size(placement.width, placement.height)
                .min_inner_size(880.0_f64.min(area.width), 640.0_f64.min(area.height))
                .title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).transparent(true),
            View::Tray => builder.inner_size(380.0, 560.0).decorations(false).resizable(false)
                .maximizable(false).minimizable(false).skip_taskbar(true).always_on_top(!self.headless).transparent(true),
            View::Recovery => builder.inner_size(880.0, 640.0).min_inner_size(480.0, 360.0),
        };
        let observer_key = key.clone();
        let window = desktop(builder.build(), "create local webview")?;
        self.state()?.documents.insert(view, Document { key, closing: false, destroyed: watch::channel(false).0 });
        let weak = Arc::downgrade(self);
        window.on_window_event(move |event| {
            if let Some(inner) = weak.upgrade() {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        // Explicit destruction uses destroy(), bypassing this user close interception.
                        api.prevent_close();
                        inner.event(move |inner| {
                            if inner.state()?.closed { return Ok(()); }
                            if view == View::Recovery { (inner.sink)(WindowSignal::Quit); Ok(()) } else { inner.hide(view) }
                        });
                    }
                    WindowEvent::Destroyed => {
                        // Acknowledgement must not compete with ordinary UI admission during shutdown.
                        let document = inner.state().map(|mut state| state.documents.remove(&view));
                        match document {
                            Ok(Some(document)) => {
                                if let Err(error) = remove_visibility_observers(&document.key) { (inner.sink)(WindowSignal::Failed(error)); }
                                document.destroyed.send_replace(true);
                            }
                            Ok(None) => {}
                            Err(error) => (inner.sink)(WindowSignal::Failed(error)),
                        }
                        (inner.sink)(WindowSignal::Destroyed(view));
                    }
                    WindowEvent::Focused(focused) => {
                        let focused = *focused;
                        inner.event(move |inner| {
                            if inner.state()?.closed { return Ok(()); }
                            if !focused {
                                (inner.sink)(WindowSignal::Blur(view));
                                if view == View::Tray { inner.hide(view)?; }
                            }
                            inner.visibility(view)?;
                            Ok(())
                        });
                    }
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } if view == View::Main => {
                        inner.event(|inner| inner.geometry());
                    }
                    _ => {}
                }
            }
        });
        let setup = (|| {
            install_visibility_observers(self, view, &observer_key, &window)?;
            if view == View::Main { set_frame(&window, placement, screens.top)?; self.geometry()?; }
            else if view == View::Recovery {
                let bounds = fit(WindowBounds { x: 0.0, y: 0.0, width: 880.0, height: 640.0 }, screens.areas[0].1, true);
                set_frame(&window, bounds, screens.top)?;
            }
            Ok(())
        })();
        if let Err(error) = setup {
            let cleanup = self.destroy(view);
            return Err(match cleanup { Ok(_) => error, Err(cleanup) => Error::aggregate(vec![error, cleanup]) });
        }
        Ok(())
    }
    fn show(&self, view: View) -> Result<()> {
        self.open()?;
        if self.headless { return Err(failure("OC_WINDOW_HEADLESS", "show window")); }
        let window = self.window(view)?;
        let native = native_window(&window)?;
        if native.isMiniaturized() { native.deminiaturize(None); }
        native.makeKeyAndOrderFront(None);
        desktop(window.set_focus(), "focus window")?;
        if !native.isVisible() { return Err(failure("OC_WINDOW_NATIVE", "window did not become visible")); }
        (self.sink)(WindowSignal::Visibility(view, true));
        Ok(())
    }
    fn hide(&self, view: View) -> Result<()> {
        if let Some(window) = self.app.get_webview_window(view.label()) {
            let native = native_window(&window)?;
            native.orderOut(None);
            if native.isVisible() { return Err(failure("OC_WINDOW_NATIVE", "window did not hide")); }
            (self.sink)(WindowSignal::Visibility(view, false));
        }
        Ok(())
    }
    fn visibility(&self, view: View) -> Result<()> {
        {
            let state = self.state()?;
            if state.closed || state.documents.get(&view).is_none_or(|document| document.closing) { return Ok(()); }
        }
        let window = self.window(view)?;
        let native = native_window(&window)?;
        (self.sink)(WindowSignal::Visibility(view, native.isVisible() && !native.isMiniaturized()));
        Ok(())
    }
    fn geometry(&self) -> Result<()> {
        if self.state()?.closed { return Ok(()); }
        let window = self.window(View::Main)?;
        let native = native_window(&window)?;
        if native.isMiniaturized() || native.isZoomed() || desktop(window.is_fullscreen(), "fullscreen state")? { return Ok(()); }
        let bounds = from_native(native.frame(), Screens::read()?.top);
        if !bounds.validate() { return Err(Error::invalid("native window geometry")); }
        (self.sink)(WindowSignal::Geometry(bounds));
        Ok(())
    }
    fn destroy(&self, view: View) -> Result<Option<watch::Receiver<bool>>> {
        let (rx, observer_key) = {
            let mut state = self.state()?;
            let Some(document) = state.documents.get_mut(&view) else { return Ok(None); };
            let rx = document.destroyed.subscribe();
            if document.closing { return Ok(Some(rx)); }
            document.closing = true;
            (rx, document.key.clone())
        };
        let result = remove_visibility_observers(&observer_key)
            .and_then(|_| self.window(view))
            .and_then(|window| desktop(window.destroy(), "destroy window"));
        if let Err(error) = result {
            if let Some(document) = self.state()?.documents.get_mut(&view) { document.closing = false; }
            return Err(error);
        }
        Ok(Some(rx))
    }
    fn create_icon(self: &Arc<Self>) -> Result<()> {
        self.open()?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(TRAY_PNG).map_err(|_| failure("OC_WINDOW_ICON", "decode brand template"))?;
        let image = desktop(Image::from_bytes(&bytes), "load brand template")?;
        let show = desktop(MenuItem::with_id(&self.app, "oc-show-main", "打开主界面 / Open main window", true, None::<&str>), "create show menu")?;
        let quit = desktop(MenuItem::with_id(&self.app, "oc-quit", "退出 OC Chan / Quit OC Chan", true, None::<&str>), "create quit menu")?;
        let menu = desktop(Menu::with_items(&self.app, &[&show, &quit]), "create tray menu")?;
        let menu_weak = Arc::downgrade(self);
        let tray_weak = Arc::downgrade(self);
        desktop(TrayIconBuilder::with_id(TRAY_ID).icon(image).icon_as_template(true).tooltip("OC Chan")
            .menu(&menu).show_menu_on_left_click(false)
            .on_menu_event(move |_, event| {
                if let Some(inner) = menu_weak.upgrade() {
                    let id = event.id().as_ref().to_owned();
                    inner.event(move |inner| {
                        inner.open()?;
                        match id.as_str() { "oc-show-main" => (inner.sink)(WindowSignal::ShowMain), "oc-quit" => (inner.sink)(WindowSignal::Quit), _ => {} }
                        Ok(())
                    });
                }
            })
            .on_tray_icon_event(move |_, event| {
                if let TrayIconEvent::Click { rect, button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    if let Some(inner) = tray_weak.upgrade() { inner.event(move |inner| inner.toggle_tray(rect)); }
                }
            }).build(&self.app), "create tray icon")?;
        self.state()?.tray = true;
        Ok(())
    }
    fn toggle_tray(self: &Arc<Self>, rect: tauri::Rect) -> Result<()> {
        self.open()?;
        if self.headless { return Err(failure("OC_WINDOW_HEADLESS", "toggle tray")); }
        if matches!(self.state()?.tray_click, TrayClick::Main) {
            self.hide(View::Tray)?;
            (self.sink)(WindowSignal::ShowMain);
            return Ok(());
        }
        if let Some(window) = self.app.get_webview_window(View::Tray.label()) {
            if native_window(&window)?.isVisible() { return self.hide(View::Tray); }
        }
        self.ensure(View::Tray, None)?;
        let screens = Screens::read()?;
        // tray-icon reports coordinates scaled by its own display, including the global origin.
        let (anchor, area) = screens.tray_area(rect)?;
        let window = self.window(View::Tray)?;
        let frame = native_window(&window)?.frame();
        let width = frame.size.width.min(area.width);
        let height = frame.size.height.min(area.height);
        let below = anchor.y + anchor.height + 6.0;
        let y = if below + height <= area.y + area.height { below } else { anchor.y - height - 6.0 };
        let bounds = fit(WindowBounds { x: anchor.x + anchor.width / 2.0 - width / 2.0, y, width, height }, area, false);
        set_frame(&window, bounds, screens.top)?;
        self.show(View::Tray)
    }
}

type Observer = Retained<ProtocolObject<dyn NSObjectProtocol>>;
thread_local! {
    // AppKit tokens are never Send; both registration and release stay on the UI thread.
    static VISIBILITY_OBSERVERS: RefCell<BTreeMap<String, Vec<Observer>>> = const { RefCell::new(BTreeMap::new()) };
}
fn install_visibility_observers(inner: &Arc<Inner>, view: View, key: &str, window: &WebviewWindow) -> Result<()> {
    let native = native_window(window)?;
    VISIBILITY_OBSERVERS.with(|observers| {
        if observers.borrow().len() >= 3 { return Err(Error::limit("window visibility observers", 3, observers.borrow().len() + 1)); }
        let center = NSNotificationCenter::defaultCenter();
        let mut tokens = Vec::with_capacity(3);
        let document_key: Arc<str> = Arc::from(key);
        // SAFETY: These immutable AppKit notification constants are read on the main thread.
        let names = unsafe { [NSWindowDidMiniaturizeNotification, NSWindowDidDeminiaturizeNotification, NSWindowDidChangeOcclusionStateNotification] };
        for name in names {
            let weak = Arc::downgrade(inner);
            let key = document_key.clone();
            let block = RcBlock::new(move |_: NonNull<NSNotification>| {
                if let Some(inner) = weak.upgrade() {
                    let key = key.clone();
                    inner.event(move |inner| {
                        let current = inner.state()?.documents.get(&view).is_some_and(|document| document.key == key.as_ref());
                        if current { inner.visibility(view)?; }
                        Ok(())
                    });
                }
            });
            // SAFETY: The observed object is the live NSWindow. The block captures only Send
            // data and marshals its work to the UI thread; no operation queue retains a window.
            let observer = unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), Some(native), None, &block) };
            tokens.push(observer);
        }
        observers.borrow_mut().insert(key.to_owned(), tokens);
        Ok(())
    })
}
fn remove_visibility_observers(key: &str) -> Result<()> {
    main_thread()?;
    let tokens = VISIBILITY_OBSERVERS.with(|observers| observers.borrow_mut().remove(key));
    if let Some(tokens) = tokens {
        let center = NSNotificationCenter::defaultCenter();
        for observer in tokens {
            // SAFETY: Every token was returned by this center's block registration API.
            unsafe { center.removeObserver((*observer).as_ref()); }
        }
    }
    Ok(())
}

// Raw native references never escape the main-thread call or cross an await point.
fn native_window(window: &WebviewWindow) -> Result<&NSWindow> {
    main_thread()?;
    let pointer = desktop(window.ns_window(), "read NSWindow")?;
    if pointer.is_null() { return Err(failure("OC_WINDOW_NATIVE", "null NSWindow")); }
    // SAFETY: Tauri owns the live NSWindow, and all call sites stay on the main thread.
    Ok(unsafe { &*pointer.cast::<NSWindow>() })
}
fn set_frame(window: &WebviewWindow, bounds: WindowBounds, top: f64) -> Result<()> {
    let native = native_window(window)?;
    native.setFrame_display(NSRect::new(NSPoint::new(bounds.x, top - bounds.y - bounds.height), NSSize::new(bounds.width, bounds.height)), false);
    if from_native(native.frame(), top) != bounds { return Err(failure("OC_WINDOW_NATIVE", "window frame was not applied")); }
    Ok(())
}
fn from_native(frame: NSRect, top: f64) -> WindowBounds {
    WindowBounds { x: frame.origin.x.round(), y: (top - frame.origin.y - frame.size.height).round(), width: frame.size.width.round(), height: frame.size.height.round() }
}
struct Screens { top: f64, areas: Vec<(f64, WindowBounds, WindowBounds)> }
impl Screens {
    fn read() -> Result<Self> {
        let screens = NSScreen::screens(main_thread()?);
        if screens.is_empty() { return Err(failure("OC_WINDOW_SCREEN", "no available screen")); }
        if screens.len() > 32 { return Err(Error::limit("displays", 32, screens.len())); }
        let primary = screens.objectAtIndex(0).frame();
        let top = primary.origin.y + primary.size.height;
        let mut areas = Vec::with_capacity(screens.len());
        for screen in screens.iter() { areas.push((screen.backingScaleFactor(), from_native(screen.visibleFrame(), top), from_native(screen.frame(), top))); }
        Ok(Self { top, areas })
    }
    fn area_for(&self, bounds: WindowBounds) -> WindowBounds {
        let mut area = self.areas[0].1;
        let mut best = 0.0;
        for (_, candidate, _) in &self.areas {
            let overlap = (bounds.x + bounds.width).min(candidate.x + candidate.width) - bounds.x.max(candidate.x);
            let vertical = (bounds.y + bounds.height).min(candidate.y + candidate.height) - bounds.y.max(candidate.y);
            let score = overlap.max(0.0) * vertical.max(0.0);
            if score > best { best = score; area = *candidate; }
        }
        area
    }
    fn tray_area(&self, rect: tauri::Rect) -> Result<(WindowBounds, WindowBounds)> {
        let cursor = NSEvent::mouseLocation();
        let cursor_y = self.top - cursor.y;
        for (scale, work, screen) in &self.areas {
            if cursor.x < screen.x || cursor.x >= screen.x + screen.width || cursor_y < screen.y || cursor_y >= screen.y + screen.height { continue; }
            let position = rect.position.to_logical::<f64>(*scale);
            let size = rect.size.to_logical::<f64>(*scale);
            let anchor = WindowBounds { x: position.x, y: position.y, width: size.width, height: size.height };
            let x = anchor.x + anchor.width / 2.0;
            let y = anchor.y + anchor.height / 2.0;
            if x >= screen.x && x < screen.x + screen.width && y >= screen.y && y < screen.y + screen.height { return Ok((anchor, *work)); }
        }
        Err(failure("OC_WINDOW_SCREEN", "tray display disappeared"))
    }
}
fn fit(mut bounds: WindowBounds, area: WindowBounds, center: bool) -> WindowBounds {
    bounds.width = bounds.width.min(area.width).round();
    bounds.height = bounds.height.min(area.height).round();
    if center { bounds.x = area.x + (area.width - bounds.width) / 2.0; bounds.y = area.y + (area.height - bounds.height) / 2.0; }
    bounds.x = bounds.x.clamp(area.x, area.x + area.width - bounds.width).round();
    bounds.y = bounds.y.clamp(area.y, area.y + area.height - bounds.height).round();
    bounds
}
const TRAY_ID: &str = "oc-chan-menu-bar";
// Existing 22×18 template raster of resources/brand/oc-chan-mono.svg, retained from createTrayIcon.
const TRAY_PNG: &str = concat!(
    "iVBORw0KGgoAAAANSUhEUgAAABYAAAASCAYAAABfJS4tAAAB+0lEQVR4AbyTPUhVYRjHn6IpaqigloqWhqZqiYggW4rGPoaopaKaI/rAxQ8EF3FQEEEQPxAEFRxc1EUXcVBExMlBFF0dREU3/f3OPe/1XhE/Br38f8/zvO97zv88533PvRhn9Ds346e8QDsswAqMwAc4",
    "qBomxnKsheG+Sjv+w/QkfIP7cBteQT/0wCWoAA2rydZiLc4zXVAy/siwAZTmvyi+QCeoz4QW8GbNKGM8ImpzSFEREa6TIpJxVTaK6CM/gybogq/gG5DipyHnAvkluAVizTA0l8z4UUQ8APXPAE/ALknRQRiGJLu0vkX4AcruNRfrzPiuK+BhLZPVEMF9fU1WM4ac7Ebq",
    "SmiD36Ccv0yxDffcii0KdcWQ0032wmmyumE4wCLjCZiHJJvzgUsap5uvsfod1F+Cr7VGvgpvIckvwLqZ8BxGQXlwcxSzkG3FOkU9qFZCOizKeEhwW26SN0B5OB6YtTjW1OzYN82MHdQRfLLfqn8QO/W1fPoL1pQPTAdn17tMSqlpWi8a73DRe2gEdZ3gH4QUmr+JiAGw",
    "0+LNjJPs0q1zPZtzj7OCsAn+++6Q38En8LN7TP4PdieapO9Ys4TzXFZQqXFhJmKVYhB6YQpU6tKbxTlzwnEZhxmXXZAPNNDc7vKpo9NJjXUp7p+D4ziN8XFeZet7AAAA//+sdooGAAAABklEQVQDAP+VYSWkXZklAAAAAElFTkSuQmCC",
);
