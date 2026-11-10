use super::*;
use crate::resources::ResourceBudget;
use std::{io::{Cursor, Write}, os::unix::fs::PermissionsExt};
use sha2::{Digest, Sha256};

fn manifest(version: &str) -> PluginManifest {
    PluginManifest { id: "system".into(), version: version.into(), api_version: 2, target: "aarch64-apple-darwin".into(), name: "系统".into(), name_en: "System".into(), description: "测试包".into(), description_en: "Test package".into(), publisher: "OC Chan".into(), section: MonitorSection::System, min_app_version: "0.1.0".into(), platforms: vec!["darwin".into()], permissions: vec!["system-metrics".into()] }
}
fn fixture(version: &str) -> (CatalogEntry, Vec<u8>) {
    let manifest = manifest(version); let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
    let mut info = plist::Dictionary::new();
    for (key, value) in [("CFBundleExecutable", "collector"), ("CFBundleIdentifier", "local.oc-chan.plugin.system"), ("CFBundleVersion", version), ("CFBundleShortVersionString", version), ("CFBundlePackageType", "BNDL")] { info.insert(key.into(), plist::Value::String(value.into())); }
    let mut info_bytes = Vec::new(); plist::Value::Dictionary(info).to_writer_xml(&mut info_bytes).unwrap();
    let mut resource = plist::Dictionary::new(); resource.insert("hash2".into(), plist::Value::Data(Sha256::digest(&manifest_bytes).to_vec()));
    let mut files = plist::Dictionary::new(); files.insert("Resources/manifest.json".into(), plist::Value::Dictionary(resource));
    let mut seal = plist::Dictionary::new(); seal.insert("files2".into(), plist::Value::Dictionary(files));
    let mut seal_bytes = Vec::new(); plist::Value::Dictionary(seal).to_writer_xml(&mut seal_bytes).unwrap();
    // Header fixture is only used by the archive parser; it is never executable
    // and cannot pass the independent codesign gate.
    let mut header = vec![0u8; 32]; header[..4].copy_from_slice(&0xfeedfacfu32.to_le_bytes()); header[4..8].copy_from_slice(&0x0100000cu32.to_le_bytes()); header[12..16].copy_from_slice(&2u32.to_le_bytes());
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).unix_permissions(0o600);
    for (name, bytes) in [("Contents/Info.plist", info_bytes), ("Contents/MacOS/collector", header), ("Contents/Resources/manifest.json", manifest_bytes), ("Contents/_CodeSignature/CodeResources", seal_bytes)] {
        zip.start_file(format!("system.ocbundle/{name}"), options).unwrap(); zip.write_all(&bytes).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    (CatalogEntry { manifest, package: format!("system-{version}.ocplugin"), sha256: oc_plugin_sdk::digest(&bytes), bytes: bytes.len() }, bytes)
}
fn temp_profile() -> tempfile::TempDir { let parent = std::env::temp_dir().canonicalize().unwrap(); let dir = tempfile::tempdir_in(parent).unwrap(); std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap(); dir }
async fn disk(profile: &tempfile::TempDir) -> Disk { Disk::open(BoundedIo::new(ResourceBudget::default()), profile.path().to_owned(), &CancellationToken::new()).await.unwrap() }
async fn stage(disk: &Disk, version: &str) -> CatalogEntry {
    let (entry, bytes) = fixture(version); let installed = Installed { entry: entry.clone(), source: Source::Bundled };
    disk.prepare(installed.clone(), &CancellationToken::new()).await.unwrap();
    disk.run(model::ARCHIVE_BYTES, &CancellationToken::new(), move |root, cancel| root.child("system", false)?.child("pending", false)?.write("archive.ocplugin", &bytes, &cancel)).await.unwrap();
    disk.extract(installed, "0.1.0".into(), &CancellationToken::new()).await.unwrap(); entry
}
#[test]
fn rejects_legacy_commonjs_and_unknown_permissions() {
    let mut manifest = manifest("1.0.0"); manifest.api_version = 1; assert_eq!(manifest.validate("0.1.0").unwrap_err().code, "OC_PLUGIN_FORMAT");
    manifest.api_version = 2; manifest.permissions.push("arbitrary-shell".into()); assert_eq!(manifest.validate("0.1.0").unwrap_err().code, "OC_PLUGIN_CAPABILITY");
    assert!(archive::inspect(br#"{"schema":1,"code":"module.exports={}"}"#, &fixture("1.0.0").0, "0.1.0", None, None, &CancellationToken::new()).is_err());
}
#[test]
fn archive_authenticates_manifest_header_crc_and_digest() {
    let (entry, bytes) = fixture("1.0.0"); let cancel = CancellationToken::new();
    let info = archive::inspect(&bytes, &entry, "0.1.0", None, None, &cancel).unwrap(); assert_eq!(info.files.len(), 4); assert!(info.expanded < model::EXPANDED_BYTES as u64);
    let mut changed = bytes.clone(); changed[40] ^= 1; assert!(archive::inspect(&changed, &entry, "0.1.0", None, None, &cancel).is_err());
    let mut false_manifest = entry.clone(); false_manifest.manifest.version = "2.0.0".into(); assert!(archive::inspect(&bytes, &false_manifest, "0.1.0", None, None, &cancel).is_err());
    let mut central = bytes.clone(); let end = central.len() - 22; central[end + 10..end + 12].copy_from_slice(&17u16.to_le_bytes()); let mut changed_entry = entry; changed_entry.sha256 = oc_plugin_sdk::digest(&central);
    assert!(archive::inspect(&central, &changed_entry, "0.1.0", None, None, &cancel).is_err());
}
#[tokio::test]
async fn restart_restores_rollback_after_current_swap() {
    let profile = temp_profile(); let disk = disk(&profile).await;
    stage(&disk, "1.0.0").await; disk.swap("system".into(), &CancellationToken::new()).await.unwrap(); disk.commit("system".into()).await.unwrap();
    stage(&disk, "2.0.0").await; disk.swap("system".into(), &CancellationToken::new()).await.unwrap();
    let recovered = disk.recover(&CancellationToken::new()).await.unwrap(); assert_eq!(recovered.len(), 1); assert_eq!(recovered[0].installed.as_ref().unwrap().entry.manifest.version, "1.0.0"); assert_eq!(recovered[0].error.as_ref().unwrap().code, "OC_PLUGIN_INTERRUPTED");
    let installed = disk.inspect("system".into(), "current", "0.1.0".into(), &CancellationToken::new()).await.unwrap(); assert_eq!(installed.entry.manifest.version, "1.0.0");
    assert!(!profile.path().join("plugins-v2/system/rollback").exists()); assert!(!profile.path().join("plugins-v2/system/pending").exists());
}
#[tokio::test]
async fn interrupted_first_install_recovers_to_uninstalled() {
    let profile = temp_profile(); let disk = disk(&profile).await;
    stage(&disk, "1.0.0").await; disk.swap("system".into(), &CancellationToken::new()).await.unwrap();
    let recovered = disk.recover(&CancellationToken::new()).await.unwrap(); assert!(!recovered[0].present); assert!(recovered[0].installed.is_none()); assert!(recovered[0].error.is_some());
}
#[tokio::test]
async fn rollback_after_failed_upgrade_preserves_exact_old_package() {
    let profile = temp_profile(); let disk = disk(&profile).await; let old = stage(&disk, "1.0.0").await;
    disk.swap("system".into(), &CancellationToken::new()).await.unwrap(); disk.commit("system".into()).await.unwrap();
    stage(&disk, "2.0.0").await; disk.swap("system".into(), &CancellationToken::new()).await.unwrap(); disk.rollback("system".into()).await.unwrap();
    let actual = disk.inspect("system".into(), "current", "0.1.0".into(), &CancellationToken::new()).await.unwrap(); assert_eq!(actual.entry, old);
}
#[tokio::test]
async fn installed_tampering_is_detected_but_explicit_remove_succeeds() {
    let profile = temp_profile(); let disk = disk(&profile).await;
    stage(&disk, "1.0.0").await; disk.swap("system".into(), &CancellationToken::new()).await.unwrap(); disk.commit("system".into()).await.unwrap();
    let file = profile.path().join("plugins-v2/system/current/system.ocbundle/Contents/Resources/manifest.json"); std::fs::write(&file, b"{}").unwrap();
    assert!(disk.inspect("system".into(), "current", "0.1.0".into(), &CancellationToken::new()).await.is_err());
    disk.remove("system".into()).await.unwrap(); assert!(!profile.path().join("plugins-v2/system").exists());
}
#[tokio::test]
async fn private_root_refuses_symlink_and_hardlink_inputs() {
    let profile = temp_profile(); let outside = temp_profile();
    std::os::unix::fs::symlink(outside.path(), profile.path().join("plugins-v2")).unwrap();
    assert!(Disk::open(BoundedIo::new(ResourceBudget::default()), profile.path().to_owned(), &CancellationToken::new()).await.is_err());
    let profile = temp_profile(); let disk = disk(&profile).await; stage(&disk, "1.0.0").await;
    let original = profile.path().join("plugins-v2/system/pending/archive.ocplugin"); std::fs::hard_link(&original, outside.path().join("alias")).unwrap();
    assert!(disk.inspect("system".into(), "pending", "0.1.0".into(), &CancellationToken::new()).await.is_err());
}
#[test]
fn catalog_rejects_count_duplicate_id_unbounded_version_and_path() {
    let (entry, _) = fixture("1.0.0");
    let bytes = serde_json::to_vec(&Catalog { schema: 1, plugins: vec![entry.clone(), entry] }).unwrap(); assert!(Catalog::parse(&bytes, "0.1.0").is_err());
    for path in ["../escape.ocplugin", "/root.ocplugin", "a%2fb.ocplugin", "a.ocplugin?token=private"] { assert!(model::package_name(path).is_err()); }
    assert!(model::version(&"1".repeat(65)).is_err());
}

#[test]
fn archive_rejects_zip64_links_path_aliases_and_preallocation_limits() {
    let (entry, original) = fixture("1.0.0");
    let central = original.windows(4).position(|bytes| bytes == b"PK\x01\x02").unwrap();
    let reject = |bytes: Vec<u8>| {
        let mut candidate = entry.clone(); candidate.bytes = bytes.len(); candidate.sha256 = oc_plugin_sdk::digest(&bytes);
        assert!(archive::inspect(&bytes, &candidate, "0.1.0", None, None, &CancellationToken::new()).is_err());
    };
    let mut bytes = original.clone(); bytes[central + 38..central + 42].copy_from_slice(&((0o120777u32) << 16).to_le_bytes()); reject(bytes);
    let mut bytes = original.clone(); bytes[central + 24..central + 28].copy_from_slice(&u32::MAX.to_le_bytes()); reject(bytes);
    let mut bytes = original.clone(); let end = bytes.len() - 22; bytes[end + 12..end + 16].copy_from_slice(&((model::CENTRAL_BYTES + 1) as u32).to_le_bytes()); reject(bytes);
    let mut bytes = original.clone(); bytes[central + 46] = b'/'; reject(bytes);
    let mut bytes = original.clone(); bytes[central + 8..central + 10].copy_from_slice(&1u16.to_le_bytes()); reject(bytes);
    let mut bytes = original; bytes.resize(model::ARCHIVE_BYTES + 1, 0); reject(bytes);
}
#[tokio::test]
async fn cancellation_waits_for_stage_cleanup_and_refunds_file_budget() {
    let profile = temp_profile(); let resources = ResourceBudget::default(); let io = BoundedIo::new(resources.clone());
    let disk = Disk::open(io.clone(), profile.path().to_owned(), &CancellationToken::new()).await.unwrap();
    let entry = stage(&disk, "1.0.0").await; let cancel = CancellationToken::new(); cancel.cancel();
    assert!(disk.extract(Installed { entry, source: Source::Bundled }, "0.1.0".into(), &cancel).await.unwrap_err().is_cancelled());
    disk.rollback("system".into()).await.unwrap();
    assert!(!profile.path().join("plugins-v2/system").exists()); assert_eq!(resources.snapshot().global.current.files, 0); io.shutdown().await.unwrap();
}
#[tokio::test]
async fn restart_after_first_rename_restores_old_and_cleans_pending() {
    let profile = temp_profile(); let disk = disk(&profile).await;
    stage(&disk, "1.0.0").await; disk.swap("system".into(), &CancellationToken::new()).await.unwrap(); disk.commit("system".into()).await.unwrap();
    stage(&disk, "2.0.0").await; disk.swap("system".into(), &CancellationToken::new()).await.unwrap();
    disk.run(0, &CancellationToken::new(), |root, _| root.child("system", false)?.rename("current", "pending")).await.unwrap();
    let recovered = disk.recover(&CancellationToken::new()).await.unwrap(); assert_eq!(recovered[0].installed.as_ref().unwrap().entry.manifest.version, "1.0.0");
    assert!(!profile.path().join("plugins-v2/system/pending").exists());
}
#[tokio::test]
async fn restart_during_committed_rollback_deletion_keeps_new_version() {
    let profile = temp_profile(); let disk = disk(&profile).await;
    stage(&disk, "1.0.0").await; disk.swap("system".into(), &CancellationToken::new()).await.unwrap(); disk.commit("system".into()).await.unwrap();
    stage(&disk, "2.0.0").await; disk.swap("system".into(), &CancellationToken::new()).await.unwrap();
    disk.run(32 * 1024, &CancellationToken::new(), |root, cancel| {
        let plugin = root.child("system", false)?;
        let mut journal: serde_json::Value = serde_json::from_slice(&plugin.read("transaction.json", 16 * 1024, &cancel)?).unwrap();
        journal["state"] = serde_json::Value::String("active".into()); plugin.atomic("transaction.json", &serde_json::to_vec(&journal).unwrap())?;
        plugin.rename("rollback", "discard")?;
        plugin.child("discard", false)?.child("system.ocbundle", false)?.child("Contents", false)?.child("Resources", false)?.unlink("manifest.json")
    }).await.unwrap();
    let recovered = disk.recover(&CancellationToken::new()).await.unwrap(); assert_eq!(recovered[0].installed.as_ref().unwrap().entry.manifest.version, "2.0.0");
    assert!(!profile.path().join("plugins-v2/system/discard").exists());
}
#[tokio::test]
async fn invalid_journal_is_retained_and_remains_explicitly_removable() {
    let profile = temp_profile(); let disk = disk(&profile).await; stage(&disk, "1.0.0").await;
    std::fs::write(profile.path().join("plugins-v2/system/transaction.json"), b"invalid").unwrap();
    let recovered = disk.recover(&CancellationToken::new()).await.unwrap(); assert!(recovered[0].present); assert!(recovered[0].error.is_some());
    disk.remove("system".into()).await.unwrap(); assert!(!profile.path().join("plugins-v2/system").exists());
}
