# Concord Deployment Guides

Operator runbooks for deploying Concord. Start with the target that matches your environment.

| Guide | Target | When to use |
|-------|--------|-------------|
| [orrgate.md](./orrgate.md) | Single-host Docker Compose on a Linux VM | First real deployment. Self-hosted, federation-enabled, behind Caddy + Cloudflare. |
| [github_bug_report_token.md](./github_bug_report_token.md) | GitHub PAT rotation | You set up `GITHUB_BUG_REPORT_TOKEN` and need to rotate the credential or audit its scope. |

New environments should land their own `.md` file in this directory and link into the table above.
