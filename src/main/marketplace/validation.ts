import { createHash } from 'node:crypto'
import semver from 'semver'
import type { PluginCatalog, PluginCatalogEntry, PluginManifest, PluginPackage } from '../../shared/marketplace'

export const MARKET_LIMITS = Object.freeze({ catalogBytes: 256 * 1024, catalogEntries: 64, packageBytes: 2 * 1024 * 1024, codeBytes: 1024 * 1024, installed: 16, installedBytes: 32 * 1024 * 1024, downloadMs: 30_000 })
export const OFFICIAL_BASE = 'https://raw.githubusercontent.com/Zixiaobowen/oc-chan/main/plugin-market/'
export const OFFICIAL_CATALOG = `${OFFICIAL_BASE}catalog.json`
const sections: Record<string, true> = { agents: true, schedules: true, system: true, events: true }
export function pluginId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw new Error('插件 ID 无效 / Invalid plugin ID')
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件格式无效 / Invalid plugin object')
}
function text(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('插件文本字段无效 / Invalid plugin text')
}
export function validateManifest(value: unknown, appVersion: string): PluginManifest {
  object(value)
  pluginId(value.id)
  for (const key of ['name', 'nameEn', 'publisher']) text(value[key], 120)
  for (const key of ['description', 'descriptionEn']) text(value[key], 2048)
  if (typeof value.version !== 'string' || value.version.length > 64 || !semver.valid(value.version)
    || typeof value.minAppVersion !== 'string' || value.minAppVersion.length > 64 || !semver.valid(value.minAppVersion)) throw new Error('插件版本无效 / Invalid plugin version')
  if (semver.lt(appVersion, value.minAppVersion)) throw new Error(`插件要求应用 ${value.minAppVersion} / App version required`)
  if (value.apiVersion !== 1 || !Object.hasOwn(sections, String(value.section))) throw new Error('插件 API 或分区不支持 / Unsupported plugin API or section')
  if (!Array.isArray(value.platforms) || value.platforms.length !== 1 || value.platforms[0] !== 'darwin') throw new Error('插件平台不支持 / Unsupported plugin platform')
  if (!Array.isArray(value.permissions) || value.permissions.length > 16) throw new Error('插件权限列表无效 / Invalid permissions')
  for (const permission of value.permissions) text(permission, 120)
  return { id: value.id, version: value.version, apiVersion: 1, name: value.name as string, nameEn: value.nameEn as string,
    description: value.description as string, descriptionEn: value.descriptionEn as string, publisher: value.publisher as string,
    section: value.section as PluginManifest['section'], minAppVersion: value.minAppVersion, platforms: ['darwin'], permissions: [...value.permissions] }
}
export function packageName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-zA-Z0-9._-]{0,127}\.ocplugin$/.test(value) || value.includes('..')) throw new Error('插件包路径无效 / Invalid package path')
}
export function validateCatalog(bytes: Buffer, appVersion: string): PluginCatalog {
  if (bytes.length > MARKET_LIMITS.catalogBytes) throw new Error('插件目录超过限制 / Catalog exceeds limit')
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  object(value)
  if (value.schema !== 1 || !Array.isArray(value.plugins) || value.plugins.length > MARKET_LIMITS.catalogEntries) throw new Error('插件目录结构无效 / Invalid catalog')
  const ids = new Set<string>()
  const plugins: PluginCatalogEntry[] = value.plugins.map(raw => {
    object(raw)
    const manifest = validateManifest(raw.manifest, appVersion)
    if (ids.has(manifest.id)) throw new Error('插件目录有重复 ID / Duplicate plugin ID')
    ids.add(manifest.id)
    packageName(raw.package)
    if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)
      || !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) <= 0 || Number(raw.bytes) > MARKET_LIMITS.packageBytes) throw new Error('插件包完整性信息无效 / Invalid package integrity metadata')
    return { manifest, package: raw.package, sha256: raw.sha256, bytes: Number(raw.bytes) }
  })
  return { schema: 1, plugins }
}
export function validatePackage(bytes: Buffer, appVersion: string, expected?: PluginCatalogEntry): PluginPackage {
  if (bytes.length > MARKET_LIMITS.packageBytes) throw new Error('插件包超过限制 / Package exceeds limit')
  if (expected && (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256)) throw new Error('插件包 SHA-256 或大小不匹配 / Package integrity mismatch')
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  object(value)
  if (value.schema !== 1 || typeof value.code !== 'string' || !value.code.trim() || Buffer.byteLength(value.code) > MARKET_LIMITS.codeBytes) throw new Error('插件包代码无效或超限 / Invalid package code')
  const manifest = validateManifest(value.manifest, appVersion)
  if (expected && JSON.stringify(manifest) !== JSON.stringify(expected.manifest)) throw new Error('插件包清单与目录不符 / Package manifest mismatch')
  return { schema: 1, manifest, code: value.code }
}
