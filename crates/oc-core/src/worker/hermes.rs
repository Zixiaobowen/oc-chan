//! Synchronous SQLite is restricted to the disposable data-worker process.
use std::{fs::OpenOptions, os::{fd::IntoRawFd, unix::fs::{MetadataExt, OpenOptionsExt}}, path::Path, sync::LazyLock, time::{Duration, Instant}};
use chrono::{DateTime, Datelike, Utc};
use regex::Regex;
use rusqlite::{Connection, OpenFlags, Row, functions::FunctionFlags, params};
use serde::Deserialize;
use serde_json::{Value, json};
use crate::{error::{Error, Result, validate_text}, model::{DeliveryStatus, ExecutionStatus, ScheduleExecution, HISTORY_PAGE_SIZE, MAX_HISTORY_OFFSET}};

static INSTANT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$").expect("constant timestamp pattern"));

/// UTC seconds and nanoseconds, never rounded to milliseconds or ordered by the input offset.
pub(crate) fn instant(value: &str) -> Result<DateTime<Utc>> {
    field(value, 64)?;
    if !INSTANT.is_match(value) { return Err(Error::invalid("Hermes timestamp")); }
    let parsed = DateTime::parse_from_rfc3339(value).map_err(|_| Error::invalid("Hermes timestamp"))?.with_timezone(&Utc);
    // Chrono permits leap seconds; Hermes' original metadata contract does not.
    if parsed.timestamp_subsec_nanos() >= 1_000_000_000 || !(0..=9999).contains(&parsed.year()) {
        return Err(Error::invalid("Hermes timestamp"));
    }
    Ok(parsed)
}
fn field(value: &str, maximum: usize) -> Result<()> {
    if value.is_empty() || value.encode_utf16().count() > maximum || value.contains('\0') {
        return Err(Error::invalid("Hermes metadata"));
    }
    Ok(())
}
fn sql_error(error: rusqlite::Error) -> Error {
    let code = error.sqlite_error_code();
    let (name, message) = match code {
        Some(rusqlite::ErrorCode::CannotOpen) => ("OC_HERMES_OPEN", "无法打开 Hermes 执行数据库 / Cannot open Hermes database"),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => ("OC_HERMES_LOCKED", "Hermes 数据库被锁定 / Hermes database locked"),
        Some(rusqlite::ErrorCode::OutOfMemory | rusqlite::ErrorCode::TooBig) => ("OC_HERMES_MEMORY", "Hermes 超过 SQLite 内存预算 / Hermes SQLite memory budget exceeded"),
        Some(rusqlite::ErrorCode::OperationInterrupted) => ("ETIMEDOUT", "Hermes 查询超过 3 秒 / Hermes query exceeded 3 seconds"),
        _ => ("OC_HERMES_METADATA", "Hermes 数据库结构或字段无效 / Invalid Hermes schema or metadata"),
    };
    Error::new(name, message)
}
fn configure(db: &mut Connection) -> Result<()> {
    db.execute_batch("PRAGMA busy_timeout=500; PRAGMA hard_heap_limit=8388608; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;").map_err(sql_error)?;
    let deadline = Instant::now() + Duration::from_secs(3);
    db.progress_handler(1000, Some(move || Instant::now() >= deadline)).map_err(sql_error)?;
    register_instant(db)
}
fn register_instant(db: &Connection) -> Result<()> {
    db.create_scalar_function("hermes_instant", 1, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |context| {
        let value = context.get::<String>(0)?;
        let time = instant(&value).map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))?;
        Ok(format!("{}.{:09}", time.format("%Y-%m-%dT%H:%M:%S"), time.timestamp_subsec_nanos()))
    }).map_err(sql_error)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryInput { job_id: String, offset: usize }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeInput { job_ids: Vec<String> }

