import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { dirtyProductPaths, pushMain } from './push-main.mjs'

const origin = 'https://github.com/Zixiaobowen/oc-chan.git'
const mac = { skip: process.platform !== 'darwin', timeout: 60_000 }
function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}
function commit(root, message) {
  git(root, 'add', '--all')
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}
function fixture(t) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'oc-chan-push-test-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'working'), remote = path.join(directory, 'remote.git')
  mkdirSync(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'OC Chan test')
  git(root, 'config', 'user.email', 'oc-chan-test@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.hooksPath', path.join(root, '.git/hooks'))
  git(root, 'init', '--bare', remote)
  git(remote, 'config', 'user.name', 'OC Chan test')
  git(remote, 'config', 'user.email', 'oc-chan-test@example.invalid')
  git(remote, 'config', 'commit.gpgsign', 'false')
  git(remote, 'config', 'core.hooksPath', path.join(remote, 'hooks'))
  git(root, 'remote', 'add', 'origin', origin)
  // Exercise real Git push/fetch/hooks locally without weakening the production URL allowlist.
  git(root, 'config', `url.${remote}.insteadOf`, origin)
  writeFileSync(path.join(root, '.gitignore'), '.dev-instances/\nrelease/\n')
  writeFileSync(path.join(root, 'product.js'), 'export const value = 1\n')
  mkdirSync(path.join(root, 'docs'))
  writeFileSync(path.join(root, 'docs/handoff.md'), 'initial\n')
  mkdirSync(path.join(root, 'scripts'))
  for (const filename of ['push-main.mjs', 'local-app-lifecycle.mjs']) {
    copyFileSync(new URL(`./${filename}`, import.meta.url), path.join(root, 'scripts', filename))
  }
  const initial = commit(root, 'initial')
  return { directory, root, remote, initial }
}

async function realPush(root) {
  return (await import(pathToFileURL(path.join(root, 'scripts/push-main.mjs')).href)).pushMain
}

function application(root) {
  const app = path.join(root, 'release/mac-arm64/OC Chan.app')
  mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true })
  writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.oc-chan.desktop</string><key>CFBundleExecutable</key><string>OC Chan</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
  copyFileSync('/bin/sleep', path.join(app, 'Contents/MacOS/OC Chan'))
  const retained = ['release/archive.zip', 'release/archive.dmg', 'release/delivery.json', 'release/evidence.log']
  for (const name of retained) writeFileSync(path.join(root, name), name)
  return { app, assertRetained: () => {
    for (const name of retained) assert.equal(readFileSync(path.join(root, name), 'utf8'), name)
    assert.equal(existsSync(path.join(root, 'product.js')), true)
    assert.equal(existsSync(path.join(root, '.git')), true)
  } }
}
function hook(directory, name, source) {
  const file = path.join(directory, name)
  writeFileSync(file, `#!/bin/sh\nset -eu\n${source}\n`)
  chmodSync(file, 0o700)
}
function record() {
  const cleaned = [], messages = []
  return { cleaned, messages, cleanup: async request => { cleaned.push(request); return { root: request.root, apply: request.apply } }, report: message => messages.push(message) }
}

test('ordinary push retains hooks and a rejected push never invokes cleanup', async t => {
  const { root, remote } = fixture(t), calls = record()
  hook(path.join(root, '.git/hooks'), 'pre-push', 'exit 1')
  await assert.rejects(pushMain({ root, ...calls }))
  assert.deepEqual(calls.cleaned, [])
  assert.throws(() => git(remote, 'rev-parse', '--verify', 'refs/heads/main'))
})

test('non-main and unrelated configured origins are rejected before push', async t => {
  const { root, remote } = fixture(t), calls = record()
  git(root, 'checkout', '-b', 'feature')
  await assert.rejects(pushMain({ root, ...calls }), /仅允许在 main/)
  git(root, 'checkout', 'main')
  git(root, 'remote', 'set-url', 'origin', 'https://github.com/example/oc-chan.git')
  await assert.rejects(pushMain({ root, ...calls }), /本项目 GitHub origin/)
  git(root, 'remote', 'set-url', 'origin', origin)
  git(root, 'remote', 'set-url', '--push', 'origin', 'https://github.com/example/oc-chan.git')
  await assert.rejects(pushMain({ root, ...calls }), /本项目 GitHub origin/)
  assert.deepEqual(calls.cleaned, [])
  assert.throws(() => git(remote, 'rev-parse', '--verify', 'refs/heads/main'))
})

test('successful transport with a remote main that no longer includes the commit never cleans', async t => {
  const { root, remote, initial } = fixture(t), calls = record()
  writeFileSync(path.join(root, 'product.js'), 'export const value = 2\n')
  commit(root, 'new product')
  hook(path.join(remote, 'hooks'), 'post-receive', `git update-ref refs/heads/main ${initial}`)
  await assert.rejects(pushMain({ root, ...calls }), /推送命令已成功.*未执行任何清理/)
  assert.equal(git(remote, 'rev-parse', 'main'), initial)
  assert.deepEqual(calls.cleaned, [])
})

test('a concurrent remote fast-forward containing the pushed commit permits real application cleanup', mac, async t => {
  const { root, remote, initial } = fixture(t)
  const source = application(root)
  const push = await realPush(root)
  hook(path.join(remote, 'hooks'), 'post-receive', 'read old new ref\ntree=$(git rev-parse "$new^{tree}")\nnext=$(git commit-tree "$tree" -p "$new" -m "concurrent advance")\ngit update-ref refs/heads/main "$next"')
  const result = await push({ root })
  assert.equal(result.commit, initial)
  assert.notEqual(result.remote, initial)
  assert.equal(existsSync(source.app), false)
  source.assertRetained()
})

