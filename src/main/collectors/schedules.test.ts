import assert from 'node:assert/strict'
import test from 'node:test'
import type { ScheduledJob, SourceStatus } from '../../shared/types'
import { describeCalendar, describeCron, describeLaunchSchedule, mergeOmpMetadata,
  parseCrontab, projectLaunchPlist, assembleScheduleSnapshot, launchOrigin, ScheduleCollector } from './schedules'
import { launchState, parseLaunchDisabled, parseLaunchServices, LaunchdCollector, runLaunchCommand, type LaunchCommand } from './launchd'
import { mkdtemp, mkdir, writeFile, appendFile, stat, utimes, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { collectionResources } from '../resource-budget'

test('calendar 对象保留通配字段，Day 与 Weekday 按或匹配', () => {
  assert.equal(describeCalendar({ Hour: 8, Minute: 15 }), '每月每日 08时15分')
  assert.equal(describeCalendar({ Month: 11, Day: 2, Weekday: 1, Minute: 0 }), '11月（2日或周一） 每小时00分')
  assert.equal(describeCalendar({}), '每月每日 每小时每分钟')
  assert.equal(describeCalendar({ Weekday: 7, Hour: 0 }), '每月周日 00时每分钟')
})

test('calendar 数组代表多个独立触发条件', () => {
  const result = describeLaunchSchedule({ StartCalendarInterval: [{ Hour: 8, Minute: 0 }, { Hour: 18, Minute: 30 }] })
  assert.equal(result.kind, 'calendar')
  assert.match(result.schedule, /08时00分；或 每月每日 18时30分/)
  assert.throws(() => describeCalendar([]))
  assert.throws(() => describeCalendar({ Minute: 60 }))
})

test('未确认的 Second 扩展保留原值与任务，并提供来源警告', () => {
  const warnings: string[] = []
  const result = describeLaunchSchedule({ StartCalendarInterval: { Hour: 12, Minute: 0, Second: 0 } }, warnings)
  assert.equal(result.kind, 'calendar')
  assert.match(result.schedule, /12时00分/)
  assert.match(result.schedule, /Second=0（是否生效未确认）/)
  assert.deepEqual(warnings, ['未确认日历扩展字段 Second=0 是否参与调度'])
  const arrayWarnings: string[] = []
  assert.match(describeCalendar([{ Hour: 8, Second: 30 }, { Hour: 18 }], arrayWarnings), /Second=30/)
  assert.equal(arrayWarnings.length, 1)
  assert.doesNotMatch(describeCalendar({ Hour: 12, Unknown: 'private-content' }), /private-content/)
})

test('interval 与 calendar 可以同时配置，不能丢失任何触发条件', () => {
  const interval = describeLaunchSchedule({ StartInterval: 60 })
  assert.equal(interval.kind, 'interval')
  assert.match(interval.schedule, /每 60 秒/)
  const combined = describeLaunchSchedule({ StartCalendarInterval: { Minute: 5 }, StartInterval: 600, RunAtLoad: true })
  assert.equal(combined.kind, 'calendar')
  assert.match(combined.schedule, /每小时05分/)
  assert.match(combined.schedule, /每 600 秒/)
  assert.match(combined.schedule, /加载时也运行/)
  assert.throws(() => describeLaunchSchedule({ StartInterval: 0 }))
})

test('KeepAlive 和 RunAtLoad 不计为定时任务', () => {
  assert.equal(describeLaunchSchedule({ KeepAlive: true }).kind, 'service')
  assert.equal(describeLaunchSchedule({ KeepAlive: { SuccessfulExit: false }, RunAtLoad: true }).kind, 'service')
  assert.equal(describeLaunchSchedule({ RunAtLoad: true, KeepAlive: false }).kind, 'startup')
  assert.equal(describeLaunchSchedule({ WatchPaths: ['/somewhere'] }).kind, 'service')
})

test('解析 launchctl 域表只取 PID、退出码和服务名', () => {
  const services = parseLaunchServices('gui/501 = {\n services = {\n 42 - com.example.running\n 0 78 com.example.failed\n 0 - com.example.waiting\n }\n environment = { SECRET = private }\n}')
  assert.equal(services.size, 3)
  assert.deepEqual(services.get('com.example.running'), { pid: 42, lastExitCode: undefined })
  assert.deepEqual(services.get('com.example.failed'), { pid: undefined, lastExitCode: 78 })
  assert.equal(JSON.stringify([...services]).includes('private'), false)
  assert.throws(() => parseLaunchServices('permission denied'))
  assert.throws(() => parseLaunchServices('services = {\n unknown format\n}'))
})

test('launchctl 第二列的状态标记不是退出码，保留真实运行 PID', () => {
  const services = parseLaunchServices('system = {\n services = {\n 2474 (jt) com.apple.modelmanagerd\n 80019 (jt) com.apple.gamepolicyd\n 0 78 com.example.failed\n }\n}')
  assert.equal(services.size, 3)
  for (const [label, pid] of [['com.apple.modelmanagerd', 2474], ['com.apple.gamepolicyd', 80019]] as const) {
    const runtime = services.get(label)
    assert.deepEqual(runtime, { pid, lastExitCode: undefined })
    assert.equal(launchState(runtime, undefined, false, true, true), 'running')
  }
  assert.equal(services.get('com.example.failed')?.lastExitCode, 78)
})

test('空字典与 jetsam 数据不是服务，真正缺少 Label 的服务仍报错', () => {
  assert.equal(projectLaunchPlist({}), null)
  assert.equal(projectLaunchPlist({ Version4: { MemoryCapacity: 16 } }), null)
  assert.throws(() => projectLaunchPlist({ Program: '/bin/run' }))
  assert.throws(() => projectLaunchPlist({ StartInterval: 60 }))
  assert.throws(() => projectLaunchPlist({ Label: '' }))
  assert.throws(() => projectLaunchPlist([]))
  const service = projectLaunchPlist({ Label: 'example', ProgramArguments: ['/bin/run', '--secret=value'],
    EnvironmentVariables: { TOKEN: 'private' }, StartInterval: 60 })
  assert.equal(service?.Program, '/bin/run')
  assert.equal(service?.StartInterval, 60)
  assert.doesNotMatch(JSON.stringify(service), /secret|private|TOKEN|ProgramArguments/)
})

test('disabled 解析支持 launchctl 文本布尔和 enabled/disabled', () => {
  const disabled = parseLaunchDisabled('disabled services = {\n "a" => disabled\n "b" => enabled\n "c" => true\n "d" => false\n}')
  assert.deepEqual([...disabled], [['a', true], ['b', false], ['c', true], ['d', false]])
  assert.throws(() => parseLaunchDisabled('failed'))
})

test('运行事实优先，显式 enable 覆盖 plist Disabled，读取失败不是 unloaded', () => {
  assert.equal(launchState({ pid: 42 }, true, true, true, true), 'running')
  assert.equal(launchState({}, true, false, true, true), 'disabled')
  assert.equal(launchState({}, false, true, true, true), 'waiting')
  assert.equal(launchState(undefined, undefined, true, true, true), 'disabled')
  assert.equal(launchState(undefined, undefined, true, false, false), 'unknown')
  assert.equal(launchState(undefined, false, false, true, true), 'unloaded')
})

test('OMP 元数据按 Label 与 launchd 合并，不重复计算任务', () => {
  const launchd: ScheduledJob = { id: 'launchd:user:com.user.omp-cron.daily', name: 'com.user.omp-cron.daily',
    source: 'launchd', scope: 'user', origin: 'unknown', kind: 'calendar', schedule: '每日 08:00', state: 'waiting', file: '/daily.plist' }
  const metadata = { id: 'daily', label: 'com.user.omp-cron.daily', name: '每日汇总', enabled: false }
  const jobs = mergeOmpMetadata([launchd], [metadata, metadata], '/jobs.json')
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].name, '每日汇总')
  assert.equal(jobs[0].state, 'disabled')
  assert.equal(jobs[0].origin, 'personal')
  assert.equal(jobs[0].kind, 'calendar')
  assert.equal(jobs[0].file, '/daily.plist')
})

