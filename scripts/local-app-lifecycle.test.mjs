import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const source = fileURLToPath(new URL('./local-app-lifecycle.mjs', import.meta.url))
const mac = { skip: process.platform !== 'darwin', timeout: 60000 }

async function fixture(t) {
  const temporary = await mkdtemp(path.join(await realpath(tmpdir()), 'oc-chan-lifecycle-'))
  const root = path.join(temporary, 'repo')
  await mkdir(path.join(root, 'scripts'), { recursive: true })
  await run('git', ['init', '--quiet', root], { timeout: 8000 })
  await copyFile(source, path.join(root, 'scripts/local-app-lifecycle.mjs'))
  const children = []
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
    await rm(temporary, { recursive: true, force: true })
  })
  const api = await import(pathToFileURL(path.join(root, 'scripts/local-app-lifecycle.mjs')).href)
  return { temporary, root, api, children }
}
async function application(root, relative = 'release/mac-arm64/OC Chan.app', identifier = 'local.oc-chan.desktop') {
  const app = path.join(root, relative)
  await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true })
  await writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>OC Chan</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
  await copyFile('/bin/sleep', path.join(app, 'Contents/MacOS/OC Chan'))
  return app
}
async function exists(filename) {
  try { await lstat(filename); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
async function launcher(f, { cleanup = true } = {}) {
  const instance = path.join(f.root, '.dev-instances', 'instance-owned')
  await mkdir(instance, { recursive: true })
  await writeFile(path.join(f.root, 'scripts/develop.mjs'), `
import { registerDevelopmentInstance } from './local-app-lifecycle.mjs'
import { rm, writeFile } from 'node:fs/promises'
const root = process.cwd()
const instance = ${JSON.stringify(instance)}
await registerDevelopmentInstance({ root, instance })
process.on('SIGTERM', async () => {
  await writeFile(root + '/launcher-stopped.json', JSON.stringify({ signal: 'SIGTERM', pid: process.pid }))
  if (${cleanup}) await rm(instance, { recursive: true })
  process.exit(0)
})
setInterval(() => {}, 1000)
process.stdout.write('ready\\n')
`)
  const child = spawn(process.execPath, ['scripts/develop.mjs'], { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] })
  f.children.push(child)
  await new Promise((resolve, reject) => {
    let output = '', error = ''
    const timer = setTimeout(() => reject(new Error(`launcher ready timeout: ${error}`)), 15000)
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready\n')) { clearTimeout(timer); resolve() } })
    child.stderr.on('data', chunk => { error += chunk; if (error.length > 16384) { clearTimeout(timer); reject(new Error('launcher stderr budget')) } })
    child.once('error', failure => { clearTimeout(timer); reject(failure) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`launcher exited ${code}: ${error}`)) })
  })
  return { child, instance, owner: path.join(instance, 'owner.json') }
}

test('preview is read-only; apply removes only verified application leaves', mac, async t => {
  const f = await fixture(t)
  const app = await application(f.root)
  const other = await application(f.root, 'release/Other.app', 'org.example.other')
  const keep = ['release/archive.zip', 'release/archive.dmg', 'release/delivery.json', 'release/evidence.log', 'src/index.ts', 'node_modules/package/index.js']
  for (const relative of keep) {
    await mkdir(path.dirname(path.join(f.root, relative)), { recursive: true })
    await writeFile(path.join(f.root, relative), relative)
  }
  const before = await lstat(app)
  const preview = await f.api.cleanupLocalWorktree({ root: f.root })
  assert.equal(preview.apply, false)
  assert.deepEqual(preview.applications, [{ application: app, removed: false }])
  assert.equal((await lstat(app)).ino, before.ino)
  const result = await f.api.cleanupLocalWorktree({ root: f.root, apply: true })
  assert.equal(result.applications[0].removed, true)
  assert.equal(result.applications[0].registration, 'not-registered')
  assert.equal(await exists(app), false)
  assert.equal(await exists(other), true)
  for (const relative of keep) assert.equal(await readFile(path.join(f.root, relative), 'utf8'), relative)
})

