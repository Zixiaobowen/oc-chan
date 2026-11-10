//! The official collector has no direct filesystem, shell, or subprocess access.
//! CPU/network baselines and history commit under the SDK cancellation lock.
use crate::{memory::{parse_vm, SystemMemory}, network::{parse_default_interface, parse_network_counters}, processes::{parse_processes, ProcessRankings}};
use oc_plugin_sdk::{CollectContext, Collector, Command, DiskInfo, Error, ErrorCode, IoOperation, OsInfo, ResourceStatus, Result, MAX_SAFE_INTEGER};
use serde::Serialize;
use std::{collections::VecDeque, time::{Instant, SystemTime, UNIX_EPOCH}};

const MAX_MEMORY: usize = 1024 * 1024;
const MAX_NETWORK: usize = 64 * 1024;
const MAX_PROCESSES: usize = 4 * 1024 * 1024;
const MAX_HISTORY: usize = 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemSample { at: u64, cpu_percent: Option<f64>, memory_percent: f64, rx_bytes_per_second: Option<f64>, tx_bytes_per_second: Option<f64> }
#[derive(Debug, Clone, Copy)]
struct CpuTimes { idle: u64, total: u64 }
#[derive(Debug, Clone)]
struct NetworkSample { iface: String, received: u64, sent: u64, at_ms: u64 }

