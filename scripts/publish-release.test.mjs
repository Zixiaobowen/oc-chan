import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { publishRelease } from './publish-release.mjs'
import { releaseInfo, releaseRepository } from './release-config.mjs'

const fixtureToken = ['isolated', 'test', 'token'].join('-')
const success = () => ({ status: 0, stdout: '', stderr: '' })
const failure = message => ({ status: 1, stdout: '', stderr: message })
const response = (status, data) => ({
  status: status >= 400 ? 1 : 0,
  stdout: `HTTP/2.0 ${status} ${status === 404 ? 'Not Found' : 'Response'}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}`,
  stderr: status >= 400 ? `gh: ${data?.message} (HTTP ${status})` : '',
})

// Stateful, isolated GitHub transport. Uploads consume the actual local files;
// public visibility, existing tags and Latest are independent server state.
function github(options = {}) {
  const releases = new Map()
  const tags = new Set(options.tags ?? [])
  const events = []
  let nextId = 1
  let latestId = null
  let latestReads = 0
  function seed(tag, { draft = false, prerelease = false, latest = false } = {}) {
    const release = { id: nextId++, tag_name: tag, draft, prerelease, assets: [] }
    releases.set(tag, release)
    if (!draft) tags.add(tag)
    if (latest) latestId = release.id
    return release
  }
  if (options.latest) seed(options.latest, { latest: true })
  const state = { releases, tags, events, seed, get latest() { return [...releases.values()].find(release => release.id === latestId) ?? null } }
  state.run = (command, args, config) => {
    assert.equal(command, 'gh')
    assert.equal(config.env.GH_REPO, releaseRepository)
    assert.equal(config.env.GH_TOKEN, fixtureToken)
    assert.ok(config.maxBuffer <= 1024 * 1024)
    assert.ok(config.timeout > 0)
    const [kind, action, tag] = args
    if (kind === 'api') {
      assert.ok(args.includes('--include'))
      const path = action.replace(`repos/${releaseRepository}`, '')
      events.push(`GET ${path}`)
      if (path === '') return response(200, { private: false })
      if (path === '/releases/latest') {
        latestReads += 1
        const override = options.latestResponse?.(latestReads, state)
        if (override) return override
        return state.latest ? response(200, state.latest) : response(404, { message: 'Not Found' })
      }
      if (path.startsWith('/git/ref/tags/')) {
        const name = decodeURIComponent(path.slice('/git/ref/tags/'.length))
        return tags.has(name) ? response(200, { ref: `refs/tags/${name}` }) : response(404, { message: 'Not Found' })
      }
      const release = path.startsWith('/releases/tags/')
        ? releases.get(decodeURIComponent(path.slice('/releases/tags/'.length)))
        : [...releases.values()].find(item => path === `/releases/${item.id}`)
      if (!release) return response(404, { message: 'Not Found' })
      const snapshot = structuredClone(release)
      if (!release.draft) options.publishedReadback?.(snapshot)
      return response(200, snapshot)
    }
    assert.equal(kind, 'release')
    events.push(`${action} ${tag}`)
    if (action === 'create') {
      if (releases.has(tag)) return failure('Release already exists')
      if (args.includes('--verify-tag') && !tags.has(tag)) return failure('Release tag does not exist')
      assert.ok(args.includes('--draft'))
      assert.ok(args.includes('--latest=false'))
      seed(tag, { draft: true, prerelease: args.includes('--prerelease') })
      return success()
    }
    const release = releases.get(tag)
    assert.ok(release, `unknown release ${tag}`)
    if (action === 'upload') {
      assert.equal(release.draft, true)
      assert.ok(!args.includes('--clobber'))
      for (const path of args.slice(3)) {
        const name = basename(path)
        if (release.assets.some(asset => asset.name === name)) return failure('Asset already exists')
        release.assets.push({ name, size: statSync(path).size, state: 'uploaded' })
        if (options.uploadFailure) return failure('Upload interrupted by network failure')
      }
      options.uploaded?.(release, state)
      return success()
    }
    assert.equal(action, 'edit')
    assert.ok(args.includes('--draft=false'))
    // Publishing mutates server state before responding, even if the response
    // is subsequently lost. This models the ambiguous outcome case.
    release.draft = false
    release.prerelease = args.includes('--prerelease=true')
    tags.add(tag)
    if (args.includes('--latest=true') && !options.ignoreLatest) {
      assert.equal(release.prerelease, false)
      latestId = release.id
    }
    options.published?.(release, state)
    return options.publishResponseLost ? failure('Connection reset after request was sent') : success()
  }
  return state
}

