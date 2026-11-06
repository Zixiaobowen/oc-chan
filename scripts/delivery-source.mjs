import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const directories = ['src', 'scripts', 'resources']
const requiredFiles = [
  'electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json',
  'docs/package-baseline.json', 'docs/dependency-review-policy.json'
]
const maxFiles = 1024
const maxEntries = 4096
const maxDepth = 32
const maxFileBytes = 16 * 1024 * 1024
const maxTotalBytes = 64 * 1024 * 1024
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const statFields = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
const sha256 = value => createHash('sha256').update(value).digest('hex')
const comparePath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0

function unchanged(before, after, name) {
  if (statFields.some(field => before[field] !== after[field])) {
    throw new Error(`Delivery source changed during capture: ${name}`)
  }
}

async function git(root, args) {
  try {
    const { stdout } = await exec('git', [
      '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
      ...args
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1'
      },
      encoding: null, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024
    })
    return stdout
  } catch (error) {
    // Do not expose stderr, local configuration, or private paths in a delivery manifest.
    throw new Error(`Delivery source Git ${args[0]} failed (${error.code ?? error.signal ?? 'unknown'}${error.killed ? ', terminated' : ''})`)
  }
}

async function gitState(root) {
  const commit = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error('Delivery source Git HEAD is invalid')
  const branchName = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toString('utf8').trim()
  const tags = (await git(root, ['tag', '--list', '--points-at', commit, '--sort=refname', '--format=%(refname:strip=2)']))
    .toString('utf8').trim().split('\n').filter(Boolean)
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none', '--no-renames'])
  return {
    commit, branch: branchName === 'HEAD' ? null : branchName, tags,
    workspace: { dirty: status.length !== 0, statusSha256: sha256(status) }
  }
}

function selectTag(tags, version) {
  const versionTags = tags.map(tag => ({ tag, version: tag.startsWith('v') ? tag.slice(1) : tag }))
    .filter(item => versionPattern.test(item.version))
  if (new Set(versionTags.map(item => item.version)).size > 1) {
    throw new Error('Delivery source HEAD has multiple different version tags')
  }
  if (versionTags.some(item => item.version !== version)) {
    throw new Error('Delivery source HEAD version tag does not match package.json version')
  }
  return versionTags.find(item => item.tag === `v${version}`)?.tag ?? versionTags[0]?.tag ?? null
}

