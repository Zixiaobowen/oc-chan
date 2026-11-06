import { homedir } from 'node:os'
import path from 'node:path'
import { EVENT_RETENTION_MS } from '../../shared/events'
import { isResourceAbort, isResourceCleanupFailure, resourceAbortError } from '../resource-budget'
import { runBudgetedCommand } from '../resource-io'
import type { HermesEventCursor, HermesEventRead } from './contracts'

export const HERMES_EVENT_TIMEOUT_MS = 3000
export const HERMES_EVENT_OUTPUT_BYTES = 256 * 1024

// Match the history collector's finite SQLite process and metadata-only projection.
// Rowid, not claimed_at, drives ingestion: late and timestamp-tied inserts remain visible.
const readerScript = String.raw`
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
let db, guard, response, observedInstant;
function fail(code) { throw Object.assign(new Error(code), { eventCode: code }); }
function field(value, max, optional = false) {
  if (optional && value === null) return null;
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail('metadata');
  return value;
}
function instant(value) {
  field(value, 64);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) fail('metadata');
  const local = match[1] + 'T' + match[2], milliseconds = Date.parse(local + 'Z');
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== local) fail('metadata');
  const hours = Number(match[6] || 0), minutes = Number(match[7] || 0);
  if (hours > 23 || minutes > 59) fail('metadata');
  const utc = new Date(milliseconds - (hours * 60 + minutes) * 60000 * (match[5] === '-' ? -1 : 1)).toISOString();
  if (utc.length !== 24) fail('metadata');
  return utc.slice(0, 19) + '.' + (match[3] || '').padEnd(9, '0');
}
function identity() {
  const stat = fs.lstatSync(process.argv[1], { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) fail('identity');
  return stat.dev + ':' + stat.ino;
}
function row(raw) {
  if (!Number.isSafeInteger(raw.rowid) || raw.rowid <= 0 || raw.invalidMetadata) fail('metadata');
  const result = { rowid: raw.rowid, id: field(raw.id, 128), jobId: field(raw.jobId, 128),
    status: field(raw.status, 32), claimedAt: field(raw.claimedAt, 64),
    finishedAt: field(raw.finishedAt, 64, true), delivery: field(raw.delivery, 32, true) };
  if (!['claimed', 'running', 'completed', 'failed'].includes(result.status)) fail('status');
  if (result.delivery !== null && !['delivered', 'failed', 'suppressed', 'suppressed_acked'].includes(result.delivery)) fail('delivery');
  const claimed = instant(result.claimedAt);
  const finished = result.finishedAt === null ? null : instant(result.finishedAt);
  if (claimed > observedInstant || finished !== null && (finished < claimed || finished > observedInstant)) fail('metadata');
  return result;
}
try {
  const previous = JSON.parse(process.argv[2]), now = process.argv[3], cutoff = process.argv[4];
  observedInstant = instant(now);
  const fileIdentity = identity();
  guard = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const stat = fs.fstatSync(guard, { bigint: true });
  if (!stat.isFile() || stat.dev + ':' + stat.ino !== fileIdentity) fail('identity');
  db = new DatabaseSync(process.argv[1], { readOnly: true });
  db.exec('PRAGMA busy_timeout=500; PRAGMA hard_heap_limit=8388608; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;');
  if (identity() !== fileIdentity) fail('identity');
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='executions'").get()) fail('schema');
  const columns = ['id', 'job_id', 'status', 'claimed_at', 'finished_at', 'delivery_outcome'];
  const projection = 'SELECT rowid, substr(id,1,129) AS id, substr(job_id,1,129) AS jobId, ' +
    'substr(status,1,33) AS status, substr(claimed_at,1,65) AS claimedAt, ' +
    'substr(finished_at,1,65) AS finishedAt, substr(delivery_outcome,1,33) AS delivery, (' +
    columns.map(name => '(coalesce(instr(' + name + ',char(0)),0)>0 OR typeof(' + name + ") NOT IN ('text'" +
      (name === 'finished_at' || name === 'delivery_outcome' ? ",'null'" : '') + '))').join(' OR ') + ') AS invalidMetadata FROM executions ';
  // Prepare even for an empty database so missing columns fail during baseline.
  const byId = db.prepare(projection + 'WHERE rowid = ?');
  const maximum = db.prepare('SELECT coalesce(max(rowid),0) AS value FROM executions').get().value;
  if (!Number.isSafeInteger(maximum) || maximum < 0) fail('schema');
  const reset = previous !== null && (previous.identity !== fileIdentity || maximum < previous.high);
  const cutoffInstant = instant(cutoff);
  let gap = previous && instant(previous.lastObservedAt) < cutoffInstant ? 'hermes-retention-gap' : null;
  const rows = [];
  function retain(entry) {
    if (instant(entry.claimedAt) < cutoffInstant) { gap = 'hermes-retention-gap'; return false; }
    return true;
  }
  let cursor;
  if (previous === null || reset) {
    const unfinished = db.prepare(projection + "WHERE status NOT IN ('completed','failed') OR status IS NULL OR delivery_outcome IS NULL ORDER BY rowid LIMIT 129").all();
    if (unfinished.length > 128) fail('pending-limit');
    const pending = unfinished.map(row).filter(retain).map(entry => ({ rowid: entry.rowid, id: entry.id, status: entry.status, delivery: entry.delivery }));
    // This is an existence check, not an unbounded metadata/body transfer.
    if (db.prepare('SELECT 1 FROM executions WHERE julianday(claimed_at) < julianday(?) LIMIT 1').get(cutoff)) gap = 'hermes-retention-gap';
    cursor = { identity: fileIdentity, baseline: maximum, high: maximum, revisit: maximum, floor: 0,
      since: now, lastObservedAt: now, pending, pendingIndex: 0 };
  } else {
    cursor = { ...previous, pending: [...previous.pending], lastObservedAt: now };
    const appended = db.prepare(projection + 'WHERE rowid > ? ORDER BY rowid LIMIT 16').all(previous.high).map(row);
    for (const entry of appended) { cursor.high = entry.rowid; if (retain(entry)) rows.push(entry); }
    const lower = Math.max(previous.baseline, previous.floor);
    const revisited = db.prepare(projection + 'WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 16').all(Math.max(previous.revisit, lower), previous.high).map(row);
    for (const entry of revisited) if (retain(entry)) rows.push(entry);
    cursor.revisit = revisited.length === 16 && revisited[15].rowid < previous.high ? revisited[15].rowid : lower;
    const removed = new Set(), pendingCount = previous.pending.length, count = Math.min(8, pendingCount);
    let capacityGap = false;
    for (let index = 0; index < pendingCount; index++) {
      if (previous.pending[index].rowid <= previous.floor) {
        removed.add(index);
        capacityGap = true;
      }
    }
    for (let offset = 0; offset < count; offset++) {
      const index = (previous.pendingIndex + offset) % pendingCount, original = previous.pending[index];
      if (removed.has(index)) continue;
      const raw = byId.get(original.rowid);
      if (!raw) { gap = 'hermes-pending-gap'; removed.add(index); continue; }
      const entry = row(raw);
      if (entry.id !== original.id) fail('identity');
      if (!retain(entry)) { removed.add(index); continue; }
      rows.push({ ...entry, baselineStatus: original.status, baselineDelivery: original.delivery });
      if ((entry.status === 'completed' || entry.status === 'failed') && entry.delivery !== null) removed.add(index);
    }
    if (capacityGap) gap = 'hermes-dedup-capacity-gap';
    cursor.pending = previous.pending.filter((_, index) => !removed.has(index));
    // Find the next surviving item in the original ring, including removals across its end.
    cursor.pendingIndex = 0;
    for (let offset = count; offset < count + pendingCount; offset++) {
      const index = (previous.pendingIndex + offset) % pendingCount;
      if (!removed.has(index)) {
        cursor.pendingIndex = index - [...removed].filter(removedIndex => removedIndex < index).length;
        break;
      }
    }
  }
  db.exec('COMMIT');
  if (identity() !== fileIdentity) fail('identity');
  response = { cursor, rows, coverage: { sourceId: 'hermes-events',
    state: reset || gap ? 'gap' : previous === null ? 'baseline' : cursor.high < maximum ? 'catching-up' : 'observing',
    since: cursor.since, observedAt: now, code: reset ? 'hermes-history-reset' : gap } };
} catch (error) {
  response = { error: error.eventCode || (error.code === 'ENOENT' ? 'missing' : error.code === 'ELOOP' ? 'identity' :
    error.errcode === 7 || error.errcode === 18 ? 'memory' : error.errcode === 5 || error.errcode === 6 ? 'locked' : 'schema') };
} finally {
  try { if (db) db.close(); }
  catch { response = { error: 'cleanup' }; }
  try { if (guard !== undefined) fs.closeSync(guard); }
  catch { response = { error: 'cleanup' }; }
}
process.stdout.write(JSON.stringify(response));
`

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function validateCursor(cursor: HermesEventCursor | null): void {
  if (cursor === null) return
  const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
  if (!cursor || !validText(cursor.identity, 128) || !/^\d+:\d+$/.test(cursor.identity) ||
      !counter(cursor.baseline) || !counter(cursor.high) || cursor.high < cursor.baseline ||
      !counter(cursor.revisit) || cursor.revisit < cursor.baseline || cursor.revisit > cursor.high ||
      !counter(cursor.floor) || cursor.floor > cursor.high ||
      !validInstant(cursor.since) || !validInstant(cursor.lastObservedAt) || cursor.lastObservedAt < cursor.since ||
      !Array.isArray(cursor.pending) || cursor.pending.length > 128 || !counter(cursor.pendingIndex) ||
      cursor.pendingIndex >= Math.max(1, cursor.pending.length)) throw new Error('Hermes 事件游标无效 / Invalid Hermes event cursor')
  const ids = new Set<number>()
  for (const item of cursor.pending) {
    if (!item || !counter(item.rowid) || item.rowid === 0 || item.rowid > cursor.baseline || ids.has(item.rowid) ||
        !validText(item.id, 128) || !['claimed', 'running', 'completed', 'failed'].includes(item.status) ||
        (item.delivery !== null && !['delivered', 'failed', 'suppressed', 'suppressed_acked'].includes(item.delivery))) {
      throw new Error('Hermes 事件游标无效 / Invalid Hermes event cursor')
    }
    ids.add(item.rowid)
  }
}

