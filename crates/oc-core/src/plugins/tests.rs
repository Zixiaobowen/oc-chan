use super::*;
use crate::{error::{Error, Result}, io::BoundedIo, model::{EventRetention, EventSnapshot, MonitorSection}, resources::ResourceBudget};
use std::{sync::{Arc, Mutex, atomic::{AtomicBool, AtomicUsize, Ordering}}, time::Duration};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

fn snapshot() -> SnapshotData { SnapshotData::Events(EventSnapshot { collected_at: crate::error::timestamp(), sources: vec![], revision: 1, retention: EventRetention::default(), coverage: vec![] }) }
struct Probe {
    calls: AtomicUsize, starts: AtomicUsize, stops: AtomicUsize, blocked: AtomicBool,
    entered: Notify, release: Notify, cancel_seen: Notify, publishers: Mutex<Vec<Publisher>>,
}
impl Probe { fn new() -> Arc<Self> { Arc::new(Self { calls: AtomicUsize::new(0), starts: AtomicUsize::new(0), stops: AtomicUsize::new(0), blocked: AtomicBool::new(false), entered: Notify::new(), release: Notify::new(), cancel_seen: Notify::new(), publishers: Mutex::new(vec![]) }) } }
struct TestPlugin { probe: Arc<Probe> }
impl CollectionPlugin for TestPlugin {
    fn start(&self, _: CancellationToken) -> BoxFuture<'_, Result<()>> { Box::pin(async { self.probe.starts.fetch_add(1, Ordering::SeqCst); Ok(()) }) }
    fn collect(&self, cancel: CancellationToken, _: Option<String>) -> BoxFuture<'_, Result<Option<SnapshotData>>> { Box::pin(async move {
        self.probe.calls.fetch_add(1, Ordering::SeqCst);
        if self.probe.blocked.load(Ordering::SeqCst) {
            self.probe.entered.notify_one();
            tokio::select! { _ = cancel.cancelled() => { self.probe.cancel_seen.notify_one(); self.probe.release.notified().await; return Err(Error::cancelled()); }, _ = self.probe.release.notified() => {} }
        }
        Ok(Some(snapshot()))
    }) }
    fn stop(&self) -> BoxFuture<'_, Result<()>> { Box::pin(async { self.probe.stops.fetch_add(1, Ordering::SeqCst); Ok(()) }) }
}
fn definition(id: &str, probe: Arc<Probe>) -> PluginDefinition {
    PluginDefinition { id: id.into(), section: MonitorSection::Events, capabilities: vec![], dependencies: vec![], retry_sources: vec!["events-source".into()], interval: Duration::from_secs(60), timeout: Duration::from_secs(2), create: Arc::new(move |context| { probe.publishers.lock().unwrap().push(context.publisher); Ok(Arc::new(TestPlugin { probe: probe.clone() })) }) }
}
fn registry(events: Arc<Mutex<Vec<RegistryEvent>>>) -> Arc<Registry> { Registry::new(BoundedIo::new(ResourceBudget::default()), Arc::new(move |event| events.lock().unwrap().push(event))) }
#[tokio::test]
async fn dormant_registration_never_constructs_or_samples() {
    let probe = Probe::new(); let registry = registry(Arc::new(Mutex::new(vec![])));
    registry.register(definition("test", probe.clone()), false).await.unwrap();
    assert!(probe.publishers.lock().unwrap().is_empty()); assert_eq!(probe.starts.load(Ordering::SeqCst), 0); assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
    registry.set_enabled("test", true).await.unwrap(); assert_eq!(probe.starts.load(Ordering::SeqCst), 1); assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
    registry.close().await.unwrap();
}
#[tokio::test]
async fn old_generation_publishers_never_reacquire_authority() {
    let events = Arc::new(Mutex::new(vec![])); let registry = registry(events.clone()); let probe = Probe::new();
    registry.register(definition("test", probe.clone()), true).await.unwrap();
    let old = probe.publishers.lock().unwrap()[0].clone();
    registry.set_enabled("test", false).await.unwrap();
    assert!(!events.lock().unwrap().iter().any(|e| matches!(e, RegistryEvent::Removed { .. })));
    registry.set_enabled("test", true).await.unwrap();
    assert!(!old.publish(snapshot(), None, true).unwrap());
    let new = probe.publishers.lock().unwrap()[1].clone(); assert!(new.generation() > old.generation()); assert!(new.publish(snapshot(), None, true).unwrap());
    registry.unregister("test").await.unwrap(); assert!(!new.publish(snapshot(), None, false).unwrap());
    assert_eq!(events.lock().unwrap().iter().filter(|e| matches!(e, RegistryEvent::Removed { .. })).count(), 1);
    registry.close().await.unwrap();
}
#[tokio::test]
async fn concurrent_refreshes_merge_and_disable_waits_for_actual_cleanup() {
    let registry = registry(Arc::new(Mutex::new(vec![]))); let probe = Probe::new();
    registry.register(definition("test", probe.clone()), true).await.unwrap(); probe.blocked.store(true, Ordering::SeqCst);
    let r = registry.clone(); let collect = tokio::spawn(async move { r.collect("test", None).await }); probe.entered.notified().await;
    let r = registry.clone(); let merged = tokio::spawn(async move { r.collect("test", None).await });
    tokio::task::yield_now().await;
    let r = registry.clone(); let disable = tokio::spawn(async move { r.set_enabled("test", false).await });
    probe.cancel_seen.notified().await;
    assert!(!disable.is_finished()); assert_eq!(probe.stops.load(Ordering::SeqCst), 0);
    probe.release.notify_one(); assert!(collect.await.unwrap().unwrap_err().is_cancelled()); assert!(merged.await.unwrap().unwrap_err().is_cancelled());
    disable.await.unwrap().unwrap(); assert_eq!(probe.calls.load(Ordering::SeqCst), 2); assert_eq!(probe.stops.load(Ordering::SeqCst), 1);
    registry.close().await.unwrap();
}
#[tokio::test]
async fn collect_deadline_cancels_but_never_drops_cleanup_future() {
    let registry = registry(Arc::new(Mutex::new(vec![]))); let probe = Probe::new(); let mut definition = definition("test", probe.clone()); definition.timeout = Duration::from_millis(20);
    registry.register(definition, true).await.unwrap(); probe.blocked.store(true, Ordering::SeqCst);
    let r = registry.clone(); let collect = tokio::spawn(async move { r.collect("test", None).await }); probe.entered.notified().await; probe.cancel_seen.notified().await;
    assert!(!collect.is_finished()); probe.release.notify_one(); assert_eq!(collect.await.unwrap().unwrap_err().code, "ETIMEDOUT");
    registry.set_enabled("test", false).await.unwrap(); registry.close().await.unwrap();
}
#[tokio::test]
async fn dependencies_reject_missing_cycles_and_live_consumer_removal() {
    let registry = registry(Arc::new(Mutex::new(vec![]))); let probe = Probe::new();
    let mut cycle = definition("cycle", probe.clone()); cycle.dependencies = vec!["cycle".into()]; assert!(registry.register(cycle, false).await.is_err());
    let mut missing = definition("consumer", probe.clone()); missing.dependencies = vec!["dependency".into()]; assert!(registry.register(missing.clone(), false).await.is_err());
    registry.register(definition("dependency", probe.clone()), true).await.unwrap(); registry.register(missing, true).await.unwrap();
    assert!(registry.set_enabled("dependency", false).await.is_err()); assert!(registry.unregister("dependency").await.is_err());
    registry.unregister("consumer").await.unwrap(); registry.unregister("dependency").await.unwrap(); registry.close().await.unwrap();
}
#[test]
fn native_json_rejects_wrong_section_unknown_keys_and_oversized_result() {
    assert!(SnapshotData::from_json(MonitorSection::System, br#"{"collectedAt":"2026-11-10T00:00:00.000Z","untrusted":true}"#).is_err());
    assert!(SnapshotData::from_json(MonitorSection::Events, &vec![b' '; oc_plugin_sdk::MAX_RESULT + 1]).is_err());
}
