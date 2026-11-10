//! Live agent discovery and bounded activity observation. The monitor owns the 2s discovery cadence.
mod activity;
mod discovery;
mod live;
mod runtime;
mod sessions;
mod watch;
#[cfg(test)]
mod tests;

use std::{collections::BTreeMap, path::PathBuf, sync::{Arc, Mutex as StdMutex}};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use crate::{error::{Error, Result, check_cancel, validate_text}, io::BoundedIo, model::AgentSnapshot, process::ProcessIdentity};

pub const MAX_SESSIONS: usize = 128;
#[derive(Clone, Debug)]
pub struct AgentPaths {
    pub home: PathBuf, pub sessions: PathBuf, pub owners: PathBuf, pub collab_hosts: PathBuf,
    /// Explicit runtime root for Tern inspect; never infer a socket from historical sessions.
    pub runtime_directory: Option<PathBuf>,
}
impl AgentPaths {
    pub fn for_home(home: PathBuf) -> Self {
        let root = home.join(".omp");
        Self { home, sessions: root.join("agent/sessions"), owners: root.join("run/session-owners"), collab_hosts: root.join("run/collab-hosts"), runtime_directory: std::env::var_os("TMPDIR").map(PathBuf::from) }
    }
    fn validate(&self) -> Result<()> {
        for path in [&self.home, &self.sessions, &self.owners, &self.collab_hosts].into_iter().chain(self.runtime_directory.as_ref()) {
            if !path.is_absolute() || path.as_os_str().len() > 4096 { return Err(Error::invalid("agent runtime root")); }
        }
        Ok(())
    }
}
pub(super) struct Published { pending: bool, identities: BTreeMap<String, ProcessIdentity> }
impl Default for Published { fn default() -> Self { Self { pending: true, identities: BTreeMap::new() } } }
impl Published {
    fn invalidate(&mut self) { self.pending = true; self.identities.clear(); }
}
struct Run {
    cancel: CancellationToken, tx: mpsc::Sender<live::Reconcile>, tasks: TaskTracker,
    task: tokio::task::JoinHandle<Result<()>>, gate: Arc<Mutex<()>>,
    cleanup: Arc<StdMutex<Vec<Error>>>,
}
pub struct AgentCollector {
    io: BoundedIo, paths: AgentPaths, publish: Arc<dyn Fn(Result<AgentSnapshot>) + Send + Sync>,
    run: Mutex<Option<Run>>, stopped: StdMutex<Option<Result<()>>>,
    published: Arc<StdMutex<Published>>,
}
impl AgentCollector {
    pub fn new(io: BoundedIo, home: PathBuf, publish: Arc<dyn Fn(Result<AgentSnapshot>) + Send + Sync>) -> Self {
        Self::with_paths(io, AgentPaths::for_home(home), publish)
    }
    pub fn with_paths(io: BoundedIo, paths: AgentPaths, publish: Arc<dyn Fn(Result<AgentSnapshot>) + Send + Sync>) -> Self {
        Self { io, paths, publish, run: Mutex::new(None), stopped: StdMutex::new(None), published: Arc::new(StdMutex::new(Published::default())) }
    }
    pub async fn start(&self, cancel: CancellationToken) -> Result<()> {
        self.paths.validate()?; check_cancel(&cancel)?;
        let mut slot = self.run.lock().await;
        if let Some(run) = slot.as_ref() { return check_cancel(&run.cancel); }
        let token = cancel.child_token(); let io_cancel = self.io.cancellation();
        let starting = token.clone().drop_guard();
        let (tx, receiver) = mpsc::channel(1);
        let (ready_tx, ready_rx) = oneshot::channel();
        let io = self.io.clone(); let publish = self.publish.clone(); let actor_cancel = token.clone();
        let published = self.published.clone(); published.lock().expect("published identity lock").invalidate();
        let task = tokio::spawn(async move { live::run(io, publish, receiver, actor_cancel, io_cancel, published, ready_tx).await });
        *slot = Some(Run { cancel: token.clone(), tx, tasks: TaskTracker::new(), task, gate: Arc::new(Mutex::new(())), cleanup: Arc::new(StdMutex::new(Vec::new())) });
        let ready = ready_rx.await.map_err(|_| Error::new("OC_AGENT_TASK", "Agent 监听任务未启动")).and_then(|result| result);
        if let Err(error) = ready {
            token.cancel();
            let stopped = (&mut slot.as_mut().expect("starting run").task).await;
            slot.take();
            return match stopped { Ok(Err(cleanup)) if cleanup.is_cleanup() => Err(Error::aggregate(vec![error, cleanup])), Err(_) => Err(Error::aggregate(vec![error, Error::new("OC_RESOURCE_CLOSE", "Agent监听启动任务异常退出")])), _ => Err(error) };
        }
        *self.stopped.lock().expect("stop result lock") = None;
        check_cancel(&token)?; starting.disarm(); Ok(())
    }
    pub async fn collect(&self, cancel: &CancellationToken) -> Result<AgentSnapshot> {
        check_cancel(cancel)?;
        let slot = self.run.lock().await;
        let run = slot.as_ref().ok_or_else(|| Error::new("OC_NOT_STARTED", "AgentCollector 尚未启动"))?;
        check_cancel(&run.cancel)?;
        let io = self.io.clone(); let paths = self.paths.clone(); let tx = run.tx.clone();
        let stopped = run.cancel.clone(); let caller = cancel.clone();
        let permit = run.gate.clone().try_lock_owned().map_err(|_| Error::new("OC_AGENT_BUSY", "前次Agent采集尚未完成 / Agent discovery is already in flight"))?;
        self.published.lock().expect("published identity lock").invalidate();
        let cleanup = run.cleanup.clone();
        let operation = stopped.child_token(); let guard = operation.clone().drop_guard();
        let (sender, receiver) = oneshot::channel();
        run.tasks.spawn(async move {
            let work = async {
                let _permit = permit;
                check_cancel(&operation)?;
                let discovery = discovery::discover(&io, &paths, &operation).await?;
                let (reply, result) = oneshot::channel();
                tokio::select! { biased; _ = operation.cancelled() => return Err(Error::cancelled()), sent = tx.send(live::Reconcile { discovery, cancel: operation.clone(), reply }) => sent.map_err(|_| Error::new("OC_AGENT_TASK", "Agent监听已停止"))? }
                let snapshot = result.await.map_err(|_| Error::new("OC_AGENT_TASK", "Agent监听未确认采集"))??;
                check_cancel(&operation)?; Ok(snapshot)
            };
            tokio::pin!(work);
            let result = tokio::select! {
                result = &mut work => result,
                _ = caller.cancelled() => { operation.cancel(); work.await },
                _ = stopped.cancelled() => { operation.cancel(); work.await },
            };
            if let Err(error) = &result { if error.is_cleanup() { let mut errors = cleanup.lock().expect("discovery cleanup lock"); if errors.len() < 16 { errors.push(error.clone()); } } }
            let _ = sender.send(result);
        });
        drop(slot);
        let result = receiver.await.map_err(|_| Error::new("OC_AGENT_TASK", "Agent采集任务异常退出"))?;
        guard.disarm(); result
    }
    pub async fn process_identity(&self, agent_id: &str) -> Result<ProcessIdentity> {
        validate_text(agent_id, 512, 2048, "agent id")?;
        let published = self.published.lock().expect("published identity lock");
        let identity = published.identities.get(agent_id).filter(|identity| !published.pending && identity.matches_live())
            .ok_or_else(|| Error::new("OC_AGENT_IDENTITY", "目标未发布、已退出或进程身份已变化 / Agent identity is not currently published"))?;
        Ok(identity.clone())
    }
    pub async fn stop(&self) -> Result<()> {
        let mut slot = self.run.lock().await;
        self.published.lock().expect("published identity lock").invalidate();
        let Some(run) = slot.as_mut() else { return self.stopped.lock().expect("stop result lock").clone().unwrap_or(Ok(())); };
        run.cancel.cancel(); run.tasks.close();
        // The actor drains its readers and watcher; discovery supervisors retain their IO leases until settled.
        run.tasks.wait().await;
        let result = (&mut run.task).await.map_err(|_| Error::new("OC_RESOURCE_CLOSE", "Agent监听任务异常退出" )).and_then(|result| result);
        let mut errors = std::mem::take(&mut *run.cleanup.lock().expect("discovery cleanup lock"));
        if let Err(error) = result { errors.push(error); }
        let result = if errors.is_empty() { Ok(()) } else { Err(Error::aggregate(errors)) };
        *self.stopped.lock().expect("stop result lock") = Some(result.clone());
        slot.take(); result
    }
}
impl Drop for AgentCollector {
    fn drop(&mut self) { if let Some(run) = self.run.get_mut().as_ref() { run.cancel.cancel(); } }
}
