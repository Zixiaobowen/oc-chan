import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { MonitorApi, MonitorUpdate, SourceHeartbeat } from '../../shared/types'
import type { SettingsApi, SettingsSnapshot } from '../../shared/settings'
import type { UpdatesApi, UpdateSnapshot } from '../../shared/updates'
import type { MarketplaceApi, MarketplaceSnapshot } from '../../shared/marketplace'
import type { StartupRecoveryApi } from '../../shared/startup-recovery'
import { registerDesktopVisibility } from './desktop-visibility'

type Messages = {
  monitor: MonitorUpdate
  sources: SourceHeartbeat
  settings: SettingsSnapshot
  updates: UpdateSnapshot
  marketplace: MarketplaceSnapshot
  navigation: null
}
type Interest = Record<keyof Messages, boolean>
type Registration = { owner: number; view: 'main' | 'tray' | 'recovery'; headless: boolean }
type Envelope<T> = { owner: number; sequence: number; value: T }
const channels: Record<keyof Messages, string> = {
  monitor: 'monitor-changed', sources: 'monitor-sources', settings: 'settings-changed',
  updates: 'updates-changed', marketplace: 'marketplace-changed', navigation: 'monitor-navigation'
}
let commitDocument: (() => Promise<void>) | null = null
export async function reportDesktopCommit(): Promise<void> {
  if (!commitDocument) throw new Error('桌面窗口尚未登记 / Desktop document is not registered')
  await commitDocument()
}

// Local Rust errors contain controlled context. Keep it here; the separate
// shareable diagnostic projection intentionally omits messages and unknown codes.
const DESKTOP_ERROR_MAX_DEPTH = 8 // Root is depth zero; retain depths 0 through 7.
const DESKTOP_ERROR_MAX_NODES = 64
const DESKTOP_ERROR_MAX_BYTES = 16 * 1024 // UTF-8, including the omission notice.
type DesktopFailure = Error & {
  code?: string
  osError?: number
  errno?: number
  causes?: DesktopFailure[]
  errors?: DesktopFailure[]
  truncated?: string[]
}

