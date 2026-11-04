import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AgentInfo, TernTarget } from '../shared/types'

const exec = promisify(execFile)
async function runCommand(file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(file, args, { timeout: 5000, maxBuffer: 2 * 1024 * 1024 })
    return stdout
  } catch (error) {
    if (error && typeof error === 'object' && 'stderr' in error &&
        typeof error.stderr === 'string' && error.stderr.trim()) {
      throw new Error(error.stderr.trim(), { cause: error })
    }
    throw error
  }
}

export function resolveTernTarget(agents: AgentInfo[], agentId: string): TernTarget {
  const byId = new Map(agents.map(agent => [agent.id, agent]))
  const visited = new Set<string>()
  let agent = byId.get(agentId)
  if (!agent) throw new Error('该 Agent 已退出，请刷新后重试。')
  if (agent.runtime !== 'OMP') throw new Error('该操作仅支持 OMP 会话。')
  while (agent && agent.runtime === 'OMP' && !visited.has(agent.id)) {
    visited.add(agent.id)
    if (agent.tern) return agent.tern
    agent = agent.parentId ? byId.get(agent.parentId) : undefined
  }
  throw new Error('未找到该 OMP 会话对应的 Tern 标签页。请确认会话仍在 Tern 中打开。')
}

export async function focusAgentInTern(
  agents: AgentInfo[], agentId: string, run = runCommand,
  resources = path.resolve(__dirname, '../../resources/tern-navigation')
): Promise<void> {
  const target = resolveTernTarget(agents, agentId)
  const processes = await run('/bin/ps', ['-axo', 'pid=,comm='])
  const tern = processes.match(/^\s*(\d+)[ \t]+(.+\/Tern\.app\/Contents\/MacOS\/tern)$/m)
  if (!tern) throw new Error('Tern 尚未运行，请打开 Tern 后重试。')
  const [, , executable] = tern
  const snapshot = JSON.parse(await run(executable, ['inspect', '--json', '--window', target.windowKey]))
  if (!Array.isArray(snapshot?.panes)) throw new Error('无法读取 Tern 标签页信息，请稍后重试。')
  const pane = snapshot.panes.find((item: { pane?: unknown } | null) => item?.pane === target.paneId)
  if (!pane || pane.exited != null || pane.omp_session_file !== target.sessionFile) {
    throw new Error('对应的 Tern 标签页已关闭、移动或更换会话，请刷新后重试。')
  }
  const result = JSON.parse(await run(executable, ['focus', String(target.paneId), '--json', '--window', target.windowKey]))
  if (result?.block !== target.paneId) throw new Error('Tern 未确认跳转到目标标签页，请重试。')
  const catalog = JSON.parse(await run(executable, ['plugin', 'list', '--json']))
  if (!Array.isArray(catalog?.plugins)) throw new Error('无法读取 Tern 插件状态。')
  const plugin = catalog.plugins.find((item: { id: string }) => item.id === 'oc-chan-navigation')
  if (!plugin) {
    await run(executable, ['plugin', 'install', path.join(resources, 'plugin'), '--json'])
  } else if (plugin.status !== 'ready' || !plugin.window) {
    throw new Error('请在 Tern 中启用 OC Chan Window Navigation 插件后重试。')
  }
  const prefix = `[Tern ${JSON.stringify(target.windowKey)}] `
  await run('/usr/bin/osascript', ['-e', 'tell application id "so.stencil.tern" to activate'])
  const presented = JSON.parse(await run(path.join(resources, 'present-window'), [prefix]))
  if (!Number.isInteger(presented?.pid) || presented.pid <= 0 || presented.main !== true ||
      typeof presented.windowTitle !== 'string' || !presented.windowTitle.startsWith(prefix)) {
    throw new Error('未确认目标 Tern 原生窗口已显示并获得焦点。')
  }
}
