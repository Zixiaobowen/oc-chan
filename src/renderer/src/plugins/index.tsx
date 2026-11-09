import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { builtinPlugins } from '../../../shared/plugin-catalog'
import type { PluginSettings } from '../../../shared/settings'
import { Empty } from '../components'
import { useI18n } from '../i18n'
import { RendererRegistry, type RendererEntry } from './registry'
import type { RendererContext, RendererContribution, RendererPluginModule } from './types'
import ContributionBoundary from './ContributionBoundary'

const verticalModules = import.meta.glob<RendererPluginModule>('../../../plugins/*/renderer/index.tsx')
const builtinModules = import.meta.glob<RendererPluginModule>('./builtin/*.tsx')
const entries: RendererEntry[] = builtinPlugins.map(plugin => {
  const builtin = builtinModules[`./builtin/${plugin.entry}.tsx`]
  const load = builtin ?? verticalModules[`../../../plugins/${plugin.entry}/renderer/index.tsx`]
  return { id: plugin.id, section: plugin.section, retainWhenDisabled: Boolean(builtin),
    load: load ?? (() => Promise.reject(new Error(`Missing renderer plugin: ${plugin.id}`))) }
})
export function useRendererPlugins(enabled: PluginSettings) {
  const [registry] = useState(() => new RendererRegistry(entries))
  const state = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const focused = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const rememberFocus = (event: FocusEvent) => { if (event.target instanceof HTMLElement) focused.current = event.target }
    document.addEventListener('focusin', rememberFocus)
    return () => document.removeEventListener('focusin', rememberFocus)
  }, [])
  useLayoutEffect(() => {
    if (focused.current && !focused.current.isConnected) {
      document.querySelector<HTMLElement>('.page-heading h1, .tray-customize > summary')?.focus({ preventScroll: true })
    }
  }, [enabled])
  useEffect(() => { registry.reconcile(enabled) }, [registry, enabled, state.errors])
  useEffect(() => () => registry.dispose(), [registry])
  const contributions = state.contributions.filter(plugin => enabled[plugin.section] || plugin.retainWhenDisabled)
  return { contributions, errors: state.errors, retry: () => registry.retry() }
}
export type RendererSlot = 'Summary' | 'Overview' | 'OverviewAfter' | 'Device' | 'Footer' | 'TrayHeading' | 'TrayFooter'
export function PluginSlot({ contributions, slot, context }: {
  contributions: readonly RendererContribution[]; slot: RendererSlot; context: RendererContext
}) {
  return <>{contributions.map(plugin => {
    const Component = plugin[slot]
    return Component ? <ContributionBoundary key={plugin.id}><Component {...context} /></ContributionBoundary> : null
  })}</>
}
export function PluginPage({ contribution, enabled, error, context, retry }: {
  contribution?: RendererContribution; enabled: boolean; error?: string; context: RendererContext; retry: () => void
}) {
  const { t } = useI18n()
  const Page = contribution?.Page
  if (Page) return <ContributionBoundary key={contribution?.id}><Page {...context} /></ContributionBoundary>
  return <div className="panel"><Empty title={!enabled ? t('插件已停用', 'Plugin disabled') : error ? t('插件加载失败', 'Plugin failed to load') : t('正在加载插件', 'Loading plugin')}>
    {error || (!enabled ? t('在数据来源中重新开启即可恢复此页面。', 'Enable collection in Data sources to restore this page.') : t('正在装配页面。', 'Preparing this page.'))}
    {!enabled ? <><br /><button className="text-button" onClick={() => context.navigate('sources')}>{t('打开数据来源', 'Open Data sources')}</button></> : error ? <><br /><button className="text-button" onClick={retry}>{t('重试', 'Retry')}</button></> : null}
  </Empty></div>
}
export type { RendererContext, RendererContribution } from './types'
