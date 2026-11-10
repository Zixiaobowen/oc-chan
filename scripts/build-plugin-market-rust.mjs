// Builds a signed `.ocplugin` ZIP from an already-built release binary. It never runs
// cargo; the `collector` Mach-O is supplied explicitly. The ZIP contains a single
// `<id>.ocbundle/` root with exactly the four required entries (Info.plist, collector,
// manifest.json, and the codesign `_CodeSignature/CodeResources`), plus directory
// entries. All files are stored (method 0) for a deterministic catalog digest.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

export const BUNDLE_API_VERSION = 2
export const BUNDLE_TARGET = ['aarch64', 'apple', 'darwin'].join('-')
const DOS_EPOCH_2000 = { date: 0b00101000000100001, time: 0 } // 2000-01-01 00:00:00

export function crc32(buffer) { return zlib.crc32(buffer) >>> 0 }

export function zipEntry(name, data) {
  const nameBuffer = Buffer.from(name, 'utf8')
  const isDir = name.endsWith('/')
  const crc = isDir ? 0 : crc32(data)
  const size = isDir ? 0 : data.length
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt16LE(DOS_EPOCH_2000.time, 10)
  local.writeUInt16LE(DOS_EPOCH_2000.date, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(size, 18)
  local.writeUInt32LE(size, 22)
  local.writeUInt16LE(nameBuffer.length, 26)
  local.writeUInt16LE(0, 28)
  const localHeader = Buffer.concat([local, nameBuffer])
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(0x0314, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt16LE(DOS_EPOCH_2000.time, 12)
  central.writeUInt16LE(DOS_EPOCH_2000.date, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(size, 20)
  central.writeUInt32LE(size, 24)
  central.writeUInt16LE(nameBuffer.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  const mode = isDir ? 0o40755 : name.endsWith('/MacOS/collector') ? 0o100755 : 0o100644
  central.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38)
  central.writeUInt32LE(0, 42)
  return { localHeader, centralHeader: Buffer.concat([central, nameBuffer]), data: isDir ? Buffer.alloc(0) : data, name }
}

export function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const { localHeader, centralHeader, data } = entry
    chunks.push(localHeader, data)
    central.push(centralHeader)
    central[central.length - 1].writeUInt32LE(offset, 42)
    offset += localHeader.length + data.length
  }
  const centralBuffer = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuffer, eocd])
}

