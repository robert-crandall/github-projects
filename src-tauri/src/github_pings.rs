use crate::{
    storage::valid_sleep_and_wake,
    tools::{canonical_github_url, run_gh},
};
use chrono::{DateTime, Utc};
use futures_util::{StreamExt, stream};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tokio::time::{Instant, timeout_at};

const MAX_TARGETS: usize = 20;
const MAX_SOURCES: usize = 64;
const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = 3;
const MAX_REQUESTS: usize = 120;
const MAX_BODY: usize = 256 * 1024;
const MAX_PINGS: usize = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Kind {
    Mention,
    ReviewRequest,
}

#[derive(Debug, Serialize)]
pub(crate) struct Ping {
    reference: String,
    kind: Kind,
    at: DateTime<Utc>,
}

#[derive(Default)]
pub(crate) struct Report {
    pub pings: Vec<Ping>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
struct Target {
    reference: String,
    since: DateTime<Utc>,
}

fn targets(workspace: Option<&Value>, cycle: usize) -> (Vec<Target>, Vec<String>) {
    let Some(workspace) = workspace else {
        return (Vec::new(), Vec::new());
    };
    let Some(items) = workspace["items"]
        .as_array()
        .filter(|items| items.len() <= 10000)
    else {
        return (
            Vec::new(),
            vec!["Sleep monitoring skipped: invalid stored work items.".into()],
        );
    };
    let mut references = BTreeMap::<String, DateTime<Utc>>::new();
    let mut invalid = false;
    let mut truncated = false;
    for item in items {
        if item.get("sleep").is_none() {
            continue;
        }
        if !valid_sleep_and_wake(item) {
            invalid = true;
            continue;
        }
        if item["status"] != "deferred" || item["sleep"]["wakeOnPing"] != true {
            continue;
        }
        let since = DateTime::parse_from_rfc3339(item["sleep"]["since"].as_str().unwrap())
            .unwrap()
            .to_utc();
        let mut add = |value: &Value| {
            let Some(reference) = value.as_str().filter(|reference| reference.len() <= 512) else {
                invalid = true;
                return;
            };
            let normalized = reference
                .strip_suffix('/')
                .unwrap_or(reference)
                .to_ascii_lowercase();
            match canonical_github_url(&normalized) {
                Ok(reference) => {
                    references
                        .entry(reference.to_ascii_lowercase())
                        .and_modify(|previous| *previous = (*previous).min(since))
                        .or_insert(since);
                }
                Err(_) => invalid = true,
            }
        };
        if let Some(sources) = item["sources"].as_array() {
            truncated |= sources.len() > MAX_SOURCES;
            for source in sources.iter().take(MAX_SOURCES) {
                if source["kind"] == "github"
                    || source["reference"].as_str().is_some_and(|reference| {
                        reference.len() <= 512
                            && reference
                                .to_ascii_lowercase()
                                .starts_with("https://github.com/")
                    })
                {
                    add(&source["reference"]);
                }
            }
        } else {
            add(&Value::Null);
        }
        if let Some(identity) = item.get("review").and_then(|review| review.get("identity")) {
            add(identity);
        }
    }
    let mut targets: Vec<_> = references
        .into_iter()
        .map(|(reference, since)| Target { reference, since })
        .collect();
    targets.sort_by_key(|target| (target.since, target.reference.clone()));
    truncated |= targets.len() > MAX_TARGETS;
    if targets.len() > MAX_TARGETS {
        let offset = (cycle % targets.len().div_ceil(MAX_TARGETS)) * MAX_TARGETS;
        targets.rotate_left(offset);
    }
    targets.truncate(MAX_TARGETS);
    let mut warnings = Vec::new();
    if invalid {
        warnings.push("Sleep monitoring skipped malformed sleep metadata or GitHub references in stored work.".into());
    }
    if truncated {
        warnings.push(format!("Sleep monitoring is incomplete: limited to {MAX_TARGETS} references this refresh and {MAX_SOURCES} sources per item. Larger reference sets rotate every five minutes."));
    }
    (targets, warnings)
}

#[derive(Clone, Copy)]
enum Feed {
    Timeline,
    Reviews,
    InlineComments,
}

impl Feed {
    fn endpoint(self, target: &Target) -> String {
        // Targets have already passed canonical_github_url; never use API-supplied URLs.
        let parts: Vec<_> = target.reference["https://github.com/".len()..]
            .split('/')
            .collect();
        let (collection, suffix) = match self {
            Self::Timeline => ("issues", "timeline"),
            Self::Reviews => ("pulls", "reviews"),
            Self::InlineComments => ("pulls", "comments"),
        };
        format!(
            "repos/{}/{}/{collection}/{}/{suffix}",
            parts[0], parts[1], parts[3]
        )
    }
}

struct Page {
    records: Vec<Value>,
    last: usize,
}

fn pagination_path_matches(path: &str, endpoint: &str) -> bool {
    if path == format!("/{endpoint}") {
        return true;
    }
    // GitHub canonicalizes Link headers to numeric repository IDs. Only read
    // their page number; requests still use our validated original endpoint.
    let Some((repository, suffix)) = path
        .strip_prefix("/repositories/")
        .and_then(|rest| rest.split_once('/'))
    else {
        return false;
    };
    repository.parse::<u64>().is_ok_and(|id| id > 0)
        && endpoint.splitn(4, '/').nth(3) == Some(suffix)
}

fn parse_page(bytes: &[u8], endpoint: &str, requested_page: usize) -> Result<Page, String> {
    let invalid = || "GitHub returned malformed sleep-monitoring data.".to_string();
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let (headers, body) = text
        .split_once("\r\n\r\n")
        .or_else(|| text.split_once("\n\n"))
        .ok_or_else(invalid)?;
    if headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        != Some("200")
    {
        return Err(invalid());
    }
    let records: Vec<Value> = serde_json::from_str(body).map_err(|_| invalid())?;
    if records.len() > PAGE_SIZE || records.iter().any(|record| !record.is_object()) {
        return Err(invalid());
    }
    let mut last = None;
    let mut next = false;
    for line in headers.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if !name.eq_ignore_ascii_case("link") {
            continue;
        }
        for link in value.split(',') {
            let Some((href, relation)) = link.trim().split_once(';') else {
                return Err(invalid());
            };
            if !relation.contains("rel=\"last\"") && !relation.contains("rel=\"next\"") {
                continue;
            }
            let href = href
                .strip_prefix('<')
                .and_then(|href| href.strip_suffix('>'))
                .ok_or_else(invalid)?;
            let url = url::Url::parse(href).map_err(|_| invalid())?;
            if url.scheme() != "https"
                || url.host_str() != Some("api.github.com")
                || !pagination_path_matches(url.path(), endpoint)
                || !url.username().is_empty()
                || url.password().is_some()
                || url.port().is_some()
                || url.fragment().is_some()
            {
                return Err(invalid());
            }
            let page = url
                .query_pairs()
                .find(|(key, _)| key == "page")
                .and_then(|(_, value)| value.parse::<usize>().ok())
                .filter(|page| *page >= requested_page && *page <= 1_000_000)
                .ok_or_else(invalid)?;
            if relation.contains("rel=\"last\"") {
                last = Some(page);
            } else {
                next = true;
            }
        }
    }
    if next && last.is_none() {
        return Err("Sleep monitoring cannot determine the pagination limit.".into());
    }
    Ok(Page {
        records,
        last: last.unwrap_or(requested_page),
    })
}

