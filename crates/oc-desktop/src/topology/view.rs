use super::*;
fn button(label:impl Into<SharedString>,p:style::Palette,cx:&mut Context<TopologyView>,action:impl Fn(&mut TopologyView,&mut Context<TopologyView>)+'static)->impl IntoElement{
    let label=label.into();div().id(label.clone()).px_3().py_1().border_1().border_color(rgb(p.line)).bg(rgb(p.surface)).text_color(rgb(p.text)).cursor_pointer().hover(move|s|s.bg(rgb(p.selected))).child(label).on_click(cx.listener(move|this,_,_,cx|{action(this,cx);cx.notify();}))
}
impl Render for TopologyView{
    fn render(&mut self,_:&mut Window,cx:&mut Context<Self>)->impl IntoElement{
        let p=self.palette;let selected=self.selected_index();
        let owner=cx.entity().downgrade();
        let canvas=self.canvas.get_or_insert_with(||cx.new(|_|TopologyCanvas{owner})).clone();
        let mut canvas_style=gpui::StyleRefinement::default();
        canvas_style.size.width=Some(gpui::relative(1.).into());
        canvas_style.size.height=Some(gpui::relative(1.).into());
        // notify during render only invalidates the next frame in GPUI. Bypass
        // scene reuse now when the owner has changed the geometry or selection.
        let canvas=gpui::AnyView::from(canvas);
        let canvas=if self.dirty{canvas}else{canvas.cached(canvas_style)};
        let mode_button=button(if self.camera.flat{self.t("切换 3D","Switch to 3D")}else{self.t("切换 2D","Switch to 2D")},p,cx,|s,_|s.switch_mode());
        #[cfg(feature="acceptance")]
        let mode_button={
            *self.mode_bounds.borrow_mut()=None;
            let bounds=self.mode_bounds.clone();
            div().relative().child(mode_button).child(gpui::canvas(move|rect,_,_|{*bounds.borrow_mut()=Some(rect);},|_,_,_,_|{}).absolute().top_0().left_0().size_full())
        };
        let mut toolbar=div().flex().flex_wrap().gap_2().p_2().border_b_1().border_color(rgb(p.line))
            .child(mode_button)
            .child(button(self.t("适应视图","Fit view"),p,cx,|s,_|s.fit(None)))
            .child(button(self.t("重新布局","Reset layout"),p,cx,|s,_|{if s.camera.flat{s.flat_seats.clear();}else{s.seats.clear();}s.rebuild();s.default_view();}))
            .child(button(match self.filter.kind{Kind::All=>self.t("类型：全部","Kind: all"),Kind::Main=>self.t("类型：主 Agent","Kind: main"),Kind::Subagent=>self.t("类型：子 Agent","Kind: subagent")},p,cx,|s,_|{s.filter.kind=match s.filter.kind{Kind::All=>Kind::Main,Kind::Main=>Kind::Subagent,Kind::Subagent=>Kind::All};s.page=0;s.rebuild();s.default_view();}))
            .child(button(match self.filter.activity{Activity::All=>self.t("活动：全部","Activity: all"),Activity::Active=>self.t("活动：活跃","Activity: active"),Activity::Inactive=>self.t("活动：空闲","Activity: idle")},p,cx,|s,_|{s.filter.activity=match s.filter.activity{Activity::All=>Activity::Active,Activity::Active=>Activity::Inactive,Activity::Inactive=>Activity::All};s.page=0;s.rebuild();s.default_view();}))
            .child(button(self.t("定位员工","Find employee"),p,cx,|s,_|s.locator=if s.locator==1{0}else{1}));
        if !self.camera.flat{toolbar=toolbar.child(button(self.t("定位楼层","Find floor"),p,cx,|s,_|s.locator=if s.locator==2{0}else{2}));}
        if self.floor.is_some(){toolbar=toolbar.child(button(self.t("显示所有楼层","Show all floors"),p,cx,|s,_|{s.floor=None;s.dirty=true;}));}
        if self.camera.flat{
            toolbar=toolbar.child(button(self.t("上一页","Previous page"),p,cx,|s,_|s.change_page(s.page.saturating_sub(1))))
                .child(div().py_1().child(format!("{} / {} · {} {}",self.page+1,self.page_count(),self.boundary,self.t("条跨页关系","cross-page relationships"))))
                .child(button(self.t("下一页","Next page"),p,cx,|s,_|s.change_page(s.page+1)));
        }
        if let Some(i)=selected{
            let node=&self.graph.nodes[i];
            if node.children>0&&self.filter.kind==Kind::All&&self.filter.activity==Activity::All&&self.filter.query.trim().is_empty(){toolbar=toolbar.child(button(if self.filter.collapsed.contains(&node.agent.id){self.t("展开子树","Expand descendants")}else{self.t("折叠子树","Collapse descendants")},p,cx,|s,_|{if let Some(id)=s.selected.clone(){if !s.filter.collapsed.remove(&id){s.filter.collapsed.insert(id);}s.rebuild();}}));}
            if node.agent.tern.is_some()&&self.evidence_current{toolbar=toolbar.child(button(self.t("在 Tern 中聚焦","Focus in Tern"),p,cx,|s,cx|s.tern(cx)));}
            toolbar=toolbar.child(button(self.t("聚焦所属建筑","Focus building"),p,cx,|s,_|{if let Some(i)=s.selected_index(){let b=s.layout.floors[s.layout.floor_by_node[i]].building;s.fit(Some(b));}}));
            if self.camera.flat{if let Some(parent)=node.agent.parent_id.clone(){if self.all_graph.nodes.iter().any(|n|n.agent.id==parent)&&!self.graph.nodes.iter().any(|n|n.agent.id==parent){toolbar=toolbar.child(button(self.t("定位跨页父 Agent","Find parent on another page"),p,cx,move|s,cx|s.locate(parent.clone(),cx)));}}}
        }
        let source=if self.camera.flat{&self.all_graph}else{&self.graph};
        let status=if self.frame.geometry_rejected{self.t("拓扑几何超过预算，请缩小搜索范围；定位菜单仍可使用。","Topology exceeds the geometry budget. Narrow the search; locator menus remain available.").into()}
            else if let Some(error)=&self.error{self.issue(error)}else if self.agents.is_empty(){self.t("当前快照没有 Agent","No agents in this snapshot").into()}else if self.graph.nodes.is_empty(){self.t("没有匹配的 Agent，请调整搜索或过滤","No matching agents. Adjust search or filters.").into()}
            else{format!("{} {} · {} {} · {} {} · {} {}{}",source.matches,self.t("个匹配","matches"),source.nodes.iter().filter(|n|n.context).count(),self.t("个上下文","context agents"),source.hidden,self.t("个折叠隐藏","collapsed"),source.nodes.iter().filter(|n|n.issue.is_some()).count(),self.t("个关系异常","relationship issues"),if self.evidence_current{""}else{self.t(" · 快照已过期，暂停拖动与 Tern 跳转"," · Stale snapshot: dragging and Tern navigation paused")})};
        let status=if !self.camera.flat&&scene::compact_scene(self.graph.nodes.len(),self.graph.edges.len(),self.layout.buildings.len(),self.layout.floors.len()){
            format!("{status}{}",self.t(" · 简化场景：保留全部员工与楼层，选中员工显示完整细节"," · Simplified scene: all employees and floors retained; select an employee for full detail"))
        }else{status};
        let status=if !self.camera.flat{format!("{status}{}",self.t(" · 标签避让：总览最多 16 个项目；楼层/员工可通过定位菜单访问"," · Labels avoid overlap: up to 16 projects in overview; use locators for every floor/employee"))}else{status};
        let detail=match self.hovered.or(selected.map(Hit::Node)){
            Some(Hit::Node(i))=>{let n=&self.graph.nodes[i];format!("{} · {} · {} {} / {} {}{}",n.agent.name,n.agent.runtime,n.children,self.t("个直接下级","direct children"),n.descendants,self.t("个后代","descendants"),n.issue.map(|issue|format!(" · {}",self.issue(issue))).unwrap_or_default())},
            Some(Hit::Floor(i))=>{let f=&self.layout.floors[i];format!("{} · {}F · {} · {} Agent{}",self.layout.buildings[f.building].name,f.level,f.name,f.members.len(),if f.unresolved{self.t(" · 父子关系未解析"," · Unresolved relationships")}else{""})},
            Some(Hit::Building(i))=>{let b=&self.layout.buildings[i];format!("{} · {} {}",b.name,b.floors.len(),self.t("个任务楼层 · 点击聚焦建筑","task floors · click to focus building"))},
            None=>self.t("拖动旋转 · Shift/中键平移 · 滚轮缩放 · Tab/Shift-Tab 定位员工 · F 下一楼层 · Enter 详情 · Shift-Enter Tern","Drag to orbit · Shift/middle drag to pan · Wheel to zoom · Tab/Shift-Tab employees · F next floor · Enter details · Shift-Enter Tern").into(),
        };
        let mut body=div().flex().flex_1().min_h(px(240.)).overflow_hidden();
        if self.locator!=0{
            let count=if self.locator==2{self.layout.floors.len()}else{source.nodes.len()};
            body=body.child(div().w(px(280.)).h_full().border_r_1().border_color(rgb(p.line)).bg(rgb(p.surface)).child(
                gpui::uniform_list("topology-locator",count,cx.processor(|s,range:std::ops::Range<usize>,_,cx|{
                    range.map(|i|{
                        let floor=s.locator==2;
                        let(label,id)=if floor{let f=&s.layout.floors[i];(format!("{} · {}F · {}",s.layout.buildings[f.building].name,f.level,f.name),f.id.clone())}else{let g=if s.camera.flat{&s.all_graph}else{&s.graph};let n=&g.nodes[i];(format!("{} · {}{}",n.agent.name,n.agent.runtime,if n.issue.is_some(){s.t(" · 关系异常"," · relationship issue")}else{""}),n.agent.id.clone())};
                        let palette=s.palette;
                        div().id(i).h(px(s.font_size+20.)).px_2().py_1().overflow_hidden().text_color(rgb(palette.text)).cursor_pointer().hover(move|d|d.bg(rgb(palette.selected))).child(label)
                            .on_click(cx.listener(move|s,_,window,cx|{window.focus(&s.focus);if floor{if let Some(index)=s.layout.floors.iter().position(|f|f.id==id){s.locate_floor(index);}}else{s.locate(id.clone(),cx);}cx.notify();}))
                    }).collect::<Vec<_>>()
                })).h_full()));
        }
        body=body.child(div().id("topology-canvas").relative().flex_1().h_full().overflow_hidden()
            .child(canvas)
            .on_mouse_down(MouseButton::Left,cx.listener(|s,e,w,cx|s.pointer_down(e,w,cx)))
            .on_mouse_down(MouseButton::Middle,cx.listener(|s,e,w,cx|s.pointer_down(e,w,cx)))
            .on_mouse_down(MouseButton::Right,cx.listener(|s,e:&MouseDownEvent,_,cx|{if let Ok(Some(Hit::Node(i)))=s.painted_hit([e.position.x.into(),e.position.y.into()]){s.select(Hit::Node(i),cx);s.tern(cx);}}))
            .on_mouse_move(cx.listener(|s,e,_,cx|s.pointer_move(e,cx)))
            .on_mouse_up(MouseButton::Left,cx.listener(|s,_,_,cx|s.pointer_up(cx)))
            .on_mouse_up(MouseButton::Middle,cx.listener(|s,_,_,cx|s.pointer_up(cx)))
            .on_mouse_up_out(MouseButton::Left,cx.listener(|s,_,_,cx|{s.cancel_drag("release-outside-canvas");cx.notify();}))
            .on_mouse_up_out(MouseButton::Middle,cx.listener(|s,_,_,cx|{s.cancel_drag("release-outside-canvas");cx.notify();}))
            .on_scroll_wheel(cx.listener(|s,e:&gpui::ScrollWheelEvent,_,cx|{let delta=e.delta.pixel_delta(px(20.));s.camera.distance=(s.camera.distance*(f32::from(delta.y)*0.002).exp()).clamp(60.,600_000.);s.dirty=true;cx.notify();})));
        div().id("native-topology").track_focus(&self.focus).flex().flex_col().size_full().bg(rgb(p.bg)).text_color(rgb(p.text)).text_size(px(self.font_size)).font_family(self.font)
            .child(toolbar).child(div().px_3().py_1().child(status)).child(body)
            // Hover details must not resize the projection between mouse move and down.
            // Keep the complete text scrollable inside two stable lines.
            .child(div().id("topology-detail").h(px((self.font_size+4.)*2.+16.)).flex_shrink_0().overflow_y_scroll().px_3().py_2().border_t_1().border_color(rgb(p.line)).child(detail))
            .on_key_down(cx.listener(|s,e:&gpui::KeyDownEvent,_,cx|s.keyboard(e,cx)))
    }
}
