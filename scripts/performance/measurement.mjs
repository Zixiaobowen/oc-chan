import { Distribution } from './core.mjs'

export class Measurement {
  constructor(label) {
    this.label = label
    this.appRss = new Distribution()
    this.appCpu = new Distribution()
    this.devRss = new Distribution()
    this.devCpu = new Distribution()
    this.counters = { resourceSamples: 0, incompleteResourceSamples: 0, lifecycleSamples: 0, missedLifecycles: 0, incompleteLifecycles: 0,
      incompleteApplicationSamples: 0, incompleteDevelopmentSamples: 0,
      incompleteApplicationCpuIntervals: 0, incompleteDevelopmentCpuIntervals: 0 }
    this.previousProcesses = new Map()
    this.lifecycleCpuGap = false
    this.maxFd = 0
    this.maxProcesses = 0
    this.maxAuxiliaryRss = 0
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
      applicationRssMiB: this.appRss.result(), applicationCpuOneCorePercent: this.appCpu.result(),
      developmentRssMiB: this.devRss.result(), developmentCpuOneCorePercent: this.devCpu.result(),
      maxObservedFd: this.maxFd, maxObservedProcesses: this.maxProcesses, maxObservedAuxiliaryRssBytes: this.maxAuxiliaryRss,
      limits: 'RSS is a one-second sample of observed descendants. CPU intervals exclude new, departed or unreadable identities. System enumeration errors and observed-app missing fields are counted separately; neither proves unseen descendants absent.' }
  }
}
