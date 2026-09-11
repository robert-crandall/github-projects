use crate::{
    error::{NativeError, Result},
    model::ReminderSchedule,
    storage::{history_loss_cutoff, read_connection, Store},
};
use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionState {
    NotDetermined,
    Denied,
    Granted,
    Provisional,
    Unsupported,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub state: PermissionState,
    pub alerts_enabled: bool,
}

impl Permission {
    pub fn allows_dispatch(&self) -> bool {
        matches!(
            self.state,
            PermissionState::Granted | PermissionState::Provisional
        )
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub delivery_key: String,
    pub schedule_id: String,
    pub occurrence_id: String,
    pub eligible_at: String,
    pub status: String,
    pub attempted_at: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderStatus {
    pub revision: String,
    pub permission: Permission,
    pub deliveries: Vec<Delivery>,
    pub limitations: &'static str,
}

pub const LIMITATIONS: &str = "Reminders require this app to be running. Sleep, Focus, disabled alerts, and denied permission can delay or prevent presentation. Requested means macOS accepted dispatch, not that a notification was shown.";

pub enum Dispatch {
    Requested,
    Failed,
    Uncertain,
}

pub trait Notifications {
    fn permission(&self) -> Result<Permission>;
    fn request_permission(&self) -> Result<Permission>;
    fn dispatch(&self, key: &str) -> Dispatch;
}

pub struct SystemNotifications;

impl Store {
    pub fn reminder_status(&self, permission: Permission) -> Result<ReminderStatus> {
        let connection = self.connection()?;
        let saved = read_connection(&connection)?;
        let mut deliveries = vec![];
        if let Some(snapshot) = saved.snapshot {
            for schedule in snapshot.reminders {
                if let Some(mut delivery) = connection.query_row(
                    "SELECT delivery_key, schedule_id, occurrence_id, eligible_at, status, attempted_at, error_code FROM reminder_deliveries WHERE delivery_key=?",
                    [schedule.delivery_key()?],
                    |row| Ok(Delivery {
                        delivery_key: row.get(0)?, schedule_id: row.get(1)?, occurrence_id: row.get(2)?,
                        eligible_at: row.get(3)?, status: row.get(4)?, attempted_at: row.get(5)?, error_code: row.get(6)?,
                    }),
                ).optional()? {
                    if delivery.status == "dispatching" {
                        delivery.status = "uncertain".into();
                        delivery.error_code = Some("dispatch-interrupted".into());
                    }
                    deliveries.push(delivery);
                }
            }
        }
        Ok(ReminderStatus {
            revision: saved.revision,
            permission,
            deliveries,
            limitations: LIMITATIONS,
        })
    }

    pub fn reconcile_reminders(
        &self,
        now: DateTime<Utc>,
        notifications: &impl Notifications,
    ) -> Result<ReminderStatus> {
        let permission = notifications.permission()?;
        let connection = self.connection()?;
        let saved = read_connection(&connection)?;
        let cutoff = history_loss_cutoff(&connection)?;
        if let Some(snapshot) = saved.snapshot {
            for schedule in snapshot.reminders {
                let eligible_at = schedule.eligible_at()?;
                if eligible_at > now {
                    continue;
                }
                let key = schedule.delivery_key()?;
                let previous: Option<String> = connection
                    .query_row(
                        "SELECT status FROM reminder_deliveries WHERE delivery_key=?",
                        [&key],
                        |row| row.get(0),
                    )
                    .optional()?;
                if previous.is_none() && cutoff.is_some_and(|cutoff| eligible_at <= cutoff) {
                    connection.execute(
                        "INSERT INTO reminder_deliveries VALUES (?,?,?,?,'uncertain',NULL,'recovery-delivery-uncertain')",
                        params![key, schedule.id, schedule.occurrence_id, schedule.eligible_at()?.to_rfc3339()],
                    )?;
                    continue;
                }
                if previous
                    .as_deref()
                    .is_some_and(|state| !matches!(state, "blocked" | "retry"))
                {
                    continue;
                }
                let status = if permission.allows_dispatch() {
                    "dispatching"
                } else {
                    "blocked"
                };
                let at = now.to_rfc3339();
                connection.execute(
                    "INSERT INTO reminder_deliveries (delivery_key,schedule_id,occurrence_id,eligible_at,status,attempted_at,error_code)
                     VALUES (?,?,?,?,?,?,NULL)
                     ON CONFLICT(delivery_key) DO UPDATE SET status=excluded.status, attempted_at=excluded.attempted_at, error_code=NULL",
                    params![key, schedule.id, schedule.occurrence_id, schedule.eligible_at()?.to_rfc3339(), status, at],
                )?;
                if !permission.allows_dispatch() {
                    continue;
                }
                // Claim durably before calling macOS. A crash between claim and completion
                // is uncertain, never silently retried (which could duplicate a visible alert).
                let (status, error_code) = match notifications.dispatch(&key) {
                    Dispatch::Requested => ("requested", None),
                    Dispatch::Failed => ("failed", Some("notification-rejected")),
                    Dispatch::Uncertain => ("uncertain", Some("notification-timeout")),
                };
                connection.execute(
                    "UPDATE reminder_deliveries SET status=?,error_code=? WHERE delivery_key=?",
                    params![status, error_code, key],
                )?;
            }
        }
        self.reminder_status(permission)
    }

    pub fn retry_reminder(&self, key: &str, expected_revision: &str) -> Result<()> {
        let connection = self.connection()?;
        let saved = read_connection(&connection)?;
        if saved.revision != expected_revision {
            return Err(NativeError::conflict());
        }
        let schedules: Vec<ReminderSchedule> =
            saved.snapshot.map(|s| s.reminders).unwrap_or_default();
        if !schedules
            .iter()
            .map(ReminderSchedule::delivery_key)
            .collect::<Result<Vec<_>>>()?
            .iter()
            .any(|k| k == key)
        {
            return Err(NativeError::invalid());
        }
        let changed = connection.execute(
            "UPDATE reminder_deliveries SET status='retry',error_code=NULL WHERE delivery_key=? AND status IN ('failed','uncertain','dispatching')",
            [key],
        )?;
        if changed != 1 {
            return Err(NativeError::new(
                "reminder-not-retryable",
                "Only failed or uncertain reminder dispatches can be retried.",
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent,
        UNNotificationRequest, UNNotificationSetting, UNNotificationSettings,
        UNUserNotificationCenter,
    };
    use std::{ptr::NonNull, sync::mpsc, time::Duration};

    fn center() -> Result<objc2::rc::Retained<UNUserNotificationCenter>> {
        // UserNotifications raises an Objective-C exception outside an application bundle.
        // Never attribute development requests to Terminal or another installed app.
        let id = NSBundle::mainBundle()
            .bundleIdentifier()
            .map(|id| id.to_string());
        if id.as_deref() != Some("io.robertcrandall.github-projects-workspace") {
            return Err(NativeError::new("notification-unavailable", "Native reminders require the built GitHub Projects Workspace.app bundle. No permission has been requested."));
        }
        Ok(UNUserNotificationCenter::currentNotificationCenter())
    }

    impl Notifications for SystemNotifications {
        fn permission(&self) -> Result<Permission> {
            let center = center()?;
            let (sender, receiver) = mpsc::sync_channel(1);
            let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                // The framework guarantees this pointer is valid for the callback.
                let settings = unsafe { settings.as_ref() };
                let state = match settings.authorizationStatus() {
                    UNAuthorizationStatus::NotDetermined => PermissionState::NotDetermined,
                    UNAuthorizationStatus::Denied => PermissionState::Denied,
                    UNAuthorizationStatus::Authorized => PermissionState::Granted,
                    UNAuthorizationStatus::Provisional => PermissionState::Provisional,
                    _ => PermissionState::Unsupported,
                };
                // A timed-out caller has gone away; there is no app state to update.
                let _ = sender.send(Permission {
                    state,
                    alerts_enabled: settings.alertSetting() == UNNotificationSetting::Enabled,
                });
            });
            center.getNotificationSettingsWithCompletionHandler(&block);
            receiver.recv_timeout(Duration::from_secs(5)).map_err(|_| NativeError::new(
                "notification-unavailable", "macOS did not return reminder permission status. Delivery cannot be confirmed.",
            ))
        }

        fn request_permission(&self) -> Result<Permission> {
            let center = center()?;
            let (sender, receiver) = mpsc::sync_channel(1);
            let block = RcBlock::new(move |_granted: Bool, error: *mut NSError| {
                let _ = sender.send(error.is_null());
            });
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert,
                &block,
            );
            let accepted = receiver.recv_timeout(Duration::from_secs(120)).map_err(|_| NativeError::new(
                "notification-unavailable", "The permission request is still unresolved. Check macOS notification settings.",
            ))?;
            if !accepted {
                return Err(NativeError::new(
                    "notification-unavailable",
                    "macOS could not complete the reminder permission request.",
                ));
            }
            self.permission()
        }

        fn dispatch(&self, key: &str) -> Dispatch {
            let Ok(center) = center() else {
                return Dispatch::Failed;
            };
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str("GitHub Projects"));
            content.setBody(&NSString::from_str(
                "A saved reminder is due. Open GitHub Projects to continue.",
            ));
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(key),
                &content,
                None,
            );
            let (sender, receiver) = mpsc::sync_channel(1);
            let block = RcBlock::new(move |error: *mut NSError| {
                let _ = sender.send(error.is_null());
            });
            center.addNotificationRequest_withCompletionHandler(&request, Some(&block));
            match receiver.recv_timeout(Duration::from_secs(5)) {
                Ok(true) => Dispatch::Requested,
                Ok(false) => Dispatch::Failed,
                Err(_) => Dispatch::Uncertain,
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl Notifications for SystemNotifications {
    fn permission(&self) -> Result<Permission> {
        Ok(Permission {
            state: PermissionState::Unsupported,
            alerts_enabled: false,
        })
    }
    fn request_permission(&self) -> Result<Permission> {
        self.permission()
    }
    fn dispatch(&self, _: &str) -> Dispatch {
        Dispatch::Failed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{timestamp, Snapshot};
    use serde_json::json;
    use std::cell::Cell;
    use tempfile::TempDir;

    struct MockNotifications {
        state: PermissionState,
        count: Cell<usize>,
        fail: bool,
    }
    impl Notifications for MockNotifications {
        fn permission(&self) -> Result<Permission> {
            Ok(Permission {
                state: self.state.clone(),
                alerts_enabled: self.state == PermissionState::Granted,
            })
        }
        fn request_permission(&self) -> Result<Permission> {
            panic!("reconciliation must not request permission")
        }
        fn dispatch(&self, _: &str) -> Dispatch {
            self.count.set(self.count.get() + 1);
            if self.fail {
                Dispatch::Failed
            } else {
                Dispatch::Requested
            }
        }
    }
    fn mock(state: PermissionState) -> MockNotifications {
        MockNotifications {
            state,
            count: Cell::new(0),
            fail: false,
        }
    }
    fn snapshot() -> Snapshot {
        Snapshot {
            format_version: 1,
            workspace: json!({"version":1,"step":{"doneAt":"2026-09-10T17:00:00Z"}}),
            reminders: vec![ReminderSchedule {
                id: "routine-1".into(),
                occurrence_id: "routine-1:2026-09-11T17:00:00Z".into(),
                due_at: "2026-09-11T17:00:00Z".into(),
                time_zone: "America/Los_Angeles".into(),
                snoozed_until: None,
                daily: Some(crate::model::DailySchedule {
                    time: "10:00".into(),
                    time_zone: "America/Los_Angeles".into(),
                }),
            }],
        }
    }
    fn save(store: &mut Store, snapshot: Snapshot) {
        store
            .save(&store.read().unwrap().revision, snapshot)
            .unwrap();
    }

    #[test]
    fn due_resume_coalescing_relaunch_and_partial_progress() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        save(&mut store, snapshot());
        let mock = mock(PermissionState::Granted);
        store
            .reconcile_reminders(timestamp("2026-09-11T16:59:00Z").unwrap(), &mock)
            .unwrap();
        assert_eq!(mock.count.get(), 0);
        store
            .reconcile_reminders(timestamp("2026-09-15T20:00:00Z").unwrap(), &mock)
            .unwrap();
        assert_eq!(mock.count.get(), 1);
        drop(store);
        let store = Store::new(dir.path().to_owned()).unwrap();
        store
            .reconcile_reminders(timestamp("2026-09-20T20:00:00Z").unwrap(), &mock)
            .unwrap();
        assert_eq!(
            mock.count.get(),
            1,
            "missed days coalesce into the same outstanding occurrence"
        );
        assert_eq!(
            store.read().unwrap().snapshot.unwrap().workspace["step"]["doneAt"],
            "2026-09-10T17:00:00Z"
        );
    }

    #[test]
    fn snooze_dispatches_once_more_for_same_occurrence_without_timezone_drift() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        let mut state = snapshot();
        save(&mut store, state.clone());
        let mock = mock(PermissionState::Granted);
        store
            .reconcile_reminders(timestamp("2026-09-11T17:00:00Z").unwrap(), &mock)
            .unwrap();
        state.reminders[0].snoozed_until = Some("2026-09-11T17:30:00Z".into());
        save(&mut store, state);
        store
            .reconcile_reminders(timestamp("2026-09-11T17:29:00Z").unwrap(), &mock)
            .unwrap();
        assert_eq!(mock.count.get(), 1);
        store
            .reconcile_reminders(timestamp("2026-09-11T17:30:00Z").unwrap(), &mock)
            .unwrap();
        store
            .reconcile_reminders(timestamp("2026-09-11T18:30:00Z").unwrap(), &mock)
            .unwrap();
        assert_eq!(mock.count.get(), 2);
        assert_eq!(
            store.read().unwrap().snapshot.unwrap().reminders[0].time_zone,
            "America/Los_Angeles"
        );
    }

    #[test]
    fn denied_permission_is_visible_and_grant_reconciles_without_prompting() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        save(&mut store, snapshot());
        let now = timestamp("2026-09-11T17:00:00Z").unwrap();
        for state in [
            PermissionState::NotDetermined,
            PermissionState::Denied,
            PermissionState::Unsupported,
        ] {
            let mock = mock(state.clone());
            let status = store.reconcile_reminders(now, &mock).unwrap();
            assert_eq!(status.permission.state, state);
            assert_eq!(status.deliveries[0].status, "blocked");
            assert_eq!(mock.count.get(), 0);
        }
        let mock = mock(PermissionState::Provisional);
        let status = store.reconcile_reminders(now, &mock).unwrap();
        assert_eq!(status.deliveries[0].status, "requested");
        assert_eq!(mock.count.get(), 1);
    }

    #[test]
    fn failed_and_crash_interrupted_dispatches_require_explicit_retry() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        save(&mut store, snapshot());
        let mut mock = mock(PermissionState::Granted);
        mock.fail = true;
        let now = timestamp("2026-09-11T17:00:00Z").unwrap();
        let status = store.reconcile_reminders(now, &mock).unwrap();
        assert_eq!(status.deliveries[0].status, "failed");
        store.reconcile_reminders(now, &mock).unwrap();
        assert_eq!(mock.count.get(), 1);
        let key = &status.deliveries[0].delivery_key;
        store
            .connection()
            .unwrap()
            .execute("UPDATE reminder_deliveries SET status='dispatching'", [])
            .unwrap();
        assert_eq!(
            store.reconcile_reminders(now, &mock).unwrap().deliveries[0].status,
            "uncertain"
        );
        assert_eq!(mock.count.get(), 1);
        assert!(store.retry_reminder(key, "stale").is_err());
        store.retry_reminder(key, &status.revision).unwrap();
        mock.fail = false;
        store.reconcile_reminders(now, &mock).unwrap();
        assert_eq!(mock.count.get(), 2);
    }

    #[test]
    fn unsaved_invalid_or_removed_schedules_cannot_dispatch() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        let revision = store.read().unwrap().revision;
        let mock = mock(PermissionState::Granted);
        let now = timestamp("2026-09-11T17:00:00Z").unwrap();
        assert!(store.save("stale", snapshot()).is_err());
        store.reconcile_reminders(now, &mock).unwrap();
        assert_eq!(mock.count.get(), 0);
        let mut invalid = snapshot();
        invalid.reminders[0].time_zone = "Invalid/Zone".into();
        assert!(store.save(&revision, invalid).is_err());
        let mut saved = snapshot();
        save(&mut store, saved.clone());
        saved.reminders.clear();
        save(&mut store, saved);
        store.reconcile_reminders(now, &mock).unwrap();
        assert_eq!(mock.count.get(), 0);
    }

