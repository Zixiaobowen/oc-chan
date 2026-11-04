import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, Tray } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Monitor } from './monitor'
import { focusAgentInTern } from './tern-navigation'
import { createTrayIcon, DesktopSettings, resolvedLanguage } from './desktop-settings'
import { describeError, readSettings, SettingsRollbackError, SettingsStore, settingsUpdateFailure } from './settings'
import type { AppSettings, SettingsSnapshot, SettingsUpdateResult } from '../shared/settings'
import type { MonitorSection, MonitorUpdate } from '../shared/types'
import { THEMES } from '../shared/themes'

app.setName('OC Chan')
const monitor = new Monitor()
const desktop = new DesktopSettings()
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
const rendererFile = path.join(__dirname, '../renderer/index.html')
const devUrl = process.env.ELECTRON_RENDERER_URL
const ternResources = app.isPackaged
  ? path.join(process.resourcesPath, 'tern-navigation')
  : path.resolve(__dirname, '../../resources/tern-navigation')

function rendererUrl(popover = false): string {
  const url = devUrl ? new URL(devUrl) : pathToFileURL(rendererFile)
  url.search = popover ? '?view=tray' : ''
  url.hash = ''
  return url.href
}

function fail(error: unknown): void {
  console.error(error)
  dialog.showErrorBox('OC Chan · 错误 / Error', describeError(error))
  exitCode = 1
  app.quit()
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
  const target = new BrowserWindow({
    width: 1280, height: 860, minWidth: 880, minHeight: 640,
    title: 'OC Chan', backgroundColor: windowBackground(desktop.snapshot(settings!.value)),
    titleBarStyle: 'hiddenInset', show: false,
    trafficLightPosition: { x: 20, y: 19 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true
    }
  })
  window = target
  secureWindow(target)
  target.once('ready-to-show', () => { if (!quitting) { target.show(); target.focus() } })
  target.on('close', (event) => { if (!quitting) { event.preventDefault(); target.hide() } })
  target.on('closed', () => { if (window === target) window = null })
  void target.loadURL(rendererUrl()).catch(fail)
}

function presentTrayWindow(): void {
  if (!trayRequested || !trayReady || !trayWindow || !tray || quitting) return
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
  const target = new BrowserWindow({
    width: 380, height: 560, show: false, frame: false,
    resizable: false, maximizable: false, minimizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    title: 'OC Chan', backgroundColor: windowBackground(desktop.snapshot(settings!.value)),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true
    }
  })
  trayWindow = target
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
  const snapshot = desktop.snapshot(settings.value)
  for (const target of [window, trayWindow]) {
    if (target && !target.isDestroyed()) {
      target.setBackgroundColor(windowBackground(snapshot))
      target.webContents.send('settings:changed', snapshot)
    }
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (settings && app.isReady() && !quitting) showMainWindow() })
  app.on('activate', () => { if (settings && !quitting) showMainWindow() })
  app.whenReady().then(async () => {
    const filename = path.resolve(app.getPath('userData'), 'settings.json')
    const initial = await readSettings(filename)
    settings = new SettingsStore(filename, initial, async (value) => {
      const visible = window?.isVisible()
      const focused = window?.isFocused()
      await desktop.apply(value)
      if (visible && window && !window.isDestroyed()) {
        window.show()
        if (focused) window.focus()
      }
      updateMenus(value)
    })
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
    await desktop.apply(initial)
    updateMenus(initial)
    ipcMain.handle('settings:snapshot', async (event) => {
      trustedSender(event)
      await settings!.idle()
      return desktop.snapshot(settings!.value)
    })
    ipcMain.handle('settings:update', async (event, patch: unknown): Promise<SettingsUpdateResult> => {
      trustedSender(event)
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
    createTrayWindow()
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
        dialog.showErrorBox('OC Chan · 错误 / Error', describeError(error))
        exitCode = 1
      }
      quitReady = true
      app.exit(exitCode)
    })()
  })
}
