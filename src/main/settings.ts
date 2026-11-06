import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_SETTINGS, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, type AppSettings, type SettingsPatch, type PluginSettings, type WindowBounds, type SettingsFailureReason, type SettingsUpdateFailure } from '../shared/settings'
import { THEME_IDS } from '../shared/themes'
import { DiagnosticError, summarizeDiagnostic, type DiagnosticCode, type DiagnosticStage } from '../shared/diagnostics'
import { NOTIFICATION_SOURCE_LIMIT, NOTIFICATION_TASK_LIMIT, type NotificationSettings } from '../shared/notifications'
import { EVENT_TYPES, type LocalEventType } from '../shared/events'
import { parseNavigationTarget } from '../shared/navigation'
import { isDeepStrictEqual } from 'node:util'

export const SETTINGS_MAX_BYTES = 64 * 1024
const maxPendingUpdates = 16
const settingsDecoder = new TextDecoder('utf-8', { fatal: true })

const choices = {
  appearance: ['system', 'light', 'dark'],
  lightTheme: THEME_IDS,
  darkTheme: THEME_IDS,
  language: ['system', 'zh-CN', 'en'],
  textSize: ['small', 'default', 'large'],
  uiFont: ['system', 'pingfang', 'helvetica'],
  codeFont: ['system', 'menlo', 'monaco'],
  trayClick: ['tray', 'main']
} as const

function settingsFailureReason(code: DiagnosticCode | undefined): SettingsFailureReason {
  switch (code) {
    case 'EACCES':
    case 'EPERM': return 'permission-denied'
    case 'ENOSPC':
    case 'EDQUOT': return 'storage-full'
    case 'EROFS': return 'read-only'
    case 'EISDIR':
    case 'ENOTDIR':
    case 'EEXIST': return 'path-conflict'
    case 'ENOENT': return 'path-unavailable'
    case 'ETIMEDOUT': return 'timeout'
    default: return 'unknown'
  }
}

export function settingsUpdateFailure(error: unknown, filename: string): SettingsUpdateFailure {
  const diagnostic = summarizeDiagnostic(error, 'settings-save', 'settings')
  return { reason: settingsFailureReason(diagnostic.primaryCode), details: diagnostic.details, filePath: path.resolve(filename) }
}

export function equalWindowBounds(a: WindowBounds | null, b: WindowBounds | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
}

function validateWindowBounds(value: unknown): WindowBounds | null {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new Error('窗口几何必须是对象 / Window geometry must be an object')
  const bounds = value as Record<string, unknown>
  for (const key in bounds) if (!['x', 'y', 'width', 'height'].includes(key)) throw new Error('未知窗口几何字段 / Unknown window geometry field')
  for (const key of ['x', 'y', 'width', 'height']) if (!Number.isSafeInteger(bounds[key])) throw new Error('窗口几何必须是整数 / Window geometry must use integers')
  const { x, y, width, height } = bounds as unknown as WindowBounds
  if (Math.abs(x) > 131072 || Math.abs(y) > 131072 || width < 320 || width > 16384 || height < 240 || height > 16384)
    throw new Error('窗口几何超出范围 / Window geometry is outside the allowed range')
  return { x, y, width, height }
}

function validatePlugins(value: unknown): Partial<PluginSettings> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new Error('插件设置必须是对象 / Plugin settings must be an object')
  const result: Partial<PluginSettings> = {}
  for (const id in value) {
    if (!Object.hasOwn(DEFAULT_SETTINGS.plugins, id)) throw new Error('未知采集插件 / Unknown collection plugin')
    const entry = Object.getOwnPropertyDescriptor(value, id)
    if (!entry || !('value' in entry) || typeof entry.value !== 'boolean')
      throw new Error('插件启停必须是布尔值 / Plugin state must be a boolean')
    result[id as keyof PluginSettings] = entry.value
  }
  return result
}

function equalPlugins(a: PluginSettings, b: PluginSettings): boolean {
  return a.agents === b.agents && a.schedules === b.schedules && a.system === b.system && a.events === b.events
}

