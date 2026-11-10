//! Read-only scheduling metadata. No job command or prompt is executed or published.
mod parse;
mod launchd;
mod runtime;
#[cfg(test)] mod tests;
pub use parse::{describe_calendar,describe_cron,describe_launch_schedule,launch_origin,parse_crontab};
pub use launchd::{LaunchRuntime,launch_state,parse_launch_disabled,parse_launch_services};

use std::{collections::{BTreeMap,BTreeSet},path::{Path,PathBuf},sync::Arc,time::Duration};
use chrono::{SecondsFormat,Utc};
use serde::Deserialize;
use serde_json::{Value,json};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use crate::{error::{Error,Result,check_cancel,timestamp,validate_text},io::{BoundedIo,CommandSpec,FileIdentity,InputFile},model::*,worker::DataWorker};
use parse::{MetadataJob,FILE_BYTES,FIELD_BYTES,MAX_JOBS,JOB_BYTES};
use launchd::LaunchDomain;

#[derive(Clone,Debug)]
pub struct SchedulePaths{
    pub home:PathBuf,
    pub directories:Vec<(PathBuf,JobScope)>,
    pub omp_metadata:PathBuf,
    pub hermes_metadata:PathBuf,
    pub hermes_database:PathBuf,
    pub uid:u32,
}
impl SchedulePaths{
    pub fn new(home:PathBuf)->Self{
        Self{directories:vec![(home.join("Library/LaunchAgents"),JobScope::User),(PathBuf::from("/Library/LaunchAgents"),JobScope::User),(PathBuf::from("/Library/LaunchDaemons"),JobScope::System),(PathBuf::from("/System/Library/LaunchAgents"),JobScope::User),(PathBuf::from("/System/Library/LaunchDaemons"),JobScope::System)],omp_metadata:home.join(".omp/cron/jobs.json"),hermes_metadata:home.join(".hermes/cron/jobs.json"),hermes_database:home.join(".hermes/cron/executions.db"),home,uid:unsafe{libc::getuid()}}
    }
    fn validate(&self)->Result<()>{
        if self.directories.len()>16{return Err(Error::limit("schedule directories",16,self.directories.len()));}
        for path in [&self.home,&self.omp_metadata,&self.hermes_metadata,&self.hermes_database].into_iter().chain(self.directories.iter().map(|(path,_)|path)){
            if !path.is_absolute()||path.to_str().is_none()||path.as_os_str().len()>FIELD_BYTES{return Err(Error::invalid("schedule source path"));}
        }
        let mut seen=BTreeSet::new();for (path,_) in &self.directories{if !seen.insert(path){return Err(Error::invalid("duplicate schedule directory"));}}
        Ok(())
    }
}
#[derive(Clone)]
struct Template{job:ScheduledJob,disabled:bool,warnings:Vec<String>}
#[derive(Clone)]
struct CachedPlist{identity:FileIdentity,template:Option<Template>,bytes:usize}
enum PlistRead{CacheHit,Converted(CachedPlist)}
#[derive(Default)]
struct PlistCache{entries:BTreeMap<PathBuf,CachedPlist>,bytes:usize}
struct Configuration{templates:Vec<Template>,omp:Vec<MetadataJob>,other_jobs:Vec<ScheduledJob>,sources:Vec<SourceStatus>,scanned:usize}
enum CronRead{Missing,Failed(String),Jobs(Vec<ScheduledJob>,usize)}
#[derive(Default)]
struct State{cache:PlistCache,configuration:Option<Configuration>,domains:BTreeMap<String,LaunchDomain>,snapshot:Option<ScheduleSnapshot>}
#[derive(Clone)]
pub struct ScheduleCollector{io:BoundedIo,worker:DataWorker,paths:SchedulePaths,state:Arc<Mutex<State>>}
impl ScheduleCollector{
    pub fn new(io:BoundedIo,worker:DataWorker,home:PathBuf)->Self{
        Self{io,worker,paths:SchedulePaths::new(home),state:Arc::new(Mutex::new(State::default()))}
    }
    pub fn with_paths(io:BoundedIo,worker:DataWorker,paths:SchedulePaths)->Result<Self>{
        paths.validate()?;Ok(Self{io,worker,paths,state:Arc::new(Mutex::new(State::default()))})
    }
    fn domains(&self)->[String;3]{[format!("gui/{}",self.paths.uid),format!("user/{}",self.paths.uid),"system".into()]}
    fn directory_source_id(&self,directory:&Path)->String{
        if directory.strip_prefix(&self.paths.home).is_ok_and(|relative|relative==Path::new("Library/LaunchAgents")){return "launchagents:user".into();}
        match directory.to_str(){
            Some("/Library/LaunchAgents")=>"launchagents:local".into(),
            Some("/Library/LaunchDaemons")=>"launchdaemons:local".into(),
            Some("/System/Library/LaunchAgents")=>"launchagents:system".into(),
            Some("/System/Library/LaunchDaemons")=>"launchdaemons:system".into(),
            _=>{use sha2::{Digest,Sha256};format!("launchdirectory:{:x}",Sha256::digest(directory.as_os_str().as_encoded_bytes()))}
        }
    }
    pub async fn collect(&self,cancel:&CancellationToken)->Result<ScheduleSnapshot>{
        check_cancel(cancel)?;self.paths.validate()?;
        let mut state=tokio::select!{biased;_=cancel.cancelled()=>return Err(Error::cancelled()),state=self.state.lock()=>state};
        if !cfg!(target_os="macos"){
            let snapshot=ScheduleSnapshot{collected_at:timestamp(),jobs:Vec::new(),sources:vec![SourceStatus::new("schedules","系统调度",SourceState::Unsupported,"当前采集器仅支持 macOS launchd 与用户 crontab")]};
            state.snapshot=Some(snapshot.clone());return Ok(snapshot);
        }
        let names=self.domains();
        let State{cache,domains,..}=&mut *state;
        let (configuration,gui,user,system)=tokio::join!(
            self.read_configuration(cache,cancel),
            launchd::read_domain(&self.io,&names[0],domains.get(&names[0]),cancel),
            launchd::read_domain(&self.io,&names[1],domains.get(&names[1]),cancel),
            launchd::read_domain(&self.io,&names[2],domains.get(&names[2]),cancel)
        );
        let failures=configuration.as_ref().err().into_iter().chain(gui.as_ref().err()).chain(user.as_ref().err()).chain(system.as_ref().err()).cloned().collect::<Vec<_>>();
        if !failures.is_empty(){return Err(Error::aggregate(failures));}check_cancel(cancel)?;
        let configuration=configuration?;
        let readings=BTreeMap::from([(names[0].clone(),gui?),(names[1].clone(),user?),(names[2].clone(),system?)]);
        let snapshot=self.compose(&configuration,&readings,&state.cache)?;
        state.configuration=Some(configuration);state.domains=readings;state.snapshot=Some(snapshot.clone());Ok(snapshot)
    }
    pub async fn retry_source(&self,source_id:&str,cancel:&CancellationToken)->Result<ScheduleSnapshot>{
        check_cancel(cancel)?;
        validate_text(source_id,MAX_SOURCE_ID_LENGTH,512,"schedule source ID")?;
        let mut state=tokio::select!{biased;_=cancel.cancelled()=>return Err(Error::cancelled()),state=self.state.lock()=>state};
        let domain=source_id.strip_prefix("launchctl:").filter(|domain|self.domains().iter().any(|known|known.as_str()==*domain)).ok_or_else(||Error::invalid("source does not support individual retry"))?;
        let previous=state.domains.get(domain).filter(|reading|reading.source.retry==Some(SourceRetry::Source)).ok_or_else(||Error::invalid("refresh schedules before source retry"))?;
        if state.configuration.is_none(){return Err(Error::invalid("refresh schedules before source retry"));}
        let reading=launchd::read_domain(&self.io,domain,Some(previous),cancel).await?;check_cancel(cancel)?;
        let mut domains=state.domains.clone();domains.insert(domain.to_owned(),reading);
        let snapshot=self.compose(state.configuration.as_ref().unwrap(),&domains,&state.cache)?;
        state.domains=domains;state.snapshot=Some(snapshot.clone());Ok(snapshot)
    }
    pub async fn history(&self,job:&ScheduledJob,offset:usize,cancel:&CancellationToken)->Result<ScheduleHistory>{
        check_cancel(cancel)?;validate_text(&job.id,MAX_SCHEDULE_ID_LENGTH,1024,"schedule job ID")?;
        if offset>MAX_HISTORY_OFFSET||offset%HISTORY_PAGE_SIZE!=0{return Err(Error::invalid("history offset"));}
        {
            let state=tokio::select!{biased;_=cancel.cancelled()=>return Err(Error::cancelled()),state=self.state.lock()=>state};
            require_current_job(state.snapshot.as_ref(),&job.id)?;
        }
        let Some(id)=job.id.strip_prefix("hermes-job:")else{
            return Ok(ScheduleHistory{job_id:job.id.clone(),source:HistorySource::Unavailable,entries:Vec::new(),offset,limit:HISTORY_PAGE_SIZE,has_more:false,collected_at:timestamp()});
        };
        validate_text(id,MAX_HERMES_JOB_ID_LENGTH,512,"Hermes job ID")?;
        #[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]struct Page{entries:Vec<ScheduleExecution>,has_more:bool}
        let response=self.worker.request("hermes-history",&self.paths.hermes_database,json!({"jobId":id,"offset":offset}),cancel).await?;
        let page:Page=serde_json::from_value(response).map_err(|_|Error::invalid("Hermes history response"))?;
        if page.entries.len()>HISTORY_PAGE_SIZE{return Err(Error::limit("Hermes history page",HISTORY_PAGE_SIZE,page.entries.len()));}
        check_cancel(cancel)?;
        let state=tokio::select!{biased;_=cancel.cancelled()=>return Err(Error::cancelled()),state=self.state.lock()=>state};
        require_current_job(state.snapshot.as_ref(),&job.id)?;
        Ok(ScheduleHistory{job_id:job.id.clone(),source:HistorySource::Hermes,entries:page.entries,offset,limit:HISTORY_PAGE_SIZE,has_more:page.has_more,collected_at:timestamp()})
    }
    async fn read_plist(&self,file:&Path,scope:JobScope,cache:&PlistCache,cancel:&CancellationToken)->Result<PlistRead>{
        let before=self.io.metadata("schedule-files",file,false,cancel).await?;
        if !before.is_file{return Err(Error::invalid("plist must be a regular file"));}
        if before.identity.size>FILE_BYTES as u64{return Err(Error::limit("plist file bytes",FILE_BYTES,before.identity.size.try_into().unwrap_or(usize::MAX)));}
        if cache.entries.get(file).is_some_and(|cached|cached.identity==before.identity){return Ok(PlistRead::CacheHit);}
        let mut command=CommandSpec::new("/usr/bin/plutil",["-convert","json","-o","-","-"],4*1024*1024,Duration::from_secs(6));
        command.input_file=Some(InputFile{path:file.to_owned(),max_bytes:FILE_BYTES,identity:Some(before.identity.clone())});
        let converted=self.io.command("schedule-plist",command,cancel).await?.success()?;
        let after=self.io.metadata("schedule-files",file,false,cancel).await?;
        if !after.is_file||before.identity!=after.identity{return Err(Error::new("OC_COLLECTION_CHANGED","plist 在转换期间发生变化 / plist changed during conversion"));}
        let raw:Value=serde_json::from_slice(&converted.stdout).map_err(|_|Error::invalid("converted plist JSON"))?;
        let template=parse::launch_job(raw,file,&self.paths.home,scope)?.map(|(job,disabled,warnings)|Template{job,disabled,warnings});
        let projection=template.as_ref().map(|template|parse::job_bytes(&template.job)).transpose()?.unwrap_or(4);
        if projection>parse::PROJECTION_BYTES{return Err(Error::limit("plist projection bytes",parse::PROJECTION_BYTES,projection));}
        let warning_bytes=template.as_ref().map(|value|value.warnings.iter().map(String::len).sum::<usize>()).unwrap_or(0);
        let bytes=projection+file.as_os_str().len()+warning_bytes+128;
        Ok(PlistRead::Converted(CachedPlist{identity:before.identity,template,bytes}))
    }
    fn commit_plist(file:&Path,read:PlistRead,cache:&mut PlistCache)->Result<Option<Template>>{
        match read{
            PlistRead::CacheHit=>Ok(cache.entries.get(file).ok_or_else(||Error::invalid("missing cached plist"))?.template.clone()),
            PlistRead::Converted(candidate)=>{
                let previous=cache.entries.get(file).map(|value|value.bytes).unwrap_or(0);
                let total=cache.bytes-previous+candidate.bytes;
                if total>JOB_BYTES{return Err(Error::limit("plist cache bytes",JOB_BYTES,total));}
                if previous==0&&cache.entries.len()>=4096{return Err(Error::limit("plist cache entries",4096,cache.entries.len()+1));}
                let template=candidate.template.clone();
                cache.entries.insert(file.to_owned(),candidate);cache.bytes=total;Ok(template)
            }
        }
    }
    async fn metadata(&self,file:&Path,id:&str,label:&str,cancel:&CancellationToken)->Result<(Vec<MetadataJob>,SourceStatus)>{
        let read=async{let file=self.io.read_file("schedule-metadata",file,FILE_BYTES,false,cancel).await?;parse::parse_metadata(&file.bytes)}.await;
        match read{
            Ok(jobs)=>{let state=if jobs.is_empty(){SourceState::Empty}else{SourceState::Ok};let detail=format!("{} 条任务元数据；仅使用名称、标识、调度与状态",jobs.len());Ok((jobs,SourceStatus::new(id,label,state,detail)))}
            Err(error)=>{propagate(&error,cancel)?;let missing=error.code=="ENOENT";Ok((Vec::new(),SourceStatus::new(id,label,if missing{SourceState::Empty}else{SourceState::Error},if missing{"未配置任务元数据".into()}else{detail(&error)})))}
        }
    }
    async fn read_crontab(&self,cancel:&CancellationToken)->Result<CronRead>{
        let failed=|error:Error|->Result<CronRead>{propagate(&error,cancel)?;Ok(CronRead::Failed(detail(&error)))};
        let output=match self.io.command("schedule-commands",CommandSpec::new("/usr/bin/crontab",["-l"],8*1024*1024,Duration::from_secs(6)),cancel).await{Ok(output)=>output,Err(error)=>return failed(error)};
        if output.exit_code==1&&String::from_utf8_lossy(&output.stderr).to_ascii_lowercase().contains("no crontab for "){return Ok(CronRead::Missing);}
        let output=match output.success(){Ok(output)=>output,Err(error)=>return failed(error)};
        match output.stdout_text(){Ok(text)=>match parse_crontab(text){Ok((jobs,invalid))=>Ok(CronRead::Jobs(jobs,invalid)),Err(error)=>failed(error)},Err(error)=>failed(error)}
    }
    async fn read_configuration(&self,cache:&mut PlistCache,cancel:&CancellationToken)->Result<Configuration>{
        let mut sources=Vec::new();
        let (omp,omp_source)=self.metadata(&self.paths.omp_metadata,"omp-cron","OMP 任务元数据",cancel).await?;
        let (hermes,hermes_source)=self.metadata(&self.paths.hermes_metadata,"hermes-cron","Hermes 任务元数据",cancel).await?;
        sources.push(omp_source);sources.push(hermes_source);
        let mut scanned=0;let mut directories=Vec::new();let mut seen=BTreeSet::new();
        for (directory,scope) in &self.paths.directories{
            // Darwin NAME_MAX is 255 bytes. Every entry counts, including non-plist names.
            match self.io.read_directory("schedule-files",directory,(4096usize-scanned).max(1),255,cancel).await{
                Ok(mut paths)=>{
                    scanned+=paths.len();if scanned>4096{return Err(Error::limit("schedule directory entries",4096,scanned));}
                    paths.retain(|path|path.extension().is_some_and(|ext|ext=="plist"));paths.sort();seen.extend(paths.iter().cloned());directories.push((directory,scope,paths));
                }
                Err(error)=>{propagate(&error,cancel)?;let missing=error.code=="ENOENT";sources.push(SourceStatus::new(self.directory_source_id(directory),directory.to_string_lossy(),if missing{SourceState::Empty}else{SourceState::Error},if missing{"目录不存在（ENOENT）；未配置此可选调度来源 / Optional schedule directory is not configured".into()}else{detail(&error)}));}
            }
        }
        require_complete(&sources)?;
        cache.entries.retain(|path,_|seen.contains(path));cache.bytes=cache.entries.values().map(|entry|entry.bytes).sum();
        let mut templates=BTreeMap::new();let mut template_bytes=0;
        for (directory,scope,files) in directories{
            let mut failures=Vec::new();let mut non_services=0;let mut duplicates=0;let mut warnings=0;let mut first_warning=String::new();
            for batch in files.chunks(4){
                check_cancel(cancel)?;
                // All four operations finish (including cancellation cleanup) before any result is committed.
                let (first,second,third,fourth)={
                    let cache=&*cache;
                    let read=|index:usize|async move{match batch.get(index){Some(file)=>Some(self.read_plist(file.as_path(),*scope,cache,cancel).await),None=>None}};
                    tokio::join!(read(0),read(1),read(2),read(3))
                };
                let results=[first,second,third,fourth];
                let fatal=results.iter().flatten().filter_map(|result|result.as_ref().err()).filter(|error|error.is_cleanup()||error.is_cancelled()).cloned().collect::<Vec<_>>();
                if !fatal.is_empty(){return Err(Error::aggregate(fatal));}check_cancel(cancel)?;
                // Commit cache entries and duplicate-label precedence in sorted file order, never completion order.
                for (file,result) in batch.iter().zip(results.into_iter().flatten()){
                // Errors stay per-file: one unreadable plist must not discard the rest of the directory.
                match result.and_then(|read|Self::commit_plist(file,read,cache)){
                    Ok(None)=>non_services+=1,
                    Ok(Some(template))=>{
                        if templates.contains_key(&template.job.id){duplicates+=1;continue;}
                        if !template.warnings.is_empty(){warnings+=1;if first_warning.is_empty(){first_warning=format!("{}：{}",file.file_name().unwrap_or_default().to_string_lossy(),template.warnings.join("；"));}}
                        template_bytes+=parse::job_bytes(&template.job)?;if template_bytes>JOB_BYTES{return Err(Error::limit("configured jobs bytes",JOB_BYTES,template_bytes));}
                        templates.insert(template.job.id.clone(),template);
                    }
                    Err(error)=>{propagate(&error,cancel)?;if failures.len()<16{failures.push(detail(&error));}}
                }
                }
            }
            let failure=if failures.is_empty(){String::new()}else{format!("；读取失败：{}",failures.join("；"))};
            let calendar=if warnings==0{String::new()}else{format!("；{warnings} 个任务含未确认日历扩展，任务已保留；{first_warning}")};
            sources.push(SourceStatus::new(self.directory_source_id(directory),directory.to_string_lossy(),if !failures.is_empty(){SourceState::Error}else if warnings>0{SourceState::Partial}else{SourceState::Ok},
                format!("{} 个 plist；{non_services} 个非服务数据 / 空字典已跳过；{duplicates} 个同域同 Label 重复已合并{failure}{calendar}",files.len())));
        }
        let runtime=async{if hermes.is_empty(){Ok(None)}else{runtime::collect(&self.io,&self.worker,&hermes,&self.paths.hermes_database,cancel).await.map(Some)}};
        let (cron,runtime)=tokio::join!(self.read_crontab(cancel),runtime);
        let failures=cron.as_ref().err().into_iter().chain(runtime.as_ref().err()).cloned().collect::<Vec<_>>();
        if !failures.is_empty(){return Err(Error::aggregate(failures));}
        let cron=cron?;let runtime=runtime?;
        let mut other_jobs=Vec::new();
        match cron{
            CronRead::Missing=>sources.push(SourceStatus::new("crontab","当前用户 crontab",SourceState::Empty,"当前用户未配置 crontab")),
            CronRead::Failed(detail)=>sources.push(SourceStatus::new("crontab","当前用户 crontab",SourceState::Error,detail)),
            CronRead::Jobs(jobs,invalid)=>{
                let detail=if invalid>0{format!("{} 条；{invalid} 行无法解析；不读取其他用户 crontab；cron 不提供每条任务的运行状态",jobs.len())}else{format!("{} 条；不读取其他用户 crontab；cron 不提供每条任务的运行状态",jobs.len())};
                sources.push(SourceStatus::new("crontab","当前用户 crontab",if invalid>0{SourceState::Error}else if jobs.is_empty(){SourceState::Empty}else{SourceState::Ok},detail));
                other_jobs.extend(jobs);
            }
        }
        if let Some((mut statuses,source))=runtime{
            sources.push(source);
            let mut included=BTreeSet::new();let now=Utc::now();
            for item in &hermes{
                if !included.insert(&item.id){continue;}
                let status=statuses.remove(&item.id).ok_or_else(||Error::invalid("missing Hermes runtime status"))?;
                let (kind,schedule)=parse::metadata_schedule(item)?;
                let disabled=item.enabled==Some(false)||matches!(item.state.as_deref(),Some("paused"|"completed"));
                let next_run=if disabled{None}else{item.next_run_at.as_deref().and_then(runtime::time).filter(|at|*at>now).map(|at|at.to_rfc3339_opts(SecondsFormat::Millis,true))};
                other_jobs.push(ScheduledJob{id:format!("hermes-job:{}",item.id),name:item.name.as_ref().filter(|value|!value.is_empty()).cloned().unwrap_or_else(||item.id.clone()),source:"Hermes 任务（由调度器执行）".into(),scope:JobScope::User,origin:JobOrigin::Personal,kind,schedule,state:status.state,state_reason:status.reason,last_run:status.last_run,pid:status.pid,last_exit_code:None,file:Some(self.paths.hermes_metadata.to_string_lossy().into_owned()),executable:None,next_run});
            }
        }
        sources.push(SourceStatus::new("schedule-semantics","调度边界",SourceState::Ok,"LaunchAgents 状态仅对应当前用户；LaunchDaemons 对应 system。启动 / 常驻服务与定时任务分列。Hermes 调度器与内部任务分别列出。launchd / cron 不提供可靠下次执行时间，不做推算；Hermes 仅显示元数据中带时区且未过期的计划时间，不保证实际执行。"));
        check_cancel(cancel)?;require_complete(&sources)?;parse::check_jobs(&other_jobs)?;
        Ok(Configuration{templates:templates.into_values().collect(),omp,other_jobs,sources,scanned})
    }
    fn compose(&self,configuration:&Configuration,domains:&BTreeMap<String,LaunchDomain>,cache:&PlistCache)->Result<ScheduleSnapshot>{
        let names=self.domains();let domain=|index:usize|domains.get(&names[index]).ok_or_else(||Error::invalid("unread launchd domain"));
        let (gui,user,system)=(domain(0)?,domain(1)?,domain(2)?);
        let mut sources=vec![gui.source.clone(),user.source.clone(),system.source.clone()];sources.extend(configuration.sources.clone());
        let mut jobs=BTreeMap::new();
        for template in &configuration.templates{
            let mut job=template.job.clone();let label=job.id.splitn(3,':').nth(2).ok_or_else(||Error::invalid("launchd job ID"))?;
            let domain=if job.scope==JobScope::System{system}else if gui.loaded_known&&gui.services.contains_key(label){gui}else if user.loaded_known&&user.services.contains_key(label){user}else{gui};
            let loaded_known=if job.scope==JobScope::System{system.loaded_known}else{(domain.loaded_known&&domain.services.contains_key(label))||(gui.loaded_known&&user.loaded_known)};
            let runtime=if domain.loaded_known{domain.services.get(label)}else{None};
            job.state=launch_state(runtime,domain.disabled.get(label).copied(),template.disabled,loaded_known,domain.disabled_known);
            job.pid=runtime.and_then(|runtime|runtime.pid);job.last_exit_code=runtime.and_then(|runtime|runtime.last_exit_code);jobs.insert(job.id.clone(),job);
        }
        for (scope,domain) in [(JobScope::User,gui),(JobScope::User,user),(JobScope::System,system)]{
            for (label,entry) in &domain.services{
                let id=format!("launchd:{}:{label}",if scope==JobScope::System{"system"}else{"user"});
                if jobs.get(&id).is_some_and(|job|job.file.is_some()||job.state!=JobState::Unknown){continue;}
                let runtime=if domain.loaded_known{Some(entry)}else{None};
                jobs.insert(id.clone(),ScheduledJob{id,name:label.clone(),source:"launchd · 运行时服务".into(),scope,origin:if label.starts_with("com.apple."){JobOrigin::System}else{JobOrigin::Unknown},kind:JobKind::Service,schedule:"标准目录中未发现对应 plist，触发方式未知".into(),state:launch_state(runtime,domain.disabled.get(label).copied(),false,domain.loaded_known,domain.disabled_known),state_reason:None,last_run:None,pid:runtime.and_then(|runtime|runtime.pid),last_exit_code:runtime.and_then(|runtime|runtime.last_exit_code),file:None,executable:None,next_run:None});
                if jobs.len()>MAX_JOBS{return Err(Error::limit("schedule jobs",MAX_JOBS,jobs.len()));}
            }
        }
        let mut jobs=jobs.into_values().collect::<Vec<_>>();parse::merge_omp(&mut jobs,&configuration.omp,&self.paths.omp_metadata)?;jobs.extend(configuration.other_jobs.clone());parse::check_jobs(&jobs)?;
        sources.push(SourceStatus::new("schedule-limits","调度资源边界",SourceState::Ok,format!("目录条目 {}/4096（所有用户与系统目录合计，含非 plist）；任务 {}/4096；缓存 {}/4096 项，投影 {}/{} 字节（含键与固定元数据估算）；任务投影最多 {} 字节。字节额度不代表 heap 或 RSS。",configuration.scanned,jobs.len(),cache.entries.len(),cache.bytes,JOB_BYTES,JOB_BYTES)));
        require_complete(&sources)?;jobs.sort_by(|a,b|a.id.cmp(&b.id));Ok(ScheduleSnapshot{collected_at:timestamp(),jobs,sources})
    }
}
fn require_current_job(snapshot:Option<&ScheduleSnapshot>,id:&str)->Result<()>{
    if snapshot.is_some_and(|snapshot|snapshot.jobs.iter().any(|job|job.id==id)){Ok(())}else{Err(Error::invalid("history requires a job in the current schedule snapshot"))}
}
fn require_complete(sources:&[SourceStatus])->Result<()>{
    if sources.len()>64{return Err(Error::limit("schedule sources",64,sources.len()));}
    let failures=sources.iter().filter(|source|source.state==SourceState::Error).map(|source|Error::new("OC_SCHEDULE_CONFIGURATION",format!("{}：{}",source.label,source.detail))).collect::<Vec<_>>();
    if failures.is_empty(){Ok(())}else{Err(Error::aggregate(failures))}
}
fn propagate(error:&Error,cancel:&CancellationToken)->Result<()>{if error.is_cleanup()||error.is_cancelled(){return Err(error.clone());}check_cancel(cancel)}
fn detail(error:&Error)->String{match error.code.as_str(){"ENOENT"=>"文件或命令不存在".into(),"EACCES"|"EPERM"=>"权限不足".into(),"ETIMEDOUT"=>"读取超时".into(),"OC_COLLECTION_CHANGED"=>"文件在读取期间发生变化，本轮未使用此结果 / File changed during reading".into(),_=>format!("读取失败 / Read failed ({})",error.code)}}
