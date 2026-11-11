import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeoutTask } from './closeout-task.mjs'

const handoff = 'docs/codex-handoffs/task.md'
const origin = 'https://github.com/Zixiaobowen/oc-chan.git'
const mac = { skip: process.platform !== 'darwin', timeout: 120_000 }
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}
function commit(root, message) {
  git(root, 'add', '--all')
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}
function fixture(t) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'oc-closeout-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'root'), remote = path.join(directory, 'remote.git'), target = path.join(directory, 'task'), other = path.join(directory, 'parallel')
  mkdirSync(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Closeout test')
  git(root, 'config', 'user.email', 'closeout@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.hooksPath', path.join(directory, 'no-hooks'))
  git(root, 'init', '--bare', remote)
  git(root, 'remote', 'add', 'origin', origin)
  // Production GitHub validation is exercised; transport stays entirely local.
  git(root, 'config', `url.${remote}.insteadOf`, origin)
  mkdirSync(path.join(root, 'docs/codex-handoffs'), { recursive: true })
  writeFileSync(path.join(root, handoff), 'Preserved task evidence\n')
  writeFileSync(path.join(root, 'product.js'), 'export const value = 1\n')
  writeFileSync(path.join(root, '.gitignore'), 'cache/\n*.log\n')
  mkdirSync(path.join(root, 'scripts'))
  for (const file of ['closeout-task.mjs', 'push-main.mjs', 'local-app-lifecycle.mjs', 'local-install-readiness.mjs', 'build-app.mjs', 'build-plugin-market-rust.mjs', 'rust-dependencies.mjs']) {
    copyFileSync(new URL(`./${file}`, import.meta.url), path.join(root, 'scripts', file))
  }
  const initial = commit(root, 'initial')
  git(root, 'push', 'origin', 'main')
  git(root, 'worktree', 'add', '-b', 'task', target)
  git(root, 'worktree', 'add', '-b', 'parallel', other)
  const run = (options = {}) => closeoutTask({ root, worktree: target, handoff, ...options })
  return { root, remote, target, other, directory, initial, run }
}
function blocked(result, code) {
  assert.equal(result.removed, false)
  assert.ok(result.blockers.some(item => item.code === code), JSON.stringify(result))
}
function receipt(result) {
  assert.ok(result.receiptPath)
  assert.equal(lstatSync(result.receiptPath).mode & 0o777, 0o600)
  assert.equal(lstatSync(path.dirname(result.receiptPath)).mode & 0o777, 0o700)
  return JSON.parse(readFileSync(result.receiptPath, 'utf8'))
}

test('dry-run reports exact remote and handoff without removing or writing receipt', t => {
  const f = fixture(t), result = f.run()
  assert.deepEqual(result.blockers, [])
  assert.equal(result.head, f.initial)
  assert.equal(result.remoteMain, f.initial)
  assert.equal(result.handoff.blob, git(f.root, 'rev-parse', `HEAD:${handoff}`))
  assert.equal(result.removed, false)
  assert.equal(result.receiptPath, null)
  assert.equal(existsSync(path.join(f.root, '.git/task-closeouts')), false)
  assert.ok(existsSync(f.target))
})

test('apply removes only the selected worktree and retains branch, parallel tree and receipt', mac, t => {
  const f = fixture(t), result = f.run({ apply: true })
  assert.deepEqual(result.blockers, [])
  assert.equal(result.removed, true)
  assert.equal(existsSync(f.target), false)
  assert.ok(existsSync(f.root) && existsSync(f.other))
  assert.equal(git(f.root, 'rev-parse', 'refs/heads/task'), f.initial)
  assert.ok(!git(f.root, 'worktree', 'list', '--porcelain').includes(`worktree ${f.target}\n`))
  assert.equal(receipt(result).removed, true)
})