function validateNotifications(value: unknown): NotificationSettings {
  const bad = (): never => { throw new Error('通知设置无效或超过资源上限 / Invalid notification settings or resource limit exceeded') }
  const record = (input: unknown, keys: string[]): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) return bad()
    const actual = Object.keys(input)
    if (actual.length !== keys.length || actual.some(key => !keys.includes(key)) ||
        actual.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) return bad()
    return input as Record<string, unknown>
  }
  const input = record(value, ['enabled', 'sourceIds', 'tasks', 'types', 'quiet', 'showTaskNames'])
  if (typeof input.enabled !== 'boolean' || typeof input.showTaskNames !== 'boolean') return bad()
  if (!Array.isArray(input.sourceIds) || input.sourceIds.length > NOTIFICATION_SOURCE_LIMIT ||
      input.sourceIds.some(id => typeof id !== 'string' || !id || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) ||
      new Set(input.sourceIds).size !== input.sourceIds.length) return bad()
  if (!Array.isArray(input.types) || input.types.length > EVENT_TYPES.length ||
      input.types.some(type => !EVENT_TYPES.includes(type as LocalEventType)) || new Set(input.types).size !== input.types.length) return bad()
  if (!Array.isArray(input.tasks) || input.tasks.length > NOTIFICATION_TASK_LIMIT) return bad()
  const tasks = input.tasks.map(item => {
    record(item, ['kind', 'id', 'identity'])
    const target = parseNavigationTarget(item)
    if (target.kind !== 'schedule' || !target.id.startsWith('hermes-job:') || target.identity.length > 1536) return bad()
    return target
  })
  if (new Set(tasks.map(task => JSON.stringify([task.id, task.identity]))).size !== tasks.length) return bad()
  const quiet = record(input.quiet, ['enabled', 'startMinute', 'endMinute'])
  if (typeof quiet.enabled !== 'boolean' || !Number.isSafeInteger(quiet.startMinute) || !Number.isSafeInteger(quiet.endMinute) ||
      (quiet.startMinute as number) < 0 || (quiet.startMinute as number) > 1439 || (quiet.endMinute as number) < 0 ||
      (quiet.endMinute as number) > 1439 || quiet.enabled && quiet.startMinute === quiet.endMinute) return bad()
  const result: NotificationSettings = { enabled: input.enabled, sourceIds: [...input.sourceIds], tasks,
    types: [...input.types], quiet: { enabled: quiet.enabled, startMinute: quiet.startMinute as number, endMinute: quiet.endMinute as number }, showTaskNames: input.showTaskNames }
  if (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024) return bad()
  return result
}

function copySettings(settings: AppSettings): AppSettings {
  return { ...settings, windowBounds: settings.windowBounds ? { ...settings.windowBounds } : null, plugins: { ...settings.plugins },
    notifications: { ...settings.notifications, sourceIds: [...settings.notifications.sourceIds], types: [...settings.notifications.types],
      tasks: settings.notifications.tasks.map(task => ({ ...task })), quiet: { ...settings.notifications.quiet } } }
}

export function validateSettings(value: unknown): SettingsPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('设置必须是对象 / Settings must be an object')
  }
  const result: Record<string, unknown> = {}
  for (const key in value) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error('未知设置字段 / Unknown setting field')
    const entry = (value as Record<string, unknown>)[key]
    if (key === 'showDock' || key === 'preventSleep') {
      if (typeof entry !== 'boolean') throw new Error(`设置 ${key} 必须是布尔值 / Must be a boolean`)
    } else if (key === 'glassIntensity') {
      if (!Number.isSafeInteger(entry) || (entry as number) < 0 || (entry as number) > 100)
        throw new Error('液态玻璃程度必须是 0–100 的整数 / Glass intensity must be an integer from 0 to 100')
    } else if (key === 'sidebarWidth') {
      if (!Number.isSafeInteger(entry) || (entry as number) < MIN_SIDEBAR_WIDTH || (entry as number) > MAX_SIDEBAR_WIDTH)
        throw new Error('侧栏宽度超出范围 / Sidebar width is outside the allowed range')
    } else if (key === 'windowBounds') {
      result[key] = validateWindowBounds(entry)
      continue
    } else if (key === 'plugins') {
      result[key] = validatePlugins(entry)
      continue
    } else if (key === 'notifications') {
      result[key] = validateNotifications(entry)
      continue
    } else if (!(choices[key as keyof typeof choices] as readonly unknown[]).includes(entry)) {
      throw new Error(`设置 ${key} 的值无效 / Invalid setting value`)
    }
    result[key] = entry
  }
  return result as SettingsPatch
}

export async function readSettings(filename: string): Promise<AppSettings> {
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return copySettings(DEFAULT_SETTINGS)
    throw new DiagnosticError('settings-open', error)
  }
  let content = '', failure: unknown, stage: DiagnosticStage = 'settings-stat'
  try {
    const before = await file.stat()
    if (!before.isFile()) throw new DiagnosticError(stage, undefined, 'OC_SETTINGS_NOT_REGULAR')
    if (before.size > SETTINGS_MAX_BYTES) throw new DiagnosticError(stage, undefined, 'OC_SETTINGS_TOO_LARGE')
    // One extra byte detects growth without trusting the earlier size or allocating for the new size.
    const buffer = Buffer.allocUnsafe(before.size + 1)
    let offset = 0
    stage = 'settings-read'
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, Math.min(16 * 1024, buffer.length - offset), offset)
      if (!bytesRead) break
      offset += bytesRead
      if (offset > SETTINGS_MAX_BYTES) throw new DiagnosticError(stage, undefined, 'OC_SETTINGS_TOO_LARGE')
      if (offset > before.size) throw new DiagnosticError(stage, undefined, 'OC_SETTINGS_CHANGED')
    }
    stage = 'settings-stat'
    const after = await file.stat()
    if (after.size !== before.size || offset !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new DiagnosticError(stage, undefined, 'OC_SETTINGS_CHANGED')
    stage = 'settings-decode'
    try { content = settingsDecoder.decode(buffer.subarray(0, offset)) } catch (error) {
      throw new DiagnosticError(stage, error, 'OC_SETTINGS_ENCODING_INVALID')
    }
  } catch (error) {
    failure = error instanceof DiagnosticError ? error : new DiagnosticError(stage, error)
  }
  try { await file.close() } catch (error) {
    const closeError = new DiagnosticError('settings-close', error)
    failure = failure ? new AggregateError([failure, closeError]) : closeError
  }
  if (failure) throw new DiagnosticError('settings-read', failure)
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch (error) {
    throw new DiagnosticError('settings-decode', error, 'OC_SETTINGS_INVALID')
  }
  try {
    const patch = validateSettings(parsed)
    return copySettings({ ...DEFAULT_SETTINGS, ...patch, plugins: { ...DEFAULT_SETTINGS.plugins, ...patch.plugins } })
  } catch (error) {
    throw new DiagnosticError('settings-validate', error, 'OC_SETTINGS_INVALID')
  }
}

