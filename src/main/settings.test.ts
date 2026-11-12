import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DiagnosticError, summarizeDiagnostic } from '../shared/diagnostics'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings, type SettingsFailureReason } from '../shared/settings'
import { THEME_IDS } from '../shared/themes'
import { SETTINGS_MAX_BYTES, readSettings, SettingsRollbackError, SettingsStore, settingsUpdateFailure, validateSettings, writeSettings } from './settings'
import { CollectionPluginRegistry } from './plugins/registry'

test('settings validate supplied keys, exact enums and booleans without coercion', () => {
  for (const input of [null, [], true, 'dark', { unknown: true }, { appearance: 'auto' }, { language: 'zh' },
    { textSize: 16 }, { uiFont: 'Arial' }, { codeFont: 'serif' }, { trayClick: 'popover' },
    { showDock: 'false' }, { preventSleep: 1 }, { appearance: undefined }, JSON.parse('{"__proto__":true}'),
    new Date(), new Map(), Object.create({ language: 'en' }), { constructor: {} }, { prototype: {} }]) {
    assert.throws(() => validateSettings(input))
  }
  for (const key of ['lightTheme', 'darkTheme']) {
    for (const value of ['', 'unknown', 'Nord', ' nord', 'nord ', 1, null, undefined]) {
      assert.throws(() => validateSettings({ [key]: value }))
    }
    for (const value of THEME_IDS) {
      assert.deepEqual(validateSettings({ [key]: value }), { [key]: value })
    }
  }
  assert.deepEqual(validateSettings({}), {})
  assert.deepEqual(validateSettings({ appearance: 'dark' }), { appearance: 'dark' })
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS }), DEFAULT_SETTINGS)
  assert.deepEqual(validateSettings({ showDock: false, preventSleep: true }), { showDock: false, preventSleep: true })
})

test('glass intensity rejects coercion and out-of-range values and persists exact endpoints', async t => {
  for (const glassIntensity of [-1, 101, 0.5, NaN, Infinity, '65', null, undefined, true])
    assert.throws(() => validateSettings({ glassIntensity }))
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-glass-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  const store = new SettingsStore(filename, { ...DEFAULT_SETTINGS }, async () => {})
  for (const glassIntensity of [0, 100, 37]) {
    await store.update({ glassIntensity })
    assert.equal((await readSettings(filename)).glassIntensity, glassIntensity)
    assert.equal(store.value.appearance, DEFAULT_SETTINGS.appearance)
  }
})

test('validated stored overrides merge with defaults; malformed, invalid and unreadable paths fail explicitly', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  assert.deepEqual(await readSettings(filename), DEFAULT_SETTINGS)
  for (const overrides of [{}, { appearance: 'dark' }, { lightTheme: 'github' }, { darkTheme: 'nord' },
    { language: 'en', lightTheme: 'solarized', darkTheme: 'gruvbox' }, { glassIntensity: 0 }, { glassIntensity: 100 }]) {
    const content = JSON.stringify(overrides)
    await writeFile(filename, content)
    assert.deepEqual(await readSettings(filename), { ...DEFAULT_SETTINGS, ...overrides })
    assert.equal(await readFile(filename, 'utf8'), content)
  }
  for (const content of ['{bad', 'null', '[]', '{"unknown":true}', '{"lightTheme":"unknown"}',
    '{"darkTheme":null}', '{"glassIntensity":-1}', '{"glassIntensity":101}', '{"glassIntensity":65.5}',
    '{"glassIntensity":"65"}', JSON.stringify({ ...DEFAULT_SETTINGS, showDock: 'false' })]) {
    await writeFile(filename, content)
    await assert.rejects(readSettings(filename), error => error instanceof DiagnosticError && error.code === 'OC_SETTINGS_INVALID')
    assert.equal(await readFile(filename, 'utf8'), content)
  }
  await assert.rejects(readSettings(directory), error => summarizeDiagnostic(error, 'settings-read').primaryCode === 'OC_SETTINGS_NOT_REGULAR')
})

