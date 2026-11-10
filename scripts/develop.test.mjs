import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ROOT, TARGET, developmentBundleLayout, digestFile } from './build-app.mjs'
import { developmentEnvironment, developmentOptions, loadDevelopmentBuild, observeGroup, parseProcesses } from './develop.mjs'

const birth = 'Tue Nov 10 10:00:00 2026', changed = 'Tue Nov 10 10:01:00 2026'
test('development defaults to headless isolated profile and explicit window opt-in', () => {
  const options = developmentOptions([]), env = developmentEnvironment('/workspace/.dev-instances/instance-one', options, { HOME: '/user', OC_CHAN_HOME: '/acceptance-home' })
  assert.equal(env.OC_CHAN_HEADLESS, '1'); assert.equal(env.OC_CHAN_PROFILE, '/workspace/.dev-instances/instance-one/profile')
  assert.equal(env.OC_CHAN_RESOURCE_DIR, '/workspace/.dev-instances/instance-one/resources'); assert.equal(env.HOME, '/user'); assert.equal(env.OC_CHAN_HOME, '/acceptance-home')
  assert.equal(developmentEnvironment('/instance', developmentOptions(['--window', '--no-cleanup']), {}).OC_CHAN_HEADLESS, '0')
  assert.equal(developmentOptions(['--no-cleanup']).cleanup, false)
  assert.throws(() => developmentOptions(['--inspect']), /Usage/)
  assert.throws(() => developmentEnvironment('/instance', options, { OC_CHAN_HOME: '../home' }), /absolute/)
})
test('observed descendant births survive parent exit without accepting unrelated PIDs', () => {
  const known = new Map(), start = Date.parse(birth)
  observeGroup([{ pid: 100, parent: 1, group: 100, birth }, { pid: 101, parent: 100, group: 100, birth }], 100, known, start)
  assert.equal(observeGroup([{ pid: 101, parent: 1, group: 100, birth }], 100, known, start).length, 1)
  assert.throws(() => observeGroup([{ pid: 101, parent: 1, group: 100, birth: changed }], 100, known, start), /reused/)
  assert.throws(() => observeGroup([{ pid: 200, parent: 1, group: 100, birth }], 100, known, start), /Cannot prove/)
  assert.deepEqual(observeGroup([{ pid: 300, parent: 1, group: 300, birth }], 100, known, start), [])
})
test('owned workers remain tracked after creating process groups and losing their parent', () => {
  const known = new Map(), start = Date.parse(birth)
  const initial = [{ pid: 100, parent: 1, group: 100, birth }, { pid: 101, parent: 100, group: 101, birth }, { pid: 102, parent: 101, group: 102, birth }, { pid: 300, parent: 1, group: 300, birth }]
  assert.deepEqual(observeGroup(initial, 100, known, start).map(row => row.pid), [100, 101, 102])
  assert.deepEqual(observeGroup([{ pid: 102, parent: 1, group: 102, birth }], 100, known, start).map(row => row.pid), [102])
  assert.throws(() => observeGroup([{ pid: 102, parent: 1, group: 102, birth: changed }], 100, known, start), /reused/)
})
test('unobserved orphan groups cannot authorize termination or directory deletion', () => {
  assert.throws(() => observeGroup([{ pid: 101, parent: 1, group: 100, birth }], 100, new Map(), Date.parse(birth)), /Cannot prove/)
  assert.throws(() => observeGroup([{ pid: 100, parent: 1, group: 100, birth }], 100, new Map(), Date.parse(changed)), /reused/)
})
test('process table parsing retains parent group and exact birth identity', () => {
  assert.deepEqual(parseProcesses(` 100 1 100 ${birth}\n 101 100 100 ${birth}\n`), [{ pid: 100, parent: 1, group: 100, birth }, { pid: 101, parent: 100, group: 100, birth }])
  assert.throws(() => parseProcesses('unexpected output'), /Invalid/)
})