async fn read_pages<F, Fut>(mut fetch: F) -> (Vec<Value>, Option<String>)
where
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = Result<Page, String>>,
{
    let first = match fetch(1).await {
        Ok(page) => page,
        Err(error) => return (Vec::new(), Some(error)),
    };
    let last = first.last;
    let mut records = first.records;
    // Read the newest pages first so long histories do not hide recent pings.
    let mut page = last;
    let mut count = 1;
    while page > 1 && count < MAX_PAGES {
        match fetch(page).await {
            Ok(result) => records.extend(result.records),
            Err(error) => return (records, Some(error)),
        }
        count += 1;
        page -= 1;
    }
    let warning = (page > 1).then(|| format!(
        "Sleep monitoring read only {MAX_PAGES} of {last} pages; pings in skipped history may be missing."
    ));
    (records, warning)
}

fn timestamp(record: &Value, key: &str) -> Result<DateTime<Utc>, String> {
    record[key]
        .as_str()
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|date| date.to_utc())
        .ok_or_else(|| format!("Sleep monitoring received an invalid {key}."))
}

fn actor<'a>(record: &'a Value, key: &str) -> Result<&'a str, String> {
    record[key]["login"]
        .as_str()
        .filter(|login| !login.is_empty() && login.len() <= 100)
        .ok_or_else(|| "Sleep monitoring could not identify an event's author.".into())
}

