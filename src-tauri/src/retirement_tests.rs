use crate::{
    error::NativeError,
    model::{digest, DailySchedule, ReminderSchedule, Snapshot},
    storage::Store,
    NativeState,
};
use rusqlite::Connection;
use serde_json::json;
use std::fs;
use tempfile::TempDir;

fn legacy_snapshot() -> Snapshot {
    Snapshot {
        format_version: 1,
        workspace: json!({
            "version": 1,
            "state": {
                "version": 2,
                "routines": [{"id": "routine-1", "notes": "Keep this legacy note"}],
                "activeId": "routine-1"
            }
        }),
        reminders: vec![ReminderSchedule {
            id: "routine-1".into(),
            occurrence_id: "routine-1:2020-01-01T17:00:00Z".into(),
            due_at: "2020-01-01T17:00:00Z".into(),
            time_zone: "America/Los_Angeles".into(),
            snoozed_until: None,
            daily: Some(DailySchedule {
                time: "09:00".into(),
                time_zone: "America/Los_Angeles".into(),
            }),
        }],
    }
}

fn migrated_snapshot(note: &str) -> Snapshot {
    Snapshot {
        format_version: 1,
        workspace: json!({
            "version": 1,
            "state": {"version": 3, "tasks": [{"id": "task-1", "notes": note}]}
        }),
        reminders: vec![],
    }
}

fn saved_legacy_store() -> (TempDir, Store, String) {
    let directory = TempDir::new().unwrap();
    let mut store = Store::new(directory.path().to_owned()).unwrap();
    let saved = store
        .save(&store.read().unwrap().revision, legacy_snapshot())
        .unwrap();
    (directory, store, saved.revision)
}

#[test]
fn native_runtime_has_no_notification_or_scheduler_entry_points() {
    let runtime = include_str!("lib.rs").split("#[cfg(test)]").next().unwrap();
    for retired in [
        "mod reminders",
        "mod activity",
        "SystemNotifications",
        "reconcile_reminders",
        "reminders_status",
        "reminders_request_permission",
        "reminders_retry",
        "workspace://tick",
        "wake_scheduler",
    ] {
        assert!(!runtime.contains(retired), "Retired entry point: {retired}");
    }
}

#[test]
fn due_legacy_snapshot_is_inert_on_fresh_startup_before_frontend_migration() {
    let (directory, store, revision) = saved_legacy_store();
    let original = fs::read(store.path()).unwrap();
    drop(store);
    for _ in 0..2 {
        let state = NativeState::new(Store::new(directory.path().to_owned()));
        let guard = state.store.lock().unwrap();
        let store = guard.as_ref().unwrap();
        let saved = store.read().unwrap();
        assert_eq!(saved.revision, revision);
        assert_eq!(saved.snapshot.unwrap().reminders.len(), 1);
        let deliveries: i64 = store
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM reminder_deliveries", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(deliveries, 0);
        assert_eq!(fs::read(store.path()).unwrap(), original);
    }
    native_runtime_has_no_notification_or_scheduler_entry_points();
}

#[test]
fn startup_with_unavailable_or_corrupt_storage_never_requires_scheduler_cleanup() {
    let state = NativeState::new(Err(NativeError::new("io", "Storage unavailable")));
    assert_eq!(
        state.store.lock().unwrap().as_ref().err().unwrap().code,
        "io"
    );

    let (directory, store, _) = saved_legacy_store();
    let path = store.path();
    drop(store);
    fs::write(&path, b"damaged legacy database").unwrap();
    let state = NativeState::new(Store::new(directory.path().to_owned()));
    let guard = state.store.lock().unwrap();
    assert_eq!(
        guard.as_ref().unwrap().read().unwrap_err().code,
        "storage-corrupt"
    );
    assert_eq!(fs::read(path).unwrap(), b"damaged legacy database");
    native_runtime_has_no_notification_or_scheduler_entry_points();
}

