import type { SourceCapability, SourceCapabilityId, SourceStatus } from './types'

const capability = (id: SourceCapabilityId, support: SourceCapability['support'], zh: string, en: string): SourceCapability =>
  ({ id, support, reason: { 'zh-CN': zh, en } })

const noProcesses = capability('processes', 'unsupported', '此来源不识别存活进程。', 'This source does not identify live processes.')
const noWorking = capability('working', 'unsupported', '此来源不提供 Agent 工作／空闲证据。', 'This source provides no evidence of agent working or idle state.')
const noRelationships = capability('relationships', 'unsupported', '此来源不提供 Agent 父子关系。', 'This source provides no agent parent–child relationships.')
const noActivity = capability('activity', 'unsupported', '此来源不提供近期工具／模型调用事件；运行状态或最近退出码不能替代调用证据。', 'This source provides no recent tool or model call events; runtime state or a last exit code is not call evidence.')
const noCount = capability('active-count', 'unsupported', '不提供精确活动 Agent 数量；OMP 进程内子代理生命周期与活动数量未公开。', 'No exact active agent count is available; OMP does not expose in-process subagent lifecycles or active counts.')
const noHistory = capability('history', 'unsupported', '不提供逐次任务执行历史；目前仅 Hermes 接入该接口，最近状态与采样趋势不等于执行历史。', 'No per-execution task history is provided; only Hermes implements that interface. Latest state and sample trends are not execution history.')
const agentNavigation = capability('navigation', 'partial', '可在应用内定位已识别 Agent 的详情；跳转外部 Tern 必须另有精确会话与窗口关联。', 'Identified agents can be located in local details; opening an external Tern tab separately requires an exact session and window association.')
const taskNavigation = capability('navigation', 'partial', '可在应用内定位已采集任务的详情；不跳转外部终端或调度器。', 'Collected tasks can be located in local details; this does not open an external terminal or scheduler.')
const systemNavigation = capability('navigation', 'partial', '可查看应用内系统监控；没有逐进程详情或外部终端跳转。', 'Metrics can be viewed in local system monitoring; there are no per-process details or external terminal jumps.')
const hermesHistory = capability('history', 'supported', 'Hermes 任务详情按需分页读取 executions.db 的逐次执行元数据；数据库不可用时明确报错，不读取执行正文。', 'Hermes task details read per-execution metadata from executions.db on demand in pages; an unavailable database is reported as an error, and execution content is not read.')

// Construct once at module initialization, never during source-list rendering.
function capabilities(overrides: Partial<Record<SourceCapabilityId, SourceCapability>>): readonly SourceCapability[] {
  return [overrides.processes ?? noProcesses, overrides.working ?? noWorking,
    overrides.relationships ?? noRelationships, overrides.activity ?? noActivity,
    overrides['active-count'] ?? noCount, overrides.history ?? noHistory,
    overrides.navigation ?? taskNavigation]
}

