import { useEffect, useId, useRef, useState } from 'react'
import type { SettingsFailureReason, SettingsUpdateFailure } from '../../shared/settings'
import { summarizeDiagnostic } from '../../shared/diagnostics'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import './settings-error.css'

type RecoveryCopy = { reason: string; steps: string[] }

type Failure = SettingsUpdateFailure | { reason: 'connection'; details: string }

function SettingsFailureNotice({ settingLabel, failure, saving, retry, retained }: {
  settingLabel: string; failure: Failure; saving: boolean; retry: () => Promise<void>; retained?: string
}) {
  const { t } = useI18n()
  const id = useId()
  const messages: Record<SettingsFailureReason | 'connection', RecoveryCopy> = {
    'permission-denied': {
      reason: t('系统拒绝了对设置路径的访问。', 'The system denied access to the settings path.'),
      steps: [
        t('在访达中检查下方路径及其上级文件夹的“显示简介 → 共享与权限”，确认当前账户可以读写。', 'In Finder, inspect the path below and its parent folders under Get Info → Sharing & Permissions. Confirm that your account can read and write.'),
        t('若路径由管理员管理，请让管理员恢复所需访问权限，再重试这项修改。', 'If an administrator manages this path, ask them to restore the required access, then retry this change.')
      ]
    },
    'storage-full': {
      reason: t('存储空间或可用配额不足，无法写入设置。', 'There is not enough storage space or available quota to write the settings.'),
      steps: [
        t('检查下方路径所在磁盘的可用空间和账户配额。移动不再需要留在此磁盘的文件，或请管理员调整配额。', 'Check free space and your account quota on the disk containing the path below. Move files you no longer need on this disk, or ask an administrator to adjust the quota.'),
        t('确认有可用空间后，重试这项修改。', 'Once space is available, retry this change.')
      ]
    },
    'read-only': {
      reason: t('设置路径所在的文件系统为只读，无法写入。', 'The file system containing the settings path is read-only.'),
      steps: [
        t('检查下方路径所在磁盘或挂载位置的读写状态；如由管理员管理，请联系管理员。', 'Check whether the disk or mounted location containing the path below allows writes. Contact its administrator if it is managed.'),
        t('恢复该位置的写入能力后，重试这项修改。', 'Restore write access to that location, then retry this change.')
      ]
    },
    'path-conflict': {
      reason: t('设置路径存在同名目录或文件与目录结构冲突。', 'The settings path has a conflicting directory name or file and folder structure.'),
      steps: [
        t('检查下方完整路径及其上级路径：设置文件的位置应是文件，上级路径应是文件夹。', 'Inspect the full path below and its parent paths: the settings file location must be a file, and its parent paths must be folders.'),
        t('先保留冲突位置的已有内容，再将其移到安全位置或重命名。不要直接删除。', 'Preserve any existing content at the conflicting location, then move it somewhere safe or rename it. Do not delete it directly.'),
        t('确认路径结构正确后，重试这项修改。应用不会自动删除已有内容。', 'Once the path structure is correct, retry this change. The app does not automatically delete existing content.')
      ]
    },
    'path-unavailable': {
      reason: t('设置路径或其上级路径当前不可用。', 'The settings path or one of its parent paths is currently unavailable.'),
      steps: [
        t('在访达中检查下方路径及其上级位置是否存在、可以访问；若位于外接磁盘或挂载位置，检查其连接状态。', 'In Finder, check that the path below and its parent locations exist and are accessible. If they are on an external disk or mounted location, check its connection.'),
        t('恢复原路径的可用状态后，重试这项修改。', 'Restore access to the original path, then retry this change.')
      ]
    },
    timeout: {
      reason: t('保存设置的操作超时，本次修改未保存。', 'Saving settings timed out. This change was not saved.'),
      steps: [
        t('检查设置路径所在磁盘或挂载位置是否响应。', 'Check that the disk or mounted location containing the settings path is responding.'),
        t('恢复响应后，重试这项修改。', 'Once it responds, retry this change.')
      ]
    },
    unknown: {
      reason: t('保存失败，但现有诊断无法确定原因。', 'Saving failed, but the available diagnostics do not identify the cause.'),
      steps: [
        t('展开诊断摘要，检查下方设置路径。请勿在原因不明时删除设置文件或修改权限。', 'Expand the diagnostic summary and inspect the settings path below. Avoid deleting settings files or changing permissions without understanding the cause.'),
        t('可以重试这项修改；若仍失败，请保留诊断摘要并联系应用维护者。', 'You can retry this change. If it still fails, keep the diagnostic summary and contact the app maintainer.')
      ]
    },
    connection: {
      reason: t('未收到设置服务的保存确认，无法判断这次修改是否已保存。', 'No save confirmation was received from the settings service, so the outcome of this change is unknown.'),
      steps: [
        t('界面保留最近收到的实际设置，可能尚未反映这次修改。重试会再次提交相同的设置值。', 'The controls retain the most recently received settings and may not yet reflect this change. Retrying submits the same setting values again.'),
        t('先重试这项修改；若仍无法确认，请保留诊断摘要，重新打开应用后检查设置，必要时联系应用维护者。', 'Retry this change first. If the outcome remains unconfirmed, keep the diagnostic summary, reopen the app and check the settings. Contact the app maintainer if needed.')
      ]
    }
  }
  const copy = messages[failure.reason]
  return <section className="settings-save-error" aria-labelledby={`${id}-title`}>
    <div role="alert" aria-atomic="true">
      <h3 id={`${id}-title`}>{failure.reason === 'connection'
        ? t(`“${settingLabel}”的保存结果未确认`, `Save outcome unconfirmed for ${settingLabel}`)
        : t(`“${settingLabel}”未能保存`, `Could not save ${settingLabel}`)}</h3>
      <p>{copy.reason}</p>
    </div>
    {failure.reason !== 'connection' && <p>{retained ?? t('这次修改未保存，界面仍显示当前实际设置。可以保留本次修改并重试，或重新选择设置值。', 'This change was not saved. The controls still show the current settings. You can retry this change or choose a setting value again.')}</p>}
    {'filePath' in failure && <p className="settings-save-error-path"><strong>{t('设置文件路径', 'Settings file path')}</strong><code>{failure.filePath}</code></p>}
    <ol>{copy.steps.map(step => <li key={step}>{step}</li>)}</ol>
    <button type="button" className="settings-save-error-retry" aria-disabled={saving} onClick={() => { if (!saving) void retry() }}>
      {saving ? t('正在重试…', 'Retrying…') : t('重试这项修改', 'Retry this change')}
    </button>
    <SettingsDiagnosticDetails details={failure.details} />
  </section>
}

