fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "workspace_read",
            "workspace_save",
            "workspace_storage_status",
            "workspace_create_backup",
            "workspace_list_backups",
            "workspace_read_backup",
            "workspace_export_json",
            "workspace_export_raw",
            "workspace_recover",
            "launch_github",
            "launch_copilot",
            "clock_now",
            "reminders_status",
            "reminders_request_permission",
            "reminders_retry",
            "service_request",
        ]),
    ))
    .expect("Native permissions could not be generated");
}