#[test]
fn v3_rejects_every_nonempty_schedule_without_changing_legacy_state() {
    let (_directory, mut store, revision) = saved_legacy_store();
    let original = fs::read(store.path()).unwrap();
    for version in [3, 4] {
        let mut snapshot = legacy_snapshot();
        snapshot.workspace["state"]["version"] = json!(version);
        assert_eq!(
            store.save(&revision, snapshot).unwrap_err().code,
            "invalid-input"
        );
        assert_eq!(store.read().unwrap().revision, revision);
        assert_eq!(fs::read(store.path()).unwrap(), original);
    }
    assert_eq!(store.list_backups().unwrap().len(), 1);
}

#[test]
fn migration_commits_state_empty_schedule_checksum_and_revision_together() {
    let (_directory, mut store, revision) = saved_legacy_store();
    let snapshot = migrated_snapshot("Preserved task");
    let expected_json = snapshot.encode().unwrap();
    let saved = store.save(&revision, snapshot).unwrap();
    assert_ne!(saved.revision, revision);
    let connection = store.connection().unwrap();
    let persisted: (String, String, String, String) = connection
        .query_row(
            "SELECT revision, snapshot, checksum, saved_at FROM workspace WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(persisted.0, saved.revision);
    assert_eq!(persisted.1, expected_json);
    assert_eq!(persisted.2, digest(expected_json.as_bytes()));
    assert_eq!(persisted.3, saved.saved_at.unwrap());
    assert!(store.read().unwrap().snapshot.unwrap().reminders.is_empty());
    assert_eq!(
        store
            .save(&revision, migrated_snapshot("Stale"))
            .unwrap_err()
            .code,
        "revision-conflict"
    );
}

#[test]
fn failed_migration_keeps_both_legacy_state_and_schedule() {
    let (_directory, mut store, revision) = saved_legacy_store();
    store
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_migration BEFORE UPDATE ON workspace
             BEGIN SELECT RAISE(ABORT, 'Injected storage failure'); END;",
        )
        .unwrap();
    assert!(store
        .save(&revision, migrated_snapshot("Not saved"))
        .is_err());
    let saved = store.read().unwrap();
    assert_eq!(saved.revision, revision);
    assert_eq!(
        saved.snapshot.unwrap().encode().unwrap(),
        legacy_snapshot().encode().unwrap()
    );
    native_runtime_has_no_notification_or_scheduler_entry_points();
}

