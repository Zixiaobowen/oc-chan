import assert from 'node:assert/strict'
import { Measurement } from './measurement.mjs'
import { now } from './core.mjs'
const roles = ['web','provisionalWeb','gpu','network']
const key = value => `${value.pid}:${value.startSeconds}:${String(value.startMicroseconds).padStart(6,'0')}`

export class AssociatedProcesses {
  constructor(label) {
    this.measurement = new Measurement(`${label}:host-plus-associated`)
    this.latest = null; this.refreshes = 0; this.incompleteRefreshes = 0; this.resourceSamples = 0; this.incompleteSamples = 0
    this.missingRoles = Object.fromEntries(roles.map(role => [role,0]))
  }
  update(observations, at = now()) {
    assert(observations.length >= 1 && observations.length <= 2)
    const identities = new Map(), failures = [], views = []
    for (const { view, processes } of observations) {
      assert(['main','tray'].includes(view))
      if (!processes) { failures.push({view,role:'all',reason:'driver did not provide process association evidence'}); continue }
      assert.equal(processes.scope,'instance-associated processes; may be shared')
      assert(Array.isArray(processes.entries) && Array.isArray(processes.unavailable) && Array.isArray(processes.notRunning))
      const seen = new Set()
      for (const entry of processes.entries) {
        assert(roles.includes(entry.role) && !seen.has(entry.role)); seen.add(entry.role)
        assert(Number.isSafeInteger(entry.pid) && entry.pid>0 && Number.isSafeInteger(entry.startSeconds) && entry.startSeconds>0 && Number.isSafeInteger(entry.startMicroseconds) && entry.startMicroseconds>=0 && entry.startMicroseconds<1000000)
        const id = key(entry)
        if (!identities.has(id)) identities.set(id,{...entry,views:[view],roles:[entry.role]})
        else { const present=identities.get(id); if(!present.views.includes(view))present.views.push(view);if(!present.roles.includes(entry.role))present.roles.push(entry.role) }
      }
      for (const entry of processes.unavailable) {
        assert(roles.includes(entry.role) && !seen.has(entry.role) && typeof entry.reason==='string' && entry.reason.length<=1024)
        seen.add(entry.role); this.missingRoles[entry.role]++; failures.push({view,...entry})
      }
      for (const role of processes.notRunning) { assert(roles.includes(role) && !seen.has(role)); seen.add(role) }
      assert.equal(seen.size,4,'Driver omitted a WebKit process role')
      views.push({view,notRunning:processes.notRunning})
    }
    assert(identities.size<=8)
    const pids=new Set()
    for(const entry of identities.values()) { assert(!pids.has(entry.pid),'PID birth changed between window association reads');pids.add(entry.pid) }
    this.refreshes++;if(failures.length)this.incompleteRefreshes++
    this.latest={at,identities:[...identities.values()],failures,views,complete:failures.length===0}
    return this.latest
  }
  resources(row) {
    if(row.type==='lifecycle'){this.measurement.resources(row);return}
    if(row.type!=='resources')return
    this.resourceSamples++
    assert(Array.isArray(row.associated), 'Sampler omitted explicit associated-process observations')
    const expected=this.latest,actual=row.associated
    const actualKeys=new Set(actual.map(value=>`${value.pid}:${value.startId}`))
    const complete=row.app.length>0 && (!this.rootPid || row.app.some(value=>value.pid===this.rootPid)) && expected?.complete && now()-expected.at<=2000 && actual.length===expected.identities.length && expected.identities.every(value=>actualKeys.has(key(value))) &&
      actual.every(value=>value.associationAgeMs<=2000 && value.rssBytes!==null && value.cpuNs!==null && value.fdCount!==null && value.sampleErrors.identity===0)
    if(!complete){this.incompleteSamples++;this.measurement.previousProcesses.clear();this.measurement.lifecycleCpuGap=true;return}
    const union=new Map(row.app.map(value=>[`${value.pid}:${value.startId}`,value]))
    for(const value of actual)if(!union.has(`${value.pid}:${value.startId}`))union.set(`${value.pid}:${value.startId}`,value)
    this.measurement.resources({...row,app:[...union.values()],development:[]})
  }
  result() {
    return { scope:'deduplicated host descendants plus instance-associated WebKit processes; processes may be shared with other instances; not exclusive application cost',
      associationRefreshMs:500,evidenceLeaseMs:2000,refreshes:this.refreshes,incompleteRefreshes:this.incompleteRefreshes,resourceSamples:this.resourceSamples,
      incompleteSamples:this.incompleteSamples,missingRoles:this.missingRoles,latest:this.latest,measurement:this.measurement.result(),
      fullCoverageEstablished:false,remainingGaps:'between-observation process changes, startup before driver connection, unobserved short-lived processes, and any explicit unavailable/permission rows' }
  }
}
