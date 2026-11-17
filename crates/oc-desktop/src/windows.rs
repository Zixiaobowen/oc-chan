use std::{cell::RefCell, rc::Rc, sync::Arc};
use gpui::{prelude::*, App, Bounds, Context, Entity, Window, WindowHandle, WindowOptions, WindowBounds, TitlebarOptions, div, px, size, point};
use oc_core::{error::{Error, Result}, settings::{WindowBounds as SavedBounds, TrayClick}};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use objc2::{msg_send, runtime::AnyObject as Object};
use crate::{api::View, host::Desktop, views::RootView};
use objc2::{MainThreadMarker};
use objc2_app_kit::NSScreen;
use objc2_foundation::{NSRect,NSPoint,NSSize};

pub struct ShellView {
    show_requested: bool,
    visibility: Option<crate::visibility::Visibility>,
    pub root: Option<Entity<RootView>>,
    pub error: Option<String>,
    pub owner: Option<u64>,
}
impl Render for ShellView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().text_color(gpui::rgb(0x1e293b))
            .children(self.root.clone()).when(self.root.is_none(), |el| el.bg(gpui::rgb(0xf8faff)).child(div().p_6().child(self.error.clone().unwrap_or_else(|| "正在连接本机服务 / Connecting local services…".into()))))
    }
}
pub struct Windows {
    pub main: Option<WindowHandle<ShellView>>,
    pub tray: Option<WindowHandle<ShellView>>,
    pub recovery: Option<WindowHandle<ShellView>>,
    pub headless: bool,
    pub tray_click: TrayClick,
}
impl Windows {
    pub fn new(headless: bool) -> Self { Self { main: None, tray: None, recovery: None, headless, tray_click: TrayClick::Tray } }
    pub fn handle(&self, view: View) -> Option<WindowHandle<ShellView>> { match view { View::Main => self.main, View::Tray => self.tray, View::Recovery => self.recovery } }
    pub fn ensure(&mut self, view: View, saved: Option<SavedBounds>, host: Arc<Desktop>, cx: &mut App) -> Result<()> {
        if self.handle(view).is_some_and(|handle| handle.read(cx).is_ok()) { return Ok(()); }
        let dimensions = if matches!(view, View::Tray) { size(px(420.),px(680.)) } else { size(px(1280.),px(860.)) };
        let screens=Screens::read()?;
        let proposed=match saved {Some(bounds)=>bounds,None=>{let area=screens.areas[0].1;SavedBounds{x:area.x+(area.width-f32::from(dimensions.width) as f64)/2.,y:area.y+(area.height-f32::from(dimensions.height) as f64)/2.,width:f32::from(dimensions.width) as f64,height:f32::from(dimensions.height) as f64}}};
        let area=screens.area_for(proposed);let restored=fit(proposed,area);
        let bounds=Bounds::new(point(px(restored.x as f32),px(restored.y as f32)),size(px(restored.width as f32),px(restored.height as f32)));
        let headless = self.headless;
        let handle = cx.open_window(WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions { title: Some("OC Chan".into()), ..Default::default() }),
            window_background:gpui::WindowBackgroundAppearance::Transparent,
            show: false, focus: false,
            window_min_size: Some(if matches!(view,View::Tray) { size(px(320f32.min(area.width as f32)),px(400f32.min(area.height as f32))) } else { size(px(880f32.min(area.width as f32)),px(640f32.min(area.height as f32))) }),
            ..Default::default()
        }, |window,cx| {
            cx.new(|cx| {
                let released=host.clone();
                cx.on_release(move |shell:&mut ShellView,_| { if let Some(owner)=shell.owner { let host=released.clone();tokio::spawn(async move{if let Err(error)=host.revoke(owner).await{host.report(error);}}); } }).detach();
                let geometry=host.clone();let (geometry_sender,mut geometry_receiver)=tokio::sync::watch::channel(None::<SavedBounds>);
                tokio::spawn(async move{while geometry_receiver.changed().await.is_ok(){let bounds=*geometry_receiver.borrow_and_update();if let Some(bounds)=bounds{if let Err(error)=geometry.geometry(bounds).await{geometry.report(error);}}}});
                cx.observe_window_bounds(window,move|_,window,_|{
                    if matches!(view,View::Main) { if let WindowBounds::Windowed(bounds)=window.window_bounds() {geometry_sender.send_replace(Some(SavedBounds{x:f32::from(bounds.origin.x).round() as f64,y:f32::from(bounds.origin.y).round() as f64,width:f32::from(bounds.size.width).round() as f64,height:f32::from(bounds.size.height).round() as f64}));} }
                }).detach();
                let activation=host.clone();
                cx.observe_window_activation(window,move|shell,window,cx|{
                    if !window.is_window_active(){if let Some(root)=&shell.root{root.update(cx,|root,cx|root.window_blurred(cx));}if let Some(owner)=shell.owner{let host=activation.clone();tokio::spawn(async move{if let Err(error)=host.blur(owner).await{host.report(error);}});}}
                    if matches!(view,View::Tray)&&!window.is_window_active()&&!headless{if let Ok(pointer)=native_window(window){unsafe{let _:()=msg_send![pointer as *mut Object,orderOut:std::ptr::null_mut::<Object>()];}}if let Some(root)=&shell.root{root.update(cx,|root,cx|root.set_visible(false,cx));}}
                }).detach();
                let shell = Self::connect(view,host.clone(),window,cx);
                let closing = host.clone();
                let weak=cx.entity().downgrade();
                window.on_window_should_close(cx, move |window,cx| {
                    if let Err(error)=weak.update(cx,|shell,cx|{if let Some(root)=&shell.root{root.update(cx,|root,cx|root.set_visible(false,cx));}}){closing.report(Error::new("OC_WINDOW_VISIBILITY",error.to_string()));}
                    // Closing a desktop inspector keeps the menu bar service alive.
                    if let Ok(pointer) = native_window(window) { unsafe { let _: () = msg_send![pointer as *mut Object, orderOut: std::ptr::null_mut::<Object>()]; } }
                    let host=closing.clone(); tokio::spawn(async move { if let Err(error)=host.hide(view).await {host.report(error);} });
                    false
                });
                shell
            })
        }).map_err(|e|Error::new("OC_WINDOW_CREATE",e.to_string()))?;
        let visibility=crate::visibility::observe(handle,view,host.clone(),cx)?;
        handle.update(cx,|shell,_,_|shell.visibility=Some(visibility)).map_err(|e|Error::new("OC_VISIBILITY_REGISTER",e.to_string()))?;
        match view { View::Main=>self.main=Some(handle),View::Tray=>self.tray=Some(handle),View::Recovery=>self.recovery=Some(handle) }
        Ok(())
    }
    fn connect(view: View, host: Arc<Desktop>, window: &mut Window, cx: &mut Context<ShellView>) -> ShellView {
        cx.spawn_in(window, async move |shell,cx| {
            let native=shell.update_in(cx,|_,window,_|native_window(window)).map_err(|error|Error::new("OC_VIEW_REGISTER",error.to_string())).and_then(|value|value);
            let result=match native {
                Ok(pointer)=>{let register=host.clone();tokio::spawn(async move{register.register(view,pointer).await}).await.map_err(|error|Error::new("OC_VIEW_REGISTER",error.to_string())).and_then(|value|value)},
                Err(error)=>Err(error),
            };
            let update=shell.update_in(cx, |shell,window,cx| match result {
                Ok(owner)=> {
                    shell.owner=Some(owner);
                    shell.root=Some(cx.new(|cx|match view {View::Main=>RootView::new(host.clone(),owner,window,cx),View::Tray=>RootView::tray(host.clone(),owner,window,cx),View::Recovery=>RootView::recovery(host.clone(),owner,window,cx)}));
                    if shell.show_requested&&!host.config.headless{window.on_next_frame(|window,_|window.activate_window());}
                    cx.notify();
                },Err(error)=>{shell.error=Some(error.to_string());cx.notify();}
            });
            if let Err(error)=update {eprintln!("OC_VIEW_CONNECT: {error}");}
        }).detach();
        ShellView{root:None,error:None,owner:None,show_requested:!matches!(view,View::Tray),visibility:None}
    }
    pub fn show(&self,view:View,cx:&mut App)->Result<()> {
        let handle=self.handle(view).ok_or_else(||Error::new("OC_WINDOW_MISSING","Window is not ready"))?;
        if !self.headless {handle.update(cx,|shell,window,cx|{shell.show_requested=true;if let Some(root)=&shell.root{root.update(cx,|root,cx|root.set_visible(true,cx));window.activate_window();}}).map_err(|e|Error::new("OC_WINDOW_SHOW",e.to_string()))?;}
        Ok(())
    }
    pub fn hide(&self,view:View,cx:&mut App)->Result<()> {
        if let Some(handle)=self.handle(view) {handle.update(cx,|shell,window,cx| { shell.show_requested=false;if let Some(root)=&shell.root{root.update(cx,|root,cx|root.set_visible(false,cx));}let pointer=native_window(window)?; unsafe{let _:()=msg_send![pointer as *mut Object,orderOut:std::ptr::null_mut::<Object>()];} Ok(()) }).map_err(|e|Error::new("OC_WINDOW_HIDE",e.to_string()))??;} Ok(())
    }
    pub fn toggle_tray(&mut self,rect:tray_icon::Rect,host:Arc<Desktop>,cx:&mut App)->Result<()> {
        if self.headless{return Err(Error::new("OC_WINDOW_HEADLESS","Cannot present tray in headless mode"));}
        if matches!(self.tray_click,TrayClick::Main){self.hide(View::Tray,cx)?;self.ensure(View::Main,None,host,cx)?;return self.show(View::Main,cx);}
        if let Some(handle)=self.tray{let visible=handle.update(cx,|_,window,_|->Result<bool>{let pointer=native_window(window)?;Ok(unsafe{msg_send![pointer as *mut Object,isVisible]})}).map_err(|e|Error::new("OC_TRAY_STATE",e.to_string()))??;if visible{self.hide(View::Tray,cx)?;let hiding=host.clone();tokio::spawn(async move{if let Err(error)=hiding.hide(View::Tray).await{hiding.report(error);}});return Ok(());}}
        self.ensure(View::Tray,None,host,cx)?;
        let screens=Screens::read()?;let cursor=objc2_app_kit::NSEvent::mouseLocation();let cursor_y=screens.top-cursor.y;
        let(scale,area,_)=screens.areas.iter().find(|(_,_,screen)|cursor.x>=screen.x&&cursor.x<screen.x+screen.width&&cursor_y>=screen.y&&cursor_y<screen.y+screen.height).ok_or_else(||Error::new("OC_TRAY_SCREEN","Tray display disappeared"))?;
        let anchor=SavedBounds{x:rect.position.x/scale,y:rect.position.y/scale,width:rect.size.width as f64/scale,height:rect.size.height as f64/scale};
        let handle=self.tray.ok_or_else(||Error::new("OC_TRAY_STATE","Tray unavailable"))?;
        handle.update(cx,|_,window,_|->Result<()>{let pointer=native_window(window)?;let native=unsafe{&*(pointer as *const objc2_app_kit::NSWindow)};let frame=native.frame();let y=anchor.y+anchor.height+6.;let bounds=fit(SavedBounds{x:anchor.x+anchor.width/2.-frame.size.width/2.,y:if y+frame.size.height<=area.y+area.height{y}else{anchor.y-frame.size.height-6.},width:frame.size.width,height:frame.size.height},*area);native.setFrame_display(NSRect::new(NSPoint::new(bounds.x,screens.top-bounds.y-bounds.height),NSSize::new(bounds.width,bounds.height)),false);Ok(())}).map_err(|e|Error::new("OC_TRAY_POSITION",e.to_string()))??;
        self.show(View::Tray,cx)
    }
    pub fn close(&mut self,view:View,cx:&mut App)->Result<()> {
        let handle=match view {View::Main=>self.main.take(),View::Tray=>self.tray.take(),View::Recovery=>self.recovery.take()};
        // Host shutdown/recovery revokes owners before requesting window disposal.
        if let Some(handle)=handle {handle.update(cx,|shell,window,_|{shell.owner=None;window.remove_window();}).map_err(|e|Error::new("OC_WINDOW_CLOSE",e.to_string()))?;} Ok(())
    }
}
pub type SharedWindows=Rc<RefCell<Windows>>;
pub fn native_window(window:&Window)->Result<u64> {
    let handle=HasWindowHandle::window_handle(window).map_err(|e|Error::new("OC_WINDOW_HANDLE",e.to_string()))?;
    match handle.as_raw() {
        RawWindowHandle::AppKit(handle)=>unsafe {let view=handle.ns_view.as_ptr() as *mut Object;let window:*mut Object=msg_send![view,window];if window.is_null(){Err(Error::new("OC_WINDOW_HANDLE","NSWindow unavailable"))}else{Ok(window as u64)}},
        _=>Err(Error::new("OC_PLATFORM","OC Chan currently requires macOS")),
    }
}
pub fn prohibit_activation() { unsafe {let app:*mut Object=msg_send![objc2::class!(NSApplication),sharedApplication];let accepted:bool=msg_send![app,setActivationPolicy:2isize];assert!(accepted,"headless activation policy rejected");} }

