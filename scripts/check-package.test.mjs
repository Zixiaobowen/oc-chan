import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as asar from '@electron/asar'
import { enforceBudget, inspectPackage } from './check-package.mjs'

const darwinOnly = { skip: process.platform !== 'darwin' ? 'Executable architecture checks require macOS /usr/bin/lipo' : false }
const helper = 'Contents/Resources/tern-navigation/present-window'
const glass = 'Contents/Resources/liquid-glass/liquid-glass.node'
const notificationPermission = 'Contents/Resources/notification-permission/notification-permission.node'
const plugin = 'Contents/Resources/tern-navigation/plugin/'
const archive = 'Contents/Resources/app.asar'
const rendererPackages = ['@dagrejs/dagre', '@xyflow/react', 'lucide-react', 'react', 'react-dom']
const mainPackages = ['js-yaml', 'semver']

async function put(root, name, content, mode) {
  const filename = path.join(root, name)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, content, mode ? { mode } : undefined)
  return filename
}
function macho(arch = 'arm64', fileType = 2) {
  // A genuine minimal thin Mach-O header, never executed by the gate.
  const bytes = Buffer.alloc(32)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  bytes.writeUInt32LE(arch === 'arm64' ? 0 : 3, 8)
  bytes.writeUInt32LE(fileType, 12)
  return bytes
}
async function fixture(t, arch = 'arm64') {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-chan-package-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = path.join(root, 'OC Chan.app')
  const staging = path.join(root, 'asar-source')
  const manifest = {
    name: 'oc-chan', version: '0.1.0', main: 'out/main/index.js',
    devDependencies: Object.fromEntries([...rendererPackages, ...mainPackages].map(name => [name, '^1.0.0'])),
    build: { productName: 'OC Chan' }
  }
  const lock = {
    name: manifest.name, version: manifest.version, lockfileVersion: 3,
    packages: {
      '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, devDependencies: manifest.devDependencies },
      ...Object.fromEntries([...rendererPackages, ...mainPackages].map(name => [`node_modules/${name}`, { version: '1.0.0', license: 'MIT', dev: true }]))
    }
  }
  await put(root, 'package.json', JSON.stringify(manifest))
  await put(root, 'package-lock.json', JSON.stringify(lock))
  await put(app, 'Contents/Info.plist', '<plist/>')
  await put(app, 'Contents/MacOS/OC Chan', macho(arch), 0o755)
  await put(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', macho(arch), 0o755)
  await put(app, helper, macho(arch), 0o755)
  await put(app, glass, macho(arch, 8), 0o755)
  await put(app, notificationPermission, macho(arch, 8), 0o755)
  await put(app, 'Contents/Resources/LICENSE.electron.txt', 'MIT License\nCopyright Electron contributors\n')
  await put(app, 'Contents/Resources/LICENSES.chromium.html', '<html>Chromium third-party licenses</html>')
  const pluginFiles = { 'plugin.toml': 'schema = 1\nid = "oc-chan-navigation"\nwindow = "window.luau"\n', 'window.luau': 'return {}\n' }
  for (const [name, content] of Object.entries(pluginFiles)) {
    await put(root, `resources/tern-navigation/plugin/${name}`, content)
    await put(app, plugin + name, content)
  }
  const systemManifest = { id: 'system', version: '1.0.0', apiVersion: 1, name: '系统监控', nameEn: 'System monitor', description: '系统资源', descriptionEn: 'System resources', publisher: 'OC Chan', section: 'system', minAppVersion: '0.1.0', platforms: ['darwin'], permissions: ['system-read'] }
  const systemPackage = JSON.stringify({ schema: 1, manifest: systemManifest, code: 'exports.createPlugin = sdk => ({ id: "system" });' })
  const catalog = JSON.stringify({ schema: 1, plugins: [{ manifest: systemManifest, package: 'system-1.0.0.ocplugin', sha256: createHash('sha256').update(systemPackage).digest('hex'), bytes: Buffer.byteLength(systemPackage) }] })
  for (const [name, content] of [['catalog.json', catalog], ['system-1.0.0.ocplugin', systemPackage]]) {
    await put(root, `out/plugin-market/${name}`, content)
    await put(app, `Contents/Resources/plugin-market/${name}`, content)
  }
  await put(staging, 'package.json', JSON.stringify({ name: manifest.name, version: manifest.version, main: manifest.main, dependencies: manifest.dependencies }))
  await put(staging, 'out/main/index.js', 'require("node:os")\n')
  await put(staging, 'out/preload/index.js', 'module.exports = {}\n')
  await put(staging, 'out/renderer/index.html', '<script type="module" src="./assets/index.js"></script><link rel="stylesheet" href="./assets/index.css">')
  await put(staging, 'out/renderer/assets/index.js', 'console.log("fixture")\n')
  await put(staging, 'out/renderer/assets/index.css', 'body { color: black }\n')
  await put(staging, 'out/renderer/bundled-dependencies.json', JSON.stringify({ schema: 1, packages: rendererPackages.map(name => ({ name, version: '1.0.0', license: 'MIT', renderedBytes: 10 })) }))
  await put(staging, 'out/renderer/THIRD_PARTY_NOTICES.txt', rendererPackages.map(name => `${name}@1.0.0\nMIT License\nCopyright fixture\n`).join('\n'))
  await put(staging, 'out/main/bundled-dependencies.json', JSON.stringify({ schema: 1, packages: mainPackages.map(name => ({ name, version: '1.0.0', license: 'MIT', renderedBytes: 10 })) }))
  await put(staging, 'out/main/THIRD_PARTY_NOTICES.txt', mainPackages.map(name => `${name}@1.0.0\nMIT License\nCopyright fixture\n`).join('\n'))
  const repack = async () => {
    asar.uncache(path.join(app, archive))
    await asar.createPackage(staging, path.join(app, archive))
  }
  await repack()
  const inspect = options => inspectPackage({ app, arch, root, measure: true, ...options })
  return { root, app, staging, manifest, lock, inspect, repack }
}
function baselineFor(report) {
  return {
    schema: 1,
    architectures: {
      [report.arch]: {
        limits: {
          appBytes: report.appBytes, asarBytes: report.asarBytes, helperBytes: report.helperBytes,
          zipBytes: 1000, dmgBytes: 1000,
          dependencyBytes: Object.fromEntries(report.dependencies.map(item => [item.name, item.bytes]))
        },
        entries: report.entries.map(({ path: name, bytes }) => ({ path: name, bytes }))
      }
    }
  }
}

for (const arch of ['arm64', 'x64']) {
  test(`valid ${arch} package reports streamed sizes, hashes and dependency provenance`, darwinOnly, async t => {
    const f = await fixture(t, arch)
    const output = path.join(f.root, 'report.json')
    const report = await f.inspect({ output })
    assert.equal(report.schema, 1)
    assert.equal(report.arch, arch)
    assert.equal(report.helperBytes, 32)
    assert.equal(report.budget.status, 'measurement-only')
    assert.equal(report.appBytes, report.entries.filter(item => item.kind !== 'asar').reduce((sum, item) => sum + item.bytes, 0))
    assert.ok(report.entries.every(item => /^[a-f0-9]{64}$/.test(item.sha256) && !path.isAbsolute(item.path)))
    assert.match(report.source.lockHash, /^[a-f0-9]{64}$/)
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), report)
    const baseline = baselineFor(report)
    const budget = await put(f.root, 'baseline.json', JSON.stringify(baseline))
    const gated = await f.inspect({ measure: false, budget })
    assert.equal(gated.budget.status, 'passed')
  })
}

