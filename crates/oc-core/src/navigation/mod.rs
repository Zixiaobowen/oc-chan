use std::sync::Mutex;
use crate::{error::{Error, Result}, model::*};

#[derive(Default)]
pub struct NavigationController { pending: Mutex<PendingNavigation> }
impl NavigationController {
    pub fn new() -> Self { Self::default() }
    pub fn put(&self, target: NavigationTarget, snapshot: &MonitorSnapshot) -> Result<()> {
        validate_target(&target, snapshot)?;
        self.pending.lock().map_err(|_| Error::new("OC_NAVIGATION_STATE", "导航状态锁失败 / Navigation state lock failed"))?.put(target)
    }
    pub fn read(&self) -> Result<Option<NavigationIntent>> {
        Ok(self.pending.lock().map_err(|_| Error::new("OC_NAVIGATION_STATE", "导航状态锁失败 / Navigation state lock failed"))?.read().cloned())
    }
    pub fn acknowledge(&self, sequence: u64) -> Result<()> {
        if sequence == 0 || sequence > 9_007_199_254_740_991 { return Err(Error::invalid("navigation sequence")); }
        self.pending.lock().map_err(|_| Error::new("OC_NAVIGATION_STATE", "导航状态锁失败 / Navigation state lock failed"))?.acknowledge(sequence);
        Ok(())
    }
}
pub fn validate_target(target: &NavigationTarget, snapshot: &MonitorSnapshot) -> Result<()> {
    target.validate()?;
    let valid = match target {
        NavigationTarget::Page { .. } => true,
        NavigationTarget::Agent { id, .. } => snapshot.agents.data.as_ref().is_some_and(|data| data.agents.iter().filter(|agent| agent.id == *id).count() == 1 && data.agents.iter().any(|agent| NavigationTarget::agent(agent) == *target)),
        NavigationTarget::Schedule { id, .. } => snapshot.schedules.data.as_ref().is_some_and(|data| data.jobs.iter().filter(|job| job.id == *id).count() == 1 && data.jobs.iter().any(|job| NavigationTarget::schedule(job) == *target)),
        NavigationTarget::Source { id, section } => {
            let sources = match section {
                MonitorSection::Agents => snapshot.agents.data.as_ref().map(|data| &data.sources),
                MonitorSection::Schedules => snapshot.schedules.data.as_ref().map(|data| &data.sources),
                MonitorSection::System => snapshot.system.data.as_ref().map(|data| &data.sources),
                MonitorSection::Events => snapshot.events.data.as_ref().map(|data| &data.sources),
            };
            sources.is_some_and(|sources| sources.iter().filter(|source| source.id == *id).count() == 1)
        }
    };
    if valid { Ok(()) } else { Err(Error::new("OC_NAVIGATION_TARGET", "导航目标已失效 / Navigation target is no longer current")) }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn stale_acknowledgement_preserves_replacement() {
        let navigation = NavigationController::new(); let snapshot = MonitorSnapshot::default();
        navigation.put(NavigationTarget::Page { page: AppPage::Agents }, &snapshot).unwrap();
        let first = navigation.read().unwrap().unwrap().sequence;
        navigation.put(NavigationTarget::Page { page: AppPage::Events }, &snapshot).unwrap();
        navigation.acknowledge(first).unwrap();
        let second = navigation.read().unwrap().unwrap(); assert_eq!(second.target.page(), AppPage::Events);
        navigation.acknowledge(second.sequence).unwrap(); assert!(navigation.read().unwrap().is_none());
    }
    #[test] fn missing_object_is_not_navigation_evidence() {
        assert!(validate_target(&NavigationTarget::Agent { id:"a".into(), identity:"[]".into() }, &MonitorSnapshot::default()).is_err());
        assert!(serde_json::from_str::<NavigationTarget>(r#"{"kind":"page","page":"agents","url":"https://example.org"}"#).is_err());
    }
}
