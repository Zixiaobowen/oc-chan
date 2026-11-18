import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Measurement } from './measurement.mjs'

const processSample = (pid, cpuNs, startId = String(pid)) => ({ pid, startId, rssBytes: 1024 * 1024, cpuNs, fdCount: 3 })
const resources = (monotonicMs, app, development = [], complete = true) => ({ type: 'resources', monotonicMs, app, development, coverage: { complete } })

test('tree CPU excludes exited and newly observed identities instead of reporting only surviving processes', () => {
  const measured = new Measurement('turnover')
  measured.resources(resources(1000, [processSample(1, 0), processSample(2, 0)]))
  measured.resources(resources(2000, [processSample(1, 10_000_000)]))
  assert.equal(measured.result().applicationCpuOneCorePercent.count, 0)
  measured.resources(resources(3000, [processSample(1, 20_000_000)]))
  assert.equal(measured.result().applicationCpuOneCorePercent.count, 1)
  assert.equal(measured.result().applicationCpuOneCorePercent.max, 1)
  measured.resources(resources(4000, [processSample(1, 30_000_000), processSample(2, 0, 'reused-pid')]))
  assert.equal(measured.result().applicationCpuOneCorePercent.count, 1)
  measured.resources(resources(5000, [processSample(1, 40_000_000), processSample(2, 10_000_000, 'reused-pid')]))
  assert.equal(measured.result().applicationCpuOneCorePercent.count, 2)
  assert.equal(measured.result().applicationCpuOneCorePercent.max, 2)
  assert.equal(measured.result().counters.incompleteApplicationCpuIntervals, 3)
})

test('a child lifecycle entirely between tree snapshots makes that CPU interval incomplete', () => {
  const measured = new Measurement('short-child')
  measured.resources(resources(1000, [processSample(1, 0)]))
  measured.resources({ type: 'lifecycle', pid: 2, ppid: 1, samples: 1, missed: false, incomplete: true, maxRssBytes: 1000 })
  measured.resources(resources(2000, [processSample(1, 10_000_000)]))
  assert.equal(measured.result().applicationCpuOneCorePercent.count, 0)
  measured.resources(resources(3000, [processSample(1, 20_000_000)]))
  assert.equal(measured.result().applicationCpuOneCorePercent.count, 1)
  assert.equal(measured.result().counters.incompleteLifecycles, 1)
})

test('unreadable unrelated system PIDs do not conceal complete observed app fields; missing app fields remain explicit', () => {
  const measured = new Measurement('scope')
  measured.resources(resources(1000, [processSample(1, 0)], [], false))
  measured.resources(resources(2000, [processSample(1, 10_000_000)], [], false))
  assert.equal(measured.result().counters.incompleteResourceSamples, 2)
  assert.equal(measured.result().counters.incompleteApplicationSamples, 0)
  assert.equal(measured.result().applicationCpuOneCorePercent.count, 1)
  measured.resources(resources(3000, [{ ...processSample(1, null), rssBytes: null, fdCount: null }], [], false))
  assert.equal(measured.result().counters.incompleteApplicationSamples, 1)
  assert.equal(measured.result().applicationRssMiB.count, 2)
  assert.equal(measured.result().applicationCpuOneCorePercent.count, 1)
})

test('app and development process turnover are accounted separately', () => {
  const measured = new Measurement('groups')
  measured.resources(resources(1000, [processSample(1, 0)], [processSample(2, 0), processSample(3, 0)]))
  measured.resources(resources(2000, [processSample(1, 10_000_000)], [processSample(2, 10_000_000)]))
  assert.equal(measured.result().applicationCpuOneCorePercent.count, 1)
  assert.equal(measured.result().developmentCpuOneCorePercent.count, 0)
})

test('renderer correlation preserves every latency stage, main commits and resource samples', () => {
  const measured = new Measurement('renderer')
  measured.expect(2, 1, 100)
  measured.resources(resources(1000, [processSample(1, 0)]))
  measured.metric(['r', 110, 0, 1, 102, 20, 101, 0])
  measured.metric(['r', 112, 1, 1, 98, 0, 99, 1])
  const keys = [[0, 1], [1, 1]]
  measured.metric(['p', 115, keys])
  measured.metric(['i', 117, 'tray', keys])
  measured.metric(['c', 119, 'tray', keys])
  assert.equal(measured.result().counters.committed, 0)
  measured.metric(['i', 120, 'main', keys])
  measured.metric(['c', 125, 'main', keys])
  measured.metric(['c', 130, 'main', keys])
  measured.resources(resources(2000, [processSample(1, 10_000_000)]))
  const result = measured.result()
  for (const name of ['expected', 'read', 'published', 'received', 'committed']) assert.equal(result.counters[name], 2)
  assert.equal(result.counters.bytesRead, 20)
  for (const name of ['zeroByteReads', 'readIssues', 'overlappingReads', 'earlierWatchReads']) assert.equal(result.counters[name], 1)
  const maxima = { eventToWatch: 1, eventToReadComplete: 12, read: 14, readOverlap: 2, readToPublish: 5, publishToIpc: 5, ipcToCommit: 5, eventToCommit: 25 }
  for (const [name, value] of Object.entries(maxima)) assert.equal(result.latencyMs[name].max, value, name)
  assert.equal(result.applicationCpuOneCorePercent.max, 1)
})

test('collections, interaction and traffic survive result snapshots and reject invalid payloads', () => {
  const measured = new Measurement('traffic')
  assert.equal(measured.result().counters.expected, 0)
  for (const section of ['agents', 'schedules', 'system', 'events']) {
    measured.metric(['sample', 110, section, 100])
    measured.metric(['publish-batch', 115, section])
    for (const view of ['main', 'tray', 'unloaded']) measured.metric(['ipc-payload', 116, section, view, 42])
  }
  measured.metric(['input', 125, 'main', 100])
  measured.metric(['input', 150, 'tray', 100])
  measured.roundTrips.add(30)
  const result = measured.result()
  assert.equal(result.inputToNextCommitMs.max, 25)
  assert.equal(result.interactionRoundTripMs.max, 30)
  for (const section of ['agents', 'schedules', 'system', 'events']) {
    assert.equal(result.collectionMs[section].max, 10)
    assert.equal(result.traffic[section].publications, 1)
    for (const view of ['main', 'tray', 'unloaded']) assert.deepEqual(result.traffic[section][view], { messages: 1, serializedBytes: 42 })
  }
  measured.metric(['ipc-payload', 120, 'agents', 'main', 10])
  assert.equal(result.traffic.agents.main.serializedBytes, 42)
  assert.throws(() => measured.metric(['ipc-payload', 120, 'invalid', 'main', 1]), /Invalid traffic section/)
  assert.throws(() => measured.metric(['ipc-payload', 120, 'agents', 'main', -1]), /Invalid IPC payload/)
})

test('expired and uncommitted correlations remain visible through expected counts', () => {
  const measured = new Measurement('expiration')
  measured.expect(1, 1, 0)
  measured.expect(1, 2, 15001)
  measured.metric(['c', 15002, 'main', [[0, 1]]])
  assert.equal(measured.result().counters.expected, 2)
  assert.equal(measured.result().counters.committed, 0)
  assert.equal(measured.result().latencyMs.eventToCommit.count, 0)
  assert.throws(() => measured.expect(32768, 3, 15002), /correlation budget/)
})
