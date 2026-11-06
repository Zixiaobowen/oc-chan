import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGlass } from './build-glass.mjs'
import { buildNotifications } from './build-notifications.mjs'

const source = fileURLToPath(new URL('../src/main/tern-present.swift', import.meta.url))

function buildNative(arch, output, minimumVersion) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch) || !/^\d+\.\d+(?:\.\d+)?$/.test(minimumVersion))
    throw new Error('Native helper requires macOS, an arm64/x64 target and a numeric minimum OS version')
  mkdirSync(path.dirname(output), { recursive: true })
  const target = `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos${minimumVersion}`
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', target, source, '-o', output], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024
  })
  if (result.error || result.signal || result.status !== 0)
    throw new Error(`Native helper compilation failed (${result.signal ?? result.status}): ${result.stderr ?? ''}`, { cause: result.error })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

// Compile into each isolated app after resources are copied, before signing or compression.
// A multi-architecture build never shares or overwrites another target's helper.
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') throw new Error('Only macOS packaging is supported')
  const { Arch } = await import('electron-builder')
  const contents = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents')
  const minimumVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print:LSMinimumSystemVersion', path.join(contents, 'Info.plist')], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024
  }).trim()
  buildNative(Arch[context.arch], path.join(contents, 'Resources/tern-navigation/present-window'), minimumVersion)
  buildGlass(Arch[context.arch], path.join(contents, 'Resources/liquid-glass/liquid-glass.node'), minimumVersion)
  buildNotifications(Arch[context.arch], path.join(contents, 'Resources/notification-permission/notification-permission.node'), minimumVersion)
  // Local development bundles must be internally verifiable before ZIP/DMG creation.
  // This uses no certificate or Apple service and does not establish developer identity.
  const bundle = path.dirname(contents)
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024
  })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.OC_CHAN_DEV_INSTANCE || fileURLToPath(new URL('../', import.meta.url))
  buildNative(process.arch, path.join(root, 'resources/tern-navigation/present-window'), '13.0')
  buildGlass(process.arch, path.join(root, 'resources/liquid-glass/liquid-glass.node'), '13.0')
  buildNotifications(process.arch, path.join(root, 'resources/notification-permission/notification-permission.node'), '13.0')
}
