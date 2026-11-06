import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import { createIpcGuard, IpcBoundaryError, type IpcArguments, type IpcChannel, type IpcContext, type IpcEvent, type IpcGuard } from './ipc-boundary'
import { SettingsStore } from './settings'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { PendingNavigation } from '../shared/navigation'
import { ScheduleHistoryReader } from './schedule-history'
import type { ScheduleHistory, ScheduledJob } from '../shared/types'

interface BoundaryFixture {
  state: { quitting: boolean; destroyed: boolean; contentsDestroyed: boolean }
  main: BrowserWindow
  tray: BrowserWindow
  mainFrame: { url: string }
  trayFrame: { url: string }
  event: IpcEvent
  trayEvent: IpcEvent
  context: IpcContext
  protect: IpcGuard
}

function fixture(): BoundaryFixture {
  const mainFrame = { url: 'http://127.0.0.1:5173/' }
  const trayFrame = { url: 'http://127.0.0.1:5173/?view=tray' }
  const state = { quitting: false, destroyed: false, contentsDestroyed: false }
  const contents = { isDestroyed: () => state.contentsDestroyed, mainFrame }
  const main = { isDestroyed: () => state.destroyed, get webContents() {
    if (state.destroyed) throw new TypeError('Object has been destroyed')
    return contents
  } } as unknown as BrowserWindow
  const tray = { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: trayFrame } } as unknown as BrowserWindow
  const context: IpcContext = { mainWindow: () => main, trayWindow: () => tray, quitting: () => state.quitting,
    mainUrl: mainFrame.url, trayUrl: trayFrame.url, headless: false }
  const event = { sender: main.webContents, senderFrame: mainFrame } as unknown as IpcEvent
  const trayEvent = { sender: tray.webContents, senderFrame: trayFrame } as unknown as IpcEvent
  return { state, main, tray, mainFrame, trayFrame, event, trayEvent, context, protect: createIpcGuard(context) }
}
const valid: { [K in IpcChannel]: IpcArguments[K] } = {
  'settings:snapshot': [], 'settings:update': [{ language: 'en' }], 'settings:show-main-window': [{ kind: 'page', page: 'settings' }],
  'settings:retry-geometry': [], 'settings:update-login-item': [true],
  'settings:preview-glass': [65],
  'settings:request-notification-permission': [],
  'monitor:snapshot': [], 'monitor:refresh': ['system'], 'monitor:retry-source': ['launchctl:system'],
  'monitor:subscription': [true, false],
  'monitor:focus-agent-in-tern': ['agent-1'], 'monitor:schedule-history': ['hermes-job:daily', 0],
  'monitor:cancel-schedule-history': [], 'monitor:navigation': [], 'monitor:acknowledge-navigation': [1],
  'monitor:events': [{ sourceId: 'hermes-events', type: 'execution-failed', before: 50, upper: 100 }],
  'monitor:cancel-events': [],
  'diagnostics:generate': [], 'diagnostics:cancel': [],
  'diagnostics:copy': ['01234567-89ab-4def-8123-456789abcdef'], 'diagnostics:save': ['01234567-89ab-4def-8123-456789abcdef']
}
const rejected = (category: IpcBoundaryError['category']) => (error: unknown) => error instanceof IpcBoundaryError && error.category === category

test('every request rejects foreign contents, subframes, changed URLs, dead windows and shutdown before effects', () => {
  const changes: ((current: BoundaryFixture) => void)[] = [
    current => { Object.assign(current.event, { sender: { isDestroyed: () => false } }) },
    current => { Object.assign(current.event, { senderFrame: { url: current.mainFrame.url } }) },
    current => { Object.assign(current.event, { senderFrame: null }) },
    current => { current.mainFrame.url = 'https://untrusted.invalid/?secret=S01_PRIVATE_INPUT' },
    current => { current.mainFrame.url = current.context.trayUrl },
    current => { current.mainFrame.url = current.context.mainUrl + '?view=main' },
    current => { current.mainFrame.url = current.context.mainUrl + '?extra=S01_PRIVATE_INPUT' },
    current => { current.mainFrame.url = 'not-a-url:S01_PRIVATE_INPUT\n[' },
    current => { current.state.destroyed = true },
    current => { current.state.contentsDestroyed = true },
    current => { current.state.quitting = true }
  ]
  for (const change of changes) for (const channel of Object.keys(valid) as IpcChannel[]) {
    const current = fixture()
    change(current)
    let effects = 0
    const guarded = current.protect(channel, () => { effects++ })
    assert.throws(() => guarded(current.event, ...valid[channel]), error => {
      assert.ok(rejected('source')(error))
      assert.ok(!(error as Error).message.includes('S01_PRIVATE_INPUT'))
      return true
    }, channel)
    assert.equal(effects, 0, channel)
  }
})

