use super::{archive, fs::{Dir, merge}, source::{Candidate, worker_error}, SOURCE};
use crate::{error::{Error, Result, check_cancel}, io::BoundedIo, resources::Request};
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(super) struct Stage { pub root: Arc<Dir>, pub directory: Arc<Dir>, pub name: String }
fn native_request() -> Request {
    // Native trust/prepare runs fixed system commands plus bounded inventories.
    // Reserve both pools atomically; never nest an IO lease inside this one.
    Request::Command { stdout_bytes: 128 * 1024, stderr_bytes: 128 * 1024, input_bytes: Some(archive::MEMORY_BYTES) }
}
pub(super) async fn verify_host(io: &BoundedIo, path: PathBuf, cancel: &CancellationToken) -> Result<String> {
    io.supervise(SOURCE, native_request(), cancel, move |cancel| async move {
        tokio::task::spawn_blocking(move || {
            check_cancel(&cancel)?;
            let result = oc_installer::verify_host(&path).map_err(installer_error);
            // Native commands have their own absolute deadline and are drained
            // inside the installer. Cancellation never detaches the blocking task.
            match result { Err(error) if error.is_cleanup() => Err(error), result => { check_cancel(&cancel)?; result } }
        }).await.map_err(|_| worker_error())?
    }).await
}
pub(super) async fn create_stage(io: &BoundedIo, profile: PathBuf, cancel: &CancellationToken) -> Result<Stage> {
    io.with_file_budget(SOURCE, 64 * 1024, cancel, move |cancel| async move {
        tokio::task::spawn_blocking(move || {
            check_cancel(&cancel)?; let root = Arc::new(Dir::profile(&profile)?);
            let name = uuid::Uuid::new_v4().to_string(); root.mkdir(&name, 0o700)?;
            let result = (|| {
                root.sync()?;
                let directory = Arc::new(root.child(&name)?); directory.private(true)?; directory.verify_path()?;
                check_cancel(&cancel)?; Ok(Stage { root: root.clone(), directory, name: name.clone() })
            })();
            match result { Ok(stage) => Ok(stage), Err(error) => merge(Err(error), root.remove_tree(&name).map_err(|e| Error::cleanup("update stage creation", e))) }
        }).await.map_err(|_| worker_error())?
    }).await
}
pub(super) async fn clean_stage(io: &BoundedIo, stage: Stage) -> Result<()> {
    // Independent cancellation: a cancelled download still owes actual cleanup.
    // The work intentionally ignores its cancellation token once admitted.
    io.with_file_budget(SOURCE, archive::MEMORY_BYTES, &CancellationToken::new(), move |_| async move {
        tokio::task::spawn_blocking(move || {
            stage.directory.verify_path()?; stage.root.verify_path()?;
            stage.root.remove_tree(&stage.name)
        }).await.map_err(|_| worker_error())?
    }).await.map_err(|error| Error::cleanup("owned update staging", error))
}
pub(super) async fn prepare(io: &BoundedIo, stage: Stage, candidate: Candidate, target: PathBuf, cancel: &CancellationToken) -> Result<oc_installer::PreparedInstallation> {
    let extraction_stage = stage.clone(); let extraction_candidate = candidate.clone();
    let bundle = io.with_file_budget(SOURCE, archive::MEMORY_BYTES, cancel, move |cancel| async move {
        tokio::task::spawn_blocking(move || {
            extraction_stage.directory.verify_path()?;
            extraction_stage.directory.space(extraction_candidate.asset.size)?;
            archive::extract(&extraction_stage.directory, &extraction_candidate, &cancel)
        }).await.map_err(|_| worker_error())?
    }).await?;
    io.supervise(SOURCE, native_request(), cancel, move |cancel| async move {
        tokio::task::spawn_blocking(move || {
            check_cancel(&cancel)?; stage.directory.verify_path()?;
            let digest = oc_installer::bundle_digest(&bundle).map_err(installer_error)?;
            check_cancel(&cancel)?;
            let request = oc_installer::PrepareRequest { target, candidate: bundle, expected_version: candidate.version,
                candidate_sha512: digest, parent: oc_installer::ProcessIdentity::current().map_err(installer_error)? };
            let prepared = oc_installer::prepare(request).map_err(installer_error)?;
            if cancel.is_cancelled() {
                return merge(Err(Error::cancelled()), prepared.abandon().map_err(|e| Error::cleanup("prepared installation", installer_error(e))));
            }
            Ok(prepared)
        }).await.map_err(|_| worker_error())?
    }).await
}
pub(super) async fn abandon(io: &BoundedIo, owned: Arc<std::sync::Mutex<Option<oc_installer::PreparedInstallation>>>) -> Result<()> {
    // The controller retains the cell if budget admission fails, so stop can
    // retry cleanup without dropping a live transaction or silently leaking it.
    io.supervise(SOURCE, native_request(), &CancellationToken::new(), move |_| async move {
        tokio::task::spawn_blocking(move || {
            let prepared = owned.lock().expect("installation owner poisoned").take().expect("installation owned once");
            prepared.abandon().map_err(|e| Error::cleanup("prepared installation", installer_error(e)))
        }).await.map_err(|_| worker_error())?
    }).await.map_err(|error| Error::cleanup("prepared installation", error))
}
fn installer_error(error: oc_installer::Error) -> Error {
    match error {
        oc_installer::Error::Aggregate { .. } => Error::cleanup("installer transaction recovery", Error::new("OC_UPDATE_INSTALLER", "安装事务恢复失败 / Installer transaction recovery failed")),
        _ => Error::new("OC_UPDATE_INSTALLER", "安装信任验证或事务准备失败 / Installation trust validation or preparation failed"),
    }
}
