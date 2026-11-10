import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCargoSource, cargoInventory, queryCargoAudit, queryCargoMetadata, readBounded, RUST_ROOTS, RUST_TARGET } from './rust-dependencies.mjs'
export { readBounded } from './rust-dependencies.mjs'

const rootDirectory = fileURLToPath(new URL('..', import.meta.url))
export const limits = Object.freeze({ metadataBytes: 16 * 1024 * 1024, packages: 20000, auditBytes: 4 * 1024 * 1024, auditEdges: 100000, auditTimeoutMs: 90000 })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = value => createHash('sha256').update(value).digest('hex')
const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value)


export function assertManifestLock(manifest, lock) {
  if (!object(manifest) || !object(lock) || lock.lockfileVersion !== 3 || !object(lock.packages) || !object(lock.packages[''])) throw new Error('Expected package manifest and npm lockfileVersion 3 root metadata')
  if (Object.keys(lock.packages).length > limits.packages) throw new Error('Lock package count exceeds budget')
  for (const field of ['name', 'version']) {
    if (typeof manifest[field] !== 'string' || manifest[field] !== lock[field]) throw new Error(`Manifest/lock mismatch: ${field}`)
  }
  for (const field of ['name', 'version', 'license', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines', 'os', 'cpu']) {
    const empty = ['name', 'version', 'license'].includes(field) ? null : {}
    if (canonical(manifest[field] ?? empty) !== canonical(lock.packages[''][field] ?? empty)) throw new Error(`Manifest/lock root mismatch: ${field}`)
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const entries = manifest[field] ?? {}
    if (!object(entries)) throw new Error(`Invalid manifest dependency group: ${field}`)
    for (const [name, spec] of Object.entries(entries)) {
      if (typeof spec !== 'string' || !object(lock.packages[`node_modules/${name}`]) || typeof lock.packages[`node_modules/${name}`].version !== 'string') throw new Error(`Missing direct locked dependency: ${name}`)
    }
  }
  const pending = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).map(name => `node_modules/${name}`)
  const visited = new Set()
  while (pending.length) {
    const location = pending.pop()
    if (visited.has(location)) continue
    visited.add(location)
    const entry = lock.packages[location]
    if (!object(entry) || entry.dev === true) throw new Error(`Runtime dependency incorrectly classified or missing: ${location}`)
    const optional = entry.optionalDependencies ?? {}
    const peers = entry.peerDependencies ?? {}
    for (const name of Object.keys({ ...entry.dependencies, ...optional, ...peers })) {
      let parent = location
      let resolved
      while (true) {
        const candidate = `${parent ? `${parent}/` : ''}node_modules/${name}`
        if (Object.hasOwn(lock.packages, candidate)) { resolved = candidate; break }
        if (!parent) break
        const marker = parent.lastIndexOf('/node_modules/')
        parent = marker < 0 ? '' : parent.slice(0, marker)
      }
      if (!resolved) {
        if (Object.hasOwn(optional, name) || entry.peerDependenciesMeta?.[name]?.optional === true) continue
        throw new Error(`Missing runtime dependency ${name} required by ${location}`)
      }
      pending.push(resolved)
      if (pending.length > limits.packages) throw new Error('Runtime dependency traversal exceeds budget')
    }
  }
}

export function validatePolicy(policy, lockSha256, cargoLockSha256) {
  if (!object(policy) || policy.schema !== 2 || !/^[a-f0-9]{64}$/.test(policy.lockSha256 ?? '') || policy.lockSha256 !== lockSha256) throw new Error('Dependency review policy lockSha256 does not match exact npm lock bytes')
  if (!/^[a-f0-9]{64}$/.test(policy.cargoLockSha256 ?? '') || policy.cargoLockSha256 !== cargoLockSha256) throw new Error('Dependency review policy cargoLockSha256 does not match exact Cargo.lock bytes')
  for (const field of ['allowedLicenses', 'allowedCargoLicenses']) if (!Array.isArray(policy[field]) || !policy[field].length || policy[field].length > 256 || policy[field].some(item => typeof item !== 'string' || !item.trim() || item.length > 256) || new Set(policy[field]).size !== policy[field].length) throw new Error(`Invalid allowed license policy: ${field}`)
  if (!Array.isArray(policy.advisories) || policy.advisories.length !== 0) throw new Error('Advisory exemptions are not permitted')
  if (typeof policy.dependencyChangeReason !== 'string' || !policy.dependencyChangeReason.trim()) throw new Error('Missing dependency change rationale')
}

