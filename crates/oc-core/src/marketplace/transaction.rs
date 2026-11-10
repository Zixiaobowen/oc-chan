use super::{archive, fs::Dir, model::*};
use crate::{error::{Error, Result, check_cancel}, io::{BoundedIo, FileIdentity}};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(super) struct Disk { pub root: Arc<Dir>, io: BoundedIo }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Installed { pub entry: CatalogEntry, pub source: Source }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum State { Prepared, Swapping, Active, Removing }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    schema: u8, id: String, state: State, parent: FileIdentity,
    old: Option<FileIdentity>, new: Option<FileIdentity>,
    old_archive: Option<FileIdentity>, new_archive: Option<FileIdentity>, sha256: Option<String>,
}
#[derive(Debug)]
pub(super) struct Recovered { pub id: String, pub installed: Option<Installed>, pub error: Option<Error>, pub present: bool }
impl Disk {
    pub async fn open(io: BoundedIo, profile: PathBuf, cancel: &CancellationToken) -> Result<Self> {
        let root = io.with_file_budget("plugin-market", 64 * 1024, cancel, move |_| async move {
            tokio::task::spawn_blocking(move || Dir::profile(&profile)).await.map_err(|_| Error::cleanup("market directory", Error::new("OC_PLUGIN_PANIC", "Directory task failed")))?
        }).await?;
        Ok(Self { root, io })
    }
    pub async fn run<T: Send + 'static>(&self, bytes: usize, cancel: &CancellationToken, work: impl FnOnce(Arc<Dir>, CancellationToken) -> Result<T> + Send + 'static) -> Result<T> {
        let root = self.root.clone();
        self.io.with_file_budget("plugin-market", bytes, cancel, move |cancel| async move {
            tokio::task::spawn_blocking(move || work(root, cancel)).await.map_err(|_| Error::cleanup("market filesystem", Error::new("OC_PLUGIN_PANIC", "Filesystem task failed")))?
        }).await
    }
    pub async fn recover(&self, cancel: &CancellationToken) -> Result<Vec<Recovered>> {
        self.run(512 * 1024, cancel, |root, cancel| {
            let names = root.names(INSTALLED_LIMIT)?; let mut result = Vec::with_capacity(names.len());
            for id in names {
                plugin_id(&id)?; check_cancel(&cancel)?;
                let recovered = (|| {
                    let plugin = root.child(&id, false)?;
                    let interrupted = recover_one(&plugin, &id)?;
                    let present = plugin.exists("current")?;
                    let installed = if present { Some(read_installed(&plugin.child("current", false)?, &cancel)?) } else { None };
                    if !present && plugin.names(16)?.is_empty() { drop(plugin); root.remove_tree(&id)?; }
                    Ok(Recovered { id: id.clone(), installed, present, error: interrupted.then(|| Error::new("OC_PLUGIN_INTERRUPTED", "Recovered an interrupted plugin transaction")) })
                })();
                match recovered { Ok(value) => result.push(value), Err(error) => result.push(Recovered { id, installed: None, error: Some(error), present: true }) }
            }
            Ok(result)
        }).await
    }
    pub async fn prepare(&self, installed: Installed, cancel: &CancellationToken) -> Result<()> {
        self.run(128 * 1024, cancel, move |root, cancel| {
            check_cancel(&cancel)?; let id = &installed.entry.manifest.id;
            let names = root.names(INSTALLED_LIMIT)?;
            if !names.contains(id) && names.len() >= INSTALLED_LIMIT { return Err(Error::limit("installed plugins", INSTALLED_LIMIT, names.len() + 1)); }
            let used = root.disk_usage()?;
            // Reserve the entire transaction peak before creating its first file.
            let required = installed.entry.bytes as u64 + EXPANDED_BYTES as u64 + 128 * 1024;
            if required > DISK_BYTES.saturating_sub(used) { return Err(Error::limit("plugin transaction disk", DISK_BYTES as usize, (used + required) as usize)); }
            let plugin = root.child(id, true)?;
            if plugin.exists("transaction.json")? || plugin.exists("pending")? || plugin.exists("rollback")? || plugin.exists("discard")? { return Err(Error::new("OC_PLUGIN_INTERRUPTED", "Plugin transaction needs recovery before installation")); }
            let old = if plugin.exists("current")? { Some(plugin.child("current", false)?.identity()?) } else { None };
            let pending = plugin.child("pending", true)?;
            let prepared = (|| {
                let old_archive = if old.is_some() { Some(archive_identity(&plugin.child("current", false)?)?) } else { None };
                let journal = Journal { schema: 1, id: id.clone(), state: State::Prepared, parent: plugin.identity()?, old, new: Some(pending.identity()?), old_archive, new_archive: None, sha256: Some(installed.entry.sha256.clone()) };
                write_journal(&plugin, &journal)?;
                let bytes = serde_json::to_vec(&installed).map_err(|_| Error::invalid("installed metadata"))?;
                if bytes.len() > 32 * 1024 { return Err(Error::invalid("installed metadata size")); }
                pending.write("entry.json", &bytes, &cancel)?; pending.sync()?; plugin.sync()?; root.sync()
            })();
            if let Err(error) = prepared {
                let cleanup = (|| { drop(pending); plugin.remove_tree("pending")?; for name in ["transaction.json.new", "transaction.json"] { if plugin.exists(name)? { plugin.unlink(name)?; } } Ok(()) })();
                return match cleanup { Ok(()) => Err(error), Err(cleanup) => Err(Error::aggregate(vec![error, Error::cleanup("prepare transaction", cleanup)])) };
            }
            Ok(())
        }).await
    }
    pub async fn extract(&self, installed: Installed, app: String, cancel: &CancellationToken) -> Result<()> {
        self.run(ARCHIVE_BYTES + 1024 * 1024, cancel, move |root, cancel| {
            let plugin = root.child(&installed.entry.manifest.id, false)?;
            let pending = plugin.child("pending", false)?;
            assert_binding(&pending, read_journal(&plugin)?.new.as_ref())?;
            let bytes = pending.read("archive.ocplugin", ARCHIVE_BYTES, &cancel)?;
            archive::inspect(&bytes, &installed.entry, &app, Some(&pending), Some(&root), &cancel)?;
            Ok(())
        }).await
    }
    pub async fn inspect(&self, id: String, location: &'static str, app: String, cancel: &CancellationToken) -> Result<Installed> {
        self.run(ARCHIVE_BYTES + 1024 * 1024, cancel, move |root, cancel| {
            let current = root.child(&id, false)?.child(location, false)?;
            let installed = read_installed(&current, &cancel)?;
            if installed.entry.manifest.id != id { return Err(Error::invalid("installed identity")); }
            let bytes = current.read("archive.ocplugin", ARCHIVE_BYTES, &cancel)?;
            let info = archive::inspect(&bytes, &installed.entry, &app, None, None, &cancel)?;
            archive::compare_tree(&current, &info, &cancel)?;
            Ok(installed)
        }).await
    }
    pub fn bundle_path(&self, id: &str, location: &str) -> PathBuf { self.root.path.join(id).join(location).join(format!("{id}.ocbundle")) }
    pub async fn swap(&self, id: String, cancel: &CancellationToken) -> Result<()> {
        self.run(64 * 1024, cancel, move |root, cancel| {
            check_cancel(&cancel)?; let plugin = root.child(&id, false)?; let mut journal = read_journal(&plugin)?;
            assert_parent(&plugin, &journal)?;
            assert_binding(&plugin.child("pending", false)?, journal.new.as_ref())?;
            if let Some(old) = &journal.old { assert_binding(&plugin.child("current", false)?, Some(old))?; }
            journal.new_archive = Some(archive_identity(&plugin.child("pending", false)?)?);
            if let Some(expected) = &journal.old_archive { assert_archive(&plugin.child("current", false)?, expected)?; }
            journal.state = State::Swapping; write_journal(&plugin, &journal)?;
            if journal.old.is_some() { plugin.rename("current", "rollback")?; }
            plugin.rename("pending", "current")?; root.sync()
        }).await
    }
    pub async fn commit(&self, id: String) -> Result<()> {
        self.run(64 * 1024, &CancellationToken::new(), move |root, _| {
            let plugin = root.child(&id, false)?; let mut journal = read_journal(&plugin)?;
            assert_parent(&plugin, &journal)?; assert_binding(&plugin.child("current", false)?, journal.new.as_ref())?;
            assert_archive(&plugin.child("current", false)?, journal.new_archive.as_ref().ok_or_else(|| Error::invalid("new archive binding"))?)?;
            journal.state = State::Active; write_journal(&plugin, &journal)?;
            // The rename is the commit point. A remaining rollback is always a
            // complete old version and wins recovery. Discard is never activated.
            if plugin.exists("rollback")? { plugin.rename("rollback", "discard")?; }
            if plugin.exists("discard")? { plugin.remove_tree("discard")?; }
            plugin.unlink("transaction.json")?; root.sync()
        }).await
    }
    pub async fn rollback(&self, id: String) -> Result<()> {
        self.run(64 * 1024, &CancellationToken::new(), move |root, _| {
            let plugin = root.child(&id, false)?;
            if !plugin.exists("transaction.json")? {
                if plugin.exists("pending")? { plugin.remove_tree("pending")?; } return Ok(());
            }
            let journal = read_journal(&plugin)?; assert_parent(&plugin, &journal)?;
            if plugin.exists("discard")? { return Err(Error::cleanup("plugin rollback", Error::new("OC_PLUGIN_COMMITTED", "New package committed; old package cleanup requires recovery"))); }
            restore(&plugin, &journal)?;
            if plugin.names(16)?.is_empty() { drop(plugin); root.remove_tree(&id)?; }
            root.sync()
        }).await
    }
    pub async fn remove(&self, id: String) -> Result<()> {
        self.run(64 * 1024, &CancellationToken::new(), move |root, _| {
            let plugin = match root.child(&id, false) {
                Ok(plugin) => plugin,
                Err(error) if error.code == "ELOOP" || error.code == "ENOTDIR" => return root.unlink(&id),
                Err(error) => return Err(error),
            };
            // Once stopped and this phase starts, cancellation cannot interrupt
            // deletion. Restart continues it even for malformed archive/manifest.
            let journal = Journal { schema: 1, id: id.clone(), state: State::Removing, parent: plugin.identity()?, old: None, new: None, old_archive: None, new_archive: None, sha256: None };
            if plugin.exists("transaction.json.new")? { plugin.unlink("transaction.json.new")?; }
            write_journal(&plugin, &journal)?;
            drop(plugin); root.remove_tree(&id)
        }).await
    }
}
fn read_installed(dir: &Dir, cancel: &CancellationToken) -> Result<Installed> {
    let bytes = dir.read("entry.json", 32 * 1024, cancel)?;
    let installed: Installed = serde_json::from_slice(&bytes).map_err(|_| Error::invalid("installed metadata"))?;
    if installed.source == Source::Installed { return Err(Error::invalid("installed provenance")); }
    Ok(installed)
}
fn read_journal(dir: &Dir) -> Result<Journal> {
    let bytes = dir.read("transaction.json", 16 * 1024, &CancellationToken::new())?;
    let journal: Journal = serde_json::from_slice(&bytes).map_err(|_| Error::new("OC_PLUGIN_INTERRUPTED", "Invalid transaction journal; package is retained for explicit uninstall"))?;
    if journal.schema != 1 { return Err(Error::invalid("transaction journal version")); } plugin_id(&journal.id)?; Ok(journal)
}
fn write_journal(dir: &Dir, journal: &Journal) -> Result<()> { let bytes = serde_json::to_vec(journal).map_err(|_| Error::invalid("transaction journal"))?; dir.atomic("transaction.json", &bytes) }
fn assert_binding(dir: &Dir, expected: Option<&FileIdentity>) -> Result<()> {
    let actual = dir.identity()?;
    if expected.is_none_or(|expected| !actual.same_file(expected)) { return Err(Error::new("OC_PLUGIN_TRANSACTION_IDENTITY", "Transaction directory identity changed")); } Ok(())
}
fn assert_parent(dir: &Dir, journal: &Journal) -> Result<()> { assert_binding(dir, Some(&journal.parent)) }
fn archive_identity(dir: &Dir) -> Result<FileIdentity> {
    let file = dir.open_read("archive.ocplugin")?;
    let identity = super::fs::regular(&file);
    super::fs::merge(identity, super::fs::close(file))
}
fn assert_archive(dir: &Dir, expected: &FileIdentity) -> Result<()> {
    if &archive_identity(dir)? != expected { return Err(Error::new("OC_PLUGIN_TRANSACTION_IDENTITY", "Transaction archive identity changed")); }
    Ok(())
}
fn recover_one(plugin: &Dir, id: &str) -> Result<bool> {
    if !plugin.exists("transaction.json")? {
        let mut interrupted = false;
        if plugin.exists("rollback")? || plugin.exists("discard")? { return Err(Error::new("OC_PLUGIN_INTERRUPTED", "Unbound rollback directory retained for diagnosis")); }
        if plugin.exists("pending")? { plugin.remove_tree("pending")?; interrupted = true; }
        if plugin.exists("transaction.json.new")? { plugin.unlink("transaction.json.new")?; interrupted = true; }
        return Ok(interrupted);
    }
    let journal = read_journal(plugin)?; if journal.id != id { return Err(Error::invalid("transaction journal plugin")); } assert_parent(plugin, &journal)?;
    if plugin.exists("transaction.json.new")? { plugin.unlink("transaction.json.new")?; }
    if journal.state == State::Removing {
        for name in plugin.names(16)? { if name == "transaction.json" { continue; } match plugin.child(&name, false) { Ok(_) => plugin.remove_tree(&name)?, Err(e) if e.code == "ENOTDIR" || e.code == "ELOOP" => plugin.unlink(&name)?, Err(e) => return Err(e) } }
        plugin.unlink("transaction.json")?; return Ok(true);
    }
    if plugin.exists("rollback")? { restore(plugin, &journal)?; return Ok(true); }
    if journal.state == State::Active {
        assert_binding(&plugin.child("current", false)?, journal.new.as_ref())?;
        assert_archive(&plugin.child("current", false)?, journal.new_archive.as_ref().ok_or_else(|| Error::invalid("active archive binding"))?)?;
        if plugin.exists("discard")? { plugin.remove_tree("discard")?; }
        if plugin.exists("pending")? { return Err(Error::invalid("committed transaction still has pending")); }
        plugin.unlink("transaction.json")?; return Ok(true);
    }
    restore(plugin, &journal)?; Ok(true)
}
fn restore(plugin: &Dir, journal: &Journal) -> Result<()> {
    if plugin.exists("rollback")? {
        assert_binding(&plugin.child("rollback", false)?, journal.old.as_ref())?;
        let expected = journal.old_archive.as_ref().ok_or_else(|| Error::invalid("rollback archive binding"))?;
        assert_archive(&plugin.child("rollback", false)?, expected)?;
        if plugin.exists("current")? { assert_binding(&plugin.child("current", false)?, journal.new.as_ref())?; plugin.remove_tree("current")?; }
        plugin.rename("rollback", "current")?;
    } else if plugin.exists("current")? {
        let current = plugin.child("current", false)?;
        let identity = current.identity()?;
        if journal.old.as_ref().is_some_and(|old| identity.same_file(old)) { /* Swap had not renamed the old version. */ }
        else if journal.old.is_none() { assert_binding(&current, journal.new.as_ref())?; drop(current); plugin.remove_tree("current")?; }
        else { return Err(Error::new("OC_PLUGIN_INTERRUPTED", "Old package is missing; retaining current package and journal")); }
    }
    if plugin.exists("pending")? { assert_binding(&plugin.child("pending", false)?, journal.new.as_ref())?; plugin.remove_tree("pending")?; }
    plugin.unlink("transaction.json")
}
