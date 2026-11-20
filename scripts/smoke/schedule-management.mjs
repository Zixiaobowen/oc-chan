import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { boundedFile } from './main-probe.mjs'

const FORM = '[data-schedule-create-form]'
const SEARCH = '.schedule-toolbar input'
const RESULT = '[data-schedule-write-status="success"]'
const JOB_BYTES = 1024 * 1024
const select = selector => `document.querySelector(${JSON.stringify(selector)})`
const action = name => select(`[data-schedule-action="${name}"]`)

export async function prepareScheduleManagement(home, launcher) {
  const bin = path.join(home, '.local/bin')
  const root = path.join(home, '.hermes')
  const alternate = path.join(root, 'profiles/smoke-other/cron')
  await mkdir(bin, { recursive: true })
  await mkdir(alternate, { recursive: true })
  await symlink(launcher, path.join(bin, 'hermes'))
  const alternateJobs = path.join(alternate, 'jobs.json')
  await writeFile(alternateJobs, '{"jobs":[]}\n', { flag: 'wx', mode: 0o600 })
  await writeFile(path.join(root, 'active_profile'), 'smoke-other\n', { flag: 'wx', mode: 0o600 })
  return { jobs: path.join(root, 'cron/jobs.json'), alternateJobs }
}

export async function exerciseScheduleManagement({ ui, renderer, stores, capture }) {
  await ui.navigate('定时任务', 'Scheduled tasks')
  await ui.stage('schedule-management', async () => {
    const name = 'OC Chan 隔离验收任务'
    const schedule = '0 3 1 1 *'
    const prompt = 'Print the isolated smoke marker.'
    const nameInput = `${FORM} input[name="name"]`
    const scheduleInput = `${FORM} input[name="schedule"]`
    const instructionInput = `${FORM} textarea[name="prompt"]`
    const readJobs = async () => JSON.parse((await boundedFile(stores.jobs, JOB_BYTES)).toString('utf8')).jobs
    async function fill(selector, value) {
      await ui.click(select(selector))
      await renderer.selectAll()
      if (value) await renderer.text(value)
      else await renderer.key('Backspace', 'Backspace')
    }
    const assertStatus = text => ui.dom(text, `${select(RESULT)}?.textContent.match(${text})`, 30_000)
    const before = (await readJobs()).map(job => job.id).sort()
    const alternateBefore = await boundedFile(stores.alternateJobs, JOB_BYTES)

    await fill(SEARCH, 'Perf schedule 000')
    await ui.click(action('create'))
    await ui.dom('new task focuses the name and defaults to paused', `document.activeElement === ${select(nameInput)} && ${select(`${FORM} input[name="paused"]`)}?.checked`)
    await renderer.key('Escape', 'Escape', 53)
    await ui.dom('closing the form returns focus', `!${select(FORM)} && document.activeElement === ${action('create')}`)
    await ui.click(action('create'))
    await fill(nameInput, name)
    await fill(scheduleInput, 'invalid cadence')
    await fill(instructionInput, prompt)
    await ui.click(action('submit-create'))
    await ui.dom('invalid schedule displays the native error and keeps the draft', `!!${select(`${FORM} [role="alert"]`)}?.textContent.includes('OC_HERMES_SCHEDULE') && ${select(nameInput)}?.value === ${JSON.stringify(name)} && ${select(instructionInput)}?.value === ${JSON.stringify(prompt)}`)
    assert.deepEqual((await readJobs()).map(job => job.id).sort(), before)
    await fill(scheduleInput, schedule)
    for (const [width, height] of [[1280, 860], [880, 640]]) {
      await renderer.resize(width, height)
      await ui.frames()
      await ui.dom('task form fields wrap within the viewport', `(() => {
        const form = ${select(FORM)};
        return form?.scrollWidth <= form?.clientWidth + 1 && [...form.querySelectorAll('input,textarea,button')].every(control => {
          const field = control.getBoundingClientRect();
          return field.width > 0 && field.left >= 0 && field.right <= innerWidth + 1;
        });
      })()`)
      await capture(`schedule-create-${width}`)
    }
    await ui.click(action('submit-create'))
    await assertStatus(/已创建|task created/u)
    const created = (await readJobs()).find(job => job.name === name)
    assert.match(created?.id ?? '', /^[0-9a-f]{12}$/u)
    assert.equal(created?.state, 'paused')
    assert.equal(created?.enabled, false)
    assert.equal(created?.prompt, prompt)
    await assertStatus(/不在当前筛选|outside the current filters/u)
    assert.equal(await ui.evaluate(`${select(SEARCH)}.value`), 'Perf schedule 000')

    const row = select(`[data-job-id="hermes-job:${created.id}"] button`)
    await fill(SEARCH, name)
    await ui.click(row)
    await ui.click(action('resume'))
    await assertStatus(/已恢复|task resumed/u)
    assert.equal((await readJobs()).find(job => job.id === created.id)?.enabled, true)
    await ui.click(action('pause'))
    await assertStatus(/已暂停|task paused/u)
    assert.equal((await readJobs()).find(job => job.id === created.id)?.state, 'paused')

    await ui.click(action('delete'))
    await ui.dom('deletion requires an explicit confirmation with safe focus', `!!${action('confirm-delete')} && document.activeElement === ${action('cancel-delete')}`)
    await capture('schedule-delete-confirmation-880')
    await ui.click(action('cancel-delete'))
    await ui.dom('cancel returns focus to delete and closes its confirmation', `!${action('confirm-delete')} && document.activeElement === ${action('delete')}`)
    assert.ok((await readJobs()).some(job => job.id === created.id))
    await ui.click(action('delete'))
    await ui.click(action('confirm-delete'))
    await assertStatus(/已删除|task deleted/u)
    await ui.dom('removed task leaves both list and details', `!${row} && ${select('#schedule-task-details')}?.dataset.open === 'false'`)
    assert.deepEqual((await readJobs()).map(job => job.id).sort(), before)
    assert.deepEqual(await boundedFile(stores.alternateJobs, JOB_BYTES), alternateBefore)
    await renderer.resize(1280, 860)
    return { actions: ['create', 'resume', 'pause', 'delete'], widths: [1280, 880], profile: 'default', verifiedPersistedState: true }
  })
}