const processes = capabilities({
  processes: capability('processes', 'supported', '按可执行文件、CLI 入口与 PID 活性识别 OMP、Codex、Claude Code、OpenCode，并合并包装进程。', 'Identifies OMP, Codex, Claude Code and OpenCode by executable, CLI entry point and live PID, merging wrapper processes.'),
  working: capability('working', 'unsupported', 'CLI 进程存在只表示运行中；包括其它 CLI 在内，不能据此标记正在工作或空闲。', 'A live CLI process means running only; it cannot establish working or idle state for these CLIs.'),
  relationships: capability('relationships', 'partial', '识别独立进程中已确认的 Agent 祖先链；无法从进程表识别 OMP 同进程子代理。', 'Recognizes confirmed agent ancestry across separate processes; the process table cannot identify OMP subagents sharing a process.'),
  navigation: agentNavigation,
})
const ownership = capabilities({
  processes: capability('processes', 'partial', '将当前打开的会话和 lease 关联到已识别 PID；同进程子代理不代表额外进程。', 'Associates currently open sessions and leases with identified PIDs; in-process subagents are not additional processes.'),
  working: capability('working', 'unsupported', 'keepAlive 可保留已完成子代理的会话与 lease；驻留只能显示状态未知，不能证明正在工作。', 'keepAlive can retain completed subagent sessions and leases; residency leaves state unknown and does not prove ongoing work.'),
  relationships: capability('relationships', 'partial', '同进程 task 依父会话专用 artifacts 目录确认归属；独立进程保留已确认祖先链，普通 fork 的 parentSession 不等于子代理。', 'In-process tasks are linked through the parent session’s dedicated artifacts directory; separate processes retain confirmed ancestry, while an ordinary fork’s parentSession does not establish a subagent.'),
  navigation: agentNavigation,
})
const tern = capabilities({
  working: capability('working', 'partial', 'Tern inspect 按精确 session 关联，仅提供主代理 working／idle，不提供子代理生命周期。', 'Tern inspect matches exact sessions and provides working/idle state only for main agents, not subagent lifecycles.'),
  navigation: capability('navigation', 'partial', '精确关联窗口、pane 和会话后可跳转外部 Tern 标签页；子代理沿已确认父链定位，跳转前重新校验且需要辅助功能权限。应用内详情是独立导航。', 'Exact window, pane and session associations enable external Tern tab navigation; subagents follow confirmed parent links. Targets are revalidated and accessibility permission is required. Local details are separate navigation.'),
})
const socket = capabilities({
  processes: capability('processes', 'partial', '私有 host registry 经真实进程身份校验后，仅补充已识别主会话元数据。', 'The private host registry is checked against actual process identity and only enriches identified main-session metadata.'),
  working: capability('working', 'partial', '认证本地 socket 的 busy 字段提供主会话工作／空闲状态；不公开子代理 roster。', 'The authenticated local socket’s busy field supplies main-session working/idle state; no subagent roster is exposed.'),
  navigation: agentNavigation,
})
const activity = capabilities({
  activity: capability('activity', 'partial', '仅订阅当前归属 OMP 会话的结构化调用元数据，最多 128 个会话、每文件 128 KiB；近 6 秒证据在完成／取消／错误或超时后清除，不等于持续工作，无提示不等于空闲。', 'Subscribes only to structured call metadata in currently owned OMP sessions, up to 128 sessions and 128 KiB per file. Evidence expires after six seconds or completion/cancellation/error; it does not mean continuous work, and no hint does not mean idle.'),
  navigation: agentNavigation,
})
const launchctl = capabilities({
  processes: capability('processes', 'partial', '读取指定 launchd 域的服务 PID 与状态；不识别 Agent 运行时或同进程子代理。', 'Reads service PIDs and state in the specified launchd domain; it does not identify agent runtimes or in-process subagents.'),
  working: capability('working', 'partial', '可区分任务运行中、等待、停用与未加载；这是 launchd 任务状态，不是 Agent 推理／空闲状态，读取失败保留未知。', 'Distinguishes running, waiting, disabled and unloaded jobs. These are launchd job states, not agent reasoning/idle states; read failures leave state unknown.'),
})
const plist = capabilities({
  working: capability('working', 'partial', 'plist 仅提供调度与停用配置；任务运行状态须合并对应 launchctl 域，配置本身不能证明执行中。', 'Plists provide scheduling and disabled configuration only; runtime state requires the corresponding launchctl domain and cannot be inferred from configuration alone.'),
})
const ompCron = capabilities({
  working: capability('working', 'partial', 'OMP 任务元数据按 Label 合并 launchd 状态；元数据本身不提供忙闲，无对应配置时标记未加载或停用。', 'OMP task metadata is merged with launchd state by Label; metadata alone provides no busy/idle evidence, and missing configuration yields unloaded or disabled state.'),
})
const hermesCron = capabilities({
  working: capability('working', 'partial', '元数据提供启用、暂停与计划状态；当前执行须由 Hermes 执行记录、心跳和进程身份另行核对。', 'Metadata provides enabled, paused and scheduled states; current execution requires separate checks of Hermes execution records, heartbeat and process identity.'),
  history: hermesHistory,
})
const hermesRuntime = capabilities({
  processes: capability('processes', 'partial', '仅对任务最新运行记录核对 PID 与进程启动时间；不枚举 Agent 或父子关系。', 'Checks PID and process start time only for the latest job execution record; it does not enumerate agents or their relationships.'),
  working: capability('working', 'partial', '运行记录、有效 claim 与进程启动时间共同确认任务运行；派发中、过期或无法确认的执行保持未知，不表示 Agent 忙闲。', 'A running record, fresh claim and matching process start time jointly confirm job execution; dispatching, stale or unconfirmed executions remain unknown, without implying agent busy/idle state.'),
  history: hermesHistory,
})
const crontab = capabilities({
  working: capability('working', 'unsupported', '只读取当前用户 crontab 配置；cron 不提供逐任务运行状态，也不读取其他用户任务。', 'Reads only the current user’s crontab configuration; cron supplies no per-job runtime state, and other users’ jobs are not read.'),
})
const system = capabilities({
  processes: capability('processes', 'partial', '从完整进程采样分别选 CPU 与内存前十，展示 PID 和资源指标；不据此判断 Agent 工作状态。', 'Selects the CPU and memory top ten separately from a full process sample, showing PIDs and resource metrics without inferring agent working state.'),
  navigation: systemNavigation,
})
const metrics = capabilities({ navigation: systemNavigation })
const none: readonly SourceCapability[] = []

/** Declared collector support is independent of its latest connection or sampling state. */
export function sourceCapabilities(source: SourceStatus): readonly SourceCapability[] {
  switch (source.id) {
    case 'processes': return processes
    case 'omp-ownership': return ownership
    case 'tern-state': return tern
    case 'omp-socket': return socket
    case 'agent-activity': return activity
    case 'omp-cron': return ompCron
    case 'hermes-cron': return hermesCron
    case 'hermes-runtime': return hermesRuntime
    case 'crontab': return crontab
    case 'system':
    case 'system-3': return system
    case 'system-0':
    case 'system-1':
    case 'system-2':
    case 'network-interface': return metrics
  }
  if (/^launchctl:(?:system|(?:gui|user)\/\d+)$/.test(source.id)) return launchctl
  if (/^\/(?:System\/)?Library\/Launch(?:Agents|Daemons)$/.test(source.id)
    || /^\/.+\/Library\/LaunchAgents$/.test(source.id)) return plist
  return none
}
