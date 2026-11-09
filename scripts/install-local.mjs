import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { inspect } from 'node:util'
import { createInstallationCheck, INSTALL_CHECK_ARGUMENT, verifyInstallationResult } from '../src/main/installation-check.mts'
import { acquireInstallLock, checkInstallTarget, installationJson, stageInstallBundle, verifyDeliveryForInstall, verifyInstallBundle } from './install-validation.mjs'
import { captureDeliverySource } from './delivery-source.mjs'
import { artifactDigest } from './local-delivery.mjs'
import { cleanupBuildApplication } from './local-app-lifecycle.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const destination = '/Applications/OC Chan.app'
const lock = '/Applications/.oc-chan-install.lock'
const githubRemote = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)Zixiaobowen\/oc-chan(?:\.git)?\/?$/i

export function pushedCommit(remoteUrl, input) {
  if (!githubRemote.test(remoteUrl)) return null
  const commits = new Set()
  for (const line of input.trim().split('\n')) {
    if (!line.trim()) continue
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 4 || !/^[a-f0-9]{40}$/.test(fields[1]) || !/^[a-f0-9]{40}$/.test(fields[3])) {
      throw new Error('无效的 Git pre-push 引用记录')
    }
    const [, localSha, remoteRef] = fields
    if (remoteRef.startsWith('refs/heads/') && !/^0+$/.test(localSha)) commits.add(localSha)
  }
  if (commits.size > 1) throw new Error('一次推送包含不同提交的多个分支，无法确定本机安装版本；请分别推送')
  return commits.values().next().value ?? null
}

function run(command, args, { cwd = root, capture = false, timeout = 60_000 } = {}) {
  return execFileSync(command, args, {
    cwd, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit']
  })?.trim()
}

function exists(file) {
  try { lstatSync(file); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export function deliveryCleanupRoot({ root, application }) {
  const bundle = realpathSync(application)
  const common = realpathSync(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, capture: true }))
  const entries = run('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root, capture: true }).split('\0')
    .filter(field => field.startsWith('worktree ')).map(field => field.slice(9))
  if (entries.length > 128) throw new Error('工作区数量超过 128，拒绝定位交付应用归属')
  for (const entry of entries) {
    // Stale worktree registrations cannot own an existing delivery application.
    if (!exists(entry)) continue
    const candidate = realpathSync(entry)
    const relative = path.relative(path.join(candidate, 'release'), bundle)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
    if (realpathSync(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: candidate, capture: true })) !== common)
      throw new Error(`交付应用所在工作区的仓库归属发生变化：${candidate}`)
    return candidate
  }
  throw new Error(`交付应用不属于本仓库已登记工作区的受管 release，已保留来源：${application}`)
}


