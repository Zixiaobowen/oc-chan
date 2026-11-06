import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nodeApiHeaders from 'node-api-headers'

const source = fileURLToPath(new URL('../src/native/liquid-glass.mm', import.meta.url))
const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export function buildGlass(arch, output, minimumVersion) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch) ||
      typeof minimumVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(minimumVersion))
    throw new Error('Liquid Glass requires macOS, an arm64/x64 target and a numeric minimum OS version')
  if (typeof output !== 'string' || output.length === 0)
    throw new Error('Liquid Glass output must be a nonempty path')
  mkdirSync(path.dirname(output), { recursive: true })
  const target = `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos${minimumVersion}`
  const result = spawnSync('/usr/bin/xcrun', [
    'clang++', '-std=c++17', '-bundle', '-undefined', 'dynamic_lookup',
    '-fobjc-arc', '-O2', '-framework', 'AppKit', '-DNAPI_VERSION=8',
    '-target', target, '-I', nodeApiHeaders.include_dir, source, '-o', output
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 })
  if (result.error || result.signal || result.status !== 0)
    throw new Error(`Liquid Glass compilation failed (${result.signal ?? result.status}): ${result.stderr ?? ''}`, { cause: result.error })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.OC_CHAN_DEV_INSTANCE || projectRoot
  buildGlass(process.arch, path.join(root, 'resources/liquid-glass/liquid-glass.node'), '13.0')
}
