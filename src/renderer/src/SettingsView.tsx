import type { ReactNode } from 'react'
import type { AppSettings } from '../../shared/settings'
import type { SourceStatus } from '../../shared/types'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import { NativeSelect } from './components'
import SettingsSaveError from './SettingsSaveError'
import ThemePicker from './ThemePicker'
import LoginItemSetting from './LoginItemSetting'
import LiquidGlassSetting from './LiquidGlassSetting'
import NotificationSettings from './NotificationSettings'
import UpdateSettings from './UpdateSettings'
import './settings.css'
import { useSystemPlugin } from './marketplace'
import SystemPluginNotice from './SystemPluginNotice'

function Choices<T extends string>({ name, label, value, options, disabled, onChange }: {
  name: keyof AppSettings; label: string; value: T; options: { value: T; label: string; description?: string }[]
  disabled: boolean; onChange: (value: T) => void
}) {
  return <fieldset className="setting-choices" aria-disabled={disabled}><legend className="sr-only">{label}</legend>
    {options.map(option => <label className="setting-choice" key={option.value}>
      <input type="radio" name={name} value={option.value} checked={value === option.value} aria-disabled={disabled} onChange={() => { if (!disabled) onChange(option.value) }} />
      <span>{option.label}</span>{option.description && <small>{option.description}</small>}
    </label>)}
  </fieldset>
}

function SettingRow({ name, label, children, errorKeys }: { name: keyof AppSettings; label: string; children: ReactNode; errorKeys?: readonly (keyof AppSettings)[] }) {
  const { error } = useSettings()
  return <section id={`setting-${name}`} className="setting-row" aria-labelledby={`setting-${name}-label`}>
    <h2 id={`setting-${name}-label`}>{label}</h2>
    <div className="setting-control">{children}</div>
    {error && (errorKeys ? errorKeys.some(key => Object.hasOwn(error.patch, key)) : Object.hasOwn(error.patch, name)) && <SettingsSaveError settingLabel={label} />}
  </section>
}

