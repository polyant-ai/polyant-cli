# Security Policy

## Supported Versions

Security fixes land on `main` and in the latest release tag. Older tags are not
maintained: upgrade to the latest release to receive a fix.

| Version     | Supported |
|-------------|-----------|
| latest tag  | yes       |
| `main`      | yes       |
| older tags  | no        |

## Reporting a Vulnerability

**Please do not open a public GitHub issue to report a security vulnerability.**

Use GitHub's private vulnerability reporting instead:

1. Go to the repository's **Security** tab on GitHub.
2. Click **Report a vulnerability**.
3. Describe the issue: steps to reproduce, the affected version or commit, and the
   impact you expect.

### What to expect

- We acknowledge reports within **48 hours**.
- We aim to triage and confirm within **7 days**.
- We target a fix within **30 days** for high-severity issues; lower-severity
  issues may take longer.
- We coordinate disclosure with you. We generally prefer **90 days** between report
  and public disclosure, and we are flexible about it.
- We credit reporters in the release notes unless you prefer to stay anonymous.

### Scope

`polyant-cli` holds credentials for a Polyant instance and forwards requests to its
management API. In scope:

- A credential (management key or personal token) leaking into argv, logs, stdout,
  stderr, a recap, a config file the CLI writes, or a request to a host other than
  the selected target (for example across a redirect)
- A secret or payload read from `--file` or stdin being echoed back
- A destructive command running without the confirmation the CLI documents
  (`--yes`, `--confirm <name>`, the production-target refusal)
- Code execution through a crafted `polyant.yaml`, response body, or `dev` project
- Vulnerabilities in the CLI's own dependencies that are reachable from its code

Out of scope:

- Vulnerabilities in the Polyant engine itself: report those to the engine's
  repository
- Issues that need an attacker who already controls the operator's shell,
  environment variables or working directory
- Issues in third-party dependencies that do not affect the CLI's code paths
  (report those upstream)

## Thanks

We appreciate responsible disclosure. Thank you for helping keep Polyant users safe.
