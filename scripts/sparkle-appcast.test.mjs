import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { verifyAppcast, combineAppcast, requireSparklePrivateKey } from './sparkle-appcast.mjs'
import { releaseChannels } from './dist.mjs'
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
    text => text.replace('<sparkle:channel>regular</sparkle:channel>', ''),
    text => text.replace('>regular<', '>unknown<'),
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

test('regular feed retains only the authenticated previous LTS', () => {
  const current = { archive, feed: appcast(archive), version: '1.2.3', channel: 'regular', publicKey, privateKey: privateSeed }
  const previous = { archive, version: '1.1.9', feed: appcast(archive, '1.1.9', xml => xml.replace('>regular<', '>lts<')) }
  assert.equal(combineAppcast(current), current.feed)
  const combined = combineAppcast({ ...current, previous })
  assert.deepEqual([...combined.toString().matchAll(/<sparkle:channel>(\w+)</g)].map(match => match[1]), ['regular', 'lts'])
  assert.equal(verify(combined).version, '1.2.3')
  assert.throws(() => verify(combined, { version: '1.1.9' }), /version mismatch/)
  for (const override of [{ version: '1.0.0' }, { archive: Buffer.alloc(archive.length) }, { feed: appcast(archive) }, { feed: previous.feed.subarray(0, 100) }]) {
    assert.throws(() => combineAppcast({ ...current, previous: { ...previous, ...override } }))
  }
})

test('release tags select the highest earlier LTS and require a marked current release', () => {
  const records = ['v1.0.0\tcommit\tHistorical release', 'v1.2.0\ttag\tOC Chan channel: lts', 'v1.10.0\ttag\tOC Chan channel: lts', 'v2.0.0\ttag\tOC Chan channel: regular']
  assert.deepEqual(releaseChannels('2.0.0', records.join('\n')), { channel: 'regular', previousLts: '1.10.0' })
  assert.deepEqual(releaseChannels('2.0.0', records.at(-1)), { channel: 'regular', previousLts: undefined })
  assert.deepEqual(releaseChannels('1.10.0', records.slice(0, 3).join('\n')), { channel: 'lts', previousLts: undefined })
  assert.throws(() => releaseChannels('1.0.0', records[0]), /explicit release channel/)
  assert.throws(() => releaseChannels('1.2.0', records.join('\n')), /newer version/)
})
