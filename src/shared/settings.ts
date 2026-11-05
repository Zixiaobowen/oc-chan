import type { ThemeId } from './themes'

export type Appearance = 'system' | 'light' | 'dark'
export type Language = 'system' | 'zh-CN' | 'en'
export type ResolvedLanguage = Exclude<Language, 'system'>
export type TextSize = 'small' | 'default' | 'large'
export type UiFont = 'system' | 'pingfang' | 'helvetica'
export type CodeFont = 'system' | 'menlo' | 'monaco'

export interface AppSettings {
  appearance: Appearance
  lightTheme: ThemeId
  darkTheme: ThemeId
  glassIntensity: number
  language: Language
  textSize: TextSize
  uiFont: UiFont
  codeFont: CodeFont
  trayClick: 'tray' | 'main'
  showDock: boolean
  preventSleep: boolean
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
  appearance: 'system', lightTheme: 'oc-chan', darkTheme: 'oc-chan',
  glassIntensity: 65,
  language: 'system', textSize: 'default',
  uiFont: 'system', codeFont: 'system', trayClick: 'tray',
  showDock: true, preventSleep: false
}

export interface SettingsSnapshot {
  settings: AppSettings
  resolvedTheme: 'light' | 'dark'
  resolvedLanguage: ResolvedLanguage
  platform: string
  liquidGlass: { available: boolean; reducedTransparency: boolean; increasedContrast: boolean }
}

export type SettingsFailureReason = 'permission-denied' | 'storage-full' | 'read-only' | 'path-conflict' | 'path-unavailable' | 'unknown'

export interface SettingsUpdateFailure {
  reason: SettingsFailureReason
  details: string
  filePath: string
}

export type SettingsUpdateResult =
  | { ok: true; snapshot: SettingsSnapshot }
  | { ok: false; error: SettingsUpdateFailure }

export interface SettingsApi {
  snapshot(): Promise<SettingsSnapshot>
  update(patch: Partial<AppSettings>): Promise<SettingsUpdateResult>
  previewGlass(intensity: number | null): Promise<void>
  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void
  showMainWindow(): Promise<void>
}
