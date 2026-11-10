import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const RUST_TARGET = 'aarch64-apple-darwin'
export const RUST_ROOTS = Object.freeze(['oc-chan', 'oc-core', 'oc-installer', 'oc-system-monitor'])
export const RUST_LIMITS = Object.freeze({ metadata: 16 * 1024 * 1024, packages: 20000, edges: 200000, crateEntries: 40000, entries: 250000, depth: 24, licenseFiles: 8192, licenseBytes: 2 * 1024 * 1024, totalLicenseBytes: 32 * 1024 * 1024 })
export const sha256 = value => createHash('sha256').update(value).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function requireThat(value, message) { if (!value) throw new Error(message) }
function within(root, file) { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }
export function readBounded(file, limit = RUST_LIMITS.metadata) {
  requireThat(Number.isSafeInteger(limit) && limit >= 0 && limit <= RUST_LIMITS.metadata, 'Invalid metadata budget')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    requireThat(before.isFile() && Number.isSafeInteger(before.size) && before.size >= 0 && before.size <= limit, `File exceeds metadata budget or is not regular: ${file}`)
    const buffer = Buffer.alloc(before.size + 1); let offset = 0
    while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, null); if (!count) break; offset += count }
    const after = fstatSync(fd)
    requireThat(offset === before.size && before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `File changed while reading: ${file}`)
    return buffer.subarray(0, offset)
  } finally { closeSync(fd) }
}
function lockChecksums(bytes) {
  const text = bytes.toString('utf8'); requireThat(/^version = [34]\s*$/m.test(text), 'Unsupported Cargo.lock format')
  const result = new Map(), blocks = text.split(/^\[\[package\]\]\s*$/m).slice(1)
  requireThat(blocks.length > 0 && blocks.length <= RUST_LIMITS.packages, 'Cargo.lock package count exceeds budget')
  for (const block of blocks) {
    const fields = {}
    for (const line of block.split('\n')) {
      const match = /^(name|version|source|checksum) = "([^"\\\r\n]+)"\s*$/.exec(line)
      if (match) { requireThat(!Object.hasOwn(fields, match[1]), 'Duplicate Cargo.lock package field'); fields[match[1]] = match[2] }
    }
    requireThat(typeof fields.name === 'string' && typeof fields.version === 'string', 'Incomplete Cargo.lock package')
    if (!fields.source) continue
    requireThat(/^[a-f0-9]{64}$/.test(fields.checksum ?? ''), 'Cargo source lacks a locked registry checksum')
    const key = JSON.stringify([fields.name, fields.version, fields.source]); requireThat(!result.has(key), 'Duplicate Cargo.lock registry package'); result.set(key, fields.checksum)
  }
  return result
}
export function cargoClosure(metadata, roots = RUST_ROOTS) {
  requireThat(object(metadata) && metadata.version === 1 && Array.isArray(metadata.packages) && metadata.packages.length <= RUST_LIMITS.packages && Array.isArray(metadata.workspace_members) && object(metadata.resolve) && Array.isArray(metadata.resolve.nodes) && metadata.resolve.nodes.length <= RUST_LIMITS.packages, 'Invalid Cargo metadata graph')
  const packages = new Map(), nodes = new Map(), workspace = new Set(metadata.workspace_members)
  for (const item of metadata.packages) {
    requireThat(object(item) && typeof item.id === 'string' && !packages.has(item.id) && typeof item.name === 'string' && typeof item.version === 'string' && Array.isArray(item.targets), 'Invalid or duplicate Cargo package')
    packages.set(item.id, item)
  }
  for (const node of metadata.resolve.nodes) { requireThat(object(node) && packages.has(node.id) && !nodes.has(node.id) && Array.isArray(node.deps), 'Invalid or duplicate Cargo resolve node'); nodes.set(node.id, node) }
  const pending = [], selectedRoots = []
  for (const name of roots) {
    const matches = metadata.packages.filter(item => item.name === name && workspace.has(item.id))
    requireThat(matches.length === 1 && matches[0].source === null, `Missing or ambiguous production Cargo root: ${name}`)
    selectedRoots.push(matches[0].id); pending.push([matches[0].id, 'runtime'])
  }
  const reached = new Map(); let edges = 0
  while (pending.length) {
    const [id, mode] = pending.pop(), item = packages.get(id)
    requireThat(item && nodes.has(id), 'Cargo edge references an unresolved package')
    const classification = item.targets.some(target => target.kind?.includes('proc-macro')) ? 'build' : mode
    let modes = reached.get(id); if (!modes) { modes = new Set(); reached.set(id, modes) }
    if (modes.has(classification)) continue
    modes.add(classification)
    for (const edge of nodes.get(id).deps) {
      requireThat(++edges <= RUST_LIMITS.edges && object(edge) && packages.has(edge.pkg) && Array.isArray(edge.dep_kinds) && edge.dep_kinds.length > 0 && edge.dep_kinds.length <= 64, 'Invalid Cargo edge or traversal budget exceeded')
      for (const kind of edge.dep_kinds) {
        requireThat(object(kind) && [null, 'normal', 'build', 'dev'].includes(kind.kind), 'Unknown Cargo dependency kind')
        if (kind.kind === 'dev') continue
        pending.push([edge.pkg, classification === 'build' || kind.kind === 'build' ? 'build' : 'runtime'])
        requireThat(pending.length <= RUST_LIMITS.edges, 'Cargo traversal queue exceeds budget')
      }
    }
  }
  const entries = [...reached].map(([id, modes]) => ({ package: packages.get(id), workspace: workspace.has(id), classification: modes.size === 2 ? 'runtime-and-build' : [...modes][0] })).sort((a, b) => a.package.id.localeCompare(b.package.id))
  return { roots: selectedRoots, entries }
}
export function queryCargoMetadata(root) {
  root = realpathSync(root)
  const lock = readBounded(path.join(root, 'Cargo.lock')), manifest = readBounded(path.join(root, 'Cargo.toml'))
  const args = ['metadata', '--locked', '--format-version', '1', '--filter-platform', RUST_TARGET]
  const result = spawnSync('cargo', args, { cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: RUST_LIMITS.metadata, killSignal: 'SIGKILL', env: { ...process.env, CARGO_TERM_COLOR: 'never' } })
  requireThat(!result.error && !result.signal && result.status === 0, `cargo metadata unavailable (${result.error?.code ?? result.signal ?? result.status})`)
  let metadata; try { metadata = JSON.parse(result.stdout) } catch { throw new Error('cargo metadata returned invalid JSON') }
  requireThat(metadata.workspace_root === root, 'Cargo metadata belongs to another workspace')
  const closure = cargoClosure(metadata), manifestHashes = { 'Cargo.toml': sha256(manifest) }
  for (const entry of closure.entries.filter(item => item.workspace)) {
    const filename = entry.package.manifest_path
    requireThat(typeof filename === 'string' && within(root, filename) && realpathSync(filename) === filename, 'Workspace Cargo manifest escapes source root')
    manifestHashes[path.relative(root, filename)] = sha256(readBounded(filename))
  }
  const source = { lockSha256: sha256(lock), manifestHashes, metadataSha256: sha256(result.stdout), command: `cargo ${args.join(' ')}` }
  assertCargoSource(root, source)
  return { ...closure, source, checksums: lockChecksums(lock) }
}
export function assertCargoSource(root, source) {
  requireThat(sha256(readBounded(path.join(root, 'Cargo.lock'))) === source.lockSha256, 'Cargo.lock changed during dependency review')
  for (const [name, hash] of Object.entries(source.manifestHashes)) requireThat(sha256(readBounded(path.join(root, name))) === hash, `Cargo manifest changed during review: ${name}`)
}
export function cargoInventory(graph) {
  return graph.entries.filter(entry => !entry.workspace).map(({ package: item, classification }) => {
    requireThat(item.source === 'registry+https://github.com/rust-lang/crates.io-index', `Unreviewed Cargo source: ${item.name}`)
    requireThat(/^[A-Za-z0-9_-]{1,128}$/.test(item.name) && /^[0-9A-Za-z.+-]{1,128}$/.test(item.version), 'Unsafe Cargo package name or version')
    const checksum = graph.checksums.get(JSON.stringify([item.name, item.version, item.source])); requireThat(checksum, 'Resolved Cargo package is absent from exact lock')
    return { id: item.id, name: item.name, version: item.version, source: item.source, checksum, license: typeof item.license === 'string' && item.license ? item.license : 'UNKNOWN', classification }
  })
}
const legalName = /^(?:licen[cs]e|copying|notice|copyright)(?:[._ -]|$)/i
const codeName = /\.(?:rs|c|h|cc|cpp|hpp|m|mm|swift|js|mjs|cjs|ts|tsx|py|sh|rb|go|java)$/i
export function collectCargoLegalFiles(item, checksum, budget, supplemental) {
  const directory = path.dirname(item.manifest_path), packageName = `${item.name}-${item.version}`
  requireThat(path.isAbsolute(directory) && realpathSync(directory) === directory && lstatSync(directory).isDirectory() && path.basename(directory) === packageName && path.basename(path.dirname(path.dirname(directory))) === 'src', 'Cargo registry source is not a canonical registry package directory')
  const archive = path.join(path.dirname(path.dirname(path.dirname(directory))), 'cache', path.basename(path.dirname(directory)), `${packageName}.crate`)
  const compressed = readBounded(archive)
  requireThat(sha256(compressed) === checksum, 'Cargo registry archive SHA256 differs from exact Cargo.lock')
  function tar(args, maximum) {
    const result = spawnSync('/usr/bin/tar', args, { input: compressed, timeout: 30000, maxBuffer: maximum, killSignal: 'SIGKILL' })
    requireThat(!result.error && !result.signal && result.status === 0, `Cargo legal archive read failed (${result.error?.code ?? result.signal ?? result.status})`)
    requireThat(result.stdout.length <= maximum, 'Cargo legal archive output exceeds budget')
    return result.stdout
  }
  const listing = new TextDecoder('utf-8', { fatal: true }).decode(tar(['-tf', '-'], 4 * 1024 * 1024))
  requireThat(listing.endsWith('\n'), 'Incomplete Cargo registry archive listing')
  const names = listing.slice(0, -1).split('\n'), seen = new Set()
  requireThat(names.length > 0 && names.length <= RUST_LIMITS.crateEntries && budget.entries + names.length <= RUST_LIMITS.entries, 'Cargo legal file traversal exceeds entry budget')
  budget.entries += names.length
  for (const name of names) {
    const parts = name.replace(/\/$/, '').split('/')
    requireThat(Buffer.byteLength(name) <= 2048 && parts.length <= RUST_LIMITS.depth && parts[0] === packageName && parts.every(part => part && part !== '.' && part !== '..') && !/[\0\r\n\\]/.test(name) && !seen.has(name), 'Cargo archive contains an unsafe or duplicate path')
    seen.add(name)
  }
  const manifestName = `${packageName}/Cargo.toml`
  requireThat(seen.has(manifestName) && readBounded(item.manifest_path, RUST_LIMITS.licenseBytes).equals(tar(['-xOf', '-', '--', manifestName], RUST_LIMITS.licenseBytes)), 'Cargo registry manifest differs from locked archive')
  let designated = null
  if (item.license_file !== null && item.license_file !== undefined) {
    requireThat(typeof item.license_file === 'string', 'Invalid Cargo license_file')
    const filename = path.resolve(directory, item.license_file)
    requireThat(within(directory, filename) && filename !== directory, 'Cargo license_file escapes package')
    designated = path.relative(directory, filename).split(path.sep).join('/')
  }
  const found = []
  for (const name of names) {
    if (name.endsWith('/')) continue
    const relative = name.slice(packageName.length + 1), basename = path.posix.basename(relative)
    if (!(legalName.test(basename) && !codeName.test(basename)) && relative !== designated) continue
    requireThat(!codeName.test(relative) && !/[?*\[\]]/.test(name), 'Cargo legal file is source code or contains archive glob characters')
    requireThat(++budget.files <= RUST_LIMITS.licenseFiles && budget.bytes < RUST_LIMITS.totalLicenseBytes, 'Cargo license content exceeds aggregate budget')
    const filename = path.join(directory, relative), maximum = Math.min(RUST_LIMITS.licenseBytes, RUST_LIMITS.totalLicenseBytes - budget.bytes)
    requireThat(realpathSync(path.dirname(filename)) === path.dirname(filename), 'Cargo legal file ancestor is a symbolic link')
    const bytes = readBounded(filename, maximum)
    requireThat(bytes.length > 0 && bytes.equals(tar(['-xOf', '-', '--', name], maximum)), 'Cargo license differs from locked registry archive')
    budget.bytes += bytes.length; found.push({ name: relative, bytes })
  }
  if (supplemental) {
    const { record, directory: supplementRoot } = supplemental
    requireThat(found.length === 0 && designated === null && record.name === item.name && record.version === item.version && record.checksum === checksum && record.license === item.license && record.repository === item.repository && /^[a-f0-9]{40}$/.test(record.commit), 'Obsolete or mismatched explicitly reviewed Cargo license supplement')
    requireThat(Array.isArray(record.evidence) && record.evidence.length >= 2 && record.evidence.length <= 8 && Array.isArray(record.files) && record.files.length > 0 && record.files.length <= 8, 'Invalid supplemental license evidence')
    let vcs, hasManifest = false
    for (const evidence of record.evidence) {
      requireThat(typeof evidence.path === 'string' && evidence.path.split('/').every(part => part && part !== '.' && part !== '..') && !/[\0\r\n\\?*\[\]]/.test(evidence.path) && /^[a-f0-9]{64}$/.test(evidence.sha256), 'Unsafe supplemental archive evidence path')
      const name = `${packageName}/${evidence.path}`, bytes = readBounded(path.join(directory, evidence.path), RUST_LIMITS.licenseBytes)
      requireThat(seen.has(name) && sha256(bytes) === evidence.sha256 && bytes.equals(tar(['-xOf', '-', '--', name], RUST_LIMITS.licenseBytes)), 'Supplemental license declaration differs from locked archive')
      if (evidence.path === '.cargo_vcs_info.json') vcs = JSON.parse(bytes.toString('utf8'))
      if (evidence.path === 'Cargo.toml') hasManifest = true
    }
    requireThat(hasManifest && vcs?.git?.sha1 === record.commit && vcs.path_in_vcs === record.pathInVcs && record.sourceArchive === `https://crates.io/api/v1/crates/${item.name}/${item.version}/download`, 'Supplemental license has no exact published VCS identity')
    const outputs = new Set()
    for (const file of record.files) {
      requireThat(typeof file.path === 'string' && file.path.split('/').every(part => part && part !== '.' && part !== '..') && !/[\0\r\n\\]/.test(file.path) && /^[A-Za-z0-9_.-]{1,128}$/.test(file.name) && legalName.test(file.name) && !codeName.test(file.name) && !outputs.has(file.name), 'Unsafe or duplicate supplemental legal file')
      requireThat(['upstream-license', 'upstream-notice', 'archive-header', 'linked-standard-license'].includes(file.kind) && typeof file.url === 'string' && /^https:\/\/(?:raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\/|www\.mozilla\.org\/media\/MPL\/2\.0\/)/.test(file.url) && /^[a-f0-9]{64}$/.test(file.sha256), 'Unbound supplemental license provenance')
      requireThat(++budget.files <= RUST_LIMITS.licenseFiles && budget.bytes < RUST_LIMITS.totalLicenseBytes, 'Supplemental license exceeds aggregate budget')
      const filename = path.join(supplementRoot, file.path), maximum = Math.min(RUST_LIMITS.licenseBytes, RUST_LIMITS.totalLicenseBytes - budget.bytes)
      requireThat(realpathSync(path.dirname(filename)) === path.dirname(filename), 'Supplemental license parent is a symbolic link')
      const bytes = readBounded(filename, maximum)
      requireThat(bytes.length > 0 && bytes.length === file.bytes && sha256(bytes) === file.sha256, 'Supplemental license bytes differ from reviewed source')
      budget.bytes += bytes.length; outputs.add(file.name)
      found.push({ name: file.name, bytes, source: { kind: file.kind, url: file.url, upstreamCommit: record.commit, sourceArchive: record.sourceArchive, archiveEvidence: record.evidence } })
    }
  }
  requireThat(found.length > 0 && (designated === null || found.some(file => file.name === designated)), `Missing complete LICENSE/NOTICE files: ${item.name}@${item.version}`)
  return found.sort((a, b) => a.name.localeCompare(b.name))
}
export function generateRustLicenses({ root, output }) {
  root = realpathSync(root); output = path.resolve(output)
  requireThat(within(root, output) && output !== root && !within(output, root), 'Rust license output must be inside this source workspace')
  requireThat(realpathSync(path.dirname(output)) === path.dirname(output), 'Rust license output parent must be canonical')
  const graph = queryCargoMetadata(root), inventory = cargoInventory(graph), packages = new Map(graph.entries.map(entry => [entry.package.id, entry.package]))
  const budget = { entries: 0, files: 0, bytes: 0 }, documents = []
  const supplementRoot = path.join(root, 'resources/rust-license-supplements'), supplementPath = path.join(supplementRoot, 'manifest.json'), supplementBytes = readBounded(supplementPath, 256 * 1024)
  const supplemental = JSON.parse(supplementBytes.toString('utf8'))
  requireThat(supplemental.schema === 1 && Array.isArray(supplemental.packages) && supplemental.packages.length <= 64, 'Invalid reviewed Cargo license supplement manifest')
  const supplements = new Map(), usedSupplements = new Set()
  for (const entry of supplemental.packages) { const key = `${entry.name}@${entry.version}`; requireThat(!supplements.has(key), 'Duplicate Cargo license supplement'); supplements.set(key, entry) }
  // Validate all source bytes before creating the destination. No source trees are copied.
  for (const entry of inventory) {
    const key = `${entry.name}@${entry.version}`, record = supplements.get(key)
    if (record) usedSupplements.add(key)
    entry.licenseFiles = collectCargoLegalFiles(packages.get(entry.id), entry.checksum, budget, record ? { record, directory: supplementRoot } : undefined).map((file, index) => {
      const relative = `licenses/${entry.name}-${entry.version}/${String(index).padStart(4, '0')}-${path.basename(file.name)}`
      documents.push({ relative, bytes: file.bytes }); return { path: relative, sourcePath: file.name, sha256: sha256(file.bytes), bytes: file.bytes.length, ...(file.source ? { source: file.source } : {}) }
    })
  }
  assertCargoSource(root, graph.source)
  requireThat(usedSupplements.size === supplements.size && sha256(readBounded(supplementPath, 256 * 1024)) === sha256(supplementBytes), 'Stale or changed Cargo license supplements require review')
  const manifest = { schema: 1, target: RUST_TARGET, lockSha256: graph.source.lockSha256, supplementManifestSha256: sha256(supplementBytes), roots: [...RUST_ROOTS], packages: inventory }
  const serialized = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`); requireThat(serialized.length <= RUST_LIMITS.metadata, 'Rust license manifest exceeds metadata budget')
  mkdirSync(output)
  for (const file of documents) { const destination = path.join(output, file.relative); mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, file.bytes, { flag: 'wx', mode: 0o644 }) }
  writeFileSync(path.join(output, 'manifest.json'), serialized, { flag: 'wx', mode: 0o644 })
  return manifest
}
export function parseCargoAuditResult(result) {
  requireThat(!result.error && !result.signal && [0, 1].includes(result.status), `cargo audit unavailable (${result.error?.code ?? result.signal ?? result.status})`)
  let report; try { report = JSON.parse(result.stdout) } catch { throw new Error('cargo audit returned invalid JSON') }
  requireThat(object(report) && !report.error && object(report.database) && object(report.lockfile) && object(report.settings) && object(report.vulnerabilities) && Array.isArray(report.vulnerabilities.list) && object(report.warnings), 'cargo audit response is unverified')
  requireThat(Number.isSafeInteger(report.database['advisory-count']) && report.database['advisory-count'] > 0 && /^[a-f0-9]{40,64}$/.test(report.database['last-commit'] ?? '') && Number.isFinite(Date.parse(report.database['last-updated'])) && Number.isSafeInteger(report.lockfile['dependency-count']) && report.lockfile['dependency-count'] > 0 && report.lockfile['dependency-count'] <= RUST_LIMITS.packages, 'cargo audit lacks a verifiable database or lockfile inventory')
  const findings = report.vulnerabilities.list
  requireThat(findings.length <= RUST_LIMITS.packages && report.vulnerabilities.count === findings.length && report.vulnerabilities.found === (findings.length > 0) && result.status === (findings.length ? 1 : 0), 'cargo audit count or exit status is inconsistent')
  requireThat(Array.isArray(report.settings.ignore) && report.settings.ignore.length === 0 && report.settings.severity === null && Array.isArray(report.settings.target_arch) && report.settings.target_arch.length === 0 && Array.isArray(report.settings.target_os) && report.settings.target_os.length === 0, 'cargo audit applied advisory, severity, or platform filters')
  for (const finding of findings) requireThat(object(finding) && /^RUSTSEC-\d{4}-\d{4}$/.test(finding.advisory?.id ?? '') && typeof finding.package?.name === 'string' && typeof finding.package?.version === 'string', 'cargo audit finding lacks package/advisory identity')
  let warnings = 0
  for (const list of Object.values(report.warnings)) { requireThat(Array.isArray(list) && (warnings += list.length) <= RUST_LIMITS.packages, 'Invalid cargo audit warning inventory') }
  return report
}
export function queryCargoAudit(root) {
  const version = spawnSync('cargo-audit', ['--version'], { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 4096, killSignal: 'SIGKILL' })
  requireThat(!version.error && !version.signal && version.status === 0 && /^cargo-audit 0\.22\.2\s*$/.test(version.stdout), 'Dependency audit requires cargo-audit 0.22.2')
  const args = ['audit', '--json', '--file', path.join(root, 'Cargo.lock')]
  const result = spawnSync('cargo', args, { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL', env: { ...process.env, CARGO_TERM_COLOR: 'never' } })
  return { raw: parseCargoAuditResult(result), command: 'cargo audit --json --file Cargo.lock', exitCode: result.status, stderr: result.stderr ?? '' }
}
