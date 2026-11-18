import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, globSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { changedFiles, changeRange, selectTests, suites, validateTestCoverage, rustCommands, runRustTests } from './ci-tests.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const allTests = Object.values(suites).flat().sort()
const union = (...groups) => [...new Set(groups.flatMap(group => suites[group]))].sort()
function temporary(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'oc-ci-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('documentation selects no product tests', () => {
  assert.deepEqual(selectTests(['README.md', 'docs/performance-baseline.json']).tests, [])
})

test('version management and release notes validate publication without selecting product crates', () => {
  for (const file of ['scripts/version.mjs', 'scripts/release-workflow.mjs', 'releases/0.2.0.md', '.github/workflows/release-prepare.yml', '.github/workflows/release-stable.yml']) {
    const plan = selectTests([file])
    assert.deepEqual(plan.tests, union('versioning', 'updates'))
    assert.deepEqual(plan.rust, [])
  }
})

test('renderer smoke follows executable and UI changes, while documentation and unit-test-only edits stay targeted', () => {
  assert.equal(selectTests(['README.md', 'docs/performance-baseline.json']).rendererSmoke, false)
  assert.equal(selectTests(['scripts/build-app.test.mjs']).rendererSmoke, false)
  assert.equal(selectTests(['scripts/install-local.mjs']).rendererSmoke, false)
  for (const files of [
    ['src-tauri/src/windows.rs'], ['crates/oc-core/src/agents/runtime.rs'],
    ['scripts/smoke-renderer.mjs', 'scripts/smoke/scenarios.mjs'],
    ['scripts/develop.mjs'], ['src-tauri/src/acceptance.rs'],
    ['package-lock.json'], ['.github/workflows/build.yml']
  ]) assert.equal(selectTests(files).rendererSmoke, true, files.join(', '))
  assert.equal(selectTests([], '版本标签').rendererSmoke, true)
  assert.equal(selectTests(['src/main/collectors/agents.ts'], undefined, ['src/main/collectors/agents.ts']).rendererSmoke, true)
})

test('collection and view changes include Rust module callers without unrelated packages', () => {
  assert.deepEqual(selectTests(['crates/oc-core/src/schedules/launchd.rs']).rust, ['events', 'monitor', 'schedules'])
  assert.deepEqual(selectTests(['crates/oc-core/src/agents/activity.rs']).rust, ['agents', 'monitor', 'tern'])
  assert.deepEqual(selectTests(['crates/oc-core/src/marketplace/source.rs']).rust, ['marketplace', 'plugins'])
  assert.deepEqual(selectTests(['crates/oc-core/src/marketplace/archive.rs']).rust, ['marketplace', 'plugins'])
  assert.deepEqual(selectTests(['src-tauri/src/windows.rs']).tests, union('views', 'diagnostics', 'install'))
  assert.deepEqual(selectTests(['src-tauri/src/windows.rs']).rust, ['host'])
})

test('dependency and public contract changes widen coverage explicitly', () => {
  const dependency = selectTests(['package-lock.json'])
  assert.deepEqual(dependency.tests, allTests)
  assert.ok(dependency.reasons.some(reason => reason.includes('依赖')))
  assert.deepEqual(selectTests(['crates/oc-core/src/io.rs', 'crates/oc-core/src/updates/mod.rs']).rust, ['core', 'host'])
})

test('new behavior files must be mapped and deleted tests cannot remain in the manifest', () => {
  validateTestCoverage(globSync(['src/**/*.test.ts', 'plugins/**/*.test.ts', 'scripts/**/*.test.mjs'], { cwd: root }))
  assert.throws(() => validateTestCoverage([...allTests, 'scripts/new.test.mjs']), /未映射/)
  assert.throws(() => validateTestCoverage(allTests.filter(file => file !== suites.install[0])), /缺失/)
  assert.throws(() => selectTests(['src/main/new-feature.ts']), /未配置测试映射/)
  for (const file of ['scripts/unknown.mjs', 'plugins/unknown.ts']) {
    assert.throws(() => selectTests([file], undefined, [file]), /未配置测试映射/)
  }
  const removed = selectTests(['src/main/collectors/agents.test.ts'], undefined, ['src/main/collectors/agents.test.ts'])
  assert.deepEqual(removed.tests, union('ci', 'packaging', 'install'))
  assert.deepEqual(removed.rust, ['host'])
})

test('retired build configuration deletion checks Tauri packaging without accepting unknown roots', () => {
  const file = 'electron.vite.config.ts'
  const plan = selectTests([file], undefined, [file])
  assert.deepEqual(plan.tests, union('install', 'packaging'))
  assert.deepEqual(plan.rust, ['host'])
  assert.equal(plan.rendererSmoke, true)
  assert.throws(() => selectTests([file]), /未配置测试映射/)
  assert.throws(() => selectTests(['unknown.config.ts'], undefined, ['unknown.config.ts']), /未配置测试映射/)
})

