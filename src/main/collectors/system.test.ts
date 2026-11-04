import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMemory, parseProcesses } from './system'

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
