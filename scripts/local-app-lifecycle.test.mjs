import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, lstat } from 'node:fs/promises'
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
  for (const name of ['local-app-lifecycle.mjs', 'local-install-readiness.mjs', 'local-install-process.m', 'build-app.mjs', 'build-plugin-market-rust.mjs', 'rust-dependencies.mjs']) await copyFile(path.join(path.dirname(source), name), path.join(root, 'scripts', name))
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
async function application(root, relative = 'release/tauri/package/OC Chan.app', identifier = 'local.oc-chan.desktop') {
  const app = path.join(root, relative)
  await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true })
  await writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>oc-chan</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
  await copyFile('/bin/sleep', path.join(app, 'Contents/MacOS/oc-chan'))
  return app
}
async function exists(filename) {
  try { await lstat(filename); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
async function launcher(f, { cleanup = true, resume = false } = {}) {
  const instance = path.join(f.root, '.dev-instances', 'instance-owned')
  if (!resume) await mkdir(instance, { recursive: true, mode: 0o700 })
  await writeFile(path.join(f.root, 'scripts/develop.mjs'), `
import { registerDevelopmentInstance, markDevelopmentInstanceStopped, cleanupStoppedDevelopmentInstance } from './local-app-lifecycle.mjs'
import { writeFile } from 'node:fs/promises'
const root = process.cwd()
const instance = ${JSON.stringify(instance)}
await registerDevelopmentInstance({ root, instance, resume: process.argv.includes('--resume-instance') })
process.on('SIGTERM', async () => {
  await writeFile(root + '/launcher-stopped.json', JSON.stringify({ signal: 'SIGTERM', pid: process.pid }))
  await markDevelopmentInstanceStopped({ root, instance })
  if (${cleanup}) await cleanupStoppedDevelopmentInstance({ root, instance })
  process.exit(0)
})
setInterval(() => {}, 1000)
process.stdout.write('ready\\n')
`)
  const child = spawn(process.execPath, ['scripts/develop.mjs', ...(resume ? ['--resume-instance', instance] : []), ...(!cleanup ? ['--no-cleanup'] : [])], { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] })
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
  await writeFile(path.join(app, 'Contents/MacOS/oc-chan'), '#!/bin/sh\nexit 0\n')
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
  const deep = path.join(f.root, 'release/a/b/c/d/e/f/g/h/i/j')
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
  const child = spawn(path.join(app, 'Contents/MacOS/oc-chan'), ['60'], { stdio: 'ignore' })
  f.children.push(child)
  await once(child, 'spawn')
  await assert.rejects(f.api.cleanupBuildApplication({ root: f.root, application: app }), /运行进程/)
  assert.equal(process.kill(child.pid, 0), true)
  assert.equal(await exists(app), true)
})

test('registered running owner is previewed but an active claim blocks cleanup and signals', mac, async t => {
  const f = await fixture(t)
  const { child, instance } = await launcher(f)
  const preview = await f.api.cleanupLocalWorktree({ root: f.root })
  assert.equal(preview.instances[0].running, true)
  assert.equal(await exists(path.join(f.root, 'launcher-stopped.json')), false)
  assert.equal(process.kill(child.pid, 0), true)
  await assert.rejects(f.api.cleanupLocalWorktree({ root: f.root, apply: true }), /活跃独占claim/)
  assert.equal(await exists(instance), true)
  assert.equal(await exists(path.join(f.root, 'launcher-stopped.json')), false)
  assert.equal(process.kill(child.pid, 0), true)
  await assert.rejects(f.api.cleanupStoppedDevelopmentInstance({ root: f.root, instance }), /当前launcher/)
  const exited = once(child, 'exit'); child.kill('SIGTERM'); const [code] = await exited
  assert.equal(code, 0); assert.equal(await exists(instance), false)
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
  await symlink(outside, path.join(instance, 'private-state-link'))
  assert.equal((await f.api.cleanupLocalWorktree({ root: f.root })).instances[0].running, false)
  await f.api.cleanupLocalWorktree({ root: f.root, apply: true })
  assert.equal(await exists(instance), false)
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
  await mkdir(instance)
  await writeFile(path.join(instance, 'unknown.txt'), 'keep')
  await assert.rejects(f.api.cleanupLocalWorktree({ root: f.root, apply: true }), /ENOENT/)
  assert.equal(await readFile(path.join(instance, 'unknown.txt'), 'utf8'), 'keep')
})

