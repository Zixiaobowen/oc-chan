use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum View { Main, Tray, Recovery }
impl View {
    pub fn permits(self, command:&str)->bool {
        match self {
            Self::Recovery=>matches!(command,"recovery_snapshot"|"recovery_retry"|"recovery_quit"),
            Self::Tray=>matches!(command,"monitor_snapshot"|"monitor_refresh"|"settings_snapshot"|"settings_show_main_window"|"marketplace_snapshot"|"tray_preferences_snapshot"|"tray_preferences_save"),
            Self::Main=>!command.starts_with("recovery_")&&!command.starts_with("tray_preferences_"),
        }
    }
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn auxiliary_views_cannot_mutate_settings_plugins_or_updates(){
        for command in ["settings_update","settings_update_login_item","settings_request_notification_permission","marketplace_install","marketplace_update","marketplace_uninstall","updates_check","updates_set_automatic_checks","diagnostics_save"]{assert!(!View::Tray.permits(command));assert!(!View::Recovery.permits(command));assert!(View::Main.permits(command));}
        assert!(View::Tray.permits("settings_show_main_window"));assert!(View::Tray.permits("tray_preferences_save"));
        assert!(!View::Main.permits("recovery_retry"));assert!(View::Recovery.permits("recovery_retry"));assert!(!View::Recovery.permits("monitor_snapshot"));
    }
}
