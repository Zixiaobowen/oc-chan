import assert from 'node:assert/strict'

const $ = selector => `document.querySelector(${JSON.stringify(selector)})`
const mode = value => `Array.from(document.querySelectorAll('.topology-mode button')).find(button => button.textContent === ${JSON.stringify(value)})`
const floor = '.topology-3d-picker select'

export async function exerciseTopology({ ui, renderer, record, agent }) {
  await ui.stage('office-navigation-and-focus', async () => {
    await ui.navigate('本机概览', 'Overview')
    await ui.click($('.agent-preview .entity-button'))
    await ui.dom('overview opens the exact employee in 3D', `${$('.agent-inspector')}?.dataset.agentId === ${JSON.stringify(agent.id)} && !!${$('.topology-3d-webgl')}`)
    await ui.dom('selected employee is revealed in its own project', `${$(floor)}?.value === ${JSON.stringify(agent.cwd?.trim() ? `cwd:${agent.cwd}` : 'unknown')} && !!${$(`.topology-3d-label[data-id=${JSON.stringify(agent.id)}]:not([hidden])`)}`)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('details close and keyboard focus returns to the office', `!${$('.agent-inspector')} && (document.activeElement?.matches('.topology-3d-label, .topology-3d-webgl') ?? false)`)
    await ui.frames()
    assert.equal(await ui.evaluate(`document.activeElement?.matches('.topology-3d-label, .topology-3d-webgl')`), true)
    return { agentId: agent.id, floor: await ui.evaluate(`${$(floor)}.value`) }
  })

  assert.equal(agent.runtime, 'OMP', `Tern menu smoke requires an OMP fixture; received ${agent.runtime}`)
  const menu = '.topology-context-menu:popover-open'
  const item = `${menu} [role="menuitem"]`
  const navigationError = '.topology-navigation-error, .topology-3d-navigation-error'
  async function pointFor(selector) {
    return ui.dom('pointer target is visible and unobstructed', `(() => {
      const element = ${$(selector)};
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return rect.width && rect.height && hit && element.contains(hit) ? {x, y} : false;
    })()`)
  }
  async function rightClick(selector) {
    if (selector.startsWith('.react-flow__node')) {
      await ui.click(`Array.from(document.querySelectorAll('.topology-controls button')).find(button => ['适应视图','Fit view'].includes(button.textContent))`)
      await ui.frames()
    }
    const point = await pointFor(selector)
    await renderer.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, 5000)
    await renderer.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'right', buttons: 2, clickCount: 1 }, 5000)
    await renderer.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'right', buttons: 0, clickCount: 1 }, 5000)
    await ui.frames()
    await ui.dom('menu survives the complete right-click gesture', `!!${$(menu)} && document.activeElement === ${$(item)}`)
  }
  for (const view of ['3D', '2D']) {
    const trigger = view === '3D'
      ? `.topology-3d-label[data-id=${JSON.stringify(agent.id)}]:not([hidden])`
      : `.react-flow__node[data-id=${JSON.stringify(agent.id)}]`
    await ui.stage(`topology-${view}-context-menu-open`, async () => {
      if (view === '2D') await ui.click(mode(view))
      await ui.navigate('本机概览', 'Overview')
      await ui.click($('.agent-preview .entity-button'))
      await ui.dom('menu target selected through overview', `${$('.agent-inspector')}?.dataset.agentId === ${JSON.stringify(agent.id)}`)
      await rightClick(trigger)
      const point = await pointFor(item)
      await renderer.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, 5000)
      await ui.frames()
      await ui.dom('moving into the menu keeps its action available', `!!${$(menu)} && !${$(item)}?.disabled`)
      return { agentId: agent.id, runtime: agent.runtime, input: 'CDP right press/release and pointer move', menuOpen: true }
    })
    await ui.stage(`topology-${view}-context-menu-actions`, async () => {
      await ui.click($(item))
      await ui.dom('real Tern IPC is rejected by the headless boundary', `${$(navigationError)}?.textContent.includes('native activation are disabled in headless development') && !${$(menu)}`)
      const rejection = await ui.evaluate(`${$(navigationError)}.textContent`)
      await ui.info()
      await ui.click(`${$(navigationError)}.querySelector('button')`)
      await rightClick(trigger)
      await ui.click($('.agent-search input'))
      await ui.dom('outside pointer click dismisses the menu and keeps destination focus', `!${$(menu)} && document.activeElement === ${$('.agent-search input')}`)
      await rightClick(trigger)
      await ui.key('Escape', 'Escape', 27)
      await ui.frames()
      await ui.dom('Escape restores focus to the exact originating agent', `!${$(menu)} && document.activeElement === ${$(trigger)}`)
      await ui.key('F10', 'F10', 121, 8)
      await ui.dom('Shift+F10 opens the focused agent menu', `!!${$(menu)} && document.activeElement === ${$(item)}`)
      await ui.key('Tab', 'Tab', 9)
      await ui.frames()
      await ui.dom('Tab dismisses the menu without trapping focus in a detached item', `!${$(menu)} && !!document.activeElement?.isConnected && document.activeElement !== document.body && !document.activeElement.closest('.topology-context-menu')`)
      return { rejection, outsideClick: true, escapeRestoresAgent: true, shiftF10: true, tabDismisses: true }
    })
    await ui.click($('.agent-inspector .section-heading .icon-button'))
    await ui.dom('details close after menu checks', `!${$('.agent-inspector')}`)
  }
  await ui.click(mode('3D'))
  await ui.dom('3D restored after context menu scenarios', `!!${$('.topology-3d-webgl')}`)

  await ui.stage('office-state-after-page-and-mode-switch', async () => {
    await ui.click(`Array.from(document.querySelectorAll('.topology-3d-controls button')).find(button => ['聚焦楼层','Focus floor'].includes(button.textContent))`)
    await ui.frames()
    const labels = () => ui.evaluate(`Array.from(document.querySelectorAll('.topology-3d-floor-label:not([hidden])'), label => ({id:label.dataset.floorId,position:label.style.transform,dimmed:label.classList.contains('is-dimmed')}))`)
    const selectedFloor = await ui.evaluate(`${$(floor)}.value`)
    const before = await labels()
    assert.ok(before.some(label => label.id === selectedFloor && !label.dimmed), 'selected floor must remain legible')
    await ui.navigate('数据来源', 'Data sources')
    await ui.navigate('协作拓扑', 'Agent topology')
    await ui.dom('project selection survives page unmount', `!!${$('.topology-3d-webgl')} && ${$(floor)}?.value === ${JSON.stringify(selectedFloor)} && !${$('.topology-3d-message')}`)
    await ui.frames()
    assert.deepEqual(await labels(), before, 'page navigation must preserve the camera and floor selection')
    await ui.click(mode('2D'))
    await ui.dom('2D remains available after office navigation', `!!${$('.react-flow__node')} && !${$('.topology-3d-webgl')}`)
    await ui.navigate('本机概览', 'Overview')
    await ui.navigate('协作拓扑', 'Agent topology')
    await ui.dom('chosen 2D mode survives page navigation', `${mode('2D')}?.getAttribute('aria-pressed') === 'true' && !!${$('.react-flow__node')}`)
    await ui.click(mode('3D'))
    await ui.dom('3D remount restores the floor', `${$(floor)}?.value === ${JSON.stringify(selectedFloor)} && !${$('.topology-3d-message')}`)
    await ui.frames()
    assert.deepEqual(await labels(), before, 'view switching must preserve the office camera')
    return { selectedFloor, floorLabels: before, restoredAfterPageAndModeSwitch: true }
  })

  await ui.stage('office-selection-filter-and-theme', async () => {
    await ui.evaluate(`(() => { const picker = ${$('.topology-3d-picker:nth-child(2) select')}; picker.value = picker.options[1].value; picker.dispatchEvent(new Event('change', {bubbles:true})); })()`)
    await ui.dom('employee picker opens real details', `!!${$('.agent-inspector')}`)
    const employeeId = await ui.evaluate(`${$('.agent-inspector')}.dataset.agentId`)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('employee picker details close', `!${$('.agent-inspector')}`)
    await ui.click($('.agent-search input'))
    await ui.evaluate(`${$('.agent-search input')}.select()`)
    await ui.key('Backspace', 'Backspace', 8)
    // The query is intentionally unmatched; data still comes from the real fixture plugin and IPC.
    await renderer.call('Input.insertText', { text: 'office-smoke-no-match' }, 5000)
    await ui.dom('filter empty state retains floor selection and explains absence', `!!${$('.topology-empty-overlay')} && !!${$('.topology-3d-floor-status')}`)
    await ui.click($('.topology-empty-overlay button'))
    await ui.dom('clearing filters restores selectable employees', `!${$('.topology-empty-overlay')} && ${$('.topology-3d-picker:nth-child(2) select')}?.options.length === 33`)
    await ui.navigate('设置', 'Settings')
    await ui.click($('input[name="appearance"][value="dark"]'))
    await ui.dom('dark theme persists through real settings IPC', `${$('.settings-list')}?.getAttribute('aria-busy') === 'false' && document.documentElement.dataset.theme === 'dark'`)
    await ui.navigate('协作拓扑', 'Agent topology')
    await ui.dom('office restores in dark theme without an error', `!!${$('.topology-3d-webgl')} && !${$('.topology-3d-message')} && document.documentElement.dataset.theme === 'dark'`)
    await ui.info()
    return { employeeId, emptyState: true, restored: true, appearance: 'dark' }
  })

  // Existing navigation scenarios exercise React Flow keyboard behavior explicitly.
  await ui.click(mode('2D'))
  await ui.dom('2D is ready for the existing navigation scenarios', `!!${$('.react-flow__node')} && !${$('.topology-3d-webgl')}`)
  await ui.stage('overview-agent-and-escape-focus', async () => {
    await ui.navigate('本机概览', 'Overview')
    await ui.click($('.agent-preview .entity-button'))
    const inspector = `.agent-inspector[data-agent-id=${JSON.stringify(agent.id)}]`
    await ui.dom('overview opens the exact Agent', `${$(inspector)}?.querySelector('h2')?.textContent === ${JSON.stringify(agent.name)}`)
    await ui.dom('Agent source remains explicitly synthetic', `${$(inspector)}?.textContent.includes('Performance fixture (synthetic)')`)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('Agent inspector closes on Escape', `!${$('.agent-inspector')}`)
    const focused = `document.activeElement === ${$(`.react-flow__node[data-id=${JSON.stringify(agent.id)}]`)}`
    await ui.dom('Agent focus returns after initial node measurement', focused)
    await ui.frames()
    record('agent-focus-after-overview-escape', await ui.evaluate(`(() => {
      const active = document.activeElement;
      const expected = ${$(`.react-flow__node[data-id=${JSON.stringify(agent.id)}]`)};
      return { active: { tag: active?.tagName, class: active?.className, label: active?.getAttribute('aria-label'), id: active?.getAttribute('data-id') },
        expected: expected && { connected: expected.isConnected, tabIndex: expected.tabIndex, visibility: getComputedStyle(expected).visibility }, focused: ${focused} };
    })()`))
    assert.equal(await ui.evaluate(focused), true, 'U-07: focus must survive two frames on the original Agent node')
    await ui.key('Enter', 'Enter', 13)
    await ui.dom('returned Agent node remains keyboard operable', `!!${$(inspector)}`)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('Agent focus returns after reopening details', focused)
    await ui.frames()
    assert.equal(await ui.evaluate(focused), true, 'U-07: repeated open/close must retain node focus')
    return { agentId: agent.id, input: 'CDP mouse and Enter/Escape', focusCheckedAfterFrames: 2 }
  })
  return { settings: { appearance: 'dark' } }
}
