import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertManifestLock, licenseInventory, parseArgs, parseAuditResult, readBounded, reviewDependencies, reviewFindings, validatePolicy } from './dependency-review.mjs'
import { rendererLicensePlugin } from './bundled-licenses.ts'

const advisoryId = 'GHSA-g3hv-75wg-m249'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const manifest = { name: 'fixture', version: '1.0.0', license: 'UNLICENSED', dependencies: { systeminformation: '^5.33.19' }, devDependencies: { react: '^19.3.1', minimatch: '^9.0.9', builder: '1.0.0' } }
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: {
    '': structuredClone(manifest),
    'node_modules/systeminformation': { version: '5.33.19', license: 'MIT' },
    'node_modules/react': { version: '19.3.1', license: 'MIT', dev: true },
    'node_modules/minimatch': { version: '9.0.9', license: 'ISC', dev: true },
    'node_modules/builder': { version: '1.0.0', license: 'MIT', dev: true }
  } }
  const bundled = { schema: 1, packages: [{ name: 'react', version: '19.3.1', license: 'MIT', renderedBytes: 100 }] }
  const policy = { schema: 1, lockSha256: hash(JSON.stringify(lock)), allowedLicenses: ['MIT', 'ISC'], advisories: [{ id: advisoryId, scope: 'build-only', reason: 'Build patterns are maintained repository inputs. npm reports <11; upstream advisory states >=7,<11.0.1 at optimizationLevel>=2. No user/IPC patterns reach this dependency.', reviewedAt: '2026-11-05' }], dependencyChangeReason: 'Renderer dependencies are bundled, only systeminformation is externalized.' }
  const audit = { auditReportVersion: 2, vulnerabilities: {
    minimatch: { name: 'minimatch', severity: 'moderate', range: '<11', nodes: ['node_modules/minimatch'], via: [{ source: 123, name: 'minimatch', title: 'Pattern denial of service', severity: 'moderate', url: `https://github.com/advisories/${advisoryId}`, range: '<11' }] },
    builder: { name: 'builder', severity: 'moderate', range: '*', nodes: ['node_modules/builder'], via: ['minimatch'] }
  }, metadata: { vulnerabilities: { moderate: 2, total: 2 } } }
  return { manifest, lock, bundled, policy, audit }
}
function temporary(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oc-chan-dependency-review-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function put(root, name, value) {
  const file = path.join(root, name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}

test('manifest agreement compares dependency scopes and exact range text, independent of key order', () => {
  const { manifest, lock } = fixture()
  assert.doesNotThrow(() => assertManifestLock(manifest, lock))
  lock.packages[''].devDependencies = Object.fromEntries(Object.entries(lock.packages[''].devDependencies).reverse())
  assert.doesNotThrow(() => assertManifestLock(manifest, lock))
  manifest.devDependencies.react = '~19.3.1'
  assert.throws(() => assertManifestLock(manifest, lock), /root mismatch: devDependencies/)
  manifest.devDependencies.react = '^19.3.1'
  delete lock.packages['node_modules/react']
  assert.throws(() => assertManifestLock(manifest, lock), /Missing direct locked dependency: react/)
})

test('a runtime dependency cannot be hidden by a dev flag, including nested and hoisted dependencies', () => {
  const { manifest, lock } = fixture()
  lock.packages['node_modules/systeminformation'].dependencies = { helper: '1.0.0' }
  lock.packages['node_modules/helper'] = { version: '1.0.0', license: 'MIT', dev: true }
  assert.throws(() => assertManifestLock(manifest, lock), /Runtime dependency incorrectly classified/)
  delete lock.packages['node_modules/helper'].dev
  assert.doesNotThrow(() => assertManifestLock(manifest, lock))
  lock.packages['node_modules/systeminformation/node_modules/helper'] = { version: '1.0.0', license: 'MIT', dev: true }
  assert.throws(() => assertManifestLock(manifest, lock), /Runtime dependency incorrectly classified/)
  delete lock.packages['node_modules/systeminformation/node_modules/helper']
  delete lock.packages['node_modules/helper']
  assert.throws(() => assertManifestLock(manifest, lock), /Missing runtime dependency helper/)
})

test('policy pins exact lock bytes and requires a dated review and dependency rationale', () => {
  const { lock, policy } = fixture()
  assert.doesNotThrow(() => validatePolicy(policy, hash(JSON.stringify(lock))))
  assert.throws(() => validatePolicy(policy, hash(JSON.stringify(lock) + '\n')), /lockSha256/)
  policy.advisories[0].reviewedAt = 'not-a-date'
  assert.throws(() => validatePolicy(policy, policy.lockSha256), /Invalid or duplicate/)
  policy.advisories = []
  policy.dependencyChangeReason = ''
  assert.throws(() => validatePolicy(policy, policy.lockSha256), /rationale/)
})

test('inventory classifies dev renderer code as bundled and distinguishes exact nested versions', () => {
  const { lock, bundled } = fixture()
  lock.packages['node_modules/builder/node_modules/react'] = { version: '18.0.0', license: 'MIT', dev: true }
  const rows = licenseInventory(lock, bundled)
  assert.equal(rows.find(row => row.path === 'node_modules/react').classification, 'bundled')
  assert.equal(rows.find(row => row.path === 'node_modules/systeminformation').classification, 'runtime')
  assert.equal(rows.find(row => row.version === '18.0.0').classification, 'build')
  assert.ok(rows.every(row => row.name !== 'fixture'))
  bundled.packages[0].version = '20.0.0'
  assert.throws(() => licenseInventory(lock, bundled), /absent from lock/)
})

test('inventory rejects traversal, linked packages, duplicate bundles and mismatched licenses', () => {
  for (const change of [
    ({ lock }) => { lock.packages['node_modules/../escape'] = { version: '1', license: 'MIT' } },
    ({ lock }) => { lock.packages['node_modules/react'].link = true },
    ({ bundled }) => { bundled.packages.push({ ...bundled.packages[0] }) },
    ({ bundled }) => { bundled.packages[0].license = 'ISC' },
    ({ bundled }) => { bundled.packages[0].renderedBytes = -1 }
  ]) {
    const data = fixture()
    change(data)
    assert.throws(() => licenseInventory(data.lock, data.bundled))
  }
})

test('known advisories propagate through cyclic build dependencies without being treated as clean', () => {
  const { lock, bundled, policy, audit } = fixture()
  audit.vulnerabilities.minimatch.via.push('builder')
  const findings = reviewFindings(audit, licenseInventory(lock, bundled), policy)
  assert.equal(findings.length, 2)
  assert.ok(findings.every(item => item.decision === 'reviewed-build-only'))
  const propagated = findings.find(item => item.name === 'builder')
  assert.equal(propagated.advisories[0].id, advisoryId)
  assert.equal(propagated.advisories[0].npmRange, '<11')
})

test('review rejects new advisories, runtime exposure, bundled exposure and unknown lock nodes', () => {
  for (const change of [
    data => { data.policy.advisories = [] },
    data => { delete data.lock.packages['node_modules/minimatch'].dev },
    data => { data.bundled.packages.push({ name: 'minimatch', version: '9.0.9', license: 'ISC', renderedBytes: 10 }) },
    data => { data.audit.vulnerabilities.minimatch.nodes.push('node_modules/missing') },
    data => { data.audit.vulnerabilities.minimatch.via[0].url = 'https://github.com/advisories/GHSA-new-unreviewed-advisory' }
  ]) {
    const data = fixture()
    change(data)
    const findings = reviewFindings(data.audit, licenseInventory(data.lock, data.bundled), data.policy)
    assert.equal(findings.find(item => item.name === 'minimatch').decision, 'rejected')
  }
})

test('incomplete and cyclic advisory propagation cannot be treated as clean', () => {
  const data = fixture()
  data.audit.vulnerabilities.minimatch.via = ['builder']
  assert.throws(() => reviewFindings(data.audit, licenseInventory(data.lock, data.bundled), data.policy))
  data.audit.vulnerabilities.minimatch.via = ['missing']
  assert.throws(() => reviewFindings(data.audit, licenseInventory(data.lock, data.bundled), data.policy), /Unresolved/)
  data.audit.vulnerabilities.minimatch.nodes = []
  assert.throws(() => reviewFindings(data.audit, licenseInventory(data.lock, data.bundled), data.policy), /Missing affected/)
})

test('dense advisory graphs stop at the traversal budget', () => {
  const { lock, bundled, policy, audit } = fixture()
  const names = Array.from({ length: 350 }, (_, index) => `build-${index}`)
  const via = ['minimatch', ...names]
  for (const name of names) {
    const location = `node_modules/${name}`
    lock.packages[location] = { version: '1.0.0', license: 'MIT', dev: true }
    audit.vulnerabilities[name] = { name, via, nodes: [location] }
  }
  assert.throws(() => reviewFindings(audit, licenseInventory(lock, bundled), policy), /traversal budget/)
})

test('npm exit 1 with valid findings is verified evidence; malformed, transport and count failures are not', () => {
  const { audit } = fixture()
  assert.deepEqual(parseAuditResult({ status: 1, stdout: JSON.stringify(audit), stderr: '' }), audit)
  for (const result of [
    { status: 1, stdout: '{' },
    { status: 1, stdout: JSON.stringify({ error: { code: 'EAI_AGAIN', summary: 'registry unavailable' } }) },
    { status: 2, stdout: JSON.stringify(audit), stderr: 'registry unavailable' },
    { status: 1, stdout: JSON.stringify({ ...audit, metadata: { vulnerabilities: { total: 0 } } }) },
    { status: 1, stdout: JSON.stringify({ ...audit, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }) }
  ]) assert.throws(() => parseAuditResult(result), /npm audit/)
  assert.throws(() => parseAuditResult({ status: 1, stdout: '', error: new Error('EAI_AGAIN original failure') }), /EAI_AGAIN original failure/)
  assert.deepEqual(parseAuditResult({ status: 0, stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }) }).vulnerabilities, {})
})