fn evidence(
    record: &Value,
    feed: Feed,
    target: &Target,
    login: &str,
    now: DateTime<Utc>,
) -> Result<Option<(Kind, DateTime<Utc>)>, String> {
    if !record.is_object() {
        return Err("Sleep monitoring received an invalid event.".into());
    }
    let (kind, key, author_key) = match feed {
        Feed::Timeline => match record["event"].as_str() {
            Some("commented") => (Kind::Mention, "created_at", "user"),
            Some("review_requested") => (Kind::ReviewRequest, "created_at", "actor"),
            Some(_) => return Ok(None),
            None => return Err("Sleep monitoring received a timeline event without a type.".into()),
        },
        Feed::Reviews => {
            match record["state"].as_str() {
                Some("PENDING") => return Ok(None),
                Some("APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED") => {}
                _ => return Err("Sleep monitoring received an invalid review state.".into()),
            }
            (Kind::Mention, "submitted_at", "user")
        }
        Feed::InlineComments => (Kind::Mention, "created_at", "user"),
    };
    let at = timestamp(record, key)?;
    // Creation/submission is evidence of a new ping; updated_at is not. Edits to
    // older bodies cannot be attributed accurately without a durable edit history.
    if at <= target.since || at > now {
        return Ok(None);
    }
    if kind == Kind::ReviewRequest {
        if !record["requested_team"].is_null() {
            if !record["requested_team"].is_object()
                || !record["requested_team"]["slug"].is_string()
            {
                return Err("Sleep monitoring received an invalid requested team.".into());
            }
            return Ok(None);
        }
        if !actor(record, "requested_reviewer")?.eq_ignore_ascii_case(login) {
            return Ok(None);
        }
        if record.get("review_requester").is_some_and(|requester| {
            requester["login"]
                .as_str()
                .is_some_and(|user| user.eq_ignore_ascii_case(login))
        }) {
            return Ok(None);
        }
    }
    if actor(record, author_key)?.eq_ignore_ascii_case(login) {
        return Ok(None);
    }
    if kind == Kind::Mention {
        let body = record["body"]
            .as_str()
            .filter(|body| body.len() <= MAX_BODY)
            .ok_or("Sleep monitoring received a missing or oversized comment body.")?;
        if !direct_mention(body, login) {
            return Ok(None);
        }
    }
    Ok(Some((kind, at)))
}

