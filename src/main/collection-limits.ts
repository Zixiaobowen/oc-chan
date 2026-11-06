import { opendir } from 'node:fs/promises'
import { collectionResources, ResourceCleanupError, throwIfAborted } from './resource-budget'

export const COLLECTION_LIMITS = Object.freeze({
  directoryEntries: 4096, jobs: 4096, jobBytes: 8 * 1024 * 1024, plistCacheEntries: 4096, plistCacheBytes: 8 * 1024 * 1024,
  plistBytes: 1024 * 1024, projectionBytes: 64 * 1024, fieldBytes: 4096, calendarEntries: 64, sources: 64
})

export class CollectionLimitError extends Error {
  readonly code = 'OC_COLLECTION_LIMIT'
  constructor(readonly scope: string, readonly limit: number, readonly observed: number) {
    super(`采集范围超过上限 / Collection limit exceeded (${scope}: ${observed} > ${limit}); 本轮未完成 / this read is incomplete`)
    this.name = 'CollectionLimitError'
  }
}

/** One counter spans every directory in one collector pass, including ignored entries. */
export class DirectoryScan {
  scanned = 0
  constructor(readonly limit = COLLECTION_LIMITS.directoryEntries) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > COLLECTION_LIMITS.directoryEntries) throw new Error('Invalid directory entry limit')
  }
  read(directory: string, source: string, signal?: AbortSignal, accept: (name: string) => boolean = () => true): Promise<string[]> {
    return collectionResources.run({ source, kind: 'file', bytes: 0, signal }, async () => {
      throwIfAborted(signal)
      const handle = await opendir(directory, { bufferSize: 16 })
      let failure: unknown
      try {
        const names: string[] = []
        for (;;) {
          throwIfAborted(signal)
          const entry = await handle.read()
          if (!entry) return names
          if (++this.scanned > this.limit) throw new CollectionLimitError('directory entries', this.limit, this.scanned)
          if (Buffer.byteLength(entry.name) > COLLECTION_LIMITS.fieldBytes) throw new CollectionLimitError('directory name bytes', COLLECTION_LIMITS.fieldBytes, Buffer.byteLength(entry.name))
          if (accept(entry.name)) names.push(entry.name)
        }
      } catch (error) { failure = error; throw error }
      finally {
        try { await handle.close() }
        catch (error) { throw new ResourceCleanupError('file', failure ? new AggregateError([failure, error], 'Directory read and close failed') : error) }
      }
    })
  }
}
