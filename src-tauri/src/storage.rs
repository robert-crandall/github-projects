use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

const SCHEMA_VERSION: i64 = 1;
const MAX_WORKSPACE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Serialize)]
pub struct StoredWorkspace {
    revision: i64,
    pub state: Option<Value>,
}

#[derive(Default, Clone)]
pub struct ToolSettings {
    pub gh_path: String,
    pub copilot_path: String,
}

pub struct Database {
    connection: Mutex<Connection>,
    pub path: PathBuf,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let existed = path.exists();
        let mut connection = Connection::open(path).map_err(db_error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(db_error)?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(db_error)?;
        if version > SCHEMA_VERSION {
            return Err(
                "This database belongs to a newer GitHub Projects version. I left it unchanged."
                    .into(),
            );
        }
        if version < SCHEMA_VERSION {
            // SQLite's backup API includes committed WAL data, unlike copying the main file.
            if existed {
                let backup = path.with_file_name(format!(
                    "workspace-before-v{SCHEMA_VERSION}-{}.sqlite3",
                    chrono::Utc::now().timestamp_millis()
                ));
                connection.backup("main", &backup, None).map_err(db_error)?;
            }
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            transaction
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS workspace (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                    revision INTEGER NOT NULL CHECK(revision >= 0),
                    state TEXT
                );
                INSERT OR IGNORE INTO workspace VALUES (1, 0, NULL);
                CREATE TABLE IF NOT EXISTS tool_settings (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                    gh_path TEXT NOT NULL,
                    copilot_path TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS notification_delivery (
                    routine_id TEXT NOT NULL,
                    occurrence_id TEXT NOT NULL,
                    delivered_at TEXT,
                    last_attempt_at TEXT,
                    error TEXT,
                    PRIMARY KEY (routine_id, occurrence_id)
                );
                PRAGMA user_version = 1;",
                )
                .map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
        }
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(db_error)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(db_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "Cannot restrict database permissions.")?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
            path: path.into(),
        })
    }

    pub fn load(&self) -> Result<StoredWorkspace, String> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| "Database lock unavailable.")?;
        let (revision, text): (i64, Option<String>) = conn
            .query_row(
                "SELECT revision, state FROM workspace WHERE singleton = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(db_error)?;
        let state = text
            .map(|text| {
                serde_json::from_str(&text).map_err(|_| {
                    "Stored workspace is unreadable. The database has not been replaced."
                        .to_string()
                })
            })
            .transpose()?;
        Ok(StoredWorkspace { revision, state })
    }

    pub fn save(&self, state: Value, expected_revision: i64) -> Result<i64, String> {
        validate_workspace(&state)?;
        let serialized =
            serde_json::to_string(&state).map_err(|_| "Cannot serialize workspace.")?;
        if serialized.len() > MAX_WORKSPACE_BYTES {
            return Err("Workspace exceeds the 16 MB storage limit. Export a backup before reducing history.".into());
        }
        let next = expected_revision
            .checked_add(1)
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or("Invalid workspace revision.")?;
        let mut conn = self
            .connection
            .lock()
            .map_err(|_| "Database lock unavailable.")?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let changed = tx.execute("UPDATE workspace SET revision = ?1, state = ?2 WHERE singleton = 1 AND revision = ?3", params![next, serialized, expected_revision]).map_err(db_error)?;
        if changed != 1 {
            return Err("Workspace conflict: another save changed the database. Reload before saving again; your stored work is unchanged.".into());
        }
        tx.commit().map_err(db_error)?;
        Ok(next)
    }

    pub fn settings(&self) -> Result<ToolSettings, String> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| "Database lock unavailable.")?;
        Ok(conn
            .query_row(
                "SELECT gh_path, copilot_path FROM tool_settings WHERE singleton = 1",
                [],
                |r| {
                    Ok(ToolSettings {
                        gh_path: r.get(0)?,
                        copilot_path: r.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(db_error)?
            .unwrap_or_default())
    }

    pub fn save_settings(&self, settings: &ToolSettings) -> Result<(), String> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| "Database lock unavailable.")?;
        conn.execute("INSERT INTO tool_settings VALUES (1, ?1, ?2) ON CONFLICT(singleton) DO UPDATE SET gh_path = excluded.gh_path, copilot_path = excluded.copilot_path", params![settings.gh_path, settings.copilot_path]).map_err(db_error)?;
        Ok(())
    }

    pub fn delivery_due(
        &self,
        routine: &str,
        occurrence: &str,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<bool, String> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| "Database lock unavailable.")?;
        let entry: Option<(Option<String>, Option<String>)> = conn.query_row("SELECT delivered_at, last_attempt_at FROM notification_delivery WHERE routine_id = ?1 AND occurrence_id = ?2", params![routine, occurrence], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(db_error)?;
        Ok(match entry {
            None => true,
            Some((Some(_), _)) => false,
            Some((None, attempted)) => attempted
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(&t).ok())
                .is_none_or(|t| now.signed_duration_since(t).num_seconds() >= 300),
        })
    }

    pub fn record_delivery(
        &self,
        routine: &str,
        occurrence: &str,
        now: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| "Database lock unavailable.")?;
        conn.execute(
            "INSERT INTO notification_delivery VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(routine_id, occurrence_id) DO UPDATE SET
            delivered_at = COALESCE(notification_delivery.delivered_at, excluded.delivered_at),
            last_attempt_at = excluded.last_attempt_at, error = excluded.error",
            params![
                routine,
                occurrence,
                if error.is_none() { Some(now) } else { None },
                now,
                error
            ],
        )
        .map_err(db_error)?;
        Ok(())
    }

    pub fn notification_error(&self) -> Result<Option<String>, String> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| "Database lock unavailable.")?;
        conn.query_row("SELECT error FROM notification_delivery WHERE error IS NOT NULL AND delivered_at IS NULL ORDER BY last_attempt_at DESC LIMIT 1", [], |r| r.get(0)).optional().map_err(db_error)
    }
}

