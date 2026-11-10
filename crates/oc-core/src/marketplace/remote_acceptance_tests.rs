//! Real local TCP, the actual HTTP worker, signed native archives and SDK process.
//! The server only serves fixture bytes; it never supplies collector responses.
use super::*;
use std::{path::Path, sync::atomic::Ordering};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, sync::Notify};

#[derive(Clone)]
struct Variant { assets: BundledAssets, entry: CatalogEntry, catalog: Arc<Vec<u8>>, archive: Arc<Vec<u8>> }
fn bounded_fixture(path: &Path, maximum: usize) -> Vec<u8> {
    assert!(std::fs::metadata(path).unwrap().len() <= maximum as u64);
    let bytes = std::fs::read(path).unwrap(); assert!(bytes.len() <= maximum); bytes
}
fn variants() -> [Variant; 3] {
    let path = PathBuf::from(std::env::var_os("OC_ACCEPTANCE_MARKET_FIXTURES").expect("explicit fixtures.json from build-marketplace-fixtures.mjs is required"));
    let record: serde_json::Value = serde_json::from_slice(&bounded_fixture(&path, 64 * 1024)).unwrap(); assert_eq!(record["schema"], 1);
    ["v1", "v2", "v3"].map(|name| {
        let value = &record["variants"][name]; let directory = PathBuf::from(value["directory"].as_str().unwrap()).canonicalize().unwrap();
        let catalog = bounded_fixture(&directory.join("catalog.json"), model::CATALOG_BYTES);
        let digest = value["catalog_sha256"].as_str().unwrap().to_owned(); assert_eq!(oc_plugin_sdk::digest(&catalog), digest);
        let parsed = Catalog::parse(&catalog, "0.1.0").unwrap(); assert_eq!(parsed.plugins.len(), 1); let entry = parsed.plugins.into_iter().next().unwrap();
        let archive = bounded_fixture(&directory.join(&entry.package), model::ARCHIVE_BYTES); assert_eq!(archive.len(), entry.bytes); assert_eq!(oc_plugin_sdk::digest(&archive), entry.sha256);
        Variant { assets: BundledAssets { directory, catalog_sha256: digest }, entry, catalog: Arc::new(catalog), archive: Arc::new(archive) }
    })
}
#[derive(Clone, Copy)]
enum Delivery { Normal, Slow, Tampered }
struct Server {
    url: String, reply: Arc<Mutex<(Variant, Delivery)>>, started: Arc<Notify>, cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<std::io::Result<()>>>, requests: Arc<AtomicUsize>,
}
impl Server {
    async fn start(variant: Variant) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let url = format!("http://{}/catalog.json", listener.local_addr().unwrap());
        let reply = Arc::new(Mutex::new((variant, Delivery::Normal))); let shared = reply.clone();
        let cancel = CancellationToken::new(); let stopping = cancel.clone(); let started = Arc::new(Notify::new()); let signal = started.clone();
        let requests = Arc::new(AtomicUsize::new(0)); let count = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let (socket, _) = tokio::select! { _ = stopping.cancelled() => return Ok(()), result = listener.accept() => result? };
                let (variant, mode) = shared.lock().unwrap().clone(); count.fetch_add(1, Ordering::SeqCst);
                tokio::select! { _ = stopping.cancelled() => return Ok(()), result = serve(socket, variant, mode, signal.clone()) => result? }
            }
        });
        Self { url, reply, started, cancel, task: Some(task), requests }
    }
    fn select(&self, variant: &Variant, mode: Delivery) { *self.reply.lock().unwrap() = (variant.clone(), mode); }
    async fn close(mut self) { self.cancel.cancel(); self.task.take().unwrap().await.unwrap().unwrap(); }
}
impl Drop for Server { fn drop(&mut self) { self.cancel.cancel(); } }
async fn serve(mut socket: TcpStream, variant: Variant, mode: Delivery, started: Arc<Notify>) -> std::io::Result<()> {
    let mut request = Vec::with_capacity(1024); let mut chunk = [0u8; 1024];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        let n = socket.read(&mut chunk).await?;
        if n == 0 || request.len() + n > 8192 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bounded fixture HTTP request")); }
        request.extend_from_slice(&chunk[..n]);
    }
    let request = std::str::from_utf8(&request).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "fixture HTTP encoding"))?;
    let resource = request.lines().next().and_then(|line| line.strip_prefix("GET ")).and_then(|line| line.strip_suffix(" HTTP/1.1")).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "fixture GET"))?;
    let catalog = resource == "/catalog.json";
    if !catalog && resource != format!("/{}", variant.entry.package) { return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "unlisted fixture package")); }
    let body = if catalog { variant.catalog } else { variant.archive };
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await?;
    if !catalog && matches!(mode, Delivery::Slow) {
        socket.write_all(&body[..body.len().min(16 * 1024)]).await?; socket.flush().await?; started.notify_one();
        match socket.read(&mut [0u8; 1]).await {
            Ok(0) => return Ok(()),
            Err(error) if matches!(error.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe) => return Ok(()),
            Err(error) => return Err(error),
            Ok(_) => return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "unexpected data while awaiting cancelled HTTP worker")),
        }
    }
    if !catalog && matches!(mode, Delivery::Tampered) {
        let mut corrupt = (*body).clone(); let index = corrupt.len() / 2; corrupt[index] ^= 1; socket.write_all(&corrupt).await?;
    } else { socket.write_all(&body).await?; }
    socket.shutdown().await
}
async fn select_feed(market: &Arc<Marketplace>, server: &Server, variant: &Variant, all: &[Variant; 3]) {
    market.set_acceptance_feed(AcceptanceFeed { catalog_url: server.url.clone(), catalog_sha256: variant.assets.catalog_sha256.clone(), trusted_assets: all.iter().map(|value| value.assets.clone()).collect() }).await.unwrap();
    let checked = market.check().await.unwrap(); assert!(checked.catalog_error.is_none(), "{:?}", checked.catalog_error);
}
fn installed(market: &Marketplace) -> String {
    market.snapshot().items.iter().find(|item| item.manifest.id == "system").unwrap().installed_version.clone().unwrap()
}
fn http_drained(resources: &ResourceBudget) {
    let snapshot = resources.snapshot(); let source = snapshot.sources.iter().find(|source| source.source == "http").expect("actual HTTP worker must be accounted");
    assert_eq!(source.statistics.current.commands, 0); assert_eq!(source.statistics.current.files, 0); assert_eq!(source.statistics.current.sockets, 0);
}

