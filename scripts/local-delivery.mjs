import { spawn } from 'node:child_process'
import { constants, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { inspectPackage } from './check-package.mjs'
import { captureDeliverySource, createDeliveryValidationSource, VALIDATION_SOURCE_DIRECTORY } from './delivery-source.mjs'
import { releaseInfo } from './release-config.mjs'
import { verifyDeliveryZip } from './delivery-zip.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAX_ARTIFACT = 1024 ** 3
const MAX_METADATA = 8 * 1024 ** 2
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function requireThat(condition, message) { if (!condition) throw new Error(message) }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs }

async function command(file, args, { cwd = ROOT, timeout = 30000, signal, allowFailure = false } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', bytes = 0, failure, forceTimer
    const terminate = error => {
      failure ??= error
      if (!child.pid) return
      try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') failure = new AggregateError([failure, error], 'Command cancellation failed') }
      forceTimer ??= setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') failure = new AggregateError([failure, error], 'Command termination failed') }
      }, 5000)
    }
    const cancel = () => terminate(signal.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => terminate(new Error(`Command timed out: ${path.basename(file)}`)), timeout)
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > 2 * 1024 ** 2) { terminate(new Error(`Command output exceeds 2 MiB: ${path.basename(file)}`)); return }
        if (name === 'stdout') stdout += chunk; else stderr += chunk
      })
      stream.on('error', terminate)
    }
    child.once('error', error => { failure ??= error })
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', cancel)
      if (failure) reject(failure)
      else if (exitSignal || code !== 0 && !allowFailure) reject(new Error(`${path.basename(file)} failed (${exitSignal ?? code}): ${stderr || stdout}`))
      else resolve({ stdout, stderr, code })
    })
  })
}

export async function artifactDigest(filename) {
  const before = await lstat(filename)
  requireThat(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= MAX_ARTIFACT, `Artifact must be a bounded regular file: ${filename}`)
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    requireThat(sameFile(before, await handle.stat()), 'Artifact changed before reading')
    const sha = createHash('sha256'); let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      bytes += chunk.length
      requireThat(bytes <= before.size, 'Artifact grew while hashing')
      sha.update(chunk)
    }
    requireThat(bytes === before.size && sameFile(before, await handle.stat()) && sameFile(before, await lstat(filename)), 'Artifact changed while hashing')
    return { name: path.basename(filename), bytes, sha256: sha.digest('hex') }
  } finally { await handle.close() }
}

export async function verifyArtifactDigests(directory, version, expected) {
  requireThat(typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version), 'Invalid delivery version')
  requireThat(Array.isArray(expected) && expected.length === 2, 'Delivery requires exactly the arm64 ZIP and DMG')
  const names = new Set()
  for (const entry of expected) {
    requireThat(entry && ['zip', 'dmg'].some(extension => entry.name === `OC-Chan-${version}-mac-arm64.${extension}`) &&
      !names.has(entry.name) && Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= MAX_ARTIFACT && /^[a-f0-9]{64}$/.test(entry.sha256), 'Invalid or duplicate delivery artifact')
    names.add(entry.name)
    const actual = await artifactDigest(path.join(directory, entry.name))
    requireThat(actual.bytes === entry.bytes && actual.sha256 === entry.sha256, `Artifact size or SHA-256 mismatch: ${entry.name}`)
  }
}

async function snapshotSource(root, directory, source) {
  for (const entry of source.files) {
    const sourceFile = path.join(root, entry.path), target = path.join(directory, entry.path)
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    const digest = createHash('sha256'); let bytes = 0
    const handle = await open(sourceFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      requireThat(info.isFile() && info.nlink === 1 && info.size === entry.bytes, `Source must remain a bounded regular file: ${entry.path}`)
      await pipeline(handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 }),
        new Transform({ transform(chunk, _encoding, callback) {
          bytes += chunk.length
          if (bytes > entry.bytes) { callback(new Error(`Source grew during snapshot: ${entry.path}`)); return }
          digest.update(chunk); callback(null, chunk)
        } }), createWriteStream(target, { flags: 'wx', mode: 0o600 }))
      requireThat(bytes === entry.bytes && digest.digest('hex') === entry.sha256, `Source changed during snapshot: ${entry.path}`)
    } finally { await handle.close() }
    await chmod(target, entry.mode)
  }
}