test('OMP 未安装 plist 的任务保留为 unloaded，已运行任务不被元数据覆盖', () => {
  const metadata = { id: 'absent', enabled: true, schedule: { kind: 'cron', expr: '0 8 * * 1-5' } }
  const jobs = mergeOmpMetadata([], [metadata, metadata], '/jobs.json')
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].state, 'unloaded')
  assert.equal(jobs[0].origin, 'personal')
  assert.equal(jobs[0].kind, 'calendar')
  const running: ScheduledJob = { id: 'launchd:user:com.user.omp-cron.absent', name: 'absent',
    source: 'launchd', scope: 'user', origin: 'unknown', kind: 'service', schedule: '未知', state: 'running', pid: 42 }
  const merged = mergeOmpMetadata([running], [{ ...metadata, enabled: false }], '/jobs.json')
  assert.equal(merged[0].state, 'running')
  assert.equal(merged[0].kind, 'calendar')
  assert.equal(merged[0].origin, 'personal')
})

test('crontab 保留表达式语义并移除命令、环境、注释内容', () => {
  const result = parseCrontab('# secret comment\nTOKEN=private\n*/15 8-18 * * MON-FRI /bin/run --token=secret\n@reboot /bin/start --password=hidden\n')
  assert.equal(result.invalid, 0)
  assert.equal(result.jobs.length, 2)
  assert.equal(result.jobs[0].kind, 'calendar')
  assert.equal(result.jobs[1].kind, 'startup')
  assert.equal(result.jobs[0].state, 'unknown')
  assert.equal(result.jobs[0].origin, 'personal')
  assert.match(result.jobs[0].schedule, /分 \*\/15 · 时 8-18/)
  assert.match(result.jobs[0].schedule, /周 MON-FRI/)
  assert.doesNotMatch(JSON.stringify(result), /private|secret|hidden|\/bin\/|TOKEN/)
})

test('无效 crontab 行不能将命令误当成调度字段输出', () => {
  const parsed = parseCrontab('echo secret values must stay private\n99 0 * * * /bin/run\n@unsupported /bin/run\n')
  assert.equal(parsed.invalid, 3)
  assert.deepEqual(parsed.jobs, [])
  assert.throws(() => describeCron('0 25 * * *'))
  assert.match(describeCron('0 8 1 JAN MON'), /日与周均受限时满足其一/)
})


test('配置源失败不会被空 crontab 或重建的 runtime service 掩盖', () => {
  const crontab: SourceStatus = { id: 'crontab', label: 'crontab', state: 'ok', detail: '当前用户未配置 crontab' }
  const runtime: ScheduledJob = { id: 'launchd:user:daily', name: 'daily', source: 'launchd · 运行时服务',
    scope: 'user', origin: 'unknown', kind: 'service', schedule: '未知', state: 'running', pid: 42 }
  for (const [id, detail] of [['/Library/LaunchAgents', '权限不足'], ['/System/Library/LaunchDaemons', '1 个读取失败'],
    ['omp-cron', '1 条格式无效'], ['hermes-job:bad', '数据格式无效或读取失败'], ['crontab', '1 行无法解析']]) {
    const failure: SourceStatus = { id, label: id, state: 'error', detail }
    assert.throws(() => assembleScheduleSnapshot([], [failure, crontab], 'later'), /调度配置采集不完整/)
    assert.throws(() => assembleScheduleSnapshot([runtime], [failure, crontab], 'later'), /调度配置采集不完整/)
  }
})

