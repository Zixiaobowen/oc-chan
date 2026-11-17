use super::*;
use core::prelude::v1::test;
use oc_core::model::{AgentKind,AgentState};
fn agent(id:&str,parent:Option<&str>)->AgentInfo{AgentInfo{id:id.into(),name:id.into(),summary:None,runtime:"OMP".into(),kind:if parent.is_some(){AgentKind::Subagent}else{AgentKind::Main},state:AgentState::Idle,activity:None,pid:1,parent_id:parent.map(str::to_owned),model:None,cwd:Some("/project".into()),session_id:None,tern:None,cpu_percent:None,memory_bytes:None,started_at:None,source:"test".into()}}
#[test]
fn search_retains_ancestors_and_descendants_but_not_siblings(){let agents=vec![agent("root",None),agent("match",Some("root")),agent("sibling",Some("root")),agent("leaf",Some("match"))];let graph=Graph::project(&agents,&Filter{query:"match".into(),..Filter::default()}).unwrap();assert_eq!(graph.matches,1);assert_eq!(graph.nodes.iter().map(|n|n.agent.id.as_str()).collect::<Vec<_>>(),vec!["leaf","match","root"]);assert_eq!(graph.edges.len(),2);assert_eq!(graph.nodes.iter().filter(|n|n.context).count(),2);}
#[test]
fn cycles_and_missing_parent_are_evidence_not_invented_edges(){let graph=Graph::project(&[agent("a",Some("b")),agent("b",Some("a")),agent("c",Some("gone"))],&Filter::default()).unwrap();assert_eq!(graph.edges.len(),2);assert!(graph.nodes.iter().all(|n|n.issue.is_some()));assert_eq!(graph.nodes[0].descendants,1);let layout=Layout::build(&graph,&mut Seats::new(),&mut BTreeMap::new());assert_eq!(layout.floors.len(),2);assert!(layout.floors.iter().all(|f|f.unresolved));}
#[test]
fn collapse_is_disabled_during_search(){let agents=vec![agent("root",None),agent("child",Some("root"))];let mut filter=Filter::default();filter.collapsed.insert("root".into());let graph=Graph::project(&agents,&filter).unwrap();assert_eq!(graph.nodes.len(),1);assert_eq!(graph.hidden,1);filter.query="child".into();assert_eq!(Graph::project(&agents,&filter).unwrap().nodes.len(),2);}
#[test]
fn graph_budget_rejects_without_truncation(){let agents:Vec<_>=(0..1201).map(|i|agent(&i.to_string(),None)).collect();assert!(Graph::project(&agents,&Filter::default()).is_err());let filter=Filter{query:"1200".into(),..Filter::default()};assert_eq!(Graph::project(&agents,&filter).unwrap().nodes.len(),1);}
#[test]
fn perspective_inverse_keeps_drag_on_same_floor(){let camera=Camera::default();let view=[50.,60.,900.,600.];for p in [V3::new(140.,40.,-90.),V3::new(-200.,280.,80.)]{let(screen,_)=camera.project(p,view).unwrap();let q=camera.floor_point(screen,p.y,view).unwrap();assert!((p.x-q.x).abs()<0.01);assert!((p.z-q.z).abs()<0.01);assert_eq!(p.y,q.y);}}
#[test]
fn caches_keep_hidden_seats_and_vector_canvas_preserves_full_viewport(){let agents=vec![agent("a",None),agent("b",None)];let graph=Graph::project(&agents,&Filter::default()).unwrap();let(mut seats,mut slots)=(Seats::new(),BTreeMap::new());let layout=Layout::build(&graph,&mut seats,&mut slots);let old=seats["b"].1;let filtered=Graph::project(&agents,&Filter{query:"a".into(),..Filter::default()}).unwrap();Layout::build(&filtered,&mut seats,&mut slots);assert_eq!(seats.len(),2);assert_eq!(seats["b"].1.x,old.x);let bounds=Bounds{origin:point(px(0.),px(0.)),size:gpui::size(px(4000.),px(3000.))};let frame=Frame::build(&graph,&layout,&Camera::default(),None,None,bounds,2.,style::Palette::default(),false,&layout.positions);assert!(!frame.geometry_rejected);assert!(!frame.polygons.is_empty());assert_eq!(frame.view,[0.,0.,4000.,3000.]);assert!(frame.polygons.windows(2).all(|w|w[0].depth>=w[1].depth));}

