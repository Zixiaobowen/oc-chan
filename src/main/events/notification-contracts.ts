import type { LocalEvent } from '../../shared/events'
import type { NavigationTarget } from '../../shared/navigation'
import type { NotificationPermission, NotificationSettings, NotificationState, NotificationTask } from '../../shared/notifications'
import type { ResolvedLanguage } from '../../shared/settings'

/** Only newly committed rows, in increasing sequence order; identity changes when the event database is replaced. */
export interface NotificationBatch {
  identity: string
  events: { sequence: number; event: LocalEvent }[]
}
export interface NativeNotificationMessage {
  id: string
  title: string
  body: string
  target: NavigationTarget
}
export interface NativeNotificationAdapter {
  permission(request: boolean, signal: AbortSignal): Promise<NotificationPermission>
  show(message: NativeNotificationMessage, signal: AbortSignal): Promise<void>
  close(): Promise<void>
}
export interface EventNotificationOptions {
  filename: () => string
  preferences: () => NotificationSettings
  language: () => ResolvedLanguage
  adapter: () => NativeNotificationAdapter
  taskName: (target: NotificationTask) => string | null
  changed: () => void
  now?: () => Date
}
/** Registered and owned by the events plugin; failures are observable without failing event collection. */
export interface EventNotificationService {
  start(signal: AbortSignal): Promise<void>
  committed(batch: NotificationBatch): Promise<void>
  refresh(): Promise<void>
  requestPermission(): Promise<void>
  setSleeping(sleeping: boolean): void
  snapshot(): NotificationState
  stop(): Promise<void>
}
