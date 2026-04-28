# Contributing to concord

Thanks for showing up. concord is a small project run mostly by one maintainer with parallel AI-assisted sessions, so the contribution process is optimized for low overhead and clear isolation. Read this once before opening a PR.

## Filing an issue

1. Check whether your issue is actually a question — those go to [Discussions](https://github.com/TruStoryHnsl/concord/discussions), not Issues.
2. Use the templates in `.github/ISSUE_TEMPLATE/`. Bug report or feature request — pick one. Blank issues are disabled on purpose.
3. Bug reports need: what you expected, what actually happened, reproduction steps, version, environment, and logs. The more concrete, the faster the fix.
4. Mesh / Reticulum / libp2p / WireGuard P2P video questions belong on the [concord-beta](https://github.com/TruStoryHnsl/concord-beta) repo, not here.

## Opening a PR

### 1. Branch from `main` on your own branch

```
git switch main
git pull
git switch -c feat/<short-slug>
```

Branch naming: `feat/<slug>`, `fix/<slug>`, `refactor/<slug>`, `chore/<slug>`. If multiple sessions could plausibly pick similar slugs, add a short disambiguating suffix (`feat/mobile-pill-menu-a3f9`).

**One session, one branch.** Don't append your work to someone else's branch silently. If the branch you find checked out doesn't match what you're doing, stop and ask.

**Don't `git merge main` into your feature branch** unless there's a specific upstream commit you genuinely need. Merging main pulls in every other parallel session's partial state; that's the regression vector this discipline exists to prevent.

### 2. Conventional commits

Every commit message follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[scope]: <description>

[optional body]

[optional footer]
```

| Type | When |
|---|---|
| `feat` | New user-visible capability |
| `fix` | Bug fix |
| `docs` | Docs only |
| `refactor` | Code change with no behavior change |
| `perf` | Performance improvement |
| `test` | Tests only |
| `chore` | Tooling, deps, housekeeping |
| `ci` | CI config |
| `build` | Build system / packaging |

Breaking changes: `feat!: ...` or include a `BREAKING CHANGE:` footer.

Examples:
- `feat(client): add edge-tap shortcut for channel sidebar`
- `fix(server): resolve federation hot-swap race in tuwunel_config`
- `feat!: rename CONDUWUIT_SERVER_NAME to CONCORD_SERVER_NAME`

### 3. Test what you changed

- Server changes: `cd server && pytest`
- Client changes: `cd client && npm test` (and `npm run lint`)
- UI changes: spin up the dev stack (`docker compose -f docker-compose.yml -f docker-compose.dev.yml up`) and click through the affected flow yourself. "It compiled" isn't a test result.
- Federation / docker-control changes: verify the hot-swap restart actually works against a real tuwunel container — `services/tuwunel_config.py` and `services/docker_control.py` are touchy.

If your change is user-visible, add a `CHANGELOG.md` entry under the `## [Unreleased]` heading using the [Keep a Changelog](https://keepachangelog.com/) categories.

### 4. Open the PR

- Title: same conventional-commit format as your commits.
- Description: use `.github/PULL_REQUEST_TEMPLATE.md`. Fill in Summary, Test plan, Breaking changes, Related issues.
- Keep PRs focused. One feature or one fix per PR. Refactors that aren't strictly needed go in their own PR.
- Don't squash unrelated commits together. Don't force-push branches that aren't yours.

### 5. Review

The maintainer (and/or AI review agents) will review. Expect direct, terse feedback. If a reviewer asks for a change, push a new commit on the same branch — don't amend or force-push unless asked. After approval, the PR is merged via squash or merge commit at the maintainer's discretion.

## Code style

- **Python (server)**: type hints on public functions. `ruff` clean. Keep routers thin; logic goes in `services/`.
- **TypeScript (client)**: strict mode. Prefer Zustand stores over prop drilling. `client/src/api/` for HTTP clients, `components/` for UI, `hooks/` for reusable hooks.
- **Rust (Tauri)**: standard `cargo fmt` + `cargo clippy`. Tauri commands stay in `src-tauri/src/`.
- **Docker / Caddy / config**: no secrets in committed files. Real `.env` is gitignored — only `.env.example` is committed.

## Things to avoid

- **Don't introduce new top-level config files casually.** `.env`, `docker-compose*.yml`, and `config/` are the surfaces. Adding a new one is a design decision worth a discussion.
- **Don't bypass `services/tuwunel_config.py`** to hand-edit `config/tuwunel.toml`. The atomic tmp-file-then-rename matters; the read-only bind mount in tuwunel matters; the regex-anchoring + RFC-1123 hostname validation matters. If you need to change federation policy programmatically, go through that service.
- **Don't mount the host docker socket** into anything. The `docker-socket-proxy` sidecar with `CONTAINERS=1 POST=1` is the seam that makes runtime federation control safe; bypassing it removes the security boundary.
- **Don't commit binary captures** (screenshots, mp4s, screen recordings). They go stale fast and bloat the repo. UI evidence belongs in PR descriptions or Discussions, not in the tree.

## Scope

concord is `commercial`-scoped under the workspace's scope semantics — the public-facing posture is "production-grade self-hosted comms platform with native-app monetization." That means:

- All endpoints validate input.
- Errors don't leak stack traces to end users.
- Dependencies are license-audited (no GPL into proprietary surfaces).
- User-facing strings get a polish pass.

Concord-beta (the mesh research fork) is a separate, more experimental project.

## License

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE) of this repo.
