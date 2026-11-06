import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { collectionResources, ResourceCleanupError, throwIfAborted } from '../resource-budget'
import { sameFileIdentity } from '../resource-io'

export const NOTIFICATION_JOURNAL_BYTES = 64 * 1024
export interface NotificationJournal {
  identity: string | null
  cursor: { sequence: number; unconfirmed: boolean }
  summaryCount: number
  cooldowns: { key: string; at: number }[]
  sentAt: number[]
}
export function emptyNotificationJournal(): NotificationJournal {
  return { identity: null, cursor: { sequence: 0, unconfirmed: false }, summaryCount: 0, cooldowns: [], sentAt: [] }
}
function invalid(): never { throw new Error('通知日志无效 / Invalid notification journal') }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
export function parseNotificationJournal(value: unknown): NotificationJournal {
  if (!record(value) || !keys(value, ['identity', 'cursor', 'summaryCount', 'cooldowns', 'sentAt']) ||
      !(value.identity === null || (typeof value.identity === 'string' && value.identity.length > 0 && value.identity.length <= 128)) ||
      !record(value.cursor) || !keys(value.cursor, ['sequence', 'unconfirmed']) || !integer(value.cursor.sequence) || typeof value.cursor.unconfirmed !== 'boolean' ||
      !integer(value.summaryCount) || !Array.isArray(value.cooldowns) || value.cooldowns.length > 64 || !Array.isArray(value.sentAt) || value.sentAt.length > 3) invalid()
  const seen = new Set<string>()
  for (const item of value.cooldowns) {
    if (!record(item) || !keys(item, ['key', 'at']) || typeof item.key !== 'string' || !/^[a-f0-9]{64}$/.test(item.key) || !integer(item.at) || seen.has(item.key)) invalid()
    seen.add(item.key)
  }
  if (!value.sentAt.every(integer)) invalid()
  return value as unknown as NotificationJournal
}
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
async function closed(file: FileHandle, failure?: unknown): Promise<void> {
  try { await file.close() } catch (error) {
    throw new ResourceCleanupError('file', failure ? new AggregateError([failure, error], 'Notification journal operation and close failed') : error)
  }
  if (failure) throw failure
}

function privateDirectory(info: Stats): void {
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
    throw Object.assign(new Error('Notification journal directory is not private and owned'), { code: 'OC_NOTIFICATION_UNSAFE_DIRECTORY' })
}
function privateFile(info: Stats): void {
  if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600)
    throw Object.assign(new Error('Notification journal file is not private, owned and singly linked'), { code: 'OC_NOTIFICATION_UNSAFE_FILE' })
}

export async function readNotificationJournal(filename: string, signal?: AbortSignal): Promise<NotificationJournal> {
  return collectionResources.run({ source: 'notifications', kind: 'file', bytes: NOTIFICATION_JOURNAL_BYTES + 1, signal }, async () => {
    let parent: FileHandle
    try { parent = await open(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) }
    catch (error) { if (missing(error)) return emptyNotificationJournal(); throw error }
    let parentFailure: unknown
    try { privateDirectory(await parent.stat()) } catch (error) { parentFailure = error }
    await closed(parent, parentFailure)
    let file: FileHandle
    try { file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) { if (missing(error)) return emptyNotificationJournal(); throw error }
    let failure: unknown, result: NotificationJournal | undefined
    try {
      throwIfAborted(signal)
      const initial = await file.stat()
      privateFile(initial)
      if (initial.size > NOTIFICATION_JOURNAL_BYTES) invalid()
      const bytes = Buffer.allocUnsafe(initial.size + 1)
      let used = 0
      while (used < bytes.length) {
        throwIfAborted(signal)
        const read = await file.read(bytes, used, Math.min(16 * 1024, bytes.length - used), used)
        if (!read.bytesRead) break
        used += read.bytesRead
      }
      if (used !== initial.size || !sameFileIdentity(initial, await file.stat())) invalid()
      result = parseNotificationJournal(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))))
    } catch (error) { failure = error }
    await closed(file, failure)
    return result!
  })
}

/** The claim is fsynced before delivery. A crash after this point never replays that claim. */
export async function writeNotificationJournal(filename: string, journal: NotificationJournal, signal?: AbortSignal): Promise<void> {
  parseNotificationJournal(journal)
  const text = JSON.stringify(journal)
  if (Buffer.byteLength(text) > NOTIFICATION_JOURNAL_BYTES) invalid()
  await collectionResources.run({ source: 'notifications', kind: 'file', bytes: NOTIFICATION_JOURNAL_BYTES + 1, signal }, async () => {
    const directory = path.dirname(filename)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    let failure: unknown
    try { privateDirectory(await parent.stat()) } catch (error) { failure = error }
    await closed(parent, failure)
    throwIfAborted(signal)
    try { privateFile(await lstat(filename)) } catch (error) { if (!missing(error)) throw error }
    const temporary = `${filename}.${randomUUID()}.tmp`
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    failure = undefined
    try {
      throwIfAborted(signal)
      privateFile(await file.stat())
      await file.writeFile(text, 'utf8')
      await file.sync()
      throwIfAborted(signal)
    } catch (error) { failure = error }
    try { await closed(file, failure) } catch (error) { failure = error }
    if (!failure) {
      try {
        try { privateFile(await lstat(filename)) } catch (error) { if (!missing(error)) throw error }
        privateDirectory(await lstat(directory))
        await rename(temporary, filename)
      } catch (error) { failure = error }
    }
    if (failure) {
      try { await unlink(temporary) } catch (error) { failure = new ResourceCleanupError('file', new AggregateError([failure, error], 'Notification journal cleanup failed')) }
      throw failure
    }
    const durable = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    failure = undefined
    try { privateDirectory(await durable.stat()); await durable.sync() } catch (error) { failure = error }
    await closed(durable, failure)
  })
}