test('完整配置可在运行状态未知或保留未知扩展时成功，不改变定时分类', () => {
  const warnings: string[] = []
  const job: ScheduledJob = { id: 'launchd:system:telemetry', name: 'telemetry', source: 'launchd', scope: 'system', origin: 'system',
    ...describeLaunchSchedule({ StartCalendarInterval: { Hour: 12, Minute: 0, Second: 0 } }, warnings),
    state: launchState(undefined, undefined, false, false, false) }
  const snapshot = assembleScheduleSnapshot([job], [
    { id: 'launchctl:system', label: '运行状态', state: 'partial', detail: '服务状态：权限不足' },
    { id: '/System/Library/LaunchDaemons', label: '系统配置', state: 'partial', detail: warnings.join('；') }
  ], 'now')
  assert.equal(snapshot.jobs[0].kind, 'calendar')
  assert.equal(snapshot.jobs[0].state, 'unknown')
  assert.match(snapshot.jobs[0].schedule, /Second=0/)
})

test('不存在的目录和未配置任务允许真实空快照，多项配置错误一起报告', () => {
  assert.deepEqual(assembleScheduleSnapshot([], [
    { id: '/Library/LaunchAgents', label: '用户配置', state: 'ok', detail: '目录不存在' },
    { id: 'omp-cron', label: 'OMP', state: 'ok', detail: '未配置任务元数据' }
  ], 'now').jobs, [])
  assert.throws(() => assembleScheduleSnapshot([], [
    { id: 'omp-cron', label: 'OMP', state: 'error', detail: '权限不足' },
    { id: 'hermes-cron', label: 'Hermes', state: 'error', detail: '数据格式无效或读取失败' }
  ], 'now'), /OMP：权限不足；Hermes：数据格式无效或读取失败/)
})

test('个人命名配置与主目录脚本可识别，包括安装到系统域的个人脚本', () => {
  const home = '/Users/example'
  const file = `${home}/Library/LaunchAgents/custom.plist`
  assert.equal(launchOrigin({ Label: 'com.user.login', Program: '/usr/bin/open' }, file, home), 'personal')
  assert.equal(launchOrigin({ Label: 'local.project.start', ProgramArguments: ['/usr/bin/open', '/Applications/Docker.app'] }, file, home), 'personal')
  assert.equal(launchOrigin({ Label: 'com.team.report', ProgramArguments: ['/usr/bin/python3', `${home}/reports/daily.py`, '--token=private'] }, file, home), 'personal')
  assert.equal(launchOrigin({ Label: 'com.team.update', ProgramArguments: [`${home}/.local/bin/python3.11`, `${home}/.local/share/tools/update.py`] }, file, home), 'personal')
  assert.equal(launchOrigin({ Label: 'custom', Program: `${home}/scripts/backup.sh` }, '/Library/LaunchDaemons/custom.plist', home), 'personal')
})

test('Python 的无参数开关不遮蔽个人脚本，内联代码和选项值不被当作入口', () => {
  const home = '/Users/example'
  const file = `${home}/Library/LaunchAgents/report.plist`
  const origin = (args: string[]) => launchOrigin({ Label: 'report', ProgramArguments: ['/usr/bin/python3.11', ...args] }, file, home)
  assert.equal(origin(['-u', '-B', `${home}/reports/daily.py`]), 'personal')
  assert.equal(origin(['-IB', '--', `${home}/reports/daily.py`]), 'personal')
  assert.equal(origin(['-u', '-c', `${home}/reports/daily.py`]), 'unknown')
  assert.equal(origin(['-W', `${home}/reports/daily.py`, '/opt/vendor/main.py']), 'unknown')
})

test('系统、应用更新器及调度器自身不属于个人任务，即使位于用户目录', () => {
  const home = '/Users/example'
  const file = `${home}/Library/LaunchAgents/example.plist`
  assert.equal(launchOrigin({ Label: 'com.apple.telemetry', Program: `${home}/script.sh` }, file, home), 'system')
  assert.equal(launchOrigin({ Label: 'com.user.example' }, '/System/Library/LaunchAgents/example.plist', home), 'system')
  assert.equal(launchOrigin({ Label: 'vendor.update', Program: `${home}/Library/Application Support/Vendor/Updater.app/Contents/MacOS/Updater` }, file, home), 'application')
  assert.equal(launchOrigin({ Label: 'vendor.update', ProgramArguments: ['/usr/bin/python3', `${home}/Library/Application Support/Vendor/update.py`] }, file, home), 'unknown')
  assert.equal(launchOrigin({ Label: 'vendor.start', ProgramArguments: ['/usr/bin/open', '/Applications/Vendor.app'] }, file, home), 'application')
  assert.equal(launchOrigin({ Label: 'ai.hermes.cron-tick', Program: `${home}/scripts/scheduler.sh` }, file, home), 'application')
  assert.equal(launchOrigin({ Label: 'ai.hermes.gateway' }, file, home), 'application')
})

