use super::*;
use crate::code_result::{Agent, Job};
use crate::conversation::{ConversationKind, ConversationReference};
use serde_json::json;
use tempfile::TempDir;

fn snapshot() -> Snapshot {
    Snapshot {
        format_version: 1,
        reminders: vec![],
        workspace: json!({
            "version":1,"state":{"version":3,"activeWorkProfile":{"id":"default","name":"Default"},
            "tasks":[{"id":"task","title":"Owner task","notes":"","status":"open","work":{
                "url":"https://github.com/octo/project/issues/47","reference":{"repo":"octo/project","kind":"pr","number":47}
            }}],
            "work":{"settings":{"codeAgents":[{"id":"reviewer","jobType":"pr-review","name":"Reviewer","instructions":"Read code","model":""}]}},
            "threads":[],"inactiveWorkProfiles":[]}
        }),
    }
}
fn intent() -> Intent {
    Intent {
        run_id: Uuid::new_v4().to_string(),
        profile_id: "default".into(),
        agent_name: "Reviewer".into(),
        started_at: "2026-09-25T01:00:00Z".into(),
        input: Input {
            task_id: "task".into(),
            source: ConversationReference {
                repo: "octo/project".into(),
                kind: ConversationKind::Pr,
                number: 47,
            },
            job: Job::PrReview,
            agent: Agent {
                id: "reviewer".into(),
                instructions: "Read code".into(),
                model: "".into(),
            },
        },
    }
}
fn setup() -> (TempDir, Store, String) {
    let dir = TempDir::new().unwrap();
    let mut store = Store::new(dir.path().into()).unwrap();
    store
        .save(&store.read().unwrap().revision, snapshot())
        .unwrap();
    let generation = store.code_run_context().unwrap().generation;
    (dir, store, generation)
}
fn failed() -> Outcome {
    Outcome::Failed {
        finished_at: "2026-09-25T01:01:00Z".into(),
        error: RunError {
            code: "source_changed".into(),
            message: "Source moved; rerun.".into(),
        },
    }
}
fn result(input: &Input, inspected: bool) -> CodeResult {
    let sha = "a".repeat(40);
    serde_json::from_value(json!({
        "format":"code-review-v1","taskId":input.task_id,
        "answer":{"job":"pr-review","findings":[],"conclusion":{
            "status":if inspected {"partial-no-approval"} else {"not-inspected"},
            "summary":if inspected {crate::code_result::PARTIAL} else {crate::code_result::NOT_INSPECTED}}},
        "source":{"reference":input.source,"url":"https://github.com/octo/project/pull/47","title":"Review",
            "body":"","updatedAt":"2026-09-25T01:00:00Z","state":"open","fingerprint":"a".repeat(64),
            "observedAt":"2026-09-25T01:00:00Z","head":{"repo":"octo/project","sha":sha,"tree":sha},
            "base":null,"baseTip":null,"defaultBranch":null,"draft":false,"merged":false},
        "verifiedAt":"2026-09-25T01:00:00Z","config":{"agentId":input.agent.id,"instructions":input.agent.instructions,
            "modelRequested":input.agent.model,"modelSelection":"sdk-default","fingerprint":"b".repeat(64)},
        "coverage":{"status":"partial","changes":"partial","knownChangedLines":0,"reviewedChangedLines":0,
            "files":{"expected":0,"compared":0,"retained":0,"omitted":0,"incompletePatches":0},
            "warnings":[],"requests":3,"readBytes":10,"contextBytes":100,"toolCalls":1},
        "evidence":if inspected {json!([{"id":"read-1","side":"head","repo":"octo/project","revision":sha,"blob":sha,
            "path":"src/file.ts","startLine":1,"endLine":1,"totalLines":1,"text":"const value = 1;"}])} else {json!([])},
        "changes":[]
    })).unwrap()
}

