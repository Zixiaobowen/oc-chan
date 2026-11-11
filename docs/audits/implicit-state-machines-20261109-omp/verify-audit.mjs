import assert from 'node:assert/strict'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const directory = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(directory, '../../..')
const load = async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'))
const [inventory, coverage, baseline] = await Promise.all(['inventory.json', 'coverage.json', 'baseline.json'].map(load))
const batches = (await Promise.all([1, 2, 3].map(n => load(`batch-0${n}.json`)))).flat()
assert.deepEqual(batches, inventory, 'Incremental batches must reproduce inventory')
const ids = new Set(inventory.map(item => item.id))
assert.equal(ids.size, inventory.length, 'Duplicate semantic IDs')
assert.equal(new Set(inventory.map(item => item.name)).size, inventory.length, 'Duplicate responsibilities')
const paths = new Set(coverage.map(item => item.path))
assert.equal(paths.size, coverage.length)
assert.deepEqual([...paths].sort(), baseline.scope)
const owned = p => p.startsWith('src/') || p.startsWith('scripts/') || p.startsWith('.github/workflows/') || p.startsWith('.githooks/') || p.startsWith('resources/tern-navigation/plugin/') || ['package.json', 'electron.vite.config.ts', 'tsconfig.json'].includes(p)
const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split('\0').filter(Boolean)
const current = []
for (const p of new Set(listed.filter(owned))) {
  try { if ((await stat(path.join(root, p))).isFile()) current.push(p) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
assert.deepEqual(current.sort(), [...paths].sort(), 'Corpus additions/deletions since audit')
const texts = new Map()
for (const entry of coverage) {
  assert.ok(['已审', '不适用', '未审'].includes(entry.status))
  assert.ok(entry.reason)
  const bytes = await readFile(path.join(root, entry.path))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Source drift: ${entry.path}`)
  texts.set(entry.path, bytes.toString('utf8').split(/\r?\n/))
}
let citations = 0
for (const item of inventory) {
  for (const key of ['id', 'name', 'kind', 'states', 'transitions', 'lifecycle', 'risk', 'confidence', 'test_gap', 'state_owner', 'writers', 'readers']) assert.ok(item[key], `${item.id} missing ${key}`)
  for (const dependency of item.dependencies) assert.ok(ids.has(dependency), `Dangling dependency: ${dependency}`)
  for (const evidence of item.evidence) {
    assert.ok(paths.has(evidence.path))
    assert.equal(texts.get(evidence.path)[evidence.line - 1], evidence.excerpt, `Bad line evidence: ${evidence.path}:${evidence.line}`)
    citations++
  }
  for (const test of item.tests) assert.ok(paths.has(test), `Missing test evidence: ${test}`)
}
const count = (rows, field) => rows.reduce((result, row) => { result[row[field]] = (result[row[field]] || 0) + 1; return result }, {})
const result = {
  verifiedAt: new Date().toISOString(), repository: root, branch: baseline.branch, head: baseline.head,
  files: coverage.length, modules: new Set(coverage.map(item => item.module)).size,
  coverage: count(coverage, 'status'), machines: inventory.length, kinds: count(inventory, 'kind'),
  modelingRiskPriority: count(inventory, 'risk_level'), citations,
  incrementalBatchSizes: await Promise.all([1, 2, 3].map(async n => (await load(`batch-0${n}.json`)).length)),
  uniqueIds: true, allCitationsMatch: true, corpusMatches: true, sourceHashesUnchanged: true,
  productionBugsReproduced: 0, existingTestSuitesRun: false,
  sessionId: baseline.session_id, subagentId: baseline.subagent_id
}
await writeFile(path.join(directory, 'verification.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
