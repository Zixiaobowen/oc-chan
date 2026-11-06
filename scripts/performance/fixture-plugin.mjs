import path from 'node:path'
import { createHash } from 'node:crypto'

const PUBLIC = 'virtual:occhan-performance-fixture:'
const PREFIX = '\0' + PUBLIC
const DIRECTORIES = ['/Library/LaunchAgents', '/Library/LaunchDaemons', '/System/Library/LaunchAgents', '/System/Library/LaunchDaemons']

/** Install only in the isolated benchmark main-process Vite build. L0 keeps every production import. */
export function createFixturePlugin(manifest, sourceRoot) {
  if (manifest?.level === 'L0') return null
  if (!['L1', 'L2'].includes(manifest?.level)) throw new Error('Fixture plugin requires explicit L1 or L2 level')
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)) throw new Error('Fixture plugin sourceRoot must be absolute')
  if (typeof manifest.root !== 'string' || !path.isAbsolute(manifest.root) || manifest.home !== path.join(manifest.root, 'home'))
    throw new Error('Invalid fixture home')
  const directories = DIRECTORIES.map((directory, index) => {
    const target = path.join(manifest.root, 'empty-system', String(index))
    if (manifest.systemDirectories?.[directory] !== target) throw new Error('Invalid fixture system directory mapping')
    return [directory, target]
  })
  const schedules = path.join(sourceRoot, 'src/main/collectors/schedules.ts')
  const history = path.join(sourceRoot, 'src/main/collectors/hermes-history.ts')
  const eventHistory = path.join(sourceRoot, 'src/main/events/hermes.ts')
  const launchd = path.join(sourceRoot, 'src/main/collectors/launchd.ts')
  const resourceIO = path.join(sourceRoot, 'src/main/resource-io.ts')
  const resourceBudget = path.join(sourceRoot, 'src/main/resource-budget.ts')
  const collectionLimits = path.join(sourceRoot, 'src/main/collection-limits.ts')
  const namespace = createHash('sha256').update(JSON.stringify([manifest.seed, 'namespace', 0])).digest('hex').slice(0, 12)
  const services = 'services = {\n' + Array.from({ length: 1000 }, (_, index) =>
    `  - 0 local.occhan.perf.${namespace}.${String(index).padStart(4, '0')}`).join('\n') + '\n}\n'
  const modules = {
    os: `import os from 'node:os';
export * from 'node:os';
export const homedir = () => ${JSON.stringify(manifest.home)};
export default { ...os, homedir };
`,
    mapping: `import path from 'node:path';
const directories = ${JSON.stringify(directories)};
export function mapPath(value) {
  if (typeof value !== 'string') return value;
  for (const [source, target] of directories) {
    if (value === source) return target;
    if (value.startsWith(source + '/')) {
      const suffix = value.slice(source.length + 1);
      if (suffix.split('/').includes('..')) throw new Error('Fixture system path escapes directory');
      return path.join(target, suffix);
    }
  }
  return value;
}
`,
    fs: `import { opendir as realOpendir, stat as realStat } from 'node:fs/promises';
import { mapPath } from ${JSON.stringify(PUBLIC + 'mapping')};
export function opendir(file, ...options) { return realOpendir(mapPath(file), ...options); }
export function stat(file, ...options) { return realStat(mapPath(file), ...options); }
`,
    command: `import { runBudgetedCommand as realCommand } from ${JSON.stringify(resourceIO)};
import { collectionResources, throwIfAborted } from ${JSON.stringify(resourceBudget)};
import { mapPath } from ${JSON.stringify(PUBLIC + 'mapping')};
const services = ${JSON.stringify(services)};
function fixed(file, args) {
  if (file === '/bin/launchctl') {
    if (args.length !== 2 || !/^(system|gui\\/\\d+|user\\/\\d+)$/.test(args[1])) throw new Error('Unexpected fixture launchctl domain');
    if (args[0] === 'print') return { stdout: args[1].startsWith('gui/') ? services : 'services = {\\n}\\n', stderr: '' };
    if (args[0] === 'print-disabled') return { stdout: 'disabled services = {\\n}\\n', stderr: '' };
    throw new Error('Unexpected fixture launchctl operation');
  }
  if (file === '/usr/bin/crontab') {
    if (args.length !== 1 || args[0] !== '-l') throw new Error('Unexpected fixture crontab operation');
    return { stdout: '# OC Chan performance fixture: no crontab entries\\n', stderr: '' };
  }
}
export function runBudgetedCommand(source, file, args, options, signal) {
  if (file === '/bin/launchctl' || file === '/usr/bin/crontab') {
    return collectionResources.run({source, kind: 'command', stdoutBytes: options.maxBuffer, stderrBytes: options.maxBuffer, signal}, async () => {
      throwIfAborted(signal);
      return fixed(file, args);
    });
  }
  const mappedOptions = options.inputFile ? { ...options, inputFile: { ...options.inputFile, path: mapPath(options.inputFile.path) } } : options;
  return realCommand(source, file, args, mappedOptions, signal);
}
`
  }
  return {
    name: 'occhan-performance-fixtures',
    enforce: 'pre',
    // Rewrite these import specifiers before Rollup marks node builtins external.
    // Exact import cardinality makes production import drift an explicit build failure.
    transform(code, id) {
      const owner = id.split('?')[0]
      const replacements = owner === schedules
        ? [['node:os', 'os'], ['node:fs/promises', 'fs']]
        : owner === launchd ? [['../resource-io', 'command']]
        : owner === collectionLimits ? [['node:fs/promises', 'fs']]
        : owner === history || owner === eventHistory ? [['node:os', 'os']] : []
      if (!replacements.length) return null
      for (const [source, target] of replacements) {
        const pattern = new RegExp(`^(import [^\\n]+ from )(['"])${source}\\2`, 'gm')
        let count = 0
        code = code.replace(pattern, (_match, declaration) => {
          count++
          return declaration + JSON.stringify(PUBLIC + target)
        })
        if (count !== 1) throw new Error(`Expected one ${source} import in fixture target ${owner}`)
      }
      return { code, map: null }
    },
    resolveId(source) {
      const name = source.startsWith(PUBLIC) ? source.slice(PUBLIC.length)
        : source.startsWith(PREFIX) ? source.slice(PREFIX.length) : null
      if (name === null) return null
      if (!Object.hasOwn(modules, name)) throw new Error('Unknown fixture virtual module')
      return PREFIX + name
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null
      const code = modules[id.slice(PREFIX.length)]
      if (code === undefined) throw new Error('Unknown fixture virtual module')
      return code
    }
  }
}