test('a shipped Electron distribution must preserve its license notices', darwinOnly, async t => {
  const f = await fixture(t)
  await rm(path.join(f.app, 'Contents/Resources/LICENSE.electron.txt'))
  await assert.rejects(f.inspect(), /Missing app runtime resource/)
})

test('packaging refuses tampered or extra independently installable plugins', darwinOnly, async t => {
  const f = await fixture(t)
  const packagePath = 'Contents/Resources/plugin-market/system-1.0.0.ocplugin'
  const original = await readFile(path.join(f.app, packagePath))
  await put(f.app, packagePath, Buffer.concat([original, Buffer.from(' ')]))
  await assert.rejects(f.inspect(), /plugin integrity mismatch/)
  await put(f.app, packagePath, original)
  await put(f.app, 'Contents/Resources/plugin-market/unknown-1.0.0.ocplugin', original)
  await assert.rejects(f.inspect(), /Unlisted plugin package/)
})

for (const name of ['out/main/index.test.js', 'out/renderer/assets/debug.log', 'out/renderer/.cache/data', 'out/main/index.d.ts', 'out/main/index.js.map']) {
  test(`ASAR rejects prohibited ${name} even in measurement mode`, darwinOnly, async t => {
    const f = await fixture(t)
    await put(f.staging, name, 'prohibited')
    await f.repack()
    await assert.rejects(f.inspect())
  })
}
for (const name of ['Contents/Resources/logs/run.log', 'Contents/Resources/.cache/state', 'Contents/Resources/tests/fixture.js', 'Contents/Resources/personal.json']) {
  test(`filesystem rejects unexpected ${name}`, darwinOnly, async t => {
    const f = await fixture(t)
    await put(f.app, name, 'prohibited')
    await assert.rejects(f.inspect(), /Prohibited package entry|Unlisted app/)
  })
}
for (const change of ['missing', 'wrong-arch', 'non-executable', 'text', 'universal']) {
  test(`navigation helper rejects ${change}`, darwinOnly, async t => {
    const f = await fixture(t)
    const filename = path.join(f.app, helper)
    if (change === 'missing') await rm(filename)
    if (change === 'wrong-arch') await writeFile(filename, macho('x64'))
    if (change === 'non-executable') await chmod(filename, 0o644)
    if (change === 'text') await writeFile(filename, '#!/bin/sh\nexit 0\n')
    if (change === 'universal') {
      const bytes = Buffer.alloc(32)
      bytes.writeUInt32BE(0xcafebabe)
      await writeFile(filename, bytes)
    }
    await assert.rejects(f.inspect(), /Missing executable|Non-executable|single-architecture|Wrong architecture/)
  })
}
for (const change of ['missing', 'wrong-arch', 'wrong-type']) {
  test(`Liquid Glass native module rejects ${change}`, darwinOnly, async t => {
    const f = await fixture(t)
    const filename = path.join(f.app, glass)
    if (change === 'missing') await rm(filename)
    else await writeFile(filename, macho(change === 'wrong-arch' ? 'x64' : 'arm64', change === 'wrong-type' ? 2 : 8))
    await assert.rejects(f.inspect(), /Missing executable|Wrong architecture or Mach-O file type/)
  })
}
for (const change of ['missing', 'wrong-arch', 'wrong-type', 'oversized']) {
  test(`notification permission module rejects ${change}`, darwinOnly, async t => {
    const f = await fixture(t)
    const filename = path.join(f.app, notificationPermission)
    if (change === 'missing') await rm(filename)
    else if (change === 'oversized') await writeFile(filename, Buffer.concat([macho('arm64', 8), Buffer.alloc(256 * 1024)]))
    else await writeFile(filename, macho(change === 'wrong-arch' ? 'x64' : 'arm64', change === 'wrong-type' ? 2 : 8))
    await assert.rejects(f.inspect(), /Missing executable|Wrong architecture or Mach-O file type|256 KiB budget/)
  })
}
test('main executable is also checked for the requested architecture', darwinOnly, async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.app, 'Contents/MacOS/OC Chan'), macho('x64'))
  await assert.rejects(f.inspect(), /Wrong architecture/)
})
for (const change of ['missing', 'changed', 'schema', 'window']) {
  test(`plugin rejects ${change}`, darwinOnly, async t => {
    const f = await fixture(t)
    if (change === 'missing') await rm(path.join(f.app, plugin, 'window.luau'))
    if (change === 'changed') await writeFile(path.join(f.app, plugin, 'window.luau'), 'return { changed = true }')
    if (change === 'schema' || change === 'window') {
      const text = `schema = ${change === 'schema' ? 2 : 1}\nid = "oc-chan-navigation"\nwindow = "${change === 'window' ? 'other.luau' : 'window.luau'}"\n`
      await writeFile(path.join(f.app, plugin, 'plugin.toml'), text)
      await writeFile(path.join(f.root, 'resources/tern-navigation/plugin/plugin.toml'), text)
    }
    await assert.rejects(f.inspect(), /ENOENT|differs from source|Invalid plugin manifest/)
  })
}
test('manifest-lock mismatch fails without rewriting either input', darwinOnly, async t => {
  const f = await fixture(t)
  f.lock.packages[''].dependencies = { systeminformation: '^4.0.0' }
  const filename = await put(f.root, 'package-lock.json', JSON.stringify(f.lock))
  const before = await readFile(filename)
  await assert.rejects(f.inspect(), /Manifest-lock dependencies mismatch/)
  assert.deepEqual(await readFile(filename), before)
})
test('external runtime modules are rejected even when declared by the source', darwinOnly, async t => {
  const f = await fixture(t)
  f.manifest.dependencies = { external: '1.0.0' }
  f.lock.packages[''].dependencies = f.manifest.dependencies
  await put(f.root, 'package.json', JSON.stringify(f.manifest))
  await put(f.root, 'package-lock.json', JSON.stringify(f.lock))
  await assert.rejects(f.inspect(), /External runtime dependencies/)
})
test('bundled metadata cannot invent a dependency version', darwinOnly, async t => {
  const f = await fixture(t)
  await put(f.staging, 'out/renderer/bundled-dependencies.json', JSON.stringify({ schema: 1, packages: rendererPackages.map(name => ({ name, version: '9.9.9', license: 'MIT', renderedBytes: 10 })) }))
  await f.repack()
  await assert.rejects(f.inspect(), /Bundled dependency disagrees with lock/)
})
test('renderer references must resolve to packaged assets', darwinOnly, async t => {
  const f = await fixture(t)
  await rm(path.join(f.staging, 'out/renderer/assets/index.js'))
  await f.repack()
  await assert.rejects(f.inspect(), /Missing referenced renderer asset/)
})
test('framework symlinks may resolve internally but cannot escape the app', darwinOnly, async t => {
  const f = await fixture(t)
  const base = 'Contents/Frameworks/Electron Framework.framework'
  await symlink('A', path.join(f.app, base, 'Versions/Current'))
  await symlink('Versions/Current/Electron Framework', path.join(f.app, base, 'Electron Framework'))
  const report = await f.inspect()
  assert.equal(report.entries.filter(entry => entry.kind === 'symlink').length, 2)
  await rm(path.join(f.app, base, 'Electron Framework'))
  await symlink(path.relative(path.join(f.app, base), path.join(f.root, 'package.json')), path.join(f.app, base, 'Electron Framework'))
  await assert.rejects(f.inspect(), /Escaping app symlink/)
})
test('ASAR symlinks and undeclared development dependencies are forbidden', darwinOnly, async t => {
  const f = await fixture(t)
  await symlink('index.js', path.join(f.staging, 'out/renderer/assets/alias.js'))
  await f.repack()
  await assert.rejects(f.inspect(), /ASAR links and unpacked/)
  await rm(path.join(f.staging, 'out/renderer/assets/alias.js'))
  await put(f.staging, 'node_modules/react/index.js', 'module.exports = {}')
  await f.repack()
  await assert.rejects(f.inspect(), /Unlisted ASAR directory/)
})
test('oversized ASAR header is rejected before library allocation', darwinOnly, async t => {
  const f = await fixture(t)
  const bytes = Buffer.alloc(16)
  bytes.writeUInt32LE(4, 0)
  bytes.writeUInt32LE(0xffffffff, 4)
  await writeFile(path.join(f.app, archive), bytes)
  await assert.rejects(f.inspect(), /ASAR header exceeds bounds/)
})
test('normal mode requires a frozen baseline and writes a failed report', darwinOnly, async t => {
  const f = await fixture(t)
  const output = path.join(f.root, 'failed-report.json')
  await assert.rejects(f.inspect({ measure: false, output }), /ENOENT/)
  assert.equal(JSON.parse(await readFile(output, 'utf8')).budget.status, 'failed')
})
test('distribution hashes and budgets are architecture-specific', darwinOnly, async t => {
  const f = await fixture(t)
  const artifactsDir = path.join(f.root, 'artifacts')
  await put(artifactsDir, 'OC-Chan-0.1.0-mac-arm64.zip', 'zip fixture')
  await put(artifactsDir, 'OC-Chan-0.1.0-mac-arm64.dmg', 'dmg fixture')
  await put(artifactsDir, 'OC-Chan-0.1.0-mac-x64.zip', 'other architecture')
  const report = await f.inspect({ artifactsDir })
  assert.equal(report.artifacts.length, 2)
  assert.ok(report.artifacts.every(item => item.name.includes('arm64') && /^[a-f0-9]{64}$/.test(item.sha256)))
  const baseline = baselineFor(report)
  baseline.architectures.arm64.limits.zipBytes = 1
  assert.throws(() => enforceBudget(report, baseline), /zip.*bytes/)
})
for (const available of ['zip', 'dmg']) {
  test(`distribution gate rejects missing counterpart when only ${available} exists`, darwinOnly, async t => {
    const f = await fixture(t)
    const artifactsDir = path.join(f.root, 'artifacts')
    await put(artifactsDir, `OC-Chan-0.1.0-mac-arm64.${available}`, 'single artifact fixture')
    await assert.rejects(f.inspect({ artifactsDir }), /Missing arm64 distribution artifact/)
  })
}

