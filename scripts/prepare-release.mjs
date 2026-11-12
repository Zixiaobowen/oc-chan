import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { basename, resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packageReleaseInfo, publicationInfo } from './release-config.mjs'
import { stableMetadata } from './dist.mjs'
import { readBounded } from './rust-dependencies.mjs'

const MAX_ASSET = 512 * 1024 * 1024
const assetName = (version, extension) => `OC-Chan-${version}-mac-arm64.${extension}`
const keysAre = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
async function digestAsset(filename, destination) {
  const source = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let output, primaryFailure
  try {
    const before = await source.stat()
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0 || before.size > MAX_ASSET) throw new Error('Invalid release asset or 512MiB limit exceeded')
    if (destination) output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const sha512 = createHash('sha512'), sha256 = createHash('sha256'); let size = 0
    for await (const chunk of source.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      size += chunk.length
      if (size > before.size || size > MAX_ASSET) throw new Error('Release asset grew during bounded read')
      sha512.update(chunk); sha256.update(chunk)
      if (output) await output.writeFile(chunk)
    }
    const after = await source.stat()
    if (size !== before.size || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Release asset changed during read')
    if (output) await output.sync()
    return { size, sha512: sha512.digest('base64'), sha256: sha256.digest('hex') }
  } catch (error) { primaryFailure = error; throw error } finally {
    const closed = await Promise.allSettled([source.close(), ...(output ? [output.close()] : [])])
    const failures = closed.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...failures], 'Release asset close failed')
  }
}
function parseChecksums(text, expected) {
  const sums = new Map()
  for (const line of text.trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (?:\.\/)?([^/\\\r\n]+)$/.exec(line)
    if (!match || !expected.has(match[2]) || sums.has(match[2])) throw new Error('Invalid or duplicate SHA256SUMS.txt entry')
    sums.set(match[2], match[1])
  }
  if (sums.size !== expected.size) throw new Error('Missing SHA256SUMS.txt entry')
  return sums
}
// Inspect the exact bytes used for publication before any remote operation.
// Preview outputs omit metadata; preparation always supplies its metadata name.
export async function inspectReleaseAssets({ directory, version, metadataName }) {
  const expected = new Set(['zip', 'dmg'].map(extension => assetName(version, extension)))
  const documents = new Map()
  let declaration
  if (metadataName) {
    const content = readBounded(join(directory, metadataName), 64 * 1024)
    documents.set(metadataName, content)
    const metadata = JSON.parse(content.toString('utf8'))
    if (!keysAre(metadata, ['schema', 'version', 'assets']) || metadata.schema !== 2 || metadata.version !== version) throw new Error('Invalid schema2 metadata fields or version')
    if (!Array.isArray(metadata.assets) || metadata.assets.length !== 1 || !keysAre(metadata.assets[0], ['target', 'name', 'size', 'sha512'])) throw new Error('Expected exactly one strict arm64 ZIP asset')
    declaration = metadata.assets[0]
    if (declaration.target !== ['darwin', 'aarch64'].join('-') || declaration.name !== assetName(version, 'zip')) throw new Error('Invalid update target or fixed ZIP filename')
  }
  const checksums = readBounded(join(directory, 'SHA256SUMS.txt'), 64 * 1024)
  documents.set('SHA256SUMS.txt', checksums)
  const sums = parseChecksums(checksums.toString('utf8'), expected), assets = []
  for (const name of expected) {
    const digest = await digestAsset(join(directory, name))
    if (sums.get(name) !== digest.sha256) throw new Error(`SHA256 mismatch: ${name}`)
    if (name === declaration?.name && (declaration.size !== digest.size || declaration.sha512 !== digest.sha512)) throw new Error('Update ZIP size or SHA512 mismatch')
    assets.push({ name, ...digest })
  }
  return { assets, documents }
}
export async function prepareRelease({ version, tag, inputs, output, env = process.env }) {
  const info = publicationInfo(version, env)
  if (tag !== info.tag) throw new Error(`Release tag ${tag} must match package version and publication source: ${info.tag}`)
  if (!keysAre(inputs, ['arm64']) || typeof inputs.arm64 !== 'string') throw new Error('Release requires exactly the arm64 artifact directory')
  const directory = inputs.arm64
  const { assets } = await inspectReleaseAssets({ directory, version, metadataName: info.metadataName })
  const manifest = JSON.parse(readBounded(join(directory, 'package-manifest-arm64.json'), 16 * 1024 * 1024).toString('utf8'))
  if (manifest?.schema !== 2 || manifest.arch !== 'arm64' || manifest.version !== version || !keysAre(manifest.artifacts, ['zip', 'dmg'])) throw new Error('Invalid schema2 arm64 package artifact manifest or version')
  for (const asset of assets) {
    const extension = asset.name.endsWith('.zip') ? 'zip' : 'dmg', entry = manifest.artifacts[extension]
    if (!entry || typeof entry.path !== 'string' || basename(entry.path) !== asset.name) throw new Error(`Package manifest artifact filename mismatch: ${asset.name}`)
    if (entry.bytes !== asset.size) throw new Error(`Package manifest size mismatch: ${asset.name}`)
    if (entry.digest !== (extension === 'zip' ? asset.sha512 : asset.sha256)) throw new Error(`Package manifest ${extension === 'zip' ? 'SHA512' : 'SHA256'} mismatch: ${asset.name}`)
  }
  const zip = assets.find(asset => asset.name === assetName(version, 'zip')), canonical = stableMetadata(version, { bytes: zip.size, digest: zip.sha512 })
  // All declarations and input digests are checked before the destination exists.
  await mkdir(output, { mode: 0o700 })
  for (const asset of assets) {
    const copied = await digestAsset(join(directory, asset.name), join(output, asset.name))
    if (copied.size !== asset.size || copied.sha512 !== asset.sha512 || copied.sha256 !== asset.sha256) throw new Error('Release asset changed between validation and copy')
  }
  if (!info.prerelease) await writeFile(join(output, info.metadataName), `${JSON.stringify(canonical, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  await writeFile(join(output, 'SHA256SUMS.txt'), assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''), { flag: 'wx', mode: 0o600 })
  return canonical
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [artifacts, output, run, tag] = process.argv.slice(2), info = publicationInfo(packageReleaseInfo().version)
  if (!artifacts || !output || !/^[1-9][0-9]{0,15}$/.test(run ?? '') || !Number.isSafeInteger(Number(run)) || String(Number(run)) !== run || !tag || process.argv.length !== 6) throw new Error('Usage: node scripts/prepare-release.mjs <artifacts-dir> <output-dir> <run-number> <tag>')
  if (info.prerelease && run !== process.env.GITHUB_RUN_NUMBER) throw new Error('Preview artifact run must match GITHUB_RUN_NUMBER')
  prepareRelease({ version: info.version, tag, env: process.env, inputs: { arm64: join(resolve(artifacts), `oc-chan-macos-arm64-${run}`) }, output: resolve(output) }).catch(error => { console.error(error); process.exitCode = 1 })
}
