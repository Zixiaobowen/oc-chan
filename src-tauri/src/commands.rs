// Window masks: main=1, tray=2, recovery=4. Build-time capabilities and the
// runtime guard use this same table; there is no general-purpose command bridge.
pub const COMMANDS: &[(&str, u8)] = &[
    ("desktop_register", 7), ("desktop_interest", 3), ("desktop_committed", 7),
    ("desktop_ack", 3),
    ("monitor_snapshot", 3), ("monitor_refresh", 3), ("monitor_retry_source", 1),
    ("monitor_focus_agent_in_tern", 1), ("monitor_schedule_history", 1), ("monitor_cancel_schedule_history", 1),
    ("monitor_events", 1), ("monitor_cancel_events", 1), ("monitor_navigation", 1),
    ("monitor_acknowledge_navigation", 1),
    ("diagnostics_generate", 1), ("diagnostics_copy", 1), ("diagnostics_save", 1), ("diagnostics_cancel", 1),
    ("settings_snapshot", 3), ("settings_update", 1), ("settings_retry_geometry", 1),
    ("settings_preview_glass", 1), ("settings_update_login_item", 1),
    ("settings_request_notification_permission", 1), ("settings_show_main_window", 3),
    ("updates_snapshot", 1), ("updates_check", 1), ("updates_download", 1),
    ("updates_cancel", 1), ("updates_install", 1), ("updates_open_release_notes", 1),
    ("marketplace_snapshot", 3), ("marketplace_check", 1), ("marketplace_install", 1),
    ("marketplace_update", 1), ("marketplace_uninstall", 1), ("marketplace_cancel", 1),
    ("recovery_snapshot", 4), ("recovery_retry", 4), ("recovery_quit", 4),
];
