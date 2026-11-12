import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdateController } from './plugins/update-controller'
import { downloadAsset, fetchUpdate, MAX_METADATA_BYTES, METADATA_URL, RELEASES_URL, parseUpdate, readMetadata, type UpdateAsset, type FetchUpdate } from './plugins/update-source'

const payload = Buffer.from('verified update archive test contents')
const asset: UpdateAsset = { version: '0.2.0', url: `${RELEASES_URL}/download/v0.2.0/OC-Chan-0.2.0-mac-arm64.zip`, size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }
const releaseAsset = (arch: string, size = asset.size) => ({ name: `OC-Chan-0.2.0-mac-${arch}.zip`, browser_download_url: `${RELEASES_URL}/download/v0.2.0/OC-Chan-0.2.0-mac-${arch}.zip`, state: 'uploaded', size, digest: `sha256:${asset.sha256}` })
const release = { tag_name: 'v0.2.0', draft: false, prerelease: false, assets: [releaseAsset('arm64'), releaseAsset('x64', 123)] }
const metadata = JSON.stringify(release)

test('stable update selection respects semver and machine architecture', () => {
  assert.deepEqual(parseUpdate(metadata, '0.1.0', 'arm64'), asset)
  assert.equal(parseUpdate(metadata, '0.1.0', 'x64')?.size, 123)
  assert.equal(parseUpdate(metadata, '0.2.0', 'arm64'), null)
  assert.equal(parseUpdate(metadata, '1.0.0', 'arm64'), null)
  assert.throws(() => parseUpdate(metadata.replaceAll('0.2.0', '0.3.0-beta.1'), '0.1.0', 'arm64'), /Prerelease/)
  assert.throws(() => parseUpdate(metadata, '0.1.0', 'riscv64'), /architecture/)
})

test('rejects nonstable releases and malformed tags', () => {
  for (const tag_name of ['0.2.0', 'vv0.2.0', 'v02.0.0', 'v0.2', 'v 0.2.0', 'v0.2.0 ']) {
    assert.throws(() => parseUpdate(JSON.stringify({ ...release, tag_name }), '0.1.0', 'arm64'), /version/)
  }
  assert.throws(() => parseUpdate(JSON.stringify({ ...release, draft: true }), '0.1.0', 'arm64'), /Draft/)
  assert.throws(() => parseUpdate(JSON.stringify({ ...release, prerelease: true }), '0.1.0', 'arm64'), /Prerelease/)
  assert.throws(() => parseUpdate('null', '0.1.0', 'arm64'), /version/)
  assert.throws(() => parseUpdate('version: 0.2.0', '0.1.0', 'arm64'), SyntaxError)
})

test('rejects missing or duplicate architecture and untrusted release assets', () => {
  const item = releaseAsset('arm64')
  const parseAssets = (assets: unknown[]) => parseUpdate(JSON.stringify({ ...release, assets }), '0.1.0', 'arm64')
  assert.throws(() => parseAssets([item, { ...item }]), /duplicate/)
  assert.throws(() => parseAssets([releaseAsset('x64')]), /Missing/)
  for (const size of [0, -1, 1.5, 512 * 1024 * 1024 + 1, '123', null]) {
    assert.throws(() => parseAssets([{ ...item, size }]), /size/)
  }
  for (const digest of [undefined, null, '', asset.sha256, `sha512:${asset.sha256}`, `sha256:${'g'.repeat(64)}`, `sha256:${'a'.repeat(63)}`]) {
    assert.throws(() => parseAssets([{ ...item, digest }]), /SHA-256/)
  }
  for (const browser_download_url of [item.browser_download_url.replace('/oc-chan/', '/other/'), item.browser_download_url.replace('/v0.2.0/', '/v0.1.0/'), `${item.browser_download_url}?token=a`, item.browser_download_url.replace('https:', 'http:')]) {
    assert.throws(() => parseAssets([{ ...item, browser_download_url }]), /URL/)
  }
  assert.throws(() => parseAssets([{ ...item, state: 'new' }]), /uploaded/)
  assert.throws(() => parseAssets([{ ...item, name: '../evil.zip' }]), /Missing/)
  assert.deepEqual(parseAssets([{ ...item, digest: `sha256:${asset.sha256.toUpperCase()}` }]), asset)
})

