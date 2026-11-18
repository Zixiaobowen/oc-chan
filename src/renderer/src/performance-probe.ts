// Imported only by the isolated acceptance Vite transform; never by product code.
import { useLayoutEffect } from 'react'
import type { MonitorSnapshot, MonitorUpdate } from '../../shared/types'
import { setHeadlessPresentationHidden } from './desktop-visibility'

type Row = unknown[]
const stamp = () => performance.timeOrigin + performance.now()
const view = new URLSearchParams(location.search).get('view') === 'tray' ? 'tray' : 'main'
const rows: Row[] = []
const received = new Map<number, number>(), committed = new Map<number, number>()
let overflow = 0, commits = 0, ready = false, disposed = false, inputAt: number | null = null
let visibilityOverridden = false
let current: MonitorSnapshot | null = null, setter: ((value: MonitorSnapshot) => void) | null = null
const push = (row: Row) => { if (!disposed) { if (rows.length === 8192) overflow++; else rows.push(row) } }
function keys(data: MonitorSnapshot['agents']['data'], seen: Map<number, number>) {
  const result: number[][] = []
  for (const agent of data?.agents ?? []) {
    const match = /^perf_(\d+)_(\d+)$/.exec(agent.activity?.name ?? '')
    if (!match) continue
    const index = Number(match[1]), sequence = Number(match[2])
    if (index >= 128) continue
    if (seen.get(index) !== sequence) result.push([index, sequence])
    seen.set(index, sequence)
  }
  return result
}
export function performanceReceive(key: string, payload: unknown) {
  if (disposed) return
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length
  push(['channel-payload', stamp(), view, key, bytes])
  if (key !== 'monitor') return
  const update = payload as MonitorUpdate
  push(['ipc-payload', stamp(), update.section, view, bytes])
  if (update.section === 'agents') push(['i', stamp(), view, keys(update.state.data as MonitorSnapshot['agents']['data'], received)])
}
export function usePerformanceSnapshot(snapshot: MonitorSnapshot, setSnapshot: (value: MonitorSnapshot) => void) {
  useLayoutEffect(() => {
    if (disposed) return
    if (!snapshot.agents.data?.agents.some(agent => agent.id.startsWith('performance-render:'))) current = snapshot
    setter = setSnapshot; commits++
    push(['c', stamp(), view, keys(snapshot.agents.data, committed)])
    if (!ready && snapshot.agents.data && snapshot.schedules.data) { ready = true; push(['commit-ready', stamp(), view]) }
    if (inputAt !== null) { push(['input', stamp(), view, inputAt]); inputAt = null }
  })
  useLayoutEffect(() => () => { current = null; setter = null }, [])
}
const input = () => { inputAt ??= stamp() }
for (const name of ['pointerdown', 'keydown', 'input']) document.addEventListener(name, input, true)
// Native rAF timestamps only group draw intervals; they do not prove presentation.
let lastFrame: number | null = null, lastDraw = -1
let pendingDrawCalls = 0, drawBatchQueued = false, drawBatches = 0, drawCalls = 0
const flushDrawBatch = () => {
  drawBatchQueued = false
  const count = pendingDrawCalls
  pendingDrawCalls = 0
  if (disposed || count === 0) return
  if (!Number.isSafeInteger(drawCalls + count) || drawBatches === Number.MAX_SAFE_INTEGER) { overflow++; return }
  drawBatches++; drawCalls += count
  push(['webgl-draw-batch', stamp(), view, count, { documentHidden: document.hidden, visibilityState: document.visibilityState, nativeRafTimestamp: frame }])
}
const restorers: (() => void)[] = []
for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
  for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'] as const) {
    const object = prototype as unknown as Record<string, (...args: unknown[]) => unknown>
    if (!Object.hasOwn(object, name)) continue
    const original = object[name]
    object[name] = function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args)
      if (disposed) return result
      // One pending microtask per synchronous draw burst, independent of suspended rAF.
      if (pendingDrawCalls === 65536) overflow++
      else pendingDrawCalls++
      if (!drawBatchQueued) { drawBatchQueued = true; queueMicrotask(flushDrawBatch) }
      const at = performance.now()
      if (frame !== null && lastFrame !== frame) { if (lastDraw >= 0) push(['webgl-frame', stamp(), view, at - lastDraw]); lastDraw = at; lastFrame = frame }
      return result
    }
    restorers.push(() => { object[name] = original })
  }
}
let frame: number | null = null, raf = 0
const tick = (at: number) => { if (disposed) return; frame = at; raf = requestAnimationFrame(tick) }
raf = requestAnimationFrame(tick)
function dispose() {
  if (disposed) return
  disposed = true; cancelAnimationFrame(raf)
  pendingDrawCalls = 0
  for (const restore of restorers) restore()
  for (const name of ['pointerdown', 'keydown', 'input']) document.removeEventListener(name, input, true)
  if (visibilityOverridden) setHeadlessPresentationHidden(null)
  received.clear(); committed.clear(); rows.length = 0; current = null; setter = null
  window.removeEventListener('pagehide', dispose)
}
const probe = {
  clock: stamp,
  status: () => ({ ready, commits, overflow, disposed, drawBatches, drawCalls, documentHidden: document.hidden, visibilityState: document.visibilityState, nativeRafTimestamp: frame }),
  drain: () => ({ rows: rows.splice(0, 128), remaining: rows.length, overflow, documentHidden: document.hidden, visibilityState: document.visibilityState, nativeRafTimestamp: frame }),
  visibility(hidden: boolean) {
    if (disposed) throw new Error('Performance probe is disposed')
    if (typeof hidden !== 'boolean') throw new Error('Invalid visibility')
    setHeadlessPresentationHidden(hidden)
    visibilityOverridden = true
  },
  topology(count: number) {
    if (![128, 500, 2000].includes(count) || !current?.agents.data || !setter) throw new Error('Topology fixture unavailable')
    const originals = current.agents.data.agents.filter(agent => !agent.id.startsWith('performance-render:'))
    if (!originals.length) throw new Error('Topology needs a real collected agent')
    const agents = Array.from({ length: count }, (_, index) => ({ ...originals[index % originals.length], id: `performance-render:${index}`, parentId: undefined }))
    setter({ ...current, agents: { ...current.agents, data: { ...current.agents.data, agents } } })
    return { count, scope: 'renderer-only expansion of collected agents; excluded from collection coverage' }
  },
  dispose
}
Object.defineProperty(window, '__ocPerf', { configurable: true, value: probe })
window.addEventListener('pagehide', dispose, { once: true })
