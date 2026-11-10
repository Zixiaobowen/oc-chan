use super::*;
use crate::resources::ResourceBudget;
use serde_json::json;

fn job(id:&str)->ScheduledJob{
    ScheduledJob{id:id.into(),name:id.into(),source:"launchd".into(),scope:JobScope::User,origin:JobOrigin::Unknown,kind:JobKind::Calendar,schedule:"每日 08:00".into(),state:JobState::Waiting,state_reason:None,last_run:None,pid:None,last_exit_code:None,file:None,executable:None,next_run:None}
}
fn collector(home:&Path)->ScheduleCollector{
    let io=BoundedIo::new(ResourceBudget::default());let worker=DataWorker::new(io.clone(),home.join("oc-data-worker"));
    ScheduleCollector::new(io,worker,home.to_owned())
}
fn domain(name:&str,known:bool,pid:Option<u32>)->LaunchDomain{
    let mut source=SourceStatus::new(format!("launchctl:{name}"),name,if known{SourceState::Ok}else{SourceState::Partial},"fixture observation");
    source.retry=Some(SourceRetry::Source);source.last_attempt_at=Some("2026-01-01T00:00:00.000Z".into());
    LaunchDomain{services:BTreeMap::from([("local.job".into(),LaunchRuntime{pid,last_exit_code:None})]),disabled:BTreeMap::new(),loaded_known:known,disabled_known:known,source}
}
#[test]fn calendars_preserve_wildcards_or_conditions_extensions_and_combined_triggers(){
    assert_eq!(describe_calendar(&json!({"Hour":8,"Minute":15})).unwrap().0,"每月每日 08时15分");
    assert_eq!(describe_calendar(&json!({"Month":11,"Day":2,"Weekday":1,"Minute":0})).unwrap().0,"11月（2日或周一） 每小时00分");
    assert_eq!(describe_calendar(&json!({})).unwrap().0,"每月每日 每小时每分钟");
    assert!(describe_calendar(&json!({"Weekday":7,"Hour":0})).unwrap().0.contains("周日 00时"));
    let (text,warnings)=describe_calendar(&json!([{"Hour":8,"Second":0},{"Hour":18,"Unknown":"private payload"}])).unwrap();
    assert!(text.contains("；或 "));assert!(text.contains("Second=0"));assert_eq!(warnings.len(),2);assert!(!text.contains("private payload"));
    for invalid in [json!([]),json!({"Minute":60}),json!({"Hour":1.5}),json!({"Day":0}),json!({"Month":13})]{assert!(describe_calendar(&invalid).is_err());}
    assert!(describe_calendar(&json!(vec![json!({});65])).is_err());
    let (kind,text,_)=describe_launch_schedule(json!({"StartCalendarInterval":{"Minute":5},"StartInterval":600,"RunAtLoad":true,"KeepAlive":{}}).as_object().unwrap()).unwrap();
    assert_eq!(kind,JobKind::Calendar);assert!(text.contains("每 600 秒"));assert!(text.contains("加载时也运行"));assert!(text.contains("KeepAlive"));
    for (input,kind) in [(json!({"KeepAlive":{}}),JobKind::Service),(json!({"RunAtLoad":true}),JobKind::Startup),(json!({"WatchPaths":["/path"]}),JobKind::Service)]{assert_eq!(describe_launch_schedule(input.as_object().unwrap()).unwrap().0,kind);}
}
#[test]fn plist_whitelist_ignores_nonservices_and_never_publishes_arguments_or_environment(){
    let file=Path::new("/Users/example/Library/LaunchAgents/example.plist");let home=Path::new("/Users/example");
    for input in [json!({}),json!({"Version4":{"MemoryCapacity":16}})]{assert!(parse::launch_job(input,file,home,JobScope::User).unwrap().is_none());}
    for input in [json!([]),json!({"Program":"/bin/run"}),json!({"Label":""}),json!({"StartInterval":60})]{assert!(parse::launch_job(input,file,home,JobScope::User).is_err());}
    let (job,_,_)=parse::launch_job(json!({"Label":"local.job","ProgramArguments":["/bin/run","--token=secret"],"EnvironmentVariables":{"SECRET":"private"},"StartInterval":60}),file,home,JobScope::User).unwrap().unwrap();
    assert_eq!(job.id,"launchd:user:local.job");assert_eq!(job.executable.as_deref(),Some("run"));let output=serde_json::to_string(&job).unwrap();assert!(!output.contains("secret"));assert!(!output.contains("private"));assert!(!output.contains("ProgramArguments"));
}
#[test]fn origins_follow_namespace_and_entrypoint_evidence(){
    let home=Path::new("/Users/example");let user=home.join("Library/LaunchAgents/custom.plist");
    let origin=|input:Value,file:&Path|launch_origin(input.as_object().unwrap(),file,home);
    assert_eq!(origin(json!({"Label":"com.user.login","Program":"/usr/bin/open"}),&user),JobOrigin::Personal);
    assert_eq!(origin(json!({"Label":"com.apple.daemon","Program":"/Users/example/script.sh"}),&user),JobOrigin::System);
    assert_eq!(origin(json!({"Label":"ai.hermes.gateway"}),&user),JobOrigin::Application);
    assert_eq!(origin(json!({"Label":"vendor","ProgramArguments":["/usr/bin/open","/Applications/Vendor.app"]}),&user),JobOrigin::Application);
    assert_eq!(origin(json!({"Label":"vendor","ProgramArguments":["/usr/bin/python3.11","-IB","--","/Users/example/reports/daily.py"]}),&user),JobOrigin::Personal);
    assert_eq!(origin(json!({"Label":"custom","Program":"/Users/example/scripts/backup.sh"}),Path::new("/Library/LaunchDaemons/custom.plist")),JobOrigin::Personal);
    for input in [json!({"Label":"vendor","ProgramArguments":["/bin/sh","-c","/Users/example/payload.sh"]}),json!({"Label":"vendor","ProgramArguments":["/usr/bin/python3","-W","/Users/example/payload.py","/opt/main.py"]}),json!({"Label":"vendor","Program":"/Users/example/scripts/../Library/vendor.py"}),json!({"Label":"vendor","Program":"/Users/example-other/script.sh"}),json!({"Label":"vendor","ProgramArguments":["node","/Users/example/project/node_modules/vendor/start.js"]})]{assert_eq!(origin(input,&user),JobOrigin::Unknown);}
}
#[test]fn cron_ids_are_stable_and_command_payloads_are_not_published(){
    let input="# comment secret\nTOKEN=private\nCRON_TZ=Asia/Shanghai\n*/15 8-18 * JAN MON-FRI /bin/run --token=secret\n@reboot /bin/start --password=hidden\n";
    let (jobs,invalid)=parse_crontab(input).unwrap();assert_eq!(invalid,0);assert_eq!(jobs.len(),2);assert_eq!(jobs,parse_crontab(input).unwrap().0);
    assert_eq!(jobs[1].kind,JobKind::Startup);assert!(jobs[0].schedule.contains("CRON_TZ=Asia/Shanghai"));assert!(jobs[0].schedule.contains("周 MON-FRI"));
    let output=serde_json::to_string(&jobs).unwrap();for private in ["private","secret","hidden","/bin/","TOKEN"]{assert!(!output.contains(private));}
    assert_ne!(jobs[0].id,parse_crontab(&input.replace("--token=secret","--token=changed")).unwrap().0[0].id);
    assert_eq!(parse_crontab("echo secret values must stay private\n99 0 * * * /bin/run\n@unsupported /bin/run\n").unwrap().1,3);
    for invalid in ["0 25 * * *","0 0 0 * *","0 0 * BAD *","*/0 * * * *","0 0 * * 8"]{assert!(describe_cron(invalid).is_err());}
    assert!(parse_crontab(&format!("* * * * * {}","x".repeat(4096))).is_err());
}
#[test]fn metadata_skips_private_fields_and_preserves_all_schedule_formats(){
    let document=json!({"jobs":[{"id":"interval","schedule":{"kind":"interval","minutes":0.5},"prompt":"private","command":"never execute"},{"id":"once","schedule":{"kind":"once","run_at":"2026-11-10T00:00:00Z"}},{"id":"cron","schedule":{"kind":"cron","expr":"0 8 * * MON"}},{"id":"calendar","calendar":{"Hour":8}}]});
    let jobs=parse::parse_metadata(&serde_json::to_vec(&document).unwrap()).unwrap();assert_eq!(jobs.len(),4);
    assert_eq!(parse::metadata_schedule(&jobs[0]).unwrap(),(JobKind::Interval,"每 0.5 分钟".into()));assert!(parse::metadata_schedule(&jobs[1]).unwrap().1.starts_with("单次："));
    assert!(parse::parse_metadata(br#"{"jobs":[{"id":"bad","enabled":"false","calendar":{}}]}"#).is_err());
    assert!(parse::parse_metadata(&serde_json::to_vec(&json!({"jobs":[{"id":"😀".repeat(65),"calendar":{}}]})).unwrap()).is_err());
    assert!(parse::parse_metadata(&vec![b' ';FILE_BYTES+1]).is_err());
    assert!(parse::parse_metadata(br#"{"jobs":[{"id":"bad","schedule":{"kind":"unknown"}}]}"#).is_err());
}
#[test]fn omp_merges_by_label_preserves_running_and_uses_plist_schedule_when_present(){
    let metadata=parse::parse_metadata(br#"{"jobs":[{"id":"daily","name":"Daily","enabled":false,"calendar":{"Hour":9}}]}"#).unwrap();
    let mut existing=job("launchd:user:com.user.omp-cron.daily");existing.file=Some("/daily.plist".into());existing.state=JobState::Running;existing.pid=Some(42);
    let mut jobs=vec![existing];parse::merge_omp(&mut jobs,&metadata,Path::new("/jobs.json")).unwrap();
    assert_eq!(jobs.len(),1);assert_eq!(jobs[0].state,JobState::Running);assert_eq!(jobs[0].schedule,"每日 08:00");assert_eq!(jobs[0].origin,JobOrigin::Personal);assert_eq!(jobs[0].name,"Daily");
    let mut absent=Vec::new();parse::merge_omp(&mut absent,&metadata,Path::new("/jobs.json")).unwrap();assert_eq!(absent[0].state,JobState::Disabled);
}
#[test]fn configuration_failure_cannot_be_hidden_by_valid_empty_or_runtime_sources(){
    let valid=SourceStatus::new("crontab","crontab",SourceState::Empty,"no crontab");
    for id in ["omp-cron","hermes-cron","launchagents:local","crontab"]{assert!(require_complete(&[valid.clone(),SourceStatus::new(id,id,SourceState::Error,"permission denied")]).is_err());}
    assert!(require_complete(&[valid,SourceStatus::new("launchctl:system","system",SourceState::Partial,"unconfirmed")]).is_ok());
}
#[test]fn retry_composition_preserves_unrelated_sources_and_never_reuses_failed_table_pid(){
    let collector=collector(Path::new("/fixture"));let names=collector.domains();
    let mut domains=BTreeMap::from([(names[0].clone(),domain(&names[0],true,Some(42))),(names[1].clone(),domain(&names[1],true,None)),(names[2].clone(),domain(&names[2],true,Some(99)))]);
    let configuration=Configuration{templates:vec![Template{job:job("launchd:user:local.job"),disabled:false,warnings:Vec::new()}],omp:Vec::new(),other_jobs:Vec::new(),sources:vec![SourceStatus::new("omp-cron","OMP",SourceState::Empty,"missing optional metadata")],scanned:1};
    let first=collector.compose(&configuration,&domains,&PlistCache::default()).unwrap();
    assert_eq!(first.jobs.iter().find(|job|job.id=="launchd:user:local.job").unwrap().pid,Some(42));
    domains.insert(names[0].clone(),domain(&names[0],false,Some(42)));
    let second=collector.compose(&configuration,&domains,&PlistCache::default()).unwrap();
    assert_eq!(second.sources[1],first.sources[1]);assert_eq!(second.sources[2],first.sources[2]);assert_eq!(second.sources[3],first.sources[3]);
    // User domain remains a valid alternate observation; the old GUI PID is never reused.
    assert_eq!(second.jobs.iter().find(|job|job.id=="launchd:user:local.job").unwrap().pid,None);
}
#[tokio::test]async fn history_requires_current_job_and_valid_page_before_worker_admission(){
    let collector=collector(Path::new("/fixture"));let hermes=job("hermes-job:daily");let token=CancellationToken::new();
    assert!(collector.history(&hermes,0,&token).await.is_err());
    collector.state.lock().await.snapshot=Some(ScheduleSnapshot{collected_at:timestamp(),jobs:vec![hermes.clone(),job("launchd:user:local.job")],sources:Vec::new()});
    for offset in [1,24,100001,100025]{assert!(collector.history(&hermes,offset,&token).await.is_err());}
    let unavailable=collector.history(&job("launchd:user:local.job"),0,&token).await.unwrap();assert_eq!(unavailable.source,HistorySource::Unavailable);
    assert!(collector.retry_source("omp-cron",&token).await.is_err());assert!(collector.retry_source("launchctl:system",&token).await.is_err());
    token.cancel();assert!(collector.history(&hermes,0,&token).await.unwrap_err().is_cancelled());
}
#[tokio::test]async fn metadata_missing_is_explicit_empty_but_bad_utf8_and_directory_are_errors(){
    let directory=tempfile::tempdir().unwrap();let collector=collector(directory.path());let token=CancellationToken::new();
    let missing=directory.path().join("absent.json");let (jobs,source)=collector.metadata(&missing,"omp-cron","OMP",&token).await.unwrap();assert!(jobs.is_empty());assert_eq!(source.state,SourceState::Empty);
    let invalid=directory.path().join("invalid.json");std::fs::write(&invalid,[0xff,0xfe]).unwrap();assert_eq!(collector.metadata(&invalid,"omp-cron","OMP",&token).await.unwrap().1.state,SourceState::Error);
    assert_eq!(collector.metadata(directory.path(),"omp-cron","OMP",&token).await.unwrap().1.state,SourceState::Error);
}
#[cfg(target_os="macos")]
#[tokio::test]async fn real_plutil_preserves_cache_identity_and_rejects_replaced_invalid_input(){
    let directory=tempfile::tempdir().unwrap();let collector=collector(directory.path());let token=CancellationToken::new();let file=directory.path().join("job.plist");let mut cache=PlistCache::default();
    let xml=|seconds|format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>local.fixture</string><key>StartInterval</key><integer>{seconds}</integer></dict></plist>");
    std::fs::write(&file,xml(60)).unwrap();let read=collector.read_plist(&file,JobScope::User,&cache,&token).await.unwrap();let first=ScheduleCollector::commit_plist(&file,read,&mut cache).unwrap().unwrap();assert!(first.job.schedule.contains("每 60 秒"));let original_bytes=cache.bytes;
    let read=collector.read_plist(&file,JobScope::User,&cache,&token).await.unwrap();ScheduleCollector::commit_plist(&file,read,&mut cache).unwrap();assert_eq!(cache.entries.len(),1);assert_eq!(cache.bytes,original_bytes);
    let replacement=directory.path().join("replacement.plist");std::fs::write(&replacement,xml(90)).unwrap();std::fs::rename(&replacement,&file).unwrap();let read=collector.read_plist(&file,JobScope::User,&cache,&token).await.unwrap();let next=ScheduleCollector::commit_plist(&file,read,&mut cache).unwrap().unwrap();assert!(next.job.schedule.contains("每 90 秒"));
    std::fs::write(&file,"invalid plist").unwrap();assert!(collector.read_plist(&file,JobScope::User,&cache,&token).await.is_err());
}
#[cfg(target_os="macos")]
#[tokio::test]async fn configuration_preserves_all_batches_and_sorted_duplicate_precedence(){
    let fixture=tempfile::tempdir().unwrap();let directory=fixture.path().join("agents");std::fs::create_dir(&directory).unwrap();
    // The last duplicate is in a partial second batch; the first sorted file must win.
    for (index,label) in ["local.duplicate","local.second","local.third","local.fourth","local.fifth","local.duplicate"].into_iter().enumerate(){
        let xml=format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>{label}</string><key>StartInterval</key><integer>{}</integer></dict></plist>",60+index);
        std::fs::write(directory.join(format!("{index}.plist")),xml).unwrap();
    }
    let mut paths=SchedulePaths::new(fixture.path().to_owned());paths.directories=vec![(directory.clone(),JobScope::User)];
    let io=BoundedIo::new(ResourceBudget::default());let worker=DataWorker::new(io.clone(),fixture.path().join("oc-data-worker"));
    let collector=ScheduleCollector::with_paths(io,worker,paths).unwrap();let token=CancellationToken::new();let mut cache=PlistCache::default();
    for _ in 0..2{
        let configuration=collector.read_configuration(&mut cache,&token).await.unwrap();
        assert_eq!(configuration.templates.len(),5);assert_eq!(configuration.scanned,6);
        let winner=configuration.templates.iter().find(|template|template.job.id=="launchd:user:local.duplicate").unwrap();
        assert_eq!(winner.job.file.as_deref(),directory.join("0.plist").to_str());assert!(winner.job.schedule.contains("每 60 秒"));
    }
}
#[cfg(target_os="macos")]
#[tokio::test]async fn cancelling_active_plist_batch_drains_all_resource_usage(){
    let fixture=tempfile::tempdir().unwrap();let directory=fixture.path().join("agents");std::fs::create_dir(&directory).unwrap();
    let padding="x".repeat(64*1024);
    for index in 0..8{
        let xml=format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>local.cancel.{index}</string><key>StartInterval</key><integer>60</integer><key>Comment</key><string>{padding}</string></dict></plist>");
        std::fs::write(directory.join(format!("{index}.plist")),xml).unwrap();
    }
    let mut paths=SchedulePaths::new(fixture.path().to_owned());paths.directories=vec![(directory,JobScope::User)];
    let budget=ResourceBudget::default();let io=BoundedIo::new(budget.clone());let worker=DataWorker::new(io.clone(),fixture.path().join("oc-data-worker"));
    let collector=ScheduleCollector::with_paths(io,worker,paths).unwrap();let token=CancellationToken::new();let mut cache=PlistCache::default();
    let cancel_when_active=async{
        let observed=tokio::time::timeout(Duration::from_secs(5),async{
            loop{
                if budget.snapshot().sources.iter().any(|source|source.source=="schedule-plist"&&source.statistics.current.commands>0){break;}
                tokio::task::yield_now().await;
            }
        }).await.is_ok();
        // Cancel even when observation times out, then let join drain the actual collection before asserting.
        token.cancel();observed
    };
    let (result,observed)=tokio::join!(collector.read_configuration(&mut cache,&token),cancel_when_active);
    assert!(observed,"no active real plist conversion observed before deadline");
    let error=result.err().expect("active collection must report cancellation");assert!(error.is_cancelled()||error.is_cleanup(),"{error:?}");
    let snapshot=budget.snapshot();let empty=crate::resources::ResourceUsage::default();
    assert_eq!(snapshot.global.current,empty);
    for source in snapshot.sources{assert_eq!(source.statistics.current,empty,"{}",source.source);}
}
#[tokio::test]async fn directory_limit_counts_ignored_entries_across_all_configured_directories(){
    let fixture=tempfile::tempdir().unwrap();let mut paths=SchedulePaths::new(fixture.path().to_owned());
    let first=fixture.path().join("user");let second=fixture.path().join("system");std::fs::create_dir(&first).unwrap();std::fs::create_dir(&second).unwrap();
    for index in 0..2048{std::fs::write(first.join(format!("ignored-{index}.txt")),[]).unwrap();}
    for index in 0..2049{std::fs::write(second.join(format!("ignored-{index}.txt")),[]).unwrap();}
    paths.directories=vec![(first,JobScope::User),(second,JobScope::System)];
    let io=BoundedIo::new(ResourceBudget::default());let worker=DataWorker::new(io.clone(),fixture.path().join("oc-data-worker"));
    let collector=ScheduleCollector::with_paths(io,worker,paths).unwrap();
    let error=collector.read_configuration(&mut PlistCache::default(),&CancellationToken::new()).await.err().expect("combined scan must fail before commands");
    assert_eq!(error.code,"OC_SCHEDULE_CONFIGURATION");assert!(error.message.contains("OC_COLLECTION_LIMIT"));
}
#[test]fn aggregate_job_and_source_limits_are_visible(){
    let oversized=job(&format!("hermes-job:{}","a".repeat(257)));assert!(parse::job_bytes(&oversized).is_err());
    let mut schedule=job("valid");schedule.schedule="x".repeat(parse::PROJECTION_BYTES+1);assert!(parse::job_bytes(&schedule).is_err());
    assert!(parse::check_jobs(&vec![job("valid");4097]).is_err());
    assert!(require_complete(&vec![SourceStatus::new("x","x",SourceState::Ok,"");65]).is_err());
    let mut paths=SchedulePaths::new(PathBuf::from("/fixture"));paths.directories=vec![(PathBuf::from("/fixture"),JobScope::User);17];assert!(paths.validate().is_err());
}
