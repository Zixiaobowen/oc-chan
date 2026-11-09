import type { MonitorApi } from '../../shared/types'
import type { SettingsApi } from '../../shared/settings'
import type { StartupRecoveryApi } from '../../shared/startup-recovery'
import type { UpdatesApi } from '../../shared/updates'
import type { MarketplaceApi } from '../../shared/marketplace'

declare global {
  interface Window { monitor?: MonitorApi; desktopSettings?: SettingsApi; startupRecovery?: StartupRecoveryApi; appUpdates?: UpdatesApi; pluginMarketplace?: MarketplaceApi }
}