pub struct SystemCollector {
    previous_cpu: Option<CpuTimes>, previous_network: Option<NetworkSample>,
    history: VecDeque<SystemSample>, start: Instant,
}
impl Default for SystemCollector { fn default() -> Self { Self::new() } }
impl SystemCollector {
    pub fn new() -> Self { Self { previous_cpu: None, previous_network: None, history: VecDeque::with_capacity(MAX_HISTORY), start: Instant::now() } }
    fn cpu_percent(&mut self, current: CpuTimes) -> Option<f64> {
        let previous = self.previous_cpu;
        let valid = current.total >= current.idle && current.total <= MAX_SAFE_INTEGER;
        self.previous_cpu = valid.then_some(current);
        let previous = previous.filter(|_| valid)?;
        let total = current.total.checked_sub(previous.total)?;
        let idle = current.idle.checked_sub(previous.idle)?;
        if total == 0 || idle > total { return None; }
        Some(100.0 * (1.0 - idle as f64 / total as f64))
    }
    fn network_rate(&mut self, current: Option<NetworkSample>) -> (Option<f64>, Option<f64>) {
        let previous = std::mem::replace(&mut self.previous_network, current);
        let (Some(previous), Some(current)) = (previous, self.previous_network.clone()) else { return (None, None); };
        let elapsed = current.at_ms.saturating_sub(previous.at_ms);
        if previous.iface != current.iface || elapsed == 0 || current.received < previous.received || current.sent < previous.sent { return (None, None); }
        let seconds = elapsed as f64 / 1000.0;
        (Some((current.received - previous.received) as f64 / seconds), Some((current.sent - previous.sent) as f64 / seconds))
    }
    fn record(&mut self, sample: SystemSample) {
        if self.history.len() == MAX_HISTORY { self.history.pop_front(); }
        self.history.push_back(sample);
    }
    fn read_memory(context: &CollectContext, total: u64) -> Result<SystemMemory> {
        let vm = context.command(Command::VmStat, MAX_MEMORY)?;
        parse_vm(&vm, total)
    }
    fn read_network(&self, context: &CollectContext) -> Result<NetworkSample> {
        let iface = { let route = context.command(Command::DefaultRoute, MAX_NETWORK)?; parse_default_interface(&route)? };
        let (received, sent) = { let output = context.command(Command::NetworkCounters { interface: iface.clone() }, MAX_NETWORK)?; parse_network_counters(&output, &iface)? };
        context.check_cancelled()?;
        Ok(NetworkSample { iface, received, sent, at_ms: self.start.elapsed().as_millis() as u64 })
    }
}
fn critical(error: &Error) -> bool { matches!(error.code, ErrorCode::Cancelled | ErrorCode::Deadline | ErrorCode::Cleanup | ErrorCode::Protocol) }
fn source(id: &str, label: &str, state: &str, detail: impl Into<String>) -> ResourceStatus {
    ResourceStatus { id: id.into(), label: label.into(), state: state.into(), detail: detail.into(), resources: None }
}
fn partial<T>(result: Result<T>, sources: &mut Vec<ResourceStatus>, id: &str, label: &str) -> Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if critical(&error) => Err(error),
        Err(error) => { sources.push(source(id, label, "error", error.to_string())); Ok(None) }
    }
}
fn disk_metrics(disk: DiskInfo) -> Result<[u64; 3]> {
    let invalid = || Error::new(ErrorCode::Collect, "磁盘统计值无效或超过安全范围");
    if disk.bsize == 0 || disk.bfree > disk.blocks || disk.bavail > disk.bfree { return Err(invalid()); }
    let bytes = |blocks: u64| blocks.checked_mul(disk.bsize).filter(|n| *n <= MAX_SAFE_INTEGER).ok_or_else(invalid);
    Ok([bytes(disk.blocks)?, bytes(disk.blocks - disk.bfree)?, bytes(disk.bavail)?])
}
fn validate_os(os: &OsInfo) -> Result<()> {
    if os.hostname.is_empty() || os.hostname.len() > 1024 || os.platform != "darwin" || os.os_version.is_empty() || os.os_version.len() > 256
        || os.cpu_model.is_empty() || os.cpu_model.len() > 1024 || os.cpu_cores == 0 || os.cpu_cores > 65536
        || os.memory_total == 0 || os.memory_total > MAX_SAFE_INTEGER || os.uptime_seconds > MAX_SAFE_INTEGER || os.swap_used > MAX_SAFE_INTEGER {
        return Err(Error::protocol("invalid host OS metadata"));
    }
    Ok(())
}
#[cfg(feature = "acceptance-fail-collect")]
fn acceptance_collection_gate() -> Result<()> {
    Err(Error::new(ErrorCode::Collect, "Acceptance native v3 deliberately rejects first collection"))
}
impl Collector for SystemCollector {
    fn id(&self) -> &'static str { "system" }
    fn io_reassembly_bytes(&self) -> usize { MAX_PROCESSES }
    // Includes parsed resource status, snapshot Value, twenty <=1024-byte process
    // names, history, metadata and temporary allocations. Serialized result is separate.
    fn business_bytes(&self) -> usize { 1024 * 1024 }
    fn collect(&mut self, context: &CollectContext) -> Result<serde_json::Value> {
        #[cfg(feature = "acceptance-fail-collect")]
        acceptance_collection_gate()?;
        let os: OsInfo = context.request(IoOperation::OsInfo, 64 * 1024, 4000)?.json()?;
        validate_os(&os)?;
        let memory = match Self::read_memory(context, os.memory_total) {
            Ok(memory) => memory,
            Err(error) => {
                if !critical(&error) { context.commit(|| self.previous_cpu = None)?; }
                return Err(error);
            }
        };
        let mut sources = vec![source("system", "系统指标", "ok", "CPU 首次或计数不连续时为未知，后续按增量采样；内存使用量为活跃内存（含 wired / compressed），不含可回收缓存。进程 CPU 以单核 100% 计。")];
        let disk = partial(context.request(IoOperation::DiskInfo, 64 * 1024, 4000).and_then(|o| o.json()).and_then(disk_metrics), &mut sources, "system-1", "磁盘")?;
        let network = partial(self.read_network(context), &mut sources, "system-2", "网络")?;
        if let Some(network) = &network { sources.push(source("network-interface", "网络接口", "ok", format!("默认接口 {}；仅统计此接口，避免虚拟网卡重复计数。首个采样周期速率尚不可用。", network.iface))); }
        let processes = partial(context.command(Command::Processes, MAX_PROCESSES).and_then(|text| parse_processes(&text)), &mut sources, "system-3", "进程")?;
        let resource: Result<ResourceStatus> = context.request(IoOperation::ResourceStatus, 64 * 1024, 4000).and_then(|o| o.json());
        if let Some(status) = partial(resource, &mut sources, "collection-resources", "采集资源额度")? {
            if status.id != "collection-resources" || !["ok", "partial", "error"].contains(&status.state.as_str()) || status.label.len() > 256 || status.detail.len() > 8192 { return Err(Error::protocol("invalid resource status")); }
            sources.push(status);
        }
        let (at, collected_at) = wall_clock_now()?;
        let interface = network.as_ref().map(|n| n.iface.clone());
        let ProcessRankings { cpu, memory: memory_processes } = processes.unwrap_or_default();
        context.commit(|| {
            let cpu_percent = self.cpu_percent(CpuTimes { idle: os.cpu_idle, total: os.cpu_total });
            let (rx, tx) = self.network_rate(network);
            self.record(SystemSample { at, cpu_percent, memory_percent: memory.active as f64 / memory.total as f64 * 100.0, rx_bytes_per_second: rx, tx_bytes_per_second: tx });
            serde_json::json!({
                "collectedAt": collected_at, "hostname": os.hostname, "platform": os.platform, "osVersion": os.os_version,
                "cpuModel": os.cpu_model, "cpuCores": os.cpu_cores, "uptimeSeconds": os.uptime_seconds, "cpuPercent": cpu_percent,
                "memoryTotal": memory.total, "memoryUsed": memory.active, "memoryAvailable": memory.available,
                "memoryApp": memory.app, "memoryWired": memory.wired, "memoryCompressed": memory.compressed, "swapUsed": os.swap_used,
                "diskTotal": disk.map(|d| d[0]), "diskUsed": disk.map(|d| d[1]), "diskAvailable": disk.map(|d| d[2]),
                "rxBytesPerSecond": rx, "txBytesPerSecond": tx, "networkInterface": interface,
                "processes": cpu, "memoryProcesses": memory_processes, "history": self.history, "sources": sources
            })
        })
    }
    fn stop(&mut self) -> Result<()> { self.previous_cpu = None; self.previous_network = None; self.history.clear(); Ok(()) }
}
fn wall_clock_now() -> Result<(u64, String)> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| Error::new(ErrorCode::Collect, "system clock predates Unix epoch"))?;
    let millis = u64::try_from(elapsed.as_millis()).ok().filter(|m| *m <= MAX_SAFE_INTEGER).ok_or_else(|| Error::new(ErrorCode::Collect, "system clock out of range"))?;
    Ok((millis, iso_time(millis)?))
}
fn iso_time(millis: u64) -> Result<String> {
    let secs = millis / 1000;
    let z = (secs / 86400) as i64 + 719468;
    let era = z.div_euclid(146097); let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1; let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    if !(1970..=9999).contains(&year) { return Err(Error::new(ErrorCode::Collect, "system clock year out of range")); }
    let rem = secs % 86400;
    Ok(format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem / 60 % 60, rem % 60, millis % 1000))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn cpu_reset_invalid_idle_delta_and_full_idle() {
        let mut c = SystemCollector::new();
        assert_eq!(c.cpu_percent(CpuTimes { total: 100, idle: 50 }), None);
        assert_eq!(c.cpu_percent(CpuTimes { total: 200, idle: 75 }), Some(75.0));
        for (total, idle) in [(50,20), (50,20), (100,10), (110,90), (0,1), (200,100)] { assert_eq!(c.cpu_percent(CpuTimes { total, idle }), None); }
        assert_eq!(c.cpu_percent(CpuTimes { total: 300, idle: 150 }), Some(50.0));
        assert_eq!(c.cpu_percent(CpuTimes { total: 400, idle: 250 }), Some(0.0));
    }
    fn net(iface: &str, received: u64, at_ms: u64) -> Option<NetworkSample> { Some(NetworkSample { iface: iface.into(), received, sent: received / 2, at_ms }) }
    #[test] fn network_route_counter_reset_failure_and_recovery() {
        let mut c = SystemCollector::new();
        assert_eq!(c.network_rate(net("en0", 1000, 0)), (None, None));
        assert_eq!(c.network_rate(net("en0", 1400, 2000)), (Some(200.0), Some(100.0)));
        assert_eq!(c.network_rate(net("en0", 10, 3000)), (None, None));
        assert_eq!(c.network_rate(net("en1", 10000, 4000)), (None, None));
        assert_eq!(c.network_rate(None), (None, None));
        assert_eq!(c.network_rate(net("en1", 12000, 6000)), (None, None));
        assert_eq!(c.network_rate(net("en1", 13000, 7000)), (Some(1000.0), Some(500.0)));
    }
    #[test] fn history_sixty_instance_isolation_and_stop() {
        let mut c = SystemCollector::new();
        for at in 0..65 { c.record(SystemSample { at, cpu_percent: None, memory_percent: 0.0, rx_bytes_per_second: None, tx_bytes_per_second: None }); }
        assert_eq!(c.history.len(), 60); assert_eq!(c.history.front().unwrap().at, 5);
        assert!(SystemCollector::new().history.is_empty());
        c.stop().unwrap(); assert!(c.history.is_empty()); assert!(c.previous_cpu.is_none()); assert!(c.previous_network.is_none());
    }
    #[test] fn wall_clock_iso_leap_day_and_january() {
        assert_eq!(iso_time(0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1709164800123).unwrap(), "2024-02-29T00:00:00.123Z");
        assert_eq!(iso_time(1735689600000).unwrap(), "2025-01-01T00:00:00.000Z");
    }
    #[test] fn disk_invalid_and_optional_sources_keep_unknown_semantics() {
        assert!(disk_metrics(DiskInfo { blocks: 1, bfree: 2, bavail: 0, bsize: 4096 }).is_err());
        assert_eq!(disk_metrics(DiskInfo { blocks: 100, bfree: 40, bavail: 30, bsize: 4096 }).unwrap(), [409600, 245760, 122880]);
        let mut sources = Vec::new();
        assert!(partial::<u64>(Err(Error::new(ErrorCode::Io, "disk unavailable")), &mut sources, "system-1", "磁盘").unwrap().is_none());
        assert_eq!(sources[0].state, "error");
        assert!(partial::<u64>(Err(Error::new(ErrorCode::Cleanup, "failed to reap")), &mut sources, "system-1", "磁盘").is_err());
    }
}
