use crate::{
    error::{NativeError, Result},
    model::digest,
};
use chrono::{DateTime, Utc};
use fs2::FileExt;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_MESSAGES: usize = 5_000;
const MAX_PAGES: usize = 2_000;
const MAX_PAGE_BYTES: usize = 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error> {
    Option::deserialize(deserializer)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConversationKind {
    Pr,
    Issue,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationReference {
    pub repo: String,
    pub number: u64,
    pub kind: ConversationKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ConversationStream {
    Description,
    Comments,
    Reviews,
    Inline,
}

impl ConversationStream {
    fn name(self) -> &'static str {
        match self {
            Self::Description => "description",
            Self::Comments => "comments",
            Self::Reviews => "reviews",
            Self::Inline => "inline",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationInput {
    pub reference: ConversationReference,
    pub stream: ConversationStream,
    #[serde(deserialize_with = "nullable")]
    pub page: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationMessage {
    pub id: String,
    pub kind: ConversationStream,
    pub body: String,
    #[serde(deserialize_with = "nullable")]
    pub author: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    #[serde(deserialize_with = "nullable")]
    pub reply_to: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub review_id: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub path: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub line: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationErrorCode {
    InvalidInput,
    InvalidOutput,
    MissingCli,
    Authentication,
    MissingScope,
    Access,
    RateLimit,
    Unavailable,
    Deadline,
    Cancelled,
    Busy,
    Protocol,
    Limit,
    Unsupported,
    CopilotUnavailable,
    CopilotOutput,
    Internal,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationError {
    pub code: ConversationErrorCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationPageMetadata {
    pub reference: ConversationReference,
    pub stream: ConversationStream,
    pub page: u32,
    pub newest_page: u32,
    #[serde(deserialize_with = "nullable")]
    pub older_page: Option<u32>,
    pub fetched_at: String,
    #[serde(deserialize_with = "nullable")]
    pub error: Option<ConversationError>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationPage {
    pub reference: ConversationReference,
    pub stream: ConversationStream,
    pub page: u32,
    pub newest_page: u32,
    #[serde(deserialize_with = "nullable")]
    pub older_page: Option<u32>,
    pub fetched_at: String,
    pub messages: Vec<ConversationMessage>,
    #[serde(deserialize_with = "nullable")]
    pub error: Option<ConversationError>,
}

impl ConversationPage {
    fn metadata(&self) -> ConversationPageMetadata {
        ConversationPageMetadata {
            reference: self.reference.clone(),
            stream: self.stream,
            page: self.page,
            newest_page: self.newest_page,
            older_page: self.older_page,
            fetched_at: self.fetched_at.clone(),
            error: self.error.clone(),
        }
    }

    pub fn validate(&self) -> Result<()> {
        self.metadata().validate()?;
        if self.messages.len() > 5
            || (self.stream == ConversationStream::Description && self.messages.len() > 1)
        {
            return Err(invalid());
        }
        for message in &self.messages {
            message.validate(&self.reference)?;
            if message.kind != self.stream {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationCache {
    pub reference: ConversationReference,
    pub messages: Vec<ConversationMessage>,
    pub pages: Vec<ConversationPageMetadata>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    cache: ConversationCache,
    // Separate clocks preserve edits when overlapping pages arrive out of order.
    fetched_at: BTreeMap<String, String>,
}

fn invalid() -> NativeError {
    NativeError::new(
        "invalid-input",
        "The conversation request has an invalid shape, source identity, or source URL.",
    )
}

fn corrupt() -> NativeError {
    NativeError::new(
        "conversation-cache-corrupt",
        "The conversation cache is unavailable or damaged. Reset it explicitly before reloading. Your notes are safe.",
    )
}

fn limited() -> NativeError {
    NativeError::new(
        "conversation-cache-limit",
        "The conversation cache limit was reached. Nothing was evicted or changed. Clear a source or reset the cache explicitly before reloading.",
    )
}

fn cache_error(error: rusqlite::Error) -> NativeError {
    match error {
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            NativeError {
                code: "conversation-cache-busy".into(),
                message: "The conversation cache is busy. Retry explicitly; your notes are safe."
                    .into(),
                retryable: true,
            }
        }
        _ => corrupt(),
    }
}

fn cache_io(_: std::io::Error) -> NativeError {
    NativeError::new(
        "conversation-cache-unavailable",
        "The conversation cache could not be accessed. Check disk space and permissions. Your notes are safe.",
    )
}

fn time(value: &str) -> Result<DateTime<Utc>> {
    if !value.ends_with('Z') || value.len() > 40 {
        return Err(invalid());
    }
    crate::model::timestamp(value).map_err(|_| invalid())
}

fn length(value: &str) -> usize {
    value.encode_utf16().count()
}

fn login(value: &str) -> bool {
    let value = value.strip_suffix("[bot]").unwrap_or(value);
    !value.is_empty()
        && value.len() <= 100
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

impl ConversationReference {
    pub fn validate(&self) -> Result<()> {
        let (owner, repo) = self.repo.split_once('/').ok_or_else(invalid)?;
        if owner.is_empty()
            || owner.len() > 100
            || !owner.as_bytes()[0].is_ascii_alphanumeric()
            || !owner
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || repo.is_empty()
            || repo.len() > 100
            || !(repo.as_bytes()[0].is_ascii_alphanumeric() || repo.as_bytes()[0] == b'_')
            || !repo
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
            || self.number == 0
            || self.number > MAX_SAFE_INTEGER
        {
            return Err(invalid());
        }
        Ok(())
    }

    fn key(&self) -> String {
        format!(
            "{}:{}:{}",
            self.repo.to_ascii_lowercase(),
            match self.kind {
                ConversationKind::Pr => "pr",
                ConversationKind::Issue => "issue",
            },
            self.number
        )
    }

    fn supports(&self, stream: ConversationStream) -> bool {
        self.kind == ConversationKind::Pr
            || matches!(
                stream,
                ConversationStream::Description | ConversationStream::Comments
            )
    }

    fn message_id(&self, value: &str, stream: ConversationStream) -> bool {
        let prefix = format!("github:{}:{}:", self.key(), stream.name());
        value.len() <= 500
            && value.strip_prefix(&prefix).is_some_and(|id| {
                !id.starts_with('0')
                    && id.bytes().all(|byte| byte.is_ascii_digit())
                    && id
                        .parse::<u64>()
                        .is_ok_and(|number| number > 0 && number <= MAX_SAFE_INTEGER)
            })
    }

    fn source_url(&self, value: &str) -> Result<()> {
        let url = crate::launch::web_url(value).map_err(|_| invalid())?;
        let url = url::Url::parse(&url).map_err(|_| invalid())?;
        let path = format!(
            "/{}/{}/{}",
            self.repo,
            match self.kind {
                ConversationKind::Pr => "pull",
                ConversationKind::Issue => "issues",
            },
            self.number
        );
        let anchor = url.fragment().is_none_or(|anchor| {
            [
                "issue-",
                "issuecomment-",
                "pullrequestreview-",
                "discussion_r",
            ]
            .iter()
            .any(|prefix| {
                anchor.strip_prefix(prefix).is_some_and(|id| {
                    !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())
                })
            })
        });
        if url.scheme() != "https"
            || url.host_str() != Some("github.com")
            || url.port().is_some()
            || url.query().is_some()
            || !url.path().eq_ignore_ascii_case(&path)
            || !anchor
        {
            return Err(invalid());
        }
        Ok(())
    }
}

impl ConversationInput {
    pub fn validate(&self) -> Result<()> {
        self.reference.validate()?;
        if !self.reference.supports(self.stream)
            || self.page.is_some_and(|page| !(1..=999_999).contains(&page))
            || (self.stream == ConversationStream::Description
                && self.page.is_some_and(|page| page != 1))
        {
            return Err(invalid());
        }
        Ok(())
    }
}

impl ConversationPageMetadata {
    fn validate(&self) -> Result<()> {
        self.reference.validate()?;
        time(&self.fetched_at)?;
        if !self.reference.supports(self.stream)
            || !(1..=999_999).contains(&self.page)
            || !(self.page..=999_999).contains(&self.newest_page)
            || self
                .older_page
                .is_some_and(|older| older == 0 || older >= self.page)
            || (self.stream == ConversationStream::Description
                && (self.page != 1 || self.newest_page != 1 || self.older_page.is_some()))
            || self
                .error
                .as_ref()
                .is_some_and(|error| length(&error.message) > 300)
        {
            return Err(invalid());
        }
        Ok(())
    }
}

impl ConversationMessage {
    fn validate(&self, reference: &ConversationReference) -> Result<()> {
        if !reference.supports(self.kind)
            || !reference.message_id(&self.id, self.kind)
            || length(&self.body) > 1_048_576
            || self.author.as_ref().is_some_and(|author| !login(author))
            || time(&self.updated_at)? < time(&self.created_at)?
            || length(&self.url) > 2_000
            || self
                .reply_to
                .as_ref()
                .is_some_and(|id| !reference.message_id(id, ConversationStream::Inline))
            || self
                .review_id
                .as_ref()
                .is_some_and(|id| !reference.message_id(id, ConversationStream::Reviews))
            || self.path.as_ref().is_some_and(|path| length(path) > 4_096)
            || self.line == Some(0)
            || (self.kind != ConversationStream::Inline
                && (self.reply_to.is_some()
                    || self.review_id.is_some()
                    || self.path.is_some()
                    || self.line.is_some()))
            || self.reply_to.as_ref() == Some(&self.id)
        {
            return Err(invalid());
        }
        reference.source_url(&self.url)
    }
}

impl Entry {
    fn empty(reference: ConversationReference) -> Self {
        Self {
            cache: ConversationCache {
                reference,
                messages: vec![],
                pages: vec![],
            },
            fetched_at: BTreeMap::new(),
        }
    }

    fn validate(&self, key: &str) -> Result<()> {
        self.cache.reference.validate()?;
        if self.cache.reference.key() != key
            || self.cache.messages.len() > MAX_MESSAGES
            || self.cache.pages.len() > MAX_PAGES
            || self.fetched_at.len() != self.cache.messages.len()
        {
            return Err(corrupt());
        }
        let mut ids = HashSet::new();
        for message in &self.cache.messages {
            message.validate(&self.cache.reference)?;
            if !ids.insert(&message.id) {
                return Err(corrupt());
            }
            time(self.fetched_at.get(&message.id).ok_or_else(corrupt)?)?;
        }
        let mut pages = HashSet::new();
        for page in &self.cache.pages {
            page.validate()?;
            if page.reference.key() != key || !pages.insert((page.stream, page.page)) {
                return Err(corrupt());
            }
        }
        Ok(())
    }

    fn merge(&mut self, page: ConversationPage) -> Result<()> {
        let fetched = time(&page.fetched_at)?;
        let metadata = page.metadata();
        let mut messages: BTreeMap<String, ConversationMessage> = self
            .cache
            .messages
            .drain(..)
            .map(|message| (message.id.clone(), message))
            .collect();
        for message in page.messages {
            let replace = match messages.get(&message.id) {
                None => true,
                Some(before) => {
                    let updated = time(&message.updated_at)?;
                    let previous = time(&before.updated_at)?;
                    updated > previous
                        || (updated == previous
                            && fetched
                                >= time(self.fetched_at.get(&message.id).ok_or_else(corrupt)?)?)
                }
            };
            if replace {
                self.fetched_at
                    .insert(message.id.clone(), page.fetched_at.clone());
                messages.insert(message.id.clone(), message);
            }
        }
        self.cache.messages = messages.into_values().collect();
        self.cache
            .messages
            .sort_by_cached_key(|message| (time(&message.created_at).unwrap(), message.id.clone()));
        match self
            .cache
            .pages
            .iter_mut()
            .find(|before| before.stream == page.stream && before.page == page.page)
        {
            Some(before) if fetched >= time(&before.fetched_at)? => *before = metadata,
            None => self.cache.pages.push(metadata),
            _ => {}
        }
        if self.cache.messages.len() > MAX_MESSAGES || self.cache.pages.len() > MAX_PAGES {
            return Err(limited());
        }
        Ok(())
    }
}

pub struct ConversationStore {
    directory: PathBuf,
}

struct CacheLock(File);

impl Drop for CacheLock {
    fn drop(&mut self) {
        // Release the advisory lock even if a spawning child briefly inherited the descriptor.
        let _ = FileExt::unlock(&self.0);
    }
}

impl ConversationStore {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    fn path(&self) -> PathBuf {
        self.directory.join("conversations.sqlite3")
    }

    fn lock(&self, create: bool) -> Result<Option<CacheLock>> {
        if !create {
            match fs::symlink_metadata(self.path()) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(cache_io(error)),
                _ => {}
            }
        }
        fs::create_dir_all(&self.directory).map_err(cache_io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))
                .map_err(cache_io)?;
        }
        let file = private_file(&self.directory.join("conversations.lock"), false)?;
        file.try_lock_exclusive().map_err(|_| NativeError {
            code: "conversation-cache-busy".into(),
            message: "The conversation cache is busy. Retry explicitly; your notes are safe."
                .into(),
            retryable: true,
        })?;
        Ok(Some(CacheLock(file)))
    }

    fn open(&self, create: bool) -> Result<Option<Connection>> {
        self.open_path(&self.path(), create)
    }

    fn open_path(&self, path: &Path, create: bool) -> Result<Option<Connection>> {
        let absent = match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() => false,
            Ok(_) => return Err(corrupt()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => return Err(cache_io(error)),
        };
        if absent && !create {
            return Ok(None);
        }
        if absent {
            fs::create_dir_all(&self.directory).map_err(cache_io)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))
                    .map_err(cache_io)?;
            }
            private_file(path, true)?;
        }
        // SQLite NOFOLLOW also rejects ancestor aliases such as macOS /var.
        // Resolve only the parent so the database itself still cannot be a symlink.
        let canonical_path = fs::canonicalize(path.parent().ok_or_else(corrupt)?)
            .map_err(cache_io)?
            .join(path.file_name().ok_or_else(corrupt)?);
        let connection = Connection::open_with_flags(
            canonical_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(cache_error)?;
        connection
            .busy_timeout(Duration::from_secs(2))
            .map_err(cache_error)?;
        connection
            .set_limit(
                rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
                (MAX_SOURCE_BYTES + 65_536) as i32,
            )
            .map_err(cache_error)?;
        connection
            .execute_batch("PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;")
            .map_err(cache_error)?;
        if absent {
            connection
                .execute_batch(
                    "BEGIN IMMEDIATE;
                     CREATE TABLE entries (
                       source_key TEXT PRIMARY KEY NOT NULL,
                       payload TEXT NOT NULL,
                       checksum TEXT NOT NULL
                     );
                     PRAGMA user_version=1;
                     COMMIT;",
                )
                .map_err(cache_error)?;
            File::open(&self.directory)
                .and_then(|file| file.sync_all())
                .map_err(cache_io)?;
        }
        Self::validate_schema(&connection)?;
        Ok(Some(connection))
    }

    fn validate_schema(connection: &Connection) -> Result<()> {
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(cache_error)?;
        if version != 1 {
            return Err(NativeError::new(
                "conversation-cache-schema",
                "The conversation cache schema is unsupported. Reset it explicitly before reloading. Your notes are safe.",
            ));
        }
        let integrity: String = connection
            .pragma_query_value(None, "quick_check", |row| row.get(0))
            .map_err(cache_error)?;
        let columns: Vec<(String, String, i64, i64)> = connection
            .prepare("SELECT name,type,\"notnull\",pk FROM pragma_table_info('entries')")
            .map_err(cache_error)?
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(cache_error)?
            .collect::<std::result::Result<_, _>>()
            .map_err(cache_error)?;
        let objects: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get(0),
            )
            .map_err(cache_error)?;
        if integrity != "ok"
            || objects != 1
            || columns
                != vec![
                    ("source_key".into(), "TEXT".into(), 1, 1),
                    ("payload".into(), "TEXT".into(), 1, 0),
                    ("checksum".into(), "TEXT".into(), 1, 0),
                ]
        {
            return Err(corrupt());
        }
        Ok(())
    }

    fn total(connection: &Connection) -> Result<usize> {
        let (total, largest): (i64, i64) = connection
            .query_row(
                "SELECT coalesce(sum(length(CAST(payload AS BLOB))),0),
                        coalesce(max(length(CAST(payload AS BLOB))),0) FROM entries",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(cache_error)?;
        if total < 0 || total > MAX_TOTAL_BYTES as i64 || largest > MAX_SOURCE_BYTES as i64 {
            return Err(corrupt());
        }
        Ok(total as usize)
    }

    fn read_entry(connection: &Connection, key: &str) -> Result<Option<(Entry, usize)>> {
        let row: Option<(String, String)> = connection
            .query_row(
                "SELECT payload,checksum FROM entries WHERE source_key=?",
                [key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(cache_error)?;
        row.map(|(payload, checksum)| {
            if payload.len() > MAX_SOURCE_BYTES || digest(payload.as_bytes()) != checksum {
                return Err(corrupt());
            }
            let entry: Entry = serde_json::from_str(&payload).map_err(|_| corrupt())?;
            entry.validate(key).map_err(|_| corrupt())?;
            Ok((entry, payload.len()))
        })
        .transpose()
    }

    pub fn read(&self, reference: ConversationReference) -> Result<Option<ConversationCache>> {
        reference.validate()?;
        let Some(_lock) = self.lock(false)? else {
            return Ok(None);
        };
        let Some(connection) = self.open(false)? else {
            return Ok(None);
        };
        Self::total(&connection)?;
        Ok(Self::read_entry(&connection, &reference.key())?.map(|(entry, _)| entry.cache))
    }

    pub fn merge(&mut self, page: ConversationPage) -> Result<ConversationCache> {
        page.validate()?;
        if serde_json::to_vec(&page).map_err(|_| invalid())?.len() > MAX_PAGE_BYTES {
            return Err(NativeError::new(
                "conversation-page-limit",
                "The conversation page exceeds the 1 MiB transport limit. It was not cached. Your notes are safe.",
            ));
        }
        let _lock = self.lock(true)?;
        let key = page.reference.key();
        let mut connection = self.open(true)?.ok_or_else(corrupt)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(cache_error)?;
        let total = Self::total(&transaction)?;
        let (mut entry, previous_bytes) = Self::read_entry(&transaction, &key)?
            .unwrap_or_else(|| (Entry::empty(page.reference.clone()), 0));
        entry.merge(page)?;
        let payload = serde_json::to_string(&entry).map_err(|_| invalid())?;
        if payload.len() > MAX_SOURCE_BYTES
            || total - previous_bytes + payload.len() > MAX_TOTAL_BYTES
        {
            return Err(limited());
        }
        transaction
            .execute(
                "INSERT INTO entries(source_key,payload,checksum) VALUES(?,?,?)
                 ON CONFLICT(source_key) DO UPDATE SET payload=excluded.payload,checksum=excluded.checksum",
                params![key, payload, digest(payload.as_bytes())],
            )
            .map_err(cache_error)?;
        transaction.commit().map_err(cache_error)?;
        Ok(entry.cache)
    }

    pub fn clear(&mut self, reference: ConversationReference) -> Result<()> {
        reference.validate()?;
        let Some(_lock) = self.lock(false)? else {
            return Ok(());
        };
        let Some(mut connection) = self.open(false)? else {
            return Ok(());
        };
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(cache_error)?;
        // Explicit deletion can recover one damaged entry without reading or resetting its peers.
        transaction
            .execute("DELETE FROM entries WHERE source_key=?", [reference.key()])
            .map_err(cache_error)?;
        transaction.commit().map_err(cache_error)?;
        Ok(())
    }

    pub fn reset(&mut self) -> Result<()> {
        let _lock = self.lock(true)?;
        let name = format!(
            "cache-recovery-{}-{}.sqlite3",
            Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
            uuid::Uuid::new_v4()
        );
        let replacement = self.directory.join(format!("replacement-{name}"));
        let components: Vec<_> = ["", "-journal", "-wal", "-shm"]
            .iter()
            .map(|suffix| {
                (
                    self.directory
                        .join(format!("conversations.sqlite3{suffix}")),
                    self.directory.join(format!("{name}{suffix}")),
                )
            })
            .filter_map(|(source, target)| match fs::symlink_metadata(&source) {
                Ok(metadata) if metadata.is_file() => Some(Ok((source, target))),
                Ok(_) => Some(Err(corrupt())),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => Some(Err(cache_io(error))),
            })
            .collect::<Result<_>>()?;
        let result = (|| {
            drop(self.open_path(&replacement, true)?.ok_or_else(corrupt)?);
            // Preserve raw bytes, including recovery journals, without opening the damaged DB.
            for (source, target) in &components {
                let mut original = OpenOptions::new()
                    .read(true)
                    .open(source)
                    .map_err(cache_io)?;
                let mut preserved = private_file(target, true)?;
                std::io::copy(&mut original, &mut preserved).map_err(cache_io)?;
                preserved.sync_all().map_err(cache_io)?;
            }
            File::open(&self.directory)
                .and_then(|file| file.sync_all())
                .map_err(cache_io)?;
            let mut retired = vec![];
            let replace: Result<()> = (|| {
                for (source, preserved) in &components {
                    if source != &self.path() {
                        fs::remove_file(source).map_err(cache_io)?;
                        retired.push((source, preserved));
                    }
                }
                fs::rename(&replacement, self.path()).map_err(cache_io)?;
                Ok(())
            })();
            if replace.is_err() {
                // Restore detached journals if replacement failed; the raw archive stays intact.
                for (source, preserved) in retired {
                    fs::copy(preserved, source).map_err(cache_io)?;
                }
            }
            replace?;
            File::open(&self.directory)
                .and_then(|file| file.sync_all())
                .map_err(cache_io)?;
            Ok(())
        })();
        if replacement.exists() {
            fs::remove_file(&replacement).map_err(cache_io)?;
        }
        result
    }
}

fn private_file(path: &Path, exclusive: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).truncate(false);
    if exclusive {
        options.create_new(true);
    } else {
        options.create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path).map_err(cache_io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model::Snapshot, storage::Store};
    use serde_json::json;

    fn directory() -> tempfile::TempDir {
        tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap()
    }

    fn reference(number: u64) -> ConversationReference {
        ConversationReference {
            repo: "octo/project".into(),
            number,
            kind: ConversationKind::Pr,
        }
    }

    fn page(number: u64, index: u32, ids: &[u64]) -> ConversationPage {
        let reference = reference(number);
        ConversationPage {
            reference: reference.clone(),
            stream: ConversationStream::Comments,
            page: index,
            newest_page: index,
            older_page: (index > 1).then(|| index - 1),
            fetched_at: "2026-09-11T01:00:00Z".into(),
            messages: ids
                .iter()
                .map(|id| ConversationMessage {
                    id: format!("github:{}:comments:{id}", reference.key()),
                    kind: ConversationStream::Comments,
                    body: format!("Message {id}"),
                    author: Some("author[bot]".into()),
                    created_at: "2026-09-10T00:00:00Z".into(),
                    updated_at: "2026-09-10T00:00:00Z".into(),
                    url: format!("https://github.com/octo/project/pull/{number}#issuecomment-{id}"),
                    reply_to: None,
                    review_id: None,
                    path: None,
                    line: None,
                })
                .collect(),
            error: None,
        }
    }

    fn notes(note: &str) -> Snapshot {
        Snapshot {
            format_version: 1,
            workspace: json!({"version":1, "state":{"version":3, "notes":note}}),
            reminders: vec![],
        }
    }

    fn encoded(cache: &ConversationCache) -> String {
        serde_json::to_string(cache).unwrap()
    }

    fn add_bytes(store: &mut ConversationStore, source: u64, mut bytes: usize) {
        let mut index = 1;
        while bytes > 0 {
            let size = bytes.min(900_000);
            let mut input = page(source, index, &[index as u64]);
            input.messages[0].body = "x".repeat(size);
            store.merge(input).unwrap();
            bytes -= size;
            index += 1;
        }
    }

    #[test]
    fn absent_reads_are_offline_and_do_not_initialize_any_files() {
        let dir = directory();
        let store = ConversationStore::new(dir.path().join("not-created"));
        assert!(store.read(reference(1)).unwrap().is_none());
        assert!(!store.directory.exists());
        let runtime = include_str!("lib.rs");
        let commands = runtime
            .split("async fn conversation_read")
            .nth(1)
            .unwrap()
            .split("fn clock_now")
            .next()
            .unwrap();
        assert!(!commands.contains("ServiceHost"));
        assert!(!commands.contains("service_request"));
    }

    #[cfg(unix)]
    #[test]
    fn fresh_cache_accepts_a_symlinked_parent_but_not_a_symlinked_database() {
        let dir = directory();
        let actual = dir.path().join("actual");
        let alias = dir.path().join("alias");
        fs::create_dir(&actual).unwrap();
        std::os::unix::fs::symlink(&actual, &alias).unwrap();
        let mut store = ConversationStore::new(alias.join("app-data"));
        assert!(store.read(reference(1)).unwrap().is_none());
        assert_eq!(store.merge(page(1, 1, &[1])).unwrap().messages.len(), 1);
        assert_eq!(store.read(reference(1)).unwrap().unwrap().messages.len(), 1);
        store.reset().unwrap();
        assert!(store.read(reference(1)).unwrap().is_none());
        let path = store.path();
        let preserved = actual.join("not-the-cache.sqlite3");
        fs::rename(&path, &preserved).unwrap();
        std::os::unix::fs::symlink(&preserved, &path).unwrap();
        let original = fs::read(&preserved).unwrap();
        assert!(store.read(reference(1)).is_err());
        assert!(store.merge(page(1, 1, &[1])).is_err());
        assert!(store.reset().is_err());
        assert_eq!(fs::read(preserved).unwrap(), original);
    }

    #[test]
    fn edits_overlap_page_metadata_and_partial_errors_merge_without_loss() {
        let dir = directory();
        let mut store = ConversationStore::new(dir.path().into());
        store.merge(page(1, 2, &[2, 3])).unwrap();
        let mut old = page(1, 1, &[1, 2, 2]);
        old.messages[2].body = "duplicate last arrival".into();
        assert_eq!(store.merge(old).unwrap().messages.len(), 3);

        let mut edit = page(1, 2, &[2]);
        edit.fetched_at = "2026-09-12T01:00:00Z".into();
        edit.messages[0].updated_at = "2026-09-11T00:00:00Z".into();
        edit.messages[0].body = "edited body".into();
        store.merge(edit.clone()).unwrap();
        let mut stale = page(1, 2, &[2]);
        stale.newest_page = 50;
        stale.messages[0].body = "stale body".into();
        let result = store.merge(stale).unwrap();
        assert_eq!(result.messages[1].body, "edited body");
        assert_eq!(result.pages[0].newest_page, 2);

        let mut equal_older_fetch = edit.clone();
        equal_older_fetch.fetched_at = "2026-09-11T02:00:00Z".into();
        equal_older_fetch.messages[0].body = "older fetched body".into();
        store.merge(equal_older_fetch).unwrap();
        assert_eq!(
            store.read(reference(1)).unwrap().unwrap().messages[1].body,
            "edited body"
        );
        edit.fetched_at = "2026-09-13T01:00:00Z".into();
        edit.messages[0].body = "latest fetched body".into();
        store.merge(edit).unwrap();

        let mut failed = page(1, 2, &[]);
        failed.fetched_at = "2026-09-14T01:00:00Z".into();
        failed.error = Some(ConversationError {
            code: ConversationErrorCode::Access,
            message: "Access unavailable".into(),
            retryable: false,
        });
        let result = store.merge(failed.clone()).unwrap();
        assert_eq!(result.messages.len(), 3);
        assert_eq!(result.messages[1].body, "latest fetched body");
        assert!(result.pages[0].error.is_some());
        failed.messages = page(1, 2, &[4]).messages;
        assert_eq!(store.merge(failed).unwrap().messages.len(), 4);
        let persisted = store.read(reference(1)).unwrap().unwrap();
        assert_eq!(
            encoded(&persisted),
            encoded(
                &ConversationStore::new(dir.path().into())
                    .read(reference(1))
                    .unwrap()
                    .unwrap()
            )
        );
    }

    #[test]
    fn normalized_source_keys_do_not_collide_with_kinds_or_other_repositories() {
        let dir = directory();
        let mut store = ConversationStore::new(dir.path().into());
        store.merge(page(1, 1, &[1])).unwrap();
        let mut mixed = page(1, 1, &[2]);
        mixed.reference.repo = "Octo/Project".into();
        assert_eq!(store.merge(mixed).unwrap().messages.len(), 2);
        let mut other = reference(1);
        other.kind = ConversationKind::Issue;
        assert!(store.read(other).unwrap().is_none());
        let mut other = reference(1);
        other.repo = "octo/project-other".into();
        assert!(store.read(other).unwrap().is_none());
        assert!(store.read(reference(2)).unwrap().is_none());
    }

    #[test]
    fn descriptions_and_inline_reply_identity_preserve_the_exact_wire_contract() {
        let dir = directory();
        let mut store = ConversationStore::new(dir.path().into());
        let mut description = page(1, 1, &[1]);
        description.stream = ConversationStream::Description;
        description.messages[0].kind = ConversationStream::Description;
        description.messages[0].id = "github:octo/project:pr:1:description:1".into();
        description.messages[0].url = "https://github.com/octo/project/pull/1".into();
        let value = serde_json::to_value(store.merge(description).unwrap()).unwrap();
        assert_eq!(value["messages"][0]["kind"], "description");
        assert!(value.get("fetchedAt").is_none());
        assert!(value["pages"][0].get("messages").is_none());
        assert_eq!(value["pages"][0].as_object().unwrap().len(), 7);

        let mut inline = page(1, 1, &[2]);
        inline.stream = ConversationStream::Inline;
        let message = &mut inline.messages[0];
        message.kind = ConversationStream::Inline;
        message.id = "github:octo/project:pr:1:inline:2".into();
        message.reply_to = Some("github:octo/project:pr:1:inline:1".into());
        message.review_id = Some("github:octo/project:pr:1:reviews:9".into());
        message.path = Some("src/a.rs".into());
        message.line = Some(10);
        message.url = "https://github.com/octo/project/pull/1#discussion_r2".into();
        let result = store.merge(inline).unwrap();
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.messages[1].path.as_deref(), Some("src/a.rs"));
    }

    #[test]
    fn malformed_shapes_sources_and_urls_are_rejected_before_creating_cache() {
        let dir = directory();
        let mut store = ConversationStore::new(dir.path().into());
        for field in ["error", "olderPage"] {
            let mut value = serde_json::to_value(page(1, 1, &[1])).unwrap();
            value.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<ConversationPage>(value).is_err());
        }
        for field in ["author", "replyTo", "reviewId", "path", "line"] {
            let mut value = serde_json::to_value(page(1, 1, &[1])).unwrap();
            value["messages"][0].as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<ConversationPage>(value).is_err());
        }
        for value in [
            json!({"repo":"octo/project","kind":"pr","number":1,"notificationId":"23"}),
            json!({"repo":"octo/project","kind":"pr","number":-1}),
            json!({"repo":"octo/project","kind":"pr","number":1.5}),
        ] {
            assert!(serde_json::from_value::<ConversationReference>(value).is_err());
        }
        for repo in [
            "octo/project/extra",
            "../project",
            "octo/repo?arg",
            "octo/.",
        ] {
            let mut input = page(1, 1, &[1]);
            input.reference.repo = repo.into();
            assert!(store.merge(input).is_err());
        }
        for url in [
            "https://evil.example/octo/project/pull/1",
            "https://github.com/other/project/pull/1",
            "https://github.com/octo/project/issues/1",
            "https://github.com/octo/project/pull/2",
            "https://github.com/octo/project/pull/1?secret=1",
            "https://github.com/octo/project/pull/1#unexpected",
            "https://github.com/octo/project/pull/1#issuecomment-1%0a",
            "http://github.com/octo/project/pull/1",
            "https://user@github.com/octo/project/pull/1",
        ] {
            let mut input = page(1, 1, &[1]);
            input.messages[0].url = url.into();
            assert!(store.merge(input).is_err(), "{url}");
        }
        for id in [
            "github:other/project:pr:1:comments:1",
            "github:octo/project:issue:1:comments:1",
            "github:octo/project:pr:1:reviews:1",
            "github:octo/project:pr:1:comments:0",
        ] {
            let mut input = page(1, 1, &[1]);
            input.messages[0].id = id.into();
            assert!(store.merge(input).is_err(), "{id}");
        }
        assert!(!store.path().exists());
    }

    #[test]
    fn conversations_over_eight_mib_leave_notes_revisions_and_backups_unchanged() {
        let dir = directory();
        let mut workspace = Store::new(dir.path().into()).unwrap();
        let saved = workspace
            .save(
                &workspace.read().unwrap().revision,
                notes("private offline note"),
            )
            .unwrap();
        let database = fs::read(workspace.path()).unwrap();
        let backup = fs::read(dir.path().join("backups/latest.sqlite3")).unwrap();
        let mut store = ConversationStore::new(dir.path().into());
        for source in 1..=3 {
            add_bytes(&mut store, source, 3 * 1024 * 1024);
        }
        assert!(
            ConversationStore::total(&store.open(false).unwrap().unwrap()).unwrap()
                > 8 * 1024 * 1024
        );
        assert_eq!(workspace.read().unwrap().revision, saved.revision);
        assert!(workspace.export_json(&saved.revision).unwrap().len() < 1024);
        assert_eq!(fs::read(workspace.path()).unwrap(), database);
        assert_eq!(
            fs::read(dir.path().join("backups/latest.sqlite3")).unwrap(),
            backup
        );
        let deliveries: i64 = workspace
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM reminder_deliveries", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(deliveries, 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(store.path()).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn per_source_and_global_byte_limits_reject_atomically_without_eviction() {
        let dir = directory();
        let mut store = ConversationStore::new(dir.path().into());
        for source in 1..=16 {
            add_bytes(&mut store, source, MAX_SOURCE_BYTES - 8192);
        }
        let before = encoded(&store.read(reference(1)).unwrap().unwrap());
        let mut too_large = page(1, 6, &[6]);
        too_large.messages[0].body = "x".repeat(900_000);
        assert_eq!(
            store.merge(too_large).unwrap_err().code,
            "conversation-cache-limit"
        );
        assert_eq!(encoded(&store.read(reference(1)).unwrap().unwrap()), before);

        let before = encoded(&store.merge(page(17, 1, &[1])).unwrap());
        let mut global = page(17, 2, &[2]);
        global.messages[0].body = "x".repeat(900_000);
        assert_eq!(
            store.merge(global).unwrap_err().code,
            "conversation-cache-limit"
        );
        assert_eq!(
            encoded(&store.read(reference(17)).unwrap().unwrap()),
            before
        );
        let mut failed = page(1, 1, &[]);
        failed.fetched_at = "2026-09-12T01:00:00Z".into();
        failed.error = Some(ConversationError {
            code: ConversationErrorCode::Unavailable,
            message: "This page is unavailable.".into(),
            retryable: true,
        });
        let partial = store.merge(failed).unwrap();
        assert_eq!(partial.messages.len(), 5);
        assert!(partial.pages[0].error.is_some());
        let connection = store.open(false).unwrap().unwrap();
        let count: i64 = connection
            .query_row("SELECT count(*) FROM entries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 17);
        assert!(ConversationStore::total(&connection).unwrap() <= MAX_TOTAL_BYTES);
        drop(connection);
        store.reset().unwrap();
        assert!(store.read(reference(1)).unwrap().is_none());
        assert_eq!(store.merge(page(1, 1, &[1])).unwrap().messages.len(), 1);
    }

    #[test]
    fn message_and_page_limits_keep_the_previous_entry() {
        for limit_messages in [true, false] {
            let dir = directory();
            let mut store = ConversationStore::new(dir.path().into());
            let mut entry = Entry::empty(reference(1));
            if limit_messages {
                entry.cache.messages =
                    page(1, 1, &(1..=MAX_MESSAGES as u64).collect::<Vec<_>>()).messages;
                for message in &entry.cache.messages {
                    entry
                        .fetched_at
                        .insert(message.id.clone(), "2026-09-11T01:00:00Z".into());
                }
            } else {
                entry.cache.pages = (1..=MAX_PAGES as u32)
                    .map(|index| page(1, index, &[]).metadata())
                    .collect();
            }
            entry.validate(&reference(1).key()).unwrap();
            let payload = serde_json::to_string(&entry).unwrap();
            assert!(payload.len() < MAX_SOURCE_BYTES);
            let connection = store.open(true).unwrap().unwrap();
            connection
                .execute(
                    "INSERT INTO entries VALUES(?,?,?)",
                    params![reference(1).key(), payload, digest(payload.as_bytes())],
                )
                .unwrap();
            drop(connection);
            let before = encoded(&store.read(reference(1)).unwrap().unwrap());
            let next = if limit_messages {
                page(1, 1, &[5001])
            } else {
                page(1, 2001, &[])
            };
            assert_eq!(
                store.merge(next).unwrap_err().code,
                "conversation-cache-limit"
            );
            assert_eq!(encoded(&store.read(reference(1)).unwrap().unwrap()), before);
        }
    }

    #[test]
    fn cache_corruption_never_resets_cache_or_breaks_note_saves() {
        for damage in ["checksum", "payload", "identity", "schema", "bytes"] {
            let dir = directory();
            let mut workspace = Store::new(dir.path().into()).unwrap();
            let saved = workspace
                .save(&workspace.read().unwrap().revision, notes("safe"))
                .unwrap();
            let mut store = ConversationStore::new(dir.path().into());
            store.merge(page(1, 1, &[1])).unwrap();
            if damage == "bytes" {
                fs::write(store.path(), b"damaged cache").unwrap();
            } else {
                let connection = store.open(false).unwrap().unwrap();
                match damage {
                    "checksum" => {
                        connection
                            .execute("UPDATE entries SET checksum='wrong'", [])
                            .unwrap();
                    }
                    "payload" => {
                        connection
                            .execute(
                                "UPDATE entries SET payload='{}',checksum=?",
                                [digest(b"{}")],
                            )
                            .unwrap();
                    }
                    "identity" => {
                        connection
                            .execute("UPDATE entries SET source_key='octo/project:pr:2'", [])
                            .unwrap();
                    }
                    "schema" => {
                        connection.execute_batch("PRAGMA user_version=99").unwrap();
                    }
                    _ => unreachable!(),
                }
            }
            let cache_bytes = fs::read(store.path()).unwrap();
            let reference = reference(if damage == "identity" { 2 } else { 1 });
            let error = store.read(reference.clone()).unwrap_err();
            assert!(error.code.starts_with("conversation-cache-"), "{damage}");
            assert!(error.message.contains("notes are safe"));
            assert!(store.merge(page(reference.number, 1, &[2])).is_err());
            assert_eq!(fs::read(store.path()).unwrap(), cache_bytes);
            assert_eq!(workspace.read().unwrap().revision, saved.revision);
            let saved = workspace
                .save(&saved.revision, notes("still editable"))
                .unwrap();
            assert_eq!(
                saved.snapshot.unwrap().workspace["state"]["notes"],
                "still editable"
            );
        }
    }

    #[test]
    fn explicit_clear_removes_only_selected_source_including_a_corrupt_entry() {
        let dir = directory();
        let mut store = ConversationStore::new(dir.path().into());
        store.clear(reference(1)).unwrap();
        assert!(!store.path().exists());
        store.merge(page(1, 1, &[1])).unwrap();
        let retained = encoded(&store.merge(page(2, 1, &[2])).unwrap());
        store
            .open(false)
            .unwrap()
            .unwrap()
            .execute(
                "UPDATE entries SET checksum='wrong' WHERE source_key=?",
                [reference(1).key()],
            )
            .unwrap();
        let mut mixed = reference(1);
        mixed.repo = "OCTO/Project".into();
        store.clear(mixed).unwrap();
        assert!(store.read(reference(1)).unwrap().is_none());
        assert_eq!(
            encoded(&store.read(reference(2)).unwrap().unwrap()),
            retained
        );
        assert_eq!(store.merge(page(1, 1, &[3])).unwrap().messages.len(), 1);
    }

    #[test]
    fn page_limit_counts_serialized_utf8_and_rejects_without_changing_saved_content() {
        let dir = directory();
        let mut store = ConversationStore::new(dir.path().into());
        let mut input = page(1, 1, &[1]);
        input.messages[0].body.clear();
        let overhead = serde_json::to_vec(&input).unwrap().len();
        input.messages[0].body = "x".repeat(MAX_PAGE_BYTES - overhead);
        assert_eq!(serde_json::to_vec(&input).unwrap().len(), MAX_PAGE_BYTES);
        let before = encoded(&store.merge(input.clone()).unwrap());
        for body in [
            format!("{}x", input.messages[0].body),
            "日".repeat(400_000),
            "\\".repeat(550_000),
        ] {
            input.messages[0].body = body;
            assert_eq!(
                store.merge(input.clone()).unwrap_err().code,
                "conversation-page-limit"
            );
            assert_eq!(encoded(&store.read(reference(1)).unwrap().unwrap()), before);
        }
    }

    #[test]
    fn explicit_reset_preserves_raw_cache_and_journals_without_touching_workspace_files() {
        for damage in ["none", "schema", "bytes", "empty"] {
            let dir = directory();
            let mut workspace = Store::new(dir.path().into()).unwrap();
            let saved = workspace
                .save(&workspace.read().unwrap().revision, notes("safe notes"))
                .unwrap();
            let workspace_bytes = fs::read(workspace.path()).unwrap();
            let backup_bytes = fs::read(dir.path().join("backups/latest.sqlite3")).unwrap();
            let mut store = ConversationStore::new(dir.path().into());
            store.merge(page(1, 1, &[1])).unwrap();
            store.merge(page(2, 1, &[2])).unwrap();
            match damage {
                "schema" => store
                    .open(false)
                    .unwrap()
                    .unwrap()
                    .execute_batch("PRAGMA user_version=99")
                    .unwrap(),
                "bytes" => fs::write(store.path(), b"broken SQLite bytes").unwrap(),
                "empty" => fs::write(store.path(), []).unwrap(),
                _ => {}
            }
            let raw = fs::read(store.path()).unwrap();
            for suffix in ["-journal", "-wal", "-shm"] {
                fs::write(
                    dir.path().join(format!("conversations.sqlite3{suffix}")),
                    suffix,
                )
                .unwrap();
            }
            store.reset().unwrap();
            assert!(store.read(reference(1)).unwrap().is_none());
            assert!(store.read(reference(2)).unwrap().is_none());
            let archives: Vec<_> = fs::read_dir(dir.path())
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| {
                    path.file_name()
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .starts_with("cache-recovery-")
                        && path
                            .extension()
                            .is_some_and(|extension| extension == "sqlite3")
                })
                .collect();
            assert_eq!(archives.len(), 1);
            assert_eq!(fs::read(&archives[0]).unwrap(), raw);
            for suffix in ["-journal", "-wal", "-shm"] {
                let preserved = PathBuf::from(format!("{}{suffix}", archives[0].display()));
                assert_eq!(fs::read(preserved).unwrap(), suffix.as_bytes());
                assert!(!dir
                    .path()
                    .join(format!("conversations.sqlite3{suffix}"))
                    .exists());
            }
            assert_eq!(workspace.read().unwrap().revision, saved.revision);
            assert_eq!(fs::read(workspace.path()).unwrap(), workspace_bytes);
            assert_eq!(
                fs::read(dir.path().join("backups/latest.sqlite3")).unwrap(),
                backup_bytes
            );
            assert_eq!(workspace.list_backups().unwrap().len(), 1);
            assert_eq!(store.merge(page(1, 1, &[3])).unwrap().messages.len(), 1);
            store.reset().unwrap();
            assert_eq!(fs::read(&archives[0]).unwrap(), raw);
            let count = fs::read_dir(dir.path())
                .unwrap()
                .filter(|entry| {
                    entry
                        .as_ref()
                        .unwrap()
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "sqlite3")
                        && entry
                            .as_ref()
                            .unwrap()
                            .file_name()
                            .to_str()
                            .unwrap()
                            .starts_with("cache-recovery-")
                })
                .count();
            assert_eq!(count, 2);
        }
    }

    #[test]
    fn reset_refuses_busy_or_unpreservable_cache_without_destroying_it() {
        let dir = directory();
        let mut store = ConversationStore::new(dir.path().into());
        store.merge(page(1, 1, &[1])).unwrap();
        let before = fs::read(store.path()).unwrap();
        let lock = store.lock(true).unwrap().unwrap();
        assert_eq!(store.reset().unwrap_err().code, "conversation-cache-busy");
        assert_eq!(fs::read(store.path()).unwrap(), before);
        let inherited = lock.0.try_clone().unwrap();
        drop(lock);
        assert_eq!(store.read(reference(1)).unwrap().unwrap().messages.len(), 1);
        drop(inherited);
        let unexpected = dir.path().join("conversations.sqlite3-journal");
        fs::create_dir(&unexpected).unwrap();
        assert!(store.reset().is_err());
        assert_eq!(fs::read(store.path()).unwrap(), before);
        fs::remove_dir(unexpected).unwrap();
        assert_eq!(store.read(reference(1)).unwrap().unwrap().messages.len(), 1);
        store.reset().unwrap();
        assert!(store.read(reference(1)).unwrap().is_none());
    }
}
