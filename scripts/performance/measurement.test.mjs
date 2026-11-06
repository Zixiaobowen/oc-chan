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
