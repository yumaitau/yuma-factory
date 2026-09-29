# Factory

A self-hosted agent software factory on Cloudflare. Connect GitHub repositories, label issues, and let Codex or Claude Code agents implement them in isolated containers. Factory opens a pull request, fixes failing CI until it is green, and closes the issue. Low-risk tickets can merge automatically.

Factory runs on Cloudflare Workers, D1, R2, Queues and Containers (the [Sandbox SDK](https://developers.cloudflare.com/sandbox/)). Agents use your own ChatGPT (Codex) or Claude (Claude Code) subscriptions. No model API keys are required.

> Subscriptions are subject to OpenAI's and Anthropic's terms. Check that your plan permits the way you share and automate it.

## How it works

1. Team members sign in with Google Workspace. Only domains in `ALLOWED_EMAIL_DOMAINS` are accepted.
2. On **Subscriptions**, each member connects a ChatGPT account for Codex by device-code sign-in or by importing a Codex `auth.json`, or a Claude Pro/Max account for Claude Code by pasting a token from `claude setup-token`. **Replace token** swaps in a fresh Claude token. Subscriptions are private by default; owners can share one with the team. **Test connection** runs a small coding task and its tests.
3. Install your Factory GitHub App on selected repositories and import their issues.
4. Assign a ticket to an agent, or label it for automatic pickup. The pool picks an idle permitted subscription with available usage, preferring the least recently used account.
5. The agent (Codex or Claude Code, matching the subscription) clones the repository, implements the ticket and runs tests in a disposable container. A separate supervisor publishes the changes as a branch and ready-for-review PR, then watches checks, commit statuses and Actions runs on the PR head. Failed CI is fed back to Codex, which pushes repairs to the same branch until CI is green. Only then does the supervisor close the issue and move the ticket to Done.

Subscriptions keep their own usage windows; the pool never combines or extends quotas. An agent can be pinned to Codex or Claude subscriptions, or use any available one. A custom model requires a pinned agent and must be available to that subscription; blank uses the CLI's default. Claude usage windows (five-hour and weekly) are read from each run's rate-limit events. Interrupted runs retry with exponential backoff (one to fifteen minutes). Exhausted subscriptions wait for reset; revoked credentials need reconnecting, after which the same durable job resumes.

Owners, and team members using a shared subscription, can **Disable subscription** to exclude it from new work without disconnecting it. Running jobs finish normally.

## Labels and risk

Factory-owned GitHub labels use a configurable prefix (`NEXT_PUBLIC_LABEL_PREFIX`, default `factory`):

| Label | Meaning |
| --- | --- |
| `factory:ready` | Request automatic pickup |
| `factory:done` | Applied when Factory completes a ticket |
| `factory:risk:low` / `medium` / `high` | Risk rating set from the project board |

`risk:low` and `severity:low` are also recognised. Conflicting labels keep the highest risk. Low-risk PRs merge automatically after green CI when GitHub allows it (squash, then merge). Unrated tickets never auto-merge, and auto-merge never bypasses branch protection.

## Automatic pickup and the work board

Enable **Background worker** to react to GitHub issue events with the browser closed. Verified webhooks update the ticket and enqueue pickup immediately; finished runs enqueue another pickup to fill free slots. Tickets must be open, in intake/assigned, and unassigned or assigned to a Factory worker. Tickets with a previous run need manual review and restart.

The pool starts with 10 agents, adjustable to 15 or 20. Each run gets its own Sandbox container (capacity 20). Each enabled subscription still runs one job at a time. Every five minutes a fallback reconciles the 24 least-recently-refreshed boards. Queue messages retry busy or interrupted checks; exhausted retries go to the dead-letter queue.

**Work board** is the global kanban: Needs preparation, Queued, Running, Waiting, Review, Needs attention, Done. It also lists recently completed runs and open Factory PRs awaiting review. Click a running ticket or **Watch live** to stream its redacted execution log (commands, results, file changes and messages) over server-sent events. Closing the browser never stops a job.

Displayed times use Australia/Sydney. Stored timestamps are UTC.

## Memory

Factory remembers what it learns about your software. Before each run it ranks the active memories for the project, plus global ones, and adds the best within the project's character budget to the prompt. Ranking uses weight, outcomes and relevance to the ticket; pinned memories always go first. Memory is framed as context that may be outdated, never as permission.

- **Teach it**: add conventions, architecture notes, gotchas and commands on the **Memory** page, over the API (`POST /api/v1/memories`), or via MCP (`factory_create_memory`).
- **It learns**: at the end of a run Codex may write durable learnings. They become active project memories at low weight (20), or wait in **Suggested** when the project's auto-learn is off. Agents never write global memory. Rediscovering a learning raises its weight by 5, up to 60.
- **Outcomes tune it**: memories used by a run that reaches green CI gain score, and memories used by a failed run lose it. Agent memories that keep failing are archived automatically.
- **You tune it**: edit content or kind, set weight 0 to 100, pin, archive or accept suggestions. Each project has a per-run budget. **Preview** shows the exact block a ticket would receive. Every change is audited with its actor and can be reverted.

## Plans and agent collaboration

Label a large issue `factory:plan` to have a planner agent carve it up. The planner inspects the repository without changing it and proposes subtasks with dependencies and likely files. Tasks that touch the same files in parallel are flagged. Approve the plan on the **Plans** page, or enable auto-approve per project on the Memory page. Factory then creates GitHub sub-issues labelled `factory:ready` that inherit the epic's Factory risk label.

- A subtask is not picked up until every ticket it builds on is closed.
- Each subtask run sees the epic's goal, the planner's approach, sibling status and the epic thread.
- Finished runs post handoff notes (new interfaces, things siblings must know) to the epic thread, which is mirrored as GitHub comments. Team members can add guidance to the thread from the Plans page or `POST /api/v1/tickets/{id}/messages`.
- Factory closes the epic once all its subtasks are closed.

- While a run is working, Codex has a live MCP channel (`/api/runs/mcp`). It can search memory, propose learnings, read the epic thread, post updates for sibling agents, and check sibling status. Each run gets its own token, which works only while that run is running. The token covers only that run's project and epic, and each run can post at most 8 updates and propose at most 10 memories.
- Applying a plan is crash-safe. Each sub-issue carries a hidden task marker, so an interrupted apply finds what it already created instead of duplicating it. Stuck applies resume on the next automation pass, and webhook or sync imports link marked issues back to their epic.

Thread messages and memory are shared across agents but treated as untrusted context in prompts.

## Morning digest (optional)

After 07:00 Sydney time, the cron sends one daily email summarising unfinished tickets and open Factory PRs through [PaperBoy](https://github.com/yumaitau/paperboy), a self-hosted transactional email service. Set `PAPERBOY_API_URL`, `PAPERBOY_API_KEY` and `PAPERBOY_FROM` to enable it. Recipients are `PAPERBOY_DIGEST_TO`, or every user on an allowed domain.

## HTTP API and MCP

Factory exposes the same operations over HTTP and MCP. Authenticate with `Authorization: Bearer <FACTORY_API_KEY>` or a signed-in session.

- Catalog: `GET /api/v1`
- OpenAPI: `GET /api/v1/openapi.json`
- MCP (Streamable HTTP): `/api/mcp`

MCP tools are named `factory_*` and map one-to-one to the `/api/v1` routes. Execution logs stay on the session-only live-output route.

## Architecture

- **Main app** (repository root): Next.js on OpenNext for Cloudflare. UI, Google SSO (Better Auth), GitHub App integration, D1 metadata, Queue consumer and cron.
- **Runner** (`sandbox-runner/`): Worker with the Cloudflare Sandbox SDK, Codex CLI and Claude Code. One container and process per job.
- **`CODEX_VAULT`**: private R2 bucket holding AES-GCM encrypted Codex logins and Claude tokens, job records and results, keyed by the runner-only `CODEX_AUTH_KEY`. Tokens never enter D1 or browser responses.
- GitHub credentials stay in the supervisor's root-only directory. The agent runs as an unprivileged user without them. Publication uses a separate pristine clone, so agent-controlled Git config cannot reach the installation token.
- Each implementation or repair attempt has a 45-minute limit. Container loss is reported as failure, never success.

## Local development

Requires Node 22+, pnpm 10 and a Cloudflare account for Containers.

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in values; see SECRETS.md
pnpm d1:migrate:local
pnpm dev
```

Checks:

```bash
pnpm test         # unit and integration tests
pnpm typecheck
pnpm lint
pnpm test:e2e     # Playwright; uses a local-only test session, no real credentials
(cd sandbox-runner && pnpm install && pnpm run typecheck)
```

Never enable `E2E_AUTH_ENABLED` or `E2E_DISABLE_AUTH_RATE_LIMIT` in production.

## Deploying

1. **Create Cloudflare resources** and put their names/IDs in `wrangler.jsonc` and `sandbox-runner/wrangler.jsonc`:

   ```bash
   pnpm exec wrangler d1 create factory              # copy database_id into wrangler.jsonc
   pnpm exec wrangler r2 bucket create factory-artifacts
   pnpm exec wrangler r2 bucket create factory-cache
   pnpm exec wrangler r2 bucket create factory-codex-vault
   pnpm exec wrangler queues create factory-events
   pnpm exec wrangler queues create factory-events-failed
   ```

   Add a `routes` entry to `wrangler.jsonc` if you want a custom domain.

2. **Create a Google OAuth client** and a **GitHub App** as described in [SECRETS.md](SECRETS.md).

3. **Deploy the runner** (Docker must be running to build the container image):

   ```bash
   cd sandbox-runner
   pnpm install
   pnpm exec wrangler secret put RUNNER_SHARED_SECRET
   pnpm exec wrangler secret put CODEX_AUTH_KEY
   pnpm run deploy
   ```

4. **Deploy the main app**:

   ```bash
   pnpm d1:migrate:remote
   pnpm exec wrangler secret put BETTER_AUTH_SECRET   # repeat for each secret in SECRETS.md
   NEXT_PUBLIC_APP_NAME="Factory" NEXT_PUBLIC_LABEL_PREFIX=factory pnpm run deploy
   ```

Apply migrations before deploying the main app. Deploying with `--keep-vars` preserves variables set in the dashboard. Keep `CODEX_AUTH_KEY` stable across deployments, and keep the Docker image's Sandbox SDK tag aligned with the runner package version. Running jobs keep their current container until their next attempt.

### Required CI checks

Factory completes a ticket only on verified green CI. Required checks are read from classic branch protection and active repository or organisation rulesets on the PR base branch, at every poll and immediately before closing. Configure at least one named required status check; with no policy, the ticket stays open. Missing, pending, skipped and neutral checks never count as green. Draft PRs keep the ticket open. Review approvals still gate non-low-risk merges.

AI review bots (CodeRabbit, Sourcery, Greptile, Ellipsis, CodeAnt, Qodo) are not CI: their statuses are ignored unless a branch rule names them as required. If no CI registers on a PR within 30 minutes, Factory releases the subscription and leaves the PR in Review with the issue open, without merging. After a low-risk merge, Factory watches the default-branch pipeline and repairs failures. If no pipeline registers on the merge commit within 10 minutes, the PR's CI is taken as final and the issue closes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
