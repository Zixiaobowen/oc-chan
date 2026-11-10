import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { inspectPackage } from './check-package.mjs'
import { artifactDigest, signatureStatus, verifyArtifactDigests } from './local-delivery.mjs'
import { digestFile, within } from './build-app.mjs'

const appId = 'local.oc-chan.desktop'
function requireThat(condition, message) { if (!condition) throw new Error(message) }
function command(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 1024 * 1024 }).trim()
}
export async function installationJson(filename, maximum = 8 * 1024 * 1024) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    requireThat(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= maximum, 'Installation metadata must be a bounded regular file')
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await file.stat()
    requireThat(offset === info.size && after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs, 'Installation metadata changed while reading')
    return JSON.parse(bytes.subarray(0, offset).toString('utf8'))
  } finally { await file.close() }
}
export function checkInstallTarget(target) {
  requireThat(path.isAbsolute(target) && path.basename(target) === 'OC Chan.app', 'Invalid installation target')
  const parent = path.dirname(target)
  const directory = lstatSync(parent)
  requireThat(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o222) !== 0, 'Installation directory is not writable or is a symlink')
  accessSync(parent, constants.W_OK | constants.X_OK)
  let previous
  try { previous = lstatSync(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (previous) {
    requireThat(previous.isDirectory() && !previous.isSymbolicLink(), 'Installed application must be a real directory')
    const plist = path.join(target, 'Contents/Info.plist')
    const info = lstatSync(plist)
    requireThat(info.isFile() && info.nlink === 1 && info.size <= 64 * 1024, 'Invalid installed application identity file')
    requireThat(command('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]) === appId, 'Installed application identifier differs')
  }
}
export function acquireInstallLock(filename, owner) {
  try { mkdirSync(filename, { mode: 0o700 }) }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`已有安装任务或未清理的安装锁：${filename}；确认任务结束后再处理`)
    throw error
  }
  // The caller owns this directory from mkdir onward, including an owner-record write failure.
  return () => writeFileSync(path.join(filename, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
}
export function checkInstallSpace(directory, inventory, statfs = statfsSync) {
  requireThat(Number.isSafeInteger(inventory.appBytes) && inventory.appBytes > 0 && inventory.appBytes <= 2 * 1024 ** 3 && Array.isArray(inventory.entries) && inventory.entries.length <= 4096, 'Invalid installation size inventory')
  const info = statfs(directory, { bigint: true })
  const required = BigInt(inventory.appBytes) + BigInt(inventory.entries.length * 4096) + 64n * 1024n ** 2n
  requireThat(info.bavail * info.bsize >= required, `安装磁盘空间不足：需要至少 ${required} 字节可用空间`)
  return required
}
export async function verifyInstallBundle(bundle, { root, version, expected, expectedSignature, buildRecord }) {
  const directory = await lstat(bundle)
  requireThat(directory.isDirectory() && !directory.isSymbolicLink(), 'Installation source must be a real application directory')
  const inventory = await inspectPackage({ app: realpathSync(bundle), arch: 'arm64', root: buildRecord?.root ?? root, buildRecord })
  if (expected) requireThat(expected.schema === 2 && inventory.version === expected.version && inventory.buildId === expected.buildId && inventory.catalogSha256 === expected.catalogSha256 && JSON.stringify(inventory.entries) === JSON.stringify(expected.entries) && inventory.appBytes === expected.appBytes,
    'Installation application differs from its package manifest')
  const plist = path.join(bundle, 'Contents/Info.plist')
  requireThat((await lstat(plist)).size <= 64 * 1024, 'Application Info.plist exceeds 64 KiB')
  requireThat(command('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]) === appId &&
    command('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]) === version,
  'Installation application identity or version differs from its source')
  const signature = await signatureStatus(bundle)
  requireThat(signature.verified && ['ad-hoc', 'developer-id'].includes(signature.kind), 'Installation requires verified local ad-hoc or Developer ID code')
  if (expectedSignature) requireThat(signature.kind === expectedSignature.kind && signature.teamIdentifier === expectedSignature.teamIdentifier &&
    JSON.stringify(signature.authorities) === JSON.stringify(expectedSignature.authorities), 'Installation signature differs from its delivery manifest')
  return { inventory, signature }
}
export async function verifyDeliveryForInstall(directory, root) {
  const directoryInfo = lstatSync(directory)
  requireThat(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink() && directoryInfo.uid === process.getuid() && !(directoryInfo.mode & 0o022), 'Delivery directory must be an owned real directory without external write access')
  directory = realpathSync(directory)
  const delivery = await installationJson(path.join(directory, 'delivery.json'), 64 * 1024)
  requireThat(delivery.schema === 2 && delivery.scope === 'local-development-only' && delivery.architecture === 'arm64' &&
    delivery.application?.path === 'OC Chan.app' && delivery.application.version === delivery.version &&
    delivery.application.signature?.verified === true && ['ad-hoc', 'developer-id'].includes(delivery.application.signature.kind) &&
    delivery.validation?.package === 'verified' && delivery.validation.dependencies === 'verified', 'Delivery is not a verified local Rust arm64 build')
  const values = []
  for (const [reference, name] of [[delivery.source?.manifest, 'source-manifest.json'], [delivery.packageManifest, 'package-manifest-arm64.json'], [delivery.dependencyReview, 'dependency-review-arm64.json'], [delivery.buildManifest, 'build-manifest.json']]) {
    requireThat(reference?.name === name && Number.isSafeInteger(reference.bytes) && reference.bytes > 0 && reference.bytes <= 8 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(reference.sha256), 'Invalid delivery metadata reference')
    const filename = path.join(directory, name), value = await installationJson(filename), actual = await artifactDigest(filename)
    requireThat(actual.bytes === reference.bytes && actual.sha256 === reference.sha256, `Delivery metadata hash mismatch: ${name}`)
    values.push(value)
  }
  const [source, expected, dependencies, buildRecord] = values
  requireThat(source.version === delivery.version && source.digest === delivery.source.digest && source.commit === delivery.source.commit && expected.schema === 2 && expected.arch === 'arm64' && dependencies.status === 'verified' && buildRecord.schema === 2 && buildRecord.version === delivery.version && buildRecord.buildId === expected.buildId, 'Delivery source, package, build or dependency evidence differs')
  requireThat(Array.isArray(source.files) && source.files.length > 0 && source.files.length <= 1024 && createHash('sha256').update(JSON.stringify(source.files)).digest('hex') === source.digest, 'Source snapshot manifest digest differs')
  const snapshot = path.join(directory, 'source-snapshot'), seen = new Set(); let sourceBytes = 0
  for (const file of source.files) {
    requireThat(typeof file.path === 'string' && !file.path.split('/').some(part => !part || part === '.' || part === '..') && !file.path.includes('\\') && !seen.has(file.path) && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= 16 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(file.sha256), 'Unsafe source snapshot entry')
    seen.add(file.path); sourceBytes += file.bytes; requireThat(sourceBytes <= 64 * 1024 * 1024, 'Source snapshot exceeds budget')
    const filename = path.join(snapshot, file.path); requireThat(within(snapshot, filename), 'Source snapshot path escaped')
    const actual = await digestFile(filename, 'sha256', 16 * 1024 * 1024)
    requireThat(actual.bytes === file.bytes && actual.digest === file.sha256 && (lstatSync(filename).mode & 0o7777) === file.mode, `Source snapshot changed: ${file.path}`)
  }
  await verifyArtifactDigests(directory, delivery.version, delivery.artifacts)
  const bundle = path.join(directory, delivery.application.path)
  const { inventory, signature } = await verifyInstallBundle(bundle, { root, buildRecord, version: delivery.version, expected, expectedSignature: delivery.application.signature })
  return { bundle, version: delivery.version, inventory, signature, source: delivery.source, buildRecord }
}
export async function stageInstallBundle(source, target, validation) {
  checkInstallTarget(target)
  checkInstallSpace(path.dirname(target), validation.inventory)
  const directory = mkdtempSync(path.join(path.dirname(target), '.oc-chan-install-'))
  const staged = path.join(directory, 'OC Chan.app')
  try {
    command('/usr/bin/ditto', [source, staged])
    await verifyInstallBundle(staged, { ...validation, expected: validation.inventory, expectedSignature: validation.signature })
    writeFileSync(path.join(directory, 'installation-source.json'), JSON.stringify({ version: validation.version, source: validation.source, signature: validation.signature, appBytes: validation.inventory.appBytes }), { flag: 'wx', mode: 0o600 })
    return { directory, staged, executable: path.join(realpathSync(path.dirname(target)), 'OC Chan.app/Contents/MacOS/oc-chan') }
  } catch (error) {
    try { rmSync(directory, { recursive: true }) }
    catch (cleanup) { throw new AggregateError([error, cleanup], `Installation staging and cleanup failed; preserved at ${directory}`) }
    throw error
  }
}