#[test]
fn durable_start_terminal_immutability_and_snapshot_cas_independence() {
    let (_dir, mut store, generation) = setup();
    let saved = store.read().unwrap();
    let token = store.status().recovery_token;
    let intent = intent();
    let start = store.code_run_start(&generation, intent.clone()).unwrap();
    assert_ne!(store.status().recovery_token, token);
    assert_eq!(store.read().unwrap().revision, saved.revision);
    assert_eq!(store.code_run_context().unwrap().generation, generation);
    assert_eq!(
        store
            .code_run_read("default", "task", None, false)
            .unwrap()
            .runs[0],
        start
    );
    assert!(matches!(
        store
            .code_run_read("default", "task", None, false)
            .unwrap()
            .runs[0]
            .outcome,
        Outcome::Running
    ));
    let token = store.status().recovery_token;
    let terminal = store
        .code_run_update(&generation, intent.clone(), failed())
        .unwrap();
    assert_ne!(store.status().recovery_token, token);
    assert_eq!(
        store
            .code_run_update(&generation, intent.clone(), failed())
            .unwrap(),
        terminal
    );
    assert_eq!(
        store
            .code_run_update(&generation, intent.clone(), interrupted())
            .unwrap_err()
            .code,
        "code-run-conflict"
    );
    let mut edited = snapshot();
    edited.workspace["state"]["tasks"][0]["notes"] = json!("edit");
    edited.workspace["state"]["tasks"][0]["status"] = json!("done");
    store.save(&saved.revision, edited).unwrap();
    assert_eq!(store.code_run_context().unwrap().generation, generation);
    assert_eq!(
        store
            .code_run_read("default", "task", None, false)
            .unwrap()
            .runs,
        vec![terminal]
    );
}

#[test]
fn owner_source_config_validation_and_alias_paging_by_append_sequence() {
    let (_dir, mut store, generation) = setup();
    for field in ["profile", "task", "source", "agent", "name"] {
        let mut invalid = intent();
        match field {
            "profile" => invalid.profile_id = "other".into(),
            "task" => invalid.input.task_id = "missing".into(),
            "source" => invalid.input.source.number = 48,
            "agent" => invalid.input.agent.instructions = "different".into(),
            _ => invalid.agent_name = "changed".into(),
        }
        assert!(store.code_run_start(&generation, invalid).is_err());
    }
    for n in 0..13 {
        let mut value = intent();
        value.started_at = format!("2026-09-{:02}T01:00:00Z", 25 - n);
        store.code_run_start(&generation, value.clone()).unwrap();
        store.code_run_update(&generation, value, failed()).unwrap();
    }
    let page = store.code_run_read("default", "task", None, false).unwrap();
    assert_eq!(page.runs.len(), 10);
    assert_eq!(page.runs[0].sequence, 13);
    assert_eq!(page.before, Some(4));
    let second = store
        .code_run_read("default", "task", page.before, false)
        .unwrap();
    assert_eq!(second.runs.len(), 3);
    assert!(second.before.is_none());
    let mut changed = snapshot();
    changed.workspace["state"]["tasks"][0]["id"] = json!("merged");
    changed.workspace["state"]["tasks"][0]["assessmentTaskIds"] = json!(["task"]);
    store
        .save(&store.read().unwrap().revision, changed)
        .unwrap();
    assert_eq!(
        store
            .code_run_read("default", "merged", None, false)
            .unwrap()
            .runs
            .len(),
        10
    );
    assert!(store.code_run_read("default", "task", None, false).is_err());
}

