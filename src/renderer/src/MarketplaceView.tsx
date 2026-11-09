import { useEffect, useRef, useState } from 'react'
import ArrowDown from 'kubai-icons-react/icons/arrow-down'
import Server from 'kubai-icons-react/icons/server'
import Sync from 'kubai-icons-react/icons/sync'
import Search from 'kubai-icons-react/icons/search'
import CircleX from 'kubai-icons-react/icons/circle-x'
import type { MarketplaceAction, MarketplaceItem } from '../../shared/marketplace'
import { bytes, time } from './components'
import { useI18n } from './i18n'
import { useMarketplace } from './marketplace'
import './marketplace.css'

export interface MarketplaceViewState { search: string; filter: 'all' | 'installed' | 'updates' }

function PluginRow({ item }: { item: MarketplaceItem }) {
  const { t, language } = useI18n()
  const { snapshot, pending, failure, run, cancel, retry } = useMarketplace()
  const [confirming, setConfirming] = useState(false)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const uninstallButton = useRef<HTMLButtonElement>(null)
  const row = useRef<HTMLElement>(null)
  const previousInstalled = useRef({ installed: item.installed, version: item.installedVersion })
  const operation = snapshot?.operation?.id === item.manifest.id ? snapshot.operation : null
  const localRequest = pending && 'id' in pending && pending.id === item.manifest.id ? pending : null
  const localFailure = failure?.request.id === item.manifest.id ? failure : null
  const operationFailure = snapshot?.error?.id === item.manifest.id ? snapshot.error : null
  const error = localFailure?.message ?? operationFailure?.message ?? item.error
  const busy = Boolean(pending || snapshot?.operation || snapshot?.checking)
  const name = language === 'zh-CN' ? item.manifest.name : item.manifest.nameEn
  const description = language === 'zh-CN' ? item.manifest.description : item.manifest.descriptionEn
  useEffect(() => {
    if (confirming) confirmButton.current?.focus()
  }, [confirming])
  useEffect(() => {
    if (previousInstalled.current.installed !== item.installed || previousInstalled.current.version !== item.installedVersion) {
      if (!item.installed) setConfirming(false)
      if (row.current?.contains(document.activeElement) || document.activeElement === document.body) {
        const target = row.current?.querySelector<HTMLElement>(item.installed ? 'h2' : '[data-install]')
        target?.focus({ preventScroll: true })
      }
    }
    previousInstalled.current = { installed: item.installed, version: item.installedVersion }
  }, [item.installed, item.installedVersion])
  function dismiss() { setConfirming(false); uninstallButton.current?.focus({ preventScroll: true }) }
  function perform(action: MarketplaceAction) { if (!busy) void run(action, item.manifest.id) }
  const phase = operation ? {
    downloading: t('正在下载', 'Downloading'), verifying: t('正在校验', 'Verifying'), activating: t('正在启用', 'Activating'), removing: t('正在卸载', 'Uninstalling')
  }[operation.phase] : t('正在处理', 'Working')
  return <article ref={row} className="market-row" data-plugin-id={item.manifest.id} aria-labelledby={`plugin-${item.manifest.id}`}>
    <Server trigger="none" className="market-plugin-icon" size={26} aria-hidden="true" />
    <div className="market-plugin-content">
      <div className="market-title"><h2 tabIndex={-1} id={`plugin-${item.manifest.id}`}>{name}</h2><span className="market-state" role="status">{item.installed ? item.error ? t('安装异常', 'Installation error') : item.updateAvailable ? t('可更新', 'Update available') : t('已安装', 'Installed') : t('未安装', 'Not installed')}</span></div>
      <p>{description}</p>
      <dl className="market-metadata">
        <div><dt>{t('发布者', 'Publisher')}</dt><dd>{item.manifest.publisher}</dd></div>
        <div><dt>{t('可用版本', 'Available version')}</dt><dd><code>{item.manifest.version}</code></dd></div>
        {item.installed && <div><dt>{t('已安装版本', 'Installed version')}</dt><dd>{item.installedVersion ? <code>{item.installedVersion}</code> : t('无法读取', 'Unreadable')}</dd></div>}
        <div><dt>{t('来源', 'Source')}</dt><dd>{item.source === 'bundled' ? t('应用附带', 'Bundled with app') : item.source === 'online' ? t('官方在线目录', 'Official online catalog') : t('本机已安装', 'Installed locally')}</dd></div>
        {item.installed && <div><dt>{t('采集偏好', 'Collection preference')}</dt><dd>{item.enabled ? t('已开启', 'Enabled') : t('已停用', 'Disabled')}</dd></div>}
      </dl>
      <details className="market-capabilities"><summary>{t('能力与运行要求', 'Capabilities and requirements')}</summary>
        <p>{t('最低应用版本', 'Minimum app version')} <code>{item.manifest.minAppVersion}</code> · {item.manifest.platforms.join(', ')}</p>
        <ul>{item.manifest.permissions.map(permission => <li key={permission}>{permission}</li>)}</ul>
        <p>{t('官方插件在本机执行代码；安装仅添加此插件声明的采集能力。', 'Official plugins execute code locally. Installation adds the collection capabilities declared here.')}</p>
      </details>
      <div className="market-actions">
        {!item.installed && <button data-install data-plugin-action="install" className="button primary" aria-disabled={busy} onClick={() => perform('install')}><ArrowDown trigger="none" size={15} aria-hidden="true" />{t('安装', 'Install')}</button>}
        {item.updateAvailable && item.installed && <button data-plugin-action="update" className="button primary" aria-disabled={busy} onClick={() => perform('update')}><ArrowDown trigger="none" size={15} aria-hidden="true" />{t('更新', 'Update')}</button>}
        {item.installed && <button ref={uninstallButton} data-plugin-action="uninstall" className="button secondary" aria-disabled={busy} aria-expanded={confirming} onClick={() => { if (!busy) setConfirming(value => !value) }}><CircleX trigger="none" size={15} aria-hidden="true" />{t('卸载', 'Uninstall')}</button>}
      </div>
      {confirming && item.installed && <div className="market-confirm" role="group" aria-label={t('确认卸载', 'Confirm uninstall')} onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); dismiss() } }}>
        <p>{t(`卸载“${name}”会停止采集并清除当前系统数据。采集偏好仍会保留，之后可重新安装。`, `Uninstalling “${name}” stops collection and clears current system data. Collection preferences are retained for reinstallation.`)}</p>
        <div className="market-actions"><button ref={confirmButton} data-plugin-action="confirm-uninstall" className="button secondary market-destructive" aria-disabled={busy} onClick={() => perform('uninstall')}>{t('确认卸载', 'Confirm uninstall')}</button><button data-plugin-action="cancel-uninstall" className="button secondary" aria-disabled={busy} onClick={() => { if (!busy) dismiss() }}>{t('保留插件', 'Keep plugin')}</button></div>
      </div>}
      {(operation || localRequest) && <div className="market-progress" role="status"><span>{phase}{operation?.phase === 'downloading' && operation.totalBytes > 0 ? ` · ${bytes(operation.receivedBytes)} / ${bytes(operation.totalBytes)}` : ''}</span>
        {operation?.phase === 'downloading' && operation.totalBytes > 0 && <progress aria-label={t('下载进度', 'Download progress')} max={operation.totalBytes} value={operation.receivedBytes} />}
        <button data-plugin-action="cancel" className="button secondary" disabled={pending?.action === 'cancel'} onClick={() => void cancel()}>{pending?.action === 'cancel' ? t('正在取消', 'Cancelling') : t('取消操作', 'Cancel operation')}</button>
      </div>}
      {error && <div className="market-error" role="alert"><p>{error}</p>
        <div className="market-actions">{(localFailure || operationFailure) && <button className="button secondary" aria-disabled={busy} onClick={() => {
          if (busy) return
          const action = localFailure?.request.action ?? operationFailure?.action
          if (action === 'uninstall') { setConfirming(true); confirmButton.current?.focus() }
          else if (localFailure) void retry()
          else if (operationFailure) void run(operationFailure.action, item.manifest.id)
        }}>{t('重试操作', 'Retry operation')}</button>}
        {item.error && !localFailure && !operationFailure && <span>{t('请按诊断处理后重试；必要时重新启动应用。', 'Follow the diagnostic before retrying; restart the app if required.')}</span>}</div>
      </div>}
    </div>
  </article>
}