test('real subprocess timeout and output overflow stay unverified with their original errors', () => {
  const timeout = spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1024 })
  assert.equal(timeout.error?.code, 'ETIMEDOUT')
  assert.throws(() => parseAuditResult(timeout), /ETIMEDOUT/)
  const overflow = spawnSync(process.execPath, ['-e', 'process.stdout.write("x".repeat(65536))'], { timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1024 })
  assert.equal(overflow.error?.code, 'ENOBUFS')
  assert.throws(() => parseAuditResult(overflow), /ENOBUFS/)
})

test('metadata size limit allows exact boundary and refuses overflow before loading', t => {
  const root = temporary(t)
  const file = put(root, 'data.json', '12345678')
  assert.equal(readBounded(file, 8).toString(), '12345678')
  assert.throws(() => readBounded(file, 7), /budget/)
  assert.throws(() => readBounded(root, 8), /not regular|budget/)
})

test('failed local preconditions produce an unverified report without changing evidence', t => {
  const root = temporary(t)
  const { manifest, lock, bundled, policy } = fixture()
  put(root, 'package.json', manifest)
  const lockFile = put(root, 'package-lock.json', lock)
  put(root, 'out/renderer/bundled-dependencies.json', bundled)
  put(root, 'out/main/bundled-dependencies.json', bundled)
  put(root, 'docs/dependency-review-policy.json', { ...policy, lockSha256: '0'.repeat(64) })
  const before = readFileSync(lockFile)
  const report = reviewDependencies({ root })
  assert.equal(report.status, 'unverified')
  assert.match(report.errors[0], /lockSha256/)
  assert.deepEqual(readFileSync(lockFile), before)
  assert.equal(report.source.lockHash, hash(before))
})

