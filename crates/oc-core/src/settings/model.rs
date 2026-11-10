use serde::{Deserialize, Serialize};
use crate::error::{Error, Result};
use crate::model::{LocalEventType, MonitorSection, NavigationTarget};

pub const MIN_SIDEBAR_WIDTH: f64 = 188.0;
pub const MAX_SIDEBAR_WIDTH: f64 = 320.0;
pub const SETTINGS_MAX_BYTES: u64 = 64 * 1024;
pub const NOTIFICATION_SOURCE_LIMIT: usize = 64;
pub const NOTIFICATION_TASK_LIMIT: usize = 24;
pub const THEME_IDS: [&str; 6] = ["oc-chan", "github", "nord", "catppuccin", "solarized", "gruvbox"];

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Appearance { System, Light, Dark }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Language { System, #[serde(rename = "zh-CN")] Chinese, En }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextSize { Small, Default, Large }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UiFont { System, Pingfang, Helvetica }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CodeFont { System, Menlo, Monaco }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrayClick { Tray, Main }
pub type ThemeId = String;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowBounds { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }
impl WindowBounds {
    pub fn validate(&self) -> bool {
        [self.x, self.y, self.width, self.height].iter().all(|v| v.is_finite() && v.fract() == 0.0)
            && self.x.abs() <= 131_072.0 && self.y.abs() <= 131_072.0
            && (320.0..=16_384.0).contains(&self.width) && (240.0..=16_384.0).contains(&self.height)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSettings { pub agents: bool, pub schedules: bool, pub system: bool, pub events: bool }
impl PluginSettings {
    pub fn get(&self, section: MonitorSection) -> bool {
        match section { MonitorSection::Agents => self.agents, MonitorSection::Schedules => self.schedules, MonitorSection::System => self.system, MonitorSection::Events => self.events }
    }
}
impl Default for PluginSettings { fn default() -> Self { Self { agents: true, schedules: true, system: true, events: true } } }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuietHours { pub enabled: bool, pub start_minute: u32, pub end_minute: u32 }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationSettings {
    pub enabled: bool, pub source_ids: Vec<String>, pub tasks: Vec<NavigationTarget>,
    #[serde(rename = "types")] pub event_types: Vec<LocalEventType>, pub quiet: QuietHours, pub show_task_names: bool,
}
impl Default for NotificationSettings {
    fn default() -> Self {
        Self { enabled: false, source_ids: Vec::new(), tasks: Vec::new(), event_types: LocalEventType::ALL.to_vec(),
            quiet: QuietHours { enabled: false, start_minute: 22 * 60, end_minute: 8 * 60 }, show_task_names: false }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    pub appearance: Appearance, pub glass_intensity: f64,
    pub light_theme: ThemeId, pub dark_theme: ThemeId,
    pub language: Language, pub text_size: TextSize, pub ui_font: UiFont, pub code_font: CodeFont,
    pub tray_click: TrayClick, pub show_dock: bool, pub prevent_sleep: bool,
    pub sidebar_width: f64, pub window_bounds: Option<WindowBounds>,
    pub plugins: PluginSettings, pub notifications: NotificationSettings,
}
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            appearance: Appearance::System, glass_intensity: 65.0, light_theme: "oc-chan".into(), dark_theme: "oc-chan".into(),
            language: Language::System, text_size: TextSize::Default, ui_font: UiFont::System, code_font: CodeFont::System,
            tray_click: TrayClick::Tray, show_dock: true, prevent_sleep: false, sidebar_width: 214.0, window_bounds: None,
            plugins: PluginSettings::default(), notifications: NotificationSettings::default(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    #[serde(deserialize_with = "present")] pub appearance: Option<Appearance>,
    #[serde(deserialize_with = "present")] pub glass_intensity: Option<f64>,
    #[serde(deserialize_with = "present")] pub light_theme: Option<ThemeId>,
    #[serde(deserialize_with = "present")] pub dark_theme: Option<ThemeId>,
    #[serde(deserialize_with = "present")] pub language: Option<Language>,
    #[serde(deserialize_with = "present")] pub text_size: Option<TextSize>,
    #[serde(deserialize_with = "present")] pub ui_font: Option<UiFont>,
    #[serde(deserialize_with = "present")] pub code_font: Option<CodeFont>,
    #[serde(deserialize_with = "present")] pub tray_click: Option<TrayClick>,
    #[serde(deserialize_with = "present")] pub show_dock: Option<bool>,
    #[serde(deserialize_with = "present")] pub prevent_sleep: Option<bool>,
    #[serde(deserialize_with = "present")] pub sidebar_width: Option<f64>,
    #[serde(deserialize_with = "present")] pub window_bounds: Option<Option<WindowBounds>>,
    #[serde(deserialize_with = "present")] pub plugins: Option<PluginPatch>,
    #[serde(deserialize_with = "present")] pub notifications: Option<NotificationSettings>,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPatch {
    #[serde(deserialize_with = "present")] pub agents: Option<bool>,
    #[serde(deserialize_with = "present")] pub schedules: Option<bool>,
    #[serde(deserialize_with = "present")] pub system: Option<bool>,
    #[serde(deserialize_with = "present")] pub events: Option<bool>,
}
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

impl AppSettings {
    pub fn validate(&self) -> Result<()> {
        if !self.glass_intensity.is_finite() || self.glass_intensity.fract() != 0.0 || !(0.0..=100.0).contains(&self.glass_intensity)
            || !self.sidebar_width.is_finite() || self.sidebar_width.fract() != 0.0
            || !(MIN_SIDEBAR_WIDTH..=MAX_SIDEBAR_WIDTH).contains(&self.sidebar_width) {
            return Err(Error::invalid("settings numeric range"));
        }
        if !THEME_IDS.contains(&self.light_theme.as_str()) || !THEME_IDS.contains(&self.dark_theme.as_str()) {
            return Err(Error::invalid("theme id"));
        }
        if self.window_bounds.as_ref().is_some_and(|bounds| !bounds.validate()) { return Err(Error::invalid("window bounds")); }
        self.notifications.validate()
    }

    pub fn apply(&mut self, patch: SettingsPatch) -> Result<()> {
        if let Some(value) = patch.appearance { self.appearance = value; }
        if let Some(value) = patch.glass_intensity { self.glass_intensity = value; }
        if let Some(value) = patch.light_theme { self.light_theme = value; }
        if let Some(value) = patch.dark_theme { self.dark_theme = value; }
        if let Some(value) = patch.language { self.language = value; }
        if let Some(value) = patch.text_size { self.text_size = value; }
        if let Some(value) = patch.ui_font { self.ui_font = value; }
        if let Some(value) = patch.code_font { self.code_font = value; }
        if let Some(value) = patch.tray_click { self.tray_click = value; }
        if let Some(value) = patch.show_dock { self.show_dock = value; }
        if let Some(value) = patch.prevent_sleep { self.prevent_sleep = value; }
        if let Some(value) = patch.sidebar_width { self.sidebar_width = value; }
        if let Some(value) = patch.window_bounds { self.window_bounds = value; }
        if let Some(value) = patch.plugins {
            if let Some(v) = value.agents { self.plugins.agents = v; }
            if let Some(v) = value.schedules { self.plugins.schedules = v; }
            if let Some(v) = value.system { self.plugins.system = v; }
            if let Some(v) = value.events { self.plugins.events = v; }
        }
        if let Some(value) = patch.notifications { self.notifications = value; }
        self.validate()
    }
}

impl NotificationSettings {
    pub fn validate(&self) -> Result<()> {
        if self.source_ids.len() > NOTIFICATION_SOURCE_LIMIT || self.tasks.len() > NOTIFICATION_TASK_LIMIT
            || self.event_types.len() > LocalEventType::ALL.len()
            || self.quiet.start_minute > 1439 || self.quiet.end_minute > 1439
            || (self.quiet.enabled && self.quiet.start_minute == self.quiet.end_minute) {
            return Err(Error::invalid("notification settings"));
        }
        for source in &self.source_ids { crate::error::validate_text(source, 128, 512, "notification source")?; }
        for task in &self.tasks {
            match task {
                NavigationTarget::Schedule { id, identity } if id.starts_with("hermes-job:") && identity.len() <= 1536 => task.validate()?,
                _ => return Err(Error::invalid("notification task must be a bounded schedule target")),
            }
        }
        if has_duplicate(&self.source_ids) || has_duplicate(&self.event_types) || has_duplicate(&self.tasks) {
            return Err(Error::invalid("duplicate notification subscriptions"));
        }
        if serde_json::to_vec(self).map_err(|_| Error::invalid("notification settings"))?.len() > 48 * 1024 {
            return Err(Error::invalid("notification settings size"));
        }
        Ok(())
    }
}
fn has_duplicate<T: PartialEq>(values: &[T]) -> bool { values.iter().enumerate().any(|(i, value)| values[..i].contains(value)) }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LoginAvailability { Available, Development, NotInstalled, Unsupported }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LoginStatus { NotRegistered, Enabled, RequiresApproval, NotFound, Unknown }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginItemState { pub availability: LoginAvailability, pub status: LoginStatus, pub open_at_login: Option<bool>, pub was_opened_at_login: bool, pub details: Option<String> }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginItemUpdateResult { pub ok: bool, pub state: LoginItemState, #[serde(skip_serializing_if = "Option::is_none")] pub details: Option<String>, #[serde(default)] pub rollback_failed: bool }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationPermission { NotDetermined, Denied, Authorized, Provisional, Unsupported, Unknown }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationPhase { Off, EventsDisabled, Starting, Ready, Quiet, Sleeping, PermissionRequired, Denied, Unavailable, Error }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NotificationOutcome { Sent, Summary, Suppressed, Cancelled, Unconfirmed }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationState {
    pub phase: NotificationPhase, pub permission: NotificationPermission, pub detail: Option<String>,
    pub pending_count: usize, pub last_sent_at: Option<String>, pub last_outcome: Option<NotificationOutcome>,
}
impl Default for NotificationState {
    fn default() -> Self { Self { phase: NotificationPhase::Off, permission: NotificationPermission::Unknown, detail: None, pending_count: 0, last_sent_at: None, last_outcome: None } }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResolvedTheme { Light, Dark }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ResolvedLanguage { #[serde(rename = "zh-CN")] Chinese, #[serde(rename = "en")] English }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiquidGlassState { pub available: bool, pub reduced_transparency: bool, pub increased_contrast: bool }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SettingsFailureReason { PermissionDenied, StorageFull, ReadOnly, PathConflict, PathUnavailable, Timeout, Unknown }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsUpdateFailure { pub reason: SettingsFailureReason, pub details: String, pub file_path: String }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsSnapshot {
    pub settings: AppSettings, pub resolved_theme: ResolvedTheme, pub resolved_language: ResolvedLanguage,
    pub platform: String, pub liquid_glass: LiquidGlassState,
    pub geometry_error: Option<SettingsUpdateFailure>, pub login_item: LoginItemState, pub notifications: NotificationState,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsUpdateResult { pub ok: bool, #[serde(skip_serializing_if = "Option::is_none")] pub snapshot: Option<SettingsSnapshot>, #[serde(skip_serializing_if = "Option::is_none")] pub error: Option<SettingsUpdateFailure> }
impl SettingsUpdateResult {
    pub fn ok(snapshot: SettingsSnapshot) -> Self { Self { ok: true, snapshot: Some(snapshot), error: None } }
    pub fn error(error: SettingsUpdateFailure) -> Self { Self { ok: false, snapshot: None, error: Some(error) } }
}
