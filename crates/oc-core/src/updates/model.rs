use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePhase { Disabled, Idle, Checking, Available, Downloading, Downloaded, Installing, Error }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DisabledReason { Development, Platform, Unsigned }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateProgress {
    pub percent: f64,
    pub transferred: u64,
    pub total: u64,
    pub bytes_per_second: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSnapshot {
    pub revision: u64,
    pub phase: UpdatePhase,
    pub current_version: String,
    pub available_version: Option<String>,
    pub checked_at: Option<String>,
    pub progress: Option<UpdateProgress>,
    pub disabled_reason: Option<DisabledReason>,
    pub error: Option<String>,
}
