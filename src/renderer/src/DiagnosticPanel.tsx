import { useEffect, useId, useRef, useState } from 'react'
import type { MonitorApi } from '../../shared/types'
import {
  DIAGNOSTIC_REPORT_MAX_BYTES, DIAGNOSTIC_REPORT_MAX_DIAGNOSTICS,
  DIAGNOSTIC_REPORT_MAX_RESOURCES, DIAGNOSTIC_REPORT_MAX_SOURCES,
  type DiagnosticFailure, type DiagnosticFailureReason, type DiagnosticPreview, type DiagnosticReportLimit
} from '../../shared/diagnostic-report'
import { SectionHeader } from './components'
import { useI18n } from './i18n'
import './diagnostic-panel.css'

type Operation = 'generate' | 'copy' | 'save' | 'cancel'
type Notice = 'ready' | 'copied' | 'saved' | 'cancelled' | 'closed' | null

const failureCopy: Record<DiagnosticFailureReason, [string, string]> = {
  busy: ['诊断操作仍在进行。请等待完成，或关闭预览后重新生成。', 'A diagnostic operation is still running. Wait for it to finish, or close the preview and generate again.'],
  expired: ['这份预览已失效。请重新生成，再复制或保存。', 'This preview has expired. Generate a new report before copying or saving.'],
  unavailable: ['本机诊断服务不可用。请重新尝试；若仍失败，重新打开应用。', 'The local diagnostic service is unavailable. Try again; if it still fails, reopen the app.'],
  exists: ['目标位置已有文件，未覆盖。请再次保存并选择新的文件名。', 'A file already exists at the destination and was not overwritten. Save again with a different file name.'],
  permission: ['没有保存文件的权限。请再次保存并选择可写的位置。', 'Permission to save the file was denied. Save again to a writable location.'],
  storage: ['存储空间不足，保存未完成。请释放空间或选择其他磁盘后重试。', 'There is not enough storage to finish saving. Free space or choose another disk, then retry.'],
  timeout: ['诊断操作超时。请关闭预览后重试；保存结果请在所选位置核对。', 'The diagnostic operation timed out. Close the preview and retry; check the chosen destination for any saved file.'],
  clipboard: ['无法写入剪贴板。请重试复制，或选择下方 JSON 手动复制。', 'The clipboard could not be written. Retry copying, or select the JSON below and copy it manually.'],
  io: ['文件写入未完成。请检查目标位置后重试，或选择其他位置。', 'The file could not be written completely. Check the destination and retry, or choose another location.'],
  cleanup: ['诊断资源清理失败，不能继续导出。请检查所选位置，完整文件或临时文件可能仍在；处理文件系统问题后重新打开应用。', 'Diagnostic cleanup failed and exports cannot continue. Check the chosen location for a completed or temporary file. Resolve the file-system problem, then reopen the app.'],
  unknown: ['操作结果无法确认。请检查剪贴板或保存位置，再关闭预览并重试。', 'The operation result could not be confirmed. Check the clipboard or save destination, then close the preview and retry.']
}
const limitCopy: Record<DiagnosticReportLimit, [string, string]> = {
  sources: ['来源条目达到上限', 'Source entry limit reached'],
  diagnostics: ['诊断条目达到上限', 'Diagnostic entry limit reached'],
  resources: ['资源条目达到上限', 'Resource entry limit reached'],
  bytes: ['报告字节上限限制了内容', 'The report byte limit restricted content'],
  'invalid-fields': ['无效或不允许的字段已省略', 'Invalid or disallowed fields were omitted']
}
const cleanupFailure: DiagnosticFailure = { status: 'error', reason: 'cleanup', details: 'DIAGNOSTIC_CANCEL_UNCONFIRMED' }
// A remounted panel must wait for the previous panel's cancellation to finish.
let releaseBarrier: Promise<DiagnosticFailure | null> = Promise.resolve(null)
function releaseDiagnostics(api: MonitorApi): Promise<DiagnosticFailure | null> {
  releaseBarrier = releaseBarrier.then(() => api.cancelDiagnostics()).then(() => null, () => cleanupFailure)
  return releaseBarrier
}

