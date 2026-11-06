import { useEffect, useRef, useState } from 'react'
import { summarizeDiagnostic } from '../../shared/diagnostics'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import { SettingsDiagnosticDetails } from './SettingsSaveError'

type Failure = { details: string; rollbackFailed: boolean; intent?: boolean }

export default function LoginItemSetting() {
  const { t } = useI18n()
  const { snapshot: { loginItem }, saving } = useSettings()
  const [state, setState] = useState(loginItem)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const alive = useRef(false)
  const pending = useRef(false)
  const refreshButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { setState(loginItem) }, [loginItem])
  useEffect(() => {
    alive.current = true
    const refresh = () => { if (!document.hidden) void request(undefined, false) }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    refresh()
    return () => {
      alive.current = false
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  async function request(enabled?: boolean, manual = true) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      if (!window.desktopSettings) throw new Error('Desktop settings are unavailable')
      if (enabled === undefined) {
        const snapshot = await window.desktopSettings.snapshot()
        if (!alive.current) return
        setState(snapshot.loginItem)
        if (manual) setFailure(null)
      } else {
        const result = await window.desktopSettings.updateLoginItem(enabled)
        if (!alive.current) return
        setState(result.state)
        setFailure(result.ok ? null : { details: result.details, rollbackFailed: result.rollbackFailed, intent: enabled })
      }
    } catch (error) {
      if (!alive.current) return
      const details = summarizeDiagnostic(error, 'settings-connection').details
      setState(value => ({ ...value, status: 'unknown', openAtLogin: null, details }))
      setFailure({ details, rollbackFailed: false, intent: enabled })
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }

  const available = state.availability === 'available'
  const checked = available && state.status === 'enabled' && state.openAtLogin === true
  const approval = available && state.status === 'requires-approval'
  const blocked = !available || state.status === 'unknown' || approval
  const status = !available ? t('不可用', 'Unavailable')
    : approval ? t('等待系统批准', 'Waiting for system approval')
    : checked ? t('已开启', 'On')
    : state.status === 'not-registered' && state.openAtLogin === false ? t('已关闭', 'Off')
    : state.status === 'not-found' ? t('系统未找到应用', 'App not found by the system')
    : t('状态未确认', 'State unconfirmed')
  const help = state.availability === 'development'
    ? t('开发实例不能修改系统登录项。请在已安装的 OC Chan 中设置。', 'Development instances cannot change login items. Use the installed OC Chan app.')
    : state.availability === 'not-installed'
    ? t('请从“应用程序”文件夹运行 OC Chan，再设置登录启动。', 'Run OC Chan from the Applications folder to configure login startup.')
    : state.availability === 'unsupported'
    ? t('此设置仅适用于 macOS。', 'This setting is available on macOS only.')
    : approval
    ? t('请在系统设置 → 通用 → 登录项与扩展中允许 OC Chan，然后重新检查。批准前不会显示为已开启。', 'Allow OC Chan in System Settings → General → Login Items & Extensions, then check again. Startup is not enabled until approved.')
    : t('登录后仅在菜单栏运行，不弹出主窗口，也不自动开启防休眠。系统设置中的更改会在回到此页时重新读取。', 'At login, run in the menu bar without opening the main window or preventing sleep. System changes are read when you return to this page.')
  const details = failure?.details ?? state.details
  return <section className="setting-row" aria-labelledby="setting-login-item-label" aria-busy={busy}>
    <h2 id="setting-login-item-label">{t('登录后启动', 'Open at login')}</h2>
    <div className="setting-control">
      <div className="setting-toggle">
        <button type="button" role="switch" className="setting-switch" aria-labelledby="setting-login-item-label" aria-describedby="login-item-help login-item-status"
          aria-checked={checked} disabled={!available} aria-disabled={blocked || busy || saving}
          onClick={() => { if (!blocked && !busy && !saving) void request(!checked) }}><span /></button>
        <span id="login-item-status" role="status">{busy ? t('正在核对…', 'Checking…') : status}</span>
      </div>
      <p className="setting-help" id="login-item-help">{help}</p>
      {available && <div className="login-item-actions">
        <button ref={refreshButton} type="button" className="button secondary" aria-disabled={busy || saving}
          onClick={() => { if (!busy && !saving) void request(failure?.intent) }}>{failure ? t('重试操作', 'Retry operation') : t('重新检查', 'Check again')}</button>
        {approval && <button type="button" className="button secondary" aria-disabled={busy || saving} onClick={() => {
          if (!busy && !saving) { refreshButton.current?.focus({ preventScroll: true }); void request(false) }
        }}>{t('取消登录项请求', 'Cancel login request')}</button>}
      </div>}
    </div>
    {details && <div className="settings-save-error">
      <p role="alert">{failure?.rollbackFailed
        ? t('修改失败，原登录项状态未能还原。请在系统设置中核查，再重新检查。', 'The change failed and the previous login item state could not be restored. Review System Settings, then check again.')
        : t('未能完成系统登录项操作。请核对当前状态并重试。', 'The login item operation did not complete. Check the current state and retry.')}</p>
      <SettingsDiagnosticDetails details={details} />
    </div>}
  </section>
}
