import assert from 'node:assert/strict'
import { withSettingsWriteDenied } from './notification-scenarios.mjs'

const shell = 'document.querySelector(".app-shell")'
const toggle = 'document.querySelector(".sidebar-toggle")'
const handle = 'document.querySelector(".sidebar-resize-handle")'

async function assertReachable(ui, selector) {
  const geometry = await ui.evaluate(`(() => {
    const element = ${selector};
    element.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { width:r.width, height:r.height, left:r.left, right:r.right, top:r.top, bottom:r.bottom,
      viewportWidth:innerWidth, viewportHeight:innerHeight, reachable:element === hit || element.contains(hit) };
  })()`)
  assert.ok(geometry.width > 0 && geometry.height > 0 && geometry.left >= 0 && geometry.top >= 0
    && geometry.right <= geometry.viewportWidth && geometry.bottom <= geometry.viewportHeight && geometry.reachable,
  `Navigation must be visible and hit-testable: ${selector}, ${JSON.stringify(geometry)}`)
  return geometry
}

async function assertTitlebarLogo(ui, geometry) {
  await ui.dom('titlebar vector loaded', 'document.querySelector(".titlebar-logo")?.complete && document.querySelector(".titlebar-logo").naturalWidth > 0')
  const bounds = await ui.evaluate(`(() => {
    const rect = element => { const r = element.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,center:r.top+r.height/2}; };
    const brand = document.querySelector('.titlebar-brand');
    const button = document.querySelector('.sidebar-toggle');
    return {brand:rect(brand),logo:rect(brand.querySelector('img')),wordmark:rect(brand.querySelector('span')),
      toggle:button ? rect(button) : null,viewportWidth:innerWidth};
  })()`)
  assert.equal(bounds.logo.width, 14, 'Logo retains its compact width')
  assert.equal(bounds.logo.height, 14, 'Logo retains its compact height')
  assert.ok(Math.abs(bounds.wordmark.left - bounds.logo.right - 4) <= 0.5, 'Logo precedes the wordmark with a 4px gap')
  assert.ok(bounds.logo.left >= bounds.brand.left && bounds.wordmark.right <= bounds.brand.right
    && bounds.brand.right <= bounds.viewportWidth, 'Logo and wordmark fit within the visible brand')
  if (bounds.toggle) assert.ok(bounds.logo.left >= bounds.toggle.right + 4, 'Logo follows the sidebar toggle')
  for (const part of ['brand', 'logo', 'wordmark']) {
    const center = geometry.obscuredContentInsets.top + bounds[part].center * geometry.pageZoom
    for (const name of ['close', 'minimize', 'zoom']) {
      const delta = center - geometry.windowButtons[name].centerYFromWebview
      assert.ok(Number.isFinite(delta) && Math.abs(delta) <= 0.5, `${part} aligns with native ${name}: delta=${delta}`)
    }
  }
  return bounds
}