test('real cleanup removes merged worktree apps and preserves dirty or unmerged worktree apps', mac, async t => {
  const { directory, root } = fixture(t)
  const messages = []
  const clean = path.join(directory, 'merged docs'), dirty = path.join(directory, 'dirty'), unmerged = path.join(directory, 'unmerged')
  git(root, 'worktree', 'add', '-b', 'merged-docs', clean)
  git(root, 'worktree', 'add', '-b', 'dirty-code', dirty)
  git(root, 'worktree', 'add', '-b', 'unmerged-code', unmerged)
  writeFileSync(path.join(clean, 'docs/handoff.md'), 'ongoing documentation\n')
  writeFileSync(path.join(clean, 'docs/audit.md'), 'untracked audit\n')
  mkdirSync(path.join(clean, 'docs/codex-handoffs'))
  writeFileSync(path.join(clean, 'docs/codex-handoffs/audit.html'), '<p>handoff evidence</p>\n')
  writeFileSync(path.join(dirty, 'product.js'), 'uncommitted product\n')
  writeFileSync(path.join(unmerged, 'product.js'), 'unmerged product\n')
  commit(unmerged, 'not merged')
  const sources = new Map([root, clean, dirty, unmerged].map(worktree => [worktree, application(worktree)]))
  const push = await realPush(root)
  const result = await push({ root, report: message => messages.push(message) })
  for (const worktree of [root, clean]) assert.equal(existsSync(sources.get(worktree).app), false)
  for (const worktree of [dirty, unmerged]) assert.equal(existsSync(sources.get(worktree).app), true)
  for (const source of sources.values()) source.assertRetained()
  assert.equal(readFileSync(path.join(clean, 'docs/handoff.md'), 'utf8'), 'ongoing documentation\n')
  assert.equal(readFileSync(path.join(clean, 'docs/audit.md'), 'utf8'), 'untracked audit\n')
  assert.equal(readFileSync(path.join(clean, 'docs/codex-handoffs/audit.html'), 'utf8'), '<p>handoff evidence</p>\n')
  assert.equal(readFileSync(path.join(dirty, 'product.js'), 'utf8'), 'uncommitted product\n')
  assert.equal(result.outcomes.find(item => item.root === dirty).retained, 'dirty-code')
  assert.equal(result.outcomes.find(item => item.root === unmerged).retained, 'unmerged')
  assert.ok(messages.some(message => message.includes('未提交产品文件')))
  assert.ok(messages.some(message => message.includes('尚未合入')))
})

test('staged renames into docs, untracked product files and docs policy JSON protect worktrees', t => {
  const { root } = fixture(t)
  git(root, 'mv', 'product.js', 'docs/disguised.md')
  writeFileSync(path.join(root, 'new-product.js'), 'untracked\n')
  writeFileSync(path.join(root, 'docs/package-baseline.json'), '{}\n')
  writeFileSync(path.join(root, 'docs/product.html'), '<p>uncommitted product</p>\n')
  assert.deepEqual(dirtyProductPaths(root).sort(), ['docs/package-baseline.json', 'docs/product.html', 'new-product.js', 'product.js'])
})

test('cleanup errors report a successful push distinctly and preserve other worktrees processing', async t => {
  const { directory, root, remote, initial } = fixture(t), calls = record()
  const second = path.join(directory, 'second')
  git(root, 'worktree', 'add', '-b', 'second', second)
  await assert.rejects(pushMain({ root, report: calls.report, cleanup: async request => {
    calls.cleaned.push(request)
    if (request.root === root) throw new Error('owned instance is still running')
  } }), error => error instanceof AggregateError && /推送及确认已成功.*清理失败/.test(error.message) && error.errors.length === 1)
  assert.equal(git(remote, 'rev-parse', 'main'), initial)
  assert.deepEqual(calls.cleaned.map(item => item.root).sort(), [root, second].sort())
})

test('real cleanup preserves previously merged parallel worktree apps and removes newly merged apps', mac, async t => {
  const { directory, root, initial } = fixture(t)
  const messages = []
  git(root, 'push', 'origin', 'main')
  const previous = path.join(directory, 'previously merged'), current = path.join(directory, 'newly merged')
  git(root, 'worktree', 'add', '-b', 'previous-task', previous)
  writeFileSync(path.join(root, 'product.js'), 'export const value = 3\n')
  commit(root, 'newly merged task')
  git(root, 'worktree', 'add', '-b', 'current-task', current)
  const sources = new Map([root, previous, current].map(worktree => [worktree, application(worktree)]))
  const push = await realPush(root)
  const result = await push({ root, report: message => messages.push(message) })
  assert.equal(result.previousRemote, initial)
  for (const worktree of [root, current]) assert.equal(existsSync(sources.get(worktree).app), false)
  assert.equal(existsSync(sources.get(previous).app), true)
  for (const source of sources.values()) source.assertRetained()
  assert.equal(result.outcomes.find(item => item.root === previous).retained, 'previously-merged')
  assert.ok(messages.some(message => message.includes('推送前已合入')))
})

test('a missing remote ref after successful push never invokes cleanup', async t => {
  const { root, remote } = fixture(t), calls = record()
  hook(path.join(remote, 'hooks'), 'post-receive', 'git update-ref -d refs/heads/main')
  await assert.rejects(pushMain({ root, ...calls }), /推送命令已成功.*未执行任何清理/)
  assert.deepEqual(calls.cleaned, [])
})