export default function MarketplaceView({ view, onViewChange }: { view: MarketplaceViewState; onViewChange: (value: MarketplaceViewState) => void }) {
  const { t, language } = useI18n()
  const { snapshot, loading, pending, failure, check, refresh, retry, cancel } = useMarketplace()
  const searchInput = useRef<HTMLInputElement>(null)
  const previousIds = useRef<string[]>([])
  const busy = Boolean(pending || snapshot?.operation || snapshot?.checking)
  const search = view.search.trim().toLocaleLowerCase()
  const items = snapshot?.items.filter(item => (view.filter === 'all' || (view.filter === 'installed' ? item.installed : item.updateAvailable)) && (!search || `${item.manifest.name} ${item.manifest.nameEn} ${item.manifest.description} ${item.manifest.descriptionEn} ${item.manifest.publisher} ${item.manifest.id} ${item.manifest.permissions.join(' ')}`.toLocaleLowerCase().includes(search))) ?? []
  const generalFailure = failure && !failure.request.id ? failure : null
  const hiddenFailure = failure?.request.id && !items.some(item => item.manifest.id === failure.request.id)
  useEffect(() => {
    const ids = items.map(item => item.manifest.id)
    if (document.activeElement === document.body && previousIds.current.some(id => !ids.includes(id))) searchInput.current?.focus({ preventScroll: true })
    previousIds.current = ids
  }, [items])
  function clear() { onViewChange({ search: '', filter: 'all' }); searchInput.current?.focus() }
  return <div className="marketplace">
    <div className="market-toolbar">
      <label className="market-search"><span>{t('搜索插件', 'Search plugins')}</span><div><Search trigger="none" size={16} aria-hidden="true" /><input ref={searchInput} type="search" value={view.search} maxLength={256} placeholder={t('名称、发布者或能力', 'Name, publisher or capability')} onChange={event => onViewChange({ ...view, search: event.target.value })} /></div></label>
      <button data-marketplace-action="check" className="button secondary" aria-disabled={busy} onClick={() => { if (!busy) void check() }}><Sync trigger="none" size={15} aria-hidden="true" />{snapshot?.checking || pending?.action === 'check' ? t('正在检查', 'Checking') : t('检查在线更新', 'Check online updates')}</button>
    </div>
    <div className="market-filters" role="group" aria-label={t('插件筛选', 'Filter plugins')}>{([
      ['all', t('全部', 'All')], ['installed', t('已安装', 'Installed')], ['updates', t('可更新', 'Updates')]
    ] as const).map(([filter, label]) => <button className="button secondary" key={filter} aria-pressed={view.filter === filter} onClick={() => onViewChange({ ...view, filter })}>{label}</button>)}</div>
    <p className="market-note">{t('应用附带的官方插件可离线安装；在线检查会连接官方 GitHub 目录。', 'Bundled official plugins can be installed offline. Online checks connect to the official GitHub catalog.')}{snapshot?.checkedAt && <> {t('上次检查', 'Last checked')} {time(snapshot.checkedAt, language)}</>}</p>
    {(generalFailure || snapshot?.catalogError) && <div className="market-error" role="alert"><p>{generalFailure?.message ?? snapshot?.catalogError}</p><button className="button secondary" aria-disabled={busy} onClick={() => { if (!busy) void (generalFailure ? retry() : check()) }}>{t('重试', 'Retry')}</button></div>}
    {(snapshot?.checking || pending?.action === 'check') && <div className="market-progress" role="status"><span>{t('正在读取官方在线目录', 'Reading the official online catalog')}</span><button className="button secondary" disabled={pending?.action === 'cancel'} onClick={() => void cancel()}>{t('取消检查', 'Cancel check')}</button></div>}
    {snapshot === null ? <div className="panel market-empty" aria-busy={loading}><p>{loading ? t('正在读取插件市场', 'Loading plugin marketplace') : t('无法读取插件市场', 'Could not load plugin marketplace')}</p>{!loading && !generalFailure && <button className="button secondary" onClick={() => void refresh()}>{t('重试读取', 'Retry loading')}</button>}</div> : <>
      <div className="market-results"><span role="status">{t(`${items.length} 个插件`, `${items.length} plugins`)}</span>{(view.search || view.filter !== 'all') && <button className="text-button" onClick={clear}>{t('清除筛选', 'Clear filters')}</button>}</div>
      {snapshot.operation && !items.some(item => item.manifest.id === snapshot.operation?.id) && <div className="market-progress" role="status"><p>{t(`插件 ${snapshot.operation.id} 正在处理。`, `Plugin ${snapshot.operation.id} is being processed.`)}</p><button className="button secondary" onClick={clear}>{t('显示插件', 'Show plugin')}</button><button className="button secondary" disabled={pending?.action === 'cancel'} onClick={() => void cancel()}>{t('取消操作', 'Cancel operation')}</button></div>}
      {(hiddenFailure || (snapshot.error && !items.some(item => item.manifest.id === snapshot.error?.id))) && <div className="market-error" role="alert"><p>{hiddenFailure ? failure?.message : snapshot.error?.message}</p><button className="button secondary" onClick={clear}>{t('显示插件并重试', 'Show plugin to retry')}</button></div>}
      <div className="panel market-list">{items.map(item => <PluginRow key={item.manifest.id} item={item} />)}{items.length === 0 && <div className="market-empty"><Server trigger="none" size={26} aria-hidden="true" /><h2>{view.filter === 'updates' && !search ? snapshot.catalogError ? t('在线更新状态未确认', 'Online update status is unconfirmed') : t('当前目录没有可用更新', 'No updates in the current catalog') : t('没有匹配的插件', 'No matching plugins')}</h2><p>{t('调整搜索或筛选；检查在线更新可读取最新官方目录。', 'Adjust your search or filters. Check online updates to read the latest official catalog.')}</p></div>}</div>
    </>}
  </div>
}
