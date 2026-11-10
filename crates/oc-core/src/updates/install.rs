use super::*;
use tokio::sync::oneshot;

impl UpdateController {
    /// The caller receives the unique prepared transaction after this operation
    /// completes. No helper is spawned here. The host must abandon on drain/spawn
    /// failure; only a successful helper spawn authorizes process exit.
    pub async fn prepare_install(self: &Arc<Self>) -> Result<oc_installer::PreparedInstallation> {
        let ticket = match self.admit(Kind::Prepare, None)? {
            Admission::New(ticket) => ticket,
            Admission::Unchanged(_) => return Err(Error::new("OC_UPDATE_DISABLED", "更新已禁用 / Updates are disabled")),
            Admission::Joined(done) => {
                // A prepared transaction is not cloneable: concurrent callers
                // wait for the one operation, then receive no second ownership.
                await_done(done).await?;
                return Err(Error::new("OC_UPDATE_BUSY", "另一更新操作已完成，请重试 / Another update operation completed; retry the explicit install"));
            },
        };
        let (candidate, stage) = {
            let state = self.state.lock().expect("update state poisoned");
            (state.candidate.clone().expect("admitted candidate"), state.stage.clone().expect("admitted archive"))
        };
        let (mut sender, receiver) = oneshot::channel::<Result<oc_installer::PreparedInstallation>>(); let this = self.clone();
        self.tasks.spawn(async move {
            let preparation_cancel = ticket.cancel.clone();
            let preparation = work::prepare(&this.io, stage, candidate, this.config.host_bundle.clone(), &preparation_cancel);
            tokio::pin!(preparation);
            let (result, interrupted) = tokio::select! {
                result = &mut preparation => (result, None),
                _ = tokio::time::sleep(INSTALL_TIMEOUT) => {
                    ticket.cancel.cancel(); (preparation.await, Some(Error::timeout("update installation preparation")))
                },
                _ = sender.closed() => {
                    ticket.cancel.cancel(); (preparation.await, Some(Error::cancelled()))
                },
            };
            let result = match (result, interrupted) {
                (Ok(prepared), Some(error)) => merge(Err(error), this.abandon_owned(prepared).await),
                (Err(error), Some(interruption)) if !error.is_cleanup() => Err(interruption),
                (result, _) => result,
            };
            // The installer has its own authenticated same-volume copy. Remove
            // the download and extraction tree before finishing this operation.
            let cleaned = this.clean_stage().await;
            let result = match (result, cleaned) {
                (Ok(prepared), Err(error)) => merge(Err(error), this.abandon_owned(prepared).await),
                (Err(error), cleanup) => merge(Err(error), cleanup),
                (result, Ok(())) => result,
            };
            match result {
                Err(error) => {
                    let reply = error.clone(); let _completion = this.finish(ticket, Err(error));
                    let _delivery = sender.send(Err(reply));
                },
                Ok(prepared) => {
                    // Sealing is serialized with cancel(), so cancellation that
                    // wins the lock abandons before releasing the operation.
                    let seal = this.seal(ticket.id);
                    if let Err(error) = seal {
                        let result: Result<()> = merge(Err(error), this.abandon_owned(prepared).await);
                        let error = result.expect_err("cancelled prepare");
                        let reply = error.clone(); let _completion = this.finish(ticket, Err(error));
                        let _delivery = sender.send(Err(reply)); return;
                    }
                    match this.finish(ticket, Ok(Outcome::Prepared)) {
                        Ok(_) => {
                            if let Err(Ok(prepared)) = sender.send(Ok(prepared)) {
                                // The API future disappeared after prepare. The
                                // supervisor still owns and abandons the value.
                                let result = this.abandon_owned(prepared).await;
                                let mut state = this.state.lock().expect("update state poisoned"); state.handing_off = false;
                                match result {
                                    Ok(()) => { state.snapshot.phase = UpdatePhase::Available; state.snapshot.error = None; },
                                    Err(error) => { state.snapshot.phase = UpdatePhase::Error; state.snapshot.error = Some(public_error(&error)); },
                                }
                                this.publish(&mut state);
                            }
                        },
                        Err(error) => {
                            let result: Result<()> = merge(Err(error), this.abandon_owned(prepared).await);
                            let error = result.expect_err("failed prepare completion"); this.fail(error.clone());
                            let _delivery = sender.send(Err(error));
                        },
                    }
                },
            }
        });
        receiver.await.map_err(|_| source::worker_error())?
    }
    async fn abandon_owned(&self, prepared: oc_installer::PreparedInstallation) -> Result<()> {
        let cell = Arc::new(Mutex::new(Some(prepared)));
        {
            let mut state = self.state.lock().expect("update state poisoned");
            assert!(state.pending.is_none(), "one prepared transaction per controller"); state.pending = Some(cell);
        }
        self.clean_pending().await
    }
    pub(super) async fn clean_pending(&self) -> Result<()> {
        let cell = self.state.lock().expect("update state poisoned").pending.clone();
        let Some(cell) = cell else { return Ok(()); };
        let result = work::abandon(&self.io, cell.clone()).await;
        if cell.lock().expect("installation owner poisoned").is_none() { self.state.lock().expect("update state poisoned").pending = None; }
        result
    }
}