#[test]
fn relaunch_marks_abandoned_once_and_restore_fences_late_results_durably() {
    let (dir, mut store, generation) = setup();
    let value = intent();
    store.code_run_start(&generation, value.clone()).unwrap();
    let backup = store
        .create_backup(&store.read().unwrap().revision)
        .unwrap();
    drop(store);
    let mut store = Store::new(dir.path().into()).unwrap();
    let reopened = store.code_run_context().unwrap().generation;
    assert_ne!(reopened, generation);
    assert!(matches!(
        store
            .code_run_read("default", "task", None, false)
            .unwrap()
            .runs[0]
            .outcome,
        Outcome::Interrupted { .. }
    ));
    let fresh = intent();
    store.code_run_start(&reopened, fresh.clone()).unwrap();
    store.code_run_context().unwrap();
    assert!(matches!(
        store
            .code_run_read("default", "task", None, false)
            .unwrap()
            .runs[0]
            .outcome,
        Outcome::Running
    ));
    let stale_token = store.status().recovery_token;
    store
        .code_run_update(&reopened, fresh.clone(), failed())
        .unwrap();
    assert!(store.recover(&backup.id, &stale_token).is_err());
    store
        .recover(&backup.id, &store.status().recovery_token)
        .unwrap();
    let restored = store.code_run_context().unwrap().generation;
    assert_ne!(restored, reopened);
    assert!(store.code_run_start(&reopened, intent()).is_err());
    // Same run ID from the restored backup cannot receive the late result.
    let late = store
        .code_run_update(&generation, value.clone(), failed())
        .unwrap();
    assert!(late.quarantined);
    let current = store.code_run_read("default", "task", None, false).unwrap();
    assert_eq!(current.runs.len(), 1);
    assert!(matches!(
        current.runs[0].outcome,
        Outcome::Interrupted { .. }
    ));
    let quarantine = store.code_run_read("unused", "unused", None, true).unwrap();
    assert_eq!(quarantine.runs, vec![late]);
    store.code_run_start(&restored, intent()).unwrap();
    let exported: serde_json::Value =
        serde_json::from_str(&store.export_json(&store.read().unwrap().revision).unwrap()).unwrap();
    assert_eq!(exported["codeRuns"].as_array().unwrap().len(), 3);
    let backup = store
        .create_backup(&store.read().unwrap().revision)
        .unwrap();
    store
        .recover(&backup.id, &store.status().recovery_token)
        .unwrap();
    assert_eq!(
        store
            .code_run_read("unused", "unused", None, true)
            .unwrap()
            .runs
            .len(),
        1
    );
}

#[test]
fn service_owned_conclusion_provenance_and_successful_result_survive_relaunch() {
    for inspected in [false, true] {
        let (dir, mut store, generation) = setup();
        let value = intent();
        store.code_run_start(&generation, value.clone()).unwrap();
        let result = result(&value.input, inspected);
        let mut forged = serde_json::to_value(&result).unwrap();
        forged["answer"]["conclusion"]["summary"] = json!("Safe to merge");
        let forged: CodeResult = serde_json::from_value(forged).unwrap();
        assert!(store
            .code_run_update(
                &generation,
                value.clone(),
                Outcome::Partial {
                    finished_at: "2026-09-25T01:02:00Z".into(),
                    result: forged
                }
            )
            .is_err());
        let outcome = if inspected {
            Outcome::Partial {
                finished_at: "2026-09-25T01:02:00Z".into(),
                result,
            }
        } else {
            Outcome::NotInspected {
                finished_at: "2026-09-25T01:02:00Z".into(),
                result,
            }
        };
        let saved = store.code_run_update(&generation, value, outcome).unwrap();
        drop(store);
        let mut store = Store::new(dir.path().into()).unwrap();
        assert_eq!(
            store
                .code_run_read("default", "task", None, false)
                .unwrap()
                .runs,
            vec![saved]
        );
    }
}

#[test]
fn failed_history_write_does_not_block_notes_done_or_new_runs() {
    let (_dir, mut store, generation) = setup();
    let value = intent();
    store.code_run_start(&generation, value.clone()).unwrap();
    store.connection().unwrap().execute_batch("CREATE TRIGGER fail_code_update BEFORE UPDATE ON code_runs BEGIN SELECT RAISE(FAIL,'disk failure'); END;").unwrap();
    assert!(store
        .code_run_update(&generation, value.clone(), failed())
        .is_err());
    let mut edit = snapshot();
    edit.workspace["state"]["tasks"][0]["notes"] = json!("Still saved");
    edit.workspace["state"]["tasks"][0]["status"] = json!("done");
    store.save(&store.read().unwrap().revision, edit).unwrap();
    store
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_code_update;")
        .unwrap();
    store.code_run_start(&generation, intent()).unwrap();
    store.code_run_update(&generation, value, failed()).unwrap();
    assert_eq!(
        store
            .code_run_read("default", "task", None, false)
            .unwrap()
            .runs
            .len(),
        2
    );
}

