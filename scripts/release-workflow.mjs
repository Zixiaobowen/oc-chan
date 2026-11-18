import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { releaseInfo, releaseRepository, requireReleaseEnvironment } from './release-config.mjs'
import { compareVersions } from './sparkle-appcast.mjs'

const commandOptions = { encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }
const git = (...args) => execFileSync('git', args, commandOptions).trim()
const version = (...args) => JSON.parse(execFileSync(process.execPath, ['scripts/version.mjs', ...args], commandOptions))

export function requireMain(env) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== releaseRepository) throw new Error('Release entry points require workflow_dispatch on the source repository main branch')
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) throw new Error('Release entry points require an exact main commit')
}

export function stableTarget(requested, checked, env, publicKey) {
  requireMain(env)
  const info = releaseInfo(requested)
  if (checked.version !== info.version) throw new Error('Requested version does not match the selected main commit')
  requireReleaseEnvironment(info, { ...env, GITHUB_REF: `refs/tags/${info.tag}` }, publicKey)
  return info
}

export function requireMatchingTag(existingCommit, commit) {
  if (existingCommit !== commit) throw new Error('Existing release tag does not point to the selected main commit; tags cannot be overwritten')
}

export function githubApi(env, transport = fetch) {
  if (!env.GH_TOKEN?.trim()) throw new Error('GH_TOKEN is required for release automation')
  return async (route, method = 'GET', body) => {
    const response = await transport(`https://api.github.com/repos/${releaseRepository}/${route}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`GitHub ${method} ${route}: HTTP ${response.status}`)
    }
    if (response.status === 204) return undefined
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > 2 * 1024 * 1024) throw new Error('GitHub response exceeds 2 MiB')
      chunks.push(Buffer.from(chunk))
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
  }
}

async function requireUnpublished(api, tag) {
  // Authenticated listing includes drafts, unlike a public release lookup.
  for (let page = 1; page <= 100; page++) {
    const releases = await api(`releases?per_page=100&page=${page}`)
    if (releases.some(release => release.tag_name === tag)) throw new Error(`Release ${tag} already exists (including drafts); refusing to rebuild or overwrite it`)
    if (releases.length < 100) return
  }
  throw new Error('Release history exceeds the 10,000-entry preflight limit')
}

export function verifyDispatchCommit(env, head) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') return
  if (head !== env.GITHUB_SHA) throw new Error('Build checkout differs from the dispatched commit')
  const expected = env.EXPECTED_SHA
  if (!expected && env.GITHUB_REF === 'refs/heads/main') return
  if (!/^[a-f0-9]{40}$/.test(expected || '') || expected !== head) throw new Error('Dispatched ref moved or expected_sha does not match the requested commit')
}

export async function run(command, env = process.env, dependencies = {}) {
  const runGit = dependencies.git || git
  const runVersion = dependencies.version || version
  const readNotes = dependencies.readNotes || (file => readFileSync(file, 'utf8'))
  if (command === 'verify-build') {
    verifyDispatchCommit(env, runGit('rev-parse', 'HEAD'))
    const tagged = env.GITHUB_REF?.startsWith('refs/tags/')
    const checked = runVersion('check', ...(tagged ? ['--release'] : []))
    if (tagged) {
      if (!['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || env.GITHUB_REF !== `refs/tags/${checked.tag}`) throw new Error('Release tag does not match the checked version')
      runGit('merge-base', '--is-ancestor', 'HEAD', 'origin/main')
    }
    return checked
  }
  requireMain(env)
  const api = githubApi(env, dependencies.fetch)
  const dispatch = (ref, sha) => api('actions/workflows/build.yml/dispatches', 'POST', { ref, inputs: { expected_sha: sha } })
  if (runGit('rev-parse', 'HEAD') !== env.GITHUB_SHA) throw new Error('Checkout does not match the selected main commit')
  runGit('merge-base', '--is-ancestor', env.GITHUB_SHA, 'origin/main')
  if (command === 'prepare') {
    if (!['patch', 'minor', 'major'].includes(env.RELEASE_BUMP)) throw new Error('Invalid release bump')
    if (!env.RELEASE_NOTES?.trim()) throw new Error('Release notes must not be empty')
    const temporary = mkdtempSync(path.join(tmpdir(), 'oc-release-'))
    let bumped
    try {
      const notes = path.join(temporary, 'notes.md')
      writeFileSync(notes, env.RELEASE_NOTES, { flag: 'wx', mode: 0o600 })
      bumped = runVersion('bump', env.RELEASE_BUMP, '--notes-file', notes)
    } finally {
      rmSync(temporary, { recursive: true })
    }
    const { version: productVersion } = releaseInfo(bumped.version)
    const branch = `release/${productVersion}`
    // Reserve the branch without force before creating the release commit.
    await api('git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: env.GITHUB_SHA })
    runGit('switch', '-c', branch)
    runGit('add', '--', ...bumped.files)
    runGit('-c', 'user.name=bowen.sun', '-c', 'user.email=bowen.sun@zstack.io', 'commit', '-m', `chore: prepare release ${productVersion}`)
    runGit('push', 'origin', `HEAD:refs/heads/${branch}`)
    const sha = runGit('rev-parse', 'HEAD')
    const checks = `https://github.com/${releaseRepository}/actions/workflows/build.yml?query=${encodeURIComponent(`branch:${branch}`)}`
    const body = `${readNotes(`releases/${productVersion}.md`)}\n\nValidation commit: ${sha}\n\n[Build validation runs](${checks})\n`
    const pr = await api('pulls', 'POST', { title: `Release ${productVersion}`, head: branch, base: 'main', body })
    // GITHUB_TOKEN-generated PR events do not start CI, so explicitly request it.
    await dispatch(branch, sha)
    return { version: productVersion, branch, pullRequest: pr.html_url }
  }
  if (command === 'stable') {
    const info = stableTarget(env.RELEASE_VERSION, runVersion('check', '--release'), env, dependencies.publicKey)
    const channel = env.RELEASE_CHANNEL
    if (!['regular', 'lts'].includes(channel)) throw new Error('Invalid stable release channel')
    const message = `OC Chan channel: ${channel}`
    for (const tag of runGit('tag', '--list', 'v*').split('\n')) {
      if (/^v\d+\.\d+\.\d+$/.test(tag) && compareVersions(tag.slice(1), info.version) > 0) throw new Error(`A newer version tag already exists: ${tag}`)
    }
    await requireUnpublished(api, info.tag)
    const refs = await api(`git/matching-refs/tags/${info.tag}`)
    const existing = refs.find(ref => ref.ref === `refs/tags/${info.tag}`)
    if (existing) {
      // Peel annotated tags too, while requiring the exact selected main commit.
      runGit('fetch', 'origin', `refs/tags/${info.tag}`)
      requireMatchingTag(runGit('rev-parse', 'FETCH_HEAD^{commit}'), env.GITHUB_SHA)
      if (runGit('for-each-ref', '--format=%(objecttype):%(contents)', `refs/tags/${info.tag}`) !== `tag:${message}`) throw new Error('Existing tag channel differs from the requested channel')
    } else {
      const tag = await api('git/tags', 'POST', { tag: info.tag, message, object: env.GITHUB_SHA, type: 'commit' })
      await api('git/refs', 'POST', { ref: `refs/tags/${info.tag}`, sha: tag.sha })
    }
    await dispatch(info.tag, env.GITHUB_SHA)
    return info
  }
  throw new Error(`Unknown release workflow command: ${command}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await run(process.argv[2])))
}
