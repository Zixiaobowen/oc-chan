import { spawn, execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
for (const argument of args) {
  if (argument !== '--window') throw new Error(`未知开发参数：${argument}；仅支持 --window`)
}
const windowed = args.includes('--window')
let child
let requestedSignal
let forceTimer
let signalError

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code !== 'EPERM') throw error
    // macOS can report EPERM for an exited group. Confirm absence independently.
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024
    })
    const rows = output.trim().split('\n')
    if (rows.length > 16384) throw new Error('进程组核验超出 PID 数量上限', { cause: error })
    const members = rows.map(row => {
      const match = row.match(/^\s*(\d+)\s+(\d+)\s*$/)
      if (!match) throw new Error('进程组核验返回无效 PID 表', { cause: error })
      return { pid: Number(match[1]), group: Number(match[2]) }
    }).filter(row => row.group === pid)
    if (!members.length) {
      console.error(`[oc-chan] 进程组 ${pid} 返回 EPERM；独立 PID 表确认该组已退出`)
      return false
    }
    throw new Error(`无法访问本实例进程组 ${pid}；仍有成员 ${members.map(row => row.pid).join(',')}`, { cause: error })
  }
}

function stop(signal) {
  if (requestedSignal) return
  requestedSignal = signal
  if (!child?.pid) return
  const pid = child.pid
  try { signalGroup(pid, signal) } catch (error) {
    signalError = error
    console.error('[oc-chan] 无法请求开发进程退出：', error)
  }
  forceTimer = setTimeout(() => {
    console.error('[oc-chan] 开发进程未及时退出，终止本实例进程组')
    try { signalGroup(pid, 'SIGKILL') } catch (error) {
      signalError = error
      console.error('[oc-chan] 无法终止开发进程：', error)
    }
  }, 10_000)
  forceTimer.unref()
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal))

async function drainGroup(pid) {
  if (!signalGroup(pid, 'SIGTERM')) return
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (signal === 'SIGKILL') {
      console.error(`[oc-chan] 进程组 ${pid} 清理超时，终止残留子进程`)
      signalGroup(pid, signal)
    }
    const deadline = Date.now() + 5000
    while (signalGroup(pid, 0)) {
      if (Date.now() >= deadline) break
      await delay(100)
    }
    if (!signalGroup(pid, 0)) return
  }
  throw new Error(`本实例进程组 ${pid} 未退出，保留目录供排查`)
}

async function run(command, arguments_, env) {
  if (requestedSignal) return
  child = spawn(command, arguments_, { cwd: root, env, stdio: 'inherit', detached: true })
  console.log(`[oc-chan] 本实例子进程组：${child.pid ?? '启动失败'}`)
  let result
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
  } finally {
    clearTimeout(forceTimer)
    if (child.pid) await drainGroup(child.pid)
    child = undefined
  }
  if (signalError) throw signalError
  if (!requestedSignal && (result.code !== 0 || result.signal)) {
    throw new Error(`开发进程退出：${result.signal ?? result.code}`)
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('当前开发入口仅支持 macOS')
  const instances = path.join(root, '.dev-instances')
  await mkdir(instances, { recursive: true })
  const instance = await mkdtemp(path.join(instances, 'instance-'))
  try {
    for (const name of ['user-data', 'session-data', 'logs']) await mkdir(path.join(instance, name), { mode: 0o700 })
    await writeFile(path.join(instance, 'instance.json'), JSON.stringify({
      launcherPid: process.pid, mode: windowed ? 'window' : 'headless',
      userData: path.join(instance, 'user-data'), sessionData: path.join(instance, 'session-data'),
      outDir: path.join(instance, 'out')
    }, null, 2), { flag: 'wx', mode: 0o600 })
    const env = { ...process.env, OC_CHAN_DEV_INSTANCE: instance, OC_CHAN_HEADLESS: windowed ? '0' : '1' }
    delete env.ELECTRON_RUN_AS_NODE
    console.log(`[oc-chan] ${windowed ? '原生窗口' : '无头'}开发实例：${instance}`)
    console.log(`[oc-chan] 退出：Ctrl+C 或 kill -TERM ${process.pid}；仅清理本实例`)
    console.log('[oc-chan] CDP：读取 Electron 输出的 DevTools listening on ws://127.0.0.1:<port>/devtools/browser/...；使用同一端口的 /json/list 发现 renderer')
    if (windowed && !requestedSignal) {
      await cp(path.join(root, 'resources/tern-navigation/plugin'), path.join(instance, 'tern-navigation/plugin'), { recursive: true })
      await run('/usr/bin/xcrun', [
        'swiftc', '-O', path.join(root, 'src/main/tern-present.swift'),
        '-o', path.join(instance, 'tern-navigation/present-window')
      ], env)
    }
    await run(process.execPath, [
      'node_modules/electron-vite/bin/electron-vite.js', 'dev',
      '--outDir', path.join(instance, 'out'), '--entry', path.join(instance, 'out/main/index.js'),
      '--watch', '--', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'
    ], env)
  } finally {
    if (child?.pid && signalGroup(child.pid, 0)) {
      throw new Error(`开发进程仍存活，保留实例目录供排查：${instance}`)
    }
    await rm(instance, { recursive: true, force: true })
    console.log(`[oc-chan] 已清理开发实例：${instance}`)
  }
  if (requestedSignal) process.exitCode = requestedSignal === 'SIGINT' ? 130 : requestedSignal === 'SIGHUP' ? 129 : 143
}

main().catch(error => {
  console.error('[oc-chan] 开发启动失败：', error)
  process.exitCode = 1
})
