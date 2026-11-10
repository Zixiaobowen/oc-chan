use super::*;
use std::collections::BTreeMap;
use oc_installer::{HistoryReadiness, PartitionEvidence, PartitionReadiness, ReadyEvidence};
use crate::{config::InstallationReceipt, documents::Document};

fn bounded_reason(value: &str) -> String {
    if value.len() <= 512 { return value.to_owned(); }
    let mut end = 480; while !value.is_char_boundary(end) { end -= 1; }
    format!("{} [truncated]", &value[..end])
}
fn partition<T>(section: MonitorSection, state: &CollectorState<T>, sources: Option<&[SourceStatus]>, status: Option<&oc_core::plugins::PluginStatus>) -> Result<PartitionEvidence> {
    let Some(status) = status else {
        return if section == MonitorSection::System { Ok(PartitionEvidence { enabled:false, installed:false, state:PartitionReadiness::NotInstalled, reason:Some("system plugin is not installed".into()) }) }
            else { Err(Error::new("OC_READY_PLUGIN", "Required builtin plugin is missing")) };
    };
    if !status.enabled { return Ok(PartitionEvidence { enabled:false, installed:true, state:PartitionReadiness::Disabled, reason:Some("collection is disabled by settings".into()) }); }
    if state.last_attempt_at.is_none() { return Err(Error::new("OC_READY_COLLECTION", "Collection has no completed attempt")); }
    let mut readiness = PartitionReadiness::Ready;
    let mut reason = None;
    if let Some(error) = &state.error { readiness = PartitionReadiness::Unavailable; reason = Some(bounded_reason(error)); }
    else if state.data.is_none() { return Err(Error::new("OC_READY_COLLECTION", "Enabled collector has no completed result")); }
    else if let Some(sources) = sources {
        let applicable: Vec<_> = sources.iter().filter(|source| source.id != "collection-resources").collect();
        if !applicable.is_empty() && applicable.iter().all(|source| matches!(source.state, SourceState::Unsupported | SourceState::Error | SourceState::Disabled)) {
            readiness = if applicable.iter().all(|source| source.state == SourceState::Unsupported) { PartitionReadiness::Unsupported } else { PartitionReadiness::Unavailable };
            reason = Some(bounded_reason(&applicable.iter().map(|source| format!("{}: {}", source.id, source.detail)).collect::<Vec<_>>().join("; ")));
        }
    }
    if section == MonitorSection::System && readiness != PartitionReadiness::Ready { return Err(Error::new("OC_READY_SYSTEM", reason.unwrap_or_else(|| "Installed system collector is not ready".into()))); }
    Ok(PartitionEvidence { enabled:true, installed:true, state:readiness, reason })
}
impl Host {
    pub(super) fn start_receipt(self: &Arc<Self>, document: Arc<Document>) {
        let Some(receipt) = self.config.ready_request.clone() else { return; };
        if self.receipt_started.swap(true, Ordering::AcqRel) { return; }
        let host = self.clone(); let owner_task = document.tasks.token();
        self.background.spawn(async move {
            let _owner_task = owner_task;
            let result = async {
                let request_receipt = receipt.clone();
                let request = host.io.with_file_budget("installation-readiness", 32 * 1024, &document.cancel, move |cancel| async move {
                    tokio::task::spawn_blocking(move || {
                        check_cancel(&cancel)?;
                        match request_receipt {
                            InstallationReceipt::Signed(path) => oc_installer::read_ready_request(&path),
                            InstallationReceipt::Local(path) => oc_installer::read_local_ready_request(&path),
                        }.map_err(|error| Error::new("OC_READY_REQUEST", error.to_string()))
                    }).await.map_err(|_| Error::invalid("readiness authentication task"))?
                }).await?;
                if request.version != env!("CARGO_PKG_VERSION") || request.bundle != host.config.bundle { return Err(Error::invalid("readiness application identity")); }
                let evidence = host.readiness(&document).await?;
                host.io.with_file_budget("installation-readiness", 32 * 1024, &document.cancel, move |cancel| async move {
                    tokio::task::spawn_blocking(move || {
                        check_cancel(&cancel)?;
                        match receipt {
                            InstallationReceipt::Signed(path) => oc_installer::write_ready_receipt(&path, evidence),
                            InstallationReceipt::Local(path) => oc_installer::write_local_ready_receipt(&path, evidence),
                        }.map_err(|error| Error::new("OC_READY_RECEIPT", error.to_string()))
                    }).await.map_err(|_| Error::invalid("readiness publication task"))?
                }).await
            }.await;
            if let Err(error) = result { host.receipt_started.store(false, Ordering::Release); if !error.is_cancelled() { host.report(error); } }
        });
    }
    pub(super) async fn readiness(&self, document: &Document) -> Result<ReadyEvidence> {
        check_cancel(&document.cancel)?;
        if document.view != View::Main || !document.ready.load(Ordering::Acquire) || !document.committed.load(Ordering::Acquire) { return Err(Error::invalid("real renderer commit")); }
        let services = self.services()?;
        services.monitor.refresh(None).await?;
        check_cancel(&document.cancel)?;
        let snapshot = services.monitor.snapshot(); let statuses = services.monitor.registry().statuses();
        let status = |section| statuses.iter().find(|status| status.section == section);
        let mut partitions = BTreeMap::new();
        partitions.insert("agents".into(), partition(MonitorSection::Agents, &snapshot.agents, snapshot.agents.data.as_ref().map(|data| data.sources.as_slice()), status(MonitorSection::Agents))?);
        partitions.insert("schedules".into(), partition(MonitorSection::Schedules, &snapshot.schedules, snapshot.schedules.data.as_ref().map(|data| data.sources.as_slice()), status(MonitorSection::Schedules))?);
        partitions.insert("events".into(), partition(MonitorSection::Events, &snapshot.events, snapshot.events.data.as_ref().map(|data| data.sources.as_slice()), status(MonitorSection::Events))?);
        partitions.insert("system".into(), partition(MonitorSection::System, &snapshot.system, snapshot.system.data.as_ref().map(|data| data.sources.as_slice()), status(MonitorSection::System))?);
        let (hermes_history, history_entries, history_reason) = if !services.monitor.enabled(MonitorSection::Schedules) {
            (HistoryReadiness::Disabled, 0, Some("schedule plugin is disabled".into()))
        } else if let Some(job) = snapshot.schedules.data.as_ref().and_then(|data| data.jobs.iter().find(|job| job.id.starts_with("hermes-job:"))) {
            let history = services.monitor.history(&job.id, 0, document.cancel.child_token()).await?;
            match history.source {
                HistorySource::Hermes => (HistoryReadiness::Available, history.entries.len() as u32, None),
                HistorySource::Unavailable => (HistoryReadiness::Unavailable, 0, Some("history provider reported unavailable".into())),
            }
        } else { (HistoryReadiness::Unavailable, 0, Some("current schedule collection contains no Hermes job".into())) };
        check_cancel(&document.cancel)?;
        Ok(ReadyEvidence { host_version:env!("CARGO_PKG_VERSION").into(), renderer_entry:"main:index.html:react-commit".into(), renderer_committed:true,
            ipc_round_trip:true, partitions, hermes_history, history_entries, history_reason })
    }
}
