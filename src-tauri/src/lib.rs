mod error;
mod launch;
mod model;
mod service;
mod smoke;
mod storage;

use error::{NativeError, Result};
use launch::{GitHubIdentity, LaunchResult};
use model::{Snapshot, WorkspaceRead};
use serde::Serialize;
use service::ServiceHost;
use std::sync::{Arc, Mutex};
use storage::{Backup, RawExport, StorageStatus, Store};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, State,
};

type SharedStore = Arc<Mutex<Result<Store>>>;

struct NativeState {
    store: SharedStore,
}

impl NativeState {
    fn new(store: Result<Store>) -> Self {
        Self {
            store: Arc::new(Mutex::new(store)),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Clock {
    now: String,
    time_zone: Option<String>,
    error: Option<NativeError>,
}

fn clock() -> Clock {
    let now = chrono::Utc::now().to_rfc3339();
    match iana_time_zone::get_timezone() {
        Ok(time_zone) => Clock {
            now,
            time_zone: Some(time_zone),
            error: None,
        },
        Err(_) => Clock {
            now,
            time_zone: None,
            error: Some(NativeError::new(
                "timezone-unavailable",
                "The local timezone could not be detected.",
            )),
        },
    }
}

async fn background<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| {
            NativeError::new(
                "native-worker-failed",
                "A native worker stopped unexpectedly. The operation was not confirmed.",
            )
        })?
}

async fn with_store<T: Send + 'static>(
    state: State<'_, NativeState>,
    operation: impl FnOnce(&mut Store) -> Result<T> + Send + 'static,
) -> Result<T> {
    let store = state.store.clone();
    background(move || {
        let mut guard = store.lock().map_err(|_| {
            NativeError::new(
                "native-worker-failed",
                "The storage worker stopped unexpectedly. Restart before saving.",
            )
        })?;
        operation(guard.as_mut().map_err(|error| error.clone())?)
    })
    .await
}

#[tauri::command]
async fn workspace_read(state: State<'_, NativeState>) -> Result<WorkspaceRead> {
    with_store(state, |store| store.read()).await
}

#[tauri::command]
async fn workspace_save(
    state: State<'_, NativeState>,
    expected_revision: String,
    snapshot: Snapshot,
) -> Result<WorkspaceRead> {
    with_store(state, move |store| store.save(&expected_revision, snapshot)).await
}

#[tauri::command]
async fn workspace_storage_status(state: State<'_, NativeState>) -> Result<StorageStatus> {
    with_store(state, |store| Ok(store.status())).await
}

#[tauri::command]
async fn workspace_create_backup(
    state: State<'_, NativeState>,
    expected_revision: String,
) -> Result<Backup> {
    with_store(state, move |store| store.create_backup(&expected_revision)).await
}

#[tauri::command]
async fn workspace_list_backups(state: State<'_, NativeState>) -> Result<Vec<Backup>> {
    with_store(state, |store| store.list_backups()).await
}

#[tauri::command]
async fn workspace_read_backup(
    state: State<'_, NativeState>,
    backup_id: String,
) -> Result<WorkspaceRead> {
    with_store(state, move |store| store.read_backup(&backup_id)).await
}

#[tauri::command]
async fn workspace_export_json(
    state: State<'_, NativeState>,
    expected_revision: String,
) -> Result<String> {
    with_store(state, move |store| store.export_json(&expected_revision)).await
}

#[tauri::command]
async fn workspace_export_raw(state: State<'_, NativeState>) -> Result<RawExport> {
    with_store(state, |store| store.export_raw()).await
}

#[tauri::command]
async fn workspace_recover(
    state: State<'_, NativeState>,
    backup_id: String,
    expected_recovery_token: String,
) -> Result<WorkspaceRead> {
    with_store(state, move |store| {
        store.recover(&backup_id, &expected_recovery_token)
    })
    .await
}

#[tauri::command]
async fn launch_github(identity: GitHubIdentity) -> Result<LaunchResult> {
    background(move || launch::dispatch(identity, false)).await
}

#[tauri::command]
async fn launch_copilot(identity: GitHubIdentity) -> Result<LaunchResult> {
    background(move || launch::dispatch(identity, true)).await
}

#[tauri::command]
fn clock_now() -> Clock {
    clock()
}

#[tauri::command]
async fn service_request(
    state: State<'_, Arc<ServiceHost>>,
    request: serde_json::Value,
) -> Result<serde_json::Value> {
    let host = state.inner().clone();
    background(move || host.request(request)).await
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window
            .show()
            .and_then(|_| window.unminimize())
            .and_then(|_| window.set_focus())
            .is_err()
        {
            eprintln!("window-show-failed: Could not show the existing workspace window.");
        }
    }
}

fn navigation_allowed(url: &url::Url) -> bool {
    let local = url.scheme() == "tauri" && url.host_str() == Some("localhost");
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    local || development
}

