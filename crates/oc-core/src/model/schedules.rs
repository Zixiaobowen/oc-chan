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
#[serde(rename_all = "lowercase")]
pub enum HermesScheduleControl { Active, Paused, Inactive }
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
    pub hermes_control: Option<HermesScheduleControl>,
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

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ScheduleMutation {
    Create { name: String, schedule: String, prompt: String, paused: bool },
    Pause { job_id: String, identity: String },
    Resume { job_id: String, identity: String },
    Delete { job_id: String, identity: String },
}

impl ScheduleMutation {
    pub(crate) fn selection(&self) -> Option<(&str, &str)> {
        match self {
            Self::Create { .. } => None,
            Self::Pause { job_id, identity } | Self::Resume { job_id, identity } | Self::Delete { job_id, identity } => Some((job_id, identity)),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleMutationReceipt {
    pub job_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_error: Option<String>,
}

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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleDetailField { pub key: String, pub value: String }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleDetail { pub job_id: String, pub collected_at: String, pub fields: Vec<ScheduleDetailField>, pub notes: Vec<String> }

pub const MAX_SCHEDULE_DETAIL_FIELD_BYTES: usize = 64 * 1024;
pub const MAX_SCHEDULE_DETAIL_BYTES: usize = 256 * 1024;
pub const MAX_SCHEDULE_DETAIL_FIELDS: usize = 64;
impl ScheduleDetail {
    pub fn validate(&self, job_id: &str) -> crate::error::Result<()> {
        use crate::error::{Error, validate_text};
        if self.job_id != job_id { return Err(Error::invalid("schedule detail response identity")); }
        validate_text(&self.collected_at, 128, 128, "schedule detail timestamp")?;
        if self.fields.len() > MAX_SCHEDULE_DETAIL_FIELDS || self.notes.len() > 16 { return Err(Error::invalid("schedule detail response entries")); }
        let mut bytes = self.job_id.len() + self.collected_at.len();
        for field in &self.fields {
            if !matches!(field.key.as_str(), "configurationFile"|"metadataFile"|"prompt"|"command"|"program"|"argv"|"launchdArguments"|"cwd"|"workdir"|"workingDirectory"|"defaultTimezone"|"metadataNotBefore"|"model"|"provider"|"script"|"interpreter"|"noAgent"|"monitorScript"|"skills"|"skill"|"repeatCompleted"|"repeatTimes"|"schedule"|"calendar"|"timezone"|"notBefore"|"originalSchedule"|"enabled"|"state"|"startInterval"|"startCalendarInterval"|"runAtLoad"|"keepAlive"|"standardInPath"|"standardOutPath"|"standardErrorPath") { return Err(Error::invalid("schedule detail field key")); }
            if field.value.len() > MAX_SCHEDULE_DETAIL_FIELD_BYTES { return Err(Error::limit("schedule detail field bytes",MAX_SCHEDULE_DETAIL_FIELD_BYTES,field.value.len())); }
            bytes += field.key.len() + field.value.len();
        }
        for note in &self.notes {
            if note.len() > MAX_SCHEDULE_DETAIL_FIELD_BYTES { return Err(Error::limit("schedule detail note bytes",MAX_SCHEDULE_DETAIL_FIELD_BYTES,note.len())); }
            bytes += note.len();
        }
        if bytes > MAX_SCHEDULE_DETAIL_BYTES { return Err(Error::limit("schedule detail response bytes",MAX_SCHEDULE_DETAIL_BYTES,bytes)); }
        Ok(())
    }
}
