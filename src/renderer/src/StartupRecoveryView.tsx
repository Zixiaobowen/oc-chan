import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { StartupFailureReason, StartupRecoverySnapshot } from '../../shared/startup-recovery'
import { summarizeDiagnostic } from '../../shared/diagnostics'
import { THEMES } from '../../shared/themes'
import { LanguageProvider } from './i18n'
import { SettingsDiagnosticDetails } from './SettingsSaveError'
import './startup-recovery.css'

export default function StartupRecoveryView() {
  const [snapshot, setSnapshot] = useState<StartupRecoverySnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [connection, setConnection] = useState<string | null>(null)
  const [retried, setRetried] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(false)
  const language = snapshot?.language ?? (navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en')
  const t = (zh: string, en: string) => language === 'zh-CN' ? zh : en
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const appearance = media.matches ? 'dark' : 'light'
      document.documentElement.dataset.theme = appearance
      document.documentElement.dataset.palette = 'oc-chan'
      for (const [name, value] of Object.entries(THEMES['oc-chan'][appearance])) document.documentElement.style.setProperty(`--${name}`, value)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])
  useEffect(() => {
    document.documentElement.lang = language
    document.title = language === 'zh-CN' ? 'OC Chan · 设置恢复' : 'OC Chan · Settings recovery'
  }, [language])
  useEffect(() => {
    mounted.current = true
    let active = true
    const api = window.startupRecovery
    if (!api) setConnection(summarizeDiagnostic(new Error(), 'settings-connection', 'settings').details)
    else void api.snapshot().then(value => { if (active) setSnapshot(value) }, error => {
      if (active) setConnection(summarizeDiagnostic(error, 'settings-connection', 'settings').details)
    })
    return () => { active = false; mounted.current = false }
  }, [])
  async function retry() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setConnection(null)
    try {
      if (!window.startupRecovery) throw new Error('Recovery service unavailable')
      const result = await window.startupRecovery.retry()
      if (mounted.current && !result.ready) { setSnapshot(result.snapshot); setRetried(true) }
    } catch (error) {
      if (mounted.current) setConnection(summarizeDiagnostic(error, 'settings-connection', 'settings').details)
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function quit() {
    try {
      if (!window.startupRecovery) throw new Error('Recovery service unavailable')
      await window.startupRecovery.quit()
    } catch (error) {
      if (mounted.current) setConnection(summarizeDiagnostic(error, 'settings-connection', 'settings').details)
    }
  }
  const reasons: Record<StartupFailureReason, { reason: string; step: string }> = {
    'invalid-json': {
      reason: t('设置文件不是有效的 JSON。', 'The settings file is not valid JSON.'),
      step: t('先在原位置以外备份文件，再用文本编辑器修复 JSON 语法，或恢复一份已知有效的设置备份。', 'Back up the file outside its original location, then repair its JSON syntax in a text editor or restore a known valid settings backup.')
    },
    'invalid-values': {
      reason: t('设置包含未知字段、无效选项或不符合要求的数值。', 'The settings contain unknown fields, invalid options or out-of-range values.'),
      step: t('先备份文件，再按 README 的“设置文件”说明修正字段和值，或恢复已知有效的备份；应用不会转换旧值。', 'Back up the file, then correct its fields and values using the Settings file section in README, or restore a known valid backup. The app does not convert old values.')
    },
    'invalid-encoding': {
      reason: t('设置文件不是有效的 UTF-8 文本。', 'The settings file is not valid UTF-8 text.'),
      step: t('先备份文件，再用文本编辑器检查其内容与编码，以 UTF-8 保存有效 JSON。', 'Back up the file, then inspect its content and encoding in a text editor and save valid JSON as UTF-8.')
    },
    'too-large': {
      reason: t('设置文件超过 64 KiB 的读取上限。', 'The settings file exceeds the 64 KiB read limit.'),
      step: t('先备份文件，再检查是否误写了日志或其它内容；保留有效设置字段，使整个 UTF-8 文件不超过 64 KiB。', 'Back up the file and check for logs or unrelated content. Keep valid settings fields within the 64 KiB limit for the entire UTF-8 file.')
    },
    'permission-denied': {
      reason: t('系统拒绝读取设置文件。', 'The system denied access to read the settings file.'),
      step: t('在访达中检查下方路径及上级文件夹的“显示简介 → 共享与权限”，确认当前账户可以读取；受管理的位置请联系管理员。', 'In Finder, inspect the path below and its parent folders under Get Info → Sharing & Permissions. Confirm your account has read access, or contact the administrator of a managed location.')
    },
    'unsafe-path': {
      reason: t('设置路径不是可安全读取的普通文件。', 'The settings path is not a safely readable regular file.'),
      step: t('检查下方路径及上级文件夹。先保留已有内容，再将设置恢复为实际的普通文件；不使用目录、符号链接或管道。', 'Inspect the path below and its parent folders. Preserve existing content, then restore settings as an actual regular file, not a directory, symbolic link or pipe.')
    },
    changed: {
      reason: t('设置文件在读取期间发生了变化。', 'The settings file changed while it was being read.'),
      step: t('等待编辑器或同步工具完成写入，再重新读取。', 'Wait for the editor or synchronization tool to finish writing, then read the file again.')
    },
    unknown: {
      reason: t('读取失败，现有诊断无法确定原因。', 'Reading failed, and the available diagnostics do not identify the cause.'),
      step: t('展开诊断摘要并检查设置路径。原因不明时不要删除文件或修改权限；保留摘要供排查。', 'Expand the diagnostic summary and inspect the settings path. Avoid deleting files or changing permissions without knowing the cause. Keep the summary for investigation.')
    }
  }
  const copy = snapshot ? reasons[snapshot.failure.reason] : null
  return <LanguageProvider language={language}><main className="startup-recovery" aria-labelledby="recovery-title">
    <div className="startup-recovery-content">
      <h1 id="recovery-title">{t('无法读取设置', 'Settings could not be read')}</h1>
      <p className="startup-recovery-intro">{t('OC Chan 已暂停启动。设置文件保持原样，数据采集尚未启动。', 'OC Chan startup is paused. Your settings file is unchanged and data collection has not started.')}</p>
      {copy && <section aria-labelledby="recovery-reason">
        <h2 id="recovery-reason">{copy.reason}</h2>
        <p className="settings-save-error-path"><strong>{t('设置文件路径', 'Settings file path')}</strong><code>{snapshot!.failure.filePath}</code></p>
        <ol><li>{copy.step}</li><li>{t('完成修复并保存后，点击“重新读取”。只有文件通过校验，应用才会继续启动。', 'After repairing and saving the file, choose Read again. The app resumes only after the file passes validation.')}</li></ol>
      </section>}
      <p role="status" aria-live="polite">{busy ? t('正在重新读取设置…', 'Reading settings again…') : retried ? t('仍无法读取，请按当前说明继续修复。', 'Settings still cannot be read. Continue with the current instructions.') : !snapshot && !connection ? t('正在读取诊断…', 'Loading diagnostics…') : ''}</p>
      {connection && <p role="alert">{t('无法确认恢复服务的状态。可以重新读取，或从应用菜单退出。', 'The recovery service status could not be confirmed. Read again, or quit from the app menu.')}</p>}
      <div className="startup-recovery-actions">
        <button type="button" className="button primary" aria-disabled={busy} onClick={() => void retry()}>{t('重新读取', 'Read again')}</button>
        <button type="button" className="button secondary" onClick={() => void quit()}>{t('退出 OC Chan', 'Quit OC Chan')}</button>
      </div>
      {(connection || snapshot) && <SettingsDiagnosticDetails details={connection ?? snapshot!.failure.details} />}
    </div>
  </main></LanguageProvider>
}
