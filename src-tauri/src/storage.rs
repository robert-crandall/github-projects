use crate::{
    error::{NativeError, Result},
    model::{digest, Snapshot, WorkspaceRead, MAX_SNAPSHOT_BYTES},
};
use chrono::Utc;
use fs2::FileExt;
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

const SCHEMA_VERSION: i64 = 1;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    pub created_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub recovery_token: String,
    pub revision: Option<String>,
    pub error: Option<NativeError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawExport {
    pub id: String,
    pub directory: String,
}

pub struct Store {
    pub(crate) directory: PathBuf,
    _lock: File,
    recovery_token: String,
}

fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn sync_file(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    File::open(path)?.sync_all()?;
    Ok(())
}

fn configure(connection: &Connection) -> Result<()> {
    connection.busy_timeout(Duration::from_secs(2))?;
    connection.set_limit(
        rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
        (MAX_SNAPSHOT_BYTES + 65536) as i32,
    )?;
    Ok(())
}

fn validate(connection: &Connection) -> Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != SCHEMA_VERSION {
        return Err(NativeError::new("unsupported-schema", "This workspace uses an unsupported database version. It has not been migrated or reset."));
    }
    let integrity: String = connection.pragma_query_value(None, "quick_check", |row| row.get(0))?;
    if integrity != "ok" {
        return Err(NativeError::corrupt());
    }
    read_connection(connection)?;
    Ok(())
}

pub(crate) fn read_connection(connection: &Connection) -> Result<WorkspaceRead> {
    history_loss_cutoff(connection)?;
    let (revision, json, hash, saved_at): (String, Option<String>, Option<String>, Option<String>) =
        connection.query_row(
            "SELECT revision, snapshot, checksum, saved_at FROM workspace WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    if Uuid::parse_str(&revision).is_err() {
        return Err(NativeError::corrupt());
    }
    let snapshot = match json {
        Some(json) => {
            if json.len() > MAX_SNAPSHOT_BYTES
                || hash.as_deref() != Some(digest(json.as_bytes()).as_str())
            {
                return Err(NativeError::corrupt());
            }
            let snapshot: Snapshot =
                serde_json::from_str(&json).map_err(|_| NativeError::corrupt())?;
            snapshot.encode().map_err(|_| NativeError::corrupt())?;
            if saved_at
                .as_deref()
                .map(crate::model::timestamp)
                .transpose()
                .map_err(|_| NativeError::corrupt())?
                .is_none()
            {
                return Err(NativeError::corrupt());
            }
            Some(snapshot)
        }
        None if hash.is_none() && saved_at.is_none() => None,
        None => return Err(NativeError::corrupt()),
    };
    Ok(WorkspaceRead {
        revision,
        snapshot,
        saved_at,
    })
}

