import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, opendir, readlink, realpath, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as asar from '@electron/asar'

const run = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAX_ENTRIES = 20_000
const MAX_HEADER = 8 * 1024 * 1024
const MAX_METADATA = 4 * 1024 * 1024
const MAX_FILE = 2 * 1024 ** 3
const MAX_TOTAL = 8 * 1024 ** 3
const HELPER = 'Contents/Resources/tern-navigation/present-window'
const GLASS = 'Contents/Resources/liquid-glass/liquid-glass.node'
const NOTIFICATION_PERMISSION = 'Contents/Resources/notification-permission/notification-permission.node'
const PLUGIN = 'Contents/Resources/tern-navigation/plugin/'
const ARCHIVE = 'Contents/Resources/app.asar'
const BUNDLE_SCOPES = ['main', 'renderer']
const RENDERER_PACKAGES = ['@dagrejs/dagre', '@xyflow/react', 'lucide-react', 'react', 'react-dom']
const policy = {
  necessary: ['Electron macOS runtime and localization', 'compiled main/preload/renderer and referenced assets', 'bundled renderer dependency inventory and license notices', 'single-architecture native Liquid Glass and notification permission modules, executable navigation helper and exact source plugin copies'],
  forbidden: ['unlisted app/ASAR resources and dependencies', 'tests, development sources, source maps, declarations, caches, logs and personal state', 'ASAR symlinks/unpacked payloads and escaping app symlinks'],
  sizeAccounting: 'appBytes sums regular file lengths and symlink target UTF-8 lengths once; directories are itemized with zero payload bytes; asar entries are separately itemized without double-counting appBytes; bundled renderedBytes are pre-compression module estimates',
  bounds: { entries: MAX_ENTRIES, archiveHeaderBytes: MAX_HEADER, metadataBytes: MAX_METADATA, fileBytes: MAX_FILE, aggregateBytes: MAX_TOTAL, depth: 32 }
}

function requireThat(condition, message) {
  if (!condition) throw new Error(message)
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function sameMap(a = {}, b = {}) {
  return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value)
}
function integer(value) {
  return Number.isSafeInteger(value) && value >= 0
}
function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
function forbidden(value) {
  return value.split('/').some(part => /^(?:\..*|tests?|__tests__|__mocks__|fixtures?|coverage|logs?|caches?|node_modules\.cache|userdata|user data|sessions?|private|credentials|secrets?|\.DS_Store)$/i.test(part)) || /(?:\.(?:map|ts|tsx|log|sqlite|db|pem|key)|\.(?:test|spec)\.[^/]+)$/i.test(value) || /(?:^|\/)(?:tests?|spec|fixtures?)[._-]/i.test(value)
}
function checkPath(value) {
  requireThat(safePath(value), `Unsafe package path: ${JSON.stringify(value).slice(0, 1100)}`)
  requireThat(!forbidden(value), `Prohibited package entry: ${value}`)
}
async function boundedRead(filename, limit = MAX_METADATA) {
  const info = await lstat(filename)
  requireThat(info.isFile() && info.size <= limit, `Metadata must be a bounded regular file: ${path.basename(filename)}`)
  const handle = await open(filename, 'r')
  try {
    const bytes = Buffer.alloc(info.size)
    const result = await handle.read(bytes, 0, bytes.length, 0)
    requireThat(result.bytesRead === bytes.length && (await handle.stat()).size === bytes.length, `Metadata changed while reading: ${path.basename(filename)}`)
    return bytes
  } finally { await handle.close() }
}
function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')) } catch (error) { throw new Error(`Invalid JSON: ${label}`, { cause: error }) }
}
async function hashFile(filename, bytes, start = 0) {
  requireThat(integer(bytes) && bytes <= MAX_FILE && integer(start), 'File exceeds streaming resource bounds')
  const hash = createHash('sha256')
  let seen = 0
  if (bytes) {
    for await (const chunk of createReadStream(filename, { start, end: start + bytes - 1, highWaterMark: 64 * 1024 })) {
      seen += chunk.length
      requireThat(seen <= bytes, 'File changed while hashing')
      hash.update(chunk)
    }
  }
  requireThat(seen === bytes, 'Truncated file while hashing')
  return hash.digest('hex')
}
const hashBuffer = bytes => createHash('sha256').update(bytes).digest('hex')
const EMPTY_HASH = hashBuffer(Buffer.alloc(0))

