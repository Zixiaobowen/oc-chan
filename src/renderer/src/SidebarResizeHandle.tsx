import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useI18n } from './i18n'
import { DEFAULT_SETTINGS, MIN_SIDEBAR_WIDTH as MIN_WIDTH, MAX_SIDEBAR_WIDTH as MAX_WIDTH } from '../../shared/settings'
import { useSettings } from './settings'

const DEFAULT_WIDTH = DEFAULT_SETTINGS.sidebarWidth
const MIN_WORKSPACE_WIDTH = 560

type Drag = { pointerId: number; startX: number; startWidth: number; previousWidth: number }

export default function SidebarResizeHandle({ compact }: { compact: boolean }) {
  const { t } = useI18n()
  const { snapshot: { settings }, update, saving, error } = useSettings()
  const persisted = useRef({ width: settings.sidebarWidth, update, saving, error })
  persisted.current = { width: settings.sidebarWidth, update, saving, error }
  const handle = useRef<HTMLDivElement>(null)
  const preferredWidth = useRef(settings.sidebarWidth)
  const maximum = useRef(MAX_WIDTH)
  const currentWidth = useRef(settings.sidebarWidth)
  const drag = useRef<Drag | null>(null)
  const frame = useRef<number | null>(null)
  const [size, setSize] = useState({ width: settings.sidebarWidth, max: MAX_WIDTH })
  const keyboardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keyboardWidth = useRef<number | null>(null)

  function saveKeyboardWidth() {
    clearTimeout(keyboardTimer.current)
    keyboardTimer.current = undefined
    const width = keyboardWidth.current
    keyboardWidth.current = null
    if (width !== null) void persisted.current.update({ sidebarWidth: width })
  }

  function applyWidth() {
    const width = Math.max(MIN_WIDTH, Math.min(maximum.current, preferredWidth.current))
    currentWidth.current = width
    handle.current?.parentElement?.style.setProperty('--sidebar-width', `${width}px`)
    setSize(previous => previous.width === width && previous.max === maximum.current
      ? previous : { width, max: maximum.current })
  }

  function finishDrag(cancel = false) {
    const active = drag.current
    if (!active) return
    drag.current = null
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    if (cancel) {
      preferredWidth.current = active.previousWidth
      if (!persisted.current.saving && persisted.current.error?.patch.sidebarWidth !== undefined)
        preferredWidth.current = persisted.current.width
    } else void persisted.current.update({ sidebarWidth: preferredWidth.current })
    applyWidth()
    handle.current?.parentElement?.removeAttribute('data-sidebar-resizing')
    if (handle.current?.hasPointerCapture(active.pointerId)) handle.current.releasePointerCapture(active.pointerId)
  }

  useLayoutEffect(() => {
    if (drag.current || saving || keyboardWidth.current !== null) return
    preferredWidth.current = settings.sidebarWidth
    applyWidth()
  }, [settings.sidebarWidth, saving, error])

  useLayoutEffect(() => {
    const shell = handle.current!.parentElement!
    const resize = () => {
      maximum.current = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, shell.clientWidth - MIN_WORKSPACE_WIDTH))
      applyWidth()
    }
    const interrupt = () => { finishDrag(true); saveKeyboardWidth() }
    const visibility = () => { if (document.hidden) interrupt() }
    const observer = new ResizeObserver(resize)
    resize()
    observer.observe(shell)
    window.addEventListener('blur', interrupt)
    window.addEventListener('pagehide', saveKeyboardWidth)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      observer.disconnect()
      saveKeyboardWidth()
      window.removeEventListener('pagehide', saveKeyboardWidth)
      window.removeEventListener('blur', interrupt)
      document.removeEventListener('visibilitychange', visibility)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      shell.removeAttribute('data-sidebar-resizing')
    }
  }, [])

  useLayoutEffect(() => {
    if (compact) finishDrag(true)
  }, [compact])

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || drag.current) return
    event.preventDefault()
    saveKeyboardWidth()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: currentWidth.current, previousWidth: preferredWidth.current }
    event.currentTarget.parentElement!.setAttribute('data-sidebar-resizing', 'true')
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    preferredWidth.current = Math.max(MIN_WIDTH, Math.min(maximum.current, Math.round(active.startWidth + event.clientX - active.startX)))
    if (frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null
      applyWidth()
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && drag.current) {
      event.preventDefault()
      finishDrag(true)
      return
    }
    const step = event.shiftKey ? 32 : 8
    const next = event.key === 'ArrowLeft' ? currentWidth.current - step
      : event.key === 'ArrowRight' ? currentWidth.current + step
      : event.key === 'Home' ? MIN_WIDTH
      : event.key === 'End' ? maximum.current
      : null
    if (next === null || drag.current) return
    event.preventDefault()
    preferredWidth.current = Math.max(MIN_WIDTH, Math.min(maximum.current, next))
    applyWidth()
    keyboardWidth.current = preferredWidth.current
    clearTimeout(keyboardTimer.current)
    keyboardTimer.current = setTimeout(saveKeyboardWidth, 250)
  }

  return <div ref={handle} className="sidebar-resize-handle" role="separator" tabIndex={compact ? -1 : 0}
    aria-hidden={compact || undefined} aria-orientation="vertical" aria-controls="main-navigation"
    aria-label={t('调整侧栏宽度', 'Resize sidebar')}
    aria-valuemin={MIN_WIDTH} aria-valuemax={size.max} aria-valuenow={size.width}
    aria-valuetext={t(`${size.width} 像素`, `${size.width} pixels`)}
    title={t('拖动调整侧栏宽度；方向键微调，双击恢复默认', 'Drag to resize; use arrow keys to adjust, double-click to reset')}
    onPointerDown={startDrag} onPointerMove={moveDrag}
    onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) finishDrag() }}
    onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finishDrag(true) }}
    onLostPointerCapture={() => finishDrag(true)} onKeyDown={onKeyDown}
    onDoubleClick={() => {
      clearTimeout(keyboardTimer.current)
      keyboardTimer.current = undefined
      keyboardWidth.current = null
      preferredWidth.current = DEFAULT_WIDTH
      applyWidth()
      void persisted.current.update({ sidebarWidth: DEFAULT_WIDTH })
    }} />
}
