import { execFileSync } from 'node:child_process'
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireInstallLock, checkInstallTarget, installationJson, stageInstallBundle, verifyDeliveryForInstall, verifyInstallBundle } from './install-validation.mjs'
import { captureDeliverySource } from './delivery-source.mjs'
import { command } from './local-delivery.mjs'
import { cleanupBuildApplication } from './local-app-lifecycle.mjs'
import { compileLocalProcessTool, launchForReadiness, nativeProcess, publishPrivateJson, stopApplication } from './local-install-readiness.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const destination = '/Applications/OC Chan.app', lock = '/Applications/.oc-chan-install.lock'
function requireThat(value, message) { if (!value) throw new Error(message) }
function run(file, args, cwd = root) { return execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function exists(file) { try { lstatSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
function same(a, b) { return a && b && a.dev === b.dev && a.ino === b.ino }
function syncDirectory(directory) { const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) } }
export function deliveryCleanupRoot({ root, application }) {
  const bundle = realpathSync(application), common = realpathSync(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], root))
  const entries = run('git', ['worktree', 'list', '--porcelain', '-z'], root).split('\0').filter(field => field.startsWith('worktree ')).map(field => field.slice(9))
  requireThat(entries.length <= 128, '工作区数量超过128，拒绝定位交付应用归属')
  for (const entry of entries) {
    if (!exists(entry)) continue
    const candidate = realpathSync(entry), relative = path.relative(path.join(candidate, 'release'), bundle)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
    requireThat(realpathSync(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], candidate)) === common, '交付工作区的仓库归属发生变化')
    return candidate
  }
  throw new Error(`交付应用不属于本仓库已登记工作区的受管release，已保留来源：${application}`)
}
export function installOptions(args) {
  if (args.length === 0) return { mode: 'current' }
  if (args.length === 2 && ['--delivery', '--check-delivery'].includes(args[0])) return { mode: args[0] === '--delivery' ? 'delivery' : 'check', directory: path.resolve(args[1]) }
  throw new Error('Usage: node scripts/install-local.mjs [--delivery DIRECTORY | --check-delivery DIRECTORY]')
}
export async function replaceBundle(staged, target, { stop, start, restart, validate }) {
  for (const callback of [stop, start, restart, validate]) requireThat(typeof callback === 'function', 'Installation requires explicit stop/start/restore/validation callbacks')
  const directory = path.dirname(staged), previous = path.join(directory, 'previous.app'), journal = path.join(directory, 'replace-journal.json')
  const sourceInfo = lstatSync(staged), parentInfo = lstatSync(path.dirname(target))
  requireThat(sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink() && sourceInfo.dev === parentInfo.dev, '安装暂存包必须是同一磁盘上的真实目录')
  requireThat(!exists(previous) && !exists(journal), '还原位置或安装日志已存在，拒绝覆盖')
  const previousInfo = exists(target) ? lstatSync(target) : null
  requireThat(!previousInfo || previousInfo.isDirectory() && !previousInfo.isSymbolicLink(), '安装目标不能是符号链接或普通文件')
  let movedPrevious = false, installed = false
  const record = phase => {
    const temporary = `${journal}.next`, fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, JSON.stringify({ schema: 2, phase, target, staged, previous, source: { dev: sourceInfo.dev, ino: sourceInfo.ino }, old: previousInfo ? { dev: previousInfo.dev, ino: previousInfo.ino } : null, at: Date.now() })); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, journal); syncDirectory(directory)
  }
  const targetStill = expected => {
    requireThat(same(lstatSync(path.dirname(target)), parentInfo), '安装目标父目录身份发生变化')
    const current = exists(target) ? lstatSync(target) : null
    requireThat(expected ? same(current, expected) : !current, '退出等待或安装期间安装目标发生变化，保留现场')
  }
  record('prepared')
  try {
    await stop(); targetStill(previousInfo)
    requireThat(same(lstatSync(staged), sourceInfo), '退出等待期间候选包身份发生变化')
    await validate(staged); targetStill(previousInfo)
    if (previousInfo) { record('backup-intent'); renameSync(target, previous); movedPrevious = true; syncDirectory(path.dirname(target)); syncDirectory(directory); record('old-backed-up') }
    record('install-intent'); renameSync(staged, target); installed = true; syncDirectory(path.dirname(target)); syncDirectory(directory); record('new-installed')
    await start(); targetStill(sourceInfo); record('committed')
  } catch (error) {
    try {
      if (installed) { targetStill(sourceInfo); record('rollback-stop-intent'); await stop(); targetStill(sourceInfo); record('rollback-new-intent'); renameSync(target, staged); syncDirectory(path.dirname(target)); syncDirectory(directory) }
      if (movedPrevious) { targetStill(null); requireThat(same(lstatSync(previous), previousInfo), '备份旧包身份变化，拒绝还原'); record('rollback-old-intent'); renameSync(previous, target); syncDirectory(path.dirname(target)); syncDirectory(directory); await restart() }
      if (!movedPrevious && !installed && previousInfo && exists(target) && same(lstatSync(target), previousInfo)) await restart()
      record(installed || movedPrevious ? 'rolled-back' : 'failed-before-replacement')
    } catch (restoreError) { throw new AggregateError([error, restoreError], `安装及还原均失败；保留现场：${previous} 与 ${target}`) }
    throw new Error(`安装失败；${movedPrevious ? '旧应用已还原' : '已撤销新安装'}：${error.message}`, { cause: error })
  }
  if (movedPrevious) {
    requireThat(same(lstatSync(previous), previousInfo), '新应用已安装就绪，但旧包清理前身份改变；保留现场')
    try { rmSync(previous, { recursive: true }); syncDirectory(directory) }
    catch (error) { throw new Error('新应用已安装并实际就绪，但旧包清理失败；保留安装日志', { cause: error }) }
  }
}
export async function installLocal(options) {
  requireThat(process.platform === 'darwin' && process.arch === 'arm64', '本机安装仅支持macOS arm64')
  if (options.mode === 'check') {
    const checked = await verifyDeliveryForInstall(options.directory, root)
    console.log(JSON.stringify({ verified: true, architecture: 'arm64', version: checked.version, application: checked.bundle, source: checked.source, signature: checked.signature, installed: false })); return checked
  }
  checkInstallTarget(destination)
  const writeOwner = acquireInstallLock(lock, { pid: process.pid, root, deliveryDirectory: options.directory ?? null }), lockIdentity = lstatSync(lock)
  const controller = new AbortController(), interrupt = () => controller.abort(new Error('Local installation cancelled'))
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  let staging, evidenceDirectory, session, failure, initialRunning = false, firstStop = true, replacementStarted = false, gateDrained = true
  try {
    writeOwner(); let prepared, buildRoot = root
    if (options.mode === 'delivery') { prepared = await verifyDeliveryForInstall(options.directory, root); prepared.bundle = realpathSync(prepared.bundle); buildRoot = deliveryCleanupRoot({ root, application: prepared.bundle }) }
    else {
      const source = await captureDeliverySource(root)
      await command('npm', ['run', 'package'], { cwd: root, timeout: 900000, signal: controller.signal })
      const buildRecord = await installationJson(path.join(root, 'release/tauri/build.json'))
      requireThat(buildRecord.schema === 2 && /^[a-f0-9-]{36}$/.test(buildRecord.buildId), 'Invalid Rust build receipt')
      const distribution = await installationJson(path.join(root, 'release/tauri', buildRecord.buildId, 'distribution.json'))
      requireThat(distribution.schema === 2 && distribution.buildId === buildRecord.buildId && distribution.version === source.version, 'Distribution differs from captured source')
      const bundle = distribution.app
      requireThat(deliveryCleanupRoot({ root, application: bundle }) === root, 'Built application belongs to another source worktree')
      const verified = await verifyInstallBundle(bundle, { root, version: source.version, buildRecord })
      requireThat(JSON.stringify(await captureDeliverySource(root)) === JSON.stringify(source), '构建期间源码发生变化，拒绝安装')
      prepared = { bundle, ...verified, buildRecord, version: source.version, source }
    }
    controller.signal.throwIfAborted()
    const evidenceParent = path.join(root, 'release/tauri/installations'); mkdirSync(evidenceParent, { recursive: true, mode: 0o700 })
    evidenceDirectory = realpathSync(mkdtempSync(path.join(evidenceParent, 'installation-')))
    const tool = await compileLocalProcessTool(root, evidenceDirectory)
    const staged = await stageInstallBundle(prepared.bundle, destination, { ...prepared, root: buildRoot }); staging = staged.directory
    await publishPrivateJson(path.join(evidenceDirectory, 'installation.json'), { schema: 2, source: { version: prepared.version, digest: prepared.source.digest }, staging, target: destination, buildId: prepared.buildRecord.buildId })
    replacementStarted = true
    await replaceBundle(staged.staged, destination, {
      validate: async candidate => { controller.signal.throwIfAborted(); await verifyInstallBundle(candidate, { ...prepared, root: buildRoot, expected: prepared.inventory, expectedSignature: prepared.signature }) },
      stop: async () => {
        if (session) { await session.abandon(); session = undefined }
        const running = exists(destination) ? await stopApplication(tool, destination) : false
        if (firstStop) { initialRunning = running; firstStop = false }
      },
      start: async () => {
        controller.signal.throwIfAborted(); await verifyInstallBundle(destination, { ...prepared, root: buildRoot, expected: prepared.inventory, expectedSignature: prepared.signature })
        session = await launchForReadiness({ tool, bundle: destination, version: prepared.version, evidenceDirectory, signal: controller.signal })
        const receipt = await session.verify(); session = undefined
        console.log(`[oc-chan] 新版真实React、IPC、采集和历史就绪：${receipt.request.process.pid}`)
      },
      restart: async () => {
        if (!initialRunning) return
        await command('/usr/bin/open', ['-a', destination], { timeout: 10000 })
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) { const apps = await nativeProcess(tool, 'applications', destination); if (apps.length === 1 && apps[0].ready) return; await delay(100) }
        throw new Error('旧包已还原但实际应用未恢复启动；保留现场')
      }
    })
    await publishPrivateJson(path.join(evidenceDirectory, 'installed.json'), { schema: 2, target: destination, version: prepared.version, at: Date.now(), installed: true })
    const cleanup = await cleanupBuildApplication({ root: buildRoot, application: prepared.bundle })
    console.log(`[oc-chan] 已安装并验证 ${destination}；仅清理来源应用 ${JSON.stringify(cleanup)}；源码、ZIP/DMG和证据保留`)
  } catch (error) { failure = error }
  if (session) { try { await session.abandon() } catch (cleanup) { gateDrained = false; failure = new AggregateError(failure ? [failure, cleanup] : [cleanup], 'Installation and launch cancellation failed') } }
  try {
    requireThat(same(lstatSync(lock), lockIdentity), '安装锁已被替换，保留未知锁')
    requireThat(gateDrained, '原生启动进程未证明排空，保留安装锁')
    if (failure && replacementStarted) {
      const journal = await installationJson(path.join(staging, 'replace-journal.json'), 16384)
      requireThat(journal.schema === 2 && journal.target === destination && ['committed', 'rolled-back', 'failed-before-replacement'].includes(journal.phase), '安装日志未到已确认终态，保留安装锁')
      const expected = journal.phase === 'committed' ? journal.source : journal.old, current = exists(destination) ? lstatSync(destination) : null
      requireThat(expected ? same(current, expected) : !current, '终态目标身份不匹配，保留安装锁')
    }
    rmSync(lock, { recursive: true })
  } catch (cleanup) { failure = new AggregateError(failure ? [failure, cleanup] : [cleanup], 'Installation and owned-lock cleanup failed') }
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
  if (failure) throw new Error(`本地安装或清理未完成；暂存与回执保留：${staging ?? '未创建'}；${evidenceDirectory ?? '未创建'}；未确认的安装锁：${exists(lock) ? lock : '已安全释放'}`, { cause: failure })
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) installLocal(installOptions(process.argv.slice(2))).catch(error => { console.error('[oc-chan] 本地安装失败：', inspect(error, { depth: null })); process.exitCode = 1 })
