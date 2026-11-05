import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, Tray } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Monitor } from './monitor'
import { focusAgentInTern } from './tern-navigation'
import { createTrayIcon, DesktopSettings, resolvedLanguage } from './desktop-settings'
import { describeError, readSettings, SettingsRollbackError, SettingsStore, settingsUpdateFailure } from './settings'
import type { AppSettings, SettingsSnapshot, SettingsUpdateResult } from '../shared/settings'
import type { MonitorSection, MonitorUpdate } from '../shared/types'
import { THEMES } from '../shared/themes'
import { applyWindowMaterial } from './liquid-glass'

app.setName('OC Chan')
const developmentInstance = app.isPackaged ? undefined : process.env.OC_CHAN_DEV_INSTANCE
const headless = !app.isPackaged && process.env.OC_CHAN_HEADLESS === '1'
if (headless && !developmentInstance) {
  console.error('无头模式需要独立实例目录 / Headless mode requires OC_CHAN_DEV_INSTANCE')
  app.exit(1)
}
try {
  if (developmentInstance) {
    for (const name of ['user-data', 'session-data', 'logs']) mkdirSync(path.join(developmentInstance, name), { recursive: true })
    app.setPath('userData', path.join(developmentInstance, 'user-data'))
    app.setPath('sessionData', path.join(developmentInstance, 'session-data'))
    app.setAppLogsPath(path.join(developmentInstance, 'logs'))
  }
  if (headless && process.platform === 'darwin') app.setActivationPolicy('prohibited')
} catch (error) {
  if (!headless) throw error
  console.error(error)
  app.exit(1)
}
const monitor = new Monitor()
const desktop = new DesktopSettings(headless)
let window: BrowserWindow | null = null
let trayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let trayMenu: Menu | undefined
let settings: SettingsStore | undefined
let trayReady = false
let trayRequested = false
let quitting = false
let quitReady = false
let exitCode = 0
let glassPreview: number | null = null
const rendererFile = path.join(__dirname, '../renderer/index.html')
const devUrl = process.env.ELECTRON_RENDERER_URL
const ternResources = app.isPackaged
  ? path.join(process.resourcesPath, 'tern-navigation')
  : developmentInstance ? path.join(developmentInstance, 'resources/tern-navigation')
    : path.resolve(__dirname, '../../resources/tern-navigation')

function rendererUrl(popover = false): string {
  const url = devUrl ? new URL(devUrl) : pathToFileURL(rendererFile)
  url.search = popover ? '?view=tray' : ''
  url.hash = ''
  return url.href
}

function fail(error: unknown): void {
  console.error(error)
  if (!headless) dialog.showErrorBox('OC Chan · 错误 / Error', describeError(error))
  exitCode = 1
  app.quit()
}

if (headless) {
  process.on('uncaughtException', fail)
  process.on('unhandledRejection', fail)
}

function trustedSender(event: Electron.IpcMainInvokeEvent): void {
  const owner = [window, trayWindow].find((candidate) => candidate && !candidate.isDestroyed() && candidate.webContents === event.sender)
  if (quitting || !owner || event.senderFrame !== event.sender.mainFrame || !event.senderFrame?.url) {
    throw new Error('不允许的窗口来源 / Untrusted window')
  }
  const url = new URL(event.senderFrame.url)
  url.hash = ''
  if (url.href !== rendererUrl(owner === trayWindow)) throw new Error('不允许的窗口来源 / Untrusted window')
}

function secureWindow(target: BrowserWindow): void {
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  target.webContents.on('will-navigate', (event) => event.preventDefault())
  target.webContents.on('will-attach-webview', (event) => event.preventDefault())
  target.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  target.webContents.session.setPermissionCheckHandler(() => false)
}

function hideTrayWindow(): void {
  trayRequested = false
  trayWindow?.hide()
}

function showMainWindow(): void {
  if (headless) throw new Error('无头开发模式不允许显示原生窗口 / Native windows are disabled in headless development')
  if (quitting) throw new Error('应用正在退出 / Application is quitting')
  hideTrayWindow()
  if (!window || window.isDestroyed()) createWindow()
  if (window?.isMinimized()) window.restore()
  window?.show()
  window?.focus()
}

function windowBackground({ settings: value, resolvedTheme }: SettingsSnapshot): string {
  return THEMES[value[resolvedTheme === 'dark' ? 'darkTheme' : 'lightTheme']][resolvedTheme].ground
}

