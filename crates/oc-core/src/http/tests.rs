use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

fn metadata() -> HttpRequest {
    HttpRequest { purpose: HttpPurpose::Marketplace, url: format!("{MARKET_BASE}catalog.json"), target: None, target_parent: None,
        max_bytes: METADATA_LIMIT, expected_size: None, timeout_ms: 30_000, disk_budget: None }
}
fn frame(frame: Frame) -> Vec<u8> { let mut bytes = Vec::new(); emit(&mut bytes, frame).unwrap(); bytes }
fn complete(body: &[u8]) -> Frame { Frame::Complete { v: VERSION, bytes: body.len() as u64, sha256: format!("{:x}", Sha256::digest(body)), sha512: STANDARD.encode(Sha512::digest(body)), file_identity: None } }
fn profile() -> tempfile::TempDir {
    let root = std::env::temp_dir().canonicalize().unwrap(); let dir = tempfile::tempdir_in(root).unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap(); dir
}
#[test]
fn response_reassembles_fragmented_frames_and_checks_both_hashes() {
    let body = vec![b'x'; METADATA_LIMIT]; let mut parser = Parser::new(metadata(), None);
    for (seq, bytes) in body.chunks(CHUNK).enumerate() {
        let encoded = frame(Frame::Data { v: VERSION, seq: seq as u64, data: STANDARD.encode(bytes) });
        for fragment in encoded.chunks(7) { parser.push(fragment).unwrap(); }
    }
    parser.push(&frame(complete(&body))).unwrap(); let result = parser.finish().unwrap();
    assert_eq!(result.body, body); assert_eq!(result.bytes, METADATA_LIMIT as u64); assert!(result.file_identity.is_none());
}
#[test]
fn protocol_rejects_missing_duplicate_truncated_and_oversized_final_results() {
    assert!(Parser::new(metadata(), None).finish().is_err());
    let mut parser = Parser::new(metadata(), None); parser.push(b"{\"type\":").unwrap(); assert!(parser.finish().is_err());
    let mut parser = Parser::new(metadata(), None); assert!(parser.push(&vec![b'x'; FRAME_LIMIT + 1]).is_err());
    let mut parser = Parser::new(metadata(), None); parser.push(&frame(complete(b""))).unwrap(); assert!(parser.push(&frame(complete(b""))).is_err());
    let mut parser = Parser::new(metadata(), None); assert!(parser.push(&frame(Frame::Data { v: VERSION, seq: 1, data: STANDARD.encode(b"test") })).is_err());
    let mut parser = Parser::new(metadata(), None); assert!(parser.push(b"{\"type\":\"data\",\"v\":1,\"seq\":0,\"data\":\"dGVzdA==\",\"unknown\":1}\n").is_err());
    let mut parser = Parser::new(metadata(), None); parser.push(&frame(Frame::Data { v: VERSION, seq: 0, data: STANDARD.encode(b"test") })).unwrap(); assert!(parser.push(&frame(complete(b"other"))).is_err());
}
#[test]
fn metadata_limit_and_progress_are_checked_before_growing_body() {
    let mut request = metadata(); request.max_bytes = 3; let mut parser = Parser::new(request, None);
    assert!(parser.push(&frame(Frame::Data { v: VERSION, seq: 0, data: STANDARD.encode(b"four") })).is_err()); assert_eq!(parser.body.capacity(), 0);
    let mut parser = Parser::new(metadata(), None);
    parser.push(&frame(Frame::Progress { v: VERSION, received_bytes: 8, total_bytes: Some(10) })).unwrap();
    assert!(parser.push(&frame(Frame::Progress { v: VERSION, received_bytes: 7, total_bytes: Some(10) })).is_err());
    let mut parser = Parser::new(metadata(), Some(Arc::new(|_| Err(Error::cancelled()))));
    assert!(parser.push(&frame(Frame::Progress { v: VERSION, received_bytes: 1, total_bytes: Some(10) })).unwrap_err().is_cancelled());
}
#[test]
fn failed_worker_is_not_a_successful_empty_body() {
    let mut parser = Parser::new(metadata(), None);
    parser.push(&frame(Frame::Failure { v: VERSION, error: Error::new("OC_HTTP_NETWORK", "TLS verification failed") })).unwrap();
    assert_eq!(parser.finish().unwrap_err().code, "OC_HTTP_NETWORK");
}
#[test]
fn source_policy_rejects_escape_and_allows_only_named_update_assets() {
    metadata().validate().unwrap();
    for url in ["http://raw.githubusercontent.com/Zixiaobowen/oc-chan/main/plugin-market/catalog.json", "https://evil.example/catalog.json", "https://raw.githubusercontent.com/Zixiaobowen/oc-chan/main/plugin-market/../other", "https://raw.githubusercontent.com/Zixiaobowen/oc-chan/main/plugin-market/a.ocplugin?private=1", "https://name@raw.githubusercontent.com/Zixiaobowen/oc-chan/main/plugin-market/catalog.json"] {
        assert!(validate_url(HttpPurpose::Marketplace, &reqwest::Url::parse(url).unwrap(), false).is_err());
    }
    for suffix in ["latest/download/latest.json", "download/v1.2.3/OC-Chan-1.2.3-mac-arm64.zip"] { validate_url(HttpPurpose::Update, &reqwest::Url::parse(&format!("{RELEASE_BASE}{suffix}")).unwrap(), false).unwrap(); }
    for suffix in ["latest/download/latest.yml", "download/v1.2.3/OC-Chan-1.2.4-mac-arm64.zip", "download/v1.2.3-beta/OC-Chan-1.2.3-beta-mac-arm64.zip", "download/v1.2.3/OC-Chan-1.2.3-mac-x64.zip"] { assert!(validate_url(HttpPurpose::Update, &reqwest::Url::parse(&format!("{RELEASE_BASE}{suffix}")).unwrap(), false).is_err()); }
    validate_url(HttpPurpose::Update, &reqwest::Url::parse("https://release-assets.githubusercontent.com/path?signature=opaque").unwrap(), true).unwrap();
    assert!(validate_url(HttpPurpose::Update, &reqwest::Url::parse("https://release-assets.githubusercontent.com.evil.example/path").unwrap(), true).is_err());
    assert!(validate_url(HttpPurpose::Update, &reqwest::Url::parse("https://objects.githubusercontent.com:444/path").unwrap(), true).is_err());
    let mut request = metadata(); request.max_bytes += 1; assert!(request.validate().is_err());
    let mut encoded = serde_json::to_value(metadata()).unwrap(); encoded["unknown"] = serde_json::json!(true); assert!(serde_json::from_value::<HttpRequest>(encoded).is_err());
}
#[test]
fn target_is_exclusive_private_and_bound_to_real_parent_identity() {
    let dir = profile(); let parent = Directory::open(dir.path(), true).unwrap(); let identity = parent.identity().unwrap(); parent.close().unwrap();
    let path = dir.path().join("archive.part"); let mut target = Target::create(&path, &identity, None).unwrap(); target.file.write_all(b"real bytes").unwrap();
    let saved = target.finish(10).unwrap(); target.close().unwrap();
    assert_eq!(saved.size, 10); assert_eq!(saved.mode & 0o777, 0o600); assert_eq!(std::fs::read(&path).unwrap(), b"real bytes");
    assert!(Target::create(&path, &identity, None).is_err()); assert_eq!(std::fs::read(&path).unwrap(), b"real bytes");
    let mut replaced = identity; replaced.ino += 1; assert!(Target::create(&dir.path().join("new.part"), &replaced, None).is_err());
    assert!(!dir.path().join("new.part").exists());
    symlink(&path, dir.path().join("link.part")).unwrap(); assert!(Target::create(&dir.path().join("link.part"), &replaced, None).is_err());
    symlink(dir.path(), dir.path().join("linked-parent")).unwrap(); assert!(Directory::open(&dir.path().join("linked-parent"), true).is_err());
}
#[test]
fn target_name_replacement_and_installation_disk_overflow_are_visible() {
    let dir = profile(); let parent = Directory::open(dir.path(), true).unwrap(); let identity = parent.identity().unwrap();
    let path = dir.path().join("archive.part"); let target = Target::create(&path, &identity, None).unwrap();
    std::fs::rename(&path, dir.path().join("moved.part")).unwrap(); std::fs::write(&path, b"replacement").unwrap();
    assert!(target.finish(0).is_err()); target.close().unwrap();
    let sparse = File::create(dir.path().join("large")).unwrap(); sparse.set_len(MARKET_DISK + 1).unwrap(); close_fd(sparse.into_raw_fd()).unwrap();
    assert!(parent.usage(0).is_err()); parent.close().unwrap();
}

