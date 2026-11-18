import { useLayoutEffect, useRef } from 'react'
import ArrowUpRight from 'kubai-icons-react/icons/arrow-up-right'
import { useI18n } from './i18n'

export interface AgentMenuAnchor {
  agentId: string
  x: number
  y: number
  trigger: HTMLElement | null
}

interface Props {
  anchor: AgentMenuAnchor
  busy: boolean
  onClose: (restoreFocus: boolean) => void
  onNavigate: (agentId: string) => void
}

export default function AgentContextMenu({ anchor, busy, onClose, onNavigate }: Props) {
  const { t } = useI18n()
  const menuRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const menu = menuRef.current!
    menu.showPopover()
    const bounds = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - bounds.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - bounds.height - 8))}px`
    menu.querySelector('button')?.focus({ preventScroll: true })
  }, [anchor])

  useLayoutEffect(() => {
    // Opening on contextmenu precedes the initiating gesture's pointerup.
    // Own dismissal so that release cannot light-dismiss the new popover.
    function dismissOutside(event: PointerEvent) {
      if (!event.composedPath().includes(menuRef.current!)) onClose(false)
    }
    document.addEventListener('pointerdown', dismissOutside, true)
    return () => document.removeEventListener('pointerdown', dismissOutside, true)
  }, [onClose])

  return <div ref={menuRef} popover="manual" role="menu" aria-label={t('OMP 操作', 'OMP actions')} className="topology-context-menu"
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose(true)
      }
      if (event.key === 'Tab') onClose(true)
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        menuRef.current?.querySelector('button')?.focus()
      }
    }}>
    <button type="button" role="menuitem" disabled={busy} onClick={() => onNavigate(anchor.agentId)}>
      <ArrowUpRight trigger="none" size={16} aria-hidden="true" />
      {busy ? t('正在跳转…', 'Navigating…') : t('跳转到 Tern 标签页', 'Go to Tern tab')}
    </button>
  </div>
}
