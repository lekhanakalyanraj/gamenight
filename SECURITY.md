# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the **Security** tab and choose **Report a vulnerability**. Don't open a public issue. You'll get a reply within 7 days.

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
- **database security tests** (pgTAP for row-level security and every RPC, plus Supabase's security advisors)

See `.github/workflows/`. `make security` runs the same scanners locally.
