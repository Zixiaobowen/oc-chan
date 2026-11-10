import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { forbiddenPackagePath, inspectBuildMarkers, inspectExecutable, inspectTree, validatePlist, validateRustLegalManifest, validateFrozenBudgets } from './check-package.mjs'
import { RUST_ROOTS, RUST_TARGET } from './rust-dependencies.mjs'

async function fixture(t) { const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oc-rust-package-'))); t.after(() => rm(root, { recursive: true, force: true })); return root }
function macho(cpu = 0x0100000c, type = 2) { const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(cpu, 4); bytes.writeUInt32LE(type, 12); bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(32, 20); return bytes }
const pin = 'a'.repeat(64)

test('production pin scanning spans stream boundaries and excludes acceptance code', async t => {
  const root = await fixture(t), binary = path.join(root, 'host')
  await writeFile(binary, Buffer.concat([Buffer.alloc(64 * 1024 - 12), Buffer.from(`OC_CHAN_CATALOG_SHA256=${pin}\0`)]))
  await inspectBuildMarkers(binary, pin)
  await assert.rejects(inspectBuildMarkers(binary, 'b'.repeat(64)), /catalog pin/)
  await writeFile(binary, Buffer.concat([Buffer.from(`OC_CHAN_CATALOG_SHA256=${pin}`), Buffer.alloc(64 * 1024 - 100), Buffer.from('OC_CHAN_ACCEPTANCE_DRIVER_V1')]))
  await assert.rejects(inspectBuildMarkers(binary, pin), /Acceptance driver/)
})
test('production binary rejects each acceptance-only WebKit process selector across a stream boundary', async t => {
  const binary = path.join(await fixture(t), 'host')
  for (const marker of ['_webProcessIdentifier', '_provisionalWebProcessIdentifier', '_gpuProcessIdentifier', '_networkProcessIdentifier']) {
    await writeFile(binary, Buffer.concat([Buffer.from(`OC_CHAN_CATALOG_SHA256=${pin}`), Buffer.alloc(64 * 1024 - 90), Buffer.from(marker)]))
    await assert.rejects(inspectBuildMarkers(binary, pin), /private WebKit selector/)
  }
})
test('a second different catalog marker fails closed', async t => {
  const binary = path.join(await fixture(t), 'host')
  await writeFile(binary, `OC_CHAN_CATALOG_SHA256=${pin}\0OC_CHAN_CATALOG_SHA256=${'b'.repeat(64)}`)
  await assert.rejects(inspectBuildMarkers(binary, pin), /catalog pin/)
})
test('only executable thin arm64 Mach-O passes the static architecture gate', async t => {
  const binary = path.join(await fixture(t), 'host'); await writeFile(binary, macho(), { mode: 0o755 })
  assert.equal(await inspectExecutable(binary), 64)
  await writeFile(binary, macho(0x01000007)); await assert.rejects(inspectExecutable(binary), /arm64/)
  await writeFile(binary, macho(0x0100000c, 6)); await assert.rejects(inspectExecutable(binary), /MH_EXECUTE/)
  await writeFile(binary, macho()); await chmod(binary, 0o600); await assert.rejects(inspectExecutable(binary), /mode/)
})
test('bundle identity and semantic version are tied to the Rust build', () => {
  const plist = { CFBundleIdentifier: 'local.oc-chan.desktop', CFBundlePackageType: 'APPL', CFBundleExecutable: 'oc-chan', CFBundleShortVersionString: '1.2.3' }
  validatePlist(plist, '1.2.3')
  assert.throws(() => validatePlist({ ...plist, CFBundleIdentifier: 'local.other' }, '1.2.3'), /identity/)
  assert.throws(() => validatePlist(plist, '1.2.4'), /version/)
})
test('inventory records content digests and rejects external links and hardlinks', async t => {
  const root = await fixture(t), app = path.join(root, 'OC Chan.app'); await mkdir(app)
  const file = path.join(app, 'payload'); await writeFile(file, 'sealed')
  const tree = await inspectTree(app)
  assert.equal(tree.entries[0].sha256, createHash('sha256').update('sealed').digest('hex'))
  await symlink('../outside', path.join(app, 'escape')); await writeFile(path.join(root, 'outside'), 'outside')
  await assert.rejects(inspectTree(app), /escapes/)
  await rm(path.join(app, 'escape')); await link(file, path.join(app, 'hardlink'))
  await assert.rejects(inspectTree(app), /Invalid package file/)
})
test('production inventory excludes Node Electron and test artifacts by path', async t => {
  for (const name of ['Contents/Frameworks/Electron Framework.framework/Electron Framework', 'Contents/Resources/node_modules/a/index.js', 'Contents/Resources/test/driver.js', 'Contents/Resources/a.node', 'Contents/Resources/app.asar', 'Contents/Resources/fixture/data.db']) assert.equal(forbiddenPackagePath(name), true, name)
  assert.equal(forbiddenPackagePath('Contents/Resources/tern-navigation/plugin/window.luau'), false)
  const app = await fixture(t); await mkdir(path.join(app, 'node_modules')); await writeFile(path.join(app, 'node_modules/package.json'), '{}')
  await assert.rejects(inspectTree(app), /Forbidden/)
})

test('packaged Cargo license inventory binds lock, provenance, flattened paths and every actual digest', () => {
  const source = 'registry+https://github.com/rust-lang/crates.io-index', expected = { lockSha256: 'a'.repeat(64), supplementManifestSha256: 'b'.repeat(64) }, digest = 'c'.repeat(64)
  const make = () => ({ schema: 1, target: RUST_TARGET, roots: [...RUST_ROOTS], ...expected, packages: [{ id: `${source}#fixture@1.0.0`, name: 'fixture', version: '1.0.0', source, checksum: 'd'.repeat(64), license: 'MIT', classification: 'runtime-and-build', licenseFiles: [{ path: 'licenses/fixture-1.0.0/0000-LICENSE', sourcePath: 'src/LICENSE', bytes: 12, sha256: digest }] }] })
  const actual = relative => { assert.equal(relative, 'rust-dependencies/licenses/fixture-1.0.0/0000-LICENSE'); return { bytes: 12, digest } }
  const manifest = make(), result = validateRustLegalManifest(manifest, expected, actual)
  assert.equal(result.licenseBytes, 12); assert.equal(result.licenseFiles, 1); assert.equal(result.packages, 1)
  assert.equal(result.resources.size, 1)
  for (const mutate of [
    value => { value.lockSha256 = 'e'.repeat(64) },
    value => { value.packages[0].licenseFiles = [] },
    value => { value.packages[0].licenseFiles[0].path = 'licenses/fixture-1.0.0/src/LICENSE' },
    value => { value.packages[0].licenseFiles[0].sourcePath = '../LICENSE' },
    value => { value.packages[0].licenseFiles.push(value.packages[0].licenseFiles[0]) },
    value => { value.packages[0].licenseFiles[0].sha256 = 'f'.repeat(64) },
    value => { value.packages[0].license = 'UNKNOWN' }
  ]) { const changed = make(); mutate(changed); assert.throws(() => validateRustLegalManifest(changed, expected, actual)) }
})

test('frozen app, helper, ZIP and DMG limits remain separate from traversal safety ceilings', () => {
  const limits = { appBytes: 314572800, helperBytes: 163840, zipBytes: 131072000, dmgBytes: 136314880 }, baseline = { schema: 1, architectures: { arm64: { limits } } }
  const make = () => ({ appBytes: limits.appBytes, executableBytes: { 'Contents/Resources/tern-navigation/present-window': limits.helperBytes }, artifacts: { zip: { bytes: limits.zipBytes }, dmg: { bytes: limits.dmgBytes } } })
  assert.deepEqual(validateFrozenBudgets(make(), baseline).limits, limits)
  for (const key of Object.keys(limits)) {
    const report = make()
    if (key === 'appBytes') report.appBytes++
    else if (key === 'helperBytes') report.executableBytes['Contents/Resources/tern-navigation/present-window']++
    else report.artifacts[key === 'zipBytes' ? 'zip' : 'dmg'].bytes++
    assert.throws(() => validateFrozenBudgets(report, baseline), new RegExp(key))
  }
  assert.throws(() => validateFrozenBudgets(make(), {}), /Missing frozen/)
})
