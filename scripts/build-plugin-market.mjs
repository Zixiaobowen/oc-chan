import { build } from 'vite'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const root = fileURLToPath(new URL('../', import.meta.url))
const allowedBuiltins = ['node:os', 'node:fs/promises']

/** Version/entry overrides are for controlled integration builds, never remote code loading. */
export async function buildPluginMarket(outputDir, { version, entry = path.join(root, 'src/plugins/system-monitor/main/index.ts') } = {}) {
  if (typeof outputDir !== 'string' || !outputDir) throw new Error('A plugin market output directory is required')
  const manifest = JSON.parse(await readFile(path.join(root, 'src/plugins/system-monitor/manifest.json'), 'utf8'))
  if (version !== undefined) {
    if (typeof version !== 'string' || version.length > 64 || !semver.valid(version)) throw new Error('Invalid plugin build version')
    manifest.version = version
  }
  const result = await build({
    root, configFile: false, logLevel: 'warn',
    build: {
      write: false, minify: false, sourcemap: false, target: 'node24',
      lib: { entry: path.resolve(entry), formats: ['cjs'], fileName: () => 'system.cjs' },
      rolldownOptions: { external: allowedBuiltins }
    }
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(result => result.output ?? [])
  if (outputs.length !== 1 || outputs[0].type !== 'chunk') throw new Error('Plugin must compile to exactly one CommonJS file')
  const chunk = outputs[0]
  if (chunk.imports.some(specifier => !allowedBuiltins.includes(specifier)) || chunk.dynamicImports.length) throw new Error('Plugin contains non-public runtime dependencies')
  const modules = Object.keys(chunk.modules)
  if (modules.some(module => module.includes('/src/main/'))) throw new Error('Plugin must use the injected host SDK, not bundle host modules')
  if (Buffer.byteLength(chunk.code) > 1024 * 1024) throw new Error('Compiled plugin exceeds its code budget')
  const bytes = Buffer.from(JSON.stringify({ schema: 1, manifest, code: chunk.code }))
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Plugin package exceeds its byte budget')
  const packageName = `system-${manifest.version}.ocplugin`
  const catalog = { schema: 1, plugins: [{ manifest, package: packageName, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }] }
  const directory = path.resolve(outputDir)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, packageName), bytes)
  await writeFile(path.join(directory, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`)
  return { directory, catalog, packagePath: path.join(directory, packageName) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPluginMarket(process.argv[2] ?? path.join(root, 'out/plugin-market'))
}
