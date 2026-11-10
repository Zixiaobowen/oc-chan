//! One request per native process. The shared IO supervisor owns cancellation,
//! process-group termination, pipe draining and reaping before releasing capacity.
use std::{ffi::OsString, io::{self, Write}, path::{Path, PathBuf}, time::Duration};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use crate::{error::{Error, Result, check_cancel}, io::{BoundedIo, CommandSpec}};
pub(crate) mod hermes;
mod events;

const MAX_INPUT: usize = 512 * 1024;
const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const MAX_STDERR: usize = 64 * 1024;
#[derive(Clone)]
pub struct DataWorker { io: BoundedIo, executable: PathBuf }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestRef<'a> { operation: &'a str, database: &'a Path, input: &'a Value }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request { operation: String, database: PathBuf, input: Value }
#[derive(Serialize, Deserialize)]
#[serde(tag = "status", content = "value", rename_all = "camelCase", deny_unknown_fields)]
enum Reply { Success(Value), Failure(Error) }

fn output_limit(operation: &str) -> usize { if operation == "hermes-history" { 128 * 1024 } else { MAX_OUTPUT } }
fn validate(operation: &str, database: &Path) -> Result<&'static str> {
    if operation.len() > 64 || !operation.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'-')
        || !database.is_absolute() || database.as_os_str().len() > 4096 {
        return Err(Error::invalid("database worker request"));
    }
    match operation {
        "hermes-history" => Ok("history"),
        "hermes-runtime" => Ok("schedules"),
        "hermes-events" => Ok("events"),
        value if value.starts_with("events-") => Ok("events"),
        _ => Err(Error::invalid("database worker operation")),
    }
}
impl DataWorker {
    pub fn new(io: BoundedIo, executable: PathBuf) -> Self { Self { io, executable } }
    pub async fn request(&self, operation: &str, database: &Path, input: Value, cancel: &CancellationToken) -> Result<Value> {
        check_cancel(cancel)?;
        let source = validate(operation, database)?;
        let bytes = encode(&RequestRef { operation, database, input: &input }, MAX_INPUT)?;
        let mut spec = CommandSpec::new(self.executable.clone(), Vec::<OsString>::new(), output_limit(operation), Duration::from_secs(3));
        spec.stderr_limit = MAX_STDERR; spec.input = bytes;
        let output = self.io.command(source, spec, cancel).await?.success()?;
        if !output.stderr.is_empty() {
            return Err(Error::new("OC_WORKER_STDERR", format!("数据库工作进程输出异常诊断 / Database worker wrote unexpected diagnostics ({} bytes)", output.stderr.len())));
        }
        check_cancel(cancel)?;
        let reply: Reply = serde_json::from_slice(&output.stdout).map_err(|_| Error::new("OC_WORKER_PROTOCOL", "数据库工作进程响应无效 / Invalid database worker response"))?;
        match reply { Reply::Success(value) => Ok(value), Reply::Failure(error) => Err(error) }
    }
}

struct LimitedBytes { bytes: Vec<u8>, limit: usize, rejected: Option<Error> }
impl LimitedBytes {
    fn new(limit: usize) -> Self { Self { bytes: Vec::new(), limit, rejected: None } }
    fn failure(&mut self, error: io::Error) -> Error {
        self.rejected.take().unwrap_or_else(|| Error::io("worker byte stream", error))
    }
}
impl Write for LimitedBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.rejected = Some(Error::limit("database worker bytes", self.limit, self.bytes.len().saturating_add(bytes.len())));
            return Err(io::Error::other("database worker byte limit"));
        }
        let needed = self.bytes.len() + bytes.len();
        if needed > self.bytes.capacity() {
            let capacity = self.bytes.capacity().max(1024).saturating_mul(2).min(self.limit).max(needed);
            if self.bytes.try_reserve_exact(capacity - self.bytes.len()).is_err() {
                self.rejected = Some(Error::new("OC_RESOURCE_LIMIT", "bounded database worker allocation refused"));
                return Err(io::Error::other("bounded allocation refused"));
            }
        }
        self.bytes.extend_from_slice(bytes); Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}
fn encode(value: &impl Serialize, limit: usize) -> Result<Vec<u8>> {
    let mut buffer = LimitedBytes::new(limit);
    if serde_json::to_writer(&mut buffer, value).is_err() {
        return Err(buffer.rejected.take().unwrap_or_else(|| Error::invalid("database worker JSON")));
    }
    Ok(buffer.bytes)
}
fn read_request() -> Result<Request> {
    let mut buffer = LimitedBytes::new(MAX_INPUT);
    if let Err(error) = io::copy(&mut io::stdin().lock(), &mut buffer) { return Err(buffer.failure(error)); }
    serde_json::from_slice(&buffer.bytes).map_err(|_| Error::invalid("database worker JSON"))
}
fn execute(request: Request) -> Result<Value> {
    validate(&request.operation, &request.database)?;
    match request.operation.as_str() {
        "hermes-history" | "hermes-runtime" => hermes::execute(&request.operation, &request.database, request.input),
        _ => events::execute(&request.operation, &request.database, request.input),
    }
}
/// Only the dedicated oc-data-worker binary invokes this synchronous entry point.
/// Domain failures have a typed reply; broken stdio is a nonzero process exit.
pub fn run_stdio() -> Result<()> {
    let request = read_request();
    let maximum = request.as_ref().map_or(MAX_OUTPUT, |request| output_limit(&request.operation));
    let reply = match request.and_then(execute) { Ok(value) => Reply::Success(value), Err(error) => Reply::Failure(error) };
    let bytes = match encode(&reply, maximum - 1) {
        Ok(bytes) => bytes,
        Err(error) => { drop(reply); encode(&Reply::Failure(error), 64 * 1024)? },
    };
    let mut stdout = io::stdout().lock();
    stdout.write_all(&bytes).and_then(|_| stdout.write_all(b"\n")).and_then(|_| stdout.flush()).map_err(|e| Error::io("database worker reply", e))
}
