import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import yaml from 'js-yaml'
import { prepareRelease } from './prepare-release.mjs'
import { releaseInfo, requireReleaseEnvironment, signingSecrets } from './release-config.mjs'

async function fixture(t, version = '0.2.0') {
  const root = await mkdtemp(join(tmpdir(), 'oc-chan-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const info = releaseInfo(version)
  const options = { version, tag: info.tag, inputs: {}, output: join(root, 'output') }
  for (const arch of ['arm64']) {
    const directory = join(root, arch)
    await mkdir(directory)
    options.inputs[arch] = directory
    const files = []
    const sums = []
    for (const extension of ['zip', 'dmg']) {
      const url = `OC-Chan-${version}-mac-${arch}.${extension}`
      const content = Buffer.from(`signed package fixture ${version} ${arch} ${extension}`)
      await writeFile(join(directory, url), content)
      files.push({ url, size: content.length, sha512: createHash('sha512').update(content).digest('base64') })
      sums.push(`${createHash('sha256').update(content).digest('hex')}  ./${url}`)
    }
    await writeFile(join(directory, info.metadataName), yaml.dump({ version, files, path: files[0].url, sha512: files[0].sha512, releaseDate: '2026-11-05T00:00:00.000Z' }))
    await writeFile(join(directory, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)
  }
  return { ...options, info }
}

async function changeMetadata(options, arch, change) {
  const path = join(options.inputs[arch], options.info.metadataName)
  const metadata = yaml.load(await readFile(path, 'utf8'))
  change(metadata)
  await writeFile(path, yaml.dump(metadata))
}

for (const version of ['0.2.0', '0.3.0-beta.1', '0.3.0-rc.2']) {
  test(`prepares the supported arm64 ZIP and DMG: ${version}`, async t => {
    const options = await fixture(t, version)
    const metadata = await prepareRelease(options)
    assert.deepEqual(metadata.files.map(file => file.url).sort(), [`OC-Chan-${version}-mac-arm64.dmg`, `OC-Chan-${version}-mac-arm64.zip`])
    assert.match(metadata.path, /-arm64\.zip$/)
    const output = yaml.load(await readFile(join(options.output, options.info.metadataName), 'utf8'))
    assert.deepEqual(output, metadata)
    for (const file of metadata.files) assert.equal((await stat(join(options.output, file.url))).size, file.size)
    const checksums = await readFile(join(options.output, 'SHA256SUMS.txt'), 'utf8')
    for (const file of metadata.files) assert.ok(checksums.includes(`  ${file.url}\n`))
    if (options.info.prerelease) await assert.rejects(stat(join(options.output, 'latest-mac.yml')), { code: 'ENOENT' })
    await assert.rejects(prepareRelease(options), { code: 'EEXIST' })
  })
}

const invalidCases = [
  ['wrong version', options => changeMetadata(options, 'arm64', data => { data.version = '9.9.9' }), /Wrong metadata version/],
  ['wrong architecture', options => changeMetadata(options, 'arm64', data => { data.files[0].url = data.files[0].url.replace('arm64', 'x64') }), /Wrong architecture/],
  ['wrong SHA512', options => changeMetadata(options, 'arm64', data => { data.files[0].sha512 = 'incorrect' }), /SHA512 mismatch/],
  ['wrong size', options => changeMetadata(options, 'arm64', data => { data.files[0].size += 1 }), /Size mismatch/],
  ['missing ZIP', options => rm(join(options.inputs.arm64, `OC-Chan-${options.version}-mac-arm64.zip`)), /ENOENT/],
  ['missing metadata file', options => rm(join(options.inputs.arm64, options.info.metadataName)), /ENOENT/],
  ['missing metadata entry', options => changeMetadata(options, 'arm64', data => { data.files.pop() }), /Expected ZIP and DMG/],
  ['duplicate metadata entry', options => changeMetadata(options, 'arm64', data => { data.files[1] = data.files[0] }), /duplicate metadata asset/],
  ['path traversal', options => changeMetadata(options, 'arm64', data => { data.files[0].url = '../unexpected.zip' }), /Wrong architecture/],
  ['wrong primary ZIP', options => changeMetadata(options, 'arm64', data => { data.path = data.files[1].url }), /Invalid primary ZIP/],
  ['wrong tag', async options => { options.tag = 'v9.9.9' }, /must match package version/],
  ['wrong SHA256', async options => {
    const path = join(options.inputs.arm64, 'SHA256SUMS.txt')
    await writeFile(path, (await readFile(path, 'utf8')).replace(/^[a-f0-9]{64}/, '0'.repeat(64)))
  }, /SHA256 mismatch/],
]
for (const [name, mutate, expected] of invalidCases) {
  test(`rejects ${name} before producing release assets`, async t => {
    const options = await fixture(t)
    await mutate(options)
    await assert.rejects(prepareRelease(options), expected)
    await assert.rejects(stat(options.output), { code: 'ENOENT' })
  })
}

test('stable and prerelease channels cannot collide', () => {
  assert.equal(releaseInfo('1.2.3').metadataName, 'latest-mac.yml')
  assert.equal(releaseInfo('1.2.3-beta.2').metadataName, 'beta-mac.yml')
  assert.throws(() => releaseInfo('1.2.3-latest.1'), /must not be latest/)
  for (const version of ['../bad', '1.2', 'v1.2.3', '1.2.3-01']) assert.throws(() => releaseInfo(version), /Invalid release version/)
})

for (const version of ['1.2.3+local.7', '1.2.3+001', '1.2.3-beta.2+local.7', '1.2.3-rc.1+build-7']) {
  test(`rejects unsupported build metadata before preparing release assets: ${version}`, async t => {
    const expected = /Release build metadata is not supported by builder artifact names or the stable update feed/
    assert.throws(() => releaseInfo(version), expected)
    const options = await fixture(t)
    await assert.rejects(prepareRelease({ ...options, version, tag: `v${version}` }), expected)
    await assert.rejects(stat(options.output), { code: 'ENOENT' })
  })
}

test('signed release preflight requires matching push tag and every secret', () => {
  const info = releaseInfo('1.2.3')
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.3', ...Object.fromEntries(signingSecrets.map(name => [name, 'present'])), APPLE_TEAM_ID: 'ABCDE12345' }
  assert.doesNotThrow(() => requireReleaseEnvironment(info, env))
  for (const name of signingSecrets) assert.throws(() => requireReleaseEnvironment(info, { ...env, [name]: '' }), new RegExp(name))
  assert.throws(() => requireReleaseEnvironment(info, { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }), /tag push/)
  assert.throws(() => requireReleaseEnvironment(info, { ...env, GITHUB_REF: 'refs/tags/v1.2.4' }), /tag push/)
})
