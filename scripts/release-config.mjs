import { readFileSync } from 'node:fs'
import semver from 'semver'

export const releaseRepository = 'Zixiaobowen/oc-chan'

export function releaseInfo(version) {
  const parsed = semver.parse(version)
  const normalized = parsed && `${parsed.version}${parsed.build.length ? `+${parsed.build.join('.')}` : ''}`
  if (!parsed || normalized !== version) throw new Error(`Invalid release version: ${version}`)
  return { version, tag: `v${version}`, prerelease: parsed.prerelease.length > 0 }
}

export function packageReleaseInfo() {
  return releaseInfo(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
}

export function requireReleaseEnvironment(info, env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== `refs/tags/${info.tag}`) {
    throw new Error(`Releases require a tag push matching package version ${info.tag}`)
  }
}
