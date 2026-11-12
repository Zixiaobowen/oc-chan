import { build, Platform, Arch } from 'electron-builder'
import { packageReleaseInfo } from './release-config.mjs'

const args = process.argv.slice(2)
if (args.some(arg => !['--arm64', '--x64', '--dir'].includes(arg)) || (args.includes('--arm64') && args.includes('--x64'))) {
  throw new Error('Usage: node scripts/dist.mjs [--arm64|--x64] [--dir]')
}
const arch = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : process.arch
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch) || arch !== process.arch) {
  throw new Error(`Native macOS ${arch} runner required; got ${process.platform} ${process.arch}`)
}
const info = packageReleaseInfo()
if (process.env.GITHUB_REF?.startsWith('refs/tags/') && process.env.GITHUB_REF !== `refs/tags/${info.tag}`) {
  throw new Error(`Release tag must match package version ${info.tag}`)
}
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
await build({
  targets: Platform.MAC.createTarget(args.includes('--dir') ? ['dir'] : ['dmg', 'zip'], Arch[arch]),
  publish: 'never',
  config: {
    forceCodeSigning: false,
    mac: { identity: '-', notarize: false },
    publish: null,
  },
})
