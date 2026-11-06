import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMemory, parseProcesses, SystemCollector, type CpuTimes, type SystemMemory } from './system'
import { NetworkReader } from './network'

const vm = (pageSize: number) => `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)\nAnonymous pages: 100.\nPages purgeable: 20.\nPages wired down: 40.\nPages occupied by compressor: 30.\n`

test('Apple Silicon 的 16KB 页正确换算，扣除 purgeable 并计入 wired/compressed', () => {
  const memory = parseMemory(vm(16384), 'total = 1024.00M  used = 8.50M  free = 1015.50M', 1024 ** 3)
  assert.equal(memory.active, 150 * 16384)
  assert.equal(memory.app, 80 * 16384)
  assert.equal(memory.wired, 40 * 16384)
  assert.equal(memory.compressed, 30 * 16384)
  assert.equal(memory.app + memory.wired + memory.compressed, memory.active)
  assert.equal(memory.available, 1024 ** 3 - 150 * 16384)
  assert.equal(memory.swapused, 8.5 * 1024 ** 2)
})

test('缺失计数器不能伪装为零使用量', () => {
  assert.throws(() => parseMemory(vm(4096).replace('Anonymous pages: 100.\n', ''), 'used = 0M', 1024 ** 3), /Anonymous pages/)
  assert.throws(() => parseMemory(vm(4096), '', 1024 ** 3), /交换空间/)
  assert.throws(() => parseMemory(vm(4096), 'used = 0M', 1), /超出物理内存/)
})

test('内存分项拒绝负 app、无效页大小和不安全计数', () => {
  assert.throws(() => parseMemory(vm(4096).replace('Pages purgeable: 20.', 'Pages purgeable: 101.'), 'used = 0M', 1024 ** 3), /app 内存分项/)
  for (const pageSize of [0, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseMemory(vm(pageSize), 'used = 0M', 1024 ** 3), /页大小/)
  }
  for (const total of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseMemory(vm(4096), 'used = 0M', total), /物理内存总量/)
  }
  assert.throws(() => parseMemory(vm(4096).replace('Pages wired down: 40.', 'Pages wired down: 9007199254740992.'), 'used = 0M', 1024 ** 3), /计数无效/)
  assert.throws(() => parseMemory(vm(4096).replace('Pages wired down: 40.', 'Pages wired down: 9007199254740991.'), 'used = 0M', Number.MAX_SAFE_INTEGER), /wired 内存分项/)
  assert.throws(() => parseMemory(vm(4096), 'used = 0M', 149 * 4096), /内存使用量超出/)
  assert.throws(() => parseMemory(vm(4096), 'used = 1..2M', 1024 ** 3), /交换空间使用量无效/)
})

test('内存分项允许零和恰好用满物理内存', () => {
  const zero = vm(4096).replace('100.', '20.').replace('40.', '0.').replace('30.', '0.')
  const empty = parseMemory(zero, 'used = 0M', 4096)
  assert.deepEqual([empty.app, empty.wired, empty.compressed, empty.active, empty.available], [0, 0, 0, 0, 4096])
  const full = parseMemory(vm(4096), 'used = 0M', 150 * 4096)
  assert.equal(full.app + full.wired + full.compressed, full.total)
  assert.equal(full.available, 0)
})

