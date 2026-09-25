use crate::{
    error::{NativeError, Result},
    model::{digest, timestamp, Snapshot, WorkspaceRead},
    storage::{read_connection, Store},
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    reference: String,
    summary: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assessment {
    importance: String,
    urgency: String,
    blockers: String,
    supporting_evidence: Vec<Evidence>,
    uncertainty: String,
    reevaluate_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedAssessment {
    result_id: String,
    id: String,
    profile_id: String,
    fingerprint: String,
    instructions_fingerprint: String,
    assessment_version: String,
    model: String,
    evaluated_at: String,
    assessment: Assessment,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    #[serde(flatten)]
    pub result: SavedAssessment,
    pub sequence: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub assessments: Vec<HistoryEntry>,
    pub before: Option<i64>,
}

fn bounded(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.chars().count())
}

impl SavedAssessment {
    fn validate(&self) -> Result<()> {
        let hash = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        let result = &self.assessment;
        if Uuid::parse_str(&self.result_id).is_err()
            || !bounded(&self.id, 1, 500)
            || !bounded(&self.profile_id, 1, 100)
            || !hash(&self.fingerprint)
            || !hash(&self.instructions_fingerprint)
            || !bounded(&self.assessment_version, 1, 100)
            || !bounded(&self.model, 0, 100)
            || [&result.importance, &result.urgency, &result.blockers]
                .iter()
                .any(|s| s.trim().is_empty() || !bounded(s, 1, 400))
            || !bounded(&result.uncertainty, 0, 400)
            || !(1..=8).contains(&result.supporting_evidence.len())
            || result.supporting_evidence.iter().any(|e| {
                !bounded(&e.reference, 1, 500)
                    || e.summary.trim().is_empty()
                    || !bounded(&e.summary, 1, 240)
            })
        {
            return Err(NativeError::invalid());
        }
        timestamp(&self.evaluated_at)?;
        timestamp(&result.reevaluate_at)?;
        Ok(())
    }
}

pub(crate) fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_assessments (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            result_id TEXT NOT NULL UNIQUE,
            profile_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            checksum TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS task_assessment_owner ON task_assessments(profile_id, task_id, sequence);",
    )?;
    Ok(())
}

fn exists(connection: &Connection) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='task_assessments'",
        [],
        |row| row.get::<_, i64>(0),
    )? == 1)
}

fn decode(sequence: i64, payload: String, checksum: String) -> Result<HistoryEntry> {
    if sequence <= 0
        || sequence > 9_007_199_254_740_991
        || payload.len() > 65_536
        || digest(payload.as_bytes()) != checksum
    {
        return Err(NativeError::corrupt());
    }
    let result: SavedAssessment =
        serde_json::from_str(&payload).map_err(|_| NativeError::corrupt())?;
    result.validate().map_err(|_| NativeError::corrupt())?;
    Ok(HistoryEntry { result, sequence })
}

#[cfg(test)]
fn all(connection: &Connection) -> Result<Vec<HistoryEntry>> {
    if !exists(connection)? {
        return Ok(vec![]);
    }
    let mut query = connection
        .prepare("SELECT sequence,payload,checksum FROM task_assessments ORDER BY sequence")?;
    let rows = query.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    rows.map(|row| {
        let (sequence, payload, checksum) = row?;
        decode(sequence, payload, checksum)
    })
    .collect()
}

const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;

