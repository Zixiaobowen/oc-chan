export const DIAGNOSTIC_MAX_DEPTH = 8
export const DIAGNOSTIC_MAX_ENTRIES = 16
export const DIAGNOSTIC_MAX_BYTES = 16 * 1024

const stages = {
  startup: '应用启动 / Startup', shutdown: '应用退出 / Shutdown',
  'tray-load': '加载托盘面板 / Load tray panel',
  'tern-navigation': '跳转到 Tern / Navigate to Tern',
  'settings-open': '打开设置 / Open settings', 'settings-stat': '核对设置文件 / Inspect settings file',
  'settings-read': '读取设置 / Read settings', 'settings-close': '关闭设置文件 / Close settings file',
  'settings-decode': '解析设置 / Parse settings', 'settings-validate': '校验设置 / Validate settings',
  'settings-directory': '准备设置目录 / Prepare settings directory',
  'settings-write': '写入设置 / Write settings', 'settings-sync': '同步设置到磁盘 / Sync settings',
  'settings-rename': '替换设置文件 / Replace settings file', 'settings-cleanup': '清理临时文件 / Clean temporary file',
  'settings-apply': '应用桌面设置 / Apply desktop settings', 'settings-save': '保存设置 / Save settings',
  'settings-rollback': '恢复原设置 / Roll back settings', 'settings-connection': '等待保存确认 / Await save confirmation',
  'login-item-read': '读取系统登录项 / Read system login item',
  'login-item-update': '修改系统登录项 / Update system login item',
  'login-item-rollback': '还原系统登录项 / Restore system login item',
  'diagnostic-generate': '生成脱敏诊断 / Generate redacted diagnostics',
  'diagnostic-copy': '复制脱敏诊断 / Copy redacted diagnostics',
  'diagnostic-save': '保存脱敏诊断 / Save redacted diagnostics',
  'diagnostic-cleanup': '清理诊断资源 / Release diagnostic resources'
} as const
export type DiagnosticStage = keyof typeof stages
const codes = {
  EACCES: '拒绝访问 / Access denied', EPERM: '操作未获许可 / Operation not permitted',
  ENOSPC: '存储空间不足 / Storage full', EDQUOT: '存储配额不足 / Quota exceeded',
  EROFS: '只读文件系统 / Read-only filesystem', EISDIR: '路径是目录 / Path is a directory',
  ENOTDIR: '路径包含非目录项 / Path component is not a directory', EEXIST: '路径已存在 / Path exists',
  ENOENT: '路径不存在 / Path unavailable', ELOOP: '拒绝符号链接或链接循环 / Symlink refused or link loop',
  EIO: '输入输出失败 / I/O failure', EBADF: '文件描述符不可用 / File descriptor unavailable',
  EMFILE: '文件描述符耗尽 / File descriptor limit', ENFILE: '系统文件表已满 / System file limit',
  ETIMEDOUT: '操作超时 / Operation timed out', ABORT_ERR: '操作已取消 / Operation aborted',
  ERR_FILE_NOT_FOUND: '界面文件不存在 / Renderer file not found', ERR_FAILED: '界面加载失败 / Renderer load failed',
  ERR_CONNECTION_REFUSED: '开发页面连接被拒绝 / Development page connection refused',
  ERR_ABORTED: '界面加载已取消 / Renderer load cancelled', ERR_TIMED_OUT: '界面加载超时 / Renderer load timed out',
  ERR_CHILD_PROCESS_STDIO_MAXBUFFER: '子进程输出超限 / Child output limit',
  OC_SETTINGS_TOO_LARGE: '设置超过64KiB / Settings exceed 64KiB',
  OC_SETTINGS_NOT_REGULAR: '设置必须是普通文件 / Settings must be a regular file',
  OC_SETTINGS_CHANGED: '读取期间文件发生变化 / File changed during read',
  OC_RESOURCE_CLOSE: '资源关闭失败 / Resource cleanup failed',
  OC_SHUTDOWN_TIMEOUT: '退出排空超时 / Shutdown drain timed out',
  OC_SETTINGS_INVALID: '设置格式或字段无效 / Invalid settings format or fields',
  OC_SETTINGS_ENCODING_INVALID: '设置不是有效UTF-8 / Settings are not valid UTF-8',
  OC_SETTINGS_BUSY: '设置更新已达在途上限，请等待当前操作完成 / Settings update limit reached; wait for pending changes',
  OC_PLUGIN_DEFINITION: '插件声明无效 / Invalid plugin declaration',
  OC_PLUGIN_DEPENDENCY: '插件依赖不可用 / Plugin dependency unavailable',
  OC_PLUGIN_UNKNOWN: '未注册的采集插件 / Unknown collection plugin',
  OC_PLUGIN_DISABLED: '采集插件已停用 / Collection plugin disabled',
  OC_PLUGIN_BUSY: '插件启停尚未完成 / Plugin transition in progress',
  OC_PLUGIN_CLOSED: '采集插件已关闭 / Collection plugin closed',
  OC_PLUGIN_CAPABILITY: '插件未提供此能力 / Plugin capability unavailable',
  OC_LOGIN_UNAVAILABLE: '当前应用不能注册登录项 / Login registration is unavailable for this app',
  OC_LOGIN_INVALID_STATUS: '系统登录项状态无效 / Invalid system login item status',
  OC_LOGIN_NOT_APPLIED: '系统未应用登录项修改 / System did not apply login item change',
  OC_LOGIN_ROLLBACK_FAILED: '系统登录项未还原 / System login item was not restored',
  OC_TRAY_CLOSED: '托盘面板在加载期间关闭 / Tray closed during load',
  OC_TRAY_RENDERER_GONE: '托盘渲染进程退出 / Tray renderer exited',
  OC_TERN_UNAVAILABLE: '未找到正在运行的 Tern，请先打开 Tern / Open Tern before navigating',
  OC_TERN_IDENTITY: 'Tern 的进程、路径或签名身份不一致 / Tern process, path or signature identity mismatch',
  OC_TERN_AMBIGUOUS: '存在多个 Tern 候选，无法确定目标 / Multiple Tern candidates; target is ambiguous',
  OC_TERN_TARGET: '目标参数无效或会话已变更，请刷新后重试 / Invalid or stale target; refresh and retry',
  OC_TERN_PROTOCOL: 'Tern 返回的数据格式无效 / Invalid Tern response',
  OC_TERN_RESOURCES: '随包导航资源缺失或不符，请重新构建或安装 OC Chan / Bundled navigation resources invalid; rebuild or reinstall OC Chan',
  OC_TERN_PLUGIN: 'Tern 导航插件未就绪，请在 Tern 中检查插件状态 / Tern navigation plugin is not ready; check its status in Tern',
  OC_TERN_BUSY: '上一次跳转尚未结束 / A navigation is still in progress',
  OC_TERN_CLOSED: '导航服务已关闭 / Navigation service is closed',
  OC_TERN_TIMEOUT: '跳转超过总时限，请检查 Tern 后重试 / Navigation deadline exceeded; check Tern and retry',
  OC_TERN_COMMAND: 'Tern 导航命令执行失败 / Tern navigation command failed',
  OC_TERN_ACCESSIBILITY: '请在系统设置 → 隐私与安全性 → 辅助功能中允许 OC Chan，然后重试 / Allow OC Chan in System Settings → Privacy & Security → Accessibility, then retry',
  OC_TERN_ACTIVATION: '未能将已核验的 Tern 应用切到前台 / Could not activate the verified Tern application',
  OC_TERN_WINDOW: '未确认对应的 Tern 窗口显示并获得焦点 / Could not confirm the target Tern window is visible and focused',
  OC_DIAGNOSTIC_BUSY: '诊断操作尚未结束 / A diagnostic operation is still in progress',
  OC_DIAGNOSTIC_EXPIRED: '诊断预览已释放或过期，请重新生成 / Preview released or expired; generate it again',
  OC_DIAGNOSTIC_UNAVAILABLE: '诊断操作当前不可用 / Diagnostic operation is unavailable',
  OC_DIAGNOSTIC_LIMIT: '诊断超出单份256KiB上限 / Diagnostic report exceeds 256KiB',
  OC_DIAGNOSTIC_CLIPBOARD: '系统未确认复制成功 / The system did not confirm the copy',
  OC_DIAGNOSTIC_CLEANUP: '诊断资源清理失败，保存结果可能已存在 / Diagnostic cleanup failed; a completed export may already exist'
} as const
export type DiagnosticCode = keyof typeof codes
const resources = ['monitor', 'agents', 'schedules', 'system', 'events', 'history', 'navigation', 'settings', 'desktop', 'tray', 'theme', 'file', 'command', 'socket', 'watcher', 'diagnostics'] as const
export type DiagnosticResource = typeof resources[number]
export class DiagnosticError extends Error {
  constructor(readonly stage: DiagnosticStage, cause?: unknown, readonly code?: DiagnosticCode, readonly resource?: DiagnosticResource) {
    super(stages[stage], { cause })
    this.name = 'DiagnosticError'
  }
}
export type DiagnosticLimit = 'depth' | 'entries' | 'bytes' | 'cycle-or-repeat' | 'uninspectable'
export interface DiagnosticSummary {
  details: string
  primaryCode?: DiagnosticCode
  truncated: boolean
  limits: DiagnosticLimit[]
  entries: number
}
const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AggregateError', 'AbortError', 'TimeoutError', 'DiagnosticError', 'SettingsRollbackError'])
const syscalls = new Set(['open', 'read', 'write', 'stat', 'fstat', 'fsync', 'rename', 'unlink', 'close', 'mkdir'])
const signals = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGABRT'])
const encoder = new TextEncoder()

