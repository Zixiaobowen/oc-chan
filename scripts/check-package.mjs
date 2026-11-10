import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, readlink, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ROOT, TARGET, BUNDLE_ID, NATIVE_RESOURCES, assert, within, boundedJson, digestFile, codeDirectoryHash } from './build-app.mjs'
import { readBounded, RUST_LIMITS, RUST_ROOTS, RUST_TARGET, sha256 } from './rust-dependencies.mjs'

const execute = promisify(execFile)
const MAX_ENTRIES = 4096, MAX_TOTAL = 2 * 1024 ** 3, MAX_FILE = 512 * 1024 ** 2
const REQUIRED = ['oc-data-worker', 'oc-installer', 'tern-navigation/present-window', 'tern-navigation/plugin/plugin.toml', 'tern-navigation/plugin/window.luau', 'plugin-market/catalog.json', 'rust-dependencies/manifest.json']
export function forbiddenPackagePath(value) {
  return value.split('/').some(part => /^(?:electron(?: framework)?(?:\.framework)?|chromium(?: framework)?(?:\.framework)?|node(?:\.exe)?|node_modules|tests?|__tests__|__mocks__|fixtures?|drivers?|coverage|logs?|caches?|\.git|\.DS_Store)$/i.test(part))
    || /\.(?:node|asar|map|ts|tsx|sqlite|db|log|pem|key)$/i.test(value) || /(?:^|\/)[^/]*\.(?:test|spec)\.[^/]+$/i.test(value)
}
export async function inspectTree(app) {
  const root = await realpath(app); const rootInfo = await lstat(app)
  assert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && root === path.resolve(app), 'App must be a real directory without a symlink alias')
  const entries = []; let total = 0, names = 0
  async function visit(directory, depth) {
    assert(depth <= 64, 'Application directory depth exceeds update budget')
    const stream = await opendir(directory)
    for await (const item of stream) {
      const absolute = path.join(directory, item.name), relative = path.relative(root, absolute).split(path.sep).join('/')
      assert(entries.length < MAX_ENTRIES && Buffer.byteLength(relative) <= 1024, 'Application inventory exceeds update entry/name budget')
      names += Buffer.byteLength(relative); assert(names <= 256 * 1024, 'Application path names exceed update metadata budget')
      assert(!forbiddenPackagePath(relative), `Forbidden packaged runtime/development file: ${relative}`)
      const metadata = await lstat(absolute); assert((metadata.mode & 0o7000) === 0, `Unsafe package permissions: ${relative}`)
      if (metadata.isSymbolicLink()) {
        const target = await readlink(absolute); assert(!path.isAbsolute(target) && Buffer.byteLength(target) <= 1024, `Invalid application symlink: ${relative}`)
        const resolved = await realpath(absolute); assert(resolved === root || within(root, resolved), `Application symlink escapes bundle: ${relative}`)
        entries.push({ path: relative, kind: 'symlink', target, bytes: Buffer.byteLength(target), mode: metadata.mode & 0o7777, sha256: createHash('sha256').update(target).digest('hex') })
      } else if (metadata.isDirectory()) { entries.push({ path: relative, kind: 'directory', bytes: 0, mode: metadata.mode & 0o7777, sha256: createHash('sha256').digest('hex') }); await visit(absolute, depth + 1) }
      else {
        assert(metadata.isFile() && metadata.nlink === 1 && metadata.size > 0 && metadata.size <= MAX_FILE, `Invalid package file: ${relative}`)
        total += metadata.size; assert(total <= MAX_TOTAL, 'Application exceeds 2 GiB expanded update budget')
        const hashed = await digestFile(absolute)
        assert(hashed.bytes === metadata.size, `Package file changed during inventory: ${relative}`)
        entries.push({ path: relative, kind: 'file', bytes: metadata.size, sha256: hashed.digest, mode: metadata.mode & 0o7777 })
      }
    }
  }
  await visit(root, 0); entries.sort((a, b) => a.path.localeCompare(b.path)); return { entries, bytes: total }
}
export async function inspectExecutable(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat(); assert(info.isFile() && info.nlink === 1 && info.size >= 32 && info.size <= MAX_FILE && (info.mode & 0o111) !== 0, `Missing executable or invalid size/mode: ${filename}`)
    const header = Buffer.alloc(32); const { bytesRead } = await handle.read(header, 0, header.length, 0)
    assert(bytesRead === 32 && header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === 0x0100000c && header.readUInt32LE(12) === 2, `Expected thin arm64 MH_EXECUTE Mach-O: ${filename}`)
    assert(header.readUInt32LE(16) > 0 && header.readUInt32LE(20) <= info.size - 32, `Invalid Mach-O load commands: ${filename}`)
    return info.size
  } finally { await handle.close() }
}
export async function inspectBuildMarkers(filename, expected) {
  assert(/^[a-f0-9]{64}$/.test(expected), 'Invalid expected catalog pin')
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat(); assert(info.isFile() && info.size <= MAX_FILE, 'Invalid host binary for build pin inspection')
    let overlap = Buffer.alloc(0); const pins = new Set(); let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      bytes += chunk.length; assert(bytes <= MAX_FILE, 'Host binary grew beyond package budget')
      const window = Buffer.concat([overlap, chunk]); const text = window.toString('latin1')
      assert(!['OC_CHAN_ACCEPTANCE_DRIVER_V1', '_webProcessIdentifier', '_provisionalWebProcessIdentifier', '_gpuProcessIdentifier', '_networkProcessIdentifier'].some(marker => text.includes(marker)), 'Acceptance driver or private WebKit selector is compiled into the production application')
      for (const match of text.matchAll(/OC_CHAN_CATALOG_SHA256=([a-f0-9]{64})/g)) pins.add(match[1])
      overlap = window.subarray(Math.max(0, window.length - 128))
    }
    assert(bytes === info.size && pins.size === 1 && pins.has(expected), 'Host compiled catalog pin does not match packaged plugin catalog')
  } finally { await handle.close() }
}
export function validatePlist(plist, version) {
  assert(plist.CFBundleIdentifier === BUNDLE_ID && plist.CFBundlePackageType === 'APPL', 'Unexpected application bundle identity/type')
  assert(plist.CFBundleExecutable === 'oc-chan' && plist.CFBundleShortVersionString === version, 'Application executable/version does not match this build')
}
function validateRecord(record, root) {
  assert(record.schema === 2 && record.root === root && record.mode === 'release' && record.arch === 'arm64' && record.target === TARGET
    && JSON.stringify(record.features) === JSON.stringify(['custom-protocol']) && /^[a-f0-9]{64}$/.test(record.catalogSha256), 'Production Rust build receipt is missing or invalid')
  assert(record.sign === '-' || /^Developer ID Application: /.test(record.sign), 'Invalid package signing policy')
}
export function validateRustLegalManifest(manifest, expected, resourceDigest) {
  assert(manifest?.schema === 1 && manifest.target === RUST_TARGET && manifest.lockSha256 === expected.lockSha256 && manifest.supplementManifestSha256 === expected.supplementManifestSha256 && JSON.stringify(manifest.roots) === JSON.stringify(RUST_ROOTS), 'Rust legal manifest does not match the exact Cargo lock, source supplements or production roots')
  assert(Array.isArray(manifest.packages) && manifest.packages.length > 0 && manifest.packages.length <= RUST_LIMITS.packages, 'Invalid Rust legal package inventory')
  const resources = new Map(), ids = new Set(); let total = 0
  for (const item of manifest.packages) {
    assert(typeof item.name === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item.name) && /^[0-9A-Za-z.+-]{1,128}$/.test(item.version) && item.source === 'registry+https://github.com/rust-lang/crates.io-index' && item.id === `${item.source}#${item.name}@${item.version}` && !ids.has(item.id), 'Invalid or duplicate Rust legal package identity')
    assert(/^[a-f0-9]{64}$/.test(item.checksum) && typeof item.license === 'string' && item.license.length > 0 && item.license !== 'UNKNOWN' && ['runtime', 'build', 'runtime-and-build'].includes(item.classification), 'Unverified Rust license or dependency classification')
    ids.add(item.id)
    assert(Array.isArray(item.licenseFiles) && item.licenseFiles.length > 0 && item.licenseFiles.length <= RUST_LIMITS.licenseFiles, 'Rust package has no complete LICENSE/NOTICE files')
    for (const file of item.licenseFiles) {
      const prefix = `licenses/${item.name}-${item.version}/`
      assert(typeof file.path === 'string' && file.path.startsWith(prefix) && /^\d{4}-[^/]+$/.test(file.path.slice(prefix.length)) && Buffer.byteLength(file.path) <= 2048 && !/[\\\0\r\n]/.test(file.path) && !/\.(?:rs|c|h|cpp|js|ts|py|sh)$/i.test(file.path), 'Rust legal path escapes its declared package or contains source code')
      assert(typeof file.sourcePath === 'string' && Buffer.byteLength(file.sourcePath) <= 2048 && file.sourcePath.split('/').every(part => part && part !== '.' && part !== '..') && !/[\\\0\r\n]/.test(file.sourcePath), 'Rust legal resource lacks its original source path')
      assert(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= RUST_LIMITS.licenseBytes && /^[a-f0-9]{64}$/.test(file.sha256), 'Invalid Rust legal file size or digest')
      const relative = `rust-dependencies/${file.path}`
      assert(!resources.has(relative) && resources.size < RUST_LIMITS.licenseFiles && total + file.bytes <= RUST_LIMITS.totalLicenseBytes, 'Duplicate Rust legal resource or aggregate budget exceeded')
      const actual = resourceDigest(relative)
      assert(actual.bytes === file.bytes && actual.digest === file.sha256, `Packaged Rust license changed: ${relative}`)
      total += file.bytes; resources.set(relative, actual)
    }
  }
  return { resources, packages: ids.size, licenseFiles: resources.size, licenseBytes: total }
}
export function validateFrozenBudgets(report, baseline) {
  const limits = baseline?.architectures?.arm64?.limits
  assert(baseline?.schema === 1 && limits && ['appBytes', 'helperBytes', 'zipBytes', 'dmgBytes'].every(key => Number.isSafeInteger(limits[key]) && limits[key] > 0), 'Missing frozen arm64 package budgets')
  const measured = { appBytes: report.appBytes, helperBytes: report.executableBytes['Contents/Resources/tern-navigation/present-window'] }
  if (report.artifacts.zip) measured.zipBytes = report.artifacts.zip.bytes
  if (report.artifacts.dmg) measured.dmgBytes = report.artifacts.dmg.bytes
  for (const [key, bytes] of Object.entries(measured)) assert(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= limits[key], `Frozen package budget exceeded: ${key} ${bytes}/${limits[key]}`)
  // ASAR and systeminformation budgets have no corresponding Rust runtime asset.
  // Host/worker/installer binaries remain covered by the unchanged total app budget.
  return { source: 'docs/package-baseline.json', limits: Object.fromEntries(Object.keys(measured).map(key => [key, limits[key]])), measured }
}
export async function inspectPackage(options) {
  const root = path.resolve(options.root ?? ROOT), app = path.resolve(options.app ?? '')
  assert(options.app && options.arch === 'arm64' && process.platform === 'darwin', 'Expected a macOS --app ABS_APP --arch arm64 package')
  const record = options.buildRecord ?? await boundedJson(path.join(root, 'release/tauri/build.json')); validateRecord(record, root)
  const tree = await inspectTree(app)
  const fileEntries = new Map(tree.entries.filter(entry => entry.kind === 'file').map(entry => [entry.path, entry]))
  function resourceDigest(relative) {
    const entry = fileEntries.get(`Contents/Resources/${relative}`)
    assert(entry, `Missing regular resource: ${relative}`)
    return { bytes: entry.bytes, digest: entry.sha256 }
  }
  const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], { timeout: 10_000, maxBuffer: 64 * 1024 })
  validatePlist(JSON.parse(stdout), record.version)
  const resourceRoot = path.join(app, 'Contents/Resources'); const catalog = await boundedJson(path.join(resourceRoot, 'plugin-market/catalog.json'), 256 * 1024)
  assert(catalog.schema === 1 && Array.isArray(catalog.plugins) && catalog.plugins.length > 0 && catalog.plugins.length <= 16, 'Invalid packaged plugin catalog')
  const allowedResources = new Set(REQUIRED), ids = new Set()
  for (const entry of catalog.plugins) {
    assert(entry.manifest?.apiVersion === 2 && entry.manifest.target === TARGET && /^[a-z][a-z0-9-]{0,63}$/.test(entry.manifest.id) && !ids.has(entry.manifest.id), 'Invalid native plugin identity/target')
    ids.add(entry.manifest.id); assert(entry.package === `${entry.manifest.id}-${entry.manifest.version}.ocplugin` && !entry.package.includes('/') && !entry.package.includes('..'), 'Invalid plugin package filename')
    assert(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= 2 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(entry.sha256), 'Invalid plugin package digest/size')
    const relative = `plugin-market/${entry.package}`; const actual = resourceDigest(relative)
    assert(actual.bytes === entry.bytes && actual.digest === entry.sha256, `Packaged plugin differs from pinned catalog: ${entry.manifest.id}`); allowedResources.add(relative)
  }
  const resources = {}
  for (const relative of allowedResources) {
    const actual = resourceDigest(relative); const expected = record.resources?.[relative]
    assert(expected, `Resource is absent from this build receipt: ${relative}`)
    if (NATIVE_RESOURCES.includes(relative)) {
      // The final bundle signature may refresh CMS timestamps. CodeDirectory
      // identity binds the executable pages without pinning timestamp bytes.
      actual.codeDirectoryHash = await codeDirectoryHash(path.join(resourceRoot, relative))
      assert(actual.codeDirectoryHash === expected.codeDirectoryHash, `Packaged native code differs from this build: ${relative}`)
    } else assert(actual.digest === expected.digest && actual.bytes === expected.bytes, `Packaged resource differs from this build: ${relative}`)
    resources[relative] = actual
  }
  assert(resources['plugin-market/catalog.json'].digest === record.catalogSha256, 'Catalog differs from compile-time build pin')
  const rustManifest = await boundedJson(path.join(resourceRoot, 'rust-dependencies/manifest.json'), RUST_LIMITS.metadata)
  const rustLegal = validateRustLegalManifest(rustManifest, { lockSha256: sha256(readBounded(path.join(root, 'Cargo.lock'))), supplementManifestSha256: sha256(readBounded(path.join(root, 'resources/rust-license-supplements/manifest.json'), 256 * 1024)) }, resourceDigest)
  for (const [relative, actual] of rustLegal.resources) { allowedResources.add(relative); resources[relative] = actual }
  const allowedFiles = new Set(['Contents/Info.plist', 'Contents/PkgInfo', 'Contents/MacOS/oc-chan', 'Contents/_CodeSignature/CodeResources', ...[...allowedResources].map(value => `Contents/Resources/${value}`)])
  const allowedDirectories = new Set()
  for (const file of allowedFiles) for (let directory = path.posix.dirname(file); directory !== '.'; directory = path.posix.dirname(directory)) allowedDirectories.add(directory)
  for (const entry of tree.entries) {
    if (entry.kind === 'directory') { assert(allowedDirectories.has(entry.path), `Unexpected directory in Rust application: ${entry.path}`); continue }
    const icon = /^Contents\/Resources\/[^/]+\.icns$/.test(entry.path)
    assert(entry.kind === 'file' && (allowedFiles.has(entry.path) || icon), `Unexpected file in Rust application: ${entry.path}`)
  }
  const executableBytes = {}
  for (const relative of ['Contents/MacOS/oc-chan', ...['oc-data-worker', 'oc-installer', 'tern-navigation/present-window'].map(value => `Contents/Resources/${value}`)]) executableBytes[relative] = await inspectExecutable(path.join(app, relative))
  await inspectBuildMarkers(path.join(app, 'Contents/MacOS/oc-chan'), record.catalogSha256)
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', app], { timeout: 120_000, maxBuffer: 256 * 1024 })
  const signed = record.sign !== '-'
  if (signed) {
    await execute('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', `=anchor apple generic and identifier "${BUNDLE_ID}" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`, app], { timeout: 120_000, maxBuffer: 256 * 1024 })
    await execute('/usr/sbin/spctl', ['--assess', '--type', 'execute', app], { timeout: 120_000, maxBuffer: 256 * 1024 })
  }
  const artifacts = {}
  if (options.artifactsDir) {
    const prefix = `OC-Chan-${record.version}-mac-arm64`
    for (const extension of ['zip', 'dmg']) {
      const filename = path.join(path.resolve(options.artifactsDir), `${prefix}.${extension}`)
      const hash = await digestFile(filename, extension === 'zip' ? 'sha512' : 'sha256'); artifacts[extension] = { path: filename, ...hash }
    }
    await execute('/usr/bin/hdiutil', ['verify', artifacts.dmg.path], { timeout: 120_000, maxBuffer: 256 * 1024 })
  }
  const report = { schema: 2, arch: 'arm64', buildId: record.buildId, version: record.version, app, appBytes: tree.bytes, entries: tree.entries,
    executableBytes, catalogSha256: record.catalogSha256, resources, artifacts, rustDependencies: { lockSha256: rustManifest.lockSha256, manifestSha256: resources['rust-dependencies/manifest.json'].digest, packages: rustLegal.packages, licenseFiles: rustLegal.licenseFiles, licenseBytes: rustLegal.licenseBytes }, signature: signed ? 'Developer ID and Gatekeeper verified' : 'ad-hoc verified; online updates disabled',
    limits: { entries: MAX_ENTRIES, expandedBytes: MAX_TOTAL, singleFileBytes: MAX_FILE, pathBytes: 256 * 1024 } }
  report.frozenBudgets = validateFrozenBudgets(report, await boundedJson(path.join(root, 'docs/package-baseline.json')))
  if (options.output) {
    const destination = path.resolve(options.output); assert(destination !== app && !within(app, destination), 'Inspection output must be outside the application')
    await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
  return report
}
async function cli(args) {
  const names = { '--app': 'app', '--arch': 'arch', '--artifacts-dir': 'artifactsDir', '--output': 'output' }, options = {}
  for (let index = 0; index < args.length; index++) {
    const key = names[args[index]]; assert(key && !options[key] && args[index + 1] && !args[index + 1].startsWith('--'), `Unknown, duplicate or missing package option: ${args[index]}`); options[key] = args[++index]
  }
  const report = await inspectPackage(options); console.log(`Rust package arm64: ${report.appBytes} bytes; ${report.entries.length} entries; ${report.signature}`)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1 })
