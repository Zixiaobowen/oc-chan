//! These tests require this build's actual signed native resource package. They do
//! not synthesize a runnable binary or bypass archive/codesign verification.
use super::*;
use crate::{plugins::{RegistryEvent, SnapshotData}, resources::ResourceBudget};
use std::{os::unix::fs::PermissionsExt, sync::atomic::AtomicUsize};

fn assets(prefix: &str) -> BundledAssets {
    BundledAssets {
        directory: PathBuf::from(std::env::var(format!("{prefix}_RESOURCES")).expect("explicit native acceptance resources path is required")).canonicalize().unwrap(),
        catalog_sha256: std::env::var(format!("{prefix}_CATALOG_SHA256")).expect("explicit independently pinned catalog SHA256 is required"),
    }
}
fn options(profile: PathBuf, assets: BundledAssets, io: BoundedIo, registry: Arc<Registry>, enabled: bool) -> MarketplaceOptions {
    options_with_roots(profile, assets, io, registry, enabled, Vec::new())
}
fn options_with_roots(profile: PathBuf, assets: BundledAssets, io: BoundedIo, registry: Arc<Registry>, enabled: bool, fixture_roots: Vec<BundledAssets>) -> MarketplaceOptions {
    MarketplaceOptions { profile, bundled: assets, host_bundle: std::env::current_exe().unwrap(), host_bundle_id: trust::HOST_BUNDLE_ID.into(), app_version: "0.1.0".into(), io, registry,
        worker: std::env::var_os("OC_DATA_WORKER").map(PathBuf::from).expect("acceptance requires the built oc-data-worker path"),
        enabled: Arc::new(move |_| enabled), changed: Arc::new(|_| {}), fixture_roots }
}
#[tokio::test]
#[ignore = "requires the release resource package and OC_ACCEPTANCE_PLUGIN_RESOURCES/OC_ACCEPTANCE_PLUGIN_CATALOG_SHA256"]
async fn real_native_dormant_install_hundred_cycles_restart_and_damage_uninstall() {
    let profile = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap(); std::fs::set_permissions(profile.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let resource = ResourceBudget::default(); let io = BoundedIo::new(resource.clone());
    let publications = Arc::new(AtomicUsize::new(0)); let observed = publications.clone();
    let registry = Registry::new(io.clone(), Arc::new(move |event| {
        if let RegistryEvent::Snapshot(publication) = event {
            if let SnapshotData::System(snapshot) = publication.snapshot {
                assert!(snapshot.memory_total > 0); assert!(snapshot.cpu_cores > 0); assert!(!snapshot.hostname.is_empty());
                assert!(snapshot.sources.iter().any(|source| source.id == "collection-resources"));
                observed.fetch_add(1, Ordering::SeqCst);
            }
        }
    }));
    let market = Marketplace::open(options(profile.path().to_owned(), assets("OC_ACCEPTANCE_PLUGIN"), io.clone(), registry.clone(), false), &CancellationToken::new()).await.unwrap();
    let result = market.install("system").await.unwrap(); assert!(result.error.is_none(), "{:?}", result.error); assert!(result.items.iter().any(|item| item.manifest.id == "system" && item.installed && !item.enabled));
    assert_eq!(resource.snapshot().global.current.plugin_processes, 0); assert_eq!(publications.load(Ordering::SeqCst), 0);
    for _ in 0..100 {
        registry.set_enabled("system", true).await.unwrap(); registry.refresh(Some(MonitorSection::System), None).await.unwrap();
        registry.set_enabled("system", false).await.unwrap();
        let current = resource.snapshot().global.current;
        assert_eq!(current.plugin_processes, 0); assert_eq!(current.commands, 0); assert_eq!(current.files, 0);
    }
    assert!(publications.load(Ordering::SeqCst) >= 200);
    market.close().await.unwrap(); registry.close().await.unwrap(); drop(market); drop(registry);
    let registry = Registry::new(io.clone(), Arc::new(|_| {}));
    let market = Marketplace::open(options(profile.path().to_owned(), assets("OC_ACCEPTANCE_PLUGIN"), io.clone(), registry.clone(), false), &CancellationToken::new()).await.unwrap();
    assert!(market.snapshot().items.iter().any(|item| item.manifest.id == "system" && item.installed && item.error.is_none()));
    market.close().await.unwrap(); registry.close().await.unwrap(); drop(market); drop(registry);
    std::fs::write(profile.path().join("plugins-v2/system/current/system.ocbundle/Contents/Resources/manifest.json"), b"{}").unwrap();
    let registry = Registry::new(io.clone(), Arc::new(|_| {}));
    let market = Marketplace::open(options(profile.path().to_owned(), assets("OC_ACCEPTANCE_PLUGIN"), io.clone(), registry.clone(), false), &CancellationToken::new()).await.unwrap();
    assert!(market.snapshot().items.iter().any(|item| item.manifest.id == "system" && item.installed && item.error.is_some()));
    assert!(market.uninstall("system").await.unwrap().error.is_none()); assert!(!profile.path().join("plugins-v2/system").exists());
    market.close().await.unwrap(); registry.close().await.unwrap(); io.shutdown().await.unwrap();
}
#[path = "remote_acceptance_tests.rs"]
mod remote;
