import { constants, type Stats } from 'node:fs'
import { open } from 'node:fs/promises'
import { execFile, type ExecFileException } from 'node:child_process'
import { collectionResources, ResourceCleanupError, resourceAbortError, throwIfAborted } from './resource-budget'
import { CollectionLimitError } from './collection-limits'

export type FileIdentity = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>
export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

export interface BudgetedCommandOptions {
  timeout: number
  maxBuffer: number
  env?: NodeJS.ProcessEnv
  inputFile?: { path: string; maxBytes: number; identity?: FileIdentity }
}

async function commandInput(input: NonNullable<BudgetedCommandOptions['inputFile']>, signal?: AbortSignal): Promise<Buffer> {
  throwIfAborted(signal)
  const handle = await open(input.path, constants.O_RDONLY | constants.O_NONBLOCK)
  let failure: unknown
  try {
    throwIfAborted(signal)
    const before = await handle.stat()
    if (!before.isFile()) throw Object.assign(new Error('Command input is not a regular file'), { code: 'NOT_REGULAR_FILE' })
    if (before.size > input.maxBytes) throw new CollectionLimitError('command input bytes', input.maxBytes, before.size)
    if (input.identity && !sameFileIdentity(before, input.identity)) throw Object.assign(new Error('Command input changed before reading'), { code: 'OC_COLLECTION_CHANGED' })
    const buffer = Buffer.allocUnsafe(before.size + 1)
    let used = 0
    while (used < buffer.length) {
      throwIfAborted(signal)
      const { bytesRead } = await handle.read(buffer, used, Math.min(64 * 1024, buffer.length - used), used)
      if (!bytesRead) break
      used += bytesRead
    }
    throwIfAborted(signal)
    if (used !== before.size || !sameFileIdentity(before, await handle.stat())) throw Object.assign(new Error('Command input changed while reading'), { code: 'OC_COLLECTION_CHANGED' })
    return buffer.subarray(0, used)
  } catch (error) { failure = error; throw error }
  finally {
    try { await handle.close() }
    catch (error) { throw new ResourceCleanupError('file', failure ? new AggregateError([failure, error], 'Command input read and close failed') : error) }
  }
}

/** Execution time starts after admission. The reservation survives abort until stdio and child close. */
export function runBudgetedCommand(source: string, file: string, args: readonly string[], options: BudgetedCommandOptions,
  signal?: AbortSignal, execute?: (input?: Buffer) => Promise<string>): Promise<{ stdout: string; stderr: string }> {
  const { timeout, maxBuffer, env } = options
  const inputFile = options.inputFile && { ...options.inputFile, identity: options.inputFile.identity && { ...options.inputFile.identity } }
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || (inputFile && (!Number.isSafeInteger(inputFile.maxBytes) || inputFile.maxBytes <= 0))) return Promise.reject(new Error('Invalid collection command limits'))
  return collectionResources.run({ source, kind: 'command', stdoutBytes: maxBuffer, stderrBytes: maxBuffer,
    inputBytes: inputFile ? inputFile.maxBytes + 1 : undefined, signal }, async () => {
    const input = inputFile ? await commandInput(inputFile, signal) : undefined
    throwIfAborted(signal)
    if (execute) {
      const stdout = await execute(input)
      if (Buffer.byteLength(stdout) > maxBuffer) throw Object.assign(new Error('Command output exceeded its byte limit'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
      return { stdout, stderr: '' }
    }
    return new Promise((resolve, reject) => {
      let result: { stdout: string; stderr: string } | undefined
      let failure: ExecFileException | null | undefined
      let inputFailure: NodeJS.ErrnoException | undefined
      let aborted = false
      const child = execFile(file, [...args], { timeout, maxBuffer, env, encoding: 'utf8', killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        failure = error
        // Protocol consumers may classify this bounded field; it is never a display-ready diagnostic.
        if (error) Object.defineProperty(error, 'stderr', { value: stderr })
        result = { stdout, stderr }
      })
      const abort = () => { aborted = true; child.kill('SIGKILL') }
      signal?.addEventListener('abort', abort, { once: true })
      if (input) {
        child.stdin!.once('error', error => { inputFailure = error })
        child.stdin!.end(input)
      }
      child.once('close', () => {
        signal?.removeEventListener('abort', abort)
        const cancelled = aborted || signal?.aborted
        if (failure && !(cancelled && failure.killed && failure.signal === 'SIGKILL')) reject(cancelled ? new ResourceCleanupError('command', failure) : failure)
        else if (inputFailure && (!cancelled || inputFailure.code !== 'EPIPE')) reject(new ResourceCleanupError('command', inputFailure))
        else if (cancelled) reject(resourceAbortError())
        else if (result) resolve(result)
        else reject(new Error('Collection command closed without a result'))
      })
      if (signal?.aborted) abort()
    })
  })
}