test('concurrent patches serialize native effects and independently preserve both themes across restart', async (t) => {
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
  const first = store.update({ appearance: 'dark', lightTheme: 'github', textSize: 'large', uiFont: 'pingfang', glassIntensity: 0 })
  const second = store.update({ darkTheme: 'catppuccin', language: 'en', codeFont: 'menlo', trayClick: 'main', showDock: false, preventSleep: true, glassIntensity: 100 })
  await Promise.all([first, second])
  assert.equal(maximum, 1)
  assert.equal(applied.length, 2)
  assert.equal(applied[1].appearance, 'dark')
  assert.equal(applied[0].lightTheme, 'github')
  assert.equal(applied[0].darkTheme, 'oc-chan')
  assert.equal(applied[1].lightTheme, 'github')
  assert.equal(applied[1].darkTheme, 'catppuccin')
  assert.equal(applied[0].glassIntensity, 0)
  assert.equal(applied[1].glassIntensity, 100)
  const expected: AppSettings = {
    glassIntensity: 100, sidebarWidth: DEFAULT_SETTINGS.sidebarWidth, sidebarCollapsed: false, windowBounds: null,
    appearance: 'dark', textSize: 'large', uiFont: 'pingfang', language: 'en',
    lightTheme: 'github', darkTheme: 'catppuccin',
    notifications: DEFAULT_SETTINGS.notifications,
    codeFont: 'menlo', trayClick: 'main', showDock: false, preventSleep: true, plugins: { ...DEFAULT_SETTINGS.plugins }
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
    if (settings.glassIntensity === 100) throw new Error('Native glass unavailable')
  })
  await assert.rejects(store.update({ glassIntensity: 100, appearance: 'dark' }), error =>
    error instanceof DiagnosticError && error.stage === 'settings-apply')
  assert.deepEqual(native, DEFAULT_SETTINGS)
  assert.deepEqual(store.value, DEFAULT_SETTINGS)
  assert.deepEqual(await readSettings(filename), DEFAULT_SETTINGS)
  await store.update({ language: 'en', glassIntensity: 0 })
  assert.equal((await readSettings(filename)).language, 'en')
  assert.equal((await readSettings(filename)).glassIntensity, 0)
})

test('a settings.json directory is classified, rolls back effects and permits retrying the same patch after removal', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  await mkdir(filename)
  let native = { ...DEFAULT_SETTINGS }
  const store = new SettingsStore(filename, { ...DEFAULT_SETTINGS }, async (settings) => { native = { ...settings } })
  const patch = { preventSleep: true, showDock: false, glassIntensity: 0 }
  await assert.rejects(store.update(patch), (error: unknown) => {
    const failure = settingsUpdateFailure(error, filename)
    assert.equal(failure.reason, 'path-conflict')
    assert.equal(failure.filePath, filename)
    assert.ok(path.isAbsolute(failure.filePath))
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
    ['ENOENT', 'path-unavailable'], ['ETIMEDOUT', 'timeout'], ['EIO', 'unknown']
  ]
  for (const [code, reason] of reasons) {
    const cause = Object.assign(new Error('original filesystem diagnostic'), { code })
    const error = new Error('Cannot save settings', { cause })
    const failure = settingsUpdateFailure(error, '/actual/settings.json')
    assert.equal(failure.reason, reason, code)
    assert.equal(failure.filePath, '/actual/settings.json')
  }
  const failure = settingsUpdateFailure(new Error('EACCES ENOSPC EROFS ENOENT'), 'settings.json')
  assert.equal(failure.reason, 'unknown')
  assert.equal(failure.filePath, path.resolve('settings.json'))
})

test('nested aggregate failures preserve errno but classify only the original operation', () => {
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
  const unknownOperation = new AggregateError([new Error('unknown operation failure'), cleanupError], 'cleanup also failed')
  assert.equal(settingsUpdateFailure(unknownOperation, '/actual/settings.json').reason, 'unknown')
  for (const code of ['ENOSPC', 'EROFS', 'EACCES']) assert.ok(failure.details.includes(code))
  assert.ok(!failure.details.includes('additional diagnostic'))
})

