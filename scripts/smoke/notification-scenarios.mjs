import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RPC_MS = 5_000
const ROOT = '#setting-notifications'
const DRAWER = '#schedule-task-details[data-open="true"]'
const SWITCH = `${ROOT} [role="switch"]`
const TYPE_GROUP = `${ROOT} fieldset[aria-describedby="notification-types-help"]`
const SOURCE_GROUP = `${ROOT} fieldset[aria-describedby="notification-sources-help"]`
const TIME_START = `${ROOT} .notification-times label:first-child input`
const TIME_END = `${ROOT} .notification-times label:nth-child(2) input`
const TIME_SAVE = `${ROOT} .notification-times button[type="submit"]`
const $ = selector => `document.querySelector(${JSON.stringify(selector)})`
const snapshot = ui => ui.evaluate('window.desktopSettings.snapshot()')
const quietToggle = `Array.from(document.querySelectorAll(${JSON.stringify(`${ROOT} fieldset`)})).find(element => element.querySelector('.notification-times'))?.querySelector('input[type="checkbox"]')`
const namesToggle = `${$(ROOT)}?.querySelector('fieldset:last-of-type input[type="checkbox"]')`

async function settled(ui, check = 'true') {
  return ui.dom('notification preference save settles through real IPC', `window.desktopSettings.snapshot().then(value => {
    const busy = document.querySelector('.settings-list')?.getAttribute('aria-busy') ?? document.querySelector('.task-notification-subscription')?.getAttribute('aria-busy');
    return busy === 'false' && !document.querySelector('.settings-save-error') && (${check}) ? value : false;
  })`)
}

async function phase(ui, expected) {
  return ui.dom(`notification phase is ${expected} in IPC and UI`, `window.desktopSettings.snapshot().then(value =>
    value.notifications.phase === ${JSON.stringify(expected)} && ${$(`${ROOT} .notification-status`)}?.dataset.phase === ${JSON.stringify(expected)} ? value : false)`)
}

async function language(ui, value) {
  await ui.navigate('设置', 'Settings')
  const input = $(`input[name="language"][value=${JSON.stringify(value)}]`)
  if (!(await ui.evaluate(`${input}?.checked`))) await ui.click(input)
  await settled(ui, `value.settings.language === ${JSON.stringify(value)} && value.resolvedLanguage === ${JSON.stringify(value)}`)
  await ui.dom('document language reflects real persisted preference', `document.documentElement.lang === ${JSON.stringify(value)}`)
}

// Native time fields have platform-specific segmented keyboard input. Use the DOM
// value setter plus input/change, retain React and real IPC, and label this evidence.
async function draftTime(ui, selector, value) {
  await ui.click($(selector))
  await ui.evaluate(`(() => {
    const input = ${$(selector)};
    if (!(input instanceof HTMLInputElement) || input.type !== 'time' || input.readOnly) throw new Error('Editable native time input required');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', {bubbles:true}));
    input.dispatchEvent(new Event('change', {bubbles:true}));
    return true;
  })()`)
  await ui.dom('time draft is rendered by React', `${$(selector)}?.value === ${JSON.stringify(value)}`)
  await ui.frames()
}

async function persistedNotifications(ui) {
  const { userData } = await ui.info()
  assert.ok(path.isAbsolute(userData) && path.basename(userData) === 'user-data', 'isolated smoke user-data is required')
  assert.equal(path.basename(path.dirname(path.dirname(userData))), '.dev-instances', 'never read installed application preferences')
  const file = await open(path.join(userData, 'settings.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    assert.ok(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= 128 * 1024, 'persisted settings must be a bounded regular file')
    const bytes = Buffer.alloc(before.size + 1)
    let count = 0
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, count)
      if (!bytesRead) break
      count += bytesRead
    }
    assert.equal(count, before.size, 'settings file must not change size while read')
    const after = await file.stat()
    assert.equal(after.mtimeMs, before.mtimeMs, 'settings file must remain stable while read')
    return JSON.parse(bytes.subarray(0, count).toString('utf8')).notifications
  } finally { await file.close() }
}

