use super::{fs::{Dir, close, merge}, model::*};
use crate::error::{Error, Result, check_cancel};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, io::{Cursor, Read, Write}};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub(super) struct ArchiveInfo { pub expanded: u64, pub files: BTreeMap<String, (u64, String)> }
fn invalid() -> Error { Error::new("OC_PLUGIN_ARCHIVE", "Invalid, unsupported or unsealed native plugin archive") }
fn u16le(bytes: &[u8], at: usize) -> Result<u16> { Ok(u16::from_le_bytes(bytes.get(at..at + 2).ok_or_else(invalid)?.try_into().expect("two bytes"))) }
fn u32le(bytes: &[u8], at: usize) -> Result<u32> { Ok(u32::from_le_bytes(bytes.get(at..at + 4).ok_or_else(invalid)?.try_into().expect("four bytes"))) }
/// Preflight central and local headers before zip allocates entries or decompresses.
/// The accepted package vocabulary is ASCII and exact, so Unicode-normalization
/// aliases, path traversal, alternate streams and executable extras cannot exist.
fn preflight(bytes: &[u8], id: &str) -> Result<()> {
    if bytes.len() < 22 || bytes.len() > ARCHIVE_BYTES || bytes.get(..4) != Some(b"PK\x03\x04") { return Err(invalid()); }
    let end = bytes.len() - 22;
    if u32le(bytes, end)? != 0x06054b50 || u16le(bytes, end + 4)? != 0 || u16le(bytes, end + 6)? != 0 || u16le(bytes, end + 20)? != 0 { return Err(invalid()); }
    let count = u16le(bytes, end + 10)? as usize; let size = u32le(bytes, end + 12)? as usize; let start = u32le(bytes, end + 16)? as usize;
    if count < 4 || count > ZIP_ENTRIES || u16le(bytes, end + 8)? as usize != count || size > CENTRAL_BYTES || start.checked_add(size) != Some(end) { return Err(invalid()); }
    let prefix = format!("{id}.ocbundle/");
    let allowed_files: BTreeSet<_> = ["Contents/Info.plist", "Contents/MacOS/collector", "Contents/Resources/manifest.json", "Contents/_CodeSignature/CodeResources"].into_iter().map(|path| format!("{prefix}{path}")).collect();
    let allowed_dirs: BTreeSet<_> = ["", "Contents/", "Contents/MacOS/", "Contents/Resources/", "Contents/_CodeSignature/"].into_iter().map(|path| format!("{prefix}{path}")).collect();
    let mut names = BTreeSet::new(); let mut files = BTreeSet::new(); let mut ranges = Vec::with_capacity(count); let mut expanded = 0u64; let mut offset = start;
    for _ in 0..count {
        if u32le(bytes, offset)? != 0x02014b50 { return Err(invalid()); }
        let flags = u16le(bytes, offset + 8)?; let method = u16le(bytes, offset + 10)?;
        let compressed = u32le(bytes, offset + 20)? as usize; let size = u32le(bytes, offset + 24)? as usize;
        let name_len = u16le(bytes, offset + 28)? as usize; let extra = u16le(bytes, offset + 30)? as usize; let comment = u16le(bytes, offset + 32)? as usize;
        let local = u32le(bytes, offset + 42)? as usize; let mode = u32le(bytes, offset + 38)? >> 16;
        if flags & !0x0800 != 0 || ![0, 8].contains(&method) || u16le(bytes, offset + 34)? != 0 || extra != 0 || comment != 0 || name_len == 0 || name_len > 160 || size > ENTRY_BYTES || compressed > ARCHIVE_BYTES { return Err(invalid()); }
        let name_bytes = bytes.get(offset + 46..offset + 46 + name_len).ok_or_else(invalid)?;
        let name = std::str::from_utf8(name_bytes).map_err(|_| invalid())?;
        if !name.is_ascii() || !names.insert(name.to_owned()) { return Err(invalid()); }
        if name.ends_with('/') {
            if !allowed_dirs.contains(name) || size != 0 || compressed != 0 || mode & 0o170000 != 0o040000 { return Err(invalid()); }
        } else {
            if !allowed_files.contains(name) || mode & 0o170000 != 0o100000 || mode & 0o7000 != 0 || size == 0 { return Err(invalid()); }
            if name.ends_with("/manifest.json") && size > MANIFEST_BYTES { return Err(invalid()); }
            if !name.ends_with("/collector") && !name.ends_with("/manifest.json") && size > 256 * 1024 { return Err(invalid()); }
            files.insert(name.to_owned());
        }
        expanded += size as u64; if expanded > EXPANDED_BYTES as u64 { return Err(invalid()); }
        if u32le(bytes, local)? != 0x04034b50 || u16le(bytes, local + 6)? != flags || u16le(bytes, local + 8)? != method
            || u32le(bytes, local + 14)? != u32le(bytes, offset + 16)? || u32le(bytes, local + 18)? as usize != compressed || u32le(bytes, local + 22)? as usize != size
            || u16le(bytes, local + 26)? as usize != name_len || u16le(bytes, local + 28)? != 0
            || bytes.get(local + 30..local + 30 + name_len) != Some(name_bytes) { return Err(invalid()); }
        let end = local.checked_add(30 + name_len).and_then(|v| v.checked_add(compressed)).ok_or_else(invalid)?;
        if end > start { return Err(invalid()); }
        ranges.push((local, end)); offset += 46 + name_len;
    }
    if offset != start + size || files != allowed_files { return Err(invalid()); }
    ranges.sort_unstable(); let mut next = 0; for (start, end) in ranges { if start != next { return Err(invalid()); } next = end; } if next != start { return Err(invalid()); }
    Ok(())
}
/// Extraction and inspection share one exact parser. A failed extraction leaves a
/// bounded pending tree owned by the transaction supervisor, which must clean it.
pub(super) fn inspect(bytes: &[u8], entry: &CatalogEntry, app: &str, destination: Option<&Dir>, disk_root: Option<&Dir>, cancel: &CancellationToken) -> Result<ArchiveInfo> {
    entry.validate(app)?;
    if bytes.len() != entry.bytes || oc_plugin_sdk::digest(bytes) != entry.sha256 { return Err(Error::new("OC_PLUGIN_INTEGRITY", "Plugin archive digest/size mismatch")); }
    preflight(bytes, &entry.manifest.id)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| invalid())?;
    let mut result = ArchiveInfo { expanded: 0, files: BTreeMap::new() };
    let mut manifest = None; let mut plist_bytes = None; let mut seal = None;
    for index in 0..archive.len() {
        check_cancel(cancel)?;
        let mut input = archive.by_index(index).map_err(|_| invalid())?;
        if input.is_dir() { continue; }
        let name = input.name().map_err(|_| invalid())?.into_owned();
        let mut pieces = name.split('/').collect::<Vec<_>>(); let filename = pieces.pop().ok_or_else(invalid)?;
        let output_dir = if let Some(destination) = destination {
            let mut dir = destination.child(pieces[0], true)?;
            for component in &pieces[1..] { dir = dir.child(component, true)?; }
            Some(dir)
        } else { None };
        let mut output = output_dir.as_ref().map(|dir| dir.create(filename)).transpose()?;
        let mut hash = Sha256::new(); let mut count = 0u64; let mut chunk = [0u8; 64 * 1024]; let mut header = Vec::with_capacity(32);
        let keep = name.ends_with("manifest.json") || name.ends_with("Info.plist") || name.ends_with("CodeResources");
        let mut metadata = Vec::new();
        let writing = (|| {
            loop {
                check_cancel(cancel)?;
                let n = input.read(&mut chunk).map_err(|_| invalid())?; if n == 0 { break; }
                if n as u64 > input.size().saturating_sub(count) || n > ENTRY_BYTES.saturating_sub(count as usize) || n as u64 > EXPANDED_BYTES as u64 - result.expanded { return Err(invalid()); }
                if let Some(root) = disk_root { let used = root.disk_usage()?; if used + n as u64 > DISK_BYTES { return Err(Error::limit("plugin disk", DISK_BYTES as usize, (used + n as u64) as usize)); } }
                count += n as u64; result.expanded += n as u64; hash.update(&chunk[..n]);
                if header.len() < 32 { header.extend_from_slice(&chunk[..n.min(32 - header.len())]); }
                if keep { let limit = if name.ends_with("manifest.json") { MANIFEST_BYTES } else { 256 * 1024 }; if n > limit - metadata.len() { return Err(invalid()); } metadata.extend_from_slice(&chunk[..n]); }
                if let Some(output) = output.as_mut() { output.write_all(&chunk[..n]).map_err(|e| Error::io("plugin extraction", e))?; }
            }
            if count != input.size() { return Err(invalid()); }
            if name.ends_with("/collector") { validate_macho(&header)?; }
            if let Some(output) = &output { output.sync_all().map_err(|e| Error::io("plugin entry fsync", e))?; }
            Ok(())
        })();
        let cleanup = output.map(close).unwrap_or(Ok(())); merge(writing, cleanup)?;
        if let Some(dir) = output_dir { if filename == "collector" { dir.executable(filename)?; } dir.sync()?; }
        if name.ends_with("manifest.json") { manifest = Some(metadata); } else if name.ends_with("Info.plist") { plist_bytes = Some(metadata); } else if name.ends_with("CodeResources") { seal = Some(metadata); }
        result.files.insert(name, (count, format!("{:x}", hash.finalize())));
    }
    let raw_manifest = manifest.ok_or_else(invalid)?;
    let manifest: PluginManifest = serde_json::from_slice(&raw_manifest).map_err(|_| invalid())?;
    manifest.validate(app)?; if manifest != entry.manifest { return Err(Error::new("OC_PLUGIN_MANIFEST", "Sealed manifest does not match the trusted catalog")); }
    validate_plist(&plist_bytes.ok_or_else(invalid)?, &manifest)?;
    validate_seal(&seal.ok_or_else(invalid)?, &raw_manifest)?;
    if let Some(destination) = destination { sync_tree(destination)?; }
    Ok(result)
}
fn validate_macho(header: &[u8]) -> Result<()> {
    if header.len() < 32 || u32le(header, 0)? != 0xfeedfacf || u32le(header, 4)? != 0x0100000c || u32le(header, 12)? != 2 { return Err(Error::new("OC_PLUGIN_ARCHITECTURE", "Plugin entry must be an arm64 Mach-O executable")); } Ok(())
}
fn validate_plist(bytes: &[u8], manifest: &PluginManifest) -> Result<()> {
    let value = plist::Value::from_reader(Cursor::new(bytes)).map_err(|_| invalid())?;
    let dict = value.as_dictionary().ok_or_else(invalid)?;
    for (key, expected) in [("CFBundleExecutable", "collector"), ("CFBundleIdentifier", &manifest.bundle_id()), ("CFBundleVersion", &manifest.version), ("CFBundleShortVersionString", &manifest.version), ("CFBundlePackageType", "BNDL")] {
        if dict.get(key).and_then(plist::Value::as_string) != Some(expected) { return Err(Error::new("OC_PLUGIN_BUNDLE", "Bundle metadata does not match manifest")); }
    }
    Ok(())
}
fn validate_seal(bytes: &[u8], manifest: &[u8]) -> Result<()> {
    let value = plist::Value::from_reader(Cursor::new(bytes)).map_err(|_| invalid())?;
    let files = value.as_dictionary().and_then(|d| d.get("files2")).and_then(plist::Value::as_dictionary).ok_or_else(invalid)?;
    let resource = files.get("Resources/manifest.json").and_then(plist::Value::as_dictionary).ok_or_else(invalid)?;
    if resource.get("optional").and_then(plist::Value::as_boolean) == Some(true) || resource.get("hash2").and_then(plist::Value::as_data) != Some(Sha256::digest(manifest).as_slice()) { return Err(Error::new("OC_PLUGIN_SEAL", "Manifest is not covered by the resource seal")); } Ok(())
}
fn sync_tree(dir: &Dir) -> Result<()> {
    for name in dir.names(20)? {
        match dir.child(&name, false) { Ok(child) => sync_tree(&child)?, Err(error) if error.code == "ENOTDIR" => {}, Err(error) => return Err(error) }
    }
    dir.sync()
}
pub(super) fn compare_tree(current: &Dir, info: &ArchiveInfo, cancel: &CancellationToken) -> Result<()> {
    let roots = current.names(8)?;
    let root_name = info.files.keys().next().and_then(|name| name.split('/').next()).ok_or_else(invalid)?;
    if roots.iter().any(|name| ![root_name, "archive.ocplugin", "entry.json"].contains(&name.as_str())) { return Err(invalid()); }
    let mut actual = BTreeMap::new();
    fn walk(dir: &Dir, prefix: &str, output: &mut BTreeMap<String, (u64, String)>, cancel: &CancellationToken, depth: usize) -> Result<()> {
        if depth > 4 { return Err(invalid()); }
        for name in dir.names(ZIP_ENTRIES)? {
            check_cancel(cancel)?;
            let path = format!("{prefix}/{name}");
            match dir.child(&name, false) {
                Ok(child) => {
                    let relative = path.split_once('/').map(|(_, path)| path).ok_or_else(invalid)?;
                    if !["Contents", "Contents/MacOS", "Contents/Resources", "Contents/_CodeSignature"].contains(&relative) { return Err(invalid()); }
                    walk(&child, &path, output, cancel, depth + 1)?;
                }
                Err(error) if error.code == "ENOTDIR" => {
                    let mut file = dir.open_read(&name)?;
                    let result = (|| { let before = super::fs::regular(&file)?; if before.size > ENTRY_BYTES as u64 { return Err(invalid()); }
                        let mut hash = Sha256::new(); let mut size = 0u64; let mut chunk = [0u8; 64 * 1024];
                        loop { check_cancel(cancel)?; let n = file.read(&mut chunk).map_err(|e| Error::io("installed entry read", e))?; if n == 0 { break; } size += n as u64; if size > before.size { return Err(invalid()); } hash.update(&chunk[..n]); }
                        if size != before.size || super::fs::regular(&file)? != before { return Err(Error::new("OC_PLUGIN_CHANGED", "Installed entry changed during verification")); }
                        Ok((size, format!("{:x}", hash.finalize()))) })();
                    let result = merge(result, close(file))?; output.insert(path, result);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
    walk(&current.child(root_name, false)?, root_name, &mut actual, cancel, 0)?;
    if actual != info.files { return Err(Error::new("OC_PLUGIN_INTEGRITY", "Installed bundle differs from authenticated archive")); } Ok(())
}
