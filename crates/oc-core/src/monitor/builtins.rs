use super::*;

pub(super) fn definitions(io: BoundedIo, worker: DataWorker, agents: AgentPaths, schedules: SchedulePaths, service: EventService, shared: &Arc<Shared>) -> Result<[PluginDefinition; 3]> {
    // Validate schedule paths before any registration or lifecycle is admitted.
    ScheduleCollector::with_paths(io.clone(), worker.clone(), schedules.clone())?;
    let weak = Arc::downgrade(shared); let agent_definition = PluginDefinition {
        id: "agents".into(), section: MonitorSection::Agents, capabilities: vec!["agent-discovery".into(), "session-activity".into()], dependencies: Vec::new(), retry_sources: Vec::new(),
        interval: Duration::from_millis(AGENT_DISCOVERY_INTERVAL_MS), timeout: Duration::from_secs(30),
        create: Arc::new(move |context| {
            let shared = weak.upgrade().ok_or_else(Error::cancelled)?; let publisher = context.publisher.clone();
            let collector = Arc::new(AgentCollector::with_paths(context.io.clone(), agents.clone(), Arc::new(move |result| match result {
                Ok(snapshot) => { if let Err(error) = publisher.publish(SnapshotData::Agents(snapshot), None, true) { publisher.report_error(error); } }
                Err(error) => { if !error.is_cancelled() { publisher.report_error(error); } }
            })));
            let generation = context.publisher.generation(); *shared.agent.lock().expect("agent instance poisoned") = Some((generation, Arc::downgrade(&collector)));
            Ok(Arc::new(AgentPlugin { collector, life: context.cancel, shared: Arc::downgrade(&shared), generation }))
        }),
    };
    let weak = Arc::downgrade(shared); let retry_sources = shared.retry_sources.clone();
    let schedule_definition = PluginDefinition {
        id: "schedules".into(), section: MonitorSection::Schedules, capabilities: vec!["scheduled-jobs".into(), "schedule-history".into()], dependencies: Vec::new(), retry_sources,
        interval: Duration::from_secs(30), timeout: Duration::from_secs(30),
        create: Arc::new(move |context| Ok(Arc::new(SchedulePlugin { collector: ScheduleCollector::with_paths(context.io, worker.clone(), schedules.clone())?, life: context.cancel, gate: AsyncMutex::new(()), shared: weak.clone() }))),
    };
    let weak = Arc::downgrade(shared);
    let event_definition = PluginDefinition {
        id: "events".into(), section: MonitorSection::Events, capabilities: vec!["local-events".into()], dependencies: Vec::new(), retry_sources: Vec::new(),
        interval: Duration::from_secs(30), timeout: Duration::from_secs(15),
        create: Arc::new(move |context| Ok(Arc::new(EventsPlugin { service: service.clone(), life: context.cancel, shared: weak.clone() }))),
    };
    Ok([agent_definition, schedule_definition, event_definition])
}
struct AgentPlugin { collector: Arc<AgentCollector>, life: CancellationToken, shared: Weak<Shared>, generation: u64 }
impl CollectionPlugin for AgentPlugin {
    fn start(&self, cancel: CancellationToken) -> BoxFuture<'_, Result<()>> { Box::pin(async move { check_cancel(&self.life)?; self.collector.start(cancel).await }) }
    fn collect(&self, cancel: CancellationToken, source: Option<String>) -> BoxFuture<'_, Result<Option<SnapshotData>>> {
        Box::pin(async move { check_cancel(&self.life)?; if source.is_some() { return Err(Error::new("OC_PLUGIN_CAPABILITY", "Agent collection has no source retry")); } self.collector.collect(&cancel).await.map(|data| Some(SnapshotData::Agents(data))) })
    }
    fn stop(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            self.life.cancel(); let result = self.collector.stop().await;
            if result.is_ok() { if let Some(shared) = self.shared.upgrade() { let mut slot = shared.agent.lock().expect("agent instance poisoned"); if slot.as_ref().is_some_and(|(generation,_)| *generation == self.generation) { slot.take(); } } }
            result
        })
    }
}
struct SchedulePlugin { collector: ScheduleCollector, life: CancellationToken, gate: AsyncMutex<()>, shared: Weak<Shared> }
impl CollectionPlugin for SchedulePlugin {
    fn start(&self, cancel: CancellationToken) -> BoxFuture<'_, Result<()>> { Box::pin(async move { check_cancel(&self.life)?; check_cancel(&cancel) }) }
    fn collect(&self, cancel: CancellationToken, source: Option<String>) -> BoxFuture<'_, Result<Option<SnapshotData>>> {
        Box::pin(async move { let _gate = self.gate.lock().await; check_cancel(&self.life)?; check_cancel(&cancel)?;
            let result = if let Some(source) = source { self.collector.retry_source(&source, &cancel).await } else { self.collector.collect(&cancel).await };
            result.map(|data| Some(SnapshotData::Schedules(data)))
        })
    }
    fn history(&self, job: ScheduledJob, offset: usize, cancel: CancellationToken) -> BoxFuture<'_, Result<ScheduleHistory>> {
        Box::pin(async move {
            let _gate = self.gate.lock().await; check_cancel(&self.life)?; check_cancel(&cancel)?;
            let shared = self.shared.upgrade().ok_or_else(Error::cancelled)?; shared.require_job(&job)?;
            let page = self.collector.history(&job, offset, &cancel).await?; check_cancel(&self.life)?; shared.require_job(&job)?; Ok(page)
        })
    }
    fn stop(&self) -> BoxFuture<'_, Result<()>> { Box::pin(async move { self.life.cancel(); let _drained = self.gate.lock().await; Ok(()) }) }
}
struct EventsPlugin { service: EventService, life: CancellationToken, shared: Weak<Shared> }
impl CollectionPlugin for EventsPlugin {
    fn start(&self, cancel: CancellationToken) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            check_cancel(&self.life)?; check_cancel(&cancel)?;
            let work = self.service.start(); tokio::pin!(work);
            tokio::select! {
                result = &mut work => result,
                _ = cancel.cancelled() => {
                    let (started, stopped) = tokio::join!(biased; work, self.service.stop());
                    let mut errors = vec![Error::cancelled()];
                    if let Err(error) = started { if !error.is_cancelled() { errors.push(error); } }
                    if let Err(error) = stopped { errors.push(Error::cleanup("event startup", error)); }
                    Err(Error::aggregate(errors))
                }
            }
        })
    }
    fn collect(&self, cancel: CancellationToken, source: Option<String>) -> BoxFuture<'_, Result<Option<SnapshotData>>> {
        Box::pin(async move {
            check_cancel(&self.life)?; if source.is_some() { return Err(Error::new("OC_PLUGIN_CAPABILITY", "Event collection has no source retry")); }
            let shared = self.shared.upgrade().ok_or_else(Error::cancelled)?;
            let input = { let state = shared.state.lock().expect("monitor state poisoned"); EventInput { snapshot: state.snapshot.clone(), enabled: SectionEnabled { agents: state.enabled.agents, schedules: state.enabled.schedules, system: state.enabled.system } } };
            self.service.collect(input, &cancel).await.map(|data| Some(SnapshotData::Events(data)))
        })
    }
    fn events(&self, query: EventQuery, cancel: CancellationToken) -> BoxFuture<'_, Result<EventPage>> { Box::pin(async move { check_cancel(&self.life)?; self.service.query(query, &cancel).await }) }
    fn stop(&self) -> BoxFuture<'_, Result<()>> { Box::pin(async move { self.life.cancel(); self.service.stop().await }) }
}
