import type { LoginItemState, LoginItemUpdateResult } from '../shared/settings'
import { DiagnosticError, summarizeDiagnostic } from '../shared/diagnostics'

interface NativeLoginItem {
  openAtLogin: boolean
  wasOpenedAtLogin: boolean
  status: string
}
interface LoginItemPlatform {
  platform: string
  packaged: boolean
  headless: boolean
  inApplicationsFolder(): boolean
  read(): NativeLoginItem
  write(enabled: boolean): void
}

/** macOS owns persistence; a second preference file must not override a system-level opt-out. */
export class LoginItems {
  constructor(private readonly native: LoginItemPlatform) {}

  snapshot(): LoginItemState { return this.readState(false) }

  wasOpenedAtLogin(): boolean { return this.readState(true).wasOpenedAtLogin }

  private readState(strict: boolean): LoginItemState {
    const unavailable = (availability: LoginItemState['availability']): LoginItemState => ({
      availability, status: 'unknown', openAtLogin: null, wasOpenedAtLogin: false, details: null
    })
    if (this.native.platform !== 'darwin') return unavailable('unsupported')
    if (this.native.headless || !this.native.packaged) return unavailable('development')
    let availability: LoginItemState['availability'] = 'available'
    try {
      if (!this.native.inApplicationsFolder()) availability = 'not-installed'
      const value = this.native.read()
      if ((value.status !== 'not-registered' && value.status !== 'enabled' && value.status !== 'requires-approval' && value.status !== 'not-found') ||
          typeof value.openAtLogin !== 'boolean' || typeof value.wasOpenedAtLogin !== 'boolean' ||
          (value.status === 'enabled' && !value.openAtLogin) || (value.status === 'not-registered' && value.openAtLogin))
        throw new DiagnosticError('login-item-read', undefined, 'OC_LOGIN_INVALID_STATUS')
      return { availability, status: value.status, openAtLogin: value.openAtLogin,
        wasOpenedAtLogin: value.wasOpenedAtLogin, details: null }
    } catch (error) {
      if (strict) throw new DiagnosticError('login-item-read', error)
      return { ...unavailable(availability), details: summarizeDiagnostic(error, 'login-item-read').details }
    }
  }

  update(enabled: boolean): LoginItemUpdateResult {
    const before = this.snapshot()
    if (before.availability !== 'available' || before.status === 'unknown') {
      return { ok: false, state: before, rollbackFailed: false,
        details: before.details ?? summarizeDiagnostic(new DiagnosticError('login-item-update', undefined, 'OC_LOGIN_UNAVAILABLE'), 'login-item-update').details }
    }
    if ((enabled && ((before.status === 'enabled' && before.openAtLogin) || before.status === 'requires-approval')) ||
        (!enabled && before.status === 'not-registered' && !before.openAtLogin)) return { ok: true, state: before }
    let state = before
    try {
      this.native.write(enabled)
      state = this.readState(true)
      if (state.status === 'unknown' || (enabled
        ? !(state.status === 'enabled' && state.openAtLogin) && state.status !== 'requires-approval'
        : state.status !== 'not-registered' || state.openAtLogin))
        throw new DiagnosticError('login-item-update', undefined, 'OC_LOGIN_NOT_APPLIED')
      return { ok: true, state }
    } catch (error) {
      state = this.snapshot()
      let failure = error, rollbackFailed = false
      if (state.status !== before.status || state.openAtLogin !== before.openAtLogin) {
        try {
          this.native.write(before.status === 'enabled' || before.status === 'requires-approval')
          state = this.readState(true)
          if (state.status !== before.status || state.openAtLogin !== before.openAtLogin)
            throw new DiagnosticError('login-item-rollback', undefined, 'OC_LOGIN_ROLLBACK_FAILED')
        } catch (rollbackError) {
          state = this.snapshot()
          rollbackFailed = true
          failure = new AggregateError([error, new DiagnosticError('login-item-rollback', rollbackError)])
        }
      }
      return { ok: false, state, rollbackFailed, details: summarizeDiagnostic(failure, 'login-item-update').details }
    }
  }
}
