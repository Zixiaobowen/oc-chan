import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import path from 'node:path'
import { boundedFile } from './main-probe.mjs'
import { buildMarketplaceFixtures } from '../build-marketplace-fixtures.mjs'

const PACKAGE_LIMIT = 64 * 1024 * 1024

// All traffic remains real HTTP through the Rust data worker. The fixture catalogs
// and signed executable packages are pinned before the loopback server is started.
export async function createMarketFeed(directory, { signal, record = () => {} } = {}) {
  assert(path.isAbsolute(directory))
  const built = await buildMarketplaceFixtures({ out: directory, signal })
  record('market-fixture-build', built)
  assert.equal(await realpath(directory), directory, 'Fixture artifact root must be canonical')
  const descriptor = JSON.parse((await boundedFile(path.join(directory, 'fixtures.json'), 65536)).toString('utf8'))
  assert.equal(descriptor.schema, 1)
  const artifacts = new Map(), handles = []
  let server, failure
  const pending = new Set()
  const state = { mode: 'updated', requests: 0, slowDownloads: 0, cancelled: 0, active: 0, peakActive: 0, bytesSent: 0, tampered: 0 }
  const report = error => { failure ??= error; record('market-feed-error', { error: String(error) }) }
  const closeFiles = async () => {
    const results = await Promise.allSettled(handles.map(handle => handle.close()))
    const errors = results.filter(value => value.status === 'rejected').map(value => value.reason)
    if (errors.length) throw new AggregateError(errors, 'Marketplace fixture descriptors did not close')
  }
  try {
    for (const [key, version] of [['v1','1.0.0'],['v2','1.1.0'],['v3','1.2.0']]) {
      const item = descriptor.variants?.[key]
      assert(item && item.version === version && path.isAbsolute(item.directory))
      assert(item.directory.startsWith(directory + path.sep) && await realpath(item.directory) === item.directory, 'Fixture package escaped the owned artifact directory')
      assert.match(item.catalog_sha256, /^[a-f0-9]{64}$/)
      const catalog = await boundedFile(path.join(item.directory, 'catalog.json'), 65536)
      assert.equal(createHash('sha256').update(catalog).digest('hex'), item.catalog_sha256, 'Pinned catalog digest mismatch')
      const entries = JSON.parse(catalog.toString('utf8'))
      assert.equal(entries.schema, 1); assert.equal(entries.plugins.length, 1)
      const entry = entries.plugins[0]
      assert.equal(entry.manifest.id, 'system'); assert.equal(entry.manifest.version, version)
      assert.equal(entry.package, item.package); assert.match(entry.package, /^[a-zA-Z0-9._-]+\.ocplugin$/)
      assert(Number.isSafeInteger(entry.bytes) && entry.bytes > 64 && entry.bytes <= PACKAGE_LIMIT)
      const file = await open(path.join(item.directory, entry.package), constants.O_RDONLY | constants.O_NOFOLLOW); handles.push(file)
      const identity = await file.stat()
      assert(identity.isFile() && identity.uid === process.getuid() && identity.nlink === 1 && identity.size === entry.bytes)
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
      for (let offset = 0; offset < identity.size;) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, identity.size - offset), offset)
        assert(bytesRead > 0, 'Fixture package changed during hashing')
        hash.update(buffer.subarray(0,bytesRead)); offset += bytesRead
      }
      assert.equal(hash.digest('hex'), entry.sha256, 'Signed fixture package digest mismatch')
      artifacts.set(key, { ...item, catalogSha256: item.catalog_sha256, catalog, file, identity })
    }
    const serve = async (request, response) => {
      if (++state.requests > 128 || state.active >= 4) { response.writeHead(429); response.end(); throw new Error('Marketplace feed admission limit exceeded') }
      state.active++; state.peakActive = Math.max(state.peakActive, state.active)
      const selected = state.mode, release = ['broken','tampered'].includes(selected) ? 'v3' : 'v2', item = artifacts.get(release)
      let closeListener, delayTimer
      try {
        assert.equal(request.socket.remoteAddress, '127.0.0.1')
        if (request.method !== 'GET' || ![`/${release}/catalog.json`, `/${release}/${item.package}`].includes(request.url)) {
          response.writeHead(400); response.end(); throw new Error('Unexpected marketplace fixture URL or method')
        }
        if (request.url.endsWith('/catalog.json')) {
          response.writeHead(200, { 'content-type':'application/json', 'content-length':item.catalog.length, connection:'close' })
          response.end(item.catalog); state.bytesSent += item.catalog.length; return
        }
        const stat = await item.file.stat()
        assert.equal(stat.size, item.identity.size); assert.equal(stat.mtimeMs, item.identity.mtimeMs); assert.equal(stat.ino, item.identity.ino)
        response.writeHead(200, { 'content-type':'application/octet-stream', 'content-length':stat.size, connection:'close' })
        if (selected === 'slow') state.slowDownloads++
        const buffer = Buffer.alloc(65536)
        for (let offset = 0; offset < stat.size;) {
          const maximum = selected === 'slow' && offset === 0 ? 64 : buffer.length
          const { bytesRead } = await item.file.read(buffer, 0, Math.min(maximum, stat.size - offset), offset)
          assert(bytesRead > 0, 'Fixture package was truncated during HTTP transfer')
          if (selected === 'tampered' && offset === 0) { buffer[0] ^= 1; state.tampered++ }
          if (response.destroyed) { state.cancelled++; return }
          // Await the socket's write callback before reusing this bounded buffer.
          await new Promise((resolve,reject) => response.write(buffer.subarray(0, bytesRead), error => error ? reject(error) : resolve()))
          state.bytesSent += bytesRead; offset += bytesRead
          if (selected === 'slow' && offset === 64) {
            const continued = await new Promise(resolve => {
              closeListener = () => { clearTimeout(delayTimer); resolve(false) }
              response.once('close', closeListener)
              delayTimer = setTimeout(() => resolve(true), 15000)
            })
            response.off('close', closeListener); clearTimeout(delayTimer)
            if (!continued) { state.cancelled++; return }
          }
        }
        response.end()
      } catch (error) {
        if (response.destroyed && ['ERR_STREAM_DESTROYED','ECONNRESET','EPIPE'].includes(error.code)) state.cancelled++
        else { report(error); response.destroy(error) }
      } finally { clearTimeout(delayTimer); if (closeListener) response.off('close', closeListener); state.active-- }
    }
    server = createServer((request,response) => {
      response.on('error', error => { if (!['ERR_STREAM_DESTROYED','ECONNRESET','EPIPE'].includes(error.code)) report(error) })
      const operation = serve(request,response); pending.add(operation)
      operation.then(() => pending.delete(operation), error => { pending.delete(operation); report(error); response.destroy() })
    })
    server.maxConnections = 4; server.requestTimeout = 10000; server.headersTimeout = 5000
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    server.on('error', report)
    const origin = `http://127.0.0.1:${server.address().port}`
    return {
      async setMode(mode, driver) {
        if (failure) throw failure
        assert(['updated','slow','broken','tampered'].includes(mode))
        state.mode = mode
        const key = ['broken','tampered'].includes(mode) ? 'v3' : 'v2', item = artifacts.get(key)
        await driver.host('marketplace-feed', { catalogUrl: `${origin}/${key}/catalog.json`, catalogSha256: item.catalogSha256,
          trustedAssets: [...artifacts.values()].map(value => ({ directory: value.directory, catalogSha256: value.catalogSha256 })) })
      },
      requests: () => state.requests, slowDownloads: () => state.slowDownloads,
      // Fixed per-run trust roots for launch-time injection, so the restart can re-verify
      // the installed fixture-signed package without treating the writable install as its own root.
      startupRoots: () => [...artifacts.values()].map(value => ({ directory: value.directory, catalogSha256: value.catalogSha256 })),
      evidence: () => ({ ...state, artifacts: [...artifacts.entries()].map(([key,value]) => ({ key, version:value.version, catalogSha256:value.catalogSha256, package:value.package, packageSha256:value.sha256, bytes:value.bytes, executableSha256:value.build.executable_sha256, failCollect:value.fail_collect })) }),
      async close() {
        server.closeAllConnections(); await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()))
        await Promise.allSettled([...pending]); await closeFiles()
        if (failure) throw failure
        assert.equal(state.active, 0, 'Marketplace HTTP transfers survived close')
      }
    }
  } catch (error) {
    if (server) { server.closeAllConnections(); server.close() }
    try { await closeFiles() } catch (cleanup) { throw new AggregateError([error,cleanup], 'Marketplace fixture setup cleanup failed') }
    throw error
  }
}
