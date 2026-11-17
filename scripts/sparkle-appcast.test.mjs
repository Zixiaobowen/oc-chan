import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { verifyAppcast, requireSparklePrivateKey } from './sparkle-appcast.mjs'
import { appcast, signFeed, publicKey, privateSeed } from './sparkle-test-fixture.mjs'

const archive = Buffer.from('actual bytes authenticated by Ed25519')
const verify = (feed, overrides = {}) => verifyAppcast({ feed, archive, version: '1.2.3', publicKey, ...overrides })
test('authenticates official Sparkle trailer and archive using real Ed25519', () => {
  assert.equal(verify(appcast(archive)).length, archive.length)
  assert.doesNotThrow(() => requireSparklePrivateKey(privateSeed, publicKey))
})
test('rejects forged feed, forged archive, wrong key and altered trailer length', () => {
  const feed = appcast(archive)
  assert.throws(() => verify(Buffer.from(feed.toString().replace('更新说明', '伪造说明'))), /signature/)
  assert.throws(() => verify(feed, { archive: Buffer.alloc(archive.length) }), /Archive Ed25519/)
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
  assert.throws(() => verify(feed, { publicKey: other }), /signature/)
  assert.throws(() => verify(Buffer.from(feed.toString().replace(/\nlength: \d+/, '\nlength: 1'))), /length/)
  assert.throws(() => verify(Buffer.concat([feed, Buffer.from('extra')])), /signature/)
  assert.throws(() => verify(feed.subarray(0, feed.indexOf('<!-- sparkle-signatures:'))), /Missing signed/)
})
test('rejects unsupported signed XML rather than interpreting a permissive subset', () => {
  const invalid = [
    text => text.replace('<rss ', '<!DOCTYPE rss SYSTEM "https://example.invalid/entity"><rss '),
    text => text.replace('<channel>', '<channel><item/>'),
    text => text.replace('</item>', '<sparkle:deltas/></item>'),
    text => text.replace('</item>', '<sparkle:releaseNotesLink>https://example.invalid</sparkle:releaseNotesLink></item>'),
    text => text.replace('version="2.0"', 'version="2.0" version="2.0"'),
    text => text.replace('www.andymatuschak.org', 'attacker.invalid'),
    text => text.replace('<title>OC Chan</title>', '<title>&external;</title>'),
    text => text.replace('</channel>', '</rss>'),
    text => text.replace('releases/download/v1.2.3/', 'releases/latest/download/'),
    text => text.replace('<sparkle:version>1.2.3', '<sparkle:version>9.9.9'),
    text => text.replace(`length="${archive.length}"`, 'length="1"'),
    text => text.replace('type="application/octet-stream"', 'type="text/html"'),
    text => text.replace('sparkle:edSignature="', 'sparkle:edSignature="A'),
  ]
  for (const mutate of invalid) assert.throws(() => verify(appcast(archive, '1.2.3', mutate)))
})
test('enforces bounds and verifies signature before attempting XML parsing', () => {
  assert.throws(() => verify(Buffer.alloc(256 * 1024 + 1)), /budget/)
  const unsignedInvalidXML = Buffer.from('not XML<!-- sparkle-signatures:\nedSignature: ' + Buffer.alloc(64).toString('base64') + '\nlength: 7\n-->\n')
  assert.throws(() => verify(unsignedInvalidXML), /signature/)
  assert.throws(() => verify(signFeed('not XML')), /XML/)
})
test('accepts only canonical 32-byte seed matching configured public key', () => {
  for (const value of ['', privateSeed + '\n', Buffer.alloc(64).toString('base64'), 'x'.repeat(1000)]) assert.throws(() => requireSparklePrivateKey(value, publicKey))
  assert.throws(() => requireSparklePrivateKey(Buffer.alloc(32).toString('base64'), publicKey), /does not match/)
})
