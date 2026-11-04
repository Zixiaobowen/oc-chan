import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings, type SettingsFailureReason } from '../shared/settings'
import { readSettings, SettingsRollbackError, SettingsStore, settingsUpdateFailure, validateSettings, writeSettings } from './settings'

test('settings validate every key, exact enum and boolean without coercion', () => {
  for (const input of [null, [], true, 'dark', { unknown: true }, { appearance: 'auto' }, { language: 'zh' },
    { textSize: 16 }, { uiFont: 'Arial' }, { codeFont: 'serif' }, { trayClick: 'popover' },
    { showDock: 'false' }, { preventSleep: 1 }, { appearance: undefined }, JSON.parse('{"__proto__":true}')]) {
    assert.throws(() => validateSettings(input, true))
  }
  assert.throws(() => validateSettings({ appearance: 'dark' }))
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS }), DEFAULT_SETTINGS)
  assert.deepEqual(validateSettings({ showDock: false, preventSleep: true }, true), { showDock: false, preventSleep: true })
})

test('only missing storage gets defaults; malformed, partial and unreadable paths fail explicitly', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  assert.deepEqual(await readSettings(filename), DEFAULT_SETTINGS)
  for (const content of ['{bad', '{}', JSON.stringify({ ...DEFAULT_SETTINGS, showDock: 'false' })]) {
    await writeFile(filename, content)
    await assert.rejects(readSettings(filename), /Invalid settings file/)
    assert.equal(await readFile(filename, 'utf8'), content)
  }
  await assert.rejects(readSettings(directory), /Cannot read settings/)
})

test('concurrent patches serialize native effects and atomically preserve all eight settings across restart', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  let active = 0
  let maximum = 0
  const applied: AppSettings[] = []
  const store = new SettingsStore(filename, { ...DEFAULT_SETTINGS }, async (settings) => {
    active += 1
    maximum = Math.max(maximum, active)
    await Promise.resolve()
    applied.push({ ...settings })
    active -= 1
  })
  const first = store.update({ appearance: 'dark', textSize: 'large', uiFont: 'pingfang' })
  const second = store.update({ language: 'en', codeFont: 'menlo', trayClick: 'main', showDock: false, preventSleep: true })
  await Promise.all([first, second])
  assert.equal(maximum, 1)
  assert.equal(applied.length, 2)
  assert.equal(applied[1].appearance, 'dark')
  const expected: AppSettings = {
    appearance: 'dark', textSize: 'large', uiFont: 'pingfang', language: 'en',
    codeFont: 'menlo', trayClick: 'main', showDock: false, preventSleep: true
  }
  assert.deepEqual(store.value, expected)
  assert.deepEqual(await readSettings(filename), expected)
  assert.deepEqual(await readdir(directory), ['settings.json'])
  const snapshot = store.value
  snapshot.showDock = true
  assert.equal(store.value.showDock, false)
})

test('a native failure restores prior effects and durable settings, and later updates still work', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  await writeSettings(filename, { ...DEFAULT_SETTINGS })
  let native = { ...DEFAULT_SETTINGS }
  const store = new SettingsStore(filename, { ...DEFAULT_SETTINGS }, async (settings) => {
    native = { ...settings }
    if (!settings.showDock) throw new Error('Dock unavailable')
  })
  await assert.rejects(store.update({ showDock: false, appearance: 'dark' }), /Dock unavailable/)
  assert.deepEqual(native, DEFAULT_SETTINGS)
  assert.deepEqual(store.value, DEFAULT_SETTINGS)
  assert.deepEqual(await readSettings(filename), DEFAULT_SETTINGS)
  await store.update({ language: 'en' })
  assert.equal((await readSettings(filename)).language, 'en')
})

test('a settings.json directory is classified, rolls back effects and permits retrying the same patch after removal', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  await mkdir(filename)
  let native = { ...DEFAULT_SETTINGS }
  const store = new SettingsStore(filename, { ...DEFAULT_SETTINGS }, async (settings) => { native = { ...settings } })
  const patch = { preventSleep: true, showDock: false }
  await assert.rejects(store.update(patch), (error: unknown) => {
    const failure = settingsUpdateFailure(error, filename)
    assert.equal(failure.reason, 'path-conflict')
    assert.equal(failure.filePath, filename)
    assert.ok(path.isAbsolute(failure.filePath))
    assert.match(failure.details, /Cannot save settings/)
    assert.match(failure.details, /rename/)
    return true
  })
  assert.deepEqual(native, DEFAULT_SETTINGS)
  assert.deepEqual(store.value, DEFAULT_SETTINGS)
  assert.deepEqual(await readdir(directory), ['settings.json'])
  await rm(filename, { recursive: true })
  await store.update(patch)
  const expected = { ...DEFAULT_SETTINGS, ...patch }
  assert.deepEqual(native, expected)
  assert.deepEqual(store.value, expected)
  assert.deepEqual(await readSettings(filename), expected)
  assert.deepEqual(await readdir(directory), ['settings.json'])
})