struct Screens {top:f64,areas:Vec<(f64,SavedBounds,SavedBounds)>}
impl Screens {
 fn read()->Result<Self>{
  let marker=MainThreadMarker::new().ok_or_else(||Error::new("OC_WINDOW_THREAD","Screen access requires main thread"))?;
  let screens=NSScreen::screens(marker);if screens.is_empty()||screens.len()>32{return Err(Error::new("OC_WINDOW_SCREEN","Invalid display count"));}
  let primary=screens.objectAtIndex(0).frame();let top=primary.origin.y+primary.size.height;
  let convert=|frame:NSRect|SavedBounds{x:frame.origin.x.round(),y:(top-frame.origin.y-frame.size.height).round(),width:frame.size.width.round(),height:frame.size.height.round()};
  let areas=screens.iter().map(|screen|(screen.backingScaleFactor(),convert(screen.visibleFrame()),convert(screen.frame()))).collect();Ok(Self{top,areas})
 }
 fn area_for(&self,bounds:SavedBounds)->SavedBounds{
  let mut best=0.;let mut area=self.areas[0].1;
  for(_,candidate,_)in &self.areas{let x=(bounds.x+bounds.width).min(candidate.x+candidate.width)-bounds.x.max(candidate.x);let y=(bounds.y+bounds.height).min(candidate.y+candidate.height)-bounds.y.max(candidate.y);let score=x.max(0.)*y.max(0.);if score>best{best=score;area=*candidate;}}
  area
 }
}
fn fit(mut bounds:SavedBounds,area:SavedBounds)->SavedBounds{
 bounds.width=bounds.width.min(area.width).round();bounds.height=bounds.height.min(area.height).round();
 bounds.x=bounds.x.clamp(area.x,area.x+area.width-bounds.width).round();bounds.y=bounds.y.clamp(area.y,area.y+area.height-bounds.height).round();bounds
}

#[cfg(test)] mod tests {
 use super::*;
 #[test] fn removed_display_keeps_restored_window_reachable(){
  let area=SavedBounds{x:0.,y:25.,width:1440.,height:875.};let screens=Screens{top:900.,areas:vec![(2.,area,area)]};
  let saved=SavedBounds{x:3000.,y:2000.,width:1280.,height:860.};let bounds=fit(saved,screens.area_for(saved));
  assert!(bounds.x>=area.x&&bounds.y>=area.y);assert!(bounds.x+bounds.width<=area.x+area.width);assert!(bounds.y+bounds.height<=area.y+area.height);
 }
 #[test] fn small_display_constrains_frame_instead_of_hiding_controls_offscreen(){
  let area=SavedBounds{x:-640.,y:25.,width:640.,height:455.};let bounds=fit(SavedBounds{x:0.,y:0.,width:1280.,height:860.},area);
  assert_eq!(bounds,area);
 }
}