function createWindow(): void {
  const appearance = desktop.snapshot(settings!.value)
  const target = new BrowserWindow({
    width: 1280, height: 860, minWidth: 880, minHeight: 640,
    title: 'OC Chan', backgroundColor: windowBackground(appearance), transparent: appearance.liquidGlass.available,
    titleBarStyle: 'hiddenInset', show: false, focusable: !headless,
    trafficLightPosition: { x: 20, y: 19 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true
    }
  })
  window = target
  applyWindowMaterial(target, appearance)
  const cancelGlassPreview = () => {
    if (glassPreview === null || target.isDestroyed() || quitting) return
    glassPreview = null
    try { applyWindowMaterial(target, desktop.snapshot(settings!.value)) } catch (error) { fail(error) }
  }
  target.on('blur', cancelGlassPreview)
  target.on('hide', cancelGlassPreview)
  target.webContents.on('did-start-navigation', cancelGlassPreview)
  target.webContents.on('render-process-gone', cancelGlassPreview)
  if (headless) target.webContents.on('render-process-gone', (_event, details) => {
    fail(new Error(`Headless renderer exited: ${details.reason} (${details.exitCode})`))
  })
  secureWindow(target)
  target.once('ready-to-show', () => { if (!quitting && !headless) { target.show(); target.focus() } })
  target.on('close', (event) => { if (!quitting) { event.preventDefault(); target.hide() } })
  target.on('closed', () => { if (window === target) { window = null; glassPreview = null } })
  void target.loadURL(rendererUrl()).then(() => {
    if (headless) console.log(`[oc-chan] Headless renderer ready; pid=${process.pid}`)
  }).catch(fail)
}

function presentTrayWindow(): void {
  if (headless || !trayRequested || !trayReady || !trayWindow || !tray || quitting) return
  const bounds = tray.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const [width, height] = trayWindow.getSize()
  const x = Math.max(area.x, Math.min(bounds.x + bounds.width / 2 - width / 2, area.x + area.width - width))
  const below = bounds.y + bounds.height + 6
  const preferredY = below + height <= area.y + area.height ? below : bounds.y - height - 6
  const y = Math.max(area.y, Math.min(preferredY, area.y + area.height - height))
  trayWindow.setPosition(Math.round(x), Math.round(y))
  trayWindow.show()
  trayWindow.focus()
}

function createTrayWindow(): void {
  if (headless) throw new Error('无头开发模式不允许创建托盘 / Tray is disabled in headless development')
  const appearance = desktop.snapshot(settings!.value)
  const target = new BrowserWindow({
    width: 380, height: 560, show: false, frame: false,
    resizable: false, maximizable: false, minimizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    title: 'OC Chan', backgroundColor: windowBackground(appearance), transparent: appearance.liquidGlass.available,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true
    }
  })
  trayWindow = target
  applyWindowMaterial(target, appearance)
  trayReady = false
  secureWindow(target)
  target.once('ready-to-show', () => { trayReady = true; presentTrayWindow() })
  target.on('blur', hideTrayWindow)
  target.on('close', (event) => { if (!quitting) { event.preventDefault(); hideTrayWindow() } })
  target.on('closed', () => { if (trayWindow === target) { trayWindow = null; trayReady = false; trayRequested = false } })
  target.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') { event.preventDefault(); hideTrayWindow() }
  })
  void target.loadURL(rendererUrl(true)).catch(fail)
}

function updateMenus(value: AppSettings): void {
  if (headless) return
  const chinese = resolvedLanguage(value) === 'zh-CN'
  trayMenu = Menu.buildFromTemplate([
    { label: chinese ? '打开主界面' : 'Open main window', click: showMainWindow },
    { type: 'separator' },
    { label: chinese ? '退出 OC Chan' : 'Quit OC Chan', click: () => app.quit() }
  ])
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'OC Chan', submenu: [
      { role: 'about', label: chinese ? '关于 OC Chan' : 'About OC Chan' },
      { type: 'separator' },
      { role: 'hide', label: chinese ? '隐藏 OC Chan' : 'Hide OC Chan' },
      { role: 'hideOthers', label: chinese ? '隐藏其他应用' : 'Hide Others' },
      { type: 'separator' },
      { role: 'quit', label: chinese ? '退出 OC Chan' : 'Quit OC Chan' }
    ] },
    { role: 'editMenu', label: chinese ? '编辑' : 'Edit' },
    { label: chinese ? '显示' : 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu', label: chinese ? '窗口' : 'Window' }
  ]))
}

function broadcastSettings(): void {
  if (!settings || quitting || settings.isUpdating) return
  try {
    const snapshot = desktop.snapshot(settings.value)
    for (const target of [window, trayWindow]) {
      if (target && !target.isDestroyed()) {
        applyWindowMaterial(target, snapshot, target === window ? glassPreview ?? undefined : undefined)
        target.webContents.send('settings:changed', snapshot)
      }
    }
  } catch (error) { fail(error) }
}