#[cfg(feature = "acceptance")]
#[test]
fn acceptance_feed_is_explicit_loopback_only_without_redirects() {
    let url = "http://127.0.0.1:23456/v2/catalog.json";
    validate_acceptance_market_url(url).unwrap();
    let mut request = metadata(); request.purpose = HttpPurpose::AcceptanceMarketplace; request.url = url.into(); request.validate().unwrap();
    assert!(validate_url(HttpPurpose::Marketplace, &reqwest::Url::parse(url).unwrap(), false).is_err());
    assert!(validate_url(HttpPurpose::AcceptanceMarketplace, &reqwest::Url::parse(url).unwrap(), true).is_err());
    for bad in ["http://localhost:23456/catalog.json", "https://127.0.0.1:23456/catalog.json", "http://127.0.0.2:23456/catalog.json", "http://127.0.0.1/catalog.json", "http://127.0.0.1:0/catalog.json", "http://user@127.0.0.1:23456/catalog.json", "http://127.0.0.1:23456/a/../catalog.json", "http://127.0.0.1:23456/a//catalog.json", "http://127.0.0.1:23456/%63atalog.json", "http://127.0.0.1:23456/catalog.json?x=1", "http://127.0.0.1:23456/catalog.json#x"] {
        assert!(validate_acceptance_market_url(bad).is_err(), "{bad}");
    }
}

#[cfg(not(feature = "acceptance"))]
#[test]
fn production_worker_cannot_deserialize_acceptance_purpose() {
    let mut value = serde_json::to_value(metadata()).unwrap(); value["purpose"] = "acceptanceMarketplace".into();
    assert!(serde_json::from_value::<HttpRequest>(value).is_err());
}