test('非 Apple 名称和用户路径不足以把未知来源或命令参数当作个人任务', () => {
  const home = '/Users/example'
  const file = `${home}/Library/LaunchAgents/vendor.plist`
  assert.equal(launchOrigin({ Label: 'vendor.service', Program: '/opt/vendor/bin/daemon' }, file, home), 'unknown')
  assert.equal(launchOrigin({ Label: 'com.user.shared' }, '/Library/LaunchAgents/shared.plist', home), 'unknown')
  assert.equal(launchOrigin({ Label: 'vendor.service', ProgramArguments: ['/usr/bin/python3', '/opt/vendor/runner.py', `${home}/payload.py`] }, file, home), 'unknown')
  assert.equal(launchOrigin({ Label: 'vendor.service', ProgramArguments: ['/bin/sh', '-c', `${home}/script.sh`] }, file, home), 'unknown')
  assert.equal(launchOrigin({ Label: 'vendor.service', Program: `${home}-other/script.sh` }, file, home), 'unknown')
  assert.equal(launchOrigin({ Label: 'vendor.service', Program: `${home}/scripts/../Library/vendor.py` }, file, home), 'unknown')
  assert.equal(launchOrigin({ Label: 'vendor.service', ProgramArguments: ['node', `${home}/project/node_modules/vendor/start.js`] }, file, home), 'unknown')
})

test('launchctl 问号只表示退出码未知，不丢失 PID 或相邻服务', () => {
  const services = parseLaunchServices('system = {\n services = {\n 86535 ? local.running\n 0 ? local.idle\n 0 78 local.failed\n }\n}')
  assert.deepEqual(services.get('local.running'), { pid: 86535, lastExitCode: undefined })
  assert.equal(launchState(services.get('local.running'), undefined, false, true, true), 'running')
  assert.equal(launchState(services.get('local.idle'), undefined, false, true, true), 'waiting')
  assert.equal(services.get('local.failed')?.lastExitCode, 78)
})

test('命令、权限、超时、结构与行错误各自诊断且不泄露原始内容', async () => {
  const cases = [
    { failure: { code: 113, stderr: 'private command environment' }, stage: 'command', code: 'command-failed', retryable: true },
    { failure: { code: 'EPERM', stderr: 'private' }, stage: 'permission', code: 'permission-denied', retryable: true },
    { failure: { code: 1, stderr: 'Operation not permitted private' }, stage: 'permission', code: 'permission-denied', retryable: true },
    { failure: { killed: true, signal: 'SIGTERM', stdout: 'private' }, stage: 'timeout', code: 'timed-out', retryable: true },
    { failure: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, stage: 'limit', code: 'output-limit', retryable: false },
    { failure: { code: 'OC_RESOURCE_LIMIT' }, stage: 'limit', code: 'resource-limit', retryable: true },
    { failure: { code: 'OC_RESOURCE_QUEUE_TIMEOUT' }, stage: 'queue', code: 'queue-timeout', retryable: true },
    { failure: { code: 'ENOENT' }, stage: 'command', code: 'command-missing', retryable: false },
    { output: 'changed table private', stage: 'structure', code: 'missing-table', retryable: false },
    { output: 'services = {\n private unrecognized row\n}\n', stage: 'row', code: 'invalid-row', retryable: false }
  ]
  for (const item of cases) {
    const reader = new LaunchdCollector(async (_file, [operation, domain]) => {
      if (operation === 'print-disabled') return 'disabled services = {\n "local.disabled" => true\n}\n'
      if (domain !== 'system') return 'services = {\n 42 - local.healthy\n}\n'
      if (item.failure) throw Object.assign(new Error('private exception'), item.failure)
      return item.output!
    }, 501, () => '2026-11-04T12:00:00.000Z')
    await Promise.all(reader.domains.map(domain => reader.read(domain)))
    const system = reader.get('system')
    assert.equal(system.loadedKnown, false)
    assert.equal(system.disabledKnown, true)
    assert.equal(launchState(undefined, system.disabled.get('local.disabled'), false, false, true), 'disabled')
    assert.equal(launchState(undefined, undefined, false, false, true), 'unknown')
    assert.deepEqual(system.source.diagnostics?.map(({ stage, code, retryable, operation }) => ({ stage, code, retryable, operation })),
      [{ stage: item.stage, code: item.code, retryable: item.retryable, operation: 'services' }])
    assert.equal(system.source.lastSuccessAt, undefined)
    assert.equal(system.source.lastAttemptAt, '2026-11-04T12:00:00.000Z')
    assert.doesNotMatch(JSON.stringify(system.source), /private|stderr|stdout|exception|stack/)
    assert.equal(reader.get('gui/501').source.state, 'ok')
    assert.equal(reader.get('user/501').services.get('local.healthy')?.pid, 42)
  }
})

test('服务表与禁用表各自失败，旧条目不充当当前运行证据，恢复清除原因', async () => {
  let servicesFail = false, disabledFail = false, second = 0
  const reader = new LaunchdCollector(async (_file, [operation]) => {
    if (operation === 'print') {
      if (servicesFail) throw Object.assign(new Error('private'), { code: 'EPERM' })
      return 'services = {\n 42 ? local.running\n 0 - local.idle\n}\n'
    }
    if (disabledFail) throw Object.assign(new Error('private'), { killed: true })
    return 'disabled services = {\n "local.stopped" => true\n}\n'
  }, 501, () => `2026-11-04T12:00:0${second++}.000Z`)
  await reader.read('system')
  const successful = reader.get('system')
  servicesFail = true
  await reader.read('system')
  const partial = reader.get('system')
  assert.equal(partial.services.get('local.running')?.pid, 42, 'membership retains the last successful table')
  assert.equal(launchState(partial.services.get('local.running'), undefined, false, partial.loadedKnown, partial.disabledKnown), 'unknown')
  assert.equal(partial.source.lastSuccessAt, successful.source.lastSuccessAt)
  servicesFail = false; disabledFail = true
  await reader.read('system')
  const disabledUnknown = reader.get('system')
  assert.equal(launchState(disabledUnknown.services.get('local.running'), undefined, false, true, false), 'running')
  assert.equal(launchState(disabledUnknown.services.get('local.idle'), undefined, false, true, false), 'unknown')
  assert.equal(launchState(undefined, disabledUnknown.disabled.get('local.stopped'), false, false, false), 'unknown')
  assert.equal(disabledUnknown.source.diagnostics?.[0].operation, 'disabled')
  servicesFail = true
  await reader.read('system')
  assert.deepEqual(reader.get('system').source.diagnostics?.map(item => item.stage), ['permission', 'timeout'])
  servicesFail = false; disabledFail = false
  await reader.read('system')
  assert.equal(reader.get('system').source.state, 'ok')
  assert.deepEqual(reader.get('system').source.diagnostics, [])
  assert.equal(reader.get('system').source.lastSuccessAt, '2026-11-04T12:00:04.000Z')
  assert.equal(reader.get('system').source.lastSuccessAt, reader.get('system').source.lastAttemptAt)
})

