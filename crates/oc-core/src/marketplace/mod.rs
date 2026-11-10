mod archive;
mod fs;
pub mod model;
mod transaction;
mod transport;
mod trust;

pub use model::{Action, Catalog, CatalogEntry, MarketplaceItem, MarketplaceSnapshot, Operation, OperationError, Phase, PluginManifest, Source};
pub use trust::BundledAssets;
#[cfg(feature = "acceptance")]
pub use transport::AcceptanceFeed;
use crate::{error::{Error, Result, check_cancel, timestamp}, io::BoundedIo, model::MonitorSection, plugins::{NativePlugin, NativePluginSpec, PluginDefinition, Registry}};
use std::{collections::{BTreeMap, BTreeSet}, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;
use transaction::{Disk, Installed};
use trust::Trust;

pub struct MarketplaceOptions {
    pub profile: PathBuf, pub bundled: BundledAssets, pub host_bundle: PathBuf, pub host_bundle_id: String,
    pub app_version: String, pub io: BoundedIo, pub registry: Arc<Registry>, pub worker: PathBuf,
    pub enabled: Arc<dyn Fn(MonitorSection) -> bool + Send + Sync>,
    pub changed: Arc<dyn Fn(MarketplaceSnapshot) + Send + Sync>,
    /// Explicit, launch-supplied fixture trust roots loaded before initialization.
    /// Production builds never carry these; the installed directory is never trusted on its own.
    #[cfg(feature = "acceptance")]
    pub fixture_roots: Vec<BundledAssets>,
}
struct Active { cancel: CancellationToken, done: watch::Receiver<Option<Result<()>>> }
struct State {
    available: BTreeMap<String, Installed>, installed: BTreeMap<String, Installed>, disk_ids: BTreeSet<String>,
    item_errors: BTreeMap<String, String>, registered: BTreeSet<String>, snapshot: MarketplaceSnapshot, active: Option<Active>,
}
pub struct Marketplace {
    disk: Disk, trust: Trust, io: BoundedIo, registry: Arc<Registry>, app: String, client: crate::http::HttpTransport,
    enabled: Arc<dyn Fn(MonitorSection) -> bool + Send + Sync>, changed: Arc<dyn Fn(MarketplaceSnapshot) + Send + Sync>,
    state: Mutex<State>, closed: AtomicBool,
    #[cfg(feature = "acceptance")]
    acceptance_feed: Mutex<Option<AcceptanceFeed>>,
}
impl Marketplace {
    pub async fn open(options: MarketplaceOptions, cancel: &CancellationToken) -> Result<Arc<Self>> {
        model::version(&options.app_version)?;
        let trust = Trust::load(&options.io, options.bundled, options.host_bundle, options.host_bundle_id, &options.app_version, cancel).await?;
        #[cfg(feature = "acceptance")]
        {
            if options.fixture_roots.len() > 16 { return Err(Error::limit("acceptance fixture roots", 16, options.fixture_roots.len())); }
            if !options.fixture_roots.is_empty() { trust.add_fixtures(&options.io, &options.fixture_roots, &options.app_version, cancel).await?; }
        }
        let disk = Disk::open(options.io.clone(), options.profile, cancel).await?;
        let available = trust.bundled.iter().map(|(id, entry)| (id.clone(), Installed { entry: entry.clone(), source: Source::Bundled })).collect();
        let client = crate::http::HttpTransport::new(options.io.clone(), options.worker);
        let market = Arc::new(Self { disk, trust, io: options.io, registry: options.registry, app: options.app_version, client, enabled: options.enabled, changed: options.changed,
            state: Mutex::new(State { available, installed: BTreeMap::new(), disk_ids: BTreeSet::new(), item_errors: BTreeMap::new(), registered: BTreeSet::new(), snapshot: MarketplaceSnapshot::default(), active: None }), closed: AtomicBool::new(false),
            #[cfg(feature = "acceptance")] acceptance_feed: Mutex::new(None) });
        let initialize = market.clone(); let parent = cancel.clone();
        market.exclusive(move |cancel| async move {
            let initializing = initialize.initialize(cancel.clone()); tokio::pin!(initializing);
            let result = tokio::select! { result = &mut initializing => result, _ = parent.cancelled() => { cancel.cancel(); initializing.await } };
            if let Err(error) = result {
                let ids: Vec<_> = initialize.state.lock().expect("market poisoned").registered.iter().cloned().collect();
                let coordination = initialize.registry.coordination(); let _guard = coordination.lock().await;
                let mut failures = vec![error];
                for id in ids { if let Err(cleanup) = initialize.registry.unregister_locked(&id).await { failures.push(Error::cleanup("market initialization", cleanup)); } }
                return Err(Error::aggregate(failures));
            }
            Ok(())
        }).await?;
        Ok(market)
    }
    async fn initialize(self: &Arc<Self>, cancel: CancellationToken) -> Result<()> {
        let recovered = self.disk.recover(&cancel).await?;
        let coordination = self.registry.coordination(); let _guard = coordination.lock().await;
        for value in recovered {
            check_cancel(&cancel)?;
            { let mut state = self.state.lock().expect("market poisoned"); if value.present { state.disk_ids.insert(value.id.clone()); } if let Some(installed) = value.installed { state.installed.insert(value.id.clone(), installed); } if let Some(error) = value.error { state.item_errors.insert(value.id.clone(), error.to_string()); } }
            if !value.present { continue; }
            let result: Result<()> = async {
                let installed = self.verify(&value.id, "current", &cancel).await?;
                self.section_available(&value.id, installed.entry.manifest.section)?;
                let definition = self.definition(&installed)?;
                self.registry.register_with_cancel_locked(definition, (self.enabled)(installed.entry.manifest.section), &cancel).await?;
                let mut state = self.state.lock().expect("market poisoned"); state.registered.insert(value.id.clone()); state.installed.insert(value.id.clone(), installed);
                Ok(())
            }.await;
            if let Err(error) = result {
                let retained = error.is_cleanup() && self.registry.statuses().iter().any(|s| s.id == value.id);
                let mut state = self.state.lock().expect("market poisoned"); if retained { state.registered.insert(value.id.clone()); } state.item_errors.insert(value.id, error.to_string());
            }
        }
        check_cancel(&cancel)?; self.publish(); Ok(())
    }
    pub fn snapshot(&self) -> MarketplaceSnapshot {
        let statuses = self.registry.statuses(); let state = self.state.lock().expect("market poisoned");
        let ids: BTreeSet<_> = state.available.keys().chain(state.installed.keys()).chain(state.disk_ids.iter()).chain(state.item_errors.keys()).cloned().collect();
        let mut snapshot = state.snapshot.clone();
        snapshot.items = ids.into_iter().map(|id| {
            let available = state.available.get(&id); let installed = state.installed.get(&id);
            let selected = match (available, installed) {
                (Some(a), Some(i)) if model::version(&i.entry.manifest.version).ok().zip(model::version(&a.entry.manifest.version).ok()).is_some_and(|(i, a)| i > a) => Some(i),
                _ => available.or(installed),
            };
            let manifest = selected.map(|v| v.entry.manifest.clone()).unwrap_or_else(|| damaged_manifest(&id));
            let update_available = match (available, installed) { (Some(a), Some(i)) => model::version(&a.entry.manifest.version).ok().zip(model::version(&i.entry.manifest.version).ok()).is_some_and(|(a, i)| a > i), _ => false };
            MarketplaceItem { manifest, installed: state.disk_ids.contains(&id), installed_version: installed.map(|i| i.entry.manifest.version.clone()),
                enabled: statuses.iter().find(|s| s.id == id).is_some_and(|s| s.enabled), update_available,
                source: selected.map_or(Source::Installed, |v| v.source), error: state.item_errors.get(&id).cloned() }
        }).collect(); snapshot
    }
    /// UI search is deterministic over the same snapshot, without extra network IO.
    pub fn search(&self, query: &str, installed_only: bool, section: Option<MonitorSection>) -> Result<Vec<MarketplaceItem>> {
        if query.len() > 1024 || query.encode_utf16().count() > 256 || query.chars().any(char::is_control) { return Err(Error::invalid("market search")); }
        let query = query.to_lowercase();
        Ok(self.snapshot().items.into_iter().filter(|item| (!installed_only || item.installed) && section.is_none_or(|section| item.manifest.section == section)
            && [&item.manifest.id, &item.manifest.name, &item.manifest.name_en, &item.manifest.description, &item.manifest.description_en, &item.manifest.publisher].iter().any(|value| value.to_lowercase().contains(&query))).collect())
    }
    fn publish(&self) { (self.changed)(self.snapshot()); }
    async fn exclusive<F, Fut>(self: &Arc<Self>, work: F) -> Result<()>
    where F: FnOnce(CancellationToken) -> Fut + Send + 'static, Fut: Future<Output = Result<()>> + Send + 'static {
        let cancel = self.io.cancellation(); let (done, receiver) = watch::channel(None);
        { let mut state = self.state.lock().expect("market poisoned"); if self.closed.load(Ordering::Acquire) { return Err(Error::new("OC_MARKET_CLOSED", "Marketplace is closed")); } if state.active.is_some() { return Err(Error::new("OC_MARKET_BUSY", "Another marketplace operation is active")); } state.active = Some(Active { cancel: cancel.clone(), done: receiver }); }
        let this = self.clone(); let (send, receive) = oneshot::channel();
        tokio::spawn(async move {
            let result = work(cancel).await;
            this.state.lock().expect("market poisoned").active = None;
            done.send_replace(Some(result.clone()));
            if let Err(Err(error)) = send.send(result) { eprintln!("abandoned marketplace transaction: {error}"); }
        });
        receive.await.map_err(|_| Error::cleanup("market transaction", Error::new("OC_PLUGIN_PANIC", "Marketplace task exited unexpectedly")))?
    }
    pub async fn check(self: &Arc<Self>) -> Result<MarketplaceSnapshot> {
        let this = self.clone();
        self.exclusive(move |cancel| async move {
            { let mut state = this.state.lock().expect("market poisoned"); state.snapshot.checking = true; state.snapshot.catalog_error = None; } this.publish();
            let result: Result<Catalog> = async {
                let feed = this.feed();
                if matches!(feed, transport::Feed::Official) { this.trust.host_team(&this.io, &cancel).await?; }
                let bytes = transport::catalog(this.client.clone(), &feed, &cancel).await?;
                #[cfg(feature = "acceptance")]
                if let transport::Feed::Acceptance(feed) = &feed {
                    if oc_plugin_sdk::digest(&bytes) != feed.catalog_sha256 { return Err(Error::new("OC_PLUGIN_TRUST", "Acceptance HTTP catalog digest mismatch")); }
                }
                let catalog = Catalog::parse(&bytes, &this.app)?;
                #[cfg(feature = "acceptance")]
                if matches!(feed, transport::Feed::Acceptance(_)) && catalog.plugins.iter().any(|entry| !this.trust.fixture_pinned(entry)) {
                    return Err(Error::new("OC_PLUGIN_TRUST", "Acceptance HTTP catalog includes an unpinned native package"));
                }
                Ok(catalog)
            }.await;
            { let mut state = this.state.lock().expect("market poisoned"); state.snapshot.checking = false; state.snapshot.checked_at = Some(timestamp());
                match result {
                    Ok(catalog) => {
                        let mut available: BTreeMap<_, _> = this.trust.bundled.iter().map(|(id, entry)| (id.clone(), Installed { entry: entry.clone(), source: Source::Bundled })).collect();
                        for entry in catalog.plugins { let id = entry.manifest.id.clone(); let replace = available.get(&id).is_none_or(|old| model::version(&entry.manifest.version).expect("validated version") > model::version(&old.entry.manifest.version).expect("validated version")); if replace { available.insert(id, Installed { entry, source: Source::Online }); } }
                        state.available = available;
                    }
                    Err(error) => state.snapshot.catalog_error = Some(error.to_string()),
                }
            }
            this.publish(); Ok(())
        }).await?;
        Ok(self.snapshot())
    }
    fn feed(&self) -> transport::Feed {
        #[cfg(feature = "acceptance")]
        if let Some(feed) = self.acceptance_feed.lock().expect("fixture feed poisoned").clone() { return transport::Feed::Acceptance(feed); }
        transport::Feed::Official
    }
    /// Explicit process-local acceptance roots. Normal check/install/update still
    /// use the supervised HTTP worker and the complete archive/signature pipeline.
    #[cfg(feature = "acceptance")]
    pub async fn set_acceptance_feed(self: &Arc<Self>, feed: AcceptanceFeed) -> Result<()> {
        crate::http::validate_acceptance_market_url(&feed.catalog_url)?;
        if !feed.catalog_url.ends_with("/catalog.json") || !oc_plugin_sdk::valid_digest(&feed.catalog_sha256) || feed.trusted_assets.is_empty() || feed.trusted_assets.len() > 8 {
            return Err(Error::invalid("acceptance feed catalog and bounded native roots"));
        }
        let this = self.clone();
        self.exclusive(move |cancel| async move {
            this.trust.add_fixtures(&this.io, &feed.trusted_assets, &this.app, &cancel).await?;
            check_cancel(&cancel)?;
            *this.acceptance_feed.lock().expect("fixture feed poisoned") = Some(feed);
            Ok(())
        }).await
    }
    pub async fn install(self: &Arc<Self>, id: &str) -> Result<MarketplaceSnapshot> { self.mutate(id, Action::Install).await }
    pub async fn update(self: &Arc<Self>, id: &str) -> Result<MarketplaceSnapshot> { self.mutate(id, Action::Update).await }
    pub async fn uninstall(self: &Arc<Self>, id: &str) -> Result<MarketplaceSnapshot> { self.mutate(id, Action::Uninstall).await }
    async fn mutate(self: &Arc<Self>, id: &str, action: Action) -> Result<MarketplaceSnapshot> {
        model::plugin_id(id)?; let id = id.to_owned(); let this = self.clone();
        self.exclusive(move |cancel| async move {
            { let mut state = this.state.lock().expect("market poisoned"); state.snapshot.error = None; state.snapshot.operation = Some(Operation { id: id.clone(), action, phase: if action == Action::Uninstall { Phase::Removing } else { Phase::Downloading }, received_bytes: 0, total_bytes: 0 }); } this.publish();
            let result = if action == Action::Uninstall { this.remove(&id, &cancel).await } else { this.activate(&id, action, &cancel).await };
            { let mut state = this.state.lock().expect("market poisoned"); state.snapshot.operation = None;
                if let Err(error) = &result { if !error.is_cancelled() { state.snapshot.error = Some(OperationError { id: id.clone(), action, message: error.to_string() }); } }
            }
            this.publish(); result
        }).await.or_else(|error| if error.is_cleanup() || error.code == "OC_MARKET_BUSY" || error.code == "OC_MARKET_CLOSED" { Err(error) } else { Ok(()) })?;
        Ok(self.snapshot())
    }
    fn phase(&self, phase: Phase) { if let Some(operation) = &mut self.state.lock().expect("market poisoned").snapshot.operation { operation.phase = phase; } self.publish(); }
    fn section_available(&self, id: &str, section: MonitorSection) -> Result<()> {
        if self.registry.statuses().iter().any(|plugin| plugin.section == section && plugin.id != id) { return Err(Error::new("OC_PLUGIN_SECTION", "Collection section already has a registered plugin")); } Ok(())
    }
    async fn activate(self: &Arc<Self>, id: &str, action: Action, cancel: &CancellationToken) -> Result<()> {
        let (candidate, previous, present) = {
            let state = self.state.lock().expect("market poisoned");
            (state.available.get(id).cloned().ok_or_else(|| Error::new("OC_PLUGIN_UNKNOWN", "Plugin is absent from the trusted catalog"))?, state.installed.get(id).cloned(), state.disk_ids.contains(id))
        };
        if (action == Action::Install && present) || (action == Action::Update && !present) { return Err(Error::invalid("market install/update state")); }
        if action == Action::Update {
            let previous = previous.as_ref().ok_or_else(|| Error::new("OC_PLUGIN_DAMAGED", "Damaged plugin must be uninstalled before installing again"))?;
            if model::version(&candidate.entry.manifest.version)? <= model::version(&previous.entry.manifest.version)? { return Err(Error::new("OC_PLUGIN_VERSION", "Update must have a strictly newer version")); }
        }
        let feed = self.feed();
        if candidate.source == Source::Online {
            match &feed {
                transport::Feed::Official => { self.trust.host_team(&self.io, cancel).await?; }
                #[cfg(feature = "acceptance")]
                transport::Feed::Acceptance(_) => { if !self.trust.fixture_pinned(&candidate.entry) { return Err(Error::new("OC_PLUGIN_TRUST", "Unpinned acceptance download")); } }
            }
        }
        if let Some(operation) = &mut self.state.lock().expect("market poisoned").snapshot.operation { operation.total_bytes = candidate.entry.bytes; }
        let mut prepared = false;
        let staging = async {
            self.disk.prepare(candidate.clone(), cancel).await?; prepared = true;
            if candidate.source == Source::Bundled {
                transport::copy_bundled(&self.io, self.disk.root.clone(), candidate.entry.clone(), self.trust.source_path(&candidate.entry)?, cancel).await?;
            } else {
                let weak = Arc::downgrade(self);
                let progress = Arc::new(move |bytes| { if let Some(market) = weak.upgrade() { if let Some(operation) = &mut market.state.lock().expect("market poisoned").snapshot.operation { operation.received_bytes = bytes; } market.publish(); } });
                transport::download(&self.io, self.disk.root.clone(), candidate.entry.clone(), self.client.clone(), &feed, cancel, progress).await?;
            }
            self.phase(Phase::Verifying); self.disk.extract(candidate.clone(), self.app.clone(), cancel).await?;
            let verified = self.verify(id, "pending", cancel).await?;
            if verified.entry != candidate.entry { return Err(Error::new("OC_PLUGIN_CHANGED", "Pending package changed")); }
            check_cancel(cancel)
        }.await;
        if let Err(error) = staging {
            if prepared { return match self.disk.rollback(id.to_owned()).await { Ok(()) => Err(error), Err(cleanup) => Err(Error::aggregate(vec![error, Error::cleanup("plugin staging", cleanup)])) }; }
            return Err(error);
        }
        // Download and verification leave the old runtime alive. The settings
        // section state is sampled only after obtaining their shared lock.
        let coordination = self.registry.coordination(); let _guard = coordination.lock().await;
        if let Err(error) = self.section_available(id, candidate.entry.manifest.section) { return match self.disk.rollback(id.to_owned()).await { Ok(()) => Err(error), Err(cleanup) => Err(Error::aggregate(vec![error, cleanup])) }; }
        self.phase(Phase::Activating);
        let old_registered = self.state.lock().expect("market poisoned").registered.contains(id);
        let mut old_stopped = false; let mut new_registered = false; let mut swapped = false;
        let activation = async {
            check_cancel(cancel)?;
            if !old_registered && self.registry.statuses().iter().any(|s| s.id == id) { return Err(Error::new("OC_PLUGIN_DUPLICATE", "Marketplace cannot replace a registration it does not own")); }
            if old_registered { self.registry.unregister_locked(id).await?; self.state.lock().expect("market poisoned").registered.remove(id); old_stopped = true; }
            check_cancel(cancel)?;
            self.disk.swap(id.to_owned(), cancel).await?; swapped = true;
            let final_package = self.verify(id, "current", cancel).await?;
            if final_package.entry != candidate.entry { return Err(Error::new("OC_PLUGIN_CHANGED", "Committed-path package changed before activation")); }
            let definition = self.definition(&candidate)?;
            self.registry.register_with_cancel_locked(definition, (self.enabled)(candidate.entry.manifest.section), cancel).await?; new_registered = true;
            self.state.lock().expect("market poisoned").registered.insert(id.to_owned());
            check_cancel(cancel)?;
            Ok(())
        }.await;
        if let Err(error) = activation {
            // Failed register may retain a poisoned generation. Never touch its
            // files or restore another version until its true stop succeeds.
            let owns_new = swapped && self.registry.statuses().iter().any(|s| s.id == id);
            if new_registered || owns_new {
                if let Err(cleanup) = self.registry.unregister_locked(id).await {
                    let mut state = self.state.lock().expect("market poisoned"); state.registered.insert(id.to_owned()); state.disk_ids.insert(id.to_owned()); state.installed.insert(id.to_owned(), candidate.clone()); state.item_errors.insert(id.to_owned(), cleanup.to_string());
                    return Err(Error::aggregate(vec![error, Error::cleanup("new plugin drain", cleanup)]));
                }
                self.state.lock().expect("market poisoned").registered.remove(id);
            }
            if !old_stopped && old_registered && error.is_cleanup() { return Err(error); }
            if let Err(cleanup) = self.disk.rollback(id.to_owned()).await { return Err(Error::aggregate(vec![error, Error::cleanup("plugin rollback", cleanup)])); }
            if old_stopped {
                if let Some(previous) = &previous {
                    let restored = self.definition(previous).and_then(|definition| Ok((definition, (self.enabled)(previous.entry.manifest.section))))?;
                    if let Err(cleanup) = self.registry.register_locked(restored.0, restored.1).await { return Err(Error::aggregate(vec![error, Error::cleanup("old plugin restoration", cleanup)])); }
                    self.state.lock().expect("market poisoned").registered.insert(id.to_owned());
                }
            }
            return Err(error);
        }
        // Cancellation after this boundary cannot undo a committed installation.
        let committed = self.disk.commit(id.to_owned()).await;
        { let mut state = self.state.lock().expect("market poisoned"); state.disk_ids.insert(id.to_owned()); state.installed.insert(id.to_owned(), candidate); state.item_errors.remove(id); }
        committed.map_err(|error| Error::cleanup("committed plugin rollback cleanup", error))
    }
    async fn remove(&self, id: &str, cancel: &CancellationToken) -> Result<()> {
        if !self.state.lock().expect("market poisoned").disk_ids.contains(id) { return Err(Error::new("OC_PLUGIN_UNKNOWN", "Plugin is not installed")); }
        let coordination = self.registry.coordination(); let _guard = coordination.lock().await; check_cancel(cancel)?;
        let registered = self.state.lock().expect("market poisoned").registered.contains(id);
        if registered { self.registry.unregister_locked(id).await?; self.state.lock().expect("market poisoned").registered.remove(id); }
        if cancel.is_cancelled() {
            if registered {
                let installed = self.state.lock().expect("market poisoned").installed.get(id).cloned().ok_or_else(|| Error::invalid("uninstall restoration metadata"))?;
                self.registry.register_locked(self.definition(&installed)?, (self.enabled)(installed.entry.manifest.section)).await
                    .map_err(|error| Error::cleanup("cancelled uninstall restoration", error))?;
                self.state.lock().expect("market poisoned").registered.insert(id.to_owned());
            }
            return Err(Error::cancelled());
        }
        self.phase(Phase::Removing); self.disk.remove(id.to_owned()).await?;
        let mut state = self.state.lock().expect("market poisoned"); state.installed.remove(id); state.disk_ids.remove(id); state.item_errors.remove(id); Ok(())
    }
    async fn verify(&self, id: &str, location: &'static str, cancel: &CancellationToken) -> Result<Installed> {
        let installed = self.disk.inspect(id.to_owned(), location, self.app.clone(), cancel).await?;
        if installed.source == Source::Bundled && !self.trust.pinned(&installed.entry) { return Err(Error::new("OC_PLUGIN_TRUST", "Installed bundled package is not trusted by this build")); }
        self.trust.verify_bundle(&self.io, &self.disk.bundle_path(id, location), &installed.entry, installed.source, cancel).await?;
        // Recheck expanded bytes after external codesign has read them.
        let after = self.disk.inspect(id.to_owned(), location, self.app.clone(), cancel).await?;
        if after.entry != installed.entry { return Err(Error::new("OC_PLUGIN_CHANGED", "Package changed during signature verification")); } Ok(installed)
    }
    fn definition(&self, installed: &Installed) -> Result<PluginDefinition> {
        let entry = installed.entry.clone(); let manifest = &entry.manifest;
        let disk = self.disk.clone(); let trust = self.trust.clone(); let io = self.io.clone(); let app = self.app.clone(); let expected = entry.clone();
        let verify = Arc::new(move |cancel: CancellationToken| -> crate::plugins::BoxFuture<'static, Result<()>> {
            let disk = disk.clone(); let trust = trust.clone(); let io = io.clone(); let app = app.clone(); let expected = expected.clone();
            Box::pin(async move {
                let installed = disk.inspect(expected.manifest.id.clone(), "current", app.clone(), &cancel).await?;
                if installed.entry != expected || (installed.source == Source::Bundled && !trust.pinned(&expected)) { return Err(Error::new("OC_PLUGIN_CHANGED", "Installed package no longer matches its registration")); }
                trust.verify_bundle(&io, &disk.bundle_path(&expected.manifest.id, "current"), &expected, installed.source, &cancel).await?;
                let after = disk.inspect(expected.manifest.id.clone(), "current", app, &cancel).await?;
                if after.entry != expected { return Err(Error::new("OC_PLUGIN_CHANGED", "Installed package changed during startup validation")); } Ok(())
            })
        });
        let spec = NativePluginSpec { id: manifest.id.clone(), app_version: self.app.clone(), section: manifest.section,
            executable: self.disk.bundle_path(&manifest.id, "current").join("Contents/MacOS/collector"), capabilities: manifest.capabilities()?, timeout: Duration::from_secs(10), verify };
        Ok(PluginDefinition { id: manifest.id.clone(), section: manifest.section, capabilities: manifest.permissions.clone(), dependencies: Vec::new(), retry_sources: Vec::new(), interval: Duration::from_secs(2), timeout: Duration::from_secs(20), create: Arc::new(move |context| Ok(Arc::new(NativePlugin::new(spec.clone(), context)))) })
    }
    pub async fn cancel(&self) -> Result<()> {
        let active = self.state.lock().expect("market poisoned").active.as_ref().map(|a| (a.cancel.clone(), a.done.clone()));
        let Some((cancel, mut done)) = active else { return Ok(()); }; cancel.cancel();
        loop {
            if let Some(result) = done.borrow().clone() { return match result { Err(error) if error.is_cancelled() => Ok(()), result => result }; }
            done.changed().await.map_err(|_| Error::cleanup("market transaction", Error::new("OC_PLUGIN_PANIC", "Transaction supervisor disappeared")))?;
        }
    }
    pub async fn close(&self) -> Result<()> { self.closed.store(true, Ordering::Release); self.cancel().await }
}
fn damaged_manifest(id: &str) -> PluginManifest {
    PluginManifest { id: id.into(), version: "0.0.0".into(), api_version: 2, target: "aarch64-apple-darwin".into(), name: id.into(), name_en: id.into(),
        description: "已安装插件损坏，详情不可读；可卸载后重新安装。".into(), description_en: "Installed package is damaged; details cannot be read. Uninstall to remove it.".into(), publisher: "Unknown".into(), section: MonitorSection::System, min_app_version: "0.0.0".into(), platforms: vec!["darwin".into()], permissions: vec![] }
}

#[cfg(test)]
mod tests;

#[cfg(all(test, feature = "acceptance"))]
mod acceptance_tests;
