//! Acceptance-only observations. No observer, allocation or queue exists in release builds.
use std::{collections::VecDeque, sync::{Mutex, LazyLock}, time::{Instant, SystemTime, UNIX_EPOCH}};
use serde_json::{Value, json};
use crate::{error::{Error, Result}, model::AgentSnapshot};
const CAPACITY: usize = 8192;
struct Probe { rows: VecDeque<Value>, overflow: u64 }
static PROBE: Mutex<Option<Probe>> = Mutex::new(None);
static CLOCK: LazyLock<(Instant, f64)> = LazyLock::new(|| (Instant::now(), SystemTime::now().duration_since(UNIX_EPOCH).expect("system clock before epoch").as_secs_f64() * 1000.0));
pub fn stamp() -> f64 {
    let (start, epoch) = &*CLOCK;
    epoch + start.elapsed().as_secs_f64() * 1000.0
}
pub fn clock() -> Value { json!({"atMs": stamp(), "domain": "rust-monotonic-epoch"}) }
pub fn install() -> Result<()> {
    let mut slot = PROBE.lock().map_err(|_| Error::invalid("performance observer poisoned"))?;
    if slot.is_some() { return Err(Error::invalid("performance observer already installed")); }
    *slot = Some(Probe { rows: VecDeque::with_capacity(CAPACITY), overflow: 0 }); Ok(())
}
pub fn uninstall() -> Result<Value> { let result = drain()?; *PROBE.lock().map_err(|_| Error::invalid("performance observer poisoned"))? = None; Ok(result) }
pub fn drain() -> Result<Value> {
    let mut slot = PROBE.lock().map_err(|_| Error::invalid("performance observer poisoned"))?;
    let probe = slot.as_mut().ok_or_else(|| Error::invalid("performance observer not installed"))?;
    let count = probe.rows.len().min(128);
    Ok(json!({"rows":probe.rows.drain(..count).collect::<Vec<_>>(),"remaining":probe.rows.len(),"overflow":probe.overflow,"clock":stamp()}))
}
pub fn observe(make: impl FnOnce() -> Value) {
    let mut slot = PROBE.lock().expect("performance observer poisoned");
    if let Some(probe) = slot.as_mut() {
        if probe.rows.len() == CAPACITY { probe.overflow += 1; } else { probe.rows.push_back(make()); }
    }
}
pub fn key(name: Option<&str>) -> Option<(u64,u64)> {
    let mut parts = name?.strip_prefix("perf_")?.split('_');
    let index = parts.next()?.parse().ok()?; let sequence = parts.next()?.parse().ok()?;
    if index >= 128 || parts.next().is_some() { return None; } Some((index, sequence))
}
pub fn publication(snapshot: &AgentSnapshot) {
    observe(|| json!(["p",stamp(),snapshot.agents.iter().filter_map(|agent| key(agent.activity.as_ref().and_then(|activity| activity.name.as_deref()))).collect::<Vec<_>>() ]));
}
