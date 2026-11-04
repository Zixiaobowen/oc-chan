import type { ScheduledJob, ScheduleHistory } from '../shared/types'
import { HermesHistoryProvider, HISTORY_PAGE_SIZE, MAX_HISTORY_OFFSET } from './collectors/hermes-history'

export { HISTORY_PAGE_SIZE, MAX_HISTORY_OFFSET } from './collectors/hermes-history'

/** Providers must settle after cancellation has released their resources and return only public metadata. */
export interface ScheduleHistoryProvider {
  supports(job: ScheduledJob): boolean
  read(job: ScheduledJob, offset: number, signal: AbortSignal): Promise<ScheduleHistory>
}

export interface ScheduleHistoryReaderOptions {
  providers?: readonly ScheduleHistoryProvider[]
  hermesDatabasePath?: string
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
  return error
}

/** One active provider and one replaceable pending request; cancellation never overlaps processes. */
export class ScheduleHistoryReader {
  private readonly providers: readonly ScheduleHistoryProvider[]
  private active?: { request: Request; controller: AbortController }
  private pending?: Request

  constructor(options: ScheduleHistoryReaderOptions = {}) {
    this.providers = options.providers ?? [new HermesHistoryProvider(options.hermesDatabasePath)]
  }

  read(job: ScheduledJob, offset = 0): Promise<ScheduleHistory> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_HISTORY_OFFSET)
      return Promise.reject(new Error('执行历史页码超出范围 / History offset out of range'))
    if (typeof job.id !== 'string' || !job.id || job.id.length > 256)
      return Promise.reject(new Error('任务标识无效 / Invalid job identifier'))
    return new Promise((resolve, reject) => {
      const request = { job, offset, resolve, reject }
      if (!this.active) this.start(request)
      else {
        this.pending?.reject(cancelled())
        this.pending = request
        this.active.request.reject(cancelled())
        this.active.controller.abort()
      }
    })
  }

  cancel(): void {
    this.pending?.reject(cancelled())
    this.pending = undefined
    this.active?.request.reject(cancelled())
    this.active?.controller.abort()
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
      request.reject(controller.signal.aborted ? cancelled() : error instanceof Error ? error
        : new Error('执行历史读取失败 / History read failed'))
    } finally {
      this.active = undefined
      const next = this.pending
      this.pending = undefined
      if (next) this.start(next)
    }
  }
}
