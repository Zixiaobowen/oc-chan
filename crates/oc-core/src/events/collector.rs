use crate::{error::{Error, Result, validate_text}, model::*};
use super::contracts::*;
#[derive(Clone, Debug)]
pub struct Observation { pub id:String, pub section:MonitorSection, pub state:SourceState, pub observed_at:String }
pub struct Transition { pub sources:Vec<SourceCursor>, pub events:Vec<LocalEvent>, pub gap:bool, pub deferred:bool }
fn millis(value:&str)->Result<i64> { validate_iso_time(value)?; Ok(chrono::DateTime::parse_from_rfc3339(value).map_err(|_|Error::invalid("observation time"))?.timestamp_millis()) }
pub fn observe(previous:&[SourceCursor], observations:&[Observation], now:&str)->Result<Transition> {
    if previous.len()>64 || observations.len()>64 { return Err(Error::limit("event sources",64,observations.len().max(previous.len()))); }
    let now_ms=millis(now)?;
    let mut output=Transition{sources:vec![],events:vec![],gap:false,deferred:false};
    let mut seen=std::collections::HashSet::new();
    for sample in observations {
        validate_text(&sample.id,128,512,"source id")?;
        if !seen.insert((sample.section,sample.id.as_str())) { return Err(Error::invalid("duplicate source observation")); }
        let at=millis(&sample.observed_at)?;
        if at>now_ms { return Err(Error::invalid("future source observation")); }
        let before=previous.iter().find(|c|c.id==sample.id && c.section==sample.section);
        if let Some(before)=before { if before.observed_at==sample.observed_at && before.state==sample.state { output.sources.push(before.clone()); continue; } }
        let interrupted=if let Some(before)=before { let prior=millis(&before.observed_at)?; at<prior || at-prior>120_000 } else {false};
        output.gap |= interrupted;
        let mut next=SourceCursor{id:sample.id.clone(),section:sample.section,state:sample.state,observed_at:sample.observed_at.clone(),unavailable_since:None,announced:false,generation:before.map_or(0,|c|c.generation)};
        let mut kind=None;
        match sample.state {
            SourceState::Error=>{
                next.unavailable_since=Some(if !interrupted && before.is_some_and(|c|c.state==SourceState::Error) { before.and_then(|c|c.unavailable_since.clone()).unwrap_or_else(||sample.observed_at.clone()) } else {sample.observed_at.clone()});
                next.announced=before.is_some_and(|c|c.announced);
                if !next.announced && at-millis(next.unavailable_since.as_ref().expect("assigned"))?>=60_000 { if next.generation>=SAFE_INTEGER { return Err(Error::invalid("source generation exhausted")); } next.generation+=1; next.announced=true; kind=Some(LocalEventType::SourceUnavailable); }
            },
            SourceState::Ok|SourceState::Empty if before.is_some_and(|c|c.announced)=>kind=Some(LocalEventType::SourceRecovered),
            SourceState::Partial if before.is_some_and(|c|c.announced)=>{ next.announced=true; next.unavailable_since=before.and_then(|c|c.unavailable_since.clone()); },
            _=>{}
        }
        if kind.is_some() && output.events.len()==16 { output.deferred=true; if let Some(before)=before { output.sources.push(before.clone()); } continue; }
        if let Some(kind)=kind {
            let since=if kind==LocalEventType::SourceUnavailable {next.unavailable_since.as_deref()} else {before.and_then(|c|c.unavailable_since.as_deref())}.ok_or_else(||Error::invalid("announced outage without onset"))?;
            let section=serde_json::to_value(sample.section).map_err(|_|Error::invalid("section"))?;
            output.events.push(LocalEvent{id:event_id(&["source",section.as_str().expect("enum string"),&sample.id,&next.generation.to_string(),since,kind.as_str()]),source_id:sample.id.clone(),entity_id:sample.id.clone(),event_type:kind,occurred_at:Some(if kind==LocalEventType::SourceUnavailable {since.to_owned()} else {sample.observed_at.clone()}),observed_at:now.into(),result_code:if kind==LocalEventType::SourceUnavailable {"source-error"} else {"source-ok"}.into(),target:if sample.id.starts_with("collection:"){None}else{Some(NavigationTarget::Source{id:sample.id.clone(),section:sample.section})}});
        }
        output.sources.push(next);
    }
    Ok(output)
}
pub fn preserve_gap(mut value:EventCoverage, previous:Option<&EventCoverage>,now:&str)->EventCoverage {
    if !matches!(value.state,CoverageState::Gap|CoverageState::Unavailable) { value.last_gap=previous.and_then(|p|p.last_gap.clone()); return value; }
    let same=previous.is_some_and(|p|p.state==value.state && p.code==value.code);
    let from=if same {previous.and_then(|p|p.last_gap.as_ref().map(|g|g.from.clone()))}else{None}.or_else(||previous.and_then(|p|p.observed_at.clone())).unwrap_or_else(||now.into());
    value.last_gap=Some(EventGap{from:from.min(now.to_owned()),to:now.into(),code:value.code.clone().unwrap_or_else(||"unavailable".into()),count:(previous.and_then(|p|p.last_gap.as_ref()).map_or(0,|g|g.count).saturating_add(usize::from(!same))).max(1).min(SAFE_INTEGER as usize)}); value
}
pub fn execution_events(read:&HermesRead,jobs:&[ScheduledJob],now:&str)->Result<Vec<LocalEvent>> {
    if read.rows.len()>40 {return Err(Error::limit("Hermes event rows",40,read.rows.len()));}
    let cutoff=millis(now)?-EVENT_RETENTION_MS;
    let mut events=vec![];
    for row in &read.rows {
        let entity=format!("hermes-job:{}",row.job_id);
        let at=row.finished_at.as_ref().map(|at|chrono::DateTime::parse_from_rfc3339(at).map(|at|at.to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis,true))).transpose().map_err(|_|Error::invalid("execution finish time"))?;
        if let Some(at)=&at {if millis(at)?<cutoff {continue;}}
        for (kind,failed) in [(LocalEventType::ExecutionFailed,row.status=="failed" && row.baseline_status.as_deref()!=Some("failed")),(LocalEventType::DeliveryFailed,row.delivery.as_deref()==Some("failed") && row.baseline_delivery.as_deref()!=Some("failed"))] {
            if !failed {continue;}
            events.push(LocalEvent{id:format!("h:{}:{}:{}",&digest(&read.cursor.identity)[..16],row.rowid,&event_id(&[&row.id,kind.as_str()])[..32]),source_id:"hermes-events".into(),entity_id:entity.clone(),event_type:kind,occurred_at:if kind==LocalEventType::ExecutionFailed {at.clone()}else{None},observed_at:now.into(),result_code:if kind==LocalEventType::ExecutionFailed {"failed"}else{"delivery-failed"}.into(),target:jobs.iter().find(|j|j.id==entity).map(NavigationTarget::schedule)});
        }
    }
    Ok(events)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn at(s:i64)->String {chrono::DateTime::from_timestamp(1_800_000_000+s,0).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}
    fn sample(s:i64,state:SourceState)->Observation {Observation{id:"source".into(),section:MonitorSection::Schedules,state,observed_at:at(s)}}
    #[test] fn sustained_outage_partial_and_recovery() { let a=observe(&[],&[sample(0,SourceState::Error)],&at(0)).unwrap(); let b=observe(&a.sources,&[sample(60,SourceState::Error)],&at(60)).unwrap(); assert_eq!(b.events.len(),1); let c=observe(&b.sources,&[sample(61,SourceState::Partial)],&at(61)).unwrap(); assert!(c.events.is_empty()); assert!(c.sources[0].announced); let d=observe(&c.sources,&[sample(62,SourceState::Ok)],&at(62)).unwrap(); assert_eq!(d.events[0].event_type,LocalEventType::SourceRecovered); assert!(observe(&d.sources,&[sample(63,SourceState::Ok)],&at(63)).unwrap().events.is_empty()); }
    #[test] fn sleep_unknown_disable_and_stale_do_not_invent_failure() { let a=observe(&[],&[sample(0,SourceState::Error)],&at(0)).unwrap(); assert!(observe(&a.sources,&[sample(0,SourceState::Error)],&at(90)).unwrap().events.is_empty()); let b=observe(&a.sources,&[sample(300,SourceState::Error)],&at(300)).unwrap(); assert!(b.gap); assert!(b.events.is_empty()); for state in [SourceState::Partial,SourceState::Disabled,SourceState::Unsupported] {assert!(observe(&a.sources,&[sample(60,state)],&at(60)).unwrap().events.is_empty());} }
    #[test] fn burst_defers_without_losing_cursor() { let samples:Vec<_>=(0..64).map(|i|Observation{id:format!("s{i}"),..sample(0,SourceState::Error)}).collect(); let a=observe(&[],&samples,&at(0)).unwrap(); let samples:Vec<_>=samples.into_iter().map(|s|Observation{observed_at:at(60),..s}).collect(); let mut sources=a.sources; let mut total=0; for _ in 0..4 {let next=observe(&sources,&samples,&at(60)).unwrap(); total+=next.events.len();sources=next.sources;} assert_eq!(total,64); assert!(observe(&sources,&samples,&at(60)).unwrap().events.is_empty()); }
}
