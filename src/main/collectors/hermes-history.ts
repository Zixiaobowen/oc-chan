import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ScheduledJob, ScheduleHistory } from '../../shared/types'
import type { ScheduleHistoryProvider } from '../schedule-history'

export const HISTORY_PAGE_SIZE = 25
export const MAX_HISTORY_OFFSET = 100_000
export const HISTORY_OUTPUT_BYTES = 128 * 1024
export const HISTORY_TIMEOUT_MS = 3000

// SQL and date validation execute in a finite process, including scans needed for ordering.
// Only bounded metadata crosses the process boundary; never select error/prompt/output bodies.
const readerScript = String.raw`
const { DatabaseSync } = require('node:sqlite');
let db;
function field(value, max, optional = false) {
  if (optional && value === null) return undefined;
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error('metadata');
  return value;
}
function instant(value) {
  field(value, 64);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new Error('timestamp');
  const local = match[1] + 'T' + match[2];
  const milliseconds = Date.parse(local + 'Z');
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== local)
    throw new Error('timestamp');
  const hours = Number(match[6] || 0), minutes = Number(match[7] || 0);
  if (hours > 23 || minutes > 59) throw new Error('timestamp');
  const offset = (hours * 60 + minutes) * 60000 * (match[5] === '-' ? -1 : 1);
  const utc = new Date(milliseconds - offset).toISOString();
  if (utc.length !== 24) throw new Error('timestamp');
  // Fixed-width UTC seconds and nine fractional digits preserve even sub-millisecond order.
  return utc.slice(0, 19) + '.' + (match[3] || '').padEnd(9, '0');
}
try {
  db = new DatabaseSync(process.argv[1], { readOnly: true });
  db.exec('PRAGMA hard_heap_limit=8388608; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA busy_timeout=500; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
  db.function('history_instant', { deterministic: true }, instant);
  const rows = db.prepare(
    'SELECT substr(id,1,129) AS id, substr(job_id,1,129) AS jobId, substr(status,1,33) AS status, ' +
    'substr(claimed_at,1,65) AS claimedAt, substr(started_at,1,65) AS startedAt, ' +
    'substr(finished_at,1,65) AS finishedAt, substr(delivery_outcome,1,33) AS delivery, ' +
    'instr(id,char(0)) + instr(job_id,char(0)) + instr(status,char(0)) + instr(claimed_at,char(0)) + ' +
    'coalesce(instr(started_at,char(0)),0) + coalesce(instr(finished_at,char(0)),0) + ' +
    'coalesce(instr(delivery_outcome,char(0)),0) AS metadataNul ' +
    'FROM executions WHERE job_id = ? ' +
    'ORDER BY history_instant(substr(claimed_at,1,65)) DESC, substr(id,1,129) COLLATE BINARY DESC LIMIT ? OFFSET ?'
  ).all(process.argv[2], Number(process.argv[4]) + 1, Number(process.argv[3]));
  const entries = rows.map(row => {
    if (row.metadataNul) throw new Error('metadata');
    const id = field(row.id, 128);
    if (field(row.jobId, 128) !== process.argv[2]) throw new Error('job');
    const status = field(row.status, 32), delivery = field(row.delivery, 32, true);
    const claimedAt = field(row.claimedAt, 64), claimed = instant(claimedAt);
    const startedAt = field(row.startedAt, 64, true), finishedAt = field(row.finishedAt, 64, true);
    const started = startedAt === undefined ? undefined : instant(startedAt);
    const finished = finishedAt === undefined ? undefined : instant(finishedAt);
    if (started !== undefined && started < claimed || finished !== undefined && finished < (started ?? claimed))
      throw new Error('time order');
    return { id, claimedAt, ...(startedAt === undefined ? {} : { startedAt }),
      ...(finishedAt === undefined ? {} : { finishedAt }),
      status: status === 'completed' ? 'succeeded' : ['claimed', 'running', 'failed'].includes(status) ? status : 'unknown',
      ...(delivery === undefined ? {} : { delivery: delivery === 'delivered' || delivery === 'failed' ? delivery
        : delivery === 'suppressed' || delivery === 'suppressed_acked' ? 'skipped' : 'unknown' }) };
  });
  process.stdout.write(JSON.stringify({ entries: entries.slice(0, Number(process.argv[4])), hasMore: entries.length > Number(process.argv[4]) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ sqliteError: Number.isInteger(error.errcode) ? error.errcode : -1 }));
} finally { if (db) db.close(); }
`

function cancelled(): Error {
  const error = new Error('执行历史读取已取消 / History read cancelled')
  error.name = 'AbortError'
  return error
}

function sqliteFailure(code: number): Error {
  const reason = code === 14 ? '无法打开执行历史数据库 / Cannot open history database'
    : code === 7 || code === 18 ? '执行历史超过内存预算 / History memory budget exceeded'
      : code === 5 || code === 6 ? '执行历史数据库被锁定 / History database locked'
        : '执行历史结构或字段无效 / Invalid history database or metadata'
  return new Error(reason)
}

export class HermesHistoryProvider implements ScheduleHistoryProvider {
  constructor(private readonly databasePath = path.join(homedir(), '.hermes/cron/executions.db')) {}

  supports(job: ScheduledJob): boolean {
    return job.id.startsWith('hermes-job:')
  }

  read(job: ScheduledJob, offset: number, signal: AbortSignal): Promise<ScheduleHistory> {
    if (signal.aborted) return Promise.reject(cancelled())
    const id = job.id.slice('hermes-job:'.length)
    if (!this.supports(job) || !id || id.length > 128 || id.includes('\0'))
      return Promise.reject(new Error('Hermes 任务标识无效 / Invalid Hermes job identifier'))
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_HISTORY_OFFSET)
      return Promise.reject(new Error('执行历史页码超出范围 / History offset out of range'))
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ['--max-old-space-size=32', '--max-semi-space-size=2',
        '-e', readerScript, this.databasePath, id, String(offset), String(HISTORY_PAGE_SIZE)], {
        timeout: HISTORY_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: HISTORY_OUTPUT_BYTES,
        encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      }, (error, stdout) => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) { reject(cancelled()); return }
        if (error) {
          reject(new Error(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? '执行历史超过输出预算 / History output budget exceeded'
            : error.killed ? '执行历史读取超时（3 秒） / History read timed out (3 seconds)'
              : '执行历史读取失败 / History read failed'))
          return
        }
        try {
          const result = JSON.parse(stdout) as { sqliteError?: number; entries?: ScheduleHistory['entries']; hasMore?: boolean }
          if (result.sqliteError !== undefined) throw sqliteFailure(result.sqliteError)
          if (!Array.isArray(result.entries) || result.entries.length > HISTORY_PAGE_SIZE || typeof result.hasMore !== 'boolean')
            throw new Error('执行历史响应无效 / Invalid history response')
          resolve({ jobId: job.id, source: 'hermes', entries: result.entries, offset, limit: HISTORY_PAGE_SIZE,
            hasMore: result.hasMore, collectedAt: new Date().toISOString() })
        } catch (failure) {
          reject(failure instanceof SyntaxError ? new Error('执行历史响应无效 / Invalid history response') : failure)
        }
      })
      const abort = (): void => { child.kill('SIGKILL') }
      signal.addEventListener('abort', abort, { once: true })
    })
  }
}
