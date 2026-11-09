import assert from 'node:assert/strict'

const $ = selector => `document.querySelector(${JSON.stringify(selector)})`
const mode = value => `Array.from(document.querySelectorAll('.topology-mode button')).find(button => button.textContent === ${JSON.stringify(value)})`
const floor = '.topology-3d-picker:nth-child(1) select'
const employee = '.topology-3d-picker:nth-child(2) select'

export async function exerciseTopology({ ui, renderer, record, agent }) {
  const agents = await ui.evaluate('window.monitor.snapshot().then(snapshot => snapshot.agents.data.agents)')
  const agentsById = new Map(agents.map(item => [item.id, item]))
  const rootFor = id => {
    const seen = new Set()
    let current = agentsById.get(id)
    assert.ok(current, `fixture must contain employee ${id}`)
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
  const roots = agents.filter(item => !item.parentId)
  const projects = new Map()
  for (const root of roots) {
    const cwd = projectOf(root)
    if (!projects.has(cwd)) projects.set(cwd, [])
    projects.get(cwd).push(root)
  }
  const expectedFloor = id => `task:${rootFor(id).id}`
  const chooseEmployee = async id => {
    await ui.evaluate(`(() => { const picker = ${$(employee)}; picker.value = ${JSON.stringify(id)}; picker.dispatchEvent(new Event('change', {bubbles:true})); })()`)
    await ui.dom('employee selection opens its task floor and exact details', `${$('.agent-inspector')}?.dataset.agentId === ${JSON.stringify(id)} && ${$(floor)}?.value === ${JSON.stringify(expectedFloor(id))}`)
  }
  await ui.stage('office-navigation-and-focus', async () => {
    await ui.navigate('本机概览', 'Overview')
    await ui.click($('.agent-preview .entity-button'))
    await ui.dom('overview opens the exact employee in 3D', `${$('.agent-inspector')}?.dataset.agentId === ${JSON.stringify(agent.id)} && !!${$('.topology-3d-webgl')}`)
    await ui.dom('selected employee is revealed in its own task', `${$(floor)}?.value === ${JSON.stringify(expectedFloor(agent.id))} && !!${$(`.topology-3d-label[data-id=${JSON.stringify(agent.id)}]:not([hidden])`)}`)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('details close and keyboard focus returns to the office', `!${$('.agent-inspector')} && (document.activeElement?.matches('.topology-3d-label, .topology-3d-webgl') ?? false)`)
    await ui.frames()
    assert.equal(await ui.evaluate(`document.activeElement?.matches('.topology-3d-label, .topology-3d-webgl')`), true)
    return { agentId: agent.id, floor: await ui.evaluate(`${$(floor)}.value`) }
  })

  await ui.stage('office-project-groups-task-floors-and-roles', async () => {
    const groups = await ui.evaluate(`Array.from(${$(floor)}.querySelectorAll('optgroup'), group => ({ label:group.label, cwd:group.title, floors:Array.from(group.querySelectorAll('option'), option => ({id:option.value,title:option.title,label:option.textContent})) }))`)
    assert.equal(groups.length, projects.size, 'one optgroup must represent each actual fixture project')
    for (const [cwd, tasks] of projects) {
      const group = groups.find(item => item.cwd === cwd)
      assert.ok(group, `project menu must expose its full cwd: ${cwd || '(unknown)'}`)
      assert.deepEqual(group.floors.map(item => item.id).sort(), tasks.map(item => `task:${item.id}`).sort(), 'each main-session branch needs a distinct task floor')
      for (const task of tasks) {
        const option = group.floors.find(item => item.id === `task:${task.id}`)
        assert.equal(option.title, cwd, 'task tooltip must retain the full project path')
        assert.ok(option.label.includes(task.summary || task.name), 'task menu must display its real root summary')
      }
      if (!cwd) assert.match(group.label, /项目未识别|Unidentified project/)
    }
    const options = await ui.evaluate(`Array.from(${$(employee)}.options, option => ({id:option.value,label:option.textContent}))`)
    for (const item of agents) {
      const option = options.find(option => option.id === item.id)
      assert.ok(option, `employee picker must contain ${item.id}`)
      assert.match(option.label, item.kind === 'main' ? /主 Agent|Main agent/ : /子 Agent|Subagent/, 'main and subagent responsibilities must remain distinguishable')
    }
    const sharedProject = [...projects.entries()].find(([, tasks]) => tasks.length > 1)
    assert.ok(sharedProject, 'fixture must provide multiple task branches in one project group')
    const [cwd, tasks] = sharedProject
    await chooseEmployee(tasks[0].id)
    await chooseEmployee(tasks[1].id)
    const child = agents.find(item => item.kind === 'subagent' && rootFor(item.id).id === tasks[1].id)
    assert.ok(child, 'fixture must provide a subagent in the second task')
    await chooseEmployee(child.id)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('role selection closes details without clearing its task floor', `!${$('.agent-inspector')} && ${$(floor)}?.value === ${JSON.stringify(expectedFloor(child.id))}`)
    return { projects: groups, roles: { main: roots.length, subagent: agents.filter(item => item.kind === 'subagent').length }, selectedChild: child.id,
      sharedProject: cwd || null, distinctTaskFloors: tasks.map(item => `task:${item.id}`),
      coverage: cwd ? 'Known project with multiple tasks' : 'Unknown project group with multiple tasks; known cwd grouping is not exercised by this fixture',
      unexercised: ['Missing-parent and cyclic-parent fixtures'] }
  })

  await ui.stage('office-state-after-page-and-mode-switch', async () => {
    await ui.click(`Array.from(document.querySelectorAll('.topology-3d-controls button')).find(button => ['聚焦楼层','Focus floor'].includes(button.textContent))`)
    await ui.frames()
    const labels = () => ui.evaluate(`Array.from(document.querySelectorAll('.topology-3d-floor-label:not([hidden])'), label => ({id:label.dataset.floorId,position:label.style.transform,dimmed:label.classList.contains('is-dimmed')}))`)
    const selectedFloor = await ui.evaluate(`${$(floor)}.value`)
    const before = await labels()
    assert.ok(before.some(label => label.id === selectedFloor && !label.dimmed), 'selected floor must remain legible')
    await ui.navigate('数据来源', 'Data sources')
    await ui.navigate('协作拓扑', 'Agent topology')
    await ui.dom('task selection survives page unmount', `!!${$('.topology-3d-webgl')} && ${$(floor)}?.value === ${JSON.stringify(selectedFloor)} && !${$('.topology-3d-message')}`)
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
    await chooseEmployee(agents[0].id)
    const employeeId = await ui.evaluate(`${$('.agent-inspector')}.dataset.agentId`)
    const selectedTaskFloor = expectedFloor(employeeId)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('employee picker details close', `!${$('.agent-inspector')}`)
    await ui.click($('.agent-search input'))
    await ui.evaluate(`${$('.agent-search input')}.select()`)
    await ui.key('Backspace', 'Backspace', 8)
    // The query is intentionally unmatched; data still comes from the real fixture plugin and IPC.
    await renderer.call('Input.insertText', { text: 'office-smoke-no-match' }, 5000)
    await ui.dom('filter empty state retains task selection and explains absence', `!!${$('.topology-empty-overlay')} && !!${$('.topology-3d-floor-status')} && ${$(floor)}?.value === ${JSON.stringify(selectedTaskFloor)}`)
    await ui.click($('.topology-empty-overlay button'))
    await ui.dom('clearing filters restores employees and the selected task', `!${$('.topology-empty-overlay')} && ${$(employee)}?.options.length === ${agents.length + 1} && ${$(floor)}?.value === ${JSON.stringify(selectedTaskFloor)} && !${$('.topology-3d-floor-status')}`)
    const restoredChild = agents.find(item => item.kind === 'subagent' && rootFor(item.id).id !== rootFor(employeeId).id)
    assert.ok(restoredChild, 'fixture must provide another task after filters clear')
    await chooseEmployee(restoredChild.id)
    await ui.key('Escape', 'Escape', 27)
    await ui.dom('restored employee selection uses the latest layout', `!${$('.agent-inspector')} && ${$(floor)}?.value === ${JSON.stringify(expectedFloor(restoredChild.id))}`)
    await ui.navigate('设置', 'Settings')
    await ui.click($('input[name="appearance"][value="dark"]'))
    await ui.dom('dark theme persists through real settings IPC', `${$('.settings-list')}?.getAttribute('aria-busy') === 'false' && document.documentElement.dataset.theme === 'dark'`)
    await ui.navigate('协作拓扑', 'Agent topology')
    await ui.dom('office restores task selection in dark theme without an error', `!!${$('.topology-3d-webgl')} && !${$('.topology-3d-message')} && document.documentElement.dataset.theme === 'dark' && ${$(floor)}?.value === ${JSON.stringify(expectedFloor(restoredChild.id))}`)
    await ui.info()
    return { employeeId, emptyState: true, restored: true, restoredChildId: restoredChild.id, appearance: 'dark' }
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