#[test]
fn history_above_snapshot_limit_and_actual_export_limit_include_every_row() {
    let (_dir, mut store, generation) = setup();
    let saved = store.read().unwrap();
    let mut connection = store.connection().unwrap();
    let tx = connection.transaction().unwrap();
    for _ in 0..900 {
        let mut value = intent();
        value.input.agent.instructions = "\"\\\n".repeat(5000);
        write(
            &tx,
            Run {
                generation: generation.clone(),
                sequence: 0,
                quarantined: false,
                intent: value,
                outcome: failed(),
            },
        )
        .unwrap();
    }
    tx.commit().unwrap();
    let bytes: i64 = connection
        .query_row("SELECT sum(length(payload)) FROM code_runs", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(bytes > 8 * 1024 * 1024);
    let export = store.export_json(&saved.revision).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&export).unwrap()["codeRuns"]
            .as_array()
            .unwrap()
            .len(),
        900
    );
    assert!(export.len() > 8 * 1024 * 1024 && export.len() < 64 * 1024 * 1024);
    let backup = store.create_backup(&saved.revision).unwrap();
    let mut edited = snapshot();
    edited.workspace["state"]["tasks"][0]["notes"] =
        json!("History does not consume snapshot capacity");
    edited.workspace["state"]["tasks"][0]["status"] = json!("done");
    let edited = store.save(&saved.revision, edited).unwrap();
    assert_eq!(
        edited.snapshot.unwrap().workspace["state"]["tasks"][0]["status"],
        "done"
    );
    store
        .recover(&backup.id, &store.status().recovery_token)
        .unwrap();
    assert_eq!(
        store
            .code_run_read("default", "task", None, false)
            .unwrap()
            .runs
            .len(),
        10
    );
    let mut connection = store.connection().unwrap();
    let tx = connection.transaction().unwrap();
    for _ in 0..1400 {
        let mut value = intent();
        value.input.agent.instructions = "\"\\\n".repeat(5000);
        write(
            &tx,
            Run {
                generation: generation.clone(),
                sequence: 0,
                quarantined: true,
                intent: value,
                outcome: failed(),
            },
        )
        .unwrap();
    }
    tx.commit().unwrap();
    assert_eq!(
        store
            .export_json(&store.read().unwrap().revision)
            .unwrap_err()
            .code,
        "export-too-large"
    );
    assert_eq!(
        store
            .code_run_read("unused", "unused", None, true)
            .unwrap()
            .runs
            .len(),
        10
    );
}

#[test]
fn duplicate_start_and_terminal_retries_preserve_identity_and_sequence() {
    let (_dir, mut store, generation) = setup();
    let value = intent();
    let started = store.code_run_start(&generation, value.clone()).unwrap();
    assert_eq!(store.code_run_start(&generation, value.clone()).unwrap(), started);
    let mut conflicting = value.clone();
    conflicting.started_at = "2026-09-25T01:01:00Z".into();
    assert_eq!(
        store.code_run_start(&generation, conflicting.clone()).unwrap_err().code,
        "code-run-conflict"
    );
    assert!(store.code_run_update(&generation, conflicting, failed()).is_err());
    assert_eq!(
        store.code_run_update(&generation, intent(), failed()).unwrap_err().code,
        "code-run-missing"
    );
    assert!(store.code_run_update(&generation, value.clone(), Outcome::Running).is_err());
    let cancelling = store.code_run_update(&generation, value.clone(), Outcome::Cancelling).unwrap();
    assert_eq!(cancelling.sequence, started.sequence);
    let cancelled = Outcome::Cancelled {
        finished_at: "2026-09-25T01:02:00Z".into(),
        error: RunError { code: "cancelled".into(), message: "Cancelled after cleanup.".into() },
    };
    let terminal = store.code_run_update(&generation, value.clone(), cancelled.clone()).unwrap();
    assert_eq!(terminal.sequence, started.sequence);
    assert_eq!(store.code_run_update(&generation, value.clone(), cancelled).unwrap(), terminal);
    assert_eq!(store.code_run_start(&generation, value).unwrap_err().code, "code-run-conflict");
    assert_eq!(store.code_run_read("default", "task", None, false).unwrap().runs, vec![terminal]);
}