test('launchd 过量、重复、越界行拒绝整表，不能伪造完整结果', () => {
  const services = (rows: string) => `services = {\n${rows}\n}\n`
  const rows = Array.from({ length: 8192 }, (_, index) => `0 - local.${index}`).join('\n')
  assert.equal(parseLaunchServices(services(rows)).size, 8192)
  assert.throws(() => parseLaunchServices(services(rows + '\n0 - local.excess')), { code: 'entry-limit' })
  assert.throws(() => parseLaunchServices(services('0 - local.same\n1 - local.same')), { code: 'invalid-row' })
  assert.throws(() => parseLaunchServices(services('999999999999999999999 - local.pid')), { code: 'invalid-row' })
  assert.throws(() => parseLaunchServices(services(`0 - ${'x'.repeat(1025)}`)), { code: 'invalid-row' })
  assert.throws(() => parseLaunchServices(' '.repeat(8 * 1024 * 1024 + 1)), { code: 'output-limit' })
  assert.throws(() => parseLaunchDisabled('disabled services = {\n "a" => true\n "a" => false\n}\n'), { code: 'invalid-row' })
})

test('单域重试只重读该域，保留配置和健康来源，恢复后重新合并运行时条目', { skip: process.platform !== 'darwin' }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-launchd-test-'))
  let collector: ScheduleCollector | undefined
  try {
    const directory = path.join(home, 'LaunchDaemons')
    await mkdir(directory)
    const file = path.join(directory, 'job.plist')
    await writeFile(file, '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>local.configured</string><key>StartInterval</key><integer>60</integer></dict></plist>')
    const calls: string[] = []
    let failed = false, newRuntime = false
    const run: LaunchCommand = async (executable, args, signal, input) => {
      calls.push(`${executable} ${args.join(' ')}`)
      if (executable === '/usr/bin/plutil') {
        assert.deepEqual(args, ['-convert', 'json', '-o', '-', '-'])
        assert.ok(input)
        const { promise, resolve, reject } = Promise.withResolvers<string>()
        let failure: Error | null = null
        let output = ''
        const child = execFile(executable, args, { timeout: 1000, maxBuffer: 65536, signal, killSignal: 'SIGKILL' }, (error, stdout) => {
          failure ??= error
          output = stdout
        })
        child.once('close', () => failure ? reject(failure) : resolve(output))
        child.stdin!.on('error', error => { failure ??= error; child.kill('SIGKILL') })
        child.stdin!.end(input)
        return promise
      }
      if (executable === '/usr/bin/crontab') return '0 8 * * * /bin/true\n'
      const [operation, domain] = args
      if (operation === 'print-disabled') return 'disabled services = {\n}\n'
      if (domain === 'system') {
        if (failed) throw Object.assign(new Error('private'), { code: 'EPERM' })
        return `services = {\n 77 ? local.configured\n 88 - local.${newRuntime ? 'replacement' : 'ephemeral'}\n}\n`
      }
      return domain.startsWith('gui/') ? 'services = {\n 99 - local.healthy\n}\n' : 'services = {\n}\n'
    }
    collector = new ScheduleCollector({ home, uid: 501, directories: [{ directory, scope: 'system' }], run })
    const initial = await collector.collect()
    const healthy = initial.jobs.find(job => job.id === 'launchd:user:local.healthy')!
    const cron = initial.jobs.find(job => job.id.startsWith('crontab:'))!
    assert.equal(initial.jobs.find(job => job.id === 'launchd:system:local.configured')?.state, 'running')
    await writeFile(file, 'broken private configuration')
    failed = true; calls.length = 0
    const partial = await collector.retry('launchctl:system')
    assert.deepEqual(calls.sort(), ['/bin/launchctl print system', '/bin/launchctl print-disabled system'].sort())
    const configured = partial.jobs.find(job => job.id === 'launchd:system:local.configured')!
    assert.equal(configured.state, 'unknown')
    assert.equal(configured.pid, undefined)
    assert.equal(configured.file, file)
    assert.equal(configured.kind, 'interval')
    assert.equal(partial.jobs.find(job => job.id === 'launchd:system:local.ephemeral')?.state, 'unknown')
    assert.deepEqual(partial.jobs.find(job => job.id === healthy.id), healthy)
    assert.equal(partial.jobs.find(job => job.id === cron.id), cron)
    assert.equal(partial.sources.find(source => source.id === 'launchctl:gui/501'), initial.sources.find(source => source.id === 'launchctl:gui/501'))
    failed = false; newRuntime = true
    const recovered = await collector.retry('launchctl:system')
    assert.equal(recovered.jobs.find(job => job.id === configured.id)?.state, 'running')
    assert.equal(recovered.jobs.some(job => job.id === 'launchd:system:local.ephemeral'), false)
    assert.equal(recovered.jobs.find(job => job.id === 'launchd:system:local.replacement')?.pid, 88)
    assert.deepEqual(recovered.sources.find(source => source.id === 'launchctl:system')?.diagnostics, [])
    await assert.rejects(collector.collect(), /调度配置采集不完整/)
    const afterConfigurationFailure = await collector.retry('launchctl:system')
    assert.equal(afterConfigurationFailure.jobs.find(job => job.id === configured.id)?.file, file)
    calls.length = 0
    await assert.rejects(collector.retry('launchctl:system/private'), /不支持/)
    assert.deepEqual(calls, [])
  } finally { collector?.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('共享命令槽耗尽时注入 plutil 排队取消不启动命令，释放后可以重用', async () => {
  let active = 0
  const { promise: held, resolve: release } = Promise.withResolvers<void>()
  const { promise: ready, resolve: admitted } = Promise.withResolvers<void>()
  const blockers = Array.from({ length: 8 }, () => collectionResources.run({
    source: 'schedule-test-blockers', kind: 'command', stdoutBytes: 1, stderrBytes: 1
  }, () => {
    if (++active === 8) admitted()
    return held
  }))
  let calls = 0
  const run: LaunchCommand = async () => { calls++; return '{}' }
  try {
    await ready
    const controller = new AbortController()
    const cancelled = assert.rejects(runLaunchCommand('/usr/bin/plutil', [], controller.signal, run),
      { name: 'AbortError', code: 'ABORT_ERR' })
    controller.abort()
    await cancelled
    assert.equal(calls, 0)
  } finally {
    release()
    await Promise.all(blockers)
  }
  assert.equal(await runLaunchCommand('/usr/bin/plutil', [], undefined, run), '{}')
  assert.equal(calls, 1)
})

interface ScheduleTestFixture {
  home: string
  user: string
  system: string
  collector: ScheduleCollector
  plutilCalls: number
  services: Record<string, string>
  cron: string
  onPlist?: (input: Buffer, signal?: AbortSignal) => Promise<void>
}

async function withScheduleFixture(work: (fixture: ScheduleTestFixture) => Promise<void>, signal?: AbortSignal) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oc-chan-schedule-bounds-'))
  let fixture: ScheduleTestFixture | undefined
  try {
    const user = path.join(home, 'user'), system = path.join(home, 'system')
    await Promise.all([user, system, path.join(home, '.omp/cron'), path.join(home, '.hermes/cron')].map(directory => mkdir(directory, { recursive: true })))
    const run: LaunchCommand = async (executable, args, currentSignal, input) => {
      assert.ok(fixture)
      if (executable === '/usr/bin/plutil') {
        assert.deepEqual(args, ['-convert', 'json', '-o', '-', '-'])
        assert.ok(input, '转换器必须接收已检查大小的文件内容，不再自行打开路径')
        assert.ok(input.byteLength <= 1024 * 1024)
        fixture.plutilCalls++
        await fixture.onPlist?.(input, currentSignal)
        return JSON.stringify(JSON.parse(input.toString('utf8')))
      }
      if (executable === '/usr/bin/crontab') return fixture.cron
      assert.equal(executable, '/bin/launchctl')
      const [operation, domain] = args
      if (operation === 'print-disabled') return 'disabled services = {\n}\n'
      assert.equal(operation, 'print')
      return `services = {\n${fixture.services[domain] ?? ''}\n}\n`
    }
    fixture = { home, user, system, collector: new ScheduleCollector({ home, uid: 501, signal, run,
      directories: [{ directory: user, scope: 'user' }, { directory: system, scope: 'system' }] }), plutilCalls: 0, services: {}, cron: '' }
    await work(fixture)
  } finally {
    fixture?.collector.dispose()
    await rm(home, { recursive: true, force: true })
  }
}

async function writeScheduleFiles(directory: string, start: number, end: number, extra: Record<string, unknown> = {}) {
  for (let offset = start; offset < end; offset += 32) {
    await Promise.all(Array.from({ length: Math.min(32, end - offset) }, (_, index) => {
      const id = offset + index
      return writeFile(path.join(directory, `${id}.plist`), JSON.stringify({ Label: `local.${id}`, StartInterval: 60, ...extra }))
    }))
  }
}

test('目录和缓存支持 0、1000、4096 项，未变文件不重复转换且上限有明确诊断', { skip: process.platform !== 'darwin' }, async () => {
  await withScheduleFixture(async fixture => {
    assert.equal((await fixture.collector.collect()).jobs.length, 0)
    for (const [start, end] of [[0, 1000], [1000, 4096]]) {
      await writeScheduleFiles(fixture.user, start, end)
      assert.equal((await fixture.collector.collect()).jobs.length, end)
      assert.equal(fixture.plutilCalls, end)
      const bounds = fixture.collector.diagnostics()
      assert.equal(bounds.cachedPlists, end)
      assert.equal(bounds.scanned, end)
      assert.equal(bounds.maxPlists, 4096)
      assert.equal(bounds.maxScanned, 4096)
      assert.equal(bounds.maxProjectionBytes, 8 * 1024 * 1024)
      assert.ok(bounds.cachedProjectionBytes > 0 && bounds.cachedProjectionBytes <= bounds.maxProjectionBytes)
      assert.equal((await fixture.collector.collect()).jobs.length, end)
      assert.equal(fixture.plutilCalls, end, '未变文件只读取身份信息，不启动 plutil')
    }
    await writeScheduleFiles(fixture.system, 4096, 4097)
    await assert.rejects(fixture.collector.collect(), /4096|collection limit|上限/i)
    assert.ok(fixture.collector.diagnostics().cachedPlists <= 4096)
  })
})

test('跨用户和系统目录合计计数包含过滤项，第 4097 个非 plist 也拒绝整轮', { skip: process.platform !== 'darwin' }, async () => {
  await withScheduleFixture(async fixture => {
    for (const directory of [fixture.user, fixture.system]) {
      for (let offset = 0; offset < 2048; offset += 32) {
        await Promise.all(Array.from({ length: 32 }, (_, index) => writeFile(path.join(directory, `${offset + index}.ignored`), '')))
      }
    }
    assert.equal((await fixture.collector.collect()).jobs.length, 0)
    assert.equal(fixture.collector.diagnostics().scanned, 4096)
    assert.equal(fixture.plutilCalls, 0)
    await writeFile(path.join(fixture.system, 'overflow.ignored'), '')
    await assert.rejects(fixture.collector.collect(), /4096|collection limit|上限/i)
    assert.equal(fixture.plutilCalls, 0)
  })
})

test('相同 size/mtime 替换 inode 会更新缓存，删除文件回收条目和投影额度', { skip: process.platform !== 'darwin' }, async () => {
  await withScheduleFixture(async fixture => {
    const file = path.join(fixture.user, 'job.plist'), replacement = path.join(fixture.home, 'replacement.plist')
    await writeFile(file, JSON.stringify({ Label: 'local.before', StartInterval: 60 }))
    const timestamp = new Date('2026-11-01T00:00:00.000Z')
    await utimes(file, timestamp, timestamp)
    const first = await fixture.collector.collect()
    const old = await stat(file)
    await writeFile(replacement, JSON.stringify({ Label: 'local.afterx', StartInterval: 60 }))
    await utimes(replacement, old.atime, old.mtime)
    await rename(replacement, file)
    const replaced = await stat(file)
    assert.equal(replaced.size, old.size)
    assert.equal(replaced.mtimeMs, old.mtimeMs)
    assert.notEqual(replaced.ino, old.ino)
    const updated = await fixture.collector.collect()
    assert.equal(fixture.plutilCalls, 2)
    assert.equal(first.jobs[0].name, 'local.before')
    assert.equal(updated.jobs[0].name, 'local.afterx')
    assert.equal(fixture.collector.diagnostics().cachedPlists, 1)
    await rm(file)
    assert.equal((await fixture.collector.collect()).jobs.length, 0)
    assert.equal(fixture.collector.diagnostics().cachedPlists, 0)
    assert.equal(fixture.collector.diagnostics().cachedProjectionBytes, 0)
  })
})

test('单 plist、UTF-8 字段、日历数量与投影额度超限均明确失败而非丢任务', { skip: process.platform !== 'darwin' }, async () => {
  await withScheduleFixture(async fixture => {
    const file = path.join(fixture.user, 'large.plist')
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 32))
    await assert.rejects(fixture.collector.collect(), /plist file bytes|1048576|上限/i)
    assert.equal(fixture.plutilCalls, 0)
    const cases = [
      { Program: '汉'.repeat(1366) },
      { StartCalendarInterval: Array.from({ length: 65 }, () => ({ Hour: 1 })) },
      { StartCalendarInterval: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`Unknown${index}`, 1])) },
      { StartCalendarInterval: Array.from({ length: 64 }, () => Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`ExtendedCalendarField${index}`, 1]))) },
    ]
    for (const extra of cases) {
      await writeFile(file, JSON.stringify({ Label: 'local.large', ...extra }))
      await assert.rejects(fixture.collector.collect(), /collection limit|上限|projection|calendar|field/i)
      assert.equal(fixture.collector.diagnostics().cachedPlists, 0)
    }
    const valid = { Label: 'local.boundary', Program: '汉'.repeat(1365) + 'a',
      StartCalendarInterval: Array.from({ length: 64 }, () => ({ Minute: 0 })) }
    assert.equal(Buffer.byteLength(valid.Program), 4096)
    await writeFile(file, JSON.stringify(valid))
    assert.equal((await fixture.collector.collect()).jobs.length, 1)
    const fields = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`Unknown${index}`, 1]))
    assert.ok(projectLaunchPlist({ Label: 'local.fields', StartCalendarInterval: fields }))
    assert.equal(Object.values(collectionResources.snapshot().global.current).every(value => value === 0), true)
  })
})

