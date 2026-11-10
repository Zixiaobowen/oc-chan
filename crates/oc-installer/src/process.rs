use crate::{combine, ensure, filesystem::deadline, reject, IoResult, Result};
use serde::{Deserialize, Serialize};
use std::{ffi::{CString, OsString}, io::Read, os::unix::{ffi::OsStrExt, io::AsRawFd}, path::{Path, PathBuf}, process::{Command, Stdio}, time::{Duration, Instant}};
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

/// Spawn a fixed system command with no shell, bounded combined output and a hard
/// deadline. All pipes are nonblocking; failure kills the process group AND waits.
pub(crate) fn bounded_command(program: &Path, args: &[OsString], end: Instant) -> Result<Vec<u8>> {
    use std::os::unix::process::CommandExt;
    deadline(end)?;
    let command_end = end.min(Instant::now() + Duration::from_secs(15));
    let mut command = Command::new(program);
    command.args(args).env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").env("LANG", "C")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let mut child = command.spawn().context("spawn signature command")?;
    let operation = (|| -> Result<Vec<u8>> {
        let mut stdout = child.stdout.take().ok_or_else(|| reject("missing command stdout"))?;
        let mut stderr = child.stderr.take().ok_or_else(|| reject("missing command stderr"))?;
        for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            ensure(flags >= 0 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == 0, "set command pipe nonblocking failed")?;
        }
        let mut output = Vec::new();
        let mut out_done = false;
        let mut err_done = false;
        loop {
            deadline(command_end)?;
            read_pipe(&mut stdout, &mut output, &mut out_done)?;
            read_pipe(&mut stderr, &mut output, &mut err_done)?;
            if let Some(status) = child.try_wait().context("wait signature command")? {
                if out_done && err_done {
                    ensure(status.success(), &format!("{} failed: {}", program.display(), String::from_utf8_lossy(&output)))?;
                    return Ok(output);
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    })();
    match operation {
        Ok(value) => Ok(value),
        Err(error) => {
            let mut failure = error;
            if unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) } != 0 {
                let e = std::io::Error::last_os_error();
                if e.raw_os_error() != Some(libc::ESRCH) { failure = combine(failure, crate::Error::Io { operation: "kill command group".into(), source: e }); }
            }
            if let Err(e) = child.wait() { failure = combine(failure, crate::Error::Io { operation: "reap command".into(), source: e }); }
            Err(failure)
        }
    }
}
fn read_pipe(reader: &mut impl Read, output: &mut Vec<u8>, finished: &mut bool) -> Result<()> {
    if *finished { return Ok(()); }
    let mut buffer = [0u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => { *finished = true; return Ok(()); }
            Ok(n) => {
                ensure(output.len() + n <= 128 * 1024, "command output exceeds 128 KiB")?;
                output.extend_from_slice(&buffer[..n]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(crate::Error::Io { operation: "read command output".into(), source: e }),
        }
    }
}

/// The forked child cannot exec until its pid/birth has been fsynced in the
/// journal. A crashed installer closes the gate; EOF makes the child exit.
/// Only the parent binds the process group. The gate already prevents exec until
/// binding succeeds, so the child must not also create the group concurrently.
/// After fork the child uses only async-signal-safe libc operations.
pub(crate) struct GatedLaunch { pub identity: ProcessIdentity, gate: i32, released: bool }
impl GatedLaunch {
    pub fn create(executable: &Path, args: &[OsString]) -> Result<Self> {
        let executable_c = CString::new(executable.as_os_str().as_bytes()).map_err(|_| reject("NUL executable path"))?;
        let mut strings = vec![executable_c.clone()];
        for arg in args { strings.push(CString::new(arg.as_os_str().as_bytes()).map_err(|_| reject("NUL launch argument"))?); }
        let mut argv: Vec<*const libc::c_char> = strings.iter().map(|s| s.as_ptr()).collect();
        argv.push(std::ptr::null());
        // Keep only a small explicit environment. HOME/USER are needed by Cocoa;
        // no dynamic-loader, plugin, Node, or credential environment is inherited.
        let mut env = vec![CString::new("PATH=/usr/bin:/bin:/usr/sbin:/sbin").map_err(|e| reject(e.to_string()))?];
        for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"] {
            if let Some(value) = std::env::var_os(key) {
                let mut bytes = key.as_bytes().to_vec(); bytes.push(b'='); bytes.extend_from_slice(value.as_bytes());
                ensure(bytes.len() <= 4096, "oversized launch environment")?;
                env.push(CString::new(bytes).map_err(|_| reject("NUL launch environment"))?);
            }
        }
        let mut envp: Vec<*const libc::c_char> = env.iter().map(|s| s.as_ptr()).collect(); envp.push(std::ptr::null());
        let mut pipes = [-1; 2];
        if unsafe { libc::pipe(pipes.as_mut_ptr()) } != 0 { return Err(crate::Error::Io { operation: "create exec gate".into(), source: std::io::Error::last_os_error() }); }
        for fd in pipes {
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
                let error = std::io::Error::last_os_error();
                unsafe { libc::close(pipes[0]); libc::close(pipes[1]); }
                return Err(crate::Error::Io { operation: "protect exec gate".into(), source: error });
            }
        }
        let pid = unsafe { libc::fork() };
        if pid == -1 {
            let error = std::io::Error::last_os_error();
            unsafe { libc::close(pipes[0]); libc::close(pipes[1]); }
            return Err(crate::Error::Io { operation: "fork application".into(), source: error });
        }
        if pid == 0 {
            unsafe {
                libc::close(pipes[1]);
                let mut byte = 0u8;
                let n = libc::read(pipes[0], (&mut byte as *mut u8).cast(), 1);
                libc::close(pipes[0]);
                if n != 1 || byte != 1 { libc::_exit(125); }
                let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
                if null < 0 { libc::_exit(126); }
                for fd in 0..=2 { if libc::dup2(null, fd) == -1 { libc::_exit(126); } }
                if null > 2 { libc::close(null); }
                // Installer is single-threaded; its own FDs are CLOEXEC.
                libc::execve(executable_c.as_ptr(), argv.as_ptr(), envp.as_ptr());
                libc::_exit(127);
            }
        }
        unsafe { libc::close(pipes[0]); }
        if unsafe { libc::setpgid(pid, pid) } != 0 {
            let error = crate::Error::Io { operation: "bind application process group".into(), source: std::io::Error::last_os_error() };
            unsafe { libc::close(pipes[1]); }
            return match reap_child(pid, true) { Ok(()) => Err(error), Err(cleanup) => Err(combine(error, cleanup)) };
        }
        let observed = ProcessIdentity::inspect(pid);
        match observed {
            Ok(Some(mut identity)) => {
                identity.executable = executable.to_owned();
                Ok(Self { identity, gate: pipes[1], released: false })
            }
            other => {
                unsafe { libc::close(pipes[1]); }
                let primary = match other { Err(e) => e, _ => reject("gated child vanished") };
                match reap_child(pid, true) { Ok(()) => Err(primary), Err(e) => Err(combine(primary, e)) }
            }
        }
    }
    pub fn release(mut self) -> Result<ProcessIdentity> {
        let byte = 1u8;
        let n = unsafe { libc::write(self.gate, (&byte as *const u8).cast(), 1) };
        if n != 1 {
            let error = crate::Error::Io { operation: "release exec gate".into(), source: std::io::Error::last_os_error() };
            return match self.cancel() { Ok(()) => Err(error), Err(cleanup) => Err(combine(error, cleanup)) };
        }
        self.released = true;
        Ok(self.identity.clone())
    }
    pub fn cancel(mut self) -> Result<()> {
        self.released = true;
        if let Some(actual) = ProcessIdentity::inspect(self.identity.pid)? {
            ensure(self.identity.same_birth(&actual), "gated child PID was reused; refusing cleanup signal")?;
        }
        if unsafe { libc::kill(self.identity.pid, libc::SIGKILL) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(crate::Error::Io { operation: "cancel gated application".into(), source: error });
            }
        }
        reap_child(self.identity.pid, true)
    }
}
impl Drop for GatedLaunch {
    fn drop(&mut self) {
        unsafe { libc::close(self.gate); }
        if !self.released {
            // A stopped gated child also has to terminate; never just drop a
            // future and assume that the OS process has ended.
            match ProcessIdentity::inspect(self.identity.pid) {
                Ok(Some(actual)) if !self.identity.same_birth(&actual) => {
                    eprintln!("installer exec gate PID was reused; cleanup refused");
                    return;
                }
                Err(error) => {
                    eprintln!("installer cannot establish exec gate identity: {error}");
                    return;
                }
                _ => {},
            }
            let killed = unsafe { libc::kill(self.identity.pid, libc::SIGKILL) };
            if killed != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                eprintln!("installer exec gate kill failed: {}", std::io::Error::last_os_error());
            }
            if let Err(e) = reap_child(self.identity.pid, true) { eprintln!("installer exec gate cleanup failed: {e}"); }
        }
    }
}
pub(crate) fn exit_error(pid: i32, operation: &str) -> crate::Error {
    let mut status = 0;
    let observed = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    let detail = if observed == pid && libc::WIFEXITED(status) {
        format!("exit status {}", libc::WEXITSTATUS(status))
    } else if observed == pid && libc::WIFSIGNALED(status) {
        format!("signal {}", libc::WTERMSIG(status))
    } else if observed == 0 {
        "process identity unavailable while child is still live".into()
    } else if observed == -1 {
        format!("exit status unavailable: {}", std::io::Error::last_os_error())
    } else { format!("wait status {status}") };
    reject(format!("{operation}: {detail}"))
}

