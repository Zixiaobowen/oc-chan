import assert from 'node:assert/strict'
import test from 'node:test'
import { LoginItems } from './login-items'
import { DiagnosticError } from '../shared/diagnostics'

function fixture() {
  let value = { status: 'not-registered', openAtLogin: false, wasOpenedAtLogin: false }
  let writes = 0, reads = 0
  const native = {
    platform: 'darwin', packaged: true, headless: false,
    inApplicationsFolder: () => true,
    read: () => { reads++; return value },
    write: (enabled: boolean) => {
      writes++
      value = { ...value, status: enabled ? 'enabled' : 'not-registered', openAtLogin: enabled }
    }
  }
  return { native, manager: new LoginItems(native),
    get value() { return value }, set value(next: typeof value) { value = next },
    get writes() { return writes }, get reads() { return reads } }
}
const denied = () => Object.assign(new Error('/private/secret-login-item credential=do-not-copy'), { code: 'EACCES' })

test('startup never registers a login item and system changes are authoritative', () => {
  const f = fixture()
  assert.equal(f.manager.wasOpenedAtLogin(), false)
  assert.equal(f.manager.snapshot().status, 'not-registered')
  assert.equal(f.manager.update(false).ok, true)
  assert.equal(f.writes, 0)
  assert.equal(f.manager.update(true).state.openAtLogin, true)
  f.value = { ...f.value, status: 'not-registered', openAtLogin: false }
  assert.equal(f.manager.snapshot().openAtLogin, false)
  assert.equal(f.writes, 1, 'reading a system opt-out must not register it again')
  f.value = { ...f.value, wasOpenedAtLogin: true }
  assert.equal(f.manager.wasOpenedAtLogin(), true)
  assert.equal(f.writes, 1)
})

test('pending approval remains pending and can be cancelled without claiming activation', () => {
  const f = fixture()
  f.native.write = enabled => { f.value = { ...f.value, status: enabled ? 'requires-approval' : 'not-registered', openAtLogin: false } }
  const pending = f.manager.update(true)
  assert.equal(pending.ok, true)
  assert.equal(pending.state.status, 'requires-approval')
  assert.equal(pending.state.openAtLogin, false)
  assert.equal(f.manager.update(false).state.status, 'not-registered')
})

test('development, headless and unsupported platforms never access native login items', () => {
  for (const options of [{ packaged: false }, { headless: true }, { platform: 'linux' }]) {
    const f = fixture()
    Object.assign(f.native, options)
    f.native.inApplicationsFolder = () => { throw new Error('must not inspect an application location') }
    assert.equal(f.manager.wasOpenedAtLogin(), false)
    const result = f.manager.update(true)
    assert.equal(result.ok, false)
    assert.equal(result.state.openAtLogin, null)
    assert.equal(f.reads, 0)
    assert.equal(f.writes, 0)
  }
})

test('a moved application exposes system status but cannot change the installed registration', () => {
  const f = fixture()
  f.native.inApplicationsFolder = () => false
  f.value = { status: 'not-found', openAtLogin: false, wasOpenedAtLogin: false }
  const result = f.manager.update(true)
  assert.equal(result.ok, false)
  assert.equal(result.state.availability, 'not-installed')
  assert.equal(result.state.status, 'not-found')
  assert.equal(f.writes, 0)
})

test('a denied change retains the old state and reports bounded redacted diagnostics', () => {
  const f = fixture()
  f.native.write = () => { throw denied() }
  const result = f.manager.update(true)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.state.status, 'not-registered')
  assert.equal(result.rollbackFailed, false)
  assert.match(result.details, /EACCES/)
  assert.doesNotMatch(result.details, /private|secret-login|credential|do-not-copy/)
})

test('a native partial failure is rolled back before reporting failure', () => {
  const f = fixture(), write = f.native.write
  f.native.write = enabled => { write(enabled); if (enabled) throw denied() }
  const result = f.manager.update(true)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rollbackFailed, false)
  assert.equal(result.state.openAtLogin, false)
  assert.equal(f.value.status, 'not-registered')
  assert.equal(f.writes, 2)
})

test('a rollback failure reports the actual changed state and both failure stages', () => {
  const f = fixture(), write = f.native.write
  f.native.write = enabled => {
    if (enabled) { write(true); throw denied() }
    throw Object.assign(new Error('private rollback body'), { code: 'EPERM' })
  }
  const result = f.manager.update(true)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rollbackFailed, true)
  assert.equal(result.state.status, 'enabled')
  assert.equal(result.state.openAtLogin, true)
  assert.match(result.details, /EACCES/)
  assert.match(result.details, /EPERM/)
  assert.match(result.details, /Restore system login item/)
  assert.doesNotMatch(result.details, /private|credential/)
})

test('a silently ignored native write is a failure, not an optimistic enabled state', () => {
  const f = fixture()
  f.native.write = () => {}
  const result = f.manager.update(true)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.state.status, 'not-registered')
  assert.match(result.details, /OC_LOGIN_NOT_APPLIED/)
})

test('unknown or contradictory system state stays unknown and prevents mutation', () => {
  for (const value of [
    { status: 'future-state', openAtLogin: true, wasOpenedAtLogin: false },
    { status: 'enabled', openAtLogin: false, wasOpenedAtLogin: false },
    { status: 'not-registered', openAtLogin: true, wasOpenedAtLogin: false }
  ]) {
    const f = fixture()
    f.value = value
    const result = f.manager.update(true)
    assert.equal(result.ok, false)
    assert.equal(result.state.status, 'unknown')
    assert.equal(result.state.openAtLogin, null)
    assert.match(result.state.details!, /OC_LOGIN_INVALID_STATUS/)
    assert.equal(f.writes, 0)
  }
})

test('native read failure is visible and cannot fall through to foreground startup', () => {
  const f = fixture()
  f.native.read = () => { throw denied() }
  assert.throws(() => f.manager.wasOpenedAtLogin(), DiagnosticError)
  assert.equal(f.manager.snapshot().openAtLogin, null)
  assert.match(f.manager.snapshot().details!, /EACCES/)
  assert.equal(f.manager.update(true).ok, false)
  assert.equal(f.writes, 0)
})

test('failure to read after a change restores the previous state and retains the read cause', () => {
  const f = fixture(), read = f.native.read, write = f.native.write
  let failRead = false
  f.native.read = () => { if (failRead) { failRead = false; throw denied() } return read() }
  f.native.write = enabled => { write(enabled); if (enabled) failRead = true }
  const result = f.manager.update(true)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.rollbackFailed, false)
  assert.equal(result.state.status, 'not-registered')
  assert.match(result.details, /EACCES/)
})
