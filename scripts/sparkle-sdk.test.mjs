import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ensureSparkleSDK, runtimeSparkleEntries, verifySparkleEntries, embedSparkle } from './sparkle-sdk.mjs'

test('embedded SDK preserves the complete upstream sealed framework and relative links', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'oc-sparkle-package-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const app = path.join(directory, 'OC Chan.app')
  await embedSparkle(app)
  const entries = runtimeSparkleEntries()
  await verifySparkleEntries(path.join(app, 'Contents/Frameworks'), entries)
  assert.ok(entries.some(entry => entry.target !== undefined))
  assert.ok((await readFile(path.join(app, 'Contents/Frameworks/Sparkle.framework/Versions/B/Headers/SPUUpdater.h'), 'utf8')).includes('SPUUpdater'))
  assert.ok((await readFile(path.join(app, 'Contents/Resources/Sparkle-LICENSE.txt'), 'utf8')).includes('Copyright'))
  const runtime = path.join(app, 'Contents/Frameworks/Sparkle.framework/Versions/B/Sparkle')
  const bytes = await readFile(runtime); bytes[bytes.length - 1] ^= 1; await writeFile(runtime, bytes)
  await assert.rejects(verifySparkleEntries(path.join(app, 'Contents/Frameworks'), entries), /differs from pin/)
})

test('cached SDK must match the trusted archive manifest before use', async t => {
  const sdk = await ensureSparkleSDK()
  const directory = await mkdtemp(path.join(tmpdir(), 'oc-sparkle-cache-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(path.join(directory, 'resources'))
  for (const file of ['sparkle.json', 'sparkle-sdk-manifest.json']) await cp(path.join('resources', file), path.join(directory, 'resources', file))
  const target = path.join(directory, 'out/sparkle-sdk/2.10.1'); await mkdir(path.dirname(target), { recursive: true })
  await cp(sdk.directory, target, { recursive: true, verbatimSymlinks: true })
  await writeFile(path.join(target, 'bin/sign_update'), 'altered signer')
  await assert.rejects(ensureSparkleSDK({ root: directory }), /differs from pin/)
})