export default function DiagnosticPanel() {
  const { t, language } = useI18n()
  const id = useId()
  const [preview, setPreview] = useState<DiagnosticPreview | null>(null)
  const [pending, setPending] = useState<Operation | null>(null)
  const [failure, setFailure] = useState<DiagnosticFailure | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [session, setSession] = useState(false)
  const mounted = useRef(false)
  const revision = useRef(0)
  const operation = useRef<Operation | null>(null)
  const owner = useRef<MonitorApi | null>(null)
  const generateButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    mounted.current = true
    const release = () => {
      revision.current++
      operation.current = null
      const api = owner.current
      owner.current = null
      if (api) void releaseDiagnostics(api)
    }
    window.addEventListener('pagehide', release)
    return () => {
      mounted.current = false
      window.removeEventListener('pagehide', release)
      release()
    }
  }, [])

  function isCurrent(token: number) { return mounted.current && revision.current === token }
  function finish(token: number) {
    if (!isCurrent(token)) return
    operation.current = null
    setPending(null)
  }

  async function generate() {
    if (operation.current) return
    const token = ++revision.current
    operation.current = 'generate'
    setPending('generate')
    setPreview(null)
    setFailure(null)
    setNotice(null)
    setSession(true)
    const api = window.monitor
    if (!api) {
      setFailure({ status: 'error', reason: 'unavailable', details: 'DIAGNOSTIC_BRIDGE_UNAVAILABLE' })
      finish(token)
      return
    }
    owner.current = api
    try {
      const releaseFailure = await releaseBarrier
      if (!isCurrent(token)) return
      if (releaseFailure) {
        setFailure(releaseFailure)
        return
      }
      const result = await api.generateDiagnostics()
      if (!isCurrent(token)) return
      if (result.status === 'ready') {
        setPreview(result.preview)
        setNotice('ready')
      } else if (result.status === 'error') setFailure(result)
      else setNotice('cancelled')
    } catch {
      if (isCurrent(token)) setFailure({ status: 'error', reason: 'unavailable', details: 'DIAGNOSTIC_GENERATE_UNCONFIRMED' })
    } finally { finish(token) }
  }

  async function act(action: 'copy' | 'save') {
    if (operation.current || !preview) return
    const token = ++revision.current
    operation.current = action
    setPending(action)
    setFailure(null)
    setNotice(null)
    const api = owner.current
    try {
      if (!api) {
        setFailure({ status: 'error', reason: 'expired', details: 'DIAGNOSTIC_PREVIEW_UNAVAILABLE' })
        setPreview(null)
        return
      }
      const result = await (action === 'copy' ? api.copyDiagnostics(preview.id) : api.saveDiagnostics(preview.id))
      if (!isCurrent(token)) return
      if (result.status === 'error') {
        setFailure(result)
        if (result.reason === 'expired') setPreview(null)
      } else setNotice(result.status)
    } catch {
      if (isCurrent(token)) setFailure({ status: 'error', reason: 'unknown', details: action === 'copy' ? 'DIAGNOSTIC_COPY_UNCONFIRMED' : 'DIAGNOSTIC_SAVE_UNCONFIRMED' })
    } finally { finish(token) }
  }

  async function close() {
    if (operation.current === 'cancel') return
    const token = ++revision.current
    operation.current = 'cancel'
    setPending('cancel')
    setPreview(null)
    setFailure(null)
    setNotice(null)
    generateButton.current?.focus({ preventScroll: true })
    const api = owner.current ?? window.monitor
    if (!api) {
      setFailure(cleanupFailure)
      finish(token)
      return
    }
    owner.current = api
    const result = await releaseDiagnostics(api)
    if (!isCurrent(token)) return
    if (result) setFailure(result)
    else {
      owner.current = null
      setSession(false)
      setNotice('closed')
    }
    finish(token)
  }

  const status = pending === 'generate' ? t('正在生成本地诊断…', 'Generating local diagnostics…')
    : pending === 'copy' ? t('正在复制…', 'Copying…')
      : pending === 'save' ? t('正在等待保存结果…', 'Waiting for the save result…')
        : pending === 'cancel' ? t('正在取消操作并释放预览…', 'Cancelling the operation and releasing the preview…')
          : notice === 'ready' ? t('预览已生成。请先检查完整 JSON，再复制或保存。', 'The preview is ready. Review the full JSON before copying or saving.')
            : notice === 'copied' ? t('诊断 JSON 已复制到剪贴板。', 'The diagnostic JSON was copied to the clipboard.')
              : notice === 'saved' ? t('诊断 JSON 已保存。', 'The diagnostic JSON was saved.')
                : notice === 'cancelled' ? t('操作已取消。', 'The operation was cancelled.')
                  : notice === 'closed' ? t('预览已关闭并释放。', 'The preview was closed and released.') : ''
  const count = (value: { included: number; total: number | null }) => `${value.included.toLocaleString(language)} / ${value.total === null ? t('总数未知', 'total unknown') : value.total.toLocaleString(language)}`

  return <section className="panel diagnostic-panel" aria-labelledby={`${id}-title`}>
    <div id={`${id}-title`}><SectionHeader title={t('脱敏诊断', 'Redacted diagnostics')} /></div>
    <div className="diagnostic-panel-body">
      <p className="diagnostic-description">{t('点击生成后，仅整理本机应用版本、架构与操作系统、来源能力和状态、受控错误码与时间、预算计数及总数量。不上传，也不自动复制或保存。', 'Generate a local report containing only the app version, architecture and OS, source capabilities and status, controlled error codes and times, budget counts and totals. Nothing is uploaded, copied or saved automatically.')}</p>
      <p className="diagnostic-description">{t('报告不含用户名、路径、UID、标题、正文、命令、环境变量或原始错误输出。关闭预览或离开此页会释放预览并取消在途操作。', 'The report excludes usernames, paths, UIDs, titles, content, commands, environment variables and raw error output. Closing the preview or leaving this page releases it and cancels pending operations.')}</p>
      <div className="diagnostic-actions">
        <button ref={generateButton} type="button" className="button primary" aria-disabled={pending !== null} aria-busy={pending === 'generate'} onClick={() => void generate()}>{preview ? t('重新生成', 'Generate again') : t('生成诊断预览', 'Generate diagnostic preview')}</button>
        {session && <button type="button" className="button secondary" aria-disabled={pending === 'cancel'} aria-busy={pending === 'cancel'} onClick={() => void close()}>{t('关闭预览并取消', 'Close preview and cancel')}</button>}
      </div>
      <p className="diagnostic-status" role="status" aria-live="polite" aria-atomic="true">{status}</p>
      {failure && <div className="diagnostic-error" role="alert">
        <p>{t(...failureCopy[failure.reason])}</p>
        <details><summary>{t('查看安全摘要', 'View safe summary')}</summary><p className="diagnostic-safe-summary">{failure.details}</p></details>
      </div>}
      {preview && <div className="diagnostic-preview">
        <dl className="diagnostic-metadata">
          <div><dt>{t('生成时间', 'Generated at')}</dt><dd><time dateTime={preview.generatedAt}>{new Date(preview.generatedAt).toLocaleString(language)}</time></dd></div>
          <div><dt>{t('报告大小', 'Report size')}</dt><dd>{preview.bytes.toLocaleString(language)} {t('字节', 'bytes')} · {(preview.bytes / 1024).toLocaleString(language, { maximumFractionDigits: 2 })} KiB</dd></div>
          <div><dt>{t('来源覆盖（纳入 / 总数）', 'Sources (included / total)')}</dt><dd>{count(preview.coverage.sources)}</dd></div>
          <div><dt>{t('诊断覆盖（纳入 / 总数）', 'Diagnostics (included / total)')}</dt><dd>{count(preview.coverage.diagnostics)}</dd></div>
          <div><dt>{t('资源覆盖（纳入 / 总数）', 'Resources (included / total)')}</dt><dd>{count(preview.coverage.resources)}</dd></div>
        </dl>
        <p className="diagnostic-budget">{t(`报告预算：${DIAGNOSTIC_REPORT_MAX_BYTES.toLocaleString(language)} 字节（${DIAGNOSTIC_REPORT_MAX_BYTES / 1024} KiB）；最多 ${DIAGNOSTIC_REPORT_MAX_SOURCES} 个来源、${DIAGNOSTIC_REPORT_MAX_DIAGNOSTICS} 条诊断、${DIAGNOSTIC_REPORT_MAX_RESOURCES} 项资源。`, `Report budget: ${DIAGNOSTIC_REPORT_MAX_BYTES.toLocaleString(language)} bytes (${DIAGNOSTIC_REPORT_MAX_BYTES / 1024} KiB); at most ${DIAGNOSTIC_REPORT_MAX_SOURCES} sources, ${DIAGNOSTIC_REPORT_MAX_DIAGNOSTICS} diagnostics and ${DIAGNOSTIC_REPORT_MAX_RESOURCES} resources.`)}</p>
        <div className="diagnostic-limits">
          <p>{preview.limits.length ? t('报告限制：以下内容已省略或受限，请结合覆盖数量查看。', 'Report limits: content was omitted or restricted as listed below. Check the coverage counts.') : t('报告限制：未触发报告上限或无效字段限制。来源本身的覆盖限制仍见 JSON。', 'Report limits: no report budget or invalid-field limits were triggered. Source-level coverage limitations remain in the JSON.')}</p>
          {preview.limits.length > 0 && <ul>{preview.limits.map(limit => <li key={limit}>{t(...limitCopy[limit])}</li>)}</ul>}
        </div>
        <label className="diagnostic-json-label" htmlFor={`${id}-json`}>{t('完整报告 JSON（只读）', 'Full report JSON (read-only)')}</label>
        <p id={`${id}-json-help`} className="diagnostic-description">{t('这是复制与保存的完整内容。可选择文本，按 ⌘A 全选、⌘C 复制；保存时由你选择本地位置。', 'This is the complete content used for copying and saving. Select text, use ⌘A to select all and ⌘C to copy; choose a local destination when saving.')}</p>
        <textarea id={`${id}-json`} aria-describedby={`${id}-json-help`} readOnly value={preview.json} rows={12} wrap="soft" spellCheck={false} />
        <div className="diagnostic-actions">
          <button type="button" className="button secondary" aria-disabled={pending !== null} aria-busy={pending === 'copy'} onClick={() => void act('copy')}>{t('复制 JSON', 'Copy JSON')}</button>
          <button type="button" className="button secondary" aria-disabled={pending !== null} aria-busy={pending === 'save'} onClick={() => void act('save')}>{t('保存 JSON…', 'Save JSON…')}</button>
        </div>
      </div>}
    </div>
  </section>
}