fn install_lifecycle(
    app: &mut tauri::App,
    store: Result<Store>,
    runtime_directory: std::path::PathBuf,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    app.manage(NativeState::new(store));
    app.manage(Arc::new(ServiceHost::new(
        runtime_directory.join("service-runtime"),
    )?));
    tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
        .on_navigation(navigation_allowed)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()?;
    let show = MenuItem::with_id(app, "show", "Show GitHub Projects", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit GitHub Projects", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    TrayIconBuilder::new()
        .icon(
            app.default_window_icon()
                .ok_or("Application icon is missing")?
                .clone(),
        )
        .tooltip("GitHub Projects")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_window(app),
            "quit" => {
                app.state::<Arc<ServiceHost>>().shutdown();
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn smoke_check() -> Result<()> {
    let directory = std::env::temp_dir().join(format!(
        "github-projects-native-smoke-{}",
        uuid::Uuid::new_v4()
    ));
    let mut store = Store::new(directory.clone())?;
    let saved = store.read()?;
    if saved.snapshot.is_some() {
        return Err(NativeError::corrupt());
    }
    let result = store.save(
        &saved.revision,
        Snapshot {
            format_version: 1,
            workspace: serde_json::json!({"version":1,"nativeSmokeCheck":true}),
            reminders: vec![],
        },
    )?;
    println!(
        "{}",
        serde_json::json!({
            "ok": true, "snapshotInitiallyEmpty": true,
            "saveReadRoundtrip": store.read()?.revision == result.revision,
            "clock": clock(),
            "networkRequests": 0, "permissionRequested": false,
        })
    );
    drop(store);
    // Only this invocation's fixed-prefix UUID directory is removed.
    std::fs::remove_dir_all(directory)?;
    Ok(())
}

pub fn run() {
    let arguments: Vec<String> = std::env::args().collect();
    let read_only_smoke = arguments
        .iter()
        .any(|arg| arg == "--integration-read-smoke-check");
    if read_only_smoke
        || arguments
            .iter()
            .any(|arg| arg == "--integration-service-smoke-check")
    {
        let directory = std::env::temp_dir().join(format!(
            "github-projects-service-smoke-{}",
            uuid::Uuid::new_v4()
        ));
        let result = (|| -> Result<()> {
            let host = ServiceHost::new(directory.clone())?;
            if !read_only_smoke {
                let preview = host.request(serde_json::json!({
                    "v":1,"id":"native-sdk-smoke","op":"copilot.interpretCapture",
                    "input":{"captureId":"synthetic-native-capture","text":"Prepare a synthetic checklist for a local example task.","timeZone":"UTC"}
                }))?;
                if preview["ok"] != true
                    || preview["result"]["previewOnly"] != true
                    || preview["result"]["captureId"] != "synthetic-native-capture"
                {
                    return Err(NativeError::new(
                        "smoke-failed",
                        "The packaged SDK did not return a confirmed structured preview.",
                    ));
                }
                println!(
                    "{}",
                    serde_json::json!({"packagedSdkPreview":true,"ok":true})
                );
            }
            let refresh = host.request(serde_json::json!({"v":1,"id":"native-read-smoke","op":"github.refresh","input":{}}))?;
            if refresh["ok"] != true {
                return Err(NativeError::new(
                    refresh["error"]["code"].as_str().unwrap_or("smoke-failed"),
                    refresh["error"]["message"]
                        .as_str()
                        .unwrap_or("The packaged read-only GitHub refresh failed."),
                ));
            }
            println!(
                "{}",
                serde_json::json!({
                    "ok":true,"readOnlyRefresh":true,
                    "threads":refresh["result"]["threads"].as_array().map(Vec::len),
                    "coverage":refresh["result"]["status"],"githubWrites":0,"permissionRequested":false
                })
            );
            host.shutdown();
            Ok(())
        })();
        if directory.exists() && std::fs::remove_dir_all(&directory).is_err() {
            eprintln!(
                "smoke-cleanup-failed: The temporary service workspace could not be removed."
            );
        }
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().any(|arg| arg == "--native-smoke-check") {
        if let Err(error) = smoke_check() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let relaunch = arguments
        .iter()
        .any(|arg| arg == "--native-ui-smoke-relaunch");
    let smoke_session = arguments
        .windows(2)
        .find(|args| args[0] == "--integration-smoke-session")
        .map(|args| uuid::Uuid::parse_str(&args[1]).expect("Smoke session must be a UUID"));
    let smoke_directory =
        (arguments.iter().any(|arg| arg == "--native-ui-smoke-check") || relaunch).then(|| {
            std::env::temp_dir().join(format!(
                "github-projects-ui-smoke-{}",
                smoke_session.unwrap_or_else(uuid::Uuid::new_v4)
            ))
        });
    let setup_directory = smoke_directory.clone();
    let exit_code = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            workspace_read,
            workspace_save,
            workspace_storage_status,
            workspace_create_backup,
            workspace_list_backups,
            workspace_read_backup,
            workspace_export_json,
            workspace_export_raw,
            workspace_recover,
            launch_github,
            launch_copilot,
            clock_now,
            service_request,
        ])
        .setup(move |app| {
            let directory = match &setup_directory {
                Some(directory) => Ok(directory.clone()),
                None => app.path().app_data_dir(),
            };
            let runtime_directory = directory
                .as_ref()
                .map_err(|_| "The isolated runtime directory is unavailable")?
                .clone();
            let store = directory
                .map_err(|_| {
                    NativeError::new(
                        "storage-unavailable",
                        "The isolated workspace data directory could not be located.",
                    )
                })
                .and_then(Store::new);
            install_lifecycle(app, store, runtime_directory)?;
            if setup_directory.is_some() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    let result = smoke::run(handle.clone(), relaunch);
                    if let Err(error) = &result {
                        eprintln!("{error}");
                    }
                    handle.exit(if result.is_ok() { 0 } else { 1 });
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.hide().is_err() {
                    eprintln!("window-hide-failed: Could not hide the workspace window.");
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("The native workspace could not be initialized")
        .run_return(|app, event| match event {
            tauri::RunEvent::Reopen { .. } => show_window(app),
            tauri::RunEvent::Exit => {
                app.state::<Arc<ServiceHost>>().shutdown();
            }
            _ => {}
        });
    if let Some(directory) = smoke_directory.filter(|_| smoke_session.is_none() || relaunch) {
        if std::fs::remove_dir_all(directory).is_err() {
            eprintln!("smoke-cleanup-failed: The temporary smoke workspace could not be removed.");
            std::process::exit(1);
        }
    }
    std::process::exit(exit_code);
}

#[cfg(test)]
mod retirement_tests;
