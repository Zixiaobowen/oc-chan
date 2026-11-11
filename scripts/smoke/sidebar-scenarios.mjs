import assert from 'node:assert/strict'
import { withSettingsWriteDenied } from './notification-scenarios.mjs'

const shell = 'document.querySelector(".app-shell")'
const toggle = 'document.querySelector(".sidebar-toggle")'
const handle = 'document.querySelector(".sidebar-resize-handle")'

export async function exerciseSidebar({ ui, renderer }) {
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
    // Resize actual WK content: CSS zoom does not change media queries.
    await renderer.resize(640, 640)
    await ui.dom('compact navigation reachable', `${shell}.dataset.compactNavigation === 'true'`)
    await ui.click('document.querySelector(".navigation-toggle")')
    await ui.dom('compact menu opens', 'document.querySelector("#main-navigation").matches(":popover-open")')
    await ui.navigate('设置', 'Settings')
    await renderer.resize(1280, 860)
    await ui.dom('saved collapsed preference survives compact mode', `${shell}.dataset.compactNavigation === 'false' && ${shell}.dataset.sidebarCollapsed === 'true'`)
    assert.equal((await ui.evaluate('window.desktopSettings.update({textSize:"default"})')).ok, true)
    return { compactPreservesPreference: true, accessibleNames: true }
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