export default function SettingsView({ sources = [], onOpenMarketplace }: { sources?: SourceStatus[]; onOpenMarketplace: () => void }) {
  const { t } = useI18n()
  const { snapshot: { settings, platform, resolvedTheme }, saving, error, update } = useSettings()
  const { installed: systemInstalled, item: systemItem, pending: marketPending, snapshot: marketSnapshot } = useSystemPlugin()
  const systemChanging = Boolean(saving || marketPending || marketSnapshot?.operation)
  const change = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => { if (!saving) void update({ [key]: value }) }
  return <div className="settings-layout">
    <div className="settings-list" aria-busy={saving}>
      <UpdateSettings />
      <SettingRow name="plugins" label={t('系统监控插件', 'System monitor plugin')}>
        {!systemInstalled ? <SystemPluginNotice onOpen={onOpenMarketplace} /> : <>
          <div className="setting-toggle"><button type="button" role="switch" className="setting-switch" aria-labelledby="setting-plugins-label" aria-describedby="system-plugin-help" aria-checked={settings.plugins.system} aria-disabled={systemChanging} onClick={() => { if (!systemChanging) void update({ plugins: { system: !settings.plugins.system } }) }}><span /></button><span>{settings.plugins.system ? t('采集已开启', 'Collection enabled') : t('采集已停用', 'Collection disabled')}</span></div>
          {systemItem?.error && <SystemPluginNotice onOpen={onOpenMarketplace} />}
          <p className="setting-help" id="system-plugin-help">{t('仅控制已安装插件的采集；安装、更新与卸载在插件市场管理。', 'Controls collection for the installed plugin. Manage installation, updates and removal in the plugin marketplace.')}</p>
          <button className="button secondary" onClick={onOpenMarketplace}>{t('打开插件市场', 'Open plugin marketplace')}</button>
        </>}
      </SettingRow>
      <SettingRow name="appearance" label={t('外观', 'Appearance')}>
        <Choices name="appearance" label={t('外观', 'Appearance')} value={settings.appearance} disabled={saving} onChange={value => change('appearance', value)} options={[
          { value: 'system', label: t('跟随系统', 'System') }, { value: 'light', label: t('浅色', 'Light') }, { value: 'dark', label: t('深色', 'Dark') }
        ]} />
      </SettingRow>
      <SettingRow name="glassIntensity" label={t('液态玻璃', 'Liquid Glass')}>
        <LiquidGlassSetting />
      </SettingRow>
      <SettingRow name={resolvedTheme === 'dark' ? 'darkTheme' : 'lightTheme'} errorKeys={['lightTheme', 'darkTheme']} label={t('主题', 'Theme')}>
        <ThemePicker />
      </SettingRow>
      <SettingRow name="language" label={t('语言', 'Language')}>
        <Choices name="language" label={t('语言', 'Language')} value={settings.language} disabled={saving} onChange={value => change('language', value)} options={[
          { value: 'system', label: t('跟随系统', 'System') }, { value: 'zh-CN', label: '简体中文' }, { value: 'en', label: 'English' }
        ]} />
        <p className="setting-help">{t('任务名称、会话内容与原始诊断保留原文。', 'Task names, session content and diagnostics keep their source language.')}</p>
      </SettingRow>
      <SettingRow name="textSize" label={t('文字大小', 'Text size')}>
        <Choices name="textSize" label={t('文字大小', 'Text size')} value={settings.textSize} disabled={saving} onChange={value => change('textSize', value)} options={[
          { value: 'small', label: t('较小', 'Small'), description: '12 px' }, { value: 'default', label: t('默认', 'Default'), description: '13 px' }, { value: 'large', label: t('较大', 'Large'), description: '15 px' }
        ]} />
      </SettingRow>
      <SettingRow name="uiFont" label={t('界面字体', 'Interface font')}>
        <NativeSelect id="ui-font" aria-labelledby="setting-uiFont-label" aria-disabled={saving} value={settings.uiFont} onChange={event => change('uiFont', event.target.value as AppSettings['uiFont'])}>
          <option value="system">{t('系统默认', 'System default')}</option><option value="pingfang">PingFang SC</option><option value="helvetica">Helvetica Neue</option>
        </NativeSelect>
      </SettingRow>
      <SettingRow name="codeFont" label={t('代码字体', 'Code font')}>
        <NativeSelect id="code-font" aria-labelledby="setting-codeFont-label" aria-disabled={saving} value={settings.codeFont} onChange={event => change('codeFont', event.target.value as AppSettings['codeFont'])}>
          <option value="system">{t('系统等宽', 'System monospace')}</option><option value="menlo">Menlo</option><option value="monaco">Monaco</option>
        </NativeSelect>
        <code className="setting-font-sample" aria-label={t('代码字体预览', 'Code font preview')}>0 O o · 1 l I · {'{} [] () => !='}</code>
      </SettingRow>
      <SettingRow name="trayClick" label={t('点击托盘图标', 'Tray icon click')}>
        <Choices name="trayClick" label={t('点击托盘图标', 'Tray icon click')} value={settings.trayClick} disabled={saving} onChange={value => change('trayClick', value)} options={[
          { value: 'tray', label: t('打开托盘', 'Open tray') }, { value: 'main', label: t('打开主界面', 'Open main window') }
        ]} />
        <p className="setting-help">{t('单击菜单栏图标时的操作；右键可打开主界面或退出。', 'Choose the menu bar icon’s click action. Right-click to open the main window or quit.')}</p>
      </SettingRow>
      <LoginItemSetting />
      <NotificationSettings sources={sources} />
      <SettingRow name="showDock" label={t('显示程序坞', 'Show in Dock')}>
        <div className="setting-toggle">
          <button type="button" role="switch" aria-labelledby="setting-showDock-label" aria-describedby="dock-help" aria-checked={settings.showDock} className="setting-switch" disabled={platform !== 'darwin'} aria-disabled={saving || platform !== 'darwin'} onClick={() => change('showDock', !settings.showDock)}><span /></button>
          <span>{settings.showDock ? t('已开启', 'On') : t('已关闭', 'Off')}</span>
        </div>
        <p id="dock-help" className="setting-help">{platform === 'darwin' ? t('隐藏后仍可从菜单栏打开应用。', 'The menu bar icon remains available when hidden.') : t('此设置仅适用于 macOS。', 'This setting is available on macOS only.')}</p>
      </SettingRow>
      <SettingRow name="preventSleep" label={t('防止休眠', 'Prevent sleep')}>
        <div className="setting-toggle">
          <button type="button" role="switch" aria-labelledby="setting-preventSleep-label" aria-describedby="sleep-help" aria-checked={settings.preventSleep} className="setting-switch" aria-disabled={saving} onClick={() => change('preventSleep', !settings.preventSleep)}><span /></button>
          <span>{settings.preventSleep ? t('已开启', 'On') : t('已关闭', 'Off')}</span>
        </div>
        <p id="sleep-help" className="setting-help">{t('阻止空闲休眠，退出应用时释放。屏幕仍可熄灭，不影响合盖或手动休眠；开启后可能增加耗电。', 'Prevent idle sleep until the app quits. Display, lid-close and manual sleep are unaffected. May use more power.')}</p>
      </SettingRow>
    </div>
    <p className="setting-save-status" role="status">{saving ? t('正在保存…', 'Saving…') : error?.failure.reason === 'connection' ? t('保存结果未确认', 'Save outcome unconfirmed') : error ? t('保存失败', 'Save failed') : t('修改即时生效，自动保存。', 'Changes apply immediately and save automatically.')}</p>
  </div>
}
