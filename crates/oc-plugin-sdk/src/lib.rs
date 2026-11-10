//! Versioned native plugin message contract and Rust SDK. Host IO is performed by the
//! host; the plugin only parses bounded results. Framing, budget, generation, call and
//! io identities are validated here so the core host can reuse the same rules.
mod runtime;
pub use runtime::{CollectContext, Collector, run_stdio};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::io::{BufRead, Write};

pub const VERSION: u8 = 2;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// Encoded NDJSON frame including newline, JSON escaping and the envelope.
pub const MAX_FRAME: usize = 64 * 1024;
/// Raw (pre-base64) chunk bytes.
pub const MAX_CHUNK: usize = 16 * 1024;
pub const MAX_RESULT: usize = 1024 * 1024;
/// Per-IO raw reassembly ceiling (covers a single 4 MiB `ps` result).
pub const MAX_IO_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_IO: usize = 8;
pub const WRITE_QUEUE: usize = 4;
/// Transport reservation: reader frame, buffered input, four output frames, writer frame,
/// event frame, base64/JSON scratch and one encoded chunk. Business buffers are separate.
pub const TRANSPORT_RESERVATION: usize = MAX_FRAME * 10 + 8192;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode { Protocol, Limit, Capability, Io, Cancelled, Deadline, Cleanup, Collect }

