use super::*;
use oc_core::settings::{ResolvedLanguage,SettingsSnapshot,TextSize,UiFont};
impl TopologyView{
    pub fn set_settings(&mut self,settings:&SettingsSnapshot){
        let palette=style::Palette::from_settings(settings);let english=settings.resolved_language==ResolvedLanguage::English;
        let font_size=match settings.settings.text_size{TextSize::Small=>12.,TextSize::Default=>14.,TextSize::Large=>16.};
        let font=match settings.settings.ui_font{UiFont::System=>".AppleSystemUIFont",UiFont::Pingfang=>"PingFang SC",UiFont::Helvetica=>"Helvetica Neue"};
        if self.palette!=palette||self.english!=english||self.font_size!=font_size||self.font!=font{self.palette=palette;self.english=english;self.font_size=font_size;self.font=font;self.dirty=true;}
    }
    pub(super) fn t(&self,zh:&'static str,en:&'static str)->&'static str{if self.english{en}else{zh}}
    pub(super) fn issue(&self,text:&str)->String{if !self.english{return text.into();}text.replace("父子关系存在循环","Parent relationship cycle").replace("父 Agent 不在当前快照中","Parent agent is absent from the current snapshot").replace("未提供父 Agent 关系","Parent agent relationship was not provided").replace("Agent ID 为空或重复，无法构建拓扑","Agent IDs are empty or duplicated; cannot build topology").replace("拓扑包含 ","Topology contains ").replace(" 个节点，超过 "," nodes; limit ").replace(" 上限；请缩小搜索或过滤范围"," exceeded. Narrow the search or filters.").replace("拓扑关系超过 ","Relationship budget exceeded: ").replace(" 上限", "")}
    pub(super) fn page_count(&self)->usize{self.all_graph.nodes.len().div_ceil(200).max(1)}
    pub(super) fn default_view(&mut self){
        if self.camera.flat{
            let filtered=!self.filter.query.trim().is_empty()||self.filter.kind!=Kind::All||self.filter.activity!=Activity::All;
            if let Some(index)=filtered.then(||self.graph.nodes.iter().position(|node|!node.context)).flatten(){self.camera.focus_node(self.flat_positions[index]);}else{self.camera.fit_first_project(&self.flat_positions,&self.layout);}
            let focal=self.bounds.map(|bounds|f32::from(bounds.size.height)).unwrap_or(400.)*1.207;
            self.camera.distance=self.camera.distance.clamp(focal,focal/0.65);
        }else{self.camera.fit(&self.layout,None);}
        self.dirty=true;
    }
    pub(super) fn rebuild_page(&mut self){
        let previous=self.page;self.page=self.page.min(self.page_count()-1);let(graph,boundary)=self.all_graph.page(&self.order,self.page);self.graph=graph;self.boundary=boundary;
        // Flat pages do not replace the retained 3D seat or parcel caches.
        self.layout=Layout::build(&self.graph,&mut Seats::new(),&mut BTreeMap::new());
        self.flat_positions=scene::flat_positions(&self.graph,&self.layout);
        scene::restore_manual_positions(&self.graph,&mut self.flat_positions,&self.flat_seats);
        if previous!=self.page{self.default_view();}
        self.hovered=None;self.drag=None;self.dirty=true;
    }
    pub(super) fn change_page(&mut self,page:usize){let page=page.min(self.page_count()-1);if page!=self.page{self.page=page;self.rebuild_page();self.default_view();}}
    pub(super) fn switch_mode(&mut self){
        let flat=!self.camera.flat;let old=self.camera;let saved=self.other_camera.take();self.camera=saved.unwrap_or(Camera{flat,..Camera::default()});self.camera.flat=flat;self.other_camera=Some(old);self.rebuild();
        if self.camera.flat{if let Some(id)=&self.selected{if let Some(position)=self.order.iter().position(|i|&self.all_graph.nodes[*i].agent.id==id){self.change_page(position/200);}}}
        if let Some(i)=self.selected_index(){self.floor=None;self.camera.focus_node(if self.camera.flat{self.flat_positions[i]}else{self.layout.positions[i]});self.dirty=true;}
        else if saved.is_none(){self.default_view();}
    }
    pub(super) fn locate(&mut self,id:String,cx:&mut Context<Self>){
        if self.camera.flat{if let Some(position)=self.order.iter().position(|i|self.all_graph.nodes[*i].agent.id==id){let page=position/200;if page!=self.page{self.change_page(page);}}}
        if let Some(i)=self.graph.nodes.iter().position(|n|n.agent.id==id){self.floor=None;self.select(Hit::Node(i),cx);self.camera.focus_node(if self.camera.flat{self.flat_positions[i]}else{self.layout.positions[i]});self.dirty=true;}
    }
    pub(super) fn locate_floor(&mut self,index:usize){if let Some(floor)=self.layout.floors.get(index){self.floor=Some(floor.id.clone());let b=&self.layout.buildings[floor.building];self.camera.target=V3::new(b.center.x,floor.y+40.,b.center.z);self.camera.pan=[0.,0.];self.camera.distance=(self.layout.width.max(self.layout.depth)*1.6).max(600.);self.dirty=true;}}
    pub(super) fn keyboard(&mut self,e:&gpui::KeyDownEvent,cx:&mut Context<Self>){
        match e.keystroke.key.as_str(){
            "escape"=>{self.drag=None;self.locator=0;self.floor=None;},
            "left"=>self.camera.pan[0]-=30.,"right"=>self.camera.pan[0]+=30.,"up"=>self.camera.pan[1]-=30.,"down"=>self.camera.pan[1]+=30.,
            "+"|"="=>self.camera.distance=(self.camera.distance/1.15).max(60.),"-"=>self.camera.distance=(self.camera.distance*1.15).min(600_000.),
            "pageup" if self.camera.flat=>self.change_page(self.page.saturating_sub(1)),"pagedown" if self.camera.flat=>self.change_page(self.page+1),
            "enter"=>{if e.keystroke.modifiers.shift{self.tern(cx);}else if let Some(id)=self.selected.clone(){self.locate(id,cx);}},
            "home"|"end"|"tab"=>{let graph=if self.camera.flat{&self.all_graph}else{&self.graph};let n=graph.nodes.len();if n==0{return;}let current=self.selected.as_ref().and_then(|id|graph.nodes.iter().position(|node|&node.agent.id==id));let next=match e.keystroke.key.as_str(){"home"=>0,"end"=>n-1,_=>if e.keystroke.modifiers.shift{current.map(|i|(i+n-1)%n).unwrap_or(n-1)}else{current.map(|i|(i+1)%n).unwrap_or(0)}};let id=graph.nodes[next].agent.id.clone();self.locate(id,cx);cx.stop_propagation();},
            "f"=>{let n=self.layout.floors.len();if n>0{let next=self.floor_index().map(|i|(i+1)%n).unwrap_or(0);self.locate_floor(next);}},
            _=>return,
        }self.dirty=true;cx.notify();
    }
}
