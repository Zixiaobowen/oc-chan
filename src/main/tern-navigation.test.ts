import assert from 'node:assert/strict'
import { watch, type FSWatcher } from 'node:fs'
import { appendFile, chmod, copyFile, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { DiagnosticError, summarizeDiagnostic } from '../shared/diagnostics'
import type { AgentInfo, TernTarget } from '../shared/types'
import { collectionResources, RESOURCE_LIMITS, ResourceCleanupError, resourceAbortError } from './resource-budget'
import { TernNavigation, resolveTernTarget, type NavigationCommand } from './tern-navigation'

const target: TernTarget = { windowKey: '3', paneId: 101, sessionFile: '/sessions/main.jsonl' }
const identity = { pid: 99, executable: '/Applications/Verified Tern.app/Contents/MacOS/tern', bundle: '/Applications/Verified Tern.app', bundleId: 'so.stencil.tern', teamId: 'VTLHGQC72S' }
const readyPlugin = { id: 'oc-chan-navigation', version: '1.0.0', status: 'ready', window: true }
function agent(id: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return { id, name: 'OMP', runtime: 'OMP', kind: 'main', state: 'idle', pid: 40, source: 'test', ...extra }
}
interface NavigationFixture {
  base: string
  resources: string
  plugin: string
  helper: string
  navigation(execute?: NavigationCommand, timeout?: number, root?: string): TernNavigation
}
function released(): void {
  const current = collectionResources.snapshot().sources.find(item => item.source === 'tern-navigation')?.current
  if (current) for (const key of ['commands', 'files', 'commandBytes', 'fileBytes', 'queued'] as const) assert.equal(current[key], 0, key)
}
async function fixture(t: TestContext): Promise<NavigationFixture> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'oc-tern-navigation-')))
  const resources = path.join(base, 'resources'), plugin = path.join(resources, 'plugin'), helper = path.join(resources, 'present-window')
  await mkdir(plugin, { recursive: true })
  for (const name of ['plugin.toml', 'window.luau']) await copyFile(path.resolve('resources/tern-navigation/plugin', name), path.join(plugin, name))
  await writeFile(helper, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const navigations: TernNavigation[] = []
  t.after(async () => {
    try { await Promise.all(navigations.map(navigation => navigation.close())) }
    finally { await rm(base, { recursive: true, force: true }) }
  })
  return { base, resources, plugin, helper,
    navigation(execute?: NavigationCommand, timeout = 2000, root = resources) {
      const navigation = new TernNavigation(root, execute, timeout)
      navigations.push(navigation)
      return navigation
    },
  }
}
function protocol(selected: TernTarget = target) {
  const state = { probes: 0, inspections: 0, lists: 0, installed: false, focused: false, presented: false }
  const execute: NavigationCommand = async (file, args, signal) => {
    assert.equal(signal.aborted, false)
    if (args[0] === 'probe') { state.probes++; return JSON.stringify(identity) }
    if (args[0] === 'present') {
      assert.equal(state.focused, true)
      assert.equal(args[1], String(identity.pid))
      assert.equal(args[2], identity.executable)
      assert.equal(args[3], selected.windowKey)
      state.presented = true
      return JSON.stringify({ pid: identity.pid, windowTitle: `[Tern ${JSON.stringify(selected.windowKey)}] Default`, main: true })
    }
    assert.equal(file, identity.executable)
    if (args[0] === 'inspect') {
      state.inspections++
      return JSON.stringify({ panes: [{ pane: selected.paneId, exited: null, omp_session_file: selected.sessionFile }] })
    }
    if (args[0] === 'plugin' && args[1] === 'list') { state.lists++; return JSON.stringify({ plugins: [readyPlugin] }) }
    if (args[0] === 'plugin' && args[1] === 'install') { state.installed = true; return '' }
    if (args[0] === 'focus') {
      state.focused = true
      return JSON.stringify({ block: selected.paneId })
    }
    throw new Error('Unexpected command in controlled fixture')
  }
  return { state, execute }
}

