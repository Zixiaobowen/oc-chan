import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AppSettings, SettingsSnapshot, SettingsUpdateFailure } from '../../shared/settings'
import { THEMES, type ThemeId } from '../../shared/themes'
import { LanguageProvider } from './i18n'

export const UI_FONTS = {
  system: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
  pingfang: '"PingFang SC", sans-serif',
  helvetica: '"Helvetica Neue", "PingFang SC", sans-serif'
} as const
export const CODE_FONTS = {
  system: 'ui-monospace, monospace',
  menlo: 'Menlo, monospace',
  monaco: 'Monaco, monospace'
} as const
const FONT_SCALES = { small: 12 / 13, default: 1, large: 15 / 13 }
type SettingsSaveFailure = {
  failure: SettingsUpdateFailure | { reason: 'connection'; details: string }
  patch: Partial<AppSettings>
}
interface SettingsContextValue {
  snapshot: SettingsSnapshot
  saving: boolean
  error: SettingsSaveFailure | null
  update: (patch: Partial<AppSettings>) => Promise<void>
  retry: () => Promise<void>
  previewTheme: (theme: ThemeId | null) => void
}
const SettingsContext = createContext<SettingsContextValue | null>(null)

export function useSettings() {
  const context = useContext(SettingsContext)
  if (!context) throw new Error('SettingsProvider is required')
  return context
}

export default function SettingsProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<SettingsSaveFailure | null>(null)
  const [saving, setSaving] = useState(false)
  const [themePreview, previewTheme] = useState<ThemeId | null>(null)
  const [attempt, setAttempt] = useState(0)
  const pending = useRef(false)
  const originalControl = useRef<HTMLElement | null>(null)
  const retryFocus = useRef<{ trigger: Element | null; moved: boolean } | null>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const appearance = snapshot ? snapshot.resolvedTheme : 'light'
  const savedTheme = snapshot ? snapshot.settings[appearance === 'dark' ? 'darkTheme' : 'lightTheme'] : 'oc-chan'
  const displayedTheme = saving ? savedTheme : themePreview ?? savedTheme
  const colors = THEMES[displayedTheme][appearance]
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.theme = appearance
    root.dataset.palette = displayedTheme
    for (const [name, value] of Object.entries(colors)) root.style.setProperty(`--${name}`, value)
  }, [appearance, displayedTheme, colors])
  useEffect(() => {
    const clearPreview = () => previewTheme(null)
    const onVisibility = () => { if (document.hidden) clearPreview() }
    window.addEventListener('blur', clearPreview)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', clearPreview)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      if (retryFocus.current && event.target !== retryFocus.current.trigger) retryFocus.current.moved = true
    }
    const onPointer = (event: PointerEvent) => {
      if (retryFocus.current && event.target instanceof Node && !retryFocus.current.trigger?.contains(event.target)) retryFocus.current.moved = true
    }
    const onBlur = () => { if (retryFocus.current) retryFocus.current.moved = true }
    document.addEventListener('focusin', onFocus)
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  useLayoutEffect(() => {
    if (saving) return
    const control = restoreFocus.current
    restoreFocus.current = null
    if (control?.isConnected) control.focus({ preventScroll: true })
  }, [saving, error])
  useEffect(() => {
    const api = window.desktopSettings
    if (!api) { setLoadError('未连接桌面设置接口。请启动 OC Chan 桌面应用。 / Desktop settings are unavailable. Launch the desktop app.'); return }
    let active = true
    let received = false
    const unsubscribe = api.subscribe(value => {
      received = true
      if (active) setSnapshot(value)
    })
    setLoadError(null)
    void api.snapshot().then(value => {
      if (active && !received) setSnapshot(value)
    }).catch(cause => { if (active) setLoadError(String(cause)) })
    return () => { active = false; unsubscribe() }
  }, [attempt])
  useLayoutEffect(() => {
    if (!snapshot) return
    const root = document.documentElement
    root.lang = snapshot.resolvedLanguage
    root.style.setProperty('--font-scale', String(FONT_SCALES[snapshot.settings.textSize]))
    root.style.setProperty('--ui-font', UI_FONTS[snapshot.settings.uiFont])
    root.style.setProperty('--code-font', CODE_FONTS[snapshot.settings.codeFont])
    document.title = snapshot.resolvedLanguage === 'zh-CN' ? 'OC Chan · 本机运行监控' : 'OC Chan · Local activity monitor'
  }, [snapshot])
  async function save(patch: Partial<AppSettings>, retrying: boolean) {
    if (pending.current) return
    pending.current = true
    previewTheme(null)
    if (retrying) retryFocus.current = { trigger: document.activeElement, moved: false }
    else {
      originalControl.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setError(null)
    }
    setSaving(true)
    try {
      if (!window.desktopSettings) throw new Error('Desktop settings are unavailable')
      const result = await window.desktopSettings.update(patch)
      if (result.ok) {
        if (retrying && retryFocus.current && !retryFocus.current.moved && document.activeElement === retryFocus.current.trigger) {
          restoreFocus.current = originalControl.current
        }
        setSnapshot(result.snapshot)
        setError(null)
      } else setError({ failure: result.error, patch })
    } catch (cause) {
      const details = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
      setError({ failure: { reason: 'connection', details }, patch })
    } finally {
      retryFocus.current = null
      pending.current = false
      setSaving(false)
    }
  }
  async function update(patch: Partial<AppSettings>) { await save({ ...patch }, false) }
  async function retry() { if (error) await save(error.patch, true) }
  if (!snapshot) return <main className="settings-loading" aria-busy={!loadError}>
    <h1>OC Chan</h1>
    {loadError ? <><p role="alert">{loadError}</p><button className="button secondary" onClick={() => setAttempt(value => value + 1)}>重试 / Retry</button></> : <p role="status">正在读取设置 / Loading settings…</p>}
  </main>
  return <SettingsContext.Provider value={{ snapshot, saving, error, update, retry, previewTheme }}>
    <LanguageProvider language={snapshot.resolvedLanguage}>{children}</LanguageProvider>
  </SettingsContext.Provider>
}
