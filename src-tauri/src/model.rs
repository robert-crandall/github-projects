use crate::error::{NativeError, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SCHEDULES: usize = 1000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DailySchedule {
    pub time: String,
    pub time_zone: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReminderSchedule {
    pub id: String,
    pub occurrence_id: String,
    pub due_at: String,
    pub time_zone: String,
    pub snoozed_until: Option<String>,
    pub daily: Option<DailySchedule>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub format_version: u32,
    pub workspace: Value,
    pub reminders: Vec<ReminderSchedule>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRead {
    pub revision: String,
    pub snapshot: Option<Snapshot>,
    pub saved_at: Option<String>,
}

pub fn timestamp(value: &str) -> Result<DateTime<Utc>> {
    if value.len() > 40 {
        return Err(NativeError::invalid());
    }
    DateTime::parse_from_rfc3339(value)
        .map(|v| v.with_timezone(&Utc))
        .map_err(|_| NativeError::invalid())
}

pub fn identifier(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(NativeError::invalid());
    }
    Ok(())
}

pub fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

impl ReminderSchedule {
    pub fn eligible_at(&self) -> Result<DateTime<Utc>> {
        let due = timestamp(&self.due_at)?;
        Ok(match &self.snoozed_until {
            Some(snooze) => due.max(timestamp(snooze)?),
            None => due,
        })
    }

    pub fn delivery_key(&self) -> Result<String> {
        // Normalize instants so different RFC3339 spellings cannot bypass deduplication.
        Ok(digest(
            serde_json::to_string(&(
                &self.id,
                &self.occurrence_id,
                self.eligible_at()?.to_rfc3339(),
            ))
            .map_err(|_| NativeError::invalid())?
            .as_bytes(),
        ))
    }
}

impl Snapshot {
    pub fn state_version(&self) -> Option<u64> {
        self.workspace.get("state")?.get("version")?.as_u64()
    }

    pub fn encode(&self) -> Result<String> {
        if self.format_version != 1
            || !self.workspace.is_object()
            || self
                .workspace
                .get("version")
                .and_then(Value::as_u64)
                .filter(|v| *v > 0)
                .is_none()
            || self.reminders.len() > MAX_SCHEDULES
            || (self.state_version().is_some_and(|version| version >= 3)
                && !self.reminders.is_empty())
        {
            return Err(NativeError::invalid());
        }
        let mut ids = HashSet::new();
        for schedule in &self.reminders {
            identifier(&schedule.id)?;
            identifier(&schedule.occurrence_id)?;
            if !ids.insert(&schedule.id) || schedule.time_zone.parse::<chrono_tz::Tz>().is_err() {
                return Err(NativeError::invalid());
            }
            schedule.eligible_at()?;
            if let Some(daily) = &schedule.daily {
                if daily.time_zone != schedule.time_zone
                    || daily.time.len() != 5
                    || chrono::NaiveTime::parse_from_str(&daily.time, "%H:%M").is_err()
                {
                    return Err(NativeError::invalid());
                }
            }
        }
        fn depth(value: &Value, level: usize) -> bool {
            level <= 64
                && match value {
                    Value::Array(v) => v.iter().all(|v| depth(v, level + 1)),
                    Value::Object(v) => v.values().all(|v| depth(v, level + 1)),
                    _ => true,
                }
        }
        if !depth(&self.workspace, 0) {
            return Err(NativeError::invalid());
        }
        let json = serde_json::to_string(self).map_err(|_| NativeError::invalid())?;
        if json.len() > MAX_SNAPSHOT_BYTES {
            return Err(NativeError::new("snapshot-too-large", "The workspace exceeds the 8 MiB native storage limit. Export a copy before reducing it."));
        }
        Ok(json)
    }
}
