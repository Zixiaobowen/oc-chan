use std::{collections::{BTreeMap,BTreeSet},path::Path,sync::LazyLock,time::Duration};
use chrono::{DateTime,NaiveDateTime,SecondsFormat,Utc};
use regex::Regex;
use serde::Deserialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use crate::{error::{Error,Result,check_cancel,validate_text},io::{BoundedIo,CommandSpec},model::*,worker::DataWorker};
use super::parse::{Claim,MetadataJob};
const CLAIM_TTL_MS:i64=300_000;
static PROCESS_ROW:LazyLock<Regex>=LazyLock::new(||Regex::new(r"^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)\s*$").expect("process row"));
#[derive(Clone,Debug,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Execution{ id:String,job_id:String,status:String,pid:u32,process_started_at:Option<i64>,claimed_at:String,finished_at:Option<String> }
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Response{entries:Vec<Execution>}
#[derive(Default)]
struct Runtime{latest:BTreeMap<String,Execution>,processes:BTreeMap<u32,i64>}
#[derive(Clone,Debug)]
pub(super) struct Status{pub state:JobState,pub reason:Option<JobStateReason>,pub pid:Option<u32>,pub last_run:Option<LastRun>}
pub(super) fn time(value:&str)->Option<DateTime<Utc>>{
    if value.len()>64{return None;}DateTime::parse_from_rfc3339(value).ok().map(|v|v.with_timezone(&Utc))
}
fn iso(value:DateTime<Utc>)->String{value.to_rfc3339_opts(SecondsFormat::Millis,true)}
fn last_run(job:&MetadataJob,now:DateTime<Utc>)->Option<LastRun>{
    if job.last_run_at.as_deref().is_none_or(str::is_empty)&&job.last_status.as_deref().is_none_or(str::is_empty){return None;}
    let result=match job.last_status.as_deref(){Some("ok")=>RunResult::Succeeded,Some("error")=>RunResult::Failed,Some("delivery_failed")=>RunResult::DeliveryFailed,Some("blocked_config")=>RunResult::Blocked,_=>RunResult::Unknown};
    Some(LastRun{result,at:job.last_run_at.as_deref().and_then(time).filter(|at|*at<=now).map(iso)})
}
fn status(job:&MetadataJob,runtime:Option<&Runtime>,now:DateTime<Utc>)->Status{
    let mut result=Status{state:JobState::Unknown,reason:None,pid:None,last_run:last_run(job,now)};
    let disabled=job.enabled==Some(false)||matches!(job.state.as_deref(),Some("paused"|"completed"));
    let has_claim=matches!(&job.fire_claim,Claim::Present(_));
    let Some(runtime)=runtime else{if disabled&&!has_claim{result.state=JobState::Disabled;}else{result.reason=Some(JobStateReason::HermesReadFailed);}return result;};
    let execution=runtime.latest.get(&job.id);
    if let Some(execution)=execution.filter(|execution|matches!(execution.status.as_str(),"completed"|"failed"|"unknown")){
        let metadata_at=result.last_run.as_ref().and_then(|run|run.at.as_deref()).and_then(time);
        let claimed=time(&execution.claimed_at);
        if !metadata_at.zip(claimed).is_some_and(|(metadata,claimed)|metadata>=claimed){
            result.last_run=Some(LastRun{result:match execution.status.as_str(){"completed"=>RunResult::Succeeded,"failed"=>RunResult::Failed,_=>RunResult::Unknown},at:execution.finished_at.as_deref().and_then(time).filter(|at|*at<=now).map(iso)});
        }
    }
    let in_flight=execution.is_some_and(|execution|matches!(execution.status.as_str(),"claimed"|"running"));
    let claimed=match &job.fire_claim{Claim::Present(Some(value))=>time(value),_=>None};
    let fresh=claimed.is_some_and(|at|{let delta=now.signed_duration_since(at).num_milliseconds();(0..CLAIM_TTL_MS).contains(&delta)});
    if let Some(execution)=execution.filter(|execution|execution.status=="running"&&fresh&&time(&execution.claimed_at).is_some_and(|at|at<=now)){
        if let Some((actual,expected))=runtime.processes.get(&execution.pid).zip(execution.process_started_at){
            if ((*actual as i128)*100-(expected as i128)).abs()<=200{result.state=JobState::Running;result.pid=Some(execution.pid);return result;}
        }
    }
    if in_flight||has_claim{result.reason=Some(if execution.is_some_and(|e|e.status=="claimed")&&fresh{JobStateReason::HermesDispatching}else{JobStateReason::HermesUnconfirmed});}
    else if disabled{result.state=JobState::Disabled;}
    else if job.enabled==Some(true)&&job.state.as_deref()==Some("scheduled"){result.state=JobState::Waiting;}
    else{result.reason=Some(JobStateReason::HermesStateUnsupported);}
    result
}
fn parse_processes(output:&str,allowed:&BTreeSet<u32>)->Result<BTreeMap<u32,i64>>{
    let mut processes=BTreeMap::new();let mut seen=BTreeSet::new();
    for line in output.lines().filter(|line|!line.trim().is_empty()){
        let row=PROCESS_ROW.captures(line).ok_or_else(||Error::invalid("Hermes process start time"))?;
        let pid=row[1].parse::<u32>().map_err(|_|Error::invalid("Hermes process PID"))?;
        if !allowed.contains(&pid)||!seen.insert(pid){return Err(Error::invalid("Hermes process selection"));}
        let value=row[2].split_whitespace().collect::<Vec<_>>().join(" ");
        let birth=NaiveDateTime::parse_from_str(&value,"%a %b %e %H:%M:%S %Y").map_err(|_|Error::invalid("Hermes process birth"))?.and_utc().timestamp();
        if !row[3].contains('Z'){processes.insert(pid,birth);}
    }Ok(processes)
}
async fn read_runtime(io:&BoundedIo,worker:&DataWorker,jobs:&[MetadataJob],database:&Path,cancel:&CancellationToken)->Result<Runtime>{
    let ids:BTreeSet<_>=jobs.iter().map(|job|job.id.clone()).collect();
    if ids.len()>256{return Err(Error::limit("Hermes jobs",256,ids.len()));}
    let response=worker.request("hermes-runtime",database,json!({"jobIds":ids}),cancel).await?;
    let response:Response=serde_json::from_value(response).map_err(|_|Error::invalid("Hermes runtime response"))?;
    if response.entries.len()>ids.len(){return Err(Error::invalid("Hermes runtime response count"));}
    let mut runtime=Runtime::default();
    for entry in response.entries{
        validate_text(&entry.id,128,512,"Hermes execution ID")?;
        if !ids.contains(&entry.job_id)||time(&entry.claimed_at).is_none()||!matches!(entry.status.as_str(),"claimed"|"running"|"completed"|"failed"|"unknown")||entry.pid==0||entry.pid>i32::MAX as u32||entry.process_started_at.is_some_and(|v|v<=0||v>9_007_199_254_740_991)||entry.finished_at.as_deref().is_some_and(|v|time(v).is_none()){
            return Err(Error::invalid("Hermes runtime evidence"));
        }
        if runtime.latest.insert(entry.job_id.clone(),entry).is_some(){return Err(Error::invalid("duplicate Hermes execution"));}
    }
    let pids:BTreeSet<_>=runtime.latest.values().filter(|entry|entry.status=="running").map(|entry|entry.pid).collect();
    if !pids.is_empty(){
        let joined=pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let mut command=CommandSpec::new("/bin/ps",["-p",&joined,"-o","pid=,lstart=,stat="],64*1024,Duration::from_secs(3));command.env.insert("TZ".into(),"UTC".into());
        let output=io.command("hermes-processes",command,cancel).await?;
        if !(output.exit_code==1&&output.stdout.iter().all(u8::is_ascii_whitespace)&&output.stderr.iter().all(u8::is_ascii_whitespace)){
            runtime.processes=parse_processes(output.success()?.stdout_text()?,&pids)?;
        }
    }
    Ok(runtime)
}
pub(super) async fn collect(io:&BoundedIo,worker:&DataWorker,jobs:&[MetadataJob],database:&Path,cancel:&CancellationToken)->Result<(BTreeMap<String,Status>,SourceStatus)>{
    let (runtime,failure)=match read_runtime(io,worker,jobs,database,cancel).await{
        Ok(runtime)=>(Some(runtime),None),Err(error)=>{if error.is_cancelled()||error.is_cleanup(){return Err(error);}(None,Some(format!("执行状态读取失败；无法确认当前运行状态 / Execution status unavailable ({})",error.code)))}
    };check_cancel(cancel)?;
    let now=Utc::now();let statuses:BTreeMap<_,_>=jobs.iter().map(|job|(job.id.clone(),status(job,runtime.as_ref(),now))).collect();
    let unknown=statuses.values().filter(|status|status.state==JobState::Unknown).count();
    let source=SourceStatus::new("hermes-runtime","Hermes 执行状态",if failure.is_some()||unknown>0{SourceState::Partial}else{SourceState::Ok},failure.unwrap_or_else(||format!("已核对 {} 条任务的执行记录与进程出生身份；{unknown} 条当前状态未确认。每个任务只返回最新执行记录；不读取执行正文。",statuses.len())));
    Ok((statuses,source))
}

