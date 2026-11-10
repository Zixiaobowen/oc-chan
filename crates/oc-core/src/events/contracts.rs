use serde::{Deserialize, Serialize};
use crate::{error::{Error, Result, validate_text}, model::*};
pub const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct PendingExecution { pub rowid: u64, pub id: String, pub status: String, #[serde(deserialize_with="nullable")] pub delivery: Option<String> }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct HermesCursor { pub identity: String, pub baseline: u64, pub high: u64, pub revisit: u64, pub floor: u64, pub since: String, pub last_observed_at: String, pub pending: Vec<PendingExecution>, pub pending_index: usize }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct HermesRow { pub rowid: u64, pub id: String, pub job_id: String, pub status: String, pub claimed_at: String, #[serde(deserialize_with="nullable")] pub finished_at: Option<String>, #[serde(deserialize_with="nullable")] pub delivery: Option<String>, #[serde(default)] pub baseline_status: Option<String>, #[serde(default)] pub baseline_delivery: Option<String> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct HermesRead { pub cursor: HermesCursor, pub rows: Vec<HermesRow>, pub coverage: EventCoverage }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct SourceCursor { pub id: String, pub section: MonitorSection, pub state: SourceState, pub observed_at: String, #[serde(deserialize_with="nullable")] pub unavailable_since: Option<String>, pub announced: bool, pub generation: u64 }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Checkpoint { pub version: u8, #[serde(deserialize_with="nullable")] pub hermes: Option<HermesCursor>, pub sources: Vec<SourceCursor>, pub coverage: Vec<EventCoverage>, #[serde(deserialize_with="nullable")] pub observed_at: Option<String> }
impl Default for Checkpoint { fn default()->Self { Self { version:1, hermes:None, sources:vec![], coverage:vec![], observed_at:None } } }
impl HermesCursor {
    pub fn validate(&self)->Result<()> {
        validate_text(&self.identity,128,512,"Hermes identity")?;
        let parts: Vec<_> = self.identity.split(':').collect();
        if parts.len()!=2 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b|b.is_ascii_digit())) || self.high>SAFE_INTEGER || self.baseline>self.high || self.floor>self.high || self.revisit<self.baseline || self.revisit>self.high || self.pending.len()>128 || self.pending_index>=self.pending.len().max(1) { return Err(Error::invalid("Hermes cursor")); }
        validate_iso_time(&self.since)?; validate_iso_time(&self.last_observed_at)?;
        if self.last_observed_at<self.since { return Err(Error::invalid("Hermes cursor time")); }
        let mut seen=std::collections::HashSet::new();
        for row in &self.pending { if row.rowid==0 || row.rowid>self.baseline || !seen.insert(row.rowid) { return Err(Error::invalid("Hermes pending row")); } validate_text(&row.id,128,512,"execution id")?; validate_status(&row.status,row.delivery.as_deref())?; }
        Ok(())
    }
}
pub fn validate_status(status:&str,delivery:Option<&str>)->Result<()> {
    if !matches!(status,"claimed"|"running"|"completed"|"failed") || delivery.is_some_and(|d|!matches!(d,"delivered"|"failed"|"suppressed"|"suppressed_acked")) { return Err(Error::new("OC_HERMES_STATUS","Hermes 执行或投递状态不受支持 / Unsupported execution or delivery status")); } Ok(())
}
impl Checkpoint {
    pub fn validate(&self)->Result<()> {
        if self.version!=1 || self.sources.len()>64 || self.coverage.len()>8 { return Err(Error::invalid("event checkpoint")); }
        if let Some(at)=&self.observed_at { validate_iso_time(at)?; }
        if let Some(c)=&self.hermes { c.validate()?; }
        let mut seen=std::collections::HashSet::new();
        for c in &self.sources { validate_text(&c.id,128,512,"source id")?; validate_iso_time(&c.observed_at)?; if let Some(at)=&c.unavailable_since { validate_iso_time(at)?; } if c.generation>SAFE_INTEGER || !seen.insert((c.section,c.id.as_str())) { return Err(Error::invalid("source cursor")); } }
        let mut seen=std::collections::HashSet::new();
        for c in &self.coverage { validate_text(&c.source_id,128,512,"coverage source")?; if !seen.insert(c.source_id.as_str()) { return Err(Error::invalid("duplicate coverage")); } for at in [&c.since,&c.observed_at].into_iter().flatten() { validate_iso_time(at)?; } if let Some(code)=&c.code { validate_text(code,64,256,"coverage code")?; } if let Some(g)=&c.last_gap { validate_iso_time(&g.from)?; validate_iso_time(&g.to)?; validate_text(&g.code,64,256,"gap code")?; if g.from>g.to || g.count==0 || g.count as u64>SAFE_INTEGER { return Err(Error::invalid("coverage gap")); } } }
        if serde_json::to_vec(self).map_err(|_|Error::invalid("checkpoint"))?.len()>128*1024 { return Err(Error::invalid("checkpoint bytes")); } Ok(())
    }
}
pub fn validate_event(event:&LocalEvent)->Result<()> {
    validate_text(&event.id,512,2048,"event id")?; validate_text(&event.source_id,128,512,"event source")?; validate_text(&event.entity_id,256,1024,"event entity")?; validate_text(&event.result_code,64,256,"event result")?;
    validate_iso_time(&event.observed_at)?; if let Some(at)=&event.occurred_at { validate_iso_time(at)?; }
    if let Some(target)=&event.target { target.validate()?; match target { NavigationTarget::Page{..}=>return Err(Error::invalid("event target")), NavigationTarget::Agent{id,identity}|NavigationTarget::Schedule{id,identity}=>{validate_text(id,256,1024,"event target id")?;validate_text(identity,1536,6144,"event target identity")?;}, _=>{} } }
    if serde_json::to_vec(event).map_err(|_|Error::invalid("event"))?.len()>EVENT_RECORD_BYTES { return Err(Error::invalid("event record bytes")); } Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct StoredState { pub identity:String, pub revision:u64, #[serde(deserialize_with="nullable")] pub checkpoint:Option<Checkpoint>, pub retention:EventRetention }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Added { pub sequence:u64, pub index:usize }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct CommitResult { pub revision:u64, pub checkpoint:Checkpoint, pub retention:EventRetention, pub identity:String, pub added:Vec<Added> }
#[derive(Clone, Debug)]
pub struct NotificationBatch { pub identity:String, pub events:Vec<(u64,LocalEvent)> }
pub fn digest(value:impl AsRef<[u8]>)->String { use sha2::{Sha256,Digest}; format!("{:x}",Sha256::digest(value.as_ref())) }
pub fn event_id(parts:&[&str])->String { digest(serde_json::to_vec(parts).expect("string array serializes")) }

pub fn nullable<'de,D,T>(deserializer:D)->std::result::Result<Option<T>,D::Error> where D:serde::Deserializer<'de>,T:Deserialize<'de>{Option::<T>::deserialize(deserializer)}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn persisted_nullable_fields_cannot_be_omitted(){let mut value=serde_json::to_value(Checkpoint::default()).unwrap();value.as_object_mut().unwrap().remove("hermes");assert!(serde_json::from_value::<Checkpoint>(value).is_err());let mut value=serde_json::to_value(Checkpoint::default()).unwrap();value.as_object_mut().unwrap().remove("observedAt");assert!(serde_json::from_value::<Checkpoint>(value).is_err());assert!(serde_json::from_value::<PendingExecution>(serde_json::json!({"rowid":1,"id":"id","status":"running"})).is_err());}
}
