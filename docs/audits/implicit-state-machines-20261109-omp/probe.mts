import assert from 'node:assert/strict'
import { CollectionPluginRegistry } from '../../../src/main/plugins/registry.ts'
import { observeSourceEvents } from '../../../src/main/events/collector.ts'
import { PendingNavigation } from '../../../src/shared/navigation.ts'
import { SettingsStore } from '../../../src/main/settings.ts'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings.ts'
const evidence: unknown[] = []
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let release!: () => void
const gate = new Promise<void>(resolve => { release = resolve })
let aborted = false, settled = false
const registry = new CollectionPluginRegistry([{ id: 'audit', section: 'agents', capabilities: [], intervalMs: 1000, timeoutMs: 10,
 create: () => ({ collect: async (signal: AbortSignal) => { signal.addEventListener('abort', () => { aborted = true }, { once: true }); await gate }, stop: async () => {} }) }],
 { onSnapshot: () => {}, onError: () => {} })
const work = registry.collect('audit').then(() => { settled = true }, () => { settled = true })
await delay(40)
assert.equal(aborted, true); assert.equal(settled, false); assert.equal(registry.statuses()[0].phase, 'failed')
evidence.push({ id: 'ISM-004', observed: { aborted, promiseSettledBeforePluginRelease: settled, phase: registry.statuses()[0].phase }, interpretation: '超时发出取消并报告failed，但保留任务所有权至实际settle；这是契约验证，不是生产故障复现' })
release(); await work; await registry.close()
assert.equal(registry.diagnostics().pending, 0)
let cursor: any[] = []
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()
const step = (seconds: number, state: any) => { const result = observeSourceEvents(cursor, [{ id: 'audit', section: 'agents', state, observedAt: at(seconds) }], at(seconds)); cursor = result.sources; return result.events.map(e => e.type) }
assert.deepEqual(step(0, 'error'), []); assert.deepEqual(step(59, 'error'), []); assert.deepEqual(step(60, 'error'), ['source-unavailable']); assert.deepEqual(step(61, 'partial'), []); assert.deepEqual(step(62, 'ok'), ['source-recovered'])
evidence.push({id: 'ISM-020', observed: '0s/59s无事件，60s不可用，partial无恢复，62s ok恢复'})
const navigation = new PendingNavigation()
navigation.put({ kind: 'page', page: 'agents' }); const old = navigation.read()!.sequence
navigation.put({ kind: 'page', page: 'settings' }); navigation.acknowledge(old)
assert.equal(navigation.read()!.target.kind, 'page'); assert.equal((navigation.read()!.target as any).page, 'settings')
navigation.acknowledge(navigation.read()!.sequence); assert.equal(navigation.read(), null)
evidence.push({id:'ISM-029', observed:'旧ack保留新意图；匹配ack清空'})
const applied: number[] = []
const store = new SettingsStore('/not-used/audit-settings.json', DEFAULT_SETTINGS, async s => { applied.push(s.glassIntensity) }, async () => { throw new Error('injected-save-failure') })
await assert.rejects(store.update({ glassIntensity: DEFAULT_SETTINGS.glassIntensity === 0 ? 10 : 0 }), (error: any) => error.stage === 'settings-save' && error.cause?.message === 'injected-save-failure')
await store.idle(); assert.equal(store.value.glassIntensity, DEFAULT_SETTINGS.glassIntensity); assert.equal(store.isUpdating, false); assert.equal(applied.length, 2)
evidence.push({id:'ISM-002', observed:{applied, isUpdating:store.isUpdating, final:store.value.glassIntensity}, interpretation:'依赖注入仅拒绝save；未读写个人设置'})
console.log(JSON.stringify({passed:4,evidence},null,2))
