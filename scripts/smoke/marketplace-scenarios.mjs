import assert from 'node:assert/strict'

const card = '[data-plugin-id="system"]'
const $ = selector => `document.querySelector(${JSON.stringify(selector)})`
const action = name => $(`${card} [data-plugin-action="${name}"]`)
const snapshot = 'window.pluginMarketplace.snapshot()'
const item = `${snapshot}.then(value => value.items.find(item => item.manifest.id === 'system'))`

async function ready(ui, version) {
  return ui.expect(`system plugin ${version} is active`, () => ui.evaluate(`Promise.all([${snapshot},window.monitor.snapshot()]).then(([market,monitor]) => {
    const item = market.items.find(item => item.manifest.id === 'system');
    if (market.operation) return false;
    if (market.error || item?.error) throw new Error(JSON.stringify({error:market.error,item}));
    return item?.installed && item.installedVersion === ${JSON.stringify(version)} && monitor.system.data && !monitor.system.error
      ? {item,system:{cpuCores:monitor.system.data.cpuCores,memoryTotal:monitor.system.data.memoryTotal,osVersion:monitor.system.data.osVersion}} : false;
  })`), 40000)
}
async function uninstall(ui) {
  await ui.click(action('uninstall'))
  await ui.click(action('confirm-uninstall'))
  await ui.expect('uninstalled plugin and snapshot are absent', () => ui.evaluate(`Promise.all([${snapshot},window.monitor.snapshot()]).then(([market,monitor]) =>
    !market.operation && !market.error && market.items.find(item => item.manifest.id === 'system')?.installed === false && monitor.system.data === null)`), 20000)
  const info = await ui.info()
  assert.equal(info.plugins.some(plugin => plugin.id === 'system'), false)
}

