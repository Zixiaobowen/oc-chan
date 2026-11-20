use std::{ffi::OsString, sync::LazyLock};

use regex::Regex;

use super::{ScheduleCollector, parse};
use crate::{
    error::{Error, Result, check_cancel, validate_text},
    io::CommandSpec,
    model::{HermesScheduleControl, JobScope, ScheduleMutation, ScheduledJob},
};
use tokio_util::sync::CancellationToken;

const SOURCE: &str = "schedule-management";
const JOB_PREFIX: &str = "hermes-job:";
const CLI_OUTPUT: usize = 32 * 1024;
const CLI_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);
static DURATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:(?:every|in) )?([1-9][0-9]{0,8})[mhd]$").expect("Hermes duration pattern")
});

fn provider_id(id: &str) -> bool {
    id.len() == 12 && id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn job_name(job: &parse::MetadataJob) -> &str {
    job.name.as_deref().filter(|name| !name.is_empty()).unwrap_or(&job.id)
}

pub(super) fn control(job: &parse::MetadataJob) -> Option<HermesScheduleControl> {
    use HermesScheduleControl::*;
    if !provider_id(&job.id) { return None; }
    if matches!(job.state.as_deref(), Some("completed" | "error")) { return Some(Inactive); }
    if job.state.as_deref() == Some("paused") || job.paused_at.as_ref().is_some_and(|at| !at.is_empty()) || job.enabled == Some(false) {
        return Some(Paused);
    }
    Some(Active)
}

fn validate_creation(name: &str, schedule: &str, prompt: &str) -> Result<()> {
    validate_text(name, 160, 640, "Hermes task name")?;
    validate_text(schedule, 256, 1024, "Hermes task schedule")?;
    if provider_id(&name.to_ascii_lowercase()) { return Err(Error::invalid("Hermes task name must not look like a task ID")); }
    if !DURATION.is_match(schedule) && chrono::DateTime::parse_from_rfc3339(schedule).is_err() && parse::describe_cron(schedule).is_err() {
        return Err(Error::new("OC_HERMES_SCHEDULE", "请输入五字段 cron、间隔（如 every 2h）、单次延时（如 in 30m）或带时区的 ISO 8601 时间 / Enter a five-field cron expression, an interval, a one-time delay or an ISO 8601 time with time zone"));
    }
    if prompt.is_empty() || prompt.len() > 16000 || prompt.encode_utf16().count() > 4000
        || prompt.chars().any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t')) {
        return Err(Error::invalid("Hermes task instruction"));
    }
    Ok(())
}

fn uncertain(cause: Error) -> Error {
    let mut error = Error::new("OC_HERMES_WRITE_UNCONFIRMED", format!(
        "Hermes 写入结果未确认（{}），请刷新后核对任务再重试 / Hermes write unconfirmed ({}); refresh and check the task before retrying",
        cause.code, cause.code,
    ));
    error.causes.push(cause);
    error
}

fn changed() -> Error {
    Error::new("OC_SCHEDULE_IDENTITY", "Hermes 任务已变化，请刷新后重新选择 / Hermes task changed; refresh and select it again")
}

fn created_id(output: &str) -> Result<&str> {
    let mut receipts = output.lines().filter_map(|line| line.strip_prefix("Created job: "));
    let id = receipts.next().filter(|id| provider_id(id)).ok_or_else(|| Error::invalid("Hermes creation receipt"))?;
    if receipts.next().is_some() { return Err(Error::invalid("Hermes creation receipt")); }
    Ok(id)
}