test('non-self cleanup refuses an instance whose drain evidence no longer matches its owner', mac, async t => {
  const f = await fixture(t)
  const { child, instance, owner } = await launcher(f, { cleanup: false })
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
  const stopped = path.join(instance, 'stopped.json')
  const evidence = JSON.parse(await readFile(stopped)); await writeFile(stopped, JSON.stringify({ ...evidence, owner: { ...evidence.owner, launcherPID: evidence.owner.launcherPID + 1 } }))
  await assert.rejects(f.api.cleanupDevelopmentInstance({ root: f.root, instance }), /排空证据/)
  assert.equal(await exists(owner), true); assert.equal(await exists(instance), true)
})

test('launcher cleanup removes incremental hardlink aliases and preserves an external alias', mac, async t => {
  const f = await fixture(t), { child, instance } = await launcher(f)
  const first = path.join(instance, 'cargo/debug/incremental/previous/object.o')
  const second = path.join(instance, 'cargo/debug/incremental/current/object.o')
  const third = path.join(instance, 'cargo/debug/build/object.o'), outside = path.join(f.temporary, 'external-object.o')
  for (const filename of [first, second, third]) await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(first, 'compiled object')
  for (const filename of [second, third, outside]) await link(first, filename)
  const before = await lstat(outside)
  assert.equal(before.nlink, 4)
  const exited = once(child, 'exit'); child.kill('SIGTERM'); const [code] = await exited
  assert.equal(code, 0); assert.equal(await exists(instance), false)
  const after = await lstat(outside)
  assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino); assert.equal(after.nlink, 1)
  assert.equal(await readFile(outside, 'utf8'), 'compiled object')
})

test('cleanup rejects inode, permission and link-count changes after inventory before deleting any entry', mac, async t => {
  for (const mutation of ['replace', 'permissions', 'link-count']) await t.test(mutation, async t => {
    const f = await fixture(t), { child, instance, owner } = await launcher(f, { cleanup: false })
    const filename = path.join(instance, 'object.o'), replacement = path.join(f.temporary, 'replacement.o')
    await writeFile(filename, 'original', { mode: 0o600 }); await writeFile(replacement, 'replacement')
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
    const originalStat = fs.lstatSync
    let changed = false
    t.mock.method(fs, 'lstatSync', function (target, ...args) {
      if (target === filename && !changed) {
        changed = true
        if (mutation === 'replace') fs.renameSync(replacement, filename)
        else if (mutation === 'permissions') fs.chmodSync(filename, 0o400)
        else fs.linkSync(filename, path.join(f.temporary, 'unobserved-alias.o'))
      }
      return originalStat.call(this, target, ...args)
    })
    syncBuiltinESMExports()
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
    await assert.rejects(f.api.cleanupDevelopmentInstance({ root: f.root, instance }), /删除前目录项身份发生变化/)
    assert.equal(changed, true); assert.equal(await exists(owner), true); assert.equal(await exists(filename), true)
  })
})

