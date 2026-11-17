//! Tiny acceptance-only scene using the application's text system and asset source.
use std::{cell::RefCell, rc::Rc};
use gpui::{prelude::*, App, Bounds, Context, Pixels, ShapedLine, TextRun, Window, WindowBounds, WindowHandle, WindowOptions, canvas, div, point, px, rgb, size, svg};
use serde_json::{Value, json};

const TEXT: &str = "GPUI Glyph Probe";
const FONT: &str = ".AppleSystemUIFont";
const ICON: &str = "resources/brand/oc-chan-mono.svg";

pub struct TextProbe { stats: Rc<RefCell<Value>> }

pub fn open(cx: &mut App) -> Result<WindowHandle<TextProbe>, String> {
    cx.open_window(WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(point(px(0.), px(0.)), size(px(480.), px(240.))))),
        show: false, focus: false, titlebar: None,
        ..Default::default()
    }, |_, cx| cx.new(|_| TextProbe { stats: Rc::new(RefCell::new(json!({"paintCount":0}))) }))
    .map_err(|error| error.to_string())
}

fn rect(bounds: Bounds<Pixels>) -> Value {
    json!({"x":f32::from(bounds.origin.x),"y":f32::from(bounds.origin.y),"width":f32::from(bounds.size.width),"height":f32::from(bounds.size.height)})
}

fn metrics(line: &ShapedLine) -> Value {
    json!({"bytes":line.len,"width":f32::from(line.width),"fontSize":f32::from(line.font_size),"ascent":f32::from(line.ascent),"descent":f32::from(line.descent),
        "glyphCount":line.runs.iter().map(|run|run.glyphs.len()).sum::<usize>(),
        "runs":line.runs.iter().map(|run|json!({"fontId":format!("{:?}",run.font_id),"glyphs":run.glyphs.iter().map(|glyph|json!({"id":format!("{:?}",glyph.id),"index":glyph.index,"x":f32::from(glyph.position.x),"y":f32::from(glyph.position.y),"emoji":glyph.is_emoji})).collect::<Vec<_>>()})).collect::<Vec<_>>()})
}

impl TextProbe {
    pub fn inspect(&self, window: &Window) -> Value {
        let mut value=self.stats.borrow().clone();
        value["viewport"]=json!({"width":f32::from(window.viewport_size().width),"height":f32::from(window.viewport_size().height)});
        value["scaleFactor"]=json!(window.scale_factor());
        let native=crate::windows::native_window(window);
        match native {
            Ok(pointer)=>unsafe {
                let win=pointer as *mut objc2::runtime::AnyObject;
                let visible:bool=objc2::msg_send![win,isVisible];
                let key:bool=objc2::msg_send![win,isKeyWindow];
                value["native"]=json!({"visible":visible,"key":key});
            },
            Err(error)=>{log::error!("OC_TEXT_PROBE_NATIVE: {error}");value["nativeError"]=json!(error.to_string());}
        }
        value
    }
}

impl Render for TextProbe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let canonical=self.stats.clone();
        let painted=self.stats.clone();
        div().size_full().flex().flex_col().gap_4().p_4().bg(rgb(0xffffff))
            .font_family(FONT).text_size(px(24.)).text_color(rgb(0x112233))
            .child(div().relative().h(px(40.)).w_full().child(TEXT)
                .child(canvas(move |bounds,_,_| {canonical.borrow_mut()["canonicalBounds"]=rect(bounds);},|_,_,_,_| {}).absolute().top_0().left_0().size_full()))
            .child(svg().path(ICON).size(px(32.)).text_color(rgb(0x112233)))
            .child(canvas(|_,_,_| (),move |bounds,_,window,cx| {
                let style=window.text_style();
                let run=TextRun {len:TEXT.len(),font:style.font(),color:style.color,background_color:None,underline:None,strikethrough:None};
                let line=window.text_system().shape_line(TEXT.into(),px(24.),&[run.clone()],None);
                let ascii="0123456789 ABC xyz";
                let direct=window.text_system().shape_line(ascii.into(),px(24.),&[TextRun{len:ascii.len(),..run}],None);
                let result=line.paint(bounds.origin,px(40.),window,cx);
                let error=result.err().map(|error|error.to_string());
                if let Some(error)=&error {log::error!("OC_TEXT_PROBE_PAINT: {error}");}
                let mut stats=painted.borrow_mut();
                let count=stats["paintCount"].as_u64().unwrap_or(0)+1;
                stats["paintCount"]=json!(count);
                stats["text"]=json!(TEXT);stats["font"]=json!(FONT);stats["resolvedFont"]=json!(format!("{:?}",style.font()));
                stats["color"]=json!(format!("{:?}",style.color));stats["icon"]=json!(ICON);
                stats["manualBounds"]=rect(bounds);stats["manualLine"]=metrics(&line);
                stats["directAscii"]=json!({"text":ascii,"metrics":metrics(&direct)});
                stats["paintError"]=json!(error);stats["paintSucceeded"]=json!(error.is_none());
            }).w_full().h(px(40.)))
    }
}
