use std::{collections::BTreeMap,sync::LazyLock,time::Duration};
use regex::Regex;
use tokio_util::sync::CancellationToken;
use crate::{error::{Error,Result,check_cancel,timestamp,validate_text},io::{BoundedIo,CommandSpec},model::*};
const MAX_ENTRIES:usize=8192;
const MAX_OUTPUT:usize=8*1024*1024;
static SERVICES:LazyLock<Regex>=LazyLock::new(||Regex::new(r"(?m)^[ \t]*services = \{[ \t]*\r?\n([\s\S]*?)^[ \t]*\}").expect("services table"));
static DISABLED:LazyLock<Regex>=LazyLock::new(||Regex::new(r"(?m)^[ \t]*disabled services = \{[ \t]*\r?\n([\s\S]*?)^[ \t]*\}").expect("disabled table"));
static SERVICE_ROW:LazyLock<Regex>=LazyLock::new(||Regex::new(r"^\s*(\d+|-)\s+(-?\d+|-|\?|\([a-zA-Z]+\))\s+(.+?)\s*$").expect("service row"));
static DISABLED_ROW:LazyLock<Regex>=LazyLock::new(||Regex::new(r#"^\s*"([^"]+)"\s*=>\s*(true|false|enabled|disabled)\s*$"#).expect("disabled row"));
#[derive(Clone,Debug,PartialEq,Eq)]
pub struct LaunchRuntime{pub pid:Option<u32>,pub last_exit_code:Option<i32>}
#[derive(Clone,Debug)]
pub(super) struct LaunchDomain{pub services:BTreeMap<String,LaunchRuntime>,pub disabled:BTreeMap<String,bool>,pub loaded_known:bool,pub disabled_known:bool,pub source:SourceStatus}
fn parse_error(code:&str)->Error{Error::new(code,"launchctl 返回结构无效 / Invalid launchctl response structure")}
fn table<'a>(output:&'a str,pattern:&Regex)->Result<&'a str>{
    if output.len()>MAX_OUTPUT{return Err(parse_error("output-limit"));}
    pattern.captures(output).and_then(|captures|captures.get(1)).map(|v|v.as_str()).ok_or_else(||parse_error("missing-table"))
}
fn label(value:&str)->Result<()>{validate_text(value,1024,1024,"launchctl label").map_err(|_|parse_error("invalid-row"))}
pub fn parse_launch_services(output:&str)->Result<BTreeMap<String,LaunchRuntime>>{
    let mut services=BTreeMap::new();
    for line in table(output,&SERVICES)?.lines().filter(|line|!line.trim().is_empty()){
        if services.len()>=MAX_ENTRIES{return Err(parse_error("entry-limit"));}
        let row=SERVICE_ROW.captures(line).ok_or_else(||parse_error("invalid-row"))?;label(&row[3])?;
        let pid=if &row[1]=="-"{0}else{row[1].parse::<u32>().map_err(|_|parse_error("invalid-row"))?};
        if pid>i32::MAX as u32{return Err(parse_error("invalid-row"));}
        let exit=&row[2];
        let last_exit_code=if exit!="-"&&exit!="?"&&!exit.starts_with('('){Some(exit.parse::<i32>().map_err(|_|parse_error("invalid-row"))?)}else{None};
        if services.insert(row[3].to_owned(),LaunchRuntime{pid:if pid==0{None}else{Some(pid)},last_exit_code}).is_some(){return Err(parse_error("invalid-row"));}
    }Ok(services)
}
pub fn parse_launch_disabled(output:&str)->Result<BTreeMap<String,bool>>{
    let mut disabled=BTreeMap::new();
    for line in table(output,&DISABLED)?.lines().filter(|line|!line.trim().is_empty()){
        if disabled.len()>=MAX_ENTRIES{return Err(parse_error("entry-limit"));}
        let row=DISABLED_ROW.captures(line).ok_or_else(||parse_error("invalid-row"))?;label(&row[1])?;
        if disabled.insert(row[1].to_owned(),matches!(&row[2],"true"|"disabled")).is_some(){return Err(parse_error("invalid-row"));}
    }Ok(disabled)
}
pub fn launch_state(runtime:Option<&LaunchRuntime>,disabled:Option<bool>,plist_disabled:bool,loaded_known:bool,disabled_known:bool)->JobState{
    if loaded_known&&runtime.is_some_and(|runtime|runtime.pid.is_some()){return JobState::Running;}
    if disabled_known&&(disabled==Some(true)||(disabled.is_none()&&plist_disabled)){return JobState::Disabled;}
    if !loaded_known{return JobState::Unknown;}
    if runtime.is_some(){if disabled_known{JobState::Waiting}else{JobState::Unknown}}else{JobState::Unloaded}
}
#[derive(Debug)]
struct Failure{error:Error,exit:Option<i32>}
impl From<Error> for Failure{fn from(error:Error)->Self{Self{error,exit:None}}}
async fn command(io:&BoundedIo,operation:&str,domain:&str,cancel:&CancellationToken)->std::result::Result<String,Failure>{
    let output=io.command("schedule-commands",CommandSpec::new("/bin/launchctl",[operation,domain],MAX_OUTPUT,Duration::from_secs(6)),cancel).await?;
    if output.exit_code!=0{
        let stderr=String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        let permission=["permission denied","operation not permitted","not privileged"].iter().any(|pattern|stderr.contains(pattern));
        return Err(Failure{error:Error::new(if permission{"EACCES"}else{"OC_COMMAND_FAILED"},"launchctl 命令失败 / launchctl command failed"),exit:Some(output.exit_code)});
    }
    Ok(output.stdout_text()?.to_owned())
}
fn diagnose(failure:&Failure,source:&str,operation:SourceDiagnosticOperation,at:&str)->SourceDiagnostic{
    use SourceDiagnosticCode as Code;
    use SourceDiagnosticStage as Stage;
    let (stage,code)=match failure.error.code.as_str(){
        "missing-table"=>(Stage::Structure,Code::MissingTable),"invalid-row"=>(Stage::Row,Code::InvalidRow),
        "entry-limit"=>(Stage::Limit,Code::EntryLimit),"output-limit"|"OC_COLLECTION_LIMIT"=>(Stage::Limit,Code::OutputLimit),
        "OC_RESOURCE_LIMIT"=>(Stage::Limit,Code::ResourceLimit),"OC_RESOURCE_QUEUE_TIMEOUT"=>(Stage::Queue,Code::QueueTimeout),
        "EACCES"|"EPERM"=>(Stage::Permission,Code::PermissionDenied),"ETIMEDOUT"=>(Stage::Timeout,Code::TimedOut),"ENOENT"=>(Stage::Command,Code::CommandMissing),_=>(Stage::Command,Code::CommandFailed)};
    SourceDiagnostic{source_id:source.into(),operation,stage,code,retryable:matches!(code,Code::CommandFailed|Code::PermissionDenied|Code::TimedOut|Code::ResourceLimit|Code::QueueTimeout),observed_at:at.into(),exit_code:failure.exit}
}
fn message(code:SourceDiagnosticCode)->&'static str{
    use SourceDiagnosticCode::*;
    match code{
        CommandFailed=>"命令执行失败，检查该域是否仍存在后重试",
        PermissionDenied=>"系统拒绝访问该域；请核对当前登录用户及系统访问限制后重试",
        TimedOut=>"命令超过 6 秒，稍后重试",CommandMissing=>"launchctl 命令不存在，当前系统不支持此读取",
        OutputLimit=>"命令输出超过 8 MiB，未使用不完整结果",EntryLimit=>"条目超过 8192 项，未使用不完整结果",
        ResourceLimit=>"达到共享资源上限，稍后重试",QueueTimeout=>"等待共享资源超过 10 秒，稍后重试",
        MissingTable=>"未找到预期表结构，需要更新 launchctl 解析器",InvalidRow=>"表内存在无法识别的行，需要更新 launchctl 解析器"}}
