//! Authenticated, bounded acceptance driver. Compiled out of production.
#[path="text.rs"]
mod text_probe;
use std::{ffi::{CString,c_char},os::unix::fs::{DirBuilderExt,PermissionsExt},sync::Arc,time::Duration};
use gpui::{App,px,size};
use oc_core::error::{Error,Result};
use serde_json::{Value,json};
use tokio::io::{AsyncBufReadExt,AsyncWriteExt,BufReader};
use crate::{host::{Desktop,Phase},api::View,windows::{SharedWindows,native_window}};
unsafe extern "C" {pub fn oc_gpui_capture_init();fn oc_gpui_capture(window:u64,output:*const c_char)->i32;fn oc_gpui_mouse(window:u64,x:f64,y:f64,kind:i32,right:bool)->i32;fn oc_gpui_input(window:u64,json:*const c_char)->i32;fn oc_gpui_draw(window:u64)->i32;}
struct Request {value:Value,reply:tokio::sync::oneshot::Sender<Value>}
pub fn start(host:&Arc<Desktop>,windows:SharedWindows,cx:&mut App)->Result<()> {
    if !host.config.headless{return Ok(());}
    let token=format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple());
    let directory=std::path::PathBuf::from(format!("/tmp/ocgpui-{}-{}",std::process::id(),&token[..12]));
    std::fs::DirBuilder::new().mode(0o700).create(&directory).map_err(|e|Error::io("acceptance directory",e))?;
    let socket=directory.join("driver.sock");
    std::fs::write(directory.join("token"),&token).map_err(|e|Error::io("acceptance token",e))?;
    std::fs::set_permissions(directory.join("token"),std::fs::Permissions::from_mode(0o600)).map_err(|e|Error::io("acceptance permissions",e))?;
    let listener=tokio::net::UnixListener::bind(&socket).map_err(|e|Error::io("acceptance socket",e))?;
    std::fs::set_permissions(&socket,std::fs::Permissions::from_mode(0o600)).map_err(|e|Error::io("acceptance socket permissions",e))?;
    let (tx,rx)=async_channel::bounded::<Request>(4);
    let ui_host=host.clone();
    cx.spawn(async move|cx|{let mut probe=None;while let Ok(request)=rx.recv().await {
        if request.value["command"]=="text-probe" {
            let result=(||->std::result::Result<Value,String>{
                let output=request.value["path"].as_str().ok_or("path required")?;
                let output=std::path::Path::new(output);
                if !output.is_absolute()||output.components().any(|part|matches!(part,std::path::Component::ParentDir))||!output.starts_with(ui_host.config.profile.parent().ok_or("instance missing")?){return Err("capture must stay in owned instance".into());}
                let filename=CString::new(output.to_string_lossy().as_bytes()).map_err(|error|error.to_string())?;
                let pointer=cx.update(|cx|->std::result::Result<u64,String>{
                    if probe.is_none(){probe=Some(text_probe::open(cx)?);}
                    probe.as_ref().ok_or("probe missing")?.update(cx,|_,window,_|{window.refresh();native_window(window).map_err(|error|error.to_string())}).map_err(|error|error.to_string())?
                }).map_err(|error|error.to_string())??;
                // App updates must be released before the native draw re-enters GPUI.
                let status=unsafe{oc_gpui_draw(pointer)};
                if status!=0{return Err(format!("Text probe draw failed: {status}"));}
                let status=unsafe{oc_gpui_capture(pointer,filename.as_ptr())};
                if status!=0{return Err(format!("Text probe Metal capture failed: {status}"));}
                let stats=cx.update(|cx|probe.as_ref().ok_or("probe missing")?.update(cx,|probe,window,_|probe.inspect(window)).map_err(|error|error.to_string())).map_err(|error|error.to_string())??;
                if stats["paintCount"].as_u64().unwrap_or(0)==0{return Err("Text probe canvas did not paint".into());}
                if let Some(error)=stats["paintError"].as_str(){return Err(format!("Text probe paint failed: {error}"));}
                Ok(json!({"path":output,"renderer":"gpui-metal","probe":stats}))
            })();
            let value=match result{Ok(value)=>json!({"ok":true,"value":value}),Err(error)=>{log::error!("OC_TEXT_PROBE: {error}");json!({"ok":false,"error":error})}};
            let _=request.reply.send(value);continue;
        }
        if request.value["command"]=="marketplace-feed" {
            let task_host=ui_host.clone();let value=request.value.clone();
            let task=tokio::spawn(async move{configure_market(&task_host,value).await});
            let value=match task.await{Ok(Ok(value))=>json!({"ok":true,"value":value}),Ok(Err(error))=>json!({"ok":false,"error":error.to_string()}),Err(error)=>json!({"ok":false,"error":error.to_string()})};
            let _=request.reply.send(value);continue;
        }
        if request.value["command"]=="inspect" {
            let view=match request.value["view"].as_str().unwrap_or("main"){"tray"=>View::Tray,"recovery"=>View::Recovery,_=>View::Main};
            let pointer=cx.update(|cx|windows.borrow().handle(view).map(|handle|handle.update(cx,|_,window,_|native_window(window))));
            if let Ok(Some(Ok(Ok(pointer))))=pointer {let status=unsafe{oc_gpui_draw(pointer)};if status!=0{let _=request.reply.send(json!({"ok":false,"error":format!("Native GPUI draw failed: {status}")}));continue;}}
        }
        let result=cx.update(|cx|dispatch(&request.value,&windows,&ui_host,cx));
        let result=result.map_err(|error|error.to_string()).and_then(|value|value).and_then(|mut value|{
            if request.value["command"]=="capture" {
                let pointer=value["window"].as_u64().ok_or("capture window missing")?;
                let filename=CString::new(value["path"].as_str().ok_or("capture path missing")?).map_err(|e|e.to_string())?;
                let status=unsafe{oc_gpui_capture(pointer,filename.as_ptr())};
                if status!=0{return Err(format!("Metal capture failed: {status}"));}
                value.as_object_mut().ok_or("capture response missing")?.remove("window");
            } else if request.value["command"]=="mouse" {
                let kind=match request.value["kind"].as_str().unwrap_or("move"){"down"=>0,"up"=>1,"move"=>2,_=>return Err("invalid mouse kind".into())};
                let status=unsafe{oc_gpui_mouse(value["window"].as_u64().ok_or("window missing")?,value["x"].as_f64().ok_or("x missing")?,value["y"].as_f64().ok_or("y missing")?,kind,request.value["button"]=="right")};
                if status!=0{return Err(format!("Native mouse event failed: {status}"));}
                value=json!(true);
            } else if matches!(request.value["command"].as_str(),Some("key"|"text"|"scroll")) {
                let payload=CString::new(request.value.to_string()).map_err(|e|e.to_string())?;
                let status=unsafe{oc_gpui_input(value["window"].as_u64().ok_or("window missing")?,payload.as_ptr())};
                if status!=0{return Err(format!("Native input failed: {status}"));}value=json!(true);
            }
            Ok(value)
        });
        let value=match result{Ok(value)=>json!({"ok":true,"value":value}),Err(error)=>json!({"ok":false,"error":error})};
        let _=request.reply.send(value);
    }}).detach();
    println!("{}",json!({"driverDirectory":directory,"pid":std::process::id(),"views":["main","tray","recovery"],"protocol":"OC_CHAN_GPUI_ACCEPTANCE_V1"}));
    let mut states=host.subscribe();let server_host=host.clone();
    let server=tokio::spawn(async move {
        loop {
            let accepted=tokio::select!{connection=listener.accept()=>connection,change=states.changed()=>{if change.is_err()||matches!(states.borrow().phase,Phase::Stopping|Phase::Stopped){break;}continue;}};
            let (stream,_)=match accepted{Ok(value)=>value,Err(error)=>{server_host.report(Error::io("acceptance accept",error));break;}};
            if stream.peer_cred().map(|cred|cred.uid()).ok()!=Some(unsafe{libc::geteuid()}){continue;}
            let mut stream=BufReader::new(stream);let mut frame=Vec::with_capacity(4096);
            let read=tokio::time::timeout(Duration::from_secs(15),async {
                loop {let bytes=stream.fill_buf().await?;if bytes.is_empty(){return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof,"frame missing"));}
                    let amount=bytes.iter().position(|byte|*byte==b'\n').map(|i|i+1).unwrap_or(bytes.len());
                    if frame.len()+amount>256*1024{return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"frame exceeds budget"));}
                    let done=bytes[amount-1]==b'\n';frame.extend_from_slice(&bytes[..amount]);stream.consume(amount);if done{return Ok(());}
                }
            }).await;
            if !matches!(read,Ok(Ok(()))){eprintln!("OC_DRIVER_INPUT: {read:?}");continue;}
            let request:Value=match serde_json::from_slice(&frame){Ok(value)=>value,Err(error)=>{eprintln!("OC_DRIVER_JSON: {error}");continue;}};
            let supplied=request["token"].as_str().unwrap_or("");
            if supplied.len()!=token.len()||supplied.bytes().zip(token.bytes()).fold(0u8,|a,(b,c)|a|(b^c))!=0{continue;}
            let Some(id)=request["id"].as_u64() else {continue;};
            let (reply,receive)=tokio::sync::oneshot::channel();
            if tx.try_send(Request{value:request.clone(),reply}).is_err(){eprintln!("OC_DRIVER_BUSY");continue;}
            let value=match tokio::time::timeout(Duration::from_secs(15),receive).await{Ok(Ok(value))=>value,_=>json!({"ok":false,"error":"UI request deadline"})};
            let mut output=match serde_json::to_vec(&json!({"id":id,"result":value})){Ok(value)=>value,Err(error)=>{eprintln!("OC_DRIVER_OUTPUT: {error}");continue;}};
            if output.len()>1024*1024{output=format!("{{\"id\":{id},\"result\":{{\"ok\":false,\"error\":\"output exceeds budget\"}}}}").into_bytes();}output.push(b'\n');
            if let Err(error)=stream.write_all(&output).await{eprintln!("OC_DRIVER_WRITE: {error}");}
            if request["command"]=="quit"{server_host.request_quit(0);break;}
        }
        for name in ["driver.sock","token"]{if let Err(error)=std::fs::remove_file(directory.join(name)){eprintln!("OC_DRIVER_CLEANUP: {error}");}}
        if let Err(error)=std::fs::remove_dir(directory){eprintln!("OC_DRIVER_CLEANUP: {error}");}
    });
    let mut server=Some(server);
    cx.on_app_quit(move |_| {let server=server.take();async move{if let Some(server)=server{if let Err(error)=server.await{eprintln!("OC_DRIVER_JOIN: {error}");}}}}).detach();
    Ok(())
}
fn dispatch(request:&Value,windows:&SharedWindows,host:&Arc<Desktop>,cx:&mut App)->std::result::Result<Value,String>{
    let command=request["command"].as_str().ok_or("command required")?;
    if command=="quit"{return Ok(json!("exit requested"));}
    if command=="state" {
        let state=host.snapshot();let phase=match state.phase{Phase::Starting=>"starting",Phase::Running=>"running",Phase::Recovery(_)=>"recovery",Phase::Fault(_)=>"fault",Phase::Stopping=>"stopping",Phase::Stopped=>"stopped"};
        let mut views=serde_json::Map::new();
        for(name,view)in [("main",View::Main),("tray",View::Tray),("recovery",View::Recovery)]{
            let value=match windows.borrow().handle(view){Some(handle)=>handle.update(cx,|shell,_,_|json!({"connected":shell.root.is_some(),"error":shell.error})).map_err(|error|error.to_string())?,None=>Value::Null};views.insert(name.into(),value);
        }
        return Ok(json!({"phase":phase,"lastError":state.last_error,"views":views}));
    }
    let view=match request["view"].as_str().unwrap_or("main"){"main"=>View::Main,"tray"=>View::Tray,"recovery"=>View::Recovery,_=>return Err("invalid view".into())};
    if command=="open"{windows.borrow_mut().ensure(view,None,host.clone(),cx).map_err(|e|e.to_string())?;return Ok(json!(true));}
    let handle=windows.borrow().handle(view).ok_or("window not ready")?;
    handle.update(cx,|shell,window,cx|->std::result::Result<Value,String>{
        match command {
            "inspect"=>{
                let pointer=native_window(window).map_err(|e|e.to_string())?;
                let mut native=unsafe{let win=pointer as *mut objc2::runtime::AnyObject;let visible:bool=objc2::msg_send![win,isVisible];let key:bool=objc2::msg_send![win,isKeyWindow];let app:*mut objc2::runtime::AnyObject=objc2::msg_send![objc2::class!(NSApplication),sharedApplication];let active:bool=objc2::msg_send![app,isActive];let policy:isize=objc2::msg_send![app,activationPolicy];json!({"visible":visible,"key":key,"appActive":active,"activationPolicy":policy})};
                native["width"]=json!(f32::from(window.viewport_size().width));native["height"]=json!(f32::from(window.viewport_size().height));
                Ok(json!({"native":native,"owner":shell.owner,"error":shell.error,"ui":shell.root.as_ref().map(|root|root.read(cx).inspect_window(window,cx))}))
            },
            "navigate"=>{let page=request["page"].as_str().ok_or("page required")?;let root=shell.root.as_ref().ok_or("view not ready")?;root.update(cx,|root,cx|root.navigate_for_acceptance(page,window,cx))?;Ok(json!(true))},
            "resize"=>{let width=request["width"].as_u64().ok_or("width required")?;let height=request["height"].as_u64().ok_or("height required")?;if !(320..=1920).contains(&width)||!(240..=1200).contains(&height){return Err("resize exceeds budget".into());}window.resize(size(px(width as f32),px(height as f32)));Ok(json!(true))},
            "capture"=>{let output=request["path"].as_str().ok_or("path required")?;let output=std::path::Path::new(output);if !output.is_absolute()||output.components().any(|part|matches!(part,std::path::Component::ParentDir))||!output.starts_with(host.config.profile.parent().ok_or("instance missing")?){return Err("capture must stay in owned instance".into());}window.refresh();Ok(json!({"path":output,"renderer":"gpui-metal","window":native_window(window).map_err(|e|e.to_string())?}))},
            "mouse"=>{let x=request["x"].as_f64().ok_or("x required")?;let y=request["y"].as_f64().ok_or("y required")?;if !x.is_finite()||!y.is_finite()||x<0.||y<0.||x>1920.||y>1200.{return Err("invalid pointer".into());}Ok(json!({"window":native_window(window).map_err(|e|e.to_string())?,"x":x,"y":y}))},
            "key"|"text"|"scroll"=>Ok(json!({"window":native_window(window).map_err(|e|e.to_string())?})),
            _=>Err("unknown GPUI driver command".into()),
        }
    }).map_err(|e|e.to_string())?
}

