import type { UpdatePhase } from '../../shared/updates'
import { useI18n } from './i18n'
import { useUpdates } from './updates'
import './updates.css'

export default function UpdateSettings() {
  const { t, language } = useI18n()
  const { snapshot, pending, failure, run, reconnect } = useUpdates()
  const phase = snapshot?.phase
  const busy = pending !== null
  const unavailable = !snapshot || Boolean(failure)
  const status: Record<UpdatePhase, string> = {
    idle: t('尚未检查更新。', 'Updates have not been checked yet.'),
    checking: t('正在检查更新…', 'Checking for updates…'),
    'no-update': t('当前已是最新版本。', 'You are up to date.'),
    available: t('发现新版本。', 'A new version is available.'),
    downloading: t('原生更新窗口正在下载更新。', 'The native updater is downloading the update.'),
    downloaded: t('更新已下载，请在原生更新窗口中继续。', 'The update is downloaded. Continue in the native updater.'),
    extracting: t('正在解压更新…', 'Extracting the update…'),
    'ready-to-install': t('更新准备就绪，请在原生更新窗口中确认安装。', 'The update is ready. Confirm installation in the native updater.'),
    installing: t('正在安装更新…', 'Installing the update…'),
    'awaiting-quit': t('更新正在等待应用退出。', 'The update is waiting for the app to quit.'),
    cancelled: t('更新已取消。', 'The update was cancelled.'),
    error: t('更新失败，请查看错误后重试。', 'The update failed. Review the error and retry.')
  }
  const statusText = failure
    ? failure.action === 'openReleaseNotes'
      ? t('发行说明打开失败，请重试。', 'Release notes could not be opened. Please retry.')
      : t('更新状态无法确认，请重新连接以获取实际状态。', 'The update status is unconfirmed. Reconnect to read the current state.')
    : pending === 'snapshot'
      ? t('正在读取更新状态…', 'Reading update status…')
      : phase ? status[phase] : t('尚未读取更新状态。', 'Update status has not been loaded.')
  return <section className="setting-row update-settings" aria-labelledby="app-updates-title">
    <h2 id="app-updates-title" tabIndex={-1}>{t('应用更新', 'App updates')}</h2>
    <div className="setting-control update-control">
      <dl className="update-versions">
        <div><dt>{t('当前版本', 'Current version')}</dt><dd>{snapshot?.currentVersion ?? t('尚未读取', 'Not loaded')}</dd></div>
        <div><dt>{t('新版本', 'New version')}</dt><dd>{snapshot?.availableVersion ?? t('尚未发现', 'None found yet')}</dd></div>
        <div><dt>{t('最近检查', 'Last checked')}</dt><dd>{snapshot?.checkedAt ? <time dateTime={snapshot.checkedAt}>{new Date(snapshot.checkedAt).toLocaleString(language)}</time> : t('尚未检查', 'Not checked yet')}</dd></div>
      </dl>
      <p className="update-status" role="status" aria-live="polite" aria-atomic="true">{statusText}</p>
      {snapshot?.probeOnly && <p className="setting-help">{t('当前构建仅检查新版；可通过发行说明下载正式版本。', 'This build only checks for updates. Download a release from the release notes.')}</p>}
      {(failure || snapshot?.error) && <p className="update-error">{failure?.details ?? snapshot?.error}</p>}
      <div className="update-actions">
        {failure && <button type="button" className="button secondary" disabled={pending !== null || (failure.action === 'openReleaseNotes' && busy)} onClick={() => failure.action === 'openReleaseNotes' ? void run('openReleaseNotes') : reconnect()}>{failure.action === 'openReleaseNotes' ? t('重试打开发行说明', 'Retry release notes') : t('重新连接', 'Reconnect')}</button>}
        <button type="button" className="button secondary" disabled={busy || unavailable || !snapshot?.canCheck} onClick={() => void run('check')}>{pending === 'check' || phase === 'checking' ? t('正在检查…', 'Checking…') : t('检查更新', 'Check for updates')}</button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void run('openReleaseNotes')}>{t('发行说明与下载', 'Release notes and downloads')}</button>
      </div>
      <label className="setting-help"><input type="checkbox" checked={snapshot?.automaticChecks ?? false} disabled={busy || unavailable || snapshot?.probeOnly} onChange={event => void run('setAutomaticChecks', event.currentTarget.checked)} />{t('自动检查更新', 'Automatically check for updates')}</label>
      <p className="setting-help">{t('下载、取消和安装由原生更新窗口管理；发行说明在默认浏览器打开。', 'Downloads, cancellation and installation are managed by the native updater. Release notes open in your default browser.')}</p>
    </div>
  </section>
}

export function UpdateNotice({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n()
  const { snapshot, failure, pending } = useUpdates()
  if (failure || pending === 'snapshot' || !snapshot || (snapshot.phase !== 'available' && snapshot.phase !== 'downloaded')) return null
  return <div className="update-notice">
    <p role="status" aria-live="polite">{snapshot.phase === 'downloaded'
      ? t(`版本 ${snapshot.availableVersion} 已下载，请在原生更新窗口中继续。`, `Version ${snapshot.availableVersion} is downloaded. Continue in the native updater.`)
      : t(`发现新版本 ${snapshot.availableVersion}。`, `Version ${snapshot.availableVersion} is available.`)}</p>
    <button type="button" className="button secondary" onClick={onOpen}>{t('查看应用更新', 'View app updates')}</button>
  </div>
}