#[test]
fn flat_pages_preserve_every_node_and_boundary_relationship(){let mut agents=vec![agent("root",None)];agents.extend((0..1300).map(|i|agent(&format!("child-{i:04}"),Some("root"))));let graph=Graph::project_with_budget(&agents,&Filter::default(),false).unwrap();let order=graph.order();assert_eq!(graph.nodes[order[0]].agent.id,"root");let mut seen=std::collections::BTreeSet::new();for page in 0..order.len().div_ceil(200){let(g,boundary)=graph.page(&order,page);assert!(g.nodes.len()<=200);assert!(boundary>0);for n in g.nodes{assert!(seen.insert(n.agent.id.clone()));}}assert_eq!(seen.len(),1301);}

#[test]
fn expanded_seats_enlarge_shared_envelope_and_preserve_parcel_slot(){let graph=Graph::project(&[agent("root",None),agent("child",Some("root")),agent("other",None)],&Filter::default()).unwrap();let(mut seats,mut slots)=(Seats::new(),BTreeMap::new());let before=Layout::build(&graph,&mut seats,&mut slots);let slot=slots["/project"];let floor=seats["child"].0.clone();seats.insert("child".into(),(floor,V3::new(2200.,40.,900.)));let after=Layout::build(&graph,&mut seats,&mut slots);assert!(after.width>before.width);assert!(after.depth>before.depth);assert_eq!(slots["/project"],slot);assert_eq!(seats["child"].1.x,2200.);assert_eq!(seats["child"].1.z,900.);}

#[test]
fn flat_page_labels_include_every_title_status_and_project(){let agents:Vec<_>=(0..200).map(|i|agent(&format!("agent-{i:03}"),None)).collect();let graph=Graph::project(&agents,&Filter::default()).unwrap();let layout=Layout::build(&graph,&mut Seats::new(),&mut BTreeMap::new());let positions=scene::flat_positions(&graph,&layout);let c=Camera{flat:true,..Camera::default()};let bounds=Bounds{origin:point(px(0.),px(0.)),size:gpui::size(px(1200.),px(800.))};let frame=Frame::build(&graph,&layout,&c,None,None,bounds,2.,style::Palette::default(),true,&positions);assert_eq!(frame.labels.len(),600);assert_eq!(frame.labels.iter().filter(|l|l.text=="/project").count(),200);assert_eq!(frame.labels.iter().filter(|l|l.text.contains("Idle")).count(),200);}

#[test]
fn inserting_before_existing_cards_does_not_overlap_manual_seats(){
    let graph=Graph::project(&[agent("0",None),agent("a",None),agent("b",None)],&Filter::default()).unwrap();
    let layout=Layout::build(&graph,&mut Seats::new(),&mut BTreeMap::new());
    let mut positions=scene::flat_positions(&graph,&layout);
    let manual=BTreeMap::from([("a".into(),V3::new(0.,0.,0.))]);
    scene::restore_manual_positions(&graph,&mut positions,&manual);
    assert_eq!(positions[1].x,0.);
    assert_eq!(manual.len(),1);
    for i in 0..positions.len(){for j in i+1..positions.len(){assert!((positions[i].x-positions[j].x).abs()>=320.||(positions[i].z-positions[j].z).abs()>=104.);}}
    let mut automatic=scene::flat_positions(&graph,&layout);
    scene::restore_manual_positions(&graph,&mut automatic,&BTreeMap::new());
    assert_eq!(automatic[0].x,0.);
    assert_ne!(automatic[1].x,0.);
}

