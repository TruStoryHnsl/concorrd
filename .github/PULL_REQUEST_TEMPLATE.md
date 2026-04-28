<!--
Conventional commits required. Title format:
  <type>[scope]: <description>
  e.g. feat(client): add edge-tap shortcut for channel sidebar
       fix(server): resolve federation hot-swap race in tuwunel_config
       docs: update install.sh quickstart

Types: feat, fix, docs, refactor, perf, test, chore, ci, build
Breaking change: feat!: ... or BREAKING CHANGE: footer.

Branch naming: feat/<slug>, fix/<slug>, refactor/<slug>, chore/<slug>.
One PR == one branch == one logical change. No merging main into your branch
unless explicitly needed — concord runs many parallel sessions and that's
how regressions cascade.
-->

## Summary

<!-- 1–3 bullets. What does this change and why. Link the issue if there is one. -->

-
-

## Test plan

<!-- Concrete steps a reviewer can run. Mark [x] for what you actually verified. -->

- [ ] `docker compose up -d --build` succeeds against a clean `.env.example`-derived environment
- [ ] Manual smoke: ...
- [ ] Affected unit/integration tests pass locally
- [ ] No new console errors in the web client
- [ ] (server changes) `concord-api` logs are clean on boot

## Screenshots / recordings

<!-- For UI changes only. -->

## Breaking changes

<!-- Anything that changes a config key, API surface, federation behavior, or data layout.
     Default: "None." If non-trivial, include a migration note. -->

None.

## Related issues

<!-- "Closes #123", "Relates to #456", or "n/a". -->

## Checklist

- [ ] Conventional commit title
- [ ] Branch name matches `<type>/<slug>` convention
- [ ] No secrets, tokens, or `.env` values committed
- [ ] CHANGELOG.md updated if user-visible
- [ ] Docs updated if behavior or config changed