for (const kind of ['staged', 'unstaged', 'untracked']) {
  test(`${kind} documentation prevents removal even with reviewed ignored entries`, t => {
    const f = fixture(t)
    const filename = kind === 'untracked' ? 'docs/new-evidence.md' : handoff
    writeFileSync(path.join(f.target, filename), 'uncommitted evidence\n')
    if (kind === 'staged') git(f.target, 'add', filename)
    writeFileSync(path.join(f.target, 'reviewed.log'), 'reviewed artifact\n')
    const result = f.run({ apply: true, discard: ['reviewed.log'] })
    blocked(result, 'dirty')
    assert.equal(readFileSync(path.join(f.target, filename), 'utf8'), 'uncommitted evidence\n')
    assert.ok(receipt(result).blockers.some(item => item.code === 'dirty'))
  })
}

test('unpublished task HEAD is refused', t => {
  const f = fixture(t)
  writeFileSync(path.join(f.target, 'product.js'), 'unpublished\n')
  commit(f.target, 'unpublished')
  blocked(f.run({ apply: true }), 'unmerged')
  assert.ok(existsSync(f.target))
})

test('live remote containment overrides stale origin/main cache', t => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, 'product.js'), 'advanced\n')
  const advanced = commit(f.root, 'advanced')
  git(f.root, 'push', 'origin', 'main')
  git(f.target, 'merge', '--ff-only', advanced)
  git(f.remote, 'update-ref', 'refs/heads/main', f.initial)
  assert.equal(git(f.root, 'rev-parse', 'origin/main'), advanced)
  const result = f.run({ apply: true })
  blocked(result, 'unmerged')
  assert.equal(result.remoteMain, f.initial)
  assert.ok(existsSync(f.target))
})

for (const kind of ['missing', 'unpublished', 'dirty', 'staged', 'symlink']) {
  test(`${kind} handoff cannot authorize deletion`, t => {
    const f = fixture(t)
    let selected = handoff
    if (kind === 'missing') selected = 'docs/codex-handoffs/absent.md'
    else if (kind === 'symlink') {
      rmSync(path.join(f.root, handoff))
      symlinkSync(path.join(f.target, handoff), path.join(f.root, handoff))
    } else {
      writeFileSync(path.join(f.root, handoff), 'not yet delivered\n')
      if (kind === 'unpublished') commit(f.root, 'local handoff')
      if (kind === 'staged') git(f.root, 'add', handoff)
    }
    blocked(f.run({ handoff: selected, apply: true }), 'handoff')
    assert.ok(existsSync(f.target))
  })
}

test('directory-aggregated ignored entries require precise review of every entry', t => {
  const f = fixture(t)
  mkdirSync(path.join(f.target, 'cache'))
  writeFileSync(path.join(f.target, 'cache/evidence.log'), 'keep until reviewed\n')
  writeFileSync(path.join(f.target, 'other.log'), 'keep too\n')
  const result = f.run({ apply: true })
  blocked(result, 'ignored')
  assert.deepEqual(result.ignored, ['cache/', 'other.log'])
  blocked(f.run({ discard: ['cache'] }), 'ignored')
  for (const invalid of ['.', '..', 'cache/*', 'cache/evidence.log', '/cache', 'missing', 'cache/../other.log']) blocked(f.run({ discard: [invalid] }), 'discard')
  assert.equal(readFileSync(path.join(f.target, 'cache/evidence.log'), 'utf8'), 'keep until reviewed\n')
})

test('explicit exact discarded ignored entries permit ordinary git removal', mac, t => {
  const f = fixture(t)
  mkdirSync(path.join(f.target, 'cache'))
  writeFileSync(path.join(f.target, 'cache/artifact.log'), 'reviewed disposable artifact\n')
  writeFileSync(path.join(f.target, 'other.log'), 'reviewed disposable log\n')
  const result = f.run({ discard: ['cache', 'other.log'], apply: true })
  assert.deepEqual(result.blockers, [])
  assert.equal(result.removed, true)
  assert.equal(existsSync(f.target), false)
  assert.deepEqual(receipt(result).discard, ['cache', 'other.log'])
})

test('primary, main, self, foreign, locked, non-root and symlink paths are refused', t => {
  const f = fixture(t)
  blocked(f.run({ worktree: f.root }), 'primary')
  blocked(closeoutTask({ root: f.target, worktree: f.target, handoff }), 'self')
  git(f.root, 'checkout', '-b', 'retained')
  git(f.target, 'checkout', 'main')
  blocked(f.run(), 'branch')
  git(f.target, 'checkout', 'task')
  git(f.root, 'worktree', 'lock', f.target)
  blocked(f.run(), 'protected')
  git(f.root, 'worktree', 'unlock', f.target)
  blocked(f.run({ worktree: path.join(f.target, 'docs') }), 'unregistered')
  const foreign = path.join(f.directory, 'foreign')
  mkdirSync(foreign)
  git(foreign, 'init', '-b', 'task')
  blocked(f.run({ worktree: foreign }), 'unregistered')
  const alias = path.join(f.directory, 'alias')
  symlinkSync(f.target, alias)
  blocked(f.run({ worktree: alias }), 'path')
  const parentAlias = path.join(f.directory, 'parent-alias')
  symlinkSync(f.directory, parentAlias)
  blocked(f.run({ worktree: path.join(parentAlias, 'task') }), 'path')
  assert.ok(existsSync(f.target) && existsSync(f.other))
})

for (const kind of ['cwd', 'open']) {
  test(`a live process holding target ${kind} blocks removal`, mac, async t => {
    const f = fixture(t)
    const source = kind === 'open'
      ? "require('node:fs').openSync(process.argv[1], 'r'); console.log('ready'); setInterval(() => {}, 1000)"
      : "console.log('ready'); setInterval(() => {}, 1000)"
    const child = spawn(process.execPath, ['-e', source, path.join(f.target, 'product.js')], { cwd: kind === 'cwd' ? f.target : f.root, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await once(child.stdout, 'data')
      const result = f.run({ apply: true })
      blocked(result, 'in-use')
      assert.ok(result.inUse.some(entry => entry.pid === child.pid && (entry.path === f.target || entry.path.startsWith(f.target + '/'))))
      assert.ok(result.inUse.every(entry => entry.path === f.target || entry.path.startsWith(f.target + '/')))
      assert.ok(existsSync(f.target))
    } finally {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
  })
}

test('real CLI reports JSON and nonzero exit for dirty targets and invalid arguments', t => {
  const f = fixture(t)
  const invoke = args => spawnSync(process.execPath, [path.join(f.root, 'scripts/closeout-task.mjs'), ...args], { cwd: f.root, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
  const clean = invoke(['--worktree', f.target, '--handoff', handoff])
  assert.equal(clean.status, 0, clean.stderr + clean.stdout)
  assert.equal(JSON.parse(clean.stdout).removed, false)
  writeFileSync(path.join(f.target, 'docs/pending.md'), 'pending\n')
  const dirty = invoke(['--worktree', f.target, '--handoff', handoff, '--apply'])
  assert.equal(dirty.status, 1)
  blocked(JSON.parse(dirty.stdout), 'dirty')
  const usage = invoke(['--apply'])
  assert.equal(usage.status, 1)
  blocked(JSON.parse(usage.stdout), 'usage')
  assert.ok(existsSync(f.target))
})

test('receipt directory symlink refuses apply without touching its destination', t => {
  const f = fixture(t), outside = path.join(f.directory, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, path.join(f.root, '.git/task-closeouts'))
  blocked(f.run({ apply: true }), 'receipt')
  assert.ok(existsSync(f.target))
})

test('non-macOS apply explicitly preserves target', { skip: process.platform === 'darwin' }, t => {
  const f = fixture(t)
  blocked(f.run({ apply: true }), 'unsupported')
  assert.ok(existsSync(f.target))
})

test('master and nested registered worktrees are protected', t => {
  const f = fixture(t)
  git(f.target, 'checkout', '-b', 'master')
  blocked(f.run(), 'branch')
  git(f.target, 'checkout', 'task')
  const nested = path.join(f.target, 'nested')
  git(f.root, 'worktree', 'add', '-b', 'nested', nested)
  blocked(f.run({ apply: true }), 'nested')
  blocked(f.run({ worktree: nested, apply: true }), 'nested')
  assert.ok(existsSync(nested))
})

test('CLI refuses its own cwd even when invoked from a separate retained entry', t => {
  const f = fixture(t)
  const result = spawnSync(process.execPath, [path.join(f.root, 'scripts/closeout-task.mjs'), '--worktree', f.target, '--handoff', handoff, '--apply'], { cwd: f.target, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
  assert.equal(result.status, 1)
  blocked(JSON.parse(result.stdout), 'self')
  assert.ok(existsSync(f.target))
})

test('blocked attempts receive distinct durable receipts without overwriting prior results', t => {
  const f = fixture(t)
  writeFileSync(path.join(f.target, 'docs/pending.md'), 'pending\n')
  const first = f.run({ apply: true })
  const original = readFileSync(first.receiptPath, 'utf8')
  const second = f.run({ apply: true })
  assert.notEqual(first.receiptPath, second.receiptPath)
  assert.equal(readFileSync(first.receiptPath, 'utf8'), original)
  assert.equal(receipt(second).removed, false)
  blocked(first, 'dirty')
  blocked(second, 'dirty')
})

for (const flag of ['assume-unchanged', 'skip-worktree']) {
  test(`${flag} cannot hide local source changes from closeout`, t => {
    const f = fixture(t)
    git(f.target, 'update-index', `--${flag}`, 'product.js')
    writeFileSync(path.join(f.target, 'product.js'), 'hidden local source that must survive\n')
    assert.equal(git(f.target, 'status', '--porcelain'), '')
    const index = git(f.target, 'ls-files', '-v', 'product.js')
    const result = f.run({ apply: true })
    blocked(result, 'index-flags')
    assert.ok(result.protectedIndex.some(entry => entry.path === 'product.js'))
    assert.equal(readFileSync(path.join(f.target, 'product.js'), 'utf8'), 'hidden local source that must survive\n')
    assert.equal(git(f.target, 'ls-files', '-v', 'product.js'), index)
    assert.equal(receipt(result).removed, false)
  })
}

test('non-boolean apply is rejected before receipt creation or deletion', t => {
  const f = fixture(t)
  for (const apply of ['true', 'false', 1, 0, null, [], {}]) {
    const result = f.run({ apply })
    blocked(result, 'apply-type')
    assert.equal(result.receiptPath, null)
    assert.ok(existsSync(f.target))
  }
  assert.equal(existsSync(path.join(f.root, '.git/task-closeouts')), false)
})

test('structured dirty entries expose all affected paths including rename source', t => {
  const f = fixture(t)
  git(f.target, 'mv', 'product.js', 'docs/renamed.js')
  writeFileSync(path.join(f.target, handoff), 'unstaged handoff\n')
  writeFileSync(path.join(f.target, 'docs/untracked.md'), 'untracked evidence\n')
  const result = f.run({ apply: true })
  blocked(result, 'dirty')
  assert.deepEqual(result.dirty, [
    { status: ' M', path: handoff },
    { status: 'R ', path: 'docs/renamed.js', originalPath: 'product.js' },
    { status: '??', path: 'docs/untracked.md' }
  ])
  assert.deepEqual(result.blockers.find(item => item.code === 'dirty').entries, result.dirty)
  assert.deepEqual(receipt(result).dirty, result.dirty)
})

test('real git submodule removal refusal retains diagnostics and observed removal state', mac, t => {
  const f = fixture(t)
  git(f.root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-b', 'main', f.remote, 'modules/dependency')
  const head = commit(f.root, 'tracked submodule')
  git(f.root, 'push', 'origin', 'main')
  git(f.target, 'merge', '--ff-only', head)
  git(f.target, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init')
  const result = f.run({ apply: true })
  blocked(result, 'command-failed')
  assert.ok(result.blockers.some(entry => /submodule/i.test(entry.message)), JSON.stringify(result))
  assert.deepEqual(result.removalState, { directoryPresent: true, registered: true })
  assert.equal(result.stage, 'remove-incomplete-materials-unverified')
  assert.ok(existsSync(f.target))
  assert.deepEqual(receipt(result).removalState, result.removalState)
})
