import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMemory } from './system'

const vm = (pageSize: number) => `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)\nAnonymous pages: 100.\nPages purgeable: 20.\nPages wired down: 40.\nPages occupied by compressor: 30.\n`

test('Apple Silicon 的 16KB 页正确换算，扣除 purgeable 并计入 wired/compressed', () => {
  const memory = parseMemory(vm(16384), 'total = 1024.00M  used = 8.50M  free = 1015.50M', 1024 ** 3)
  assert.equal(memory.active, 150 * 16384)
  assert.equal(memory.available, 1024 ** 3 - 150 * 16384)
  assert.equal(memory.swapused, 8.5 * 1024 ** 2)
})

test('缺失计数器不能伪装为零使用量', () => {
  assert.throws(() => parseMemory(vm(4096).replace('Anonymous pages: 100.\n', ''), 'used = 0M', 1024 ** 3), /Anonymous pages/)
  assert.throws(() => parseMemory(vm(4096), '', 1024 ** 3), /交换空间/)
  assert.throws(() => parseMemory(vm(4096), 'used = 0M', 1), /超出物理内存/)
})
