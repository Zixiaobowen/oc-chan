import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Diagnostics, DIAGNOSTIC_PREVIEW_TTL_MS, saveDiagnosticReport } from './diagnostics'
import { collectionResources, resourceAbortError, ResourceCleanupError } from './resource-budget'
import { DIAGNOSTIC_REPORT_MAX_BYTES, type DiagnosticReportContent } from '../shared/diagnostic-report'

const content = (): DiagnosticReportContent => ({ generatedAt: '2026-11-05T00:00:00.000Z', json: '{"schemaVersion":1}', bytes: 19,
  limits: [], coverage: { sources: { included: 0, total: 0 }, diagnostics: { included: 0, total: 0 }, resources: { included: 0, total: 0 } } })
const unexpectedCopy = async () => { throw new Error('Unexpected clipboard access') }
async function ready(service: Diagnostics) {
  const result = await service.generate()
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') throw new Error('Expected a report')
  return result.preview
}
async function directory(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-diagnostic-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

test('only an existing preview can copy or open the save dialog; replacing and releasing invalidate IDs', async t => {
  let copies = 0, dialogs = 0
  const service = new Diagnostics({ build: content, chooseFile: async () => { dialogs++; return null }, copy: async () => { copies++ } })
  t.after(() => service.close())
  const absent = await service.save('no-preview')
  assert.equal(absent.status === 'error' && absent.reason, 'expired')
  const first = await ready(service)
  await ready(service)
  const stale = await service.copy(first.id)
  assert.equal(stale.status === 'error' && stale.reason, 'expired')
  await service.cancel()
  assert.equal(service.diagnostics().previewBytes, 0)
  assert.equal(service.diagnostics().timers, 0)
  assert.equal(copies, 0)
  assert.equal(dialogs, 0)
})

test('generation can be cancelled before sampling and does not revive a released report', async () => {
  let sampled = false
  const service = new Diagnostics({ build: () => { sampled = true; return content() }, copy: unexpectedCopy, chooseFile: async () => null })
  const generating = service.generate()
  await service.cancel()
  assert.deepEqual(await generating, { status: 'cancelled' })
  assert.equal(sampled, false)
  assert.deepEqual(service.diagnostics(), { closed: false, active: false, previewBytes: 0, timers: 0, cleanupFailed: false })
  await service.close()
})

test('cancel waits for the real owner to release and concurrent generation remains rejected', async () => {
  const started = Promise.withResolvers<void>(), drained = Promise.withResolvers<void>()
  let cancelled = false, completed = false
  const service = new Diagnostics({ build: content, copy: unexpectedCopy, chooseFile: async signal => {
    signal.addEventListener('abort', () => { cancelled = true }, { once: true })
    started.resolve()
    await drained.promise
    return null
  } })
  const preview = await ready(service)
  const saving = service.save(preview.id)
  await started.promise
  const closing = service.cancel().then(() => { completed = true })
  await Promise.resolve()
  assert.equal(cancelled, true)
  assert.equal(completed, false)
  const busy = await service.generate()
  assert.equal(busy.status === 'error' && busy.reason, 'busy')
  drained.resolve()
  assert.deepEqual(await saving, { status: 'cancelled' })
  await closing
  assert.equal(service.diagnostics().active, false)
  await service.close()
})

test('preview expiration revokes writes and closing the service prevents reopening', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let writes = 0
  const service = new Diagnostics({ build: content, copy: unexpectedCopy, chooseFile: async () => { writes++; return '/unused' } })
  const preview = await ready(service)
  t.mock.timers.tick(DIAGNOSTIC_PREVIEW_TTL_MS)
  const expired = await service.save(preview.id)
  assert.equal(expired.status === 'error' && expired.reason, 'expired')
  assert.equal(service.diagnostics().previewBytes, 0)
  assert.equal(writes, 0)
  await service.close()
  const closed = await service.generate()
  assert.equal(closed.status === 'error' && closed.reason, 'unavailable')
})

test('dialog cancellation creates no file and failed copy never returns success or private content', async t => {
  const dir = await directory(t)
  const service = new Diagnostics({ build: content, chooseFile: async () => null,
    copy: async () => { throw Object.assign(new Error('/Users/private/token-secret'), { code: 'EACCES' }) } })
  t.after(() => service.close())
  const preview = await ready(service)
  assert.deepEqual(await service.save(preview.id), { status: 'cancelled' })
  assert.deepEqual(await fs.readdir(dir), [])
  const result = await service.copy(preview.id)
  assert.equal(result.status === 'error' && result.reason, 'permission')
  assert.doesNotMatch(JSON.stringify(result), /private|token-secret/)
  assert.match(JSON.stringify(result), /EACCES/)
})