test('renderer smoke keeps its live mapping while the retired collector has only deletion coverage', () => {
  for (const file of ['scripts/smoke-renderer.mjs', 'scripts/smoke/scenarios.mjs']) {
    const plan = selectTests([file])
    assert.deepEqual(plan.tests, union('performance', 'install'))
    assert.deepEqual(plan.rust, ['host'])
    assert.equal(plan.rendererSmoke, true)
  }
})

test('marketplace fixtures and WK probes select their real consumers', () => {
  const fixture = selectTests(['scripts/build-marketplace-fixtures.mjs'])
  assert.deepEqual(fixture.tests, union('marketplace', 'performance', 'install'))
  assert.deepEqual(fixture.rust, ['marketplace', 'plugins', 'system'])
  assert.equal(fixture.rendererSmoke, true)
  for (const file of ['Cargo.lock', 'Cargo.toml', 'build-frontend.mjs', 'build.rs', 'frontend/index.html', 'frontend/main.jsx', 'run-probe.mjs', 'src/main.rs', 'tauri.conf.json']) {
    const filePath = `scripts/probes/wk/${file}`
    const probe = selectTests([filePath])
    assert.deepEqual(probe.tests, union('performance', 'install'))
    assert.deepEqual(probe.rust, ['host'])
    assert.equal(probe.rendererSmoke, true)
  }
  assert.throws(() => selectTests(['scripts/probes/unknown/run.mjs']), /未配置测试映射/)
  assert.throws(() => selectTests(['scripts/build-marketplace-unknown.mjs']), /未配置测试映射/)
  assert.equal(selectTests(['rust-toolchain.toml']).rendererSmoke, true)
})


test('unsafe or oversized changed paths fail instead of producing an empty passing plan', () => {
  for (const invalid of ['../outside', '/tmp/file', 'src/main/../file', 'line\nbreak', 'nul\0byte', 'x'.repeat(4097)])
    assert.throws(() => selectTests([invalid]), /相对路径/)
  assert.throws(() => selectTests(Array(4097).fill('README.md')), /4096/)
})

test('branch and PR events require a precise base; release and manual events check the complete version', () => {
  const base = 'a'.repeat(40)
  for (const event of ['push', 'pull_request']) {
    assert.deepEqual(changeRange({ GITHUB_EVENT_NAME: event, GITHUB_REF_TYPE: 'branch', OC_CHAN_CI_BASE: base }), { base })
    assert.throws(() => changeRange({ GITHUB_EVENT_NAME: event, OC_CHAN_CI_BASE: '--all' }), /SHA/)
    assert.throws(() => changeRange({ GITHUB_EVENT_NAME: event }), /SHA/)
  }
  for (const environment of [
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag' },
    { GITHUB_EVENT_NAME: 'push', OC_CHAN_CI_BASE: '0'.repeat(40) }
  ]) {
    const range = changeRange(environment)
    assert.deepEqual(selectTests([], range.fullReason).tests, allTests)
  }
  assert.throws(() => changeRange({ GITHUB_EVENT_NAME: 'pull_request_target' }), /支持的CI事件/)
})

test('core tests first build a real worker and pass its exact absolute executable path', () => {
  const plan = rustCommands(['events', 'monitor'], { cwd: '/workspace/project', environment: { CARGO_TARGET_DIR: 'isolated-target' } })
  assert.deepEqual(plan.commands[0], ['build', '--locked', '-p', 'oc-core', '--bin', 'oc-data-worker', '--features', 'acceptance'])
  assert.equal(plan.env.OC_DATA_WORKER_TEST_EXECUTABLE, '/workspace/project/isolated-target/debug/oc-data-worker')
  assert.equal(plan.env.OC_DATA_WORKER, plan.env.OC_DATA_WORKER_TEST_EXECUTABLE)
  assert.deepEqual(plan.commands.slice(1).map(args => args.at(-3)), ['events::', 'monitor::'])
  assert.ok(plan.commands.slice(1).every(args => args.includes('--lib') && !args.includes('--workspace')))
  assert.equal(rustCommands(['installer']).commands.length, 1)
  assert.throws(() => rustCommands(['unknown']), /未知Rust/)
})

