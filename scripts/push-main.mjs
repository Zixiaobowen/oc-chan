import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cleanupLocalWorktree } from './local-app-lifecycle.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const githubRemote = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)Zixiaobowen\/oc-chan(?:\.git)?\/?$/i
const hash = /^[a-f0-9]{40}$/

function git(root, args, { inherit = false, timeout = 30_000 } = {}) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024,
    stdio: inherit ? ['inherit', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe']
  }) ?? ''
}

function configValues(root, name) {
  try { return git(root, ['config', '--get-all', name]).trim().split('\n') }
  catch (error) {
    if (error.status === 1 && !error.stdout && !error.stderr) return []
    throw error
  }
}

function ancestor(root, commit, target) {
  try { git(root, ['merge-base', '--is-ancestor', commit, target]); return true }
  catch (error) {
    if (error.status === 1) return false
    throw error
  }
}

export function registeredWorktrees(root) {
  const fields = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0')
  const result = []
  let entry = null
  for (const field of fields) {
    if (field.startsWith('worktree ')) {
      if (result.length >= 128) throw new Error('工作区数量超过 128，拒绝自动清理')
      entry = { root: field.slice(9) }
      result.push(entry)
    } else if (field === 'bare' && entry) entry.bare = true
    else if ((field === 'prunable' || field.startsWith('prunable ')) && entry) entry.prunable = true
  }
  if (!result.length) throw new Error('Git 未返回可验证的工作区')
  return result
}

function documentation(filename) {
  return /^(?:README(?:\.[^/]+)?\.md|AGENTS\.md|CHANGELOG\.md)$/.test(filename) || /^docs\/.+\.md$/.test(filename) || /^docs\/codex-handoffs\/[^/]+\.html$/.test(filename)
}

export function dirtyProductPaths(root) {
  const fields = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).split('\0')
  const result = new Set()
  for (let index = 0; index < fields.length; index++) {
    const row = fields[index]
    if (!row) continue
    if (!/^[ MTADRCU?!]{2} /.test(row)) throw new Error('无法解析工作区状态，拒绝清理')
    const names = [row.slice(3)]
    if (/[RC]/.test(row.slice(0, 2))) {
      const original = fields[++index]
      if (!original) throw new Error('Git 重命名状态缺少来源，拒绝清理')
      names.push(original)
    }
    for (const name of names) if (!documentation(name)) result.add(name)
    if (result.size > 20_000) throw new Error('工作区改动数量超过上限，拒绝清理')
  }
  return [...result]
}

function validateOrigin(root) {
  // Git transport rewrites and SSH configuration remain Git's responsibility.
  // Both configured fetch and push destinations must name this GitHub repository.
  const fetch = configValues(root, 'remote.origin.url')
  const push = configValues(root, 'remote.origin.pushurl')
  if (fetch.length !== 1 || !githubRemote.test(fetch[0]) || push.length > 1 || push.some(url => !githubRemote.test(url))) {
    throw new Error('push:main 仅允许本项目 GitHub origin（Zixiaobowen/oc-chan）')
  }
}

function remoteMain(root, allowMissing = false) {
  let output
  try { output = git(root, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']) }
  catch (error) {
    if (allowMissing && error.status === 2 && !error.stdout) return null
    throw error
  }
  const rows = output.trim().split('\n')
  const fields = rows[0]?.split(/\s+/)
  if (rows.length !== 1 || fields.length !== 2 || !hash.test(fields[0]) || fields[1] !== 'refs/heads/main') {
    throw new Error('远端 main 返回无效引用，无法确认 GitHub 状态')
  }
  const remote = fields[0]
  git(root, ['fetch', '--no-tags', 'origin', remote], { timeout: 120_000 })
  return remote
}

export async function pushMain({ root = ROOT, cleanup = cleanupLocalWorktree, report = console.log } = {}) {
  root = realpathSync(root)
  if (realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !== root) throw new Error('入口必须位于 Git 工作区根目录')
  if (git(root, ['symbolic-ref', '--short', 'HEAD']).trim() !== 'main') throw new Error('push:main 仅允许在 main 分支执行；请先完成合并')
  validateOrigin(root)
  const commit = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  if (!hash.test(commit)) throw new Error('main 提交无效')
  const previousRemote = remoteMain(root, true)
  // Keep the normal pre-push hooks; a successful hook alone never authorizes cleanup.
  git(root, ['push', 'origin', 'main'], { inherit: true, timeout: 1_800_000 })
  report(`[oc-chan] git push origin main 已成功；确认 GitHub main 后清理当前及本次新合入工作区`)
  let remote
  try {
    validateOrigin(root)
    if (git(root, ['rev-parse', '--verify', 'refs/heads/main']).trim() !== commit) throw new Error('推送期间本地 main 发生变化')
    remote = remoteMain(root)
    if (!ancestor(root, commit, remote)) throw new Error('GitHub main 不包含本次提交，禁止清理')
  } catch (error) {
    throw new Error(`推送命令已成功，但远端提交无法确认；未执行任何清理：${error.message}`, { cause: error })
  }
  const outcomes = [], failures = []
  try {
    const common = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim())
    for (const entry of registeredWorktrees(root)) {
      if (entry.bare || entry.prunable) {
        report(`[oc-chan] 保留 ${entry.root}：${entry.bare ? '裸仓库' : '工作区已失效'}`)
        continue
      }
      try {
        const candidate = realpathSync(entry.root)
        if (realpathSync(git(candidate, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()) !== common ||
          realpathSync(git(candidate, ['rev-parse', '--show-toplevel']).trim()) !== candidate) throw new Error('工作区归属发生变化')
        const head = git(candidate, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
        if (!ancestor(root, head, remote)) {
          report(`[oc-chan] 保留 ${candidate}：HEAD 尚未合入 GitHub main`)
          outcomes.push({ root: candidate, retained: 'unmerged' })
          continue
        }
        if (candidate !== root && previousRemote && ancestor(root, head, previousRemote)) {
          report(`[oc-chan] 保留 ${candidate}：推送前已合入，不属于本次新合入任务`)
          outcomes.push({ root: candidate, retained: 'previously-merged' })
          continue
        }
        const dirty = dirtyProductPaths(candidate)
        if (dirty.length) {
          report(`[oc-chan] 保留 ${candidate}：有未提交产品文件 ${dirty.slice(0, 10).map(name => JSON.stringify(name)).join(', ')}${dirty.length > 10 ? ' …' : ''}`)
          outcomes.push({ root: candidate, retained: 'dirty-code' })
          continue
        }
        // Recheck the tip immediately before handing ownership-sensitive removal to lifecycle.
        if (git(candidate, ['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== head || dirtyProductPaths(candidate).length) throw new Error('工作区在清理前发生变化')
        const result = await cleanup({ root: candidate, apply: true })
        outcomes.push({ root: candidate, result })
        report(`[oc-chan] 已处理 ${candidate} 的本机临时应用`)
      } catch (error) { failures.push(new Error(`工作区清理失败 ${entry.root}：${error.message}`, { cause: error })) }
    }
  } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'GitHub main 推送及确认已成功，但本机清理失败；请处理原因后运行 cleanup:local -- --apply')
  return { commit, previousRemote, remote, outcomes }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve().then(() => {
    if (process.argv.length !== 2) throw new Error('用法：npm run push:main（不接受额外参数）')
    return pushMain()
  }).catch(error => {
    console.error('[oc-chan] push:main 失败：', error)
    process.exitCode = 1
  })
}
