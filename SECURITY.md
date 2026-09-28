# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately: **[report a vulnerability](https://github.com/lekhanakalyanraj/gamenight/security/advisories/new)** (GitHub private vulnerability reporting). Don't open a public issue.

**What happens next:**

| When | What |
|---|---|
| Within 7 days | We acknowledge your report and confirm whether we can reproduce it |
| Within 30 days | A fix or mitigation for high and critical issues (lower severities in the next release) |
| Within 90 days of your report | Coordinated disclosure: we publish an advisory, crediting you unless you'd rather stay anonymous |

Only the latest version on `main` is supported. We don't take legal action over good-faith research that follows this policy and doesn't touch other people's data.

The most useful reports show a player or guest being able to:

- see another player's hidden role, word or answer
- act in, read, or subscribe to a room they aren't a member of
- get past a room's age rating
- make the AI host reveal secrets or say something outside the room's rating
- run up model or text-to-speech costs without limit
- reach an API key, or anything else that bypasses row-level security

**Out of scope:** the demo account in `supabase/seed.sql`. It exists only in the local development stack.

## How the code is checked

Every pull request runs:
- **secret scanning** (gitleaks)
- **static analysis** (Semgrep with custom rules, CodeQL)
- **dependency scanning** (OSV-Scanner, dependency review)
- **workflow auditing** (zizmor, actionlint)
- **database security tests** (pgTAP for row-level security, every RPC and service isolation, plus Supabase's security advisors)
- **image scanning** (hadolint for every Dockerfile, Grype for every image)
- **end-to-end tests**, including security headers and the CSP

Every merge to `main` publishes images only after they pass Grype, with an SBOM and signed build provenance. A nightly OWASP ZAP scan runs against the web image.

See `.github/workflows/`. `make security` runs the same scanners locally.
