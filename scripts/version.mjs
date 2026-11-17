import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseInfo } from './release-config.mjs'
import { readBounded } from './rust-dependencies.mjs'

export const NOTES_LIMIT = 64 * 1024
const policyFile = 'docs/dependency-review-policy.json'
const sha256 = text => createHash('sha256').update(text).digest('hex')
const json = value => `${JSON.stringify(value, null, 2)}\n`
function requireThat(value, message) { if (!value) throw new Error(message) }
function section(text, name) {
  const sections = [...text.matchAll(/^\[([^\]\r\n]+)\][ \t]*(?:#[^\n]*)?\r?$/gm)]
  const matches = sections.filter(match => match[1] === name)
  requireThat(matches.length === 1, `Missing or duplicate TOML section: ${name}`)
  const match = matches[0], start = match.index + match[0].length
  const end = text.indexOf('\n[', start)
  return text.slice(start, end < 0 ? text.length : end)
}
function stringField(text, name) {
  const lines = text.split('\n').filter(line => new RegExp(`^\\s*${name}\\s*=`).test(line))
  requireThat(lines.length === 1, `Missing or duplicate field: ${name}`)
  const match = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*"([^"\\\\\\r\\n]+)"[ \\t]*(?:#[^\\n]*)?\\r?$`).exec(lines[0])
  requireThat(match, `Unsupported TOML field format: ${name}`)
  return match[1]
}
function replaceVersion(text, previous, version) {
  const expression = /^([ \t]*version[ \t]*=[ \t]*")([^"\r\n]+)("[^\r\n]*)$/gm
  let count = 0
  const result = text.replace(expression, (line, prefix, value, suffix) => {
    requireThat(value === previous, 'Version changed during planning'); count++; return `${prefix}${version}${suffix}`
  })
  requireThat(count === 1, 'Expected one version assignment')
  return result
}
function notes(file) {
  const bytes = readBounded(file, NOTES_LIMIT)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  requireThat(text.trim().length > 0 && !text.includes('\0'), 'Release notes must be nonempty UTF-8 text without NUL')
  return text
}
function inspect(root) {
  root = realpathSync(root)
  const originals = new Map()
  function read(relative) {
    const absolute = path.join(root, relative)
    requireThat(realpathSync(absolute) === absolute, `Symbolic links are unsupported: ${relative}`)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readBounded(absolute))
    originals.set(relative, text); return text
  }
  const manifest = read('Cargo.toml'), workspace = section(manifest, 'workspace.package')
  const { version, tag } = releaseInfo(stringField(workspace, 'version'))
  const result = spawnSync('cargo', ['metadata', '--no-deps', '--offline', '--locked', '--format-version', '1'], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 })
  requireThat(!result.error && result.status === 0, `cargo metadata failed: ${result.error?.message ?? result.stderr}`)
  const metadata = JSON.parse(result.stdout)
  requireThat(metadata.version === 1 && metadata.workspace_root === root && Array.isArray(metadata.workspace_members), 'Unexpected Cargo metadata workspace')
  const local = new Map(), inherited = new Set()
  for (const id of metadata.workspace_members) {
    const item = metadata.packages.find(item => item.id === id)
    requireThat(item && item.source === null && !local.has(item.name), 'Invalid or duplicate workspace member')
    const relative = path.relative(root, item.manifest_path)
    requireThat(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Workspace member escapes root')
    const text = read(relative), pkg = section(text, 'package')
    requireThat(stringField(pkg, 'name') === item.name, 'Cargo package name mismatch')
    const versionLines = pkg.split('\n').filter(line => /^\s*(?:version\b|["']version["'])/.test(line))
    requireThat(versionLines.length === 1, `Unsupported version declaration: ${relative}`)
    if (/^[ \t]*version\.workspace[ \t]*=[ \t]*true[ \t]*(?:#[^\n]*)?\r?$/.test(versionLines[0])) {
      requireThat(item.version === version, `Workspace version drift: ${item.name}`); inherited.add(item.name)
    } else requireThat(stringField(pkg, 'version') === item.version, `Unsupported version declaration: ${relative}`)
    local.set(item.name, item.version)
  }
  requireThat(inherited.size > 0, 'No workspace version inheritors')
  const lock = read('Cargo.lock'), chunks = lock.split(/(?=^\[\[package\]\][ \t]*\r?$)/m)
  requireThat(/^\s*(?:#[^\n]*\n\s*)*version = [34]\s*$/.test(chunks[0]), 'Unsupported Cargo.lock header')
  const seen = new Set()
  for (const chunk of chunks.slice(1)) {
    const name = stringField(chunk, 'name'), lockedVersion = stringField(chunk, 'version')
    // Source-qualified packages are external, even if their names match a member.
    const sourceLines = chunk.split('\n').filter(line => /^\s*(?:source\b|["']source["'])/.test(line))
    if (sourceLines.length) { stringField(chunk, 'source'); continue }
    requireThat(!seen.has(name), `Duplicate local locked package: ${name}`); seen.add(name)
    if (local.has(name)) requireThat(lockedVersion === local.get(name), `Cargo.lock version drift: ${name}`)
  }
  for (const name of local.keys()) requireThat(seen.has(name), `Missing local Cargo.lock member: ${name}`)
  const pkg = JSON.parse(read('package.json')), npm = JSON.parse(read('package-lock.json'))
  requireThat([2, 3].includes(npm.lockfileVersion) && npm.packages?.[''], 'Unsupported npm lock format')
  requireThat(pkg.version === version && npm.version === version && npm.packages[''].version === version, 'npm version drift from Cargo workspace')
  const policy = JSON.parse(read(policyFile))
  requireThat(policy.lockSha256 === sha256(originals.get('package-lock.json')) && policy.cargoLockSha256 === sha256(lock), 'Dependency policy lock hash drift; review dependencies before changing version')
  return { root, originals, manifest, workspace, version, tag, inherited, chunks, pkg, npm, policy }
}
export function checkVersion(root = process.cwd(), { release = false, env = process.env } = {}) {
  const { version, tag, root: directory } = inspect(root)
  if (release) {
    notes(path.join(directory, 'releases', `${version}.md`))
    if (env.GITHUB_REF?.startsWith('refs/tags/') || env.GITHUB_REF_TYPE === 'tag') {
      requireThat(env.GITHUB_REF === `refs/tags/${tag}` && (!env.GITHUB_REF_NAME || env.GITHUB_REF_NAME === tag), `Release tag must match ${tag}`)
    }
  }
  return { version, tag }
}
export function bumpVersion(root, kind, notesFile, { rename = renameSync } = {}) {
  requireThat(['patch', 'minor', 'major'].includes(kind), 'Bump must be patch, minor, or major')
  requireThat(typeof notesFile === 'string' && notesFile.length > 0, 'A notes file is required')
  const state = inspect(root), { originals, version: previousVersion, inherited } = state
  root = state.root
  const parts = previousVersion.split('.').map(BigInt), index = { major: 0, minor: 1, patch: 2 }[kind]
  parts[index]++; for (let i = index + 1; i < 3; i++) parts[i] = 0n
  const { version, tag } = releaseInfo(parts.join('.'))
  const releaseFile = `releases/${version}.md`, releaseDir = path.join(root, 'releases')
  const content = notes(path.resolve(root, notesFile))
  requireThat(!existsSync(path.join(root, releaseFile)), `Release notes already exist: ${releaseFile}`)
  if (existsSync(releaseDir)) requireThat(lstatSync(releaseDir).isDirectory() && realpathSync(releaseDir) === releaseDir, 'Releases must be a real directory')
  const changes = new Map()
  changes.set('Cargo.toml', state.manifest.replace(state.workspace, replaceVersion(state.workspace, previousVersion, version)))
  const newLock = state.chunks.map((chunk, index) => {
    if (!index) return chunk
    const name = stringField(chunk, 'name')
    if (/^\s*source\s*=/m.test(chunk)) return chunk
    if (inherited.has(name)) chunk = replaceVersion(chunk, previousVersion, version)
    // Cargo can qualify dependency references by version; source-qualified references stay external.
    return chunk.replace(/^(\s*")([^"\r\n]+)(",?\s*)$/gm, (line, prefix, reference, suffix) => {
      const pieces = reference.split(' ')
      return pieces.length === 2 && inherited.has(pieces[0]) && pieces[1] === previousVersion ? `${prefix}${pieces[0]} ${version}${suffix}` : line
    })
  }).join('')
  changes.set('Cargo.lock', newLock)
  state.pkg.version = version; state.npm.version = version; state.npm.packages[''].version = version
  changes.set('package.json', json(state.pkg)); changes.set('package-lock.json', json(state.npm))
  state.policy.lockSha256 = sha256(changes.get('package-lock.json')); state.policy.cargoLockSha256 = sha256(newLock)
  changes.set(policyFile, json(state.policy)); changes.set(releaseFile, content)
  // Stage every byte before replacing any source. Restore completed replacements on failure.
  const staged = [], applied = []; let madeDirectory = false
  try {
    for (const [file, before] of originals) requireThat(readFileSync(path.join(root, file), 'utf8') === before, `File changed during version planning: ${file}`)
    if (!existsSync(releaseDir)) { mkdirSync(releaseDir); madeDirectory = true }
    for (const [file, after] of changes) {
      const target = path.join(root, file), temporary = `${target}.version-${process.pid}-${staged.length}.tmp`
      const fd = openSync(temporary, 'wx', originals.has(file) ? lstatSync(target).mode : 0o644)
      staged.push({ file, target, temporary })
      try { writeFileSync(fd, after) } finally { closeSync(fd) }
    }
    // Reserve the new note with exclusive creation so a concurrent release is never overwritten.
    writeFileSync(path.join(root, releaseFile), '', { flag: 'wx' }); applied.push(releaseFile)
    for (const entry of staged) { rename(entry.temporary, entry.target); if (entry.file !== releaseFile) applied.push(entry.file) }
  } catch (error) {
    const failures = [error]
    for (const file of applied.reverse()) {
      try { if (originals.has(file)) writeFileSync(path.join(root, file), originals.get(file)); else unlinkSync(path.join(root, file)) } catch (rollback) { failures.push(rollback) }
    }
    for (const { temporary } of staged) { try { if (existsSync(temporary)) unlinkSync(temporary) } catch (cleanup) { failures.push(cleanup) } }
    if (madeDirectory) { try { rmdirSync(releaseDir) } catch (cleanup) { failures.push(cleanup) } }
    if (failures.length > 1) throw new AggregateError(failures, 'Version update failed; rollback/cleanup also failed')
    throw error
  }
  return { previousVersion, version, tag, files: [...changes.keys()] }
}
export function runVersion(args, root = process.cwd()) {
  if (args[0] === 'check' && (args.length === 1 || (args.length === 2 && args[1] === '--release'))) return checkVersion(root, { release: args.length === 2 })
  if (args[0] === 'bump' && args.length === 4 && args[2] === '--notes-file') return bumpVersion(root, args[1], args[3])
  throw new Error('Usage: version.mjs check [--release] | bump <patch|minor|major> --notes-file <path>')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(runVersion(process.argv.slice(2)))) } catch (error) { console.error(error); process.exitCode = 1 }
}