#[test]
fn last_page_fit_brings_single_employee_back_into_view(){
    let agents:Vec<_>=(0..201).map(|i|agent(&format!("agent-{i:03}"),None)).collect();
    let graph=Graph::project_with_budget(&agents,&Filter::default(),false).unwrap();
    let (page,_)=graph.page(&graph.order(),1);
    let layout=Layout::build(&page,&mut Seats::new(),&mut BTreeMap::new());
    let positions=scene::flat_positions(&page,&layout);
    let mut camera=Camera{flat:true,target:V3::new(119400.,0.,0.),distance:600.,pan:[900.,600.],..Camera::default()};
    camera.fit_flat(&positions,&layout,None);
    let (at,_)=camera.project(positions[0],[0.,0.,1200.,800.]).unwrap();
    assert_eq!(at,[600.,400.]);assert_eq!(camera.pan,[0.,0.]);assert!(camera.distance<=600.);
}

#[test]
fn oversized_snapshot_is_rejected_before_id_validation_or_filtering(){
    let shared=Arc::new(agent("",None));
    let agents=vec![shared;graph::MAX_INPUT_NODES+1];
    let error=Graph::project_shared(&agents,&Filter{query:"absent".into(),..Filter::default()},false).err().unwrap();
    assert!(error.contains("索引预算"));
}

#[test]
fn paginated_graph_shares_one_agent_payload_with_snapshot(){
    let agents:Vec<_>=(0..1301).map(|i|Arc::new(agent(&format!("{i:04}"),None))).collect();
    let graph=Graph::project_shared(&agents,&Filter::default(),false).unwrap();
    for page in 0..7{let (page,_)=graph.page(&graph.order(),page);for node in page.nodes{let i=node.agent.id.parse::<usize>().unwrap();assert!(Arc::ptr_eq(&node.agent,&agents[i]));}}
}

#[test]
fn full_1200_employee_scene_keeps_all_hit_targets_under_geometry_budget(){
    // Worst parcel count: every employee has their own building and floor.
    let agents:Vec<_>=(0..1200).map(|i|{let mut a=agent(&format!("{i:04}"),None);a.cwd=Some(format!("/project/{i:04}"));a}).collect();
    let graph=Graph::project(&agents,&Filter::default()).unwrap();
    let layout=Layout::build(&graph,&mut Seats::new(),&mut BTreeMap::new());
    let mut camera=Camera::default();camera.fit(&layout,None);
    let bounds=Bounds{origin:point(px(0.),px(0.)),size:gpui::size(px(1200.),px(800.))};
    let frame=Frame::build(&graph,&layout,&camera,Some(1199),None,bounds,2.,style::Palette::default(),false,&layout.positions);
    assert!(!frame.geometry_rejected);
    assert!(frame.polygons.len()<=24_080);
    let employees:std::collections::BTreeSet<_>=frame.polygons.iter().filter_map(|p|match p.hit{Some(Hit::Node(i))=>Some(i),_=>None}).collect();
    let floors:std::collections::BTreeSet<_>=frame.polygons.iter().filter_map(|p|match p.hit{Some(Hit::Floor(i))=>Some(i),_=>None}).collect();
    assert_eq!(employees.len(),1200);assert_eq!(floors.len(),1200);
    assert!(frame.polygons.iter().filter(|p|p.hit==Some(Hit::Node(1199))).count()>10);
}