#[derive(Debug, Clone, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct Error { pub code: ErrorCode, pub message: String }
impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        let mut message = message.into();
        if message.len() > 512 { let mut end = 512; while !message.is_char_boundary(end) { end -= 1; } message.truncate(end); }
        Self { code, message }
    }
    pub fn protocol(message: impl Into<String>) -> Self { Self::new(ErrorCode::Protocol, message) }
}
impl From<std::io::Error> for Error { fn from(e: std::io::Error) -> Self { Self::new(ErrorCode::Io, e.to_string()) } }
pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Capability { SystemMetrics, ProcessRanking, ReadDefaultNetworkInterface }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "name", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command { VmStat, Processes, DefaultRoute, NetworkCounters { interface: String } }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum IoOperation { Command { command: Command }, OsInfo, DiskInfo, ResourceStatus }
impl IoOperation {
    pub fn capability(&self) -> Capability {
        match self {
            Self::Command { command: Command::Processes } => Capability::ProcessRanking,
            Self::Command { command: Command::DefaultRoute | Command::NetworkCounters { .. } } => Capability::ReadDefaultNetworkInterface,
            _ => Capability::SystemMetrics,
        }
    }
    pub fn validate(&self) -> Result<()> {
        if let Self::Command { command: Command::NetworkCounters { interface } } = self {
            if !valid_interface(interface) { return Err(Error::protocol("invalid network interface")); }
        }
        Ok(())
    }
}
pub fn valid_interface(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._:-".contains(&b))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budgets {
    pub frame_bytes: usize, pub chunk_bytes: usize, pub result_bytes: usize,
    pub max_io: usize, pub io_reassembly_bytes: usize, pub protocol_bytes: usize,
}
impl Budgets {
    pub fn validate(&self) -> Result<()> {
        if self.frame_bytes != MAX_FRAME || self.chunk_bytes != MAX_CHUNK || self.result_bytes == 0 || self.result_bytes > MAX_RESULT
            || self.max_io == 0 || self.max_io > MAX_IO || self.io_reassembly_bytes > MAX_IO_BYTES * MAX_IO
            || self.protocol_bytes < TRANSPORT_RESERVATION + self.result_bytes + self.io_reassembly_bytes {
            return Err(Error::new(ErrorCode::Limit, "unsupported or insufficient protocol reservation"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Initialize {
    pub id: String, pub app_version: String, pub capabilities: Vec<Capability>, pub budgets: Budgets,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Stream { Stdout, Stderr, Data }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OsInfo {
    pub hostname: String, pub platform: String, pub os_version: String,
    pub cpu_model: String, pub cpu_cores: usize, pub uptime_seconds: u64, pub memory_total: u64,
    pub swap_used: u64, pub cpu_idle: u64, pub cpu_total: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiskInfo { pub blocks: u64, pub bfree: u64, pub bavail: u64, pub bsize: u64 }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceStatus {
    pub id: String, pub label: String, pub state: String, pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub resources: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum HostMessage {
    Initialize { v: u8, generation: u64, id: String, app_version: String, capabilities: Vec<Capability>, budgets: Budgets },
    Collect { v: u8, generation: u64, call: u64, deadline_ms: u64 },
    IoChunk { v: u8, generation: u64, call: u64, io: u64, seq: u64, stream: Stream, data: String },
    IoEnd { v: u8, generation: u64, call: u64, io: u64, bytes: usize, sha256: String, stdout_bytes: usize, stderr_bytes: usize, data_bytes: usize, exit_code: Option<i32>, identity: String },
    IoError { v: u8, generation: u64, call: u64, io: u64, code: ErrorCode, message: String },
    Cancel { v: u8, generation: u64, call: u64 },
    Stop { v: u8, generation: u64 },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum PluginMessage {
    Ready { v: u8, generation: u64, protocol_bytes: usize, io_reassembly_bytes: usize, business_bytes: usize },
    IoRequest { v: u8, generation: u64, call: u64, io: u64, operation: IoOperation, max_bytes: usize, timeout_ms: u64 },
    ResultChunk { v: u8, generation: u64, call: u64, seq: u64, data: String },
    ResultEnd { v: u8, generation: u64, call: u64, bytes: usize, sha256: String },
    Error { v: u8, generation: u64, call: Option<u64>, code: ErrorCode, message: String },
    Cancelled { v: u8, generation: u64, call: u64 },
    Stopped { v: u8, generation: u64 },
}

pub fn safe_id(id: u64) -> Result<()> {
    if id == 0 || id > MAX_SAFE_INTEGER { Err(Error::protocol("identifier outside safe integer range")) } else { Ok(()) }
}
fn validate_envelope(v: u8, generation: u64, expected: Option<u64>) -> Result<()> {
    safe_id(generation)?;
    if v != VERSION || expected.is_some_and(|g| g != generation) { return Err(Error::protocol("version or generation mismatch")); }
    Ok(())
}
impl HostMessage {
    pub fn generation(&self) -> u64 {
        match self { Self::Initialize { generation, .. } | Self::Collect { generation, .. } | Self::IoChunk { generation, .. }
            | Self::IoEnd { generation, .. } | Self::IoError { generation, .. } | Self::Cancel { generation, .. } | Self::Stop { generation, .. } => *generation }
    }
    pub fn validate(&self, expected: Option<u64>) -> Result<()> {
        let envelope = match self {
            Self::Initialize { v, generation, .. } => validate_envelope(*v, *generation, expected),
            Self::Collect { v, generation, .. } => validate_envelope(*v, *generation, expected),
            Self::IoChunk { v, generation, .. } => validate_envelope(*v, *generation, expected),
            Self::IoEnd { v, generation, .. } => validate_envelope(*v, *generation, expected),
            Self::IoError { v, generation, .. } => validate_envelope(*v, *generation, expected),
            Self::Cancel { v, generation, .. } => validate_envelope(*v, *generation, expected),
            Self::Stop { v, generation } => validate_envelope(*v, *generation, expected),
        };
        envelope?;
        match self {
            Self::Initialize { id, app_version, capabilities, budgets, .. } => {
                if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    || app_version.len() > 64 || capabilities.len() > 3 { return Err(Error::protocol("invalid initialize")); }
                for (index, capability) in capabilities.iter().enumerate() { if capabilities[..index].contains(capability) { return Err(Error::protocol("duplicate capability")); } }
                budgets.validate()
            }
            Self::Collect { call, deadline_ms, .. } => { safe_id(*call)?; if *deadline_ms == 0 || *deadline_ms > 60_000 { return Err(Error::protocol("invalid collection deadline")); } Ok(()) }
            Self::Cancel { call, .. } => safe_id(*call),
            Self::IoChunk { call, io, seq, data, .. } => { safe_id(*call)?; safe_id(*io)?; if *seq > MAX_SAFE_INTEGER { return Err(Error::protocol("unsafe sequence")); } decode_chunk(data).map(|_| ()) }
            Self::IoEnd { call, io, bytes, sha256, stdout_bytes, stderr_bytes, data_bytes, identity, .. } => {
                safe_id(*call)?; safe_id(*io)?;
                if *bytes > MAX_IO_BYTES || stdout_bytes.checked_add(*stderr_bytes).and_then(|n| n.checked_add(*data_bytes)) != Some(*bytes)
                    || !valid_digest(sha256) || identity.is_empty() || identity.len() > 256 { return Err(Error::protocol("invalid IO completion")); }
                Ok(())
            }
            Self::IoError { call, io, message, .. } => { safe_id(*call)?; safe_id(*io)?; if message.len() > 512 { return Err(Error::protocol("oversized IO error")); } Ok(()) }
            Self::Stop { .. } => Ok(()),
        }
    }
}
impl PluginMessage {
    pub fn generation(&self) -> u64 {
        match self { Self::Ready { generation, .. } | Self::IoRequest { generation, .. } | Self::ResultChunk { generation, .. }
            | Self::ResultEnd { generation, .. } | Self::Error { generation, .. } | Self::Cancelled { generation, .. } | Self::Stopped { generation, .. } => *generation }
    }
    pub fn validate(&self, expected: Option<u64>) -> Result<()> {
        let envelope = match self {
            Self::Ready { v, generation, .. } => validate_envelope(*v, *generation, expected),
            Self::IoRequest { v, generation, .. } => validate_envelope(*v, *generation, expected),
            Self::ResultChunk { v, generation, .. } => validate_envelope(*v, *generation, expected),
            Self::ResultEnd { v, generation, .. } => validate_envelope(*v, *generation, expected),
            Self::Error { v, generation, .. } => validate_envelope(*v, *generation, expected),
            Self::Cancelled { v, generation, .. } => validate_envelope(*v, *generation, expected),
            Self::Stopped { v, generation } => validate_envelope(*v, *generation, expected),
        };
        envelope?;
        match self {
            Self::Ready { protocol_bytes, io_reassembly_bytes, business_bytes, .. } => {
                if *io_reassembly_bytes > MAX_IO_BYTES * MAX_IO || *business_bytes > MAX_RESULT
                    || !protocol_bytes.checked_sub(TRANSPORT_RESERVATION + *io_reassembly_bytes).is_some_and(|bytes| (1..=MAX_RESULT).contains(&bytes)) {
                    return Err(Error::protocol("invalid ready reservation"));
                }
                Ok(())
            }
            Self::IoRequest { call, io, operation, max_bytes, timeout_ms, .. } => {
                safe_id(*call)?; safe_id(*io)?; operation.validate()?;
                if *max_bytes == 0 || *max_bytes > MAX_IO_BYTES || *timeout_ms == 0 || *timeout_ms > 60_000 { return Err(Error::protocol("invalid IO request bounds")); }
                Ok(())
            }
            Self::ResultChunk { call, seq, data, .. } => { safe_id(*call)?; if *seq > MAX_SAFE_INTEGER { return Err(Error::protocol("unsafe sequence")); } decode_chunk(data).map(|_| ()) }
            Self::ResultEnd { call, bytes, sha256, .. } => { safe_id(*call)?; if *bytes > MAX_RESULT || !valid_digest(sha256) { return Err(Error::protocol("invalid result completion")); } Ok(()) }
            Self::Error { call, message, .. } => { if let Some(c) = call { safe_id(*c)?; } if message.len() > 512 { return Err(Error::protocol("oversized error")); } Ok(()) }
            Self::Cancelled { call, .. } => safe_id(*call),
            Self::Stopped { .. } => Ok(()),
        }
    }
}
pub fn valid_digest(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
pub fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
pub fn encode_chunk(bytes: &[u8]) -> Result<String> {
    if bytes.is_empty() || bytes.len() > MAX_CHUNK { return Err(Error::new(ErrorCode::Limit, "invalid raw chunk size")); }
    Ok(STANDARD.encode(bytes))
}
pub fn decode_chunk(data: &str) -> Result<Vec<u8>> {
    if data.is_empty() || data.len() > MAX_CHUNK.div_ceil(3) * 4 { return Err(Error::new(ErrorCode::Limit, "invalid base64 chunk size")); }
    let decoded = STANDARD.decode(data).map_err(|_| Error::protocol("invalid base64"))?;
    if decoded.len() > MAX_CHUNK { return Err(Error::new(ErrorCode::Limit, "oversized decoded chunk")); }
    Ok(decoded)
}

struct LimitedWriter { bytes: Vec<u8>, limit: usize }
impl Write for LimitedWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if data.len() > self.limit.saturating_sub(self.bytes.len()) { return Err(std::io::Error::other("encoded value exceeds byte budget")); }
        self.bytes.extend_from_slice(data); Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
pub fn encode_json<T: Serialize>(value: &T, limit: usize) -> Result<Vec<u8>> {
    let mut out = LimitedWriter { bytes: Vec::with_capacity(limit), limit };
    serde_json::to_writer(&mut out, value).map_err(|_| Error::new(ErrorCode::Limit, "JSON encoding exceeds budget or contains invalid data"))?;
    Ok(out.bytes)
}
pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let mut frame = encode_json(value, MAX_FRAME - 1)?; frame.push(b'\n'); Ok(frame)
}
/// No read_line allocation: rejects the first byte beyond the frame limit.
/// Caller must reserve its BufRead capacity in addition to MAX_FRAME.
pub fn read_frame<R: BufRead, T: DeserializeOwned>(reader: &mut R) -> Result<Option<T>> {
    let mut frame = Vec::with_capacity(MAX_FRAME);
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if frame.is_empty() { Ok(None) } else { Err(Error::protocol("truncated NDJSON frame")) };
        }
        let n = available.iter().position(|b| *b == b'\n').map_or(available.len(), |p| p + 1);
        if n > MAX_FRAME - frame.len() { return Err(Error::new(ErrorCode::Limit, "NDJSON frame exceeds 64KiB")); }
        let finished = available[n - 1] == b'\n'; frame.extend_from_slice(&available[..n]); reader.consume(n);
        if finished { return serde_json::from_slice(&frame).map(Some).map_err(|_| Error::protocol("invalid NDJSON message")); }
        if frame.len() == MAX_FRAME { return Err(Error::new(ErrorCode::Limit, "NDJSON frame lacks bounded newline")); }
    }
}

/// Bounded, ordered stream validator reusable by host result collection.
/// Hash covers decoded bytes in arrival order, including all IO stream kinds.
pub struct Reassembly { limit: usize, next: u64, bytes: usize, hash: Sha256, data: Vec<u8>, finished: bool, retain: bool }
impl Reassembly {
    pub fn new(limit: usize) -> Result<Self> {
        if limit == 0 || limit > MAX_IO_BYTES { return Err(Error::new(ErrorCode::Limit, "invalid reassembly capacity")); }
        Ok(Self { limit, next: 0, bytes: 0, hash: Sha256::new(), data: Vec::with_capacity(limit), finished: false, retain: true })
    }
    pub fn discard(&mut self) { self.data = Vec::new(); self.retain = false; }
    pub fn push(&mut self, seq: u64, data: &str) -> Result<()> { self.push_filtered(seq, data, true).map(|_| ()) }
    pub fn push_filtered(&mut self, seq: u64, data: &str, retain_chunk: bool) -> Result<usize> {
        if self.finished || seq != self.next { return Err(Error::protocol("duplicate completion or out-of-order chunk")); }
        let raw = decode_chunk(data)?;
        if raw.len() > self.limit.saturating_sub(self.bytes) { return Err(Error::new(ErrorCode::Limit, "reassembly exceeds reserved capacity")); }
        self.bytes += raw.len(); self.next += 1; self.hash.update(&raw);
        if self.retain && retain_chunk { self.data.extend_from_slice(&raw); } Ok(raw.len())
    }
    pub fn finish(&mut self, bytes: usize, sha256: &str) -> Result<Vec<u8>> {
        if self.finished || bytes != self.bytes || !valid_digest(sha256) || format!("{:x}", self.hash.clone().finalize()) != sha256 { return Err(Error::protocol("duplicate completion, byte total or digest mismatch")); }
        self.finished = true; Ok(std::mem::take(&mut self.data))
    }
}

/// IO stdout/data payload; stderr is hashed and bounded but never exposed as an error detail.
#[derive(Debug)]
pub struct IoOutput { pub data: Vec<u8>, pub exit_code: Option<i32>, pub identity: String }
impl IoOutput {
    pub fn text(self) -> Result<String> { String::from_utf8(self.data).map_err(|_| Error::protocol("host IO returned non-UTF8 text")) }
    pub fn json<T: DeserializeOwned>(self) -> Result<T> { serde_json::from_slice(&self.data).map_err(|_| Error::protocol("host IO returned invalid typed JSON")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn negotiated_result_limits_and_total_reservation_are_enforced() {
        let mut budgets = Budgets { frame_bytes: MAX_FRAME, chunk_bytes: MAX_CHUNK, result_bytes: 512 * 1024,
            max_io: MAX_IO, io_reassembly_bytes: MAX_IO_BYTES, protocol_bytes: TRANSPORT_RESERVATION + 512 * 1024 + MAX_IO_BYTES };
        budgets.validate().unwrap();
        PluginMessage::Ready { v: VERSION, generation: 1, protocol_bytes: budgets.protocol_bytes,
            io_reassembly_bytes: MAX_IO_BYTES, business_bytes: MAX_RESULT }.validate(Some(1)).unwrap();
        budgets.protocol_bytes -= 1; assert!(budgets.validate().is_err());
        budgets.protocol_bytes += 1; budgets.result_bytes = 0; assert!(budgets.validate().is_err());
        budgets.result_bytes = MAX_RESULT + 1; assert!(budgets.validate().is_err());
        assert!(PluginMessage::Ready { v: VERSION, generation: 1, protocol_bytes: usize::MAX,
            io_reassembly_bytes: MAX_IO_BYTES, business_bytes: MAX_RESULT }.validate(Some(1)).is_err());
        assert!(encode_json(&"x".repeat(512 * 1024), 512 * 1024).is_err());
    }
    use std::io::Cursor;
    #[test] fn chunk_order_total_digest_and_completion_are_enforced() {
        let mut r = Reassembly::new(10).unwrap();
        assert!(r.push(1, &encode_chunk(b"a").unwrap()).is_err());
        r.push(0, &encode_chunk(b"abc").unwrap()).unwrap();
        assert!(r.finish(4, &digest(b"abc")).is_err());
        assert!(r.finish(3, &digest(b"abd")).is_err());
        assert_eq!(r.finish(3, &digest(b"abc")).unwrap(), b"abc");
        assert!(r.finish(3, &digest(b"abc")).is_err());
        assert!(r.push(1, &encode_chunk(b"d").unwrap()).is_err());
    }
    #[test] fn limits_apply_before_accumulation() {
        assert!(encode_chunk(&vec![0; MAX_CHUNK + 1]).is_err());
        let mut r = Reassembly::new(3).unwrap();
        assert!(r.push(0, &encode_chunk(b"four").unwrap()).is_err());
        assert!(encode_frame(&"\"".repeat(MAX_FRAME)).is_err());
        assert!(read_frame::<_, serde_json::Value>(&mut Cursor::new(vec![b' '; MAX_FRAME + 1])).is_err());
        assert!(read_frame::<_, serde_json::Value>(&mut Cursor::new(b"{\"x\":1}")).is_err());
    }
    #[test] fn exact_frame_limit_and_multiple_frames() {
        let first = format!("\"{}\"\n", "x".repeat(MAX_FRAME - 3));
        let mut input = Cursor::new(format!("{first}null\n"));
        assert_eq!(read_frame::<_, String>(&mut input).unwrap().unwrap().len(), MAX_FRAME - 3);
        assert!(read_frame::<_, Option<String>>(&mut input).unwrap().unwrap().is_none());
        assert!(read_frame::<_, String>(&mut input).unwrap().is_none());
    }
    #[test] fn tagged_messages_reject_unknown_fields_and_old_generation() {
        let init = HostMessage::Initialize { v: 2, generation: 1, id: "system".into(), app_version: "0.1.0".into(), capabilities: vec![], budgets: Budgets { frame_bytes: MAX_FRAME, chunk_bytes: MAX_CHUNK, result_bytes: MAX_RESULT, max_io: MAX_IO, io_reassembly_bytes: MAX_IO_BYTES, protocol_bytes: TRANSPORT_RESERVATION + MAX_RESULT + MAX_IO_BYTES } };
        init.validate(Some(1)).unwrap();
        let mut input = Cursor::new(b"{\"type\":\"cancel\",\"v\":2,\"generation\":1,\"call\":2,\"extra\":true}\n");
        assert!(read_frame::<_, HostMessage>(&mut input).is_err());
        assert!(validate_envelope(2, 1, Some(2)).is_err());
        let end = HostMessage::IoEnd { v: 2, generation: 1, call: 1, io: 1, bytes: 0, sha256: digest(b""), stdout_bytes: usize::MAX, stderr_bytes: 1, data_bytes: 0, exit_code: Some(0), identity: "registered-command".into() };
        assert!(end.validate(Some(1)).is_err());
        assert!(safe_id(MAX_SAFE_INTEGER + 1).is_err());
    }
    #[test] fn four_megabyte_io_is_chunked_without_relaxing_frame_limit() {
        let block = vec![b'x'; MAX_CHUNK]; let encoded = encode_chunk(&block).unwrap();
        let mut r = Reassembly::new(MAX_IO_BYTES).unwrap(); let mut hash = Sha256::new();
        for seq in 0..(MAX_IO_BYTES / MAX_CHUNK) { r.push(seq as u64, &encoded).unwrap(); hash.update(&block); }
        assert_eq!(r.finish(MAX_IO_BYTES, &format!("{:x}", hash.finalize())).unwrap().len(), MAX_IO_BYTES);
    }
    #[test] fn envelope_fields_serialize_to_camel_case_tags() {
        let message = PluginMessage::Cancelled { v: 2, generation: 3, call: 4 };
        let json: serde_json::Value = serde_json::from_slice(&encode_frame(&message).unwrap()).unwrap();
        assert_eq!(json["type"], "cancelled"); assert_eq!(json["v"], 2); assert_eq!(json["generation"], 3); assert_eq!(json["call"], 4);
        let request = PluginMessage::IoRequest { v: 2, generation: 3, call: 4, io: 1, operation: IoOperation::OsInfo, max_bytes: 10, timeout_ms: 100 };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["maxBytes"], 10); assert_eq!(json["timeoutMs"], 100);
        assert!(json.get("max_bytes").is_none());
        assert!(request.validate(Some(4)).is_err());
        assert!(PluginMessage::Stopped { v: 1, generation: 3 }.validate(Some(3)).is_err());
    }
}
