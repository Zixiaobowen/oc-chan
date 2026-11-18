import { useEffect, useState } from 'react'
import ChevronRight from 'kubai-icons-react/icons/chevron-right'
import Puzzle from 'kubai-icons-react/icons/puzzle'
import type { AppPage } from '../../shared/navigation'
import type { PluginMetadata } from '../../shared/plugin-catalog'
import { useI18n } from './i18n'

export default function PluginNavigation({ plugins, page, loading, failed, navigate }: {
  plugins: readonly PluginMetadata[]
  page: AppPage
  loading: boolean
  failed: boolean
  navigate: (page: AppPage) => void
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(true)
  const active = plugins.some(plugin => plugin.page.id === page)
  useEffect(() => { if (active) setExpanded(true) }, [page, active])

  return <div className="plugin-navigation" role="group" aria-labelledby="plugin-navigation-title">
    <div className="plugin-navigation-heading">
      <button id="plugin-navigation-title" className={`nav-item${page === 'plugins' ? ' selected' : ''}${active ? ' has-current' : ''}`}
        aria-current={page === 'plugins' ? 'page' : undefined} onClick={() => navigate('plugins')}>
        <Puzzle trigger="none" size={18} aria-hidden="true" /><span>{t('插件', 'Plugins')}</span>
      </button>
      <button id="plugin-navigation-toggle" className="plugin-navigation-toggle" type="button"
        aria-label={expanded ? t('收起已安装插件', 'Collapse installed plugins') : t('展开已安装插件', 'Expand installed plugins')}
        title={expanded ? t('收起已安装插件', 'Collapse installed plugins') : t('展开已安装插件', 'Expand installed plugins')}
        aria-expanded={expanded} aria-controls="installed-plugin-navigation" onClick={() => setExpanded(value => !value)}>
        <ChevronRight className="plugin-navigation-chevron" trigger="none" size={14} aria-hidden="true" />
      </button>
    </div>
    <div id="installed-plugin-navigation" hidden={!expanded}>
      {plugins.length ? <ul className="plugin-navigation-list">{plugins.map(plugin => <li key={plugin.id}>
        <button className={`nav-item${page === plugin.page.id ? ' selected' : ''}`} data-plugin-page={plugin.id}
          aria-current={page === plugin.page.id ? 'page' : undefined} onClick={() => navigate(plugin.page.id)}>
          <span>{t(...plugin.page.label)}</span>
        </button>
      </li>)}</ul> : <p className="plugin-navigation-empty">{failed
        ? t('插件状态读取失败，请点击“插件”重试。', 'Could not load plugins. Open Plugins to retry.')
        : loading ? t('正在读取插件…', 'Loading plugins…') : t('暂无已安装插件', 'No installed plugins')}</p>}
    </div>
  </div>
}
