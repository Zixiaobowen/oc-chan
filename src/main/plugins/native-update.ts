import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { UpdateAsset } from './update-source'

export interface NativeUpdater {
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'update-downloaded' | 'update-not-available', listener: () => void): unknown
  removeListener(event: 'error', listener: (error: Error) => void): unknown
  removeListener(event: 'update-downloaded' | 'update-not-available', listener: () => void): unknown
  setFeedURL(options: { url: string; headers: Record<string, string> }): void
  checkForUpdates(): void
}

/** Resolve only after Squirrel has validated and staged the signed app. */
export async function stageNativeUpdate(native: NativeUpdater, file: string, asset: UpdateAsset, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if ((await stat(file)).size !== asset.size) throw new Error('更新包已改变 / Downloaded update has changed')
  signal.throwIfAborted()
  const token = randomBytes(32).toString('hex')
  const feedPath = `/${token}/feed`
  const zipPath = `/${token}/update.zip`
  const authorization = `Basic ${Buffer.from(`oc-chan:${token}`).toString('base64')}`
  let baseUrl = ''
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 }, (request, response) => {
    if (request.method !== 'GET') { response.writeHead(405).end(); return }
    if (request.url === feedPath && request.headers.authorization === authorization) {
      const body = JSON.stringify({ url: `${baseUrl}${zipPath}`, name: asset.version, notes: '', pub_date: new Date().toISOString(), size: asset.size })
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }).end(body)
    } else if (request.url === zipPath) {
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': asset.size, 'Cache-Control': 'no-store' })
      void pipeline(createReadStream(file, { highWaterMark: 64 * 1024 }), response).catch(error => {
        response.destroy(error)
        console.error('[app-updates] Native update transfer failed:', error.message)
      })
    } else response.writeHead(404).end()
  })
  server.maxConnections = 2
  server.maxRequestsPerSocket = 4
  server.setTimeout(30_000, socket => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new Error('Cannot start native update feed') }
  baseUrl = `http://127.0.0.1:${address.port}`
  await new Promise<void>((resolve, reject) => {
    let finished = false
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
      native.removeListener('error', onError)
      native.removeListener('update-downloaded', onDownloaded)
      native.removeListener('update-not-available', onUnavailable)
      server.removeListener('error', onError)
      server.closeAllConnections()
      server.close()
    }
    const onError = (error: Error) => {
      if (finished) return
      finished = true
      cleanup()
      reject(error)
    }
    const onAbort = () => onError(signal.reason instanceof Error ? signal.reason : new Error('Update installation cancelled'))
    const onUnavailable = () => onError(new Error('原生更新器未接受更新 / Native updater rejected the update'))
    const onDownloaded = () => {
      if (finished) return
      finished = true
      cleanup()
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    native.on('error', onError)
    native.on('update-downloaded', onDownloaded)
    native.on('update-not-available', onUnavailable)
    server.on('error', onError)
    if (signal.aborted) { onAbort(); return }
    try {
      native.setFeedURL({ url: `${baseUrl}${feedPath}`, headers: { Authorization: authorization, 'Cache-Control': 'no-store' } })
      native.checkForUpdates()
    } catch (error) { onError(error instanceof Error ? error : new Error(String(error))) }
  })
}