async function bundleFixture(t) {
  const instance = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oc-development-receipt-')))
  t.after(() => rm(instance, { recursive: true, force: true }))
  const layout = developmentBundleLayout(instance), plist = path.join(layout.application, 'Contents/Info.plist')
  await mkdir(path.dirname(layout.binary), { recursive: true }); await mkdir(layout.resourcesDir, { recursive: true })
  await writeFile(layout.binary, 'unit-test executable bytes'); await writeFile(plist, 'unit-test plist bytes')
  const resources = {}
  for (const name of ['oc-data-worker', 'oc-installer', 'tern-navigation/present-window', 'tern-navigation/plugin/plugin.toml', 'tern-navigation/plugin/window.luau', 'plugin-market/catalog.json', 'rust-dependencies/manifest.json']) {
    const filename = path.join(layout.resourcesDir, name)
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, name)
    resources[name] = await digestFile(filename)
  }
  const record = { schema: 2, root: ROOT, mode: 'development', arch: 'arm64', target: TARGET, sign: '-', version: '0.1.0',
    features: ['acceptance', 'custom-protocol'], targetDir: path.join(instance, 'cargo'), binary: layout.binary,
    binaryIdentity: await digestFile(layout.binary), resources, catalogSha256: resources['plugin-market/catalog.json'].digest,
    developmentBundle: { ...layout, infoPlistIdentity: await digestFile(plist) } }
  const save = () => writeFile(path.join(instance, 'build.json'), JSON.stringify(record))
  await save()
  const plistFields = { CFBundleIdentifier: layout.identifier, CFBundleExecutable: 'oc-chan', CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', LSUIElement: true }
  const calls = [], command = async (file, args) => {
    calls.push({ file, args })
    if (file === '/usr/bin/plutil') return { stdout: JSON.stringify(plistFields) }
    assert.equal(file, '/usr/bin/codesign'); assert.deepEqual(args, ['--verify', '--deep', '--strict', layout.application])
    return { stdout: '' }
  }
  return { instance, layout, record, plist, plistFields, save, calls, command }
}
test('development receipts reject release features and bare executable paths', async t => {
  const f = await bundleFixture(t)
  f.record.features = ['custom-protocol']; await f.save()
  await assert.rejects(loadDevelopmentBuild(f.instance, f.command), /Invalid isolated/)
  f.record.features = ['acceptance', 'custom-protocol']; f.record.binary = path.join(f.instance, 'cargo', TARGET, 'debug/oc-chan'); await f.save()
  await assert.rejects(loadDevelopmentBuild(f.instance, f.command), /real isolated application/)
  assert.equal(f.calls.length, 0)
})
test('resume rejects changed binary, plist and bundled resources before launch', async t => {
  for (const leaf of ['binary', 'plist', 'resource']) {
    const f = await bundleFixture(t)
    const filename = leaf === 'binary' ? f.layout.binary : leaf === 'plist' ? f.plist : path.join(f.layout.resourcesDir, 'oc-data-worker')
    await writeFile(filename, 'modified after build')
    await assert.rejects(loadDevelopmentBuild(f.instance, f.command), /differs from its build receipt/)
    assert.equal(f.calls.some(call => call.file === '/usr/bin/codesign'), false)
  }
})
test('development launch rejects wrong bundle identity, Dock flag and signature failures', async t => {
  const f = await bundleFixture(t)
  f.plistFields.CFBundleIdentifier = 'local.oc-chan.desktop'
  await assert.rejects(loadDevelopmentBuild(f.instance, f.command), /Info.plist/)
  f.plistFields.CFBundleIdentifier = f.layout.identifier; f.plistFields.LSUIElement = false
  await assert.rejects(loadDevelopmentBuild(f.instance, f.command), /Info.plist/)
  f.plistFields.LSUIElement = true
  await assert.rejects(loadDevelopmentBuild(f.instance, async (file, args) => {
    if (file === '/usr/bin/codesign') throw new Error('signature rejected')
    return f.command(file, args)
  }), /signature rejected/)
})
test('development bundle resource symlinks cannot bypass the receipt', async t => {
  const f = await bundleFixture(t), filename = path.join(f.layout.resourcesDir, 'oc-data-worker'), outside = path.join(f.instance, 'other-worker')
  await writeFile(outside, 'oc-data-worker'); await rm(filename); await symlink(outside, filename)
  await assert.rejects(loadDevelopmentBuild(f.instance, f.command), /escaped its owned path/)
})