test('a tray document cannot write settings, read or cancel history, retry tools, or consume navigation', () => {
  const current = fixture()
  for (const channel of ['settings:update', 'settings:preview-glass', 'settings:retry-geometry', 'settings:update-login-item', 'monitor:schedule-history', 'monitor:cancel-schedule-history',
    'monitor:retry-source', 'monitor:focus-agent-in-tern', 'monitor:navigation', 'monitor:acknowledge-navigation', 'monitor:events', 'monitor:cancel-events',
    'settings:request-notification-permission',
    'diagnostics:generate', 'diagnostics:copy', 'diagnostics:save', 'diagnostics:cancel'] as const) {
    let effects = 0
    assert.throws(() => current.protect(channel, () => { effects++ })(current.trayEvent, ...valid[channel]), rejected('capability'))
    assert.equal(effects, 0)
  }
})

test('invalid argument shapes, arity, IDs and numeric bounds never reach a data or tool action', () => {
  const invalid: [IpcChannel, unknown[]][] = []
  for (const value of [null, {}, [], NaN, -1, 0.5, 'unknown']) invalid.push(['monitor:refresh', [value]])
  for (const value of [undefined, null, {}, [], 0, 1, 'true']) {
    invalid.push(['monitor:subscription', [value, false]], ['monitor:subscription', [true, value]])
    invalid.push(['settings:update-login-item', [value]])
  }
  invalid.push(['monitor:subscription', [true]])
  for (const intensity of [undefined, {}, [], NaN, Infinity, -1, 101, 1.5, '65', true])
    invalid.push(['settings:preview-glass', [intensity]])
  for (const channel of ['monitor:retry-source', 'monitor:focus-agent-in-tern', 'monitor:schedule-history'] as const) {
    for (const value of [null, {}, [], NaN, '', 'S01_PRIVATE_INPUT\0', 'id\nvalue', 'x'.repeat(513)]) invalid.push([channel, [value]])
  }
  invalid.push(['monitor:retry-source', ['x'.repeat(129)]], ['monitor:schedule-history', ['x'.repeat(257)]],
    ['monitor:schedule-history', ['hermes-job:']], ['monitor:schedule-history', [`hermes-job:${'x'.repeat(129)}`]])
  for (const offset of [null, {}, NaN, Infinity, -25, 0.5, 1, 100001, Number.MAX_SAFE_INTEGER])
    invalid.push(['monitor:schedule-history', ['hermes-job:daily', offset]])
  for (const sequence of [null, {}, NaN, Infinity, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1'])
    invalid.push(['monitor:acknowledge-navigation', [sequence]])
  for (const target of [null, [], {}, { kind: 'page', page: 'unknown' }, { kind: 'page', page: 'settings', path: '/secret' },
    { kind: 'schedule', id: 'x'.repeat(257), identity: 'same' }, { kind: 'source', id: 'x'.repeat(129), section: 'system' },
    JSON.parse('{"kind":"page","page":"settings","__proto__":{"polluted":true}}')])
    invalid.push(['settings:show-main-window', [target]])
  for (const channel of ['diagnostics:copy', 'diagnostics:save'] as const) {
    for (const value of [null, {}, [], 1, '', '/tmp/report.json', 'x'.repeat(4096), '01234567-89ab-0def-0123-456789abcdef'])
      invalid.push([channel, [value]])
    invalid.push([channel, [valid[channel][0], { path: '/tmp/report.json', json: 'private text' }]])
  }
  for (const value of [null, [], { limit: 5000 }, { before: -1 }, { upper: Infinity }, { sourceId: 'x'.repeat(129) },
    { type: 'unknown' }, { from: 'bad' }, { from: '2026-11-06T00:00:00.000Z', to: '2026-11-05T00:00:00.000Z' }])
    invalid.push(['monitor:events', [value]])
  for (const channel of Object.keys(valid) as IpcChannel[]) {
    invalid.push([channel, [...valid[channel], 'extra', 'extra']])
    if (valid[channel].length && !['monitor:refresh', 'settings:show-main-window', 'monitor:events'].includes(channel)) invalid.push([channel, []])
  }
  const current = fixture()
  let effects = 0
  for (const [channel, args] of invalid)
    assert.throws(() => current.protect(channel, () => { effects++ })(current.event, ...args), rejected('arguments'), channel)
  assert.equal(effects, 0)
})

test('invalid settings cannot enter the transaction or echo unknown keys', () => {
  const current = fixture()
  let applies = 0, saves = 0, transactions = 0
  const store = new SettingsStore('/unused/settings.json', { ...DEFAULT_SETTINGS }, async () => { applies++ }, async () => { saves++ })
  const update = current.protect('settings:update', patch => { transactions++; return store.update(patch) })
  for (const patch of [null, new Date(), new Map(), [], { language: 'unknown' }, { showDock: 1 },
    { S01_PRIVATE_INPUT: true }, JSON.parse('{"__proto__":{"showDock":true}}'), { constructor: {} },
    { prototype: {} }, Object.create({ language: 'en' }), { plugins: { unknown: false } },
    { plugins: { agents: 'false' } }, { plugins: null }, { plugins: [] }, { plugins: { system: undefined } }]) {
    assert.throws(() => update(current.event, patch), error => {
      assert.ok(rejected('arguments')(error))
      assert.ok(!(error as Error).message.includes('S01_PRIVATE_INPUT'))
      return true
    })
  }
  assert.equal(transactions, 0)
  assert.equal(applies, 0)
  assert.equal(saves, 0)
  assert.deepEqual(store.value, DEFAULT_SETTINGS)
})

test('renderer geometry edits cannot replace native window bounds', () => {
  const current = fixture()
  let changes = 0
  const update = current.protect('settings:update', () => { changes++ })
  for (const windowBounds of [null, { x: 10, y: 20, width: 900, height: 700 }])
    assert.throws(() => update(current.event, { windowBounds, sidebarWidth: 240 }), rejected('capability'))
  assert.equal(changes, 0)
  update(current.event, { sidebarWidth: 240 })
  assert.equal(changes, 1)
})

test('canonical local document URLs and same-document hashes preserve navigation delivery and acknowledgement', () => {
  for (const url of ['http://127.0.0.1:5173/', 'file:///Applications/OC%20Chan.app/Contents/Resources/app.asar/out/renderer/index.html']) {
    const current = fixture()
    current.context.mainUrl = url
    current.mainFrame.url = url + '#details'
    const pending = new PendingNavigation()
    pending.put({ kind: 'page', page: 'schedules' })
    const read = current.protect('monitor:navigation', () => pending.read())
    const acknowledge = current.protect('monitor:acknowledge-navigation', sequence => pending.acknowledge(sequence))
    const intent = read(current.event)!
    assert.equal(intent.target.kind, 'page')
    acknowledge(current.event, intent.sequence + 1)
    assert.deepEqual(read(current.event), intent)
    acknowledge(current.event, intent.sequence)
    assert.equal(read(current.event), null)
  }
})

test('untrusted and tray cancellation leave a real in-flight history request alive', async () => {
  const current = fixture()
  let signal: AbortSignal | undefined, finish!: (page: ScheduleHistory) => void
  const reader = new ScheduleHistoryReader({ providers: [{ supports: () => true,
    read: (_job, _offset, activeSignal) => { signal = activeSignal; return new Promise(resolve => { finish = resolve }) } }] })
  const job: ScheduledJob = { id: 'hermes-job:daily', name: 'daily', source: 'Hermes', scope: 'user', origin: 'personal', kind: 'calendar', schedule: 'daily', state: 'waiting' }
  const read = current.protect('monitor:schedule-history', (_id, offset) => reader.read(job, offset))
  const cancel = current.protect('monitor:cancel-schedule-history', () => reader.cancel())
  const active = read(current.event, job.id)
  assert.throws(() => cancel(current.trayEvent), rejected('capability'))
  assert.throws(() => cancel({ ...current.event, senderFrame: null } as IpcEvent), rejected('source'))
  assert.equal(signal!.aborted, false)
  const page: ScheduleHistory = { jobId: job.id, source: 'hermes', entries: [], offset: 0, limit: 25, hasMore: false, collectedAt: '2026-11-05T00:00:00Z' }
  finish(page)
  assert.deepEqual(await active, page)
  const cancelled = assert.rejects(read(current.event, job.id, 25), { name: 'AbortError' })
  cancel(current.event)
  assert.equal(signal!.aborted, true)
  finish({ ...page, offset: 25 })
  await cancelled
})

test('headless activation is rejected before native or external operations', () => {
  const current = fixture()
  current.context.headless = true
  let activations = 0
  for (const channel of ['settings:show-main-window', 'monitor:focus-agent-in-tern', 'settings:update-login-item'] as const) {
    assert.throws(() => current.protect(channel, () => { activations++ })(current.event, ...valid[channel]), rejected('headless'))
  }
  assert.equal(activations, 0)
})