export function SettingsDiagnosticDetails({ details }: { details: string }) {
  const { t } = useI18n()
  const id = useId()
  return <details className="settings-save-error-details">
    <summary>{t('查看诊断摘要', 'View diagnostic summary')}</summary>
    <label htmlFor={`${id}-diagnostics`}>{t('脱敏诊断（只读）', 'Redacted diagnostics (read-only)')}</label>
    <p id={`${id}-copy-help`}>{t('仅含错误类型、错误代码和失败阶段，省略原始正文与私人路径；超限会标记截断。选择文字后按 ⌘C 复制，按 ⌘A 全选。', 'Includes only error types, codes and failure stages. Original content and private paths are omitted; limits are marked. Select text and press ⌘C to copy, or ⌘A to select all.')}</p>
    <textarea id={`${id}-diagnostics`} readOnly value={details} rows={6} wrap="soft" spellCheck={false} aria-describedby={`${id}-copy-help`} />
  </details>
}

export default function SettingsSaveError({ settingLabel }: { settingLabel: string }) {
  const { error, saving, retry } = useSettings()
  return error ? <SettingsFailureNotice settingLabel={settingLabel} failure={error.failure} saving={saving} retry={retry} /> : null
}

export function GeometrySaveErrors() {
  const { snapshot, error } = useSettings()
  const { t } = useI18n()
  const [saving, setSaving] = useState(false)
  const [connection, setConnection] = useState<Failure | null>(null)
  const pending = useRef(false)
  useEffect(() => { setConnection(null) }, [snapshot])
  async function retry() {
    if (pending.current) return
    pending.current = true
    setSaving(true)
    const trigger = document.activeElement
    try {
      if (!window.desktopSettings) throw new Error('Desktop settings are unavailable')
      const result = await window.desktopSettings.retryGeometry()
      setConnection(result.ok ? null : result.error)
      if (result.ok && (document.activeElement === trigger || (!trigger?.isConnected && document.activeElement === document.body)))
        document.querySelector<HTMLElement>('.sidebar-resize-handle')?.focus({ preventScroll: true })
    } catch (cause) {
      setConnection({ reason: 'connection', details: summarizeDiagnostic(cause, 'settings-connection', 'settings').details })
    } finally {
      pending.current = false
      setSaving(false)
    }
  }
  const failure = connection ?? snapshot.geometryError
  return <>
    {(error?.patch.sidebarWidth !== undefined || error?.patch.sidebarCollapsed !== undefined) && <SettingsSaveError settingLabel={t('侧栏布局', 'Sidebar layout')} />}
    {failure && <SettingsFailureNotice settingLabel={t('窗口尺寸和位置', 'Window size and position')}
      failure={failure} saving={saving} retry={retry}
      retained={t('窗口保持当前尺寸和位置，但这次调整尚未保存。重试会保存当前正常窗口的位置。', 'The window keeps its current size and position, but this adjustment has not been saved. Retrying saves the current normal window bounds.')} />}
  </>
}
