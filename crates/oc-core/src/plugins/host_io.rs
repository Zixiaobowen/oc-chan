use crate::{error::{Error, Result, check_cancel}, io::{BoundedIo, CommandSpec}};
use oc_plugin_sdk::{Command, DiskInfo, IoOperation, OsInfo, Stream};
use std::{ffi::{CStr, CString}, time::Duration};
use tokio_util::sync::CancellationToken;

pub(super) struct Output { pub streams: Vec<(Stream, Vec<u8>)>, pub exit_code: Option<i32>, pub identity: String }
pub(super) async fn perform<T: Send + 'static>(io: BoundedIo, operation: IoOperation, maximum: usize, timeout: Duration, cancel: CancellationToken,
    consume: impl FnOnce(Output, CancellationToken) -> super::BoxFuture<'static, Result<T>> + Send + 'static) -> Result<T> {
    operation.validate().map_err(|_| Error::invalid("plugin IO operation"))?;
    check_cancel(&cancel)?;
    if let IoOperation::Command { command } = operation {
        let (path, args, limit): (&str, Vec<String>, usize) = match command {
            Command::VmStat => ("/usr/bin/vm_stat", vec![], 64 * 1024),
            Command::Processes => ("/bin/ps", vec!["-axo".into(), "pid=,pcpu=,rss=,comm=".into()], 4 * 1024 * 1024),
            Command::DefaultRoute => ("/sbin/route", vec!["-n".into(), "get".into(), "default".into()], 32 * 1024),
            Command::NetworkCounters { interface } => ("/usr/sbin/netstat", vec!["-ibn".into(), "-I".into(), interface], 256 * 1024),
        };
        let mut spec = CommandSpec::new(path, args, maximum.min(limit), timeout.min(Duration::from_secs(10)));
        spec.stderr_limit = maximum.min(16 * 1024);
        return io.command_with_output("plugin-host", spec, &cancel, move |output, cancel| async move {
            let total = output.stdout.len() + output.stderr.len();
            if total > maximum { return Err(Error::limit("plugin IO output", maximum, total)); }
            let identity = match &output.identity {
                Some(identity) => format!("pid={};birth={}.{};pgid={}", identity.pid, identity.start_seconds, identity.start_microseconds, identity.process_group),
                None => format!("pid={};birth=unknown;reason={}", output.pid, output.identity_error.as_ref().map_or("not-observed", |error| error.code.as_str())),
            };
            consume(Output { streams: vec![(Stream::Stdout, output.stdout), (Stream::Stderr, output.stderr)], exit_code: Some(output.exit_code), identity }, cancel).await
        }).await;
    }
    let resources = io.resources().clone();
    io.with_file_budget("plugin-host", maximum + 64 * 1024, &cancel, move |cancel| async move {
        let worker_cancel = cancel.clone();
        let output = tokio::task::spawn_blocking(move || {
            let cancel = worker_cancel;
            check_cancel(&cancel)?;
            let bytes = match operation {
                IoOperation::OsInfo => oc_plugin_sdk::encode_json(&os_info()?, maximum),
                IoOperation::DiskInfo => oc_plugin_sdk::encode_json(&disk_info()?, maximum),
                IoOperation::ResourceStatus => oc_plugin_sdk::encode_json(&resources.source_status(), maximum),
                IoOperation::Command { .. } => unreachable!("command dispatched above"),
            }.map_err(|_| Error::limit("host IO JSON", maximum, maximum + 1))?;
            check_cancel(&cancel)?;
            Ok::<Output, Error>(Output { streams: vec![(Stream::Data, bytes)], exit_code: None, identity: "host-native-readonly".into() })
        }).await.map_err(|_| Error::cleanup("native plugin IO", Error::new("OC_PLUGIN_PANIC", "Native IO worker exited")))??;
        consume(output, cancel).await
    }).await
}
fn sysctl_bytes(name: &CStr, maximum: usize) -> Result<Vec<u8>> {
    let mut length = 0;
    if unsafe { libc::sysctlbyname(name.as_ptr(), std::ptr::null_mut(), &mut length, std::ptr::null_mut(), 0) } != 0 { return Err(Error::io("system metric size", std::io::Error::last_os_error())); }
    if length == 0 || length > maximum { return Err(Error::limit("system metric", maximum, length)); }
    let mut bytes = vec![0u8; length];
    if unsafe { libc::sysctlbyname(name.as_ptr(), bytes.as_mut_ptr().cast(), &mut length, std::ptr::null_mut(), 0) } != 0 { return Err(Error::io("system metric", std::io::Error::last_os_error())); }
    bytes.truncate(length); Ok(bytes)
}
fn sysctl_u64(name: &CStr) -> Result<u64> {
    let bytes = sysctl_bytes(name, 8)?;
    match bytes.len() { 4 => Ok(u32::from_ne_bytes(bytes.try_into().expect("four bytes")) as u64), 8 => Ok(u64::from_ne_bytes(bytes.try_into().expect("eight bytes"))), _ => Err(Error::invalid("system metric integer")) }
}
fn sysctl_text(name: &CStr) -> Result<String> {
    let bytes = sysctl_bytes(name, 1024)?;
    let text = std::str::from_utf8(bytes.strip_suffix(&[0]).unwrap_or(&bytes)).map_err(|_| Error::invalid("system metric UTF8"))?;
    if text.is_empty() || text.contains('\0') { return Err(Error::invalid("system metric text")); } Ok(text.to_owned())
}
fn os_info() -> Result<OsInfo> {
    let hostname = sysctl_text(c"kern.hostname")?;
    let boot = sysctl_bytes(c"kern.boottime", std::mem::size_of::<libc::timeval>())?;
    if boot.len() != std::mem::size_of::<libc::timeval>() { return Err(Error::invalid("boot time")); }
    let boot = unsafe { std::ptr::read_unaligned(boot.as_ptr().cast::<libc::timeval>()) };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| Error::invalid("system clock"))?.as_secs();
    if boot.tv_sec < 0 || boot.tv_sec as u64 > now { return Err(Error::invalid("boot time")); }
    let (cpu_idle, cpu_total) = cpu_ticks()?;
    Ok(OsInfo { hostname, platform: "darwin".into(), os_version: sysctl_text(c"kern.osproductversion")?,
        cpu_model: sysctl_text(c"machdep.cpu.brand_string")?, cpu_cores: sysctl_u64(c"hw.ncpu")? as usize,
        uptime_seconds: now - boot.tv_sec as u64, memory_total: sysctl_u64(c"hw.memsize")?, swap_used: swap_used()?, cpu_idle, cpu_total })
}
fn swap_used() -> Result<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::xsw_usage>::uninit();
    let mut length = std::mem::size_of::<libc::xsw_usage>();
    if unsafe { libc::sysctlbyname(c"vm.swapusage".as_ptr(), usage.as_mut_ptr().cast(), &mut length, std::ptr::null_mut(), 0) } != 0 {
        return Err(Error::io("swap usage", std::io::Error::last_os_error()));
    }
    if length != std::mem::size_of::<libc::xsw_usage>() { return Err(Error::invalid("swap usage structure size")); }
    let usage = unsafe { usage.assume_init() };
    if usage.xsu_used > usage.xsu_total || usage.xsu_used > oc_plugin_sdk::MAX_SAFE_INTEGER { return Err(Error::invalid("swap usage byte count")); }
    Ok(usage.xsu_used)
}
fn cpu_ticks() -> Result<(u64, u64)> {
    unsafe extern "C" { fn mach_host_self() -> u32; fn host_statistics(host: u32, flavor: i32, info: *mut i32, count: *mut u32) -> i32; fn mach_port_deallocate(task: u32, name: u32) -> i32; static mach_task_self_: u32; }
    let host = unsafe { mach_host_self() }; let mut ticks = [0u32; 4]; let mut count = 4u32;
    let result = unsafe { host_statistics(host, 3, ticks.as_mut_ptr().cast(), &mut count) };
    let close = unsafe { mach_port_deallocate(mach_task_self_, host) };
    if close != 0 { return Err(Error::cleanup("host port", Error::new("OC_SYSTEM_METRIC", format!("mach port deallocation={close}")))); }
    if result != 0 || count != 4 { return Err(Error::new("OC_SYSTEM_METRIC", format!("host CPU statistics={result}"))); }
    Ok((ticks[2] as u64, ticks.iter().map(|v| *v as u64).sum()))
}
fn disk_info() -> Result<DiskInfo> {
    let path = CString::new("/").expect("fixed root"); let mut value = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), value.as_mut_ptr()) } != 0 { return Err(Error::io("root filesystem statistics", std::io::Error::last_os_error())); }
    let value = unsafe { value.assume_init() };
    Ok(DiskInfo { blocks: u64::from(value.f_blocks), bfree: u64::from(value.f_bfree), bavail: u64::from(value.f_bavail), bsize: value.f_frsize })
}
