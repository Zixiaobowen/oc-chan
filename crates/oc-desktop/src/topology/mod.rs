mod graph;
mod layout;
mod scene;
mod geometry;
mod navigation;
mod view;
pub(crate) mod style;

use gpui::{prelude::*, canvas, div, point, px, rgb, Bounds, Context, EventEmitter, FocusHandle, Focusable, MouseButton, MouseDownEvent, MouseMoveEvent, PathBuilder, Pixels, Render, SharedString, TextRun, Window};
use oc_core::model::AgentInfo;
use std::collections::BTreeMap;
use std::sync::Arc;
use graph::{Activity,Filter,Graph,Kind};
use layout::{Layout,Seats,V3};
use scene::{Camera,Frame,Hit};

#[derive(Clone,Debug)]
pub enum TopologyEvent { Select(String), FocusTern(String) }
struct Drag { start:[f32;2], last:[f32;2], hit:Option<Hit>, target:Option<String>, pan:bool, moved:bool, offset:Option<V3> }
impl Drag {
    // Snapshot sorting can change indices while a physical button is held.
    fn reconcile(&mut self,graph:&Graph,layout:&Layout,positions:&[V3],camera:&Camera,view:[f32;4])->bool {
        self.hit=match self.hit {
            Some(Hit::Node(_))=>self.target.as_ref().and_then(|id|graph.nodes.iter().position(|n|&n.agent.id==id)).map(Hit::Node),
            Some(Hit::Floor(_))=>self.target.as_ref().and_then(|id|layout.floors.iter().position(|f|&f.id==id)).map(Hit::Floor),
            Some(Hit::Building(_))=>self.target.as_ref().and_then(|id|layout.buildings.iter().position(|b|&b.id==id)).map(Hit::Building),
            None=>return true,
        };
        let Some(hit)=self.hit else{return false;};
        if self.offset.is_some(){if let Hit::Node(i)=hit{let seat=positions[i];self.offset=camera.floor_point(self.last,seat.y,view).map(|q|V3::new(seat.x-q.x,0.,seat.z-q.z));}}
        true
    }
}
/// Native GPU path topology. Snapshot/query setters are called inside Entity::update;
/// the owning view must notify its Context after applying a snapshot.
pub struct TopologyView {
    agents:Vec<Arc<AgentInfo>>, filter:Filter, graph:Graph, layout:Layout, seats:Seats,
    // frame remains the last painted scene through refresh/rebuild/dirty changes.
    // Only paint replaces it; its indices must be resolved by stable identity.
    slots:BTreeMap<String,usize>, camera:Camera, frame:Frame, bounds:Option<Bounds<Pixels>>,
    dirty:bool, scale:f32, canvas:Option<gpui::Entity<TopologyCanvas>>, error:Option<String>, selected:Option<String>, floor:Option<String>,
    drag:Option<Drag>, hovered:Option<Hit>, focus:FocusHandle, evidence_current:bool,
    palette:style::Palette,english:bool,font_size:f32,font:&'static str,
    all_graph:Graph,order:Vec<usize>,page:usize,boundary:usize,locator:u8,
    flat_positions:Vec<V3>,flat_seats:BTreeMap<String,V3>,other_camera:Option<Camera>,
    rejected_input:Option<usize>,
    #[cfg(feature="acceptance")]
    mode_bounds:std::rc::Rc<std::cell::RefCell<Option<Bounds<Pixels>>>>,
    #[cfg(feature="acceptance")]
    pointer_evidence:serde_json::Value,
}
impl EventEmitter<TopologyEvent> for TopologyView {}
impl Focusable for TopologyView { fn focus_handle(&self,_:&gpui::App)->FocusHandle {self.focus.clone()} }
impl TopologyView {
    pub fn new(cx:&mut Context<Self>)->Self { Self{agents:Vec::new(),filter:Filter::default(),graph:Graph::default(),layout:Layout::default(),seats:Seats::new(),slots:BTreeMap::new(),camera:Camera::default(),frame:Frame::default(),bounds:None,dirty:true,scale:1.,canvas:None,error:None,selected:None,floor:None,drag:None,hovered:None,focus:cx.focus_handle(),evidence_current:true,palette:style::Palette::default(),english:false,font_size:14.,font:".AppleSystemUIFont",all_graph:Graph::default(),order:Vec::new(),page:0,boundary:0,locator:0,flat_positions:Vec::new(),flat_seats:BTreeMap::new(),other_camera:None,rejected_input:None,
        #[cfg(feature="acceptance")] mode_bounds:Default::default(),
        #[cfg(feature="acceptance")] pointer_evidence:serde_json::json!({}),
    } }
    pub fn update_agents(&mut self,agents:Vec<AgentInfo>){
        if let Err(error)=graph::check_input_budget(agents.len()) { self.rejected_input=Some(agents.len());self.agents.clear();self.graph=Graph::default();self.all_graph=Graph::default();self.layout=Layout::default();self.order.clear();self.cancel_drag("snapshot-budget-rejected");self.hovered=None;self.error=Some(error);self.dirty=true;return; }
        let was_rejected=self.rejected_input.take().is_some();
        if !was_rejected&&self.agents.len()==agents.len()&&self.agents.iter().zip(&agents).all(|(a,b)|a.as_ref()==b){return;}
        let gesture=self.drag.take();let view=self.frame.view;
        let first=self.agents.is_empty();let live:std::collections::BTreeSet<_>=agents.iter().map(|a|a.id.as_str()).collect();self.seats.retain(|id,_|live.contains(id.as_str()));self.flat_seats.retain(|id,_|live.contains(id.as_str()));self.filter.collapsed.retain(|id|live.contains(id.as_str()));self.agents=agents.into_iter().map(Arc::new).collect();self.rebuild();if first{self.default_view();}
        if let Some(mut drag)=gesture {
            let positions=if self.camera.flat{&self.flat_positions}else{&self.layout.positions};
            if drag.reconcile(&self.graph,&self.layout,positions,&self.frame.camera,view){self.drag=Some(drag);}
            else{self.cancel_drag("snapshot-target-removed");}
        }
    }
    pub fn set_query(&mut self,query:String){if self.filter.query!=query{self.filter.query=query;self.page=0;self.rebuild();if self.camera.flat{if let Some(first)=self.order.iter().position(|i|!self.all_graph.nodes[*i].context){self.change_page(first/200);}}self.default_view();}}
    pub fn set_evidence_current(&mut self,current:bool){self.evidence_current=current;if !current&&self.drag.is_some(){self.cancel_drag("stale-evidence");}}
    fn rebuild(&mut self){
        if self.drag.is_some(){self.cancel_drag("projection-rebuilt");}self.hovered=None;
        if self.rejected_input.is_some(){self.dirty=true;return;}
        match Graph::project_shared(&self.agents,&self.filter,!self.camera.flat){
            Ok(graph)=>{self.error=None;if self.camera.flat{self.all_graph=graph;self.order=self.all_graph.order();self.rebuild_page();}else{self.layout=Layout::build(&graph,&mut self.seats,&mut self.slots);self.graph=graph;self.all_graph=Graph::default();self.order.clear();self.boundary=0;}
                if self.selected.as_ref().is_some_and(|id|!self.agents.iter().any(|a|&a.id==id)){self.selected=None;}
            },
            Err(error)=>{self.error=Some(error);self.graph=Graph::default();self.all_graph=Graph::default();self.layout=Layout::default();self.order.clear();}
        }self.dirty=true;
    }
    fn selected_index(&self)->Option<usize>{self.selected.as_ref().and_then(|id|self.graph.nodes.iter().position(|n|&n.agent.id==id))}
    fn floor_index(&self)->Option<usize>{self.floor.as_ref().and_then(|id|self.layout.floors.iter().position(|f|&f.id==id))}
    fn select(&mut self,hit:Hit,cx:&mut Context<Self>){match hit{Hit::Node(i)=>{if let Some(node)=self.graph.nodes.get(i){self.selected=Some(node.agent.id.clone());cx.emit(TopologyEvent::Select(node.agent.id.clone()));}},Hit::Floor(i)=>{self.floor=Some(self.layout.floors[i].id.clone());},Hit::Building(i)=>{self.floor=None;self.fit(Some(i));}}self.dirty=true;cx.notify();}
    fn tern(&mut self,cx:&mut Context<Self>){if !self.evidence_current{return;}if let Some(i)=self.selected_index(){let a=&self.graph.nodes[i].agent;if a.tern.is_some(){cx.emit(TopologyEvent::FocusTern(a.id.clone()));}}}
    fn cancel_drag(&mut self,reason:&str){
        self.drag=None;
        #[cfg(feature="acceptance")]
        {self.pointer_evidence["cancel"]=serde_json::json!(reason);}
        #[cfg(not(feature="acceptance"))]
        let _=reason;
    }
    fn painted_hit(&mut self,p:[f32;2])->Result<Option<Hit>,&'static str>{
        let result=self.frame.resolve_hit(p,&self.graph,&self.layout,self.camera.flat);
        if let Err(reason)=result{self.cancel_drag(reason);}
        result
    }
    fn pointer_down(&mut self,event:&MouseDownEvent,window:&mut Window,cx:&mut Context<Self>){
        window.focus(&self.focus);let p:[f32;2]=[event.position.x.into(),event.position.y.into()];let Ok(hit)=self.painted_hit(p)else{cx.notify();return;};let pan=event.modifiers.shift||event.button==MouseButton::Middle||self.frame.camera.flat;
        let offset=match hit{Some(Hit::Node(i))if self.evidence_current&&!event.modifiers.shift&&event.button==MouseButton::Left=>{let painted=self.frame.node_ids.iter().position(|id|id==&self.graph.nodes[i].agent.id).expect("resolved painted node identity");let seat=self.frame.positions[painted];self.frame.camera.floor_point(p,seat.y,self.frame.view).map(|q|V3::new(seat.x-q.x,0.,seat.z-q.z))},_=>None};
        let target=match hit{Some(Hit::Node(i))=>Some(self.graph.nodes[i].agent.id.clone()),Some(Hit::Floor(i))=>Some(self.layout.floors[i].id.clone()),Some(Hit::Building(i))=>Some(self.layout.buildings[i].id.clone()),None=>None};
        #[cfg(feature="acceptance")]
        {self.pointer_evidence=serde_json::json!({"down":{"at":p,"hit":format!("{hit:?}"),"target":target,"view":self.frame.view}});}
        self.drag=Some(Drag{start:p,last:p,hit,target,pan,moved:false,offset});cx.notify();
    }
    fn pointer_move(&mut self,event:&MouseMoveEvent,cx:&mut Context<Self>){
        let p:[f32;2]=[event.position.x.into(),event.position.y.into()];
        if let Some(mut drag)=self.drag.take(){
            if event.pressed_button.is_none(){self.cancel_drag("move-without-button");self.dirty=true;cx.notify();return;}let dx=p[0]-drag.last[0];let dy=p[1]-drag.last[1];drag.moved|=(p[0]-drag.start[0]).hypot(p[1]-drag.start[1])>4.;
            if drag.moved{
                if let(Some(Hit::Node(i)),Some(offset))=(drag.hit,drag.offset){
                    if self.camera.flat{
                        let id=&self.graph.nodes[i].agent.id;
                        if !self.flat_seats.contains_key(id)&&self.flat_seats.len()>=4096{self.error=Some(self.t("手动位置缓存已达 4096 上限，请重新布局释放缓存","Manual position cache reached 4096 entries. Reset layout to release the cache.").into());}
                        else if let Some(mut q)=self.frame.camera.floor_point(p,0.,self.frame.view){q.x+=offset.x;q.z+=offset.z;self.flat_positions[i]=q;self.flat_seats.insert(id.clone(),q);}
                    }else{
                        let floor=&self.layout.floors[self.layout.floor_by_node[i]];let building=&self.layout.buildings[floor.building];
                        if let Some(mut q)=self.frame.camera.floor_point(p,self.layout.positions[i].y,self.frame.view){q.x+=offset.x;q.z+=offset.z;
                            let occupied=floor.members.iter().any(|j|*j!=i&&(self.layout.positions[*j].x-q.x).hypot(self.layout.positions[*j].z-q.z)<55.);
                            if !occupied{let id=self.graph.nodes[i].agent.id.clone();let building_index=floor.building;let old_center=building.center;let old_width=self.layout.width;let main=self.graph.nodes[i].agent.kind==oc_core::model::AgentKind::Main&&!floor.unresolved;let mut local=V3::new(q.x-building.center.x+self.layout.width/2.,q.y,q.z-building.center.z);if main{local.x=local.x.clamp(110.,210.);local.z=local.z.clamp(-70.,70.);}else{local.x=local.x.max(390.);}self.seats.insert(id,(floor.id.clone(),local));self.layout=Layout::build(&self.graph,&mut self.seats,&mut self.slots);let new_center=self.layout.buildings[building_index].center;self.camera.target.x+=new_center.x-old_center.x-(self.layout.width-old_width)/2.;self.camera.target.z+=new_center.z-old_center.z;}
                        }
                    }
                }else if drag.pan{self.camera.pan[0]+=dx;self.camera.pan[1]+=dy;}else{self.camera.yaw+=dx*0.008;self.camera.pitch=(self.camera.pitch+dy*0.008).clamp(0.08,1.50);}self.dirty=true;
            }drag.last=p;self.drag=Some(drag);cx.notify();
        }else{let hit=self.painted_hit(p).ok().flatten();if self.hovered!=hit{self.hovered=hit;cx.notify();}}
    }
    fn pointer_up(&mut self,cx:&mut Context<Self>){
        #[cfg(feature="acceptance")]
        {self.pointer_evidence["up"]=serde_json::json!({"hit":self.drag.as_ref().map(|d|format!("{:?}",d.hit)),"moved":self.drag.as_ref().map(|d|d.moved),"view":self.frame.view});}
        if let Some(drag)=self.drag.take(){if !drag.moved{if let Some(hit)=drag.hit{self.select(hit,cx);}}}cx.notify();
    }
    fn fit(&mut self,building:Option<usize>){if self.camera.flat{self.camera.fit_flat(&self.flat_positions,&self.layout,building);}else{self.camera.fit(&self.layout,building);}self.dirty=true;}
    fn paint(&mut self,bounds:Bounds<Pixels>,window:&mut Window,cx:&mut Context<Self>){
        let scale=window.scale_factor();let mut failure=None;
        if self.dirty||self.bounds!=Some(bounds)||self.scale!=scale{
            let rejected=self.frame.geometry_rejected;
            self.frame=Frame::build(&self.graph,&self.layout,&self.camera,self.selected_index(),if self.camera.flat{None}else{self.floor_index()},bounds,scale,self.palette,self.english,if self.camera.flat{&self.flat_positions}else{&self.layout.positions});self.bounds=Some(bounds);self.scale=scale;self.dirty=false;
            if rejected!=self.frame.geometry_rejected{cx.notify();}
        }
        let view=self.frame.view;
        window.with_content_mask(Some(gpui::ContentMask{bounds:Bounds{origin:point(px(view[0]),px(view[1])),size:gpui::size(px(view[2]),px(view[3]))}}),|window|{
            // GPUI takes ownership of Path. Move each freshly tessellated path into
            // the scene; the cached child view reuses the scene on hover-only redraws.
            for polygon in &self.frame.polygons{
                let mut path=if polygon.stroke{PathBuilder::stroke(px(1.))}else{PathBuilder::fill()};
                for (i,p)in polygon.points.iter().enumerate(){if i==0{path.move_to(point(px(p[0]),px(p[1])));}else{path.line_to(point(px(p[0]),px(p[1])));}}
                path.close();match path.build(){Ok(path)=>window.paint_path(path,rgb(polygon.color)),Err(error)=>{failure=Some(format!("{}: {error}",self.t("拓扑 GPU 路径生成失败","Topology GPU path generation failed")));break;}}
            }
            self.frame.label_bounds.clear();
            if failure.is_none(){for index in 0..self.frame.labels.len(){
                let label=&self.frame.labels[index];let hit=label.hit;
                let [mut x,mut y]=label.at;let font_size=scene::label_font_size(self.font_size-1.,label.scale);let height=font_size*(self.font_size+4.)/(self.font_size-1.);
                let text:SharedString=label.text.clone().into();let run=TextRun{len:text.len(),font:window.text_style().font(),color:rgb(self.palette.text).into(),background_color:Some(rgb(self.palette.surface).into()),underline:None,strikethrough:None};
                let line=window.text_system().shape_line(text,px(font_size),&[run],None);let measured_width=f32::from(line.width);let width=label.width.map_or(measured_width,|available|available.min(measured_width));
                if self.camera.flat{
                    if x+width<view[0]||x>view[0]+view[2]||y+height<view[1]||y>view[1]+view[3]{continue;}
                    self.frame.label_bounds.push(([x,y,width,height],hit));
                }else{let Some(rect)=self.frame.place_label([x,y],width,height,hit)else{continue;};x=rect[0];y=rect[1];}
                let result=window.with_content_mask(Some(gpui::ContentMask{bounds:Bounds{origin:point(px(x),px(y)),size:gpui::size(px(width),px(height))}}),|window|line.paint(point(px(x),px(y)),px(height),window,cx));
                if let Err(error)=result{failure=Some(format!("{}: {error}",self.t("拓扑标签绘制失败","Topology label painting failed")));break;}
            }}
        });
        if let Some(error)=failure{if self.error.as_ref()!=Some(&error){self.error=Some(error);cx.notify();}}
    }
}

