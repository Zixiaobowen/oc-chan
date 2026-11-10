use std::{collections::{BTreeMap, BTreeSet}, path::{Component, Path, PathBuf}};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;
use crate::{error::{Error, Result, validate_text}, io::{BoundedIo, FileIdentity}, model::{AgentInfo, AgentKind, AgentState, SourceState, SourceStatus}};
use super::{AgentPaths, MAX_SESSIONS, runtime::filename};

#[derive(Clone, Debug)]
pub(super) struct Session {
    pub id: String, pub file: PathBuf, pub summary: Option<String>, pub cwd: Option<String>,
    pub parent: Option<String>, pub started_at: Option<String>, pub model: Option<String>,
    pub identity: FileIdentity,
}
#[derive(Clone, Debug, Default)]
pub(super) struct OpenFiles { pub pid: u32, pub cwd: Option<String>, pub sessions: Vec<PathBuf>, pub leases: BTreeSet<String>, pub codex: Vec<PathBuf> }
pub(super) fn field(value: Option<String>, maximum: usize) -> Result<Option<String>> {
    let value = value.filter(|text| !text.is_empty());
    if let Some(text) = &value {
        if text.len() > 4096 { return Err(Error::limit("agent metadata field bytes", 4096, text.len())); }
        validate_text(text, maximum, 4096, "agent metadata").map_err(|_| Error::new("INVALID_METADATA", "代理元数据字段无效"))?;
    }
    Ok(value)
}
pub(super) fn omp_field(value: Option<String>, maximum: usize) -> Result<Option<String>> {
    if let Some(text) = &value { if text.len() > 4096 { return Err(Error::limit("agent metadata field bytes", 4096, text.len())); } }
    Ok(value.filter(|text| !text.is_empty() && text.encode_utf16().count() <= maximum && !text.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}')))
}
fn optional_text<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    struct Text;
    impl<'de> serde::de::Visitor<'de> for Text {
        type Value = Option<String>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result { formatter.write_str("optional metadata text") }
        fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> { Ok(Some(value.to_owned())) }
        fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> { Ok(Some(value)) }
        fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
        fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
        fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
        fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
        fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> { while sequence.next_element::<serde::de::IgnoredAny>()?.is_some() {} Ok(None) }
        fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> { while map.next_entry::<serde::de::IgnoredAny, serde::de::IgnoredAny>()?.is_some() {} Ok(None) }
    }
    deserializer.deserialize_any(Text)
}
pub(super) fn uuid(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(index, byte)| if matches!(index, 8 | 13 | 18 | 23) { byte == b'-' } else { byte.is_ascii_hexdigit() })
}
fn digits(value: &str, count: usize) -> bool { value.len() == count && value.bytes().all(|b| b.is_ascii_digit()) }
pub(super) fn rollout_id(path: &Path) -> Option<String> {
    if !path.is_absolute() { return None; }
    let parts: Vec<_> = path.iter().filter_map(|p| p.to_str()).collect();
    if parts.len() < 5 { return None; }
    let tail = &parts[parts.len()-5..];
    if tail[0] != "sessions" || !digits(tail[1], 4) || !digits(tail[2], 2) || !digits(tail[3], 2) { return None; }
    let name = tail[4].strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    if name.len() < 56 || !name.is_char_boundary(20) { return None; }
    let date = name.as_bytes();
    for (i, byte) in date[..20].iter().enumerate() {
        if matches!(i, 4 | 7 | 13 | 16 | 19) { if *byte != b'-' { return None; } }
        else if i == 10 { if *byte != b'T' { return None; } }
        else if !byte.is_ascii_digit() { return None; }
    }
    let mut ids = name[20..].split('_'); let id = ids.next()?;
    if !uuid(id) || ids.next().is_some_and(|suffix| !uuid(suffix)) || ids.next().is_some() { return None; }
    Some(id.to_ascii_lowercase())
}
pub(super) fn parse_open_files(output: &str, paths: &AgentPaths) -> Result<Vec<OpenFiles>> {
    let mut result: Vec<OpenFiles> = Vec::new(); let mut descriptor = ""; let mut access = ""; let mut count = 0;
    for line in output.lines() {
        if line.len() > 4097 { return Err(Error::limit("ownership field", 4096, line.len()-1)); }
        let Some(kind) = line.as_bytes().first().copied() else { continue; };
        if !kind.is_ascii() { return Err(Error::invalid("lsof field tag")); }
        let value = &line[1..];
        match kind {
            b'p' => {
                descriptor = ""; access = "";
                let pid = value.parse::<u32>().map_err(|_| Error::invalid("lsof pid"))?;
                if pid == 0 { return Err(Error::invalid("lsof pid")); }
                if result.len() == 4096 { return Err(Error::limit("ownership processes", 4096, 4097)); }
                result.push(OpenFiles { pid, ..Default::default() });
            },
            b'f' => { descriptor = value; access = ""; }, b'a' => access = value,
            b'n' => if let Some(row) = result.last_mut() {
                let path = Path::new(value);
                if descriptor == "cwd" { row.cwd = field(Some(value.into()), 4096)?; }
                else if path.starts_with(&paths.owners) && path.extension().is_some_and(|e| e == "lock") {
                    let id = path.file_stem().and_then(|n| n.to_str()).unwrap_or("");
                    if uuid(id) { row.leases.insert(id.into()); count += 1; }
                } else if path.starts_with(&paths.sessions) && path.extension().is_some_and(|e| e == "jsonl") && !filename(path).starts_with('.') {
                    row.sessions.push(path.into()); count += 1;
                } else if !descriptor.is_empty() && descriptor.bytes().all(|b| b.is_ascii_digit()) && matches!(access, "u" | "w") && rollout_id(path).is_some() {
                    row.codex.push(path.into()); count += 1;
                }
                if count > 4096 { return Err(Error::limit("ownership descriptors", 4096, count)); }
            },
            _ => (),
        }
    }
    Ok(result)
}
#[derive(Deserialize)]
struct OmpHeader {
    #[serde(rename="type")] kind: String,
    #[serde(default, deserialize_with="optional_text")] id: Option<String>,
    #[serde(default, deserialize_with="optional_text")] title: Option<String>,
    v: Option<u32>,
    #[serde(default, deserialize_with="optional_text")] cwd: Option<String>,
    #[serde(rename="parentSession", default, deserialize_with="optional_text")] parent: Option<String>,
    #[serde(default, deserialize_with="optional_text")] timestamp: Option<String>,
    #[serde(default, deserialize_with="optional_text")] model: Option<String>,
}
pub(super) fn parse_omp(prefix: &[u8], file: PathBuf, identity: FileIdentity) -> Result<Session> {
    let lines: Vec<_> = prefix.split(|b| *b == b'\n').take(4).collect();
    let mut summary = None;
    if let Some(line) = lines.first().filter(|line| line.starts_with(b"{\"type\":\"title\",")) {
        let title: OmpHeader = serde_json::from_slice(line).map_err(|_| Error::new("INVALID_JSON", "OMP 标题格式无效"))?;
        if title.v == Some(1) {
            summary = omp_field(title.title, 512)?.map(|title| {
                let title = title.trim_start_matches(|c: char| matches!(c as u32, 0xe000..=0xf8ff | 0xf0000..=0xffffd | 0x100000..=0x10fffd)).trim(); title.to_owned()
            }).filter(|t| !t.is_empty() && !t.eq_ignore_ascii_case("omp"));
        }
    }
    for (index, line) in lines.iter().take(2).enumerate() {
        if !line.starts_with(b"{\"type\":\"session\",") { continue; }
        let header: OmpHeader = serde_json::from_slice(line).map_err(|_| Error::new("INVALID_JSON", "OMP 会话头格式无效"))?;
        let id = header.id.filter(|id| uuid(id)).ok_or_else(|| Error::invalid("OMP session identity"))?;
        let model = match lines.get(index+1).filter(|line| line.starts_with(b"{\"type\":\"model_change\",")) {
            Some(line) => { let model: OmpHeader = serde_json::from_slice(line).map_err(|_| Error::new("INVALID_JSON", "OMP 模型头格式无效"))?; omp_field(model.model, 512)? },
            None => None,
        };
        let _ = header.kind;
        return Ok(Session { id, file, summary, cwd: omp_field(header.cwd, 4096)?, parent: omp_field(header.parent, 4096)?,
            started_at: omp_field(header.timestamp, 4096)?.filter(|t| chrono::DateTime::parse_from_rfc3339(t).is_ok()), model, identity });
    }
    Err(Error::new("INVALID_METADATA", "未找到 OMP 会话头 / Missing OMP session header"))
}
fn normalized(path: &Path) -> PathBuf {
    let mut output = PathBuf::new(); for part in path.components() { match part { Component::CurDir => (), Component::ParentDir => { output.pop(); }, other => output.push(other.as_os_str()) } } output
}
pub(super) fn owned_omp(processes: Vec<AgentInfo>, files: &[OpenFiles], metadata: &[Session]) -> Vec<AgentInfo> {
    let by_file: BTreeMap<_, _> = metadata.iter().map(|m| (normalized(&m.file), m)).collect();
    let owned_ids: BTreeSet<_> = files.iter().flat_map(|fd| metadata.iter().filter(move |s| fd.sessions.contains(&s.file) && fd.leases.contains(&s.id)).map(|s| s.id.as_str())).collect();
    let mut result = Vec::new(); let mut primary = BTreeMap::new();
    for mut process in processes {
        let descriptors = files.iter().find(|f| f.pid == process.pid);
        process.cwd = descriptors.and_then(|d| d.cwd.clone());
        let owned: Vec<_> = metadata.iter().filter(|m| descriptors.is_some_and(|d| d.sessions.contains(&m.file) && d.leases.contains(&m.id))).collect();
        if process.runtime != "OMP" || owned.is_empty() { primary.insert(process.id.clone(), process.id.clone()); result.push(process); continue; }
        for item in &owned {
            let directory = item.file.parent().unwrap_or(Path::new("/"));
            let parent_path = PathBuf::from(format!("{}.jsonl", directory.display()));
            let parent = by_file.get(&normalized(&parent_path)).copied();
            let explicit = item.parent.as_ref().and_then(|p| p.strip_suffix(".jsonl")).is_some_and(|p| normalized(directory) == normalized(Path::new(p)));
            let task = parent.is_some() || explicit;
            let shared = parent.is_some_and(|p| owned.iter().any(|s| s.id == p.id));
            let mut agent = process.clone(); agent.id = format!("omp:{}", item.id); agent.session_id = Some(item.id.clone());
            if !task { primary.insert(process.id.clone(), agent.id.clone()); }
            agent.name = if task { item.file.file_stem().and_then(|p| p.to_str()).and_then(|name| field(Some(name.into()), 160).ok().flatten()).unwrap_or_else(|| "OMP subagent".into()) } else { "OMP".into() };
            agent.summary = item.summary.clone(); agent.model = item.model.clone(); agent.cwd = item.cwd.clone().or(agent.cwd);
            agent.started_at = item.started_at.clone();
            if task { agent.kind = AgentKind::Subagent; agent.state = AgentState::Unknown;
                if let Some(parent) = parent.filter(|p| owned_ids.contains(p.id.as_str())) { agent.parent_id = Some(format!("omp:{}", parent.id)); }
            }
            if shared { agent.cpu_percent = None; agent.memory_bytes = None; }
            agent.source = "OMP open ownership/session descriptors + session header (initial model)".into(); result.push(agent);
        }
    }
    for agent in &mut result { if let Some(parent) = agent.parent_id.as_ref().and_then(|id| primary.get(id)) { agent.parent_id = Some(parent.clone()); } }
    result
}
#[derive(Debug, Deserialize)]
struct CodexRecord { #[serde(rename="type")] kind: String, payload: CodexPayload }
#[derive(Debug, Deserialize)]
struct CodexPayload { id: String, timestamp: Option<String>, cwd: Option<String>, source: Option<CodexSource>, agent_nickname: Option<String>, agent_role: Option<String> }
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CodexSource { Text(String), Detail { subagent: Option<CodexSubagent> } }
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CodexSubagent { Detail { thread_spawn: Option<Spawn> }, Text(String) }
#[derive(Debug, Deserialize)]
struct Spawn { parent_thread_id: String, agent_nickname: Option<String>, agent_role: Option<String> }
#[derive(Clone, Debug)]
pub(super) struct CodexSession { pub id: String, pub parent: Option<String>, pub subagent: bool, pub name: Option<String>, pub cwd: Option<String>, pub started_at: Option<String> }
pub(super) fn parse_codex(line: &[u8], file: &Path) -> Result<CodexSession> {
    let record: CodexRecord = serde_json::from_slice(line).map_err(|_| Error::new("INVALID_METADATA", "Codex 会话头无效 / Invalid Codex session header"))?;
    let payload = record.payload;
    if record.kind != "session_meta" || !uuid(&payload.id) || rollout_id(file).as_deref() != Some(&payload.id.to_ascii_lowercase()) { return Err(Error::new("INVALID_METADATA", "Codex 会话身份不匹配")); }
    let (subagent, spawn) = match payload.source {
        Some(CodexSource::Detail { subagent: Some(CodexSubagent::Detail { thread_spawn }) }) => (true, thread_spawn),
        Some(CodexSource::Detail { subagent: Some(CodexSubagent::Text(value)) }) => { field(Some(value), 160)?; (true, None) },
        Some(CodexSource::Text(value)) => { field(Some(value), 160)?; (false, None) },
        _ => (false, None),
    };
    if spawn.as_ref().is_some_and(|s| !uuid(&s.parent_thread_id)) { return Err(Error::new("INVALID_METADATA", "Codex 父线程身份无效")); }
    let name = field(payload.agent_nickname.or_else(|| spawn.as_ref().and_then(|s| s.agent_nickname.clone())), 160)?
        .or(field(payload.agent_role.or_else(|| spawn.as_ref().and_then(|s| s.agent_role.clone())), 160)?);
    let started_at = field(payload.timestamp, 64)?.filter(|stamp| chrono::DateTime::parse_from_rfc3339(stamp).is_ok());
    Ok(CodexSession { id: payload.id.to_ascii_lowercase(), parent: spawn.map(|s| s.parent_thread_id.to_ascii_lowercase()), subagent, name, cwd: field(payload.cwd, 4096)?, started_at })
}
pub(super) async fn read_codex(io: &BoundedIo, path: &Path, cancel: &CancellationToken) -> Result<CodexSession> {
    let mut bytes = Vec::new(); let mut identity: Option<FileIdentity> = None;
    while bytes.len() < 1024 * 1024 {
        let read = io.read_range("agent-metadata", path, bytes.len() as u64, 16 * 1024, cancel).await?;
        if identity.as_ref().is_some_and(|before| !before.same_file(&read.identity) || read.identity.size != before.size || read.identity.mtime != before.mtime || read.identity.mtime_nanos != before.mtime_nanos) { return Err(Error::new("OC_COLLECTION_CHANGED", "Codex 会话头读取期间文件已改变")); }
        identity = Some(read.identity);
        if read.bytes.is_empty() { break; }
        if let Some(end) = read.bytes.iter().position(|b| *b == b'\n') { bytes.extend_from_slice(&read.bytes[..end]); return parse_codex(&bytes, path); }
        bytes.extend_from_slice(&read.bytes);
    }
    if bytes.len() == 1024 * 1024 { Err(Error::limit("Codex header bytes", 1024 * 1024, 1024 * 1024 + 1)) }
    else { Err(Error::new("INCOMPLETE_HEADER", "Codex 首条会话记录尚未完整")) }
}
pub(super) fn project_codex(processes: Vec<AgentInfo>, sessions: &BTreeMap<String, (CodexSession, u32)>, hosts: &BTreeSet<u32>) -> Vec<AgentInfo> {
    let mut result = Vec::new(); let mut primary_ids = BTreeMap::new();
    for process in processes {
        let owned: Vec<_> = sessions.values().filter(|(_, pid)| *pid == process.pid).map(|(s, _)| s).collect();
        if process.runtime != "Codex" || owned.is_empty() { if !hosts.contains(&process.pid) { result.push(process); } continue; }
        let roots: Vec<_> = owned.iter().copied().filter(|s| !s.subagent).collect();
        let primary = if roots.len() == 1 { Some(roots[0]) } else if owned.len() == 1 { Some(owned[0]) } else { None };
        if let Some(primary) = primary { primary_ids.insert(process.id.clone(), format!("codex:{}", primary.id)); }
        for session in owned {
            let mut agent = process.clone(); agent.id = format!("codex:{}", session.id); agent.session_id = Some(session.id.clone());
            agent.name = session.name.clone().unwrap_or_else(|| if session.subagent { "Codex subagent" } else { "Codex" }.into());
            if session.subagent { agent.kind = AgentKind::Subagent; agent.parent_id = session.parent.as_ref().map(|id| format!("codex:{id}")); }
            if session.subagent || hosts.contains(&process.pid) { agent.state = AgentState::Unknown; }
            agent.cwd = session.cwd.clone().or(agent.cwd);
            agent.started_at = session.started_at.clone();
            if primary.is_none_or(|p| p.id != session.id) { agent.cpu_percent = None; agent.memory_bytes = None; }
            agent.source = "Codex live writable rollout descriptor + session_meta".into(); result.push(agent);
        }
    }
    for agent in &mut result { if let Some(parent) = agent.parent_id.as_ref().and_then(|p| primary_ids.get(p)) { agent.parent_id = Some(parent.clone()); } }
    result
}
pub(super) async fn collect_codex(io: &BoundedIo, processes: Vec<AgentInfo>, files: &[OpenFiles], hosts: &BTreeSet<u32>, available: usize, cancel: &CancellationToken) -> Result<(Vec<AgentInfo>, SourceStatus)> {
    let pids: BTreeSet<_> = processes.iter().filter(|p| p.runtime == "Codex").map(|p| p.pid).collect();
    let mut owners: BTreeMap<&PathBuf, BTreeSet<u32>> = BTreeMap::new();
    for file in files.iter().filter(|f| pids.contains(&f.pid)) { for path in &file.codex { owners.entry(path).or_default().insert(file.pid); } }
    let mut sessions = BTreeMap::new(); let mut ambiguous = BTreeSet::new(); let mut issues = BTreeSet::new();
    for (attempted, (file, owners)) in owners.iter().enumerate() {
        if attempted >= available.min(MAX_SESSIONS) { issues.insert("SESSION_LIMIT".into()); break; }
        if owners.len() != 1 { issues.insert("AMBIGUOUS_OWNER".into()); continue; }
        match read_codex(io, file, cancel).await {
            Ok(session) => {
                if sessions.contains_key(&session.id) || ambiguous.contains(&session.id) { sessions.remove(&session.id); ambiguous.insert(session.id); issues.insert("AMBIGUOUS_SESSION".into()); }
                else { sessions.insert(session.id.clone(), (session, *owners.first().expect("one owner"))); }
            },
            Err(error) if error.is_cleanup() || error.is_cancelled() => return Err(error),
            Err(error) => { issues.insert(error.code); },
        }
    }
    let source = SourceStatus::new("codex-sessions", "Codex 主代理与子代理", if !issues.is_empty() { SourceState::Partial } else if sessions.is_empty() { SourceState::Empty } else { SourceState::Ok },
        format!("关联 {} 个 Codex 会话；{} 个存活进程可写 rollout 文件。明确父线程 ID 支持多层关联；普通 fork 不建边；共享进程资源不重复。驻留不证明正在工作，子代理和 app-server 会话保持未知。OMP/Codex 共用128头部上限，单头部1MiB；不扫描历史。{}", sessions.len(), owners.len(), issues.into_iter().collect::<Vec<String>>().join("、")));
    Ok((project_codex(processes, &sessions, hosts), source))
}
