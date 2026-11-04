import assert from 'node:assert/strict'
import test from 'node:test'
import type { ScheduledJob, SourceStatus } from '../../shared/types'
import { describeCalendar, describeCron, describeLaunchSchedule, launchState, mergeOmpMetadata,
  parseCrontab, parseLaunchDisabled, parseLaunchServices, projectLaunchPlist, assembleScheduleSnapshot, launchOrigin } from './schedules'

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