test('host tests prepare real catalog inputs before Tauri cargo tests in an isolated directory', () => {
  const environment = { CARGO_TARGET_DIR: 'isolated-target', OC_CHAN_RESOURCE_DIR: '/stale/resources' }
  const plan = rustCommands(['host'], { cwd: '/workspace/project', environment, hostDirectory: '/tmp/ci-owned' })
  assert.deepEqual(plan.prerequisites, [
    [process.execPath, ['/workspace/project/scripts/sparkle-sdk.mjs']],
    ['cargo', ['build', '--locked', '--release', '--target', 'aarch64-apple-darwin', '--target-dir', '/workspace/project/isolated-target', '-p', 'oc-system-monitor', '--bin', 'collector']],
    [process.execPath, ['/workspace/project/scripts/build-plugin-market-rust.mjs', '--collector', '/workspace/project/isolated-target/aarch64-apple-darwin/release/collector', '--manifest', '/workspace/project/plugins/system-monitor/manifest.json', '--out', '/tmp/ci-owned/resources/plugin-market', '--sign', '-']],
    [process.execPath, ['/workspace/project/node_modules/vite/bin/vite.js', 'build', '--outDir', '/tmp/ci-owned/frontend', '--emptyOutDir']],
  ])
  assert.equal(plan.env.OC_CHAN_RESOURCE_DIR, '/tmp/ci-owned/resources')
  assert.equal(environment.OC_CHAN_RESOURCE_DIR, '/stale/resources')
  assert.deepEqual(plan.commands.at(-1), ['test', '--locked', '-p', 'oc-chan', '--features', 'acceptance', '--', '--test-threads=1'])
  assert.deepEqual(rustCommands(['core', 'installer']).prerequisites, [])
})

test('host prerequisites fail closed and release their directory on success, nonzero exit, and spawn error', () => {
  for (const outcome of ['success', 'exit', 'error']) {
    const calls = []; let directory
    const failure = new Error('spawn failed')
    const execute = () => runRustTests(['host'], { cwd: root, environment: {}, spawn(command, args, options) {
      directory = path.dirname(options.env.OC_CHAN_RESOURCE_DIR)
      assert.equal(existsSync(directory), true)
      assert.equal(options.stdio, 'inherit')
      assert.equal(options.timeout, 20 * 60 * 1000)
      calls.push([command, args])
      if (calls.length === 2 && outcome === 'exit') return { status: 7 }
      if (calls.length === 2 && outcome === 'error') return { error: failure }
      return { status: 0 }
    } })
    if (outcome === 'error') assert.throws(execute, error => error === failure)
    else assert.equal(execute(), outcome === 'exit' ? 7 : 0)
    assert.equal(existsSync(directory), false)
    assert.equal(calls.length, outcome === 'success' ? 6 : 2)
    assert.equal(calls.some(([command, args]) => command === 'cargo' && args[0] === 'test'), outcome === 'success')
  }
})

test('commit diff reports both sides of a rename and preserves spaces without shell parsing', t => {
  const directory = temporary(t)
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--quiet')
  git('config', 'user.name', 'bowen.sun')
  git('config', 'user.email', 'bowen.sun@zstack.io')
  mkdirSync(path.join(directory, 'docs'))
  writeFileSync(path.join(directory, 'docs/old name.md'), 'previous\n')
  git('add', '--', 'docs/old name.md')
  git('commit', '--quiet', '-m', 'fixture base')
  const base = git('rev-parse', 'HEAD')
  renameSync(path.join(directory, 'docs/old name.md'), path.join(directory, 'docs/new name.md'))
  git('add', '--', 'docs/old name.md', 'docs/new name.md')
  git('commit', '--quiet', '-m', 'fixture rename')
  const changes = changedFiles(base, directory)
  assert.deepEqual(changes.files, ['docs/new name.md', 'docs/old name.md'])
  assert.deepEqual(changes.removed, ['docs/old name.md'])
  assert.deepEqual(selectTests(changes.files, undefined, changes.removed).tests, [])
  assert.deepEqual(changedFiles(git('rev-parse', 'HEAD'), directory), { files: [], removed: [] })
  assert.throws(() => changedFiles('--all', directory), /SHA/)
})

test('a real failing test returns failure and prevents the downstream stage; a passing test releases it', t => {
  const directory = temporary(t)
  const fixture = path.join(directory, 'behavior.test.mjs')
  const artifact = path.join(directory, 'downstream-stage')
  const moduleUrl = pathToFileURL(path.join(root, 'scripts/ci-tests.mjs')).href
  const entry = `import {runTests} from ${JSON.stringify(moduleUrl)};import {writeFileSync} from 'node:fs';
    const status=runTests([${JSON.stringify(fixture)}],{stdio:'pipe'});
    if(status===0)writeFileSync(${JSON.stringify(artifact)},'stage reached');process.exitCode=status;`
  // The fixture launches a fresh CI runner, not a worker of this test process.
  const environment = { ...process.env }
  delete environment.NODE_TEST_CONTEXT
  for (const fail of [true, false]) {
    writeFileSync(fixture, `import test from 'node:test';test('controlled behavior',()=>{${fail ? "throw new Error('intentional gate failure')" : ''}});\n`)
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', entry], { cwd: root, env: environment, encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, fail ? 1 : 0, result.stderr)
    assert.equal(existsSync(artifact), !fail)
  }
})
