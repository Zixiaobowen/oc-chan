import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { crc32 } from 'node:zlib'
import unzipper from 'unzipper'

const ROOT = 'OC Chan.app/'
const MAX_ARCHIVE = 1024 ** 3
const MAX_MEMBER = 512 * 1024 ** 2
const MAX_DIRECTORY = 8 * 1024 ** 2
const MAX_ENTRIES = 20_000
const WORKER = 'oc-chan-delivery-zip'
const EMPTY_HASH = createHash('sha256').digest('hex')

function requireThat(condition, message) {
  if (!condition) throw new Error(message)
}
function safePath(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024 &&
    !/[\\\x00-\x1f\x7f-\x9f]/u.test(value) && value.split('/').length <= 32 &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
function expectedMap(entries) {
  requireThat(Array.isArray(entries) && entries.length > 0 && entries.length <= MAX_ENTRIES, 'Expected ZIP entries exceed bounds or are empty')
  const files = new Map()
  const directories = new Set([ROOT.slice(0, -1)])
  let total = 0
  let metadata = 0
  for (const entry of entries) {
    requireThat(entry && safePath(entry.path) && safePath(ROOT + entry.path) && (entry.path === 'Contents' || entry.path.startsWith('Contents/')), 'Invalid expected ZIP path')
    requireThat(['file', 'symlink', 'directory'].includes(entry.kind), 'Invalid expected ZIP kind')
    requireThat(Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o7777, 'Invalid expected ZIP permissions')
    requireThat(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= MAX_MEMBER &&
      (entry.kind !== 'symlink' || entry.bytes <= 1024), 'Expected ZIP member exceeds bounds')
    requireThat(typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256), 'Invalid expected ZIP SHA256')
    requireThat(entry.kind !== 'directory' || entry.bytes === 0 && entry.sha256 === EMPTY_HASH, 'Expected ZIP directory must have no payload')
    const name = ROOT + entry.path
    requireThat(!files.has(name), 'Duplicate expected ZIP path')
    files.set(name, { path: entry.path, bytes: entry.bytes, kind: entry.kind, sha256: entry.sha256, mode: entry.mode })
    if (entry.kind === 'directory') directories.add(name)
    total += entry.bytes
    metadata += Buffer.byteLength(name) + 80
    requireThat(total <= MAX_ARCHIVE && metadata <= MAX_DIRECTORY, 'Expected ZIP aggregate exceeds bounds')
    let ancestor = name.slice(0, name.lastIndexOf('/'))
    while (ancestor) {
      directories.add(ancestor)
      requireThat(directories.size <= MAX_ENTRIES, 'Expected ZIP ancestor count exceeds bounds')
      ancestor = ancestor.slice(0, ancestor.lastIndexOf('/') < 0 ? 0 : ancestor.lastIndexOf('/'))
    }
  }
  for (const [name, entry] of files) requireThat(entry.kind === 'directory' || !directories.has(name), 'Expected ZIP file is also an ancestor')
  return { files, directories }
}
function identity(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':')
}
async function fileInfo(filename) {
  const info = await lstat(filename, { bigint: true })
  requireThat(info.isFile() && info.size >= 22n && info.size <= BigInt(MAX_ARCHIVE), 'ZIP must be a bounded regular file (22 bytes–1 GiB)')
  return info
}
async function readAt(handle, offset, length, size) {
  requireThat(Number.isSafeInteger(offset) && offset >= 0 && length >= 0 && length <= MAX_DIRECTORY && offset + length <= size, 'ZIP metadata range exceeds bounds')
  const bytes = Buffer.alloc(length)
  let seen = 0
  while (seen < length) {
    const result = await handle.read(bytes, seen, length - seen, offset + seen)
    requireThat(result.bytesRead > 0, 'Truncated ZIP metadata')
    seen += result.bytesRead
  }
  return bytes
}
function checkExtra(bytes) {
  let offset = 0
  while (offset < bytes.length) {
    requireThat(offset + 4 <= bytes.length, 'Truncated ZIP extra field')
    const id = bytes.readUInt16LE(offset)
    const length = bytes.readUInt16LE(offset + 2)
    requireThat(id !== 1, 'ZIP64 is not supported')
    offset += 4 + length
    requireThat(offset <= bytes.length, 'Truncated ZIP extra field payload')
  }
}

