import { closeSync, fstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

const MAX_METADATA_BYTES = 1024 * 1024
const MAX_NOTICE_BYTES = 16 * 1024 * 1024
const MAX_FILES = 100000
const MAX_PACKAGES = 1024
const MAX_MODULES = 100000

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function readBounded(file: string, limit = MAX_METADATA_BYTES): string {
  const fd = openSync(file, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error(`License metadata is not a bounded file: ${file}`)
    const buffer = Buffer.alloc(stat.size + 1)
    let count = 0
    while (count < buffer.length) {
      const size = readSync(fd, buffer, count, buffer.length - count, null)
      if (size === 0) break
      count += size
    }
    if (count > stat.size) throw new Error(`License metadata changed while reading: ${file}`)
    return buffer.subarray(0, count).toString('utf8')
  } finally { closeSync(fd) }
}

/** The inventory describes code retained in final chunks, including transitive packages. */
export function rendererLicensePlugin(): Plugin {
  let root = ''
  return {
    name: 'oc-chan-renderer-licenses',
    apply: 'build',
    enforce: 'post',
    configResolved(config) { root = realpathSync(config.root) },
    generateBundle(_options, bundle) {
      const packages = new Map<string, { directory: string; name: string; version: string; license: string; renderedBytes: number }>()
      let modules = 0
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const [id, module] of Object.entries(output.modules)) {
          if (++modules > MAX_MODULES) throw new Error('Renderer module inventory exceeds its budget')
          if (module.renderedLength === 0 || id.startsWith('\0')) continue
          const clean = id.split('?')[0]
          const marker = '/node_modules/'
          const index = clean.lastIndexOf(marker)
          if (index === -1) continue
          if (!Number.isSafeInteger(module.renderedLength) || module.renderedLength < 0) throw new Error(`Missing rendered module size: ${id}`)
          const parts = clean.slice(index + marker.length).split('/')
          const count = parts[0].startsWith('@') ? 2 : 1
          if (parts.length <= count || parts.slice(0, count).some(part => !part || part === '..' || part === '.')) throw new Error(`Invalid package module path: ${id}`)
          const directory = realpathSync(clean.slice(0, index + marker.length) + parts.slice(0, count).join('/'))
          // Renderer root can be src/renderer; node_modules must be in that root or an ancestor.
          let ancestor = root
          while (!inside(path.join(ancestor, 'node_modules'), directory) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor)
          if (!inside(path.join(ancestor, 'node_modules'), directory)) throw new Error(`Package escapes project dependency roots: ${id}`)
          if (!inside(directory, realpathSync(clean))) throw new Error(`Module escapes package: ${id}`)
          let entry = packages.get(directory)
          if (!entry) {
            if (packages.size >= MAX_PACKAGES) throw new Error('Renderer package inventory exceeds its budget')
            const metadataPath = path.join(directory, 'package.json')
            if (!inside(directory, realpathSync(metadataPath))) throw new Error(`Package metadata escapes package: ${directory}`)
            const metadata = JSON.parse(readBounded(metadataPath)) as { name?: unknown; version?: unknown; license?: unknown }
            if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string' || typeof metadata.license !== 'string' || !metadata.name || !metadata.version || !metadata.license) throw new Error(`Incomplete package license metadata: ${directory}`)
            if (metadata.name.length > 214 || metadata.version.length > 128 || metadata.license.length > 1024) throw new Error(`Package license identifiers exceed budget: ${directory}`)
            entry = { directory, name: metadata.name, version: metadata.version, license: metadata.license, renderedBytes: 0 }
            packages.set(directory, entry)
          }
          entry.renderedBytes += module.renderedLength
          if (!Number.isSafeInteger(entry.renderedBytes)) throw new Error('Rendered byte count exceeds safe integer range')
        }
      }
      if (packages.size === 0) throw new Error('Renderer has no attributable npm modules; license inventory cannot be verified')
      let files = 0
      let noticeBytes = 0
      const notices: string[] = []
      const inventory = new Map<string, { name: string; version: string; license: string; renderedBytes: number }>()
      for (const entry of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
        const pending = [{ directory: entry.directory, depth: 0, noticeDirectory: false }]
        const texts: { file: string; text: string }[] = []
        while (pending.length) {
          const current = pending.pop()!
          if (current.depth > 32) throw new Error(`License directory depth exceeds budget: ${entry.name}`)
          const handle = opendirSync(current.directory)
          try {
            let child
            while ((child = handle.readSync())) {
              if (++files > MAX_FILES) throw new Error('License discovery exceeds file budget')
              if (child.name === 'node_modules' || child.name === '.git') continue
              const file = path.join(current.directory, child.name)
              const namedNotice = /^(?:licen[cs]es?|copying|copyright|notices?|third[-_ ]party(?:[-_ ]notices)?)(?:$|[._ -])/i.test(child.name)
              if (child.isDirectory()) { pending.push({ directory: file, depth: current.depth + 1, noticeDirectory: current.noticeDirectory || namedNotice }); continue }
              if (!current.noticeDirectory && !namedNotice) continue
              if (!inside(entry.directory, realpathSync(file))) throw new Error(`License file escapes package: ${file}`)
              const text = readBounded(file)
              if (!text.trim()) throw new Error(`Empty license notice: ${file}`)
              noticeBytes += Buffer.byteLength(text)
              if (noticeBytes > MAX_NOTICE_BYTES) throw new Error('Combined license notices exceed byte budget')
              texts.push({ file: path.relative(entry.directory, file).split(path.sep).join('/'), text })
            }
          } finally { handle.closeSync() }
        }
        if (!texts.some(item => item.file.split('/').some(part => /^(?:licen[cs]es?|copying)(?:$|[._ -])/i.test(part)))) throw new Error(`No license/copyright notice found for ${entry.name}@${entry.version}; NOTICE alone is insufficient`)
        notices.push(`===== ${entry.name}@${entry.version} (${entry.license}) =====\n` + texts.sort((a, b) => a.file.localeCompare(b.file)).map(item => `--- ${item.file} ---\n${item.text}\n`).join('\n'))
        const key = `${entry.name}@${entry.version}`
        const prior = inventory.get(key)
        if (prior) {
          if (prior.license !== entry.license) throw new Error(`Conflicting package licenses: ${key}`)
          prior.renderedBytes += entry.renderedBytes
        } else {
          const { name, version, license, renderedBytes } = entry
          inventory.set(key, { name, version, license, renderedBytes })
        }
      }
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: notices.join('\n') })
      this.emitFile({ type: 'asset', fileName: 'bundled-dependencies.json', source: JSON.stringify({ schema: 1, packages: [...inventory.values()] }, null, 2) + '\n' })
    }
  }
}
