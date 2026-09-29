# Configuration and secrets

Store secret values with `wrangler secret put` (stdin) or the Cloudflare dashboard. Never commit login files, private keys or secret values. Non-secret settings live in `vars` in each `wrangler.jsonc`.

## Build-time settings (main app)

Next.js inlines these when you run `opennextjs-cloudflare build`. Set them in the build environment or a `.env.production` file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` | `Factory` | Name shown in the UI, emails and API catalog |
| `NEXT_PUBLIC_LABEL_PREFIX` | `factory` | GitHub label prefix: `<prefix>:ready`, `<prefix>:done`, `<prefix>:risk:*`. Must match the runner's `LABEL_PREFIX` |

## Main Worker

| Name | Kind | Source |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | secret | 32+ random bytes. Keep it stable: rotating it signs everyone out |
| `BETTER_AUTH_URL` | secret or var | Public origin, e.g. `https://factory.example.com` |
| `ALLOWED_EMAIL_DOMAINS` | var | Comma-separated Google Workspace domains allowed to sign in. Empty rejects everyone |
| `TRUSTED_ORIGINS` | var | Optional extra origins for Better Auth, e.g. your `workers.dev` URL |
| `SANDBOX_RUNNER_URL` | secret | Runner Worker URL, e.g. `https://factory-sandbox.<subdomain>.workers.dev` |
| `SANDBOX_RUNNER_SECRET` | secret | Random value. Must match the runner's `RUNNER_SHARED_SECRET` |
| `GOOGLE_CLIENT_ID` | secret | Google Cloud OAuth web client |
| `GOOGLE_CLIENT_SECRET` | secret | Matching Google OAuth secret |
| `GITHUB_APP_ID` | secret | GitHub App numeric ID |
| `GITHUB_APP_PRIVATE_KEY` | secret | Entire downloaded PEM, including BEGIN/END lines |
| `GITHUB_APP_CLIENT_ID` | secret | GitHub App client ID |
| `GITHUB_APP_CLIENT_SECRET` | secret | GitHub App client secret |
| `GITHUB_APP_SLUG` | secret | GitHub App URL slug |
| `GITHUB_APP_WEBHOOK_SECRET` | secret | Same random value configured in the GitHub App webhook settings |
| `FACTORY_API_KEY` | secret | Optional bearer key for `/api/v1` and `/api/mcp` |
| `PAPERBOY_API_URL` | var | Optional. Origin of your [PaperBoy](https://github.com/yumaitau/paperboy) instance |
| `PAPERBOY_API_KEY` | secret | Optional. PaperBoy API key |
| `PAPERBOY_FROM` | var | Optional. Sender, e.g. `Factory <factory@example.com>` |
| `PAPERBOY_DIGEST_TO` | var | Optional comma-separated recipients. Defaults to every user on an allowed domain |

The morning digest runs only when `PAPERBOY_API_URL`, `PAPERBOY_API_KEY` and `PAPERBOY_FROM` are all set.

## Runner Worker (`sandbox-runner`)

| Name | Kind | Source |
| --- | --- | --- |
| `RUNNER_SHARED_SECRET` | secret | Same value as the main app's `SANDBOX_RUNNER_SECRET` |
| `CODEX_AUTH_KEY` | secret | Random 32-byte key, base64-encoded (`openssl rand -base64 32`). Keep it: replacing it makes stored Codex logins and Claude tokens unreadable |
| `FACTORY_URL` | var | Public origin of the main app, used for callbacks |
| `LABEL_PREFIX` | var | Optional, default `factory`. Must match `NEXT_PUBLIC_LABEL_PREFIX` |
| `COMMIT_AUTHOR_NAME` | var | Optional, default `Factory`. Author of agent commits |
| `COMMIT_AUTHOR_EMAIL` | var | Optional, default `factory@users.noreply.github.com` |

Codex logins and Claude subscription tokens are connected through the app and encrypted in the private `CODEX_VAULT` R2 bucket. They are not Worker environment secrets. No model API keys are required.

## External settings

- Google OAuth redirect URI: `{BETTER_AUTH_URL}/api/auth/callback/google`.
- GitHub App callback URL: `{BETTER_AUTH_URL}/api/github/callback`.
- GitHub App webhook URL: `{BETTER_AUTH_URL}/api/github/webhook`. Subscribe to **Issues** events.
- GitHub App permissions: Contents, Issues and Pull requests read/write; Metadata, Administration, Checks, Commit statuses and Actions read.

Device-code sign-in uses the official Codex authorization page. Claude subscriptions use a long-lived token from `claude setup-token` (Claude Pro or Max); Anthropic API keys are refused. Each subscription authorizes its own login. Owners control whether other team members may assign work to it.
