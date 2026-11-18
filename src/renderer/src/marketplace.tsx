import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { MarketplaceAction, MarketplaceSnapshot } from '../../shared/marketplace'

type Request = { action: MarketplaceAction; id: string } | { action: 'check'; id?: never } | { action: 'cancel'; id?: never } | { action: 'load'; id?: never }
interface MarketplaceContextValue {
  snapshot: MarketplaceSnapshot | null
  loading: boolean
  pending: Request | null
  failure: { request: Request; message: string } | null
  refresh(): Promise<void>
  check(): Promise<void>
  run(action: MarketplaceAction, id: string): Promise<void>
  cancel(): Promise<void>
  retry(): Promise<void>
}
const MarketplaceContext = createContext<MarketplaceContextValue | null>(null)

export default function MarketplaceProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<MarketplaceSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<Request | null>(null)
  const [failure, setFailure] = useState<MarketplaceContextValue['failure']>(null)
  const mounted = useRef(false)
  const revision = useRef(0)
  const requesting = useRef(false)
  const cancelling = useRef(false)
  const activeRequest = useRef<{ cancelled: boolean } | null>(null)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const request = useCallback(async (next: Request) => {
    if (cancelling.current || (requesting.current && next.action !== 'cancel')) return
    const currentRequest = { cancelled: false }
    if (next.action === 'cancel') { if (activeRequest.current) activeRequest.current.cancelled = true }
    else activeRequest.current = currentRequest
    if (next.action === 'cancel') cancelling.current = true
    else requesting.current = true
    setPending(next)
    setFailure(null)
    if (next.action === 'load') setLoading(true)
    const started = revision.current
    try {
      const api = window.pluginMarketplace
      if (!api) throw new Error('插件市场连接不可用 / Plugin marketplace connection unavailable')
      if (next.action === 'cancel') {
        await api.cancel()
        const currentRevision = revision.current
        const result = await api.snapshot()
        if (mounted.current && revision.current === currentRevision) { snapshotRef.current = result; setSnapshot(result) }
      } else {
        const result = next.action === 'load' ? await api.snapshot() : next.action === 'check' ? await api.check() : await api[next.action](next.id)
        if (mounted.current && revision.current === started) { snapshotRef.current = result; setSnapshot(result) }
      }
    } catch (cause) {
      if (mounted.current && !currentRequest.cancelled) setFailure({ request: next, message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (next.action === 'cancel') cancelling.current = false
      else requesting.current = false
      if (activeRequest.current === currentRequest) activeRequest.current = null
      if (mounted.current) {
        setPending(current => current === next ? null : current)
        if (next.action === 'load') setLoading(false)
      }
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    let active = true
    const api = window.pluginMarketplace
    const unsubscribe = api?.subscribe(value => {
      if (!active) return
      revision.current++
      snapshotRef.current = value
      setSnapshot(value)
      setLoading(false)
    })
    void request({ action: 'load' })
    return () => { active = false; mounted.current = false; unsubscribe?.() }
  }, [request])
  const run = (action: MarketplaceAction, id: string) => {
    if (snapshotRef.current?.operation || snapshotRef.current?.checking) return Promise.resolve()
    return request({ action, id })
  }
  return <MarketplaceContext.Provider value={{ snapshot, loading, pending, failure,
    refresh: () => request({ action: 'load' }), check: () => request({ action: 'check' }), run,
    cancel: () => request({ action: 'cancel' }), retry: () => failure ? request(failure.request) : Promise.resolve()
  }}>{children}</MarketplaceContext.Provider>
}

export function useMarketplace() {
  const value = useContext(MarketplaceContext)
  if (!value) throw new Error('MarketplaceProvider is required')
  return value
}

export function useSystemPlugin() {
  const market = useMarketplace()
  const item = market.snapshot?.items.find(candidate => candidate.manifest.id === 'system')
  return { ...market, item, installed: market.snapshot === null ? null : Boolean(item?.installed) }
}