export function licenseInventory(lock, bundled) {
  if (!object(lock?.packages) || Object.keys(lock.packages).length > limits.packages) throw new Error('Invalid or oversized lock package inventory')
  if (!object(bundled) || bundled.schema !== 1 || !Array.isArray(bundled.packages) || !bundled.packages.length || bundled.packages.length > 1024) throw new Error('Missing or invalid actual renderer bundled dependency inventory')
  const bundledKeys = new Map()
  for (const entry of bundled.packages) {
    if (!object(entry) || typeof entry.name !== 'string' || !entry.name || typeof entry.version !== 'string' || !entry.version || typeof entry.license !== 'string' || !entry.license || !Number.isSafeInteger(entry.renderedBytes) || entry.renderedBytes < 0) throw new Error('Invalid bundled package metadata')
    const key = `${entry.name}@${entry.version}`
    if (bundledKeys.has(key)) throw new Error(`Duplicate bundled package: ${key}`)
    bundledKeys.set(key, entry)
  }
  const found = new Set()
  const inventory = []
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location === '') continue
    if (!/^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*node_modules\/(?:@[^/]+\/)?[^/]+$/.test(location) || location.split('/').some(part => part === '.' || part === '..') || /[\\\0\r\n]/.test(location) || !object(entry) || entry.link || typeof entry.version !== 'string' || !entry.version) throw new Error(`Unverifiable lock package: ${location}`)
    const name = entry.name ?? location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)
    if (typeof name !== 'string' || !name) throw new Error(`Invalid lock package name: ${location}`)
    const key = `${name}@${entry.version}`
    const bundle = bundledKeys.get(key)
    const license = typeof entry.license === 'string' ? entry.license : 'UNKNOWN'
    if (bundle && bundle.license !== license) throw new Error(`Bundled/lock license mismatch: ${key}`)
    if (bundle) found.add(key)
    inventory.push({ path: location, name, version: entry.version, license, classification: entry.dev !== true ? 'runtime' : bundle ? 'bundled' : 'build', bundled: Boolean(bundle), optional: entry.optional === true, ...(bundle ? { renderedBytes: bundle.renderedBytes } : {}) })
  }
  for (const key of bundledKeys.keys()) if (!found.has(key)) throw new Error(`Bundled package is absent from lock: ${key}`)
  return inventory.sort((a, b) => a.path.localeCompare(b.path))
}

export function parseAuditResult(result) {
  const stderr = String(result.stderr ?? '')
  const stdout = String(result.stdout ?? '')
  if (result.error || result.signal || ![0, 1].includes(result.status)) throw new Error(`npm audit unavailable: ${result.error?.message ?? result.signal ?? `exit ${result.status}`}\n${stderr}\n${stdout}`)
  let audit
  try { audit = JSON.parse(stdout) } catch (error) { throw new Error(`npm audit returned invalid JSON: ${error.message}\n${stderr}\n${stdout}`) }
  if (!object(audit) || audit.error || audit.auditReportVersion !== 2 || !object(audit.vulnerabilities) || !object(audit.metadata?.vulnerabilities) || !Number.isSafeInteger(audit.metadata.vulnerabilities.total) || audit.metadata.vulnerabilities.total < 0) throw new Error(`npm audit response is unverified: ${stdout}\n${stderr}`)
  const count = Object.keys(audit.vulnerabilities).length
  if (count > limits.packages || audit.metadata.vulnerabilities.total !== count || (result.status === 1 && count === 0)) throw new Error(`npm audit finding count/exit status is inconsistent: ${stdout}\n${stderr}`)
  return audit
}

export function queryAudit(root) {
  const result = spawnSync('npm', ['audit', '--json', '--package-lock-only', '--ignore-scripts', '--include=dev', '--include=optional', '--include=peer'], {
    cwd: root, encoding: 'utf8', timeout: limits.auditTimeoutMs, maxBuffer: limits.auditBytes, killSignal: 'SIGKILL', windowsHide: true,
    env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false' }
  })
  return { audit: parseAuditResult(result), stderr: result.stderr ?? '', exitCode: result.status }
}

