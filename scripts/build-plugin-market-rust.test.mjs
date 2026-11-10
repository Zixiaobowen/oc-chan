import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildZip, bundleManifest, buildInfoPlist, crc32, zipEntry, buildPluginMarketRust, BUNDLE_API_VERSION, BUNDLE_TARGET } from './build-plugin-market-rust.mjs'

function readZip(buffer) {
  assert.ok(buffer.length >= 22)
  const eocd = buffer.subarray(buffer.length - 22)
  assert.equal(eocd.readUInt32LE(0), 0x06054b50, 'EOCD signature')
  const count = eocd.readUInt16LE(10)
  const centralOffset = eocd.readUInt32LE(16)
  const entries = []
  let offset = centralOffset
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, `central header ${i}`)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const crc = buffer.readUInt32LE(offset + 16)
    const size = buffer.readUInt32LE(offset + 24)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    entries.push({ name, localOffset, crc, size })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return { entries, count }
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('manifest requires apiVersion 2 and native target, preserving all fields', () => {
  const source = {
    id: 'system', version: '1.0.0', apiVersion: BUNDLE_API_VERSION, target: BUNDLE_TARGET, name: '系统监控', nameEn: 'System Monitor',
    description: '描述', descriptionEn: 'Description', publisher: 'OC Chan', section: 'system',
    minAppVersion: '0.1.0', platforms: ['darwin'], permissions: ['system-metrics', 'process-ranking', 'read-default-network-interface'],
  }
  const manifest = bundleManifest(source)
  assert.equal(manifest.apiVersion, BUNDLE_API_VERSION)
  assert.equal(manifest.target, BUNDLE_TARGET)
  assert.equal(manifest.id, 'system')
  assert.equal(manifest.name, '系统监控')
  assert.deepEqual(manifest.permissions, source.permissions)
  assert.throws(() => bundleManifest({ ...source, apiVersion: 1 }))
  assert.throws(() => bundleManifest({ ...source, target: 'x86_64-apple-darwin' }))
  assert.throws(() => bundleManifest({ ...source, id: 'not valid!' }))
  assert.throws(() => bundleManifest({ ...source, description: '' }))
  assert.throws(() => bundleManifest({ ...source, version: '../../escape' }))
  assert.throws(() => bundleManifest({ ...source, version: '<bad>' }))
})

test('buildPluginMarketRust rejects an apiVersion 1 manifest before reading the collector', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-plugin-reject-'))
  try {
    const manifestPath = path.join(dir, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify({ id: 'system', version: '1.0.0', apiVersion: 1, target: BUNDLE_TARGET, name: '系统监控', description: '描述' }))
    await assert.rejects(
      buildPluginMarketRust({ collector: path.join(dir, 'missing-collector'), manifest: manifestPath, outDir: path.join(dir, 'out'), sign: '-' }),
      /apiVersion must be 2/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('info plist pins the executable and bundle identifier', () => {
  const plist = buildInfoPlist('system', '1.0.0')
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>collector<\/string>/)
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>local\.oc-chan\.plugin\.system<\/string>/)
})

test('zip has exactly the declared entries with matching data and crc', () => {
  const a = Buffer.from('manifest contents')
  const b = Buffer.from('binary payload')
  const entries = [zipEntry('p.ocbundle/Contents/Resources/manifest.json', a), zipEntry('p.ocbundle/Contents/MacOS/collector', b)]
  const archive = buildZip(entries)
  const { entries: parsed, count } = readZip(archive)
  assert.equal(count, 2)
  assert.deepEqual(parsed.map((e) => e.name), ['p.ocbundle/Contents/Resources/manifest.json', 'p.ocbundle/Contents/MacOS/collector'])
  assert.equal(parsed[0].crc, crc32(a))
  assert.equal(parsed[1].crc, crc32(b))
  assert.equal(parsed[0].size, a.length)
  const first = parsed[0]
  const local = archive.subarray(first.localOffset)
  assert.equal(local.readUInt32LE(0), 0x04034b50, 'local header signature')
  const nameLength = local.readUInt16LE(26)
  const extraLength = local.readUInt16LE(28)
  const dataStart = first.localOffset + 30 + nameLength + extraLength
  assert.deepEqual(archive.subarray(dataStart, dataStart + a.length), a)
})

test('zip records executable and directory permissions', () => {
  const executable = zipEntry('system.ocbundle/Contents/MacOS/collector', Buffer.from('mach-o'))
  const directory = zipEntry('system.ocbundle/', null)
  assert.equal(executable.centralHeader.readUInt32LE(38) >>> 16, 0o100755)
  assert.equal(directory.centralHeader.readUInt32LE(38) >>> 16, 0o40755)
})
