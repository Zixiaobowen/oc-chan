import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cargoClosure, cargoInventory, parseCargoAuditResult, readBounded } from './rust-dependencies.mjs'

const registry = 'registry+https://github.com/rust-lang/crates.io-index'
function graphFixture() {
  const packages = ['host', 'runtime', 'builder', 'macro', 'shared', 'macro-helper', 'dev-only'].map(name => ({ id: name === 'host' ? 'host' : `${registry}#${name}@1.0.0`, name, version: '1.0.0', source: name === 'host' ? null : registry, license: 'MIT', targets: [{ kind: [name === 'macro' ? 'proc-macro' : 'lib'] }] }))
  const id = name => packages.find(item => item.name === name).id, edge = (name, kind = null) => ({ pkg: id(name), dep_kinds: [{ kind, target: null }] })
  const nodes = packages.map(item => ({ id: item.id, deps: [] })), node = name => nodes.find(item => item.id === id(name))
  node('host').deps = [edge('runtime'), edge('builder', 'build'), edge('macro'), edge('dev-only', 'dev')]
  node('runtime').deps = [edge('shared')]; node('builder').deps = [edge('shared')]; node('macro').deps = [edge('macro-helper')]
  return { metadata: { version: 1, workspace_members: ['host'], packages, resolve: { nodes } }, packages, node, edge }
}
test('production closure separates runtime, build tools and proc macro dependencies and excludes dev-only edges', () => {
  const { metadata } = graphFixture(), graph = cargoClosure(metadata, ['host']), classifications = Object.fromEntries(graph.entries.map(item => [item.package.name, item.classification]))
  assert.deepEqual(classifications, { host: 'runtime', builder: 'build', macro: 'build', 'macro-helper': 'build', runtime: 'runtime', shared: 'runtime-and-build' })
  assert.equal(graph.entries.some(item => item.package.name === 'dev-only'), false)
})
test('unresolved nodes, unknown edge kinds and ambiguous roots cannot produce a partial passing inventory', () => {
  for (const change of [
    value => { value.metadata.resolve.nodes = value.metadata.resolve.nodes.filter(node => node.id !== value.node('shared').id) },
    value => { value.node('host').deps[0].dep_kinds[0].kind = 'optional' },
    value => { value.metadata.packages.push({ ...value.packages[0], id: 'duplicate' }); value.metadata.workspace_members.push('duplicate') }
  ]) { const value = graphFixture(); change(value); assert.throws(() => cargoClosure(value.metadata, ['host'])) }
  assert.throws(() => cargoClosure(graphFixture().metadata, ['missing']), /production Cargo root/)
})
test('registry inventory must be in the exact lock and cannot silently accept git sources', () => {
  const { metadata, packages } = graphFixture(), graph = cargoClosure(metadata, ['host'])
  graph.checksums = new Map(packages.filter(item => item.source).map(item => [JSON.stringify([item.name, item.version, item.source]), 'a'.repeat(64)]))
  assert.equal(cargoInventory(graph).length, 5)
  graph.checksums.clear(); assert.throws(() => cargoInventory(graph), /exact lock/)
  graph.entries.find(item => !item.workspace).package.source = 'git+https://example.invalid/repository'
  assert.throws(() => cargoInventory(graph), /Unreviewed Cargo source/)
})
function auditFixture() {
  return { database: { 'advisory-count': 100, 'last-commit': 'a'.repeat(40), 'last-updated': '2026-11-10T00:00:00Z' }, lockfile: { 'dependency-count': 308 }, settings: { ignore: [], severity: null, target_arch: [], target_os: [] }, vulnerabilities: { count: 0, found: false, list: [] }, warnings: {} }
}
const auditResult = (report, status = 0) => ({ stdout: JSON.stringify(report), status })
test('cargo audit binds its database identity, raw findings, exit status and absence of ignore filters', () => {
  const clean = auditFixture(); assert.deepEqual(parseCargoAuditResult(auditResult(clean)), clean)
  const vulnerable = auditFixture(); vulnerable.vulnerabilities = { count: 1, found: true, list: [{ advisory: { id: 'RUSTSEC-2026-0001' }, package: { name: 'fixture', version: '1.0.0' } }] }
  assert.deepEqual(parseCargoAuditResult(auditResult(vulnerable, 1)), vulnerable)
  assert.throws(() => parseCargoAuditResult(auditResult(vulnerable, 0)), /inconsistent/)
  for (const change of [value => { value.settings.ignore = ['RUSTSEC-2026-0001'] }, value => { value.settings.severity = 'critical' }, value => { value.settings.target_os = ['macos'] }, value => { value.database['last-commit'] = 'unknown' }, value => { value.vulnerabilities.count = 99 }]) {
    const report = auditFixture(); change(report); assert.throws(() => parseCargoAuditResult(auditResult(report)))
  }
  assert.throws(() => parseCargoAuditResult({ stdout: '{}', status: 2 }), /unavailable/)
  assert.throws(() => parseCargoAuditResult({ stdout: 'not json', status: 0 }), /invalid JSON/)
})
test('bounded source reads reject oversized, symlink and directory inputs before reading contents', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'oc-rust-legal-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'LICENSE'); writeFileSync(file, 'license text')
  assert.equal(readBounded(file, 12).toString(), 'license text')
  assert.throws(() => readBounded(file, 11), /budget/)
  symlinkSync(file, path.join(directory, 'link')); assert.throws(() => readBounded(path.join(directory, 'link')), /ELOOP/)
  mkdirSync(path.join(directory, 'folder')); assert.throws(() => readBounded(path.join(directory, 'folder')), /not regular/)
})