export function reviewFindings(audit, inventory) {
  const byPath = new Map(inventory.map(entry => [entry.path, entry]))
  const vulnerabilities = audit.vulnerabilities
  const memo = new Map()
  let traversed = 0
  function origins(name) {
    if (memo.has(name)) return memo.get(name)
    const pending = [name]
    const visited = new Set(pending)
    const result = new Map()
    while (pending.length) {
      const current = pending.pop()
      const cached = memo.get(current)
      if (cached) {
        for (const item of cached) {
          if (++traversed > limits.auditEdges) throw new Error('Advisory propagation exceeds traversal budget')
          result.set(item.id, item)
        }
        continue
      }
      const finding = vulnerabilities[current]
      if (!object(finding) || !Array.isArray(finding.via) || !finding.via.length || finding.via.length > limits.packages) throw new Error(`Unresolved npm audit finding: ${current}`)
      for (const via of finding.via) {
        if (++traversed > limits.auditEdges) throw new Error('Advisory propagation exceeds traversal budget')
        if (typeof via === 'string') {
          if (!visited.has(via)) { visited.add(via); pending.push(via) }
          if (visited.size > limits.packages) throw new Error('Advisory package count exceeds traversal budget')
        } else {
          if (!object(via) || typeof via.url !== 'string' || typeof via.range !== 'string') throw new Error(`Invalid npm advisory evidence: ${current}`)
          const id = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(via.url)?.[1] ?? (Number.isSafeInteger(via.source) ? String(via.source) : null)
          if (!id) throw new Error(`Advisory has no verifiable identity: ${current}`)
          result.set(id, { id, url: via.url, npmRange: via.range, title: via.title, severity: via.severity })
        }
      }
    }
    const values = [...result.values()]
    if (!values.length) throw new Error(`No advisory origins: ${name}`)
    memo.set(name, values)
    return values
  }
  return Object.entries(vulnerabilities).map(([name, finding]) => {
    if (!object(finding) || !Array.isArray(finding.nodes) || !finding.nodes.length || finding.nodes.length > limits.packages) throw new Error(`Missing affected lock nodes: ${name}`)
    const nodes = finding.nodes.map(location => {
      if (typeof location !== 'string') throw new Error(`Invalid affected node: ${name}`)
      const entry = byPath.get(location)
      return entry ? { path: location, version: entry.version, classification: entry.classification, bundled: entry.bundled } : { path: location, classification: 'unknown' }
    })
    const advisories = origins(name)
    const buildOnly = nodes.every(node => node.classification === 'build' && !node.bundled)
    return { name, severity: finding.severity, range: finding.range, nodes, advisories, decision: 'rejected', reason: buildOnly ? 'Build dependency vulnerability requires remediation' : 'Runtime, bundled, or unknown affected package' }
  })
}