pub(crate) fn export_json(connection: &Connection, workspace: WorkspaceRead) -> Result<String> {
    let limit = || {
        NativeError::new("export-too-large", "JSON export exceeds 64 MiB. Preserve database files or use a database backup; all history remains saved.")
    };
    let mut output = serde_json::to_string(&workspace).map_err(|_| NativeError::corrupt())?;
    output.pop();
    output.push_str(",\"assessments\":[");
    if exists(connection)? {
        let mut query = connection
            .prepare("SELECT sequence,payload,checksum FROM task_assessments ORDER BY sequence")?;
        let rows = query.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        for (index, row) in rows.enumerate() {
            let (sequence, payload, checksum) = row?;
            let entry = serde_json::to_string(&decode(sequence, payload, checksum)?)
                .map_err(|_| NativeError::corrupt())?;
            let comma = usize::from(index > 0);
            if output.len() + comma + entry.len() + 2 > MAX_EXPORT_BYTES {
                return Err(limit());
            }
            if comma != 0 {
                output.push(',');
            }
            output.push_str(&entry);
        }
    }
    output.push_str("]}");
    if output.len() > MAX_EXPORT_BYTES {
        return Err(limit());
    }
    Ok(output)
}

fn insert(connection: &Connection, result: &SavedAssessment) -> Result<HistoryEntry> {
    result.validate()?;
    let existing = connection
        .query_row(
            "SELECT sequence,payload,checksum FROM task_assessments WHERE result_id=?",
            [&result.result_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((sequence, payload, checksum)) = existing {
        let saved = decode(sequence, payload, checksum)?;
        if &saved.result != result {
            return Err(NativeError::new(
                "assessment-conflict",
                "An immutable assessment changed. The original history is retained.",
            ));
        }
        return Ok(saved);
    }
    let payload = serde_json::to_string(result).map_err(|_| NativeError::invalid())?;
    connection.execute(
        "INSERT INTO task_assessments(result_id,profile_id,task_id,payload,checksum) VALUES (?,?,?,?,?)",
        params![result.result_id, result.profile_id, result.id, payload, digest(payload.as_bytes())],
    )?;
    let sequence = connection.last_insert_rowid();
    if sequence > 9_007_199_254_740_991 {
        return Err(NativeError::invalid());
    }
    Ok(HistoryEntry {
        result: result.clone(),
        sequence,
    })
}

fn profile_tasks<'a>(snapshot: &'a Snapshot, profile_id: &str) -> Result<&'a Vec<Value>> {
    let state = &snapshot.workspace["state"];
    let active = state["activeWorkProfile"]["id"]
        .as_str()
        .unwrap_or("default");
    let tasks = if active == profile_id {
        &state["tasks"]
    } else {
        &state["inactiveWorkProfiles"]
            .as_array()
            .and_then(|profiles| profiles.iter().find(|p| p["id"] == profile_id))
            .ok_or_else(NativeError::invalid)?["tasks"]
    };
    tasks.as_array().ok_or_else(NativeError::invalid)
}

fn ownership(tasks: &[Value]) -> Result<HashMap<&str, &str>> {
    let mut owners = HashMap::new();
    for task in tasks {
        let id = task["id"].as_str().ok_or_else(NativeError::invalid)?;
        if owners.insert(id, id).is_some() {
            return Err(NativeError::invalid());
        }
    }
    for task in tasks {
        let id = task["id"].as_str().ok_or_else(NativeError::invalid)?;
        if let Some(aliases) = task.get("assessmentTaskIds") {
            for alias in aliases.as_array().ok_or_else(NativeError::invalid)? {
                let alias = alias
                    .as_str()
                    .filter(|id| bounded(id, 1, 500))
                    .ok_or_else(NativeError::invalid)?;
                if owners.get(alias).is_some_and(|owner| *owner != id) {
                    return Err(NativeError::new("assessment-owner-conflict", "Assessment history aliases must belong to exactly one task in each profile."));
                }
                owners.insert(alias, id);
            }
        }
    }
    Ok(owners)
}

pub(crate) fn validate_ownership(snapshot: &Snapshot) -> Result<()> {
    let state = &snapshot.workspace["state"];
    if let Some(tasks) = state.get("tasks").and_then(Value::as_array) {
        ownership(tasks)?;
    }
    if let Some(profiles) = state.get("inactiveWorkProfiles") {
        for profile in profiles.as_array().ok_or_else(NativeError::invalid)? {
            ownership(
                profile["tasks"]
                    .as_array()
                    .ok_or_else(NativeError::invalid)?,
            )?;
        }
    }
    Ok(())
}

