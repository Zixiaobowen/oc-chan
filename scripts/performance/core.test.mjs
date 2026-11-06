import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EvidenceLog, Distribution, until } from './core.mjs'
import { Measurement } from './measurement.mjs'
import { gunzipSync } from 'node:zlib'

test('gzip evidence round trips ordered JSONL across chunks and accounts actual disk bytes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'occhan-gzip-test-'))
  t.after(() => rm(root, { recursive: true }))
  const log = new EvidenceLog(path.join(root, 'evidence'), { gzip: true, chunkBytes: 256 })
  await log.initialize()
  const expected = Array.from({ length: 100 }, (_, sequence) => ({ sequence, message: 'bounded evidence' }))
  for (const row of expected) await log.append(row)
  await log.close()
  let disk = 0, raw = 0
  const rows = []
  for (const file of (await readdir(log.directory)).sort()) {
    assert.match(file, /\.jsonl\.gz$/)
    const compressed = await readFile(path.join(log.directory, file))
    const text = gunzipSync(compressed).toString()
    disk += compressed.length; raw += Buffer.byteLength(text)
    rows.push(...text.trim().split('\n').map(JSON.parse))
  }
  assert.deepEqual(rows, expected)
  assert.equal(log.bytes, disk)
  assert.equal(log.rawBytes, raw)
  assert.equal(log.queued, 0)
})

test('gzip rejects compressed disk overflow and a real destination creation failure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'occhan-gzip-failure-'))
  t.after(() => rm(root, { recursive: true }))
  const capped = new EvidenceLog(path.join(root, 'capped'), { gzip: true, maxBytes: 16, chunkBytes: 16 })
  await capped.initialize()
  await capped.append([1])
  await assert.rejects(capped.close(), /budget exceeded/)
  assert.ok(capped.bytes <= 16)
  assert.equal(capped.file, undefined)
  const broken = new EvidenceLog(path.join(root, 'removed'), { gzip: true })
  await broken.initialize()
  await rm(broken.directory, { recursive: true })
  await assert.rejects(broken.append([1]), /ENOENT/)
  await assert.rejects(broken.close(), /ENOENT/)
  assert.equal(broken.queued, 0)
})

test('gzip propagates a real file-descriptor write failure and releases its compressor', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'occhan-gzip-write-failure-'))
  t.after(() => rm(root, { recursive: true }))
  const log = new EvidenceLog(path.join(root, 'evidence'), { gzip: true })
  await log.initialize()
  await log.append({ sequence: 1 })
  await log.file.close()
  await assert.rejects(log.close(), /closed|EBADF/i)
  assert.equal(log.file, undefined)
  assert.equal(log.compressor, undefined)
  assert.equal(log.queued, 0)
})

test('evidence rotates without overwriting and rejects a record before exceeding the total budget', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'occhan-evidence-test-'))
  try {
    const log = new EvidenceLog(path.join(root, 'evidence'), { maxBytes: 60, chunkBytes: 30 })
    await log.initialize()
    await Promise.all([log.append({ sequence: 1 }), log.append({ sequence: 2 }), log.append({ sequence: 3 })])
    await assert.rejects(log.append({ sequence: 4, rejected: true }), /budget exceeded/)
    await assert.rejects(log.close(), /budget exceeded/)
    const rows = []
    let size = 0
    for (const file of (await readdir(log.directory)).sort()) {
      const text = await readFile(path.join(log.directory, file), 'utf8')
      size += Buffer.byteLength(text)
      assert.ok(Buffer.byteLength(text) <= 30)
      rows.push(...text.trim().split('\n').map(JSON.parse))
    }
    assert.deepEqual(rows, [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }])
    assert.ok(size <= 60)
  } finally { await rm(root, { recursive: true }) }
})

test('latency quantiles preserve overflow and reject invalid clocks', () => {
  const values = new Distribution()
  for (let index = 1; index <= 100; index++) values.add(index)
  assert.deepEqual([values.percentile(.5), values.percentile(.95), values.percentile(.99)], [50, 95, 99])
  values.add(60001)
  assert.equal(values.result().overflow, 1)
  assert.equal(values.percentile(1), null)
  assert.throws(() => values.add(-1), /Invalid duration/)
})

