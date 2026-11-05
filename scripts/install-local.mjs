import { execFileSync } from 'node:child_process'
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { inspect } from 'node:util'

const root = fileURLToPath(new URL('..', import.meta.url))
const destination = '/Applications/OC Chan.app'
const appId = 'local.oc-chan.desktop'
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

function checkBundle(bundle) {
  if (!lstatSync(bundle).isDirectory()) throw new Error(`应用路径必须是实际目录，不能是符号链接：${bundle}`)
  const plist = path.join(bundle, 'Contents/Info.plist')
  if (run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist], { capture: true }) !== appId) {
    throw new Error(`应用标识不匹配，拒绝替换：${bundle}`)
  }
}

async function application(action) {
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
  const deadline = Date.now() + 15_000
  if (action === 'quit') {
    const apps = query(true)
    while (apps.some(app => alive(app.pid))) {
      if (Date.now() >= deadline) throw new Error('OC Chan 在 15 秒内未退出，停止替换')
      await setTimeout(100)
    }
    return
  }
  while (Date.now() < deadline) {
    const app = query().find(candidate => candidate.ready)
    if (app) {
      await setTimeout(2_000)
      if (!query().some(candidate => candidate.pid === app.pid)) throw new Error('新版 OC Chan 启动后退出')
      return JSON.stringify({ pid: app.pid })
    }
    await setTimeout(200)
  }
  throw new Error('新版 OC Chan 在 15 秒内未启动')
}

export async function replaceBundle(staged, target, { stop, start }) {
  const previous = path.join(path.dirname(staged), 'previous.app')
  let movedPrevious = false
  let installed = false
  await stop()
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
  let commit = null
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
    if (!commit) {
      console.log('[oc-chan] 没有分支提交需要安装（空推送、删除分支或仅标签）')
      return
    }
  } else if (args.length) {
    throw new Error('用法：node scripts/install-local.mjs [--pre-push <remote-name> <remote-url>]')
  }
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('本机安装仅支持 macOS arm64 / x64')
  }
  accessSync('/Applications', constants.W_OK)
  if (exists(destination)) checkBundle(destination)
  try { mkdirSync(lock) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`已有安装任务或未清理的安装锁：${lock}；确认任务结束后再处理`)
    throw error
  }
  let snapshot
  let staging
  let preserveStaging = false
  try {
    writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, root, commit }))
    let buildRoot = root
    if (commit) {
      const resolved = run('git', ['rev-parse', '--verify', `${commit}^{commit}`], { capture: true })
      if (resolved !== commit) throw new Error('待推送引用不是提交')
      snapshot = mkdtempSync(path.join(tmpdir(), 'oc-chan-build-'))
      buildRoot = path.join(snapshot, 'source')
      mkdirSync(buildRoot)
      const archive = path.join(snapshot, 'source.tar')
      run('git', ['archive', '--format=tar', `--output=${archive}`, commit])
      run('/usr/bin/tar', ['-xf', archive, '-C', buildRoot])
      console.log(`[oc-chan] 构建待推送提交 ${commit}（独立源码快照）`)
      run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: buildRoot, timeout: 600_000 })
    } else {
      console.log('[oc-chan] 手动安装：构建当前工作目录，包含未提交改动')
    }
    run('npm', ['run', 'package'], { cwd: buildRoot, timeout: 900_000 })
    const source = path.join(buildRoot, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'OC Chan.app')
    checkBundle(source)
    accessSync(path.join(source, 'Contents/Resources/app.asar'), constants.R_OK)
    const machoArch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
    for (const executable of ['MacOS/OC Chan', 'Resources/tern-navigation/present-window', 'Resources/liquid-glass/liquid-glass.node']) {
      const file = path.join(source, 'Contents', executable)
      accessSync(file, constants.X_OK)
      run('/usr/bin/lipo', [file, '-verify_arch', machoArch])
    }
    staging = mkdtempSync('/Applications/.oc-chan-install-')
    const staged = path.join(staging, 'OC Chan.app')
    run('/usr/bin/ditto', [source, staged])
    // Local ad-hoc signing makes the complete copied bundle verifiable; it is not notarization.
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', staged])
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged])
    console.log('[oc-chan] 新包校验通过，退出旧应用并替换安装')
    try {
      await replaceBundle(staged, destination, {
        stop: () => application('quit'),
        start: async () => {
          run('/usr/bin/open', ['-a', destination])
          console.log(`[oc-chan] 新版已启动 ${await application('check')}`)
        }
      })
    } catch (error) {
      preserveStaging = true
      throw new Error(`${error.message}；安装现场保留在 ${staging}`, { cause: error })
    }
    console.log(`[oc-chan] 已替换 ${destination}，旧应用包已删除；个人设置和数据保留`)
  } finally {
    if (snapshot) rmSync(snapshot, { recursive: true, force: true })
    if (staging && !preserveStaging) rmSync(staging, { recursive: true, force: true })
    rmSync(lock, { recursive: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error('[oc-chan] 本机安装失败，pre-push 将阻止推送：', inspect(error, { depth: null }))
    process.exitCode = 1
  })
}
