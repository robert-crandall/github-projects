# Product Requirements Document: GH Projects (Working Title)

> Historical reference only. The greenfield requirements in [`PRODUCT.md`](../PRODUCT.md) supersede this document. Do not restore its project-first dashboard, routing rules, or notification-triggered snoozing.

**Target User:** Solo developer with ADHD, managing personal projects with heavy GitHub involvement  
**Platform:** macOS desktop app

---

## What This App Is

A personal project management tool for developers. It answers the question "what am I working on and what do I need to do next?" — and, as a second-order capability, it surfaces GitHub notifications in the context of the projects they belong to.

This is not a GitHub notification manager. GitHub notifications are one input into a project-centric view of your work.

---

## Design Principles

- **Project-first.** The app opens to your projects, not your notifications.
- **Aesthetically considered.** Native dark/light mode, theme support, and a UI that feels crafted — not utilitarian. The visual quality of the app is a feature.
- **Non-blocking.** All network I/O (GitHub sync, notification fetch, content prefetch) is async and happens behind the scenes. The UI is never waiting on the network.
- **Low friction.** State management is simple. Features that require ongoing manual upkeep are a red flag.

---

## Core Concepts

### Projects
The primary unit of the app. A project is a container for your work context and anything related to it.

Each project has:
- **Name**
- **Notes** — free-form text for context, requirements, links to docs, etc.
- **Next action** — a short text field; single most important next step
- **Todo list** — a lightweight ordered task list scoped to this project
- **Links** — a labeled URL list (e.g., "Staging", "Figma", "Linear board")
- **GitHub notifications** — threaded notifications routed to this project
- **Status** — Active or Snoozed

### Inbox
Notifications that have arrived but haven't been assigned to a project yet. The inbox is a first-class view, not a fallback bucket.

### Notification Threads
The app tracks GitHub notifications at the thread level. Each thread belongs to at most one project (or sits in the inbox if unmapped).

### Routing Rules
Two-tier system for routing incoming notifications to projects:
- **Thread-level mapping** — explicit: this thread goes to this project
- **Repo-level rule** — implicit: all notifications from this repo go to this project (unless a thread-level mapping overrides it)

Precedence: thread-level > repo-level > inbox.

---

## Features

### 1. Project Management

Users can create, edit, and delete projects. Within a project, they can:
- Edit the name, notes, next action, and links at any time
- Manage a todo list (add, check off, reorder, delete tasks)
- View all GitHub notification threads routed to this project
- Snooze the project

The dashboard shows all active projects with their next action and unread notification count. Snoozed projects are visible in a collapsed section.

### 2. GitHub Integration

**Authentication:** GitHub OAuth.

**Notification sync:** Polls the GitHub Notifications API on a configurable interval. Sync is fully async — the app never blocks on it.

**Async content prefetch:** After the notification list syncs, notification content (thread details) is fetched in the background. The list renders immediately from local data; fetched content populates in place. Content is considered stale only when a new notification arrives on that thread.

**Thread closure:** When GitHub signals that a thread is resolved — PR merged, issue closed, etc. — the thread is automatically removed from view globally. No acknowledgment, no archive step, just gone. Unsubscribe (write-back to GitHub API) is the manual equivalent.

**Read state:** Tracked locally. Marking a notification read does not write back to GitHub.

**Unsubscribe:** Calls the GitHub API to unsubscribe from a thread, which also closes it locally.

### 3. Inbox and Routing

When a notification arrives from an unmapped thread:
- It appears in the Inbox
- The user assigns it to a project (or creates a new one)
- The app records the thread → project mapping for future notifications on that thread

After assigning a thread, the app evaluates whether to offer a repo-level rule:
- **No other mapped threads from that repo:** Offer an opt-in — "Always route [repo] to [project]?"
- **All other threads from that repo already go to the same project:** Offer an opt-out (pre-checked) — pattern is already established
- **Threads from that repo are split across projects:** No offer — thread-level mapping is appropriate

If a repo rule is created, the user can optionally migrate already-mapped threads from that repo to the new rule.

Repo-level rules can be edited and deleted from Settings.

### 4. Notification Filtering

Filters suppress notifications from appearing anywhere in the app. Filtering operates on multiple dimensions:

| Dimension | Match type |
|-----------|-----------|
| Author | Substring (case-insensitive) |
| Org | Substring |
| Repo | Substring |
| Reason | Select (enum) |
| State | Select (enum) |
| Type | Select (enum) |

Multiple filters combine with AND logic. Active filters are displayed as removable chips.

**Two-tier type filtering:**
- **Global rules** are a non-overridable floor. A notification type suppressed globally is suppressed everywhere.
- **Per-repo rules** are strictly additive. A repo rule can suppress additional types beyond the global set; it cannot un-suppress a globally suppressed type.

The UI makes this hierarchy visually explicit.

Filters are session-scoped in v1.

### 5. Snooze

Projects can be snoozed in three modes:
- **Manual** — hidden until the user manually un-snoozes
- **Date-based** — hidden until a specific date, then auto-surfaced
- **Notification-triggered** — hidden until a new GitHub notification arrives for this project

Snoozed projects appear in a collapsed section of the dashboard.

### 6. Appearance

- Native macOS dark/light mode support
- Theme support (multiple built-in themes, at minimum)
- UI is visually distinctive

---

## Technical Constraints

All GitHub API calls and DB writes happen off the render thread. The UI never blocks on I/O.

---

## Out of Scope

- GitHub write-back beyond unsubscribe
- Multi-user or team features
- Mobile
- Integrations beyond GitHub
- Gantt charts, sprints, velocity, or any "enterprise PM" concepts

---

## Success Criteria

The app is shippable when:

1. User can authenticate with GitHub and pull notifications
2. Notifications are routed to projects via thread and repo rules
3. Unmapped notifications surface in the Inbox
4. Projects display name, notes, next action, todo list, links, and notifications
5. Closed/merged threads disappear automatically
6. Unsubscribe works
7. Filtering works across all specified dimensions with global/per-repo type hierarchy
8. Snooze works in all three modes
9. Dark/light mode and at least one theme variant work correctly
10. No UI lockup — all network I/O is async

**Success looks like:**
- Opening the app tells you what you're working on and what to do next
- GitHub notifications appear where they're relevant, not as a firehose
- Snoozed work stays invisible until it matters
- The app feels good to use
