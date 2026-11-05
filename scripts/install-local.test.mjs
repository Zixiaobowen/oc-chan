import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pushedCommit, replaceBundle } from './install-local.mjs'

const sha = 'a'.repeat(40)
const other = 'b'.repeat(40)
const zero = '0'.repeat(40)
const remote = 'https://github.com/Zixiaobowen/oc-chan.git'
const ref = (local = sha, target = 'refs/heads/feature') => `refs/heads/feature ${local} ${target} ${zero}\n`

test('GitHub branch pushes select the pushed commit across supported URL forms', () => {
  for (const url of [remote, 'https://github.com/Zixiaobowen/oc-chan', 'git@github.com:Zixiaobowen/oc-chan.git', 'ssh://git@github.com/Zixiaobowen/oc-chan.git']) {
    assert.equal(pushedCommit(url, ref()), sha)
  }
  assert.equal(pushedCommit(remote, ref() + ref(sha, 'refs/heads/second')), sha)
})

test('unrelated remotes, tag-only pushes, deletion and empty pushes never install', () => {
  for (const url of ['https://github.com/example/oc-chan.git', 'https://github.com.evil.test/Zixiaobowen/oc-chan.git', '/tmp/oc-chan.git']) {
    assert.equal(pushedCommit(url, ref()), null)
  }
  for (const input of ['', '\n', ref(sha, 'refs/tags/v1'), `(delete) ${zero} refs/heads/feature ${sha}\n`]) {
    assert.equal(pushedCommit(remote, input), null)
  }
})

test('ambiguous or malformed branch pushes fail before installation', () => {
  assert.throws(() => pushedCommit(remote, ref() + ref(other, 'refs/heads/second')), /多个分支/)
  for (const input of ['bad input', ref('not-a-sha'), `${ref().trim()} extra`]) {
    assert.throws(() => pushedCommit(remote, input), /无效/)
  }
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

test('successful replacement removes obsolete bundle files and keeps user settings', async t => {
  const { target, staging, staged, settings } = fixture(t)
  await replaceBundle(staged, target, { stop: noAction, start: () => assert.equal(readFileSync(path.join(target, 'version'), 'utf8'), 'new') })
  assert.deepEqual(readdirSync(target), ['version'])
  assert.deepEqual(readdirSync(staging), [])
  assert.equal(readFileSync(settings, 'utf8'), '{"language":"en"}')
})

test('launch failure restores the entire old bundle and retains failed new bundle for diagnosis', async t => {
  const { target, staged } = fixture(t)
  await assert.rejects(replaceBundle(staged, target, { stop: noAction, start: () => { throw new Error('launch failed') } }), /旧应用已还原/)
  assert.equal(readFileSync(path.join(target, 'version'), 'utf8'), 'old')
  assert.equal(readFileSync(path.join(target, 'obsolete'), 'utf8'), 'old-only resource')
  assert.equal(readFileSync(path.join(staged, 'version'), 'utf8'), 'new')
})

test('an app that refuses to quit is never removed', async t => {
  const { target, staged } = fixture(t)
  await assert.rejects(replaceBundle(staged, target, { stop: () => { throw new Error('quit refused') }, start: noAction }), /quit refused/)
  assert.equal(readFileSync(path.join(target, 'version'), 'utf8'), 'old')
  assert.equal(readFileSync(path.join(staged, 'version'), 'utf8'), 'new')
})

test('a failed move restores the old bundle', async t => {
  const { target, staged } = fixture(t)
  rmSync(staged, { recursive: true })
  await assert.rejects(replaceBundle(staged, target, { stop: noAction, start: noAction }), /旧应用已还原/)
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
