import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const execute = promisify(execFile)
const MAX_ARCHIVE = 32 * 1024 * 1024
const assert = (value, message) => { if (!value) throw new Error(message) }
export function readSparkleConfig(root = ROOT) {
  const config = JSON.parse(readFileSync(path.join(root, 'resources/sparkle.json'), 'utf8'))
  assert(config.schema === 1 && /^2\.\d+\.\d+$/.test(config.version), 'Invalid pinned Sparkle version')
  assert(config.url === `https://github.com/sparkle-project/Sparkle/releases/download/${config.version}/Sparkle-${config.version}.tar.xz` && /^[a-f0-9]{64}$/.test(config.sha256), 'Invalid Sparkle archive pin')
  assert(/^[A-Za-z0-9+/]{43}=$/.test(config.publicKey) && Buffer.from(config.publicKey, 'base64').length === 32, 'Invalid Sparkle public key')
  assert(config.feedURL === 'https://github.com/Zixiaobowen/oc-chan/releases/latest/download/appcast.xml', 'Unexpected production Sparkle feed')
  return config
}
export function readSparkleManifest(root = ROOT) {
  const config = readSparkleConfig(root)
  const manifest = JSON.parse(readFileSync(path.join(root, 'resources/sparkle-sdk-manifest.json'), 'utf8'))
  assert(manifest.schema === 1 && manifest.version === config.version && manifest.archiveSha256 === config.sha256 && Array.isArray(manifest.entries) && manifest.entries.length > 0 && manifest.entries.length <= 1024, 'Invalid Sparkle content manifest')
  const paths = new Set()
  for (const entry of manifest.entries) {
    assert(typeof entry.path === 'string' && !paths.has(entry.path) && entry.path.length <= 1024 && !path.isAbsolute(entry.path) && entry.path.split('/').every(part => part && part !== '.' && part !== '..') && !/[\\\0\r\n]/.test(entry.path), 'Invalid Sparkle content path')
    paths.add(entry.path)
    assert(typeof entry.target === 'string' ? !path.isAbsolute(entry.target) && entry.target.length <= 1024 : Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= MAX_ARCHIVE && /^[a-f0-9]{64}$/.test(entry.sha256), 'Invalid Sparkle content identity')
  }
  return manifest
}
async function digest(filename, maximum = MAX_ARCHIVE) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    assert(before.isFile() && before.size > 0 && before.size <= maximum, `Invalid Sparkle file: ${filename}`)
    const hash = createHash('sha256'); let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) { bytes += chunk.length; assert(bytes <= maximum, 'Sparkle file exceeds budget'); hash.update(chunk) }
    const after = await handle.stat()
    assert(bytes === before.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'Sparkle file changed while hashing')
    return { bytes, sha256: hash.digest('hex') }
  } finally { await handle.close() }
}
export function runtimeSparkleEntries(root = ROOT) {
  return readSparkleManifest(root).entries.filter(entry => entry.path.startsWith('Sparkle.framework/'))
}
export async function verifySparkleEntries(directory, entries) {
  const base = await realpath(directory)
  for (const entry of entries) {
    const filename = path.join(base, entry.path), info = await lstat(filename)
    if (entry.target !== undefined) {
      assert(info.isSymbolicLink() && await readlink(filename) === entry.target, `Sparkle symlink differs from pin: ${entry.path}`)
      const resolved = await realpath(filename)
      assert(resolved.startsWith(`${base}${path.sep}`), `Sparkle symlink escapes bundle: ${entry.path}`)
    } else {
      const actual = await digest(filename)
      assert(actual.bytes === entry.bytes && actual.sha256 === entry.sha256 && Boolean(info.mode & 0o111) === entry.executable, `Sparkle content differs from pin: ${entry.path}`)
    }
  }
}
export async function ensureSparkleSDK({ root = ROOT } = {}) {
  const config = readSparkleConfig(root), manifest = readSparkleManifest(root)
  const cache = path.join(root, 'out/sparkle-sdk'), directory = path.join(cache, config.version)
  const result = { directory, framework: path.join(directory, 'Sparkle.framework'), bin: path.join(directory, 'bin') }
  let existing
  try { existing = await lstat(directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existing) {
    assert(existing.isDirectory() && !existing.isSymbolicLink(), 'Sparkle SDK must be a real directory')
    await verifySparkleEntries(directory, manifest.entries)
    return result
  }
  await mkdir(cache, { recursive: true })
  const temporary = await mkdtemp(path.join(cache, '.download-'))
  try {
    const archive = path.join(temporary, 'Sparkle.tar.xz')
    const response = await fetch(config.url, { signal: AbortSignal.timeout(180_000) })
    assert(response.ok, `Sparkle download failed: HTTP ${response.status}`)
    const file = await open(archive, 'wx', 0o600); let bytes = 0
    try {
      for await (const chunk of response.body) { bytes += chunk.length; assert(bytes <= MAX_ARCHIVE, 'Sparkle download exceeds 32 MiB'); await file.writeFile(chunk) }
    } finally { await file.close() }
    assert((await digest(archive)).sha256 === config.sha256, 'Sparkle download SHA256 mismatch')
    const staged = path.join(temporary, 'sdk'); await mkdir(staged)
    // The exact trusted archive is verified before tar sees it; only selected SDK entries are extracted.
    await execute('/usr/bin/tar', ['-xf', archive, '-C', staged, './Sparkle.framework', './bin/generate_keys', './bin/generate_appcast', './bin/sign_update', './LICENSE'], { timeout: 60_000, maxBuffer: 64 * 1024 })
    await verifySparkleEntries(staged, manifest.entries)
    try { await rename(staged, directory) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
      await verifySparkleEntries(directory, manifest.entries)
    }
    return result
  } finally { await rm(temporary, { recursive: true }) }
}
export async function embedSparkle(application, { root = ROOT } = {}) {
  const sdk = await ensureSparkleSDK({ root }), frameworks = path.join(application, 'Contents/Frameworks')
  await mkdir(frameworks, { recursive: true })
  // Sparkle's upstream signature seals framework headers and modules too.
  // Preserve the exact framework rather than invalidating its identity by pruning.
  await cp(sdk.framework, path.join(frameworks, 'Sparkle.framework'), { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true })
  await verifySparkleEntries(frameworks, runtimeSparkleEntries(root))
  await mkdir(path.join(application, 'Contents/Resources'), { recursive: true })
  await writeFile(path.join(application, 'Contents/Resources/Sparkle-LICENSE.txt'), await readFile(path.join(sdk.directory, 'LICENSE')), { flag: 'wx' })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await ensureSparkleSDK()))
