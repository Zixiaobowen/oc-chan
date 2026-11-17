import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, TARGET, assert, loadBuild, withBuildLock, buildEnvironment, bundleApplication, run } from './build-app.mjs'
import { inspectPackage } from './check-package.mjs'

export function parseDistributionOptions(args) {
  assert(new Set(args).size === args.length && args.every(arg => ['--arm64', '--dir'].includes(arg)), 'Usage: node scripts/dist.mjs [--arm64] [--dir]')
  return { directoryOnly: args.includes('--dir') }
}
export function stableMetadata(version, archive) {
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), 'latest.json is only generated for strict stable semantic versions')
  assert(Number.isSafeInteger(archive.bytes) && archive.bytes > 0 && archive.bytes <= 512 * 1024 * 1024 && /^[A-Za-z0-9+/]{86}==$/.test(archive.digest), 'Invalid update archive size or SHA-512')
  const digest = Buffer.from(archive.digest, 'base64'); assert(digest.length === 64 && digest.toString('base64') === archive.digest, 'Noncanonical update SHA-512')
  return { schema: 2, version, assets: [{ target: ['darwin', 'aarch64'].join('-'), name: `OC-Chan-${version}-mac-arm64.zip`, size: archive.bytes, sha512: archive.digest }] }
}
export async function distribute({ directoryOnly = false, execute = run } = {}) {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Distribution requires a native macOS arm64 host')
  const initial = await loadBuild()
  return withBuildLock(initial.resourcesDir, async () => {
    const record = await loadBuild(); assert(record.buildId === initial.buildId, 'Build changed before distribution acquired ownership')
    if (record.sign !== '-') for (const key of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) assert(process.env[key]?.trim(), `Explicit Developer ID distribution requires ${key} for notarization`)
    const env = buildEnvironment({ resourcesDir: record.resourcesDir, targetDir: record.targetDir, sign: record.sign })
    const destination = path.join(ROOT, 'release/gpui', record.buildId)
    await mkdir(destination, { mode: 0o700 })
    const app = path.join(destination, 'OC Chan.app')
    await bundleApplication({ application: app, binary: record.binary, resourcesDir: record.resourcesDir, version: record.version, sign: record.sign, execute, env })
    if (record.sign !== '-') {
      const submission = path.join(destination, 'notarization.zip')
      await execute('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, submission], { cwd: ROOT, env })
      await execute('/usr/bin/xcrun', ['notarytool', 'submit', submission, '--apple-id', env.APPLE_ID, '--password', env.APPLE_PASSWORD, '--team-id', env.APPLE_TEAM_ID, '--wait'], { cwd: ROOT, env })
      await execute('/usr/bin/xcrun', ['stapler', 'staple', app], { cwd: ROOT, env })
      await execute('/usr/bin/xcrun', ['stapler', 'validate', app], { cwd: ROOT, env })
    }
    if (!directoryOnly) {
      const prefix = `OC-Chan-${record.version}-mac-arm64`, zip = path.join(destination, `${prefix}.zip`), dmg = path.join(destination, `${prefix}.dmg`)
      await execute('/usr/bin/hdiutil', ['create', '-volname', 'OC Chan', '-srcfolder', app, '-format', 'UDZO', dmg], { cwd: ROOT, env })
      // -y stores relative bundle symlinks; -X excludes platform extra metadata.
      // ZIP's app root and names are exactly those accepted by schema2 updates.
      await execute('/usr/bin/zip', ['-q', '-r', '-y', '-X', zip, path.basename(app)], { cwd: path.dirname(app), env })
    }
    const report = await inspectPackage({ app, arch: 'arm64', root: ROOT, buildRecord: record, ...(directoryOnly ? {} : { artifactsDir: destination }), output: path.join(destination, 'package-report.json') })
    const artifacts = report.artifacts
    if (!directoryOnly) {
      const metadata = stableMetadata(record.version, artifacts.zip)
      artifacts.metadata = path.join(destination, 'latest.json')
      await writeFile(artifacts.metadata, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    }
    const distribution = { schema: 2, buildId: record.buildId, version: record.version, arch: 'arm64', app, destination, artifacts, catalogSha256: record.catalogSha256,
      signature: report.signature, published: false }
    await writeFile(path.join(destination, 'distribution.json'), `${JSON.stringify(distribution, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    console.log(`[oc-chan] 本地 GPUI 产物：${destination}\n[oc-chan] 临时应用：${app}`)
    return distribution
  })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) distribute(parseDistributionOptions(process.argv.slice(2))).catch(error => { console.error(error); process.exitCode = 1 })