export function buildInfoPlist(id, version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleExecutable</key>\t<string>collector</string>
\t<key>CFBundleIdentifier</key>\t<string>local.oc-chan.plugin.${id}</string>
\t<key>CFBundleInfoDictionaryVersion</key>\t<string>6.0</string>
\t<key>CFBundleName</key>\t<string>${id}</string>
\t<key>CFBundlePackageType</key>\t<string>BNDL</string>
\t<key>CFBundleShortVersionString</key>\t<string>${version}</string>
\t<key>CFBundleVersion</key>\t<string>${version}</string>
</dict>
</plist>
`
}

export function bundleManifest(sourceManifest) {
  const { id, version, apiVersion, target, name, nameEn, description, descriptionEn, publisher, section, minAppVersion, platforms, permissions } = sourceManifest
  for (const field of ['id', 'version', 'name', 'description']) {
    if (typeof sourceManifest[field] !== 'string' || !sourceManifest[field]) throw new Error(`manifest missing ${field}`)
  }
  if (apiVersion !== BUNDLE_API_VERSION) throw new Error(`manifest apiVersion must be ${BUNDLE_API_VERSION}`)
  if (target !== BUNDLE_TARGET) throw new Error(`manifest target must be ${BUNDLE_TARGET}`)
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error(`manifest id is not a valid bundle id: ${id}`)
  if (version.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('manifest version must be a safe semantic version')
  return {
    id, version, apiVersion, target,
    name, nameEn, description, descriptionEn, publisher, section, minAppVersion, platforms, permissions,
  }
}

async function signBundle(bundlePath, id, sign) {
  const args = ['--force', '--sign', sign, '--identifier', `local.oc-chan.plugin.${id}`, '--options', 'runtime']
  if (sign !== '-') args.push('--timestamp')
  await execFileAsync('/usr/bin/codesign', [...args, bundlePath], { timeout: 30_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' })
  const verification = ['--verify', '--deep', '--strict', '--all-architectures', '--verbose=2']
  if (sign !== '-') verification.push('-R', '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists')
  await execFileAsync('/usr/bin/codesign', [...verification, bundlePath], { timeout: 30_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' })
}

export async function buildPluginMarketRust({ collector, manifest, outDir, sign = '-', catalog = path.join(outDir, 'catalog.json') }) {
  if (typeof collector !== 'string' || typeof manifest !== 'string' || typeof outDir !== 'string' || !outDir) throw new Error('collector, manifest and outDir are required')
  if (typeof sign !== 'string' || (sign !== '-' && !sign.startsWith('Developer ID Application: '))) throw new Error('sign must be "-" or an explicit Developer ID Application identity')
  if ((await stat(manifest)).size > 16 * 1024) throw new Error('manifest exceeds the 16 KiB budget')
  const sourceManifest = JSON.parse(await readFile(manifest, 'utf8'))
  const bundle = bundleManifest(sourceManifest)
  const id = bundle.id
  if ((await stat(collector)).size > 8 * 1024 * 1024) throw new Error('collector binary exceeds the 8 MiB entry budget')
  const binary = await readFile(collector)
  if (binary.length === 0) throw new Error('collector binary is empty')
  if (binary.length > 8 * 1024 * 1024) throw new Error('collector binary exceeds the 8 MiB entry budget')
  if (binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf || binary.readUInt32LE(4) !== 0x0100000c) throw new Error('collector must be an arm64 Mach-O release executable')
  const manifestBytes = Buffer.from(`${JSON.stringify(bundle)}\n`)
  if (manifestBytes.length > 16 * 1024) throw new Error('bundle manifest exceeds the 16 KiB budget')

  const staging = await mkdtemp(path.join(os.tmpdir(), 'oc-plugin-bundle-'))
  const bundleRoot = path.join(staging, `${id}.ocbundle`)
  try {
    await mkdir(path.join(bundleRoot, 'Contents', 'MacOS'), { recursive: true })
    await mkdir(path.join(bundleRoot, 'Contents', 'Resources'), { recursive: true })
    await writeFile(path.join(bundleRoot, 'Contents', 'Info.plist'), buildInfoPlist(id, bundle.version))
    await writeFile(path.join(bundleRoot, 'Contents', 'MacOS', 'collector'), binary, { mode: 0o755 })
    await writeFile(path.join(bundleRoot, 'Contents', 'Resources', 'manifest.json'), manifestBytes)
    await signBundle(bundleRoot, id, sign)

    const signedFiles = [
      'Contents/Info.plist', 'Contents/MacOS/collector',
      'Contents/Resources/manifest.json', 'Contents/_CodeSignature/CodeResources',
    ]
    const sizes = await Promise.all(signedFiles.map(async (file) => (await stat(path.join(bundleRoot, file))).size))
    if (sizes[1] > 8 * 1024 * 1024 || sizes.reduce((a, b) => a + b, 0) > 9 * 1024 * 1024) throw new Error('signed bundle exceeds expanded file budget')
    const [infoPlist, signedBinary, signedManifest, codeResources] = await Promise.all(signedFiles.map((file) => readFile(path.join(bundleRoot, file))))
    const files = [
      [`${id}.ocbundle/`, null],
      [`${id}.ocbundle/Contents/`, null],
      [`${id}.ocbundle/Contents/Info.plist`, infoPlist],
      [`${id}.ocbundle/Contents/MacOS/`, null],
      [`${id}.ocbundle/Contents/MacOS/collector`, signedBinary],
      [`${id}.ocbundle/Contents/Resources/`, null],
      [`${id}.ocbundle/Contents/Resources/manifest.json`, signedManifest],
      [`${id}.ocbundle/Contents/_CodeSignature/`, null],
      [`${id}.ocbundle/Contents/_CodeSignature/CodeResources`, codeResources],
    ].map(([name, data]) => zipEntry(name, data))
    const archive = buildZip(files)
    if (archive.length > 2 * 1024 * 1024) throw new Error('plugin archive exceeds the 2 MiB budget')

    await mkdir(outDir, { recursive: true })
    const packageName = `${id}-${bundle.version}.ocplugin`
    await writeFile(path.join(outDir, packageName), archive)
    const bytes = archive.length
    const sha256 = createHash('sha256').update(archive).digest('hex')
    let catalogData
    try { catalogData = JSON.parse(await readFile(catalog, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error; catalogData = { schema: 1, plugins: [] } }
    if (catalogData.schema !== 1 || !Array.isArray(catalogData.plugins)) throw new Error('invalid existing catalog')
    catalogData.plugins = catalogData.plugins.filter((entry) => entry.manifest.id !== id)
    catalogData.plugins.push({ manifest: bundle, package: packageName, sha256, bytes })
    await writeFile(catalog, `${JSON.stringify(catalogData, null, 2)}\n`)
    return { directory: outDir, catalog: catalogData, packagePath: path.join(outDir, packageName), manifest: bundle, bytes, sha256 }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
  const collector = get('--collector'); const manifest = get('--manifest'); const outDir = get('--out')
  const sign = get('--sign') ?? '-'; const catalog = get('--catalog')
  if (!collector || !manifest || !outDir) {
    console.error('usage: build-plugin-market-rust.mjs --collector <binary> --manifest <manifest.json> --out <dir> [--sign <identity|-|>] [--catalog <catalog.json>]')
    process.exit(2)
  }
  const options = { collector, manifest, outDir, sign, ...(catalog ? { catalog } : {}) }
  buildPluginMarketRust(options).then((result) => {
    console.log(JSON.stringify(result, null, 2))
  }).catch((error) => { console.error(error.message); process.exit(1) })
}
