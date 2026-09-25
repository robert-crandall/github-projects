use crate::{
    assessments::{ownership, profile_tasks, task_ids},
    code_result::{bounded, result_timestamp, trimmed, CodeResult, Input},
    error::{NativeError, Result},
    model::{digest, Snapshot},
    storage::{read_connection, Store},
};
use chrono::Utc;
use rusqlite::{params, Connection, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const MAX_BYTES: usize = 1024 * 1024;
const SELECT_RUN: &str = "SELECT sequence,generation,run_id,profile_id,task_id,quarantined,terminal,payload,checksum FROM code_runs";
fn valid_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id|
        id.hyphenated().to_string().eq_ignore_ascii_case(value)
            && (id.is_nil() || id.as_u128() == u128::MAX
                || (id.get_variant() == uuid::Variant::RFC4122
                    && (1..=8).contains(&id.get_version_num()))))
}
fn run_timestamp(value: &str) -> Result<()> {
    if value.ends_with('Z') {
        return result_timestamp(value);
    }
    if value.is_ascii() && value.len() > 6 {
        let (time, offset) = value.split_at(value.len() - 6);
        let bytes = offset.as_bytes();
        if matches!(bytes[0], b'+' | b'-') && bytes[3] == b':'
            && [bytes[1], bytes[2], bytes[4], bytes[5]].iter().all(u8::is_ascii_digit)
            && &offset[1..3] <= "23" && &offset[4..6] <= "59"
        {
            return result_timestamp(&format!("{time}Z"));
        }
    }
    Err(NativeError::invalid())
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub run_id: String,
    pub profile_id: String,
    pub agent_name: String,
    pub started_at: String,
    pub input: Input,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RunError {
    pub code: String,
    pub message: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Outcome {
    Running,
    Cancelling,
    Partial {
        #[serde(rename = "finishedAt")]
        finished_at: String,
        result: CodeResult,
    },
    NotInspected {
        #[serde(rename = "finishedAt")]
        finished_at: String,
        result: CodeResult,
    },
    Failed {
        #[serde(rename = "finishedAt")]
        finished_at: String,
        error: RunError,
    },
    Cancelled {
        #[serde(rename = "finishedAt")]
        finished_at: String,
        error: RunError,
    },
    Interrupted {
        #[serde(rename = "finishedAt")]
        finished_at: String,
        error: RunError,
    },
}
impl Outcome {
    fn terminal(&self) -> bool {
        !matches!(self, Self::Running | Self::Cancelling)
    }
    fn validate(&self, input: &Input) -> Result<()> {
        match self {
            Self::Running | Self::Cancelling => Ok(()),
            Self::Partial {
                finished_at,
                result,
            }
            | Self::NotInspected {
                finished_at,
                result,
            } => {
                run_timestamp(finished_at)?;
                if result.not_inspected() != matches!(self, Self::NotInspected { .. }) {
                    return Err(NativeError::invalid());
                }
                result.validate(input)
            }
            Self::Failed { finished_at, error }
            | Self::Cancelled { finished_at, error }
            | Self::Interrupted { finished_at, error } => {
                run_timestamp(finished_at)?;
                if !bounded(&error.code, 1, 100) || !bounded(&error.message, 1, 2000) {
                    return Err(NativeError::invalid());
                }
                Ok(())
            }
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Run {
    pub generation: String,
    pub sequence: i64,
    pub quarantined: bool,
    pub intent: Intent,
    pub outcome: Outcome,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub runs: Vec<Run>,
    pub before: Option<i64>,
}
#[derive(Serialize)]
pub struct Context {
    pub generation: String,
}

impl Intent {
    fn validate(&self) -> Result<()> {
        if !valid_uuid(&self.run_id)
            || !bounded(&self.profile_id, 1, 100)
            || !bounded(trimmed(&self.agent_name), 1, 100)
        {
            return Err(NativeError::invalid());
        }
        run_timestamp(&self.started_at)?;
        self.input.validate()
    }
}
fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS code_runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        generation TEXT NOT NULL, run_id TEXT NOT NULL, profile_id TEXT NOT NULL, task_id TEXT NOT NULL,
        quarantined INTEGER NOT NULL, terminal INTEGER NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL,
        UNIQUE(generation,run_id,quarantined));
        CREATE INDEX IF NOT EXISTS code_run_owner ON code_runs(quarantined,profile_id,task_id,sequence);")?;
    Ok(())
}
fn exists(connection: &Connection) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='code_runs'",
        [],
        |r| r.get::<_, i64>(0),
    )? == 1)
}
fn decode(row: &Row<'_>) -> Result<Run> {
    let payload: String = row.get("payload")?;
    let checksum: String = row.get("checksum")?;
    if payload.len() > MAX_BYTES || digest(payload.as_bytes()) != checksum {
        return Err(NativeError::corrupt());
    }
    let run: Run = serde_json::from_str(&payload).map_err(|_| NativeError::corrupt())?;
    if run.sequence <= 0
        || run.sequence > 9_007_199_254_740_991
        || !valid_uuid(&run.generation)
        || row.get::<_, i64>("sequence")? != run.sequence
        || row.get::<_, String>("generation")? != run.generation
        || row.get::<_, String>("run_id")? != run.intent.run_id
        || row.get::<_, String>("profile_id")? != run.intent.profile_id
        || row.get::<_, String>("task_id")? != run.intent.input.task_id
        || row.get::<_, i64>("quarantined")? != i64::from(run.quarantined)
        || row.get::<_, i64>("terminal")? != i64::from(run.outcome.terminal())
    {
        return Err(NativeError::corrupt());
    }
    run.intent
        .validate()
        .and_then(|_| run.outcome.validate(&run.intent.input))
        .map_err(|_| NativeError::corrupt())?;
    Ok(run)
}
fn find(
    connection: &Connection,
    generation: &str,
    id: &str,
    quarantined: bool,
) -> Result<Option<Run>> {
    let mut query = connection.prepare(&format!(
        "{SELECT_RUN} WHERE generation=? AND run_id=? AND quarantined=?"
    ))?;
    let mut rows = query.query(params![generation, id, quarantined])?;
    rows.next()?.map(decode).transpose()
}
fn write(connection: &Connection, mut run: Run) -> Result<Run> {
    if run.sequence == 0 {
        connection.execute("INSERT INTO code_runs(generation,run_id,profile_id,task_id,quarantined,terminal,payload,checksum) VALUES (?,?,?,?,?,?,'','')",
            params![run.generation,run.intent.run_id,run.intent.profile_id,run.intent.input.task_id,run.quarantined,run.outcome.terminal()])?;
        run.sequence = connection.last_insert_rowid();
    }
    let payload = serde_json::to_string(&run).map_err(|_| NativeError::invalid())?;
    if payload.len() > MAX_BYTES {
        return Err(NativeError::new(
            "code-run-limit",
            "The code run exceeds the 1 MiB history limit. Export the pending result.",
        ));
    }
    connection.execute(
        "UPDATE code_runs SET terminal=?,payload=?,checksum=? WHERE sequence=?",
        params![
            run.outcome.terminal(),
            payload,
            digest(payload.as_bytes()),
            run.sequence
        ],
    )?;
    Ok(run)
}
fn interrupted() -> Outcome {
    Outcome::Interrupted { finished_at: Utc::now().to_rfc3339(), error: RunError {
        code: "interrupted".into(), message: "The app stopped or the workspace was restored before this run was saved. No work was replayed. Start a new run explicitly.".into(),
    } }
}
fn validate_owner(snapshot: &Snapshot, intent: &Intent) -> Result<()> {
    let tasks = profile_tasks(snapshot, &intent.profile_id)?;
    let owners = ownership(tasks)?;
    let owner = owners
        .get(intent.input.task_id.as_str())
        .ok_or_else(NativeError::invalid)?;
    let task = tasks
        .iter()
        .find(|task| task["id"] == *owner)
        .ok_or_else(NativeError::invalid)?;
    let state = &snapshot.workspace["state"];
    let profile = if state["activeWorkProfile"]["id"] == intent.profile_id {
        state
    } else {
        state["inactiveWorkProfiles"]
            .as_array()
            .and_then(|p| p.iter().find(|p| p["id"] == intent.profile_id))
            .ok_or_else(NativeError::invalid)?
    };
    let job = serde_json::to_value(&intent.input.job).map_err(|_| NativeError::invalid())?;
    let configured = profile["work"]["settings"]["codeAgents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|a| a["jobType"] == job))
        .ok_or_else(NativeError::invalid)?;
    if configured["id"] != intent.input.agent.id
        || configured["name"] != intent.agent_name
        || configured["instructions"] != intent.input.agent.instructions
        || configured["model"] != intent.input.agent.model
    {
        return Err(NativeError::new(
            "code-run-settings",
            "Code agent settings changed before the run started. Start again with saved settings.",
        ));
    }
    // Resolve the same canonical source as task details without trusting a renderer-supplied URL.
    let reference = task["work"]
        .get("reference")
        .cloned()
        .or_else(|| task["work"]["notification"].get("reference").cloned())
        .or_else(|| {
            state["threads"]
                .as_array()?
                .iter()
                .find(|t| t["id"] == task["threadId"] && task["threadId"].is_string())
                .map(
                    |t| serde_json::json!({"repo":t["repo"],"kind":t["kind"],"number":t["number"]}),
                )
        });
    let expected = if let Some(reference) = reference {
        serde_json::from_value(reference).map_err(|_| NativeError::invalid())?
    } else {
        let url = url::Url::parse(
            task["work"]["url"]
                .as_str()
                .ok_or_else(NativeError::invalid)?,
        )
        .map_err(|_| NativeError::invalid())?;
        let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
        if url.scheme() != "https"
            || url.host_str() != Some("github.com")
            || !url.username().is_empty()
            || url.password().is_some()
            || parts.len() != 4
            || !["pull", "pulls"].contains(&parts[2])
        {
            return Err(NativeError::invalid());
        }
        crate::conversation::ConversationReference {
            repo: format!("{}/{}", parts[0], parts[1]),
            number: parts[3].parse().map_err(|_| NativeError::invalid())?,
            kind: crate::conversation::ConversationKind::Pr,
        }
    };
    if expected.repo.to_lowercase() != intent.input.source.repo.to_lowercase()
        || expected.kind != intent.input.source.kind
        || expected.number != intent.input.source.number
    {
        return Err(NativeError::invalid());
    }
    if let Some(url) = task["work"]["url"].as_str() {
        let url = url::Url::parse(url).map_err(|_| NativeError::invalid())?;
        let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
        if url.host_str() != Some("github.com")
            || parts.len() != 4
            || format!("{}/{}", parts[0], parts[1]).to_lowercase() != expected.repo.to_lowercase()
            || parts[3].parse::<u64>().ok() != Some(expected.number)
        {
            return Err(NativeError::invalid());
        }
    }
    Ok(())
}

impl Store {
    pub fn code_run_context(&mut self) -> Result<Context> {
        if !self.code_runs_ready {
            let mut connection = self.connection()?;
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            initialize(&tx)?;
            let abandoned: Vec<i64> = {
                let mut query = tx.prepare(SELECT_RUN)?;
                let mut rows = query.query([])?;
                let mut abandoned = Vec::new();
                while let Some(row) = rows.next()? {
                    let run = decode(row)?;
                    if !run.outcome.terminal() {
                        abandoned.push(run.sequence);
                    }
                }
                abandoned
            };
            let changed = !abandoned.is_empty();
            for sequence in abandoned {
                let mut query = tx.prepare(&format!("{SELECT_RUN} WHERE sequence=?"))?;
                let mut rows = query.query([sequence])?;
                let mut run = decode(rows.next()?.ok_or_else(NativeError::corrupt)?)?;
                drop(rows);
                run.outcome = interrupted();
                write(&tx, run)?;
            }
            tx.commit()?;
            self.code_runs_ready = true;
            if changed {
                self.rotate_recovery_token();
            }
        }
        Ok(Context {
            generation: self.code_run_generation.clone(),
        })
    }
    pub fn code_run_start(&mut self, generation: &str, intent: Intent) -> Result<Run> {
        self.code_run_context()?;
        intent.validate()?;
        if generation != self.code_run_generation {
            return Err(NativeError::new(
                "workspace-replaced",
                "The workspace changed. No code job was started.",
            ));
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let snapshot = read_connection(&tx)?
            .snapshot
            .ok_or_else(NativeError::invalid)?;
        validate_owner(&snapshot, &intent)?;
        if let Some(saved) = find(&tx, generation, &intent.run_id, false)? {
            if saved.intent != intent || saved.outcome.terminal() {
                return Err(NativeError::new(
                    "code-run-conflict",
                    "This run already exists. Start a new run explicitly.",
                ));
            }
            return Ok(saved);
        }
        let run = write(
            &tx,
            Run {
                generation: generation.into(),
                sequence: 0,
                quarantined: false,
                intent,
                outcome: Outcome::Running,
            },
        )?;
        tx.commit()?;
        self.rotate_recovery_token();
        Ok(run)
    }
    pub fn code_run_update(
        &mut self,
        generation: &str,
        intent: Intent,
        outcome: Outcome,
    ) -> Result<Run> {
        self.code_run_context()?;
        intent.validate()?;
        outcome.validate(&intent.input)?;
        if !valid_uuid(generation) || matches!(outcome, Outcome::Running) {
            return Err(NativeError::invalid());
        }
        let quarantined = generation != self.code_run_generation;
        if quarantined && !outcome.terminal() {
            return Err(NativeError::new(
                "workspace-replaced",
                "The previous workspace run is no longer active.",
            ));
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old = find(&tx, generation, &intent.run_id, quarantined)?;
        let run = if let Some(mut saved) = old {
            if saved.intent != intent {
                return Err(NativeError::invalid());
            }
            if saved.outcome.terminal() {
                if saved.outcome == outcome {
                    return Ok(saved);
                }
                return Err(NativeError::new(
                    "code-run-conflict",
                    "A terminal code run cannot be overwritten. Its original result is retained.",
                ));
            }
            saved.outcome = outcome;
            write(&tx, saved)?
        } else if quarantined {
            write(
                &tx,
                Run {
                    generation: generation.into(),
                    sequence: 0,
                    quarantined: true,
                    intent,
                    outcome,
                },
            )?
        } else {
            return Err(NativeError::new(
                "code-run-missing",
                "The saved start intent is missing. Export this pending result.",
            ));
        };
        tx.commit()?;
        self.rotate_recovery_token();
        Ok(run)
    }
    pub fn code_run_read(
        &mut self,
        profile: &str,
        task: &str,
        before: Option<i64>,
        quarantined: bool,
    ) -> Result<Page> {
        self.code_run_context()?;
        if before.is_some_and(|v| v <= 0 || v > 9_007_199_254_740_991) {
            return Err(NativeError::invalid());
        }
        let connection = self.connection()?;
        let aliases = if quarantined {
            vec![]
        } else {
            task_ids(
                &read_connection(&connection)?
                    .snapshot
                    .ok_or_else(NativeError::invalid)?,
                profile,
                task,
            )?
        };
        let mut query = connection.prepare(&format!(
            "{SELECT_RUN} WHERE quarantined=? AND sequence<? AND (? OR (profile_id=? AND task_id IN (SELECT value FROM json_each(?)))) ORDER BY sequence DESC LIMIT 11"))?;
        let mut rows = query.query(
            params![
                quarantined,
                before.unwrap_or(i64::MAX),
                quarantined,
                profile,
                serde_json::to_string(&aliases).map_err(|_| NativeError::invalid())?
            ],
        )?;
        let mut runs = Vec::new();
        while let Some(row) = rows.next()? {
            runs.push(decode(row)?);
        }
        let more = runs.len() > 10;
        runs.truncate(10);
        Ok(Page {
            before: if more {
                runs.last().map(|r| r.sequence)
            } else {
                None
            },
            runs,
        })
    }
}

pub(crate) fn append_export(connection: &Connection, output: &mut String) -> Result<()> {
    output.pop();
    output.push_str(",\"codeRuns\":[");
    if exists(connection)? {
        let mut query = connection.prepare(&format!("{SELECT_RUN} ORDER BY sequence"))?;
        let mut rows = query.query([])?;
        let mut first = true;
        while let Some(row) = rows.next()? {
            let entry =
                serde_json::to_string(&decode(row)?).map_err(|_| NativeError::corrupt())?;
            if output.len() + entry.len() + 3 > 64 * 1024 * 1024 {
                return Err(NativeError::new("export-too-large", "JSON export exceeds 64 MiB. Use a database backup; all code runs remain saved."));
            }

            if !first {
                output.push(',');
            }
            first = false;
            output.push_str(&entry);
        }
    }
    output.push_str("]}");
    Ok(())
}

#[cfg(test)]
#[path = "code_runs_tests.rs"]
mod tests;
