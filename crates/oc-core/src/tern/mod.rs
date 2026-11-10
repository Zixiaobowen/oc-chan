use std::{collections::{HashMap, HashSet}, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::Duration};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{sync::watch, time::Instant};
use tokio_util::sync::CancellationToken;
use crate::{error::{Error, Result, check_cancel, validate_text}, io::{BoundedIo, CommandSpec, FileIdentity}, model::{AgentInfo, TernTarget}, process::ProcessIdentity};
const SOURCE: &str = "tern-navigation";
const DIGESTS: [(&str, &str); 2] = [("plugin.toml", "16030fddd13a4f54268e99d2dd237f279ae9aac6fd02f451dd7a2360c822dc34"), ("window.luau", "ba0282155dad6f64da69bc4afdab6b5de3afca509c79bb1c1a5cb01190079fde")];
fn failure(code: &str) -> Error { Error::new(code, format!("Tern 导航失败 / Tern navigation failed: {code}")) }
fn path_valid(path: &Path) -> bool {
    path.is_absolute() && path.to_str().is_some_and(|text| text.len() <= 4096 && !text.chars().any(|c| c.is_control()) && !text.ends_with('/'))
        && path.components().all(|part| !matches!(part, std::path::Component::ParentDir | std::path::Component::CurDir))
}
pub fn resolve_target<'a>(agents: &'a [AgentInfo], id: &str) -> Result<(&'a AgentInfo, TernTarget)> {
    if agents.len() > 10_000 { return Err(failure("OC_TERN_TARGET")); }
    let mut by_id = HashMap::with_capacity(agents.len());
    for agent in agents { if by_id.insert(agent.id.as_str(), agent).is_some() { return Err(failure("OC_TERN_TARGET")); } }
    let mut current = id; let mut visited = HashSet::new();
    loop {
        let agent = by_id.get(current).ok_or_else(|| failure("OC_TERN_TARGET"))?;
        if agent.runtime != "OMP" || !visited.insert(current) { return Err(failure("OC_TERN_TARGET")); }
        if let Some(target) = &agent.tern {
            if target.window_key.len() > 128 || !target.window_key.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) || target.pane_id == 0 || target.pane_id > 9_007_199_254_740_991 || !path_valid(Path::new(&target.session_file)) { return Err(failure("OC_TERN_TARGET")); }
            return Ok((agent, target.clone()));
        }
        current = agent.parent_id.as_deref().ok_or_else(|| failure("OC_TERN_TARGET"))?;
    }
}
pub struct TernOptions {
    pub io: BoundedIo, pub resources: PathBuf, pub home: PathBuf, pub tmp: PathBuf, pub headless: bool,
    pub agents: Arc<dyn Fn() -> Vec<AgentInfo> + Send + Sync>,
    pub process_identity: Arc<dyn Fn(String) -> futures_util::future::BoxFuture<'static, Result<ProcessIdentity>> + Send + Sync>,
}
#[derive(Clone)] struct Active { cancel: CancellationToken, done: watch::Receiver<Option<Result<()>>> }
#[derive(Default)] struct State { closed: bool, active: Option<Active> }
pub struct TernNavigation { options: TernOptions, state: Mutex<State> }
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all="camelCase")]
struct TernIdentity { pid: u32, executable: PathBuf, bundle: PathBuf, bundle_id: String, team_id: String }
impl TernNavigation {
    pub fn new(options: TernOptions) -> Result<Arc<Self>> {
        if !path_valid(&options.resources) || !path_valid(&options.home) || !path_valid(&options.tmp) { return Err(failure("OC_TERN_RESOURCES")); }
        Ok(Arc::new(Self { options, state: Mutex::new(State::default()) }))
    }
    pub async fn focus(self: &Arc<Self>, id: &str) -> Result<()> {
        validate_text(id,512,2048,"agent id")?;
        if self.options.headless { return Err(failure("OC_TERN_UNAVAILABLE")); }
        let cancel = CancellationToken::new(); let (tx, rx) = watch::channel(None);
        {
            let mut state = self.state.lock().map_err(|_| failure("OC_TERN_CLOSED"))?;
            if state.closed { return Err(failure("OC_TERN_CLOSED")); }
            if state.active.is_some() { return Err(failure("OC_TERN_BUSY")); }
            state.active = Some(Active { cancel: cancel.clone(), done: rx.clone() });
        }
        let this = self.clone(); let id = id.to_owned();
        tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(10);
            let result = {
                let work = this.navigate(&id, deadline, &cancel); tokio::pin!(work);
                tokio::select! {
                    result = &mut work => result,
                    _ = tokio::time::sleep_until(deadline) => {
                        cancel.cancel(); let result = work.await;
                        match result { Err(error) if error.is_cleanup() => Err(error), _ => Err(failure("OC_TERN_TIMEOUT")) }
                    }
                }
            };
            if let Ok(mut state) = this.state.lock() { state.active = None; }
            tx.send_replace(Some(result));
        });
        wait(rx).await
    }
    pub async fn cancel(&self) -> Result<()> {
        let active = self.state.lock().map_err(|_| failure("OC_TERN_CLOSED"))?.active.clone();
        if let Some(active) = active { active.cancel.cancel(); match wait(active.done).await { Err(error) if error.is_cancelled() => Ok(()), result => result } } else { Ok(()) }
    }
    pub async fn close(&self) -> Result<()> { self.state.lock().map_err(|_| failure("OC_TERN_CLOSED"))?.closed = true; self.cancel().await }
    async fn canonical(&self, path: &Path, cancel: &CancellationToken) -> Result<()> {
        if !path_valid(path) { return Err(failure("OC_TERN_RESOURCES")); }
        let path = path.to_owned();
        self.options.io.with_file_budget(SOURCE,4096,cancel,move |token| async move {
            check_cancel(&token)?;
            let real = tokio::fs::canonicalize(&path).await.map_err(|e| Error::io("canonical native resource",e))?;
            check_cancel(&token)?;
            if real != path { return Err(failure("OC_TERN_RESOURCES")); } Ok(())
        }).await
    }
    async fn resources(&self, cancel: &CancellationToken) -> Result<Vec<(PathBuf, FileIdentity)>> {
        let root = &self.options.resources; let plugin = root.join("plugin"); let helper = root.join("present-window");
        let mut identities = Vec::with_capacity(5);
        for directory in [root, &plugin] {
            self.canonical(directory,cancel).await?;
            let meta = self.options.io.metadata(SOURCE,directory,true,cancel).await?;
            if !meta.is_dir { return Err(failure("OC_TERN_RESOURCES")); }
            identities.push((directory.clone(),meta.identity));
        }
        let entries = self.options.io.read_directory(SOURCE,&plugin,3,256,cancel).await?;
        if entries.len()!=2 || entries.iter().any(|p| !DIGESTS.iter().any(|(name,_)| p.file_name().is_some_and(|n| n == *name))) { return Err(failure("OC_TERN_RESOURCES")); }
        for (name,digest) in DIGESTS {
            let path = plugin.join(name); self.canonical(&path,cancel).await?;
            let read = self.options.io.read_file(SOURCE,&path,16384,true,cancel).await?;
            if format!("{:x}",Sha256::digest(&read.bytes)) != digest { return Err(failure("OC_TERN_RESOURCES")); }
            identities.push((path,read.identity));
        }
        self.canonical(&helper,cancel).await?;
        let meta = self.options.io.metadata(SOURCE,&helper,true,cancel).await?;
        if !meta.is_file || meta.identity.size == 0 || meta.identity.size > 2*1024*1024 || meta.identity.mode & 0o111 == 0 { return Err(failure("OC_TERN_RESOURCES")); }
        identities.push((helper,meta.identity));
        self.revalidate(&identities,cancel).await?; Ok(identities)
    }
    async fn revalidate(&self, identities: &[(PathBuf,FileIdentity)], cancel: &CancellationToken) -> Result<()> {
        for (path,identity) in identities { self.canonical(path,cancel).await?; if self.options.io.metadata(SOURCE,path,true,cancel).await?.identity != *identity { return Err(failure("OC_TERN_RESOURCES")); } } Ok(())
    }
    async fn command(&self, executable: &Path, args: &[&str], limit: usize, helper: bool, deadline: Instant, cancel: &CancellationToken) -> Result<Value> {
        check_cancel(cancel)?;
        let remaining = deadline.checked_duration_since(Instant::now()).ok_or_else(|| failure("OC_TERN_TIMEOUT"))?;
        let mut spec = CommandSpec::new(executable,args.iter().copied(),limit,remaining);
        spec.stderr_limit = 65536;
        spec.env.insert("HOME".into(),self.options.home.as_os_str().to_owned());
        spec.env.insert("TMPDIR".into(),self.options.tmp.as_os_str().to_owned());
        self.options.io.command_with_output(SOURCE,spec,cancel,move |output, token| async move {
            check_cancel(&token)?;
            if output.exit_code != 0 {
                if helper { if let Ok(code) = std::str::from_utf8(&output.stderr) {
                    let code = code.strip_suffix('\n').unwrap_or(code);
                    if matches!(code,"OC_TERN_UNAVAILABLE"|"OC_TERN_IDENTITY"|"OC_TERN_AMBIGUOUS"|"OC_TERN_TARGET"|"OC_TERN_PROTOCOL"|"OC_TERN_RESOURCES"|"OC_TERN_PLUGIN"|"OC_TERN_BUSY"|"OC_TERN_CLOSED"|"OC_TERN_TIMEOUT"|"OC_TERN_COMMAND"|"OC_TERN_ACCESSIBILITY"|"OC_TERN_ACTIVATION"|"OC_TERN_WINDOW") { return Err(failure(code)); }
                } }
                return Err(failure("OC_TERN_COMMAND"));
            }
            serde_json::from_slice(&output.stdout).map_err(|_| failure("OC_TERN_PROTOCOL"))
        }).await
    }
    async fn navigate(&self,id:&str,deadline:Instant,cancel:&CancellationToken)->Result<()> {
        self.canonical(&self.options.home,cancel).await?; self.canonical(&self.options.tmp,cancel).await?;
        let agents = (self.options.agents)(); let (owner,target) = resolve_target(&agents,id)?;
        let owner_id=owner.id.clone(); let session_id=owner.session_id.as_deref().ok_or_else(|| failure("OC_TERN_TARGET"))?;
        let birth=(self.options.process_identity)(owner_id.clone()).await?;
        if owner.pid != birth.pid || ProcessIdentity::read(birth.pid)? != birth { return Err(failure("OC_TERN_IDENTITY")); }
        let session=self.options.io.read_range(SOURCE,Path::new(&target.session_file),0,65536,cancel).await?;
        let header:Value=serde_json::from_slice(session.bytes.split(|b| *b==b'\n').next().ok_or_else(|| failure("OC_TERN_TARGET"))?).map_err(|_| failure("OC_TERN_TARGET"))?;
        if header["type"]!="session" || header["id"]!=session_id { return Err(failure("OC_TERN_TARGET")); }
        let resources=self.resources(cancel).await?; let helper=self.options.resources.join("present-window");
        let identity=identity(self.command(&helper,&["probe"],65536,true,deadline,cancel).await?)?;
        let tern_birth=ProcessIdentity::read(identity.pid)?;
        let executable_identity=self.options.io.metadata(SOURCE,&identity.executable,true,cancel).await?.identity;
        let inspect=["inspect","--json","--window",target.window_key.as_str()];
        pane(&self.command(&identity.executable,&inspect,2*1024*1024,false,deadline,cancel).await?,&target)?;
        if !plugin_ready(&self.command(&identity.executable,&["plugin","list","--json"],256*1024,false,deadline,cancel).await?)? {
            self.revalidate(&resources,cancel).await?;
            let plugin=self.options.resources.join("plugin"); let plugin=plugin.to_str().ok_or_else(|| failure("OC_TERN_RESOURCES"))?;
            self.command(&identity.executable,&["plugin","install",plugin,"--json"],256*1024,false,deadline,cancel).await?;
            if !plugin_ready(&self.command(&identity.executable,&["plugin","list","--json"],256*1024,false,deadline,cancel).await?)? { return Err(failure("OC_TERN_PLUGIN")); }
        }
        self.revalidate(&resources,cancel).await?;
        let current=identity_from(self.command(&helper,&["probe"],65536,true,deadline,cancel).await?)?;
        let latest=(self.options.agents)(); let (new_owner,new_target)=resolve_target(&latest,id)?;
        if current != identity || new_owner.id!=owner_id || new_target!=target || new_owner.session_id.as_deref()!=Some(session_id)
            || (self.options.process_identity)(owner_id.clone()).await? != birth || ProcessIdentity::read(birth.pid)?!=birth || ProcessIdentity::read(identity.pid)?!=tern_birth
            || self.options.io.metadata(SOURCE,&identity.executable,true,cancel).await?.identity!=executable_identity { return Err(failure("OC_TERN_IDENTITY")); }
        let session_now=self.options.io.metadata(SOURCE,Path::new(&target.session_file),true,cancel).await?;
        if !session_now.is_file || !session_now.identity.same_file(&session.identity) { return Err(failure("OC_TERN_TARGET")); }
        pane(&self.command(&identity.executable,&inspect,2*1024*1024,false,deadline,cancel).await?,&target)?;
        check_cancel(cancel)?;
        let session_current=self.options.io.read_range(SOURCE,Path::new(&target.session_file),0,65536,cancel).await?;
        let header_current:Value=serde_json::from_slice(session_current.bytes.split(|b|*b==b'\n').next().ok_or_else(||failure("OC_TERN_TARGET"))?).map_err(|_|failure("OC_TERN_TARGET"))?;
        if !session_current.identity.same_file(&session.identity)||header_current["type"]!="session"||header_current["id"]!=session_id||ProcessIdentity::read(birth.pid)?!=birth||ProcessIdentity::read(identity.pid)?!=tern_birth{return Err(failure("OC_TERN_IDENTITY"));}
        let pane_id=target.pane_id.to_string();
        let focused=self.command(&identity.executable,&["focus",&pane_id,"--json","--window",&target.window_key],65536,false,deadline,cancel).await?;
        if focused["block"].as_u64()!=Some(target.pane_id) { return Err(failure("OC_TERN_TARGET")); }
        if ProcessIdentity::read(identity.pid)?!=tern_birth { return Err(failure("OC_TERN_IDENTITY")); }
        self.revalidate(&resources,cancel).await?;
        let pid=identity.pid.to_string(); let executable=identity.executable.to_str().ok_or_else(|| failure("OC_TERN_IDENTITY"))?;
        let presented=self.command(&helper,&["present",&pid,executable,&target.window_key],65536,true,deadline,cancel).await?;
        let prefix=format!("[Tern {}] ",serde_json::to_string(&target.window_key).map_err(|_| failure("OC_TERN_TARGET"))?);
        if presented["pid"].as_u64()!=Some(identity.pid as u64) || presented["main"]!=true || !presented["windowTitle"].as_str().is_some_and(|s| s.len()<=4096 && !s.chars().any(|c| c.is_control()) && s.starts_with(&prefix)) { return Err(failure("OC_TERN_WINDOW")); } Ok(())
    }
}
fn identity(value:Value)->Result<TernIdentity>{identity_from(value)}
fn identity_from(value:Value)->Result<TernIdentity>{
    let result:TernIdentity=serde_json::from_value(value).map_err(|_| failure("OC_TERN_IDENTITY"))?;
    if result.pid==0 || result.pid>i32::MAX as u32 || result.bundle_id!="so.stencil.tern" || result.team_id!="VTLHGQC72S" || !path_valid(&result.bundle) || !path_valid(&result.executable) || result.executable!=result.bundle.join("Contents/MacOS/tern") { return Err(failure("OC_TERN_IDENTITY")); } Ok(result)
}
fn pane(value:&Value,target:&TernTarget)->Result<()> {
    let panes=value["panes"].as_array().filter(|a| a.len()<=10_000).ok_or_else(|| failure("OC_TERN_PROTOCOL"))?; let mut matches=0;
    for pane in panes { let id=pane["pane"].as_u64().filter(|n| *n>0 && *n<=9_007_199_254_740_991).ok_or_else(|| failure("OC_TERN_PROTOCOL"))?;
        if id==target.pane_id { if !pane["exited"].is_null() || pane["omp_session_file"]!=target.session_file { return Err(failure("OC_TERN_TARGET")); } matches+=1; }
    }
    if matches!=1 { return Err(failure("OC_TERN_TARGET")); } Ok(())
}
fn plugin_ready(value:&Value)->Result<bool>{
    let plugins=value["plugins"].as_array().filter(|a|a.len()<=256).ok_or_else(|| failure("OC_TERN_PROTOCOL"))?; let mut ids=HashSet::new(); let mut ready=false;
    for plugin in plugins { let id=plugin["id"].as_str().filter(|id| id.len()<=256).ok_or_else(|| failure("OC_TERN_PLUGIN"))?;
        if !ids.insert(id) { return Err(failure("OC_TERN_PLUGIN")); }
        if id=="oc-chan-navigation" { if plugin["status"]!="ready" || plugin["window"]!=true || plugin["version"]!="1.0.0" { return Err(failure("OC_TERN_PLUGIN")); } ready=true; }
    } Ok(ready)
}
async fn wait(mut rx:watch::Receiver<Option<Result<()>>>)->Result<()> {
    loop { if let Some(result)=rx.borrow().clone() { return result; } rx.changed().await.map_err(|_| failure("OC_TERN_CLOSED"))?; }
}
#[cfg(test)] mod tests {
    use super::*; use serde_json::json;
    #[test] fn rejects_ambiguous_and_replaced_panes() {
        let target=TernTarget { window_key:"w".into(),pane_id:1,session_file:"/tmp/session".into() };
        let item=json!({"pane":1,"omp_session_file":"/tmp/session"});
        assert!(pane(&json!({"panes":[item.clone(),item]}),&target).is_err());
        assert!(pane(&json!({"panes":[{"pane":1,"omp_session_file":"/tmp/replaced"}]}),&target).is_err());
    }
    #[test] fn refuses_untrusted_executable_and_duplicate_plugin() {
        assert!(identity(json!({"pid":1,"bundle":"/Applications/Tern.app","executable":"/bin/sh","bundleId":"so.stencil.tern","teamId":"VTLHGQC72S"})).is_err());
        assert!(plugin_ready(&json!({"plugins":[{"id":"x"},{"id":"x"}]})).is_err());
    }
    fn agent(id:&str,parent:Option<&str>,tern:Option<TernTarget>)->AgentInfo {
        serde_json::from_value(json!({"id":id,"name":"agent","runtime":"OMP","kind":"main","state":"unknown","pid":42,"parentId":parent,"tern":tern,"source":"test"})).unwrap()
    }
    #[test] fn walks_only_confirmed_parent_chain_and_rejects_cycles() {
        let target=TernTarget{window_key:"w".into(),pane_id:1,session_file:"/private/tmp/session".into()};
        let root=agent("root",None,Some(target.clone()));let child=agent("child",Some("root"),None);
        let agents=vec![root,child];assert_eq!(resolve_target(&agents,"child").unwrap().1,target);
        let cycle=vec![agent("a",Some("b"),None),agent("b",Some("a"),None)];assert!(resolve_target(&cycle,"a").is_err());
        assert!(resolve_target(&[agent("a",Some("missing"),None)],"a").is_err());
        assert!(resolve_target(&[agents[0].clone(),agents[0].clone()],"root").is_err());
    }
    fn navigation(root:&Path,headless:bool)->Arc<TernNavigation>{
        TernNavigation::new(TernOptions{io:BoundedIo::new(crate::resources::ResourceBudget::default()),resources:root.to_owned(),home:root.to_owned(),tmp:root.to_owned(),headless,agents:Arc::new(Vec::new),process_identity:Arc::new(|_|Box::pin(async{Err(failure("OC_TERN_IDENTITY"))}))}).unwrap()
    }
    #[tokio::test]async fn changed_resource_identity_and_symlink_are_rejected(){
        let directory=tempfile::tempdir().unwrap();let root=std::fs::canonicalize(directory.path()).unwrap();let path=root.join("payload");std::fs::write(&path,"first").unwrap();
        let navigation=navigation(&root,false);let cancel=CancellationToken::new();let identity=navigation.options.io.metadata(SOURCE,&path,true,&cancel).await.unwrap().identity;
        std::fs::remove_file(&path).unwrap();std::fs::write(&path,"replacement").unwrap();
        assert_eq!(navigation.revalidate(&[(path.clone(),identity)],&cancel).await.unwrap_err().code,"OC_TERN_RESOURCES");
        let alias=root.join("alias");std::os::unix::fs::symlink(&path,&alias).unwrap();assert_eq!(navigation.canonical(&alias,&cancel).await.unwrap_err().code,"OC_TERN_RESOURCES");
        navigation.options.io.shutdown().await.unwrap();
    }
    #[tokio::test]async fn headless_and_closed_reject_without_commands(){
        let directory=tempfile::tempdir().unwrap();let root=std::fs::canonicalize(directory.path()).unwrap();let navigation=navigation(&root,true);
        assert_eq!(navigation.focus("agent").await.unwrap_err().code,"OC_TERN_UNAVAILABLE");assert_eq!(navigation.options.io.resources().snapshot().global.admitted,0);
        navigation.close().await.unwrap();navigation.options.io.shutdown().await.unwrap();
    }
    #[tokio::test]async fn cancel_waits_for_actual_operation_cleanup(){
        let directory=tempfile::tempdir().unwrap();let root=std::fs::canonicalize(directory.path()).unwrap();let navigation=navigation(&root,false);
        let cancel=CancellationToken::new();let (tx,rx)=watch::channel(None);navigation.state.lock().unwrap().active=Some(Active{cancel:cancel.clone(),done:rx});
        let cleaned=Arc::new(std::sync::atomic::AtomicBool::new(false));let worker_cleaned=cleaned.clone();
        tokio::spawn(async move{cancel.cancelled().await;tokio::task::yield_now().await;worker_cleaned.store(true,std::sync::atomic::Ordering::Release);tx.send_replace(Some(Err(Error::cancelled())));});
        navigation.cancel().await.unwrap();assert!(cleaned.load(std::sync::atomic::Ordering::Acquire));navigation.options.io.shutdown().await.unwrap();
    }
}
