use super::*;
use sha2::{Digest, Sha256};

const FIELD_LIMIT: usize = MAX_SCHEDULE_DETAIL_FIELD_BYTES;
const TOTAL_LIMIT: usize = MAX_SCHEDULE_DETAIL_BYTES;
const FIELD_COUNT: usize = MAX_SCHEDULE_DETAIL_FIELDS;

struct LimitedJson { bytes: Vec<u8>, limit: usize }
impl std::io::Write for LimitedJson {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) { return Err(std::io::Error::other("schedule detail JSON limit")); }
        self.bytes.extend_from_slice(bytes); Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

struct Fields { values: Vec<ScheduleDetailField>, bytes: usize }
impl Fields {
    fn new() -> Self { Self { values: Vec::new(), bytes: 0 } }
    fn text(&mut self, key: &str, value: &str) -> Result<()> {
        if value.len() > FIELD_LIMIT { return Err(Error::limit("schedule detail field bytes", FIELD_LIMIT, value.len())); }
        let bytes = self.bytes + key.len() + value.len();
        if bytes > TOTAL_LIMIT { return Err(Error::limit("schedule detail total bytes", TOTAL_LIMIT, bytes)); }
        if self.values.len() >= FIELD_COUNT { return Err(Error::limit("schedule detail fields", FIELD_COUNT, self.values.len()+1)); }
        self.values.push(ScheduleDetailField { key: key.into(), value: value.into() }); self.bytes = bytes; Ok(())
    }
    fn value(&mut self, key: &str, value: Option<&Value>) -> Result<()> {
        let Some(value) = value.filter(|v| !v.is_null()) else { return Ok(()); };
        match value {
            Value::String(text) => self.text(key, text),
            Value::Bool(_) | Value::Number(_) => self.serialized(key, value),
            Value::Array(items) if items.len() <= 256 && items.iter().all(|v| v.is_string() || v.is_number() || v.is_boolean()) => self.serialized(key, value),
            _ => Err(Error::invalid(&format!("schedule detail field {key} type or item limit"))),
        }
    }
    fn object(&mut self, key: &str, value: Option<&Value>, allowed: &[&str]) -> Result<()> {
        let Some(value) = value.filter(|v| !v.is_null()) else { return Ok(()); };
        let objects: Vec<&Value> = match value { Value::Array(items) if items.len() <= 256 => items.iter().collect(), Value::Object(_) => vec![value], _ => return Err(Error::invalid(&format!("schedule detail {key} object"))) };
        let mut selected = Vec::new();
        for object in objects {
            let map = object.as_object().ok_or_else(|| Error::invalid("schedule detail object entry"))?;
            let mut projection = BTreeMap::new();
            for name in allowed {
                if let Some(value) = map.get(*name).filter(|v| !v.is_null()) {
                    if !(value.is_string() || value.is_number() || value.is_boolean() || value.as_array().is_some_and(|items| items.len() <= 256 && items.iter().all(|v| v.is_string() || v.is_number() || v.is_boolean()))) { return Err(Error::invalid("schedule detail object field")); }
                    projection.insert(*name, value);
                }
            }
            selected.push(projection);
        }
        if value.is_array() { self.serialized(key, &selected) } else { self.serialized(key, &selected[0]) }
    }
    fn serialized(&mut self, key: &str, value: &impl serde::Serialize) -> Result<()> {
        let limit = FIELD_LIMIT.min(TOTAL_LIMIT.saturating_sub(self.bytes + key.len()));
        let mut writer = LimitedJson { bytes:Vec::new(), limit };
        serde_json::to_writer(&mut writer,value).map_err(|_| Error::limit("schedule detail serialized bytes",limit,limit+1))?;
        let text = String::from_utf8(writer.bytes).map_err(|_| Error::invalid("schedule detail JSON encoding"))?;
        if self.values.len() >= FIELD_COUNT { return Err(Error::limit("schedule detail fields",FIELD_COUNT,self.values.len()+1)); }
        self.bytes += key.len() + text.len(); self.values.push(ScheduleDetailField { key:key.into(),value:text }); Ok(())
    }
}
fn identity(snapshot: Option<&ScheduleSnapshot>, job: &ScheduledJob) -> Result<()> {
    if snapshot.is_some_and(|s| s.jobs.iter().any(|current| current.id == job.id && current.source == job.source && current.scope == job.scope && current.file == job.file && current.executable == job.executable)) { Ok(()) }
    else { Err(Error::new("OC_SCHEDULE_IDENTITY", "任务已不在当前快照中 / Schedule identity is no longer current")) }
}
type Raw<'a> = &'a serde_json::value::RawValue;
#[derive(Deserialize)]
struct MetadataDocument<'a> {
    #[serde(borrow, deserialize_with = "raw_jobs")] jobs: Vec<Raw<'a>>,
    #[serde(borrow)] timezone: Option<Raw<'a>>,
}
fn raw_jobs<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Vec<Raw<'de>>,D::Error> {
    struct Jobs;
    impl<'de> serde::de::Visitor<'de> for Jobs {
        type Value = Vec<Raw<'de>>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("at most 4096 schedule jobs") }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Self::Value,A::Error> {
            let mut jobs = Vec::new();
            while let Some(job) = seq.next_element::<Raw<'de>>()? {
                if jobs.len() == MAX_JOBS { return Err(serde::de::Error::custom("schedule detail job limit 4096")); }
                jobs.push(job);
            }
            Ok(jobs)
        }
    }
    deserializer.deserialize_seq(Jobs)
}
struct Selected<'a>(BTreeMap<String,Raw<'a>>);
impl<'de> Deserialize<'de> for Selected<'de> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self,D::Error> {
        struct FieldsVisitor;
        impl<'de> serde::de::Visitor<'de> for FieldsVisitor {
            type Value = Selected<'de>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("schedule configuration object") }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> std::result::Result<Self::Value,A::Error> {
                let mut fields = BTreeMap::new();
                while let Some(key) = map.next_key::<String>()? {
                    if matches!(key.as_str(),"prompt"|"command"|"argv"|"cwd"|"workdir"|"model"|"provider"|"script"|"interpreter"|"no_agent"|"monitor_script"|"skills"|"skill"|"not_before"|"enabled"|"state"|"schedule"|"calendar"|"timezone"|"repeat"|"metadata"|"completed"|"times"|"original_schedule"|"Label"|"Program"|"ProgramArguments"|"WorkingDirectory"|"StartInterval"|"RunAtLoad"|"StandardInPath"|"StandardOutPath"|"StandardErrorPath"|"StartCalendarInterval"|"KeepAlive") {
                        if fields.insert(key,map.next_value::<Raw<'de>>()?).is_some() { return Err(serde::de::Error::custom("duplicate schedule detail field")); }
                    } else { map.next_value::<serde::de::IgnoredAny>()?; }
                }
                Ok(Selected(fields))
            }
        }
        deserializer.deserialize_map(FieldsVisitor)
    }
}
fn raw_value(raw: Option<Raw<'_>>) -> Result<Option<Value>> {
    raw.map(|raw| {
        if raw.get().len() > FIELD_LIMIT { return Err(Error::limit("schedule detail input field bytes",FIELD_LIMIT,raw.get().len())); }
        serde_json::from_str(raw.get()).map_err(|_| Error::invalid("schedule detail field JSON"))
    }).transpose()
}
fn metadata_fields(bytes: &[u8], job: &ScheduledJob, hermes: bool, fields: &mut Fields) -> Result<()> {
    if bytes.len() > FILE_BYTES { return Err(Error::limit("schedule detail metadata bytes",FILE_BYTES,bytes.len())); }
    let document: MetadataDocument<'_> = serde_json::from_slice(bytes).map_err(|_| Error::invalid("schedule detail document or 4096 job limit"))?;
    #[derive(Deserialize)] struct Identity { id: String, label: Option<String> }
    let mut selected = None;
    for raw in document.jobs {
        let item: Identity = serde_json::from_str(raw.get()).map_err(|_| Error::invalid("schedule detail job identity"))?;
        validate_text(&item.id,MAX_HERMES_JOB_ID_LENGTH,FIELD_BYTES,"schedule detail metadata ID")?;
        let matches = if hermes { job.id.strip_prefix("hermes-job:") == Some(item.id.as_str()) }
            else { job.id.strip_prefix("launchd:user:").is_some_and(|label| match item.label.as_deref().filter(|s| !s.is_empty()) { Some(value) => label == value, None => label.strip_prefix("com.user.omp-cron.") == Some(item.id.as_str()) }) };
        if matches && selected.replace(raw).is_some() { return Err(Error::new("OC_SCHEDULE_IDENTITY","Schedule configuration identity is ambiguous")); }
    }
    let raw = selected.ok_or_else(|| Error::new("OC_SCHEDULE_IDENTITY","Schedule configuration is missing"))?;
    let item: Selected<'_> = serde_json::from_str(raw.get()).map_err(|_| Error::invalid("schedule detail selected job"))?;
    let get = |name: &str| item.0.get(name).copied();
    for (source,key) in [("prompt","prompt"),("command","command"),("argv","argv"),("cwd","cwd"),("workdir","workdir"),("model","model"),("provider","provider"),("script","script"),("interpreter","interpreter"),("no_agent","noAgent"),("monitor_script","monitorScript"),("skills","skills"),("skill","skill"),("not_before","notBefore"),("enabled","enabled"),("state","state"),("timezone","timezone")] { fields.value(key,raw_value(get(source))?.as_ref())?; }
    fields.object("schedule",raw_value(get("schedule"))?.as_ref(), &["kind","expr","minutes","run_at","display"])?;
    fields.object("calendar",raw_value(get("calendar"))?.as_ref(), &["Minute","Hour","Day","Weekday","Month"])?;
    fields.value("defaultTimezone",raw_value(document.timezone)?.as_ref())?;
    for (name,mappings) in [("repeat",[("completed","repeatCompleted"),("times","repeatTimes")]),("metadata",[("not_before","metadataNotBefore"),("original_schedule","originalSchedule")])] {
        if let Some(raw) = get(name).filter(|raw| raw.get() != "null") {
            let nested: Selected<'_> = serde_json::from_str(raw.get()).map_err(|_| Error::invalid("schedule detail nested object"))?;
            for (source,key) in mappings {
                let value = raw_value(nested.0.get(source).copied())?;
                if key == "originalSchedule" && value.as_ref().is_some_and(Value::is_object) { fields.object(key,value.as_ref(), &["kind","expr","minutes","run_at","display"])?; }
                else { fields.value(key,value.as_ref())?; }
            }
        }
    }
    Ok(())
}
fn plist_fields(raw: &Selected<'_>, fields: &mut Fields) -> Result<()> {
    let get = |name: &str| raw.0.get(name).copied();
    for (source,key) in [("Program","program"),("ProgramArguments","launchdArguments"),("WorkingDirectory","workingDirectory"),("StartInterval","startInterval"),("RunAtLoad","runAtLoad"),("StandardInPath","standardInPath"),("StandardOutPath","standardOutPath"),("StandardErrorPath","standardErrorPath")] { fields.value(key,raw_value(get(source))?.as_ref())?; }
    fields.object("startCalendarInterval",raw_value(get("StartCalendarInterval"))?.as_ref(), &["Minute","Hour","Day","Weekday","Month"])?;
    let keep = raw_value(get("KeepAlive"))?;
    if keep.as_ref().is_some_and(Value::is_object) { fields.object("keepAlive",keep.as_ref(), &["SuccessfulExit","NetworkState","Crashed","AfterInitialDemand"])?; }
    else { fields.value("keepAlive",keep.as_ref())?; }
    Ok(())
}
fn cron_fields(text: &str, job: &ScheduledJob, fields: &mut Fields) -> Result<()> {
    let (jobs, _) = parse_crontab(text)?;
    identity(Some(&ScheduleSnapshot { collected_at: String::new(), jobs, sources: vec![] }),job)?;
    let mut timezone = None;
    for (index, original) in text.split_inclusive('\n').enumerate() {
        let line = original.trim();
        if let Some((name,value)) = line.split_once('=') { if name.trim() == "CRON_TZ" { timezone = Some(value.trim()); } }
        let hash = Sha256::digest(format!("{index}:{line}").as_bytes());
        let id = format!("crontab:{}", hash[..8].iter().map(|b| format!("{b:02x}")).collect::<String>());
        if id != job.id { continue; }
        let count = if line.starts_with('@') { 1 } else { 5 };
        let mut rest = line;
        for _ in 0..count { let end = rest.find(char::is_whitespace).ok_or_else(|| Error::invalid("crontab command"))?; rest = rest[end..].trim_start(); }
        fields.text("schedule", line[..line.len()-rest.len()].trim_end())?;
        fields.text("command",rest)?;
        if let Some(timezone) = timezone { fields.text("timezone",timezone)?; }
        return Ok(());
    }
    Err(Error::new("OC_SCHEDULE_IDENTITY", "crontab entry changed"))
}
impl ScheduleCollector {
    pub async fn schedule_detail(&self, job: &ScheduledJob, cancel: &CancellationToken) -> Result<ScheduleDetail> {
        check_cancel(cancel)?; validate_text(&job.id,MAX_SCHEDULE_ID_LENGTH,1024,"schedule job ID")?;
        let state = tokio::select! { biased; _ = cancel.cancelled() => return Err(Error::cancelled()), state = self.state.lock() => state };
        identity(state.snapshot.as_ref(),job)?;
        let mut fields = Fields::new(); let mut notes = Vec::new();
        let hermes = job.id.starts_with("hermes-job:");
        let omp = matches!(job.source.as_str(), "launchd · OMP 任务" | "OMP 任务 · 未发现 launchd 配置");
        if hermes || omp {
            let path = if hermes { &self.paths.hermes_metadata } else { &self.paths.omp_metadata };
            let file = self.io.read_file("schedule-detail",path,FILE_BYTES,false,cancel).await?;
            fields.text("metadataFile",path.to_str().ok_or_else(|| Error::invalid("metadata path"))?)?;
            metadata_fields(&file.bytes,job,hermes,&mut fields)?;
        }
        if job.id.starts_with("launchd:") {
            if let Some(path) = job.file.as_deref().map(Path::new).filter(|p| *p != self.paths.omp_metadata) {
                if !self.paths.directories.iter().any(|(directory,_)| path.parent() == Some(directory.as_path())) || path.extension().is_none_or(|e| e != "plist") { return Err(Error::invalid("schedule detail plist path")); }
                let before = self.io.metadata("schedule-detail",path,false,cancel).await?;
                if !before.is_file { return Err(Error::invalid("schedule detail regular plist")); }
                if before.identity.size > FILE_BYTES as u64 { return Err(Error::limit("schedule detail file bytes",FILE_BYTES,before.identity.size as usize)); }
                let mut command = CommandSpec::new("/usr/bin/plutil",["-convert","json","-o","-","-"],4*1024*1024,Duration::from_secs(6));
                command.input_file = Some(InputFile { path:path.into(), max_bytes:FILE_BYTES, identity:Some(before.identity.clone()) });
                let output = self.io.command("schedule-detail",command,cancel).await?.success()?;
                let after = self.io.metadata("schedule-detail",path,false,cancel).await?;
                if !after.is_file || before.identity != after.identity { return Err(Error::new("OC_COLLECTION_CHANGED","plist changed during detail read")); }
                let raw: Selected<'_> = serde_json::from_slice(&output.stdout).map_err(|_| Error::invalid("schedule detail plist JSON"))?;
                let label = job.id.splitn(3,':').nth(2);
                if raw_value(raw.0.get("Label").copied())?.as_ref().and_then(Value::as_str) != label { return Err(Error::new("OC_SCHEDULE_IDENTITY","plist Label changed")); }
                fields.text("configurationFile",path.to_str().ok_or_else(|| Error::invalid("plist path"))?)?;
                plist_fields(&raw,&mut fields)?;
            } else if !omp { notes.push("标准目录中没有配置文件，无法读取任务正文 / No configuration file in the standard directories; task content is unavailable".into()); }
        } else if job.id.starts_with("crontab:") {
            let output = self.io.command("schedule-detail",CommandSpec::new("/usr/bin/crontab",["-l"],8*1024*1024,Duration::from_secs(6)),cancel).await?.success()?;
            cron_fields(output.stdout_text()?,job,&mut fields)?;
        } else if !hermes { return Err(Error::new("OC_PLUGIN_CAPABILITY","Schedule details unavailable for this source")); }
        check_cancel(cancel)?; identity(state.snapshot.as_ref(),job)?;
        notes.push("仅显示明确配置的白名单字段；未设置的模型、时区不推断默认值。环境变量和凭据不读取，任务不执行 / Only explicitly configured allowlisted fields are shown; model and timezone defaults are not inferred. Environment variables and credentials are excluded; tasks are never executed".into());
        let detail = ScheduleDetail { job_id:job.id.clone(),collected_at:timestamp(),fields:fields.values,notes };
        detail.validate(&job.id)?; Ok(detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job(id: &str) -> ScheduledJob {
        ScheduledJob { id:id.into(),name:"fixture".into(),source:"Hermes 任务（由调度器执行）".into(),scope:JobScope::User,origin:JobOrigin::Personal,kind:JobKind::Calendar,schedule:"fixture".into(),state:JobState::Waiting,state_reason:None,last_run:None,pid:None,last_exit_code:None,file:None,executable:None,next_run:None }
    }
    fn value<'a>(fields: &'a Fields, key: &str) -> Option<&'a str> { fields.values.iter().find(|f| f.key == key).map(|f| f.value.as_str()) }
    #[test]
    fn metadata_detail_whitelist_preserves_real_fields_without_snapshot_bodies() {
        let raw = json!({"timezone":"Asia/Shanghai","jobs":[{"id":"one","prompt":"private prompt","script":"echo  'a b'","interpreter":"bash","workdir":"/work","no_agent":true,"model":null,"provider":null,"skills":["review"],"repeat":{"completed":1,"times":3},"schedule":{"kind":"cron","expr":"0 8 * * *","token":"secret"},"environment":{"TOKEN":"secret"},"api_key":"secret"}]});
        let bytes = serde_json::to_vec(&raw).unwrap(); let mut fields = Fields::new();
        metadata_fields(&bytes,&job("hermes-job:one"),true,&mut fields).unwrap();
        assert_eq!(value(&fields,"prompt"),Some("private prompt")); assert_eq!(value(&fields,"workdir"),Some("/work"));
        assert_eq!(value(&fields,"script"),Some("echo  'a b'")); assert_eq!(value(&fields,"repeatTimes"),Some("3"));
        assert_eq!(value(&fields,"defaultTimezone"),Some("Asia/Shanghai")); assert!(value(&fields,"model").is_none());
        assert!(!serde_json::to_string(&fields.values).unwrap().contains("secret"));
        let parsed = parse::parse_metadata(&bytes).unwrap(); let mut jobs = Vec::new(); parse::merge_omp(&mut jobs,&parsed,Path::new("/jobs.json")).unwrap();
        let snapshot = serde_json::to_string(&ScheduleSnapshot { collected_at:timestamp(),jobs,sources:vec![] }).unwrap();
        assert!(!snapshot.contains("private prompt")); assert!(!snapshot.contains("a b"));
        assert!(metadata_fields(&bytes,&job("hermes-job:missing"),true,&mut Fields::new()).is_err());
        let duplicate = serde_json::to_vec(&json!({"jobs":[{"id":"one","schedule":{"kind":"interval","minutes":1}},{"id":"one","schedule":{"kind":"interval","minutes":1}}]})).unwrap();
        assert!(metadata_fields(&duplicate,&job("hermes-job:one"),true,&mut Fields::new()).is_err());
    }
    #[test]
    fn detail_limits_reject_instead_of_truncating() {
        let mut fields = Fields::new();
        assert!(fields.text("prompt",&"x".repeat(FIELD_LIMIT+1)).is_err());
        for _ in 0..3 { fields.text("prompt",&"x".repeat(FIELD_LIMIT)).unwrap(); }
        assert!(fields.text("prompt",&"x".repeat(FIELD_LIMIT)).is_err());
        let mut fields = Fields::new(); for _ in 0..FIELD_COUNT { fields.text("state","x").unwrap(); }
        assert!(fields.text("state","x").is_err());
        assert!(metadata_fields(&vec![b' ';FILE_BYTES+1],&job("hermes-job:one"),true,&mut Fields::new()).is_err());
        assert!(Fields::new().value("argv",Some(&json!(vec!["x";257]))).is_err());
    }
    #[test]
    fn plist_and_cron_detail_preserve_arguments_and_exclude_environment() {
        let mut fields = Fields::new();
        let plist = serde_json::to_vec(&json!({"Program":"/bin/sh","ProgramArguments":["sh","-c","printf  '%s'  hello"],"WorkingDirectory":"/tmp","StandardOutPath":"/tmp/out","EnvironmentVariables":{"TOKEN":"secret"}})).unwrap();
        plist_fields(&serde_json::from_slice::<Selected<'_>>(&plist).unwrap(),&mut fields).unwrap();
        assert_eq!(value(&fields,"workingDirectory"),Some("/tmp")); assert!(value(&fields,"launchdArguments").unwrap().contains("printf  '%s'  hello"));
        assert!(!serde_json::to_string(&fields.values).unwrap().contains("secret"));
        let text = "TOKEN=secret\nCRON_TZ=UTC\n0 8 * * * printf  '%s'  hello\n";
        let (jobs,_) = parse_crontab(text).unwrap(); let mut fields = Fields::new(); cron_fields(text,&jobs[0],&mut fields).unwrap();
        assert_eq!(value(&fields,"command"),Some("printf  '%s'  hello")); assert_eq!(value(&fields,"timezone"),Some("UTC"));
        assert!(cron_fields("0 9 * * * changed\n",&jobs[0],&mut Fields::new()).is_err());
    }
    #[tokio::test]
    async fn detail_requires_current_identity_and_honors_cancellation() {
        let dir = tempfile::tempdir().unwrap(); let io = BoundedIo::new(crate::resources::ResourceBudget::default());
        let collector = ScheduleCollector::new(io.clone(),DataWorker::new(io,dir.path().join("worker")),dir.path().into());
        let job = job("hermes-job:one"); let cancel = CancellationToken::new();
        assert_eq!(collector.schedule_detail(&job,&cancel).await.unwrap_err().code,"OC_SCHEDULE_IDENTITY");
        collector.state.lock().await.snapshot = Some(ScheduleSnapshot { collected_at:timestamp(),jobs:vec![job.clone()],sources:vec![] });
        let mut forged = job.clone(); forged.file = Some("/outside/jobs.json".into());
        assert_eq!(collector.schedule_detail(&forged,&cancel).await.unwrap_err().code,"OC_SCHEDULE_IDENTITY");
        std::fs::create_dir_all(dir.path().join(".hermes/cron")).unwrap();
        std::fs::write(&collector.paths.hermes_metadata,br#"{"jobs":[{"id":"one","prompt":"body","schedule":{"kind":"interval","minutes":1}}]}"#).unwrap();
        let result = collector.schedule_detail(&job,&cancel).await.unwrap(); assert!(result.fields.iter().any(|f| f.key == "prompt" && f.value == "body"));
        let serialized = serde_json::to_value(result).unwrap(); assert!(serialized.get("jobId").is_some()); assert!(serialized.get("collectedAt").is_some());
        cancel.cancel(); assert!(collector.schedule_detail(&job,&cancel).await.unwrap_err().is_cancelled());
    }
    #[test]
    fn selected_metadata_skips_other_bodies_and_rejects_ambiguous_labels() {
        let bytes = serde_json::to_vec(&json!({"jobs":[{"id":"other","prompt":"x".repeat(FIELD_LIMIT*2)},{"id":"one","prompt":"selected","metadata":{"private":{"token":"x".repeat(FIELD_LIMIT*2)},"not_before":"later"}}]})).unwrap();
        let document: MetadataDocument<'_> = serde_json::from_slice(&bytes).unwrap();
        let range = bytes.as_ptr() as usize..bytes.as_ptr() as usize+bytes.len();
        assert!(range.contains(&(document.jobs[0].get().as_ptr() as usize)));
        let mut fields = Fields::new(); metadata_fields(&bytes,&job("hermes-job:one"),true,&mut fields).unwrap();
        assert_eq!(value(&fields,"prompt"),Some("selected")); assert_eq!(value(&fields,"metadataNotBefore"),Some("later"));
        let bytes = serde_json::to_vec(&json!({"jobs":[{"id":"a","label":"same"},{"id":"b","label":"same"}]})).unwrap();
        assert_eq!(metadata_fields(&bytes,&job("launchd:user:same"),false,&mut Fields::new()).unwrap_err().code,"OC_SCHEDULE_IDENTITY");
        let bytes = serde_json::to_vec(&json!({"jobs":[{"id":"one","prompt":"x".repeat(FIELD_LIMIT+1)}]})).unwrap();
        assert_eq!(metadata_fields(&bytes,&job("hermes-job:one"),true,&mut Fields::new()).unwrap_err().code,"OC_COLLECTION_LIMIT");
    }
    #[test]
    fn detail_public_contract_rejects_wrong_identity_unknown_keys_and_total_overflow() {
        let mut detail = ScheduleDetail { job_id:"one".into(),collected_at:timestamp(),fields:vec![],notes:vec![] };
        assert!(detail.validate("other").is_err());
        detail.fields.push(ScheduleDetailField { key:"environment".into(),value:"secret".into() }); assert!(detail.validate("one").is_err());
        detail.fields = (0..4).map(|_| ScheduleDetailField { key:"prompt".into(),value:"x".repeat(FIELD_LIMIT) }).collect();
        assert_eq!(detail.validate("one").unwrap_err().code,"OC_COLLECTION_LIMIT");
    }
}
