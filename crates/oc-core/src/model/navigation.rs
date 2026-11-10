use serde::{Deserialize, Serialize};
use super::{AgentInfo, ScheduledJob, MonitorSection};
use crate::error::{Error, Result, validate_text};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppPage { Overview, Agents, Schedules, Events, System, Sources, Plugins, Settings }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum NavigationTarget {
    Page { page: AppPage },
    Agent { id: String, identity: String },
    Schedule { id: String, identity: String },
    Source { id: String, section: MonitorSection },
}
impl NavigationTarget {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Page { .. } => Ok(()),
            Self::Agent { id, identity } => {
                validate_text(id, 512, 2048, "agent id")?;
                validate_text(identity, 16384, 65536, "agent identity")
            }
            Self::Schedule { id, identity } => {
                validate_text(id, 256, 1024, "schedule id")?;
                validate_text(identity, 16384, 65536, "schedule identity")
            }
            Self::Source { id, .. } => validate_text(id, 128, 512, "source id"),
        }
    }
    pub fn agent(agent: &AgentInfo) -> Self {
        Self::Agent { id: agent.id.clone(), identity: serde_json::json!([agent.runtime, agent.pid, agent.session_id, agent.started_at]).to_string() }
    }
    pub fn schedule(job: &ScheduledJob) -> Self {
        Self::Schedule { id: job.id.clone(), identity: serde_json::json!([job.source, job.scope, job.file, job.executable]).to_string() }
    }
    pub fn page(&self) -> AppPage {
        match self { Self::Page { page } => *page, Self::Agent { .. } => AppPage::Agents, Self::Schedule { .. } => AppPage::Schedules, Self::Source { .. } => AppPage::Sources }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NavigationIntent { pub sequence: u64, pub target: NavigationTarget }
#[derive(Default)]
pub struct PendingNavigation { sequence: u64, intent: Option<NavigationIntent> }
impl PendingNavigation {
    pub fn put(&mut self, target: NavigationTarget) -> Result<()> {
        target.validate()?;
        if self.sequence >= 9_007_199_254_740_991 { return Err(Error::new("OC_NAVIGATION_SEQUENCE", "导航序列已耗尽 / Navigation sequence exhausted")); }
        self.sequence += 1;
        self.intent = Some(NavigationIntent { sequence: self.sequence, target });
        Ok(())
    }
    pub fn read(&self) -> Option<&NavigationIntent> { self.intent.as_ref() }
    pub fn acknowledge(&mut self, sequence: u64) {
        if self.intent.as_ref().is_some_and(|intent| intent.sequence == sequence) { self.intent = None; }
    }
}
