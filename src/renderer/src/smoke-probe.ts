// Imported only by the isolated smoke Vite transform; never by product code.
type PendingAck = {
  send: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}
let held = false, disposed = false, releasing = false, duplicate = 0
let pending: PendingAck | null = null

export async function smokeAcknowledge(send: () => Promise<unknown>): Promise<unknown> {
  if (disposed) throw new DOMException('Smoke ACK document is closed', 'AbortError')
  if (!held) return send()
  if (pending) {
    duplicate++
    throw new Error('More than one unacknowledged push')
  }
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  pending = { send, resolve, reject }
  return promise
}

const control = Object.freeze({
  hold(): void {
    if (disposed) throw new Error('Smoke ACK document is closed')
    if (held || pending || releasing) throw new Error('Smoke ACK hold is already active')
    held = true
  },
  async release(): Promise<void> {
    if (disposed) throw new Error('Smoke ACK document is closed')
    if (!held) throw new Error('Smoke ACK hold is not active')
    const ack = pending
    pending = null
    held = false
    if (!ack) return
    releasing = true
    try {
      const value = await ack.send()
      ack.resolve(value)
    } catch (error) {
      ack.reject(error)
      throw error
    } finally {
      releasing = false
    }
  },
  state: () => ({ held, pending: pending ? 1 : 0, releasing, duplicate, disposed })
})
Object.defineProperty(window, '__ocSmokeAck', { value: control, writable: false, configurable: false, enumerable: false })
window.addEventListener('pagehide', () => {
  disposed = true
  held = false
  const ack = pending
  pending = null
  ack?.reject(new DOMException('Smoke ACK document is closed', 'AbortError'))
}, { once: true })