test('coalesced events remain in coverage denominator and stages correlate by session plus sequence', () => {
  const measurement = new Measurement('boundary')
  measurement.expect(2, 1, 1000)
  measurement.metric(['r', 1110, 0, 1, 1100, 180, 1002, 0])
  measurement.metric(['p', 1112, [[0, 1]]])
  measurement.metric(['i', 1115, 'main', [[0, 1]]])
  measurement.metric(['c', 1120, 'main', [[0, 1]]])
  measurement.metric(['c', 1130, 'main', [[0, 1]]])
  const result = measurement.result()
  assert.equal(result.counters.expected, 2)
  assert.equal(result.counters.committed, 1)
  assert.equal(result.latencyMs.eventToCommit.p95, 120)
  assert.equal(result.latencyMs.read.p95, 10)
  assert.equal(result.latencyMs.eventToReadComplete.p95, 110)
  measurement.expire(20000)
  assert.equal(measurement.pending.size, 0)
})

test('an in-flight read can include an event written after it started', () => {
  const measurement = new Measurement('overlapping read')
  measurement.expect(1, 1, 1000)
  measurement.metric(['r', 1015, 0, 1, 990, 180, 980, 0])
  measurement.metric(['p', 1016, [[0, 1]]])
  measurement.metric(['i', 1020, 'main', [[0, 1]]])
  measurement.metric(['c', 1030, 'main', [[0, 1]]])
  const result = measurement.result()
  assert.equal(result.counters.committed, 1)
  assert.equal(result.counters.overlappingReads, 1)
  assert.equal(result.counters.earlierWatchReads, 1)
  assert.equal(result.latencyMs.eventToReadComplete.max, 15)
  assert.equal(result.latencyMs.read.max, 25)
  assert.equal(result.latencyMs.readOverlap.max, 10)
  assert.equal(result.latencyMs.eventToWatch.count, 0)
  assert.equal(result.latencyMs.eventToCommit.max, 30)
})

test('a read completing before the event still rejects an invalid clock', () => {
  const measurement = new Measurement('invalid clock')
  measurement.expect(1, 1, 1000)
  assert.throws(() => measurement.metric(['r', 999, 0, 1, 990, 180, 980, 0]), /Invalid duration/)
})

test('cancelled waits stop before evaluating another condition', async () => {
  const controller = new AbortController()
  let calls = 0
  const waiting = until(() => { calls++; controller.abort(new Error('cancelled measurement')); return false }, { signal: controller.signal, interval: 1 })
  await assert.rejects(waiting, /cancelled measurement/)
  assert.equal(calls, 1)
})

test('traffic counts redundant sends separately from event coverage and separates window destinations', () => {
  const measurement = new Measurement('traffic')
  measurement.expect(1, 1, 1000)
  for (const at of [1100, 1120]) {
    measurement.metric(['publish-batch', at, 'agents'])
    measurement.metric(['p', at, [[0, 1]]])
    measurement.metric(['ipc-payload', at + 1, 'agents', 'main', 256])
    measurement.metric(['i', at + 2, 'main', [[0, 1]]])
    measurement.metric(['c', at + 3, 'main', [[0, 1]]])
  }
  measurement.metric(['ipc-payload', 1101, 'agents', 'tray', 256])
  measurement.metric(['ipc-payload', 1102, 'system', 'unloaded', 64])
  const result = measurement.result()
  assert.deepEqual(result.traffic.agents, { publications: 2, main: { messages: 2, serializedBytes: 512 }, tray: { messages: 1, serializedBytes: 256 }, unloaded: { messages: 0, serializedBytes: 0 } })
  assert.equal(result.counters.published, 1)
  assert.equal(result.counters.received, 1)
  assert.equal(result.counters.committed, 1)
  assert.deepEqual(result.traffic.system.unloaded, { messages: 1, serializedBytes: 64 })
  assert.throws(() => measurement.metric(['ipc-payload', 1200, 'agents', 'main', -1]), /Invalid IPC payload/)
  assert.throws(() => measurement.metric(['publish-batch', 1200, '__proto__']), /Invalid traffic section/)
  assert.throws(() => measurement.metric(['ipc-payload', 1200, 'agents', 'other', 64]), /Invalid IPC payload/)
})
