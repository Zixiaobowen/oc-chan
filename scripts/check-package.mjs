import assert from 'node:assert/strict'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as asar from '@electron/asar'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAX_ARCHIVE_BYTES = 3 * 1024 * 1024
const MAX_HEADER_BYTES = 512 * 1024
const MAX_ENTRIES = 2048
const RUNTIME_PACKAGE = 'systeminformation'
const RENDERER_PACKAGES = ['@dagrejs/dagre', '@xyflow/react', 'lucide-react', 'react', 'react-dom']
const INVENTORY = 'out/renderer/bundled-dependencies.json'
const NOTICES = 'out/renderer/THIRD_PARTY_NOTICES.txt'

async function readJson(filename, limit) {
  const handle = await open(filename, 'r')
  try {
    const info = await handle.stat()
    assert(info.isFile() && info.size <= limit, `Invalid or oversized metadata: ${filename}`)
    const bytes = Buffer.alloc(info.size)
    assert.equal((await handle.read(bytes, 0, bytes.length, 0)).bytesRead, bytes.length, `Truncated metadata: ${filename}`)
    return JSON.parse(bytes.toString('utf8'))
  } finally { await handle.close() }
}

export async function inspectPackage(appDirectory, { root = ROOT } = {}) {
  const filename = path.join(appDirectory, 'Contents/Resources/app.asar')
  const info = await lstat(filename)
  assert(info.isFile(), 'app.asar must be a regular file')
  assert(info.size <= MAX_ARCHIVE_BYTES, `ASAR size budget exceeded: ${info.size} > ${MAX_ARCHIVE_BYTES}`)
  // Validate the serialized header size before the ASAR library allocates it.
  const handle = await open(filename, 'r')
  let headerSize
  try {
    const prefix = Buffer.alloc(16)
    assert.equal((await handle.read(prefix, 0, 16, 0)).bytesRead, 16, 'Truncated ASAR prefix')
    headerSize = prefix.readUInt32LE(4)
    assert(prefix.readUInt32LE(0) === 4 && headerSize >= 8 && headerSize <= MAX_HEADER_BYTES && headerSize + 8 <= info.size &&
      prefix.readUInt32LE(8) === headerSize - 4 && prefix.readUInt32LE(12) <= headerSize - 8, 'Invalid or oversized ASAR header')
  } finally { await handle.close() }

  try {
    const files = new Map()
    let entries = 0
    function visit(node, parent = '', depth = 0) {
      assert(depth <= 32 && node && typeof node.files === 'object', 'Invalid ASAR directory')
      for (const [name, item] of Object.entries(node.files)) {
        assert(++entries <= MAX_ENTRIES, 'ASAR entry budget exceeded')
        assert(name && name !== '.' && name !== '..' && !/[\/\\\x00-\x1f]/.test(name), 'Invalid ASAR path')
        const relative = parent ? `${parent}/${name}` : name
        assert(item && !item.link && !item.unpacked, `Unexpected linked or unpacked payload: ${relative}`)
        if (relative.startsWith('node_modules/')) {
          assert(relative === `node_modules/${RUNTIME_PACKAGE}` || relative.startsWith(`node_modules/${RUNTIME_PACKAGE}/`), `Unexpected runtime dependency: ${relative}`)
        }
        if (item.files) { visit(item, relative, depth + 1); continue }
        assert(relative === 'package.json' || relative.startsWith('out/') || relative.startsWith(`node_modules/${RUNTIME_PACKAGE}/`), `Unexpected application payload: ${relative}`)
        assert(!/\.(?:map|ts|tsx|log)$|\.(?:test|spec)\.[^/]+$|(?:^|\/)(?:tests?|__tests__|__mocks__|fixtures?|coverage|cache)(?:\/|$)/i.test(relative), `Development file in application: ${relative}`)
        assert(Number.isSafeInteger(item.size) && item.size >= 0 && typeof item.offset === 'string' && /^\d+$/.test(item.offset), `Invalid ASAR file range: ${relative}`)
        const start = headerSize + 8 + Number(item.offset)
        assert(Number.isSafeInteger(start) && start + item.size <= info.size, `ASAR range exceeds archive: ${relative}`)
        files.set(relative, item)
      }
    }
    visit(asar.getRawHeader(filename).header)
    function metadata(name) {
      const entry = files.get(name)
      assert(entry && entry.size > 0 && entry.size <= 1024 * 1024, `Missing or oversized required file: ${name}`)
      return asar.extractFile(filename, name).toString('utf8')
    }
    for (const name of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      assert(files.has(name) && files.get(name).size > 0, `Missing application entry: ${name}`)
    }
    const [manifest, lock] = await Promise.all([
      readJson(path.join(root, 'package.json'), 256 * 1024),
      readJson(path.join(root, 'package-lock.json'), 4 * 1024 * 1024)
    ])
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [RUNTIME_PACKAGE], 'Only the main-process collector belongs in runtime dependencies')
    assert.deepEqual(lock.packages?.['']?.dependencies, manifest.dependencies, 'Runtime dependencies disagree with lockfile')
    for (const name of RENDERER_PACKAGES) assert(typeof manifest.devDependencies?.[name] === 'string', `Bundled frontend dependency must be dev-only: ${name}`)
    const packed = JSON.parse(metadata('package.json'))
    assert(packed.name === manifest.name && packed.version === manifest.version && packed.main === 'out/main/index.js', 'Packed application identity disagrees with source')
    assert.deepEqual(packed.dependencies, manifest.dependencies, 'Packed runtime dependencies disagree with source')
    assert(!Object.keys(packed.devDependencies ?? {}).length && !Object.keys(packed.optionalDependencies ?? {}).length, 'Development or optional dependencies retained in packed manifest')
    const runtime = JSON.parse(metadata(`node_modules/${RUNTIME_PACKAGE}/package.json`))
    assert(runtime.name === RUNTIME_PACKAGE && runtime.version === lock.packages?.[`node_modules/${RUNTIME_PACKAGE}`]?.version, 'Collector package disagrees with lockfile')
    const runtimeEntry = typeof runtime.main === 'string' ? path.posix.join(`node_modules/${RUNTIME_PACKAGE}`, runtime.main) : ''
    assert(runtimeEntry.startsWith(`node_modules/${RUNTIME_PACKAGE}/`) && files.has(runtimeEntry), 'Collector runtime entry is missing')
    const inventory = JSON.parse(metadata(INVENTORY))
    assert(inventory.schema === 1 && Array.isArray(inventory.packages) && inventory.packages.length > 0 && inventory.packages.length <= 1024, 'Invalid bundled dependency inventory')
    const notices = metadata(NOTICES)
    const seen = new Set()
    for (const item of inventory.packages) {
      assert(item && typeof item.name === 'string' && typeof item.version === 'string' && typeof item.license === 'string' && item.license, 'Invalid bundled dependency record')
      const key = `${item.name}@${item.version}`
      assert(!seen.has(key), `Duplicate bundled dependency: ${key}`)
      seen.add(key)
      assert(Object.entries(lock.packages).some(([name, entry]) => (name === `node_modules/${item.name}` || name.endsWith(`/node_modules/${item.name}`)) && entry.version === item.version && entry.license === item.license), `Bundled dependency disagrees with lockfile: ${key}`)
      assert(notices.includes(`===== ${key} (${item.license}) =====`), `Missing bundled license notice: ${key}`)
    }
    for (const name of RENDERER_PACKAGES) assert(inventory.packages.some(item => item.name === name), `Missing frontend license inventory: ${name}`)
    return {
      schema: 1, asarBytes: info.size, asarLimitBytes: MAX_ARCHIVE_BYTES, files: files.size,
      runtimeDependencies: [{ name: runtime.name, version: runtime.version }],
      bundledDependencies: inventory.packages, licenseBytes: files.get(NOTICES).size
    }
  } finally { asar.uncache(filename) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--app') throw new Error('Usage: node scripts/check-package.mjs --app <application.app>')
  inspectPackage(process.argv[3]).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
