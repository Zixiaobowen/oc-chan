import { app, nativeImage, nativeTheme, powerSaveBlocker } from 'electron'
import type { AppSettings, ResolvedLanguage, SettingsSnapshot, SettingsUpdateFailure } from '../shared/settings'
import { LoginItems } from './login-items'
import { liquidGlassState } from './liquid-glass'
import type { NotificationState } from '../shared/notifications'

export function resolvedLanguage(settings: AppSettings): ResolvedLanguage {
  return settings.language === 'system' ? app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en' : settings.language
}

export function createTrayIcon() {
  const image = nativeImage.createEmpty()
  // Rasterized from resources/brand/oc-chan-mono.svg at 22 × 18 pt, 1× and 2×.
  image.addRepresentation({ scaleFactor: 1, buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABYAAAASCAYAAABfJS4tAAAB+0lEQVR4AbyTPUhVYRjHn6IpaqigloqWhqZqiYggW4rGPoaopaKaI/rAxQ8EF3FQEEEQPxAEFRxc1EUXcVBExMlBFF0dREU3/f3OPe/1XhE/Br38f8/zvO97zv88533PvRhn9Ds346e8QDsswAqMwAc4qBomxnKsheG+Sjv+w/QkfIP7cBteQT/0wCWoAA2rydZiLc4zXVAy/siwAZTmvyi+QCeoz4QW8GbNKGM8ImpzSFEREa6TIpJxVTaK6CM/gybogq/gG5DipyHnAvkluAVizTA0l8z4UUQ8APXPAE/ALknRQRiGJLu0vkX4AcruNRfrzPiuK+BhLZPVEMF9fU1WM4ac7EbqSmiD36Ccv0yxDffcii0KdcWQ0032wmmyumE4wCLjCZiHJJvzgUsap5uvsfod1F+Cr7VGvgpvIckvwLqZ8BxGQXlwcxSzkG3FOkU9qFZCOizKeEhwW26SN0B5OB6YtTjW1OzYN82MHdQRfLLfqn8QO/W1fPoL1pQPTAdn17tMSqlpWi8a73DRe2gEdZ3gH4QUmr+JiAGw0+LNjJPs0q1zPZtzj7OCsAn+++6Q38En8LN7TP4PdieapO9Ys4TzXFZQqXFhJmKVYhB6YQpU6tKbxTlzwnEZhxmXXZAPNNDc7vKpo9NJjXUp7p+D4ziN8XFeZet7AAAA//+sdooGAAAABklEQVQDAP+VYSWkXZklAAAAAElFTkSuQmCC', 'base64') })
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACwAAAAkCAYAAADy19hsAAAEPklEQVR4AeyXWchVVRTHv3qKBqgeIqKiemguonooomigh6IooogmKGiCiggqooIm6qEBokQcwAEcQBFBEFQUR5yHF0VRHPBFBQcEFX3S3+969mGfdc859356vwfFy/qfNey19/6fdfbZ+9zLhy6w3yXCI/3ALsoKX0/VXgd/gVlgLpgGfgbPguHc9NPki8XoBMcRhHpL22S30n0cOARmgq/Ba+BF8Bb4CSwCB8GPoE0iSf0ExxGnGaAn8SbC79B5K/gI9JLrSPgNbAIPgyipkhKMbdHvSbyO8GeMMgVcCYYjD5G8DDwJkki2H6IpP2mJ11Y7En6FHqNAnZwguBLMA1YT1SVXEZkBbgZO2ER2Ce0JmLUi6a7+OeEr6PY/iLKPwKfgavAEeAH46G9E/wGiGJ9P0AlRFZHkM0RyXIb/C6iTrieUE/6WHreAXFbjPALGAl8KVCkHsH4Az4NjIJd7c6ewJSVRSRehUvk0JF7XViZp5IQ/MZDhMPabwAqjGmUhLe+DNpGspNpybKu7ocqySIQfI/smkIuPe28eaLHdn0VTSj9kU19vLtlWvNI3EX40ZWR6QmZrmvs7hgdH3XY3lbY6yQmkdp/IHBy3w9vQuUjS5WG1hW366iFJaNzuJcMW7CMgl+9wvgceHB4oLhfcUlaUVrvh05xIysvAA+dfdJ1I3Dnl4fK836REOO65R20MeC747hR5qK6P7U6sTngwGYV2Ky3MLnUNkWsLdDgmwscJ5uLplfvaS71k2JDZmn5zqHthXUhw3w6h0rWy7lTCSpdLYleZcta4B3UDyOVXnK+AE3gaqnFLeaq0qkbcjz10/JiaTtrfwLFQXeLu8A/RxwvsQJeE1+oEfBh8Xdeba3e0TsB7wU+uEyc7aXeUt3G+AX48oSrigSHi3l8SXk/6HpCLh8LdeaDFfpe2l0CTVLampqQiLsn8JnO7JGzuGC8ZXOQ+9juzWJ35KsHJoE1cFv2QtqpxnEbCf5K5HeTyAI7V99HFF/Eu2vz2mI1OLy9mRxZ0rtVLIl0hUKQYi5UtmoYqN5pPZIcvhrp/bi3ejG/sZppXgZ1gG/gcRPEFdn3WHRiStorOpRbJjuPod42REzbBynyg0YD7iLvx34GuEz+I3qDBfylWJu7BNJViVUUZCIZkHaMSjoRtnMTFzXw/ejiynGS3to3oJB6tTpz8frX9usjauY6wcc95PxHdB08ZaMFu2r4EkvUDyqrlcGJJt1Wb7h0xx+8GdScQL02EzfNk8Y+nR6Mf7U7sbuDOMZ4EX8S0PP7Dt901GeEatc2qSUbyEalNzVDN0kY49TqJ4d8iJ/Ery4PjY2KeUmvQSZqqYr+Uo5Z8RFNf8yvoh3ClQ4vjpCKmSC7GztkfJGFJxGpG35zzwqAJW+G0DiU70Op6p4Mm7JiS9uUaOFkHHwnCjjtiuER4xEpbDHzBVfgMAAAA//89/UmuAAAABklEQVQDAOXWw0kxEO5fAAAAAElFTkSuQmCC', 'base64') })
  image.setTemplateImage(true)
  return image
}

export class DesktopSettings {
  private blocker: number | undefined

  readonly loginItems: LoginItems

  constructor(private readonly headless: boolean, private readonly notificationState: () => NotificationState) {
    this.loginItems = new LoginItems({
      platform: process.platform, packaged: app.isPackaged, headless,
      inApplicationsFolder: () => app.isInApplicationsFolder(),
      read: () => app.getLoginItemSettings({ type: 'mainAppService' }),
      write: openAtLogin => app.setLoginItemSettings({ type: 'mainAppService', openAtLogin })
    })
  }

  snapshot(settings: AppSettings, geometryError: SettingsUpdateFailure | null = null): SettingsSnapshot {
    return {
      settings,
      resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      resolvedLanguage: resolvedLanguage(settings),
      platform: process.platform,
      liquidGlass: liquidGlassState(),
      geometryError,
      loginItem: this.loginItems.snapshot(),
      notifications: settings.notifications.enabled && !settings.plugins.events
        ? { ...this.notificationState(), phase: 'events-disabled' } : this.notificationState()
    }
  }

  async apply(settings: AppSettings): Promise<void> {
    if (this.headless && (settings.showDock || settings.preventSleep)) {
      throw new Error('无头开发模式不允许显示 Dock 或阻止休眠 / Dock and sleep prevention are disabled in headless development')
    }
    if (nativeTheme.themeSource !== settings.appearance) nativeTheme.themeSource = settings.appearance
    if (this.headless) return
    if (process.platform === 'darwin') {
      if (!app.dock) throw new Error('Dock API 不可用 / Dock API unavailable')
      if (settings.showDock !== app.dock.isVisible()) {
        if (settings.showDock) await app.dock.show()
        else app.dock.hide()
      }
      if (app.dock.isVisible() !== settings.showDock) throw new Error('无法更改 Dock 可见性 / Cannot change Dock visibility')
    } else if (!settings.showDock) throw new Error('隐藏 Dock 仅适用于 macOS / Hiding Dock requires macOS')
    if (settings.preventSleep && this.blocker === undefined) {
      this.blocker = powerSaveBlocker.start('prevent-app-suspension')
      if (!powerSaveBlocker.isStarted(this.blocker)) throw new Error('无法阻止休眠 / Cannot prevent sleep')
    } else if (!settings.preventSleep) this.dispose()
  }

  dispose(): void {
    if (this.blocker === undefined) return
    powerSaveBlocker.stop(this.blocker)
    if (powerSaveBlocker.isStarted(this.blocker)) throw new Error('无法释放休眠阻止器 / Cannot release sleep blocker')
    this.blocker = undefined
  }
}