#[test]
fn source_kind_and_profile_boundaries_require_saved_configuration() {
    let (_dir, mut store, generation) = setup();
    let mut legacy = snapshot();
    legacy.workspace["state"]["tasks"][0]["work"].as_object_mut().unwrap().remove("reference");
    store.save(&store.read().unwrap().revision, legacy.clone()).unwrap();
    assert!(store.code_run_start(&generation, intent()).is_err());
    legacy.workspace["state"]["tasks"][0]["work"]["url"] = json!("https://github.com/octo/project/pull/47");
    store.save(&store.read().unwrap().revision, legacy).unwrap();
    store.code_run_start(&generation, intent()).unwrap();
    let mut wrong_kind = intent();
    wrong_kind.input.source.kind = ConversationKind::Issue;
    assert!(store.code_run_start(&generation, wrong_kind).is_err());

    let mut parked = snapshot();
    parked.workspace["state"]["inactiveWorkProfiles"] = json!([{
        "id": "other", "name": "Other",
        "tasks": parked.workspace["state"]["tasks"],
        "work": parked.workspace["state"]["work"]
    }]);
    store.save(&store.read().unwrap().revision, parked).unwrap();
    let mut other = intent();
    other.profile_id = "other".into();
    let saved = store.code_run_start(&generation, other).unwrap();
    assert_eq!(store.code_run_read("other", "task", None, false).unwrap().runs, vec![saved]);
    assert_eq!(store.code_run_read("default", "task", None, false).unwrap().runs.len(), 1);
    for changed in ["id", "model"] {
        let mut wrong_agent = intent();
        if changed == "id" {
            wrong_agent.input.agent.id = "another-agent".into();
        } else {
            wrong_agent.input.agent.model = "another-model".into();
        }
        assert_eq!(store.code_run_start(&generation, wrong_agent).unwrap_err().code, "code-run-settings");
    }
}

#[test]
fn corrupt_history_fails_read_and_export_without_blocking_notes() {
    for checksum in [false, true] {
        let (_dir, mut store, generation) = setup();
        let value = intent();
        let run = store.code_run_start(&generation, value.clone()).unwrap();
        store.code_run_update(&generation, value, failed()).unwrap();
        let mut invalid = serde_json::to_value(&run).unwrap();
        invalid["intent"]["startedAt"] = json!("not-a-timestamp");
        let payload = invalid.to_string();
        store.connection().unwrap().execute(
            "UPDATE code_runs SET payload=?,checksum=?",
            params![payload, if checksum { digest(payload.as_bytes()) } else { "bad-checksum".into() }],
        ).unwrap();
        let error = store.code_run_read("default", "task", None, false).err().unwrap();
        assert_eq!(error.code, "storage-corrupt");
        assert_eq!(
            store.export_json(&store.read().unwrap().revision).unwrap_err().code,
            "storage-corrupt"
        );
        let mut edited = snapshot();
        edited.workspace["state"]["tasks"][0]["notes"] = json!("Independent task edit");
        store.save(&store.read().unwrap().revision, edited).unwrap();
    }
}