async function fixture(t, version = '1.2.3', serverOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'oc-chan-publish-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const info = releaseInfo(version)
  const names = ['SHA256SUMS.txt', info.metadataName, `OC-Chan-${version}-mac-arm64.dmg`, `OC-Chan-${version}-mac-arm64.zip`]
  const sizes = new Map()
  for (const [index, name] of names.entries()) {
    const content = Buffer.from(`release fixture ${version} ${index} ${name}\n`)
    await writeFile(join(directory, name), content)
    sizes.set(name, content.length)
  }
  const remote = github({ tags: [info.tag], ...serverOptions })
  const options = { directory, version, tag: info.tag, env: { GH_TOKEN: fixtureToken, GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/tags/${info.tag}` } }
  return { remote, options, info, sizes, publish: () => publishRelease(options, remote.run) }
}

function assertPublic(fixture, latestTag) {
  const release = fixture.remote.releases.get(fixture.info.tag)
  assert.equal(release.draft, false)
  assert.equal(release.prerelease, fixture.info.prerelease)
  assert.equal(release.tag_name, fixture.info.tag)
  assert.deepEqual(new Map(release.assets.map(asset => [asset.name, asset.size])), fixture.sizes)
  assert.ok(release.assets.every(asset => asset.state === 'uploaded'))
  assert.equal(fixture.remote.latest?.tag_name ?? null, latestTag)
  const events = fixture.remote.events
  const upload = events.indexOf(`upload ${fixture.info.tag}`)
  const draftCheck = events.indexOf(`GET /releases/tags/${fixture.info.tag}`, upload + 1)
  const latestCheck = events.indexOf('GET /releases/latest', draftCheck + 1)
  const publish = events.indexOf(`edit ${fixture.info.tag}`)
  const publicCheck = events.indexOf(`GET /releases/${release.id}`, publish + 1)
  const latestReadback = events.indexOf('GET /releases/latest', publicCheck + 1)
  assert.ok(upload >= 0 && draftCheck > upload && latestCheck > draftCheck && publish > latestCheck && publicCheck > publish && latestReadback > publicCheck)
}

for (const [version, latest, expected] of [
  ['1.9.0', 'v1.10.0', 'v1.10.0'],
  ['1.10.0', 'v1.9.0', 'v1.10.0'],
  ['2.0.0', 'v1.99.99', 'v2.0.0'],
  ['1.2.3', undefined, 'v1.2.3'],
  ['2.0.0-beta.1', 'v1.2.3', 'v1.2.3'],
  ['2.0.0-beta.1', undefined, null],
]) {
  test(`publishes ${version} with existing Latest ${latest ?? 'none'} as Latest ${expected ?? 'none'}`, async t => {
    const f = await fixture(t, version, { latest })
    const result = await f.publish()
    assert.equal(result.latest, expected === f.info.tag)
    assertPublic(f, expected)
  })
}

test('re-reads Latest after upload before deciding whether to promote', async t => {
  const f = await fixture(t, '2.0.0', { latest: 'v1.0.0', uploaded: (_release, remote) => remote.seed('v3.0.0', { latest: true }) })
  await f.publish()
  assertPublic(f, 'v3.0.0')
})

for (const [name, serverOptions] of [
  ['same Latest version', { latest: 'v1.2.3' }],
  ['existing release', {}],
]) {
  test(`rejects ${name} without overwriting`, async t => {
    const f = await fixture(t, '1.2.3', serverOptions)
    if (name === 'existing release') f.remote.seed('v1.2.3', { draft: true })
    const before = structuredClone([...f.remote.releases])
    await assert.rejects(f.publish(), /already exists/)
    assert.deepEqual([...f.remote.releases], before)
    assert.ok(f.remote.events.every(event => event.startsWith('GET ')))
  })
}

test('rejects a missing source tag without creating a release or tag', async t => {
  const f = await fixture(t, '1.2.3', { tags: [] })
  await assert.rejects(f.publish(), /Release tag does not exist/)
  assert.equal(f.remote.releases.size, 0)
  assert.equal(f.remote.tags.size, 0)
  assert.ok(f.remote.events.every(event => event.startsWith('GET ')))
})

for (const [name, invalidResponse, message] of [
  ['invalid JSON', { status: 0, stdout: 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{', stderr: '' }, /Invalid API JSON/],
  ['null JSON', response(200, null), /Invalid API object/],
  ['unauthorized', response(401, { message: 'Bad credentials' }), /HTTP 401.*Bad credentials/],
  ['server failure', response(503, { message: 'Service unavailable' }), /HTTP 503/],
  ['network failure mentioning 404', failure('Network connection failed, previous HTTP 404'), /Invalid API response.*Network connection/],
  ['404 with unexpected body', response(404, { message: 'Authorization failed' }), /HTTP 404.*Authorization failed/],
  ['404 with malformed JSON', { status: 1, stdout: 'HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{', stderr: 'gh: HTTP 404' }, /Invalid API JSON/],
]) {
  test(`propagates current Latest ${name} without creating a release`, async t => {
    const f = await fixture(t, '1.2.3', { latestResponse: () => invalidResponse })
    await assert.rejects(f.publish(), message)
    assert.equal(f.remote.releases.size, 0)
    assert.ok(f.remote.events.every(event => event.startsWith('GET ')))
  })
}

for (const tag of ['v1.02.3', '1.2.3', 'v1.2', 'v1.2.3+build.7', 'v1.2.3-beta.1']) {
  test(`rejects noncanonical or unstable current Latest ${tag}`, async t => {
    const f = await fixture(t, '2.0.0', { latest: tag })
    await assert.rejects(f.publish(), /Invalid|build metadata/)
    assert.equal(f.remote.releases.size, 1)
    assert.ok(f.remote.events.every(event => event.startsWith('GET ')))
  })
}

test('upload failure keeps the incomplete release private and preserves Latest', async t => {
  const f = await fixture(t, '2.0.0', { latest: 'v1.0.0', uploadFailure: true })
  await assert.rejects(f.publish(), error => {
    assert.match(error.message, /uploading assets.*Upload interrupted/)
    assert.match(error.message, /https:\/\/github.com\/Zixiaobowen\/oc-chan\/releases\/tag\/v2.0.0/)
    assert.match(error.message, /Remote state was not rolled back/)
    return true
  })
  const draft = f.remote.releases.get(f.info.tag)
  assert.equal(draft.draft, true)
  assert.equal(draft.assets.length, 1)
  assert.equal(f.remote.latest.tag_name, 'v1.0.0')
  assert.ok(!f.remote.events.includes(`edit ${f.info.tag}`))
})

for (const [name, corrupt] of [
  ['size', release => { release.assets[0].size += 1 }],
  ['state', release => { release.assets[0].state = 'new' }],
  ['duplicate name', release => { release.assets[1] = { ...release.assets[0] } }],
  ['missing attachment', release => { release.assets.pop() }],
  ['wrong tag', release => { release.tag_name = 'v9.9.9' }],
]) {
  test(`server draft ${name} mismatch prevents public visibility`, async t => {
    const f = await fixture(t, '1.2.3', { uploaded: corrupt })
    await assert.rejects(f.publish(), /verifying draft/)
    assert.equal(f.remote.releases.get(f.info.tag).draft, true)
    assert.equal(f.remote.latest, null)
    assert.ok(!f.remote.events.includes(`edit ${f.info.tag}`))
  })
}

test('a Latest lookup failure after upload leaves the verified draft private', async t => {
  const f = await fixture(t, '1.2.3', { latestResponse: count => count === 2 ? response(403, { message: 'Forbidden' }) : undefined })
  await assert.rejects(f.publish(), /reading current Latest before publication.*HTTP 403/)
  assert.equal(f.remote.releases.get(f.info.tag).draft, true)
  assert.ok(!f.remote.events.includes(`edit ${f.info.tag}`))
})

for (const [name, serverOptions, message] of [
  ['draft state', { published: release => { release.draft = true } }, /Published release state/],
  ['asset count', { published: release => { release.assets.pop() } }, /Published release state or asset count/],
  ['release identity', { publishedReadback: release => { release.id += 100 } }, /Published release state/],
  ['Latest not promoted', { ignoreLatest: true }, /Latest readback mismatch/],
  ['Latest changes after publication', { published: (_release, remote) => remote.seed('v9.0.0', { latest: true }) }, /Latest readback mismatch/],
  ['Latest lookup fails', { latestResponse: count => count === 3 ? response(502, { message: 'Bad gateway' }) : undefined }, /HTTP 502/],
]) {
  test(`public readback rejects ${name} without deletion or overwrite`, async t => {
    const f = await fixture(t, '2.0.0', { latest: 'v1.0.0', ...serverOptions })
    await assert.rejects(f.publish(), error => {
      assert.match(error.message, /verifying published release/)
      assert.match(error.message, message)
      assert.match(error.message, /https:\/\/api.github.com\/repos\/Zixiaobowen\/oc-chan\/releases\/2/)
      return true
    })
    assert.ok(f.remote.releases.has(f.info.tag))
    assert.equal(f.remote.events.filter(event => event === `edit ${f.info.tag}`).length, 1)
    assert.ok(f.remote.events.every(event => !event.startsWith('delete ')))
  })
}

test('lost publication response retains the actual public release with a diagnostic location', async t => {
  const f = await fixture(t, '2.0.0', { latest: 'v1.0.0', publishResponseLost: true })
  await assert.rejects(f.publish(), /outcome may be unknown.*Connection reset.*Remote state was not rolled back.*https:\/\//)
  assert.equal(f.remote.releases.get(f.info.tag).draft, false)
  assert.equal(f.remote.latest.tag_name, f.info.tag)
  assert.equal(f.remote.events.filter(event => event === `edit ${f.info.tag}`).length, 1)
})
