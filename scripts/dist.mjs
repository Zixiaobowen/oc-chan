import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, assert, loadBuild, withBuildLock, buildEnvironment, bundleApplication, run } from './build-app.mjs'
import { inspectPackage } from './check-package.mjs'
import { generateAppcast, compareVersions, readUpdateArchive } from './sparkle-appcast.mjs'
import { readBounded } from './rust-dependencies.mjs'
import { releaseInfo, requireReleaseEnvironment } from './release-config.mjs'

export function releaseChannels(version, records) {
  let channel, previousLts
  for (const line of records.trimEnd().split('\n')) {
    const [tag, type, subject] = line.split('\t')
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) continue
    const candidate = releaseInfo(tag.slice(1)).version
    const order = compareVersions(candidate, version)
    if (order > 0) throw new Error(`A newer version tag already exists: ${tag}`)
    const marker = type === 'tag' && /^OC Chan channel: (regular|lts)$/.exec(subject)?.[1]
    if (order === 0) channel = marker
    if (order < 0 && marker === 'lts' && (!previousLts || compareVersions(candidate, previousLts) > 0)) previousLts = candidate
  }
  if (!channel) throw new Error('Expected a version tag with an explicit release channel')
  return { channel, previousLts: channel === 'regular' ? previousLts : undefined }
}

function releaseHistory(version, directory) {
  const records = execFileSync('git', ['for-each-ref', '--format=%(refname:strip=2)%09%(objecttype)%09%(contents:subject)', 'refs/tags/v*'], { encoding: 'utf8' })
  const { channel, previousLts } = releaseChannels(version, records)
  if (!previousLts) return { channel }
  const prefix = `https://github.com/Zixiaobowen/oc-chan/releases/download/v${previousLts}/`
  const download = (name, maxBytes) => {
    const file = path.join(directory, name)
    execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '300', '--max-filesize', String(maxBytes), '--output', file, prefix + name])
    return file
  }
  return { channel, previous: { version: previousLts,
    feed: readBounded(download('appcast.xml', 256 * 1024), 256 * 1024),
    archive: readUpdateArchive(download(`OC-Chan-${previousLts}-mac-arm64.zip`, 512 * 1024 * 1024)),
  } }
}
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
    const destination = path.join(ROOT, 'release/tauri', record.buildId)
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
      const temporary = await mkdtemp(path.join(tmpdir(), 'oc-lts-history-'))
      try {
        const history = releaseHistory(record.version, temporary)
        await generateAppcast({ ...history, archive: artifacts.zip.path, version: record.version, notesFile: path.join(ROOT, 'releases', `${record.version}.md`), output: artifacts.metadata })
      } finally { await rm(temporary, { recursive: true, force: true }) }
    }
    const distribution = { schema: 2, buildId: record.buildId, version: record.version, arch: 'arm64', app, destination, artifacts, catalogSha256: record.catalogSha256,
      signature: report.signature, published: false }
    await writeFile(path.join(destination, 'distribution.json'), `${JSON.stringify(distribution, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    console.log(`[oc-chan] 本地 React/Tauri 产物：${destination}\n[oc-chan] 临时应用：${app}`)
    return distribution
  })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) distribute(parseDistributionOptions(process.argv.slice(2))).catch(error => { console.error(error); process.exitCode = 1 })