#[test]
fn recovery_fences_start_and_terminal_updates_without_changing_snapshot_cas() {
    let (_dir, mut store, generation) = setup();
    let before = store.status();
    let backup = store.create_backup(before.revision.as_deref().unwrap()).unwrap();
    let value = intent();
    store.code_run_start(&generation, value.clone()).unwrap();
    assert_eq!(
        store.recover_at_revision(&backup.id, &before.recovery_token, before.revision.as_deref()).unwrap_err().code,
        "revision-conflict"
    );
    let running = store.status();
    store.code_run_update(&generation, value.clone(), failed()).unwrap();
    assert_eq!(
        store.recover_at_revision(&backup.id, &running.recovery_token, running.revision.as_deref()).unwrap_err().code,
        "revision-conflict"
    );
    let current = store.status();
    store.recover_at_revision(&backup.id, &current.recovery_token, current.revision.as_deref()).unwrap();
    assert_eq!(store.code_run_start(&generation, intent()).unwrap_err().code, "workspace-replaced");
    assert!(store.code_run_update(&generation, value.clone(), Outcome::Cancelling).is_err());
    let late = store.code_run_update(&generation, value.clone(), failed()).unwrap();
    assert!(late.quarantined);
    assert_eq!(late.generation, generation);
    assert_eq!(late.intent, value);
    assert_eq!(store.code_run_update(&generation, value.clone(), failed()).unwrap(), late);
    assert_eq!(
        store.code_run_update(&generation, value, interrupted()).unwrap_err().code,
        "code-run-conflict"
    );
    assert!(store.code_run_read("default", "task", None, false).unwrap().runs.is_empty());
    assert_eq!(store.code_run_read("unused", "unused", None, true).unwrap().runs, vec![late]);
}

#[test]
fn startup_checks_every_sql_identity_before_interrupting_any_run() {
    for (column, replacement) in [
        ("sequence", json!(999)), ("generation", json!(Uuid::new_v4().to_string())),
        ("run_id", json!(Uuid::new_v4().to_string())), ("profile_id", json!("other")),
        ("task_id", json!("other-task")), ("quarantined", json!(1)), ("terminal", json!(0)),
    ] {
        let (dir, mut store, generation) = setup();
        let running = store.code_run_start(&generation, intent()).unwrap();
        let value = intent();
        store.code_run_start(&generation, value.clone()).unwrap();
        let terminal = store.code_run_update(&generation, value, failed()).unwrap();
        let connection = store.connection().unwrap();
        let before: Vec<String> = connection.prepare("SELECT payload FROM code_runs ORDER BY sequence")
            .unwrap().query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        let replacement = if let Some(n) = replacement.as_i64() {
            rusqlite::types::Value::Integer(n)
        } else {
            rusqlite::types::Value::Text(replacement.as_str().unwrap().into())
        };
        connection.execute(
            &format!("UPDATE code_runs SET {column}=? WHERE sequence=?"),
            params![replacement, terminal.sequence],
        ).unwrap();
        drop(connection);
        drop(store);
        let mut store = Store::new(dir.path().into()).unwrap();
        assert_eq!(store.code_run_context().err().unwrap().code, "storage-corrupt", "{column}");
        let connection = store.connection().unwrap();
        let after: Vec<String> = connection.prepare("SELECT payload FROM code_runs ORDER BY sequence")
            .unwrap().query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(before, after, "{column}: initialization must roll back all interruptions");
        assert_eq!(connection.query_row("SELECT terminal FROM code_runs WHERE sequence=?",
            [running.sequence], |row| row.get::<_, i64>(0)).unwrap(), 0);
        store.create_backup(&store.read().unwrap().revision).unwrap();
        store.export_raw().unwrap();
    }
}

#[test]
fn selected_rows_reject_column_corruption_in_pages_lookup_and_export() {
    for column in ["sequence", "generation", "run_id", "profile_id", "task_id", "quarantined", "terminal"] {
        let (_dir, mut store, generation) = setup();
        let mut workspace = snapshot();
        workspace.workspace["state"]["tasks"].as_array_mut().unwrap().push(json!({"id":"other-task"}));
        workspace.workspace["state"]["inactiveWorkProfiles"] = json!([{
            "id":"other", "tasks":[{"id":"task"}], "work":workspace.workspace["state"]["work"]
        }]);
        store.save(&store.read().unwrap().revision, workspace).unwrap();
        let value = intent();
        store.code_run_start(&generation, value.clone()).unwrap();
        let terminal = store.code_run_update(&generation, value.clone(), failed()).unwrap();
        let other_id = Uuid::new_v4().to_string();
        let replacement = match column {
            "sequence" => rusqlite::types::Value::Integer(999),
            "quarantined" => rusqlite::types::Value::Integer(1),
            "terminal" => rusqlite::types::Value::Integer(0),
            "profile_id" => rusqlite::types::Value::Text("other".into()),
            "task_id" => rusqlite::types::Value::Text("other-task".into()),
            _ => rusqlite::types::Value::Text(other_id.clone()),
        };
        store.connection().unwrap().execute(
            &format!("UPDATE code_runs SET {column}=? WHERE sequence=?"),
            params![replacement, terminal.sequence],
        ).unwrap();
        let error = store.code_run_read(
            if column == "profile_id" { "other" } else { "default" },
            if column == "task_id" { "other-task" } else { "task" },
            None, column == "quarantined",
        ).err().unwrap();
        assert_eq!(error.code, "storage-corrupt", "{column}");
        assert_eq!(store.export_json(&store.read().unwrap().revision).unwrap_err().code, "storage-corrupt", "{column}");
        if column == "run_id" {
            let mut lookup = value.clone();
            lookup.run_id = other_id;
            assert_eq!(store.code_run_update(&generation, lookup, failed()).unwrap_err().code, "storage-corrupt");
        }
        if column == "terminal" {
            assert_eq!(store.code_run_update(&generation, value, interrupted()).unwrap_err().code, "storage-corrupt");
        }
    }
}

