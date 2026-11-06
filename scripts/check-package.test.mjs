import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { finished } from 'node:stream/promises'
import * as asar from '@electron/asar'
import { inspectPackage } from './check-package.mjs'

const rendererNames = ['@dagrejs/dagre', '@xyflow/react', 'lucide-react', 'react', 'react-dom']

async function fixture(t, change = () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-chan-package-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'input')
  const app = path.join(root, 'OC Chan.app')
  const packages = rendererNames.map(name => ({ name, version: '1.0.0', license: 'MIT', renderedBytes: 5 }))
  const manifest = { name: 'oc-chan', version: '0.1.0', main: 'out/main/index.js', dependencies: { systeminformation: '^5.0.0' }, devDependencies: Object.fromEntries(rendererNames.map(name => [name, '^1.0.0'])) }
  const packed = { name: manifest.name, version: manifest.version, main: manifest.main, dependencies: manifest.dependencies }
  const lock = { packages: { '': manifest, 'node_modules/systeminformation': { version: '5.0.0', license: 'MIT' }, ...Object.fromEntries(packages.map(item => [`node_modules/${item.name}`, { version: item.version, license: item.license }])) } }
  const files = {
    'package.json': JSON.stringify(packed),
    'out/main/index.js': "require('systeminformation')\n",
    'out/preload/index.js': 'exports.ready = true\n',
    'out/renderer/index.html': '<script src="./assets/app.js"></script>',
    'out/renderer/assets/app.js': 'document.body.textContent = "ready"',
    'out/renderer/bundled-dependencies.json': JSON.stringify({ schema: 1, packages }),
    'out/renderer/THIRD_PARTY_NOTICES.txt': packages.map(item => `===== ${item.name}@${item.version} (${item.license}) =====\nMIT License\n`).join('\n'),
    'node_modules/systeminformation/package.json': JSON.stringify({ name: 'systeminformation', version: '5.0.0', main: './lib/index.js' }),
    'node_modules/systeminformation/lib/index.js': 'exports.currentLoad = async () => ({ currentLoad: 10 })'
  }
  change({ files, manifest, packed, lock })
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(source, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest))
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock))
  await mkdir(path.join(app, 'Contents/Resources'), { recursive: true })
  await finished(await asar.createPackage(source, path.join(app, 'Contents/Resources/app.asar')))
  return { root, app }
}

test('a distributable retains the real collector dependency and bundled frontend attribution', async t => {
  const { root, app } = await fixture(t)
  const report = await inspectPackage(app, { root })
  assert.deepEqual(report.runtimeDependencies, [{ name: 'systeminformation', version: '5.0.0' }])
  assert.deepEqual(report.bundledDependencies.map(item => item.name), rendererNames)
})

test('a copied frontend dependency rejects the package before distribution', async t => {
  const { root, app } = await fixture(t, ({ files }) => { files['node_modules/react/index.js'] = 'module.exports = {}' })
  await assert.rejects(inspectPackage(app, { root }), /Unexpected runtime dependency: node_modules\/react/)
})

test('missing collector entry or mismatched collector version rejects the package', async t => {
  for (const change of [
    ({ files }) => { delete files['node_modules/systeminformation/lib/index.js'] },
    ({ files }) => { files['node_modules/systeminformation/package.json'] = JSON.stringify({ name: 'systeminformation', version: '6.0.0', main: 'lib/index.js' }) }
  ]) {
    const { root, app } = await fixture(t, change)
    await assert.rejects(inspectPackage(app, { root }), /Collector runtime entry is missing|Collector package disagrees/)
  }
})

test('missing attribution and a stale bundled dependency version reject the package', async t => {
  for (const change of [
    ({ files }) => { delete files['out/renderer/THIRD_PARTY_NOTICES.txt'] },
    ({ files }) => { files['out/renderer/THIRD_PARTY_NOTICES.txt'] = 'Only an unrelated license remains' },
    ({ files }) => { const inventory = JSON.parse(files['out/renderer/bundled-dependencies.json']); inventory.packages[0].version = '2.0.0'; files['out/renderer/bundled-dependencies.json'] = JSON.stringify(inventory) }
  ]) {
    const { root, app } = await fixture(t, change)
    await assert.rejects(inspectPackage(app, { root }), /Missing or oversized required file|Missing bundled license|Bundled dependency disagrees/)
  }
})

test('development sources and oversized archives cannot enter the application', async t => {
  for (const [name, content, expected] of [
    ['out/main/index.js.map', '{}', /Development file in application/],
    ['out/renderer/assets/oversized.bin', Buffer.alloc(3 * 1024 * 1024), /ASAR size budget exceeded/]
  ]) {
    const { root, app } = await fixture(t, ({ files }) => { files[name] = content })
    await assert.rejects(inspectPackage(app, { root }), expected)
  }
})