if (!app.requestSingleInstanceLock()) {
  if (headless) app.exit(1)
  else app.quit()
}
else {
  app.on('second-instance', () => { if (!headless && settings && app.isReady() && !quitting) showMainWindow() })
  app.on('activate', () => { if (!headless && settings && !quitting) showMainWindow() })
  if (developmentInstance) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => app.quit())
  }
  app.whenReady().then(async () => {
    const filename = path.resolve(app.getPath('userData'), 'settings.json')
    const initial = await readSettings(filename)
    if (headless) { initial.showDock = false; initial.preventSleep = false }
    settings = new SettingsStore(filename, initial, async (value) => {
      glassPreview = null
      const visible = window?.isVisible()
      const focused = window?.isFocused()
      await desktop.apply(value)
      if (!headless && visible && window && !window.isDestroyed()) {
        window.show()
        if (focused) window.focus()
      }
      updateMenus(value)
      const appearance = desktop.snapshot(value)
      for (const target of [window, trayWindow]) {
        if (target && !target.isDestroyed()) applyWindowMaterial(target, appearance)
      }
    })
    if (!headless) {
      tray = new Tray(createTrayIcon())
      tray.setToolTip('OC Chan')
      if (process.platform === 'darwin') tray.setIgnoreDoubleClickEvents(true)
      tray.on('click', () => {
        if (quitting || !settings) return
        if (settings.value.trayClick === 'main') { showMainWindow(); return }
        if (!trayWindow) createTrayWindow()
        trayRequested = !trayRequested
        if (trayRequested) presentTrayWindow()
        else hideTrayWindow()
      })
      tray.on('right-click', () => { hideTrayWindow(); if (trayMenu) tray?.popUpContextMenu(trayMenu) })
    }
    await desktop.apply(initial)
    updateMenus(initial)
    ipcMain.handle('settings:snapshot', async (event) => {
      trustedSender(event)
      await settings!.idle()
      return desktop.snapshot(settings!.value)
    })
    ipcMain.handle('settings:preview-glass', (event, ...args: unknown[]) => {
      trustedSender(event)
      if (!window || window.isDestroyed() || event.sender !== window.webContents) {
        throw new Error('玻璃预览仅允许主窗口 / Glass preview requires the main window')
      }
      const intensity = args[0]
      if (args.length !== 1 || (intensity !== null && (typeof intensity !== 'number' || !Number.isInteger(intensity) || intensity < 0 || intensity > 100))) {
        throw new Error('玻璃强度必须是 null 或 0–100 的整数 / Glass preview must be null or an integer from 0 to 100')
      }
      if (settings!.isUpdating) throw new Error('设置正在保存 / Settings update is in progress')
      applyWindowMaterial(window, desktop.snapshot(settings!.value), intensity ?? undefined)
      glassPreview = intensity
    })
    ipcMain.handle('settings:update', async (event, patch: unknown): Promise<SettingsUpdateResult> => {
      trustedSender(event)
      glassPreview = null
      try {
        await settings!.update(patch)
        await settings!.idle()
      } catch (error) {
        if (error instanceof SettingsRollbackError) {
          fail(error)
          throw new Error(describeError(error))
        }
        broadcastSettings()
        return { ok: false, error: settingsUpdateFailure(error, filename) }
      }
      broadcastSettings()
      return { ok: true, snapshot: desktop.snapshot(settings!.value) }
    })
    ipcMain.handle('settings:show-main-window', (event) => { trustedSender(event); showMainWindow() })
    ipcMain.handle('monitor:snapshot', (event) => { trustedSender(event); return monitor.state })
    ipcMain.handle('monitor:refresh', async (event, section?: MonitorSection) => {
      trustedSender(event)
      if (section !== undefined && !['agents', 'schedules', 'system'].includes(section)) throw new Error('未知的数据来源')
      await monitor.refresh(section)
    })
    ipcMain.handle('monitor:focus-agent-in-tern', async (event, agentId: unknown) => {
      trustedSender(event)
      try {
        if (headless) throw new Error('无头开发模式不允许切换应用 / App navigation is disabled in headless development')
        if (typeof agentId !== 'string') throw new Error('无效的 Agent 标识')
        await focusAgentInTern(monitor.state.agents.data?.agents ?? [], agentId, undefined, ternResources)
        return { error: null }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    })
    monitor.on('change', (update: MonitorUpdate) => {
      for (const target of [window, trayWindow]) {
        if (target && !target.isDestroyed()) target.webContents.send('monitor:changed', update)
      }
    })
    nativeTheme.on('updated', broadcastSettings)
    createWindow()
    if (!headless) createTrayWindow()
    monitor.start()
  }).catch(fail)
  app.on('before-quit', (event) => {
    if (quitReady) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    void (async () => {
      const failures: unknown[] = []
      try { await settings?.idle() } catch (error) { failures.push(error) }
      try { monitor.stop() } catch (error) { failures.push(error) }
      try { desktop.dispose() } catch (error) { failures.push(error) }
      try { tray?.destroy(); tray = null } catch (error) { failures.push(error) }
      nativeTheme.removeListener('updated', broadcastSettings)
      if (failures.length) {
        const error = new AggregateError(failures, '退出清理失败 / Shutdown cleanup failed')
        console.error(error)
        if (!headless) dialog.showErrorBox('OC Chan · 错误 / Error', describeError(error))
        exitCode = 1
      }
      quitReady = true
      app.exit(exitCode)
    })()
  })
}