/** Only bounded, enumerated metadata is shareable. Never read message, stack, stderr, path, or custom toString. */
export function summarizeDiagnostic(error: unknown, stage: DiagnosticStage, resource?: 'settings'): DiagnosticSummary {
  const limits = new Set<DiagnosticLimit>()
  const visited = new Set<object>()
  const pending = [{ value: error, depth: 0, primary: true }]
  const lines = [stages[stage], ...(resource === 'settings' ? ['resource=<appData>/settings.json'] : [])]
  let bytes = encoder.encode(lines.join('\n')).byteLength, entries = 0
  let primaryCode: DiagnosticCode | undefined
  const data = (value: object, key: string): unknown => {
    try {
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (property && !('value' in property)) limits.add('uninspectable')
      return property && 'value' in property ? property.value : undefined
    } catch { limits.add('uninspectable'); return undefined }
  }
  while (pending.length) {
    if (entries >= DIAGNOSTIC_MAX_ENTRIES) { limits.add('entries'); break }
    const { value, depth, primary } = pending.pop()!
    if (depth >= DIAGNOSTIC_MAX_DEPTH) { limits.add('depth'); continue }
    if (!value || typeof value !== 'object') {
      lines.push(`${depth}: Non-error value (content omitted)`)
      entries++
      continue
    }
    if (visited.has(value)) { limits.add('cycle-or-repeat'); continue }
    visited.add(value)
    let rawName = data(value, 'name'), array: object | undefined
    try {
      const prototype = Object.getPrototypeOf(value)
      if (rawName === undefined && prototype) rawName = data(prototype, 'name')
      const aggregate = data(value, 'errors')
      if (Array.isArray(aggregate)) array = aggregate
    } catch { limits.add('uninspectable') }
    const kind = array ? 'AggregateError' : typeof rawName === 'string' && rawName.length <= 64 && names.has(rawName) ? rawName : 'Error'
    const rawCode = data(value, 'code')
    const code = typeof rawCode === 'string' && rawCode.length <= 64 && Object.hasOwn(codes, rawCode) ? rawCode as DiagnosticCode : undefined
    if (primary && code) primaryCode = code
    const rawStage = data(value, 'stage')
    const operation = typeof rawStage === 'string' && rawStage.length <= 64 && Object.hasOwn(stages, rawStage) ? rawStage as DiagnosticStage : undefined
    const syscall = data(value, 'syscall'), signal = data(value, 'signal'), errno = data(value, 'errno')
    const parts = [`${depth}: ${kind}`]
    if (operation) parts.push(stages[operation])
    if (code) parts.push(`${code}: ${codes[code]}`)
    else if (rawCode !== undefined) parts.push('code=unlisted (omitted)')
    const resourceId = data(value, 'resource')
    if (typeof resourceId === 'string' && resourceId.length <= 16 && resources.includes(resourceId as DiagnosticResource)) parts.push(`resource=${resourceId}`)
    if (typeof syscall === 'string' && syscall.length <= 16 && syscalls.has(syscall)) parts.push(`syscall=${syscall}`)
    if (typeof signal === 'string' && signal.length <= 8 && signals.has(signal)) parts.push(`signal=${signal}`)
    if (Number.isSafeInteger(errno) && (errno as number) >= -2147483648 && (errno as number) <= 2147483647) parts.push(`errno=${errno}`)
    if (data(value, 'killed') === true) parts.push('killed=true')
    const line = parts.join(' | ')
    const length = encoder.encode(line).byteLength + 1
    if (bytes + length > DIAGNOSTIC_MAX_BYTES - 512) { limits.add('bytes'); break }
    bytes += length
    lines.push(line)
    entries++
    const cause = data(value, 'cause')
    const rawLength = array ? data(array, 'length') : 0
    const count = Number.isSafeInteger(rawLength) && (rawLength as number) > 0 ? rawLength as number : 0
    const available = DIAGNOSTIC_MAX_ENTRIES - entries - pending.length
    const children = Math.min(count, available)
    if (children < count) limits.add('entries')
    if (cause !== undefined) {
      if (available > children) pending.push({ value: cause, depth: depth + 1, primary: primary && rawCode === undefined && !count })
      else limits.add('entries')
    }
    for (let index = children - 1; index >= 0; index--)
      pending.push({ value: data(array!, String(index)), depth: depth + 1, primary: primary && rawCode === undefined && index === 0 })
  }
  if (limits.size) lines.push(`诊断已截断 / Diagnostic truncated: ${[...limits].join(', ')}`)
  return { details: lines.join('\n'), primaryCode, truncated: limits.size > 0, limits: [...limits], entries }
}