impl ScheduleCollector {
    pub(crate) async fn manage_schedule(&self, change: ScheduleMutation, selected: Option<ScheduledJob>, cancel: &CancellationToken) -> Result<String> {
        use HermesScheduleControl::*;
        check_cancel(cancel)?;
        let root = self.paths.home.join(".hermes");
        if self.paths.hermes_metadata != root.join("cron/jobs.json") {
            return Err(Error::invalid("Hermes default profile path"));
        }
        let (jobs, bytes) = self.hermes_write_metadata(cancel).await?;
        let mut args: Vec<OsString> = ["--profile", "default", "cron"].into_iter().map(Into::into).collect();
        let (id, expected) = match change {
            ScheduleMutation::Create { name, schedule, prompt, paused } => {
                let (name, schedule, prompt) = (name.trim(), schedule.trim(), prompt.trim());
                validate_creation(name, schedule, prompt)?;
                if jobs.len() >= super::runtime::MAX_HERMES_JOBS {
                    return Err(Error::limit("Hermes jobs", super::runtime::MAX_HERMES_JOBS, jobs.len() + 1));
                }
                // Hermes formats its JSON on write. Reserve space for the new record and escaping.
                let projected = bytes + 4096 + 6 * (name.len() + schedule.len() + prompt.len());
                if projected > parse::FILE_BYTES {
                    return Err(Error::limit("Hermes task metadata", parse::FILE_BYTES, projected));
                }
                args.extend(["create".into(), format!("--name={name}").into(), "--deliver=local".into()]);
                if paused { args.push("--paused".into()); }
                args.extend(["--".into(), schedule.into(), prompt.into()]);
                (None, Some(if paused { Paused } else { Active }))
            }
            change => {
                let job = selected.ok_or_else(changed)?;
                let id = job.id.strip_prefix(JOB_PREFIX).filter(|id| provider_id(id)).ok_or_else(read_only)?;
                if job.scope != JobScope::User || job.hermes_control.is_none()
                    || job.file.as_deref().map(std::path::Path::new) != Some(self.paths.hermes_metadata.as_path()) {
                    return Err(read_only());
                }
                let mut matching = jobs.iter().filter(|item| item.id == id);
                let current = matching.next().ok_or_else(changed)?;
                if matching.next().is_some() || jobs.iter().any(|item| item.id != id && job_name(item).eq_ignore_ascii_case(id))
                    || job.name != job_name(current) || job.schedule != parse::metadata_schedule(current)?.1 {
                    return Err(changed());
                }
                let (verb, expected) = match change {
                    ScheduleMutation::Pause { .. } if control(current) == Some(Active) => ("pause", Some(Paused)),
                    ScheduleMutation::Resume { .. } if control(current) == Some(Paused) => ("resume", Some(Active)),
                    ScheduleMutation::Delete { .. } => ("remove", None),
                    _ => return Err(changed()),
                };
                args.extend([verb.into(), id.into()]);
                (Some(id.to_owned()), expected)
            }
        };
        // Use the installed user launcher, never a renderer-supplied command or a PATH search.
        let launcher = self.paths.home.join(".local/bin/hermes");
        let metadata = self.io.metadata(SOURCE, &launcher, false, cancel).await.map_err(|error| {
            if error.code == "ENOENT" { Error::new("OC_HERMES_UNAVAILABLE", "未找到 ~/.local/bin/hermes，请确认 Hermes 已安装 / ~/.local/bin/hermes was not found; check the Hermes installation") } else { error }
        })?;
        if !metadata.is_file || ![0, self.paths.uid].contains(&metadata.identity.uid)
            || metadata.identity.mode & 0o022 != 0 || metadata.identity.mode & 0o111 == 0 {
            return Err(Error::new("OC_HERMES_UNAVAILABLE", "Hermes 启动器的权限或归属不符合要求 / Hermes launcher has invalid permissions or ownership"));
        }
        check_cancel(cancel)?;
        let mut command = CommandSpec::new(launcher, args, CLI_OUTPUT, CLI_TIMEOUT);
        command.env.extend([
            ("HOME".into(), self.paths.home.as_os_str().to_owned()),
            ("HERMES_HOME".into(), root.into_os_string()),
            ("NO_COLOR".into(), "1".into()),
            ("TERM".into(), "dumb".into()),
        ]);
        let output = self.io.command(SOURCE, command, cancel).await.map_err(uncertain)?;
        if output.exit_code != 0 { return Err(uncertain(output.success().unwrap_err())); }
        let id = match id {
            Some(id) => id,
            None => created_id(output.stdout_text().map_err(uncertain)?).map_err(uncertain)?.to_owned(),
        };
        drop(output);
        let (verified, _) = self.hermes_write_metadata(cancel).await.map_err(uncertain)?;
        let mut matching = verified.iter().filter(|item| item.id == id);
        if matching.next().and_then(control) != expected || matching.next().is_some() {
            return Err(uncertain(Error::invalid("Hermes persisted state")));
        }
        Ok(format!("{JOB_PREFIX}{id}"))
    }

    async fn hermes_write_metadata(&self, cancel: &CancellationToken) -> Result<(Vec<parse::MetadataJob>, usize)> {
        match self.io.read_file(SOURCE, &self.paths.hermes_metadata, parse::FILE_BYTES, false, cancel).await {
            Ok(file) => Ok((parse::parse_metadata(&file.bytes)?, file.bytes.len())),
            Err(error) if error.code == "ENOENT" => Ok((Vec::new(), 0)),
            Err(error) => Err(error),
        }
    }
}

fn read_only() -> Error {
    Error::new("OC_SCHEDULE_READ_ONLY", "该任务来源只读 / This task source is read-only")
}
