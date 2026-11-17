import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertManifestLock, licenseInventory, parseArgs, parseAuditResult, readBounded, reviewDependencies, reviewFindings, validatePolicy } from './dependency-review.mjs'

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
  const policy = { schema: 2, lockSha256: hash(JSON.stringify(lock)), cargoLockSha256: 'c'.repeat(64), allowedLicenses: ['MIT', 'ISC'], allowedCargoLicenses: ['MIT'], advisories: [], dependencyChangeReason: 'Unit fixture distinguishes delivery build tools; Rust uses its exact independent lock.' }
  const audit = { auditReportVersion: 2, vulnerabilities: {
    minimatch: { name: 'minimatch', severity: 'moderate', range: '<11', nodes: ['node_modules/minimatch'], via: [{ source: 123, name: 'minimatch', title: 'Pattern denial of service', severity: 'moderate', url: `https://github.com/advisories/${advisoryId}`, range: '<11' }] },
    builder: { name: 'builder', severity: 'moderate', range: '*', nodes: ['node_modules/builder'], via: ['minimatch'] }
  }, metadata: { vulnerabilities: { moderate: 2, total: 2 } } }
  return { manifest, lock, policy, audit }
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

test('policy pins both exact lock files and rejects advisory exemptions', () => {
  const { lock, policy } = fixture()
  assert.doesNotThrow(() => validatePolicy(policy, hash(JSON.stringify(lock)), policy.cargoLockSha256))
  assert.throws(() => validatePolicy(policy, hash(JSON.stringify(lock) + '\n'), policy.cargoLockSha256), /lockSha256/)
  assert.throws(() => validatePolicy(policy, policy.lockSha256, 'd'.repeat(64)), /cargoLockSha256/)
  policy.advisories = [{ id: advisoryId, scope: 'build-only' }]
  assert.throws(() => validatePolicy(policy, policy.lockSha256, policy.cargoLockSha256), /exemptions/)
  policy.advisories = []; policy.dependencyChangeReason = ''
  assert.throws(() => validatePolicy(policy, policy.lockSha256, policy.cargoLockSha256), /rationale/)
})

test('npm inventory contains delivery tools only, preserving exact nested versions', () => {
  const { lock } = fixture()
  lock.packages['node_modules/builder/node_modules/react'] = { version: '18.0.0', license: 'MIT', dev: true }
  const rows = licenseInventory(lock)
  assert.ok(rows.every(row => row.classification === 'build' && row.bundled === false))
  assert.equal(rows.filter(row => row.name === 'react').length, 2)
})

test('inventory rejects traversal and linked packages', () => {
  for (const change of [
    ({ lock }) => { lock.packages['node_modules/../escape'] = { version: '1', license: 'MIT' } },
    ({ lock }) => { lock.packages['node_modules/react'].link = true },
  ]) {
    const data = fixture()
    change(data)
    assert.throws(() => licenseInventory(data.lock))
  }
})

test('known advisories propagate through cyclic build dependencies without being treated as clean', () => {
  const { lock, audit } = fixture()
  audit.vulnerabilities.minimatch.via.push('builder')
  const findings = reviewFindings(audit, licenseInventory(lock))
  assert.equal(findings.length, 2)
  assert.ok(findings.every(item => item.decision === 'rejected' && item.reason.includes('remediation')))
  const propagated = findings.find(item => item.name === 'builder')
  assert.equal(propagated.advisories[0].id, advisoryId)
  assert.equal(propagated.advisories[0].npmRange, '<11')
})

test('review rejects new advisories and unknown lock nodes regardless of npm dependency flags', () => {
  for (const change of [
    data => { delete data.lock.packages['node_modules/minimatch'].dev },
    data => { data.audit.vulnerabilities.minimatch.nodes.push('node_modules/missing') },
    data => { data.audit.vulnerabilities.minimatch.via[0].url = 'https://github.com/advisories/GHSA-new-unreviewed-advisory' }
  ]) {
    const data = fixture()
    change(data)
    const findings = reviewFindings(data.audit, licenseInventory(data.lock))
    assert.equal(findings.find(item => item.name === 'minimatch').decision, 'rejected')
  }
})

test('incomplete and cyclic advisory propagation cannot be treated as clean', () => {
  const data = fixture()
  data.audit.vulnerabilities.minimatch.via = ['builder']
  assert.throws(() => reviewFindings(data.audit, licenseInventory(data.lock)))
  data.audit.vulnerabilities.minimatch.via = ['missing']
  assert.throws(() => reviewFindings(data.audit, licenseInventory(data.lock)), /Unresolved/)
  data.audit.vulnerabilities.minimatch.nodes = []
  assert.throws(() => reviewFindings(data.audit, licenseInventory(data.lock)), /Missing affected/)
})

test('dense advisory graphs stop at the traversal budget', () => {
  const { lock, audit } = fixture()
  const names = Array.from({ length: 350 }, (_, index) => `build-${index}`)
  const via = ['minimatch', ...names]
  for (const name of names) {
    const location = `node_modules/${name}`
    lock.packages[location] = { version: '1.0.0', license: 'MIT', dev: true }
    audit.vulnerabilities[name] = { name, via, nodes: [location] }
  }
  assert.throws(() => reviewFindings(audit, licenseInventory(lock)), /traversal budget/)
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
  const { manifest, lock, policy } = fixture()
  put(root, 'package.json', manifest)
  const lockFile = put(root, 'package-lock.json', lock)
  put(root, 'Cargo.lock', 'version = 4\n')
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