pub(super) async fn read_domain(io:&BoundedIo,domain:&str,previous:Option<&LaunchDomain>,cancel:&CancellationToken)->Result<LaunchDomain>{
    // Join both operations, including cancellation cleanup; try_join would drop the sibling early.
    let (services,disabled)=tokio::join!(command(io,"print",domain,cancel),command(io,"print-disabled",domain,cancel));
    let services=services.and_then(|value|parse_launch_services(&value).map_err(Into::into));
    let disabled=disabled.and_then(|value|parse_launch_disabled(&value).map_err(Into::into));
    combine(domain,previous,services,disabled,cancel)
}
fn combine(domain:&str,previous:Option<&LaunchDomain>,services:std::result::Result<BTreeMap<String,LaunchRuntime>,Failure>,disabled:std::result::Result<BTreeMap<String,bool>,Failure>,cancel:&CancellationToken)->Result<LaunchDomain>{
    let fatal=services.as_ref().err().into_iter().chain(disabled.as_ref().err()).filter(|failure|failure.error.is_cleanup()||failure.error.is_cancelled()).map(|failure|failure.error.clone()).collect::<Vec<_>>();
    if !fatal.is_empty(){return Err(Error::aggregate(fatal));}check_cancel(cancel)?;
    let id=format!("launchctl:{domain}");let at=timestamp();let mut diagnostics=Vec::new();let mut details=Vec::new();
    for (operation,count,failure) in [(SourceDiagnosticOperation::Services,services.as_ref().ok().map(BTreeMap::len),services.as_ref().err()),(SourceDiagnosticOperation::Disabled,disabled.as_ref().ok().map(BTreeMap::len),disabled.as_ref().err())]{
        let name=match operation{SourceDiagnosticOperation::Services=>"已加载服务",SourceDiagnosticOperation::Disabled=>"禁用覆盖"};
        if let Some(count)=count{details.push(format!("{name}：{count} 项"));}
        if let Some(failure)=failure{let diagnostic=diagnose(failure,&id,operation,&at);details.push(format!("{name}：{}{}",message(diagnostic.code),if previous.is_some(){"（保留上次条目，本轮状态未知）"}else{""}));diagnostics.push(diagnostic);}
    }
    let mut source=SourceStatus::new(&id,format!("launchd 运行状态 · {domain}"),if diagnostics.is_empty(){SourceState::Ok}else{SourceState::Partial},details.join("；"));
    source.last_attempt_at=Some(at.clone());source.last_success_at=if diagnostics.is_empty(){Some(at)}else{previous.and_then(|value|value.source.last_success_at.clone())};
    source.retry=Some(SourceRetry::Source);source.diagnostics=Some(diagnostics);
    Ok(LaunchDomain{loaded_known:services.is_ok(),disabled_known:disabled.is_ok(),services:match services{Ok(value)=>value,Err(_)=>previous.map(|p|p.services.clone()).unwrap_or_default()},disabled:match disabled{Ok(value)=>value,Err(_)=>previous.map(|p|p.disabled.clone()).unwrap_or_default()},source})
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn parses_flags_without_inventing_exit_codes(){
        let rows=parse_launch_services("system = {\n services = {\n 42 (jt) local.running\n 17 ? local.unknown\n 0 78 local.failed\n - - local.waiting\n }\n environment = { SECRET=private }\n}").unwrap();
        assert_eq!(rows["local.running"].pid,Some(42));assert_eq!(rows["local.running"].last_exit_code,None);assert_eq!(rows["local.unknown"].pid,Some(17));assert_eq!(rows["local.failed"].last_exit_code,Some(78));
        assert!(parse_launch_services("services = {\n bad row\n}").is_err());assert!(parse_launch_services("services = {\n 1 - duplicate\n 2 - duplicate\n}").is_err());
        assert!(parse_launch_services("permission denied").is_err());
    }
    #[test]fn explicit_enable_overrides_plist_but_running_evidence_wins(){
        let run=LaunchRuntime{pid:Some(42),last_exit_code:None};let wait=LaunchRuntime{pid:None,last_exit_code:None};
        assert_eq!(launch_state(Some(&run),Some(true),true,true,true),JobState::Running);
        assert_eq!(launch_state(Some(&wait),Some(false),true,true,true),JobState::Waiting);
        assert_eq!(launch_state(None,None,true,true,true),JobState::Disabled);
        assert_eq!(launch_state(Some(&run),None,true,false,false),JobState::Unknown);
        assert_eq!(launch_state(Some(&wait),None,false,true,false),JobState::Unknown);
    }
    #[test]fn disabled_aliases_and_malformed_rows(){
        let rows=parse_launch_disabled("disabled services = {\n \"a\" => disabled\n \"b\" => enabled\n \"c\" => true\n \"d\" => false\n}").unwrap();
        assert!(rows["a"]&&rows["c"]&&!rows["b"]&&!rows["d"]);assert!(parse_launch_disabled("disabled services = {\n \"a\" => perhaps\n}").is_err());
    }
    #[test]fn failed_tables_retain_membership_but_never_stale_pid_or_disabled_evidence(){
        let token=CancellationToken::new();
        let previous=combine("gui/501",None,Ok(BTreeMap::from([("local.job".into(),LaunchRuntime{pid:Some(42),last_exit_code:None})])),Ok(BTreeMap::from([("local.job".into(),true)])),&token).unwrap();
        let reading=combine("gui/501",Some(&previous),Err(Error::new("EACCES","denied").into()),Ok(BTreeMap::new()),&token).unwrap();
        assert!(reading.services.contains_key("local.job"));assert!(!reading.loaded_known);assert!(reading.disabled_known);assert_eq!(reading.source.last_success_at,previous.source.last_success_at);
        assert_eq!(reading.source.diagnostics.as_ref().unwrap()[0].code,SourceDiagnosticCode::PermissionDenied);
        assert_eq!(launch_state(None,None,false,reading.loaded_known,reading.disabled_known),JobState::Unknown);
    }
}
