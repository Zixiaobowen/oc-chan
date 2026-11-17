use crate::{ensure, reject, Result};
use serde::{Deserialize, Serialize};
use std::{os::unix::ffi::OsStrExt, path::PathBuf};
#[cfg(target_os = "linux")]
use std::fs;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: i32,
    pub birth_seconds: u64,
    pub birth_fraction: u64,
    pub executable: PathBuf,
}
impl ProcessIdentity {
    pub fn current() -> Result<Self> { Self::inspect(std::process::id() as i32)?.ok_or_else(|| reject("current process vanished")) }
    pub fn inspect(pid: i32) -> Result<Option<Self>> {
        ensure(pid > 1, "invalid process PID")?;
        platform_identity(pid)
    }
    pub(crate) fn same_birth(&self, other: &Self) -> bool {
        self.pid == other.pid && self.birth_seconds == other.birth_seconds && self.birth_fraction == other.birth_fraction
    }
    pub(crate) fn live(&self) -> Result<bool> {
        match Self::inspect(self.pid)? {
            None => Ok(false),
            Some(actual) => {
                ensure(self.same_birth(&actual), "PID reused by an unknown process; preserving transaction")?;
                ensure(self.executable == actual.executable, "process executable identity changed")?;
                Ok(true)
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn platform_identity(pid: i32) -> Result<Option<ProcessIdentity>> {
    // proc_bsdinfo is a fixed public libproc ABI, including microsecond birth time.
    #[repr(C)]
    struct BsdInfo {
        flags: u32, status: u32, xstatus: u32, pid: u32, ppid: u32,
        uid: u32, gid: u32, ruid: u32, rgid: u32, svuid: u32, svgid: u32,
        rfu_1: u32, comm: [u8; 16], name: [u8; 32], nfiles: u32, pgid: u32,
        pjobc: u32, e_tdev: u32, e_tpgid: u32, nice: i32,
        start_tvsec: u64, start_tvusec: u64,
    }
    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut libc::c_void, size: i32) -> i32;
        fn proc_pidpath(pid: i32, buffer: *mut libc::c_void, size: u32) -> i32;
    }
    let mut info = std::mem::MaybeUninit::<BsdInfo>::uninit();
    let n = unsafe { proc_pidinfo(pid, 3, 0, info.as_mut_ptr().cast(), std::mem::size_of::<BsdInfo>() as i32) };
    if n == 0 {
        let e = std::io::Error::last_os_error();
        if matches!(e.raw_os_error(), Some(libc::ESRCH | libc::ENOENT)) { return Ok(None); }
        return Err(crate::Error::Io { operation: "read process birth".into(), source: e });
    }
    ensure(n as usize == std::mem::size_of::<BsdInfo>(), "incomplete libproc process identity")?;
    let info = unsafe { info.assume_init() };
    if info.status == 5 { return Ok(None); } // SZOMB: terminated, safe to reap.
    let mut path = [0u8; 4096];
    let n = unsafe { proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if n <= 0 {
        let e = std::io::Error::last_os_error();
        if matches!(e.raw_os_error(), Some(libc::ESRCH | libc::ENOENT)) { return Ok(None); }
        return Err(crate::Error::Io { operation: "read process executable".into(), source: e });
    }
    let length = path.iter().position(|b| *b == 0).ok_or_else(|| reject("unterminated process executable path"))?;
    Ok(Some(ProcessIdentity { pid, birth_seconds: info.start_tvsec, birth_fraction: info.start_tvusec,
        executable: PathBuf::from(std::ffi::OsStr::from_bytes(&path[..length])) }))
}
#[cfg(target_os = "linux")]
fn platform_identity(pid: i32) -> Result<Option<ProcessIdentity>> {
    let stat_path = format!("/proc/{pid}/stat");
    let contents = match fs::read_to_string(&stat_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(crate::Error::Io { operation: "read process stat".into(), source: e }),
    };
    ensure(contents.len() <= 8192, "oversized proc stat")?;
    let after = contents.rsplit_once(')').ok_or_else(|| reject("invalid proc stat"))?.1;
    let fields: Vec<_> = after.split_whitespace().collect();
    ensure(fields.len() >= 20, "truncated proc stat")?;
    if fields[0] == "Z" { return Ok(None); }
    let birth = fields[19].parse::<u64>().map_err(|_| reject("invalid process birth"))?;
    let executable = match fs::read_link(format!("/proc/{pid}/exe")) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(crate::Error::Io { operation: "read process executable".into(), source: e }),
    };
    Ok(Some(ProcessIdentity { pid, birth_seconds: birth, birth_fraction: 0, executable }))
}