#[test]
fn snapshot_reindexes_held_node_without_losing_click_or_drag(){
    let before=Graph::project(&[agent("b",None)],&Filter::default()).unwrap();
    let mut updated=agent("b",None);updated.cpu_percent=Some(42.);
    let after=Graph::project(&[agent("a",None),updated],&Filter::default()).unwrap();
    let layout=Layout::build(&after,&mut Seats::new(),&mut BTreeMap::new());
    let positions=scene::flat_positions(&after,&layout);
    let camera=Camera{flat:true,..Camera::default()};let view=[240.,300.,900.,400.];
    let mut drag=Drag{start:[600.,500.],last:[620.,510.],hit:Some(Hit::Node(0)),target:Some(before.nodes[0].agent.id.clone()),pan:true,moved:false,offset:Some(V3::default())};
    assert!(drag.reconcile(&after,&layout,&positions,&camera,view));
    assert_eq!(drag.hit,Some(Hit::Node(1)));assert!(!drag.moved);
    let point=camera.floor_point(drag.last,positions[1].y,view).unwrap();let offset=drag.offset.unwrap();
    assert!((point.x+offset.x-positions[1].x).abs()<0.01);
    assert!((point.z+offset.z-positions[1].z).abs()<0.01);
    drag.moved=true;
    assert!(drag.reconcile(&after,&layout,&positions,&camera,view));assert!(drag.moved);
    assert!(!drag.reconcile(&Graph::default(),&Layout::default(),&[],&camera,view));
}

#[test]
fn snapshot_reindexes_selected_floor_by_identity(){
    let graph=Graph::project(&[agent("a",None),agent("b",None)],&Filter::default()).unwrap();
    let layout=Layout::build(&graph,&mut Seats::new(),&mut BTreeMap::new());
    let floor=layout.floor_by_node[1];
    let mut drag=Drag{start:[0.,0.],last:[0.,0.],hit:Some(Hit::Floor(usize::MAX)),target:Some(layout.floors[floor].id.clone()),pan:false,moved:false,offset:None};
    assert!(drag.reconcile(&graph,&layout,&layout.positions,&Camera::default(),[0.,0.,900.,400.]));
    assert_eq!(drag.hit,Some(Hit::Floor(floor)));
}

#[test]
fn selected_floor_frame_rebuild_keeps_only_its_employees_after_viewport_change(){
    let graph=Graph::project(&[agent("a",None),agent("b",None)],&Filter::default()).unwrap();
    let layout=Layout::build(&graph,&mut Seats::new(),&mut BTreeMap::new());
    let floor=layout.floor_by_node[1];let mut camera=Camera::default();camera.fit(&layout,None);
    for origin in [point(px(0.),px(0.)),point(px(240.),px(310.))]{
        let bounds=Bounds{origin,size:gpui::size(px(900.),px(400.))};
        let frame=Frame::build(&graph,&layout,&camera,Some(1),Some(floor),bounds,2.,style::Palette::default(),false,&layout.positions);
        assert_eq!(frame.view,[f32::from(origin.x),f32::from(origin.y),900.,400.]);
        assert!(!frame.geometry_rejected);
        assert!(frame.polygons.iter().any(|p|p.hit==Some(Hit::Node(1))));
        for polygon in &frame.polygons{match polygon.hit{Some(Hit::Node(i))=>assert_eq!(layout.floor_by_node[i],floor),Some(Hit::Floor(i))=>assert_eq!(i,floor),Some(Hit::Building(_))=>panic!("buildings must use measured label hit bounds"),None=>{}}}
    }
}

#[test]
fn flat_default_frames_first_project_on_each_page_instead_of_all_projects(){
    let agents:Vec<_>=(0..401).map(|i|{let mut a=agent(&format!("{i:04}"),None);a.cwd=Some(format!("/project/{i:04}"));a}).collect();
    let all=Graph::project_with_budget(&agents,&Filter::default(),false).unwrap();let order=all.order();
    for page in 0..3 {
        let (graph,_)=all.page(&order,page);let layout=Layout::build(&graph,&mut Seats::new(),&mut BTreeMap::new());let positions=scene::flat_positions(&graph,&layout);
        let mut camera=Camera{flat:true,pan:[800.,400.],distance:600_000.,..Camera::default()};
        camera.fit_first_project(&positions,&layout);
        assert_eq!(camera.pan,[0.,0.]);assert!(camera.distance<=600.);
        let (at,_)=camera.project(positions[0],[240.,300.,900.,400.]).unwrap();assert_eq!(at,[690.,500.]);
        let default_distance=camera.distance;camera.fit_flat(&positions,&layout,None);
        if graph.nodes.len()>1{assert!(camera.distance>default_distance*100.);}
    }
}