fn reap_child(pid: i32, blocking: bool) -> Result<()> {
    loop {
        let mut status = 0;
        let n = unsafe { libc::waitpid(pid, &mut status, if blocking { 0 } else { libc::WNOHANG }) };
        if n >= 0 { return Ok(()); }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EINTR) { continue; }
        if error.raw_os_error() == Some(libc::ECHILD) { return Ok(()); } // recovery helper is not original parent
        return Err(crate::Error::Io { operation: "reap application".into(), source: error });
    }
}
pub(crate) fn stop_exact(expected: &ProcessIdentity, gate_executable: &Path, end: Instant) -> Result<()> {
    let group_live = || -> Result<bool> {
        if unsafe { libc::kill(-expected.pid, 0) } == 0 { return Ok(true); }
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::ESRCH) { return Ok(false); }
        Err(crate::Error::Io { operation: "inspect launched process group".into(), source: e })
    };
    let Some(actual) = ProcessIdentity::inspect(expected.pid)? else {
        reap_child(expected.pid, false)?;
        ensure(!group_live()?, "new host is gone but unverified descendants remain; preserving bundles")?;
        return Ok(());
    };
    ensure(expected.same_birth(&actual), "refusing to stop reused PID")?;
    ensure(actual.executable == expected.executable || actual.executable == gate_executable, "refusing to stop unexpected executable")?;
    ensure(unsafe { libc::getpgid(expected.pid) } == expected.pid, "launched process left its registered process group")?;
    let signal_group = |signal| -> Result<()> {
        if let Some(current) = ProcessIdentity::inspect(expected.pid)? {
            ensure(expected.same_birth(&current), "PID reused while stopping process group")?;
        }
        if unsafe { libc::kill(-expected.pid, signal) } != 0 {
            let e = std::io::Error::last_os_error();
            if e.raw_os_error() != Some(libc::ESRCH) {
                return Err(crate::Error::Io { operation: "stop launched process group".into(), source: e });
            }
        }
        Ok(())
    };
    signal_group(libc::SIGTERM)?;
    let soft = end.min(Instant::now() + Duration::from_secs(3));
    loop {
        if ProcessIdentity::inspect(expected.pid)?.is_none() { reap_child(expected.pid, false)?; }
        if !group_live()? { reap_child(expected.pid, true)?; return Ok(()); }
        if Instant::now() >= soft { break; }
        std::thread::sleep(Duration::from_millis(25));
    }
    signal_group(libc::SIGKILL)?;
    loop {
        if ProcessIdentity::inspect(expected.pid)?.is_none() { reap_child(expected.pid, false)?; }
        if !group_live()? { reap_child(expected.pid, true)?; return Ok(()); }
        deadline(end)?;
        std::thread::sleep(Duration::from_millis(25));
    }
}