async function withSettingsWriteDenied(ui, action) {
  assert.equal(typeof process.getuid, 'function', 'settings permission fault requires POSIX ownership')
  assert.notEqual(process.getuid(), 0, 'root bypasses directory write restrictions; this fault cannot run as root')
  const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)))
  const instances = path.join(repository, '.dev-instances')
  const { userData } = await ui.info()
  const instance = path.dirname(userData)
  assert.equal(path.dirname(instance), instances, 'permission fault is restricted to this repository’s disposable instances')
  assert.match(path.basename(instance), /^instance-[\w-]+$/)
  assert.equal(path.basename(userData), 'user-data')
  for (const directory of [instances, instance, userData]) {
    assert.equal(await realpath(directory), directory, 'fault ancestors must be canonical and contain no symbolic links')
    const stat = await lstat(directory)
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'fault directories must belong to the current user')
  }
  const directory = await open(userData, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let original, mode, restore = false, result, failure
  try {
    original = await directory.stat()
    mode = original.mode & 0o7777
    const current = await lstat(userData)
    assert.ok(original.isDirectory() && original.uid === process.getuid() && current.ino === original.ino && current.dev === original.dev, 'held directory descriptor must match the validated owned profile')
    assert.equal(mode & 0o700, 0o700, 'profile must originally permit owner read/write/search')
    restore = true
    await directory.chmod(0o500)
    assert.equal((await directory.stat()).mode & 0o777, 0o500)
    result = await action()
  } catch (error) { failure = error }
  finally {
    const errors = []
    if (restore) {
      try {
        await directory.chmod(mode)
        assert.equal((await directory.stat()).mode & 0o7777, mode, 'original user-data permissions must be restored exactly')
        const restored = await lstat(userData)
        assert.ok(restored.isDirectory() && !restored.isSymbolicLink() && restored.ino === original.ino && restored.dev === original.dev, 'profile identity must survive the permission fault')
      } catch (error) { errors.push(error) }
    }
    try { await directory.close() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError([failure, ...errors].filter(Boolean), 'Owned settings directory permission restoration failed')
  }
  if (failure) throw failure
  return result
}

async function responsive(ui, renderer, locale) {
  const originalScale = await ui.evaluate("document.documentElement.style.getPropertyValue('--font-scale')")
  const metrics = await ui.evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})')
  const results = []
  let failure
  try {
    return await ui.stage(`notifications-responsive-${locale}`, async () => {
    await language(ui, locale)
    await ui.evaluate("document.documentElement.style.setProperty('--font-scale','1')")
    const base = await ui.evaluate(`parseFloat(getComputedStyle(${$('#notification-help')}).fontSize)`)
    for (const [width, height, scale] of [[1280, 860, 1], [880, 640, 1], [1280, 860, 2], [880, 640, 2]]) {
      await renderer.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, RPC_MS)
      await ui.evaluate(`document.documentElement.style.setProperty('--font-scale', ${JSON.stringify(String(scale))})`)
      await ui.frames()
      await ui.click($(TIME_START))
      await ui.dom('time field is focusable at this size', `document.activeElement === ${$(TIME_START)}`)
      const result = await ui.evaluate(`(() => {
        const root = ${$(ROOT)}, content = ${$('.main-content')}, bounds = root.getBoundingClientRect();
        return {width:innerWidth,height:innerHeight,scale:${scale},language:document.documentElement.lang,
          rootWidth:root.clientWidth,rootScroll:root.scrollWidth,contentWidth:content.clientWidth,contentScroll:content.scrollWidth,
          font:parseFloat(getComputedStyle(${$('#notification-help')}).fontSize),
          overflow:Array.from(root.querySelectorAll('input,button,code,fieldset')).filter(element => {
            const r=element.getBoundingClientRect(); return r.left<bounds.left-1 || r.right>bounds.right+1;
          }).map(element=>({tag:element.tagName,id:element.id,class:element.className})).slice(0,12)};
      })()`)
      assert.equal(result.width, width)
      assert.equal(result.height, height)
      assert.equal(result.language, locale)
      assert.ok(result.rootScroll <= result.rootWidth + 1 && result.contentScroll <= result.contentWidth + 1, 'notification settings must not create horizontal workspace overflow')
      assert.deepEqual(result.overflow, [], 'all notification controls must remain within the settings row')
      assert.ok(Math.abs(result.font - base * scale) < 0.5, '200% must actually double notification helper text')
      // Scroll the last control into view too; short viewport height must not hide it.
      await ui.evaluate(`(${namesToggle}).scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})`)
      await ui.frames()
      assert.equal(await ui.evaluate(`(() => { const input=${namesToggle}, r=input.getBoundingClientRect(); const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2); return r.top>=0 && r.bottom<=innerHeight && (hit===input || input.contains(hit)); })()`), true, 'privacy opt-in remains reachable below the fold')
      results.push(result)
    }
      return { geometry: results, viewportEvidence: 'CDP CSS viewport and --font-scale 200%; not native window/fullscreen acceptance' }
    })
  } catch (error) { failure = error; throw error }
  finally {
    const cleanup = await Promise.allSettled([
      ui.evaluate(`document.documentElement.style.setProperty('--font-scale', ${JSON.stringify(originalScale)})`),
      renderer.call('Emulation.setDeviceMetricsOverride', { ...metrics, mobile: false }, RPC_MS)
    ])
    const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError([failure, ...errors].filter(Boolean), 'Notification viewport/text-scale restoration failed')
  }
}

