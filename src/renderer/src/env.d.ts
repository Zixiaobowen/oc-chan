import type { MonitorApi } from '../../shared/types'
import type { SettingsApi } from '../../shared/settings'

declare global {
  interface Window { monitor?: MonitorApi; desktopSettings?: SettingsApi }
}
