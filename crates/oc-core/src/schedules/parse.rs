use std::{path::{Component, Path, PathBuf}, sync::LazyLock};
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use crate::{error::{Error, Result, validate_text}, model::*};

pub(super) const FIELD_BYTES: usize = 4096;
pub(super) const PROJECTION_BYTES: usize = 64 * 1024;
pub(super) const MAX_JOBS: usize = 4096;
pub(super) const JOB_BYTES: usize = 8 * 1024 * 1024;
pub(super) const FILE_BYTES: usize = 1024 * 1024;
static CRON_PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:\*|\d+(?:-\d+)?)(?:/[1-9]\d*)?$").expect("cron regex"));
static CRON_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[a-z]+").expect("cron names"));
static ENVIRONMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z_0-9]*\s*=").expect("cron environment"));
static TIMEZONE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^CRON_TZ\s*=\s*["']?([A-Za-z0-9_+\-/]+)["']?\s*$"#).expect("cron timezone"));
static INTERPRETER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:python(?:\d+(?:\.\d+)*)?|node|bun|ruby|perl|(?:ba|z|k|fi)?sh|osascript)$").expect("interpreter names"));
static PYTHON_FLAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-[bBEiIOqRsSuvx]+$").expect("python flags"));

pub(super) fn bounded_text(value: Option<&Value>) -> Result<Option<String>> {
    match value.and_then(Value::as_str).filter(|value| !value.is_empty()) {
        None => Ok(None), Some(text) => { if text.len()>FIELD_BYTES { return Err(Error::limit("metadata field bytes",FIELD_BYTES,text.len())); } Ok(Some(text.to_owned())) }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) struct MetadataJob {
    pub id: String,
    pub name: Option<String>, pub label: Option<String>,
    pub enabled: Option<bool>, pub state: Option<String>,
    pub schedule: Option<MetadataSchedule>, pub calendar: Option<Value>,
    pub next_run_at: Option<String>, pub not_before: Option<String>,
    #[serde(default)] pub fire_claim: Claim,
    pub last_run_at: Option<String>, pub last_status: Option<String>,
}
// Only these fields are deserialized. Unknown fields, including prompt/command/body, are skipped.
#[derive(Clone, Debug, Deserialize)]
pub(super) struct MetadataSchedule { pub kind: Option<String>, pub expr: Option<String>, pub minutes: Option<f64>, pub run_at: Option<String> }
#[derive(Clone, Debug, Default)]
pub(super) enum Claim { #[default] Absent, Present(Option<String>) }
impl<'de> Deserialize<'de> for Claim {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self,D::Error> {
        #[derive(Deserialize)] struct At { at: Option<String> }
        #[derive(Deserialize)] #[serde(untagged)] enum Input { Object(At), Other(serde::de::IgnoredAny) }
        // Null means no fire claim. Malformed non-null ownership remains unconfirmed.
        let value = Option::<Input>::deserialize(deserializer)?;
        Ok(match value { None => Self::Absent, Some(Input::Object(at)) => Self::Present(at.at.filter(|value| !value.is_empty())), Some(Input::Other(_)) => Self::Present(None) })
    }
}
#[derive(Deserialize)] struct MetadataDocument { jobs: Vec<MetadataJob> }
pub(super) fn parse_metadata(bytes: &[u8]) -> Result<Vec<MetadataJob>> {
    if bytes.len()>FILE_BYTES { return Err(Error::limit("schedule metadata bytes",FILE_BYTES,bytes.len())); }
    let document: MetadataDocument=serde_json::from_slice(bytes).map_err(|_| Error::invalid("schedule metadata jobs"))?;
    if document.jobs.len()>MAX_JOBS { return Err(Error::limit("metadata jobs",MAX_JOBS,document.jobs.len())); }
    for job in &document.jobs {
        validate_text(&job.id,MAX_HERMES_JOB_ID_LENGTH,FIELD_BYTES,"metadata job ID")?;
        for value in [job.name.as_deref(),job.label.as_deref(),job.state.as_deref(),job.next_run_at.as_deref(),job.not_before.as_deref(),job.last_run_at.as_deref(),job.last_status.as_deref()] {
            if let Some(value)=value { if value.len()>FIELD_BYTES { return Err(Error::limit("metadata field bytes",FIELD_BYTES,value.len())); } }
        }
        if let Claim::Present(Some(at))=&job.fire_claim { if at.len()>FIELD_BYTES { return Err(Error::limit("claim bytes",FIELD_BYTES,at.len())); } }
        metadata_schedule(job)?;
    }
    Ok(document.jobs)
}
pub(super) fn metadata_schedule(job: &MetadataJob) -> Result<(JobKind,String)> {
    if let Some(schedule)=&job.schedule {
        match schedule.kind.as_deref() {
            Some("interval") if schedule.minutes.is_some_and(|value| value.is_finite() && value>0.0) => return Ok((JobKind::Interval,format!("每 {} 分钟",schedule.minutes.unwrap()))),
            Some("once") => if let Some(at)=schedule.run_at.as_deref().filter(|value| !value.is_empty()) { check_field(at)?; return Ok((JobKind::Calendar,format!("单次：{at}"))); },
            Some("cron") => if let Some(expression)=schedule.expr.as_deref().filter(|value| !value.is_empty()) { return Ok((JobKind::Calendar,describe_cron(expression)?)); },
            _ => (),
        }
    }
    if let Some(calendar)=&job.calendar { return Ok((JobKind::Calendar,format!("{}（系统本地时间）",describe_calendar(calendar)?.0))); }
    Err(Error::invalid("schedule format"))
}
fn check_field(value: &str) -> Result<()> { if value.len()>FIELD_BYTES { Err(Error::limit("schedule field bytes",FIELD_BYTES,value.len())) } else { Ok(()) } }
fn integer(value: &Value) -> Option<i64> { value.as_i64().or_else(|| value.as_f64().filter(|v| v.is_finite() && v.fract()==0.0 && v.abs()<=9_007_199_254_740_991.0).map(|v|v as i64)) }
pub fn describe_calendar(value: &Value) -> Result<(String,Vec<String>)> {
    let rows: Vec<&Value> = match value.as_array() { Some(rows)=>rows.iter().collect(),None=>vec![value] };
    if rows.is_empty() { return Err(Error::invalid("empty calendar")); }
    if rows.len()>64 { return Err(Error::limit("calendar conditions",64,rows.len())); }
    let weekdays=["周日","周一","周二","周三","周四","周五","周六","周日"];
    let mut descriptions=Vec::with_capacity(rows.len()); let mut warnings=Vec::new();
    for row in rows {
        let row=row.as_object().ok_or_else(||Error::invalid("calendar condition"))?;
        if row.len()>64 { return Err(Error::limit("calendar fields",64,row.len())); }
        let mut extensions=Vec::new();
        for (key,value) in row {
            if key.len()>128 { return Err(Error::limit("calendar field name",128,key.len())); }
            let bounds=match key.as_str() { "Month"=>Some((1,12)),"Day"=>Some((1,31)),"Weekday"=>Some((0,7)),"Hour"=>Some((0,23)),"Minute"=>Some((0,59)),_=>None };
            if let Some((low,high))=bounds {
                if !integer(value).is_some_and(|value| value>=low && value<=high) { return Err(Error::invalid("calendar field")); }
            } else {
                let extension=format!("{key}={}",integer(value).map(|value|value.to_string()).unwrap_or_else(||"未解析的非整数值".into()));
                warnings.push(format!("未确认日历扩展字段 {extension} 是否参与调度")); extensions.push(extension);
            }
        }
        let n=|key:&str|row.get(key).and_then(integer);
        let month=n("Month").map(|v|format!("{v}月")).unwrap_or_else(||"每月".into());
        let day=n("Day").map(|v|format!("{v}日")).unwrap_or_default();
        let weekday=n("Weekday").map(|v|weekdays[v as usize]).unwrap_or("");
        let date=if !day.is_empty()&&!weekday.is_empty(){format!("（{day}或{weekday}）")}else if !day.is_empty(){day}else if !weekday.is_empty(){weekday.into()}else{"每日".into()};
        let hour=n("Hour").map(|v|format!("{v:02}时")).unwrap_or_else(||"每小时".into());
        let minute=n("Minute").map(|v|format!("{v:02}分")).unwrap_or_else(||"每分钟".into());
        let extension=if extensions.is_empty(){String::new()}else{format!("；原始扩展字段 {}（是否生效未确认）",extensions.join("、"))};
        descriptions.push(format!("{month}{date} {hour}{minute}{extension}"));
    }
    let result=descriptions.join("；或 ");
    if result.len()>PROJECTION_BYTES { return Err(Error::limit("calendar projection",PROJECTION_BYTES,result.len())); }
    Ok((result,warnings))
}
pub fn describe_launch_schedule(plist: &Map<String,Value>) -> Result<(JobKind,String,Vec<String>)> {
    let mut schedules=Vec::new(); let mut warnings=Vec::new();
    if let Some(calendar)=plist.get("StartCalendarInterval") { let (description,notes)=describe_calendar(calendar)?; warnings=notes; schedules.push(format!("{description}（系统本地时间）")); }
    if let Some(interval)=plist.get("StartInterval") {
        let seconds=integer(interval).filter(|v|*v>0).ok_or_else(||Error::invalid("launchd interval"))?;
        schedules.push(format!("每 {seconds} 秒；休眠或上次仍运行时可能跳过"));
    }
    let run=plist.get("RunAtLoad")==Some(&Value::Bool(true));
    let keep=plist.get("KeepAlive").is_some_and(|v|v==&Value::Bool(true)||v.is_object());
    let (kind,schedule)=if !schedules.is_empty(){
        if run{schedules.push("加载时也运行".into());} if keep{schedules.push("另有 KeepAlive 保活条件".into());}
        (if plist.contains_key("StartCalendarInterval"){JobKind::Calendar}else{JobKind::Interval},schedules.join("；"))
    }else if keep{(JobKind::Service,"常驻 / 条件保活（非定时任务）".into())}else if run{(JobKind::Startup,"加载时运行（非定时任务）".into())}else{(JobKind::Service,"按需或事件触发（非定时任务）".into())};
    Ok((kind,schedule,warnings))
}
fn normalize(path: &Path) -> PathBuf {
    let mut result=PathBuf::new(); for component in path.components(){match component{Component::ParentDir=>{result.pop();},Component::CurDir=>(),other=>result.push(other.as_os_str())}} result
}
pub fn launch_origin(plist: &Map<String,Value>, file: &Path, home: &Path) -> JobOrigin {
    let label=plist.get("Label").and_then(Value::as_str).unwrap_or("");
    if file.starts_with("/System/Library")||label.starts_with("com.apple."){return JobOrigin::System;}
    if ["ai.hermes.cron-tick","ai.hermes.gateway"].contains(&label){return JobOrigin::Application;}
    if file.parent()==Some(home.join("Library/LaunchAgents").as_path())&&(label.starts_with("com.user.")||label.starts_with("local.")){return JobOrigin::Personal;}
    let args=plist.get("ProgramArguments").and_then(Value::as_array);
    let arg=|index:usize|args.and_then(|args|args.get(index)).and_then(Value::as_str);
    let program=plist.get("Program").and_then(Value::as_str).filter(|v|!v.is_empty()).or_else(||arg(0));
    let application=|value:&str|{let lower=value.to_ascii_lowercase(); lower.ends_with(".app")||lower.contains(".app/")||Path::new(value).starts_with("/Library")||Path::new(value).starts_with(home.join("Library"))};
    let name=program.and_then(|value|Path::new(value).file_name()).and_then(|v|v.to_str()).unwrap_or("");
    let interpreter=INTERPRETER.is_match(name); let mut index=1;
    if name.starts_with("python"){while arg(index).is_some_and(|v|PYTHON_FLAG.is_match(v)){index+=1;}}
    if interpreter&&arg(index)==Some("--"){index+=1;}
    if let Some(entry)=if interpreter{arg(index)}else{program}{
        let script=normalize(Path::new(entry)); let text=script.to_string_lossy();
        if script.is_absolute()&&script.starts_with(home)&&script!=home&&!application(&text)&&!text.contains("/node_modules/")&&script.extension().and_then(|v|v.to_str()).is_some_and(|v|["sh","py","js","mjs","cjs","ts","command","scpt"].contains(&v)){return JobOrigin::Personal;}
    }
    if plist.get("BundleProgram").and_then(Value::as_str).is_some_and(|v|!v.is_empty())||program.is_some_and(application)||(program==Some("/usr/bin/open")&&args.is_some_and(|args|args.iter().filter_map(Value::as_str).any(application))){return JobOrigin::Application;}
    JobOrigin::Unknown
}
pub(super) fn launch_job(raw: Value, file: &Path, home: &Path, scope: JobScope) -> Result<Option<(ScheduledJob,bool,Vec<String>)>> {
    let plist=raw.as_object().ok_or_else(||Error::invalid("plist dictionary"))?;
    let label=bounded_text(plist.get("Label"))?;
    let Some(label)=label else {
        let keys=["Label","Program","ProgramArguments","BundleProgram","StartCalendarInterval","StartInterval","RunAtLoad","KeepAlive","MachServices","Sockets","LaunchEvents","WatchPaths","QueueDirectories","StartOnMount","Disabled","UserName","GroupName","EnvironmentVariables"];
        if keys.iter().any(|key|plist.contains_key(*key)){return Err(Error::invalid("launchd Label"));} return Ok(None);
    };
    validate_text(&label,MAX_SCHEDULE_ID_LENGTH-"launchd:system:".len(),FIELD_BYTES,"launchd label")?;
    let (kind,schedule,warnings)=describe_launch_schedule(plist)?;
    let scheduler=["ai.hermes.cron-tick","ai.hermes.gateway"].contains(&label.as_str());
    let program=bounded_text(plist.get("Program"))?.or(bounded_text(plist.get("ProgramArguments").and_then(Value::as_array).and_then(|args|args.first()))?);
    let job=ScheduledJob{id:format!("launchd:{}:{label}",if scope==JobScope::System{"system"}else{"user"}),name:if scheduler{format!("{label}（调度器 / 服务）")}else{label},source:if scheduler{"launchd · Hermes 调度器"}else{"launchd"}.into(),scope,origin:launch_origin(plist,file,home),kind,schedule,state:JobState::Unknown,state_reason:None,last_run:None,pid:None,last_exit_code:None,file:Some(file.to_string_lossy().into_owned()),executable:program.as_deref().and_then(|p|Path::new(p).file_name()).map(|p|p.to_string_lossy().into_owned()),next_run:None};
    job_bytes(&job)?;
    Ok(Some((job,plist.get("Disabled")==Some(&Value::Bool(true)),warnings)))
}
pub fn describe_cron(expression: &str) -> Result<String> {
    check_field(expression)?; let fields:Vec<_>=expression.split_whitespace().collect();
    if fields.len()!=5{return Err(Error::invalid("five-field cron"));}
    let bounds=[(0,59),(0,23),(1,31),(1,12),(0,7)];
    let months=["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    let weekdays=["sun","mon","tue","wed","thu","fri","sat"];
    for (index,field) in fields.iter().enumerate(){
        let names:&[&str]=if index==3{&months}else if index==4{&weekdays}else{&[]};
        let lower=field.to_ascii_lowercase();
        let numeric=CRON_NAME.replace_all(&lower,|captures:&regex::Captures<'_>|names.iter().position(|name|*name==&captures[0]).map(|position|(position+usize::from(index==3)).to_string()).unwrap_or_else(||"invalid".into()));
        for part in numeric.split(','){
            if !CRON_PART.is_match(part){return Err(Error::invalid("cron field"));}
            let range=part.split('/').next().unwrap();
            if range!="*"{for value in range.split('-'){let number=value.parse::<u32>().map_err(|_|Error::invalid("cron range"))?; if number<bounds[index].0||number>bounds[index].1{return Err(Error::invalid("cron range"));}}}
        }
    }
    Ok(format!("分 {} · 时 {} · 日 {} · 月 {} · 周 {}（* 为任意；日与周均受限时满足其一）",fields[0],fields[1],fields[2],fields[3],fields[4]))
}
pub fn parse_crontab(output: &str) -> Result<(Vec<ScheduledJob>,usize)> {
    let mut jobs=Vec::new(); let mut invalid=0; let mut timezone="系统本地时间".to_owned();
    for (index,original) in output.split_inclusive('\n').enumerate(){
        check_field(original)?; let line=original.trim(); if line.is_empty()||line.starts_with('#'){continue;}
        if ENVIRONMENT.is_match(line){if let Some(capture)=TIMEZONE.captures(line){timezone=format!("CRON_TZ={}（是否支持由本机 cron 决定）",&capture[1]);}continue;}
        let words:Vec<_>=line.split_whitespace().take(6).collect(); let Some(first)=words.first()else{continue;};
        let macro_schedule=match *first{"@yearly"|"@annually"=>Some("每年 1 月 1 日 00:00"),"@monthly"=>Some("每月 1 日 00:00"),"@weekly"=>Some("每周日 00:00"),"@daily"|"@midnight"=>Some("每日 00:00"),"@hourly"=>Some("每小时 00 分"),"@reboot"=>Some("cron 守护进程启动时运行（非定时任务）"),_=>None};
        let schedule=if first.starts_with('@'){if words.len()<2||macro_schedule.is_none(){invalid+=1;continue;}macro_schedule.unwrap().to_owned()}else{if words.len()<6{invalid+=1;continue;}match describe_cron(&words[..5].join(" ")){Ok(value)=>value,Err(_)=>{invalid+=1;continue;}}};
        let hash=Sha256::digest(format!("{index}:{line}").as_bytes()); let id=hash[..8].iter().map(|byte|format!("{byte:02x}")).collect::<String>();
        jobs.push(ScheduledJob{id:format!("crontab:{id}"),name:format!("crontab 第 {} 行",index+1),source:"crontab · 当前用户".into(),scope:JobScope::User,origin:JobOrigin::Personal,kind:if *first=="@reboot"{JobKind::Startup}else{JobKind::Calendar},schedule:format!("{schedule}（{timezone}）"),state:JobState::Unknown,state_reason:None,last_run:None,pid:None,last_exit_code:None,file:None,executable:None,next_run:None});
        if jobs.len()>MAX_JOBS{return Err(Error::limit("crontab jobs",MAX_JOBS,jobs.len()));}
    }
    check_jobs(&jobs)?; Ok((jobs,invalid))
}
pub(super) fn job_bytes(job: &ScheduledJob) -> Result<usize> {
    validate_text(&job.id,MAX_SCHEDULE_ID_LENGTH,FIELD_BYTES,"schedule job ID")?;
    for value in [&job.name,&job.source] {check_field(value)?;}
    for value in [&job.file,&job.executable,&job.next_run].into_iter().flatten(){check_field(value)?;}
    if job.schedule.len()>PROJECTION_BYTES{return Err(Error::limit("job schedule bytes",PROJECTION_BYTES,job.schedule.len()));}
    Ok(serde_json::to_vec(job).map_err(|_|Error::invalid("schedule projection"))?.len()+128)
}
pub(super) fn check_jobs(jobs: &[ScheduledJob]) -> Result<()> {
    if jobs.len()>MAX_JOBS{return Err(Error::limit("schedule jobs",MAX_JOBS,jobs.len()));}
    let mut bytes=0; for job in jobs{bytes+=job_bytes(job)?;if bytes>JOB_BYTES{return Err(Error::limit("schedule projection bytes",JOB_BYTES,bytes));}} Ok(())
}
pub(super) fn merge_omp(jobs: &mut Vec<ScheduledJob>,metadata: &[MetadataJob],file: &Path) -> Result<()> {
    check_jobs(jobs)?;
    let mut bytes=jobs.iter().try_fold(0usize,|sum,job|job_bytes(job).map(|bytes|sum+bytes))?;
    let mut indexed:std::collections::BTreeMap<String,usize>=jobs.iter().enumerate().filter(|(_,job)|job.scope==JobScope::User).map(|(index,job)|(job.id.clone(),index)).collect();
    for item in metadata{
        let label=item.label.as_deref().filter(|v|!v.is_empty()).map(str::to_owned).unwrap_or_else(||format!("com.user.omp-cron.{}",item.id));
        let id=format!("launchd:user:{label}");
        if let Some(index)=indexed.get(&id).copied(){
            let job=&mut jobs[index];
            bytes-=job_bytes(job)?;
            if let Some(name)=item.name.as_ref().filter(|v|!v.is_empty()){job.name=name.clone();}
            job.source="launchd · OMP 任务".into();job.origin=JobOrigin::Personal;
            if job.file.is_none(){(job.kind,job.schedule)=metadata_schedule(item)?;}
            if item.enabled==Some(false)&&job.state!=JobState::Running{job.state=JobState::Disabled;}
            if let Some(at)=item.not_before.as_ref().filter(|v|!v.is_empty()){job.schedule.push_str(&format!("；首次执行不早于 {at}"));}
            bytes+=job_bytes(job)?;
        }else{
            let (kind,mut schedule)=metadata_schedule(item)?;
            if let Some(at)=item.not_before.as_ref().filter(|v|!v.is_empty()){schedule.push_str(&format!("；首次执行不早于 {at}"));}
            if jobs.len()>=MAX_JOBS{return Err(Error::limit("schedule jobs",MAX_JOBS,jobs.len()+1));}
            indexed.insert(id.clone(),jobs.len());
            jobs.push(ScheduledJob{id,name:item.name.as_ref().filter(|v|!v.is_empty()).cloned().unwrap_or(label),source:"OMP 任务 · 未发现 launchd 配置".into(),scope:JobScope::User,origin:JobOrigin::Personal,kind,schedule,state:if item.enabled==Some(false){JobState::Disabled}else{JobState::Unloaded},state_reason:None,last_run:None,pid:None,last_exit_code:None,file:Some(file.to_string_lossy().into_owned()),executable:None,next_run:None});
            bytes+=job_bytes(jobs.last().expect("inserted job"))?;
        }
        if bytes>JOB_BYTES{return Err(Error::limit("schedule projection bytes",JOB_BYTES,bytes));}
    } Ok(())
}