test('installer consumer rejects installed, outside-release and unrelated workspace paths', mac, async t => {
  const f = await fixture(t)
  await assert.rejects(f.api.cleanupBuildApplication({ root: f.root, application: '/Applications/OC Chan.app' }), /release/)
  const outside = await application(f.root, 'outside/OC Chan.app')
  await assert.rejects(f.api.cleanupBuildApplication({ root: f.root, application: outside }), /release/)
  const stranger = path.join(f.temporary, 'stranger')
  await run('git', ['init', '--quiet', stranger])
  const unrelated = await application(stranger)
  await assert.rejects(f.api.cleanupBuildApplication({ root: stranger, application: unrelated }), /不属于本仓库/)
  assert.equal(await exists(outside), true)
  assert.equal(await exists(unrelated), true)
  const nested = await application(f.root, 'release/Other.app/Contents/OC Chan.app')
  await assert.rejects(f.api.cleanupBuildApplication({ root: f.root, application: nested }), /父目录越界/)
  assert.equal(await exists(nested), true)
})

test('installer consumer cleans a verified release bundle without requiring a commit', mac, async t => {
  const f = await fixture(t)
  const app = await application(f.root)
  const result = await f.api.cleanupBuildApplication({ root: f.root, application: app })
  assert.equal(result.registration, 'not-registered')
  assert.equal(await exists(app), false)
})

test('registered application is unregistered before removal while another registration remains', mac, async t => {
  const f = await fixture(t)
  const app = await application(f.root)
  const other = await application(f.root, 'release/other/OC Chan.app')
  const registrar = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  await run(registrar, ['-f', app, other], { timeout: 8000 })
  const result = await f.api.cleanupBuildApplication({ root: f.root, application: app })
  assert.equal(result.registration, 'unregistered')
  assert.equal(await exists(app), false)
  assert.equal(await exists(other), true)
  // A second successful unregister proves the first removal left this record intact.
  await run(registrar, ['-u', other], { timeout: 8000 })
})

test('same-repository registered worktrees are accepted, subdirectories are rejected', mac, async t => {
  const f = await fixture(t)
  await run('git', ['-C', f.root, '-c', 'user.name=Lifecycle Test', '-c', 'user.email=lifecycle@example.invalid', 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'fixture'])
  const linked = path.join(f.temporary, 'linked')
  await run('git', ['-C', f.root, 'worktree', 'add', '--detach', linked])
  const app = await application(linked)
  await f.api.cleanupBuildApplication({ root: linked, application: app })
  assert.equal(await exists(app), false)
  await assert.rejects(f.api.cleanupLocalWorktree({ root: path.join(linked, 'release') }), /未登记/)
})

test('wrong bundle identifier and executable identity preserve application', mac, async t => {
  const f = await fixture(t)
  const app = await application(f.root, undefined, 'org.example.foreign')
  await assert.rejects(f.api.cleanupLocalWorktree({ root: f.root, apply: true }), /bundle 身份/)
  await application(f.root)
  await writeFile(path.join(app, 'Contents/MacOS/OC Chan'), '#!/bin/sh\nexit 0\n')
  await assert.rejects(f.api.cleanupBuildApplication({ root: f.root, application: app }), /Mach-O/)
  assert.equal(await exists(app), true)
})

test('symlinked roots, ancestors, bundle leaves and escaping internal links are refused', mac, async t => {
  const f = await fixture(t)
  const app = await application(f.root)
  const alias = path.join(f.temporary, 'alias')
  await symlink(f.root, alias)
  await assert.rejects(f.api.cleanupLocalWorktree({ root: alias, apply: true }), /符号链接/)
  const leaf = path.join(f.root, 'release/alias')
  await symlink(path.dirname(app), leaf)
  await assert.rejects(f.api.cleanupBuildApplication({ root: f.root, application: path.join(leaf, 'OC Chan.app') }), /符号链接/)
  await rm(leaf)
  await symlink(f.root, path.join(app, 'Contents/escape'))
  await assert.rejects(f.api.cleanupBuildApplication({ root: f.root, application: app }), /越界符号链接/)
  await rm(path.join(app, 'Contents/escape'))
  const outside = await application(f.root, 'outside/OC Chan.app')
  await symlink(outside, path.join(f.root, 'release/OC Chan.app'))
  await assert.rejects(f.api.cleanupLocalWorktree({ root: f.root, apply: true }), /符号链接/)
  assert.equal(await exists(app), true)
  assert.equal(await exists(outside), true)
})

