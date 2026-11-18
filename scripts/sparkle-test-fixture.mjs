import { generateKeyPairSync, sign } from 'node:crypto'
export const { privateKey, publicKey: key } = generateKeyPairSync('ed25519')
export const publicKey = key.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
export const privateSeed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64')
export function signFeed(content) {
  const bytes = Buffer.from(content)
  return Buffer.concat([bytes, Buffer.from(`<!-- sparkle-signatures:\nedSignature: ${sign(null, bytes, privateKey).toString('base64')}\nlength: ${bytes.length}\n-->\n`)])
}
export function appcast(archive, version = '1.2.3', mutate = text => text) {
  return signFeed(mutate(`<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel><title>OC Chan</title><item><sparkle:channel>regular</sparkle:channel><title>${version}</title><sparkle:version>${version}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString><description sparkle:format="markdown"><![CDATA[更新说明]]></description><enclosure url="https://github.com/Zixiaobowen/oc-chan/releases/download/v${version}/OC-Chan-${version}-mac-arm64.zip" length="${archive.length}" type="application/octet-stream" sparkle:edSignature="${sign(null, archive, privateKey).toString('base64')}"/></item></channel></rss>\n`))
}
