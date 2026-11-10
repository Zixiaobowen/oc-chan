use serde::{Deserialize, Serialize};
use super::{NavigationTarget, SourceStatus};
use crate::error::{Error, Result, validate_text};

pub const EVENT_PAGE_SIZE: usize = 50;
pub const EVENT_BATCH_LIMIT: usize = 100;
pub const EVENT_RECORD_BYTES: usize = 2048;
pub const EVENT_MAX_RECORDS: usize = 10_000;
pub const EVENT_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const EVENT_DISK_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum LocalEventType { ExecutionFailed, DeliveryFailed, SourceUnavailable, SourceRecovered }
impl LocalEventType {
    pub const ALL: [Self; 4] = [Self::ExecutionFailed, Self::DeliveryFailed, Self::SourceUnavailable, Self::SourceRecovered];
    pub fn as_str(self) -> &'static str { match self { Self::ExecutionFailed => "execution-failed", Self::DeliveryFailed => "delivery-failed", Self::SourceUnavailable => "source-unavailable", Self::SourceRecovered => "source-recovered" } }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalEvent {
    pub id: String, pub source_id: String, pub entity_id: String,
    #[serde(rename = "type")]
    pub event_type: LocalEventType,
    #[serde(deserialize_with = "super::required_nullable")]
    pub occurred_at: Option<String>,
    pub observed_at: String, pub result_code: String,
    #[serde(deserialize_with = "super::required_nullable")]
    pub target: Option<NavigationTarget>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub event_type: Option<LocalEventType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upper: Option<u64>,
}
impl EventQuery {
    pub fn validate(&self) -> Result<()> {
        if let Some(source) = &self.source_id { validate_text(source, 128, 512, "event source")?; }
        for value in [&self.from, &self.to].into_iter().flatten() { validate_iso_time(value)?; }
        if matches!((&self.from, &self.to), (Some(from), Some(to)) if from > to)
            || [self.before, self.upper].into_iter().flatten().any(|cursor| cursor > 9_007_199_254_740_991) {
            return Err(Error::invalid("event range"));
        }
        Ok(())
    }
}
pub fn validate_iso_time(value: &str) -> Result<()> {
    let date = chrono::DateTime::parse_from_rfc3339(value).map_err(|_| Error::invalid("event time"))?;
    if value.len() != 24 || date.to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) != value {
        return Err(Error::invalid("event time"));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RetentionReason { Age, Count, Bytes }
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventRetention {
    pub count: usize, pub newest_sequence: u64, pub oldest_observed_at: Option<String>,
    pub deleted_count: usize, pub deleted_through: Option<String>, pub reason: Option<RetentionReason>, pub disk_bytes: u64,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CoverageState { Baseline, Observing, CatchingUp, Gap, Disabled, Unavailable }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventGap { pub from: String, pub to: String, pub code: String, pub count: usize }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventCoverage {
    pub source_id: String, pub state: CoverageState, pub since: Option<String>, pub observed_at: Option<String>, pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_gap: Option<EventGap>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventSnapshot {
    pub collected_at: String, pub sources: Vec<SourceStatus>, pub revision: u64,
    pub retention: EventRetention, pub coverage: Vec<EventCoverage>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventPage {
    pub entries: Vec<LocalEvent>, pub next: Option<u64>, pub upper: u64, pub revision: u64,
    pub retention: EventRetention, pub coverage: Vec<EventCoverage>,
}
