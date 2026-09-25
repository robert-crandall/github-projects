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
    store.save(&saved.revision, edited).unwrap();
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
