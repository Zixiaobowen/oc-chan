import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { ScheduledJob, SourceStatus } from '../../shared/types'
import { collectionResources, isResourceCleanupFailure, ResourceCleanupError, throwIfAborted } from '../resource-budget'
import { runBudgetedCommand } from '../resource-io'
export const MAX_METADATA_BYTES = 1024 * 1024
export const MAX_HERMES_JOBS = 256
const CLAIM_TTL_MS = 300_000 // Hermes cron/constants.py: FIRE_CLAIM_TTL_SECONDS.

export interface HermesJobMetadata {
  id: string
  enabled?: boolean
  state?: string
  fireClaimAt?: string | null
  lastRunAt?: string
  lastStatus?: string
}
interface Execution {
  id: string
  jobId: string
  status: 'claimed' | 'running' | 'completed' | 'failed' | 'unknown'
  pid: number
  processStartedAt: number | null
  claimedAt: string
  finishedAt?: string | null
}
interface Runtime {
  latest: Map<string, Execution>
  processes: Map<number, number>
}
export class ReadFailure extends Error {}

export async function readScheduleMetadata(file: string, signal?: AbortSignal): Promise<unknown> {
  return collectionResources.run({ source: 'schedule-metadata', kind: 'file', bytes: MAX_METADATA_BYTES + 1, signal }, async () => {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    let failure: unknown
    try {
      const info = await handle.stat()
      throwIfAborted(signal)
      if (!info.isFile()) throw new ReadFailure('任务配置不是普通文件')
      const { size } = info
      if (size > MAX_METADATA_BYTES) throw new ReadFailure('任务配置超过 1 MiB 读取上限')
      const buffer = Buffer.alloc(size + 1)
      let bytes = 0
      while (bytes < buffer.length) {
        throwIfAborted(signal)
        const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, null)
        if (!bytesRead) break
        bytes += bytesRead
      }
      throwIfAborted(signal)
      if (bytes > size) throw new ReadFailure('任务配置在读取期间发生变化')
      return JSON.parse(buffer.toString('utf8', 0, bytes))
    } catch (error) { failure = error; throw error }
    finally {
      try { await handle.close() }
      catch (error) { throw new ResourceCleanupError('file', failure ? new AggregateError([failure, error]) : error) }
    }
  })
}

function timestamp(value: unknown): number {
  return typeof value === 'string' && value.length <= 64 && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN
}

function lastRun(job: HermesJobMetadata, now: number): ScheduledJob['lastRun'] {
  if (!job.lastRunAt && !job.lastStatus) return undefined
  const at = timestamp(job.lastRunAt)
  const result: NonNullable<ScheduledJob['lastRun']>['result'] = job.lastStatus === 'ok' ? 'succeeded'
    : job.lastStatus === 'error' ? 'failed' : job.lastStatus === 'delivery_failed' ? 'delivery-failed'
      : job.lastStatus === 'blocked_config' ? 'blocked' : 'unknown'
  return { result, at: Number.isFinite(at) && at <= now ? new Date(at).toISOString() : undefined }
}

export function hermesJobStatus(job: HermesJobMetadata, runtime: Runtime | null, now: number):
Pick<ScheduledJob, 'state' | 'stateReason' | 'pid' | 'lastRun'> {
  const result = { lastRun: lastRun(job, now) }
  const disabled = job.enabled === false || job.state === 'paused' || job.state === 'completed'
  const hasClaim = job.fireClaimAt !== undefined
  if (!runtime) return disabled && !hasClaim ? { ...result, state: 'disabled' }
    : { ...result, state: 'unknown', stateReason: 'hermes-read-failed' }
  const execution = runtime.latest.get(job.id)
  if (execution && ['completed', 'failed', 'unknown'].includes(execution.status) &&
    !(timestamp(result.lastRun?.at) >= timestamp(execution.claimedAt))) {
    const finished = timestamp(execution.finishedAt)
    result.lastRun = { result: execution.status === 'completed' ? 'succeeded' : execution.status === 'failed' ? 'failed' : 'unknown',
      at: Number.isFinite(finished) && finished <= now ? new Date(finished).toISOString() : undefined }
  }
  const inFlight = execution?.status === 'running' || execution?.status === 'claimed'
  const claimedAt = timestamp(job.fireClaimAt)
  const fresh = now >= claimedAt && now - claimedAt < CLAIM_TTL_MS
  if (inFlight && execution.status === 'running' && fresh && timestamp(execution.claimedAt) <= now && execution.processStartedAt !== null) {
    const started = runtime.processes.get(execution.pid)
    // macOS ps has second precision; Hermes stores centiseconds with a 2 s drift tolerance.
    if (started !== undefined && Math.abs(started - execution.processStartedAt / 100) <= 2)
      return { ...result, state: 'running', pid: execution.pid }
  }
  if (inFlight || hasClaim) return { ...result, state: 'unknown',
    stateReason: execution?.status === 'claimed' && fresh ? 'hermes-dispatching' : 'hermes-unconfirmed' }
  if (disabled) return { ...result, state: 'disabled' }
  if (job.enabled === true && job.state === 'scheduled') return { ...result, state: 'waiting' }
  return { ...result, state: 'unknown', stateReason: 'hermes-state-unsupported' }
}

