import assert from 'node:assert/strict'

const RPC_MS = 5_000
const ROOT = '.events-view'
const ROWS = '.event-list > li[data-event-id]'
const $ = selector => `document.querySelector(${JSON.stringify(selector)})`
const action = name => $(`[data-event-action="${name}"]`)
const row = id => `${ROWS}[data-event-id=${JSON.stringify(id)}]`
const idsExpression = `Array.from(document.querySelectorAll(${JSON.stringify(ROWS)}), element => element.dataset.eventId)`
const settled = `${$(ROOT)}?.getAttribute('aria-busy') === 'false' && !${$('.event-error')}`

async function page(ui, count = 50) {
  await ui.dom(`event page settles with ${count} rows`, `${settled} && document.querySelectorAll(${JSON.stringify(ROWS)}).length === ${count}`)
  const ids = await ui.evaluate(idsExpression)
  assert.equal(new Set(ids).size, ids.length, 'event IDs must be unique within the page')
  return ids
}

async function source(ui, renderer, value) {
  await ui.click($('#event-source-filter'))
  // Headless macOS has no active application menu to handle Command-A.
  await renderer.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] }, RPC_MS)
  await renderer.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 }, RPC_MS)
  await ui.dom('source text is fully selected before replacement', `(() => { const input = ${$('#event-source-filter')}; return input.selectionStart === 0 && input.selectionEnd === input.value.length; })()`)
  await ui.key('Backspace', 'Backspace', 8)
  if (value) await renderer.call('Input.insertText', { text: value }, RPC_MS)
  await ui.dom('exact source draft entered through CDP', `${$('#event-source-filter')}?.value === ${JSON.stringify(value)}`)
}

