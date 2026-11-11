import { useState } from 'react'
import Server from 'kubai-icons-react/icons/server'
import { useI18n } from './i18n'
import { useSystemPlugin } from './marketplace'
import './marketplace.css'

export default function SystemPluginNotice({ onOpen }: { onOpen?: () => void }) {
  const { t } = useI18n()
  const { installed, item, failure, loading, refresh } = useSystemPlugin()
  const [error, setError] = useState<string | null>(null)
  async function open() {
    if (onOpen) { onOpen(); return }
    try {
      if (!window.desktopSettings) throw new Error(t('桌面连接不可用。', 'The desktop connection is unavailable.'))
      await window.desktopSettings.showMainWindow({ kind: 'page', page: 'plugins' })
      setError(null)
    } catch (cause) { setError(String(cause)) }
  }
  if (installed && !item?.error) return null
  return <div className="plugin-required">
    <Server trigger="none" size={22} aria-hidden="true" />
    <div><strong>{item?.error ? t('系统监控插件需要检查', 'System monitor needs attention') : installed === null ? failure && !loading ? t('插件状态读取失败', 'Could not read plugin status') : t('正在读取插件状态', 'Loading plugin status') : t('系统监控尚未安装', 'System monitor is not installed')}</strong>
      <p>{item?.error ? t('请打开“插件”查看诊断并处理安装状态。', 'Open Plugins to inspect diagnostics and manage this installation.') : installed === null ? t('确认安装状态后显示系统数据。', 'System data appears after the installation state is known.') : t('从“插件”安装后，即可采集 CPU、内存、磁盘与网络。', 'Install from Plugins to collect CPU, memory, disk and network metrics.')}</p>
      {item?.error && <p className="market-error" role="alert">{item.error}</p>}
      {installed === null && failure && <p className="market-error" role="alert">{failure.message}</p>}
      {error && <p className="market-error" role="alert">{error}</p>}
      <div className="market-actions">{installed === null && failure && <button className="button secondary" disabled={loading} onClick={() => void refresh()}>{t('重试读取', 'Retry loading')}</button>}
        <button className="button secondary" onClick={() => void open()}>{t('打开插件', 'Open Plugins')}</button></div>
    </div>
  </div>
}
