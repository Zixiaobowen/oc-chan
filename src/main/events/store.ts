import path from 'node:path'
import { runBudgetedCommand } from '../resource-io'
import { isResourceAbort, isResourceCleanupFailure } from '../resource-budget'
import { parseEventQuery, type EventPage, type EventQuery, type EventRetention } from '../../shared/events'
import type { EventCheckpoint, EventCommit } from './contracts'

const CHECKPOINT_BYTES = 128 * 1024
const OUTPUT_BYTES = 256 * 1024
const MAX_PENDING = 16

type Loaded = { revision: number; checkpoint: EventCheckpoint | null; retention: EventRetention }
type Committed = { revision: number; retention: EventRetention; checkpoint: EventCheckpoint;
  identity: string; added: { sequence: number; index: number }[] }
type Operation = 'load' | 'commit' | 'query'

function failure(code: string): Error {
  const messages: Record<string, string> = {
    invalid: '事件字段或结构无效 / Invalid event metadata or structure',
    limit: '事件存储超过资源预算 / Event storage budget exceeded',
    stale: '事件检查点已更新 / Stale event checkpoint revision',
    locked: '事件数据库被锁定 / Event database locked',
    corrupt: '事件数据库损坏或结构无效 / Corrupt or invalid event database',
    permission: '事件数据库权限不足或路径不安全 / Event database permission denied or unsafe path',
    full: '事件数据库空间不足 / Event database full',
    closed: '事件存储已关闭 / Event store closed',
    queue: '事件存储等待预算已满（16个请求／100条事件） / Event store queue full (16 requests / 100 events)',
    timeout: '事件存储操作超时（3 秒） / Event store operation timed out (3 seconds)',
    command: '事件存储操作失败 / Event store operation failed',
    sidecar: '事件数据库附属文件不符合预算 / Unexpected event database sidecar budget',
  }
  return Object.assign(new Error(messages[code] ?? messages.command), { code: `EVENT_STORE_${code.toUpperCase()}` })
}

function cancelled(): Error {
  return Object.assign(new Error('事件存储操作已取消 / Event store operation cancelled'), { name: 'AbortError', code: 'ABORT_ERR' })
}