async function appIdentity(app, version, signal) {
  const plist = path.join(app, 'Contents/Info.plist')
  const field = async key => (await command('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { signal })).stdout.trim()
  const identifier = await field('CFBundleIdentifier')
  const actualVersion = await field('CFBundleShortVersionString')
  requireThat(identifier === 'local.oc-chan.desktop' && actualVersion === version, 'Application identifier or version does not match the build source')
  return { identifier, version: actualVersion, buildVersion: await field('CFBundleVersion'), minimumMacOS: await field('LSMinimumSystemVersion') }
}

export async function signatureStatus(app, signal) {
  const display = await command('/usr/bin/codesign', ['--display', '--verbose=4', app], { signal, allowFailure: true })
  const text = display.stdout + display.stderr
  if (display.code !== 0) {
    requireThat(display.code === 1 && /code object is not signed at all/.test(text), `Cannot determine application signature: ${text}`)
    return { kind: 'unsigned', verified: false, authorities: [], teamIdentifier: null }
  }
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { signal, timeout: 120000 })
  const authorities = [...text.matchAll(/^Authority=(.+)$/gm)].map(match => match[1])
  const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]
  return { kind: /^Signature=adhoc$/m.test(text) ? 'ad-hoc' : authorities.some(value => value.startsWith('Developer ID Application:')) ? 'developer-id' : 'other',
    verified: true, authorities, teamIdentifier: !team || team === 'not set' ? null : team }
}

async function verifyDmg(filename, expected, sources, signal) {
  await command('/usr/bin/hdiutil', ['verify', filename], { signal, timeout: 120000 })
  const temporary = await mkdtemp(path.join(tmpdir(), 'oc-chan-delivery-mount-'))
  const mount = path.join(temporary, 'image')
  let failure, attached = false, result
  try {
    await command('/usr/sbin/diskutil', ['image', 'attach', '--readOnly', '--nobrowse', '--mountPoint', mount, filename], { signal, timeout: 120000 })
    attached = true
    const inspected = await inspectPackage({ app: path.join(mount, 'OC Chan.app'), arch: 'arm64', sources })
    requireThat(JSON.stringify(inspected.entries) === JSON.stringify(expected.entries), 'DMG application differs from the directory package')
    result = { checksum: 'verified', application: 'matches-directory-package', readOnly: true }
  } catch (error) { failure = error }
  try {
    let mounted = attached
    try { mounted ||= (await lstat(mount)).dev !== (await lstat(temporary)).dev } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (mounted) await command('/usr/sbin/diskutil', ['eject', mount], { timeout: 30000 })
    try { requireThat((await lstat(mount)).dev === (await lstat(temporary)).dev, `Image remains mounted at ${mount}`) } catch (error) { if (error.code !== 'ENOENT') throw error }
    await rm(temporary, { recursive: true })
  } catch (error) {
    throw new AggregateError(failure ? [failure, error] : [error], `DMG cleanup failed; preserved mount location: ${mount}`)
  }
  if (failure) throw failure
  return result
}

async function metadata(filename, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n'
  requireThat(Buffer.byteLength(bytes) <= MAX_METADATA, 'Delivery metadata exceeds 8 MiB')
  await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 })
  return { name: path.basename(filename), bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }
}

