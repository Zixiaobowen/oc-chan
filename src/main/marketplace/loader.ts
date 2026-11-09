import { compileFunction } from 'node:vm'
import * as os from 'node:os'
import { statfs } from 'node:fs/promises'
import type { PluginPackage } from '../../shared/marketplace'
import type { AnyCollectionPlugin } from '../plugins/contracts'
import { pluginSdk } from './sdk'

/** Trusted first-party CJS only; an allowlist is not a security sandbox. No require cache is created. */
export function loadPlugin(pkg: PluginPackage): AnyCollectionPlugin {
  const modules: Record<string, unknown> = { 'node:os': os, 'node:fs/promises': Object.freeze({ statfs }) }
  const requireBuiltin = (specifier: string) => {
    if (!Object.hasOwn(modules, specifier)) throw new Error(`插件引用未允许的模块 / Module not allowed: ${String(specifier).slice(0, 120)}`)
    return modules[specifier]
  }
  const module = { exports: {} as { createPlugin?: unknown } }
  compileFunction(pkg.code, ['exports', 'require', 'module'], { filename: `ocplugin:${pkg.manifest.id}@${pkg.manifest.version}` })(module.exports, requireBuiltin, module)
  if (typeof module.exports.createPlugin !== 'function') throw new Error('插件没有 createPlugin 导出 / Missing createPlugin export')
  const definition: AnyCollectionPlugin = module.exports.createPlugin(pluginSdk)
  if (!definition || definition.id !== pkg.manifest.id || definition.section !== pkg.manifest.section
    || typeof definition.create !== 'function' || !Array.isArray(definition.capabilities) || definition.capabilities.length > 16
    || definition.capabilities.some(value => typeof value !== 'string' || value.length > 120)
    || !Number.isSafeInteger(definition.intervalMs) || definition.intervalMs < 1000
    || !Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 1 || definition.timeoutMs > 30_000) throw new Error('插件运行接口无效 / Invalid plugin runtime contract')
  return definition
}
