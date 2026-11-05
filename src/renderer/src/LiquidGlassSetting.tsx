import { useCallback, useEffect, useRef } from 'react'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import { SettingsDiagnosticDetails } from './SettingsSaveError'

const rangeKeys: Record<string, true> = { ArrowLeft: true, ArrowRight: true, ArrowUp: true, ArrowDown: true, Home: true, End: true, PageUp: true, PageDown: true }

export default function LiquidGlassSetting() {
  const { t } = useI18n()
  const { snapshot: { settings, liquidGlass }, saving, update, glassPreview, glassPreviewError, previewGlass, retryGlassPreview } = useSettings()
  const timer = useRef<number | undefined>(undefined)
  const pointer = useRef<number | null>(null)
  const cancelledPointer = useRef<number | null>(null)
  const dirty = useRef(false)
  const amount = useRef(settings.glassIntensity)
  const blocked = !liquidGlass.available || liquidGlass.reducedTransparency || liquidGlass.increasedContrast
  const disabled = saving || blocked
  const value = glassPreview ?? settings.glassIntensity
  const cancel = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    if (pointer.current !== null) cancelledPointer.current = pointer.current
    pointer.current = null
    dirty.current = false
    previewGlass(null)
  }, [previewGlass])
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) cancel() }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel()
    }
    const onPointerEnd = (event: PointerEvent) => {
      if (cancelledPointer.current === event.pointerId) cancelledPointer.current = null
    }
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', onEscape)
    window.addEventListener('pointerup', onPointerEnd)
    window.addEventListener('pointercancel', onPointerEnd)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', onEscape)
      window.removeEventListener('pointerup', onPointerEnd)
      window.removeEventListener('pointercancel', onPointerEnd)
      document.removeEventListener('visibilitychange', onVisibility)
      cancel()
    }
  }, [cancel])
  useEffect(() => { if (blocked) cancel() }, [blocked, cancel])
  function commit() {
    window.clearTimeout(timer.current)
    timer.current = undefined
    pointer.current = null
    if (!dirty.current || disabled) return
    dirty.current = false
    if (amount.current === settings.glassIntensity) { previewGlass(null); return }
    void update({ glassIntensity: amount.current })
  }
  return <>
    <div className="glass-setting-range">
      <input id="glass-intensity" name="glassIntensity" type="range" min={0} max={100} step={1} value={value}
        aria-labelledby="setting-glassIntensity-label" aria-describedby="glass-intensity-help glass-intensity-status"
        aria-valuetext={value === 0 ? t('0%，已关闭', '0%, off') : `${value}%`} aria-disabled={disabled}
        onPointerDown={event => {
          if (disabled) { event.preventDefault(); return }
          window.clearTimeout(timer.current)
          timer.current = undefined
          cancelledPointer.current = null
          pointer.current = event.pointerId
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onChange={event => {
          if (disabled || cancelledPointer.current !== null) return
          amount.current = event.currentTarget.valueAsNumber
          dirty.current = true
          previewGlass(amount.current)
          window.clearTimeout(timer.current)
          if (pointer.current === null) timer.current = window.setTimeout(commit, 250)
        }}
        onPointerUp={event => { if (pointer.current === event.pointerId) commit() }}
        onPointerCancel={cancel}
        onLostPointerCapture={event => { if (pointer.current === event.pointerId) cancel() }}
        onKeyDown={event => {
          if (disabled && rangeKeys[event.key]) event.preventDefault()
          if (event.key === 'Escape') { event.preventDefault(); cancel() }
        }}
        onBlur={cancel}
      />
      <output htmlFor="glass-intensity" className="glass-setting-value">{value}%{value === 0 && <span>{t('关闭', 'Off')}</span>}</output>
    </div>
    <div className="glass-setting-scale" aria-hidden="true"><span>{t('弱', 'Subtle')}</span><span>{t('强', 'Strong')}</span></div>
    <p id="glass-intensity-help" className="setting-help">{t('弱：更接近实色；强：背景更通透。0% 关闭。仅影响侧栏、顶栏与托盘，数据区保持实色。', 'Subtle is closer to solid; strong reveals more of the background. 0% turns it off. Applies to the sidebar, top bar and tray; data areas stay solid.')}</p>
    <p id="glass-intensity-status" className="setting-help">{!liquidGlass.available
      ? t('需要 macOS 26 或更新版本及可用的原生玻璃效果。', 'Requires macOS 26 or later and available native Liquid Glass.')
      : liquidGlass.reducedTransparency || liquidGlass.increasedContrast
        ? t('系统已开启“减少透明度”或“增加对比度”，当前使用实色并保留已保存的强度。', 'Reduce Transparency or Increase Contrast is enabled. Solid surfaces are used and your saved intensity is retained.')
        : t('拖动时预览，松开保存；键盘调整停顿后保存。按 Esc 或离开控件取消未保存的预览。', 'Drag to preview, release to save. Keyboard changes save after a short pause. Press Esc or leave the control to cancel an unsaved preview.')}</p>
    {glassPreviewError && <div className="glass-preview-error">
      <p role="alert">{t('玻璃预览失败，已恢复实色。', 'Glass preview failed. Solid surfaces have been restored.')}</p>
      <button type="button" className="text-button" aria-disabled={disabled}
        onBlur={event => { if (!(event.relatedTarget instanceof HTMLElement) || event.relatedTarget.id !== 'glass-intensity') cancel() }}
        onClick={() => { if (!disabled) retryGlassPreview() }}>{t('重试预览', 'Retry preview')}</button>
      <SettingsDiagnosticDetails details={glassPreviewError.details} />
    </div>}
  </>
}