export async function writeSettings(filename: string, settings: AppSettings): Promise<void> {
  try { await mkdir(path.dirname(filename), { recursive: true }) } catch (error) {
    throw new DiagnosticError('settings-directory', error)
  }
  const temporary = `${filename}.${randomUUID()}.tmp`
  let file: Awaited<ReturnType<typeof open>>
  try { file = await open(temporary, 'wx', 0o600) } catch (error) {
    throw new DiagnosticError('settings-open', error)
  }
  let failure: unknown, stage: DiagnosticStage = 'settings-write'
  try {
    await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    stage = 'settings-sync'
    await file.sync()
  } catch (error) {
    failure = new DiagnosticError(stage, error)
  }
  try { await file.close() } catch (error) {
    const closeError = new DiagnosticError('settings-close', error)
    failure = failure ? new AggregateError([failure, closeError]) : closeError
  }
  if (!failure) {
    try { await rename(temporary, filename); return } catch (error) {
      failure = new DiagnosticError('settings-rename', error)
    }
  }
  try { await unlink(temporary) } catch (error) {
    failure = new AggregateError([failure, new DiagnosticError('settings-cleanup', error)])
  }
  throw new DiagnosticError('settings-save', failure)
}

export class SettingsRollbackError extends DiagnosticError {
  constructor(cause: unknown) {
    super('settings-rollback', cause)
    this.name = 'SettingsRollbackError'
  }
}

export class SettingsStore {
  private current: AppSettings
  private queue: Promise<void> = Promise.resolve()
  private pendingUpdates = 0
  private fatalError: SettingsRollbackError | undefined
  isUpdating = false

  constructor(
    private readonly filename: string,
    initial: AppSettings,
    private readonly apply: (settings: AppSettings) => Promise<void>,
    private readonly save = writeSettings
  ) {
    this.current = copySettings(initial)
  }

  get value(): AppSettings {
    if (this.fatalError) throw this.fatalError
    return copySettings(this.current)
  }

  async idle(): Promise<void> {
    let pending: Promise<void>
    do {
      pending = this.queue
      await pending
    } while (pending !== this.queue)
    if (this.fatalError) throw this.fatalError
  }

  update(input: unknown): Promise<AppSettings> {
    let patch: SettingsPatch
    try {
      patch = validateSettings(input)
    } catch (error) {
      return Promise.reject(new DiagnosticError('settings-validate', error, 'OC_SETTINGS_INVALID'))
    }
    if (this.pendingUpdates >= maxPendingUpdates)
      return Promise.reject(new DiagnosticError('settings-apply', undefined, 'OC_SETTINGS_BUSY', 'settings'))
    this.pendingUpdates++
    const operation = this.queue.then(async () => {
      if (this.fatalError) throw this.fatalError
      const previous = this.current
      const next = { ...previous, ...patch, plugins: patch.plugins ? { ...previous.plugins, ...patch.plugins } : previous.plugins }
      if ((Object.keys(next) as (keyof AppSettings)[]).every(key => key === 'windowBounds'
        ? equalWindowBounds(next.windowBounds, previous.windowBounds)
        : key === 'plugins' ? equalPlugins(next.plugins, previous.plugins)
          : key === 'notifications' ? isDeepStrictEqual(next.notifications, previous.notifications) : next[key] === previous[key])) {
        return this.value
      }
      this.isUpdating = true
      let stage: DiagnosticStage = 'settings-apply'
      try {
        await this.apply(next)
        stage = 'settings-save'
        await this.save(this.filename, next)
        this.current = next
        return this.value
      } catch (error) {
        const failure = error instanceof DiagnosticError ? error : new DiagnosticError(stage, error)
        try {
          await this.apply(previous)
        } catch (rollbackError) {
          this.fatalError = new SettingsRollbackError(new AggregateError([
            failure, new DiagnosticError('settings-rollback', rollbackError)
          ]))
          throw this.fatalError
        }
        throw failure
      } finally {
        this.isUpdating = false
      }
    }).finally(() => { this.pendingUpdates-- })
    // The caller receives the rejection; only the queue barrier consumes it so later edits can proceed.
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }
}
