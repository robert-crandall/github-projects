use crate::{
    error::{NativeError, Result},
    NativeState,
};
use std::{sync::mpsc, time::Duration};
use tauri::Manager;

#[derive(Default)]
pub(crate) struct ServiceFixture {
    rankings: std::sync::atomic::AtomicUsize,
}

impl ServiceFixture {
    pub fn request(&self, request: serde_json::Value) -> Result<serde_json::Value> {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let result = match request["op"].as_str() {
            Some("work.intake") => serde_json::json!({"items":[],"hasMore":false}),
            Some("work.collect") => serde_json::json!({
                "candidates":[],"observations":[],"warnings":[],"collectedAt":now
            }),
            Some("work.rank") => {
                self.rankings
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let tasks = request["input"]["tasks"].as_array().ok_or_else(failed)?;
                serde_json::json!({
                    "orderedIds":tasks.iter().map(|task| task["id"].clone()).collect::<Vec<_>>(),
                    "reasons":tasks.iter().map(|task| serde_json::json!({
                        "id":task["id"],"reason":"Native smoke priority"
                    })).collect::<Vec<_>>()
                })
            }
            _ => {
                return Err(NativeError::new(
                    "smoke-failed",
                    "The native UI smoke attempted an unexpected service or model operation.",
                ))
            }
        };
        Ok(serde_json::json!({"v":1,"id":request["id"],"ok":true,"result":result}))
    }
}

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
        &format!("The bundled renderer did not reach: {script}"),
    ))
}

fn click(window: &tauri::WebviewWindow, text: &str) -> Result<()> {
    let text = serde_json::to_string(text).map_err(|_| failed())?;
    evaluate(window, &format!("[...document.querySelectorAll('button')].find(button => button.textContent === {text}).click(); true"))?;
    Ok(())
}

fn saved(window: &tauri::WebviewWindow) -> Result<()> {
    wait_for(
        window,
        "document.querySelector('.workspace-footer')?.textContent.includes('Saved on this Mac')",
    )
}

pub fn run(app: tauri::AppHandle, relaunch: bool) -> Result<()> {
    let window = app.get_webview_window("main").ok_or_else(failed)?;
    wait_for(&window, "document.querySelector('.task-top') !== null && document.querySelector('.task-sidebar') !== null")?;
    if relaunch {
        evaluate(&window, "[...document.querySelectorAll('.task-tabs button')].find(button => button.textContent.startsWith('Done')).click(); true")?;
        wait_for(
            &window,
            "document.querySelector('.task-title')?.textContent === 'Native smoke capture'",
        )?;
        evaluate(&window, "document.querySelector('.task-row').click(); true")?;
        wait_for(&window, "document.querySelector('#task-notes')?.value === 'Native smoke note survives relaunch'")?;
        println!(
            "{}",
            serde_json::json!({
                "ok":true,"actualProcessRelaunch":true,"taskAndNotesRetained":true,
                "networkRequests":0,"permissionRequested":false
            })
        );
        return Ok(());
    }
    evaluate(
        &window,
        "document.querySelector('.task-capture').click(); true",
    )?;
    wait_for(&window, "document.querySelector('#capture-task') !== null")?;
    evaluate(&window, "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(document.querySelector('#capture-task'),'Native smoke capture'); document.querySelector('#capture-task').dispatchEvent(new Event('input',{bubbles:true})); true")?;
    std::thread::sleep(Duration::from_millis(200));
    evaluate(
        &window,
        "document.querySelector('dialog button[type=submit]').click(); true",
    )?;
    wait_for(&window, "document.querySelector('.task-row') !== null")?;
    evaluate(&window, "document.querySelector('.task-row').click(); true")?;
    wait_for(&window, "document.querySelector('#task-notes') !== null")?;
    evaluate(&window, "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(document.querySelector('#task-notes'),'Native smoke note survives relaunch'); document.querySelector('#task-notes').dispatchEvent(new Event('input',{bubbles:true})); true")?;
    std::thread::sleep(Duration::from_millis(200));
    saved(&window)?;
    {
        let native = app.state::<NativeState>();
        let guard = native.store.lock().map_err(|_| failed())?;
        let snapshot = guard
            .as_ref()
            .map_err(|_| failed())?
            .read()?
            .snapshot
            .ok_or_else(failed)?;
        if snapshot.workspace["state"]["tasks"][0]["notes"] != "Native smoke note survives relaunch"
            || snapshot.workspace["state"]["tasks"][0]["status"] != "open"
            || snapshot.state_version() != Some(3)
            || !snapshot.reminders.is_empty()
        {
            return Err(failed());
        }
    }
    window.close().map_err(|_| failed())?;
    std::thread::sleep(Duration::from_millis(500));
    if window.is_visible().map_err(|_| failed())? || app.webview_windows().len() != 1 {
        return Err(failed());
    }
    crate::show_window(&app);
    std::thread::sleep(Duration::from_millis(500));
    if !window.is_visible().map_err(|_| failed())? || app.webview_windows().len() != 1 {
        return Err(failed());
    }
    click(&window, "Run now")?;
    wait_for(
        &window,
        "document.querySelector('.task-reason')?.textContent === 'Native smoke priority'",
    )?;
    saved(&window)?;
    click(&window, "Settings")?;
    wait_for(
        &window,
        "document.querySelector('#schedule-heading') !== null",
    )?;
    evaluate(&window, "document.querySelector('#schedule-heading').closest('section').querySelector('input[type=checkbox]').click(); true")?;
    evaluate(
        &window,
        "document.querySelector('.task-settings button[type=submit]').click(); true",
    )?;
    saved(&window)?;
    click(&window, "Back to tasks")?;
    evaluate(&window, "const RealDate=Date; const future=RealDate.now()+31*60*1000; window.Date=class extends RealDate { constructor(...args){ super(...(args.length ? args : [future])); } static now(){ return future; } }; true")?;
    window.hide().map_err(|_| failed())?;
    tauri::Emitter::emit(&app, "work-tick", ()).map_err(|_| failed())?;
    let fixture = app.state::<ServiceFixture>();
    for _ in 0..100 {
        if fixture.rankings.load(std::sync::atomic::Ordering::SeqCst) >= 2 {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if fixture.rankings.load(std::sync::atomic::Ordering::SeqCst) != 2
        || window.is_visible().map_err(|_| failed())?
    {
        return Err(failed());
    }
    crate::show_window(&app);
    saved(&window)?;
    click(&window, "Settings")?;
    wait_for(
        &window,
        "document.querySelector('#schedule-heading') !== null",
    )?;
    evaluate(&window, "document.querySelector('#schedule-heading').closest('section').querySelector('input[type=checkbox]').click(); true")?;
    evaluate(
        &window,
        "document.querySelector('.task-settings button[type=submit]').click(); true",
    )?;
    saved(&window)?;
    click(&window, "Back to tasks")?;
    wait_for(&window, "document.querySelector('.task-complete') !== null")?;
    evaluate(
        &window,
        "document.querySelector('.task-complete').click(); true",
    )?;
    wait_for(&window, "document.querySelector('.task-title') === null")?;
    saved(&window)?;
    println!(
        "{}",
        serde_json::json!({
            "ok":true,"threePanelRankedHome":true,"captureAndNotesPersisted":true,
            "closeHidesExistingWindow":true,"showReusesWindow":true,"hiddenScheduledRun":true,
            "rankedTaskDonePersisted":true,"networkRequests":0,"permissionRequested":false
        })
    );
    Ok(())
}

fn failed() -> NativeError {
    NativeError::new("smoke-failed", "The native lifecycle smoke check failed.")
}
