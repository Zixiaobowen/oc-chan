use serde::{Deserialize, Serialize};
use super::SourceStatus;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobScope { User, System }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobOrigin { Personal, System, Application, Unknown }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobKind { Calendar, Interval, Startup, Service }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobState { Running, Waiting, Disabled, Unloaded, Unknown }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JobStateReason { HermesReadFailed, HermesDispatching, HermesUnconfirmed, HermesStateUnsupported }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RunResult { Succeeded, Failed, DeliveryFailed, Blocked, Unknown }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LastRun {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    pub result: RunResult,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledJob {
    pub id: String, pub name: String, pub source: String,
    pub scope: JobScope, pub origin: JobOrigin, pub kind: JobKind,
    pub schedule: String, pub state: JobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_reason: Option<JobStateReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run: Option<LastRun>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleSnapshot { pub collected_at: String, pub jobs: Vec<ScheduledJob>, pub sources: Vec<SourceStatus> }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionStatus { Claimed, Running, Succeeded, Failed, Unknown }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryStatus { Delivered, Failed, Skipped, Unknown }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleExecution {
    pub id: String, pub claimed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub status: ExecutionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<DeliveryStatus>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HistorySource { Hermes, Unavailable }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleHistory {
    pub job_id: String, pub source: HistorySource, pub entries: Vec<ScheduleExecution>,
    pub offset: usize, pub limit: usize, pub has_more: bool, pub collected_at: String,
}
