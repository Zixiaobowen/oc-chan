import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { PermissionSettingsTarget, SettingsPatch } from '../shared/settings'
import type { MonitorSection } from '../shared/types'
import { HISTORY_PAGE_SIZE, MAX_HISTORY_OFFSET, MAX_SCHEDULE_ID_LENGTH, MAX_AGENT_ID_LENGTH, MAX_SOURCE_ID_LENGTH, MAX_HERMES_JOB_ID_LENGTH } from '../shared/types'
import { parseNavigationTarget, type NavigationTarget } from '../shared/navigation'
import { validateSettings } from './settings'
import { parseEventQuery, type EventQuery } from '../shared/events'

export interface IpcArguments {
  'settings:snapshot': []
  'settings:update': [patch: SettingsPatch]
  'settings:preview-glass': [intensity: number | null]
  'settings:retry-geometry': []
  'settings:update-login-item': [enabled: boolean]
  'settings:request-notification-permission': []
  'settings:accessibility-state': []
  'settings:open-permission-settings': [target: PermissionSettingsTarget]
  'settings:show-main-window': [target?: NavigationTarget]
  'monitor:snapshot': []
  'monitor:subscription': [updates: boolean, sources: boolean]
  'monitor:refresh': [section?: MonitorSection]
  'monitor:retry-source': [sourceId: string]
  'monitor:focus-agent-in-tern': [agentId: string]
  'monitor:schedule-history': [jobId: string, offset?: number]
  'monitor:cancel-schedule-history': []
  'monitor:events': [query?: EventQuery]
  'monitor:cancel-events': []
  'monitor:navigation': []
  'monitor:acknowledge-navigation': [sequence: number]
  'diagnostics:generate': []
  'diagnostics:copy': [id: string]
  'diagnostics:save': [id: string]
  'diagnostics:cancel': []
}
export type IpcChannel = keyof IpcArguments
export type IpcEvent = IpcMainEvent | IpcMainInvokeEvent
export interface IpcContext {
  mainWindow(): BrowserWindow | null
  trayWindow(): BrowserWindow | null
  quitting(): boolean
  mainUrl: string
  trayUrl: string
  headless: boolean
}

export interface IpcGuard {
  <K extends IpcChannel, Result>(channel: K, action: (...args: IpcArguments[K]) => Result):
    (event: IpcEvent, ...args: unknown[]) => Result
}

// A request must pass both ownership and its channel's capability before reaching a handler.
const channels: Record<IpcChannel, { mainOnly: boolean; min: number; max: number }> = {
  'settings:snapshot': { mainOnly: false, min: 0, max: 0 },
  'settings:update': { mainOnly: true, min: 1, max: 1 },
  'settings:preview-glass': { mainOnly: true, min: 1, max: 1 },
  'settings:retry-geometry': { mainOnly: true, min: 0, max: 0 },
  'settings:update-login-item': { mainOnly: true, min: 1, max: 1 },
  'settings:request-notification-permission': { mainOnly: true, min: 0, max: 0 },
  'settings:accessibility-state': { mainOnly: true, min: 0, max: 0 },
  'settings:open-permission-settings': { mainOnly: true, min: 1, max: 1 },
  'settings:show-main-window': { mainOnly: false, min: 0, max: 1 },
  'monitor:snapshot': { mainOnly: false, min: 0, max: 0 },
  'monitor:subscription': { mainOnly: false, min: 2, max: 2 },
  'monitor:refresh': { mainOnly: false, min: 0, max: 1 },
  'monitor:retry-source': { mainOnly: true, min: 1, max: 1 },
  'monitor:focus-agent-in-tern': { mainOnly: true, min: 1, max: 1 },
  'monitor:schedule-history': { mainOnly: true, min: 1, max: 2 },
  'monitor:cancel-schedule-history': { mainOnly: true, min: 0, max: 0 },
  'monitor:events': { mainOnly: true, min: 0, max: 1 },
  'monitor:cancel-events': { mainOnly: true, min: 0, max: 0 },
  'monitor:navigation': { mainOnly: true, min: 0, max: 0 },
  'monitor:acknowledge-navigation': { mainOnly: true, min: 1, max: 1 },
  'diagnostics:generate': { mainOnly: true, min: 0, max: 0 },
  'diagnostics:copy': { mainOnly: true, min: 1, max: 1 },
  'diagnostics:save': { mainOnly: true, min: 1, max: 1 },
  'diagnostics:cancel': { mainOnly: true, min: 0, max: 0 }
}