function failureDetail(error: unknown): string {
  if (error instanceof ReadFailure) return error.message
  const failure = error as NodeJS.ErrnoException & { killed?: boolean }
  if (failure?.code === 'OC_RESOURCE_LIMIT') return '执行状态读取达到共享资源上限'
  if (failure?.code === 'OC_RESOURCE_QUEUE_TIMEOUT') return '执行状态读取等待共享资源超时'
  if (failure?.code === 'ENOENT') return '执行记录文件或读取命令不存在'
  if (failure?.code === 'EACCES' || failure?.code === 'EPERM') return '没有读取执行记录的权限'
  if (failure?.killed) return '执行状态读取超时（3 秒）'
  if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return '执行记录超过 4 MiB 输出上限'
  return '执行状态读取失败；无法确认当前运行状态'
}

async function readExecutions(file: string, ids: string[], signal?: AbortSignal): Promise<Map<string, Execution>> {
  if (ids.length > MAX_HERMES_JOBS) throw new ReadFailure('Hermes 任务超过 256 条读取上限')
  if (ids.some(id => !id || id.length > 128 || id.includes('\0'))) throw new ReadFailure('Hermes 任务标识无效或超过 128 字符')
  if (!ids.length) return new Map()
  // Select one execution per job inside SQLite; history size must not determine availability.
  const sql = `SELECT substr(id,1,129) AS id, substr(job_id,1,129) AS jobId, substr(status,1,33) AS status,
      pid, process_started_at AS processStartedAt, substr(claimed_at,1,65) AS claimedAt,
      substr(finished_at,1,65) AS finishedAt
    FROM executions WHERE job_id = ?
    ORDER BY execution_instant(substr(claimed_at,1,65)) DESC,
      substr(claimed_at,1,65) COLLATE BINARY DESC, substr(id,1,129) COLLATE BINARY DESC LIMIT 1;`
  // Electron's bundled SQLite reads WAL databases without depending on macOS sqlite3's
  // read-only sidecar behavior. A finite child keeps synchronous SQL and its heap off the UI process.
  const reader = String.raw`
    const { DatabaseSync } = require('node:sqlite');
    let db;
    try {
      db = new DatabaseSync(process.argv[1], { readOnly: true });
      db.exec('PRAGMA busy_timeout=500; PRAGMA hard_heap_limit=8388608; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;');
      // Match Date.parse precision; SQLite date functions can round across millisecond boundaries.
      db.function('execution_instant', { deterministic: true }, value => {
        const at = typeof value === 'string' && value.length <= 64 && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
        if (!Number.isFinite(at)) throw new Error('Invalid execution timestamp');
        return at;
      });
      const statement = db.prepare(process.argv[2]);
      const rows = [];
      for (const id of JSON.parse(process.argv[3])) {
        const row = statement.get(id);
        if (row) rows.push(row);
      }
      process.stdout.write(JSON.stringify(rows));
    } catch (error) {
      process.stdout.write(JSON.stringify({ sqliteError: Number.isInteger(error.errcode) ? error.errcode : -1 }));
    } finally { if (db) db.close(); }
  `
  const { stdout } = await runBudgetedCommand('hermes-executions', process.execPath, ['--max-old-space-size=32', '--max-semi-space-size=2',
    '-e', reader, file, sql, JSON.stringify(ids)], { timeout: 3000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, signal)
  const rows: unknown = JSON.parse(stdout)
  if (rows && typeof rows === 'object' && 'sqliteError' in rows) {
    const reason = rows.sqliteError === 14 ? '无法打开 Hermes 执行数据库'
      : rows.sqliteError === 7 || rows.sqliteError === 18 ? 'Hermes 执行数据库超过 8 MiB SQLite 内存预算'
        : rows.sqliteError === 5 || rows.sqliteError === 6 ? 'Hermes 执行数据库正被锁定'
          : 'Hermes 执行数据库结构或内容无效'
    throw new ReadFailure(`${reason}（SQLite ${rows.sqliteError}）`)
  }
  if (!Array.isArray(rows)) throw new ReadFailure('Hermes 执行记录格式无效')
  if (rows.length > ids.length) throw new ReadFailure('Hermes 最新执行记录超过请求任务数量')
  const latest = new Map<string, Execution>()
  const allowed = new Set(ids)
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id || row.id.length > 128 ||
      !allowed.has(row.jobId) || !['claimed', 'running', 'completed', 'failed', 'unknown'].includes(row.status) ||
      !Number.isSafeInteger(row.pid) || row.pid <= 0 ||
      !(row.processStartedAt === null || Number.isSafeInteger(row.processStartedAt) && row.processStartedAt > 0) ||
      !(row.finishedAt === null || Number.isFinite(timestamp(row.finishedAt))) ||
      !Number.isFinite(timestamp(row.claimedAt))) throw new ReadFailure('Hermes 执行记录字段无效')
    if (latest.has(row.jobId)) throw new ReadFailure('Hermes 最新执行记录重复')
    latest.set(row.jobId, row)
  }
  return latest
}