export function reviewDependencies({ root = rootDirectory, policy: policyPath = path.join(root, 'docs/dependency-review-policy.json'), bundledManifest = path.join(root, 'out/renderer/bundled-dependencies.json') } = {}) {
  const report = { schema: 2, generatedAt: new Date().toISOString(), status: 'unverified', source: {}, licenses: [], findings: [], cargo: { status: 'unverified', target: RUST_TARGET, roots: [...RUST_ROOTS], licenses: [], findings: [] }, errors: [] }
  try {
    const packageBytes = readBounded(path.join(root, 'package.json')), lockBytes = readBounded(path.join(root, 'package-lock.json'))
    const cargoLockBytes = readBounded(path.join(root, 'Cargo.lock')), policyBytes = readBounded(policyPath), bundleBytes = readBounded(bundledManifest)
    report.source = { packageHash: digest(packageBytes), lockHash: digest(lockBytes), cargoLockHash: digest(cargoLockBytes), policyHash: digest(policyBytes), bundledManifestHash: digest(bundleBytes) }
    const manifest = JSON.parse(packageBytes.toString('utf8')), lock = JSON.parse(lockBytes.toString('utf8')), policy = JSON.parse(policyBytes.toString('utf8'))
    assertManifestLock(manifest, lock); validatePolicy(policy, report.source.lockHash, report.source.cargoLockHash)
    report.dependencyChangeReason = policy.dependencyChangeReason
    report.licenses = licenseInventory(lock, JSON.parse(bundleBytes.toString('utf8')))
    const allowed = new Set(policy.allowedLicenses), cargoAllowed = new Set(policy.allowedCargoLicenses)
    report.errors.push(...report.licenses.filter(entry => !allowed.has(entry.license)).map(entry => `Unreviewed npm license ${entry.license}: ${entry.path}@${entry.version}`))
    let complete = true, graph
    try {
      graph = queryCargoMetadata(root); report.cargo.source = graph.source; report.cargo.licenses = cargoInventory(graph)
      if (graph.source.lockSha256 !== report.source.cargoLockHash) throw new Error('Cargo metadata used different lock bytes')
      report.errors.push(...report.cargo.licenses.filter(entry => !cargoAllowed.has(entry.license)).map(entry => `Unreviewed Cargo license ${entry.license}: ${entry.name}@${entry.version}`))
    } catch (error) { complete = false; report.cargo.error = error.message; report.errors.push(error.message) }
    try {
      const result = queryAudit(root)
      report.audit = { status: 'verified', command: 'npm audit --json --package-lock-only --ignore-scripts --include=dev --include=optional --include=peer', exitCode: result.exitCode, stderr: result.stderr, raw: result.audit }
      report.findings = reviewFindings(result.audit, report.licenses)
      report.errors.push(...report.findings.map(finding => `${finding.name}: ${finding.reason}`))
    } catch (error) { complete = false; report.audit = { status: 'unverified', error: error.message }; report.errors.push(error.message) }
    try {
      const result = queryCargoAudit(root); report.cargo.audit = { status: 'verified', ...result }
      const classifications = new Map(report.cargo.licenses.map(item => [`${item.name}@${item.version}`, item.classification]))
      report.cargo.findings = result.raw.vulnerabilities.list.map(item => ({ id: item.advisory.id, name: item.package.name, version: item.package.version, classification: classifications.get(`${item.package.name}@${item.package.version}`) ?? 'lockfile-only', decision: 'rejected', advisory: item.advisory, versions: item.versions }))
      report.errors.push(...report.cargo.findings.map(item => `${item.id}: ${item.name}@${item.version}`))
      report.cargo.warnings = result.raw.warnings
      if (graph) report.cargo.status = report.cargo.findings.length || report.cargo.licenses.some(item => !cargoAllowed.has(item.license)) ? 'rejected' : 'verified'
    } catch (error) { complete = false; report.cargo.audit = { status: 'unverified', error: error.message }; report.errors.push(error.message) }
    if (graph) assertCargoSource(root, graph.source)
    if (digest(readBounded(path.join(root, 'package-lock.json'))) !== report.source.lockHash || digest(readBounded(path.join(root, 'Cargo.lock'))) !== report.source.cargoLockHash || digest(readBounded(path.join(root, 'package.json'))) !== report.source.packageHash || digest(readBounded(policyPath)) !== report.source.policyHash || digest(readBounded(bundledManifest)) !== report.source.bundledManifestHash) throw new Error('Dependency evidence changed during review')
    report.status = !complete ? 'unverified' : report.errors.length ? 'rejected' : 'verified'
  } catch (error) {
    report.errors.push(error.message)
    if (!report.audit) report.audit = { status: 'unverified', error: error.message }
    if (!report.cargo.audit) report.cargo.audit = { status: 'unverified', error: error.message }
  }
  return report
}

export function parseArgs(args, root = rootDirectory) {
  const options = { root, output: path.join(root, 'release/dependency-review.json'), policy: path.join(root, 'docs/dependency-review-policy.json'), bundledManifest: path.join(root, 'out/renderer/bundled-dependencies.json') }
  const names = { '--output': 'output', '--policy': 'policy', '--bundled-manifest': 'bundledManifest' }
  const seen = new Set()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    if (!Object.hasOwn(names, flag) || seen.has(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Usage: node scripts/dependency-review.mjs [--output JSON] [--policy JSON] [--bundled-manifest JSON]')
    seen.add(flag)
    options[names[flag]] = path.resolve(root, args[index + 1])
  }
  const output = options.output
  if (!output.endsWith('.json') || output.split(path.sep).includes('node_modules')) throw new Error('Report output must be a JSON file outside node_modules')
  const protectedPaths = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'Cargo.toml', 'Cargo.lock'].map(file => path.join(root, file)).concat(options.policy, options.bundledManifest)
  let outputReal = output
  try { outputReal = realpathSync(output) } catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const file of protectedPaths) {
    let real = file
    try { real = realpathSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (file === output || real === outputReal) throw new Error('Report output would overwrite dependency evidence')
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const report = reviewDependencies(options)
  mkdirSync(path.dirname(options.output), { recursive: true })
  writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'w' })
  console.log(`Dependency review: ${report.status}; ${report.findings.length} affected packages; report: ${options.output}`)
  if (report.status !== 'verified') process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