    #[test]
    fn equivalent_instants_share_a_delivery_key() {
        let mut schedule = snapshot().reminders.remove(0);
        let key = schedule.delivery_key().unwrap();
        schedule.due_at = "2026-09-11T10:00:00-07:00".into();
        assert_eq!(schedule.delivery_key().unwrap(), key);
    }

    #[test]
    fn recovery_does_not_replay_notifications_sent_since_backup() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        save(&mut store, snapshot());
        let backup = store
            .create_backup(&store.read().unwrap().revision)
            .unwrap();
        let mock = mock(PermissionState::Granted);
        let now = timestamp("2026-09-11T17:00:00Z").unwrap();
        store.reconcile_reminders(now, &mock).unwrap();
        assert_eq!(mock.count.get(), 1);
        store
            .recover(&backup.id, &store.status().recovery_token)
            .unwrap();
        store.reconcile_reminders(now, &mock).unwrap();
        assert_eq!(mock.count.get(), 1);
    }

    #[test]
    fn recovery_from_corrupt_storage_marks_due_delivery_uncertain() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        let mut state = snapshot();
        state.reminders[0].due_at = "2020-01-01T17:00:00Z".into();
        save(&mut store, state);
        let backup = store
            .create_backup(&store.read().unwrap().revision)
            .unwrap();
        std::fs::write(store.path(), b"damaged").unwrap();
        store
            .recover(&backup.id, &store.status().recovery_token)
            .unwrap();
        let mock = mock(PermissionState::Granted);
        let status = store.reconcile_reminders(Utc::now(), &mock).unwrap();
        assert_eq!(mock.count.get(), 0);
        assert_eq!(status.deliveries[0].status, "uncertain");
        assert_eq!(
            status.deliveries[0].error_code.as_deref(),
            Some("recovery-delivery-uncertain")
        );
    }

    #[test]
    fn history_loss_survives_empty_restore_relaunch_and_older_scheduled_backup() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        let empty_backup = store
            .create_backup(&store.read().unwrap().revision)
            .unwrap();
        let mut state = snapshot();
        state.reminders[0].due_at = "2020-01-01T17:00:00Z".into();
        save(&mut store, state);
        let scheduled_backup = store
            .create_backup(&store.read().unwrap().revision)
            .unwrap();
        let mock = mock(PermissionState::Granted);
        store.reconcile_reminders(Utc::now(), &mock).unwrap();
        assert_eq!(mock.count.get(), 1);
        std::fs::write(store.path(), b"damaged").unwrap();
        store
            .recover(&empty_backup.id, &store.status().recovery_token)
            .unwrap();
        assert!(store.read().unwrap().snapshot.is_none());
        drop(store);
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        store
            .recover(&scheduled_backup.id, &store.status().recovery_token)
            .unwrap();
        let status = store.reconcile_reminders(Utc::now(), &mock).unwrap();
        assert_eq!(
            mock.count.get(),
            1,
            "restoring an empty backup must not erase lost-history uncertainty"
        );
        assert_eq!(status.deliveries[0].status, "uncertain");
        store
            .retry_reminder(&status.deliveries[0].delivery_key, &status.revision)
            .unwrap();
        store.reconcile_reminders(Utc::now(), &mock).unwrap();
        assert_eq!(mock.count.get(), 2, "explicit retry is still available");
    }

    #[test]
    fn history_loss_covers_reintroduced_old_schedules_but_not_new_future_occurrences() {
        let dir = TempDir::new().unwrap();
        let mut store = Store::new(dir.path().to_owned()).unwrap();
        let backup = store
            .create_backup(&store.read().unwrap().revision)
            .unwrap();
        std::fs::write(store.path(), b"damaged").unwrap();
        store
            .recover(&backup.id, &store.status().recovery_token)
            .unwrap();
        let cutoff = history_loss_cutoff(&store.connection().unwrap())
            .unwrap()
            .unwrap();
        let mut state = snapshot();
        state.reminders[0].due_at = "2020-01-01T17:00:00Z".into();
        save(&mut store, state.clone());
        let mock = mock(PermissionState::Granted);
        let status = store.reconcile_reminders(Utc::now(), &mock).unwrap();
        assert_eq!(mock.count.get(), 0);
        assert_eq!(status.deliveries[0].status, "uncertain");

        let future = cutoff + chrono::Duration::hours(1);
        state.reminders[0].due_at = future.to_rfc3339();
        state.reminders[0].occurrence_id = "routine-1:future-occurrence".into();
        save(&mut store, state);
        store.reconcile_reminders(future, &mock).unwrap();
        assert_eq!(
            mock.count.get(),
            1,
            "history loss must not disable genuinely future reminders"
        );
    }
}
