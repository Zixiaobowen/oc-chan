import { createHash } from 'node:crypto'
import { open, rename, rm, statfs, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { gt, valid } from 'semver'

export const RELEASES_URL = 'https://github.com/Zixiaobowen/oc-chan/releases'
export const METADATA_URL = 'https://api.github.com/repos/Zixiaobowen/oc-chan/releases/latest'
export const MAX_METADATA_BYTES = 64 * 1024
export const MAX_UPDATE_BYTES = 512 * 1024 * 1024
const NETWORK_HOSTS: Record<string, true> = { 'api.github.com': true, 'github.com': true, 'release-assets.githubusercontent.com': true, 'objects.githubusercontent.com': true }
export type FetchUpdate = (url: string, init: RequestInit) => Promise<Response>
export interface UpdateAsset { version: string; url: string; size: number; sha256: string }

export async function fetchUpdate(url: string, signal: AbortSignal, fetcher: FetchUpdate): Promise<Response> {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.username || target.password || target.port || !Object.hasOwn(NETWORK_HOSTS, target.hostname)) {
      throw new Error('更新地址不受信任 / Untrusted update URL')
    }
    const response = await fetcher(url, { signal, redirect: 'manual', credentials: 'omit', cache: 'no-store',
      ...(target.hostname === 'api.github.com' ? { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } } : {}) })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('更新服务器缺少跳转地址 / Missing update redirect')
      url = new URL(location, url).href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 404 && target.hostname === 'api.github.com') throw new Error('尚无可用 Release，或发布仓库不可访问 / No available Release or repository inaccessible (HTTP 404)')
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
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || !('tag_name' in value) || typeof value.tag_name !== 'string' || value.tag_name.length > 65 || !value.tag_name.startsWith('v') || !valid(currentVersion)) {
    throw new Error('更新版本无效 / Invalid update version')
  }
  const version = value.tag_name.slice(1)
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) || !valid(version)) throw new Error('更新版本无效 / Invalid update version')
  if (!('draft' in value) || value.draft !== false) throw new Error('发布尚未公开 / Draft or invalid release')
  if (!('prerelease' in value) || value.prerelease !== false || version.split('+')[0].includes('-')) throw new Error('稳定更新源包含预发布版本 / Prerelease in stable update feed')
  if (!('assets' in value) || !Array.isArray(value.assets) || value.assets.length < 1) throw new Error('更新文件列表无效 / Invalid update file list')
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('不支持此架构 / Unsupported architecture')
  const name = `OC-Chan-${version}-mac-${arch}.zip`
  const matches = value.assets.filter((file): file is Record<string, unknown> => Boolean(file && typeof file === 'object' && file.name === name))
  if (matches.length !== 1) throw new Error(`更新包缺失或重复 / Missing or duplicate update package: ${name}`)
  const file = matches[0]
  const url = `${RELEASES_URL}/download/v${version}/${name}`
  if (file.browser_download_url !== url) throw new Error('更新资产地址不匹配 / Invalid release asset URL')
  if (file.state !== 'uploaded') throw new Error('更新资产尚未上传完成 / Update asset is not uploaded')
  if (!Number.isSafeInteger(file.size) || Number(file.size) <= 0 || Number(file.size) > MAX_UPDATE_BYTES || typeof file.digest !== 'string' || !/^sha256:[a-fA-F0-9]{64}$/.test(file.digest)) {
    throw new Error('更新包大小或校验信息无效 / Invalid update size or SHA-256')
  }
  if (!gt(version, currentVersion)) return null
  return { version, url, size: Number(file.size), sha256: file.digest.slice(7).toLowerCase() }
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
  const digest = createHash('sha256')
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
    if (transferred !== asset.size || digest.digest('hex') !== asset.sha256) throw new Error('更新包校验失败 / Update integrity check failed')
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
