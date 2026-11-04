import { createContext, useCallback, useContext, type ReactNode } from 'react'
import type { ResolvedLanguage } from '../../shared/settings'

const LanguageContext = createContext<ResolvedLanguage>('zh-CN')
export function LanguageProvider({ language, children }: { language: ResolvedLanguage; children: ReactNode }) {
  return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>
}
export function useI18n() {
  const language = useContext(LanguageContext)
  const t = useCallback((zh: string, en: string) => language === 'zh-CN' ? zh : en, [language])
  return { language, t }
}
