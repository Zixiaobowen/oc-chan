import assert from 'node:assert/strict'
import test from 'node:test'
import { NetworkReader, parseDefaultInterface, parseNetworkCounters } from './network'
import { pluginSdk } from '../../../main/marketplace/sdk'

const header = 'Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll Drop'
const table = (iface: string, received: number, sent: number, address = 'aa:bb:cc:dd:ee:ff') => `${header}\n${iface} 1500 <Link#20> ${address} 12 0 ${received} 10 0 ${sent} 0 1\n`

test('counts only the selected link row with and without a link address or Drop column', () => {
  const rows = table('en0', 1200, 300) + 'en0 1500 192.0.2 192.0.2.1 12 - 9999 10 - 9999 - -\n'
  assert.deepEqual(parseNetworkCounters(rows, 'en0'), { received: 1200, sent: 300 })
  assert.deepEqual(parseNetworkCounters(table('utun3', 200, 100, ''), 'utun3'), { received: 200, sent: 100 })
  assert.deepEqual(parseNetworkCounters(`${header.replace(' Drop', '')}\nen0 1500 <Link#20> aa 12 0 900 10 0 100 0\n`, 'en0'), { received: 900, sent: 100 })
})

test('missing, duplicate, unsafe and ambiguous counters fail instead of reporting zero', () => {
  assert.throws(() => parseNetworkCounters(header, 'en0'))
  assert.throws(() => parseNetworkCounters(table('en0', 1, 2) + table('en0', 1, 2).split('\n')[1], 'en0'))
  assert.throws(() => parseNetworkCounters(table('en0', Number.MAX_SAFE_INTEGER + 1, 2), 'en0'))
  assert.throws(() => parseNetworkCounters(table('en0', -1, 2), 'en0'))
  assert.equal(parseDefaultInterface('route to: default\n  interface: en0\n'), 'en0')
  assert.throws(() => parseDefaultInterface('interface: en0\ninterface: en1\n'))
  assert.throws(() => parseDefaultInterface('interface: --invalid\n'))
})

test('rates need continuous counter evidence and recover explicitly after route changes and failures', async () => {
  let at = 0, iface = 'en0', received = 1000, sent = 100, failed = false
  const reader = new NetworkReader(pluginSdk, async file => {
    if (failed) throw new Error('network read failed')
    return file === '/sbin/route' ? `interface: ${iface}\n` : table(iface, received, sent)
  }, () => at)
  assert.equal((await reader.read()).rxBytesPerSecond, null)
  at = 2000; received = 1400; sent = 300
  assert.deepEqual(await reader.read(), { iface: 'en0', rxBytesPerSecond: 200, txBytesPerSecond: 100 })
  at = 3000; received = 10
  assert.equal((await reader.read()).rxBytesPerSecond, null)
  at = 4000; iface = 'en1'; received = 10000
  assert.equal((await reader.read()).rxBytesPerSecond, null)
  failed = true
  await assert.rejects(reader.read())
  failed = false; at = 6000; received = 12000
  assert.equal((await reader.read()).rxBytesPerSecond, null)
  at = 7000; received = 13000
  assert.equal((await reader.read()).rxBytesPerSecond, 1000)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(reader.read(cancelled.signal), { name: 'AbortError' })
  at = 8000; received = 14000
  assert.equal((await reader.read()).rxBytesPerSecond, null)
})

test('network instances do not share baselines and disposal rejects late IO before sampling', async () => {
  let at = 0, received = 100
  const run = async (file: string) => file === '/sbin/route' ? 'interface: en0\n' : table('en0', received, 10)
  const first = new NetworkReader(pluginSdk, run, () => at), second = new NetworkReader(pluginSdk, run, () => at)
  assert.equal((await first.read()).rxBytesPerSecond, null)
  at = 1000; received = 300
  assert.equal((await first.read()).rxBytesPerSecond, 200)
  assert.equal((await second.read()).rxBytesPerSecond, null)
  first.dispose()
  at = 2000; received = 600
  assert.equal((await second.read()).rxBytesPerSecond, 300)
  second.dispose()

  const counters = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  let sampleReads = 0, signal: AbortSignal | undefined
  const inFlight = new NetworkReader(pluginSdk, async (file, _args, currentSignal) => {
    signal = currentSignal
    if (file === '/sbin/route') return 'interface: en0\n'
    started.resolve()
    return counters.promise
  }, () => ++sampleReads)
  const reading = inFlight.read()
  const rejected = assert.rejects(reading, { name: 'AbortError' })
  await started.promise
  inFlight.dispose()
  assert.equal(signal?.aborted, true)
  counters.resolve(table('en0', 100, 50))
  await rejected
  assert.equal(sampleReads, 0)
  await assert.rejects(inFlight.read(), { name: 'AbortError' })
})
