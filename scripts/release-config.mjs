import { readFileSync } from 'node:fs'
import semver from 'semver'

export const releaseRepository = 'Zixiaobowen/oc-chan'
export const signingSecrets = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']

export function releaseInfo(version) {
  const parsed = semver.parse(version)
  const normalized = parsed && `${parsed.version}${parsed.build.length ? `+${parsed.build.join('.')}` : ''}`
  if (!parsed || normalized !== version) throw new Error(`Invalid release version: ${version}`)
  if (parsed.build.length) throw new Error('Release build metadata is not supported by builder artifact names or the stable update feed')
  const prerelease = parsed.prerelease.length > 0
  const channel = prerelease ? String(parsed.prerelease[0]) : 'latest'
  if (prerelease && channel === 'latest') throw new Error('Prerelease channel must not be latest')
  return { version, tag: `v${version}`, prerelease, channel, metadataName: `${channel}-mac.yml` }
}

export function packageReleaseInfo() {
  return releaseInfo(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
}

export function requireReleaseEnvironment(info, env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== `refs/tags/${info.tag}`) {
    throw new Error(`Signed releases require a tag push matching package version ${info.tag}`)
  }
  const missing = signingSecrets.filter(name => !env[name]?.trim())
  if (missing.length) throw new Error(`Missing required release secrets: ${missing.join(', ')}`)
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('APPLE_TEAM_ID must be the 10-character Apple team identifier')
}
