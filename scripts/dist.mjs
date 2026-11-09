import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, Platform, Arch } from 'electron-builder'
import { packageReleaseInfo, requireReleaseEnvironment } from './release-config.mjs'

const args = process.argv.slice(2)
const usage = 'Usage: node scripts/dist.mjs [--arm64|--x64] [--dir] [--out DIRECTORY]'
let arch = process.arch, directory = false, out
const seen = new Set()
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  const key = ['--arm64', '--x64'].includes(arg) ? 'arch' : arg
  if (seen.has(key)) throw new Error(usage)
  seen.add(key)
  if (key === 'arch') arch = arg.slice(2)
  else if (arg === '--dir') directory = true
  else if (arg === '--out' && args[index + 1]?.trim() && !args[index + 1].startsWith('--')) out = path.resolve(args[++index])
  else throw new Error(usage)
}
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch) || arch !== process.arch) {
  throw new Error(`Native macOS ${arch} runner required; got ${process.platform} ${process.arch}`)
}
const info = packageReleaseInfo()
const signed = process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF?.startsWith('refs/tags/')
if (signed) requireReleaseEnvironment(info)
// Never use certificates from a developer's keychain for ordinary/local builds.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = signed ? 'true' : 'false'
execFileSync('npm', ['run', 'build:app'], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit', timeout: 600000 })
await build({
  targets: Platform.MAC.createTarget(directory ? ['dir'] : ['dmg', 'zip'], Arch[arch]),
  publish: 'never',
  config: {
    ...(out ? { directories: { output: out } } : {}),
    forceCodeSigning: signed,
    mac: { ...(signed ? {} : { identity: null }), notarize: signed },
    publish: {
      provider: 'github',
      owner: 'Zixiaobowen',
      repo: 'oc-chan',
      channel: info.channel,
      releaseType: info.prerelease ? 'prerelease' : 'draft',
      publishAutoUpdate: true,
    },
  },
})
