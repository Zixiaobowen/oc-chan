import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packageReleaseInfo, releaseInfo, releaseRepository, requireReleaseEnvironment } from './release-config.mjs'
import { digestFile, inspectReleaseAssets, releaseAssetNames } from './prepare-release.mjs'

function github(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN, GH_REPO: releaseRepository },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`gh ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout
}

export async function publishRelease({ directory, version, tag, env = process.env, gh = github }) {
  const info = releaseInfo(version)
  if (tag !== info.tag) throw new Error(`Release tag ${tag} must match package version ${info.tag}`)
  requireReleaseEnvironment(info, env)
  if (!env.GITHUB_TOKEN?.trim()) throw new Error('Missing GITHUB_TOKEN')
  if (env.GITHUB_REPOSITORY !== releaseRepository) throw new Error('Release must be published to the source repository')
  const names = ['SHA256SUMS.txt', ...releaseAssetNames(version)].sort()
  const actual = (await readdir(directory)).sort()
  if (JSON.stringify(actual) !== JSON.stringify(names)) throw new Error('Unexpected or missing release assets')
  const assets = await inspectReleaseAssets(directory, version)
  assets.push({ name: 'SHA256SUMS.txt', ...await digestFile(join(directory, 'SHA256SUMS.txt')) })
  const expected = new Map(assets.map(asset => [asset.name, asset]))
  const repository = JSON.parse(gh(['api', `repos/${releaseRepository}`]))
  if (repository.private !== false) throw new Error('Update release repository must be public')
  gh(['release', 'create', tag, '--verify-tag', '--draft', '--title', `OC Chan ${tag}`, '--notes', `OC Chan ${tag}: Ad-hoc signed macOS installers for Apple Silicon.`, '--latest=false', ...(info.prerelease ? ['--prerelease'] : [])])
  // No --clobber: collisions fail, and any failure after creation leaves a draft.
  gh(['release', 'upload', tag, ...names.map(name => join(directory, name))])
  const { databaseId } = JSON.parse(gh(['release', 'view', tag, '--json', 'databaseId']))
  const release = JSON.parse(gh(['api', `repos/${releaseRepository}/releases/${databaseId}`]))
  if (release.tag_name !== tag || release.draft !== true || release.prerelease !== info.prerelease || !Array.isArray(release.assets) || release.assets.length !== expected.size) throw new Error('Draft release state or asset count mismatch')
  for (const asset of release.assets) {
    const local = expected.get(asset.name)
    if (!local || local.size !== asset.size || asset.state !== 'uploaded' || asset.digest !== `sha256:${local.sha256}`) throw new Error(`Incomplete or corrupt release upload: ${asset.name}`)
    expected.delete(asset.name)
  }
  if (expected.size) throw new Error('Draft release is missing assets')
  gh(['release', 'edit', tag, '--draft=false', `--prerelease=${info.prerelease}`, `--latest=${!info.prerelease}`])
  return `Published ${releaseRepository} ${tag}`
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, tag] = process.argv.slice(2)
  if (!directory || !tag || process.argv.length !== 4) throw new Error('Usage: node scripts/publish-release.mjs <verified-assets-dir> <tag>')
  console.log(await publishRelease({ directory, version: packageReleaseInfo().version, tag }))
}
