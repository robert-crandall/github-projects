use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::timeout;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationStatus {
    pub permission: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl NotificationStatus {
    fn unavailable(error: String) -> Self {
        Self {
            permission: "unavailable".into(),
            error: Some(error),
        }
    }
}

pub async fn status() -> NotificationStatus {
    match native::permission(false).await {
        Ok(permission) => NotificationStatus {
            permission,
            error: None,
        },
        Err(error) => NotificationStatus::unavailable(error),
    }
}

pub async fn request_permission() -> NotificationStatus {
    match native::permission(true).await {
        Ok(permission) => NotificationStatus {
            permission,
            error: None,
        },
        Err(error) => NotificationStatus::unavailable(error),
    }
}

pub async fn send(id: &str, title: &str, body: &str) -> Result<(), String> {
    let permission = status().await;
    if permission.permission != "granted" {
        return Err(permission.error.unwrap_or_else(|| "Notifications are not authorized. Enable GitHub Projects in macOS System Settings → Notifications.".into()));
    }
    native::send(id, title, body).await
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use block2::RcBlock;
    use objc2::{rc::Retained, runtime::Bool};
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent,
        UNNotificationRequest, UNNotificationSettings, UNUserNotificationCenter,
    };
    use std::{
        ptr::NonNull,
        sync::{Arc, Mutex},
    };
    use tokio::sync::oneshot;

    fn center() -> Result<Retained<UNUserNotificationCenter>, String> {
        let identifier = NSBundle::mainBundle().bundleIdentifier();
        if identifier.is_none_or(|id| id.to_string() != "dev.followthrough.app") {
            return Err("Native notifications require the installed GitHub Projects.app bundle. Browser previews and an unbundled dev executable cannot deliver reliable reminders.".into());
        }
        Ok(UNUserNotificationCenter::currentNotificationCenter())
    }

    fn begin_status() -> Result<oneshot::Receiver<String>, String> {
        let center = center()?;
        let (tx, rx) = oneshot::channel();
        let tx = Arc::new(Mutex::new(Some(tx)));
        let callback = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // Apple guarantees the settings object exists for the duration of this callback.
            let state = unsafe { settings.as_ref() }.authorizationStatus();
            let state = if state == UNAuthorizationStatus::Authorized
                || state == UNAuthorizationStatus::Provisional
            {
                "granted"
            } else if state == UNAuthorizationStatus::Denied {
                "denied"
            } else {
                "prompt"
            };
            if let Ok(mut tx) = tx.lock() {
                if let Some(tx) = tx.take() {
                    let _ = tx.send(state.to_string());
                }
            }
        });
        center.getNotificationSettingsWithCompletionHandler(&callback);
        Ok(rx)
    }

    fn begin_request() -> Result<oneshot::Receiver<Result<(), String>>, String> {
        let center = center()?;
        let (tx, rx) = oneshot::channel();
        let tx = Arc::new(Mutex::new(Some(tx)));
        let callback = RcBlock::new(move |_granted: Bool, error: *mut NSError| {
            let result = if error.is_null() {
                Ok(())
            } else {
                Err("macOS could not request notification permission. Check System Settings → Notifications.".into())
            };
            if let Ok(mut tx) = tx.lock() {
                if let Some(tx) = tx.take() {
                    let _ = tx.send(result);
                }
            }
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &callback,
        );
        Ok(rx)
    }

    pub async fn permission(request: bool) -> Result<String, String> {
        if request {
            let rx = begin_request()?;
            timeout(Duration::from_secs(60), rx)
                .await
                .map_err(|_| "Notification permission request timed out.")?
                .map_err(|_| "Notification permission callback ended.")??;
        }
        let rx = begin_status()?;
        timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| "Notification permission check timed out.".to_string())?
            .map_err(|_| "Notification permission callback ended.".into())
    }

    fn begin_send(
        id: &str,
        title: &str,
        body: &str,
    ) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        let center = center()?;
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(id),
            &content,
            None,
        );
        let (tx, rx) = oneshot::channel();
        let tx = Arc::new(Mutex::new(Some(tx)));
        let callback = RcBlock::new(move |error: *mut NSError| {
            let result = if error.is_null() {
                Ok(())
            } else {
                Err("macOS rejected this notification. No successful delivery was recorded.".into())
            };
            if let Ok(mut tx) = tx.lock() {
                if let Some(tx) = tx.take() {
                    let _ = tx.send(result);
                }
            }
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&callback));
        Ok(rx)
    }

    pub async fn send(id: &str, title: &str, body: &str) -> Result<(), String> {
        let rx = begin_send(id, title, body)?;
        timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| "macOS notification delivery timed out.")?
            .map_err(|_| "macOS notification callback ended.")?
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    pub async fn permission(_: bool) -> Result<String, String> {
        Err("This build supports native reminders on macOS only.".into())
    }
    pub async fn send(_: &str, _: &str, _: &str) -> Result<(), String> {
        Err("Native reminders require macOS.".into())
    }
}

#[derive(Debug, PartialEq)]
pub(crate) struct Reminder {
    routine_id: String,
    occurrence_id: String,
    title: String,
}

fn past(value: &Value, now: DateTime<Utc>) -> bool {
    value
        .as_str()
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .is_some_and(|t| t <= now)
}