test('CLI prevents report paths overwriting evidence, including symlink aliases', t => {
  const root = temporary(t)
  const file = put(root, 'package-lock.json', '{}')
  symlinkSync(file, path.join(root, 'alias.json'))
  assert.throws(() => parseArgs(['--output', 'package-lock.json'], root), /overwrite/)
  assert.throws(() => parseArgs(['--output', 'alias.json'], root), /overwrite/)
  assert.throws(() => parseArgs(['--output', 'report.json', '--output', 'another.json'], root), /Usage/)
  assert.throws(() => parseArgs(['--policy'], root), /Usage/)
})

function bundleFixture(t, { missingLicense = false } = {}) {
  const root = temporary(t)
  const directory = 'node_modules/@fixture/retained'
  put(root, `${directory}/package.json`, { name: '@fixture/retained', version: '1.2.3', license: 'MIT' })
  const moduleA = put(root, `${directory}/index.js`, 'export const retained = 1')
  const moduleB = put(root, `${directory}/other.js`, 'export const other = 2')
  if (!missingLicense) put(root, `${directory}/LICENSE`, 'Copyright (c) Fixture Authors\nPermission is hereby granted to use this fixture.\n')
  if (!missingLicense) put(root, `${directory}/licenses/vendor.txt`, 'Vendor license grant in a dedicated license directory.\n')
  put(root, `${directory}/vendor/NOTICE.txt`, 'Third-party vendor copyright and attribution.\n')
  put(root, 'node_modules/unused/package.json', { name: 'unused', version: '1', license: 'GPL-3.0' })
  const unused = put(root, 'node_modules/unused/index.js', 'export const unused = 1')
  const plugin = rendererLicensePlugin()
  plugin.configResolved({ root })
  const assets = []
  const run = () => plugin.generateBundle.call({ emitFile: asset => assets.push(asset) }, {}, {
    'chunk.js': { type: 'chunk', modules: { [moduleA]: { renderedLength: 12 }, [moduleB]: { renderedLength: 7 }, [unused]: { renderedLength: 0 } } }
  })
  return { root, directory, moduleA, assets, run }
}