test('locked versions must satisfy manifest ranges even when both root maps agree', darwinOnly, async t => {
  const f = await fixture(t)
  f.lock.packages['node_modules/react'].version = '4.0.0'
  await put(f.root, 'package-lock.json', JSON.stringify(f.lock))
  await assert.rejects(f.inspect(), /Locked direct version does not satisfy/)
})
for (const [name, content] of [
  ['out/renderer/assets/index.js', 'import { value } from "./missing.js"; console.log(value)'],
  ['out/renderer/assets/index.css', 'body { background: url("./missing.png") }']
]) {
  test(`referenced assets are checked inside ${name}`, darwinOnly, async t => {
    const f = await fixture(t)
    await put(f.staging, name, content)
    await f.repack()
    await assert.rejects(f.inspect(), /Missing referenced renderer asset/)
  })
}

const measured = {
  arch: 'arm64', appBytes: 1000, asarBytes: 100, helperBytes: 32,
  artifacts: [{ name: 'app.zip', bytes: 200 }, { name: 'app.dmg', bytes: 250 }],
  dependencies: [{ name: 'systeminformation', bytes: 50 }],
  entries: [{ path: 'asar:out/renderer/assets/new.js', bytes: 100 }]
}
test('frozen budgets pass equality and report the largest new entries on growth', () => {
  const baseline = baselineFor(measured)
  assert.equal(enforceBudget(measured, baseline).status, 'passed')
  baseline.architectures.arm64.entries = []
  baseline.architectures.arm64.limits.appBytes = 999
  assert.throws(() => enforceBudget(measured, baseline), error => {
    assert.match(error.message, /appBytes: 1000 > 999/)
    assert.match(error.message, /NEW asar:out\/renderer\/assets\/new.js/)
    assert.equal(error.growth[0].growthBytes, 100)
    return true
  })
})
test('dependency growth, absent architecture, and missing distribution limits fail closed', () => {
  const baseline = baselineFor(measured)
  baseline.architectures.arm64.limits.dependencyBytes.systeminformation = 49
  assert.throws(() => enforceBudget(measured, baseline), /dependency:systeminformation/)
  assert.throws(() => enforceBudget({ ...measured, arch: 'x64' }, baseline), /baseline for x64/)
  const invalid = baselineFor(measured)
  delete invalid.architectures.arm64.limits.dmgBytes
  assert.throws(() => enforceBudget(measured, invalid), /baseline limit: dmgBytes/)
})
