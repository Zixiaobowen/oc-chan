import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { readBounded } from './rust-dependencies.mjs'
import { readSparkleConfig, ensureSparkleSDK } from './sparkle-sdk.mjs'

const MAX_ARCHIVE = 512 * 1024 * 1024
const namespace = 'http://www.andymatuschak.org/xml-namespaces/sparkle'
export function readUpdateArchive(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0 || before.size > MAX_ARCHIVE) throw new Error('Invalid update archive or 512MiB budget exceeded')
    const bytes = Buffer.allocUnsafe(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (!count) break
      offset += count
    }
    const after = fstatSync(fd)
    if (offset !== before.size || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Update archive changed during read')
    return bytes.subarray(0, offset)
  } finally { closeSync(fd) }
}
async function runGenerator(command, args, input, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let failure, bytes = 0
    const stop = reason => {
      failure ??= new Error(reason)
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') failure = new Error('Could not stop Sparkle generator process group') }
      }
    }
    const timer = setTimeout(() => stop('Sparkle generator exceeded its time budget'), 120_000)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) stop('Sparkle generator exceeded its output budget')
    })
    child.on('error', () => stop('Could not start official Sparkle generator'))
    child.stdin.on('error', () => stop('Could not deliver Sparkle signing input'))
    child.on('close', code => {
      clearTimeout(timer)
      if (failure || code !== 0) reject(failure ?? new Error('Official Sparkle appcast generation failed'))
      else resolve()
    })
    child.stdin.end(input)
  })
}
export function decodeKey(value, length) {
  if (typeof value !== 'string' || value.length > 128) throw new Error('Invalid Sparkle key or signature')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== length || bytes.toString('base64') !== value) throw new Error('Invalid Sparkle key or signature')
  return bytes
}
export function requireSparklePrivateKey(value, publicKey = readSparkleConfig().publicKey) {
  const seed = decodeKey(value, 32)
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
  const derived = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
  if (!derived.equals(decodeKey(publicKey, 32))) throw new Error('SPARKLE_PRIVATE_KEY does not match the configured public key')
  return key
}
const publicObject = value => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decodeKey(value, 32)]), format: 'der', type: 'spki' })
const decodeText = text => {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(text)) throw new Error('Unsupported XML entity')
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity])
}
// Deliberately accepts only the bounded XML subset emitted by our pinned generator.
// No DTD, entities, processing instructions, namespaces other than Sparkle, or unknown elements.
function parseXML(text) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text)) throw new Error('Unsupported XML characters')
  text = text.replace(/^<\?xml version="1\.0"(?: encoding="utf-8")?(?: standalone="yes")?\?>\s*/i, declaration => ' '.repeat(declaration.length))
  const document = { name: '#document', children: [], text: '', attributes: {} }, stack = [document]
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/gy
  let token, end = 0, count = 0
  while ((token = tokens.exec(text))) {
    end = tokens.lastIndex
    if (++count > 1024) throw new Error('Appcast XML node budget exceeded')
    const value = token[0], parent = stack.at(-1)
    if (value.startsWith('<!--')) {
      if (value.slice(4, -3).includes('--')) throw new Error('Invalid XML comment')
      continue
    }
    if (value.startsWith('<![CDATA[')) { if (parent.name !== 'description') throw new Error('Unsupported XML CDATA'); parent.text += value.slice(9, -3); continue }
    if (value.startsWith('</')) {
      if (value !== `</${parent.name}>` || stack.length === 1) throw new Error('Mismatched XML close tag')
      parent.end = end
      stack.pop(); continue
    }
    if (value.startsWith('<')) {
      const match = /^<([A-Za-z][A-Za-z0-9:]*)((?:\s+[A-Za-z][A-Za-z0-9:]*="[^"<>]*")*)\s*(\/?)>$/.exec(value)
      if (!match || stack.length > 5) throw new Error('Unsupported XML syntax')
      const attributes = {}
      for (const attribute of match[2].matchAll(/([A-Za-z][A-Za-z0-9:]*)="([^"<>]*)"/g)) {
        if (Object.hasOwn(attributes, attribute[1])) throw new Error('Duplicate XML attribute')
        attributes[attribute[1]] = decodeText(attribute[2])
      }
      const node = { name: match[1], attributes, children: [], text: '', start: token.index, end }
      parent.children.push(node)
      if (!match[3]) stack.push(node)
    } else { if (value.includes(']]>')) throw new Error('Invalid XML text'); parent.text += decodeText(value) }
  }
  if (end !== text.length || stack.length !== 1 || document.text.trim() || document.children.length !== 1) throw new Error('Incomplete XML document')
  return document.children[0]
}
function fields(node, allowed, required = []) {
  if (Object.keys(node.attributes).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(node.attributes, key))) throw new Error(`Unsupported ${node.name} attributes`)
}
function children(node, allowed, required = allowed) {
  if (node.text.trim()) throw new Error(`Unexpected ${node.name} text`)
  const result = {}
  for (const child of node.children) {
    if (!allowed.includes(child.name) || result[child.name]) throw new Error(`Unsupported or duplicate ${child.name} element`)
    result[child.name] = child
  }
  if (required.some(name => !result[name])) throw new Error(`Missing ${node.name} element`)
  return result
}
function authenticatedItems(feed, publicKey) {
  if (!Buffer.isBuffer(feed) || feed.length > 256 * 1024) throw new Error('Appcast exceeds size budget')
  const prefix = Buffer.from('<!-- sparkle-signatures:\n'), offset = feed.lastIndexOf(prefix)
  if (offset < 0) throw new Error('Missing signed appcast trailer')
  const trailer = /^<!-- sparkle-signatures:\nedSignature: ([A-Za-z0-9+/]{86}==)\nlength: ([1-9][0-9]*)\n-->\n$/.exec(feed.subarray(offset).toString('utf8'))
  const content = feed.subarray(0, offset), key = publicObject(publicKey)
  if (!trailer || trailer[2] !== String(content.length) || !verify(null, content, key, decodeKey(trailer[1], 64))) throw new Error('Appcast Ed25519 signature or length mismatch')
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(content), rss = parseXML(xml)
  if (rss.name !== 'rss') throw new Error('Expected RSS appcast')
  fields(rss, ['version', 'xmlns:sparkle'], ['version', 'xmlns:sparkle'])
  if (rss.attributes.version !== '2.0' || rss.attributes['xmlns:sparkle'] !== namespace) throw new Error('Invalid appcast namespace')
  const { channel } = children(rss, ['channel']); fields(channel, [])
  const nodes = channel.children.filter(child => child.name === 'item')
  const { title } = children({ ...channel, children: channel.children.filter(child => child.name !== 'item') }, ['title'])
  fields(title, [])
  if (title.children.length || nodes.length < 1 || nodes.length > 2) throw new Error('Invalid channel title or item count')
  const items = nodes.map(node => parseItem(node, xml))
  if (items.length === 2 && (items[0].channel !== 'regular' || items[1].channel !== 'lts' || compareVersions(items[0].version, items[1].version) <= 0)) throw new Error('Expected newest regular followed by an older LTS')
  return { items, xml }
}
export function compareVersions(a, b) {
  const right = b.split('.').map(BigInt)
  for (const [index, value] of a.split('.').map(BigInt).entries()) {
    if (value !== right[index]) return value > right[index] ? 1 : -1
  }
  return 0
}
function parseItem(item, xml) {
  fields(item, [])
  const entries = children(item, ['title', 'pubDate', 'sparkle:channel', 'sparkle:version', 'sparkle:shortVersionString', 'sparkle:minimumSystemVersion', 'sparkle:hardwareRequirements', 'description', 'enclosure'], ['sparkle:channel', 'sparkle:version', 'sparkle:shortVersionString', 'description', 'enclosure'])
  for (const [name, entry] of Object.entries(entries)) {
    fields(entry, name === 'enclosure' ? ['url', 'length', 'type', 'sparkle:edSignature'] : name === 'description' ? ['sparkle:format'] : [])
    if (entry.children.length) throw new Error('Unsupported nested appcast element')
  }
  const version = entries['sparkle:version'].text, channel = entries['sparkle:channel'].text
  if (!['regular', 'lts'].includes(channel)) throw new Error('Invalid appcast channel')
  if (version.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || entries['sparkle:shortVersionString'].text !== version) throw new Error('Appcast version mismatch')
  if (!entries.description.text.trim()) throw new Error('Missing embedded release notes')
  const enclosure = entries.enclosure.attributes
  const url = `https://github.com/Zixiaobowen/oc-chan/releases/download/v${version}/OC-Chan-${version}-mac-arm64.zip`
  if (enclosure.url !== url || !/^[1-9]\d{0,8}$/.test(enclosure.length) || Number(enclosure.length) > MAX_ARCHIVE || enclosure.type !== 'application/octet-stream' || entries.enclosure.text.trim()) throw new Error('Appcast enclosure URL, length or type mismatch')
  return { version, channel, url, length: Number(enclosure.length), signature: decodeKey(enclosure['sparkle:edSignature'], 64), start: item.start, end: item.end, xml: xml.slice(item.start, item.end) }
}
function verifyArchive(item, archive, version, publicKey) {
  if (item.version !== version) throw new Error('Appcast version mismatch')
  if (!Buffer.isBuffer(archive) || archive.length !== item.length) throw new Error('Appcast archive length mismatch')
  if (!verify(null, archive, publicObject(publicKey), item.signature)) throw new Error('Archive Ed25519 signature mismatch')
}
export function verifyAppcast({ feed, archive, version, publicKey = readSparkleConfig().publicKey }) {
  const { items: [item] } = authenticatedItems(feed, publicKey)
  verifyArchive(item, archive, version, publicKey)
  return { version, url: item.url, length: item.length }
}
export function combineAppcast({ feed, archive, version, channel, previous, privateKey, publicKey }) {
  const key = requireSparklePrivateKey(privateKey, publicKey)
  const { xml, items } = authenticatedItems(feed, publicKey)
  const [current] = items
  if (items.length !== 1 || current.channel !== channel) throw new Error('Generated item does not match release channel')
  verifyArchive(current, archive, version, publicKey)
  if (!previous) return feed
  const { items: prior } = authenticatedItems(previous.feed, publicKey)
  const [lts] = prior
  if (prior.length !== 1 || channel !== 'regular' || lts.channel !== 'lts' || compareVersions(version, lts.version) <= 0) throw new Error('Expected a strictly older LTS release')
  verifyArchive(lts, previous.archive, previous.version, publicKey)
  const content = Buffer.from(xml.slice(0, current.end) + '\n' + lts.xml + xml.slice(current.end))
  const trailer = `<!-- sparkle-signatures:\nedSignature: ${sign(null, content, key).toString('base64')}\nlength: ${content.length}\n-->\n`
  const combined = Buffer.concat([content, Buffer.from(trailer)])
  authenticatedItems(combined, publicKey)
  return combined
}
export async function generateAppcast({ archive, version, channel, previous, notesFile, output, privateKey = process.env.SPARKLE_PRIVATE_KEY }) {
  const config = readSparkleConfig()
  requireSparklePrivateKey(privateKey, config.publicKey)
  const bytes = readUpdateArchive(archive), notes = readBounded(notesFile, 64 * 1024)
  if (!notes.toString('utf8').trim()) throw new Error('Release notes must not be empty')
  const sdk = await ensureSparkleSDK(), temporary = await mkdtemp(join(tmpdir(), 'oc-appcast-'))
  try {
    const archives = join(temporary, 'archives'); await mkdir(archives)
    await writeFile(join(archives, basename(archive)), bytes, { flag: 'wx', mode: 0o600 })
    await writeFile(join(archives, basename(archive, '.zip') + '.md'), notes, { flag: 'wx', mode: 0o600 })
    const environment = { ...process.env, CFFIXED_USER_HOME: temporary, TMPDIR: temporary }
    delete environment.SPARKLE_PRIVATE_KEY
    // Output is drained with a budget but never logged; the seed only crosses stdin.
    await runGenerator(join(sdk.bin, 'generate_appcast'), ['--ed-key-file', '-', '--channel', channel, '--maximum-versions', '1', '--maximum-deltas', '0', '--embed-release-notes', '--disable-signing-warning', '--download-url-prefix', `https://github.com/Zixiaobowen/oc-chan/releases/download/v${version}/`, archives], privateKey + '\n', environment)
    const feed = readBounded(join(archives, 'appcast.xml'), 256 * 1024)
    const result = combineAppcast({ feed, archive: bytes, version, channel, previous, privateKey, publicKey: config.publicKey })
    await writeFile(output, result, { flag: 'wx', mode: 0o600 })
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
