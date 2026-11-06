import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate as settle } from 'node:timers/promises'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import { TrayWindowController } from './tray-window'

function fixture() {
  const created: ReturnType<typeof panel>[] = []
  const shown: BrowserWindow[] = [], errors: unknown[] = []
  function panel() {
    let destroyed = false
    let resolve!: () => void, reject!: (error: unknown) => void
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    const gate = { promise, resolve, reject }
    const contents = new EventEmitter()
    const target = Object.assign(new EventEmitter(), {
      hide() {},
      isDestroyed: () => destroyed,
      destroy() { if (!destroyed) { destroyed = true; target.emit('closed'); contents.emit('destroyed') } }
    })
    Object.defineProperty(target, 'webContents', { get() {
      if (destroyed) throw new Error('Object has been destroyed')
      return contents
    } })
    return { target, window: target as unknown as BrowserWindow, contents, gate,
      finish() { gate.resolve(); target.emit('ready-to-show') } }
  }
  const controller = new TrayWindowController({
    create() { const value = panel(); created.push(value); return value.window },
    load(window) { return created.find(value => value.window === window)!.gate.promise },
    present(window) { shown.push(window) }, report(error) { errors.push(error) }
  })
  return { controller, created, shown, errors }
}

function released(value: ReturnType<typeof fixture>['created'][number]) {
  assert.equal(value.window.isDestroyed(), true)
  assert.deepEqual(value.target.eventNames(), [])
  assert.deepEqual(value.contents.eventNames(), [])
}

test('no panel is allocated before a request; concurrent opens share one load and one window', async () => {
  const f = fixture()
  assert.equal(f.controller.window, null)
  assert.equal(f.created.length, 0)
  const requests = Array.from({ length: 10 }, () => f.controller.ensure())
  assert.ok(requests.every(request => request === requests[0]))
  await settle()
  assert.equal(f.created.length, 1)
  f.created[0].finish()
  assert.deepEqual(await Promise.all(requests), Array(10).fill(f.created[0].window))
  assert.deepEqual(f.shown, [])
  await f.controller.dispose()
  released(f.created[0])
})

test('hide and repeated clicks during load preserve the latest intent without reopening or duplicating the panel', async () => {
  const f = fixture()
  for (let index = 0; index < 10; index++) f.controller.toggle()
  const ready = f.controller.ensure()
  await settle()
  assert.equal(f.created.length, 1)
  f.created[0].finish()
  await ready
  assert.equal(f.shown.length, 0)
  f.controller.toggle()
  assert.deepEqual(f.shown, [f.created[0].window])
  f.created[0].target.emit('blur')
  f.controller.toggle()
  assert.equal(f.created.length, 1)
  assert.equal(f.shown.length, 2)
  await f.controller.dispose()
})

test('painting does not present an unfinished load; failure releases the window and one later click retries', async () => {
  const f = fixture()
  f.controller.toggle()
  const first = f.controller.ensure()
  const failure = Object.assign(new Error('load failed'), { code: 'ERR_FILE_NOT_FOUND' })
  const rejected = assert.rejects(first, error => error === failure)
  await settle()
  f.created[0].target.emit('ready-to-show')
  await settle()
  assert.deepEqual(f.shown, [])
  f.created[0].gate.reject(failure)
  await rejected
  assert.deepEqual(f.errors, [failure])
  released(f.created[0])
  assert.equal(f.controller.window, null)
  f.controller.toggle()
  const second = f.controller.ensure()
  await settle()
  assert.equal(f.created.length, 2)
  f.created[1].finish()
  await second
  assert.deepEqual(f.shown, [f.created[1].window])
  await f.controller.dispose()
})

test('an unready panel times out and releases its listeners so a new request can succeed', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const first = f.controller.ensure()
  const rejected = assert.rejects(first, { code: 'ETIMEDOUT' })
  await settle()
  f.created[0].gate.resolve()
  context.mock.timers.tick(10_000)
  await rejected
  released(f.created[0])
  const second = f.controller.ensure()
  await settle()
  f.created[1].finish()
  assert.equal(await second, f.created[1].window)
  await f.controller.dispose()
})

test('shutdown cancels an in-flight load and prevents a late ready event from showing or recreating the panel', async () => {
  const f = fixture()
  f.controller.toggle()
  const pending = f.controller.ensure()
  const rejected = assert.rejects(pending, { code: 'ABORT_ERR' })
  await settle()
  await f.controller.dispose()
  await rejected
  f.created[0].finish()
  await settle()
  released(f.created[0])
  assert.deepEqual(f.shown, [])
  assert.deepEqual(f.errors, [])
  await assert.rejects(f.controller.ensure(), { code: 'ABORT_ERR' })
  f.controller.toggle()
  assert.equal(f.created.length, 1)
})

test('external destruction while loading rejects the request and releases its slot for retry', async () => {
  const f = fixture()
  const first = f.controller.ensure()
  const rejected = assert.rejects(first, { code: 'OC_TRAY_CLOSED' })
  await settle()
  f.created[0].target.destroy()
  await rejected
  released(f.created[0])
  const retry = f.controller.ensure()
  await settle()
  f.created[1].finish()
  assert.equal(await retry, f.created[1].window)
  await f.controller.dispose()
})

test('a crashed loaded renderer is released and reported once, and the next click creates a usable replacement', async () => {
  const f = fixture()
  const first = f.controller.ensure()
  await settle()
  f.created[0].finish()
  await first
  f.created[0].contents.emit('render-process-gone')
  released(f.created[0])
  assert.equal(f.controller.window, null)
  assert.equal(f.errors.length, 1)
  assert.equal((f.errors[0] as { code: string }).code, 'OC_TRAY_RENDERER_GONE')
  f.controller.toggle()
  const second = f.controller.ensure()
  await settle()
  f.created[1].finish()
  await second
  assert.deepEqual(f.shown, [f.created[1].window])
  await f.controller.dispose()
})