const failures: Record<string, string> = {
  missing: '无法打开 Hermes 事件数据库 / Cannot open Hermes event database',
  identity: 'Hermes 事件数据库身份无效或已变更 / Invalid or changed Hermes event database identity',
  metadata: 'Hermes 事件字段无效 / Invalid Hermes event metadata',
  schema: 'Hermes 事件数据库结构无效 / Invalid Hermes event database schema',
  status: 'Hermes 执行状态不受支持 / Unsupported Hermes execution status',
  delivery: 'Hermes 投递状态不受支持 / Unsupported Hermes delivery status',
  'pending-limit': 'Hermes 基线未完成记录超过 128 条，无法建立完整覆盖 / Hermes baseline pending limit exceeded (128)',
  memory: 'Hermes 事件读取超过内存预算 / Hermes event memory budget exceeded',
  locked: 'Hermes 事件数据库被锁定 / Hermes event database locked',
  cleanup: 'Hermes 事件读取资源关闭失败 / Hermes event resource cleanup failed'
}

export class HermesEventReader {
  constructor(private readonly databasePath = path.join(homedir(), '.hermes/cron/executions.db')) {}

  async read(cursor: HermesEventCursor | null, now: string, signal: AbortSignal): Promise<HermesEventRead> {
    if (signal.aborted) throw resourceAbortError()
    validateCursor(cursor)
    if (!validInstant(now) || (cursor && now < cursor.lastObservedAt)) throw new Error('Hermes 事件时间无效 / Invalid Hermes event time')
    // Copy only the fixed contract; caller-owned objects cannot enlarge the serialized request.
    const checkpoint = cursor && { identity: cursor.identity, baseline: cursor.baseline, high: cursor.high,
      revisit: cursor.revisit, floor: cursor.floor, since: cursor.since, lastObservedAt: cursor.lastObservedAt, pendingIndex: cursor.pendingIndex,
      pending: cursor.pending.map(({ rowid, id, status, delivery }) => ({ rowid, id, status, delivery })) }
    let stdout: string
    try {
      const result = await runBudgetedCommand('hermes-events', process.execPath,
        ['--max-old-space-size=32', '--max-semi-space-size=2', '-e', readerScript, this.databasePath,
          JSON.stringify(checkpoint), now, new Date(Date.parse(now) - EVENT_RETENTION_MS).toISOString()],
        { timeout: HERMES_EVENT_TIMEOUT_MS, maxBuffer: HERMES_EVENT_OUTPUT_BYTES,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, signal)
      stdout = result.stdout
    } catch (error) {
      if (isResourceAbort(error) || isResourceCleanupFailure(error)) throw error
      const failure = error as NodeJS.ErrnoException & { killed?: boolean }
      if (failure.code === 'OC_RESOURCE_LIMIT' || failure.code === 'OC_RESOURCE_QUEUE_TIMEOUT') throw error
      throw new Error(failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'Hermes 事件读取超过输出预算 / Hermes event output budget exceeded'
        : failure.killed ? 'Hermes 事件读取超时（3 秒） / Hermes event read timed out (3 seconds)'
          : 'Hermes 事件读取失败 / Hermes event read failed')
    }
    if (signal.aborted) throw resourceAbortError()
    let result: HermesEventRead & { error?: string }
    try { result = JSON.parse(stdout) as typeof result }
    catch { throw new Error('Hermes 事件响应无效 / Invalid Hermes event response') }
    if (result.error) throw new Error(Object.hasOwn(failures, result.error) ? failures[result.error] : failures.schema)
    validateCursor(result.cursor)
    if (!Array.isArray(result.rows) || result.rows.length > 40 || !result.coverage || result.coverage.sourceId !== 'hermes-events')
      throw new Error('Hermes 事件响应无效 / Invalid Hermes event response')
    return result
  }
}
