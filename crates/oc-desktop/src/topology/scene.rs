use super::{graph::Graph,layout::{Layout,V3}};
use gpui::{Bounds,Pixels};
// On 64-bit targets: Polygon is ~56 bytes plus 32 bytes for four points.
// 600k quads cost ~50 MiB; six 32-byte GPUI PathVertex values per quad
// add ~110 MiB per path copy, excluding path headers and double-buffered scenes.
// Cap at 30k faces (~2.5 MiB of polygons); select LOD BEFORE generating geometry.
pub const MAX_SCENE_POLYGONS:usize=30_000;
pub(super) fn compact_scene(nodes:usize,edges:usize,buildings:usize,floors:usize)->bool {
    // Compact upper bound: 10*N + 5*B + 5*F + 2*E + 80 selected detail.
    // N,B,F <= 1200 and E <= 2400 => 28,880 faces, below the cap.
    nodes*90+edges*2+buildings*140+floors*130>MAX_SCENE_POLYGONS
}
pub const LABEL_LIMIT:usize=32;
pub const BUILDING_LABEL_LIMIT:usize=16;
// Bound glyph raster sizes during continuous zoom: 93 half-pixel sizes.
pub(super) fn label_font_size(base:f32,scale:f32)->f32{((base*scale).clamp(2.,48.)*2.).round()/2.}
#[derive(Clone,Copy)]
pub struct Camera {pub yaw:f32,pub pitch:f32,pub distance:f32,pub target:V3,pub pan:[f32;2],pub flat:bool}
impl Default for Camera {fn default()->Self{Self{yaw:-0.55,pitch:0.75,distance:2200.,target:V3::default(),pan:[0.,0.],flat:false}}}
impl Camera {
    fn basis(&self,p:V3)->V3 {let x=p.x-self.target.x;let y=p.y-self.target.y;let z=p.z-self.target.z;let h=x*self.yaw.sin()+z*self.yaw.cos();V3::new(x*self.yaw.cos()-z*self.yaw.sin(),y*self.pitch.cos()-h*self.pitch.sin(),y*self.pitch.sin()+h*self.pitch.cos())}
    pub fn project(&self,p:V3,view:[f32;4])->Option<([f32;2],f32)> {let p=if self.flat {V3::new(p.x-self.target.x,-p.z+self.target.z,0.)}else{self.basis(p)};let depth=self.distance-p.z;if depth<5.{return None;}let focal=view[3]*1.207;let scale=focal/depth;Some(([view[0]+view[2]/2.+self.pan[0]+p.x*scale,view[1]+view[3]/2.+self.pan[1]-p.y*scale],depth))}
    pub fn floor_point(&self,p:[f32;2],y:f32,view:[f32;4])->Option<V3>{let focal=view[3]*1.207;let sx=(p[0]-view[0]-view[2]/2.-self.pan[0])/focal;let sy=-(p[1]-view[1]-view[3]/2.-self.pan[1])/focal;if self.flat{return Some(V3::new(self.target.x+sx*self.distance,y,self.target.z-sy*self.distance));}let (s,c)=self.pitch.sin_cos();let denominator=sy*c-s;if denominator.abs()<0.0001{return None;}let depth=(y-self.target.y-self.distance*s)/denominator;if depth<=5.{return None;}let ry=sy*depth;let rz=self.distance-depth;let h=-ry*s+rz*c;let rx=sx*depth;Some(V3::new(self.target.x+rx*self.yaw.cos()+h*self.yaw.sin(),y,self.target.z-rx*self.yaw.sin()+h*self.yaw.cos()))}
    pub fn fit(&mut self,layout:&Layout,building:Option<usize>){let points:Vec<_>=layout.positions.iter().enumerate().filter(|(i,_)|building.is_none_or(|b|layout.floors[layout.floor_by_node[*i]].building==b)).map(|(_,p)|*p).collect();if points.is_empty(){return;}let mut lo=points[0];let mut hi=lo;for p in points {lo.x=lo.x.min(p.x);lo.y=lo.y.min(p.y);lo.z=lo.z.min(p.z);hi.x=hi.x.max(p.x);hi.y=hi.y.max(p.y);hi.z=hi.z.max(p.z);}self.target=V3::new((lo.x+hi.x)/2.,(lo.y+hi.y)/2.,(lo.z+hi.z)/2.);self.distance=((hi.x-lo.x+layout.width).max(hi.z-lo.z+layout.depth).max(hi.y-lo.y+240.)*1.6).clamp(60.,600_000.);self.pan=[0.,0.];}
    pub fn fit_flat(&mut self,positions:&[V3],layout:&Layout,building:Option<usize>){let mut points=positions.iter().enumerate().filter(|(i,_)|building.is_none_or(|b|layout.floors[layout.floor_by_node[*i]].building==b)).map(|(_,p)|p);let Some(first)=points.next()else{return;};let(mut lo,mut hi)=(*first,*first);for p in points{lo.x=lo.x.min(p.x);lo.z=lo.z.min(p.z);hi.x=hi.x.max(p.x);hi.z=hi.z.max(p.z);}self.target=V3::new((lo.x+hi.x)/2.,0.,(lo.z+hi.z)/2.);self.distance=((hi.x-lo.x+200.).max(hi.z-lo.z+160.)*1.7).clamp(300.,600_000.);self.pan=[0.,0.];}
    pub fn fit_first_project(&mut self,positions:&[V3],layout:&Layout){
        let Some(floor)=layout.floor_by_node.first()else{return;};
        self.fit_flat(positions,layout,Some(layout.floors[*floor].building));
    }
    pub fn focus_node(&mut self,position:V3){self.target=position;self.pan=[0.,0.];self.distance=if self.flat{600.}else{850.};}
}
#[derive(Clone,Copy,PartialEq,Debug)]
pub enum Hit {Node(usize),Floor(usize),Building(usize)}
pub struct Polygon {pub points:Vec<[f32;2]>,pub depth:f32,pub color:u32,pub hit:Option<Hit>,pub stroke:bool}
pub struct Label {pub at:[f32;2],pub text:String,pub hit:Hit,pub scale:f32,pub width:Option<f32>}
#[derive(Default)]
pub struct Frame {pub polygons:Vec<Polygon>,pub labels:Vec<Label>,pub label_bounds:Vec<([f32;4],Hit)>,pub view:[f32;4],pub geometry_rejected:bool,pub camera:Camera,pub node_ids:Vec<String>,pub positions:Vec<V3>,floor_ids:Vec<String>,building_ids:Vec<String>}
impl Frame {
    /// Indices belong to this painted frame, never to a refreshed graph. Only
    /// bounded projection identities are retained, not agent payloads or geometry copies.
    pub fn resolve_hit(&self,p:[f32;2],graph:&Graph,layout:&Layout,flat:bool)->Result<Option<Hit>,&'static str>{
        let Some(hit)=self.hit(p)else{return Ok(None);};
        if self.camera.flat!=flat{return Err("painted-mode-changed");}
        let resolved=match hit{
            Hit::Node(i)=>self.node_ids.get(i).and_then(|id|graph.nodes.iter().position(|n|&n.agent.id==id)).map(Hit::Node),
            Hit::Floor(i)=>self.floor_ids.get(i).and_then(|id|layout.floors.iter().position(|f|&f.id==id)).map(Hit::Floor),
            Hit::Building(i)=>self.building_ids.get(i).and_then(|id|layout.buildings.iter().position(|b|&b.id==id)).map(Hit::Building),
        };
        resolved.map(Some).ok_or("painted-target-removed")
    }
    pub fn hit(&self,p:[f32;2])->Option<Hit>{if p[0]<self.view[0]||p[1]<self.view[1]||p[0]>self.view[0]+self.view[2]||p[1]>self.view[1]+self.view[3]{return None;}self.label_bounds.iter().rev().find(|(r,_)|p[0]>=r[0]&&p[0]<=r[0]+r[2]&&p[1]>=r[1]&&p[1]<=r[1]+r[3]).map(|(_,hit)|*hit).or_else(||self.polygons.iter().rev().find(|f|f.hit.is_some()&&inside(p,&f.points)).and_then(|f|f.hit))}
    /// Place measured text in priority order, with bounded probes and a fixed
    /// visible budget. The returned rectangle is also the pointer hit target.
    pub(super) fn place_label(&mut self,at:[f32;2],width:f32,height:f32,hit:Hit)->Option<[f32;4]>{
        let [vx,vy,vw,vh]=self.view;
        if width<=0.||height<=0.||width>vw||height>vh||at[0]<vx||at[0]>vx+vw||at[1]<vy||at[1]>vy+vh{return None;}
        let limit=if matches!(hit,Hit::Building(_)){BUILDING_LABEL_LIMIT}else{LABEL_LIMIT};
        if self.label_bounds.iter().filter(|(_,h)|matches!(h,Hit::Building(_))==matches!(hit,Hit::Building(_))).count()>=limit{return None;}
        let x=at[0].clamp(vx,vx+vw-width);
        for step in [0.,-1.,1.,-2.,2.,-3.,3.]{
            let y=(at[1]+step*(height+4.)).clamp(vy,vy+vh-height);
            let rect=[x,y,width,height];
            if self.label_bounds.iter().all(|(r,_)|x+width+4.<=r[0]||r[0]+r[2]+4.<=x||y+height+4.<=r[1]||r[1]+r[3]+4.<=y){self.label_bounds.push((rect,hit));return Some(rect);}
        }
        None
    }
    fn polygon(&mut self,camera:&Camera,vertices:&[V3],color:u32,hit:Option<Hit>,stroke:bool){if self.polygons.len()>=MAX_SCENE_POLYGONS{self.geometry_rejected=true;return;}let mut points=Vec::with_capacity(vertices.len());let mut depth=0.;for v in vertices{let Some((p,d))=camera.project(*v,self.view)else{return;};if !p[0].is_finite()||!p[1].is_finite(){return;}points.push(p);depth+=d;}depth/=vertices.len()as f32;self.polygons.push(Polygon{points,depth,color,hit,stroke});}
    pub(super) fn cuboid(&mut self,c:&Camera,p:V3,w:f32,h:f32,d:f32,color:u32,hit:Option<Hit>){let a=V3::new(p.x-w/2.,p.y,p.z-d/2.);let b=V3::new(p.x+w/2.,p.y,p.z-d/2.);let e=V3::new(p.x-w/2.,p.y,p.z+d/2.);let f=V3::new(p.x+w/2.,p.y,p.z+d/2.);let up=|p:V3|V3::new(p.x,p.y+h,p.z);for (vertices,tint) in [([a,b,up(b),up(a)],shade(color,0.75)),([b,f,up(f),up(b)],shade(color,0.85)),([f,e,up(e),up(f)],shade(color,0.8)),([e,a,up(a),up(e)],shade(color,0.9)),([up(a),up(b),up(f),up(e)],color)] {self.polygon(c,&vertices,tint,hit,false);}}
    pub fn build(graph:&Graph,layout:&Layout,c:&Camera,selected:Option<usize>,floor:Option<usize>,bounds:Bounds<Pixels>,_scale:f32,palette:super::style::Palette,english:bool,positions:&[V3])->Self{
        let width=f32::from(bounds.size.width);let height=f32::from(bounds.size.height);let mut frame=Self{view:[f32::from(bounds.origin.x),f32::from(bounds.origin.y),width,height],..Self::default()};
        if width<=0.||height<=0.{return frame;}
        frame.camera=*c;
        frame.node_ids=graph.nodes.iter().map(|n|n.agent.id.clone()).collect();
        frame.positions=positions.to_vec();
        if !c.flat{frame.floor_ids=layout.floors.iter().map(|f|f.id.clone()).collect();frame.building_ids=layout.buildings.iter().map(|b|b.id.clone()).collect();}
        let compact=compact_scene(graph.nodes.len(),graph.edges.len(),layout.buildings.len(),layout.floors.len());
        if !c.flat{frame.district(c,layout,palette,floor,compact);}
        for &(a,b) in &graph.edges {if floor.is_some_and(|f|layout.floor_by_node[a]!=f||layout.floor_by_node[b]!=f){continue;}let mut p=positions[a];let mut q=positions[b];p.y+=30.;q.y+=30.;let dx=q.x-p.x;let dz=q.z-p.z;let len=dx.hypot(dz).max(1.);let ox=-dz/len*1.7;let oz=dx/len*1.7;frame.polygon(c,&[V3::new(p.x+ox,p.y,p.z+oz),V3::new(q.x+ox,q.y,q.z+oz),V3::new(q.x-ox,q.y,q.z-oz),V3::new(p.x-ox,p.y,p.z-oz)],palette.edge,None,false);let tip=V3::new(q.x-dx/len*30.,q.y,q.z-dz/len*30.);frame.polygon(c,&[tip,V3::new(tip.x-dx/len*16.+ox*4.,tip.y,tip.z-dz/len*16.+oz*4.),V3::new(tip.x-dx/len*16.-ox*4.,tip.y,tip.z-dz/len*16.-oz*4.)],palette.edge,None,false);}
        let mut labels=Vec::new();
        for (i,node) in graph.nodes.iter().enumerate(){if floor.is_some_and(|f|layout.floor_by_node[i]!=f){continue;}let p=positions[i];let color=if selected==Some(i){palette.accent}else if node.issue.is_some(){palette.warning}else if node.context{palette.muted}else if node.agent.activity.is_some()||node.agent.state==oc_core::model::AgentState::Working{palette.active}else{palette.edge};
            if c.flat{
                if let Some((at,depth))=c.project(p,frame.view){
                    let scale=frame.view[3]*1.207/c.distance;
                    let left=at[0]-150.*scale;let top=at[1]-42.*scale;
                    frame.polygons.push(Polygon{points:vec![[left,top],[left+300.*scale,top],[left+300.*scale,top+84.*scale],[left,top+84.*scale]],depth,color:palette.surface,hit:Some(Hit::Node(i)),stroke:false});
                    frame.polygons.push(Polygon{points:vec![[left,top],[left+300.*scale,top],[left+300.*scale,top+84.*scale],[left,top+84.*scale]],depth,color,hit:Some(Hit::Node(i)),stroke:true});
                    let state=match node.agent.state{oc_core::model::AgentState::Working=>if english{"Working"}else{"工作中"},oc_core::model::AgentState::Idle=>if english{"Idle"}else{"空闲"},oc_core::model::AgentState::Running=>if english{"Running"}else{"运行中"},oc_core::model::AgentState::Unknown=>if english{"Unknown"}else{"未知"}};
                    let issue=if node.issue.is_some(){if english{" · relationship issue"}else{" · 关系异常"}}else if node.context{if english{" · context"}else{" · 上下文"}}else{""};
                    for(row,text)in [node.agent.name.clone(),format!("{} · {state}{issue}",node.agent.runtime),node.agent.cwd.clone().unwrap_or_else(||if english{"Unknown project".into()}else{"工程未识别".into()})].into_iter().enumerate(){labels.push((false,false,depth,Label{at:[left+8.*scale,top+(5.+row as f32*24.)*scale],text,hit:Hit::Node(i),scale,width:Some(284.*scale)}));}
                }
            }else{
                if compact&&selected!=Some(i){
                    // Keep every employee's body and desk, with independent hit targets.
                    frame.cuboid(c,V3::new(p.x,p.y-13.,p.z+35.),78.,6.,44.,palette.line,Some(Hit::Node(i)));
                    frame.cuboid(c,V3::new(p.x,p.y-17.,p.z),23.,50.,18.,color,Some(Hit::Node(i)));
                }else{frame.employee(c,p,color,palette,i);}
                if floor.is_some()||selected==Some(i){if let Some((at,depth))=c.project(V3::new(p.x,p.y+65.,p.z),frame.view){labels.push((selected!=Some(i),node.context,depth,Label{at,text:format!("{}{}",node.agent.name,if node.issue.is_some(){if english{" [relationship issue]"}else{" [关系异常]"}}else if node.context{if english{" [context]"}else{" [上下文]"}}else{""}),hit:Hit::Node(i),scale:1.,width:None}));}}
            }
        }
        // Only bounded graph members are sorted (<=1200 in 3D). Keep candidates
        // until measured placement so an occluded label does not consume a slot.
        labels.sort_by(|a,b|a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.total_cmp(&b.2)));frame.labels=labels.into_iter().map(|(_,_,_,l)|l).collect();
        if !c.flat{
            if let Some(i)=floor{let f=&layout.floors[i];let b=&layout.buildings[f.building];if let Some((at,_))=c.project(V3::new(b.center.x-layout.width/2.,f.y,b.center.z-layout.depth/2.),frame.view){let label=Label{at,text:format!("{} · {}F · {}",if b.id.is_empty()&&english{"Unknown project"}else{&b.name},f.level,f.name),hit:Hit::Floor(i),scale:1.,width:None};let index=usize::from(frame.labels.first().is_some_and(|l|matches!(l.hit,Hit::Node(j) if selected==Some(j))));frame.labels.insert(index,label);}}
            else{let selected_building=selected.map(|i|layout.floors[layout.floor_by_node[i]].building);let mut buildings:Vec<_>=layout.buildings.iter().enumerate().filter_map(|(i,b)|{let top=b.floors.last().map_or(0.,|f|layout.floors[*f].y+230.);c.project(V3::new(b.center.x,top,b.center.z),frame.view).map(|(at,depth)|(selected_building!=Some(i),depth,Label{at,text:if b.id.is_empty()&&english{"Unknown project".into()}else{b.name.clone()},hit:Hit::Building(i),scale:1.,width:None}))}).collect();buildings.sort_by(|a,b|a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));frame.labels.extend(buildings.into_iter().map(|(_,_,l)|l));}
        }
        if frame.geometry_rejected{frame.polygons.clear();frame.labels.clear();}else{frame.polygons.sort_by(|a,b|b.depth.total_cmp(&a.depth));}frame
    }
}
fn shade(color:u32,f:f32)->u32{let r=((color>>16)&255)as f32*f;let g=((color>>8)&255)as f32*f;let b=(color&255)as f32*f;((r as u32)<<16)|((g as u32)<<8)|(b as u32)}
fn inside(p:[f32;2],v:&[[f32;2]])->bool{if v.len()<3{return false;}let mut hit=false;let mut j=v.len()-1;for i in 0..v.len(){if (v[i][1]>p[1])!=(v[j][1]>p[1])&&p[0]<(v[j][0]-v[i][0])*(p[1]-v[i][1])/(v[j][1]-v[i][1])+v[i][0]{hit=!hit;}j=i;}hit}
pub(super) fn flat_positions(graph:&Graph,layout:&Layout)->Vec<V3>{
    let mut depths=vec![0;graph.nodes.len()];let mut children=vec![Vec::new();depths.len()];let mut incoming=vec![0;depths.len()];
    for &(a,b)in &graph.edges{children[a].push(b);incoming[b]+=1;}
    let mut queue:std::collections::VecDeque<_>=(0..incoming.len()).filter(|i|incoming[*i]==0).collect();
    while let Some(i)=queue.pop_front(){for &j in &children[i]{depths[j]=depths[j].max(depths[i]+1);incoming[j]-=1;if incoming[j]==0{queue.push_back(j);}}}
    let mut rows=BTreeRows::new();let mut widths=vec![360f32;layout.floors.len()];
    let mut positions:Vec<_>=(0..graph.nodes.len()).map(|i|{let floor=layout.floor_by_node[i];let rank=depths[i];let seat=rows.entry((floor,rank)).or_insert(0usize);let p=V3::new(*seat as f32*360.,0.,rank as f32*160.);*seat+=1;widths[floor]=widths[floor].max(*seat as f32*360.);p}).collect();
    let mut offset=0.;for width in &mut widths{let w=*width;*width=offset;offset+=w+240.;}
    for (i,p)in positions.iter_mut().enumerate(){p.x+=widths[layout.floor_by_node[i]];}positions
}
type BTreeRows=std::collections::BTreeMap<(usize,usize),usize>;

/// Restore only user-authored seats. Automatic cards avoid every manual card
/// and earlier automatic card. At most 200 cards, with <=201 probes each.
pub(super) fn restore_manual_positions(graph:&Graph,positions:&mut [V3],manual:&std::collections::BTreeMap<String,V3>){
    let mut occupied:Vec<V3>=graph.nodes.iter().filter_map(|n|manual.get(&n.agent.id).copied()).collect();
    for (i,node) in graph.nodes.iter().enumerate(){
        if let Some(p)=manual.get(&node.agent.id){positions[i]=*p;continue;}
        let mut p=positions[i];
        for _ in 0..=graph.nodes.len(){
            if !occupied.iter().any(|q|(q.x-p.x).abs()<320.&&(q.z-p.z).abs()<104.){break;}
            p.x+=640.;
        }
        positions[i]=p;occupied.push(p);
    }
}
