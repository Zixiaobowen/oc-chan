import { app, nativeTheme, type BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { SettingsSnapshot } from '../shared/settings'
import { THEMES } from '../shared/themes'

interface NativeGlass {
  supported(): boolean
  setGlass(handle: Buffer, intensity: number, dark: boolean): { active: boolean; viewCount: number }
}
let native: NativeGlass | undefined
const applied = new WeakMap<BrowserWindow, { intensity: number; dark: boolean }>()

function binding(): NativeGlass {
  if (!native) {
    const resources = app.isPackaged ? process.resourcesPath
      : process.env.OC_CHAN_DEV_INSTANCE ? path.join(process.env.OC_CHAN_DEV_INSTANCE, 'resources')
        : path.join(app.getAppPath(), 'resources')
    native = createRequire(path.join(app.getAppPath(), 'package.json'))(path.join(resources, 'liquid-glass/liquid-glass.node')) as NativeGlass
  }
  return native
}

export function liquidGlassState(): SettingsSnapshot['liquidGlass'] {
  return {
    available: process.platform === 'darwin' && binding().supported(),
    reducedTransparency: nativeTheme.prefersReducedTransparency,
    increasedContrast: nativeTheme.shouldUseHighContrastColors
  }
}

export function applyWindowMaterial(target: BrowserWindow, snapshot: SettingsSnapshot, preview?: number): void {
  const { settings, resolvedTheme, liquidGlass } = snapshot
  const dark = resolvedTheme === 'dark'
  const intensity = liquidGlass.available && !liquidGlass.reducedTransparency && !liquidGlass.increasedContrast
    ? preview ?? settings.glassIntensity : 0
  if (liquidGlass.available) {
    const previous = applied.get(target)
    if (!previous || previous.intensity !== intensity || previous.dark !== dark) {
      const result = binding().setGlass(target.getNativeWindowHandle(), intensity, dark)
      if (result.active !== (intensity > 0) || result.viewCount !== (intensity > 0 ? 1 : 0))
        throw new Error('原生液态玻璃状态不一致 / Native Liquid Glass state is inconsistent')
      applied.set(target, { intensity, dark })
    }
  }
  target.setBackgroundColor(intensity > 0 ? '#00000000'
    : THEMES[settings[dark ? 'darkTheme' : 'lightTheme']][resolvedTheme].ground)
}
