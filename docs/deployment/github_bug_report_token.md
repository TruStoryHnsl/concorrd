# GitHub Bug Report Token — setup, rotation, threat model

INS-028 introduced an optional GitHub integration where bug reports
submitted via Concord's in-app `BugReportModal` are mirrored to
GitHub issues on the concord repo. This document covers the
operational side: how to generate the token, how to rotate it, what
happens when it's missing or revoked, and what blast radius a
leaked token would have.

## What the token is

A **fine-grained GitHub personal access token** with exactly one
permission: `Issues: Read and write` on exactly one repository
(`TruStoryHnsl/concord` by default, overridable via the
`GITHUB_BUG_REPORT_REPO` env var).

It is **not** a classic OAuth token, **not** a `repo`-scoped PAT,
**not** a GitHub App installation token. The fine-grained PAT is
the modern, least-privilege mechanism — everything else is
over-privileged for our use case.

## What the token does

When a user submits a bug report via the in-app modal, the
`POST /api/reports` handler on `concord-api`:

1. Writes the report to the local `bug_reports` SQLite table
   (source of truth — **this step always succeeds or fails
   atomically, regardless of GitHub**).
2. Calls `POST https://api.github.com/repos/<repo>/issues` with
   the user's title and description as the issue body. On
   success, the returned issue `number` is persisted back to the
   DB row so the admin panel can deep-link to the issue.
3. On **any** GitHub-side failure (network error, 401, 403, 404,
   422, 5xx, malformed JSON, missing `number` field), the handler
   logs a WARN entry and returns a normal success response to the
   client. The user's report is **never** lost to a GitHub outage.

## Setup

### 1. Generate the fine-grained PAT

1. Log into GitHub as the account that owns or has admin access to
   the concord repo.
