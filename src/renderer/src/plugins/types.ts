import type { ComponentProps, ComponentType } from 'react'
import type { MonitorSection, MonitorSnapshot, SourceHeartbeat, SourceStatus } from '../../../shared/types'
import type { AppPage, NavigationTarget } from '../../../shared/navigation'
import type { AppSettings } from '../../../shared/settings'
import type AgentsView from '../AgentsView'
import type SchedulesView from '../SchedulesView'
import type EventsView from '../EventsView'

export interface RendererContext {
  snapshot: MonitorSnapshot
  plugins: AppSettings['plugins']
  paused: boolean
  visible: boolean
  navigate: (page: AppPage) => void
  openTarget: (target: NavigationTarget) => void
  agents?: ComponentProps<typeof AgentsView>
  schedules?: ComponentProps<typeof SchedulesView>
  events?: ComponentProps<typeof EventsView>
}
export interface SourceContributionProps {
  sources: SourceStatus[]
  observations?: SourceHeartbeat['sources']
  enabled: boolean
}
export interface TrayContribution {
  id: string
  label: readonly [string, string]
  sections: readonly MonitorSection[]
  Component: ComponentType<RendererContext>
}
export interface RendererContribution {
  id: string
  section: MonitorSection
  /** Existing views keep their retained-snapshot behavior when collection is disabled. */
  retainWhenDisabled?: boolean
  Page?: ComponentType<RendererContext>
  Summary?: ComponentType<RendererContext>
  Overview?: ComponentType<RendererContext>
  OverviewAfter?: ComponentType<RendererContext>
  Footer?: ComponentType<RendererContext>
  TrayHeading?: ComponentType<RendererContext>
  TrayFooter?: ComponentType<RendererContext>
  Source?: ComponentType<SourceContributionProps>
  tray?: readonly TrayContribution[]
}
export interface RendererPluginModule {
  default: RendererContribution
}
