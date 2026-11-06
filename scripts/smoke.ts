import assert from 'node:assert/strict'
import { collectAgents } from '../src/main/collectors/agents'
import { ScheduleCollector } from '../src/main/collectors/schedules'
import { SystemCollector } from '../src/main/collectors/system'

async function main() {
  const systemCollector = new SystemCollector()
  const [agents, schedules, system] = await Promise.all([
    collectAgents(), new ScheduleCollector().collect(), systemCollector.collect().finally(() => systemCollector.dispose())
  ])
  assert.equal(new Set(agents.agents.map(agent => agent.id)).size, agents.agents.length, 'Agent ID 必须唯一')
  for (const agent of agents.agents) {
    assert(agent.pid > 0, '活动 Agent 必须具有有效 PID')
    process.kill(agent.pid, 0)
  }
  assert.equal(new Set(schedules.jobs.map(job => job.id)).size, schedules.jobs.length, '任务不能重复计数')
  assert(system.memoryTotal > 0 && system.cpuCores > 0, '必须读取真实系统指标')
  assert.equal(system.cpuPercent, null, '首次 CPU 采样必须等待连续增量证据')
  assert(system.processes.length > 0, '必须读取真实进程列表')
  const summary = {
    agents: { main: agents.agents.filter(agent => agent.kind === 'main').length, activeSubagents: agents.activeSubagentCount, residentSubagents: agents.agents.filter(agent => agent.kind === 'subagent').length, sources: agents.sources },
    schedules: { recurring: schedules.jobs.filter(job => ['calendar', 'interval'].includes(job.kind)).length, other: schedules.jobs.filter(job => ['startup', 'service'].includes(job.kind)).length, sources: schedules.sources },
    system: { cpuModel: system.cpuModel, cpuCores: system.cpuCores, memoryGB: system.memoryTotal / 1024 ** 3, sources: system.sources }
  }
  console.log(JSON.stringify(summary, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
