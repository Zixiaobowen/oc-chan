import assert from 'node:assert/strict'
import test from 'node:test'
import { DIAGNOSTIC_MAX_BYTES, DIAGNOSTIC_MAX_DEPTH, DIAGNOSTIC_MAX_ENTRIES, DiagnosticError, summarizeDiagnostic } from './diagnostics'

const privateText = 'PRIVATE_SENTINEL_/Users/test-person/secrets?token=example-value'

test('shareable output omits arbitrary content while retaining errno, stage and timeout metadata', () => {
  for (const code of ['EACCES', 'ENOSPC', 'ETIMEDOUT']) {
    const cause = Object.assign(new Error(privateText), {
      code, errno: -13, syscall: 'open', path: privateText, dest: privateText,
      stderr: privateText, stdout: privateText, cmd: privateText, stack: privateText,
      signal: 'SIGTERM', killed: true
    })
    const result = summarizeDiagnostic(new DiagnosticError('settings-open', cause), 'settings-read', 'settings')
    assert.equal(result.primaryCode, code)
    assert.equal(result.truncated, false)
    assert.ok(!JSON.stringify(result).includes(privateText))
    assert.ok(!result.details.includes('/Users/'))
    assert.ok(result.details.includes('errno=-13'))
    assert.ok(result.details.includes('SIGTERM'))
    assert.ok(result.details.includes('syscall=open'))
    assert.ok(result.details.includes('<appData>/settings.json'))
  }
  const custom = Object.assign(new Error(privateText), { code: privateText, name: privateText, syscall: privateText, signal: privateText, stage: privateText })
  assert.ok(!JSON.stringify(summarizeDiagnostic(custom, 'startup')).includes(privateText))
})

test('cyclic causes, deep aggregates and wide branches end within the stated budgets', () => {
  const cyclic = new Error(privateText)
  cyclic.cause = cyclic
  const cycle = summarizeDiagnostic(cyclic, 'startup')
  assert.ok(cycle.truncated)
  assert.ok(cycle.limits.includes('cycle-or-repeat'))
  let deep: Error = new Error(privateText)
  for (let index = 0; index < 1000; index++) deep = new AggregateError([deep], privateText)
  const depth = summarizeDiagnostic(deep, 'startup')
  assert.ok(depth.limits.includes('depth'))
  assert.ok(depth.entries <= DIAGNOSTIC_MAX_DEPTH)
  const wide = new AggregateError([], privateText)
  const sparse: unknown[] = []
  sparse[0] = Object.assign(new Error(privateText), { code: 'ENOSPC' })
  sparse.length = 1_000_000
  wide.errors = sparse
  const width = summarizeDiagnostic(wide, 'shutdown')
  assert.equal(width.primaryCode, 'ENOSPC')
  assert.ok(width.limits.includes('entries'))
  for (const result of [cycle, depth, width]) {
    assert.ok(Buffer.byteLength(result.details) <= DIAGNOSTIC_MAX_BYTES)
    assert.ok(result.entries <= DIAGNOSTIC_MAX_ENTRIES)
    assert.ok(!result.details.includes(privateText))
  }
})

test('large error fields, throwing accessors and revoked proxies cannot escape the safe formatter', () => {
  const huge = privateText.repeat(20_000)
  const error = Object.assign(new Error(huge), { code: huge, errno: huge, name: huge, cause: huge })
  const large = summarizeDiagnostic(error, 'startup')
  assert.ok(Buffer.byteLength(large.details) <= DIAGNOSTIC_MAX_BYTES)
  assert.ok(!large.details.includes(privateText))
  let invoked = false
  const accessor = Object.defineProperty(new Error(), 'cause', { get() { invoked = true; throw new Error(privateText) } })
  const blocked = summarizeDiagnostic(accessor, 'startup')
  assert.equal(invoked, false)
  assert.ok(blocked.limits.includes('uninspectable'))
  const { proxy, revoke } = Proxy.revocable([], {})
  revoke()
  const aggregate = new AggregateError([], privateText)
  aggregate.errors = proxy
  assert.ok(summarizeDiagnostic(aggregate, 'shutdown').limits.includes('uninspectable'))
  assert.ok(summarizeDiagnostic(proxy, 'startup').limits.includes('uninspectable'))
})

test('secondary cleanup codes do not override an unknown primary operation', () => {
  const cleanup = Object.assign(new Error(privateText), { code: 'EACCES' })
  for (const primary of [new Error(privateText), Object.assign(new Error(privateText), { code: privateText, cause: cleanup })]) {
    const result = summarizeDiagnostic(new AggregateError([primary, cleanup]), 'settings-save')
    assert.equal(result.primaryCode, undefined)
    assert.ok(result.details.includes('EACCES'))
    assert.ok(!result.details.includes(privateText))
  }
})