fn implementation_result(input: &Input) -> serde_json::Value {
    let mut value = serde_json::to_value(result(input, true)).unwrap();
    value["answer"] = json!({
        "job":"implementation-assessment", "summary":"Inspect the value.", "uncertainty":"Partial coverage.",
        "findings":[], "nextStep":{"text":"Check input validation.", "evidence":[{
            "kind":"code", "readId":"read-1", "side":"head", "path":"src/file.ts",
            "startLine":1, "endLine":1, "quote":"const value = 1;"
        }]}
    });
    value
}

fn assert_result_rejected(store: &mut Store, generation: &str, intent: &Intent, result: serde_json::Value) {
    let outcome = serde_json::from_value(json!({
        "status":"partial", "finishedAt":"2026-09-25T01:02:00Z", "result":result,
    })).map_err(|_| NativeError::invalid());
    let error = outcome.and_then(|outcome| store.code_run_update(generation, intent.clone(), outcome)).unwrap_err();
    assert_eq!(error.code, "invalid-input");
    let saved = store.code_run_read("default", "task", None, false).unwrap();
    assert_eq!(saved.runs.len(), 1);
    assert_eq!(saved.runs[0].outcome, Outcome::Running);
}

#[test]
fn every_shared_nested_invalid_result_is_rejected_before_commit() {
    let cases: serde_json::Value = serde_json::from_str(include_str!("../../tests/code-result-invalid.json")).unwrap();
    for implementation in [false, true] {
        let (_dir, mut store, generation) = setup();
        let mut value = intent();
        let baseline = if implementation {
            value.input.job = Job::ImplementationAssessment;
            value.input.source.kind = ConversationKind::Issue;
            let mut workspace = snapshot();
            workspace.workspace["state"]["tasks"][0]["work"]["reference"]["kind"] = json!("issue");
            workspace.workspace["state"]["work"]["settings"]["codeAgents"][0]["jobType"] = json!("implementation-assessment");
            store.save(&store.read().unwrap().revision, workspace).unwrap();
            implementation_result(&value.input)
        } else {
            serde_json::to_value(result(&value.input, true)).unwrap()
        };
        serde_json::from_value::<CodeResult>(baseline.clone()).unwrap().validate(&value.input).unwrap();
        store.code_run_start(&generation, value.clone()).unwrap();
        for case in cases[if implementation { "implementation" } else { "common" }].as_array().unwrap() {
            let mut invalid = baseline.clone();
            let replacement = match case["repeat"].as_u64() {
                Some(count) => json!(case["value"].as_str().unwrap().repeat(count as usize)),
                None => case["value"].clone(),
            };
            *invalid.pointer_mut(case["path"].as_str().unwrap()).unwrap() = replacement;
            assert_result_rejected(&mut store, &generation, &value, invalid);
        }
        for path in cases["requiredNullable"].as_array().unwrap() {
            let (parent, key) = path.as_str().unwrap().rsplit_once('/').unwrap();
            let mut invalid = baseline.clone();
            invalid.pointer_mut(parent).unwrap().as_object_mut().unwrap().remove(key);
            assert_result_rejected(&mut store, &generation, &value, invalid);
        }
        for (path, entry, count) in [
            ("/evidence", baseline["evidence"][0].clone(), 25),
            ("/changes", json!({"filename":"file", "status":"added", "additions":1, "deletions":0, "patchComplete":false}), 101),
        ] {
            let mut invalid = baseline.clone();
            *invalid.pointer_mut(path).unwrap() = json!(vec![entry; count]);
            assert_result_rejected(&mut store, &generation, &value, invalid);
        }
        if implementation {
            let finding = json!({"title":"Finding", "severity":"low", "rationale":"Reason",
                "evidence":[{"kind":"source", "quote":"Review"}]});
            for (path, entry, count) in [
                ("/answer/findings", finding.clone(), 21),
                ("/answer/nextStep/evidence", baseline["answer"]["nextStep"]["evidence"][0].clone(), 9),
            ] {
                let mut invalid = baseline.clone();
                *invalid.pointer_mut(path).unwrap() = json!(vec![entry; count]);
                assert_result_rejected(&mut store, &generation, &value, invalid);
            }
            for (field, length) in [("title", 241), ("rationale", 2001)] {
                let mut invalid = baseline.clone();
                invalid["answer"]["findings"] = json!([finding]);
                invalid["answer"]["findings"][0][field] = json!("x".repeat(length));
                assert_result_rejected(&mut store, &generation, &value, invalid);
            }
            let mut invalid = baseline.clone();
            invalid["evidence"][0]["id"] = json!("read-0");
            invalid["answer"]["nextStep"]["evidence"][0]["readId"] = json!("read-0");
            assert_result_rejected(&mut store, &generation, &value, invalid);
            let mut invalid = baseline.clone();
            invalid["evidence"][0]["text"] = json!("x".repeat(4001));
            invalid["answer"]["nextStep"]["evidence"][0]["quote"] = json!("x".repeat(4001));
            assert_result_rejected(&mut store, &generation, &value, invalid);
        }
        store.code_run_update(&generation, value, Outcome::Partial {
            finished_at:"2026-09-25T01:02:00Z".into(),
            result:serde_json::from_value(baseline).unwrap(),
        }).unwrap();
    }
}

