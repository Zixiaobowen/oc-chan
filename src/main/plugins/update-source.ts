import { createHash } from 'node:crypto'
import { open, rename, rm, statfs, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { load, JSON_SCHEMA } from 'js-yaml'
import { gt, parse, valid } from 'semver'

export const RELEASES_URL = 'https://github.com/Zixiaobowen/oc-chan/releases'
export const METADATA_URL = `${RELEASES_URL}/latest/download/latest-mac.yml`
export const MAX_METADATA_BYTES = 64 * 1024
export const MAX_UPDATE_BYTES = 512 * 1024 * 1024
const NETWORK_HOSTS: Record<string, true> = { 'github.com': true, 'release-assets.githubusercontent.com': true, 'objects.githubusercontent.com': true }
export type FetchUpdate = (url: string, init: RequestInit) => Promise<Response>
export interface UpdateAsset { version: string; url: string; size: number; sha512: string }

export async function fetchUpdate(url: string, signal: AbortSignal, fetcher: FetchUpdate): Promise<Response> {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.username || target.password || target.port || !Object.hasOwn(NETWORK_HOSTS, target.hostname)) {
      throw new Error('更新地址不受信任 / Untrusted update URL')
    }
    const response = await fetcher(url, { signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('更新服务器缺少跳转地址 / Missing update redirect')
      url = new URL(location, url).href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`更新服务返回 HTTP ${response.status} / Update service returned HTTP ${response.status}`)
    }
    return response
  }
  throw new Error('更新服务跳转次数超限 / Too many update redirects')
}

export async function readMetadata(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (declared > MAX_METADATA_BYTES) {
    await response.body?.cancel()
    throw new Error('更新信息超过 64 KiB 上限 / Update metadata exceeds 64 KiB')
  }
  if (!response.body) throw new Error('更新信息为空 / Empty update metadata')
  const reader = response.body.getReader()
  // One fixed allocation, checked before copying each chunk; never concatenate unbounded strings.
  const bytes = new Uint8Array(MAX_METADATA_BYTES)
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength > MAX_METADATA_BYTES - size) throw new Error('更新信息超过 64 KiB 上限 / Update metadata exceeds 64 KiB')
      bytes.set(value, size)
      size += value.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}

export function parseUpdate(text: string, currentVersion: string, arch: string): UpdateAsset | null {
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES) throw new Error('Update metadata exceeds 64 KiB')
  // Generated builder metadata needs no YAML aliases, anchors or tags. Reject them before parsing.
  if (/(?:^|[\s,[{])[&*!]/m.test(text)) throw new Error('Unsupported YAML reference or tag')
  const value: unknown = load(text, { schema: JSON_SCHEMA })
  if (!value || typeof value !== 'object' || !('version' in value) || typeof value.version !== 'string' || value.version.length > 64 || !valid(currentVersion)) {
    throw new Error('更新版本无效 / Invalid update version')
  }
  const version = parse(value.version)
  const canonicalVersion = version && `${version.version}${version.build.length ? `+${version.build.join('.')}` : ''}`
  if (!version || canonicalVersion !== value.version) throw new Error('更新版本无效 / Invalid update version')
  if (version.prerelease.length) throw new Error('稳定更新源包含预发布版本 / Prerelease in stable update feed')
  if (version.build.length) throw new Error('稳定更新源包含构建元数据 / Build metadata in stable update feed')
  if (!('files' in value) || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 8) throw new Error('更新文件列表无效 / Invalid update file list')
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('不支持此架构 / Unsupported architecture')
  const name = `OC-Chan-${value.version}-mac-${arch}.zip`
  const matches = value.files.filter((file): file is Record<string, unknown> => Boolean(file && typeof file === 'object' && file.url === name))
  if (matches.length !== 1) throw new Error(`更新包缺失或重复 / Missing or duplicate update package: ${name}`)
  const file = matches[0]
  if (!Number.isSafeInteger(file.size) || Number(file.size) <= 0 || Number(file.size) > MAX_UPDATE_BYTES || typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) {
    throw new Error('更新包大小或校验信息无效 / Invalid update size or SHA-512')
  }
  if (!gt(value.version, currentVersion)) return null
  return { version: value.version, url: `${RELEASES_URL}/download/v${value.version}/${name}`, size: Number(file.size), sha512: file.sha512 }
}

export async function downloadAsset(asset: UpdateAsset, directory: string, signal: AbortSignal, fetcher: FetchUpdate,
  progress: (transferred: number, total: number, bytesPerSecond: number) => void): Promise<string> {
  const space = await statfs(directory)
  // ZIP, native staging and replacement may coexist. Refuse before allocating disk space.
  if (space.bavail * space.bsize < asset.size * 5 + 256 * 1024 * 1024) throw new Error('安装更新所需磁盘空间不足 / Insufficient disk space for update')
  const response = await fetchUpdate(asset.url, signal, fetcher)
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) !== asset.size) {
    await response.body?.cancel()
    throw new Error('更新包长度与发布信息不符 / Update size mismatch')
  }
  if (!response.body) throw new Error('更新包为空 / Empty update package')
  const partial = join(directory, 'download.part')
  const destination = join(directory, 'update.zip')
  const reader = response.body.getReader()
  let file: FileHandle | undefined
  let transferred = 0
  const digest = createHash('sha512')
  const started = performance.now()
  let lastProgress = started
  try {
    file = await open(partial, 'w', 0o600)
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength > asset.size - transferred) throw new Error('更新包超过声明大小 / Update exceeds declared size')
      digest.update(value)
      let offset = 0
      while (offset < value.byteLength) {
        signal.throwIfAborted()
        const { bytesWritten } = await file.write(value, offset, value.byteLength - offset)
        if (!bytesWritten) throw new Error('无法写入更新包 / Cannot write update package')
        offset += bytesWritten
      }
      transferred += value.byteLength
      const now = performance.now()
      if (now - lastProgress >= 250) {
        progress(transferred, asset.size, transferred * 1000 / Math.max(1, now - started))
        lastProgress = now
      }
    }
    if (transferred !== asset.size || digest.digest('base64') !== asset.sha512) throw new Error('更新包校验失败 / Update integrity check failed')
    signal.throwIfAborted()
    await file.sync()
    await file.close()
    file = undefined
    await rename(partial, destination)
    progress(transferred, asset.size, transferred * 1000 / Math.max(1, performance.now() - started))
    return destination
  } finally {
    try { await reader.cancel() } finally {
      reader.releaseLock()
      try { await file?.close() } finally { await rm(partial, { force: true }) }
    }
  }
}