#[cfg(feature="acceptance")]
impl TopologyView {
    pub fn inspect(&self)->serde_json::Value {
        use serde_json::json;
        let mut nodes=BTreeMap::new();
        let mut attempts=vec![0u8;self.frame.node_ids.len()];
        // Use painted polygons rather than world-space seat projections. A
        // candidate is exposed only if the real pointer hit-test selects it.
        for polygon in self.frame.polygons.iter().rev(){
            let Some(Hit::Node(i))=polygon.hit else{continue;};
            if nodes.contains_key(&i)||attempts[i]>=8||polygon.points.is_empty(){continue;}
            let count=polygon.points.len() as f32;
            let at=polygon.points.iter().fold([0.,0.],|a,p|[a[0]+p[0]/count,a[1]+p[1]/count]);
            let [x,y,w,h]=self.frame.view;
            if at[0]<x||at[0]>x+w||at[1]<y||at[1]>y+h{continue;}
            attempts[i]+=1;
            if matches!(self.frame.resolve_hit(at,&self.graph,&self.layout,self.camera.flat),Ok(Some(Hit::Node(_))))&&self.frame.hit(at)==Some(Hit::Node(i)){nodes.insert(i,json!({"id":self.frame.node_ids[i],"x":at[0],"y":at[1]}));}
        }
        let positions=if self.camera.flat{&self.flat_positions}else{&self.layout.positions};
        let seats:serde_json::Map<String,serde_json::Value>=self.graph.nodes.iter().zip(positions).map(|(node,p)|(node.agent.id.clone(),json!({"x":p.x,"y":p.y,"z":p.z}))).collect();
        let mode=self.mode_bounds.borrow().map(|b|json!({"x":f32::from(b.origin.x),"y":f32::from(b.origin.y),"width":f32::from(b.size.width),"height":f32::from(b.size.height)}));
        json!({"flat":self.camera.flat,"selected":self.selected,"floor":self.floor,"view":self.frame.view,"dirty":self.dirty,"pointer":self.pointer_evidence,"nodes":nodes.into_values().collect::<Vec<_>>(),"buttons":{"mode":mode},"seats":seats})
    }
}

/// Separate paint invalidation from toolbar/hover updates on the parent view.
struct TopologyCanvas { owner:gpui::WeakEntity<TopologyView> }
impl Render for TopologyCanvas {
    fn render(&mut self,_:&mut Window,_:&mut Context<Self>)->impl IntoElement {
        let owner=self.owner.clone();
        canvas(move|_,_,_|(),move|bounds,_,window,cx|{
            if let Some(owner)=owner.upgrade(){owner.update(cx,|s,cx|s.paint(bounds,window,cx));}
        }).size_full()
    }
}

#[cfg(test)]
mod tests;