// Validate every allocation-driving field before handing the directory to unzipper.
async function preflight(handle, size, expected) {
  const tail = await readAt(handle, Math.max(0, size - 65557), Math.min(size, 65557), size)
  let end = -1
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
      requireThat(end === -1, 'Ambiguous ZIP end record')
      end = offset
    }
  }
  requireThat(end !== -1, 'Missing ZIP end record (truncated ZIP or non-ZIP input)')
  const endOffset = size - tail.length + end
  const eocd = tail.subarray(end)
  const count = eocd.readUInt16LE(10)
  const directorySize = eocd.readUInt32LE(12)
  const directoryOffset = eocd.readUInt32LE(16)
  requireThat(eocd.readUInt16LE(4) === 0 && eocd.readUInt16LE(6) === 0 && eocd.readUInt16LE(8) === count, 'Multi-disk ZIP is not supported')
  requireThat(count !== 0xffff && directorySize !== 0xffffffff && directoryOffset !== 0xffffffff, 'ZIP64 is not supported')
  requireThat(count > 0 && count <= MAX_ENTRIES && directorySize <= MAX_DIRECTORY && directorySize >= count * 46, 'ZIP central directory exceeds bounds')
  requireThat(directoryOffset > 0 && directoryOffset + directorySize === endOffset, 'Invalid ZIP central directory boundary or ZIP64 record')
  const bytes = await readAt(handle, directoryOffset, directorySize, size)
  const records = []
  const seen = new Set()
  let offset = 0
  let total = 0
  for (let index = 0; index < count; index++) {
    requireThat(offset + 46 <= bytes.length && bytes.readUInt32LE(offset) === 0x02014b50, 'Invalid ZIP central record')
    const header = bytes.subarray(offset, offset + 46)
    const nameLength = header.readUInt16LE(28)
    const extraLength = header.readUInt16LE(30)
    const commentLength = header.readUInt16LE(32)
    const next = offset + 46 + nameLength + extraLength + commentLength
    requireThat(next <= bytes.length && nameLength > 0 && nameLength <= 1040, 'ZIP central name/extra/comment exceeds bounds')
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
    const directory = name.endsWith('/')
    const canonical = directory ? name.slice(0, -1) : name
    requireThat(safePath(canonical) && name.startsWith(ROOT), 'Unsafe ZIP member path')
    requireThat(!seen.has(canonical), 'Duplicate ZIP member path')
    seen.add(canonical)
    const flags = header.readUInt16LE(8)
    const method = header.readUInt16LE(10)
    const compressed = header.readUInt32LE(20)
    const uncompressed = header.readUInt32LE(24)
    const localOffset = header.readUInt32LE(42)
    requireThat((flags & ~0x080e) === 0, 'Encrypted or unsupported ZIP flags')
    requireThat(method === 0 || method === 8, 'Unsupported ZIP compression method')
    requireThat(header.readUInt16LE(6) <= 20 && compressed !== 0xffffffff && uncompressed !== 0xffffffff && localOffset !== 0xffffffff, 'ZIP64 or unsupported ZIP extraction version')
    requireThat(header.readUInt16LE(34) === 0, 'Multi-disk ZIP member is not supported')
    requireThat(compressed <= MAX_ARCHIVE && uncompressed <= MAX_MEMBER, 'ZIP member exceeds bounds')
    requireThat(method !== 0 || compressed === uncompressed, 'Stored ZIP member size mismatch')
    requireThat((header.readUInt16LE(4) >>> 8) === 3, 'ZIP member lacks UNIX file attributes')
    const type = (header.readUInt32LE(38) >>> 16) & 0o170000
    const wanted = expected.files.get(canonical)
    if (directory) {
      requireThat(type === 0o040000 && expected.directories.has(canonical) && uncompressed === 0, `Unexpected or nonempty ZIP directory: ${name}`)
    } else {
      requireThat(wanted && wanted.kind !== 'directory', `Unexpected ZIP member: ${name}`)
      requireThat(type === (wanted.kind === 'symlink' ? 0o120000 : 0o100000), 'ZIP UNIX file/symlink type mismatch')
      requireThat(uncompressed === wanted.bytes, 'ZIP expected member size mismatch')
    }
    if (wanted) requireThat(((header.readUInt32LE(38) >>> 16) & 0o7777) === wanted.mode, `ZIP permissions differ from the application: ${name}`)
    total += uncompressed
    requireThat(total <= MAX_ARCHIVE, 'ZIP aggregate uncompressed size exceeds bounds')
    checkExtra(bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength))
    records.push({ name, nameBytes, header, flags, method, compressed, uncompressed, localOffset, crc: header.readUInt32LE(16), sha256: directory ? EMPTY_HASH : wanted.sha256 })
    offset = next
  }
  requireThat(offset === bytes.length, 'ZIP central directory has unlisted records or trailing bytes')
  for (const name of expected.files.keys()) requireThat(seen.has(name), `Missing ZIP member: ${name}`)
  let cursor = 0
  for (const record of [...records].sort((a, b) => a.localOffset - b.localOffset)) {
    requireThat(record.localOffset === cursor, 'ZIP local records overlap or contain hidden gaps')
    const local = await readAt(handle, cursor, 30, directoryOffset)
    requireThat(local.readUInt32LE(0) === 0x04034b50 && local.subarray(4, 14).equals(record.header.subarray(6, 16)), 'ZIP local/central metadata mismatch')
    const nameLength = local.readUInt16LE(26)
    const extraLength = local.readUInt16LE(28)
    requireThat(nameLength === record.nameBytes.length, 'ZIP local/central name length mismatch')
    const variable = await readAt(handle, cursor + 30, nameLength + extraLength, directoryOffset)
    requireThat(variable.subarray(0, nameLength).equals(record.nameBytes), 'ZIP local/central name mismatch')
    checkExtra(variable.subarray(nameLength))
    const values = [record.crc, record.compressed, record.uncompressed]
    for (let i = 0; i < values.length; i++) {
      const actual = local.readUInt32LE(14 + i * 4)
      requireThat(actual === values[i] || ((record.flags & 8) !== 0 && actual === 0), 'ZIP local/central CRC or size mismatch')
    }
    cursor += 30 + nameLength + extraLength + record.compressed
    requireThat(cursor <= directoryOffset, 'ZIP member payload exceeds archive bounds')
    if (record.flags & 8) {
      const first = await readAt(handle, cursor, 4, directoryOffset)
      const signed = first.readUInt32LE(0) === 0x08074b50
      const descriptor = await readAt(handle, cursor + (signed ? 4 : 0), 12, directoryOffset)
      requireThat(values.every((value, i) => descriptor.readUInt32LE(i * 4) === value), 'ZIP data descriptor mismatch')
      cursor += signed ? 16 : 12
      // unzipper scans for a descriptor when compressedSize is zero; forbid that ambiguous path.
      requireThat(record.compressed > 0, 'Empty ZIP data descriptor is unsupported')
    }
  }
  requireThat(cursor === directoryOffset, 'ZIP has unlisted local payload')
  return { records, tailSize: size - endOffset, directoryOffset, directorySize }
}

