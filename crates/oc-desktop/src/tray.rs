use std::sync::Arc;
use gpui::App;
use oc_core::{error::{Error,Result},settings::TrayClick};
use tray_icon::{TrayIcon,TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState,Icon,menu::{Menu,MenuItem,MenuEvent}};
use base64::Engine;
use crate::{host::Desktop,windows::SharedWindows,api::View};
pub fn install(host:Arc<Desktop>,windows:SharedWindows,cx:&mut App)->Result<TrayIcon>{
    let bytes=base64::engine::general_purpose::STANDARD.decode(TRAY_PNG).map_err(|e|Error::new("OC_TRAY_ICON",e.to_string()))?;
    let image=image::load_from_memory_with_format(&bytes,image::ImageFormat::Png).map_err(|e|Error::new("OC_TRAY_ICON",e.to_string()))?.into_rgba8();
    let icon=Icon::from_rgba(image.into_raw(),22,18).map_err(|e|Error::new("OC_TRAY_ICON",e.to_string()))?;
    let menu=Menu::new();let show=MenuItem::with_id("show","打开主界面 / Open main window",true,None);let quit=MenuItem::with_id("quit","退出 OC Chan / Quit OC Chan",true,None);
    menu.append_items(&[&show,&quit]).map_err(|e|Error::new("OC_TRAY_MENU",e.to_string()))?;
    let tray=TrayIconBuilder::new().with_id("oc-chan-menu-bar").with_icon(icon).with_icon_as_template(true).with_tooltip("OC Chan").with_menu(Box::new(menu)).with_menu_on_left_click(false).build().map_err(|e|Error::new("OC_TRAY_CREATE",e.to_string()))?;
    let (sender,receive)=async_channel::bounded::<(String,Option<tray_icon::Rect>)>(16);
    let clicks=sender.clone();TrayIconEvent::set_event_handler(Some(move|event|{if let TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,rect,..}=event{if let Err(error)=clicks.try_send(("click".into(),Some(rect))){eprintln!("OC_TRAY_EVENTS: {error}");}}}));
    MenuEvent::set_event_handler(Some(move|event:MenuEvent|{if let Err(error)=sender.try_send((event.id.0,None)){eprintln!("OC_TRAY_EVENTS: {error}");}}));
    cx.spawn(async move|cx|{while let Ok((action,rect))=receive.recv().await{
        if action=="quit"{host.request_quit(0);continue;}
        let result=cx.update(|cx|{
            let mut windows=windows.borrow_mut();
            if let Some(rect)=rect{return windows.toggle_tray(rect,host.clone(),cx);}
            let view=if action=="show"||matches!(windows.tray_click,TrayClick::Main){View::Main}else{View::Tray};
            windows.ensure(view,None,host.clone(),cx)?;windows.show(view,cx)
        });
        match result{Ok(Ok(()))=>{},Ok(Err(error))=>host.report(error),Err(error)=>host.report(Error::new("OC_TRAY_ACTION",error.to_string()))}
    }}).detach();Ok(tray)
}
const TRAY_PNG: &str = concat!(
    "iVBORw0KGgoAAAANSUhEUgAAABYAAAASCAYAAABfJS4tAAAB+0lEQVR4AbyTPUhVYRjHn6IpaqigloqWhqZqiYggW4rGPoaopaKaI/rAxQ8EF3FQEEEQPxAEFRxc1EUXcVBExMlBFF0dREU3/f3OPe/1XhE/Br38f8/zvO97zv88533PvRhn9Ds346e8QDsswAqMwAc4",
    "qBomxnKsheG+Sjv+w/QkfIP7cBteQT/0wCWoAA2rydZiLc4zXVAy/siwAZTmvyi+QCeoz4QW8GbNKGM8ImpzSFEREa6TIpJxVTaK6CM/gybogq/gG5DipyHnAvkluAVizTA0l8z4UUQ8APXPAE/ALknRQRiGJLu0vkX4AcruNRfrzPiuK+BhLZPVEMF9fU1WM4ac7Ebq",
    "SmiD36Ccv0yxDffcii0KdcWQ0032wmmyumE4wCLjCZiHJJvzgUsap5uvsfod1F+Cr7VGvgpvIckvwLqZ8BxGQXlwcxSzkG3FOkU9qFZCOizKeEhwW26SN0B5OB6YtTjW1OzYN82MHdQRfLLfqn8QO/W1fPoL1pQPTAdn17tMSqlpWi8a73DRe2gEdZ3gH4QUmr+JiAGw",
    "0+LNjJPs0q1zPZtzj7OCsAn+++6Q38En8LN7TP4PdieapO9Ys4TzXFZQqXFhJmKVYhB6YQpU6tKbxTlzwnEZhxmXXZAPNNDc7vKpo9NJjXUp7p+D4ziN8XFeZet7AAAA//+sdooGAAAABklEQVQDAP+VYSWkXZklAAAAAElFTkSuQmCC",
);
