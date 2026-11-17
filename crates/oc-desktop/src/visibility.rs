use std::{ptr::NonNull,sync::Arc};
use block2::RcBlock;
use objc2::{rc::Retained,runtime::ProtocolObject};
use objc2_foundation::{NSNotification,NSNotificationCenter,NSObjectProtocol};
use objc2_app_kit::{NSWindow,NSWindowDidMiniaturizeNotification,NSWindowDidDeminiaturizeNotification,NSWindowDidChangeOcclusionStateNotification,NSWindowOcclusionState};
use gpui::{App,WindowHandle};
use oc_core::error::{Error,Result};
use crate::{api::View,host::Desktop,windows::{ShellView,native_window}};

pub struct Visibility {tokens:Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>}
impl Drop for Visibility {
 fn drop(&mut self){let center=NSNotificationCenter::defaultCenter();for token in self.tokens.drain(..){unsafe{center.removeObserver(token.as_ref());}}}
}
pub fn observe(handle:WindowHandle<ShellView>,view:View,host:Arc<Desktop>,cx:&mut App)->Result<Visibility>{
 let pointer=handle.update(cx,|_,window,_|native_window(window)).map_err(|e|Error::new("OC_VISIBILITY_WINDOW",e.to_string()))??;
 let native=unsafe{&*(pointer as *const NSWindow)};
 let (send,mut receive)=tokio::sync::watch::channel(host.config.headless||native.isVisible());
 let mut tokens=Vec::with_capacity(3);let center=NSNotificationCenter::defaultCenter();
 for name in unsafe{[NSWindowDidMiniaturizeNotification,NSWindowDidDeminiaturizeNotification,NSWindowDidChangeOcclusionStateNotification]} {
  let send=send.clone();let headless=host.config.headless;
  let block=RcBlock::new(move|_:NonNull<NSNotification>|{
   if unsafe{libc::pthread_main_np()}==0{eprintln!("OC_VISIBILITY_THREAD: AppKit notification outside main thread");return;}
   let native=unsafe{&*(pointer as *const NSWindow)};
   let visible=headless||(native.isVisible()&&!native.isMiniaturized()&&native.occlusionState().contains(NSWindowOcclusionState::Visible));
   send.send_replace(visible);
  });
  tokens.push(unsafe{center.addObserverForName_object_queue_usingBlock(Some(name),Some(native),None,&block)});
 }
 cx.spawn(async move|cx|{while receive.changed().await.is_ok(){
  let visible=*receive.borrow_and_update();
  if let Err(error)=handle.update(cx,|shell,_,cx|{if let Some(root)=&shell.root{root.update(cx,|root,cx|root.set_visible(visible,cx));}}){host.report(Error::new("OC_VISIBILITY_VIEW",error.to_string()));break;}
  if !visible{let hiding=host.clone();match tokio::spawn(async move{hiding.hide(view).await}).await{Ok(Ok(()))=>{},Ok(Err(error))=>host.report(error),Err(error)=>host.report(Error::new("OC_VISIBILITY_TASK",error.to_string()))}}
 }}).detach();Ok(Visibility{tokens})
}
