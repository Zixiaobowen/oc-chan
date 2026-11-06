import { spawnSync } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { packageReleaseInfo, releaseRepository } from './release-config.mjs'

const [directory, tag] = process.argv.slice(2)
const info = packageReleaseInfo()
if (!directory || tag !== info.tag || process.argv.length !== 4) throw new Error(`Usage: node scripts/publish-release.mjs <verified-assets-dir> ${info.tag}`)
if (!process.env.UPDATE_RELEASE_TOKEN?.trim()) throw new Error('Missing required release secret: UPDATE_RELEASE_TOKEN')
if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== `refs/tags/${tag}`) throw new Error('Publishing requires a matching tag push')

function gh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GH_TOKEN: process.env.UPDATE_RELEASE_TOKEN, GH_REPO: releaseRepository },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`gh ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout
}

const names = ['SHA256SUMS.txt', info.metadataName, ...['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(extension => `OC-Chan-${info.version}-mac-${arch}.${extension}`))].sort()
const actual = (await readdir(directory)).sort()
if (JSON.stringify(actual) !== JSON.stringify(names)) throw new Error('Unexpected or missing release assets')
const expected = new Map()
for (const name of names) expected.set(name, (await stat(join(directory, name))).size)
const repository = JSON.parse(gh(['api', `repos/${releaseRepository}`]))
if (repository.private !== false) throw new Error('Update release repository must be public')
// The public repository has no source tags. GitHub creates this release's tag on
// its own default branch; initialize that repository before the first release.
gh(['release', 'create', tag, '--draft', '--title', `OC Chan ${tag}`, '--notes', `OC Chan ${tag}\n\nmacOS installers and signed application update packages for Apple Silicon and Intel.`, '--latest=false', ...(info.prerelease ? ['--prerelease'] : [])])
// No --clobber: collisions fail, and any failure after creation leaves a draft.
gh(['release', 'upload', tag, ...names.map(name => join(directory, name))])
const { databaseId } = JSON.parse(gh(['release', 'view', tag, '--json', 'databaseId']))
const release = JSON.parse(gh(['api', `repos/${releaseRepository}/releases/${databaseId}`]))
if (release.draft !== true || release.prerelease !== info.prerelease || release.assets.length !== expected.size) throw new Error('Draft release state or asset count mismatch')
for (const asset of release.assets) {
  if (expected.get(asset.name) !== asset.size || asset.state !== 'uploaded') throw new Error(`Incomplete release upload: ${asset.name}`)
  expected.delete(asset.name)
}
if (expected.size) throw new Error('Draft release is missing assets')
gh(['release', 'edit', tag, '--draft=false', `--prerelease=${info.prerelease}`, `--latest=${!info.prerelease}`])
console.log(`Published ${releaseRepository} ${tag}`)
