use super::*;
use serde_json::json;
use sha2::{Digest, Sha512};
use std::io::Write;
fn metadata() -> serde_json::Value {
    json!({"schema":2,"version":"0.2.0","assets":[{"target":TARGET,"name":"OC-Chan-0.2.0-mac-arm64.zip","size":17,"sha512":STANDARD.encode([0u8;64])}]})
}
#[test]
fn metadata_error_classification_uses_only_the_http_code() {
    let missing = metadata_error(Error::new("OC_HTTP_NOT_FOUND", "controlled transport detail"));
    assert_eq!(missing.code, "OC_UPDATE_METADATA_NOT_FOUND");
    assert_eq!(missing.message, "controlled transport detail");
    for code in ["OC_HTTP_STATUS", "OC_HTTP_NETWORK", "ETIMEDOUT", "ABORT_ERR"] {
        let original = Error::new(code, "HTTP source returned status 404");
        let expected = serde_json::to_value(&original).unwrap();
        assert_eq!(serde_json::to_value(metadata_error(original)).unwrap(), expected);
    }
}
#[test]
fn strict_metadata_selects_upgrade_and_validates_even_old_releases() {
    let bytes = serde_json::to_vec(&metadata()).unwrap(); let candidate = parse_metadata(&bytes, "0.1.0").unwrap().unwrap();
    assert_eq!(candidate.version, "0.2.0"); assert_eq!(candidate.asset.size, 17);
    assert_eq!(candidate.url(), "https://github.com/Zixiaobowen/oc-chan/releases/download/v0.2.0/OC-Chan-0.2.0-mac-arm64.zip");
    assert!(parse_metadata(&bytes, "0.2.0").unwrap().is_none());
    let mut invalid = metadata(); invalid["assets"][0]["size"] = json!(0);
    assert!(parse_metadata(&serde_json::to_vec(&invalid).unwrap(), "9.0.0").is_err());
    assert!(parse_metadata(&vec![b' '; MAX_METADATA_BYTES + 1], "0.1.0").is_err());
}
#[test]
fn rejects_unknown_duplicate_unstable_and_noncanonical_fields() {
    for version in ["v0.2.0", "0.2", "00.2.0", "0.2.0-rc.1", "0.2.0+build"] {
        let mut value = metadata(); value["version"] = json!(version);
        assert!(parse_metadata(&serde_json::to_vec(&value).unwrap(), "0.1.0").is_err(), "{version}");
    }
    for mutation in ["unknown", "asset-unknown", "duplicate", "size", "target", "name", "digest", "schema", "fractional"] {
        let mut value = metadata();
        match mutation {
            "unknown" => value["url"] = json!("https://evil.invalid"),
            "asset-unknown" => value["assets"][0]["url"] = json!("https://evil.invalid"),
            "duplicate" => { let asset = value["assets"][0].clone(); value["assets"].as_array_mut().unwrap().push(asset); },
            "size" => value["assets"][0]["size"] = json!(MAX_UPDATE_BYTES + 1),
            "target" => value["assets"][0]["target"] = json!("darwin-x64"),
            "name" => value["assets"][0]["name"] = json!("../OC-Chan-0.2.0-mac-arm64.zip"),
            "digest" => value["assets"][0]["sha512"] = json!("0".repeat(128)),
            "schema" => value["schema"] = json!(1),
            "fractional" => value["assets"][0]["size"] = json!(1.5),
            _ => unreachable!(),
        }
        assert!(parse_metadata(&serde_json::to_vec(&value).unwrap(), "0.1.0").is_err(), "{mutation}");
    }
    let duplicated = String::from_utf8(serde_json::to_vec(&metadata()).unwrap()).unwrap().replacen("\"schema\":2", "\"schema\":2,\"schema\":2", 1);
    assert!(parse_metadata(duplicated.as_bytes(), "0.1.0").is_err());
}
#[test]
fn maximum_asset_size_is_inclusive_and_asset_count_is_bounded() {
    let mut value = metadata(); value["assets"][0]["size"] = json!(MAX_UPDATE_BYTES);
    assert_eq!(parse_metadata(&serde_json::to_vec(&value).unwrap(), "0.1.0").unwrap().unwrap().asset.size, MAX_UPDATE_BYTES);
    let item = value["assets"][0].clone(); value["assets"] = json!(vec![item; 9]);
    assert!(parse_metadata(&serde_json::to_vec(&value).unwrap(), "0.1.0").is_err());
}
#[test]
fn progress_is_monotonic_throttled_and_uses_actual_elapsed_time() {
    let start = Instant::now(); let mut clock = ProgressClock::new(start);
    assert!(clock.observe(HttpProgress { received_bytes: 10, total_bytes: Some(100) }, 100, start + Duration::from_millis(249)).unwrap().is_none());
    let progress = clock.observe(HttpProgress { received_bytes: 20, total_bytes: Some(100) }, 100, start + Duration::from_millis(250)).unwrap().unwrap();
    assert_eq!(progress.percent, 20.0); assert_eq!(progress.bytes_per_second, 80.0);
    assert!(clock.observe(HttpProgress { received_bytes: 21, total_bytes: None }, 100, start + Duration::from_millis(251)).unwrap().is_none());
    assert!(clock.observe(HttpProgress { received_bytes: 19, total_bytes: None }, 100, start + Duration::from_millis(500)).is_err());
    assert!(clock.observe(HttpProgress { received_bytes: 101, total_bytes: None }, 100, start + Duration::from_millis(500)).is_err());
    assert!(clock.observe(HttpProgress { received_bytes: 50, total_bytes: Some(101) }, 100, start + Duration::from_millis(500)).is_err());
}
#[test]
fn worker_result_requires_matching_digest_size_and_real_file_identity() {
    let temporary = tempfile::tempdir().unwrap(); let profile = temporary.path().canonicalize().unwrap(); let root = Dir::profile(&profile).unwrap();
    root.mkdir("attempt", 0o700).unwrap(); let directory = root.child("attempt").unwrap();
    let bytes = b"verified payload"; let mut file = directory.create("archive.part").unwrap(); file.write_all(bytes).unwrap(); file.sync_all().unwrap();
    let identity = FileIdentity::from_metadata(&file.metadata().unwrap()); close(file).unwrap();
    let asset = Asset { target: TARGET.into(), name: "OC-Chan-0.2.0-mac-arm64.zip".into(), size: bytes.len() as u64, sha512: STANDARD.encode(Sha512::digest(bytes)) };
    let mut response = HttpResponse { bytes: bytes.len() as u64, body: Vec::new(), sha256: String::new(), sha512: asset.sha512.clone(), file_identity: Some(identity) };
    verify_download(&directory, &asset, &response).unwrap();
    response.sha512 = STANDARD.encode([0u8;64]); assert_eq!(verify_download(&directory, &asset, &response).unwrap_err().code, "OC_UPDATE_INTEGRITY");
    response.sha512 = asset.sha512.clone(); response.bytes += 1; assert!(verify_download(&directory, &asset, &response).is_err()); response.bytes -= 1;
    std::fs::write(directory.path.join("archive.part"), b"modified payload").unwrap(); assert!(verify_download(&directory, &asset, &response).is_err());
    directory.close().unwrap(); root.remove_tree("attempt").unwrap(); root.close().unwrap();
}