fn direct_mention(body: &str, login: &str) -> bool {
    let mut fence: Option<(u8, usize)> = None;
    let mut inline = 0;
    let mut quoted = false;
    let mut html = false;
    let mut html_comment = false;
    let mut html_literal = None;
    for line in body.lines() {
        let text = line.trim_start();
        if html_comment {
            html_comment = !text.contains("-->");
            continue;
        }
        if text.contains("<!--") {
            html_comment = !text.contains("-->");
            continue;
        }
        let lower = text.to_ascii_lowercase();
        if let Some(close) = html_literal {
            if lower.contains(close) {
                html_literal = None;
            }
            continue;
        }
        for (open, close) in [
            ("<blockquote", "</blockquote>"),
            ("<pre", "</pre>"),
            ("<code", "</code>"),
        ] {
            if lower.contains(open) && !lower.contains(close) {
                html_literal = Some(close);
            }
        }
        if html_literal.is_some() {
            continue;
        }
        if text.is_empty() {
            quoted = false;
            html = false;
            continue;
        }
        let marker = text.as_bytes()[0];
        let run = text.bytes().take_while(|byte| *byte == marker).count();
        if let Some((open, length)) = fence {
            if marker == open && run >= length {
                fence = None;
            }
            continue;
        }
        if (marker == b'`' || marker == b'~') && run >= 3 {
            fence = Some((marker, run));
            continue;
        }
        quoted |= text.starts_with('>');
        html |= text.starts_with('<');
        if quoted
            || html
            || line.starts_with("    ")
            || line.starts_with('\t')
            || text.contains('<')
        {
            continue;
        }
        let bytes = line.as_bytes();
        let mut index = 0;
        let mut quotation = false;
        while index < bytes.len() {
            if bytes[index] == b'`' {
                let length = bytes[index..]
                    .iter()
                    .take_while(|byte| **byte == b'`')
                    .count();
                if inline == 0 {
                    inline = length;
                } else if inline == length {
                    inline = 0;
                }
                index += length;
                continue;
            }
            if inline == 0 && bytes[index] == b'"' {
                quotation = !quotation;
            }
            if inline == 0 && !quotation && bytes[index] == b'@' {
                let end = index + 1 + login.len();
                let before = index == 0
                    || bytes[index - 1].is_ascii_whitespace()
                    || b"([{,:;!?*~".contains(&bytes[index - 1]);
                let after = end >= bytes.len()
                    || (!bytes[end].is_ascii_alphanumeric()
                        && !b"-_/@".contains(&bytes[end])
                        && !(bytes[end] == b'.'
                            && bytes.get(end + 1).is_some_and(u8::is_ascii_alphanumeric)));
                if before
                    && after
                    && bytes
                        .get(index + 1..end)
                        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(login.as_bytes()))
                {
                    return true;
                }
            }
            index += 1;
        }
    }
    false
}

