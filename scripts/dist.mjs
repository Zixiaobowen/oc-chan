import { build, Platform, Arch } from 'electron-builder'
import { packageReleaseInfo, requireReleaseEnvironment } from './release-config.mjs'

const args = process.argv.slice(2)
if (args.some(arg => !['--arm64', '--x64', '--dir'].includes(arg)) || (args.includes('--arm64') && args.includes('--x64'))) {
  throw new Error('Usage: node scripts/dist.mjs [--arm64|--x64] [--dir]')
}
const arch = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : process.arch
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch) || arch !== process.arch) {
  throw new Error(`Native macOS ${arch} runner required; got ${process.platform} ${process.arch}`)
}
const info = packageReleaseInfo()
const signed = process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF?.startsWith('refs/tags/')
if (signed) requireReleaseEnvironment(info)
// Never use certificates from a developer's keychain for ordinary/local builds.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = signed ? 'true' : 'false'
await build({
  targets: Platform.MAC.createTarget(args.includes('--dir') ? ['dir'] : ['dmg', 'zip'], Arch[arch]),
  publish: 'never',
  config: {
    forceCodeSigning: signed,
    mac: { ...(signed ? {} : { identity: null }), notarize: signed },
    publish: {
      provider: 'github',
      owner: 'Zixiaobowen',
      repo: 'oc-chan-releases',
      channel: info.channel,
      releaseType: info.prerelease ? 'prerelease' : 'draft',
      publishAutoUpdate: true,
    },
  },
})
