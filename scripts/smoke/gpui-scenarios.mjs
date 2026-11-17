import assert from 'node:assert/strict'
import { copyFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Only fixture feed configuration is seeded. All product mutations below are
// performed by native pointer/keyboard events against measured, rendered controls.
export async function exerciseGpui({ driver, instance, output, manifest, scenario = 'all', feed, record }) {
  const inspect = async () => { const state = await driver.request('inspect'); assert.notEqual(state.ui?.buttonsLimited, true, 'Native control inspection exceeded its declared budget'); return state }
  async function expect(name, predicate, timeout = 40000) {
    const deadline = Date.now() + timeout
    let last
    while (Date.now() < deadline) {
      last = await inspect()
      assert.equal(last.native.visible, false)
      assert.equal(last.native.key, false)
      assert.equal(last.native.appActive, false)
      assert.equal(last.native.activationPolicy, 2)
      if (await predicate(last.ui, last)) return last.ui
      await delay(80)
    }
    throw new Error(`${name}: deadline exceeded; page=${last?.ui?.page}; error=${last?.ui?.error}; selected=${last?.ui?.topology?.selected ?? 'none'}; pending=${JSON.stringify(last?.ui?.pending)}`)
  }
  async function capture(name) {
    const filename = `scenario-${name}.png`, owned = path.join(instance, filename)
    await driver.request('capture', { path: owned })
    await copyFile(owned, path.join(output, filename))
    return filename
  }
  async function stage(name, action) {
    record(name, { status: 'started' })
    try {
      const details = await action()
      record(name, { status: 'passed', ...details, screenshot: await capture(name) })
    } catch (error) {
      const failures = [error]
      record(name, { status: 'failed', error: error.stack })
      try { await writeFile(path.join(output, `scenario-${name}-failed.json`), JSON.stringify(await inspect(), null, 2) + '\n', { mode: 0o600 }) }
      catch (diagnostic) { failures.push(diagnostic); record(`${name}-diagnostics`, { error: String(diagnostic) }) }
      try { await capture(`${name}-failed`) }
      catch (diagnostic) { failures.push(diagnostic); record(`${name}-capture`, { error: String(diagnostic) }) }
      if (failures.length > 1) throw new AggregateError(failures, `${name}: failure evidence incomplete`)
      throw error
    }
  }
  async function mouse(point, kind) { await driver.request('mouse', { ...point, kind }) }
  async function clickPoint(point) {
    await mouse(point, 'move'); await mouse(point, 'down'); await mouse(point, 'up')
  }
  async function locate(id, group = 'buttons') {
    let reset = false
    const header = group === 'buttons' && ['pause', 'monitor_refresh', 'sidebar', 'confirm', 'cancel-confirm'].includes(id)
    // Scroll the real page and re-read painted bounds after each event.
    for (let attempt = 0; attempt < 70; attempt++) {
      const state = await inspect(), rect = state.ui[group]?.[id]
      if (rect && rect.width > 0 && rect.height > 0) {
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        if (point.x > 0 && point.x < state.native.width && point.y > (header ? 0 : 90) && point.y < state.native.height - 15) return point
      }
      const deltaY = !rect && !reset ? 2000 : rect && rect.y < 90 ? 400 : -400
      reset = true
      await driver.request('scroll', { x: state.native.width - 80, y: state.native.height / 2, deltaY })
      await delay(60)
    }
    throw new Error(`Rendered ${group}.${id} was not reachable by scrolling`)
  }
  async function click(id) { await clickPoint(await locate(id)) }
  async function navigate(page) {
    await driver.request('navigate', { page })
    await expect(`navigate ${page}`, ui => ui.page === page)
  }
  async function fill(id, text) {
    await clickPoint(await locate(id, 'inputs'))
    await driver.request('key', { key: 'a', modifiers: ['command'] })
    await driver.request('text', { text })
    await expect(`${id} draft receives native text`, ui => ui.drafts[id] === text)
  }
  const saved = ui => ui.settings.settings
  const center = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
  const inside = (rect, outer) => rect && outer && rect.width > 0 && rect.height > 0 && rect.x >= outer.x - 1 && rect.y >= outer.y - 1 && rect.x + rect.width <= outer.x + outer.width + 1 && rect.y + rect.height <= outer.y + outer.height + 1
  async function panelReady(id, close) {
    return expect(`visible settled detail for ${id}`, ui => ui.selection?.id === id && ui.focusedId === close && ui.panelProgress === 1 && !ui.panelAnimating && inside(ui.targets?.['detail-panel'], ui.targets?.workspace))
  }
  async function closeDetail(expectedFocus) {
    await driver.request('key', { key: 'escape' })
    return expect('Escape closes panel and restores actual focus', ui => !ui.selection && !ui.panelAnimating && !ui.targets?.['detail-panel'] && ui.focusedId === expectedFocus)
  }
  async function clickInPanel(id) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const ui = (await inspect()).ui, panel = ui.targets?.['detail-panel'], rect = ui.buttons[id]
      assert(panel, 'Detail panel must remain rendered')
      if (inside(rect, panel)) { await clickPoint(center(rect)); return }
      await driver.request('scroll', { ...center(panel), deltaY: rect && rect.y < panel.y + 60 ? 300 : -300 })
      await delay(60)
    }
    throw new Error(`Detail control ${id} did not become visible through native scrolling`)
  }
  const item = ui => ui.market?.items.find(value => value.manifest.id === 'system')
  const idle = ui => !ui.pending.includes('settings_update')
  const active = (ui, version) => !ui.market.operation && !ui.market.error && item(ui)?.installedVersion === version && item(ui).installed && !ui.monitor.system.error && ui.monitor.system.data?.cpuCores > 0 && ui.monitor.system.data.memoryTotal > 0
  await driver.request('resize', { width: 1280, height: 860 })
  await expect('settings and monitor loaded', ui => ui.settings && ui.monitor && ui.market)
  if (scenario === 'schedules') {
    await stage('schedule-configuration-details', async () => {
      const started = Date.now(), rssSamples = []
      const sampleRss = async () => {
        const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(driver.receipt.pid), '-o', 'rss='], { timeout: 2000, maxBuffer: 4096 })
        const kib = Number(stdout.trim())
        assert(Number.isFinite(kib) && kib > 0, 'Owned GPUI process memory must be observable')
        rssSamples.push(kib)
      }
      await sampleRss()
      await navigate('schedules')
      const ready = await expect('fixture tasks collected', ui => manifest.hermesJobIds.slice(0, 2).every(id => ui.monitor.schedules.data?.jobs.some(job => job.id === id)))
      const job = ready.monitor.schedules.data.jobs.find(job => job.id === manifest.hermesJobIds[0])
      assert(!JSON.stringify(ready.monitor).includes(JSON.stringify(manifest.taskDetail.prompt)), 'Task bodies must stay out of periodic snapshots')
      await fill('search', job.name)
      await click(`job-${job.id}`)
      await panelReady(job.id, 'job-close')
      const loaded = await expect('task configuration and execution history load independently', ui => ui.scheduleDetail?.jobId === job.id && ui.historyLoaded && !ui.pending.includes('monitor_schedule_detail') && !ui.requests.monitor_schedule_detail.error)
      const fields = Object.fromEntries(loaded.scheduleDetail.fields.map(field => [field.key, field.value]))
      assert.equal(fields.prompt, manifest.taskDetail.prompt)
      assert.equal(fields.workdir, manifest.taskDetail.workdir)
      assert.equal(fields.model, manifest.taskDetail.model)
      const captures = []
      for (const [width, height] of [[1280, 860], [880, 640]]) {
        await driver.request('resize', { width, height })
        await panelReady(job.id, 'job-close')
        const state = await expect('prompt is rendered within panel width', ui => {
          const field = ui.targets['schedule-field-prompt'], panel = ui.targets['detail-panel']
          return field && panel && field.width > 0 && field.height > 40 && field.x >= panel.x && field.x + field.width <= panel.x + panel.width + 1
        })
        const panel = state.targets['detail-panel'], prompt = state.targets['schedule-field-prompt']
        await driver.request('scroll', { ...center(panel), deltaY: panel.y + 80 - prompt.y })
        captures.push(await capture(`schedule-prompt-${width}`))
      }
      const generation = loaded.requests.monitor_schedule_detail.generation
      await clickInPanel('schedule-detail-refresh')
      await expect('configuration refresh completes', ui => ui.requests.monitor_schedule_detail.generation > generation && !ui.pending.includes('monitor_schedule_detail') && !ui.requests.monitor_schedule_detail.error && ui.scheduleDetail?.jobId === job.id)
      await clickInPanel('history-refresh')
      await expect('history refresh retains configuration', ui => !ui.pending.includes('monitor_schedule_history') && ui.scheduleDetail?.jobId === job.id)
      await driver.request('key', { key: 'escape' })
      await expect('closing releases configuration', ui => !ui.selection && !ui.scheduleDetail && !ui.pending.includes('monitor_schedule_detail'))
      await driver.request('resize', { width: 1280, height: 860 })
      const other = ready.monitor.schedules.data.jobs.find(job => job.id === manifest.hermesJobIds[1])
      await fill('search', other.name)
      await click(`job-${other.id}`)
      const changed = await expect('switching task loads its own configuration', ui => ui.scheduleDetail?.jobId === other.id)
      assert(!changed.scheduleDetail.fields.some(field => field.value === manifest.taskDetail.prompt), 'Previous task body must not leak into another task')
      await navigate('overview')
      await expect('leaving releases configuration', ui => !ui.scheduleDetail && !ui.pending.includes('monitor_schedule_detail'))
      for (let iteration = 0; iteration < 8; iteration++) {
        await navigate('schedules')
        await expect('return reloads selected task', ui => ui.scheduleDetail?.jobId === other.id)
        await sampleRss()
        await navigate('overview')
        await expect('repeat leave releases configuration', ui => !ui.scheduleDetail && !ui.pending.includes('monitor_schedule_detail'))
      }
      return { taskId: job.id, widths: [1280, 880], captures, independentHistory: true, releasedOnCloseAndLeave: true, reopenCycles: 8, durationMs: Date.now() - started, hostRssSamplesKiB: rssSamples, sampledPeakHostRssKiB: Math.max(...rssSamples) }
    })
    return {}
  }

  await stage('refresh-pause-resume', async () => {
    await navigate('overview')
    const generation = (await inspect()).ui.requests?.monitor_refresh?.generation ?? 0
    await click('monitor_refresh')
    await expect('refresh is dispatched and completes', ui => ui.requests.monitor_refresh?.generation > generation && !ui.pending.includes('monitor_refresh') && !ui.requests.monitor_refresh.error)
    await click('pause')
    const paused = await expect('display pauses', ui => ui.paused)
    const frozen = structuredClone(paused.monitor)
    await delay(300)
    assert.deepEqual((await inspect()).ui.monitor, frozen, 'Paused display must retain its snapshot')
    await click('pause')
    await expect('display resumes', ui => !ui.paused)
    return { nativeClicks: 3, snapshotFrozen: true }
  })

  await stage('marketplace-offline-install', async () => {
    await navigate('plugins')
    const before = (await inspect()).ui
    assert.equal(item(before).installed, false, 'Owned fixture must begin without installed plugins')
    assert.equal(before.monitor.system.data, null)
    const requests = feed?.requests()
    await click('install-system'); await click('confirm')
    const ready = await expect('bundled system collector samples real machine', ui => active(ui, '1.0.0'))
    if (feed) assert.equal(feed.requests(), requests, 'Bundled install must not use loopback HTTP')
    await click('uninstall-system'); await click('cancel-confirm')
    assert.equal(item((await inspect()).ui).installed, true)
    return { version: '1.0.0', cpuCores: ready.monitor.system.data.cpuCores, memoryTotal: ready.monitor.system.data.memoryTotal, cancelledUninstall: true }
  })

  if (feed) {
    const seed = { host: (command, args) => driver.request(command, args) }
    async function check(mode, version) {
      await feed.setMode(mode, seed)
      await click('marketplace_check')
      await expect(`${mode} catalog offers ${version}`, ui => !ui.market.checking && !ui.pending.includes('marketplace_check') && item(ui)?.manifest.version === version && item(ui).updateAvailable)
    }
    await stage('marketplace-cancel-download', async () => {
      await check('slow', '1.1.0')
      await click('update-system'); await click('confirm')
      await expect('real HTTP download starts', ui => feed.slowDownloads() > 0 && ui.market.operation?.phase === 'downloading')
      assert.equal(item((await inspect()).ui).installedVersion, '1.0.0')
      await click('marketplace_cancel')
      await expect('cancel preserves active package', ui => active(ui, '1.0.0'))
      await expect('HTTP transfer is cancelled', () => feed.evidence().cancelled > 0)
      return feed.evidence()
    })
    await stage('marketplace-update', async () => {
      await check('updated', '1.1.0')
      await click('update-system'); await click('confirm')
      await expect('updated real collector is active', ui => active(ui, '1.1.0'))
      return { version: '1.1.0', requests: feed.requests() }
    })
    for (const [mode, code] of [['broken', 'OC_PLUGIN_COLLECT:'], ['tampered', 'OC_PLUGIN_INTEGRITY:']]) {
      await stage(`marketplace-${mode}-rollback`, async () => {
        await check(mode, '1.2.0')
        await click('update-system'); await click('confirm')
        const state = await expect(`${mode} rejection leaves previous collector running`, ui => !ui.market.operation && ui.market.error?.id === 'system' && ui.market.error.action === 'update' && ui.market.error.message.startsWith(code) && item(ui).installedVersion === '1.1.0' && !ui.monitor.system.error && ui.monitor.system.data?.memoryTotal > 0)
        if (mode === 'tampered') assert(feed.evidence().tampered > 0)
        return { rejectedVersion: '1.2.0', activeVersion: '1.1.0', error: state.market.error, feed: feed.evidence() }
      })
    }
  } else {
    assert(!['all', 'marketplace'].includes(scenario), 'Full marketplace scenario requires a loopback fixture feed')
    record('marketplace-online', { status: 'not-requested', reason: `scenario=${scenario}; no feed supplied` })
  }

  if (['all', 'topology', 'collectors'].includes(scenario)) {
    await stage('fixture-collectors', async () => {
      assert(manifest?.agentIds?.length, 'Real owned agent fixtures are required')
      const state = await expect('all owned fixture agents collected', ui => manifest.agentIds.every(id => ui.monitor.agents.data?.agents.some(agent => agent.id === id)), 60000)
      assert.equal(state.monitor.agents.error, null)
      assert.equal(state.monitor.agents.data.activeSubagentCount, null)
      assert.equal(state.monitor.schedules.error, null)
      const jobs = state.monitor.schedules.data.jobs
      for (const id of manifest.hermesJobIds) assert(jobs.some(job => job.id === id), `Missing fixture job ${id}`)
      return { agents: manifest.agentIds, hermesJobs: manifest.hermesJobIds }
    })
    if (['all', 'topology'].includes(scenario)) {
      await stage('fixture-topology-documentation', async () => {
        await navigate('agents'); await fill('search', manifest.fixtureModel)
        const state = await expect('only owned fixture topology is rendered', ui => ui.drafts.search === manifest.fixtureModel && ui.topology?.nodes.length > 0 && ui.topology.nodes.every(node => manifest.agentIds.includes(node.id)))
        assert.equal(state.topology.flat, false, 'Documentation capture requires the default 3D view')
        const ys = state.topology.nodes.map(node => node.y)
        assert(Math.max(...ys) - Math.min(...ys) >= 80, 'Filtering to one project must refit the 3D camera instead of leaving a tiny distant building')
        const screenshot = await capture('README-fixture-3d')
        const mode = state.topology.buttons.mode; assert(mode, '2D mode control must be painted')
        await clickPoint(center(mode))
        const flat = await expect('only fixture nodes in 2D', ui => ui.topology.flat && ui.topology.nodes.length > 0 && ui.topology.nodes.every(node => manifest.agentIds.includes(node.id)))
        const flatScreenshot = await capture('README-fixture-2d')
        await clickPoint(center(flat.topology.buttons.mode)); await expect('return to 3D', ui => !ui.topology.flat)
        await fill('search', '')
        return { screenshot, flatScreenshot, fixtureOnly: true }
      })
    }
    let sourceJob, initialSourceBounds
    await stage('schedule-first-screen-detail', async () => {
      await navigate('schedules')
      const initial = await inspect()
      assert(initial.ui.monitor.schedules.data.jobs.length >= 2000, 'Large schedule fixture must remain loaded')
      assert.equal(initial.ui.pageScrollY, 0, 'First job must be clicked from the initial viewport')
      const viewport = { x: 0, y: 90, width: initial.native.width, height: initial.native.height - 105 }
      const entry = Object.entries(initial.ui.buttons).filter(([id, rect]) => id.startsWith('job-') && initial.ui.monitor.schedules.data.jobs.some(job => id === `job-${job.id}`) && inside(rect, viewport)).sort((a, b) => a[1].y - b[1].y)[0]
      assert(entry, 'A real task row must be visible without scrolling the large list')
      const firstId = entry[0].slice(4)
      await clickPoint(center(entry[1]))
      await panelReady(firstId, 'job-close')
      const firstScreenshot = await capture('schedule-first-screen-panel-open')
      await closeDetail(entry[0])
      // The owned Hermes fixture supplies many real database history rows.
      sourceJob = initial.ui.monitor.schedules.data.jobs.find(job => job.id === manifest.hermesJobIds[0])
      assert(sourceJob, 'Owned Hermes history task is required')
      await fill('search', sourceJob.name)
      await click(`job-${sourceJob.id}`)
      const opened = await panelReady(sourceJob.id, 'job-close')
      await expect('Hermes history request finishes', ui => ui.requests.monitor_schedule_history?.generation > 0 && !ui.pending.includes('monitor_schedule_history') && !ui.requests.monitor_schedule_history.error)
      await driver.request('scroll', { ...center(opened.targets['detail-panel']), deltaY: -500 })
      const scrolled = await expect('detail scroll is independent of the schedule list', ui => ui.detailScrollY < opened.detailScrollY && ui.pageScrollY === opened.pageScrollY)
      const detailScreenshot = await capture('schedule-detail-independent-scroll')
      const row = scrolled.buttons[`job-${sourceJob.id}`]
      await closeDetail(inside(row, viewport) ? `job-${sourceJob.id}` : 'search')
      return { firstId, totalJobs: initial.ui.monitor.schedules.data.jobs.length, historyJob: sourceJob.id, pageScrollY: scrolled.pageScrollY, detailScrollY: scrolled.detailScrollY, firstScreenshot, detailScreenshot }
    })
    await stage('schedule-source-focus-refresh', async () => {
      // Measure the destination before requesting the jump: highlight alone cannot pass.
      await navigate('sources')
      const initial = await inspect(), sourceKey = 'source-schedules-hermes-runtime'
      assert.equal(initial.ui.pageScrollY, 0)
      initialSourceBounds = initial.ui.targets[sourceKey]
      assert(initialSourceBounds, 'Schedule source must have measured rendered bounds')
      assert(initialSourceBounds.y >= initial.native.height, 'Fixture source must start below the viewport')
      await navigate('schedules')
      await fill('search', sourceJob.name)
      await click(`job-${sourceJob.id}`)
      await panelReady(sourceJob.id, 'job-close')
      await clickInPanel('job-source-hermes-runtime')
      const jumped = await expect('source row scrolls into view and receives actual focus', (ui, state) => {
        const rect = ui.targets[sourceKey], workspace = ui.targets.workspace
        return ui.page === 'sources' && ui.selection?.id === 'hermes-runtime' && ui.focusedId === sourceKey && ui.sourceJumpPending === false && rect && rect.width > 0 && rect.height > 0 && rect.x >= workspace.x - 1 && rect.x + rect.width <= state.native.width + 1 && rect.y >= workspace.y - 1 && rect.y < state.native.height - 60
      })
      const jumpScreenshot = await capture('schedule-source-jump-focused')
      const workspace = jumped.targets.workspace
      await driver.request('scroll', { ...center(workspace), deltaY: -180 })
      const moved = await expect('manual source scrolling moves away from jump offset', ui => ui.pageScrollY !== jumped.pageScrollY)
      const generation = moved.requests.monitor_refresh?.generation ?? 0
      await click('monitor_refresh')
      const refreshed = await expect('explicit refresh preserves manual source scroll', ui => ui.requests.monitor_refresh?.generation > generation && !ui.pending.includes('monitor_refresh') && !ui.requests.monitor_refresh.error && ui.sourceJumpPending === false)
      assert.equal(refreshed.pageScrollY, moved.pageScrollY, 'Global refresh must not repeat the source jump')
      return { source: sourceKey, initialSourceBounds, jumpScrollY: jumped.pageScrollY, refreshedScrollY: refreshed.pageScrollY, jumpScreenshot }
    })
  }
  if (['all', 'topology'].includes(scenario)) {
    await stage('agent-detail-focus-return', async () => {
      await navigate('agents')
      const ready = await expect('owned topology node is rendered', ui => ui.topology?.nodes.some(node => manifest.agentIds.includes(node.id)))
      const node = ready.topology.nodes.find(node => manifest.agentIds.includes(node.id))
      await clickPoint({ x: node.x, y: node.y })
      const opened = await panelReady(node.id, 'close-agent')
      assert.equal(opened.topology.selected, node.id)
      const panelScreenshot = await capture('agent-detail-panel-focused')
      await driver.request('resize', { width: 880, height: 640 })
      await panelReady(node.id, 'close-agent')
      const narrowScreenshot = await capture('agent-detail-narrow-viewport')
      await driver.request('resize', { width: 1280, height: 860 })
      await panelReady(node.id, 'close-agent')
      await closeDetail('topology')
      return { selected: node.id, panelScreenshot, narrowScreenshot, restoredFocus: 'topology' }
    })
    await stage('topology-select-mode-drag', async () => {
      await navigate('agents')
      const state = await expect('fixture nodes are painted', ui => ui.topology?.nodes.some(node => manifest.agentIds.includes(node.id)))
      const node = state.topology.nodes.find(node => manifest.agentIds.includes(node.id))
      await clickPoint({ x: node.x, y: node.y })
      await expect('exact real fixture node selected', ui => ui.topology.selected === node.id && ui.selection?.id === node.id)
      if (!state.topology.flat) {
        const bounds = (await inspect()).ui.topology.buttons.mode
        await clickPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
      }
      // The non-modal inspector covers the right canvas edge; never click through it.
      await closeDetail('topology')
      const flat = await expect('2D preserves selected fixture', ui => ui.topology.flat && ui.topology.selected === node.id && ui.topology.nodes.some(value => value.id === node.id))
      const target = flat.topology.nodes.find(value => value.id === node.id)
      const before = structuredClone(flat.topology.seats)
      await mouse({ x: target.x, y: target.y }, 'move')
      await mouse({ x: target.x, y: target.y }, 'down')
      for (let step = 1; step <= 8; step++) await mouse({ x: target.x + step * 5, y: target.y + step * 3 }, 'move')
      await mouse({ x: target.x + 40, y: target.y + 24 }, 'up')
      const moved = await expect('2D drag changes node layout', ui => JSON.stringify(ui.topology.seats) !== JSON.stringify(before))
      assert.equal(moved.topology.selected, node.id)
      await navigate('overview'); await navigate('agents')
      await expect('navigation preserves 2D layout and selection', ui => ui.topology.flat && ui.topology.selected === node.id && JSON.stringify(ui.topology.seats) === JSON.stringify(moved.topology.seats))
      return { selected: node.id, mode: '2d', drag: { dx: 40, dy: 24 }, layoutPreserved: true }
    })
  }

  await stage('settings-language-theme-drafts', async () => {
    await navigate('settings')
    await click('setting-language-2')
    await expect('English saved and resolved', ui => idle(ui) && saved(ui).language === 'en' && ui.language === 'en')
    await click('setting-language-1')
    await expect('Chinese saved and resolved', ui => idle(ui) && saved(ui).language === 'zh-CN' && ui.language === 'zh-CN')
    await click('setting-appearance-2')
    await expect('dark appearance saved', ui => idle(ui) && saved(ui).appearance === 'dark' && ui.theme === 'dark')
    await click('setting-darkTheme-2')
    await expect('Nord theme saved', ui => idle(ui) && saved(ui).darkTheme === 'nord')
    await fill('quietStart', '21:17'); await fill('quietEnd', '07:43')
    const original = structuredClone(saved((await inspect()).ui).notifications.quiet)
    const wasEnabled = saved((await inspect()).ui).notifications.enabled
    await click('notification-toggle')
    await expect('unrelated notification save preserves unsaved quiet draft', ui => idle(ui) && saved(ui).notifications.enabled === !wasEnabled && ui.drafts.quietStart === '21:17' && ui.drafts.quietEnd === '07:43')
    assert.deepEqual(saved((await inspect()).ui).notifications.quiet, original)
    await click('quiet-save')
    await expect('quiet draft is persisted', ui => idle(ui) && saved(ui).notifications.quiet.startMinute === 1277 && saved(ui).notifications.quiet.endMinute === 463)
    await fill('glass', '37')
    await click('save-glass')
    await expect('integer glass intensity saved', ui => idle(ui) && saved(ui).glassIntensity === 37)
    return { language: 'zh-CN', appearance: 'dark', darkTheme: 'nord', glassIntensity: 37, quietStart: 1277, quietEnd: 463 }
  })

  await stage('marketplace-final-uninstall', async () => {
    await navigate('plugins')
    await click('uninstall-system'); await click('confirm')
    await expect('uninstall removes package and real system snapshot', ui => !ui.market.operation && !ui.market.error && !item(ui).installed && item(ui).installedVersion === null && ui.monitor.system.data === null)
    return { installed: false, systemSnapshotCleared: true }
  })
  const settings = saved((await inspect()).ui)
  const expectedSettings = Object.fromEntries(['language', 'appearance', 'darkTheme', 'glassIntensity', 'notifications', 'plugins'].map(key => [key, structuredClone(settings[key])]))
  record('settings-restart-expectation', { expectedSettings })
  return expectedSettings
}
