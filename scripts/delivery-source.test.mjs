import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { captureDeliverySource } from './delivery-source.mjs'

const exec = promisify(execFile)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const initialFiles = {
  'src/renderer/index.ts': 'export const answer = 42\n',
  'scripts/build.mjs': 'console.log("build")\n',
  'resources/icon.txt': 'icon\n',
  'plugins/system-monitor/src/main.rs': 'fn main() {}\n',
  'vite.config.ts': 'export default {}\n',
  'Cargo.toml': '[workspace]\n',
  'Cargo.lock': 'version = 4\n',
  'rust-toolchain.toml': '[toolchain]\nchannel="1.99.0"\nprofile="minimal"\n',
  'src-tauri/Cargo.toml': '[package]\nname="host"\n',
  'crates/oc-core/src/lib.rs': 'pub fn captured() {}\n',
  'native/helper.swift': 'import Foundation\n',
  'package.json': '{"name":"delivery-fixture","version":"1.2.3"}\n',
  'package-lock.json': '{"name":"delivery-fixture","version":"1.2.3","lockfileVersion":3}\n',
  'tsconfig.json': '{}\n',
  'docs/dependency-review-policy.json': '{}\n',
  'docs/package-baseline.json': '{}\n'
}

async function put(root, relative, content) {
  const file = path.join(root, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
  return file
}

async function git(root, ...args) {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    env: {
      PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'bowen.sun', GIT_AUTHOR_EMAIL: 'bowen.sun@zstack.io',
      GIT_COMMITTER_NAME: 'bowen.sun', GIT_COMMITTER_EMAIL: 'bowen.sun@zstack.io'
    }
  })
  return stdout.trim()
}

