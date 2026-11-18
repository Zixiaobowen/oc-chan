export const DIAGNOSTIC_REPORT_MAX_BYTES = 256 * 1024
export const DIAGNOSTIC_REPORT_MAX_SOURCES = 64
export const DIAGNOSTIC_REPORT_MAX_DIAGNOSTICS = 128
export const DIAGNOSTIC_REPORT_MAX_RESOURCES = 32

export type DiagnosticReportLimit = 'sources' | 'diagnostics' | 'resources' | 'bytes' | 'invalid-fields'
export interface DiagnosticReportCoverage {
  sources: { included: number; total: number | null }
  diagnostics: { included: number; total: number | null }
  resources: { included: number; total: number | null }
}
export interface DiagnosticReportContent {
  generatedAt: string
  bytes: number
  json: string
  limits: DiagnosticReportLimit[]
  coverage: DiagnosticReportCoverage
}
export interface DiagnosticPreview extends DiagnosticReportContent { id: string }
export type DiagnosticFailureReason = 'busy' | 'expired' | 'unavailable' | 'exists' | 'permission' | 'storage' | 'timeout' | 'clipboard' | 'io' | 'cleanup' | 'unknown'
export interface DiagnosticFailure {
  status: 'error'
  reason: DiagnosticFailureReason
  details: string
}
export type DiagnosticGenerateResult = { status: 'ready'; preview: DiagnosticPreview } | { status: 'cancelled' } | DiagnosticFailure
export type DiagnosticActionResult = { status: 'copied' | 'saved' | 'cancelled' } | DiagnosticFailure
