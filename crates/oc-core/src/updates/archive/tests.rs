use super::*;
use super::super::source::{Asset, TARGET};

struct Item<'a> { name: &'a str, mode: u32, data: &'a [u8], deflated: bool }
fn file<'a>(name: &'a str, data: &'a [u8]) -> Item<'a> { Item { name, mode: 0o100644, data, deflated: false } }
fn link<'a>(name: &'a str, target: &'a str) -> Item<'a> { Item { name, mode: 0o120777, data: target.as_bytes(), deflated: false } }
fn u16out(out: &mut Vec<u8>, value: u16) { out.extend_from_slice(&value.to_le_bytes()); }
fn u32out(out: &mut Vec<u8>, value: u32) { out.extend_from_slice(&value.to_le_bytes()); }
fn encoded(data: &[u8], deflated: bool) -> (u32, Vec<u8>) {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let method = if deflated { zip::CompressionMethod::Deflated } else { zip::CompressionMethod::Stored };
    writer.start_file("entry", zip::write::SimpleFileOptions::default().compression_method(method)).unwrap();
    writer.write_all(data).unwrap(); let bytes = writer.finish().unwrap().into_inner();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap(); let entry = archive.by_index(0).unwrap();
    let start = entry.data_start().expect("opened ZIP entry has a data offset") as usize; let end = start + entry.compressed_size() as usize;
    (entry.crc32(), bytes[start..end].to_vec())
}
fn zip(items: &[Item<'_>]) -> Vec<u8> {
    let mut out = Vec::new(); let mut central = Vec::new();
    for item in items {
        let offset = out.len() as u32; let (crc, data) = encoded(item.data, item.deflated);
        let method = if item.deflated { 8 } else { 0 };
        u32out(&mut out, 0x04034b50); u16out(&mut out, 20); u16out(&mut out, 0x800); u16out(&mut out, method);
        u16out(&mut out, 0); u16out(&mut out, 0); u32out(&mut out, crc); u32out(&mut out, data.len() as u32); u32out(&mut out, item.data.len() as u32);
        u16out(&mut out, item.name.len() as u16); u16out(&mut out, 0); out.extend_from_slice(item.name.as_bytes()); out.extend_from_slice(&data);
        u32out(&mut central, 0x02014b50); u16out(&mut central, 0x0314); u16out(&mut central, 20); u16out(&mut central, 0x800); u16out(&mut central, method);
        u16out(&mut central, 0); u16out(&mut central, 0); u32out(&mut central, crc); u32out(&mut central, data.len() as u32); u32out(&mut central, item.data.len() as u32);
        u16out(&mut central, item.name.len() as u16); u16out(&mut central, 0); u16out(&mut central, 0); u16out(&mut central, 0); u16out(&mut central, 0);
        u32out(&mut central, item.mode << 16); u32out(&mut central, offset); central.extend_from_slice(item.name.as_bytes());
    }
    let central_start = out.len() as u32; out.extend_from_slice(&central);
    u32out(&mut out, 0x06054b50); u16out(&mut out, 0); u16out(&mut out, 0); u16out(&mut out, items.len() as u16); u16out(&mut out, items.len() as u16);
    u32out(&mut out, central.len() as u32); u32out(&mut out, central_start); u16out(&mut out, 0); out
}
fn extraction(bytes: &[u8], cancel: &CancellationToken) -> (tempfile::TempDir, Result<PathBuf>) {
    let temporary = tempfile::tempdir().unwrap(); let profile = temporary.path().canonicalize().unwrap();
    let root = Dir::profile(&profile).unwrap(); root.mkdir("attempt", 0o700).unwrap(); let directory = root.child("attempt").unwrap();
    let mut output = directory.create("archive.zip").unwrap(); output.write_all(bytes).unwrap(); output.sync_all().unwrap(); close(output).unwrap();
    let candidate = Candidate { version: "0.2.0".into(), asset: Asset { target: TARGET.into(), name: "OC-Chan-0.2.0-mac-arm64.zip".into(), size: bytes.len() as u64, sha512: STANDARD.encode(Sha512::digest(bytes)) } };
    let result = extract(&directory, &candidate, cancel); directory.close().unwrap(); root.close().unwrap(); (temporary, result)
}
#[test]
fn extracts_deflate_modes_and_standard_framework_symlinks() {
    let mut executable = file("OC Chan.app/Contents/MacOS/OC Chan", b"executable fixture"); executable.mode = 0o100755; executable.deflated = true;
    let bytes = zip(&[executable,
        file("OC Chan.app/Contents/Frameworks/F.framework/Versions/A/Resources/data", b"resource"),
        link("OC Chan.app/Contents/Frameworks/F.framework/Versions/Current", "A"),
        link("OC Chan.app/Contents/Frameworks/F.framework/Resources", "Versions/Current/Resources")]);
    let (_temporary, result) = extraction(&bytes, &CancellationToken::new()); let bundle = result.unwrap();
    assert_eq!(std::fs::read(bundle.join("Contents/Frameworks/F.framework/Resources/data")).unwrap(), b"resource");
    assert_eq!(std::fs::metadata(bundle.join("Contents/MacOS/OC Chan")).unwrap().permissions().mode() & 0o777, 0o755);
    assert_eq!(std::fs::read_link(bundle.join("Contents/Frameworks/F.framework/Versions/Current")).unwrap(), PathBuf::from("A"));
}
#[test]
fn rejects_duplicate_alias_traversal_conflict_and_special_entries() {
    let cases = vec![
        vec![file("OC Chan.app/Contents/a", b"1"), file("OC Chan.app/Contents/a", b"2")],
        vec![file("OC Chan.app/Contents/A", b"1"), file("OC Chan.app/Contents/a", b"2")],
        vec![file("OC Chan.app/Contents/é", b"1"), file("OC Chan.app/Contents/e\u{301}", b"2")],
        vec![file("OC Chan.app/../escape", b"1")],
        vec![file("/OC Chan.app/file", b"1")],
        vec![file("Other.app/file", b"1")],
        vec![file("OC Chan.app/Contents/a", b"1"), file("OC Chan.app/Contents/a/b", b"2")],
        vec![Item { name: "OC Chan.app/pipe", mode: 0o010644, data: b"", deflated: false }],
        vec![Item { name: "OC Chan.app/suid", mode: 0o104755, data: b"x", deflated: false }],
        vec![link("OC Chan.app/Contents/link", "sub"), file("OC Chan.app/Contents/link/file", b"x")],
    ];
    for items in cases { let (_temporary, result) = extraction(&zip(&items), &CancellationToken::new()); assert!(result.is_err()); }
}
#[test]
fn rejects_link_escape_chains_cycles_missing_targets_and_file_traversal() {
    for target in ["/etc/passwd", "../../outside", "missing", "../Contents/file/../file", "link"] {
        let bytes = zip(&[file("OC Chan.app/Contents/file", b"x"), link("OC Chan.app/Contents/link", target)]);
        let (_temporary, result) = extraction(&bytes, &CancellationToken::new()); assert!(result.is_err(), "{target}");
    }
    let bytes = zip(&[link("OC Chan.app/Contents/a", "b"), link("OC Chan.app/Contents/b", "a")]);
    assert!(extraction(&bytes, &CancellationToken::new()).1.is_err());
    let bytes = zip(&[link("OC Chan.app/Contents/escape", "../../outside"), link("OC Chan.app/Contents/other", "escape/../Contents/file"), file("OC Chan.app/Contents/file", b"x")]);
    assert!(extraction(&bytes, &CancellationToken::new()).1.is_err());
}
#[test]
fn rejects_central_local_mismatch_and_budgets_before_decompression() {
    let original = zip(&[file("OC Chan.app/Contents/file", b"payload")]); let end = original.len() - 22;
    let central = u32le(&original, end + 16).unwrap() as usize;
    for offset_value in [(end + 12, (CENTRAL_BYTES + 1) as u32), (central + 24, ENTRY_BYTES as u32 + 1), (central + 42, 1), (central + 16, 0)] {
        let mut bytes = original.clone(); bytes[offset_value.0..offset_value.0 + 4].copy_from_slice(&offset_value.1.to_le_bytes());
        assert!(extraction(&bytes, &CancellationToken::new()).1.is_err());
    }
    let mut entries = original.clone(); entries[end + 8..end + 10].copy_from_slice(&20_001u16.to_le_bytes()); entries[end + 10..end + 12].copy_from_slice(&20_001u16.to_le_bytes());
    assert!(extraction(&entries, &CancellationToken::new()).1.is_err());
    let name = format!("OC Chan.app/{}file", "d/".repeat(DEPTH));
    assert!(extraction(&zip(&[file(&name, b"x")]), &CancellationToken::new()).1.is_err());
    let mut crc = original.clone(); let data_start = 30 + "OC Chan.app/Contents/file".len(); crc[data_start] ^= 1;
    assert!(extraction(&crc, &CancellationToken::new()).1.is_err());
}
#[test]
fn rejects_bomb_declaration_and_cancels_without_writing_bundle() {
    let mut item = file("OC Chan.app/Contents/bomb", b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); item.deflated = true;
    let mut bytes = zip(&[item]); let central = u32le(&bytes, bytes.len() - 6).unwrap() as usize;
    bytes[22..26].copy_from_slice(&1u32.to_le_bytes()); bytes[central + 24..central + 28].copy_from_slice(&1u32.to_le_bytes());
    assert!(extraction(&bytes, &CancellationToken::new()).1.is_err());
    let cancel = CancellationToken::new(); cancel.cancel(); let (temporary, result) = extraction(&zip(&[file("OC Chan.app/file", b"x")]), &cancel);
    assert!(result.unwrap_err().is_cancelled()); assert!(!temporary.path().join("updates-v2/attempt/OC Chan.app").exists());
}
#[test]
fn cleanup_does_not_follow_symlinks_and_handles_readonly_directories() {
    let temporary = tempfile::tempdir().unwrap(); let profile = temporary.path().canonicalize().unwrap();
    let outside = temporary.path().join("keep"); std::fs::write(&outside, b"keep").unwrap();
    let root = Dir::profile(&profile).unwrap(); root.mkdir("attempt", 0o700).unwrap(); let stage = root.child("attempt").unwrap();
    stage.mkdir("readonly", 0o755).unwrap(); let readonly = stage.child("readonly").unwrap(); readonly.symlink("outside", outside.to_str().unwrap()).unwrap(); readonly.permissions(0o555).unwrap(); readonly.close().unwrap(); stage.close().unwrap();
    root.remove_tree("attempt").unwrap(); assert_eq!(std::fs::read(&outside).unwrap(), b"keep"); root.close().unwrap();
}

#[test]
fn accepts_relative_parent_links_that_remain_inside_bundle() {
    let bytes = zip(&[file("OC Chan.app/Contents/data", b"inside"), link("OC Chan.app/Contents/Resources/link", "../data")]);
    let (_temporary, result) = extraction(&bytes, &CancellationToken::new()); let bundle = result.unwrap();
    assert_eq!(std::fs::read(bundle.join("Contents/Resources/link")).unwrap(), b"inside");
}

#[test]
fn disk_space_preflight_rejects_insufficient_space_and_arithmetic_overflow() {
    let temporary = tempfile::tempdir().unwrap(); let root = Dir::profile(&temporary.path().canonicalize().unwrap()).unwrap();
    assert!(root.space(u64::MAX).is_err());
    assert_eq!(root.space((u64::MAX - 256 * 1024 * 1024) / 5).unwrap_err().code, "OC_UPDATE_SPACE"); root.close().unwrap();
}

#[test]
fn central_directory_snapshot_cannot_be_replaced_after_preflight() {
    let bytes = zip(&[file("OC Chan.app/file", b"safe")]); let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("archive.zip"); std::fs::write(&path, &bytes).unwrap(); let mut input = File::open(&path).unwrap();
    let (entries, _, snapshot) = preflight(&mut input, &CancellationToken::new()).unwrap();
    let mut changed = bytes.clone(); let end = changed.len() - 22;
    changed[end + 10..end + 12].copy_from_slice(&65_535u16.to_le_bytes()); std::fs::write(&path, changed).unwrap();
    let mut archive = zip::ZipArchive::new(SnapshotRead { file: &mut input, position: 0, snapshot }).unwrap();
    assert_eq!(archive.len(), 1); let mut payload = Vec::new();
    read_entry(&mut archive, 0, &entries[0], &CancellationToken::new(), |bytes| { payload.extend_from_slice(bytes); Ok(()) }).unwrap();
    assert_eq!(payload, b"safe");
}

#[test]
fn rejects_total_expansion_before_opening_any_compressed_entry() {
    let names: Vec<_> = (0..5).map(|index| format!("OC Chan.app/Contents/file{index}")).collect();
    let items: Vec<_> = names.iter().map(|name| file(name, b"x")).collect(); let mut bytes = zip(&items);
    let mut position = u32le(&bytes, bytes.len() - 6).unwrap() as usize;
    for _ in 0..5 {
        let local = u32le(&bytes, position + 42).unwrap() as usize;
        bytes[local + 22..local + 26].copy_from_slice(&(ENTRY_BYTES as u32).to_le_bytes());
        bytes[position + 24..position + 28].copy_from_slice(&(ENTRY_BYTES as u32).to_le_bytes());
        position += 46 + u16le(&bytes, position + 28).unwrap() as usize;
    }
    let temporary = tempfile::tempdir().unwrap(); let path = temporary.path().join("archive"); std::fs::write(&path, bytes).unwrap();
    let mut input = File::open(path).unwrap(); assert!(preflight(&mut input, &CancellationToken::new()).is_err());
}

#[test]
fn rejects_aggregate_link_target_memory_before_allocating_link_text() {
    let names: Vec<_> = (0..257).map(|index| format!("OC Chan.app/Contents/link{index}")).collect();
    let target = "./".repeat(512); let items: Vec<_> = names.iter().map(|name| link(name, &target)).collect();
    let bytes = zip(&items); let temporary = tempfile::tempdir().unwrap(); let path = temporary.path().join("archive"); std::fs::write(&path, bytes).unwrap();
    let mut input = File::open(path).unwrap(); assert!(preflight(&mut input, &CancellationToken::new()).is_err());
}
