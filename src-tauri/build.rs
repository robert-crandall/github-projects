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
            "conversation_read",
            "conversation_merge",
            "conversation_reset",
            "launch_github",
            "launch_copilot",
            "launch_web_url",
            "clock_now",
            "service_request",
        ]),
    ))
    .expect("Native permissions could not be generated");
}
