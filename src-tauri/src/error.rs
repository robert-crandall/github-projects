use serde::Serialize;

pub type Result<T> = std::result::Result<T, NativeError>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl NativeError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: matches!(code, "storage-busy" | "io" | "notification-unavailable"),
        }
    }
    pub fn invalid() -> Self {
        Self::new(
            "invalid-input",
            "The native request has an invalid or unsupported format.",
        )
    }
    pub fn corrupt() -> Self {
        Self::new("storage-corrupt", "The workspace is damaged. It has not been reset. Export the saved files or explicitly recover a backup.")
    }
    pub fn conflict() -> Self {
        Self::new(
            "revision-conflict",
            "The saved workspace changed. Reload it before applying pending changes.",
        )
    }
}

impl std::fmt::Display for NativeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for NativeError {}

impl From<std::io::Error> for NativeError {
    fn from(_: std::io::Error) -> Self {
        Self::new("io", "The workspace files could not be accessed. Check disk space and folder permissions; the operation was not confirmed.")
    }
}
impl From<rusqlite::Error> for NativeError {
    fn from(error: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(failure, _) = &error {
            use rusqlite::ErrorCode;
            return match failure.code {
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => Self::new("storage-busy", "The workspace is busy. Retry the operation."),
                ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase => Self::corrupt(),
                _ => Self::new("storage-failed", "SQLite could not complete the operation. Your changes have not been confirmed saved."),
            };
        }
        Self::corrupt()
    }
}
