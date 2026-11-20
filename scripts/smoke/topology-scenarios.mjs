import assert from 'node:assert/strict'

const $ = selector => `document.querySelector(${JSON.stringify(selector)})`
const mode = value => `Array.from(document.querySelectorAll('.topology-mode button')).find(button => button.textContent === ${JSON.stringify(value)})`
const taskPicker = '.topology-3d-picker:nth-child(1) select'
const agentPicker = '.topology-3d-picker:nth-child(2) select'

export async function exerciseTopology({ ui, renderer, record, agent, overviewAgent, fixtureAgentIds }) {
  const agents = await ui.evaluate('window.monitor.snapshot().then(snapshot => snapshot.agents.data.agents)')
  const fixtureIds = new Set(fixtureAgentIds)
  const fixtures = agents.filter(item => fixtureIds.has(item.id))
  assert.equal(fixtures.length, fixtureAgentIds.length, 'topology fixture identities must remain discoverable')
  record('topology-agent-evidence', { agents: fixtures.map(({ id, parentId, kind, cwd, sessionId, pid, name }) => ({ id, parentId, kind, cwd, sessionId, pid, name })) })
  const agentsById = new Map(agents.map(item => [item.id, item]))
  const rootFor = id => {
    const seen = new Set()
    let current = agentsById.get(id)
    assert.ok(current, `fixture must contain agent ${id}`)
    while (current.parentId) {
      assert.ok(!seen.has(current.id), 'fixture parent chains must be acyclic')
      seen.add(current.id)
      current = agentsById.get(current.parentId)
      assert.ok(current, 'fixture must contain every referenced parent')
    }
    assert.equal(current.kind, 'main', 'fixture task root must be a main agent')
    return current
  }
  const projectOf = item => item.cwd ? item.cwd.replace(/\/+$/, '') || '/' : ''
  const roots = fixtures.filter(item => !item.parentId)
  const projects = new Map()
  for (const root of roots) {
    const cwd = projectOf(root)
    if (!projects.has(cwd)) projects.set(cwd, [])
    projects.get(cwd).push(root)
  }
  const expectedTask = id => `task:${rootFor(id).id}`
  const chooseAgent = async id => {
    await ui.evaluate(`(() => { const picker = ${$(agentPicker)}; picker.value = ${JSON.stringify(id)}; picker.dispatchEvent(new Event('change', {bubbles:true})); })()`)
    await ui.dom('agent selection opens its task system and exact details', `${$('.agent-inspector')}?.dataset.agentId === ${JSON.stringify(id)} && ${$(taskPicker)}?.value === ${JSON.stringify(expectedTask(id))}`)
  }
  await ui.stage('galaxy-navigation-and-focus', async () => {
    await ui.navigate('本机概览', 'Overview')
    await ui.click($('.agent-preview .entity-button'))
    await ui.dom('overview opens the exact agent in 3D', `${$('.agent-inspector')}?.dataset.agentId === ${JSON.stringify(overviewAgent.id)} && !!${$('.topology-3d-webgl')}`)
    await chooseAgent(agent.id)
    await ui.dom('selected agent opens its own task system', `${$(taskPicker)}?.value === ${JSON.stringify(expectedTask(agent.id))}`)
    await ui.dom('selected agent label is projected into the visible scene', `!!${$(`.topology-3d-label[data-id=${JSON.stringify(agent.id)}]:not([hidden])`)}`)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('details close and keyboard focus returns to the galaxy', `!${$('.agent-inspector')} && (document.activeElement?.matches('.topology-3d-label, .topology-3d-webgl') ?? false)`)
    await ui.frames()
    assert.equal(await ui.evaluate(`document.activeElement?.matches('.topology-3d-label, .topology-3d-webgl')`), true)
    return { agentId: agent.id, task: await ui.evaluate(`${$(taskPicker)}.value`) }
  })

  await ui.stage('galaxy-overview-default', async () => {
    await ui.click(`Array.from(document.querySelectorAll('.topology-3d-controls button')).find(button => ['显示全部任务','Show all tasks'].includes(button.textContent))`)
    await ui.click(`Array.from(document.querySelectorAll('.topology-3d-controls button')).find(button => ['适应全部','Fit all'].includes(button.textContent))`)
    await ui.dom('all tasks are visible in the galaxy overview', `${$(taskPicker)}?.value === '' && !!${$('.topology-3d-webgl')} && !${$('.topology-3d-message')}`)
    await ui.frames()
    return { projects: projects.size, tasks: roots.length, agents: agents.length, viewport: [1280, 860] }
  })

  await ui.stage('galaxy-project-groups-tasks-and-roles', async () => {
    const groups = await ui.evaluate(`Array.from(${$(taskPicker)}.querySelectorAll('optgroup'), group => ({ label:group.label, cwd:group.title, tasks:Array.from(group.querySelectorAll('option'), option => ({id:option.value,title:option.title,label:option.textContent})) }))`)
    assert.ok(projects.size >= 2, 'fixture must exercise multiple distinct project galaxies')
    assert.ok(groups.length >= projects.size, 'each fixture project must have a galaxy group')
    for (const [cwd, tasks] of projects) {
      const group = groups.find(item => item.cwd === cwd)
      assert.ok(group, `project menu must expose its full cwd: ${cwd || '(unknown)'}`)
      assert.deepEqual(group.tasks.map(item => item.id).sort(), tasks.map(item => `task:${item.id}`).sort(), 'each main-session branch needs a distinct task system')
      for (const task of tasks) {
        const option = group.tasks.find(item => item.id === `task:${task.id}`)
        assert.equal(option.title, cwd, 'task tooltip must retain the full project path')
        assert.ok(option.label.includes(task.summary || task.name), 'task menu must display its real root summary')
      }
      if (!cwd) assert.match(group.label, /项目未识别|Unidentified project/)
    }
    const options = await ui.evaluate(`Array.from(${$(agentPicker)}.options, option => ({id:option.value,label:option.textContent}))`)
    for (const item of fixtures) {
      const option = options.find(option => option.id === item.id)
      assert.ok(option, `agent picker must contain ${item.id}`)
      assert.match(option.label, item.kind === 'main' ? /主 Agent|Main agent/ : /子代理|Subagent/, 'main and subagent responsibilities must remain distinguishable')
    }
    const sharedProject = [...projects.entries()].find(([, tasks]) => tasks.length > 1 && tasks.slice(0, 2).every(task => fixtures.some(item => item.kind === 'subagent' && item.parentId === task.id)))
    assert.ok(sharedProject, 'fixture must provide multiple task branches in one project group')
    const crossDirectoryChild = fixtures.find(item => item.kind === 'subagent' && projectOf(item) !== projectOf(rootFor(item.id)))
    assert.ok(crossDirectoryChild, 'fixture must include a subagent with a different working directory')
    assert.ok(groups.find(group => group.cwd === projectOf(rootFor(crossDirectoryChild.id)))?.tasks.some(task => task.id === expectedTask(crossDirectoryChild.id)), 'cross-directory subagent must follow its main task project')
    await chooseAgent(crossDirectoryChild.id)
    const [cwd, tasks] = sharedProject
    await chooseAgent(tasks[0].id)
    await chooseAgent(tasks[1].id)
    const child = fixtures.find(item => item.kind === 'subagent' && rootFor(item.id).id === tasks[1].id)
    assert.ok(child, 'fixture must provide a subagent in the second task')
    await chooseAgent(child.id)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('role selection closes details without clearing its task system', `!${$('.agent-inspector')} && ${$(taskPicker)}?.value === ${JSON.stringify(expectedTask(child.id))}`)
    return { projects: groups.filter(group => projects.has(group.cwd)), roles: { main: roots.length, subagent: fixtures.filter(item => item.kind === 'subagent').length }, selectedChild: child.id,
      sharedProject: cwd || null, distinctTasks: tasks.map(item => `task:${item.id}`), crossDirectoryChild: crossDirectoryChild.id,
      unexercised: ['Missing-parent and cyclic-parent fixtures'] }
  })
  assert.equal(agent.runtime, 'OMP', `Tern menu smoke requires an OMP fixture; received ${agent.runtime}`)
  const menu = '.topology-context-menu:popover-open'
  const item = `${menu} [role="menuitem"]`
  const navigationError = '.topology-navigation-error'
  const galaxyAgent = `.topology-3d-label[data-id=${JSON.stringify(agent.id)}]:not([hidden])`
  const node = `.react-flow__node[data-id=${JSON.stringify(agent.id)}]`
  const inspectedAgent = `${$('.agent-inspector')}?.dataset.agentId === ${JSON.stringify(agent.id)}`
  const noGalaxyTernAction = `!${$(menu)} && !${$('.topology-3d [role="alert"]')} && !Array.from(document.querySelectorAll('.topology-3d-controls button'), button => button.textContent).some(text => text.includes('Tern'))`
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
    const point = await pointFor(selector)
    await renderer.mouse('move', point.x, point.y)
    await renderer.mouse('down', point.x, point.y, 'right')
    await renderer.mouse('up', point.x, point.y, 'right')
    await ui.frames()
  }
  await ui.stage('galaxy-drag-survives-filter', async () => {
    const child = fixtures.find(item => item.kind === 'subagent' && item.name && item.parentId)
    assert.ok(child, 'fixture must provide a draggable child')
    await chooseAgent(child.id)
    await ui.click(`Array.from(document.querySelectorAll('.topology-3d-controls button')).find(button => ['聚焦选中 Agent','Focus selected agent'].includes(button.textContent))`)
    const label = `.topology-3d-label[data-id=${JSON.stringify(child.id)}]:not([hidden])`
    await ui.dom('focused fixture planet has a visible label', `!!${$(label)}`)
    await ui.frames()
    const before = await ui.evaluate(`${$(label)}.style.transform`)
    const point = await pointFor('.topology-3d-webgl')
    await renderer.mouse('move', point.x, point.y)
    await renderer.mouse('down', point.x, point.y)
    await renderer.mouse('drag', point.x + 40, point.y + 20)
    await renderer.mouse('up', point.x + 40, point.y + 20)
    const moved = await ui.dom('drag moves the real fixture planet', `${$(label)}?.style.transform !== ${JSON.stringify(before)} && ${$(label)}?.style.transform`)
    await ui.click($('.agent-search input'))
    await renderer.text(child.name)
    await ui.dom('filter retains the dragged fixture planet', `${$('.agent-search input')}?.value === ${JSON.stringify(child.name)} && !!${$(label)} && ${$(agentPicker)}.options.length < ${agents.length + 1}`)
    await ui.frames()
    assert.equal(await ui.evaluate(`${$(label)}.style.transform`), moved, 'filtering must preserve the dragged planet and camera')
    await ui.evaluate(`${$('.agent-search input')}.select()`)
    await ui.key('Backspace', 'Backspace', 8)
    await ui.dom('clearing the filter restores the fixture tasks', `${$('.agent-search input')}?.value === '' && ${$(agentPicker)}?.options.length >= ${fixtures.length + 1}`)
    await ui.frames()
    assert.equal(await ui.evaluate(`${$(label)}.style.transform`), moved, 'clearing filters must preserve the dragged planet and camera')
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('dragged planet details close', `!${$('.agent-inspector')}`)
    return { agentId: child.id, input: 'AppKit drag and search', restoredAfterFilter: true }
  })
  await ui.stage('galaxy-agent-inspection', async () => {
    await ui.navigate('本机概览', 'Overview')
    await ui.click($('.agent-preview .entity-button'))
    await ui.dom('overview opens its selected agent', `${$('.agent-inspector')}?.dataset.agentId === ${JSON.stringify(overviewAgent.id)}`)
    await chooseAgent(agent.id)
    await ui.dom('galaxy shows the selected fixture OMP agent details', inspectedAgent)
    await rightClick(galaxyAgent)
    assert.equal(await ui.evaluate(noGalaxyTernAction), true, 'right-clicking a 3D agent must offer no Tern action')
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('closing details returns to the galaxy agent label', `!${$('.agent-inspector')} && document.activeElement === ${$(galaxyAgent)}`)
    await ui.key('F10', 'F10', 121, 8)
    await ui.frames()
    assert.equal(await ui.evaluate(noGalaxyTernAction), true, 'Shift+F10 on a 3D agent must offer no Tern action')
    await ui.key('Enter', 'Enter', 13)
    await ui.dom('the galaxy agent label still opens details with Enter', inspectedAgent)
    return { agentId: agent.id, input: 'AppKit right press/release and Shift+F10, Enter' }
  })
  await ui.stage('galaxy-agent-inspection-narrow', async () => {
    await renderer.resize(880, 640)
    await ui.dom('galaxy keeps the exact agent and task in a narrow window', `innerWidth === 880 && innerHeight === 640 && ${inspectedAgent} && ${$(taskPicker)}?.value === ${JSON.stringify(expectedTask(agent.id))}`)
    await ui.click(`Array.from(document.querySelectorAll('.topology-3d-controls button')).find(button => ['聚焦选中 Agent','Focus selected agent'].includes(button.textContent))`)
    assert.equal(await ui.evaluate(noGalaxyTernAction), true, 'narrow galaxy controls must offer no Tern action')
    return { agentId: agent.id, width: 880, height: 640 }
  })
  await ui.stage('galaxy-overview-narrow', async () => {
    await ui.click($('.agent-inspector .section-heading .icon-button'))
    await ui.dom('narrow details close', `!${$('.agent-inspector')}`)
    await ui.click(`Array.from(document.querySelectorAll('.topology-3d-controls button')).find(button => ['显示全部任务','Show all tasks'].includes(button.textContent))`)
    await ui.click(`Array.from(document.querySelectorAll('.topology-3d-controls button')).find(button => ['适应全部','Fit all'].includes(button.textContent))`)
    await ui.dom('narrow galaxy overview remains accessible', `innerWidth === 880 && innerHeight === 640 && !!${$('.topology-3d-webgl')} && ${$(taskPicker)}?.value === '' && !${$('.topology-3d-message')}`)
    await ui.frames()
    return { width: 880, height: 640, projects: projects.size }
  })
  await chooseAgent(agent.id)
  await renderer.resize(1280, 860)
  await ui.dom('default viewport restored in WKWebView', 'innerWidth === 1280 && innerHeight === 860')

  async function openNodeMenu() {
    await ui.click(`Array.from(document.querySelectorAll('.topology-controls button')).find(button => ['适应视图','Fit view'].includes(button.textContent))`)
    await ui.frames()
    await rightClick(node)
    await ui.dom('menu survives the complete right-click gesture', `!!${$(menu)} && document.activeElement === ${$(item)}`)
  }
  await ui.stage('topology-2D-context-menu-open', async () => {
    await ui.click(mode('2D'))
    await ui.dom('the inspected OMP agent stays selected in 2D', `${mode('2D')}?.getAttribute('aria-pressed') === 'true' && ${inspectedAgent}`)
    await openNodeMenu()
    const point = await pointFor(item)
    await renderer.mouse('move', point.x, point.y)
    await ui.frames()
    await ui.dom('moving into the menu keeps its action available', `!!${$(menu)} && !${$(item)}?.disabled`)
    return { agentId: agent.id, runtime: agent.runtime, input: 'AppKit right press/release and pointer move', menuOpen: true }
  })
  await ui.stage('topology-2D-context-menu-actions', async () => {
    await ui.click($(item))
    await ui.dom('real Tern IPC is rejected by the headless boundary', `${$(navigationError)}?.textContent.includes('OC_TERN_UNAVAILABLE') && !${$(menu)}`)
    const rejection = await ui.evaluate(`${$(navigationError)}.textContent`)
    await ui.info()
    await ui.click(`${$(navigationError)}.querySelector('button')`)
    await openNodeMenu()
    await ui.evaluate(`(() => {
      const events = window.__ocTopologyPointerDiagnostic = {};
      for (const type of ['pointerdown', 'pointerup']) document.addEventListener(type, event => {
        events[type] = { x: event.clientX, y: event.clientY, target: event.target?.tagName, className: typeof event.target?.className === 'string' ? event.target.className : '' };
      }, { capture: true, once: true });
      return true;
    })()`)
    await ui.click($('.agent-search input'))
    record('topology-menu-outside-pointer', await ui.evaluate(`({ events: window.__ocTopologyPointerDiagnostic, active: document.activeElement?.tagName, activeClass: document.activeElement?.className, menuOpen: !!${$(menu)} })`))
    await ui.dom('outside pointer click dismisses the menu and keeps destination focus', `!${$(menu)} && document.activeElement === ${$('.agent-search input')}`)
    await openNodeMenu()
    await ui.key('Escape', 'Escape', 27)
    await ui.frames()
    await ui.dom('Escape restores focus to the exact originating agent', `!${$(menu)} && document.activeElement === ${$(node)}`)
    await ui.key('F10', 'F10', 121, 8)
    await ui.dom('Shift+F10 opens the focused agent menu', `!!${$(menu)} && document.activeElement === ${$(item)}`)
    await ui.key('Tab', 'Tab', 9)
    await ui.frames()
    await ui.dom('Tab dismisses the menu without trapping focus in a detached item', `!${$(menu)} && !!document.activeElement?.isConnected && document.activeElement !== document.body && !document.activeElement.closest('.topology-context-menu')`)
    return { rejection, outsideClick: true, escapeRestoresAgent: true, shiftF10: true, tabDismisses: true }
  })
  await ui.click($('.agent-inspector .section-heading .icon-button'))
  await ui.dom('details close after menu checks', `!${$('.agent-inspector')}`)
  await ui.click(mode('3D'))
  await ui.dom('3D restored after the 2D menu scenario', `!!${$('.topology-3d-webgl')}`)

  await ui.stage('galaxy-state-after-page-and-mode-switch', async () => {
    await ui.click(`Array.from(document.querySelectorAll('.topology-3d-controls button')).find(button => ['聚焦任务','Focus task'].includes(button.textContent))`)
    await ui.frames()
    const labels = () => ui.evaluate(`Array.from(document.querySelectorAll('.topology-3d-task-label:not([hidden])'), label => {
      const kind = label.classList.contains('topology-3d-galaxy-label') ? 'galaxy' : 'task';
      const id = kind === 'galaxy' ? label.dataset.galaxyId : label.dataset.taskId;
      if (!id) throw new Error('Projected ' + kind + ' label has no identity');
      return {kind,id,position:label.style.transform,dimmed:label.classList.contains('is-dimmed')};
    }).sort((left,right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))`)
    const selectedTask = await ui.evaluate(`${$(taskPicker)}.value`)
    const before = await labels()
    assert.ok(before.some(label => label.id === selectedTask && !label.dimmed), 'selected task must remain legible')
    await ui.navigate('数据来源', 'Data sources')
    await ui.navigate('协作拓扑', 'Agent topology')
    await ui.dom('task selection survives page unmount', `!!${$('.topology-3d-webgl')} && ${$(taskPicker)}?.value === ${JSON.stringify(selectedTask)} && !${$('.topology-3d-message')}`)
    await ui.frames()
    assert.deepEqual(await labels(), before, 'page navigation must preserve the camera and task selection')
    await ui.click(mode('2D'))
    await ui.dom('2D remains available after galaxy navigation', `!!${$('.react-flow__node')} && !${$('.topology-3d-webgl')}`)
    await ui.navigate('本机概览', 'Overview')
    await ui.navigate('协作拓扑', 'Agent topology')
    await ui.dom('chosen 2D mode survives page navigation', `${mode('2D')}?.getAttribute('aria-pressed') === 'true' && !!${$('.react-flow__node')}`)
    await ui.click(mode('3D'))
    await ui.dom('3D remount restores the task', `${$(taskPicker)}?.value === ${JSON.stringify(selectedTask)} && !${$('.topology-3d-message')}`)
    await ui.frames()
    assert.deepEqual(await labels(), before, 'view switching must preserve the galaxy camera')
    return { selectedTask, labels: before, restoredAfterPageAndModeSwitch: true }
  })

  await ui.stage('galaxy-selection-filter-and-theme', async () => {
    await chooseAgent(fixtures[0].id)
    const agentId = await ui.evaluate(`${$('.agent-inspector')}.dataset.agentId`)
    const selectedTask = expectedTask(agentId)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('agent picker details close', `!${$('.agent-inspector')}`)
    await ui.click($('.agent-search input'))
    await ui.evaluate(`${$('.agent-search input')}.select()`)
    await ui.key('Backspace', 'Backspace', 8)
    // The query is intentionally unmatched; data still comes from the real fixture plugin and IPC.
    await renderer.text('galaxy-smoke-no-match')
    await ui.dom('filter empty state retains task selection and explains absence', `!!${$('.topology-empty-overlay')} && !!${$('.topology-3d-task-status')} && ${$(taskPicker)}?.value === ${JSON.stringify(selectedTask)}`)
    await ui.click($('.topology-empty-overlay button'))
    await ui.dom('clearing filters restores agents and the selected task', `!${$('.topology-empty-overlay')} && ${JSON.stringify(fixtureAgentIds)}.every(id => Array.from(${$(agentPicker)}?.options ?? []).some(option => option.value === id)) && ${$(taskPicker)}?.value === ${JSON.stringify(selectedTask)} && !${$('.topology-3d-task-status')}`)
    const restoredChild = fixtures.find(item => item.kind === 'subagent' && rootFor(item.id).id !== rootFor(agentId).id)
    assert.ok(restoredChild, 'fixture must provide another task after filters clear')
    await chooseAgent(restoredChild.id)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('restored agent selection uses the latest layout', `!${$('.agent-inspector')} && ${$(taskPicker)}?.value === ${JSON.stringify(expectedTask(restoredChild.id))}`)
    await ui.navigate('设置', 'Settings')
    await ui.click($('input[name="appearance"][value="dark"]'))
    await ui.dom('dark theme persists through real settings IPC', `${$('.settings-list')}?.getAttribute('aria-busy') === 'false' && document.documentElement.dataset.theme === 'dark'`)
    await ui.navigate('协作拓扑', 'Agent topology')
    await ui.dom('galaxy restores task selection in dark theme without an error', `!!${$('.topology-3d-webgl')} && !${$('.topology-3d-message')} && document.documentElement.dataset.theme === 'dark' && ${$(taskPicker)}?.value === ${JSON.stringify(expectedTask(restoredChild.id))}`)
    await ui.info()
    return { agentId, emptyState: true, restored: true, restoredChildId: restoredChild.id, appearance: 'dark' }
  })

  // Existing navigation scenarios exercise React Flow keyboard behavior explicitly.
  await ui.click(mode('2D'))
  await ui.dom('2D is ready for the existing navigation scenarios', `!!${$('.react-flow__node')} && !${$('.topology-3d-webgl')}`)
  await ui.stage('overview-agent-and-escape-focus', async () => {
    await ui.navigate('本机概览', 'Overview')
    await ui.click($('.agent-preview .entity-button'))
    const inspector = `.agent-inspector[data-agent-id=${JSON.stringify(overviewAgent.id)}]`
    await ui.dom('overview opens the exact Agent', `${$(inspector)}?.querySelector('h2')?.textContent === ${JSON.stringify(overviewAgent.name)}`)
    await ui.dom('Agent source retains actual collector provenance', `${$(inspector)}?.textContent.includes(${JSON.stringify(overviewAgent.source)})`)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('Agent inspector closes on Escape', `!${$('.agent-inspector')}`)
    const focused = `document.activeElement === ${$(`.react-flow__node[data-id=${JSON.stringify(overviewAgent.id)}]`)}`
    await ui.dom('Agent focus returns after initial node measurement', focused)
    await ui.frames()
    record('agent-focus-after-overview-escape', await ui.evaluate(`(() => {
      const active = document.activeElement;
      const expected = ${$(`.react-flow__node[data-id=${JSON.stringify(overviewAgent.id)}]`)};
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
    return { agentId: overviewAgent.id, input: 'AppKit responder mouse and Enter/Escape', focusCheckedAfterFrames: 2 }
  })
  return { settings: { appearance: 'dark' } }
}