test('storage exhaustion preserves the previous file and native effects, then the same patch can succeed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  const initial: AppSettings = { ...DEFAULT_SETTINGS, lightTheme: 'github', darkTheme: 'nord' }
  await writeSettings(filename, initial)
  const previousFile = await readFile(filename, 'utf8')
  let native = { ...initial }
  let full = true
  const store = new SettingsStore(filename, initial, async (settings) => {
    native = { ...settings }
  }, async (target, settings) => {
    if (full) throw Object.assign(new Error('write quota exhausted'), { code: 'EDQUOT' })
    await writeSettings(target, settings)
  })
  const patch: Partial<AppSettings> = { preventSleep: true, showDock: false, lightTheme: 'solarized', darkTheme: 'gruvbox', glassIntensity: 100 }
  await assert.rejects(store.update(patch), (error: unknown) => {
    assert.equal(settingsUpdateFailure(error, filename).reason, 'storage-full')
    return true
  })
  assert.deepEqual(store.value, initial)
  assert.deepEqual(native, initial)
  assert.equal(await readFile(filename, 'utf8'), previousFile)
  full = false
  await store.update(patch)
  const expected = { ...initial, ...patch }
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
  const first = store.update({ glassIntensity: 0 })
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
  await assert.rejects(store.update({ lightTheme: 'unknown' }))
  await assert.rejects(store.update({ darkTheme: 'NORD' }))
  await assert.rejects(store.update({ glassIntensity: 101 }))
  await assert.rejects(store.update({ glassIntensity: 65.5 }))
  await store.update({})
  assert.equal(applied, 0)
  assert.equal(saved, 0)
  await store.update({ preventSleep: true })
  assert.equal(applied, 1)
  assert.equal(saved, 1)
})

test('settings size and UTF-8 boundaries preserve the original file on rejection', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  const exact = Buffer.from('{}' + ' '.repeat(SETTINGS_MAX_BYTES - 2))
  await writeFile(filename, exact)
  assert.deepEqual(await readSettings(filename), DEFAULT_SETTINGS)
  for (const content of [Buffer.concat([exact, Buffer.from(' ')]), Buffer.from([0xff, 0xfe])]) {
    await writeFile(filename, content)
    await assert.rejects(readSettings(filename))
    assert.deepEqual(await readFile(filename), content)
  }
  await writeSettings(filename, { ...DEFAULT_SETTINGS, language: 'en' })
  assert.equal((await stat(filename)).mode & 0o777, 0o600)
  assert.equal((await readSettings(filename)).language, 'en')
})

test('symlink, dangling symlink and FIFO inputs are rejected without following or blocking', { timeout: 5000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'target.json'), link = path.join(directory, 'settings.json')
  await writeFile(target, '{"language":"en"}')
  await symlink(target, link)
  await assert.rejects(readSettings(link), error => summarizeDiagnostic(error, 'settings-read').primaryCode === 'ELOOP')
  assert.equal(await readFile(target, 'utf8'), '{"language":"en"}')
  await rm(target)
  await assert.rejects(readSettings(link), error => summarizeDiagnostic(error, 'settings-read').primaryCode === 'ELOOP')
  const fifo = path.join(directory, 'pipe')
  await promisify(execFile)('mkfifo', [fifo], { timeout: 2000 })
  await assert.rejects(readSettings(fifo), error => summarizeDiagnostic(error, 'settings-read').primaryCode === 'OC_SETTINGS_NOT_REGULAR')
  assert.ok((await stat(fifo)).isFIFO())
})

test('growth between stat and reading is rejected and its descriptor is closed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  await writeFile(filename, '{}')
  const handle = await open(filename, 'r')
  const prototype = Object.getPrototypeOf(handle)
  await handle.close()
  const original = prototype.read
  let captured: typeof handle | undefined
  // Interpose one real append at the race boundary; reads still use the actual descriptor and filesystem.
  t.mock.method(prototype, 'read', async function (this: typeof handle, ...args: unknown[]) {
    if (!captured) { captured = this; await appendFile(filename, ' '.repeat(SETTINGS_MAX_BYTES)) }
    return Reflect.apply(original, this, args)
  })
  await assert.rejects(readSettings(filename), error => summarizeDiagnostic(error, 'settings-read').primaryCode === 'OC_SETTINGS_CHANGED')
  assert.equal(captured!.fd, -1)
  assert.equal(await readFile(filename, 'utf8'), '{}' + ' '.repeat(SETTINGS_MAX_BYTES))
})

