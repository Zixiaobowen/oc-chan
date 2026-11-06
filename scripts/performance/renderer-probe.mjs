import { eventKeys, stamp } from './event-keys.mjs'

const view = new URLSearchParams(location.search).get('view') === 'tray' ? 'tray' : 'main'
const seen = new Map()
let ready = false
let commits = 0
let inputAt = null
let missingSnapshots = 0
const report = row => window.__ocPerformance.report(row)

// React's existing devtools commit hook observes the committed state, not an arbitrary
// animation frame after IPC. The source fingerprint and React version are in the report.
function committedSnapshot(root) {
  const stack = [root.current]
  let visited = 0
  while (stack.length && visited++ < 256) {
    const fiber = stack.pop()
    if (!fiber) continue
    if (fiber.type?.name === (view === 'main' ? 'App' : 'TrayView')) {
      let hook = fiber.memoizedState
      for (let count = 0; hook && count < 256; count++, hook = hook.next) {
        const value = hook.memoizedState
        if (value && typeof value === 'object' && 'agents' in value && 'schedules' in value && 'system' in value) return value
      }
      throw new Error('Performance probe cannot locate the committed snapshot hook')
    }
    if (fiber.sibling) stack.push(fiber.sibling)
    if (fiber.child) stack.push(fiber.child)
  }
  return null
}
const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ ?? {
  supportsFiber: true, renderers: new Map(),
  inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id },
  onCommitFiberUnmount() {}, checkDCE() {}
}
const originalCommit = hook.onCommitFiberRoot
hook.onCommitFiberRoot = function (renderer, root, ...rest) {
  originalCommit?.call(this, renderer, root, ...rest)
  try {
    const snapshot = committedSnapshot(root)
    if (!snapshot) {
      if (++missingSnapshots > 20) throw new Error('Performance probe did not observe the product component')
      return
    }
    missingSnapshots = 0
    commits++
    const at = stamp()
    const keys = eventKeys(snapshot.agents.data, seen)
    if (keys.length) report(['c', at, view, keys])
    if (!ready && snapshot.agents.data && snapshot.schedules.data && snapshot.system.data) {
      ready = true
      report(['commit-ready', at, view])
    }
    if (inputAt !== null) { report(['input', at, view, inputAt]); inputAt = null }
  } catch (error) { report(['probe-error', stamp(), view, String(error)]) }
}
globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook
for (const event of ['pointerdown', 'keydown', 'input']) document.addEventListener(event, () => { inputAt ??= stamp() }, true)
globalThis.__ocPerfState = {
  get ready() { return ready }, get commits() { return commits },
  // Renderer visibility is simulated for headless runs; native show/focus is forbidden.
  visibility(hidden) {
    if (typeof hidden !== 'boolean') throw new Error('Invalid visibility state')
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  }
}