async function readProcesses(latest: Map<string, Execution>, signal?: AbortSignal): Promise<Map<number, number>> {
  const pids = [...new Set([...latest.values()].filter(row => row.status === 'running').map(row => row.pid))]
  const processes = new Map<number, number>()
  if (!pids.length) return processes
  let stdout: string
  try {
    const result = await runBudgetedCommand('hermes-processes', '/bin/ps', ['-p', pids.join(','), '-o', 'pid=,lstart=,stat='], {
      timeout: 3000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
    }, signal)
    stdout = result.stdout
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    // ps exits 1 with no output when all requested PIDs have exited.
    if (failure.code === 1 && !failure.stdout?.trim() && !failure.stderr?.trim()) return processes
    throw error
  }
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const match = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)\s*$/)
    if (!match) throw new ReadFailure('无法解析执行进程的启动时间')
    const started = Date.parse(`${match[2]} UTC`) / 1000
    if (!Number.isFinite(started)) throw new ReadFailure('执行进程的启动时间无效')
    if (!match[3].includes('Z')) processes.set(Number(match[1]), started)
  }
  return processes
}

export async function collectHermesRuntime(jobs: HermesJobMetadata[], file: string, signal?: AbortSignal): Promise<{
  statuses: Map<string, Pick<ScheduledJob, 'state' | 'stateReason' | 'pid' | 'lastRun'>>
  source: SourceStatus
}> {
  let runtime: Runtime | null = null
  let failure: string | undefined
  try {
    const latest = await readExecutions(file, [...new Set(jobs.map(job => job.id))], signal)
    runtime = { latest, processes: await readProcesses(latest, signal) }
  } catch (error) {
    if (signal?.aborted || isResourceCleanupFailure(error)) throw error
    failure = failureDetail(error)
  }
  const now = Date.now()
  const statuses = new Map(jobs.map(job => [job.id, hermesJobStatus(job, runtime, now)]))
  const unknown = [...statuses.values()].filter(job => job.state === 'unknown').length
  return { statuses, source: { id: 'hermes-runtime', label: 'Hermes 执行状态', state: failure || unknown ? 'partial' : 'ok',
    detail: failure ?? `已核对 ${statuses.size} 条任务的执行记录与心跳；${unknown} 条当前状态未确认。每次最多读取 256 条任务，每个任务只返回最新执行记录；不读取执行正文。` } }
}
