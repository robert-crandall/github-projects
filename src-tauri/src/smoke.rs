use crate::{
    error::{NativeError, Result},
    NativeState,
};
use std::{
    sync::{atomic::Ordering, mpsc},
    time::Duration,
};
use tauri::Manager;

pub fn run(app: tauri::AppHandle) -> Result<()> {
    let window = app.get_webview_window("main").ok_or_else(failed)?;
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .eval_with_callback(
            "document.body.innerText.includes('No desktop workspace has been saved.')",
            move |value| {
                let _ = sender.send(value);
            },
        )
        .map_err(|_| failed())?;
    if receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| failed())?
        != "true"
    {
        return Err(NativeError::new(
            "smoke-failed",
            "The bundled webview did not render an empty native workspace.",
        ));
    }
    if !window.is_visible().map_err(|_| failed())? {
        return Err(failed());
    }
    window.close().map_err(|_| failed())?;
    std::thread::sleep(Duration::from_millis(500));
    if window.is_visible().map_err(|_| failed())? || app.webview_windows().len() != 1 {
        return Err(NativeError::new(
            "smoke-failed",
            "Closing did not retain the hidden workspace window.",
        ));
    }
    let ticks = app.state::<NativeState>().ticks.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_secs(16));
    let hidden_ticks = app.state::<NativeState>().ticks.load(Ordering::SeqCst);
    if hidden_ticks <= ticks {
        return Err(NativeError::new(
            "smoke-failed",
            "The native clock did not continue while the window was hidden.",
        ));
    }
    crate::show_window(&app);
    std::thread::sleep(Duration::from_millis(500));
    if !window.is_visible().map_err(|_| failed())? || app.webview_windows().len() != 1 {
        return Err(NativeError::new(
            "smoke-failed",
            "Show did not return the existing window.",
        ));
    }
    println!(
        "{}",
        serde_json::json!({
            "ok": true, "nativeRendererRead": true, "closeHidesExistingWindow": true,
            "clockTicksWhileHidden": hidden_ticks - ticks, "showReusesWindow": true,
            "permissionRequested": false, "networkRequests": 0,
        })
    );
    Ok(())
}

fn failed() -> NativeError {
    NativeError::new("smoke-failed", "The native lifecycle smoke check failed.")
}