async fn configure_market(host:&Arc<Desktop>,value:Value)->Result<Value>{
    #[derive(serde::Deserialize)] #[serde(rename_all="camelCase")] struct Asset{directory:std::path::PathBuf,catalog_sha256:String}
    #[derive(serde::Deserialize)] #[serde(rename_all="camelCase")] struct Feed{catalog_url:String,catalog_sha256:String,trusted_assets:Vec<Asset>}
    let feed:Feed=serde_json::from_value(value).map_err(|_|Error::invalid("fixture market feed"))?;
    if feed.trusted_assets.is_empty()||feed.trusted_assets.len()>16{return Err(Error::invalid("fixture asset count"));}
    let mut assets=Vec::with_capacity(feed.trusted_assets.len());
    for asset in feed.trusted_assets{if !asset.directory.is_absolute()||asset.directory.components().any(|part|matches!(part,std::path::Component::ParentDir)){return Err(Error::invalid("fixture path"));}assets.push(oc_core::marketplace::BundledAssets{directory:asset.directory,catalog_sha256:asset.catalog_sha256});}
    host.services()?.market.set_acceptance_feed(oc_core::marketplace::AcceptanceFeed{catalog_url:feed.catalog_url,catalog_sha256:feed.catalog_sha256,trusted_assets:assets}).await?;
    Ok(json!({"configured":true}))
}
