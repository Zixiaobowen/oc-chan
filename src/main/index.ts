import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, Tray } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { release as osRelease } from 'node:os'
import { version as appVersion } from '../../package.json'
import { Monitor } from './monitor'
import { createSystemPlugin } from './plugins/system'
import { createAgentsPlugin } from './plugins/agents'
import { createSchedulesPlugin } from './plugins/schedules'
import { createEventsPlugin } from './plugins/events'
import { EventNotifications } from './events/notifications'
import { createNativeNotificationAdapter } from './events/native-notifications'
import { TernNavigation } from './tern-navigation'
import { createTrayIcon, DesktopSettings, resolvedLanguage } from './desktop-settings'
import { readSettings, SettingsRollbackError, SettingsStore, settingsUpdateFailure } from './settings'
import { DiagnosticError, summarizeDiagnostic, type DiagnosticStage } from '../shared/diagnostics'
import type { AppSettings, PluginSettings, SettingsSnapshot, SettingsUpdateResult } from '../shared/settings'
import type { MonitorUpdate, SourceHeartbeat } from '../shared/types'
import { THEMES } from '../shared/themes'
import { PendingNavigation, scheduleTarget } from '../shared/navigation'
import { assertIpcSource, createIpcGuard, IpcBoundaryError, type IpcArguments, type IpcChannel } from './ipc-boundary'
import { drainShutdown } from './shutdown'
import { collectionResources } from './resource-budget'
import { MonitorSubscriptions } from './monitor-subscriptions'
import { TrayWindowController } from './tray-window'
import { restoreWindowBounds, WindowGeometry } from './window-geometry'
import { StartupSettingsRecovery } from './startup-recovery'
import type { StartupRecoverySnapshot } from '../shared/startup-recovery'
import { Diagnostics } from './diagnostics'
import { buildDiagnosticReport } from './diagnostic-report'
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
const eventNotifications = new EventNotifications({
  filename: () => path.join(app.getPath('userData'), 'events', 'notifications.json'),
  preferences: () => settings!.value.notifications,
  language: () => resolvedLanguage(settings!.value),
  changed: broadcastSettings,
  taskName: target => {
    const job = monitor.state.schedules.data?.jobs.find(job => job.id === target.id)
    return job && scheduleTarget(job).identity === target.identity ? job.name : null
  },
  adapter: () => createNativeNotificationAdapter({ headless,
    onSleeping: sleeping => eventNotifications.setSleeping(sleeping),
    onNavigate: target => {
      showMainWindow()
      pendingNavigation.put(target)
      window?.webContents.send('monitor:navigation')
    }
  })
})
const monitor: Monitor = new Monitor({ plugins: [createAgentsPlugin(), createSchedulesPlugin(), createSystemPlugin(),
  createEventsPlugin({ databasePath: () => path.join(app.getPath('userData'), 'events', 'events.sqlite'), notifications: eventNotifications, inputs: () => ({
    snapshot: monitor.state,
    enabled: Object.fromEntries(monitor.pluginStatuses().map(plugin => [plugin.section, plugin.enabled])) as PluginSettings
  }) })] })
