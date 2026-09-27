# Security policy

Factory handles GitHub App private keys, installation tokens and Codex login credentials. Please report vulnerabilities privately.

## Reporting

Use GitHub's [private vulnerability reporting](../../security/advisories/new) on this repository. Do not open a public issue.

Include:

- affected component (main app, sandbox runner, container image)
- steps to reproduce or a proof of concept
- impact as you understand it

We aim to acknowledge reports within five working days and will keep you updated until a fix is released.

## Scope

In scope: authentication and domain restriction, credential storage in `CODEX_VAULT`, isolation between the Codex process and GitHub credentials in the sandbox, webhook and runner-callback verification, and the HTTP/MCP API.

Out of scope: vulnerabilities in Cloudflare, GitHub, OpenAI or other upstream services, and issues that require a compromised Cloudflare account.

## Deployment hardening

- Never set `E2E_AUTH_ENABLED` or `E2E_DISABLE_AUTH_RATE_LIMIT` in production.
- Keep `ALLOWED_EMAIL_DOMAINS` to domains you control.
- Rotate `SANDBOX_RUNNER_SECRET`/`RUNNER_SHARED_SECRET`, `FACTORY_API_KEY` and the GitHub webhook secret if they leak. Rotating `CODEX_AUTH_KEY` makes stored Codex logins unreadable; members must reconnect.
