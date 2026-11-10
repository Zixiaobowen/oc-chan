import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareRelease } from './prepare-release.mjs'
import { stableMetadata } from './dist.mjs'
import { releaseInfo, requireReleaseEnvironment, signingSecrets } from './release-config.mjs'

async function fixture(t, version = '0.2.0') {
  const root = await mkdtemp(join(tmpdir(), 'oc-chan-release-')); t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'arm64'); await mkdir(directory)
  const info = releaseInfo(version), options = { version, tag: info.tag, inputs: { arm64: directory }, output: join(root, 'output'), info }, sums = []
  for (const extension of ['zip', 'dmg']) {
    const name = `OC-Chan-${version}-mac-arm64.${extension}`, content = Buffer.from(`release unit fixture ${version} ${extension}`)
    await writeFile(join(directory, name), content)
    sums.push(`${createHash('sha256').update(content).digest('hex')}  ./${name}`)
    if (extension === 'zip') await writeFile(join(directory, info.metadataName), JSON.stringify(stableMetadata(version, { bytes: content.length, digest: createHash('sha512').update(content).digest('base64') })))
  }
  await writeFile(join(directory, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)
  return options
}
async function changeMetadata(options, change) {
  const filename = join(options.inputs.arm64, options.info.metadataName), metadata = JSON.parse(await readFile(filename, 'utf8'))
  change(metadata); await writeFile(filename, JSON.stringify(metadata))
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
  ['oversized metadata', options => writeFile(join(options.inputs.arm64, 'latest.json'), ' '.repeat(64 * 1024 + 1)), /budget/],
  ['oversized sparse asset', options => truncate(join(options.inputs.arm64, `OC-Chan-${options.version}-mac-arm64.zip`), 512 * 1024 * 1024 + 1), /512MiB/],
  ['symlink asset', async options => { const filename = join(options.inputs.arm64, `OC-Chan-${options.version}-mac-arm64.zip`); await rm(filename); await symlink(`OC-Chan-${options.version}-mac-arm64.dmg`, filename) }, /ELOOP/]
]
for (const [name, mutate, expected] of invalidCases) test(`rejects ${name} before creating output`, async t => {
  const options = await fixture(t); await mutate(options)
  await assert.rejects(prepareRelease(options), expected); await assert.rejects(stat(options.output), { code: 'ENOENT' })
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
