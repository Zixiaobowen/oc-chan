use std::collections::BTreeSet;
use serde::{Serialize, Deserialize};
use serde_json::{json, Value, Map};
use crate::{error::{Error, Result, timestamp}, model::*, resources::{ResourceBudgetSnapshot, ResourceStatistics}};
pub const MAX_BYTES: usize = 256 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct CoverageCount { pub included: usize, pub total: Option<usize> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ReportCoverage { pub sources: CoverageCount, pub diagnostics: CoverageCount, pub resources: CoverageCount }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ReportContent { pub generated_at:String, pub bytes:usize, pub json:String, pub coverage:ReportCoverage, pub limits:Vec<String> }
pub struct ReportMetadata { pub version:String, pub tauri:String, pub platform:String, pub arch:String, pub os_release:String }
const SOURCES:&[&str]=&["processes","omp-ownership","codex-sessions","tern-state","omp-socket","agent-activity","omp-cron","hermes-cron","hermes-runtime","hermes-metadata-errors","crontab","schedule-semantics","system","system-0","system-1","system-2","system-3","network-interface","collection-resources","schedule-limits","event-store","hermes-events","source-events"];
const RESOURCES:&[&str]=&["agent-activity","agent-metadata","agent-processes","agent-ownership","agent-collab","agent-tern","schedule-files","schedule-plist","schedule-commands","schedule-metadata","hermes-processes","history","schedules","events","tern-navigation","diagnostic-export","plugin-host","plugin-market","http","app-updates","settings","desktop-startup","application-install","installation-readiness"];
struct Projection { limits:BTreeSet<String>, coverage:ReportCoverage, inspected_sources:usize, inspected_diagnostics:usize, remaining:usize }
impl Projection {
    fn invalid(&mut self)->Value { self.limits.insert("invalid-fields".into()); Value::Null }
    fn enumeration(&mut self,value:&str,allowed:&[&str])->Value { if allowed.contains(&value) { json!(value) } else { self.invalid() } }
    fn time(&mut self,value:Option<&str>)->Value {
        let Some(value)=value else {return Value::Null};
        if !matches!(value.len(),20|24) || !value.ends_with('Z') { return self.invalid(); }
        match chrono::DateTime::parse_from_rfc3339(value) {
            Ok(time) if time.to_rfc3339_opts(if value.len()==20 {chrono::SecondsFormat::Secs} else {chrono::SecondsFormat::Millis},true)==value => json!(value), _=>self.invalid()
        }
    }
    fn version(&mut self,value:&str)->Value {
        let parts:Vec<_>=value.split('.').take(4).collect();
        if value.len()<=32 && parts.len()==3 && parts.iter().all(|p| !p.is_empty() && p.len()<=9 && p.bytes().all(|b|b.is_ascii_digit())) {json!(value)} else {self.invalid()}
    }
    fn source(&mut self,value:&str)->String {
        if SOURCES.contains(&value) || value=="launchctl:system" {return value.into();}
        for domain in ["gui","user"] { if let Some(uid)=value.strip_prefix(&format!("launchctl:{domain}/")) {if !uid.is_empty() && uid.len()<=10 && uid.bytes().all(|b|b.is_ascii_digit()) {return format!("launchctl:{domain}");}} }
        if matches!(value,"launchagents:user"|"launchagents:local"|"launchagents:system"|"launchdaemons:local"|"launchdaemons:system"){return value.into();}
        if let Some(hash)=value.strip_prefix("launchdirectory:"){if hash.len()==64 && hash.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return "launchdirectory:custom".into();}}
        self.invalid(); "unknown".into()
    }
    fn admit(&mut self,value:&Value)->bool {
        let bytes=value.to_string().len()+1;
        if bytes>self.remaining {self.limits.insert("bytes".into());false} else {self.remaining-=bytes;true}
    }
    fn sources(&mut self,sources:Option<&[SourceStatus]>)->Vec<Value> {
        let Some(sources)=sources else {self.coverage.sources.total=None;self.coverage.diagnostics.total=None;return Vec::new()};
        if let Some(total)=&mut self.coverage.sources.total {*total+=sources.len();}
        let take=sources.len().min(64-self.inspected_sources);
        if take<sources.len(){self.limits.insert("sources".into());self.coverage.diagnostics.total=None;}
        let mut result=Vec::with_capacity(take);
        for source in sources.iter().take(take) {
            self.inspected_sources+=1;
            let id=self.source(&source.id);
            let mut item=json!({"id":id,"state":source.state,"lastAttemptAt":self.time(source.last_attempt_at.as_deref()),"lastSuccessAt":self.time(source.last_success_at.as_deref()),"capabilities":capabilities(&id),"diagnostics":[]});
            let diagnostics=source.diagnostics.as_deref().unwrap_or(&[]);
            if let Some(total)=&mut self.coverage.diagnostics.total {*total+=diagnostics.len();}
            let count=diagnostics.len().min(128-self.inspected_diagnostics);
            if count<diagnostics.len(){self.limits.insert("diagnostics".into());}
            if !self.admit(&item){continue;}
            let mut safe=Vec::with_capacity(count);
            for diagnostic in diagnostics.iter().take(count) {
                self.inspected_diagnostics+=1;
                let record=json!({"sourceId":self.source(&diagnostic.source_id),"operation":diagnostic.operation,"stage":diagnostic.stage,"code":diagnostic.code,"retryable":diagnostic.retryable,"observedAt":self.time(Some(&diagnostic.observed_at)),"exitCode":diagnostic.exit_code});
                if self.admit(&record){safe.push(record);self.coverage.diagnostics.included+=1;}
            }
            item["diagnostics"]=json!(safe);result.push(item);self.coverage.sources.included+=1;
        } result
    }
    fn section<T>(&mut self,state:&CollectorState<T>,collected:Option<&str>,sources:Option<&[SourceStatus]>,totals:Value)->Value {
        json!({"dataAvailable":state.data.is_some(),"hasError":state.error.is_some(),"refreshing":state.refreshing,"lastAttemptAt":self.time(state.last_attempt_at.as_deref()),"lastSuccessAt":self.time(state.last_success_at.as_deref()),"collectedAt":self.time(collected),"totals":totals,"sources":self.sources(sources)})
    }
    fn numeric(&mut self,value:Value)->Value {
        match value { Value::Object(fields)=>Value::Object(fields.into_iter().map(|(key,value)|(key,self.numeric(value))).collect()), Value::Number(number) if number.as_f64().is_some_and(|n| n.is_finite() && n>=0.0 && n<=9_007_199_254_740_991.0)=>Value::Number(number), _=>self.invalid() }
    }
    fn statistics(&mut self,value:&ResourceStatistics)->Result<Value> { Ok(self.numeric(serde_json::to_value(value).map_err(|_|Error::invalid("resource statistics"))?)) }
}
fn capabilities(id:&str)->Vec<Value>{
    let mut support=["unsupported";7]; support[6]="partial";
    match id {
        "processes"=>{support[0]="supported";support[2]="partial";},
        "omp-ownership"|"codex-sessions"=>{support[0]="partial";support[2]="partial";},
        "tern-state"=>support[1]="partial",
        "omp-socket"=>{support[0]="partial";support[1]="partial";},
        "agent-activity"=>support[3]="partial",
        "omp-cron"=>support[1]="partial",
        "hermes-cron"=>{support[1]="partial";support[5]="supported";},
        "hermes-runtime"=>{support[0]="partial";support[1]="partial";support[5]="supported";},
        "system"|"system-3"=>support[0]="partial",
        "crontab"|"system-0"|"system-1"|"system-2"|"network-interface"=>{},
        id if id.starts_with("launchctl:")=>{support[0]="partial";support[1]="partial";},
        id if id.starts_with("launchagents:")||id.starts_with("launchdaemons:")||id=="launchdirectory:custom"=>support[1]="partial",
        _=>return Vec::new()
    }
    ["processes","working","relationships","activity","active-count","history","navigation"].iter().zip(support).map(|(id,support)|json!({"id":id,"support":support})).collect()
}
pub fn build_report(snapshot:&MonitorSnapshot,resources:&ResourceBudgetSnapshot,metadata:&ReportMetadata)->Result<ReportContent>{
    let generated_at=timestamp();
    let count=||CoverageCount{included:0,total:Some(0)};
    let mut p=Projection {limits:BTreeSet::new(),coverage:ReportCoverage{sources:count(),diagnostics:count(),resources:count()},inspected_sources:0,inspected_diagnostics:0,remaining:MAX_BYTES-16384};
    let a=snapshot.agents.data.as_ref();let s=snapshot.schedules.data.as_ref();let y=snapshot.system.data.as_ref();let e=snapshot.events.data.as_ref();
    let mut sections=Map::new();
    sections.insert("agents".into(),p.section(&snapshot.agents,a.map(|d|d.collected_at.as_str()),a.map(|d|d.sources.as_slice()),json!({"agents":a.map(|d|d.agents.len())})));
    sections.insert("schedules".into(),p.section(&snapshot.schedules,s.map(|d|d.collected_at.as_str()),s.map(|d|d.sources.as_slice()),json!({"jobs":s.map(|d|d.jobs.len())})));
    sections.insert("system".into(),p.section(&snapshot.system,y.map(|d|d.collected_at.as_str()),y.map(|d|d.sources.as_slice()),json!({"processes":y.map(|d|d.processes.len()),"memoryProcesses":y.map(|d|d.memory_processes.len()),"history":y.map(|d|d.history.len())})));
    sections.insert("events".into(),p.section(&snapshot.events,e.map(|d|d.collected_at.as_str()),e.map(|d|d.sources.as_slice()),json!({"events":e.map(|d|d.retention.count)})));
    p.coverage.resources.total=Some(resources.sources.len());if resources.sources.len()>32 {p.limits.insert("resources".into());}
    let mut resource_sources=Vec::new();
    for source in resources.sources.iter().take(32){
        let id=if RESOURCES.contains(&source.source.as_str()){source.source.as_str()}else{p.invalid();"unknown"};
        let mut safe=p.statistics(&source.statistics)?;safe["source"]=json!(id);
        if p.admit(&safe){resource_sources.push(safe);p.coverage.resources.included+=1;}
    }
    let metadata=json!({"version":p.version(&metadata.version),"tauri":p.version(&metadata.tauri),"platform":p.enumeration(&metadata.platform,&["darwin","linux","win32","aix","freebsd","openbsd","sunos","android"]),"arch":p.enumeration(&metadata.arch,&["arm","arm64","ia32","x64","loong64","mips","mipsel","ppc","ppc64","riscv64","s390","s390x"]),"osRelease":p.version(&metadata.os_release)});
    let resource_limits=p.numeric(serde_json::to_value(&resources.limits).map_err(|_|Error::invalid("resource limits"))?);let global=p.statistics(&resources.global)?;
    let limits:Vec<String>=p.limits.into_iter().collect();
    let report=json!({"schemaVersion":1,"generatedAt":generated_at,"scope":{"included":["application-version-and-platform","source-capability-status-and-controlled-diagnostics","resource-budget-counts","collection-times-and-array-totals"],"excluded":["usernames","paths","uids","titles","content","commands","environment","stderr","raw-errors"],"collection":"existing-in-memory-snapshot-only; no-network-or-additional-collection","coverage":"included counts emitted records; total is null when unavailable or not fully inspected","resources":"reserved-io-capacity-and-counters; not-heap-or-rss"},"metadata":metadata,"sections":sections,"resources":{"limits":resource_limits,"global":global,"sources":resource_sources},"coverage":p.coverage,"limits":limits});
    let json=report.to_string();if json.len()>MAX_BYTES{return Err(Error::new("OC_DIAGNOSTIC_LIMIT","诊断报告超过256KiB / Diagnostic report exceeds 256KiB"));}
    Ok(ReportContent{generated_at,bytes:json.len(),json,coverage:p.coverage,limits})
}
#[cfg(test)] mod tests {
    use super::*;use crate::resources::ResourceBudget;
    #[test] fn untrusted_metadata_and_source_text_never_leak(){
        let mut snapshot=MonitorSnapshot::default();snapshot.agents.error=Some("SECRET /Users/person/token".into());
        snapshot.agents.data=Some(AgentSnapshot{collected_at:"SECRET".into(),agents:Vec::new(),active_subagent_count:None,sources:vec![SourceStatus::new("launchagents:user","SECRET /Users/secret/Library/LaunchAgents",SourceState::Error,"SECRET")]});
        let metadata=ReportMetadata{version:"1.0.0".into(),tauri:"2.0.0".into(),platform:"darwin".into(),arch:"arm64".into(),os_release:"SECRET".into()};
        let mut resources=ResourceBudget::default().snapshot();
        resources.sources=vec![
            crate::resources::SourceStatistics{source:"history".into(),statistics:ResourceStatistics{admitted:3,completed:1,cancelled:2,..Default::default()}},
            crate::resources::SourceStatistics{source:"SECRET /Users/person/token".into(),statistics:Default::default()},
        ];
        let report=build_report(&snapshot,&resources,&metadata).unwrap();
        let projected:Value=serde_json::from_str(&report.json).unwrap();
        assert_eq!(projected["resources"]["sources"][0]["source"],"history");
        assert_eq!(projected["resources"]["sources"][0]["cancelled"],2);
        assert_eq!(projected["resources"]["sources"][1]["source"],"unknown");
        assert!(!report.json.contains("SECRET"));assert!(!report.json.contains("/Users/"));assert!(report.json.contains("launchagents:user"));assert!(report.bytes<=MAX_BYTES);
    }
    #[test]fn report_caps_records_globally_and_marks_incomplete_coverage(){
        let mut source=SourceStatus::new("processes","PRIVATE",SourceState::Partial,"PRIVATE");
        source.diagnostics=Some(vec![SourceDiagnostic{source_id:"processes".into(),operation:SourceDiagnosticOperation::Services,stage:SourceDiagnosticStage::Limit,code:SourceDiagnosticCode::EntryLimit,retryable:true,observed_at:"2026-11-10T00:00:00.000Z".into(),exit_code:None};3]);
        let mut snapshot=MonitorSnapshot::default();snapshot.agents.data=Some(AgentSnapshot{collected_at:"2026-11-10T00:00:00.000Z".into(),agents:Vec::new(),active_subagent_count:None,sources:vec![source;66]});
        let metadata=ReportMetadata{version:"1.0.0".into(),tauri:"2.0.0".into(),platform:"darwin".into(),arch:"arm64".into(),os_release:"27.2.0".into()};
        let mut resources=ResourceBudget::default().snapshot();resources.sources=vec![crate::resources::SourceStatistics{source:"PRIVATE".into(),statistics:Default::default()};34];
        let report=build_report(&snapshot,&resources,&metadata).unwrap();
        assert_eq!(report.coverage.sources.included,64);assert_eq!(report.coverage.diagnostics.included,128);assert_eq!(report.coverage.resources.included,32);assert_eq!(report.coverage.diagnostics.total,None);
        for limit in ["sources","diagnostics","resources","invalid-fields"]{assert!(report.limits.iter().any(|item|item==limit));}
        assert!(!report.json.contains("PRIVATE"));assert!(report.bytes<=MAX_BYTES);assert_eq!(report.bytes,report.json.len());
    }
}
