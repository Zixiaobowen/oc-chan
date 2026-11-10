use std::{collections::BTreeMap, path::PathBuf, sync::{Arc, Mutex as StdMutex}, time::Duration};
use futures_util::{stream::FuturesUnordered, StreamExt, future::BoxFuture};
use tokio::{sync::{mpsc, oneshot}, time::Instant};
use tokio_util::sync::CancellationToken;
use crate::{error::{Error, Result, check_cancel, timestamp}, io::BoundedIo, model::{AgentSnapshot, SourceState, SourceStatus, AGENT_ACTIVITY_WINDOW_MS}};
use super::{activity::{ActivityRead, ActivityReader, time}, discovery::Discovery, sessions::Session, watch::{FileWatcher, Signal}, MAX_SESSIONS};

pub(super) struct Reconcile { pub discovery: Discovery, pub cancel: CancellationToken, pub reply: oneshot::Sender<Result<AgentSnapshot>> }
const COALESCE: Duration = Duration::from_millis(90);
const PUBLISH: Duration = Duration::from_millis(16);
const MAX_READS: usize = 8;
struct Entry {
    session: Session, revision: u64, reader: Option<ActivityReader>, result: Option<ActivityRead>,
    error: Option<String>, watching: bool, reading: bool, due: Option<Instant>, dirty: bool, cancel: CancellationToken,
}
struct Completed { path: PathBuf, revision: u64, reader: ActivityReader, result: Result<ActivityRead> }
struct Actor {
    io: BoundedIo, publish: Arc<dyn Fn(Result<AgentSnapshot>) + Send + Sync>,
    cancel: CancellationToken, entries: BTreeMap<PathBuf, Entry>, base: Option<Discovery>,
    watcher: Option<FileWatcher>, watch_peak: usize,
    reads: FuturesUnordered<BoxFuture<'static, Completed>>, revision: u64, publish_due: Option<Instant>,
    cleanup: Vec<Error>,
    published: Arc<StdMutex<super::Published>>,
    base_cancel: CancellationToken,
}
impl Actor {
    fn record_cleanup(&mut self, error: Error) { if self.cleanup.len() < 16 { self.cleanup.push(error); } }
    fn queue_publish(&mut self) { self.publish_due.get_or_insert_with(|| Instant::now() + PUBLISH); }
    fn detach(&mut self, path: &PathBuf) {
        let watching = self.entries.get(path).is_some_and(|entry| entry.watching);
        if let Some(entry) = self.entries.get_mut(path) { entry.cancel.cancel(); entry.due = None; entry.dirty = false; entry.watching = false; }
        if watching {
            if let Some(watcher) = &mut self.watcher {
                if let Err(error) = watcher.unwatch(path) { self.record_cleanup(error); }
            }
        }
    }
    fn fail(&mut self, path: &PathBuf, error: &str) {
        self.detach(path);
        if let Some(entry) = self.entries.get_mut(path) { entry.revision = entry.revision.wrapping_add(1); entry.error = Some(error.into()); entry.result = None; }
        self.queue_publish();
    }
    fn signal(&mut self, signal: Signal) {
        let Some(entry) = self.entries.get_mut(&signal.path).filter(|entry| entry.revision == signal.revision && entry.watching) else { return; };
        if signal.invalid { self.fail(&signal.path, "会话文件被移动、替换或删除，等待下一次进程发现重新确认"); return; }
        entry.dirty = true;
        if !entry.reading { entry.due.get_or_insert_with(|| Instant::now() + COALESCE); }
    }
    fn attach(&mut self, path: &PathBuf) {
        let Some(entry) = self.entries.get_mut(path) else { return; };
        self.revision = self.revision.wrapping_add(1); entry.revision = self.revision;
        entry.cancel = self.cancel.child_token(); entry.error = None; entry.result = None;
        let watched = self.watcher.as_mut().expect("watcher during run").watch(path, entry.revision, &entry.session.identity);
        match watched {
            Err(error) => { entry.error = Some(format!("会话监听失败（{}）", error.code)); entry.watching = false; },
            Ok(()) => { entry.watching = true; entry.dirty = true; entry.due = Some(Instant::now() + COALESCE); },
        }
        self.watch_peak = self.watch_peak.max(self.watcher.as_ref().map(FileWatcher::len).unwrap_or(0));
    }
    fn start_reads(&mut self) {
        let now = Instant::now();
        for (path, entry) in &mut self.entries {
            if self.reads.len() >= MAX_READS { break; }
            if !entry.watching || entry.reading || entry.due.is_none_or(|due| due > now) { continue; }
            entry.due = None; entry.dirty = false; entry.reading = true;
            let mut reader = entry.reader.take().unwrap_or_default(); let io = self.io.clone();
            let path = path.clone(); let revision = entry.revision; let identity = entry.session.identity.clone(); let cancel = entry.cancel.clone();
            self.reads.push(Box::pin(async move { let result = reader.read(&io, &path, &identity, &cancel).await; Completed { path, revision, reader, result } }));
        }
    }
    fn complete(&mut self, completed: Completed) {
        let Completed { path, revision, reader, result } = completed;
        if let Err(error) = &result { if error.is_cleanup() { self.record_cleanup(error.clone()); } }
        let Some(entry) = self.entries.get_mut(&path) else { return; };
        entry.reading = false; entry.reader = Some(reader);
        if entry.revision != revision || entry.cancel.is_cancelled() { return; }
        match result {
            Ok(result) => {
                let changed = entry.result.as_ref().is_none_or(|old| old.activity != result.activity || old.issues != result.issues);
                entry.result = Some(result);
                if entry.dirty { entry.due.get_or_insert_with(|| Instant::now() + COALESCE); }
                if changed { self.queue_publish(); }
            },
            Err(error) if error.is_cancelled() => (),
            Err(error) => self.fail(&path, &format!("会话读取失败（{}）", error.code)),
        }
    }
    async fn reconcile(&mut self, discovery: Discovery, operation: &CancellationToken) -> Result<AgentSnapshot> {
        self.published.lock().expect("published identity lock").invalidate();
        check_cancel(operation)?; check_cancel(&self.cancel)?;
        if self.watcher.is_none() { self.watcher = Some(FileWatcher::new()?); }
        let desired: BTreeMap<_, _> = discovery.sessions.iter().take(MAX_SESSIONS).map(|s| (s.file.clone(), s)).collect();
        let removed: Vec<_> = self.entries.iter().filter(|(path, entry)| {
            desired.get(*path).is_none_or(|new| new.id != entry.session.id || !new.identity.same_file(&entry.session.identity)) ||
                self.base.as_ref().is_some_and(|old| old.snapshot.agents.iter().filter(|a| a.session_id.as_ref() == Some(&entry.session.id)).any(|a| old.identities.get(&a.pid) != discovery.identities.get(&a.pid)))
        }).map(|(path, _)| path.clone()).collect();
        for path in &removed { self.detach(path); if let Some(entry) = self.entries.get_mut(path) { entry.revision = entry.revision.wrapping_add(1); entry.result = None; } }
        // Never admit replacement watch/read lanes before retired readers have actually settled.
        while self.entries.iter().any(|(path, entry)| removed.contains(path) && entry.reading) {
            if let Some(completed) = self.reads.next().await { self.complete(completed); } else { break; }
        }
        for path in removed { self.entries.remove(&path); }
        check_cancel(operation)?; check_cancel(&self.cancel)?;
        for session in discovery.sessions.iter().take(MAX_SESSIONS) {
            let path = session.file.clone();
            self.entries.entry(path.clone()).or_insert_with(|| Entry { session: session.clone(), revision: 0, reader: Some(ActivityReader::default()), result: None, error: None, watching: false, reading: false, due: None, dirty: false, cancel: self.cancel.child_token() });
            if !self.entries[&path].watching && !self.entries[&path].reading { self.attach(&path); }
        }
        check_cancel(operation)?; check_cancel(&self.cancel)?;
        self.base_cancel = operation.clone();
        self.base = Some(discovery);
        self.published.lock().expect("published identity lock").pending = false;
        self.project().ok_or_else(|| Error::new("OC_AGENT_STATE", "缺少已确认发现快照"))
    }
    fn project(&self) -> Option<AgentSnapshot> {
        let discovery = self.base.as_ref()?; let mut snapshot = discovery.snapshot.clone();
        let now = chrono::Utc::now().timestamp_millis();
        snapshot.agents.retain(|agent| discovery.identities.get(&agent.pid).is_some_and(|identity| identity.matches_live()));
        let mut observed = 0; let mut unsupported = 0; let mut incomplete = 0; let mut errors = 0; let mut watching = 0;
        let mut issues = std::collections::BTreeSet::new();
        for agent in &mut snapshot.agents {
            agent.activity = None;
            let entry = agent.session_id.as_ref().and_then(|id| self.entries.values().find(|entry| &entry.session.id == id));
            if let Some(entry) = entry {
                if entry.error.is_none() { agent.activity = entry.result.as_ref().and_then(|result| result.activity.as_ref()).filter(|activity| time(&activity.observed_at).is_some_and(|then| now >= then && now - then < AGENT_ACTIVITY_WINDOW_MS)).cloned(); }
            } else { unsupported += 1; }
            if agent.activity.is_some() { observed += 1; }
        }
        for entry in self.entries.values() {
            if entry.watching { watching += 1; }
            if let Some(error) = &entry.error { errors += 1; issues.insert(error.clone()); }
            else if let Some(result) = &entry.result {
                if !result.issues.is_empty() { incomplete += 1; }
                for issue in &result.issues { if issue.contains("截断") || issue.contains("替换") || issue.contains("失败") { errors += 1; } issues.insert(issue.clone()); }
            } else { incomplete += 1; issues.insert("已订阅，等待首次增量读取".into()); }
        }
        snapshot.active_subagent_count = if snapshot.agents.is_empty() { Some(0) } else { None };
        snapshot.sources.retain(|s| s.id != "agent-activity");
        snapshot.sources.push(SourceStatus::new("agent-activity", "会话事件订阅", if errors > 0 { SourceState::Error } else if incomplete > 0 || unsupported > 0 { SourceState::Partial } else if watching > 0 { SourceState::Ok } else { SourceState::Empty },
            format!("监听 {watching}/{} 个当前OMP会话；watch FD当前{}、峰值{}、上限128，另有{}个kqueue FD，与瞬时文件IO的8槽分开统计。内核按注册合并事件，每次最多32条，待读会话最多128、同时读取最多8。90ms首事件合批、16ms首完成发布、6s过期。单文件128KiB；{observed} 个近期调用，{unsupported} 个进程无支持来源。完成/取消/错误清除，不改变忙闲或推算活动数量。监听失败在正常发现时重挂，无轮询兜底。{}", self.entries.len(), self.watcher.as_ref().map(FileWatcher::len).unwrap_or(0), self.watch_peak, usize::from(self.watcher.is_some()), issues.into_iter().collect::<Vec<_>>().join("；"))));
        snapshot.collected_at = timestamp(); Some(snapshot)
    }
    fn emit(&mut self) {
        self.publish_due = None;
        if self.cancel.is_cancelled() { return; }
        if let Some(snapshot) = self.project() {
            let mut published = self.published.lock().expect("published identity lock");
            if !published.pending {
                published.identities.clear();
                if let Some(base) = &self.base {
                    for agent in &snapshot.agents { if let Some(identity) = base.identities.get(&agent.pid) { published.identities.insert(agent.id.clone(), identity.clone()); } }
                }
            }
            drop(published);
            (self.publish)(Ok(snapshot));
        }
        let now = chrono::Utc::now().timestamp_millis();
        for entry in self.entries.values_mut() {
            if let Some(result) = entry.result.as_mut() { if result.activity.as_ref().is_some_and(|activity| time(&activity.observed_at).is_none_or(|then| now < then || now - then >= AGENT_ACTIVITY_WINDOW_MS)) { result.activity = None; } }
        }
    }
    fn deadline(&self) -> Instant {
        let now = Instant::now(); let wall = chrono::Utc::now().timestamp_millis();
        let expiry = self.entries.values().filter_map(|entry| entry.result.as_ref()?.activity.as_ref()).filter_map(|activity| time(&activity.observed_at)).map(|then| now + Duration::from_millis((then + AGENT_ACTIVITY_WINDOW_MS - wall).max(0) as u64)).min();
        self.entries.values().filter_map(|entry| if self.reads.len() < MAX_READS { entry.due } else { None }).chain(self.publish_due).chain(expiry).min().unwrap_or(now + Duration::from_secs(86400))
    }
    async fn clear_snapshot(&mut self) {
        self.published.lock().expect("published identity lock").invalidate();
        let paths: Vec<_> = self.entries.keys().cloned().collect();
        for path in paths { self.detach(&path); }
        while let Some(completed) = self.reads.next().await { self.complete(completed); }
        self.entries.clear(); self.base = None; self.publish_due = None;
        self.base_cancel = CancellationToken::new();
    }
    async fn close(&mut self) -> Result<()> {
        self.cancel.cancel();
        self.clear_snapshot().await;
        if let Some(watcher) = self.watcher.take() { if let Err(error) = watcher.close() { self.record_cleanup(error); } }
        if self.cleanup.is_empty() { Ok(()) } else { Err(Error::aggregate(std::mem::take(&mut self.cleanup))) }
    }
}

