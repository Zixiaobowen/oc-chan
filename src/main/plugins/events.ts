import { SAMPLING_INTERVALS } from '../../shared/types'
import { EventCollector, type EventInputs } from '../events/collector'
import { EventStore } from '../events/store'
import { HermesEventReader } from '../events/hermes'
import type { CollectionPluginDefinition } from './contracts'
import type { EventNotificationService } from '../events/notification-contracts'

export interface EventsPluginOptions {
  databasePath: () => string
  inputs: () => EventInputs
  hermesDatabasePath?: string
  clock?: () => string
  notifications?: EventNotificationService
}

export function createEventsPlugin(options: EventsPluginOptions): CollectionPluginDefinition<'events'> {
  return {
    id: 'events', section: 'events', capabilities: ['local-events'], intervalMs: SAMPLING_INTERVALS.events, timeoutMs: 15_000,
    create(context) {
      const collector = new EventCollector(new EventStore(options.databasePath()),
        new HermesEventReader(options.hermesDatabasePath), options.inputs, context.signal, options.clock,
        options.notifications ? batch => options.notifications!.committed(batch) : undefined)
      return {
        start: signal => options.notifications?.start(signal),
        collect: signal => collector.collect(signal),
        events: { query: (query, signal) => collector.query(query, signal) },
        stop: async () => {
          const results = await Promise.allSettled([collector.close(), options.notifications?.stop()])
          const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
          if (errors.length) throw new AggregateError(errors, '事件插件释放失败 / Events plugin cleanup failed')
        }
      }
    }
  }
}