// Tab still exercises real focus. macOS native popup input requires a visible window;
// select options with DOM automation, then verify React state and the real IPC query.
async function select(ui, id, value) {
  await ui.click($('#event-source-filter'))
  await ui.key('Tab', 'Tab', 9)
  if (id === 'event-range-filter') await ui.key('Tab', 'Tab', 9)
  assert.equal(await ui.evaluate('document.activeElement?.id'), id)
  await ui.evaluate(`(() => {
    const element = ${$(`#${id}`)}, value = ${JSON.stringify(value)};
    if (!(element instanceof HTMLSelectElement) || !Array.from(element.options).some(option => option.value === value))
      throw new Error('Requested event filter option is unavailable');
    element.value = value;
    element.dispatchEvent(new Event('input', {bubbles:true}));
    element.dispatchEvent(new Event('change', {bubbles:true}));
    return true;
  })()`)
  await ui.key('Tab', 'Tab', 9)
  await ui.dom('select draft selected through DOM automation', `${$(`#${id}`)}?.value === ${JSON.stringify(value)}`)
}

async function queryForRows(ui, main) {
  const info = await main.evaluate('globalThis.__ocSmokeControl.info()', RPC_MS)
  const query = info.eventQueries.recent.at(-1)
  assert.ok(query && info.eventQueries.active === 0, 'a completed real event IPC request must exist')
  const result = await ui.evaluate(`window.monitor.events(${JSON.stringify(query)})`)
  assert.deepEqual(await ui.evaluate(idsExpression), result.entries.map(entry => entry.id), 'DOM must match the actual IPC page')
  return { query, result }
}

export async function exerciseEmptyEvents(ui) {
  await ui.stage('events-initial-empty-baseline', async () => {
    await ui.navigate('事件', 'Events')
    await page(ui, 0)
    await ui.dom('empty baseline is distinct from no matches', `/尚无保留事件|No retained events/.test(${$('.event-empty')}?.textContent ?? '')`)
    const result = await ui.evaluate('window.monitor.events()')
    assert.equal(result.retention.count, 0, 'F05 empty state must run before F04 creates records')
    return { retained: 0, source: 'real isolated event store before F04' }
  })
}

export async function exerciseEvents({ ui, main, renderer, capture, appendExecution, lockHistory, lockEvents }) {
  let seed, first, second
  await ui.stage('events-5000-bounded-pagination', async () => {
    seed = await main.evaluate('globalThis.__ocSmokeControl.seedEvents()', 90_000)
    assert.equal(seed.count, 5000)
    assert.equal(seed.batches, 50)
    assert.ok(seed.retention.count >= 5003, 'F04 records must survive the F05 seed')
    assert.ok(seed.retention.diskBytes <= 20 * 1024 * 1024)
    await ui.navigate('事件', 'Events')
    await ui.click(action('latest'))
    first = await page(ui)
    assert.ok(first.includes(seed.validId) && first.includes(seed.obsoleteId) && first.includes(seed.nullId))
    const firstPage = await queryForRows(ui, main)
    await ui.click(action('next'))
    second = await page(ui)
    assert.equal(new Set([...first, ...second]).size, 100, 'stable cursor pages must not overlap')
    const nextPage = await queryForRows(ui, main)
    assert.equal(nextPage.query.before, firstPage.result.next)
    assert.equal(nextPage.query.upper, firstPage.result.upper)
    await ui.click(action('previous'))
    assert.deepEqual(await page(ui), first, 'previous must return the same page')
    await ui.click(action('refresh'))
    assert.deepEqual(await page(ui), first, 'same-page refresh must preserve the upper cursor')
    return { seed, mountedRows: 50, first: [first[0], first.at(-1)], second: [second[0], second.at(-1)] }
  })

  await ui.stage('events-source-type-time-and-clear', async () => {
    const before = (await ui.info()).eventQueries.total
    await source(ui, renderer, 'smoke-events-a')
    await select(ui, 'event-type-filter', 'execution-failed')
    await select(ui, 'event-range-filter', '1h')
    assert.equal((await ui.info()).eventQueries.total, before, 'draft editing must not query events')
    await ui.click(action('apply'))
    await page(ui)
    const filtered = await queryForRows(ui, main)
    assert.equal(filtered.query.sourceId, 'smoke-events-a')
    assert.equal(filtered.query.type, 'execution-failed')
    assert.equal(Date.parse(filtered.query.to) - Date.parse(filtered.query.from), 3_600_000)
    assert.ok(filtered.result.entries.every(entry => entry.sourceId === 'smoke-events-a' && entry.type === 'execution-failed' && entry.observedAt >= filtered.query.from && entry.observedAt <= filtered.query.to))
    assert.ok(filtered.result.entries.some(entry => entry.occurredAt < filtered.query.from), 'discovery-time filter must retain older occurrence times')
    await ui.dom('occurrence and discovery have separate labels', `Array.from(document.querySelectorAll('.event-metadata dt')).some(e => /发生时间|Occurred/.test(e.textContent)) && Array.from(document.querySelectorAll('.event-metadata dt')).some(e => /发现时间|Discovered/.test(e.textContent))`)
    await ui.click(action('next'))
    const saved = await page(ui)
    await ui.evaluate(`${$(ROWS)}.querySelector('[data-event-action="target"]').scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})`)
    await ui.frames()
    const savedScroll = await ui.evaluate(`${$('.main-content')}.scrollTop`)
    await ui.click(`${$(ROWS)}.querySelector('[data-event-action="target"]')`)
    await ui.dom('event target opens the exact synthetic task', `${$('#schedule-task-details[data-open="true"]')}?.dataset.jobId === ${JSON.stringify(seed.target.id)}`)
    await ui.dom('event target reads actual execution history', `${$('.schedule-history')}?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.schedule-history-list .schedule-execution-id').length === 25`)
    await ui.key('Escape', 'Escape', 27)
    await ui.navigate('事件', 'Events')
    assert.deepEqual(await page(ui), saved, 'returning from target must preserve filtered page')
    await ui.dom('returning from target restores event scroll', `Math.abs(${$('.main-content')}.scrollTop - ${savedScroll}) <= 1`)
    assert.deepEqual(await ui.evaluate(`[${$('#event-source-filter')}.value,${$('#event-type-filter')}.value,${$('#event-range-filter')}.value]`), ['smoke-events-a', 'execution-failed', '1h'])
    await source(ui, renderer, 'smoke-events-no-such-source')
    await ui.click(action('apply'))
    await page(ui, 0)
    await ui.dom('no matches differs from empty store', `/没有匹配的事件|No matching events/.test(${$('.event-empty')}?.textContent ?? '')`)
    await ui.click(action('clear'))
    assert.deepEqual(await page(ui), first)
    assert.deepEqual(await ui.evaluate(`[${$('#event-source-filter')}.value,${$('#event-type-filter')}.value,${$('#event-range-filter')}.value]`), ['', 'all', 'all'])
    for (const [range, duration] of [['24h', 86_400_000], ['7d', 604_800_000]]) {
      await select(ui, 'event-range-filter', range)
      await ui.click(action('apply'))
      await page(ui)
      const ranged = await queryForRows(ui, main)
      assert.equal(Date.parse(ranged.query.to) - Date.parse(ranged.query.from), duration)
      assert.ok(ranged.result.entries.every(entry => entry.observedAt >= ranged.query.from && entry.observedAt <= ranged.query.to))
    }
    await ui.click(action('clear'))
    assert.deepEqual(await page(ui), first)
    return { filters: filtered.query, realHistory: true, preservedPage: saved[0], cleared: true,
      selectInput: 'DOM option selection with input/change; native popup keyboard not exercised' }
  })

  await ui.stage('events-identity-and-background-new-record', async () => {
    await ui.dom('changed identity remains visible without navigation', `${$(row(seed.obsoleteId))}?.textContent.includes(${JSON.stringify(seed.target.id)}) && /身份已变化|different identity/.test(${`${$(row(seed.obsoleteId))}?.querySelector('.event-target-reason')?.textContent`} ?? '') && !${$(row(seed.obsoleteId))}?.querySelector('[data-event-action="target"]')`)
    await ui.dom('null targets never fabricate navigation', `/没有可导航目标|no navigation target/.test(${$(row(seed.nullId))}?.textContent ?? '') && !${$(row(seed.nullId))}?.querySelector('[data-event-action="target"]')`)
    await ui.click(action('next'))
    assert.deepEqual(await page(ui), second)
    await ui.click($('#event-source-filter'))
    // Dismiss native suggestions while keeping input focus, then move over the
    // scroller and commit its hit-test region before dispatching the real wheel.
    await ui.key('Escape', 'Escape', 27)
    await ui.frames()
    const geometry = await ui.evaluate(`(() => {
      const content = ${$('.main-content')}, r = content.getBoundingClientRect();
      const x = r.right - 40, y = r.top + r.height / 2;
      if (!content.contains(document.elementFromPoint(x, y)) || content.scrollHeight <= content.clientHeight)
        throw new Error('Event workspace must be scrollable and unobstructed');
      return { x, y, scroll: content.scrollTop };
    })()`)
    const point = { x: geometry.x, y: geometry.y }
    await renderer.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, RPC_MS)
    await ui.frames()
    await renderer.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 240 }, RPC_MS)
    await ui.dom('real wheel scroll moves event workspace', `${$('.main-content')}?.scrollTop > ${geometry.scroll}`)
    await ui.frames()
    const position = `(() => {
      const content = ${$('.main-content')}, bounds = content.getBoundingClientRect();
      const anchor = Array.from(document.querySelectorAll(${JSON.stringify(ROWS)})).find(element => {
        const rect = element.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
      return {ids:${idsExpression}, scroll:content.scrollTop, focus:document.activeElement?.id,
        anchor:anchor ? {id:anchor.dataset.eventId, top:anchor.getBoundingClientRect().top - bounds.top} : null};
    })()`
    const before = await ui.evaluate(position)
    assert.equal(before.focus, 'event-source-filter')
    const queryCount = (await ui.info()).eventQueries.total
    const appendedAt = await appendExecution()
    await renderer.evaluate('window.monitor.refresh("events")', 20_000)
    await ui.dom('new records are announced without replacing the page', `/有新记录|New records are available/.test(${$('.event-feedback')}?.textContent ?? '')`)
    await ui.frames()
    const after = await ui.evaluate(position)
    assert.deepEqual(after.ids, before.ids, 'background updates must preserve the current page')
    assert.equal(after.focus, before.focus, 'background updates must preserve input focus')
    assert.ok(before.anchor && after.anchor, 'a visible event row must anchor the scroll comparison')
    assert.equal(after.anchor.id, before.anchor.id, 'background updates must retain the same visible event')
    assert.ok(Math.abs(after.anchor.top - before.anchor.top) <= 1, `background updates moved the reading position: ${JSON.stringify({before, after})}`)
    assert.equal((await ui.info()).eventQueries.total, queryCount, 'background collection must not automatically query a replacement page')
    await ui.click(action('latest'))
    const latest = await page(ui)
    assert.notDeepEqual(latest, first)
    const actual = await queryForRows(ui, main)
    assert.ok(actual.result.entries.some(entry => entry.sourceId === 'hermes-events' && entry.entityId === seed.target.id && entry.occurredAt === appendedAt), 'latest must reveal the actual newly collected execution')
    return { backgroundPreserved: { before, after }, latest: latest[0], target: seed.target }
  })

  await ui.stage('events-real-ipc-failure-retry-and-cancellation', async () => {
    const original = await page(ui)
    let failure
    try {
      await main.evaluate('globalThis.__ocSmokeControl.faultEvents(true)', RPC_MS)
      await ui.click(action('next'))
      await ui.dom('actual missing events IPC handler is visible', `${$(ROOT)}?.getAttribute('aria-busy') === 'false' && ${$('.event-error')}?.textContent.includes('monitor:events')`)
      assert.deepEqual(await ui.evaluate(idsExpression), original, 'failed page request must preserve successful rows')
      await capture('events-real-ipc-failure')
      await main.evaluate('globalThis.__ocSmokeControl.faultEvents(false)', RPC_MS)
      await ui.click(action('retry'))
      const recovered = await page(ui)
      assert.notDeepEqual(recovered, original, 'retry must complete the failed next-page request')
      await ui.click(action('previous'))
      assert.deepEqual(await page(ui), original)
      await main.evaluate('globalThis.__ocSmokeControl.faultEvents(true)', RPC_MS)
      await ui.click(action('next'))
      await ui.dom('second next-page failure retains its error', `${$(ROOT)}?.getAttribute('aria-busy') === 'false' && ${$('.event-error')}?.textContent.includes('monitor:events')`)
      await main.evaluate('globalThis.__ocSmokeControl.faultEvents(false)', RPC_MS)
      await ui.navigate('本机概览', 'Overview')
      await ui.navigate('事件', 'Events')
      assert.deepEqual(await page(ui), original, 'reactivation must refresh the last successful page instead of replaying failed next')
      await ui.click(action('next'))
      assert.deepEqual(await page(ui), recovered, 'only an explicit next action may leave the restored successful page')
      await ui.click(action('previous'))
      assert.deepEqual(await page(ui), original)
    } catch (error) { failure = error; throw error }
    finally {
      try { await main.evaluate('globalThis.__ocSmokeControl.faultEvents(false)', RPC_MS) }
      catch (error) { throw new AggregateError([failure, error].filter(Boolean), 'Events IPC handler restoration failed') }
    }
    await ui.click($('#event-source-filter'))
    const pausePoint = await ui.evaluate(`(() => {
      const button = ${$('.page-actions button[aria-pressed]')}, rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !button.contains(document.elementFromPoint(x, y)))
        throw new Error('Pause button must be visible before starting the bounded query');
      return {x, y};
    })()`)
    const before = (await ui.info()).eventQueries
    const release = await lockEvents()
    let cancellationFailure, pending, cancelled, pauseDispatchMs
    try {
      pending = renderer.evaluate('window.monitor.events().then(() => ({rejected:false}), error => ({rejected:true,error:String(error)}))', RPC_MS)
        .then(value => ({ value }), error => ({ protocolError: error }))
      await ui.expect('event store admits the real query before cancellation', async () => (await ui.info()).eventQueries.active === 1, 2_000)
      await ui.evaluate('window.monitor.cancelEvents(); true')
      const outcome = await pending
      if (outcome.protocolError) throw outcome.protocolError
      cancelled = outcome.value
      assert.equal(cancelled.rejected, true, 'actual event request must reject when cancelled')
      await ui.expect('real events IPC cancellation drains', async () => {
        const info = await ui.info()
        return info.eventQueries.active === 0 && info.eventQueries.cancelled > before.cancelled
      }, 2_000)
      const afterDirect = (await ui.info()).eventQueries.cancelled
      const began = performance.now()
      await ui.click(action('refresh'))
      await ui.expect('UI refresh admits a real events query', async () => (await ui.info()).eventQueries.active === 1, 2_000)
      // Its header position is stable during list reads. Avoid scrolling/assertion round trips
      // after admission: SQLite deliberately rejects a lock after only 500 ms.
      await renderer.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...pausePoint, button: 'left', clickCount: 1 }, RPC_MS)
      await renderer.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pausePoint, button: 'left', clickCount: 1 }, RPC_MS)
      pauseDispatchMs = performance.now() - began
      await ui.dom('real pause click freezes display', `${$('.page-actions button[aria-pressed]')}?.getAttribute('aria-pressed') === 'true'`)
      await ui.expect('UI pause cancels and drains its real event query', async () => {
        const info = await ui.info()
        return info.eventQueries.active === 0 && info.eventQueries.cancelled > afterDirect &&
          info.resources.sources.filter(item => item.source === 'event-store').every(item => Object.values(item.current).every(value => value === 0))
      }, 2_000)
      assert.deepEqual(await ui.evaluate(idsExpression), original, 'UI cancellation must preserve its successful page')
    } catch (error) { cancellationFailure = error; throw error }
    finally {
      const cleanup = await Promise.allSettled([ui.evaluate('window.monitor.cancelEvents(); true'), release()])
      if (pending) {
        const outcome = await pending
        if (outcome.protocolError) cleanup.push({ status: 'rejected', reason: outcome.protocolError })
      }
      const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError([cancellationFailure, ...errors].filter(Boolean), 'Event cancellation/lock cleanup failed')
    }
    await ui.click($('.page-actions button[aria-pressed]'))
    await ui.dom('resuming events allows requests again', `${action('refresh')}?.getAttribute('aria-disabled') === 'false'`)
    await ui.click(action('refresh'))
    assert.deepEqual(await page(ui), original, 'UI must successfully query again after pause cancellation and lock release')
    return { channel: 'monitor:events', restored: true, cancellation: cancelled, uiCancellationRecovered: true, pauseDispatchMs }
  })

  await ui.stage('events-pause-disable-and-coverage', async () => {
    const original = await page(ui)
    await ui.click($('.page-actions button[aria-pressed]'))
    await ui.dom('paused events retain rows and disable querying', `/显示已暂停|Display paused/.test(${$('.event-feedback')}?.textContent ?? '') && ${action('refresh')}?.getAttribute('aria-disabled') === 'true'`)
    const pausedCount = (await ui.info()).eventQueries.total
    await ui.frames()
    assert.deepEqual(await ui.evaluate(idsExpression), original)
    assert.equal((await ui.info()).eventQueries.total, pausedCount)
    await ui.click($('.page-actions button[aria-pressed]'))
    await page(ui)
    await ui.navigate('数据来源', 'Data sources')
    await ui.click($('[data-source-section="events"] [role="switch"]'))
    await ui.dom('event collection switch disabled', `${$('[data-source-section="events"] [role="switch"]')}?.getAttribute('aria-checked') === 'false'`)
    await ui.navigate('事件', 'Events')
    await ui.dom('disabled events explicitly retain last page', `/本地事件已停用|Local events are disabled/.test(${$('.event-feedback')}?.textContent ?? '') && ${action('refresh')}?.getAttribute('aria-disabled') === 'true'`)
    assert.deepEqual(await ui.evaluate(idsExpression), original)
    assert.equal(await ui.evaluate('window.monitor.events().then(() => false, () => true)'), true)
    await ui.expect('disabled events release all resources', async () => {
      const info = await ui.info()
      return info.eventQueries.active === 0 && info.resources.sources.filter(item => ['event-store', 'hermes-events'].includes(item.source)).every(item => Object.values(item.current).every(value => value === 0))
    })
    await ui.navigate('数据来源', 'Data sources')
    await ui.click($('[data-source-section="events"] [role="switch"]'))
    await ui.dom('event collection switch enabled', `${$('[data-source-section="events"] [role="switch"]')}?.getAttribute('aria-checked') === 'true'`)
    await ui.navigate('事件', 'Events')
    await page(ui)
    const release = await lockHistory()
    let coverageFailure
    try {
      await renderer.evaluate('window.monitor.refresh("events")', 20_000)
      const snapshot = await ui.evaluate('window.monitor.snapshot()')
      assert.ok(snapshot.events.data.coverage.some(item => item.sourceId === 'hermes-events' && item.state === 'unavailable' && item.lastGap), 'real locked history must produce unavailable coverage and a persistent gap')
      await ui.click(action('refresh'))
      await page(ui)
      await ui.click($('.event-coverage summary'))
      await ui.dom('coverage gap and retention deletion range are rendered', `${$('.event-coverage')}.open && !!${$('.event-gap')} && !!${$('[data-coverage-state="unavailable"]')} && /删除截至发现时间|Deleted through discovery time/.test(${$('.event-retention-metadata')}.textContent)`)
    } catch (error) { coverageFailure = error; throw error }
    finally {
      try { await release() } catch (error) { throw new AggregateError([coverageFailure, error].filter(Boolean), 'Event coverage lock release failed') }
    }
    await renderer.evaluate('window.monitor.refresh("events")', 20_000)
    await ui.click(action('refresh'))
    await page(ui)
    await ui.dom('restored observation retains historical gap disclosure', `!!${$('[data-coverage-state="observing"]')} && !!${$('.event-gap')}`)
    return { pauseRetained: true, disabledRetained: true, coverage: 'real SQLite lock -> unavailable -> observing with lastGap' }
  })

  await ui.stage('events-responsive-long-metadata-and-text-scale', async () => {
    await ui.click(action('latest'))
    await page(ui)
    const originalScale = await ui.evaluate(`document.documentElement.style.getPropertyValue('--font-scale')`)
    const originalMetrics = await ui.evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})')
    const baseFont = await ui.evaluate(`parseFloat(getComputedStyle(${$(`${row(seed.validId)} .event-row-heading h3`)}).fontSize)`)
    const results = []
    let failure
    try {
      for (const [width, height, scale] of [[1280, 860, 1], [880, 640, 1], [880, 640, 2]]) {
        await renderer.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, RPC_MS)
        await ui.evaluate(`document.documentElement.style.setProperty('--font-scale', ${JSON.stringify(String(scale))})`)
        await ui.frames()
        await ui.click($('#event-source-filter'))
        await ui.frames()
        const geometry = await ui.evaluate(`(() => {
          const root = ${$(ROOT)}, content = ${$('.main-content')};
          const elements = Array.from(root.querySelectorAll('input,select,button,.event-id'));
          return {width:innerWidth, height:innerHeight, rootWidth:root.clientWidth, rootScroll:root.scrollWidth,
            contentWidth:content.clientWidth, contentScroll:content.scrollWidth, rows:root.querySelectorAll('li[data-event-id]').length,
            font:parseFloat(getComputedStyle(${$(`${row(seed.validId)} .event-row-heading h3`)}).fontSize),
            overflow:elements.filter(e => { const r=e.getBoundingClientRect(), p=root.getBoundingClientRect(); return r.left < p.left-1 || r.right > p.right+1; }).map(e=>({tag:e.tagName,id:e.id,class:e.className})).slice(0,12)};
        })()`)
        assert.equal(geometry.width, width, 'viewport must be actual CSS pixels')
        assert.equal(geometry.height, height, 'viewport height must be actual CSS pixels')
        assert.equal(geometry.rows, 50)
        assert.ok(geometry.rootScroll <= geometry.rootWidth + 1 && geometry.contentScroll <= geometry.contentWidth + 1, 'events must not create horizontal workspace overflow')
        assert.deepEqual(geometry.overflow, [], 'long identifiers and controls must stay inside the event view')
        assert.ok(Math.abs(geometry.font - baseFont * scale) < 0.5, '200% must actually double event text')
        results.push({ width, scale, ...geometry })
        if (width === 1280 || scale === 2) await capture(`events-${width}-text-${scale * 100}`)
      }
    } catch (error) { failure = error; throw error }
    finally {
      const errors = []
      try { await ui.evaluate(`document.documentElement.style.setProperty('--font-scale', ${JSON.stringify(originalScale)})`) } catch (error) { errors.push(error) }
      try { await renderer.call('Emulation.setDeviceMetricsOverride', { ...originalMetrics, mobile: false }, RPC_MS) } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError([failure, ...errors].filter(Boolean), 'Event viewport/scale restoration failed')
    }
    return { results, nativeWindowAcceptance: false }
  })
}
