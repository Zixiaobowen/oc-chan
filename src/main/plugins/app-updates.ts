import { app, autoUpdater, dialog, ipcMain, net, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { AppPlugin } from '../../shared/plugins'
import type { UpdateSnapshot } from '../../shared/updates'
import { UpdateController } from './update-controller'
import { stageNativeUpdate } from './native-update'
import { RELEASES_URL } from './update-source'
import { IpcBoundaryError } from '../ipc-boundary'

const execute = promisify(execFile)
export interface AppUpdatesHost {
  headless: boolean
  authorize(event: Electron.IpcMainInvokeEvent): void
  changed(snapshot: UpdateSnapshot): void
  beforeInstall(): Promise<void>
}

export class AppUpdatesPlugin implements AppPlugin {
  readonly id = 'app-updates'
  private stopped = false
  private verification = new AbortController()
  private readonly controller: UpdateController
  private readonly channels: string[] = []
  private readonly nativeError = (error: Error) => {
    // Squirrel can emit after a timed-out local transfer has already been closed.
    if (!this.stopped && this.controller.snapshot.phase !== 'installing') this.controller.fail(error)
  }
  constructor(private readonly host: AppUpdatesHost) {
    this.controller = new UpdateController({
      version: app.getVersion(), arch: process.arch,
      directory: path.join(app.getPath('userData'), 'app-updates'),
      fetch: (url, options) => net.fetch(url, options),
      changed: snapshot => host.changed(snapshot),
      install: async (file, asset, signal) => {
        await stageNativeUpdate(autoUpdater, file, asset, signal)
        await host.beforeInstall()
        try { autoUpdater.quitAndInstall() } catch (error) {
          // Services are already stopped; do not leave an inert window after a failed handoff.
          console.error('[app-updates] Native installation handoff failed', error)
          dialog.showErrorBox('OC Chan · 更新安装失败 / Update installation failed', error instanceof Error ? error.message : String(error))
          app.exit(1)
        }
      }
    })
  }

  async start(): Promise<void> {
    this.stopped = false
    this.verification = new AbortController()
    const actions = {
      snapshot: () => this.controller.snapshot,
      check: () => this.controller.check(),
      download: () => this.controller.download(),
      cancel: () => this.controller.cancel(),
      install: () => this.controller.install(),
      'release-notes': () => {
        if (this.host.headless) throw new IpcBoundaryError('headless')
        return shell.openExternal(this.controller.snapshot.availableVersion
          ? `${RELEASES_URL}/tag/v${encodeURIComponent(this.controller.snapshot.availableVersion)}` : RELEASES_URL)
      }
    }
    for (const [name, action] of Object.entries(actions)) {
      const channel = `updates:${name}`
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        this.host.authorize(event)
        if (args.length) throw new IpcBoundaryError('arguments')
        return action()
      })
      this.channels.push(channel)
    }
    try {
      let disabled: UpdateSnapshot['disabledReason'] = !app.isPackaged ? 'development' : process.platform !== 'darwin' ? 'platform' : null
      if (!disabled) {
        try {
          const { stderr } = await execute('/usr/bin/codesign', ['--display', '--verbose=4', path.resolve(process.execPath, '../../..')], { timeout: 5000, maxBuffer: 16 * 1024, signal: this.verification.signal })
          if (!/^Authority=Developer ID Application:/m.test(stderr) || !/^TeamIdentifier=[A-Z0-9]+$/m.test(stderr)) disabled = 'unsigned'
        } catch (error) {
          if (error && typeof error === 'object' && 'stderr' in error && /code object is not signed at all/.test(String(error.stderr))) disabled = 'unsigned'
          else throw error
        }
      }
      if (!this.stopped) {
        if (!disabled) autoUpdater.on('error', this.nativeError)
        this.controller.start(disabled)
      }
    } catch (error) {
      if (!this.stopped) {
        this.controller.start('unsigned')
        this.controller.fail(error)
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.verification.abort()
    autoUpdater.removeListener('error', this.nativeError)
    for (const channel of this.channels.splice(0)) ipcMain.removeHandler(channel)
    await this.controller.stop()
  }
}
