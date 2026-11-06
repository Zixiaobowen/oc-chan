import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindow, Screen } from 'electron'
import { DEFAULT_SETTINGS, type WindowBounds } from '../shared/settings'
import { readSettings, SettingsStore, validateSettings, writeSettings } from './settings'
import { restoreWindowBounds, WindowGeometry } from './window-geometry'

const primary = { id: 1, workArea: { x: 0, y: 32, width: 1728, height: 1048 } }
const normal = { x: 80, y: 70, width: 1000, height: 720 }
function fixture(initial = normal) {
  const state = { bounds: { ...initial }, minimized: false, maximized: false, fullscreen: false, destroyed: false }
  const target = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.destroyed, isMinimized: () => state.minimized,
    isMaximized: () => state.maximized, isFullScreen: () => state.fullscreen,
    getNormalBounds: () => ({ ...state.bounds }), setMinimumSize: (_width: number, _height: number) => {},
    setBounds: (bounds: WindowBounds) => { state.bounds = { ...bounds }; target.emit('resize') }
  })
  const displays = { current: [primary] }
  const screens = Object.assign(new EventEmitter(), {
    getAllDisplays: () => displays.current, getPrimaryDisplay: () => primary
  })
  return { state, target, screens, displays, native: target as unknown as BrowserWindow, screen: screens as unknown as Screen }
}

test('geometry validation rejects unsafe sizes and preserves independent durable preferences', async t => {
  for (const sidebarWidth of [-1, 187, 321, 200.5, NaN, Infinity, '214', null])
    assert.throws(() => validateSettings({ sidebarWidth }))
  for (const windowBounds of [[], 1, undefined, {}, { ...normal, width: -1 }, { ...normal, height: 239 },
    { ...normal, width: 16385 }, { ...normal, x: NaN }, { ...normal, y: Infinity }, { ...normal, x: 131073 },
    { ...normal, x: 1.5 }, { ...normal, path: '/untrusted' }, Object.create(normal)])
    assert.throws(() => validateSettings({ windowBounds }))
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-geometry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  let writes = 0
  const store = new SettingsStore(filename, { ...DEFAULT_SETTINGS }, async () => {}, async (file, value) => {
    writes++; await writeSettings(file, value)
  })
  const bounds = { ...normal, x: -1500 }
  const update = store.update({ windowBounds: bounds, sidebarWidth: 320 })
  bounds.width = -100
  await update
  const snapshot = store.value
  snapshot.windowBounds!.width = 9999
  const saved = await readSettings(filename)
  assert.deepEqual(saved.windowBounds, { ...normal, x: -1500 })
  assert.equal(saved.sidebarWidth, 320)
  await store.update({ windowBounds: { ...saved.windowBounds! } })
  assert.equal(writes, 1)
  await writeFile(filename, '{"windowBounds":{"x":0,"y":0,"width":-1,"height":800}}')
  const invalid = await readFile(filename, 'utf8')
  await assert.rejects(readSettings(filename))
  assert.equal(await readFile(filename, 'utf8'), invalid)
})

test('restore keeps valid secondary-screen coordinates and clamps detached or smaller displays', () => {
  const secondary = { id: 2, workArea: { x: -1920, y: -100, width: 1920, height: 1080 } }
  const bounds = { ...normal, x: -1800 }
  assert.deepEqual(restoreWindowBounds(bounds, [primary, secondary], 1).bounds, bounds)
  const restored = restoreWindowBounds(bounds, [primary], 1)
  assert.equal(restored.adjusted, true)
  assert.deepEqual(restored.bounds, { x: 364, y: 196, width: 1000, height: 720 })
  const small = { id: 3, workArea: { x: 500, y: 20, width: 800, height: 600 } }
  const limited = restoreWindowBounds({ x: 1250, y: 500, width: 2000, height: 1500 }, [small], 3)
  assert.deepEqual(limited.bounds, small.workArea)
  assert.deepEqual([limited.minWidth, limited.minHeight], [800, 600])
  assert.throws(() => restoreWindowBounds(normal, [], 1))
  assert.throws(() => restoreWindowBounds(normal, [{ id: 1, workArea: { ...normal, width: NaN } }], 1))
})

