use gpui::{prelude::*, *, actions};
use std::ops::Range;

actions!(oc_input, [Backspace, Delete, Left, Right, SelectAll, Copy, Cut, Paste, Home, End]);
pub struct Changed;
pub struct TextInput {
    pub text: String,
    placeholder: SharedString,
    focus: FocusHandle,
    selection: Range<usize>,
    marked: Option<Range<usize>>,
    bounds: Option<Bounds<Pixels>>,
    line: Option<ShapedLine>,
    pub dark: bool,
}
impl EventEmitter<Changed> for TextInput {}
impl TextInput {
    pub fn new(placeholder: impl Into<SharedString>, cx: &mut Context<Self>) -> Self {
        Self { text: String::new(), placeholder: placeholder.into(), focus: cx.focus_handle(), selection: 0..0, marked: None, bounds: None, line: None, dark: false }
    }
    pub fn set(&mut self, text: String, cx: &mut Context<Self>) { self.text = text; self.selection = self.text.len()..self.text.len(); self.marked = None; cx.notify(); }
    pub fn init(cx: &mut App) {
        cx.bind_keys([
            KeyBinding::new("backspace", Backspace, Some("OcInput")), KeyBinding::new("delete", Delete, Some("OcInput")),
            KeyBinding::new("left", Left, Some("OcInput")), KeyBinding::new("right", Right, Some("OcInput")),
            KeyBinding::new("cmd-a", SelectAll, Some("OcInput")), KeyBinding::new("cmd-c", Copy, Some("OcInput")),
            KeyBinding::new("cmd-x", Cut, Some("OcInput")), KeyBinding::new("cmd-v", Paste, Some("OcInput")),
            KeyBinding::new("home", Home, Some("OcInput")), KeyBinding::new("end", End, Some("OcInput")),
        ]);
    }
    fn from_utf16(&self, n: usize) -> usize { let mut count=0; for (i,c) in self.text.char_indices() { if count >= n { return i; } count+=c.len_utf16(); } self.text.len() }
    fn to_utf16(&self, n: usize) -> usize { self.text[..n].encode_utf16().count() }
    fn utf16(&self, r: Range<usize>) -> Range<usize> { self.to_utf16(r.start)..self.to_utf16(r.end) }
    fn bytes(&self, r: Range<usize>) -> Range<usize> { self.from_utf16(r.start)..self.from_utf16(r.end) }
    fn previous(&self) -> usize { self.text[..self.selection.start].char_indices().next_back().map(|(i,_)|i).unwrap_or(0) }
    fn next(&self) -> usize { self.text[self.selection.end..].chars().next().map(|c|self.selection.end+c.len_utf8()).unwrap_or(self.text.len()) }
    fn replace(&mut self, range: Option<Range<usize>>, text: &str, cx: &mut Context<Self>) {
        let range=range.map(|r|self.bytes(r)).or(self.marked.take()).unwrap_or(self.selection.clone());
        let text=text.replace(['\n','\r'], " ");
        self.text.replace_range(range.clone(), &text); let end=range.start+text.len(); self.selection=end..end;
        cx.emit(Changed); cx.notify();
    }
}
impl Focusable for TextInput { fn focus_handle(&self,_:&App)->FocusHandle { self.focus.clone() } }
impl EntityInputHandler for TextInput {
    fn text_for_range(&mut self,r:Range<usize>,actual:&mut Option<Range<usize>>,_:&mut Window,_:&mut Context<Self>)->Option<String>{let r=self.bytes(r);*actual=Some(self.utf16(r.clone()));Some(self.text[r].into())}
    fn selected_text_range(&mut self,_:bool,_:&mut Window,_:&mut Context<Self>)->Option<UTF16Selection>{Some(UTF16Selection{range:self.utf16(self.selection.clone()),reversed:false})}
    fn marked_text_range(&self,_:&mut Window,_:&mut Context<Self>)->Option<Range<usize>>{self.marked.clone().map(|r|self.utf16(r))}
    fn unmark_text(&mut self,_:&mut Window,cx:&mut Context<Self>){self.marked=None;cx.notify();}
    fn replace_text_in_range(&mut self,r:Option<Range<usize>>,text:&str,_:&mut Window,cx:&mut Context<Self>){self.replace(r,text,cx);}
    fn replace_and_mark_text_in_range(&mut self,r:Option<Range<usize>>,text:&str,selected:Option<Range<usize>>,_:&mut Window,cx:&mut Context<Self>){
        let start=r.clone().map(|r|self.from_utf16(r.start)).or_else(||self.marked.as_ref().map(|r|r.start)).unwrap_or(self.selection.start);
        self.replace(r,text,cx); self.marked=(!text.is_empty()).then_some(start..start+text.len());
        if let Some(r)=selected { let base=self.to_utf16(start); self.selection=self.bytes(base+r.start..base+r.end); } cx.notify();
    }
    fn bounds_for_range(&mut self,r:Range<usize>,bounds:Bounds<Pixels>,_:&mut Window,_:&mut Context<Self>)->Option<Bounds<Pixels>>{let r=self.bytes(r);let l=self.line.as_ref()?;Some(Bounds::from_corners(point(bounds.left()+l.x_for_index(r.start),bounds.top()),point(bounds.left()+l.x_for_index(r.end),bounds.bottom())))}
    fn character_index_for_point(&mut self,p:Point<Pixels>,_:&mut Window,_:&mut Context<Self>)->Option<usize>{Some(self.to_utf16(self.line.as_ref()?.closest_index_for_x(p.x-self.bounds?.left())))}
}
impl Render for TextInput {
    fn render(&mut self,_:&mut Window,cx:&mut Context<Self>)->impl IntoElement {
        div().id("input").w_full().min_w(px(100.)).px_3().py_2().border_1().rounded_md()
            .border_color(rgb(if self.dark {0x53647b}else{0xa9bfdc})).bg(rgb(if self.dark {0x172333}else{0xffffff})).text_color(rgb(if self.dark {0xe9f0fb}else{0x182c47}))
            .key_context("OcInput").track_focus(&self.focus).cursor_text().overflow_hidden()
            .on_mouse_down(MouseButton::Left,cx.listener(|this,event:&MouseDownEvent,window,cx|{this.focus.focus(window);if let (Some(line),Some(bounds))=(&this.line,this.bounds){let i=line.closest_index_for_x(event.position.x-bounds.left()).min(this.text.len()); if event.modifiers.shift{this.selection=this.selection.start.min(i)..this.selection.end.max(i);}else{this.selection=i..i;}}cx.notify();}))
            .on_action(cx.listener(|this,_:&Backspace,_,cx|{if this.selection.is_empty(){this.selection=this.previous()..this.selection.end;}this.replace(None,"",cx);}))
            .on_action(cx.listener(|this,_:&Delete,_,cx|{if this.selection.is_empty(){this.selection=this.selection.start..this.next();}this.replace(None,"",cx);}))
            .on_action(cx.listener(|this,_:&Left,_,cx|{let p=if this.selection.is_empty(){this.previous()}else{this.selection.start};this.selection=p..p;cx.notify();}))
            .on_action(cx.listener(|this,_:&Right,_,cx|{let p=if this.selection.is_empty(){this.next()}else{this.selection.end};this.selection=p..p;cx.notify();}))
            .on_action(cx.listener(|this,_:&Home,_,cx|{this.selection=0..0;cx.notify();}))
            .on_action(cx.listener(|this,_:&End,_,cx|{this.selection=this.text.len()..this.text.len();cx.notify();}))
            .on_action(cx.listener(|this,_:&SelectAll,_,cx|{this.selection=0..this.text.len();cx.notify();}))
            .on_action(cx.listener(|this,_:&Copy,_,cx|{cx.write_to_clipboard(ClipboardItem::new_string(this.text[this.selection.clone()].into()));}))
            .on_action(cx.listener(|this,_:&Cut,_,cx|{cx.write_to_clipboard(ClipboardItem::new_string(this.text[this.selection.clone()].into()));this.replace(None,"",cx);}))
            .on_action(cx.listener(|this,_:&Paste,_,cx|{if let Some(text)=cx.read_from_clipboard().and_then(|i|i.text()){this.replace(None,&text,cx);}}))
            .child(InputElement(cx.entity()))
    }
}
struct InputElement(Entity<TextInput>);
impl IntoElement for InputElement {type Element=Self;fn into_element(self)->Self{self}}
impl Element for InputElement {
    type RequestLayoutState=(); type PrepaintState=ShapedLine;
    fn id(&self)->Option<ElementId>{None}
    fn source_location(&self)->Option<&'static std::panic::Location<'static>>{None}
    fn request_layout(&mut self,_:Option<&GlobalElementId>,_:Option<&InspectorElementId>,window:&mut Window,cx:&mut App)->(LayoutId,()) {let mut style=Style::default();style.size.width=relative(1.).into();style.size.height=px(22.).into();(window.request_layout(style,[],cx),())}
    fn prepaint(&mut self,_:Option<&GlobalElementId>,_:Option<&InspectorElementId>,_:Bounds<Pixels>,_:&mut (),window:&mut Window,cx:&mut App)->ShapedLine {
        let input=self.0.read(cx);let style=window.text_style();let text:SharedString=if input.text.is_empty(){input.placeholder.clone()}else{input.text.clone().into()};let color=if input.text.is_empty(){rgb(if input.dark{0xa9bdd6}else{0x536781}).into()}else{style.color};
        let run=TextRun{len:text.len(),font:style.font(),color,background_color:None,underline:input.marked.as_ref().map(|_|UnderlineStyle{color:Some(color),thickness:px(1.),wavy:false}),strikethrough:None};window.text_system().shape_line(text,style.font_size.to_pixels(window.rem_size()),&[run],None)
    }
    fn paint(&mut self,_:Option<&GlobalElementId>,_:Option<&InspectorElementId>,bounds:Bounds<Pixels>,_:&mut (),line:&mut ShapedLine,window:&mut Window,cx:&mut App) {
        let input=self.0.read(cx);let focus=input.focus.clone();let selection=input.selection.clone();
        window.handle_input(&focus,ElementInputHandler::new(bounds,self.0.clone()),cx);
        if focus.is_focused(window) {let left=bounds.left()+line.x_for_index(selection.start);let right=bounds.left()+line.x_for_index(selection.end);if selection.is_empty(){window.paint_quad(fill(Bounds::new(point(left,bounds.top()),size(px(1.5),bounds.size.height)),rgb(0x2375d8)));}else{window.paint_quad(fill(Bounds::from_corners(point(left,bounds.top()),point(right,bounds.bottom())),rgba(0x4589dc55)));}}
        if let Err(error)=line.paint(bounds.origin,px(22.),window,cx){eprintln!("OC_INPUT_PAINT: {error}");}
        self.0.update(cx,|input,_|{input.bounds=Some(bounds);input.line=Some(line.clone());});
    }
}
