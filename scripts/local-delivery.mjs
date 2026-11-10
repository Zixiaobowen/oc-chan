import { spawn } from 'node:child_process'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { inspectPackage } from './check-package.mjs'
import { captureDeliverySource } from './delivery-source.mjs'
import { verifyDeliveryZip } from './delivery-zip.mjs'
import { boundedJson, within } from './build-app.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const MAX_ARTIFACT = 512 * 1024 ** 2
const MAX_METADATA = 8 * 1024 ** 2
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function requireThat(condition, message) { if (!condition) throw new Error(message) }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs }

export async function command(file, args, { cwd = ROOT, timeout = 30000, signal, allowFailure = false } = {}) {
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
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
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
    await pipeline(createReadStream(sourceFile, { flags: constants.O_RDONLY | constants.O_NOFOLLOW, highWaterMark: 64 * 1024 }),
      new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (bytes > entry.bytes) { callback(new Error(`Source grew during snapshot: ${entry.path}`)); return }
        digest.update(chunk); callback(null, chunk)
      } }), createWriteStream(target, { flags: 'wx', mode: 0o600 }))
    requireThat(bytes === entry.bytes && digest.digest('hex') === entry.sha256, `Source changed during snapshot: ${entry.path}`)
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

async function verifyDmg(filename, expected, root, signal) {
  await command('/usr/bin/hdiutil', ['verify', filename], { signal, timeout: 120000 })
  const temporary = await mkdtemp(path.join(tmpdir(), 'oc-chan-delivery-mount-'))
  const mount = path.join(temporary, 'image')
  let failure, attached = false, result
  try {
    await command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, filename], { signal, timeout: 120000 })
    attached = true
    const inspected = await inspectPackage({ app: await realpath(path.join(mount, 'OC Chan.app')), arch: 'arm64', root })
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
  requireThat(within(path.join(root, 'release/tauri'), requested), 'Local delivery must be inside this workspace release/tauri directory')
  await mkdir(path.dirname(requested), { recursive: true, mode: 0o700 })
  const destination = path.join(await realpath(path.dirname(requested)), path.basename(requested))
  requireThat(within(path.join(root, 'release/tauri'), destination), 'Delivery parent escaped the managed release directory')
  await mkdir(destination, { mode: 0o700 })
  const controller = new AbortController()
  const onInt = () => controller.abort(new Error('Local delivery cancelled: SIGINT'))
  const onTerm = () => controller.abort(new Error('Local delivery cancelled: SIGTERM'))
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm)
  let failure, receipt
  try {
    const source = await captureDeliverySource(root)
    const snapshot = path.join(destination, 'source-snapshot')
    await mkdir(snapshot, { mode: 0o700 }); await snapshotSource(root, snapshot, source)
    console.log(`Building local Rust arm64 delivery ${source.version}; source ${source.digest}`)
    const install = await command('npm', ['ci', '--no-audit', '--no-fund'], { cwd: snapshot, signal: controller.signal, timeout: 600000 })
    await writeFile(path.join(destination, 'dependency-install.log'), install.stdout + install.stderr, { flag: 'wx', mode: 0o600 })
    const build = await command('npm', ['run', 'package:dist'], { cwd: snapshot, signal: controller.signal, timeout: 900000 })
    await writeFile(path.join(destination, 'build.log'), build.stdout + build.stderr, { flag: 'wx', mode: 0o600 })
    await command('npm', ['run', 'audit:dependencies', '--', '--output', path.join(destination, 'dependency-review-arm64.json')], { cwd: snapshot, signal: controller.signal, timeout: 120000 })
    const buildRecord = await boundedJson(path.join(snapshot, 'release/tauri/build.json'))
    requireThat(buildRecord.schema === 2 && buildRecord.root === snapshot && buildRecord.mode === 'release' && buildRecord.version === source.version && /^[a-f0-9-]{36}$/.test(buildRecord.buildId), 'Build receipt differs from the captured source')
    const distribution = await boundedJson(path.join(snapshot, 'release/tauri', buildRecord.buildId, 'distribution.json'))
    requireThat(distribution.schema === 2 && distribution.buildId === buildRecord.buildId && distribution.version === source.version && distribution.arch === 'arm64' && within(path.join(snapshot, 'release/tauri'), distribution.app), 'Distribution receipt differs from the captured build')
    const app = path.join(destination, 'OC Chan.app')
    await cp(distribution.app, app, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false })
    const artifacts = []
    for (const extension of ['zip', 'dmg']) {
      const name = `OC-Chan-${source.version}-mac-arm64.${extension}`, input = distribution.artifacts?.[extension]?.path
      requireThat(input === path.join(distribution.destination, name) && within(path.join(snapshot, 'release/tauri'), input), 'Distribution archive path escaped the build')
      await copyFile(input, path.join(destination, name), constants.COPYFILE_EXCL)
      artifacts.push(await artifactDigest(path.join(destination, name)))
    }
    const inventory = await inspectPackage({ app, arch: 'arm64', artifactsDir: destination, root: snapshot, buildRecord })
    const identity = await appIdentity(app, source.version, controller.signal), signature = await signatureStatus(app, controller.signal)
    requireThat(signature.verified && ['ad-hoc', 'developer-id'].includes(signature.kind), 'Local delivery requires verified ad-hoc or Developer ID code')
    const zipResult = await verifyDeliveryZip(path.join(destination, artifacts.find(entry => entry.name.endsWith('.zip')).name), inventory.entries)
    const dmgResult = await verifyDmg(path.join(destination, artifacts.find(entry => entry.name.endsWith('.dmg')).name), inventory, snapshot, controller.signal)
    await verifyArtifactDigests(destination, source.version, artifacts)
    requireThat(JSON.stringify(await captureDeliverySource(root)) === JSON.stringify(source), 'Workspace source changed during build; no delivery receipt was generated')
    controller.signal.throwIfAborted()
    const sourceFile = await metadata(path.join(destination, 'source-manifest.json'), source)
    const packageFile = await metadata(path.join(destination, 'package-manifest-arm64.json'), inventory)
    const buildFile = await metadata(path.join(destination, 'build-manifest.json'), buildRecord)
    const dependencyFile = await artifactDigest(path.join(destination, 'dependency-review-arm64.json'))
    requireThat((await boundedJson(path.join(destination, dependencyFile.name), MAX_METADATA)).status === 'verified', 'Dependency review did not pass')
    receipt = { schema: 2, createdAt: new Date().toISOString(), scope: 'local-development-only', version: source.version, architecture: 'arm64',
      source: { commit: source.commit, branch: source.branch, tag: source.tag, workspace: source.workspace, digest: source.digest, manifest: sourceFile },
      application: { path: 'OC Chan.app', ...identity, signature, installed: false },
      artifacts, packageManifest: packageFile, buildManifest: buildFile, dependencyReview: dependencyFile,
      validation: { package: 'verified', dependencies: 'verified', zip: zipResult, dmg: dmgResult }, publication: { status: 'not-published', downloadUrl: null } }
    await writeFile(path.join(destination, 'SHA256SUMS.txt'), [...artifacts, sourceFile, packageFile, buildFile, dependencyFile].map(entry => `${entry.sha256}  ${entry.name}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  } catch (error) { failure = error }
  // Source snapshots, archives, logs and delivery evidence remain available for
  // review and recovery. This operation never removes source worktrees.
  process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm)
  if (failure) {
    try { await metadata(path.join(destination, 'failure.json'), { complete: false, error: String(failure), details: failure instanceof AggregateError ? failure.errors.map(String) : [], recordedAt: new Date().toISOString() }) }
    catch (recording) { throw new AggregateError([failure, recording], 'Delivery and failure-evidence publication failed') }
    throw failure
  }
  await metadata(path.join(destination, 'delivery.json'), receipt)
  console.log(`Verified local Rust delivery: ${path.join(destination, 'delivery.json')}`)
  return receipt
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: node scripts/local-delivery.mjs --out NEW_DIRECTORY')
  createLocalDelivery({ out: args[1] }).catch(error => { console.error(error); process.exitCode = 1 })
}
