use crate::{
    error::{NativeError, Result},
    NativeState,
};
use std::{
    sync::{atomic::Ordering, mpsc},
    time::Duration,
};
use tauri::Manager;

fn evaluate(window: &tauri::WebviewWindow, script: &str) -> Result<bool> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .eval_with_callback(script, move |value| {
            let _ = sender.send(value);
        })
        .map_err(|_| failed())?;
    Ok(receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| failed())?
        == "true")
}

fn wait_for(window: &tauri::WebviewWindow, script: &str) -> Result<()> {
    for _ in 0..50 {
        if evaluate(window, script)? {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(NativeError::new(
        "smoke-failed",
        "The bundled renderer did not reach the expected saved state.",
    ))
}

pub fn run(app: tauri::AppHandle, relaunch: bool) -> Result<()> {
    let window = app.get_webview_window("main").ok_or_else(failed)?;
    if relaunch {
        wait_for(&window, "document.querySelector('#scratch-notes')?.value === 'Native smoke note survives relaunch' && document.querySelector('.active-anchor')?.textContent.includes('Native smoke capture')")?;
        println!(
            "{}",
            serde_json::json!({"ok":true,"actualProcessRelaunch":true,"notesAndCurrentWorkRetained":true,"networkRequests":0,"permissionRequested":false})
        );
        return Ok(());
    }
    wait_for(&window, "document.body.innerText.includes('Refresh to load GitHub activity') && document.body.innerText.includes('Choose an action.')")?;
    evaluate(
        &window,
        "document.querySelector('.capture-button').click(); true",
    )?;
    wait_for(&window, "document.querySelector('#capture-text') !== null")?;
    evaluate(&window, "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(document.querySelector('#capture-text'),'Native smoke capture'); document.querySelector('#capture-text').dispatchEvent(new Event('input',{bubbles:true})); true")?;
    std::thread::sleep(Duration::from_millis(200));
    evaluate(
        &window,
        "document.querySelector('dialog button[type=submit]').click(); true",
    )?;
    wait_for(&window, "document.querySelector('#scratch-notes') !== null")?;
    evaluate(&window, "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(document.querySelector('#scratch-notes'),'Native smoke note survives relaunch'); document.querySelector('#scratch-notes').dispatchEvent(new Event('input',{bubbles:true})); true")?;
    std::thread::sleep(Duration::from_millis(200));
    evaluate(&window, "Array.from(document.querySelectorAll('.detail-actions button')).find(button=>button.textContent==='Work on this').click(); true")?;
    wait_for(&window, "document.querySelector('.workspace-footer')?.textContent.includes('Saved on this Mac') && document.querySelector('.active-anchor')?.textContent.includes('Native smoke capture')")?;
    {
        let native = app.state::<NativeState>();
        let guard = native.store.lock().map_err(|_| failed())?;
        let saved = guard.as_ref().map_err(|_| failed())?.read()?;
        let snapshot = saved.snapshot.ok_or_else(failed)?;
        if snapshot.workspace["state"]["actions"][0]["notes"]
            != "Native smoke note survives relaunch"
            || snapshot.workspace["state"]["activeId"].is_null()
        {
            return Err(failed());
        }
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
            "ok": true, "nativeRendererRead": true, "captureAndNotesPersisted":true, "closeHidesExistingWindow": true,
            "clockTicksWhileHidden": hidden_ticks - ticks, "showReusesWindow": true,
            "permissionRequested": false, "networkRequests": 0,
        })
    );
    Ok(())
}

fn failed() -> NativeError {
    NativeError::new("smoke-failed", "The native lifecycle smoke check failed.")
}
