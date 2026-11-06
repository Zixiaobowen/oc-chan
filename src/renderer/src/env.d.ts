import type { MonitorApi } from '../../shared/types'
import type { SettingsApi } from '../../shared/settings'
import type { StartupRecoveryApi } from '../../shared/startup-recovery'

declare global {
  interface Window { monitor?: MonitorApi; desktopSettings?: SettingsApi; startupRecovery?: StartupRecoveryApi }
}