const subscriptions = new MonitorSubscriptions(headless)
const pendingNavigation = new PendingNavigation()
const desktop = new DesktopSettings(headless, () => eventNotifications.snapshot())
let window: BrowserWindow | null = null
let eventQueryController: AbortController | null = null
function cancelEventQuery(): void {
  eventQueryController?.abort()
  eventQueryController = null
}
const trayPanel = new TrayWindowController({
  create: createTrayWindow,
  load: async target => { secureWindow(target); await target.loadURL(rendererUrl(true)) },
  present: presentTrayWindow,
  report: reportTrayError
})
let tray: Tray | null = null
let trayMenu: Menu | undefined
let settings: SettingsStore | undefined
let geometry: WindowGeometry | undefined
let glassPreview: number | null = null
let recoveryWindow: BrowserWindow | null = null
let closeRecovery: (() => Promise<void>) | undefined
let quitting = false
let quitReady = false
let installationController: AbortController | undefined
let installationWork: Promise<void> | undefined
let diagnosticDialogOwner: BrowserWindow | null = null
const diagnostics = new Diagnostics({
  build: () => buildDiagnosticReport(monitor.state, collectionResources.snapshot(), {
    version: appVersion, electron: process.versions.electron, platform: process.platform,
    arch: process.arch, osRelease: osRelease()
  }, new Date().toISOString()),
  copy: async text => {
    try { await clipboard.writeText(text) }
    catch (error) { throw new DiagnosticError('diagnostic-copy', error, 'OC_DIAGNOSTIC_CLIPBOARD') }
  },
  chooseFile: async signal => {
    const owner = window
    if (headless || quitting || signal.aborted || !owner || owner.isDestroyed())
      throw new DiagnosticError('diagnostic-save', undefined, 'OC_DIAGNOSTIC_UNAVAILABLE')
    const chinese = resolvedLanguage(settings!.value) === 'zh-CN'
    diagnosticDialogOwner = owner
    try {
      const result = await dialog.showSaveDialog(owner, {
        title: chinese ? '保存脱敏诊断' : 'Save redacted diagnostics',
        defaultPath: `OC-Chan-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }], showsTagField: false,
        message: chinese ? '请选择新的文件名；已有文件不会被覆盖。' : 'Choose a new file name; existing files will not be overwritten.',
        properties: ['dontAddToRecent']
      })
      return result.canceled ? null : result.filePath
    } finally { if (diagnosticDialogOwner === owner) diagnosticDialogOwner = null }
  }
})

function cancelWindowDiagnostics(target: BrowserWindow): void {
  // Electron exposes no save-dialog abort API. Destroy its owner only when that document is closing or going away.
  if (diagnosticDialogOwner === target) {
    diagnosticDialogOwner = null
    if (!target.isDestroyed()) target.destroy()
  }
  void diagnostics.cancel().catch(error => console.error(summarizeDiagnostic(error, 'diagnostic-cleanup').details))
}
let exitCode = 0
const rendererFile = path.join(__dirname, '../renderer/index.html')
const devUrl = process.env.ELECTRON_RENDERER_URL
const ternResources = app.isPackaged
  ? path.join(process.resourcesPath, 'tern-navigation')
  : developmentInstance ? path.join(developmentInstance, 'resources/tern-navigation')
    : path.resolve(__dirname, '../../resources/tern-navigation')
const ternNavigation = new TernNavigation(ternResources)

function rendererUrl(popover = false): string {
  const url = devUrl ? new URL(devUrl) : pathToFileURL(rendererFile)
  url.search = popover ? '?view=tray' : ''
  url.hash = ''
  return url.href
}

function fail(error: unknown, stage: DiagnosticStage = 'startup'): void {
  const { details } = summarizeDiagnostic(error, stage)
  console.error(details)
  if (!headless) dialog.showErrorBox('OC Chan · 错误 / Error', details)
  exitCode = 1
  app.quit()
}

if (headless) {
  process.on('uncaughtException', error => fail(error))
  process.on('unhandledRejection', error => fail(error))
}

function secureWindow(target: BrowserWindow, register = true): void {
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  target.webContents.on('will-navigate', (event) => event.preventDefault())
  target.webContents.on('will-attach-webview', (event) => event.preventDefault())
  target.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  target.webContents.session.setPermissionCheckHandler(() => false)
  if (register) subscriptions.register(target)
}

function reportTrayError(error: unknown): void {
  const { details } = summarizeDiagnostic(error, 'tray-load')
  console.error(details)
  if (!headless && !quitting) dialog.showErrorBox('OC Chan · 托盘加载失败 / Tray failed to load',
    `${details}\n请再次点击托盘重试 / Click the tray again to retry`)
}

function showMainWindow(): void {
  if (headless) throw new Error('无头开发模式不允许显示原生窗口 / Native windows are disabled in headless development')
  if (quitting) throw new Error('应用正在退出 / Application is quitting')
  trayPanel.hide()
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
  const placement = restoreWindowBounds(settings!.value.windowBounds, screen.getAllDisplays(), screen.getPrimaryDisplay().id)
  if (placement.adjusted) console.info('[oc-chan] Restoring window within an available display work area')
  const target = new BrowserWindow({
    ...placement.bounds, minWidth: placement.minWidth, minHeight: placement.minHeight,
    title: 'OC Chan', backgroundColor: windowBackground(appearance), transparent: appearance.liquidGlass.available,
    titleBarStyle: 'hiddenInset', show: false,
    focusable: !headless,
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
    try { applyWindowMaterial(target, settingsSnapshot()) } catch (error) { fail(error, 'settings-apply') }
  }
  target.on('blur', cancelGlassPreview)
  target.on('hide', cancelGlassPreview)
  target.webContents.on('did-start-navigation', cancelGlassPreview)
  target.webContents.on('render-process-gone', cancelGlassPreview)
  if (headless) target.webContents.on('render-process-gone', (_event, details) => {
    fail(new Error(`Headless renderer exited: ${details.reason} (${details.exitCode})`))
  })
  geometry = new WindowGeometry(target, screen, settings!, path.resolve(app.getPath('userData'), 'settings.json'), broadcastSettings, error => {
    if (error instanceof SettingsRollbackError) fail(error, 'settings-rollback')
    else console.error(summarizeDiagnostic(error, 'settings-save', 'settings').details)
  })
  secureWindow(target)
  target.once('ready-to-show', () => { if (!quitting && !headless) { target.show(); target.focus() } })
  const cancelNavigation = () => {
    void ternNavigation.cancel().catch(error => console.error(summarizeDiagnostic(error, 'tern-navigation').details))
  }
  target.on('close', (event) => {
    cancelNavigation()
    cancelWindowDiagnostics(target)
    cancelEventQuery()
    if (!quitting && !target.isDestroyed()) { event.preventDefault(); target.hide() }
  })
  target.on('closed', () => { if (window === target) { window = null; glassPreview = null } })
  target.on('closed', () => monitor.cancelScheduleHistory())
  target.webContents.on('render-process-gone', () => monitor.cancelScheduleHistory())
  target.webContents.on('did-start-navigation', () => monitor.cancelScheduleHistory())
  target.on('closed', cancelEventQuery)
  target.webContents.on('render-process-gone', cancelEventQuery)
  target.webContents.on('did-start-navigation', cancelEventQuery)
  target.on('closed', cancelNavigation)
  target.webContents.on('render-process-gone', cancelNavigation)
  target.webContents.on('did-start-navigation', cancelNavigation)
  target.on('closed', () => cancelWindowDiagnostics(target))
  target.webContents.on('render-process-gone', () => cancelWindowDiagnostics(target))
  target.webContents.on('did-start-navigation', () => cancelWindowDiagnostics(target))
  void target.loadURL(rendererUrl()).then(() => {
    if (headless) console.log(`[oc-chan] Headless renderer ready; pid=${process.pid}`)
  }).catch(fail)
}

function presentTrayWindow(target: BrowserWindow): void {
  if (headless || !tray || quitting) return
  const bounds = tray.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const [width, height] = target.getSize()
  const x = Math.max(area.x, Math.min(bounds.x + bounds.width / 2 - width / 2, area.x + area.width - width))
  const below = bounds.y + bounds.height + 6
  const preferredY = below + height <= area.y + area.height ? below : bounds.y - height - 6
  const y = Math.max(area.y, Math.min(preferredY, area.y + area.height - height))
  target.setPosition(Math.round(x), Math.round(y))
  target.show()
  target.focus()
}

function createTrayWindow(): BrowserWindow {
  const appearance = desktop.snapshot(settings!.value)
  const target = new BrowserWindow({
    width: 380, height: 560, show: false, frame: false,
    resizable: false, maximizable: false, minimizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: !headless, focusable: !headless,
    title: 'OC Chan', backgroundColor: windowBackground(appearance), transparent: appearance.liquidGlass.available,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true
    }
  })
  applyWindowMaterial(target, appearance)
  return target
}

function updateMenus(value: AppSettings): void {
  if (headless) { Menu.setApplicationMenu(null); return }
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

function settingsSnapshot(): SettingsSnapshot {
  return desktop.snapshot(settings!.value, geometry?.error ?? null)
}

function broadcastSettings(): void {
  if (!settings || quitting || settings.isUpdating) return
  try {
    const snapshot = settingsSnapshot()
    for (const target of [window, trayPanel.window]) {
      if (target && !target.isDestroyed()) {
        applyWindowMaterial(target, snapshot, target === window ? glassPreview ?? undefined : undefined)
        target.webContents.send('settings:changed', snapshot)
      }
    }
  } catch (error) { fail(error, 'settings-apply') }
}

function recoverStartupSettings(filename: string, error: unknown): Promise<AppSettings | null> {
  if (headless) return Promise.reject(error)
  const recovery = new StartupSettingsRecovery(filename, error)
  const language = app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  const chinese = language === 'zh-CN'
  const recoveryUrl = new URL(rendererUrl())
  recoveryUrl.search = '?view=recovery'
  const target = new BrowserWindow({
    width: 880, height: 640, minWidth: 480, minHeight: 360,
    title: chinese ? 'OC Chan · 设置恢复' : 'OC Chan · Settings recovery', show: false,
    backgroundColor: THEMES['oc-chan'][nativeTheme.shouldUseDarkColors ? 'dark' : 'light'].ground,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  recoveryWindow = target
  secureWindow(target, false)
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'OC Chan', submenu: [{ role: 'quit', label: chinese ? '退出 OC Chan' : 'Quit OC Chan' }] },
    { role: 'editMenu', label: chinese ? '编辑' : 'Edit' },
    { label: chinese ? '显示' : 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }
  ]))
  return new Promise((resolve, reject) => {
    let settled = false
    const channels = ['recovery:snapshot', 'recovery:retry', 'recovery:quit'] as const
    const snapshot = (): StartupRecoverySnapshot => ({ failure: recovery.failure, language })
    const finish = (value: AppSettings | null, failure?: unknown) => {
      if (settled) return
      settled = true
      for (const channel of channels) ipcMain.removeHandler(channel)
      target.removeListener('closed', onClosed)
      if (!target.isDestroyed()) target.destroy()
      if (recoveryWindow === target) recoveryWindow = null
      if (failure) reject(failure)
      else resolve(value)
    }
    const onClosed = () => app.quit()
    closeRecovery = async () => { finish(null); await recovery.close() }
    const handle = (channel: typeof channels[number], action: () => unknown) => {
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        assertIpcSource(event, recoveryWindow, recoveryUrl.href, quitting || settled)
        if (args.length) throw new IpcBoundaryError('arguments')
        return action()
      })
    }
    handle('recovery:snapshot', snapshot)
    handle('recovery:retry', async () => {
      const result = await recovery.retry()
      if (result.kind === 'ready' && !quitting && !settled) {
        await recovery.close()
        finish(result.settings)
        closeRecovery = undefined
        return { ready: true }
      }
      return { ready: false, snapshot: snapshot() }
    })
    handle('recovery:quit', () => { app.quit() })
    target.once('closed', onClosed)
    target.once('ready-to-show', () => { if (!quitting && !settled) { target.show(); target.focus() } })
    void target.loadURL(recoveryUrl.href).catch(async cause => { await recovery.close(); finish(null, cause) })
  })
}

async function applyPlugins(value: PluginSettings): Promise<void> {
  for (const plugin of monitor.pluginStatuses()) {
    const enabled = value[plugin.section]
    if (plugin.enabled === enabled) continue
    try { await monitor.setPluginEnabled(plugin.id, enabled) }
    catch (error) { throw new DiagnosticError('settings-apply', error, undefined, plugin.section) }
  }
}

function activateApplication(): void {
  if (headless || quitting || !app.isReady()) return
  if (recoveryWindow && !recoveryWindow.isDestroyed()) {
    if (recoveryWindow.isMinimized()) recoveryWindow.restore()
    recoveryWindow.show()
    recoveryWindow.focus()
  } else if (settings) showMainWindow()
}

if (!app.requestSingleInstanceLock()) {
  if (headless) app.exit(1)
  else app.quit()
}
else {
  app.on('second-instance', activateApplication)
  app.on('activate', activateApplication)
  // Recovery replaces its window before normal startup finishes; macOS stays resident between windows.
  app.on('window-all-closed', () => { if (headless || process.platform !== 'darwin') app.quit() })
  if (developmentInstance) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => app.quit())
  }
  app.whenReady().then(async () => {
    const filename = path.resolve(app.getPath('userData'), 'settings.json')
    const initial = await readSettings(filename).catch(error => recoverStartupSettings(filename, error))
    if (!initial || quitting) return
    const loginStartup = desktop.loginItems.wasOpenedAtLogin()
    if (headless || loginStartup) { initial.showDock = false; initial.preventSleep = false }
    let appliedSettings = initial
    settings = new SettingsStore(filename, initial, async (value) => {
      const previous = appliedSettings
      appliedSettings = value
      await applyPlugins(value.plugins)
      if (value.appearance !== previous.appearance || value.showDock !== previous.showDock || value.preventSleep !== previous.preventSleep) {
        const visible = window?.isVisible()
        const focused = window?.isFocused()
        await desktop.apply(value)
        if (!headless && visible && window && !window.isDestroyed()) {
          if (focused) { window.show(); window.focus() }
          else window.showInactive()
        }
      }
      if (value.language !== previous.language) updateMenus(value)
      const appearance = desktop.snapshot(value)
      for (const target of [window, trayPanel.window]) {
        if (target && !target.isDestroyed()) applyWindowMaterial(target, appearance)
      }
    })
    await applyPlugins(initial.plugins)
    await desktop.apply(initial)
    updateMenus(initial)
    const protect = createIpcGuard({ mainWindow: () => window, trayWindow: () => trayPanel.window,
      quitting: () => quitting, mainUrl: rendererUrl(), trayUrl: rendererUrl(true), headless })
    const handle = <K extends Exclude<IpcChannel, 'monitor:cancel-schedule-history' | 'monitor:cancel-events' | 'monitor:subscription'>>(
      channel: K, action: (...args: IpcArguments[K]) => unknown
    ) => ipcMain.handle(channel, protect(channel, action))
    handle('settings:snapshot', async () => {
      await settings!.idle()
      return settingsSnapshot()
    })
    handle('settings:preview-glass', intensity => {
      if (!window || window.isDestroyed()) throw new Error('主窗口不可用 / Main window is unavailable')
      if (settings!.isUpdating) throw new Error('设置正在保存 / Settings update is in progress')
      applyWindowMaterial(window, settingsSnapshot(), intensity ?? undefined)
      glassPreview = intensity
    })
    handle('settings:update-login-item', enabled => {
      const result = desktop.loginItems.update(enabled)
      broadcastSettings()
      return result
    })
    handle('settings:request-notification-permission', async () => {
      await settings!.idle()
      if (!settings!.value.notifications.enabled || !settings!.value.plugins.events)
        throw new Error('请先开启本地通知与事件采集 / Enable notifications and event collection first')
      await eventNotifications.requestPermission()
      broadcastSettings()
      return settingsSnapshot().notifications
    })
    handle('settings:update', async (patch): Promise<SettingsUpdateResult> => {
      glassPreview = null
      try {
        await settings!.update(patch)
        await settings!.idle()
      } catch (error) {
        if (error instanceof SettingsRollbackError) {
          fail(error, 'settings-rollback')
          throw new Error(summarizeDiagnostic(error, 'settings-rollback', 'settings').details)
        }
        broadcastSettings()
        return { ok: false, error: settingsUpdateFailure(error, filename) }
      }
      if (patch.notifications || patch.plugins?.events !== undefined || patch.language !== undefined) await eventNotifications.refresh()
      broadcastSettings()
      return { ok: true, snapshot: settingsSnapshot() }
    })
    handle('settings:retry-geometry', async (): Promise<SettingsUpdateResult> => {
      if (!geometry) throw new Error('Window geometry is unavailable')
      const error = await geometry.retry()
      await settings!.idle()
      broadcastSettings()
      return error ? { ok: false, error } : { ok: true, snapshot: settingsSnapshot() }
    })
    handle('settings:show-main-window', (target) => {
      showMainWindow()
      if (target) {
        pendingNavigation.put(target)
        window?.webContents.send('monitor:navigation')
      }
    })
    handle('monitor:navigation', () => pendingNavigation.read())
    handle('monitor:acknowledge-navigation', (sequence) => pendingNavigation.acknowledge(sequence))
    handle('monitor:snapshot', () => monitor.state)
    handle('monitor:refresh', (section) => monitor.refresh(section))
    handle('monitor:retry-source', (sourceId) => monitor.retrySource(sourceId))
    handle('monitor:events', async query => {
      cancelEventQuery()
      const controller = new AbortController()
      eventQueryController = controller
      try { return await monitor.readEvents(query, controller.signal) }
      finally { if (eventQueryController === controller) eventQueryController = null }
    })
    handle('diagnostics:generate', () => diagnostics.generate())
    handle('diagnostics:copy', id => diagnostics.copy(id))
    handle('diagnostics:save', id => diagnostics.save(id))
    handle('diagnostics:cancel', () => diagnostics.cancel())
    handle('monitor:focus-agent-in-tern', async (agentId) => {
      try {
        await ternNavigation.focus(monitor.state.agents.data?.agents ?? [], agentId)
        return { error: null }
      } catch (error) {
        return { error: summarizeDiagnostic(error, 'tern-navigation').details }
      }
    })
    handle('monitor:schedule-history', (jobId, offset = 0) => monitor.readScheduleHistory(jobId, offset))
    const cancelHistory = protect('monitor:cancel-schedule-history', () => monitor.cancelScheduleHistory())
    ipcMain.on('monitor:cancel-schedule-history', (event, ...args: unknown[]) => {
      try { cancelHistory(event, ...args) } catch (error) {
        if (!(error instanceof IpcBoundaryError)) throw error
        console.error('Rejected IPC request', error.category)
      }
    })
    const cancelEvents = protect('monitor:cancel-events', cancelEventQuery)
    ipcMain.on('monitor:cancel-events', (event, ...args: unknown[]) => {
      try { cancelEvents(event, ...args) } catch (error) {
        if (!(error instanceof IpcBoundaryError)) throw error
        console.error('Rejected IPC request', error.category)
      }
    })
    ipcMain.on('monitor:subscription', (event, ...args: unknown[]) => {
      try { protect('monitor:subscription', (updates, sources) => subscriptions.set(event.sender, updates, sources))(event, ...args) }
      catch (error) {
        if (!(error instanceof IpcBoundaryError)) throw error
        console.error('Rejected IPC request', error.category)
      }
    })
    monitor.on('change', (update: MonitorUpdate) => subscriptions.publish('monitor:changed', update))
    monitor.on('sources', (heartbeat: SourceHeartbeat) => subscriptions.publish('monitor:sources', heartbeat))
    nativeTheme.on('updated', broadcastSettings)
    if (!loginStartup) createWindow()
    if (!headless) {
      tray = new Tray(createTrayIcon())
      tray.setToolTip('OC Chan')
      if (process.platform === 'darwin') tray.setIgnoreDoubleClickEvents(true)
      tray.on('click', () => {
        if (quitting || !settings) return
        if (settings.value.trayClick === 'main') { showMainWindow(); return }
        trayPanel.toggle()
      })
      tray.on('right-click', () => { trayPanel.hide(); if (trayMenu) tray?.popUpContextMenu(trayMenu) })
    }
    await monitor.start()
    const installationArguments = process.argv.filter(argument => argument.startsWith('--oc-chan-install-check='))
    if (installationArguments.length) {
      if (installationArguments.length !== 1) throw new Error('Duplicate installation check argument')
      installationController = new AbortController()
      const signal = installationController.signal
      installationWork = import('./installation-check.mjs').then(({ runInstallationCheck, INSTALL_CHECK_ARGUMENT, INSTALLATION_PROBE }) =>
        runInstallationCheck(installationArguments[0].slice(INSTALL_CHECK_ARGUMENT.length), {
          executable: process.execPath, version: appVersion, signal,
          probe: async () => {
            if (!window || window.isDestroyed()) throw new Error('Installation main window is unavailable')
            if (window.webContents.isLoadingMainFrame() || window.webContents.getURL() !== rendererUrl()) return null
            return window.webContents.executeJavaScript(INSTALLATION_PROBE)
          }
        }))
      void installationWork.catch(fail)
    }
  }).catch(fail)
  app.on('before-quit', (event) => {
    if (quitReady) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    installationController?.abort(new Error('Application is quitting'))
    subscriptions.dispose()
    if (diagnosticDialogOwner) cancelWindowDiagnostics(diagnosticDialogOwner)
    void (async () => {
      try {
        await drainShutdown({
          monitor: async () => { await Promise.all([monitor.stop(), installationWork]) },
          navigation: () => ternNavigation.close(),
          diagnostics: () => diagnostics.close(),
          settings: async () => {
            try { await closeRecovery?.(); closeRecovery = undefined; await geometry?.dispose() }
            finally { await settings?.idle() }
          },
          desktop: () => desktop.dispose(),
          tray: async () => { try { await trayPanel.dispose() } finally { tray?.destroy(); tray = null } },
          theme: () => { nativeTheme.removeListener('updated', broadcastSettings) }
        })
        console.info('[oc-chan] Shutdown drained')
      } catch (error) {
        console.error(summarizeDiagnostic(error, 'shutdown').details)
        console.error('[oc-chan] Shutdown remaining', JSON.stringify({ monitor: monitor.diagnostics(), diagnostics: diagnostics.diagnostics(), resources: collectionResources.snapshot().global.current }))
        exitCode = 1
      }
      quitReady = true
      app.exit(exitCode)
    })()
  })
}
