import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { UpdatePolicy, UpdateSnapshot } from '../../shared/updates'

type UpdateRequest = ['check'] | ['openReleaseNotes'] | ['setAutomaticChecks', boolean] | ['setPolicy', UpdatePolicy]
type UpdateAction = UpdateRequest[0]
type PendingAction = UpdateAction | 'snapshot'
interface UpdateFailure { action: PendingAction; details: string }
interface UpdatesContextValue {
  snapshot: UpdateSnapshot | null
  pending: PendingAction | null
  failure: UpdateFailure | null
  run: (...request: UpdateRequest) => Promise<void>
  reconnect: () => void
}
const UpdatesContext = createContext<UpdatesContextValue | null>(null)
export function useUpdates() {
  const context = useContext(UpdatesContext)
  if (!context) throw new Error('UpdatesProvider is required')
  return context
}

export default function UpdatesProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null)
  const [pending, setPending] = useState<PendingAction | null>('snapshot')
  const [failure, setFailure] = useState<UpdateFailure | null>(null)
  const [attempt, setAttempt] = useState(0)
  const latest = useRef<UpdateSnapshot | null>(null)
  const pendingRef = useRef<PendingAction | null>('snapshot')
  const generation = useRef(0)
  const operation = useRef(0)
  const observations = useRef(0)
  const accept = useCallback((value: UpdateSnapshot) => {
    latest.current = value
    setSnapshot(value)
  }, [])

  useEffect(() => {
    const connection = ++generation.current
    const api = window.appUpdates
    let unsubscribe: (() => void) | undefined
    pendingRef.current = 'snapshot'
    setPending('snapshot')
    setFailure(null)
    const connect = async () => {
      try {
        if (!api) throw new Error('未连接应用更新接口，请重新打开桌面应用。 / App update connection is unavailable. Reopen the desktop app.')
        const observed = observations.current
        unsubscribe = api.subscribe(value => { if (generation.current === connection) { observations.current++; accept(value) } })
        const value = await api.snapshot()
        if (generation.current === connection && observations.current === observed) accept(value)
      } catch (cause) {
        if (generation.current === connection) setFailure({ action: 'snapshot', details: cause instanceof Error ? cause.message : String(cause) })
      } finally {
        if (generation.current === connection) {
          pendingRef.current = null
          setPending(null)
        }
      }
    }
    void connect()
    return () => { generation.current++; unsubscribe?.() }
  }, [accept, attempt])

  const run = useCallback(async (...[action, argument]: UpdateRequest) => {
    if (pendingRef.current) return
    if (action === 'check' && !latest.current?.canCheck) return
    const connection = generation.current
    const request = ++operation.current
    const observed = observations.current
    pendingRef.current = action
    setPending(action)
    setFailure(null)
    try {
      const api = window.appUpdates
      if (!api) throw new Error('未连接应用更新接口，请重新打开桌面应用。 / App update connection is unavailable. Reopen the desktop app.')
      if (action === 'openReleaseNotes') await api.openReleaseNotes()
      else {
        let value: UpdateSnapshot
        if (action === 'setPolicy') value = await api.setPolicy(argument)
        else if (action === 'setAutomaticChecks') value = await api.setAutomaticChecks(argument)
        else value = await api.check()
        if (generation.current === connection && observations.current === observed) accept(value)
      }
    } catch (cause) {
      if (generation.current === connection && operation.current === request) setFailure({ action, details: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (generation.current === connection && operation.current === request) {
        pendingRef.current = null
        setPending(null)
      }
    }
  }, [accept])

  const reconnect = useCallback(() => {
    if (pendingRef.current) return
    pendingRef.current = 'snapshot'
    setPending('snapshot')
    setAttempt(value => value + 1)
  }, [])

  return <UpdatesContext.Provider value={{ snapshot, pending, failure, run, reconnect }}>{children}</UpdatesContext.Provider>
}
