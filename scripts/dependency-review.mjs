import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDirectory = fileURLToPath(new URL('..', import.meta.url))
export const limits = Object.freeze({ metadataBytes: 16 * 1024 * 1024, packages: 20000, auditBytes: 4 * 1024 * 1024, auditEdges: 100000, auditTimeoutMs: 90000 })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = value => createHash('sha256').update(value).digest('hex')
const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value)

export function readBounded(file, limit = limits.metadataBytes) {
  const fd = openSync(file, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error(`File exceeds metadata budget or is not regular: ${file}`)
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    if (length > stat.size) throw new Error(`File grew while reading: ${file}`)
    return buffer.subarray(0, length)
  } finally { closeSync(fd) }
}

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

export function validatePolicy(policy, lockSha256) {
  if (!object(policy) || policy.schema !== 1 || !/^[a-f0-9]{64}$/.test(policy.lockSha256 ?? '') || policy.lockSha256 !== lockSha256) throw new Error('Dependency review policy lockSha256 does not match exact lock bytes')
  if (!Array.isArray(policy.allowedLicenses) || !policy.allowedLicenses.length || policy.allowedLicenses.some(item => typeof item !== 'string' || !item.trim()) || policy.allowedLicenses.length > 256) throw new Error('Invalid allowed license policy')
  if (!Array.isArray(policy.advisories) || policy.advisories.length > 256 || typeof policy.dependencyChangeReason !== 'string' || !policy.dependencyChangeReason.trim()) throw new Error('Missing dependency change rationale or advisory policy')
  const ids = new Set()
  for (const advisory of policy.advisories) {
    if (!object(advisory) || typeof advisory.id !== 'string' || !advisory.id || advisory.scope !== 'build-only' || typeof advisory.reason !== 'string' || !advisory.reason.trim() || typeof advisory.reviewedAt !== 'string' || !Number.isFinite(Date.parse(advisory.reviewedAt)) || ids.has(advisory.id)) throw new Error('Invalid or duplicate reviewed advisory')
    ids.add(advisory.id)
  }
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

export function reviewFindings(audit, inventory, policy) {
  const byPath = new Map(inventory.map(entry => [entry.path, entry]))
  const allowed = new Map(policy.advisories.map(entry => [entry.id, entry]))
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
    const advisories = origins(name).map(advisory => ({ ...advisory, review: allowed.get(advisory.id) ?? null }))
    const buildOnly = nodes.every(node => node.classification === 'build' && !node.bundled)
    const reviewed = buildOnly && advisories.every(advisory => advisory.review?.scope === 'build-only')
    return { name, severity: finding.severity, range: finding.range, nodes, advisories, decision: reviewed ? 'reviewed-build-only' : 'rejected', reason: !buildOnly ? 'Runtime, bundled, or unknown affected package' : !reviewed ? 'New or unreviewed advisory' : 'Exact lock and build-only reachability acknowledged; vulnerability remains present' }
  })
}

export function reviewDependencies({ root = rootDirectory, policy: policyPath = path.join(root, 'docs/dependency-review-policy.json'), bundledManifest = path.join(root, 'out/renderer/bundled-dependencies.json') } = {}) {
  const report = { schema: 1, generatedAt: new Date().toISOString(), status: 'unverified', source: {}, licenses: [], findings: [], errors: [] }
  try {
    const packageBytes = readBounded(path.join(root, 'package.json'))
    const lockBytes = readBounded(path.join(root, 'package-lock.json'))
    const policyBytes = readBounded(policyPath)
    const bundleBytes = readBounded(bundledManifest)
    report.source = { packageHash: digest(packageBytes), lockHash: digest(lockBytes), policyHash: digest(policyBytes), bundledManifestHash: digest(bundleBytes) }
    const manifest = JSON.parse(packageBytes.toString('utf8'))
    const lock = JSON.parse(lockBytes.toString('utf8'))
    assertManifestLock(manifest, lock)
    const policy = JSON.parse(policyBytes.toString('utf8'))
    validatePolicy(policy, report.source.lockHash)
    report.dependencyChangeReason = policy.dependencyChangeReason
    report.licenses = licenseInventory(lock, JSON.parse(bundleBytes.toString('utf8')))
    const allowed = new Set(policy.allowedLicenses)
    const licenseErrors = report.licenses.filter(entry => !allowed.has(entry.license)).map(entry => `Unreviewed license ${entry.license}: ${entry.path}@${entry.version}`)
    const result = queryAudit(root)
    report.audit = { status: 'verified', command: 'npm audit --json --package-lock-only --ignore-scripts --include=dev --include=optional --include=peer', exitCode: result.exitCode, stderr: result.stderr, raw: result.audit }
    report.findings = reviewFindings(result.audit, report.licenses, policy)
    report.errors.push(...licenseErrors)
    for (const finding of report.findings) if (finding.decision === 'rejected') report.errors.push(`${finding.name}: ${finding.reason}`)
    if (digest(readBounded(path.join(root, 'package-lock.json'))) !== report.source.lockHash || digest(readBounded(path.join(root, 'package.json'))) !== report.source.packageHash) throw new Error('Manifest/lock changed during dependency review')
    report.status = report.errors.length ? 'rejected' : 'verified'
  } catch (error) {
    report.errors.push(error.message)
    if (!report.audit) report.audit = { status: 'unverified', error: error.message }
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
  const protectedPaths = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'].map(file => path.join(root, file)).concat(options.policy, options.bundledManifest)
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