#[cfg(test)]
mod tests{
    use super::*;
    fn job()->MetadataJob{serde_json::from_value(json!({"id":"daily","enabled":true,"state":"scheduled"})).unwrap()}
    fn now()->DateTime<Utc>{time("2026-11-04T08:00:00Z").unwrap()}
    fn active()->Runtime{
        let birth=now().timestamp()-3600;
        Runtime{latest:BTreeMap::from([("daily".into(),Execution{id:"run".into(),job_id:"daily".into(),status:"running".into(),pid:42,process_started_at:Some(birth*100),claimed_at:"2026-11-04T07:50:00Z".into(),finished_at:None})]),processes:BTreeMap::from([(42,birth)])}
    }
    #[test]fn supported_idle_and_disabled_states_do_not_invent_results(){
        let mut job=job();let runtime=Runtime::default();assert_eq!(status(&job,Some(&runtime),now()).state,JobState::Waiting);
        job.state=Some("paused".into());assert_eq!(status(&job,None,now()).state,JobState::Disabled);assert!(status(&job,None,now()).last_run.is_none());
        job.state=Some("future-format".into());assert_eq!(status(&job,Some(&runtime),now()).reason,Some(JobStateReason::HermesStateUnsupported));
        assert_eq!(status(&job,None,now()).reason,Some(JobStateReason::HermesReadFailed));
    }
    #[test]fn fresh_claim_and_matching_birth_are_both_required_even_when_paused(){
        let mut job=job();job.fire_claim=Claim::Present(Some("2026-11-04T07:59:59Z".into()));job.state=Some("paused".into());let mut runtime=active();
        assert_eq!(status(&job,Some(&runtime),now()).state,JobState::Running);
        runtime.processes.insert(42,now().timestamp());assert_eq!(status(&job,Some(&runtime),now()).reason,Some(JobStateReason::HermesUnconfirmed));
        for at in ["2026-11-04T07:55:00Z","2026-11-04T08:00:01Z","malformed"]{job.fire_claim=Claim::Present(Some(at.into()));assert_eq!(status(&job,Some(&active()),now()).reason,Some(JobStateReason::HermesUnconfirmed));}
    }
    #[test]fn dispatch_and_terminal_results_remain_distinct(){
        let mut job=job();job.fire_claim=Claim::Present(Some("2026-11-04T07:59:59Z".into()));let mut runtime=active();runtime.latest.get_mut("daily").unwrap().status="claimed".into();
        assert_eq!(status(&job,Some(&runtime),now()).reason,Some(JobStateReason::HermesDispatching));
        job.fire_claim=Claim::Absent;job.last_run_at=Some("2026-11-04T07:51:00Z".into());job.last_status=Some("delivery_failed".into());runtime.latest.get_mut("daily").unwrap().status="completed".into();
        assert_eq!(status(&job,Some(&runtime),now()).last_run.unwrap().result,RunResult::DeliveryFailed);
        job.last_run_at=Some("2026-11-03T07:51:00Z".into());assert_eq!(status(&job,Some(&runtime),now()).last_run.unwrap().result,RunResult::Succeeded);
    }
    #[test]fn zombie_processes_cannot_confirm_ownership(){
        let allowed=BTreeSet::from([42,43]);let result=parse_processes("42 Wed Nov 4 07:00:00 2026 S\n43 Wed Nov 4 07:00:00 2026 Z\n",&allowed).unwrap();assert!(result.contains_key(&42));assert!(!result.contains_key(&43));
        assert!(parse_processes("44 Wed Nov 4 07:00:00 2026 S",&allowed).is_err());
    }
}