fn task_ids(snapshot: &Snapshot, profile_id: &str, task_id: &str) -> Result<Vec<String>> {
    let owners = ownership(profile_tasks(snapshot, profile_id)?)?;
    if owners.get(task_id) != Some(&task_id) {
        return Err(NativeError::invalid());
    }
    Ok(owners
        .into_iter()
        .filter(|(_, owner)| *owner == task_id)
        .map(|(id, _)| id.to_owned())
        .collect())
}

impl Store {
    pub fn assessment_append(
        &mut self,
        profile_id: &str,
        values: Vec<SavedAssessment>,
    ) -> Result<Vec<HistoryEntry>> {
        if values.is_empty() || values.len() > 20 {
            return Err(NativeError::invalid());
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        initialize(&transaction)?;
        let snapshot = read_connection(&transaction)?
            .snapshot
            .ok_or_else(NativeError::invalid)?;
        let mut ids = HashSet::new();
        let owners = ownership(profile_tasks(&snapshot, profile_id)?)?;
        for value in &values {
            if value.profile_id != profile_id
                || !ids.insert(&value.result_id)
                || !owners.contains_key(value.id.as_str())
            {
                return Err(NativeError::invalid());
            }
        }
        let results = values
            .iter()
            .map(|value| insert(&transaction, value))
            .collect::<Result<Vec<_>>>()?;
        transaction.commit()?;
        self.rotate_recovery_token();
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn snapshot() -> Snapshot {
        Snapshot {
            format_version: 1,
            reminders: vec![],
            workspace: json!({
                "version": 1, "state": {
                    "version": 3, "activeWorkProfile": {"id":"default","name":"Default"},
                    "tasks": [{"id":"manual","title":"Owner task","notes":"Owner notes","status":"open"}],
                    "inactiveWorkProfiles":[{"id":"other","name":"Other","tasks":[{"id":"parked"}]}]
                }
            }),
        }
    }
    fn result(id: &str) -> SavedAssessment {
        serde_json::from_value(json!({
                        "resultId": Uuid::new_v4().to_string(), "id":id,"profileId":"default",
                        "fingerprint":"a".repeat(64),"instructionsFingerprint":"b".repeat(64),
                        "assessmentVersion":"work-assessment-v2","model":"","evaluatedAt":"2026-09-24T12:00:00Z",
                        "assessment":{"importance":"i".repeat(400),"urgency":"u".repeat(400),"blockers":"b".repeat(400),
                            "uncertainty":"n".repeat(400),"reevaluateAt":"2026-09-25T12:00:00Z",
                            "supportingEvidence":(0..8).map(|_| json!({"reference":"$title","summary":"e".repeat(240)})).collect::<Vec<_>>()}
                    })).unwrap()
    }
    fn setup() -> (TempDir, Store) {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        store
            .save(&store.read().unwrap().revision, snapshot())
            .unwrap();
        (dir, store)
    }

    #[test]
    fn append_is_immutable_idempotent_scoped_and_independent_of_workspace_cas() {
        let (_dir, mut store) = setup();
        let saved = store.read().unwrap();
        let first = result("manual");
        let inserted = store
            .assessment_append("default", vec![first.clone()])
            .unwrap();
        assert_eq!(
            store
                .assessment_append("default", vec![first.clone()])
                .unwrap(),
            inserted
        );
        assert_eq!(store.read().unwrap().revision, saved.revision);
        let mut conflicting = first.clone();
        conflicting.model = "different".into();
        assert_eq!(
            store
                .assessment_append("default", vec![conflicting])
                .unwrap_err()
                .code,
            "assessment-conflict"
        );
        assert!(store.assessment_append("other", vec![first]).is_err());
        assert!(store
            .assessment_append("default", vec![result("parked")])
            .is_err());
        let mut next = snapshot();
        next.workspace["state"]["tasks"][0]["notes"] = json!("Concurrent owner edit");
        store.save(&saved.revision, next).unwrap();
        assert_eq!(
            store
                .assessment_read("default", "manual", None)
                .unwrap()
                .assessments,
            inserted
        );
    }

    #[test]
    fn history_above_eight_mib_pages_relaunches_and_keeps_normal_saves_backup_export_restore() {
        let (dir, mut store) = setup();
        for _ in 0..115 {
            store
                .assessment_append("default", (0..20).map(|_| result("manual")).collect())
                .unwrap();
        }
        let bytes: i64 = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT sum(length(payload)) FROM task_assessments",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(bytes > 8 * 1024 * 1024);
        let saved = store.read().unwrap();
        assert!(saved.snapshot.as_ref().unwrap().encode().unwrap().len() < 1024);
        let backup = store.create_backup(&saved.revision).unwrap();
        let export = store.export_json(&saved.revision).unwrap();
        assert!(export.len() > 8 * 1024 * 1024);
        let raw = store.export_raw().unwrap();
        assert!(std::path::Path::new(&raw.directory)
            .join("workspace.sqlite3")
            .exists());
        drop(store);
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        let mut cursor = None;
        let mut ids = HashSet::new();
        let mut previous = i64::MAX;
        loop {
            let page = store.assessment_read("default", "manual", cursor).unwrap();
            assert!(page.assessments.len() <= 20);
            for entry in page.assessments {
                assert!(entry.sequence < previous);
                previous = entry.sequence;
                assert!(ids.insert(entry.result.result_id));
            }
            cursor = page.before;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(ids.len(), 2300);
        let mut next = snapshot();
        next.workspace["state"]["tasks"][0]["notes"] = json!("Still saving after 8 MiB history");
        next.workspace["state"]["tasks"][0]["status"] = json!("done");
        store.save(&saved.revision, next).unwrap();
        let newest = store
            .assessment_append("default", vec![result("manual")])
            .unwrap();
        assert_eq!(
            store
                .assessment_read("default", "manual", None)
                .unwrap()
                .assessments[0],
            newest[0]
        );
        let token = store.status().recovery_token;
        let restored = store.recover(&backup.id, &token).unwrap();
        assert_eq!(all(&store.connection().unwrap()).unwrap().len(), 2300);
        assert_eq!(
            restored.snapshot.unwrap().workspace["state"]["tasks"][0]["status"],
            "open"
        );
        let original: Value = serde_json::from_str(&export).unwrap();
        assert_eq!(
            serde_json::to_value(all(&store.connection().unwrap()).unwrap()).unwrap(),
            original["assessments"]
        );
    }

    #[test]
    fn consolidated_aliases_preserve_sequence_and_reads_do_not_mutate_saved_state() {
        let (_dir, mut store) = setup();
        let first = result("manual");
        let mut newest = result("old-duplicate");
        newest.evaluated_at = "2026-09-24T11:00:00Z".into();
        let mut consolidated = snapshot();
        consolidated.workspace["state"]["tasks"][0]["assessmentTaskIds"] =
            json!(["manual", "old-duplicate"]);
        let saved = store
            .save(&store.read().unwrap().revision, consolidated)
            .unwrap();
        store
            .assessment_append("default", vec![first.clone(), newest.clone()])
            .unwrap();
        let page = store.assessment_read("default", "manual", None).unwrap();
        assert_eq!(page.assessments[0].result, newest);
        assert_eq!(page.assessments[1].result, first);
        let backups = store.list_backups().unwrap().len();
        assert_eq!(store.read().unwrap().revision, saved.revision);
        assert_eq!(
            store.read().unwrap().snapshot.unwrap().workspace,
            saved.snapshot.unwrap().workspace
        );
        assert_eq!(store.list_backups().unwrap().len(), backups);
    }

    #[test]
    fn failed_history_append_does_not_block_task_saves() {
        let (_dir, mut store) = setup();
        let saved = store.read().unwrap();
        let connection = store.connection().unwrap();
        connection.execute_batch("CREATE TRIGGER fail_append BEFORE INSERT ON task_assessments BEGIN SELECT RAISE(ABORT,'synthetic capacity'); END;").unwrap();
        assert!(store
            .assessment_append("default", vec![result("manual")])
            .is_err());
        let mut next = snapshot();
        next.workspace["state"]["tasks"][0]["status"] = json!("done");
        let saved = store.save(&saved.revision, next).unwrap();
        assert_eq!(
            saved.snapshot.unwrap().workspace["state"]["tasks"][0]["status"],
            "done"
        );
        connection
            .execute_batch("DROP TRIGGER fail_append")
            .unwrap();
        store
            .assessment_append("default", vec![result("manual")])
            .unwrap();
        assert_eq!(
            store
                .assessment_read("default", "manual", None)
                .unwrap()
                .assessments
                .len(),
            1
        );
    }

    #[test]
    fn recovery_rejects_concurrent_append_or_snapshot_change_before_restoring() {
        let (_dir, mut store) = setup();
        let before = store.status();
        let backup = store
            .create_backup(before.revision.as_deref().unwrap())
            .unwrap();
        let appended = store
            .assessment_append("default", vec![result("manual")])
            .unwrap();
        assert_eq!(
            store
                .recover_at_revision(
                    &backup.id,
                    &before.recovery_token,
                    before.revision.as_deref()
                )
                .unwrap_err()
                .code,
            "revision-conflict"
        );
        assert_eq!(
            store
                .assessment_read("default", "manual", None)
                .unwrap()
                .assessments,
            appended
        );
        store
            .save(before.revision.as_deref().unwrap(), snapshot())
            .unwrap();
        let latest = store.status();
        assert_eq!(
            store
                .recover_at_revision(
                    &backup.id,
                    &latest.recovery_token,
                    before.revision.as_deref()
                )
                .unwrap_err()
                .code,
            "revision-conflict"
        );
        store
            .recover_at_revision(
                &backup.id,
                &latest.recovery_token,
                latest.revision.as_deref(),
            )
            .unwrap();
        assert!(store
            .assessment_read("default", "manual", None)
            .unwrap()
            .assessments
            .is_empty());
    }

    #[test]
    fn ambiguous_aliases_fail_save_read_and_append_but_profiles_are_independent() {
        for shared in [false, true] {
            let (_dir, mut store) = setup();
            let revision = store.read().unwrap().revision;
            let mut invalid = snapshot();
            invalid.workspace["state"]["tasks"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":"B"}));
            invalid.workspace["state"]["tasks"][0]["assessmentTaskIds"] =
                json!([if shared { "former" } else { "B" }]);
            if shared {
                invalid.workspace["state"]["tasks"][1]["assessmentTaskIds"] = json!(["former"]);
            }
            assert_eq!(
                store.save(&revision, invalid.clone()).unwrap_err().code,
                "assessment-owner-conflict"
            );
            assert_eq!(store.read().unwrap().revision, revision);
            let json = invalid.encode().unwrap();
            store
                .connection()
                .unwrap()
                .execute(
                    "UPDATE workspace SET snapshot=?,checksum=?",
                    params![json, digest(json.as_bytes())],
                )
                .unwrap();
            assert_eq!(store.read().unwrap_err().code, "storage-corrupt");
            assert!(store
                .assessment_append("default", vec![result("manual")])
                .is_err());
            assert!(store.assessment_read("default", "manual", None).is_err());
        }
        let (_dir, mut store) = setup();
        let mut valid = snapshot();
        valid.workspace["state"]["tasks"][0]["assessmentTaskIds"] = json!(["former"]);
        valid.workspace["state"]["inactiveWorkProfiles"][0]["tasks"][0]["assessmentTaskIds"] =
            json!(["former"]);
        store.save(&store.read().unwrap().revision, valid).unwrap();
    }

    #[test]
    fn export_cap_measures_actual_serialized_history_and_small_workspace() {
        let (_dir, store) = setup();
        let mut connection = store.connection().unwrap();
        let mut count = 0;
        let mut serialized_rows = 0;
        {
            let transaction = connection.transaction().unwrap();
            while serialized_rows < 57 * 1024 * 1024 {
                let entry = insert(&transaction, &result("manual")).unwrap();
                serialized_rows +=
                    serde_json::to_string(&entry).unwrap().len() + usize::from(count > 0);
                count += 1;
            }
            transaction.commit().unwrap();
        }
        let saved = store.read().unwrap();
        let envelope = serde_json::to_string(&saved).unwrap();
        let actual_bytes = envelope.len() - 1 + ",\"assessments\":[".len() + serialized_rows + 2;
        let exported = store.export_json(&saved.revision).unwrap();
        assert_eq!(exported.len(), actual_bytes);
        assert!(actual_bytes > 57 * 1024 * 1024 && actual_bytes < MAX_EXPORT_BYTES);
        assert_eq!(
            serde_json::from_str::<Value>(&exported).unwrap()["assessments"]
                .as_array()
                .unwrap()
                .len(),
            count
        );
        drop(exported);
        {
            let transaction = connection.transaction().unwrap();
            while envelope.len() - 1 + ",\"assessments\":[".len() + serialized_rows + 2
                <= MAX_EXPORT_BYTES
            {
                let entry = insert(&transaction, &result("manual")).unwrap();
                serialized_rows += serde_json::to_string(&entry).unwrap().len() + 1;
            }
            transaction.commit().unwrap();
        }
        let exact_oversized = serde_json::to_string(&json!({
            "revision":saved.revision, "snapshot":saved.snapshot, "savedAt":saved.saved_at, "assessments":all(&connection).unwrap()
        })).unwrap();
        assert!(exact_oversized.len() > MAX_EXPORT_BYTES);
        assert_eq!(
            store.export_json(&saved.revision).unwrap_err().code,
            "export-too-large"
        );
    }
}
impl Store {
    pub fn assessment_read(
        &self,
        profile_id: &str,
        task_id: &str,
        before: Option<i64>,
    ) -> Result<HistoryPage> {
        if before.is_some_and(|n| n <= 0) {
            return Err(NativeError::invalid());
        }
        let connection = self.connection()?;
        let snapshot = read_connection(&connection)?
            .snapshot
            .ok_or_else(NativeError::invalid)?;
        let ids = task_ids(&snapshot, profile_id, task_id)?;
        if !exists(&connection)? {
            return Ok(HistoryPage {
                assessments: vec![],
                before: None,
            });
        }
        let mut query = connection.prepare(
            "SELECT sequence,payload,checksum FROM task_assessments
             WHERE profile_id=? AND task_id IN (SELECT value FROM json_each(?)) AND sequence < ?
             ORDER BY sequence DESC LIMIT 21",
        )?;
        let rows = query.query_map(
            params![
                profile_id,
                serde_json::to_string(&ids).map_err(|_| NativeError::invalid())?,
                before.unwrap_or(i64::MAX)
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let mut assessments = rows
            .map(|row| {
                let (seq, json, hash) = row?;
                decode(seq, json, hash)
            })
            .collect::<Result<Vec<_>>>()?;
        if assessments
            .iter()
            .any(|entry| entry.result.profile_id != profile_id || !ids.contains(&entry.result.id))
        {
            return Err(NativeError::corrupt());
        }
        let more = assessments.len() > 20;
        assessments.truncate(20);
        let before = if more {
            assessments.last().map(|entry| entry.sequence)
        } else {
            None
        };
        Ok(HistoryPage {
            assessments,
            before,
        })
    }
}
