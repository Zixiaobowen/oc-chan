import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { packageReleaseInfo, releaseInfo } from './release-config.mjs'

const architectures = ['x64', 'arm64']
const extensions = ['zip', 'dmg']
const assetName = (version, arch, extension) => `OC-Chan-${version}-mac-${arch}.${extension}`

async function readSmallFile(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error(`Invalid or oversized metadata: ${path}`)
  return readFile(path, 'utf8')
}

async function digestFile(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size <= 0 || !Number.isSafeInteger(stat.size)) throw new Error(`Invalid release asset: ${path}`)
  const sha512 = createHash('sha512')
  const sha256 = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    sha512.update(chunk)
    sha256.update(chunk)
  }
  return { size: stat.size, sha512: sha512.digest('base64'), sha256: sha256.digest('hex') }
}

function parseChecksums(text, expected) {
  const sums = new Map()
  for (const line of text.trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (?:\.\/)?([^/\\]+)$/.exec(line)
    if (!match || !expected.has(match[2]) || sums.has(match[2])) throw new Error('Invalid SHA256SUMS.txt entry')
    sums.set(match[2], match[1])
  }
  if (sums.size !== expected.size) throw new Error('Missing SHA256SUMS.txt entry')
  return sums
}

export async function prepareRelease({ version, tag, inputs, output }) {
  const info = releaseInfo(version)
  if (tag !== info.tag) throw new Error(`Release tag ${tag} must match package version ${info.tag}`)
  const assets = []
  const dates = []
  for (const arch of architectures) {
    if (!inputs[arch]) throw new Error(`Missing ${arch} build directory`)
    const directory = inputs[arch]
    const metadata = yaml.load(await readSmallFile(join(directory, info.metadataName)), { schema: yaml.JSON_SCHEMA })
    if (metadata?.version !== version) throw new Error(`Wrong metadata version for ${arch}: ${metadata?.version}`)
    if (!Array.isArray(metadata.files) || metadata.files.length !== 2) throw new Error(`Expected ZIP and DMG metadata for ${arch}`)
    if (typeof metadata.releaseDate !== 'string' || !Number.isFinite(Date.parse(metadata.releaseDate))) throw new Error(`Invalid releaseDate for ${arch}`)
    dates.push(metadata.releaseDate)
    const expected = new Set(extensions.map(extension => assetName(version, arch, extension)))
    const sums = parseChecksums(await readSmallFile(join(directory, 'SHA256SUMS.txt')), expected)
    const seen = new Set()
    for (const file of metadata.files) {
      if (!file || !expected.has(file.url) || seen.has(file.url)) throw new Error(`Wrong architecture, version, or duplicate metadata asset for ${arch}: ${file?.url}`)
      seen.add(file.url)
      const source = join(directory, file.url)
      const digest = await digestFile(source)
      if (file.size !== digest.size) throw new Error(`Size mismatch: ${file.url}`)
      if (file.sha512 !== digest.sha512) throw new Error(`SHA512 mismatch: ${file.url}`)
      if (sums.get(file.url) !== digest.sha256) throw new Error(`SHA256 mismatch: ${file.url}`)
      assets.push({ source, url: file.url, ...digest })
    }
    const zip = assets.find(file => file.url === assetName(version, arch, 'zip'))
    if (metadata.path !== zip.url || metadata.sha512 !== zip.sha512) throw new Error(`Invalid primary ZIP metadata for ${arch}`)
  }
  // Validate every input before creating anything. A prior output directory is an error.
  assets.sort((a, b) => Number(a.url.endsWith('.dmg')) - Number(b.url.endsWith('.dmg')) || b.url.localeCompare(a.url))
  const merged = {
    version,
    files: assets.map(({ url, sha512, size }) => ({ url, sha512, size })),
    path: assets[0].url,
    sha512: assets[0].sha512,
    releaseDate: new Date(Math.max(...dates.map(Date.parse))).toISOString(),
  }
  await mkdir(output)
  for (const asset of assets) await copyFile(asset.source, join(output, asset.url), constants.COPYFILE_EXCL)
  await writeFile(join(output, info.metadataName), yaml.dump(merged, { lineWidth: -1, noRefs: true }), { flag: 'wx' })
  await writeFile(join(output, 'SHA256SUMS.txt'), assets.map(asset => `${asset.sha256}  ${asset.url}\n`).join(''), { flag: 'wx' })
  return merged
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [artifacts, output, runNumber, tag] = process.argv.slice(2)
  if (!artifacts || !output || !/^\d+$/.test(runNumber ?? '') || !tag || process.argv.length !== 6) {
    throw new Error('Usage: node scripts/prepare-release.mjs <artifacts-dir> <output-dir> <run-number> <tag>')
  }
  await prepareRelease({
    version: packageReleaseInfo().version,
    tag,
    inputs: Object.fromEntries(architectures.map(arch => [arch, join(artifacts, `oc-chan-macos-${arch}-${runNumber}`)])),
    output,
  })
}
