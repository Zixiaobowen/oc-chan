use serde::{Deserialize, Serialize};
use super::SourceStatus;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessInfo { pub pid: u32, pub name: String, pub cpu_percent: f64, pub memory_bytes: u64 }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemSample {
    pub at: i64, pub cpu_percent: Option<f64>, pub memory_percent: f64,
    pub rx_bytes_per_second: Option<f64>, pub tx_bytes_per_second: Option<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemSnapshot {
    pub collected_at: String, pub hostname: String, pub platform: String,
    pub os_version: String, pub cpu_model: String, pub cpu_cores: u32,
    pub uptime_seconds: f64, pub cpu_percent: Option<f64>,
    pub memory_total: u64, pub memory_used: u64, pub memory_available: u64,
    pub memory_app: u64, pub memory_wired: u64, pub memory_compressed: u64,
    pub swap_used: u64, pub disk_total: Option<u64>, pub disk_used: Option<u64>,
    pub disk_available: Option<u64>, pub rx_bytes_per_second: Option<f64>,
    pub tx_bytes_per_second: Option<f64>, pub network_interface: Option<String>,
    pub processes: Vec<ProcessInfo>, pub memory_processes: Vec<ProcessInfo>,
    pub history: Vec<SystemSample>, pub sources: Vec<SourceStatus>,
}