fn db_error(error: rusqlite::Error) -> String {
    format!("SQLite could not complete this operation: {error}. Existing data has not been reset.")
}

pub fn iso(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| chrono::DateTime::parse_from_rfc3339(text).is_ok())
}

fn string(value: &Value, key: &str) -> bool {
    value[key].is_string()
}

pub fn validate_workspace(state: &Value) -> Result<(), String> {
    let invalid = || "Invalid workspace format. I kept the previous database state.".to_string();
    if state["version"] != 1
        || state
            .get("runtime")
            .is_some_and(|runtime| runtime != "desktop")
        || !iso(&state["clock"])
        || !string(state, "draft")
        || !state["interpretationError"].is_boolean()
        || !state["sync"].is_object()
        || !["items", "captures", "projects", "undo"]
            .iter()
            .all(|key| state[key].is_array())
    {
        return Err(invalid());
    }
    let items = state["items"].as_array().ok_or_else(invalid)?;
    if items.len() > 10000
        || state["undo"]
            .as_array()
            .is_some_and(|undo| undo.len() > 1000)
    {
        return Err(invalid());
    }
    let mut ids = HashSet::new();
    for item in items {
        let Some(id) = item["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 2048)
        else {
            return Err(invalid());
        };
        if !ids.insert(id)
            || !["title", "notes", "nextStep"]
                .iter()
                .all(|key| string(item, key))
            || !["review", "fix", "mention", "task", "routine"]
                .contains(&item["kind"].as_str().unwrap_or(""))
            || !["available", "deferred", "waiting", "completed", "removed"]
                .contains(&item["status"].as_str().unwrap_or(""))
            || !iso(&item["createdAt"])
            || !iso(&item["updatedAt"])
            || !item["sources"].is_array()
            || !valid_steps(&item["steps"])
            || !valid_sleep_and_wake(item)
        {
            return Err(invalid());
        }
        if let Some(routine) = item.get("routine") {
            if !valid_time(routine["time"].as_str().unwrap_or(""))
                || routine.get("timeZone").is_some_and(|zone| {
                    zone.as_str()
                        .and_then(|s| s.parse::<chrono_tz::Tz>().ok())
                        .is_none()
                })
                || !iso(&routine["nextDueAt"])
            {
                return Err(invalid());
            }
            let Some(occurrences) = routine["occurrences"].as_array() else {
                return Err(invalid());
            };
            let mut occurrence_ids = HashSet::new();
            for occurrence in occurrences {
                if !string(occurrence, "id")
                    || !occurrence_ids.insert(occurrence["id"].as_str())
                    || !iso(&occurrence["dueAt"])
                    || !valid_steps(&occurrence["steps"])
                    || !["outstanding", "completed", "skipped", "missed"]
                        .contains(&occurrence["status"].as_str().unwrap_or(""))
                    || ["snoozedUntil", "reminderAt", "finishedAt"]
                        .iter()
                        .any(|key| occurrence.get(key).is_some_and(|v| !iso(v)))
                    || occurrence
                        .get("reminderDismissed")
                        .is_some_and(|v| !v.is_boolean())
                {
                    return Err(invalid());
                }
            }
        }
    }
    if state
        .get("activeId")
        .is_some_and(|id| id.as_str().is_none_or(|id| !ids.contains(id)))
    {
        return Err(invalid());
    }
    for capture in state["captures"].as_array().ok_or_else(invalid)? {
        if !["id", "original", "itemId", "interpretation"]
            .iter()
            .all(|key| string(capture, key))
            || !iso(&capture["createdAt"])
        {
            return Err(invalid());
        }
    }
    for project in state["projects"].as_array().ok_or_else(invalid)? {
        if !["id", "name", "notes"]
            .iter()
            .all(|key| string(project, key))
        {
            return Err(invalid());
        }
    }
    // Older undo records remain compatible; validate the new metadata wherever present.
    for entry in state["undo"].as_array().ok_or_else(invalid)? {
        for key in ["itemsBefore", "itemsAfter"] {
            if let Some(snapshots) = entry.get(key).and_then(Value::as_array) {
                if snapshots.len() > 10000
                    || snapshots.iter().any(|item| !valid_sleep_and_wake(item))
                {
                    return Err(invalid());
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn valid_sleep_and_wake(item: &Value) -> bool {
    item.get("sleep").is_none_or(|sleep| {
        sleep.is_object()
            && item["status"] == "deferred"
            && iso(&sleep["since"])
            && sleep["wakeOnPing"].is_boolean()
    }) && item.get("wake").is_none_or(|wake| {
        wake.is_object()
            && iso(&wake["at"])
            && ["mention", "review-request", "time", "manual"]
                .contains(&wake["reason"].as_str().unwrap_or(""))
    })
}

fn valid_steps(value: &Value) -> bool {
    value.as_array().is_some_and(|steps| {
        steps
            .iter()
            .all(|s| string(s, "id") && string(s, "title") && s.get("doneAt").is_none_or(iso))
    })
}

pub fn valid_time(time: &str) -> bool {
    let bytes = time.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && [0, 1, 3, 4].iter().all(|&i| bytes[i].is_ascii_digit())
        && time[..2].parse::<u8>().is_ok_and(|h| h < 24)
        && time[3..].parse::<u8>().is_ok_and(|m| m < 60)
}

#[cfg(test)]
pub(crate) fn test_state() -> Value {
    serde_json::json!({"version":1,"runtime":"desktop","clock":"2026-09-08T17:00:00Z","items":[],"captures":[],"projects":[],"draft":"","undo":[],"sync":{"status":"ok","lastSuccessAt":"2026-09-08T17:00:00Z"},"interpretationError":false})
}

#[cfg(test)]
mod tests {
    use super::*;
    static DIRECTORY_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn directory() -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/storage-tests")
            .join(format!(
                "{}-{}-{}",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap(),
                DIRECTORY_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn two_database_connections_cannot_overwrite_each_other() {
        let dir = directory();
        let path = dir.join("workspace.sqlite3");
        let first = Database::open(&path).unwrap();
        let second = Database::open(&path).unwrap();
        first.save(test_state(), 0).unwrap();
        let mut newer = test_state();
        newer["draft"] = serde_json::json!("Preserve this capture");
        assert!(second.save(newer.clone(), 0).is_err());
        assert_eq!(second.save(newer.clone(), 1).unwrap(), 2);
        assert_eq!(first.load().unwrap().state.unwrap(), newer);
        drop((first, second));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migration_backs_up_committed_wal_and_rejects_future_versions() {
        let dir = directory();
        let path = dir.join("workspace.sqlite3");
        let old = Connection::open(&path).unwrap();
        old.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES ('preserve');").unwrap();
        let migrated = Database::open(&path).unwrap();
        let backup_path = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("workspace-before-v1")
            })
            .unwrap();
        let backup = Connection::open(backup_path).unwrap();
        assert_eq!(
            backup
                .query_row("SELECT value FROM legacy", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "preserve"
        );
        drop((migrated, backup, old));
        let newer = Connection::open(&path).unwrap();
        newer.execute_batch("PRAGMA user_version=99;").unwrap();
        drop(newer);
        assert!(Database::open(&path).is_err());
        let preserved = Connection::open(&path).unwrap();
        assert_eq!(
            preserved
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            99
        );
        drop(preserved);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_timezone_and_pending_edit_metadata_are_preserved() {
        let dir = directory();
        let db = Database::open(&dir.join("workspace.sqlite3")).unwrap();
        let mut state = test_state();
        state["items"] = serde_json::json!([{
            "id":"routine", "title":"Daily reminder", "kind":"routine", "status":"available",
            "createdAt":"2026-09-08T17:00:00Z", "updatedAt":"2026-09-08T17:00:00Z",
            "sources":[], "notes":"", "steps":[], "nextStep":"Announce",
            "routine":{"time":"10:00","nextDueAt":"2026-09-09T10:00:00Z","occurrences":[]}
        }]);
        state["captures"] = serde_json::json!([{
            "id":"capture", "original":"Daily reminder", "createdAt":"2026-09-08T17:00:00Z",
            "itemId":"routine", "interpretation":"pending", "actionEdited":true
        }]);
        db.save(state.clone(), 0).unwrap();
        assert_eq!(db.load().unwrap().state.unwrap(), state);
        state["items"][0]["routine"]["timeZone"] = serde_json::json!("Invalid/Timezone");
        assert!(db.save(state, 1).is_err());
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn sleeping_state() -> Value {
        let mut state = test_state();
        state["items"] = serde_json::json!([{
            "id":"issue", "title":"Sleeping issue", "kind":"task", "status":"deferred",
            "createdAt":"2026-09-08T17:00:00Z", "updatedAt":"2026-09-08T17:00:00Z",
            "sources":[], "notes":"", "steps":[], "nextStep":"Reply",
            "availableAt":"2026-09-09T17:00:00Z",
            "sleep":{"since":"2026-09-08T17:00:00Z","wakeOnPing":true},
            "wake":{"at":"2026-09-07T17:00:00Z","reason":"manual"}
        }]);
        state
    }

    #[test]
    fn sleep_wake_and_undo_metadata_survive_native_storage_roundtrip() {
        let dir = directory();
        let path = dir.join("workspace.sqlite3");
        let db = Database::open(&path).unwrap();
        let mut state = sleeping_state();
        let sleeping = state["items"][0].clone();
        let mut awake = sleeping.clone();
        awake.as_object_mut().unwrap().remove("sleep");
        awake["status"] = serde_json::json!("available");
        awake["wake"] = serde_json::json!({"at":"2026-09-08T18:00:00Z","reason":"mention"});
        state["items"][0] = awake.clone();
        state["undo"] = serde_json::json!([{
            "id":"decision","label":"Wake","itemsBefore":[sleeping],"itemsAfter":[awake]
        }]);
        db.save(state.clone(), 0).unwrap();
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(db.load().unwrap().state.unwrap(), state);
        let mut invalid = state.clone();
        invalid["undo"][0]["itemsBefore"][0]["sleep"]["wakeOnPing"] = serde_json::json!("true");
        assert!(db.save(invalid, 1).is_err());
        assert_eq!(db.load().unwrap().state.unwrap(), state);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reject_malformed_sleep_and_wake_without_rejecting_legacy_workspaces() {
        let state = sleeping_state();
        assert!(validate_workspace(&state).is_ok());
        for sleep in [
            Value::Null,
            serde_json::json!(true),
            serde_json::json!({}),
            serde_json::json!({"since":"yesterday","wakeOnPing":true}),
            serde_json::json!({"since":"2026-09-08T17:00:00Z","wakeOnPing":"true"}),
            serde_json::json!({"since":25,"wakeOnPing":true}),
        ] {
            let mut invalid = state.clone();
            invalid["items"][0]["sleep"] = sleep;
            assert!(validate_workspace(&invalid).is_err());
        }
        for status in ["available", "waiting", "completed", "removed"] {
            let mut invalid = state.clone();
            invalid["items"][0]["status"] = serde_json::json!(status);
            assert!(validate_workspace(&invalid).is_err());
        }
        for wake in [
            Value::Null,
            serde_json::json!([]),
            serde_json::json!({}),
            serde_json::json!({"at":"yesterday","reason":"manual"}),
            serde_json::json!({"at":"2026-09-08T17:00:00Z","reason":"comment"}),
            serde_json::json!({"at":"2026-09-08T17:00:00Z","reason":true}),
        ] {
            let mut invalid = state.clone();
            invalid["items"][0]["wake"] = wake;
            assert!(validate_workspace(&invalid).is_err());
        }
        for reason in ["mention", "review-request", "time", "manual"] {
            let mut valid = state.clone();
            valid["items"][0]["wake"]["reason"] = serde_json::json!(reason);
            assert!(validate_workspace(&valid).is_ok());
        }
        let mut legacy = state;
        let item = legacy["items"][0].as_object_mut().unwrap();
        item.remove("sleep");
        item.remove("wake");
        assert!(validate_workspace(&legacy).is_ok());
        assert!(validate_workspace(&test_state()).is_ok());
    }

    #[test]
    fn persistence_conflict_and_invalid_state_preserve_old_data() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/storage-tests")
            .join(format!(
                "{}-{}",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap()
            ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("workspace.sqlite3");
        let db = Database::open(&path).unwrap();
        assert_eq!(db.load().unwrap().revision, 0);
        assert!(db.load().unwrap().state.is_none());
        let state = test_state();
        assert_eq!(db.save(state.clone(), 0).unwrap(), 1);
        assert!(db.save(state.clone(), 0).unwrap_err().contains("conflict"));
        assert!(db.save(serde_json::json!({}), 1).is_err());
        db.record_delivery("r", "r@one", "2026-09-08T17:00:00Z", Some("denied"))
            .unwrap();
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-08T18:00:00Z")
            .unwrap()
            .to_utc();
        assert!(db.delivery_due("r", "r@one", now).unwrap());
        db.record_delivery("r", "r@one", "2026-09-08T18:00:00Z", None)
            .unwrap();
        drop(db);
        let reopened = Database::open(&path).unwrap();
        assert_eq!(reopened.load().unwrap().state.unwrap(), state);
        assert!(!reopened.delivery_due("r", "r@one", now).unwrap());
        assert!(reopened.delivery_due("r", "r@two", now).unwrap());
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
