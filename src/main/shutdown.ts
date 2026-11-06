import { DiagnosticError } from '../shared/diagnostics'

export const SHUTDOWN_TIMEOUT_MS = 5000
const resources = ['monitor', 'navigation', 'diagnostics', 'settings', 'desktop', 'tray', 'theme'] as const
type Resource = typeof resources[number]
export type ShutdownOperations = Record<Resource, () => void | Promise<void>>

/** The caller must exit on failure: a timed-out operation has NOT finished cleanup. */
export function drainShutdown(operations: ShutdownOperations, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SHUTDOWN_TIMEOUT_MS) return Promise.reject(new RangeError('Invalid shutdown deadline'))
  return new Promise((resolve, reject) => {
    const pending = new Set<Resource>(resources)
    const failures: unknown[] = []
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      reject(new AggregateError([...failures, ...[...pending].map(resource => new DiagnosticError('shutdown', undefined, 'OC_SHUTDOWN_TIMEOUT', resource))], '退出排空超时 / Shutdown drain timed out'))
    }, timeoutMs)
    const finish = (resource: Resource, failed: boolean, error?: unknown) => {
      if (settled) return
      if (failed) failures.push(new DiagnosticError('shutdown', error, undefined, resource))
      pending.delete(resource)
      if (resource === 'settings') {
        release('monitor')
        release('desktop')
      }
      if (settled || pending.size) return
      settled = true
      clearTimeout(timer)
      if (failures.length) reject(new AggregateError(failures, '退出清理失败 / Shutdown cleanup failed'))
      else resolve()
    }
    const release = (resource: Resource) => {
      try { Promise.resolve(operations[resource]()).then(() => finish(resource, false), error => finish(resource, true, error)) }
      catch (error) { finish(resource, true, error) }
    }
    // Settings can still apply plugin and desktop effects while persisting final geometry.
    // Keep those targets alive until the settings transaction settles, including on failure.
    for (const resource of resources) if (resource !== 'monitor' && resource !== 'desktop') release(resource)
  })
}
