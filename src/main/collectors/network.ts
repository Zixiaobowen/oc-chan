import { runBudgetedCommand } from '../resource-io'
import { throwIfAborted } from '../resource-budget'

const MAX_OUTPUT_BYTES = 64 * 1024
interface Counters { received: number; sent: number }
interface Sample extends Counters { iface: string; at: number }
type Command = (file: string, args: string[], signal?: AbortSignal) => Promise<string>
const command: Command = async (file, args, signal) => (await runBudgetedCommand('system-network', file, args,
  { timeout: 4000, maxBuffer: MAX_OUTPUT_BYTES, env: { ...process.env, LC_ALL: 'C' } }, signal)).stdout

export function parseDefaultInterface(output: string): string {
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new Error('默认路由输出超过限制')
  const matches = [...output.matchAll(/^\s*interface:\s*(\S+)\s*$/gm)]
  if (matches.length !== 1 || !/^[a-z][a-z0-9._:-]{0,31}$/.test(matches[0][1])) throw new Error('没有可用的默认网络接口')
  return matches[0][1]
}

export function parseNetworkCounters(output: string, iface: string): Counters {
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new Error('网络统计输出超过限制')
  const lines = output.trim().split('\n')
  const headers = lines[0].trim().split(/\s+/)
  const rxIndex = headers.indexOf('Ibytes'), txIndex = headers.indexOf('Obytes')
  if (headers[0] !== 'Name' || headers[2] !== 'Network' || rxIndex < 3 || txIndex <= rxIndex) throw new Error('网络统计表结构无法识别')
  let counters: Counters | undefined
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/)
    if ((fields[0] !== iface && fields[0] !== `${iface}*`) || !/^<Link#\d+>$/.test(fields[2] ?? '')) continue
    if (counters || fields.length < headers.length - 1 || fields.length > headers.length) throw new Error('网络接口统计行不完整或重复')
    // Some interfaces omit the link-layer address. Numeric counters remain right-aligned with their headings.
    const rx = fields[fields.length - headers.length + rxIndex], tx = fields[fields.length - headers.length + txIndex]
    if (!/^\d+$/.test(rx) || !/^\d+$/.test(tx)) throw new Error('网络接口计数器无效')
    const received = Number(rx), sent = Number(tx)
    if (!Number.isSafeInteger(received) || !Number.isSafeInteger(sent)) throw new Error('网络接口计数器超过安全范围')
    counters = { received, sent }
  }
  if (!counters) throw new Error('网络接口未返回链路计数器')
  return counters
}

export class NetworkReader {
  private previous?: Sample
  private readonly controller = new AbortController()
  constructor(private readonly run: Command = command, private readonly now: () => number = () => performance.now()) {}

  dispose(): void {
    this.controller.abort()
    this.previous = undefined
  }

  async read(signal?: AbortSignal): Promise<{ iface: string; rxBytesPerSecond: number | null; txBytesPerSecond: number | null }> {
    signal = signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal
    try {
      throwIfAborted(signal)
      const iface = parseDefaultInterface(await this.run('/sbin/route', ['-n', 'get', 'default'], signal))
      throwIfAborted(signal)
      const counters = parseNetworkCounters(await this.run('/usr/sbin/netstat', ['-bdnI', iface], signal), iface)
      throwIfAborted(signal)
      const current = { iface, ...counters, at: this.now() }
      const previous = this.previous
      this.previous = current
      const elapsed = previous ? (current.at - previous.at) / 1000 : 0
      const continuous = previous && previous.iface === iface && elapsed > 0 && counters.received >= previous.received && counters.sent >= previous.sent
      return { iface, rxBytesPerSecond: continuous ? (counters.received - previous.received) / elapsed : null,
        txBytesPerSecond: continuous ? (counters.sent - previous.sent) / elapsed : null }
    } catch (error) {
      this.previous = undefined
      throw error
    }
  }
}