function appFileAllowed(value, product) {
  if (['Contents/Info.plist', 'Contents/PkgInfo', `Contents/MacOS/${product}`, ARCHIVE, HELPER, GLASS, NOTIFICATION_PERMISSION, `${PLUGIN}plugin.toml`, `${PLUGIN}window.luau`, 'Contents/Resources/app-update.yml', 'Contents/Resources/icon.icns', 'Contents/Resources/LICENSE.electron.txt', 'Contents/Resources/LICENSES.chromium.html', 'Contents/_CodeSignature/CodeResources'].includes(value)) return true
  if (/^Contents\/Resources\/[a-zA-Z0-9_]+\.lproj\/InfoPlist\.strings$/.test(value)) return true
  const prefix = 'Contents/Frameworks/'
  if (!value.startsWith(prefix)) return false
  const relative = value.slice(prefix.length)
  for (const suffix of ['', ' (GPU)', ' (Plugin)', ' (Renderer)']) {
    const name = `${product} Helper${suffix}`
    if ([`${name}.app/Contents/Info.plist`, `${name}.app/Contents/PkgInfo`, `${name}.app/Contents/MacOS/${name}`, `${name}.app/Contents/_CodeSignature/CodeResources`].includes(relative)) return true
  }
  for (const name of ['Mantle', 'ReactiveObjC', 'Squirrel']) {
    if ([`${name}.framework/Versions/A/${name}`, `${name}.framework/Versions/A/Resources/Info.plist`, `${name}.framework/Versions/A/_CodeSignature/CodeResources`].includes(relative)) return true
  }
  if (relative === 'Squirrel.framework/Versions/A/Resources/ShipIt') return true
  return /^Electron Framework\.framework\/Versions\/A\/(?:Electron Framework|_CodeSignature\/CodeResources|Helpers\/(?:chrome_crashpad_handler|app_shim_loader)|Libraries\/(?:libffmpeg\.dylib|libvk_swiftshader\.dylib|vk_swiftshader_icd\.json)|Resources\/(?:Info\.plist|MainMenu\.nib|icudtl\.dat|resources\.pak|chrome_(?:100|200)_percent\.pak|v8_context_snapshot\.(?:arm64|x86_64)\.bin|[a-zA-Z0-9_]+\.lproj\/locale\.pak))$/.test(relative)
}
function appDirectoryAllowed(value, product) {
  if (['Contents', 'Contents/MacOS', 'Contents/Resources', 'Contents/Frameworks', 'Contents/_CodeSignature', 'Contents/Resources/tern-navigation', 'Contents/Resources/tern-navigation/plugin', 'Contents/Resources/liquid-glass', 'Contents/Resources/notification-permission'].includes(value)) return true
  if (/^Contents\/Resources\/[a-zA-Z0-9_]+\.lproj$/.test(value)) return true
  for (const suffix of ['', ' (GPU)', ' (Plugin)', ' (Renderer)']) {
    const base = `Contents/Frameworks/${product} Helper${suffix}.app`
    if ([base, `${base}/Contents`, `${base}/Contents/MacOS`, `${base}/Contents/_CodeSignature`].includes(value)) return true
  }
  return /^Contents\/Frameworks\/(?:Electron Framework|Mantle|ReactiveObjC|Squirrel)\.framework(?:\/Versions(?:\/A(?:\/(?:Helpers|Libraries|_CodeSignature|Resources(?:\/[a-zA-Z0-9_]+\.lproj)?))?)?)?$/.test(value)
}
function frameworkLinkAllowed(value) {
  return /^Contents\/Frameworks\/(Electron Framework|Mantle|ReactiveObjC|Squirrel)\.framework\/(?:Versions\/Current|Resources|Libraries|Helpers|Electron Framework|Mantle|ReactiveObjC|Squirrel)$/.test(value)
}
async function inspectApp(app, product) {
  requireThat((await lstat(app)).isDirectory(), '--app must be a regular directory')
  const canonicalApp = await realpath(app)
  const entries = []
  let count = 0
  let total = 0
  async function visit(directory, relative = '', depth = 0) {
    requireThat(depth <= 32, 'App directory depth exceeds limit')
    for await (const item of await opendir(directory)) {
      requireThat(++count <= MAX_ENTRIES, 'App entry count exceeds limit')
      const value = relative ? `${relative}/${item.name}` : item.name
      checkPath(value)
      const filename = path.join(directory, item.name)
      const info = await lstat(filename)
      if (info.isSymbolicLink()) {
        requireThat(frameworkLinkAllowed(value), `Unlisted app symlink: ${value}`)
        const target = await readlink(filename)
        requireThat(!path.isAbsolute(target) && target.length <= 1024, `Unsafe app symlink: ${value}`)
        const resolved = await realpath(filename)
        requireThat(resolved.startsWith(`${canonicalApp}${path.sep}`), `Escaping app symlink: ${value}`)
        entries.push({ path: value, bytes: Buffer.byteLength(target), sha256: hashBuffer(Buffer.from(target)), kind: 'symlink', mode: info.mode & 0o7777 })
        total += Buffer.byteLength(target)
      } else if (info.isDirectory()) {
        requireThat(appDirectoryAllowed(value, product), `Unlisted app directory: ${value}`)
        entries.push({ path: value, bytes: 0, sha256: EMPTY_HASH, kind: 'directory', mode: info.mode & 0o7777 })
        await visit(filename, value, depth + 1)
      } else {
        requireThat(info.isFile() && appFileAllowed(value, product), `Unlisted app file: ${value}`)
        total += info.size
        requireThat(total <= MAX_TOTAL, 'App aggregate bytes exceed limit')
        entries.push({ path: value, bytes: info.size, sha256: await hashFile(filename, info.size), kind: 'file', mode: info.mode & 0o7777 })
      }
    }
  }
  await visit(app)
  return { entries, bytes: total }
}
async function executable(filename, arch, label, fileType = 2) {
  let info
  try { info = await lstat(filename) } catch (error) { throw new Error(`Missing executable: ${label}`, { cause: error }) }
  requireThat(info.isFile() && (info.mode & 0o111) !== 0, `Non-executable or non-regular Mach-O: ${label}`)
  const handle = await open(filename, 'r')
  try {
    const header = Buffer.alloc(32)
    requireThat((await handle.read(header, 0, 32, 0)).bytesRead === 32 && header.readUInt32LE(0) === 0xfeedfacf, `Expected single-architecture Mach-O: ${label}`)
    const cpu = arch === 'arm64' ? 0x0100000c : 0x01000007
    requireThat(header.readUInt32LE(4) === cpu && header.readUInt32LE(12) === fileType, `Wrong architecture or Mach-O file type: ${label}`)
  } finally { await handle.close() }
  const { stdout } = await run('/usr/bin/lipo', ['-archs', filename], { timeout: 10_000, maxBuffer: 16 * 1024, encoding: 'utf8' })
  requireThat(stdout.trim() === (arch === 'arm64' ? 'arm64' : 'x86_64'), `Wrong or multiple architectures: ${label}`)
  return info.size
}
function lockedVersionMatches(spec, version) {
  // The reviewed manifest uses exact, caret or tilde stable versions only.
  // Reject new spec shapes explicitly rather than guessing npm resolution semantics.
  const wanted = /^(\^|~)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(spec)
  const actual = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  if (!wanted || !actual) return false
  const minimum = wanted.slice(2).map(Number)
  const current = actual.slice(1).map(Number)
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  if (!wanted[1]) return compare(current, minimum) === 0
  const upper = wanted[1] === '~' || (minimum[0] === 0 && minimum[1] > 0)
    ? [minimum[0], minimum[1] + 1, 0]
    : minimum[0] > 0 ? [minimum[0] + 1, 0, 0] : [0, 0, minimum[2] + 1]
  return compare(current, minimum) >= 0 && compare(current, upper) < 0
}
function checkRoot(manifest, lock) {
  requireThat(object(manifest) && object(lock) && lock.lockfileVersion >= 2 && object(lock.packages) && object(lock.packages['']), 'Missing manifest/lock metadata')
  const locked = lock.packages['']
  requireThat(manifest.name === lock.name && manifest.version === lock.version && manifest.name === locked.name && manifest.version === locked.version, 'Manifest-lock name/version mismatch')
  requireThat(manifest.main === 'out/main/index.js', 'Unexpected source main entry')
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    requireThat(sameMap(manifest[section], locked[section]), `Manifest-lock ${section} mismatch`)
  }
  requireThat(Object.keys(manifest.dependencies ?? {}).length === 0, 'External runtime dependencies are not allowed')
  requireThat(Object.keys(manifest.optionalDependencies ?? {}).length === 0, 'Optional runtime dependencies are not allowed')
  for (const [name, spec] of Object.entries({ ...manifest.devDependencies, ...manifest.dependencies })) {
    const version = lock.packages[`node_modules/${name}`]?.version
    requireThat(typeof version === 'string', `Missing locked direct dependency: ${name}`)
    requireThat(lockedVersionMatches(spec, version), `Locked direct version does not satisfy reviewed manifest range: ${name}`)
  }
  for (const name of RENDERER_PACKAGES) requireThat(typeof manifest.devDependencies?.[name] === 'string', `Bundled renderer dependency must be dev-only: ${name}`)
}
function asarFileAllowed(value) {
  return value === 'package.json' || value === 'out/main/index.js' || value === 'out/preload/index.js' || value === 'out/renderer/index.html' || /^out\/(?:main|renderer)\/(?:bundled-dependencies\.json|THIRD_PARTY_NOTICES\.txt)$/.test(value) || /^out\/(?:main|preload)\/chunks\/[a-zA-Z0-9_-]+\.js$/.test(value) || /^out\/renderer\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css|svg|png|jpg|jpeg|webp|ico|woff2?|ttf)$/.test(value)
}
async function archiveHeader(filename) {
  const info = await lstat(filename)
  requireThat(info.isFile() && info.size <= MAX_FILE, 'ASAR must be a bounded regular file')
  const handle = await open(filename, 'r')
  try {
    const prefix = Buffer.alloc(16)
    requireThat((await handle.read(prefix, 0, 16, 0)).bytesRead === 16 && prefix.readUInt32LE(0) === 4, 'Invalid ASAR header prefix')
    const size = prefix.readUInt32LE(4)
    const length = prefix.readUInt32LE(12)
    requireThat(size >= 8 && size <= MAX_HEADER && size + 8 <= info.size && prefix.readUInt32LE(8) === size - 4 && length > 0 && length <= size - 8, 'ASAR header exceeds bounds or is malformed')
    const bytes = Buffer.alloc(length)
    requireThat((await handle.read(bytes, 0, length, 16)).bytesRead === length, 'Truncated ASAR header')
    const header = parseJson(bytes, 'ASAR header')
    const files = new Map()
    let count = 0
    function visit(node, parent = '', depth = 0) {
      requireThat(depth <= 32 && object(node) && object(node.files), 'Malformed or too-deep ASAR directory')
      for (const [name, item] of Object.entries(node.files)) {
        requireThat(++count <= MAX_ENTRIES, 'ASAR entry count exceeds limit')
        requireThat(!name.includes('/'), 'Invalid ASAR entry name')
        const value = parent ? `${parent}/${name}` : name
        checkPath(value)
        requireThat(object(item) && !item.link && !item.unpacked, `ASAR links and unpacked entries are forbidden: ${value}`)
        if (item.files) {
          requireThat(['out', 'out/main', 'out/main/chunks', 'out/preload', 'out/preload/chunks', 'out/renderer', 'out/renderer/assets'].includes(value), `Unlisted ASAR directory: ${value}`)
          visit(item, value, depth + 1)
        } else {
          requireThat(asarFileAllowed(value), `Unlisted ASAR file: ${value}`)
          requireThat(integer(item.size) && item.size <= MAX_FILE && typeof item.offset === 'string' && /^\d+$/.test(item.offset), `Invalid ASAR file range: ${value}`)
          const start = Number(item.offset) + size + 8
          requireThat(integer(start) && start + item.size <= info.size, `ASAR file range exceeds archive: ${value}`)
          files.set(value, { bytes: item.size, start })
        }
      }
    }
    visit(header)
    let cursor = size + 8
    for (const item of [...files.values()].sort((a, b) => a.start - b.start || a.bytes - b.bytes)) {
      requireThat(item.start === cursor, 'ASAR contains overlapping entries or hidden payload gaps')
      cursor += item.bytes
    }
    requireThat(cursor === info.size, 'ASAR contains unlisted trailing payload')
    return { files, bytes: info.size }
  } finally { await handle.close() }
}
async function inspectArchive(filename, manifest, lock) {
  // Bound and validate the serialized header and entry count before the ASAR library allocates it.
  try {
    const { files, bytes } = await archiveHeader(filename)
    function metadata(name) {
      const item = files.get(name)
      requireThat(item && item.bytes <= MAX_METADATA, `Missing or oversized ASAR metadata: ${name}`)
      return asar.extractFile(filename, name)
    }
    for (const name of ['package.json', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', ...BUNDLE_SCOPES.flatMap(scope => [`out/${scope}/bundled-dependencies.json`, `out/${scope}/THIRD_PARTY_NOTICES.txt`])]) {
      requireThat(files.has(name) && files.get(name).bytes > 0, `Missing required ASAR entry: ${name}`)
    }
    const packed = parseJson(metadata('package.json'), 'packed package.json')
    requireThat(packed.name === manifest.name && packed.version === manifest.version && packed.main === 'out/main/index.js' && sameMap(packed.dependencies, manifest.dependencies), 'Packed manifest disagrees with source runtime contract')
    requireThat(!Object.keys(packed.devDependencies ?? {}).length && !Object.keys(packed.optionalDependencies ?? {}).length, 'Packed manifest retains development/optional dependencies')
    const bundledDependencies = []
    for (const scope of BUNDLE_SCOPES) {
      const inventory = parseJson(metadata(`out/${scope}/bundled-dependencies.json`), `${scope} bundled dependencies`)
      requireThat(inventory.schema === 1 && Array.isArray(inventory.packages) && inventory.packages.length > 0 && inventory.packages.length <= 1000, 'Invalid bundled dependency inventory')
      const notices = metadata(`out/${scope}/THIRD_PARTY_NOTICES.txt`).toString('utf8')
      let previous
      for (const item of inventory.packages) {
        requireThat(object(item) && typeof item.name === 'string' && typeof item.version === 'string' && typeof item.license === 'string' && item.license.length > 0 && integer(item.renderedBytes), 'Invalid bundled dependency record')
        requireThat(!previous || previous.name.localeCompare(item.name) < 0 || (previous.name === item.name && previous.version.localeCompare(item.version) < 0), 'Duplicate or unsorted bundled dependency record')
        previous = item
        const matches = Object.entries(lock.packages).filter(([key, entry]) => (key === `node_modules/${item.name}` || key.endsWith(`/node_modules/${item.name}`)) && entry.version === item.version && entry.license === item.license)
        requireThat(matches.length > 0, `Bundled dependency disagrees with lock: ${item.name}@${item.version}`)
        requireThat(notices.includes(item.name) && notices.includes(item.version), `Missing bundled license notice: ${item.name}@${item.version}`)
      }
      if (scope === 'renderer') for (const name of RENDERER_PACKAGES) requireThat(inventory.packages.some(item => item.name === name), `Missing bundled renderer dependency: ${name}`)
      bundledDependencies.push(...inventory.packages)
    }
    function referenced(ref, from) {
      const value = ref.split(/[?#]/)[0]
      requireThat(value && !/^(?:[a-z]+:|\/\/)/i.test(value), `Nonlocal renderer asset reference: ${ref}`)
      const resolved = path.posix.normalize(value.startsWith('/') ? `out/renderer/${value.slice(1)}` : path.posix.join(path.posix.dirname(from), value))
      requireThat(resolved.startsWith('out/renderer/') && files.has(resolved), `Missing referenced renderer asset: ${ref}`)
    }
    const html = metadata('out/renderer/index.html').toString('utf8')
    let assets = 0
    for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
      referenced(match[1], 'out/renderer/index.html')
      assets++
    }
    requireThat(assets > 0, 'Renderer index has no local assets')
    for (const name of files.keys()) {
      if (!name.startsWith('out/renderer/assets/') || !/\.(?:js|css)$/.test(name)) continue
      const text = metadata(name).toString('utf8')
      if (name.endsWith('.css')) {
        for (const match of text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) {
          if (!match[1].startsWith('data:')) referenced(match[1], name)
        }
      } else {
        for (const match of text.matchAll(/(?:^|[;\n}])\s*(?:import\s*(?:[^"'();\n]*?\bfrom\s*)?|export\s*[^"'();\n]*?\bfrom\s*)["']([^"']+)["']/g)) referenced(match[1], name)
        for (const match of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) referenced(match[1], name)
      }
    }
    const entries = []
    for (const [name, item] of files) entries.push({ path: `asar:${name}`, bytes: item.bytes, sha256: await hashFile(filename, item.bytes, item.start), kind: 'asar' })
    return { bytes, entries, dependencies: [], bundledDependencies }
  } finally { asar.uncache(filename) }
}
async function pluginSources(app, root) {
  for (const name of ['plugin.toml', 'window.luau']) {
    const source = await boundedRead(path.join(root, 'resources/tern-navigation/plugin', name))
    const packed = await boundedRead(path.join(app, PLUGIN, name))
    requireThat(source.length > 0 && source.equals(packed), `Packaged plugin differs from source: ${name}`)
    if (name === 'plugin.toml') {
      const text = packed.toString('utf8')
      for (const [key, expected] of [['schema', '1'], ['id', '"oc-chan-navigation"'], ['window', '"window.luau"']]) {
        const values = [...text.matchAll(new RegExp(`^${key}\\s*=\\s*([^\\r\\n#]+)`, 'gm'))]
        requireThat(values.length === 1 && values[0][1].trim() === expected, `Invalid plugin manifest field: ${key}`)
      }
    }
  }
}
async function artifacts(directory, manifest, arch) {
  if (!directory) return []
  const result = []
  let count = 0
  for await (const item of await opendir(directory)) {
    requireThat(++count <= MAX_ENTRIES, 'Artifact directory entry count exceeds limit')
    if (!/\.(?:zip|dmg)$/.test(item.name)) continue
    if (!item.name.endsWith(`-${arch}.zip`) && !item.name.endsWith(`-${arch}.dmg`)) continue
    requireThat(item.name === `OC-Chan-${manifest.version}-mac-${arch}${path.extname(item.name)}`, `Unexpected distribution artifact: ${item.name}`)
    const filename = path.join(directory, item.name)
    const info = await lstat(filename)
    requireThat(info.isFile() && info.size > 0, `Artifact must be a nonempty regular file: ${item.name}`)
    result.push({ name: item.name, bytes: info.size, sha256: await hashFile(filename, info.size) })
  }
  for (const extension of ['zip', 'dmg']) requireThat(result.some(item => item.name.endsWith(`.${extension}`)), `Missing ${arch} distribution artifact: ${extension}`)
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

export function enforceBudget(report, baseline) {
  requireThat(baseline?.schema === 1 && object(baseline.architectures), 'Missing or invalid frozen package baseline')
  const target = baseline.architectures[report.arch]
  requireThat(object(target?.limits) && Array.isArray(target.entries) && target.entries.length <= MAX_ENTRIES * 2, `Missing or invalid frozen baseline for ${report.arch}`)
  const errors = []
  const compare = (label, actual, limit) => {
    requireThat(integer(limit) && limit > 0, `Missing or invalid baseline limit: ${label}`)
    requireThat(integer(actual), `Invalid measured size: ${label}`)
    if (actual > limit) errors.push(`${label}: ${actual} > ${limit} (+${actual - limit} bytes)`)
  }
  for (const name of ['appBytes', 'asarBytes', 'helperBytes']) compare(name, report[name], target.limits[name])
  for (const extension of ['zip', 'dmg']) {
    requireThat(integer(target.limits[`${extension}Bytes`]) && target.limits[`${extension}Bytes`] > 0, `Missing or invalid baseline limit: ${extension}Bytes`)
    for (const artifact of report.artifacts.filter(item => item.name.endsWith(`.${extension}`))) compare(artifact.name, artifact.bytes, target.limits[`${extension}Bytes`])
  }
  requireThat(object(target.limits.dependencyBytes), 'Missing dependency byte budgets')
  for (const dependency of report.dependencies) compare(`dependency:${dependency.name}`, dependency.bytes, target.limits.dependencyBytes[dependency.name])
  const previous = new Map()
  for (const entry of target.entries) {
    requireThat(typeof entry.path === 'string' && integer(entry.bytes) && !previous.has(entry.path), 'Invalid baseline entry')
    previous.set(entry.path, entry.bytes)
  }
  const growth = report.entries.map(entry => ({ path: entry.path, bytes: entry.bytes, growthBytes: entry.bytes - (previous.get(entry.path) ?? 0), new: !previous.has(entry.path) })).filter(entry => entry.growthBytes > 0).sort((a, b) => b.growthBytes - a.growthBytes).slice(0, 20)
  if (errors.length) {
    const error = new Error(`Package size budget exceeded:\n${errors.join('\n')}\nLargest new/growing entries:\n${growth.map(entry => `${entry.new ? 'NEW ' : ''}${entry.path}: +${entry.growthBytes} bytes`).join('\n')}`)
    error.growth = growth
    throw error
  }
  return { status: 'passed', largestGrowth: growth }
}

export async function inspectPackage(options) {
  const { app, arch, artifactsDir, output, measure = false } = options
  const root = path.resolve(options.root ?? ROOT)
  requireThat(typeof app === 'string' && path.isAbsolute(app) && ['arm64', 'x64'].includes(arch), 'Expected --app ABS_APP and --arch arm64|x64')
  const packageBytes = await boundedRead(path.join(root, 'package.json'))
  const lockBytes = await boundedRead(path.join(root, 'package-lock.json'), MAX_HEADER)
  const manifest = parseJson(packageBytes, 'package.json')
  const lock = parseJson(lockBytes, 'package-lock.json')
  checkRoot(manifest, lock)
  const product = manifest.build?.productName
  requireThat(product === 'OC Chan', 'Unexpected application product name')
  const appTree = await inspectApp(app, product)
  const helperBytes = await executable(path.join(app, HELPER), arch, HELPER)
  const glassBytes = await executable(path.join(app, GLASS), arch, GLASS, 8)
  const notificationBytes = await executable(path.join(app, NOTIFICATION_PERMISSION), arch, NOTIFICATION_PERMISSION, 8)
  requireThat(notificationBytes <= 256 * 1024, 'Notification permission module exceeds 256 KiB budget')
  await executable(path.join(app, `Contents/MacOS/${product}`), arch, `Contents/MacOS/${product}`)
  for (const required of ['Contents/Info.plist', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', 'Contents/Resources/LICENSE.electron.txt', 'Contents/Resources/LICENSES.chromium.html']) requireThat(appTree.entries.some(entry => entry.path === required && entry.kind === 'file' && entry.bytes > 0), `Missing app runtime resource: ${required}`)
  await pluginSources(app, root)
  const archive = await inspectArchive(path.join(app, ARCHIVE), manifest, lock)
  const report = {
    schema: 1, arch, appBytes: appTree.bytes, asarBytes: archive.bytes, helperBytes, glassBytes, notificationBytes,
    artifacts: await artifacts(artifactsDir, manifest, arch),
    entries: [...appTree.entries, ...archive.entries].sort((a, b) => a.path.localeCompare(b.path)),
    dependencies: archive.dependencies, bundledDependencies: archive.bundledDependencies,
    source: { packageHash: hashBuffer(packageBytes), lockHash: hashBuffer(lockBytes) },
    policy,
    budget: { status: measure ? 'measurement-only' : 'pending' }
  }
  let failure
  if (!measure) {
    try {
      const baseline = parseJson(await boundedRead(path.resolve(options.budget ?? path.join(root, 'docs/package-baseline.json')), MAX_HEADER), 'package baseline')
      report.budget = enforceBudget(report, baseline)
    } catch (error) {
      report.budget = { status: 'failed', error: error.code ? `Cannot read frozen package baseline (${error.code})` : error.message, largestGrowth: error.growth ?? [] }
      failure = error
    }
  }
  if (output) {
    const destination = path.resolve(output)
    requireThat(destination !== app && !destination.startsWith(`${path.resolve(app)}${path.sep}`) && ![path.join(root, 'package.json'), path.join(root, 'package-lock.json'), path.resolve(options.budget ?? path.join(root, 'docs/package-baseline.json'))].includes(destination), 'Report output must not overwrite app/source/baseline')
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`)
  }
  if (failure) throw failure
  return report
}

async function cli() {
  const options = {}
  const names = { '--app': 'app', '--arch': 'arch', '--artifacts-dir': 'artifactsDir', '--output': 'output', '--budget': 'budget' }
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--measure') {
      requireThat(!options.measure, 'Duplicate --measure')
      options.measure = true
    } else {
      const key = names[flag]
      requireThat(key && !options[key] && args[index + 1] && !args[index + 1].startsWith('--'), `Unknown, duplicate or incomplete option: ${flag}`)
      options[key] = args[++index]
    }
  }
  requireThat(options.output, 'Required --output JSON')
  const report = await inspectPackage(options)
  console.log(`Package ${report.arch}: app=${report.appBytes}, asar=${report.asarBytes}, helper=${report.helperBytes}; budget=${report.budget.status}`)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(error => { console.error(error.message); process.exitCode = 1 })
}