test('release depth and node budgets fail before deleting valid candidates', mac, async t => {
  const f = await fixture(t)
  const app = await application(f.root)
  const deep = path.join(f.root, 'release/a/b/c/d/e/f')
  await mkdir(deep, { recursive: true })
  await assert.rejects(f.api.cleanupLocalWorktree({ root: f.root, apply: true }), /深度超出预算/)
  await rm(path.join(f.root, 'release/a'), { recursive: true })
  for (let index = 0; index < 4097; index++) await writeFile(path.join(f.root, 'release', `entry-${index}`), '')
  await assert.rejects(f.api.cleanupLocalWorktree({ root: f.root, apply: true }), /节点超出预算/)
  assert.equal(await exists(app), true)
})

test('candidate count budget fails without deleting earlier candidates', mac, async t => {
  const f = await fixture(t)
  for (let index = 0; index < 33; index++) await application(f.root, `release/target-${index}/OC Chan.app`)
  await assert.rejects(f.api.cleanupLocalWorktree({ root: f.root, apply: true }), /候选数量超出预算/)
  assert.equal(await exists(path.join(f.root, 'release/target-0/OC Chan.app')), true)
})

test('running bundle is retained without terminating its process', mac, async t => {
  const f = await fixture(t)
  const app = await application(f.root)
  const child = spawn(path.join(app, 'Contents/MacOS/OC Chan'), ['60'], { stdio: 'ignore' })
  f.children.push(child)
  await once(child, 'spawn')
  await assert.rejects(f.api.cleanupBuildApplication({ root: f.root, application: app }), /运行进程/)
  assert.equal(process.kill(child.pid, 0), true)
  assert.equal(await exists(app), true)
})

test('registered running owner is previewed without signals then stopped through its handler', mac, async t => {
  const f = await fixture(t)
  const { child, instance } = await launcher(f)
  const preview = await f.api.cleanupLocalWorktree({ root: f.root })
  assert.equal(preview.instances[0].running, true)
  assert.equal(await exists(path.join(f.root, 'launcher-stopped.json')), false)
  assert.equal(process.kill(child.pid, 0), true)
  const result = await f.api.cleanupLocalWorktree({ root: f.root, apply: true })
  assert.equal(result.instances[0].removed, true)
  assert.equal(await exists(instance), false)
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'launcher-stopped.json'))), { signal: 'SIGTERM', pid: child.pid })
})

test('real development launcher signals descendants once and waits for their graceful exit', mac, async t => {
  const f = await fixture(t)
  await copyFile(new URL('./develop.mjs', import.meta.url), path.join(f.root, 'scripts/develop.mjs'))
  const resources = path.join(f.root, 'resources/tern-navigation/plugin')
  await mkdir(resources, { recursive: true })
  for (const name of ['plugin.toml', 'window.luau']) {
    await copyFile(new URL(`../resources/tern-navigation/plugin/${name}`, import.meta.url), path.join(resources, name))
  }
  // Replace the external build/watch commands with a real process group whose
  // leader exits before its descendant finishes an asynchronous shutdown.
  await writeFile(path.join(f.root, 'scripts/build-glass.mjs'), 'process.exit(0)\n')
  await writeFile(path.join(f.root, 'scripts/draining-worker.mjs'), `
import { writeFileSync } from 'node:fs'
let signals = 0
process.on('SIGTERM', () => {
  writeFileSync('termination-count', String(++signals))
  if (signals === 1) setTimeout(() => process.exit(0), 750)
})
setTimeout(() => process.exit(2), 10000)
process.stdout.write('draining-worker-ready\\n')
`)
  const runner = path.join(f.root, 'node_modules/electron-vite/bin')
  await mkdir(runner, { recursive: true })
  await writeFile(path.join(runner, 'electron-vite.js'), `
const { spawn } = require('node:child_process')
process.on('SIGTERM', () => process.exit(0))
spawn(process.execPath, ['scripts/draining-worker.mjs'], { stdio: 'inherit' })
`)
  const child = spawn(process.execPath, ['scripts/develop.mjs'], {
    cwd: f.root, env: { ...process.env, OC_CHAN_PERFORMANCE_CONFIG: '', OC_CHAN_SMOKE_CONFIG: '' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  f.children.push(child)
  const closed = once(child, 'close')
  let output = '', errors = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`launcher readiness timed out: ${errors}`)), 15000)
    child.stdout.on('data', chunk => {
      output += chunk
      if (output.length > 65536) { clearTimeout(timer); reject(new Error('launcher output budget exceeded')) }
      if (output.includes('draining-worker-ready\n')) { clearTimeout(timer); resolve() }
    })
    child.stderr.on('data', chunk => {
      errors += chunk
      if (errors.length > 65536) { clearTimeout(timer); reject(new Error('launcher error budget exceeded')) }
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`launcher exited ${code}: ${errors}`)) })
  })
  const result = await f.api.cleanupLocalWorktree({ root: f.root, apply: true })
  const [code, signal] = await closed
  assert.equal(code, 143, errors)
  assert.equal(signal, null)
  assert.equal(await readFile(path.join(f.root, 'termination-count'), 'utf8'), '1')
  assert.equal(await exists(result.instances[0].instance), false)
  assert.doesNotMatch(errors, /开发启动失败|子进程退出超时|无权访问/)
})