test('缓存字节按投影与键的额度限制，未到 4096 项也会明确拒绝', { skip: process.platform !== 'darwin' }, async () => {
  await withScheduleFixture(async fixture => {
    // A long directory component grows cached Program, while the exposed executable remains only "run".
    await writeScheduleFiles(fixture.user, 0, 2100, { Program: '/' + 'x'.repeat(4091) + '/run' })
    await assert.rejects(fixture.collector.collect(), /plist cache projection bytes|缓存.*上限/i)
    const bounds = fixture.collector.diagnostics()
    assert.ok(bounds.cachedPlists > 0 && bounds.cachedPlists < 2100)
    assert.ok(bounds.cachedProjectionBytes <= 8 * 1024 * 1024)
    fixture.collector.dispose()
    assert.equal(fixture.collector.diagnostics().cachedPlists, 0)
    assert.equal(fixture.collector.diagnostics().cachedProjectionBytes, 0)
    await assert.rejects(fixture.collector.collect(), /取消|stopped|disposed|停止/i)
  })
})

test('最终任务上限跨配置、三个 launchctl 域、OMP、Hermes 和 cron 合计执行', { skip: process.platform !== 'darwin' }, async () => {
  await withScheduleFixture(async fixture => {
    await writeScheduleFiles(fixture.user, 0, 1)
    for (const domain of ['gui/501', 'user/501', 'system']) {
      fixture.services[domain] = Array.from({ length: 1364 }, (_, index) => `0 - local.${domain.replace('/', '-')}.${index}`).join('\n')
    }
    await writeFile(path.join(fixture.home, '.omp/cron/jobs.json'), JSON.stringify({ jobs: [{ id: 'omp', enabled: false, schedule: { kind: 'interval', minutes: 1 } }] }))
    await writeFile(path.join(fixture.home, '.hermes/cron/jobs.json'), JSON.stringify({ jobs: [{ id: 'hermes', enabled: false, schedule: { kind: 'interval', minutes: 1 } }] }))
    fixture.cron = '0 8 * * * /bin/true\n'
    const snapshot = await fixture.collector.collect()
    assert.equal(snapshot.jobs.length, 4096)
    assert.equal(snapshot.jobs.filter(job => job.id.startsWith('hermes-job:')).length, 1)
    assert.equal(snapshot.jobs.filter(job => job.id.startsWith('crontab:')).length, 1)
    fixture.cron += '0 9 * * * /bin/true\n'
    await assert.rejects(fixture.collector.collect(), /jobs across all sources|4096|上限/i)
    assert.equal(snapshot.jobs.length, 4096, '失败不修改已发布快照')
  })
})