export function desktopError(value: unknown): Error {
  if (value instanceof Error) return value
  const limits = new Set<string>()
  const visited = new Set<object>()
  const lines: string[] = []
  let nodes = 0
  let remaining = DESKTOP_ERROR_MAX_BYTES - 256 // Reserve the bounded notice below.
  // Scan only the retained prefix, without encoding/copying an unbounded string.
  const text = (input: string): string => {
    let end = 0
    while (end < input.length) {
      const point = input.codePointAt(end)!
      const bytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
      if (bytes > remaining) { limits.add('bytes'); break }
      remaining -= bytes
      end += point > 0xffff ? 2 : 1
    }
    return input.slice(0, end)
  }
  const invalid = (field: string): TypeError => new TypeError(`桌面错误格式无效 / Invalid desktop error: ${field}`)
  const visit = (input: unknown, depth: number): DesktopFailure | undefined => {
    if (depth >= DESKTOP_ERROR_MAX_DEPTH) { limits.add('depth'); return }
    if (nodes >= DESKTOP_ERROR_MAX_NODES) { limits.add('nodes'); return }
    if (remaining === 0) { limits.add('bytes'); return }
    nodes++
    if (typeof input === 'object' && input !== null) {
      if (visited.has(input)) { limits.add('cycle-or-repeat'); return }
      visited.add(input)
    }
    let code: string | undefined, message: string, osError: number | undefined
    let causes: unknown[] = []
    let malformed: TypeError | undefined
    if (depth === 0 && typeof input === 'string') {
      // Tauri transport failures can be strings, independently of the Rust contract.
      message = input
    } else {
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('expected Rust error object')
        const data = (key: string): unknown => {
          const property = Object.getOwnPropertyDescriptor(input, key)
          if (property && !('value' in property)) throw invalid(`${key} accessor`)
          return property?.value
        }
        const rawCode = data('code'), rawMessage = data('message')
        const rawOsError = data('osError'), rawCauses = data('causes')
        if (typeof rawCode !== 'string') throw invalid('code must be a string')
        if (typeof rawMessage !== 'string') throw invalid('message must be a string')
        if (rawOsError !== undefined && (!Number.isInteger(rawOsError) || (rawOsError as number) < -2147483648 || (rawOsError as number) > 2147483647)) throw invalid('osError must be an i32')
        if (rawCauses !== undefined && !Array.isArray(rawCauses)) throw invalid('causes must be an array')
        code = rawCode
        message = rawMessage
        osError = rawOsError as number | undefined
        causes = (rawCauses as unknown[] | undefined) ?? []
      } catch (error) {
        // Never coerce arbitrary objects or silently turn invalid payloads into a
        // successful Rust error. Inspection exceptions keep their original identity.
        if (!(error instanceof TypeError) || !error.message.startsWith('桌面错误格式无效 / Invalid desktop error: ')) throw error
        malformed = error
        code = 'OC_DESKTOP_ERROR_INVALID'
        message = error.message
      }
    }
    const prefix = text(depth === 0 ? '' : `\n${'  '.repeat(depth)}${depth}: `)
    const boundedCode = code === undefined ? undefined : text(code)
    const ownMessage = (boundedCode === undefined ? '' : boundedCode + text(': ')) + text(message)
      + (osError === undefined ? '' : text(` (osError=${osError})`))
    lines.push(prefix + ownMessage)
    const children: DesktopFailure[] = []
    for (let index = 0; index < causes.length; index++) {
      const child = visit(causes[index], depth + 1)
      if (child) children.push(child)
      if (depth + 1 >= DESKTOP_ERROR_MAX_DEPTH || nodes >= DESKTOP_ERROR_MAX_NODES || remaining === 0) {
        if (index + 1 < causes.length) limits.add(depth + 1 >= DESKTOP_ERROR_MAX_DEPTH ? 'depth' : nodes >= DESKTOP_ERROR_MAX_NODES ? 'nodes' : 'bytes')
        break
      }
    }
    const error: DesktopFailure = malformed ?? (children.length ? new AggregateError(children, ownMessage) : new Error(ownMessage))
    error.message = ownMessage
    if (boundedCode !== undefined) error.code = boundedCode
    if (osError !== undefined) { error.osError = osError; error.errno = osError }
    // AggregateError.errors is consumed by summarizeDiagnostic; causes preserves
    // the Rust shape. Both refer to the same bounded array, with no tree copy.
    error.causes = error instanceof AggregateError ? error.errors as DesktopFailure[] : children
    return error
  }
  const error = visit(value, 0)!
  if (limits.size) {
    error.truncated = [...limits]
    lines.push(`\n原因已省略 / Causes omitted: ${error.truncated.join(', ')}`)
  }
  error.message = lines.join('')
  return error
}

// Cancellation remains awaitable. Cleanup handlers use this to surface failures
// even after their component has unmounted; they must not create unhandled rejections.
export function reportDesktopFailure(value: unknown): void {
  window.dispatchEvent(new CustomEvent('oc-desktop-error', { detail: desktopError(value) }))
}