export async function exerciseNotifications({ ui, main, renderer, capture, manifest }) {
  let expected, original, target, failure
  const limitations = {
    nativeWindowAcceptance: false,
    operatingSystemNotificationDelivery: 'not exercised: real headless adapter must report unsupported',
    saveFailureRetryFocus: 'pending real owned-directory permission fault',
    timeInput: 'DOM native value setter with input/change; no bridge replacement or native segmented-input claim'
  }
  try {
    await ui.stage('notifications-default-off', async () => {
      await ui.dom('real desktop APIs are ready', '!!window.desktopSettings && !!window.monitor && !!document.querySelector(".app-shell")')
      await ui.info()
      await ui.navigate('设置', 'Settings')
      original = await settled(ui)
      expected = {
        enabled: false, sourceIds: [], tasks: [],
        types: ['execution-failed', 'delivery-failed', 'source-unavailable', 'source-recovered'],
        quiet: { enabled: false, startMinute: 1320, endMinute: 480 }, showTaskNames: false
      }
      assert.deepEqual(original.settings.notifications, expected, 'fresh isolated preferences must have safe notification defaults')
      assert.equal(original.settings.plugins.events, true, 'event collection begins enabled independently of notifications')
      await phase(ui, 'off')
      await ui.dom('default switch is visibly off', `${$(SWITCH)}?.getAttribute('aria-checked') === 'false'`)
      assert.equal(await ui.evaluate(`(${namesToggle}).checked`), false)
      return { defaults: expected, ...limitations }
    })

    await ui.stage('notifications-hermes-task-subscription', async () => {
      const job = await ui.expect('real fixture Hermes schedule is collected', () => ui.evaluate(`window.monitor.snapshot().then(value => value.schedules.data?.jobs.find(job => ${JSON.stringify(manifest.hermesJobIds)}.includes(job.id)) ?? false)`), 35_000)
      assert.ok(manifest.hermesJobIds.includes(job.id) && job.id.startsWith('hermes-job:'))
      target = { kind: 'schedule', id: job.id, identity: JSON.stringify([job.source, job.scope, job.file ?? null, job.executable ?? null]) }
      await ui.navigate('定时任务', 'Scheduled tasks')
      if (await ui.evaluate(`!!${$(DRAWER)}`)) {
        await ui.key('Escape', 'Escape', 27)
        await ui.dom('previous task details close before subscription scenario', `!${$(DRAWER)}`)
      }
      // Earlier history scenarios intentionally leave their schedule search in view memory.
      const clearFilters = $('.schedule-result-summary .text-button')
      if (await ui.evaluate(`!!${clearFilters}`)) await ui.click(clearFilters)
      await ui.dom('subscription starts without inherited task filters', `!${clearFilters} && ${$('.schedule-toolbar .search-field input')}?.value === ''`)
      await ui.dom('subscription scenario includes launchd tasks after clearing filters', `!!${$('.schedule-panel [data-job-id^="launchd:"]')}`)
      const taskRow = $(`.schedule-panel [data-job-id=${JSON.stringify(job.id)}] button`)
      await ui.click(taskRow)
      await ui.dom('subscription is attached to exact task details', `${$(DRAWER)}?.dataset.jobId === ${JSON.stringify(job.id)} && !!${$('.task-notification-subscription button[aria-pressed]')}`)
      const subscription = $('.task-notification-subscription button[aria-pressed]')
      await ui.click(subscription)
      await settled(ui, `value.settings.notifications.tasks.some(task => task.id === ${JSON.stringify(target.id)} && task.identity === ${JSON.stringify(target.identity)})`)
      await ui.dom('subscribing does not enable global notifications', `${subscription}?.getAttribute('aria-pressed') === 'true' && /全局通知关闭|global notifications are off/.test(${$('.task-notification-subscription')}?.textContent ?? '')`)
      assert.equal((await snapshot(ui)).settings.notifications.enabled, false)
      await ui.key(' ', 'Space', 32)
      await settled(ui, 'value.settings.notifications.tasks.length === 0')
      await ui.dom('keyboard unsubscribe retains button focus', `document.activeElement === ${subscription} && ${subscription}?.getAttribute('aria-pressed') === 'false'`)
      await ui.key(' ', 'Space', 32)
      await settled(ui, 'value.settings.notifications.tasks.length === 1')
      assert.deepEqual((await snapshot(ui)).settings.notifications.tasks, [target])
      await ui.key('Escape', 'Escape', 27)
      await ui.dom('task drawer closes', `${$('#schedule-task-details')}?.dataset.open === 'false'`)
      const unsupportedId = await ui.evaluate(`${$('.schedule-panel [data-job-id^="launchd:"]')}?.dataset.jobId`)
      assert.ok(unsupportedId, 'fixture must include a launchd schedule to check unsupported subscription')
      await ui.click($(`.schedule-panel [data-job-id=${JSON.stringify(unsupportedId)}] button`))
      await ui.dom('launchd cannot subscribe to execution events', `${$(DRAWER)}?.dataset.jobId === ${JSON.stringify(unsupportedId)} && ${subscription}?.getAttribute('aria-disabled') === 'true' && /不提供真实的逐次执行事件|does not supply actual per-run events/.test(${$('.task-notification-subscription')}?.textContent ?? '')`)
      await ui.key('Escape', 'Escape', 27)
      await ui.navigate('设置', 'Settings')
      const redacted = await ui.evaluate(`${$(`${ROOT} .notification-task-list`)}.textContent`)
      assert.ok(redacted.includes('ID · ') && !redacted.includes(job.id) && !redacted.includes(target.identity) && !redacted.includes(job.name), 'settings subscription list must show only an opaque task alias')
      return { task: target, taskNameExposed: false, autoEnabled: false, unsupportedId, keyboardUnsubscribeResubscribe: true }
    })

    await ui.stage('notifications-source-types-and-quiet-drafts', async () => {
      const source = await ui.expect('Hermes event source is collected', () => ui.evaluate('window.monitor.snapshot().then(value => value.events.data?.sources.find(source => source.id === "hermes-events") ?? false)'), 35_000)
      await ui.dom('collection-wide failures are subscribable and non-event storage rows are excluded', `${$(`${SOURCE_GROUP} input[value="collection:agents"]`)} && ${$(`${SOURCE_GROUP} input[value="collection:schedules"]`)} && ${$(`${SOURCE_GROUP} input[value="collection:system"]`)} && !${$(`${SOURCE_GROUP} input[value="event-store"]`)} && !${$(`${SOURCE_GROUP} input[value="source-events"]`)}`)
      await ui.click($(`${SOURCE_GROUP} input[value="collection:schedules"]`))
      await settled(ui, 'value.settings.notifications.sourceIds.includes("collection:schedules")')
      await ui.key(' ', 'Space', 32)
      await settled(ui, 'value.settings.notifications.sourceIds.length === 0')
      const sourceInput = `Array.from(document.querySelectorAll(${JSON.stringify(`${SOURCE_GROUP} label`)})).find(element => element.querySelector('span')?.firstChild?.textContent === ${JSON.stringify(source.label)})?.querySelector('input')`
      await ui.click(sourceInput)
      await settled(ui, 'value.settings.notifications.sourceIds.includes("hermes-events")')
      await ui.click(`document.querySelectorAll(${JSON.stringify(`${TYPE_GROUP} input`)})[1]`)
      await settled(ui, '!value.settings.notifications.types.includes("delivery-failed")')
      await ui.click(quietToggle)
      await settled(ui, 'value.settings.notifications.quiet.enabled')
      const saved = (await snapshot(ui)).settings.notifications
      await draftTime(ui, TIME_START, '')
      assert.deepEqual((await snapshot(ui)).settings.notifications, saved, 'incomplete time input must stay local')
      await ui.click($(TIME_SAVE))
      await ui.dom('incomplete time has a visible validation error', `/HH:mm/.test(${$('#notification-time-error')}?.textContent ?? '') && ${$(TIME_START)}?.getAttribute('aria-invalid') === 'true'`)
      assert.deepEqual((await snapshot(ui)).settings.notifications, saved, 'invalid time submission must not reach persistence')
      await draftTime(ui, TIME_START, '12:00')
      await draftTime(ui, TIME_END, '12:00')
      await ui.click($(TIME_SAVE))
      await ui.dom('equal quiet times produce an explicit error without losing focus', `/不能相同|must differ/.test(${$('#notification-time-error')}?.textContent ?? '') && document.activeElement === ${$(TIME_SAVE)}`)
      assert.deepEqual((await snapshot(ui)).settings.notifications, saved)
      await capture('notifications-quiet-equal-error')
      await draftTime(ui, TIME_START, '22:45')
      await draftTime(ui, TIME_END, '07:15')
      assert.deepEqual((await snapshot(ui)).settings.notifications, saved, 'valid draft is not saved before explicit submit')
      await ui.click($(TIME_SAVE))
      await settled(ui, 'value.settings.notifications.quiet.startMinute === 1365 && value.settings.notifications.quiet.endMinute === 435')
      await ui.dom('saved quiet time clears validation and retains submit focus', `!${$('#notification-time-error')}?.textContent && document.activeElement === ${$(TIME_SAVE)}`)
      await ui.click(namesToggle)
      await settled(ui, 'value.settings.notifications.showTaskNames')
      await ui.key(' ', 'Space', 32)
      await settled(ui, '!value.settings.notifications.showTaskNames')
      expected = (await snapshot(ui)).settings.notifications
      assert.deepEqual(expected.tasks, [target])
      assert.deepEqual(expected.sourceIds, ['hermes-events'])
      assert.deepEqual(expected.types, ['execution-failed', 'source-unavailable', 'source-recovered'])
      assert.deepEqual(expected.quiet, { enabled: true, startMinute: 1365, endMinute: 435 })
      assert.equal(expected.enabled, false)
      assert.deepEqual(await persistedNotifications(ui), expected, 'cross-midnight subscriptions and quiet hours must be written to actual settings.json')
      return { expected, invalidDraftPersisted: false, equalTimesRejected: true, explicitSaveFocusRetained: true, ...limitations }
    })

    await ui.stage('notifications-real-save-failure-and-focus-retry', async () => {
      const before = (await snapshot(ui)).settings.notifications
      assert.equal(before.enabled, false, 'permission fault must never enable notifications')
      await withSettingsWriteDenied(ui, async () => {
        await ui.click(namesToggle)
        await ui.dom('real settings write denial renders SettingsSaveError', `${$(`${ROOT} .settings-save-error`)} && ${$('.settings-list')}?.getAttribute('aria-busy') === 'false' && /拒绝了对设置路径的访问|denied access to the settings path/.test(${$(`${ROOT} .settings-save-error`)}.textContent)`)
        assert.deepEqual((await snapshot(ui)).settings.notifications, before, 'real persistence failure must roll back the complete notification object')
        assert.deepEqual(await persistedNotifications(ui), before, 'denied atomic write leaves the old settings file intact')
        await ui.dom('failed save keeps original opt-in focus and actual unchecked state', `document.activeElement === (${namesToggle}) && !(${namesToggle}).checked`)
        await capture('notifications-settings-permission-denied')
      })
      await ui.click($(`${ROOT} .settings-save-error-retry`))
      const retried = await settled(ui, 'value.settings.notifications.showTaskNames')
      await ui.frames()
      await ui.dom('successful retry returns focus to the initiating checkbox', `document.activeElement === (${namesToggle}) && (${namesToggle}).checked`)
      assert.deepEqual(await persistedNotifications(ui), retried.settings.notifications, 'retry must persist via the restored real directory')
      await ui.key(' ', 'Space', 32)
      await settled(ui, '!value.settings.notifications.showTaskNames')
      assert.deepEqual((await snapshot(ui)).settings.notifications, expected, 'privacy opt-in is restored to off after fault exercise')
      limitations.saveFailureRetryFocus = 'passed real owned-profile chmod 0500 write denial, exact mode restoration, UI retry and original checkbox focus'
      return { fault: 'real owned-profile directory chmod 0500', restored: true, rollback: true, retryPersisted: true, originalFocusRestored: true }
    })

    await ui.stage('notifications-headless-and-plugin-lifecycle', async () => {
      await ui.click($(SWITCH))
      const enabled = await phase(ui, 'unavailable')
      assert.equal(enabled.notifications.permission, 'unsupported', 'real headless adapter must never claim OS permission success')
      await settled(ui, 'value.settings.notifications.enabled')
      await ui.dom('unsupported permission is explicit and request is blocked', `/不支持|Unsupported/.test(${$(ROOT)}.textContent) && ${$(`${ROOT} .notification-actions button`)}?.getAttribute('aria-disabled') === 'true'`)
      await renderer.evaluate('window.monitor.refresh("events")', 20_000)
      const events = await ui.evaluate('window.monitor.events()')
      assert.ok(Array.isArray(events.entries) && events.retention && Array.isArray(events.coverage), 'notification unavailability must not break the real event reader')
      const collected = await ui.evaluate('window.monitor.snapshot()')
      assert.equal(collected.events.error, null)
      assert.ok(collected.events.data)
      await ui.dom('global switch retains focus after enable', `document.activeElement === ${$(SWITCH)}`)
      await ui.key(' ', 'Space', 32)
      await phase(ui, 'off')
      await settled(ui, '!value.settings.notifications.enabled')
      await ui.key(' ', 'Space', 32)
      await phase(ui, 'unavailable')
      await settled(ui, 'value.settings.notifications.enabled')
      await ui.navigate('数据来源', 'Data sources')
      await ui.click($('[data-source-section="events"] [role="switch"]'))
      await ui.dom('event plugin is actually disabled', 'window.desktopSettings.snapshot().then(value => !value.settings.plugins.events && value.notifications.phase === "events-disabled")')
      await ui.navigate('设置', 'Settings')
      await phase(ui, 'events-disabled')
      assert.equal((await snapshot(ui)).settings.notifications.enabled, true, 'plugin disabling preserves notification preference')
      await ui.click($(SWITCH))
      await phase(ui, 'off')
      await settled(ui, '!value.settings.notifications.enabled')
      await ui.navigate('数据来源', 'Data sources')
      await ui.click($('[data-source-section="events"] [role="switch"]'))
      await ui.dom('event collection is restored', 'window.desktopSettings.snapshot().then(value => value.settings.plugins.events && value.notifications.phase === "off")')
      await ui.navigate('设置', 'Settings')
      await phase(ui, 'off')
      assert.deepEqual((await snapshot(ui)).settings.notifications, expected, 'enable/disable cycles preserve subscriptions and quiet settings')
      await ui.info()
      return { permission: enabled.notifications.permission, phases: ['unavailable', 'off', 'unavailable', 'events-disabled', 'off'], eventsReadable: true, nativeWindowAcceptance: false }
    })

    for (const locale of ['zh-CN', 'en']) await responsive(ui, renderer, locale)

    await ui.stage('notifications-retained-preferences-for-restart', async () => {
      await language(ui, 'zh-CN')
      await settled(ui, '!value.settings.notifications.enabled && value.settings.plugins.events')
      await phase(ui, 'off')
      assert.deepEqual((await snapshot(ui)).settings.notifications, expected)
      assert.deepEqual(await persistedNotifications(ui), expected)
      await ui.evaluate(`${$(SWITCH)}.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})`)
      await ui.info()
      return { expectedNotifications: expected, eventCollectionEnabled: true, restartAcceptance: 'performed separately by caller', ...limitations }
    })
    return expected
  } catch (error) { failure = error; throw error }
  finally {
    if (failure) {
      // Failure cleanup uses the real settings IPC, never a fake business bridge.
      // The isolated instance must not remain notification-enabled after an assertion.
      try {
        const result = await ui.evaluate(`window.desktopSettings.snapshot().then(value => window.desktopSettings.update({notifications:{...value.settings.notifications,enabled:false},plugins:{events:true}}))`)
        assert.equal(result.ok, true, 'failed notification smoke cleanup must save the safe disabled state')
      } catch (cleanupError) { throw new AggregateError([failure, cleanupError], 'Notification smoke failure and safe-state restoration failed') }
    }
  }
}
