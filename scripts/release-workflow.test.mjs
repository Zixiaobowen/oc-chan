import test from 'node:test'
import assert from 'node:assert/strict'
import { requireMain, stableTarget, requireMatchingTag, verifyDispatchCommit, run, githubApi } from './release-workflow.mjs'
import { releaseRepository, signingSecrets } from './release-config.mjs'
import { readFileSync } from 'node:fs'
import { publicKey, privateSeed } from './sparkle-test-fixture.mjs'

const env = {
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: releaseRepository,
  GITHUB_SHA: 'a'.repeat(40),
  SPARKLE_PRIVATE_KEY: privateSeed,
}

test('release entry requires manual source main and exact selected commit', () => {
  assert.doesNotThrow(() => requireMain(env))
  for (const override of [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/heads/release/1.2.3' },
    { GITHUB_REF: 'refs/tags/v1.2.3' },
    { GITHUB_REPOSITORY: 'fork/oc-chan' },
    { GITHUB_SHA: '' },
  ]) assert.throws(() => requireMain({ ...env, ...override }))
})

test('stable version must be strict and match checked main version', () => {
  assert.equal(stableTarget('1.2.3', { version: '1.2.3' }, env, publicKey).tag, 'v1.2.3')
  for (const requested of ['v1.2.3', '1.2.3-beta', '01.2.3', '1.2.3\n', '1.2.4']) {
    assert.throws(() => stableTarget(requested, { version: '1.2.3' }, env, publicKey))
  }
})

test('stable entry checks every signing secret before creating a tag', () => {
  for (const key of signingSecrets) {
    assert.throws(() => stableTarget('1.2.3', { version: '1.2.3' }, { ...env, [key]: '' }, publicKey), /Missing required release secrets/)
  }
  assert.throws(() => stableTarget('1.2.3', { version: '1.2.3' }, { ...env, SPARKLE_PRIVATE_KEY: Buffer.alloc(32).toString('base64') }, publicKey), /does not match/)
})

test('an existing immutable tag is reusable only at the exact selected commit', () => {
  assert.doesNotThrow(() => requireMatchingTag('a'.repeat(40), 'a'.repeat(40)))
  assert.throws(() => requireMatchingTag('b'.repeat(40), 'a'.repeat(40)), /cannot be overwritten/)
})

test('release dispatch is bound to its exact requested commit', () => {
  const branch = { ...env, GITHUB_REF: 'refs/heads/release/1.2.3', EXPECTED_SHA: env.GITHUB_SHA }
  assert.doesNotThrow(() => verifyDispatchCommit(branch, env.GITHUB_SHA))
  assert.throws(() => verifyDispatchCommit({ ...branch, EXPECTED_SHA: '' }, env.GITHUB_SHA), /expected_sha/)
  assert.throws(() => verifyDispatchCommit({ ...branch, EXPECTED_SHA: 'b'.repeat(40) }, env.GITHUB_SHA), /expected_sha/)
  assert.throws(() => verifyDispatchCommit(branch, 'b'.repeat(40)), /checkout/)
  assert.doesNotThrow(() => verifyDispatchCommit(env, env.GITHUB_SHA))
  assert.doesNotThrow(() => verifyDispatchCommit({ ...env, GITHUB_EVENT_NAME: 'push' }, env.GITHUB_SHA))
})