#[test]
fn run_envelope_uses_reader_compatible_uuid_and_iso_forms() {
    let (_dir, mut store, generation) = setup();
    for id in [
        Uuid::new_v4().simple().to_string(),
        "00000000-0000-4000-0000-000000000000".into(),
        "00000000-0000-9000-8000-000000000000".into(),
    ] {
        let mut value = intent();
        value.run_id = id.clone();
        assert!(store.code_run_start(&generation, value).is_err(), "{id}");
        assert!(store.code_run_update(&id, intent(), failed()).is_err(), "{id}");
    }
    for time in [
        "2026-09-25t01:00:00z", "2026-09-25T01:00:60Z", "2026-02-30T01:00:00Z",
        "2026-09-25T01:00:00+24:00", "2026-09-25T01:00:00+0000",
    ] {
        let mut value = intent();
        value.started_at = time.into();
        assert!(store.code_run_start(&generation, value).is_err(), "{time}");
    }
    assert!(store.code_run_read("default", "task", None, false).unwrap().runs.is_empty());
    for time in [
        "2026-09-25T01:00Z", "2026-09-25T01:00:00Z", "2026-09-25T01:00:00-07:00",
        "2026-09-25T01:00:00.123456789012345678901234567890123Z",
    ] {
        let mut value = intent();
        value.started_at = time.into();
        store.code_run_start(&generation, value.clone()).unwrap();
        let outcome = Outcome::Cancelled {
            finished_at: "2026-09-25t01:00:00z".into(),
            error: RunError { code:"cancelled".into(), message:"Stopped.".into() },
        };
        assert!(store.code_run_update(&generation, value.clone(), outcome).is_err());
        store.code_run_update(&generation, value, failed()).unwrap();
    }
}
