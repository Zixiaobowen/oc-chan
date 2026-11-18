import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { until } from './core.mjs'
import { prepareFixtures } from './fixtures.mjs'

export async function prepareSmokeFixtures(directory, seed = 20261104, sessionCount = 32) {
  assert([32, 128].includes(sessionCount), 'Fixture sessions must be 32 or 128')
  const manifest = await prepareFixtures(directory, { seed, now: Date.now() })
  const taskDocument = JSON.parse(await readFile(manifest.jobsFile, 'utf8'))
  const detailPrompt = '检查项目每日构建结果，列出失败原因与需要人工处理的事项。\n保留原始错误信息，不执行部署。\n' + '这是一段用于验证窄窗口换行的任务说明。'.repeat(24) + '\n/workspace/' + 'unbroken-path-segment'.repeat(12)
  Object.assign(taskDocument.jobs[0], { prompt: detailPrompt, workdir: manifest.root, model: 'acceptance-detail-model' })
  await writeFile(manifest.jobsFile, JSON.stringify(taskDocument) + '\n', { mode: 0o600 })
  manifest.taskDetail = { prompt: detailPrompt, workdir: manifest.root, model: 'acceptance-detail-model' }
  const fixtureModel = `acceptance-fixture-${randomUUID()}`
  const sessions = path.join(manifest.home, '.omp/agent/sessions')
  const owners = path.join(manifest.home, '.omp/run/session-owners')
  const hosts = path.join(manifest.home, '.omp/run/collab-hosts')
  const entry = path.join(manifest.root, '@oh-my-pi/pi-coding-agent/dist/cli.js')
  for (const item of [sessions, owners, hosts, path.dirname(entry)]) await mkdir(item, { recursive: true, mode: 0o700 })
  await writeFile(path.join(path.dirname(path.dirname(entry)), 'package.json'), JSON.stringify({ type:'module', private:true }), { flag:'wx', mode:0o600 })
  await writeFile(entry, `import fs from 'node:fs'
const fds = []
let closing = false, adoptionTimer
function close(error) {
  if (closing) return
  closing = true
  clearTimeout(adoptionTimer)
  const failures = error ? [error] : []
  for (const fd of fds) {
    try { fs.closeSync(fd) } catch (failure) { failures.push(failure) }
  }
  if (failures.length) {
    const message = failures.map(failure => String(failure.message).slice(0, 128)).join('; ').slice(0, 2048)
    process.stderr.write('Fixture failure: ' + message + '\\n', () => process.exit(1))
  } else process.exit(0)
}
process.stdin.on('end', () => close())
process.stdin.on('error', close)
process.on('SIGTERM', () => close())
process.on('SIGINT', () => close())
process.stdin.resume()
try {
  for (const file of JSON.parse(process.env.OC_ACCEPTANCE_FILES)) fds.push(fs.openSync(file, 'r+'))
  const deadline = Date.now() + 3000
  function awaitAdoption() {
    if (closing) return
    if (process.ppid === 1) {
      process.stdout.write(JSON.stringify({ protocol: 'OC_CHAN_FIXTURE_READY_V1', pid: process.pid, ppid: process.ppid }) + '\\n')
    } else if (Date.now() >= deadline) close(new Error('Fixture adoption deadline exceeded; ppid=' + process.ppid))
    else adoptionTimer = setTimeout(awaitAdoption, 20)
  }
  awaitAdoption()
} catch (error) { close(error) }
`, { flag: 'wx', mode: 0o600 })
  // Only the launcher is our ChildProcess. Its inherited pipes keep the real fixture
  // reachable after adoption by PID 1, and smoke exit naturally delivers stdin EOF.
  const launcherSource = `import { spawn } from 'node:child_process'
try {
  const child = spawn(process.execPath, [process.argv[1]], { stdio: [0, 1, 2] })
  child.once('error', error => {
    process.exitCode = 1
    process.stderr.write('Fixture launcher failure: ' + String(error.message).slice(0, 1024) + '\\n')
  })
  child.once('spawn', () => child.unref())
} catch (error) {
  process.exitCode = 1
  process.stderr.write('Fixture launcher failure: ' + String(error.message).slice(0, 1024) + '\\n')
}`
  const children = []; const ids = []; const files = []
  const pidExists = pid => {
    try { process.kill(pid, 0); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  let stopPromise
  const stop = () => stopPromise ??= (async () => {
    // End every pipe before waiting, including launchers whose fixture is not ready.
    for (const state of children) {
      state.stopping = true
      try { state.stdin.end() } catch (error) { state.fail('stdin-end', error) }
    }
    const results = await Promise.all(children.map(async state => {
      const failures = []
      try {
        await until(() => state.launcherDone && state.child.stdout.closed && state.child.stderr.closed, { timeout: 5000 })
      } catch (error) {
        failures.push(new Error(`Fixture ${state.pid ?? 'not ready'} inherited output pipes or launcher did not close; preserving process`, { cause: error }))
      }
      if (state.pid !== undefined) {
        try { await until(() => !pidExists(state.pid), { timeout: 5000 }) }
        catch (error) {
          failures.push(new Error(`Fixture PID ${state.pid} still exists, was reused, or could not be inspected; preserving process without signalling`, { cause: error }))
        }
      }
      return [...state.failures.values(), ...failures]
    }))
    const failures = results.flat()
    if (failures.length) throw new AggregateError(failures, 'Fixture process cleanup failed')
  })()
  try {
    for (let branch = 0; branch < sessionCount / 8; branch++) {
      const mainId = randomUUID(), rootFile = path.join(sessions, mainId + '.jsonl'), branchDirectory = path.join(sessions, mainId)
      await mkdir(branchDirectory, { mode: 0o700 })
      const descriptors = []
      for (let index = 0; index < 8; index++) {
        const id = index ? randomUUID() : mainId
        const file = index ? path.join(branchDirectory, `worker-${index}.jsonl`) : rootFile
        const header = { type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: manifest.root, ...(index ? { parentSession: rootFile } : {}) }
        await writeFile(file, JSON.stringify(header) + '\n' + JSON.stringify({ type: 'model_change', model: fixtureModel }) + '\n', { flag: 'wx', mode: 0o600 })
        const lease = path.join(owners, id + '.lock')
        await writeFile(lease, '', { flag: 'wx', mode: 0o600 })
        descriptors.push(file, lease); ids.push(`omp:${id}`); files.push(file)
      }
      const child = spawn(process.execPath, ['--input-type=module', '-e', launcherSource, entry], { cwd: manifest.root, env: { PATH: process.env.PATH, HOME: manifest.home, OC_ACCEPTANCE_FILES: JSON.stringify(descriptors) }, stdio: ['pipe', 'pipe', 'pipe'] })
      // Node automatically destroys child.stdin when the launcher exits. Transfer
      // ownership so only smoke closes the inherited input pipe and delivers EOF.
      const state = { child, stdin: child.stdin, pid: undefined, launcherDone: false, stopping: false, failures: new Map(), rejectStartup: undefined }
      child.stdin = null
      state.fail = (kind, error) => {
        if (!state.failures.has(kind)) state.failures.set(kind, error)
        state.rejectStartup?.(error)
      }
      children.push(state)
      await new Promise((resolve, reject) => {
        let output = Buffer.alloc(0), totalBytes = 0, ready = false, settled = false
        const timer = setTimeout(() => done(new Error('Fixture process readiness deadline')), 5000)
        const done = error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          state.rejectStartup = undefined
          error ? reject(error) : resolve()
        }
        state.rejectStartup = done
        const maybeReady = () => {
          if (ready && state.launcherDone && state.failures.size === 0) done()
        }
        child.once('error', error => { state.launcherDone = true; state.fail('launcher-error', error) })
        child.once('exit', (code, signal) => {
          state.launcherDone = true
          if (code !== 0 || signal !== null) state.fail('launcher-exit', new Error(`Fixture launcher exited unsuccessfully: code=${code}, signal=${signal}`))
          else maybeReady()
        })
        state.stdin.on('error', error => state.fail('stdin-error', error))
        for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
          stream.on('error', error => state.fail(`${name}-error`, error))
          stream.once('close', () => {
            if (!state.stopping) state.fail(`${name}-close`, new Error(`Fixture ${state.pid ?? 'not ready'} ${name} closed unexpectedly`))
          })
        }
        const admitOutput = chunk => {
          totalBytes = Math.min(4097, totalBytes + chunk.length)
          if (totalBytes <= 4096) return true
          state.fail('output-limit', new Error('Fixture stdout/stderr exceeds 4096 bytes'))
          return false
        }
        child.stderr.on('data', chunk => {
          if (admitOutput(chunk)) state.fail('stderr', new Error(`Fixture stderr: ${chunk.toString('utf8').slice(0, 2048)}`))
        })
        child.stdout.on('data', chunk => {
          if (!admitOutput(chunk)) return
          try {
            assert(!ready, 'Fixture emitted output after READY')
            output = Buffer.concat([output, chunk])
            const end = output.indexOf(10)
            if (end < 0) return
            assert.equal(end + 1, output.length, 'Unexpected additional fixture response')
            const message = JSON.parse(output.subarray(0, end).toString('utf8'))
            assert(message !== null && typeof message === 'object' && !Array.isArray(message), 'Invalid fixture READY object')
            assert.equal(Object.keys(message).sort().join(','), 'pid,ppid,protocol', 'Invalid fixture READY fields')
            assert.equal(message.protocol, 'OC_CHAN_FIXTURE_READY_V1')
            assert(Number.isSafeInteger(message.pid) && message.pid > 1 && message.pid <= 2147483647 && message.pid !== child.pid && message.pid !== process.pid, 'Invalid real fixture PID')
            assert.equal(message.ppid, 1, 'Fixture still has a CLI ancestor')
            state.pid = message.pid
            ready = true
            maybeReady()
          } catch (error) { state.fail('ready-protocol', error) }
        })
      })
    }
    const failures = children.flatMap(state => [...state.failures.values()])
    if (failures.length) throw new AggregateError(failures, 'Fixture failed during startup')
    return Object.assign(manifest, { agentIds: ids, agentFiles: files, agentPids: children.map(state => state.pid), fixtureModel, stopAgents: stop })
  } catch (error) { try { await stop() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Fixture startup and cleanup failed') } throw error }
}
