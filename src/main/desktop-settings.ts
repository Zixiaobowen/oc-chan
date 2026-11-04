import { app, nativeImage, nativeTheme, powerSaveBlocker } from 'electron'
import type { AppSettings, ResolvedLanguage, SettingsSnapshot } from '../shared/settings'

export function resolvedLanguage(settings: AppSettings): ResolvedLanguage {
  return settings.language === 'system' ? app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en' : settings.language
}

export function createTrayIcon() {
  const image = nativeImage.createEmpty()
  image.addRepresentation({
    scaleFactor: 2,
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAW0lEQVR4nO2ROQ4AIAzD+v9Pw8qCWgrhELaUjUQWNYNPKU2uACGPbUJFFIS2CM2CkGxr+d1nd71iZMzrIfS3UBaEjgr13mQ6Q6iE0jwjdGwr+hOjQUgmBACgpgLGrlS6UpCm5QAAAABJRU5ErkJggg==', 'base64')
  })
  image.setTemplateImage(true)
  return image
}

export class DesktopSettings {
  private blocker: number | undefined

  snapshot(settings: AppSettings): SettingsSnapshot {
    return {
      settings,
      resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      resolvedLanguage: resolvedLanguage(settings),
      platform: process.platform
    }
  }

  async apply(settings: AppSettings): Promise<void> {
    if (nativeTheme.themeSource !== settings.appearance) nativeTheme.themeSource = settings.appearance
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
