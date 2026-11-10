import assert from 'node:assert/strict'
import { test } from 'node:test'
import { link, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { artifactDigest, verifyArtifactDigests } from './local-delivery.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-chan-delivery-digest-'))
  t.after(() => rm(root, { recursive: true }))
  const version = '1.2.3'
  const paths = ['zip', 'dmg'].map(extension => path.join(root, `OC-Chan-${version}-mac-arm64.${extension}`))
  // This layer authenticates bytes. ZIP structure and DMG contents have separate checks.
  for (const [index, filename] of paths.entries()) await writeFile(filename, `local fixture ${index}`)
  const expected = await Promise.all(paths.map(artifactDigest))
  return { root, version, paths, expected }
}

test('the delivery receipt rejects altered bytes even when file size remains unchanged', async t => {
  const value = await fixture(t)
  await verifyArtifactDigests(value.root, value.version, value.expected)
  await writeFile(value.paths[0], 'local fixture X')
  await assert.rejects(verifyArtifactDigests(value.root, value.version, value.expected), /SHA-256 mismatch/)
})

test('wrong version, missing architecture artifact and truncation cannot produce a passing receipt', async t => {
  const value = await fixture(t)
  await assert.rejects(verifyArtifactDigests(value.root, '1.2.4', value.expected), /Invalid.*artifact/)
  await assert.rejects(verifyArtifactDigests(value.root, value.version, value.expected.slice(0, 1)), /requires exactly/)
  await assert.rejects(verifyArtifactDigests(value.root, value.version, [value.expected[0], value.expected[0]]), /duplicate/)
  await writeFile(value.paths[1], 'short')
  await assert.rejects(verifyArtifactDigests(value.root, value.version, value.expected), /size or SHA-256 mismatch/)
  await rm(value.paths[1])
  await assert.rejects(verifyArtifactDigests(value.root, value.version, value.expected), /ENOENT/)
})

test('artifact paths cannot escape through links and oversized files are rejected before reading', async t => {
  const value = await fixture(t)
  const alias = path.join(value.root, 'alias.zip')
  await symlink(value.paths[0], alias)
  await assert.rejects(artifactDigest(alias), /bounded regular file/)
  await rm(alias)
  await link(value.paths[0], alias)
  await assert.rejects(artifactDigest(value.paths[0]), /bounded regular file/)
  const large = path.join(value.root, 'large.zip')
  const handle = await open(large, 'wx')
  try { await handle.truncate(512 * 1024 ** 2 + 1) } finally { await handle.close() }
  await assert.rejects(artifactDigest(large), /bounded regular file/)
})
