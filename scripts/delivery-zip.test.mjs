import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'
import { verifyDeliveryZip } from './delivery-zip.mjs'

const ROOT = 'OC Chan.app/'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const appFiles = [
  { name: `${ROOT}Contents/MacOS/OC Chan`, data: Buffer.from('local delivery fixture\n'), mode: 0o100755, method: 8 },
  { name: `${ROOT}Contents/Current`, data: Buffer.from('MacOS/OC Chan'), mode: 0o120777, method: 0 }
]
const expected = appFiles.map(item => ({ path: item.name.slice(ROOT.length), bytes: item.data.length, sha256: sha256(item.data), kind: item.mode === 0o120777 ? 'symlink' : 'file', mode: item.mode & 0o7777 }))
const directories = ['OC Chan.app/', `${ROOT}Contents/`, `${ROOT}Contents/MacOS/`].map(name => ({ name, data: Buffer.alloc(0), mode: 0o040755, method: 0 }))

// Standard single-disk ZIP records; fixtures exercise the actual library decoder.
function zip(items = [...directories, ...appFiles], { comment = '', extra = Buffer.alloc(0) } = {}) {
  const localParts = []
  const centralParts = []
  const records = []
  let localOffset = 0
  let centralOffset = 0
  for (const item of items) {
    const name = Buffer.from(item.name)
    const data = item.data ?? Buffer.alloc(0)
    const method = item.method ?? 0
    const compressed = Buffer.concat([method === 8 ? deflateRawSync(data) : data, item.compressedSuffix ?? Buffer.alloc(0)])
    const checksum = crc32(data)
    const flags = 0x800 | (item.descriptor ? 8 : 0)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    if (!item.descriptor) {
      local.writeUInt32LE(checksum, 14)
      local.writeUInt32LE(compressed.length, 18)
      local.writeUInt32LE(data.length, 22)
    }
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(extra.length, 28)
    const descriptor = Buffer.alloc(item.descriptor ? (item.descriptor === 'unsigned' ? 12 : 16) : 0)
    if (item.descriptor) {
      const start = descriptor.length === 16 ? 4 : 0
      if (start) descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(checksum, start)
      descriptor.writeUInt32LE(compressed.length, start + 4)
      descriptor.writeUInt32LE(data.length, start + 8)
    }
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt32LE(((item.mode ?? 0o100644) * 65536) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    records.push({ local: localOffset, central: centralOffset, payload: localOffset + 30 + name.length + extra.length, compressed: compressed.length })
    localParts.push(local, name, extra, compressed, descriptor)
    centralParts.push(central, name, extra)
    localOffset += local.length + name.length + extra.length + compressed.length + descriptor.length
    centralOffset += central.length + name.length + extra.length
  }
  const commentBytes = Buffer.from(comment)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(items.length, 8)
  eocd.writeUInt16LE(items.length, 10)
  eocd.writeUInt32LE(centralOffset, 12)
  eocd.writeUInt32LE(localOffset, 16)
  eocd.writeUInt16LE(commentBytes.length, 20)
  return {
    bytes: Buffer.concat([...localParts, ...centralParts, eocd, commentBytes]),
    records: records.map(record => ({ ...record, central: record.central + localOffset })),
    eocd: localOffset + centralOffset,
    directory: localOffset
  }
}
async function fixture(t, bytes) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-zip-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'delivery.zip')
  await writeFile(filename, bytes)
  return filename
}
async function rejectFixture(t, archive, pattern, entries = expected) {
  await assert.rejects(verifyDeliveryZip(await fixture(t, archive.bytes ?? archive), entries), pattern)
}