#[test]
fn selected_node_focus_stays_reachable_in_both_modes_after_zoom(){
    for flat in [false,true]{
        let selected=V3::new(120_000.,if flat{0.}else{520.},9000.);
        let mut camera=Camera{flat,pan:[900.,600.],distance:600_000.,..Camera::default()};
        camera.focus_node(selected);
        assert_eq!(camera.pan,[0.,0.]);assert_eq!(camera.distance,if flat{600.}else{850.});
        for zoom in [0.5,1.,2.]{
            let mut zoomed=camera;zoomed.distance*=zoom;
            let (at,_)=zoomed.project(selected,[240.,300.,900.,400.]).unwrap();assert_eq!(at,[690.,500.]);
        }
    }
}

#[test]
fn continuous_zoom_uses_bounded_half_pixel_glyph_sizes(){
    let mut sizes=std::collections::BTreeSet::new();
    for base in [11.,13.,15.]{for step in 0..20_000{
        let size=scene::label_font_size(base,step as f32/1000.);
        assert!((2. ..=48.).contains(&size));assert_eq!((size*2.).fract(),0.);
        sizes.insert((size*2.)as u32);
    }}
    assert_eq!(sizes.len(),93);
    assert!(scene::label_font_size(13.,0.5)<scene::label_font_size(13.,1.));
    assert!(scene::label_font_size(13.,1.)<scene::label_font_size(13.,2.));
}

#[test]
fn overlapping_project_labels_use_measured_bounds_and_keep_selected_priority(){
    let agents:Vec<_>=(0..20).map(|i|{let mut a=agent(&format!("{i:02}"),None);a.cwd=Some(format!("/project/{i:02}"));a}).collect();
    let graph=Graph::project(&agents,&Filter::default()).unwrap();
    let layout=Layout::build(&graph,&mut Seats::new(),&mut BTreeMap::new());
    let mut camera=Camera::default();camera.fit(&layout,None);
    let bounds=Bounds{origin:point(px(0.),px(0.)),size:gpui::size(px(1200.),px(800.))};
    let overview=Frame::build(&graph,&layout,&camera,None,None,bounds,2.,style::Palette::default(),false,&layout.positions);
    assert_eq!(overview.labels.len(),20);
    assert!(overview.labels.iter().all(|l|matches!(l.hit,Hit::Building(_))));
    let mut frame=Frame::build(&graph,&layout,&camera,Some(19),None,bounds,2.,style::Palette::default(),false,&layout.positions);
    assert_eq!(frame.labels[0].hit,Hit::Node(19));
    assert_eq!(frame.labels[1].hit,Hit::Building(layout.floors[layout.floor_by_node[19]].building));
    // Force labels onto one projected point, with nonuniform measured widths.
    // The selected employee keeps its anchor; displaced buildings must be
    // clickable at their new bounds, and hidden candidates retain their data.
    let hits:Vec<_>=frame.labels.iter().map(|l|l.hit).collect();
    for (i,hit) in hits.into_iter().enumerate(){frame.place_label([1180.,400.],180.+i as f32,20.,hit);}
    assert_eq!(frame.label_bounds[0],([1020.,400.,180.,20.],Hit::Node(19)));
    assert!(frame.label_bounds.len()>1);assert!(frame.label_bounds.len()<frame.labels.len());
    for (i,(r,hit)) in frame.label_bounds.iter().enumerate(){
        assert_eq!(frame.hit([r[0]+r[2]/2.,r[1]+r[3]/2.]),Some(*hit));
        assert!(r[0]>=0.&&r[0]+r[2]<=1200.&&r[1]>=0.&&r[1]+r[3]<=800.);
        for (s,_) in &frame.label_bounds[i+1..]{assert!(r[0]+r[2]<=s[0]||s[0]+s[2]<=r[0]||r[1]+r[3]<=s[1]||s[1]+s[3]<=r[1]);}
    }
    assert_eq!(graph.nodes.len(),20);assert_eq!(layout.floors.len(),20);
    frame.label_bounds.clear();
    for i in 0..20{frame.place_label([10.+(i%5)as f32*220.,10.+(i/5)as f32*100.],180.,20.,Hit::Building(i));}
    assert_eq!(frame.label_bounds.len(),scene::BUILDING_LABEL_LIMIT);
    let floor=layout.floor_by_node[19];
    let focused=Frame::build(&graph,&layout,&camera,Some(19),Some(floor),bounds,2.,style::Palette::default(),false,&layout.positions);
    assert_eq!(focused.labels[0].hit,Hit::Node(19));
    assert!(focused.labels.iter().any(|l|l.hit==Hit::Floor(floor)));
    assert!(focused.labels.iter().all(|l|match l.hit{Hit::Node(i)=>layout.floor_by_node[i]==floor,Hit::Floor(i)=>i==floor,Hit::Building(_)=>false}));
}

