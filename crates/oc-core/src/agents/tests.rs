use std::{collections::{BTreeMap, BTreeSet}, io::Write, path::{Path, PathBuf}, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use crate::{error::{Result, timestamp}, io::{BoundedIo, FileIdentity}, model::{AgentInfo, AgentKind, AgentSnapshot, AgentState, SourceState}, process::ProcessIdentity, resources::{ResourceBudget, ResourceLimits, Request, Outcome}};
use super::{AgentCollector, AgentPaths, activity::{ActivityReader, ActivityState, TAIL_BYTES}, discovery::Discovery, live, runtime::{self, ProcessRow}, sessions::{self, Session, CodexSession, OpenFiles}};

const ROOT: &str = "01a10000-0000-7000-8000-000000000001";
const CHILD: &str = "01a10000-0000-7000-8000-000000000002";
const GRANDCHILD: &str = "01a10000-0000-7000-8000-000000000003";
fn io() -> BoundedIo { BoundedIo::new(ResourceBudget::default()) }
fn identity(path: &Path) -> FileIdentity { FileIdentity::from_metadata(&std::fs::metadata(path).unwrap()) }
fn row(pid: u32, ppid: u32, executable: &str, args: &str) -> ProcessRow { ProcessRow { pid, ppid, executable: executable.into(), args: args.into(), cpu: 2.0, memory: 4096 } }
fn process(pid: u32, runtime: &str) -> AgentInfo {
    AgentInfo { id: format!("process:{pid}"), name: runtime.into(), summary: None, runtime: runtime.into(), kind: AgentKind::Main, state: AgentState::Running, activity: None, pid, parent_id: None, model: None, cwd: None, session_id: None, tern: None, cpu_percent: Some(2.0), memory_bytes: Some(4096), started_at: None, source: "fixture process".into() }
}
fn tool(name: &str, stamp: &str) -> Vec<u8> { let mut bytes = serde_json::to_vec(&serde_json::json!({"type":"custom","customType":"tool_execution_start","timestamp":stamp,"data":{"toolCallId":"call_1","toolName":name,"arguments":{"secret":"PRIVATE"}}})).unwrap(); bytes.push(b'\n'); bytes }
fn append(path: &Path, bytes: &[u8]) { let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap(); file.write_all(bytes).unwrap(); file.sync_all().unwrap(); }
fn session(file: &Path, id: &str) -> Session { Session { id: id.into(), file: file.into(), summary: None, cwd: None, parent: None, started_at: None, model: None, identity: identity(file) } }
fn rollout(directory: &Path, id: &str) -> PathBuf { directory.join("sessions/2026/11/06").join(format!("rollout-2026-11-06T00-00-00-{id}.jsonl")) }
fn codex_record(id: &str, parent: Option<&str>) -> Vec<u8> {
    let source = match parent { Some(parent) => serde_json::json!({"subagent":{"thread_spawn":{"parent_thread_id":parent,"agent_nickname":"Explorer"}}}), None => serde_json::json!("cli") };
    let mut bytes = serde_json::to_vec(&serde_json::json!({"type":"session_meta","payload":{"id":id,"source":source,"cwd":"/project","base_instructions":{"text":"PRIVATE"}}})).unwrap(); bytes.push(b'\n'); bytes
}

#[test]
fn ordinary_source_failures_preserve_detail_without_launchd_diagnostics() {
    let operation = "Tern inspect 不可用，保留 PID 活性";
    let error = crate::error::Error::new("OC_COMMAND_FAILED", "inspect failed");
    let source = super::discovery::failure_source("tern-state", "Tern 主代理状态", operation, &error);
    assert_eq!(source.state, SourceState::Error);
    assert_eq!(source.detail, format!("{operation}（OC_COMMAND_FAILED）；没有推测缺失数据。"));
    assert!(source.diagnostics.is_none());
    let wire = serde_json::to_value(&source).unwrap();
    assert!(wire.get("diagnostics").is_none());
    assert_eq!(serde_json::from_value::<crate::model::SourceStatus>(wire).unwrap(), source);
}

#[test]
fn runtime_classification_keeps_prompts_out_of_command_matching() {
    for (exe, args) in [("/bin/zsh", "zsh -c omp --model foo"), ("/usr/bin/grep", "grep codex"), ("/opt/bin/node", "node /tmp/codex.js"), ("/opt/bin/omp", "omp __omp_worker_eval"), ("/opt/bin/claude", "claude --model best mcp serve"), ("/opt/bin/opencode", "opencode serve")] { assert!(runtime::identify(&row(1, 0, exe, args)).is_none(), "{exe}"); }
    assert!(runtime::identify(&row(1, 0, "/opt/bin/codex", "codex -m app-server Explain this")).is_some());
    assert!(runtime::identify(&row(1, 0, "/opt/bin/omp", "omp --print collab")).is_some());
    assert!(runtime::identify(&row(1, 0, "/opt/bin/codex", "codex -c description=\"app-server service\" app-server")).unwrap().host);
    assert_eq!(runtime::identify(&row(1, 0, "/opt/bin/node", "node /lib/@anthropic-ai/claude-code/cli.js")).unwrap().name, "Claude Code");
}
#[test]
fn wrappers_merge_and_ancestry_crosses_shell_without_self_parent() {
    let rows = vec![row(10, 1, "/opt/bin/node", "node /lib/@openai/codex/bin/codex.js"), row(11, 10, "/opt/bin/codex", "codex"), row(20, 11, "/bin/zsh", "zsh"), row(30, 20, "/opt/bin/omp", "omp")];
    let live: BTreeMap<_, _> = [10,11,30].into_iter().map(|pid| (pid, ProcessIdentity { pid, start_seconds: 100, start_microseconds: 0, process_group: pid })).collect();
    let (agents, _) = runtime::process_agents(&rows, &live);
    assert_eq!(agents.len(), 2); assert_eq!(agents[0].pid, 11); assert_eq!(agents[0].parent_id, None); assert_eq!(agents[1].parent_id.as_deref(), Some("process:11"));
}
#[test]
fn activity_whitelist_terminal_events_and_ttl() {
    let now = chrono::Utc::now().timestamp_millis(); let stamp = timestamp(); let mut state = ActivityState::default();
    state.consume(&tool("read", &stamp), now + 100).unwrap();
    let activity = state.recent(now + 100).unwrap(); assert_eq!(activity.name.as_deref(), Some("read"));
    assert!(!serde_json::to_string(&activity).unwrap().contains("PRIVATE"));
    assert!(state.recent(now + 6200).is_none());
    for reason in ["stop", "length", "abort", "aborted", "error"] {
        state.consume(&tool("read", &stamp), now + 100).unwrap();
        state.consume(&serde_json::to_vec(&serde_json::json!({"type":"message","message":{"role":"assistant","stopReason":reason,"content":"PRIVATE"}})).unwrap(), now + 100).unwrap();
        assert!(state.recent(now + 100).is_none());
    }
    for index in 0..32 {
        let record = serde_json::json!({"type":"custom","customType":"tool_execution_start","timestamp":stamp,"data":{"toolCallId":format!("call_{index}"),"toolName":"read"}});
        state.consume(&serde_json::to_vec(&record).unwrap(), now + 100).unwrap();
    }
    let extra = serde_json::json!({"type":"custom","customType":"tool_execution_start","timestamp":stamp,"data":{"toolCallId":"overflow","toolName":"read"}});
    assert_eq!(state.consume(&serde_json::to_vec(&extra).unwrap(), now + 100).unwrap_err().code, "OC_COLLECTION_LIMIT"); assert!(state.recent(now + 100).is_none());
}
#[tokio::test]
async fn chunked_long_lines_and_incomplete_tail_never_show_stale_activity() {
    let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("session.jsonl");
    let large = serde_json::json!({"type":"message","message":{"role":"user","content":"私".repeat(20_000)}});
    let mut bytes = serde_json::to_vec(&large).unwrap(); bytes.push(b'\n'); bytes.extend(tool("read", &timestamp()));
    std::fs::write(&path, bytes).unwrap(); let expected = identity(&path); let io = io(); let cancel = CancellationToken::new(); let mut reader = ActivityReader::default();
    let result = reader.read(&io, &path, &expected, &cancel).await.unwrap(); assert_eq!(result.activity.unwrap().name.as_deref(), Some("read")); assert!(result.bytes_read > 16 * 1024); assert!(result.bytes_read <= TAIL_BYTES);
    append(&path, b"{\"type\":\"message\",\"message\":");
    let result = reader.read(&io, &path, &expected, &cancel).await.unwrap(); assert!(result.activity.is_none()); assert!(!result.issues.is_empty());
    append(&path, b"{\"role\":\"assistant\",\"stopReason\":\"stop\"}}\n");
    assert!(reader.read(&io, &path, &expected, &cancel).await.unwrap().activity.is_none());
    append(&path, &tool("write", &timestamp())); assert_eq!(reader.read(&io, &path, &expected, &cancel).await.unwrap().activity.unwrap().name.as_deref(), Some("write"));
    std::fs::write(&path, tool("truncated", &timestamp())).unwrap();
    let reset = reader.read(&io, &path, &expected, &cancel).await.unwrap(); assert!(reset.activity.is_none()); assert!(reset.issues.contains("文件被截断或替换"));
    let next = directory.path().join("replacement"); std::fs::write(&next, tool("replacement", &timestamp())).unwrap(); std::fs::rename(&next, &path).unwrap();
    assert_eq!(reader.read(&io, &path, &expected, &cancel).await.unwrap_err().code, "OC_COLLECTION_CHANGED");
    io.shutdown().await.unwrap();
}
#[tokio::test]
async fn enormous_tail_and_header_are_bounded_and_release_budget() {
    let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("large.jsonl");
    std::fs::write(&path, vec![b'x'; TAIL_BYTES * 8]).unwrap(); let io = io(); let cancel = CancellationToken::new();
    let result = ActivityReader::default().read(&io, &path, &identity(&path), &cancel).await.unwrap(); assert_eq!(result.bytes_read, TAIL_BYTES); assert!(result.activity.is_none()); assert!(!result.issues.is_empty());
    append(&path,b"\n");append(&path,&tool("recent",&timestamp()));
    let recent=ActivityReader::default().read(&io,&path,&identity(&path),&cancel).await.unwrap();assert_eq!(recent.activity.unwrap().name.as_deref(),Some("recent"));assert_eq!(recent.issues,BTreeSet::from(["尾部窗口之前的记录未读取".into()]));
    let path = rollout(directory.path(), ROOT); std::fs::create_dir_all(path.parent().unwrap()).unwrap(); std::fs::write(&path, vec![b'x'; 1024 * 1024 + 100]).unwrap();
    assert_eq!(sessions::read_codex(&io, &path, &cancel).await.unwrap_err().code, "OC_COLLECTION_LIMIT");
    std::fs::write(&path, b"{\"type\":\"session_meta\"").unwrap(); assert_eq!(sessions::read_codex(&io, &path, &cancel).await.unwrap_err().code, "INCOMPLETE_HEADER");
    assert_eq!(io.resources().snapshot().global.current.files, 0); assert_eq!(io.resources().snapshot().global.current.queued, 0); io.shutdown().await.unwrap();
}
#[tokio::test]
async fn codex_multilevel_identity_ambiguity_and_global_allowance() {
    let directory = tempfile::tempdir().unwrap(); let root = rollout(directory.path(), ROOT); let child = rollout(directory.path(), CHILD); let grandchild = rollout(directory.path(), GRANDCHILD);
    std::fs::create_dir_all(root.parent().unwrap()).unwrap();
    for (path, id, parent) in [(&root, ROOT, None), (&child, CHILD, Some(ROOT)), (&grandchild, GRANDCHILD, Some(CHILD))] { std::fs::write(path, codex_record(id, parent)).unwrap(); }
    let io = io(); let cancel = CancellationToken::new(); let processes = vec![process(40, "Codex")]; let descriptors = vec![OpenFiles { pid: 40, codex: vec![root.clone(), child.clone(), grandchild], ..Default::default() }];
    let (agents, source) = sessions::collect_codex(&io, processes.clone(), &descriptors, &BTreeSet::from([40]), 128, &cancel).await.unwrap();
    assert_eq!(source.state, SourceState::Ok); assert_eq!(agents.len(), 3);
    let nested = agents.iter().find(|a| a.session_id.as_deref() == Some(GRANDCHILD)).unwrap(); assert_eq!(nested.parent_id.as_deref(), Some(format!("codex:{CHILD}").as_str())); assert_eq!(nested.memory_bytes, None); assert_eq!(nested.state, AgentState::Unknown);
    let (limited, source) = sessions::collect_codex(&io, processes.clone(), &descriptors, &BTreeSet::new(), 1, &cancel).await.unwrap(); assert_eq!(limited.len(), 1); assert_eq!(source.state, SourceState::Partial); assert!(source.detail.contains("SESSION_LIMIT"));
    let (released, _) = sessions::collect_codex(&io, processes.clone(), &[], &BTreeSet::from([40]), 128, &cancel).await.unwrap(); assert!(released.is_empty());
    let mut duplicate = descriptors.clone(); duplicate.push(OpenFiles { pid: 41, codex: vec![root], ..Default::default() });
    let (_, source) = sessions::collect_codex(&io, vec![process(40,"Codex"), process(41,"Codex")], &duplicate, &BTreeSet::new(), 128, &cancel).await.unwrap(); assert!(source.detail.contains("AMBIGUOUS_OWNER"));
    assert!(sessions::parse_codex(&codex_record(ROOT, None), &child).is_err());
    io.shutdown().await.unwrap();
}
#[test]
fn writable_rollouts_and_omp_task_paths_are_evidence() {
    let root = PathBuf::from("/test"); let paths = AgentPaths::for_home(root.clone()); let file = rollout(&root, ROOT);
    let output = format!("p40\nf3\nar\nn{}\nf4\naw\nn{}\n", file.display(), file.display());
    assert_eq!(sessions::parse_open_files(&output, &paths).unwrap()[0].codex, vec![file]);
    let oversized = format!("p40\nf3\naw\nn{}\n", "x".repeat(4097)); assert_eq!(sessions::parse_open_files(&oversized, &paths).unwrap_err().code, "OC_COLLECTION_LIMIT");
    let directory = tempfile::tempdir().unwrap(); let main = directory.path().join("main.jsonl"); let child = directory.path().join("main/Worker.jsonl"); let fork = directory.path().join("fork.jsonl");
    std::fs::create_dir_all(child.parent().unwrap()).unwrap(); for path in [&main,&child,&fork] { std::fs::write(path, b"").unwrap(); }
    let mut task = session(&child, CHILD); task.parent = Some("source-fork".into()); let mut branch = session(&fork, GRANDCHILD); branch.parent = Some(main.to_string_lossy().into());
    let agents = sessions::owned_omp(vec![process(40,"OMP")], &[OpenFiles { pid:40, sessions:vec![main.clone(), child.clone(), fork.clone()], leases:BTreeSet::from([ROOT.into(),CHILD.into(),GRANDCHILD.into()]), ..Default::default() }], &[session(&main,ROOT),task,branch]);
    let task = agents.iter().find(|a| a.session_id.as_deref()==Some(CHILD)).unwrap(); assert_eq!(task.parent_id.as_deref(),Some(format!("omp:{ROOT}").as_str())); assert_eq!(task.state,AgentState::Unknown); assert!(task.memory_bytes.is_none());
    assert_eq!(agents.iter().find(|a| a.session_id.as_deref()==Some(GRANDCHILD)).unwrap().kind,AgentKind::Main);
}

#[test]
fn omp_session_header_exports_whitelist_and_preserves_fork_identity() {
    let child = PathBuf::from("/sessions/main/Worker.jsonl");
    let mut bytes = "{\"type\":\"title\",\"v\":1,\"title\":\"\u{f06a9} AGENT: 简短摘要\"}\n".as_bytes().to_vec();
    bytes.extend(format!("{{\"type\":\"session\",\"id\":\"{CHILD}\",\"timestamp\":\"2026-11-02T03:47:55.457Z\",\"cwd\":\"/project\",\"parentSession\":\"/sessions/main.jsonl\",\"secret\":\"PRIVATE\"}}\n").as_bytes());
    bytes.extend(b"{\"type\":\"model_change\",\"model\":\"provider/model\",\"providerPayload\":\"PRIVATE\"}\n");
    bytes.extend(serde_json::to_vec(&serde_json::json!({"type":"message","message":{"role":"user","content":"private prompt"}})).unwrap()); bytes.push(b'\n');
    let parsed = sessions::parse_omp(&bytes, child, identity(&std::env::temp_dir())).unwrap();
    assert_eq!(parsed.id, CHILD); assert_eq!(parsed.summary.as_deref(), Some("AGENT: 简短摘要")); assert_eq!(parsed.cwd.as_deref(), Some("/project")); assert_eq!(parsed.model.as_deref(), Some("provider/model")); assert_eq!(parsed.parent.as_deref(), Some("/sessions/main.jsonl"));
    let mut broken = b"{\"type\":\"session\",\"id\":\"bad-id\"}\n".to_vec();
    assert!(sessions::parse_omp(&broken, PathBuf::from("/s/x.jsonl"), identity(&std::env::temp_dir())).is_err()); broken.clear();
    assert!(sessions::parse_omp(&broken, PathBuf::from("/s/x.jsonl"), identity(&std::env::temp_dir())).is_err());
    for title in [serde_json::json!(""), serde_json::json!("omp"), serde_json::json!("   "), serde_json::json!("a".repeat(513)), serde_json::json!("bad\nlabel"), serde_json::json!(42)] {
        let bytes = format!("{{\"type\":\"title\",\"v\":1,\"title\":{title}}}\n{{\"type\":\"session\",\"id\":\"{ROOT}\",\"title\":\"Outdated title\"}}\n");
        assert!(sessions::parse_omp(bytes.as_bytes(), PathBuf::from("/s/x.jsonl"), identity(&std::env::temp_dir())).unwrap().summary.is_none());
    }
}

struct LiveFixture { io: BoundedIo, cancel: CancellationToken, sender: mpsc::Sender<live::Reconcile>, events: mpsc::Receiver<Result<AgentSnapshot>>, task: tokio::task::JoinHandle<Result<()>> }
impl LiveFixture {
    async fn new(io: BoundedIo) -> Self {
        let (events_tx, events) = mpsc::channel(1024); let (sender, receiver) = mpsc::channel(1); let (ready_tx, ready_rx) = oneshot::channel(); let cancel = CancellationToken::new();
        let publish = Arc::new(move |result| { events_tx.try_send(result).expect("bounded test observations"); });
        let task = tokio::spawn(live::run(io.clone(), publish, receiver, cancel.clone(), io.cancellation(), Arc::new(std::sync::Mutex::new(super::Published::default())), ready_tx)); ready_rx.await.unwrap().unwrap();
        Self { io, cancel, sender, events, task }
    }
    async fn reconcile(&self, discovery: Discovery) -> AgentSnapshot { let (reply,result)=oneshot::channel(); self.sender.send(live::Reconcile { discovery,cancel:self.cancel.child_token(),reply }).await.unwrap(); result.await.unwrap().unwrap() }
    async fn next(&mut self, predicate: impl Fn(&AgentSnapshot)->bool) -> AgentSnapshot {
        tokio::time::timeout(Duration::from_secs(5), async { loop { let event=self.events.recv().await.expect("actor alive").unwrap(); if predicate(&event) { return event; } } }).await.expect("expected observable snapshot")
    }
    async fn close(self) { self.cancel.cancel(); self.task.await.unwrap().unwrap(); assert_eq!(self.io.resources().snapshot().global.current.files,0); assert_eq!(self.io.resources().snapshot().global.current.queued,0); }
}
fn discovery(paths: &[PathBuf]) -> Discovery {
    let identity=ProcessIdentity::read(std::process::id()).unwrap();
    let mut agents=Vec::new(); let mut sessions=Vec::new();
    for (index,path) in paths.iter().enumerate() { let id=format!("session-{index}"); let mut agent=process(identity.pid,"OMP"); agent.id=format!("omp:{id}"); agent.session_id=Some(id.clone()); agent.started_at=Some(identity.started_at().unwrap()); agents.push(agent); sessions.push(session(path,&id)); }
    Discovery { snapshot:AgentSnapshot { collected_at:timestamp(),active_subagent_count:if agents.is_empty(){Some(0)}else{None},agents,sources:Vec::new() },sessions,identities:BTreeMap::from([(identity.pid,identity)]) }
}
#[tokio::test]
async fn real_watch_publishes_start_terminal_expiry_and_deletion() {
    let directory=tempfile::tempdir().unwrap(); let path=directory.path().join("session.jsonl"); std::fs::write(&path,b"").unwrap(); let mut live=LiveFixture::new(io()).await;
    live.reconcile(discovery(std::slice::from_ref(&path))).await;
    append(&path,&tool("read",&timestamp())); live.next(|s|s.agents.iter().any(|a|a.activity.is_some())).await;
    append(&path,b"{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\"}}\n"); live.next(|s|s.agents.iter().all(|a|a.activity.is_none()) && s.sources.last().unwrap().state==SourceState::Ok).await;
    let past=(chrono::Utc::now()-chrono::Duration::milliseconds(4500)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true); append(&path,&tool("expires",&past));
    live.next(|s|s.agents.iter().any(|a|a.activity.is_some())).await; live.next(|s|s.agents.iter().all(|a|a.activity.is_none())).await;
    std::fs::remove_file(&path).unwrap(); live.next(|s|s.sources.last().unwrap().state==SourceState::Error).await;
    live.reconcile(discovery(&[])).await; live.next(|s|s.agents.is_empty()).await; live.close().await;
}
#[tokio::test]
async fn removed_session_cancels_queued_read_and_never_publishes_late_result() {
    let directory=tempfile::tempdir().unwrap(); let path=directory.path().join("pending.jsonl"); std::fs::write(&path,tool("late",&timestamp())).unwrap();
    let budget=ResourceBudget::new(ResourceLimits { files:1,..ResourceLimits::default() }).unwrap(); let io=BoundedIo::new(budget.clone());
    let held=budget.acquire("fixture",Request::File { bytes:1 },&CancellationToken::new()).await.unwrap(); let mut live=LiveFixture::new(io).await;
    live.reconcile(discovery(std::slice::from_ref(&path))).await;
    tokio::time::timeout(Duration::from_secs(3),async { while budget.snapshot().global.current.queued==0 { tokio::task::yield_now().await; } }).await.unwrap();
    let empty=live.reconcile(discovery(&[])).await; assert!(empty.agents.is_empty()); assert_eq!(budget.snapshot().global.current.queued,0);
    held.finish(Outcome::Completed); live.next(|s|s.agents.is_empty()).await;
    while let Ok(event)=live.events.try_recv(){assert!(event.unwrap().agents.iter().all(|a|a.activity.is_none()));}
    live.close().await;
}
#[tokio::test]
async fn process_birth_reuse_revokes_session_and_old_activity() {
    let directory=tempfile::tempdir().unwrap();let path=directory.path().join("identity.jsonl");std::fs::write(&path,tool("old",&timestamp())).unwrap();let mut live=LiveFixture::new(io()).await;
    live.reconcile(discovery(std::slice::from_ref(&path))).await;live.next(|s|s.agents.iter().any(|a|a.activity.is_some())).await;
    let mut reused=discovery(std::slice::from_ref(&path)); reused.identities.values_mut().next().unwrap().start_seconds+=1;
    let snapshot=live.reconcile(reused).await;assert!(snapshot.agents.is_empty());live.next(|s|s.agents.is_empty()).await;live.close().await;
}
#[tokio::test]
async fn repeated_watch_lifetimes_and_public_start_stop_drain() {
    let directory=tempfile::tempdir().unwrap(); let path=directory.path().join("cycle.jsonl");std::fs::write(&path,b"").unwrap();let io=io();
    for _ in 0..100 { let live=LiveFixture::new(io.clone()).await;live.reconcile(discovery(std::slice::from_ref(&path))).await;live.close().await; }
    let collector=AgentCollector::new(io.clone(),directory.path().into(),Arc::new(|_|{}));
    for _ in 0..10 { let parent=CancellationToken::new();collector.start(parent.clone()).await.unwrap();collector.start(parent.clone()).await.unwrap();parent.cancel();collector.stop().await.unwrap();collector.stop().await.unwrap(); }
    io.shutdown().await.unwrap();
}

#[test]
fn codex_forks_and_missing_parents_do_not_invent_relations() {
    let session = |id: &str, parent: Option<&str>, subagent| CodexSession { id:id.into(),parent:parent.map(str::to_owned),subagent,name:None,cwd:None,started_at:Some("2026-11-01T00:00:00Z".into()) };
    let mut child_process = process(41,"Codex");child_process.parent_id=Some("process:40".into());child_process.kind=AgentKind::Subagent;
    let sessions = BTreeMap::from([(ROOT.into(),(session(ROOT,None,false),40)),(CHILD.into(),(session(CHILD,Some(ROOT),true),41)),(GRANDCHILD.into(),(session(GRANDCHILD,None,false),40))]);
    let agents = sessions::project_codex(vec![process(40,"Codex"),child_process],&sessions,&BTreeSet::new());
    assert_eq!(agents.iter().find(|a|a.session_id.as_deref()==Some(GRANDCHILD)).unwrap().parent_id,None);
    assert_eq!(agents.iter().filter(|a|a.pid==40).filter(|a|a.memory_bytes.is_some()).count(),0);
    assert_eq!(agents.iter().find(|a|a.session_id.as_deref()==Some(CHILD)).unwrap().parent_id.as_deref(),Some(format!("codex:{ROOT}").as_str()));
    let orphan = BTreeMap::from([(CHILD.into(),(session(CHILD,Some(ROOT),true),41))]);
    let orphan = sessions::project_codex(vec![process(41,"Codex")],&orphan,&BTreeSet::new());assert_eq!(orphan[0].parent_id.as_deref(),Some(format!("codex:{ROOT}").as_str()));
}

#[tokio::test]
async fn one_hundred_twenty_eight_long_sessions_keep_io_bounded() {
    let directory=tempfile::tempdir().unwrap();let mut paths=Vec::new();let payload=vec![b'x';TAIL_BYTES*2];
    for index in 0..128 { let path=directory.path().join(format!("{index}.jsonl"));std::fs::write(&path,&payload).unwrap();paths.push(path); }
    let io=io();let mut live=LiveFixture::new(io.clone()).await;live.reconcile(discovery(&paths)).await;
    let snapshot=live.next(|s|s.agents.len()==128 && s.sources.last().is_some_and(|source|!source.detail.contains("等待首次增量读取"))).await;
    assert!(snapshot.agents.iter().all(|agent|agent.activity.is_none()));assert_eq!(snapshot.sources.last().unwrap().state,SourceState::Partial);
    assert!(io.resources().snapshot().global.peak.files<=8);assert!(io.resources().snapshot().global.peak.file_bytes<=8*16*1024);
    live.close().await;io.shutdown().await.unwrap();
}

#[tokio::test]
async fn navigation_identity_only_comes_from_published_birth_identity() {
    let directory=tempfile::tempdir().unwrap();let path=directory.path().join("identity.jsonl");std::fs::write(&path,b"").unwrap();
    let (events_tx,mut events)=mpsc::channel(16);let io=io();
    let collector=AgentCollector::new(io.clone(),directory.path().into(),Arc::new(move|snapshot|{events_tx.try_send(snapshot).unwrap();}));
    collector.start(CancellationToken::new()).await.unwrap();assert_eq!(collector.process_identity("omp:session-0").await.unwrap_err().code,"OC_AGENT_IDENTITY");
    let mut sample=discovery(std::slice::from_ref(&path));sample.snapshot.agents[0].started_at=Some("2000-01-01T00:00:00Z".into());
    let tx=collector.run.lock().await.as_ref().unwrap().tx.clone();let(reply,result)=oneshot::channel();tx.send(live::Reconcile{discovery:sample,cancel:CancellationToken::new(),reply}).await.unwrap();result.await.unwrap().unwrap();
    let published=tokio::time::timeout(Duration::from_secs(3),events.recv()).await.unwrap().unwrap().unwrap();assert_eq!(published.agents[0].started_at.as_deref(),Some("2000-01-01T00:00:00Z"));
    assert_eq!(collector.process_identity("omp:session-0").await.unwrap(),ProcessIdentity::read(std::process::id()).unwrap());
    collector.published.lock().unwrap().invalidate();assert!(collector.process_identity("omp:session-0").await.is_err());
    collector.stop().await.unwrap();assert!(collector.process_identity("omp:session-0").await.is_err());io.shutdown().await.unwrap();
}

#[test]
fn tern_targets_require_exact_live_main_session_and_bounded_arrays() {
    let directory=tempfile::tempdir().unwrap();let main=directory.path().join("main.jsonl");let child=directory.path().join("child.jsonl");for path in [&main,&child]{std::fs::write(path,b"").unwrap();}
    let metadata=vec![session(&main,ROOT),session(&child,CHILD)];let mut root=process(40,"OMP");root.session_id=Some(ROOT.into());let mut nested=process(40,"OMP");nested.kind=AgentKind::Subagent;nested.state=AgentState::Unknown;nested.session_id=Some(CHILD.into());
    let mut agents=vec![root,nested];let bytes=serde_json::to_vec(&serde_json::json!({"panes":[{"pane":7,"working":true,"omp_session_file":main,"prompt":"PRIVATE"},{"pane":8,"working":true,"omp_session_file":child},{"pane":9,"working":true,"omp_session_file":"/different/main.jsonl"}]})).unwrap();
    assert_eq!(super::discovery::apply_tern(&mut agents,&metadata,&bytes,"window-1").unwrap(),1);assert_eq!(agents[0].state,AgentState::Working);assert_eq!(agents[0].tern.as_ref().unwrap().pane_id,7);assert_eq!(agents[1].state,AgentState::Unknown);assert!(!serde_json::to_string(&agents).unwrap().contains("PRIVATE"));
    let over=serde_json::to_vec(&serde_json::json!({"panes":vec![serde_json::json!({});4097]})).unwrap();assert_eq!(super::discovery::apply_tern(&mut agents,&metadata,&over,"window-1").unwrap_err().code,"OC_COLLECTION_LIMIT");
}

#[tokio::test]
async fn private_collab_socket_only_exports_whitelisted_live_metadata() {
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    let directory=tempfile::tempdir().unwrap();let paths=AgentPaths::for_home(directory.path().into());std::fs::create_dir_all(&paths.collab_hosts).unwrap();std::fs::set_permissions(&paths.collab_hosts,std::fs::Permissions::from_mode(0o700)).unwrap();
    let endpoint=directory.path().join("host.sock");let listener=tokio::net::UnixListener::bind(&endpoint).unwrap();let identity=ProcessIdentity::read(std::process::id()).unwrap();let pid=identity.pid;
    let record=paths.collab_hosts.join("host.json");std::fs::write(&record,serde_json::to_vec(&serde_json::json!({"version":1,"pid":pid,"endpoint":endpoint,"token":"fixture-secret"})).unwrap()).unwrap();std::fs::set_permissions(&record,std::fs::Permissions::from_mode(0o600)).unwrap();
    let stop=CancellationToken::new();let server_stop=stop.clone();
    let server=tokio::spawn(async move {
        let(mut stream,_)=listener.accept().await.unwrap();let mut bytes=Vec::new();let mut chunk=[0u8;1024];
        loop{let read=stream.read(&mut chunk).await.unwrap();assert!(read>0);bytes.extend_from_slice(&chunk[..read]);assert!(bytes.len()<=4096);if bytes.contains(&b'\n'){break;}}
        let request:serde_json::Value=serde_json::from_slice(&bytes).unwrap();assert_eq!(request["token"],"fixture-secret");assert_eq!(request["op"],"snapshot");
        let mut response=serde_json::to_vec(&serde_json::json!({"v":1,"ok":true,"snapshot":{"pid":pid,"sessionId":ROOT,"sessionName":"Current","cwd":"/project","busy":true,"model":{"provider":"vendor","id":"model","apiKey":"PRIVATE"},"prompt":"PRIVATE"}})).unwrap();response.push(b'\n');stream.write_all(&response).await.unwrap();server_stop.cancelled().await;
    });
    let io=io();let mut agents=vec![process(pid,"OMP")];let source=super::discovery::collab(&io,&paths,&mut agents,&BTreeMap::from([(pid,identity.clone())]),&CancellationToken::new()).await.unwrap();
    assert_eq!(source.state,SourceState::Ok,"{source:?}");assert_eq!(agents[0].name,"Current");assert_eq!(agents[0].model.as_deref(),Some("vendor/model"));assert_eq!(agents[0].state,AgentState::Working);let output=serde_json::to_string(&agents).unwrap();assert!(!output.contains("PRIVATE"));assert!(!output.contains("fixture-secret"));
    stop.cancel();server.await.unwrap();std::fs::set_permissions(&paths.collab_hosts,std::fs::Permissions::from_mode(0o755)).unwrap();
    let source=super::discovery::collab(&io,&paths,&mut agents,&BTreeMap::from([(pid,identity)]),&CancellationToken::new()).await.unwrap();assert_eq!(source.state,SourceState::Error);io.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_completed_discovery_revokes_unpublished_batch() {
    let directory=tempfile::tempdir().unwrap();let path=directory.path().join("cancelled.jsonl");std::fs::write(&path,tool("unpublished",&timestamp())).unwrap();
    let mut live=LiveFixture::new(io()).await;let operation=CancellationToken::new();let(reply,result)=oneshot::channel();
    live.sender.send(live::Reconcile{discovery:discovery(std::slice::from_ref(&path)),cancel:operation.clone(),reply}).await.unwrap();result.await.unwrap().unwrap();operation.cancel();
    live.reconcile(discovery(&[])).await;
    let snapshot=tokio::time::timeout(Duration::from_secs(3),live.events.recv()).await.unwrap().unwrap().unwrap();assert!(snapshot.agents.is_empty());
    while let Ok(event)=live.events.try_recv(){assert!(event.unwrap().agents.is_empty());}live.close().await;
}
