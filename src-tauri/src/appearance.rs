//! Appearance preferences live in their own bounded JSON file, outside workspace backups.
//! Construction performs no I/O; a failed read never prevents the window from opening.

use crate::error::{NativeError, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
};
use tauri::{webview::Color, Manager, Theme};

const MAX_NAME_CHARS: usize = 100;
const MAX_PREFERENCES_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppearanceMode {
    Light,
    Dark,
    System,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppearancePreferences {
    pub name: String,
    pub mode: AppearanceMode,
}

impl AppearancePreferences {
    fn encode(&self) -> Result<Vec<u8>> {
        if self.name.len() > MAX_NAME_CHARS * 4
            || self.name.trim().is_empty()
            || self.name.chars().count() > MAX_NAME_CHARS
            || self.name.chars().any(char::is_control)
        {
            return Err(NativeError::invalid());
        }
        let bytes = serde_json::to_vec(self).map_err(|_| NativeError::invalid())?;
        if bytes.len() > MAX_PREFERENCES_BYTES {
            return Err(NativeError::invalid());
        }
        Ok(bytes)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppearanceTone {
    Light,
    Dark,
}

impl From<AppearanceTone> for Theme {
    fn from(tone: AppearanceTone) -> Self {
        match tone {
            AppearanceTone::Light => Self::Light,
            AppearanceTone::Dark => Self::Dark,
        }
    }
}

fn window_theme(mode: AppearanceMode, tone: AppearanceTone) -> Option<Theme> {
    match mode {
        AppearanceMode::System => None,
        _ => Some(tone.into()),
    }
}

fn background_color(value: &str) -> Result<Color> {
    let bytes = value.as_bytes();
    if bytes.len() != 7 || bytes[0] != b'#' || !bytes[1..].iter().all(u8::is_ascii_hexdigit) {
        return Err(NativeError::invalid());
    }
    let channel = |range| u8::from_str_radix(&value[range], 16).map_err(|_| NativeError::invalid());
    Ok(Color(channel(1..3)?, channel(3..5)?, channel(5..7)?, 255))
}

pub fn apply(
    app: &tauri::AppHandle,
    tone: AppearanceTone,
    background: &str,
    mode: AppearanceMode,
) -> Result<()> {
    let color = background_color(background)?;
    let unavailable = || NativeError {
        code: "appearance-unavailable".into(),
        message: "The window appearance could not be applied. Retry after the window is available."
            .into(),
        retryable: true,
    };
    let window = app.get_webview_window("main").ok_or_else(unavailable)?;
    window
        .set_theme(window_theme(mode, tone))
        .map_err(|_| unavailable())?;
    // Tauri updates both layers where supported; macOS only supports the window layer.
    window
        .set_background_color(Some(color))
        .map_err(|_| unavailable())
}

fn corrupt() -> NativeError {
    NativeError::new(
        "appearance-corrupt",
        "The saved appearance preferences are invalid. They have not been reset. Choose an appearance to replace them.",
    )
}

fn io_error(_: std::io::Error) -> NativeError {
    NativeError::new(
        "io",
        "The appearance preferences could not be accessed. Check disk space and folder permissions; the operation was not confirmed.",
    )
}

pub struct AppearanceStore {
    directory: PathBuf,
}

impl AppearanceStore {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    fn path(&self) -> PathBuf {
        self.directory.join("appearance.json")
    }

    pub fn read(&self) -> Result<Option<AppearancePreferences>> {
        match fs::symlink_metadata(self.path()) {
            Ok(metadata)
                if metadata.is_file() && metadata.len() <= MAX_PREFERENCES_BYTES as u64 => {}
            Ok(_) => return Err(corrupt()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(error)),
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut bytes = Vec::new();
        options
            .open(self.path())
            .map_err(io_error)?
            .take((MAX_PREFERENCES_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() > MAX_PREFERENCES_BYTES {
            return Err(corrupt());
        }
        let preferences: AppearancePreferences =
            serde_json::from_slice(&bytes).map_err(|_| corrupt())?;
        preferences.encode().map_err(|_| corrupt())?;
        Ok(Some(preferences))
    }

    pub fn save(&self, preferences: AppearancePreferences) -> Result<()> {
        let bytes = preferences.encode()?;
        fs::create_dir_all(&self.directory).map_err(io_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))
                .map_err(io_error)?;
        }
        let staging = self
            .directory
            .join(format!("appearance-{}.pending", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&staging).map_err(io_error)?;
        let result = (|| {
            file.write_all(&bytes).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            drop(file);
            fs::rename(&staging, self.path()).map_err(io_error)?;
            File::open(&self.directory)
                .and_then(|directory| directory.sync_all())
                .map_err(io_error)?;
            Ok(())
        })();
        if result.is_err() {
            match fs::remove_file(&staging) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(io_error(error)),
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn system_mode_releases_the_native_override_so_media_queries_follow_the_os() {
        assert_eq!(
            window_theme(AppearanceMode::System, AppearanceTone::Dark),
            None
        );
        assert_eq!(
            window_theme(AppearanceMode::System, AppearanceTone::Light),
            None
        );
        assert_eq!(
            window_theme(AppearanceMode::Dark, AppearanceTone::Dark),
            Some(Theme::Dark)
        );
        assert_eq!(
            window_theme(AppearanceMode::Light, AppearanceTone::Light),
            Some(Theme::Light)
        );
    }

    fn directory() -> tempfile::TempDir {
        tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap()
    }

    fn preferences(name: &str, mode: AppearanceMode) -> AppearancePreferences {
        AppearancePreferences {
            name: name.into(),
            mode,
        }
    }

    #[test]
    fn missing_preferences_return_null_without_creating_files() {
        let directory = directory();
        let path = directory.path().join("absent");
        let store = AppearanceStore::new(path.clone());
        assert_eq!(
            serde_json::to_value(store.read().unwrap()).unwrap(),
            json!(null)
        );
        assert!(!path.exists());
    }

    #[test]
    fn preferences_roundtrip_all_modes_and_replace_atomically() {
        let directory = directory();
        let store = AppearanceStore::new(directory.path().into());
        for (mode, serialized) in [
            (AppearanceMode::Light, "light"),
            (AppearanceMode::Dark, "dark"),
            (AppearanceMode::System, "system"),
        ] {
            let expected = preferences("An unknown catalog theme", mode);
            assert_eq!(
                serde_json::to_value(store.save(expected.clone()).unwrap()).unwrap(),
                json!(null)
            );
            let reopened = AppearanceStore::new(directory.path().into());
            assert_eq!(reopened.read().unwrap(), Some(expected));
            assert_eq!(
                serde_json::to_value(reopened.read().unwrap()).unwrap(),
                json!({"name": "An unknown catalog theme", "mode": serialized})
            );
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(store.path()).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn workspace_backups_and_recovery_do_not_include_appearance() {
        use crate::{model::Snapshot, storage::Store};

        let directory = directory();
        let mut workspace = Store::new(directory.path().into()).unwrap();
        let appearance = AppearanceStore::new(directory.path().into());
        let empty = workspace.read().unwrap();
        let saved = workspace
            .save(
                &empty.revision,
                Snapshot {
                    format_version: 1,
                    workspace: json!({"version": 1}),
                    reminders: vec![],
                },
            )
            .unwrap();
        appearance
            .save(preferences("Before backup", AppearanceMode::Light))
            .unwrap();
        let backup = workspace.create_backup(&saved.revision).unwrap();
        let expected = preferences("After backup", AppearanceMode::Dark);
        appearance.save(expected.clone()).unwrap();
        assert_eq!(workspace.read().unwrap().revision, saved.revision);
        assert!(!workspace
            .export_json(&saved.revision)
            .unwrap()
            .contains("appearance"));
        let exported = workspace.export_raw().unwrap();
        assert!(!PathBuf::from(exported.directory)
            .join("appearance.json")
            .exists());
        workspace
            .recover(&backup.id, &workspace.status().recovery_token)
            .unwrap();
        assert_eq!(appearance.read().unwrap(), Some(expected));
    }

    #[test]
    fn invalid_names_do_not_replace_saved_preferences() {
        let directory = directory();
        let store = AppearanceStore::new(directory.path().into());
        let expected = preferences("Original", AppearanceMode::System);
        store.save(expected.clone()).unwrap();
        for name in [
            "".into(),
            " ".into(),
            "\n".into(),
            "x\0y".into(),
            "x".repeat(101),
            "🌙".repeat(101),
        ] {
            assert_eq!(
                store
                    .save(preferences(&name, AppearanceMode::Light))
                    .unwrap_err()
                    .code,
                "invalid-input"
            );
            assert_eq!(store.read().unwrap(), Some(expected.clone()));
        }
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn names_at_character_and_serialization_bounds_roundtrip() {
        let directory = directory();
        let store = AppearanceStore::new(directory.path().into());
        for name in ["x".repeat(100), "🌙".repeat(100), "\"\\".repeat(50)] {
            let expected = preferences(&name, AppearanceMode::Dark);
            assert!(expected.encode().unwrap().len() <= MAX_PREFERENCES_BYTES);
            store.save(expected.clone()).unwrap();
            assert_eq!(store.read().unwrap(), Some(expected));
        }
    }

    #[test]
    fn corrupt_or_oversized_preferences_are_not_reset() {
        let directory = directory();
        let store = AppearanceStore::new(directory.path().into());
        for bytes in [
            b"".to_vec(),
            b"{".to_vec(),
            b"null".to_vec(),
            vec![0xff],
            serde_json::to_vec(&json!({"name": "Theme", "mode": "sepia"})).unwrap(),
            serde_json::to_vec(&json!({"name": "Theme", "mode": "Dark"})).unwrap(),
            serde_json::to_vec(&json!({"name": "", "mode": "dark"})).unwrap(),
            serde_json::to_vec(&json!({"name": "x".repeat(101), "mode": "dark"})).unwrap(),
            serde_json::to_vec(&json!({"name": "Theme", "mode": null})).unwrap(),
            serde_json::to_vec(&json!({"name": "Theme"})).unwrap(),
            serde_json::to_vec(&json!({"name": "Theme", "mode": "dark", "extra": true})).unwrap(),
            vec![b' '; MAX_PREFERENCES_BYTES + 1],
        ] {
            fs::write(store.path(), &bytes).unwrap();
            assert_eq!(store.read().unwrap_err().code, "appearance-corrupt");
            assert_eq!(fs::read(store.path()).unwrap(), bytes);
        }
        // Only an explicit save replaces damaged preferences.
        let expected = preferences("Recovered", AppearanceMode::Light);
        store.save(expected.clone()).unwrap();
        assert_eq!(store.read().unwrap(), Some(expected));
    }

    #[test]
    fn failed_replace_preserves_destination_and_removes_staging() {
        let directory = directory();
        let store = AppearanceStore::new(directory.path().into());
        fs::create_dir(store.path()).unwrap();
        fs::write(store.path().join("keep"), b"untouched").unwrap();
        let error = store
            .save(preferences("Theme", AppearanceMode::Dark))
            .unwrap_err();
        assert_eq!(error.code, "io");
        assert!(error.retryable);
        assert_eq!(fs::read(store.path().join("keep")).unwrap(), b"untouched");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        assert_eq!(store.read().unwrap_err().code, "appearance-corrupt");
    }

    #[test]
    fn read_io_failures_do_not_masquerade_as_missing_preferences() {
        let directory = directory();
        let path = directory.path().join("not-a-directory");
        fs::write(&path, b"untouched").unwrap();
        let store = AppearanceStore::new(path);
        assert_eq!(store.read().unwrap_err().code, "io");
    }

    #[test]
    fn tone_and_color_are_strict_and_opaque() {
        assert_eq!(Theme::from(AppearanceTone::Light), Theme::Light);
        assert_eq!(Theme::from(AppearanceTone::Dark), Theme::Dark);
        for tone in ["system", "Dark", "", "auto"] {
            assert!(serde_json::from_value::<AppearanceTone>(json!(tone)).is_err());
        }
        for color in [
            "",
            "#fff",
            "#1234567",
            "#12345678",
            "123456",
            "#gg0000",
            " #123456",
            "#１２３",
            "red",
            "rgb(0,0,0)",
        ] {
            assert_eq!(background_color(color).unwrap_err().code, "invalid-input");
        }
        assert_eq!(
            background_color("#aB09fF").unwrap(),
            Color(171, 9, 255, 255)
        );
        assert_eq!(background_color("#000000").unwrap(), Color(0, 0, 0, 255));
        assert_eq!(
            background_color("#ffffff").unwrap(),
            Color(255, 255, 255, 255)
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_does_not_follow_preference_symlinks() {
        let directory = directory();
        let store = AppearanceStore::new(directory.path().into());
        let target = directory.path().join("other.json");
        fs::write(&target, b"untouched").unwrap();
        std::os::unix::fs::symlink(&target, store.path()).unwrap();
        assert_eq!(store.read().unwrap_err().code, "appearance-corrupt");
        assert_eq!(fs::read(target).unwrap(), b"untouched");
    }
}
