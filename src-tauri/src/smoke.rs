use crate::{
    error::{NativeError, Result},
    NativeState,
};
use std::{sync::mpsc, time::Duration};
use tauri::Manager;

#[derive(Default)]
pub(crate) struct ServiceFixture {
    refreshes: std::sync::atomic::AtomicUsize,
    writes: std::sync::atomic::AtomicUsize,
}

impl ServiceFixture {
    pub fn request(&self, request: serde_json::Value) -> Result<serde_json::Value> {
        use std::sync::atomic::Ordering;
        let old = "2026-09-11T17:00:00Z";
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let result = match request["op"].as_str() {
            Some("github.refresh") => {
                let count = self.refreshes.fetch_add(1, Ordering::SeqCst);
                let at = if count < 2 {
                    old
                } else {
                    "2026-09-11T18:00:00Z"
                };
                serde_json::json!({
                    "batchId":format!("native-refresh-{count}"),"fetchedAt":now,
                    "viewer":"viewer","status":"complete","diagnostics":[],
                    "coverage":{"notifications":"complete","pages":1,"received":1,"returned":1,"missingMeansDone":false},
                    "threads":[{
                        "id":"123","reference":{"repo":"octo/project","kind":"pr","number":123},
                        "title":"Native conversation reader","reason":"mention","notification":"unread",
                        "updatedAt":at,"lastReadAt":null,"state":"open","size":null,"subscription":"subscribed",
                        "coverage":{"timeline":"complete","newestPage":1,"fetchedPages":[1],"observedAt":at},
                        "evidence":[{"id":format!("native-event:{at}"),"kind":"comment","at":at,"actor":"octocat",
                            "text":"Native archive evidence","recipient":{"kind":"none"},"requestState":"not-request","textTruncated":false}]
                    }]
                })
            }
            Some("github.acknowledge") => {
                if request["input"]["threadId"] != "123"
                    || request["input"]["notificationUpdatedAt"] != old
                {
                    return Err(failed());
                }
                self.writes.fetch_add(1, Ordering::SeqCst);
                let mut result = request["input"].clone();
                result["status"] = "confirmed".into();
                result["action"] = "acknowledge".into();
                result["confirmedAt"] = now.into();
                result
            }
            Some("github.conversation") => {
                let input = &request["input"];
                let comments = input["stream"] == "comments";
                let page = input["page"]
                    .as_u64()
                    .unwrap_or(if comments { 2 } else { 1 });
                serde_json::json!({
                    "reference":input["reference"],"stream":input["stream"],
                    "page":page,"newestPage":if comments { 2 } else { 1 },
                    "olderPage":if page > 1 { Some(page - 1) } else { None },
                    "fetchedAt":now,"error":null,
                    "messages": if comments { vec![serde_json::json!({
                        "id":format!("github:octo/project:pr:123:comments:{page}"),"kind":"comments",
                        "body":if page == 1 {"NATIVE_OLD_HISTORY"} else {"NATIVE_RECENT_HISTORY"},"author":"octocat","createdAt":old,"updatedAt":old,
                        "url":"https://github.com/octo/project/pull/123#issuecomment-1",
                        "replyTo":null,"reviewId":null,"path":null,"line":null
                    })] } else { vec![] }
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
        &format!("The bundled renderer did not reach: {script}"),
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
                state:'open',subscribed:true,events:[],archive:null
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
    evaluate(window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh').click(); true")?;
    wait_for(window, "document.querySelector('.queue .work-row[data-row-key=\"t:123\"]') && document.querySelector('.workspace-footer')?.textContent.includes('Saved on this Mac') && !document.querySelector('.refresh-button')?.disabled")?;
    evaluate(window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Archive thread').click(); true")?;
    wait_for(window, "!document.querySelector('.queue .work-row[data-row-key=\"t:123\"]') && document.querySelector('.feedback')?.textContent.includes('GitHub confirmed Done')")?;
    evaluate(window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh').click(); true")?;
    wait_for(window, "!document.querySelector('.refresh-button')?.disabled && document.querySelector('.workspace-footer')?.textContent.includes('Saved on this Mac') && !document.querySelector('.queue .work-row[data-row-key=\"t:123\"]')")?;
    evaluate(window, "[...document.querySelectorAll('nav button')].find(button => button.textContent.startsWith('Archive')).click(); true")?;
    wait_for(
        window,
        "document.querySelector('.queue .work-row[data-row-key=\"t:123\"]') !== null",
    )?;
    evaluate(
        window,
        "document.querySelector('.queue .row-select').click(); true",
    )?;
    wait_for(
        window,
        "document.querySelector('#thread-note-0')?.value === 'Private native reader note'",
    )?;
    evaluate(window, "document.querySelector('.conversation-pages > summary').click(); [...document.querySelectorAll('button')].find(button => button.textContent === 'Load older comments').click(); true")?;
    wait_for(window, "document.querySelector('.conversation')?.textContent.includes('NATIVE_OLD_HISTORY') && document.querySelector('.queue .work-row[data-row-key=\"t:123\"]') !== null")?;
    evaluate(window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh').click(); true")?;
    wait_for(window, "!document.querySelector('.refresh-button')?.disabled && !document.querySelector('.queue .work-row[data-row-key=\"t:123\"]') && document.querySelector('#thread-note-0')?.value === 'Private native reader note'")?;
    evaluate(window, "[...document.querySelectorAll('nav button')].find(button => button.textContent.startsWith('Inbox')).click(); true")?;
    wait_for(
        window,
        "document.querySelector('.queue .work-row[data-row-key=\"t:123\"]') !== null",
    )?;
    evaluate(
        window,
        "document.querySelector('.queue .row-select').click(); true",
    )?;
    wait_for(
        window,
        "document.querySelector('#thread-note-0')?.value === 'Private native reader note'",
    )?;
    wait_for(window, "[...document.querySelectorAll('button')].some(button => button.textContent === 'Discard conversation cache' && !button.disabled)")?;
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
        evaluate(&window, "[...document.querySelectorAll('nav button')].find(button => button.textContent.startsWith('Inbox')).click(); true")?;
        wait_for(
            &window,
            "document.querySelector('.queue .work-row[data-row-key=\"t:123\"]') !== null",
        )?;
        evaluate(
            &window,
            "document.querySelector('.queue .row-select').click(); true",
        )?;
        wait_for(
            &window,
            "document.querySelector('#thread-note-0')?.value === 'Private native reader note'",
        )?;
        println!(
            "{}",
            serde_json::json!({"ok":true,"actualProcessRelaunch":true,"taskAndNotesRetained":true,"resurfacedThreadRetained":true,"networkRequests":0,"permissionRequested":false})
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
    let fixture = app.state::<ServiceFixture>();
    if fixture.refreshes.load(std::sync::atomic::Ordering::SeqCst) != 3
        || fixture.writes.load(std::sync::atomic::Ordering::SeqCst) != 1
    {
        return Err(failed());
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
            "nativeConversationReader": true, "untruncatedCachedBody": true, "cacheResetKeepsNotes": true,
            "nativeArchiveAndAcknowledgement": true, "identicalRefreshKeepsArchive": true,
            "oldHistoryKeepsArchive": true, "newActivityResurfacesSameThread": true,
            "permissionRequested": false, "networkRequests": 0,
        })
    );
    Ok(())
}

fn failed() -> NativeError {
    NativeError::new("smoke-failed", "The native lifecycle smoke check failed.")
}
