import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { UpdateSnapshot } from '../../shared/updates'

type UpdateAction = 'check' | 'download' | 'cancel' | 'install' | 'openReleaseNotes'
type PendingAction = UpdateAction | 'snapshot'
interface UpdateFailure { action: PendingAction; details: string }
interface UpdatesContextValue {
  snapshot: UpdateSnapshot | null
  pending: PendingAction | null
  failure: UpdateFailure | null
  run: (action: UpdateAction) => Promise<void>
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
  const accept = useCallback((value: UpdateSnapshot) => {
    if (latest.current && value.revision <= latest.current.revision) return
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
        unsubscribe = api.subscribe(value => { if (generation.current === connection) accept(value) })
        const value = await api.snapshot()
        if (generation.current === connection) accept(value)
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

  const run = useCallback(async (action: UpdateAction) => {
    // A download can remain pending until completion; cancellation must still be available.
    const canCancel = action === 'cancel' && latest.current?.phase === 'downloading'
    if (pendingRef.current && !(canCancel && pendingRef.current === 'download')) return
    if (action !== 'cancel' && ['checking', 'downloading', 'installing'].includes(latest.current?.phase ?? '')) return
    const connection = generation.current
    const request = ++operation.current
    pendingRef.current = action
    setPending(action)
    setFailure(null)
    try {
      const api = window.appUpdates
      if (!api) throw new Error('未连接应用更新接口，请重新打开桌面应用。 / App update connection is unavailable. Reopen the desktop app.')
      if (action === 'openReleaseNotes') await api.openReleaseNotes()
      else {
        const value = await api[action]()
        if (generation.current === connection) accept(value)
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
