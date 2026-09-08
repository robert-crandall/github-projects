use crate::tools::{github_login, run_gh, valid_repository};
use chrono::{DateTime, Duration, Utc};
use futures_util::{StreamExt, TryStreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

const LIMIT: usize = 50;
const TEAM: &str = "integrations/terraform-provider-core-maintainers";

#[derive(Clone, Copy, Debug, PartialEq)]
enum Bucket {
    Direct,
    Team,
    Authored,
    Mention,
    Reviewed,
    Assigned,
    IssueMention,
}

impl Bucket {
    fn is_issue(self) -> bool {
        matches!(self, Self::Assigned | Self::IssueMention)
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchItem {
    number: u64,
    title: String,
    repository: Repository,
    #[serde(default)]
    author: Option<Author>,
    updated_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    #[serde(default)]
    is_draft: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repository {
    name_with_owner: String,
}
#[derive(Clone, Deserialize)]
struct Author {
    login: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Details {
    #[serde(default)]
    review_decision: Option<String>,
    #[serde(default)]
    mergeable: Option<String>,
    #[serde(default)]
    status_check_rollup: Vec<Value>,
    #[serde(default)]
    additions: Option<u64>,
    #[serde(default)]
    deletions: Option<u64>,
    #[serde(default)]
    changed_files: Option<u64>,
    #[serde(default)]
    is_draft: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubSnapshot {
    fetched_at: String,
    login: String,
    items: Vec<Value>,
    warnings: Vec<String>,
    pings: Vec<crate::github_pings::Ping>,
}

fn search_args(bucket: Bucket, now: DateTime<Utc>) -> Vec<String> {
    let issue = bucket.is_issue();
    let mut args = vec!["search".into(), if issue { "issues" } else { "prs" }.into()];
    match bucket {
        Bucket::Direct => args.push("user-review-requested:@me".into()),
        Bucket::Team => args.push(format!("team-review-requested:{TEAM}")),
        Bucket::Authored => args.push("--author=@me".into()),
        Bucket::Mention | Bucket::IssueMention => args.push("--mentions=@me".into()),
        Bucket::Reviewed => args.push("--reviewed-by=@me".into()),
        Bucket::Assigned => args.push("--assignee=@me".into()),
    }
    let days = match bucket {
        Bucket::Mention | Bucket::IssueMention => Some(3),
        Bucket::Reviewed => Some(2),
        Bucket::Assigned => Some(30),
        _ => None,
    };
    if let Some(days) = days {
        args.push(format!(
            "--updated=>={}",
            (now - Duration::days(days)).format("%Y-%m-%d")
        ));
    }
    args.extend([
        "archived:false".into(),
        "--state=open".into(),
        "--limit".into(),
        LIMIT.to_string(),
        "--sort=updated".into(),
        "--order=asc".into(),
        "--json".into(),
        if issue {
            "number,title,repository,author,createdAt,updatedAt"
        } else {
            "number,title,repository,author,createdAt,updatedAt,isDraft"
        }
        .into(),
    ]);
    args
}

#[derive(Debug, PartialEq)]
enum Ci {
    Failing,
    Pending,
    Passing,
    NoChecks,
}

fn ci(checks: &[Value]) -> Ci {
    if checks.is_empty() {
        return Ci::NoChecks;
    }
    let mut pending = false;
    for check in checks {
        let status = check["conclusion"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| check["state"].as_str())
            .unwrap_or("");
        if [
            "FAILURE",
            "TIMED_OUT",
            "CANCELLED",
            "ACTION_REQUIRED",
            "ERROR",
            "STARTUP_FAILURE",
            "STALE",
        ]
        .contains(&status)
        {
            return Ci::Failing;
        }
        if !["SUCCESS", "NEUTRAL", "SKIPPED"].contains(&status) {
            pending = true;
        }
    }
    if pending { Ci::Pending } else { Ci::Passing }
}

fn authored_action(details: &Details) -> Option<(&'static str, String)> {
    if details.is_draft {
        return None;
    }
    let ci = ci(&details.status_check_rollup);
    if details.review_decision.as_deref() == Some("APPROVED")
        && details.mergeable.as_deref() == Some("MERGEABLE")
        && matches!(ci, Ci::Passing | Ci::NoChecks)
    {
        return Some((
            "merge",
            "Approved, mergeable, and CI passing or no checks.".into(),
        ));
    }
    let mut blockers = Vec::new();
    if details.review_decision.as_deref() == Some("CHANGES_REQUESTED") {
        blockers.push("changes requested");
    }
    if details.mergeable.as_deref() == Some("CONFLICTING") {
        blockers.push("merge conflicts");
    }
    if ci == Ci::Failing {
        blockers.push("failing CI");
    }
    if blockers.is_empty() {
        None
    } else {
        Some(("fix", blockers.join(", ")))
    }
}

fn url(item: &SearchItem, bucket: Bucket) -> Result<String, String> {
    if !valid_repository(&item.repository.name_with_owner) || item.number == 0 {
        return Err("GitHub returned an invalid repository or issue number.".into());
    }
    Ok(format!(
        "https://github.com/{}/{}/{}",
        item.repository.name_with_owner,
        if bucket.is_issue() { "issues" } else { "pull" },
        item.number
    ))
}

fn work_item(
    item: &SearchItem,
    bucket: Bucket,
    details: Option<&Details>,
    login: &str,
    now: DateTime<Utc>,
) -> Option<Value> {
    if item.is_draft || details.is_some_and(|details| details.is_draft) {
        return None;
    }
    let mine = item
        .author
        .as_ref()
        .is_some_and(|author| author.login.eq_ignore_ascii_case(login));
    let (obligation, kind, label, next_step, evidence) = match bucket {
        Bucket::Direct => ("review", "review", "Direct review request".to_owned(), "Review the requested pull request.".to_owned(), "GitHub directly requested your review.".to_owned()),
        Bucket::Team => ("review", "review", format!("Team review requested · {TEAM}"), "Review as a Terraform Provider Core Maintainers team member.".into(), format!("Requested from {TEAM}, not directly from you.")),
        Bucket::Authored => {
            let (action, evidence) = authored_action(details?)?;
            if action == "merge" { ("merge", "task", "Authored PR · ready to merge".into(), "Open GitHub and decide whether to merge.".into(), evidence) }
            else { ("fix", "fix", "Authored PR · needs your fix".into(), "Address the reported blocker, then check GitHub again.".into(), evidence) }
        }
        Bucket::Mention | Bucket::IssueMention if (bucket == Bucket::IssueMention || !mine) && item.updated_at >= now - Duration::days(3) => ("reply", "mention", "Mentioned · may owe a reply".into(), "Check whether this mention needs your reply.".into(), "A recent mention is a signal, not proof that you owe a response.".into()),
        Bucket::Reviewed if !mine && item.updated_at >= now - Duration::days(2) => ("review", "review", "Reviewed PR · may need re-review".into(), "Check recent activity to decide whether another review is needed.".into(), "You previously reviewed this PR. Recent activity alone does not prove a new review obligation.".into()),
        Bucket::Assigned if item.updated_at >= now - Duration::days(30) => ("task", "task", "Assigned issue".into(), "Open the assigned issue and identify your next action.".into(), "This open issue is assigned to you.".into()),
        _ => return None,
    };
    let url = url(item, bucket).ok()?;
    let mut work = json!({
        "id": format!("github:{url}:{obligation}"), "title": item.title, "kind": kind, "status": "available",
        "createdAt": item.created_at.to_rfc3339(), "updatedAt": item.updated_at.to_rfc3339(),
        "sources": [{"id":format!("github:{url}:{bucket:?}"),"kind":"github","label":label,"reference":url}],
        "notes":"","steps":[],"nextStep":next_step,"evidence":evidence
    });
    if kind == "review" {
        let request = match bucket {
            Bucket::Direct => "direct",
            Bucket::Team => "team",
            _ => "manual",
        };
        let mut review = json!({"identity":url,"request":request});
        if bucket == Bucket::Team {
            review["team"] = json!(TEAM);
        }
        if let Some(details) = details {
            if let (Some(additions), Some(deletions)) = (details.additions, details.deletions) {
                if let Some(lines) = additions.checked_add(deletions) {
                    review["lines"] = json!(lines);
                }
            }
            if let Some(files) = details.changed_files {
                review["files"] = json!(files);
            }
        }
        work["review"] = review;
    }
    Some(work)
}

pub async fn sync(path: &Path, workspace: Option<&Value>) -> Result<GitHubSnapshot, String> {
    let now = Utc::now();
    let login = github_login(path).await?;
    let (discovery, monitoring) = tokio::join!(
        discover(path, &login, now),
        crate::github_pings::poll(path, workspace, &login, now)
    );
    let (items, mut warnings) = discovery?;
    warnings.extend(monitoring.warnings);
    Ok(GitHubSnapshot {
        fetched_at: Utc::now().to_rfc3339(),
        login,
        items,
        warnings,
        pings: monitoring.pings,
    })
}

async fn discover(
    path: &Path,
    login: &str,
    now: DateTime<Utc>,
) -> Result<(Vec<Value>, Vec<String>), String> {
    let buckets = [
        Bucket::Direct,
        Bucket::Team,
        Bucket::Authored,
        Bucket::Mention,
        Bucket::Reviewed,
        Bucket::Assigned,
        Bucket::IssueMention,
    ];
    let results: Vec<(Bucket, Vec<SearchItem>)> = stream::iter(buckets)
        .map(|bucket| async move {
            let output = run_gh(path, &search_args(bucket, now))
                .await
                .map_err(|e| format!("{bucket:?} query failed: {e}"))?;
            let items = serde_json::from_slice(&output).map_err(|_| {
                format!(
                    "{bucket:?} query returned an invalid response; previous snapshot retained."
                )
            })?;
            Ok::<_, String>((bucket, items))
        })
        .buffered(3)
        .try_collect()
        .await?;
    let mut warnings = Vec::new();
    let mut to_enrich = HashMap::new();
    for (bucket, items) in &results {
        if items.len() >= LIMIT {
            warnings.push(format!("{bucket:?} search reached {LIMIT} results and may be incomplete. Missing work has not been removed."));
        }
        for item in items {
            let key = url(item, *bucket)?;
            if !item.is_draft
                && matches!(
                    bucket,
                    Bucket::Direct | Bucket::Team | Bucket::Reviewed | Bucket::Authored
                )
            {
                to_enrich.insert(key, item.clone());
            }
        }
    }
    let enriched: Vec<(String, Details)> = stream::iter(to_enrich).map(|(key, item)| async move {
        let args = vec!["pr".into(), "view".into(), item.number.to_string(), "--repo".into(), item.repository.name_with_owner, "--json".into(), "reviewDecision,mergeable,statusCheckRollup,isDraft,additions,deletions,changedFiles".into()];
        let output = run_gh(path, &args).await.map_err(|e| format!("PR enrichment failed: {e}"))?;
        let details = serde_json::from_slice(&output).map_err(|_| "GitHub returned invalid PR details.".to_string())?;
        Ok::<_, String>((key, details))
    }).buffer_unordered(4).try_collect().await?;
    let enriched: HashMap<_, _> = enriched.into_iter().collect();
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for (bucket, mut candidates) in results {
        candidates.sort_by_key(|item| item.updated_at);
        for candidate in candidates {
            let identity = url(&candidate, bucket)?;
            if seen.contains(&identity.to_ascii_lowercase()) {
                continue;
            }
            if let Some(item) = work_item(&candidate, bucket, enriched.get(&identity), &login, now)
            {
                seen.insert(identity.to_ascii_lowercase());
                items.push(item);
            }
        }
    }
    Ok((items, warnings))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approved_mergeable_and_real_ci_required() {
        let mut detail = Details {
            review_decision: Some("APPROVED".into()),
            mergeable: Some("MERGEABLE".into()),
            ..Default::default()
        };
        assert_eq!(authored_action(&detail).unwrap().0, "merge");
        detail.status_check_rollup = vec![json!({"conclusion":"", "status":"IN_PROGRESS"})];
        assert!(authored_action(&detail).is_none());
        detail.status_check_rollup = vec![json!({"state":"SUCCESS"})];
        assert_eq!(authored_action(&detail).unwrap().0, "merge");
        detail.mergeable = Some("UNKNOWN".into());
        assert!(authored_action(&detail).is_none());
        detail.status_check_rollup = vec![json!({"conclusion":"FAILURE"})];
        assert_eq!(authored_action(&detail).unwrap().0, "fix");
        assert_eq!(
            ci(&[json!({"conclusion":"FUTURE_UNKNOWN_STATE"})]),
            Ci::Pending
        );
    }
    #[test]
    fn direct_and_team_searches_are_narrow_and_capped() {
        let direct = search_args(Bucket::Direct, Utc::now());
        assert!(direct.contains(&"user-review-requested:@me".to_owned()));
        assert!(!direct.contains(&"review-requested:@me".to_owned()));
        assert!(
            search_args(Bucket::Team, Utc::now())
                .contains(&format!("team-review-requested:{TEAM}"))
        );
        assert!(direct.contains(&"50".to_string()));
    }
    #[test]
    fn every_search_excludes_archived_repositories() {
        for bucket in [
            Bucket::Direct,
            Bucket::Team,
            Bucket::Authored,
            Bucket::Mention,
            Bucket::Reviewed,
            Bucket::Assigned,
            Bucket::IssueMention,
        ] {
            let args = search_args(bucket, Utc::now());
            assert!(args.contains(&"archived:false".to_owned()), "{bucket:?}");
        }
    }
    #[test]
    fn issue_mentions_search_issues_with_the_existing_mention_window() {
        let now = DateTime::parse_from_rfc3339("2026-09-08T18:00:00Z")
            .unwrap()
            .to_utc();
        let args = search_args(Bucket::IssueMention, now);
        assert_eq!(&args[..2], ["search", "issues"]);
        assert!(args.contains(&"--mentions=@me".into()));
        assert!(args.contains(&"--updated=>=2026-09-05".into()));
        assert!(args.contains(&"--state=open".into()));
        assert!(args.contains(&"archived:false".into()));
        assert!(args.contains(&LIMIT.to_string()));
        assert_eq!(
            args.last().unwrap(),
            "number,title,repository,author,createdAt,updatedAt"
        );
        assert!(!args.iter().any(|arg| arg.starts_with("--assignee")));
        assert_eq!(search_args(Bucket::Mention, now)[1], "prs");
        assert_eq!(search_args(Bucket::Assigned, now)[1], "issues");
    }

    #[test]
    fn issue_mentions_create_reply_work_even_on_self_authored_issues() {
        let now = DateTime::parse_from_rfc3339("2026-09-08T18:00:00Z")
            .unwrap()
            .to_utc();
        let mut item: SearchItem = serde_json::from_value(json!({
            "number": 42,
            "title": "Please clarify this issue",
            "repository": {"nameWithOwner": "acme/repo"},
            "author": {"login": "other"},
            "createdAt": now - Duration::days(30),
            "updatedAt": now
        }))
        .unwrap();
        let work = work_item(&item, Bucket::IssueMention, None, "me", now).unwrap();
        assert_eq!(
            work["id"],
            "github:https://github.com/acme/repo/issues/42:reply"
        );
        assert_eq!(work["kind"], "mention");
        assert_eq!(work["status"], "available");
        assert_eq!(work["title"], item.title);
        assert_eq!(
            work["sources"][0]["reference"],
            "https://github.com/acme/repo/issues/42"
        );
        assert_eq!(
            work["sources"][0]["id"],
            "github:https://github.com/acme/repo/issues/42:IssueMention"
        );
        assert_eq!(
            work["nextStep"],
            "Check whether this mention needs your reply."
        );
        assert!(work["evidence"].as_str().unwrap().contains("not proof"));
        assert!(work.get("review").is_none());
        assert!(work.get("routine").is_none());
        assert_ne!(
            work["id"],
            work_item(&item, Bucket::Mention, None, "me", now).unwrap()["id"]
        );
        assert_eq!(
            url(&item, Bucket::Assigned).unwrap(),
            url(&item, Bucket::IssueMention).unwrap()
        );

        item.author = Some(Author { login: "ME".into() });
        assert!(work_item(&item, Bucket::IssueMention, None, "me", now).is_some());
        assert!(work_item(&item, Bucket::Mention, None, "me", now).is_none());
        item.updated_at = now - Duration::days(3);
        assert!(work_item(&item, Bucket::IssueMention, None, "me", now).is_some());
        item.updated_at -= Duration::seconds(1);
        assert!(work_item(&item, Bucket::IssueMention, None, "me", now).is_none());
    }

    #[test]
    fn real_diff_data_and_weak_signals_remain_distinct() {
        let now = Utc::now();
        let item = SearchItem {
            number: 42,
            title: "Small change".into(),
            repository: Repository {
                name_with_owner: "acme/repo".into(),
            },
            author: Some(Author {
                login: "other".into(),
            }),
            created_at: now,
            updated_at: now,
            is_draft: false,
        };
        let details = Details {
            additions: Some(12),
            deletions: Some(3),
            changed_files: Some(2),
            ..Default::default()
        };
        let direct = work_item(&item, Bucket::Direct, Some(&details), "me", now).unwrap();
        assert_eq!(direct["review"]["lines"], 15);
        assert_eq!(direct["review"]["request"], "direct");
        let team = work_item(&item, Bucket::Team, None, "me", now).unwrap();
        assert_eq!(team["id"], direct["id"]);
        assert_eq!(team["review"]["request"], "team");
        assert!(team["review"].get("lines").is_none());
        let reviewed = work_item(&item, Bucket::Reviewed, None, "me", now).unwrap();
        assert!(
            reviewed["evidence"]
                .as_str()
                .unwrap()
                .contains("does not prove")
        );
    }

    #[tokio::test]
    #[ignore = "Reads GitHub search and PR metadata using the existing gh sign-in."]
    async fn live_github_sync_smoke() {
        let path = crate::tools::resolve_tool("gh", "").unwrap();
        let snapshot = tokio::time::timeout(std::time::Duration::from_secs(180), sync(&path, None))
            .await
            .unwrap()
            .unwrap();
        assert!(!snapshot.login.is_empty());
        for item in snapshot.items {
            assert!(
                item["id"]
                    .as_str()
                    .unwrap()
                    .starts_with("github:https://github.com/")
            );
            assert!(item["steps"].is_array());
            assert!(crate::storage::iso(&item["updatedAt"]));
        }
    }
}
