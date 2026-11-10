import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, globSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
export const suites = {
  topology: ['src/renderer/src/agent-topology.test.ts', 'src/renderer/src/agent-topology-3d-layout.test.ts'],
  views: ['src/renderer/src/view-state.test.ts', 'src/renderer/src/plugin-registry.test.ts', 'src/renderer/src/tray-selection.test.ts'],
  navigation: ['src/shared/navigation.test.ts'],
  diagnostics: ['src/shared/diagnostics.test.ts'],
  install: ['scripts/install-local.test.mjs', 'scripts/local-app-lifecycle.test.mjs', 'scripts/local-install-readiness.test.mjs', 'scripts/push-main.test.mjs', 'scripts/develop.test.mjs'],
  updates: ['scripts/prepare-release.test.mjs', 'scripts/publish-release.test.mjs'],
  packaging: ['scripts/build-app.test.mjs', 'scripts/check-package.test.mjs', 'scripts/dependency-review.test.mjs', 'scripts/rust-dependencies.test.mjs'],
  marketplace: ['scripts/build-plugin-market-rust.test.mjs'],
  delivery: ['scripts/local-delivery.test.mjs', 'scripts/delivery-source.test.mjs', 'scripts/delivery-zip.test.mjs'],
  performance: ['scripts/performance/core.test.mjs', 'scripts/performance/measurement.test.mjs', 'scripts/performance/fixtures.test.mjs', 'scripts/performance/soak-scenario.test.mjs', 'scripts/performance/sampler.test.mjs', 'scripts/performance/native-harness.test.mjs'],
  ci: ['scripts/ci-tests.test.mjs']
}
const core = filter => ({ package: 'oc-core', features: ['acceptance'], library: true, ...(filter ? { filter } : {}) })
export const rustSuites = {
  core: core(), agents: core('agents::'), schedules: core('schedules::'), events: core('events::'),
  updates: core('updates::'), marketplace: core('marketplace::'), plugins: core('plugins::'),
  monitor: core('monitor::'), settings: core('settings::'), diagnostics: core('diagnostics::'),
  navigation: core('navigation::'), tern: core('tern::'),
  installer: { package: 'oc-installer', library: true }, sdk: { package: 'oc-plugin-sdk', library: true },
  system: { package: 'oc-system-monitor' }, native: { package: 'oc-native-bridge', library: true },
  host: { package: 'oc-chan', features: ['acceptance'] }
}
const all = Object.keys(suites), allRust = ['core', 'installer', 'sdk', 'system', 'native', 'host']
const rules = [
  [/^(?:package(?:-lock)?\.json|Cargo\.(?:toml|lock)|rust-toolchain(?:\.toml)?|tsconfig\.json|vite\.config\.ts)$/, all, allRust, '依赖与跨语言构建契约变更'],
  [/^crates\/oc-core\/src\/(?:io(?:\/|\.rs)|http(?:\/|\.rs)|resources\.rs|error\.rs|lib\.rs|worker(?:\/|\.rs)|bin\/|model\/|process\.rs)/, [], ['core', 'host'], '共享IO、worker与DTO及直接宿主调用方'],
  [/^crates\/oc-core\/src\/agents\//, ['topology', 'views'], ['agents', 'monitor', 'tern'], 'Agent采集及调度、导航调用方'],
  [/^crates\/oc-core\/src\/schedules\//, ['views'], ['schedules', 'events', 'monitor'], '任务采集及事件、调度调用方'],
  [/^crates\/oc-core\/src\/events\//, ['views'], ['events', 'monitor', 'host'], '事件、通知和持久worker链路'],
  [/^crates\/oc-core\/src\/updates\//, ['updates'], ['updates'], '更新状态机与有界下载解压'],
  [/^crates\/oc-core\/src\/marketplace\//, ['marketplace'], ['marketplace', 'plugins'], '原生市场与插件生命周期'],
  [/^crates\/oc-core\/src\/plugins\//, ['marketplace'], ['plugins', 'marketplace', 'monitor'], '原生插件宿主及直接调用方'],
  [/^crates\/oc-core\/src\/monitor(?:\/|\.rs)/, ['views'], ['monitor', 'host'], '调度、快照与宿主退出'],
  [/^crates\/oc-core\/src\/settings\//, ['views'], ['settings', 'events', 'monitor'], '偏好持久化及调用方'],
  [/^crates\/oc-core\/src\/diagnostics\//, ['diagnostics'], ['diagnostics', 'host'], '脱敏诊断与导出'],
  [/^crates\/oc-core\/src\/navigation\//, ['views'], ['navigation', 'host'], '对象导航及宿主边界'],
  [/^crates\/oc-core\/src\/tern\//, [], ['tern', 'host'], 'Tern实例与真实出生身份'],
  [/^crates\/oc-core\//, ['performance'], ['core'], '核心包的其余行为与资源测量'],
  [/^crates\/oc-installer\//, ['install', 'updates'], ['installer', 'updates', 'host'], '持久安装事务及更新、就绪调用方'],
  [/^crates\/oc-plugin-sdk\//, ['marketplace'], ['sdk', 'plugins', 'marketplace', 'system'], '原生插件协议及消费者'],
  [/^plugins\/system-monitor\//, ['marketplace'], ['system', 'plugins'], '系统插件与宿主协议'],
  [/^src-tauri\//, ['views', 'diagnostics', 'install'], ['host'], 'Tauri宿主与真实WebKit入口'],
  [/^native\//, ['install', 'packaging'], ['native', 'host'], '原生窗口、权限、材质和输入桥接'],
  [/^src\/renderer\/src\/(?:AgentTopology|agent-topology|agent-office|AgentsView)/, ['topology', 'views'], ['navigation'], '拓扑交互及定位'],
  [/^src\/renderer\//, ['topology', 'views'], [], '渲染与视图状态'],
  [/^src\/plugins\//, ['views', 'marketplace'], ['system', 'plugins'], '插件界面贡献与原生插件契约'],
  [/^src\/shared\//, ['diagnostics', 'views', 'navigation'], ['core', 'host'], '前后端DTO契约'],
  [/^scripts\/local-install-lock\.test\.c$/, ['install'], [], '本机安装锁的原生测试观察器'],
  [/^scripts\/(?:install-(?:local|validation)|local-install-(?:readiness|process)|local-app-lifecycle|push-main|develop)\.(?:mjs|m)$|^\.githooks\//, ['install', 'delivery'], ['installer'], '本机安装、真实就绪与实例归属'],
  [/^scripts\/(?:prepare-release|publish-release|release-config|dist)\.mjs$/, ['updates', 'packaging'], ['updates'], 'schema2发布与打包'],
  [/^scripts\/(?:build-app|check-package|dependency-review|rust-dependencies)\.mjs$|^scripts\/bundled-licenses\.ts$|^docs\/(?:package-baseline|dependency-review-policy)\.json$|^resources\/rust-license-supplements\//, ['packaging', 'delivery'], [], 'Rust产物、锁绑定审计与完整许可证'],
  [/^scripts\/build-plugin-market-rust\.mjs$|^plugin-market\//, ['marketplace', 'packaging'], ['marketplace', 'system'], '原生插件发布目录'],
  [/^scripts\/build-marketplace-fixtures\.mjs$/, ['marketplace', 'performance', 'install'], ['marketplace', 'plugins', 'system'], '原生市场验收夹具与真实宿主场景'],
  [/^scripts\/probes\/wk\//, ['performance', 'install'], ['host'], '独立WKWebView探针与原生验收驱动'],
  [/^scripts\/(?:local-delivery|delivery-source|delivery-zip)\.mjs$/, ['delivery', 'packaging', 'install'], [], '交付快照与归档完整性'],
  [/^scripts\/performance\//, ['performance'], [], '资源性能测量工具'],
  [/^scripts\/smoke-renderer\.mjs$|^scripts\/smoke\//, ['performance', 'install'], ['host'], '真实WKWebView验收与隔离夹具'],
  [/^scripts\/ci-tests\.mjs$|^\.github\/workflows\//, ['ci'], [], 'CI行为选择与执行门禁'],
  [/^resources\//, ['packaging'], ['host'], '生产原生资源'],
  [/\.md$|^docs\/|^\.impeccable\/|^\.gitignore$|^LICENSE(?:\..*)?$/, [], [], '文档与开发说明']
]
// Retired entry points are accepted only as deletions, with their replacement modules.
const retiredRules = [
  [/^electron\.vite\.config\.ts$/, ['topology', 'views', 'navigation', 'packaging'], [], '删除Electron构建配置，检查前端与原生打包'],
  [/^scripts\/build-(?:glass|native|notifications)\.mjs$|^src\/native\/(?:liquid-glass|notification-permission)\.mm$/, ['packaging', 'install'], ['native', 'host'], '移除旧原生桥接，检查Rust宿主'],
  [/^scripts\/build-plugin-market(?:\.test)?\.mjs$/, ['marketplace', 'packaging'], ['marketplace', 'system'], '移除旧插件打包，检查原生市场'],
  [/^scripts\/smoke\.ts$/, ['performance', 'install'], ['host'], '移除旧smoke入口，检查WKWebView验收'],
  [/^src\/main\/(?:collectors\/(?:agent-activity|agents|codex-sessions|hermes-history|hermes-runtime)|live-agents)(?:\.test)?\.ts$/, ['topology', 'views'], ['agents', 'monitor', 'tern'], '移除旧Agent采集，检查原生采集调用方'],
  [/^src\/main\/(?:collectors\/(?:launchd|schedules)|schedule-history)(?:\.test)?\.ts$/, ['views'], ['schedules', 'events', 'monitor'], '移除旧任务采集，检查任务与事件'],
  [/^src\/main\/events\/(?:collector|contracts|hermes|native-notifications|notification-contracts|notification-journal|notifications|store)(?:\.test)?\.ts$/, ['views'], ['events', 'monitor', 'host'], '移除旧事件链路，检查通知与宿主'],
  [/^src\/main\/(?:app-updates|plugins\/(?:app-updates|native-update|update-controller|update-source))(?:\.test)?\.ts$/, ['updates'], ['updates', 'installer', 'host'], '移除旧更新链路，检查原生更新事务'],
  [/^src\/main\/marketplace\/(?:io|loader|manager|sdk|validation)(?:\.test)?\.ts$/, ['marketplace'], ['marketplace', 'plugins'], '移除旧市场，检查原生市场与插件'],
  [/^src\/main\/plugins\/(?:agents|catalog|contracts|events|lazy|registry|schedules)(?:\.test)?\.ts$/, ['views', 'marketplace'], ['plugins', 'monitor'], '移除旧插件宿主，检查原生插件调度'],
  [/^src\/main\/(?:diagnostic-report|diagnostics)(?:\.test)?\.ts$/, ['diagnostics'], ['diagnostics', 'host'], '移除旧诊断，检查原生诊断导出'],
  [/^src\/main\/(?:navigation|tern-navigation|tern-present)(?:\.test)?\.(?:ts|swift)$/, ['navigation', 'views'], ['navigation', 'tern', 'native', 'host'], '迁移原生导航与Tern窗口呈现'],
  [/^src\/main\/(?:collection-limits|resource-budget|resource-io)(?:\.test)?\.ts$/, ['performance'], ['core', 'host'], '移除旧资源约束，检查Rust资源预算'],
  [/^src\/main\/(?:desktop-settings|liquid-glass|login-items|settings|tray-window|window-geometry)(?:\.test)?\.ts$/, ['views', 'install'], ['settings', 'native', 'host'], '移除旧桌面偏好与窗口，检查原生宿主'],
  [/^src\/main\/(?:index|installation-check|ipc-boundary|monitor-subscriptions|monitor|shutdown|startup-recovery)(?:\.test)?\.(?:ts|mts)$|^src\/preload\/index\.ts$/, ['views', 'install'], ['monitor', 'installer', 'host'], '移除旧进程入口，检查原生生命周期与IPC']
]
export function selectTests(files, fullReason, removedFiles = []) {
  if (fullReason) return { tests: Object.values(suites).flat().sort(), rust: [...allRust], reasons: [fullReason], rendererSmoke: true }
  if (!Array.isArray(files) || files.length > 4096) throw new Error('改动文件清单无效或超过4096项')
  const selected = new Set(), rust = new Set(), reasons = new Set(), known = new Set(Object.values(suites).flat()), removed = new Set(removedFiles)
  for (const file of files) {
    if (typeof file !== 'string' || !file || file.length > 4096 || file.startsWith('/') || file.split('/').includes('..') || /[\0\r\n]/.test(file)) throw new Error('改动路径必须是有界的仓库相对路径')
    const deletedTest = removed.has(file) && /\.test\.(?:ts|mjs)$/.test(file)
    if (known.has(file)) { selected.add(file); reasons.add('直接变更的行为测试'); continue }
    const rule = rules.find(([pattern]) => pattern.test(file)) ?? (removed.has(file) ? retiredRules.find(([pattern]) => pattern.test(file)) : undefined)
    if (!rule) throw new Error(`未配置测试映射：${file}；请更新scripts/ci-tests.mjs`)
    if (deletedTest) { suites.ci.forEach(item => selected.add(item)); reasons.add('删除测试时验证完整映射') }
    rule[1].forEach(group => suites[group].forEach(item => selected.add(item))); rule[2].forEach(item => rust.add(item)); reasons.add(rule[3])
  }
  if (rust.has('core')) for (const key of [...rust]) if (key !== 'core' && rustSuites[key].package === 'oc-core') rust.delete(key)
  const rendererSmoke = files.some(file => removed.has(file) && retiredRules.some(([pattern]) => pattern.test(file)) || !/\.test\.(?:ts|mjs)$/.test(file) && /^(?:src\/|src-tauri\/|native\/|crates\/|plugins\/|plugin-market\/|resources\/|scripts\/(?:smoke|develop|build-app|build-plugin-market-rust|build-marketplace-fixtures|probes\/wk\/)|(?:package(?:-lock)?\.json|Cargo\.(?:toml|lock)|rust-toolchain(?:\.toml)?|tsconfig\.json|vite\.config\.ts)$|\.github\/workflows\/)/.test(file))
  return { tests: [...selected].sort(), rust: [...rust].sort(), reasons: [...reasons].sort(), rendererSmoke }
}
export function validateTestCoverage(files) {
  const expected = new Set(Object.values(suites).flat()), actual = new Set(files)
  const missing = [...expected].filter(file => !actual.has(file)), unmapped = [...actual].filter(file => !expected.has(file))
  if (missing.length || unmapped.length) throw new Error(`测试映射与当前仓库不一致；缺失：${missing.join(', ')}；未映射：${unmapped.join(', ')}`)
}
export function changeRange(environment) {
  const event = environment.GITHUB_EVENT_NAME
  if (event === 'workflow_dispatch') return { fullReason: '手动构建完整版本：全部确定性行为测试' }
  if (event === 'push' && environment.GITHUB_REF_TYPE === 'tag') return { fullReason: '版本标签：全部确定性行为测试' }
  if (!['push', 'pull_request'].includes(event)) throw new Error('缺少支持的CI事件；本地请显式传入改动路径')
  const base = environment.OC_CHAN_CI_BASE
  if (event === 'push' && base === '0'.repeat(40)) return { fullReason: '新分支没有前序提交：检查完整版本' }
  if (!/^[0-9a-f]{40}$/.test(base ?? '')) throw new Error('CI比较基准必须是完整的提交SHA')
  return { base }
}
export function changedFiles(base, cwd = root) {
  if (!/^[0-9a-f]{40}$/.test(base ?? '')) throw new Error('比较基准不是完整提交SHA')
  const output = execFileSync('git', ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', base, 'HEAD', '--'], { cwd, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30000 })
  const entries = output ? output.slice(0, -1).split('\0') : []
  if (entries.length % 2) throw new Error('Git改动清单不完整')
  const files = [], removed = []
  for (let index = 0; index < entries.length; index += 2) { if (!/^[ADMT]$/.test(entries[index])) throw new Error(`无法识别Git变更类型：${entries[index]}`); files.push(entries[index + 1]); if (entries[index] === 'D') removed.push(entries[index + 1]) }
  return { files, removed }
}
function exitStatus(result) { if (result.error) throw result.error; if (result.signal) throw new Error(`行为测试被信号终止：${result.signal}`); return result.status }
export function runTests(files, { cwd = root, stdio = 'inherit' } = {}) {
  return files.length ? exitStatus(spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=2', ...files], { cwd, stdio, timeout: 10 * 60 * 1000, maxBuffer: 256 * 1024 })) : 0
}
export function rustCommands(groups, { cwd = root, environment = process.env, hostDirectory = path.join(path.resolve(cwd, environment.CARGO_TARGET_DIR ?? 'target'), 'ci-host') } = {}) {
  if (!Array.isArray(groups) || groups.some(group => !Object.hasOwn(rustSuites, group))) throw new Error('未知Rust测试组')
  const commands = [], prerequisites = [], env = { ...environment }
  if (groups.includes('host')) {
    const target = path.resolve(cwd, environment.CARGO_TARGET_DIR ?? 'target')
    const resources = path.join(hostDirectory, 'resources'), frontend = path.join(hostDirectory, 'frontend')
    env.OC_CHAN_RESOURCE_DIR = resources
    env.TAURI_CONFIG = JSON.stringify({ build: { frontendDist: frontend } })
    prerequisites.push(
      ['cargo', ['build', '--locked', '--release', '--target', 'aarch64-apple-darwin', '--target-dir', target, '-p', 'oc-system-monitor', '--bin', 'collector']],
      [process.execPath, [path.join(cwd, 'scripts/build-plugin-market-rust.mjs'), '--collector', path.join(target, 'aarch64-apple-darwin/release/collector'), '--manifest', path.join(cwd, 'plugins/system-monitor/manifest.json'), '--out', path.join(resources, 'plugin-market'), '--sign', '-']],
      [process.execPath, [path.join(cwd, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', frontend, '--emptyOutDir']]
    )
  }
  if (groups.some(group => ['oc-core', 'oc-chan'].includes(rustSuites[group].package))) {
    commands.push(['build', '--locked', '-p', 'oc-core', '--bin', 'oc-data-worker', '--features', 'acceptance'])
    const worker = path.join(path.resolve(cwd, environment.CARGO_TARGET_DIR ?? 'target'), 'debug/oc-data-worker')
    env.OC_DATA_WORKER_TEST_EXECUTABLE = worker; env.OC_DATA_WORKER = worker
  }
  for (const group of groups) {
    const item = rustSuites[group], args = ['test', '--locked', '-p', item.package]
    if (item.features) args.push('--features', item.features.join(','))
    if (item.library) args.push('--lib')
    if (item.filter) args.push(item.filter)
    args.push('--', '--test-threads=1'); commands.push(args)
  }
  return { commands, prerequisites, env }
}
export function runRustTests(groups, { cwd = root, stdio = 'inherit', environment = process.env, spawn = spawnSync } = {}) {
  const hostDirectory = groups.includes('host') ? mkdtempSync(path.join(tmpdir(), 'oc-ci-host-')) : undefined
  try {
    const plan = rustCommands(groups, { cwd, environment, hostDirectory })
    for (const [command, args] of [...plan.prerequisites, ...plan.commands.map(args => ['cargo', args])]) {
      const status = exitStatus(spawn(command, args, { cwd, env: plan.env, stdio, timeout: 20 * 60 * 1000, maxBuffer: 512 * 1024, killSignal: 'SIGKILL' }))
      if (status !== 0) return status
    }
    return 0
  } finally {
    if (hostDirectory) rmSync(hostDirectory, { recursive: true })
  }
}
function main() {
  const args = process.argv.slice(2), planOnly = args[0] === '--plan'; if (planOnly) args.shift()
  if (args.some(arg => arg.startsWith('-'))) throw new Error('Usage: npm run test:ci -- [--plan] [changed/path ...]')
  validateTestCoverage(globSync(['src/**/*.test.ts', 'plugins/**/*.test.ts', 'scripts/**/*.test.mjs'], { cwd: root }))
  const range = args.length ? {} : changeRange(process.env), changes = args.length || range.fullReason ? { files: args, removed: [] } : changedFiles(range.base)
  const plan = selectTests(changes.files, range.fullReason, changes.removed); console.log(JSON.stringify(plan, null, 2))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `renderer_smoke=${plan.rendererSmoke}\n`)
  if (!planOnly) { const status = runTests(plan.tests); process.exitCode = status === 0 ? runRustTests(plan.rust) : status }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { main() } catch (error) { console.error(error); process.exitCode = 1 } }
