import type { MonitorSection } from './types'

export interface PluginManifest {
  id: string
  version: string
  apiVersion: 1
  name: string
  nameEn: string
  description: string
  descriptionEn: string
  publisher: string
  section: MonitorSection
  minAppVersion: string
  platforms: Array<'darwin'>
  permissions: string[]
}

export interface PluginCatalogEntry {
  manifest: PluginManifest
  package: string
  sha256: string
  bytes: number
}

export interface PluginCatalog {
  schema: 1
  plugins: PluginCatalogEntry[]
}

export interface PluginPackage {
  schema: 1
  manifest: PluginManifest
  code: string
}

export interface MarketplaceItem {
  manifest: PluginManifest
  installed: boolean
  installedVersion: string | null
  enabled: boolean
  updateAvailable: boolean
  source: 'bundled' | 'online' | 'installed'
  error: string | null
}

export type MarketplaceAction = 'install' | 'update' | 'uninstall'
export interface MarketplaceOperation {
  id: string
  action: MarketplaceAction
  phase: 'downloading' | 'verifying' | 'activating' | 'removing'
  receivedBytes: number
  totalBytes: number
}

export interface MarketplaceSnapshot {
  items: MarketplaceItem[]
  checking: boolean
  checkedAt: string | null
  catalogError: string | null
  operation: MarketplaceOperation | null
  error: { id: string; action: MarketplaceAction; message: string } | null
}

export interface MarketplaceApi {
  snapshot(): Promise<MarketplaceSnapshot>
  check(): Promise<MarketplaceSnapshot>
  install(id: string): Promise<MarketplaceSnapshot>
  update(id: string): Promise<MarketplaceSnapshot>
  uninstall(id: string): Promise<MarketplaceSnapshot>
  cancel(): Promise<void>
  subscribe(listener: (snapshot: MarketplaceSnapshot) => void): () => void
}
