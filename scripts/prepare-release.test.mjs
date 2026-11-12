import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, stat, symlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareRelease } from './prepare-release.mjs'
import { stableMetadata } from './dist.mjs'
import { publicationInfo, releaseInfo, releaseRepository, requireReleaseEnvironment, signingSecrets } from './release-config.mjs'

const previewEnv = { GITHUB_REPOSITORY: releaseRepository, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: `abcdef0${'1'.repeat(33)}`, GITHUB_RUN_NUMBER: '42' }

async function fixture(t, version = '0.2.0', preview = false) {
  const root = await mkdtemp(join(tmpdir(), 'oc-chan-release-')); t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'arm64'); await mkdir(directory)
  const env = preview ? { ...previewEnv } : { GITHUB_REPOSITORY: releaseRepository, GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/tags/v${version}` }
  const info = publicationInfo(version, env), options = { version, tag: info.tag, env, inputs: { arm64: directory }, output: join(root, 'output'), info }, sums = []
  const manifest = { schema: 2, arch: 'arm64', version, artifacts: {} }
  for (const extension of ['zip', 'dmg']) {
    const name = `OC-Chan-${version}-mac-arm64.${extension}`, content = Buffer.from(`release unit fixture ${version} ${extension}`)
    await writeFile(join(directory, name), content)
    manifest.artifacts[extension] = { path: `/build/runner/release/${name}`, bytes: content.length, digest: createHash(extension === 'zip' ? 'sha512' : 'sha256').update(content).digest(extension === 'zip' ? 'base64' : 'hex') }
    sums.push(`${createHash('sha256').update(content).digest('hex')}  ./${name}`)
    if (extension === 'zip') await writeFile(join(directory, info.metadataName), JSON.stringify(stableMetadata(version, { bytes: content.length, digest: createHash('sha512').update(content).digest('base64') })))
  }
  await writeFile(join(directory, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)
  await writeFile(join(directory, 'package-manifest-arm64.json'), JSON.stringify(manifest))
  return options
}
async function changeMetadata(options, change) {
  const filename = join(options.inputs.arm64, options.info.metadataName), metadata = JSON.parse(await readFile(filename, 'utf8'))
  change(metadata); await writeFile(filename, JSON.stringify(metadata))
}
async function changeManifest(options, change) {
  const filename = join(options.inputs.arm64, 'package-manifest-arm64.json'), manifest = JSON.parse(await readFile(filename, 'utf8'))
  change(manifest); await writeFile(filename, JSON.stringify(manifest))
}
test('publishes one schema2 ZIP declaration and both bounded installer attachments', async t => {
  const options = await fixture(t), metadata = await prepareRelease(options)
  assert.deepEqual(metadata, JSON.parse(await readFile(join(options.output, 'latest.json'), 'utf8')))
  assert.deepEqual(Object.keys(metadata).sort(), ['assets', 'schema', 'version'])
  assert.equal(metadata.assets.length, 1); assert.equal(metadata.assets[0].target, ['darwin', 'aarch64'].join('-'))
  for (const extension of ['zip', 'dmg']) {
    const name = `OC-Chan-${options.version}-mac-arm64.${extension}`
    assert.deepEqual(await readFile(join(options.output, name)), await readFile(join(options.inputs.arm64, name)))
    assert.ok((await readFile(join(options.output, 'SHA256SUMS.txt'), 'utf8')).includes(`  ${name}\n`))
  }
  await assert.rejects(prepareRelease(options), { code: 'EEXIST' })
})
test('preview copies exactly three verified attachments without stable update metadata', async t => {
  const options = await fixture(t, '0.2.0', true)
  await prepareRelease(options)
  const names = ['OC-Chan-0.2.0-mac-arm64.dmg', 'OC-Chan-0.2.0-mac-arm64.zip']
  assert.deepEqual((await readdir(options.output)).sort(), [...names, 'SHA256SUMS.txt'].sort())
  const checksums = await readFile(join(options.output, 'SHA256SUMS.txt'), 'utf8')
  for (const name of names) {
    const content = await readFile(join(options.output, name))
    assert.deepEqual(content, await readFile(join(options.inputs.arm64, name)))
    assert.ok(checksums.includes(`${createHash('sha256').update(content).digest('hex')}  ${name}\n`))
  }
  await assert.rejects(stat(join(options.output, 'latest.json')), { code: 'ENOENT' })
  await assert.rejects(prepareRelease(options), { code: 'EEXIST' })
})
const invalidCases = [
  ['wrong version', options => changeMetadata(options, data => { data.version = '9.9.9' }), /version/],
  ['unknown root field', options => changeMetadata(options, data => { data.files = [] }), /fields/],
  ['unknown asset field', options => changeMetadata(options, data => { data.assets[0].url = 'https://example.invalid' }), /strict/],
  ['wrong schema', options => changeMetadata(options, data => { data.schema = 1 }), /schema2/],
  ['wrong architecture', options => changeMetadata(options, data => { data.assets[0].target = 'windows-x86_64' }), /target/],
  ['wrong SHA512', options => changeMetadata(options, data => { data.assets[0].sha512 = 'incorrect' }), /SHA512 mismatch/],
  ['wrong size', options => changeMetadata(options, data => { data.assets[0].size++ }), /size or SHA512/],
  ['missing ZIP', options => rm(join(options.inputs.arm64, `OC-Chan-${options.version}-mac-arm64.zip`)), /ENOENT/],
  ['missing metadata', options => rm(join(options.inputs.arm64, 'latest.json')), /ENOENT/],
  ['missing metadata asset', options => changeMetadata(options, data => { data.assets.pop() }), /exactly one/],
  ['duplicate metadata asset', options => changeMetadata(options, data => { data.assets.push(data.assets[0]) }), /exactly one/],
  ['path traversal', options => changeMetadata(options, data => { data.assets[0].name = '../unexpected.zip' }), /filename/],
  ['wrong tag', async options => { options.tag = 'v9.9.9' }, /must match package version/],
  ['unsupported architecture input', async options => { options.inputs.x64 = options.inputs.arm64 }, /exactly the arm64/],
  ['wrong SHA256', async options => { const filename = join(options.inputs.arm64, 'SHA256SUMS.txt'); await writeFile(filename, (await readFile(filename, 'utf8')).replace(/^[a-f0-9]{64}/, '0'.repeat(64))) }, /SHA256 mismatch/],
  ['missing checksum entry', async options => { const filename = join(options.inputs.arm64, 'SHA256SUMS.txt'); await writeFile(filename, `${(await readFile(filename, 'utf8')).split('\n')[0]}\n`) }, /Missing SHA256SUMS/],
  ['duplicate checksum entry', async options => { const filename = join(options.inputs.arm64, 'SHA256SUMS.txt'), text = await readFile(filename, 'utf8'); await writeFile(filename, text + text.split('\n')[0] + '\n') }, /duplicate SHA256SUMS/],
  ['oversized checksums', options => writeFile(join(options.inputs.arm64, 'SHA256SUMS.txt'), ' '.repeat(64 * 1024 + 1)), /budget/],
  ['oversized metadata', options => writeFile(join(options.inputs.arm64, 'latest.json'), ' '.repeat(64 * 1024 + 1)), /budget/],
  ['oversized sparse asset', options => truncate(join(options.inputs.arm64, `OC-Chan-${options.version}-mac-arm64.zip`), 512 * 1024 * 1024 + 1), /512MiB/],
  ['oversized sparse DMG', options => truncate(join(options.inputs.arm64, `OC-Chan-${options.version}-mac-arm64.dmg`), 512 * 1024 * 1024 + 1), /512MiB/],
  ['symlink asset', async options => { const filename = join(options.inputs.arm64, `OC-Chan-${options.version}-mac-arm64.zip`); await rm(filename); await symlink(`OC-Chan-${options.version}-mac-arm64.dmg`, filename) }, /ELOOP/]
]
for (const [name, mutate, expected] of invalidCases) test(`rejects ${name} before creating output`, async t => {
  const options = await fixture(t); await mutate(options)
  await assert.rejects(prepareRelease(options), expected); await assert.rejects(stat(options.output), { code: 'ENOENT' })
})
const invalidManifestCases = [
  ['missing report', options => rm(join(options.inputs.arm64, 'package-manifest-arm64.json')), /ENOENT/],
  ['old schema', options => changeManifest(options, data => { data.schema = 1 }), /schema2/],
  ['wrong architecture', options => changeManifest(options, data => { data.arch = 'x64' }), /arm64/],
  ['wrong version', options => changeManifest(options, data => { data.version = '9.9.9' }), /version/],
  ['missing artifacts', options => changeManifest(options, data => { delete data.artifacts }), /artifact manifest/],
  ['old artifact array', options => changeManifest(options, data => { data.artifacts = Object.values(data.artifacts) }), /artifact manifest/],
  ['unexpected attachment', options => changeManifest(options, data => { data.artifacts.exe = data.artifacts.zip }), /artifact manifest/],
  ['oversized report', options => writeFile(join(options.inputs.arm64, 'package-manifest-arm64.json'), ' '.repeat(16 * 1024 * 1024 + 1)), /budget/],
]
for (const extension of ['zip', 'dmg']) {
  invalidManifestCases.push(
    [`missing ${extension} declaration`, options => changeManifest(options, data => { delete data.artifacts[extension] }), /artifact manifest/],
    [`null ${extension} declaration`, options => changeManifest(options, data => { data.artifacts[extension] = null }), /filename mismatch/],
    [`wrong ${extension} filename`, options => changeManifest(options, data => { data.artifacts[extension].path = `/build/runner/OC-Chan-${options.version}-mac-x64.${extension}` }), /filename mismatch/],
    [`missing ${extension} path`, options => changeManifest(options, data => { delete data.artifacts[extension].path }), /filename mismatch/],
    [`wrong ${extension} size`, options => changeManifest(options, data => { data.artifacts[extension].bytes++ }), /size mismatch/],
    [`missing ${extension} digest`, options => changeManifest(options, data => { delete data.artifacts[extension].digest }), /SHA(?:256|512) mismatch/],
    [`wrong ${extension} digest`, options => changeManifest(options, data => { data.artifacts[extension].digest = 'incorrect' }), /SHA(?:256|512) mismatch/],
  )
}
for (const preview of [false, true]) {
  for (const [name, mutate, expected] of invalidManifestCases) test(`${preview ? 'preview' : 'stable'} rejects package manifest ${name} before creating output`, async t => {
    const options = await fixture(t, '0.2.0', preview); await mutate(options)
    await assert.rejects(prepareRelease(options), expected)
    await assert.rejects(stat(options.output), { code: 'ENOENT' })
  })
}
test('preview still rejects tampered metadata SHA512 before creating output', async t => {
  const options = await fixture(t, '0.2.0', true)
  await changeMetadata(options, data => { data.assets[0].sha512 = 'incorrect' })
  await assert.rejects(prepareRelease(options), /SHA512 mismatch/)
  await assert.rejects(stat(options.output), { code: 'ENOENT' })
})
test('only strict stable semantic versions produce latest.json', () => {
  assert.deepEqual(releaseInfo('1.2.3'), { version: '1.2.3', tag: 'v1.2.3', metadataName: 'latest.json' })
  for (const version of ['../bad', '1.2', 'v1.2.3', '01.2.3', '1.2.3-beta.2', '1.2.3+build', '18446744073709551616.0.0']) assert.throws(() => releaseInfo(version), /strict stable/)
})
test('signed release preflight binds the push tag, exact Developer ID team and all Tauri secrets', () => {
  const info = releaseInfo('1.2.3'), env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.3', ...Object.fromEntries(signingSecrets.map(name => [name, 'present'])), APPLE_TEAM_ID: 'ABCDE12345', APPLE_SIGNING_IDENTITY: 'Developer ID Application: Fixture (ABCDE12345)' }
  assert.doesNotThrow(() => requireReleaseEnvironment(info, env))
  for (const name of signingSecrets) assert.throws(() => requireReleaseEnvironment(info, { ...env, [name]: '' }), new RegExp(name))
  assert.throws(() => requireReleaseEnvironment(info, { ...env, APPLE_SIGNING_IDENTITY: 'Developer ID Application: Other (AAAAA99999)' }), /APPLE_SIGNING_IDENTITY/)
  assert.throws(() => requireReleaseEnvironment(info, { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }), /tag push/)
  assert.throws(() => requireReleaseEnvironment(info, { ...env, GITHUB_REF: 'refs/tags/v1.2.4' }), /tag push/)
})

test('publication channels bind exact source, commit and canonical bounded run number', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    assert.deepEqual(publicationInfo('1.2.3', { ...previewEnv, GITHUB_EVENT_NAME: event }), { ...releaseInfo('1.2.3'), tag: 'preview-42-abcdef0', prerelease: true, commit: previewEnv.GITHUB_SHA })
  }
  assert.deepEqual(publicationInfo('1.2.3', { ...previewEnv, GITHUB_REF: 'refs/tags/v1.2.3' }), { ...releaseInfo('1.2.3'), prerelease: false })
  assert.equal(publicationInfo('1.2.3', { ...previewEnv, GITHUB_RUN_NUMBER: String(Number.MAX_SAFE_INTEGER) }).tag, 'preview-9007199254740991-abcdef0')
  for (const run of [undefined, '', '0', '01', '-1', '1.5', '1e3', ' 1', '1\n', 1, '9007199254740992', '9'.repeat(100)]) {
    assert.throws(() => publicationInfo('1.2.3', { ...previewEnv, GITHUB_RUN_NUMBER: run }), /GITHUB_RUN_NUMBER/)
  }
  for (const sha of [undefined, '', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), `${previewEnv.GITHUB_SHA}\n`]) {
    assert.throws(() => publicationInfo('1.2.3', { ...previewEnv, GITHUB_SHA: sha }), /GITHUB_SHA/)
  }
  for (const version of ['01.2.3', '1.2.3-beta.1', '1.2.3+build', '1.2.3\n', '18446744073709551616.0.0']) assert.throws(() => publicationInfo(version, previewEnv), /strict stable/)
  for (const overrides of [
    { GITHUB_REPOSITORY: 'fork/oc-chan' }, { GITHUB_REPOSITORY: undefined },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REF: 'refs/tags/v1.2.4' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/tags/v1.2.3' },
  ]) assert.throws(() => publicationInfo('1.2.3', { ...previewEnv, ...overrides }), /Publishing requires/)
})
