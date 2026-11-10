//! One HTTP request per owned data-worker process. The parent returns only after
//! command success, stdio drain and wait, so DNS, TLS and reqwest's connection tasks
//! cannot outlive the resource lease or cancellation acknowledgement.
use crate::{error::{Error, Result}, io::{BoundedIo, CommandSpec, FileIdentity}};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use std::{ffi::{CStr, CString}, fs::File, io::{Read, Write}, os::{fd::{AsRawFd, FromRawFd, IntoRawFd}, unix::{ffi::OsStrExt, fs::MetadataExt}}, path::{Component, Path, PathBuf}, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tokio_util::sync::CancellationToken;

const VERSION: u8 = 1;
const INPUT_LIMIT: usize = 16 * 1024;
const FRAME_LIMIT: usize = 64 * 1024;
const CHUNK: usize = 16 * 1024;
const METADATA_LIMIT: usize = 256 * 1024;
const MARKET_DISK: u64 = 32 * 1024 * 1024;
const MARKET_BASE: &str = "https://raw.githubusercontent.com/Zixiaobowen/oc-chan/main/plugin-market/";
const RELEASE_BASE: &str = "https://github.com/Zixiaobowen/oc-chan-releases/releases/";
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HttpPurpose {
    Marketplace, Update,
    #[cfg(feature = "acceptance")]
    AcceptanceMarketplace,
}
impl HttpPurpose {
    fn is_market(self) -> bool { self != Self::Update }
    fn is_fixture(self) -> bool {
        #[cfg(feature = "acceptance")]
        if self == Self::AcceptanceMarketplace { return true; }
        false
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpDiskBudget { pub root: PathBuf, pub max_bytes: u64 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpRequest {
    pub purpose: HttpPurpose, pub url: String, pub target: Option<PathBuf>, pub target_parent: Option<FileIdentity>,
    pub max_bytes: usize, pub expected_size: Option<u64>, pub timeout_ms: u64, pub disk_budget: Option<HttpDiskBudget>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpResponse { pub bytes: u64, pub body: Vec<u8>, pub sha256: String, pub sha512: String, pub file_identity: Option<FileIdentity> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpProgress { pub received_bytes: u64, pub total_bytes: Option<u64> }
pub type Progress = Arc<dyn Fn(HttpProgress) -> Result<()> + Send + Sync>;
#[derive(Clone)]
pub struct HttpTransport { io: BoundedIo, worker: PathBuf }
impl HttpTransport {
    pub fn new(io: BoundedIo, worker: PathBuf) -> Self { Self { io, worker } }
    pub async fn get(&self, request: HttpRequest, cancel: &CancellationToken, progress: Option<Progress>) -> Result<HttpResponse> {
        request.validate()?;
        let input = oc_plugin_sdk::encode_json(&request, INPUT_LIMIT).map_err(|_| Error::invalid("HTTP request size"))?;
        let parser = Arc::new(Mutex::new(Parser::new(request.clone(), progress)));
        let observer = parser.clone();
        let mut command = CommandSpec::new(&self.worker, ["--http"], 1024 * 1024, Duration::from_millis(request.timeout_ms));
        command.stderr_limit = 64 * 1024; command.input = input;
        // Includes bounded worker TLS/header buffers, chunk/encoding scratch and
        // host metadata reassembly. The input is additionally charged by BoundedIo.
        command.network_file_bytes = Some(1024 * 1024 + if request.target.is_none() { request.max_bytes } else { 0 });
        command.stdout_observer = Some(Arc::new(move |bytes| observer.lock().expect("HTTP parser poisoned").push(bytes)));
        self.io.command_with_output("http", command, cancel, move |output, _| async move {
            output.success()?;
            parser.lock().expect("HTTP parser poisoned").finish()
        }).await
    }
}
impl HttpRequest {
    fn validate(&self) -> Result<()> {
        #[cfg(feature = "acceptance")]
        if self.purpose.is_fixture() { validate_acceptance_market_url(&self.url)?; }
        let url = reqwest::Url::parse(&self.url).map_err(|_| Error::invalid("HTTP URL"))?; validate_url(self.purpose, &url, false)?;
        let max = match (self.purpose, self.target.is_some()) { (HttpPurpose::Update, true) => 512 * 1024 * 1024, (HttpPurpose::Update, false) => 64 * 1024, (_, true) => 2 * 1024 * 1024, (_, false) => METADATA_LIMIT };
        if self.max_bytes == 0 || self.max_bytes > max || self.timeout_ms == 0 || self.timeout_ms > 900_000 || self.expected_size.is_some_and(|size| size == 0 || size > self.max_bytes as u64) { return Err(Error::invalid("HTTP request limits")); }
        match (&self.target, &self.target_parent) {
            (Some(target), Some(parent)) => {
                validate_path(target)?;
                if parent.uid != unsafe { libc::getuid() } || parent.mode & 0o077 != 0 || parent.mode & libc::S_IFMT as u32 != libc::S_IFDIR as u32 || self.expected_size.is_none() { return Err(Error::invalid("HTTP target parent identity")); }
                if self.purpose.is_market() && !url.path().ends_with(".ocplugin") { return Err(Error::invalid("market archive URL")); }
                if self.purpose == HttpPurpose::Update && !url.path().ends_with(".zip") { return Err(Error::invalid("update archive URL")); }
            }
            (None, None) => {
                let expected = match self.purpose {
                    HttpPurpose::Marketplace => format!("{MARKET_BASE}catalog.json"), HttpPurpose::Update => format!("{RELEASE_BASE}latest/download/latest.json"),
                    #[cfg(feature = "acceptance")]
                    HttpPurpose::AcceptanceMarketplace => { if !url.path().ends_with("/catalog.json") { return Err(Error::invalid("acceptance catalog filename")); } url.to_string() }
                };
                if self.url != expected || self.disk_budget.is_some() { return Err(Error::invalid("fixed HTTP metadata URL")); }
            }
            _ => return Err(Error::invalid("HTTP target identity pair")),
        }
        if let Some(budget) = &self.disk_budget {
            validate_path(&budget.root)?;
            if !self.purpose.is_market() || budget.max_bytes != MARKET_DISK || !self.target.as_ref().is_some_and(|target| target.starts_with(&budget.root) && target != &budget.root) { return Err(Error::invalid("HTTP market disk budget")); }
        } else if self.purpose.is_market() && self.target.is_some() { return Err(Error::invalid("market downloads require installation disk budget")); }
        Ok(())
    }
}
fn validate_path(path: &Path) -> Result<()> {
    if !path.is_absolute() || path.as_os_str().as_bytes().len() > 4096 || path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) || path.as_os_str().as_bytes().contains(&0) { return Err(Error::invalid("HTTP private target path")); } Ok(())
}
fn validate_url(purpose: HttpPurpose, url: &reqwest::Url, redirected: bool) -> Result<()> {
    #[cfg(feature = "acceptance")]
    if purpose == HttpPurpose::AcceptanceMarketplace {
        if redirected { return Err(Error::invalid("acceptance feed redirect")); }
        return validate_acceptance_market_url(url.as_str());
    }
    if url.as_str().len() > 8192 || url.scheme() != "https" || url.as_str().trim_start_matches("https://").split('/').next().is_some_and(|authority| authority.contains('@')) || url.fragment().is_some() || url.port().is_some_and(|port| port != 443) { return Err(Error::invalid("HTTPS source")); }
    match purpose {
        #[cfg(feature = "acceptance")]
        HttpPurpose::AcceptanceMarketplace => unreachable!("acceptance URL handled above"),
        HttpPurpose::Marketplace => {
            let name = url.as_str().strip_prefix(MARKET_BASE).ok_or_else(|| Error::invalid("official market URL"))?;
            if url.query().is_some() || name.is_empty() || name.len() > 128 || name.contains("..") || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)) { return Err(Error::invalid("official market filename")); }
        }
        HttpPurpose::Update => {
            if redirected {
                if !matches!(url.host_str(), Some("github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com")) { return Err(Error::invalid("update redirect host")); }
                if url.host_str() == Some("github.com") && !url.path().starts_with("/Zixiaobowen/oc-chan-releases/releases/") { return Err(Error::invalid("update redirect repository")); }
            } else {
                if url.query().is_some() { return Err(Error::invalid("update initial query")); }
                let suffix = url.as_str().strip_prefix(RELEASE_BASE).ok_or_else(|| Error::invalid("official update repository"))?;
                if suffix != "latest/download/latest.json" {
                    let path = suffix.strip_prefix("download/v").ok_or_else(|| Error::invalid("update asset path"))?;
                    let (version, name) = path.split_once('/').ok_or_else(|| Error::invalid("update asset version"))?;
                    let parsed = semver::Version::parse(version).map_err(|_| Error::invalid("update asset version"))?;
                    if version.len() > 64 || !parsed.pre.is_empty() || !parsed.build.is_empty() || parsed.to_string() != version || name != format!("OC-Chan-{version}-mac-arm64.zip") { return Err(Error::invalid("stable update asset")); }
                }
            }
        }
    }
    Ok(())
}

/// No DNS, credentials, queries, encoding aliases or cross-origin redirects.
#[cfg(feature = "acceptance")]
pub(crate) fn validate_acceptance_market_url(value: &str) -> Result<()> {
    let url = reqwest::Url::parse(value).map_err(|_| Error::invalid("acceptance market URL"))?;
    if value.len() > 2048 || url.as_str() != value || url.scheme() != "http" || url.host_str() != Some("127.0.0.1")
        || url.port().is_none_or(|port| port == 0) || value.split('/').nth(2).is_none_or(|authority| authority.contains('@')) || url.query().is_some() || url.fragment().is_some()
        || url.path().split('/').skip(1).any(|part| part.is_empty() || part.len() > 128 || part.contains("..") || !part.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))) {
        return Err(Error::invalid("explicit loopback-only acceptance feed"));
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum Frame {
    Progress { v: u8, received_bytes: u64, total_bytes: Option<u64> },
    Data { v: u8, seq: u64, data: String },
    Complete { v: u8, bytes: u64, sha256: String, sha512: String, file_identity: Option<FileIdentity> },
    Failure { v: u8, error: Error },
}
struct Parser {
    request: HttpRequest, progress: Option<Progress>, line: Vec<u8>, body: Vec<u8>, sequence: u64,
    transferred: u64, hash256: Sha256, hash512: Sha512, terminal: Option<Result<HttpResponse>>,
}
impl Parser {
    fn new(request: HttpRequest, progress: Option<Progress>) -> Self { Self { request, progress, line: Vec::new(), body: Vec::new(), sequence: 0, transferred: 0, hash256: Sha256::new(), hash512: Sha512::new(), terminal: None } }
    fn push(&mut self, mut bytes: &[u8]) -> Result<()> {
        while !bytes.is_empty() {
            if self.terminal.is_some() { return Err(Error::new("OC_HTTP_PROTOCOL", "Output after HTTP terminal result")); }
            let count = bytes.iter().position(|byte| *byte == b'\n').map_or(bytes.len(), |n| n + 1);
            if count > FRAME_LIMIT.saturating_sub(self.line.len()) { return Err(Error::limit("HTTP worker frame", FRAME_LIMIT, self.line.len() + count)); }
            if self.line.capacity() == 0 { self.line.reserve_exact(FRAME_LIMIT); }
            self.line.extend_from_slice(&bytes[..count]); bytes = &bytes[count..];
            if self.line.last() == Some(&b'\n') {
                let frame: Frame = serde_json::from_slice(&self.line).map_err(|_| Error::new("OC_HTTP_PROTOCOL", "Invalid HTTP worker message"))?;
                self.line.clear(); self.frame(frame)?;
            }
        }
        Ok(())
    }
    fn frame(&mut self, frame: Frame) -> Result<()> {
        match frame {
            Frame::Progress { v: VERSION, received_bytes, total_bytes } => {
                if received_bytes < self.transferred || received_bytes > self.request.max_bytes as u64 || total_bytes.is_some_and(|total| total > self.request.max_bytes as u64 || total < received_bytes)
                    || self.request.expected_size.zip(total_bytes).is_some_and(|(expected, total)| expected != total) { return Err(Error::new("OC_HTTP_PROTOCOL", "Invalid HTTP progress")); }
                self.transferred = received_bytes;
                if let Some(progress) = &self.progress { progress(HttpProgress { received_bytes, total_bytes })?; }
            }
            Frame::Data { v: VERSION, seq, data } => {
                if self.request.target.is_some() || seq != self.sequence || data.len() > CHUNK.div_ceil(3) * 4 { return Err(Error::new("OC_HTTP_PROTOCOL", "Invalid HTTP body chunk")); }
                let decoded = STANDARD.decode(&data).map_err(|_| Error::new("OC_HTTP_PROTOCOL", "Invalid HTTP chunk encoding"))?;
                if decoded.is_empty() || decoded.len() > CHUNK || decoded.len() > self.request.max_bytes.saturating_sub(self.body.len()) { return Err(Error::limit("HTTP metadata", self.request.max_bytes, self.body.len() + decoded.len())); }
                if self.body.capacity() == 0 { self.body.reserve_exact(self.request.max_bytes); }
                self.body.extend_from_slice(&decoded); self.hash256.update(&decoded); self.hash512.update(&decoded); self.sequence += 1;
            }
            Frame::Complete { v: VERSION, bytes, sha256, sha512, file_identity } => {
                if bytes > self.request.max_bytes as u64 || bytes < self.transferred || self.request.expected_size.is_some_and(|expected| expected != bytes)
                    || !oc_plugin_sdk::valid_digest(&sha256) || STANDARD.decode(&sha512).map_or(true, |digest| digest.len() != 64 || STANDARD.encode(&digest) != sha512) { return Err(Error::new("OC_HTTP_PROTOCOL", "Invalid HTTP completion")); }
                if self.request.target.is_some() {
                    let identity = file_identity.as_ref().ok_or_else(|| Error::new("OC_HTTP_PROTOCOL", "Missing HTTP target identity"))?;
                    if !self.body.is_empty() || identity.size != bytes || identity.uid != unsafe { libc::getuid() } || identity.nlink != 1 || identity.mode & 0o077 != 0 || identity.mode & libc::S_IFMT as u32 != libc::S_IFREG as u32 { return Err(Error::new("OC_HTTP_PROTOCOL", "Invalid HTTP target identity")); }
                } else if file_identity.is_some() || bytes != self.body.len() as u64 || sha256 != format!("{:x}", self.hash256.clone().finalize()) || sha512 != STANDARD.encode(self.hash512.clone().finalize()) {
                    return Err(Error::new("OC_HTTP_PROTOCOL", "HTTP metadata digest mismatch"));
                }
                self.terminal = Some(Ok(HttpResponse { bytes, body: std::mem::take(&mut self.body), sha256, sha512, file_identity }));
            }
            Frame::Failure { v: VERSION, error } => {
                if error.message.len() > 1024 || error.code.len() > 64 || error.causes.len() > 16 { return Err(Error::new("OC_HTTP_PROTOCOL", "Unbounded HTTP worker error")); }
                self.terminal = Some(Err(error));
            }
            _ => return Err(Error::new("OC_HTTP_PROTOCOL", "Unsupported HTTP worker version")),
        }
        Ok(())
    }
    fn finish(&mut self) -> Result<HttpResponse> {
        if !self.line.is_empty() { return Err(Error::new("OC_HTTP_PROTOCOL", "Truncated HTTP worker frame")); }
        self.terminal.take().ok_or_else(|| Error::new("OC_HTTP_PROTOCOL", "HTTP worker exited without a final result"))?
    }
}
fn emit(output: &mut impl Write, frame: Frame) -> Result<()> {
    let mut bytes = oc_plugin_sdk::encode_json(&frame, FRAME_LIMIT - 1).map_err(|_| Error::limit("HTTP worker frame", FRAME_LIMIT, FRAME_LIMIT + 1))?;
    bytes.push(b'\n'); output.write_all(&bytes).map_err(|error| Error::io("HTTP protocol output", error))?;
    output.flush().map_err(|error| Error::io("HTTP protocol flush", error))
}
pub fn run_worker() -> Result<()> {
    let mut input = Vec::with_capacity(INPUT_LIMIT + 1);
    std::io::stdin().take((INPUT_LIMIT + 1) as u64).read_to_end(&mut input).map_err(|error| Error::io("HTTP request input", error))?;
    let mut output = std::io::stdout().lock();
    let result: Result<HttpResponse> = (|| {
        if input.len() > INPUT_LIMIT { return Err(Error::limit("HTTP request", INPUT_LIMIT, input.len())); }
        let request: HttpRequest = serde_json::from_slice(&input).map_err(|_| Error::invalid("HTTP worker request"))?; request.validate()?;
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| Error::io("HTTP worker runtime", error))?;
        let result = runtime.block_on(fetch(request, &mut output));
        // DNS/blocking tasks and every connection driver are dropped/joined before
        // the final protocol result. The parent additionally waits for process exit.
        drop(runtime); result
    })();
    match result {
        Ok(response) => emit(&mut output, Frame::Complete { v: VERSION, bytes: response.bytes, sha256: response.sha256, sha512: response.sha512, file_identity: response.file_identity }),
        Err(error) => emit(&mut output, Frame::Failure { v: VERSION, error }),
    }
}
async fn fetch(request: HttpRequest, output: &mut impl Write) -> Result<HttpResponse> {
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).https_only(!request.purpose.is_fixture()).http1_only().no_proxy().pool_max_idle_per_host(0)
        .connect_timeout(Duration::from_secs(10)).build().map_err(|_| Error::new("OC_HTTP_NETWORK", "HTTP client initialization failed"))?;
    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    let mut url = reqwest::Url::parse(&request.url).map_err(|_| Error::invalid("HTTP source"))?;
    let redirects = if request.purpose == HttpPurpose::Update { 5 } else if request.purpose.is_fixture() { 0 } else { 3 };
    let mut response = None;
    for attempt in 0..=redirects {
        validate_url(request.purpose, &url, attempt > 0)?;
        let remaining = deadline.saturating_duration_since(Instant::now()); if remaining.is_zero() { return Err(Error::timeout("HTTP request")); }
        let value = client.get(url.clone()).header(reqwest::header::ACCEPT_ENCODING, "identity").timeout(remaining).send().await.map_err(network_error)?;
        if value.status().is_redirection() {
            if attempt == redirects { return Err(Error::new("OC_HTTP_REDIRECT", "HTTP redirect limit exceeded")); }
            let location = value.headers().get(reqwest::header::LOCATION).and_then(|value| value.to_str().ok()).filter(|value| value.len() <= 8192).ok_or_else(|| Error::invalid("HTTP redirect location"))?;
            url = url.join(location).map_err(|_| Error::invalid("HTTP redirect URL"))?; continue;
        }
        if value.status() != reqwest::StatusCode::OK { return Err(Error::new("OC_HTTP_STATUS", format!("HTTP source returned status {}", value.status().as_u16()))); }
        if value.headers().get_all(reqwest::header::CONTENT_ENCODING).iter().any(|encoding| encoding != "identity") { return Err(Error::invalid("HTTP content encoding")); }
        response = Some(value); break;
    }
    let response = response.ok_or_else(|| Error::new("OC_HTTP_REDIRECT", "Missing final HTTP response"))?;
    let lengths = response.headers().get_all(reqwest::header::CONTENT_LENGTH);
    let mut lengths = lengths.iter();
    let declared = lengths.next().map(|length| {
        let text = length.to_str().map_err(|_| Error::invalid("HTTP content length"))?;
        if text.is_empty() || text.len() > 20 || !text.bytes().all(|byte| byte.is_ascii_digit()) { return Err(Error::invalid("HTTP content length")); }
        text.parse::<u64>().map_err(|_| Error::invalid("HTTP content length"))
    }).transpose()?;
    if lengths.next().is_some() { return Err(Error::invalid("duplicate HTTP content length")); }
    if declared.is_some_and(|size| size > request.max_bytes as u64) || request.expected_size.zip(declared).is_some_and(|(expected, declared)| expected != declared) { return Err(Error::new("OC_HTTP_SIZE", "HTTP declared size mismatch")); }
    let budget = request.disk_budget.as_ref().map(|budget| Directory::open(&budget.root, true)).transpose()?;
    let opening = request.target.as_ref().map(|path| Target::create(path, request.target_parent.as_ref().expect("validated parent"), request.disk_budget.as_ref().zip(budget.as_ref()))).transpose();
    let mut target = match opening { Ok(target) => target, Err(error) => return if let Some(root) = budget { merge(Err(error), root.close()) } else { Err(error) } };
    let result = async {
        let mut stream = response.bytes_stream(); let mut received = 0u64; let mut sequence = 0u64;
        let mut hash256 = Sha256::new(); let mut hash512 = Sha512::new(); let mut progress_at = Instant::now();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(network_error)?;
            if Instant::now() >= deadline { return Err(Error::timeout("HTTP body")); }
            if chunk.len() as u64 > request.max_bytes as u64 - received { return Err(Error::limit("HTTP body", request.max_bytes, received as usize + chunk.len())); }
            for part in chunk.chunks(CHUNK) {
                if let Some(target) = &mut target {
                    if let Some(root) = &budget { let used = root.usage(0)?; if part.len() as u64 > MARKET_DISK.saturating_sub(used) { return Err(Error::limit("plugin disk", MARKET_DISK as usize, used as usize + part.len())); } }
                    target.file.write_all(part).map_err(|error| Error::io("HTTP target write", error))?;
                } else {
                    emit(output, Frame::Data { v: VERSION, seq: sequence, data: STANDARD.encode(part) })?; sequence += 1;
                }
                received += part.len() as u64; hash256.update(part); hash512.update(part);
            }
            if progress_at.elapsed() >= Duration::from_millis(250) { emit(output, Frame::Progress { v: VERSION, received_bytes: received, total_bytes: declared.or(request.expected_size) })?; progress_at = Instant::now(); }
        }
        if declared.is_some_and(|size| size != received) || request.expected_size.is_some_and(|size| size != received) { return Err(Error::new("OC_HTTP_SIZE", "HTTP actual size mismatch")); }
        let file_identity = if let Some(target) = &target { Some(target.finish(received)?) } else { None };
        Ok(HttpResponse { bytes: received, body: Vec::new(), sha256: format!("{:x}", hash256.finalize()), sha512: STANDARD.encode(hash512.finalize()), file_identity })
    }.await;
    let result = if let Some(target) = target { merge(result, target.close()) } else { result };
    if let Some(root) = budget { merge(result, root.close()) } else { result }
}
fn network_error(error: reqwest::Error) -> Error { if error.is_timeout() { Error::timeout("HTTP network") } else { Error::new("OC_HTTP_NETWORK", "HTTP DNS, TLS or response transfer failed") } }
struct Directory { file: File }
impl Directory {
    fn open(path: &Path, private: bool) -> Result<Self> {
        validate_path(path)?;
        let fd = unsafe { libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
        if fd < 0 { return Err(last("HTTP root open")); }
        let mut directory = Self { file: unsafe { File::from_raw_fd(fd) } };
        for component in path.components() {
            if let Component::Normal(name) = component { directory = directory.descend(name.as_bytes(), false)?; }
        }
        directory.checked(private)
    }
    fn child(&self, name: &[u8], private: bool) -> Result<Self> {
        let name = CString::new(name).map_err(|_| Error::invalid("HTTP directory name"))?;
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { return Err(last("HTTP target directory open")); }
        Self { file: unsafe { File::from_raw_fd(fd) } }.checked(private)
    }
    fn private(&self) -> Result<()> {
        let metadata = self.file.metadata().map_err(|error| Error::io("HTTP target directory metadata", error))?;
        if metadata.uid() != unsafe { libc::getuid() } || metadata.mode() & 0o077 != 0 { return Err(Error::invalid("HTTP private directory ownership")); } Ok(())
    }
    fn identity(&self) -> Result<FileIdentity> { Ok(FileIdentity::from_metadata(&self.file.metadata().map_err(|error| Error::io("HTTP directory identity", error))?)) }
    fn close(self) -> Result<()> { close_fd(self.file.into_raw_fd()) }
    fn checked(self, private: bool) -> Result<Self> {
        if private { if let Err(error) = self.private() { return merge(Err(error), self.close()); } } Ok(self)
    }
    fn descend(self, name: &[u8], private: bool) -> Result<Self> {
        let next = self.child(name, private);
        match (next, self.close()) { (next, Ok(())) => next, (Err(first), Err(last)) => Err(Error::aggregate(vec![first, last])), (Ok(next), Err(error)) => merge(Err(error), next.close()) }
    }
    fn usage(&self, depth: usize) -> Result<u64> {
        if depth > 10 { return Err(Error::invalid("market directory depth")); }
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), c".".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { return Err(last("HTTP budget directory open")); }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() { let error = last("HTTP budget directory stream"); close_fd(fd)?; return Err(error); }
        let result = (|| {
            let mut total = 0u64; let mut count = 0;
            loop {
                unsafe { *libc::__error() = 0; } let entry = unsafe { libc::readdir(stream) };
                if entry.is_null() { if unsafe { *libc::__error() } != 0 { return Err(last("HTTP budget directory read")); } break; }
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
                if name.to_bytes() == b"." || name.to_bytes() == b".." { continue; }
                count += 1; if count > 64 { return Err(Error::limit("market directory entries", 64, count)); }
                let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
                if unsafe { libc::fstatat(self.file.as_raw_fd(), name.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 { return Err(last("HTTP budget metadata")); }
                let stat = unsafe { stat.assume_init() };
                let bytes = match stat.st_mode & libc::S_IFMT {
                    libc::S_IFDIR => { let child = self.child(name.to_bytes(), true)?; merge(child.usage(depth + 1), child.close())? },
                    libc::S_IFREG if stat.st_nlink == 1 && stat.st_size >= 0 && stat.st_uid == unsafe { libc::getuid() } && stat.st_mode & 0o022 == 0 => stat.st_size as u64,
                    _ => return Err(Error::invalid("market budget file type")),
                };
                total = total.checked_add(bytes).ok_or_else(|| Error::invalid("market disk total"))?;
                if total > MARKET_DISK { return Err(Error::limit("market disk", MARKET_DISK as usize, total as usize)); }
            }
            Ok(total)
        })();
        let close = if unsafe { libc::closedir(stream) } == 0 { Ok(()) } else { Err(Error::cleanup("HTTP directory", last("closedir"))) };
        merge(result, close)
    }
}
struct Target { file: File, parent: Directory, name: CString }
impl Target {
    fn create(path: &Path, expected: &FileIdentity, budget: Option<(&HttpDiskBudget, &Directory)>) -> Result<Self> {
        let parent_path = path.parent().ok_or_else(|| Error::invalid("HTTP target parent"))?;
        let parent = if let Some((spec, root)) = budget {
            let relative = parent_path.strip_prefix(&spec.root).map_err(|_| Error::invalid("HTTP target outside disk budget"))?;
            let mut parent = root.child(b".", true)?;
            for component in relative.components() { if let Component::Normal(name) = component { parent = parent.descend(name.as_bytes(), true)?; } }
            parent
        } else { Directory::open(parent_path, true)? };
        let opening = (|| {
            if !parent.identity()?.same_file(expected) { return Err(Error::new("OC_HTTP_IDENTITY", "HTTP target parent was replaced")); }
            let name = CString::new(path.file_name().ok_or_else(|| Error::invalid("HTTP target name"))?.as_bytes()).map_err(|_| Error::invalid("HTTP target name"))?;
            let fd = unsafe { libc::openat(parent.file.as_raw_fd(), name.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC, 0o600) };
            if fd < 0 { return Err(last("HTTP exclusive target create")); }
            Ok((unsafe { File::from_raw_fd(fd) }, name))
        })();
        match opening { Ok((file, name)) => Ok(Self { file, parent, name }), Err(error) => merge(Err(error), parent.close()) }
    }
    fn finish(&self, bytes: u64) -> Result<FileIdentity> {
        self.file.sync_all().map_err(|error| Error::io("HTTP target fsync", error))?;
        let metadata = self.file.metadata().map_err(|error| Error::io("HTTP target metadata", error))?;
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() != bytes || metadata.uid() != unsafe { libc::getuid() } || metadata.mode() & 0o077 != 0 { return Err(Error::new("OC_HTTP_IDENTITY", "HTTP target file changed")); }
        let mut named = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstatat(self.parent.file.as_raw_fd(), self.name.as_ptr(), named.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 { return Err(last("HTTP target name identity")); }
        let named = unsafe { named.assume_init() };
        if named.st_ino as u64 != metadata.ino() || named.st_dev as u64 != metadata.dev() { return Err(Error::new("OC_HTTP_IDENTITY", "HTTP target name was replaced")); }
        self.parent.file.sync_all().map_err(|error| Error::io("HTTP target directory fsync", error))?;
        Ok(FileIdentity::from_metadata(&metadata))
    }
    fn close(self) -> Result<()> { let result = close_fd(self.file.into_raw_fd()); merge(result, close_fd(self.parent.file.into_raw_fd())) }
}
fn close_fd(fd: i32) -> Result<()> { if unsafe { libc::close(fd) } == 0 { Ok(()) } else { Err(Error::cleanup("HTTP file descriptor", last("close"))) } }
fn last(operation: &str) -> Error { Error::io(operation, std::io::Error::last_os_error()) }
fn merge<T>(result: Result<T>, cleanup: Result<()>) -> Result<T> { match (result, cleanup) { (result, Ok(())) => result, (Ok(_), Err(error)) => Err(error), (Err(first), Err(last)) => Err(Error::aggregate(vec![first, last])) } }

#[cfg(test)]
mod tests;
