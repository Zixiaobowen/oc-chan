use std::{collections::{BTreeMap, VecDeque}, future::Future, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
use oc_core::{diagnostics::Diagnostics, error::{Error, Result, check_cancel}};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use crate::api::View;

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Interest { pub monitor: bool, pub sources: bool, pub settings: bool, pub updates: bool, pub marketplace: bool, pub navigation: bool }
impl Interest {
    pub fn allows(self, channel: &str) -> bool {
        match channel { "monitor-changed" => self.monitor, "monitor-sources" => self.sources, "settings-changed" => self.settings,
            "updates-changed" => self.updates, "marketplace-changed" => self.marketplace, "monitor-navigation" => self.navigation, "desktop-failure" => true, _ => false }
    }
    pub fn validate(self, view: View) -> Result<()> {
        if view == View::Recovery || view == View::Tray && (self.sources || self.updates || self.navigation) { return Err(Error::invalid("window subscriptions")); }
        Ok(())
    }
}

#[derive(Default)]
pub struct QuerySlot { token: Mutex<Option<CancellationToken>>, gate: AsyncMutex<()>, cleanup: Mutex<Option<Error>> }
impl QuerySlot {
    pub async fn run<T, F, Fut>(&self, parent: &CancellationToken, work: F) -> Result<T>
    where F: FnOnce(CancellationToken) -> Fut, Fut: Future<Output = Result<T>> {
        check_cancel(parent)?;
        let token = parent.child_token();
        if let Some(previous) = self.token.lock().map_err(|_| Error::invalid("query state"))?.replace(token.clone()) { previous.cancel(); }
        let _gate = tokio::select! { biased; _ = token.cancelled() => return Err(Error::cancelled()), gate = self.gate.lock() => gate };
        check_cancel(&token)?;
        let result = work(token).await;
        if let Err(error) = &result { if error.is_cleanup() { *self.cleanup.lock().map_err(|_| Error::invalid("query cleanup"))? = Some(error.clone()); } }
        result
    }
    pub async fn cancel(&self) -> Result<()> {
        if let Some(token) = self.token.lock().map_err(|_| Error::invalid("query state"))?.take() { token.cancel(); }
        let _gate = self.gate.lock().await;
        match self.cleanup.lock().map_err(|_| Error::invalid("query cleanup"))?.clone() { Some(error) => Err(error), None => Ok(()) }
    }
}

pub struct Document {
    pub id: u64, pub view: View, pub epoch: u64, pub key: String, pub cancel: CancellationToken,
    pub interest: Mutex<Interest>, pub visible: AtomicBool, pub committed: AtomicBool, pub ready: AtomicBool, pub listening: AtomicBool,
    pub tasks: TaskTracker, pub history: QuerySlot, pub events: QuerySlot, pub diagnostics: Option<Arc<Diagnostics>>,
    pub native_registered: AtomicBool, pub settings_registered: AtomicBool, outbound: Mutex<Outbound>,
}
impl Document {
    pub fn new(id: u64, view: View, epoch: u64, key: String, visible: bool, diagnostics: Option<Arc<Diagnostics>>) -> Self {
        Self { id, view, epoch, key, cancel: CancellationToken::new(), interest: Mutex::new(Interest::default()),
            visible: AtomicBool::new(visible), committed: AtomicBool::new(false), ready: AtomicBool::new(false), listening: AtomicBool::new(false), tasks: TaskTracker::new(),
            history: QuerySlot::default(), events: QuerySlot::default(), diagnostics,
            native_registered: AtomicBool::new(false), settings_registered: AtomicBool::new(false), outbound: Mutex::new(Outbound::default()) }
    }
    pub fn invalidate(&self) { self.cancel.cancel(); self.tasks.close(); }
    pub fn pause_pushes(&self) -> Result<()> {
        let mut outbound = self.outbound.lock().map_err(|_| Error::invalid("desktop push state"))?;
        outbound.pending.clear(); outbound.bytes = 0; Ok(())
    }
    pub fn can_receive(&self, channel: &str, headless: bool) -> Result<bool> {
        Ok(self.ready.load(Ordering::Acquire) && self.listening.load(Ordering::Acquire) && !self.cancel.is_cancelled() && (headless || self.visible.load(Ordering::Acquire))
            && self.interest.lock().map_err(|_| Error::invalid("subscription state"))?.allows(channel))
    }
    pub fn push(&self, channel: &'static str, stream: &'static str, value: Arc<str>) -> Result<Option<Delivery>> {
        let limit = crate::ipc::OUTPUT_LIMIT - 128;
        if value.len() > limit { return Err(Error::limit("desktop event body", limit, value.len())); }
        let mut outbound = self.outbound.lock().map_err(|_| Error::invalid("desktop push state"))?;
        if outbound.in_flight.is_none() && outbound.pending.is_empty() { return outbound.delivery(self.id, Pending { channel, stream, value }).map(Some); }
        let previous = outbound.pending.iter().position(|pending| pending.channel == channel && pending.stream == stream);
        let bytes = outbound.bytes - previous.map_or(0, |index| outbound.pending[index].value.len()) + value.len();
        if bytes > 16 * 1024 * 1024 { return Err(Error::limit("desktop pending bytes", 16 * 1024 * 1024, bytes)); }
        if let Some(index) = previous { outbound.pending[index].value = value; }
        else {
            if outbound.pending.len() >= 13 { return Err(Error::limit("desktop pending streams", 13, 14)); }
            outbound.pending.push_back(Pending { channel, stream, value });
        }
        outbound.bytes = bytes;
        if outbound.in_flight.is_none() {
            let pending = outbound.pending.pop_front().expect("queued desktop push");
            outbound.bytes -= pending.value.len();
            outbound.delivery(self.id, pending).map(Some)
        } else { Ok(None) }
    }
    pub fn acknowledge(&self, sequence: u64) -> Result<Option<Delivery>> {
        let mut outbound = self.outbound.lock().map_err(|_| Error::invalid("desktop push state"))?;
        if sequence == 0 || sequence > outbound.next { return Err(Error::invalid("desktop push acknowledgement")); }
        if outbound.in_flight != Some(sequence) { return Ok(None); }
        outbound.in_flight = None;
        let interest = *self.interest.lock().map_err(|_| Error::invalid("subscription state"))?;
        while let Some(pending) = outbound.pending.pop_front() {
            outbound.bytes -= pending.value.len();
            if interest.allows(pending.channel) { return outbound.delivery(self.id, pending).map(Some); }
        }
        Ok(None)
    }
    pub fn failed_delivery(&self) -> Result<()> {
        self.outbound.lock().map_err(|_| Error::invalid("desktop push state"))?.in_flight = None; Ok(())
    }
    #[cfg(feature="acceptance")]
    pub fn push_statistics(&self) -> Result<serde_json::Value> {
        let outbound = self.outbound.lock().map_err(|_| Error::invalid("desktop push statistics"))?;
        Ok(serde_json::json!({"inFlight":usize::from(outbound.in_flight.is_some()),"pending":outbound.pending.len(),"sequence":outbound.next,"bytes":outbound.bytes}))
    }
}

struct Pending { channel: &'static str, stream: &'static str, value: Arc<str> }
pub struct Delivery { pub channel: &'static str, pub payload: String }
#[derive(Default)]
struct Outbound { next: u64, in_flight: Option<u64>, pending: VecDeque<Pending>, bytes: usize }
impl Outbound {
    fn delivery(&mut self, owner: u64, pending: Pending) -> Result<Delivery> {
        if self.next >= 9_007_199_254_740_991 { return Err(Error::invalid("desktop push sequence")); }
        self.next += 1; self.in_flight = Some(self.next);
        Ok(Delivery { channel: pending.channel, payload: format!("{{\"owner\":{owner},\"sequence\":{},\"value\":{}}}", self.next, pending.value) })
    }
}

#[derive(Default)]
struct State { next: u64, epochs: [u64; 3], documents: BTreeMap<View, Arc<Document>> }
#[derive(Default)]
pub struct Documents { state: Mutex<State>, pub gates: [AsyncMutex<()>; 3] }
pub fn index(view: View) -> usize { match view { View::Main => 0, View::Tray => 1, View::Recovery => 2 } }
impl Documents {
    pub fn invalidate(&self, view: View) -> Result<()> {
        let mut state = self.state.lock().map_err(|_| Error::invalid("document state"))?;
        state.epochs[index(view)] = state.epochs[index(view)].checked_add(1).ok_or_else(|| Error::invalid("document generation"))?;
        if let Some(document) = state.documents.get(&view) { document.invalidate(); }
        Ok(())
    }
    pub fn allocate(&self, view: View) -> Result<(u64, u64)> {
        let mut state = self.state.lock().map_err(|_| Error::invalid("document state"))?;
        if state.next >= 9_007_199_254_740_991 { return Err(Error::invalid("document owner sequence")); }
        state.next += 1;
        Ok((state.next, state.epochs[index(view)]))
    }
    pub fn insert(&self, document: Arc<Document>) -> Result<()> {
        let mut state = self.state.lock().map_err(|_| Error::invalid("document state"))?;
        if state.epochs[index(document.view)] != document.epoch || state.documents.contains_key(&document.view) {
            return Err(Error::new("OC_DOCUMENT_CHANGED", "窗口文档已变化 / Desktop document changed"));
        }
        state.documents.insert(document.view, document); Ok(())
    }
    pub fn current(&self, view: View, owner: u64, key: &str) -> Result<Arc<Document>> {
        let state = self.state.lock().map_err(|_| Error::invalid("document state"))?;
        state.documents.get(&view).filter(|document| document.id == owner && document.key == key
            && document.ready.load(Ordering::Acquire) && document.epoch == state.epochs[index(view)] && !document.cancel.is_cancelled()).cloned()
            .ok_or_else(|| Error::new("OC_DOCUMENT_REVOKED", "窗口文档权限已撤销 / Desktop document is no longer authorized"))
    }
    pub fn take(&self, view: View) -> Result<Option<Arc<Document>>> {
        Ok(self.state.lock().map_err(|_| Error::invalid("document state"))?.documents.remove(&view))
    }
    pub fn get(&self, view: View) -> Result<Option<Arc<Document>>> {
        Ok(self.state.lock().map_err(|_| Error::invalid("document state"))?.documents.get(&view).cloned())
    }
    pub fn all(&self) -> Result<Vec<Arc<Document>>> {
        Ok(self.state.lock().map_err(|_| Error::invalid("document state"))?.documents.values().cloned().collect())
    }
}

#[cfg(test)]
#[path="document_tests.rs"]
mod tests;
