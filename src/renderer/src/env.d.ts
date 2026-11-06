import type { MonitorApi } from '../../shared/types'
import type { SettingsApi } from '../../shared/settings'
import type { UpdatesApi } from '../../shared/updates'

declare global {
  interface Window { monitor?: MonitorApi; desktopSettings?: SettingsApi; appUpdates?: UpdatesApi }
}
