import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { collectionResources, resourceAbortError, throwIfAborted } from '../resource-budget'
import { MARKET_LIMITS, OFFICIAL_BASE } from './validation'

export async function safeDirectory(directory: string, create = false): Promise<string> {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('插件目录不是普通目录 / Invalid plugin directory')
  return realpath(directory)
}
export async function fileExists(file: string): Promise<boolean> {
  try { await lstat(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
export async function readBounded(file: string, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  return collectionResources.run({ source: 'plugin-market', kind: 'file', bytes: maximum + 1, signal }, async () => {
    throwIfAborted(signal)
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let failure: unknown
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1) throw new Error('插件输入必须是普通非链接文件 / Plugin input must be a regular unlinked file')
      if (before.size > maximum) throw new Error('插件文件超过限制 / Plugin file exceeds limit')
      const bytes = Buffer.allocUnsafe(before.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        throwIfAborted(signal)
        const read = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      const after = await handle.stat()
      throwIfAborted(signal)
      if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('读取期间插件文件发生变化 / Plugin file changed while reading')
      return bytes.subarray(0, offset)
    } catch (error) { failure = error; throw error }
    finally { try { await handle.close() } catch (error) { throw new AggregateError(failure ? [failure, error] : [error], '插件文件关闭失败 / Plugin file close failed') } }
  })
}
export async function writeExclusive(file: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
  return collectionResources.run({ source: 'plugin-market', kind: 'file', bytes: bytes.length, signal }, async () => {
    throwIfAborted(signal)
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let failure: unknown
    try { await handle.writeFile(bytes); await handle.sync(); throwIfAborted(signal) }
    catch (error) { failure = error; throw error }
    finally { try { await handle.close() } catch (error) { throw new AggregateError(failure ? [failure, error] : [error], '插件文件关闭失败 / Plugin file close failed') } }
  })
}
export async function installedFiles(directory: string): Promise<string[]> {
  const entries: string[] = []
  const handle = await opendir(directory)
  for await (const entry of handle) {
    if (entries.length >= MARKET_LIMITS.installed * 3) throw new Error('插件安装目录条目超过限制 / Installed directory entry limit exceeded')
    if (!/^[a-z][a-z0-9-]{0,47}\.ocplugin(?:\.(?:pending|rollback))?$/.test(entry.name)) throw new Error(`插件目录存在未知文件 / Unknown installed file: ${entry.name.slice(0, 120)}`)
    entries.push(entry.name)
  }
  return entries.sort()
}
export function officialUrl(value: string): URL {
  const url = new URL(value)
  if (!url.href.startsWith(OFFICIAL_BASE) || url.username || url.password || url.search || url.hash
    || !/^[a-zA-Z0-9._-]+$/.test(url.href.slice(OFFICIAL_BASE.length))) throw new Error('仅允许官方插件来源 / Only the official plugin source is allowed')
  return url
}
export async function download(url: string, maximum: number, fetcher: typeof fetch, signal: AbortSignal, progress?: (bytes: number) => void): Promise<Buffer> {
  officialUrl(url)
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new Error('插件下载超时 / Plugin download timed out')), MARKET_LIMITS.downloadMs)
  const combined = AbortSignal.any([signal, timeout.signal])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let failure: unknown
  let cancellation: Promise<void> | undefined, cancellationFailure: unknown
  const cancelReader = () => {
    if (reader && !cancellation) cancellation = reader.cancel().catch(error => {
      if (!(combined.aborted && error instanceof Error && error.name === 'AbortError')) cancellationFailure = error
    })
  }
  try {
    const response = await fetcher(url, { signal: combined, redirect: 'error' })
    reader = response.body?.getReader()
    combined.addEventListener('abort', cancelReader, { once: true })
    if (!response.ok) throw new Error(`官方插件源请求失败 / Official source request failed: HTTP ${response.status}`)
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new Error('插件下载超过限制 / Download exceeds limit')
    if (!reader) throw new Error('插件源没有响应内容 / Empty source response')
    const bytes = Buffer.allocUnsafe(maximum)
    let used = 0, published = 0
    while (true) {
      if (combined.aborted) throw timeout.signal.aborted ? timeout.signal.reason : resourceAbortError()
      const chunk = await reader.read()
      if (chunk.done) break
      if (used + chunk.value.byteLength > maximum) throw new Error('插件下载超过限制 / Download exceeds limit')
      bytes.set(chunk.value, used)
      used += chunk.value.byteLength
      if (used - published >= 64 * 1024) { published = used; progress?.(used) }
    }
    if (combined.aborted) throw timeout.signal.aborted ? timeout.signal.reason : resourceAbortError()
    if (used !== published) progress?.(used)
    return bytes.subarray(0, used)
  } catch (error) { failure = timeout.signal.aborted ? timeout.signal.reason : error; throw failure }
  finally {
    clearTimeout(timer)
    combined.removeEventListener('abort', cancelReader)
    cancelReader()
    try {
      await cancellation
      if (cancellationFailure) throw new AggregateError(failure ? [failure, cancellationFailure] : [cancellationFailure], '插件下载回收失败 / Download cleanup failed')
    } finally { reader?.releaseLock() }
  }
}
export function childPath(directory: string, name: string): string {
  const file = resolve(directory, name)
  if (dirname(file) !== directory) throw new Error('插件路径越界 / Plugin path escapes directory')
  return file
}