test('GitHub API uses versioned JSON headers and reports unavailable releases', async () => {
  const signal = new AbortController().signal
  await fetchUpdate(METADATA_URL, signal, async (url, options) => {
    assert.equal(url, METADATA_URL)
    assert.deepEqual(options.headers, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' })
    assert.equal(options.credentials, 'omit')
    return new Response(metadata)
  })
  await assert.rejects(fetchUpdate(METADATA_URL, signal, async () => new Response(null, { status: 404 })), /No available Release or repository inaccessible/)
})

test('an unavailable GitHub Release is an error rather than an up-to-date result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-update-unavailable-'))
  const controller = new UpdateController({ version: '0.1.0', arch: 'arm64', directory,
    fetch: async () => new Response(null, { status: 404 }), changed: () => {}, install: async () => {} })
  try {
    controller.start('development')
    await controller.check()
    assert.equal(controller.snapshot.phase, 'error')
    assert.equal(controller.snapshot.availableVersion, null)
    assert.match(controller.snapshot.error!, /No available Release or repository inaccessible/)
  } finally { await controller.stop(); await rm(directory, { recursive: true, force: true }) }
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
    fetch: async url => { requests++; return new Response(url === METADATA_URL ? metadata : payload) },
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
    if (url === METADATA_URL) return new Response(metadata)
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

test('unsigned and development builds allow manual checks but never download or install', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-update-stop-'))
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let requests = 0
  let installs = 0
  const controller = new UpdateController({ version: '0.1.0', arch: 'arm64', directory,
    fetch: async () => { requests++; return new Response(metadata) }, changed: () => {}, install: async () => { installs++ } })
  try {
    for (const reason of ['unsigned', 'development'] as const) {
      for (let i = 0; i < 25; i++) {
        const before = requests
        controller.start(reason)
        assert.equal(controller.snapshot.phase, 'idle')
        context.mock.timers.tick(30_000)
        await Promise.resolve()
        assert.equal(requests, before)
        await controller.check()
        assert.equal(requests, before + 1)
        assert.equal(controller.snapshot.phase, 'available')
        assert.equal(controller.snapshot.availableVersion, asset.version)
        assert.equal(controller.snapshot.disabledReason, reason)
        await controller.download()
        await controller.install()
        assert.equal(controller.snapshot.phase, 'available')
        assert.equal(requests, before + 1)
        assert.equal(installs, 0)
        await controller.stop()
        await controller.check()
        assert.equal(requests, before + 1)
      }
    }
    assert.deepEqual(await readdir(directory), [])
  } finally { await controller.stop(); context.mock.timers.reset(); await rm(directory, { recursive: true, force: true }) }
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

test('signature and check errors remain visible without automatic checks and allow manual retry', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-update-disabled-error-'))
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let requests = 0
  let rejectCheck = true
  const controller = new UpdateController({ version: '0.2.0', arch: 'arm64', directory,
    fetch: async () => { requests++; return rejectCheck ? new Response(null, { status: 503 }) : new Response(metadata) }, changed: () => {}, install: async () => {} })
  try {
    for (const reason of ['unsigned', 'development'] as const) {
      const before = requests
      rejectCheck = true
      controller.start(reason)
      controller.fail(new Error('Signature validation failed'))
      assert.equal(controller.snapshot.phase, 'error')
      assert.equal(controller.snapshot.error, 'Signature validation failed')
      context.mock.timers.tick(6 * 60 * 60 * 1000)
      await Promise.resolve()
      assert.equal(requests, before)
      await controller.check()
      assert.equal(requests, before + 1)
      assert.match(controller.snapshot.error!, /HTTP 503/)
      context.mock.timers.tick(6 * 60 * 60 * 1000)
      await Promise.resolve()
      assert.equal(requests, before + 1)
      assert.match(controller.snapshot.error!, /HTTP 503/)
      rejectCheck = false
      await controller.check()
      assert.equal(requests, before + 2)
      assert.equal(controller.snapshot.disabledReason, reason)
      assert.equal(controller.snapshot.phase, 'idle')
      assert.equal(controller.snapshot.error, null)
      context.mock.timers.tick(6 * 60 * 60 * 1000)
      await Promise.resolve()
      assert.equal(requests, before + 2)
      await controller.stop()
    }
  } finally { await controller.stop(); context.mock.timers.reset(); await rm(directory, { recursive: true, force: true }) }
})

test('unsupported platforms never check, download or install even after an error', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-update-platform-'))
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let requests = 0
  let installs = 0
  const controller = new UpdateController({ version: '0.1.0', arch: 'arm64', directory,
    fetch: async () => { requests++; return new Response(metadata) }, changed: () => {}, install: async () => { installs++ } })
  try {
    controller.start('platform')
    assert.equal(controller.snapshot.phase, 'disabled')
    await controller.check()
    controller.fail(new Error('Platform unavailable'))
    await controller.check()
    await controller.download()
    await controller.install()
    context.mock.timers.tick(6 * 60 * 60 * 1000)
    await Promise.resolve()
    assert.equal(requests, 0)
    assert.equal(installs, 0)
    assert.equal(controller.snapshot.disabledReason, 'platform')
    assert.equal(controller.snapshot.error, 'Platform unavailable')
  } finally { await controller.stop(); context.mock.timers.reset(); await rm(directory, { recursive: true, force: true }) }
})