export class IpcBoundaryError extends Error {
  constructor(readonly category: 'source' | 'capability' | 'arguments' | 'headless') {
    super(category === 'source' ? '不允许的窗口来源 / Untrusted window'
      : category === 'capability' ? '此窗口不允许该操作 / Window capability denied'
        : category === 'headless' ? '无头开发模式不允许修改登录项、打开系统设置、显示窗口或切换应用 / Login item changes, System Settings and native activation are disabled in headless development'
          : 'IPC 请求参数无效 / Invalid IPC arguments')
    this.name = 'IpcBoundaryError'
  }
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

function validateArguments(channel: IpcChannel, args: unknown[]): void {
  const value = args[0]
  switch (channel) {
    case 'settings:update':
      try { args[0] = validateSettings(value) } catch { throw new IpcBoundaryError('arguments') }
      if (Object.hasOwn(args[0] as object, 'windowBounds')) throw new IpcBoundaryError('capability')
      break
    case 'settings:preview-glass':
      if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100))
        throw new IpcBoundaryError('arguments')
      break
    case 'settings:update-login-item':
      if (typeof value !== 'boolean') throw new IpcBoundaryError('arguments')
      break
    case 'settings:open-permission-settings':
      if (value !== 'accessibility' && value !== 'notifications') throw new IpcBoundaryError('arguments')
      break
    case 'settings:show-main-window':
      if (value !== undefined) {
        try { args[0] = parseNavigationTarget(value) } catch { throw new IpcBoundaryError('arguments') }
      }
      break
    case 'monitor:subscription':
      if (typeof value !== 'boolean' || typeof args[1] !== 'boolean') throw new IpcBoundaryError('arguments')
      break
    case 'monitor:refresh':
      if (value !== undefined && value !== 'agents' && value !== 'schedules' && value !== 'system' && value !== 'events') throw new IpcBoundaryError('arguments')
      break
    case 'monitor:retry-source':
      if (!text(value, MAX_SOURCE_ID_LENGTH)) throw new IpcBoundaryError('arguments')
      break
    case 'monitor:focus-agent-in-tern':
      if (!text(value, MAX_AGENT_ID_LENGTH)) throw new IpcBoundaryError('arguments')
      break
    case 'monitor:schedule-history': {
      const offset = args[1] === undefined ? 0 : args[1]
      if (!text(value, MAX_SCHEDULE_ID_LENGTH) || !Number.isSafeInteger(offset) || (offset as number) < 0 ||
          (offset as number) > MAX_HISTORY_OFFSET || (offset as number) % HISTORY_PAGE_SIZE !== 0)
        throw new IpcBoundaryError('arguments')
      if (value.startsWith('hermes-job:') && !text(value.slice('hermes-job:'.length), MAX_HERMES_JOB_ID_LENGTH))
        throw new IpcBoundaryError('arguments')
      break
    }
    case 'monitor:events': {
      try { args[0] = parseEventQuery(value) } catch { throw new IpcBoundaryError('arguments') }
      break
    }
    case 'monitor:acknowledge-navigation':
      if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new IpcBoundaryError('arguments')
      break
    case 'diagnostics:copy':
    case 'diagnostics:save':
      if (typeof value !== 'string' || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
        throw new IpcBoundaryError('arguments')
      break
  }
}

export function assertIpcSource(event: IpcEvent, owner: BrowserWindow | null, expectedUrl: string, quitting: boolean): void {
  if (quitting || !owner || owner.isDestroyed() || event.sender.isDestroyed() || owner.webContents !== event.sender)
    throw new IpcBoundaryError('source')
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) throw new IpcBoundaryError('source')
  let url: URL
  try { url = new URL(frame.url) } catch { throw new IpcBoundaryError('source') }
  url.hash = ''
  if (url.href !== expectedUrl) throw new IpcBoundaryError('source')
}

export function createIpcGuard(context: IpcContext): IpcGuard {
  return function protect<K extends IpcChannel, Result>(channel: K, action: (...args: IpcArguments[K]) => Result) {
    return (event: IpcEvent, ...args: unknown[]): Result => {
      if (context.quitting() || event.sender.isDestroyed()) throw new IpcBoundaryError('source')
      const main = context.mainWindow()
      const tray = context.trayWindow()
      const owner = main && !main.isDestroyed() && main.webContents === event.sender ? main
        : tray && !tray.isDestroyed() && tray.webContents === event.sender ? tray : null
      assertIpcSource(event, owner, owner === main ? context.mainUrl : context.trayUrl, context.quitting())
      const rule = Object.hasOwn(channels, channel) ? channels[channel] : undefined
      if (!rule || (rule.mainOnly && owner !== main)) throw new IpcBoundaryError('capability')
      if (args.length < rule.min || args.length > rule.max) throw new IpcBoundaryError('arguments')
      validateArguments(channel, args)
      if (context.headless && (channel === 'settings:show-main-window' || channel === 'monitor:focus-agent-in-tern' || channel === 'settings:update-login-item' || channel === 'settings:open-permission-settings'))
        throw new IpcBoundaryError('headless')
      return action(...args as IpcArguments[K])
    }
  }
}
