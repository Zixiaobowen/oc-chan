// Imported exclusively by the performance Vite configuration.
export function eventKeys(snapshot, previous) {
  const keys = []
  const agents = snapshot?.agents ?? []
  if (agents.length > 4096) throw new Error('Performance snapshot observation budget exceeded')
  const present = new Set()
  for (const agent of agents) {
    if (!agent.id.startsWith('performance:')) continue
    present.add(agent.id)
    const match = /^perf_(\d+)$/.exec(agent.activity?.name ?? '')
    const sequence = match ? Number(match[1]) : null
    if (sequence !== null && previous.get(agent.id) !== sequence) keys.push([Number(agent.id.slice(12)), sequence])
    previous.set(agent.id, sequence)
  }
  for (const id of previous.keys()) if (!present.has(id)) previous.delete(id)
  return keys
}
export const stamp = () => Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000
