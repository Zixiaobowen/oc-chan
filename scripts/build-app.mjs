import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { buildPluginMarketRust } from './build-plugin-market-rust.mjs'
import { generateRustLicenses } from './rust-dependencies.mjs'

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
export const TARGET = ['aarch64', 'apple', 'darwin'].join('-')
export const BUNDLE_ID = 'local.oc-chan.desktop'
export const BUILD_RECORD = path.join(ROOT, 'release/tauri/build.json')
const TAURI = path.join(ROOT, 'node_modules/@tauri-apps/cli/tauri.js')
const RESOURCE_FILES = ['oc-data-worker', 'oc-installer', 'tern-navigation/present-window', 'tern-navigation/plugin/plugin.toml', 'tern-navigation/plugin/window.luau']
export const NATIVE_RESOURCES = ['oc-data-worker', 'oc-installer', 'tern-navigation/present-window']
export async function codeDirectoryHash(filename) {
  const { stderr } = await promisify(execFile)('/usr/bin/codesign', ['-d', '--verbose=4', filename], { timeout: 10_000, maxBuffer: 128 * 1024 })
  const hashes = [...stderr.matchAll(/^CDHash=([a-f0-9]{40,64})\r?$/gm)]
  assert(hashes.length === 1, 'Expected one thin-binary CodeDirectory hash')
  return hashes[0][1]
}
export function assert(condition, message) { if (!condition) throw new Error(message) }
export function within(parent, child) { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) }
export async function boundedJson(filename, maximum = 256 * 1024) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat(); assert(info.isFile() && info.size <= maximum, `Invalid or oversized JSON: ${filename}`)
    const bytes = Buffer.alloc(info.size + 1); let size = 0
    while (size < bytes.length) { const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null); if (!bytesRead) break; size += bytesRead }
    assert(size === info.size, `JSON changed while reading: ${filename}`)
    return JSON.parse(bytes.subarray(0, size).toString('utf8'))
  } finally { await handle.close() }
}
export async function digestFile(filename, algorithm = 'sha256', maximum = 512 * 1024 * 1024) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat(); assert(before.isFile() && before.size <= maximum, `Invalid or oversized file: ${filename}`)
    const hash = createHash(algorithm); let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) { bytes += chunk.length; assert(bytes <= maximum, `File exceeds limit: ${filename}`); hash.update(chunk) }
    const after = await handle.stat(); assert(bytes === before.size && before.ino === after.ino && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `File changed while hashing: ${filename}`)
    return { bytes, digest: hash.digest(algorithm === 'sha512' ? 'base64' : 'hex') }
  } finally { await handle.close() }
}
export function run(file, args, { cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: 'inherit' }); let failure
    child.once('error', error => { failure = error })
    child.once('close', (code, signal) => failure ? reject(failure) : code === 0 && !signal ? resolve() : reject(new Error(`${path.basename(file)} exited ${signal ?? code}`)))
  })
}
export function signingIdentity(env = process.env) {
  const value = env.APPLE_SIGNING_IDENTITY?.trim() || '-'
  assert(value === '-' || /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(value), 'APPLE_SIGNING_IDENTITY must name an explicit Developer ID Application identity or "-"')
  return value
}
export function buildEnvironment({ resourcesDir, targetDir, instance, sign = '-', configuration }, original = process.env) {
  const env = { ...original, CARGO_TARGET_DIR: targetDir, OC_CHAN_RESOURCE_DIR: resourcesDir, TAURI_CONFIG: JSON.stringify(configuration), APPLE_SIGNING_IDENTITY: sign }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'TAURI_DEV', 'TAURI_DEBUG', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']) delete env[key]
  assert(!/acceptance/.test(`${env.RUSTFLAGS ?? ''} ${env.CARGO_ENCODED_RUSTFLAGS ?? ''}`), 'Do not inject acceptance cfg through compiler flags')
  if (instance) env.OC_CHAN_DEV_INSTANCE = instance
  else { for (const key of Object.keys(env)) if (key.startsWith('OC_CHAN_') && key !== 'OC_CHAN_RESOURCE_DIR') delete env[key] }
  // Local builds never auto-discover signing/notarization credentials.
  if (sign === '-' || instance) for (const key of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH', 'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD']) delete env[key]
  return env
}
export function developmentBundleLayout(instance, targetDir = path.join(instance, 'cargo')) {
  const application = path.join(targetDir, TARGET, 'debug/bundle/macos/OC Chan.app')
  return { application, binary: path.join(application, 'Contents/MacOS/oc-chan'),
    resourcesDir: path.join(application, 'Contents/Resources'),
    identifier: `${BUNDLE_ID}.development.i${createHash('sha256').update(path.resolve(instance)).digest('hex').slice(0, 24)}` }
}
export function tauriConfiguration(frontendDir, resourcesDir, sign, development) {
  return { ...(development ? { identifier: development.identifier } : {}),
    build: { frontendDist: frontendDir, beforeBuildCommand: '', beforeBundleCommand: '', features: [] },
    bundle: { active: true, createUpdaterArtifacts: false, resources: { [`${resourcesDir}${path.sep}`]: '' },
      macOS: { signingIdentity: sign, ...(development ? { infoPlist: development.infoPlist } : {}) } } }
}
export async function withBuildLock(resourcesDir, work) {
  const filename = path.join(path.dirname(resourcesDir), '.build-app.lock'); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let identity, result; const failures = []
  try { identity = await handle.stat(); await handle.writeFile(JSON.stringify({ pid: process.pid, root: ROOT })); await handle.sync(); result = await work() }
  catch (error) { failures.push(error) }
  try { await handle.close() } catch (error) { failures.push(error) }
  try {
    const current = await lstat(filename)
    assert(identity && current.dev === identity.dev && current.ino === identity.ino, 'Build lock was replaced; preserving it')
    await rm(filename)
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Build and owned-lock cleanup failed')
  return result
}
async function publishResources(staged, destination, buildId) {
  const ownerPath = `${destination}.owner.json`; let previous
  try { previous = await lstat(destination) } catch (error) { if (error.code !== 'ENOENT') throw error }
  let backup
  if (previous) {
    const owner = await boundedJson(ownerPath, 4096)
    assert(previous.isDirectory() && !previous.isSymbolicLink() && owner.root === ROOT && owner.path === destination && owner.dev === previous.dev && owner.ino === previous.ino, 'Existing resource directory is not owned by this build pipeline')
    backup = `${destination}.previous-${buildId}`; await rename(destination, backup)
  }
  try { await rename(staged, destination) }
  catch (error) {
    if (backup) { try { await rename(backup, destination) } catch (cleanup) { throw new AggregateError([error, cleanup], 'Resource publication and rollback failed') } }
    throw error
  }
  const identity = await lstat(destination)
  const temporary = `${ownerPath}.${buildId}.tmp`
  await writeFile(temporary, `${JSON.stringify({ schema: 1, root: ROOT, path: destination, buildId, dev: identity.dev, ino: identity.ino })}\n`, { flag: 'wx', mode: 0o600 })
  await rename(temporary, ownerPath)
  if (backup) await rm(backup, { recursive: true })
}
export async function buildApplication(options = {}) {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Rust desktop builds require a native macOS arm64 host')
  const mode = options.mode ?? 'release'; assert(['release', 'development'].includes(mode), 'Unknown application build mode')
  const instance = options.instance && path.resolve(options.instance)
  if (mode === 'development') assert(instance && path.dirname(instance) === path.join(ROOT, '.dev-instances') && /^instance-[\w-]+$/.test(path.basename(instance)), 'Development builds require an owned instance directory')
  else assert(!instance, 'Release builds cannot include a development instance')
  const targetDir = path.resolve(options.targetDir ?? (instance ? path.join(instance, 'cargo') : path.join(ROOT, 'release/tauri/cargo')))
  const resourcesDir = path.resolve(options.resourcesDir ?? (instance ? path.join(instance, 'resources') : path.join(ROOT, 'out/host-resources')))
  const frontendDir = path.resolve(options.frontendDir ?? (instance ? path.join(instance, 'frontend') : path.join(ROOT, 'out/renderer')))
  for (const directory of [targetDir, resourcesDir, frontendDir]) assert(instance ? within(instance, directory) : within(path.join(ROOT, 'out'), directory) || within(path.join(ROOT, 'release/tauri'), directory), 'Build output must stay inside its owned output tree')
  const sign = mode === 'development' ? '-' : options.sign ?? signingIdentity(); assert(sign === '-' || /^Developer ID Application: /.test(sign), 'Invalid explicit signing identity')
  const execute = options.run ?? run
  return withBuildLock(resourcesDir, async () => {
    let primaryFailure
    const buildId = randomUUID(), development = instance ? developmentBundleLayout(instance, targetDir) : undefined
    const infoPlist = instance && path.join(instance, `build-${buildId}.Info.plist`)
    if (development) await writeFile(infoPlist, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>LSUIElement</key><true/></dict></plist>\n', { flag: 'wx', mode: 0o600 })
    const configuration = tauriConfiguration(frontendDir, resourcesDir, sign, development && { identifier: development.identifier, infoPlist })
    const env = buildEnvironment({ resourcesDir, targetDir, instance, sign, configuration })
    const packageInfo = await boundedJson(path.join(ROOT, 'package.json')); assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageInfo.version), 'Invalid package release version')
    await mkdir(path.dirname(resourcesDir), { recursive: true, mode: 0o700 }); const staged = await mkdtemp(path.join(path.dirname(resourcesDir), '.host-resources-'))
    let published = false
    try {
      await execute('cargo', ['build', '--release', '--locked', '--target', TARGET, '--target-dir', targetDir,
        ...(mode === 'development' ? ['--features', 'oc-core/acceptance'] : []),
        '-p', 'oc-core', '--bin', 'oc-data-worker', '-p', 'oc-installer', '--bin', 'oc-installer', '-p', 'oc-system-monitor', '--bin', 'collector'], { cwd: ROOT, env })
      const nativeRoot = path.join(targetDir, TARGET, 'release')
      for (const binary of ['oc-data-worker', 'oc-installer']) await copyFile(path.join(nativeRoot, binary), path.join(staged, binary), constants.COPYFILE_EXCL)
      await mkdir(path.join(staged, 'tern-navigation/plugin'), { recursive: true })
      await execute('/usr/bin/xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macos13.0', path.join(ROOT, 'native/tern-present.swift'), '-o', path.join(staged, 'tern-navigation/present-window')], { cwd: ROOT, env })
      for (const filename of ['plugin.toml', 'window.luau']) await copyFile(path.join(ROOT, 'resources/tern-navigation/plugin', filename), path.join(staged, 'tern-navigation/plugin', filename), constants.COPYFILE_EXCL)
      for (const binary of ['oc-data-worker', 'oc-installer', 'tern-navigation/present-window']) {
        await execute('/usr/bin/codesign', ['--force', '--sign', sign, '--options', 'runtime', ...(sign === '-' ? [] : ['--timestamp']), path.join(staged, binary)], { cwd: ROOT, env })
      }
      await buildPluginMarketRust({ collector: path.join(nativeRoot, 'collector'), manifest: path.join(ROOT, 'plugins/system-monitor/manifest.json'), outDir: path.join(staged, 'plugin-market'), sign })
      generateRustLicenses({ root: ROOT, output: path.join(staged, 'rust-dependencies') })
      await publishResources(staged, resourcesDir, buildId); published = true
      await execute(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', frontendDir, '--emptyOutDir'], { cwd: ROOT, env })
      const configurationFile = path.join(instance ?? path.join(ROOT, 'release/tauri'), `build-${buildId}.config.json`)
      await mkdir(path.dirname(configurationFile), { recursive: true, mode: 0o700 }); await writeFile(configurationFile, `${JSON.stringify(configuration, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      const features = mode === 'development' ? ['acceptance', 'custom-protocol'] : ['custom-protocol']
      await execute(process.execPath, [TAURI, 'build', '--no-bundle', '--ci', ...(mode === 'development' ? ['--debug'] : []), '--target', TARGET,
        '--features', features.join(','), '--config', configurationFile, '--', '--no-default-features'], { cwd: ROOT, env })
      if (development) {
        // Use the same Tauri bundler as distribution. It creates and signs a real
        // application in the owned target tree; do not copy or relocate it again.
        await execute(process.execPath, [TAURI, 'bundle', '--debug', '--ci', '--no-binary-patching', '--target', TARGET,
          '--features', features.join(','), '--config', configurationFile, '--bundles', 'app'], { cwd: ROOT, env })
      }
      const binary = development?.binary ?? path.join(targetDir, TARGET, 'release', 'oc-chan')
      const catalog = await boundedJson(path.join(resourcesDir, 'plugin-market/catalog.json'))
      const files = [...RESOURCE_FILES, 'plugin-market/catalog.json', 'rust-dependencies/manifest.json', ...catalog.plugins.map(entry => `plugin-market/${entry.package}`)]
      assert(files.length <= 22 && catalog.schema === 1, 'Invalid generated plugin catalog')
      const resources = {}
      for (const filename of files) {
        assert(!filename.includes('..') && !path.isAbsolute(filename), 'Unsafe resource path')
        resources[filename] = await digestFile(path.join(resourcesDir, filename))
        if (NATIVE_RESOURCES.includes(filename)) resources[filename].codeDirectoryHash = await codeDirectoryHash(path.join(resourcesDir, filename))
      }
      const record = { schema: 2, buildId, root: ROOT, mode, version: packageInfo.version, arch: 'arm64', target: TARGET, features, sign,
        resourcesDir, frontendDir, targetDir, configurationFile, binary, binaryIdentity: await digestFile(binary), resources,
        catalogSha256: resources['plugin-market/catalog.json'].digest,
        ...(development ? { developmentBundle: { ...development, infoPlistIdentity: await digestFile(path.join(development.application, 'Contents/Info.plist'), 'sha256', 64 * 1024) } } : {}) }
      const recordPath = instance ? path.join(instance, 'build.json') : BUILD_RECORD
      await mkdir(path.dirname(recordPath), { recursive: true }); const temporary = `${recordPath}.${buildId}.tmp`
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, recordPath)
      return record
    } catch (error) { primaryFailure = error; throw error }
    finally {
      if (!published) {
        try { await rm(staged, { recursive: true, force: true }) }
        catch (error) { throw primaryFailure ? new AggregateError([primaryFailure, error], 'Build and staging cleanup failed') : error }
      }
    }
  })
}
export async function loadBuild() {
  const record = await boundedJson(BUILD_RECORD)
  assert(record.schema === 2 && record.root === ROOT && record.mode === 'release' && record.arch === 'arm64' && record.target === TARGET
    && JSON.stringify(record.features) === JSON.stringify(['custom-protocol']), 'A current production Rust build is required')
  const binary = await digestFile(record.binary); assert(binary.digest === record.binaryIdentity.digest, 'Built binary changed; rebuild before bundling')
  for (const [filename, expected] of Object.entries(record.resources)) {
    assert(!filename.includes('..') && !path.isAbsolute(filename), 'Invalid resource receipt path')
    const actual = await digestFile(path.join(record.resourcesDir, filename)); assert(actual.digest === expected.digest && actual.bytes === expected.bytes, `Built resource changed: ${filename}`)
  }
  return record
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  assert(args.length === 0 || (args.length === 2 && args[0] === '--development-instance' && path.isAbsolute(args[1])), 'Usage: node scripts/build-app.mjs [--development-instance ABS_INSTANCE]')
  const options = args.length ? { mode: 'development', instance: args[1] } : {}
  buildApplication(options).then(record => console.log(`[oc-chan] Rust ${record.mode} binary: ${record.binary}`)).catch(error => { console.error(error); process.exitCode = 1 })
}