export async function createLocalDelivery({ root = ROOT, out }) {
  requireThat(process.platform === 'darwin' && process.arch === 'arm64', 'Local delivery requires an arm64 Mac')
  requireThat(typeof out === 'string' && out.length > 0, 'Required --out NEW_DIRECTORY')
  root = await realpath(root)
  const requested = path.resolve(out)
  const destination = path.join(await realpath(path.dirname(requested)), path.basename(requested))
  await mkdir(destination, { mode: 0o700 })
  const controller = new AbortController()
  const interrupt = signal => controller.abort(new Error(`Local delivery cancelled: ${signal}`))
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM')
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm)
  let snapshot, failure, receipt
  try {
    const source = await captureDeliverySource(root)
    releaseInfo(source.version)
    snapshot = await mkdtemp(path.join(tmpdir(), 'oc-chan-delivery-source-'))
    await snapshotSource(root, snapshot, source)
    const sources = await createDeliveryValidationSource(snapshot, path.join(destination, VALIDATION_SOURCE_DIRECTORY), source)
    console.log(`Building local arm64 delivery ${source.version}; workspace source ${source.digest}`)
    const install = await command('npm', ['ci', '--no-audit', '--no-fund'], { cwd: snapshot, signal: controller.signal, timeout: 600000 })
    await writeFile(path.join(destination, 'dependency-install.log'), install.stdout + install.stderr, { flag: 'wx', mode: 0o600 })
    const build = await command('npm', ['run', 'dist', '--', '--out', destination], { cwd: snapshot, signal: controller.signal, timeout: 900000 })
    await writeFile(path.join(destination, 'build.log'), build.stdout + build.stderr, { flag: 'wx', mode: 0o600 })
    await command('npm', ['run', 'audit:dependencies', '--', '--output', path.join(destination, 'dependency-review-arm64.json')], {
      cwd: snapshot, signal: controller.signal, timeout: 120000
    })
    const app = path.join(destination, 'mac-arm64', 'OC Chan.app')
    const inventory = await inspectPackage({ app, arch: 'arm64', artifactsDir: destination, sources })
    const identity = await appIdentity(app, source.version, controller.signal)
    const signature = await signatureStatus(app, controller.signal)
    console.log('Checking ZIP members and read-only DMG contents')
    const zip = inventory.artifacts.find(entry => entry.name.endsWith('.zip'))
    const dmg = inventory.artifacts.find(entry => entry.name.endsWith('.dmg'))
    const zipResult = await verifyDeliveryZip(path.join(destination, zip.name), inventory.entries.filter(entry => entry.kind !== 'asar'))
    const dmgResult = await verifyDmg(path.join(destination, dmg.name), inventory, sources, controller.signal)
    await verifyArtifactDigests(destination, source.version, inventory.artifacts)
    const after = await captureDeliverySource(root)
    requireThat(JSON.stringify(after) === JSON.stringify(source), 'Workspace source changed during build; no delivery receipt was generated')
    controller.signal.throwIfAborted()
    const sourceFile = await metadata(path.join(destination, 'source-manifest.json'), source)
    const packageFile = await metadata(path.join(destination, 'package-manifest-arm64.json'), inventory)
    const dependencyFile = await artifactDigest(path.join(destination, 'dependency-review-arm64.json'))
    receipt = { schema: 2, createdAt: new Date().toISOString(), scope: 'local-development-only', version: source.version, architecture: 'arm64',
      source: { commit: source.commit, branch: source.branch, tag: source.tag, workspace: source.workspace, digest: source.digest, manifest: sourceFile, validationPath: VALIDATION_SOURCE_DIRECTORY, ciRun: null },
      application: { path: 'mac-arm64/OC Chan.app', ...identity, signature, notarization: 'not-requested', gatekeeper: 'not-assessed', installed: false },
      artifacts: inventory.artifacts, packageManifest: packageFile, dependencyReview: dependencyFile,
      validation: { packageBudget: inventory.budget.status, dependencies: 'verified', zip: zipResult, dmg: dmgResult },
      publication: { status: 'not-published', downloadUrl: null }, upgradeInstructions: 'README.md: 本地交付与手动升级' }
    await writeFile(path.join(destination, 'SHA256SUMS.txt'), [...inventory.artifacts, sourceFile, packageFile, dependencyFile].map(entry => `${entry.sha256}  ${entry.name}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  } catch (error) { failure = error }
  try { if (snapshot) await rm(snapshot, { recursive: true }) } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Delivery and source snapshot cleanup failed') : error
  }
  process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm)
  if (failure) {
    await metadata(path.join(destination, 'failure.json'), { complete: false, error: String(failure), details: failure instanceof AggregateError ? failure.errors.map(String) : [], recordedAt: new Date().toISOString() })
    throw failure
  }
  await metadata(path.join(destination, 'delivery.json'), receipt)
  console.log(`Verified local delivery: ${path.join(destination, 'delivery.json')}`)
  return receipt
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: node scripts/local-delivery.mjs --out NEW_DIRECTORY')
  createLocalDelivery({ out: args[1] }).catch(error => { console.error(error); process.exitCode = 1 })
}
