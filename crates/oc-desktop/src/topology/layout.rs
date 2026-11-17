use super::graph::Graph;
use oc_core::model::AgentKind;
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Copy, Debug, Default)]
pub struct V3 { pub x: f32, pub y: f32, pub z: f32 }
impl V3 { pub fn new(x:f32,y:f32,z:f32)->Self { Self{x,y,z} } }
pub struct Floor { pub id: String, pub name: String, pub building: usize, pub level: usize, pub y:f32, pub members: Vec<usize>, pub unresolved:bool }
pub struct Building { pub id:String, pub name:String, pub center:V3, pub floors:Vec<usize> }
#[derive(Default)]
pub struct Layout { pub floors:Vec<Floor>, pub buildings:Vec<Building>, pub positions:Vec<V3>, pub floor_by_node:Vec<usize>, pub width:f32, pub depth:f32 }
pub type Seats = BTreeMap<String,(String,V3)>;
impl Layout {
    pub fn build(graph:&Graph, seats:&mut Seats, slots:&mut BTreeMap<String,usize>) -> Self {
        let n=graph.nodes.len(); let mut neighbors=vec![Vec::new();n]; let mut parented=BTreeSet::new();
        for &(a,b) in &graph.edges { neighbors[a].push(b); neighbors[b].push(a); parented.insert(b); }
        let mut seen=BTreeSet::new(); let mut branches=Vec::new();
        for i in 0..n { if !seen.insert(i) { continue; } let mut members=vec![i]; let mut cursor=0; while cursor<members.len() { for &j in &neighbors[members[cursor]] { if seen.insert(j) { members.push(j); } } cursor+=1; } members.sort_unstable(); let root=*members.iter().find(|i| !parented.contains(i)).unwrap_or(&members[0]); let cwd=graph.nodes[root].agent.cwd.as_deref().unwrap_or("").trim_end_matches('/').to_string(); branches.push((cwd,root,members)); }
        branches.sort_by(|a,b| (a.0.is_empty(),&a.0,&graph.nodes[a.1].agent.id).cmp(&(b.0.is_empty(),&b.0,&graph.nodes[b.1].agent.id)));
        let occupancy=branches.iter().map(|b| b.2.len()).max().unwrap_or(0);
        let columns=(occupancy as f32).sqrt().ceil().max(1.); let rows=(occupancy as f32/columns).ceil();
        let mut result=Self{width:760f32.max(530.+(columns-1.)*140.),depth:420f32.max(280.+(rows-1.)*140.),positions:vec![V3::default();n],floor_by_node:vec![0;n],..Self::default()};
        let ids:BTreeSet<_>=graph.nodes.iter().map(|n| n.agent.id.as_str()).collect();
        let additions=ids.iter().filter(|id|!seats.contains_key(**id)).count();
        let evict:Vec<_>=seats.keys().filter(|id|!ids.contains(id.as_str())).take((seats.len()+additions).saturating_sub(super::graph::MAX_NODES)).cloned().collect();for id in evict{seats.remove(&id);}
        let projects:BTreeSet<_>=branches.iter().map(|b| b.0.clone()).collect();
        let additions=projects.iter().filter(|id|!slots.contains_key(*id)).count();let evict:Vec<_>=slots.keys().filter(|id|!projects.contains(*id)).take((slots.len()+additions).saturating_sub(super::graph::MAX_NODES)).cloned().collect();for id in evict{slots.remove(&id);}
        for (cwd,root,members) in branches {
            let building=if let Some(i)=result.buildings.iter().position(|b|b.id==cwd) {i} else { let used:BTreeSet<_>=slots.values().copied().collect(); let slot=*slots.entry(cwd.clone()).or_insert_with(||(0..super::graph::MAX_NODES).find(|i|!used.contains(i)).expect("bounded building slots")); let (x,z)=street_cell(slot); let name=if cwd.is_empty(){"工程未识别".into()}else{cwd.rsplit('/').next().unwrap_or(&cwd).to_string()}; result.buildings.push(Building{id:cwd.clone(),name,center:V3::new(x as f32,0.,z as f32),floors:Vec::new()}); result.buildings.len()-1 };
            let level=result.buildings[building].floors.len(); let y=level as f32*240.; let floor_id=format!("task:{}",graph.nodes[root].agent.id);
            let unresolved=graph.nodes[root].agent.kind!=AgentKind::Main || members.iter().any(|i|graph.nodes[*i].issue.is_some());
            let shared=members.len()-usize::from(!unresolved); let cols=(shared as f32).sqrt().ceil().max(1.) as usize; let rows=(shared as f32/cols as f32).ceil(); let mut seat=0;
            let mut occupied=BTreeSet::new();
            for &i in &members { let id=&graph.nodes[i].agent.id; let main=i==root && !unresolved; let default=if main{V3::new(160.,y+40.,0.)}else{let p=V3::new(390.+(seat%cols)as f32*140.,y+40.,(seat/cols)as f32*140.-(rows-1.)*70.);seat+=1;p}; let mut p=seats.get(id).filter(|(f,_)|f==&floor_id).map(|(_,p)|*p).unwrap_or(default); p.y=y+40.; while !occupied.insert(((p.x/70.).round()as i32,(p.z/70.).round()as i32)) {p.x+=70.;} result.width=result.width.max(p.x+110.);result.depth=result.depth.max((p.z.abs()+90.)*2.);seats.insert(id.clone(),(floor_id.clone(),p));result.positions[i]=p;result.floor_by_node[i]=result.floors.len(); }
            result.buildings[building].floors.push(result.floors.len());result.floors.push(Floor{id:floor_id,name:graph.nodes[root].agent.summary.clone().unwrap_or_else(||graph.nodes[root].agent.name.clone()),building,level:level+1,y,members,unresolved});
        }
        for b in &mut result.buildings {b.center.x*=result.width+400.;b.center.z*=result.depth+400.;}
        for i in 0..n {let b=&result.buildings[result.floors[result.floor_by_node[i]].building];result.positions[i].x+=b.center.x-result.width/2.;result.positions[i].z+=b.center.z;}
        result
    }
}
fn street_cell(index:usize)->(i32,i32){if index==0{return(0,0)}let ring=((((index+1)as f32).sqrt()-1.)/2.).ceil()as i32;let side=ring*2;let offset=(side+1).pow(2)-1-index as i32;if offset<side{(ring-offset,-ring)}else if offset<side*2{(-ring,-ring+offset-side)}else if offset<side*3{(-ring+offset-side*2,ring)}else{(ring,ring-(offset-side*3))}}