2. Visit [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
3. **Name**: `concord-bug-report-mirror` (or any descriptive name).
4. **Resource owner**: the org/user that owns the concord repo.
5. **Expiration**: pick a reasonable window (30–90 days) and add a
   calendar reminder to rotate. The token does not need to be
   permanent.
6. **Repository access**: **Only select repositories** →
   `TruStoryHnsl/concord`. Do **NOT** pick "All repositories" or
   "Public Repositories" — that over-grants.
7. **Permissions → Repository permissions**: find **Issues** and
   set it to **Read and write**. Leave every other permission at
   its default (`No access`). Confirm the summary shows **only
   Issues** with write access and nothing else.
8. Click **Generate token**. Copy the value — you cannot view it
   again after closing the page.

### 2. Install the token on the server

#### Docker Compose

Add to your `.env` file on the concord host:

```sh
GITHUB_BUG_REPORT_TOKEN=github_pat_your_token_here
GITHUB_BUG_REPORT_REPO=TruStoryHnsl/concord
```

Then restart the `concord-api` service:

```sh
docker compose restart concord-api
```

The server logs a single INFO line at the first bug report
submission confirming the mirror is configured:

```
bug report #1: mirrored to GitHub issue #42 in TruStoryHnsl/concord
```

If the token is missing, the log instead reads:

```
bug report #1: GITHUB_BUG_REPORT_TOKEN unset — GitHub mirror disabled
```

That's not an error — it's the expected state when the integration
is turned off.

#### Bare-metal / systemd

Add `GITHUB_BUG_REPORT_TOKEN` to the service's `EnvironmentFile=`
target or to the unit's `Environment=` directive, then
`systemctl restart concord-api`.

## Rotation

Rotate on a schedule (match the token's expiration) and **any time
the token may have leaked** (accidentally committed to git, shared
in a screenshare, left in a build log, etc.).

### 3-step rotation runbook

1. **Generate** a new fine-grained PAT following the Setup steps
   above. Copy the value.
2. **Update the env var** — edit `.env` (Docker Compose) or the
   systemd unit, replace `GITHUB_BUG_REPORT_TOKEN=...` with the
   new value, save.
3. **Restart the service**:
   ```sh
   docker compose restart concord-api   # or: systemctl restart concord-api
   ```

   Verify with a test bug report (submit one via the in-app modal
   or via `curl POST /api/reports`) and confirm a new GitHub issue
   appears on the concord repo.

4. **Revoke the old token** on GitHub:
   [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens)
   → find the old token → **Revoke**. Do not skip this step —
   leaving the old token live means it's still a valid credential
   until its natural expiration.

There is no in-process cache to invalidate — the token is read
from the env on each handler call via `config.GITHUB_BUG_REPORT_TOKEN`.
A restart is sufficient to pick up the new value.

## Threat model

### What an attacker can do with a leaked token

- Create new issues on the concord repo (arbitrary content).
- Edit or close existing issues on the concord repo.
- Read issue comments and issue metadata on the concord repo
  (by virtue of `Issues: Read and write`).

### What an attacker CANNOT do with a leaked token

- Read any source code (no `Contents` permission).
- Modify any source code, branches, or tags (no `Contents: write`).
- Modify repository settings, collaborators, or secrets (no
  `Administration` permission).
- Access private issues on other repositories (the token is
  scoped to one repo).
- Touch any other GitHub resource: Actions, Pages, Projects,
  Packages, Dependabot, etc. — all permissions default to `No
  access`.
- Access the concord homeserver, concord-api, LiveKit SFU, TURN
  server, database, or any other service behind the `concord-*`
  docker-compose stack. The token has zero bearing on anything
  outside github.com's API.

### Detection

If someone starts spam-filing issues via a leaked token, the
signal is obvious: a burst of new issues on the concord repo with
varied content not matching in-app submissions. Rotate the token
(runbook above) and the burst stops instantly.

GitHub's fine-grained PAT dashboard shows the last-used timestamp
and approximate request count for each token — useful for
detecting whether a long-unused token has been activated without
authorization.

### Blast radius summary

| Compromise scenario | Impact |
|---|---|
| Token leaked to public logs | Attacker can spam issues on the concord repo. Rotate, move on. |
| Token committed to git | Same as above. Also trigger GitHub's secret-scanning to confirm it was revoked. |
| Attacker MITMs the GitHub API call | Impossible in practice — the client uses HTTPS with the system CA bundle. |
| Attacker reads the server's env file | Yes, they get the token. They do NOT get any other Concord secrets unless those are co-located. Treat like any leaked credential. |
| `concord-api` process memory dump | Token is in the env var space, visible to anyone with local root on the host. Same threat model as every other env-based secret. |

## Disabling the integration

Set `GITHUB_BUG_REPORT_TOKEN=` (empty) in the env and restart
`concord-api`. Bug reports continue to work — they're stored in
the local `bug_reports` table and surfaced in the admin panel as
before. The `bug_reports.github_issue_number` column stays NULL
for reports filed while the token is unset.

## Failure modes and what users see

| Server state | User experience | Admin sees |
|---|---|---|
| Token unset | "Report submitted" ✓ | Report row, "GitHub mirror unavailable" label |
| Token set + GitHub reachable | "Report submitted" ✓ | Report row, "View on GitHub (issue #N)" link |
| Token set + GitHub returns 401 | "Report submitted" ✓ | Report row, "GitHub mirror unavailable" label, WARN in log |
| Token set + GitHub unreachable | "Report submitted" ✓ | Same as above |
| Token set + rate limited | "Report submitted" ✓ | Same as above, rate-limit headers in WARN log |
| Local DB write fails | "Report failed" ✗ | Nothing written, stack trace in ERROR log |

The invariant: **the user-facing POST /api/reports endpoint's
return status is determined solely by the local DB write**. The
GitHub mirror is a best-effort background operation whose failure
is invisible to the user.

## Related

- Code: `server/routers/admin.py` — `_create_github_issue_for_bug_report`
- Config: `server/config.py` — `GITHUB_BUG_REPORT_TOKEN`, `GITHUB_BUG_REPORT_REPO`
- Model: `server/models.py` — `BugReport.github_issue_number`
- Migration: `server/database.py` — `_lightweight_migrations()`
- Tests: `server/tests/test_bug_reports.py` — 10 cases covering
  happy path + every documented failure mode
- Origin: commit `71c5c2b` (renumbered from original INS-026),
  PLAN.md section "PRIORITY: GitHub Bug Report Integration
  (INS-028, routed 2026-04-08)"