test('100 resize events retain only the last pending bounds and shutdown drains real atomic writes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-geometry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  let active = 0, maximum = 0, writes = 0
  const store = new SettingsStore(filename, { ...DEFAULT_SETTINGS, windowBounds: normal }, async () => {}, async (file, value) => {
    writes++; active++; maximum = Math.max(maximum, active)
    try {
      if (writes === 1) { entered.resolve(); await gate.promise }
      await writeSettings(file, value)
    } finally { active-- }
  })
  const f = fixture()
  const errors: unknown[] = []
  const geometry = new WindowGeometry(f.native, f.screen, store, filename, () => {}, error => errors.push(error))
  t.after(() => geometry.dispose())
  f.target.setBounds({ ...normal, x: 90 })
  const flushing = geometry.flush()
  await entered.promise
  const sidebar = store.update({ sidebarWidth: 288 })
  for (let index = 0; index < 100; index++) f.target.setBounds({ ...normal, x: 100 + index })
  const disposing = geometry.dispose()
  assert.strictEqual(geometry.dispose(), disposing)
  gate.resolve()
  await Promise.all([flushing, sidebar, disposing])
  const saved = await readSettings(filename)
  assert.deepEqual(saved.windowBounds, { ...normal, x: 199 })
  assert.equal(saved.sidebarWidth, 288)
  assert.equal(writes, 3)
  assert.equal(maximum, 1)
  assert.deepEqual(errors, [])
  assert.equal(f.target.eventNames().length, 0)
  assert.equal(f.screens.eventNames().length, 0)
})

test('returning to saved bounds cancels an obsolete pending resize and non-normal states never replace it', async t => {
  let writes = 0
  const store = new SettingsStore('/unused/settings.json', { ...DEFAULT_SETTINGS, windowBounds: normal }, async () => {}, async () => { writes++ })
  const f = fixture()
  const geometry = new WindowGeometry(f.native, f.screen, store, '/unused/settings.json', () => {}, error => { throw error })
  t.after(() => geometry.dispose())
  f.target.setBounds({ ...normal, x: 200 })
  f.target.setBounds(normal)
  await geometry.flush()
  assert.equal(writes, 0)
  for (const mode of ['minimized', 'maximized', 'fullscreen'] as const) {
    f.state[mode] = true
    f.target.setBounds({ x: 0, y: 0, width: 1728, height: 1117 })
    await geometry.flush()
    assert.deepEqual(store.value.windowBounds, normal)
    f.state.bounds = { ...normal }
    f.state[mode] = false
  }
  await geometry.dispose()
  assert.equal(writes, 0)
})

test('display removal repositions on return from fullscreen and repeated lifecycles release listeners', async () => {
  const initial = { ...normal, x: -1800 }
  const store = new SettingsStore('/unused/settings.json', { ...DEFAULT_SETTINGS, windowBounds: initial }, async () => {}, async () => {})
  const f = fixture(initial)
  const geometry = new WindowGeometry(f.native, f.screen, store, '/unused/settings.json', () => {}, error => { throw error })
  f.state.fullscreen = true
  f.screens.emit('display-removed')
  assert.deepEqual(f.state.bounds, initial)
  f.state.fullscreen = false
  f.target.emit('leave-full-screen')
  await geometry.dispose()
  assert.deepEqual(store.value.windowBounds, { x: 364, y: 196, width: 1000, height: 720 })
  for (let index = 0; index < 100; index++) {
    const instance = new WindowGeometry(f.native, f.screen, store, '/unused/settings.json', () => {}, error => { throw error })
    await instance.dispose()
    assert.deepEqual(f.target.eventNames(), [])
    assert.deepEqual(f.screens.eventNames(), [])
  }
})

test('a real path conflict is reported without claiming saved bounds and retry saves the current position', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-geometry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  await mkdir(filename)
  const store = new SettingsStore(filename, { ...DEFAULT_SETTINGS, windowBounds: normal }, async () => {})
  const f = fixture()
  const failures: unknown[] = []
  const geometry = new WindowGeometry(f.native, f.screen, store, filename, () => {}, error => failures.push(error))
  t.after(() => geometry.dispose())
  f.target.setBounds({ ...normal, x: 200 })
  assert.equal((await geometry.flush())?.reason, 'path-conflict')
  assert.equal(failures.length, 1)
  assert.deepEqual(store.value.windowBounds, normal)
  assert.deepEqual(f.state.bounds, { ...normal, x: 200 })
  await rm(filename, { recursive: true })
  f.target.setBounds({ ...normal, x: 300 })
  assert.equal(await geometry.retry(), null)
  assert.equal(geometry.error, null)
  assert.deepEqual((await readSettings(filename)).windowBounds, { ...normal, x: 300 })
})
