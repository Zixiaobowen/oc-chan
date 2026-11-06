import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nodeApiHeaders from 'node-api-headers'

const source = fileURLToPath(new URL('../src/native/notification-permission.mm', import.meta.url))
const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export function buildNotifications(arch, output, minimumVersion) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch) ||
      typeof minimumVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(minimumVersion))
    throw new Error('Notification permissions require macOS, an arm64/x64 target and a numeric minimum OS version')
  if (typeof output !== 'string' || output.length === 0)
    throw new Error('Notification permission output must be a nonempty path')
  mkdirSync(path.dirname(output), { recursive: true })
  const target = `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos${minimumVersion}`
  const result = spawnSync('/usr/bin/xcrun', [
    'clang++', '-std=c++17', '-bundle', '-undefined', 'dynamic_lookup',
    '-fobjc-arc', '-O2', '-framework', 'Foundation', '-framework', 'UserNotifications', '-DNAPI_VERSION=8',
    '-target', target, '-I', nodeApiHeaders.include_dir, source, '-o', output
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 })
  if (result.error || result.signal || result.status !== 0)
    throw new Error(`Notification permission compilation failed (${result.signal ?? result.status}): ${result.stderr ?? ''}`, { cause: result.error })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.OC_CHAN_DEV_INSTANCE || projectRoot
  buildNotifications(process.arch, path.join(root, 'resources/notification-permission/notification-permission.node'), '13.0')
}
