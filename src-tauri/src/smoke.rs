use crate::{
    error::{NativeError, Result},
    NativeState,
};
use std::{sync::mpsc, time::Duration};
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
        wait_for(&window, "document.querySelector('#task-notes')?.value === 'Native smoke note survives relaunch' && document.querySelector('.detail h2')?.textContent === 'Native smoke capture' && document.querySelector('.task-controls input[type=checkbox]')?.checked === false")?;
        println!(
            "{}",
            serde_json::json!({"ok":true,"actualProcessRelaunch":true,"taskAndNotesRetained":true,"networkRequests":0,"permissionRequested":false})
        );
        return Ok(());
    }
    wait_for(&window, "document.body.innerText.includes('Refresh to load GitHub activity') && document.body.innerText.includes('Select a thread')")?;
    evaluate(
        &window,
        "document.querySelector('.capture-button').click(); true",
    )?;
    wait_for(&window, "document.querySelector('#capture-text') !== null && document.querySelector('dialog button[type=submit]')?.textContent === 'Save task'")?;
    evaluate(&window, "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(document.querySelector('#capture-text'),'Native smoke capture'); document.querySelector('#capture-text').dispatchEvent(new Event('input',{bubbles:true})); true")?;
    std::thread::sleep(Duration::from_millis(200));
    evaluate(
        &window,
        "document.querySelector('dialog button[type=submit]').click(); true",
    )?;
    wait_for(&window, "document.querySelector('#task-notes') !== null && document.querySelector('label[for=\"task-notes\"]')?.textContent === 'Task notes' && document.querySelector('.task-controls input[type=checkbox]')?.checked === false")?;
    evaluate(&window, "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(document.querySelector('#task-notes'),'Native smoke note survives relaunch'); document.querySelector('#task-notes').dispatchEvent(new Event('input',{bubbles:true})); true")?;
    std::thread::sleep(Duration::from_millis(200));
    wait_for(&window, "document.querySelector('.workspace-footer')?.textContent.includes('Saved on this Mac') && document.querySelector('.detail h2')?.textContent === 'Native smoke capture'")?;
    {
        let native = app.state::<NativeState>();
        let guard = native.store.lock().map_err(|_| failed())?;
        let saved = guard.as_ref().map_err(|_| failed())?.read()?;
        let snapshot = saved.snapshot.ok_or_else(failed)?;
        if snapshot.workspace["state"]["tasks"][0]["notes"] != "Native smoke note survives relaunch"
            || snapshot.workspace["state"]["tasks"][0]["title"] != "Native smoke capture"
            || snapshot.workspace["state"]["tasks"][0]["status"] != "open"
            || snapshot.state_version() != Some(3)
            || !snapshot.reminders.is_empty()
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
            "retiredSchedulesAbsent": true, "showReusesWindow": true,
            "permissionRequested": false, "networkRequests": 0,
        })
    );
    Ok(())
}

fn failed() -> NativeError {
    NativeError::new("smoke-failed", "The native lifecycle smoke check failed.")
}
