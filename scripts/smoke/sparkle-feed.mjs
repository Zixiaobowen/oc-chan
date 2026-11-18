import { createServer } from 'node:http'
import { appcast, publicKey, signFeed } from '../sparkle-test-fixture.mjs'

export async function createSparkleFeed({ phase = 'available', version = '99.0.0' } = {}) {
  if (!['available', 'no-update', 'error'].includes(phase)) throw new Error('Unknown Sparkle acceptance phase')
  const archive = Buffer.from('acceptance probe does not download this archive')
  const item = (number, channel) => appcast(archive, number).toString().match(/<item>[\s\S]+?<\/item>/)[0].replace('<sparkle:channel>regular</sparkle:channel>', `<sparkle:channel>${channel}</sparkle:channel>`)
  const regular = item(phase === 'no-update' ? '0.1.0' : version, 'regular')
  const ltsVersion = '98.0.0'
  const lts = phase === 'available' ? item(ltsVersion, 'lts') : ''
  const payload = signFeed(`<?xml version="1.0" encoding="utf-8"?>\n<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel><title>OC Chan</title>${regular}${lts}</channel></rss>\n`)
  if (phase === 'error') payload[100] ^= 1
  let requests = 0
  const server = createServer((request, response) => {
    if (++requests > 32) { response.writeHead(429).end(); return }
    if (request.url !== '/appcast.xml') { response.writeHead(404).end(); return }
    response.writeHead(200, { 'Content-Type': 'application/rss+xml', 'Content-Length': payload.length, 'Cache-Control': 'no-store' }); response.end(payload)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${server.address().port}/appcast.xml`, publicKey,
    expectation: { expectedPhase: phase, ...(phase === 'available' ? { expectedVersion: version, ltsVersion } : {}) },
    close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }) }
}