test('confirmed parent ownership inherits a target and a direct target takes precedence', () => {
  const direct = { ...target, windowKey: '', paneId: 303 }
  const agents = [agent('main', { tern: target }), agent('child', { parentId: 'main' }),
    agent('nested', { parentId: 'child' }), agent('separate', { parentId: 'main', tern: direct })]
  const inherited = resolveTernTarget(agents, 'nested')
  assert.deepEqual(inherited, target)
  assert.deepEqual(resolveTernTarget(agents, 'separate'), direct)
})

test('invalid keys, panes and session paths reject before any command or resource I/O', async () => {
  let calls = 0
  const navigation = new TernNavigation('/missing-resources', async () => { calls++; return '' })
  const badTargets = [
    ...['"', '$(open)', 'a\nb', '\0', 'x'.repeat(129), '中文', 'a b', '3\n'].map(windowKey => ({ ...target, windowKey })),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN].map(paneId => ({ ...target, paneId })),
    ...['relative', '', '/bad\0path', '/bad\npath', '/bad\u007fpath', '/bad\u0085path', '/' + 'x'.repeat(4096)].map(sessionFile => ({ ...target, sessionFile })),
  ]
  try {
    for (const tern of badTargets) await assert.rejects(navigation.focus([agent('main', { tern })], 'main'), { code: 'OC_TERN_TARGET' })
    assert.equal(calls, 0)
  } finally { await navigation.close() }
})

test('missing, duplicated, cyclic, oversized and non-OMP ownership cannot issue a command', async () => {
  const agents = [agent('unrelated', { tern: target }), agent('orphan', { parentId: 'missing' }),
    agent('a', { parentId: 'b' }), agent('b', { parentId: 'a' }), agent('codex', { runtime: 'Codex', parentId: 'unrelated' }),
    agent('via-codex', { parentId: 'codex' })]
  let calls = 0
  const navigation = new TernNavigation('/missing-resources', async () => { calls++; return '' })
  try {
    for (const id of ['orphan', 'a', 'b', 'codex', 'via-codex', 'exited']) {
      await assert.rejects(navigation.focus(agents, id), { code: 'OC_TERN_TARGET' })
    }
    await assert.rejects(navigation.focus([agent('same', { tern: target }), agent('same')], 'same'), { code: 'OC_TERN_TARGET' })
    await assert.rejects(navigation.focus(Array.from({ length: 10_001 }, (_, i) => agent(String(i), { tern: target })), '0'), { code: 'OC_TERN_TARGET' })
    assert.equal(calls, 0)
  } finally { await navigation.close() }
})

test('a valid unique chain reaches the verified native window, including an empty window key', async t => {
  const f = await fixture(t)
  for (const windowKey of ['', 'a'.repeat(128), 'valid._-9']) {
    const selected = { ...target, windowKey }
    const p = protocol(selected)
    await f.navigation(p.execute).focus([agent('root', { tern: selected, parentId: 'expired-ancestor' }), agent('nested', { parentId: 'root' })], 'nested')
    assert.equal(p.state.presented, true)
    assert.equal(p.state.installed, false)
    released()
  }
})

test('mutation of the snapshot after focus begins cannot redirect the captured target', async t => {
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  t.after(() => resume.resolve())
  const f = await fixture(t), p = protocol()
  const selected = { ...target }
  const navigation = f.navigation(async (file, args, signal) => {
    if (args[0] === 'probe' && p.state.probes === 0) { entered.resolve(); await resume.promise }
    return p.execute(file, args, signal)
  })
  const result = navigation.focus([agent('main', { tern: selected })], 'main')
  await Promise.race([entered.promise, result])
  selected.paneId = 202; selected.sessionFile = '/different.jsonl'; selected.windowKey = 'other'
  resume.resolve()
  await result
  assert.equal(p.state.presented, true)
})

