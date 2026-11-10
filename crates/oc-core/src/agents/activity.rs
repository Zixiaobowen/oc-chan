use std::{collections::{BTreeMap, BTreeSet}, path::Path};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;
use crate::{error::{Error, Result, check_cancel}, io::{BoundedIo, FileIdentity}, model::{ActivityKind, AgentActivity, AGENT_ACTIVITY_WINDOW_MS}};

pub(super) const TAIL_BYTES: usize = 128 * 1024;
const CHUNK_BYTES: usize = 16 * 1024;
#[derive(Default, Debug)]
pub(super) struct ActivityState { calls: BTreeMap<String, AgentActivity>, model: Option<AgentActivity> }
#[derive(Deserialize)]
struct Record { #[serde(rename="type")] kind: String, #[serde(rename="customType")] custom_type: Option<String>, timestamp: Option<String>, message: Option<Message>, data: Option<Data> }
#[derive(Deserialize)]
struct Message { role: Option<String>, #[serde(rename="stopReason")] stop_reason: Option<String>, #[serde(rename="toolCallId")] tool_call_id: Option<String> }
#[derive(Deserialize)]
struct Data { #[serde(rename="toolCallId")] tool_call_id: Option<String>, #[serde(rename="toolName")] tool_name: Option<String> }
pub(super) fn time(value: &str) -> Option<i64> { chrono::DateTime::parse_from_rfc3339(value).ok().map(|t| t.timestamp_millis()) }
fn identifier(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.is_empty() && s.len() <= 160 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_./:|-".contains(&b)))
}
impl ActivityState {
    fn clear(&mut self) { self.calls.clear(); self.model = None; }
    pub(super) fn consume(&mut self, bytes: &[u8], now: i64) -> Result<()> {
        let record: Record = match serde_json::from_slice(bytes) { Ok(record) => record, Err(_) => { self.clear(); return Err(Error::new("INVALID_JSONL", "JSONL 记录损坏")); } };
        let message = record.message;
        let role = message.as_ref().and_then(|m| m.role.as_deref());
        let stop = message.as_ref().and_then(|m| m.stop_reason.as_deref());
        let assistant = record.kind == "message" && role == Some("assistant");
        if (assistant && stop.is_some_and(|r| matches!(r, "stop" | "length" | "abort" | "aborted" | "error"))) || (record.kind == "message" && role == Some("user")) { self.clear(); return Ok(()); }
        let start = record.kind == "custom" && record.custom_type.as_deref() == Some("tool_execution_start");
        let result = record.kind == "message" && role == Some("toolResult");
        if !start && !result && !assistant { return Ok(()); }
        let Some(observed) = record.timestamp.as_deref().and_then(time).filter(|t| *t <= now) else { self.clear(); return Err(Error::new("INVALID_ACTIVITY", "调用时间无效")); };
        if result {
            let Some(id) = identifier(message.and_then(|m| m.tool_call_id)) else { self.clear(); return Err(Error::new("INVALID_ACTIVITY", "调用标识无效")); };
            self.calls.remove(&id); self.model = None; return Ok(());
        }
        if assistant && stop != Some("toolUse") { self.clear(); return Err(Error::new("UNSUPPORTED_ACTIVITY", "调用事件格式不支持")); }
        if now - observed >= AGENT_ACTIVITY_WINDOW_MS { return Ok(()); }
        let observed_at = chrono::DateTime::from_timestamp_millis(observed).ok_or_else(|| Error::invalid("activity timestamp"))?.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        if start {
            let (id, name) = record.data.map(|d| (identifier(d.tool_call_id), identifier(d.tool_name))).unwrap_or_default();
            let (Some(id), Some(name)) = (id, name) else { self.clear(); return Err(Error::new("INVALID_ACTIVITY", "调用元数据无效")); };
            if self.calls.len() >= 32 && !self.calls.contains_key(&id) { self.clear(); return Err(Error::limit("active calls", 32, 33)); }
            self.model = None; self.calls.insert(id, AgentActivity { kind: ActivityKind::Tool, name: Some(name), observed_at });
        } else { self.model = Some(AgentActivity { kind: ActivityKind::Model, name: None, observed_at }); }
        Ok(())
    }
    pub(super) fn recent(&mut self, now: i64) -> Option<AgentActivity> {
        let current = |activity: &AgentActivity| time(&activity.observed_at).is_some_and(|then| now >= then && now - then < AGENT_ACTIVITY_WINDOW_MS);
        self.calls.retain(|_, activity| current(activity));
        if self.model.as_ref().is_some_and(|activity| !current(activity)) { self.model = None; }
        self.model.iter().chain(self.calls.values()).max_by(|a, b| a.observed_at.cmp(&b.observed_at)).cloned()
    }
}
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct ActivityRead { pub activity: Option<AgentActivity>, pub issues: BTreeSet<String>, pub bytes_read: usize }
#[derive(Default, Debug)]
pub(super) struct ActivityReader { identity: Option<FileIdentity>, offset: u64, state: ActivityState, issues: BTreeSet<String> }
impl ActivityReader {
    pub(super) async fn read(&mut self, io: &BoundedIo, path: &Path, expected: &FileIdentity, cancel: &CancellationToken) -> Result<ActivityRead> {
        #[cfg(feature = "acceptance")]
        let began = crate::performance::stamp();
        let outcome = self.read_inner(io, path, expected, cancel).await;
        #[cfg(feature = "acceptance")]
        if let Ok(result) = &outcome {
            if let Some((index, sequence)) = crate::performance::key(result.activity.as_ref().and_then(|activity| activity.name.as_deref())) {
                crate::performance::observe(|| serde_json::json!(["r", crate::performance::stamp(), index, sequence, began, result.bytes_read, null, result.issues.len()]));
            }
        }
        if outcome.is_err() { self.state.clear(); self.identity = None; self.offset = 0; }
        outcome
    }
    async fn read_inner(&mut self, io: &BoundedIo, path: &Path, expected: &FileIdentity, cancel: &CancellationToken) -> Result<ActivityRead> {
        let probe = io.read_range("agent-activity", path, 0, 0, cancel).await?;
        let initial = probe.identity;
        if !expected.same_file(&initial) { return Err(Error::new("OC_COLLECTION_CHANGED", "会话文件已替换，等待进程发现重新确认")); }
        let reset = self.identity.as_ref().is_some_and(|old| !old.same_file(&initial) || initial.size < old.size || (initial.size == old.size && (initial.mtime != old.mtime || initial.mtime_nanos != old.mtime_nanos)));
        if reset { self.offset = 0; self.state.clear(); }
        let now = chrono::Utc::now().timestamp_millis();
        if !reset && self.identity.as_ref() == Some(&initial) {
            return Ok(ActivityRead { activity: self.state.recent(now), issues: self.issues.clone(), bytes_read: 0 });
        }
        let start = self.offset.max(initial.size.saturating_sub(TAIL_BYTES as u64));
        let omitted = start > self.offset;
        if omitted { self.state.clear(); }
        let mut issues = BTreeSet::new();
        if reset { issues.insert("文件被截断或替换".into()); }
        if omitted { issues.insert("尾部窗口之前的记录未读取".into()); }
        let target = (initial.size - start) as usize;
        let mut bytes = Vec::with_capacity(target);
        while bytes.len() < target {
            check_cancel(cancel)?;
            let read = io.read_range("agent-activity", path, start + bytes.len() as u64, CHUNK_BYTES.min(target - bytes.len()), cancel).await?;
            if !initial.same_file(&read.identity) || read.identity.size < initial.size || (read.identity.size == initial.size && (read.identity.mtime != initial.mtime || read.identity.mtime_nanos != initial.mtime_nanos)) {
                return Err(Error::new("OC_COLLECTION_CHANGED", "读取期间文件发生截断或替换"));
            }
            if read.bytes.is_empty() { issues.insert("读取期间文件发生截断".into()); break; }
            bytes.extend_from_slice(&read.bytes);
        }
        let now = chrono::Utc::now().timestamp_millis();
        let begin = if omitted { bytes.iter().position(|b| *b == b'\n').map(|n| n+1).unwrap_or(bytes.len()) } else { 0 };
        let end = bytes.iter().rposition(|b| *b == b'\n').map(|n| n+1).unwrap_or(0);
        if end < bytes.len() { issues.insert("尾部记录尚未完整或超过读取上限".into()); }
        if begin <= end {
            for line in bytes[begin..end].split(|b| *b == b'\n') {
                if line.is_empty() || line.starts_with(b"# ") { continue; }
                if let Err(error) = self.state.consume(line, now) { issues.insert(error.code); }
            }
        }
        self.offset = start + end as u64;
        // Observe only the bytes actually sampled; an append during reading must remain dirty.
        self.identity = Some(initial);
        let unsafe_tail = issues.iter().any(|issue| issue != "尾部窗口之前的记录未读取");
        if unsafe_tail { self.state.clear(); }
        self.issues = issues.clone();
        Ok(ActivityRead { activity: if unsafe_tail { None } else { self.state.recent(now) }, issues, bytes_read: bytes.len() })
    }
}
