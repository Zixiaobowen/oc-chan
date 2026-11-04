import { useLayoutEffect } from 'react'
import { THEMES, THEME_IDS } from '../../shared/themes'
import { useI18n } from './i18n'
import { useSettings } from './settings'

export default function ThemePicker() {
  const { t } = useI18n()
  const { snapshot: { settings, resolvedTheme }, saving, update, previewTheme } = useSettings()
  const setting = resolvedTheme === 'dark' ? 'darkTheme' : 'lightTheme'
  const selected = settings[setting]
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') previewTheme(null) }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previewTheme(null)
    }
  }, [resolvedTheme, previewTheme])
  return <>
    <p className="setting-help theme-current">{t('当前编辑：', 'Editing: ')}{resolvedTheme === 'dark' ? t('深色配色', 'dark palette') : t('浅色配色', 'light palette')}</p>
    <fieldset className="theme-options" aria-disabled={saving} aria-describedby="theme-help"
      onPointerLeave={() => previewTheme(null)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) previewTheme(null) }}>
      <legend className="sr-only">{t('主题', 'Theme')}</legend>
      {THEME_IDS.map(id => {
        const theme = THEMES[id]
        const colors = theme[resolvedTheme]
        return <label className="theme-option" key={id} onPointerEnter={event => { if (!saving && event.pointerType !== 'touch') previewTheme(id) }}>
          <span className="theme-swatch" aria-hidden="true" style={{ backgroundColor: colors.ground, color: colors.ink, borderColor: colors.border }}>
            <span className="theme-swatch-sidebar" style={{ backgroundColor: colors.sidebar, borderColor: colors.border }}><i style={{ backgroundColor: colors.accent }} /></span>
            <span className="theme-swatch-type">Aa</span>
            <span className="theme-swatch-colors">{[colors.accent, colors.blue, colors.warning, colors.error].map((color, index) => <i key={index} style={{ backgroundColor: color }} />)}</span>
          </span>
          <span className="theme-option-name">
            <input type="radio" name={setting} value={id} checked={selected === id} aria-disabled={saving}
              onFocus={() => { if (!saving) previewTheme(id) }}
              onChange={() => { if (!saving) void update({ [setting]: id }) }} />
            <span>{theme.name}</span>
          </span>
        </label>
      })}
    </fieldset>
    <p id="theme-help" className="setting-help">{t('悬停预览，点击保存；Esc 取消预览。浅色与深色分别记住主题。', 'Hover to preview, click to save; Esc cancels the preview. Light and dark palettes are saved separately.')}</p>
  </>
}