pub(crate) async fn poll(
    path: &Path,
    workspace: Option<&Value>,
    login: &str,
    now: DateTime<Utc>,
) -> Report {
    let cycle = now.timestamp().div_euclid(300).max(0) as usize;
    let (targets, warnings) = targets(workspace, cycle);
    let mut report = Report {
        warnings,
        ..Report::default()
    };
    let budget = AtomicUsize::new(MAX_REQUESTS);
    let deadline = Instant::now() + Duration::from_secs(60);
    let jobs: Vec<_> = targets
        .iter()
        .flat_map(|target| {
            let feeds: &[Feed] = if target.reference.contains("/pull/") {
                &[Feed::Timeline, Feed::Reviews, Feed::InlineComments]
            } else {
                &[Feed::Timeline]
            };
            feeds.iter().map(move |feed| (target.clone(), *feed))
        })
        .collect();
    let mut results = stream::iter(jobs)
        .map(|(target, feed)| {
            let budget = &budget;
            async move {
                let endpoint = feed.endpoint(&target);
                let (records, warning) =
                    read_pages(|page| {
                        let endpoint = &endpoint;
                        async move {
                            if Instant::now() >= deadline
                                || budget
                                    .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |left| {
                                        left.checked_sub(1)
                                    })
                                    .is_err()
                            {
                                return Err(
                                    "Sleep monitoring reached its 60-second or 120-request limit."
                                        .into(),
                                );
                            }
                            let args = vec![
                                "api".into(),
                                "--hostname".into(),
                                "github.com".into(),
                                "--method".into(),
                                "GET".into(),
                                "--include".into(),
                                "-H".into(),
                                "Accept: application/vnd.github+json".into(),
                                "-H".into(),
                                "X-GitHub-Api-Version: 2022-11-28".into(),
                                format!("{endpoint}?per_page={PAGE_SIZE}&page={page}"),
                            ];
                            let bytes = timeout_at(deadline, run_gh(path, &args)).await.map_err(
                                |_| "Sleep monitoring reached its 60-second limit.".to_string(),
                            )??;
                            parse_page(&bytes, endpoint, page)
                        }
                    })
                    .await;
                (target, feed, records, warning)
            }
        })
        .buffer_unordered(3);
    let mut pings = BTreeSet::new();
    let mut truncated = false;
    while let Some((target, feed, records, warning)) = results.next().await {
        if let Some(warning) = warning {
            report
                .warnings
                .push(format!("{}: {warning}", feed.endpoint(&target)));
        }
        let mut malformed = false;
        for record in records {
            match evidence(&record, feed, &target, login, now) {
                Ok(Some((kind, at))) => {
                    pings.insert((at, target.reference.clone(), kind));
                    if pings.len() > MAX_PINGS {
                        pings.pop_first();
                        truncated = true;
                    }
                }
                Ok(None) => {}
                Err(_) => malformed = true,
            }
        }
        if malformed {
            report.warnings.push(format!(
                "{}: sleep monitoring skipped malformed events; some pings may be missing.",
                feed.endpoint(&target)
            ));
        }
    }
    if truncated {
        report.warnings.push(format!("Sleep monitoring retained only the newest {MAX_PINGS} pings; earlier pings may be missing."));
    }
    // Keep the snapshot inside the frontend warning bound, including discovery warnings.
    if report.warnings.len() > 80 {
        report.warnings.truncate(79);
        report
            .warnings
            .push("Additional sleep-monitoring failures were omitted.".into());
    }
    report.pings = pings
        .into_iter()
        .map(|(at, reference, kind)| Ping {
            reference,
            kind,
            at,
        })
        .collect();
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn time(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text).unwrap().to_utc()
    }

    fn target() -> Target {
        Target {
            reference: "https://github.com/acme/repo/pull/42".into(),
            since: time("2026-09-01T12:00:00Z"),
        }
    }

    fn sleeping(reference: &str) -> Value {
        json!({
            "status":"deferred", "sources":[{"kind":"github","reference":reference}],
            "sleep":{"since":"2026-09-01T12:00:00Z","wakeOnPing":true}
        })
    }

    fn comment() -> Value {
        json!({
            "event":"commented", "user":{"login":"other"}, "body":"Please check @me.",
            "created_at":"2026-09-08T12:00:00Z","updated_at":"2026-09-08T12:00:00Z"
        })
    }

    fn check(record: &Value, feed: Feed) -> Result<Option<(Kind, DateTime<Utc>)>, String> {
        evidence(record, feed, &target(), "me", time("2026-09-08T14:00:00Z"))
    }

    #[test]
    fn targets_include_assigned_and_missing_search_references_and_review_identity() {
        let first = sleeping("https://github.com/Acme/Repo/issues/20");
        let mut second = sleeping("https://github.com/acme/repo/issues/20");
        second["sleep"]["since"] = json!("2026-09-02T12:00:00Z");
        second["review"] = json!({"identity":"https://github.com/acme/repo/pull/42"});
        let mut captured = sleeping("https://github.com/Acme/Repo/issues/21/");
        captured["sources"][0]["kind"] = json!("capture");
        let (targets, warnings) = targets(Some(&json!({"items":[first,second,captured]})), 0);
        assert!(warnings.is_empty());
        assert_eq!(targets.len(), 3);
        assert_eq!(
            targets[0].reference,
            "https://github.com/acme/repo/issues/20"
        );
        assert_eq!(targets[0].since, target().since);
        assert_eq!(
            targets[1].reference,
            "https://github.com/acme/repo/issues/21"
        );
        assert_eq!(targets[2].reference, target().reference);
        assert_eq!(
            Feed::Timeline.endpoint(&targets[0]),
            "repos/acme/repo/issues/20/timeline"
        );
        assert_eq!(
            Feed::Timeline.endpoint(&targets[2]),
            "repos/acme/repo/issues/42/timeline"
        );
        assert_eq!(
            Feed::Reviews.endpoint(&targets[2]),
            "repos/acme/repo/pulls/42/reviews"
        );
        assert_eq!(
            Feed::InlineComments.endpoint(&targets[2]),
            "repos/acme/repo/pulls/42/comments"
        );
    }

    #[test]
    fn targets_ignore_legacy_defer_disabled_ping_and_invalid_stored_input() {
        let mut disabled = sleeping(&target().reference);
        disabled["sleep"]["wakeOnPing"] = json!(false);
        let mut active = sleeping(&target().reference);
        active["status"] = json!("available");
        let mut invalid = sleeping(&target().reference);
        invalid["sleep"]["since"] = json!("bad");
        let (found, warnings) = targets(
            Some(&json!({"items":[
                disabled, active, invalid,
                {"status":"deferred","sources":[{"kind":"github","reference":target().reference}]},
                sleeping("https://evil.example/acme/repo/pull/1"),
                sleeping("https://github.com/acme/repo/pull/1?cmd=bad"),
                sleeping("https://github.com/acme/repo/pull/01")
            ]})),
            0,
        );
        assert!(found.is_empty());
        assert_eq!(warnings.len(), 1);
        assert!(targets(None, 0).1.is_empty());
        assert!(!targets(Some(&json!({})), 0).1.is_empty());
    }

    #[test]
    fn target_and_source_limits_are_explicit() {
        let items: Vec<_> = (1..=MAX_TARGETS + 1)
            .map(|number| sleeping(&format!("https://github.com/acme/repo/issues/{number}")))
            .collect();
        let workspace = json!({"items":items});
        let (found, warnings) = targets(Some(&workspace), 0);
        assert_eq!(found.len(), MAX_TARGETS);
        assert_eq!(warnings.len(), 1);
        let (next, _) = targets(Some(&workspace), 1);
        let covered: BTreeSet<_> = found
            .iter()
            .chain(&next)
            .map(|target| &target.reference)
            .collect();
        assert_eq!(covered.len(), MAX_TARGETS + 1);
        let mut item = sleeping(&target().reference);
        item["sources"] = json!(vec![
            json!({"kind":"github","reference":target().reference});
            MAX_SOURCES + 1
        ]);
        assert_eq!(targets(Some(&json!({"items":[item]})), 0).1.len(), 1);
    }

    #[test]
    fn only_new_direct_mentions_wake_across_all_comment_feeds() {
        for feed in [Feed::Timeline, Feed::InlineComments, Feed::Reviews] {
            let mut record = comment();
            record["state"] = json!("COMMENTED");
            record["submitted_at"] = record["created_at"].clone();
            assert_eq!(check(&record, feed).unwrap().unwrap().0, Kind::Mention);
            record["user"]["login"] = json!("ME");
            assert!(check(&record, feed).unwrap().is_none());
            record["user"]["login"] = json!("other");
            record["body"] = json!("Ordinary update; @team/reviewers @someone-else");
            assert!(check(&record, feed).unwrap().is_none());
            record["body"] = json!("@me");
            for old in ["2026-08-01T12:00:00Z", "2026-09-01T12:00:00Z"] {
                record["created_at"] = json!(old);
                record["submitted_at"] = json!(old);
                assert!(
                    check(&record, feed).unwrap().is_none(),
                    "Old body edited later must stay asleep"
                );
            }
            record["created_at"] = json!("2026-09-09T12:00:00Z");
            record["submitted_at"] = record["created_at"].clone();
            assert!(check(&record, feed).unwrap().is_none());
        }
        let mut pending = comment();
        pending["state"] = json!("PENDING");
        assert!(check(&pending, Feed::Reviews).unwrap().is_none());
    }

    #[test]
    fn mention_parser_avoids_teams_prefixes_emails_code_and_quotes() {
        for text in [
            "@me",
            "Hi @ME!",
            "Could **@me** check?",
            "(@me)",
            "@me.",
            "> @other\n\n@me",
            "```\n@other\n```\n@me",
            "`@other` @me",
            "~~~rust\n@other\n~~~\n@me",
        ] {
            assert!(direct_mention(text, "me"), "{text}");
        }
        for text in [
            "Ordinary comment",
            "@me-too",
            "@me2",
            "@me/team",
            "@org/me",
            "@meh",
            "user@me.com",
            "user+@me",
            "@me.example.com",
            "\\@me",
            "`@me`",
            "``code ` @me ``",
            "```\n@me\n```",
            "~~~rust\n@me\n~~~",
            "    @me",
            "\t@me",
            "> @me",
            "> quote\n@me",
            "\"@me said\"",
            "<blockquote>@me</blockquote>",
            "<!--\n@me\n-->",
            "<!--\n\n@me\n-->",
            "<blockquote>\n\n@me\n</blockquote>",
            "<pre>\n\n@me\n</pre>",
            "https://example.com/@me",
            "@me_suffix",
        ] {
            assert!(!direct_mention(text, "me"), "{text}");
        }
    }

    #[test]
    fn review_requests_require_a_new_event_to_the_signed_in_user() {
        let mut request = json!({
            "event":"review_requested", "created_at":"2026-09-08T12:00:00Z",
            "actor":{"login":"other"}, "requested_reviewer":{"login":"ME"}
        });
        assert_eq!(
            check(&request, Feed::Timeline).unwrap().unwrap().0,
            Kind::ReviewRequest
        );
        request["requested_team"] = json!({"slug":"me"});
        assert!(check(&request, Feed::Timeline).unwrap().is_none());
        request["requested_team"] = Value::Null;
        request["requested_reviewer"]["login"] = json!("another");
        assert!(check(&request, Feed::Timeline).unwrap().is_none());
        request["requested_reviewer"]["login"] = json!("me");
        request["actor"]["login"] = json!("me");
        assert!(check(&request, Feed::Timeline).unwrap().is_none());
        request["actor"]["login"] = json!("other");
        request["created_at"] = json!("2026-09-01T12:00:00Z");
        request["updated_at"] = json!("2026-09-08T12:00:00Z");
        assert!(check(&request, Feed::Timeline).unwrap().is_none());
        for event in [
            "mentioned",
            "review_request_removed",
            "assigned",
            "synchronize",
            "renamed",
        ] {
            request["created_at"] = json!("2026-09-08T12:00:00Z");
            request["event"] = json!(event);
            assert!(check(&request, Feed::Timeline).unwrap().is_none());
        }
        assert!(
            check(
                &json!({"reason":"mention","updated_at":"2026-09-08T12:00:00Z"}),
                Feed::Timeline
            )
            .is_err()
        );
    }

    #[test]
    fn malformed_evidence_is_not_reported_as_successful_monitoring() {
        for key in ["body", "user", "created_at", "event"] {
            let mut record = comment();
            record[key] = Value::Null;
            assert!(check(&record, Feed::Timeline).is_err(), "{key}");
        }
        let mut record = comment();
        record["body"] = json!("x".repeat(MAX_BODY + 1));
        assert!(check(&record, Feed::Timeline).is_err());
        assert!(check(&json!({"event":"review_requested","created_at":"2026-09-08T12:00:00Z","actor":{"login":"other"}}),Feed::Timeline).is_err());
    }

    #[test]
    fn api_pages_validate_arrays_status_and_untrusted_links() {
        let endpoint = "repos/acme/repo/issues/42/timeline";
        assert_eq!(
            parse_page(b"HTTP/2.0 200 OK\r\n\r\n[]", endpoint, 1)
                .unwrap()
                .last,
            1
        );
        let good = format!(
            "HTTP/2.0 200 OK\nLink: <https://api.github.com/{endpoint}?per_page=100&page=2>; rel=\"next\", <https://api.github.com/{endpoint}?per_page=100&page=8>; rel=\"last\"\n\n[]"
        );
        assert_eq!(parse_page(good.as_bytes(), endpoint, 1).unwrap().last, 8);
        let canonical = good.replace("repos/acme/repo", "repositories/212613049");
        assert_eq!(
            parse_page(canonical.as_bytes(), endpoint, 1).unwrap().last,
            8
        );
        for bad in [
            "[]".to_owned(),
            "HTTP/2.0 404 Not Found\n\n[]".into(),
            "HTTP/2.0 200 OK\n\n{}".into(),
            "HTTP/2.0 200 OK\n\n[null]".into(),
            good.replace("api.github.com", "evil.example"),
            good.replace("page=8", "page=99999999999"),
            good.replace("issues/42", "issues/43"),
            canonical.replace("issues/42", "issues/43"),
            canonical.replace("212613049", "not-a-repository"),
            format!(
                "HTTP/2.0 200 OK\n\n{}",
                json!(vec![json!({}); PAGE_SIZE + 1])
            ),
        ] {
            assert!(parse_page(bad.as_bytes(), endpoint, 1).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn pagination_reads_newest_pages_with_explicit_truncation_and_partial_failures() {
        let mut requested = Vec::new();
        let (records, warning) = read_pages(|number| {
            requested.push(number);
            async move {
                Ok(Page {
                    records: vec![json!({"page":number})],
                    last: 8,
                })
            }
        })
        .await;
        assert_eq!(requested, vec![1, 8, 7]);
        assert_eq!(records.len(), MAX_PAGES);
        assert!(warning.unwrap().contains("3 of 8"));
        let (records, warning) = read_pages(|number| async move {
            if number == 1 {
                Ok(Page {
                    records: vec![comment()],
                    last: 2,
                })
            } else {
                Err("read failed".into())
            }
        })
        .await;
        assert_eq!(records.len(), 1);
        assert_eq!(warning.as_deref(), Some("read failed"));
        let (_, warning) = read_pages(|_| async {
            Ok(Page {
                records: vec![],
                last: 1,
            })
        })
        .await;
        assert!(warning.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn poll_reads_all_pr_feeds_and_keeps_pings_when_another_target_fails() {
        use std::os::unix::fs::PermissionsExt;
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/github-ping-tests")
            .join(format!(
                "{}-{}",
                std::process::id(),
                Utc::now().timestamp_nanos_opt().unwrap()
            ));
        std::fs::create_dir_all(&directory).unwrap();
        let cli = directory.join("gh");
        std::fs::write(&cli, r#"#!/bin/sh
case "$*" in
  *"--method GET --include"*) ;;
  *) exit 2 ;;
esac
case "$*" in
  *"repos/acme/repo/issues/99/timeline"*) exit 1 ;;
  *"repos/acme/repo/issues/42/timeline"*)
    printf 'HTTP/2.0 200 OK\r\n\r\n'
    printf '[{"event":"review_requested","actor":{"login":"other"},"requested_reviewer":{"login":"me"},"created_at":"2026-09-08T12:00:00Z"}]'
    ;;
  *"repos/acme/repo/pulls/42/reviews"*)
    printf 'HTTP/2.0 200 OK\r\n\r\n'
    printf '[{"state":"COMMENTED","user":{"login":"other"},"body":"@me","submitted_at":"2026-09-08T12:01:00Z"}]'
    ;;
  *"repos/acme/repo/pulls/42/comments"*)
    printf 'HTTP/2.0 200 OK\r\n\r\n'
    printf '[{"user":{"login":"other"},"body":"@me","created_at":"2026-09-08T12:02:00Z"}]'
    ;;
  *) exit 2 ;;
