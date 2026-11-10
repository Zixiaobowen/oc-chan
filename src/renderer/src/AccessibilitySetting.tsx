import { useEffect, useRef, useState } from 'react'
import type { AccessibilityState } from '../../shared/settings'
import { summarizeDiagnostic } from '../../shared/diagnostics'
import { useI18n } from './i18n'
import { SettingsDiagnosticDetails } from './SettingsSaveError'

export default function AccessibilitySetting() {
  const { t } = useI18n()
  const [state, setState] = useState<AccessibilityState | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ action: 'check' | 'open'; details: string } | null>(null)
  const alive = useRef(false)
  const pending = useRef(false)
  useEffect(() => {
    alive.current = true
    const refresh = () => { if (!document.hidden) void request('check') }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    refresh()
    return () => {
      alive.current = false
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  async function request(action: 'check' | 'open') {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    let recheck = false
    try {
      if (!window.desktopSettings) throw new Error('Desktop settings are unavailable')
      if (action === 'open') {
        await window.desktopSettings.openPermissionSettings('accessibility')
        recheck = true
        if (alive.current) setFailure(null)
      } else {
        const next = await window.desktopSettings.accessibilityState()
        if (!alive.current) return
        setState(next)
        if (next.details) setFailure({ action, details: next.details })
        else setFailure(previous => previous?.action === 'open' ? previous : null)
      }
    } catch (error) {
      if (!alive.current) return
      const details = summarizeDiagnostic(error, 'settings-connection').details
      if (action === 'check') setState(previous => previous ? { ...previous, status: 'unknown', details } : null)
      setFailure({ action, details })
    } finally {
      pending.current = false
      if (alive.current) {
        if (recheck) void request('check')
        else setBusy(false)
      }
    }
  }

  const available = state?.availability === 'available'
  const status = state?.availability === 'headless' ? t('无头模式不可用', 'Unavailable in headless mode')
    : state?.availability === 'unsupported' ? t('当前系统不支持', 'Unsupported on this platform')
    : state?.status === 'authorized' ? t('已授权', 'Allowed')
    : state?.status === 'not-authorized' ? t('尚未授权', 'Not allowed')
    : t('状态未确认', 'State unconfirmed')
  return <section className="setting-row" aria-labelledby="setting-accessibility-label" aria-busy={busy}>
    <h2 id="setting-accessibility-label">{t('辅助功能权限', 'Accessibility permission')}</h2>
    <div className="setting-control">
      <p role="status">{busy ? t('正在处理…', 'Working…') : status}</p>
      <p className="setting-help">{t('用于跳转并聚焦 Tern 窗口。请在系统设置 → 隐私与安全性 → 辅助功能中允许 OC Chan。若更新后仍提示未授权，请在系统设置中重新启用 OC Chan。返回此页会重新读取权限，应用不会自动请求授权。', 'Used to navigate to and focus Tern windows. Allow OC Chan in System Settings → Privacy & Security → Accessibility. If access is still denied after an update, re-enable OC Chan in System Settings. Returning here rechecks permission without requesting access.')}</p>
      {state?.availability === 'headless' && <p className="setting-help">{t('无头模式不查询辅助功能权限，也不能打开系统设置。', 'Headless mode does not query accessibility permission or open System Settings.')}</p>}
      {state?.availability === 'unsupported' && <p className="setting-help">{t('此权限入口仅适用于 macOS。', 'This permission entry is available on macOS only.')}</p>}
      <div className="login-item-actions">
        <button type="button" className="button secondary" disabled={!available} aria-disabled={busy || !available} onClick={() => { if (available && !busy) void request('open') }}>{t('打开系统辅助功能设置', 'Open Accessibility settings')}</button>
        <button type="button" className="button secondary" aria-disabled={busy} onClick={() => { if (!busy) void request('check') }}>{t('重新检查', 'Check again')}</button>
      </div>
      {failure && <div className="settings-save-error"><p role="alert">{failure.action === 'open'
        ? t('未能打开系统设置。请重试，或手动打开上方路径。', 'Could not open System Settings. Retry or open the path above manually.')
        : t('未能读取辅助功能权限。请重新检查。', 'Could not read accessibility permission. Check again.')}</p><SettingsDiagnosticDetails details={failure.details} /></div>}
    </div>
  </section>
}