pub(crate) trait Runtime {
    fn launch(&self, executable: &Path, arguments: &[OsString]) -> Result<GatedLaunch> { GatedLaunch::create(executable, arguments) }
    fn ready_instance(&self, expected: &ProcessIdentity, bundle: &Path) -> Result<bool>;
    #[cfg(test)]
    fn on_launched(&self, _request: &Path) -> Result<()> { Ok(()) }
}
pub(crate) struct NativeRuntime;
impl Runtime for NativeRuntime {
    fn ready_instance(&self, expected: &ProcessIdentity, bundle: &Path) -> Result<bool> {
        if !expected.live()? { return Ok(false); }
        workspace_ready(expected.pid, bundle, &expected.executable)
    }
}
#[cfg(not(target_os = "macos"))]
fn workspace_ready(_pid: i32, _bundle: &Path, _executable: &Path) -> Result<bool> {
    Err(reject("NSWorkspace readiness is available only on macOS"))
}
#[cfg(target_os = "macos")]
fn workspace_ready(pid: i32, bundle: &Path, executable: &Path) -> Result<bool> {
    use std::ffi::{CStr, c_char, c_void};
    type Id = *mut c_void;
    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {}
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Id;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> Id;
        fn objc_autoreleasePoolPop(pool: Id);
    }
    struct Pool(Id);
    impl Drop for Pool { fn drop(&mut self) { unsafe { objc_autoreleasePoolPop(self.0); } } }
    unsafe fn msg(object: Id, selector: &CStr) -> Id {
        let call: unsafe extern "C" fn(Id, Id) -> Id = unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
        unsafe { call(object, sel_registerName(selector.as_ptr())) }
    }
    unsafe fn boolean(object: Id, selector: &CStr) -> bool {
        let call: unsafe extern "C" fn(Id, Id) -> i8 = unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
        unsafe { call(object, sel_registerName(selector.as_ptr())) != 0 }
    }
    unsafe fn string(object: Id) -> Result<String> {
        ensure(!object.is_null(), "missing NSWorkspace identity")?;
        let bytes = unsafe { msg(object, c"UTF8String") }.cast::<c_char>();
        ensure(!bytes.is_null(), "invalid NSWorkspace string")?;
        let length = unsafe { libc::strnlen(bytes, 4097) };
        ensure(length <= 4096, "oversized NSWorkspace path")?;
        let slice = unsafe { std::slice::from_raw_parts(bytes.cast::<u8>(), length) };
        String::from_utf8(slice.to_vec()).map_err(|_| reject("invalid NSWorkspace path encoding"))
    }
    unsafe {
        let _pool = Pool(objc_autoreleasePoolPush());
        let class = objc_getClass(c"NSRunningApplication".as_ptr());
        ensure(!class.is_null(), "NSRunningApplication unavailable")?;
        let call: unsafe extern "C" fn(Id, Id, i32) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let app = call(class, sel_registerName(c"runningApplicationWithProcessIdentifier:".as_ptr()), pid);
        if app.is_null() || boolean(app, c"isTerminated") || !boolean(app, c"isFinishedLaunching") { return Ok(false); }
        let bundle_path = string(msg(msg(app, c"bundleURL"), c"path"))?;
        let executable_path = string(msg(msg(app, c"executableURL"), c"path"))?;
        let identifier = string(msg(app, c"bundleIdentifier"))?;
        ensure(Path::new(&bundle_path) == bundle && Path::new(&executable_path) == executable && identifier == crate::BUNDLE_ID,
            "NSWorkspace instance identity differs from launch")?;
        Ok(true)
    }
}
