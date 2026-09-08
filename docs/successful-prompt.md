Produce a "Waiting on me" digest: a checklist of everything genuinely waiting on ME so follow-through does not rely on memory. My GitHub login is robert-crandall. This is a READ-ONLY automation - the only commands you may run are gh read commands (search, pr view, api GET). Never merge, comment, close, label, review, or push anything.
Step 1 - Gather data (all commands verified to work)
Run these with the GitHub CLI:
Review requested of me directly (not via a team):
  gh search prs "user-review-requested:@me" --state=open --limit 50 --json number,title,repository,author,updatedAt,isDraft
  IMPORTANT: use the user-review-requested:@me qualifier for this list. Do not replace it with review-requested:@me, which also matches requests for every team I belong to.
Review requested of the Terraform Provider Core Maintainers team:
  gh search prs "team-review-requested:integrations/terraform-provider-core-maintainers" --state=open --limit 50 --json number,title,repository,author,updatedAt,isDraft
  Treat these as team review requests, not direct requests to me. Do not broaden this query to other teams.
My authored open PRs:
  gh search prs --author=@me --state=open --limit 50 --json number,title,repository,isDraft,updatedAt
PRs that mention me:
  gh search prs --mentions=@me --state=open --limit 50 --json number,title,repository,author,updatedAt
Open PRs I have reviewed:
  gh search prs --reviewed-by=@me --state=open --limit 50 --json number,title,repository,author,updatedAt
Issues assigned to me:
  gh search issues --assignee=@me --state=open --limit 50 --json number,title,repository,updatedAt
If gh is not authenticated or a query fails outright, STOP and report the problem in your final message instead of guessing.
Step 2 - Enrich my authored PRs
gh search prs does NOT return review decision, mergeability, or CI status. For each of MY authored open PRs (skip drafts), fetch those fields:
gh pr view <number> --repo <owner/repo> --json number,reviewDecision,mergeable,isDraft,statusCheckRollup
Compute a CI rollup from statusCheckRollup[].conclusion (fall back to .state):
FAILING if any is FAILURE / TIMED_OUT / CANCELLED / ACTION_REQUIRED / ERROR
PENDING if any is empty / PENDING / IN_PROGRESS / QUEUED / EXPECTED
PASSING if there are checks and none are failing/pending
NO_CHECKS if there are none
Note: personal repos with no branch protection often return an empty reviewDecision and mergeable: UNKNOWN - treat empty reviewDecision as "no review required" (not a blocker), and treat UNKNOWN mergeability as "not known to be conflicting."
Step 3 - Bucket into "waiting on ME" (first match wins, so each item appears once; priority order top to bottom)
Review requested of me - from the direct user review-requested list, not draft. Action: I need to review.
Team review requested - integrations/terraform-provider-core-maintainers - from the Terraform Provider Core Maintainers team review-requested list, not draft, and not already counted as a direct request above. Action: I need to review as a team member.
My PR - ready to merge - I authored it, not draft, reviewDecision == APPROVED, mergeable == MERGEABLE, CI is PASSING or NO_CHECKS. Action: I need to merge.
My PR - needs my fix - I authored it, not draft, AND at least one of: reviewDecision == CHANGES_REQUESTED, mergeable == CONFLICTING, CI == FAILING. Action: fix (say which of: changes requested / conflicts / CI).
Mentioned - may owe a reply - from the mentions list, updated within the last 3 days, NOT authored by me, and not already counted above. Action: check if I owe a reply.
PR I reviewed - recent activity - from the reviewed-by list, updated within the last 2 days, not authored by me, not already counted. Light signal that it may need a re-review.
Assigned issue - open issue assigned to me, updated within the last 30 days, not already counted. Action: my task.
De-duplicate across buckets by PR/issue identity (owner/repo#number). Within each bucket, sort by staleness (most days since updatedAt first) so old loops surface at the top.
Step 4 - Output
Print a single Markdown report:
Title: # Waiting on me - <YYYY-MM-DD>
One summary line with the count in each non-empty bucket. Keep direct review requests and integrations/terraform-provider-core-maintainers team review requests as separate counts.
One ## section per NON-EMPTY bucket, each a checklist. Use ## Team review requested - integrations/terraform-provider-core-maintainers for the team-only bucket so it is never presented as a direct request to me. Line format:
  - [ ] owner/repo#<number> - <title> (@<author>, <N>d) https://github.com/owner/repo/pull/<number>
  where <N>d is days since updatedAt. For issues use the issues URL.
Skip empty buckets entirely (do not print them).
If EVERY bucket is empty, print a one-line "Nothing is waiting on you right now." and stop.
Style: plain hyphens, never em dashes. Reference authors as plain @login only inside checklist lines - do not otherwise @-mention people. Keep it tight; the whole point is a scannable list I can act on.
Guardrails
READ-ONLY. The only allowed write action is NONE. Do not merge, comment, close, label, request review, approve, or push.
Do not open sessions or create issues/PRs. Just produce the digest as your final message.
