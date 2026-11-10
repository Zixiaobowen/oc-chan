use serde::{Deserialize, Serialize};
use std::{fmt, io};

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Only controlled context and OS error numbers cross the desktop boundary.
/// Command output, prompts, credentials and arbitrary error strings do not.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Error {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_error: Option<i32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub causes: Vec<Error>,
}

impl Error {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), os_error: None, causes: Vec::new() }
    }
    pub fn cancelled() -> Self { Self::new("ABORT_ERR", "操作已取消 / Operation cancelled") }
    pub fn timeout(operation: &str) -> Self { Self::new("ETIMEDOUT", format!("操作超时 / Operation timed out: {operation}")) }
    pub fn limit(scope: &str, limit: usize, observed: usize) -> Self {
        Self::new("OC_COLLECTION_LIMIT", format!("采集超过上限 / Collection limit ({scope}: {observed}/{limit}); result is incomplete"))
    }
    pub fn invalid(scope: &str) -> Self { Self::new("OC_INVALID_INPUT", format!("输入无效 / Invalid input: {scope}")) }
    pub fn io(operation: &str, error: io::Error) -> Self {
        let errno = error.raw_os_error();
        let code = match errno {
            Some(libc::ENOENT) => "ENOENT", Some(libc::EACCES) => "EACCES", Some(libc::EPERM) => "EPERM",
            Some(libc::ENOSPC) => "ENOSPC", Some(libc::EDQUOT) => "EDQUOT", Some(libc::EROFS) => "EROFS",
            Some(libc::EEXIST) => "EEXIST", Some(libc::EISDIR) => "EISDIR", Some(libc::ENOTDIR) => "ENOTDIR",
            Some(libc::ELOOP) => "ELOOP", Some(libc::EBADF) => "EBADF", Some(libc::EMFILE) => "EMFILE",
            Some(libc::ENFILE) => "ENFILE", Some(libc::ETIMEDOUT) => "ETIMEDOUT", _ => "EIO",
        };
        Self { code: code.into(), message: format!("{operation}: {code}"), os_error: errno, causes: Vec::new() }
    }
    pub fn cleanup(resource: &str, error: Self) -> Self {
        Self { code: "OC_RESOURCE_CLOSE".into(), message: format!("资源释放失败 / Resource cleanup failed: {resource}"), os_error: None, causes: vec![error] }
    }
    pub fn aggregate(mut errors: Vec<Self>) -> Self {
        assert!(!errors.is_empty(), "error aggregation requires a failure");
        if errors.len() == 1 { return errors.remove(0); }
        let cleanup = errors.iter().any(Self::is_cleanup);
        let cancelled = errors.iter().all(Self::is_cancelled);
        let omitted = errors.len().saturating_sub(16);
        errors.truncate(16);
        Self {
            code: if cleanup { "OC_RESOURCE_CLOSE" } else if cancelled { "ABORT_ERR" } else { "OC_MULTIPLE_FAILURES" }.into(),
            message: format!("多项操作失败 / Multiple operations failed; omitted causes: {omitted}"),
            os_error: None, causes: errors,
        }
    }
    pub fn is_cancelled(&self) -> bool { self.code == "ABORT_ERR" }
    pub fn is_cleanup(&self) -> bool { self.code == "OC_RESOURCE_CLOSE" }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}: {}", self.code, self.message) }
}
impl std::error::Error for Error {}

pub fn check_cancel(cancel: &tokio_util::sync::CancellationToken) -> Result<()> {
    if cancel.is_cancelled() { Err(Error::cancelled()) } else { Ok(()) }
}

pub fn validate_text(value: &str, utf16_limit: usize, byte_limit: usize, field: &str) -> Result<()> {
    if value.is_empty() || value.len() > byte_limit || value.encode_utf16().count() > utf16_limit
        || value.chars().any(|ch| ch <= '\u{001f}' || ch == '\u{007f}') {
        return Err(Error::invalid(field));
    }
    Ok(())
}

pub fn timestamp() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }
