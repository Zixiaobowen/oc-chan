import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deliveryCleanupRoot, installOptions, replaceBundle as replaceTransaction } from './install-local.mjs'
import { acquireInstallLock, checkInstallSpace, checkInstallTarget, installationJson } from './install-validation.mjs'

test('installation is explicit and rejects the removed pre-push entry', () => {
  assert.deepEqual(installOptions([]), { mode: 'current' })
  assert.deepEqual(installOptions(['--check-delivery', '/delivery']), { mode: 'check', directory: '/delivery' })
  assert.throws(() => installOptions(['--pre-push', 'origin', 'https://github.com/Zixiaobowen/oc-chan.git']), /Usage/)
})

function fixture(t, installed = true) {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-chan-install-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'OC Chan.app')
  const staging = path.join(dir, 'staging')
  const staged = path.join(staging, 'OC Chan.app')
  mkdirSync(staged, { recursive: true })
  writeFileSync(path.join(staged, 'version'), 'new')
  if (installed) {
    mkdirSync(target)
    writeFileSync(path.join(target, 'version'), 'old')
    writeFileSync(path.join(target, 'obsolete'), 'old-only resource')
  }
  const settings = path.join(dir, 'user-settings.json')
  writeFileSync(settings, '{"language":"en"}')
  return { dir, target, staging, staged, settings }
}
const noAction = () => {}
const replaceBundle = (staged, target, callbacks) => replaceTransaction(staged, target, { restart: noAction, validate: noAction, ...callbacks })

test('successful replacement removes obsolete bundle files and keeps user settings', async t => {
  const { target, staging, staged, settings } = fixture(t)
  await replaceBundle(staged, target, { stop: noAction, start: () => assert.equal(readFileSync(path.join(target, 'version'), 'utf8'), 'new') })
  assert.deepEqual(readdirSync(target), ['version'])
  assert.deepEqual(readdirSync(staging), ['replace-journal.json'])
  assert.equal(JSON.parse(readFileSync(path.join(staging, 'replace-journal.json'), 'utf8')).phase, 'committed')
  assert.equal(readFileSync(settings, 'utf8'), '{"language":"en"}')
})

test('launch failure restores the entire old bundle and retains failed new bundle for diagnosis', async t => {
  const { target, staged } = fixture(t)
  await assert.rejects(replaceBundle(staged, target, { stop: noAction, start: () => { throw new Error('launch failed') } }), /旧应用已还原/)
  assert.equal(readFileSync(path.join(target, 'version'), 'utf8'), 'old')
  assert.equal(readFileSync(path.join(target, 'obsolete'), 'utf8'), 'old-only resource')
  assert.equal(readFileSync(path.join(staged, 'version'), 'utf8'), 'new')
})

test('failed readiness restores and restarts the old application', async t => {
  const { target, staged } = fixture(t); let restarted = false
  await assert.rejects(replaceBundle(staged, target, {
    stop: noAction, start: () => { throw new Error('actual readiness failed') },
    restart: () => { assert.equal(readFileSync(path.join(target, 'version'), 'utf8'), 'old'); restarted = true }
  }), /旧应用已还原/)
  assert.equal(restarted, true)
})
test('post-drain validation failure keeps the original target and resumes it', async t => {
  const { target, staged } = fixture(t); let restarted = false, started = false
  await assert.rejects(replaceBundle(staged, target, {
    stop: noAction, start: () => { started = true }, restart: () => { restarted = true },
    validate: () => { throw new Error('candidate changed after drain') }
  }), /candidate changed/)
  assert.equal(restarted, true); assert.equal(started, false)
  assert.equal(readFileSync(path.join(target, 'version'), 'utf8'), 'old')
  assert.equal(readFileSync(path.join(staged, 'version'), 'utf8'), 'new')
})
test('an app that refuses to quit is never removed', async t => {
  const { target, staged } = fixture(t)
  await assert.rejects(replaceBundle(staged, target, { stop: () => { throw new Error('quit refused') }, start: noAction }), /quit refused/)
  assert.equal(readFileSync(path.join(target, 'version'), 'utf8'), 'old')
  assert.equal(readFileSync(path.join(staged, 'version'), 'utf8'), 'new')
})

test('missing staged bundle is rejected before stopping the old app', async t => {
  const { target, staged } = fixture(t)
  rmSync(staged, { recursive: true })
  let stops = 0
  await assert.rejects(replaceBundle(staged, target, { stop: () => { stops++ }, start: noAction }), { code: 'ENOENT' })
  assert.equal(stops, 0)
  assert.equal(readFileSync(path.join(target, 'version'), 'utf8'), 'old')
})

test('a failed first installation leaves no broken target app', async t => {
  const { target, staged } = fixture(t, false)
  await assert.rejects(replaceBundle(staged, target, { stop: noAction, start: () => { throw new Error('launch failed') } }), /已撤销新安装/)
  assert.equal(existsSync(target), false)
  assert.equal(readFileSync(path.join(staged, 'version'), 'utf8'), 'new')
})

test('a rollback failure preserves both apps and reports both errors', async t => {
  const { target, staging, staged } = fixture(t)
  let stops = 0
  await assert.rejects(replaceBundle(staged, target, {
    stop: () => { if (++stops === 2) throw new Error('new app refuses to quit') },
    start: () => { throw new Error('launch verification failed') }
  }), error => error instanceof AggregateError && error.errors.length === 2 && /保留现场/.test(error.message))
  assert.equal(readFileSync(path.join(target, 'version'), 'utf8'), 'new')
  assert.equal(readFileSync(path.join(staging, 'previous.app/version'), 'utf8'), 'old')
})

test('an occupied backup location is preserved before any stop or replacement', async t => {
  const { target, staging, staged } = fixture(t)
  mkdirSync(path.join(staging, 'previous.app'))
  writeFileSync(path.join(staging, 'previous.app/evidence'), 'older failed transaction')
  let stops = 0
  await assert.rejects(replaceBundle(staged, target, { stop: () => { stops++ }, start: noAction }), /还原位置.*已存在/)
  assert.equal(stops, 0)
  assert.equal(readFileSync(path.join(staging, 'previous.app/evidence'), 'utf8'), 'older failed transaction')
  assert.equal(readFileSync(path.join(target, 'version'), 'utf8'), 'old')
})
for (const which of ['target', 'staged']) test(`symlink ${which} cannot redirect an installation`, async t => {
  const f = fixture(t)
  const real = path.join(f.dir, `real-${which}`)
  renameSync(f[which], real)
  symlinkSync(real, f[which])
  let stops = 0
  await assert.rejects(replaceBundle(f.staged, f.target, { stop: () => { stops++ }, start: noAction }), /真实目录|符号链接/)
  assert.equal(stops, 0)
  assert.equal(readFileSync(path.join(real, 'version'), 'utf8'), which === 'target' ? 'old' : 'new')
})
test('a target changed during graceful quit is never overwritten', async t => {
  const f = fixture(t)
  const moved = path.join(f.dir, 'other-transaction.app')
  await assert.rejects(replaceBundle(f.staged, f.target, { stop: () => {
    renameSync(f.target, moved)
    mkdirSync(f.target)
    writeFileSync(path.join(f.target, 'version'), 'other')
  }, start: noAction }), /目标发生变化/)
  assert.equal(readFileSync(path.join(f.target, 'version'), 'utf8'), 'other')
  assert.equal(readFileSync(path.join(moved, 'version'), 'utf8'), 'old')
  assert.equal(readFileSync(path.join(f.staged, 'version'), 'utf8'), 'new')
})
test('existing installation locks are never removed or overwritten', t => {
  const f = fixture(t, false)
  const lock = path.join(f.dir, '.lock')
  acquireInstallLock(lock, { pid: 123 })()
  assert.throws(() => acquireInstallLock(lock, { pid: 456 }), /已有安装任务/)
  assert.deepEqual(JSON.parse(readFileSync(path.join(lock, 'owner.json'), 'utf8')), { pid: 123 })
})
test('space preflight reserves the full new app, metadata blocks and a safety margin', t => {
  const f = fixture(t, false)
  const inventory = { appBytes: 270699367, entries: Array(610).fill(null) }
  assert.throws(() => checkInstallSpace(f.dir, inventory, () => ({ bavail: 1n, bsize: 4096n })), /磁盘空间不足/)
  const required = BigInt(inventory.appBytes + 610 * 4096 + 64 * 1024 ** 2)
  assert.equal(checkInstallSpace(f.dir, inventory, () => ({ bavail: required, bsize: 1n })), required)
  assert.equal(readFileSync(f.settings, 'utf8'), '{"language":"en"}')
})
test('write-permission refusal leaves settings untouched', t => {
  const f = fixture(t, false)
  chmodSync(f.dir, 0o500)
  try { assert.throws(() => checkInstallTarget(f.target), /not writable/) }
  finally { chmodSync(f.dir, 0o700) }
  assert.equal(readFileSync(f.settings, 'utf8'), '{"language":"en"}')
  assert.equal(existsSync(f.target), false)
})
test('oversized or symlinked source manifests are rejected before JSON parsing', async t => {
  const f = fixture(t, false)
  const file = path.join(f.dir, 'metadata.json')
  writeFileSync(file, 'x'.repeat(1025))
  await assert.rejects(installationJson(file, 1024), /bounded regular file/)
  const link = path.join(f.dir, 'link.json')
  symlinkSync(file, link)
  await assert.rejects(installationJson(link), { code: 'ELOOP' })
})

function deliveryRepository(t) {
  const f = fixture(t, false)
  const root = path.join(realpathSync(f.dir), 'workspace')
  mkdirSync(root)
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  git(root, 'init', '-b', 'main')
  git(root, '-c', 'user.name=OC Chan test', '-c', 'user.email=oc-chan-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial')
  return { ...f, root, git }
}

test('delivery cleanup resolves the actual registered worktree containing release artifacts', t => {
  const { dir, root, git } = deliveryRepository(t)
  const worktree = path.join(realpathSync(dir), 'delivery worktree')
  git(root, 'worktree', 'add', '-b', 'delivery', worktree)
  const application = path.join(worktree, 'release/tauri/local-delivery/OC Chan.app')
  mkdirSync(application, { recursive: true })
  assert.equal(deliveryCleanupRoot({ root, application }), worktree)
  assert.equal(existsSync(application), true)
})

test('external deliveries and symlink escapes are rejected without deleting their applications', t => {
  const { dir, root } = deliveryRepository(t)
  const outside = path.join(dir, 'external/OC Chan.app')
  mkdirSync(outside, { recursive: true })
  mkdirSync(path.join(root, 'release'))
  const escape = path.join(root, 'release/OC Chan.app')
  symlinkSync(outside, escape)
  for (const application of [outside, escape]) {
    assert.throws(() => deliveryCleanupRoot({ root, application }), /不属于本仓库.*已保留来源/)
    assert.equal(existsSync(application), true)
  }
})

test('delivery cleanup refuses an unrelated repository release tree', t => {
  const { dir, root, git } = deliveryRepository(t)
  const foreign = path.join(dir, 'foreign')
  mkdirSync(foreign)
  git(foreign, 'init', '-b', 'main')
  const application = path.join(foreign, 'release/tauri/package/OC Chan.app')
  mkdirSync(application, { recursive: true })
  assert.throws(() => deliveryCleanupRoot({ root, application }), /不属于本仓库/)
  assert.equal(existsSync(application), true)
})
