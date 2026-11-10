import { readFileSync } from 'node:fs'

export const releaseRepository = 'Zixiaobowen/oc-chan'
export const signingSecrets = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']
export function releaseInfo(version) {
  if (typeof version !== 'string' || version.length > 64 || version.trim() !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version.split('.').some(part => BigInt(part) > 18446744073709551615n)) throw new Error(`Invalid strict stable release version: ${version}`)
  return { version, tag: `v${version}`, metadataName: 'latest.json' }
}
export function publicationInfo(version, env = process.env) {
  const info = releaseInfo(version)
  if (env.GITHUB_REPOSITORY !== releaseRepository) throw new Error(`Publishing requires source repository ${releaseRepository}`)
  if ((env.GITHUB_EVENT_NAME === 'push' || env.GITHUB_EVENT_NAME === 'workflow_dispatch') && env.GITHUB_REF === 'refs/heads/main') {
    if (typeof env.GITHUB_SHA !== 'string' || env.GITHUB_SHA.length !== 40 || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA)) throw new Error('Preview publishing requires a 40-character lowercase hexadecimal GITHUB_SHA')
    const run = env.GITHUB_RUN_NUMBER
    if (typeof run !== 'string' || !/^[1-9][0-9]{0,15}$/.test(run) || !Number.isSafeInteger(Number(run)) || String(Number(run)) !== run) throw new Error('Preview publishing requires GITHUB_RUN_NUMBER to be a canonical positive safe integer')
    return { ...info, tag: `preview-${run}-${env.GITHUB_SHA.slice(0, 7)}`, prerelease: true, commit: env.GITHUB_SHA }
  }
  if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === `refs/tags/${info.tag}`) return { ...info, prerelease: false }
  throw new Error(`Publishing requires a main push/manual main run or a tag push matching package version ${info.tag}`)
}
export function packageReleaseInfo() { return releaseInfo(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version) }
export function requireReleaseEnvironment(info, env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== `refs/tags/${info.tag}`) throw new Error(`Signed releases require a tag push matching package version ${info.tag}`)
  const missing = signingSecrets.filter(name => !env[name]?.trim())
  if (missing.length) throw new Error(`Missing required release secrets: ${missing.join(', ')}`)
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('APPLE_TEAM_ID must be the 10-character Apple team identifier')
  if (!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(env.APPLE_SIGNING_IDENTITY) || !env.APPLE_SIGNING_IDENTITY.endsWith(`(${env.APPLE_TEAM_ID})`)) throw new Error('APPLE_SIGNING_IDENTITY must be a Developer ID Application identity from APPLE_TEAM_ID')
}