function workflowFixture({ tagCommit, releases = [], failRoute, ancestor = true } = {}) {
  const events = []
  let head = env.GITHUB_SHA
  const releaseCommit = 'c'.repeat(40)
  const files = ['Cargo.toml', 'Cargo.lock', 'package.json', 'package-lock.json', 'docs/dependency-review-policy.json', 'releases/1.2.3.md']
  const input = { ...env, GH_TOKEN: ['workflow', 'fixture'].join('-'), RELEASE_BUMP: 'patch', RELEASE_VERSION: '1.2.3', RELEASE_NOTES: 'Fix $(echo unsafe) `literal`\nSecond line' }
  const dependencies = {
    publicKey,
    git(...args) {
      events.push({ type: 'git', args })
      if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? head : tagCommit
      if (args[0] === 'merge-base' && !ancestor) throw new Error('Commit is outside main')
      if (args.includes('commit')) head = releaseCommit
      return ''
    },
    version(...args) {
      events.push({ type: 'version', args })
      if (args[0] === 'bump') assert.equal(readFileSync(args[3], 'utf8'), input.RELEASE_NOTES)
      return { previousVersion: '1.2.2', version: '1.2.3', tag: 'v1.2.3', files }
    },
    readNotes() { return input.RELEASE_NOTES },
    async fetch(url, options) {
      const route = url.split(`/repos/${releaseRepository}/`)[1]
      const body = options.body ? JSON.parse(options.body) : undefined
      events.push({ type: 'api', route, method: options.method, body })
      assert.equal(options.headers.Authorization, `Bearer ${input.GH_TOKEN}`)
      assert.ok(options.signal instanceof AbortSignal)
      if (route === failRoute) return new Response('secret must never be reported', { status: 403 })
      if (route.startsWith('releases?')) return Response.json(releases)
      if (route.startsWith('git/matching-refs/')) return Response.json(tagCommit ? [{ ref: 'refs/tags/v1.2.3' }] : [])
      if (route === 'pulls') return Response.json({ html_url: 'https://example.test/pull/42' })
      if (route.endsWith('/dispatches')) return new Response(null, { status: 204 })
      if (route === 'git/refs') return Response.json({})
      throw new Error(`Unexpected test request: ${route}`)
    },
  }
  return { events, input, dependencies, files, releaseCommit }
}

test('prepare orchestrates an exact-file commit, PR, then SHA-bound build dispatch', async () => {
  const fixture = workflowFixture()
  const result = await run('prepare', fixture.input, fixture.dependencies)
  assert.equal(result.pullRequest, 'https://example.test/pull/42')
  const requests = fixture.events.filter(event => event.type === 'api')
  assert.deepEqual(requests.map(event => event.route), ['git/refs', 'pulls', 'actions/workflows/build.yml/dispatches'])
  assert.deepEqual(requests[0].body, { ref: 'refs/heads/release/1.2.3', sha: env.GITHUB_SHA })
  assert.deepEqual(requests[2].body, { ref: 'release/1.2.3', inputs: { expected_sha: fixture.releaseCommit } })
  assert.ok(requests[1].body.body.includes(fixture.input.RELEASE_NOTES))
  assert.ok(requests[1].body.body.includes(fixture.releaseCommit))
  assert.deepEqual(fixture.events.find(event => event.type === 'git' && event.args[0] === 'add').args, ['add', '--', ...fixture.files])
  const push = fixture.events.findIndex(event => event.type === 'git' && event.args[0] === 'push')
  const pr = fixture.events.findIndex(event => event.route === 'pulls')
  assert.ok(push < pr)
})

test('prepare propagates PR and dispatch errors without leaking response bodies', async () => {
  for (const route of ['pulls', 'actions/workflows/build.yml/dispatches']) {
    const fixture = workflowFixture({ failRoute: route })
    await assert.rejects(run('prepare', fixture.input, fixture.dependencies), error => {
      assert.match(error.message, /HTTP 403/)
      assert.ok(!error.message.includes('secret'))
      return true
    })
    if (route === 'pulls') assert.ok(!fixture.events.some(event => event.route?.endsWith('/dispatches')))
  }
})