test('real export preserves UTF-8 bytes, private permissions, and does not replace existing files or symlinks', async t => {
  const dir = await directory(t), filename = path.join(dir, 'report.json')
  const json = '{"state":"未知"}\n', signal = new AbortController().signal
  await saveDiagnosticReport(filename, json, signal)
  assert.equal(await fs.readFile(filename, 'utf8'), json)
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600)
  await assert.rejects(saveDiagnosticReport(filename, '{"changed":true}', signal), { code: 'EEXIST' })
  assert.equal(await fs.readFile(filename, 'utf8'), json)
  const link = path.join(dir, 'link.json')
  await fs.symlink(filename, link)
  await assert.rejects(saveDiagnosticReport(link, '{"changed":true}', signal), { code: 'EEXIST' })
  assert.deepEqual((await fs.readdir(dir)).sort(), ['link.json', 'report.json'])
  assert.equal(collectionResources.snapshot().global.current.files, 0)
})

test('cancel during a partially written export removes owned temporary data and never creates destination', async t => {
  const dir = await directory(t), filename = path.join(dir, 'cancelled.json'), controller = new AbortController()
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    const write = handle.writeFile.bind(handle)
    handle.writeFile = async () => { await write('partial'); controller.abort(); throw resourceAbortError() }
    return handle
  } }
  await assert.rejects(saveDiagnosticReport(filename, content().json, controller.signal, io), { name: 'AbortError' })
  assert.deepEqual(await fs.readdir(dir), [])
  assert.equal(collectionResources.snapshot().global.current.files, 0)
})

test('write failure cleans a real temporary file and exposes its errno without a success receipt', async t => {
  const dir = await directory(t), filename = path.join(dir, 'denied.json')
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    handle.writeFile = async () => { throw Object.assign(new Error('sensitive-path'), { code: 'ENOSPC', errno: 28 }) }
    return handle
  } }
  const service = new Diagnostics({ build: content, copy: unexpectedCopy, chooseFile: async () => filename,
    save: (file, text, signal) => saveDiagnosticReport(file, text, signal, io) })
  t.after(() => service.close())
  const result = await service.save((await ready(service)).id)
  assert.equal(result.status === 'error' && result.reason, 'storage')
  assert.match(JSON.stringify(result), /ENOSPC/)
  assert.match(JSON.stringify(result), /errno=28/)
  assert.doesNotMatch(JSON.stringify(result), /sensitive-path/)
  assert.deepEqual(await fs.readdir(dir), [])
})

test('cleanup failure is distinct from cancellation and cancel cannot acknowledge a successful release', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const service = new Diagnostics({ build: content, copy: unexpectedCopy, chooseFile: async () => '/unused', save: async () => {
    entered.resolve(); await release.promise
    throw new ResourceCleanupError('file', Object.assign(new Error('private'), { code: 'EIO' }))
  } })
  const saving = service.save((await ready(service)).id)
  await entered.promise
  const closed = assert.rejects(service.cancel(), { code: 'OC_DIAGNOSTIC_CLEANUP' })
  release.resolve()
  assert.equal((await saving).status, 'error')
  await closed
  const blocked = await service.generate()
  assert.equal(blocked.status === 'error' && blocked.reason, 'cleanup')
  assert.equal(service.diagnostics().cleanupFailed, true)
  await assert.rejects(service.close(), { code: 'OC_DIAGNOSTIC_CLEANUP' })
})

test('oversized reports reject before a file is opened, including multibyte boundaries', async t => {
  const dir = await directory(t), filename = path.join(dir, 'large.json'), signal = new AbortController().signal
  for (const text of ['x'.repeat(DIAGNOSTIC_REPORT_MAX_BYTES + 1), '中'.repeat(Math.ceil(DIAGNOSTIC_REPORT_MAX_BYTES / 3))])
    await assert.rejects(saveDiagnosticReport(filename, text, signal), { code: 'OC_DIAGNOSTIC_LIMIT' })
  assert.deepEqual(await fs.readdir(dir), [])
})