test('renderer inventory follows retained chunk IDs and preserves complete license and nested notices', t => {
  const { assets, run } = bundleFixture(t)
  run()
  const inventory = JSON.parse(assets.find(asset => asset.fileName === 'bundled-dependencies.json').source)
  assert.deepEqual(inventory, { schema: 1, packages: [{ name: '@fixture/retained', version: '1.2.3', license: 'MIT', renderedBytes: 19 }] })
  const notice = assets.find(asset => asset.fileName === 'THIRD_PARTY_NOTICES.txt').source
  assert.match(notice, /Copyright \(c\) Fixture Authors\nPermission is hereby granted to use this fixture\./)
  assert.match(notice, /vendor\/NOTICE.txt[\s\S]*Third-party vendor copyright and attribution/)
  assert.match(notice, /licenses\/vendor.txt[\s\S]*Vendor license grant in a dedicated license directory/)
  assert.doesNotMatch(notice, /unused|GPL-3.0/)
})

test('renderer license collection rejects missing notices, path escapes and oversized metadata', t => {
  const missing = bundleFixture(t, { missingLicense: true })
  assert.throws(missing.run, /No license\/copyright notice/)
  const escaped = bundleFixture(t)
  const license = path.join(escaped.root, escaped.directory, 'LICENSE')
  rmSync(license)
  symlinkSync(put(escaped.root, 'outside.txt', 'external text'), license)
  assert.throws(escaped.run, /escapes package/)
  const huge = bundleFixture(t)
  put(huge.root, `${huge.directory}/LICENSE`, 'x'.repeat(1024 * 1024 + 1))
  assert.throws(huge.run, /bounded file/)
})