test('close and cleanup failures retain the original write errno and remain visible', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  await writeSettings(filename, { ...DEFAULT_SETTINGS })
  const previous = await readFile(filename)
  const handle = await open(filename, 'r'), prototype = Object.getPrototypeOf(handle)
  await handle.close()
  // close is an instance method on FileHandle: install it on each temporary file via writeFile's receiver.
  t.mock.method(prototype, 'writeFile', async function (this: typeof handle) {
    const close = this.close.bind(this)
    this.close = async () => {
      await close()
      const temporary = (await readdir(directory)).find(name => name.endsWith('.tmp'))!
      await rm(path.join(directory, temporary))
      await mkdir(path.join(directory, temporary))
      throw Object.assign(new Error('private close body'), { code: 'EIO', errno: -5 })
    }
    throw Object.assign(new Error('private write body'), { code: 'ENOSPC', errno: -28 })
  })
  await assert.rejects(writeSettings(filename, { ...DEFAULT_SETTINGS, language: 'en' }), error => {
    const result = settingsUpdateFailure(error, filename)
    assert.equal(result.reason, 'storage-full')
    assert.ok(result.details.includes('ENOSPC'))
    assert.ok(result.details.includes('EIO'))
    assert.ok(result.details.includes('syscall=unlink'))
    assert.ok(!result.details.includes('private'))
    return true
  })
  assert.deepEqual(await readFile(filename), previous)
})

test('plugin preferences reject unknown identities and non-boolean or accessor values', () => {
  for (const plugins of [null, [], true, 'agents', { unknown: false }, { agents: 0 }, { schedules: 'false' },
    { system: undefined }, JSON.parse('{"__proto__":false}'), Object.create({ agents: false })]) {
    assert.throws(() => validateSettings({ plugins }))
  }
  let reads = 0
  const plugins = Object.defineProperty({}, 'agents', { enumerable: true, get() { reads++; return false } })
  assert.throws(() => validateSettings({ plugins }))
  assert.equal(reads, 0)
})

test('queued plugin patches preserve independent changes across restart and isolate caller mutation', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-plugin-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  const initial = { ...DEFAULT_SETTINGS, plugins: { ...DEFAULT_SETTINGS.plugins } }
  const store = new SettingsStore(filename, initial, async () => {})
  initial.plugins.system = false
  const patch = { plugins: { agents: false } }
  const first = store.update(patch)
  patch.plugins.agents = true
  const second = store.update({ plugins: { schedules: false } })
  await Promise.all([first, second])
  const expected = { ...DEFAULT_SETTINGS.plugins, agents: false, schedules: false }
  assert.deepEqual(store.value.plugins, expected)
  const borrowed = store.value
  borrowed.plugins.agents = true
  assert.deepEqual(store.value.plugins, expected)
  const restarted = await readSettings(filename)
  assert.deepEqual(restarted.plugins, expected)
  await writeFile(filename, '{"plugins":{"agents":false}}')
  assert.deepEqual((await readSettings(filename)).plugins, { ...DEFAULT_SETTINGS.plugins, agents: false })
  assert.equal(await readFile(filename, 'utf8'), '{"plugins":{"agents":false}}')
})

test('failed plugin preference persistence restores the running plugin and durable file before retry', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-plugin-rollback-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  await writeSettings(filename, { ...DEFAULT_SETTINGS })
  const registry = new CollectionPluginRegistry([{
    id: 'system', section: 'system', capabilities: ['system-metrics'], intervalMs: 2000, timeoutMs: 1000,
    create: () => ({ collect: async () => {}, stop() {} })
  }], { onSnapshot() {}, onError() {} })
  t.after(() => registry.close())
  await registry.collect('system')
  let failSave = true
  const store = new SettingsStore(filename, { ...DEFAULT_SETTINGS }, async settings => {
    await registry.setEnabled('system', settings.plugins.system)
  }, async (target, settings) => {
    if (failSave) throw Object.assign(new Error('storage quota'), { code: 'ENOSPC' })
    await writeSettings(target, settings)
  })
  await assert.rejects(store.update({ plugins: { system: false } }), error =>
    settingsUpdateFailure(error, filename).reason === 'storage-full')
  assert.equal(registry.statuses()[0].phase, 'running')
  assert.equal(registry.statuses()[0].enabled, true)
  assert.equal(store.value.plugins.system, true)
  assert.equal((await readSettings(filename)).plugins.system, true)
  failSave = false
  await store.update({ plugins: { system: false } })
  assert.equal(registry.statuses()[0].phase, 'disabled')
  assert.equal((await readSettings(filename)).plugins.system, false)
})

