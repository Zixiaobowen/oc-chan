mod agents;
mod events;
mod navigation;
mod schedules;
mod system;

pub use agents::*;
pub use events::*;
pub use navigation::*;
pub use schedules::*;
pub use system::*;
use serde::{Deserialize, Serialize};
use crate::resources::ResourceBudgetSnapshot;

pub(crate) fn required_nullable<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where D: serde::Deserializer<'de>, T: serde::Deserialize<'de> {
    serde::Deserialize::deserialize(deserializer)
}

pub const AGENT_DISCOVERY_INTERVAL_MS: u64 = 2_000;
pub const AGENT_ACTIVITY_WINDOW_MS: i64 = 6_000;
pub const HISTORY_PAGE_SIZE: usize = 25;
pub const MAX_HISTORY_OFFSET: usize = 100_000;
pub const MAX_SCHEDULE_ID_LENGTH: usize = 256;
pub const MAX_HERMES_JOB_ID_LENGTH: usize = 128;
pub const MAX_AGENT_ID_LENGTH: usize = 512;
pub const MAX_SOURCE_ID_LENGTH: usize = 128;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SourceState { Ok, Empty, Partial, Error, Unsupported, Disabled }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SourceDiagnosticOperation { Services, Disabled }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SourceDiagnosticStage { Command, Timeout, Permission, Structure, Row, Limit, Queue }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SourceDiagnosticCode {
    CommandFailed, PermissionDenied, TimedOut, CommandMissing, OutputLimit,
    EntryLimit, MissingTable, InvalidRow, ResourceLimit, QueueTimeout,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceDiagnostic {
    pub source_id: String,
    pub operation: SourceDiagnosticOperation,
    pub stage: SourceDiagnosticStage,
    pub code: SourceDiagnosticCode,
    pub retryable: bool,
    pub observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[cfg(test)]
mod source_diagnostic_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn source_diagnostics_reject_values_outside_wire_contract() {
        let diagnostic = json!({"sourceId":"launchctl:gui/501","operation":"services","stage":"command","code":"command-failed","retryable":true,"observedAt":"2026-11-10T00:00:00.000Z"});
        let decoded: SourceDiagnostic = serde_json::from_value(diagnostic.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), diagnostic);
        let status = json!({"id":"launchctl:gui/501","label":"launchd","state":"partial","detail":"命令执行失败","diagnostics":[diagnostic]});
        let decoded: SourceStatus = serde_json::from_value(status.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), status);
        for (field, invalid) in [("stage", "collect"), ("operation", "读取失败"), ("code", "OC_COMMAND_FAILED")] {
            let mut invalid_status = status.clone();
            invalid_status["diagnostics"][0][field] = json!(invalid);
            assert!(serde_json::from_value::<SourceDiagnostic>(invalid_status["diagnostics"][0].clone()).is_err(), "{field}");
            assert!(serde_json::from_value::<SourceStatus>(invalid_status).is_err(), "{field}");
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceObservation {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceStatus {
    pub id: String,
    pub label: String,
    pub state: SourceState,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Vec<SourceDiagnostic>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resources: Option<ResourceBudgetSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<SourceRetry>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SourceRetry { Source, Section }

impl SourceStatus {
    pub fn new(id: impl Into<String>, label: impl Into<String>, state: SourceState, detail: impl Into<String>) -> Self {
        Self { id: id.into(), label: label.into(), state, detail: detail.into(), last_attempt_at: None,
            last_success_at: None, diagnostics: None, resources: None, retry: None }
    }
    pub fn observation(&self) -> SourceObservation {
        SourceObservation { id: self.id.clone(), last_attempt_at: self.last_attempt_at.clone(), last_success_at: self.last_success_at.clone() }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectorState<T> {
    pub data: Option<T>,
    pub error: Option<String>,
    pub refreshing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<String>,
}
impl<T> Default for CollectorState<T> {
    fn default() -> Self { Self { data: None, error: None, refreshing: false, last_attempt_at: None, last_success_at: None } }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonitorSnapshot {
    pub agents: CollectorState<AgentSnapshot>,
    pub schedules: CollectorState<ScheduleSnapshot>,
    pub system: CollectorState<SystemSnapshot>,
    pub events: CollectorState<EventSnapshot>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum MonitorSection { Agents, Schedules, System, Events }
impl MonitorSection {
    pub const ALL: [Self; 4] = [Self::Agents, Self::Schedules, Self::System, Self::Events];
    pub fn as_str(self) -> &'static str { match self { Self::Agents => "agents", Self::Schedules => "schedules", Self::System => "system", Self::Events => "events" } }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "section", content = "state", rename_all = "lowercase", deny_unknown_fields)]
pub enum MonitorUpdate {
    Agents(CollectorState<AgentSnapshot>), Schedules(CollectorState<ScheduleSnapshot>),
    System(CollectorState<SystemSnapshot>), Events(CollectorState<EventSnapshot>),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceHeartbeat {
    pub section: MonitorSection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<String>,
    pub sources: Vec<SourceObservation>,
}