test('structured failures classify errno without interpreting message text', () => {
  const reasons: [string, SettingsFailureReason][] = [
    ['EACCES', 'permission-denied'], ['EPERM', 'permission-denied'],
    ['ENOSPC', 'storage-full'], ['EDQUOT', 'storage-full'], ['EROFS', 'read-only'],
    ['EISDIR', 'path-conflict'], ['ENOTDIR', 'path-conflict'], ['EEXIST', 'path-conflict'],
    ['ENOENT', 'path-unavailable'], ['EIO', 'unknown']
  ]
  for (const [code, reason] of reasons) {
    const cause = Object.assign(new Error('original filesystem diagnostic'), { code })
    const error = new Error('Cannot save settings', { cause })
    const failure = settingsUpdateFailure(error, '/actual/settings.json')
    assert.equal(failure.reason, reason, code)
    assert.equal(failure.details, 'Cannot save settings\noriginal filesystem diagnostic')
    assert.equal(failure.filePath, '/actual/settings.json')
  }
  const failure = settingsUpdateFailure(new Error('EACCES ENOSPC EROFS ENOENT'), 'settings.json')
  assert.equal(failure.reason, 'unknown')
  assert.equal(failure.filePath, path.resolve('settings.json'))
})

test('nested aggregate failures retain every diagnostic but classify only the original operation', () => {
  const writeError = Object.assign(new Error('write failed'), { code: 'ENOSPC' })
  const closeError = Object.assign(new Error('close failed'), { code: 'EROFS' })
  const cleanupError = Object.assign(new Error('cleanup failed'), { code: 'EACCES' })
  const writeAndClose = new AggregateError([writeError, closeError], 'write and close failed')
  const saveAndCleanup = new AggregateError([
    new Error('operation wrapper', { cause: writeAndClose }), cleanupError
  ], 'save and cleanup failed', { cause: new Error('additional diagnostic') })
  const error = new Error('Cannot save settings', { cause: saveAndCleanup })
  const failure = settingsUpdateFailure(error, '/actual/settings.json')
  assert.equal(failure.reason, 'storage-full')
  assert.equal(failure.details, [
    'Cannot save settings', 'save and cleanup failed', 'operation wrapper', 'write and close failed',
    'write failed', 'close failed', 'cleanup failed', 'additional diagnostic'
  ].join('\n'))
  const unknownOperation = new AggregateError([new Error('unknown operation failure'), cleanupError], 'cleanup also failed')
  assert.equal(settingsUpdateFailure(unknownOperation, '/actual/settings.json').reason, 'unknown')
})

test('storage exhaustion preserves the previous file and native effects, then the same patch can succeed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  await writeSettings(filename, { ...DEFAULT_SETTINGS })
  const previousFile = await readFile(filename, 'utf8')
  let native = { ...DEFAULT_SETTINGS }
  let full = true
  const store = new SettingsStore(filename, { ...DEFAULT_SETTINGS }, async (settings) => {
    native = { ...settings }
  }, async (target, settings) => {
    if (full) throw Object.assign(new Error('write quota exhausted'), { code: 'EDQUOT' })
    await writeSettings(target, settings)
  })
  const patch = { preventSleep: true, showDock: false }
  await assert.rejects(store.update(patch), (error: unknown) => {
    assert.equal(settingsUpdateFailure(error, filename).reason, 'storage-full')
    return true
  })
  assert.deepEqual(store.value, DEFAULT_SETTINGS)
  assert.deepEqual(native, DEFAULT_SETTINGS)
  assert.equal(await readFile(filename, 'utf8'), previousFile)
  full = false
  await store.update(patch)
  const expected = { ...DEFAULT_SETTINGS, ...patch }
  assert.deepEqual(native, expected)
  assert.deepEqual(store.value, expected)
  assert.deepEqual(await readSettings(filename), expected)
})

test('a rollback failure rejects queued changes and never exposes an allegedly consistent snapshot', async () => {
  let applyCount = 0
  const store = new SettingsStore('/unused/settings.json', { ...DEFAULT_SETTINGS }, async () => {
    applyCount += 1
    if (applyCount === 2) throw new Error('Rollback failed')
  }, async () => { throw new Error('Disk full') })
  const first = store.update({ preventSleep: true })
  const second = store.update({ appearance: 'dark' })
  const results = await Promise.allSettled([first, second])
  assert.equal(results[0].status, 'rejected')
  assert.equal(results[1].status, 'rejected')
  for (const result of results) {
    if (result.status === 'rejected') assert.ok(result.reason instanceof SettingsRollbackError)
  }
  assert.equal(applyCount, 2)
  assert.throws(() => store.value, SettingsRollbackError)
  await assert.rejects(store.idle(), SettingsRollbackError)
})

test('invalid patches never enter the transaction or poison subsequent valid changes', async () => {
  let applied = 0
  let saved = 0
  const store = new SettingsStore('/unused/settings.json', { ...DEFAULT_SETTINGS }, async () => { applied += 1 }, async () => { saved += 1 })
  await assert.rejects(store.update({ preventSleep: 'true' }))
  await store.update({})
  assert.equal(applied, 0)
  assert.equal(saved, 0)
  await store.update({ preventSleep: true })
  assert.equal(applied, 1)
  assert.equal(saved, 1)
})
