import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifiedGithubMain } from './push-main.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAX_ENTRIES = 20_000
const HASH = /^[a-f0-9]{40}$/
class Refusal extends Error {
  constructor(code, message) { super(message); this.code = code }
}
function refuse(code, message) { throw new Refusal(code, message) }
function command(program, args, cwd, maxBuffer = 8 * 1024 * 1024) {
  try {
    return execFileSync(program, args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const stderr = String(error.stderr ?? '')
    const diagnostic = stderr.slice(0, 16_384)
    throw new Refusal('command-failed', `${program} ${args.find(arg => !arg.startsWith('-')) ?? ''} 查询或操作失败（${error.code ?? error.status ?? 'unknown'}）${diagnostic ? `：${diagnostic}` : ''}${stderr.length > diagnostic.length ? '\n[stderr 超过 16384 字符，已截断诊断；操作按失败处理]' : ''}`)
  }
}
function git(root, args) { return command('git', ['--no-optional-locks', ...args], root) }
function fields(text) {
  if (text && !text.endsWith('\0')) refuse('invalid-output', 'Git 输出未完整结束')
  const result = text ? text.slice(0, -1).split('\0') : []
  if (result.length > MAX_ENTRIES) refuse('limit', 'Git 文件/字段数量超过 20000 上限')
  return result
}
function statusEntries(text) {
  const rows = fields(text), entries = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (!/^[ MTADRCU?!]{2} [\s\S]+$/.test(row)) refuse('invalid-output', 'Git porcelain 状态条目无效')
    const entry = { status: row.slice(0, 2), path: row.slice(3) }
    if (/[RC]/.test(entry.status)) {
      entry.originalPath = rows[++index]
      if (!entry.originalPath) refuse('invalid-output', 'Git 重命名状态缺少原路径')
    }
    entries.push(entry)
  }
  return entries
}
function protectedIndex(target) {
  return fields(git(target, ['ls-files', '-v', '-z'])).flatMap(row => {
    if (!/^[A-Za-z?] [\s\S]+$/.test(row)) refuse('invalid-output', 'Git 索引标志输出无效')
    return /[a-zS]/.test(row[0]) ? [{ flag: row[0], path: row.slice(2) }] : []
  })
}
function observeRemoval(root, target, report, commandFailed) {
  const state = { directoryPresent: null, registered: null }
  try { lstatSync(target); state.directoryPresent = true } catch (error) {
    if (error.code === 'ENOENT') state.directoryPresent = false
    else report.blockers.push({ code: 'remove-observation', message: `删除后目录状态查询失败：${error.message}` })
  }
  try { state.registered = worktrees(root).some(entry => entry.path === target) } catch (error) {
    report.blockers.push({ code: 'remove-observation', message: `删除后注册状态查询失败：${error.message}` })
  }
  report.removalState = state
  report.removed = state.directoryPresent === false && state.registered === false
  if (report.removed) report.stage = commandFailed ? 'removed-with-command-error' : 'removed'
  else if (Object.values(state).includes(null)) report.stage = 'remove-state-unknown'
  else if (state.directoryPresent !== state.registered) report.stage = 'remove-partial'
  else report.stage = 'remove-incomplete-materials-unverified'
}
function worktrees(root) {
  const entries = []
  for (const field of fields(git(root, ['worktree', 'list', '--porcelain', '-z']))) {
    if (field.startsWith('worktree ')) entries.push({ path: field.slice(9) })
    else if (field) {
      const entry = entries.at(-1)
      if (!entry) refuse('invalid-output', '工作树登记输出无效')
      const space = field.indexOf(' ')
      entry[space < 0 ? field : field.slice(0, space)] = space < 0 ? true : field.slice(space + 1)
    }
  }
  if (!entries.length || entries.length > 128) refuse('limit', '工作树登记为空或超过 128 上限')
  return entries
}
const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep)
function common(root) { return realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()) }
function canonical(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.normalize(target) !== target || realpathSync(target) !== target) {
    refuse('path', '目标必须是绝对规范路径，不允许符号链接或符号链接祖先')
  }
  if (!lstatSync(target).isDirectory()) refuse('path', '目标必须是目录')
}
function identity(root, target) {
  canonical(target)
  const entries = worktrees(root)
  const entry = entries.find(item => item.path === target)
  if (!entry) refuse('unregistered', '目标未注册在入口仓库')
  if (target === entries[0].path) refuse('primary', '不能删除 primary 主仓库')
  if (contains(target, root) || contains(root, target) || contains(target, realpathSync(process.cwd()))) refuse('self', '不能删除入口、当前进程目录或危险嵌套路径')
  if (entries.some(item => item.path !== target && (contains(target, item.path) || contains(item.path, target)))) refuse('nested', '目标与其它注册工作树存在父子嵌套')
  if (entry.locked !== undefined || entry.prunable !== undefined || entry.bare !== undefined) refuse('protected', '目标工作树 locked、prunable 或 bare')
  if (['refs/heads/main', 'refs/heads/master'].includes(entry.branch)) refuse('branch', '不能删除 main/master 工作树')
  const shared = common(root)
  if (common(target) !== shared || realpathSync(git(target, ['rev-parse', '--show-toplevel']).trim()) !== target) refuse('identity', '目标不是同仓库的工作树根目录')
  const head = git(target, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  if (!HASH.test(head) || entry.HEAD !== head) refuse('identity', '目标 HEAD 与登记不一致')
  const metadata = realpathSync(git(target, ['rev-parse', '--absolute-git-dir']).trim())
  const stat = lstatSync(target), meta = lstatSync(metadata)
  return { head, branch: entry.branch ?? null, common: shared, metadata, dev: stat.dev, ino: stat.ino, metaDev: meta.dev, metaIno: meta.ino }
}
function ancestor(root, head, remote) {
  try {
    execFileSync('git', ['--no-optional-locks', 'merge-base', '--is-ancestor', head, remote], { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (error.status === 1) refuse('unmerged', '目标 HEAD 不被现场 GitHub main 包含')
    refuse('command-failed', `Git 包含性检查失败（${error.code ?? error.status}）`)
  }
}
function treeBlob(root, revision, filename) {
  const rows = fields(git(root, ['ls-tree', '-z', revision, '--', filename]))
  const match = rows.length === 1 && /^(100644|100755) blob ([a-f0-9]{40})\t/.exec(rows[0])
  if (!match || rows[0].slice(match[0].length) !== filename) refuse('handoff', '交接在提交中不是唯一常规 blob')
  return match[2]
}
function handoffBlob(root, handoff, remote) {
  if (typeof handoff !== 'string' || !/^docs\/codex-handoffs\/.+\.md$/.test(handoff) || handoff.includes('\\') || handoff.split('/').some(part => !part || part === '.' || part === '..' || /[*?\[\]]/.test(part))) refuse('handoff', '交接必须是 docs/codex-handoffs/ 下的明确 .md 路径')
  const blob = treeBlob(root, remote, handoff)
  if (treeBlob(root, 'HEAD', handoff) !== blob) refuse('handoff', '入口 HEAD 的交接与远端不一致')
  const file = path.join(root, handoff)
  if (realpathSync(file) !== file || !lstatSync(file).isFile()) refuse('handoff', '入口交接不是常规文件或经过符号链接')
  if (git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none', '--', handoff])) refuse('handoff', '入口交接存在未提交改动')
  if (git(root, ['hash-object', '--no-filters', '--', file]).trim() !== blob) refuse('handoff', '入口交接文件内容与远端 blob 不一致')
  return blob
}
function ignoredEntries(target) {
  return fields(git(target, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).sort()
}
const trimSlash = value => value.endsWith('/') ? value.slice(0, -1) : value
function reviewedDiscard(ignored, discard) {
  if (!Array.isArray(discard) || discard.length > MAX_ENTRIES) refuse('discard', 'discard 必须是有界逐项列表')
  const reviewed = new Set()
  for (const raw of discard) {
    if (typeof raw !== 'string') refuse('discard', 'discard 条目必须为字符串')
    const value = trimSlash(raw)
    if (!value || path.isAbsolute(value) || /[\\*?\[\]\0]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..') || !ignored.some(item => trimSlash(item) === value)) refuse('discard', 'discard 必须精确匹配本次 ignored 条目，不能使用模式或父目录泛匹配')
    reviewed.add(value)
  }
  return ignored.filter(item => !reviewed.has(trimSlash(item)))
}
function inUse(target, root) {
  if (process.platform !== 'darwin') return null
  // No PID filter: include every visible descriptor, cwd and executable text.
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-F0pfn'], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error || result.status !== 0 || result.stderr) refuse('lsof-failed', `lsof 查询失败或不完整（${result.error?.code ?? result.status}），不能确认目标无人使用`)
  const output = result.stdout
  let pid = null, count = 0
  const matches = new Map()
  for (const raw of output.split('\0')) {
    const field = raw.replace(/^\n/, '')
    if (!field) continue
    if (++count > 500_000) refuse('limit', 'lsof 字段超过上限，不能确认目标无人使用')
    if (field.startsWith('p')) {
      if (!/^p\d+$/.test(field)) refuse('lsof-failed', 'lsof PID 输出无效')
      pid = Number(field.slice(1))
    } else if (field.startsWith('f')) {
      if (!pid || field.length < 2) refuse('lsof-failed', 'lsof 文件描述符输出无效')
    } else if (field.startsWith('n')) {
      if (!pid) refuse('lsof-failed', 'lsof 文件缺少 PID')
      const name = field.slice(1)
      if (contains(target, name)) matches.set(`${pid}\0${name}`, { pid, path: name })
    } else refuse('lsof-failed', 'lsof 返回无法解析的字段')
  }
  if (!count) refuse('lsof-failed', 'lsof 未返回可验证的进程信息')
  return [...matches.values()]
}

function createReceipt(root, report) {
  const directory = path.join(common(root), 'task-closeouts')
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) refuse('receipt', '回执目录必须是当前用户拥有的私有常规目录')
  report.receiptPath = path.join(directory, `${randomUUID()}.json`)
  const fd = openSync(report.receiptPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const file = fstatSync(fd)
  if (!file.isFile() || file.nlink !== 1) { closeSync(fd); refuse('receipt', '回执不是独占常规文件') }
  return fd
}
function saveReceipt(fd, report) {
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n')
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, offset)
    if (!written) refuse('receipt', '回执写入未完成')
    offset += written
  }
  ftruncateSync(fd, bytes.length)
  fsyncSync(fd)
}

export function closeoutTask({ root = ROOT, worktree, handoff, discard = [], apply = false } = {}) {
  const report = { root, target: worktree ?? null, head: null, remoteMain: null, handoff: { path: handoff ?? null, blob: null }, ignored: [], discard, dirty: [], protectedIndex: [], blockers: [], inUse: null, removed: false, removalState: null, receiptPath: null, stage: 'planned',
    limitations: ['Git worktree remove 与检查之间存在 TOCTOU；无法阻止不合作的外部写入。lsof 只覆盖系统允许当前用户观察的进程。'] }
  let receipt, removalAttempted = false
  try {
    if (typeof apply !== 'boolean') refuse('apply-type', 'apply 必须是 boolean，不能使用字符串或其它 truthy 值')
    root = realpathSync(root)
    report.root = root
    if (realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !== root) refuse('root', '入口必须是工作树根目录')
    if (apply) { receipt = createReceipt(root, report); saveReceipt(receipt, report) }
    const before = identity(root, worktree)
    report.head = before.head
    const status = git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])
    report.dirty = statusEntries(status)
    report.protectedIndex = protectedIndex(worktree)
    if (report.protectedIndex.length) report.blockers.push({ code: 'index-flags', message: '索引存在 assume-unchanged 或 skip-worktree 标志，无法依赖 status 确认内容安全', entries: report.protectedIndex })
    report.ignored = ignoredEntries(worktree)
    if (status) report.blockers.push({ code: 'dirty', message: '目标有暂存、未暂存或未跟踪内容，必须先处理', entries: report.dirty })
    const unreviewed = reviewedDiscard(report.ignored, discard)
    if (unreviewed.length) report.blockers.push({ code: 'ignored', message: '存在未逐项确认 discard 的 ignored 内容', entries: unreviewed })
    report.remoteMain = verifiedGithubMain(root)
    ancestor(root, before.head, report.remoteMain)
    report.handoff.blob = handoffBlob(root, handoff, report.remoteMain)
    report.inUse = inUse(worktree, root)
    if (report.inUse?.length) report.blockers.push({ code: 'in-use', message: '目标被进程使用', entries: report.inUse })
    if (apply && process.platform !== 'darwin') report.blockers.push({ code: 'unsupported', message: 'apply 仅支持 macOS，已保留目标' })
    report.stage = report.blockers.length ? 'blocked' : 'checked'
    if (!apply || report.blockers.length) return report

    const latest = verifiedGithubMain(root)
    ancestor(root, before.head, latest)
    if (handoffBlob(root, handoff, latest) !== report.handoff.blob) refuse('changed', '删除前交接 blob 发生变化')
    report.remoteMain = latest
    report.inUse = inUse(worktree, root)
    if (report.inUse.length) refuse('in-use', '删除前目标被进程使用')
    const after = identity(root, worktree)
    if (JSON.stringify(after) !== JSON.stringify(before) || git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']) !== status || JSON.stringify(ignoredEntries(worktree)) !== JSON.stringify(report.ignored)) refuse('changed', '删除前目标身份、HEAD、状态或 ignored 条目发生变化')
    if (protectedIndex(worktree).length) refuse('index-flags', '删除前索引出现 assume-unchanged 或 skip-worktree 标志')
    report.stage = 'removing'
    saveReceipt(receipt, report)
    removalAttempted = true
    report.stage = 'remove-attempted'
    git(root, ['worktree', 'remove', '--', worktree])
    observeRemoval(root, worktree, report, false)
    if (!report.removed) refuse('remove-incomplete', '删除后目录或登记尚未确认消失；材料完整性未验证，请检查实际状态')
  } catch (error) {
    report.blockers.push({ code: error.code ?? 'error', message: error.message })
    if (removalAttempted && !report.removalState) observeRemoval(root, worktree, report, true)
  } finally {
    if (receipt !== undefined) {
      try { saveReceipt(receipt, report) } catch (error) { report.blockers.push({ code: 'receipt-write', message: `回执写回失败：${error.message}` }) }
      try { closeSync(receipt) } catch (error) { report.blockers.push({ code: 'receipt-close', message: `回执关闭失败：${error.message}` }) }
    }
  }
  return report
}

function cli(args) {
  const options = { discard: [] }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--apply' && !options.apply) options.apply = true
    else if (['--worktree', '--handoff', '--discard'].includes(arg)) {
      const value = args[++index]
      if (!value || value.startsWith('--')) refuse('usage', `${arg} 缺少值`)
      const key = arg.slice(2)
      if (key === 'discard') options.discard.push(value)
      else if (options[key] === undefined) options[key] = value
      else refuse('usage', `${arg} 不能重复`)
    } else refuse('usage', `未知或重复参数 ${arg}`)
  }
  if (!options.worktree || !options.handoff) refuse('usage', '用法：node scripts/closeout-task.mjs --worktree <absolute> --handoff docs/codex-handoffs/<file>.md [--discard <exact-entry>]... [--apply]')
  return closeoutTask(options)
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let report
  try { report = cli(process.argv.slice(2)) } catch (error) {
    report = { root: ROOT, target: null, head: null, remoteMain: null, handoff: { path: null, blob: null }, ignored: [], discard: [], blockers: [{ code: error.code ?? 'error', message: error.message }], removed: false }
  }
  console.log(JSON.stringify(report, null, 2))
  if (report.blockers.length) process.exitCode = 1
}
