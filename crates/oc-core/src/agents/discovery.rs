use std::{collections::{BTreeMap, BTreeSet}, path::Path, time::Duration};
use serde::Deserialize;
use futures_util::{stream, StreamExt};
use tokio_util::sync::CancellationToken;
use crate::{error::{Error, Result, check_cancel, timestamp}, io::{BoundedIo, CommandSpec}, model::{AgentInfo, AgentKind, AgentSnapshot, AgentState, SourceState, SourceStatus, TernTarget}, process::ProcessIdentity};
use super::{AgentPaths, MAX_SESSIONS, runtime::{self, ProcessRow}, sessions::{self, Session}};

pub(super) struct Discovery { pub snapshot: AgentSnapshot, pub sessions: Vec<Session>, pub identities: BTreeMap<u32, ProcessIdentity> }
pub(super) fn failure_source(id: &str, label: &str, operation: &str, error: &Error) -> SourceStatus {
    let state = if error.code == "ENOENT" { SourceState::Empty } else if error.code == "OC_COLLECTION_LIMIT" { SourceState::Partial } else { SourceState::Error };
    SourceStatus::new(id, label, state, format!("{operation}（{}）；没有推测缺失数据。", error.code))
}
fn fatal(error: &Error) -> bool { error.is_cancelled() || error.is_cleanup() }
#[derive(Deserialize)]
struct Host { version: u32, pid: u32, endpoint: String, token: String }
#[derive(Deserialize)]
struct SocketResponse { v: u32, ok: bool, snapshot: SocketSnapshot }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct SocketSnapshot { pid: u32, session_id: Option<String>, session_name: Option<String>, cwd: Option<String>, model: Option<SocketModel>, busy: Option<bool> }
#[derive(Deserialize)]
struct SocketModel { provider: Option<String>, id: Option<String> }
async fn read_host(io: &BoundedIo, path: &Path, pids: &BTreeSet<u32>, identities: &BTreeMap<u32, ProcessIdentity>, cancel: &CancellationToken) -> Result<Option<SocketSnapshot>> {
    let read = io.read_file("agent-collab", path, 4096, true, cancel).await?;
    if read.identity.uid != unsafe { libc::getuid() } || read.identity.mode & 0o077 != 0 { return Err(Error::new("OC_PRIVATE_PERMISSIONS", "host 文件权限不安全")); }
    let host: Host = serde_json::from_slice(&read.bytes).map_err(|_| Error::new("INVALID_METADATA", "host 记录无效"))?;
    if host.version != 1 || host.pid == 0 || !Path::new(&host.endpoint).is_absolute() { return Err(Error::invalid("collab host")); }
    sessions::field(Some(host.endpoint.clone()), 4096)?;
    if sessions::field(Some(host.token.clone()), 4096)?.is_none() { return Err(Error::invalid("collab token")); }
    let Some(identity) = identities.get(&host.pid).filter(|identity| identity.matches_live() && pids.contains(&host.pid)) else { return Ok(None); };
    let mut request = serde_json::to_vec(&serde_json::json!({"v":1,"token":host.token,"op":"snapshot"})).map_err(|_| Error::invalid("collab request"))?;
    request.push(b'\n');
    let bytes = io.socket("agent-collab", Path::new(&host.endpoint), request, 64 * 1024, Duration::from_millis(500), cancel).await?;
    let response: SocketResponse = serde_json::from_slice(&bytes).map_err(|_| Error::new("INVALID_METADATA", "socket 回复无效"))?;
    if !response.ok || response.v != 1 || response.snapshot.pid != host.pid { return Err(Error::new("INVALID_METADATA", "socket 身份无效")); }
    if !identity.matches_live() { return Ok(None); }
    let mut snapshot = response.snapshot;
    sessions::field(snapshot.session_id.clone(), 512)?;
    snapshot.session_name = sessions::omp_field(snapshot.session_name, 160)?;
    snapshot.cwd = sessions::omp_field(snapshot.cwd, 4096)?;
    if let Some(model) = &mut snapshot.model {
        model.provider = sessions::omp_field(model.provider.take(), 512)?;
        model.id = sessions::omp_field(model.id.take(), 512)?;
    }
    Ok(Some(snapshot))
}
pub(super) async fn collab(io: &BoundedIo, paths: &AgentPaths, agents: &mut [AgentInfo], identities: &BTreeMap<u32, ProcessIdentity>, cancel: &CancellationToken) -> Result<SourceStatus> {
    let mut paths = match io.read_private_directory("agent-collab", &paths.collab_hosts, 4096, 4096, cancel).await {
        Ok(paths) => paths, Err(error) if fatal(&error) => return Err(error),
        Err(error) => return Ok(failure_source("omp-socket", "OMP 本地 socket", "无法读取私有 host registry", &error)),
    };
    paths.retain(|path| runtime::filename(path).strip_suffix(".json").is_some_and(|name| !name.is_empty() && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')));
    let pids = agents.iter().filter(|agent| agent.runtime == "OMP").map(|agent| agent.pid).collect();
    let batch = cancel.child_token(); let mut fatal_errors = Vec::new();
    let mut names = paths.iter().take(32);
    let mut reads = stream::iter(std::iter::from_fn(|| names.next().map(|path| read_host(io, path, &pids, identities, &batch)))).buffer_unordered(8);
    let mut succeeded = 0; let mut errors = Vec::new();
    while let Some(result) = reads.next().await {
        match result {
            Ok(Some(snapshot)) if !batch.is_cancelled() => {
                let Some(agent) = agents.iter_mut().find(|agent| agent.pid == snapshot.pid && agent.kind == AgentKind::Main && (agent.session_id.is_none() || agent.session_id == snapshot.session_id)) else { continue; };
                if let Some(name) = snapshot.session_name { agent.name = name; }
                if let Some(cwd) = snapshot.cwd { agent.cwd = Some(cwd); }
                if let Some(model) = snapshot.model { if let (Some(provider), Some(id)) = (model.provider, model.id) { agent.model = Some(format!("{provider}/{id}")); } }
                if let Some(busy) = snapshot.busy { agent.state = if busy { AgentState::Working } else { AgentState::Idle }; }
                agent.source = "OMP authenticated local socket snapshot".into(); succeeded += 1;
            },
            Ok(_) => (),
            Err(error) if fatal(&error) => { batch.cancel(); fatal_errors.push(error); },
            Err(error) => errors.push(error.code),
        }
    }
    if !fatal_errors.is_empty() { return Err(Error::aggregate(fatal_errors)); }
    check_cancel(cancel)?;
    Ok(SourceStatus::new("omp-socket", "OMP 本地 socket", if !errors.is_empty() || paths.len() > 32 { SourceState::Partial } else if succeeded > 0 { SourceState::Ok } else { SourceState::Empty },
        format!("读取 {succeeded} 个活跃 host；{} 个失败。仅提供主会话白名单元数据，不公开子代理 roster；本轮最多32个host，最多8个在途读取，共用全局预算。{}", errors.len(), errors.join("、"))))
}
fn bounded_items<'de, D, T>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where D: serde::Deserializer<'de>, T: Deserialize<'de> {
    struct Items<T>(std::marker::PhantomData<T>);
    impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for Items<T> {
        type Value = Vec<T>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result { formatter.write_str("at most 4096 metadata items") }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error> {
            let mut items = Vec::new();
            while let Some(item) = sequence.next_element()? {
                if items.len() == 4096 { return Err(serde::de::Error::custom("OC_COLLECTION_LIMIT")); }
                items.push(item);
            }
            Ok(items)
        }
    }
    deserializer.deserialize_seq(Items(std::marker::PhantomData))
}
fn protocol_error(error: serde_json::Error) -> Error {
    if error.to_string().starts_with("OC_COLLECTION_LIMIT") { Error::limit("Tern metadata items", 4096, 4097) }
    else { Error::new("INVALID_METADATA", "Tern 元数据协议无效") }
}
#[derive(Deserialize)]
struct TernClients { #[serde(deserialize_with="bounded_items")] clients: Vec<TernClient> }
#[derive(Deserialize)]
struct TernClient { kind: Option<String>, window: Option<String> }
#[derive(Deserialize)]
struct TernWindow { #[serde(deserialize_with="bounded_items")] panes: Vec<TernPane> }
#[derive(Deserialize)]
struct TernPane { exited: Option<serde::de::IgnoredAny>, working: Option<bool>, omp_session_file: Option<String>, pane: Option<u64> }
pub(super) fn apply_tern(agents: &mut [AgentInfo], sessions: &[Session], bytes: &[u8], window: &str) -> Result<usize> {
    let snapshot: TernWindow = serde_json::from_slice(bytes).map_err(protocol_error)?;
    let mut matched = 0;
    for pane in snapshot.panes {
        if pane.exited.is_some() { continue; }
        let (Some(working), Some(file)) = (pane.working, pane.omp_session_file) else { continue; };
        sessions::field(Some(file.clone()), 4096)?;
        let Some(session) = sessions.iter().find(|s| s.file == Path::new(&file)) else { continue; };
        let Some(agent) = agents.iter_mut().find(|a| a.session_id.as_ref() == Some(&session.id) && a.runtime == "OMP" && a.kind == AgentKind::Main) else { continue; };
        agent.state = if working { AgentState::Working } else { AgentState::Idle };
        agent.source = "Tern pane working state + OMP ownership/session descriptors".into();
        if let Some(pane_id) = pane.pane.filter(|p| *p > 0 && *p <= 9_007_199_254_740_991) { agent.tern = Some(TernTarget { window_key: window.into(), pane_id, session_file: file }); }
        matched += 1;
    }
    Ok(matched)
}
fn tern_command(executable: &str, args: &[&str], paths: &AgentPaths) -> CommandSpec {
    let mut spec = CommandSpec::new(executable, args.iter().copied(), 2 * 1024 * 1024, Duration::from_secs(1));
    spec.env.insert("HOME".into(), paths.home.as_os_str().to_owned());
    if let Some(runtime) = &paths.runtime_directory { spec.env.insert("TMPDIR".into(), runtime.as_os_str().to_owned()); }
    spec
}
async fn tern(io: &BoundedIo, paths: &AgentPaths, agents: &mut [AgentInfo], sessions: &[Session], rows: &[ProcessRow], cancel: &CancellationToken) -> Result<SourceStatus> {
    let Some(host) = rows.iter().find(|r| r.executable.ends_with("/Tern.app/Contents/MacOS/tern")) else { return Ok(SourceStatus::new("tern-state", "Tern 主代理状态", SourceState::Empty, "未发现 Tern 宿主进程；保留 CLI 进程活性状态。")); };
    let work = async {
        let output = io.command("agent-tern", tern_command(&host.executable, &["inspect", "--json"], paths), cancel).await?.success()?;
        let clients: TernClients = serde_json::from_slice(&output.stdout).map_err(protocol_error)?;
        let mut windows = BTreeSet::new(); let mut failed = 0;
        for client in clients.clients {
            if client.kind.as_deref() != Some("window") { continue; }
            match client.window { Some(key) if key.encode_utf16().count() <= 128 && !key.chars().any(|c| c.is_control()) => { windows.insert(key); }, _ => failed += 1 }
        }
        let mut matched = 0; let batch = cancel.child_token(); let mut fatal_errors = Vec::new();
        let mut keys = windows.iter().take(16);
        let mut reads = stream::iter(std::iter::from_fn(|| keys.next().map(|key| {
            let batch = &batch;
            async move { (key, io.command("agent-tern", tern_command(&host.executable, &["inspect", "--json", "--window", key], paths), batch).await.and_then(|output| output.success())) }
        }))).buffer_unordered(4);
        while let Some((key, result)) = reads.next().await {
            let result = result.and_then(|output| { check_cancel(&batch)?; apply_tern(agents, sessions, &output.stdout, key) });
            match result { Ok(count) => matched += count, Err(error) if fatal(&error) => { batch.cancel(); fatal_errors.push(error); }, Err(_) => failed += 1 }
        }
        if !fatal_errors.is_empty() { return Err(Error::aggregate(fatal_errors)); }
        check_cancel(cancel)?;
        Ok(SourceStatus::new("tern-state", "Tern 主代理状态", if failed > 0 || windows.len() > 16 || matched == 0 { SourceState::Partial } else { SourceState::Ok }, format!("枚举 {} 个窗口，按精确session关联 {matched} 个主代理；{failed} 个读取失败；最多16窗口，不提供子代理生命周期。", windows.len())))
    }.await;
    match work { Ok(source) => Ok(source), Err(error) if fatal(&error) => Err(error), Err(error) => Ok(failure_source("tern-state", "Tern 主代理状态", "Tern inspect 不可用，保留 PID 活性", &error)) }
}

pub(super) async fn discover(io: &BoundedIo, paths: &AgentPaths, cancel: &CancellationToken) -> Result<Discovery> {
    let (mut rows, mut identities) = runtime::read_processes(io, cancel).await?;
    let identity_failures = rows.iter().filter(|row| runtime::identify(row).is_some() && !identities.contains_key(&row.pid)).count();
    let (mut agents, hosts) = runtime::process_agents(&rows, &identities);
    // Arguments are transient classification input; never retain prompt/credential-bearing argv.
    for row in &mut rows { row.args = String::new(); }
    let mut sources = vec![SourceStatus::new("processes", "本机 CLI 进程", if identity_failures > 0 { SourceState::Partial } else if agents.is_empty() { SourceState::Empty } else { SourceState::Ok }, format!("已识别 OMP、Codex、Claude Code、OpenCode，合并wrapper/native，验证PID出生身份；{identity_failures} 个身份读取失败。进程存在不代表正在推理。"))];
    let mut metadata = Vec::new(); let mut files = Vec::new(); let mut attempted = 0; let mut ownership_failure = None;
    if !agents.is_empty() {
        let work = async {
            let pids = agents.iter().map(|a| a.pid.to_string()).collect::<Vec<_>>().join(",");
            let output = io.command("agent-ownership", CommandSpec::new("/usr/sbin/lsof", ["-nP", "-a", "-p", &pids, "-F", "pfan"], 4 * 1024 * 1024, Duration::from_millis(1800)), cancel).await?.success()?;
            files = sessions::parse_open_files(output.stdout_text()?, paths)?;
            // Descriptors from a PID reused during lsof must never be assigned to the sampled process.
            files.retain(|f| identities.get(&f.pid).is_some_and(ProcessIdentity::matches_live));
            let paths: BTreeSet<_> = files.iter().flat_map(|f| f.sessions.iter()).collect();
            let mut unreadable = 0;
            for path in paths.iter().take(MAX_SESSIONS) {
                attempted += 1;
                let read = async { let read = io.read_range("agent-metadata", path, 0, 16 * 1024, cancel).await?; sessions::parse_omp(&read.bytes, (*path).clone(), read.identity) }.await;
                match read { Ok(session) => metadata.push(session), Err(error) if fatal(&error) => return Err(error), Err(_) => unreadable += 1 }
            }
            Ok(SourceStatus::new("omp-ownership", "OMP 主代理与子代理", SourceState::Partial,
                format!("读取 {attempted} 个打开会话头部；{unreadable} 个无法解析。task由父会话专用artifacts目录与lease确认，普通fork不建父子边。keepAlive可保留已完成task，忙闲未知、不计活动数；模型为初始值。lsof不报告flock持有状态，自定义目录需显式AgentPaths。{}", if paths.len() > MAX_SESSIONS { "SESSION_LIMIT：最多128头部。" } else { "" })))
        }.await;
        match work { Ok(source) => { agents = sessions::owned_omp(agents, &files, &metadata); sources.push(source); }, Err(error) if fatal(&error) => return Err(error), Err(error) => { sources.push(failure_source("omp-ownership", "OMP 主代理与子代理", "打开文件/会话lease读取失败", &error)); ownership_failure = Some(error); } }
    } else { sources.push(SourceStatus::new("omp-ownership", "OMP 主代理与子代理", SourceState::Empty, "未识别到活跃CLI；没有扫描历史会话。")); }
    let (codex, source) = sessions::collect_codex(io, agents, &files, &hosts, MAX_SESSIONS.saturating_sub(attempted), cancel).await?;
    agents = codex;
    sources.push(ownership_failure.as_ref().map(|e| failure_source("codex-sessions", "Codex 主代理与子代理", "无法确认会话归属", e)).unwrap_or(source));
    sources.push(tern(io, paths, &mut agents, &metadata, &rows, cancel).await?);
    sources.push(collab(io, paths, &mut agents, &identities, cancel).await?);
    check_cancel(cancel)?;
    agents.retain(|agent| identities.get(&agent.pid).is_some_and(ProcessIdentity::matches_live));
    let ids: BTreeSet<_> = agents.iter().filter_map(|a| a.session_id.as_deref()).collect();
    metadata.retain(|s| ids.contains(s.id.as_str()));
    identities.retain(|pid, _| agents.iter().any(|a| a.pid == *pid));
    let active_subagent_count = if agents.is_empty() { Some(0) } else { None };
    Ok(Discovery { snapshot: AgentSnapshot { collected_at: timestamp(), agents, active_subagent_count, sources }, sessions: metadata, identities })
}
