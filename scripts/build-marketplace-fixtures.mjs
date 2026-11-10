// Acceptance-only native packages. This tool does not modify plugin-market/,
// the normal Cargo target directory, the installed application or any profile.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPluginMarketRust } from './build-plugin-market-rust.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function cargoBuild(args, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []; const stderr = []; let bytes = 0; let failure = null
    const stop = error => {
      failure ??= error
      if (!child.pid) return
      try { process.kill(-child.pid, 'SIGKILL') } catch (cleanup) { if (cleanup.code !== 'ESRCH') failure = new AggregateError([failure, cleanup], 'fixture build cleanup failed') }
    }
    const timer = setTimeout(() => stop(new Error('fixture Cargo build exceeded 15-minute deadline')), 900_000)
    const abort = () => stop(signal.reason instanceof Error ? signal.reason : new Error('fixture build cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => { if (bytes + chunk.length > 4 * 1024 * 1024) { stop(new Error('fixture Cargo output exceeded 4MiB')); return }; bytes += chunk.length; chunks.push(chunk) })
      stream.on('error', stop)
    }
    child.on('error', stop)
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`fixture Cargo exited ${code ?? exitSignal}: ${result.stderr.slice(-4096)}`))
      else resolve(result)
    })
  })
}
async function boundedRead(file, maximum) {
  if ((await stat(file)).size > maximum) throw new Error(`fixture input exceeds ${maximum} bytes: ${file}`)
  const bytes = await readFile(file)
  if (bytes.length > maximum) throw new Error(`fixture input grew beyond ${maximum} bytes: ${file}`)
  return bytes
}
export async function buildMarketplaceFixtures({ out, signal }) {
  signal?.throwIfAborted()
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('native marketplace fixtures require macOS arm64')
  if (typeof out !== 'string' || !path.isAbsolute(out) || out.length > 4096) throw new Error('--out must be a new absolute task directory')
  const directory = path.join(await realpath(path.dirname(out)), path.basename(out))
  await mkdir(directory, { mode: 0o700 }) // EEXIST is intentional: never overwrite another task.
  const target = path.join(directory, 'cargo')
  const source = JSON.parse(await boundedRead(path.join(root, 'plugins/system-monitor/manifest.json'), 16 * 1024))
  const cargoArgs = ['build', '--locked', '--release', '-p', 'oc-system-monitor', '--bin', 'collector', '--no-default-features', '--target-dir', target]
  async function build(failing) {
    const args = [...cargoArgs, ...(failing ? ['--features', 'acceptance-fail-collect'] : [])]
    const output = await cargoBuild(args, signal)
    await writeFile(path.join(directory, failing ? 'cargo-v3.log' : 'cargo-v1-v2.log'), output.stdout + output.stderr, { mode: 0o600, flag: 'wx' })
    return path.join(target, 'release/collector')
  }
  const variants = {}
  let collector = await build(false)
  for (const [key, version, failing] of [['v1', '1.0.0', false], ['v2', '1.1.0', false], ['v3', '1.2.0', true]]) {
    signal?.throwIfAborted()
    if (failing) collector = await build(true)
    const variant = path.join(directory, key); await mkdir(variant, { mode: 0o700 })
    const manifest = path.join(variant, 'input-manifest.json')
    await writeFile(manifest, `${JSON.stringify({ ...source, version }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    signal?.throwIfAborted()
    const result = await buildPluginMarketRust({ collector, manifest, outDir: variant, sign: '-' })
    signal?.throwIfAborted()
    const catalog = await boundedRead(path.join(variant, 'catalog.json'), 256 * 1024)
    variants[key] = { directory: variant, catalog_sha256: hash(catalog), package: path.basename(result.packagePath), sha256: result.sha256, bytes: result.bytes,
      version, api_version: 2, fail_collect: failing,
      build: { cargo_features: failing ? ['acceptance-fail-collect'] : [], executable_sha256: hash(await boundedRead(collector, 8 * 1024 * 1024)),
        behavior: failing ? 'Real SDK collector returns Collect error on first collection; used to exercise activation rollback' : 'Real system collector and host IO; v1/v2 differ only in their signed package version' } }
  }
  const record = { schema: 1, purpose: 'oc-chan isolated native marketplace acceptance only', directory, variants,
    instructions: 'Serve each variant catalog.json and its exact .ocplugin over 127.0.0.1 HTTP. Pin catalog_sha256 and trusted_assets explicitly. Build oc-data-worker with acceptance. Never distribute these ad-hoc fixture packages.' }
  await writeFile(path.join(directory, 'fixtures.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  signal?.throwIfAborted()
  return record
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--out') { console.error('usage: node scripts/build-marketplace-fixtures.mjs --out <new absolute task directory>'); process.exitCode = 2 }
  else {
    const controller = new AbortController(); const cancel = () => controller.abort(new Error('fixture builder interrupted'))
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
    buildMarketplaceFixtures({ out: args[1], signal: controller.signal }).then(record => console.log(JSON.stringify(record, null, 2)))
      .catch(error => { console.error(error.message); process.exitCode = 1 })
      .finally(() => { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) })
  }
}