export async function exerciseMarketplace({ ui, main, renderer, feed, thorough = true }) {
  await ui.stage('marketplace-starts-uninstalled', async () => {
    await ui.dom('marketplace bridge is available', `!!window.pluginMarketplace && !!${$('.app-shell')}`)
    await ui.navigate('插件市场', 'Plugin marketplace')
    const current = await ui.evaluate(item)
    assert.equal(current.installed, false)
    assert.equal(current.installedVersion, null)
    assert.equal((await ui.evaluate('window.monitor.snapshot()')).system.data, null)
    await ui.dom('install action is visible', `!!${action('install')}`)
    return { installed: false, source: current.source }
  })
  await ui.stage('marketplace-install-lifecycle', async () => {
    for (let cycle = 0; cycle < (thorough ? 4 : 1); cycle++) {
      await ui.click(action('install'))
      const state = await ready(ui, '1.0.0')
      assert.ok(state.system.cpuCores > 0 && state.system.memoryTotal > 0)
      if (cycle < (thorough ? 3 : 0)) await uninstall(ui)
    }
    await ui.click(action('uninstall'))
    await ui.dom('uninstall confirmation receives focus', 'document.activeElement?.dataset.pluginAction === "confirm-uninstall"')
    await ui.click(action('cancel-uninstall'))
    assert.equal((await ui.evaluate(item)).installed, true)
    return { cycles: thorough ? 4 : 1, cancelledUninstallPreservedInstallation: true, metrics: 'real Rust macOS collector' }
  })
  await ui.stage('marketplace-disable-enable-drains-process', async () => {
    await ui.navigate('数据来源', 'Data sources')
    await ui.click($('[data-source-section="system"] [role="switch"]'))
    await ui.expect('disabled real system collector is drained', async () => {
      const info = await ui.info(), plugin = info.plugins.find(value => value.id === 'system')
      return plugin?.enabled === false && info.resources.global.current.pluginProcesses === 0
    }, 20000)
    assert.equal((await ui.evaluate(item)).installed, true)
    await ui.click($('[data-source-section="system"] [role="switch"]'))
    await ready(ui, '1.0.0')
    await ui.navigate('插件市场', 'Plugin marketplace')
    return { installedAcrossDisable: true, collectorProcessDrained: true, resumedVersion: '1.0.0' }
  })
  if (thorough) {
  assert(feed, 'Full marketplace acceptance requires real Rust fixture artifacts and a loopback feed')
  await ui.stage('marketplace-cancels-download', async () => {
    await feed.setMode('slow', main)
    await ui.click($('[data-marketplace-action="check"]'))
    await ui.expect('online update is available', () => ui.evaluate(`${item}.then(item => item.updateAvailable && item.manifest.version === '1.1.0')`), 15000)
    await ui.click(action('update'))
    await ui.expect('real package download has started', async () => feed.slowDownloads() > 0 && await ui.evaluate(`${snapshot}.then(value => value.operation?.phase === 'downloading')`))
    assert.equal((await ui.evaluate(item)).installedVersion, '1.0.0')
    assert.ok((await ui.evaluate('window.monitor.snapshot()')).system.data.memoryTotal > 0)
    assert.equal(await ui.evaluate('window.pluginMarketplace.uninstall("system").then(() => false, error => /busy/i.test(String(error)))'), true)
    await ui.click(action('cancel'))
    await ui.expect('cancelled download releases operation', () => ui.evaluate(`${snapshot}.then(value => !value.operation && !value.error)`))
    await ui.dom('successful cancellation leaves no failure alert', `!${$(`${card} .market-error`)}`)
    assert.equal((await ui.evaluate(item)).installedVersion, '1.0.0')
    await feed.setMode('updated', main)
    return { cancelled: true, previousVersionKeptRunning: true }
  })
  await ui.stage('marketplace-download-and-update', async () => {
    await ui.click($('[data-marketplace-action="check"]'))
    await ui.expect('online update is available', () => ui.evaluate(`${item}.then(item => item.updateAvailable && item.manifest.version === '1.1.0')`), 15000)
    await ui.click(action('update'))
    const state = await ready(ui, '1.1.0')
    assert.ok(state.system.cpuCores > 0 && state.system.memoryTotal > 0)
    return { version: state.item.installedVersion, realCollectorMetrics: state.system, requests: feed.requests() }
  })
  await ui.stage('marketplace-rejects-failed-activation', async () => {
    await feed.setMode('broken', main)
    await ui.click($('[data-marketplace-action="check"]'))
    await ui.expect('broken update is offered', () => ui.evaluate(`${item}.then(item => item.updateAvailable && item.manifest.version === '1.2.0')`))
    await ui.click(action('update'))
    await ui.expect('failed first collection is reported for this update', () => ui.evaluate(`${snapshot}.then(value => !value.operation && value.error?.id === 'system' && value.error.action === 'update' && value.error.message.startsWith('OC_PLUGIN_COLLECT:'))`), 40000)
    const state = await ui.evaluate('window.monitor.snapshot()')
    assert.equal(state.system.error, null)
    assert.ok(state.system.data.cpuCores > 0 && state.system.data.memoryTotal > 0)
    assert.equal((await ui.evaluate(item)).installedVersion, '1.1.0')
    return { failedVersion: '1.2.0', recoveredVersion: '1.1.0' }
  })
  await ui.stage('marketplace-rejects-tampered-package', async () => {
    await feed.setMode('tampered', main)
    await ui.click($('[data-marketplace-action="check"]'))
    await ui.expect('tampered update is offered', () => ui.evaluate(`${item}.then(item => item.manifest.version === '1.2.0')`))
    await ui.click(action('update'))
    await ui.expect('package integrity failure is shown', () => ui.evaluate(`${snapshot}.then(value => !value.operation && value.error?.id === 'system' && value.error.action === 'update' && value.error.message.startsWith('OC_PLUGIN_INTEGRITY:'))`), 20000)
    assert.equal((await ui.evaluate(item)).installedVersion, '1.1.0')
    assert.ok((await ui.evaluate('window.monitor.snapshot()')).system.data.memoryTotal > 0)
    return { rejectedVersion: '1.2.0', activeVersion: '1.1.0' }
  })
  await ui.stage('marketplace-responsive-layout', async () => {
    for (const [width, height] of [[880, 640], [1024, 768], [1280, 860], [1600, 1000]]) {
      await renderer.resize(width, height)
      await ui.frames()
      const overflow = await ui.evaluate('({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})')
      assert.ok(overflow.scroll <= overflow.client, `Marketplace overflows at ${width} x ${height}`)
    }
    for (const language of ['en', 'zh-CN']) {
      await ui.evaluate(`window.desktopSettings.update({language:${JSON.stringify(language)}})`)
      await renderer.resize(880, 640)
      await ui.evaluate('document.documentElement.style.setProperty("--font-scale","2")')
      await ui.frames()
      assert.equal(await ui.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `200% text overflow: ${language}`)
      await ui.click(action('uninstall'))
      await ui.dom('confirmation focused at 200% text', 'document.activeElement?.dataset.pluginAction === "confirm-uninstall"')
      await ui.key('Escape', 'Escape', 27)
      await ui.dom('Escape restores uninstall focus', 'document.activeElement?.dataset.pluginAction === "uninstall"')
      await ui.evaluate('document.documentElement.style.removeProperty("--font-scale")')
    }
    await renderer.resize(1280, 860)
    const native = await renderer.inspect()
    await ui.expect('restored real outer geometry is persisted before restart', () => ui.evaluate(`window.desktopSettings.snapshot().then(value => value.settings.windowBounds?.width === ${native.outerWidth} && value.settings.windowBounds?.height === ${native.outerHeight})`))
    return { cssViewports: ['880x640', '1024x768', '1280x860', '1600x1000'], textScale: 2, languages: ['en', 'zh-CN'], visibleNativeAcceptance: false }
  })
  }
  const settings = (await ui.evaluate('window.desktopSettings.snapshot()')).settings
  return { settings: { plugins: settings.plugins }, pluginVersion: thorough ? '1.1.0' : '1.0.0' }
}

export async function verifyMarketplaceRestart(ui) {
  await ui.stage('marketplace-restart-retains-installed-code', async () => {
    await ui.navigate('插件市场', 'Plugin marketplace')
    const state = await ready(ui, '1.1.0')
    assert.ok(state.system.cpuCores > 0 && state.system.memoryTotal > 0)
    return { version: state.item.installedVersion, executablePersistence: true, realCollectorMetrics: state.system }
  })
  await ui.stage('marketplace-final-uninstall', async () => {
    await uninstall(ui)
    return { pluginRemoved: true, snapshotCleared: true }
  })
}
