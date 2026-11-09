import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, symlink, link } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { download, readBounded } from './io'
import { MARKET_LIMITS, OFFICIAL_CATALOG, validateCatalog } from './validation'

test('文件读取在分配前拒绝超限、符号链接、硬链接与FIFO', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-market-io-'))
  try {
    const file = path.join(root, 'package')
    await writeFile(file, Buffer.alloc(33))
    await assert.rejects(readBounded(file, 32), /exceeds limit/)
    const symbolic = path.join(root, 'symlink')
    await symlink(file, symbolic)
    await assert.rejects(readBounded(symbolic, 64))
    const hard = path.join(root, 'hardlink')
    await link(file, hard)
    await assert.rejects(readBounded(hard, 64), /regular unlinked file/)
    if (process.platform !== 'win32') {
      const fifo = path.join(root, 'fifo')
      await promisify(execFile)('mkfifo', [fifo])
      await assert.rejects(readBounded(fifo, 64), /regular unlinked file/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('HTTP失败、内容长度超限和流超限均回收响应体并明确报错', async () => {
  for (const scenario of ['http', 'header', 'stream']) {
    let cancellations = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) { if (scenario === 'stream') controller.enqueue(new Uint8Array(33)) },
      cancel() { cancellations++ }
    })
    const fetcher: typeof fetch = async () => new Response(body, { status: scenario === 'http' ? 404 : 200, headers: scenario === 'header' ? { 'content-length': '33' } : {} })
    await assert.rejects(download(OFFICIAL_CATALOG, 32, fetcher, new AbortController().signal), scenario === 'http' ? /HTTP 404/ : /exceeds limit/)
    assert.equal(cancellations, 1)
  }
})

test('取消正在等待响应体的下载会取消stream并排空', async () => {
  const entered = Promise.withResolvers<void>()
  let cancellations = 0
  const body = new ReadableStream<Uint8Array>({ pull() { entered.resolve() }, cancel() { cancellations++ } })
  const controller = new AbortController()
  const reading = download(OFFICIAL_CATALOG, 32, async () => new Response(body), controller.signal)
  const rejected = assert.rejects(reading, { name: 'AbortError' })
  await entered.promise
  controller.abort()
  await rejected
  assert.equal(cancellations, 1)
})

test('损坏JSON、超大目录和非官方地址不进入网络装载', async () => {
  assert.throws(() => validateCatalog(Buffer.alloc(MARKET_LIMITS.catalogBytes + 1), '0.1.0'), /exceeds limit/)
  assert.throws(() => validateCatalog(Buffer.from('{broken'), '0.1.0'))
  let requested = false
  const fetcher: typeof fetch = async () => { requested = true; return new Response('{}') }
  await assert.rejects(download('https://example.com/package.ocplugin', 32, fetcher, new AbortController().signal), /official plugin source/)
  assert.equal(requested, false)
})
