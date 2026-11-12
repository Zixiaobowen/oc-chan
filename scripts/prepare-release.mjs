import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packageReleaseInfo, releaseInfo } from './release-config.mjs'

export const releaseAssetNames = version => ['zip', 'dmg'].map(extension => `OC-Chan-${version}-mac-arm64.${extension}`)

async function readSmallFile(path, limit = 64 * 1024) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > limit) throw new Error(`Invalid or oversized metadata: ${path}`)
  return readFile(path, 'utf8')
}

export async function digestFile(path, maxBytes = Number.MAX_SAFE_INTEGER) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size <= 0 || !Number.isSafeInteger(stat.size)) throw new Error(`Invalid release asset: ${path}`)
  if (stat.size > maxBytes) throw new Error(`Release asset exceeds size limit (${maxBytes} bytes): ${path}`)
  const sha256 = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    if (size > maxBytes) throw new Error(`Release asset exceeds size limit (${maxBytes} bytes): ${path}`)
    sha256.update(chunk)
  }
  if (size !== stat.size) throw new Error(`Size changed while reading: ${path}`)
  return { size, sha256: sha256.digest('hex') }
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

export async function inspectReleaseAssets(directory, version) {
  const names = releaseAssetNames(version)
  const sums = parseChecksums(await readSmallFile(join(directory, 'SHA256SUMS.txt')), new Set(names))
  const assets = []
  for (const name of names) {
    const source = join(directory, name)
    const digest = await digestFile(source, name.endsWith('.zip') ? 512 * 1024 * 1024 : Number.MAX_SAFE_INTEGER)
    if (sums.get(name) !== digest.sha256) throw new Error(`SHA256 mismatch: ${name}`)
    assets.push({ source, name, ...digest })
  }
  return assets
}

export async function prepareRelease({ version, tag, inputs, output }) {
  const info = releaseInfo(version)
  if (tag !== info.tag) throw new Error(`Release tag ${tag} must match package version ${info.tag}`)
  if (Object.keys(inputs).some(arch => arch !== 'arm64')) throw new Error('Unsupported release architecture; this release targets arm64')
  if (!inputs.arm64) throw new Error('Missing arm64 build directory')
  const assets = await inspectReleaseAssets(inputs.arm64, version)
  const manifest = JSON.parse(await readSmallFile(join(inputs.arm64, 'package-manifest-arm64.json'), 16 * 1024 * 1024))
  if (manifest.schema !== 1 || manifest.arch !== 'arm64' || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== assets.length) throw new Error('Invalid package artifact manifest')
  const seen = new Set()
  for (const entry of manifest.artifacts) {
    const asset = assets.find(asset => asset.name === entry.name)
    if (!asset || seen.has(entry.name)) throw new Error('Unexpected or duplicate package artifact')
    if (entry.bytes !== asset.size) throw new Error(`Size mismatch: ${entry.name}`)
    if (entry.sha256 !== asset.sha256) throw new Error(`Manifest SHA256 mismatch: ${entry.name}`)
    seen.add(entry.name)
  }
  // Validate every input before creating anything. A prior output directory is an error.
  await mkdir(output)
  for (const asset of assets) await copyFile(asset.source, join(output, asset.name), constants.COPYFILE_EXCL)
  await writeFile(join(output, 'SHA256SUMS.txt'), assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''), { flag: 'wx' })
  return { version, files: assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [artifacts, output, runNumber, tag] = process.argv.slice(2)
  if (!artifacts || !output || !/^\d+$/.test(runNumber ?? '') || !tag || process.argv.length !== 6) {
    throw new Error('Usage: node scripts/prepare-release.mjs <artifacts-dir> <output-dir> <run-number> <tag>')
  }
  await prepareRelease({
    version: packageReleaseInfo().version,
    tag,
    inputs: { arm64: join(artifacts, `oc-chan-macos-arm64-${runNumber}`) },
    output,
  })
}