// Validate lengths before serializing: no arbitrary object, body, or unbounded array crosses the process boundary.
function validateMetadata(kind: 'checkpoint' | 'event', input: unknown): void {
  function bad(): never { throw failure('invalid') }
  function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) bad()
    const fields = Object.keys(value)
    if (fields.length !== keys.length || fields.some(key => !keys.includes(key))) bad()
    for (const key of fields) if (!Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty('value')) bad()
    return value as Record<string, unknown>
  }
  function text(value: unknown, max: number): void {
    if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) bad()
  }
  function instant(value: unknown, nullable = false): void {
    if (nullable && value === null) return
    if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) bad()
  }
  function integer(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0) bad() }
  function one(value: unknown, allowed: string[]): void { if (!allowed.includes(value as string)) bad() }
  function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) bad(); return value }
  if (kind === 'event') {
    const event = object(input, ['id', 'sourceId', 'entityId', 'type', 'occurredAt', 'observedAt', 'resultCode', 'target'])
    text(event.id, 512); text(event.sourceId, 128); text(event.entityId, 256); text(event.resultCode, 64)
    one(event.type, ['execution-failed', 'delivery-failed', 'source-unavailable', 'source-recovered'])
    instant(event.occurredAt, true); instant(event.observedAt)
    if (event.target !== null) {
      if (!event.target || typeof event.target !== 'object' || !('kind' in event.target)) bad()
      const targetKind = event.target.kind
      const target = object(event.target, targetKind === 'source' ? ['kind', 'id', 'section'] : ['kind', 'id', 'identity'])
      one(target.kind, ['source', 'schedule', 'agent']); text(target.id, 256)
      if (target.kind === 'source') one(target.section, ['agents', 'schedules', 'system', 'events'])
      else text(target.identity, 1536)
    }
    return
  }
  const checkpoint = object(input, ['version', 'hermes', 'sources', 'coverage', 'observedAt'])
  if (checkpoint.version !== 1) bad()
  instant(checkpoint.observedAt, true)
  if (checkpoint.hermes !== null) {
    const cursor = object(checkpoint.hermes, ['identity', 'baseline', 'high', 'revisit', 'floor', 'since', 'lastObservedAt', 'pending', 'pendingIndex'])
    text(cursor.identity, 512)
    for (const key of ['baseline', 'high', 'revisit', 'floor', 'pendingIndex']) integer(cursor[key])
    if ((cursor.floor as number) > (cursor.high as number) || (cursor.revisit as number) > (cursor.high as number)) bad()
    instant(cursor.since); instant(cursor.lastObservedAt)
    for (const value of array(cursor.pending, 128)) {
      const row = object(value, ['rowid', 'id', 'status', 'delivery'])
      integer(row.rowid); text(row.id, 128); text(row.status, 32)
      if (row.delivery !== null) text(row.delivery, 32)
    }
  }
  for (const value of array(checkpoint.sources, 64)) {
    const source = object(value, ['id', 'section', 'state', 'observedAt', 'unavailableSince', 'announced', 'generation'])
    text(source.id, 128); one(source.section, ['agents', 'schedules', 'system', 'events'])
    one(source.state, ['ok', 'empty', 'partial', 'error', 'unsupported', 'disabled'])
    instant(source.observedAt); instant(source.unavailableSince, true); integer(source.generation)
    if (typeof source.announced !== 'boolean') bad()
  }
  for (const value of array(checkpoint.coverage, 8)) {
    const hasGap = value !== null && typeof value === 'object' && Object.hasOwn(value, 'lastGap')
    const coverage = object(value, ['sourceId', 'state', 'since', 'observedAt', 'code', ...(hasGap ? ['lastGap'] : [])])
    text(coverage.sourceId, 128)
    one(coverage.state, ['baseline', 'observing', 'catching-up', 'gap', 'disabled', 'unavailable'])
    instant(coverage.since, true); instant(coverage.observedAt, true)
    if (coverage.code !== null) text(coverage.code, 64)
    if (hasGap) {
      const gap = object(coverage.lastGap, ['from', 'to', 'code', 'count'])
      instant(gap.from); instant(gap.to); text(gap.code, 64); integer(gap.count)
      if ((gap.from as string) > (gap.to as string) || gap.count === 0) bad()
    }
  }
}

