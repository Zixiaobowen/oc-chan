import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { SettingsPatch, SettingsSnapshot, SettingsUpdateFailure } from '../../shared/settings'
import { THEMES, type ThemeId } from '../../shared/themes'
import { summarizeDiagnostic } from '../../shared/diagnostics'
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
  patch: SettingsPatch
}
interface SettingsContextValue {
  snapshot: SettingsSnapshot
  saving: boolean
  error: SettingsSaveFailure | null
  update: (patch: SettingsPatch) => Promise<void>
  retry: () => Promise<void>
  previewTheme: (theme: ThemeId | null) => void
  glassPreview: number | null
  glassPreviewError: { details: string; intensity: number | null } | null
  previewGlass: (intensity: number | null) => void
  retryGlassPreview: () => void
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
  const [glassPreview, setGlassPreview] = useState<number | null>(null)
  const [glassPreviewError, setGlassPreviewError] = useState<{ details: string; intensity: number | null } | null>(null)
  const glassRequest = useRef<{ intensity: number | null; revision: number } | undefined>(undefined)
  const glassWorker = useRef<Promise<void> | null>(null)
  const glassRevision = useRef(0)
  const glassFailure = useRef(false)
  const glassActive = useRef(false)
  const pending = useRef(false)
  const queued = useRef<SettingsPatch | null>(null)
  const originalControl = useRef<HTMLElement | null>(null)
  const retryFocus = useRef<{ trigger: Element | null; moved: boolean } | null>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const appearance = snapshot ? snapshot.resolvedTheme : 'light'
  const savedTheme = snapshot ? snapshot.settings[appearance === 'dark' ? 'darkTheme' : 'lightTheme'] : 'oc-chan'
  const displayedTheme = saving ? savedTheme : themePreview ?? savedTheme
  const colors = THEMES[displayedTheme][appearance]
  const flushGlass = useCallback(function flush(): Promise<void> {
    if (glassWorker.current) return glassWorker.current
    const run = async () => {
      while (glassRequest.current !== undefined) {
        const request = glassRequest.current
        glassRequest.current = undefined
        try {
          if (!window.desktopSettings) throw new Error('Desktop settings are unavailable')
          await window.desktopSettings.previewGlass(request.intensity)
          if (request.revision === glassRevision.current) {
            if (request.intensity !== null) glassFailure.current = false
            if (document.activeElement?.matches('.glass-preview-error button')) {
              document.getElementById('glass-intensity')?.focus({ preventScroll: true })
            }
            setGlassPreviewError(previous => request.intensity !== null || previous?.intensity === null ? null : previous)
          }
        } catch (cause) {
          glassFailure.current = true
          setGlassPreviewError({ details: summarizeDiagnostic(cause, 'settings-apply', 'settings').details, intensity: request.intensity })
          if (request.revision === glassRevision.current) {
            setGlassPreview(null)
            if (request.intensity !== null) {
              glassActive.current = false
              glassRequest.current = { intensity: null, revision: ++glassRevision.current }
            }
          }
        }
      }
    }
    const worker = run().finally(() => {
      glassWorker.current = null
      if (glassRequest.current !== undefined) return flush()
    })
    glassWorker.current = worker
    return worker
  }, [])
  const previewGlass = useCallback((intensity: number | null) => {
    if (intensity !== null && pending.current) return
    if (intensity === null && !glassActive.current) return
    glassActive.current = intensity !== null
    setGlassPreview(intensity)
    glassRequest.current = { intensity, revision: ++glassRevision.current }
    void flushGlass()
  }, [flushGlass])
  const retryGlassPreview = () => {
    if (!glassPreviewError || pending.current) return
    const intensity = glassPreviewError.intensity
    if (intensity === null) glassFailure.current = false
    // A failed cancellation must be sent even when no local preview remains.
    glassActive.current = true
    previewGlass(intensity)
  }
  useLayoutEffect(() => {
    const root = document.documentElement
    const capability = snapshot?.liquidGlass
    const intensity = glassPreview ?? snapshot?.settings.glassIntensity ?? 0
    const state = glassPreviewError ? 'error' : !capability?.available ? 'unavailable'
      : capability.reducedTransparency || capability.increasedContrast ? 'accessibility'
        : intensity === 0 ? 'off' : 'active'
    root.dataset.liquidGlass = state
    root.style.setProperty('--glass-intensity', String(intensity / 100))
    root.style.setProperty('--glass-solid-percent', `${100 - intensity * 0.72}%`)
  }, [glassPreview, glassPreviewError, snapshot?.settings.glassIntensity, snapshot?.liquidGlass.available, snapshot?.liquidGlass.reducedTransparency, snapshot?.liquidGlass.increasedContrast])
  useEffect(() => {
    const cancel = () => previewGlass(null)
    const onVisibility = () => { if (document.hidden) cancel() }
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', onVisibility)
      cancel()
    }
  }, [previewGlass])
  useEffect(() => {
    const capability = snapshot?.liquidGlass
    if (capability && (!capability.available || capability.reducedTransparency || capability.increasedContrast)) previewGlass(null)
  }, [snapshot?.liquidGlass.available, snapshot?.liquidGlass.reducedTransparency, snapshot?.liquidGlass.increasedContrast, previewGlass])
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
    }).catch(cause => { if (active) setLoadError(summarizeDiagnostic(cause, 'settings-read', 'settings').details) })
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
  }, [snapshot?.resolvedLanguage, snapshot?.settings.textSize, snapshot?.settings.uiFont, snapshot?.settings.codeFont])
  async function save(patch: SettingsPatch, retrying: boolean) {
    if (pending.current) return
    pending.current = true
    previewTheme(null)
    if (patch.glassIntensity === undefined) previewGlass(null)
    if (retrying) retryFocus.current = { trigger: document.activeElement, moved: false }
    else {
      originalControl.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setError(null)
    }
    setSaving(true)
    try {
      if (!window.desktopSettings) throw new Error('Desktop settings are unavailable')
      if (patch.glassIntensity !== undefined) {
        await flushGlass()
        if (glassFailure.current) return
      }
      const result = await window.desktopSettings.update(patch)
      if (result.ok) {
        if (retrying && retryFocus.current && !retryFocus.current.moved && document.activeElement === retryFocus.current.trigger) {
          restoreFocus.current = originalControl.current
        }
        setSnapshot(result.snapshot)
        setError(null)
      } else setError({ failure: result.error, patch })
    } catch (cause) {
      const { details } = summarizeDiagnostic(cause, 'settings-connection', 'settings')
      setError({ failure: { reason: 'connection', details }, patch })
    } finally {
      if (patch.glassIntensity !== undefined) {
        setGlassPreview(null)
        glassActive.current = false
        glassRequest.current = { intensity: null, revision: ++glassRevision.current }
        await flushGlass()
      }
      retryFocus.current = null
      pending.current = false
      setSaving(false)
      const next = queued.current
      queued.current = null
      if (next) void save(next, false)
    }
  }
  async function update(patch: SettingsPatch) {
    if (pending.current) {
      queued.current = { ...queued.current, ...patch,
        ...((queued.current?.plugins || patch.plugins) && { plugins: { ...queued.current?.plugins, ...patch.plugins } }) }
      return
    }
    await save({ ...patch, ...(patch.plugins && { plugins: { ...patch.plugins } }) }, false)
  }
  async function retry() { if (error) await save(error.patch, true) }
  if (!snapshot) return <main className="settings-loading" aria-busy={!loadError}>
    <h1>OC Chan</h1>
    {loadError ? <><p role="alert">{loadError}</p><button className="button secondary" onClick={() => setAttempt(value => value + 1)}>重试 / Retry</button></> : <p role="status">正在读取设置 / Loading settings…</p>}
  </main>
  return <SettingsContext.Provider value={{ snapshot, saving, error, update, retry, previewTheme, glassPreview, glassPreviewError, previewGlass, retryGlassPreview }}>
    <LanguageProvider language={snapshot.resolvedLanguage}>{children}</LanguageProvider>
  </SettingsContext.Provider>
}
