mod copilot;
mod github;
mod github_pings;
mod notifications;
mod storage;
mod tools;

use copilot::{CaptureProposal, Copilot, RankingInput, RankingProposal};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use storage::{Database, StoredWorkspace, ToolSettings};
use tauri::{
    AppHandle, Emitter, Manager, State,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_dialog::DialogExt;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tools::{ToolStatus, resolve_tool};

pub struct Backend {
    database: Arc<Database>,
    copilot: Copilot,
    sync_lock: tokio::sync::Mutex<()>,
    shutdown: CancellationToken,
    quitting: AtomicBool,
    exit_ready: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionStatus {
    github: ToolStatus,
    copilot: ToolStatus,
    database_path: String,
}

#[tauri::command]
async fn workspace_load(backend: State<'_, Backend>) -> Result<StoredWorkspace, String> {
    let database = backend.database.clone();
    tauri::async_runtime::spawn_blocking(move || database.load())
        .await
        .map_err(|_| "Database reader failed.")?
}

#[tauri::command]
async fn workspace_save(
    backend: State<'_, Backend>,
    state: Value,
    expected_revision: i64,
) -> Result<i64, String> {
    let database = backend.database.clone();
    tauri::async_runtime::spawn_blocking(move || database.save(state, expected_revision))
        .await
        .map_err(|_| "Database writer failed.")?
}

#[tauri::command]
async fn workspace_export(app: AppHandle, state: Value) -> Result<bool, String> {
    storage::validate_workspace(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .set_title("Export workspace backup")
            .set_file_name("github-projects-backup.json")
            .add_filter("Workspace JSON", &["json"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = path
            .into_path()
            .map_err(|_| "Choose a local file for your backup.")?;
        let serialized = serde_json::to_vec_pretty(&state)
            .map_err(|_| "Cannot serialize the workspace backup.")?;
        let parent = path.parent().ok_or("Choose a valid backup directory.")?;
        let staging = parent.join(format!(
            ".github-projects-export-{}.part",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let result = (|| {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&staging)
                .map_err(|_| "Cannot create the backup in this directory.")?;
            file.write_all(&serialized)
                .and_then(|_| file.sync_all())
                .map_err(|_| "Cannot finish writing the backup.")?;
            std::fs::rename(&staging, &path)
                .map_err(|_| "Cannot move the completed backup to its chosen destination.")?;
            Ok(true)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(staging);
        }
        result
    })
    .await
    .map_err(|_| "Workspace export failed.")?
}

#[tauri::command]
async fn connection_status(backend: State<'_, Backend>) -> Result<ConnectionStatus, String> {
    let settings = backend.database.settings()?;
    backend
        .copilot
        .set_github_path(resolve_tool("gh", &settings.gh_path).ok());
    let github = async {
        match resolve_tool("gh", &settings.gh_path) {
            Ok(path) => {
                let mut status = ToolStatus {
                    path: Some(path.to_string_lossy().into_owned()),
                    available: true,
                    ..Default::default()
                };
                match tools::github_login(&path).await {
                    Ok(login) => {
                        status.authenticated = Some(true);
                        status.login = Some(login);
                    }
                    Err(error) => {
                        status.error = Some(error);
                    }
                }
                status
            }
            Err(error) => ToolStatus {
                path: (!settings.gh_path.is_empty()).then_some(settings.gh_path.clone()),
                error: Some(error),
                ..Default::default()
            },
        }
    };
    let copilot = async {
        match resolve_tool("copilot", &settings.copilot_path) {
            Ok(path) => backend.copilot.status(&path).await,
            Err(error) => ToolStatus {
                path: (!settings.copilot_path.is_empty()).then_some(settings.copilot_path.clone()),
                error: Some(error),
                ..Default::default()
            },
        }
    };
    let (github, copilot) = tokio::join!(github, copilot);
    Ok(ConnectionStatus {
        github,
        copilot,
        database_path: backend.database.path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
async fn configure_tools(
    backend: State<'_, Backend>,
    gh_path: String,
    copilot_path: String,
) -> Result<ConnectionStatus, String> {
    for path in [&gh_path, &copilot_path] {
        if path.len() > 4096
            || path.chars().any(char::is_control)
            || (!path.is_empty() && !Path::new(path).is_absolute())
        {
            return Err("Executable settings must be absolute paths, not shell commands.".into());
        }
    }
    backend.copilot.shutdown().await;
    backend.database.save_settings(&ToolSettings {
        gh_path,
        copilot_path,
    })?;
    connection_status(backend).await
}

#[tauri::command]
async fn github_sync(backend: State<'_, Backend>) -> Result<github::GitHubSnapshot, String> {
    let _guard = backend
        .sync_lock
        .try_lock()
        .map_err(|_| "A GitHub refresh is already running.")?;
    let path = resolve_tool("gh", &backend.database.settings()?.gh_path)?;
    let database = backend.database.clone();
    let workspace = tauri::async_runtime::spawn_blocking(move || database.load())
        .await
        .map_err(|_| "Sleep monitoring could not read the stored workspace.")??;
    tokio::select! {
        _ = backend.shutdown.cancelled() => Err("GitHub refresh cancelled because the app is quitting.".into()),
        result = timeout(Duration::from_secs(180), github::sync(&path, workspace.state.as_ref())) => result.map_err(|_| "GitHub refresh exceeded three minutes. The previous snapshot is unchanged.".to_string())?,
    }
}

#[tauri::command]
async fn interpret_capture(
    backend: State<'_, Backend>,
    text: String,
    clock: String,
    time_zone: String,
) -> Result<CaptureProposal, String> {
    let data = copilot::capture_input(&text, &clock, &time_zone)?;
    let settings = backend.database.settings()?;
    backend
        .copilot
        .set_github_path(resolve_tool("gh", &settings.gh_path).ok());
    let path = resolve_tool("copilot", &settings.copilot_path)?;
    let response = backend
        .copilot
        .propose(&path, copilot::CAPTURE_INSTRUCTIONS, data)
        .await?;
    copilot::validate_capture(&response, &text)
}

#[tauri::command]
async fn prioritize_work(
    backend: State<'_, Backend>,
    input: RankingInput,
) -> Result<RankingProposal, String> {
    let data = input.validate()?;
    let settings = backend.database.settings()?;
    backend
        .copilot
        .set_github_path(resolve_tool("gh", &settings.gh_path).ok());
    let path = resolve_tool("copilot", &settings.copilot_path)?;
    let response = backend
        .copilot
        .propose(&path, copilot::RANKING_INSTRUCTIONS, data)
        .await?;
    copilot::validate_ranking(&response, &input)
}

#[tauri::command]
fn cancel_copilot(backend: State<'_, Backend>) {
    backend.copilot.cancel();
}

#[tauri::command]
async fn open_github(url: String) -> Result<(), String> {
    let url = tools::canonical_github_url(&url)?;
    #[cfg(target_os = "macos")]
    {
        let mut command = tokio::process::Command::new("/usr/bin/open");
        command
            .args(["--", &url])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let status = timeout(Duration::from_secs(10), command.status())
            .await
            .map_err(|_| "Opening GitHub timed out.")?
            .map_err(|_| "Cannot open your browser.")?;
        if !status.success() {
            return Err("macOS could not open the GitHub link.".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("This build supports opening links on macOS only.".into())
    }
}

#[tauri::command]
async fn notification_status(
    backend: State<'_, Backend>,
) -> Result<notifications::NotificationStatus, String> {
    let mut status = notifications::status().await;
    if status.error.is_none() {
        status.error = backend.database.notification_error().unwrap_or_else(Some);
    }
    Ok(status)
}

#[tauri::command]
async fn request_notification_permission() -> notifications::NotificationStatus {
    notifications::request_permission().await
}

#[tauri::command]
async fn notification_test() -> Result<(), String> {
    notifications::send(
        "follow-through-test",
        "GitHub Projects",
        "Test reminder requested. Focus settings may silence notifications.",
    )
    .await
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    notifications::clock_event(app);
}

fn quit(app: &AppHandle) {
    let backend = app.state::<Backend>();
    if backend.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    backend.shutdown.cancel();
    backend.copilot.cancel();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        app.state::<Backend>().copilot.shutdown().await;
        app.state::<Backend>()
            .exit_ready
            .store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_window(app)
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            workspace_load,
            workspace_save,
            workspace_export,
            connection_status,
            configure_tools,
            github_sync,
            interpret_capture,
            prioritize_work,
            cancel_copilot,
            open_github,
            notification_status,
            request_notification_permission,
            notification_test
        ])
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700))?;
            }
            let workspace = data.join("copilot-workspace");
            std::fs::create_dir_all(&workspace)?;
            let database =
                Database::open(&data.join("workspace.sqlite3")).map_err(std::io::Error::other)?;
            app.manage(Backend {
                database: Arc::new(database),
                copilot: Copilot::new(workspace),
                sync_lock: tokio::sync::Mutex::new(()),
                shutdown: CancellationToken::new(),
                quitting: AtomicBool::new(false),
                exit_ready: AtomicBool::new(false),
            });
            let show = MenuItem::with_id(app, "show", "Show GitHub Projects", true, None::<&str>)?;
            let capture = MenuItem::with_id(app, "capture", "Capture", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(
                app,
                "quit",
                "Quit GitHub Projects",
                true,
                Some("CmdOrCtrl+Q"),
            )?;
            let menu = Menu::with_items(app, &[&show, &capture, &quit_item])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| std::io::Error::other("Missing app icon"))?;
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("GitHub Projects")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "capture" => {
                        show_window(app);
                        let _ = app.emit("desktop-capture", ());
                    }
                    "quit" => quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let cancellation = handle.state::<Backend>().shutdown.clone();
                let mut interval = tokio::time::interval(Duration::from_secs(20));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = cancellation.cancelled() => break,
                        _ = interval.tick() => {
                            notifications::clock_event(&handle);
                            if let Err(error) = notifications::heartbeat(&handle).await {
                                notifications::report_error(&handle, &error);
                            }
                        }
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if !window.state::<Backend>().quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            tauri::WindowEvent::Focused(true) => notifications::clock_event(window.app_handle()),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("GitHub Projects could not start. Existing workspace data has not been reset.");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if !app.state::<Backend>().exit_ready.load(Ordering::SeqCst) {
                api.prevent_exit();
                quit(app);
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show_window(app),
        _ => {}
    });
}
