import type { MonitorSection } from '../../shared/types'
import { throwIfAborted } from '../resource-budget'
import type { CollectionPluginDefinition } from './contracts'

/** Imports may finish after cancellation; never construct an instance in that generation. */
export function lazyCollectionPlugin<K extends MonitorSection>(
  metadata: Omit<CollectionPluginDefinition<K>, 'create'>,
  load: () => Promise<CollectionPluginDefinition<K>>
): CollectionPluginDefinition<K> {
  return { ...metadata, async create(context) {
    throwIfAborted(context.signal)
    const definition = await load()
    throwIfAborted(context.signal)
    if (definition.id !== metadata.id || definition.section !== metadata.section) {
      throw new Error(`Plugin ${metadata.id}: loaded definition identity does not match its registration`)
    }
    return definition.create(context)
  } }
}
