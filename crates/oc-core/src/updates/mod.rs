//! Host-independent updates. Preparing ends the update operation before returning
//! the installer transaction; the host then drains services, spawns and exits.
mod archive;
mod fs;
pub mod model;
mod source;
mod work;
mod install;
pub use model::{DisabledReason, UpdatePhase, UpdateProgress, UpdateSnapshot};
pub use source::{RELEASES_URL, METADATA_URL};
use crate::{error::{Error, Result, check_cancel, timestamp}, io::BoundedIo};
use source::Candidate;
use fs::merge;
use std::{path::PathBuf, sync::{Arc, Mutex}, time::Duration};
use tokio::{sync::watch, time::Instant};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use work::Stage;

pub const STARTUP_CHECK: Duration = Duration::from_secs(30);
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(120);
const SOURCE: &str = "app-updates";

pub struct UpdateConfig {
    /// Existing, private application profile. No installation target is derived
    /// from this path or from release metadata.
    pub profile: PathBuf,
    pub host_bundle: PathBuf,
    /// The installed oc-data-worker executable used by the supervised HTTP path.
    pub worker: PathBuf,
    pub current_version: String,
    pub development: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind { Check, Download, Prepare }
struct Active { id: u64, kind: Kind, cancel: CancellationToken, accepting_cancel: bool, done: watch::Receiver<Option<Result<UpdateSnapshot>>> }
struct State {
    snapshot: UpdateSnapshot, candidate: Option<Candidate>, stage: Option<Stage>,
    active: Option<Active>, sequence: u64, closed: bool, handing_off: bool,
    scheduler_started: bool, external_failure: Option<Error>,
    pending: Option<Arc<Mutex<Option<oc_installer::PreparedInstallation>>>>,
}
pub struct UpdateController {
    config: UpdateConfig, io: BoundedIo, transport: crate::http::HttpTransport,
    state: Mutex<State>, changed: watch::Sender<UpdateSnapshot>,
    deadline: watch::Sender<Instant>, stop: CancellationToken, tasks: TaskTracker,
    stopping: tokio::sync::Mutex<()>,
}
struct Ticket { id: u64, cancel: CancellationToken, done: watch::Sender<Option<Result<UpdateSnapshot>>> }
enum Admission { New(Ticket), Joined(watch::Receiver<Option<Result<UpdateSnapshot>>>), Unchanged(UpdateSnapshot) }
enum Outcome { Checked(Option<Candidate>), Downloaded, Prepared }
impl UpdateController {
    pub async fn new(config: UpdateConfig, io: BoundedIo) -> Result<Arc<Self>> {
        if config.current_version.len() > 64 || semver::Version::parse(&config.current_version).is_err() { return Err(Error::invalid("current application version")); }
        let disabled = if !cfg!(all(target_os = "macos", target_arch = "aarch64")) { Some(DisabledReason::Platform) }
            else if config.development || cfg!(debug_assertions) { Some(DisabledReason::Development) }
            else {
                match work::verify_host(&io, config.host_bundle.clone(), &io.cancellation()).await {
                    Ok(version) if version == config.current_version => None,
                    Ok(_) => return Err(Error::invalid("running application version differs from signed bundle")),
                    Err(error) if error.is_cancelled() || error.is_cleanup() => return Err(error),
                    Err(_) => Some(DisabledReason::Unsigned),
                }
            };
        Self::construct(config, io, disabled)
    }
    fn construct(config: UpdateConfig, io: BoundedIo, disabled: Option<DisabledReason>) -> Result<Arc<Self>> {
        let snapshot = UpdateSnapshot { revision: 0, phase: if disabled == Some(DisabledReason::Platform) { UpdatePhase::Disabled } else { UpdatePhase::Idle },
            current_version: config.current_version.clone(), available_version: None, checked_at: None,
            progress: None, disabled_reason: disabled, error: None };
        let (changed, _) = watch::channel(snapshot.clone()); let (deadline, _) = watch::channel(Instant::now() + STARTUP_CHECK);
        let transport = crate::http::HttpTransport::new(io.clone(), config.worker.clone());
        Ok(Arc::new(Self { config, stop: io.cancellation(), io, transport, changed, deadline,
            tasks: TaskTracker::new(), stopping: tokio::sync::Mutex::new(()),
            state: Mutex::new(State { snapshot, candidate: None, stage: None, active: None, sequence: 0,
                closed: false, handing_off: false, scheduler_started: false, external_failure: None, pending: None }) }))
    }
    pub fn snapshot(&self) -> UpdateSnapshot { self.state.lock().expect("update state poisoned").snapshot.clone() }
    pub fn subscribe(&self) -> watch::Receiver<UpdateSnapshot> { self.changed.subscribe() }
    fn publish(&self, state: &mut State) {
        state.snapshot.revision = state.snapshot.revision.checked_add(1).expect("update revision exhausted");
        self.changed.send_replace(state.snapshot.clone());
    }
    /// Start one check-only scheduler. Manual checks atomically move its deadline.
    pub fn start(self: &Arc<Self>) {
        let mut state = self.state.lock().expect("update state poisoned");
        if state.closed || state.scheduler_started || state.snapshot.disabled_reason.is_some() { return; }
        state.scheduler_started = true;
        let this = self.clone(); let mut deadline = self.deadline.subscribe();
        self.tasks.spawn(async move {
            loop {
                let next = *deadline.borrow_and_update();
                tokio::select! {
                    _ = this.stop.cancelled() => break,
                    change = deadline.changed() => { if change.is_err() { break; } continue; },
                    _ = tokio::time::sleep_until(next) => (),
                }
                if this.stop.is_cancelled() { break; }
                // Errors are already recorded by the operation supervisor.
                let _result = this.run(Kind::Check, Some(next)).await;
            }
        });
    }
    fn admit(&self, kind: Kind, scheduled: Option<Instant>) -> Result<Admission> {
        let mut state = self.state.lock().expect("update state poisoned");
        if state.closed { return Err(Error::new("OC_UPDATE_CLOSED", "更新控制器已关闭 / Updates are closed")); }
        if state.snapshot.disabled_reason.is_some() {
            if kind != Kind::Check { return Err(Error::new("OC_UPDATE_DISABLED", "当前应用不允许下载或安装更新 / This application cannot download or install updates")); }
            if state.snapshot.disabled_reason == Some(DisabledReason::Platform) || scheduled.is_some() { return Ok(Admission::Unchanged(state.snapshot.clone())); }
        }
        if scheduled.is_some_and(|expected| expected != *self.deadline.borrow()) { return Ok(Admission::Unchanged(state.snapshot.clone())); }
        if kind == Kind::Check { self.deadline.send_replace(Instant::now() + CHECK_INTERVAL); }
        if kind == Kind::Check && state.handing_off { return Ok(Admission::Unchanged(state.snapshot.clone())); }
        if state.handing_off || state.pending.is_some() { return Err(Error::new("OC_UPDATE_HANDOFF", "更新已准备移交或等待清理 / Installation is prepared or awaiting cleanup")); }
        if let Some(active) = &state.active { return Ok(Admission::Joined(active.done.clone())); }
        if kind != Kind::Prepare && state.snapshot.phase == UpdatePhase::Downloaded { return Ok(Admission::Unchanged(state.snapshot.clone())); }
        if kind != Kind::Check && state.candidate.is_none() { return Err(Error::new("OC_UPDATE_UNAVAILABLE", "没有可用更新 / No update is available")); }
        if kind == Kind::Prepare && (state.snapshot.phase != UpdatePhase::Downloaded || state.stage.is_none()) { return Err(Error::new("OC_UPDATE_UNAVAILABLE", "更新尚未下载 / Update has not been downloaded")); }
        state.sequence = state.sequence.checked_add(1).expect("update operation sequence exhausted");
        let id = state.sequence; let cancel = self.stop.child_token(); let (done, receiver) = watch::channel(None);
        state.active = Some(Active { id, kind, cancel: cancel.clone(), accepting_cancel: true, done: receiver }); state.external_failure = None;
        if kind == Kind::Check { state.candidate = None; state.snapshot.available_version = None; }
        state.snapshot.phase = match kind { Kind::Check => UpdatePhase::Checking, Kind::Download => UpdatePhase::Downloading, Kind::Prepare => UpdatePhase::Installing };
        state.snapshot.progress = if kind == Kind::Download { state.candidate.as_ref().map(|candidate| UpdateProgress { percent: 0.0, transferred: 0, total: candidate.asset.size, bytes_per_second: 0.0 }) } else { None };
        state.snapshot.error = None; self.publish(&mut state);
        Ok(Admission::New(Ticket { id, cancel, done }))
    }
    pub async fn check(self: &Arc<Self>) -> Result<UpdateSnapshot> { self.run(Kind::Check, None).await }
    pub async fn download(self: &Arc<Self>) -> Result<UpdateSnapshot> { self.run(Kind::Download, None).await }
    async fn run(self: &Arc<Self>, kind: Kind, scheduled: Option<Instant>) -> Result<UpdateSnapshot> {
        let ticket = match self.admit(kind, scheduled)? {
            Admission::Unchanged(snapshot) => return Ok(snapshot), Admission::Joined(done) => return await_done(done).await,
            Admission::New(ticket) => ticket,
        };
        let receiver = ticket.done.subscribe(); let this = self.clone();
        self.tasks.spawn(async move {
            let duration = if kind == Kind::Check { CHECK_TIMEOUT } else { DOWNLOAD_TIMEOUT };
            let result = deadline(ticket.cancel.clone(), duration, this.operate(ticket.id, kind, &ticket.cancel)).await;
            let result = match result { Ok(outcome) => this.seal(ticket.id).map(|()| outcome), Err(error) => Err(error) };
            let result = if result.is_err() { merge(result, this.clean_stage().await) } else { result };
            let _completion = this.finish(ticket, result);
        });
        await_done(receiver).await
    }
    async fn operate(self: &Arc<Self>, id: u64, kind: Kind, cancel: &CancellationToken) -> Result<Outcome> {
        self.clean_stage().await?; check_cancel(cancel)?;
        match kind {
            Kind::Check => source::fetch(&self.io, &self.transport, self.config.current_version.clone(), cancel).await.map(Outcome::Checked),
            Kind::Download => {
                let candidate = self.state.lock().expect("update state poisoned").candidate.clone().ok_or_else(|| Error::invalid("update candidate"))?;
                let stage = work::create_stage(&self.io, self.config.profile.clone(), cancel).await?;
                self.state.lock().expect("update state poisoned").stage = Some(stage.clone());
                let this = self.clone();
                let progress = Arc::new(move |progress| this.progress(id, progress));
                let result = source::download(&self.io, &self.transport, stage.directory.clone(), candidate, cancel, progress).await;
                result.map(|()| Outcome::Downloaded)
            },
            Kind::Prepare => unreachable!("prepare owns a transaction result"),
        }
    }
    fn seal(&self, id: u64) -> Result<()> {
        let mut state = self.state.lock().expect("update state poisoned");
        if let Some(error) = &state.external_failure { return Err(error.clone()); }
        let active = state.active.as_mut().filter(|active| active.id == id).ok_or_else(|| Error::invalid("update completion generation"))?;
        check_cancel(&active.cancel)?; active.accepting_cancel = false; Ok(())
    }
    fn progress(&self, id: u64, progress: UpdateProgress) {
        let mut state = self.state.lock().expect("update state poisoned");
        if !state.closed && state.external_failure.is_none() && state.active.as_ref().is_some_and(|a| a.id == id && !a.cancel.is_cancelled()) {
            state.snapshot.progress = Some(progress); self.publish(&mut state);
        }
    }
    fn finish(&self, ticket: Ticket, result: Result<Outcome>) -> Result<UpdateSnapshot> {
        let mut state = self.state.lock().expect("update state poisoned");
        if !state.active.as_ref().is_some_and(|a| a.id == ticket.id) { return Err(Error::invalid("stale update completion")); }
        let kind = state.active.as_ref().expect("active ticket").kind;
        let result = match (result, state.external_failure.take()) {
            (result, None) => result, (Ok(_), Some(error)) => Err(error),
            (Err(first), Some(last)) => Err(Error::aggregate(vec![first, last])),
        };
        if kind == Kind::Check { state.snapshot.checked_at = Some(timestamp()); }
        state.snapshot.progress = None;
        let failure = match result {
            Ok(Outcome::Checked(candidate)) => {
                state.snapshot.available_version = candidate.as_ref().map(|candidate| candidate.version.clone());
                state.snapshot.phase = if candidate.is_some() { UpdatePhase::Available } else { UpdatePhase::Idle };
                state.candidate = candidate; state.snapshot.error = None; None
            },
            Ok(Outcome::Downloaded) => { state.snapshot.phase = UpdatePhase::Downloaded; state.snapshot.error = None; None },
            Ok(Outcome::Prepared) => { state.handing_off = true; state.snapshot.phase = UpdatePhase::Installing; None },
            Err(error) if error.is_cancelled() => {
                state.snapshot.phase = if state.candidate.is_some() { UpdatePhase::Available } else { UpdatePhase::Idle };
                state.snapshot.error = None; None
            },
            Err(error) => { state.snapshot.phase = UpdatePhase::Error; state.snapshot.error = Some(public_error(&error)); Some(error) },
        };
        state.active = None; self.publish(&mut state);
        let result = failure.map_or_else(|| Ok(state.snapshot.clone()), Err);
        ticket.done.send_replace(Some(result.clone())); result
    }
    pub async fn cancel(&self) -> Result<UpdateSnapshot> {
        let done = {
            let state = self.state.lock().expect("update state poisoned");
            if state.handing_off { return Err(Error::new("OC_UPDATE_HANDOFF", "安装事务已交给宿主 / Installation transaction is owned by the host")); }
            state.active.as_ref().map(|active| { if active.accepting_cancel { active.cancel.cancel(); } active.done.clone() })
        };
        match done { Some(done) => await_done(done).await, None => Ok(self.snapshot()) }
    }
    /// Report a host drain/spawn/exit failure. Host-owned prepared transactions
    /// must be explicitly abandoned before calling this method.
    pub fn fail(&self, error: Error) {
        let mut state = self.state.lock().expect("update state poisoned");
        if let Some(active) = &state.active { active.cancel.cancel(); state.external_failure = Some(error.clone()); }
        state.handing_off = false; state.snapshot.progress = None;
        state.snapshot.phase = if state.snapshot.disabled_reason == Some(DisabledReason::Platform) { UpdatePhase::Disabled } else { UpdatePhase::Error };
        state.snapshot.error = Some(public_error(&error)); self.publish(&mut state);
    }
    async fn clean_stage(&self) -> Result<()> {
        let stage = self.state.lock().expect("update state poisoned").stage.clone();
        if let Some(stage) = stage {
            work::clean_stage(&self.io, stage).await?;
            self.state.lock().expect("update state poisoned").stage = None;
        }
        Ok(())
    }
    /// Stop admission, await operations and discard only this controller's owned
    /// profile stage. Call before closing BoundedIo admission. Never installs.
    pub async fn stop(&self) -> Result<()> {
        let _guard = self.stopping.lock().await;
        let done = {
            let mut state = self.state.lock().expect("update state poisoned"); state.closed = true; self.stop.cancel();
            state.active.as_ref().map(|active| { active.cancel.cancel(); active.done.clone() })
        };
        let drained = match done { Some(done) => await_done(done).await.map(|_| ()), None => Ok(()) };
        self.tasks.close(); self.tasks.wait().await;
        let result = merge(merge(drained, self.clean_stage().await), self.clean_pending().await);
        if let Err(error) = &result { self.fail(error.clone()); }
        result
    }
}
async fn await_done(mut done: watch::Receiver<Option<Result<UpdateSnapshot>>>) -> Result<UpdateSnapshot> {
    loop {
        if let Some(result) = done.borrow().clone() { return result; }
        done.changed().await.map_err(|_| source::worker_error())?;
    }
}
/// Timeout cancels, then awaits the actual future and all of its cleanup. It
/// never drops a blocking task or releases its lease before that work ends.
async fn deadline<T>(cancel: CancellationToken, duration: Duration, work: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => result,
        _ = tokio::time::sleep(duration) => {
            cancel.cancel(); let result = work.await;
            match result { Err(error) if error.is_cleanup() => Err(error), _ => Err(Error::timeout("app update")) }
        },
    }
}
fn public_error(error: &Error) -> String {
    // Error causes can include host-local paths; only controlled categories cross
    // this DTO. No reqwest URL, raw installer output or filesystem path is exposed.
    if error.is_cleanup() { "更新暂存清理失败 / Update staging cleanup failed".into() }
    else if error.code == "ETIMEDOUT" { "更新操作超时 / Update operation timed out".into() }
    else if error.code == "OC_UPDATE_METADATA_NOT_FOUND" { "尚无可用 Release，或发布仓库不可访问 / No available Release or repository inaccessible".into() }
    else if error.code == "OC_UPDATE_SPACE" { "更新空间不足 / Insufficient update disk space".into() }
    else if error.code == "OC_UPDATE_INTEGRITY" { "更新大小或摘要不符 / Update size or SHA-512 mismatch".into() }
    else if error.code == "OC_UPDATE_ARCHIVE" { "更新ZIP结构或路径不安全 / Unsafe update ZIP structure or path".into() }
    else if error.code == "OC_UPDATE_INSTALLER" { "更新未通过安装信任验证 / Update failed installation trust validation".into() }
    else { "更新操作失败 / Update operation failed".into() }
}

#[cfg(test)]
mod tests;