esac
"#).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let workspace = json!({"items":[
            sleeping(&target().reference),
            sleeping("https://github.com/acme/repo/issues/99")
        ]});
        let report = poll(&cli, Some(&workspace), "me", time("2026-09-08T14:00:00Z")).await;
        std::fs::remove_dir_all(directory).unwrap();
        assert_eq!(report.pings.len(), 3);
        assert_eq!(report.warnings.len(), 1);
        assert!(report.warnings[0].contains("issues/99/timeline"));
        assert_eq!(report.pings[0].kind, Kind::ReviewRequest);
        assert_eq!(report.pings[1].kind, Kind::Mention);
        assert_eq!(report.pings[1].at, time("2026-09-08T12:01:00Z"));
        assert_eq!(report.pings[2].kind, Kind::Mention);
        assert_eq!(report.pings[2].at, time("2026-09-08T12:02:00Z"));
    }

    #[test]
    fn ping_serialization_matches_the_frontend_contract() {
        let ping = Ping {
            reference: target().reference,
            kind: Kind::ReviewRequest,
            at: target().since,
        };
        assert_eq!(
            serde_json::to_value(ping).unwrap(),
            json!({
                "reference":"https://github.com/acme/repo/pull/42",
                "kind":"review-request","at":"2026-09-01T12:00:00Z"
            })
        );
    }
}
