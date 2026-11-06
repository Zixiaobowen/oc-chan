import { SAMPLING_INTERVALS } from '../../shared/types'
import { HermesHistoryProvider } from '../collectors/hermes-history'
import { ScheduleCollector } from '../collectors/schedules'
import { resourceAbortError, throwIfAborted } from '../resource-budget'
import { ScheduleHistoryReader } from '../schedule-history'
import type { CollectionPluginDefinition } from './contracts'

export interface SchedulesPluginOptions {
  uid?: number
  createCollector?: (signal: AbortSignal) => Pick<ScheduleCollector, 'collect' | 'retry' | 'supports' | 'dispose'>
  createHistory?: () => ScheduleHistoryReader
}

export function createSchedulesPlugin(options: SchedulesPluginOptions = {}): CollectionPluginDefinition<'schedules'> {
  const uid = options.uid ?? process.getuid?.() ?? 0
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('无效用户 ID / Invalid user ID')
  return {
    id: 'schedules',
    section: 'schedules',
    capabilities: ['scheduled-jobs', 'schedule-history'],
    retrySources: [`launchctl:gui/${uid}`, `launchctl:user/${uid}`, 'launchctl:system'],
    intervalMs: SAMPLING_INTERVALS.schedules,
    timeoutMs: 30_000,
    create(context) {
      const history = options.createHistory ? options.createHistory() : new ScheduleHistoryReader({ providers: [new HermesHistoryProvider()] })
      const collector = options.createCollector ? options.createCollector(context.signal) : new ScheduleCollector({ uid, signal: context.signal })
      let stopping: Promise<void> | undefined
      const cancelHistory = (): void => history.cancel()
      if (context.signal.aborted) cancelHistory()
      else context.signal.addEventListener('abort', cancelHistory, { once: true })
      return {
        async collect(signal, sourceId) {
          throwIfAborted(context.signal)
          throwIfAborted(signal)
          if (stopping) throw resourceAbortError()
          if (sourceId !== undefined && !collector.supports(sourceId))
            throw new Error('此来源不支持单独重试 / Source does not support individual retry')
          return sourceId === undefined ? collector.collect(signal) : collector.retry(sourceId, signal)
        },
        history: {
          async read(job, offset) {
            throwIfAborted(context.signal)
            if (stopping) throw resourceAbortError()
            return history.read(job, offset)
          },
          cancel: cancelHistory
        },
        stop() {
          if (stopping) return stopping
          context.signal.removeEventListener('abort', cancelHistory)
          stopping = Promise.allSettled([
            Promise.resolve().then(() => collector.dispose()),
            Promise.resolve().then(() => history.close())
          ]).then(results => {
            const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
            if (failures.length === 1) throw failures[0]
            if (failures.length) throw new AggregateError(failures, '任务采集与历史关闭失败 / Schedule collection and history cleanup failed')
          })
          return stopping
        }
      }
    }
  }
}