test('stale registered instance is removable; ownerless instances are never guessed', mac, async t => {
  const f = await fixture(t)
  const { child, instance } = await launcher(f, { cleanup: false })
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
  const outside = path.join(f.temporary, 'outside-data')
  await mkdir(outside)
  await writeFile(path.join(outside, 'keep.txt'), 'keep')
  await symlink(outside, path.join(instance, 'SingletonSocket'))
  assert.equal((await f.api.cleanupLocalWorktree({ root: f.root })).instances[0].running, false)
  await f.api.cleanupLocalWorktree({ root: f.root, apply: true })
  assert.equal(await exists(instance), false)
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
  await mkdir(instance)
  await writeFile(path.join(instance, 'unknown.txt'), 'keep')
  await assert.rejects(f.api.cleanupLocalWorktree({ root: f.root, apply: true }), /ENOENT/)
  assert.equal(await readFile(path.join(instance, 'unknown.txt'), 'utf8'), 'keep')
})

test('forged start identity and foreign live PID never receive a signal', mac, async t => {
  const f = await fixture(t)
  const { child, owner, instance } = await launcher(f)
  const original = JSON.parse(await readFile(owner))
  await writeFile(owner, JSON.stringify({ ...original, identity: { ...original.identity, started: 'forged' } }))
  await assert.rejects(f.api.cleanupLocalWorktree({ root: f.root, apply: true }), /身份不符/)
  assert.equal(process.kill(child.pid, 0), true)
  await writeFile(owner, JSON.stringify({ ...original, launcherPID: process.pid }))
  await assert.rejects(f.api.cleanupLocalWorktree({ root: f.root, apply: true }), /身份不符/)
  assert.equal(process.kill(child.pid, 0), true)
  assert.equal(await exists(instance), true)
  assert.equal(await exists(path.join(f.root, 'launcher-stopped.json')), false)
})

test('copying a real launcher identity to another instance does not authorize termination', mac, async t => {
  const f = await fixture(t)
  const { child, owner } = await launcher(f)
  const copied = JSON.parse(await readFile(owner))
  const forged = path.join(f.root, '.dev-instances/instance-forged')
  await mkdir(forged)
  await writeFile(path.join(forged, 'owner.json'), JSON.stringify({ ...copied, instance: forged }), { mode: 0o600 })
  await assert.rejects(f.api.cleanupLocalWorktree({ root: f.root, apply: true }), /lsof|持有本实例/)
  assert.equal(process.kill(child.pid, 0), true)
  assert.equal(await exists(path.join(f.root, 'launcher-stopped.json')), false)
  assert.equal(await exists(forged), true)
})

test('stale instance with evidence logs or archive is preserved explicitly', mac, async t => {
  const f = await fixture(t)
  const { child, instance } = await launcher(f, { cleanup: false })
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
  await writeFile(path.join(instance, 'evidence.log'), 'keep')
  await assert.rejects(f.api.cleanupLocalWorktree({ root: f.root, apply: true }), /受保护文件/)
  assert.equal(await readFile(path.join(instance, 'evidence.log'), 'utf8'), 'keep')
})

test('CLI resolves its own workspace and rejects all arguments except --apply', mac, async t => {
  const f = await fixture(t)
  const script = path.join(f.root, 'scripts/local-app-lifecycle.mjs')
  const { stdout } = await run(process.execPath, [script], { cwd: f.temporary, timeout: 15000 })
  assert.deepEqual(JSON.parse(stdout), { root: f.root, apply: false, applications: [], instances: [] })
  await assert.rejects(run(process.execPath, [script, '--root', f.root], { cwd: f.temporary }), /用法/)
})