pub(super) async fn run(io: BoundedIo, publish: Arc<dyn Fn(Result<AgentSnapshot>) + Send + Sync>, mut receiver: mpsc::Receiver<Reconcile>, cancel: CancellationToken, io_cancel: CancellationToken, published: Arc<StdMutex<super::Published>>, ready: oneshot::Sender<Result<()>>) -> Result<()> {
    let watcher = match FileWatcher::new() { Ok(watcher) => watcher, Err(error) => { let _ = ready.send(Err(error.clone())); return Err(error); } };
    let mut actor = Actor { io, publish, cancel: cancel.clone(), entries: BTreeMap::new(), base: None, watcher: Some(watcher), watch_peak: 0,
        reads: FuturesUnordered::new(), revision: 0, publish_due: None, cleanup: Vec::new(), published, base_cancel: CancellationToken::new() };
    let _ = ready.send(Ok(()));
    loop {
        let deadline = actor.deadline();
        let base_cancel = actor.base_cancel.clone();
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            _ = io_cancel.cancelled() => { cancel.cancel(); break; },
            _ = base_cancel.cancelled() => actor.clear_snapshot().await,
            _ = tokio::time::sleep_until(deadline) => {
                actor.start_reads();
                let now = chrono::Utc::now().timestamp_millis();
                let expired = actor.entries.values().any(|entry| entry.result.as_ref().and_then(|result| result.activity.as_ref()).is_some_and(|a| time(&a.observed_at).is_none_or(|then| now < then || now - then >= AGENT_ACTIVITY_WINDOW_MS)));
                if actor.publish_due.is_some_and(|due| due <= Instant::now()) || expired { actor.emit(); }
            },
            Some(message) = receiver.recv() => {
                let result = actor.reconcile(message.discovery, &message.cancel).await;
                if result.is_ok() { actor.queue_publish(); } else { actor.clear_snapshot().await; }
                let _ = message.reply.send(result);
            },
            Some(completed) = actor.reads.next(), if !actor.reads.is_empty() => { actor.complete(completed); actor.start_reads(); },
            signals = async { actor.watcher.as_ref().expect("active watcher").next().await }, if actor.watcher.is_some() => {
                match signals {
                    Ok(signals) => { for signal in signals { actor.signal(signal); } },
                    Err(error) => {
                        let paths: Vec<_> = actor.entries.keys().cloned().collect();
                        for path in paths { actor.fail(&path, &format!("会话通知失败（{}），等待正常发现重新确认", error.code)); }
                        if let Some(watcher) = actor.watcher.take() { if let Err(cleanup) = watcher.close() { actor.record_cleanup(cleanup); } }
                        (actor.publish)(Err(error));
                    },
                }
            },
        }
    }
    receiver.close();
    while let Ok(message) = receiver.try_recv() { let _ = message.reply.send(Err(Error::cancelled())); }
    actor.close().await
}
