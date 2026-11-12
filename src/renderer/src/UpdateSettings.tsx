import type { UpdatePhase } from '../../shared/updates'
import { bytes } from './components'
import { useI18n } from './i18n'
import { useUpdates } from './updates'
import './updates.css'

export default function UpdateSettings() {
  const { t, language } = useI18n()
  const { snapshot, pending, failure, run, reconnect } = useUpdates()
  const phase = snapshot?.phase
  const busy = pending !== null || phase === 'checking' || phase === 'downloading' || phase === 'installing'
  const unavailable = !snapshot || phase === 'disabled' || Boolean(failure)
  const installUnavailable = unavailable || Boolean(snapshot?.disabledReason)
  const status: Record<UpdatePhase, string> = {
    disabled: t('此应用暂不支持应用内更新。', 'In-app updates are unavailable for this app.'),
    idle: snapshot?.checkedAt
      ? t('最近一次检查未发现新版本。', 'No newer version was found at the last check.')
      : t('尚未检查更新。', 'Updates have not been checked yet.'),
    checking: t('正在检查更新…', 'Checking for updates…'),
    available: snapshot?.disabledReason
      ? t('发现新版本。可前往 GitHub Release 下载并手动安装。', 'A new version is available. Download it from GitHub Releases and install it manually.')
      : t('发现新版本，可手动下载。', 'A new version is available to download.'),
    downloading: t('正在下载更新，可随时取消。', 'Downloading the update. You can cancel the download.'),
    downloaded: t('更新已下载，点击“重启并安装”完成更新。', 'The update is downloaded. Choose Restart and install to apply it.'),
    installing: t('正在退出应用并安装更新…', 'Quitting the app to install the update…'),
    error: t('更新失败。请查看下方错误后重试。', 'The update failed. Review the error below and retry.')
  }
  const disabledReason = snapshot?.disabledReason === 'development'
    ? t('开发模式支持手动检查新版；可前往 GitHub Release 下载，应用内安装不可用。', 'Development builds support manual checks. Download from GitHub Releases; in-app installation is unavailable.')
    : snapshot?.disabledReason === 'unsigned'
      ? t('当前应用未通过正式发布签名检查，可检查新版并前往 GitHub Release 下载；应用内安装不可用。', 'This app has not passed release signature verification. Check for updates and download from GitHub Releases; in-app installation is unavailable.')
      : snapshot?.disabledReason === 'platform'
        ? t('应用内更新目前仅支持 macOS。', 'In-app updates currently support macOS only.')
        : null
  const statusText = failure
    ? failure.action === 'openReleaseNotes'
      ? t('发行说明打开失败，请重试。', 'Release notes could not be opened. Please retry.')
      : t('更新状态无法确认，请重新连接以获取实际状态。', 'The update status is unconfirmed. Reconnect to read the current state.')
    : pending === 'snapshot'
      ? t('正在读取更新状态…', 'Reading update status…')
      : phase ? status[phase] : t('尚未读取更新状态。', 'Update status has not been loaded.')
  const percent = snapshot?.progress ? Math.max(0, Math.min(100, snapshot.progress.percent)) : 0
  return <section className="setting-row update-settings" aria-labelledby="app-updates-title">
    <h2 id="app-updates-title" tabIndex={-1}>{t('应用更新', 'App updates')}</h2>
    <div className="setting-control update-control">
      <dl className="update-versions">
        <div><dt>{t('当前版本', 'Current version')}</dt><dd>{snapshot?.currentVersion ?? t('尚未读取', 'Not loaded')}</dd></div>
        <div><dt>{t('新版本', 'New version')}</dt><dd>{snapshot?.availableVersion ?? t('尚未发现', 'None found yet')}</dd></div>
        <div><dt>{t('最近检查', 'Last checked')}</dt><dd>{snapshot?.checkedAt ? <time dateTime={snapshot.checkedAt}>{new Date(snapshot.checkedAt).toLocaleString(language)}</time> : t('尚未检查', 'Not checked yet')}</dd></div>
      </dl>
      <p className="update-status" role="status" aria-live="polite" aria-atomic="true">{statusText}</p>
      {disabledReason && <p className="setting-help">{disabledReason}</p>}
      {(failure || snapshot?.error) && <p className="update-error">{failure?.details ?? snapshot?.error}</p>}
      {phase === 'downloading' && <div className="update-download" aria-live="off">
        <progress max={100} value={percent} aria-label={t('更新下载进度', 'Update download progress')} />
        <p>{snapshot?.progress
          ? `${percent.toFixed(0)}% · ${bytes(snapshot.progress.transferred)} / ${bytes(snapshot.progress.total)} · ${bytes(snapshot.progress.bytesPerSecond)}/s`
          : t('等待下载进度…', 'Waiting for download progress…')}</p>
      </div>}
      <div className="update-actions">
        {failure && <button type="button" className="button secondary" disabled={pending !== null || (failure.action === 'openReleaseNotes' && busy)} onClick={() => failure.action === 'openReleaseNotes' ? void run('openReleaseNotes') : reconnect()}>{failure.action === 'openReleaseNotes' ? t('重试打开发行说明', 'Retry release notes') : t('重新连接', 'Reconnect')}</button>}
        <button type="button" className="button secondary" disabled={busy || unavailable} onClick={() => void run('check')}>{pending === 'check' || phase === 'checking' ? t('正在检查…', 'Checking…') : t('检查更新', 'Check for updates')}</button>
        {(phase === 'available' || (phase === 'error' && snapshot?.availableVersion)) && <button type="button" className="button primary" disabled={busy || installUnavailable} onClick={() => void run('download')}>{phase === 'error' ? t('重新下载', 'Retry download') : t('下载更新', 'Download update')}</button>}
        {phase === 'downloading' && <button type="button" className="button secondary" disabled={pending !== null && pending !== 'download'} onClick={() => void run('cancel')}>{pending === 'cancel' ? t('正在取消…', 'Cancelling…') : t('取消下载', 'Cancel download')}</button>}
        {phase === 'downloaded' && <button type="button" className="button primary" disabled={busy || installUnavailable} onClick={() => void run('install')}>{t('重启并安装', 'Restart and install')}</button>}
        <button type="button" className="button secondary" disabled={busy} onClick={() => void run('openReleaseNotes')}>{t('发行说明与下载', 'Release notes and downloads')}</button>
      </div>
      <p className="setting-help">{t('可主动检查新版；已签名的正式版本还会在启动后及每 6 小时自动检查。下载和安装由你决定，普通退出不会安装，并会清理下载包；发行说明在默认浏览器打开。', 'You can check for updates manually. Signed release builds also check after launch and every 6 hours. You choose when to download and install. Quitting normally discards the download without installing. Release notes open in your default browser.')}</p>
    </div>
  </section>
}

export function UpdateNotice({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n()
  const { snapshot, failure, pending } = useUpdates()
  if (failure || pending === 'snapshot' || !snapshot || (snapshot.phase !== 'available' && snapshot.phase !== 'downloaded')) return null
  return <div className="update-notice">
    <p role="status" aria-live="polite">{snapshot.phase === 'downloaded'
      ? t(`版本 ${snapshot.availableVersion} 已下载，可重启安装。`, `Version ${snapshot.availableVersion} is downloaded and ready to install.`)
      : t(`发现新版本 ${snapshot.availableVersion}。`, `Version ${snapshot.availableVersion} is available.`)}</p>
    <button type="button" className="button secondary" onClick={onOpen}>{t('查看应用更新', 'View app updates')}</button>
  </div>
}
