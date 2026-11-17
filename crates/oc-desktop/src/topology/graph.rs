use oc_core::model::{AgentInfo, AgentKind, AgentState};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;
// Bounds all index/relationship allocations before sorting or constructing maps.
// At most 10,000 entries: approximately 4 MiB of transient index metadata.
pub const MAX_INPUT_NODES: usize = 10_000;
pub fn check_input_budget(count: usize) -> Result<(), String> {
    if count > MAX_INPUT_NODES { Err(format!("快照包含 {count} 个 Agent，超过索引预算 {MAX_INPUT_NODES}；请缩小输入快照")) } else { Ok(()) }
}

pub const MAX_NODES: usize = 1200;
pub const MAX_EDGES: usize = 2400;
#[derive(Clone, Copy, Default, PartialEq)]
pub enum Kind { #[default] All, Main, Subagent }
#[derive(Clone, Copy, Default, PartialEq)]
pub enum Activity { #[default] All, Active, Inactive }
#[derive(Default)]
pub struct Filter { pub kind: Kind, pub activity: Activity, pub query: String, pub collapsed: BTreeSet<String> }
#[derive(Clone)]
pub struct Node { pub agent: Arc<AgentInfo>, pub context: bool, pub issue: Option<&'static str>, pub children: usize, pub descendants: usize }
#[derive(Clone,Default)]
pub struct Graph { pub nodes: Vec<Node>, pub edges: Vec<(usize, usize)>, pub matches: usize, pub hidden: usize }
impl Graph {
    #[cfg(test)]
    pub fn project(agents: &[AgentInfo], filter: &Filter) -> Result<Self, String> { Self::project_with_budget(agents,filter,true) }
    #[cfg(test)]
    pub fn project_with_budget(agents: &[AgentInfo], filter: &Filter,bounded:bool) -> Result<Self, String> {
        check_input_budget(agents.len())?;
        let agents: Vec<_> = agents.iter().cloned().map(Arc::new).collect();
        Self::project_shared(&agents, filter, bounded)
    }
    pub fn project_shared(agents: &[Arc<AgentInfo>], filter: &Filter, bounded: bool) -> Result<Self, String> {
        check_input_budget(agents.len())?;
        let mut ordered: Vec<_> = agents.iter().collect();
        ordered.sort_by(|a,b| a.id.cmp(&b.id));
        let mut index = BTreeMap::new();
        for (i,a) in ordered.iter().enumerate() {
            if a.id.trim().is_empty() || index.insert(a.id.as_str(),i).is_some() { return Err("Agent ID 为空或重复，无法构建拓扑".into()); }
        }
        let mut children = vec![Vec::new(); ordered.len()];
        let parents: Vec<_> = ordered.iter().map(|a| a.parent_id.as_deref().and_then(|id| index.get(id).copied())).collect();
        for (i,parent) in parents.iter().enumerate() { if let Some(p) = parent { children[*p].push(i); } }
        let mut remaining: Vec<_> = children.iter().map(Vec::len).collect();
        let mut descendants = vec![0; ordered.len()];
        let mut queue: VecDeque<_> = (0..ordered.len()).filter(|i| remaining[*i] == 0).collect();
        while let Some(i) = queue.pop_front() { if let Some(p) = parents[i] { descendants[p] += descendants[i]+1; remaining[p] -= 1; if remaining[p] == 0 { queue.push_back(p); } } }
        let mut cycles = BTreeSet::new();
        for i in 0..ordered.len() { if remaining[i] == 0 || cycles.contains(&i) { continue; } let mut cycle = Vec::new(); let mut p = i; while cycles.insert(p) { cycle.push(p); p = parents[p].expect("cycle has parent"); } let count = cycle.iter().map(|i| descendants[*i]+1).sum::<usize>()-1; for i in cycle { descendants[i] = count; } }
        let query = filter.query.trim().to_lowercase();
        let matches: BTreeSet<_> = ordered.iter().enumerate().filter(|(_,a)| {
            let active = a.state == AgentState::Working || a.activity.is_some();
            (filter.kind == Kind::All || (filter.kind == Kind::Main) == (a.kind == AgentKind::Main)) &&
            (filter.activity == Activity::All || (filter.activity == Activity::Active && active) || (filter.activity == Activity::Inactive && !active && a.state == AgentState::Idle)) &&
            (query.is_empty() || [a.name.as_str(), a.runtime.as_str(), a.summary.as_deref().unwrap_or(""), a.cwd.as_deref().unwrap_or(""), a.model.as_deref().unwrap_or(""), &a.pid.to_string()].iter().any(|v| v.to_lowercase().contains(&query)))
        }).map(|(i,_)| i).collect();
        let mut included = matches.clone(); let mut visited = BTreeSet::new();
        for i in &matches { let mut p = Some(*i); while let Some(i) = p { if !visited.insert(i) { break; } included.insert(i); p = parents[i]; } }
        if filter.activity != Activity::Inactive { queue.extend(matches.iter().copied()); let mut visited = matches.clone(); while let Some(i) = queue.pop_front() { for child in &children[i] { if visited.insert(*child) { included.insert(*child); queue.push_back(*child); } } } }
        let mut hidden = BTreeSet::new();
        if filter.kind == Kind::All && filter.activity == Activity::All && query.is_empty() {
            for (i,a) in ordered.iter().enumerate() { if !filter.collapsed.contains(&a.id) { continue; } let mut visited = BTreeSet::from([i]); queue.extend(children[i].iter().copied()); while let Some(j) = queue.pop_front() { if visited.insert(j) { hidden.insert(j); queue.extend(children[j].iter().copied()); } } }
        }
        let visible: Vec<_> = included.difference(&hidden).copied().collect();
        if bounded && visible.len() > MAX_NODES { return Err(format!("拓扑包含 {} 个节点，超过 {MAX_NODES} 上限；请缩小搜索或过滤范围", visible.len())); }
        let mapped: BTreeMap<_,_> = visible.iter().enumerate().map(|(i,j)| (*j,i)).collect();
        let edges: Vec<_> = visible.iter().filter_map(|j| parents[*j].and_then(|p| mapped.get(&p).map(|i| (*i,mapped[j])))).collect();
        if bounded && edges.len() > MAX_EDGES { return Err(format!("拓扑关系超过 {MAX_EDGES} 上限")); }
        let nodes = visible.into_iter().map(|i| { let a = ordered[i]; Node { agent: a.clone(), context: !matches.contains(&i), children: children[i].len(), descendants: descendants[i], issue: if cycles.contains(&i) { Some("父子关系存在循环") } else if a.parent_id.is_some() && parents[i].is_none() { Some("父 Agent 不在当前快照中") } else if a.kind == AgentKind::Subagent && a.parent_id.is_none() { Some("未提供父 Agent 关系") } else { None } } }).collect();
        Ok(Self { nodes, edges, matches: matches.len(), hidden: hidden.len() })
    }
    /// Project roots first, then real descendants. Cycles are visited exactly once.
    pub fn order(&self)->Vec<usize>{
        let mut children=vec![Vec::new();self.nodes.len()];let mut parented=BTreeSet::new();
        for &(a,b)in &self.edges{children[a].push(b);parented.insert(b);}
        let mut roots:Vec<_>=(0..self.nodes.len()).collect();roots.sort_by_key(|i|{let a=&self.nodes[*i].agent;(parented.contains(i),a.cwd.as_deref().unwrap_or("").is_empty(),a.cwd.as_deref().unwrap_or(""),a.id.as_str())});
        let mut seen=BTreeSet::new();let mut order=Vec::with_capacity(self.nodes.len());
        for root in roots{let mut pending=vec![root];while let Some(i)=pending.pop(){if !seen.insert(i){continue;}order.push(i);pending.extend(children[i].iter().rev().copied());}}order
    }
    pub fn page(&self,order:&[usize],page:usize)->(Self,usize){
        let start=(page*200).min(order.len());let ids=&order[start..(start+200).min(order.len())];let mapped:BTreeMap<_,_>=ids.iter().enumerate().map(|(i,j)|(*j,i)).collect();let mut edges=Vec::new();let mut boundary=0;
        for &(a,b)in &self.edges{match(mapped.get(&a),mapped.get(&b)){(Some(a),Some(b))=>edges.push((*a,*b)),(Some(_),None)|(None,Some(_))=>boundary+=1,_=>{}}}
        (Self{nodes:ids.iter().map(|i|self.nodes[*i].clone()).collect(),edges,matches:self.matches,hidden:self.hidden},boundary)
    }
}