async function application(action, check) {
  // Each query uses a fresh NSWorkspace; its running-app list requires a native event loop to refresh.
  const query = (quit = false) => JSON.parse(run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
    ObjC.import('AppKit');
    const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    const found = [];
    for (let i = 0; i < apps.count; i++) {
      const app = apps.objectAtIndex(i);
      if (app.bundleURL && ObjC.unwrap(app.bundleURL.path) === ${JSON.stringify(destination)} && !app.terminated) {
        found.push({pid: app.processIdentifier, ready: app.finishedLaunching});
        if (${quit} && !app.terminate) throw new Error('OC Chan 拒绝退出');
      }
    }
    JSON.stringify(found);
  `], { capture: true, timeout: 5_000 }))
  const alive = pid => {
    try { process.kill(pid, 0); return true } catch (error) {
      if (error.code === 'ESRCH') return false
      throw error
    }
  }
  const deadline = Date.now() + (action === 'quit' ? 15_000 : 45_000)
  if (action === 'quit') {
    const apps = query(true)
    while (apps.some(app => alive(app.pid))) {
      if (Date.now() >= deadline) throw new Error('OC Chan 在 15 秒内未退出，停止替换')
      await setTimeout(100)
    }
    return
  }
  while (Date.now() < deadline) {
    const result = await verifyInstallationResult(check)
    if (result) {
      if (!query().some(candidate => candidate.pid === result.pid && candidate.ready)) throw new Error('就绪回执与实际运行应用不匹配')
      await setTimeout(2_000)
      if (!query().some(candidate => candidate.pid === result.pid && candidate.ready)) throw new Error('新版 OC Chan 启动后退出')
      return result
    }
    await setTimeout(200)
  }
  throw new Error('新版 OC Chan 在 45 秒内未完成界面、IPC与采集就绪验证')
}

export async function replaceBundle(staged, target, { stop, start }) {
  const previous = path.join(path.dirname(staged), 'previous.app')
  const sourceInfo = lstatSync(staged)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || sourceInfo.dev !== lstatSync(path.dirname(target)).dev)
    throw new Error('安装暂存包必须是同一磁盘上的真实目录')
  if (exists(previous)) throw new Error(`还原位置已存在，拒绝覆盖：${previous}`)
  const previousInfo = exists(target) ? lstatSync(target) : null
  if (previousInfo && (!previousInfo.isDirectory() || previousInfo.isSymbolicLink())) throw new Error('安装目标不能是符号链接或普通文件')
  let movedPrevious = false
  let installed = false
  await stop()
  const current = exists(target) ? lstatSync(target) : null
  if (Boolean(current) !== Boolean(previousInfo) || current && (current.ino !== previousInfo.ino || current.dev !== previousInfo.dev))
    throw new Error('退出等待期间安装目标发生变化，保留现场')
  if (exists(target)) {
    renameSync(target, previous)
    movedPrevious = true
  }
  try {
    renameSync(staged, target)
    installed = true
    await start()
  } catch (error) {
    try {
      if (installed) {
        await stop()
        renameSync(target, staged)
      }
      if (movedPrevious) renameSync(previous, target)
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `安装及还原均失败；保留现场，请检查 ${previous} 和 ${target}`)
    }
    throw new Error(`安装失败；${movedPrevious ? '旧应用已还原' : '已撤销新安装'}：${error.message}`, { cause: error })
  }
  if (movedPrevious) rmSync(previous, { recursive: true })
}

async function main() {
  const args = process.argv.slice(2)
  let commit = null, deliveryDirectory = null
  if (args[0] === '--pre-push' && args.length === 3) {
    if (!githubRemote.test(args[2])) {
      console.log('[oc-chan] 跳过本机安装：目标不是本项目的 GitHub 仓库')
      return
    }
    let input = ''
    for await (const chunk of process.stdin) {
      input += chunk
      if (Buffer.byteLength(input) > 64 * 1024) throw new Error('推送引用列表超过 64 KiB，拒绝自动安装')
    }
    commit = pushedCommit(args[2], input)
    if (!commit) { console.log('[oc-chan] 没有分支提交需要安装（空推送、删除分支或仅标签）'); return }
  } else if (['--delivery', '--check-delivery'].includes(args[0]) && args.length === 2) {
    deliveryDirectory = path.resolve(args[1])
  } else if (args.length) {
    throw new Error('用法：node scripts/install-local.mjs [--pre-push <remote-name> <remote-url> | --delivery <目录> | --check-delivery <目录>]')
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('本期本机安装仅支持 macOS arm64')
  if (args[0] === '--check-delivery') {
    const verified = await verifyDeliveryForInstall(deliveryDirectory)
    console.log(JSON.stringify({ verified: true, architecture: 'arm64', version: verified.version, application: verified.bundle, source: verified.source, signature: verified.signature, installed: false }))
    return
  }
  checkInstallTarget(destination)
  const writeOwner = acquireInstallLock(lock, { pid: process.pid, root, commit, deliveryDirectory })
  let snapshot, staging, check, failure
  let preserveStaging = false
  try {
    writeOwner()
    let buildRoot = root, prepared, sourceEvidence
    if (deliveryDirectory) {
      prepared = await verifyDeliveryForInstall(deliveryDirectory)
      prepared.bundle = realpathSync(prepared.bundle)
      buildRoot = deliveryCleanupRoot({ root, application: prepared.bundle })
    } else {
      if (commit) {
        const resolved = run('git', ['rev-parse', '--verify', `${commit}^{commit}`], { capture: true })
        if (resolved !== commit) throw new Error('待推送引用不是提交')
        snapshot = mkdtempSync(path.join(tmpdir(), 'oc-chan-build-'))
        buildRoot = path.join(snapshot, 'source')
        mkdirSync(buildRoot)
        const archive = path.join(snapshot, 'source.tar')
        run('git', ['archive', '--format=tar', `--output=${archive}`, commit])
        sourceEvidence = { kind: 'git-archive', commit, archive: await artifactDigest(archive) }
        run('/usr/bin/tar', ['-xf', archive, '-C', buildRoot])
        console.log(`[oc-chan] 构建待推送提交 ${commit}（独立源码快照）`)
        run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: buildRoot, timeout: 600_000 })
      } else {
        sourceEvidence = await captureDeliverySource(root)
        console.log('[oc-chan] 手动安装：构建当前工作目录，包含未提交改动')
      }
      const { version } = await installationJson(path.join(buildRoot, 'package.json'), 64 * 1024)
      run('npm', ['run', 'package'], { cwd: buildRoot, timeout: 900_000 })
      const bundle = path.join(buildRoot, 'release/mac-arm64/OC Chan.app')
      const { inventory, signature } = await verifyInstallBundle(bundle, { root: buildRoot, version })
      if (!commit && JSON.stringify(await captureDeliverySource(root)) !== JSON.stringify(sourceEvidence)) throw new Error('构建期间源码发生变化，拒绝安装')
      prepared = { bundle, inventory, signature, version, source: sourceEvidence, root: buildRoot }
    }
    const staged = await stageInstallBundle(prepared.bundle, destination, prepared)
    staging = staged.directory
    check = await createInstallationCheck(staged.executable, prepared.version)
    console.log('[oc-chan] 来源、内容、架构、签名、磁盘和权限预检通过，退出旧应用并替换安装')
    try {
      await replaceBundle(staged.staged, destination, {
        stop: () => application('quit'),
        start: async () => {
          run('/usr/bin/open', ['-a', destination, '--args', `${INSTALL_CHECK_ARGUMENT}${check.filename}`])
          console.log(`[oc-chan] 新版实际就绪 ${JSON.stringify(await application('check', check))}`)
        }
      })
    } catch (error) {
      preserveStaging = true
      throw new Error(`${error.message}；安装现场保留在 ${staging}，启动证据在 ${check.directory}`, { cause: error })
    }
    console.log(`[oc-chan] 已替换 ${destination}，旧应用包已删除；个人设置和数据保留`)
    if (!snapshot) {
      try {
        const cleanup = await cleanupBuildApplication({ root: buildRoot, application: prepared.bundle })
        console.log(`[oc-chan] 来源应用清理 ${JSON.stringify(cleanup)}`)
      } catch (error) {
        throw new Error(`正式应用已成功安装并就绪，但来源应用清理失败：${error.message}`, { cause: error })
      }
    }
  } catch (error) { failure = error }
  for (const owned of [snapshot, !preserveStaging && staging, !preserveStaging && check?.directory, lock].filter(Boolean)) {
    try { rmSync(owned, { recursive: true }) }
    catch (error) { failure = failure ? new AggregateError([failure, error], `安装与清理失败；保留 ${owned}`) : error }
  }
  if (failure) throw failure
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error('[oc-chan] 本机安装或安装后清理失败；如用于 pre-push，将阻止推送：', inspect(error, { depth: null }))
    process.exitCode = 1
  })
}
