import { spawn, execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { registerDevelopmentInstance } from './local-app-lifecycle.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const options = new Set(process.argv.slice(2))
for (const option of options) {
  if (!['--window', '--inspect'].includes(option)) throw new Error(`未知开发参数：${option}；支持 --window、--inspect`)
}
const windowed = options.has('--window')
const smokeConfig = process.env.OC_CHAN_SMOKE_CONFIG
if (windowed && (process.env.OC_CHAN_PERFORMANCE_CONFIG || smokeConfig)) throw new Error('验收仅允许独立无头实例')
if (smokeConfig && smokeConfig !== process.env.OC_CHAN_PERFORMANCE_CONFIG) throw new Error('Smoke 配置必须与性能 fixture 配置一致')
let child
let requestedSignal
let forceTimer

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') {
      // A disappearing macOS process group can reject kill(0). Verify absence
      // independently; a real member or a failed enumeration still aborts cleanup.
      const output = execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 })
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
      throw new Error(`进程组 ${pid} 无权访问；仍有成员 ${members.map(row => row.pid).join(',')}，保留实例`, { cause: error })
    }
    throw error
  }
}

function stop(signal) {
  if (requestedSignal) return
  requestedSignal = signal
  if (!child?.pid) return
  signalGroup(child.pid, signal)
  forceTimer = setTimeout(() => {
    console.error('[oc-chan] 开发进程未及时退出，终止本实例进程组')
    signalGroup(child.pid, 'SIGKILL')
  }, 10_000)
  forceTimer.unref()
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal))

async function run(args, env) {
  if (requestedSignal) return
  child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', detached: true })
  if (smokeConfig) console.log(`[oc-chan] 验收子进程组：${child.pid}`)
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(forceTimer)
  // electron-vite and native compiler descendants must exit before their files are removed.
  if (signalGroup(child.pid, 'SIGTERM')) {
    const deadline = Date.now() + 5_000
    while (signalGroup(child.pid, 0)) {
      if (Date.now() >= deadline) {
        signalGroup(child.pid, 'SIGKILL')
        throw new Error('子进程退出超时；已终止本实例进程组')
      }
      await delay(100)
    }
  }
  child = undefined
  if (!requestedSignal && (result.code !== 0 || result.signal)) {
    throw new Error(`开发进程退出：${result.signal ?? result.code}`)
  }
}

async function readBoundedFile(filename, limit) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error('验收配置文件超出预算或不是普通文件')
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== info.size) throw new Error('验收配置文件读取期间发生变化')
    return bytes.subarray(0, offset)
  } finally { await file.close() }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('当前开发入口仅支持 macOS')
  const instances = path.join(root, '.dev-instances')
  await mkdir(instances, { recursive: true })
  const instance = await mkdtemp(path.join(instances, 'instance-'))
  try {
    await registerDevelopmentInstance({ root, instance })
    for (const name of ['user-data', 'session-data']) await mkdir(path.join(instance, name))
    const pluginDirectory = path.join(instance, 'resources/tern-navigation/plugin')
    await mkdir(pluginDirectory, { recursive: true })
    for (const name of ['plugin.toml', 'window.luau']) {
      await copyFile(path.join(root, 'resources/tern-navigation/plugin', name), path.join(pluginDirectory, name), constants.COPYFILE_EXCL)
    }
    if (process.env.OC_CHAN_PERFORMANCE_CONFIG) {
      const smoke = smokeConfig ? JSON.parse((await readBoundedFile(smokeConfig, 128 * 1024)).toString('utf8')).smoke : undefined
      if (smokeConfig && (!smoke || typeof smoke.exitReport !== 'string' || !path.isAbsolute(smoke.exitReport)))
        throw new Error('无效 Smoke 配置')
      const seed = smoke?.settingsSeed
      if (seed !== undefined && (typeof seed !== 'string' || !path.isAbsolute(seed))) throw new Error('无效 Smoke 设置种子')
      const initial = seed ? await readBoundedFile(seed, 64 * 1024) : Buffer.from(JSON.stringify({
        appearance: 'light', language: 'zh-CN', textSize: 'default', uiFont: 'system', codeFont: 'system', showDock: false, preventSleep: false
      }))
      const settings = JSON.parse(initial.toString('utf8'))
      if (settings.showDock !== false || settings.preventSleep !== false) throw new Error('无头验收设置必须关闭 Dock 与阻止睡眠')
      await writeFile(path.join(instance, 'user-data/settings.json'), initial, { flag: 'wx', mode: 0o600 })
      if (smoke?.pluginSeed !== undefined) {
        if (smoke.marketplace !== true || typeof smoke.pluginSeed !== 'string' || !path.isAbsolute(smoke.pluginSeed)) throw new Error('无效 Smoke 插件种子')
        const packageBytes = await readBoundedFile(smoke.pluginSeed, 2 * 1024 * 1024)
        await mkdir(path.join(instance, 'user-data/plugins'), { mode: 0o700 })
        await writeFile(path.join(instance, 'user-data/plugins/system.ocplugin'), packageBytes, { flag: 'wx', mode: 0o600 })
      }
    }
    const env = { ...process.env, OC_CHAN_DEV_INSTANCE: instance, OC_CHAN_HEADLESS: windowed ? '0' : '1' }
    delete env.ELECTRON_RUN_AS_NODE
    console.log(`[oc-chan] ${windowed ? '原生窗口' : '无头'}开发实例：${instance}`)
    if (windowed) await run(['scripts/build-native.mjs'], env)
    else await run(['scripts/build-glass.mjs'], env)
    await run(['scripts/build-plugin-market.mjs', path.join(instance, 'out/plugin-market')], env)
    await run([
      'node_modules/electron-vite/bin/electron-vite.js', 'dev',
      ...(smokeConfig ? ['--config', 'scripts/smoke/vite.config.mjs'] : process.env.OC_CHAN_PERFORMANCE_CONFIG ? ['--config', 'scripts/performance/vite.config.mjs'] : []),
      '--outDir', path.join(instance, 'out'), '--entry', path.join(instance, 'out/main/index.js'),
      '--watch', '--', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      ...(process.env.OC_CHAN_INSTALL_CHECK ? [`--oc-chan-install-check=${process.env.OC_CHAN_INSTALL_CHECK}`] : []),
      ...(options.has('--inspect') ? ['--inspect=0'] : [])
    ], env)
  } finally {
    if (child?.pid && signalGroup(child.pid, 0)) {
      throw new Error(`开发进程仍存活，保留实例目录供排查：${instance}`)
    }
    await rm(instance, { recursive: true, force: true })
    console.log(`[oc-chan] 已清理开发实例：${instance}`)
  }
  if (requestedSignal) process.exitCode = requestedSignal === 'SIGINT' ? 130 : 143
}

main().catch(error => {
  console.error('[oc-chan] 开发启动失败：', error)
  process.exitCode = 1
})
