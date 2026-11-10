import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { open, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packageReleaseInfo, publicationInfo, releaseInfo, releaseRepository } from './release-config.mjs'

// The workflow must serialize every writer to this repository from Latest read
// through publication and readback. GitHub has no conditional Latest update API.
export async function publishRelease({ directory, version, tag, env = process.env }, run = spawnSync) {
  const info = publicationInfo(version, env)
  if (!directory || tag !== info.tag) throw new Error(`Release tag must match package version and publication source: ${info.tag}`)
  if (!env.GH_TOKEN?.trim()) throw new Error('Missing required release environment: GH_TOKEN')

  function gh(args) {
    const result = run('gh', args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 10 * 60 * 1000,
      env: { ...env, GH_REPO: releaseRepository },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error) throw result.error
    if (args[0] === 'api') {
      const response = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(result.stdout)
      if (!response) throw new Error(`Invalid API response for ${args[1]}: ${result.stderr.trim()}`)
      let data
      try {
        data = JSON.parse(response[2])
      } catch (cause) {
        throw new Error(`Invalid API JSON for ${args[1]}`, { cause })
      }
      const status = Number(response[1])
      if (result.status !== 0 || status < 200 || status >= 300) {
        const error = new Error(`gh api ${args[1]} failed (HTTP ${status}): ${result.stderr.trim() || data?.message || 'unknown error'}`)
        // A failed process alone, stderr text, or an invalid body is not a 404.
        error.notFound = result.status === 1 && status === 404 && data?.message === 'Not Found'
        throw error
      }
      return data
    }
    if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`)
    return result.stdout
  }

  const api = path => gh(['api', `repos/${releaseRepository}/${path}`, '--include'])
  function optionalApi(path) {
    try {
      const data = api(path)
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Invalid API object for ${path}`)
      return data
    } catch (error) {
      if (error.notFound === true) return null
      throw error
    }
  }
  function releaseByTag() {
    const [owner, name] = releaseRepository.split('/')
    // REST releases/tags only resolves published releases; GraphQL includes drafts.
    const result = gh(['api', 'graphql', '--include', '-f', 'query=query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){databaseId tagName isDraft isPrerelease}}}', '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `tag=${tag}`])
    if (result?.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length !== 0)) throw new Error(`GraphQL release lookup failed: ${JSON.stringify(result.errors)}`)
    const repository = result?.data?.repository
    if (!repository || typeof repository !== 'object' || !Object.hasOwn(repository, 'release')) throw new Error('Invalid GraphQL release lookup response')
    const release = repository.release
    if (release === null) return null
    if (!release || !Number.isSafeInteger(release.databaseId) || release.databaseId <= 0 || release.tagName !== tag || typeof release.isDraft !== 'boolean' || typeof release.isPrerelease !== 'boolean') throw new Error('Invalid GraphQL release identity')
    return release
  }
  function latestRelease() {
    const release = optionalApi('releases/latest')
    if (release === null) return null
    if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || release.tag_name.length === 0 || (!info.prerelease && !release.tag_name.startsWith('v'))) {
      throw new Error('Invalid current Latest release state')
    }
    if (info.prerelease) return { id: release.id, tag: release.tag_name }
    const latest = releaseInfo(release.tag_name.slice(1))
    if (latest.tag !== release.tag_name) throw new Error('Invalid current Latest release version')
    return { id: release.id, tag: latest.tag, version: latest.version }
  }
  function assertDifferentVersion(latest) {
    if (!info.prerelease && latest && info.version === latest.version) throw new Error(`Release version already exists as Latest: ${latest.tag}`)
  }

  const names = ['SHA256SUMS.txt', ...(!info.prerelease ? [info.metadataName] : []), ...['dmg', 'zip'].map(extension => `OC-Chan-${info.version}-mac-arm64.${extension}`)].sort()
  const actual = []
  for await (const entry of await opendir(directory)) {
    actual.push(entry.name)
    if (actual.length > names.length) throw new Error('Unexpected or missing release assets')
  }
  if (JSON.stringify(actual.sort()) !== JSON.stringify(names)) throw new Error('Unexpected or missing release assets')
  const expected = new Map()
  for (const name of names) {
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      const details = await file.stat()
      if (!details.isFile() || !Number.isSafeInteger(details.size) || details.size <= 0) throw new Error(`Invalid release asset: ${name}`)
      expected.set(name, details.size)
    } finally {
      await file.close()
    }
  }
  const repository = gh(['api', `repos/${releaseRepository}`, '--include'])
  if (typeof repository?.private !== 'boolean') throw new Error('Invalid release repository visibility')
  if (!info.prerelease && repository.private) throw new Error('Update release repository must be public')
  assertDifferentVersion(latestRelease())
  if (releaseByTag() !== null) {
    throw new Error(`Release already exists: ${tag}`)
  }
  const existingTag = optionalApi(`git/ref/tags/${encodeURIComponent(tag)}`)
  if (info.prerelease && existingTag !== null) throw new Error(`Preview tag already exists: ${tag}`)
  if (!info.prerelease && existingTag === null) throw new Error(`Release tag does not exist: ${tag}`)

  function verifyRelease(release, draft, id) {
    if (!release || !Number.isSafeInteger(release.id) || release.id <= 0 || (id !== undefined && release.id !== id) || release.tag_name !== tag || release.draft !== draft || release.prerelease !== info.prerelease || !Array.isArray(release.assets) || release.assets.length !== expected.size) {
      throw new Error(`${draft ? 'Draft' : 'Published'} release state or asset count mismatch`)
    }
    const remaining = new Map(expected)
    for (const asset of release.assets) {
      if (!asset || !remaining.has(asset.name) || remaining.get(asset.name) !== asset.size || asset.state !== 'uploaded') throw new Error(`Incomplete release upload: ${asset?.name}`)
      remaining.delete(asset.name)
    }
    if (remaining.size) throw new Error('Release is missing assets')
  }

  let stage = 'creating draft'
  let releaseId
  const url = `https://github.com/${releaseRepository}/releases/tag/${encodeURIComponent(tag)}`
  try {
    const title = info.prerelease ? `OC Chan preview #${env.GITHUB_RUN_NUMBER} (${info.commit.slice(0, 7)})` : `OC Chan ${tag}`
    const notes = info.prerelease
      ? `OC Chan main preview\n\nBuilt from main commit ${info.commit}.\n\nApple Silicon macOS installers are ad-hoc signed, not Developer ID signed, and not Apple notarized. Download and install manually. This prerelease does not enter the application's stable update channel.`
      : `OC Chan ${tag}\n\nmacOS installers and signed application update packages for Apple Silicon.`
    gh(['release', 'create', tag, ...(info.prerelease ? ['--target', info.commit, '--prerelease'] : ['--verify-tag']), '--draft', '--title', title, '--notes', notes, '--latest=false'])
    stage = 'resolving created draft'
    const created = releaseByTag()
    if (!created || !created.isDraft || created.isPrerelease !== info.prerelease) throw new Error('Created draft identity or state mismatch')
    releaseId = created.databaseId
    stage = 'uploading assets'
    // No --clobber: any collision fails and leaves the draft for inspection.
    gh(['release', 'upload', tag, ...names.map(name => join(directory, name))])
    stage = 'verifying draft'
    verifyRelease(api(`releases/${releaseId}`), true, releaseId)
    // Re-read after upload to minimize the read/write window. All publishers
    // still require the shared workflow lock, including manual publishers.
    stage = 'reading current Latest before publication'
    const previousLatest = latestRelease()
    assertDifferentVersion(previousLatest)
    let makeLatest = false
    if (!info.prerelease) {
      const current = info.version.split('.').map(BigInt)
      const previous = previousLatest?.version.split('.').map(BigInt)
      const differing = previous ? current.findIndex((part, index) => part !== previous[index]) : -1
      makeLatest = !previous || (differing >= 0 && current[differing] > previous[differing])
    }
    stage = 'publishing release (outcome may be unknown)'
    gh(['release', 'edit', tag, '--draft=false', `--prerelease=${info.prerelease}`, `--latest=${makeLatest}`])
    stage = 'verifying published release'
    verifyRelease(api(`releases/${releaseId}`), false, releaseId)
    if (info.prerelease) {
      const publishedTag = api(`git/ref/tags/${encodeURIComponent(tag)}`)
      if (publishedTag?.ref !== `refs/tags/${tag}` || publishedTag.object?.type !== 'commit' || publishedTag.object.sha !== info.commit) throw new Error(`Published preview tag commit mismatch: expected ${info.commit}`)
    }
    const observedLatest = latestRelease()
    const expectedLatest = makeLatest ? { id: releaseId, tag } : previousLatest
    if (observedLatest?.id !== expectedLatest?.id || observedLatest?.tag !== expectedLatest?.tag) {
      throw new Error(`Latest readback mismatch: expected ${expectedLatest?.tag ?? 'none'}, observed ${observedLatest?.tag ?? 'none'}`)
    }
    return { version: info.version, tag, url, latest: makeLatest, prerelease: info.prerelease }
  } catch (cause) {
    const endpoint = `https://api.github.com/repos/${releaseRepository}/releases/${releaseId ?? `tags/${encodeURIComponent(tag)}`}`
    throw new Error(`Release ${tag} failed while ${stage}: ${cause.message}. Remote state was not rolled back; inspect ${url} and ${endpoint}`, { cause })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, tag] = process.argv.slice(2)
  const info = publicationInfo(packageReleaseInfo().version)
  if (!directory || tag !== info.tag || process.argv.length !== 4) throw new Error(`Usage: node scripts/publish-release.mjs <verified-assets-dir> ${info.tag}`)
  const result = await publishRelease({ directory, version: info.version, tag, env: process.env })
  console.log(`Published ${releaseRepository} ${result.tag} (Prerelease: ${result.prerelease}, Latest: ${result.latest}) ${result.url}`)
}
