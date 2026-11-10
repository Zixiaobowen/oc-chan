import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { registerDevelopmentInstance, markDevelopmentInstanceStopped, cleanupStoppedDevelopmentInstance } from './local-app-lifecycle.mjs'
import { ROOT, TARGET, NATIVE_RESOURCES, assert, boundedJson, digestFile, developmentBundleLayout, within } from './build-app.mjs'

const execute = promisify(execFile)
export function developmentOptions(args) {
  const options = { window: false, cleanup: true, resumeInstance: undefined }, seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    assert(!seen.has(argument), 'Usage: duplicate development option'); seen.add(argument)
    if (argument === '--window') options.window = true
    else if (argument === '--no-cleanup') options.cleanup = false
    else if (argument === '--resume-instance') {
      const instance = args[++index]
      assert(typeof instance === 'string' && path.isAbsolute(instance) && instance.length <= 4096 && !/[\0\r\n]/.test(instance), 'Usage: --resume-instance requires an absolute instance directory')
      options.resumeInstance = path.resolve(instance)
    } else throw new Error('Usage: node scripts/develop.mjs [--window] [--no-cleanup] [--resume-instance <absolute-instance>]')
  }
  return options
}
export function developmentEnvironment(instance, options, original = process.env) {
  const env = { ...original, OC_CHAN_DEV_INSTANCE: instance, OC_CHAN_PROFILE: path.join(instance, 'profile'),
    OC_CHAN_RESOURCE_DIR: path.join(instance, 'resources'), OC_CHAN_HEADLESS: options.window ? '0' : '1' }
  if (env.OC_CHAN_HOME) assert(path.isAbsolute(env.OC_CHAN_HOME), 'OC_CHAN_HOME must be an absolute acceptance data home')
  for (const key of ['ELECTRON_RUN_AS_NODE', 'OC_CHAN_SOURCE_HOME', 'OC_CHAN_INSTANCE', 'OC_CHAN_RESOURCES_DIR']) delete env[key]
  return env
}
export async function loadDevelopmentBuild(instance, command = execute) {
  const record = await boundedJson(path.join(instance, 'build.json'))
  assert(record.schema === 2 && record.mode === 'development' && record.root === ROOT && record.arch === 'arm64'
    && record.target === TARGET && record.sign === '-' && JSON.stringify(record.features) === JSON.stringify(['acceptance', 'custom-protocol'])
    && typeof record.targetDir === 'string' && path.isAbsolute(record.targetDir) && within(instance, record.targetDir), 'Invalid isolated development build receipt')
  const expected = developmentBundleLayout(instance, record.targetDir), bundle = record.developmentBundle
  assert(bundle && Object.entries(expected).every(([key, value]) => bundle[key] === value) && record.binary === expected.binary, 'Development receipt must name its real isolated application bundle')
  for (const directory of [expected.application, path.dirname(expected.binary), expected.resourcesDir]) {
    const info = await lstat(directory)
    assert(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && await realpath(directory) === directory, 'Development bundle directory escaped its owned path')
  }
  const verify = async (filename, identity, maximum) => {
    assert(await realpath(filename) === filename, `Development bundle file escaped its owned path: ${filename}`)
    const actual = await digestFile(filename, 'sha256', maximum)
    assert(actual.digest === identity?.digest && actual.bytes === identity?.bytes, `Development bundle file differs from its build receipt: ${filename}`)
  }
  const plist = path.join(expected.application, 'Contents/Info.plist')
  await verify(expected.binary, record.binaryIdentity)
  await verify(plist, bundle.infoPlistIdentity, 64 * 1024)
  const { stdout } = await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { timeout: 10_000, maxBuffer: 64 * 1024 })
  const identity = JSON.parse(stdout)
  assert(identity.CFBundleIdentifier === expected.identifier && identity.CFBundleExecutable === 'oc-chan'
    && identity.CFBundlePackageType === 'APPL' && identity.CFBundleShortVersionString === record.version && identity.LSUIElement === true, 'Invalid development application Info.plist')
  assert(record.resources && typeof record.resources === 'object' && !Array.isArray(record.resources)
    && Object.keys(record.resources).length <= 22 && [...NATIVE_RESOURCES, 'tern-navigation/plugin/plugin.toml', 'tern-navigation/plugin/window.luau', 'plugin-market/catalog.json', 'rust-dependencies/manifest.json'].every(name => record.resources[name])
    && record.catalogSha256 === record.resources['plugin-market/catalog.json'].digest, 'Invalid development resource receipt')
  for (const [filename, identity] of Object.entries(record.resources)) {
    assert(filename && !filename.includes('..') && !path.isAbsolute(filename), 'Invalid development resource receipt path')
    await verify(path.join(expected.resourcesDir, filename), identity)
  }
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', expected.application], { timeout: 120_000, maxBuffer: 128 * 1024 })
  return record
}
export function parseProcesses(output) {
  const rows = output.trim() ? output.trim().split('\n') : []
  assert(rows.length <= 16384, 'Process enumeration exceeds ownership budget')
  return rows.map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/)
    assert(match && Number.isFinite(Date.parse(match[4])), 'Invalid process birth/ownership table')
    return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), birth: match[4] }
  })
}
async function processes() {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })
  return parseProcesses(stdout)
}
export function observeGroup(rows, group, known, firstBirth) {
  const byPid = new Map(rows.map(row => [row.pid, row])), ownership = new Map()
  if (!known.size) {
    const leader = byPid.get(group)
    if (leader) { assert(Date.parse(leader.birth) >= firstBirth - 2000, 'Child PID was reused before registration'); known.set(leader.pid, leader.birth) }
  }
  function own(row, visiting = new Set()) {
    if (known.has(row.pid)) { assert(known.get(row.pid) === row.birth, 'Owned process PID was reused'); return true }
    if (ownership.has(row.pid)) return ownership.get(row.pid)
    if (visiting.has(row.pid) || visiting.size >= 64) return false
    visiting.add(row.pid); const parent = byPid.get(row.parent)
    const owned = Boolean(parent && own(parent, visiting)); ownership.set(row.pid, owned)
    if (owned) { assert(known.size < 4096, 'Owned descendant budget exceeded'); known.set(row.pid, row.birth) }
    return owned
  }
  const members = []
  for (const row of rows) {
    const owned = own(row)
    if (row.group === group) assert(owned, 'Cannot prove descendant birth identity; preserving the development instance')
    if (owned) members.push(row)
  }
  for (const pid of known.keys()) if (!byPid.has(pid)) known.delete(pid)
  return members
}
export async function launchDevelopment(options) {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Development requires native macOS arm64')
  const instances = path.join(ROOT, '.dev-instances'); await mkdir(instances, { recursive: true, mode: 0o700 })
  const directory = await lstat(instances)
  assert(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid() && !(directory.mode & 0o077), 'Development instance root must be a private owned directory')
  const resume = options.resumeInstance !== undefined
  const instance = resume ? path.resolve(options.resumeInstance) : await mkdtemp(path.join(instances, 'instance-'))
  assert(path.dirname(instance) === instances && /^instance-[\w-]+$/.test(path.basename(instance)), 'Resume must name a direct owned development instance')
  let requestedSignal, interrupt, drained = true
  const signal = name => { requestedSignal ??= name; interrupt?.() }
  const onInterrupt = () => signal('SIGINT'), onTerminate = () => signal('SIGTERM')
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate)
  async function runOwned(file, args, env, stage) {
    if (requestedSignal) return
    const launchedAt = Date.now(), known = new Map(); let signalExit, spawnError, monitorError
    const interrupted = new Promise(resolve => { signalExit = resolve }); interrupt = signalExit
    const child = spawn(file, args, { cwd: ROOT, env, stdio: 'inherit', detached: true }); drained = false
    const completion = new Promise(resolve => {
      child.once('error', error => { spawnError = error })
      child.once('close', (code, termination) => resolve({ code, termination }))
    })
    if (!child.pid) { await completion; drained = true; throw spawnError ?? new Error('Development child did not start') }
    if (stage === 'app' && env.OC_CHAN_PERFORMANCE === '1') console.log(`__OC_PERF_STAGE__${JSON.stringify({ performanceStage: 'app-spawn', atMs: launchedAt, pid: child.pid })}`)
    let pending, ended = false
    const refresh = () => {
      if (ended) return Promise.resolve([])
      if (!pending) pending = processes().then(rows => {
        const members = observeGroup(rows, child.pid, known, launchedAt)
        if (!members.length) ended = true
        return members
      }).finally(() => { pending = undefined })
      return pending
    }
    const timer = setInterval(() => { refresh().catch(error => { monitorError ??= error; signalExit() }) }, 200)
    try {
      await refresh()
      await Promise.race([completion, interrupted])
      clearInterval(timer)
      let members = await refresh(); const deadline = Date.now() + 20000; let forced = false; const sent = new Map()
      while (members.length) {
        const leaderAlive = members.some(member => member.pid === child.pid)
        // Every signal names an observed PID plus its unchanged birth, so a
        // disappearing leader never authorizes signaling an unrelated group.
        for (const member of members) {
          if (!forced && leaderAlive && member.pid !== child.pid) continue
          const termination = forced ? 'SIGKILL' : 'SIGTERM'
          if (sent.get(member.pid) === termination) continue
          const current = (await processes()).find(row => row.pid === member.pid)
          if (!current) continue
          assert(current.birth === member.birth && current.group === member.group, 'Process identity changed before termination')
          try { process.kill(member.pid, termination); sent.set(member.pid, termination) } catch (error) { if (error.code !== 'ESRCH') throw error }
        }
        await delay(100); members = await refresh()
        if (Date.now() >= deadline && !forced) forced = true
        if (forced && Date.now() >= deadline + 5000 && members.length) throw new Error('Owned descendants did not exit; preserving the development instance')
      }
      const result = await completion
      if (monitorError) throw monitorError
      drained = true
      if (forced) throw new Error('Development child exceeded graceful shutdown deadline and required termination')
      if (spawnError) throw spawnError
      if (!requestedSignal && (result.code !== 0 || result.termination)) throw new Error(`Development child exited: ${result.termination ?? result.code}`)
    } finally { clearInterval(timer); interrupt = undefined }
  }
  let failure, registered = false
  try {
    await registerDevelopmentInstance({ root: ROOT, instance, resume }); registered = true
    if (!resume) await mkdir(path.join(instance, 'profile'), { mode: 0o700 })
    const env = developmentEnvironment(instance, options)
    if (resume) delete env.OC_CHAN_ACCEPTANCE_SETTINGS
    console.log(`[oc-chan] 独立 Rust 实例：${instance}`)
    if (!resume) {
      if (env.OC_CHAN_PERFORMANCE === '1') console.log(`__OC_PERF_STAGE__${JSON.stringify({ performanceStage: 'build-start', atMs: Date.now() })}`)
      await runOwned(process.execPath, [path.join(ROOT, 'scripts/build-app.mjs'), '--development-instance', instance], env, 'build')
      if (env.OC_CHAN_PERFORMANCE === '1') console.log(`__OC_PERF_STAGE__${JSON.stringify({ performanceStage: 'build-end', atMs: Date.now() })}`)
    }
    if (!requestedSignal) {
      const record = await loadDevelopmentBuild(instance)
      env.OC_CHAN_RESOURCE_DIR = record.developmentBundle.resourcesDir
      console.log(`[oc-chan] ${options.window ? '窗口' : '无头'}模式；Ctrl+C 停止并排空本实例`)
      await runOwned(record.binary, [], env, 'app')
    }
  } catch (error) { failure = error }
  finally {
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate)
    if (drained && registered) {
      try {
        await markDevelopmentInstanceStopped({ root: ROOT, instance })
        if (options.cleanup) { await cleanupStoppedDevelopmentInstance({ root: ROOT, instance }); console.log(`[oc-chan] 已清理本实例：${instance}`) }
        else console.log(`[oc-chan] 已保留实例：${instance}（--no-cleanup）`)
      } catch (error) { failure = failure ? new AggregateError([failure, error], 'Development and owned-instance cleanup failed') : error }
    } else console.log(`[oc-chan] 已保留实例：${instance}（${registered ? '进程尚未确认排空' : '未取得实例所有权'}）`)
  }
  if (failure) throw failure
  if (requestedSignal) process.exitCode = requestedSignal === 'SIGINT' ? 130 : 143
  return instance
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) launchDevelopment(developmentOptions(process.argv.slice(2))).catch(error => { console.error('[oc-chan] Rust 开发启动失败：', error); process.exitCode = 1 })