export async function exerciseSidebar({ ui, renderer }) {
  await ui.stage('sidebar-native-traffic-light-alignment', async () => {
    await renderer.resize(1280, 860)
    assert.equal((await ui.evaluate('window.desktopSettings.update({sidebarWidth:188})')).ok, true)
    const measurements = []
    for (const textSize of ['small', 'default', 'large']) {
      for (const sidebarCollapsed of [false, true]) {
        assert.equal((await ui.evaluate(`window.desktopSettings.update(${JSON.stringify({ textSize, sidebarCollapsed })})`)).ok, true)
        await ui.dom('alignment layout applied', `${shell}?.dataset.sidebarCollapsed === ${JSON.stringify(String(sidebarCollapsed))}`)
        await ui.frames()
        const center = await ui.evaluate(`(() => { const r = ${toggle}.getBoundingClientRect(); return r.y + r.height / 2; })()`)
        const geometry = (await renderer.inspect()).geometry
        const delta = geometry.obscuredContentInsets.top + center * geometry.pageZoom - geometry.windowButtons.close.centerYFromWebview
        assert.ok(Number.isFinite(delta) && Math.abs(delta) <= 0.5, `Sidebar toggle must align with native traffic lights: ${textSize}, collapsed=${sidebarCollapsed}, delta=${delta}`)
        const logoBounds = await assertTitlebarLogo(ui, geometry)
        const brand = await ui.evaluate(`(() => {
          const r = document.querySelector('.titlebar-brand').getBoundingClientRect();
          const button = ${toggle}.getBoundingClientRect();
          const entry = document.querySelector(${JSON.stringify(sidebarCollapsed ? '.topbar-tabs button' : '.sidebar nav button')});
          const navigation = entry.getBoundingClientRect();
          const drag = document.querySelector('.window-drag').getBoundingClientRect();
          const breadcrumb = document.querySelector('.breadcrumb')?.getBoundingClientRect();
          const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
          return {x:r.x,y:r.y,width:r.width,height:r.height,center:r.y+r.height/2,sidebarWidth:sidebar.width,
            afterToggle:r.left >= button.right + 4, navigationClear:${sidebarCollapsed}
              ? navigation.left >= r.right + 8 : navigation.top >= drag.bottom && navigation.top <= drag.bottom + 8,
            workspaceClear:!breadcrumb || breadcrumb.left >= r.right + 8};
        })()`)
        const brandDelta = geometry.obscuredContentInsets.top + brand.center * geometry.pageZoom - geometry.windowButtons.close.centerYFromWebview
        assert.ok(Math.abs(brandDelta) <= 0.5 && brand.afterToggle && brand.navigationClear && brand.workspaceClear, `Brand alignment and navigation clearance: ${JSON.stringify(brand)}`)
        const previous = measurements.at(-1)
        if (sidebarCollapsed) assert.deepEqual({x:brand.x,y:brand.y,width:brand.width,height:brand.height}, previous.brandBounds)
        if (!sidebarCollapsed) {
          assert.equal(brand.sidebarWidth, 188, 'Brand clears workspace content at minimum sidebar width')
          await assertReachable(ui, 'document.querySelector(".sidebar nav button")')
          const settings = await assertReachable(ui, 'document.querySelector(".sidebar-bottom button:last-child")')
          assert.ok(settings.viewportHeight - settings.bottom <= 16, 'Settings stays at the bottom without a device block below it')
        }
        measurements.push({ textSize, sidebarCollapsed, delta, brandDelta, logoBounds, brandBounds:{x:brand.x,y:brand.y,width:brand.width,height:brand.height} })
      }
    }
    assert.equal((await ui.evaluate('window.desktopSettings.update({textSize:"default",sidebarCollapsed:false})')).ok, true)
    return { measurements, tolerancePoints: 0.5 }
  })
  await ui.stage('sidebar-navigation-and-persistence', async () => {
    await renderer.resize(1280, 860)
    assert.equal((await ui.evaluate('window.desktopSettings.update({sidebarCollapsed:false,sidebarWidth:260})')).ok, true)
    await ui.dom('expanded sidebar ready', `${shell}?.dataset.sidebarCollapsed === 'false' && ${handle}?.getAttribute('aria-valuenow') === '260'`)
    const before = await ui.evaluate(`(() => { const r=${toggle}.getBoundingClientRect(); return {x:r.x,y:r.y}; })()`)
    await ui.click(toggle)
    await ui.dom('sidebar collapsed', `${shell}?.dataset.sidebarCollapsed === 'true'`)
    await ui.expect('collapsed preference persisted', async () => (await ui.evaluate('window.desktopSettings.snapshot()')).settings.sidebarCollapsed === true)
    assert.deepEqual(await ui.evaluate(`(() => { const r=${toggle}.getBoundingClientRect(); return {x:r.x,y:r.y}; })()`), before)
    const labels = await ui.evaluate('Array.from(document.querySelectorAll(".topbar-tabs button"), b => b.getAttribute("aria-label"))')
    assert(labels.length >= 5 && labels.every(Boolean), 'Core and installed plugin tabs retain accessible names')
    assert.equal(labels.filter(label => ['插件', 'Plugins'].includes(label)).length, 1, 'Topbar exposes one Plugins management entry')
    assert.equal(labels.some(label => ['插件市场', 'Plugin marketplace'].includes(label)), false, 'Topbar has no duplicate marketplace entry')
    assert.equal(labels.some(label => ['系统监控', 'System monitor'].includes(label)), true, 'Installed system monitoring remains accessible')
    // Native input exercises every actual tab, including installed system monitoring.
    for (let index = 0; index < labels.length; index++) {
      await ui.click(`document.querySelectorAll('.topbar-tabs button')[${index}]`)
      await ui.dom('topbar navigation selects its page', `document.querySelectorAll('.topbar-tabs button')[${index}]?.getAttribute('aria-current') === 'page'`)
    }
    for (let index = 0; index < 2; index++) {
      await ui.click(`document.querySelectorAll('.topbar-icon')[${index}]`)
      await ui.dom('right-side destination opens', `document.querySelectorAll('.topbar-icon')[${index}]?.getAttribute('aria-current') === 'page'`)
    }
    // Synchronous clicks deliberately overlap the single-flight settings queue.
    await ui.evaluate(`(() => { for(let i=0;i<7;i++) ${toggle}.click(); return true; })()`)
    await ui.expect('latest rapid toggle wins', async () => (await ui.evaluate('window.desktopSettings.snapshot()')).settings.sidebarCollapsed === false)
    await ui.dom('latest rapid layout agrees', `${shell}.dataset.sidebarCollapsed === 'false'`)
    await ui.evaluate(`(() => { window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyS',key:'s',metaKey:true,ctrlKey:true,bubbles:true})); return true; })()`)
    await ui.dom('shortcut toggles layout', `${shell}.dataset.sidebarCollapsed === 'true'`)
    await ui.click(toggle)
    await ui.dom('reverse click is immediately available', `${shell}.dataset.sidebarCollapsed === 'false'`)
    await ui.expect('expanded preference settles', async () => (await ui.evaluate('window.desktopSettings.snapshot()')).settings.sidebarCollapsed === false)
    return { nativeClicks: true, rapidClicksAndShortcut: 'DOM events through React; not native shortcut acceptance' }
  })
  await ui.stage('sidebar-drag-threshold', async () => {
    const point = await ui.evaluate(`(() => { const r=${handle}.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+100}; })()`)
    await renderer.mouse('down', point.x, point.y)
    await ui.dom('native pointer down starts resizing', `${shell}.dataset.sidebarResizing === 'true'`)
    // AppKit distinguishes mouseMoved from leftMouseDragged while the button is held.
    await renderer.mouse('drag', point.x - 135, point.y)
    await ui.dom('63px past minimum stays expanded', `${shell}.dataset.sidebarCollapsed === 'false' && ${handle}.getAttribute('aria-valuenow') === '188'`)
    await renderer.mouse('drag', point.x - 136, point.y)
    await ui.dom('64px past minimum collapses', `${shell}.dataset.sidebarCollapsed === 'true'`)
    await renderer.mouse('up', point.x - 136, point.y)
    await ui.expect('drag collapse saved without overwriting width', async () => {
      const value = (await ui.evaluate('window.desktopSettings.snapshot()')).settings
      return value.sidebarCollapsed === true && value.sidebarWidth === 260
    })
    await ui.click(toggle)
    await ui.dom('reopening restores original width', `${handle}.getAttribute('aria-valuenow') === '260'`)
    await ui.expect('drag reopen settles', async () => (await ui.evaluate('window.desktopSettings.snapshot()')).settings.sidebarCollapsed === false)
    return { originalWidth: 260, minimum: 188, overshoot: 64 }
  })
  await ui.stage('sidebar-save-failure-and-retry', async () => {
    await withSettingsWriteDenied(ui, async () => {
      await ui.click(toggle)
      await ui.dom('save error visible and layout restored', `!!document.querySelector('.settings-save-error-retry') && ${shell}.dataset.sidebarCollapsed === 'false'`)
      assert.equal((await ui.evaluate('window.desktopSettings.snapshot()')).settings.sidebarCollapsed, false)
    })
    await ui.click('document.querySelector(".settings-save-error-retry")')
    await ui.dom('retry saves and applies collapsed layout', `!document.querySelector('.settings-save-error') && ${shell}.dataset.sidebarCollapsed === 'true'`)
    return { failure: 'real settings directory write denial with exact permission restoration', retry: true }
  })
  await ui.stage('sidebar-compact-and-accessible-labels', async () => {
    await renderer.resize(880, 640)
    assert.equal((await ui.evaluate('window.desktopSettings.update({textSize:"large",language:"en"})')).ok, true)
    await ui.dom('large English topbar ready', 'document.documentElement.lang === "en"')
    assert.equal(await ui.evaluate('Array.from(document.querySelectorAll(".topbar-tabs button,.topbar-icon")).every(b=>!!b.getAttribute("aria-label"))'), true)
    const narrowBrand = await assertTitlebarLogo(ui, (await renderer.inspect()).geometry)
    const tabCount = await ui.evaluate('document.querySelectorAll(".topbar-tabs button").length')
    for (let index = 0; index < tabCount; index++) {
      const selector = `document.querySelectorAll('.topbar-tabs button')[${index}]`
      const rect = await assertReachable(ui, selector)
      assert.ok(rect.left >= narrowBrand.brand.right + 8, 'Narrow topbar navigation clears the titlebar brand')
      await ui.click(selector)
      await ui.dom('narrow topbar destination opens', `${selector}.getAttribute('aria-current') === 'page'`)
    }
    for (let index = 0; index < 2; index++) await assertReachable(ui, `document.querySelectorAll('.topbar-icon')[${index}]`)
    // Resize actual WK content: CSS zoom does not change media queries.
    await renderer.resize(640, 640)
    await ui.dom('compact navigation reachable', `${shell}.dataset.compactNavigation === 'true'`)
    const compactToggle = await assertReachable(ui, 'document.querySelector(".navigation-toggle")')
    const compactBrand = await assertTitlebarLogo(ui, (await renderer.inspect()).geometry)
    assert.ok(compactToggle.top >= compactBrand.brand.bottom + 8, 'Compact navigation remains below the titlebar brand')
    await ui.click('document.querySelector(".navigation-toggle")')
    await ui.dom('compact menu opens', 'document.querySelector("#main-navigation").matches(":popover-open")')
    const compactEntry = await assertReachable(ui, 'document.querySelector(".sidebar nav button")')
    assert.ok(compactEntry.top >= compactBrand.brand.bottom + 8, 'Open compact menu clears the logo and wordmark')
    await assertReachable(ui, 'document.querySelector(".sidebar-bottom button:last-child")')
    await ui.navigate('设置', 'Settings')
    await renderer.resize(1280, 860)
    await ui.dom('saved collapsed preference survives compact mode', `${shell}.dataset.compactNavigation === 'false' && ${shell}.dataset.sidebarCollapsed === 'true'`)
    assert.equal((await ui.evaluate('window.desktopSettings.update({textSize:"default"})')).ok, true)
    return { compactPreservesPreference: true, accessibleNames: true, narrowBrand, compactBrand }
  })
  return { settings: { sidebarCollapsed: true, sidebarWidth: 260, language: 'en', textSize: 'default' } }
}

export async function verifySidebarRestart({ ui, savedSettings }) {
  await ui.stage('restart-sidebar-preferences', async () => {
    const value = (await ui.evaluate('window.desktopSettings.snapshot()')).settings
    assert.equal(value.sidebarCollapsed, savedSettings.sidebarCollapsed)
    assert.equal(value.sidebarWidth, savedSettings.sidebarWidth)
    await ui.dom('restart restores collapsed navigation', `${shell}.dataset.sidebarCollapsed === 'true'`)
    await ui.click(toggle)
    await ui.dom('restart retains expanded width', `${handle}.getAttribute('aria-valuenow') === '260'`)
    return { collapsed: savedSettings.sidebarCollapsed, width: savedSettings.sidebarWidth }
  })
}