test('最终任务投影字节跨配置与运行域累计，条数未超限也不得发布超量快照', { skip: process.platform !== 'darwin' }, async () => {
  await withScheduleFixture(async fixture => {
    await writeScheduleFiles(fixture.user, 0, 1800, { Program: '/' + 'x'.repeat(4095) })
    for (const domain of ['gui/501', 'system']) {
      fixture.services[domain] = Array.from({ length: 1000 }, (_, index) => `0 - local.${domain.replace('/', '-')}.${index}.${'x'.repeat(100)}`).join('\n')
    }
    await assert.rejects(fixture.collector.collect(), /job projection bytes|任务.*上限/i)
    assert.equal(fixture.collector.diagnostics().cachedPlists, 1800)
    assert.ok(fixture.collector.diagnostics().cachedProjectionBytes <= 8 * 1024 * 1024)
  })
})

test('转换期间增长的配置明确失败，既有完整快照仍可用于来源重试', { skip: process.platform !== 'darwin' }, async () => {
  await withScheduleFixture(async fixture => {
    const file = path.join(fixture.user, 'job.plist')
    await writeFile(file, JSON.stringify({ Label: 'local.stable', StartInterval: 60 }))
    const first = await fixture.collector.collect()
    await writeFile(file, JSON.stringify({ Label: 'local.changing', StartInterval: 120 }))
    fixture.onPlist = async () => { await appendFile(file, ' ') }
    await assert.rejects(fixture.collector.collect(), /发生变化|changed/i)
    fixture.onPlist = undefined
    const retained = await fixture.collector.retry('launchctl:system')
    assert.equal(retained.jobs[0].name, first.jobs[0].name)
    assert.equal(first.jobs[0].name, 'local.stable')
    assert.equal(Object.values(collectionResources.snapshot().global.current).every(value => value === 0), true)
  })
})

