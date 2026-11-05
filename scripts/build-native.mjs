import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGlass } from './build-glass.mjs'
import { inspectPackage } from './check-package.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const source = path.join(projectRoot, 'src/main/tern-present.swift')

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
  if (arch === 'arm64') {
    const baseline = JSON.parse(readFileSync(path.join(projectRoot, 'docs/package-baseline.json'), 'utf8'))
    const limit = baseline.architectures?.arm64?.limits?.helperBytes
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid arm64 native helper byte budget')
    const bytes = statSync(output).size
    if (bytes > limit) throw new Error(`Native helper size budget exceeded: ${bytes} > ${limit}`)
    console.log(`[oc-chan] Native helper budget: ${bytes}/${limit} bytes`)
  }
}

// Compile into the target bundle after resources are copied and before signing.
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') throw new Error('Only macOS packaging is supported')
  const { Arch } = await import('electron-builder')
  const contents = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents')
  const report = await inspectPackage(path.dirname(contents))
  console.log(`[oc-chan] Package content verified: ${report.asarBytes}/${report.asarLimitBytes} ASAR bytes; runtime: ${report.runtimeDependencies.map(item => item.name).join(', ')}`)
  const minimumVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print:LSMinimumSystemVersion', path.join(contents, 'Info.plist')], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024
  }).trim()
  buildNative(Arch[context.arch], path.join(contents, 'Resources/tern-navigation/present-window'), minimumVersion)
  buildGlass(Arch[context.arch], path.join(contents, 'Resources/liquid-glass/liquid-glass.node'), minimumVersion)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.OC_CHAN_DEV_INSTANCE || projectRoot
  buildNative(process.arch, path.join(root, 'resources/tern-navigation/present-window'), '13.0')
  buildGlass(process.arch, path.join(root, 'resources/liquid-glass/liquid-glass.node'), '13.0')
}
