import type { ThemeId } from './themes'
import type { NavigationTarget } from './navigation'
import type { MonitorSection } from './types'
import { DEFAULT_NOTIFICATIONS, type NotificationSettings, type NotificationState } from './notifications'

export type Appearance = 'system' | 'light' | 'dark'
export type Language = 'system' | 'zh-CN' | 'en'
export type ResolvedLanguage = Exclude<Language, 'system'>
export type TextSize = 'small' | 'default' | 'large'
export type UiFont = 'system' | 'pingfang' | 'helvetica'
export type CodeFont = 'system' | 'menlo' | 'monaco'

export const MIN_SIDEBAR_WIDTH = 188
export const MAX_SIDEBAR_WIDTH = 320
export interface WindowBounds { x: number; y: number; width: number; height: number }

export type PluginSettings = Record<MonitorSection, boolean>

export interface AppSettings {
  appearance: Appearance
  glassIntensity: number
  lightTheme: ThemeId
  darkTheme: ThemeId
  language: Language
  textSize: TextSize
  uiFont: UiFont
  codeFont: CodeFont
  trayClick: 'tray' | 'main'
  showDock: boolean
  preventSleep: boolean
  sidebarWidth: number
  windowBounds: WindowBounds | null
  plugins: PluginSettings
  notifications: NotificationSettings
}

export type SettingsPatch = Omit<Partial<AppSettings>, 'plugins'> & { plugins?: Partial<PluginSettings> }

export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
  appearance: 'system', lightTheme: 'oc-chan', darkTheme: 'oc-chan',
  glassIntensity: 65,
  language: 'system', textSize: 'default',
  uiFont: 'system', codeFont: 'system', trayClick: 'tray',
  showDock: true, preventSleep: false, sidebarWidth: 214, windowBounds: null,
  plugins: Object.freeze({ agents: true, schedules: true, system: true, events: true }),
  notifications: DEFAULT_NOTIFICATIONS
}

export interface LoginItemState {
  availability: 'available' | 'development' | 'not-installed' | 'unsupported'
  status: 'not-registered' | 'enabled' | 'requires-approval' | 'not-found' | 'unknown'
  openAtLogin: boolean | null
  wasOpenedAtLogin: boolean
  details: string | null
}
export type LoginItemUpdateResult =
  | { ok: true; state: LoginItemState }
  | { ok: false; state: LoginItemState; details: string; rollbackFailed: boolean }

export interface SettingsSnapshot {
  settings: AppSettings
  resolvedTheme: 'light' | 'dark'
  resolvedLanguage: ResolvedLanguage
  platform: string
  liquidGlass: { available: boolean; reducedTransparency: boolean; increasedContrast: boolean }
  geometryError: SettingsUpdateFailure | null
  loginItem: LoginItemState
  notifications: NotificationState
}

export type SettingsFailureReason = 'permission-denied' | 'storage-full' | 'read-only' | 'path-conflict' | 'path-unavailable' | 'timeout' | 'unknown'

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
  retryGeometry(): Promise<SettingsUpdateResult>
  update(patch: SettingsPatch): Promise<SettingsUpdateResult>
  previewGlass(intensity: number | null): Promise<void>
  updateLoginItem(enabled: boolean): Promise<LoginItemUpdateResult>
  requestNotificationPermission(): Promise<NotificationState>
  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void
  showMainWindow(target?: NavigationTarget): Promise<void>
}