pub(crate) fn history_loss_cutoff(
    connection: &Connection,
) -> Result<Option<chrono::DateTime<Utc>>> {
    let cutoff: Option<String> = connection.query_row(
        "SELECT delivery_history_lost_before FROM workspace WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    cutoff
        .as_deref()
        .map(crate::model::timestamp)
        .transpose()
        .map_err(|_| NativeError::corrupt())
}

impl Store {
    pub fn new(directory: PathBuf) -> Result<Self> {
        private_dir(&directory)?;
        private_dir(&directory.join("backups"))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("workspace.lock"))?;
        lock.try_lock_exclusive().map_err(|_| NativeError::new("storage-busy", "Another desktop process owns this workspace. Close it before opening another instance."))?;
        let store = Self {
            directory,
            _lock: lock,
            recovery_token: Uuid::new_v4().to_string(),
        };
        if !store.path().exists() {
            store.initialize()?;
        }
        Ok(store)
    }

    pub(crate) fn path(&self) -> PathBuf {
        self.directory.join("workspace.sqlite3")
    }

    fn initialize(&self) -> Result<()> {
        // Create only a genuinely absent database. A damaged or zero-byte file is never reset.
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.path())?;
        sync_file(&self.path())?;
        let mut connection = Connection::open(self.path())?;
        configure(&connection)?;
        connection.execute_batch(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;",
        )?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE workspace (
                id INTEGER PRIMARY KEY CHECK(id=1),
                revision TEXT NOT NULL,
                snapshot TEXT,
                checksum TEXT,
                saved_at TEXT,
                delivery_history_lost_before TEXT
            );
            CREATE TABLE reminder_deliveries (
                delivery_key TEXT PRIMARY KEY,
                schedule_id TEXT NOT NULL,
                occurrence_id TEXT NOT NULL,
                eligible_at TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('blocked','dispatching','requested','failed','uncertain','retry')),
                attempted_at TEXT,
                error_code TEXT
            );
            PRAGMA user_version=1;",
        )?;
        transaction.execute(
            "INSERT INTO workspace (id, revision) VALUES (1, ?)",
            [Uuid::new_v4().to_string()],
        )?;
        transaction.commit()?;
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }

    pub(crate) fn connection(&self) -> Result<Connection> {
        let connection =
            Connection::open_with_flags(self.path(), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        configure(&connection)?;
        validate(&connection)?;
        connection.execute_batch("PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;")?;
        Ok(connection)
    }

    pub fn read(&self) -> Result<WorkspaceRead> {
        read_connection(&self.connection()?)
    }

    pub fn status(&self) -> StorageStatus {
        match self.read() {
            Ok(saved) => StorageStatus {
                recovery_token: self.recovery_token.clone(),
                revision: Some(saved.revision),
                error: None,
            },
            Err(error) => StorageStatus {
                recovery_token: self.recovery_token.clone(),
                revision: None,
                error: Some(error),
            },
        }
    }

    pub fn save(&mut self, expected_revision: &str, snapshot: Snapshot) -> Result<WorkspaceRead> {
        let json = snapshot.encode()?;
        let mut connection = self.connection()?;
        if read_connection(&connection)?.revision != expected_revision {
            return Err(NativeError::conflict());
        }
        self.backup_connection(&connection, "latest")?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let revision = Uuid::new_v4().to_string();
        let saved_at = Utc::now().to_rfc3339();
        let rows = transaction.execute(
            "UPDATE workspace SET revision=?, snapshot=?, checksum=?, saved_at=? WHERE id=1 AND revision=?",
            params![revision, json, digest(json.as_bytes()), saved_at, expected_revision],
        )?;
        if rows != 1 {
            return Err(NativeError::conflict());
        }
        // The schedule is inside the checksummed envelope, so there is no independent
        // registration step that could schedule unsaved work.
        transaction.commit()?;
        self.recovery_token = Uuid::new_v4().to_string();
        Ok(WorkspaceRead {
            revision,
            snapshot: Some(snapshot),
            saved_at: Some(saved_at),
        })
    }

    fn backup_path(&self, id: &str) -> Result<PathBuf> {
        if id != "latest" && Uuid::parse_str(id).is_err() {
            return Err(NativeError::invalid());
        }
        Ok(self.directory.join("backups").join(format!("{id}.sqlite3")))
    }

    fn backup_connection(&self, connection: &Connection, id: &str) -> Result<()> {
        let target = self.backup_path(id)?;
        let temporary = self
            .directory
            .join("backups")
            .join(format!("{}.tmp", Uuid::new_v4()));
        connection.backup(rusqlite::MAIN_DB, &temporary, None)?;
        sync_file(&temporary)?;
        fs::rename(&temporary, target)?;
        File::open(self.directory.join("backups"))?.sync_all()?;
        Ok(())
    }

    pub fn create_backup(&self, expected_revision: &str) -> Result<Backup> {
        let connection = self.connection()?;
        if read_connection(&connection)?.revision != expected_revision {
            return Err(NativeError::conflict());
        }
        let id = Uuid::new_v4().to_string();
        self.backup_connection(&connection, &id)?;
        Ok(Backup {
            id,
            created_at: Utc::now().to_rfc3339(),
        })
    }

    pub fn list_backups(&self) -> Result<Vec<Backup>> {
        let mut backups = vec![];
        for entry in fs::read_dir(self.directory.join("backups"))? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("sqlite3") {
                continue;
            }
            let id = path
                .file_stem()
                .and_then(|id| id.to_str())
                .ok_or_else(NativeError::invalid)?
                .to_owned();
            self.backup_path(&id)?;
            backups.push(Backup {
                id,
                created_at: chrono::DateTime::<Utc>::from(entry.metadata()?.modified()?)
                    .to_rfc3339(),
            });
        }
        backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(backups)
    }

    fn backup_read_connection(&self, id: &str) -> Result<Connection> {
        let connection =
            Connection::open_with_flags(self.backup_path(id)?, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        configure(&connection)?;
        validate(&connection)?;
        Ok(connection)
    }

    pub fn read_backup(&self, id: &str) -> Result<WorkspaceRead> {
        read_connection(&self.backup_read_connection(id)?)
    }

    pub fn export_json(&self, expected_revision: &str) -> Result<String> {
        let read = self.read()?;
        if read.revision != expected_revision {
            return Err(NativeError::conflict());
        }
        serde_json::to_string(&read).map_err(|_| NativeError::corrupt())
    }

    pub fn export_raw(&self) -> Result<RawExport> {
        let id = Uuid::new_v4().to_string();
        let directory = self.directory.join("exports").join(&id);
        private_dir(&directory)?;
        // Preserve a damaged database and any recovery journal without opening or interpreting it.
        for name in [
            "workspace.sqlite3",
            "workspace.sqlite3-journal",
            "workspace.sqlite3-wal",
            "workspace.sqlite3-shm",
        ] {
            let source = self.directory.join(name);
            if source.exists() {
                let destination = directory.join(name);
                fs::copy(source, &destination)?;
                sync_file(&destination)?;
            }
        }
        File::open(&directory)?.sync_all()?;
        File::open(directory.parent().ok_or_else(NativeError::invalid)?)?.sync_all()?;
        Ok(RawExport {
            id,
            directory: directory.to_string_lossy().into_owned(),
        })
    }

    pub fn recover(&mut self, backup_id: &str, expected_token: &str) -> Result<WorkspaceRead> {
        if expected_token != self.recovery_token {
            return Err(NativeError::conflict());
        }
        let source = self.backup_read_connection(backup_id)?;
        let staging = self.directory.join(format!("{}.restore", Uuid::new_v4()));
        source.backup(rusqlite::MAIN_DB, &staging, None)?;
        let connection = Connection::open(&staging)?;
        connection.execute_batch("PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;")?;
        connection.execute(
            "UPDATE workspace SET revision=? WHERE id=1",
            [Uuid::new_v4().to_string()],
        )?;
        let mut cutoff = history_loss_cutoff(&connection)?;
        match self.connection() {
            Ok(current) => {
                cutoff = cutoff.max(history_loss_cutoff(&current)?);
                let mut statement = current.prepare("SELECT delivery_key,schedule_id,occurrence_id,eligible_at,status,attempted_at,error_code FROM reminder_deliveries")?;
                let rows = statement.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                })?;
                for row in rows {
                    let row = row?;
                    connection.execute(
                        "INSERT OR REPLACE INTO reminder_deliveries VALUES (?,?,?,?,?,?,?)",
                        params![row.0, row.1, row.2, row.3, row.4, row.5, row.6],
                    )?;
                }
            }
            Err(error)
                if matches!(
                    error.code.as_str(),
                    "storage-corrupt" | "unsupported-schema"
                ) =>
            {
                cutoff = cutoff.max(Some(Utc::now()));
            }
            Err(error) => return Err(error),
        }
        // The watermark survives even an empty restore, so a later restore/import cannot
        // resurrect a previously sent occurrence after its delivery ledger was lost.
        connection.execute(
            "UPDATE workspace SET delivery_history_lost_before=? WHERE id=1",
            [cutoff.map(|instant| instant.to_rfc3339())],
        )?;
        if let (Some(cutoff), Some(snapshot)) = (cutoff, read_connection(&connection)?.snapshot) {
            for schedule in snapshot.reminders {
                if schedule.eligible_at()? <= cutoff {
                    connection.execute(
                        "INSERT INTO reminder_deliveries VALUES (?,?,?,?,'uncertain',NULL,'recovery-delivery-uncertain')
                         ON CONFLICT(delivery_key) DO UPDATE SET status='uncertain',error_code='recovery-delivery-uncertain'
                         WHERE status IN ('blocked','retry')",
                        params![schedule.delivery_key()?, schedule.id, schedule.occurrence_id, schedule.eligible_at()?.to_rfc3339()],
                    )?;
                }
            }
        }
        validate(&connection)?;
        drop(connection);
        sync_file(&staging)?;
        let original = self.export_raw()?;
        // Move journals aside only after preserving all original bytes. SQLite must not
        // apply an old database's journal to the restored database.
        for name in [
            "workspace.sqlite3-journal",
            "workspace.sqlite3-wal",
            "workspace.sqlite3-shm",
        ] {
            let path = self.directory.join(name);
            if path.exists() {
                fs::rename(
                    &path,
                    Path::new(&original.directory).join(format!("retired-{name}")),
                )?;
            }
        }
        fs::rename(staging, self.path())?;
        File::open(&self.directory)?.sync_all()?;
        self.recovery_token = Uuid::new_v4().to_string();
        self.read()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    pub fn snapshot(note: &str) -> Snapshot {
        Snapshot {
            format_version: 1,
            workspace: json!({"version": 1, "note": note}),
            reminders: vec![],
        }
    }

    #[test]
    fn fresh_roundtrip_cas_and_relaunch() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        let initial = store.read().unwrap();
        assert!(initial.snapshot.is_none());
        let saved = store
            .save(&initial.revision, snapshot("offline note"))
            .unwrap();
        assert_ne!(saved.revision, initial.revision);
        assert_eq!(
            store
                .save(&initial.revision, snapshot("stale"))
                .unwrap_err()
                .code,
            "revision-conflict"
        );
        drop(store);
        let reopened = Store::new(dir.path().to_owned()).unwrap().read().unwrap();
        assert_eq!(reopened.revision, saved.revision);
        assert_eq!(reopened.snapshot.unwrap().workspace["note"], "offline note");
    }

    #[test]
    fn recovery_preserves_original_and_never_reuses_revision() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        let first = store
            .save(&store.read().unwrap().revision, snapshot("first"))
            .unwrap();
        let backup = store.create_backup(&first.revision).unwrap();
        let old_token = store.status().recovery_token;
        store.save(&first.revision, snapshot("second")).unwrap();
        assert_eq!(
            store.recover(&backup.id, &old_token).unwrap_err().code,
            "revision-conflict"
        );
        let token = store.status().recovery_token;
        let restored = store.recover(&backup.id, &token).unwrap();
        assert_ne!(restored.revision, first.revision);
        assert_eq!(restored.snapshot.unwrap().workspace["note"], "first");
        assert!(store.directory.join("exports").exists());
        assert_eq!(
            store
                .save(&first.revision, snapshot("ABA"))
                .unwrap_err()
                .code,
            "revision-conflict"
        );
    }

    #[test]
    fn corruption_cannot_be_overwritten_but_can_be_exported_and_recovered() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        let saved = store
            .save(&store.read().unwrap().revision, snapshot("safe"))
            .unwrap();
        let backup = store.create_backup(&saved.revision).unwrap();
        fs::write(store.path(), b"damaged database").unwrap();
        assert_eq!(store.read().unwrap_err().code, "storage-corrupt");
        assert!(store.save(&saved.revision, snapshot("lost")).is_err());
        assert_eq!(fs::read(store.path()).unwrap(), b"damaged database");
        let export = store.export_raw().unwrap();
        assert_eq!(
            fs::read(Path::new(&export.directory).join("workspace.sqlite3")).unwrap(),
            b"damaged database"
        );
        store
            .recover(&backup.id, &store.status().recovery_token)
            .unwrap();
        assert_eq!(
            store.read().unwrap().snapshot.unwrap().workspace["note"],
            "safe"
        );
    }

    #[test]
    fn damaged_json_future_schema_and_zero_byte_database_are_not_reset() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        let saved = store
            .save(&store.read().unwrap().revision, snapshot("safe"))
            .unwrap();
        let connection = store.connection().unwrap();
        connection
            .execute("UPDATE workspace SET snapshot='{}' WHERE id=1", [])
            .unwrap();
        assert_eq!(store.read().unwrap_err().code, "storage-corrupt");
        assert!(store
            .save(&saved.revision, snapshot("replacement"))
            .is_err());
        connection.execute_batch("PRAGMA user_version=99").unwrap();
        assert_eq!(store.read().unwrap_err().code, "unsupported-schema");
        drop(connection);
        drop(store);
        fs::write(dir.path().join("workspace.sqlite3"), []).unwrap();
        let store = Store::new(dir.path().to_owned()).unwrap();
        assert_eq!(store.read().unwrap_err().code, "unsupported-schema");
        assert_eq!(fs::metadata(store.path()).unwrap().len(), 0);
    }

    #[test]
    fn bounds_backup_paths_and_exclusive_process_lock() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        assert!(Store::new(dir.path().to_owned()).is_err());
        assert!(store.read_backup("../workspace").is_err());
        let revision = store.read().unwrap().revision;
        assert!(store
            .save(&revision, snapshot(&"x".repeat(MAX_SNAPSHOT_BYTES)))
            .is_err());
        assert_eq!(store.read().unwrap().revision, revision);
        assert!(store.read().unwrap().snapshot.is_none());
    }

    #[test]
    fn automatic_backup_is_previous_committed_snapshot() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        let first = store
            .save(&store.read().unwrap().revision, snapshot("first"))
            .unwrap();
        store.save(&first.revision, snapshot("second")).unwrap();
        assert_eq!(
            store
                .read_backup("latest")
                .unwrap()
                .snapshot
                .unwrap()
                .workspace["note"],
            "first"
        );
        let export: WorkspaceRead =
            serde_json::from_str(&store.export_json(&store.read().unwrap().revision).unwrap())
                .unwrap();
        assert_eq!(export.snapshot.unwrap().workspace["note"], "second");
    }

    #[test]
    fn backup_failure_cannot_commit_a_new_snapshot_or_schedule() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        let original = store.read().unwrap();
        fs::create_dir(store.directory.join("backups/latest.sqlite3")).unwrap();
        assert!(store
            .save(&original.revision, snapshot("not saved"))
            .is_err());
        let after = store.read().unwrap();
        assert_eq!(after.revision, original.revision);
        assert!(after.snapshot.is_none());
    }

    #[test]
    fn invalid_saved_at_is_corruption_and_can_be_recovered() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        let saved = store
            .save(&store.read().unwrap().revision, snapshot("safe"))
            .unwrap();
        let backup = store.create_backup(&saved.revision).unwrap();
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE workspace SET saved_at='damaged timestamp' WHERE id=1",
                [],
            )
            .unwrap();
        assert_eq!(store.read().unwrap_err().code, "storage-corrupt");
        let restored = store
            .recover(&backup.id, &store.status().recovery_token)
            .unwrap();
        assert_eq!(restored.snapshot.unwrap().workspace["note"], "safe");
    }
}
