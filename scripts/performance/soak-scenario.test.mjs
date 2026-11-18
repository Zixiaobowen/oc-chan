import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SoakEvidence } from './soak-scenario.mjs'

const live = pid => ({ pid, rssBytes: 256 * 1024 ** 2, cpuNs: 1_000_000, fdCount: 4 })
const unavailable = (pid, error, state) => ({ pid, rssBytes: null, cpuNs: null, fdCount: null,
  sampleErrors: { taskInfo: error, descriptors: 0, identity: 0 }, ...(state ? { sampleState: state } : {}) })
const snapshot = (monotonicMs, app) => ({ type: 'resources', atMs: Date.now(), monotonicMs, app,
  coverage: { permissionDenied: 0, observedApp: { complete: app.every(proc => proc.rssBytes !== null) } } })

test('confirmed exit retains null RSS and excludes the incomplete snapshot from the trend', () => {
  const evidence = new SoakEvidence({ pid: 1 }, true)
  evidence.hour = 2
  evidence.stage = 'stable-L1'
  evidence.resources(snapshot(1000, [live(1), unavailable(2, 3, 'exited')]))
  assert.equal(evidence.coverage.exitedDuringSampling, 1)
  assert.equal(evidence.coverage.applicationUnavailable, 0)
  assert.equal(evidence.latest.rssBytes, null)
  assert.equal(evidence.latest.observedRssBytes, 256 * 1024 ** 2)
  assert.equal(evidence.firstStableRss.count, 0)
  evidence.resources(snapshot(2000, [live(1)]))
  assert.equal(evidence.firstStableRss.count, 1)
  assert.equal(evidence.firstStableRss.percentile(.5), 256)
})

test('a live application field failure still aborts even alongside a confirmed exited child', () => {
  const evidence = new SoakEvidence({ pid: 1 }, false)
  assert.throws(() => evidence.resources(snapshot(1000,
    [live(1), unavailable(2, 13), unavailable(3, 3, 'exited')])), /sample unavailable/)
  assert.equal(evidence.coverage.applicationUnavailable, 1)
  assert.equal(evidence.coverage.exitedDuringSampling, 1)
  assert.equal(evidence.latest, null)
})

test('a missing or exited main process cannot be accepted as an empty application', () => {
  for (const app of [[], [live(2)], [unavailable(1, 3, 'exited'), live(2)]]) {
    const evidence = new SoakEvidence({ pid: 1 }, false)
    assert.throws(() => evidence.resources(snapshot(1000, app)), /sample unavailable/)
    assert.equal(evidence.coverage.applicationUnavailable, 1)
  }
})
