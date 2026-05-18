# Concord Host Allowlist (Where Concord Runs)

Concord has exactly **two** sanctioned deploy targets in the user's
infrastructure. Any other host is forbidden. `install.sh` enforces this
at runtime.

| Host  | Role                | Always-on   | Notes                                          |
|-------|---------------------|-------------|------------------------------------------------|
| `orr1on` | **Production**   | yes         | AWS EC2. Serves `concorrd.com`. Pulls from `main` releases only. |
| `orrion` | **Development**  | yes (dev)   | User's daily-driver workstation. Runs real-time-tested branches against the user's own client. |

## Forbidden hosts

| Host       | Why it must never deploy concord |
|------------|-----------------------------------|
| `orrgate`  | orrgate is the Docker/services VM for non-concord stacks (orrapus, plex, NPM, pihole, etc.). Concord has its own dedicated host (`orr1on`); duplicating it on orrgate eats the root disk with Rust/Tauri build artifacts (a single `target/` tree is 5–10 GB and concord has cross-compile targets for x86_64, arm64, Windows, macOS). The 2026-05-17 orrapus outage was caused by orrgate's root LV hitting 100% — about 32 GB of which was an orphan concord checkout that never should have existed there. |
| any host not in the allowlist | Defaults to forbidden. Add a row to this table + update `install.sh` if you mean to add one. |

> **Note for orrion.** The "NEVER autocorrect" rule applies — `orr1on` is
> the AWS production host (numeric digit `1`), distinct from `orrion`
> the dev workstation. They are different machines with different roles.

## Enforcement

`install.sh` reads `$(hostname)` at startup and aborts with a clear
message if the lowercased hostname matches a forbidden host. To
deliberately bypass the check (e.g. a one-off recovery exercise on a
disposable host), export `CONCORD_HOST_ALLOWLIST_BYPASS=i-know-what-im-doing`
before invoking `install.sh`. The bypass is intentionally awkward to
type so it doesn't get habituated.

## Adding a new sanctioned host

1. Add a row to the **allowed** table above with role + notes.
2. Add the lowercase hostname to the `_CONCORD_ALLOWED_HOSTS` array
   near the top of `install.sh`.
3. Open a PR describing the operational reason.

## Adding a new forbidden host

1. Add a row to the **Forbidden hosts** table above with the
   one-sentence reason.
2. Add the lowercase hostname to the `_CONCORD_FORBIDDEN_HOSTS` array
   near the top of `install.sh`.
3. Open a PR.

## What happened on 2026-05-17

For audit/teaching purposes:

orrgate's `/docker/stacks/concord/` was 32 GB of orphan Rust build
artifacts and five sub-agent git worktrees (w01, w02, w04, w05, w06,
all stale from 2026-04-28) that had been accidentally placed on the
wrong host months prior. It accumulated alongside Docker build cache
(57 GB) and unused images (46 GB) until the orrgate root LV hit 100 %
and orrapus's gunicorn workers could no longer write logs or open
sqlite, returning HTTP 500. After service restoration, the orphan tree
was archived to `orrigins:/mnt/orrigins/backup/orphans/` and removed.
This allowlist + install.sh guard exists so a misroute can't happen
again.