pub fn execute(operation: &str, database: &Path, input: Value) -> Result<Value> {
    // Validate admission before touching any file, including an absent database.
    match operation {
        "hermes-history" => { let request: HistoryInput = serde_json::from_value(input.clone()).map_err(|_| Error::invalid("Hermes history request"))?; validate_history(&request)?; }
        "hermes-runtime" => { let request: RuntimeInput = serde_json::from_value(input.clone()).map_err(|_| Error::invalid("Hermes runtime request"))?; validate_ids(&request.job_ids)?; }
        _ => return Err(Error::invalid("Hermes worker operation")),
    }
    let guard = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(database).map_err(|e| Error::io("open Hermes database", e))?;
    let outcome = (|| {
        let before = guard.metadata().map_err(|e| Error::io("stat Hermes database", e))?;
        if !before.is_file() { return Err(Error::invalid("Hermes database must be a regular file")); }
        let identity = (before.dev(), before.ino());
        let mut db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(sql_error)?;
        let result = (|| {
            configure(&mut db)?;
            verify_identity(database, identity)?;
            db.execute_batch("BEGIN;").map_err(sql_error)?;
            let value = match operation {
                "hermes-history" => read_history(&db, serde_json::from_value(input).map_err(|_| Error::invalid("history request"))?)?,
                "hermes-runtime" => read_runtime(&db, serde_json::from_value(input).map_err(|_| Error::invalid("runtime request"))?)?,
                _ => unreachable!(),
            };
            db.execute_batch("COMMIT;").map_err(sql_error)?;
            verify_identity(database, identity)?;
            let limit = if operation == "hermes-history" { 128 * 1024 } else { 4 * 1024 * 1024 };
            let bytes = serde_json::to_vec(&value).map_err(|_| Error::invalid("Hermes output"))?.len();
            if bytes > limit { return Err(Error::limit("Hermes output bytes", limit, bytes)); }
            Ok(value)
        })();
        let closed = db.close().map_err(|(_, error)| Error::cleanup("Hermes SQLite", sql_error(error)));
        crate::io::merge_close(result, closed)
    })();
    let fd = guard.into_raw_fd();
    let closed = if unsafe { libc::close(fd) } == 0 { Ok(()) } else { Err(Error::cleanup("Hermes database guard", Error::io("close", std::io::Error::last_os_error()))) };
    crate::io::merge_close(outcome, closed)
}
fn verify_identity(path: &Path, expected: (u64, u64)) -> Result<()> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| Error::io("stat Hermes database", e))?;
    if !meta.is_file() || (meta.dev(), meta.ino()) != expected { return Err(Error::new("OC_COLLECTION_CHANGED", "Hermes 数据库身份已改变 / Hermes database identity changed")); }
    Ok(())
}
fn validate_history(input: &HistoryInput) -> Result<()> {
    validate_text(&input.job_id, 128, 512, "Hermes job ID")?;
    if input.offset > MAX_HISTORY_OFFSET || input.offset % HISTORY_PAGE_SIZE != 0 { return Err(Error::invalid("history offset")); }
    Ok(())
}
fn validate_ids(ids: &[String]) -> Result<()> {
    if ids.len() > 256 { return Err(Error::limit("Hermes jobs", 256, ids.len())); }
    let mut seen = std::collections::HashSet::new();
    for id in ids { validate_text(id, 128, 512, "Hermes job ID")?; if !seen.insert(id) { return Err(Error::invalid("duplicate Hermes job ID")); } }
    Ok(())
}
// substr bounds transfer, while the original-column predicates detect NUL, wrong storage class,
// and oversized originals (including suffixes hidden after a NUL).
fn projection(fields: &[(&str, usize, bool)]) -> String {
    let selected = fields.iter().map(|(name, max, _)| format!("substr({name},1,{})", max + 1)).collect::<Vec<_>>().join(",");
    let invalid = fields.iter().map(|(name, max, optional)| {
        let valid = format!("(typeof({name})='text' AND instr({name},char(0))=0 AND length(CAST({name} AS BLOB))<={})", max * 4);
        if *optional { format!("NOT ({name} IS NULL OR {valid})") } else { format!("NOT {valid}") }
    }).collect::<Vec<_>>().join(" OR ");
    format!("{selected}, ({invalid}) AS invalid_metadata")
}
fn text(row: &Row<'_>, column: usize, max: usize) -> Result<String> {
    let value: String = row.get(column).map_err(sql_error)?; field(&value, max)?; Ok(value)
}
fn optional_text(row: &Row<'_>, column: usize, max: usize) -> Result<Option<String>> {
    let value: Option<String> = row.get(column).map_err(sql_error)?;
    if let Some(value) = &value { field(value, max)?; } Ok(value)
}
fn read_history(db: &Connection, input: HistoryInput) -> Result<Value> {
    validate_history(&input)?;
    let columns = projection(&[("id",128,false),("job_id",128,false),("status",32,false),("claimed_at",64,false),("started_at",64,true),("finished_at",64,true),("delivery_outcome",32,true)]);
    let sql = format!("SELECT {columns} FROM executions WHERE job_id=? ORDER BY hermes_instant(substr(claimed_at,1,65)) DESC, substr(id,1,129) COLLATE BINARY DESC LIMIT ? OFFSET ?");
    let mut statement = db.prepare(&sql).map_err(sql_error)?;
    let mut rows = statement.query(params![input.job_id, HISTORY_PAGE_SIZE + 1, input.offset]).map_err(sql_error)?;
    let mut entries = Vec::with_capacity(HISTORY_PAGE_SIZE + 1);
    while let Some(row) = rows.next().map_err(sql_error)? {
        if row.get::<_, bool>(7).map_err(sql_error)? { return Err(Error::invalid("Hermes metadata")); }
        let id = text(row,0,128)?;
        if text(row,1,128)? != input.job_id { return Err(Error::invalid("Hermes history job")); }
        let status = text(row,2,32)?;
        let claimed_at = text(row,3,64)?;
        let started_at = optional_text(row,4,64)?;
        let finished_at = optional_text(row,5,64)?;
        let delivery = optional_text(row,6,32)?;
        let claimed = instant(&claimed_at)?;
        let started = started_at.as_deref().map(instant).transpose()?;
        let finished = finished_at.as_deref().map(instant).transpose()?;
        if started.is_some_and(|at| at < claimed) || finished.is_some_and(|at| at < started.unwrap_or(claimed)) { return Err(Error::invalid("Hermes execution time order")); }
        entries.push(ScheduleExecution { id, claimed_at, started_at, finished_at,
            status: match status.as_str() { "completed" => ExecutionStatus::Succeeded, "claimed" => ExecutionStatus::Claimed, "running" => ExecutionStatus::Running, "failed" => ExecutionStatus::Failed, _ => ExecutionStatus::Unknown },
            delivery: delivery.map(|value| match value.as_str() { "delivered" => DeliveryStatus::Delivered, "failed" => DeliveryStatus::Failed, "suppressed" | "suppressed_acked" => DeliveryStatus::Skipped, _ => DeliveryStatus::Unknown }),
        });
    }
    let has_more = entries.len() > HISTORY_PAGE_SIZE; entries.truncate(HISTORY_PAGE_SIZE);
    Ok(json!({"entries":entries,"hasMore":has_more}))
}
fn read_runtime(db: &Connection, input: RuntimeInput) -> Result<Value> {
    validate_ids(&input.job_ids)?;
    let columns = projection(&[("id",128,false),("job_id",128,false),("status",32,false),("claimed_at",64,false),("finished_at",64,true)]);
    let sql = format!("SELECT {columns}, pid, process_started_at FROM executions WHERE job_id=? ORDER BY hermes_instant(substr(claimed_at,1,65)) DESC, substr(claimed_at,1,65) COLLATE BINARY DESC, substr(id,1,129) COLLATE BINARY DESC LIMIT 1");
    let mut statement = db.prepare(&sql).map_err(sql_error)?;
    let mut entries = Vec::with_capacity(input.job_ids.len());
    for job_id in input.job_ids {
        let mut rows = statement.query(params![job_id]).map_err(sql_error)?;
        if let Some(row) = rows.next().map_err(sql_error)? {
            if row.get::<_, bool>(5).map_err(sql_error)? { return Err(Error::invalid("Hermes runtime metadata")); }
            let id = text(row,0,128)?;
            if text(row,1,128)? != job_id { return Err(Error::invalid("Hermes runtime job")); }
            let status = text(row,2,32)?;
            if !["claimed","running","completed","failed","unknown"].contains(&status.as_str()) { return Err(Error::invalid("Hermes execution status")); }
            let claimed_at = text(row,3,64)?; let claimed = instant(&claimed_at)?;
            let finished_at = optional_text(row,4,64)?;
            if finished_at.as_deref().map(instant).transpose()?.is_some_and(|at| at < claimed) { return Err(Error::invalid("Hermes runtime time order")); }
            let pid: i64 = row.get(6).map_err(sql_error)?;
            let process_started_at: Option<i64> = row.get(7).map_err(sql_error)?;
            if !(1..=i32::MAX as i64).contains(&pid) || process_started_at.is_some_and(|value| !(1..=9_007_199_254_740_991).contains(&value)) { return Err(Error::invalid("Hermes process evidence")); }
            entries.push(json!({"id":id,"jobId":job_id,"status":status,"pid":pid,"processStartedAt":process_started_at,"claimedAt":claimed_at,"finishedAt":finished_at}));
        }
    }
    Ok(json!({"entries":entries}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap(); register_instant(&db).unwrap();
        db.execute_batch("CREATE TABLE executions(id TEXT,job_id TEXT,status TEXT,pid INTEGER,process_started_at INTEGER,claimed_at TEXT,started_at TEXT,finished_at TEXT,delivery_outcome TEXT,prompt TEXT);").unwrap(); db
    }
    fn insert(db: &Connection, id: &str, at: &str, status: &str, delivery: Option<&str>) {
        db.execute("INSERT INTO executions VALUES (?,'daily',?,42,12300,?,NULL,NULL,?,'private body')",params![id,status,at,delivery]).unwrap();
    }
    fn history(db: &Connection, offset: usize) -> Result<Value> { read_history(db,HistoryInput{job_id:"daily".into(),offset}) }
    #[test] fn instants_reject_invalid_calendar_and_preserve_nanos() {
        for value in ["2026-02-30T00:00:00Z","2026-01-01T00:00:00","2026-01-01T00:00:60Z","2026-01-01T00:00:00+24:00","2026-01-01T00:00:00.1234567890Z"] { assert!(instant(value).is_err(),"{value}"); }
        assert!(instant("2026-01-01T00:00:00.000000002Z").unwrap() > instant("2026-01-01T01:00:00.000000001+01:00").unwrap());
    }
    #[test] fn pages_order_instants_then_binary_ids_and_never_expose_payloads() {
        let db=database();
        for n in 0..27 { insert(&db,&format!("{n:02}"),"2026-01-01T00:00:00.000000001Z","completed",None); }
        insert(&db,"latest","2026-01-01T01:00:00.000000002+01:00","completed",Some("failed"));
        let first=history(&db,0).unwrap(); assert_eq!(first["entries"].as_array().unwrap().len(),25); assert_eq!(first["hasMore"],true); assert_eq!(first["entries"][0]["id"],"latest"); assert_eq!(first["entries"][1]["id"],"26");
        assert_eq!(first["entries"][0]["status"],"succeeded"); assert_eq!(first["entries"][0]["delivery"],"failed"); assert!(!first.to_string().contains("private"));
        let second=history(&db,25).unwrap(); assert_eq!(second["entries"].as_array().unwrap().len(),3); assert_eq!(second["hasMore"],false);
    }
    #[test] fn unknown_status_and_suppressed_delivery_are_not_success() {
        let db=database(); insert(&db,"x","2026-01-01T00:00:00Z","new-status",Some("suppressed_acked"));
        let value=history(&db,0).unwrap(); assert_eq!(value["entries"][0]["status"],"unknown"); assert_eq!(value["entries"][0]["delivery"],"skipped"); assert!(value["entries"][0].get("startedAt").is_none());
    }
    #[test] fn metadata_nuls_truncation_unicode_and_reversed_times_reject() {
        for id in ["a\0hidden".to_owned(),"a".repeat(129),"😀".repeat(65)] {
            let db=database(); insert(&db,&id,"2026-01-01T00:00:00Z","completed",None); assert!(history(&db,0).is_err());
        }
        let db=database(); insert(&db,"valid","2026-01-01T00:00:00.000000002Z","completed",None);
        db.execute("UPDATE executions SET started_at='2026-01-01T00:00:00.000000001Z'",[]).unwrap(); assert!(history(&db,0).is_err());
        db.execute("UPDATE executions SET started_at=NULL, finished_at='2025-12-31T23:59:59Z'",[]).unwrap(); assert!(history(&db,0).is_err());
    }
    #[test] fn valid_empty_differs_from_missing_schema_and_invalid_offsets() {
        assert_eq!(history(&database(),0).unwrap()["entries"],json!([]));
        assert!(history(&Connection::open_in_memory().unwrap(),0).is_err());
        for offset in [1,24,100001,100025] { assert!(history(&database(),offset).is_err()); }
        assert!(history(&database(),100000).is_ok());
    }
    #[test] fn bound_job_ids_and_latest_queries_ignore_other_jobs() {
        let db=database(); insert(&db,"old","2026-01-01T00:00:00Z","failed",None); insert(&db,"new","2026-01-01T02:00:00+01:00","completed",None);
        let value=read_runtime(&db,RuntimeInput{job_ids:vec!["daily".into(),"' OR 1=1 --".into()]}).unwrap(); assert_eq!(value["entries"].as_array().unwrap().len(),1); assert_eq!(value["entries"][0]["id"],"new");
        assert!(validate_ids(&vec!["x".into();257]).is_err());
    }
    #[test] fn missing_database_never_becomes_empty_history_or_creates_a_file() {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("missing.db");
        let error=execute("hermes-history",&path,json!({"jobId":"daily","offset":0})).unwrap_err();
        assert_eq!(error.code,"ENOENT");assert!(!path.exists());
    }
    #[test] fn nonregular_and_symlink_database_paths_are_rejected_before_sqlite() {
        let directory=tempfile::tempdir().unwrap();let fifo=directory.path().join("fifo");
        let name=std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();assert_eq!(unsafe{libc::mkfifo(name.as_ptr(),0o600)},0);
        assert!(execute("hermes-history",&fifo,json!({"jobId":"daily","offset":0})).is_err());
        assert!(execute("hermes-history",directory.path(),json!({"jobId":"daily","offset":0})).is_err());
        let link=directory.path().join("link");std::os::unix::fs::symlink(&fifo,&link).unwrap();
        assert_eq!(execute("hermes-history",&link,json!({"jobId":"daily","offset":0})).unwrap_err().code,"ELOOP");
    }
    #[test] fn locked_database_is_explicit_failure_and_reusable_after_unlock() {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("history.db");
        let writer=Connection::open(&path).unwrap();
        writer.execute_batch("CREATE TABLE executions(id TEXT,job_id TEXT,status TEXT,claimed_at TEXT,started_at TEXT,finished_at TEXT,delivery_outcome TEXT);").unwrap();
        let reader=Connection::open_with_flags(&path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();register_instant(&reader).unwrap();reader.busy_timeout(Duration::from_millis(10)).unwrap();
        writer.execute_batch("BEGIN EXCLUSIVE;").unwrap();
        assert_eq!(history(&reader,0).unwrap_err().code,"OC_HERMES_LOCKED");
        writer.execute_batch("ROLLBACK;").unwrap();assert_eq!(history(&reader,0).unwrap()["entries"],json!([]));
        assert!(reader.execute("INSERT INTO executions(id) VALUES ('write-forbidden')",[]).is_err());
    }
    #[test] fn bounded_columns_reject_hidden_nul_suffixes_and_storage_class_changes() {
        for (column,value) in [("status",format!("completed\0{}","x".repeat(128))),("delivery_outcome","d".repeat(33)),("claimed_at",format!("2026-01-01T00:00:00Z\0{}","x".repeat(128)))] {
            let db=database();insert(&db,"id","2026-01-01T00:00:00Z","completed",None);
            db.execute(&format!("UPDATE executions SET {column}=?"),params![value]).unwrap();assert!(history(&db,0).is_err());
        }
        let db=database();insert(&db,"id","2026-01-01T00:00:00Z","completed",None);
        db.execute("UPDATE executions SET status=CAST('completed' AS BLOB)",[]).unwrap();assert!(history(&db,0).is_err());
    }
    #[test] fn older_history_volume_does_not_change_latest_execution() {
        let db=database();
        db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4097) INSERT INTO executions(id,job_id,status,pid,process_started_at,claimed_at) SELECT 'old-'||x,'daily','failed',42,12300,'2025-01-01T00:00:00Z' FROM n;").unwrap();
        insert(&db,"latest","2026-01-01T00:00:00.000000002Z","completed",None);
        insert(&db,"nearby","2026-01-01T01:00:00.000000001+01:00","failed",None);
        let value=read_runtime(&db,RuntimeInput{job_ids:vec!["daily".into()]}).unwrap();assert_eq!(value["entries"][0]["id"],"latest");
        db.execute("UPDATE executions SET claimed_at='invalid timestamp' WHERE id='old-1'",[]).unwrap();
        assert!(read_runtime(&db,RuntimeInput{job_ids:vec!["daily".into()]}).is_err());
    }
    #[test] fn query_progress_interrupt_is_a_visible_timeout() {
        let mut db=database();insert(&db,"id","2026-01-01T00:00:00Z","completed",None);
        db.progress_handler(1,Some(||true)).unwrap();assert_eq!(history(&db,0).unwrap_err().code,"ETIMEDOUT");
        db.progress_handler(0,None::<fn()->bool>).unwrap();assert!(history(&db,0).is_ok());
    }
}
