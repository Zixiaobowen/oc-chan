import { Distribution } from './core.mjs'

const stages = ['eventToWatch', 'eventToReadComplete', 'read', 'readOverlap', 'readToPublish', 'publishToIpc', 'ipcToCommit', 'eventToCommit']
const sections = ['agents', 'schedules', 'system', 'events']
export class Measurement {
  constructor(label) {
    this.label = label
    this.pending = new Map()
    this.durations = Object.fromEntries(stages.map(name => [name, new Distribution()]))
    this.collections = Object.fromEntries(sections.map(name => [name, new Distribution()]))
    this.interactions = new Distribution()
    this.roundTrips = new Distribution()
    this.appRss = new Distribution()
    this.appCpu = new Distribution()
    this.devRss = new Distribution()
    this.devCpu = new Distribution()
    this.counters = { expected: 0, read: 0, published: 0, received: 0, committed: 0, zeroByteReads: 0, bytesRead: 0, readIssues: 0,
      overlappingReads: 0, earlierWatchReads: 0,
      resourceSamples: 0, incompleteResourceSamples: 0, lifecycleSamples: 0, missedLifecycles: 0, incompleteLifecycles: 0,
      incompleteApplicationSamples: 0, incompleteDevelopmentSamples: 0,
      incompleteApplicationCpuIntervals: 0, incompleteDevelopmentCpuIntervals: 0 }
    this.traffic = Object.fromEntries(sections.map(section => [section, {
      publications: 0, ...Object.fromEntries(['main', 'tray', 'unloaded'].map(view => [view, { messages: 0, serializedBytes: 0 }]))
    }]))
    this.previousProcesses = new Map()
    this.lifecycleCpuGap = false
    this.maxFd = 0
    this.maxProcesses = 0
    this.maxAuxiliaryRss = 0
  }
  expect(count, sequence, at) {
    this.expire(at)
    if (this.pending.size + count > 32768) throw new Error('Event correlation budget exceeded')
    for (let index = 0; index < count; index++) this.pending.set(`${index}:${sequence}`, { at })
    this.counters.expected += count
  }
  expire(at) { for (const [key, event] of this.pending) if (at - event.at > 15000) this.pending.delete(key) }
  metric(row) {
    const [kind, at] = row
    if (kind === 'publish-batch' || kind === 'ipc-payload') {
      const section = row[2]
      if (!Object.hasOwn(this.traffic, section)) throw new Error('Invalid traffic section')
      const traffic = this.traffic[section]
      if (kind === 'publish-batch') traffic.publications++
      else {
        const view = row[3], bytes = row[4]
        if (!['main', 'tray', 'unloaded'].includes(view) || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid IPC payload metric')
        traffic[view].messages++
        traffic[view].serializedBytes += bytes
      }
      return
    }
    if (kind === 'sample') this.collections[row[2]].add(at - row[3])
    if (kind === 'input' && typeof row[3] === 'number' && row[2] === 'main') this.interactions.add(at - row[3])
    if (kind === 'r') {
      this.counters.bytesRead += row[5]
      this.counters.zeroByteReads += Number(row[5] === 0)
      this.counters.readIssues += row[7]
      const event = this.pending.get(`${row[2]}:${row[3]}`)
      if (!event || event.readEnd !== undefined) return
      event.readEnd = at
      this.counters.read++
      this.durations.eventToReadComplete.add(at - event.at)
      this.durations.read.add(at - row[4])
      if (row[4] < event.at) {
        this.counters.overlappingReads++
        this.durations.readOverlap.add(event.at - row[4])
      }
      if (row[6] !== null) {
        if (row[6] >= event.at) this.durations.eventToWatch.add(row[6] - event.at)
        else this.counters.earlierWatchReads++
      }
    }
    if (!['p', 'i', 'c'].includes(kind) || (kind !== 'p' && row[2] !== 'main')) return
    const keys = kind === 'p' ? row[2] : row[3]
    for (const [index, sequence] of keys) {
      const event = this.pending.get(`${index}:${sequence}`)
      if (!event) continue
      if (kind === 'p' && event.publish === undefined) {
        event.publish = at
        this.counters.published++
        if (event.readEnd !== undefined) this.durations.readToPublish.add(at - event.readEnd)
      } else if (kind === 'i' && event.ipc === undefined) {
        event.ipc = at
        this.counters.received++
        if (event.publish !== undefined) this.durations.publishToIpc.add(Math.max(0, at - event.publish))
      } else if (kind === 'c' && event.commit === undefined) {
        event.commit = at
        this.counters.committed++
        if (event.ipc !== undefined) this.durations.ipcToCommit.add(Math.max(0, at - event.ipc))
        this.durations.eventToCommit.add(at - event.at)
      }
    }
  }
  resources(record) {
    if (record.type === 'lifecycle') {
      this.lifecycleCpuGap = true
      this.counters.lifecycleSamples += record.samples
      this.counters.missedLifecycles += Number(record.missed)
      this.counters.incompleteLifecycles += Number(record.incomplete === true)
      this.maxAuxiliaryRss = Math.max(this.maxAuxiliaryRss, record.maxRssBytes ?? 0)
      return
    }
    if (record.type !== 'resources') return
    this.counters.resourceSamples++
    this.counters.incompleteResourceSamples += Number(!record.coverage.complete)
    const next = new Map()
    for (const [group, list] of [['app', record.app], ['dev', record.development]]) {
      let rss = 0, cpu = 0, fds = 0, completeRss = true, completeCpu = !this.lifecycleCpuGap, completeFields = true
      for (const proc of list) {
        if (proc.rssBytes === null || proc.cpuNs === null || proc.fdCount === null) completeFields = false
        if (proc.rssBytes === null) completeRss = false
        else rss += proc.rssBytes
        if (proc.fdCount !== null) fds += proc.fdCount
        const key = `${proc.pid}:${proc.startId}`
        const previous = this.previousProcesses.get(key)
        if (previous?.group === group && proc.cpuNs !== null && previous.cpuNs !== null) {
          const elapsed = record.monotonicMs - previous.at
          if (elapsed > 0 && proc.cpuNs >= previous.cpuNs) cpu += (proc.cpuNs - previous.cpuNs) / (elapsed * 1e6) * 100
          else completeCpu = false
        } else completeCpu = false
        next.set(key, { cpuNs: proc.cpuNs, at: record.monotonicMs, group })
      }
      for (const [key, previous] of this.previousProcesses) {
        if (previous.group === group && next.get(key)?.group !== group) completeCpu = false
      }
      if (list.length && !completeFields) this.counters[group === 'app' ? 'incompleteApplicationSamples' : 'incompleteDevelopmentSamples']++
      if (list.length && !completeCpu) this.counters[group === 'app' ? 'incompleteApplicationCpuIntervals' : 'incompleteDevelopmentCpuIntervals']++
      if (list.length && completeRss) this[group === 'app' ? 'appRss' : 'devRss'].add(rss / 1024 ** 2)
      // New or departed process CPU has no complete interval. Never count only the survivors as the whole tree.
      if (list.length && completeCpu) this[group === 'app' ? 'appCpu' : 'devCpu'].add(cpu)
      if (group === 'app') {
        this.maxFd = Math.max(this.maxFd, fds)
        this.maxProcesses = Math.max(this.maxProcesses, list.length)
        if (rss > 2 * 1024 ** 3) throw new Error('Application tree exceeded the 2 GiB measurement safety ceiling')
      }
    }
    this.previousProcesses = next
    this.lifecycleCpuGap = false
  }
  result() {
    return { label: this.label, counters: { ...this.counters },
      traffic: structuredClone(this.traffic),
      latencyMs: Object.fromEntries(Object.entries(this.durations).map(([name, data]) => [name, data.result()])),
      collectionMs: Object.fromEntries(Object.entries(this.collections).map(([name, data]) => [name, data.result()])),
      inputToNextCommitMs: this.interactions.result(), applicationRssMiB: this.appRss.result(), applicationCpuOneCorePercent: this.appCpu.result(),
      interactionRoundTripMs: this.roundTrips.result(),
      developmentRssMiB: this.devRss.result(), developmentCpuOneCorePercent: this.devCpu.result(),
      maxObservedFd: this.maxFd, maxObservedProcesses: this.maxProcesses, maxObservedAuxiliaryRssBytes: this.maxAuxiliaryRss,
      limits: 'RSS is a one-second sampled maximum of observed descendants, with 10 ms lifecycle supplements; CPU intervals exclude new, departed or unreadable identities. System enumeration errors and observed-app missing fields are counted separately; neither proves unseen descendants absent. Commit percentiles cover committed events only; compare counters for coalescing or loss.' }
  }
}
