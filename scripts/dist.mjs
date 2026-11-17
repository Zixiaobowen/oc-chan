import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, assert, loadBuild, withBuildLock, buildEnvironment, bundleApplication, run } from './build-app.mjs'
import { inspectPackage } from './check-package.mjs'
import { generateAppcast } from './sparkle-appcast.mjs'
import { releaseInfo, requireReleaseEnvironment } from './release-config.mjs'

export function parseDistributionOptions(args) {
  assert(new Set(args).size === args.length && args.every(arg => ['--arm64', '--dir'].includes(arg)), 'Usage: node scripts/dist.mjs [--arm64] [--dir]')
  return { directoryOnly: args.includes('--dir') }
}
export async function distribute({ directoryOnly = false, execute = run } = {}) {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Distribution requires a native macOS arm64 host')
  const initial = await loadBuild()
  return withBuildLock(initial.resourcesDir, async () => {
    const record = await loadBuild(); assert(record.buildId === initial.buildId, 'Build changed before distribution acquired ownership')
    if (process.env.GITHUB_REF?.startsWith('refs/tags/')) requireReleaseEnvironment(releaseInfo(record.version))
    const env = buildEnvironment({ resourcesDir: record.resourcesDir, targetDir: record.targetDir, sign: record.sign })
    const destination = path.join(ROOT, 'release/gpui', record.buildId)
    await mkdir(destination, { mode: 0o700 })
    const app = path.join(destination, 'OC Chan.app')
    await bundleApplication({ application: app, binary: record.binary, resourcesDir: record.resourcesDir, version: record.version, sign: record.sign, execute, env })
    if (!directoryOnly) {
      const prefix = `OC-Chan-${record.version}-mac-arm64`, zip = path.join(destination, `${prefix}.zip`), dmg = path.join(destination, `${prefix}.dmg`)
      await execute('/usr/bin/hdiutil', ['create', '-volname', 'OC Chan', '-srcfolder', app, '-format', 'UDZO', dmg], { cwd: ROOT, env })
      // -y stores relative bundle symlinks; -X excludes platform extra metadata.
      // Preserve the application bundle layout and framework symlinks.
      await execute('/usr/bin/zip', ['-q', '-r', '-y', '-X', zip, path.basename(app)], { cwd: path.dirname(app), env })
    }
    const report = await inspectPackage({ app, arch: 'arm64', root: ROOT, buildRecord: record, ...(directoryOnly ? {} : { artifactsDir: destination }), output: path.join(destination, 'package-report.json') })
    const artifacts = report.artifacts
    if (!directoryOnly && process.env.GITHUB_REF?.startsWith('refs/tags/')) {
      artifacts.metadata = path.join(destination, 'appcast.xml')
      await generateAppcast({ archive: artifacts.zip.path, version: record.version, notesFile: path.join(ROOT, 'releases', `${record.version}.md`), output: artifacts.metadata })
    }
    const distribution = { schema: 2, buildId: record.buildId, version: record.version, arch: 'arm64', app, destination, artifacts, catalogSha256: record.catalogSha256,
      signature: report.signature, published: false }
    await writeFile(path.join(destination, 'distribution.json'), `${JSON.stringify(distribution, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    console.log(`[oc-chan] 本地 GPUI 产物：${destination}\n[oc-chan] 临时应用：${app}`)
    return distribution
  })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) distribute(parseDistributionOptions(process.argv.slice(2))).catch(error => { console.error(error); process.exitCode = 1 })