export async function initializeDesktop(onFailure: (error: Error) => void): Promise<() => void> {
  const documentKey = window.__OC_DESKTOP_DOCUMENT__
  if (typeof documentKey !== 'string' || !/^[a-f0-9-]{36}$/.test(documentKey)) throw new Error('桌面文档身份缺失 / Desktop document identity missing')
  const options = { headers: { 'X-OC-Document': documentKey } }
  let committed: Promise<void> | null = null
  const reportCommit = () => committed ??= call<void>('desktop_committed')
  let closed = false
  let releaseVisibility: (() => void) | null = null
  let failure: Error | null = null
  let owner = 0
  let receivedSequence = 0
  const unlisteners: UnlistenFn[] = []
  const listeners: { [K in keyof Messages]: Set<(value: Messages[K]) => void> } = {
    monitor: new Set(), sources: new Set(), settings: new Set(), updates: new Set(), marketplace: new Set(), navigation: new Set()
  }
  let requested = 0
  let acknowledged = 0
  let pumping: Promise<void> | null = null
  const fail = (value: unknown) => {
    if (closed || failure) return
    failure = desktopError(value)
    onFailure(failure)
  }
  const receiveFailure = (event: Event) => fail((event as CustomEvent<unknown>).detail)
  window.addEventListener('oc-desktop-error', receiveFailure)
  const ensureOpen = () => {
    if (closed) throw new Error('桌面连接已关闭 / Desktop connection closed')
    if (failure) throw failure
  }
  async function call<T>(command: string, args: object = {}): Promise<T> {
    ensureOpen()
    try { return await invoke<T>(command, { owner, args }, options) }
    catch (error) { throw desktopError(error) }
  }
  function receive<T>(payload: Envelope<T>, deliver: (value: T) => void): void {
    if (closed || payload.owner !== owner) return
    if (!Number.isSafeInteger(payload.sequence) || payload.sequence <= receivedSequence) {
      fail(new Error('桌面消息顺序无效 / Invalid desktop message sequence'))
      return
    }
    receivedSequence = payload.sequence
    try { if (!failure) deliver(payload.value) }
    catch (error) { fail(error) }
    finally {
      void invoke('desktop_ack', { owner, args: { sequence: payload.sequence } }, options).catch(fail)
    }
  }
  const queries: Record<'history' | 'events', { generation: number; cancelling: Promise<void> | null }> = {
    history: { generation: 0, cancelling: null }, events: { generation: 0, cancelling: null }
  }
  async function query<T>(kind: keyof typeof queries, command: string, args: object): Promise<T> {
    const state = queries[kind]
    const generation = ++state.generation
    await state.cancelling
    if (generation !== state.generation) throw new DOMException('查询已取消 / Query cancelled', 'AbortError')
    return call(command, args)
  }
  function cancelQuery(kind: keyof typeof queries, command: string): Promise<void> {
    const state = queries[kind]
    state.generation++
    if (state.cancelling) return state.cancelling
    const cancellation = call<void>(command)
    state.cancelling = cancellation
    void cancellation.then(() => { state.cancelling = null }, error => {
      state.cancelling = null
      fail(error)
    })
    return cancellation
  }
  function pump(): void {
    if (pumping || closed || failure) return
    pumping = Promise.resolve().then(async () => {
      while (!closed && acknowledged < requested) {
        const revision = requested
        const interest: Interest = {
          monitor: listeners.monitor.size > 0, sources: listeners.sources.size > 0,
          settings: listeners.settings.size > 0, updates: listeners.updates.size > 0,
          marketplace: listeners.marketplace.size > 0, navigation: listeners.navigation.size > 0
        }
        await call<void>('desktop_interest', { interest })
        acknowledged = revision
      }
    }).then(() => {
      pumping = null
      if (!closed && acknowledged < requested) pump()
    }, error => {
      pumping = null
      fail(error)
    })
  }
  async function barrier(): Promise<void> {
    ensureOpen()
    while (acknowledged < requested) {
      pump()
      await pumping
      ensureOpen()
    }
  }
  function subscribe<K extends keyof Messages>(key: K, listener: (value: Messages[K]) => void): () => void {
    ensureOpen()
    const set = listeners[key]
    const first = set.size === 0
    // Each registration owns its identity, including repeated use of one callback.
    const subscription = (value: Messages[K]) => listener(value)
    set.add(subscription)
    if (first) { requested++; pump() }
    let active = true
    return () => {
      if (!active) return
      active = false
      set.delete(subscription)
      if (!closed && set.size === 0) { requested++; pump() }
    }
  }
  function dispose(): void {
    if (closed) return
    closed = true
    if (commitDocument === reportCommit) commitDocument = null
    releaseVisibility?.()
    window.removeEventListener('pagehide', dispose)
    window.removeEventListener('oc-desktop-error', receiveFailure)
    for (const unlisten of unlisteners.splice(0)) unlisten()
    for (const set of Object.values(listeners)) set.clear()
  }
  window.addEventListener('pagehide', dispose, { once: true })
  try {
    const registration = await invoke<Registration>('desktop_register', {}, options)
    if (!Number.isSafeInteger(registration.owner) || registration.owner <= 0 || !['main', 'tray', 'recovery'].includes(registration.view) || typeof registration.headless !== 'boolean') {
      throw new Error('桌面窗口登记无效 / Invalid desktop window registration')
    }
    owner = registration.owner
    ensureOpen()
    const expected = new URLSearchParams(location.search).get('view') ?? 'main'
    if (expected !== registration.view) throw new Error('桌面窗口身份不匹配 / Desktop window identity mismatch')
    commitDocument = reportCommit
    releaseVisibility = registerDesktopVisibility(registration.headless)
    if (registration.view === 'recovery') {
      window.startupRecovery = Object.freeze<StartupRecoveryApi>({
        snapshot: () => call('recovery_snapshot'), retry: () => call('recovery_retry'), quit: () => call('recovery_quit')
      })
      return dispose
    }
    const failureUnlisten = await listen<Envelope<unknown>>('desktop-failure', event => receive(event.payload, fail))
    if (closed) failureUnlisten()
    else unlisteners.push(failureUnlisten)
    ensureOpen()
    const keys: (keyof Messages)[] = registration.view === 'main'
      ? ['monitor', 'sources', 'settings', 'updates', 'marketplace', 'navigation']
      : ['monitor', 'settings', 'marketplace']
    const results = await Promise.allSettled(keys.map(async key => {
      const unlisten = await listen<Envelope<Messages[typeof key]>>(channels[key], event => {
        receive(event.payload, value => {
          for (const listener of listeners[key]) (listener as (value: Messages[typeof key]) => void)(value)
        })
      })
      if (closed) unlisten()
      else unlisteners.push(unlisten)
    }))
    const rejected = results.find(result => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
    ensureOpen()
    window.monitor = Object.freeze<MonitorApi>({
      snapshot: async () => { await barrier(); return call('monitor_snapshot') },
      refresh: section => call('monitor_refresh', section === undefined ? {} : { section }),
      retrySource: sourceId => call('monitor_retry_source', { sourceId }),
      focusAgentInTern: agentId => call('monitor_focus_agent_in_tern', { agentId }),
      scheduleHistory: (jobId, offset) => query('history', 'monitor_schedule_history', { jobId, offset: offset ?? 0 }),
      cancelScheduleHistory: () => cancelQuery('history', 'monitor_cancel_schedule_history'),
      events: request => query('events', 'monitor_events', { query: request ?? {} }),
      cancelEvents: () => cancelQuery('events', 'monitor_cancel_events'),
      generateDiagnostics: () => call('diagnostics_generate'),
      copyDiagnostics: id => call('diagnostics_copy', { id }),
      saveDiagnostics: id => call('diagnostics_save', { id }),
      cancelDiagnostics: () => call('diagnostics_cancel'),
      navigation: async () => { await barrier(); return call('monitor_navigation') },
      acknowledgeNavigation: sequence => call('monitor_acknowledge_navigation', { sequence }),
      onNavigation: listener => subscribe('navigation', listener),
      subscribe: listener => subscribe('monitor', listener),
      subscribeSources: listener => subscribe('sources', listener)
    })
    window.desktopSettings = Object.freeze<SettingsApi>({
      snapshot: async () => { await barrier(); return call('settings_snapshot') },
      update: patch => call('settings_update', { patch }),
      retryGeometry: () => call('settings_retry_geometry'),
      previewGlass: intensity => call('settings_preview_glass', { intensity }),
      updateLoginItem: enabled => call('settings_update_login_item', { enabled }),
      requestNotificationPermission: () => call('settings_request_notification_permission'),
      accessibilityState: () => call('settings_accessibility_state'),
      openPermissionSettings: target => call('settings_open_permission_settings', { target }),
      showMainWindow: target => call('settings_show_main_window', target === undefined ? {} : { target }),
      subscribe: listener => subscribe('settings', listener)
    })
    window.pluginMarketplace = Object.freeze<MarketplaceApi>({
      snapshot: async () => { await barrier(); return call('marketplace_snapshot') },
      check: () => call('marketplace_check'), install: id => call('marketplace_install', { id }),
      update: id => call('marketplace_update', { id }), uninstall: id => call('marketplace_uninstall', { id }),
      cancel: () => call('marketplace_cancel'), subscribe: listener => subscribe('marketplace', listener)
    })
    if (registration.view === 'main') {
      window.appUpdates = Object.freeze<UpdatesApi>({
        snapshot: async () => { await barrier(); return call('updates_snapshot') },
        check: () => call('updates_check'), download: () => call('updates_download'),
        cancel: () => call('updates_cancel'), install: () => call('updates_install'),
        openReleaseNotes: () => call('updates_open_release_notes'), subscribe: listener => subscribe('updates', listener)
      })
    }
    return dispose
  } catch (error) {
    dispose()
    throw desktopError(error)
  }
}