test('stable creates a tag only after checking release history and binds dispatch to main SHA', async () => {
  const fixture = workflowFixture()
  await run('stable', fixture.input, fixture.dependencies)
  const requests = fixture.events.filter(event => event.type === 'api')
  assert.deepEqual(requests.map(event => event.route), ['releases?per_page=100&page=1', 'git/matching-refs/tags/v1.2.3', 'git/refs', 'actions/workflows/build.yml/dispatches'])
  assert.deepEqual(requests[2].body, { ref: 'refs/tags/v1.2.3', sha: env.GITHUB_SHA })
  assert.deepEqual(requests[3].body, { ref: 'v1.2.3', inputs: { expected_sha: env.GITHUB_SHA } })
})

test('stable rejects both drafts and published releases before any writes', async () => {
  for (const draft of [true, false]) {
    const fixture = workflowFixture({ releases: [{ tag_name: 'v1.2.3', draft }] })
    await assert.rejects(run('stable', fixture.input, fixture.dependencies), /already exists/)
    assert.ok(fixture.events.filter(event => event.type === 'api').every(event => event.method === 'GET'))
  }
})

test('stable retries same-commit tags but rejects conflicting tags without API writes', async () => {
  const matching = workflowFixture({ tagCommit: env.GITHUB_SHA })
  await run('stable', matching.input, matching.dependencies)
  assert.deepEqual(matching.events.filter(event => event.type === 'api' && event.method === 'POST').map(event => event.route), ['actions/workflows/build.yml/dispatches'])
  const conflict = workflowFixture({ tagCommit: 'b'.repeat(40) })
  await assert.rejects(run('stable', conflict.input, conflict.dependencies), /cannot be overwritten/)
  assert.ok(conflict.events.filter(event => event.type === 'api').every(event => event.method === 'GET'))
})

test('stable propagates dispatch failure and rejects missing signing credentials before API writes', async () => {
  const fixture = workflowFixture({ failRoute: 'actions/workflows/build.yml/dispatches' })
  await assert.rejects(run('stable', fixture.input, fixture.dependencies), /HTTP 403/)
  const unsigned = workflowFixture()
  await assert.rejects(run('stable', { ...unsigned.input, SPARKLE_PRIVATE_KEY: '' }, unsigned.dependencies), /Missing required release secrets/)
  assert.ok(!unsigned.events.some(event => event.type === 'api'))
})

test('verify-build checks release metadata and main ancestry for dispatched tags', async () => {
  const fixture = workflowFixture()
  const tagged = { ...fixture.input, GITHUB_REF: 'refs/tags/v1.2.3', EXPECTED_SHA: env.GITHUB_SHA }
  await run('verify-build', tagged, fixture.dependencies)
  assert.deepEqual(fixture.events.find(event => event.type === 'version').args, ['check', '--release'])
  assert.ok(fixture.events.some(event => event.type === 'git' && event.args[0] === 'merge-base'))
  assert.ok(!fixture.events.some(event => event.type === 'api'))
  const outside = workflowFixture({ ancestor: false })
  await assert.rejects(run('verify-build', tagged, outside.dependencies), /outside main/)
  await assert.rejects(run('verify-build', { ...tagged, EXPECTED_SHA: 'b'.repeat(40) }, fixture.dependencies), /expected_sha/)
})

test('verify-build branch dispatch checks versions without release notes or external writes', async () => {
  const fixture = workflowFixture()
  await run('verify-build', { ...fixture.input, GITHUB_REF: 'refs/heads/release/1.2.3', EXPECTED_SHA: env.GITHUB_SHA }, fixture.dependencies)
  assert.deepEqual(fixture.events.find(event => event.type === 'version').args, ['check'])
  assert.ok(!fixture.events.some(event => event.type === 'api'))
})

test('API rejects absent token, oversized responses and transport failure', async () => {
  assert.throws(() => githubApi({}), /GH_TOKEN/)
  const oversized = githubApi({ GH_TOKEN: 'fixture' }, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)))
  await assert.rejects(oversized('releases'), /exceeds 2 MiB/)
  const failed = githubApi({ GH_TOKEN: 'fixture' }, async () => { throw new Error('Network unavailable') })
  await assert.rejects(failed('releases'), /Network unavailable/)
})