async function verifyInWorker(filename, entries, initialIdentity) {
  const expected = expectedMap(entries)
  const info = await fileInfo(filename)
  requireThat(identity(info) === initialIdentity, 'ZIP changed before verification')
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    requireThat(identity(await handle.stat({ bigint: true })) === initialIdentity, 'ZIP changed while opening')
    const checked = await preflight(handle, Number(info.size), expected)
    const directory = await unzipper.Open.file(filename, { tailSize: checked.tailSize })
    requireThat(directory.files.length === checked.records.length && directory.offsetToStartOfCentralDirectory === checked.directoryOffset && directory.sizeOfCentralDirectory === checked.directorySize, 'ZIP directory changed while opening')
    let total = 0
    for (let index = 0; index < checked.records.length; index++) {
      const record = checked.records[index]
      const entry = directory.files[index]
      requireThat(entry.path === record.name && entry.pathBuffer.equals(record.nameBytes) && entry.flags === record.flags && entry.compressionMethod === record.method && entry.compressedSize === record.compressed && entry.uncompressedSize === record.uncompressed && entry.crc32 === record.crc && entry.offsetToLocalFileHeader === record.localOffset && entry.externalFileAttributes === record.header.readUInt32LE(38), 'ZIP member changed while opening')
      const stream = entry.stream()
      let decoder
      stream.once('pipe', source => { decoder = source })
      // Observe stream errors immediately; always await close, including bounded-read failures.
      const closed = finished(stream, { cleanup: true }).then(() => null, error => error)
      const hash = createHash('sha256')
      let seen = 0
      let crc = 0
      let failure
      try {
        for await (const chunk of stream) {
          seen += chunk.length
          total += chunk.length
          requireThat(seen <= record.uncompressed && seen <= MAX_MEMBER && total <= MAX_ARCHIVE, 'ZIP streamed payload exceeds bounds')
          crc = crc32(chunk, crc)
          hash.update(chunk)
        }
        requireThat(seen === record.uncompressed, 'ZIP streamed member size mismatch')
        requireThat(record.method === 0 || decoder?.bytesWritten === record.compressed, 'ZIP compressed member length mismatch')
        requireThat(crc === record.crc, 'ZIP member CRC mismatch')
        requireThat(hash.digest('hex') === record.sha256, 'ZIP member SHA256 mismatch')
      } catch (error) {
        failure = error
        throw error
      } finally {
        stream.destroy()
        const error = await closed
        if (error && !failure) throw error
      }
    }
    requireThat(identity(await handle.stat({ bigint: true })) === initialIdentity && identity(await fileInfo(filename)) === initialIdentity, 'ZIP changed during verification')
    return { entryCount: checked.records.length, uncompressedBytes: total }
  } finally {
    await handle.close()
  }
}

export async function verifyDeliveryZip(filename, expectedEntries) {
  requireThat(typeof filename === 'string' && filename.length > 0 && filename.length <= 4096 && !filename.includes('\0'), 'Invalid ZIP filename')
  const expected = expectedMap(expectedEntries)
  const initialIdentity = identity(await fileInfo(filename))
  // unzipper's public stream API does not cascade destroy() to its private file/inflate
  // streams. A worker owns them all; awaiting termination closes them on every outcome.
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { task: WORKER, filename, entries: [...expected.files.values()], initialIdentity },
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 }
  })
  let deadline
  try {
    const result = await new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('ZIP verification exceeded its 120-second deadline')), 120_000)
      worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message.result))
      worker.once('error', reject)
      worker.once('exit', code => reject(new Error(`ZIP verification worker exited without a result (${code})`)))
    })
    requireThat(identity(await fileInfo(filename)) === initialIdentity, 'ZIP changed after verification')
    return result
  } finally {
    clearTimeout(deadline)
    await worker.terminate()
  }
}

if (!isMainThread && workerData?.task === WORKER) {
  try {
    const result = await verifyInWorker(workerData.filename, workerData.entries, workerData.initialIdentity)
    parentPort.postMessage({ result })
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