test('resume retains the exact profile inode, updates birth identity, and excludes a concurrent resume', mac, async t => {
  const f = await fixture(t), first = await launcher(f, { cleanup: false })
  const profile = path.join(first.instance, 'profile'); await mkdir(profile, { mode: 0o700 }); await writeFile(path.join(profile, 'state.json'), '{"installed":true}')
  const profileBefore = await lstat(profile), ownerBefore = JSON.parse(await readFile(first.owner))
  const stopped = once(first.child, 'exit'); first.child.kill('SIGTERM'); await stopped
  const second = await launcher(f, { cleanup: false, resume: true }), ownerAfter = JSON.parse(await readFile(second.owner))
  assert.equal(ownerAfter.schema, 2); assert.notDeepEqual(ownerAfter.identity, ownerBefore.identity)
  assert.equal((await lstat(profile)).ino, profileBefore.ino)
  assert.equal(await readFile(path.join(profile, 'state.json'), 'utf8'), '{"installed":true}')
  await assert.rejects(run(process.execPath, ['scripts/develop.mjs', '--resume-instance', first.instance, '--no-cleanup'], { cwd: f.root, timeout: 30000 }), /EEXIST/)
  const ended = once(second.child, 'exit'); second.child.kill('SIGTERM'); await ended
  const another = path.join(f.root, '.dev-instances/instance-unrelated'); await mkdir(another, { mode: 0o700 }); await writeFile(path.join(another, 'keep'), 'keep')
  await f.api.cleanupDevelopmentInstance({ root: f.root, instance: first.instance })
  assert.equal(await exists(first.instance), false); assert.equal(await readFile(path.join(another, 'keep'), 'utf8'), 'keep')
})

test('resume with default cleanup removes only its drained instance including the development bundle', mac, async t => {
  const f = await fixture(t), first = await launcher(f, { cleanup: false })
  const app = await application(f.root, path.relative(f.root, path.join(first.instance, 'cargo/debug/bundle/macos/OC Chan.app')), 'local.oc-chan.desktop.development.itest')
  const profile = path.join(first.instance, 'profile'); await mkdir(profile, { mode: 0o700 })
  const before = await lstat(profile)
  const stopped = once(first.child, 'exit'); first.child.kill('SIGTERM'); assert.equal((await stopped)[0], 0)
  const second = await launcher(f, { resume: true })
  assert.equal((await lstat(profile)).ino, before.ino); assert.equal(await exists(app), true)
  const unrelated = path.join(f.root, '.dev-instances/instance-unrelated'); await mkdir(unrelated, { mode: 0o700 }); await writeFile(path.join(unrelated, 'keep'), 'keep')
  const ended = once(second.child, 'exit'); second.child.kill('SIGTERM'); assert.equal((await ended)[0], 0)
  assert.equal(await exists(first.instance), false); assert.equal(await readFile(path.join(unrelated, 'keep'), 'utf8'), 'keep')
})

test('resume rejects missing drain evidence and schema1 without rewriting the old owner or profile', mac, async t => {
  const f = await fixture(t), first = await launcher(f, { cleanup: false })
  const stopped = once(first.child, 'exit'); first.child.kill('SIGTERM'); await stopped
  await rm(path.join(first.instance, 'stopped.json'))
  const before = await readFile(first.owner)
  const args = ['scripts/develop.mjs', '--resume-instance', first.instance, '--no-cleanup']
  await assert.rejects(run(process.execPath, args, { cwd: f.root, timeout: 30000 }), /ENOENT/)
  assert.deepEqual(await readFile(first.owner), before); assert.equal(await exists(path.join(first.instance, '.resume-claim')), false)
  const owner = JSON.parse(before); await writeFile(first.owner, JSON.stringify({ ...owner, schema: 1 }))
  await assert.rejects(run(process.execPath, args, { cwd: f.root, timeout: 30000 }), /owner 身份不符/)
  assert.equal(JSON.parse(await readFile(first.owner)).schema, 1)
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
  const { child, owner, instance } = await launcher(f)
  const copied = JSON.parse(await readFile(owner))
  const forged = path.join(f.root, '.dev-instances/instance-forged')
  await mkdir(forged, { mode: 0o700 })
  await writeFile(path.join(forged, 'owner.json'), JSON.stringify({ ...copied, instance: forged }), { mode: 0o600 })
  await assert.rejects(f.api.cleanupLocalWorktree({ root: f.root, apply: true }))
  assert.equal(process.kill(child.pid, 0), true)
  assert.equal(await exists(path.join(f.root, 'launcher-stopped.json')), false)
  assert.equal(await exists(instance), true)
  assert.equal(await exists(forged), true)
  assert.equal(JSON.parse(await readFile(owner)).instance, instance)
  assert.equal(JSON.parse(await readFile(path.join(forged, 'owner.json'))).instance, forged)
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
