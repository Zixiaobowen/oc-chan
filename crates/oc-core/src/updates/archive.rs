//! ZIP metadata is bounded before the mature ZIP parser allocates its index. The virtual
//! tree is checked before writes; links are created only after ordinary entries,
//! and their complete component-by-component resolution must stay in the bundle.
use super::{fs::{Dir, close, merge}, source::{Candidate, MAX_UPDATE_BYTES}};
use crate::error::{Error, Result, check_cancel};
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha512};
use std::{collections::{BTreeMap, BTreeSet, VecDeque}, fs::File, io::{Read, Seek, SeekFrom, Write}, os::unix::fs::PermissionsExt, path::PathBuf};
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;

pub(super) const MEMORY_BYTES: usize = 12 * 1024 * 1024;
const CENTRAL_BYTES: usize = 1024 * 1024;
const TREE_NAME_BYTES: usize = 256 * 1024;
const ENTRIES: usize = 4096;
const DEPTH: usize = 64;
const NAME_BYTES: usize = 1024;
const ENTRY_BYTES: u64 = 512 * 1024 * 1024;
const EXPANDED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const BUNDLE: &str = "OC Chan.app";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind { Directory, File, Link }
struct Entry { name: String, kind: Kind, mode: u32, size: u64, data_start: u64, compressed: u64, method: u16, crc: u32 }
struct Tree { nodes: BTreeMap<String, Kind>, aliases: BTreeMap<String, String>, explicit: BTreeSet<String>, name_bytes: usize }
impl Tree {
    fn new() -> Self { Self { nodes: BTreeMap::new(), aliases: BTreeMap::new(), explicit: BTreeSet::new(), name_bytes: 0 } }
    fn insert(&mut self, name: &str, kind: Kind) -> Result<()> {
        if !self.explicit.insert(name.to_owned()) { return Err(invalid()); }
        let parts: Vec<_> = name.split('/').collect();
        for index in 1..=parts.len() {
            let prefix = parts[..index].join("/"); let value = if index == parts.len() { kind } else { Kind::Directory };
            let alias: String = prefix.nfc().flat_map(char::to_lowercase).collect();
            if self.aliases.get(&alias).is_some_and(|old| old != &prefix) { return Err(invalid()); }
            if let Some(old) = self.nodes.get(&prefix) { if *old != value { return Err(invalid()); } }
            else {
                self.name_bytes = self.name_bytes.checked_add(prefix.len()).ok_or_else(invalid)?;
                if self.nodes.len() == ENTRIES || self.name_bytes > TREE_NAME_BYTES { return Err(invalid()); }
                self.aliases.insert(alias, prefix.clone()); self.nodes.insert(prefix, value);
            }
        }
        Ok(())
    }
}
fn invalid() -> Error { Error::new("OC_UPDATE_ARCHIVE", "更新ZIP结构或路径不安全 / Unsafe or unsupported update ZIP structure or path") }
fn u16le(bytes: &[u8], offset: usize) -> Result<u16> { Ok(u16::from_le_bytes(bytes.get(offset..offset + 2).ok_or_else(invalid)?.try_into().expect("two bytes"))) }
fn u32le(bytes: &[u8], offset: usize) -> Result<u32> { Ok(u32::from_le_bytes(bytes.get(offset..offset + 4).ok_or_else(invalid)?.try_into().expect("four bytes"))) }
fn read_at(file: &mut File, offset: u64, bytes: &mut [u8]) -> Result<()> {
    file.seek(SeekFrom::Start(offset)).map_err(|e| Error::io("update ZIP seek", e))?;
    file.read_exact(bytes).map_err(|e| Error::io("update ZIP read", e))
}
fn path(name: &str, directory: bool) -> Result<&str> {
    if name.is_empty() || name.len() > NAME_BYTES || name.contains(['\\', ':']) || name.chars().any(char::is_control) { return Err(invalid()); }
    let name = if directory { name.strip_suffix('/').ok_or_else(invalid)? } else { name };
    let parts: Vec<_> = name.split('/').collect();
    if parts.len() > DEPTH || parts.first() != Some(&BUNDLE) || parts.iter().any(|part| part.is_empty() || *part == "." || *part == ".." || part.len() > 255) { return Err(invalid()); }
    if parts.len() == 1 && !directory { return Err(invalid()); }
    Ok(name)
}
fn extras(bytes: &[u8]) -> Result<()> {
    if bytes.len() > 4096 { return Err(invalid()); }
    let mut offset = 0;
    while offset < bytes.len() {
        let tag = u16le(bytes, offset)?; let size = u16le(bytes, offset + 2)? as usize;
        // ZIP64, encryption and Unicode-name overrides can change the meaning of
        // our preflight. Only ordinary timestamp and uid/gid metadata is accepted.
        if !matches!(tag, 0x5455 | 0x7875 | 0x000a | 0x5855) { return Err(invalid()); }
        offset = offset.checked_add(4 + size).filter(|end| *end <= bytes.len()).ok_or_else(invalid)?;
    }
    Ok(())
}
fn preflight(file: &mut File, cancel: &CancellationToken) -> Result<(Vec<Entry>, Tree, DirectorySnapshot)> {
    let size = file.metadata().map_err(|e| Error::io("update ZIP metadata", e))?.len();
    if !(22..=MAX_UPDATE_BYTES).contains(&size) { return Err(invalid()); }
    let tail_size = size.min(65_557) as usize; let mut tail = vec![0; tail_size];
    read_at(file, size - tail_size as u64, &mut tail)?;
    let end = (0..=tail.len() - 22).rev().find(|&n| tail[n..n + 4] == *b"PK\x05\x06" && u16le(&tail, n + 20).is_ok_and(|comment| n + 22 + comment as usize == tail.len())).ok_or_else(invalid)?;
    let count = u16le(&tail, end + 10)? as usize; let central_size = u32le(&tail, end + 12)? as usize; let central_start = u32le(&tail, end + 16)? as u64;
    if count == 0 || count > ENTRIES || u16le(&tail, end + 8)? as usize != count || u16le(&tail, end + 4)? != 0 || u16le(&tail, end + 6)? != 0
        || central_size > CENTRAL_BYTES || central_start.checked_add(central_size as u64) != Some(size - tail_size as u64 + end as u64) { return Err(invalid()); }
    let mut central = Vec::with_capacity(central_size + tail.len() - end); central.resize(central_size, 0); read_at(file, central_start, &mut central)?;
    let mut entries = Vec::with_capacity(count); let mut tree = Tree::new(); let mut offset = 0; let mut total = 0u64; let mut ranges = Vec::with_capacity(count);
    let mut link_bytes = 0u64;
    for _ in 0..count {
        check_cancel(cancel)?;
        if u32le(&central, offset)? != 0x02014b50 { return Err(invalid()); }
        let flags = u16le(&central, offset + 8)?; let method = u16le(&central, offset + 10)?;
        let crc = u32le(&central, offset + 16)?; let compressed = u32le(&central, offset + 20)? as u64; let expanded = u32le(&central, offset + 24)? as u64;
        let name_length = u16le(&central, offset + 28)? as usize; let extra_length = u16le(&central, offset + 30)? as usize; let comment_length = u16le(&central, offset + 32)? as usize;
        let local = u32le(&central, offset + 42)? as u64; let mode = u32le(&central, offset + 38)? >> 16;
        if flags & !(0x800 | 8 | 6) != 0 || !matches!(method, 0 | 8) || name_length == 0 || name_length > NAME_BYTES || expanded > ENTRY_BYTES
            || u16le(&central, offset + 34)? != 0 || mode & 0o7000 != 0 { return Err(invalid()); }
        total = total.checked_add(expanded).filter(|n| *n <= EXPANDED_BYTES).ok_or_else(invalid)?;
        let name_start = offset + 46; let name_end = name_start.checked_add(name_length).ok_or_else(invalid)?;
        let raw_name = central.get(name_start..name_end).ok_or_else(invalid)?;
        let name = std::str::from_utf8(raw_name).map_err(|_| invalid())?;
        let directory = name.ends_with('/');
        let kind = match mode & 0o170000 {
            0 => if directory { Kind::Directory } else { Kind::File },
            0o040000 if directory => Kind::Directory,
            0o100000 if !directory => Kind::File,
            0o120000 if !directory => Kind::Link,
            _ => return Err(invalid()),
        };
        if (kind == Kind::Directory && (expanded != 0 || (mode != 0 && mode & 0o500 != 0o500))) || (kind == Kind::Link && (expanded == 0 || expanded > NAME_BYTES as u64)) { return Err(invalid()); }
        if kind == Kind::Link { link_bytes += expanded; if link_bytes > 256 * 1024 { return Err(invalid()); } }
        let name = path(name, directory)?.to_owned(); tree.insert(&name, kind)?;
        let extra_end = name_end.checked_add(extra_length).ok_or_else(invalid)?;
        extras(central.get(name_end..extra_end).ok_or_else(invalid)?)?;
        offset = extra_end.checked_add(comment_length).filter(|n| *n <= central.len()).ok_or_else(invalid)?;
        let mut header = [0; 30]; read_at(file, local, &mut header)?;
        if u32le(&header, 0)? != 0x04034b50 || u16le(&header, 6)? != flags || u16le(&header, 8)? != method || u16le(&header, 26)? as usize != name_length { return Err(invalid()); }
        if flags & 8 == 0 && (u32le(&header, 14)? != crc || u32le(&header, 18)? as u64 != compressed || u32le(&header, 22)? as u64 != expanded) { return Err(invalid()); }
        let local_extra = u16le(&header, 28)? as usize;
        if local_extra > 4096 { return Err(invalid()); }
        let mut local_name_extra = vec![0; name_length + local_extra]; read_at(file, local + 30, &mut local_name_extra)?;
        if &local_name_extra[..name_length] != raw_name { return Err(invalid()); }
        extras(&local_name_extra[name_length..])?;
        let data_start = local.checked_add(30 + name_length as u64 + local_extra as u64).ok_or_else(invalid)?;
        let mut data_end = data_start.checked_add(compressed).filter(|n| *n <= central_start).ok_or_else(invalid)?;
        if flags & 8 != 0 {
            let mut descriptor = [0; 16];
            if data_end + 12 > central_start { return Err(invalid()); }
            read_at(file, data_end, &mut descriptor[..12])?;
            let shift = if u32le(&descriptor, 0)? == 0x08074b50 {
                if data_end + 16 > central_start { return Err(invalid()); }
                read_at(file, data_end + 12, &mut descriptor[12..])?; 4
            } else { 0 };
            if u32le(&descriptor, shift)? != crc || u32le(&descriptor, shift + 4)? as u64 != compressed || u32le(&descriptor, shift + 8)? as u64 != expanded { return Err(invalid()); }
            data_end += (12 + shift) as u64;
        }
        ranges.push((local, data_end)); entries.push(Entry { name, kind, mode, size: expanded, data_start, compressed, method, crc });
    }
    if offset != central.len() { return Err(invalid()); }
    ranges.sort_unstable(); let mut next = 0;
    for (start, end) in ranges { if start != next { return Err(invalid()); } next = end; }
    if next != central_start { return Err(invalid()); }
    central.extend_from_slice(&tail[end..]);
    Ok((entries, tree, DirectorySnapshot { start: central_start, bytes: central }))
}
fn verify_archive(file: &mut File, candidate: &Candidate, cancel: &CancellationToken) -> Result<()> {
    if file.metadata().map_err(|e| Error::io("update archive metadata", e))?.len() != candidate.asset.size { return Err(invalid()); }
    let mut bytes = [0; 64 * 1024]; let mut digest = Sha512::new(); let mut size = 0u64;
    file.seek(SeekFrom::Start(0)).map_err(|e| Error::io("update archive seek", e))?;
    loop {
        check_cancel(cancel)?; let read = file.read(&mut bytes).map_err(|e| Error::io("update archive read", e))?;
        if read == 0 { break; } size += read as u64; if size > candidate.asset.size { return Err(invalid()); } digest.update(&bytes[..read]);
    }
    if size != candidate.asset.size || STANDARD.encode(digest.finalize()) != candidate.asset.sha512 { return Err(Error::new("OC_UPDATE_INTEGRITY", "下载包在安装前改变 / Downloaded archive changed before installation")); }
    Ok(())
}
pub(super) fn extract(directory: &Dir, candidate: &Candidate, cancel: &CancellationToken) -> Result<PathBuf> {
    let mut file = directory.read("archive.zip")?;
    let before = crate::io::FileIdentity::from_metadata(&file.metadata().map_err(|e| Error::io("update archive identity", e))?);
    let result = (|| {
        verify_archive(&mut file, candidate, cancel)?;
        let (entries, tree, snapshot) = preflight(&mut file, cancel)?;
        let input = SnapshotRead { file: &mut file, position: 0, snapshot };
        let mut archive = zip::ZipArchive::new(input).map_err(|_| invalid())?;
        if archive.len() != entries.len() { return Err(invalid()); }
        // Validate link content and graph before creating any bundle entry.
        let mut links = BTreeMap::new();
        for (index, entry) in entries.iter().enumerate().filter(|(_, entry)| entry.kind == Kind::Link) {
            check_cancel(cancel)?; let mut bytes = Vec::with_capacity(entry.size as usize);
            read_entry(&mut archive, index, entry, cancel, |chunk| { bytes.extend_from_slice(chunk); Ok(()) })?;
            let target = String::from_utf8(bytes).map_err(|_| invalid())?;
            validate_target(&target)?; links.insert(entry.name.clone(), target);
        }
        for name in links.keys() { resolve(name, &tree.nodes, &links)?; }
        for (name, kind) in &tree.nodes {
            if *kind != Kind::Directory { continue; } check_cancel(cancel)?;
            let parts: Vec<_> = name.split('/').collect(); let parent = directory.descend(&parts[..parts.len() - 1])?;
            let result = parent.mkdir(parts[parts.len() - 1], 0o755); merge(result, parent.close())?;
        }
        let mut total = 0u64;
        for (index, entry) in entries.iter().enumerate() {
            if entry.kind == Kind::Directory { read_entry(&mut archive, index, entry, cancel, |_| Err(invalid()))?; continue; }
            if entry.kind != Kind::File { continue; } check_cancel(cancel)?;
            let parts: Vec<_> = entry.name.split('/').collect(); let parent = directory.descend(&parts[..parts.len() - 1])?;
            let mut output = parent.create(parts[parts.len() - 1])?;
            let written = (|| {
                read_entry(&mut archive, index, entry, cancel, |bytes| {
                    total += bytes.len() as u64; if total > EXPANDED_BYTES { return Err(invalid()); }
                    output.write_all(bytes).map_err(|e| Error::io("update extract write", e))
                })?;
                output.set_permissions(std::fs::Permissions::from_mode(if entry.mode == 0 { 0o644 } else { entry.mode & 0o777 })).map_err(|e| Error::io("update file permissions", e))?;
                output.sync_all().map_err(|e| Error::io("update extract fsync", e))
            })();
            merge(merge(written, close(output)), parent.close())?;
        }
        for (name, target) in &links {
            check_cancel(cancel)?; let parts: Vec<_> = name.split('/').collect(); let parent = directory.descend(&parts[..parts.len() - 1])?;
            let result = parent.symlink(parts[parts.len() - 1], target); merge(result, parent.close())?;
        }
        // Sync all directories after their children, and preserve explicit modes
        // only once all children are written (read-only signed directories work).
        let modes: BTreeMap<_, _> = entries.iter().filter(|entry| entry.kind == Kind::Directory).map(|entry| (entry.name.as_str(), entry.mode)).collect();
        for (name, kind) in tree.nodes.iter().rev() {
            if *kind != Kind::Directory { continue; }
            check_cancel(cancel)?; let dir = directory.descend(&name.split('/').collect::<Vec<_>>())?;
            let result = dir.sync(); merge(result, dir.close())?;
            // Directory modes are set through the anchored handle below.
            if modes.get(name.as_str()).is_some_and(|mode| mode & 0o777 != 0o755 && *mode != 0) { directory_mode(directory, name, modes[name.as_str()] & 0o777)?; }
        }
        drop(archive);
        let after = crate::io::FileIdentity::from_metadata(&file.metadata().map_err(|e| Error::io("update archive identity", e))?);
        if before != after { return Err(Error::new("OC_UPDATE_INTEGRITY", "解压期间下载包改变 / Archive changed during extraction")); }
        directory.sync()?; directory.verify_path()?; check_cancel(cancel)?;
        Ok(directory.path.join(BUNDLE))
    })();
    merge(result, close(file))
}
struct DirectorySnapshot { start: u64, bytes: Vec<u8> }
// The file may be writable by the same user. Never let a changed EOCD/central
// directory bypass the bounds established before ZipArchive allocates memory.
struct SnapshotRead<'a> { file: &'a mut File, position: u64, snapshot: DirectorySnapshot }
impl Read for SnapshotRead<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.position >= self.snapshot.start {
            let offset = (self.position - self.snapshot.start) as usize;
            let bytes = self.snapshot.bytes.get(offset..).unwrap_or_default(); let count = bytes.len().min(buffer.len());
            buffer[..count].copy_from_slice(&bytes[..count]); self.position += count as u64; Ok(count)
        } else {
            let count = buffer.len().min((self.snapshot.start - self.position) as usize);
            self.file.seek(SeekFrom::Start(self.position))?;
            let read = self.file.read(&mut buffer[..count])?; self.position += read as u64; Ok(read)
        }
    }
}
impl Seek for SnapshotRead<'_> {
    fn seek(&mut self, seek: SeekFrom) -> std::io::Result<u64> {
        let end = self.snapshot.start + self.snapshot.bytes.len() as u64;
        let next = match seek {
            SeekFrom::Start(value) => Some(value),
            SeekFrom::End(delta) => end.checked_add_signed(delta),
            SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
        }.filter(|position| *position <= end).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "ZIP seek outside archive"))?;
        self.position = next; Ok(next)
    }
}
fn read_entry<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, index: usize, entry: &Entry, cancel: &CancellationToken, mut write: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
    let mut input = archive.by_index(index).map_err(|_| invalid())?;
    if input.name().map_err(|_| invalid())?.trim_end_matches('/') != entry.name || input.size() != entry.size || input.compressed_size() != entry.compressed
        || input.data_start() != Some(entry.data_start) || input.crc32() != entry.crc || input.encrypted()
        || !matches!((entry.method, input.compression()), (0, zip::CompressionMethod::Stored) | (8, zip::CompressionMethod::Deflated)) { return Err(invalid()); }
    let mut buffer = [0; 64 * 1024]; let mut size = 0u64;
    loop {
        check_cancel(cancel)?; let read = input.read(&mut buffer).map_err(|_| invalid())?; if read == 0 { break; }
        size += read as u64; if size > entry.size || size > ENTRY_BYTES { return Err(invalid()); }
        write(&buffer[..read])?;
    }
    // Reading through EOF invokes the ZIP library's CRC verification.
    if size != entry.size { return Err(invalid()); }
    Ok(())
}
fn directory_mode(root: &Dir, name: &str, mode: u32) -> Result<()> {
    let dir = root.descend(&name.split('/').collect::<Vec<_>>())?;
    let result = dir.permissions(mode); merge(result, dir.close())
}
fn validate_target(target: &str) -> Result<()> {
    if target.is_empty() || target.len() > NAME_BYTES || target.starts_with('/') || target.contains(['\\', ':']) || target.chars().any(char::is_control) || target.split('/').any(|part| part.len() > 255) { return Err(invalid()); }
    Ok(())
}
fn resolve(name: &str, nodes: &BTreeMap<String, Kind>, links: &BTreeMap<String, String>) -> Result<String> {
    let mut pending: VecDeque<String> = name.split('/').map(str::to_owned).collect(); let mut resolved: Vec<String> = Vec::new(); let mut hops = 0;
    while let Some(part) = pending.pop_front() {
        match part.as_str() {
            "" | "." => (),
            ".." => { if resolved.len() <= 1 { return Err(invalid()); } resolved.pop(); },
            _ => {
                resolved.push(part); let path = resolved.join("/"); let kind = nodes.get(&path).ok_or_else(invalid)?;
                if *kind == Kind::Link {
                    hops += 1; if hops > 40 { return Err(invalid()); }
                    resolved.pop(); let target = links.get(&path).ok_or_else(invalid)?;
                    for component in target.split('/').rev() { pending.push_front(component.to_owned()); }
                } else if !pending.is_empty() && *kind != Kind::Directory { return Err(invalid()); }
            }
        }
    }
    if resolved.first().map(String::as_str) != Some(BUNDLE) { return Err(invalid()); }
    Ok(resolved.join("/"))
}

#[cfg(test)]
mod tests;