test('RSS 排名覆盖全系统，低 CPU 高内存进程不会被 CPU 前十过滤', () => {
  const rows = Array.from({ length: 12 }, (_, index) => `${index + 1} ${20 - index}.0 ${100 + index} /usr/bin/cpu-${index}`)
  rows.push('99 0.0 900000 /Applications/Memory Worker')
  const rankings = parseProcesses(rows.join('\n'))
  assert.equal(rankings.cpu.length, 10)
  assert.equal(rankings.memory.length, 10)
  assert.deepEqual(rankings.cpu.map(process => process.pid), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual(rankings.memory.map(process => process.pid), [99, 12, 11, 10, 9, 8, 7, 6, 5, 4])
  assert.equal(rankings.memory[0].memoryBytes, 900000 * 1024)
  assert.equal(rankings.memory[0].name, 'Memory Worker')
})

test('两个进程排名在相同指标下保持原始顺序，并限制为十条', () => {
  const rows = Array.from({ length: 25 }, (_, index) => `${25 - index} 1.0 100 /bin/tied`)
  const rankings = parseProcesses(rows.join('\n'))
  const expected = Array.from({ length: 10 }, (_, index) => 25 - index)
  assert.deepEqual(rankings.cpu.map(process => process.pid), expected)
  assert.deepEqual(rankings.memory.map(process => process.pid), expected)
  assert.deepEqual(parseProcesses(''), { cpu: [], memory: [] })
})

function collector(cpu: () => CpuTimes, memory = async () => parseMemory(vm(4096), 'used = 0M', 1024 ** 3)) {
  let networkSample = 0
  return new SystemCollector({
    cpu, memory,
    disk: async () => ({ type: 0, bsize: 4096, frsize: 4096, blocks: 100, bfree: 40, bavail: 30, files: 100, ffree: 50 }),
    processes: async () => parseProcesses(Array.from({ length: 25 }, (_, i) => `${i + 1} ${i} ${100 - i} /bin/process-${i}`).join('\n')),
    network: new NetworkReader(async file => file === '/sbin/route' ? 'interface: en0\n'
      : `Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes\nen0 1500 <Link#1> aa 1 0 ${++networkSample * 100} 1 0 ${networkSample * 50}\n`, () => networkSample * 1000),
  })
}

test('系统采集实例隔离 CPU、网络基线和历史，首次为空，连续采样才产生数值', async () => {
  let cpu = { total: 100, idle: 50 }
  const first = collector(() => cpu), second = collector(() => cpu)
  try {
    const initial = await first.collect()
    assert.equal(initial.cpuPercent, null)
    assert.equal(initial.rxBytesPerSecond, null)
    cpu = { total: 200, idle: 75 }
    const next = await first.collect()
    assert.equal(next.cpuPercent, 75)
    assert.equal(next.rxBytesPerSecond, 100)
    assert.equal(next.txBytesPerSecond, 50)
    assert.deepEqual(next.history.map(sample => sample.cpuPercent), [null, 75])
    const independent = await second.collect()
    assert.equal(independent.cpuPercent, null)
    assert.equal(independent.rxBytesPerSecond, null)
    assert.equal(independent.history.length, 1)
    assert.equal(initial.history.length, 1)
    first.dispose()
    cpu = { total: 300, idle: 125 }
    assert.equal((await second.collect()).cpuPercent, 50)
  } finally { first.dispose(); second.dispose() }
})

test('CPU 计数回退、无效增量与无效计数形成空值并重建连续基线', async () => {
  let cpu = { total: 100, idle: 50 }
  const system = collector(() => cpu)
  try {
    await system.collect()
    for (const counters of [
      { total: 50, idle: 20 },
      { total: 50, idle: 20 },
      { total: 100, idle: 10 },
      { total: 110, idle: 90 },
      { total: NaN, idle: 0 },
      { total: 200, idle: 100 },
    ]) {
      cpu = counters
      assert.equal((await system.collect()).cpuPercent, null)
    }
    cpu = { total: 300, idle: 150 }
    assert.equal((await system.collect()).cpuPercent, 50)
    cpu = { total: 400, idle: 250 }
    assert.equal((await system.collect()).cpuPercent, 0, '有效的完全空闲采样必须保留为零')
  } finally { system.dispose() }
})

test('IO 期间 dispose 取消采集，晚到结果不得写入 CPU 与历史', async () => {
  const pending = Promise.withResolvers<SystemMemory>()
  let cpuReads = 0, observedSignal: AbortSignal | undefined
  const system = collector(() => { cpuReads++; return { total: 100, idle: 50 } })
  system.dispose()
  await assert.rejects(system.collect(), { name: 'AbortError' })
  assert.equal(cpuReads, 0)
  const inFlight = new SystemCollector({
    cpu: () => { cpuReads++; return { total: 100, idle: 50 } },
    memory: signal => { observedSignal = signal; return pending.promise },
    disk: async () => ({ type: 0, bsize: 4096, frsize: 4096, blocks: 100, bfree: 40, bavail: 30, files: 100, ffree: 50 }),
    processes: async () => ({ cpu: [], memory: [] }),
    network: new NetworkReader(async file => file === '/sbin/route' ? 'interface: en0\n' : ''),
  })
  const work = inFlight.collect()
  const rejected = assert.rejects(work, { name: 'AbortError' })
  inFlight.dispose()
  assert.equal(observedSignal?.aborted, true)
  pending.resolve(parseMemory(vm(4096), 'used = 0M', 1024 ** 3))
  await rejected
  assert.equal(cpuReads, 0)
  await assert.rejects(inFlight.collect(), { name: 'AbortError' })
})

test('持续采样仅保留最近六十条历史和 CPU、RSS 各十条排名', async () => {
  let total = 0
  const system = collector(() => ({ total: ++total * 100, idle: total * 50 }))
  try {
    const first = await system.collect()
    for (let index = 1; index <= 65; index++) {
      const snapshot = await system.collect()
      assert.equal(snapshot.history.length, Math.min(index + 1, 60))
      assert.equal(snapshot.processes.length, 10)
      assert.equal(snapshot.memoryProcesses.length, 10)
      assert.equal(snapshot.processes[0].pid, 25)
      assert.equal(snapshot.memoryProcesses[0].pid, 1)
      if (index >= 60) assert.equal(snapshot.history.every(sample => sample.cpuPercent === 50), true)
    }
    assert.equal(first.history.length, 1)
    assert.equal(first.history[0].cpuPercent, null)
  } finally { system.dispose() }
})
