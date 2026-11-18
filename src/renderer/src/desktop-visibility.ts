type Presentation = { headless: boolean; hidden: boolean | null }
let presentation: Presentation | null = null

export function registerDesktopVisibility(headless: boolean): () => void {
  if (presentation) throw new Error('桌面窗口已登记 / Desktop document is already registered')
  const current: Presentation = { headless, hidden: null }
  presentation = current
  return () => { if (presentation === current) presentation = null }
}

// Native visibility controls ordinary windows. Headless presentation stays active
// unless explicitly suspended for development/acceptance; it never shows a window.
export function isDesktopDocumentVisible(): boolean {
  if (!presentation) throw new Error('桌面窗口尚未登记 / Desktop document is not registered')
  return presentation.headless ? presentation.hidden !== true : !document.hidden
}

export function isHeadlessDesktop(): boolean {
  if (!presentation) throw new Error('桌面窗口尚未登记 / Desktop document is not registered')
  return presentation.headless
}

export interface DesktopUpdate { cancel(): void }

// Headless WebKit may suspend native animation frames. These one-shot tasks
// advance product state/rendering only; they are not observed display frames.
export function scheduleDesktopUpdate(update: () => void): DesktopUpdate {
  if (isHeadlessDesktop()) {
    const task = window.setTimeout(update, 0)
    return { cancel: () => window.clearTimeout(task) }
  }
  const frame = window.requestAnimationFrame(update)
  return { cancel: () => window.cancelAnimationFrame(frame) }
}

// Imported by the isolated performance probe, not by product UI controls.
export function setHeadlessPresentationHidden(hidden: boolean | null): void {
  if (!presentation) throw new Error('桌面窗口尚未登记 / Desktop document is not registered')
  if (!presentation.headless) throw new Error('仅无头模式允许调整展示状态 / Presentation override requires headless mode')
  if (hidden !== null && typeof hidden !== 'boolean') throw new Error('展示状态无效 / Invalid presentation state')
  const visible = isDesktopDocumentVisible()
  presentation.hidden = hidden
  if (visible !== isDesktopDocumentVisible()) document.dispatchEvent(new Event('visibilitychange'))
}