// A literal script survives bundling without closing over compiled helper names.
// SQLite, directory inspection and recovery run only in this finite, heap-capped child.
const storeScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const file = process.argv[1], operation = process.argv[2];
const input = JSON.parse(process.argv.slice(3).join(''));
const MAIN_BYTES = 8388608, DISK_BYTES = 20971520, PAYLOAD_BYTES = 3145728;
let db, inTransaction = false, result, errorCode;
function fail(code) { throw Object.assign(new Error(code), { storeCode: code }); }
function info(name) { try { return fs.lstatSync(name); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function safe(stat, directory = false) {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || stat.nlink > 1 && !directory) fail('permission');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('permission');
  if ((stat.mode & 0o077) !== 0 || (stat.mode & (directory ? 0o700 : 0o600)) !== (directory ? 0o700 : 0o600)) fail('permission');
}
function disk() {
  const main = info(file); if (!main) fail('corrupt'); safe(main);
  if (main.size > MAIN_BYTES) fail('limit');
  let bytes = main.size;
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = info(file + suffix);
    if (!sidecar) continue;
    safe(sidecar);
    if (suffix !== '-journal' || sidecar.size > MAIN_BYTES + 65536) fail('sidecar');
    if (sidecar.size > 0) {
      if (sidecar.size < 512) fail('sidecar');
      const header = Buffer.alloc(28), fd = fs.openSync(file + suffix, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) fail('sidecar'); }
      finally { fs.closeSync(fd); }
      const magic = header.subarray(0,8).toString('hex'), sector = header.readUInt32BE(20);
      if (!['d9d505f920a163d7','0000000000000000'].includes(magic) || header.readUInt32BE(24) !== 4096 ||
          sector < 512 || sector > 65536 || (sector & (sector - 1)) !== 0) fail('sidecar');
    }
    bytes += sidecar.size;
  }
  if (bytes > DISK_BYTES) fail('limit');
  return bytes;
}
try {
  process.umask(0o077);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  safe(fs.lstatSync(directory), true);
  if (!info(file)) {
    // Never truncate, replace, or delete an existing database, even after a failed operation.
    try { const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); fs.closeSync(fd); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  disk();
  db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=500; PRAGMA hard_heap_limit=16777216; PRAGMA cache_size=-1024; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const application = db.prepare('PRAGMA application_id').get().application_id;
  const tableCount = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get().n;
  if (version !== 1 && !(version === 0 && application === 0 && tableCount === 0) || version === 1 && application !== 1329808718) fail('corrupt');
  if (version === 0) db.exec('PRAGMA page_size=4096;');
  if (db.prepare('PRAGMA page_size').get().page_size !== 4096) fail('corrupt');
  if (db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') fail('sidecar');
  db.exec('PRAGMA synchronous=FULL; PRAGMA max_page_count=2048;');
  db.exec('BEGIN IMMEDIATE'); inTransaction = true;
  if (version === 0) {
    db.exec('CREATE TABLE event_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, checkpoint TEXT, deleted_count INTEGER NOT NULL, deleted_through TEXT, reason TEXT);' +
      'INSERT INTO event_state VALUES(1,0,NULL,0,NULL,NULL);' +
      'CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL, type TEXT NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL, payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND 2048));' +
      'CREATE INDEX events_observed ON events(observed_at);' +
      'CREATE INDEX events_source ON events(source_id,seq);' +
      'CREATE INDEX events_type ON events(type,seq);' +
      'CREATE TABLE event_tombstones (id BLOB PRIMARY KEY CHECK(length(id)=32), identity BLOB NOT NULL CHECK(length(identity)=8), rowid INTEGER NOT NULL, observed_at INTEGER NOT NULL) WITHOUT ROWID;' +
      'PRAGMA application_id=1329808718; PRAGMA user_version=1;');
  }
  const state = db.prepare('SELECT revision, checkpoint, deleted_count AS deletedCount, deleted_through AS deletedThrough, reason FROM event_state WHERE singleton=1 AND (checkpoint IS NULL OR length(CAST(checkpoint AS BLOB))<=131072)').get();
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0) fail('corrupt');
  if (operation === 'commit' && state.revision !== input.revision) fail('stale');
  const previous = state.checkpoint === null ? null : JSON.parse(state.checkpoint);
  const checkpoint = operation === 'commit' ? input.checkpoint : previous;
  let deletedCount = state.deletedCount, deletedThrough = state.deletedThrough, reason = state.reason;
  const now = input.now;
  const cutoff = new Date(Date.parse(now) - 604800000).toISOString();
  const identity = checkpoint && checkpoint.hermes ? createHash('sha256').update(checkpoint.hermes.identity).digest('hex').slice(0,16) : null;
  const identityBytes = identity === null ? null : Buffer.from(identity,'hex');
  if (identity && previous && previous.hermes && previous.hermes.identity === checkpoint.hermes.identity)
    checkpoint.hermes.floor = Math.max(checkpoint.hermes.floor,previous.hermes.floor);
  let floorChanged = false, gapFrom = now;
  function hermesId(id) {
    const match = /^h:([a-f0-9]{16}):([1-9][0-9]*):[a-f0-9]{32}$/.exec(id);
    if (!match) return null;
    const rowid = Number(match[2]);
    if (!Number.isSafeInteger(rowid)) fail('invalid');
    return { identity: match[1], rowid };
  }
  function advance(rowid, observedAt) {
    if (typeof observedAt === 'number') observedAt = new Date(observedAt).toISOString();
    if (rowid > checkpoint.hermes.floor) {
      checkpoint.hermes.floor = rowid;
      checkpoint.hermes.high = Math.max(checkpoint.hermes.high,rowid);
      floorChanged = true;
      if (observedAt < gapFrom) gapFrom = observedAt;
    }
  }
  function retire(where, args) {
    const lost = db.prepare('SELECT max(rowid) AS rowid,min(observed_at) AS observedAt FROM event_tombstones WHERE identity=? AND (' + where + ')').get(identityBytes,...args);
    if (identity && lost.rowid !== null) advance(lost.rowid,lost.observedAt);
    db.prepare('DELETE FROM event_tombstones WHERE ' + where).run(...args);
    if (identity) db.prepare('DELETE FROM event_tombstones WHERE identity=? AND rowid<=?').run(identityBytes,checkpoint.hermes.floor);
  }
  // A replaced database identity cannot be revisited by the current cursor.
  if (identity) db.prepare('DELETE FROM event_tombstones WHERE identity<>?').run(identityBytes);
  else db.exec('DELETE FROM event_tombstones');
  retire('observed_at < ?', [Date.parse(cutoff)]);
  const tombstone = db.prepare('SELECT 1 FROM event_tombstones WHERE id=?');
  const remember = db.prepare('INSERT INTO event_tombstones(id,identity,rowid,observed_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING');
  const digest = id => createHash('sha256').update(id).digest();
  function covered(event) {
    const id = hermesId(event.id);
    return id && (id.identity !== identity || id.rowid <= checkpoint.hermes.floor || tombstone.get(digest(event.id)));
  }
  function prune(where, args, why) {
    const summary = db.prepare('SELECT count(*) AS n,max(observed_at) AS through FROM events WHERE ' + where).get(...args);
    if (!summary.n) return;
    for (const row of db.prepare('SELECT id,observed_at FROM events WHERE ' + where).iterate(...args)) {
      const id = hermesId(row.id);
      if (!id || id.identity !== identity || id.rowid <= checkpoint.hermes.floor) continue;
      if (row.observed_at < cutoff) advance(id.rowid,row.observed_at);
      else remember.run(digest(row.id),identityBytes,id.rowid,Date.parse(row.observed_at));
    }
    const overflow = db.prepare('SELECT max(count(*)-32768,0) AS n FROM event_tombstones').get().n;
    if (overflow) retire('id IN (SELECT id FROM event_tombstones ORDER BY observed_at,rowid,id LIMIT ?)', [overflow]);
    if (identity) db.prepare('DELETE FROM event_tombstones WHERE identity=? AND rowid<=?').run(identityBytes,checkpoint.hermes.floor);
    db.prepare('DELETE FROM events WHERE ' + where).run(...args);
    deletedCount += summary.n;
    if (deletedThrough === null || summary.through > deletedThrough) deletedThrough = summary.through;
    reason = why;
  }
  prune('observed_at < ?', [cutoff], 'age');
  const added = [];
  if (operation === 'commit') {
    // Prune before insertion so a bounded batch cannot overflow a nearly full main file.
    // Existing duplicate IDs consume no new payload and cannot evict unrelated records.
    const exists = db.prepare('SELECT 1 FROM events WHERE id=?');
    const seen = new Set();
    const additions = [];
    for (let index = 0; index < input.events.length; index++) {
      const event = input.events[index];
      if (seen.has(event.id) || exists.get(event.id) || covered(event)) continue;
      seen.add(event.id);
      const payload = JSON.stringify(event);
      additions.push({ event, index, payload, bytes: Buffer.byteLength(payload) });
    }
    const totals = db.prepare('SELECT count(*) AS n,coalesce(sum(payload_bytes),0) AS bytes FROM events').get();
    const extra = Math.max(0, totals.n + additions.length - 10000);
    if (extra) prune('seq IN (SELECT seq FROM events ORDER BY seq LIMIT ?)', [extra], 'count');
    const remaining = db.prepare('SELECT coalesce(sum(payload_bytes),0) AS bytes FROM events').get().bytes;
    let excess = remaining + additions.reduce((sum, entry) => sum + entry.bytes, 0) - PAYLOAD_BYTES;
    if (excess > 0) {
      // At most 10000 tiny numeric rows; no stored payloads are materialized for pruning.
      let through = 0;
      for (const row of db.prepare('SELECT seq,payload_bytes AS bytes FROM events ORDER BY seq').iterate()) {
        through = row.seq; excess -= row.bytes; if (excess <= 0) break;
      }
      if (through) prune('seq<=?', [through], 'bytes');
    }
    const insert = db.prepare('INSERT INTO events(id,source_id,type,observed_at,payload,payload_bytes) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
    for (const { event, index, payload, bytes } of additions) {
      if (covered(event)) continue;
      const inserted = insert.run(event.id,event.sourceId,event.type,event.observedAt,payload,bytes);
      if (inserted.changes && event.observedAt >= cutoff) added.push({ sequence: Number(inserted.lastInsertRowid), index });
    }
    prune('observed_at < ?', [cutoff], 'age');
  }
  if (identity) {
    const pending = checkpoint.hermes.pending.filter(row => row.rowid > checkpoint.hermes.floor);
    if (pending.length !== checkpoint.hermes.pending.length) checkpoint.hermes.pendingIndex = 0;
    checkpoint.hermes.pending = pending;
    checkpoint.hermes.high = Math.max(checkpoint.hermes.high,checkpoint.hermes.floor);
    checkpoint.hermes.revisit = Math.max(checkpoint.hermes.revisit,checkpoint.hermes.floor);
  }
  if (floorChanged) {
    checkpoint.hermes.pendingIndex = 0;
    let coverage = checkpoint.coverage.find(entry => entry.sourceId === 'hermes-events');
    if (!coverage) {
      if (checkpoint.coverage.length >= 8) fail('limit');
      coverage = { sourceId: 'hermes-events', state: 'gap', since: checkpoint.hermes.since, observedAt: now, code: null };
      checkpoint.coverage.push(coverage);
    }
    coverage.state = 'gap'; coverage.code = 'hermes-dedup-capacity-gap'; coverage.observedAt = now;
    coverage.lastGap = { from: gapFrom, to: now, code: coverage.code, count: Math.min(Number.MAX_SAFE_INTEGER,(coverage.lastGap ? coverage.lastGap.count : 0)+1) };
  }
  if (operation === 'commit' || floorChanged) {
    if (state.revision === Number.MAX_SAFE_INTEGER) fail('limit');
    state.revision++;
    const encoded = JSON.stringify(checkpoint);
    if (Buffer.byteLength(encoded)>131072) fail('limit');
    db.prepare('UPDATE event_state SET revision=?,checkpoint=? WHERE singleton=1').run(state.revision,encoded);
  }
  db.prepare('UPDATE event_state SET deleted_count=?,deleted_through=?,reason=? WHERE singleton=1').run(deletedCount,deletedThrough,reason);
  const summary = db.prepare('SELECT count(*) AS count,min(observed_at) AS oldestObservedAt,coalesce(max(seq),0) AS newestSequence FROM events').get();
  const retention = { ...summary, deletedCount, deletedThrough, reason, diskBytes: 0 };
  result = { revision: state.revision, retention };
  if (operation === 'load' || operation === 'commit') result.checkpoint = checkpoint;
  else if (operation === 'query') {
    const query = input.query;
    const maximum = db.prepare("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='events'),0) AS seq").get().seq;
    const upper = query.upper === undefined ? maximum : Math.min(query.upper, maximum);
    const conditions = ['seq<=?'], parameters = [upper];
    for (const [field,column,operator] of [['before','seq','<'],['sourceId','source_id','='],['type','type','='],['from','observed_at','>='],['to','observed_at','<=']]) {
      if (query[field] !== undefined) { conditions.push(column + operator + '?'); parameters.push(query[field]); }
    }
    const rows = db.prepare('SELECT seq,payload FROM events WHERE ' + conditions.join(' AND ') + ' ORDER BY seq DESC LIMIT 51').all(...parameters);
    result.entries = rows.slice(0,50).map(row => JSON.parse(row.payload));
    result.next = rows.length > 50 ? rows[49].seq : null;
    result.upper = upper;
    result.coverage = checkpoint === null ? [] : checkpoint.coverage;
  }
  if (operation === 'commit') {
    const stat = info(file);
    result.identity = String(stat.dev) + ':' + String(stat.ino) + ':' + String(stat.birthtimeMs);
    result.added = added;
  }
  disk();
  db.exec('COMMIT'); inTransaction = false;
} catch (error) {
  const code = Number.isInteger(error.errcode) ? error.errcode & 255 : -1;
  errorCode = error.storeCode || (code === 5 || code === 6 ? 'locked' : code === 13 ? 'full' : code === 7 || code === 18 ? 'limit' :
    code === 3 || code === 8 || code === 14 || code === 23 || ['EACCES','EPERM','EROFS','ELOOP','ENOTDIR'].includes(error.code) ? 'permission' :
    error.code === 'ENOSPC' || error.code === 'EDQUOT' ? 'full' : 'corrupt');
} finally {
  if (db) {
    if (inTransaction && db.isTransaction) { try { db.exec('ROLLBACK'); } catch { errorCode = 'corrupt'; } }
    try { db.close(); } catch { errorCode = 'corrupt'; }
  }
}
if (!errorCode) { try { result.retention.diskBytes = disk(); } catch (error) { errorCode = error.storeCode || 'permission'; } }
process.stdout.write(JSON.stringify(errorCode ? { error: errorCode } : result));
`

interface Request {
  operation: Operation
  input: string
  eventCount: number
  controller: AbortController
  signal?: AbortSignal
  abort: () => void
  resolve: (result: Loaded | Committed | EventPage) => void
  reject: (error: unknown) => void
}

export class EventStore {
  private readonly databasePath: string
  private queue: Request[] = []
  private active: Request | null = null
  private pendingEvents = 0
  private closed = false
  private closing: Promise<void> | null = null
  private drained: (() => void) | null = null

  constructor(databasePath: string) {
    if (typeof databasePath !== 'string' || !databasePath || databasePath.includes('\0')) throw failure('invalid')
    this.databasePath = path.resolve(databasePath)
  }

  load(signal?: AbortSignal): Promise<Loaded> {
    return this.enqueue('load', JSON.stringify({ now: new Date().toISOString() }), signal) as Promise<Loaded>
  }

  commit(input: EventCommit, signal?: AbortSignal): Promise<Committed> {
    try {
      if (!input || Object.keys(input).length !== 4 || !['revision', 'checkpoint', 'events', 'now'].every(key => Object.hasOwn(input, key)) ||
          !Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision === Number.MAX_SAFE_INTEGER ||
          !Array.isArray(input.events) || input.events.length > 100 || typeof input.now !== 'string' || input.now.length !== 24 ||
          !Number.isFinite(Date.parse(input.now)) || new Date(input.now).toISOString() !== input.now) throw failure('invalid')
      validateMetadata('checkpoint', input.checkpoint)
      if (Buffer.byteLength(JSON.stringify(input.checkpoint)) > CHECKPOINT_BYTES) throw failure('limit')
      for (const event of input.events) {
        validateMetadata('event', event)
        if (event.observedAt > input.now) throw failure('invalid')
        if (Buffer.byteLength(JSON.stringify(event)) > 2048) throw failure('limit')
      }
      return this.enqueue('commit', JSON.stringify(input), signal, input.events.length) as Promise<Committed>
    } catch (error) { return Promise.reject(error) }
  }

  query(query: EventQuery = {}, signal?: AbortSignal): Promise<EventPage> {
    try {
      return this.enqueue('query', JSON.stringify({ query: parseEventQuery(query), now: new Date().toISOString() }), signal) as Promise<EventPage>
    } catch (error) { return Promise.reject(error) }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const { promise, resolve } = Promise.withResolvers<void>()
    this.closing = promise
    this.drained = resolve
    for (const request of this.queue.splice(0)) {
      this.pendingEvents -= request.eventCount
      request.signal?.removeEventListener('abort', request.abort)
      request.reject(cancelled())
    }
    if (this.active) this.active.controller.abort()
    else { this.drained!(); this.drained = null }
    return this.closing
  }

  private enqueue(operation: Operation, input: string, signal?: AbortSignal, eventCount = 0): Promise<Loaded | Committed | EventPage> {
    if (this.closed) return Promise.reject(failure('closed'))
    if (signal?.aborted) return Promise.reject(cancelled())
    if (this.queue.length + Number(this.active !== null) >= MAX_PENDING || this.pendingEvents + eventCount > 100) return Promise.reject(failure('queue'))
    const { promise, resolve, reject } = Promise.withResolvers<Loaded | Committed | EventPage>()
    const request: Request = { operation, input, eventCount, controller: new AbortController(), signal, resolve, reject, abort: () => {
      if (this.active === request) request.controller.abort()
      else {
        const index = this.queue.indexOf(request)
        if (index !== -1) { this.queue.splice(index, 1); this.pendingEvents -= request.eventCount }
        signal?.removeEventListener('abort', request.abort)
        reject(cancelled())
      }
    } }
    signal?.addEventListener('abort', request.abort, { once: true })
    this.pendingEvents += eventCount
    this.queue.push(request)
    this.pump()
    return promise
  }

  private pump(): void {
    if (this.active || this.closed) return
    const request = this.queue.shift()
    if (!request) return
    this.active = request
    void this.execute(request).finally(() => {
      request.signal?.removeEventListener('abort', request.abort)
      this.pendingEvents -= request.eventCount
      this.active = null
      if (this.closed) { this.drained?.(); this.drained = null }
      else this.pump()
    }).then(request.resolve, request.reject)
  }

  private async execute(request: Request): Promise<Loaded | Committed | EventPage> {
    let stdout: string
    try {
      // Separate argv chunks avoid the per-argument OS limit for a 128 KiB checkpoint.
      const chunks = request.input.match(/[\s\S]{1,8192}/gu) ?? []
      const result = await runBudgetedCommand('event-store', process.execPath,
        ['--max-old-space-size=32', '--max-semi-space-size=2', '-e', storeScript, this.databasePath, request.operation, ...chunks],
        { timeout: 3000, maxBuffer: OUTPUT_BYTES, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, request.controller.signal)
      stdout = result.stdout
    } catch (error) {
      if (isResourceAbort(error) || isResourceCleanupFailure(error)) throw error
      const cause = error as NodeJS.ErrnoException & { killed?: boolean }
      if (cause.code === 'OC_RESOURCE_LIMIT' || cause.code === 'OC_RESOURCE_QUEUE_TIMEOUT') throw failure('limit')
      throw failure(cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'limit' : cause.killed ? 'timeout' : 'command')
    }
    if (request.controller.signal.aborted) throw cancelled()
    try {
      const result = JSON.parse(stdout)
      if (typeof result?.error === 'string') throw failure(result.error)
      if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0 || !result.retention ||
          !Number.isSafeInteger(result.retention.count) || result.retention.count < 0 || result.retention.count > 10000 ||
          !Number.isSafeInteger(result.retention.newestSequence) || result.retention.newestSequence < 0 ||
          !Number.isSafeInteger(result.retention.diskBytes) || result.retention.diskBytes < 0 || result.retention.diskBytes > 20 * 1024 * 1024) throw failure('corrupt')
      if (request.operation === 'commit' && result.checkpoint === null) throw failure('corrupt')
      if (request.operation !== 'query' && result.checkpoint !== null) validateMetadata('checkpoint', result.checkpoint)
      if (request.operation === 'commit') {
        if (typeof result.identity !== 'string' || result.identity.length > 128 || !/^[0-9]+:[0-9]+:[0-9.]+$/.test(result.identity) ||
            !Array.isArray(result.added) || result.added.length > request.eventCount) throw failure('corrupt')
        let sequence = 0
        const indexes = new Set<number>()
        for (const row of result.added) {
          if (!row || !Number.isSafeInteger(row.sequence) || row.sequence <= sequence || row.sequence > result.retention.newestSequence ||
              !Number.isSafeInteger(row.index) || row.index < 0 || row.index >= request.eventCount || indexes.has(row.index)) throw failure('corrupt')
          sequence = row.sequence
          indexes.add(row.index)
        }
      }
      if (request.operation === 'query') {
        if (!Array.isArray(result.entries) || result.entries.length > 50 || !Array.isArray(result.coverage) || result.coverage.length > 8 ||
            !Number.isSafeInteger(result.upper) || result.upper < 0 || (result.next !== null && (!Number.isSafeInteger(result.next) || result.next <= 0))) throw failure('corrupt')
        for (const event of result.entries) {
          validateMetadata('event', event)
          if (Buffer.byteLength(JSON.stringify(event)) > 2048) throw failure('corrupt')
        }
        validateMetadata('checkpoint', { version: 1, hermes: null, sources: [], coverage: result.coverage, observedAt: null })
      }
      return result
    } catch (error) {
      if (error instanceof SyntaxError) throw failure('corrupt')
      throw error
    }
  }
}
