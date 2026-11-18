import { Component, type ReactNode } from 'react'
import { useI18n } from '../i18n'

function Failure({ error, retry }: { error: Error; retry: () => void }) {
  const { t } = useI18n()
  return <div className="error-notice" role="alert"><div><strong>{t('插件显示失败', 'Plugin display failed')}</strong><p>{error.message}</p></div><button className="button secondary" onClick={retry}>{t('重试', 'Retry')}</button></div>
}
/** A rendering failure is confined to the contributed surface, with an explicit local retry. */
export default class ContributionBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
  render() {
    return this.state.error ? <Failure error={this.state.error} retry={() => this.setState({ error: null })} /> : this.props.children
  }
}
