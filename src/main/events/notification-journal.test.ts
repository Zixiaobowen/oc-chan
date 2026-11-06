import assert from 'node:assert/strict'
import { chmod, link, mkdtemp, mkdir, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { collectionResources } from '../resource-budget'
import { emptyNotificationJournal, NOTIFICATION_JOURNAL_BYTES, readNotificationJournal, writeNotificationJournal } from './notification-journal'

test('notification journal writes private bounded metadata atomically and releases file leases', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-notification-journal-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'private', 'notifications.json')
  const journal = emptyNotificationJournal()
  journal.identity = '1:2:3'
  journal.cursor = { sequence: 100, unconfirmed: true }
  journal.summaryCount = 97
  journal.cooldowns = Array.from({ length: 64 }, (_, index) => ({ key: index.toString(16).padStart(64, '0'), at: 1_700_000_000_000 }))
  journal.sentAt = [1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002]
  await writeNotificationJournal(filename, journal)
  assert.deepEqual(await readNotificationJournal(filename), journal)
  assert.equal((await stat(path.dirname(filename))).mode & 0o777, 0o700)
  assert.equal((await stat(filename)).mode & 0o777, 0o600)
  assert((await stat(filename)).size <= NOTIFICATION_JOURNAL_BYTES)
  journal.cursor.sequence = 101
  await writeNotificationJournal(filename, journal)
  assert.equal((await readNotificationJournal(filename)).cursor.sequence, 101)
  assert.equal(collectionResources.snapshot().sources.find(source => source.source === 'notifications')?.current.files, 0)
})

test('journal refuses symlinks, directories, oversized files and invalid encoding without replacing them', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-notification-journal-invalid-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'target'), link = path.join(directory, 'link')
  await writeFile(target, 'keep')
  await symlink(target, link)
  await assert.rejects(readNotificationJournal(link))
  await assert.rejects(writeNotificationJournal(link, emptyNotificationJournal()))
  assert.equal(await readFile(target, 'utf8'), 'keep')
  const folder = path.join(directory, 'folder')
  await mkdir(folder)
  await assert.rejects(readNotificationJournal(folder))
  await assert.rejects(writeNotificationJournal(folder, emptyNotificationJournal()))
  const large = path.join(directory, 'large')
  await writeFile(large, Buffer.alloc(NOTIFICATION_JOURNAL_BYTES + 1, 32), { mode: 0o600 })
  await assert.rejects(readNotificationJournal(large))
  await writeFile(large, Buffer.from([0xff, 0xfe]))
  await assert.rejects(readNotificationJournal(large))
})

test('invalid persisted cardinality is rejected instead of replaying an empty journal', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-notification-journal-schema-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'journal')
  const journal = emptyNotificationJournal()
  journal.sentAt = [1, 2, 3, 4]
  await writeFile(filename, JSON.stringify(journal), { mode: 0o600 })
  await assert.rejects(readNotificationJournal(filename))
  await assert.rejects(writeNotificationJournal(filename, journal))
  const before = await readFile(filename, 'utf8')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(writeNotificationJournal(filename, emptyNotificationJournal(), controller.signal), { name: 'AbortError' })
  assert.equal(await readFile(filename, 'utf8'), before)
  assert.equal(collectionResources.snapshot().sources.find(source => source.source === 'notifications')?.current.files, 0)
})

test('unsafe existing permissions and hardlinks are rejected without changing mode, inode or contents', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-notification-journal-owned-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'journal')
  await writeNotificationJournal(filename, emptyNotificationJournal())
  const original = await readFile(filename, 'utf8')
  const inode = (await stat(filename)).ino
  await chmod(filename, 0o644)
  await assert.rejects(readNotificationJournal(filename), { code: 'OC_NOTIFICATION_UNSAFE_FILE' })
  await assert.rejects(writeNotificationJournal(filename, emptyNotificationJournal()), { code: 'OC_NOTIFICATION_UNSAFE_FILE' })
  assert.equal((await stat(filename)).mode & 0o777, 0o644)
  assert.equal((await stat(filename)).ino, inode)
  assert.equal(await readFile(filename, 'utf8'), original)
  await chmod(filename, 0o600)
  await link(filename, path.join(directory, 'alias'))
  await assert.rejects(readNotificationJournal(filename), { code: 'OC_NOTIFICATION_UNSAFE_FILE' })
  await assert.rejects(writeNotificationJournal(filename, emptyNotificationJournal()), { code: 'OC_NOTIFICATION_UNSAFE_FILE' })
  assert.equal((await stat(filename)).nlink, 2)
  assert.equal((await stat(filename)).ino, inode)
  assert.equal(await readFile(filename, 'utf8'), original)
  await chmod(directory, 0o755)
  await assert.rejects(readNotificationJournal(filename), { code: 'OC_NOTIFICATION_UNSAFE_DIRECTORY' })
  await assert.rejects(writeNotificationJournal(filename, emptyNotificationJournal()), { code: 'OC_NOTIFICATION_UNSAFE_DIRECTORY' })
  assert.equal((await stat(directory)).mode & 0o777, 0o755)
})

test('a different process owner cannot read or replace the journal and its directory', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-notification-journal-uid-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'journal')
  await writeNotificationJournal(filename, emptyNotificationJournal())
  const original = await readFile(filename, 'utf8')
  const uid = process.getuid!()
  const owner = t.mock.method(process as NodeJS.Process & { getuid(): number }, 'getuid', () => uid + 1)
  try {
    await assert.rejects(readNotificationJournal(filename), { code: 'OC_NOTIFICATION_UNSAFE_DIRECTORY' })
    await assert.rejects(writeNotificationJournal(filename, emptyNotificationJournal()), { code: 'OC_NOTIFICATION_UNSAFE_DIRECTORY' })
  } finally { owner.mock.restore() }
  assert.equal((await stat(directory)).uid, uid)
  assert.equal(await readFile(filename, 'utf8'), original)
})
