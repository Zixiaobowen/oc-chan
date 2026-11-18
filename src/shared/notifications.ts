import type { LocalEventType } from './events'
import type { NavigationTarget } from './navigation'

export const NOTIFICATION_SOURCE_LIMIT = 64
export const NOTIFICATION_TASK_LIMIT = 24
export type NotificationTask = Extract<NavigationTarget, { kind: 'schedule' }>
export interface NotificationSettings {
  enabled: boolean
  sourceIds: string[]
  tasks: NotificationTask[]
  types: LocalEventType[]
  quiet: { enabled: boolean; startMinute: number; endMinute: number }
  showTaskNames: boolean
}
export const DEFAULT_NOTIFICATIONS: Readonly<NotificationSettings> = {
  enabled: false, sourceIds: [], tasks: [],
  types: ['execution-failed', 'delivery-failed', 'source-unavailable', 'source-recovered'],
  quiet: { enabled: false, startMinute: 22 * 60, endMinute: 8 * 60 }, showTaskNames: false
}
export type NotificationPermission = 'not-determined' | 'denied' | 'authorized' | 'provisional' | 'unsupported' | 'unknown'
export interface NotificationState {
  phase: 'off' | 'events-disabled' | 'starting' | 'ready' | 'quiet' | 'sleeping' | 'permission-required' | 'denied' | 'unavailable' | 'error'
  permission: NotificationPermission
  detail: string | null
  pendingCount: number
  lastSentAt: string | null
  lastOutcome: 'sent' | 'summary' | 'suppressed' | 'cancelled' | 'unconfirmed' | null
}
export const INITIAL_NOTIFICATION_STATE: Readonly<NotificationState> = {
  phase: 'off', permission: 'unknown', detail: null, pendingCount: 0, lastSentAt: null, lastOutcome: null
}
