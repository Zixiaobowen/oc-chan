import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import { UpdateController } from './plugins/update-controller'
import { downloadAsset, fetchUpdate, MAX_METADATA_BYTES, parseUpdate, readMetadata, type UpdateAsset, type FetchUpdate } from './plugins/update-source'

const payload = Buffer.from('verified update archive test contents')
const asset: UpdateAsset = { version: '0.2.0', url: 'https://github.com/Zixiaobowen/oc-chan-releases/releases/download/v0.2.0/OC-Chan-0.2.0-mac-arm64.zip', size: payload.length, sha512: createHash('sha512').update(payload).digest('base64') }
const metadata = dump({ version: asset.version, files: [{ url: 'OC-Chan-0.2.0-mac-arm64.zip', size: asset.size, sha512: asset.sha512 }, { url: 'OC-Chan-0.2.0-mac-x64.zip', size: 123, sha512: asset.sha512 }] })

test('stable update selection respects semver and machine architecture', () => {
  assert.deepEqual(parseUpdate(metadata, '0.1.0', 'arm64'), asset)
  assert.equal(parseUpdate(metadata, '0.1.0', 'x64')?.size, 123)
  assert.equal(parseUpdate(metadata, '0.2.0', 'arm64'), null)
  assert.equal(parseUpdate(metadata, '1.0.0', 'arm64'), null)
  assert.throws(() => parseUpdate(metadata.replaceAll('0.2.0', '0.3.0-beta.1'), '0.1.0', 'arm64'), /Prerelease/)
  assert.throws(() => parseUpdate(metadata, '0.1.0', 'riscv64'), /architecture/)
})

test('rejects missing/duplicate architecture, unsafe size and YAML aliases', () => {
  const item = { url: 'OC-Chan-0.2.0-mac-arm64.zip', size: asset.size, sha512: asset.sha512 }
  assert.throws(() => parseUpdate(dump({ version: '0.2.0', files: [item, { ...item }] }), '0.1.0', 'arm64'), /duplicate/)
  assert.throws(() => parseUpdate(dump({ version: '0.2.0', files: [{ ...item, size: 1024 ** 3 }] }), '0.1.0', 'arm64'), /size/)
  assert.throws(() => parseUpdate(dump({ version: '0.2.0', files: [{ ...item, url: '../evil.zip' }] }), '0.1.0', 'arm64'), /Missing/)
  assert.throws(() => parseUpdate('version: 0.2.0\nfiles: &files\n  - *files', '0.1.0', 'arm64'), /reference/)
})

test('metadata rejects oversized responses before retaining the overflow chunk', async () => {
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(4096)) },
    cancel() { cancelled = true }
  })
  await assert.rejects(readMetadata(new Response(stream), new AbortController().signal), /64 KiB/)
  assert.equal(cancelled, true)
  const oversized = new Response('no', { headers: { 'content-length': String(MAX_METADATA_BYTES + 1) } })
  await assert.rejects(readMetadata(oversized, new AbortController().signal), /64 KiB/)
})

test('redirects cannot escape HTTPS GitHub release hosts', async () => {
  let calls = 0
  const fetcher: FetchUpdate = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://localhost/private' } }) }
  await assert.rejects(fetchUpdate(asset.url, new AbortController().signal, fetcher), /Untrusted/)
  assert.equal(calls, 1)
  await assert.rejects(fetchUpdate('https://github.com.evil.invalid/a', new AbortController().signal, fetcher), /Untrusted/)
  assert.equal(calls, 1)
})