#[tokio::test]
#[ignore = "requires OC_ACCEPTANCE_MARKET_FIXTURES and actual OC_DATA_WORKER built with acceptance"]
async fn real_http_cancel_upgrade_failed_native_activation_and_tamper_retain_live_version() {
    let all = variants(); let [v1, v2, v3] = &all;
    let profile = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap(); std::fs::set_permissions(profile.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let resources = ResourceBudget::default(); let io = BoundedIo::new(resources.clone()); let publications = Arc::new(AtomicUsize::new(0)); let observed = publications.clone();
    let registry = Registry::new(io.clone(), Arc::new(move |event| { if let RegistryEvent::Snapshot(publication) = event { if let SnapshotData::System(snapshot) = publication.snapshot { assert!(snapshot.memory_total > 0); observed.fetch_add(1, Ordering::SeqCst); } } }));
    let market = Marketplace::open(options(profile.path().to_owned(), v1.assets.clone(), io.clone(), registry.clone(), true), &CancellationToken::new()).await.unwrap();
    let initial = market.install("system").await.unwrap(); assert!(initial.error.is_none(), "initial bundled install failed: {:?}", initial.error); assert_eq!(installed(&market), v1.entry.manifest.version); assert!(publications.load(Ordering::SeqCst) > 0);
    let server = Server::start(v2.clone()).await;
    market.set_acceptance_feed(AcceptanceFeed { catalog_url: server.url.clone(), catalog_sha256: "0".repeat(64), trusted_assets: vec![v1.assets.clone()] }).await.unwrap();
    assert!(market.check().await.unwrap().catalog_error.is_some());
    market.set_acceptance_feed(AcceptanceFeed { catalog_url: server.url.clone(), catalog_sha256: v2.assets.catalog_sha256.clone(), trusted_assets: vec![v1.assets.clone()] }).await.unwrap();
    assert!(market.check().await.unwrap().catalog_error.is_some(), "untrusted native package was accepted from a pinned HTTP catalog");
    let initial_generation = registry.statuses().iter().find(|status| status.id == "system").unwrap().generation;
    select_feed(&market, &server, v2, &all).await; server.select(v2, Delivery::Slow);
    let update = { let market = market.clone(); tokio::spawn(async move { market.update("system").await }) };
    tokio::time::timeout(Duration::from_secs(10), server.started.notified()).await.unwrap();
    market.cancel().await.unwrap(); update.await.unwrap().unwrap();
    assert_eq!(installed(&market), v1.entry.manifest.version); assert!(!profile.path().join("plugins-v2/system/pending").exists()); http_drained(&resources);
    assert_eq!(registry.statuses().iter().find(|status| status.id == "system").unwrap().generation, initial_generation);
    registry.refresh(Some(MonitorSection::System), None).await.unwrap();
    server.select(v2, Delivery::Normal); let upgraded = market.update("system").await.unwrap(); assert!(upgraded.error.is_none(), "HTTP upgrade failed: {:?}", upgraded.error);
    assert_eq!(installed(&market), v2.entry.manifest.version); registry.set_enabled("system", false).await.unwrap(); registry.set_enabled("system", true).await.unwrap();
    let before_failure = publications.load(Ordering::SeqCst); server.select(v3, Delivery::Normal); select_feed(&market, &server, v3, &all).await;
    let previous_generation = registry.statuses().iter().find(|status| status.id == "system").unwrap().generation;
    let failed = market.update("system").await.unwrap(); assert!(failed.error.is_some(), "failed native activation unexpectedly succeeded: {:?}", failed.error); assert_eq!(installed(&market), v2.entry.manifest.version);
    let restored_generation = registry.statuses().iter().find(|status| status.id == "system").unwrap().generation;
    assert!(restored_generation > previous_generation, "native activation did not stop and restore the previous lifecycle");
    registry.refresh(Some(MonitorSection::System), None).await.unwrap(); assert!(publications.load(Ordering::SeqCst) > before_failure);
    assert!(!profile.path().join("plugins-v2/system/rollback").exists()); assert!(!profile.path().join("plugins-v2/system/pending").exists());
    server.select(v3, Delivery::Tampered); let tampered = market.update("system").await.unwrap(); assert!(tampered.error.is_some(), "tampered HTTP package unexpectedly succeeded: {:?}", tampered.error); assert_eq!(installed(&market), v2.entry.manifest.version);
    assert_eq!(registry.statuses().iter().find(|status| status.id == "system").unwrap().generation, restored_generation, "tampered download stopped the healthy installed generation");
    registry.refresh(Some(MonitorSection::System), None).await.unwrap(); http_drained(&resources); assert!(server.requests.load(Ordering::SeqCst) >= 6);
    let removed = market.uninstall("system").await.unwrap(); assert!(removed.error.is_none(), "uninstall failed: {:?}", removed.error); market.close().await.unwrap(); registry.close().await.unwrap(); io.shutdown().await.unwrap(); server.close().await;
    let usage = resources.snapshot().global.current; assert_eq!(usage.plugin_processes, 0); assert_eq!(usage.commands, 0); assert_eq!(usage.files, 0); assert_eq!(usage.sockets, 0);
}

#[tokio::test]
#[ignore = "requires OC_ACCEPTANCE_MARKET_FIXTURES and actual OC_DATA_WORKER built with acceptance"]
async fn real_http_upgrade_restart_requires_explicit_fixture_root_and_uninstall() {
    let all = variants(); let [v1, v2, _] = &all;
    let roots = || all.iter().map(|variant| variant.assets.clone()).collect::<Vec<_>>();
    let profile = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap(); std::fs::set_permissions(profile.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let resources = ResourceBudget::default(); let io = BoundedIo::new(resources.clone()); let publications = Arc::new(AtomicUsize::new(0));
    let observer = |publications: Arc<AtomicUsize>| Arc::new(move |event| {
        if let RegistryEvent::Snapshot(publication) = event { if let SnapshotData::System(snapshot) = publication.snapshot { assert!(snapshot.memory_total > 0); publications.fetch_add(1, Ordering::SeqCst); } }
    });

    // First process: install the bundled v1 and upgrade to v2 over real HTTP, both pinned by explicit roots.
    let registry = Registry::new(io.clone(), observer(publications.clone()));
    let market = Marketplace::open(options_with_roots(profile.path().to_owned(), v1.assets.clone(), io.clone(), registry.clone(), true, roots()), &CancellationToken::new()).await.unwrap();
    let initial = market.install("system").await.unwrap(); assert!(initial.error.is_none(), "bundled install failed: {:?}", initial.error); assert_eq!(installed(&market), v1.entry.manifest.version);
    let server = Server::start(v2.clone()).await; select_feed(&market, &server, v2, &all).await; server.select(v2, Delivery::Normal);
    let upgraded = market.update("system").await.unwrap(); assert!(upgraded.error.is_none(), "HTTP upgrade failed: {:?}", upgraded.error); assert_eq!(installed(&market), v2.entry.manifest.version);
    assert!(publications.load(Ordering::SeqCst) > 0); market.close().await.unwrap(); registry.close().await.unwrap(); drop(market); drop(registry); server.close().await;
    publications.store(0, Ordering::SeqCst);

    // Restart with the same explicit roots: the installed v2 package re-verifies and a real collector publishes memory_total.
    let registry = Registry::new(io.clone(), observer(publications.clone()));
    let market = Marketplace::open(options_with_roots(profile.path().to_owned(), v1.assets.clone(), io.clone(), registry.clone(), true, roots()), &CancellationToken::new()).await.unwrap();
    let snapshot = market.snapshot();
    let item = snapshot.items.iter().find(|item| item.manifest.id == "system").unwrap();
    assert!(item.installed && item.error.is_none(), "explicit roots did not retain the installed package: {:?}", item.error); assert_eq!(item.installed_version.as_deref(), Some(v2.entry.manifest.version.as_str()));
    registry.refresh(Some(MonitorSection::System), None).await.unwrap(); assert!(publications.load(Ordering::SeqCst) > 0, "restart collector never published a real system snapshot");
    market.close().await.unwrap(); registry.close().await.unwrap(); drop(market); drop(registry);

    // Without explicit roots the same installed package must be rejected rather than trusted from its writable directory.
    let registry = Registry::new(io.clone(), Arc::new(|_| {}));
    let market = Marketplace::open(options_with_roots(profile.path().to_owned(), v1.assets.clone(), io.clone(), registry.clone(), true, Vec::new()), &CancellationToken::new()).await.unwrap();
    let snapshot = market.snapshot();
    let item = snapshot.items.iter().find(|item| item.manifest.id == "system").unwrap();
    assert!(item.installed && item.error.is_some(), "installed fixture package was trusted without an explicit root");
    assert!(item.error.as_deref().is_some_and(|error| error.starts_with("OC_PLUGIN_ONLINE_DISABLED:")), "unexpected rejection: {:?}", item.error);
    assert_eq!(resources.snapshot().global.current.plugin_processes, 0, "untrusted installed package must not launch a collector");
    market.close().await.unwrap(); registry.close().await.unwrap(); drop(market); drop(registry);

    // Restore the roots so the healthy install can be uninstalled cleanly.
    let registry = Registry::new(io.clone(), Arc::new(|_| {}));
    let market = Marketplace::open(options_with_roots(profile.path().to_owned(), v1.assets.clone(), io.clone(), registry.clone(), true, roots()), &CancellationToken::new()).await.unwrap();
    assert!(market.snapshot().items.iter().any(|item| item.manifest.id == "system" && item.installed && item.error.is_none()));
    let removed = market.uninstall("system").await.unwrap(); assert!(removed.error.is_none(), "uninstall failed: {:?}", removed.error); assert!(!profile.path().join("plugins-v2/system").exists());
    market.close().await.unwrap(); registry.close().await.unwrap(); io.shutdown().await.unwrap();
    let usage = resources.snapshot().global.current; assert_eq!(usage.plugin_processes, 0); assert_eq!(usage.commands, 0); assert_eq!(usage.files, 0); assert_eq!(usage.sockets, 0);
}