test('dispose 在转换期间取消信号，晚到结果不得重新写入缓存或允许后续采样', { skip: process.platform !== 'darwin' }, async () => {
  await withScheduleFixture(async fixture => {
    await writeScheduleFiles(fixture.user, 0, 1)
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let observedSignal: AbortSignal | undefined
    fixture.onPlist = async (_input, signal) => { observedSignal = signal; started.resolve(); await release.promise }
    const work = fixture.collector.collect()
    const rejected = assert.rejects(work, /取消|stopped|disposed|停止/i)
    await started.promise
    try {
      fixture.collector.dispose()
      assert.equal(observedSignal?.aborted, true)
    } finally { release.resolve() }
    await rejected
    assert.equal(fixture.collector.diagnostics().cachedPlists, 0)
    assert.equal(fixture.collector.diagnostics().cachedProjectionBytes, 0)
    await assert.rejects(fixture.collector.collect(), /取消|stopped|disposed|停止/i)
    await assert.rejects(fixture.collector.retry('launchctl:system'), /取消|stopped|disposed|停止/i)
    assert.equal(Object.values(collectionResources.snapshot().global.current).every(value => value === 0), true)
  })
})

test('配置采集外部取消后共享命令、文件及字节额度全部归还', { skip: process.platform !== 'darwin' }, async () => {
  const controller = new AbortController()
  await withScheduleFixture(async fixture => {
    await writeScheduleFiles(fixture.user, 0, 1)
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    fixture.onPlist = async () => { started.resolve(); await release.promise }
    const work = fixture.collector.collect()
    const rejected = assert.rejects(work, /取消|AbortError|cancel/i)
    await started.promise
    controller.abort()
    release.resolve()
    await rejected
    assert.equal(Object.values(collectionResources.snapshot().global.current).every(value => value === 0), true)
  }, controller.signal)
})

test('单轮取消排空真实配置读取且下一轮可重用，预取消重试不得修改缓存', { skip: process.platform !== 'darwin' }, async () => {
  await withScheduleFixture(async fixture => {
    await writeScheduleFiles(fixture.user, 0, 1)
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const operation = new AbortController()
    let observed: AbortSignal | undefined
    fixture.onPlist = async (_input, signal) => { observed = signal; started.resolve(); await release.promise }
    const rejected = assert.rejects(fixture.collector.collect(operation.signal), /取消|AbortError|cancel/i)
    await started.promise
    operation.abort()
    assert.equal(observed?.aborted, true)
    release.resolve()
    await rejected
    assert.equal(Object.values(collectionResources.snapshot().global.current).every(value => value === 0), true)
    fixture.onPlist = undefined
    const snapshot = await fixture.collector.collect()
    assert.equal(snapshot.jobs.length, 1)
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(fixture.collector.retry('launchctl:system', cancelled.signal), { name: 'AbortError' })
    assert.equal((await fixture.collector.retry('launchctl:system')).jobs[0].name, snapshot.jobs[0].name)
  })
})