#[test]
fn painted_hit_keeps_identity_and_camera_across_refresh_before_pointer_down(){
    let before=Graph::project(&[agent("b",None)],&Filter::default()).unwrap();
    let layout=Layout::build(&before,&mut Seats::new(),&mut BTreeMap::new());
    let positions=scene::flat_positions(&before,&layout);
    let camera=Camera{flat:true,target:positions[0],distance:600.,..Camera::default()};
    let bounds=Bounds{origin:point(px(20.),px(40.)),size:gpui::size(px(900.),px(600.))};
    let frame=Frame::build(&before,&layout,&camera,None,None,bounds,2.,style::Palette::default(),false,&positions);
    let at=camera.project(positions[0],frame.view).unwrap().0;
    assert_eq!(frame.hit(at),Some(Hit::Node(0)));
    // A refresh inserts before the visible card, before the next paint/down.
    let after=Graph::project(&[agent("a",None),agent("b",None)],&Filter::default()).unwrap();
    let after_layout=Layout::build(&after,&mut Seats::new(),&mut BTreeMap::new());
    assert_eq!(frame.resolve_hit(at,&after,&after_layout,true),Ok(Some(Hit::Node(1))));
    assert_eq!(frame.node_ids,vec!["b"]);
    assert_eq!(frame.positions.len(),1);
    assert_eq!(frame.view,[20.,40.,900.,600.]);
    let painted_point=frame.camera.floor_point(at,positions[0].y,frame.view).unwrap();
    assert!((painted_point.x-positions[0].x).abs()<0.01);
    assert!((painted_point.z-positions[0].z).abs()<0.01);
    let mut drag=Drag{start:at,last:at,hit:Some(Hit::Node(1)),target:Some("b".into()),pan:true,moved:false,offset:None};
    assert!(drag.reconcile(&after,&after_layout,&scene::flat_positions(&after,&after_layout),&frame.camera,frame.view));
    assert_eq!(after.nodes[match drag.hit.unwrap(){Hit::Node(i)=>i,_=>panic!("node expected")}].agent.id,"b");
    let removed=Graph::project(&[agent("a",None)],&Filter::default()).unwrap();
    let removed_layout=Layout::build(&removed,&mut Seats::new(),&mut BTreeMap::new());
    assert_eq!(frame.resolve_hit(at,&removed,&removed_layout,true),Err("painted-target-removed"));
    assert!(!drag.reconcile(&removed,&removed_layout,&scene::flat_positions(&removed,&removed_layout),&frame.camera,frame.view));
    assert_eq!(frame.resolve_hit(at,&after,&after_layout,false),Err("painted-mode-changed"));
    assert_eq!(frame.resolve_hit([-1.,-1.],&removed,&removed_layout,true),Ok(None));
}
