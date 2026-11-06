import { HISTORY_PAGE_SIZE, MAX_HISTORY_OFFSET, MAX_SCHEDULE_ID_LENGTH, type ScheduledJob, type ScheduleHistory } from '../shared/types'
import { isResourceAbort, isResourceCleanupFailure } from './resource-budget'

/** Providers must settle after cancellation has released their resources and return only public metadata. */
export interface ScheduleHistoryProvider {
  supports(job: ScheduledJob): boolean
  read(job: ScheduledJob, offset: number, signal: AbortSignal): Promise<ScheduleHistory>
}

export interface ScheduleHistoryReaderOptions {
  providers: readonly ScheduleHistoryProvider[]
}

interface Request {
  job: ScheduledJob
  offset: number
  resolve: (history: ScheduleHistory) => void
  reject: (error: Error) => void
}

function cancelled(): Error {
  const error = new Error('执行历史读取已取消 / History read cancelled')
  error.name = 'AbortError'
  return Object.assign(error, { code: 'ABORT_ERR' })
}

/** One active provider and one replaceable pending request; cancellation never overlaps processes. */
export class ScheduleHistoryReader {
  private readonly providers: readonly ScheduleHistoryProvider[]
  private active?: { request: Request; controller: AbortController }
  private pending?: Request
  private closed = false
  private closePromise?: Promise<void>
  private drainFailure?: Error
  private idleWaiter?: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }

  constructor(options: ScheduleHistoryReaderOptions) {
    this.providers = options.providers
  }

  read(job: ScheduledJob, offset = 0): Promise<ScheduleHistory> {
    if (this.closed) return Promise.reject(new Error('执行历史读取器已关闭 / History reader closed'))
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_HISTORY_OFFSET || offset % HISTORY_PAGE_SIZE !== 0)
      return Promise.reject(new Error('执行历史页码超出范围 / History offset out of range'))
    if (typeof job.id !== 'string' || !job.id || job.id.length > MAX_SCHEDULE_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(job.id))
      return Promise.reject(new Error('任务标识无效 / Invalid job identifier'))
    const { promise, resolve, reject } = Promise.withResolvers<ScheduleHistory>()
    const request = { job, offset, resolve, reject }
    if (!this.active) this.start(request)
    else {
      this.pending?.reject(cancelled())
      this.pending = request
      this.active.request.reject(cancelled())
      this.active.controller.abort()
    }
    return promise
  }

  cancel(): void {
    this.pending?.reject(cancelled())
    this.pending = undefined
    this.active?.request.reject(cancelled())
    this.active?.controller.abort()
  }

  idle(): Promise<void> {
    if (!this.active && !this.pending) return this.drainFailure ? Promise.reject(this.drainFailure) : Promise.resolve()
    this.idleWaiter ??= Promise.withResolvers<void>()
    return this.idleWaiter.promise
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.cancel()
    this.closePromise = this.idle()
    return this.closePromise
  }

  diagnostics() {
    const phase = this.active ? this.active.controller.signal.aborted ? 'cancelling' : 'reading'
      : this.drainFailure ? 'failed' : this.closed ? 'closed' : 'idle'
    return { closed: this.closed, active: Boolean(this.active), pending: Boolean(this.pending), phase }
  }

  private start(request: Request): void {
    const controller = new AbortController()
    this.active = { request, controller }
    void this.execute(request, controller)
  }

  private async execute(request: Request, controller: AbortController): Promise<void> {
    try {
      const provider = this.providers.find(candidate => candidate.supports(request.job))
      const history: ScheduleHistory = provider
        ? await provider.read(request.job, request.offset, controller.signal)
        : { jobId: request.job.id, source: 'unavailable', entries: [], offset: request.offset,
            limit: HISTORY_PAGE_SIZE, hasMore: false, collectedAt: new Date().toISOString() }
      if (controller.signal.aborted) request.reject(cancelled())
      else request.resolve(history)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('执行历史读取失败 / History read failed')
      // A caller may already have received AbortError; provider failure during release must still reach shutdown.
      if (isResourceCleanupFailure(error) || controller.signal.aborted && !isResourceAbort(error)) this.drainFailure ??= failure
      request.reject(failure)
    } finally {
      this.active = undefined
      const next = this.pending
      this.pending = undefined
      if (next && !this.closed) this.start(next)
      else {
        next?.reject(cancelled())
        const waiter = this.idleWaiter
        this.idleWaiter = undefined
        if (this.drainFailure) waiter?.reject(this.drainFailure)
        else waiter?.resolve()
      }
    }
  }
}