#[test]
fn immutable_legacy_backup_survives_later_saves_recovery_and_remigration() {
    let (directory, mut store, revision) = saved_legacy_store();
    let saved = store.save(&revision, migrated_snapshot("First")).unwrap();
    let backup = store
        .list_backups()
        .unwrap()
        .into_iter()
        .find(|backup| backup.id != "latest")
        .expect("Migration must preserve a non-rotating legacy backup");
    let path = directory
        .path()
        .join("backups")
        .join(format!("{}.sqlite3", backup.id));
    let bytes = fs::read(&path).unwrap();
    assert_eq!(store.read_backup(&backup.id).unwrap().revision, revision);
    let saved = store
        .save(&saved.revision, migrated_snapshot("Second"))
        .unwrap();
    store
        .save(&saved.revision, migrated_snapshot("Third"))
        .unwrap();
    assert_eq!(
        store
            .read_backup("latest")
            .unwrap()
            .snapshot
            .unwrap()
            .state_version(),
        Some(3)
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);

    // Recovery preserves the legacy data, but cannot restore executable delivery code.
    let restored = store
        .recover(&backup.id, &store.status().recovery_token)
        .unwrap();
    assert_ne!(restored.revision, revision);
    assert_eq!(
        restored.snapshot.unwrap().encode().unwrap(),
        legacy_snapshot().encode().unwrap()
    );
    drop(store);
    let state = NativeState::new(Store::new(directory.path().to_owned()));
    let mut guard = state.store.lock().unwrap();
    let store = guard.as_mut().unwrap();
    let delivery_count: i64 = store
        .connection()
        .unwrap()
        .query_row("SELECT count(*) FROM reminder_deliveries", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(delivery_count, 0);
    let revision = store.read().unwrap().revision;
    store
        .save(&revision, migrated_snapshot("Migrated again"))
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(
        store
            .read_backup(&backup.id)
            .unwrap()
            .snapshot
            .unwrap()
            .state_version(),
        Some(2)
    );
    native_runtime_has_no_notification_or_scheduler_entry_points();
}

#[test]
fn migration_reuses_explicit_immutable_backup_of_the_same_revision() {
    let (directory, store, revision) = saved_legacy_store();
    let backup = store.create_backup(&revision).unwrap();
    let path = directory
        .path()
        .join("backups")
        .join(format!("{}.sqlite3", backup.id));
    let bytes = fs::read(&path).unwrap();
    drop(store);
    let mut store = Store::new(directory.path().to_owned()).unwrap();
    let saved = store.save(&revision, migrated_snapshot("First")).unwrap();
    store
        .save(&saved.revision, migrated_snapshot("Second"))
        .unwrap();
    let immutable: Vec<_> = store
        .list_backups()
        .unwrap()
        .into_iter()
        .filter(|backup| backup.id != "latest")
        .collect();
    assert_eq!(immutable.len(), 1);
    assert_eq!(immutable[0].id, backup.id);
    assert_eq!(fs::read(path).unwrap(), bytes);
    assert_eq!(store.read_backup(&backup.id).unwrap().revision, revision);
}

#[test]
fn migration_does_not_reuse_a_corrupt_immutable_backup() {
    let (directory, mut store, revision) = saved_legacy_store();
    let backup = store.create_backup(&revision).unwrap();
    let path = directory
        .path()
        .join("backups")
        .join(format!("{}.sqlite3", backup.id));
    fs::write(&path, b"damaged backup").unwrap();
    store.save(&revision, migrated_snapshot("First")).unwrap();
    let replacement = store
        .list_backups()
        .unwrap()
        .into_iter()
        .find(|candidate| candidate.id != "latest" && candidate.id != backup.id)
        .expect("A damaged copy does not satisfy migration backup protection");
    assert_eq!(fs::read(path).unwrap(), b"damaged backup");
    assert_eq!(
        store.read_backup(&replacement.id).unwrap().revision,
        revision
    );
}

#[test]
fn corrupt_storage_recovery_of_legacy_backup_stays_inert_on_relaunch() {
    let (directory, mut store, revision) = saved_legacy_store();
    let backup = store.create_backup(&revision).unwrap();
    fs::write(store.path(), b"damaged").unwrap();
    store
        .recover(&backup.id, &store.status().recovery_token)
        .unwrap();
    drop(store);
    let state = NativeState::new(Store::new(directory.path().to_owned()));
    let guard = state.store.lock().unwrap();
    let store = guard.as_ref().unwrap();
    assert_eq!(
        store.read().unwrap().snapshot.unwrap().state_version(),
        Some(2)
    );
    let dispatched: i64 = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM reminder_deliveries WHERE status IN ('dispatching','requested')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(dispatched, 0);
    native_runtime_has_no_notification_or_scheduler_entry_points();
}

#[test]
fn invalid_v3_schedule_on_disk_is_not_silently_accepted() {
    let (_directory, store, _) = saved_legacy_store();
    let mut invalid = legacy_snapshot();
    invalid.workspace["state"]["version"] = json!(3);
    let json = serde_json::to_string(&invalid).unwrap();
    let connection = Connection::open(store.path()).unwrap();
    connection
        .execute(
            "UPDATE workspace SET snapshot=?, checksum=? WHERE id=1",
            rusqlite::params![json, digest(json.as_bytes())],
        )
        .unwrap();
    assert_eq!(store.read().unwrap_err().code, "storage-corrupt");
}

#[test]
fn legacy_schedule_validation_and_normalized_recovery_keys_still_apply() {
    let mut legacy = legacy_snapshot();
    let key = legacy.reminders[0].delivery_key().unwrap();
    legacy.reminders[0].due_at = "2020-01-01T09:00:00-08:00".into();
    assert_eq!(legacy.reminders[0].delivery_key().unwrap(), key);
    assert!(legacy.encode().is_ok());
    legacy.reminders[0].time_zone = "Invalid/Zone".into();
    assert!(legacy.encode().is_err());
}