test('bad, missing and multiple probe identities reject before invoking a claimed executable', async t => {
  const f = await fixture(t)
  const invalid = [null, {}, [identity, identity], { ...identity, pid: 0 }, { ...identity, pid: 2_147_483_648 },
    { ...identity, pid: '99' }, { ...identity, bundleId: 'fake' }, { ...identity, teamId: 'fake' },
    { ...identity, executable: '/tmp/tern' }, { ...identity, executable: identity.executable + '\0' },
    { ...identity, bundle: '/Applications/../Verified Tern.app' }, { ...identity, executable: 'relative/tern' }]
  for (const value of invalid) {
    let external = 0
    await assert.rejects(f.navigation(async (_file, args) => {
      if (args[0] === 'probe') return JSON.stringify(value)
      external++; return ''
    }).focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_IDENTITY' })
    assert.equal(external, 0)
  }
})

test('closed, missing, reused or duplicate panes reject before focus and presentation', async t => {
  const f = await fixture(t)
  const pane = { pane: target.paneId, exited: null, omp_session_file: target.sessionFile }
  for (const panes of [[], [{ ...pane, exited: 0 }], [{ ...pane, omp_session_file: '/replaced.jsonl' }], [{ ...pane, pane: 202 }], [pane, pane]]) {
    const p = protocol()
    await assert.rejects(f.navigation((file, args, signal) => args[0] === 'inspect'
      ? Promise.resolve(JSON.stringify({ panes })) : p.execute(file, args, signal))
      .focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_TARGET' })
    assert.equal(p.state.focused, false)
    assert.equal(p.state.presented, false)
    assert.equal(p.state.installed, false)
  }
})

test('identity or session changes during plugin checks stop before pane focus', async t => {
  const f = await fixture(t)
  for (const change of ['pid', 'executable', 'session']) {
    const p = protocol()
    const navigation = f.navigation(async (file, args, signal) => {
      if (args[0] === 'probe' && p.state.probes === 1 && change !== 'session') {
        return JSON.stringify(change === 'pid' ? { ...identity, pid: 100 } :
          { ...identity, bundle: '/Applications/Another.app', executable: '/Applications/Another.app/Contents/MacOS/tern' })
      }
      if (args[0] === 'inspect' && p.state.inspections === 1 && change === 'session') return JSON.stringify({ panes: [{ pane: target.paneId, omp_session_file: '/replacement' }] })
      return p.execute(file, args, signal)
    })
    await assert.rejects(navigation.focus([agent('main', { tern: target })], 'main'), { code: change === 'session' ? 'OC_TERN_TARGET' : 'OC_TERN_IDENTITY' })
    assert.equal(p.state.focused, false)
    assert.equal(p.state.presented, false)
  }
})

test('JSON and collection limits reject before any focus side effect', async t => {
  const f = await fixture(t)
  for (const [command, output, code] of [
    ['probe', '{', 'OC_TERN_PROTOCOL'], ['probe', 'x'.repeat(64 * 1024 + 1), 'OC_TERN_COMMAND'],
    ['inspect', '{', 'OC_TERN_PROTOCOL'], ['inspect', JSON.stringify({ panes: Array(10_001).fill({ pane: 1 }) }), 'OC_TERN_PROTOCOL'],
    ['inspect', 'x'.repeat(2 * 1024 * 1024 + 1), 'OC_TERN_COMMAND'],
    ['plugin', JSON.stringify({ plugins: Array(257).fill(readyPlugin) }), 'OC_TERN_PROTOCOL'],
    ['plugin', 'x'.repeat(256 * 1024 + 1), 'OC_TERN_COMMAND'],
    ['plugin', JSON.stringify({ plugins: [readyPlugin, readyPlugin] }), 'OC_TERN_PLUGIN'],
    ['plugin', JSON.stringify({ plugins: [{ ...readyPlugin, status: 'disabled' }] }), 'OC_TERN_PLUGIN'],
    ['plugin', JSON.stringify({ plugins: [{ ...readyPlugin, window: false }] }), 'OC_TERN_PLUGIN'],
    ['plugin', JSON.stringify({ plugins: [{ ...readyPlugin, window: {} }] }), 'OC_TERN_PLUGIN'],
    ['plugin', JSON.stringify({ plugins: [{ ...readyPlugin, version: '0.9.0' }] }), 'OC_TERN_PLUGIN'],
  ]) {
    const p = protocol()
    await assert.rejects(f.navigation((file, args, signal) => args[0] === command ? Promise.resolve(output) : p.execute(file, args, signal))
      .focus([agent('main', { tern: target })], 'main'), { code })
    assert.equal(p.state.focused, false)
    released()
  }
})

test('a missing plugin installs only the fixed bundled directory and must become ready on re-read', async t => {
  const f = await fixture(t)
  for (const becomesReady of [true, false]) {
    const p = protocol()
    let lists = 0, installed = false
    const result = f.navigation(async (file, args, signal) => {
      if (args[0] === 'plugin' && args[1] === 'list') {
        lists++
        return JSON.stringify({ plugins: installed && becomesReady ? [readyPlugin] : [] })
      }
      if (args[0] === 'plugin' && args[1] === 'install') {
        assert.equal(args[2], f.plugin)
        assert.equal(p.state.focused, false)
        installed = true
        return 'installation result is intentionally not a JSON contract'
      }
      return p.execute(file, args, signal)
    }).focus([agent('main', { tern: target })], 'main')
    if (becomesReady) await result
    else await assert.rejects(result, { code: 'OC_TERN_PLUGIN' })
    assert.equal(installed, true)
    assert.equal(lists, 2)
    assert.equal(p.state.presented, becomesReady)
  }
})

test('focus failure or an incorrect block never activates the native window', async t => {
  const f = await fixture(t)
  for (const response of [new Error('sensitive connection body'), { block: 202 }, { block: '101' }]) {
    const p = protocol()
    await assert.rejects(f.navigation(async (file, args, signal) => {
      if (args[0] === 'focus') {
        if (response instanceof Error) throw response
        return JSON.stringify(response)
      }
      return p.execute(file, args, signal)
    }).focus([agent('main', { tern: target })], 'main'), { code: response instanceof Error ? 'OC_TERN_COMMAND' : 'OC_TERN_TARGET' })
    assert.equal(p.state.presented, false)
  }
})

test('presentation receipts require the same PID, exact prefix and bounded main-window title', async t => {
  const f = await fixture(t)
  const presented = { pid: identity.pid, windowTitle: '[Tern "3"] Default', main: true }
  for (const value of [{ ...presented, pid: 100 }, { ...presented, pid: '99' }, { ...presented, main: false },
    { ...presented, windowTitle: '[Tern ""] Default' }, { ...presented, windowTitle: '[Tern "3"] ' + 'x'.repeat(4096) },
    { ...presented, windowTitle: '[Tern "3"] secret\nline' }, { ...presented, windowTitle: null }]) {
    const p = protocol()
    await assert.rejects(f.navigation((file, args, signal) => args[0] === 'present' ? Promise.resolve(JSON.stringify(value)) : p.execute(file, args, signal))
      .focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_WINDOW' })
    assert.equal(p.state.focused, true)
  }
})

test('helper errors accept only a complete fixed code and diagnostics never disclose stderr', async t => {
  const f = await fixture(t)
  for (const [stderr, code] of [['OC_TERN_AMBIGUOUS\n', 'OC_TERN_AMBIGUOUS'], ['OC_TERN_ACCESSIBILITY\n', 'OC_TERN_ACCESSIBILITY'],
    ['OC_TERN_UNAVAILABLE\n', 'OC_TERN_UNAVAILABLE'], ['OC_TERN_IDENTITY\n', 'OC_TERN_IDENTITY'],
    ['OC_TERN_WINDOW\nprivate /Users/person/session', 'OC_TERN_COMMAND'], ['OC_TERN_WINDOW', 'OC_TERN_COMMAND'],
    [' OC_TERN_WINDOW\n', 'OC_TERN_COMMAND'], ['OC_TERN_MADEUP\n', 'OC_TERN_COMMAND']]) {
    const cause = Object.assign(new Error('private /Users/person/session'), { stderr })
    await assert.rejects(f.navigation(async () => { throw cause }).focus([agent('main', { tern: target })], 'main'), error => {
      assert.ok(error instanceof DiagnosticError)
      assert.equal(error.code, code)
      assert.equal(error.cause, cause)
      const summary = summarizeDiagnostic(error, 'tern-navigation')
      assert.equal(summary.primaryCode, code)
      assert.doesNotMatch(summary.details, /private|\/Users\/person|session/)
      return true
    })
  }
  const p = protocol()
  await assert.rejects(f.navigation(async (file, args, signal) => {
    if (args[0] === 'inspect') throw Object.assign(new Error('private'), { stderr: 'OC_TERN_ACCESSIBILITY\n' })
    return p.execute(file, args, signal)
  }).focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_COMMAND' })
})

test('tampered, oversized, symlinked and extra bundled resources never invoke any command', async t => {
  const mutations: ((f: NavigationFixture) => Promise<void>)[] = [
    f => appendFile(path.join(f.plugin, 'plugin.toml'), '\nid="other"\n'),
    f => writeFile(path.join(f.plugin, 'plugin.toml'), 'id="other"\n'),
    f => appendFile(path.join(f.plugin, 'window.luau'), '\nrequire("untrusted")'),
    f => writeFile(path.join(f.plugin, 'window.luau'), 'x'.repeat(16 * 1024 + 1)),
    f => writeFile(f.helper, Buffer.alloc(2 * 1024 * 1024 + 1)),
    f => chmod(f.helper, 0o644),
    f => writeFile(path.join(f.plugin, 'extra.luau'), 'untrusted'),
    f => mkdir(path.join(f.plugin, 'extra-directory')),
    async f => { await rm(path.join(f.plugin, 'window.luau')); await symlink(path.resolve('resources/tern-navigation/plugin/window.luau'), path.join(f.plugin, 'window.luau')) },
    async f => { await rm(f.helper); await symlink('/bin/echo', f.helper) },
    async f => { await rename(f.plugin, path.join(f.base, 'moved-plugin')); await symlink(path.join(f.base, 'moved-plugin'), f.plugin) },
    async f => { await rm(f.helper); await mkdir(f.helper) },
    f => rm(path.join(f.plugin, 'plugin.toml')),
  ]
  for (const mutate of mutations) {
    const f = await fixture(t)
    await mutate(f)
    let executed = 0
    await assert.rejects(f.navigation(async () => { executed++; return '' }).focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_RESOURCES' })
    assert.equal(executed, 0)
    released()
  }
  const f = await fixture(t), linked = path.join(f.base, 'linked-resources')
  await symlink(f.resources, linked)
  let executed = 0
  await assert.rejects(f.navigation(async () => { executed++; return '' }, 2000, linked)
    .focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_RESOURCES' })
  assert.equal(executed, 0)
})

test('a payload replaced after initial inspection is rejected before plugin installation', async t => {
  const f = await fixture(t), p = protocol()
  await assert.rejects(f.navigation(async (file, args, signal) => {
    if (args[0] === 'plugin' && args[1] === 'list') {
      await appendFile(path.join(f.plugin, 'window.luau'), '\n-- changed')
      return JSON.stringify({ plugins: [] })
    }
    return p.execute(file, args, signal)
  }).focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_RESOURCES' })
  assert.equal(p.state.installed, false)
  assert.equal(p.state.focused, false)
})

test('read-time changes close the actual descriptor before rejecting resources', async t => {
  const f = await fixture(t), probe = await open(path.join(f.plugin, 'plugin.toml'), 'r')
  const prototype = Object.getPrototypeOf(probe), original = prototype.read
  await probe.close()
  let captured: typeof probe | undefined, executed = 0
  t.mock.method(prototype, 'read', async function (this: typeof probe, ...args: unknown[]) {
    if (!captured) { captured = this; await appendFile(path.join(f.plugin, 'plugin.toml'), '\nchanged') }
    return Reflect.apply(original, this, args)
  })
  await assert.rejects(f.navigation(async () => { executed++; return '' }).focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_RESOURCES' })
  assert.ok(captured)
  await assert.rejects(captured.stat(), { code: 'EBADF' })
  assert.equal(executed, 0)
  released()
})

test('concurrent requests reject immediately and cancellation retains ownership until execution drains', async t => {
  const entered = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  t.after(() => finish.resolve())
  const f = await fixture(t), p = protocol()
  let block = true
  const navigation = f.navigation(async (file, args, signal) => {
    if (block) {
      entered.resolve()
      signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      await finish.promise
      throw resourceAbortError()
    }
    return p.execute(file, args, signal)
  })
  const result = navigation.focus([agent('main', { tern: target })], 'main')
  const rejected = assert.rejects(result, { code: 'ABORT_ERR' })
  await Promise.race([entered.promise, result])
  await assert.rejects(navigation.focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_BUSY' })
  let drained = false
  const cancelled = navigation.cancel().then(() => { drained = true })
  await aborted.promise
  assert.equal(drained, false)
  assert.equal(collectionResources.snapshot().sources.find(item => item.source === 'tern-navigation')!.current.commands, 1)
  await assert.rejects(navigation.focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_BUSY' })
  finish.resolve()
  await Promise.all([cancelled, rejected])
  released()
  block = false
  await navigation.focus([agent('main', { tern: target })], 'main')
  assert.equal(p.state.presented, true)
  await navigation.close()
  await assert.rejects(navigation.focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_CLOSED' })
})

test('the total deadline includes both resource-file and command admission queues', async t => {
  // Real pool admission and cancellation are the integration boundary; the parent deadline must include queue time.
  const f = await fixture(t)
  for (const kind of ['file', 'command'] as const) {
    const lease = await collectionResources.acquire(kind === 'file'
      ? { source: 'test-tern-hold', kind, bytes: RESOURCE_LIMITS.fileBytes }
      : { source: 'test-tern-hold', kind, stdoutBytes: RESOURCE_LIMITS.commandBytes, stderrBytes: 0 })
    let executed = 0
    try {
      await assert.rejects(f.navigation(async () => { executed++; return '' }, 100)
        .focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_TIMEOUT' })
      assert.equal(executed, 0)
      released()
    } finally { lease.release() }
  }
})

test('file-close failures survive cancellation in focus, cancel and permanent close', async t => {
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  t.after(() => finish.resolve())
  const f = await fixture(t), probe = await open(f.helper, 'r')
  const prototype = Object.getPrototypeOf(probe), originalStat = prototype.stat
  await probe.close()
  const cause = Object.assign(new Error('private close details'), { code: 'EIO' })
  let captured: typeof probe | undefined
  t.mock.method(prototype, 'stat', async function (this: typeof probe, ...args: unknown[]) {
    if (!captured) {
      captured = this
      const close = this.close.bind(this)
      this.close = async () => { entered.resolve(); await finish.promise; await close(); throw cause }
    }
    return Reflect.apply(originalStat, this, args)
  })
  const navigation = f.navigation(async () => { throw new Error('No command expected') })
  const result = navigation.focus([agent('main', { tern: target })], 'main')
  const failed = (error: unknown) => error instanceof ResourceCleanupError && error.cause === cause
  const rejected = assert.rejects(result, failed)
  await Promise.race([entered.promise, result])
  const cancelled = assert.rejects(navigation.cancel(), failed)
  const closed = assert.rejects(navigation.close(), failed)
  finish.resolve()
  await Promise.all([rejected, cancelled, closed])
  assert.ok(captured)
  await assert.rejects(captured.stat(), { code: 'EBADF' })
  released()
})

async function realHelper(f: NavigationFixture, body: string): Promise<void> {
  // The only executable is a disposable Node child. It cannot launch Tern or touch user plugins.
  const command = [process.execPath, '-e', body].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ')
  await writeFile(f.helper, `#!/bin/sh\nexec ${command} -- "$@"\n`, { mode: 0o755 })
}
function childReady(t: TestContext, base: string) {
  const pidFile = path.join(base, 'owned-pid')
  let watcher: FSWatcher | undefined
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  // Failure deadline only; readiness comes from an actual child's atomic PID-file rename, not a guessed sleep.
  const timer = setTimeout(() => reject(new Error('Controlled child did not become ready')), 3000)
  watcher = watch(base, (_event, name) => {
    if (name === 'owned-pid') void readFile(pidFile, 'utf8').then(value => resolve(Number(value)), reject)
  })
  const ready = promise.finally(() => { watcher?.close(); clearTimeout(timer) })
  t.after(() => { watcher?.close(); clearTimeout(timer) })
  const announce = `const fs=require('node:fs');const p=${JSON.stringify(pidFile)};fs.writeFileSync(p+'.tmp',String(process.pid));fs.renameSync(p+'.tmp',p);`
  return { ready, announce, pidFile }
}

test('real owned children close on cancel and close before their resource reservation is released', { timeout: 10_000 }, async t => {
  for (const method of ['cancel', 'close'] as const) {
    const f = await fixture(t), child = childReady(t, f.base)
    await realHelper(f, child.announce + 'setInterval(()=>{},1000)')
    const navigation = f.navigation(undefined, 5000)
    const result = navigation.focus([agent('main', { tern: target })], 'main')
    const rejected = assert.rejects(result, { code: 'ABORT_ERR' })
    const pid = await Promise.race([child.ready, result.then(() => { throw new Error('Navigation ended before child readiness') })])
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
    await navigation[method]()
    await rejected
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    released()
  }
})

test('a real child exceeding the total deadline is killed and drained', { timeout: 5000 }, async t => {
  // execFile's OS-child kill and close events require the real platform timer; fake clocks cannot deliver those events.
  const f = await fixture(t), child = childReady(t, f.base)
  await realHelper(f, child.announce + 'setInterval(()=>{},1000)')
  const result = f.navigation(undefined, 1000).focus([agent('main', { tern: target })], 'main')
  const rejected = assert.rejects(result, { code: 'OC_TERN_TIMEOUT' })
  const pid = await Promise.race([child.ready, result.then(() => { throw new Error('Navigation ended before child readiness') })])
  await rejected
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  released()
})

test('real helper output overflow kills and drains the child without accepting a receipt', { timeout: 5000 }, async t => {
  const f = await fixture(t), child = childReady(t, f.base)
  await realHelper(f, child.announce + 'process.stdout.write("x".repeat(256*1024));setInterval(()=>{},1000)')
  await assert.rejects(f.navigation(undefined).focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_COMMAND' })
  const pid = await child.ready
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  released()
})

test('constructor deadlines are finite positive integers capped at ten seconds', () => {
  for (const timeout of [0, -1, 1.5, 10_001, Infinity, NaN]) assert.throws(() => new TernNavigation('/unused', undefined, timeout), RangeError)
})

test('closing while queued cancels admission without ever starting a command', async t => {
  const f = await fixture(t)
  const lease = await collectionResources.acquire({ source: 'test-tern-hold', kind: 'file', bytes: RESOURCE_LIMITS.fileBytes })
  let executed = 0
  try {
    const navigation = f.navigation(async () => { executed++; return '' })
    const rejected = assert.rejects(navigation.focus([agent('main', { tern: target })], 'main'), { code: 'ABORT_ERR' })
    assert.equal(collectionResources.snapshot().sources.find(item => item.source === 'tern-navigation')!.current.queued, 1)
    await navigation.close()
    await rejected
    await assert.rejects(navigation.focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_CLOSED' })
    assert.equal(executed, 0)
    released()
  } finally { lease.release() }
})

test('same-content replacement during reading fails identity validation and closes the old descriptor', async t => {
  const f = await fixture(t), filename = path.join(f.plugin, 'plugin.toml'), replacement = path.join(f.base, 'replacement')
  await copyFile(filename, replacement)
  const probe = await open(filename, 'r'), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read
  await probe.close()
  let captured: typeof probe | undefined, executed = 0
  t.mock.method(prototype, 'read', async function (this: typeof probe, ...args: unknown[]) {
    const result = await Reflect.apply(originalRead, this, args)
    if (!captured) { captured = this; await rename(replacement, filename) }
    return result
  })
  await assert.rejects(f.navigation(async () => { executed++; return '' }).focus([agent('main', { tern: target })], 'main'), { code: 'OC_TERN_RESOURCES' })
  assert.ok(captured)
  await assert.rejects(captured.stat(), { code: 'EBADF' })
  assert.equal(executed, 0)
  released()
})

test('real helper failures expose only whitelisted codes and redact sensitive stderr', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  for (const [stderr, code] of [
    ['OC_TERN_ACCESSIBILITY\n', 'OC_TERN_ACCESSIBILITY'],
    ['OC_TERN_IDENTITY\n/Users/private/secret-session credential=value', 'OC_TERN_COMMAND'],
  ]) {
    await realHelper(f, `process.stderr.write(${JSON.stringify(stderr)});process.exit(1)`)
    await assert.rejects(f.navigation().focus([agent('main', { tern: target })], 'main'), error => {
      const summary = summarizeDiagnostic(error, 'tern-navigation')
      assert.equal(summary.primaryCode, code)
      assert.doesNotMatch(summary.details, /private|secret-session|credential|value/)
      return true
    })
    released()
  }
})
