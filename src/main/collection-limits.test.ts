import assert from 'node:assert/strict'
import { mkdir, mkdtemp, opendir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { COLLECTION_LIMITS, CollectionLimitError, DirectoryScan } from './collection-limits'
import { collectionResources } from './resource-budget'

async function fixture(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'oc-r02-directory-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
async function populate(directory: string, count: number): Promise<void> {
  for (let start = 0; start < count; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, count - start) }, (_, offset) => {
      const index = start + offset
      return writeFile(join(directory, `${index}.${index === 0 ? 'json' : 'txt'}`), '')
    }))
  }
}
function assertReleased(): void {
  const current = collectionResources.snapshot().global.current
  assert.equal(current.files, 0)
  assert.equal(current.fileBytes, 0)
  assert.equal(current.queued, 0)
}

test('directory scans count filtered entries across directories at the 4096 and 4097 boundaries', async t => {
  const root = await fixture(t)
  const empty = join(root, 'empty'), first = join(root, 'first'), second = join(root, 'second'), extra = join(root, 'extra')
  for (const directory of [empty, first, second, extra]) await mkdir(directory)
  await populate(first, 2048)
  await populate(second, 2048)
  await populate(extra, 1)
  const scan = new DirectoryScan()
  const accept = (name: string) => name.endsWith('.json')
  assert.deepEqual(await scan.read(empty, 'test-directory', undefined, accept), [])
  assert.equal(scan.scanned, 0)
  assert.deepEqual(await scan.read(first, 'test-directory', undefined, accept), ['0.json'])
  assert.equal(scan.scanned, 2048)
  assert.deepEqual(await scan.read(second, 'test-directory', undefined, accept), ['0.json'])
  assert.equal(scan.scanned, COLLECTION_LIMITS.directoryEntries)
  assertReleased()
  await assert.rejects(scan.read(extra, 'test-directory', undefined, accept), (error: unknown) => {
    assert.ok(error instanceof CollectionLimitError)
    assert.equal(error.code, 'OC_COLLECTION_LIMIT')
    assert.equal(error.limit, 4096)
    assert.equal(error.observed, 4097)
    return true
  })
  assertReleased()
  assert.deepEqual(await new DirectoryScan().read(extra, 'test-directory-normal'), ['0.json'])
  assertReleased()
})

test('a single directory at 4096 entries succeeds but a filtered 4097th entry rejects', async t => {
  const directory = await fixture(t)
  await populate(directory, 4096)
  assert.deepEqual(await new DirectoryScan().read(directory, 'test-directory', undefined, name => name.endsWith('.json')), ['0.json'])
  await writeFile(join(directory, 'extra.txt'), '')
  await assert.rejects(new DirectoryScan().read(directory, 'test-directory', undefined, name => name.endsWith('.json')), { code: 'OC_COLLECTION_LIMIT' })
  assertReleased()
})

test('mid-scan cancellation closes the actual directory handle before releasing its lease', async t => {
  const directory = await fixture(t)
  await populate(directory, 64)
  const probe = await opendir(directory)
  const prototype = Object.getPrototypeOf(probe)
  const original = prototype.read
  await probe.close()
  let captured: typeof probe | undefined
  t.mock.method(prototype, 'read', function (this: typeof probe, ...args: unknown[]) {
    captured = this
    return Reflect.apply(original, this, args)
  })
  const controller = new AbortController()
  const scan = new DirectoryScan()
  await assert.rejects(scan.read(directory, 'test-directory', controller.signal, () => {
    if (scan.scanned === 8) controller.abort()
    return false
  }), { name: 'AbortError', code: 'ABORT_ERR' })
  assert.equal(scan.scanned, 8)
  assert.ok(captured)
  await assert.rejects(captured.read(), { code: 'ERR_DIR_CLOSED' })
  assertReleased()
  assert.equal((await new DirectoryScan().read(directory, 'test-directory-normal')).length, 64)
  assertReleased()
})

test('queued cancellation never opens a directory and read failures do not become empty success', async t => {
  const directory = await fixture(t)
  const filename = join(directory, 'file')
  await writeFile(filename, '')
  const held = await collectionResources.acquire({ source: 'test-directory-hold', kind: 'file', bytes: 0 })
  const others: typeof held[] = []
  for (let index = 1; index < collectionResources.limits.files; index++) others.push(await collectionResources.acquire({ source: 'test-directory-hold', kind: 'file', bytes: 0 }))
  const controller = new AbortController()
  t.after(() => { controller.abort(); held.release(); for (const lease of others) lease.release() })
  const scan = new DirectoryScan()
  // A missing path would produce ENOENT if the cancelled queued operation ever opened it.
  const result = assert.rejects(scan.read(join(directory, 'missing'), 'test-directory', controller.signal), { name: 'AbortError', code: 'ABORT_ERR' })
  controller.abort()
  await result
  assert.equal(scan.scanned, 0)
  held.release()
  for (const lease of others) lease.release()
  assertReleased()
  await assert.rejects(new DirectoryScan().read(filename, 'test-directory'), { code: 'ENOTDIR' })
  await assert.rejects(new DirectoryScan().read(join(directory, 'missing'), 'test-directory'), { code: 'ENOENT' })
  assertReleased()
  assert.deepEqual(await new DirectoryScan().read(directory, 'test-directory-normal'), ['file'])
  assertReleased()
})
