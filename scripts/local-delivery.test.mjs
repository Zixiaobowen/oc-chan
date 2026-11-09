import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { copyFile, link, mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
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
  try { await handle.truncate(1024 ** 3 + 1) } finally { await handle.close() }
  await assert.rejects(artifactDigest(large), /bounded regular file/)
})

const exec = promisify(execFile)
test('distribution CLI rejects malformed and obsolete output arguments before building', async () => {
  for (const args of [
    ['--config.directories.output=/tmp/unused'], ['--out'], ['--out', '--dir'],
    ['--out', ''], ['--out', '/tmp/one', '--out', '/tmp/two'], ['--arm64', '--x64'], ['--dir', '--dir'],
  ]) {
    await assert.rejects(exec(process.execPath, [fileURLToPath(new URL('./dist.mjs', import.meta.url)), ...args], { timeout: 10000 }),
      error => error.code === 1 && /Usage: node scripts\/dist.mjs/.test(error.stderr) && !/build:app/.test(error.stdout))
  }
})

test('distribution rejects invalid release versions before application compilation', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-chan-dist-preflight-'))
  t.after(() => rm(root, { recursive: true }))
  await mkdir(path.join(root, 'scripts'))
  for (const name of ['dist.mjs', 'release-config.mjs']) await copyFile(new URL(name, import.meta.url), path.join(root, 'scripts', name))
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(root, 'node_modules'))
  for (const version of ['01.2.3', '1.2.3+local', '1.2.3-latest.1']) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version }))
    await assert.rejects(exec(process.execPath, [path.join(root, 'scripts/dist.mjs'), '--dir', '--out', path.join(root, 'artifacts')], {
      cwd: root, timeout: 10000, env: { ...process.env, GITHUB_EVENT_NAME: '', GITHUB_REF: '' },
    }), error => error.code === 1 && /Invalid release version|build metadata|Prerelease channel/.test(error.stderr) && !/build:app/.test(error.stdout))
  }
})
