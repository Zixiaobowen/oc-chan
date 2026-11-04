import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings, type SettingsFailureReason, type SettingsUpdateFailure } from '../shared/settings'

const choices = {
  appearance: ['system', 'light', 'dark'],
  language: ['system', 'zh-CN', 'en'],
  textSize: ['small', 'default', 'large'],
  uiFont: ['system', 'pingfang', 'helvetica'],
  codeFont: ['system', 'menlo', 'monaco'],
  trayClick: ['tray', 'main']
} as const

export function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = [error.message, ...error.errors.map(describeError)]
    if (error.cause !== undefined) details.push(describeError(error.cause))
    return details.join('\n')
  }
  if (error instanceof Error) return `${error.message}${error.cause !== undefined ? `\n${describeError(error.cause)}` : ''}`
  return String(error)
}

function settingsFailureReason(error: unknown): SettingsFailureReason {
  // Aggregates put the failed operation first; later errors belong to close/cleanup.
  if (error instanceof AggregateError) return settingsFailureReason(error.errors[0])
  if (!(error instanceof Error)) return 'unknown'
  if ('code' in error) {
    switch (error.code) {
      case 'EACCES':
      case 'EPERM': return 'permission-denied'
      case 'ENOSPC':
      case 'EDQUOT': return 'storage-full'
      case 'EROFS': return 'read-only'
      case 'EISDIR':
      case 'ENOTDIR':
      case 'EEXIST': return 'path-conflict'
      case 'ENOENT': return 'path-unavailable'
      default: return 'unknown'
    }
  }
  return error.cause === undefined ? 'unknown' : settingsFailureReason(error.cause)
}

export function settingsUpdateFailure(error: unknown, filename: string): SettingsUpdateFailure {
  return { reason: settingsFailureReason(error), details: describeError(error), filePath: path.resolve(filename) }
}

export function validateSettings(value: unknown, partial = false): Partial<AppSettings> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('设置必须是对象 / Settings must be an object')
  }
  const entries = Object.entries(value)
  for (const [key, entry] of entries) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error(`未知设置 / Unknown setting: ${key}`)
    if (key === 'showDock' || key === 'preventSleep') {
      if (typeof entry !== 'boolean') throw new Error(`设置 ${key} 必须是布尔值 / Must be a boolean`)
    } else if (!(choices[key as keyof typeof choices] as readonly unknown[]).includes(entry)) {
      throw new Error(`设置 ${key} 的值无效 / Invalid setting value`)
    }
  }
  if (!partial && entries.length !== Object.keys(DEFAULT_SETTINGS).length) {
    throw new Error('设置文件缺少必需字段 / Settings file is missing required fields')
  }
  return { ...value } as Partial<AppSettings>
}

export async function readSettings(filename: string): Promise<AppSettings> {
  let content: string
  try {
    content = await readFile(filename, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { ...DEFAULT_SETTINGS }
    throw new Error(`无法读取设置 / Cannot read settings: ${filename}`, { cause: error })
  }
  try {
    return validateSettings(JSON.parse(content)) as AppSettings
  } catch (error) {
    throw new Error(`设置文件损坏或无效 / Invalid settings file: ${filename}`, { cause: error })
  }
}

export async function writeSettings(filename: string, settings: AppSettings): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  let failure: unknown
  try {
    await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await file.sync()
  } catch (error) {
    failure = error
  }
  try {
    await file.close()
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], '写入和关闭设置失败 / Settings write and close failed') : error
  }
  if (!failure) {
    try {
      await rename(temporary, filename)
      return
    } catch (error) {
      failure = error
    }
  }
  try {
    await unlink(temporary)
  } catch (error) {
    failure = new AggregateError([failure, error], '保存和清理设置失败 / Settings save and cleanup failed')
  }
  throw new Error(`无法保存设置 / Cannot save settings: ${filename}`, { cause: failure })
}

export class SettingsRollbackError extends Error {}

export class SettingsStore {
  private current: AppSettings
  private queue: Promise<void> = Promise.resolve()
  private fatalError: SettingsRollbackError | undefined
  isUpdating = false

  constructor(
    private readonly filename: string,
    initial: AppSettings,
    private readonly apply: (settings: AppSettings) => Promise<void>,
    private readonly save = writeSettings
  ) {
    this.current = { ...initial }
  }

  get value(): AppSettings {
    if (this.fatalError) throw this.fatalError
    return { ...this.current }
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
    let patch: Partial<AppSettings>
    try {
      patch = validateSettings(input, true)
    } catch (error) {
      return Promise.reject(error)
    }
    const operation = this.queue.then(async () => {
      if (this.fatalError) throw this.fatalError
      const previous = this.current
      const next = { ...previous, ...patch }
      if ((Object.keys(next) as (keyof AppSettings)[]).every((key) => next[key] === previous[key])) {
        return this.value
      }
      this.isUpdating = true
      try {
        await this.apply(next)
        await this.save(this.filename, next)
        this.current = next
        return this.value
      } catch (error) {
        try {
          await this.apply(previous)
        } catch (rollbackError) {
          this.fatalError = new SettingsRollbackError('设置回滚失败，应用将退出以避免状态不一致 / Settings rollback failed; application must exit', {
            cause: new AggregateError([error, rollbackError], 'Settings transaction and rollback failed')
          })
          throw this.fatalError
        }
        throw error
      } finally {
        this.isUpdating = false
      }
    })
    // The caller receives the rejection; only the queue barrier consumes it so later edits can proceed.
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }
}
