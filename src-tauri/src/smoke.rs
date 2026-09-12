use crate::{
    error::{NativeError, Result},
    NativeState,
};
use std::{sync::mpsc, time::Duration};
use tauri::Manager;

fn evaluate_text(window: &tauri::WebviewWindow, script: &str) -> Result<String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .eval_with_callback(script, move |value| {
            let _ = sender.send(value);
        })
        .map_err(|_| failed())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| failed())
}

fn evaluate(window: &tauri::WebviewWindow, script: &str) -> Result<bool> {
    Ok(evaluate_text(window, script)? == "true")
}

fn wait_for(window: &tauri::WebviewWindow, script: &str) -> Result<()> {
    for _ in 0..50 {
        if evaluate(window, "window.__conversationSmokeFailed === true")? {
            return Err(NativeError::new(
                "smoke-failed",
                &format!(
                    "Conversation smoke IPC failed: {}",
                    evaluate_text(window, "window.__conversationSmokeFailure")?
                ),
            ));
        }
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

fn conversation_reader(window: &tauri::WebviewWindow) -> Result<()> {
    let body = format!(
        "# Native conversation\n\n{}NATIVE_FULL_BODY_END",
        "Full native message. ".repeat(180)
    );
    let page = serde_json::json!({
        "reference": {"repo":"octo/project","kind":"pr","number":123},
        "stream":"description","page":1,"newestPage":1,"olderPage":null,
        "fetchedAt":"2026-09-11T17:00:00Z","error":null,
        "messages":[{
            "id":"github:octo/project:pr:123:description:1","kind":"description",
            "body":body,"author":"octocat","createdAt":"2026-09-11T17:00:00Z",
            "updatedAt":"2026-09-11T17:00:00Z","url":"https://github.com/octo/project/pull/123",
            "replyTo":null,"reviewId":null,"path":null,"line":null
        }]
    });
    evaluate(
        window,
        &format!(
            r#"void (async () => {{
              const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
              const before = await invoke('workspace_read');
              const page = {page};
              window.__conversationSmokeStage = 'merge';
              await invoke('conversation_merge', {{page}});
              window.__conversationSmokeStage = 'read';
              const cached = await invoke('conversation_read', {{reference:page.reference}});
              if (cached.messages[0].body !== page.messages[0].body) throw new Error('cache-body');
              const after = await invoke('workspace_read');
              if (after.revision !== before.revision) throw new Error('cache-workspace-revision');
              const snapshot = before.snapshot;
              snapshot.workspace.state.threads.push({{
                id:'123',repo:'octo/project',kind:'pr',number:123,source:'github',
                title:'Native conversation reader',reason:'subscribed',notification:'read',
                state:'open',subscribed:true,events:[]
              }});
              snapshot.workspace.state.order.push('t:123');
              snapshot.workspace.state.selectedKey = 't:123';
              snapshot.workspace.state.view = 'inbox';
              window.__conversationSmokeStage = 'seed workspace';
              await invoke('workspace_save', {{expectedRevision:before.revision,snapshot}});
              location.reload();
            }})().catch(error => {{ window.__conversationSmokeFailure = window.__conversationSmokeStage + ': ' + String(error?.message ?? error); window.__conversationSmokeFailed = true; }}); true"#
        ),
    )?;
    wait_for(window, "document.querySelector('.conversation-message')?.textContent.includes('NATIVE_FULL_BODY_END') && document.querySelector('#thread-note-0') !== null")?;
    evaluate(window, "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(document.querySelector('#thread-note-0'),'Private native reader note'); document.querySelector('#thread-note-0').dispatchEvent(new Event('input',{bubbles:true})); true")?;
    std::thread::sleep(Duration::from_millis(200));
    wait_for(
        window,
        "document.querySelector('.workspace-footer')?.textContent.includes('Saved on this Mac')",
    )?;
    evaluate(window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Discard conversation cache').click(); true")?;
    wait_for(window, "[...document.querySelectorAll('button')].some(button => button.textContent === 'Discard cached conversations')")?;
    evaluate(window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Discard cached conversations').click(); true")?;
    wait_for(window, "!document.querySelector('.conversation-message') && document.querySelector('#thread-note-0')?.value === 'Private native reader note' && [...document.querySelectorAll('button')].some(button => button.textContent === 'Load conversation' && !button.disabled)")?;
    evaluate(window, "[...document.querySelectorAll('nav button')].find(button => button.textContent.startsWith('Tasks')).click(); true")?;
    wait_for(
        window,
        "document.querySelector('.row-select')?.textContent.includes('Native smoke capture')",
    )?;
    evaluate(
        window,
        "document.querySelector('.row-select').click(); true",
    )?;
    wait_for(window, "document.querySelector('#task-notes')?.value === 'Native smoke note survives relaunch' && document.querySelector('.workspace-footer')?.textContent.includes('Saved on this Mac')")?;
    Ok(())
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
    conversation_reader(&window)?;
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
            "nativeConversationReader": true, "untruncatedCachedBody": true, "cacheResetKeepsNotes": true,
            "permissionRequested": false, "networkRequests": 0,
        })
    );
    Ok(())
}

fn failed() -> NativeError {
    NativeError::new("smoke-failed", "The native lifecycle smoke check failed.")
}
