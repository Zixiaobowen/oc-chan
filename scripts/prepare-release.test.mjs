import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir, symlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareRelease, digestFile, inspectReleaseAssets } from './prepare-release.mjs'
import { publishRelease } from './publish-release.mjs'
import { releaseInfo, releaseRepository, requireReleaseEnvironment } from './release-config.mjs'

async function fixture(t, version = '0.2.0') {
  const root = await mkdtemp(join(tmpdir(), 'oc-chan-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'arm64')
  await mkdir(directory)
  const options = { version, tag: `v${version}`, inputs: { arm64: directory }, output: join(root, 'output') }
  const artifacts = []
  for (const extension of ['zip', 'dmg']) {
    const name = `OC-Chan-${version}-mac-arm64.${extension}`
    const content = Buffer.from(`package fixture ${version} ${extension}`)
    await writeFile(join(directory, name), content)
    artifacts.push({ name, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
  }
  await writeFile(join(directory, 'package-manifest-arm64.json'), JSON.stringify({ schema: 1, arch: 'arm64', artifacts }))
  await writeFile(join(directory, 'SHA256SUMS.txt'), artifacts.map(file => `${file.sha256}  ./${file.name}\n`).join(''))
  return options
}

async function changeManifest(options, change) {
  const path = join(options.inputs.arm64, 'package-manifest-arm64.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  change(manifest)
  await writeFile(path, JSON.stringify(manifest))
}

for (const version of ['0.2.0', '0.3.0-beta.1', '0.3.0-rc.2']) {
  test(`prepares complete arm64 assets without YAML: ${version}`, async t => {
    const options = await fixture(t, version)
    const result = await prepareRelease(options)
    assert.equal(result.files.length, 2)
    assert.deepEqual((await readdir(options.output)).sort(), ['SHA256SUMS.txt', ...result.files.map(file => file.name)].sort())
    for (const file of result.files) assert.deepEqual(await digestFile(join(options.output, file.name)), { size: file.size, sha256: file.sha256 })
    await assert.rejects(prepareRelease(options), { code: 'EEXIST' })
  })
}

const invalidCases = [
  ['wrong size', options => changeManifest(options, data => { data.artifacts[0].bytes += 1 }), /Size mismatch/],
  ['wrong manifest digest', options => changeManifest(options, data => { data.artifacts[0].sha256 = '0'.repeat(64) }), /Manifest SHA256 mismatch/],
  ['wrong architecture', options => changeManifest(options, data => { data.arch = 'x64' }), /Invalid package artifact manifest/],
  ['missing manifest artifact', options => changeManifest(options, data => { data.artifacts.pop() }), /Invalid package artifact manifest/],
  ['duplicate artifact', options => changeManifest(options, data => { data.artifacts[1] = data.artifacts[0] }), /duplicate package artifact/],
  ['wrong artifact version', options => changeManifest(options, data => { data.artifacts[0].name = 'OC-Chan-9.9.9-mac-arm64.zip' }), /Unexpected/],
  ['missing ZIP', options => rm(join(options.inputs.arm64, `OC-Chan-${options.version}-mac-arm64.zip`)), /ENOENT/],
  ['empty ZIP', options => writeFile(join(options.inputs.arm64, `OC-Chan-${options.version}-mac-arm64.zip`), ''), /Invalid release asset/],
  ['wrong tag', async options => { options.tag = 'v9.9.9' }, /must match package version/],
  ['unsupported input', async options => { options.inputs.x64 = options.inputs.arm64 }, /Unsupported release architecture/],
  ['missing input', async options => { delete options.inputs.arm64 }, /Missing arm64/],
  ['wrong SHA256', async options => {
    const path = join(options.inputs.arm64, 'SHA256SUMS.txt')
    await writeFile(path, (await readFile(path, 'utf8')).replace(/^[a-f0-9]{64}/, '0'.repeat(64)))
  }, /SHA256 mismatch/],
  ['missing checksum entry', async options => {
    const path = join(options.inputs.arm64, 'SHA256SUMS.txt')
    await writeFile(path, (await readFile(path, 'utf8')).split('\n')[0] + '\n')
  }, /Missing SHA256SUMS/],
  ['traversal checksum entry', async options => {
    const path = join(options.inputs.arm64, 'SHA256SUMS.txt')
    await writeFile(path, (await readFile(path, 'utf8')).replace('./OC-', '../OC-'))
  }, /Invalid SHA256SUMS/],
  ['symlink asset', async options => {
    const path = join(options.inputs.arm64, `OC-Chan-${options.version}-mac-arm64.zip`)
    await rm(path)
    await symlink(`OC-Chan-${options.version}-mac-arm64.dmg`, path)
  }, /Invalid release asset/],
]
for (const [name, mutate, expected] of invalidCases) {
  test(`rejects ${name} before producing release assets`, async t => {
    const options = await fixture(t)
    await mutate(options)
    await assert.rejects(prepareRelease(options), expected)
    await assert.rejects(stat(options.output), { code: 'ENOENT' })
  })
}

test('ZIP above the 512 MiB client limit is rejected before hashing or copying', async t => {
  const options = await fixture(t)
  const path = join(options.inputs.arm64, `OC-Chan-${options.version}-mac-arm64.zip`)
  await truncate(path, 512 * 1024 * 1024 + 1)
  await assert.rejects(inspectReleaseAssets(options.inputs.arm64, options.version), /exceeds size limit \(536870912 bytes\)/)
  await assert.rejects(prepareRelease(options), /exceeds size limit/)
  await assert.rejects(stat(options.output), { code: 'ENOENT' })
})

test('asset size limit includes its exact boundary', async t => {
  const options = await fixture(t)
  const path = join(options.inputs.arm64, `OC-Chan-${options.version}-mac-arm64.zip`)
  const content = await readFile(path)
  assert.deepEqual(await digestFile(path, content.length), { size: content.length, sha256: createHash('sha256').update(content).digest('hex') })
  await assert.rejects(digestFile(path, content.length - 1), /exceeds size limit/)
})

test('release versions and push tags are exact without signing credentials', () => {
  assert.equal(releaseInfo('1.2.3').prerelease, false)
  assert.equal(releaseInfo('1.2.3-beta.2').prerelease, true)
  for (const version of ['../bad', '1.2', 'v1.2.3', '1.2.3-01']) assert.throws(() => releaseInfo(version), /Invalid release version/)
  const info = releaseInfo('1.2.3')
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.3' }
  assert.throws(() => requireReleaseEnvironment(info, { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }), /tag push/)
  assert.throws(() => requireReleaseEnvironment(info, { ...env, GITHUB_REF: 'refs/tags/v1.2.4' }), /tag push/)
})

async function publication(t, version = '0.2.0', mutate = () => {}) {
  const options = await fixture(t, version)
  await prepareRelease(options)
  const assets = []
  for (const name of await readdir(options.output)) {
    const digest = await digestFile(join(options.output, name))
    assets.push({ name, size: digest.size, digest: `sha256:${digest.sha256}`, state: 'uploaded' })
  }
  const release = { tag_name: options.tag, draft: true, prerelease: releaseInfo(version).prerelease, assets }
  mutate(release)
  const calls = []
  const gh = args => {
    calls.push(args)
    if (args[0] === 'api') return JSON.stringify(args[1].includes('/releases/') ? release : { private: false })
    if (args[1] === 'view') return JSON.stringify({ databaseId: 42 })
    return ''
  }
  return { calls, run: () => publishRelease({ directory: options.output, version, tag: options.tag, env: { GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/tags/${options.tag}`, GITHUB_REPOSITORY: releaseRepository, GITHUB_TOKEN: 'test-token' }, gh }) }
}

for (const version of ['0.2.0', '0.3.0-beta.1']) {
  test(`publishes verified draft with correct latest policy: ${version}`, async t => {
    const { calls, run } = await publication(t, version)
    await run()
    const create = calls.find(args => args[1] === 'create')
    assert.ok(create.includes('--draft'))
    assert.ok(create.includes('--verify-tag'))
    assert.ok(create.includes('--latest=false'))
    assert.equal(create.includes('--prerelease'), releaseInfo(version).prerelease)
    assert.deepEqual(calls.at(-1), ['release', 'edit', `v${version}`, '--draft=false', `--prerelease=${releaseInfo(version).prerelease}`, `--latest=${!releaseInfo(version).prerelease}`])
    assert.ok(calls.findIndex(args => args[1] === 'upload') < calls.findIndex(args => args[1] === 'edit'))
  })
}

for (const [name, mutate] of [
  ['digest mismatch', release => { release.assets[0].digest = `sha256:${'0'.repeat(64)}` }],
  ['missing digest', release => { delete release.assets[0].digest }],
  ['size mismatch', release => { release.assets[0].size++ }],
  ['missing asset', release => { release.assets.pop() }],
  ['duplicate asset', release => { release.assets[1] = release.assets[0] }],
  ['incomplete upload', release => { release.assets[0].state = 'new' }],
  ['wrong tag', release => { release.tag_name = 'v9.9.9' }],
  ['not draft', release => { release.draft = false }],
]) {
  test(`never publishes draft with ${name}`, async t => {
    const { calls, run } = await publication(t, '0.2.0', mutate)
    await assert.rejects(run(), /release state|release upload/)
    assert.equal(calls.some(args => args[1] === 'edit'), false)
  })
}