// Capture working-tree inputs, not a claim that dirty contents equal the HEAD commit.
// Callers compare the entire returned object before and after their build.
// Each file mode is the numeric permission mask (stat.mode & 0o7777), without type bits.
// scripts/ is recursive, so every build/helper script participates in the digest.
export async function captureDeliverySource(root) {
  const requestedRoot = path.resolve(root)
  const rootStat = await lstat(requestedRoot, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Delivery source root must be a real directory, not a symlink')
  const base = await realpath(requestedRoot)
  const gitRoot = (await git(base, ['rev-parse', '--show-toplevel'])).toString('utf8').trim()
  if (await realpath(gitRoot) !== base) throw new Error('Delivery source root must be the Git worktree root')
  const initialGit = await gitState(base)
  const nodes = new Map([['', rootStat]])
  const candidates = []
  let totalBytes = 0
  let entryCount = 0

  async function inspect(relative, expected) {
    if (++entryCount > maxEntries) throw new Error(`Delivery source exceeds ${maxEntries} filesystem entries`)
    if (relative.split('/').length > maxDepth) throw new Error(`Delivery source exceeds depth ${maxDepth}: ${relative}`)
    const components = relative.split('/')
    if (components.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/.test(part))) {
      throw new Error('Delivery source contains an unsafe path')
    }
    if (components.some(part => /^(?:\.git|\.ssh|\.aws|\.gnupg|\.npmrc|\.netrc|\.env(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\..*)?)$/i.test(part))) {
      throw new Error(`Delivery source contains a credential/private-data path: ${relative}`)
    }
    const absolute = path.join(base, relative)
    let stat
    try { stat = await lstat(absolute, { bigint: true }) } catch (error) {
      throw new Error(`Delivery source input unavailable: ${relative} (${error.code ?? 'unknown'})`)
    }
    if (stat.isSymbolicLink()) throw new Error(`Delivery source symlink is forbidden: ${relative}`)
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Delivery source requires regular files/directories: ${relative}`)
    if (expected === 'directory' && !stat.isDirectory() || expected === 'file' && !stat.isFile()) {
      throw new Error(`Delivery source expected ${expected}: ${relative}`)
    }
    if (await realpath(absolute) !== absolute) throw new Error(`Delivery source path escapes through a symlink: ${relative}`)
    nodes.set(relative, stat)
    if (stat.isFile()) {
      if (stat.nlink !== 1n) throw new Error(`Delivery source hard link is forbidden: ${relative}`)
      if (stat.size > BigInt(maxFileBytes)) throw new Error(`Delivery source file exceeds 16 MiB: ${relative}`)
      if (candidates.length >= maxFiles) throw new Error(`Delivery source exceeds ${maxFiles} files`)
      totalBytes += Number(stat.size)
      if (totalBytes > maxTotalBytes) throw new Error('Delivery source exceeds total 64 MiB')
      candidates.push({ path: relative, stat })
    }
    return stat
  }

  async function walk(relative) {
    const directory = await opendir(path.join(base, relative), { bufferSize: 32 })
    for await (const entry of directory) {
      const child = `${relative}/${entry.name}`
      const stat = await inspect(child)
      if (stat.isDirectory()) await walk(child)
    }
  }

  for (const directory of directories) {
    await inspect(directory, 'directory')
    await walk(directory)
  }
  await inspect('docs', 'directory')
  for (const file of requiredFiles) await inspect(file, 'file')
  candidates.sort(comparePath)
  const files = []
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let version
  for (const candidate of candidates) {
    const absolute = path.join(base, candidate.path)
    // Check ancestors again before opening; O_NOFOLLOW protects the leaf itself.
    const components = candidate.path.split('/')
    for (let index = 0; index < components.length; index++) {
      const parent = components.slice(0, index).join('/')
      unchanged(nodes.get(parent), await lstat(path.join(base, parent), { bigint: true }), parent || '.')
    }
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      unchanged(candidate.stat, await handle.stat({ bigint: true }), candidate.path)
      if (await realpath(absolute) !== absolute) throw new Error(`Delivery source path escaped: ${candidate.path}`)
      const hash = createHash('sha256')
      const packageBytes = candidate.path === 'package.json' ? Buffer.alloc(Number(candidate.stat.size)) : null
      let bytes = 0
      while (true) {
        const result = await handle.read(buffer, 0, buffer.length, null)
        if (result.bytesRead === 0) break
        if (bytes + result.bytesRead > Number(candidate.stat.size)) throw new Error(`Delivery source grew during capture: ${candidate.path}`)
        const chunk = buffer.subarray(0, result.bytesRead)
        hash.update(chunk)
        if (packageBytes) chunk.copy(packageBytes, bytes)
        bytes += result.bytesRead
      }
      unchanged(candidate.stat, await handle.stat({ bigint: true }), candidate.path)
      unchanged(candidate.stat, await lstat(absolute, { bigint: true }), candidate.path)
      if (bytes !== Number(candidate.stat.size)) throw new Error(`Delivery source length changed: ${candidate.path}`)
      if (packageBytes) {
        let manifest
        try { manifest = JSON.parse(packageBytes.toString('utf8')) } catch {
          throw new Error('Delivery source package.json is not valid JSON')
        }
        version = manifest?.version
        if (typeof version !== 'string' || !versionPattern.test(version)) throw new Error('Delivery source package.json version must be valid SemVer')
      }
      files.push({ path: candidate.path, bytes, mode: Number(candidate.stat.mode & 0o7777n), sha256: hash.digest('hex') })
    } finally {
      await handle.close()
    }
  }
  for (const [relative, stat] of nodes) {
    unchanged(stat, await lstat(path.join(base, relative), { bigint: true }), relative || '.')
  }
  const finalGit = await gitState(base)
  if (JSON.stringify(initialGit) !== JSON.stringify(finalGit)) throw new Error('Delivery source Git metadata changed during capture')
  return {
    version, commit: initialGit.commit, branch: initialGit.branch,
    tag: selectTag(initialGit.tags, version), workspace: initialGit.workspace,
    digest: sha256(JSON.stringify(files)), files
  }
}
