import { EventEmitter } from 'node:events'
import { isDeepStrictEqual } from 'node:util'
import { collectSchedules } from './collectors/schedules'
import { collectSystem } from './collectors/system'
import { LiveAgents, type LiveAgentsOptions } from './live-agents'
import { AGENT_DISCOVERY_INTERVAL_MS, SAMPLING_INTERVALS, type MonitorSection, type MonitorSnapshot, type MonitorUpdate } from '../shared/types'

interface MonitorOptions extends LiveAgentsOptions {
  schedules?: typeof collectSchedules
  system?: typeof collectSystem
}

export class Monitor extends EventEmitter {
  state: MonitorSnapshot = {
    agents: { data: null, error: null, refreshing: false },
    schedules: { data: null, error: null, refreshing: false },
    system: { data: null, error: null, refreshing: false }
  }
  private timers: NodeJS.Timeout[] = []
  private pending = new Map<MonitorSection, Promise<void>>()
  private stopped = false
  private readonly agents: LiveAgents
  private readonly schedules: typeof collectSchedules
  private readonly system: typeof collectSystem

  constructor(options: MonitorOptions = {}) {
    super()
    this.schedules = options.schedules ?? collectSchedules
    this.system = options.system ?? collectSystem
    this.agents = new LiveAgents(data => this.update('agents', { ...this.state.agents, data }), options)
  }

  start(): void {
    if (this.stopped || this.timers.length) return
    void this.refresh()
    this.timers.push(setInterval(() => { void this.refresh('agents', false) }, AGENT_DISCOVERY_INTERVAL_MS))
    for (const section of ['system', 'schedules'] as const) {
      this.timers.push(setInterval(() => { void this.refresh(section, false) }, SAMPLING_INTERVALS[section]))
    }
  }

  stop(): void {
    this.stopped = true
    this.timers.forEach(clearInterval)
    this.timers = []
    this.agents.stop()
  }

  async refresh(section?: MonitorSection, manual = true): Promise<void> {
    if (this.stopped) return
    if (!section) {
      await Promise.all((['agents', 'schedules', 'system'] as const).map(key => this.refresh(key, manual)))
      return
    }
    const existing = this.pending.get(section)
    if (existing) return existing
    const work = this.collect(section, manual).finally(() => this.pending.delete(section))
    this.pending.set(section, work)
    return work
  }

  private update<K extends MonitorSection>(section: K, state: MonitorSnapshot[K]): void {
    if (this.stopped) return
    const previous = this.state[section]
    // Keep the freshest initial-snapshot timestamp without emitting a heartbeat
    // for an otherwise unchanged section. Event inactivity is normal.
    const before = previous.data ? { ...previous.data, collectedAt: undefined } : null
    const after = state.data ? { ...state.data, collectedAt: undefined } : null
    this.state = { ...this.state, [section]: state }
    if (previous.error === state.error && previous.refreshing === state.refreshing && isDeepStrictEqual(before, after)) return
    this.emit('change', { section, state } as MonitorUpdate)
  }

  private async collect(section: MonitorSection, manual: boolean): Promise<void> {
    if (manual) this.update(section, { ...this.state[section], refreshing: true })
    try {
      switch (section) {
        case 'agents':
          await this.agents.reconcile()
          this.update('agents', { ...this.state.agents, error: null, refreshing: false })
          break
        case 'schedules':
          this.update('schedules', { data: await this.schedules(), error: null, refreshing: false })
          break
        case 'system':
          this.update('system', { data: await this.system(), error: null, refreshing: false })
          break
      }
    } catch (error) {
      this.update(section, { ...this.state[section], error: error instanceof Error ? error.message : String(error), refreshing: false })
    }
  }
}