async function fixture(t, { repository = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-chan-delivery-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [relative, content] of Object.entries(initialFiles)) await put(root, relative, content)
  if (repository) {
    await git(root, 'init', '-b', 'delivery-fixture')
    await git(root, 'add', '--all')
    await git(root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Delivery source fixture')
  }
  return root
}

async function sparse(root, relative, bytes) {
  const file = await put(root, relative, '')
  const handle = await open(file, 'r+')
  try { await handle.truncate(bytes) } finally { await handle.close() }
}

test('captures actual HEAD, sorted scoped paths, permissions, lengths and content hashes', async t => {
  const root = await fixture(t)
  await chmod(path.join(root, 'scripts/build.mjs'), 0o755)
  await git(root, 'add', 'scripts/build.mjs')
  await git(root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Executable fixture script')
  const result = await captureDeliverySource(root)
  assert.equal(result.version, '1.2.3')
  assert.equal(result.commit, await git(root, 'rev-parse', 'HEAD'))
  assert.equal(result.branch, 'delivery-fixture')
  assert.equal(result.tag, null)
  assert.deepEqual(result.workspace, { dirty: false, statusSha256: sha256('') })
  assert.deepEqual(result.files.map(file => file.path), Object.keys(initialFiles).sort())
  for (const file of result.files) {
    assert.equal(file.bytes, Buffer.byteLength(initialFiles[file.path]))
    assert.equal(file.sha256, sha256(initialFiles[file.path]))
    assert.equal(typeof file.mode, 'number')
    assert.equal(file.mode & ~0o7777, 0)
  }
  assert.equal(result.files.find(file => file.path === 'scripts/build.mjs').mode, 0o755)
  assert.equal(result.digest, sha256(JSON.stringify(result.files)))
  assert.deepEqual(await captureDeliverySource(root), result)
})

test('dirty modifications and untracked additions change digest without inventing a commit', async t => {
  const root = await fixture(t)
  const before = await captureDeliverySource(root)
  await put(root, 'src/renderer/index.ts', 'export const answer = 43\n')
  const modified = await captureDeliverySource(root)
  assert.equal(modified.commit, before.commit)
  assert.equal(modified.workspace.dirty, true)
  assert.notEqual(modified.workspace.statusSha256, before.workspace.statusSha256)
  assert.notEqual(modified.digest, before.digest)
  await put(root, 'scripts/new script.mjs', 'export default "added"\n')
  const added = await captureDeliverySource(root)
  assert.equal(added.commit, before.commit)
  assert.notEqual(added.digest, modified.digest)
  assert.notEqual(added.workspace.statusSha256, modified.workspace.statusSha256)
  assert.ok(added.files.some(file => file.path === 'scripts/new script.mjs'))
})

test('source digest binds path and complete permission bits', async t => {
  const root = await fixture(t)
  const before = await captureDeliverySource(root)
  await rename(path.join(root, 'resources/icon.txt'), path.join(root, 'resources/renamed.txt'))
  const renamed = await captureDeliverySource(root)
  assert.notEqual(renamed.digest, before.digest)
  await chmod(path.join(root, 'scripts/build.mjs'), 0o740)
  const changedMode = await captureDeliverySource(root)
  assert.equal(changedMode.files.find(file => file.path === 'scripts/build.mjs').mode, 0o740)
  assert.notEqual(changedMode.digest, renamed.digest)
})

test('scopes file contents, includes ignored build inputs, and reports workspace changes separately', async t => {
  const root = await fixture(t)
  const before = await captureDeliverySource(root)
  await put(root, '.gitignore', 'src/ignored.ts\n')
  await put(root, '.env', 'PRIVATE_TOKEN=fixture-only\n')
  await put(root, 'docs/private-notes.txt', 'outside source scope\n')
  const outside = await captureDeliverySource(root)
  assert.equal(outside.digest, before.digest)
  assert.equal(outside.workspace.dirty, true)
  assert.ok(!outside.files.some(file => file.path === '.env' || file.path === 'docs/private-notes.txt'))
  await put(root, 'src/ignored.ts', 'export const ignored = true\n')
  const ignored = await captureDeliverySource(root)
  assert.notEqual(ignored.digest, outside.digest)
  assert.ok(ignored.files.some(file => file.path === 'src/ignored.ts'))
})

test('only declared Cargo output roots with real Cargo markers are excluded', async t => {
  const root = await fixture(t)
  await put(root, 'native/Cargo.toml', '[package]\nname="native"\n')
  const before = await captureDeliverySource(root)
  await put(root, 'native/target/CACHEDIR.TAG', 'Signature: 8a477f597d28d172789f06886806bc55\n# cargo cache\n')
  await put(root, 'native/target/.rustc_info.json', '{"rustc_fingerprint":1,"outputs":{}}')
  await sparse(root, 'native/target/debug/large.rlib', 20 * 1024 * 1024)
  assert.equal((await captureDeliverySource(root)).digest, before.digest)
  await put(root, 'src/target/owned-source.rs', 'pub fn real_source() {}\n')
  assert.ok((await captureDeliverySource(root)).files.some(file => file.path === 'src/target/owned-source.rs'))
  await put(root, 'native/target/CACHEDIR.TAG', 'not Cargo evidence')
  await assert.rejects(captureDeliverySource(root), /ownership evidence/)
})

test('HEAD version tags include annotated tags and prefer the v alias', async t => {
  const root = await fixture(t)
  await git(root, 'tag', 'unrelated-label')
  assert.equal((await captureDeliverySource(root)).tag, null)
  await git(root, 'tag', '1.2.3')
  assert.equal((await captureDeliverySource(root)).tag, '1.2.3')
  await git(root, '-c', 'tag.gpgsign=false', 'tag', '-a', 'v1.2.3', '-m', 'Version fixture')
  assert.equal((await captureDeliverySource(root)).tag, 'v1.2.3')
  await git(root, 'checkout', '--detach')
  const detached = await captureDeliverySource(root)
  assert.equal(detached.branch, null)
  assert.equal(detached.tag, 'v1.2.3')
})

test('rejects a HEAD version tag that does not match the working package version', async t => {
  const root = await fixture(t)
  await git(root, 'tag', 'v1.2.4')
  await assert.rejects(captureDeliverySource(root), /version tag does not match/)
})

test('rejects multiple different version tags on HEAD', async t => {
  const root = await fixture(t)
  await git(root, 'tag', 'v1.2.3')
  await git(root, 'tag', '1.2.4')
  await assert.rejects(captureDeliverySource(root), /multiple different version tags/)
})

test('uses only HEAD tags and accepts SemVer prereleases and build metadata', async t => {
  const root = await fixture(t)
  await git(root, 'tag', 'v1.2.3')
  await put(root, 'package.json', JSON.stringify({ version: '2.0.0-rc.1+local.7' }))
  await git(root, 'add', 'package.json')
  await git(root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Prerelease fixture')
  assert.equal((await captureDeliverySource(root)).tag, null)
  await git(root, 'tag', 'v2.0.0-rc.1+local.7')
  assert.equal((await captureDeliverySource(root)).tag, 'v2.0.0-rc.1+local.7')
})

test('rejects missing inputs and incorrect required input types', async t => {
  for (const input of ['src', 'src-tauri', 'crates', 'native', 'scripts', 'resources', 'plugins', ...Object.keys(initialFiles).filter(name => !/^(src|src-tauri|crates|native|scripts|resources|plugins)\//.test(name))]) {
    await t.test(input, async t => {
      const root = await fixture(t)
      await rm(path.join(root, input), { recursive: true })
      await assert.rejects(captureDeliverySource(root), /input unavailable/)
    })
  }
  await t.test('directory replacing file', async t => {
    const root = await fixture(t)
    await rm(path.join(root, 'tsconfig.json'))
    await mkdir(path.join(root, 'tsconfig.json'))
    await assert.rejects(captureDeliverySource(root), /expected file/)
  })
})

test('rejects invalid package JSON and versions', async t => {
  for (const contents of ['{', '{}', '{"version":1}', '{"version":"01.2.3"}', '{"version":"1.2.3-01"}']) {
    await t.test(contents, async t => {
      const root = await fixture(t)
      await put(root, 'package.json', contents)
      await assert.rejects(captureDeliverySource(root), /package.json/)
    })
  }
})

test('rejects leaf symlinks even when their targets remain inside the root', async t => {
  const root = await fixture(t)
  await symlink('icon.txt', path.join(root, 'resources/alias.txt'))
  await assert.rejects(captureDeliverySource(root), /symlink/)
})

test('rejects directory symlinks, external escapes, and a symlink root', async t => {
  const root = await fixture(t)
  await symlink('../resources', path.join(root, 'src/linked'))
  await assert.rejects(captureDeliverySource(root), /symlink/)
  await rm(path.join(root, 'src/linked'))
  await symlink(tmpdir(), path.join(root, 'src/outside'))
  await assert.rejects(captureDeliverySource(root), /symlink/)
  await rm(path.join(root, 'src/outside'))
  await rename(path.join(root, 'docs'), path.join(root, 'docs-real'))
  await symlink('docs-real', path.join(root, 'docs'))
  await assert.rejects(captureDeliverySource(root), /symlink/)
  const alias = `${root}-alias`
  t.after(() => rm(alias, { force: true }))
  await symlink(root, alias)
  await assert.rejects(captureDeliverySource(alias), /root must be a real directory/)
})

test('rejects source hard links', async t => {
  const root = await fixture(t)
  await link(path.join(root, 'src/renderer/index.ts'), path.join(root, 'src/alias.ts'))
  await assert.rejects(captureDeliverySource(root), /hard link/)
})

test('rejects private inputs and ambiguous path characters before reading contents', async t => {
  for (const name of ['src/.env', 'src/.ssh/id_rsa', 'scripts/bad\\name.mjs', 'resources/bad\nname']) {
    await t.test(JSON.stringify(name), async t => {
      const root = await fixture(t)
      await put(root, name, 'fixture data\n')
      await assert.rejects(captureDeliverySource(root), /credential\/private-data path|unsafe path/)
    })
  }
})

test('rejects files over 16 MiB and total inputs over 64 MiB', async t => {
  await t.test('individual file', async t => {
    const root = await fixture(t)
    await sparse(root, 'resources/oversized.bin', 16 * 1024 * 1024 + 1)
    await assert.rejects(captureDeliverySource(root), /file exceeds 16 MiB/)
  })
  await t.test('aggregate', async t => {
    const root = await fixture(t)
    for (let index = 0; index < 4; index++) await sparse(root, `resources/large-${index}.bin`, 16 * 1024 * 1024)
    await assert.rejects(captureDeliverySource(root), /total 64 MiB/)
  })
})

test('rejects more than 1024 source files and depth beyond 32', async t => {
  await t.test('file count', async t => {
    const root = await fixture(t)
    for (let index = 0; index < 1024; index++) await put(root, `src/file-${index}.ts`, '')
    await assert.rejects(captureDeliverySource(root), /exceeds 1024 files/)
  })
  await t.test('depth', async t => {
    const root = await fixture(t)
    await put(root, `src/${Array(31).fill('nested').join('/')}/too-deep.ts`, '')
    await assert.rejects(captureDeliverySource(root), /exceeds depth 32/)
  })
})

test('fails explicitly outside Git, before the first commit, and below a worktree root', async t => {
  const root = await fixture(t, { repository: false })
  await assert.rejects(captureDeliverySource(root), /Git rev-parse failed/)
  await git(root, 'init', '-b', 'empty-fixture')
  await assert.rejects(captureDeliverySource(root), /Git rev-parse failed/)
  const committed = await fixture(t)
  await assert.rejects(captureDeliverySource(path.join(committed, 'src')), /must be the Git worktree root/)
})

test('accepts an exact 16 MiB file and depth 32', async t => {
  const root = await fixture(t)
  await sparse(root, 'resources/at-limit.bin', 16 * 1024 * 1024)
  const deepPath = `src/${Array(30).fill('nested').join('/')}/at-limit.ts`
  await put(root, deepPath, 'export {}\n')
  const captured = await captureDeliverySource(root)
  assert.equal(captured.files.find(file => file.path === 'resources/at-limit.bin').bytes, 16 * 1024 * 1024)
  assert.ok(captured.files.some(file => file.path === deepPath))
})

test('rejects non-regular input without opening a FIFO', async t => {
  const root = await fixture(t)
  await exec('mkfifo', [path.join(root, 'resources/pipe')], { timeout: 5_000, maxBuffer: 1024 })
  await assert.rejects(captureDeliverySource(root), /regular files\/directories/)
})

test('bounds Git stdout and rejects a missing Git executable', async t => {
  const root = await fixture(t, { repository: false })
  const bin = path.join(root, 'fake-bin')
  await mkdir(bin)
  const executable = await put(root, 'fake-bin/git', `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(1024 * 1024 + 1, 97))\n`)
  await chmod(executable, 0o755)
  const previousPath = process.env.PATH
  try {
    process.env.PATH = bin
    await assert.rejects(captureDeliverySource(root), /Git rev-parse failed \(ERR_CHILD_PROCESS_STDIO_MAXBUFFER/)
    await rm(executable)
    await assert.rejects(captureDeliverySource(root), /Git rev-parse failed \(ENOENT/)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
})
