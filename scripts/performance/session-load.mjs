import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { boundedFile } from '../smoke/main-probe.mjs'

// Keep each real descriptor's inode: truncation exercises the production reader reset.
export class SessionLoad {
  constructor(manifest) { this.manifest = manifest; this.identities = []; this.headers = []; this.rotations = 0 }
  async initialize() {
    for (const file of this.manifest.agentFiles) {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { const stat = await handle.stat(); this.identities.push({ dev: stat.dev, ino: stat.ino }); this.headers.push(await boundedFile(file, 4096)) }
      finally { await handle.close() }
    }
  }
  async owned(index) {
    const handle = await open(this.manifest.agentFiles[index], constants.O_RDWR | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat(), expected = this.identities[index]
      if (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > 512 * 1024) throw new Error('Session load file identity/budget changed')
      return { handle, size: stat.size }
    } catch (error) { await handle.close(); throw error }
  }
  async write(count, sequence) {
    if (![32,128].includes(count) || count > this.identities.length || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid session load')
    let bytes = 0
    for (let offset = 0; offset < count; offset += 8) {
      const results = await Promise.allSettled(Array.from({ length: Math.min(8, count - offset) }, async (_, delta) => {
      const index = offset + delta, { handle, size } = await this.owned(index)
      try {
        const line = Buffer.from(JSON.stringify({ type: 'custom', customType: 'tool_execution_start', timestamp: new Date().toISOString(), data: { toolCallId: `performance:${index}`, toolName: `perf_${index}_${sequence}` } }) + '\n')
        let position = size
        if (position + line.length > 256 * 1024) {
          await handle.truncate(0)
          const header = this.headers[index]
          if ((await handle.write(header, 0, header.length, 0)).bytesWritten !== header.length) throw new Error('Short session header write')
          position = header.length; this.rotations++
        }
        const written = await handle.write(line, 0, line.length, position)
        if (written.bytesWritten !== line.length) throw new Error('Short session fixture write')
        bytes += written.bytesWritten
      } finally { await handle.close() }
      }))
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Fixture writes failed after all admitted writes drained')
    }
    return { count, sequence, bytes, rotations: this.rotations }
  }
  async rotate() {
    for (let index = 0; index < this.identities.length; index++) {
      const { handle } = await this.owned(index)
      try { await handle.truncate(0); const bytes = this.headers[index]; const written = await handle.write(bytes, 0, bytes.length, 0); if (written.bytesWritten !== bytes.length) throw new Error('Short session rotation'); this.rotations++ }
      finally { await handle.close() }
    }
  }
  async oversized(inspect) {
    const { handle, size } = await this.owned(0)
    try {
      const bytes = Buffer.alloc(192 * 1024, 120); bytes[bytes.length - 1] = 10
      if (size + bytes.length > 512 * 1024) throw new Error('Oversized fixture budget exceeded')
      if ((await handle.write(bytes, 0, bytes.length, size)).bytesWritten !== bytes.length) throw new Error('Short oversized write')
      return await inspect()
    } finally { try { await handle.truncate(size) } finally { await handle.close() } }
  }
}