test('long plugin transitions bound accepted preference work and release capacity after draining', async () => {
  const gate = Promise.withResolvers<void>()
  let active = 0, maximum = 0
  const store = new SettingsStore('/unused/settings.json', { ...DEFAULT_SETTINGS }, async () => {
    active++
    maximum = Math.max(maximum, active)
    await gate.promise
    active--
  }, async () => {})
  const work = Array.from({ length: 16 }, (_, index) => store.update({ plugins: { system: index % 2 !== 0 } }))
  await assert.rejects(store.update({ plugins: { agents: false } }), error =>
    error instanceof DiagnosticError && error.code === 'OC_SETTINGS_BUSY')
  gate.resolve()
  await Promise.all(work)
  assert.equal(maximum, 1)
  assert.equal(store.value.plugins.agents, true)
  await store.update({ plugins: { agents: false } })
  await store.idle()
  assert.equal(store.value.plugins.agents, false)
})

test('notification subscriptions persist full identities and reject unsafe or oversized preference edits', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-notification-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  const store = new SettingsStore(filename, { ...DEFAULT_SETTINGS }, async () => {})
  const notifications = { ...DEFAULT_SETTINGS.notifications, enabled: true, sourceIds: ['hermes-events'],
    tasks: [{ kind: 'schedule' as const, id: 'hermes-job:daily', identity: '["Hermes","user","/local/jobs.json",null]' }],
    quiet: { enabled: true, startMinute: 1320, endMinute: 480 } }
  await store.update({ notifications })
  const persisted = (await readSettings(filename)).notifications
  assert.deepEqual(persisted, notifications)
  notifications.sourceIds.push('changed-by-caller')
  notifications.tasks[0].identity = 'changed-by-caller'
  const exposed = store.value.notifications
  exposed.types.pop()
  exposed.quiet.startMinute = 1
  assert.deepEqual(store.value.notifications, persisted, 'caller and snapshot mutation must not alter live subscriptions')
  for (const invalid of [
    { ...persisted, enabled: 1 }, { ...persisted, sourceIds: ['same', 'same'] },
    { ...persisted, sourceIds: Array.from({ length: 65 }, (_, index) => String(index)) },
    { ...persisted, sourceIds: ['bad\nsource'] }, { ...persisted, types: ['source-unavailable', 'source-unavailable'] },
    { ...persisted, types: ['unknown'] }, { ...persisted, tasks: [{ ...persisted.tasks[0], kind: 'agent' }] },
    { ...persisted, tasks: [{ ...persisted.tasks[0], id: 'cron:daily' }] },
    { ...persisted, tasks: Array.from({ length: 25 }, (_, index) => ({ ...persisted.tasks[0], id: `hermes-job:${index}` })) },
    { ...persisted, tasks: [persisted.tasks[0], persisted.tasks[0]] },
    { ...persisted, quiet: { enabled: true, startMinute: 0, endMinute: 0 } },
    { ...persisted, quiet: { enabled: true, startMinute: 1440, endMinute: 0 } },
    { ...persisted, quiet: { enabled: true, startMinute: 1.5, endMinute: 0 } },
    { ...persisted, showTaskNames: 'true' }, { ...persisted, extra: true },
    { ...persisted, tasks: Array.from({ length: 24 }, (_, index) => ({ ...persisted.tasks[0], id: `hermes-job:${index}`, identity: '长'.repeat(1536) })) }
  ]) await assert.rejects(store.update({ notifications: invalid }), error => error instanceof DiagnosticError && error.code === 'OC_SETTINGS_INVALID')
  assert.deepEqual(store.value.notifications, persisted)
  assert.deepEqual((await readSettings(filename)).notifications, persisted)
  assert.ok((await stat(filename)).size <= SETTINGS_MAX_BYTES)
})
