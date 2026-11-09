import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPluginMarket } from '../build-plugin-market.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

export async function createMarketFeed(directory) {
  const entry = path.join(directory, 'updated-system.ts')
  await writeFile(entry, `import { createPlugin as original } from ${JSON.stringify(path.join(root, 'plugins/system-monitor/index.ts'))};
export function createPlugin(sdk) {
  const definition = original(sdk);
  return { ...definition, create(context) {
    const instance = definition.create(context);
    return { ...instance, async collect(signal) {
      const snapshot = await instance.collect(signal);
      return { ...snapshot, osVersion: snapshot.osVersion + ' [marketplace-update-proof]' };
    }};
  }};
}\n`)
  const updated = await buildPluginMarket(path.join(directory, 'updated'), { version: '1.1.0', entry })
  const brokenEntry = path.join(directory, 'broken-system.ts')
  await writeFile(brokenEntry, `import { createPlugin as original } from ${JSON.stringify(path.join(root, 'plugins/system-monitor/index.ts'))};
export function createPlugin(sdk) {
  return { ...original(sdk), create() { return { collect() { throw new Error('marketplace-activation-proof'); }, stop() {} }; } };
}\n`)
  const broken = await buildPluginMarket(path.join(directory, 'broken'), { version: '1.2.0', entry: brokenEntry })
  const packages = new Map()
  for (const built of [updated, broken]) {
    const bytes = await readFile(built.packagePath)
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Smoke plugin exceeded package budget')
    packages.set(path.basename(built.packagePath), bytes)
  }
  const tampered = structuredClone(updated.catalog)
  tampered.plugins[0].manifest.version = '1.3.0'
  tampered.plugins[0].package = 'system-1.3.0.ocplugin'
  tampered.plugins[0].sha256 = '0'.repeat(64)
  packages.set(tampered.plugins[0].package, packages.get(path.basename(updated.packagePath)))
  const catalogs = { updated: updated.catalog, slow: updated.catalog, broken: broken.catalog, tampered }
  let mode = 'updated', requests = 0, slowDownloads = 0
  const server = createServer((request, response) => {
    if (++requests > 128) { response.writeHead(429); response.end(); return }
    const name = request.url?.slice(1)
    if (request.method !== 'GET' || !name || !/^[a-zA-Z0-9._-]+$/.test(name)) { response.writeHead(400); response.end(); return }
    const bytes = name === 'catalog.json' ? Buffer.from(JSON.stringify(catalogs[mode])) : packages.get(name)
    if (!bytes) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length, 'connection': 'close' })
    if (mode === 'slow' && name !== 'catalog.json') {
      slowDownloads++
      response.write(bytes.subarray(0, 64))
      const timer = setTimeout(() => response.end(bytes.subarray(64)), 15000)
      response.once('close', () => clearTimeout(timer))
    } else response.end(bytes)
  })
  server.maxConnections = 4
  server.requestTimeout = 10000
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    setMode(value) { if (!Object.hasOwn(catalogs, value)) throw new Error('Unknown marketplace feed mode'); mode = value },
    requests: () => requests,
    slowDownloads: () => slowDownloads,
    async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  }
}
