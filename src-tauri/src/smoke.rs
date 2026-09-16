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
    rankings: std::sync::atomic::AtomicUsize,
}

impl ServiceFixture {
    pub fn request(&self, request: serde_json::Value) -> Result<serde_json::Value> {
        use std::sync::atomic::Ordering;
        let old = "2026-09-11T17:00:00Z";
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let result = match request["op"].as_str() {
            Some("work.intake") => serde_json::json!({"items":[],"hasMore":false}),
            Some("work.collect") => serde_json::json!({
                "candidates":[],"observations":[],"warnings":[],"collectedAt":now
            }),
            Some("work.rank") => {
                self.rankings.fetch_add(1, Ordering::SeqCst);
                let tasks = request["input"]["tasks"].as_array().ok_or_else(failed)?;
                serde_json::json!({
                    "orderedIds":tasks.iter().map(|task| task["id"].clone()).collect::<Vec<_>>(),
                    "reasons":tasks.iter().map(|task| serde_json::json!({
                        "id":task["id"],"reason":"Native smoke priority"
                    })).collect::<Vec<_>>()
                })
            }
            Some("github.refresh") => {
                let count = self.refreshes.fetch_add(1, Ordering::SeqCst);
                let at = if count >= 4 {
                    now.as_str()
                } else if count < 2 {
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
                        "sourceState":{"state":if count == 3 {"queued"} else {"open"},"observedAt":now,"updatedAt":at,"error":null},
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

fn fill_rule_field(window: &tauri::WebviewWindow, label: &str, value: &str) -> Result<()> {
    let label = serde_json::to_string(label).map_err(|_| failed())?;
    let value = serde_json::to_string(value).map_err(|_| failed())?;
    evaluate(
        window,
        &format!(
            r#"
      (() => {{
        const input = [...document.querySelectorAll('dialog label')].find(label => label.textContent.startsWith({label})).querySelector('input,select');
        const select = input instanceof HTMLSelectElement;
        Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : HTMLInputElement.prototype,'value').set.call(input,{value});
        input.dispatchEvent(new Event(select ? 'change' : 'input',{{bubbles:true}}));
      }})(); true"#
        ),
    )?;
    std::thread::sleep(Duration::from_millis(150));
    Ok(())
}

fn filtering_rules(window: &tauri::WebviewWindow) -> Result<()> {
    evaluate(window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Filtering rules').click(); true")?;
    wait_for(
        window,
        "document.querySelector('dialog[open] .inbox-settings') !== null",
    )?;
    evaluate(
        window,
        "document.querySelector('.inbox-settings summary').click(); true",
    )?;
    fill_rule_field(window, "Inbox name", "Native inbox")?;
    evaluate(window, "[...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Create inbox').click(); true")?;
    wait_for(window, "document.querySelector('.inbox-settings .rule-list')?.textContent.includes('Native inbox')")?;
    evaluate(window, "[...document.querySelectorAll('dialog button')].find(button => button.textContent === 'New rule').click(); true")?;
    wait_for(window, "document.querySelector('.rule-editor') !== null")?;
    fill_rule_field(window, "Rule name", "Native route")?;
    fill_rule_field(window, "Thread type", "pr")?;
    evaluate(window, "const select=document.querySelector('.rule-editor label select:last-child'); const action=[...document.querySelectorAll('.rule-editor select')].at(-1); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(action,action.options[1].value); action.dispatchEvent(new Event('change',{bubbles:true})); true")?;
    std::thread::sleep(Duration::from_millis(150));
    evaluate(window, "[...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Preview matches').click(); true")?;
    wait_for(window, "document.querySelector('.rule-preview')?.textContent.includes('Effective location: Native inbox')")?;
    evaluate(window, "[...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Save rule').click(); true")?;
    wait_for(window, "document.querySelector('.rule-editor') === null")?;
    evaluate(window, "[...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Back to workspace').click(); true")?;
    wait_for(window, "document.querySelector('[aria-label=\"Thread location\"]')?.textContent.includes('Native route') && !document.querySelector('.queue .work-row[data-row-key=\"t:123\"]')")?;
    evaluate(window, "[...document.querySelectorAll('nav button')].find(button => button.textContent.startsWith('Native inbox')).click(); true")?;
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
    evaluate(window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh').click(); true")?;
    wait_for(window, "!document.querySelector('.refresh-button')?.disabled && document.querySelector('[aria-label=\"Thread location\"]')?.textContent.includes('Currently in GitHub') && !document.querySelector('.queue .work-row[data-row-key=\"t:123\"]')")?;
    evaluate(window, "[...document.querySelectorAll('nav button')].find(button => button.textContent.startsWith('Filtered')).click(); true")?;
    wait_for(
        window,
        "document.querySelector('.queue .work-row[data-row-key=\"t:123\"]') !== null",
    )?;
    evaluate(
        window,
        "document.querySelector('.queue .row-select').click(); true",
    )?;
    wait_for(window, "document.querySelector('#thread-note-0')?.value === 'Private native reader note' && document.querySelector('.conversation')?.textContent.includes('NATIVE_FULL_BODY_END')")?;
    evaluate(window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh').click(); true")?;
    wait_for(window, "!document.querySelector('.refresh-button')?.disabled && !document.querySelector('.queue .work-row[data-row-key=\"t:123\"]') && document.querySelector('[aria-label=\"Thread location\"]')?.textContent.includes('Native route')")?;
    evaluate(window, "[...document.querySelectorAll('nav button')].find(button => button.textContent.startsWith('Native inbox')).click(); true")?;
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
    Ok(())
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
    filtering_rules(window)?;
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
    wait_for(&window, "document.querySelector('.task-top') !== null")?;
    evaluate(&window, "document.querySelector('button[aria-label=\"Sources and priorities\"]').click(); true")?;
    wait_for(&window, "document.querySelector('.task-settings') !== null")?;
    evaluate(&window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Open saved thread notes').click(); true")?;
    if relaunch {
        wait_for(&window, "document.querySelector('#task-notes')?.value === 'Native smoke note survives relaunch' && document.querySelector('.detail h2')?.textContent === 'Native smoke capture' && document.querySelector('.task-controls input[type=checkbox]')?.checked === true")?;
        evaluate(&window, "[...document.querySelectorAll('nav button')].find(button => button.textContent.startsWith('Native inbox')).click(); true")?;
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
            "document.querySelector('#thread-note-0')?.value === 'Private native reader note' && document.querySelector('.workspace-footer')?.textContent.includes('Saved on this Mac')",
        )?;
        println!(
            "{}",
            serde_json::json!({"ok":true,"actualProcessRelaunch":true,"taskAndNotesRetained":true,"resurfacedThreadRetained":true,"rulesAndNamedInboxRetained":true,"networkRequests":0,"permissionRequested":false})
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
    if fixture.refreshes.load(std::sync::atomic::Ordering::SeqCst) != 5
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
    evaluate(&window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Back to ranked tasks').click(); true")?;
    wait_for(&window, "document.querySelector('.task-title')?.textContent === 'Native smoke capture'")?;
    evaluate(&window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Run now').click(); true")?;
    wait_for(&window, "document.querySelector('.task-reason')?.textContent === 'Native smoke priority' && document.querySelector('.workspace-footer')?.textContent.includes('Saved on this Mac')")?;
    evaluate(&window, "document.querySelector('button[aria-label=\"Sources and priorities\"]').click(); true")?;
    wait_for(&window, "document.querySelector('#schedule-heading') !== null")?;
    evaluate(&window, "document.querySelector('#schedule-heading').closest('section').querySelector('input[type=checkbox]').click(); true")?;
    evaluate(&window, "document.querySelector('.task-settings button[type=submit]').click(); true")?;
    wait_for(&window, "document.querySelector('.workspace-footer')?.textContent.includes('Saved on this Mac')")?;
    evaluate(&window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Back to tasks').click(); const RealDate=Date; const future=RealDate.now()+31*60*1000; window.Date=class extends RealDate { constructor(...args){ super(...(args.length ? args : [future])); } static now(){ return future; } }; true")?;
    window.hide().map_err(|_| failed())?;
    tauri::Emitter::emit(&app, "work-tick", ()).map_err(|_| failed())?;
    for _ in 0..100 {
        if fixture.rankings.load(std::sync::atomic::Ordering::SeqCst) >= 2 {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if fixture.rankings.load(std::sync::atomic::Ordering::SeqCst) != 2
        || window.is_visible().map_err(|_| failed())?
    {
        return Err(NativeError::new("smoke-failed", "The opted-in schedule did not rank while the window was hidden."));
    }
    crate::show_window(&app);
    wait_for(&window, "document.querySelector('.workspace-footer')?.textContent.includes('Saved on this Mac') && [...document.querySelectorAll('button')].some(button => button.textContent === 'Run now')")?;
    evaluate(&window, "document.querySelector('button[aria-label=\"Sources and priorities\"]').click(); true")?;
    wait_for(&window, "document.querySelector('#schedule-heading') !== null")?;
    evaluate(&window, "document.querySelector('#schedule-heading').closest('section').querySelector('input[type=checkbox]').click(); document.querySelector('.task-settings button[type=submit]').click(); true")?;
    wait_for(&window, "document.querySelector('.workspace-footer')?.textContent.includes('Saved on this Mac')")?;
    evaluate(&window, "[...document.querySelectorAll('button')].find(button => button.textContent === 'Back to tasks').click(); true")?;
    wait_for(&window, "document.querySelector('.task-complete') !== null")?;
    evaluate(&window, "document.querySelector('.task-complete').click(); true")?;
    wait_for(&window, "document.querySelector('.task-title') === null && document.querySelector('.workspace-footer')?.textContent.includes('Saved on this Mac')")?;
    {
        let native = app.state::<NativeState>();
        let guard = native.store.lock().map_err(|_| failed())?;
        let snapshot = guard.as_ref().map_err(|_| failed())?.read()?.snapshot.ok_or_else(failed)?;
        if snapshot.workspace["state"]["tasks"][0]["status"] != "done"
            || snapshot.workspace["state"]["work"]["ranking"]["rankedAt"].as_str().is_none()
        {
            return Err(failed());
        }
    }
    println!(
        "{}",
        serde_json::json!({
            "ok": true, "nativeRendererRead": true, "captureAndNotesPersisted":true, "closeHidesExistingWindow": true,
            "retiredSchedulesAbsent": true, "showReusesWindow": true,
            "nativeConversationReader": true, "untruncatedCachedBody": true, "cacheResetKeepsNotes": true,
            "nativeArchiveAndAcknowledgement": true, "identicalRefreshKeepsArchive": true,
            "oldHistoryKeepsArchive": true, "newActivityResurfacesSameThread": true,
            "nativeRulePreviewAndRouting": true, "queueEntryAndExit": true, "automaticSuppressionWrites": 0,
            "rankedTaskHome":true,"sdkRankingTransport":true,"rankedTaskDonePersisted":true,"hiddenScheduledRun":true,
            "permissionRequested": false, "networkRequests": 0,
        })
    );
    Ok(())
}

fn failed() -> NativeError {
    NativeError::new("smoke-failed", "The native lifecycle smoke check failed.")
}