pub(crate) fn candidates(state: &Value, now: DateTime<Utc>) -> Vec<Reminder> {
    if state["runtime"] != "desktop" {
        return Vec::new();
    }
    let Some(items) = state["items"].as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            if item["status"] != "available"
                || item.get("availableAt").is_some_and(|v| !past(v, now))
            {
                return None;
            }
            let routine = item.get("routine")?;
            let routine_id = item["id"].as_str()?;
            let occurrences = routine["occurrences"].as_array()?;
            let outstanding = occurrences
                .iter()
                .filter(|o| o["status"] == "outstanding")
                .min_by_key(|o| {
                    o["dueAt"]
                        .as_str()
                        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
                });
            let occurrence_id = if let Some(occurrence) = outstanding {
                if !past(&occurrence["dueAt"], now)
                    || occurrence["reminderDismissed"] == true
                    || occurrence
                        .get("snoozedUntil")
                        .is_some_and(|v| !past(v, now))
                    || occurrence.get("reminderAt").is_some_and(|v| !past(v, now))
                {
                    return None;
                }
                occurrence["id"].as_str()?.to_string()
            } else {
                let due = &routine["nextDueAt"];
                if !past(due, now) || occurrences.iter().any(|o| o["dueAt"] == *due) {
                    return None;
                }
                // Use the renderer's occurrence identity before it reconciles a hidden/suspended window.
                format!("{routine_id}@{}", due.as_str()?)
            };
            Some(Reminder {
                routine_id: routine_id.into(),
                occurrence_id,
                title: item["title"].as_str()?.chars().take(180).collect(),
            })
        })
        .collect()
}

pub fn clock_event(app: &AppHandle) {
    let _ = app.emit(
        "desktop-clock",
        Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    );
}

pub fn report_error(app: &AppHandle, error: &str) {
    let _ = app.emit("desktop-notification-error", error);
    let _ = app.emit("desktop-error", error);
}

pub async fn heartbeat(app: &AppHandle) -> Result<(), String> {
    let backend = app.state::<crate::Backend>();
    let Some(state) = backend.database.load()?.state else {
        return Ok(());
    };
    let now = Utc::now();
    for reminder in candidates(&state, now) {
        if backend.shutdown.is_cancelled() {
            return Ok(());
        }
        if !backend
            .database
            .delivery_due(&reminder.routine_id, &reminder.occurrence_id, now)?
        {
            continue;
        }
        let permission = status().await;
        let result = if permission.permission != "granted" {
            Err(permission.error.unwrap_or_else(|| "Reminder not delivered: notifications are not authorized in macOS System Settings.".into()))
        } else {
            let current = backend.database.load()?.state;
            if !current
                .as_ref()
                .is_some_and(|state| candidates(state, now).contains(&reminder))
            {
                continue;
            }
            tokio::select! {
                _ = backend.shutdown.cancelled() => return Ok(()),
                result = native::send(&reminder.occurrence_id, "Routine due", &reminder.title) => result,
            }
        };
        backend.database.record_delivery(
            &reminder.routine_id,
            &reminder.occurrence_id,
            &now.to_rfc3339(),
            result.as_ref().err().map(String::as_str),
        )?;
        if let Err(error) = result {
            report_error(app, &error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn one_pending_occurrence_survives_days_without_catchup() {
        let now = DateTime::parse_from_rfc3339("2026-09-08T18:00:00Z")
            .unwrap()
            .to_utc();
        let mut state = json!({"runtime":"desktop","items":[{"id":"daily","title":"Announce then increase","status":"available","routine":{"nextDueAt":"2026-09-01T17:00:00.000Z","occurrences":[]}}]});
        let candidate = candidates(&state, now);
        assert_eq!(candidate.len(), 1);
        assert_eq!(candidate[0].occurrence_id, "daily@2026-09-01T17:00:00.000Z");
        state["items"][0]["routine"]["occurrences"] = json!([{"id":candidate[0].occurrence_id,"dueAt":"2026-09-01T17:00:00.000Z","status":"outstanding","steps":[]}]);
        state["items"][0]["routine"]["nextDueAt"] = json!("2026-09-09T17:00:00Z");
        assert_eq!(candidates(&state, now), candidate);
        state["items"][0]["routine"]["occurrences"][0]["snoozedUntil"] =
            json!("2026-09-09T00:00:00Z");
        assert!(candidates(&state, now).is_empty());
        state["items"][0]["routine"]["occurrences"][0]["snoozedUntil"] =
            json!("2026-09-08T00:00:00Z");
        state["items"][0]["routine"]["occurrences"][0]["reminderDismissed"] = json!(true);
        assert!(candidates(&state, now).is_empty());
        state["runtime"] = json!("demo");
        assert!(candidates(&state, now).is_empty());
    }

    #[test]
    fn inactive_and_finished_routines_never_notify() {
        let now = DateTime::parse_from_rfc3339("2026-09-08T18:00:00Z")
            .unwrap()
            .to_utc();
        let mut state = json!({"runtime":"desktop","items":[{"id":"r","title":"Routine","status":"available","routine":{"nextDueAt":"2026-09-09T17:00:00Z","occurrences":[{"id":"r@one","dueAt":"2026-09-08T17:00:00Z","status":"completed","steps":[]}]}}]});
        assert!(candidates(&state, now).is_empty());
        state["items"][0]["routine"]["occurrences"][0]["status"] = json!("outstanding");
        assert_eq!(candidates(&state, now).len(), 1);
        for status in ["waiting", "deferred", "removed", "completed"] {
            state["items"][0]["status"] = json!(status);
            assert!(candidates(&state, now).is_empty());
        }
    }

    #[tokio::test]
    async fn unbundled_test_process_cannot_claim_permission() {
        let status = status().await;
        assert_eq!(status.permission, "unavailable");
        assert!(status.error.is_some());
    }
}
