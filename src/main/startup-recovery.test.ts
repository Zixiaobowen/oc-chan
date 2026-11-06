import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { StartupSettingsRecovery, startupSettingsFailure } from './startup-recovery'
import { readSettings, SETTINGS_MAX_BYTES } from './settings'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/settings'
import { DiagnosticError } from '../shared/diagnostics'
import type { StartupFailureReason } from '../shared/startup-recovery'

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-recovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return path.join(directory, 'settings.json')
}

test('read failures explain malformed, invalid, oversized and non-UTF8 files without modifying them or revealing content', async t => {
  const filename = await fixture(t)
  const cases: [string | Buffer, StartupFailureReason][] = [
    ['{"private-config-secret":', 'invalid-json'],
    ['{"codeFont":"private-config-secret"}', 'invalid-values'],
    ['{"private-config-secret":true}', 'invalid-values'],
    [Buffer.alloc(SETTINGS_MAX_BYTES + 1, 32), 'too-large'],
    [Buffer.from([0xc3, 0x28]), 'invalid-encoding']
  ]
  for (const [content, reason] of cases) {
    await writeFile(filename, content, { mode: 0o600 })
    const before = await stat(filename)
    await assert.rejects(readSettings(filename), error => {
      const failure = startupSettingsFailure(error, filename)
      assert.equal(failure.reason, reason)
      assert.equal(failure.filePath, filename)
      assert.ok(!failure.details.includes('private-config-secret'))
      assert.ok(!failure.details.includes(filename))
      return true
    })
    assert.deepEqual(await readFile(filename), Buffer.from(content))
    const after = await stat(filename)
    assert.equal(after.mode, before.mode)
    assert.equal(after.mtimeMs, before.mtimeMs)
  }
})

test('access denied stays an explicit failure and leaves original permissions unchanged', { skip: process.getuid?.() === 0 }, async t => {
  const filename = await fixture(t)
  await writeFile(filename, '{}')
  await chmod(filename, 0)
  t.after(() => chmod(filename, 0o600).catch(error => { if (error.code !== 'ENOENT') throw error }))
  await assert.rejects(readSettings(filename), error => {
    assert.equal(startupSettingsFailure(error, filename).reason, 'permission-denied')
    return true
  })
  assert.equal((await stat(filename)).mode & 0o777, 0)
  await chmod(filename, 0o600)
  assert.equal(await readFile(filename, 'utf8'), '{}')
})

test('failed re-read replaces diagnostics; repairing the same file releases valid settings once', async t => {
  const filename = await fixture(t)
  await writeFile(filename, '{invalid')
  let initial: unknown
  try { await readSettings(filename) } catch (error) { initial = error }
  const recovery = new StartupSettingsRecovery(filename, initial)
  assert.equal(recovery.failure.reason, 'invalid-json')
  await writeFile(filename, '{"unknown":true}')
  assert.equal((await recovery.retry()).kind, 'failed')
  assert.equal(recovery.failure.reason, 'invalid-values')
  await writeFile(filename, '{"language":"en","sidebarWidth":260}')
  const result = await recovery.retry()
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') throw new Error('Expected recovery')
  assert.deepEqual(result.settings, { ...DEFAULT_SETTINGS, language: 'en', sidebarWidth: 260 })
  await writeFile(filename, '{changed-after-recovery')
  assert.strictEqual(await recovery.retry(), result)
  await recovery.close()
  assert.deepEqual(await recovery.retry(), { kind: 'closed' })
  assert.equal(await readFile(filename, 'utf8'), '{changed-after-recovery')
})

test('concurrent re-reads share one operation and close drains it without resuming startup', async () => {
  let finish!: (settings: AppSettings) => void
  let reads = 0
  const recovery = new StartupSettingsRecovery('/unused/settings.json', new DiagnosticError('settings-decode', undefined, 'OC_SETTINGS_INVALID'), () => {
    reads++
    return new Promise(resolve => { finish = resolve })
  })
  const first = recovery.retry()
  for (let index = 0; index < 100; index++) assert.strictEqual(recovery.retry(), first)
  assert.equal(reads, 1)
  let drained = false
  const closing = recovery.close().then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)
  finish({ ...DEFAULT_SETTINGS })
  assert.deepEqual(await first, { kind: 'closed' })
  await closing
  assert.equal(drained, true)
  assert.deepEqual(await recovery.retry(), { kind: 'closed' })
  assert.equal(reads, 1)
})
