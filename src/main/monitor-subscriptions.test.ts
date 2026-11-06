import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { BrowserWindow, WebContents } from 'electron'
import type { MonitorUpdate, SourceHeartbeat } from '../shared/types'
import { MonitorSubscriptions } from './monitor-subscriptions'

function windowFixture(visible = true) {
  const state = { visible, minimized: false, destroyed: false }
  const messages: { channel: string; payload: unknown }[] = []
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.destroyed,
    send: (channel: string, payload: unknown) => messages.push({ channel, payload })
  })
  const target = Object.assign(new EventEmitter(), {
    webContents: contents as unknown as WebContents,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized
  })
  return { state, messages, contents, target, window: target as unknown as BrowserWindow }
}
const update = (error: string | null): MonitorUpdate => ({ section: 'system', state: { data: null, error, refreshing: false } })
const heartbeat: SourceHeartbeat = { section: 'system', sources: [] }

test('each window receives only requested streams while visible, without replaying hidden snapshots', () => {
  const subscriptions = new MonitorSubscriptions(false)
  const main = windowFixture(), tray = windowFixture(false)
  subscriptions.register(main.window)
  subscriptions.register(tray.window)
  subscriptions.set(main.window.webContents, true, false)
  subscriptions.set(tray.window.webContents, true, true)
  subscriptions.publish('monitor:changed', update('first'))
  subscriptions.publish('monitor:sources', heartbeat)
  assert.deepEqual(main.messages.map(message => message.channel), ['monitor:changed'])
  assert.equal(tray.messages.length, 0)
  main.state.visible = false
  main.target.emit('hide')
  subscriptions.publish('monitor:changed', update('hidden'))
  subscriptions.publish('monitor:sources', heartbeat)
  assert.equal(main.messages.length, 1)
  tray.state.visible = true
  tray.target.emit('show')
  assert.equal(tray.messages.length, 0)
  const latest = update('latest')
  subscriptions.publish('monitor:changed', latest)
  subscriptions.publish('monitor:sources', heartbeat)
  assert.deepEqual(tray.messages, [
    { channel: 'monitor:changed', payload: latest }, { channel: 'monitor:sources', payload: heartbeat }
  ])
  subscriptions.dispose()
})

test('pause, minimize and a hundred repeated subscription cycles do not accumulate delivery or native listeners', () => {
  const subscriptions = new MonitorSubscriptions(false), current = windowFixture()
  subscriptions.register(current.window)
  for (let cycle = 0; cycle < 100; cycle++) {
    subscriptions.set(current.window.webContents, true, false)
    subscriptions.set(current.window.webContents, true, false)
    subscriptions.publish('monitor:changed', update(String(cycle)))
    subscriptions.set(current.window.webContents, false, false)
    subscriptions.publish('monitor:changed', update('paused'))
  }
  assert.equal(current.messages.length, 100)
  assert.ok(current.messages.every((message, index) => (message.payload as MonitorUpdate).state.error === String(index)))
  for (const event of ['show', 'hide', 'minimize', 'restore', 'closed']) assert.equal(current.target.listenerCount(event), 1)
  subscriptions.set(current.window.webContents, true, false)
  current.state.minimized = true
  current.target.emit('minimize')
  subscriptions.publish('monitor:changed', update('minimized'))
  assert.equal(current.messages.length, 100)
  current.state.minimized = false
  current.target.emit('restore')
  subscriptions.publish('monitor:changed', update('restored'))
  assert.equal((current.messages.at(-1)!.payload as MonitorUpdate).state.error, 'restored')
  subscriptions.dispose()
  assert.equal(current.target.eventNames().length, 0)
  assert.equal(current.contents.eventNames().length, 0)
})

test('a replacement document and renderer crash invalidate subscriptions; same-document and child navigation preserve them', () => {
  const subscriptions = new MonitorSubscriptions(false), current = windowFixture()
  subscriptions.register(current.window)
  subscriptions.set(current.window.webContents, true, true)
  for (const details of [{ isMainFrame: false, isSameDocument: false }, { isMainFrame: true, isSameDocument: true }]) {
    current.contents.emit('did-start-navigation', details)
    subscriptions.publish('monitor:changed', update(null))
  }
  assert.equal(current.messages.length, 2)
  current.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  subscriptions.publish('monitor:changed', update('old document'))
  subscriptions.publish('monitor:sources', heartbeat)
  assert.equal(current.messages.length, 2)
  subscriptions.set(current.window.webContents, true, true)
  subscriptions.publish('monitor:sources', heartbeat)
  assert.equal(current.messages.length, 3)
  current.contents.emit('render-process-gone')
  subscriptions.publish('monitor:changed', update('crashed'))
  subscriptions.publish('monitor:sources', heartbeat)
  assert.equal(current.messages.length, 3)
  subscriptions.dispose()
})

test('destroyed windows release their slot and listeners; unowned windows and excess registrations are refused', () => {
  const subscriptions = new MonitorSubscriptions(false)
  const main = windowFixture(), tray = windowFixture(), extra = windowFixture()
  subscriptions.register(main.window)
  subscriptions.register(tray.window)
  assert.throws(() => subscriptions.register(extra.window), RangeError)
  assert.throws(() => subscriptions.set(extra.window.webContents, true, false))
  subscriptions.set(main.window.webContents, true, true)
  main.state.destroyed = true
  main.contents.emit('destroyed')
  assert.equal(main.target.eventNames().length, 0)
  assert.equal(main.contents.eventNames().length, 0)
  subscriptions.register(extra.window)
  subscriptions.set(extra.window.webContents, true, false)
  subscriptions.publish('monitor:changed', update('replacement'))
  assert.equal(main.messages.length, 0)
  assert.equal(extra.messages.length, 1)
  tray.target.emit('closed')
  assert.equal(tray.contents.eventNames().length, 0)
  subscriptions.dispose()
  subscriptions.publish('monitor:changed', update('shutdown'))
  assert.equal(extra.messages.length, 1)
})

test('headless rendering follows explicit document subscriptions without showing native windows', () => {
  const subscriptions = new MonitorSubscriptions(true), current = windowFixture(false)
  subscriptions.register(current.window)
  subscriptions.publish('monitor:changed', update('unsubscribed'))
  assert.equal(current.messages.length, 0)
  subscriptions.set(current.window.webContents, true, false)
  subscriptions.publish('monitor:changed', update('visible document'))
  assert.equal(current.messages.length, 1)
  subscriptions.set(current.window.webContents, false, false)
  subscriptions.publish('monitor:changed', update('hidden document'))
  assert.equal(current.messages.length, 1)
  assert.equal(current.state.visible, false)
  subscriptions.dispose()
})