test('download publishes only a complete checksum-verified file and removes failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-update-download-'))
  try {
    const path = await downloadAsset(asset, directory, new AbortController().signal, async () => new Response(payload), () => {})
    assert.deepEqual(await readFile(path), payload)
    await rm(path)
    await assert.rejects(downloadAsset(asset, directory, new AbortController().signal, async () => new Response(Buffer.alloc(payload.length)), () => {}), /integrity/)
    assert.deepEqual(await readdir(directory), [])
    await assert.rejects(downloadAsset(asset, directory, new AbortController().signal, async () => new Response(Buffer.alloc(payload.length + 1)), () => {}), /declared/)
    assert.deepEqual(await readdir(directory), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('concurrent checks coalesce and cannot auto-download or install', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-update-state-'))
  let requests = 0
  let installs = 0
  const controller = new UpdateController({ version: '0.1.0', arch: 'arm64', directory,
    fetch: async url => { requests++; return new Response(url.endsWith('.yml') ? metadata : payload) },
    changed: () => {}, install: async () => { installs++ }
  })
  try {
    controller.start(null)
    await Promise.all(Array.from({ length: 100 }, () => controller.check()))
    assert.equal(requests, 1)
    assert.equal(controller.snapshot.phase, 'available')
    assert.equal(installs, 0)
    await controller.install()
    assert.equal(installs, 0)
    await controller.download()
    assert.equal(controller.snapshot.phase, 'downloaded')
    assert.equal(requests, 2)
    await controller.check()
    assert.equal(controller.snapshot.phase, 'downloaded')
    assert.equal(requests, 2)
    await controller.install()
    assert.equal(installs, 1)
  } finally { await controller.stop(); await rm(directory, { recursive: true, force: true }) }
})

test('download cancellation interrupts the read, preserves offer, and releases its partial file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-update-cancel-'))
  let downloadStarted: () => void = () => {}
  const started = new Promise<void>(resolve => { downloadStarted = resolve })
  let aborted = false
  const fetcher: FetchUpdate = async (url, options) => {
    if (url.endsWith('.yml')) return new Response(metadata)
    const stream = new ReadableStream({ start(streamController) {
      options.signal?.addEventListener('abort', () => { aborted = true; streamController.error(options.signal?.reason) }, { once: true })
      streamController.enqueue(payload.subarray(0, 4))
      downloadStarted()
    } })
    return new Response(stream)
  }
  const controller = new UpdateController({ version: '0.1.0', arch: 'arm64', directory, fetch: fetcher, changed: () => {}, install: async () => {} })
  try {
    controller.start(null)
    await controller.check()
    const downloading = controller.download()
    await started
    await controller.cancel()
    await downloading
    assert.equal(aborted, true)
    assert.equal(controller.snapshot.phase, 'available')
    assert.equal(controller.snapshot.error, null)
    assert.deepEqual(await readdir(directory), [])
  } finally { await controller.stop(); await rm(directory, { recursive: true, force: true }) }
})

test('disabled plugins never fetch and repeated lifecycle leaves no update files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-update-stop-'))
  let requests = 0
  const controller = new UpdateController({ version: '0.1.0', arch: 'arm64', directory,
    fetch: async () => { requests++; return new Response(metadata) }, changed: () => {}, install: async () => {} })
  try {
    for (let i = 0; i < 25; i++) {
      controller.start('unsigned')
      await controller.check()
      await controller.download()
      await controller.stop()
    }
    assert.equal(requests, 0)
    assert.deepEqual(await readdir(directory), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a manual check postpones the startup check so errors remain visible', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-update-timer-'))
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let requests = 0
  const controller = new UpdateController({ version: '0.1.0', arch: 'arm64', directory,
    fetch: async () => { requests++; return new Response(null, { status: 503 }) }, changed: () => {}, install: async () => {} })
  try {
    controller.start(null)
    await controller.check()
    assert.equal(controller.snapshot.phase, 'error')
    context.mock.timers.tick(30_000)
    await Promise.resolve()
    assert.equal(requests, 1)
    assert.match(controller.snapshot.error!, /HTTP 503/)
  } finally { await controller.stop(); context.mock.timers.reset(); await rm(directory, { recursive: true, force: true }) }
})

test('an error cannot enable network checks in an unsigned build', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-update-disabled-error-'))
  let requests = 0
  const controller = new UpdateController({ version: '0.1.0', arch: 'arm64', directory,
    fetch: async () => { requests++; return new Response(metadata) }, changed: () => {}, install: async () => {} })
  try {
    controller.start('unsigned')
    controller.fail(new Error('Signature validation failed'))
    await controller.check()
    assert.equal(requests, 0)
    assert.equal(controller.snapshot.disabledReason, 'unsigned')
    assert.equal(controller.snapshot.phase, 'error')
  } finally { await controller.stop(); await rm(directory, { recursive: true, force: true }) }
})
