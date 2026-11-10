import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BUNDLE_ID, TARGET, boundedJson, buildEnvironment, developmentBundleLayout, digestFile, signingIdentity, tauriConfiguration, withBuildLock } from './build-app.mjs'
import { parseDistributionOptions, stableMetadata } from './dist.mjs'

async function fixture(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'oc-rust-build-')); t.after(() => rm(root, { recursive: true, force: true })); return root }

test('production builds strip development overrides and do not discover signing credentials', () => {
  const env = buildEnvironment({ resourcesDir: '/build/resources', targetDir: '/build/cargo', configuration: {} }, {
    HOME: '/user', OC_CHAN_HOME: '/fixtures', OC_CHAN_PROFILE: '/formal-profile', OC_CHAN_HEADLESS: '0', APPLE_ID: 'secret', APPLE_PASSWORD: 'secret', APPLE_CERTIFICATE: 'secret', TAURI_SIGNING_PRIVATE_KEY: 'secret'
  })
  assert.equal(env.HOME, '/user'); assert.equal(env.OC_CHAN_RESOURCE_DIR, '/build/resources'); assert.equal(env.APPLE_SIGNING_IDENTITY, '-')
  for (const key of ['OC_CHAN_HOME', 'OC_CHAN_PROFILE', 'OC_CHAN_HEADLESS', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_CERTIFICATE', 'TAURI_SIGNING_PRIVATE_KEY']) assert.equal(env[key], undefined)
  assert.throws(() => buildEnvironment({ configuration: {} }, { RUSTFLAGS: '--cfg feature="acceptance"' }), /acceptance/)
  assert.equal(signingIdentity({}), '-'); assert.throws(() => signingIdentity({ APPLE_SIGNING_IDENTITY: 'Apple Development: Someone' }), /Developer ID/)
})
test('Tauri maps isolated embedded frontend and resource roots without build recursion', () => {
  const config = tauriConfiguration('/instance/frontend', '/instance/resources', '-')
  assert.equal(config.build.frontendDist, '/instance/frontend'); assert.equal(config.build.beforeBuildCommand, '')
  assert.deepEqual(config.bundle.resources, { '/instance/resources/': '' }); assert.equal(config.bundle.createUpdaterArtifacts, false)
})
test('development bundle identity is legal, isolated per instance and stable on resume', () => {
  const instance = '/workspace/.dev-instances/instance-one', layout = developmentBundleLayout(instance)
  assert.equal(layout.application, path.join(instance, 'cargo', TARGET, 'debug/bundle/macos/OC Chan.app'))
  assert.equal(layout.binary, path.join(layout.application, 'Contents/MacOS/oc-chan'))
  assert.equal(layout.resourcesDir, path.join(layout.application, 'Contents/Resources'))
  assert.match(layout.identifier, /^local\.oc-chan\.desktop\.development\.i[a-f0-9]{24}$/)
  assert.notEqual(layout.identifier, BUNDLE_ID)
  assert.notEqual(layout.identifier, developmentBundleLayout(`${instance}-two`).identifier)
  assert.deepEqual(layout, developmentBundleLayout(instance))
  const config = tauriConfiguration('/frontend', '/resources', '-', { identifier: layout.identifier, infoPlist: '/instance/development.Info.plist' })
  assert.equal(config.identifier, layout.identifier); assert.equal(config.bundle.macOS.infoPlist, '/instance/development.Info.plist')
  assert.equal(config.bundle.macOS.signingIdentity, '-')
  const production = tauriConfiguration('/frontend', '/resources', '-')
  assert.equal(production.identifier, undefined); assert.equal(production.bundle.macOS.infoPlist, undefined)
})
test('build ownership excludes a concurrent builder and releases the exact lock', async t => {
  const resources = path.join(await fixture(t), 'resources')
  await withBuildLock(resources, async () => {
    await assert.rejects(withBuildLock(resources, async () => assert.fail('must not enter')), { code: 'EEXIST' })
  })
  await assert.rejects(lstat(path.join(path.dirname(resources), '.build-app.lock')), { code: 'ENOENT' })
})
test('build failure retains cleanup failure and never unlinks a replaced lock', async t => {
  const root = await fixture(t), lock = path.join(root, '.build-app.lock')
  await assert.rejects(withBuildLock(path.join(root, 'resources'), async () => {
    await rename(lock, `${lock}.displaced`); await writeFile(lock, 'other owner', { flag: 'wx' })
    throw new Error('original build failed')
  }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2)
    assert.match(error.errors[0].message, /original build failed/); assert.match(error.errors[1].message, /replaced/)
    return true
  })
  assert.ok((await lstat(lock)).isFile())
})
test('bounded reads and hashing reject symlinks and preflight file-size excess', async t => {
  const root = await fixture(t), file = path.join(root, 'input'); await writeFile(file, '{"value":1}')
  assert.deepEqual(await boundedJson(file, 32), { value: 1 })
  await assert.rejects(boundedJson(file, 4), /oversized/); await assert.rejects(digestFile(file, 'sha256', 4), /oversized/)
  const alias = path.join(root, 'alias'); await symlink(file, alias); await assert.rejects(boundedJson(alias)); await assert.rejects(digestFile(alias))
})
test('schema2 metadata uses fixed arm64 filename and canonical SHA512', () => {
  const digest = createHash('sha512').update('archive').digest('base64')
  assert.deepEqual(stableMetadata('1.2.3', { bytes: 7, digest }), { schema: 2, version: '1.2.3', assets: [{ target: ['darwin', 'aarch64'].join('-'), name: 'OC-Chan-1.2.3-mac-arm64.zip', size: 7, sha512: digest }] })
  for (const version of ['v1.2.3', '1.2.3-beta.1', '1.2.3+local', '01.2.3']) assert.throws(() => stableMetadata(version, { bytes: 7, digest }), /stable/)
  for (const bytes of [0, -1, 512 * 1024 * 1024 + 1, 1.5]) assert.throws(() => stableMetadata('1.2.3', { bytes, digest }), /size/)
  assert.throws(() => stableMetadata('1.2.3', { bytes: 7, digest: 'x'.repeat(88) }), /SHA-512/)
  assert.throws(() => parseDistributionOptions(['--x64']), /Usage/)
  assert.deepEqual(parseDistributionOptions(['--dir']), { directoryOnly: true })
})
