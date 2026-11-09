import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, globSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
export const suites = {
  agents: ['src/main/collectors/agents.test.ts', 'src/main/collectors/codex-sessions.test.ts', 'src/main/live-agents.test.ts'],
  schedules: ['src/main/collectors/schedules.test.ts', 'src/main/collectors/hermes-runtime.test.ts'],
  history: ['src/main/schedule-history.test.ts', 'src/main/collectors/hermes-history.test.ts'],
  events: ['src/main/events/store.test.ts', 'src/main/events/hermes.test.ts', 'src/main/events/collector.test.ts'],
  notifications: ['src/main/events/notifications.test.ts', 'src/main/events/notification-journal.test.ts', 'src/main/events/native-notifications.test.ts'],
  system: ['src/main/collectors/system.test.ts', 'src/main/collectors/network.test.ts'],
  monitor: ['src/main/monitor.test.ts', 'src/main/shutdown.test.ts'],
  plugins: ['src/main/plugins/registry.test.ts', 'src/main/plugins/agents.test.ts', 'src/main/plugins/schedules.test.ts'],
  resources: ['src/main/resource-budget.test.ts', 'src/main/resource-io.test.ts', 'src/main/collection-limits.test.ts'],
  topology: ['src/renderer/src/agent-topology.test.ts', 'src/renderer/src/agent-topology-3d-layout.test.ts'],
  views: ['src/renderer/src/view-state.test.ts'],
  navigation: ['src/main/navigation.test.ts'],
  tern: ['src/main/tern-navigation.test.ts', 'src/main/tern-present.test.ts'],
  settings: ['src/main/settings.test.ts', 'src/main/window-geometry.test.ts', 'src/main/startup-recovery.test.ts', 'src/main/login-items.test.ts'],
  diagnostics: ['src/shared/diagnostics.test.ts', 'src/main/diagnostic-report.test.ts', 'src/main/diagnostics.test.ts'],
  ipc: ['src/main/ipc-boundary.test.ts', 'src/main/monitor-subscriptions.test.ts', 'src/main/tray-window.test.ts'],
  install: ['scripts/install-local.test.mjs', 'src/main/installation-check.test.ts'],
  updates: ['src/main/app-updates.test.ts', 'scripts/prepare-release.test.mjs', 'scripts/publish-release.test.mjs'],
  packaging: ['scripts/check-package.test.mjs', 'scripts/dependency-review.test.mjs'],
  delivery: ['scripts/local-delivery.test.mjs', 'scripts/delivery-source.test.mjs', 'scripts/delivery-zip.test.mjs'],
  performance: ['scripts/performance/core.test.mjs', 'scripts/performance/measurement.test.mjs', 'scripts/performance/fixtures.test.mjs', 'scripts/performance/soak-scenario.test.mjs', 'scripts/performance/sampler.test.mjs'],
  ci: ['scripts/ci-tests.test.mjs']
}
const product = ['agents', 'schedules', 'history', 'events', 'notifications', 'system', 'monitor', 'plugins', 'resources', 'topology', 'views', 'navigation', 'tern', 'settings', 'diagnostics', 'ipc', 'updates']
const all = Object.keys(suites)
const rules = [
  [/^(package(?:-lock)?\.json|tsconfig\.json|electron\.vite\.config\.ts)$/, all, '依赖或构建契约变更'],
  [/^src\/(?:main\/index\.ts|preload\/|shared\/types\.ts)/, product, '公共IPC/快照入口变更'],
  [/^src\/main\/(?:index\.ts|installation-check\.mts)$/, ['install'], '安装就绪协议与启动生命周期'],
  [/^src\/main\/ipc-boundary\.ts$/, ['ipc', 'settings', 'history', 'events', 'navigation'], 'IPC来源与输入边界'],
  [/^src\/main\/monitor-subscriptions\.ts$/, ['ipc'], '窗口订阅与推送生命周期'],
  [/^src\/main\/tray-window\.ts$/, ['ipc', 'diagnostics'], '按需托盘创建与加载失败清理'],
  [/^src\/main\/resource-(?:budget|io)\.ts$|^src\/shared\/resources\.ts$/, ['resources', 'agents', 'schedules', 'history', 'events', 'notifications', 'system', 'monitor', 'tern'], '全局资源预算及直接采集、通知和导航调用方'],
  [/^src\/main\/collection-limits\.ts$/, ['resources', 'agents', 'schedules'], '目录枚举和对象预算及直接消费者'],
  [/^src\/main\/collectors\/(?:agents|agent-activity|codex-sessions)\.ts$|^src\/main\/live-agents\.ts$/, ['agents', 'plugins', 'monitor', 'tern'], 'Agent采集及直接调用方'],
  [/^src\/main\/collectors\/(?:schedules|launchd|hermes-runtime)\.ts$/, ['schedules', 'plugins', 'monitor'], '任务采集及直接调用方'],
  [/^src\/main\/(?:collectors\/hermes-history|schedule-history)\.ts$/, ['history', 'plugins', 'monitor'], '执行历史及来源生命周期'],
  [/^src\/main\/events\/(?:notifications|notification-journal|notification-contracts|native-notifications)\.ts$|^src\/shared\/notifications\.ts$/, ['notifications', 'events', 'settings', 'ipc'], '本地通知、去重限流与偏好边界'],
  [/^src\/main\/events\/|^src\/shared\/events\.ts$/, ['events', 'plugins', 'monitor', 'ipc'], '本地事件采集、持久游标与有界查询'],
  [/^src\/main\/collectors\/(?:system|network)\.ts$/, ['system', 'monitor'], '系统采集及直接调用方'],
  [/^scripts\/(?:dist|release-config)\.mjs$/, ['updates', 'packaging', 'delivery', 'install'], '构建入口、发布版本与本地交付调用方'],
  [/^src\/main\/plugins\/(?:app-updates|native-update|update-controller|update-source)\.ts$|^src\/shared\/(?:updates|plugins)\.ts$|^src\/renderer\/src\/(?:UpdateSettings|updates)\.tsx$|^scripts\/(?:prepare-release|publish-release)\.mjs$/, ['updates', 'monitor', 'ipc', 'packaging'], '应用更新、原生交接与发布元数据'],
  [/^src\/main\/plugins\//, ['plugins', 'monitor', 'agents', 'schedules', 'history', 'events', 'notifications', 'system', 'settings'], '采集插件契约与生命周期'],
  [/^src\/main\/monitor\.ts$/, ['monitor', 'plugins', 'agents', 'schedules', 'history', 'events', 'system'], '采集调度与历史入口'],
  [/^src\/main\/shutdown\.ts$/, ['monitor', 'history', 'notifications', 'tern', 'diagnostics'], '应用退出排空与诊断'],
  [/^src\/main\/(?:tern-navigation\.ts|tern-present\.swift)$|^resources\/tern-navigation\//, ['tern', 'diagnostics', 'ipc'], 'Tern导航身份、诊断与窗口权限'],
  [/^src\/main\/(?:settings|desktop-settings|window-geometry|startup-recovery|login-items)\.ts$|^src\/shared\/(?:settings|themes|startup-recovery)\.ts$/, ['settings', 'plugins', 'notifications', 'ipc'], '桌面偏好、通知及来源启停边界'],
  [/^src\/main\/liquid-glass\.ts$|^src\/native\/liquid-glass\.mm$/, ['settings', 'ipc', 'packaging'], '原生材质、辅助功能与窗口生命周期'],
  [/^src\/native\/notification-permission\.mm$/, ['notifications', 'settings', 'ipc', 'packaging'], '原生通知权限与资源生命周期'],
  [/^src\/shared\/diagnostics\.ts$/, ['diagnostics', 'settings', 'tern'], '有界诊断与设置及导航错误消费者'],
  [/^src\/main\/diagnostic(?:s|-report)\.ts$|^src\/shared\/diagnostic-report\.ts$|^src\/renderer\/src\/DiagnosticPanel\.tsx$/, ['diagnostics', 'ipc'], '脱敏诊断、预览所有权与本地输出'],
  [/^src\/shared\/navigation\.ts$/, ['navigation', 'views'], '对象导航契约及查看状态'],
  [/^src\/shared\/source-capabilities\.ts$|^src\/renderer\/src\/SourcePanels\.tsx$/, ['monitor', 'navigation'], '来源能力、轻量采样心跳与来源定位'],
  [/^src\/renderer\/src\/(?:AgentTopology(?:3D)?|AgentsView|agent-topology(?:-3d-layout|-scene)?|agent-office-(?:employee|building))\.(?:ts|tsx)$/, ['topology', 'views', 'navigation'], '拓扑与对象导航'],
  [/^src\/renderer\/src\/(?:SchedulesView|ScheduleHistory)\.tsx$/, ['history', 'views', 'navigation'], '任务详情及历史'],
  [/^src\/renderer\/src\/(?:EventsView|events-view)\.(?:ts|tsx)$/, ['events', 'views', 'navigation', 'ipc'], '事件列表、稳定分页与对象直达'],
  [/^src\/renderer\/src\/view-state\.ts$/, ['views', 'topology', 'navigation'], '会话查看状态'],
  [/^src\/renderer\/src\/(?:SystemView|SystemMetrics)\.tsx$/, ['system'], '系统指标消费者'],
  [/^src\/renderer\/src\/(?:SettingsView|SettingsSaveError|StartupRecoveryView|LoginItemSetting|LiquidGlassSetting|NotificationSettings|TaskNotificationSubscription|ThemePicker|SidebarResizeHandle|settings)\.tsx$/, ['settings', 'notifications'], '偏好消费者'],
  [/^src\/renderer\/src\/(?:App|TrayView|components|main|i18n)\.tsx$/, ['topology', 'views', 'navigation', 'history', 'events', 'settings'], '跨视图入口'],
  [/^scripts\/install-(?:local|validation)\.mjs$|^\.githooks\//, ['install', 'packaging'], '本机安装预检与事务'],
  [/^scripts\/performance\//, ['performance'], '测量工具'],
  [/^scripts\/smoke-renderer\.mjs$|^scripts\/smoke\//, ['performance', 'ci'], '真实Electron smoke及夹具入口'],
  [/^scripts\/develop\.mjs$/, ['performance', 'install'], '开发启动与打包入口'],
  [/^scripts\/build-(?:native|glass|notifications)\.mjs$/, ['packaging', 'install', 'delivery'], '原生产物与安装校验'],
  [/^scripts\/smoke\.ts$/, ['agents', 'schedules', 'system', 'monitor'], '只读采集smoke调用方'],
  [/^scripts\/ci-tests\.mjs$|^\.github\/workflows\//, ['ci'], 'CI选择与执行门禁'],
  [/^scripts\/(?:check-package|dependency-review)\.mjs$|^scripts\/bundled-licenses\.ts$|^docs\/(?:package-baseline|dependency-review-policy)\.json$/, ['packaging', 'install'], '发布包内容、体积、许可证和公告门禁'],
  [/^scripts\/(?:local-delivery|delivery-source|delivery-zip)\.mjs$/, ['delivery', 'packaging', 'install'], '本地交付来源、归档内容与完整性'],
  [/\.md$|^docs\/|^\.impeccable\/|^\.gitignore$|^LICENSE(?:\..*)?$/, [], '文档/开发说明'],
  [/^src\/renderer\/.*\.(?:css|html|d\.ts)$|^resources\/(?:icon\.icns$|brand\/)/, [], '界面资源须另行真实渲染验收']
]

export function selectTests(files, fullReason, removedFiles = []) {
  if (fullReason) return { tests: Object.values(suites).flat().sort(), reasons: [fullReason], rendererSmoke: true }
  if (!Array.isArray(files) || files.length > 4096) throw new Error('改动文件清单无效或超过4096项')
  const selected = new Set(), reasons = new Set()
  const knownTests = new Set(Object.values(suites).flat())
  const removed = new Set(removedFiles)
  for (const file of files) {
    if (typeof file !== 'string' || !file || file.length > 4096 || file.startsWith('/') || file.split('/').includes('..') || /[\0\r\n]/.test(file))
      throw new Error('改动路径必须是有界的仓库相对路径')
    if (knownTests.has(file)) { selected.add(file); reasons.add('直接变更的行为测试'); continue }
    const rule = rules.find(([pattern]) => pattern.test(file))
    if (removed.has(file) && /\.test\.(?:ts|mjs)$/.test(file)) {
      for (const test of suites.ci) selected.add(test)
      reasons.add('移除测试：校验剩余测试映射')
      continue
    }
    if (!rule && removed.has(file) && /^(?:src|scripts)\//.test(file)) {
      for (const group of product) for (const test of suites[group]) selected.add(test)
      reasons.add('移除原模块且当前映射已删除：检查跨模块调用方')
      continue
    }
    if (!rule) throw new Error(`未配置测试映射：${file}；请更新 scripts/ci-tests.mjs`)
    for (const group of rule[1]) for (const test of suites[group]) selected.add(test)
    reasons.add(rule[2])
  }
  const rendererSmoke = files.some(file => !/\.test\.(?:ts|mjs)$/.test(file) &&
    /^(?:src\/|scripts\/(?:smoke-renderer\.mjs$|smoke\/|develop\.mjs$|build-(?:native|glass|notifications)\.mjs$|performance\/)|(?:package(?:-lock)?\.json|tsconfig\.json|electron\.vite\.config\.ts)$|\.github\/workflows\/)/.test(file))
  return { tests: [...selected].sort(), reasons: [...reasons].sort(), rendererSmoke }
}

export function validateTestCoverage(files) {
  const expected = new Set(Object.values(suites).flat())
  const actual = new Set(files)
  const missing = [...expected].filter(file => !actual.has(file))
  const unmapped = [...actual].filter(file => !expected.has(file))
  if (missing.length || unmapped.length) throw new Error(`测试映射与当前仓库不一致；缺失：${missing.join(', ')}；未映射：${unmapped.join(', ')}`)
}

export function changeRange(environment) {
  const event = environment.GITHUB_EVENT_NAME
  if (event === 'workflow_dispatch') return { fullReason: '手动构建完整版本：检查全部确定性行为测试' }
  if (event === 'push' && environment.GITHUB_REF_TYPE === 'tag') return { fullReason: '版本标签：检查全部确定性行为测试' }
  if (!['push', 'pull_request'].includes(event)) throw new Error('缺少支持的CI事件；本地请显式传入改动路径')
  const base = environment.OC_CHAN_CI_BASE
  if (event === 'push' && base === '0'.repeat(40)) return { fullReason: '新分支没有前序提交：检查完整版本' }
  if (!/^[0-9a-f]{40}$/.test(base ?? '')) throw new Error('CI比较基准必须是完整的提交SHA')
  return { base }
}

export function changedFiles(base, cwd = root) {
  if (!/^[0-9a-f]{40}$/.test(base ?? '')) throw new Error('比较基准不是完整提交SHA')
  const output = execFileSync('git', ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', base, 'HEAD', '--'], {
    cwd, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30000
  })
  const entries = output ? output.slice(0, -1).split('\0') : []
  if (entries.length % 2) throw new Error('Git改动清单不完整')
  const files = [], removed = []
  for (let index = 0; index < entries.length; index += 2) {
    if (!/^[ADMT]$/.test(entries[index])) throw new Error(`无法识别Git变更类型：${entries[index]}`)
    files.push(entries[index + 1])
    if (entries[index] === 'D') removed.push(entries[index + 1])
  }
  return { files, removed }
}

export function runTests(files, { cwd = root, stdio = 'inherit' } = {}) {
  if (!files.length) return 0
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=2', ...files], {
    cwd, stdio, timeout: 10 * 60 * 1000, maxBuffer: 256 * 1024
  })
  if (result.error) throw result.error
  if (result.signal) throw new Error(`行为测试被信号终止：${result.signal}`)
  return result.status
}

function main() {
  const args = process.argv.slice(2)
  const planOnly = args[0] === '--plan'
  if (planOnly) args.shift()
  if (args.some(arg => arg.startsWith('-'))) throw new Error('Usage: npm run test:ci -- [--plan] [changed/path ...]')
  validateTestCoverage(globSync(['src/**/*.test.ts', 'scripts/**/*.test.mjs'], { cwd: root }))
  const range = args.length ? {} : changeRange(process.env)
  const changes = args.length || range.fullReason ? { files: args, removed: [] } : changedFiles(range.base)
  const plan = selectTests(changes.files, range.fullReason, changes.removed)
  console.log(JSON.stringify(plan, null, 2))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `renderer_smoke=${plan.rendererSmoke}\n`)
  if (!plan.tests.length) console.log('无适用的自动化行为测试；类型检查与产物校验仍由构建步骤执行。')
  if (!planOnly) process.exitCode = runTests(plan.tests)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(error); process.exitCode = 1 }
}
