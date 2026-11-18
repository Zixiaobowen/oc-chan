import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ensureSparkleSDK } from '../sparkle-sdk.mjs'

const execute = promisify(execFile), root = fileURLToPath(new URL('../..', import.meta.url))
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'oc-sparkle-install-')))
const sdk = await ensureSparkleSDK()
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64')
let feed, zipBytes, requestCount = 0, server
const run = (file, args, options = {}) => execute(file, args, { timeout: 150_000, maxBuffer: 1024 * 1024, ...options })
try {
  server = createServer((request, response) => {
    if (++requestCount > 32) { response.writeHead(429).end(); return }
    const bytes = request.url === '/appcast.xml' ? feed : request.url === '/update.zip' ? zipBytes : undefined
    if (!bytes) { response.writeHead(404).end(); return }
    response.writeHead(200, { 'Content-Type': request.url.endsWith('.xml') ? 'application/rss+xml' : 'application/octet-stream', 'Content-Length': bytes.length }); response.end(bytes)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${server.address().port}`
  const identifier = `org.occhan.acceptance.sparkle.i${process.pid}`
  const make = async (app, version, value) => {
    await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true })
    const source = path.join(directory, `fixture-${version}.c`)
    await writeFile(source, `int main(void) { return ${value}; }\n`)
    await run('/usr/bin/xcrun', ['clang', '-mmacosx-version-min=13.0', source, '-o', path.join(app, 'Contents/MacOS/fixture')])
    const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleName</key><string>OC Chan Sparkle Acceptance</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>LSUIElement</key><true/><key>SUPublicEDKey</key><string>${key}</string><key>SUFeedURL</key><string>${url}/appcast.xml</string><key>SURequireSignedFeed</key><true/><key>SUVerifyUpdateBeforeExtraction</key><true/><key>SUSignedFeedFailureExpirationInterval</key><integer>0</integer><key>SUEnableAutomaticChecks</key><false/><key>SUEnableSystemProfiling</key><false/><key>SUEnableJavaScript</key><false/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`
    await writeFile(path.join(app, 'Contents/Info.plist'), plist)
    await run('/usr/bin/codesign', ['--force', '--sign', '-', app])
  }
  const old = path.join(directory, 'fixture.app'), staged = path.join(directory, 'new/fixture.app'), archives = path.join(directory, 'archives')
  await make(old, '1.0.0', 0); await make(staged, '1.0.1', 1); await mkdir(archives)
  await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', staged, path.join(archives, 'update.zip')])
  await writeFile(path.join(archives, 'update.md'), 'Real Sparkle isolated application replacement.\n')
  const keyFile = path.join(directory, 'signing.key'); await writeFile(keyFile, seed, { mode: 0o600 })
  await run(path.join(sdk.bin, 'generate_appcast'), ['--ed-key-file', keyFile, '--maximum-versions', '1', '--maximum-deltas', '0', '--embed-release-notes', '--disable-signing-warning', '--download-url-prefix', `${url}/`, archives], { env: { ...process.env, CFFIXED_USER_HOME: directory } })
  await rm(keyFile)
  feed = await readFile(path.join(archives, 'appcast.xml')); zipBytes = await readFile(path.join(archives, 'update.zip'))
  const expectedHash = createHash('sha256').update(await readFile(path.join(staged, 'Contents/MacOS/fixture'))).digest('hex')
  const harness = path.join(directory, 'sparkle-install')
  await run('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-mmacosx-version-min=13.0', '-F', sdk.directory, '-framework', 'AppKit', '-framework', 'Sparkle', `-Wl,-rpath,${sdk.directory}`, path.join(root, 'src-tauri/acceptance/sparkle-install.mm'), '-o', harness])
  const result = await run(harness, [directory, old, `${url}/appcast.xml`, key, '1.0.1', expectedHash])
  process.stdout.write(result.stdout)
  assert.ok(requestCount >= 2, 'Feed and ZIP must both be downloaded')
  console.log(JSON.stringify({ complete: true, requests: requestCount, targetVersion: '1.0.1', expectedExecutableSha256: expectedHash }))
} catch (error) {
  console.error(error.stderr ?? error.message); throw error
} finally {
  if (server) await new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) })
  await rm(directory, { recursive: true, force: true })
}