for (const descriptor of [false, 'signed', 'unsigned']) {
  test(`verifies real ZIP files and symlinks (${descriptor || 'no descriptor'})`, async t => {
    const archive = zip([...directories, ...appFiles.map(item => ({ ...item, descriptor }))], { comment: 'local use only'.repeat(80) })
    const result = await verifyDeliveryZip(await fixture(t, archive.bytes), expected)
    assert.deepEqual(result, { entryCount: 5, uncompressedBytes: expected.reduce((sum, entry) => sum + entry.bytes, 0) })
  })
}
test('directory entries are optional and zero-byte files are verified', async t => {
  const empty = { name: `${ROOT}Contents/empty`, data: Buffer.alloc(0), mode: 0o100644 }
  const entries = [...expected, { path: 'Contents/empty', bytes: 0, sha256: sha256(empty.data), kind: 'file', mode: 0o644 }]
  const archive = zip([...appFiles, empty])
  assert.equal((await verifyDeliveryZip(await fixture(t, archive.bytes), entries)).entryCount, 3)
})
test('an expected empty language directory must survive archiving without gaining contents', async t => {
  const empty = { name: `${ROOT}Contents/Resources/af.lproj/`, data: Buffer.alloc(0), mode: 0o040755 }
  const entries = [...expected, { path: 'Contents/Resources/af.lproj', bytes: 0, sha256: sha256(empty.data), kind: 'directory', mode: 0o755 }]
  assert.deepEqual(await verifyDeliveryZip(await fixture(t, zip([...appFiles, empty]).bytes), entries), {
    entryCount: 3, uncompressedBytes: expected.reduce((sum, entry) => sum + entry.bytes, 0)
  })
  await rejectFixture(t, zip(appFiles), /Missing ZIP member/, entries)
  await rejectFixture(t, zip([...appFiles, { ...empty, data: Buffer.from('unexpected') }]), /nonempty ZIP directory/, entries)
})
test('archive permissions must preserve executable and directory access bits', async t => {
  await rejectFixture(t, zip([{ ...appFiles[0], mode: 0o100644 }, appFiles[1]]), /permissions differ/)
  const directory = { path: 'Contents/MacOS', bytes: 0, sha256: sha256(Buffer.alloc(0)), kind: 'directory', mode: 0o755 }
  await rejectFixture(t, zip([...appFiles, { ...directories[2], mode: 0o040000 }]), /permissions differ/, [...expected, directory])
})
test('CRC mismatch is rejected even when SHA256 matches', async t => {
  const archive = zip(appFiles)
  const record = archive.records[0]
  const changed = (archive.bytes.readUInt32LE(record.central + 16) ^ 1) >>> 0
  archive.bytes.writeUInt32LE(changed, record.central + 16)
  archive.bytes.writeUInt32LE(changed, record.local + 14)
  await rejectFixture(t, archive, /CRC mismatch/)
})
test('stored payload corruption is rejected', async t => {
  const archive = zip(appFiles)
  archive.bytes[archive.records[1].payload] ^= 1
  await rejectFixture(t, archive, /CRC mismatch/)
})
test('invalid compressed payload is rejected and worker streams are closed', async t => {
  const archive = zip(appFiles)
  const record = archive.records[0]
  archive.bytes.fill(0xff, record.payload, record.payload + record.compressed)
  await rejectFixture(t, archive, /invalid|distance|block|code|data/i)
})
test('rejects trailing bytes hidden inside a compressed member', async t => {
  await rejectFixture(t, zip([{ ...appFiles[0], compressedSuffix: Buffer.from('hidden') }, appFiles[1]]), /compressed member length mismatch/)
})
test('expected hash mismatch is rejected', async t => {
  await rejectFixture(t, zip(), /SHA256 mismatch/, [{ ...expected[0], sha256: '0'.repeat(64) }, expected[1]])
})
test('expected size mismatch is rejected before decompression', async t => {
  await rejectFixture(t, zip(), /size mismatch/, [{ ...expected[0], bytes: expected[0].bytes + 1 }, expected[1]])
})
for (const declared of [1, appFiles[0].data.length + 1]) {
  test(`actual decompressed length must equal declared length (${declared})`, async t => {
    const archive = zip(appFiles)
    archive.bytes.writeUInt32LE(declared, archive.records[0].local + 22)
    archive.bytes.writeUInt32LE(declared, archive.records[0].central + 24)
    await rejectFixture(t, archive, /payload exceeds bounds|streamed member size mismatch/, [{ ...expected[0], bytes: declared }, expected[1]])
  })
}
for (const [label, items, pattern] of [
  ['missing', [appFiles[0]], /Missing ZIP member/],
  ['extra', [...appFiles, { ...appFiles[0], name: `${ROOT}Contents/extra` }], /Unexpected ZIP member/],
  ['duplicate', [...appFiles, appFiles[0]], /Duplicate ZIP/],
  ['escape', [{ ...appFiles[0], name: `${ROOT}Contents/../escape` }, appFiles[1]], /Unsafe ZIP/],
  ['absolute', [{ ...appFiles[0], name: '/OC Chan.app/Contents/file' }, appFiles[1]], /Unsafe ZIP/],
  ['backslash', [{ ...appFiles[0], name: `${ROOT}Contents\\escape` }, appFiles[1]], /Unsafe ZIP/],
  ['control', [{ ...appFiles[0], name: `${ROOT}Contents/a\u0001b` }, appFiles[1]], /Unsafe ZIP/],
  ['other app', [{ ...appFiles[0], name: 'Other.app/Contents/file' }, appFiles[1]], /Unsafe ZIP/],
  ['unrelated directory', [...appFiles, { name: `${ROOT}Contents/unlisted/`, mode: 0o040755 }], /Unexpected or nonempty ZIP directory/],
  ['nonempty directory', [...appFiles, { ...directories[0], data: Buffer.from('x') }], /Unexpected or nonempty ZIP directory/],
  ['file as symlink', [{ ...appFiles[0], mode: 0o120777 }, appFiles[1]], /type mismatch/],
  ['symlink as file', [appFiles[0], { ...appFiles[1], mode: 0o100644 }], /type mismatch/],
  ['special UNIX type', [{ ...appFiles[0], mode: 0o020644 }, appFiles[1]], /type mismatch/]
]) {
  test(`rejects ${label}`, async t => rejectFixture(t, zip(items), pattern))
}
for (const [label, mutate, pattern] of [
  ['local name mismatch', a => { a.bytes[a.records[0].local + 30] ^= 1 }, /name mismatch/],
  ['local flags mismatch', a => a.bytes.writeUInt16LE(0, a.records[0].local + 6), /metadata mismatch/],
  ['local CRC mismatch', a => a.bytes.writeUInt32LE(0, a.records[0].local + 14), /CRC or size mismatch/],
  ['local size mismatch', a => a.bytes.writeUInt32LE(1, a.records[0].local + 18), /CRC or size mismatch/],
  ['encrypted member', a => a.bytes.writeUInt16LE(1, a.records[0].central + 8), /Encrypted/],
  ['strong encryption', a => a.bytes.writeUInt16LE(64, a.records[0].central + 8), /Encrypted/],
  ['unsupported compression', a => a.bytes.writeUInt16LE(99, a.records[0].central + 10), /compression/],
  ['DOS attributes', a => a.bytes.writeUInt16LE(20, a.records[0].central + 4), /UNIX/],
  ['ZIP64 member', a => a.bytes.writeUInt32LE(0xffffffff, a.records[0].central + 24), /ZIP64/],
  ['oversized member', a => a.bytes.writeUInt32LE(512 * 1024 ** 2 + 1, a.records[0].central + 24), /member exceeds bounds/],
  ['ZIP64 end count', a => { a.bytes.writeUInt16LE(0xffff, a.eocd + 8); a.bytes.writeUInt16LE(0xffff, a.eocd + 10) }, /ZIP64/],
  ['ZIP64 directory size', a => a.bytes.writeUInt32LE(0xffffffff, a.eocd + 12), /ZIP64/],
  ['ZIP64 directory offset', a => a.bytes.writeUInt32LE(0xffffffff, a.eocd + 16), /ZIP64/],
  ['multi-disk archive', a => a.bytes.writeUInt16LE(1, a.eocd + 4), /Multi-disk/],
  ['multi-disk member', a => a.bytes.writeUInt16LE(1, a.records[0].central + 34), /Multi-disk/],
  ['oversized directory', a => a.bytes.writeUInt32LE(8 * 1024 ** 2 + 1, a.eocd + 12), /directory exceeds bounds/],
  ['oversized count', a => { a.bytes.writeUInt16LE(20001, a.eocd + 8); a.bytes.writeUInt16LE(20001, a.eocd + 10) }, /directory exceeds bounds/],
  ['bad central boundary', a => a.bytes.writeUInt32LE(a.directory - 1, a.eocd + 16), /boundary/],
  ['overlapping local offsets', a => a.bytes.writeUInt32LE(0, a.records[1].central + 42), /overlap|gaps/]
]) {
  test(`rejects ${label}`, async t => {
    const archive = zip(appFiles)
    mutate(archive)
    await rejectFixture(t, archive, pattern)
  })
}
test('rejects ZIP64 extra fields without sentinel sizes', async t => {
  await rejectFixture(t, zip(appFiles, { extra: Buffer.from([1, 0, 0, 0]) }), /ZIP64/)
})
test('rejects malformed extra field lengths', async t => {
  await rejectFixture(t, zip(appFiles, { extra: Buffer.from([2, 0, 1, 0]) }), /extra field payload/)
})
test('rejects mismatched data descriptors', async t => {
  const archive = zip(appFiles.map(item => ({ ...item, descriptor: true })))
  const record = archive.records[0]
  archive.bytes[record.payload + record.compressed + 4] ^= 1
  await rejectFixture(t, archive, /descriptor mismatch/)
})
for (const [label, bytes] of [
  ['truncated', zip().bytes.subarray(0, -1)],
  ['HTML', Buffer.from('<html><body>Not a ZIP download</body></html>')],
  ['empty', Buffer.alloc(0)],
  ['trailing bytes', Buffer.concat([zip().bytes, Buffer.from('hidden')])]
]) {
  test(`rejects ${label} input`, async t => rejectFixture(t, bytes, /ZIP/))
}
test('rejects archive over 1 GiB before opening unzipper', async t => {
  const filename = await fixture(t, zip().bytes)
  const handle = await open(filename, 'r+')
  try { await handle.truncate(1024 ** 3 + 1) } finally { await handle.close() }
  await assert.rejects(verifyDeliveryZip(filename, expected), /bounded regular file/)
})
test('rejects filesystem symlink instead of regular ZIP input', async t => {
  const filename = await fixture(t, zip().bytes)
  const link = `${filename}.link`
  await symlink(filename, link)
  await assert.rejects(verifyDeliveryZip(link, expected), /bounded regular file/)
})
for (const [label, entries, pattern] of [
  ['empty expected list', [], /Expected ZIP entries/],
  ['too many expected entries', Array(20001).fill(expected[0]), /Expected ZIP entries/],
  ['duplicate expected paths', [expected[0], expected[0]], /Duplicate expected/],
  ['unsafe expected path', [{ ...expected[0], path: 'Contents/../escape' }], /Invalid expected/],
  ['invalid expected hash', [{ ...expected[0], sha256: 'not-a-hash' }], /SHA256/],
  ['invalid expected kind', [{ ...expected[0], kind: 'asar' }], /kind/],
  ['invalid expected size', [{ ...expected[0], bytes: NaN }], /bounds/],
  ['negative expected size', [{ ...expected[0], bytes: -1 }], /bounds/],
  ['oversized expected member', [{ ...expected[0], bytes: 512 * 1024 ** 2 + 1 }], /bounds/],
  ['oversized expected symlink', [{ ...expected[1], bytes: 1025 }], /bounds/],
  ['oversized expected aggregate', ['a', 'b', 'c'].map(name => ({ ...expected[0], path: `Contents/${name}`, bytes: 512 * 1024 ** 2 })), /aggregate exceeds bounds/],
  ['expected ancestor collision', [expected[0], { ...expected[1], path: 'Contents/MacOS' }], /also an ancestor/]
]) {
  test(`rejects ${label}`, async t => rejectFixture(t, zip(), pattern, entries))
}
